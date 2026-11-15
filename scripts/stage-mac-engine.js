// Copies the compiled macOS engine binaries to engine/dist-mac/<arch>/djengine, where electron-builder takes them from.
// On a Mac: cargo build --release --target aarch64-apple-darwin (arm64) and --target x86_64-apple-darwin (x64) first (the CI workflow does this).
const fs = require('fs'), path = require('path');
const map = { arm64: 'aarch64-apple-darwin', x64: 'x86_64-apple-darwin' };
for (const [arch, triple] of Object.entries(map)) {
  const src = path.join(__dirname, '..', 'engine', 'target', triple, 'release', 'djengine'), dst = path.join(__dirname, '..', 'engine', 'dist-mac', arch, 'djengine');
  if (!fs.existsSync(src)) { console.error('missing ' + src + ': build it with  cargo build --release --target ' + triple + ' --manifest-path engine/Cargo.toml'); process.exit(1); }
  fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); fs.chmodSync(dst, 0o755); console.log('staged', arch);
}
