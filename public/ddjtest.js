'use strict';
/* CONTROLLER TEST for the Pioneer DDJ-SB.
   Opens from the "Controller test" button. While it is open it records every message of every control (count, minimum, maximum, noise at rest, direction),
   shows a live bar per control, lets you play a tone on the master and on the headphones (to check the analog MASTER LEVEL / HEADPHONES LEVEL knobs by ear)
   and lights the controller's LEDs. "Apply tuning" turns what it measured into a calibration (real travel, centre notch of the tempo faders and the
   crossfader, a small dead band for noisy faders), stored in localStorage 'ddjCal' and used by ddjsb.js from then on. "Save report" writes a Markdown + JSON report. */
(() => {
  const btn = document.getElementById('btnHw'); if (!btn) return;
  btn.hidden = false; btn.textContent = 'Controller test'; btn.title = 'Test every knob, fader, button and pad of the DDJ-SB, record them and tune them';
  const hx = n => n.toString(16).toUpperCase().padStart(2, '0');
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------------------------------------------------------------- the controls */
  const C = [];   // { id, group, name, kind: 'ax14' | 'ax7' | 'btn' | 'enc' | 'analog', st (status byte), cc / note, center?: true }
  const ax14 = (id, group, name, st, cc, center) => C.push({ id, group, name, kind: 'ax14', st, cc, center });
  const btnN = (id, group, name, st, note) => C.push({ id, group, name, kind: 'btn', st, note });
  const enc = (id, group, name, st, cc, ccs) => C.push({ id, group, name, kind: 'enc', st, cc, ccs });
  for (const d of [0, 1]) {
    const D = 'Deck ' + (d + 1), s = 0xB0 + d, n = 0x90 + d, g = D;
    ax14(`d${d}.tempo`, g, D + ' pitch fader', s, 0x00, true); ax14(`d${d}.vol`, g, D + ' channel fader', s, 0x13);
    ax14(`d${d}.hi`, g, D + ' HI', s, 0x07); ax14(`d${d}.mid`, g, D + ' MID', s, 0x0B); ax14(`d${d}.low`, g, D + ' LOW', s, 0x0F);
    ax14(`d${d}.filter`, g, D + ' FILTER', 0xB6, 0x17 + d);
    enc(`d${d}.jog`, g, D + ' jog wheel', s, 0x22, [0x21, 0x22, 0x23, 0x1F, 0x26]);
    for (const [k, nm, no] of [['play', 'PLAY / PAUSE', 0x0B], ['cue', 'CUE', 0x0C], ['sync', 'SYNC', 0x58], ['shift', 'SHIFT', 0x3F], ['pfl', 'CUE (headphones)', 0x54], ['vinyl', 'VINYL', 0x17], ['key', 'KEY LOCK', 0x1A]]) btnN(`d${d}.${k}`, g, D + ' ' + nm, n, no);
    for (let p = 0; p < 4; p++) btnN(`d${d}.hot${p}`, g, D + ' pad ' + (p + 1) + ' (HOT CUE)', 0x97 + d, p);
    for (let p = 0; p < 4; p++) btnN(`d${d}.loop${p}`, g, D + ' pad ' + (p + 1) + ' (AUTO LOOP)', 0x97 + d, 0x10 + p);
    for (let p = 0; p < 4; p++) btnN(`d${d}.mloop${p}`, g, D + ' pad ' + (p + 1) + ' (MANUAL LOOP)', 0x97 + d, 0x20 + p);
    for (let p = 0; p < 4; p++) btnN(`d${d}.samp${p}`, g, D + ' pad ' + (p + 1) + ' (SAMPLER)', 0x97 + d, 0x30 + p);
    for (let b = 0; b < 3; b++) btnN(`fx${d}.b${b}`, 'FX' + (d + 1), 'FX' + (d + 1) + ' SELECT ' + (b + 1), 0x94 + d, 0x47 + b);
    ax14(`fx${d}.level`, 'FX' + (d + 1), 'FX' + (d + 1) + ' LEVEL', 0xB4 + d, 0x06);
  }
  ax14('xf', 'Mixer', 'Crossfader', 0xB6, 0x1F);   // (a crossfader has no centre notch)
  ax14('hpmix', 'Mixer', 'HEADPHONES MIX', 0xB6, 0x05);
  C.push({ id: 'master', group: 'Mixer', name: 'MASTER LEVEL (analog knob)', kind: 'analog', st: 0xB6, cc: 0x07 });
  C.push({ id: 'hplevel', group: 'Mixer', name: 'HEADPHONES LEVEL (analog knob)', kind: 'analog', st: 0xB6, cc: 0x09 });
  enc('browse', 'Browse', 'BROWSE knob (turn)', 0xB6, 0x40, [0x40, 0x64]); btnN('browsepush', 'Browse', 'BROWSE knob (push)', 0x96, 0x41);
  btnN('loadA', 'Browse', 'LOAD 1', 0x96, 0x46); btnN('loadB', 'Browse', 'LOAD 2', 0x96, 0x47);

  /* ---------------------------------------------------------------- recording */
  const S = {};   // id -> state
  const fresh = c => ({ n: 0, min: Infinity, max: -Infinity, last: null, on: 0, off: 0, up: 0, down: 0, holds: [], seg: null, msb: 0, t0: 0 });
  C.forEach(c => { S[c.id] = fresh(c); });
  /* the recording is kept in localStorage ('ddjTestState') while the window is open and restored the next time, so closing the window never loses a test */
  const persist = () => { try { const o = {}; for (const c of C) { const s = S[c.id]; if (s.n || s.touch) { const { seg, ...rest } = s; o[c.id] = { ...rest, min: s.min === Infinity ? null : s.min, max: s.max === -Infinity ? null : s.max, holds: s.holds.slice(-12) }; } } lsSet('ddjTestState', { t: Date.now(), S: o, unk }); } catch {} };
  const restore = () => { const st = lsGet('ddjTestState', null); if (!st || !st.S) return; for (const [id, v] of Object.entries(st.S)) if (S[id]) Object.assign(S[id], v, { min: v.min === null ? Infinity : v.min, max: v.max === null ? -Infinity : v.max, seg: null }); if (st.unk) Object.assign(unk, st.unk); };
  const find = (st, d1) => C.find(c => (c.kind === 'btn' ? (c.st === st && c.note === d1) : (c.st === st && (c.ccs ? c.ccs.includes(d1) : (c.cc === d1 || (c.kind === 'ax14' && c.cc + 0x20 === d1))))));
  const unk = {};   // messages that belong to no known control (BACK, FILTER FADE, shifted buttons...)
  restore();
  let open = false, lastMsg = '', lastName = '', lastT = 0;
  const typ0 = st => ((st & 0xF0) === 0x80 ? 0x90 | (st & 15) : st);
  function onMsg(d) {
    const st = d[0], d1 = d[1], d2 = d[2] || 0, now = performance.now(); if (st >= 0xF0) return;
    if (!(st === 0xB0 && d1 === 0x23)) { lastMsg = hx(st) + ' ' + hx(d1) + ' ' + hx(d2); const cc = find(typ0(st), d1); lastName = cc ? cc.name : 'not a known control'; lastT = now; }
    const typ = st & 0xF0, key = typ === 0x80 ? 0x90 | (st & 15) : st;
    if ((key & 0xF0) === 0x90 && (key & 15) < 2 && [0x35, 0x36, 0x67].includes(d1)) { const js = S['d' + (key & 15) + '.jog']; js.touch = (js.touch || 0) + (typ === 0x90 && d2 > 0 ? 1 : 0); js.t0 = now; lastName = 'Deck ' + ((key & 15) + 1) + ' jog wheel (touch sensor)'; return; }
    const c = find(key, d1); if (!c) { const k = hx(st) + ' ' + hx(d1); const u = unk[k] = unk[k] || { n: 0, min: 255, max: 0 }; u.n++; u.min = Math.min(u.min, d2); u.max = Math.max(u.max, d2); return; }
    const s = S[c.id];
    if (c.kind === 'btn') { s.n++; if (typ === 0x90 && d2 > 0) s.on++; else s.off++; s.last = d2; s.t0 = now; return; }
    if (c.kind === 'enc') { s.n++; const dir = d2 === 0x40 ? 0 : (c.id === 'browse' ? (d2 < 0x40 ? 1 : -1) : (d2 > 0x40 ? 1 : -1)); if (c.kind === 'enc' && d2 !== 0x40 && c.id !== 'browse') { /* a platter / ring tick is 0x3F or 0x41 etc */ } if (dir > 0) s.up++; else if (dir < 0) s.down++; s.last = d2; s.t0 = now; return; }
    if (c.kind === 'ax14') {
      if (d1 === c.cc) { s.msb = d2; return; }
      const v = (s.msb << 7) | d2; s.n++; s.last = v; s.t0 = now; s.min = Math.min(s.min, v); s.max = Math.max(s.max, v);
      if (v > (s.prev ?? v)) s.up++; else if (v < (s.prev ?? v)) s.down++; s.prev = v;
      // holds: a stretch of >= 600 ms where the value stays within 400 counts is a "rest"; its spread is the noise, its mean the rest position
      if (!s.seg || Math.abs(v - s.seg.lo) > 400 || Math.abs(v - s.seg.hi) > 400) { endSeg(s); s.seg = { t: now, lo: v, hi: v, sum: v, k: 1 }; }
      else { s.seg.lo = Math.min(s.seg.lo, v); s.seg.hi = Math.max(s.seg.hi, v); s.seg.sum += v; s.seg.k++; s.seg.te = now; }
      return;
    }
    s.n++; s.last = d2;   // analog: any message at all
  }
  function endSeg(s) { const g = s.seg; if (g && g.te && g.te - g.t >= 600 && g.k >= 3 && g.hi - g.lo <= 120) s.holds.push({ mean: g.sum / g.k, spread: g.hi - g.lo, ms: g.te - g.t }); s.seg = null; }
  // a rest is only ended when the next message arrives, so close open segments when asking for results
  const holdsOf = s => { const g = s.seg; return g && g.te && g.te - g.t >= 600 && g.k >= 3 && g.hi - g.lo <= 120 ? s.holds.concat([{ mean: g.sum / g.k, spread: g.hi - g.lo, ms: g.te - g.t }]) : s.holds; };   // finished rests plus the one in progress
  const flush = () => {};

  /* ---------------------------------------------------------------- analysis */
  const R14 = 16383;
  function analyse(c) {
    const s = S[c.id];
    if (c.kind === 'btn') return { st: s.on && s.off ? 'ok' : s.n ? 'part' : 'none', text: s.n ? `pressed ${s.on}, released ${s.off}` : 'not pressed yet' };
    if (c.kind === 'enc') return { st: s.up && s.down ? 'ok' : s.n ? 'part' : 'none', text: s.n ? `${s.up} clockwise, ${s.down} counter-clockwise ticks` + (s.touch ? ', touched ' + s.touch + 'x' : '') : (s.touch ? 'touched ' + s.touch + 'x: now turn it both ways' : 'not turned yet') };
    if (c.kind === 'analog') return { st: s.n ? 'info' : 'none', text: s.n ? `sends MIDI after all (${s.n} messages): mapped?` : 'no MIDI (this knob is analog: it changes the controller\'s own output level and cannot be read by software)' };
    if (!s.n) return { st: 'none', text: 'not moved yet' };
    const travel = (s.max - s.min) / R14; const hs = holdsOf(s), noise = Math.max(0, ...hs.map(h => h.spread));
    const centre = c.center ? hs.filter(h => Math.abs(h.mean - 8192) < 700).sort((a, b) => b.ms - a.ms)[0] : null;
    const ok = travel >= 0.9 && (!c.center || centre);
    return { st: ok ? 'ok' : 'part', travel, noise, centre, text: `${(travel * 100).toFixed(0)} % travel (${s.min}-${s.max})` + (noise ? `, noise at rest ${noise}` : '') + (c.center ? (centre ? `, centre rests at ${Math.round(centre.mean)}` : ', centre notch not seen yet (leave it in the notch for a second)') : '') };
  }
  function tuning() {
    flush(); const cal = {};
    for (const c of C) {
      if (c.kind !== 'ax14') continue; const s = S[c.id], a = analyse(c); if (!s.n || a.travel < 0.5) continue;
      const key = `${c.st.toString(16)}:${c.cc.toString(16)}`, e = { min: s.min, max: s.max };
      if (a.noise >= 6) e.db = Math.min(60, Math.ceil(a.noise * 1.3));   // a dead band of at most 60 counts (0.4 %) so a noisy fader cannot shake the sound
      if (c.center && a.centre) { e.center = Math.round(a.centre.mean); e.snap = Math.min(300, Math.max(80, Math.ceil((a.noise || 0) * 2))); }
      cal[key] = e;
    }
    return cal;
  }

  /* ---------------------------------------------------------------- dialog */
  let dlg = null, timer = 0, tone = { m: 0, c: 0 };
  const bar = (c, s) => {
    if (c.kind === 'ax14' && s.last != null) return `<i style="width:${(s.last / R14 * 100).toFixed(1)}%"></i>`;
    if ((c.kind === 'btn') && s.last != null) return `<i style="width:${s.last > 0 && performance.now() - s.t0 < 400 ? 100 : 0}%;background:#37d67a"></i>`;
    if (c.kind === 'enc' && s.last != null) return `<i style="width:${performance.now() - s.t0 < 250 ? 100 : 0}%;background:#ffa226"></i>`;
    return '';
  };
  const BADGE = { ok: '<b class="g">OK</b>', part: '<b class="y">partly</b>', none: '<b class="n">–</b>', info: '<b class="y">info</b>' };
  function render() {
    if (!dlg) return; flush();
    let html = '', grp = '', done = 0;
    for (const c of C) { const a = analyse(c), s = S[c.id]; if (a.st === 'ok') done++; if (c.group !== grp) { grp = c.group; html += `<tr class="gh"><td colspan="4">${esc(grp)}</td></tr>`; }
      html += `<tr class="${a.st}"><td>${BADGE[a.st]}</td><td>${esc(c.name)}</td><td class="bar">${bar(c, s)}</td><td class="tx">${esc(a.text)}</td></tr>`; }
    const uk = Object.entries(unk).sort(); if (uk.length) html += '<tr class="gh"><td colspan="4">Other messages (not a known control)</td></tr>' + uk.map(([k, v]) => '<tr><td><b class="y">?</b></td><td><code>' + k + '</code></td><td></td><td class="tx">' + v.n + ' messages, values ' + v.min + '-' + v.max + '</td></tr>').join('');
    dlg.querySelector('#dtBody').innerHTML = html; dlg.querySelector('#dtLast').innerHTML = lastMsg ? '<b>' + esc(lastName) + '</b> &nbsp; <code>' + lastMsg + '</code>' + (performance.now() - lastT < 600 ? ' ●' : '') : 'Turn or press a control: its name appears here'; dlg.querySelector('#dtCount').textContent = `${done} / ${C.filter(c => c.kind !== 'analog').length} controls tested OK`;
  }
  function stop() { if (open) { persist(); autoReport(); } open = false; clearInterval(timer); clearInterval(tone.t); window.__midiTap = null; window.__ledHold = false; if (dlg) dlg.close(); }
  function leds(on) { if (typeof midiOut === 'undefined' || !midiOut) return toast('No DDJ-SB MIDI output'); window.__ledHold = true;
    for (const d of [0, 1]) { for (const n of [0x0B, 0x47, 0x0C, 0x48, 0x54, 0x68, 0x58, 0x17, 0x1A]) midiOut.send([0x90 + d, n, on ? 0x7F : 0]); for (const p of [0x00, 0x08, 0x10, 0x18, 0x20, 0x30, 0x38, 0x40, 0x48, 0x50, 0x58]) for (let i = 0; i < 4; i++) midiOut.send([0x97 + d, p + i, on ? 0x7F : 0]); for (let b = 0; b < 3; b++) { midiOut.send([0x94 + d, 0x47 + b, on ? 0x7F : 0]); midiOut.send([0x94 + d, 0x63 + b, on ? 0x7F : 0]); } }
    if (!on) window.__ledHold = false; }
  async function autoReport() { try { const rows = C.map(c => { const a = analyse(c); return `| ${a.st} | ${c.name} | ${a.text} |`; }); await window.electronAPI.hwSaveReport('ddjsb-test-auto', ['# DDJ-SB controller test (saved when the window was closed)', '', '| Status | Control | Result |', '|---|---|---|', ...rows, '', 'Messages that belong to no known control: ' + JSON.stringify(unk)].join('\n'), JSON.stringify({ unk, tuning: tuning() }), true); } catch {} }
  async function save() {
    flush(); const rows = C.map(c => { const a = analyse(c), s = S[c.id]; return { id: c.id, name: c.name, status: a.st, text: a.text, n: s.n, min: s.min === Infinity ? null : s.min, max: s.max === -Infinity ? null : s.max }; });
    const cal = tuning(), md = ['# DDJ-SB controller test', 'Generated ' + new Date().toISOString(), '', '| Status | Control | Result |', '|---|---|---|', ...rows.map(r => `| ${r.status} | ${r.name} | ${r.text} |`), '', '## Tuning', '```json', JSON.stringify(cal, null, 1), '```'].join('\n');
    try { const r = await window.electronAPI.hwSaveReport('ddjsb-test', md, JSON.stringify({ rows, cal }, null, 1)); toast('Report saved: ' + r, 7000); } catch (e) { toast('Could not save the report: ' + e.message); }
  }
  function show() {
    if (open) return; open = true;
    dlg = document.getElementById('ddjtest') || document.body.appendChild(Object.assign(document.createElement('dialog'), { id: 'ddjtest' }));
    dlg.innerHTML = `<div class="dtbox"><header><b>CONTROLLER TEST</b><span>Pioneer DDJ-SB: move every knob and fader to both ends, press every button and pad. <span id="dtCount"></span></span><button id="dtClose">Close</button></header>
      <div class="dtbar"><button id="dtTM">Tone on master: off</button><button id="dtTC">Tone on headphones: off</button><button id="dtLon">Light all LEDs</button><button id="dtLoff">LEDs off</button><button id="dtReset">Reset test</button><button id="dtApply" class="pri">Apply tuning</button><button id="dtClear">Clear tuning</button><button id="dtSave">Save report</button></div>
      <div id="dtLast" class="dtlast"></div><p class="dim small">The tones let you check the analog MASTER LEVEL and HEADPHONES LEVEL knobs by ear: turn them while a tone plays. Faders: sweep from end to end, then leave the pitch faders and the crossfader in their centre notch for a second.</p>
      <div class="dtwrap"><table class="dt"><tbody id="dtBody"></tbody></table></div></div>`;
    window.__midiTap = onMsg; dlg.showModal();
    const q = id => dlg.querySelector('#' + id);
    q('dtClose').onclick = stop; dlg.addEventListener('close', () => { if (open) stop(); }, { once: true });
    const tg = (k, label, id, target) => { q(id).onclick = () => { tone[k] = tone[k] ? 0 : 1; q(id).textContent = label + (tone[k] ? 'on' : 'off'); q(id).classList.toggle('pri', !!tone[k]); }; };
    tg('m', 'Tone on master: ', 'dtTM'); tg('c', 'Tone on headphones: ', 'dtTC');
    tone.t = setInterval(() => { if (tone.m) engSend({ cmd: 'beep', target: 'master' }); if (tone.c) engSend({ cmd: 'beep', target: 'cue' }); }, 1500);
    q('dtLon').onclick = () => leds(true); q('dtLoff').onclick = () => leds(false);
    q('dtReset').onclick = () => { C.forEach(c => { S[c.id] = fresh(c); }); for (const k of Object.keys(unk)) delete unk[k]; lsSet('ddjTestState', null); render(); };
    q('dtApply').onclick = () => { const cal = tuning(), n = Object.keys(cal).length; lsSet('ddjCal', cal); toast(n ? `Tuning applied to ${n} controls (travel, centre notch, dead band)` : 'Nothing to tune yet: move the faders and knobs end to end first', 6000); };
    q('dtClear').onclick = () => { lsSet('ddjCal', {}); toast('Tuning cleared'); };
    q('dtSave').onclick = save;
    timer = setInterval(() => { render(); persist(); }, 1000); render();
  }
  btn.addEventListener('click', show);
  window.ddjTest = { C, S, unk, analyse, tuning, show, stop, onMsg, reset: () => { C.forEach(c => { S[c.id] = fresh(c); }); for (const k of Object.keys(unk)) delete unk[k]; } };
})();
