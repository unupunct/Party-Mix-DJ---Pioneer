'use strict';
/* LOOP CONTROL + LOOP SLICER calculations (no DOM, no audio). All times are seconds of the track (the beat grid of the analysis: bpm + grid offset), independent of the pitch
   fader (the engine plays the region at whatever rate the deck has, so a loop of N beats always stays N beats long). Loadable in the browser (window.LoopCalc) and in Node. */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.LoopCalc = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const SIZES = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 4, 8, 16, 32];
  const SIZE_LABEL = b => (b < 1 ? '1/' + Math.round(1 / b) : String(b));
  const SLICE_COUNTS = [4, 8, 16], SOURCE_BEATS = [1, 2, 4, 8, 16], QUANT = [0, 0.25, 0.5, 1];   // quantisation in beats, 0 = off
  const MODES = ['oneshot', 'loop', 'hold', 'quantized'], MODE_LABEL = { oneshot: 'ONE-SHOT', loop: 'LOOP', hold: 'HOLD', quantized: 'QUANTIZED' };
  const MIN_LOOP_S = 0.002;
  const beat = bpm => (bpm > 0 ? 60 / bpm : 0.5);
  /* nearest line of a grid made of `unit` beats starting at `grid` seconds */
  function snap(t, bpm, grid, unitBeats) { const u = beat(bpm) * unitBeats; return grid + Math.round((t - grid) / u) * u; }
  function snapFloor(t, bpm, grid, unitBeats) { const u = beat(bpm) * unitBeats; return grid + Math.floor((t - grid) / u + 1e-9) * u; }
  /* Loop of `beats` beats starting at the playhead. With quantisation the start is the nearest grid line of min(size, 1 beat) (a 1/4 beat loop snaps to quarter beats, a 4 beat loop to beats). */
  function autoLoop(pos, beats, o) {
    const unit = Math.min(beats, 1), start = o.quantize ? Math.max(0, snap(pos, o.bpm, o.grid, unit)) : pos, len = beats * beat(o.bpm);
    return fit({ start, end: start + len }, o.dur);
  }
  /* keep a loop inside the track (shift it back if it would run past the end; shrink it only if the track is shorter than the loop) */
  function fit(l, dur) {
    let { start, end } = l; const len = end - start;
    if (!(len > 0)) return null;
    if (dur > 0 && end > dur) { if (len >= dur) { start = 0; end = dur; } else { end = dur; start = dur - len; } }
    if (start < 0) { end -= start; start = 0; }
    return end - start >= MIN_LOOP_S ? { start, end } : null;
  }
  const loopIn = (pos, o) => (o.quantize ? Math.max(0, snap(pos, o.bpm, o.grid, 1)) : pos);
  /* LOOP OUT: the end must come after the start; quantised to the beat grid when asked (and at least one 1/32 beat long) */
  function loopOut(start, pos, o) {
    let end = o.quantize ? snap(pos, o.bpm, o.grid, 1) : pos; const min = Math.max(MIN_LOOP_S, beat(o.bpm) / 32);
    if (end < start + min) end = o.quantize ? start + beat(o.bpm) : start + min;
    return fit({ start, end }, o.dur);
  }
  const lengthBeats = (l, bpm) => (l ? (l.end - l.start) / beat(bpm) : 0);
  /* move by one loop length (dir -1 / +1), kept on the grid and inside the track */
  function move(l, dir, o) { const len = l.end - l.start, s = l.start + dir * len; if (s < 0 || (o.dur > 0 && s + len > o.dur + 1e-9)) return l; return { start: s, end: s + len }; }
  /* length x2 or /2 (the start stays, the end moves); limited to 1/32 .. 32 beats and to the end of the track */
  function resize(l, factor, o) {
    const b = beat(o.bpm), cur = (l.end - l.start) / b, want = clamp(cur * factor, SIZES[0], SIZES[SIZES.length - 1]);
    if (Math.abs(want - cur) < 1e-9) return l; return fit({ start: l.start, end: l.start + want * b }, o.dur) || l;
  }
  const nearestSize = beats => SIZES.reduce((best, s) => (Math.abs(Math.log(s / beats)) < Math.abs(Math.log(best / beats)) ? s : best), SIZES[0]);
  /* ---------------- slicer */
  /* source region: `beats` beats starting at the playhead's beat (quantised down to the grid so slice 1 is always on a beat) */
  function sliceRegion(pos, beats, o) { const start = Math.max(0, snapFloor(pos, o.bpm, o.grid, 1)); return fit({ start, end: start + beats * beat(o.bpm) }, o.dur); }
  function sliceBounds(region, n, i) { const l = (region.end - region.start) / n; return { start: region.start + i * l, end: region.start + (i + 1) * l }; }
  /* which slice the playhead is in (null outside the region) */
  function sliceAt(region, n, pos) { if (!region || pos < region.start || pos >= region.end) return null; return Math.min(n - 1, Math.floor((pos - region.start) / (region.end - region.start) * n)); }
  /* the engine message for the slicer of a deck */
  function sliceConfig(deck, cfg, region, o) {
    if (!region) return { cmd: 'sliceCfg', deck, on: false };
    const quant = cfg.mode === 'quantized' && !(cfg.quant > 0) ? beat(o.bpm) : (cfg.quant || 0) * beat(o.bpm);
    let rev = 0; (cfg.reverse || []).forEach((r, i) => { if (r && i < 16) rev |= 1 << i; });
    return { cmd: 'sliceCfg', deck, on: true, start: region.start, end: region.end, n: cfg.n, mode: Math.max(0, MODES.indexOf(cfg.mode)), quant, repeat: (cfg.repeat || 0) * beat(o.bpm), grid: o.grid, rev };
  }
  /* ---------------- performance pad pointer state: one press per pointer, release always ends it (up / cancel / lost capture / leaving while captured is not a release) */
  class PadPointer {
    constructor(onPress, onRelease) { this.onPress = onPress; this.onRelease = onRelease; this.id = null; }
    get down() { return this.id !== null; }
    press(id) { if (this.id !== null) return false; this.id = id; this.onPress(); return true; }
    release(id) { if (this.id === null || (id !== undefined && id !== this.id)) return false; this.id = null; this.onRelease(); return true; }
  }
  return { SIZES, SIZE_LABEL, SLICE_COUNTS, SOURCE_BEATS, QUANT, MODES, MODE_LABEL, beat, snap, snapFloor, autoLoop, fit, loopIn, loopOut, lengthBeats, move, resize, nearestSize, sliceRegion, sliceBounds, sliceAt, sliceConfig, PadPointer };
});
