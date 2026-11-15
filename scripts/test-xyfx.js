'use strict';
/* Unit tests of the XY pad core (coordinates, neutral zone, blending weights, parameter mapping, interaction state machine). Run: node scripts/test-xyfx.js */
const assert = require('assert');
const X = require('../public/xyfx.js');
let n = 0; const t = (name, fn) => { try { fn(); n++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };
const near = (a, b, e = 1e-9, m = '') => assert(Math.abs(a - b) <= e, `${m} ${a} vs ${b}`);
const cfg = X.sanitize({});

t('coordinates: left/top = 0, right/bottom = 1, centre = 0.5, any size or aspect ratio', () => {
  for (const r of [{ left: 10, top: 20, width: 300, height: 300 }, { left: 0, top: 0, width: 640, height: 360 }, { left: -50, top: 5, width: 77, height: 913 }]) {
    const c = X.normalize(r.left + r.width / 2, r.top + r.height / 2, r); near(c.x, 0.5); near(c.y, 0.5);
    const tl = X.normalize(r.left, r.top, r); near(tl.x, 0); near(tl.y, 0); const br = X.normalize(r.left + r.width, r.top + r.height, r); near(br.x, 1); near(br.y, 1);
  }
  const o = X.normalize(-999, 99999, { left: 0, top: 0, width: 100, height: 100 }); assert.deepStrictEqual(o, { x: 0, y: 1 }, 'outside the pad is clamped');
  assert.deepStrictEqual(X.normalize(5, 5, { left: 0, top: 0, width: 0, height: 0 }), { x: 0.5, y: 0.5 }, 'a collapsed pad gives the centre');
});
t('neutral zone: nothing inside the neutral radius, full effect beyond the activation radius, no step in between', () => {
  assert(X.inNeutral(0.5, 0.5, cfg)); assert(X.inNeutral(0.5 + cfg.neutral - 0.01, 0.5, cfg)); assert(!X.inNeutral(0.5 + cfg.neutral + 0.01, 0.5, cfg));
  near(X.activation(0.5, 0.5, cfg), 0); near(X.activation(0.5 + cfg.neutral, 0.5, cfg), 0); near(X.activation(0.5 + cfg.activation, 0.5, cfg), 1); near(X.activation(0.95, 0.95, cfg), 1);
  let prev = 0; for (let d = 0; d <= 0.5; d += 0.001) { const a = X.activation(0.5 + d, 0.5, cfg); assert(a >= prev - 1e-12, 'monotonic'); assert(a - prev < 0.02, 'smooth: ' + (a - prev)); prev = a; }
  const mid = X.activation(0.5 + (cfg.neutral + cfg.activation) / 2, 0.5, cfg); assert(mid > 0.4 && mid < 0.6, 'smoothstep midpoint ' + mid);
});
t('blending weights are bilinear, sum to 1 everywhere, and each corner belongs to its own effect', () => {
  for (let x = 0; x <= 1; x += 0.05) for (let y = 0; y <= 1; y += 0.05) { const w = X.zoneWeights(x, y); near(w[0] + w[1] + w[2] + w[3], 1, 1e-9); near(w[0], (1 - x) * (1 - y)); near(w[1], x * (1 - y)); near(w[2], (1 - x) * y); near(w[3], x * y); }
  assert.deepStrictEqual(X.zoneWeights(0, 0).map(v => +v.toFixed(6)), [1, 0, 0, 0]); assert.deepStrictEqual(X.zoneWeights(1, 0).map(v => +v.toFixed(6)), [0, 1, 0, 0]);
  assert.deepStrictEqual(X.zoneWeights(0, 1).map(v => +v.toFixed(6)), [0, 0, 1, 0]); assert.deepStrictEqual(X.zoneWeights(1, 1).map(v => +v.toFixed(6)), [0, 0, 0, 1]);
  near(X.zoneWeights(0.3, 0.7, 2).reduce((a, b) => a + b), 1, 1e-9, 'sharpness keeps the sum at 1');
});
t('mix: top-left = FILTER, top-right = ECHO, bottom-left = REVERB, bottom-right = FLANGER; centre = nothing', () => {
  const at = (x, y) => X.mix(x, y, cfg, 120);
  const dom = m => m.effects.indexOf(Math.max(...m.effects));
  assert.strictEqual(dom(at(0.05, 0.05)), 0); assert.strictEqual(dom(at(0.95, 0.05)), 1); assert.strictEqual(dom(at(0.05, 0.95)), 2); assert.strictEqual(dom(at(0.95, 0.95)), 3);
  const c = at(0.5, 0.5); near(c.act, 0); assert(c.effects.every(v => v === 0), 'no effect at the centre');
  const m = at(0.7, 0.3); near(m.w.reduce((a, b) => a + b), 1, 1e-9); assert(m.effects.reduce((a, b) => a + b) <= 1 + 1e-9, 'total effect weight never exceeds 1');
});
t('parameter mapping and ranges', () => {
  const R = cfg.ranges;
  const f0 = X.params('filter', 0, 0.5, 0.5, cfg, 120), f1 = X.params('filter', 0, 0, 0, cfg, 120);
  near(f0[0], R.cutoff[1], 1e-6); near(f0[1], 0); near(f1[0], R.cutoff[0], 1e-6); near(f1[1], R.resMax);                      // log sweep 20 kHz -> 50 Hz, resonance 0 -> 95 %
  const q = [0.1, 0.2, 0.3, 0.4].map(x => X.params('filter', 0, x, 0.5, cfg, 120)[0]); assert(q[0] < q[1] && q[1] < q[2] && q[2] < q[3], 'cutoff rises towards the centre');
  near(Math.log(q[1] / q[0]), Math.log(q[2] / q[1]), 1e-9, 'cutoff is logarithmic (equal steps = equal ratios)'); near(Math.log(q[3] / q[2]), Math.log(q[2] / q[1]), 1e-9);
  const e0 = X.params('echo', 1, 0.5, 0.5, cfg, 120), e1 = X.params('echo', 1, 1, 0, cfg, 120);
  near(e0[0], (1 / 32) * 60 / 120, 1e-9); near(e1[0], 2 * 60 / 120, 1e-9); near(e1[1], 0.92);                                  // 1/32 beat .. 1 beat at 120 BPM, feedback 0..85 %
  near(X.params('echo', 1, 1, 0, cfg, 90)[0], 120 / 90, 1e-9); near(X.params('echo', 1, 1, 0, X.sanitize({ bpmSync: false }), 90)[0], 1, 1e-9);
  assert(X.params('echo', 1, 0.8, 0.5, X.sanitize({ snapEcho: true }), 120).every(Number.isFinite));
  near(X.params('reverb', 2, 0, 1, cfg, 120)[0], 1); near(X.params('reverb', 2, 0, 1, cfg, 120)[1], 1); near(X.params('reverb', 2, 0.5, 0.5, cfg, 120)[0], 0);
  const l0 = X.params('flanger', 3, 0.5, 0.5, cfg, 120), l1 = X.params('flanger', 3, 1, 1, cfg, 120); near(l0[0], 0.05, 1e-9); near(l1[0], 14, 1e-9); near(l1[1], 1);
  for (let x = 0; x <= 1; x += 0.1) for (let y = 0; y <= 1; y += 0.1) { const m = X.mix(x, y, cfg, 128); assert(m.p.every(Number.isFinite), 'finite'); assert(m.p[0] >= 50 - 1e-6 && m.p[0] <= 20000 + 1e-6); assert(m.p[1] <= 0.95 + 1e-9 && m.p[3] <= 0.92 + 1e-9 && m.p[2] > 0 && m.p[2] <= 1.9); }
});
t('custom assignment: the zones take the chosen effects, duplicates merge their weights', () => {
  const c = X.sanitize({ assign: ['flanger', 'reverb', 'echo', 'filter'] }); const m = X.mix(0.02, 0.02, c, 120); assert(m.w[3] > 0.9 && m.effects[3] > 0.9, 'top-left is now the flanger');
  const d = X.sanitize({ assign: ['filter', 'filter', 'echo', 'echo'] }); const zw = X.zoneWeights(0.3, 0.1, d.sharpness), dm = X.mix(0.3, 0.1, d, 120); near(dm.w[0], zw[0] + zw[1], 1e-9, 'duplicate zones merge'); near(dm.w[1], zw[2] + zw[3], 1e-9); near(dm.w[0] + dm.w[1], 1, 1e-9); assert.strictEqual(dm.w[2] + dm.w[3], 0);
  assert.deepStrictEqual(X.sanitize({ assign: ['filter', 'nope', 'echo', 'echo'] }).assign, X.DEFAULTS.assign, 'invalid assignments fall back to the default');
});
t('configuration is sanitised and clamped (damaged saved data cannot break the pad)', () => {
  const c = X.sanitize({ neutral: 9, activation: -1, sensitivity: 50, sharpness: 'x', ranges: { cutoff: [5, 99999], delay: 'bad', resMax: 7 }, bpmSync: false });
  assert(c.neutral <= 0.45 && c.activation > c.neutral && c.sensitivity === 2 && c.sharpness === X.DEFAULTS.sharpness && c.ranges.cutoff[0] === 20 && c.ranges.cutoff[1] === 20000 && c.ranges.resMax === 0.98 && c.bpmSync === false);
  assert.deepStrictEqual(X.sanitize(null), X.sanitize(undefined)); assert.deepStrictEqual(X.sanitize({}), X.DEFAULTS);
  const m = X.mix(0.9, 0.1, X.sanitize({ sensitivity: 2 }), 120); assert(m.act >= 0 && m.act <= 1);
  near(X.applySensitivity(0.6, 0.4, 2).x, 0.7); near(X.applySensitivity(1, 0, 2).x, 1);
});
t('interaction: pointerdown activates, move updates, release is immediate (act 0), other pointers are ignored', () => {
  const sent = []; const pad = new X.Pad({}, m => sent.push(m), { getBpm: () => 126 });
  assert.strictEqual(pad.state, 'idle'); assert(pad.down(1, 0.1, 0.1)); assert.strictEqual(pad.state, 'active'); assert(sent.at(-1).act > 0.9 && sent.at(-1).w[0] > 0.8);
  assert(!pad.down(2, 0.9, 0.9), 'a second finger does not take over'); assert(!pad.move(2, 0.9, 0.9)); assert(!pad.up(2));
  pad.move(1, 0.9, 0.1); assert(sent.at(-1).w[1] > 0.8); pad.move(1, 0.5, 0.5); near(sent.at(-1).act, 0);
  const before = sent.length; assert(pad.up(1)); assert.strictEqual(pad.state, 'idle'); assert.strictEqual(sent.length, before + 1); const last = sent.at(-1); assert.strictEqual(last.act, 0); assert.deepStrictEqual(last.w, [0, 0, 0, 0]);
  near(pad.x, 0.5); near(pad.y, 0.5); assert(!pad.up(1), 'a second release does nothing'); assert.strictEqual(sent.length, before + 1);
});
t('interaction: cancel, lost capture and forced release always end in IDLE with the effects off; no stuck state', () => {
  for (const how of ['cancel', 'release', 'up']) { const sent = []; const pad = new X.Pad({}, m => sent.push(m)); pad.down(7, 0.95, 0.95); assert(sent.at(-1).act > 0); pad[how](how === 'release' ? undefined : 7); assert.strictEqual(pad.state, 'idle'); assert.strictEqual(sent.at(-1).act, 0, how); }
  const sent = []; const pad = new X.Pad({}, m => sent.push(m)); pad.release(); assert.strictEqual(sent.length, 0, 'releasing an idle pad sends nothing');
  pad.down(1, 0.2, 0.8); pad.release(); assert(pad.down(3, 0.8, 0.8), 'a new press works after a release');
  const states = []; const p2 = new X.Pad({}, () => {}, { onState: s => states.push(s ? 'on' : 'off') }); p2.down(1, 0.1, 0.1); p2.move(1, 0.2, 0.2); p2.cancel(1); assert.deepStrictEqual(states, ['on', 'on', 'off']);
});
t('changing the configuration while pressed keeps the pad consistent', () => {
  const sent = []; const pad = new X.Pad({}, m => sent.push(m)); pad.down(1, 0.05, 0.05); const a = sent.at(-1).p[0]; pad.setConfig({ ranges: { cutoff: [500, 5000] } }); assert(sent.at(-1).p[0] > a, 'new range applied'); pad.up(1);
});
t('filter type: low-pass / high-pass / band-pass / notch are selectable, saved safely and sent to the engine', () => {
  assert.strictEqual(X.sanitize({}).filterType, 'lp'); assert.strictEqual(X.sanitize({ filterType: 'nope' }).filterType, 'lp'); for (const f of ['lp', 'hp', 'bp', 'notch']) assert.strictEqual(X.sanitize({ filterType: f }).filterType, f);
  const lp = X.sanitize({}), hp = X.sanitize({ filterType: 'hp' }), R = lp.ranges;
  near(X.params('filter', 0, 0.5, 0.5, lp, 120)[0], R.cutoff[1], 1e-6); near(X.params('filter', 0, 0, 0, lp, 120)[0], R.cutoff[0], 1e-6, 'low-pass closes outward');
  near(X.params('filter', 0, 0.5, 0.5, hp, 120)[0], R.cutoff[0], 1e-6); near(X.params('filter', 0, 0, 0, hp, 120)[0], R.cutoff[1], 1e-6, 'high-pass climbs outward');
  assert.deepStrictEqual(['lp', 'hp', 'bp', 'notch'].map(f => X.mix(0.1, 0.1, X.sanitize({ filterType: f }), 120).ft), [0, 1, 2, 3]);
  const sent = []; const pad = new X.Pad({ filterType: 'bp' }, m => sent.push(m)); pad.down(1, 0.1, 0.1); pad.up(1); assert(sent.every(m => m.ft === 2), 'every message carries the filter type, release included');
});
t('28 effects: seven per family, each zone can run any of them, saved safely and sent to the engine', () => {
  assert.deepStrictEqual(Object.values(X.VARIANTS).map(v => v.length), [7, 7, 7, 7]); assert.strictEqual(Object.values(X.VARIANTS).flat().length, 28); for (const l of Object.values(X.VARIANTS).flat()) assert(X.VARIANT_LABEL[l], 'label for ' + l);
  const d = X.sanitize({}); assert.deepStrictEqual(d.variants, { echo: 'echo', reverb: 'room', flanger: 'flanger' }); assert.deepStrictEqual(X.variantIdx(d), [0, 0, 0, 0]);
  const c = X.sanitize({ filterType: 'vowel', variants: { echo: 'reverse', reverb: 'gated', flanger: 'ring' } }); assert.deepStrictEqual(X.variantIdx(c), [5, 5, 4, 6]);
  const bad = X.sanitize({ filterType: 'x', variants: { echo: 'room', reverb: 5, flanger: null } }); assert.deepStrictEqual(X.variantIdx(bad), [0, 0, 0, 0], 'unknown values fall back to the first effect of the family');
  assert.deepStrictEqual(X.mix(0.1, 0.1, c, 120).var, [5, 5, 4, 6]);
  const sent = []; const pad = new X.Pad(c, m => sent.push(m)); pad.down(1, 0.9, 0.9); pad.up(1); assert(sent.every(m => Array.isArray(m.var) && m.var.join() === '5,5,4,6'), 'every message (release included) carries the four effects');
  assert(X.params('echo', 1, 1, 0, X.sanitize({ variants: { echo: 'pingpong' } }), 120).every(Number.isFinite), 'echo variants share the echo parameters');
});
console.log(`\n${n} XY core tests passed` + (process.exitCode ? ' (with failures)' : ''));
