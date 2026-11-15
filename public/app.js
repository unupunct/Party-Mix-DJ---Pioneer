'use strict';
/* DDJ-SB DJ - 2-deck player, playlist and scrolling waveforms for the Pioneer DDJ-SB.
   Audio: Web Audio. Controller: Web MIDI (mapping taken from the Mixxx Pioneer DDJ-SB mapping, see ddjsb.js). */

const PI = Math.PI, BPS = 150;                       // waveform buckets per second
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const $ = (s, el = document) => el.querySelector(s);
const fmt = s => { if (!isFinite(s)) s = 0; const n = s < 0; s = Math.abs(s);
  return (n ? '-' : '') + Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0') + '.' + Math.floor((s * 10) % 10); };
const fmtS = s => isFinite(s) && s > 0 ? Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0') : '–';
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
function toast(msg, ms = 3500) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg; document.body.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

/* ------------------------------------------------------------------ native engine bridge (Electron only) */
const NE = window.electronAPI && window.electronAPI.engine;
const nat = { active: false, everActive: false, ready: false, devices: [], status: null, state: null, settings: null, pending: new Map(), reqId: 1, lastClips: 0, clipUntil: 0, devWaiter: null };
const engSend = c => { if (window.__engTap) window.__engTap(c); if (NE) NE.send(c); };   // (__engTap: self-test hook)
/* Wheels and faders can fire hundreds of messages a second. The first change goes out at once, later ones are merged (the last value always arrives). */
const _thr = new Map();
function engSendThrottled(key, cmd, ms = 8) {
  const now = performance.now(), st = _thr.get(key) || { t: 0, timer: 0, cmd: null };
  st.cmd = cmd;
  if (now - st.t >= ms) { st.t = now; engSend(cmd); st.cmd = null; }
  else if (!st.timer) st.timer = setTimeout(() => { st.timer = 0; st.t = performance.now(); if (st.cmd) { engSend(st.cmd); st.cmd = null; } }, ms - (now - st.t));
  _thr.set(key, st);
}

/* ------------------------------------------------------------------ audio graph */
const AC = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
const mix = { sum: AC.createGain(), gain: AC.createGain(), lim: AC.createDynamicsCompressor(), out: AC.createGain() };
mix.lim.threshold.value = -3; mix.lim.knee.value = 0; mix.lim.ratio.value = 20; mix.lim.attack.value = 0.003; mix.lim.release.value = 0.1;
mix.hp = AC.createBiquadFilter(); mix.hp.type = 'highpass'; mix.hp.frequency.value = 10; mix.lp = AC.createBiquadFilter(); mix.lp.type = 'lowpass'; mix.lp.frequency.value = 22000;   // master DJ filter (Web Audio fallback)
mix.sum.connect(mix.gain); mix.gain.connect(mix.hp); mix.hp.connect(mix.lp); mix.lp.connect(mix.lim); mix.lim.connect(mix.out);

const cue = { sum: AC.createGain(), masterTap: AC.createGain(), cueTap: AC.createGain(), head: AC.createGain(), out: AC.createGain() };
cue.sum.connect(cue.cueTap); mix.gain.connect(cue.masterTap);
cue.cueTap.connect(cue.head); cue.masterTap.connect(cue.head); cue.head.connect(cue.out);

const streamDest = AC.createMediaStreamDestination();
const cueEl = new Audio(); cueEl.srcObject = streamDest.stream;
// The headphone cue is a second stereo stream sent to a second output device. (Chromium folds multichannel output down to
// stereo, so the Party Mix's own channel 3/4 headphone jack cannot be addressed from here.)
let cueMode = 'off';                                   // off | device
function rewire() {
  for (const n of [mix.out, cue.out]) try { n.disconnect(); } catch {}
  mix.out.connect(AC.destination);
  if (cueMode === 'device') cue.out.connect(streamDest);
}
rewire();

/* ------------------------------------------------------------------ analysis (waveform colours + BPM) */
function analyze(buf) {
  const sr = buf.sampleRate, c0 = buf.getChannelData(0), c1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : c0;
  const B = Math.max(1, Math.round(sr / BPS)), n = Math.ceil(buf.length / B);
  const amp = new Float32Array(n), lo = new Float32Array(n), mi = new Float32Array(n), hi = new Float32Array(n);
  const a1 = 1 - Math.exp(-2 * PI * 250 / sr), a2 = 1 - Math.exp(-2 * PI * 2500 / sr);
  let l1 = 0, l2 = 0;
  for (let b = 0; b < n; b++) {
    const s0 = b * B, s1 = Math.min(buf.length, s0 + B); let pa = 0, pl = 0, pm = 0, ph = 0;
    for (let i = s0; i < s1; i++) {
      const x = (c0[i] + c1[i]) * 0.5; l1 += a1 * (x - l1); l2 += a2 * (x - l2);
      pl += Math.abs(l1); pm += Math.abs(l2 - l1); ph += Math.abs(x - l2);
      const ax = Math.max(Math.abs(c0[i]), Math.abs(c1[i])); if (ax > pa) pa = ax;
    }
    const c = (s1 - s0) || 1; amp[b] = pa; lo[b] = pl / c; mi[b] = pm / c; hi[b] = ph / c;
  }
  let ma = 1e-9, ml = 1e-9, mm = 1e-9, mh = 1e-9;
  for (let i = 0; i < n; i++) { if (amp[i] > ma) ma = amp[i]; if (lo[i] > ml) ml = lo[i]; if (mi[i] > mm) mm = mi[i]; if (hi[i] > mh) mh = hi[i]; }
  const a8 = new Uint8Array(n), col = new Uint8Array(n * 3);
  for (let i = 0; i < n; i++) {
    a8[i] = Math.round(255 * Math.pow(amp[i] / ma, 0.8));
    const bl = Math.pow(lo[i] / ml, 0.6), bm = Math.pow(mi[i] / mm, 0.6), bh = Math.pow(hi[i] / mh, 0.6);
    const m = Math.max(bl, bm, bh, 1e-3);
    col[i * 3] = 40 + 215 * bl / m; col[i * 3 + 1] = 40 + 215 * bm / m; col[i * 3 + 2] = 40 + 215 * bh / m;
  }
  // BPM from onset envelope of the low/mid bands
  const env = new Float32Array(n);
  for (let i = 1; i < n; i++) env[i] = Math.max(0, (lo[i] - lo[i - 1]) + 0.5 * (mi[i] - mi[i - 1]));
  const s0 = Math.min(Math.floor(10 * BPS), Math.max(0, n - 20 * BPS)), s1 = Math.min(n - 1, s0 + 120 * BPS);
  let best = 0, bestBpm = 0;
  if (s1 - s0 > 8 * BPS) {
    for (let bpm = 75; bpm <= 175; bpm += 0.1) {
      const lag = BPS * 60 / bpm; let sc = 0;
      for (let i = s0; i < s1 - Math.ceil(lag) - 1; i++) { const j = i + lag, jf = Math.floor(j), fr = j - jf; sc += env[i] * (env[jf] * (1 - fr) + env[jf + 1] * fr); }
      sc /= (s1 - s0);
      if (sc > best) { best = sc; bestBpm = bpm; }
    }
  }
  let grid = 0;
  if (bestBpm) {
    const P = BPS * 60 / bestBpm; let bs = -1, bp = 0;
    for (let p = 0; p < P; p += 0.5) { let sc = 0; for (let t = s0 + p; t < s1; t += P) sc += env[Math.round(t)]; if (sc > bs) { bs = sc; bp = p; } }
    grid = ((bp + s0) % P) / BPS;                       // offset of first beat in seconds (beats fall at s0 + bp + k*P)
  }
  return { n, amp: a8, col, bpm: bestBpm ? Math.round(bestBpm * 10) / 10 : 0, grid };
}

/* ------------------------------------------------------------------ deck */
const PAD_COL = ['#ff4d4d', '#ffb020', '#37d67a', '#4da3ff'];
class Deck {
  constructor(i) {
    this.i = i; this.name = 'No track'; this.trackId = null; this.buf = null; this.an = null;
    this.playing = false; this.anchorPos = 0; this.anchorT = 0; this.rate = 1; this.bend = 0;
    this.cuePt = 0; this.hot = [null, null, null, null]; this.loop = null; this.zoom = 6;
    this.padMode = 'hot'; this.padDn = [false, false, false, false]; this.padFlash = [0, 0, 0, 0]; this.scratch = false; this.scratching = false; this.scrTimer = 0; this.scrWas = false; this.previewing = false;
    this.pflOn = false; this.synced = false; this.loading = false; this.src = null;
    this.nPos = 0; this.nT = 0; this.cmdAt = 0; this.guard = 0;   // native-engine position tracking
    this.trim = AC.createGain(); this.low = AC.createBiquadFilter(); this.mid = AC.createBiquadFilter(); this.high = AC.createBiquadFilter();
    this.mid.type = 'peaking'; this.mid.frequency.value = 1000; this.mid.Q.value = 0.7;
    this.low.type = 'lowshelf'; this.low.frequency.value = 250; this.high.type = 'highshelf'; this.high.frequency.value = 2500;
    this.pre = AC.createGain(); this.pfl = AC.createGain(); this.pfl.gain.value = 0; this.vol = AC.createGain(); this.xf = AC.createGain();
    this.trim.connect(this.low); this.low.connect(this.mid); this.mid.connect(this.high); this.high.connect(this.pre);
    this.pre.connect(this.pfl); this.pfl.connect(cue.sum); this.pre.connect(this.vol); this.vol.connect(this.xf); this.xf.connect(mix.sum);
  }
  get effRate() { return this.rate * (1 + this.bend); }
  get dur() { return this.buf ? this.buf.duration : 0; }
  get effBpm() { return this.an && this.an.bpm ? this.an.bpm * this.rate : 0; }
  pos() {
    if (!this.buf) return 0;
    if (nat.active) {                                   // native engine: last reported position + extrapolation
      let p = this.nPos + (this.playing ? (performance.now() - this.nT) / 1000 * this.effRate : 0);
      if (this.loop && this.playing && p >= this.loop.end) p = this.loop.start + ((p - this.loop.start) % (this.loop.end - this.loop.start));
      return clamp(p, 0, this.dur);
    }
    let p = this.anchorPos;
    if (this.playing) {
      p += (AC.currentTime - this.anchorT) * this.effRate;
      if (this.loop && p >= this.loop.end) p = this.loop.start + ((p - this.loop.start) % (this.loop.end - this.loop.start));
    }
    return clamp(p, 0, this.dur);
  }
  reanchor() { if (nat.active) { this.nPos = this.pos(); this.nT = performance.now(); return; } this.anchorPos = this.pos(); this.anchorT = AC.currentTime; }
  _stopSrc() { if (this.src) { const s = this.src; this.src = null; s.onended = null; try { s.stop(); } catch {} s.disconnect(); } }
  _start() {
    this._stopSrc();
    const s = AC.createBufferSource(); s.buffer = this.buf; s.playbackRate.value = this.effRate;
    if (this.loop) { s.loop = true; s.loopStart = this.loop.start; s.loopEnd = this.loop.end; }
    s.connect(this.trim); s.start(0, this.anchorPos); this.src = s;
    s.onended = () => { if (this.src === s) { this.src = null; if (this.playing) { this.playing = false; this.anchorPos = this.dur; } } };
  }
  play() {
    if (!this.buf || this.playing) return;
    if (nat.active) {
      if (this.nPos >= this.dur - 0.05) this.nPos = 0;
      this.nT = performance.now(); this.cmdAt = this.nT; this.guard = this.nT + 120; this.playing = true;
      return engSend({ cmd: 'play', deck: this.i });
    }
    AC.resume();
    if (this.anchorPos >= this.dur - 0.05) this.anchorPos = 0;
    this.anchorT = AC.currentTime; this.playing = true; this._start();
  }
  pause() {
    if (!this.playing) return;
    if (nat.active) { this.nPos = this.pos(); this.nT = performance.now(); this.cmdAt = this.nT; this.playing = false; return engSend({ cmd: 'pause', deck: this.i }); }
    this.anchorPos = this.pos(); this.playing = false; this._stopSrc();
  }
  // PLAY/PAUSE button: pausing brakes like a platter losing speed (native engine); every other stop (cue, load, scratch...) stays instant
  toggle() {
    if (!this.playing) return this.play();
    if (nat.active && lsGet('brake', true)) { this.nPos = this.pos(); this.nT = performance.now(); this.cmdAt = this.nT; this.playing = false; return engSend({ cmd: 'brake', deck: this.i }); }
    this.pause();
  }
  seek(t) {
    if (!this.buf) return;
    if (nat.active) { this.nPos = clamp(t, 0, this.dur); this.nT = performance.now(); this.guard = this.nT + 120; return engSend({ cmd: 'seek', deck: this.i, pos: this.nPos }); }
    this.anchorPos = clamp(t, 0, this.dur); this.anchorT = AC.currentTime; if (this.playing) this._start();
  }
  setRate(r) { this.reanchor(); this.rate = r; if (nat.active) engSendThrottled('rate' + this.i, { cmd: 'rate', deck: this.i, value: this.effRate }, 10); else if (this.src) this.src.playbackRate.value = this.effRate; }
  setBend(b) { this.reanchor(); this.bend = b; if (nat.active) engSendThrottled('rate' + this.i, { cmd: 'rate', deck: this.i, value: this.effRate }, 10); else if (this.src) this.src.playbackRate.value = this.effRate; }
  cueDown() {
    if (!this.buf) return;
    if (this.playing) { this.pause(); this.seek(this.cuePt); }
    else if (Math.abs(this.pos() - this.cuePt) < 0.03) { this.previewing = true; this.play(); }
    else { this.cuePt = this.pos(); this.saveCues(); }
  }
  cueUp() { if (this.previewing) { this.previewing = false; this.pause(); this.seek(this.cuePt); } }
  setLoop(l) {
    this.reanchor(); this.loop = l;
    if (nat.active) return engSend({ cmd: 'loop', deck: this.i, start: l ? l.start : 0, end: l ? l.end : 0, on: !!l });
    if (this.playing) this._start();
  }
  autoLoop(beats) {
    if (!this.an || !this.an.bpm) { toast('No BPM detected for this track'); return; }
    const per = 60 / this.an.bpm, len = beats * per;
    if (this.loop && Math.abs((this.loop.end - this.loop.start) - len) < 1e-3) { this.setLoop(null); return; }
    const p = this.pos(), k = Math.floor((p - this.an.grid) / per + 0.15);
    const start = Math.max(0, this.an.grid + k * per);
    this.setLoop({ start, end: Math.min(this.dur, start + len) });
  }
  syncTo(o) {
    if (!o || !o.effBpm || !this.an || !this.an.bpm) { toast('Sync needs BPM on both decks'); return; }
    const ratio = o.effBpm / this.an.bpm; let r = ratio;
    for (const f of [2, 0.5]) if (Math.abs(ratio * f - 1) < Math.abs(r - 1) - 0.02) r = ratio * f;   // half / double time when that is the closer match
    ctl[`d${this.i}.pitch`].set(clamp((r - 1) * 100, -16, 16));
    this.synced = true;
    if (o.playing && this.playing) {                   // both running: also line up the beats (in real time, so half / double time works too)
      const per = d => 60 / (d.an.bpm * d.rate);       // real seconds per beat
      const into = d => { const pb = 60 / d.an.bpm, x = (((d.pos() - d.an.grid) / pb) % 1 + 1) % 1; return x * per(d); };
      const P = per(this); let diff = (into(o) - into(this)) % P; if (diff > P / 2) diff -= P; if (diff < -P / 2) diff += P;
      if (Math.abs(diff) > 0.008) this.seek(this.pos() + diff * this.rate);
    }
  }
  pad(n, down) {
    if (!down && this._fxOn && this._fxOn[n] != null) { fxHold(this.i, this._fxOn[n], false); this._fxOn[n] = null; }   // released, whatever the mode is now
    this.padDn[n] = !!down; if (down) this.padFlash[n] = performance.now() + 220;   // the pad LED (screen and controller) lights while pressed
    if (this.padMode === 'jump' || this.padMode === 'roll') {   // EFFECTS: pads 1-4 hold their own effect · EFFECT 2: pads 1-3 hold an effect, pad 4 switches Dry/Wet <-> Dry+Wet
      if (down) { if (this.padMode === 'roll' && n === 3) { fxAdd[this.i] = !fxAdd[this.i]; engSend({ cmd: 'fxMode', deck: this.i, additive: fxAdd[this.i] }); toast('Deck ' + (this.i + 1) + ' effect mix: ' + (fxAdd[this.i] ? 'Dry+Wet' : 'Dry/Wet')); } else { const slot = this.padMode === 'jump' ? n : 4 + n; (this._fxOn = this._fxOn || [])[n] = slot; fxHold(this.i, slot, true); } }
      return;
    }
    if (!this.buf) return;
    const m = this.padMode;
    if (m === 'hot') { if (!down) return; if (this.hot[n] == null) { this.hot[n] = this.pos(); this.saveCues(); } else this.seek(this.hot[n]); }
    else if (m === 'loop') { if (down) this.autoLoop([1, 2, 4, 8][n]); }
    else if (m === 'mloop') {   // IN, OUT, EXIT, 1/2x
      if (!down) return;
      if (n === 0) this._ddjIn = this.pos();
      else if (n === 1) { if (this._ddjIn != null && this.pos() > this._ddjIn + 0.05) this.setLoop({ start: this._ddjIn, end: this.pos() }); }
      else if (n === 2) this.setLoop(null);
      else if (this.loop) this.setLoop({ start: this.loop.start, end: this.loop.start + (this.loop.end - this.loop.start) / 2 });
    }
  }
  clearCues() { this.hot = [null, null, null, null]; this.saveCues(); }
  saveCues() { if (this.trackId) lsSet('cues:' + this.trackId, { cue: this.cuePt, hot: this.hot }); }
  loadCues() { const c = lsGet('cues:' + this.trackId, null); this.cuePt = c ? c.cue : 0; this.hot = c ? c.hot : [null, null, null, null]; }
  jog(delta) {
    if (!this.buf) return;
    const k = jogSens();                               // 0.1 .. 1.5, default 0.45 (the wheels used to be far too touchy)
    if (this.scratch) {                                // basic scratch: pause, move, resume after idle
      if (!this.scratching) { this.scrWas = this.playing; this.pause(); this.scratching = true; }
      this.seek(this.pos() + delta * 0.012 * k);
      if (delta > 0) this.grain(Math.min(3, 0.6 + delta * 0.5));
      clearTimeout(this.scrTimer);
      this.scrTimer = setTimeout(() => { this.scratching = false; if (this.scrWas) this.play(); }, 90);
    } else if (this.playing) { const lim = Math.max(0.05, 0.25 * k); this.setBend(clamp(this.bend + delta * 0.015 * k, -lim, lim)); }
    else this.seek(this.pos() + delta * 0.05 * k);
  }
  grain(rate) {
    if (nat.active) return;                            // (native scrub audio comes with the time-stretch milestone)
    const s = AC.createBufferSource(); s.buffer = this.buf; s.playbackRate.value = rate;
    s.connect(this.trim); s.start(0, this.anchorPos, 0.06); s.onended = () => s.disconnect();
  }
}
const jogSens = () => clamp(+lsGet('jogSens', 0.45) || 0.45, 0.1, 1.5);
const decks = [new Deck(0), new Deck(1)];

/* ------------------------------------------------------------------ controls (UI <-> audio <-> MIDI) */
const ctl = {};
function reg(name, el, min, max, apply0) {
  const apply = v => { apply0(v); nativeParam(name, v); };   // drive the Web Audio graph and (when active) the native engine
  const c = ctl[name] = { el, apply, set(v) { el.value = v; apply(+v); } };
  el.min = min; el.max = max; el.step = (max - min) / 1000;
  el.addEventListener('input', () => apply(+el.value));
  return c;
}
const eqDb = v => v < 0.5 ? -26 * (1 - v * 2) : 14.4 * (v - 0.5) * 2;
function xfApply() {
  const x = (+ctl.xf.el.value + 1) / 2;
  decks[0].xf.gain.value = Math.min(1, 2 * (1 - x)); decks[1].xf.gain.value = Math.min(1, 2 * x);
}

/* ------------------------------------------------------------------ DOM building */
function buildUI() {
  const waves = $('#waves'), dk = $('#decks');
  for (const d of decks) {
    const L = d.i ? 'b' : 'a', N = d.i ? 'B' : 'A';
    waves.insertAdjacentHTML('beforeend', `<div class="wavebox"><canvas id="wv${d.i}"></canvas><span class="tag ${L}">${N}</span><span class="ttl" id="tt${d.i}">No track</span><span class="tm" id="tm${d.i}">0:00.0</span><span class="bpm" id="bp${d.i}"></span></div>`);
  }
  const deckHtml = d => { const L = d.i ? 'b' : 'a', N = d.i ? 'B' : 'A'; return `
  <div class="deck ${L}" id="deck${d.i}">
    <canvas class="ov" id="ov${d.i}"></canvas>
    <div class="row">
      <button class="tbtn" data-act="play">▶ PLAY</button><button class="tbtn cue" data-act="cue">CUE</button>
      <button class="tbtn" data-act="sync">SYNC</button><button class="tbtn scr" data-act="scr">SCRATCH</button><button class="tbtn pfl" data-act="pfl">HEADPHONE</button>
    </div>
    <div class="pitch"><span class="dim">PITCH</span><input type="range" id="pt${d.i}"><span class="val" id="ptv${d.i}">0.00%</span><button data-act="reset" title="Reset pitch">0</button></div>
    <div class="modes">
      <button data-mode="hot">HOT CUE</button><button data-mode="loop">AUTO LOOP</button><button data-mode="mloop">MANUAL LOOP</button><button data-mode="jump">SAMPLER</button>
    </div>
    <div class="pads" id="pads${d.i}">${[0, 1, 2, 3].map(n => `<div class="pad" data-pad="${n}">${n + 1}</div>`).join('')}</div>
    <div class="loopinfo" id="li${d.i}"></div>
  </div>`; };
  const knob = (id, label) => `<div class="knob"><input type="range" id="${id}"><span>${label}</span></div>`;
  const chan = d => `<div class="ch ${d.i ? 'b' : 'a'}"><span class="lbl">${d.i ? 'B' : 'A'}</span>
    ${knob(`d${d.i}.gain`, 'TRIM')}${knob(`d${d.i}.treble`, 'HI')}${knob(`d${d.i}.mid`, 'MID')}${knob(`d${d.i}.bass`, 'LOW')}${knob(`d${d.i}.filter`, 'FILTER')}
    <input type="range" class="fader" id="d${d.i}.vol"><span class="dim small">VOLUME</span></div>`;
  dk.innerHTML = deckHtml(decks[0]) + `<div class="mixer"><h3>MIXER</h3><div class="chs">${chan(decks[0])}${chan(decks[1])}</div>
    <input type="range" class="xfade" id="xf"><div class="dim small" style="text-align:center;margin-top:-6px">CROSSFADER</div>
    <div class="mrow" style="margin-top:10px">${knob('fx0', 'LEVEL')}${knob('fx1', 'LEVEL')}${knob('master', 'MASTER LEVEL')}${knob('hpMix', 'HEADPHONES MIX')}${knob('headMix', 'HEADPHONES LEVEL')}${knob('headGain', 'FILTER FADE')}</div></div>` + deckHtml(decks[1]);

  reg('xf', $('#xf'), -1, 1, xfApply); ctl.xf.set(0);
  reg('master', $('#master'), 0, 1, v => mix.gain.gain.value = v); ctl.master.set(0.8);
  reg('fx0', $('#fx0'), 0, 1, () => {}); ctl.fx0.set(1); reg('fx1', $('#fx1'), 0, 1, () => {}); ctl.fx1.set(1);   // FX1 / FX2 LEVEL knobs (native engine)
  /* HEADPHONES VOLUME (the controller's CUE MIX knob): the level of the headphone / cue output. What you hear is the cued channels with a little of the master (30 %), as before. */
let HP_MIX = 0;   // HEADPHONES MIX knob: 0 = only the decks whose HEADPHONE (CUE) button is on, 1 = only the master
reg('headMix', $('#headMix'), 0, 1, v => { const g = hpGain(v); cue.cueTap.gain.value = (1 - HP_MIX) * g; cue.masterTap.gain.value = HP_MIX * g; }); ctl.headMix.set(0.8);
reg('hpMix', $('#hpMix'), 0, 1, v => { HP_MIX = v; if (ctl.headMix) ctl.headMix.apply(+ctl.headMix.el.value); }); ctl.hpMix.set(0);
  cue.head.gain.value = 1.2;   // headphone level is fixed now: the CUE GAIN knob is the master DJ filter
  reg('headGain', $('#headGain'), 0, 1, v => { const f = (v - 0.5) * 2, m = Math.abs(f); if (m <= 0.05) { mix.hp.frequency.value = 10; mix.lp.frequency.value = 22000; } else { const u = (m - 0.05) / 0.95; if (f < 0) { mix.lp.frequency.value = 18000 * Math.pow(200 / 18000, u); mix.hp.frequency.value = 10; } else { mix.hp.frequency.value = 30 * Math.pow(6000 / 30, u); mix.lp.frequency.value = 22000; } } }); ctl.headGain.set(0.5);
  for (const d of decks) {
    const k = `d${d.i}`;
    reg(`${k}.gain`, document.getElementById(`${k}.gain`), 0, 1, v => d.trim.gain.value = v * 2); ctl[`${k}.gain`].set(0.5);
    reg(`${k}.treble`, document.getElementById(`${k}.treble`), 0, 1, v => d.high.gain.value = eqDb(v)); ctl[`${k}.treble`].set(0.5);
    reg(`${k}.bass`, document.getElementById(`${k}.bass`), 0, 1, v => d.low.gain.value = eqDb(v)); ctl[`${k}.bass`].set(0.5);
    reg(`${k}.mid`, document.getElementById(`${k}.mid`), 0, 1, v => d.mid.gain.value = eqDb(v)); ctl[`${k}.mid`].set(0.5);
    reg(`${k}.filter`, document.getElementById(`${k}.filter`), 0, 1, () => {}); ctl[`${k}.filter`].set(0.5);   // channel DJ filter (native engine)
    reg(`${k}.vol`, document.getElementById(`${k}.vol`), 0, 1, v => d.vol.gain.value = v * v); ctl[`${k}.vol`].set(0);
    d.range = [6, 8, 10, 16, 25].includes(lsGet('tempoRange' + d.i, 8)) ? lsGet('tempoRange' + d.i, 8) : 8; d.keylock = false;
    reg(`${k}.pitch`, $(`#pt${d.i}`), -d.range, d.range, p => {
      d.setRate(1 + p / 100); $(`#ptv${d.i}`).textContent = (p >= 0 ? '+' : '') + p.toFixed(2) + '%';
    });
    { const pc = ctl[`${k}.pitch`], pset = pc.set; pc.set = v => { const R = [6, 8, 10, 16, 25].find(x => x >= Math.abs(+v) - 1e-6); if (R && R > d.range) d.setRange(R, true); pset(v); }; }   // a value beyond the range (SYNC) widens the range
    d.setRange = (R, quiet) => { const pc = ctl[`${k}.pitch`], cur = +pc.el.value; d.range = R; lsSet('tempoRange' + d.i, R); pc.el.min = -R; pc.el.max = R; pc.el.step = (2 * R) / 2000; pc.el.value = clamp(cur, -R, R); pc.apply(+pc.el.value); if (!quiet) toast('Deck ' + (d.i + 1) + ' tempo range ±' + R + ' %'); };
    d.cycleRange = () => { const L = [6, 8, 10, 16, 25]; d.setRange(L[(L.indexOf(d.range) + 1) % L.length]); };
    d.setKeyLock = on => { d.keylock = !!on; engSend({ cmd: 'keyLock', deck: d.i, on: d.keylock }); };
    ctl[`${k}.pitch`].set(0);
    const root = $(`#deck${d.i}`);
    root.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.mode) d.padMode = b.dataset.mode;
      switch (b.dataset.act) { case 'play': d.toggle(); break; case 'sync': d.syncTo(decks[1 - d.i]); break;
        case 'scr': hmSearch(d); break; case 'pfl': togglePfl(d); break; case 'reset': d.synced = false; ctl[`${k}.pitch`].set(0); break; }
    });
    $('[data-act=cue]', root).addEventListener('pointerdown', () => d.cueDown());
    window.addEventListener('pointerup', () => d.cueUp());
    $('#pads' + d.i).addEventListener('pointerdown', e => { const p = e.target.closest('.pad'); if (p) { d._padHeld = +p.dataset.pad; d.pad(+p.dataset.pad, true); } });
    $('#pads' + d.i).addEventListener('contextmenu', e => { e.preventDefault(); const p = e.target.closest('.pad'); if (p && d.padMode === 'hot') { d.hot[+p.dataset.pad] = null; d.saveCues(); } else if (p && d.padMode === 'jump') fxMenu(+p.dataset.pad, e.clientX, e.clientY); else if (p && d.padMode === 'roll' && +p.dataset.pad < 3) fxMenu(4 + +p.dataset.pad, e.clientX, e.clientY); });
    $('#pads' + d.i).addEventListener('wheel', e => { const p = e.target.closest('.pad'); if (!p || !(d.padMode === 'jump' || (d.padMode === 'roll' && +p.dataset.pad < 3))) return; e.preventDefault(); const s = (d.padMode === 'roll' ? 4 : 0) + +p.dataset.pad; fxChoose(s, (fxSlots[s] + (e.deltaY > 0 ? 1 : FX_NAMES.length - 1)) % FX_NAMES.length); }, { passive: false });
    window.addEventListener('pointerup', () => { if (d._padHeld != null) { d.pad(d._padHeld, false); d._padHeld = null; } });
    $('#ov' + d.i).addEventListener('pointerdown', e => { const r = e.target.getBoundingClientRect(); d.seek((e.clientX - r.left) / r.width * d.dur); });
    {   // the waveform is a control: click = play / pause, drag = scrub (back / forward, the track follows the hand), wheel = zoom, shift + wheel = nudge the position
      const wv = $('#wv' + d.i); let drag = null; wv.title = 'Click: play / pause · drag: rewind / forward · wheel: zoom · shift + wheel: nudge'; wv.style.touchAction = 'none';
      wv.addEventListener('pointerdown', e => { if ((e.button !== 0 && e.pointerType === 'mouse') || !d.buf) return; try { wv.setPointerCapture(e.pointerId); } catch {} drag = { id: e.pointerId, x: e.clientX, pos: d.pos(), moved: false, was: d.playing }; wv.classList.add('grab'); });
      wv.addEventListener('pointermove', e => {
        if (!drag || e.pointerId !== drag.id) return; const dx = e.clientX - drag.x; if (!drag.moved && Math.abs(dx) < 4) return;
        if (!drag.moved) { drag.moved = true; if (d.playing) d.pause(); }
        d.seek(clamp(drag.pos - dx / Math.max(1, wv.clientWidth) * d.zoom, 0, d.dur));
      });
      const end = e => { if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.id)) return; const g = drag; drag = null; wv.classList.remove('grab'); if (!g.moved) d.toggle(); else if (g.was) d.play(); };
      wv.addEventListener('pointerup', end); wv.addEventListener('pointercancel', end); wv.addEventListener('lostpointercapture', end);
      wv.addEventListener('wheel', e => { e.preventDefault(); if (e.shiftKey) { if (d.buf) d.seek(clamp(d.pos() + Math.sign(e.deltaY || e.deltaX) * d.zoom * 0.08, 0, d.dur)); return; } d.zoom = clamp(d.zoom * (e.deltaY > 0 ? 1.15 : 1 / 1.15), 0.8, 60); }, { passive: false });
    }
  }
  for (const d of decks) d.wave = $('#wv' + d.i), d.ov = $('#ov' + d.i), d.ovCache = document.createElement('canvas');
}
function togglePfl(d, on) { d.pflOn = on === undefined ? !d.pflOn : !!on; d.pfl.gain.value = d.pflOn ? 1 : 0; if (nat.active) engSend({ cmd: 'param', name: `d${d.i}.pfl`, value: d.pflOn ? 1 : 0 }); }

/* ------------------------------------------------------------------ rendering */
const DPR = Math.min(2, window.devicePixelRatio || 1);
function sizeCanvas(c) { const w = Math.round(c.clientWidth * DPR), h = Math.round(c.clientHeight * DPR); if (c.width !== w || c.height !== h) { c.width = w; c.height = h; return true; } return false; }

/* Waveform: vivid colours (saturation and brightness lifted, played part dimmed), a bright core inside the peak envelope, bar numbers and phrase marks on the beat grid,
   intro / outro zones, a time ruler, loop and cue flags and a glowing playhead. */
const wvFmt = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
function wvColor(r, g, b, k) {   // k = brightness 0..1 (played part is dimmer)
  const l = 0.3 * r + 0.59 * g + 0.11 * b; r = l + (r - l) * 2.5; g = l + (g - l) * 2.5; b = l + (b - l) * 2.5; r = Math.max(0, r); g = Math.max(0, g); b = Math.max(0, b);   // saturate hard, keep the hue
  const m = Math.max(r, g, b, 1), sc = Math.min(2.2, 245 / m) ** 0.95;                                                  // lift dull colours
  return [clamp(r * sc * k, 0, 255) | 0, clamp(g * sc * k, 0, 255) | 0, clamp(b * sc * k, 0, 255) | 0];
}
function drawWave(d) {
  const c = d.wave; sizeCanvas(c); const g = c.getContext('2d'), W = c.width, H = c.height, mid = H / 2, rulerH = 12 * DPR;
  const bg = g.createLinearGradient(0, 0, 0, H); bg.addColorStop(0, '#0b0d13'); bg.addColorStop(0.5, '#05060a'); bg.addColorStop(1, '#0b0d13'); g.fillStyle = bg; g.fillRect(0, 0, W, H);
  if (!d.an) { g.fillStyle = '#4b5060'; g.font = `${14 * DPR}px Segoe UI`; g.textAlign = 'center'; g.fillText(d.loading ? 'Loading…' : 'Load a track from the playlist', W / 2, mid + 5); return; }
  const an = d.an, pos = d.pos(), cw = 2 * DPR, cols = Math.ceil(W / cw), tpc = d.zoom / cols, f = d.feat || {};
  const x = t => (t - pos) / d.zoom * W + W / 2, tl = pos - d.zoom / 2, tr = pos + d.zoom / 2, amp = mid - rulerH * 0.5;
  // structure zones
  if (f.introEndS > 1) { g.fillStyle = 'rgba(55,214,122,.07)'; g.fillRect(x(0), 0, x(f.introEndS) - x(0), H); }
  if (f.outroStartS != null && f.outroStartS < d.dur - 1) { g.fillStyle = 'rgba(255,176,32,.08)'; g.fillRect(x(f.outroStartS), 0, x(d.dur) - x(f.outroStartS), H); }
  g.fillStyle = 'rgba(255,255,255,.05)'; g.fillRect(0, mid - 0.5 * DPR, W, DPR);   // centre axis
  for (let i = 0; i < cols; i++) {
    const t = pos + (i - cols / 2) * tpc; if (t < 0 || t > d.dur) continue;
    const b0 = Math.floor(t * BPS), b1 = Math.max(b0, Math.floor((t + tpc) * BPS)); let best = 0, bi = b0;
    for (let b = b0; b <= b1 && b < an.n; b++) if (an.amp[b] > best) { best = an.amp[b]; bi = b; }
    if (bi >= an.n) continue;
    const h = Math.max(1, best / 255 * amp * 0.96), o = bi * 3, k = i < cols / 2 ? 0.62 : 1, [r, gg, bl] = wvColor(an.col[o], an.col[o + 1], an.col[o + 2], k), px = i * cw, wd = cw - DPR * 0.35;
    g.fillStyle = `rgba(${r},${gg},${bl},.92)`; g.fillRect(px, mid - h, wd, h * 2);   // peak envelope
    const hc = h * 0.5; g.fillStyle = `rgba(${r + (255 - r) * 0.5 | 0},${gg + (255 - gg) * 0.5 | 0},${bl + (255 - bl) * 0.5 | 0},${0.55 * k + 0.2})`; g.fillRect(px, mid - hc, wd, hc * 2);   // bright core
  }
  { const tip = g.createLinearGradient(0, 0, 0, H); tip.addColorStop(0, 'rgba(0,0,0,.45)'); tip.addColorStop(0.3, 'rgba(0,0,0,0)'); tip.addColorStop(0.7, 'rgba(0,0,0,0)'); tip.addColorStop(1, 'rgba(0,0,0,.45)'); g.fillStyle = tip; g.fillRect(0, 0, W, H); }   // tips fade out (one gradient for the whole strip)
  if (d.loop) { const lx0 = x(d.loop.start), lx1 = x(d.loop.end); g.fillStyle = 'rgba(55,214,122,.2)'; g.fillRect(lx0, 0, lx1 - lx0, H); g.fillStyle = '#37d67a'; g.fillRect(lx0, 0, 2 * DPR, H); g.fillRect(lx1 - 2 * DPR, 0, 2 * DPR, H); g.font = `bold ${9 * DPR}px Segoe UI`; g.textAlign = 'left'; g.fillText('LOOP', lx0 + 4 * DPR, H - rulerH - 3 * DPR); }
  g.font = `${9 * DPR}px Segoe UI`;
  if (an.bpm) {
    const per = 60 / an.bpm, beatPx = per / d.zoom * W;
    for (let k = Math.ceil((tl - an.grid) / per); an.grid + k * per < tr; k++) {
      const bar = k % 4 === 0, phrase = k % 16 === 0, px = Math.round(x(an.grid + k * per));
      g.strokeStyle = phrase ? 'rgba(255,215,90,.8)' : bar ? 'rgba(255,255,255,.5)' : 'rgba(255,255,255,.16)'; g.lineWidth = phrase ? 2 * DPR : DPR;
      g.beginPath(); g.moveTo(px, bar ? 0 : H * 0.28); g.lineTo(px, bar ? H - rulerH : H * 0.72); g.stroke();
      if (bar && beatPx * 4 > 34 * DPR && k >= 0) { g.fillStyle = phrase ? '#ffd75a' : 'rgba(255,255,255,.7)'; g.textAlign = 'left'; g.fillText(String(k / 4 + 1), px + 3 * DPR, H - rulerH - 3 * DPR); }
    }
  }
  // time ruler
  g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(0, H - rulerH, W, rulerH);
  const steps = [1, 2, 5, 10, 15, 30, 60, 120], step = steps.find(s => s / d.zoom * W > 70 * DPR) || 120;
  g.fillStyle = '#9aa0b0'; g.strokeStyle = '#555a68'; g.lineWidth = DPR; g.textAlign = 'left';
  for (let t = Math.ceil(Math.max(0, tl) / step) * step; t < Math.min(tr, d.dur); t += step) { const px = Math.round(x(t)); g.beginPath(); g.moveTo(px, H - rulerH); g.lineTo(px, H - rulerH * 0.55); g.stroke(); g.fillText(wvFmt(t), px + 3 * DPR, H - 2.5 * DPR); }
  // flags: intro end, outro, cue and hot cues
  const flag = (t, color, label, w = 14) => { if (t < tl || t > tr) return; const px = Math.round(x(t));
    g.fillStyle = color; g.fillRect(px - DPR / 2, 0, DPR * 1.5, H - rulerH); g.beginPath(); g.moveTo(px, 0); g.lineTo(px + w * DPR, 0); g.lineTo(px + (w - 4) * DPR, 7 * DPR); g.lineTo(px + w * DPR, 14 * DPR); g.lineTo(px, 14 * DPR); g.fill();
    g.fillStyle = '#000'; g.font = `bold ${10 * DPR}px Segoe UI`; g.textAlign = 'left'; g.fillText(label, px + 3 * DPR, 11 * DPR); };
  if (f.introEndS > 1) flag(f.introEndS, 'rgba(55,214,122,.8)', 'IN', 18);
  if (f.outroStartS != null && f.outroStartS < d.dur - 1) flag(f.outroStartS, 'rgba(255,176,32,.85)', 'OUT', 22);
  flag(d.cuePt, '#ffb020', 'C'); d.hot.forEach((t, n) => t != null && flag(t, PAD_COL[n], String(n + 1)));
  // playhead with a soft glow and end markers
  g.save(); g.shadowColor = '#ffffff'; g.shadowBlur = 8 * DPR; g.fillStyle = '#fff'; g.fillRect(W / 2 - DPR, 0, 2 * DPR, H - rulerH); g.restore();
  g.fillStyle = '#fff'; g.beginPath(); g.moveTo(W / 2 - 5 * DPR, 0); g.lineTo(W / 2 + 5 * DPR, 0); g.lineTo(W / 2, 7 * DPR); g.fill();
}
function renderOverview(d) {
  const c = d.ovCache; c.width = Math.max(200, Math.round(d.ov.clientWidth * DPR)); c.height = Math.round(d.ov.clientHeight * DPR) || 40;
  const g = c.getContext('2d'), W = c.width, H = c.height, an = d.an; g.clearRect(0, 0, W, H); if (!an) return;
  for (let x = 0; x < W; x++) {
    const b0 = Math.floor(x / W * an.n), b1 = Math.max(b0, Math.floor((x + 1) / W * an.n) - 1); let best = 0, bi = b0;
    for (let b = b0; b <= b1 && b < an.n; b++) if (an.amp[b] > best) { best = an.amp[b]; bi = b; }
    const o = bi * 3, h = Math.max(1, best / 255 * H / 2 * 0.95);
    { const [r, gg, bl] = wvColor(an.col[o], an.col[o + 1], an.col[o + 2], 1); g.fillStyle = `rgb(${r},${gg},${bl})`; g.fillRect(x, H / 2 - h, 1, h * 2); }
  }
}
function drawOverview(d) {
  const c = d.ov; if (sizeCanvas(c) || d._ovw !== c.width) { d._ovw = c.width; renderOverview(d); }
  const g = c.getContext('2d'), W = c.width, H = c.height; g.clearRect(0, 0, W, H);
  if (!d.an) return; g.drawImage(d.ovCache, 0, 0, W, H);
  const px = d.pos() / d.dur * W; g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(0, 0, px, H);
  g.fillStyle = '#ffb020'; g.fillRect(d.cuePt / d.dur * W, 0, DPR, H);
  d.hot.forEach((t, n) => { if (t != null) { g.fillStyle = PAD_COL[n]; g.fillRect(t / d.dur * W, 0, DPR * 1.5, H); } });
  g.fillStyle = '#fff'; g.fillRect(px - DPR / 2, 0, DPR * 1.5, H);
}
/* Key / energy readout. Key and energy are estimates: a trailing "?" means low confidence (atonal, noisy or ambiguous music). */
function keyText(d) {
  const f = d.feat; if (!f) return '';
  const k = f.key, kt = k ? `${k.camelot}${k.confidence < 0.35 ? '?' : ''} (${k.name})` : 'key n/a';
  return `${kt} · E${f.energy}`;
}
function featTip(d) {
  const f = d.feat; if (!f) return '';
  const k = f.key, pct = v => Math.round(v * 100) + '%';
  return [k ? `Key: ${k.name} = ${k.camelot}, confidence ${pct(k.confidence)}${k.confidence < 0.35 ? ' (low: treat as a guess)' : ''}, runner-up ${k.runnerUp}` : 'Key: not detected',
    `Tempo confidence ${pct(f.bpmConfidence)}, stability ${pct(f.tempoStability)}, ${f.timeSignature}/4`,
    `Energy ${f.energy}/10 (estimate), danceability ${pct(f.danceability)} (estimate)`,
    `Loudness ${f.rmsDb.toFixed(1)} dB RMS, peak ${f.peakDb.toFixed(1)} dB, dynamic range ${f.dynamicRangeDb.toFixed(1)} dB`,
    f.introEndS != null ? `Intro ends ~${f.introEndS.toFixed(0)} s` : '', f.outroStartS != null ? `Outro starts ~${f.outroStartS.toFixed(0)} s` : '',
    `Mood: ${f.mood} (rough estimate)`].filter(Boolean).join('\n');
}
const lastUi = [{}, {}];
function setCls(el, cls, on) { if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on); }
function updateUi(d) {
  const i = d.i, root = $('#deck' + i), pos = d.pos(), U = lastUi[i];
  const rem = lsGet('timeRemaining', false), tm = rem ? '-' + fmt(Math.max(0, d.dur - pos)) : fmt(pos); if (U.tm !== tm) { $('#tm' + i).textContent = tm; U.tm = tm; }
  if (U.name !== d.name) { $('#tt' + i).textContent = d.name; U.name = d.name; }
  const bp = (d.an && d.an.bpm ? `${(d.an.bpm * d.rate).toFixed(1)} BPM   (${d.an.bpm.toFixed(1)} orig)   –${fmt(d.dur - pos)}` : d.an ? 'BPM n/a' : '') + (d.feat ? '   ' + keyText(d) : '');
  if (U.bp !== bp) { const el = $('#bp' + i); el.textContent = bp; el.title = featTip(d); U.bp = bp; }
  setCls($('[data-act=play]', root), 'lit', d.playing); $('[data-act=play]', root).textContent = '▶❚❚';
  setCls($('[data-act=cue]', root), 'lit', !d.playing && d.buf && Math.abs(pos - d.cuePt) < 0.03);
  const o = decks[1 - i], synced = !!(d.effBpm && o.effBpm && Math.abs(d.effBpm - o.effBpm) < 0.06);
  setCls($('[data-act=sync]', root), 'lit', synced); d._syncLit = synced;
  setCls($('[data-act=scr]', root), 'lit', hmOn(d)); setCls($('[data-act=pfl]', root), 'lit', d.pflOn);
  root.querySelectorAll('[data-mode]').forEach(b => setCls(b, 'sel', b.dataset.mode === d.padMode)); if (root.dataset.pm !== d.padMode) root.dataset.pm = d.padMode;
  const labels = { hot: ['1', '2', '3', '4'], loop: ['1', '2', '4', '8'], jump: fxSlots.slice(0, 4).map(i => FX_NAMES[i]), mloop: ['Loop in', 'Loop out', 'Loop exit', 'Loop 1/2x'], roll: [...fxSlots.slice(4, 7).map(i => FX_NAMES[i]), fxAdd[d.i] ? 'Dry+Wet' : 'Dry/Wet'] }[d.padMode];
  root.querySelectorAll('.pad').forEach((p, n) => {
    if (p.textContent !== String(n + 1)) p.textContent = String(n + 1);   // the printed pad numbers; the function in this mode is the tooltip
    const tip = 'Pad ' + (n + 1) + ': ' + labels[n] + (d.padMode === 'jump' || (d.padMode === 'roll' && n < 3) ? ' (hold = effect on; right-click or scroll = change effect)' : d.padMode === 'roll' ? ' (press = switch mix mode)' : '');
    if (p.title !== tip) p.title = tip;
    const fxs = d.padMode === 'jump' ? FX_SHORT[fxSlots[n]] : d.padMode === 'roll' ? (n < 3 ? FX_SHORT[fxSlots[4 + n]] : fxAdd[d.i] ? 'D+W' : 'D/W') : ''; if ((p.dataset.fx || '') !== fxs) { if (fxs) p.dataset.fx = fxs; else delete p.dataset.fx; }
    const on = padLit(d, n); setCls(p, 'set', on); p.style.setProperty('--padc', d.padMode === 'hot' ? PAD_COL[n] : '#37d67a');
  });
  const li = d.loop ? `LOOP ${((d.loop.end - d.loop.start) * (d.an ? d.an.bpm : 0) / 60).toFixed(2).replace(/\.?0+$/, '')} beats` : '';
  if (U.li !== li) { $('#li' + i).textContent = li; U.li = li; }
}
function padLit(d, n) {
  if (d.padDn[n] || d.padFlash[n] > performance.now()) return true;
  if (d.padMode === 'hot') return d.hot[n] != null;
  if (d.padMode === 'roll' && n === 3) return !fxAdd[d.i];   // manual: pad 4 lit = Dry/Wet, off = Dry+Wet
  if (d.padMode === 'mloop') return n === 0 ? d._ddjIn != null : n === 2 ? !!d.loop : false;
  if (d.padMode === 'loop') {
    if (!d.loop || !d.an || !d.an.bpm) return false;
    const beats = (d.loop.end - d.loop.start) * d.an.bpm / 60, want = [1, 2, 4, 8][n];
    return Math.abs(beats - want) < 0.01;
  }
  return false;
}
let lastFrame = performance.now();
function frame(now) {
  lastFrame = now;
  for (const d of decks) {
    if (Math.abs(d.bend) > 0.0008) d.setBend(d.bend * 0.82); else if (d.bend !== 0) d.setBend(0);
    if (!window.__djHidden) { drawWave(d); drawOverview(d); }
    updateUi(d);
  }
  updateLeds();
  requestAnimationFrame(frame);
}

/* ------------------------------------------------------------------ loading tracks */
async function loadToDeck(d, item) {
  if (!item) return;
  if (item.radio) return playRadio(item);   // a live stream is not loaded into a deck
  if (!nat.active) AC.resume();
  d.loading = true; d.pause(); d.an = null; d.buf = null; d.feat = null; d.name = 'Loading… ' + item.name;
  try {
    if (nat.active && item.path) {                       // native engine: decode + analysis happen in djengine, off the UI thread
      const ev = await natLoad(d.i, item);
      d.buf = { duration: ev.duration, sampleRate: ev.sampleRate };
      d.an = { n: ev.n, amp: b64ToU8(ev.amp), col: b64ToU8(ev.col), bpm: ev.bpm, grid: ev.grid };
      d.trackId = item.id; d.path = item.path; d.name = trackLabel(item); d.loop = null; d.previewing = false; d.synced = false; d.playing = false; d.feat = ev.features || null;
      d.nPos = 0; d.nT = performance.now(); d.guard = d.nT + 250; d.loadCues(); autoCues(d); if (d.cuePt) d.seek(d.cuePt);
      d._ovw = -1; item.dur = ev.duration; item.bpm = ev.bpm; persistPlaylist(); renderPlaylist();
      d.loading = false; return;
    }
    let ab;
    if (item.path && window.electronAPI) ab = await window.electronAPI.readFile(item.path);
    else {
      let file = item.file;
      if (item.handle) {
        let perm = await item.handle.queryPermission({ mode: 'read' });
        if (perm !== 'granted') perm = await item.handle.requestPermission({ mode: 'read' });
        if (perm !== 'granted') throw new Error('Permission to read the file was not granted. Click the track once with the mouse.');
        file = await item.handle.getFile();
      }
      ab = await file.arrayBuffer();
    }
    const buf = await AC.decodeAudioData(ab);
    await new Promise(r => setTimeout(r, 0));
    const an = analyze(buf);
    d.buf = buf; d.an = an; d.trackId = item.id; d.name = trackLabel(item);
    d.anchorPos = 0; d.loop = null; d.previewing = false; d.synced = false; d.loadCues(); autoCues(d); if (d.cuePt) d.anchorPos = d.cuePt;
    d._ovw = -1;
    item.dur = buf.duration; item.bpm = an.bpm; persistPlaylist(); renderPlaylist();
  } catch (e) { d.name = 'No track'; toast('Could not load "' + item.name + '": ' + (e.message || e)); }
  d.loading = false;
}

/* ------------------------------------------------------------------ playlist (+ persistence of file handles) */
let playlist = [], sel = -1;
const idb = {
  db: null,
  open() { return new Promise((res, rej) => { const r = indexedDB.open('ddjsbdj', 1); r.onupgradeneeded = () => r.result.createObjectStore('playlist', { keyPath: 'id' }); r.onsuccess = () => { this.db = r.result; res(); }; r.onerror = () => rej(r.error); }); },
  async saveAll(items) { if (!this.db) return; const tx = this.db.transaction('playlist', 'readwrite'), s = tx.objectStore('playlist'); s.clear(); items.forEach((it, order) => it.handle && s.put({ id: it.id, order, name: it.name, handle: it.handle, dur: it.dur, bpm: it.bpm })); },
  getAll() { return new Promise(res => { if (!this.db) return res([]); const r = this.db.transaction('playlist').objectStore('playlist').getAll(); r.onsuccess = () => res(r.result.sort((a, b) => a.order - b.order)); r.onerror = () => res([]); }); },
};
const persistPlaylist = () => {
  if (window.__folderView) return;   // the browser shows a temporary list: never save it over the playlist
  if (window.electronAPI) lsSet('playlist', playlist.filter(i => i.path || i.radio).map(({ id, name, url, radio, path, dur, bpm, artist, title, meta, album, genre, camelot, keyName, keyConf, energy, anStatus }) => ({ id, name, url, radio, path, dur, bpm, artist, title, meta, album, genre, camelot, keyName, keyConf, energy, anStatus })));
  else idb.saveAll(playlist).catch(() => {});
};
function addPaths(items) {
  if (window.__folderView && window.fbrowser) window.fbrowser.leave();
  const have = new Set(playlist.map(i => i.path));
  for (const it of items) if (!have.has(it.path)) playlist.push({ id: newId(), name: it.name, path: it.path, dur: 0, bpm: 0 });
  finishAdd();
}
const AUDIO_RE = /\.(mp3|wav|flac|m4a|aac|ogg|opus|aif|aiff|wma)$/i;
const newId = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()));

async function addHandle(h) { if (h.kind === 'file' && AUDIO_RE.test(h.name)) { playlist.push({ id: newId(), name: h.name, handle: h }); } }
async function scanDir(dir, depth = 0) {
  const list = []; for await (const e of dir.values()) list.push(e);
  list.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const e of list) { if (e.kind === 'file') await addHandle(e); else if (depth < 3) await scanDir(e, depth + 1); }
}
function addFiles(files) { if (window.__folderView && window.fbrowser) window.fbrowser.leave(); for (const f of files) if (AUDIO_RE.test(f.name) || f.type.startsWith('audio/')) playlist.push({ id: newId(), name: f.name, file: f, dur: 0, bpm: 0 }); finishAdd(); }
function finishAdd() { if (sel < 0 && playlist.length) sel = 0; persistPlaylist(); renderPlaylist(); libScan(playlist, false); fetchMeta(); }

/* Artist / title: read tags in the desktop app (music-metadata), else guess "Artist - Title" from the file name. */
const baseName = it => it.name.replace(/\.[^.]+$/, '');
function guessTags(it) {
  const m = baseName(it).replace(/_/g, ' ').match(/^(?:\d{1,3}\s*[-.)]\s*)?(.+?)\s+-\s+(.+)$/);
  return m ? { artist: m[1].trim(), title: m[2].trim() } : { artist: '', title: '' };
}
const trackTitle = it => it.title || guessTags(it).title || baseName(it);
const trackArtist = it => it.artist || guessTags(it).artist || '';
const trackLabel = it => { const a = trackArtist(it), t = trackTitle(it); return a ? `${a} – ${t}` : t; };
let metaBusy = false;
async function fetchMeta() {
  if (!window.electronAPI || !window.electronAPI.readMeta || metaBusy) return;
  metaBusy = true;
  try {
    for (;;) {
      const todo = playlist.filter(i => i.path && (!i.meta || i.meta < 2)).slice(0, 40); if (!todo.length) break;
      let res = {}; try { res = await window.electronAPI.readMeta(todo.map(i => i.path)); } catch {}
      for (const it of todo) { const r = res[it.path] || {}; it.artist = r.artist || ''; it.title = r.title || ''; it.album = r.album || ''; it.genre = r.genre || ''; if (!it.dur && r.dur) it.dur = r.dur; it.meta = 2; }
      for (const it of todo) scheduleRender(filterText || keyFilter ? null : it);   // update rows in place (a full redraw per batch made the UI stutter)
      persistSoon(); libScan(todo, false);
    }
  } finally { metaBusy = false; }
}

/* Search box: filters by artist, title and file name */
let filterText = '';
let keyFilter = '';   // Camelot key chosen on the Harmonic Match wheel (filters the playlist too)
function setKeyFilter(k) {
  keyFilter = (k && k !== keyFilter) ? k : '';
  const chip = document.getElementById('keyChip'); if (chip) { chip.hidden = !keyFilter; chip.textContent = keyFilter ? 'Key ' + keyFilter + ' ✕' : ''; }
  const vis = visibleIdx(); if (vis.length && !vis.includes(sel)) sel = vis[0]; renderPlaylist();
  return keyFilter;
}
const visibleIdx = () => {
  const q = filterText.trim().toLowerCase();
  if (!q) return playlist.map((_, i) => i).filter(i => !keyFilter || playlist[i].camelot === keyFilter);
  const words = q.split(/\s+/); const out = [];
  playlist.forEach((it, i) => { if (keyFilter && it.camelot !== keyFilter) return; const hay = (trackArtist(it) + ' ' + trackTitle(it) + ' ' + it.name).toLowerCase(); if (words.every(w => hay.includes(w))) out.push(i); });
  return out;
};
const AUDIO_TYPES = [{ description: 'Audio', accept: { 'audio/*': ['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.aif', '.aiff'] } }];

const escH = x => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
function rowInner(it, n) {
  const badges = decks.map(d => d.trackId === it.id ? `<span class="badge ${d.i ? 'b' : 'a'}">${d.i ? 'B' : 'A'}</span>` : '').join('');
  return `<td class="n">${n + 1}</td><td class="ar">${escH(trackArtist(it))}</td><td class="t">${badges}${escH(trackTitle(it))}</td><td>${fmtS(it.dur)}</td><td>${it.bpm ? it.bpm.toFixed(1) : '–'}</td>${keyCells(it)}
      <td>${it.radio ? '<button class="ld a" data-d="radio" title="Play this radio station">📻 ▶</button>' : '<button class="ld a" data-d="0">A</button><button class="ld b" data-d="1">B</button>' + (NE ? '<button class="ld re" data-d="re" title="Analyse this track again">↻</button>' : '')}<button class="ld" data-d="x" title="${window.__folderView ? 'Add to the playlist' : 'Remove'}">${window.__folderView ? '＋' : '✕'}</button></td>`;
}
/* ------------------------------------------------------------------ M3U playlists and internet radio
   "Browse PC…" adds files; "M3U / Radio…" opens a playlist file (.m3u / .m3u8 / .pls: local songs go to the playlist, http addresses become radio entries) or takes an internet
   radio address (a stream, or a playlist that lists streams). Radio entries play on their own RADIO player (play / stop / volume in the playlist bar) through the default
   output; they are not loaded into a deck (a live stream cannot be beat-matched or cued). */
const radio = { el: new Audio(), item: null };
radio.el.preload = 'none'; radio.el.volume = lsGet('radioVol', 0.8);
function radioUi() {
  const box = $('#radioBox'); if (!box) return;
  box.hidden = !radio.item && !playlist.some(i => i.radio);
  $('#radioName').textContent = radio.item ? radio.item.name : 'Radio';
  $('#radioBtn').textContent = radio.item && !radio.el.paused ? '■' : '▶';
  $('#radioVol').value = radio.el.volume;
}
function playRadio(it) {
  if (!it || !it.url) return;
  radio.item = it; radio.el.src = it.url; radioUi();
  radio.el.play().then(() => { toast('Radio: ' + it.name); radioUi(); }).catch(e => {
    toast('This stream could not be played: ' + (e && e.message ? e.message : e) + '. Check the address (MP3 / AAC / Ogg streams only, no HLS).', 7000);
    radio.item = null; radio.el.removeAttribute('src'); radioUi();
  });
}
function stopRadio() { radio.el.pause(); radio.el.removeAttribute('src'); radio.el.load(); radio.item = null; radioUi(); }
radio.el.addEventListener('error', () => { if (radio.item) { toast('The radio stream stopped: ' + radio.item.name, 5000); radio.item = null; radioUi(); } });
function addRadioEntries(list) {
  let n = 0;
  for (const e of list) {
    if (playlist.some(i => i.radio && i.url === e.url)) continue;
    playlist.push({ id: newId(), name: e.name || e.url, title: e.name || e.url, artist: 'Radio', url: e.url, radio: true, dur: 0, bpm: 0 }); n++;
  }
  return n;
}
async function importEntries(res) {
  if (!res || res.error) { toast(res && res.error ? res.error : 'Nothing was added', 7000); return false; }
  const files = res.entries.filter(e => e.kind === 'file').map(e => e.path), urls = res.entries.filter(e => e.kind === 'url');
  let nf = 0;
  if (files.length && window.electronAPI) {
    const items = await window.electronAPI.scanPaths(files); nf = items.length;
    const have = new Set(playlist.map(i => i.path));
    for (const it of items) if (!have.has(it.path)) playlist.push({ id: newId(), name: it.name, path: it.path, dur: 0, bpm: 0 });
  }
  const nr = addRadioEntries(urls);
  if (!nf && !nr) { toast('The playlist has nothing that can be played here (missing files?).', 6000); return false; }
  finishAdd(); radioUi();
  toast(`Added ${nf} song${nf === 1 ? '' : 's'}` + (nr ? ` and ${nr} radio station${nr === 1 ? '' : 's'}` : ''));
  return true;
}
function openRadioDialog() {
  let dlg = document.getElementById('radiodlg');
  if (!dlg) {
    dlg = document.createElement('dialog'); dlg.id = 'radiodlg'; dlg.className = 'radiodlg';
    dlg.innerHTML = '<h3>M3U playlist / internet radio</h3><p class="dim">Paste a radio address (a stream, or a .m3u / .pls link) or open a playlist file from this PC.</p>' +
      '<input id="radioUrl" type="url" placeholder="https://…  (stream or .m3u / .pls address)" spellcheck="false" autocomplete="off"><div id="radioMsg" class="radiomsg"></div>' +
      '<menu><button id="radioFile">📂 Open .m3u / .pls file…</button><button id="radioAddBtn" class="primary">Add address</button><button id="radioClose">Close</button></menu>';
    document.body.appendChild(dlg);
    const msg = t => { $('#radioMsg').textContent = t || ''; };
    $('#radioClose').onclick = () => dlg.close();
    $('#radioFile').onclick = async () => {
      msg(''); const r = await window.electronAPI.pickPlaylist();
      if (r && r.entries && !r.entries.length && !r.error) return;   // dialog cancelled
      if (await importEntries(r)) dlg.close(); else msg(r && r.error || '');
    };
    const add = async () => {
      const u = $('#radioUrl').value.trim(); if (!u) return; msg('Contacting the server…');
      const r = await window.electronAPI.fetchPlaylist(u);
      if (await importEntries(r)) { $('#radioUrl').value = ''; dlg.close(); } else msg(r && r.error || '');
    };
    $('#radioAddBtn').onclick = add; $('#radioUrl').addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  }
  $('#radioMsg').textContent = ''; dlg.showModal(); $('#radioUrl').focus();
}

let plBound = false;
function bindPlaylist(tb) {
  plBound = true;
  tb.addEventListener('click', e => {
    const tr = e.target.closest('tr[data-n]'); if (!tr) return;
    const n = +tr.dataset.n, it = playlist[n]; if (!it) return;
    const bt = e.target.closest('button'); sel = n;
    if (bt) {
      if (bt.dataset.d === 're' && it.path) { libSend({ cmd: 'libraryReanalyze', paths: [it.path] }); it.anStatus = 'pending'; }
      else if (bt.dataset.d === 'x' && window.__folderView) { window.fbrowser.addToPlaylist(it); }
      else if (bt.dataset.d === 'x') { playlist.splice(n, 1); sel = Math.min(sel, playlist.length - 1); persistPlaylist(); }
      else if (bt.dataset.d === 'radio') playRadio(it);
      else loadToDeck(decks[+bt.dataset.d], it);
    }
    renderPlaylist();
  });
  tb.addEventListener('dblclick', e => {
    const tr = e.target.closest('tr[data-n]'); if (!tr || e.target.closest('button')) return;
    if (playlist[+tr.dataset.n] && playlist[+tr.dataset.n].radio) return playRadio(playlist[+tr.dataset.n]);
    loadToDeck(decks.find(d => !d.playing) || decks[0], playlist[+tr.dataset.n]);
  });
}
function renderPlaylist() {
  const tb = $('#tbl tbody'); if (!plBound) bindPlaylist(tb);
  const vis = visibleIdx();
  let html;
  if (!playlist.length && window.__folderView) html = '<tr><td colspan="8" class="empty">Choose a drive or folder on the left to see its tracks here.</td></tr>';
  else if (!playlist.length) html = '<tr><td colspan="8" class="empty">Browse the PC for files or a folder (or drop them here), or add an M3U playlist / internet radio, to build your playlist.</td></tr>';
  else if (!vis.length) html = '<tr><td colspan="8" class="empty">No tracks match your search.</td></tr>';
  else html = vis.map(n => { const it = playlist[n]; return `<tr class="trk${n === sel ? ' sel' : ''}" data-n="${n}" title="${escH(it.name)}">${rowInner(it, n)}</tr>`; }).join('');
  tb.innerHTML = html;
  radioUi();
  $('#libInfo').textContent = !playlist.length ? '' : vis.length === playlist.length ? `${playlist.length} tracks` : `${vis.length} of ${playlist.length} tracks`;
}
/* update just one row (used while the background analysis delivers results) */
function patchRow(it) {
  const n = playlist.indexOf(it); if (n < 0) return;
  const tr = $('#tbl tbody').querySelector('tr[data-n="' + n + '"]'); if (tr) tr.innerHTML = rowInner(it, n);
}
let _persistTimer = 0;
function persistSoon() { if (_persistTimer) return; _persistTimer = setTimeout(() => { _persistTimer = 0; persistPlaylist(); }, 3000); }
window.addEventListener('beforeunload', () => { try { persistPlaylist(); } catch {} });
/* Scroll only the playlist box so the row is visible; the page itself never scrolls (that used to push the toolbar out of view). */
function revealRow(row, center) {
  const wrap = row && row.closest('.tablewrap'); if (!wrap) return;
  const head = 28, top = row.offsetTop, bottom = top + row.offsetHeight;
  if (center) wrap.scrollTop = Math.max(0, top - wrap.clientHeight / 2);
  else if (top < wrap.scrollTop + head) wrap.scrollTop = Math.max(0, top - head);
  else if (bottom > wrap.scrollTop + wrap.clientHeight) wrap.scrollTop = bottom - wrap.clientHeight + 4;
}
function moveSel(dir) {
  const vis = visibleIdx(); if (!vis.length) return;
  const pos = vis.indexOf(sel);
  sel = vis[pos < 0 ? (dir > 0 ? 0 : vis.length - 1) : clamp(pos + dir, 0, vis.length - 1)]; renderPlaylist();
  revealRow($('#tbl tbody tr.sel'), false);
}

function initLibraryUi() {
  $('#btnRadio').onclick = () => { if (window.electronAPI && window.electronAPI.pickPlaylist) openRadioDialog(); else toast('Playlists and radio need the desktop app.'); };
  $('#radioBtn').onclick = () => { if (radio.item && !radio.el.paused) stopRadio(); else { const it = radio.item || playlist.find(i => i.radio); if (it) playRadio(it); } };
  $('#radioVol').oninput = e => { radio.el.volume = +e.target.value; lsSet('radioVol', radio.el.volume); };
  $('#btnAdd').onclick = async () => {
    if (window.fbrowser) return window.fbrowser.toggle();   // Browse PC: the playlist area becomes the folder browser (press again to go back)
    if (window.electronAPI) addPaths(await window.electronAPI.pickFiles());
    else if (window.showOpenFilePicker) { try { const hs = await showOpenFilePicker({ multiple: true, types: AUDIO_TYPES }); for (const h of hs) await addHandle(h); finishAdd(); } catch {} }
    else { const i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.accept = 'audio/*'; i.onchange = () => addFiles(i.files); i.click(); }
  };
  $('#btnFolder').onclick = async () => {
    if (window.electronAPI) return addPaths(await window.electronAPI.pickFolder());
    if (!window.showDirectoryPicker) return toast('Folder picking needs Edge or Chrome');
    try { const dir = await showDirectoryPicker(); await scanDir(dir); finishAdd(); } catch {}
  };
  $('#btnClear').onclick = () => { playlist = []; sel = -1; persistPlaylist(); renderPlaylist(); };
  const search = $('#search');
  search.addEventListener('input', () => { filterText = search.value; const vis = visibleIdx(); if (vis.length && !vis.includes(sel)) sel = vis[0]; renderPlaylist(); });
  search.addEventListener('keydown', e => {
    if (e.key === 'Escape') { search.value = ''; filterText = ''; renderPlaylist(); search.blur(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); moveSel(1); } else if (e.key === 'ArrowUp') { e.preventDefault(); moveSel(-1); }
    else if (e.key === 'Enter') loadToDeck(decks.find(d => !d.playing) || decks[0], playlist[sel]);
  });
  window.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); search.focus(); search.select(); } });
  const lib = $('#library');
  lib.addEventListener('dragover', e => { e.preventDefault(); lib.classList.add('drop'); });
  lib.addEventListener('dragleave', () => lib.classList.remove('drop'));
  lib.addEventListener('drop', async e => {
    e.preventDefault(); lib.classList.remove('drop');
    if (window.electronAPI) {
      const paths = [...e.dataTransfer.files].map(f => window.electronAPI.pathForFile(f)).filter(Boolean);
      return addPaths(await window.electronAPI.scanPaths(paths));
    }
    const items = [...e.dataTransfer.items].filter(i => i.kind === 'file');
    const proms = items.map(i => i.getAsFileSystemHandle ? i.getAsFileSystemHandle() : Promise.resolve(null));
    const files = [...e.dataTransfer.files], hs = await Promise.all(proms);
    if (hs.every(h => h)) { for (const h of hs) { if (h.kind === 'directory') await scanDir(h); else await addHandle(h); } finishAdd(); }
    else addFiles(files);
  });
}

/* ------------------------------------------------------------------ output devices */
const cleanLabel = l => String(l || '').replace(/^(Default|Communications) - /, '').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '');
const realDevices = devs => devs.filter(d => d.deviceId !== 'default' && d.deviceId !== 'communications');
/* A short beep through a chosen device so you can hear which output you are about to pick. */
let beepUrl = null;
function beepWavUrl() {
  if (beepUrl) return beepUrl;
  const sr = 22050, n = Math.floor(sr * 0.7), b = new DataView(new ArrayBuffer(44 + n * 2));
  const w = (o, s) => [...s].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); b.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
  b.setUint32(24, sr, true); b.setUint32(28, sr * 2, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true); w(36, 'data'); b.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const t = i / sr, env = Math.min(1, t * 40, (0.7 - t) * 40); b.setInt16(44 + i * 2, Math.sin(2 * PI * (t < 0.35 ? 523 : 659) * t) * env * 9000, true); }
  return beepUrl = URL.createObjectURL(new Blob([b], { type: 'audio/wav' }));
}
async function playBeep(id) {
  const a = new Audio(beepWavUrl());
  try { if (a.setSinkId) await a.setSinkId(!id || id === 'default' ? '' : id); await a.play(); } catch (e) { toast('Test sound failed: ' + e.message); }
}
async function pickDevice(title, opts = {}) {
  try { const s = await navigator.mediaDevices.getUserMedia({ audio: true }); s.getTracks().forEach(t => t.stop()); } catch {}
  const devs = realDevices((await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput'));
  const sel = $('#devsel'); sel.innerHTML = ''; $('#devtitle').textContent = title; $('#devhint').textContent = opts.hint || '';
  const add = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); return o; };
  (opts.extra || []).forEach(([v, t]) => add(v, t));
  let pick = null;
  devs.forEach(d => { const o = add(d.deviceId, cleanLabel(d.label) || d.deviceId); if (!pick && opts.prefer && opts.prefer(d.label)) pick = o; });
  (pick || sel.options[0]).selected = true;
  const test = $('#devtest'); test.onclick = () => { if (sel.value !== 'off') playBeep(sel.value); };
  const dlg = $('#devdlg'); return new Promise(res => { dlg.onclose = () => res(dlg.returnValue === 'ok' ? { id: sel.value, label: sel.selectedOptions[0].textContent } : null); dlg.showModal(); });
}
async function setMasterSink(id, label) {
  try { if (AC.setSinkId) await AC.setSinkId(id === 'default' ? '' : id); else throw new Error('setSinkId not supported'); }
  catch (e) { return toast('Could not switch master output: ' + e.message); }
  $('#masterName').textContent = cleanLabel(label); lsSet('sinkMaster', { id, label });
  if (AC.state !== 'running') await AC.resume().catch(() => {});
  toast(`Master output → ${cleanLabel(label)}`);
}
async function setCueSink(id, label) {
  if (id === 'off') { cueMode = 'off'; cueEl.pause(); }
  else {
    try { await cueEl.setSinkId(id === 'default' ? '' : id); cueMode = 'device'; await cueEl.play(); } catch (e) { return toast('Could not use cue output: ' + e.message); }
  }
  rewire(); $('#cueName').textContent = id === 'off' ? 'off' : cleanLabel(label); lsSet('sinkCue', { id, label });
  if (id !== 'off') toast(`Headphone cue → ${cleanLabel(label)}. Press HEADPHONE on a deck to hear it.`);
}
function initOutputs() {
  const isPM = l => /party\s*mix/i.test(l || '');
  $('#btnMaster').onclick = async () => {
    const r = await pickDevice('Master output (speakers / main mix)', { extra: [['default', 'System default']], prefer: isPM, hint: 'Where the main mix plays, e.g. the Party Mix or your speakers.' });
    if (r) setMasterSink(r.id, r.label);
  };
  $('#btnCue').onclick = async () => {
    const r = await pickDevice('Headphone cue output', { extra: [['off', 'Off (no headphone cue)']], prefer: l => !isPM(l), hint: 'Pick the output your headphones are plugged into, usually a different device from the master (for example the computer’s own headphone jack). Use "Test sound" to check.' });
    if (r) setCueSink(r.id, r.label);
  };
  const inv = $('#invPitch'); inv.checked = lsGet('invPitch', false); inv.onchange = () => lsSet('invPitch', inv.checked);
  if (!NE) restoreLegacyOutputs();                       // with the native engine, outputs come from its own settings
}
let legacyRestored = false;
function restoreLegacyOutputs() {
  if (legacyRestored) return; legacyRestored = true;
  const m = lsGet('sinkMaster', null); if (m) setMasterSink(m.id, m.label);
  const c = lsGet('sinkCue', null); if (c && c.id !== 'off' && c.id !== 'split') setCueSink(c.id, c.label);
  else if (c && c.id === 'split') { lsSet('sinkCue', { id: 'off', label: 'off' }); toast('The "channels 3–4" cue option was removed because it cannot work in the built-in audio. Choose a headphone output with Cue out.', 7000); }
}

/* ------------------------------------------------------------------ Pioneer DDJ-SB MIDI (mapping in ddjsb.js) */
let midiOut = null, midiNames = [];
const monlog = $('#monlog'); let monOn = false;
function monitor(msg) { if (!monOn) return; monlog.textContent = (msg + '\n' + monlog.textContent).slice(0, 4000); }

/* diagnostics: the last 500 control-change messages (not the jog wheels) are kept in localStorage 'midiLog' as "ms,status,cc,value;..." so a misbehaving fader can be analysed afterwards */
const midiLog = []; let midiLogN = 0;
setInterval(() => { if (midiLogN !== midiLog.length || midiLog.length >= 6000) { midiLogN = midiLog.length; lsSet('midiLog', midiLog.map(x => x.join(',')).join(';')); } }, 2000);
function onMidi(e) {
  const [st, d1, d2 = 0] = e.data; if (st >= 0xF0) return;
  if (window.__midiTap) window.__midiTap(e.data);   // controller test: every raw message
  if ((st & 0xF0) === 0xB0 && d1 !== 0x06) { midiLog.push([Math.round(performance.now()), st, d1, d2]); if (midiLog.length > 6000) midiLog.shift(); }
  const type = st & 0xF0, ch = st & 0x0F; const t = (type === 0x90 && d2 === 0) ? 0x80 : type;
  monitor(`${st.toString(16).toUpperCase()} ${d1.toString(16).padStart(2, '0')} ${d2.toString(16).padStart(2, '0')}   ${t === 0xB0 ? 'CC' : t === 0x90 ? 'NoteOn' : t === 0x80 ? 'NoteOff' : 'type ' + type.toString(16)} ch${ch + 1}`);
  if (window.ddjsb) { window.ddjsb.handle(st, d1, d2); return; }   // Pioneer DDJ-SB mapping (ddjsb.js)
  if (t === 0xB0) onCC(ch, d1, d2); else if (t === 0x90 || t === 0x80) onNote(ch, d1, t === 0x90);
}
function onCC(ch, n, v) {
  const v01 = v / 127;
  if (ch <= 1) {
    const d = decks[ch], k = `d${ch}`;
    switch (n) {
      case 0x06: d.jog(v < 0x40 ? v : v - 0x80); break;
      case 0x09: ctl[`${k}.pitch`].set((lsGet('invPitch', false) ? -1 : 1) * (v01 - 0.5) * 16); break;
      case 0x17: ctl[`${k}.gain`].set(v01); break;
      case 0x18: ctl[`${k}.treble`].set(v01); break;
      case 0x19: ctl[`${k}.bass`].set(v01); break;
      case 0x1C: ctl[`${k}.vol`].set(v01); break;
    }
  } else if (ch === 15) {
    switch (n) {
      case 0x08: if (!(window.autodj && window.autodj.S && window.autodj.S.on)) ctl.xf.set(v01 * 2 - 1); break;   // (Auto DJ drives the crossfader itself)
      case 0x0A: ctl.master.set(v01); break;
      case 0x0C: ctl.headGain.set(v01); break;
      case 0x0D: ctl.headMix.set(v01); break;
      case 0x00: moveSel(v > 0x40 ? -1 : 1); break;
    }
  }
}
/* After the analysis, a track that has no cue points yet gets 4 hot cues (pads 1-4 in CUE mode), snapped to the bar grid:
   1 first downbeat (beat start), 2 end of the intro, 3 the chorus / drop (the biggest sustained jump in loudness after the intro), 4 start of the outro.
   Only once per track (and never over cues you set yourself); clear them with the right-click on a pad. */
function autoCues(d) {
  try {
    if (!d.buf || !d.an || !d.trackId || d.hot.some(x => x != null) || lsGet('autocued:' + d.trackId, false)) return;
    const dur = d.buf.duration, f = d.feat || {}, bpm = d.an.bpm, bar = bpm ? 240 / bpm : 0;
    if (!(dur > 30)) return;
    let start = Number.isFinite(f.downbeatOffsetS) ? f.downbeatOffsetS : (d.an.grid || 0); start = clamp(start, 0, dur * 0.4);
    const snap = t => bar ? start + Math.round((t - start) / bar) * bar : t;
    const amp = d.an.amp, n = amp.length, per = dur / n, win = Math.max(2, Math.round((bar ? bar * 8 : 16) / per));
    const pre = new Float64Array(n + 1); for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + amp[i];
    const mean = (a, b) => (pre[Math.min(n, b)] - pre[Math.max(0, a)]) / Math.max(1, Math.min(n, b) - Math.max(0, a));
    const intro = snap(Number.isFinite(f.introEndS) && f.introEndS > start ? f.introEndS : start + (bar ? bar * 8 : 20));
    const outro = snap(Number.isFinite(f.outroStartS) && f.outroStartS > intro ? f.outroStartS : dur - (bar ? bar * 16 : 40));
    let best = -1, bi = 0; for (let i = Math.floor(intro / per); i + win <= Math.min(n, outro / per); i++) { const g = mean(i, i + win) - mean(i - win, i); if (g > best) { best = g; bi = i; } }
    let chorus = bi ? snap(bi * per) : snap((intro + outro) / 2);
    const cues = [start, intro, chorus, outro]; const minGap = bar ? Math.max(bar * 2, 4) : 6;
    for (let k = 1; k < 4; k++) { while (cues[k] < cues[k - 1] + minGap && bar && cues[k] < dur - 2) cues[k] += bar; }
    d.hot = cues.map(t => (t > 0.05 && t < dur - 2) || t === cues[0] ? Math.max(0, +t.toFixed(3)) : null);
    if (!d.cuePt) d.cuePt = d.hot[0] || 0;
    d.saveCues(); lsSet('autocued:' + d.trackId, true);
    toast('4 cue points placed: START · INTRO END · CHORUS/DROP · OUTRO (pads 1-4 in CUE mode)');
  } catch (e) { /* cue points are a convenience: never block a load */ }
}
const hpGain = v => v * v * 3;   // headphone volume curve (0..1 -> linear gain up to 3; the engine rounds off the peaks)
function hmSearch(d) { if (window.harmonic) window.harmonic.openForDeck(d.i); }
const hmOn = d => !!(window.harmonic && window.harmonic.hm.sourceMode === String(d.i));
/* ------------------------------------------------------------------ FX (PAD MODE = SAMPLER): 4 pads = 4 effect slots, 16 effects to choose from (native engine) */
const FX_NAMES = ['Flanger', 'Phaser', 'Echo', 'Ping-Pong', 'Reverb', 'Bit Crusher', 'Gater', 'Auto-Pan', 'Ring Mod', 'Auto-Wah', 'Chorus', 'Overdrive', 'Stutter', 'Dub Echo', 'Telephone', 'Filter Sweep',
  'Tape Stop', 'Spinback', 'Reverse', 'Trance Gate', 'Machine Gun', 'Beat Roll', 'Tape Echo', 'Vibrato', 'Sidechain Pump', 'Lo-Fi', 'Megaphone', 'Underwater', 'Noise Riser', 'Robot', 'Jet', 'HP Sweep', 'Bass Kill', 'Lows Only', 'Octave Down', 'Octave Up'];
const FX_SHORT = ['FLNG', 'PHAS', 'ECHO', 'PING', 'REVB', 'CRSH', 'GATE', 'PAN', 'RING', 'WAH', 'CHOR', 'DRV', 'STUT', 'DUB', 'TELE', 'SWP',
  'STOP', 'SPIN', 'REV', 'TRNC', 'GUN', 'ROLL', 'TAPE', 'VIB', 'PUMP', 'LOFI', 'MEGA', 'DEEP', 'RISE', 'ROBO', 'JET', 'HPS', 'BKIL', 'LOW', 'OCT-', 'OCT+'];
const FX_DEFAULT = [0, 1, 2, 4, 2, 0, 15, 2, 4, 0, 2, 4, 0];   // + slots 7-9: FX1 SELECT 1-3 · slots 10-12: FX2 SELECT 1-3   // slots 0-3: EFFECTS pads 1-4 · slots 4-6: EFFECT 2 pads 1-3
let fxSlots = (() => { const v = lsGet('fxSlots', null); const ok = Array.isArray(v) && v.every(x => Number.isInteger(x) && x >= 0 && x < FX_NAMES.length); return ok ? FX_DEFAULT.map((x, i) => (i < v.length ? v[i] : x)) : FX_DEFAULT.slice(); })();
const fxAdd = [false, false];   // EFFECT 2, pad 4: false = Dry/Wet, true = Dry+Wet (per deck)
const fxHeld = [Array(13).fill(false), Array(13).fill(false)]; let fxBpmSent = 0;
function fxSync() { fxSlots.forEach((e, s) => engSend({ cmd: 'fxEffect', slot: s, effect: e })); fxAdd.forEach((add, deck) => engSend({ cmd: 'fxMode', deck, additive: add })); fxBpmSent = 0; }
function fxHold(deck, slot, on) {   // an effect works on the channel of the deck whose pad is held, nowhere else
  if (fxHeld[deck][slot] === on) return; fxHeld[deck][slot] = on; engSend({ cmd: 'fxOn', deck, slot, on });
}
function fxSlotName(slot) { return slot >= 10 ? 'FX2 SELECT ' + (slot - 9) : slot >= 7 ? 'FX1 SELECT ' + (slot - 6) : slot < 4 ? 'SAMPLER pad ' + (slot + 1) : 'Pad bank 2 · pad ' + (slot - 3); }
function fxChoose(slot, effect) { fxSlots[slot] = effect; lsSet('fxSlots', fxSlots); engSend({ cmd: 'fxEffect', slot, effect }); toast(fxSlotName(slot) + ' = ' + FX_NAMES[effect]); }
function fxMenu(slot, x, y) {
  document.querySelectorAll('.fxmenu').forEach(e => e.remove());
  const m = document.createElement('div'); m.className = 'fxmenu';
  m.innerHTML = '<h4>' + fxSlotName(slot).toUpperCase() + '</h4>' + FX_NAMES.map((n, i) => '<button data-i="' + i + '"' + (fxSlots[slot] === i ? ' class="cur"' : '') + '>' + n + '</button>').join('');
  m.style.left = Math.max(4, Math.min(x, innerWidth - 380)) + 'px'; m.style.top = Math.max(4, Math.min(y, innerHeight - 420)) + 'px';
  m.addEventListener('click', e => { const b = e.target.closest('button'); if (b) { fxChoose(slot, +b.dataset.i); m.remove(); } });
  document.body.appendChild(m);
  setTimeout(() => window.addEventListener('pointerdown', function off(e) { if (!m.contains(e.target)) { m.remove(); window.removeEventListener('pointerdown', off); } }), 0);
}
setInterval(() => { const d = decks.find(x => x.playing && x.an && x.an.bpm) || decks.find(x => x.an && x.an.bpm); const b = d ? Math.round(d.an.bpm * d.rate * 10) / 10 : 0; if (b && b !== fxBpmSent) { fxBpmSent = b; engSend({ cmd: 'fxBpm', value: b }); } }, 500);
/* PAD MODE: the Party Mix keeps the mode itself (3 LEDs: CUE, LOOP, EFFECTS; the 4th state lights all three) and tells us with a note on channel 5 / 6 that NAMES the mode
   (Mixxx preset: 0x00 CUE, 0x0B LOOP, 0x0E 3rd LED, 0x18 all three; the preset sends no LED messages). So the screen simply follows that note, and the app never writes the
   mode LEDs (writing 0x01 to them is what lit all three). Clicking a mode on the screen changes the screen only. */
const MODE_NOTE = { 0x00: 'hot', 0x0B: 'loop', 0x0E: 'jump', 0x18: 'roll' };   // jump = EFFECTS (3rd LED, 4 effect pads), roll = EFFECT 2 (all 3 LEDs: pads 1-3 effects, pad 4 dry/wet)
const MODE_ORDER = ['hot', 'loop', 'jump', 'roll'];
const cyclePadMode = d => { d.padMode = MODE_ORDER[(MODE_ORDER.indexOf(d.padMode) + 1) % MODE_ORDER.length]; };   // the PAD MODE button: next mode
function onNote(ch, n, down) {
  if (ch <= 1) {
    const d = decks[ch];
    if (n === 0x01) { down ? d.cueDown() : d.cueUp(); return; }
    if (n === 0x1B) { togglePfl(d, down); return; }   // the HEADPHONE button is a latching switch: ON message = on, OFF message = off (every press counts)
    if (!down) return;
    if (n === 0x00) d.toggle(); else if (n === 0x02) d.syncTo(decks[1 - ch]);
    else if (n === 0x07) hmSearch(d);;   // the SCRATCH button now starts the Harmonic Match search for this deck
  } else if (ch === 4 || ch === 5) {
    const d = decks[ch - 4];
    if (MODE_NOTE[n]) { if (down) d.padMode = MODE_NOTE[n]; }   // the controller lights its own LEDs on a press: overwrite with the screen's state
    else if (n >= 0x14 && n <= 0x17) d.pad(n - 0x14, down);
  } else if (ch === 15 && down) {
    if (n === 0x02) loadToDeck(decks[0], playlist[sel]); else if (n === 0x03) loadToDeck(decks[1], playlist[sel]);
  }
}
const ledCache = new Map();
setInterval(() => ledCache.clear(), 2000);   // re-send every LED state regularly so the controller always matches the screen
function led(status, note, on) {
  if (window.__ledHold) return;   // the controller test owns the LEDs while it is open
  const key = status * 256 + note, val = on ? 0x7F : 0x00;   // DDJ-SB: 0x7F lit, 0x00 dark
  //   // off = velocity 1 (a dim glow); the HEADPHONE button must really go dark, so it gets velocity 0
  if (!midiOut || ledCache.get(key) === val) return;
  ledCache.set(key, val); try { midiOut.send([status, note, val]); } catch {}
}
function ledsOff() { if (window.ddjsb) window.ddjsb.off(); }
function updateLeds() { if (midiOut && window.ddjsb) window.ddjsb.leds(); }
async function initMidi() {
  const st = $('#midiStatus');
  if (!navigator.requestMIDIAccess) { st.textContent = 'MIDI: not supported (use Edge or Chrome)'; return; }
  let acc; try { acc = await navigator.requestMIDIAccess(); } catch (e) { st.textContent = 'MIDI: permission denied'; return; }
  const refresh = () => {
    const ins = [...acc.inputs.values()].filter(i => /ddj[-\s]?sb/i.test(i.name));
    for (const i of acc.inputs.values()) i.onmidimessage = null; ins.forEach(i => i.onmidimessage = onMidi);
    const prev = midiOut; midiOut = [...acc.outputs.values()].find(o => /ddj[-\s]?sb/i.test(o.name)) || null;
    if (midiOut !== prev) ledCache.clear();
    midiNames = ins.map(i => i.name);
    if (ins.length && window.ddjWizard) window.ddjWizard.maybeFirstRun();   // first time the DDJ-SB is seen: offer the calibration wizard
    st.className = 'chip ' + (ins.length ? 'on' : 'off');
    st.textContent = ins.length ? `MIDI: ${ins[0].name} connected` : 'MIDI: DDJ-SB not found – plug it in';
  };
  acc.onstatechange = refresh; refresh();
  window.addEventListener('beforeunload', () => { if (midiOut && window.ddjsb) window.ddjsb.off(); });
}

/* ------------------------------------------------------------------ music library (SQLite in the engine, analysed in the background) */
const lib = { ready: false, progress: null, stats: null, lastScan: null, timer: 0 };
const libSend = c => { if (NE) NE.send(c); };
const itemMeta = it => ({ path: it.path, artist: it.artist || undefined, title: it.title || undefined, album: it.album || undefined, genre: it.genre || undefined });
function libScan(items, force) {
  if (!lib.ready) return;
  const list = items.filter(i => i.path).map(itemMeta);
  if (list.length) libSend({ cmd: 'libraryScan', id: nat.reqId++, force: !!force, items: list });
}
function applyRow(it, row) {
  it.anStatus = row.status; it.anError = row.error;
  if (row.status === 'done') { it.camelot = row.camelot; it.keyName = row.keyName; it.keyConf = row.keyConf; it.energy = row.energy; if (row.bpm) it.bpm = row.bpm; if (row.duration) it.dur = row.duration; }
}
const _dirtyRows = new Set(); let _fullRender = false;
function scheduleRender(it) {
  if (it) _dirtyRows.add(it); else _fullRender = true;
  if (lib.timer) return;
  lib.timer = setTimeout(() => {
    lib.timer = 0;
    if (_fullRender) renderPlaylist(); else for (const r of _dirtyRows) patchRow(r);
    _dirtyRows.clear(); _fullRender = false;
    persistSoon(); updateAnalysisUi();
  }, 250);
}
function camelotColor(c) { const n = parseInt(c, 10); return `hsl(${((n - 1) * 30 + 200) % 360},70%,66%)`; }
function keyCells(it) {
  let k = '–';
  if (it.camelot) { const low = it.keyConf != null && it.keyConf < 0.35; k = `<span style="color:${camelotColor(it.camelot)};${low ? 'opacity:.6' : ''}">${it.camelot}${low ? '?' : ''}</span>`; }
  else if (it.anStatus === 'error') k = `<span class="err" title="${String(it.anError || 'analysis failed').replace(/"/g, '&quot;')}">!</span>`;
  else if (it.anStatus === 'pending' || it.anStatus === 'analyzing') k = '…';
  const tip = it.camelot ? `${it.keyName} = ${it.camelot}, confidence ${Math.round((it.keyConf || 0) * 100)}%${it.keyConf < 0.35 ? ' (low: a guess)' : ''}` : '';
  return `<td class="k" title="${tip}">${k}</td><td class="e">${it.energy != null ? it.energy : ''}</td>`;
}
function updateAnalysisUi() {
  const box = $('#anBox'); if (!box) return; box.hidden = !lib.ready;
  const p = lib.progress, total = playlist.filter(i => i.path).length, done = playlist.filter(i => i.anStatus === 'done').length, errs = playlist.filter(i => i.anStatus === 'error').length;
  const busy = p && (p.pending || p.running);
  $('#anInfo').textContent = busy ? `analysing: ${p.running} running, ${p.pending} waiting${p.paused ? ' (paused)' : ''}` : `${done}/${total} analysed${errs ? ', ' + errs + ' could not be analysed' : ''}`;
  $('#btnPauseAn').textContent = p && p.paused ? '▶ Resume analysis' : '⏸ Pause analysis';
}
function onLibraryEvent(ev) {
  switch (ev.evt) {
    case 'libraryReady':
      lib.ready = true; lib.stats = ev.stats;
      libSend({ cmd: 'libraryConfig', workers: +lsGet('anWorkers', 2), cpuLimit: +lsGet('anCpu', 100) });
      libSend({ cmd: 'libraryGet', id: 'initial', paths: playlist.map(i => i.path).filter(Boolean) });   // cached results first (instant)
      libScan(playlist, false);                                                                              // then pick up new / changed files
      updateAnalysisUi(); break;
    case 'libraryRows': { const by = new Map(playlist.map(i => [i.path, i])); for (const row of ev.rows) { const it = by.get(row.path); if (it) applyRow(it, row); } scheduleRender(); break; }
    case 'trackAnalyzed': { const it = playlist.find(x => x.path === ev.path); if (it && ev.row) { applyRow(it, ev.row); scheduleRender(it); } break; }
    case 'trackError': { const it = playlist.find(x => x.path === ev.path); if (it) { it.anStatus = 'error'; it.anError = ev.message; scheduleRender(it); } break; }
    case 'libraryProgress': lib.progress = ev; updateAnalysisUi(); break;
    case 'libraryScanned': lib.lastScan = ev; break;
    case 'libraryStats': lib.stats = ev.stats; break;
    case 'libraryMatches': { const p = nat.pending.get(ev.id); if (p) { nat.pending.delete(ev.id); p.res(ev); } break; }
    case 'librarySequence': { const p = nat.pending.get(ev.id); if (p) { nat.pending.delete(ev.id); p.res(ev); } break; }
    case 'librarySequenceError': { const p = nat.pending.get(ev.id); if (p) { nat.pending.delete(ev.id); p.rej(new Error(ev.message)); } break; }
    case 'libraryMatchError': { const p = nat.pending.get(ev.id); if (p) { nat.pending.delete(ev.id); p.rej(new Error(ev.message)); } break; }
    case 'libraryError': console.warn('[library]', ev.message); toast('Library: ' + ev.message, 6000); break;
  }
}
/* Ranked matches for one analysed track (H3). opts: { settings: {weights, pitchLimit, keylock, gates, sourcePitch}, filter: {...}, scope: {paths, folder, exclude} } */
function libMatch(path, opts = {}) {
  return new Promise((res, rej) => {
    const id = nat.reqId++, t = setTimeout(() => { nat.pending.delete(id); rej(new Error('the library did not answer')); }, 30000);
    nat.pending.set(id, { res: v => { clearTimeout(t); res(v); }, rej: e => { clearTimeout(t); rej(e); } });
    libSend({ cmd: 'libraryMatch', id, path, settings: opts.settings || {}, filter: opts.filter || {}, scope: opts.scope || {} });
  });
}
/* Overview of an ordered list of tracks: distributions, transitions, problems (H4) */
function libSequence(paths, settings) {
  return new Promise((res, rej) => {
    const id = nat.reqId++, t = setTimeout(() => { nat.pending.delete(id); rej(new Error('the library did not answer')); }, 60000);
    nat.pending.set(id, { res: v => { clearTimeout(t); res(v); }, rej: e => { clearTimeout(t); rej(e); } });
    libSend({ cmd: 'libraryAnalyzeSequence', id, paths, settings: settings || {} });
  });
}
function initJogControl() {
  const el = document.getElementById('jogSens'); if (!el) return;
  el.value = Math.round(jogSens() * 100);
  el.oninput = () => { lsSet('jogSens', +el.value / 100); el.title = 'Jog wheel sensitivity: ' + el.value + '%'; };
  el.title = 'Jog wheel sensitivity: ' + el.value + '%';
}
function initLibraryControls() {
  initJogControl();
  const kc = document.getElementById('keyChip'); if (kc) kc.onclick = () => setKeyFilter('');
  if (!NE) return;
  const w = $('#anWorkers'), c = $('#anCpu'); w.value = String(lsGet('anWorkers', 2)); c.value = String(lsGet('anCpu', 100));
  const cfg = () => { lsSet('anWorkers', +w.value); lsSet('anCpu', +c.value); libSend({ cmd: 'libraryConfig', workers: +w.value, cpuLimit: +c.value }); };
  w.onchange = c.onchange = cfg;
  $('#btnAnalyze').onclick = () => { libScan(playlist, false); toast('Analysing tracks that are new or changed…', 2500); };
  $('#btnPauseAn').onclick = () => libSend({ cmd: lib.progress && lib.progress.paused ? 'libraryResume' : 'libraryPause' });
}

/* ------------------------------------------------------------------ native audio engine (djengine.exe) */
const b64ToU8 = s => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
function nativeParam(name, v) {
  if (!nat.active) return;
  const mf = /^fx(\d)$/.exec(name); if (mf) { engSendThrottled('fxl:' + mf[1], { cmd: 'fxLevel', deck: +mf[1], value: v }, 8); return; }
  let n, val = v; const m = /^d(\d)\.(\w+)$/.exec(name);
  if (m) {
    const k = m[2];
    if (k === 'gain') { n = `d${m[1]}.trim`; val = v * 2; } else if (k === 'treble') { n = `d${m[1]}.high`; val = eqDb(v); }
    else if (k === 'bass') { n = `d${m[1]}.low`; val = eqDb(v); } else if (k === 'mid') { n = `d${m[1]}.mid`; val = eqDb(v); } else if (k === 'filter') { n = `d${m[1]}.filter`; val = (v - 0.5) * 2; } else if (k === 'vol') { n = `d${m[1]}.vol`; val = v * v; } else return;
  } else if (name === 'headGain') { n = 'filter'; val = (v - 0.5) * 2; } else if (name === 'headMix') { n = 'headGain'; val = hpGain(v); } else if (name === 'hpMix') { n = 'headMix'; val = v; } else if (name === 'xf' || name === 'master') n = name; else return;
  engSendThrottled('p:' + n, { cmd: 'param', name: n, value: val }, 8);
}
function syncNativeParams() {
  for (const k of Object.keys(ctl)) nativeParam(k, +ctl[k].el.value);
  for (const d of decks) { engSend({ cmd: 'keyLock', deck: d.i, on: !!d.keylock }); engSend({ cmd: 'param', name: `d${d.i}.pfl`, value: d.pflOn ? 1 : 0 }); engSend({ cmd: 'rate', deck: d.i, value: d.effRate }); }
}
function natLoad(deck, item) {
  return new Promise((res, rej) => {
    const id = nat.reqId++, t = setTimeout(() => { nat.pending.delete(id); rej(new Error('the audio engine did not answer')); }, 90000);
    nat.pending.set(id, { res: v => { clearTimeout(t); res(v); }, rej: e => { clearTimeout(t); rej(e); } });
    engSend({ cmd: 'load', deck, path: item.path, id });
  });
}
function enginePing() { return new Promise((res, rej) => { const id = nat.reqId++, t = setTimeout(() => { nat.pending.delete(id); rej(new Error('no answer')); }, 5000); nat.pending.set(id, { res: v => { clearTimeout(t); res(v); }, rej }); engSend({ cmd: 'ping', id }); }); }
function natFeatures(path) {
  return new Promise((res, rej) => {
    const id = nat.reqId++, t = setTimeout(() => { nat.pending.delete(id); rej(new Error('the audio engine did not answer')); }, 120000);
    nat.pending.set(id, { res: ev => { clearTimeout(t); res(ev.features); }, rej: e => { clearTimeout(t); rej(e); } });
    engSend({ cmd: 'features', path, id });
  });
}
function getEngineDevices() {
  return new Promise(res => { const t = setTimeout(() => res(nat.devices), 3000); nat.devWaiter = d => { clearTimeout(t); res(d); }; engSend({ cmd: 'devices' }); });
}
async function startNativeAudio() {
  const devs = await getEngineDevices();
  const ok = id => devs.some(d => d.id === id);
  const key = id => String(id || '').replace(/:[0-9A-Fa-f]{6,}(?=:)/g, ':*');   // a Mac device id holds the USB port (…Party Mix:14100000:1); the same device on another port still matches
  const heal = id => { if (!id || ok(id)) return id; const m = devs.filter(d => key(d.id) === key(id)); return m.length === 1 ? m[0].id : id; };
  let s = lsGet('audioSettings', null);
  if (s) { if (s.master) s.master = heal(s.master); if (s.cue && s.cue.mode === 'device') s.cue.device = heal(s.cue.device); }
  if (lsGet('audioSettingsV', 0) < 2) { s = null; lsSet('audioSettingsV', 2); }   // one-time reset: the default output is now the Realtek front speakers
  if (!s || (s.master && !ok(s.master))) {
    const rt = devs.find(d => /realtek/i.test(d.name) && /speaker/i.test(d.name)) || devs.find(d => /realtek/i.test(d.name)), ddj = devs.find(d => /ddj[-\s]?sb/i.test(d.name) && d.maxChannels >= 4);
    const pm = devs.find(d => /party\s*mix/i.test(d.name));
    const mac = /Mac/i.test(navigator.platform), def = devs.find(d => d.isDefault);
    if (ddj) s = { master: ddj.id, cue: { mode: 'same4' }, sampleRate: 0, buffer: 0 };   // the DDJ-SB is a 4-channel sound card: master out = channels 1/2, headphone jack = channels 3/4 (its MASTER LEVEL and HEADPHONES LEVEL knobs then work)
    else if (rt) s = { master: rt.id, cue: { mode: 'off' }, sampleRate: 0, buffer: 0 };
    else if (mac && def && pm && def.id !== pm.id) {   // a Mac: the Party Mix line outputs are rarely connected, so the master plays on the Mac's own output and the headphone cue goes to the controller's jack
      const common = (pm.rates || []).filter(r => (def.rates || []).includes(r));
      s = { master: def.id, cue: pm.maxChannels >= 4 ? { mode: 'device', device: pm.id } : { mode: 'off' }, sampleRate: common.includes(44100) ? 44100 : (common[0] || 0), buffer: 0 };
    } else s = { master: pm ? pm.id : null, cue: pm && pm.maxChannels >= 4 ? { mode: 'same4' } : { mode: 'off' }, sampleRate: 0, buffer: 0 };
  }
  if (s.cue && s.cue.mode === 'device' && !ok(s.cue.device)) s.cue = { mode: 'off' };
  nat.settings = s; engSend({ cmd: 'open', ...s }); engSend({ cmd: 'syncTrim', ms: lsGet('syncTrim', 0) });
}
async function resyncDecks() {
  for (const d of decks) {
    if (!d.trackId) continue; const it = playlist.find(x => x.id === d.trackId); if (!it) continue;
    const pos = d.pos(); d.playing = false; await loadToDeck(d, it); d.seek(pos);
  }
  toast('Audio engine recovered');
}
const dB = p => p > 1e-5 ? 20 * Math.log10(p) : -100;
const meterW = p => clamp((dB(p) + 60) / 60, 0, 1) * 100 + '%';
function setChip(text, cls, title) { const c = $('#engChip'); if (!c) return; c.textContent = text; c.className = 'chip ' + cls; if (title) c.title = title; }
function updateEngineChip() {
  const s = nat.status, st = nat.state; if (!s) return;
  const lat = st ? st.latencyMs.toFixed(0) : '–', cpu = st ? Math.round(st.cpu * 100) : 0;
  setChip(`ENGINE ${s.channels}ch ${(s.sampleRate / 1000).toFixed(1)}k · ${lat} ms · CPU ${cpu}%${st && st.xruns ? ' · xruns ' + st.xruns : ''}`, st && (st.xruns || performance.now() < nat.clipUntil) ? 'off' : 'on',
    `${s.masterName}${s.cue === 'same4' ? ' (headphones on channels 3/4)' : s.cue === 'device' ? ' · cue → ' + s.cueName : ''}`);
  const info = $('#aInfo'); if (info) info.textContent = `${s.masterName} · ${s.channels} channels · ${s.sampleRate} Hz · output latency ${lat} ms · buffer ${st ? st.bufferFrames : '–'} frames${s.cue === 'same4' ? ' · headphones: channels 3/4' : s.cue === 'device' ? ' · cue: ' + s.cueName : ''}`;
}
function onEngineState(ev) {
  nat.state = ev; const now = performance.now();
  ev.decks.forEach((s, i) => {
    const d = decks[i]; if (!d || !d.buf) return;
    if (now >= d.guard) { d.nPos = s.pos; d.nT = now; }
    if (d.playing && !s.playing && now - d.cmdAt > 250) { d.playing = false; d.nPos = s.pos; d.nT = now; }
  });
  const L = $('#mtrL'), R = $('#mtrR'); if (L) { L.style.width = meterW(ev.master[0]); R.style.width = meterW(ev.master[1]); }
  if (ev.clips > nat.lastClips) { nat.lastClips = ev.clips; nat.clipUntil = now + 1500; }
  const m = $('#mtr'); if (m) setCls(m, 'clip', now < nat.clipUntil);
  if ((nat.tick = (nat.tick || 0) + 1) % 10 === 0) updateEngineChip();
}
function onEngineEvent(ev) {
  switch (ev.evt) {
    case 'ready': nat.ready = true; startNativeAudio(); fxSync(); break;
    case 'devices': nat.devices = ev.devices; if (nat.devWaiter) { nat.devWaiter(ev.devices); nat.devWaiter = null; } break;
    case 'audio': {
      nat.status = ev.status; const first = !nat.active; nat.active = true;
      if (first) {
        AC.suspend().catch(() => {}); syncNativeParams(); fxSync(); const again = nat.everActive; nat.everActive = true;
        $('#btnMaster').innerHTML = 'Audio: <b id="masterName">settings…</b>'; $('#btnCue').hidden = true;
        if (again) resyncDecks(); else toast(`Audio engine: ${ev.status.masterName} · ${ev.status.channels} ch · ${ev.status.sampleRate} Hz${ev.status.cue === 'same4' ? ' · headphones on channels 3/4' : ''}`, 5000);
      } else if (ev.reconnected) toast('Audio device reconnected', 3000);
      updateEngineChip(); if (window.__bannerCheck) window.__bannerCheck(); break;
    }
    case 'audioError': toast('Audio engine: ' + ev.message, 7000); if (!nat.active) { setChip('ENGINE: built-in Web Audio', 'off', ev.message); restoreLegacyOutputs(); autoPickOutput(); } break;
    case 'audioLost': toast('Audio device lost, trying to reconnect…', 5000); setChip('ENGINE: device lost, reconnecting…', 'off'); break;
    case 'loaded': { const p = nat.pending.get(ev.id); if (p) { nat.pending.delete(ev.id); p.res(ev); } break; }
    case 'features': { const p = nat.pending.get(ev.id); if (p) { nat.pending.delete(ev.id); p.res(ev); } break; }
    case 'featuresError': { const p = nat.pending.get(ev.id); if (p) { nat.pending.delete(ev.id); p.rej(new Error(ev.message)); } break; }
    case 'loadError': { const p = nat.pending.get(ev.id); if (p) { nat.pending.delete(ev.id); p.rej(new Error(ev.message)); } break; }
    case 'state': onEngineState(ev); break;
    case 'pong': { const p = nat.pending.get(ev.id); if (p) { nat.pending.delete(ev.id); p.res(ev); } break; }
    case 'engineExit': toast('Audio engine stopped, restarting…', 4000); setChip('ENGINE: restarting…', 'off'); break;
    case 'engineUnavailable': if (!nat.everActive) { setChip('ENGINE: built-in Web Audio', 'off', ev.reason); restoreLegacyOutputs(); autoPickOutput(); } else toast('Audio engine unavailable: ' + ev.reason, 8000); break;
    case 'warning': case 'error': console.warn('[engine]', ev.message); break;
    default: if (/^library/.test(ev.evt) || ev.evt === 'trackAnalyzed' || ev.evt === 'trackError') onLibraryEvent(ev);
  }
}
function openAudioDialog() {
  const dlg = $('#audiodlg'), M = $('#aMaster'), C = $('#aCue'), R = $('#aRate'), B = $('#aBuf'), devs = nat.devices, s = nat.settings || {};
  const fill = (sel, opts, cur) => { sel.innerHTML = ''; for (const [v, t] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = t; sel.appendChild(o); } if ([...sel.options].some(o => o.value === cur)) sel.value = cur; };
  const curCue = !s.cue || s.cue.mode === 'off' ? 'off' : s.cue.mode === 'same4' ? 'same4' : 'dev:' + s.cue.device;
  fill(M, [['', 'System default'], ...devs.map(d => [d.id, d.name + (d.maxChannels >= 4 ? ` · ${d.maxChannels} channels` : '')])], s.master || '');
  const cur = { cue: curCue, rate: String(s.sampleRate || 0), buf: String(s.buffer || 0) };
  const refresh = () => {
    const md = devs.find(d => d.id === M.value) || devs.find(d => d.isDefault) || devs[0];
    const cueOpts = [['off', 'Off (no headphone cue)']];
    if (md && md.maxChannels >= 4) cueOpts.push(['same4', 'Headphone jack of this device (channels 3/4), e.g. Party Mix']);
    devs.filter(d => !md || d.id !== md.id).forEach(d => cueOpts.push(['dev:' + d.id, d.name + ' (separate device)']));
    fill(C, cueOpts, cur.cue);
    fill(R, [['0', 'Device default'], ...(md ? md.rates.map(r => [String(r), r + ' Hz']) : [])], cur.rate);
    fill(B, [['0', 'Auto (device decides)'], ['128', '128'], ['256', '256'], ['512', '512'], ['1024', '1024']], cur.buf);
  };
  refresh();
  const apply = () => {
    cur.cue = C.value; cur.rate = R.value; cur.buf = B.value;
    const cue = C.value === 'off' ? { mode: 'off' } : C.value === 'same4' ? { mode: 'same4' } : { mode: 'device', device: C.value.slice(4) };
    nat.settings = { master: M.value || null, cue, sampleRate: +R.value, buffer: +B.value }; lsSet('audioSettings', nat.settings);
    engSend({ cmd: 'open', ...nat.settings }); syncNativeParams();
  };
  M.onchange = () => { cur.cue = 'off'; cur.rate = '0'; refresh(); apply(); };
  C.onchange = R.onchange = B.onchange = apply;
  { const row = $('#drvRow'), b = $('#aDriver'); if (row && window.electronAPI && window.electronAPI.runDriverInstaller && /Win/i.test(navigator.platform)) { row.hidden = false; b.onclick = async () => { const r = await window.electronAPI.runDriverInstaller(); toast(r && r.ok ? 'Pioneer driver installer started (unplug and replug the DDJ-SB when it finishes)' : 'Could not start the driver installer: ' + (r && r.reason), 6000); }; } }
  const T = $('#aTrim'), TV = $('#aTrimV'); T.value = lsGet('syncTrim', 0); TV.textContent = T.value + ' ms';
  T.oninput = () => { TV.textContent = T.value + ' ms'; lsSet('syncTrim', +T.value); engSend({ cmd: 'syncTrim', ms: +T.value }); };
  $('#aTestM').onclick = () => engSend({ cmd: 'beep', target: 'master' });
  $('#aTestC').onclick = () => engSend({ cmd: 'beep', target: 'cue' });
  updateEngineChip(); dlg.showModal();
}
function initNative() {
  if (!NE) return setChip('ENGINE: built-in Web Audio', 'off');
  setChip('ENGINE: starting…', 'off');
  const legacyM = $('#btnMaster').onclick, legacyC = $('#btnCue').onclick;
  $('#btnMaster').onclick = e => nat.active ? openAudioDialog() : legacyM(e);
  $('#btnCue').onclick = e => nat.active ? openAudioDialog() : legacyC(e);
  NE.onEvent(onEngineEvent);
  NE.start().then(ok => { if (!ok) { setChip('ENGINE: built-in Web Audio', 'off', 'djengine.exe not found'); restoreLegacyOutputs(); autoPickOutput(); } });
}

/* ------------------------------------------------------------------ boot */
function boot() {
  buildUI(); initLibraryUi(); initOutputs(); renderPlaylist();
  $('#btnMon').onclick = () => { monOn = !monOn; $('#monitor').hidden = !monOn; };
  $('#monClose').onclick = () => { monOn = false; $('#monitor').hidden = true; };
  const banner = $('#banner'), chk = () => { banner.hidden = AC.state === 'running' || nat.active; }; window.__bannerCheck = chk;
  AC.onstatechange = chk; chk(); const unlock = () => { AC.resume(); cueEl.paused && cueMode === 'device' && cueEl.play().catch(() => {}); };
  banner.onclick = unlock; window.addEventListener('pointerdown', unlock); window.addEventListener('keydown', unlock);
  if (window.electronAPI) { playlist = lsGet('playlist', []); if (playlist.length) sel = 0; renderPlaylist(); fetchMeta(); }
  else idb.open().then(() => idb.getAll()).then(rows => { playlist = rows.map(r => ({ id: r.id, name: r.name, handle: r.handle, dur: r.dur, bpm: r.bpm })); if (playlist.length) sel = 0; renderPlaylist(); }).catch(() => {});
  initShortcuts(); if (!NE) autoPickOutput(); initMidi(); initLibraryControls(); initNative(); requestAnimationFrame(frame);
}

/* First run: if no output was chosen yet, use the Party Mix's own output when the browser can name it. */
async function autoPickOutput() {
  if (lsGet('sinkMaster', null) || !navigator.mediaDevices) return;
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput');
    const pm = realDevices(devs).find(d => /party\s*mix/i.test(d.label));
    if (pm) await setMasterSink(pm.deviceId, pm.label);
  } catch {}
}

/* Keyboard: Q/P play A/B, 1/2 load selected track to A/B, Up/Down select track, Enter load to free deck */
function initShortcuts() {
  window.addEventListener('keydown', e => {
    if (e.ctrlKey || e.altKey || e.metaKey || /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range' && e.target.type !== 'checkbox') return;
    const k = e.key.toLowerCase();
    if (k === 'q') decks[0].toggle(); else if (k === 'p') decks[1].toggle();
    else if (k === 's') decks[0].scratch = !decks[0].scratch; else if (k === 'd') decks[1].scratch = !decks[1].scratch;   // scratch mode moved to the keyboard
    else if (k === '1') loadToDeck(decks[0], playlist[sel]); else if (k === '2') loadToDeck(decks[1], playlist[sel]);
    else if (k === 'arrowdown' && e.target.type !== 'range') { e.preventDefault(); moveSel(1); }
    else if (k === 'arrowup' && e.target.type !== 'range') { e.preventDefault(); moveSel(-1); }
    else if (k === 'enter') loadToDeck(decks.find(d => !d.playing) || decks[0], playlist[sel]);
  });
}
boot();
window.dj = { radio, playRadio, stopRadio, addRadioEntries, FX_NAMES, fxChoose, get fxSlots() { return fxSlots; }, decks, ctl, addFiles, addPaths, ping: enginePing, revealRow, match: libMatch, sequence: libSequence, setKeyFilter, get keyFilter() { return keyFilter; }, lib, libSend, libScan, onLibraryEvent, analyzeFile: natFeatures, setMasterSink, setCueSink, cueEl, nat, engSend, openAudioDialog, get cueMode() { return cueMode; }, get playlist() { return playlist; }, loadToDeck, onMidi, mix, cue, AC };
