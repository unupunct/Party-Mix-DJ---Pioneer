// Playback must not suffer while the library is analysed in the background.
// Plays a steady tone through the real Party Mix (looped), then adds N synthetic tracks to the library and lets
// 4 analysis workers run flat out. Checks engine underruns, callback CPU, latency stability, continuity of the
// signal on Windows' own endpoint meter, that every track was analysed, that a second scan queues nothing, and that
// the source files are byte-identical afterwards.
//   node scripts/library-stress-test.js [tracks=90] [workers=4]
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), readline = require('readline'), crypto = require('crypto');

const N = +process.argv[2] || 90, WORKERS = +process.argv[3] || 4;
const exe = path.join(__dirname, '..', 'engine', 'target', 'release', 'djengine.exe');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'libstress-')), music = path.join(dir, 'music'); fs.mkdirSync(music);
const meterOut = path.join(dir, 'meter.txt');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
const check = (name, pass, detail = '') => { results.push(pass); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };

function wav(path_, sr, secs, fn) {
  const n = sr * secs, d = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) { const v = Math.max(-1, Math.min(1, fn(i / sr))) * 32000; d.writeInt16LE(v, i * 4); d.writeInt16LE(v, i * 4 + 2); }
  const h = Buffer.alloc(44); h.write('RIFF', 0); h.writeUInt32LE(36 + d.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(d.length, 40);
  fs.writeFileSync(path_, Buffer.concat([h, d]));
}
const sha = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');

(async () => {
  // ---- test material
  const tone = path.join(dir, 'steady-tone.wav'); wav(tone, 44100, 30, t => Math.sin(2 * Math.PI * 440 * t) * 0.5);
  const files = [];
  for (let i = 0; i < N; i++) {
    const f = path.join(music, `track${String(i).padStart(3, '0')}.wav`), bpm = 90 + (i % 40), root = 110 * Math.pow(2, (i % 12) / 12);
    wav(f, 22050, 12, t => { const bt = (t - 0.1) % (60 / bpm); const k = t > 0.1 ? Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-bt * 30)) * bt) * Math.exp(-bt * 9) * 0.6 : 0; return k + 0.15 * Math.sin(2 * Math.PI * root * t) + 0.1 * Math.sin(2 * Math.PI * root * 1.5 * t); });
    files.push(f);
  }
  const before = files.map(sha);
  console.log(`generated ${N} tracks (${(files.reduce((a, f) => a + fs.statSync(f).size, 0) / 1e6).toFixed(0)} MB) in ${dir}`);

  // ---- engine + meter
  const eng = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, DJ_LIBRARY: path.join(dir, 'library.db') } });
  const events = [], waiters = []; let state = null; const states = []; let progress = null;
  readline.createInterface({ input: eng.stdout }).on('line', l => {
    let e; try { e = JSON.parse(l); } catch { return; }
    if (e.evt === 'state') { state = e; states.push({ ...e, t: Date.now() }); return; }
    if (e.evt === 'libraryProgress') progress = e;
    const w = waiters.find(x => x.p(e)); if (w) { waiters.splice(waiters.indexOf(w), 1); w.r(e); } else events.push(e);
  });
  const send = o => eng.stdin.write(JSON.stringify(o) + '\n');
  const waitFor = (p, ms = 20000) => { const i = events.findIndex(p); if (i >= 0) return Promise.resolve(events.splice(i, 1)[0]); return new Promise((r, j) => { const w = { p, r }; waiters.push(w); setTimeout(() => { const k = waiters.indexOf(w); if (k >= 0) { waiters.splice(k, 1); j(new Error('timeout')); } }, ms); }); };

  await waitFor(e => e.evt === 'ready');
  const lr = await waitFor(e => e.evt === 'libraryReady' || e.evt === 'libraryError');
  check('library database opened by the engine', lr.evt === 'libraryReady', lr.evt === 'libraryReady' ? `schema ${lr.schema}` : lr.message);
  send({ cmd: 'devices' }); const devs = (await waitFor(e => e.evt === 'devices')).devices;
  const pm = devs.find(d => /party\s*mix/i.test(d.name));
  if (!pm) { console.log('Party Mix not found'); eng.kill(); process.exit(2); }

  const meter = spawn('pwsh', ['-NoProfile', '-Command', `& '${path.join(__dirname, 'endpoint-meter.ps1')}' -Names 'Party Mix' -Seconds 120 -OutFile '${meterOut}' -IntervalMs 25`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r, j) => { meter.stdout.on('data', d => { if (String(d).includes('METER_READY')) r(); }); setTimeout(() => j(new Error('meter timeout')), 25000); });

  send({ cmd: 'open', master: pm.id, cue: { mode: 'same4' }, sampleRate: 44100 });
  await waitFor(e => e.evt === 'audio');
  send({ cmd: 'load', deck: 0, path: tone, id: 1 }); await waitFor(e => e.evt === 'loaded');
  for (const [n, v] of [['master', 1], ['xf', 0], ['d0.vol', 1], ['d0.trim', 1]]) send({ cmd: 'param', name: n, value: v });
  send({ cmd: 'seek', deck: 0, pos: 2 }); send({ cmd: 'loop', deck: 0, start: 2, end: 20, on: true }); send({ cmd: 'play', deck: 0 });
  await sleep(3000);
  const base = { x0: state.xruns, lat: state.latencyMs }; const tBase = Date.now();

  // ---- background analysis at full tilt
  send({ cmd: 'libraryConfig', workers: WORKERS, cpuLimit: 100 });
  const t0 = Date.now();
  send({ cmd: 'libraryScan', id: 1, items: files.map((p, i) => ({ path: p, artist: 'Stress', title: 'Track ' + i })) });
  const sc = await waitFor(e => e.evt === 'libraryScanned');
  check('library scan registered every file', sc.added === N && sc.queued === N, JSON.stringify({ added: sc.added, queued: sc.queued }));
  let sawRunning = 0;
  for (let i = 0; i < 600; i++) { await sleep(250); if (progress) sawRunning = Math.max(sawRunning, progress.running); if (progress && progress.pending === 0 && progress.running === 0 && progress.done + progress.errors >= N) break; }
  const tDone = Date.now(), secs = (tDone - t0) / 1000;
  await sleep(1500);
  console.log(`      analysed ${progress.done}/${N} tracks in ${secs.toFixed(1)} s (${(N / secs).toFixed(1)} tracks/s), up to ${sawRunning} workers running`);
  check('every track analysed', progress.done === N && progress.errors === 0, `done ${progress.done}, errors ${progress.errors}`);

  // ---- playback health during analysis
  const during = states.filter(s => s.t >= t0 && s.t <= tDone);
  check('engine state samples were collected during the analysis', during.length > 100, `${during.length} samples`);
  const maxCpu = Math.max(...during.map(s => s.cpu)), lats = during.map(s => s.latencyMs).filter(x => x > 0);
  const xr = state.xruns - base.x0;
  console.log(`      during analysis: callback CPU max ${(maxCpu * 100).toFixed(1)} %, latency ${Math.min(...lats).toFixed(1)}–${Math.max(...lats).toFixed(1)} ms, underruns ${xr}`);
  check('no audio underruns while analysing', xr === 0, `${xr} xruns`);
  check('audio callback stays far below its deadline', maxCpu < 0.5, `${(maxCpu * 100).toFixed(1)} % max`);
  check('output latency stays stable', Math.max(...lats) - Math.min(...lats) < 10, `${(Math.max(...lats) - Math.min(...lats)).toFixed(1)} ms spread`);
  check(`${WORKERS} analysis workers ran in parallel`, sawRunning >= Math.min(WORKERS, 2), `max running ${sawRunning}`);

  // ---- second scan is a no-op, stats consistent
  send({ cmd: 'libraryScan', id: 2, items: files.map(p => ({ path: p })) });
  const sc2 = await waitFor(e => e.evt === 'libraryScanned');
  check('second scan queues nothing (no re-analysis of unchanged files)', sc2.queued === 0 && sc2.unchanged === N, JSON.stringify({ queued: sc2.queued, unchanged: sc2.unchanged }));
  send({ cmd: 'libraryStats' }); const st = (await waitFor(e => e.evt === 'libraryStats')).stats;
  check('database reports all tracks analysed', st.analyzed === N && st.errors === 0 && st.tracks === N, JSON.stringify(st));
  send({ cmd: 'libraryRows', id: 3, sort: 'bpm', limit: 5, filter: { bpmMin: 100, bpmMax: 104 } }); const pg = await waitFor(e => e.evt === 'libraryPage');
  check('indexed query returns analysed rows', pg.rows.length > 0 && pg.rows.every(r => r.bpm >= 100 && r.bpm <= 104 && r.camelot), `${pg.rows.length} rows, first ${pg.rows[0] && pg.rows[0].bpm.toFixed(1)} BPM ${pg.rows[0] && pg.rows[0].camelot}`);

  eng.stdin.write('{"cmd":"pause","deck":0}\n'); await sleep(300); eng.stdin.write('{"cmd":"quit"}\n');
  await new Promise(r => meter.on('exit', r));

  // ---- Windows' own meter: was the signal continuous during the analysis?
  const rows = fs.readFileSync(meterOut, 'utf8').trim().split('\n').map(l => { const f = l.split(' '); return { t: +f[0], ch: f[1].split('=')[1].split('/').map(Number) }; });
  const win = rows.filter(r => r.t >= t0 + 500 && r.t <= tDone);
  const quiet = win.filter(r => Math.max(r.ch[0], r.ch[1]) < 0.15).length;
  const ch34 = Math.max(...win.map(r => Math.max(r.ch[2], r.ch[3])));
  console.log(`      endpoint meter: ${win.length} samples during analysis, ${quiet} below the tone level, ch3/4 peak ${ch34.toFixed(2)}`);
  check('Windows output meter shows an unbroken tone during analysis', win.length > 100 && quiet <= 2, `${quiet} of ${win.length} samples dropped`);

  // ---- originals untouched
  const after = files.map(sha);
  check('source music files are byte-identical afterwards', before.every((h, i) => h === after[i]));
  check('no extra files appeared next to the music', fs.readdirSync(music).length === N, `${fs.readdirSync(music).length} files`);

  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  const bad = results.filter(x => !x).length;
  console.log(`\n${results.length - bad}/${results.length} checks passed`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.error('TEST ERROR', e); process.exit(1); });
