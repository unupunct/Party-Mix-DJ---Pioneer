'use strict';
/* LOOP CONTROL + LOOP SLICER panel (left of the console). The calculations are in loopcalc.js; the loop itself is the deck's existing loop (Deck.setLoop -> engine loop, also drawn on the waveform);
   the slicer runs in the audio engine (engine/src/slicer.rs: sample-accurate slice positions, quantised triggers, reverse, repeat, 2 ms cross-fades), this file only sends its configuration and pad events.
   Globals from app.js: decks, nat, engSend, lsGet, lsSet, toast. */
(() => {
  if (!window.sideHost || !window.LoopCalc) return;
  const C = window.LoopCalc, $ = (s, el) => (el || document).querySelector(s);
  const PALETTES = { red: ['#ff4d4d', '#ff9a6a'], blue: ['#38c9ff', '#7fb6ff'], green: ['#37d67a', '#9be15d'], violet: ['#c06cff', '#ff4fa8'], amber: ['#ffb020', '#ffd75a'] };
  const DEF = { sizeIdx: 7, quantize: true, target: 'auto', n: 8, source: 4, mode: 'oneshot', quant: 0, repeat: 0, reverse: Array(16).fill(false), palette: 'red', compact: false };
  let S = Object.assign({}, DEF, lsGet('loopPanel', {}));
  const sane = () => { S.sizeIdx = Math.min(C.SIZES.length - 1, Math.max(0, S.sizeIdx | 0)); S.n = C.SLICE_COUNTS.includes(S.n) ? S.n : 8; S.source = C.SOURCE_BEATS.includes(S.source) ? S.source : 4; if (!C.MODES.includes(S.mode)) S.mode = 'oneshot'; if (!C.QUANT.includes(S.quant)) S.quant = 0; if (![0, 0.25, 0.5, 1].includes(S.repeat)) S.repeat = 0; if (!PALETTES[S.palette]) S.palette = 'red'; if (!Array.isArray(S.reverse) || S.reverse.length !== 16) S.reverse = Array(16).fill(false); if (!['auto', '0', '1'].includes(String(S.target))) S.target = 'auto'; S.target = String(S.target); S.quantize = S.quantize !== false; S.compact = !!S.compact; };
  sane(); const save = () => lsSet('loopPanel', S);
  const el = document.createElement('section'); el.id = 'looppanel';
  window.sideHost.add('left', el);
  const st = { lastLoop: [null, null], slicer: [null, null], revEdit: false, pads: [], padPtr: [] };   // per deck: remembered loop, active slicer region

  /* ---------------------------------------------------------------- target deck */
  let lastLoaded = 0;
  const target = () => { if (S.target !== 'auto') return decks[+S.target]; const pl = decks.filter(d => d.playing && d.buf); if (pl.length === 1) return pl[0]; return decks[lastLoaded] && decks[lastLoaded].buf ? decks[lastLoaded] : (decks.find(d => d.buf) || decks[0]); };
  setInterval(() => decks.forEach((d, i) => { if (d.path && d._lpPath !== d.path) { d._lpPath = d.path; lastLoaded = i; } }), 300);
  const info = d => (d && d.an && d.an.bpm ? { bpm: d.an.bpm, grid: Number.isFinite(d.an.grid) ? d.an.grid : 0, dur: d.dur, quantize: S.quantize } : null);
  const need = d => { const o = info(d); if (!o) toast(d && d.buf ? 'No BPM / beat grid detected for this track' : 'Load a track first'); return o; };

  /* ---------------------------------------------------------------- loop control (the deck's own loop: engine loop + waveform overlay) */
  const setLoop = (d, l) => { if (l) st.lastLoop[d.i] = l; d.setLoop(l); if (st.slicer[d.i] && l) { st.slicer[d.i].region = l; sliceSend(d); } render(); };
  const act = {
    size(i) { S.sizeIdx = i; save(); const d = target(), o = need(d); if (d && d.loop && o) setLoop(d, C.fit({ start: d.loop.start, end: d.loop.start + C.SIZES[i] * C.beat(o.bpm) }, o.dur) || d.loop); render(); },   // changing the size while a loop runs resizes it in place
    auto() { const d = target(), o = need(d); if (!o) return; if (d.loop && Math.abs(C.lengthBeats(d.loop, o.bpm) - C.SIZES[S.sizeIdx]) < 1e-3) return act.exit(); setLoop(d, C.autoLoop(d.pos(), C.SIZES[S.sizeIdx], o)); },
    in() { const d = target(), o = need(d); if (!o) return; const s = C.loopIn(d.pos(), o); st.pendIn = { deck: d.i, start: s }; d.setLoop(null); render(); toast('Loop IN at ' + s.toFixed(2) + ' s: press LOOP OUT'); },
    out() { const d = target(), o = need(d); if (!o) return; const s = st.pendIn && st.pendIn.deck === d.i ? st.pendIn.start : (d.loop ? d.loop.start : C.loopIn(d.pos(), o)), l = C.loopOut(s, d.pos(), o); if (!l) return toast('Loop too short'); st.pendIn = null; setLoop(d, l); },
    toggle() { const d = target(); if (!d) return; if (d.loop) { st.lastLoop[d.i] = d.loop; d.setLoop(null); sliceOff(d); render(); } else if (st.lastLoop[d.i]) setLoop(d, st.lastLoop[d.i]); else act.auto(); },
    exit() { const d = target(); if (!d) return; if (d.loop) st.lastLoop[d.i] = d.loop; st.pendIn = null; d.setLoop(null); sliceOff(d); render(); },
    retrig() { const d = target(); if (d && d.loop) { d.seek(d.loop.start); if (st.slicer[d.i]) nat.active && engSend({ cmd: 'sliceStop', deck: d.i }); } },
    move(dir) { const d = target(), o = need(d); if (d && d.loop && o) setLoop(d, C.move(d.loop, dir, o)); },
    resize(f) { const d = target(), o = need(d); if (d && d.loop && o) setLoop(d, C.resize(d.loop, f, o)); },
    quant() { S.quantize = !S.quantize; save(); render(); },
  };

  /* ---------------------------------------------------------------- slicer (engine) */
  const nativeOk = () => nat.active;
  const sliceCfgMsg = d => { const s = st.slicer[d.i], o = info(d); return s && o ? C.sliceConfig(d.i, { n: S.n, mode: S.mode, quant: S.quant, repeat: S.repeat, reverse: S.reverse }, s.region, o) : { cmd: 'sliceCfg', deck: d.i, on: false }; };
  function sliceSend(d) { if (nativeOk()) engSend(sliceCfgMsg(d)); }
  function sliceOn(d) {
    if (!nativeOk()) return toast('The loop slicer needs the native audio engine');
    const o = need(d); if (!o) return;
    const region = d.loop ? { start: d.loop.start, end: d.loop.end } : C.sliceRegion(d.pos(), S.source, o); if (!region) return toast('Not enough track left for the slicer');
    st.slicer[d.i] = { region, own: !d.loop }; d.loop = { start: region.start, end: region.end };   // shown on the waveform; the engine loops the region itself while the slicer is on
    sliceSend(d); if (!d.playing) d.play(); render();
  }
  function sliceOff(d) { if (!st.slicer[d.i]) return; st.slicer[d.i] = null; if (nativeOk()) engSend({ cmd: 'sliceCfg', deck: d.i, on: false }); render(); }
  const slicerToggle = () => { const d = target(); if (!d) return; const s = st.slicer[d.i]; if (s) { const own = s.own; sliceOff(d); if (own) d.setLoop(null); } else sliceOn(d); };
  const slicerResync = () => { const d = target(); if (d && st.slicer[d.i]) { const o = info(d); if (o && !d.loop) st.slicer[d.i].region = C.sliceRegion(d.pos(), S.source, o); sliceSend(d); } };
  const padPress = i => {
    const d = target(); if (!d) return; if (st.revEdit) { S.reverse[i] = !S.reverse[i]; save(); slicerResync(); render(); return; }
    if (!st.slicer[d.i]) sliceOn(d); if (!st.slicer[d.i]) return; if (!d.playing) d.play();
    st.padDeck = d.i; if (nativeOk()) engSend({ cmd: 'slicePad', deck: d.i, idx: i, down: true });
  };
  const padRelease = i => { const di = st.padDeck != null ? st.padDeck : target().i; if (st.slicer[di] && nativeOk()) engSend({ cmd: 'slicePad', deck: di, idx: i, down: false }); };
  const sliceReset = () => { const d = target(); S.reverse = Array(16).fill(false); save(); if (d && st.slicer[d.i]) { engSend({ cmd: 'sliceStop', deck: d.i }); slicerResync(); } render(); };

  /* ---------------------------------------------------------------- UI */
  const pal = () => PALETTES[S.palette];
  function build() {
    el.style.setProperty('--pa', pal()[0]); el.style.setProperty('--pb', pal()[1]); el.classList.toggle('compact', S.compact);
    const seg = (name, items, cur, fmt = x => x) => `<div class="seg" data-seg="${name}">${items.map(v => `<button data-v="${v}" class="${String(v) === String(cur) ? 'on' : ''}">${fmt(v)}</button>`).join('')}</div>`;
    el.innerHTML = `<header><b>LOOP</b><span class="lpdeck" data-seg="target">${['auto', '0', '1'].map(v => `<button data-v="${v}" class="${S.target === v ? 'on' : ''}" title="${v === 'auto' ? 'Follows the playing deck' : 'Deck ' + (v === '0' ? 'A' : 'B')}">${v === 'auto' ? 'AUTO' : v === '0' ? 'A' : 'B'}</button>`).join('')}</span><span class="lpwho" id="lpWho"></span><button id="lpCfgBtn" title="Settings">⚙</button></header>
      <div class="lpbody">
      <div class="lpsec"><h3>LOOP CONTROL</h3>
        <div class="lpstat" id="lpStat"></div>
        <div class="lpsizes" data-seg="size">${C.SIZES.map((b, i) => `<button data-v="${i}" class="${i === S.sizeIdx ? 'on' : ''}" title="${C.SIZE_LABEL(b)} beat${b === 1 ? '' : 's'}">${C.SIZE_LABEL(b)}</button>`).join('')}</div>
        <div class="lpmain"><button data-act="in">IN</button><button data-act="out">OUT</button><button data-act="auto" class="hot">AUTO</button><button data-act="toggle" id="lpOnOff">ON/OFF</button><button data-act="exit">EXIT</button><button data-act="retrig" title="Jump to the start of the loop">RETRIG</button></div>
        <div class="lpadj"><button data-act="mvb" title="Move the loop back by its length">◀ MOVE</button><button data-act="mvf" title="Move the loop forward by its length">MOVE ▶</button><button data-act="half" title="Half the loop length">÷2</button><button data-act="dbl" title="Double the loop length">×2</button><button data-act="q" id="lpQ" title="Snap IN / OUT / AUTO to the beat grid">QUANT</button></div>
      </div>
      <div class="lpsec"><h3>LOOP SLICER <button id="lpSlOn" class="mini" title="Arm the slicer on the loop (or on the next beats)">OFF</button><button id="lpRev" class="mini" title="Reverse edit: tap pads to flip their direction (right-click a pad does the same)">REV</button><button id="lpReset" class="mini" title="Back to the original sequence">RESET</button></h3>
        <div class="slpads n${S.n}" id="lpPads">${Array.from({ length: S.n }, (_, i) => `<button class="slpad" data-i="${i}"><b>${i + 1}</b><i></i><u></u></button>`).join('')}</div>
        <div class="slrow"><span>SLICES</span>${seg('n', C.SLICE_COUNTS, S.n)}<span>SOURCE</span>${seg('source', C.SOURCE_BEATS, S.source, v => v + ' b')}</div>
        <div class="slrow"><span>MODE</span>${seg('mode', C.MODES, S.mode, v => C.MODE_LABEL[v])}</div>
        <div class="slrow"><span>QUANT</span>${seg('quant', C.QUANT, S.quant, v => (v ? '1/' + 1 / v : 'OFF').replace('1/1', '1').replace('1/4', '1/4'))}<span>REPEAT</span>${seg('repeat', [0, 0.25, 0.5, 1], S.repeat, v => (v ? (v === 1 ? '1' : '1/' + 1 / v) : 'OFF'))}</div>
      </div></div>
      <div class="lpcfg" id="lpCfg" hidden></div>`;
    st.pads = [...el.querySelectorAll('.slpad')]; bindPads(); render();
  }
  function bindPads() {
    st.padPtr = st.pads.map((b, i) => new C.PadPointer(() => { b.classList.add('down'); padPress(i); }, () => { b.classList.remove('down'); padRelease(i); }));
    st.pads.forEach((b, i) => {
      const p = st.padPtr[i]; b.style.touchAction = 'none';
      b.addEventListener('pointerdown', e => { if (e.pointerType === 'mouse' && e.button !== 0) return; e.preventDefault(); try { b.setPointerCapture(e.pointerId); } catch {} p.press(e.pointerId); });
      for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(ev, e => p.release(e.pointerId));
      b.addEventListener('contextmenu', e => { e.preventDefault(); S.reverse[i] = !S.reverse[i]; save(); slicerResync(); render(); });
    });
  }
  const releaseAll = () => st.padPtr.forEach(p => p.release());
  window.addEventListener('blur', releaseAll); window.addEventListener('pointerup', () => { if (st.padPtr.some(p => p.down)) setTimeout(releaseAll, 0); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

  el.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b || b.classList.contains('slpad')) return;
    const seg = b.closest('[data-seg]');
    if (seg) {
      const k = seg.dataset.seg, v = b.dataset.v;
      if (k === 'size') act.size(+v); else if (k === 'target') { S.target = v; save(); render(); }
      else { if (k === 'n') S.n = +v; else if (k === 'source') S.source = +v; else if (k === 'mode') S.mode = v; else if (k === 'quant') S.quant = +v; else if (k === 'repeat') S.repeat = +v; sane(); save(); if (k === 'n') { build(); slicerResync(); return; } if (k === 'source') { const d = target(); if (d && st.slicer[d.i] && !d.loop) { st.slicer[d.i].region = null; slicerResync(); } } else slicerResync(); render(); }
      return;
    }
    const a = b.dataset.act; if (a) { ({ in: act.in, out: act.out, auto: act.auto, toggle: act.toggle, exit: act.exit, retrig: act.retrig, mvb: () => act.move(-1), mvf: () => act.move(1), half: () => act.resize(0.5), dbl: () => act.resize(2), q: act.quant })[a](); return; }
    if (b.id === 'lpSlOn') slicerToggle(); else if (b.id === 'lpRev') { st.revEdit = !st.revEdit; render(); } else if (b.id === 'lpReset') sliceReset(); else if (b.id === 'lpCfgBtn') cfgToggle();
  });

  /* status + pads follow the deck and the engine (30 fps while the panel is visible) */
  function render() {
    if (!st.pads.length) return; const d = target(), o = info(d), loop = d && d.loop, sl = d && st.slicer[d.i];
    $('#lpWho', el).textContent = d ? (d.i ? 'DECK B' : 'DECK A') : '';
    $('#lpStat', el).innerHTML = loop && o ? `<span class="chip on">${sl ? 'SLICER' : 'LOOP ON'}</span><span>IN <b>${loop.start.toFixed(2)}</b></span><span>OUT <b>${loop.end.toFixed(2)}</b></span><span><b>${(+C.lengthBeats(loop, o.bpm).toFixed(3))}</b> beats</span>`
      : st.pendIn ? `<span class="chip">IN SET</span><span>IN <b>${st.pendIn.start.toFixed(2)}</b></span><span>press OUT</span>` : `<span class="chip">LOOP OFF</span><span>size <b>${C.SIZE_LABEL(C.SIZES[S.sizeIdx])}</b> beat${C.SIZES[S.sizeIdx] === 1 ? '' : 's'}</span>${o ? '' : '<span class="dim">no beat grid</span>'}`;
    el.querySelectorAll('[data-seg=size] button').forEach(b => b.classList.toggle('on', +b.dataset.v === S.sizeIdx));
    $('#lpOnOff', el).classList.toggle('on', !!loop); $('#lpQ', el).classList.toggle('on', S.quantize); $('#lpRev', el).classList.toggle('on', st.revEdit);
    const so = $('#lpSlOn', el); so.textContent = sl ? 'ON' : 'OFF'; so.classList.toggle('on', !!sl);
    st.pads.forEach((b, i) => b.classList.toggle('rev', !!S.reverse[i]));
    el.classList.toggle('revedit', st.revEdit);
  }
  setInterval(() => {   // pad highlights from the engine's report, progress from the playhead
    if (!st.pads.length || el.style.display === 'none' || window.__djHidden) return;
    const d = target(); if (!d) return; const sl = st.slicer[d.i], es = nat.state && nat.state.decks && nat.state.decks[d.i], cur = es && es.slice != null ? es.slice : -1, pend = es && es.slicePend != null ? es.slicePend : -1, o = info(d);
    const idx = sl && o ? C.sliceAt(sl.region, S.n, d.pos()) : null;
    st.pads.forEach((b, i) => {
      b.classList.toggle('on', !!sl && cur === i); b.classList.toggle('pend', !!sl && pend === i); b.classList.toggle('head', !!sl && cur < 0 && idx === i);
      const bar = b.querySelector('u'); let pr = 0; if (sl && o && (cur === i || (cur < 0 && idx === i))) { const bnd = C.sliceBounds(sl.region, S.n, i), pos = d.pos(); pr = Math.min(1, Math.max(0, (pos - bnd.start) / (bnd.end - bnd.start))); if (S.reverse[i] && cur === i) pr = 1 - pr; } bar.style.width = (pr * 100).toFixed(0) + '%';
    });
    if (sl && !d.loop) { sl.region = null; st.slicer[d.i] = null; render(); }                 // the loop was cleared elsewhere: the slicer follows
    else if (sl && d.loop && (Math.abs(d.loop.start - sl.region.start) > 1e-6 || Math.abs(d.loop.end - sl.region.end) > 1e-6)) { sl.region = { start: d.loop.start, end: d.loop.end }; sliceSend(d); }
    render();
  }, 40);

  /* ---------------------------------------------------------------- settings */
  const cfgBox = $('#lpCfg', el);
  function cfgToggle() { const box = $('#lpCfg', el); box.hidden = !box.hidden; if (!box.hidden) renderCfg(); }
  function renderCfg() {
    const box = $('#lpCfg', el), opt = (arr, cur, f = x => x) => arr.map(v => `<option value="${v}"${String(v) === String(cur) ? ' selected' : ''}>${f(v)}</option>`).join('');
    box.innerHTML = `<h4>Defaults</h4><label>Default loop size <select id="lcSize">${opt(C.SIZES.map((_, i) => i), S.sizeIdx, i => C.SIZE_LABEL(C.SIZES[i]) + ' beat' + (C.SIZES[i] === 1 ? '' : 's'))}</select></label>
      <label>Slicer source length <select id="lcSrc">${opt(C.SOURCE_BEATS, S.source, v => v + ' beat' + (v === 1 ? '' : 's'))}</select></label><label>Number of slices <select id="lcN">${opt(C.SLICE_COUNTS, S.n)}</select></label>
      <label>Playback mode <select id="lcMode">${opt(C.MODES, S.mode, v => C.MODE_LABEL[v])}</select></label><label>Quantisation <select id="lcQ">${opt(C.QUANT, S.quant, v => (v ? '1/' + 1 / v + ' beat' : 'none').replace('1/1 beat', '1 beat'))}</select></label>
      <label class="chk"><input type="checkbox" id="lcQuant"${S.quantize ? ' checked' : ''}> Snap loop IN / OUT / AUTO to the beat grid</label>
      <h4>Look</h4><label>Pad colours <select id="lcPal">${opt(Object.keys(PALETTES), S.palette)}</select></label><label class="chk"><input type="checkbox" id="lcCompact"${S.compact ? ' checked' : ''}> Compact buttons</label>
      <h4>Reverse</h4><div class="dim">Tap REV, then the pads you want reversed (or right-click a pad). <button id="lcClearRev">Clear all</button></div><div class="lpbtns"><button id="lcReset">Restore defaults</button></div>`;
  }
  el.addEventListener('change', e => {
    const id = e.target.id; if (!id || !id.startsWith('lc')) return; const v = e.target.value;
    if (id === 'lcSize') S.sizeIdx = +v; else if (id === 'lcSrc') S.source = +v; else if (id === 'lcN') S.n = +v; else if (id === 'lcMode') S.mode = v; else if (id === 'lcQ') S.quant = +v;
    else if (id === 'lcQuant') S.quantize = e.target.checked; else if (id === 'lcPal') S.palette = v; else if (id === 'lcCompact') S.compact = e.target.checked;
    sane(); save(); const open = !$('#lpCfg', el).hidden; build(); if (open) { $('#lpCfg', el).hidden = false; renderCfg(); } slicerResync();
  });
  el.addEventListener('click', e => {
    if (e.target.id === 'lcClearRev') { S.reverse = Array(16).fill(false); save(); slicerResync(); render(); }
    if (e.target.id === 'lcReset') { S = Object.assign({}, DEF, { reverse: Array(16).fill(false) }); save(); build(); const d = target(); if (d && st.slicer[d.i]) slicerResync(); toast('Loop panel: default settings restored'); }
  });
  build();
  window.loopPanel = { act, S: () => S, state: st, target, slicerToggle, padPress, padRelease, sliceReset, build, render, sliceCfgMsg, setS(o) { Object.assign(S, o); sane(); save(); build(); slicerResync(); } };
})();
