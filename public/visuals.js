'use strict';
/* Side visuals: two framed screens in the free space left and right of the console, styled like the controller
   (dark board, red neon edge, the console's accent colours). 50 procedural presets; a click on a frame switches it to a random one.
   Reacts to the master level and the beat of the playing track. Needs globals from app.js: decks, nat, clamp. */
(() => {
  const root = document.getElementById('waves'); if (!root) return;   // the visuals sit left and right of the waveforms
  const TAU = Math.PI * 2, R = Math.random;
  const PALS = [['#ff2b3a', '#ff4fa8', '#b66cff'], ['#3ab0ff', '#b66cff', '#ff4fa8'], ['#35e07a', '#3ab0ff', '#e9ecf4'], ['#ffa226', '#ff2b3a', '#ff4fa8'], ['#3ab0ff', '#35e07a', '#b66cff'], ['#ff2b3a', '#ffa226', '#e9ecf4']];
  const lerpHex = (a, b, t) => { const p = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16)); const x = p(a), y = p(b); return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',')})`; };
  const lut = pal => Array.from({ length: 48 }, (_, i) => { const f = i / 47 * 2, k = Math.min(1, Math.floor(f)); return lerpHex(pal[k], pal[k + 1], f - k); });
  const fade = (g, w, h, a) => { g.globalCompositeOperation = 'source-over'; g.fillStyle = `rgba(6,6,9,${Math.min(1, a * 1.6 + 0.04)})`; g.fillRect(0, 0, w, h); };   // shorter trails: clean lines instead of a smear
  const DPRV = () => Math.max(1, Math.min(2, window.devicePixelRatio || 1));

  /* each family: init(w,h,p) -> state; draw(g,w,h,S,st,p)   S = { t, lvl, pulse, pal, lut, dt } */
  const F = {
    tunnel: { draw(g, w, h, S, st, p) { fade(g, w, h, 0.35); g.lineWidth = 1.6; for (let i = 0; i < 14; i++) { const z = ((i / 14) + S.t * p.sp) % 1, r = z * z * Math.hypot(w, h) * 0.6 * (1 + S.pulse * 0.15); g.strokeStyle = S.pal[i % 3]; g.globalAlpha = Math.min(1, z * 1.4); g.beginPath(); for (let k = 0; k <= p.n; k++) { const a = k / p.n * TAU + S.t * p.rot + i * p.tw; g.lineTo(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r); } g.stroke(); } g.globalAlpha = 1; } },
    bars: { draw(g, w, h, S, st, p) { fade(g, w, h, 0.4); const n = p.n, bw = w / n; for (let i = 0; i < n; i++) { const v = (0.15 + 0.85 * Math.abs(Math.sin(S.t * p.sp + i * 0.7 + Math.sin(i * 1.9)))) * (0.35 + S.lvl * 0.9 + S.pulse * 0.2), bh = clamp(v, 0, 1) * h * (p.mirror ? 0.5 : 0.95); g.fillStyle = S.pal[i % 3]; if (p.mirror) g.fillRect(i * bw + 1, h / 2 - bh, bw - 2, bh * 2); else g.fillRect(i * bw + 1, h - bh, bw - 2, bh); } } },
    plasma: { draw(g, w, h, S, st, p) { const gw = 72, gh = Math.round(72 * h / w) || 96, cw = w / gw, ch = h / gh, t = S.t * p.sp; for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) { const v = Math.sin(x * p.a + t) + Math.sin(y * p.b + t * 1.3) + Math.sin((x + y) * p.c + t * 0.7) + Math.sin(Math.hypot(x - gw / 2, y - gh / 2) * p.d - t * 2) + S.pulse * 0.6; g.fillStyle = S.lut[clamp(Math.floor((v + 4) / 8 * 47), 0, 47)]; g.fillRect(x * cw, y * ch, cw + 1, ch + 1); } } },
    stars: { init(w, h) { return { s: Array.from({ length: 120 }, () => ({ x: R() * 2 - 1, y: R() * 2 - 1, z: R() })) }; }, draw(g, w, h, S, st, p) { fade(g, w, h, 0.28); for (const s of st.s) { const pz = s.z; s.z -= S.dt * (p.sp + S.lvl * 0.8); if (s.z <= 0.02) { s.x = R() * 2 - 1; s.y = R() * 2 - 1; s.z = 1; continue; } const x1 = w / 2 + s.x / s.z * w * 0.4, y1 = h / 2 + s.y / s.z * h * 0.4, x0 = w / 2 + s.x / pz * w * 0.4, y0 = h / 2 + s.y / pz * h * 0.4; g.strokeStyle = S.pal[(s.x * 9 | 0) % 3 < 0 ? 0 : Math.abs(s.x * 9 | 0) % 3]; g.lineWidth = 0.6 + (1 - s.z) * 2.2; g.beginPath(); g.moveTo(x0, y0); g.lineTo(x1, y1); g.stroke(); } } },
    burst: { draw(g, w, h, S, st, p) { fade(g, w, h, 0.3); g.lineWidth = p.lw; for (let i = 0; i < p.n; i++) { const a = i / p.n * TAU + S.t * p.rot, l = (0.25 + 0.5 * Math.abs(Math.sin(S.t * 1.7 + i))) * Math.hypot(w, h) * 0.5 * (0.8 + S.pulse * 0.5 + S.lvl); g.strokeStyle = S.pal[i % 3]; g.beginPath(); g.moveTo(w / 2 + Math.cos(a) * 14, h / 2 + Math.sin(a) * 14); g.lineTo(w / 2 + Math.cos(a) * l, h / 2 + Math.sin(a) * l); g.stroke(); } } },
    lissa: { draw(g, w, h, S, st, p) { fade(g, w, h, 0.12); g.lineWidth = 1.8; for (let c = 0; c < 3; c++) { g.strokeStyle = S.pal[c]; g.beginPath(); for (let i = 0; i <= 220; i++) { const u = i / 220 * TAU; g.lineTo(w / 2 + Math.sin(u * p.a + S.t * 0.9 + c) * w * (0.32 + S.lvl * 0.12), h / 2 + Math.sin(u * p.b + S.t * 0.6 + c * 0.7) * h * (0.32 + S.pulse * 0.06)); } g.stroke(); } } },
    grid: { draw(g, w, h, S, st, p) { g.fillStyle = '#06060a'; g.fillRect(0, 0, w, h); const hz = h * 0.5; const gr = g.createLinearGradient(0, hz - h * 0.3, 0, hz); gr.addColorStop(0, 'transparent'); gr.addColorStop(1, S.pal[0] + '66'); g.fillStyle = gr; g.fillRect(0, hz - h * 0.3, w, h * 0.3); g.fillStyle = S.pal[1]; g.beginPath(); g.arc(w / 2, hz - h * 0.1, Math.min(w * 0.2, h * 0.3) * (1 + S.pulse * 0.1), Math.PI, 0); g.fill(); g.strokeStyle = S.pal[2]; g.lineWidth = 1.2; for (let i = -8; i <= 8; i++) { g.beginPath(); g.moveTo(w / 2 + i * w * 0.04, hz); g.lineTo(w / 2 + i * w * 0.55, h); g.stroke(); } for (let i = 0; i < 10; i++) { const z = ((i / 10) + S.t * p.sp) % 1, y = hz + (z * z) * (h - hz); g.globalAlpha = 0.3 + z * 0.7; g.beginPath(); g.moveTo(0, y); g.lineTo(w, y); g.stroke(); } g.globalAlpha = 1; } },
    kaleido: { draw(g, w, h, S, st, p) { fade(g, w, h, 0.22); g.save(); g.translate(w / 2, h / 2); g.lineWidth = 2; for (let k = 0; k < p.n; k++) { g.save(); g.rotate(k / p.n * TAU + S.t * p.rot); const r = Math.min(w, h) * 0.42 * (0.7 + S.lvl * 0.5 + S.pulse * 0.12); g.strokeStyle = S.pal[k % 3]; g.beginPath(); g.moveTo(0, 0); g.quadraticCurveTo(r * 0.5, Math.sin(S.t * 1.3 + k) * r * 0.6, r, Math.cos(S.t + k) * r * 0.3); g.stroke(); g.fillStyle = S.pal[(k + 1) % 3]; g.beginPath(); g.arc(r, Math.cos(S.t + k) * r * 0.3, 3 + S.pulse * 4, 0, TAU); g.fill(); g.restore(); } g.restore(); } },
    rain: { init(w, h, p) { return { c: Array.from({ length: p.n }, (_, i) => ({ x: (i + 0.5) / p.n, y: R(), v: 0.25 + R() * 0.6 })) }; }, draw(g, w, h, S, st, p) { fade(g, w, h, 0.2); for (const c of st.c) { c.y += c.v * S.dt * (0.6 + S.lvl); if (c.y > 1.3) { c.y = -0.1; c.v = 0.25 + R() * 0.6; } for (let k = 0; k < 7; k++) { g.globalAlpha = 1 - k / 7; g.fillStyle = S.pal[k ? (st.c.indexOf(c) % 3) : 2]; g.fillRect(c.x * w - 2, (c.y - k * 0.04) * h, 4, h * 0.03); } } g.globalAlpha = 1; } },
    waves: { draw(g, w, h, S, st, p) { fade(g, w, h, 0.4); for (let l = 0; l < p.n; l++) { g.fillStyle = S.pal[l % 3] + '55'; g.strokeStyle = S.pal[l % 3]; g.lineWidth = 1.5; g.beginPath(); g.moveTo(0, h); for (let x = 0; x <= w; x += 6) g.lineTo(x, h * (0.45 + l * 0.1) + Math.sin(x * 0.03 * (l + 1) + S.t * p.sp * (l + 1)) * h * (0.06 + S.lvl * 0.1 + S.pulse * 0.02)); g.lineTo(w, h); g.closePath(); g.fill(); g.stroke(); } } },
    bubbles: { init(w, h, p) { return { b: Array.from({ length: p.n }, () => ({ x: R(), y: R(), r: 0.02 + R() * 0.05, v: 0.05 + R() * 0.15, ph: R() * 9 })) }; }, draw(g, w, h, S, st, p) { fade(g, w, h, 0.3); for (const b of st.b) { b.y -= b.v * S.dt * (0.7 + S.lvl); if (b.y < -0.1) { b.y = 1.1; b.x = R(); } const r = b.r * Math.min(w, h) * (1 + S.pulse * 0.4); g.strokeStyle = S.pal[(b.ph | 0) % 3]; g.lineWidth = 2; g.beginPath(); g.arc(b.x * w + Math.sin(S.t + b.ph) * 12, b.y * h, r, 0, TAU); g.stroke(); } } },
    lasers: { draw(g, w, h, S, st, p) { fade(g, w, h, 0.25); g.globalCompositeOperation = 'lighter'; g.lineWidth = 2.4; for (let i = 0; i < p.n; i++) { const a = -Math.PI / 2 + Math.sin(S.t * p.sp + i * 1.3) * 1.0; g.strokeStyle = S.pal[i % 3]; g.beginPath(); g.moveTo(w * (p.src === 'c' ? 0.5 : (i + 0.5) / p.n), h); g.lineTo(w * (p.src === 'c' ? 0.5 : (i + 0.5) / p.n) + Math.cos(a) * h * 1.3, h + Math.sin(a) * h * 1.3); g.stroke(); } g.globalCompositeOperation = 'source-over'; } },
    hex: { draw(g, w, h, S, st, p) { fade(g, w, h, 0.5); const s = p.s, hh = s * Math.sqrt(3) / 2; for (let row = -1; row < h / hh + 1; row++) for (let col = -1; col < w / (s * 1.5) + 1; col++) { const x = col * s * 1.5, y = row * hh * 2 + (col & 1) * hh, d = Math.hypot(x - w / 2, y - h / 2) / Math.hypot(w, h), v = 0.5 + 0.5 * Math.sin(d * 10 - S.t * p.sp) + S.pulse * 0.2; g.strokeStyle = S.pal[(row + col + 9) % 3]; g.globalAlpha = clamp(v, 0.08, 1); g.beginPath(); for (let k = 0; k < 6; k++) g.lineTo(x + Math.cos(k * TAU / 6) * s * 0.85, y + Math.sin(k * TAU / 6) * s * 0.85); g.closePath(); g.stroke(); } g.globalAlpha = 1; } },
    spiral: { draw(g, w, h, S, st, p) { fade(g, w, h, 0.2); for (let i = 0; i < 160; i++) { const u = i / 160, a = u * TAU * p.turns + S.t * p.rot, r = u * Math.min(w, h) * 0.5 * (1 + S.pulse * 0.1); g.fillStyle = S.pal[i % 3]; g.beginPath(); g.arc(w / 2 + Math.cos(a) * r, h / 2 + Math.sin(a) * r, 1.4 + u * 3 + S.lvl * 2, 0, TAU); g.fill(); } } },
    scope: { draw(g, w, h, S, st, p) { fade(g, w, h, 0.25); g.lineWidth = 1.8; for (let c = 0; c < p.n; c++) { g.strokeStyle = S.pal[c % 3]; g.beginPath(); for (let x = 0; x <= w; x += 3) { const u = x / w; g.lineTo(x, h * (c + 1) / (p.n + 1) + (Math.sin(u * 14 + S.t * 2.2 + c) * 0.5 + Math.sin(u * 31 - S.t * 3.1) * 0.25) * h * (0.06 + S.lvl * 0.12 + S.pulse * 0.03)); } g.stroke(); } } },
    eqring: { draw(g, w, h, S, st, p) { fade(g, w, h, 0.35); const n = p.n, r0 = Math.min(w, h) * 0.22; g.lineWidth = Math.max(2, 180 / n); for (let i = 0; i < n; i++) { const a = i / n * TAU + S.t * 0.2, v = (0.2 + 0.8 * Math.abs(Math.sin(S.t * 2 + i * 0.5 + Math.sin(i * 2.3)))) * (0.4 + S.lvl + S.pulse * 0.3), r1 = r0 + v * Math.min(w, h) * 0.26; g.strokeStyle = S.pal[i % 3]; g.beginPath(); g.moveTo(w / 2 + Math.cos(a) * r0, h / 2 + Math.sin(a) * r0); g.lineTo(w / 2 + Math.cos(a) * r1, h / 2 + Math.sin(a) * r1); g.stroke(); } } },
    embers: { init(w, h, p) { return { e: Array.from({ length: p.n }, () => ({ x: R(), y: R(), v: 0.1 + R() * 0.4, s: R() * 6 })) }; }, draw(g, w, h, S, st, p) { fade(g, w, h, 0.18); g.globalCompositeOperation = 'lighter'; for (const e of st.e) { e.y -= e.v * S.dt * (0.8 + S.lvl * 1.5); e.x += Math.sin(S.t * 2 + e.s) * 0.0015; if (e.y < -0.05) { e.y = 1.05; e.x = R(); } g.fillStyle = S.pal[(e.s | 0) % 3]; g.globalAlpha = clamp(e.y * 1.2, 0, 1); g.beginPath(); g.arc(e.x * w, e.y * h, 1.5 + e.v * 5 + S.pulse * 2, 0, TAU); g.fill(); } g.globalAlpha = 1; g.globalCompositeOperation = 'source-over'; } },
    rings: { draw(g, w, h, S, st, p) { fade(g, w, h, 0.3); g.lineWidth = 2.4; for (let i = 0; i < p.n; i++) { const z = ((i / p.n) + S.t * p.sp) % 1; g.strokeStyle = S.pal[i % 3]; g.globalAlpha = 1 - z; g.beginPath(); g.arc(w / 2, h / 2, z * Math.hypot(w, h) * 0.5 * (1 + S.pulse * 0.06), 0, TAU); g.stroke(); } g.globalAlpha = 1; } },
    dots: { draw(g, w, h, S, st, p) { fade(g, w, h, 0.4); const nx = p.n, ny = Math.round(p.n * h / w); for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const px = (x + 0.5) / nx * w, py = (y + 0.5) / ny * h, d = Math.hypot(px - w / 2, py - h / 2), v = Math.sin(d * 0.06 - S.t * p.sp) * 0.5 + 0.5 + S.pulse * 0.2; g.fillStyle = S.pal[(x + y) % 3]; g.globalAlpha = 0.2 + v * 0.8; g.beginPath(); g.arc(px, py, 1 + v * w / nx * 0.36, 0, TAU); g.fill(); } g.globalAlpha = 1; } },
    orbit: { draw(g, w, h, S, st, p) { fade(g, w, h, 0.1); for (let i = 0; i < p.n; i++) { const a = S.t * (0.4 + i * 0.23) * p.sp + i, rx = w * (0.12 + i * 0.07), ry = h * (0.1 + i * 0.06); g.fillStyle = S.pal[i % 3]; g.beginPath(); g.arc(w / 2 + Math.cos(a) * rx, h / 2 + Math.sin(a) * ry, 3 + S.pulse * 3 + S.lvl * 3, 0, TAU); g.fill(); } g.strokeStyle = S.pal[0]; g.globalAlpha = 0.5; g.beginPath(); g.arc(w / 2, h / 2, 5 + S.pulse * 8, 0, TAU); g.stroke(); g.globalAlpha = 1; } },
    checker: { draw(g, w, h, S, st, p) { g.fillStyle = '#06060a'; g.fillRect(0, 0, w, h); const n = p.n; for (let y = 0; y < n * h / w + 1; y++) for (let x = 0; x < n; x++) { const cw = w / n, ox = Math.sin(S.t * p.sp + y * 0.5) * cw * 0.3; if ((x + y + Math.floor(S.t * 2)) % 2) { g.fillStyle = S.pal[(x + y) % 3]; g.globalAlpha = 0.5 + S.pulse * 0.4; g.fillRect(x * cw + ox, y * cw, cw - 2, cw - 2); } } g.globalAlpha = 1; } },
  };
  // 50 presets: [family, palette, params, name]
  const P = [];
  const add = (f, pal, p, name) => P.push({ f, pal, p, name });
  [[3, 0, 0.5, 0.05], [5, 1, 0.3, 0.1], [4, 2, -0.4, 0.16], [6, 3, 0.2, 0.0]].forEach(([n, pal, rot, tw], i) => add('tunnel', pal, { n, sp: 0.12 + i * 0.03, rot, tw }, 'NEON TUNNEL ' + (i + 1)));
  [[16, 0, false], [24, 1, true], [12, 3, false]].forEach(([n, pal, mirror], i) => add('bars', pal, { n, sp: 1.4 + i * 0.5, mirror }, 'EQ BARS ' + (i + 1)));
  [[0.5, 0.4, 0.3, 0.7, 1, 0], [0.8, 0.3, 0.5, 0.4, 1.4, 1], [0.35, 0.6, 0.2, 0.9, 0.8, 4]].forEach(([a, b, c, d, sp, pal], i) => add('plasma', pal, { a, b, c, d, sp }, 'PLASMA ' + (i + 1)));
  [[0.35, 0], [0.7, 2], [0.5, 4]].forEach(([sp, pal], i) => add('stars', pal, { sp }, 'STAR DRIVE ' + (i + 1)));
  [[18, 0, 0.3, 2], [30, 1, -0.5, 1.4], [12, 3, 0.15, 3]].forEach(([n, pal, rot, lw], i) => add('burst', pal, { n, rot, lw }, 'RAY BURST ' + (i + 1)));
  [[3, 2, 0], [5, 4, 1], [3, 5, 4]].forEach(([a, b, pal], i) => add('lissa', pal, { a, b }, 'LISSAJOUS ' + (i + 1)));
  [[0.4, 0], [0.7, 1], [0.25, 3]].forEach(([sp, pal], i) => add('grid', pal, { sp }, 'SYNTH GRID ' + (i + 1)));
  [[6, 0, 0.2], [8, 2, -0.15], [10, 4, 0.3]].forEach(([n, pal, rot], i) => add('kaleido', pal, { n, rot }, 'KALEIDO ' + (i + 1)));
  [[14, 2], [22, 0]].forEach(([n, pal], i) => add('rain', pal, { n }, 'DATA RAIN ' + (i + 1)));
  [[3, 1, 1.2], [4, 3, 0.8]].forEach(([n, pal, sp], i) => add('waves', pal, { n, sp }, 'WAVE FIELD ' + (i + 1)));
  [[26, 4], [40, 1]].forEach(([n, pal], i) => add('bubbles', pal, { n }, 'BUBBLES ' + (i + 1)));
  [[7, 0, 0.8, 'b'], [5, 1, 1.2, 'c'], [9, 3, 0.6, 'b']].forEach(([n, pal, sp, src], i) => add('lasers', pal, { n, sp, src }, 'LASER SHOW ' + (i + 1)));
  [[20, 2, 1.5], [14, 4, 1]].forEach(([s, pal, sp], i) => add('hex', pal, { s, sp }, 'HEX GRID ' + (i + 1)));
  [[4, 0, 0.4], [7, 1, -0.3]].forEach(([turns, pal, rot], i) => add('spiral', pal, { turns, rot }, 'SPIRAL ' + (i + 1)));
  [[3, 1], [5, 4]].forEach(([n, pal], i) => add('scope', pal, { n }, 'SCOPE ' + (i + 1)));
  [[48, 0], [32, 3]].forEach(([n, pal], i) => add('eqring', pal, { n }, 'EQ RING ' + (i + 1)));
  [[90, 3], [60, 0]].forEach(([n, pal], i) => add('embers', pal, { n }, 'EMBERS ' + (i + 1)));
  [[7, 0.22, 1], [10, 0.35, 2]].forEach(([n, sp, pal], i) => add('rings', pal, { n, sp }, 'RIPPLES ' + (i + 1)));
  [[10, 0.9, 0], [16, 1.6, 4]].forEach(([n, sp, pal], i) => add('dots', pal, { n, sp }, 'DOT WAVE ' + (i + 1)));
  add('orbit', 1, { n: 6, sp: 1 }, 'ORBITS 1'); add('checker', 5, { n: 8, sp: 1.6 }, 'CHECKER');
  add('speaker', 0, { model: 0 }, 'SPEAKERS · TOWER'); add('speaker', 1, { model: 1 }, 'SPEAKERS · SUBWOOFER'); add('speaker', 3, { model: 2 }, 'SPEAKERS · MONITOR');
  const COUNT = P.length;   // 53: 50 visuals + 3 speaker models (a frame shows a visual or speakers, never both)

  /* ---- shared audio-reactive state */
  const S = { t: 0, dt: 0.03, lvl: 0.25, pulse: 0, kick: 0, prevLvl: 0.25, cost: 0, pal: PALS[0], lut: lut(PALS[0]) };
  const bpmNow = () => { const d = decks.find(x => x.playing && x.an && x.an.bpm) || decks.find(x => x.an && x.an.bpm); return d ? d.an.bpm * d.rate : 120; };

  /* ---- frames */
  const make = side => {
    const el = document.createElement('div'); el.className = 'vframe ' + side; el.title = 'Click: random visual';
    el.innerHTML = '<div class="vscreen"><canvas></canvas></div><div class="vplate"><i></i><span></span><i></i></div>';
    root.appendChild(el);
    const f = { side, el, cv: el.querySelector('.vscreen canvas'), label: el.querySelector('span'), idx: -1, st: null, w: 0, h: 0, flash: 0 };
    f.g = f.cv.getContext('2d');
    el.addEventListener('pointerdown', () => pick(f));
    return f;
  };
  const frames = [make('left'), make('right')];
  // the two screens act as one: the same preset, the same moment; a click on either one changes both
  function pick(_f, to) {
    const cur = frames[0].idx; let i; do { i = to != null ? to : Math.floor(R() * COUNT); } while (i === cur && to == null && COUNT > 1);
    const pr = P[i];
    for (const f of frames) {
      f.idx = i; f.pal = PALS[pr.pal]; f.lut = lut(f.pal); f.st = F[pr.f].init ? F[pr.f].init(f.w || 200, f.h || 300, pr.p) : null;
      f.label.textContent = `VISUAL ${String(i + 1).padStart(2, '0')}/${COUNT} · ${pr.name}`; f.flash = 1;
      if (f.w) { f.g.fillStyle = '#06060a'; f.g.fillRect(0, 0, f.w, f.h); }
      try { lsSet('visual.' + f.side, i); } catch {}   // remembered per side, restored on the next start
    }
  }

  /* ---- layout: each visual sits in a side column above its panel, level with the waveform block; the columns are computed by sidehost.js (CSS variables on #djview) */
  function layout() {
    const W = root.clientWidth, H = root.clientHeight; if (!W || !H) return;
    const cs = getComputedStyle(document.getElementById('djview')), visw = parseFloat(cs.getPropertyValue('--visw')) || 0, colx = parseFloat(cs.getPropertyValue('--colx')) || 14, top = 8, hgt = H - top - 2;
    frames.forEach((f, n) => {
      const show = visw >= 100 && hgt >= 80; f.el.style.display = show ? '' : 'none'; if (!show) return;
      Object.assign(f.el.style, { left: (n === 0 ? colx : W - colx - visw) + 'px', top: top + 'px', width: visw + 'px', height: hgt + 'px' });
      const cw0 = f.cv.clientWidth, ch0 = f.cv.clientHeight, sw = Math.max(40, cw0 || Math.round(visw - 16)), shh = Math.max(30, ch0 || Math.round(hgt - 44)), dpr = DPRV();   // the real size of the screen: circles stay circles
      if (f.cv.width !== Math.round(sw * dpr) || f.cv.height !== Math.round(shh * dpr)) { f.cv.width = Math.round(sw * dpr); f.cv.height = Math.round(shh * dpr); f.w = sw; f.h = shh; f.g.setTransform(dpr, 0, 0, dpr, 0, 0); f.g.lineJoin = 'round'; f.g.lineCap = 'round'; if (f.idx >= 0) pick(f, f.idx); }
    });
  }
  window.addEventListener('sidepanels-layout', layout);
  new ResizeObserver(layout).observe(root); setTimeout(layout, 0); setTimeout(layout, 400);
  frames.forEach(f => { f.w = 200; f.h = 300; });


  /* ---- speakers: a stereo pair filling the screen, 3 models; drivers pump with the bass of the playing music.
     Realistic details: wood-vinyl cabinet with grain, bevel and gloss (drawn once and cached), baffle with screws, metal frames with bolts, rubber surrounds,
     brushed-metal cones with ridges, specular dust caps and domes, a port tube, feet and a floor reflection; the cabinet shakes a little with the bass. */
  const SPK = ['TOWER', 'SUBWOOFER', 'MONITOR'];
  const texCache = {};
  const spkRnd = n => { const s = Math.sin(n * 12.9898) * 43758.5453; return s - Math.floor(s); };
  function cabinetTex(w, h) {
    const k = Math.round(w) + 'x' + Math.round(h); if (texCache[k]) return texCache[k];
    const c = document.createElement('canvas'); c.width = Math.max(2, Math.ceil(w)); c.height = Math.max(2, Math.ceil(h)); const g = c.getContext('2d'), rad = Math.min(16, w * 0.07);
    const base = g.createLinearGradient(0, 0, w, 0); base.addColorStop(0, '#0e0f12'); base.addColorStop(0.16, '#1c1e24'); base.addColorStop(0.5, '#292b33'); base.addColorStop(0.84, '#1a1c21'); base.addColorStop(1, '#0c0d10');
    g.fillStyle = base; g.beginPath(); g.roundRect(0.5, 0.5, w - 1, h - 1, rad); g.fill();
    g.save(); g.clip(); g.lineWidth = 0.7;   // fine wood-vinyl grain
    for (let i = 0; i < h / 2.4; i++) { const y = i * 2.4 + spkRnd(i) * 1.5; g.globalAlpha = 0.04 + spkRnd(i + 99) * 0.06; g.strokeStyle = i % 3 ? '#ffffff' : '#000000'; g.beginPath(); g.moveTo(0, y); g.bezierCurveTo(w * 0.3, y + spkRnd(i + 5) * 3 - 1.5, w * 0.7, y + spkRnd(i + 9) * 3 - 1.5, w, y + spkRnd(i + 3) * 2 - 1); g.stroke(); }
    g.globalAlpha = 1;
    const sheen = g.createLinearGradient(0, 0, w * 0.9, h * 0.6); sheen.addColorStop(0, 'rgba(255,255,255,.14)'); sheen.addColorStop(0.35, 'rgba(255,255,255,.03)'); sheen.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sheen; g.fillRect(0, 0, w, h); g.restore();
    g.lineWidth = 1.6; g.strokeStyle = 'rgba(255,255,255,.22)'; g.beginPath(); g.moveTo(rad, 1); g.lineTo(w - rad, 1); g.moveTo(1, rad); g.lineTo(1, h - rad); g.stroke();   // bevel highlight
    g.strokeStyle = 'rgba(0,0,0,.7)'; g.beginPath(); g.moveTo(rad, h - 1); g.lineTo(w - rad, h - 1); g.moveTo(w - 1, rad); g.lineTo(w - 1, h - rad); g.stroke();
    const m = Math.max(6, w * 0.05), bf = g.createLinearGradient(0, m, 0, h - m); bf.addColorStop(0, '#0b0c0f'); bf.addColorStop(1, '#14151a');   // recessed baffle
    g.fillStyle = bf; g.beginPath(); g.roundRect(m, m, w - m * 2, h - m * 2, rad * 0.6); g.fill(); g.strokeStyle = 'rgba(0,0,0,.85)'; g.lineWidth = 2; g.stroke(); g.strokeStyle = 'rgba(255,255,255,.07)'; g.lineWidth = 1; g.beginPath(); g.roundRect(m + 1.5, m + 1.5, w - m * 2 - 3, h - m * 2 - 3, rad * 0.5); g.stroke();
    for (const [sx, sy] of [[m + 6, m + 6], [w - m - 6, m + 6], [m + 6, h - m - 6], [w - m - 6, h - m - 6]]) spkScrew(g, sx, sy, Math.max(2, w * 0.012));
    return texCache[k] = c;
  }
  function spkScrew(g, x, y, r) {
    const rg = g.createRadialGradient(x - r * 0.3, y - r * 0.3, 0.3, x, y, r); rg.addColorStop(0, '#9a9ea8'); rg.addColorStop(1, '#2a2c33'); g.fillStyle = rg; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill();
    g.strokeStyle = '#0008'; g.lineWidth = Math.max(0.8, r * 0.3); g.beginPath(); g.moveTo(x - r * 0.6, y); g.lineTo(x + r * 0.6, y); g.stroke();
  }
  function cone(g, cx, cy, r, ex, col, glow) {
    // metal frame with bolts, rubber surround (ridged, lit from the top-left), brushed-metal cone with ridges, specular dust cap; ex (0..1) = excursion
    const fr = r * 1.2; let rg = g.createRadialGradient(cx - fr * 0.4, cy - fr * 0.4, fr * 0.2, cx, cy, fr); rg.addColorStop(0, '#50545e'); rg.addColorStop(1, '#16171b');
    g.fillStyle = rg; g.beginPath(); g.arc(cx, cy, fr, 0, TAU); g.fill(); g.strokeStyle = '#000a'; g.lineWidth = 1.5; g.stroke();
    for (let k = 0; k < 4; k++) { const an = Math.PI / 4 + k * Math.PI / 2; spkScrew(g, cx + Math.cos(an) * fr * 0.9, cy + Math.sin(an) * fr * 0.9, Math.max(1.6, r * 0.05)); }
    const sr = r * 1.04, sg = g.createLinearGradient(cx - sr, cy - sr, cx + sr, cy + sr); sg.addColorStop(0, '#3b3e46'); sg.addColorStop(0.5, '#0c0d10'); sg.addColorStop(1, '#2a2c33');
    g.strokeStyle = sg; g.lineWidth = r * 0.16; g.beginPath(); g.arc(cx, cy, sr * 0.96, 0, TAU); g.stroke();   // rubber roll
    g.strokeStyle = '#ffffff22'; g.lineWidth = 1; g.beginPath(); g.arc(cx, cy, sr * 1.03, Math.PI * 0.95, Math.PI * 1.6); g.stroke();
    const rr = r * (0.9 + ex * 0.045), off = ex * r * 0.03;
    g.save(); g.shadowColor = '#000'; g.shadowBlur = r * 0.12; g.shadowOffsetX = off; g.shadowOffsetY = off;
    const cg = g.createConicGradient ? g.createConicGradient(-2.3, cx, cy) : null;
    if (cg) { cg.addColorStop(0, '#59606c'); cg.addColorStop(0.12, '#2a2d34'); cg.addColorStop(0.3, '#1a1b20'); cg.addColorStop(0.5, '#34373f'); cg.addColorStop(0.68, '#16171b'); cg.addColorStop(0.86, '#2c2f36'); cg.addColorStop(1, '#59606c'); g.fillStyle = cg; }
    else { rg = g.createRadialGradient(cx - rr * 0.3, cy - rr * 0.3, rr * 0.05, cx, cy, rr); rg.addColorStop(0, '#4a4d56'); rg.addColorStop(1, '#0b0b0e'); g.fillStyle = rg; }
    g.beginPath(); g.arc(cx, cy, rr, 0, TAU); g.fill(); g.restore();
    rg = g.createRadialGradient(cx, cy, rr * 0.3, cx, cy, rr); rg.addColorStop(0, 'rgba(0,0,0,0)'); rg.addColorStop(1, 'rgba(0,0,0,.55)'); g.fillStyle = rg; g.beginPath(); g.arc(cx, cy, rr, 0, TAU); g.fill();   // depth towards the rim
    g.lineWidth = 0.8; for (let k = 1; k <= 7; k++) { g.strokeStyle = k % 2 ? '#ffffff14' : '#00000055'; g.beginPath(); g.arc(cx, cy, rr * (0.3 + k * 0.095) * (1 - ex * 0.015 * k), 0, TAU); g.stroke(); }
    const cap = rr * (0.3 + ex * 0.05); rg = g.createRadialGradient(cx - cap * 0.4, cy - cap * 0.45, cap * 0.05, cx, cy, cap); rg.addColorStop(0, '#d9dce4'); rg.addColorStop(0.35, '#8b909b'); rg.addColorStop(1, '#17181c');
    g.fillStyle = rg; g.beginPath(); g.arc(cx, cy, cap, 0, TAU); g.fill(); g.strokeStyle = '#000a'; g.lineWidth = 1; g.stroke();
    g.fillStyle = 'rgba(255,255,255,.55)'; g.beginPath(); g.ellipse(cx - cap * 0.3, cy - cap * 0.4, cap * 0.28, cap * 0.14, -0.6, 0, TAU); g.fill();   // specular
    g.save(); g.strokeStyle = col; g.globalAlpha = 0.22 + glow * 0.7; g.lineWidth = 1.6; g.shadowColor = col; g.shadowBlur = glow * 12; g.beginPath(); g.arc(cx, cy, fr * 1.02, 0, TAU); g.stroke(); g.restore();
  }
  function tweeter(g, cx, cy, r, ex, col) {
    const pr = r * 1.9, pg = g.createRadialGradient(cx - pr * 0.4, cy - pr * 0.4, pr * 0.1, cx, cy, pr); pg.addColorStop(0, '#4b4f59'); pg.addColorStop(1, '#14151a');
    g.fillStyle = pg; g.beginPath(); g.arc(cx, cy, pr, 0, TAU); g.fill(); g.strokeStyle = '#000a'; g.lineWidth = 1; g.stroke();
    g.lineWidth = 0.8; for (let k = 1; k <= 3; k++) { g.strokeStyle = k % 2 ? '#ffffff1a' : '#0007'; g.beginPath(); g.arc(cx, cy, r * (1.15 + k * 0.2), 0, TAU); g.stroke(); }   // waveguide grooves
    const dr = r * (1 + ex * 0.1), rg = g.createRadialGradient(cx - dr * 0.35, cy - dr * 0.4, dr * 0.05, cx, cy, dr); rg.addColorStop(0, '#f2f4f8'); rg.addColorStop(0.4, '#9aa0ac'); rg.addColorStop(1, '#2b2d34');
    g.fillStyle = rg; g.beginPath(); g.arc(cx, cy, dr, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,255,255,.7)'; g.beginPath(); g.ellipse(cx - dr * 0.3, cy - dr * 0.38, dr * 0.3, dr * 0.14, -0.6, 0, TAU); g.fill();
    g.save(); g.strokeStyle = col; g.globalAlpha = 0.35 + ex * 0.55; g.lineWidth = 1.2; g.shadowColor = col; g.shadowBlur = ex * 8; g.beginPath(); g.arc(cx, cy, pr * 1.02, 0, TAU); g.stroke(); g.restore();
  }
  function spkPort(g, cx, cy, r) {
    const rg = g.createRadialGradient(cx, cy, r * 0.1, cx, cy, r * 1.3); rg.addColorStop(0, '#000'); rg.addColorStop(0.7, '#050506'); rg.addColorStop(0.85, '#2a2c33'); rg.addColorStop(1, '#0d0e11');
    g.fillStyle = rg; g.beginPath(); g.arc(cx, cy, r * 1.3, 0, TAU); g.fill(); g.strokeStyle = 'rgba(255,255,255,.18)'; g.lineWidth = 1; g.beginPath(); g.arc(cx, cy, r * 1.3, Math.PI * 1.05, Math.PI * 1.7); g.stroke();
  }
  function spkLed(g, x, y, r, col, lvl) {
    g.save(); g.fillStyle = col; g.globalAlpha = 0.35 + lvl * 0.65; g.shadowColor = col; g.shadowBlur = 4 + lvl * 10; g.beginPath(); g.arc(x, y, r, 0, TAU); g.fill(); g.restore();
  }
  function oneSpeaker(g, model, x, y, w, h, bass, hi, col) {
    const feet = Math.min(10, h * 0.04), bh = h - feet;   // the cabinet stands on two feet
    g.save(); g.fillStyle = 'rgba(0,0,0,.55)'; g.filter = 'blur(5px)'; g.beginPath(); g.ellipse(x + w / 2, y + h + 1, w * 0.52, feet * 0.9, 0, 0, TAU); g.fill(); g.restore();
    for (const fx of [x + w * 0.16, x + w * 0.84 - w * 0.12]) { const fg = g.createLinearGradient(0, y + bh, 0, y + h); fg.addColorStop(0, '#3a3d45'); fg.addColorStop(1, '#0a0a0c'); g.fillStyle = fg; g.beginPath(); g.roundRect(fx, y + bh - 1, w * 0.12, feet + 1, 3); g.fill(); }
    const shake = bass * Math.min(1.6, w * 0.012) * (model === 1 ? 1.4 : 1);   // the cabinet trembles with the bass
    g.save(); g.translate((spkRnd(performance.now() * 0.05) - 0.5) * shake, (spkRnd(performance.now() * 0.05 + 7) - 0.5) * shake);
    g.drawImage(cabinetTex(w, bh), x, y);
    const cx = x + w / 2, B = Math.max(6, w * 0.05);
    if (model === 0) {          // tower: tweeter, midrange and woofer, port at the bottom
      const rw = Math.min(w * 0.3, bh * 0.17), rm = Math.min(w * 0.19, bh * 0.1);
      tweeter(g, cx, y + bh * 0.13, Math.min(w * 0.075, bh * 0.045), hi, col);
      cone(g, cx, y + bh * 0.31, rm, Math.min(1, bass * 0.7 + hi * 0.3), col, bass * 0.7);
      cone(g, cx, y + bh * 0.58, rw, bass, col, bass); spkPort(g, cx, y + bh * 0.86, Math.min(w * 0.07, bh * 0.04));
      spkLed(g, x + w - B - 12, y + bh - B - 10, 2.4, col, bass);
    } else if (model === 1) {   // subwoofer: one big driver with deep excursion, slot port below
      const r = Math.min(w * 0.4, bh * 0.38); cone(g, cx, y + bh * 0.46, r, Math.min(1, bass * 1.5), col, bass);
      g.fillStyle = '#050506'; g.beginPath(); g.roundRect(x + w * 0.22, y + bh - B - 14, w * 0.56, 7, 3); g.fill(); g.strokeStyle = '#ffffff22'; g.stroke();
      spkLed(g, x + w - B - 12, y + B + 12, 2.6, col, bass);
    } else {                    // studio monitor: tweeter with waveguide over a woofer, front port
      const r = Math.min(w * 0.31, bh * 0.25); tweeter(g, cx, y + bh * 0.2, Math.min(w * 0.09, bh * 0.06), hi, col);
      cone(g, cx, y + bh * 0.58, r, bass, col, bass); spkPort(g, cx, y + bh * 0.9, Math.min(w * 0.055, 6));
      spkLed(g, x + B + 12, y + bh - B - 10, 2.4, col, 0.4 + hi * 0.6);
    }
    g.restore();
  }
  F.speaker = {
    init() { return { cone: [0, 0] }; },
    draw(g, w, h, S, st, p) {   // a visual of its own (not an overlay): a stereo pair of speakers filling the screen, drivers pumping with the bass
      const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#101117'); gr.addColorStop(0.75, '#08090c'); gr.addColorStop(1, '#14151b'); g.fillStyle = gr; g.fillRect(0, 0, w, h);
      const fl = g.createRadialGradient(w / 2, h * 1.05, 4, w / 2, h * 1.05, w * 0.7); fl.addColorStop(0, 'rgba(255,255,255,.07)'); fl.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = fl; g.fillRect(0, h * 0.7, w, h * 0.3);   // light on the floor
      const bass = clamp(S.pulse * 0.55 + S.lvl * 0.6, 0, 1), hi = clamp(S.lvl * 1.2 + S.pulse * 0.2, 0, 1), col = S.pal[0];
      st.cone[0] += (bass - st.cone[0]) * (bass > st.cone[0] ? 0.7 : 0.25); st.cone[1] += (hi - st.cone[1]) * 0.4;
      const pad = Math.max(6, Math.min(w, h) * 0.06), sh = h - pad * 2, ratio = p.model === 1 ? 0.95 : p.model === 0 ? 0.52 : 0.68;   // a tower is tall and narrow, a sub nearly square, a monitor in between
      const sw = Math.min((w - pad * 3) / 2, sh * ratio), gap = Math.min(w * 0.08, Math.max(pad, (w - sw * 2) / 3)), x0 = (w - sw * 2 - gap) / 2;
      oneSpeaker(g, p.model, x0, pad, sw, sh, st.cone[0], st.cone[1], col); oneSpeaker(g, p.model, x0 + sw + gap, pad, sw, sh, st.cone[0], st.cone[1], col);
    },
  };

  const saved = frames.map(f => { try { const v = lsGet('visual.' + f.side, null); return Number.isInteger(v) && v >= 0 && v < COUNT ? v : null; } catch { return null; } });
pick(frames[0], saved[0] != null ? saved[0] : saved[1]);   // the two screens show one picture: the left choice wins, else the right one

  /* ---- animation at ~30 fps, paused when the DJ view is not showing */
  let last = performance.now(), acc = 0;
  function loop(now) {
    requestAnimationFrame(loop);
    const dt = Math.min(0.1, (now - last) / 1000); last = now; acc += dt; if (acc < (S.cost > 9 ? 0.032 : 0.0155)) return; S.dt = acc; acc = 0;
    if (document.hidden || root.offsetParent === null) return;
    const st = nat.state, level = st ? Math.max(...st.master) : 0, playing = decks.some(d => d.playing);
    const tl = clamp(playing ? Math.sqrt(level) * 1.5 : 0.2, 0, 1); S.lvl += (tl - S.lvl) * (tl > S.lvl ? 0.8 : 0.18);   // fast attack, quick release
    const dl = S.lvl - S.prevLvl; S.prevLvl = S.lvl; S.kick = Math.max(S.kick * 0.8, dl > 0.05 ? Math.min(1, dl * 4.5) : 0);   // transient: a sudden rise in level is a kick / hit
    const dk = decks.find(x => x.playing && x.an && x.an.bpm && Number.isFinite(x.an.grid)); let beat = (now / 1000) * bpmNow() / 60; if (dk) beat = (dk.pos() - dk.an.grid) / (60 / dk.an.bpm);   // beat phase of the playing track itself, so the visuals hit exactly on the beats
    S.pulse = Math.max(Math.exp(-(((beat % 1) + 1) % 1) * 5) * (playing ? 1 : 0.4), S.kick);
    S.t += S.dt;
    const m = frames[0], c = frames[1]; if (m.el.style.display === 'none' || !m.w) return;
    S.pal = m.pal; S.lut = m.lut; const pr = P[m.idx];   // drawn once, then copied: both screens show exactly the same picture
    m.g.globalAlpha = 1; const t0 = performance.now(); try { F[pr.f].draw(m.g, m.w, m.h, S, m.st, pr.p); } catch (e) { m.g.fillStyle = '#000'; m.g.fillRect(0, 0, m.w, m.h); } S.cost += (performance.now() - t0 - S.cost) * 0.1;
    if (m.flash > 0) { m.g.fillStyle = `rgba(255,255,255,${m.flash * 0.35})`; m.g.fillRect(0, 0, m.w, m.h); m.flash -= 0.12; }
    if (c.el.style.display !== 'none') { if (c.cv.width !== m.cv.width || c.cv.height !== m.cv.height) { c.cv.width = m.cv.width; c.cv.height = m.cv.height; } c.g.save(); c.g.setTransform(1, 0, 0, 1, 0, 0); c.g.drawImage(m.cv, 0, 0); c.g.restore(); }
  }
  requestAnimationFrame(loop);
  window.visuals = { frames, presets: P, count: COUNT, pick, layout };
})();
