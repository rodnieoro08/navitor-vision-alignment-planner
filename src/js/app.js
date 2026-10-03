/* Navitor Vision commissural alignment planner - application logic (client-side only). */
(function () {
  'use strict';
  const M = NavMath, V = NavViews, D = NavDicom, VOL = NavVolume, PH = NavPhantom, NN = NavNadir, Q = NavMPR;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1);
  const fv = (P) => P ? '(' + P.map(f1).join(', ') + ')' : '—';

  const GROUPS = {
    nadir: { keys: ['NCC', 'LCC', 'RCC'], label: (k) => 'Nadir ' + k, short: (k) => 'n' + k[0], color: { NCC: '#ffd600', LCC: '#d50000', RCC: '#00c853' } },   // NCC yellow, LCC red, RCC green (triangles; H = circles, A = diamonds)
    H: { keys: ['NL', 'NR', 'LR'], label: (k) => 'H_' + k, short: (k) => 'H_' + k, color: { NL: '#ff5252', NR: '#69f0ae', LR: '#448aff' } },
    A: { keys: ['NL', 'NR', 'LR'], label: (k) => 'A_' + k, short: (k) => 'A_' + k, color: { NL: '#ff5252', NR: '#69f0ae', LR: '#448aff' } }
  };
  const HK = GROUPS.H.keys;
  const S = {
    vol: null, source: '', truth: null, volId: 0,
    m: { nadir: { NCC: null, LCC: null, RCC: null }, H: { NL: null, NR: null, LR: null }, cl: [], A: { NL: null, NR: null, LR: null } },
    p: { smoothMm: 4, annAuto: true, annS: null, descS: null, refMode: 'own', radMode: 'keep', fixedR: 12, cprAngle: 0, minMargin: 2, pracFrac: 0.7, side: 'any', stableOnly: false },
    wl: { c: 200, w: 700 }, cross: [0, 0, 0], tool: 'nav', active: 'axial', hover: null, invertScroll: false, orient: Q.identity(), seed: null, auto: { prev: null, result: null, src: {}, hsrc: {} },
    cl: null, clVer: 0, sH: null, sD: null, tr: null, scan: null, axis: null, rankBest: [], rankPrac: [], sel: null, selManual: false, tab: 'load', seriesScan: null, meta: { id: '', age: '', note: '' }
  };

  const CL_COLOR = '#00e5ff';   // centreline points / polyline: cyan (was yellow; yellow is now the NCC colour)
  /* ---------------- marker model ---------------- */
  function allMarkers() {
    const out = [];
    for (const g of ['nadir', 'H']) for (const k of GROUPS[g].keys) if (S.m[g][k]) out.push({ id: g + '.' + k, group: g, key: k, label: GROUPS[g].short(k), color: GROUPS[g].color[k], pos: S.m[g][k] });
    S.m.cl.forEach((P, i) => out.push({ id: 'cl.' + i, group: 'cl', key: i, label: 'C' + (i + 1), color: CL_COLOR, pos: P }));
    if (S.seed) out.push({ id: 'seed.0', group: 'seed', key: 0, label: 'seed', color: '#e040fb', pos: S.seed });
    for (const k of GROUPS.A.keys) if (S.m.A[k]) out.push({ id: 'A.' + k, group: 'A', key: k, label: 'A_' + k, color: GROUPS.A.color[k], pos: S.m.A[k].pos });
    return out;
  }
  function setMarkerPos(id, P) {
    const [g, k] = id.split('.');
    if (g === 'cl') S.m.cl[+k] = P; else if (g === 'A') S.m.A[k] = { pos: P, manual: true }; else if (g === 'seed') S.seed = P; else { S.m[g][k] = P; if (g === 'nadir') S.auto.src[k] = 'manual'; if (g === 'H') (S.auto.hsrc = S.auto.hsrc || {})[k] = 'manual'; }
  }
  function deleteMarker(id) {
    const [g, k] = id.split('.');
    if (g === 'cl') S.m.cl.splice(+k, 1); else if (g === 'A') { if (S.m.A[k]) S.m.A[k].manual = false; } else if (g === 'seed') S.seed = null; else { S.m[g][k] = null; if (g === 'nadir') S.auto.src[k] = 'manual'; if (g === 'H') (S.auto.hsrc = S.auto.hsrc || {})[k] = 'manual'; }
    S.selManual = S.selManual && true; onChanged();
  }
  function placeMarker(tool, P) {
    const [g, k] = tool.split('.');
    if (g === 'seed') { S.seed = P; S.tool = 'nav'; S.cross = P.slice(); onChanged(true); return; }
    if (g === 'cl') {
      if ($('chkInsert').checked && S.m.cl.length >= 2) {
        let best = 1e18, bi = S.m.cl.length - 1;
        for (let i = 0; i < S.m.cl.length - 1; i++) {
          const a = S.m.cl[i], b = S.m.cl[i + 1], ab = M.sub(b, a), t = Math.min(Math.max(M.dot(M.sub(P, a), ab) / M.dot(ab, ab), 0), 1), d = M.dist(P, M.add(a, M.mul(ab, t)));
          if (d < best) { best = d; bi = i; }
        }
        S.m.cl.splice(bi + 1, 0, P);
      } else S.m.cl.push(P);
    } else {
      S.m[g][k] = P; if (g === 'nadir') S.auto.src[k] = 'manual'; if (g === 'H') (S.auto.hsrc = S.auto.hsrc || {})[k] = 'manual';
      if ($('chkAdvance').checked && g === 'H') { const nxt = { NL: 'H.NR', NR: 'H.LR', LR: 'nav' }[k]; S.tool = nxt; }
    }
    S.cross = P.slice(); onChanged(true);
  }

  /* ---------------- computation ---------------- */
  function defaultDescLevel(cl) {
    let zi = 0; for (let i = 0; i < cl.pts.length; i++) if (cl.pts[i][2] > cl.pts[zi][2]) zi = i;
    return Math.min(Math.max(cl.s[zi] - 80, 0.15 * cl.length), 0.9 * cl.length);
  }
  function update() {
    const p = S.p;
    S.cl = S.m.cl.length >= 2 ? M.buildCentreline(S.m.cl, { smoothMm: p.smoothMm, step: 0.5 }) : null; S.clVer++;
    S.tr = null; S.scan = null; S.axis = null; S.rankBest = []; S.rankPrac = [];
    if (!S.cl) { S.sH = S.sD = null; return; }
    const L = S.cl.length, Hs = {}; HK.forEach((k) => { if (S.m.H[k]) Hs[k] = S.m.H[k]; });
    const hk = Object.keys(Hs);
    if (hk.length && p.annAuto) { const cen = M.mul(hk.reduce((a, k) => M.add(a, Hs[k]), [0, 0, 0]), 1 / hk.length); S.sH = M.nearestS(S.cl, cen).s; }
    else S.sH = Math.min(Math.max(p.annS != null ? p.annS : 0.75 * L, 0), L);
    S.sD = Math.min(Math.max(p.descS != null ? p.descS : defaultDescLevel(S.cl), 0), L);
    if (hk.length) {
      S.tr = M.transferMarkers(S.cl, Hs, { sD: S.sD, refMode: p.refMode, sCommon: S.sH, radiusMode: p.radMode, fixedR: p.fixedR });
      HK.forEach((k) => { if (!S.m.A[k] || !S.m.A[k].manual) S.m.A[k] = S.tr[k] ? { pos: S.tr[k].A, manual: false } : null; });
    } else HK.forEach((k) => { if (S.m.A[k] && !S.m.A[k].manual) S.m.A[k] = null; });
    rescan();
  }
  function rescan() {
    S.scan = null; S.rankBest = []; S.rankPrac = [];
    if (!S.cl || !HK.every((k) => S.m.A[k])) return;
    const f = M.frameAt(S.cl, S.sD); S.axis = { C: f.C, a: f.T };
    S.scan = M.scanProjections(f.C, f.T, HK.map((k) => S.m.A[k].pos), { minMargin: S.p.minMargin });
    rerank();
  }
  function rerank() {
    if (!S.scan) return;
    const o = { side: S.p.side, stableOnly: S.p.stableOnly, count: 8 };
    S.rankBest = M.rankProjections(S.scan, Object.assign({ mode: 'margin' }, o));
    const ref = S.rankBest.length ? S.rankBest[0].margin : 0;
    S.rankPrac = M.rankProjections(S.scan, Object.assign({ mode: 'practical', frac: S.p.pracFrac, refBest: ref }, o));
    if (!S.sel || !S.selManual) { const t = S.rankPrac[0] || S.rankBest[0]; S.sel = t ? { lao: t.lao, cran: t.cran } : (S.sel || null); }
  }
  function selEval() {
    if (!S.sel || !S.axis) return null;
    const pts = HK.map((k) => S.m.A[k] && S.m.A[k].pos); if (!pts.every(Boolean)) return null;
    return M.evalViewFast(S.axis.C, S.axis.a, pts, S.sel.lao, S.sel.cran, S.p.minMargin);
  }

  /* ---------------- views ---------------- */
  const MPR = {            // static info only; the plane frames (u, v, n) come from the current orientation S.orient (NavMPR) - identity = classic axial / coronal / sagittal
    axial: { title: 'Axial', lab: ['R', 'L', 'A', 'P'] },
    coronal: { title: 'Coronal', lab: ['R', 'L', 'S', 'I'] },
    sagittal: { title: 'Sagittal', lab: ['A', 'P', 'S', 'I'] }
  };
  const mprFrame = (name) => Q.viewFrame(S.orient, name);
  const views = {};
  function mkMPR(name, canvasId) {
    const v = new V.PlaneView($(canvasId), {
      volume: () => S.vol, wl: () => S.wl, kind: 'mpr', name,
      frame: () => { const f = mprFrame(name); return { o: M.mul(f.n, M.dot(S.cross, f.n)), u: f.u, v: f.v, n: f.n }; },
      overlay: (view, ctx) => overlay(view, ctx)
    });
    v.kind = 'mpr'; v.groups = ['nadir', 'H', 'cl', 'A', 'seed']; views[name] = v; attachView(v); return v;
  }
  function xsecFrame(which) { return () => { if (!S.cl) return null; const f = M.frameAt(S.cl, which === 'ann' ? S.sH : S.sD); return { o: f.C, u: f.N1, v: f.N2, n: f.T }; }; }
  function mkXsec(which, canvasId) {
    const v = new V.PlaneView($(canvasId), { volume: () => S.vol, wl: () => S.wl, frame: xsecFrame(which), overlay: (view, ctx) => overlay(view, ctx) });
    v.kind = 'xsec'; v.which = which; v.groups = which === 'ann' ? ['nadir', 'H'] : ['A']; v.mm = 0.23; views['x' + which] = v; attachView(v); return v;
  }
  function fitViews() {
    if (!S.vol) return; const b = S.vol.bbox;
    for (const n of Object.keys(MPR)) {                                                  // extents of the (possibly oblique) plane over the volume's bounding box
      const f = mprFrame(n); let lu = [1e9, -1e9], lv = [1e9, -1e9];
      for (let c = 0; c < 8; c++) { const P = [c & 1 ? b.hi[0] : b.lo[0], c & 2 ? b.hi[1] : b.lo[1], c & 4 ? b.hi[2] : b.lo[2]], a = M.dot(P, f.u), bb = M.dot(P, f.v); lu = [Math.min(lu[0], a), Math.max(lu[1], a)]; lv = [Math.min(lv[0], bb), Math.max(lv[1], bb)]; }
      if (Q.isIdentity(S.orient)) { const cu = (lu[0] + lu[1]) / 2, cvv = (lv[0] + lv[1]) / 2; views[n].fit(lu[1] - lu[0], lv[1] - lv[0], cu, cvv); }
      else { const e = Math.min(lu[1] - lu[0], lv[1] - lv[0]), cu = M.dot(S.cross, f.u), cvv = M.dot(S.cross, f.v); views[n].fit(Math.max(e, 1), Math.max(e, 1), cu, cvv); }
    }
    views.xann.mm = 0.23; views.xdesc.mm = 0.23; views.xann.cu = views.xann.cv = views.xdesc.cu = views.xdesc.cv = 0; Object.values(views).forEach((v) => { v.dirty = true; });
  }
  function markerVis(view, m) {
    if (!view.groups.includes(m.group)) return 0;
    const dn = Math.abs(view.depth(m.pos));
    if (view.kind === 'xsec') return dn <= 3 ? 2 : dn <= 40 ? 1 : 0;
    return dn <= 3 ? 2 : dn <= 30 ? 1 : 0;
  }
  function symbol(ctx, x, y, m, solid) {
    ctx.save(); ctx.globalAlpha = solid ? 1 : 0.5; ctx.lineWidth = solid ? 1.6 : 1.3; ctx.strokeStyle = solid ? '#000' : m.color; ctx.fillStyle = m.color;
    ctx.beginPath();
    if (m.group === 'A') { ctx.moveTo(x, y - 8); ctx.lineTo(x + 8, y); ctx.lineTo(x, y + 8); ctx.lineTo(x - 8, y); ctx.closePath(); }
    else if (m.group === 'nadir') { ctx.moveTo(x, y - 7); ctx.lineTo(x + 7, y + 6); ctx.lineTo(x - 7, y + 6); ctx.closePath(); }
    else if (m.group === 'seed') { ctx.arc(x, y, 6, 0, 7); ctx.moveTo(x - 10, y); ctx.lineTo(x + 10, y); ctx.moveTo(x, y - 10); ctx.lineTo(x, y + 10); }
    else if (m.group === 'cl') ctx.arc(x, y, 4.2, 0, 7); else ctx.arc(x, y, 6.5, 0, 7);
    if (m.group === 'nadir') { ctx.lineWidth = 2; ctx.strokeStyle = solid ? '#fff' : m.color; }
    if (solid) { if (m.group !== 'seed') ctx.fill(); ctx.stroke(); if (m.group === 'A') { ctx.strokeStyle = '#fff'; ctx.lineWidth = 1; ctx.stroke(); } } else ctx.stroke();
    ctx.restore();
    ctx.save(); ctx.globalAlpha = solid ? 1 : 0.6; ctx.fillStyle = m.color; ctx.font = 'bold 11px sans-serif'; ctx.textAlign = 'left'; ctx.shadowColor = '#000'; ctx.shadowBlur = 3; ctx.fillText(m.label, x + 9, y - 7); ctx.restore();
  }
  function overlay(view, ctx) {
    const W = view.W, H = view.H;
    if (!S.vol) { ctx.fillStyle = '#9aa'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Load a CT or the synthetic phantom (tab 1)', W / 2, H / 2); return; }
    if (view.kind === 'xsec') {
      if (!S.cl) { ctx.fillStyle = '#9aa'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center'; ctx.fillText('Place ≥ 2 centreline points first', W / 2, H / 2); return; }
      const c = view.toScreen(view.frame().o);
      ctx.strokeStyle = 'rgba(79,195,247,0.6)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(c[0] - 12, c[1]); ctx.lineTo(c[0] + 12, c[1]); ctx.moveTo(c[0], c[1] - 12); ctx.lineTo(c[0], c[1] + 12); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(c[0], c[1]); ctx.lineTo(W - 4, c[1]); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right'; ctx.fillText('0° (N1)', W - 6, c[1] - 4);
      ctx.textAlign = 'left'; ctx.fillStyle = '#cfd8dc'; ctx.fillText('looking along centreline direction (bifurcation → apex) · angles clockwise', 6, H - 6);
      ctx.fillStyle = '#fff'; ctx.fillText('s = ' + f1(view.which === 'ann' ? S.sH : S.sD) + ' mm', 6, 14);
      if (view.which === 'desc' && S.sel && S.axis) { // beam plane trace
        const n3 = M.lateralDir(S.axis.a, S.sel.lao, S.sel.cran), f = view.frame();
        if (n3) { const nx = M.dot(n3, f.u), ny = M.dot(n3, f.v), nl = Math.hypot(nx, ny);
          if (nl > 1e-3) { const ux = nx / nl, uy = ny / nl, tx = -uy, ty = ux;
            ctx.strokeStyle = '#ff9800'; ctx.lineWidth = 2; ctx.setLineDash([8, 5]); ctx.beginPath(); ctx.moveTo(c[0] - tx * 190, c[1] - ty * 190); ctx.lineTo(c[0] + tx * 190, c[1] + ty * 190); ctx.stroke(); ctx.setLineDash([]);
            ctx.beginPath(); ctx.moveTo(c[0], c[1]); ctx.lineTo(c[0] + ux * 70, c[1] + uy * 70); ctx.stroke(); ctx.fillStyle = '#ff9800'; ctx.font = 'bold 11px sans-serif'; ctx.fillText('image right', c[0] + ux * 74, c[1] + uy * 74); ctx.fillText(M.labelAngles(S.sel.lao, S.sel.cran), 6, 28); } }
      }
      if (view.which === 'ann' && S.tool.startsWith('nadir') === false) { /* nothing extra */ }
      const grp = view.groups;
      allMarkers().forEach((m) => { const vis = markerVis(view, m); if (!vis) return; const p = view.toScreen(m.pos);
        if (grp.includes(m.group) && (m.group === 'H' || m.group === 'A')) { ctx.strokeStyle = m.color; ctx.globalAlpha = 0.55; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(c[0], c[1]); ctx.lineTo(p[0], p[1]); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha = 1;
          const f = view.frame(), d = M.sub(m.pos, f.o), ang = ((Math.atan2(M.dot(d, f.v), M.dot(d, f.u)) * M.R2D) % 360 + 360) % 360; ctx.fillStyle = m.color; ctx.font = '10px sans-serif'; ctx.fillText(Math.round(ang) + '°', p[0] + 10, p[1] + 12); }
        symbol(ctx, p[0], p[1], m, vis === 2); });
      return;
    }
    // MPR
    const d = MPR[view.cfg.name], cs = view.toScreen(S.cross), CH = crossGeom(view);
    if (S.cl) { // projected smoothed centreline
      ctx.strokeStyle = 'rgba(255,214,0,0.45)'; ctx.lineWidth = 1.4; ctx.beginPath();
      let pen = false; for (let i = 0; i < S.cl.pts.length; i += 4) { const p = view.toScreen(S.cl.pts[i]); if (!pen) { ctx.moveTo(p[0], p[1]); pen = true; } else ctx.lineTo(p[0], p[1]); } ctx.stroke();
      ctx.fillStyle = CL_COLOR; for (let i = 0; i < S.cl.pts.length; i += 2) if (Math.abs(view.depth(S.cl.pts[i])) < 1.2) { const p = view.toScreen(S.cl.pts[i]); ctx.fillRect(p[0] - 1, p[1] - 1, 2.5, 2.5); }
    }
    // crosshair = traces of the other two planes (tilt when the orientation is rotated), with grabbable end handles
    CH.lines.forEach((ln, li) => { const hot = hoverHandle && hoverHandle.view === view && hoverHandle.li === li;
      ctx.strokeStyle = hot ? 'rgba(129,212,250,0.95)' : 'rgba(79,195,247,0.6)'; ctx.lineWidth = hot ? 1.8 : 1; ctx.beginPath(); ctx.moveTo(cs[0] - ln.d[0] * 4000, cs[1] - ln.d[1] * 4000); ctx.lineTo(cs[0] + ln.d[0] * 4000, cs[1] + ln.d[1] * 4000); ctx.stroke();
      ln.handles.forEach((h, hi) => { const on = hoverHandle && hoverHandle.view === view && hoverHandle.li === li && hoverHandle.hi === hi || (drag && drag.type === 'rot' && drag.view === view && drag.li === li); ctx.beginPath(); ctx.arc(h[0], h[1], on ? 6.5 : 5, 0, 7); ctx.fillStyle = on ? '#81d4fa' : '#29b6f6'; ctx.fill(); ctx.strokeStyle = '#012'; ctx.lineWidth = 1.4; ctx.stroke(); }); });
    allMarkers().forEach((m) => { const vis = markerVis(view, m); if (vis) { const p = view.toScreen(m.pos); symbol(ctx, p[0], p[1], m, vis === 2); } });
    ctx.fillStyle = '#cfd8dc'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(d.lab[0], 10, H / 2 + 4); ctx.fillText(d.lab[1], W - 10, H / 2 + 4); ctx.fillText(d.lab[2], W / 2, 14); ctx.fillText(d.lab[3], W / 2, H - 6);
    const sg = sliceGeom(view.cfg.name); ctx.textAlign = 'left'; ctx.font = '11px sans-serif';
    const oblq = !Q.isIdentity(S.orient), an = Q.angles(S.orient), nz = sg.n;
    ctx.fillText(d.title + ' · ' + (oblq ? 'oblique · pos ' + f1(sg.s) + ' mm along normal (' + sg.n.map((v) => v.toFixed(2)).join(', ') + ')' : 'slice ' + (sg.k + 1) + '/' + sg.N + ' · ' + (nz[0] ? 'x' : nz[1] ? 'y' : 'z') + ' = ' + f1(Math.abs(nz[0] + nz[1] + nz[2]) * (nz[0] ? -sg.s : sg.s)) + ' mm'), 6, H - 20);
    if (oblq) { ctx.fillStyle = '#81d4fa'; ctx.textAlign = 'right'; ctx.font = 'bold 11px sans-serif'; ctx.fillText('lines rotated ' + (an.rot[view.cfg.name] >= 0 ? '+' : '') + an.rot[view.cfg.name].toFixed(1) + '°', W - 8, 14); ctx.textAlign = 'left'; ctx.fillStyle = '#cfd8dc'; ctx.font = '11px sans-serif'; }
    ctx.fillText('W ' + Math.round(S.wl.w) + ' / L ' + Math.round(S.wl.c) + ' · ' + f1(1 / view.mm * 1) + ' px/mm', 6, 14 + 14);
    if (S.tool !== 'nav') { ctx.fillStyle = '#ffeb3b'; ctx.fillText('placing: ' + toolLabel(S.tool), 6, 14); }
  }
  function toolLabel(t) { if (t === 'nav') return 'Navigate'; if (t === 'cl') return 'Centreline point'; if (t === 'seed') return 'Root seed (click inside the opacified aortic root)'; const [g, k] = t.split('.'); return GROUPS[g].label(k); }

  /* ---------------- interaction ---------------- */
  let drag = null, hoverHandle = null;
  /* ---- oblique MPR: crosshair lines + end handles ---- */
  const HANDLE_INSET = 15, HANDLE_R = 9, LINE_TOL = 5;
  function crossGeom(view) {                           // screen geometry of the two crosshair lines of an MPR view: unit screen direction d, end handles (clipped to the canvas), plane normal (world)
    const name = view.cfg.name, cs = view.toScreen(S.cross), lines = Q.viewLines(S.orient, name).map((l) => {
      const d = [l.screen[0], l.screen[1]], hs = [];
      for (const sg of [1, -1]) {
        let t = 1e9; const dx = d[0] * sg, dy = d[1] * sg;
        if (dx > 1e-6) t = Math.min(t, (view.W - HANDLE_INSET - cs[0]) / dx); else if (dx < -1e-6) t = Math.min(t, (HANDLE_INSET - cs[0]) / dx);
        if (dy > 1e-6) t = Math.min(t, (view.H - HANDLE_INSET - cs[1]) / dy); else if (dy < -1e-6) t = Math.min(t, (HANDLE_INSET - cs[1]) / dy);
        if (!(t > 0) || t > 1e8) t = 0; hs.push([cs[0] + dx * Math.max(t, 0), cs[1] + dy * Math.max(t, 0)]);
      }
      return { d, handles: hs, normal: l.normal, plane: l.plane };
    });
    return { cs, lines };
  }
  function hitHandle(view, px, py) {
    if (view.kind !== 'mpr') return null; const g = crossGeom(view); let best = null, bd = HANDLE_R;
    g.lines.forEach((ln, li) => ln.handles.forEach((h, hi) => { const dd = Math.hypot(h[0] - px, h[1] - py); if (dd < bd) { bd = dd; best = { view, li, hi, g }; } }));
    return best;
  }
  function hitLine(view, px, py) {                      // body of a crosshair line (not within 14 px of the crosshair centre: there a click moves the crosshair)
    if (view.kind !== 'mpr') return null; const g = crossGeom(view); if (Math.hypot(px - g.cs[0], py - g.cs[1]) < 14) return null;
    let best = null, bd = LINE_TOL;
    g.lines.forEach((ln, li) => { const dd = Math.abs((px - g.cs[0]) * ln.d[1] - (py - g.cs[1]) * ln.d[0]); if (dd < bd) { bd = dd; best = { view, li, g }; } });
    return best;
  }
  /* set a new orientation; every MPR view keeps the crosshair at the same screen position (rotation about the crosshair) */
  function applyOrient(O) {
    const anchors = {}; Object.keys(MPR).forEach((n) => { anchors[n] = views[n].toScreen(S.cross); });
    S.orient = O;
    Object.keys(MPR).forEach((n) => { const v = views[n], f = mprFrame(n), a = anchors[n]; v.cu = M.dot(S.cross, f.u) - (a[0] - v.W / 2) * v.mm; v.cv = M.dot(S.cross, f.v) - (a[1] - v.H / 2) * v.mm; v.dirty = true; });
    cprCache = null; renderAll();
  }
  function resetOrient() { if (!S.vol) return; applyOrient(Q.identity()); }
  function alignToCentreline() {
    if (!S.vol || !S.cl) return; const q = M.nearestS(S.cl, S.cross), f = M.frameAt(S.cl, q.s); applyOrient(Q.alignZ(f.T));
  }
  function mpos(view, e) { const r = view.canvas.getBoundingClientRect(); return { x: (e.clientX - r.left) * view.W / r.width, y: (e.clientY - r.top) * view.H / r.height }; }
  function hitMarker(view, px, py) {
    let best = null, bd = 11;
    allMarkers().forEach((m) => { if (!markerVis(view, m)) return; const p = view.toScreen(m.pos), d = Math.hypot(p[0] - px, p[1] - py); if (d < bd) { bd = d; best = m; } });
    return best;
  }
  function setCrossFromView(view, P) { S.cross = P; }
  function clampCross() { const b = S.vol.bbox; for (let i = 0; i < 3; i++) S.cross[i] = Math.min(Math.max(S.cross[i], b.lo[i]), b.hi[i]); }
  function attachView(view) {
    const cv = view.canvas;
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
    cv.addEventListener('mousedown', (e) => {
      if (!S.vol) return; e.preventDefault(); const p = mpos(view, e);
      if (e.button === 2) { drag = { type: 'wl', x: e.clientX, y: e.clientY, c: S.wl.c, w: S.wl.w }; return; }
      if (e.button === 1 || (e.button === 0 && e.shiftKey)) { drag = { type: 'pan', view, x: p.x, y: p.y, cu: view.cu, cv: view.cv }; return; }
      if (e.button !== 0) return;
      const hit = hitMarker(view, p.x, p.y);
      if (hit) { if (e.altKey) deleteMarker(hit.id); else drag = { type: 'marker', id: hit.id, view, depth: view.depth(hit.pos) }; return; }
      if (view.kind === 'mpr') {
        const hh = hitHandle(view, p.x, p.y);
        if (hh) { const cs = hh.g.cs; drag = { type: 'rot', view, li: hh.li, O0: Q.clone(S.orient), n0: mprFrame(view.cfg.name).n, a0: Math.atan2(p.y - cs[1], p.x - cs[0]), last: 0 }; hoverHandle = hh; renderAll(); return; }
        const hl = S.tool === 'nav' ? hitLine(view, p.x, p.y) : null;
        if (hl) { const ln = hl.g.lines[hl.li], f = mprFrame(view.cfg.name), N = ln.normal; drag = { type: 'tr', view, li: hl.li, cross0: S.cross.slice(), N, sd: [M.dot(N, f.u), M.dot(N, f.v)], p0: p }; renderAll(); return; }
        const P = view.toWorld(p.x, p.y);
        if (S.tool === 'nav') { drag = { type: 'cross', view }; S.cross = P; clampCross(); renderAll(); } else placeMarker(S.tool, P);
      } else if (view.which === 'ann' && /^(H|nadir)\./.test(S.tool)) placeMarker(S.tool, view.toWorld(p.x, p.y));
    });
    cv.addEventListener('mousemove', (e) => {
      if (drag || !S.vol || view.kind !== 'mpr') return; const p = mpos(view, e), hh = hitHandle(view, p.x, p.y), hl = hh ? null : (S.tool === 'nav' ? hitLine(view, p.x, p.y) : null);
      const nh = hh ? { view, li: hh.li, hi: hh.hi } : null, ch = (nh ? nh.li + '.' + nh.hi : '') !== (hoverHandle && hoverHandle.view === view ? hoverHandle.li + '.' + hoverHandle.hi : '');
      cv.style.cursor = hh ? 'grab' : hl ? 'move' : ''; if (ch) { hoverHandle = nh; renderAll(); }
    });
    cv.addEventListener('mouseleave', () => { if (hoverHandle && hoverHandle.view === view && !drag) { hoverHandle = null; renderAll(); } });
    window.addEventListener('mousemove', (e) => {
      if (!drag) return;
      if (drag.type === 'wl') { S.wl.w = Math.max(20, drag.w + (e.clientX - drag.x) * 4); S.wl.c = drag.c + (e.clientY - drag.y) * 2; syncWL(); invalidateImages(); renderAll(); return; }
      if (drag.view !== view) return;
      const p = mpos(view, e);
      if (drag.type === 'pan') { view.cu = drag.cu - (p.x - drag.x) * view.mm; view.cv = drag.cv - (p.y - drag.y) * view.mm; view.dirty = true; renderAll(); }
      else if (drag.type === 'rot') {                                                    // rotate the other two planes about this view's normal, following the handle
        const cs = view.toScreen(S.cross); let da = Math.atan2(p.y - cs[1], p.x - cs[0]) - drag.a0; da = Math.atan2(Math.sin(da), Math.cos(da)); drag.last = da;
        applyOrient(Q.rotateAbout(drag.O0, drag.n0, da * M.R2D));
      }
      else if (drag.type === 'tr') {                                                     // translate the line = move the crosshair along that plane's normal (which lies in this view)
        const s = ((p.x - drag.p0.x) * drag.sd[0] + (p.y - drag.p0.y) * drag.sd[1]) * view.mm; S.cross = Q.translate(drag.cross0, drag.N, s); clampCross(); renderAll();
      }
      else if (drag.type === 'cross') { S.cross = view.toWorld(p.x, p.y); clampCross(); renderAll(); }
      else if (drag.type === 'marker') { const P = view.toWorld(p.x, p.y), f = view.frame(); setMarkerPos(drag.id, M.add(P, M.mul(f.n, drag.depth))); onChanged(true); }
    });
    window.addEventListener('mouseup', () => { if (drag && drag.type === 'rot') { hoverHandle = null; renderAll(); } drag = null; });
    // ---- wheel / trackpad: scroll slices (plain wheel) or zoom (pinch = ctrlKey wheel, or any wheel on cross-section views) ----
    const ws = { acc: 0, t: 0, dir: 0 };
    cv.addEventListener('wheel', (e) => {
      e.preventDefault(); S.active = view.cfg.name || S.active; if (!S.vol) return; const p = mpos(view, e);
      const unit = e.deltaMode === 1 ? 10 : e.deltaMode === 2 ? 300 : 1;                  // line-mode notch (Firefox: 3 lines) = 30 px = 1 slice; page mode = 10 slices
      if (view.kind === 'xsec' || e.ctrlKey) {                                           // zoom: pinch gesture reports ctrlKey + small deltaY
        const k = e.ctrlKey ? 0.01 : 0.0015, zu = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1; view.zoomAt(p.x, p.y, Math.exp(-e.deltaY * zu * k)); renderAll(); return;
      }
      const dy = e.deltaY * unit, now = e.timeStamp || Date.now();
      if (now - ws.t > 400 || Math.sign(dy) !== ws.dir) ws.acc = 0;                      // new gesture or direction change
      ws.t = now; ws.dir = Math.sign(dy);
      let steps;
      if (e.deltaMode === 0 && Math.abs(e.deltaY) >= 50 && Number.isInteger(e.deltaY)) steps = Math.sign(dy) * Math.max(1, Math.round(Math.abs(dy) / 100));   // classic mouse-wheel notch
      else { ws.acc += dy; steps = Math.trunc(ws.acc / WHEEL_PX); ws.acc -= steps * WHEEL_PX; }                                                         // trackpad / fractional: accumulate
      if (steps) stepSlice(view.cfg.name, S.invertScroll ? steps : -steps);              // deltaY<0 (wheel up / two-finger swipe up) -> +n
    }, { passive: false });
    ['gesturestart', 'gesturechange'].forEach((ev) => cv.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'gesturechange' && S.vol && e.scale) { const p = mpos(view, e), f = e.scale / (view._gs || 1); view._gs = e.scale; view.zoomAt(p.x, p.y, f); renderAll(); } else view._gs = 1; }));   // Safari pinch (untested)
    cv.addEventListener('mouseenter', () => { S.hover = view.cfg.name || null; if (S.hover) S.active = S.hover; });
    cv.addEventListener('mouseleave', () => { S.hover = null; });
    cv.addEventListener('mousedown', () => { if (view.cfg.name) S.active = view.cfg.name; });
  }
  /* ---------------- slice navigation (shared by wheel, keyboard, sliders) ---------------- */
  const WHEEL_PX = 30;   // accumulated wheel pixels per slice for trackpads (one mouse-wheel notch = 1 slice)
  function sliceGeom(name) {                           // slice stack along the current (possibly oblique) plane normal; identity orientation == the original axis-aligned stack
    const vol = S.vol, n = mprFrame(name).n, b = vol.bbox, aligned = Q.isIdentity(S.orient);
    const m = vol.inv, dv = [m[0][0] * n[0] + m[0][1] * n[1] + m[0][2] * n[2], m[1][0] * n[0] + m[1][1] * n[1] + m[1][2] * n[2], m[2][0] * n[0] + m[2][1] * n[1] + m[2][2] * n[2]];
    const pitch = aligned ? 1 / Math.max(Math.abs(dv[0]), Math.abs(dv[1]), Math.abs(dv[2])) : Math.min(...[vol.vi, vol.vj, vol.vk].map((v) => Math.hypot(v[0], v[1], v[2])));   // mm per step: voxel pitch along n (aligned) / smallest voxel size (oblique)
    let smin = 1e9, smax = -1e9; for (let c = 0; c < 8; c++) { const d = M.dot([c & 1 ? b.hi[0] : b.lo[0], c & 2 ? b.hi[1] : b.lo[1], c & 4 ? b.hi[2] : b.lo[2]], n); smin = Math.min(smin, d); smax = Math.max(smax, d); }
    const N = Math.max(1, Math.round((smax - smin) / pitch) + 1), s = M.dot(S.cross, n);
    return { n, pitch, smin, smax, N, s, k: Math.min(N - 1, Math.max(0, Math.round((s - smin) / pitch))) };
  }
  function setSlice(name, k) {
    if (!S.vol) return; const g = sliceGeom(name); k = Math.min(g.N - 1, Math.max(0, Math.round(k)));
    const s = Math.min(g.smax, g.smin + k * g.pitch); S.cross = M.add(S.cross, M.mul(g.n, s - g.s)); clampCross(); renderAll();
  }
  function stepSlice(name, steps) { if (!S.vol || !steps) return; const g = sliceGeom(name); setSlice(name, g.k + steps); }
  function addSliceBars() {
    for (const name of Object.keys(MPR)) {
      const cv = views[name].canvas, bar = document.createElement('div'); bar.className = 'slicebar';
      bar.innerHTML = `<input type="range" min="0" max="0" value="0" step="1" aria-label="${MPR[name].title} slice"><span class="slicelab mono">–</span>`;
      cv.parentNode.insertBefore(bar, cv.nextSibling);
      const inp = bar.querySelector('input'); inp.addEventListener('input', () => { S.active = name; setSlice(name, +inp.value); });
      views[name].bar = { inp, lab: bar.querySelector('.slicelab') };
    }
  }
  function updateSliceBars() {
    for (const name of Object.keys(MPR)) {
      const b = views[name].bar; if (!b) continue;
      if (!S.vol) { b.inp.disabled = true; b.lab.textContent = '–'; continue; }
      const g = sliceGeom(name); b.inp.disabled = false; b.inp.max = g.N - 1; b.inp.value = g.k;
      b.lab.textContent = Q.isIdentity(S.orient) ? `${g.k + 1}/${g.N}  ${g.n[2] ? 'z' : g.n[1] ? 'y' : 'x'} ${(g.n[g.n[2] ? 2 : g.n[1] ? 1 : 0] * g.s).toFixed(1)} mm` : `${g.k + 1}/${g.N}  oblique ${g.s.toFixed(1)} mm`;
    }
  }
  document.addEventListener('keydown', (e) => {
    if (!S.vol || S.tab !== 'mark' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target, tag = t && t.tagName; if (tag === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
    if (tag === 'INPUT' && t.type === 'range' && !t.closest('.slicebar')) return;       // other sliders keep their own arrow-key behaviour
    const dir = e.key === 'ArrowUp' || e.key === 'PageUp' ? 1 : e.key === 'ArrowDown' || e.key === 'PageDown' ? -1 : 0; if (!dir) return;
    e.preventDefault(); stepSlice(S.hover || S.active || 'axial', dir * (e.shiftKey ? 5 : 1) * (S.invertScroll ? -1 : 1));
  });
  function invalidateImages() { Object.values(views).forEach((v) => { v.dirty = true; }); cprCache = null; }

  /* ---------------- UI: Mark tab ---------------- */
  function renderToolList() {
    const rows = [];
    const row = (tool, label, color, pos, opts) => `<div class="toolrow ${S.tool === tool ? 'active' : ''}"><span class="dot" style="background:${color || '#888'}"></span><button class="tbtn" data-act="tool" data-tool="${tool}">${esc(label)}${pos ? ' ✓ ' + esc(fv(pos)) : ''}</button>${pos ? `<button class="g" title="go to" data-act="goto" data-id="${opts}">⌖</button><button class="x" title="delete" data-act="del" data-id="${opts}">✕</button>` : ''}</div>`;
    rows.push(row('nav', 'Navigate (move crosshair)', '#4fc3f7'));
    rows.push('<div class="muted small">Cusp nadirs (optional) – triangles; auto-detect below</div>');
    rows.push(row('seed', 'Set root seed (for auto-detect)', '#e040fb', S.seed, 'seed.0'));
    GROUPS.nadir.keys.forEach((k) => rows.push(row('nadir.' + k, GROUPS.nadir.label(k), GROUPS.nadir.color[k], S.m.nadir[k], 'nadir.' + k)));
    rows.push('<div class="muted small">Native commissures (annular/SOV level)</div>');
    HK.forEach((k) => rows.push(row('H.' + k, GROUPS.H.label(k), GROUPS.H.color[k], S.m.H[k], 'H.' + k)));
    rows.push('<div class="muted small">Centreline</div>');
    rows.push(row('cl', 'Add centreline point (' + S.m.cl.length + ')', CL_COLOR));
    $('toolList').innerHTML = rows.join(''); updateAutoButtons();
    $('clList').innerHTML = S.m.cl.length ? '<table>' + S.m.cl.map((P, i) => `<tr><td>C${i + 1}</td><td class="mono">${esc(fv(P))}</td><td><button class="g" data-act="goto" data-id="cl.${i}">⌖</button><button class="x" data-act="del" data-id="cl.${i}">✕</button></td></tr>`).join('') + '</table>' : '<div class="muted small" style="padding:4px">No points yet. Click along the aorta from the aortic bifurcation up and over the arch, through the valve to the LV apex.</div>';
    let w = '';
    if (S.m.cl.length >= 2 && S.m.cl[0][2] > S.m.cl[S.m.cl.length - 1][2]) w = '⚠ First point is higher (z) than the last: order should be bifurcation → apex (use Reverse).';
    $('clWarn').textContent = w;
  }
  function renderMarkSummary() {
    const nH = HK.filter((k) => S.m.H[k]).length;
    let t = `Centreline points: ${S.m.cl.length} ${S.cl ? '(smoothed length ' + f1(S.cl.length) + ' mm)' : '(need ≥ 2)'}\nH markers: ${nH}/3 · Nadirs (optional): ${GROUPS.nadir.keys.filter((k) => S.m.nadir[k]).length}/3`;
    if (nH === 3) { const g = M.angularGaps(HK.map((k) => S.tr ? S.tr[k].phi : 0)); if (S.tr) t += `\nH angular separations about centreline: ${g.map((x) => Math.round(x) + '°').join(' / ')}` + (g.some((x) => x < 85 || x > 155) ? '  ⚠ far from ~120°: check marker order/placement' : ''); }
    const nn = GROUPS.nadir.keys.filter((k) => S.m.nadir[k]);
    if (nn.length === 3) { const a = GROUPS.nadir.keys.map((k) => S.m.nadir[k]), nrm = M.norm(M.cross(M.sub(a[1], a[0]), M.sub(a[2], a[0]))), cen = M.mul(M.add(M.add(a[0], a[1]), a[2]), 1 / 3);
      if (S.cl) { const T = M.frameAt(S.cl, M.nearestS(S.cl, cen).s).T; t += `\nAnnular (nadir) plane vs centreline tangent: ${f1(Math.acos(Math.min(1, Math.abs(M.dot(nrm, T)))) * M.R2D)}° tilt`; } }
    $('markSummary').textContent = t;
  }
  function renderCursorInfo() {
    if (!S.vol) { $('cursorInfo').textContent = 'no volume'; if ($('orientInfo')) $('orientInfo').textContent = ''; return; }
    renderOrientInfo();
    const hu = S.vol.sample(S.cross), v = S.vol.toVoxel(S.cross);
    $('cursorInfo').textContent = `LPS mm: ${fv(S.cross)}\nvoxel: ${v.map((x) => x.toFixed(1)).join(', ')}\nHU: ${hu === hu ? Math.round(hu) : 'outside'}\n(x: + patient LEFT, y: + POSTERIOR, z: + SUPERIOR)`;
  }
  function renderOrientInfo() {
    const el = $('orientInfo'); if (!el) return; const id = Q.isIdentity(S.orient), an = Q.angles(S.orient), O = S.orient, f = (v) => v.map((x) => x.toFixed(3)).join(', ');
    el.textContent = id ? 'MPR orientation: scanner axes (not rotated).\nDrag the blue handles at the ends of the crosshair lines to rotate the other two planes; drag a line to move it.'
      : `MPR orientation: double-oblique\nlines rotated: axial ${an.rot.axial.toFixed(1)}° · coronal ${an.rot.coronal.toFixed(1)}° · sagittal ${an.rot.sagittal.toFixed(1)}°\naxial normal tilted ${an.tiltAxial.toFixed(1)}° from scanner z\naxial n = (${f(O.Z)})\ncoronal n = (${f(O.Y)})\nsagittal n = (${f(Q.NORMAL(O).sagittal)})`;
    $('btnResetOrient').disabled = id; $('btnAlignCl').disabled = !S.cl;
  }
  function syncWL() { $('wlLevel').value = S.wl.c; $('wlWindow').value = S.wl.w; $('wlLevelO').textContent = Math.round(S.wl.c); $('wlWindowO').textContent = Math.round(S.wl.w); }
  const PRESETS = { 'CTA 200/700': [200, 700], 'Soft 40/400': [40, 400], 'Wide 300/1500': [300, 1500], 'Lung −600/1500': [-600, 1500] };

  /* ---------------- UI: Transfer tab ---------------- */
  let cprCache = null;
  function renderTransfer() {
    const L = S.cl ? S.cl.length : 700;
    ['annLevel', 'descLevel'].forEach((id) => { $(id).max = Math.ceil(L); });
    $('annLevel').value = S.sH == null ? 0 : S.sH; $('descLevel').value = S.sD == null ? 0 : S.sD;
    $('annLevelO').textContent = S.sH == null ? '—' : f1(S.sH) + ' mm'; $('descLevelO').textContent = S.sD == null ? '—' : f1(S.sD) + ' mm';
    $('annLevel').disabled = S.p.annAuto && HK.some((k) => S.m.H[k]); $('smoothO').textContent = S.p.smoothMm + ' mm'; $('cprAngleO').textContent = S.p.cprAngle + '°';
    $('fixedRow').style.display = S.p.radMode === 'fixed' ? 'flex' : 'none';
    $('clStats').textContent = S.cl ? `Smoothed centreline: ${f1(S.cl.length)} mm, ${S.cl.pts.length} samples @ 0.5 mm.\nRotation-minimising frame (double reflection).` : 'Need ≥ 2 centreline points (tab 2).';
    views.xann.draw(); views.xdesc.draw();
    const Hs = HK.map((k) => S.m.H[k] && S.tr ? { label: 'H_' + k, color: GROUPS.H.color[k], phi: S.tr[k].phi, rho: S.tr[k].rho } : null).filter(Boolean);
    const As = S.cl ? HK.map((k) => S.m.A[k] ? Object.assign({ label: 'A_' + k, color: GROUPS.A.color[k] }, M.angularPosition(S.cl, S.sD, S.m.A[k].pos)) : null).filter(Boolean) : [];
    V.drawPolar($('cvPolar1'), { title: 'Angular positions about the centreline', H: Hs, A: As, beam: beamInfo() });
    renderCPRCanvas(); renderTransferTable(As);
  }
  function beamInfo() {
    if (!S.sel || !S.axis || !S.cl) return null; const n3 = M.lateralDir(S.axis.a, S.sel.lao, S.sel.cran); if (!n3) return null;
    const f = M.frameAt(S.cl, S.sD); return { n2: [M.dot(n3, f.N1), M.dot(n3, f.N2)], label: M.labelAngles(S.sel.lao, S.sel.cran) };
  }
  function renderCPRCanvas() {
    const cv = $('cvCPR'), ctx = cv.getContext('2d');
    if (!S.vol || !S.cl) { ctx.fillStyle = '#111'; ctx.fillRect(0, 0, cv.width, cv.height); ctx.fillStyle = '#9aa'; ctx.font = '13px sans-serif'; ctx.fillText('Straightened view needs a volume and a centreline', 20, 40); return; }
    const key = [S.volId, S.clVer, S.p.cprAngle, S.wl.c, S.wl.w].join('|');
    if (!cprCache || cprCache.key !== key) {
      const off = document.createElement('canvas'); off.width = cv.width; off.height = cv.height;
      const map = V.renderCPR(off, S.vol, S.cl, S.p.cprAngle, S.wl, 45); cprCache = { key, off, map };
    }
    ctx.drawImage(cprCache.off, 0, 0); const map = cprCache.map, a = S.p.cprAngle * M.D2R;
    [[S.sH, '#ff9800', 'annulus'], [S.sD, '#00e5ff', 'descending']].forEach(([s, c, lab]) => { if (s == null) return; const x = map.px(s); ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, cv.height); ctx.stroke(); ctx.setLineDash([]); ctx.fillStyle = c; ctx.font = '11px sans-serif'; ctx.fillText(lab + ' ' + f1(s) + ' mm', x + 4, 12); });
    if (S.tr) HK.forEach((k) => { if (!S.tr[k]) return; const t = S.tr[k], off = t.rho * Math.cos(t.phi * M.D2R - a); const x = map.px(t.s), y = map.py(off);
      ctx.fillStyle = GROUPS.H.color[k]; ctx.strokeStyle = '#000'; ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill(); ctx.stroke(); ctx.font = 'bold 10px sans-serif'; ctx.fillText('H_' + k, x + 7, y - 4); });
    if (S.cl) HK.forEach((k) => { if (!S.m.A[k]) return; const t = M.angularPosition(S.cl, S.sD, S.m.A[k].pos), off = t.rho * Math.cos(t.phi * M.D2R - a); const x = map.px(S.sD), y = map.py(off);
      ctx.fillStyle = GROUPS.A.color[k]; ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x + 6, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 6, y); ctx.closePath(); ctx.fill(); ctx.stroke(); ctx.fillStyle = GROUPS.A.color[k]; ctx.fillText('A_' + k, x + 8, y + 12); });
    ctx.fillStyle = '#cfd8dc'; ctx.font = '10px sans-serif'; ctx.fillText('cut plane at ' + S.p.cprAngle + '° about centreline; vertical axis = offset ±45 mm', 8, cv.height - 6);
  }
  function renderTransferTable(As) {
    if (!S.cl || !S.tr) { $('transferTable').innerHTML = '<div class="card muted">Place centreline + H markers to see the transferred A markers.</div>'; return; }
    const nMan = HK.filter((k) => S.m.A[k] && S.m.A[k].manual).length;
    const gaps = M.angularGaps(HK.filter((k) => S.tr[k]).map((k) => S.tr[k].phi));
    let h = `<div class="card"><h2>Marker transfer</h2><table><tr><th>Marker</th><th>H level s (mm)</th><th>H angle</th><th>H radius</th><th>→ A angle</th><th>A radius</th><th>A position, LPS mm</th><th>state</th></tr>`;
    HK.forEach((k, i) => { const t = S.tr[k], a = As.find((x) => x.label === 'A_' + k); if (!t) return;
      h += `<tr><td><b style="color:${GROUPS.H.color[k]}">A_${k}</b> ← H_${k}</td><td>${f1(t.s)}</td><td>${f1(((t.phi % 360) + 360) % 360)}°</td><td>${f1(t.rho)} mm</td><td>${a ? f1(((a.phi % 360) + 360) % 360) + '°' : '—'}</td><td>${a ? f1(a.rho) + ' mm' : '—'}</td><td class="mono">${esc(fv(S.m.A[k] && S.m.A[k].pos))}</td><td>${S.m.A[k] && S.m.A[k].manual ? '<span class="warn">manually adjusted</span>' : 'computed'}</td></tr>`; });
    h += '</table>';
    if (gaps.length === 3) h += `<p class="small">H angular separations: ${gaps.map((g) => Math.round(g) + '°').join(' / ')} ${gaps.some((x) => x < 85 || x > 155) ? '<span class="warn">⚠ unusual (expected ≈120° each) – check marker placement</span>' : '<span class="muted">(plausible, ≈120°)</span>'}</p>`;
    h += `<div class="btnrow tight"><button class="btn sm" id="btnResetA" ${nMan ? '' : 'disabled'}>Reset ${nMan} manual A marker(s) to computed</button></div></div>`;
    $('transferTable').innerHTML = h;
    const b = $('btnResetA'); if (b) b.onclick = () => { HK.forEach((k) => { if (S.m.A[k]) S.m.A[k].manual = false; }); onChanged(); };
  }

  /* ---------------- UI: C-arm tab ---------------- */
  function heatState() { return { sel: S.sel, best: S.rankBest, prac: S.rankPrac, side: S.p.side }; }
  function rankTable(title, list, tag) {
    let h = `<h3 style="margin-top:4px">${title}</h3><table><tr><th>#</th><th>Projection</th><th>margin</th><th>gap</th><th>pair side</th><th>±2° stable</th><th>burden</th></tr>`;
    if (!list.length) h += '<tr><td colspan="7" class="muted">none</td></tr>';
    list.forEach((r) => { const sel = S.sel && S.sel.lao === r.lao && S.sel.cran === r.cran; h += `<tr class="click ${sel ? 'sel' : ''}" data-lao="${r.lao}" data-cran="${r.cran}"><td>${tag}${r.rank}</td><td><b>${esc(M.labelAngles(r.lao, r.cran))}</b></td><td>${f1(r.margin)} mm</td><td>${f1(r.gap)} mm</td><td>${r.pairSide < 0 ? '2L:1R' : '1L:2R'}</td><td>${r.stable ? 'yes' : 'no'}</td><td>${f1(r.burden)}°</td></tr>`; });
    return h + '</table>';
  }
  function renderCarm() {
    const g = S.scan;
    $('carmStatus').innerHTML = !S.cl ? '<span class="warn">Need centreline + three H markers (tabs 2/3).</span>' : !g ? '<span class="warn">A markers not available yet (need all three H markers).</span>' : `Axis at descending level s = ${f1(S.sD)} mm. Best margin on the grid: <b>${f1(g.best)} mm</b>. ${g.valid.reduce((a, b) => a + b, 0)} of ${g.valid.length} grid views are 2:1 with margin ≥ ${g.minMargin} mm.`;
    V.drawHeatmap($('cvHeat'), g, heatState());
    $('rankTables').innerHTML = g ? rankTable('Best separation (S) – ranked by margin, 4° spacing', S.rankBest, 'S') + '<div style="height:8px"></div>' + rankTable(`Most practical (P) – margin ≥ ${Math.round(S.p.pracFrac * 100)}% of best, smallest angles first`, S.rankPrac, 'P') : '';
    if (S.sel) { $('selLao').value = S.sel.lao; $('selCran').value = S.sel.cran; }
    renderSelected();
  }
  function renderSelected() {
    const sel = S.sel, ev = selEval();
    $('selBig').textContent = sel ? M.labelAngles(sel.lao, sel.cran) : '—';
    const lbl = HK.map((k) => 'A_' + k), colA = HK.map((k) => GROUPS.A.color[k]);
    let info = '', dA = null;
    if (sel && S.axis && HK.every((k) => S.m.A[k])) {
      dA = V.drawProjDiagram($('cvDiagA'), { title: 'Simulated angio view: A markers', C: S.axis.C, a: S.axis.a, pts: HK.map((k) => S.m.A[k].pos), labels: lbl, colors: colA, shape: 'diamond', lao: sel.lao, cran: sel.cran, minMargin: S.p.minMargin });
      if (ev && !ev.degenerate) {
        const names = HK.map((k, i) => ({ n: 'A_' + k, s: ev.s[i] }));
        const left = names.filter((x) => x.s < 0), right = names.filter((x) => x.s >= 0);
        info += ev.is21 ? `2:1 distribution: ${left.length === 2 ? '2 on image LEFT (' + left.map((x) => x.n).join(', ') + '), 1 on RIGHT (' + right[0].n + ')' : '1 on image LEFT (' + left[0].n + '), 2 on RIGHT (' + right.map((x) => x.n).join(', ') + ')'}\n` : 'NOT a 2:1 distribution at this angle.\n';
        info += `${ev.valid ? '✔ valid' : '✖ below min margin'} · margin (nearest marker to projected axis) ${f1(ev.margin)} mm · pair–single gap ${f1(ev.gap)} mm\n`;
        info += 'lateral offsets from projected axis (mm, + = image right): ' + names.map((x) => x.n + ' ' + (x.s >= 0 ? '+' : '') + f1(x.s)).join(' · ');
        const k = (sel.cran - M.CRAN_MIN) * S.scan.nL + (sel.lao - M.LAO_MIN); info += `\n±2° stable: ${S.scan.stable[k] ? 'yes' : 'no'} · angle burden ${f1(Math.hypot(sel.lao, sel.cran))}°`;
        const rb = S.rankBest.findIndex((r) => r.lao === sel.lao && r.cran === sel.cran), rp = S.rankPrac.findIndex((r) => r.lao === sel.lao && r.cran === sel.cran);
        if (rb >= 0) info += `\nlisted as S${rb + 1}`; if (rp >= 0) info += `\nlisted as P${rp + 1}`;
      } else info += 'Beam is nearly parallel to the centreline axis here - projection undefined.';
    } else V.drawProjDiagram($('cvDiagA'), { title: 'Simulated angio view: A markers', pts: [null] });
    if (sel && S.cl && HK.every((k) => S.m.H[k])) {
      const f = M.frameAt(S.cl, S.sH), dH = V.drawProjDiagram($('cvDiagH'), { title: 'Corresponding view: H markers (annulus axis)', C: f.C, a: f.T, pts: HK.map((k) => S.m.H[k]), labels: HK.map((k) => 'H_' + k), colors: HK.map((k) => GROUPS.H.color[k]), shape: 'circle', lao: sel.lao, cran: sel.cran, minMargin: 0 });
      if (dH) info += `\nH markers in the same beam direction, about the annulus-level axis: ${dH.nL} left : ${dH.nR} right (reference only; the centreline curves between the two levels, so this need not equal the A arrangement).`;
    } else V.drawProjDiagram($('cvDiagH'), { title: 'Corresponding view: H markers', pts: [null] });
    $('selInfo').textContent = info;
    const Hs = HK.map((k) => S.m.H[k] && S.tr ? { label: 'H_' + k, color: GROUPS.H.color[k], phi: S.tr[k].phi, rho: S.tr[k].rho } : null).filter(Boolean);
    const As = S.cl ? HK.map((k) => S.m.A[k] ? Object.assign({ label: 'A_' + k, color: GROUPS.A.color[k] }, M.angularPosition(S.cl, S.sD, S.m.A[k].pos)) : null).filter(Boolean) : [];
    V.drawPolar($('cvPolar2'), { title: 'Cross-section schematic with beam-plane trace', H: Hs, A: As, beam: beamInfo() });
  }
  function selectProjection(lao, cran, manual) {
    lao = Math.max(-60, Math.min(60, Math.round(lao))); cran = Math.max(-40, Math.min(40, Math.round(cran)));
    S.sel = { lao, cran }; S.selManual = manual !== false; renderAll();
  }

  /* ---------------- Summary ---------------- */
  function buildSummary() {
    renderCarm();
    const ev = selEval(), sel = S.sel, now = new Date();
    const id = $('sumId').value.trim(), age = $('sumAge').value.trim(), note = $('sumNote').value.trim();
    const img = (cv) => cv.toDataURL('image/png');
    let h = `<h1>Navitor Vision commissural alignment – planning summary</h1><div class="small">Investigational decision-support output · generated ${now.toLocaleDateString('en-GB')} ${now.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} (local) · ${esc(S.source || 'no CT loaded')}${id ? ' · ID: ' + esc(id) : ''}${age ? ' · age ' + esc(age) : ''}</div>`;
    h += `<div class="disc"><b>INVESTIGATIONAL – NOT VALIDATED – NOT FOR SOLE CLINICAL USE.</b> Marker-based (manual) calculation with approximate descending-aorta level and idealised C-arm geometry. Verify against 3mensio and live fluoroscopy. Generated entirely in the browser; no patient data transmitted. This sheet contains no patient name and no image pixels.</div>`;
    if (!sel || !ev) { h += '<p>No projection available – complete centreline and H markers first.</p>'; $('printArea').innerHTML = h; return; }
    h += `<h2>Selected C-arm projection (A markers 2:1)</h2><div class="big">${esc(M.labelAngles(sel.lao, sel.cran))}</div>`;
    const names = HK.map((k, i) => ({ n: 'A_' + k, s: ev.s[i] })), left = names.filter((x) => x.s < 0), right = names.filter((x) => x.s >= 0);
    h += `<div>${ev.is21 ? `Distribution: <b>${left.length} left : ${right.length} right</b> (left: ${left.map((x) => x.n).join(', ') || '—'}; right: ${right.map((x) => x.n).join(', ') || '—'}) · margin <b>${f1(ev.margin)} mm</b> · pair–single gap ${f1(ev.gap)} mm` : '<b>Not 2:1 at this angle</b>'}${ev.valid ? '' : ' · <b>below minimum margin</b>'}</div>`;
    h += `<div class="small">Convention: LAO + / RAO −, CRAN + / CAUD −; AP = 0°/0°; supine head-first; image as seen from detector. Lateral offsets (mm, + = image right of projected axis): ${names.map((x) => x.n + ' ' + (x.s >= 0 ? '+' : '') + f1(x.s)).join(', ')}.</div>`;
    h += `<div class="small">Alternatives – best separation: ${S.rankBest.slice(0, 3).map((r) => esc(M.labelAngles(r.lao, r.cran)) + ' (' + f1(r.margin) + ' mm)').join('; ') || '—'}. Most practical: ${S.rankPrac.slice(0, 3).map((r) => esc(M.labelAngles(r.lao, r.cran)) + ' (' + f1(r.margin) + ' mm)').join('; ') || '—'}.</div>`;
    h += `<h2>Marker coordinates (DICOM patient LPS, mm: x + left, y + posterior, z + superior)</h2><table><tr><th>Marker</th><th>x</th><th>y</th><th>z</th><th>angle about centreline*</th><th>radius</th><th>level s</th><th>source</th></tr>`;
    HK.forEach((k) => { const P = S.m.H[k]; if (!P || !S.tr) return; const t = S.tr[k]; h += `<tr><td>H_${k}</td><td>${f1(P[0])}</td><td>${f1(P[1])}</td><td>${f1(P[2])}</td><td>${f1(((t.phi % 360) + 360) % 360)}°</td><td>${f1(t.rho)} mm</td><td>${f1(t.s)} mm</td><td>${(S.auto.hsrc || {})[k] === 'auto' ? `auto-detected (EXPERIMENTAL, conf ${S.auto.result ? S.auto.result.confidence : '?'}%) – verify` : 'user-marked'}</td></tr>`; });
    HK.forEach((k) => { const a = S.m.A[k]; if (!a) return; const t = M.angularPosition(S.cl, S.sD, a.pos); h += `<tr><td>A_${k}</td><td>${f1(a.pos[0])}</td><td>${f1(a.pos[1])}</td><td>${f1(a.pos[2])}</td><td>${f1(((t.phi % 360) + 360) % 360)}°</td><td>${f1(t.rho)} mm</td><td>${f1(S.sD)} mm</td><td>${a.manual ? 'manually adjusted' : 'computed (RMF transfer)'}</td></tr>`; });
    GROUPS.nadir.keys.forEach((k) => { const P = S.m.nadir[k]; if (P) h += `<tr><td><b style="color:${GROUPS.nadir.color[k]};text-shadow:0 0 1px #000">▲</b> Nadir ${k}</td><td>${f1(P[0])}</td><td>${f1(P[1])}</td><td>${f1(P[2])}</td><td>—</td><td>—</td><td>—</td><td>${S.auto.src[k] === 'auto' ? `auto-detected (EXPERIMENTAL, conf ${S.auto.result ? S.auto.result.confidence : '?'}%) – verify` : 'optional'}</td></tr>`; });
    h += `</table><div class="small">*Angle about the smoothed centreline, measured clockwise (looking along the centreline direction, bifurcation → apex) from the RMF reference axis N1. Centreline: ${S.m.cl.length} manual points, Gaussian smoothing σ = ${S.p.smoothMm} mm, length ${f1(S.cl.length)} mm. Annulus level s = ${f1(S.sH)} mm; descending-aorta level s = ${f1(S.sD)} mm (from bifurcation). Angle reference: ${S.p.refMode === 'own' ? 'each H at its own level' : 'common level'}; A radius: ${S.p.radMode}${S.p.radMode === 'fixed' ? ' ' + S.p.fixedR + ' mm' : ''}. Minimum margin for 2:1: ${S.p.minMargin} mm.</div>`;
    h += `<h2>Simulated views</h2><div class="imgs"><img src="${img($('cvDiagA'))}" width="200"><img src="${img($('cvDiagH'))}" width="200"><img src="${img($('cvPolar2'))}" width="200"></div>`;
    h += `<h2>Projection map (margin of the 2:1 arrangement, mm)</h2><img src="${img($('cvHeat'))}" width="470">`;
    h += `<h2>Intra-procedural reminder (from the protocol)</h2><div class="small">With the FlexNav flush port at 12 o’clock, reproduce the arrangement of the three A markers (2 on one side : 1 on the other, as predicted above) in the NCC-isolation view; record the C-arm angle used. ${note ? '<br>Note: ' + esc(note) : ''}</div>`;
    h += `<div class="small" style="margin-top:6px"><b>Limitations:</b> manual marker placement (no automatic segmentation); descending-aorta level chosen by the user; rotation-minimising frame may differ from the vendor straightening frame; ideal orthographic C-arm model; sign convention to be verified on the angiography system. Not validated against clinical outcomes.</div>`;
    $('printArea').innerHTML = h;
  }

  /* ---------------- help ---------------- */
  function helpHTML() {
    return `<h2>Method &amp; assumptions</h2>
<h3>Protocol implemented</h3><ol>
<li>CT covering upper chest/aortic root to the femoral arteries.</li><li>Open the aortic-valve series (any DICOM series; choose in tab 1).</li>
<li>Mark native commissures H_NL, H_NR, H_LR at the annular/SOV level (after cusp nadirs; nadirs optional).</li>
<li>Define the aortic centreline by manual points from the aortic bifurcation to the cardiac apex; it is smoothed (centripetal Catmull-Rom, Gaussian σ).</li>
<li>For each H marker, its angle about the local centreline (in a rotation-minimising frame) and radial offset are measured at the marker's level (or a common annulus level).</li>
<li>The same angle/offset is re-applied at a chosen level in the descending aorta, giving A_NL, A_NR, A_LR in 3D patient coordinates (draggable).</li>
<li>All C-arm projections LAO/RAO −60…+60°, CRAN/CAUD −40…+40° (1° grid) are tested: the A markers are projected orthographically; a projection is "2:1" when the signed lateral distances of the three markers from the projected centreline axis split 2 vs 1 and the nearest marker is at least <i>min margin</i> mm from the axis. Margin = distance of the nearest marker to the axis (mm). Gap = lateral distance between the single marker and the nearest pair marker.</li>
<li>Record the angle; during TAVI place the FlexNav flush port at 12 o'clock and reproduce the 2-left/1-right arrangement in the NCC-isolation view.</li></ol>
<h3>Conventions</h3><ul>
<li>Patient coordinates = DICOM LPS: x → patient left, y → posterior, z → superior (mm).</li>
<li>C-arm: LAO positive, RAO negative; CRAN positive, CAUD negative. Beam direction (source→detector) d = (sin LAO·cos CRAN, −cos LAO·cos CRAN, sin CRAN). AP = 0°/0° has the source posterior and detector anterior. Image is displayed as seen from the detector: at AP patient-left is on image right, head is up.</li>
<li>Angles about the centreline are measured clockwise as seen looking along the centreline direction (bifurcation → apex), from the RMF reference axis N1.</li></ul>
<h3>Marker colours</h3><ul>
<li><b style="color:#ffd600">▲ NCC = yellow</b>, <b style="color:#d50000">▲ LCC = red</b>, <b style="color:#00c853">▲ RCC = green</b> (cusp nadirs: triangles with a white outline, in markers, labels, lists, cross-sections, diagrams and the summary).</li>
<li>H commissure markers are <b>circles</b>: H_NL <span style="color:#ff5252">red</span>, H_NR <span style="color:#69f0ae">green</span>, H_LR <span style="color:#448aff">blue</span> (unchanged; lighter tones than the nadir red/green, different shape, and always labelled). A markers are diamonds.</li>
<li>Centreline points were yellow (now clashing with NCC) and are now <b style="color:#00e5ff">cyan</b>; the root seed is a magenta ⊕.</li></ul>
<h3>Auto-detect nadirs + commissures (EXPERIMENTAL, semi-automatic)</h3><ul>
<li>One button places the three nadirs <b>and</b> the native commissure markers H_NL, H_NR, H_LR. Each commissure is at the <b>angular midpoint between the two adjacent nadir directions</b> about the root axis (H_NL between NCC and LCC, H_NR between NCC and RCC, H_LR between LCC and RCC), at the <b>apex of the cusp-attachment crown</b> (typically 12-22 mm above the nadir plane; a typical height is used and flagged if it cannot be measured) and on the <b>lumen wall</b> at that angle. Existing H markers are replaced (Undo restores them). If the commissures look ambiguous (heights disagree, inter-sinus notch not at the midpoint, atypically low) the confidence is reduced and a warning is shown. <b>Rotate labels</b> renames the H markers consistently with the cusps.</li>
<li>Needs a starting point: <b>Set root seed</b> (click inside the contrast-filled aortic root, mid-sinus level) or <b>Seed = crosshair</b>; if there is no seed, the H-marker centroid (with a centreline) or the root end of a centreline with ≥ 3 points is used.</li>
<li>Method: lumen region-growing from the seed (adaptive threshold from the local HU, ≈ half-way between the seed HU and soft tissue, limited to a 40 mm sphere) → morphological clean-up → root axis (centreline tangent if available, otherwise PCA of the lumen plus a search over tilted axes, refined from the sinus-level lumen centres) → area profile along the axis to find the sinus level/annulus → pocket depth in 72 angular bins → best three pockets about 120° apart → the lowest (most ventricular) lumen points of each pocket are the nadirs.</li>
<li>Labels: viewed from the aorta looking toward the LV, RCC → LCC → NCC run counter-clockwise (in LPS this is right-handed about the LV→aorta axis). RCC is the anterior-right cusp, LCC left(-posterior), NCC posterior-right next to the interatrial septum. The assignment uses this handedness plus these direction priors; if the guess is wrong use <b>Rotate labels</b> (cyclic, keeps the handedness).</li>
<li>A confidence score (0-100: sinus relief, three-lobed shape, 120° spacing, planarity, prominence, label certainty) is shown; below 25 nothing is placed. <b>The score is not a validated accuracy.</b> Always check every point in the MPRs and cross-section and drag it if needed; markers stay draggable. <b>Undo auto-detect</b> restores the previous nadirs.</li>
<li>Validated on <b>synthetic phantoms only</b> (nadirs: mean error ≈ 2 mm, systematically a little too high; commissures: angle error mean ≈ 1-2°, worst 3.5°, position ≈ 0.6-1.8 mm - but the phantom commissure is defined as the angular midpoint, which is the detector's own assumption, so this does not show that real commissures lie there); it has <b>not been tested on real CT</b>. It can fail or mislead on calcified/stented roots, bicuspid valves, motion, poor opacification, or strongly tilted roots (&gt; ≈ 35-40° from the scanner z-axis) without a centreline.</li></ul>
<h3>Oblique / double-oblique MPR</h3><ul>
<li>The blue crosshair lines in each Mark-tab view are the traces of the other two planes. <b>Drag a round handle at a line end</b> to rotate the other two planes about this view's normal (the three planes stay mutually orthogonal; the dragged view's image stays put and its lines tilt). <b>Drag a line</b> to move that plane. The rotation angles are shown in every view and in the info box; <b>Reset orientation</b> restores scanner axes; <b>Align to centreline</b> makes the axial plane perpendicular to the centreline at the cursor.</li>
<li>Scrolling, arrow keys and sliders step along the rotated normal; markers, cursor/LPS/HU readouts and W/L, zoom, pan work in rotated views. Marker coordinates, the transfer step and the C-arm maths are always in patient (LPS) space and are not changed by rotating a view.</li></ul>
<h3>Approximations / limitations</h3><ul>
<li>Marker placement is manual, except the optional <b>experimental</b> “Auto-detect nadirs” (see below). There is no automatic centreline or commissure detection.</li>
<li>The descending-aorta level is user-chosen; the default is an arbitrary heuristic (80 mm of centreline below the highest point of the centreline).</li>
<li>The rotation-minimising (parallel-transport) frame is a mathematical model of "same rotational angle in the stretched view"; 3mensio's own straightened frame may differ, particularly around the arch. Always compare with 3mensio.</li>
<li>C-arm geometry is idealised (orthographic projection, isocentric, no table rotation/tilt, no magnification/parallax, no gantry/cradle offsets, patient lying as in the CT). Real fluoroscopy angles may differ; sign conventions differ between systems and must be verified.</li>
<li>DICOM: uncompressed (implicit/explicit VR little endian, explicit big endian, deflated), JPEG Lossless (Process 14 / SV1, hand-decoded), JPEG Baseline/Extended (8/12-bit, grey-scale only) and RLE Lossless. JPEG 2000, JPEG-LS, progressive JPEG, colour images and multi-frame (enhanced) CT are not supported. Series are chosen from a list; large folders (thousands of files, several series) are scanned header-only and only the selected series is decoded.</li>
<li>The tool has not been validated clinically or against 3mensio. No claim of accuracy is made.</li></ul>
<h3>Privacy</h3><p>Everything runs in this browser tab. No network requests are made with patient data; the page contains no external scripts or fonts. Patient name/ID/birth-date DICOM tags are never read. Close the tab to discard all data.</p>`;
  }

  /* ---------------- loading ---------------- */
  function setProgress(a, b, label) { $('progBar').style.width = (100 * a / Math.max(b, 1)) + '%'; if (label) $('loadStatus').textContent = label + ' ' + a + '/' + b; }
  function status(msg, cls) { const e = $('loadStatus'); e.textContent = msg; e.className = 'status ' + (cls || ''); }
  function setVolume(vol, label, truth) {
    S.vol = vol; S.source = label; S.truth = truth || null; S.volId++;
    S.m = { nadir: { NCC: null, LCC: null, RCC: null }, H: { NL: null, NR: null, LR: null }, cl: [], A: { NL: null, NR: null, LR: null } };
    S.p.descS = null; S.p.annS = null; S.sel = null; S.selManual = false; S.cross = vol.bbox.centre.slice(); cprCache = null; S.orient = Q.identity(); S.seed = null; S.auto = { prev: null, result: null, src: {}, hsrc: {} }; if ($('autoNadirOut')) autoStatus('');
    $('btnDemoMarkers').disabled = !truth; S.tool = 'nav';
    $('volInfo').textContent = `Source: ${label}\ndims: ${vol.dims.join(' × ')} voxels · spacing ${vol.spacing.map((x) => x.toFixed(2)).join(' × ')} mm\nextent (LPS, mm): x ${f1(vol.bbox.lo[0])}…${f1(vol.bbox.hi[0])}, y ${f1(vol.bbox.lo[1])}…${f1(vol.bbox.hi[1])}, z ${f1(vol.bbox.lo[2])}…${f1(vol.bbox.hi[2])}${vol.warnings.length ? '\n⚠ ' + vol.warnings.join('\n⚠ ') : ''}`;
    fitViews(); update(); renderAll();
  }
  function loadPhantom() {
    const g = PH.generate({ spacing: 2 });
    setVolume(new VOL.Volume(g.volume), 'Synthetic phantom (no patient data)', g.truth);
    S.cross = g.truth.centreline.pts[Math.round(g.truth.sRoot / 0.7)].slice(); S.wl = { c: 200, w: 800 }; syncWL(); status('Synthetic phantom loaded (128×128×210 voxels, 2 mm).', 'ok'); renderAll();
  }
  function demoMarkers() {
    if (!S.truth) return; const t = S.truth;
    S.m.cl = t.demoCtrl().map((p) => p.map((v) => Math.round(v * 10) / 10));
    HK.forEach((k) => { S.m.H[k] = t.H[k].map((v) => Math.round(v * 10) / 10); }); GROUPS.nadir.keys.forEach((k) => { S.m.nadir[k] = t.nadir[k].map((v) => Math.round(v * 10) / 10); });
    S.m.A = { NL: null, NR: null, LR: null }; S.selManual = false; S.p.descS = null;
    const cen = M.mul(HK.reduce((a, k) => M.add(a, S.m.H[k]), [0, 0, 0]), 1 / 3); S.cross = cen; onChanged();
  }
  let busy = false;
  /* ---------------- auto-detect nadirs (experimental) ---------------- */
  const confClass = (q) => q === 'good' ? 'ok' : q === 'fair' ? 'warn' : 'err';
  function autoStatus(html) { $('autoNadirOut').innerHTML = html; }
  function updateAutoButtons() {
    const have3 = GROUPS.nadir.keys.every((k) => S.m.nadir[k]);
    $('btnRotNadir').disabled = !have3; $('btnUndoNadir').disabled = !S.auto.prev; $('btnAutoNadir').disabled = !S.vol || autoBusy;
  }
  let autoBusy = false;
  function flowAxisAt(P) {                              // centreline runs bifurcation -> apex (toward the LV): flow axis at the root = -tangent
    if (!S.cl) return null; const q = M.nearestS(S.cl, P); if (!q || q.dist > 30) return null;
    const T = M.frameAt(S.cl, q.s).T; return M.mul(T, -1);
  }
  async function autoDetect() {
    if (!S.vol || autoBusy) return;
    let seed = S.seed, how = 'seed';
    const HKs = HK.filter((k) => S.m.H[k]);
    if (!seed && S.cl && HKs.length) { const c = M.mul(HKs.reduce((a, k) => M.add(a, S.m.H[k]), [0, 0, 0]), 1 / HKs.length); const q = M.nearestS(S.cl, c); seed = M.frameAt(S.cl, q.s).C; how = 'H markers + centreline'; }
    if (!seed && !(S.cl && S.m.cl.length >= 3)) { autoStatus('<span class="warn">Auto-detect needs a starting point: use “Set root seed” and click inside the contrast-filled aortic root (centre of the sinuses), or press “Seed = crosshair”, or place ≥ 3 centreline points first.</span>'); return; }
    autoBusy = true; updateAutoButtons(); autoStatus('<span class="muted">Detecting… (region growing around the seed, ~1 s)</span>'); await new Promise((r) => setTimeout(r, 40));
    let res;
    try {
      if (seed) res = NN.detect(S.vol, seed, { axisHint: flowAxisAt(seed) });
      else {                                            // centreline only: try candidate positions along the last 70 mm of the centreline (toward the LV), keep the most confident
        let best = null; const L = S.cl.length;
        for (let s = Math.max(0, L - 70); s <= L - 4; s += 6) { const C = M.frameAt(S.cl, s).C, r = NN.detect(S.vol, C, { axisHint: flowAxisAt(C), res: 1.1, half: 44 }); if (r.ok && (!best || r.confidence > best.res.confidence)) best = { res: r, C }; await new Promise((r2) => setTimeout(r2, 0)); }
        if (best) { seed = best.C; how = 'centreline scan'; res = NN.detect(S.vol, seed, { axisHint: flowAxisAt(seed) }); if (!res.ok) res = best.res; }
        else res = { ok: false, message: 'No aortic root pattern (sinus bulge with three pockets) was found along the end of the centreline. Click “Set root seed” inside the opacified aortic root and try again.' };
      }
    } catch (e) { res = { ok: false, message: 'Auto-detect could not run on this volume (' + e.message + '). Place the nadirs manually.' }; }
    autoBusy = false;
    if (!res.ok) { autoStatus(`<div class="warn"><b>Auto-detect did not find the nadirs / commissures.</b> ${esc(res.message)}</div><div class="muted small">Nothing was changed. You can place the markers manually.</div>`); updateAutoButtons(); return; }
    if (res.confidence < 25) { autoStatus(`<div class="warn"><b>Auto-detect found a candidate but with very low confidence (${res.confidence}%) – not placed.</b> ${res.warnings.map(esc).join(' ')}</div>`); updateAutoButtons(); return; }
    const hadH = HK.some((k) => S.m.H[k]);
    S.auto.prev = JSON.parse(JSON.stringify(S.m.nadir)); S.auto.prevH = JSON.parse(JSON.stringify(S.m.H)); S.auto.prevSrc = Object.assign({}, S.auto.src); S.auto.prevHsrc = Object.assign({}, S.auto.hsrc || {}); S.auto.result = res; S.auto.replacedH = hadH;
    GROUPS.nadir.keys.forEach((k) => { S.m.nadir[k] = res.nadirs[k].map((v) => Math.round(v * 10) / 10); S.auto.src[k] = 'auto'; });
    S.auto.hsrc = {}; if (res.commissures) HK.forEach((k) => { S.m.H[k] = res.commissures[k].map((v) => Math.round(v * 10) / 10); S.auto.hsrc[k] = 'auto'; });
    if (!S.seed) S.seed = seed.map((v) => Math.round(v * 10) / 10);
    S.cross = M.mul(GROUPS.nadir.keys.reduce((a, k) => M.add(a, S.m.nadir[k]), [0, 0, 0]), 1 / 3);
    onChanged(); renderAutoResult(); updateAutoButtons();
  }
  function renderAutoResult() {
    const r = S.auto.result; if (!r) { return; }
    const edited = GROUPS.nadir.keys.some((k) => S.auto.src[k] !== 'auto') || HK.some((k) => (S.auto.hsrc || {})[k] !== 'auto'), ci = r.commissureInfo;
    autoStatus(`<div class="autoBadge ${confClass(r.quality)}">Auto-detected nadirs + commissures – confidence ${r.confidence}% (${r.quality})${edited ? ' · edited since' : ''}</div>
<div class="warn small"><b>EXPERIMENTAL – verify every point.</b> Check each triangle (nadirs) against the sinus floors and each H circle (commissures) against the sinus-to-sinus junction/wall in the three views and drag it if needed. Cusp names are a guess from anatomy (RCC anterior-right, LCC left, NCC posterior-right); press “Rotate labels” if they are wrong (H labels follow).</div>
${S.auto.replacedH ? '<div class="muted small">Existing H markers were replaced – “Undo auto-detect” restores them.</div>' : ''}
${ci ? `<div class="muted small mono">commissures: angular midpoints between adjacent nadirs · apex ≈ ${f1(ci.riseAboveNadirs)} mm above the nadir plane (SD ${f1(ci.heightSD)} mm)${ci.usedFallback ? ' · <span class="warn">typical height used for some</span>' : ''} · notch offset ${ci.notchDeviationDeg === ci.notchDeviationDeg && ci.notchDeviationDeg != null ? Math.round(ci.notchDeviationDeg) + '°' : 'n/a'} · commissure score ${ci.score}% (nadirs alone ${r.nadirConfidence}%)</div>` : ''}
<div class="muted small mono">lumen ${r.lumenHU} HU (threshold ${r.thresholdHU}) · sinus area ${r.sinusAreaMm2} mm² · nadir-plane Ø ≈ ${f1(r.nadirPlaneDiameterMm)} mm · pocket gaps ${r.gaps.map((g) => g + '°').join('/')} · pocket relief ${f1(r.relief)} mm · ${r.closedValve ? 'closed-valve pattern' : 'open valve / LVOT continuous'} · ${r.ms} ms</div>
${r.warnings.length ? '<ul class="warn small">' + r.warnings.map((w) => '<li>' + esc(w) + '</li>').join('') + '</ul>' : ''}`);
  }
  function rotateNadirLabels() {
    if (!GROUPS.nadir.keys.every((k) => S.m.nadir[k])) return;
    S.auto.prevForRot = null; S.m.nadir = NN.rotateLabels(S.m.nadir); S.auto.src = NN.rotateLabels(S.auto.src);
    const rotH = HK.every((k) => S.m.H[k]) && HK.some((k) => (S.auto.hsrc || {})[k] === 'auto');           // H markers that belong to an auto-detected set follow the relabel (each H keeps its pair of cusps)
    if (rotH) { S.m.H = NN.rotateH(S.m.H); S.auto.hsrc = NN.rotateH(S.auto.hsrc); }
    onChanged(); updateAutoButtons();
    if (S.auto.result) autoStatus($('autoNadirOut').innerHTML + '<div class="muted small">Labels rotated (RCC → LCC → NCC order kept)' + (rotH ? '; H_NL / H_NR / H_LR renamed to match their cusp pairs' : '') + '.</div>');
  }
  function undoAutoNadirs() {
    if (!S.auto.prev) return; S.m.nadir = S.auto.prev; if (S.auto.prevH) S.m.H = S.auto.prevH; S.auto.src = S.auto.prevSrc || {}; S.auto.hsrc = S.auto.prevHsrc || {}; S.auto.prev = null; S.auto.prevH = null; S.auto.result = null; onChanged(); updateAutoButtons(); autoStatus('<span class="muted">Auto-detected nadirs + commissures removed; previous nadirs and H markers restored.</span>');
  }

  async function loadSeries(series) {
    if (busy) { status('Still busy – wait for the current load to finish.', ''); return; }
    busy = true; S.loadedSeries = series; renderSeriesList();
    status('Decoding ' + series.recs.length + ' slices…'); setProgress(0, 1); await new Promise((r) => setTimeout(r, 20));
    try {
      const t0 = Date.now();
      const g = await D.buildVolume(series, {}, (a, b) => setProgress(a, b, 'Decoding slices'));
      const vol = new VOL.Volume(g); setVolume(vol, 'DICOM series “' + (series.desc || 'no description') + '” (' + g.info.slices + ' slices, ' + g.info.cols + '×' + g.info.rows + (g.info.codec && g.info.codec !== 'uncompressed' ? ', ' + g.info.codec : '') + ')');
      series.recs.forEach((r) => r.src.release && r.src.release());
      status('Loaded ' + g.info.slices + ' slices – ' + vol.dims.join('×') + ' voxels (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s).' + (g.warnings.length ? ' ⚠ ' + g.warnings.join(' ⚠ ') : ''), g.warnings.length ? '' : 'ok');
      S.wl = { c: 200, w: 700 }; syncWL(); renderAll();
    } catch (e) { S.loadedSeries = null; status('Could not build volume: ' + e.message, 'err'); }
    finally { busy = false; renderSeriesList(); }
  }
  function renderSeriesList() {
    const sc = S.seriesScan; if (!sc) { $('seriesList').innerHTML = ''; return; }
    let h = '';
    if (sc.series.length) {
      h += `<h3>Series found (${sc.series.length})</h3><div class="muted small">Only the series you load is decoded. Best match for a TAVI planning CT (axial, thin, contrast) is pre-selected.</div><div class="tblwrap"><table class="serTbl"><tr><th></th><th>Description</th><th>Mod.</th><th>Slices</th><th>Matrix</th><th>Spacing</th><th>Orient.</th><th>Coverage</th><th>Contrast</th><th>Codec</th><th>Notes</th></tr>`;
      sc.series.forEach((s, i) => {
        const sel = s === S.loadedSeries, sp = s.step ? s.step.toFixed(2) + (s.thickness && Math.abs(s.thickness - s.step) > 0.05 ? ' (thk ' + s.thickness.toFixed(2) + ')' : '') + ' mm' : '–';
        const notes = s.reasons.map((r) => esc(r)).join(', ') + (s.warnings.length ? ` <span class="warn">${s.warnings.map((r) => esc(r)).join(', ')}</span>` : '');
        h += `<tr class="${sel ? 'sel' : ''}"><td><button class="btn sm ${s.preselect && !sel ? 'primary' : ''}" data-act="series" data-i="${i}" ${busy ? 'disabled' : ''}>${sel ? 'Loaded' : 'Load'}</button></td><td>${s.preselect ? '★ ' : ''}${esc(s.desc || '(no description)')}${s.number != null ? ' <span class="muted">#' + esc(Array.isArray(s.number) ? s.number[0] : s.number) + '</span>' : ''}${s.phase ? ' <span class="muted">[' + esc(s.phase) + ']</span>' : ''}</td><td>${esc(s.modality)}</td><td>${s.recs.length}${s.recs.length < 30 ? ' <span class="warn">few</span>' : ''}</td><td>${s.cols}×${s.rows}</td><td>${sp}</td><td>${esc(s.orientation)}</td><td>${s.coverage ? Math.round(s.coverage) + ' mm' : '–'}</td><td>${s.contrast ? 'yes' : '–'}</td><td>${esc(s.codec || 'raw')}</td><td class="small">${notes}</td></tr>`;
      });
      h += '</table></div>';
    }
    const sk = sc.skipped, parts = Object.keys(sk).filter((k) => sk[k]).map((k) => `${sk[k]} ${sc.skipLabels[k] || k}`);
    if (parts.length) h += `<div class="muted small">Skipped (not used, not an error): ${parts.join('; ')}.</div>`;
    const bad = Object.keys(sc.badCodecs || {}); if (bad.length) h += `<div class="warn small">Unsupported compression: ${bad.map((u) => esc(NavCodecs.tsName(u)) + ' (' + sc.badCodecs[u] + ' files)').join('; ')}.</div>`;
    $('seriesList').innerHTML = h;
  }
  async function handleFiles(files) {
    files = [...files]; if (!files.length || busy) return; S.seriesScan = null; S.loadedSeries = null; renderSeriesList();
    busy = true; status('Scanning ' + files.length + ' file(s)…'); setProgress(0, 1);
    let sc;
    try {
      const t0 = Date.now();
      sc = await D.loadFiles(files, (a, b) => setProgress(a, b, 'Scanning files'));
      S.seriesScan = sc; setProgress(1, 1);
    } catch (e) { busy = false; status('Error: ' + e.message, 'err'); return; }
    busy = false; renderSeriesList();
    if (!sc.series.length) {
      const sk = sc.skipped, bad = Object.keys(sc.badCodecs || {});
      status(sk['unsupported-codec'] ? `No readable images: ${sk['unsupported-codec']} file(s) use a compression this app cannot decode (${bad.map((u) => NavCodecs.tsName(u)).join('; ')}). Supported: uncompressed, JPEG Lossless (Process 14 / SV1), JPEG Baseline, RLE. Export the CT uncompressed, or decompress it (e.g. gdcmconv --raw / dcmdjpeg) and retry.` : sk.multiframe ? 'Multi-frame / enhanced DICOM is not supported - export as classic single-frame CT slices.' : 'No readable single-frame grayscale DICOM slices with position information were found in the selection.', 'err'); return;
    }
    const pick = sc.series.find((x) => x.preselect) || (sc.series.length === 1 ? sc.series[0] : null);
    if (pick) await loadSeries(pick);
    else status(sc.series.length + ' series found, none looks like an axial CT stack – choose one below and press Load.', '');
  }
  async function filesFromDrop(dt) {
    const items = dt.items ? [...dt.items] : [], entries = items.map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
    if (!entries.length) return [...dt.files];
    const files = [];
    const walk = async (en) => {
      if (en.isFile) await new Promise((res) => en.file((f) => { files.push(f); res(); }, res));
      else if (en.isDirectory) { const rd = en.createReader(); for (;;) { const batch = await new Promise((res) => rd.readEntries(res, () => res([]))); if (!batch.length) break; for (const b of batch) await walk(b); } }
    };
    for (const en of entries) await walk(en);
    return files;
  }

  /* ---------------- session ---------------- */
  function saveSession() {
    const o = { format: 'navitor-align-session', version: 1, note: 'coordinates only (LPS mm); no image data', markers: { nadir: S.m.nadir, H: S.m.H, cl: S.m.cl, A: S.m.A, seed: S.seed }, orient: S.orient, params: S.p, selection: S.sel, meta: { id: $('sumId').value, age: $('sumAge').value } };
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(o, null, 1)], { type: 'application/json' })); a.download = 'navitor-align-markers.json'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function loadSession(file) {
    try { const o = JSON.parse(await file.text()); if (o.format !== 'navitor-align-session') throw new Error('not a session file');
      S.m = { nadir: o.markers.nadir, H: o.markers.H, cl: o.markers.cl, A: o.markers.A || { NL: null, NR: null, LR: null } }; S.seed = o.markers.seed || null; S.auto = { prev: null, result: null, src: {}, hsrc: {} }; if (S.vol) applyOrient(o.orient && o.orient.X && o.orient.Y ? Q.orthonormalise(o.orient) : Q.identity()); Object.assign(S.p, o.params || {}); if (o.selection) { S.sel = o.selection; S.selManual = true; }
      $('sumId').value = (o.meta && o.meta.id) || ''; $('sumAge').value = (o.meta && o.meta.age) || ''; syncControls(); onChanged(); status('Markers loaded.', 'ok');
    } catch (e) { status('Could not load markers: ' + e.message, 'err'); }
  }
  function syncControls() {
    $('smooth').value = S.p.smoothMm; $('chkAnnAuto').checked = S.p.annAuto; $('refMode').value = S.p.refMode; $('radMode').value = S.p.radMode; $('fixedR').value = S.p.fixedR; $('cprAngle').value = S.p.cprAngle;
    $('minMargin').value = S.p.minMargin; $('pracFrac').value = Math.round(S.p.pracFrac * 100); $('sideSel').value = S.p.side; $('chkStable').checked = S.p.stableOnly;
  }

  /* ---------------- render orchestration ---------------- */
  let raf = 0;
  function renderAll() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; renderNow(); }); }
  function renderNow() {
    const t = S.tab;
    if (t === 'mark') { updateSliceBars(); renderToolList(); renderMarkSummary(); renderCursorInfo(); views.axial.draw(); views.coronal.draw(); views.sagittal.draw(); }
    else if (t === 'transfer') renderTransfer();
    else if (t === 'carm') renderCarm();
  }
  function onChanged(fromDrag) { update(); Object.values(views).forEach((v) => { if (v.kind === 'xsec') v.dirty = true; }); cprCache = null; renderAll(); }
  function setTab(t) {
    S.tab = t; document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
    document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + t));
    if (t === 'summary') buildSummary(); renderNow();
  }

  /* ---------------- init ---------------- */
  function init() {
    mkMPR('axial', 'cvAxial'); mkMPR('coronal', 'cvCoronal'); mkMPR('sagittal', 'cvSagittal'); mkXsec('ann', 'cvXAnn'); mkXsec('desc', 'cvXDesc');
    $('helpText').innerHTML = helpHTML();
    document.querySelectorAll('#tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab)));
    $('btnPhantom').onclick = loadPhantom; $('btnDemoMarkers').onclick = () => { demoMarkers(); setTab('mark'); };
    ['inFiles', 'inFolder', 'inZip'].forEach((id) => $(id).addEventListener('change', (e) => { handleFiles(e.target.files); e.target.value = ''; }));
    const drop = $('drop');
    ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', async (e) => { e.preventDefault(); const files = await filesFromDrop(e.dataTransfer); handleFiles(files); });
    window.addEventListener('dragover', (e) => e.preventDefault()); window.addEventListener('drop', (e) => e.preventDefault());
    $('seriesList').addEventListener('click', (e) => { const b = e.target.closest('[data-act=series]'); if (b) loadSeries(S.seriesScan.series[+b.dataset.i]); });
    $('btnSaveSession').onclick = saveSession; $('inSession').addEventListener('change', (e) => { if (e.target.files[0]) loadSession(e.target.files[0]); e.target.value = ''; });
    // mark tab panel
    const act = (e) => { const b = e.target.closest('[data-act]'); if (!b) return; const a = b.dataset.act;
      if (a === 'tool') { S.tool = b.dataset.tool; renderAll(); }
      else if (a === 'del') deleteMarker(b.dataset.id);
      else if (a === 'goto') { const m = allMarkers().find((x) => x.id === b.dataset.id); if (m) { S.cross = m.pos.slice(); renderAll(); } } };
    $('toolList').addEventListener('click', act); $('clList').addEventListener('click', act);
    $('btnClReverse').onclick = () => { S.m.cl.reverse(); onChanged(); };
    $('btnClClear').onclick = () => { S.m.cl = []; onChanged(); };
    $('btnClearAll').onclick = () => { S.seed = null; S.auto = { prev: null, result: null, src: {}, hsrc: {} }; autoStatus(''); S.m = { nadir: { NCC: null, LCC: null, RCC: null }, H: { NL: null, NR: null, LR: null }, cl: [], A: { NL: null, NR: null, LR: null } }; S.sel = null; S.selManual = false; onChanged(); };
    $('btnFitAll').onclick = () => { fitViews(); renderAll(); };
    $('btnResetOrient').onclick = resetOrient; $('btnAlignCl').onclick = alignToCentreline;
    $('btnAutoNadir').onclick = autoDetect; $('btnRotNadir').onclick = rotateNadirLabels; $('btnUndoNadir').onclick = undoAutoNadirs;
    $('btnSeedCross').onclick = () => { if (!S.vol) return; S.seed = S.cross.map((v) => Math.round(v * 10) / 10); onChanged(); };
    addSliceBars(); $('chkInvScroll').addEventListener('change', (e) => { S.invertScroll = e.target.checked; });
    $('btnGoRoot').onclick = () => { const h = HK.filter((k) => S.m.H[k]); if (h.length) { S.cross = M.mul(h.reduce((a, k) => M.add(a, S.m.H[k]), [0, 0, 0]), 1 / h.length); renderAll(); } };
    $('wlPresets').innerHTML = Object.keys(PRESETS).map((k) => `<button class="btn sm" data-p="${k}">${k}</button>`).join('');
    $('wlPresets').addEventListener('click', (e) => { const k = e.target.dataset.p; if (k) { S.wl = { c: PRESETS[k][0], w: PRESETS[k][1] }; syncWL(); invalidateImages(); renderAll(); } });
    $('wlLevel').oninput = (e) => { S.wl.c = +e.target.value; syncWL(); invalidateImages(); renderAll(); }; $('wlWindow').oninput = (e) => { S.wl.w = +e.target.value; syncWL(); invalidateImages(); renderAll(); };
    // transfer tab controls
    $('smooth').oninput = (e) => { S.p.smoothMm = +e.target.value; onChanged(); };
    $('chkAnnAuto').onchange = (e) => { S.p.annAuto = e.target.checked; onChanged(); };
    $('annLevel').oninput = (e) => { S.p.annS = +e.target.value; S.p.annAuto = false; $('chkAnnAuto').checked = false; onChanged(); };
    $('descLevel').oninput = (e) => { S.p.descS = +e.target.value; onChanged(); };
    $('btnDescDefault').onclick = () => { S.p.descS = null; onChanged(); };
    $('refMode').onchange = (e) => { S.p.refMode = e.target.value; HK.forEach((k) => { if (S.m.A[k]) S.m.A[k].manual = false; }); onChanged(); };
    $('radMode').onchange = (e) => { S.p.radMode = e.target.value; onChanged(); }; $('fixedR').oninput = (e) => { S.p.fixedR = +e.target.value || 12; onChanged(); };
    $('cprAngle').oninput = (e) => { S.p.cprAngle = +e.target.value; cprCache = null; renderAll(); };
    // carm controls
    $('minMargin').onchange = (e) => { S.p.minMargin = Math.max(0, +e.target.value || 0); rescan(); renderAll(); };
    $('pracFrac').onchange = (e) => { S.p.pracFrac = Math.min(1, Math.max(0.1, (+e.target.value || 70) / 100)); rerank(); renderAll(); };
    $('sideSel').onchange = (e) => { S.p.side = e.target.value; S.selManual = false; rerank(); renderAll(); };
    $('chkStable').onchange = (e) => { S.p.stableOnly = e.target.checked; S.selManual = false; rerank(); renderAll(); };
    const hm = $('cvHeat'), hpos = (e) => { const r = hm.getBoundingClientRect(); return { x: (e.clientX - r.left) * hm.width / r.width, y: (e.clientY - r.top) * hm.height / r.height }; };
    hm.addEventListener('mousemove', (e) => { if (!S.scan) return; const p = hpos(e), a = V.heatmapAngleAt(S.scan, p.x, p.y); $('heatHover').textContent = a ? `${M.labelAngles(a.lao, a.cran)} · ${S.scan.valid[a.k] ? 'margin ' + f1(S.scan.margin[a.k]) + ' mm, gap ' + f1(S.scan.gap[a.k]) + ' mm' + (S.scan.pairSide[a.k] < 0 ? ' (2L:1R)' : ' (1L:2R)') : S.scan.is21[a.k] ? '2:1 but margin < min' : 'not 2:1'}` : ''; });
    hm.addEventListener('click', (e) => { if (!S.scan) return; const p = hpos(e), a = V.heatmapAngleAt(S.scan, p.x, p.y); if (a) selectProjection(a.lao, a.cran); });
    $('rankTables').addEventListener('click', (e) => { const tr = e.target.closest('tr[data-lao]'); if (tr) selectProjection(+tr.dataset.lao, +tr.dataset.cran); });
    $('selLao').onchange = () => selectProjection(+$('selLao').value, +$('selCran').value); $('selCran').onchange = () => selectProjection(+$('selLao').value, +$('selCran').value);
    $('btnPrint').onclick = () => { buildSummary(); window.print(); };
    ['sumId', 'sumAge', 'sumNote'].forEach((id) => $(id).addEventListener('input', () => { if (S.tab === 'summary') buildSummary(); }));
    syncWL(); syncControls(); renderToolList(); renderNow();
  }
  window.NavApp = { GROUPS, CL_COLOR, Q, mprFrame, applyOrient, resetOrient, alignToCentreline, crossGeom, sliceGeom, S, M, update, onChanged, loadPhantom, demoMarkers, setTab, selectProjection, handleFiles, allMarkers, placeMarker, views, buildSummary, rescan, rerank, selEval, fitViews, renderNow, setVolume };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
