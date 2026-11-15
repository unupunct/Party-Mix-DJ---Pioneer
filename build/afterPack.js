// On macOS: sign the packed app ad hoc (no certificate needed). Apple-silicon Macs will not start an app whose signature was broken by packaging.
const { execFileSync } = require('child_process'), path = require('path');
exports.default = async function (ctx) {
  if (ctx.electronPlatformName !== 'darwin') return;
  const app = path.join(ctx.appOutDir, ctx.packager.appInfo.productFilename + '.app');
  console.log('ad-hoc signing', app);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
