'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  toggleFullscreen: () => ipcRenderer.invoke('toggle-fullscreen'),
  pickFiles: () => ipcRenderer.invoke('pick-files'),
  pickPlaylist: () => ipcRenderer.invoke('pick-playlist-file'),
  fetchPlaylist: url => ipcRenderer.invoke('fetch-playlist-url', url),
  fsRoots: () => ipcRenderer.invoke('fs-roots'),
  fsDirs: p => ipcRenderer.invoke('fs-list-dirs', p),
  fsAudio: p => ipcRenderer.invoke('fs-list-audio', p),
  runDriverInstaller: () => ipcRenderer.invoke('run-driver-installer'),
  hwInventory: () => ipcRenderer.invoke('hw-inventory'),
  hwSaveReport: (n, md, json) => ipcRenderer.invoke('hw-save-report', n, md, json),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  scanPaths: paths => ipcRenderer.invoke('scan-paths', paths),
  readFile: p => ipcRenderer.invoke('read-file', p),
  readMeta: paths => ipcRenderer.invoke('read-meta', paths),
  engine: {
    start: () => ipcRenderer.invoke('engine-start'),
    send: cmd => ipcRenderer.send('engine-send', cmd),
    onEvent: cb => { ipcRenderer.on('engine-event', (_e, ev) => cb(ev)); },
  },
  pathForFile: f => { try { return webUtils.getPathForFile(f); } catch { return ''; } },
});
