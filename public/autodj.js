'use strict';
/* AUTO DJ: plays the playlist by itself.
   - picks the next song by a mode (best Harmonic Match, vibe, random, playlist order, energy up / down),
   - loads it on the free deck, matches the tempo (also half / double time) and starts it on the next bar of the playing song,
   - crossfades with a bass swap over 8 / 16 / 32 beats, then stops the old deck and repeats.
   Needs globals from app.js: decks, playlist, sel, ctl, nat, loadToDeck, libMatch, toast, lsGet, lsSet, clamp, trackLabel, fmt. */
(() => {
  const MODES = [
    { id: 'best', name: 'BEST MATCH', text: 'The next song is the best Harmonic Match: key, tempo, energy and more.' },
    { id: 'vibe', name: 'VIBE', text: 'Keeps the same mood and energy, with variety among the best matches.' },
    { id: 'random', name: 'RANDOM', text: 'Any song from the playlist, never the same one twice in a row.' },
    { id: 'playlist', name: 'PLAYLIST ORDER', text: 'The playlist from top to bottom.' },
    { id: 'up', name: 'ENERGY UP', text: 'Builds the set: each song a little more energetic.' },
    { id: 'down', name: 'ENERGY DOWN', text: 'Cools the set down: calmer and calmer songs.' },
  ];
  const BEATS = [[8, 'Short · 8 beats'], [16, 'Normal · 16 beats'], [32, 'Long · 32 beats']];
  const S = { on: false, mode: lsGet('adjMode', 'best'), beats: +lsGet('adjBeats', 16) || 16, state: 'off', leader: null, nextItem: null, nextReady: false, preparing: false, busy: false,
    hist: [], skip: false, cmdAt: 0, fade: null, msg: '', timer: 0, bassSwap: true, log: [] };
  if (!MODES.some(m => m.id === S.mode)) S.mode = 'best';
  const side = i => (i === 0 ? -1 : 1);
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const itemOf = d => (d && d.trackId ? playlist.find(i => i.id === d.trackId) : null);
  const labelOf = it => (it ? trackLabel(it) : '–');
  const modeName = () => MODES.find(m => m.id === S.mode).name;
  const note = m => { S.msg = m; S.log.unshift(m); S.log.length = Math.min(S.log.length, 30); };
  const finished = d => d.buf && d.dur && d.pos() >= d.dur - 0.35;
  const remaining = d => Math.max(0, (d.dur - d.pos()) / Math.max(0.2, d.effRate));

  /* ---------------------------------------------------------------- choosing the next song */
  function pool(exclude) {
    const ex = new Set(exclude);
    const all = playlist.filter(i => i.path && !ex.has(i.path));
    const fresh = all.filter(i => !S.hist.includes(i.path));
    if (fresh.length) return fresh;
    S.hist = S.hist.slice(-1); return all;                      // everything played: start over (never the song that just played)
  }
  const pickRandom = a => a[Math.floor(Math.random() * a.length)];
  async function chooseNext(L) {
    const cur = itemOf(L), p = pool(decks.map(d => d.path).filter(Boolean)).filter(i => !decks.some(d => d.trackId === i.id));   // never a song that is already on a deck
    if (!p.length) return null;
    if (S.mode === 'random') return pickRandom(p);
    if (S.mode === 'playlist') {
      const at = cur ? playlist.indexOf(cur) : -1;
      for (let k = 1; k <= playlist.length; k++) { const it = playlist[(at + k) % playlist.length]; if (it && p.includes(it)) return it; }
      return p[0];
    }
    // the matching modes ask the library engine (needs the native engine and analysed tracks); anything that fails falls back to random
    if (!nat.active) { note('Matching needs the native audio engine: random song'); return pickRandom(p); }
    try {
      const H = window.harmonic, settings = H.engineSettings(+ctl[`d${L.i}.pitch`].el.value);
      if (S.mode === 'vibe' && H.PRESETS && H.PRESETS.similar) settings.weights = H.PRESETS.similar.w;
      const res = await libMatch(L.path, { settings, filter: { limit: 60, sort: 'score', minScore: 0 }, scope: { paths: p.map(i => i.path) } });
      let ms = (res.matches || []).filter(m => p.some(i => i.path === m.path));
      if (!ms.length) return pickRandom(p);
      const ok = ms.filter(m => m.tempo && m.tempo.withinLimit), pref = ok.length ? ok : ms;   // songs whose tempo can be matched first
      let m;
      if (S.mode === 'best') m = pref[0];
      else if (S.mode === 'vibe') { const top = pref.slice(0, 6); const w = top.map(x => Math.pow(Math.max(0.05, x.score), 3)), tot = w.reduce((a, b) => a + b, 0); let r = Math.random() * tot; m = top.find((x, k) => (r -= w[k]) <= 0) || top[0]; }
      else {
        const e0 = res.source && res.source.energy != null ? res.source.energy : 5, cand = pref.slice(0, 25).filter(x => x.score >= 0.35);
        const up = S.mode === 'up', fit = (cand.length ? cand : pref).filter(x => (up ? x.energy >= e0 : x.energy <= e0));
        const set = fit.length ? fit : (cand.length ? cand : pref);
        m = set.slice().sort((a, b) => (up ? a.energy - b.energy : b.energy - a.energy) || b.score - a.score).find(x => (up ? x.energy > e0 : x.energy < e0)) || set[0];   // the smallest step in the wanted direction
      }
      note(`${modeName()}: ${m.artist ? m.artist + ' – ' : ''}${m.title || m.path.split(/[\\/]/).pop()} (match ${Math.round(m.score * (m.score <= 1 ? 100 : 1))}%)`);
      return p.find(i => i.path === m.path) || pickRandom(p);
    } catch (e) { note('Matching not available (' + (e.message || e) + '): random song'); return pickRandom(p); }
  }

  /* ---------------------------------------------------------------- the transition */
  function makePlan(L, N) {
    const lb = L.an && L.an.bpm ? L.effBpm : 0, nb = N.an && N.an.bpm ? N.an.bpm : 0, limit = (window.harmonic && +window.harmonic.hm.settings.pitchLimit) || 8;
    let mode = 'cut', rate = 1, per = 0;
    if (lb && nb) {
      let best = null;
      for (const f of [1, 2, 0.5]) { const r = lb * f / nb, off = Math.abs(r - 1) * 100; if (off <= limit && (!best || off < best.off - 1)) best = { r, off, f }; }
      if (best) { mode = 'sync'; rate = best.r; per = 60 / lb; }
    }
    const rem = remaining(L);
    let fade = mode === 'sync' ? S.beats * per : Math.min(6, rem);
    fade = Math.min(fade, Math.max(1.2, rem - 0.4), N.dur * 0.45);
    let wait = 0;
    if (mode === 'sync' && L.playing && L.an.grid != null) {          // start on the next bar of the playing song
      const bL = (L.pos() - L.an.grid) / (60 / L.an.bpm), nextBar = Math.ceil(bL / 4 - 0.02) * 4;
      wait = Math.max(0, (nextBar - bL) * (60 / L.an.bpm) / Math.max(0.2, L.effRate));
      if (wait + fade > rem - 0.2) { wait = 0; fade = Math.max(1.2, Math.min(fade, rem - 0.3)); }       // no time left: start at once
    }
    return { mode, rate, fade, wait };
  }
  const sleepUntil = async t => { const d = t - performance.now(); if (d > 25) await sleep(d - 20); while (performance.now() < t) { /* spin the last milliseconds for a tight start */ } };

  async function begin(L, N) {
    S.state = 'fading'; S.skip = false;
    const plan = makePlan(L, N), item = S.nextItem;
    const lb = +ctl[`d${L.i}.bass`].el.value, nb = +ctl[`d${N.i}.bass`].el.value;
    N.synced = false; if (plan.mode === 'sync') ctl[`d${N.i}.pitch`].set(clamp((plan.rate - 1) * 100, -16, 16)); else ctl[`d${N.i}.pitch`].set(0);
    N.seek(N.an && N.an.grid ? N.an.grid : 0);
    if (S.bassSwap) ctl[`d${N.i}.bass`].set(0.12);                     // the new song comes in without its bass
    note(`${plan.mode === 'sync' ? 'Tempo matched' : 'No tempo match possible: short crossfade'} · ${labelOf(item)}`);
    if (plan.wait > 0.02) await sleepUntil(performance.now() + plan.wait * 1000);
    N.play(); S.cmdAt = performance.now(); S.hist.push(item.path);
    if (plan.mode === 'sync') setTimeout(() => { if (L.playing && N.playing) N.syncTo(L); }, 900);   // fine phase correction once the engine is running
    S.fade = { L: L.i, N: N.i, t0: performance.now(), ms: plan.fade * 1000, lb, nb, plan };
    const startX = side(L.i), endX = side(N.i);
    await new Promise(res => {
      const iv = setInterval(() => {
        if (!S.on) { clearInterval(iv); res(); return; }
        const p = clamp((performance.now() - S.fade.t0) / S.fade.ms, 0, 1), e = p * p * (3 - 2 * p);
        ctl.xf.set(startX + (endX - startX) * e);
        if (S.bassSwap) {
          ctl[`d${N.i}.bass`].set(0.12 + (nb - 0.12) * clamp((p - 0.25) / 0.3, 0, 1));          // new bass in...
          ctl[`d${L.i}.bass`].set(lb - (lb - 0.1) * clamp((p - 0.45) / 0.3, 0, 1));              // ...old bass out
        }
        if (p >= 1) { clearInterval(iv); res(); }
      }, 40);
    });
    if (!S.on) return;
    L.pause(); ctl[`d${L.i}.bass`].set(lb); ctl[`d${N.i}.bass`].set(nb); ctl[`d${L.i}.pitch`].set(0); ctl.xf.set(endX);
    S.leader = N.i; S.nextItem = null; S.nextReady = false; S.fade = null; S.state = 'play';
    note('Now playing: ' + labelOf(itemOf(N)));
  }

  /* ---------------------------------------------------------------- the loop */
  async function prepareNext(L, N) {
    if (N.playing) return;
    const item = await chooseNext(L); if (!item || !S.on) return;
    S.nextItem = item; await loadToDeck(N, item);
    S.nextReady = !!(N.buf && N.trackId === item.id); if (!S.nextReady) { S.nextItem = null; note('Could not load ' + labelOf(item)); }
  }
  async function startFresh() {
    const p = pool([]); if (!p.length) { stop('The playlist is empty'); return; }
    const it = S.mode === 'playlist' ? (playlist[sel] || p[0]) : pickRandom(p);
    await loadToDeck(decks[0], it); if (!decks[0].buf) return;
    decks[0].play(); S.cmdAt = performance.now(); S.leader = 0; S.hist.push(it.path); S.state = 'play'; ctl.xf.set(-1); note('Starting with ' + labelOf(it));
  }
  async function step() {
    let L = S.leader != null ? decks[S.leader] : null;
    if (!L || !L.buf || L.loading) {
      L = decks.find(d => d.buf && d.playing) || decks.find(d => d.buf && !d.loading) || null;
      if (!L) { if (!decks.some(d => d.loading)) await startFresh(); return; }
      S.leader = L.i; ctl.xf.set(side(L.i)); if (!L.playing) { L.play(); S.cmdAt = performance.now(); }
      if (L.path && !S.hist.includes(L.path)) S.hist.push(L.path);
    }
    if (!L.playing && !finished(L)) { if (performance.now() - S.cmdAt > 2500) stop('Auto DJ stopped: the deck was paused'); return; }
    const N = decks[1 - L.i], rem = remaining(L), per = L.an && L.an.bpm ? 60 / L.effBpm : 0.5;
    const fadeEst = L.an && L.an.bpm ? S.beats * per : 6, preload = Math.max(fadeEst + 25, 40);
    if (!S.nextItem && !S.preparing && (rem < preload || S.skip)) { S.preparing = true; try { await prepareNext(L, N); } finally { S.preparing = false; } }
    if (S.nextReady) {
      const outro = L.feat && L.feat.outroStartS, remOutro = outro && outro > L.dur * 0.6 ? (outro - L.pos()) / Math.max(0.2, L.effRate) : Infinity;
      if (S.skip || finished(L) || rem <= Math.min(fadeEst, L.dur * 0.4) + 4 * per + 0.6 || remOutro <= 4 * per + 0.3) await begin(L, N);
    } else if (finished(L) && !S.preparing) { S.nextItem = null; }     // song ended and no next ready: the next pass prepares it
  }
  async function tick() {
    if (!S.on) return;
    if (!S.busy && S.state !== 'fading') { S.busy = true; try { await step(); } catch (e) { console.warn('[autodj]', e); } finally { S.busy = false; } }
    paint();
  }
  function start() {
    if (S.on) return; S.on = true; S.state = 'play'; S.leader = null; S.nextItem = null; S.nextReady = false; S.fade = null; S.skip = false; S.hist = []; S.log = [];
    ctl['d0.vol'].set(1); ctl['d1.vol'].set(1);                           // channel faders open: the crossfader does the mixing
    note('Auto DJ started · ' + modeName()); clearInterval(S.timer); S.timer = setInterval(tick, 250); tick(); paint();
  }
  function stop(why) {
    if (!S.on) return; S.on = false; S.state = 'off'; clearInterval(S.timer);
    if (S.fade) { const f = S.fade; ctl[`d${f.L}.bass`].set(f.lb); ctl[`d${f.N}.bass`].set(f.nb); S.fade = null; }
    note(why || 'Auto DJ stopped'); if (why) toast(why, 4000); paint();
  }
  const skip = () => { if (S.on) { S.skip = true; note('Skipping to the next song…'); } };

  /* ---------------------------------------------------------------- panel + header button */
  let dlg;
  const btn = document.getElementById('btnAuto');
  function build() {
    if (dlg) return;
    dlg = document.createElement('dialog'); dlg.id = 'autodlg'; dlg.className = 'autodlg';
    dlg.innerHTML = `<div class="adwrap">
      <div class="adhead"><h3>AUTO DJ</h3><span id="adState" class="adstate"></span></div>
      <div class="adnote">Plays the playlist by itself: picks the next song, matches the tempo, lines up the beats, swaps the bass and crossfades.</div>
      <div class="admodes" id="adModes">${MODES.map(m => `<button type="button" data-m="${m.id}"><b>${m.name}</b><span>${m.text}</span></button>`).join('')}</div>
      <label class="adrow">Transition <select id="adBeats">${BEATS.map(([b, t]) => `<option value="${b}">${t}</option>`).join('')}</select></label>
      <label class="adrow adchk"><input type="checkbox" id="adBass" checked> Bass swap during the transition</label>
      <div class="adnow"><div><small>NOW</small><b id="adNow">–</b></div><div><small>NEXT</small><b id="adNext">–</b></div><div class="adbar"><i id="adBarI"></i></div><code id="adMsg"></code></div>
      <menu><button type="button" id="adSkip">SKIP ▶▶</button><button type="button" id="adClose">Close</button><button type="button" id="adGo" class="primary">START AUTO DJ</button></menu></div>`;
    document.body.appendChild(dlg);
    dlg.querySelectorAll('#adModes button').forEach(b => b.onclick = () => { S.mode = b.dataset.m; lsSet('adjMode', S.mode); if (S.on) note('Mode: ' + modeName()); paint(); });
    dlg.querySelector('#adBeats').onchange = e => { S.beats = +e.target.value; lsSet('adjBeats', S.beats); };
    dlg.querySelector('#adBass').onchange = e => { S.bassSwap = e.target.checked; };
    dlg.querySelector('#adGo').onclick = () => { S.on ? stop() : start(); };
    dlg.querySelector('#adSkip').onclick = skip; dlg.querySelector('#adClose').onclick = () => dlg.close();
    dlg.querySelector('#adBeats').value = String(S.beats);
  }
  function paint() {
    if (btn) { btn.classList.toggle('on', S.on); btn.textContent = S.on ? 'AUTO DJ ● ' + modeName() : 'AUTO DJ'; }
    if (!dlg) return;
    dlg.querySelectorAll('#adModes button').forEach(b => b.classList.toggle('on', b.dataset.m === S.mode));
    dlg.querySelector('#adGo').textContent = S.on ? 'STOP AUTO DJ' : 'START AUTO DJ'; dlg.querySelector('#adGo').classList.toggle('stop', S.on);
    dlg.querySelector('#adSkip').disabled = !S.on;
    dlg.querySelector('#adState').textContent = !S.on ? 'OFF' : S.state === 'fading' ? 'MIXING' : S.preparing ? 'LOADING NEXT' : 'PLAYING';
    dlg.querySelector('#adState').className = 'adstate ' + (S.on ? 'on' : '');
    const L = S.leader != null ? decks[S.leader] : null;
    dlg.querySelector('#adNow').textContent = S.on && L ? labelOf(itemOf(S.fade ? decks[S.fade.N] : L)) : '–';
    const rem = L && L.buf ? remaining(L) : 0;
    dlg.querySelector('#adNext').textContent = S.state === 'fading' ? '(mixing in now)' : S.nextItem ? labelOf(S.nextItem) + (S.state !== 'fading' && rem ? '  ·  in ' + fmt(rem) : '') : (S.on ? '(chosen shortly before the end)' : '–');
    dlg.querySelector('#adBarI').style.width = S.fade ? Math.round(clamp((performance.now() - S.fade.t0) / S.fade.ms, 0, 1) * 100) + '%' : '0%';
    dlg.querySelector('#adMsg').textContent = S.msg;
  }
  const openPanel = () => { build(); if (!dlg.open) dlg.show(); paint(); };
  if (btn) btn.addEventListener('click', openPanel);
  window.autodj = { S, MODES, start, stop, skip, tick, open: openPanel, chooseNext, makePlan };
})();
