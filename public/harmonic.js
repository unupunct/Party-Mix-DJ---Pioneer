'use strict';
/* HARMONIC MATCH workspace (H4).
   Everything shown here is computed by the engine (matching, sequence analysis) from the SQLite library; this file only asks and displays.
   Works only with the native engine + library (not in the Web Audio fallback). Globals from app.js: nat, lib, decks, ctl, playlist, loadToDeck,
   libMatch, libSequence, libScan, libSend, toast, setKeyFilter, camelotColor, togglePfl, lsGet, lsSet, clamp, fmtS. */
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const WEIGHTS = [['harmonic', 'Harmonic'], ['bpm', 'Tempo'], ['energy', 'Energy'], ['rhythm', 'Rhythm'], ['genre', 'Genre'], ['mood', 'Mood'], ['danceability', 'Danceability'], ['spectral', 'Spectrum'], ['vocal', 'Vocals']];
  const PRESETS = {
    default: { label: 'Balanced (default)', w: { harmonic: 20, bpm: 15, energy: 15, rhythm: 15, genre: 10, mood: 10, danceability: 5, spectral: 5, vocal: 5 } },
    harmonic: { label: 'Harmonic mix', w: { harmonic: 45, bpm: 20, energy: 10, rhythm: 8, genre: 5, mood: 4, danceability: 3, spectral: 3, vocal: 2 } },
    tempo: { label: 'Tempo first', w: { harmonic: 10, bpm: 45, energy: 12, rhythm: 12, genre: 6, mood: 5, danceability: 4, spectral: 3, vocal: 3 } },
    energy: { label: 'Energy flow', w: { harmonic: 12, bpm: 12, energy: 35, rhythm: 14, genre: 6, mood: 8, danceability: 6, spectral: 4, vocal: 3 } },
    similar: { label: 'Similar sound (keys may differ)', w: { harmonic: 4, bpm: 10, energy: 15, rhythm: 20, genre: 15, mood: 12, danceability: 5, spectral: 14, vocal: 5 } },
  };
  const CLS = { 'Excellent': 'ex', 'Very Good': 'vg', 'Compatible': 'co', 'Experimental': 'xp', 'Not Recommended': 'nr' };
  const hm = {
    view: 'dj', req: 0, seqReq: 0, res: null, matches: [], sel: null, err: '', pin: null, sourceMode: 'auto', lastLoaded: 1, prevPaths: ['', ''],
    settings: Object.assign({ preset: 'default', weights: { ...PRESETS.default.w }, pitchLimit: 8, keylock: false, gates: true }, lsGet('hmSettings', {})),
    f: Object.assign({ minScore: 0, bpmMin: '', bpmMax: '', maxBpmDiff: '', energyMin: '', energyMax: '', genre: '', vocals: 'any', sort: 'score', scope: 'library', folder: '' }, lsGet('hmFilter', {})),
    keyFilter: '', set: lsGet('setlist', []), seq: null, seqScope: lsGet('hmSeqScope', 'playlist'), sig: '', seqSig: '', dirty: true, pair: null,
  };
  const save = () => { lsSet('hmSettings', hm.settings); lsSet('hmFilter', hm.f); lsSet('setlist', hm.set); lsSet('hmSeqScope', hm.seqScope); };
  const num = v => (v === '' || v == null || isNaN(+v)) ? undefined : +v;
  const base = p => String(p || '').split(/[\\/]/).pop();
  const dirOf = p => String(p || '').replace(/[\\/][^\\/]*$/, '');
  const fmtDur = s => { s = Math.round(s || 0); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60); return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min ${String(s % 60).padStart(2, '0')} s`; };
  const keyTxt = (c, conf) => c ? `${c}${conf != null && conf < 0.35 ? '?' : ''}` : '–';
  const keyHtml = (c, conf) => c ? `<span class="ck" style="color:${camelotColor(c)}${conf != null && conf < 0.35 ? ';opacity:.6' : ''}">${keyTxt(c, conf)}</span>` : '–';
  const itemFor = path => playlist.find(i => i.path === path) || (hm.set.find(i => i.path === path) ? { id: 'set:' + path, name: base(path), path, artist: hm.set.find(i => i.path === path).artist, title: hm.set.find(i => i.path === path).title } : { id: 'hm:' + path, name: base(path), path });
  const labelOf = m => (m.artist ? m.artist + ' – ' : '') + (m.title || base(m.path).replace(/\.[^.]+$/, ''));

  /* ---------------------------------------------------------------- settings / filters -> engine
     (kept pure so they can be inspected from the self-test) */
  function engineSettings(sourcePitch) {
    const s = hm.settings, w = hm.pin ? PRESETS.similar.w : s.weights;
    return { weights: w, pitchLimit: +s.pitchLimit || 8, keylock: !!s.keylock, gates: !!s.gates, sourcePitch: sourcePitch || 0 };
  }
  function engineFilter() {
    const f = hm.f;
    return { minScore: +f.minScore || 0, bpmMin: num(f.bpmMin), bpmMax: num(f.bpmMax), maxBpmDiff: num(f.maxBpmDiff), energyMin: num(f.energyMin), energyMax: num(f.energyMax),
      genres: String(f.genre || '').split(',').map(x => x.trim()).filter(Boolean), vocals: f.vocals, limit: 300, sort: f.sort };
  }
  function engineScope(src) {
    const pl = playlist.map(i => i.path).filter(Boolean), st = hm.set.map(i => i.path);
    switch (hm.f.scope) {
      case 'playlist': return { paths: pl };
      case 'set': return { paths: st };
      case 'notset': return { exclude: st };
      case 'folder': return { folder: hm.f.folder || (src ? dirOf(src.path) : '') };
      default: return {};
    }
  }

  /* ---------------------------------------------------------------- live source selection */
  const deckItem = d => d.trackId ? playlist.find(i => i.id === d.trackId) || (d.path ? { id: d.trackId, path: d.path, name: d.name } : null) : null;
  const onAir = d => { const v = +ctl[`d${d.i}.vol`].el.value, x = (+ctl.xf.el.value + 1) / 2, g = d.i === 0 ? Math.min(1, 2 * (1 - x)) : Math.min(1, 2 * x); return v * v * g; };
  function pickSource() {
    if (hm.pin) return { kind: 'pin', path: hm.pin.path, label: hm.pin.label, pitch: 0 };
    const ds = decks.filter(d => d.buf && d.path);
    if (!ds.length) return null;
    let d = null;
    if (hm.sourceMode !== 'auto') d = ds.find(x => x.i === +hm.sourceMode) || null;
    else { const playing = ds.filter(x => x.playing); d = playing.length === 1 ? playing[0] : playing.length > 1 ? playing.sort((a, b) => onAir(b) - onAir(a))[0] : (ds.find(x => x.i === hm.lastLoaded) || ds[0]); }
    return d ? { kind: 'deck', deck: d.i, target: 1 - d.i, path: d.path, label: d.name, pitch: +ctl[`d${d.i}.pitch`].el.value, playing: d.playing } : null;
  }
  const statusOf = path => { const it = playlist.find(i => i.path === path); return it ? it.anStatus : undefined; };

  /* ---------------------------------------------------------------- build the static page */
  function build() {
    $('#hmview').innerHTML = `
    <section class="hm-top" id="hmTop"></section>
    <section class="hm-adv" id="hmAdv">
      <div class="card" id="hmRead"></div>
      <div class="card" id="hmWheelCard"><h3>Camelot wheel <span class="dim small" id="hmWheelSub"></span></h3><div id="hmWheel"></div></div>
      <div class="card" id="hmNext"></div>
    </section>
    <section class="hm-ctl" id="hmCtl">
      <div class="row1">
        <label>Source <select id="hmSrc"><option value="auto">Live (auto)</option><option value="0">Deck A</option><option value="1">Deck B</option></select></label>
        <label>Preset <select id="hmPreset">${Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`).join('')}<option value="custom">Custom weights</option></select></label>
        <label>Search in <select id="hmScope"><option value="library">Whole library</option><option value="playlist">Current playlist</option><option value="set">My set list</option><option value="notset">Not yet in my set list</option><option value="folder">Folder…</option></select></label>
        <input id="hmFolder" placeholder="folder path (default: the source track's folder)" hidden>
        <label>Sort <select id="hmSort"><option value="score">Compatibility</option><option value="bpm">BPM</option><option value="key">Key</option><option value="energy">Energy</option><option value="genre">Genre</option></select></label>
        <button id="hmRefresh" title="Recalculate now">↻ Refresh</button>
        <button id="hmWeightsBtn">Weights…</button>
        <button id="hmGenerate" disabled title="Smart playlist generator: next step (H5)">Generate Smart Playlist</button>
      </div>
      <div class="row2">
        <label>Min score <input type="range" id="hmMin" min="0" max="100" step="1"><b id="hmMinV">0</b></label>
        <label>BPM <input id="hmBmin" type="number" placeholder="min"> – <input id="hmBmax" type="number" placeholder="max"></label>
        <label>Max BPM diff <input id="hmBdiff" type="number" placeholder="any"></label>
        <label>Energy <input id="hmEmin" type="number" min="1" max="10" placeholder="1"> – <input id="hmEmax" type="number" min="1" max="10" placeholder="10"></label>
        <label>Genre <input id="hmGenre" placeholder="house, disco…"></label>
        <label>Vocals <select id="hmVoc"><option value="any">any</option><option value="only">with vocals</option><option value="none">instrumental</option></select></label>
        <label>Pitch limit <input id="hmLimit" type="number" min="1" max="30" step="1" style="width:52px"> %</label>
        <label class="chk"><input type="checkbox" id="hmKeylock"> Key-lock</label>
        <label class="chk" title="Down-weight pairs that cannot be tempo-matched or clash harmonically"><input type="checkbox" id="hmGates"> Penalties</label>
        <span id="hmKeyChip" class="keychip" hidden></span>
      </div>
      <div id="hmWeights" class="weights" hidden></div>
    </section>
    <section class="hm-mid">
      <div class="hm-tablewrap"><table id="hmTable"><thead><tr><th>Match</th><th>Track</th><th>BPM</th><th>Key</th><th>E</th><th title="Tempo change needed on the candidate">Tempo change</th><th>Key compatibility</th><th title="Candidate energy minus source energy">ΔE</th><th>Genre</th><th>Mood</th><th></th></tr></thead><tbody></tbody></table><div id="hmMsg" class="empty"></div></div>
      <aside id="hmDetail" class="hm-detail"></aside>
    </section>
    <section class="hm-bottom">
      <div class="card" id="hmAnalysis"><h3>Playlist analysis <select id="hmSeqScope"><option value="playlist">Current playlist</option><option value="set">My set list</option></select></h3><div id="hmStats"></div></div>
      <div class="card" id="hmGraphs"><h3>Energy progression</h3><div id="hmEnergy"></div><h3>BPM distribution</h3><div id="hmBpm"></div></div>
    </section>`;
    bind();
    syncControls();
  }
  const keys24 = () => { const out = []; for (let n = 1; n <= 12; n++) out.push(n + 'B'); for (let n = 1; n <= 12; n++) out.push(n + 'A'); return out; };

  function syncControls() {
    const f = hm.f, s = hm.settings;
    $('#hmPreset').value = s.preset; $('#hmScope').value = f.scope; $('#hmSort').value = f.sort; $('#hmFolder').value = f.folder; $('#hmFolder').hidden = f.scope !== 'folder';
    $('#hmMin').value = f.minScore; $('#hmMinV').textContent = f.minScore; $('#hmBmin').value = f.bpmMin; $('#hmBmax').value = f.bpmMax; $('#hmBdiff').value = f.maxBpmDiff;
    $('#hmEmin').value = f.energyMin; $('#hmEmax').value = f.energyMax; $('#hmGenre').value = f.genre; $('#hmVoc').value = f.vocals;
    $('#hmLimit').value = s.pitchLimit; $('#hmKeylock').checked = s.keylock; $('#hmGates').checked = s.gates; $('#hmSeqScope').value = hm.seqScope; $('#hmSrc').value = hm.sourceMode;
    renderWeights();
  }
  function renderWeights() {
    const w = hm.settings.weights, sum = WEIGHTS.reduce((a, [k]) => a + (+w[k] || 0), 0) || 1;
    $('#hmWeights').innerHTML = `<div class="wgrid">${WEIGHTS.map(([k, name]) => `<label>${name}<input type="range" min="0" max="50" step="1" data-w="${k}" value="${w[k]}"><b>${w[k]} <small>(${Math.round(100 * w[k] / sum)}%)</small></b></label>`).join('')}</div>
      <div class="dim small">Weights are relative: only their proportions matter. <button id="hmWReset">Reset to default</button></div>`;
  }
  const dirty = () => { hm.dirty = true; save(); };
  function bind() {
    const on = (id, ev, fn) => { const el = $(id); el.addEventListener(ev, fn); };
    on('#hmSrc', 'change', e => { hm.sourceMode = e.target.value; hm.pin = null; dirty(); });
    on('#hmPreset', 'change', e => { const k = e.target.value; hm.settings.preset = k; if (PRESETS[k]) hm.settings.weights = { ...PRESETS[k].w }; hm.pin = null; renderWeights(); dirty(); });
    on('#hmScope', 'change', e => { hm.f.scope = e.target.value; $('#hmFolder').hidden = hm.f.scope !== 'folder'; dirty(); });
    on('#hmFolder', 'change', e => { hm.f.folder = e.target.value.trim(); dirty(); });
    on('#hmSort', 'change', e => { hm.f.sort = e.target.value; dirty(); });
    on('#hmMin', 'input', e => { hm.f.minScore = +e.target.value; $('#hmMinV').textContent = e.target.value; dirty(); });
    for (const [id, k] of [['#hmBmin', 'bpmMin'], ['#hmBmax', 'bpmMax'], ['#hmBdiff', 'maxBpmDiff'], ['#hmEmin', 'energyMin'], ['#hmEmax', 'energyMax'], ['#hmGenre', 'genre']]) on(id, 'change', e => { hm.f[k] = e.target.value; dirty(); });
    on('#hmVoc', 'change', e => { hm.f.vocals = e.target.value; dirty(); });
    on('#hmLimit', 'change', e => { hm.settings.pitchLimit = clamp(+e.target.value || 8, 1, 30); dirty(); hm.seqSig = ''; });
    on('#hmKeylock', 'change', e => { hm.settings.keylock = e.target.checked; dirty(); hm.seqSig = ''; });
    on('#hmGates', 'change', e => { hm.settings.gates = e.target.checked; dirty(); hm.seqSig = ''; });
    on('#hmRefresh', 'click', () => { hm.dirty = true; hm.seqSig = ''; });
    on('#hmWeightsBtn', 'click', () => { const w = $('#hmWeights'); w.hidden = !w.hidden; });
    on('#hmWeights', 'input', e => { const k = e.target.dataset.w; if (!k) return; hm.settings.weights[k] = +e.target.value; hm.settings.preset = 'custom'; $('#hmPreset').value = 'custom'; const lab = e.target.parentElement.querySelector('b'); const sum = WEIGHTS.reduce((a, [kk]) => a + (+hm.settings.weights[kk] || 0), 0) || 1; lab.innerHTML = `${e.target.value} <small>(${Math.round(100 * e.target.value / sum)}%)</small>`; dirty(); });
    on('#hmWeights', 'click', e => { if (e.target.id === 'hmWReset') { hm.settings.preset = 'default'; hm.settings.weights = { ...PRESETS.default.w }; renderWeights(); $('#hmPreset').value = 'default'; dirty(); } });
    on('#hmSeqScope', 'change', e => { hm.seqScope = e.target.value; hm.seqSig = ''; save(); });
    on('#hmKeyChip', 'click', () => setKey(''));
    $('#hmTable tbody').addEventListener('click', onRowClick);
    $('#hmDetail').addEventListener('click', onActionClick);
    $('#hmTop').addEventListener('click', onActionClick);
    $('#hmStats').addEventListener('click', onStatsClick);
    $('#hmWheel').addEventListener('click', e => { const k = e.target.closest('[data-key]'); if (k) setKey(k.dataset.key); });
    $('#hmEnergy').addEventListener('click', e => graphClick(e));
    $('#hmNext').addEventListener('click', onNextClick);
    $('#hmWheel').addEventListener('click', e => { const dot = e.target.closest('[data-rec]'); if (dot) { hm.sel = dot.dataset.rec; renderTable(); renderAdvisor(); } });
  }
  function setKey(k) {
    hm.keyFilter = (k && k !== hm.keyFilter) ? k : '';
    setKeyFilter(hm.keyFilter);                // the main playlist follows
    $('#hmKeyChip').hidden = !hm.keyFilter; $('#hmKeyChip').textContent = hm.keyFilter ? `Key ${hm.keyFilter} ✕` : '';
    renderTable(); renderWheel();
  }

  /* ---------------------------------------------------------------- top: source + pair */
  function renderTop(src, res) {
    const top = $('#hmTop');
    if (!nat.active || !lib.ready) { top.innerHTML = `<div class="card wide"><b>Harmonic Match needs the native audio engine and the music library.</b><div class="dim">They are not available in this session (built-in audio fallback).</div></div>`; return; }
    if (!src) { top.innerHTML = `<div class="card wide"><b>No track selected</b><div class="dim">Load a track on a deck, or press “Similar” on any recommendation. The list follows the deck that is playing.</div></div>`; return; }
    const d = src.kind === 'deck' ? decks[src.deck] : null, s = res && res.source, f = d && d.feat;
    const bpm = s ? s.bpm * (1 + (src.pitch || 0) / 100) : 0;
    const keyName = f && f.key ? f.key.name : '';
    const conf = s ? s.keyConfidence : (f && f.key ? f.key.confidence : null);
    const st = statusOf(src.path);
    const head = src.kind === 'pin' ? `<span class="badge pin">SIMILAR TO</span>` : `<span class="badge ${src.deck ? 'b' : 'a'}">DECK ${src.deck ? 'B' : 'A'}</span>${src.playing ? ' <span class="live">● PLAYING</span>' : ''}`;
    const rec = src.kind === 'pin' ? `<button data-act="unpin">← Back to live matching</button>` : `<span class="dim">Next song for <b>Deck ${src.deck ? 'B' : 'A'}</b> <small>(mix it in on the free deck, or load it here when this track ends)</small></span>`;
    let body;
    if (!s) body = st === 'pending' || st === 'analyzing' ? `<div class="dim">Analysing this track… recommendations appear when it is done.</div>` : st === 'error' ? `<div class="warn">This track could not be analysed.</div>` : `<div class="dim">${esc(hm.err || 'This track is not analysed yet.')} <button data-act="analyze-src">Analyze track</button></div>`;
    else body = `<div class="srcgrid"><div><small>BPM</small><b>${bpm.toFixed(1)}</b>${src.pitch ? `<small> (${(src.pitch >= 0 ? '+' : '') + src.pitch.toFixed(1)}%)</small>` : ''}</div><div><small>Camelot key</small><b>${keyHtml(s.camelot, conf)}</b>${keyName ? `<small> ${esc(keyName)}</small>` : ''}</div><div><small>Energy</small><b>${s.energy}/10</b></div><div><small>Genre</small><b>${esc(s.genre || '–')}</b></div><div><small>Key confidence</small><b>${conf != null ? Math.round(conf * 100) + '%' : '–'}</b></div></div>`;
    $('#hmTop').innerHTML = `<div class="card src"><div class="srchead">${head}<span class="srctitle">${esc(s ? labelOf(s) : src.label)}</span>${rec}</div>${body}</div><div class="card pair" id="hmPair">${pairHtml()}</div>`;
  }
  function pairHtml() {
    const p = hm.pair;
    if (!p) return `<div class="dim">Deck pair: load analysed tracks on both decks to see how well they match.</div>`;
    if (p.msg) return `<h3>Deck A ⇄ Deck B</h3><div class="dim">${esc(p.msg)}</div>`;
    const m = p.m;
    return `<h3>Deck ${p.from ? 'B' : 'A'} → Deck ${p.from ? 'A' : 'B'}</h3><div class="pairscore ${CLS[m.label] || ''}"><b>${Math.round(m.score)}%</b> <span>${m.label}</span></div>
      <div class="pairrows"><div>BPM ${m.tempo.originalBpm.toFixed(1)} → ${m.tempo.targetBpm.toFixed(1)}: <b>${tempoText(m)}</b></div><div>Key ${keyTxt(m.harmonic.sourceKey)} → ${keyTxt(m.harmonic.candidateKey)}: <b>${esc(m.harmonic.relation)}</b> (${m.harmonic.label})</div><div>Energy ${p.srcEnergy} → ${m.energy} (${m.energy - p.srcEnergy >= 0 ? '+' : ''}${m.energy - p.srcEnergy})</div></div>${m.notes.length ? `<div class="notes">${m.notes.map(n => `<div>• ${esc(n)}</div>`).join('')}</div>` : ''}`;
  }
  const tempoText = m => { const t = m.tempo; if (t.mode === 'unknown') return 'unknown'; const a = t.adjustPct, mode = t.mode === 'double-time' ? ' (double-time)' : t.mode === 'half-time' ? ' (half-time)' : ''; return `${a >= 0 ? 'speed up' : 'slow down'} ${Math.abs(a).toFixed(1)}%${mode}${t.withinLimit ? '' : ' – beyond your pitch limit'}`; };

  async function refreshPair() {
    const ds = decks.filter(d => d.buf && d.path);
    if (ds.length < 2) { hm.pair = null; const el = $('#hmPair'); if (el) el.innerHTML = pairHtml(); return; }
    const src = pickSource();
    const from = src && src.kind === 'deck' ? src.deck : 0, a = decks[from], b = decks[1 - from];
    const sa = statusOf(a.path), sb = statusOf(b.path);
    if (sa !== 'done' || sb !== 'done') hm.pair = { msg: 'Waiting for the analysis of ' + (sa !== 'done' ? 'Deck ' + (from ? 'B' : 'A') : 'Deck ' + (from ? 'A' : 'B')) + '…' };
    else {
      try { const r = await libMatch(a.path, { settings: engineSettings(+ctl[`d${from}.pitch`].el.value), filter: { limit: 1 }, scope: { paths: [b.path] } }); hm.pair = r.matches[0] ? { m: r.matches[0], from, srcEnergy: r.source.energy } : { msg: 'No result.' }; }
      catch (e) { hm.pair = { msg: e.message }; }
    }
    const el = $('#hmPair'); if (el) el.innerHTML = pairHtml();
  }

  /* ---------------------------------------------------------------- recommendations table */
  function visibleMatches() { return hm.matches.filter(m => !hm.keyFilter || m.camelot === hm.keyFilter); }
  function renderTable() {
    const tb = $('#hmTable tbody'), msg = $('#hmMsg'), rows = visibleMatches();
    const srcE = hm.res ? hm.res.source.energy : 0;
    tb.innerHTML = rows.map((m, i) => {
      const t = m.tempo, h = m.harmonic, dE = m.energy - srcE;
      const shift = h.candidateKeyAfterShift && h.candidateKeyAfterShift !== h.candidateKey ? ` <small>(→ ${h.candidateKeyAfterShift} with pitch)</small>` : '';
      return `<tr data-i="${i}" data-path="${esc(m.path)}" class="${hm.sel === m.path ? 'sel' : ''}">
        <td class="sc"><b>${Math.round(m.score)}%</b><span class="lab ${CLS[m.label] || ''}">${m.label}</span></td>
        <td class="tt"><b>${esc(m.title || base(m.path).replace(/\.[^.]+$/, ''))}</b><i>${esc(m.artist || '')}</i></td>
        <td>${m.bpm ? m.bpm.toFixed(1) : '–'}</td><td>${keyHtml(m.camelot, h.uncertain ? 0 : 1)}</td><td>${m.energy || '–'}</td>
        <td class="bd" title="${esc(tempoText(m))}">${t.mode === 'unknown' ? '–' : `${t.adjustPct >= 0 ? '+' : ''}${t.adjustPct.toFixed(1)}%${t.mode !== 'direct' ? ' <small>' + (t.mode === 'double-time' ? '×2' : '÷2') + '</small>' : ''}${t.withinLimit ? '' : ' <small class="warn">limit</small>'}`}</td>
        <td class="kr"><span class="lab ${CLS[h.label] || ''}">${h.label}</span><small>${esc(h.relation)}${h.uncertain ? ' ?' : ''}</small>${shift}</td>
        <td>${dE > 0 ? '+' : ''}${dE}</td><td>${esc(m.genre || '–')}</td><td class="mood">${esc((m.mood || '').split(' /')[0])}</td>
        <td class="act"><button data-act="prev" title="Preview in headphones">▶</button><button data-act="a" title="Load to Deck A">A</button><button data-act="b" title="Load to Deck B">B</button><button data-act="set" title="Add to my set list">＋</button><button data-act="sim" title="Find similar tracks">≈</button><button data-act="an" title="Analyze this track again">↻</button></td></tr>`;
    }).join('');
    msg.textContent = hm.err ? hm.err : !hm.res ? '' : !rows.length ? (hm.matches.length ? `No matches with key ${hm.keyFilter}.` : (hm.res.candidates ? 'No tracks match your filters.' : 'Nothing to compare with yet: analyse more tracks.')) : '';
    if (hm.res && hm.res.unanalysed > 0) msg.textContent += `${msg.textContent ? ' ' : ''}${hm.res.unanalysed} track(s) are not analysed yet and are not included.`;
    renderDetail();
  }
  const rowMatch = el => { const tr = el.closest('tr[data-path]'); return tr ? hm.matches.find(m => m.path === tr.dataset.path) : null; };
  function onRowClick(e) {
    const m = rowMatch(e.target); if (!m) return;
    const b = e.target.closest('button[data-act]');
    if (b) return act(b.dataset.act, m);
    hm.sel = m.path; renderTable(); renderAdvisor();
  }
  function onActionClick(e) {
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const m = hm.matches.find(x => x.path === hm.sel);
    if (b.dataset.act === 'unpin') { hm.pin = null; dirty(); return; }
    if (b.dataset.act === 'analyze-src') { const s = pickSource(); if (s) analyze(s.path); return; }
    if (m) act(b.dataset.act, m);
  }
  const PARTS = [['harmonic', 'Harmonic', m => m.harmonic], ['tempo', 'Tempo', m => m.tempo], ['energyPart', 'Energy', m => m.energyPart], ['rhythm', 'Rhythm', m => m.rhythm], ['genrePart', 'Genre', m => m.genrePart], ['moodPart', 'Mood', m => m.moodPart], ['danceabilityPart', 'Danceability', m => m.danceabilityPart], ['spectral', 'Spectrum', m => m.spectral], ['vocalPart', 'Vocals', m => m.vocalPart]];
  function renderDetail() {
    const el = $('#hmDetail'), m = hm.matches.find(x => x.path === hm.sel);
    if (!m) { el.innerHTML = `<div class="dim">Select a track to see why it scores as it does.</div>`; return; }
    const detail = p => p.detail || (p.relation ? p.relation : '');
    el.innerHTML = `<h3>${esc(labelOf(m))}</h3><div class="big ${CLS[m.label] || ''}"><b>${m.score.toFixed(1)}%</b> ${m.label}</div>
      ${PARTS.map(([k, name, get]) => { const p = get(m); return `<div class="bar" title="${esc(detail(p))}"><span>${name}</span><div class="track"><i style="width:${Math.round(p.score * 100)}%;opacity:${0.35 + 0.65 * (p.reliability == null ? 1 : p.reliability)}"></i></div><em>${Math.round(p.score * 100)}</em></div><div class="why">${esc(k === 'tempo' ? tempoText(m) : detail(p))}${p.reliability != null && p.reliability < 1 ? ' <span class="warn">(low confidence: counts less)</span>' : ''}</div>`; }).join('')}
      ${m.notes.length ? `<div class="notes">${m.notes.map(n => `<div>• ${esc(n)}</div>`).join('')}</div>` : ''}
      <div class="dactions"><button data-act="prev">▶ Preview</button><button data-act="a">Load to Deck A</button><button data-act="b">Load to Deck B</button><button data-act="set">Add to set list</button><button data-act="sim">Find similar</button><button data-act="an">Analyze track</button></div>`;
  }

  /* ---------------------------------------------------------------- actions */
  function analyze(path) { libScan([itemFor(path)], true); const it = playlist.find(i => i.path === path); if (it) it.anStatus = 'pending'; toast('Analysing ' + base(path) + '…', 2500); hm.dirty = true; }
  async function preview(m) {
    if (!nat.active) return toast('Preview needs the native audio engine');
    const src = pickSource();
    const free = decks.filter(d => !d.playing && !d.scratching).sort((a, b) => (src && src.kind === 'deck' && a.i === src.deck ? 1 : 0) - (src && src.kind === 'deck' && b.i === src.deck ? 1 : 0))[0];
    if (!free) return toast('Both decks are playing: stop one to preview a track in your headphones', 5000);
    ctl[`d${free.i}.vol`].set(0);                                                // audible only in the headphones until the channel fader is opened
    if (!free.pflOn) togglePfl(free);
    if (nat.status && nat.status.cue === 'off') toast('Headphone cue is off: choose it under Audio settings to hear the preview', 6000);
    await loadToDeck(free, itemFor(m.path));
    if (!free.buf) return;
    const intro = free.feat && free.feat.introEndS != null ? free.feat.introEndS : free.dur * 0.3;
    free.seek(Math.min(intro, Math.max(0, free.dur - 10))); free.play();
    toast(`Previewing on Deck ${free.i ? 'B' : 'A'} in your headphones (channel fader at 0)`, 4500);
  }
  function addToSet(m) {
    if (hm.set.some(i => i.path === m.path)) return toast('Already in your set list');
    hm.set.push({ path: m.path, artist: m.artist || '', title: m.title || base(m.path).replace(/\.[^.]+$/, '') }); save(); hm.seqSig = ''; toast(`Added to set list (${hm.set.length})`, 2500);
  }
  function act(a, m) {
    if (a === 'prev') preview(m);
    else if (a === 'a') loadToDeck(decks[0], itemFor(m.path));
    else if (a === 'b') loadToDeck(decks[1], itemFor(m.path));
    else if (a === 'set') addToSet(m);
    else if (a === 'sim') { hm.pin = { path: m.path, label: labelOf(m) }; hm.dirty = true; hm.sel = null; }
    else if (a === 'an') analyze(m.path);
  }

  /* ---------------------------------------------------------------- refresh loop */
  async function refresh() {
    hm.dirty = false;
    if (!nat.active || !lib.ready) { renderTop(null); return; }
    const src = pickSource(); hm.srcNow = src;
    if (!src) { hm.res = null; hm.matches = []; hm.err = ''; renderTop(null); renderTable(); renderAdvisor(); return; }
    const my = ++hm.req;
    try {
      const res = await libMatch(src.path, { settings: engineSettings(src.pitch || 0), filter: engineFilter(), scope: engineScope(src) });
      if (my !== hm.req) return;
      hm.res = res; hm.matches = res.matches; hm.err = '';
      if (hm.sel && !hm.matches.some(m => m.path === hm.sel)) hm.sel = null;
      if (!hm.sel && hm.matches.length) hm.sel = hm.matches[0].path;
    } catch (e) { if (my !== hm.req) return; hm.res = null; hm.matches = []; hm.err = /not been analysed/.test(e.message) ? '' : e.message; }
    renderTop(src, hm.res); renderTable(); renderWheel(); renderAdvisor(); refreshPair();
  }
  const seqPaths = () => hm.seqScope === 'set' ? hm.set.map(i => i.path) : playlist.map(i => i.path).filter(Boolean);
  async function refreshSeq() {
    hm.seqSig = seqSignature();
    if (!nat.active || !lib.ready) return;
    const paths = seqPaths(), my = ++hm.seqReq;
    if (!paths.length) { hm.seq = null; renderAnalysis(); renderGraphs(); renderWheel(); return; }
    try { const r = await libSequence(paths, engineSettings(0)); if (my !== hm.seqReq) return; hm.seq = r; } catch (e) { if (my !== hm.seqReq) return; hm.seq = { error: e.message }; }
    renderAnalysis(); renderGraphs(); renderWheel();
  }
  const seqSignature = () => `${hm.seqScope}|${playlist.length}|${playlist.reduce((n, i) => n + (i.anStatus === 'done' ? 1 : 0), 0)}|${hm.set.map(i => i.path).join(',').length}|${hm.set.length}|${hm.settings.pitchLimit}|${hm.settings.keylock}|${hm.settings.gates}`;
  function tick() {
    if (hm.view !== 'hm') return;
    decks.forEach((d, i) => { if (d.path && hm.prevPaths[i] !== d.path) { hm.prevPaths[i] = d.path; hm.lastLoaded = i; } });
    const src = pickSource();
    const sig = JSON.stringify([src && [src.kind, src.deck, src.path, Math.round((src.pitch || 0) * 2) / 2, statusOf(src.path)], decks.map(d => d.path), decks.map(d => Math.round(+ctl[`d${d.i}.pitch`].el.value * 2))]);
    if (sig !== hm.sig || hm.dirty) { hm.sig = sig; clearTimeout(hm.deb); hm.deb = setTimeout(refresh, 200); }
    if (seqSignature() !== hm.seqSig) { hm.seqSig = seqSignature(); clearTimeout(hm.sdeb); hm.sdeb = setTimeout(refreshSeq, 300); }
  }

  /* ---------------------------------------------------------------- Camelot wheel */
  function sector(cx, cy, r0, r1, a0, a1) {
    const p = (r, a) => [cx + r * Math.sin(a), cy - r * Math.cos(a)].map(v => v.toFixed(1));
    const [x0, y0] = p(r1, a0), [x1, y1] = p(r1, a1), [x2, y2] = p(r0, a1), [x3, y3] = p(r0, a0);
    return `M${x0},${y0} A${r1},${r1} 0 0 1 ${x1},${y1} L${x2},${y2} A${r0},${r0} 0 0 0 ${x3},${y3} Z`;
  }
  function renderWheel() {
    const counts = hm.seq && hm.seq.keys ? hm.seq.keys : {};
    const max = Math.max(1, ...Object.values(counts));
    const sk = hm.res && hm.res.source ? hm.res.source.camelot : null;
    const parse = k => k ? [parseInt(k, 10), k.endsWith('A')] : null, sp = parse(sk);
    const compat = k => { if (!sp) return false; const [n, a] = parse(k); const d = ((n - sp[0]) % 12 + 12) % 12; return (a === sp[1] && (d === 0 || d === 1 || d === 11)) || (a !== sp[1] && d === 0); };
    const S = 340, c = S / 2, recs = topRecs();
    let svg = `<svg viewBox="0 0 ${S} ${S}" id="hmWheelSvg" role="img" aria-label="Camelot wheel"><defs><radialGradient id="whBg" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#1b1f2a"/><stop offset="1" stop-color="#0a0b0e"/></radialGradient><radialGradient id="whHub" cx="50%" cy="40%" r="70%"><stop offset="0" stop-color="#2a2f3d"/><stop offset="1" stop-color="#0e1016"/></radialGradient><filter id="whGlow" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="3.2"/></filter></defs>
      <circle cx="${c}" cy="${c}" r="${c - 2}" fill="url(#whBg)" stroke="#2c303b" stroke-width="2"/><circle cx="${c}" cy="${c}" r="${c - 9}" fill="none" stroke="#1f232d" stroke-width="1"/>`;
    for (let t = 0; t < 60; t++) { const a = t * 6 * Math.PI / 180, r0 = t % 5 ? c - 7 : c - 11; svg += `<line x1="${(c + r0 * Math.sin(a)).toFixed(1)}" y1="${(c - r0 * Math.cos(a)).toFixed(1)}" x2="${(c + (c - 4) * Math.sin(a)).toFixed(1)}" y2="${(c - (c - 4) * Math.cos(a)).toFixed(1)}" stroke="#3a3f4d" stroke-width="${t % 5 ? 0.6 : 1.2}"/>`; }
    const pos = {};   // centre of each key's segment
    for (const key of keys24()) {
      const n = parseInt(key, 10), minor = key.endsWith('A'), k = n % 12, r0 = minor ? 66 : 112, r1 = minor ? 110 : 156, a0 = (k * 30 - 14.2) * Math.PI / 180, a1 = (k * 30 + 14.2) * Math.PI / 180;
      const cnt = counts[key] || 0, mid = (r0 + r1) / 2, am = k * 30 * Math.PI / 180, tx = c + mid * Math.sin(am), ty = c - mid * Math.cos(am); pos[key] = { am, r0, r1, mid, tx, ty };
      const cls = ['seg', compat(key) ? 'compat' : '', key === sk ? 'src' : '', key === hm.keyFilter ? 'picked' : ''].filter(Boolean).join(' ');
      svg += `<g class="${cls}" data-key="${key}"><title>${key}: ${cnt} track(s)${key === sk ? ' (source key)' : compat(key) ? ' (compatible with the source)' : ''}</title><path d="${sector(c, c, r0, r1, a0, a1)}" style="fill:${camelotColor(key)};fill-opacity:${(sk ? (compat(key) ? 0.5 : 0.14) + 0.34 * cnt / max : 0.22 + 0.7 * cnt / max).toFixed(2)}"/><text x="${tx.toFixed(1)}" y="${(ty + (cnt ? -2 : 4)).toFixed(1)}" text-anchor="middle">${key}</text>${cnt ? `<text x="${tx.toFixed(1)}" y="${(ty + 10).toFixed(1)}" text-anchor="middle" class="cnt">${cnt}</text>` : ''}</g>`;
    }
    // the source key glows; every recommended song gets a numbered dot in the key it is in, joined to the hub
    if (sk && pos[sk]) { const p = pos[sk]; svg += `<path class="srcglow" d="${sector(c, c, p.r0 - 2, p.r1 + 2, p.am - 0.26, p.am + 0.26)}" fill="none" stroke="#ffd23f" stroke-width="3" filter="url(#whGlow)"/>`; }
    const used = {};
    recs.forEach((m, i) => {
      const p = pos[m.camelot]; if (!p) return; const u = used[m.camelot] = (used[m.camelot] || 0) + 1, off = (u - 1) * 0.15 * (u % 2 ? -1 : 1), a = p.am + off, r = p.mid + (p.r1 - p.r0) * 0.28 * (u > 2 ? 1 : 0);
      const x = c + r * Math.sin(a), y = c - r * Math.cos(a), col = m.score >= 90 ? '#37d67a' : m.score >= 75 ? '#9be15d' : m.score >= 60 ? '#ffd23f' : '#ff9a6a', on = hm.sel === m.path;
      svg += `<line x1="${(c + 60 * Math.sin(a)).toFixed(1)}" y1="${(c - 60 * Math.cos(a)).toFixed(1)}" x2="${x.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${col}" stroke-opacity="${on ? 0.95 : 0.35}" stroke-width="${on ? 2 : 1}" stroke-dasharray="3 3"/>
        <g class="rec${on ? ' on' : ''}" data-rec="${esc(m.path)}"><title>#${i + 1} ${esc(labelOf(m))}: ${Math.round(m.score)}% (${m.camelot})</title><circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${on ? 11 : 9}" fill="#0b0c10" stroke="${col}" stroke-width="2.4"/><text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle" class="rn">${i + 1}</text></g>`;
    });
    // hub: the key and tempo of the song being read
    const bpm = hm.res && hm.res.source ? hm.res.source.bpm : 0, kcol = sk ? camelotColor(sk) : '#888';
    svg += `<circle cx="${c}" cy="${c}" r="58" fill="url(#whHub)" stroke="${kcol}" stroke-width="2.5"/><circle cx="${c}" cy="${c}" r="52" fill="none" stroke="#2c303b" stroke-width="1"/>
      <text x="${c}" y="${c - 6}" text-anchor="middle" class="hubk" style="fill:${kcol}">${sk || '–'}</text><text x="${c}" y="${c + 12}" text-anchor="middle" class="hubb">${bpm ? bpm.toFixed(0) + ' BPM' : 'no track'}</text><text x="${c}" y="${c + 26}" text-anchor="middle" class="hubs">${sk ? 'NOW' : ''}</text></svg>`;
    $('#hmWheel').innerHTML = svg;
    $('#hmWheelSub').textContent = sk ? 'numbers = best next songs' : 'click a key to filter';
  }

  /* ---------------------------------------------------------------- advisor: reads the song, recommends the next one */
  const sameSong = m => hm.res && hm.res.source && (m.path === hm.res.source.path || (m.title && m.title === hm.res.source.title && Math.abs((m.bpm || 0) - hm.res.source.bpm) < 0.6 && m.camelot === hm.res.source.camelot));
  function topRecs() { return hm.matches.filter(m => !sameSong(m)).sort((a, b) => b.score - a.score).slice(0, 5); }
  const mmss = s => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
  function keyMove(m) {
    const sk = hm.res && hm.res.source && hm.res.source.camelot, ck = m.camelot; if (!sk || !ck) return ['', ''];
    const a = [parseInt(sk, 10), sk.endsWith('A')], b = [parseInt(ck, 10), ck.endsWith('A')], d = ((b[0] - a[0]) % 12 + 12) % 12;
    if (a[1] === b[1] && d === 0) return ['Perfect key match', 'same key: the mix is seamless'];
    if (a[1] === b[1] && d === 1) return ['Energy lift', 'one step up the wheel: lifts the energy'];
    if (a[1] === b[1] && d === 11) return ['Settle down', 'one step down the wheel: relaxes the energy'];
    if (a[1] !== b[1] && d === 0) return ['Mood switch', (b[1] ? 'relative minor' : 'relative major') + ': same notes, other mood'];
    return [m.harmonic.label, m.harmonic.relation];
  }
  function renderAdvisor() {
    const read = $('#hmRead'), next = $('#hmNext'); if (!read || !next) return;
    const src = hm.srcNow, s = hm.res && hm.res.source, d = src && src.kind === 'deck' ? decks[src.deck] : null, f = d && d.feat;
    hm.wfDeck = d && d.an ? d : null;
    if (!nat.active || !lib.ready) { read.innerHTML = next.innerHTML = ''; return; }
    if (!src || !s) { read.innerHTML = `<h3>Reading the song</h3><div class="dim">${src ? 'Analysing this track… the reading appears when it is done.' : 'Load a track on a deck: it is read here (key, tempo, energy, structure) and the best next songs are suggested.'}</div>`; next.innerHTML = `<h3>Play next</h3><div class="dim">No recommendations yet.</div>`; return; }
    const conf = s.keyConfidence, dance = f ? f.danceability : null, pct = v => Math.round(v * 100);
    const seg = n => Array.from({ length: 10 }, (_, i) => `<i class="${i < n ? 'on' : ''}" style="${i < n ? 'background:' + (n >= 8 ? '#ff5d5d' : n >= 5 ? '#ffb020' : '#37d67a') : ''}"></i>`).join('');
    let when = '';
    if (d && f && d.playing) { const pos = d.pos(), outro = f.outroStartS; when = outro != null && outro > pos ? `<b>Bring the next song in around ${mmss(outro)}</b> (the outro starts) · in ${mmss(outro - pos)}` : `<b>This song is in its outro: mix the next one in now</b> · ${mmss(d.dur - pos)} left`; }
    else if (d && f && f.outroStartS != null) when = `Outro starts at ${mmss(f.outroStartS)} · intro ends at ${mmss(f.introEndS || 0)}`;
    read.innerHTML = `<h3>Reading the song <span class="dim small">${src.kind === 'deck' ? 'Deck ' + (src.deck ? 'B' : 'A') + (src.playing ? ' · playing' : '') : 'similar-to mode'}</span></h3>
      <div class="rtitle" title="${esc(labelOf(s))}">${esc(labelOf(s))}</div>
      <div class="rgrid"><div><small>Key</small><b>${keyHtml(s.camelot, conf)}</b><em>${f && f.key ? esc(f.key.name) : ''}${conf != null ? ' · ' + pct(conf) + '% sure' : ''}</em></div>
        <div><small>Tempo</small><b>${(s.bpm * (1 + ((src.pitch || 0) / 100))).toFixed(1)}</b><em>BPM${src.pitch ? ' (' + (src.pitch >= 0 ? '+' : '') + src.pitch.toFixed(1) + '%)' : ''}${f && f.timeSignature ? ' · ' + f.timeSignature + '/4' : ''}</em></div>
        <div><small>Energy</small><span class="seg10">${seg(s.energy || 0)}</span><em>${s.energy || '–'} / 10</em></div>
        <div><small>Danceability</small><span class="meter"><i style="width:${dance != null ? pct(dance) : 0}%"></i></span><em>${dance != null ? pct(dance) + '%' : '–'}</em></div></div>
      <div class="rchips">${f && f.mood ? `<span class="chip">${esc(f.mood.split(' /')[0])}</span>` : ''}${f ? `<span class="chip">${f.vocalPresence > 0.35 ? 'vocals' : 'mostly instrumental'}</span><span class="chip">${f.low > 0.6 ? 'bass-heavy' : f.high > 0.12 ? 'bright' : 'balanced'}</span>` : ''}${s.genre ? `<span class="chip">${esc(s.genre)}</span>` : ''}</div>
      ${d && d.an ? `<canvas id="hmWf" class="wf"></canvas>` : ''}
      <div class="rwhen">${when}</div>`;
    drawWf();

    const recs = topRecs();
    next.innerHTML = `<h3>Play next <span class="dim small">best ${recs.length} for ${src.kind === 'deck' ? 'Deck ' + (src.deck ? 'B' : 'A') : 'this song'} · click to inspect</span></h3>` + (recs.length ? `<div class="recs">${recs.map((m, i) => {
      const t = m.tempo, [mv, why] = keyMove(m), dE = m.energy - (s.energy || 0), col = m.score >= 90 ? '#37d67a' : m.score >= 75 ? '#9be15d' : m.score >= 60 ? '#ffd23f' : '#ff9a6a';
      return `<div class="rec ${hm.sel === m.path ? 'sel' : ''}" data-path="${esc(m.path)}"><div class="rk" style="--c:${col};--p:${Math.round(m.score)}"><b>${Math.round(m.score)}</b></div>
        <div class="rb"><div class="rt"><span class="rn">${i + 1}</span><b>${esc(m.title || base(m.path).replace(/\.[^.]+$/, ''))}</b><i>${esc(m.artist || '')}</i></div>
          <div class="rm"><span class="tag" style="border-color:${camelotColor(m.camelot)}">${keyHtml(m.camelot)} ${esc(mv)}</span><span class="tag">${m.bpm ? m.bpm.toFixed(0) + ' BPM' : '–'}${t.mode === 'unknown' ? '' : ' (' + (t.adjustPct >= 0 ? '+' : '') + t.adjustPct.toFixed(1) + '%)'}</span><span class="tag ${dE > 0 ? 'up' : dE < 0 ? 'dn' : ''}">E ${m.energy}${dE ? (dE > 0 ? ' ▲' : ' ▼') + Math.abs(dE) : ' ='}</span></div>
          <div class="rw">${esc(why)}${t.mode === 'direct' && Math.abs(t.adjustPct) < 2 ? ' · tempo already close' : t.withinLimit ? '' : ' · tempo gap beyond your pitch limit'}</div></div>
        <div class="ra"><button data-act="prev" title="Preview in headphones">▶</button><button data-act="a" title="Load to Deck A">A</button><button data-act="b" title="Load to Deck B">B</button><button data-act="set" title="Add to my set list">＋</button></div></div>`;
    }).join('')}</div>` : `<div class="dim">${hm.matches.length ? 'Only copies of this song match: analyse more tracks.' : 'Nothing to recommend yet: analyse more tracks or relax the filters below.'}</div>`);
  }
  function onNextClick(e) {
    const row = e.target.closest('.rec[data-path]'); if (!row) return;
    const m = hm.matches.find(x => x.path === row.dataset.path); if (!m) return;
    const b = e.target.closest('button[data-act]'); if (b) return act(b.dataset.act, m);
    hm.sel = m.path; renderTable(); renderAdvisor(); renderWheel();
  }
  /* waveform of the playing track with its structure: intro / main / outro, the cue points, the loop and the playhead (redrawn 4x a second) */
  function drawWf() {
    const c = $('#hmWf'), d = hm.wfDeck; if (!c || !d || !d.an || !d.dur) return;
    const DPRx = window.devicePixelRatio || 1, w = Math.round(c.clientWidth * DPRx), hgt = Math.round(c.clientHeight * DPRx); if (!w || !hgt) return;
    if (c.width !== w || c.height !== hgt) { c.width = w; c.height = hgt; }
    const g = c.getContext('2d'), an = d.an, f = d.feat || {}, H = hgt, mid = H * 0.5, X = t => t / d.dur * w;
    g.clearRect(0, 0, w, H);
    const intro = f.introEndS > 1 ? f.introEndS : 0, outro = f.outroStartS != null && f.outroStartS < d.dur - 1 ? f.outroStartS : d.dur;
    if (intro) { g.fillStyle = 'rgba(55,214,122,.10)'; g.fillRect(0, 0, X(intro), H); }
    if (outro < d.dur) { g.fillStyle = 'rgba(255,176,32,.12)'; g.fillRect(X(outro), 0, w - X(outro), H); }
    for (let x = 0; x < w; x++) {
      const b0 = Math.floor(x / w * an.n), b1 = Math.max(b0, Math.floor((x + 1) / w * an.n) - 1); let best = 0, bi = b0;
      for (let b = b0; b <= b1 && b < an.n; b++) if (an.amp[b] > best) { best = an.amp[b]; bi = b; }
      const o = bi * 3, hh = Math.max(1, best / 255 * mid * 0.8), done = x < X(d.pos());
      g.fillStyle = `rgba(${an.col[o]},${an.col[o + 1]},${an.col[o + 2]},${done ? 0.35 : 1})`; g.fillRect(x, mid - hh, 1, hh * 2);
    }
    g.font = `${Math.round(9 * DPRx)}px Segoe UI, sans-serif`; g.textBaseline = 'top';
    if (intro) { g.fillStyle = '#37d67a'; g.fillText('INTRO', 4, 2); } if (outro < d.dur) { g.fillStyle = '#ffb020'; { const tw = g.measureText('OUTRO · MIX POINT').width; if (X(outro) + tw + 8 > w) g.textAlign = 'right'; g.fillText('OUTRO · MIX POINT', g.textAlign === 'right' ? w - 4 : X(outro) + 4, 2); g.textAlign = 'left'; } g.fillRect(X(outro), 0, DPRx * 1.5, H); }
    if (d.loop) { g.fillStyle = 'rgba(77,163,255,.28)'; g.fillRect(X(d.loop.start), 0, X(d.loop.end) - X(d.loop.start), H); }
    (d.hot || []).forEach((t, n) => { if (t == null) return; g.fillStyle = PAD_COL[n]; g.fillRect(X(t), 0, DPRx * 1.5, H); g.fillText(String(n + 1), X(t) + 3, H - 12 * DPRx); });
    g.fillStyle = '#fff'; g.fillRect(X(d.pos()) - DPRx / 2, 0, DPRx * 1.5, H);
  }
  setInterval(() => { if (hm.view === 'hm') drawWf(); }, 250);

  /* ---------------------------------------------------------------- playlist analysis + graphs */
  function renderAnalysis() {
    const el = $('#hmStats'), s = hm.seq;
    if (!s) { el.innerHTML = `<div class="dim">${hm.seqScope === 'set' ? 'Your set list is empty: add tracks with ＋ in the table.' : 'The playlist is empty.'}</div>${setHtml()}`; return; }
    if (s.error) { el.innerHTML = `<div class="warn">${esc(s.error)}</div>`; return; }
    const missing = s.unanalysed.length, mean = s.meanTransition, sm = s.smoothShare;
    const genres = s.genres.map(([g, n]) => `<span class="chip">${esc(g)} <b>${n}</b></span>`).join('');
    el.innerHTML = `<div class="kv"><div><small>Tracks</small><b>${s.total}</b></div><div><small>Analysed</small><b>${s.analysed}</b></div><div><small>Total time</small><b>${fmtDur(s.durationS)}</b></div>
      <div><small>Average transition</small><b>${mean == null ? '–' : mean.toFixed(0) + '%'}</b></div><div><small>Smooth transitions</small><b>${sm == null ? '–' : Math.round(sm * 100) + '%'}</b></div><div><small>Problem transitions</small><b class="${s.problems.length ? 'warn' : ''}">${s.problems.length}</b></div></div>
      ${missing ? `<div class="warn">${missing} track(s) not analysed yet <button data-act="an-missing">Analyze missing</button></div>` : ''}
      <div class="chips">${genres || '<span class="dim">no genre tags</span>'}</div>
      <h4>Potential problem transitions</h4>
      <div class="problems">${s.problems.length ? s.problems.slice(0, 40).map(p => `<div class="prob" data-path="${esc(p.from)}"><b>${esc(base(p.from).replace(/\.[^.]+$/, ''))}</b> → <b>${esc(base(p.to).replace(/\.[^.]+$/, ''))}</b> <span class="sc">${Math.round(p.score)}%</span><div class="dim small">${p.reasons.map(esc).join('; ')}</div></div>`).join('') : '<div class="dim">None found. Every neighbouring pair of analysed tracks mixes within your limits.</div>'}${s.problems.length > 40 ? `<div class="dim small">…and ${s.problems.length - 40} more</div>` : ''}</div>
      ${setHtml()}`;
  }
  function setHtml() {
    if (hm.seqScope !== 'set' && !hm.set.length) return '';
    return `<h4>My set list (${hm.set.length}) <button data-act="set-clear" ${hm.set.length ? '' : 'disabled'}>Clear</button></h4><div class="setlist">${hm.set.map((t, i) => `<div class="setrow" data-i="${i}"><span>${i + 1}.</span><b>${esc(t.title)}</b><i>${esc(t.artist)}</i><span class="sact"><button data-act="set-up" title="Move up">↑</button><button data-act="set-down" title="Move down">↓</button><button data-act="set-a" title="Load to Deck A">A</button><button data-act="set-b" title="Load to Deck B">B</button><button data-act="set-del" title="Remove">✕</button></span></div>`).join('') || '<div class="dim">empty</div>'}</div>`;
  }
  function onStatsClick(e) {
    const prob = e.target.closest('.prob'); if (prob && !e.target.closest('button')) { focusInPlaylist(prob.dataset.path); return; }
    const b = e.target.closest('button[data-act]'); if (!b) return;
    const row = e.target.closest('.setrow'), i = row ? +row.dataset.i : -1;
    switch (b.dataset.act) {
      case 'an-missing': libScan(playlist.filter(p => p.path && p.anStatus !== 'done'), false); toast('Analysing the missing tracks…', 2500); break;
      case 'set-clear': hm.set = []; break;
      case 'set-del': hm.set.splice(i, 1); break;
      case 'set-up': if (i > 0) [hm.set[i - 1], hm.set[i]] = [hm.set[i], hm.set[i - 1]]; break;
      case 'set-down': if (i >= 0 && i < hm.set.length - 1) [hm.set[i + 1], hm.set[i]] = [hm.set[i], hm.set[i + 1]]; break;
      case 'set-a': loadToDeck(decks[0], itemFor(hm.set[i].path)); break;
      case 'set-b': loadToDeck(decks[1], itemFor(hm.set[i].path)); break;
    }
    save(); hm.seqSig = ''; hm.dirty = true;
  }
  function focusInPlaylist(path) {
    const i = playlist.findIndex(p => p.path === path); if (i < 0) return toast('That track is not in the playlist');
    setView('dj'); sel = i; setKeyFilter(''); document.getElementById('search').value = ''; filterText = ''; renderPlaylist();
    revealRow(document.querySelector('#tbl tbody tr.sel'), true);
  }
  function renderGraphs() {
    const s = hm.seq;
    if (!s || s.error || !s.series.length) { $('#hmEnergy').innerHTML = '<div class="dim">Nothing to show yet.</div>'; $('#hmBpm').innerHTML = ''; return; }
    const W = 360, H = 120, n = s.series.length, px = i => 28 + (n === 1 ? 0 : (W - 36) * i / (n - 1)), py = e => H - 18 - (H - 34) * (e - 1) / 9;
    let svg = `<svg viewBox="0 0 ${W} ${H}" id="hmEnergySvg" data-n="${n}">`;
    for (const e of [1, 5, 10]) svg += `<line x1="28" x2="${W - 8}" y1="${py(e)}" y2="${py(e)}" class="grid"/><text x="4" y="${py(e) + 3}" class="axis">${e}</text>`;
    const pts = s.series.map((t, i) => t.energy ? [px(i), py(t.energy), i] : null);
    // break the line at unanalysed tracks
    let run = []; const runs = []; for (const p of pts) { if (p) run.push(p); else { if (run.length) runs.push(run); run = []; } } if (run.length) runs.push(run);
    for (const r of runs) svg += `<polyline points="${r.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ')}" class="eline"/>`;
    for (const p of s.problems) { const a = pts[p.index], b = pts[p.index + 1]; if (a && b) svg += `<line x1="${a[0].toFixed(1)}" y1="${a[1].toFixed(1)}" x2="${b[0].toFixed(1)}" y2="${b[1].toFixed(1)}" class="eprob"/>`; }
    if (n <= 120) for (const p of pts) if (p) svg += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.4" class="edot"/>`;
    svg += `<text x="${W - 8}" y="${H - 3}" text-anchor="end" class="axis">track order →  (red = problem transition)</text></svg>`;
    $('#hmEnergy').innerHTML = svg;
    const bins = s.bpmBins, mx = Math.max(1, ...bins), BW = 360, BH = 100, bw = (BW - 20) / bins.length;
    let b = `<svg viewBox="0 0 ${BW} ${BH}" id="hmBpmSvg">`;
    bins.forEach((c, i) => { const h = (BH - 24) * c / mx; b += `<rect x="${(10 + i * bw).toFixed(1)}" y="${(BH - 14 - h).toFixed(1)}" width="${(bw - 1.5).toFixed(1)}" height="${h.toFixed(1)}" class="bbar"><title>${s.bpmBinStart + i * s.bpmBinWidth}–${s.bpmBinStart + (i + 1) * s.bpmBinWidth} BPM: ${c} track(s)</title></rect>`; if (i % 4 === 0) b += `<text x="${(10 + i * bw).toFixed(1)}" y="${BH - 2}" class="axis">${s.bpmBinStart + i * s.bpmBinWidth}</text>`; });
    $('#hmBpm').innerHTML = b + '</svg>';
  }
  function graphClick(e) {
    const svg = e.target.closest('svg'); if (!svg || !hm.seq) return;
    const r = svg.getBoundingClientRect(), n = hm.seq.series.length, x = (e.clientX - r.left) / r.width * 360, i = Math.round((x - 28) / (360 - 36) * (n - 1));
    const t = hm.seq.series[clamp(i, 0, n - 1)]; if (t) focusInPlaylist(t.path);
  }

  /* ---------------------------------------------------------------- views */
  function setView(v) {
    hm.view = v; window.__djHidden = v !== 'dj';
    $('#djview').hidden = v !== 'dj'; $('#hmview').hidden = v !== 'hm';
    document.querySelectorAll('#tabs .tab').forEach(b => b.classList.toggle('sel', b.dataset.view === v));
    if (v === 'hm') { if (!$('#hmTop')) build(); hm.dirty = true; hm.sig = ''; hm.seqSig = ''; tick(); }
  }
  document.querySelectorAll('#tabs .tab').forEach(b => b.addEventListener('click', () => setView(b.dataset.view)));
  setInterval(tick, 400);
  window.addEventListener('keydown', e => { if (e.altKey && e.key.toLowerCase() === 'h') { e.preventDefault(); setView(hm.view === 'hm' ? 'dj' : 'hm'); } });

  /* Pressing the centre of a jog wheel: open this workspace for that deck. The source is that deck's track (until you pick another source),
     and the list is the next song for that deck. */
  function openForDeck(i) {
    hm.pin = null; hm.sourceMode = String(i); hm.sel = null; hm.dirty = true; hm.sig = '';
    setView('hm');
    const el = $('#hmSrc'); if (el) el.value = String(i);
    const d = decks[i];
    if (!d.buf) toast('Load a track on Deck ' + (i ? 'B' : 'A') + ' first: Harmonic Match then finds the next song for it', 4500);
    save();
  }
  window.harmonic = { hm, openForDeck, setView, refresh, refreshSeq, engineSettings, engineFilter, engineScope, pickSource, preview, PRESETS, addToSet, act, setKey };
})();
