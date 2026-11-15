'use strict';
/* Pioneer DDJ-SB mapping (MIDI in, LEDs out).
   Taken from the Mixxx "Pioneer DDJ-SB" mapping (Pioneer-DDJ-SB.midi.xml and its script, MIT licence, by Joan Ardiaca Jove, wingcom and Hilton Rudham).
   Layout of the controller:
     decks 1 / 2   buttons: note-on on MIDI channel 1 / 2      knobs and faders: CC on channel 1 / 2 (14 bit: MSB cc, LSB cc + 0x20)
     pads          channel 8 / 9 (deck 1 / 2); the pad MODE button of the controller picks the note range it sends (hot cue, auto loop, manual loop, sampler)
     mixer         channel 7: crossfader, filter knobs, headphone mix, browse knob
   Needs globals from app.js: decks, ctl, playlist, sel, moveSel, loadToDeck, togglePfl, lsGet, led (via window.ddjsb.leds). */
(() => {
  const hi14 = {};                              // pending MSB values: "status:cc" -> value
  const shift = [false, false];                 // SHIFT button per deck
  const kill = {};                              // held kill switches: "deck:band" -> saved value
  const LOOPS = [1, 2, 4, 8, 16, 32, 64];       // auto-loop pads: 0x10-0x13 then 0x18-0x1A (beats)
  /* calibration written by the Controller test (localStorage 'ddjCal'): real travel of a fader, the centre notch of the pitch faders / crossfader and a dead band for noisy ones */
  const lastRaw = {};
  function adj(key, raw) {
    const c = lsGet('ddjCal', {})[key]; if (!c) return raw / 0x3FFF;
    let v = raw;
    if (c.db && lastRaw[key] !== undefined && Math.abs(raw - lastRaw[key]) <= c.db) v = lastRaw[key];
    lastRaw[key] = v;
    const lo = c.min !== undefined ? c.min : 0, hi = c.max !== undefined ? c.max : 0x3FFF;
    let f;
    if (c.center !== undefined && hi > c.center && c.center > lo) { f = Math.abs(v - c.center) <= (c.snap || 0) ? 0.5 : v < c.center ? 0.5 * (v - lo) / (c.center - lo) : 0.5 + 0.5 * (v - c.center) / (hi - c.center); }
    else f = (v - lo) / Math.max(1, hi - lo);
    return Math.max(0, Math.min(1, f));
  };
  const xfFree = () => !(window.autodj && window.autodj.S && window.autodj.S.on);

  function cc(ch, n, v, st) {
    // 14-bit controls: MSB numbers 0x00 (tempo), 0x04 (trim), 0x07 (high), 0x0B (mid), 0x0F (low), 0x13 (channel fader); LSB = MSB + 0x20.
    const MSB = [0x00, 0x07, 0x0B, 0x0F, 0x13, 0x17, 0x18, 0x1F, 0x05];
    if (ch <= 1 || ch === 6) {
      if (MSB.includes(n)) { hi14[st * 256 + n] = v; return true; }
      if (MSB.includes(n - 0x20)) {
        const base = n - 0x20, d = decks[ch], k = `d${ch}`, key = st * 256 + base, full = adj(st.toString(16) + ':' + base.toString(16), ((hi14[key] === undefined ? 0 : hi14[key]) << 7) | v);
        if (ch <= 1) {
          if (base === 0x00) ctl[`${k}.pitch`].set(((full * 2 - 1)) * decks[ch].range * (lsGet('invPitch', false) ? -1 : 1));   // tempo fader: +/-8 %; measured on the unit: top = 0, centre notch = 8192, bottom = 16383, and the top is the slower end (printed "-")
          else if (base === 0x07) ctl[`${k}.treble`].set(full);                                                       // HI
          else if (base === 0x0B) ctl[`${k}.mid`].set(full);                                                          // MID
          else if (base === 0x0F) ctl[`${k}.bass`].set(full);                                                         // LOW
          else if (base === 0x13) ctl[`${k}.vol`].set(full);                                                          // channel fader
        } else {
          if (base === 0x1F) { if (xfFree()) ctl.xf.set(full * 2 - 1); }                                              // crossfader
          else if (base === 0x17 || base === 0x18) ctl[`d${base - 0x17}.filter`].set(full);                           // FILTER knob of channel 1 / 2
          else if (base === 0x05) { if (shift[0] || shift[1]) ctl.headMix.set(full); else ctl.hpMix.set(full); }       // HEADPHONES MIX (hold SHIFT: the software HEADPHONES LEVEL, because the real knob is analog)
        }
        return true;
      }
    }
    if (ch <= 1) {
      const d = decks[ch];
      if (n === 0x21 || n === 0x22 || n === 0x23) { d.jog(v - 0x40); return true; }                                   // jog ring / platter (centre 0x40)
      if (n === 0x1F || n === 0x26) { d.jog((v - 0x40) * 8); return true; }                                           // shifted: fast
    }
    if ((ch === 4 || ch === 5) && (n === 0x00 || n === 0x20)) {                                                       // SHIFT + FX LEVEL knob (the controller sends its shifted CC 0x00 + 0x20): the software MASTER LEVEL, because the real knob is analog
      if (n === 0x00) { hi14[st * 256] = v; return true; }
      ctl.master.set(adj(st.toString(16) + ':0', ((hi14[st * 256] || 0) << 7) | v)); return true;
    }
    if (ch === 4 || ch === 5) {                                                                                       // FX1 / FX2 LEVEL knob (14 bit: 0x06 + 0x26)
      if (n === 0x06) { hi14[st * 256 + n] = v; return true; }
      if (n === 0x26) { const full = adj(st.toString(16) + ':6', ((hi14[st * 256 + 0x06] || 0) << 7) | v); ctl[`fx${ch - 4}`].set(full); return true; }
    }
    if (ch === 6 && n === 0x40) { moveSel(v > 0x40 ? -1 : 1); return true; }                                          // BROWSE knob
    if (ch === 6 && n === 0x64) { moveSel(v > 0x40 ? -10 : 10); return true; }                                        // SHIFT + BROWSE: ten at a time
    return false;
  }

  function deckNote(ch, n, down) {
    const d = decks[ch], o = decks[1 - ch];
    switch (n) {
      case 0x3F: shift[ch] = down; return true;                                                                       // SHIFT
      case 0x0B: if (down) d.toggle(); return true;                                                                   // PLAY / PAUSE
      case 0x47: if (down) { d.seek(0); d.play(); } return true;                                                      // SHIFT + PLAY: restart the track
      case 0x0C: down ? d.cueDown() : d.cueUp(); return true;                                                         // CUE
      case 0x48: if (down && d.playing) d.toggle(); return true;                                                      // SHIFT + CUE: brake / pause
      case 0x17: if (down) { d.scratch = !d.scratch; toast('Deck ' + (ch + 1) + ' scratch mode ' + (d.scratch ? 'on' : 'off')); } return true;   // VINYL
      case 0x54: case 0x68: if (down) togglePfl(d); return true;                                                      // HEADPHONE CUE
      case 0x58: if (down) d.syncTo(o); return true;                                                                  // SYNC
      case 0x35: case 0x36: case 0x67: return true;                                                                   // jog touch (the wheel messages do the work)
      case 0x1A: if (down) { d.setKeyLock(!d.keylock); toast('Deck ' + (ch + 1) + ' KEY LOCK ' + (d.keylock ? 'on' : 'off')); } return true;   // KEY LOCK (master tempo)
      case 0x60: if (down) d.cycleRange(); return true;                                                               // SHIFT + KEY LOCK = TEMPO RANGE
      case 0x5C: if (down) { d.quantize = !d.quantize; toast('Deck ' + (ch + 1) + ' QUANTIZE ' + (d.quantize ? 'on: cue, hot cue and loop points snap to the beat' : 'off')); } return true;   // SHIFT + SYNC = QUANTIZE
      case 0x4E: if (down) { d.slip = !d.slip; if (!d.slip) d._ghost = null; toast('Deck ' + (ch + 1) + ' SLIP ' + (d.slip ? 'on: the track keeps running under loops and scratches' : 'off')); } return true;   // SHIFT + VINYL = SLIP
    }
    return false;
  }

  function padNote(ch, n, down) {                                                                                     // ch 0 / 1 = deck
    const d = decks[ch];
    const grp = n >> 4 & 7, idx = n & 3, sh = !!(n & 8), second = !!(n & 0x40);                                       // 0x0_ hot, 0x1_ auto loop, 0x2_ manual loop, 0x3_ sampler, 0x4_ hot 5-8, 0x5_ roll, 0x6_ kill
    if (grp === 0 || grp === 4) {                                                                                     // hot cue pads (the second bank maps onto the same four cues)
      if (sh) { if (down && d.hot[idx] != null) { d.hot[idx] = null; d.saveCues(); toast('Hot cue ' + (idx + 1) + ' cleared'); } return true; }   // SHIFT + pad: clear
      d.padMode = 'hot'; d.pad(idx, down); return true;
    }
    if (grp === 1 || grp === 5) {                                                                                     // auto loop (and loop roll as the short loops)
      d.padMode = 'loop';
      if (!down) return true;
      if (grp === 1) { const i = (n & 8) ? 4 + idx : idx; if (LOOPS[i]) d.autoLoop(LOOPS[i]); }
      else d.autoLoop([0.25, 0.5, 1, 2, 0.125, 0.0625, 4, 8][(n & 8) ? 4 + idx : idx]);
      return true;
    }
    if (grp === 2) {                                                                                                  // manual loop pads
      d.padMode = 'mloop';
      if (!down) return true;
      if (n === 0x22) d.setLoop(null);                                                                                // EXIT
      else if (n === 0x23 && d.loop) d.setLoop({ start: d.loop.start, end: d.loop.start + (d.loop.end - d.loop.start) / 2 });   // HALVE
      else if (n === 0x2B && d.loop) d.setLoop({ start: d.loop.start, end: Math.min(d.dur, d.loop.start + (d.loop.end - d.loop.start) * 2) });   // DOUBLE
      else if (n === 0x20 && d.buf) d._ddjIn = d.snap(d.pos());                                                               // LOOP IN
      else if (n === 0x21 && d.buf && d._ddjIn != null && d.snap(d.pos()) > d._ddjIn + 0.05) d.setLoop({ start: d._ddjIn, end: d.snap(d.pos()) });   // LOOP OUT
      return true;
    }
    if (grp === 3) {                                                                                                  // sampler pads = effect pads
      d.padMode = 'jump'; if (n & 8) { if (down) sampStop(idx); } else d.pad(idx, down); return true;                 // 0x30-0x33: play sample 1-4, 0x38-0x3B (SHIFT): stop it
    }
    if (grp === 7) { if (down) { if (n & 8) sampSet(idx, null); else sampLoadSelected(idx); } return true; }       // 0x70-0x73: load the selected track into sample slot 1-4, 0x78-0x7B: empty it
    if (grp === 6) {                                                                                                  // kill switches (0x60 LOW, 0x61 MID, 0x62 HIGH, 0x63 MUTE): hold to cut
      if (n > 0x63) return true; const band = ['bass', null, 'treble', 'vol'][n & 3]; if (!band) return true;
      const c = ctl[`d${ch}.${band}`], key = ch + ':' + band;
      if (down) { if (kill[key] === undefined) { kill[key] = +c.el.value; c.set(band === 'vol' ? 0 : 0); } }
      else if (kill[key] !== undefined) { c.set(kill[key]); delete kill[key]; }
      return true;
    }
    return false;
  }

  function note(st, n, v) {
    const ch = st & 0x0F, down = (st & 0xF0) === 0x90 && v > 0;
    if (ch <= 1) return deckNote(ch, n, down);
    if (ch === 7 || ch === 8) return padNote(ch - 7, n, down);
    if (ch === 6) {                                                                                                   // browse section
      if (n === 0x46 || n === 0x47) { if (down) loadToDeck(decks[n - 0x46], playlist[sel]); return true; }          // LOAD A / B
      return true;
    }
    if (ch === 4 || ch === 5) {                                                                                       // FX1 / FX2 SELECT 1-3 (0x47-0x49; SHIFT: 0x63-0x65): hold = effect on
      const b = n >= 0x63 ? n - 0x63 : n - 0x47, dk = ch - 4;
      if (b >= 0 && b < 3) { fxHold(dk, 7 + 3 * dk + b, down); const el = document.querySelectorAll('.fxsel')[dk * 3 + b]; if (el) el.classList.toggle('lit', down); }
      return true;
    }
    return false;
  }

  /* LEDs: on = 0x7F, off = 0x00. Both the normal and the SHIFT note of a button are lit. */
  function leds() {
    if (typeof led !== 'function' || typeof midiOut === 'undefined' || !midiOut) return;
    for (const d of decks) {
      const s = 0x90 + d.i, p = 0x97 + d.i, pos = d.pos();
      const cueLit = !d.playing && d.buf && Math.abs(pos - d.cuePt) < 0.03;
      for (const n of [0x0B, 0x47]) led(s, n, d.playing);
      for (const n of [0x0C, 0x48]) led(s, n, d.playing || cueLit);
      for (const n of [0x54, 0x68]) led(s, n, d.pflOn);
      led(s, 0x58, !!d._syncLit); led(s, 0x17, d.scratch); led(s, 0x1A, !!d.keylock); led(s, 0x5C, !!d.quantize); led(s, 0x4E, !!d.slip);
      for (let i = 0; i < 4; i++) {
        const set = d.hot[i] != null;
        led(p, 0x00 + i, set); led(p, 0x08 + i, set); led(p, 0x40 + i, set); led(p, 0x48 + i, set);                    // hot cue pads
        const sl = !!samp.slots[i] || !!(nat.state && ((nat.state.samplesPlaying >> i) & 1));
        led(p, 0x30 + i, sl); led(p, 0x38 + i, sl);                                                                    // sampler pads: lit when the slot holds a sound (or is playing)
      }
      LOOPS.forEach((b, i) => led(p, i < 4 ? 0x10 + i : 0x18 + (i - 4), !!(d.loop && d.an && d.an.bpm && Math.abs((d.loop.end - d.loop.start) - b * 60 / d.an.bpm) < 0.01)));
      for (let b = 0; b < 3; b++) { const on = typeof fxHeld !== 'undefined' && !!fxHeld[d.i][7 + 3 * d.i + b]; led(0x94 + d.i, 0x47 + b, on); led(0x94 + d.i, 0x63 + b, on); }   // FX SELECT lights
      led(p, 0x22, !!d.loop);                                                                                          // loop EXIT lit while a loop runs
    }
  }
  function off() {
    if (typeof led !== 'function') return;
    for (const d of decks) {
      const s = 0x90 + d.i, p = 0x97 + d.i;
      for (const n of [0x0B, 0x47, 0x0C, 0x48, 0x54, 0x68, 0x58, 0x17, 0x1A]) led(s, n, false);
      for (let i = 0; i < 0x64; i++) led(p, i, false);
    }
  }
  window.ddjsb = { handle(st, d1, d2) {
    if (window.__ddjMute) return true;   // the calibration wizard is running: the controller must not drive the app
    const type = st & 0xF0;
    if (type === 0xB0) return cc(st & 0x0F, d1, d2, st);
    if (type === 0x90 || type === 0x80) return note(st, d1, type === 0x80 ? 0 : d2);
    return false;
  }, leds, off, shift };
})();
