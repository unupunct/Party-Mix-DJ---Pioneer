'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const AUDIO_RE = /\.(mp3|wav|flac|m4a|aac|ogg|opus|aif|aiff|wma)$/i;
const SELFTEST = process.env.DJ_SELFTEST === '1';

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (!SELFTEST && !app.requestSingleInstanceLock()) { app.quit(); }

let win;
// Self-test runs use a throwaway profile so they never touch the user's real settings/playlist.
if (SELFTEST) app.setPath('userData', fs.mkdtempSync(path.join(app.getPath('temp'), 'ddjsbdj-test-')));

function scanPaths(paths, depth = 0, out = []) {
  for (const p of paths) {
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (depth > 4) continue;
      let names = []; try { names = fs.readdirSync(p); } catch {}
      names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      scanPaths(names.map(n => path.join(p, n)), depth + 1, out);
    } else if (AUDIO_RE.test(p)) out.push(p);
  }
  return out;
}
const toItems = list => list.map(p => ({ path: p, name: path.basename(p) }));

ipcMain.handle('run-driver-installer', async () => {   // Windows: start Pioneer's DDJ-SB driver installer that ships with the app (it asks for administrator rights itself)
  if (process.platform !== 'win32') return { ok: false, reason: 'Windows only' };
  const cands = [path.join(process.resourcesPath || '', 'drivers', 'Pioneer_DDJ_SB_Driver_1.100.exe'), path.join(__dirname, '..', 'drivers', 'Pioneer_DDJ_SB_Driver_1.100.exe')];
  const f = cands.find(p => fs.existsSync(p)); if (!f) return { ok: false, reason: 'the driver installer was not found' };
  const err = await shell.openPath(f); return err ? { ok: false, reason: err } : { ok: true };
});
ipcMain.handle('pick-files', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Add tracks', properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'aif', 'aiff', 'wma'] }, { name: 'All files', extensions: ['*'] }],
  });
  return r.canceled ? [] : toItems(r.filePaths);
});
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Add folder', properties: ['openDirectory'] });
  return r.canceled ? [] : toItems(scanPaths(r.filePaths));
});
/* ---- M3U / M3U8 / PLS playlists and internet radio addresses */
function parsePlaylistText(text, baseDir) {
  const out = [], lines = String(text).replace(/^\uFEFF/, '').split(/\r?\n/); let title = '';
  const pls = {}, isPls = /^\s*\[playlist\]/i.test(text);
  const add = (ref, name) => {
    ref = ref.trim(); if (!ref) return;
    if (/^https?:\/\//i.test(ref)) out.push({ kind: 'url', url: ref, name: name || ref });
    else { let p = ref.replace(/^file:\/\/\/?/i, ''); try { p = decodeURIComponent(p); } catch {} if (!path.isAbsolute(p)) p = path.resolve(baseDir || '.', p); out.push({ kind: 'file', path: p, name: name || path.basename(p) }); }
  };
  if (isPls) {
    for (const l of lines) { const mm = /^(File|Title)(\d+)=(.*)$/i.exec(l.trim()); if (mm) (pls[mm[2]] = pls[mm[2]] || {})[mm[1].toLowerCase()] = mm[3]; }
    Object.keys(pls).sort((a, b) => a - b).forEach(k => pls[k].file && add(pls[k].file, pls[k].title));
    return out.slice(0, 5000);
  }
  for (const l0 of lines) {
    const l = l0.trim(); if (!l) continue;
    if (l.startsWith('#')) { const mm = /^#EXTINF:[^,]*,(.*)$/i.exec(l); if (mm) title = mm[1].trim(); continue; }
    add(l, title); title = '';
  }
  return out.slice(0, 5000);
}
ipcMain.handle('pick-playlist-file', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Open playlist (.m3u / .m3u8 / .pls)', properties: ['openFile'], filters: [{ name: 'Playlists', extensions: ['m3u', 'm3u8', 'pls'] }, { name: 'All files', extensions: ['*'] }] });
  if (r.canceled || !r.filePaths[0]) return { entries: [] };
  try {
    const p = r.filePaths[0], st = fs.statSync(p);
    if (st.size > 5e6) return { error: 'That file is too large for a playlist.' };
    return { entries: parsePlaylistText(fs.readFileSync(p, 'utf8'), path.dirname(p)), name: path.basename(p) };
  } catch (e) { return { error: String(e.message || e) }; }
});
ipcMain.handle('fetch-playlist-url', async (_e, url) => {
  url = String(url || '').trim();
  if (!/^https?:\/\/[^\s]+$/i.test(url)) return { error: 'Enter an address that starts with http:// or https://' };
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'DDJSBDJ' } });
    const ct = String(res.headers.get('content-type') || '').toLowerCase();
    const looksList = /mpegurl|scpls|text\/plain|text\/html/.test(ct) || /\.(m3u8?|pls)(\?|$)/i.test(url);
    if (!res.ok) return { error: 'The server answered ' + res.status };
    if (!looksList) { try { await res.body.cancel(); } catch {} return { entries: [{ kind: 'url', url, name: new URL(url).hostname }] }; }   // a direct stream
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 2e6) return { error: 'That playlist is too large.' };
    const text = buf.toString('utf8');
    if (/#EXT-X-(STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE)/.test(text)) return { error: 'This is an HLS stream (.m3u8 segments). Only normal radio streams (MP3 / AAC / Ogg) and playlists of them are supported.' };
    if (!/^\s*(#EXTM3U|\[playlist\])/i.test(text) && !/^https?:\/\//im.test(text)) return { entries: [{ kind: 'url', url, name: new URL(url).hostname }] };
    return { entries: parsePlaylistText(text, null) };
  } catch (e) { return { error: e.name === 'AbortError' ? 'No answer from the server within 8 seconds.' : String(e.message || e) }; }
  finally { clearTimeout(timer); }
});
/* ---- controller test: a READ-ONLY inventory of the controller (USB interfaces, Windows audio outputs with volume and mute) and saving of the report */
const HW_PS = "$ErrorActionPreference = 'SilentlyContinue'\nAdd-Type -TypeDefinition @'\nusing System; using System.Runtime.InteropServices;\n[ComImport, Guid(\"BCDE0395-E52F-467C-8E3D-C4579291692E\")] public class MMDeviceEnumeratorCom2 {}\n[ComImport, Guid(\"A95664D2-9614-4F35-A746-DE8DB63617E6\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]\npublic interface IMMDeviceEnumerator2 { int EnumAudioEndpoints(int f, int m, out IntPtr d); int GetDefaultAudioEndpoint(int f, int r, out IMMDevice2 d); int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice2 d); }\n[ComImport, Guid(\"D666063F-1587-4E43-81F1-B948E807363F\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]\npublic interface IMMDevice2 { int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }\n[ComImport, Guid(\"5CDF2C82-841E-4546-9722-0CF74078229A\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]\npublic interface IAudioEndpointVolume2 {\n  int RegisterControlChangeNotify(IntPtr p); int UnregisterControlChangeNotify(IntPtr p); int GetChannelCount(out uint n);\n  int SetMasterVolumeLevel(float l, ref Guid c); int SetMasterVolumeLevelScalar(float l, ref Guid c); int GetMasterVolumeLevel(out float l); int GetMasterVolumeLevelScalar(out float l);\n  int SetChannelVolumeLevel(uint ch, float l, ref Guid c); int SetChannelVolumeLevelScalar(uint ch, float l, ref Guid c); int GetChannelVolumeLevel(uint ch, out float l); int GetChannelVolumeLevelScalar(uint ch, out float l);\n  int SetMute([MarshalAs(UnmanagedType.Bool)] bool m, ref Guid c); int GetMute([MarshalAs(UnmanagedType.Bool)] out bool m);\n}\npublic class VolInfo {\n  public static string Read(string id) {\n    var e = (IMMDeviceEnumerator2)new MMDeviceEnumeratorCom2(); IMMDevice2 d; e.GetDevice(id, out d);\n    Guid g = new Guid(\"5CDF2C82-841E-4546-9722-0CF74078229A\"); object o; d.Activate(ref g, 23, IntPtr.Zero, out o);\n    var v = (IAudioEndpointVolume2)o; float s; bool mu; v.GetMasterVolumeLevelScalar(out s); v.GetMute(out mu);\n    return \"volume=\" + Math.Round(s * 100) + \"% mute=\" + mu;\n  }\n}\n'@\n$usb = @(Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match 'VID_15E4' } | ForEach-Object { [pscustomobject]@{ name = $_.FriendlyName; class = $_.Class; status = $_.Status; service = $_.Service; id = $_.InstanceId } })\n$ep = @(Get-PnpDevice -Class AudioEndpoint -PresentOnly | Where-Object { $_.InstanceId -match '\\{0\\.0\\.0\\.' } | ForEach-Object { $id = ($_.InstanceId -replace '^SWD\\\\MMDEVAPI\\\\', ''); $vi = $null; try { $vi = [VolInfo]::Read($id) } catch {}; [pscustomobject]@{ name = $_.FriendlyName; id = $id; info = $vi } })\n[pscustomobject]@{ usb = $usb; endpoints = $ep } | ConvertTo-Json -Depth 4 -Compress";
ipcMain.handle('hw-inventory', () => new Promise(resolve => {
  if (process.platform !== 'win32') return resolve({ usb: [], endpoints: [], error: 'Windows only' });
  const { spawn } = require('child_process');
  let out = '', done = false; const fin = v => { if (!done) { done = true; resolve(v); } };
  try {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(HW_PS, 'utf16le').toString('base64')], { windowsHide: true });
    p.stdout.on('data', d => { out += d; }); p.on('error', e => fin({ usb: [], endpoints: [], error: e.message }));
    p.on('close', () => { try { const j = JSON.parse(out.trim()); const arr = x => (x == null ? [] : Array.isArray(x) ? x : [x]); fin({ usb: arr(j.usb), endpoints: arr(j.endpoints) }); } catch (e) { fin({ usb: [], endpoints: [], error: 'could not read: ' + e.message }); } });
    setTimeout(() => { try { p.kill(); } catch {} fin({ usb: [], endpoints: [], error: 'timeout' }); }, 20000);
  } catch (e) { fin({ usb: [], endpoints: [], error: e.message }); }
}));
ipcMain.handle('hw-save-report', (_e, name, md, json, quiet) => {
  const dir = path.join(app.getPath('documents'), 'DDJ-SB DJ reports'); fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19), base = path.join(dir, String(name || 'report').replace(/[^\w.-]/g, '_') + '-' + stamp);
  fs.writeFileSync(base + '.md', String(md)); fs.writeFileSync(base + '.json', String(json)); if (!quiet) { try { shell.showItemInFolder(base + '.md'); } catch {} }
  return base + '.md';
});
/* ---- folder browser (Browse PC): quick links, drives, sub-folders, audio files of one folder */
ipcMain.handle('fs-roots', () => {
  const out = [];
  for (const [label, key] of [['Music', 'music'], ['Desktop', 'desktop'], ['Downloads', 'downloads'], ['Documents', 'documents'], ['Home', 'home']]) {
    try { const p = app.getPath(key); if (fs.existsSync(p)) out.push({ name: label, path: p, kind: 'link' }); } catch {}
  }
  if (process.platform === 'win32') for (let c = 67; c <= 90; c++) { const p = String.fromCharCode(c) + ':\\'; try { if (fs.existsSync(p)) out.push({ name: p, path: p, kind: 'drive' }); } catch {} }
  else out.push({ name: '/', path: '/', kind: 'drive' });
  return out;
});
ipcMain.handle('fs-list-dirs', (_e, p) => {
  try {
    return fs.readdirSync(String(p), { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.') && !d.name.startsWith('$') && d.name !== 'System Volume Information')
      .map(d => ({ name: d.name, path: path.join(String(p), d.name) })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  } catch { return []; }
});
ipcMain.handle('fs-list-audio', (_e, p) => {
  try {
    const names = fs.readdirSync(String(p), { withFileTypes: true }).filter(d => d.isFile() && AUDIO_RE.test(d.name)).map(d => d.name).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return names.slice(0, 3000).map(n => ({ path: path.join(String(p), n), name: n }));
  } catch { return []; }
});
ipcMain.handle('scan-paths', (_e, paths) => toItems(scanPaths(Array.isArray(paths) ? paths : [])));
// ---------------------------------------------------------------- native audio engine (separate process)
const { spawn } = require('child_process');
const readline = require('readline');
let engine = null, engineRestarts = 0, quitting = false;
const engineExe = () => {
  const exeName = process.platform === 'win32' ? 'djengine.exe' : 'djengine';
  const cands = [path.join(process.resourcesPath || '', exeName), path.join(__dirname, '..', 'engine', 'target', 'release', exeName)];
  return cands.find(p => { try { return fs.statSync(p).isFile(); } catch { return false; } }) || null;
};
function toRenderer(ev) { if (win && !win.isDestroyed()) win.webContents.send('engine-event', ev); }
function startEngine() {
  if (process.env.DJ_ENGINE === 'off') return toRenderer({ evt: 'engineUnavailable', reason: 'disabled by DJ_ENGINE=off' });
  const exe = engineExe();
  if (!exe) return toRenderer({ evt: 'engineUnavailable', reason: 'the audio engine was not found' });
  try { engine = spawn(exe, [], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env: { ...process.env, DJ_LIBRARY: path.join(app.getPath('userData'), 'library.db') } }); }
  catch (e) { return toRenderer({ evt: 'engineUnavailable', reason: String(e) }); }
  readline.createInterface({ input: engine.stdout }).on('line', l => { try { toRenderer(JSON.parse(l)); } catch {} });
  engine.stdin.on('error', () => {});
  engine.on('exit', code => {
    engine = null;
    if (quitting) return;
    toRenderer({ evt: 'engineExit', code });
    if (engineRestarts++ < 3) setTimeout(() => { startEngine(); toRenderer({ evt: 'engineRestarted', attempt: engineRestarts }); }, 800);
    else toRenderer({ evt: 'engineUnavailable', reason: 'engine kept crashing' });
  });
}
ipcMain.on('engine-send', (_e, cmd) => { if (engine && engine.stdin.writable && cmd && typeof cmd === 'object') engine.stdin.write(JSON.stringify(cmd) + '\n'); });
ipcMain.handle('engine-start', () => { if (!engine && !quitting) { engineRestarts = 0; startEngine(); } return !!engineExe(); });
app.on('before-quit', () => { quitting = true; if (engine) { try { engine.stdin.write('{"cmd":"quit"}\n'); } catch {} setTimeout(() => { try { engine && engine.kill(); } catch {} }, 300); } });

let mmPromise;
ipcMain.handle('read-meta', async (_e, paths) => {
  mmPromise = mmPromise || import('music-metadata');
  const mm = await mmPromise, list = Array.isArray(paths) ? paths.filter(p => typeof p === 'string' && AUDIO_RE.test(p)) : [], out = {};
  let i = 0;
  const worker = async () => {
    while (i < list.length) {
      const p = list[i++];
      try { const md = await mm.parseFile(p, { skipCovers: true }); out[p] = { artist: md.common.artist || '', title: md.common.title || '', album: md.common.album || '', genre: (md.common.genre || []).join(', '), dur: md.format.duration || 0 }; }
      catch { out[p] = { artist: '', title: '', dur: 0 }; }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
});
ipcMain.handle('read-file', async (_e, p) => {
  if (typeof p !== 'string' || !AUDIO_RE.test(p)) throw new Error('Not an audio file');
  const b = await fs.promises.readFile(p);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
});

let userLeftFs = false, userToggle = false;
const fsLog = m => { try { fs.appendFileSync(path.join(app.getPath('userData'), 'fullscreen.log'), new Date().toISOString() + ' ' + m + '\n'); } catch {} };
function toggleFs() {   // F11 / the toolbar button: fullscreen <-> maximised window
  if (!win || win.isDestroyed()) return;
  if (win.isFullScreen()) { userLeftFs = true; userToggle = true; win.setFullScreen(false); } else win.setFullScreen(true);
}
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 900, minWidth: 900, minHeight: 640,
    title: 'DDJ-SB DJ', backgroundColor: '#0c0d10', show: !SELFTEST ? false : true, fullscreen: !SELFTEST, fullscreenable: true,
    icon: path.join(__dirname, '..', 'build', 'icon.ico'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
  });
  win.once('ready-to-show', () => { win.show(); if (!SELFTEST) for (const ms of [0, 300, 1200, 3000, 6000]) setTimeout(() => { if (!win.isDestroyed() && !win.isFullScreen() && !userLeftFs) { fsLog('retry fullscreen at ' + ms + ' ms'); win.setFullScreen(true); } }, ms); });   // fill the screen: the whole console is visible without scrolling
  win.setMenuBarVisibility(false); win.setAutoHideMenuBar(true);
  // starts fullscreen; F11 toggles to a maximised window (and back) so the window always fills the screen
  win.webContents.on('before-input-event', (e, i) => { if (i.type === 'keyDown' && i.key === 'F11') { e.preventDefault(); toggleFs(); } });
  win.on('enter-full-screen', () => fsLog('entered fullscreen'));
  win.on('leave-full-screen', () => { fsLog('left fullscreen (user toggle: ' + userToggle + ')'); if (!SELFTEST && !win.isDestroyed() && userToggle) { userToggle = false; win.maximize(); } });
  ipcMain.removeHandler('toggle-fullscreen'); ipcMain.handle('toggle-fullscreen', () => { toggleFs(); return true; });
  if (process.env.DJ_FS_LOG) setTimeout(() => { try { fs.writeFileSync(process.env.DJ_FS_LOG, JSON.stringify({ fs: win.isFullScreen(), max: win.isMaximized(), b: win.getBounds() })); } catch {} }, 4000);
  win.loadFile(path.join(__dirname, '..', 'public', 'index.html'), SELFTEST ? { query: { selftest: '1' } } : undefined);
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', e => e.preventDefault());
  if (SELFTEST) win.webContents.once('did-finish-load', () => runSelfTest());
}

async function runSelfTest() {
  const out = process.env.DJ_SELFTEST_OUT || path.join(app.getPath('temp'), 'ddjsbdj-selftest.json');
  let result;
  try {
    const code = fs.readFileSync(process.env.DJ_SELFTEST_SCRIPT || path.join(__dirname, 'selftest.js'), 'utf8');
    const cfg = { wav: process.env.DJ_SELFTEST_WAV || '', wav2: process.env.DJ_SELFTEST_WAV2 || '', dir: process.env.DJ_SELFTEST_DIR || '', engine: process.env.DJ_ENGINE || '', shot: !!process.env.DJ_SELFTEST_SHOT, shotView: process.env.DJ_SELFTEST_SHOT_VIEW || 'hm' };
    result = await win.webContents.executeJavaScript(`(${code})(${JSON.stringify(cfg)})`, true);
  } catch (e) { result = { ok: false, error: String(e && e.stack || e) }; }
  fs.writeFileSync(out, JSON.stringify(result, null, 2));
  if (process.env.DJ_SELFTEST_SHOT) { try { if (!process.env.DJ_SHOT_KEEP) await win.webContents.executeJavaScript("document.querySelectorAll('dialog[open]').forEach(d=>d.close())"); await new Promise(r => setTimeout(r, 1200)); fs.writeFileSync(process.env.DJ_SELFTEST_SHOT, (await win.webContents.capturePage()).toPNG()); } catch {} }   // the app's own window only
  app.exit(result.ok ? 0 : 1);
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  // The app itself needs MIDI (controller) and media (to reveal audio output device names).
  // Needs: MIDI (controller; Electron reports it as midiSysex), media (reveals output device names), speaker-selection (setSinkId). Our local page only.
  const allowed = new Set(['midi', 'midiSysex', 'media', 'audioCapture', 'speaker-selection']);
  const isOurs = url => typeof url === 'string' && url.startsWith('file:');
  const log = process.env.DJ_PERMLOG ? m => fs.appendFileSync(process.env.DJ_PERMLOG, m + '\n') : () => {};
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => {
    const ok = allowed.has(perm) && isOurs(details && details.requestingUrl || wc.getURL());
    log(`request ${perm} url=${details && details.requestingUrl} wc=${wc.getURL()} -> ${ok}`); cb(ok);
  });
  session.defaultSession.setPermissionCheckHandler((wc, perm, origin, details) => {
    const ok = allowed.has(perm) && (isOurs(origin) || !origin);
    log(`check ${perm} origin=${origin} req=${details && details.requestingUrl} -> ${ok}`); return ok;
  });
  createWindow();
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
