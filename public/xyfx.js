'use strict';
/* XY MULTI-FX core (no DOM, no audio): coordinate normalisation, neutral zone, bilinear blending, parameter mapping and the pad's interaction state machine.
   The UI (xypad UI in sidepanels.js) feeds it pointer positions; it produces control messages {act, w, p} that go to the audio engine (engine/src/xyfx.rs) or the Web Audio fallback.
   Loadable in the browser (window.XYFX) and in Node (scripts/test-xyfx.js).

   Zones (top-left, top-right, bottom-left, bottom-right) get the effects of cfg.assign (default FILTER, ECHO, REVERB, FLANGER). The pad centre is neutral.
   weights  = bilinear: TL (1-X)(1-Y), TR X(1-Y), BL (1-X)Y, BR XY  (they always sum to 1: a convex blend, never four wet signals added at full volume)
   activation = smoothstep of the distance from the centre between the neutral radius and the activation radius.
   Parameters use the zone's own outward axes (u, v: 0 at the centre line, 1 at the outer edge): outward = more of the effect. */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.XYFX = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const EFFECTS = ['filter', 'echo', 'reverb', 'flanger'];
  const NAMES = { filter: 'FILTER', echo: 'ECHO', reverb: 'REVERB', flanger: 'FLANGER' };
  const COLORS = { filter: '#38c9ff', echo: '#c06cff', reverb: '#37d67a', flanger: '#ffb020' };
  const ZONES = ['TL', 'TR', 'BL', 'BR'];
  /* Each of the four zones can run any of 7 effects of its family (28 in all, 21 beyond the original four). The order matches the engine (engine/src/xyfx.rs, NV = 7). */
  const VARIANTS = {
    filter: ['lp', 'hp', 'bp', 'notch', 'comb', 'vowel', 'peak'],
    echo: ['echo', 'pingpong', 'tape', 'dub', 'slap', 'reverse', 'triplet'],
    reverb: ['room', 'hall', 'plate', 'spring', 'gated', 'swell', 'dark'],
    flanger: ['flanger', 'phaser', 'chorus', 'vibrato', 'tremolo', 'autopan', 'ring'],
  };
  const VARIANT_LABEL = { lp: 'Low-pass', hp: 'High-pass', bp: 'Band-pass', notch: 'Notch', comb: 'Comb', vowel: 'Vowel', peak: 'Peak boost', echo: 'Echo', pingpong: 'Ping-Pong', tape: 'Tape echo', dub: 'Dub echo', slap: 'Slapback', reverse: 'Reverse echo', triplet: 'Triplet echo', room: 'Room', hall: 'Hall', plate: 'Plate', spring: 'Spring', gated: 'Gated', swell: 'Swell', dark: 'Dark', flanger: 'Flanger', phaser: 'Phaser', chorus: 'Chorus', vibrato: 'Vibrato', tremolo: 'Tremolo', autopan: 'Auto-pan', ring: 'Ring mod' };
  const FILTER_TYPES = VARIANTS.filter, FILTER_LABEL = VARIANT_LABEL, FILTER_SHORT = { lp: 'LP', hp: 'HP', bp: 'BP', notch: 'NOTCH', comb: 'COMB', vowel: 'VOWEL', peak: 'PEAK' };
  const variantOf = (cfg, fam) => (fam === 'filter' ? cfg.filterType : (cfg.variants && cfg.variants[fam]) || VARIANTS[fam][0]);
  const variantIdx = cfg => EFFECTS.map(e => Math.max(0, VARIANTS[e].indexOf(variantOf(cfg, e))));
  const DIV = [1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1];   // musical echo divisions (in beats)
  const DEFAULTS = {
    v: 2, neutral: 0.1, activation: 0.27, sensitivity: 1, sharpness: 1.4, bpmSync: true, snapEcho: false, filterType: 'lp', variants: { echo: 'echo', reverb: 'room', flanger: 'flanger' },
    assign: ['filter', 'echo', 'reverb', 'flanger'],
    ranges: { cutoff: [50, 20000], resMax: 0.95, delay: [1 / 32, 2], fbMax: 0.92, room: [0, 1], wetMax: 1, rate: [0.05, 14], depthMax: 1 },
  };
  const clone = o => JSON.parse(JSON.stringify(o));
  /* A saved / typed configuration is merged over the defaults and every field is clamped to a sane range, so a damaged file can never break the pad. */
  function sanitize(c) {
    const d = clone(DEFAULTS), s = c && typeof c === 'object' ? c : {}, num = (v, a, b, def) => (typeof v === 'number' && isFinite(v) ? clamp(v, a, b) : def);
    d.neutral = num(s.neutral, 0, 0.45, d.neutral); d.activation = num(s.activation, d.neutral + 0.02, 0.7, Math.max(d.activation, d.neutral + 0.02));
    d.sensitivity = num(s.sensitivity, 0.5, 2, 1); d.sharpness = num(s.sharpness, 0.5, 4, DEFAULTS.sharpness);
    d.bpmSync = s.bpmSync !== false; d.snapEcho = !!s.snapEcho; d.filterType = FILTER_TYPES.includes(s.filterType) ? s.filterType : 'lp'; const sv = s.variants && typeof s.variants === 'object' ? s.variants : {}; for (const fam of ['echo', 'reverb', 'flanger']) d.variants[fam] = VARIANTS[fam].includes(sv[fam]) ? sv[fam] : VARIANTS[fam][0];
    if (Array.isArray(s.assign) && s.assign.length === 4 && s.assign.every(e => EFFECTS.includes(e))) d.assign = s.assign.slice();
    const r = s.ranges && typeof s.ranges === 'object' ? s.ranges : {}, R = d.ranges, pair = (v, def, lo, hi) => (Array.isArray(v) && v.length === 2 && v.every(x => typeof x === 'number' && isFinite(x)) ? [clamp(Math.min(v[0], v[1]), lo, hi), clamp(Math.max(v[0], v[1]), lo, hi)] : def);
    R.cutoff = pair(r.cutoff, R.cutoff, 20, 20000); R.delay = pair(r.delay, R.delay, 1 / 64, 4); R.room = pair(r.room, R.room, 0, 1); R.rate = pair(r.rate, R.rate, 0.02, 20);
    R.resMax = num(r.resMax, 0, 0.98, R.resMax); R.fbMax = num(r.fbMax, 0, 0.95, R.fbMax); R.wetMax = num(r.wetMax, 0, 1, R.wetMax); R.depthMax = num(r.depthMax, 0, 1, R.depthMax);
    if (R.cutoff[1] <= R.cutoff[0]) R.cutoff = [R.cutoff[0], Math.min(20000, R.cutoff[0] * 2 + 1)];
    return d;
  }
  /* pointer position -> 0..1 (left 0, right 1, top 0, bottom 1). Works with any size and aspect ratio; a zero-sized rect gives the centre. */
  function normalize(clientX, clientY, rect) {
    if (!rect || !(rect.width > 0) || !(rect.height > 0)) return { x: 0.5, y: 0.5 };
    return { x: clamp((clientX - rect.left) / rect.width, 0, 1), y: clamp((clientY - rect.top) / rect.height, 0, 1) };
  }
  const applySensitivity = (x, y, s) => ({ x: clamp(0.5 + (x - 0.5) * s, 0, 1), y: clamp(0.5 + (y - 0.5) * s, 0, 1) });
  const distance = (x, y) => Math.hypot(x - 0.5, y - 0.5);
  const inNeutral = (x, y, cfg) => distance(x, y) <= cfg.neutral;
  /* smoothstep between the neutral and the activation radius: 0 inside the neutral zone, 1 beyond the activation radius, no step in between */
  function activation(x, y, cfg) { const t = clamp((distance(x, y) - cfg.neutral) / Math.max(1e-6, cfg.activation - cfg.neutral), 0, 1); return t * t * (3 - 2 * t); }
  function zoneWeights(x, y, sharp = 1) {
    const w = [(1 - x) * (1 - y), x * (1 - y), (1 - x) * y, x * y].map(v => (sharp === 1 ? v : Math.pow(v, sharp)));
    const s = w[0] + w[1] + w[2] + w[3]; return s > 0 ? w.map(v => v / s) : [0.25, 0.25, 0.25, 0.25];
  }
  const logLerp = (a, b, t) => a * Math.pow(b / a, t), lerp = (a, b, t) => a + (b - a) * t;
  /* the zone's own coordinates: how far out towards its corner the pointer is, per axis (0..1) */
  function outward(zone, x, y) {
    const u = zone % 2 === 0 ? (0.5 - x) * 2 : (x - 0.5) * 2, v = zone < 2 ? (0.5 - y) * 2 : (y - 0.5) * 2;
    return { u: clamp(u, 0, 1), v: clamp(v, 0, 1) };
  }
  const snapBeats = b => DIV.reduce((best, d) => (Math.abs(Math.log(d / b)) < Math.abs(Math.log(best / b)) ? d : best), DIV[0]);
  /* Parameters of one effect for one zone. Returns the engine units: filter {cutoff Hz, res}, echo {delay s, fb}, reverb {room, wet}, flanger {rate Hz, depth}. */
  function params(effect, zone, x, y, cfg, bpm) {
    const { u, v } = outward(zone, x, y), R = cfg.ranges;
    switch (effect) {
      case 'filter': return [cfg.filterType === 'hp' ? logLerp(R.cutoff[0], R.cutoff[1], u) : logLerp(R.cutoff[1], R.cutoff[0], u), v * R.resMax];   // low-pass / band-pass / notch close from the top, a high-pass climbs from the bottom
      case 'echo': { let beats = logLerp(R.delay[0], R.delay[1], u); if (cfg.snapEcho) beats = snapBeats(beats); const b = cfg.bpmSync && bpm > 40 && bpm < 260 ? bpm : 120; return [clamp(beats * 60 / b, 0.001, 1.9), v * R.fbMax]; }
      case 'reverb': return [lerp(R.room[0], R.room[1], u), v * R.wetMax];
      default: return [logLerp(R.rate[0], R.rate[1], u), v * R.depthMax];
    }
  }
  const NEUTRAL_P = (cfg) => [cfg.ranges.cutoff[1], 0, 0.25, 0, 0.5, 0, 1, 0];
  /* Everything the engine needs for one pointer position (already through the sensitivity). */
  function mix(x, y, cfg, bpm) {
    const act = activation(x, y, cfg), zw = zoneWeights(x, y, cfg.sharpness), w = [0, 0, 0, 0], acc = EFFECTS.map(() => [0, 0]), p = NEUTRAL_P(cfg);
    cfg.assign.forEach((eff, z) => { const e = EFFECTS.indexOf(eff), q = params(eff, z, x, y, cfg, bpm); w[e] += zw[z]; acc[e][0] += zw[z] * q[0]; acc[e][1] += zw[z] * q[1]; });
    EFFECTS.forEach((_, e) => { if (w[e] > 1e-9) { p[e * 2] = acc[e][0] / w[e]; p[e * 2 + 1] = acc[e][1] / w[e]; } });
    return { x, y, act, w, zw, p, ft: Math.max(0, FILTER_TYPES.indexOf(cfg.filterType)), var: variantIdx(cfg), effects: EFFECTS.map((_, e) => w[e] * act) };
  }
  /* Interaction state machine: IDLE <-> ACTIVE for one pointer. Release (up / cancel / lost capture / blur) is immediate and always ends in IDLE with act = 0. */
  class Pad {
    constructor(cfg, send, opts = {}) { this.cfg = sanitize(cfg); this.send = send || (() => {}); this.getBpm = opts.getBpm || (() => 120); this.onState = opts.onState || (() => {}); this.state = 'idle'; this.pid = null; this.x = 0.5; this.y = 0.5; this.last = null; }
    setConfig(cfg) { this.cfg = sanitize(cfg); if (this.state === 'active') this._update(this.rx, this.ry); }
    down(id, x, y) { if (this.state === 'active') return false; this.state = 'active'; this.pid = id; this._update(x, y); return true; }
    move(id, x, y) { if (this.state !== 'active' || id !== this.pid) return false; this._update(x, y); return true; }
    up(id) { if (this.state !== 'active' || (id !== undefined && id !== this.pid)) return false; this.release(); return true; }
    cancel(id) { return this.up(id); }
    release() {
      const wasActive = this.state === 'active'; this.state = 'idle'; this.pid = null; this.x = 0.5; this.y = 0.5; this.rx = 0.5; this.ry = 0.5;
      const p = this.last ? this.last.p : NEUTRAL_P(this.cfg); this.last = null;
      if (wasActive) this.send({ act: 0, w: [0, 0, 0, 0], p, ft: Math.max(0, FILTER_TYPES.indexOf(this.cfg.filterType)), var: variantIdx(this.cfg) }); this.onState(null);
    }
    _update(rx, ry) {
      this.rx = rx; this.ry = ry; const s = applySensitivity(rx, ry, this.cfg.sensitivity); this.x = s.x; this.y = s.y;
      this.last = mix(this.x, this.y, this.cfg, this.getBpm()); this.send({ act: this.last.act, w: this.last.w, p: this.last.p, ft: this.last.ft, var: this.last.var }); this.onState(this.last);
    }
  }
  return { VARIANTS, VARIANT_LABEL, variantOf, variantIdx, FILTER_TYPES, FILTER_LABEL, FILTER_SHORT, EFFECTS, NAMES, COLORS, ZONES, DIV, DEFAULTS, clone, sanitize, normalize, applySensitivity, distance, inNeutral, activation, zoneWeights, outward, params, mix, snapBeats, Pad };
});
