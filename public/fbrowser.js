'use strict';
/* Browse PC: the "Browse PC" button turns the playlist area into a folder browser, like the browser of other DJ programs: a tree of quick links (Music, Desktop, ...), drives and
   folders on the left, and the audio files of the chosen folder in the list instead of the playlist (same A / B buttons and double-click loading; + adds a track to the playlist).
   Pressing the button again brings the playlist back. The small + next to a folder adds everything in it (with sub-folders) to the playlist.
   Needs globals from app.js: playlist, sel, renderPlaylist, fetchMeta, addPaths, newId, toast, persistPlaylist, lsGet, lsSet. */
(() => {
  const lib = document.getElementById('library'), tree = document.getElementById('fbtree'), btn = document.getElementById('btnAdd'), title = document.getElementById('libTitle');
  if (!lib || !tree || !btn || !window.electronAPI || !window.electronAPI.fsRoots) { const a = document.getElementById('fbrowser'); if (a) a.hidden = true; return; }
  const api = window.electronAPI, esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  let saved = null, selNode = null, folderPath = lsGet('browseFolder', ''), built = false;

  function node(entry, depth, kind) {
    const el = document.createElement('div'); el.className = 'fbn ' + (kind || ''); el.style.setProperty('--d', depth);
    el.innerHTML = `<span class="tg">▸</span><span class="nm" title="${esc(entry.path)}">${kind === 'link' ? '★ ' : kind === 'drive' ? '▣ ' : '▪ '}${esc(entry.name)}</span><button class="ad" title="Add every track in this folder (with sub-folders) to the playlist">＋</button>`;
    const kids = document.createElement('div'); kids.hidden = true; let loaded = false;
    const tg = el.querySelector('.tg');
    const toggle = async open => {
      if (open === undefined) open = kids.hidden;
      if (open && !loaded) { loaded = true; const dirs = await api.fsDirs(entry.path); for (const d of dirs) { const n = node(d, depth + 1); kids.append(n.el, n.kids); } if (!dirs.length) tg.textContent = '·'; }
      kids.hidden = !open; if (tg.textContent !== '·') tg.textContent = open ? '▾' : '▸';
    };
    tg.onclick = e => { e.stopPropagation(); toggle(); };
    el.onclick = () => { if (selNode) selNode.classList.remove('sel'); selNode = el; el.classList.add('sel'); showFolder(entry.path); };
    el.ondblclick = () => toggle();
    el.querySelector('.ad').onclick = async e => {
      e.stopPropagation(); const items = await api.scanPaths([entry.path]); if (!items.length) return toast('No audio files in ' + entry.name);
      const had = saved ? saved.list.length : playlist.length, list = saved ? saved.list : playlist, have = new Set(list.map(i => i.path));
      for (const it of items) if (!have.has(it.path)) list.push({ id: newId(), name: it.name, path: it.path, dur: 0, bpm: 0 });
      const keep = window.__folderView; window.__folderView = false; try { persistPlaylist(); } finally { window.__folderView = keep; }
      toast(`Added ${list.length - had} track${list.length - had === 1 ? '' : 's'} from ${entry.name} to the playlist`);
    };
    return { el, kids };
  }
  async function build() {
    tree.textContent = ''; built = true;
    for (const r of await api.fsRoots()) { const n = node(r, 0, r.kind); tree.append(n.el, n.kids); }
  }

  async function showFolder(p) {
    folderPath = p; lsSet('browseFolder', p);
    const files = await api.fsAudio(p);
    const old = new Map((saved ? saved.list : []).filter(i => i.path).map(i => [i.path, i]));
    playlist = files.map(f => old.get(f.path) || { id: newId(), name: f.name, path: f.path, dur: 0, bpm: 0 });
    sel = playlist.length ? 0 : -1;
    title.textContent = '📁 ' + (p.length > 38 ? '…' + p.slice(-37) : p); title.title = p;
    renderPlaylist(); fetchMeta();
    if (!files.length) toast('No audio files directly in this folder: open a sub-folder, or use the + to add all of them.', 4000);
  }
  async function enter() {
    if (window.__folderView) return;
    saved = { list: playlist, sel }; window.__folderView = true; lib.classList.add('browsing'); btn.classList.add('on'); btn.textContent = '📋 Playlist';
    btn.title = 'Back to your playlist';
    if (!built) await build();
    if (folderPath) await showFolder(folderPath); else { playlist = []; sel = -1; title.textContent = '📁 Browse'; renderPlaylist(); }
  }
  function leave() {
    if (!window.__folderView) return;
    window.__folderView = false; if (saved) { playlist = saved.list; sel = Math.min(saved.sel, playlist.length - 1); } saved = null;
    lib.classList.remove('browsing'); btn.classList.remove('on'); btn.textContent = '📂 Browse PC'; btn.title = 'Browse this PC: the playlist switches to a folder browser; press again to go back';
    title.textContent = 'Playlist'; title.title = '';
    renderPlaylist();
  }
  function addToPlaylist(it) {
    if (!saved) return;
    if (saved.list.some(i => i.path === it.path)) return toast('Already in the playlist');
    saved.list.push({ id: newId(), name: it.name, path: it.path, dur: it.dur || 0, bpm: it.bpm || 0, artist: it.artist, title: it.title });
    const keep = window.__folderView; window.__folderView = false; try { persistPlaylist(); } finally { window.__folderView = keep; }
    toast('Added to the playlist: ' + it.name);
  }
  const toggle = () => (window.__folderView ? leave() : enter());

  document.getElementById('fbRefresh').onclick = build;
  window.fbrowser = { enter, leave, toggle, addToPlaylist, build, showFolder, get folderPath() { return folderPath; } };
})();
