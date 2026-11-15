// Hardware routing test for djengine.exe: drives the engine like the app does and measures what Windows' own
// endpoint meters receive. Needs the Party Mix connected (and optionally a second output, e.g. Realtek).
//   node scripts/engine-hw-test.js <test.wav> [secondOutputNameFragment=Realtek]
const { spawn } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path'), readline = require('readline');

const wav = process.argv[2], second = process.argv[3] || 'Realtek';
if (!wav || !fs.existsSync(wav)) { console.error('usage: node engine-hw-test.js <test.wav> [second-output]'); process.exit(2); }
const exe = path.join(__dirname, '..', 'engine', 'target', 'release', 'djengine.exe');
const out = path.join(os.tmpdir(), 'engine-meter.txt'); try { fs.unlinkSync(out); } catch {}
const results = []; const sleep = ms => new Promise(r => setTimeout(r, ms));
const check = (name, pass, detail = '') => { results.push({ name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };

(async () => {
  const eng = spawn(exe, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const waiters = []; const events = []; let lastState = null;
  readline.createInterface({ input: eng.stdout }).on('line', l => {
    let e; try { e = JSON.parse(l); } catch { return; }
    if (e.evt === 'state') { lastState = e; return; }
    const w = waiters.find(x => x.pred(e));
    if (w) { waiters.splice(waiters.indexOf(w), 1); w.res(e); } else events.push(e);
  });
  const send = o => eng.stdin.write(JSON.stringify(o) + '\n');
  // each wait consumes the event it matches, so a later wait can never be satisfied by a stale event
  const waitFor = (pred, ms = 8000) => { const i = events.findIndex(pred); if (i >= 0) return Promise.resolve(events.splice(i, 1)[0]); return new Promise((res, rej) => { const w = { pred, res }; waiters.push(w); setTimeout(() => { const j = waiters.indexOf(w); if (j >= 0) { waiters.splice(j, 1); rej(new Error('timeout')); } }, ms); }); };

  await waitFor(e => e.evt === 'ready'); check('engine starts and reports ready', true);
  send({ cmd: 'devices' }); const devs = (await waitFor(e => e.evt === 'devices')).devices;
  const pm = devs.find(d => /party\s*mix/i.test(d.name)), other = devs.find(d => d.name.toLowerCase().includes(second.toLowerCase()) && !/party\s*mix/i.test(d.name));
  check('Party Mix found as a 4-channel device', pm && pm.maxChannels >= 4, pm ? `${pm.name}, ${pm.maxChannels} ch, rates ${pm.rates}` : 'missing');
  if (!pm) { eng.kill(); process.exit(1); }

  const meterArgs = ['-NoProfile', '-File', path.join(__dirname, 'endpoint-meter.ps1'), '-Names', 'Party Mix' + (other ? `,${second}` : ''), '-Seconds', '60', '-OutFile', out];
  const names = ['Party Mix'].concat(other ? [second] : []);
  const meter = spawn('pwsh', ['-NoProfile', '-Command', `& '${meterArgs[2]}' -Names ${names.map(n => `'${n}'`).join(',')} -Seconds 60 -OutFile '${out}'`], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res, rej) => { meter.stdout.on('data', d => { if (String(d).includes('METER_READY')) res(); }); meter.on('exit', c => rej(new Error('meter exited ' + c))); setTimeout(() => rej(new Error('meter timeout')), 20000); });

  const open = async (settings) => { send({ cmd: 'open', ...settings }); return waitFor(e => e.evt === 'audio' || e.evt === 'audioError'); };
  const win = async (label, ms, setup) => { await setup(); const s = Date.now(); send({ cmd: 'seek', deck: 0, pos: 10 }); send({ cmd: 'play', deck: 0 }); await sleep(ms); const e = Date.now(); send({ cmd: 'pause', deck: 0 }); await sleep(600); return { label, s: s + 600, e }; };
  const windows = [];

  // load a track
  send({ cmd: 'load', deck: 0, path: wav, id: 1 }); const loaded = await waitFor(e => e.evt === 'loaded' || e.evt === 'loadError', 20000);
  check('track decoded + analysed off-thread', loaded.evt === 'loaded' && Math.abs(loaded.bpm - 120) < 0.6, loaded.evt === 'loaded' ? `bpm ${loaded.bpm}, ${loaded.duration.toFixed(1)} s` : loaded.message);
  send({ cmd: 'load', deck: 1, path: path.join(__dirname, 'nonexistent.mp3'), id: 2 });
  const bad = await waitFor(e => e.evt === 'loadError' && e.id === 2); check('missing file reports a clean error', !!bad.message, bad.message);

  // ---- A/B: single device, master on ch1/2, cue on ch3/4
  let r = await open({ master: pm.id, cue: { mode: 'same4' }, sampleRate: 44100 });
  check('open Party Mix with cue on channels 3/4', r.evt === 'audio', r.evt === 'audio' ? `${r.status.channels} ch @ ${r.status.sampleRate}` : r.message);
  const P = (n, v) => send({ cmd: 'param', name: n, value: v });
  P('master', 1); P('xf', 0); P('headGain', 1); P('headMix', 0); P('d0.trim', 1);
  windows.push(await win('A: master only (vol 1, PFL off)', 2500, async () => { P('d0.vol', 1); P('d0.pfl', 0); await sleep(300); }));
  windows.push(await win('B: cue only (vol 0, PFL on)', 2500, async () => { P('d0.vol', 0); P('d0.pfl', 1); await sleep(300); }));

  // ---- C: cue on a second device
  if (other) {
    r = await open({ master: pm.id, cue: { mode: 'device', device: other.id }, sampleRate: 44100 });
    check('open with cue on a second output device', r.evt === 'audio' && r.status.cue === 'device' && r.status.cueName.length > 0, r.evt === 'audio' ? `cue → ${r.status.cueName}` : r.message);
    windows.push(await win('C: cue on 2nd device (vol 0, PFL on)', 3000, async () => { P('d0.vol', 0); P('d0.pfl', 1); await sleep(300); }));
    send({ cmd: 'param', name: 'headMix', value: 0 });
  }

  // ---- D: device loss + automatic recovery
  r = await open({ master: pm.id, cue: { mode: 'same4' }, sampleRate: 44100 });
  check('reopen on Party Mix channels 3/4 before the loss test', r.evt === 'audio' && r.status.cue === 'same4' && !r.reconnected);
  P('d0.vol', 1); P('d0.pfl', 0); await sleep(300);
  send({ cmd: 'seek', deck: 0, pos: 10 }); send({ cmd: 'play', deck: 0 }); await sleep(600);
  const tLoss = Date.now(); send({ cmd: 'simulateLoss' });
  const lost = await waitFor(e => e.evt === 'audioLost', 4000).catch(() => null);
  check('device loss detected', !!lost);
  const back = await waitFor(e => e.evt === 'audio' && e.reconnected, 8000).catch(() => null);
  check('stream reopened automatically after loss', !!back, back ? `${Date.now() - tLoss} ms` : 'no reconnect');
  const sD = Date.now(); await sleep(2500); windows.push({ label: 'D: after automatic reconnect (vol 1)', s: sD + 600, e: Date.now() });
  const st = lastState;
  send({ cmd: 'pause', deck: 0 }); await sleep(300);

  // ---- engine health numbers
  check('no output underruns (xruns)', st && st.xruns === 0, st && `xruns ${st.xruns}`);
  check('CPU load of audio callback < 25 %', st && st.cpu < 0.25, st && `${(st.cpu * 100).toFixed(1)} %`);
  console.log(`      latency ${st && st.latencyMs.toFixed(1)} ms, buffer ${st && st.bufferFrames} frames, clips ${st && st.clips}`);

  eng.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n');
  await new Promise(res => meter.on('exit', res)); // meter finishes its 60 s window

  // ---- evaluate meters
  const rows = fs.readFileSync(out, 'utf8').trim().split('\n').map(l => { const f = l.split(' '); const o = { t: +f[0] }; for (const c of f.slice(1)) { const [k, v] = c.split('='); o[k] = v.split('/').map(Number); } return o; });
  const peak = (w, dev, chs) => Math.max(0, ...rows.filter(x => x.t >= w.s && x.t <= w.e).map(x => Math.max(...chs.map(c => (x[dev] || [])[c] || 0))));
  const W = Object.fromEntries(windows.map(w => [w.label[0], w]));
  const pmKey = 'Party_Mix', otherKey = second.replace(' ', '_');
  const A = { f: peak(W.A, pmKey, [0, 1]), c: peak(W.A, pmKey, [2, 3]) }, B = { f: peak(W.B, pmKey, [0, 1]), c: peak(W.B, pmKey, [2, 3]) };
  console.log(`      A  Party Mix ch1/2 ${A.f.toFixed(2)}  ch3/4 ${A.c.toFixed(2)}\n      B  Party Mix ch1/2 ${B.f.toFixed(2)}  ch3/4 ${B.c.toFixed(2)}`);
  check('master reaches Party Mix channels 1/2 only', A.f > 0.2 && A.c < 0.02);
  check('headphone cue reaches Party Mix channels 3/4 only', B.c > 0.2 && B.f < 0.02);
  if (W.C) {
    const Cp = { f: peak(W.C, pmKey, [0, 1, 2, 3]), o: peak(W.C, otherKey, [0, 1]) };
    console.log(`      C  Party Mix any ${Cp.f.toFixed(2)}  ${second} ${Cp.o.toFixed(2)}`);
    check(`cue on second device reaches ${second} only`, Cp.o > 0.2 && Cp.f < 0.02);
  }
  const D = { f: peak(W.D, pmKey, [0, 1]), c: peak(W.D, pmKey, [2, 3]) };
  console.log(`      D  Party Mix ch1/2 ${D.f.toFixed(2)}  ch3/4 ${D.c.toFixed(2)}`);
  check('audio flows again after reconnect', D.f > 0.2 && D.c < 0.02);

  const failed = results.filter(x => !x.pass).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('TEST ERROR', e); process.exit(1); });
