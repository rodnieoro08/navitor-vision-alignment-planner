/* NavViews: canvas rendering helpers (plane views, heat map, projection diagram, polar diagram, straightened view). */
(function (root) {
  'use strict';
  const M = root.NavMath;
  const dot = M.dot;

  class PlaneView {
    constructor(canvas, cfg) {
      this.canvas = canvas; this.ctx = canvas.getContext('2d'); this.W = canvas.width; this.H = canvas.height; this.cfg = cfg;
      this.cu = 0; this.cv = 0; this.mm = 1; this.dirty = true;
      this.off = document.createElement('canvas'); this.off.width = this.W; this.off.height = this.H;
      this.offCtx = this.off.getContext('2d'); this.img = this.offCtx.createImageData(this.W, this.H); this.buf32 = new Uint32Array(this.img.data.buffer);
    }
    frame() { return this.cfg.frame(); }
    toWorld(px, py) { const f = this.frame(); const a = this.cu + (px - this.W / 2) * this.mm, b = this.cv + (py - this.H / 2) * this.mm; return [f.o[0] + f.u[0] * a + f.v[0] * b, f.o[1] + f.u[1] * a + f.v[1] * b, f.o[2] + f.u[2] * a + f.v[2] * b]; }
    toScreen(P) { const f = this.frame(), d = [P[0] - f.o[0], P[1] - f.o[1], P[2] - f.o[2]]; return [this.W / 2 + (dot(d, f.u) - this.cu) / this.mm, this.H / 2 + (dot(d, f.v) - this.cv) / this.mm]; }
    depth(P) { const f = this.frame(); return dot([P[0] - f.o[0], P[1] - f.o[1], P[2] - f.o[2]], f.n); }
    fit(extentU, extentV, cu, cv) { this.mm = Math.max(extentU / this.W, extentV / this.H) * 1.04; this.cu = cu || 0; this.cv = cv || 0; this.dirty = true; }
    zoomAt(px, py, factor) {
      const before = this.pxToPlane(px, py);
      this.mm = Math.min(Math.max(this.mm / factor, 0.05), 8);
      const after = this.pxToPlane(px, py);
      this.cu += before[0] - after[0]; this.cv += before[1] - after[1]; this.dirty = true;
    }
    pxToPlane(px, py) { return [this.cu + (px - this.W / 2) * this.mm, this.cv + (py - this.H / 2) * this.mm]; }
    renderImage() {
      const vol = this.cfg.volume(), f = this.frame();
      if (!vol || !f) { this.offCtx.fillStyle = '#111'; this.offCtx.fillRect(0, 0, this.W, this.H); this.dirty = false; return; }
      const wl = this.cfg.wl(), P00 = this.toWorld(0, 0);
      vol.renderPlane(this.buf32, this.W, this.H, P00, f.u.map((x) => x * this.mm), f.v.map((x) => x * this.mm), wl.c, wl.w);
      this.offCtx.putImageData(this.img, 0, 0); this.dirty = false;
    }
    // The cached CT image is re-rendered whenever anything that determines it changed (plane position/orientation, pan/zoom, window/level, volume),
    // not only when a caller remembers to set `dirty` (scrolling moved only the overlay before: slices appeared frozen).
    imageKey() {
      const vol = this.cfg.volume(), f = this.frame(); if (!vol || !f) return 'none';
      const wl = this.cfg.wl(); if (this._vol !== vol) { this._vol = vol; this._vid = (this._vid || 0) + 1; }
      return [this._vid, f.o[0].toFixed(4), f.o[1].toFixed(4), f.o[2].toFixed(4), f.u[0].toFixed(5), f.u[1].toFixed(5), f.u[2].toFixed(5), f.v[0].toFixed(5), f.v[1].toFixed(5), f.v[2].toFixed(5), this.mm, this.cu, this.cv, wl.c, wl.w].join('|');
    }
    draw() {
      const key = this.imageKey(); if (key !== this._key) { this.dirty = true; this._key = key; }
      if (this.dirty) this.renderImage();
      this.ctx.drawImage(this.off, 0, 0);
      if (this.cfg.overlay) this.cfg.overlay(this, this.ctx);
    }
  }

  const PLASMA = [[13, 8, 135], [106, 0, 168], [177, 42, 144], [225, 100, 98], [252, 166, 54], [240, 249, 33]];
  function plasma(t) {
    t = Math.min(Math.max(t, 0), 1) * (PLASMA.length - 1); const i = Math.min(Math.floor(t), PLASMA.length - 2), f = t - i;
    return PLASMA[i].map((v, k) => Math.round(v + (PLASMA[i + 1][k] - v) * f));
  }
  const HM = { cell: 6, ox: 56, oy: 22 };
  function drawHeatmap(canvas, g, st) {
    const ctx = canvas.getContext('2d'), { cell, ox, oy } = HM;
    ctx.fillStyle = '#12161c'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!g) { ctx.fillStyle = '#9aa'; ctx.font = '14px sans-serif'; ctx.fillText('Place centreline, H markers and compute A markers first', ox + 40, oy + 100); return; }
    for (let ci = 0; ci < g.nC; ci++) for (let li = 0; li < g.nL; li++) {
      const k = ci * g.nL + li, x = ox + li * cell, y = oy + (g.nC - 1 - ci) * cell;
      const sideOk = !st.side || st.side === 'any' || (st.side === 'left' && g.pairSide[k] === -1) || (st.side === 'right' && g.pairSide[k] === 1);
      if (g.valid[k] && sideOk) { const c = plasma(g.margin[k] / Math.max(g.best, 1e-6)); ctx.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`; }
      else ctx.fillStyle = g.valid[k] ? '#3a3f48' : (g.is21[k] ? '#2b2f36' : '#1c2128');
      ctx.fillRect(x, y, cell, cell);
      if (g.valid[k] && !g.stable[k] && sideOk) { ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(x + 1, y + 1, cell - 2, cell - 2); }
    }
    // axes
    ctx.strokeStyle = '#556'; ctx.lineWidth = 1; ctx.strokeRect(ox - .5, oy - .5, g.nL * cell + 1, g.nC * cell + 1);
    ctx.fillStyle = '#cfd8dc'; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
    for (let l = -60; l <= 60; l += 10) { const x = ox + (l + 60) * cell + cell / 2; ctx.fillText((l > 0 ? '+' : '') + l, x, oy + g.nC * cell + 14); ctx.beginPath(); ctx.moveTo(x, oy + g.nC * cell); ctx.lineTo(x, oy + g.nC * cell + 3); ctx.stroke(); }
    ctx.textAlign = 'right';
    for (let c = -40; c <= 40; c += 10) { const y = oy + (40 - c) * cell + cell / 2 + 4; ctx.fillText((c > 0 ? '+' : '') + c, ox - 6, y); }
    ctx.textAlign = 'center'; ctx.font = '12px sans-serif';
    ctx.fillText('◄ RAO (−)          LAO angle (°)          LAO (+) ►', ox + g.nL * cell / 2, oy + g.nC * cell + 30);
    ctx.save(); ctx.translate(14, oy + g.nC * cell / 2); ctx.rotate(-Math.PI / 2); ctx.fillText('◄ CAUD (−)     CRAN angle (°)     CRAN (+) ►', 0, 0); ctx.restore();
    // zero lines
    ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(ox + 60 * cell + cell / 2, oy); ctx.lineTo(ox + 60 * cell + cell / 2, oy + g.nC * cell); ctx.moveTo(ox, oy + 40 * cell + cell / 2); ctx.lineTo(ox + g.nL * cell, oy + 40 * cell + cell / 2); ctx.stroke(); ctx.setLineDash([]);
    const pos = (a) => [ox + (a.lao + 60) * cell + cell / 2, oy + (40 - a.cran) * cell + cell / 2];
    (st.best || []).forEach((a, i) => { const [x, y] = pos(a); ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(x, y, 6, 0, 7); ctx.stroke(); ctx.fillStyle = '#fff'; ctx.font = 'bold 10px sans-serif'; ctx.fillText('S' + (i + 1), x, y - 9); });
    (st.prac || []).forEach((a, i) => { const [x, y] = pos(a); ctx.strokeStyle = '#4dd0e1'; ctx.lineWidth = 2; ctx.strokeRect(x - 5, y - 5, 10, 10); ctx.fillStyle = '#4dd0e1'; ctx.font = 'bold 10px sans-serif'; ctx.fillText('P' + (i + 1), x, y + 17); });
    if (st.sel) { const [x, y] = pos(st.sel); ctx.strokeStyle = '#ff1744'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(x - 10, y); ctx.lineTo(x + 10, y); ctx.moveTo(x, y - 10); ctx.lineTo(x, y + 10); ctx.stroke(); }
  }
  function heatmapAngleAt(g, px, py) {
    const li = Math.floor((px - HM.ox) / HM.cell), ci = g.nC - 1 - Math.floor((py - HM.oy) / HM.cell);
    if (li < 0 || li >= g.nL || ci < 0 || ci >= g.nC) return null;
    return { lao: g.laoMin + li, cran: g.cranMin + ci, k: ci * g.nL + li };
  }

  /* Simulated projection: axis drawn vertical (image rotated to straighten the projected axis); markers at their lateral offset. */
  function drawProjDiagram(canvas, o) {
    const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center'; ctx.fillStyle = '#111'; ctx.font = 'bold 13px sans-serif'; ctx.fillText(o.title, W / 2, 18);
    const r = o.pts.every(Boolean) ? M.evalViewProjected(o.C, o.a, o.pts, o.lao, o.cran) : null;
    if (!r || r.degenerate) { ctx.font = '13px sans-serif'; ctx.fillStyle = '#777'; ctx.fillText(r ? 'Beam parallel to the axis - undefined' : 'Markers not available', W / 2, H / 2); return null; }
    const cx = W / 2, cy = H / 2 + 6, k = o.scale || 5.5;
    ctx.fillStyle = '#e8f1fb'; ctx.fillRect(0, 28, cx, H - 28); ctx.fillStyle = '#fdf0e3'; ctx.fillRect(cx, 28, cx, H - 28);
    ctx.fillStyle = '#6a8bb0'; ctx.font = '11px sans-serif'; ctx.fillText('IMAGE LEFT', cx / 2, H - 8); ctx.fillStyle = '#b08a5e'; ctx.fillText('IMAGE RIGHT', cx + cx / 2, H - 8);
    // nominal ring radius
    const rads = o.pts.map((P) => { const v = M.sub(P, o.C); return M.len(M.sub(v, M.mul(o.a, M.dot(v, o.a)))); }), rho = rads.reduce((a, b) => a + b, 0) / rads.length;
    ctx.strokeStyle = '#9aa7b3'; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx - rho * k, 40); ctx.lineTo(cx - rho * k, H - 22); ctx.moveTo(cx + rho * k, 40); ctx.lineTo(cx + rho * k, H - 22); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = '#222'; ctx.lineWidth = 1.5; ctx.setLineDash([10, 4, 2, 4]); ctx.beginPath(); ctx.moveTo(cx, 36); ctx.lineTo(cx, H - 22); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#222'; ctx.font = '10px sans-serif'; ctx.fillText('projected centreline axis', cx, 46);
    const cls = M.classify(r.markers.map((m) => m.s), o.minMargin || 0);
    r.markers.forEach((m, i) => {
      const x = cx + m.s * k, y = cy - m.w * k * 0.35 - 0; // along-axis offsets are shown compressed (x0.35)
      ctx.beginPath(); if (o.shape === 'diamond') { ctx.moveTo(x, y - 11); ctx.lineTo(x + 11, y); ctx.lineTo(x, y + 11); ctx.lineTo(x - 11, y); ctx.closePath(); } else ctx.arc(x, y, 10, 0, 7);
      ctx.fillStyle = o.colors[i]; ctx.fill(); ctx.strokeStyle = '#000'; ctx.lineWidth = 1.2; ctx.stroke();
      ctx.fillStyle = '#000'; ctx.font = 'bold 11px sans-serif'; ctx.fillText(o.labels[i], x, y - 15);
      ctx.font = '10px sans-serif'; ctx.fillText((m.s >= 0 ? '+' : '') + m.s.toFixed(1) + ' mm', x, y + 25);
      ctx.strokeStyle = 'rgba(0,0,0,0.25)'; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(cx, y); ctx.lineTo(x, y); ctx.stroke(); ctx.setLineDash([]);
    });
    const nL = r.markers.filter((m) => m.s < 0).length, nR = r.markers.length - nL;
    ctx.fillStyle = cls.is21 ? '#0a6b2d' : '#a33'; ctx.font = 'bold 14px sans-serif';
    ctx.fillText(nL + ' left : ' + nR + ' right' + (cls.is21 ? '  (2:1)' : '  (not 2:1)'), W / 2, 64);
    ctx.fillStyle = '#444'; ctx.font = '10px sans-serif'; ctx.fillText('axis tilt on image: ' + r.tilt.toFixed(0) + '° from vertical (diagram rotated to show it vertical)', W / 2, 78);
    return { cls, res: r, nL, nR };
  }

  /* Small schematic fluoro screen for an overlap-projection solution (no CT pixels). o = {item (M.overlapProjections item), labels, colors}.
   * Dark screen, projected centreline axis drawn vertical (dashed), image LEFT / RIGHT as in the C-arm tab; the overlapped pair is drawn as a filled diamond inside a ring, the lone marker as a single diamond. */
  function drawOverlapView(canvas, o) {
    const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height, it = o.item, cx = W / 2, cy = H / 2 + 2;
    ctx.fillStyle = '#05080b'; ctx.fillRect(0, 0, W, H); ctx.strokeStyle = '#33414f'; ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
    ctx.setLineDash([6, 4]); ctx.strokeStyle = '#7b8b9b'; ctx.beginPath(); ctx.moveTo(cx, 16); ctx.lineTo(cx, H - 16); ctx.stroke(); ctx.setLineDash([]);
    ctx.textAlign = 'center'; ctx.font = '10px sans-serif'; ctx.fillStyle = '#8fa1b3'; ctx.fillText('projected axis', cx, 11);
    ctx.textAlign = 'left'; ctx.fillText('LEFT', 6, H - 5); ctx.textAlign = 'right'; ctx.fillText('RIGHT', W - 6, H - 5);
    const maxAbs = Math.max(8, ...it.s.map((v) => Math.abs(v))), k = Math.min(6, (cx - 30) / maxAbs);
    const dia = (x, y, r, fill, stroke, lw) => { ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath(); if (fill) { ctx.fillStyle = fill; ctx.fill(); } ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.stroke(); };
    const pos = (i) => [cx + it.s[i] * k, cy - it.w[i] * k * 0.35];
    ctx.textAlign = 'center';
    const [lx, ly] = pos(it.lone); dia(lx, ly, 9, o.colors[it.lone], '#000', 1.2);
    ctx.fillStyle = '#e3eaf1'; ctx.font = 'bold 11px sans-serif'; ctx.fillText(o.labels[it.lone], lx, ly - 15); ctx.font = '10px sans-serif'; ctx.fillStyle = '#8fa1b3'; ctx.fillText('alone', lx, ly + 25);
    const [p1x, p1y] = pos(it.pair[0]), [p2x, p2y] = pos(it.pair[1]);
    dia(p2x, p2y, 14, null, o.colors[it.pair[1]], 2.5); dia(p1x, p1y, 8, o.colors[it.pair[0]], '#000', 1.2);
    ctx.fillStyle = '#e3eaf1'; ctx.font = 'bold 11px sans-serif'; ctx.fillText(o.labels[it.pair[0]] + ' + ' + o.labels[it.pair[1]], (p1x + p2x) / 2, Math.min(p1y, p2y) - 20); ctx.font = '10px sans-serif'; ctx.fillStyle = '#8fa1b3';
    ctx.fillText('overlap (Δ ' + it.residual.toFixed(2) + ' mm)', (p1x + p2x) / 2, Math.max(p1y, p2y) + 28);
  }

  /* Schematic cross-section (no CT pixels): H and A angular positions about the centreline, plus the beam plane trace. */
  function drawPolar(canvas, o) {
    const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height, cx = W / 2, cy = H / 2 + 6, R = Math.min(W, H) / 2 - 34;
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.fillStyle = '#111'; ctx.textAlign = 'center'; ctx.font = 'bold 13px sans-serif'; ctx.fillText(o.title || 'Angular positions about the centreline', W / 2, 16);
    ctx.strokeStyle = '#999'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(cx, cy, R, 0, 7); ctx.stroke();
    ctx.font = '10px sans-serif'; ctx.fillStyle = '#555';
    for (let a = 0; a < 360; a += 30) {
      const t = a * M.D2R, x1 = cx + Math.cos(t) * R, y1 = cy + Math.sin(t) * R;
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(t) * (R - 6), cy + Math.sin(t) * (R - 6)); ctx.lineTo(x1, y1); ctx.stroke();
      ctx.fillText(a + '°', cx + Math.cos(t) * (R + 15), cy + Math.sin(t) * (R + 15) + 3);
    }
    ctx.fillStyle = '#777'; ctx.fillText('0° = reference axis N1 (right); clockwise, looking along apex → descending aorta', cx, H - 6);
    const maxRho = Math.max(1, ...[...(o.H || []), ...(o.A || [])].map((m) => m.rho)), sc = R / (maxRho * 1.15);
    if (o.beam) { // dividing line = plane of axis+beam; n2 = image-right direction in this plane (screen coords x=N1,y=N2)
      const n = o.beam.n2, nl = Math.hypot(n[0], n[1]);
      if (nl > 1e-6) {
        const nx = n[0] / nl, ny = n[1] / nl, tx = -ny, ty = nx;
        const thn = Math.atan2(ny, nx); ctx.fillStyle = 'rgba(255,152,0,0.10)'; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, R, thn - Math.PI / 2, thn + Math.PI / 2, false); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#e65100'; ctx.lineWidth = 2; ctx.setLineDash([8, 4]); ctx.beginPath(); ctx.moveTo(cx - tx * R, cy - ty * R); ctx.lineTo(cx + tx * R, cy + ty * R); ctx.stroke(); ctx.setLineDash([]);
        ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + nx * R * 0.55, cy + ny * R * 0.55); ctx.stroke();
        ctx.fillStyle = '#e65100'; ctx.font = 'bold 11px sans-serif'; ctx.fillText('image RIGHT side', cx + nx * R * 0.7, cy + ny * R * 0.7);
        ctx.fillText('image LEFT side', cx - nx * R * 0.7, cy - ny * R * 0.7);
        ctx.font = '10px sans-serif'; ctx.fillText('beam-plane trace (' + o.beam.label + ')', cx + tx * R * 0.72, cy + ty * R * 0.72 - 6);
      }
    }
    const draw = (list, shape, rScale) => (list || []).forEach((m) => {
      const t = m.phi * M.D2R, x = cx + Math.cos(t) * m.rho * sc * rScale, y = cy + Math.sin(t) * m.rho * sc * rScale;
      ctx.strokeStyle = m.color; ctx.lineWidth = 1; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(x, y); ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); if (shape === 'diamond') { ctx.moveTo(x, y - 9); ctx.lineTo(x + 9, y); ctx.lineTo(x, y + 9); ctx.lineTo(x - 9, y); ctx.closePath(); } else ctx.arc(x, y, 8, 0, 7);
      ctx.fillStyle = shape === 'diamond' ? '#fff' : m.color; ctx.fill(); ctx.strokeStyle = m.color; ctx.lineWidth = 2.5; ctx.stroke();
      ctx.fillStyle = '#000'; ctx.font = 'bold 10px sans-serif'; ctx.fillText(m.label + ' ' + Math.round(((m.phi % 360) + 360) % 360) + '°', x, y - 13);
    });
    draw(o.H, 'circle', 1); draw(o.A, 'diamond', 0.78);
    ctx.fillStyle = '#000'; ctx.beginPath(); ctx.arc(cx, cy, 2.5, 0, 7); ctx.fill();
    ctx.font = '10px sans-serif'; ctx.fillStyle = '#333'; ctx.textAlign = 'left'; ctx.fillText('● H (annulus/SOV)   ◇ A (descending aorta)', 8, H - 20);
  }

  /* Straightened (stretched) vessel view: columns = arc length, rows = offset along direction alpha in the RMF cross-section */
  function renderCPR(canvas, vol, cl, alphaDeg, wl, halfRangeMm) {
    const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
    if (!vol || !cl) { ctx.fillStyle = '#111'; ctx.fillRect(0, 0, W, H); return null; }
    const img = ctx.createImageData(W, H), b32 = new Uint32Array(img.data.buffer), a = alphaDeg * M.D2R, ca = Math.cos(a), sa = Math.sin(a);
    const lo = wl.c - wl.w / 2, scale = 255 / wl.w, mmPerPx = 2 * halfRangeMm / H;
    for (let x = 0; x < W; x++) {
      const f = M.frameAt(cl, cl.length * x / (W - 1)), ex = f.N1[0] * ca + f.N2[0] * sa, ey = f.N1[1] * ca + f.N2[1] * sa, ez = f.N1[2] * ca + f.N2[2] * sa;
      for (let y = 0; y < H; y++) {
        const off = (y - H / 2) * mmPerPx, h = vol.sample([f.C[0] + ex * off, f.C[1] + ey * off, f.C[2] + ez * off]);
        if (h !== h) b32[y * W + x] = 0xFF1A1A1A; else { let g = (h - lo) * scale; g = g < 0 ? 0 : g > 255 ? 255 : g | 0; b32[y * W + x] = 0xFF000000 | (g << 16) | (g << 8) | g; }
      }
    }
    ctx.putImageData(img, 0, 0);
    return { px: (s) => s / cl.length * (W - 1), py: (off) => H / 2 + off / mmPerPx, mmPerPx };
  }

  root.NavViews = { PlaneView, drawHeatmap, heatmapAngleAt, drawProjDiagram, drawOverlapView, drawPolar, renderCPR, plasma, HM };
})(typeof self !== 'undefined' ? self : this);
