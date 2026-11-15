// Generates build/icon.png + build/icon.ico (vinyl record with two deck-coloured arcs). No dependencies.
const fs = require('fs'), zlib = require('zlib'), path = require('path');
const S = 1024, F = 4, px = Buffer.alloc(S * S * 4);
const cx = S / 2, cy = S / 2;   // geometry below is in 256-px units
function put(x, y, r, g, b, a) { const i = (y * S + x) * 4; const ia = a / 255, oa = px[i + 3] / 255, na = ia + oa * (1 - ia);
  if (na === 0) return; px[i] = (r * ia + px[i] * oa * (1 - ia)) / na; px[i + 1] = (g * ia + px[i + 1] * oa * (1 - ia)) / na; px[i + 2] = (b * ia + px[i + 2] * oa * (1 - ia)) / na; px[i + 3] = na * 255; }
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const dx = (x + 0.5 - cx) / F, dy = (y + 0.5 - cy) / F, d = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
  // rounded-square background
  const rx = Math.abs(dx) - (128 - 40), ry = Math.abs(dy) - (128 - 40), rr = Math.hypot(Math.max(rx, 0), Math.max(ry, 0)) + Math.min(Math.max(rx, ry), 0) - 40;
  const bg = Math.max(0, Math.min(1, (0.5 - rr) * F)); if (bg <= 0) continue;
  put(x, y, 18, 20, 28, 255 * bg);
  const disc = Math.max(0, Math.min(1, (0.5 - (d - 100)) * F)); if (disc > 0) put(x, y, 8, 8, 10, 255 * disc);
  if (d > 52 && d < 98 && Math.floor(d / 4) % 2 === 0) put(x, y, 40, 44, 56, 120);
  const ring = (r0, r1) => Math.max(0, Math.min(1, (Math.min(d - r0, r1 - d) + 0.5) * F));
  const rg = ring(84, 92);                                       // coloured arcs: blue (left) / orange (right)
  if (rg > 0) { const left = Math.cos(ang) < 0; const wedge = Math.abs(Math.sin(ang)) < 0.82; if (wedge) left ? put(x, y, 25, 184, 255, 255 * rg) : put(x, y, 255, 122, 26, 255 * rg); }
  const lab = Math.max(0, Math.min(1, (0.5 - (d - 34)) * F)); if (lab > 0) put(x, y, 25, 184, 255, 255 * lab);
  const hole = Math.max(0, Math.min(1, (0.5 - (d - 6)) * F)); if (hole > 0) put(x, y, 18, 20, 28, 255 * hole);
}
function crc(buf) { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  let v = 0xffffffff; for (const b of buf) v = t[(v ^ b) & 255] ^ (v >>> 8); return (v ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); }
const raw = Buffer.alloc((S * 4 + 1) * S); for (let y = 0; y < S; y++) { raw[y * (S * 4 + 1)] = 0; px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4); }
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
const out = path.join(__dirname, '..', 'build'); fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'icon-mac.png'), png); process.exit(0);
const dir = Buffer.alloc(22); dir.writeUInt16LE(0, 0); dir.writeUInt16LE(1, 2); dir.writeUInt16LE(1, 4);
dir[6] = 0; dir[7] = 0; dir[8] = 0; dir[9] = 0; dir.writeUInt16LE(1, 10); dir.writeUInt16LE(32, 12); dir.writeUInt32LE(png.length, 14); dir.writeUInt32LE(22, 18);
fs.writeFileSync(path.join(out, 'icon.ico'), Buffer.concat([dir, png]));
console.log('icon written', png.length, 'bytes');
