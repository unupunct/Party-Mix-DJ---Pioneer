'use strict';
/* Unit tests of the loop / slicer calculations. Run: node scripts/test-loopcalc.js */
const assert = require('assert');
const L = require('../public/loopcalc.js');
let n = 0; const t = (name, fn) => { try { fn(); n++; console.log('  ok  ' + name); } catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; } };
const near = (a, b, e = 1e-9, m = '') => assert(Math.abs(a - b) <= e, `${m} ${a} vs ${b}`);
const o = { bpm: 120, grid: 0.25, dur: 200, quantize: true };   // beat = 0.5 s, beats at 0.25, 0.75, 1.25 ...

t('every loop size gives exactly that many beats, starting on the grid', () => {
  for (const b of L.SIZES) { const l = L.autoLoop(10.3, b, o); near(L.lengthBeats(l, 120), b, 1e-9, 'size ' + b); const unit = Math.min(b, 1) * 0.5; near(((l.start - o.grid) / unit) % 1 < 1e-6 || ((l.start - o.grid) / unit) % 1 > 1 - 1e-6 ? 0 : 1, 0, 0, 'on the grid ' + b); }
  assert.deepStrictEqual(L.SIZES, [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32]); assert.strictEqual(L.SIZE_LABEL(1 / 8), '1/8'); assert.strictEqual(L.SIZE_LABEL(4), '4');
});
t('loop length follows the BPM (a 4 beat loop is 2 s at 120 BPM and 1.6 s at 150 BPM)', () => { near(L.autoLoop(3, 4, { ...o, bpm: 120 }).end - L.autoLoop(3, 4, { ...o, bpm: 120 }).start, 2); near(L.autoLoop(3, 4, { ...o, bpm: 150 }).end - L.autoLoop(3, 4, { ...o, bpm: 150 }).start, 1.6); });
t('quantisation: on = snapped to the grid, off = exactly at the playhead', () => {
  near(L.autoLoop(10.3, 1, o).start, 10.25); near(L.autoLoop(10.6, 1, o).start, 10.75); near(L.autoLoop(10.3, 4, { ...o, quantize: false }).start, 10.3);
  near(L.autoLoop(10.3, 1 / 4, o).start, 10.25); near(L.snap(10.38, 120, 0.25, 0.25), 10.375, 1e-9);
  near(L.loopIn(10.3, o), 10.25); near(L.loopIn(10.3, { ...o, quantize: false }), 10.3);
});
t('loop in / loop out', () => {
  const s = L.loopIn(10.3, o), l = L.loopOut(s, 12.6, o); near(l.start, 10.25); near(l.end, 12.75);
  const bad = L.loopOut(10.25, 9, o); assert(bad.end > bad.start, 'an out before the in is corrected'); near(bad.end, 10.75);
  const free = L.loopOut(10.3, 10.9, { ...o, quantize: false }); near(free.start, 10.3); near(free.end, 10.9);
});
t('loop move: by one loop length, back and forth, never outside the track', () => {
  const l = { start: 10, end: 12 }; assert.deepStrictEqual(L.move(l, 1, o), { start: 12, end: 14 }); assert.deepStrictEqual(L.move(l, -1, o), { start: 8, end: 10 });
  assert.deepStrictEqual(L.move({ start: 0, end: 2 }, -1, o), { start: 0, end: 2 }); assert.deepStrictEqual(L.move({ start: 198, end: 200 }, 1, o), { start: 198, end: 200 });
});
t('loop length: double / halve, limited to 1/32 .. 32 beats and the end of the track', () => {
  let l = L.autoLoop(10, 4, o); l = L.resize(l, 2, o); near(L.lengthBeats(l, 120), 8); l = L.resize(l, 0.5, o); near(L.lengthBeats(l, 120), 4);
  let s = L.autoLoop(10, 1 / 32, o); assert.deepStrictEqual(L.resize(s, 0.5, o), s, 'cannot go below 1/32'); let big = L.autoLoop(10, 32, o); near(L.lengthBeats(L.resize(big, 2, o), 120), 32, 1e-9, 'cannot go above 32');
  const e = L.resize({ start: 197, end: 199 }, 2, o); assert(e.end <= 200 + 1e-9 && e.end - e.start > 2, 'near the end of the track the loop is shifted back'); near(L.nearestSize(3.1), 2 <= 3.1 && 4 ? 4 : 2); near(L.nearestSize(0.3), 0.25);
});
t('loop near the end of the track stays inside it', () => { const l = L.autoLoop(199.4, 4, o); assert(l.end <= 200 + 1e-9 && l.start >= 0); near(l.end - l.start, 2); assert.strictEqual(L.fit({ start: 5, end: 5 }, 200), null); });
t('slice boundaries: 4, 8 and 16 slices of 1, 2, 4, 8 or 16 beats tile the region exactly', () => {
  for (const nn of L.SLICE_COUNTS) for (const b of L.SOURCE_BEATS) {
    const r = L.sliceRegion(20.2, b, o); near(L.lengthBeats(r, 120), b); near(((r.start - o.grid) / 0.5) % 1 < 1e-6 || ((r.start - o.grid) / 0.5) % 1 > 1 - 1e-6 ? 0 : 1, 0, 0, 'starts on a beat');
    let prev = r.start; for (let i = 0; i < nn; i++) { const s = L.sliceBounds(r, nn, i); near(s.start, prev, 1e-9); near(s.end - s.start, (r.end - r.start) / nn, 1e-9); prev = s.end; } near(prev, r.end, 1e-9);
  }
  assert.deepStrictEqual(L.SLICE_COUNTS, [4, 8, 16]); assert.deepStrictEqual(L.SOURCE_BEATS, [1, 2, 4, 8, 16]);
  assert(L.sliceRegion(20.2, 4, o).start <= 20.2, 'region starts at or before the playhead (slice 1 on a beat)');
});
t('slice position: the slice under the playhead, null outside', () => {
  const r = { start: 10, end: 14 }; assert.strictEqual(L.sliceAt(r, 8, 10), 0); assert.strictEqual(L.sliceAt(r, 8, 10.49), 0); assert.strictEqual(L.sliceAt(r, 8, 10.5), 1); assert.strictEqual(L.sliceAt(r, 8, 13.999), 7);
  assert.strictEqual(L.sliceAt(r, 8, 14), null); assert.strictEqual(L.sliceAt(r, 8, 9.9), null); assert.strictEqual(L.sliceAt(null, 8, 10), null); assert.strictEqual(L.sliceAt(r, 4, 12.5), 2);
});
t('engine slicer message: quantisation, repeat, modes and the reverse mask', () => {
  const r = { start: 10, end: 14 }, base = { n: 8, mode: 'oneshot', quant: 0, repeat: 0, reverse: [] };
  let m = L.sliceConfig(1, base, r, o); assert.strictEqual(m.cmd, 'sliceCfg'); assert.strictEqual(m.deck, 1); assert(m.on && m.n === 8 && m.mode === 0 && m.quant === 0 && m.rev === 0 && m.start === 10 && m.end === 14 && m.grid === 0.25);
  m = L.sliceConfig(0, { ...base, quant: 0.25, mode: 'loop', repeat: 0.5 }, r, o); near(m.quant, 0.125); assert.strictEqual(m.mode, 1); near(m.repeat, 0.25);
  m = L.sliceConfig(0, { ...base, mode: 'quantized' }, r, o); near(m.quant, 0.5, 1e-9, 'quantized mode with no quantisation uses one beat'); assert.strictEqual(m.mode, 3);
  m = L.sliceConfig(0, { ...base, mode: 'hold', reverse: [false, false, true, false, false, true] }, r, o); assert.strictEqual(m.rev, (1 << 2) | (1 << 5)); assert.strictEqual(m.mode, 2);
  assert.strictEqual(L.sliceConfig(0, base, null, o).on, false); assert.deepStrictEqual(L.MODES, ['oneshot', 'loop', 'hold', 'quantized']);
});
t('pad pointer states: one press per pointer, release ends it, no duplicates, no stuck pad', () => {
  const ev = []; const p = new L.PadPointer(() => ev.push('press'), () => ev.push('release'));
  assert(p.press(1)); assert(p.down); assert(!p.press(1), 'no duplicate press'); assert(!p.press(2), 'a second finger on the same pad is ignored'); assert(!p.release(2)); assert(p.release(1)); assert(!p.down); assert(!p.release(1), 'no duplicate release');
  assert(p.press(3)); assert(p.release()); assert.deepStrictEqual(ev, ['press', 'release', 'press', 'release']);
});
console.log(`\n${n} loop / slicer calculation tests passed` + (process.exitCode ? ' (with failures)' : ''));
