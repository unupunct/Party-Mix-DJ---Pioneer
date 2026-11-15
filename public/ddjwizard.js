'use strict';
/* FIRST-RUN CALIBRATION WIZARD for the Pioneer DDJ-SB.
   A window drawn like the controller (same layout as the console on the main screen). It highlights one group of controls at a time, tells you what to do
   (move a fader to both ends, rest it in the notch, turn a knob, press a button...), records the movement with the same recorder as the Controller test (ddjtest.js),
   ticks the controls off and moves on. At the end the measured travel, centre notches and dead bands are stored as the calibration ('ddjCal', used by ddjsb.js).
   Starts by itself the first time the DDJ-SB is seen (after the driver is installed), and from the Calibrate button at any time.
   While it runs the controller does not drive the app (window.__ddjMute). */
(() => {
  const T = window.ddjTest; if (!T) return;
  const W = 820, H = 454, TX = [36, 783], JX = [178, 640], PX = [[99, 154, 209, 263], [557, 611, 666, 720]], FXX = [[104, 155, 207], [561, 612, 663]], CX = [350, 468];
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------------------------------------------------------------- the drawing: one element per control (or group of controls) */
  const E = [];
  const el = (ids, kind, x, y, w, h, label) => E.push({ ids: [].concat(ids), kind, x, y, w, h, label: label || '' });
  for (const d of [0, 1]) {
    el(`d${d}.tempo`, 'fader', TX[d], 100, 22, 96, 'PITCH'); el(`d${d}.jog`, 'jog', JX[d], 197, 236, 236, 'JOG');
    el(`d${d}.vol`, 'fader', CX[d], 316, 20, 92, '');
    [['hi', 53, 'HI'], ['mid', 101, 'MID'], ['low', 149, 'LOW'], ['filter', 197, 'FILTER']].forEach(([k, y, l]) => el(`d${d}.${k}`, 'knob', CX[d], y, 34, 34, l));
    el(`d${d}.pfl`, 'btn', CX[d], 237, 36, 16, 'CUE'); el(`d${d}.key`, 'btn', TX[d], 176, 32, 13, 'KEY LOCK'); el(`d${d}.vinyl`, 'btn', TX[d], 260, 32, 13, 'VINYL');
    FXX[d].forEach((x, n) => el(`fx${d}.b${n}`, 'btn', x, 48, 32, 13, String(n + 1))); el(`fx${d}.level`, 'knob', d ? 712 : 258, 52, 30, 30, 'LEVEL');
    for (let p = 0; p < 4; p++) el([`d${d}.hot${p}`, `d${d}.loop${p}`, `d${d}.mloop${p}`, `d${d}.samp${p}`], 'pad', PX[d][p], 368, 46, 36, String(p + 1));
    [['play', '▶/❚❚'], ['cue', 'CUE'], ['sync', 'SYNC'], ['shift', 'SHIFT']].forEach(([k, l], n) => el(`d${d}.${k}`, 'pad2', PX[d][n], 416, 46, 36, l));
  }
  el('xf', 'hfader', 410, 420, 104, 14, ''); el('hpmix', 'knob', 410, 198, 34, 34, 'HEADPHONES MIX'); el('master', 'knob', 410, 150, 34, 34, 'MASTER LEVEL'); el('hplevel', 'knob', 410, 246, 34, 34, 'HEADPHONES LEVEL');
  el(['browse', 'browsepush'], 'knob', 410, 65, 44, 44, 'BROWSE'); el('loadA', 'btn', 384, 26, 36, 13, 'LOAD 1'); el('loadB', 'btn', 436, 26, 36, 13, 'LOAD 2');
  const MODES = ['HOT CUE', 'AUTO LOOP', 'MANUAL LOOP', 'SAMPLER'];

  /* ---------------------------------------------------------------- the steps */
  const STEPS = [];
  const step = (title, hint, ids) => STEPS.push({ title, hint, ids });
  for (const d of [0, 1]) {
    const D = 'DECK ' + (d + 1) + ' (' + (d ? 'right' : 'left') + ')';
    step(D + ': PITCH fader', 'Push the pitch fader to the very TOP, then to the very BOTTOM, then leave it resting in the CENTRE notch for a second.', [`d${d}.tempo`]);
    step(D + ': CHANNEL fader', 'Move the channel fader (next to the CUE button) all the way up and all the way down.', [`d${d}.vol`]);
    step(D + ': HI, MID, LOW and FILTER', 'Turn each of the four knobs fully left and fully right.', [`d${d}.hi`, `d${d}.mid`, `d${d}.low`, `d${d}.filter`]);
    step(D + ': JOG wheel', 'Spin the jog wheel slowly clockwise and counter-clockwise (touch the top and the edge too).', [`d${d}.jog`]);
    step(D + ': buttons', 'Press each lit button once: PLAY, CUE, SYNC, SHIFT, the CUE button under the FILTER knob, VINYL and KEY LOCK.', [`d${d}.play`, `d${d}.cue`, `d${d}.sync`, `d${d}.shift`, `d${d}.pfl`, `d${d}.vinyl`, `d${d}.key`]);
    step(D + ': pads', 'Press the four pads in each mode: choose HOT CUE, AUTO LOOP, MANUAL LOOP and SAMPLER with the mode buttons above the pads, and press pads 1 to 4 in every mode.', [0, 1, 2, 3].flatMap(p => [`d${d}.hot${p}`, `d${d}.loop${p}`, `d${d}.mloop${p}`, `d${d}.samp${p}`]));
    step(D + ': FX', 'Press FX SELECT 1, 2 and 3 and turn the FX LEVEL knob fully both ways.', [`fx${d}.b0`, `fx${d}.b1`, `fx${d}.b2`, `fx${d}.level`]);
  }
  step('MIXER: crossfader', 'Move the crossfader all the way to the left and all the way to the right.', ['xf']);
  step('MIXER: HEADPHONES MIX', 'Turn the HEADPHONES MIX knob fully both ways.', ['hpmix']);
  step('BROWSE and LOAD', 'Turn the BROWSE knob both ways, push it, then press LOAD 1 and LOAD 2.', ['browse', 'browsepush', 'loadA', 'loadB']);

  /* ---------------------------------------------------------------- the window */
  let dlg = null, timer = 0, cur = 0, running = false, doneAt = 0, skipped = new Set(), stage = null, nodes = [];
  const status = id => { const c = T.C.find(x => x.id === id); return c ? T.analyse(c).st : 'none'; };
  const groupState = ids => { const s = ids.map(status); return s.every(x => x === 'ok') ? 'ok' : s.some(x => x === 'ok' || x === 'part') ? 'part' : 'none'; };
  function build() {
    stage.innerHTML = ''; nodes = [];
    const board = document.createElement('div'); board.className = 'wzboard'; stage.appendChild(board);
    const lab = (x, y, w, t, cls) => { const e = document.createElement('div'); e.className = 'wzlab ' + (cls || ''); e.textContent = t; e.style.cssText = `left:${x - w / 2}px;top:${y}px;width:${w}px`; board.appendChild(e); };
    for (const d of [0, 1]) { lab(d ? 710 : 110, 8, 90, 'DECK ' + (d + 1), 'big'); PX[d].forEach((x, i) => lab(x, 322, 52, MODES[i], 'tiny')); }
    lab(410, 4, 70, 'BROWSE', 'tiny'); lab(410, 340, 90, 'CH FADER START', 'tiny');
    for (const e of E) {
      const n = document.createElement('div'); n.className = 'wzc ' + e.kind; n.style.cssText = `left:${e.x - e.w / 2}px;top:${e.y - e.h / 2}px;width:${e.w}px;height:${e.h}px`;
      if (e.kind === 'jog') n.innerHTML = '<i class="jhub"></i>'; else if (e.kind === 'knob') n.innerHTML = '<i class="kind"></i>'; else if (e.kind === 'fader' || e.kind === 'hfader') n.innerHTML = '<i class="slot"></i><i class="thumb"></i>';
      const t = document.createElement('span'); t.textContent = e.label; n.appendChild(t);
      board.appendChild(n); nodes.push({ e, n });
    }
    fit();
  }
  function fit() { if (!stage) return; const b = stage.querySelector('.wzboard'); if (!b) return; const k = Math.min(stage.clientWidth / W, 1.6); b.style.transform = `scale(${k})`; stage.style.height = (H * k) + 'px'; }
  function tick() {
    const step = STEPS[cur], now = performance.now();
    for (const { e, n } of nodes) {
      const st = groupState(e.ids); n.dataset.st = st;
      n.classList.toggle('cur', !!step && !running === false && e.ids.some(i => step.ids.includes(i)));
      const live = e.ids.some(i => { const s = T.S[i]; return s && s.t0 && now - s.t0 < 250; }); n.classList.toggle('live', live);
      const first = T.S[e.ids[0]], c = T.C.find(x => x.id === e.ids[0]);
      if (c && c.kind === 'ax14' && first.last != null) {
        const p = first.last / 16383;
        if (e.kind === 'fader') n.querySelector('.thumb').style.top = (p * 100) + '%'; else if (e.kind === 'hfader') n.querySelector('.thumb').style.left = (p * 100) + '%';
        else if (e.kind === 'knob') n.querySelector('.kind').style.transform = `rotate(${-135 + 270 * p}deg)`;
      }
    }
    if (!step) return;
    const okAll = step.ids.every(i => status(i) === 'ok');
    dlg.querySelector('#wzTitle').textContent = step.title; dlg.querySelector('#wzHint').textContent = step.hint;
    dlg.querySelector('#wzProg').style.width = (cur / STEPS.length * 100) + '%'; dlg.querySelector('#wzNum').textContent = `Step ${cur + 1} of ${STEPS.length}`;
    const left = step.ids.filter(i => status(i) !== 'ok').length; dlg.querySelector('#wzLeft').textContent = okAll ? 'Done ✓' : left + ' of ' + step.ids.length + ' controls still to do';
    dlg.querySelector('#wzLeft').className = okAll ? 'ok' : '';
    if (okAll) { if (!doneAt) doneAt = now; else if (now - doneAt > 900) { doneAt = 0; next(); } } else doneAt = 0;
  }
  function next() { if (cur < STEPS.length - 1) { cur++; } else finish(); }
  function finish() {
    clearInterval(timer); running = false; window.__ddjMute = false; window.__midiTap = null;
    const cal = T.tuning(), n = Object.keys(cal).length; lsSet('ddjCal', cal); lsSet('ddjCalDone', true);
    const rows = STEPS.map(s => { const ok = s.ids.filter(i => status(i) === 'ok').length; return `<tr class="${ok === s.ids.length ? 'g' : 'y'}"><td>${ok === s.ids.length ? '✓' : '–'}</td><td>${esc(s.title)}</td><td>${ok} / ${s.ids.length}</td></tr>`; }).join('');
    const tuned = Object.entries(cal).map(([k, v]) => `${k}: travel ${v.min}–${v.max}${v.center !== undefined ? ', centre ' + v.center : ''}${v.db ? ', dead band ' + v.db : ''}`).join('<br>');
    dlg.querySelector('.wzbody').innerHTML = `<h2>Calibration finished</h2><p>The measured settings were applied to <b>${n}</b> faders and knobs: the real travel of each fader, the centre notch of the pitch faders and the crossfader, and a small dead band for noisy ones. You can run this again from the <b>Calibrate</b> button.</p><div class="wzres"><table>${rows}</table></div><p class="dim small">${tuned || 'No fader or knob was moved far enough to tune.'}</p><div class="wzbtns"><button class="pri" id="wzOk">Start DJing</button></div><p class="dim small">MASTER LEVEL and HEADPHONES LEVEL are analog knobs of the controller (they send no MIDI), so there is nothing to calibrate for them.</p>`;
    dlg.querySelector('#wzOk').onclick = close;
  }
  function close() { clearInterval(timer); running = false; window.__ddjMute = false; window.__midiTap = null; window.__ledHold = false; if (dlg && dlg.open) dlg.close(); window.removeEventListener('resize', fit); }
  function start() {
    if (running) return; running = true; cur = 0; doneAt = 0; skipped = new Set(); T.reset(); window.__ddjMute = true; window.__midiTap = T.onMsg;
    dlg = document.getElementById('ddjwiz') || document.body.appendChild(Object.assign(document.createElement('dialog'), { id: 'ddjwiz' }));
    dlg.innerHTML = `<div class="wzbox"><header><b>DDJ-SB CALIBRATION</b><span id="wzNum"></span><button id="wzX" title="Close without calibrating">✕</button></header>
      <div class="wzbody"><div class="wzbar"><i id="wzProg"></i></div><h2 id="wzTitle"></h2><p id="wzHint"></p><div id="wzLeft"></div><div id="wzStage" class="wzstage"></div>
      <div class="wzbtns"><button id="wzSkip">Skip this step</button><button id="wzFinish">Finish now</button></div></div></div>`;
    stage = dlg.querySelector('#wzStage'); build(); dlg.showModal(); fit(); window.addEventListener('resize', fit);
    dlg.querySelector('#wzX').onclick = () => { running = false; close(); toast('Calibration cancelled'); };
    dlg.querySelector('#wzSkip').onclick = () => { skipped.add(cur); doneAt = 0; next(); };
    dlg.querySelector('#wzFinish').onclick = finish;
    dlg.addEventListener('cancel', e => { e.preventDefault(); });
    timer = setInterval(tick, 120); tick();
  }
  function intro() {
    if (running || (dlg && dlg.open)) return;
    dlg = document.getElementById('ddjwiz') || document.body.appendChild(Object.assign(document.createElement('dialog'), { id: 'ddjwiz' }));
    dlg.innerHTML = `<div class="wzbox small"><header><b>DDJ-SB FOUND</b></header><div class="wzbody"><h2>Let's calibrate your controller</h2><p>The DDJ-SB is connected. This takes about two minutes: you will be asked to move every fader and knob to both ends and press every button and pad. The software measures the real travel, the centre notches and the noise of each control and tunes itself for best performance.</p><div class="wzbtns"><button class="pri" id="wzGo">Start calibration</button><button id="wzLater">Later</button><button id="wzNever">Don't ask again</button></div></div></div>`;
    dlg.showModal(); dlg.addEventListener('cancel', e => e.preventDefault());
    dlg.querySelector('#wzGo').onclick = () => { dlg.close(); start(); }; dlg.querySelector('#wzLater').onclick = () => dlg.close(); dlg.querySelector('#wzNever').onclick = () => { lsSet('ddjCalSkip', true); dlg.close(); };
  }
  let asked = false;
  function maybeFirstRun() { if (asked || lsGet('ddjCalDone', false) || lsGet('ddjCalSkip', false)) return; asked = true; setTimeout(intro, 1500); }
  const b = document.getElementById('btnCal'); if (b) { b.hidden = false; b.title = 'Calibrate the DDJ-SB: move every fader and knob, press every button; the software tunes itself'; b.onclick = start; b.addEventListener('click', e => e.stopImmediatePropagation(), true); b.addEventListener('click', start); }
  window.ddjWizard = { start, maybeFirstRun, STEPS, E };
  const iv = setInterval(() => { if (typeof midiNames !== 'undefined' && midiNames.length) { clearInterval(iv); maybeFirstRun(); } }, 1000);   // (the MIDI port may be found before this file has loaded)
})();
