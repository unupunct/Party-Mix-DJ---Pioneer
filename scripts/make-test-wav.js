// Usage: [BPM=128] node make-test-wav.js <out.wav> [seconds=60] [artist] [title]
// Writes a 120 BPM kick/snare/hat test track; with artist/title it also embeds RIFF INFO tags (IART/INAM).
const fs = require('fs');
const [out, secsArg, artist, title] = process.argv.slice(2);
const sr = 44100, bpm = Number(process.env.BPM) || 120, secs = Number(secsArg) || 60, n = sr * secs;
const info = (id, s) => { const t = Buffer.from(s + '\0'); const pad = t.length % 2 ? Buffer.from([0]) : Buffer.alloc(0); const h = Buffer.alloc(8); h.write(id, 0); h.writeUInt32LE(t.length, 4); return Buffer.concat([h, t, pad]); };
let list = Buffer.alloc(0);
if (artist || title) { const body = Buffer.concat([Buffer.from('INFO'), artist ? info('IART', artist) : Buffer.alloc(0), title ? info('INAM', title) : Buffer.alloc(0)]); const h = Buffer.alloc(8); h.write('LIST', 0); h.writeUInt32LE(body.length, 4); list = Buffer.concat([h, body]); }
const data = Buffer.alloc(n * 4);
const beat = 60 / bpm; let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
for (let i = 0; i < n; i++) {
  const t = i / sr, bt = (t - 0.25) % beat, bi = Math.floor((t - 0.25) / beat); let x = 0;
  if (t >= 0.25) {
    x += Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-bt * 30)) * bt) * Math.exp(-bt * 9) * 0.9;
    if (bi % 2 == 1) x += rnd() * Math.exp(-bt * 18) * 0.5;
    const ht = (t - 0.25 + beat / 2) % beat; x += rnd() * Math.exp(-ht * 70) * 0.25;
  }
  const v = Math.max(-1, Math.min(1, x * 0.8)) * 32000; data.writeInt16LE(v, i * 4); data.writeInt16LE(v, i * 4 + 2);
}
const fmt = Buffer.alloc(24); fmt.write('fmt ', 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(1, 8); fmt.writeUInt16LE(2, 10); fmt.writeUInt32LE(sr, 12); fmt.writeUInt32LE(sr * 4, 16); fmt.writeUInt16LE(4, 20); fmt.writeUInt16LE(16, 22);
const dh = Buffer.alloc(8); dh.write('data', 0); dh.writeUInt32LE(data.length, 4);
const body = Buffer.concat([Buffer.from('WAVE'), fmt, list, dh, data]);
const riff = Buffer.alloc(8); riff.write('RIFF', 0); riff.writeUInt32LE(body.length, 4);
fs.writeFileSync(out, Buffer.concat([riff, body]));
