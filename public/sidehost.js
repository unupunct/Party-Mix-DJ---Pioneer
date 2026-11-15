'use strict';
/* Page layout host. One design: three columns that line up top to bottom.
     centre column  = the waveforms (same width as the mixer) above the mixer;
     left column    = a visual above the LOOP CONTROL + SLICER panel;  right column = a visual above the XY MULTI-FX pad.
   This file computes the geometry from the mixer's scale (consoleSkin) and publishes it as CSS variables on #djview (--boardx: left edge of the mixer, --colw: width of a side column, --colx: its left offset);
   panels register with sideHost.add(side, element) and are placed beside the mixer, the visuals (visuals.js) and the waveform padding (CSS) read the variables. */
(() => {
  const root = document.getElementById('decks'), view = document.getElementById('djview'); if (!root || !view || !window.consoleSkin) return;
  const panels = { left: null, right: null }, MAXW = 640, MARGIN = 14, GAP = 12;
  const geom = { boardx: 14, colw: 0, colx: 14, top: 0, hgt: 0, show: false };
  function fitContent(el) {   // shrink the inside of a panel (never its box) until everything fits
    const body = el.querySelector('.lpbody'); if (!body) return;
    let z = 1; el.style.setProperty('--lz', 1);
    for (let i = 0; i < 14 && body.scrollHeight > body.clientHeight + 1 && z > 0.55; i++) { z = Math.round((z - 0.04) * 100) / 100; el.style.setProperty('--lz', z); }
  }
  function layout() {
    const sk = window.consoleSkin, K = sk.scale, W = root.clientWidth, H = root.clientHeight; if (!W || !H) return;
    const boardW = 820 * K, sl = (W - boardW) / 2, free = Math.floor(sl - GAP - MARGIN);        // free width beside the mixer inside #decks
    const colw = Math.max(0, Math.min(MAXW, free)), colx = MARGIN + Math.floor((free - colw) / 2);  // panels are centred in that space (and capped, so they keep their proportions)
    const top = Math.round((H - 454 * K) / 2 + 8 * K), hgt = Math.round(438 * K);
    const show = colw >= 200 && hgt > 180, visw = Math.round(colw / 2);   // the visuals are half the width of a side panel and sit at the outer margins; the waveforms take all the room between them
    Object.assign(geom, { boardx: Math.round(14 + sl), colw, colx: colx + 14, top, hgt, show, visw, wpad: show ? colx + 14 + visw + 12 : 14 });
    view.style.setProperty('--boardx', geom.boardx + 'px'); view.style.setProperty('--visw', visw + 'px'); view.style.setProperty('--wpad', geom.wpad + 'px'); view.style.setProperty('--colw', colw + 'px'); view.style.setProperty('--colx', geom.colx + 'px'); view.style.setProperty('--sidegap', Math.round(sl) + 'px');
    for (const side of ['left', 'right']) {
      const el = panels[side]; if (!el) continue;
      el.style.display = geom.show ? '' : 'none'; if (!geom.show) continue;
      Object.assign(el.style, { left: (side === 'left' ? colx : W - colx - colw) + 'px', top: top + 'px', width: colw + 'px', height: hgt + 'px' });
      fitContent(el);
    }
    window.dispatchEvent(new CustomEvent('sidepanels-layout', { detail: geom }));
  }
  const host = { add(side, el) { panels[side] = el; el.classList.add('sidepanel', side); root.appendChild(el); layout(); }, layout, geom, get panels() { return panels; } };
  window.sideHost = host;
  new ResizeObserver(layout).observe(root); new ResizeObserver(layout).observe(view); setTimeout(layout, 0); setTimeout(layout, 400);
  window.addEventListener('resize', layout);
})();
