'use strict';
/* XY MULTI-FX PAD: UI + controller wiring. The maths (coordinates, neutral zone, bilinear blend, parameter mapping, state machine) lives in xyfx.js; the sound is made by the engine
   (engine/src/xyfx.rs: Filter / Echo / Reverb / Flanger on the master bus) or, in the Web Audio fallback, by the node chain built here. This file only draws, listens to the pointer and sends
   control messages {cmd:'xy', act, w:[4], p:[8]}. Globals from app.js: nat, engSend, decks, AC, mix, lsGet, lsSet, toast. */
(() => {
  if (!window.sideHost || !window.XYFX) return;
  const X = window.XYFX, $ = (s, el) => (el || document).querySelector(s);
  const KEY = 'xyfx', KEYP = 'xyfxPresets';
  let cfg = X.sanitize((() => { const s = lsGet(KEY, {}); if (s && typeof s === 'object' && (s.v || 1) < 2) { delete s.ranges; delete s.neutral; delete s.activation; delete s.sharpness; s.v = 2; lsSet(KEY, s); } return s; })()), presets = lsGet(KEYP, {}); if (!presets || typeof presets !== 'object') presets = {};
  const el = document.createElement('section'); el.id = 'xypanel';
  el.innerHTML = `<header><b>XY MULTI-FX</b><span class="xystate" id="xyState">IDLE</span><button id="xyCfgBtn" title="Settings: assignments, radii, ranges, presets">⚙</button></header>
    <div class="xywrap"><canvas id="xyCanvas" title="Press and move: Filter / Echo / Reverb / Flanger. Release = clean sound."></canvas></div>
    <div class="xyread"><div class="xyxy"><span>X <b id="xyX">0.50</b></span><span>Y <b id="xyY">0.50</b></span><span>ACT <b id="xyA">0%</b></span></div><div class="xybars" id="xyBars"></div></div>
    <div class="xycfg" id="xyCfg" hidden></div>`;
  window.sideHost.add('right', el);
  const cv = $('#xyCanvas', el), g = cv.getContext('2d'), bars = $('#xyBars', el);
  const bpmNow = () => { const d = decks.find(x => x.playing && x.an && x.an.bpm) || decks.find(x => x.an && x.an.bpm); return d ? d.an.bpm * d.rate : 0; };

  /* ---------------------------------------------------------------- audio path: engine message, or the Web Audio fallback */
  let pend = null, tLast = 0, timer = 0;
  const post = m => { const msg = { cmd: 'xy', act: m.act, w: m.w, p: m.p, ft: m.ft || 0, var: m.var || [m.ft || 0, 0, 0, 0] }; if (nat.active) engSend(msg); else fb.apply(msg); };
  let fresh = true;   // the first message of a press always goes out at once (the 8 ms merge only applies to the continuous movement after it)
  function send(m) {   // a release is never delayed and cancels everything still waiting
    if (m.act === 0 && m.w.every(v => v === 0)) { clearTimeout(timer); timer = 0; pend = null; post(m); tLast = performance.now(); fresh = true; return; }
    const now = performance.now(); pend = m;
    if (fresh || now - tLast >= 8) { fresh = false; clearTimeout(timer); timer = 0; tLast = now; post(m); pend = null; } else if (!timer) timer = setTimeout(() => { timer = 0; if (pend) { tLast = performance.now(); post(pend); pend = null; } }, 8 - (now - tLast));
  }
  /* Web Audio fallback (no native engine): the same blend with nodes. dry = (1-act); each path = w_i * act; paths read the master after the pre-limiter lowpass. */
  const fb = (() => {
    let built = null;
    function build() {
      const A = AC, inp = mix.lp, out = mix.lim, N = (n, t = 0.01) => ({ n, t });
      const dry = A.createGain(); inp.connect(dry); dry.connect(out);
      const mk = () => { const o = A.createGain(); o.gain.value = 0; o.connect(out); return o; };
      // filter
      const f = A.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 18000; f.Q.value = 0.7; const fo = mk(); inp.connect(f); f.connect(fo);
      // echo
      const ed = A.createDelay(2); ed.delayTime.value = 0.25; const efb = A.createGain(); efb.gain.value = 0; const elp = A.createBiquadFilter(); elp.type = 'lowpass'; elp.frequency.value = 5000;
      const eo = mk(), edry = A.createGain(), ewet = A.createGain(); edry.gain.value = 0.75; ewet.gain.value = 0.7; inp.connect(ed); ed.connect(elp); elp.connect(efb); efb.connect(ed); inp.connect(edry); edry.connect(eo); ed.connect(ewet); ewet.connect(eo);
      // reverb: decaying noise impulse (room size = length), wet level
      const cvl = A.createConvolver(), rdry = A.createGain(), rwet = A.createGain(), ro = mk(); let room = -1; rwet.gain.value = 0; rdry.gain.value = 1;
      const setRoom = r => { if (Math.abs(r - room) < 0.08) return; room = r; const len = Math.floor(A.sampleRate * (0.4 + 2.4 * r)), b = A.createBuffer(2, len, A.sampleRate); for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.2 + (1 - r) * 2); } cvl.buffer = b; };
      setRoom(0.5); inp.connect(rdry); rdry.connect(ro); inp.connect(cvl); cvl.connect(rwet); rwet.connect(ro);
      // flanger
      const fd = A.createDelay(0.05), lfo = A.createOscillator(), lg = A.createGain(), ffb = A.createGain(), fdry = A.createGain(), fwet = A.createGain(), flo = mk(); fd.delayTime.value = 0.003; lfo.frequency.value = 0.5; lg.gain.value = 0.002; ffb.gain.value = 0.45; fdry.gain.value = 0.7; fwet.gain.value = 0.5;
      lfo.connect(lg); lg.connect(fd.delayTime); lfo.start(); inp.connect(fd); fd.connect(ffb); ffb.connect(fd); inp.connect(fdry); fdry.connect(flo); fd.connect(fwet); fwet.connect(flo);
      return { dry, fo: fo, eo, ro, flo, f, ed, efb, rdry, rwet, setRoom, lfo, lg, fwet };
    }
    function apply(m) {
      if (!built) { if (m.act <= 0) return; built = build(); }
      const t = AC.currentTime, S = (p, v, c = 0.012) => p.setTargetAtTime(v, t, c), b = built, a = m.act, sum = m.w.reduce((x, y) => x + y, 0) || 1, P = m.p;
      if (a <= 0) { for (const k of ['fo', 'eo', 'ro', 'flo']) { b[k].gain.cancelScheduledValues(t); b[k].gain.setTargetAtTime(0, t, 0.0012); } b.dry.gain.cancelScheduledValues(t); b.dry.gain.setTargetAtTime(1, t, 0.0012); b.efb.gain.setTargetAtTime(0, t, 0.0012); return; }   // ~4 ms to dry; the echo loop is cut
      S(b.dry.gain, 1 - a); ['fo', 'eo', 'ro', 'flo'].forEach((k, i) => S(b[k].gain, a * m.w[i] / sum));
      const bt = ['lowpass', 'highpass', 'bandpass', 'notch', 'notch', 'bandpass', 'peaking'][(m.var && m.var[0]) || m.ft || 0]; if (bt === 'peaking') b.f.gain.value = 10; if (b.f.type !== bt) b.f.type = bt; S(b.f.frequency, P[0]); S(b.f.Q, 0.7 + P[1] * 12); S(b.ed.delayTime, Math.min(1.9, P[2]), 0.08); S(b.efb.gain, Math.min(0.85, P[3]) * 0.9);
      b.setRoom(P[4]); S(b.rwet.gain, P[5] * 1.2); S(b.rdry.gain, 1 - P[5] * 0.75);
      S(b.lfo.frequency, P[6]); S(b.lg.gain, 0.0005 + P[7] * 0.004); S(b.fwet.gain, 0.3 + 0.4 * P[7]);
    }
    return { apply };
  })();

  /* ---------------------------------------------------------------- controller */
  const pad = new X.Pad(cfg, send, { getBpm: bpmNow, onState: m => { cur = m; dirty = true; } });
  let cur = null, dirty = true, vis = { x: 0.5, y: 0.5 }, size = 0;
  const cssPos = ev => X.normalize(ev.clientX, ev.clientY, cv.getBoundingClientRect());
  cv.style.touchAction = 'none';
  cv.addEventListener('pointerdown', e => { if (e.button > 0 && e.pointerType === 'mouse') return; e.preventDefault(); try { cv.setPointerCapture(e.pointerId); } catch {} const p = cssPos(e); if (!pad.down(e.pointerId, p.x, p.y)) return; ui(); });
  cv.addEventListener('pointermove', e => { if (pad.state !== 'active') return; e.preventDefault(); const p = cssPos(e); pad.move(e.pointerId, p.x, p.y); });
  const rel = e => { if (pad.up(e.pointerId)) ui(); };
  cv.addEventListener('pointerup', rel); cv.addEventListener('pointercancel', rel); cv.addEventListener('lostpointercapture', rel);
  window.addEventListener('pointerup', rel); window.addEventListener('pointercancel', rel);   // safety net: release even if capture is not supported
  window.addEventListener('blur', () => { if (pad.up()) ui(); }); document.addEventListener('visibilitychange', () => { if (document.hidden && pad.up()) ui(); });
  cv.addEventListener('contextmenu', e => e.preventDefault());

  /* ---------------------------------------------------------------- drawing: only while something changes */
  const COL = X.COLORS, hex = (c, a) => c + Math.round(a * 255).toString(16).padStart(2, '0');
  function resize() {
    const w = el.clientWidth, h = el.clientHeight, wide = w >= 460, d = Math.min(2, window.devicePixelRatio || 1);
    el.classList.toggle('wide', wide);
    let s; if (wide) s = Math.floor(Math.min(h - ($('header', el).offsetHeight + 14), w * 0.58)); else { const r = cv.parentElement.getBoundingClientRect(); s = Math.floor(Math.min(r.width, r.height)); }
    s = Math.max(120, s); el.style.setProperty('--xys', s + 'px'); size = s; cv.style.width = cv.style.height = s + 'px'; cv.width = cv.height = Math.round(s * d); g.setTransform(d, 0, 0, d, 0, 0); dirty = true;
  }
  function draw() {
    const s = size, c = cfg, zones = c.assign, pos = cur ? { x: cur.x, y: cur.y } : { x: 0.5, y: 0.5 };
    vis.x += (pos.x - vis.x) * (cur ? 0.6 : 0.35); vis.y += (pos.y - vis.y) * (cur ? 0.6 : 0.35);
    const moving = Math.abs(vis.x - pos.x) + Math.abs(vis.y - pos.y) > 0.002; if (!moving) { vis.x = pos.x; vis.y = pos.y; }
    g.clearRect(0, 0, s, s); const R = Math.min(14, s * 0.04);
    g.save(); g.beginPath(); g.roundRect(0, 0, s, s, R); g.clip(); g.fillStyle = '#07080b'; g.fillRect(0, 0, s, s);
    const corner = [[0, 0], [s, 0], [0, s], [s, s]];
    zones.forEach((e, z) => { const col = COL[e], gr = g.createRadialGradient(corner[z][0], corner[z][1], 0, corner[z][0], corner[z][1], s * 0.78); const k = cur ? 0.18 + 0.5 * (cur.effects[X.EFFECTS.indexOf(e)] || 0) : 0.2; gr.addColorStop(0, hex(col, Math.min(0.8, k + 0.25))); gr.addColorStop(0.55, hex(col, k * 0.4)); gr.addColorStop(1, hex(col, 0)); g.fillStyle = gr; g.fillRect(0, 0, s, s); });
    g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1; for (let i = 1; i < 8; i++) { g.beginPath(); g.moveTo(i * s / 8, 0); g.lineTo(i * s / 8, s); g.moveTo(0, i * s / 8); g.lineTo(s, i * s / 8); g.stroke(); }
    g.strokeStyle = 'rgba(255,255,255,.22)'; g.beginPath(); g.moveTo(s / 2, 0); g.lineTo(s / 2, s); g.moveTo(0, s / 2); g.lineTo(s, s / 2); g.stroke();
    g.setLineDash([4, 4]); g.strokeStyle = 'rgba(255,255,255,.28)'; g.beginPath(); g.arc(s / 2, s / 2, c.neutral * s, 0, Math.PI * 2); g.stroke(); g.strokeStyle = 'rgba(255,255,255,.12)'; g.beginPath(); g.arc(s / 2, s / 2, c.activation * s, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
    const ng = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, c.neutral * s); ng.addColorStop(0, 'rgba(255,255,255,.10)'); ng.addColorStop(1, 'rgba(255,255,255,.02)'); g.fillStyle = ng; g.beginPath(); g.arc(s / 2, s / 2, c.neutral * s, 0, Math.PI * 2); g.fill();
    g.font = `800 ${Math.max(10, s * 0.045)}px Segoe UI, sans-serif`; g.textBaseline = 'top';
    zones.forEach((e, z) => { const on = cur && (cur.effects[X.EFFECTS.indexOf(e)] || 0) > 0.03; g.fillStyle = on ? '#fff' : hex(COL[e], 0.85); g.textAlign = z % 2 ? 'right' : 'left'; g.textBaseline = z < 2 ? 'top' : 'bottom'; g.fillText((X.VARIANT_LABEL[X.variantOf(c, e)] || X.NAMES[e]).toUpperCase(), z % 2 ? s - 10 : 10, z < 2 ? 9 : s - 9); });
    const px = vis.x * s, py = vis.y * s, act = cur ? cur.act : 0, col = cur ? COL[zones[cur.zw.indexOf(Math.max(...cur.zw))]] : '#9aa0b0';
    if (cur) { g.strokeStyle = hex(col, 0.35); g.lineWidth = 1; g.beginPath(); g.moveTo(s / 2, s / 2); g.lineTo(px, py); g.stroke(); }
    g.save(); g.shadowColor = cur ? col : '#fff'; g.shadowBlur = cur ? 10 + act * 26 : 6; g.fillStyle = cur ? '#fff' : 'rgba(255,255,255,.55)'; g.beginPath(); g.arc(px, py, cur ? 9 + act * 5 : 6, 0, Math.PI * 2); g.fill(); g.restore();
    g.strokeStyle = cur ? col : 'rgba(255,255,255,.4)'; g.lineWidth = 2; g.beginPath(); g.arc(px, py, cur ? 15 + act * 8 : 10, 0, Math.PI * 2); g.stroke();
    g.restore(); g.strokeStyle = cur ? 'rgba(255,255,255,.4)' : '#2a2d35'; g.lineWidth = 2; g.beginPath(); g.roundRect(1, 1, s - 2, s - 2, R); g.stroke();
    return moving;
  }
  const fmt = {
    filter: p => `${X.FILTER_SHORT[cfg.filterType]} ${p[0] >= 1000 ? (p[0] / 1000).toFixed(1) + ' kHz' : Math.round(p[0]) + ' Hz'} · Q ${Math.round(p[1] * 100)}%`,
    echo: p => `${Math.round(p[0] * 1000)} ms · FB ${Math.round(p[1] * 100)}%`, reverb: p => `room ${Math.round(p[0] * 100)}% · wet ${Math.round(p[1] * 100)}%`, flanger: p => `${p[0].toFixed(2)} Hz · depth ${Math.round(p[1] * 100)}%`,
  };
  function readouts() {
    const m = cur; $('#xyX', el).textContent = m ? m.x.toFixed(2) : '0.50'; $('#xyY', el).textContent = m ? m.y.toFixed(2) : '0.50'; $('#xyA', el).textContent = m ? Math.round(m.act * 100) + '%' : '0%';
    X.EFFECTS.forEach((e, i) => { const b = bars.children[i]; if (!b) return; const v = m ? m.effects[i] : 0; b.firstChild.style.width = Math.round(v * 100) + '%'; b.lastChild.textContent = m && v > 0.02 ? fmt[e](m.p.slice(i * 2, i * 2 + 2)) : '–'; b.classList.toggle('on', v > 0.02); });
  }
  const ui = () => { const st = $('#xyState', el); st.textContent = pad.state === 'active' ? (cur && cur.act > 0 ? 'ACTIVE' : 'NEUTRAL') : 'IDLE'; st.className = 'xystate ' + (pad.state === 'active' ? (cur && cur.act > 0 ? 'on' : 'neu') : ''); };
  const varOpts = fam => X.VARIANTS[fam].map(t => `<option value="${t}"${t === X.variantOf(cfg, fam) ? ' selected' : ''}>${X.VARIANT_LABEL[t]}</option>`).join('');
  const ftOpts = () => varOpts('filter');
  const selId = fam => (fam === 'filter' ? 'xyFt' : 'xyV_' + fam);
  bars.innerHTML = X.EFFECTS.map(e => `<div class="xybar" style="--c:${COL[e]}"><div class="fill"></div><b>${X.NAMES[e]}</b><select id="${selId(e)}" data-fam="${e}" title="Choose the ${X.NAMES[e].toLowerCase()} effect">${varOpts(e)}</select><em>–</em></div>`).join('');
  const syncSelects = () => X.EFFECTS.forEach(e => { const s = $('#' + selId(e), el); if (s) s.value = X.variantOf(cfg, e); const c = $('#xc_' + e, cfgBox); if (c) c.value = X.variantOf(cfg, e); });
  const setVariant = (fam, v) => { if (fam === 'filter') cfg.filterType = v; else cfg.variants[fam] = v; commit(); syncSelects(); if (pad.state === 'idle') post({ act: 0, w: [0, 0, 0, 0], p: [18000, 0, 0.25, 0, 0.5, 0, 1, 0], ft: X.variantIdx(cfg)[0], var: X.variantIdx(cfg) }); toast('XY pad ' + X.NAMES[fam].toLowerCase() + ': ' + X.VARIANT_LABEL[v]); dirty = true; };
  bars.addEventListener('change', e => { const s = e.target.closest('select[data-fam]'); if (s) setVariant(s.dataset.fam, s.value); });
  bars.addEventListener('pointerdown', e => e.stopPropagation());
  (function loop() { requestAnimationFrame(loop); if (el.style.display === 'none' || window.__djHidden) return; if (!size) resize(); if (dirty || cur) { dirty = draw(); readouts(); ui(); } })();
  new ResizeObserver(resize).observe(cv.parentElement); new ResizeObserver(resize).observe(el); window.addEventListener('sidepanels-layout', () => setTimeout(resize, 0));

  /* ---------------------------------------------------------------- settings: assignments, radii, ranges, BPM sync, presets */
  const cfgBox = $('#xyCfg', el);
  const sel = (id, opts, v) => `<select id="${id}">${opts.map(o => `<option value="${o}"${o === v ? ' selected' : ''}>${X.NAMES[o] || o}</option>`).join('')}</select>`;
  const rng = (id, label, min, max, step, v, unit = '') => `<label>${label}<input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${v}"><b id="${id}V">${v}${unit}</b></label>`;
  function renderCfg() {
    const R = cfg.ranges;
    cfgBox.innerHTML = `<h4>Zone assignment</h4><div class="xyas"><label>Top-left ${sel('xaTL', X.EFFECTS, cfg.assign[0])}</label><label>Top-right ${sel('xaTR', X.EFFECTS, cfg.assign[1])}</label><label>Bottom-left ${sel('xaBL', X.EFFECTS, cfg.assign[2])}</label><label>Bottom-right ${sel('xaBR', X.EFFECTS, cfg.assign[3])}</label></div>
      <h4>Effect of each family</h4>${X.EFFECTS.map(e => `<label>${X.NAMES[e]} <select id="xc_${e}">${varOpts(e)}</select></label>`).join('')}
      <h4>Behaviour</h4>${rng('xcNeu', 'Neutral radius', 0, 0.4, 0.01, cfg.neutral)}${rng('xcAct', 'Activation radius', 0.05, 0.7, 0.01, cfg.activation)}${rng('xcSen', 'Sensitivity', 0.5, 2, 0.05, cfg.sensitivity)}${rng('xcShp', 'Zone focus', 0.5, 4, 0.1, cfg.sharpness)}
      <label class="chk"><input type="checkbox" id="xcBpm"${cfg.bpmSync ? ' checked' : ''}> Echo follows the track BPM</label> <label class="chk"><input type="checkbox" id="xcSnap"${cfg.snapEcho ? ' checked' : ''}> Echo snaps to 1/32 … 1 beat</label>
      <h4>Ranges</h4>${rng('xrCl', 'Cutoff low (Hz)', 20, 2000, 10, R.cutoff[0])}${rng('xrCh', 'Cutoff high (Hz)', 2000, 20000, 100, R.cutoff[1])}${rng('xrRes', 'Resonance max (%)', 0, 98, 1, Math.round(R.resMax * 100))}
      ${rng('xrDl', 'Echo shortest (beats)', 0.0156, 0.5, 0.0156, R.delay[0])}${rng('xrDh', 'Echo longest (beats)', 0.25, 4, 0.05, R.delay[1])}${rng('xrFb', 'Feedback max (%)', 0, 95, 1, Math.round(R.fbMax * 100))}
      ${rng('xrRm', 'Room max (%)', 10, 100, 1, Math.round(R.room[1] * 100))}${rng('xrWet', 'Wet max (%)', 0, 100, 1, Math.round(R.wetMax * 100))}${rng('xrRl', 'Flanger rate low (Hz)', 0.02, 2, 0.01, R.rate[0])}${rng('xrRh', 'Flanger rate high (Hz)', 1, 20, 0.1, R.rate[1])}${rng('xrDp', 'Flanger depth max (%)', 0, 100, 1, Math.round(R.depthMax * 100))}
      <h4>Presets</h4><div class="xypre"><select id="xpSel"><option value="">— saved configurations —</option>${Object.keys(presets).map(k => `<option>${k.replace(/</g, '&lt;')}</option>`).join('')}</select><button id="xpLoad">Load</button><button id="xpDel">Delete</button></div>
      <div class="xypre"><input id="xpName" placeholder="name" maxlength="24"><button id="xpSave">Save current</button><button id="xpReset">Restore defaults</button></div>`;
  }
  const commit = () => { cfg = X.sanitize(cfg); lsSet(KEY, cfg); pad.setConfig(cfg); dirty = true; };
  function readCfg() {
    const v = id => +$('#' + id, cfgBox).value, R = cfg.ranges;
    cfg.assign = ['xaTL', 'xaTR', 'xaBL', 'xaBR'].map(i => $('#' + i, cfgBox).value); cfg.neutral = v('xcNeu'); cfg.activation = Math.max(v('xcAct'), cfg.neutral + 0.02); cfg.sensitivity = v('xcSen'); cfg.sharpness = v('xcShp');
    cfg.filterType = $('#xc_filter', cfgBox).value; cfg.variants = { echo: $('#xc_echo', cfgBox).value, reverb: $('#xc_reverb', cfgBox).value, flanger: $('#xc_flanger', cfgBox).value }; syncSelects(); cfg.bpmSync = $('#xcBpm', cfgBox).checked; cfg.snapEcho = $('#xcSnap', cfgBox).checked;
    R.cutoff = [v('xrCl'), v('xrCh')]; R.resMax = v('xrRes') / 100; R.delay = [v('xrDl'), v('xrDh')]; R.fbMax = v('xrFb') / 100; R.room = [0, v('xrRm') / 100]; R.wetMax = v('xrWet') / 100; R.rate = [v('xrRl'), v('xrRh')]; R.depthMax = v('xrDp') / 100;
    cfgBox.querySelectorAll('input[type=range]').forEach(i => { const b = $('#' + i.id + 'V', cfgBox); if (b) b.textContent = i.value; }); commit();
  }
  cfgBox.addEventListener('input', readCfg); cfgBox.addEventListener('change', readCfg);
  cfgBox.addEventListener('click', e => {
    const id = e.target.id; if (!id || !id.startsWith('xp')) return; const name = $('#xpName', cfgBox).value.trim(), pick = $('#xpSel', cfgBox).value;
    if (id === 'xpSave' && name) { presets[name] = X.clone(cfg); lsSet(KEYP, presets); renderCfg(); toast('XY pad configuration saved: ' + name); }
    else if (id === 'xpLoad' && pick && presets[pick]) { cfg = X.sanitize(presets[pick]); commit(); renderCfg(); toast('XY pad configuration loaded: ' + pick); }
    else if (id === 'xpDel' && pick) { delete presets[pick]; lsSet(KEYP, presets); renderCfg(); }
    else if (id === 'xpReset') { cfg = X.clone(X.DEFAULTS); commit(); renderCfg(); toast('XY pad: default settings restored'); }
  });
  $('#xyCfgBtn', el).onclick = () => { if (pad.up()) ui(); cfgBox.hidden = !cfgBox.hidden; el.classList.toggle('cfgopen', !cfgBox.hidden); if (!cfgBox.hidden) renderCfg(); setTimeout(resize, 0); };
  window.xypad = { pad, get cfg() { return cfg; }, setConfig(c) { cfg = X.sanitize(c); commit(); }, send, canvas: cv, presets: () => presets, fb, get state() { return pad.state; }, get cur() { return cur; } };
})();
