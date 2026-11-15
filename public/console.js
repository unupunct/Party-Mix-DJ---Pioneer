'use strict';
/* Console faceplate: the DJ screen laid out as the Pioneer DDJ-SB (top view).
   The board is a fixed 736 x 440 design that is scaled to the window, so every control keeps its place relative to the others.
   Nothing here changes what the controls do: the existing buttons, pads, sliders, MIDI bindings and engine commands are reused and
   repositioned; added are jog wheels (with the HARMONIC MATCH hub in the centre), rotary knobs, the browse wheel with LOAD 1 / LOAD 2,
   channel meters and the party lights on the top edge (+ a LIGHTS button in the toolbar).
   Globals from app.js: decks, ctl, playlist, sel, nat, midiOut, loadToDeck, moveSel, trackLabel, clamp, toast, lsGet, lsSet. */
(() => {
  const root = document.getElementById('decks');
  if (!root) return;
  root.classList.add('console');
  const NS = 'http://www.w3.org/2000/svg';
  const svgEl = (tag, attrs = {}, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
  const html = (tag, cls, parent, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; if (parent) parent.appendChild(e); return e; };
  const place = (e, x, y, w, h) => { e.style.left = x + 'px'; e.style.top = y + 'px'; if (w != null) e.style.width = w + 'px'; if (h != null) e.style.height = h + 'px'; return e; };
  const rad = d => (d - 90) * Math.PI / 180;
  const arc = (cx, cy, r, a0, a1) => { const p = a => [cx + r * Math.cos(rad(a)), cy + r * Math.sin(rad(a))].map(v => v.toFixed(2)); const [x0, y0] = p(a0), [x1, y1] = p(a1); return `M${x0},${y0} A${r},${r} 0 ${Math.abs(a1 - a0) > 180 ? 1 : 0} 1 ${x1},${y1}`; };
  const DW = 820, DH = 454;                      // design size of the board (the DDJ-SB top view, 1320 x 730 mm-ish scaled)
  let K = 1;                                     // current scale (design px -> screen px)
  const JX = [178, 640];                         // jog wheel centres (board x); y = 197

  /* ---------------------------------------------------------------- stage: board, three layers, scaling */
  const stage = html('div', 'stage'), board = html('div', 'board', stage);
  const [deckA, deckB] = [root.querySelector('.deck.a'), root.querySelector('.deck.b')], mixer = root.querySelector('.mixer');
  const deckEls = [deckA, deckB];
  stage.style.width = DW + 'px'; stage.style.height = DH + 'px';
  stage.append(deckA, deckB, mixer); root.appendChild(stage);
  place(board, 0, 0, DW, DH); for (const e of [deckA, deckB, mixer]) place(e, 0, 0, DW, DH);
  mixer.querySelector('h3').remove();
  for (const x of [314, 504]) { const s = html('div', 'sep', stage); s.style.left = x + 'px'; }
  const fit = () => { const W = root.clientWidth, H = root.clientHeight || DH; K = Math.max(0.3, Math.min(W / DW, H / DH)); stage.style.transform = `scale(${K})`; stage.style.left = Math.max(0, (W - DW * K) / 2) + 'px'; stage.style.top = Math.max(0, (H - DH * K) / 2) + 'px'; };
  new ResizeObserver(fit).observe(root); fit();

  /* ---------------------------------------------------------------- party lights on the top edge + LIGHTS button */
  const orbs = [304, 368, 432].map((x, i) => { const o = html('div', 'orb o' + i, stage); place(o, x - 12, 14, 24, 24); html('em', '', o); html('i', '', o); html('s', '', o); html('u', '', o); html('b', '', o); return o; });
  const HUE = [205, 318, 135];                                                    // blue, magenta, green: each light keeps its own colour
  const orbS = [0, 1, 2].map(() => ({ ang: Math.random() * 360, v: 0, b: 0 }));   // smoothed state per light: spin angle, spin speed, brightness
  const MODES = ['off', 'on', 'beat', 'music'], LABEL = { off: 'LIGHTS: OFF', on: 'LIGHTS: ON', beat: 'LIGHTS: BEAT', music: 'LIGHTS: MUSIC' };
  const lights = { mode: MODES.includes(lsGet('lightsMode', 'off')) ? lsGet('lightsMode', 'off') : 'off', last: [-1, -1, -1], lastSend: 0, level: 0, iv: [0, 0, 0] };
  const LIGHT_CC = [0x40, 0x42, 0x43];           // the controller's three party lights (CC on MIDI channel 1), as used by the Mixxx Party Mix mapping
  const btnLights = document.getElementById('btnLights');
  function sendLights(vals, force) {
    return;   // (the Party Mix party lights do not exist on the DDJ-SB)
    vals.forEach((v, i) => { const q = Math.max(0, Math.min(0x60, Math.round(v * 0x60))); if (force || lights.last[i] !== q) { lights.last[i] = q; try { midiOut.send([0xB0, LIGHT_CC[i], q]); } catch {} } });
  }
  function setLights(m) {
    lights.mode = m; lsSet('lightsMode', m);
    if (btnLights) { btnLights.textContent = LABEL[m]; btnLights.classList.toggle('on', m !== 'off'); }
    root.dataset.lights = m;
    sendLights(m === 'off' ? [0, 0, 0] : [0.7, 0.7, 0.7], true);          // switching off really switches the hardware lights off
  }
  if (btnLights) { btnLights.addEventListener('click', () => setLights(MODES[(MODES.indexOf(lights.mode) + 1) % MODES.length])); btnLights.textContent = LABEL[lights.mode]; btnLights.classList.toggle('on', lights.mode !== 'off'); }
  root.dataset.lights = lights.mode;

  /* ---------------------------------------------------------------- rotary knobs (bound to the existing range inputs) */
  const KNOB_TEXT = { gain: ['TRIM', '', ''], treble: ['HI', 'MIN', 'MAX'], mid: ['MID', 'MIN', 'MAX'], bass: ['LOW', 'MIN', 'MAX'], filter: ['FILTER', 'LPF', 'HPF'], master: ['MASTER LEVEL', '', ''], fx0: ['LEVEL', '', ''], fx1: ['LEVEL', '', ''], hpMix: ['HEADPHONES MIX', 'CUE', 'MASTER'], headMix: ['HEADPHONES LEVEL', 'MIN', 'MAX'], headGain: ['FILTER FADE', 'LP', 'HP'] };
  const knobs = [];
  function makeKnob(input) {
    const name = input.id, min = +input.min, max = +input.max, def = name.endsWith('.vol') ? 0 : (min + max) / 2, key = name.replace(/^d\d\./, '');
    const wrap = input.closest('.knob'); wrap.classList.add('kwrap'); input.classList.add('vh');
    const w = html('div', 'kn'); w.dataset.ctl = name; w.tabIndex = 0; w.setAttribute('role', 'slider'); w.title = 'Drag up/down, scroll, double-click to reset';
    const s = svgEl('svg', { viewBox: '0 0 64 64' }, w);
    for (let k = 0; k <= 10; k++) { const a = rad(-135 + 27 * k), r0 = 28, r1 = k % 5 === 0 ? 32 : 30.5; svgEl('line', { x1: 32 + r0 * Math.cos(a), y1: 32 + r0 * Math.sin(a), x2: 32 + r1 * Math.cos(a), y2: 32 + r1 * Math.sin(a), class: 'kn-tick' }, s); }
    const val = svgEl('path', { class: 'kn-val' }, s);
    svgEl('circle', { cx: 32, cy: 32, r: 23, class: 'kn-body' }, s);
    svgEl('circle', { cx: 32, cy: 32, r: 23, class: 'kn-ridge' }, s);
    const cap = svgEl('g', {}, s);
    svgEl('circle', { cx: 32, cy: 32, r: 17, class: 'kn-cap' }, cap);
    svgEl('rect', { x: 30.5, y: 13.5, width: 3, height: 12, rx: 1.5, class: 'kn-ind' }, cap);
    wrap.insertBefore(w, wrap.firstChild);
    const t = KNOB_TEXT[key]; if (t) { const sp = wrap.querySelector('span'); sp.textContent = t[0]; if (t[1]) { html('small', 'kl l', wrap, t[1]); html('small', 'kl r', wrap, t[2]); } }
    const draw = () => { const v = clamp((+input.value - min) / (max - min), 0, 1), a = -135 + 270 * v; cap.setAttribute('transform', `rotate(${a} 32 32)`); val.setAttribute('d', v <= 0.001 ? '' : arc(32, 32, 26.5, -135, a)); w.dataset.v = v.toFixed(3); w.setAttribute('aria-valuenow', String(Math.round(v * 100))); };
    const set = v01 => ctl[name].set(min + clamp(v01, 0, 1) * (max - min));
    const orig = ctl[name].set; ctl[name].set = v => { orig(v); draw(); };        // MIDI / app changes move the knob too
    input.addEventListener('input', draw);
    let drag = null;
    w.addEventListener('pointerdown', e => { try { w.setPointerCapture(e.pointerId); } catch {} drag = { y: e.clientY, v: (+input.value - min) / (max - min) }; e.preventDefault(); });
    w.addEventListener('pointermove', e => { if (drag) set(drag.v + (drag.y - e.clientY) / ((e.shiftKey ? 600 : 160) * K)); });
    w.addEventListener('pointerup', () => { drag = null; });
    w.addEventListener('wheel', e => { e.preventDefault(); set((+input.value - min) / (max - min) + (e.deltaY < 0 ? 0.04 : -0.04)); }, { passive: false });
    w.addEventListener('dblclick', () => ctl[name].set(def));
    w.addEventListener('keydown', e => { if (e.key === 'ArrowUp' || e.key === 'ArrowRight') set((+input.value - min) / (max - min) + 0.04); else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') set((+input.value - min) / (max - min) - 0.04); });
    draw(); knobs.push({ name, draw, wrap });
  }
  root.querySelectorAll('.knob input[type=range]').forEach(makeKnob);
  const knobWrap = id => document.getElementById(id).closest('.knob');

  /* ---------------------------------------------------------------- jog wheels with the HARMONIC MATCH hub */
  const jogs = [];
  function makeJog(d) {
    const D = deckEls[d.i], box = html('div', 'jogbox'); place(box, JX[d.i] - 120, 77, 240, 240);
    const s = svgEl('svg', { viewBox: '0 0 220 220', class: 'jog', role: 'img', 'aria-label': 'Jog wheel, Deck ' + (d.i + 1) }, box);
    const defs = svgEl('defs', {}, s), g = svgEl('linearGradient', { id: 'silver' + d.i, x1: 0, y1: 0, x2: 1, y2: 1 }, defs);
    [['0', '#f3f5f9'], ['.35', '#8e949f'], ['.55', '#e9ecf2'], ['1', '#6d727c']].forEach(([o, c]) => svgEl('stop', { offset: o, 'stop-color': c }, g));
    const rg = svgEl('radialGradient', { id: 'plat' + d.i, cx: .35, cy: .3, r: 1 }, defs); [['0', '#2a2c32'], ['.6', '#111214'], ['1', '#060607']].forEach(([o, c]) => svgEl('stop', { offset: o, 'stop-color': c }, rg));
    svgEl('circle', { cx: 110, cy: 110, r: 108, class: 'j-case' }, s);
    svgEl('circle', { cx: 110, cy: 110, r: 100, fill: `url(#silver${d.i})`, class: 'j-silver' }, s);
    svgEl('circle', { cx: 110, cy: 110, r: 91, class: 'j-gap' }, s);
    for (let k = 0; k < 72; k++) svgEl('line', { x1: 110, y1: 4, x2: 110, y2: 10, class: 'j-notch', transform: `rotate(${k * 5} 110 110)` }, s);
    const led = svgEl('path', { d: arc(110, 110, 104, 128, 232), class: 'j-led' }, s);               // red LEDs along the lower-left edge
    const C = 2 * Math.PI * 95;
    svgEl('circle', { cx: 110, cy: 110, r: 95, class: 'j-progbg' }, s);
    const prog = svgEl('circle', { cx: 110, cy: 110, r: 95, class: 'j-prog', 'stroke-dasharray': C.toFixed(1), 'stroke-dashoffset': C.toFixed(1), transform: 'rotate(-90 110 110)' }, s);
    const rot = svgEl('g', { class: 'j-rot' }, s);
    svgEl('circle', { cx: 110, cy: 110, r: 86, fill: `url(#plat${d.i})`, class: 'j-plat' }, rot);
    svgEl('line', { x1: 110, y1: 160, x2: 110, y2: 196, class: 'j-line' }, rot);                          // the line below the centre of the platter
    const hit = svgEl('circle', { cx: 110, cy: 110, r: 86, class: 'j-hit' }, s);
    const hub = svgEl('g', { class: 'hub', tabindex: 0, role: 'button', 'aria-label': 'Harmonic Match: find the next song for Deck ' + (d.i + 1) }, s);
    svgEl('title', {}, hub).textContent = 'HARMONIC MATCH: find the next song for Deck ' + (d.i + 1) + ' (opens the Harmonic Match tab)';
    svgEl('circle', { cx: 110, cy: 110, r: 46, class: 'h-bg' }, hub);
    for (let k = 0; k < 48; k++) svgEl('line', { x1: 110, y1: 66, x2: 110, y2: k % 4 === 0 ? 73 : 70, class: 'h-tick', transform: `rotate(${k * 7.5} 110 110)` }, hub);
    svgEl('circle', { cx: 110, cy: 110, r: 37, class: 'h-edge' }, hub);
    const t = (y, cls, txt) => { const e = svgEl('text', { x: 110, y, 'text-anchor': 'middle', class: cls }, hub); e.textContent = txt; return e; };
    t(104, 'h-t1', 'HARMONIC'); t(117, 'h-t2', 'MATCH'); const info = t(130, 'h-info', 'Deck ' + (d.i + 1));
    D.appendChild(box);

    let drag = null, acc = 0, offset = 0;
    const ang = (e, r) => Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI;
    hit.addEventListener('pointerdown', e => { try { hit.setPointerCapture(e.pointerId); } catch {} drag = { last: ang(e, s.getBoundingClientRect()) }; });
    hit.addEventListener('pointermove', e => {
      if (!drag) return; const a = ang(e, s.getBoundingClientRect()); let dd = a - drag.last; if (dd > 180) dd -= 360; if (dd < -180) dd += 360; drag.last = a;
      offset += dd; acc += dd / 5;
      while (Math.abs(acc) >= 1) { d.jog(Math.sign(acc)); acc -= Math.sign(acc); }
    });
    const end = () => { drag = null; acc = 0; };
    hit.addEventListener('pointerup', end); hit.addEventListener('pointercancel', end);
    hit.addEventListener('wheel', e => { e.preventDefault(); d.jog(e.deltaY < 0 ? 2 : -2); offset += e.deltaY < 0 ? 10 : -10; }, { passive: false });
    const open = () => window.harmonic && window.harmonic.openForDeck(d.i);
    hub.addEventListener('click', open);
    hub.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    jogs.push({ d, rot, prog, C, info, hub, led, angle: 0, get offset() { return offset; }, set offset(v) { offset = v; } });
  }
  decks.forEach(makeJog);

  /* ---------------------------------------------------------------- decks: lay the existing controls out like the hardware */
  const ICON_SCR = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.6"/><text x="12" y="15.4" text-anchor="middle" font-size="9.5" font-weight="900" fill="currentColor" font-family="Segoe UI,Arial">HM</text></svg>';
  const ICON_PFL = '<svg viewBox="0 0 24 24"><path d="M4 14v-2a8 8 0 0 1 16 0v2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="3" y="13" width="4.5" height="7" rx="1.6" fill="currentColor"/><rect x="16.5" y="13" width="4.5" height="7" rx="1.6" fill="currentColor"/></svg>';
  const MODE_ORDER = ['hot', 'loop', 'jump', 'roll'], MODE_NAME = { hot: 'CUE', loop: 'LOOP', jump: 'EFFECTS', roll: 'EFFECT 2' };
  const PADX = [[99, 154, 209, 263], [557, 611, 666, 720]], FXX = [[104, 155, 207], [561, 612, 663]], TX = [36, 783], deckUi = [];
  const ICON_CUE = '<svg viewBox="0 0 24 24"><path d="M4 14v-2a8 8 0 0 1 16 0v2" fill="none" stroke="currentColor" stroke-width="2"/><rect x="3" y="13" width="4.5" height="7" rx="1.6" fill="currentColor"/><rect x="16.5" y="13" width="4.5" height="7" rx="1.6" fill="currentColor"/></svg>';
  function layoutDeck(d) {
    const D = deckEls[d.i], left = d.i === 0, px = PADX[d.i], ui = deckUi[d.i] = {};
    // overview strip moves up under the big waveform
    const ov = D.querySelector('canvas.ov'), wave = document.querySelectorAll('#waves .wavebox')[d.i];
    if (ov && wave) { ov.classList.add('ovbar'); wave.appendChild(ov); }
    const row = D.querySelector('.row'), q = a => row.querySelector(`[data-act=${a}]`);
    const scr = q('scr'), pfl = q('pfl'), sync = q('sync'), cue = q('cue'), play = q('play');
    scr.style.display = 'none'; D.appendChild(scr);                               // (Harmonic Match opens from the jog wheel hub)
    // FX select buttons 1-3 (hold = effect on) under the FX1 / FX2 label
    const fxl = html('div', 'secl', D, left ? 'FX1' : 'FX2'); place(fxl, FXX[d.i][1] - 20, 26, 40, 10);
    const fxf = html('div', 'secframe', D); place(fxf, FXX[d.i][0] - 18, 30, FXX[d.i][2] - FXX[d.i][0] + 36, 38);
    FXX[d.i].forEach((x, n) => {
      const b = html('button', 'hw2 fxsel', D); b.title = 'FX ' + (n + 1) + ': hold to switch the effect on · right-click to choose the effect'; place(b, x - 16, 42, 32, 13);
      html('div', 'tiny', D, 'SELECT'); place(D.lastChild, x - 16, 57, 32, 7);
      const slot = 7 + 3 * d.i + n, on = v => { fxHold(d.i, slot, v); b.classList.toggle('lit', v); };
      b.addEventListener('contextmenu', e => { e.preventDefault(); fxMenu(slot, e.clientX, e.clientY); });
      (ui.fxl = ui.fxl || []).push({ slot, el: D.lastChild });
      b.addEventListener('pointerdown', e => { try { b.setPointerCapture(e.pointerId); } catch {} on(true); }); b.addEventListener('pointerup', () => on(false)); b.addEventListener('pointercancel', () => on(false));
    });
    // tempo slider on the outer edge
    const tl = html('div', 'secl', D, 'TEMPO'); place(tl, TX[d.i] - 20, 36, 40, 10);
    const pitch = D.querySelector('.pitch'); pitch.classList.add('tempo'); place(pitch, TX[d.i] - 23, 46, 46, 124);
    [...pitch.children].forEach(c => { if (c.classList.contains('dim') || c.tagName === 'BUTTON') c.remove(); });
    const marks = html('div', 'tmarks', pitch); marks.innerHTML = '<b>–</b><b>0</b><b>+</b>'; marks.classList.add(left ? 'l' : 'r');
    pitch.querySelector('input').addEventListener('dblclick', () => ctl[`d${d.i}.pitch`].set(0));
    pitch.querySelector('input').title = 'Tempo (double-click: 0%)';
    // KEY LOCK (not available in this software yet) and VINYL (scratch mode; SHIFT + VINYL = SLIP on the hardware)
    const kl = html('button', 'hw2', D); kl.title = 'KEY LOCK (master tempo): the tempo fader changes the speed, not the key · right-click: tempo range (6 / 8 / 10 / 16 / 25 %)'; place(kl, TX[d.i] - 16, 170, 32, 13);
    kl.addEventListener('click', () => d.setKeyLock(!d.keylock)); kl.addEventListener('contextmenu', e => { e.preventDefault(); d.cycleRange(); }); ui.key = kl;
    html('div', 'tiny', D, 'KEY LOCK'); place(D.lastChild, TX[d.i] - 20, 160, 40, 7);
    html('div', 'tiny', D, 'TEMPO RANGE'); place(D.lastChild, TX[d.i] - 20, 185, 40, 7); ui.range = D.lastChild;
    const vb = html('button', 'hw2', D); vb.title = 'VINYL: scratch mode for this deck (the jog wheel scratches while it is lit)'; place(vb, TX[d.i] - 16, 254, 32, 13);
    html('div', 'tiny', D, 'VINYL'); place(D.lastChild, TX[d.i] - 20, 244, 40, 7);
    html('div', 'tiny red', D, 'SLIP'); place(D.lastChild, TX[d.i] - 20, 269, 40, 7);
    vb.addEventListener('click', () => { d.scratch = !d.scratch; });
    ui.vinyl = vb;
    // pad mode buttons (the controller keeps the mode and tells us by the notes it sends; clicking one here changes the screen only)
    const modes = D.querySelector('.modes'); modes.classList.add('modebar'); place(modes, px[0] - 25, 325, px[3] - px[0] + 50, 16);
    const MN = { hot: 'HOT CUE', loop: 'AUTO LOOP', mloop: 'MANUAL LOOP', jump: 'SAMPLER' };
    [...modes.querySelectorAll('button')].forEach(b => { b.textContent = MN[b.dataset.mode]; });
    // the four performance pads, then the transport pads PLAY, CUE, SYNC, SHIFT
    const pads = D.querySelector('.pads'); pads.classList.add('padgrid', 'row4'); place(pads, px[0] - 23, 350, px[3] - px[0] + 46, 36);
    place(D.querySelector('.loopinfo'), px[0] - 23, 388, 150, 8);
    for (const [b, n, txt] of [[play, 0, ''], [cue, 1, 'CUE'], [sync, 2, 'SYNC']]) { b.classList.add('hwb'); place(b, px[n] - 23, 398, 46, 36); D.appendChild(b); if (txt) b.textContent = txt; }
    play.classList.add('play');
    const sh = html('button', 'hwb shiftb', D, 'SHIFT'); sh.title = 'SHIFT (the controller button; its other functions are reached with the hardware)'; place(sh, px[3] - 23, 398, 46, 36); ui.shift = sh;
    // CUE (headphone cue) button of this channel sits in the mixer: the existing button moves there
    const cx = left ? 350 : 468; pfl.classList.add('cuebtn'); pfl.innerHTML = 'CUE'; pfl.title = 'Headphone cue (PFL) for channel ' + (d.i + 1); place(pfl, cx - 18, 229, 36, 16); D.appendChild(pfl);
    row.remove();
  }
  decks.forEach(layoutDeck);

  /* ---------------------------------------------------------------- mixer: channels left/right, browse + LOAD 1/2, master / cue mix / cue gain, crossfader */
  const MX = 410;                                   // centre line of the mixer (board x)
  const at = (e, cx, cy, w = 56, h = 50) => place(e, cx - w / 2, cy - 19, w, h);
  const chs = [...mixer.querySelectorAll('.ch')];
  chs.forEach((ch, i) => {
    const cxn = i ? 468 : 350; ch.style.position = 'static';
    for (const [id, cy] of [['treble', 53], ['mid', 101], ['bass', 149], ['filter', 197]]) { const k = knobWrap(`d${i}.${id}`); mixer.appendChild(k); at(k, cxn, cy); }
    const gk = knobWrap(`d${i}.gain`); gk.style.display = 'none'; mixer.appendChild(gk);     // (no TRIM knob on the DDJ-SB)
    const f = ch.querySelector('.fader'); const fw = html('div', 'fwrap', mixer); place(fw, cxn - 17, 272, 34, 96); fw.appendChild(f);
    const meter = html('div', 'chmeter', mixer); meter.dataset.deck = i; meter.innerHTML = '<i></i><i></i>'; place(meter, i ? cxn - 32 : cxn + 24, 276, 8, 88);
    const lbl = html('div', 'chnum', mixer, String(i + 1)); place(lbl, cxn - 10, 258, 20, 14);
    html('div', 'tiny red', mixer, 'CH FADER START'); place(mixer.lastChild, cxn - 30, 372, 60, 7);
    ch.remove();
  });
  mixer.querySelector('.chs').remove();
  for (const [id, x] of [['fx0', 258], ['fx1', 712]]) { const k = knobWrap(id); mixer.appendChild(k); at(k, x, 50, 50); const l = html('div', 'tiny', mixer, 'BEATS'); place(l, x - 15, 74, 30, 7); }
  const cp = html('div', 'cpanel', mixer); place(cp, MX - 30, 124, 60, 146);
  for (const [id, cy] of [['master', 150], ['hpMix', 198], ['headMix', 246]]) { const k = knobWrap(id); mixer.appendChild(k); at(k, MX, cy, 60); }
  { const k = knobWrap('headGain'); mixer.appendChild(k); k.style.display = 'none'; }     // (the master DJ filter has no knob on the DDJ-SB: FILTER FADE is a button)
  // FILTER FADE: with the light on, the crossfader sweeps the channel filters (moving away from a deck closes its low-pass filter)
  const ff = { on: false, saved: [0.5, 0.5] };
  const ffApply = () => { if (!ff.on) return; const x = +ctl.xf.el.value; ctl['d0.filter'].set(0.5 - Math.max(0, x) / 2); ctl['d1.filter'].set(0.5 - Math.max(0, -x) / 2); };
  const ffb = html('button', 'ffade', mixer); ffb.innerHTML = '<b>ON</b>'; ffb.title = 'FILTER FADE: the crossfader sweeps the channel filters'; place(ffb, MX - 21, 350, 42, 28);
  html('div', 'tiny', mixer, 'FILTER FADE'); place(mixer.lastChild, MX - 30, 340, 60, 7);
  const ffSet = on => { if (on === ff.on) return; ff.on = on; ffb.classList.toggle('lit', on); if (on) { ff.saved = [+ctl['d0.filter'].el.value, +ctl['d1.filter'].el.value]; ffApply(); } else { ctl['d0.filter'].set(ff.saved[0]); ctl['d1.filter'].set(ff.saved[1]); } };
  ffb.addEventListener('click', () => ffSet(!ff.on));
  { const o = ctl.xf.set; ctl.xf.set = v => { o(v); ffApply(); }; document.getElementById('xf').addEventListener('input', ffApply); }
  window.filterFade = { get on() { return ff.on; }, set: ffSet };
  mixer.querySelector('.mrow').remove();
  // browse wheel at the top, LOAD 1 / LOAD 2 above it, BACK beneath
  const bk = html('div', 'bk', mixer); bk.id = 'browseKnob'; bk.tabIndex = 0; bk.setAttribute('role', 'slider'); bk.title = 'Browse: turn (drag or scroll) to move through the playlist, press to load into the free deck'; place(bk, MX - 22, 43, 44, 44);
  bk.innerHTML = '<svg viewBox="0 0 80 80"><circle class="bk-ring" cx="40" cy="40" r="37"/><circle class="bk-body" cx="40" cy="40" r="32"/><g id="bkRot"><circle class="bk-rib" cx="40" cy="40" r="28.5"/><circle class="bk-rib2" cx="40" cy="40" r="28.5"/><circle class="bk-cap" cx="40" cy="40" r="24"/></g><circle class="bk-shine" cx="40" cy="40" r="24"/></svg>';
  html('div', 'bklabel', mixer, 'BROWSE'); place(mixer.lastChild, MX - 30, 6, 60, 9);
  const lb = (id, txt, cx) => { const b = html('button', 'hw2 loadbtn', mixer, ''); b.id = id; b.setAttribute('aria-label', 'LOAD ' + txt); b.title = 'Load the selected track to deck ' + txt; place(b, cx - 18, 19, 36, 13); const l = html('div', 'tiny', mixer, 'LOAD ' + txt); place(l, cx - 20, 34, 40, 7); return b; };
  lb('cLoadA', '1', MX - 26); lb('cLoadB', '2', MX + 26);
  { const b = html('button', 'hw2 dis', mixer); b.title = 'BACK: not used'; place(b, MX - 16, 96, 32, 12); html('div', 'tiny', mixer, 'BACK'); place(mixer.lastChild, MX - 20, 88, 40, 7); html('div', 'tiny red', mixer, 'PANEL'); place(mixer.lastChild, MX - 20, 110, 40, 7); }
  const plate = html('div', 'plate', mixer, 'Pioneer DDJ-SB'); place(plate, MX - 50, 318, 100, 11); plate.style.display = 'none';
  // crossfader
  const xf = document.getElementById('xf');
  const xw = html('div', 'xwrap', mixer); place(xw, MX - 64, 402, 128, 32); xw.appendChild(xf); xf.classList.add('xfade'); html('div', 'xmid', xw);
  xf.addEventListener('dblclick', () => ctl.xf.set(0));
  [...mixer.children].forEach(e => { if (e.tagName === 'DIV' && !e.className && /CROSSFADER/.test(e.textContent)) e.remove(); });

  const cur = () => playlist[sel];
  document.getElementById('cLoadA').onclick = () => cur() ? loadToDeck(decks[0], cur()) : toast('The playlist is empty');
  document.getElementById('cLoadB').onclick = () => cur() ? loadToDeck(decks[1], cur()) : toast('The playlist is empty');
  let bkAngle = 0, bkDrag = null, bkAcc = 0;
  const bkStep = n => { moveSel(n); bkAngle += n * 14; document.getElementById('bkRot').setAttribute('transform', `rotate(${bkAngle} 40 40)`); };
  bk.addEventListener('pointerdown', e => { try { bk.setPointerCapture(e.pointerId); } catch {} bkDrag = { y: e.clientY, moved: false }; });
  bk.addEventListener('pointermove', e => { if (!bkDrag) return; bkAcc += (bkDrag.y - e.clientY) / K; bkDrag.y = e.clientY; if (Math.abs(bkAcc) > 2) bkDrag.moved = true; while (Math.abs(bkAcc) >= 8) { bkStep(bkAcc > 0 ? -1 : 1); bkAcc -= Math.sign(bkAcc) * 8; } });
  bk.addEventListener('pointerup', () => { const moved = bkDrag && bkDrag.moved; bkDrag = null; bkAcc = 0; if (!moved && cur()) loadToDeck(decks.find(x => !x.playing) || decks[0], cur()); });
  bk.addEventListener('wheel', e => { e.preventDefault(); bkStep(e.deltaY > 0 ? 1 : -1); }, { passive: false });
  bk.addEventListener('keydown', e => { if (e.key === 'ArrowDown') bkStep(1); else if (e.key === 'ArrowUp') bkStep(-1); else if (e.key === 'Enter' && cur()) loadToDeck(decks.find(x => !x.playing) || decks[0], cur()); });

  /* ---------------------------------------------------------------- animation: platters turn, LEDs, meters, party lights */
  let last = performance.now(), slow = 0, lastBeat = -1;
  const meterW = p => Math.round(clamp((20 * Math.log10(Math.max(p, 1e-5)) + 54) / 54, 0, 1) * 100);
  const playingBpm = () => { const d = decks.find(x => x.playing && x.an && x.an.bpm) || decks.find(x => x.an && x.an.bpm); return d ? d.an.bpm * d.rate : 120; };
  function loop(now) {
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    // party-light intensities (0..1) per light
    const st = nat.state, level = st ? Math.max(...st.master) : 0, m = lights.mode, t = now / 1000, bpm = playingBpm(), dk = decks.find(x => x.playing && x.an && x.an.bpm && Number.isFinite(x.an.grid));
    // the beat phase comes from the playing track itself (its beat grid and playhead), so the lights hit exactly on the beats of the music; without a grid they free-run at the track tempo
    let beat = t * bpm / 60; if (dk) beat = (dk.pos() - dk.an.grid) / (60 / dk.an.bpm); const bi = Math.floor(beat), ph = beat - bi;
    lights.level += (clamp(Math.sqrt(level) * 1.4, 0, 1) - lights.level) * 0.35;
    const iv = lights.iv;
    for (let i = 0; i < 3; i++) {
      // target brightness and spin speed per mode, then smoothed (fast attack, slow release) so the lights glide like the real ones
      const tgt = m === 'off' ? 0 : m === 'on' ? 0.6 + 0.3 * Math.sin(t * 1.1 + i * 2.1) : m === 'beat' ? Math.exp(-ph * 3.6) * (bi % 3 === i ? 1 : 0.55) + 0.12 : lights.level * (0.7 + 0.3 * Math.sin(t * 2.2 + i * 2.1)) + 0.08;
      const spd = m === 'off' ? 0 : (m === 'on' ? 70 : m === 'beat' ? 60 + 260 * Math.exp(-ph * 3) : 50 + 420 * lights.level) * (i === 1 ? -1 : 1) * (0.8 + 0.2 * i);
      const pp = m === 'off' ? 0 : dk ? Math.exp(-((ph + i * 0.07) % 1) * 4.2) * (((bi % 4) + 4) % 4 === 0 ? 1 : 0.8) : lights.level * 0.45;   // pulse: sharp on the beat, decays until the next one, strongest on the bar
      const s = orbS[i]; s.b += ((m === 'off' ? tgt : Math.min(1, tgt + 0.3 * pp)) - s.b) * (tgt > s.b ? 0.5 : 0.12); if (m === 'off' && s.b < 0.02) s.b = 0; s.v += (spd - s.v) * 0.08; s.ang = (s.ang + s.v * dt) % 360; iv[i] = s.b;
      const o = orbs[i]; o.style.setProperty('--b', s.b.toFixed(3)); o.style.setProperty('--p', pp.toFixed(3)); o.style.setProperty('--ang', s.ang.toFixed(1) + 'deg'); o.style.setProperty('--h', (HUE[i] + 22 * Math.sin(t * 0.45 + i * 2) + (m === 'off' ? 0 : 28 * Math.sin(t * 0.2 + i))).toFixed(0));
    }
    if (now - lights.lastSend > 90 && m !== 'off') { lights.lastSend = now; sendLights(iv); }
    if (!window.__djHidden) {
      for (const j of jogs) {
        const d = j.d;
        if (d.buf && d.playing) j.angle += 200 * d.effRate * dt;            // 33 1/3 rpm = 200 degrees per second
        j.angle += j.offset; j.offset = 0;
        j.rot.setAttribute('transform', `rotate(${(j.angle % 360).toFixed(2)} 110 110)`);
        j.prog.setAttribute('stroke-dashoffset', (j.C * (1 - (d.buf && d.dur ? clamp(d.pos() / d.dur, 0, 1) : 0))).toFixed(1));
        j.hub.classList.toggle('active', !!(window.harmonic && window.harmonic.hm.sourceMode === String(d.i)));
        j.led.style.opacity = (d.playing ? 0.55 : 0.18) + (m === 'off' ? 0 : 0.45 * iv[d.i]);   // the red edge LEDs glow with the music when the lights are on
      }
      deckUi.forEach((u, i) => { u.key.classList.toggle('lit', !!decks[i].keylock); const rt = '±' + decks[i].range + '%'; if (u.range.textContent !== rt) u.range.textContent = rt; u.vinyl.classList.toggle('lit', !!decks[i].scratch); u.shift.classList.toggle('lit', !!(window.ddjsb && window.ddjsb.shift[i])); });
      document.querySelectorAll('.chmeter').forEach(el => { const p = st && st.decks[+el.dataset.deck] ? st.decks[+el.dataset.deck].peak : [0, 0]; el.children[0].style.height = meterW(p[0]) + '%'; el.children[1].style.height = meterW(p[1]) + '%'; });
      if ((slow += dt) > 0.25) {
        slow = 0;
        deckUi.forEach(u => (u.fxl || []).forEach(x => { const t = (typeof FX_SHORT !== 'undefined' && typeof fxSlots !== 'undefined') ? FX_SHORT[fxSlots[x.slot]] : 'SELECT'; if (x.el.textContent !== t) x.el.textContent = t; }));
        for (const j of jogs) { const d = j.d, f = d.feat; j.info.textContent = !d.buf ? 'Deck ' + (d.i + 1) : (f && f.key ? f.key.camelot + (f.key.confidence < 0.35 ? '?' : '') + ' · ' : '') + (d.an && d.an.bpm ? (d.an.bpm * d.rate).toFixed(1) : '–'); }
        const it = cur(); bk.title = 'Browse: turn to move through the playlist, press to load into the free deck. Selected: ' + (it ? trackLabel(it) : '–');
      }
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
  window.addEventListener('beforeunload', () => { if (lights.mode !== 'off') sendLights([0, 0, 0], true); });   // leave the hardware lights off when the app closes
  document.querySelectorAll('.wavebox .tm').forEach(el => { el.style.cursor = 'pointer'; el.title = 'Click: switch between elapsed and remaining time'; el.addEventListener('click', () => { lsSet('timeRemaining', !lsGet('timeRemaining', false)); lastUi.forEach(u => { u.tm = null; }); }); });
  { const fk = document.querySelector('.kn[data-ctl="headGain"]'); if (fk) fk.title = 'FILTER (the CUE GAIN knob): centre = off, turn left = low-pass (cuts the highs), turn right = high-pass (cuts the lows). Works on the master, on any channel and volume.'; }
  window.consoleSkin = { jogs, knobs, bkStep, lights, setLights, stage, get scale() { return K; } };
})();
