/* NavNadir: semi-automatic detection of the three aortic-valve cusp nadirs in a contrast CT (EXPERIMENTAL, heuristic; always verify).
 * Pipeline (all on a local 0.8 mm grid around a user seed in the contrast-filled aortic root, nothing leaves the browser):
 *  1. adaptive threshold from the HU around the seed (soft tissue ~40 HU .. lumen HU), region grow inside a 40 mm sphere, 2-voxel opening to cut coronaries / thin leaks
 *  2. root axis a (LV -> aorta): centreline tangent if supplied, else PCA of the lumen near the seed; refined by the centroid line of the sinus cross-sections
 *  3. cross-sectional area profile A(h) along a: sinus level = interior area maximum (bulge of the sinuses of Valsalva); annulus level = where the area falls to a minimum / the lumen ends
 *  4. pocket depth D(theta) = lowest lumen height in each angular bin (outside the central tube) between annulus and sinus level;
 *     the three nadirs = best triple of deep pockets spaced ~120 degrees apart; position = wall point at the lowest height of each pocket
 *  5. labels from handedness + anatomy: seen from the aorta looking toward the LV, RCC -> LCC -> NCC runs counter-clockwise (right-handed about a);
 *     of the 3 cyclic assignments the one best matching the typical LPS directions (RCC anterior-right, LCC left, NCC posterior-right) is chosen.
 * Not validated on real CT. Failure returns {ok:false, message} instead of throwing. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NavNadir = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-12 ? mul(a, 1 / l) : [0, 0, 0]; };
  const fail = (code, message, extra) => Object.assign({ ok: false, code, message }, extra || {});
  const ORDER = ['RCC', 'LCC', 'NCC'];                                  // counter-clockwise looking from the aorta toward the LV (= right-handed about the flow axis)
  const PRIOR = { RCC: [-0.30, -0.95, 0], LCC: [0.85, 0.05, 0], NCC: [-0.60, 0.80, 0] };   // typical in-plane directions, LPS (x + left, y + posterior)

  function basis(a) { const e1 = norm(cross([0, 0, 1], a)), f = Math.hypot(...e1) < 0.2 ? norm(cross([1, 0, 0], a)) : e1, e2 = cross(a, f); return [f, e2]; }
  function smooth1(arr, sigma) {
    const r = Math.ceil(sigma * 3), w = [], out = new Float64Array(arr.length); let ws = 0;
    for (let i = -r; i <= r; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); w.push(v); ws += v; }
    for (let i = 0; i < arr.length; i++) { let s = 0, wt = 0; for (let k = -r; k <= r; k++) { const j = i + k; if (j < 0 || j >= arr.length) continue; s += arr[j] * w[k + r]; wt += w[k + r]; } out[i] = s / wt; }
    return out;
  }

  /* vol: NavVolume (sample(P) -> HU or NaN); seed: patient LPS mm; opts: { axisHint (unit LV->aorta, optional), res, half, radius } */
  function detect(vol, seed, opts) {
    opts = opts || {};
    const t0 = Date.now(), g = opts.res || 0.8, half = opts.half || 48, R = opts.radius || 40, n = 2 * Math.round(half / g) + 1, c0 = (n - 1) / 2, N = n * n * n;
    if (!vol || !seed) return fail('no-input', 'Load a CT and set a seed point in the aortic root first.');
    // ---- 1. resample + 3x3x3 box blur ----
    const raw = new Float32Array(N); let p = 0;
    for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++, p++) { const h = vol.sample([seed[0] + (i - c0) * g, seed[1] + (j - c0) * g, seed[2] + (k - c0) * g]); raw[p] = h === h ? h : -1000; }
    const H = new Float32Array(N), tmp = new Float32Array(N), tmp2 = new Float32Array(N), sx = 1, sy = n, sz = n * n;
    const box = (src, dst, st) => { for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const q = i + j * sy + k * sz, c = [i, j, k][st === 1 ? 0 : st === sy ? 1 : 2]; dst[q] = (c > 0 && c < n - 1) ? (src[q - st] + src[q] + src[q + st]) / 3 : src[q]; } };
    if (opts.blur) { box(raw, tmp, sx); box(tmp, tmp2, sy); box(tmp2, H, sz); } else H.set(raw);   // no blur by default: blurring fills thin pocket wedges and biases the nadir upward
    // ---- 2. seed HU, threshold ----
    const rr = (x, y, z) => Math.hypot(x - c0, y - c0, z - c0) * g;
    const near = (rad) => { const out = [], m = Math.ceil(rad / g); for (let dz = -m; dz <= m; dz++) for (let dy = -m; dy <= m; dy++) for (let dx = -m; dx <= m; dx++) if (Math.hypot(dx, dy, dz) * g <= rad) out.push(dx + dy * sy + dz * sz); return out; };
    const ctr = Math.round(c0), seedIdx = ctr + ctr * sy + ctr * sz;
    const ball3 = near(3), med = (idxs, base) => { const v = idxs.map((o) => H[base + o]).sort((a, b) => a - b); return v[v.length >> 1]; };
    let sIdx = seedIdx, mu = med(ball3, sIdx);
    if (mu < 150) {                                                               // snap to the brightest nearby blob (user click may be a few mm off)
      let best = -1e9, bi = -1; const m = Math.ceil(7 / g);
      for (let dz = -m; dz <= m; dz++) for (let dy = -m; dy <= m; dy++) for (let dx = -m; dx <= m; dx++) if (Math.hypot(dx, dy, dz) * g <= 7) { const q = seedIdx + dx + dy * sy + dz * sz, v = med(ball3, q); if (v > best) { best = v; bi = q; } }
      if (best < 150) return fail('seed-not-in-lumen', `The seed is not in contrast-filled blood (median HU around the seed ${Math.round(mu)}, brightest nearby ${Math.round(best)}). Click inside the opacified aortic root (centre of the sinuses of Valsalva), or use the crosshair after scrolling there.`, { seedHU: mu });
      sIdx = bi; mu = best;
    }
    if (mu > 900) return fail('seed-in-calcium', `The seed sits in a very bright structure (${Math.round(mu)} HU, calcification or stent?). Move it into the contrast-filled lumen.`);
    const T = Math.min(450, Math.max(130, 40 + 0.5 * (mu - 40)));
    // ---- region grow inside the sphere ----
    const inSphere = new Uint8Array(N); let nSphere = 0;
    for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) if (rr(i, j, k) <= R) { inSphere[i + j * sy + k * sz] = 1; nSphere++; }
    const mask = new Uint8Array(N); for (let q = 0; q < N; q++) mask[q] = inSphere[q] && H[q] > T ? 1 : 0;
    const nb6 = [1, -1, sy, -sy, sz, -sz];
    const grow = (m, startIdx) => {                                               // connected component of startIdx in mask m
      const lab = new Uint8Array(N), queue = new Int32Array(N); let qh = 0, qt = 0; if (!m[startIdx]) return { lab, count: 0 };
      lab[startIdx] = 1; queue[qt++] = startIdx;
      while (qh < qt) { const q = queue[qh++]; for (let d = 0; d < 6; d++) { const r = q + nb6[d]; if (r >= 0 && r < N && m[r] && !lab[r]) { lab[r] = 1; queue[qt++] = r; } } }
      return { lab, count: qt };
    };
    const first = grow(mask, sIdx);
    if (first.count < 8000) return fail('lumen-small', `Only a small bright region (${Math.round(first.count * g * g * g / 1000 * 10) / 10} ml) was found around the seed - it does not look like the opacified aortic root (threshold ${Math.round(T)} HU). Check the seed and the contrast phase.`);
    if (first.count > 0.55 * nSphere) return fail('lumen-leak', 'The bright region fills most of the search sphere (threshold leak, e.g. non-selective contrast or a very bright mediastinum). Auto-detection cannot separate the root here.');
    // opening: erode twice (6-neighbourhood), keep the seed component, dilate back inside the lumen -> removes coronaries / thin bridges
    let cur = first.lab;
    const erode = (m) => { const o = new Uint8Array(N); for (let q = 0; q < N; q++) if (m[q]) { let ok = 1; for (let d = 0; d < 6; d++) { const r = q + nb6[d]; if (r < 0 || r >= N || !m[r]) { ok = 0; break; } } o[q] = ok; } return o; };
    const dilate = (m, within) => { const o = new Uint8Array(m); for (let q = 0; q < N; q++) if (m[q]) for (let d = 0; d < 6; d++) { const r = q + nb6[d]; if (r >= 0 && r < N && within[r]) o[r] = 1; } return o; };
    let e = erode(erode(cur)), es = sIdx;
    if (!e[es]) { let bd = 1e9; const m = Math.ceil(6 / g); for (let dz = -m; dz <= m; dz++) for (let dy = -m; dy <= m; dy++) for (let dx = -m; dx <= m; dx++) { const q = sIdx + dx + dy * sy + dz * sz, d = Math.hypot(dx, dy, dz); if (e[q] && d < bd) { bd = d; es = q; } } }
    if (!e[es]) return fail('lumen-thin', 'The bright region around the seed is too thin to be an aortic root.');
    const core = grow(e, es).lab; let lum = core; for (let it = 0; it < 6; it++) lum = dilate(lum, first.lab);     // geodesic re-growth (4.8 mm): restores thin pocket wedges, coronaries stay short stubs
    // collect lumen cells (position relative to seed cell, mm)
    // distance transform (chamfer, 26-neighbourhood, mm): the ridge of maximal inscribed balls is a robust root centre line (slab centroids are biased by oblique cuts and the iteration diverges)
    const DT = new Float32Array(N);
    { for (let q = 0; q < N; q++) DT[q] = lum[q] ? 1e9 : 0;
      const offs = [], wts = []; for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dz < 0 || (dz === 0 && (dy < 0 || (dy === 0 && dx < 0)))) { offs.push(dx + dy * sy + dz * sz); wts.push(g * Math.hypot(dx, dy, dz)); }
      const lo = sz + sy + 1, hi = N - lo;
      for (let q = lo; q < hi; q++) if (lum[q]) { let d = DT[q]; for (let t = 0; t < 13; t++) { const v = DT[q + offs[t]] + wts[t]; if (v < d) d = v; } DT[q] = d; }
      for (let q = hi - 1; q >= lo; q--) if (lum[q]) { let d = DT[q]; for (let t = 0; t < 13; t++) { const v = DT[q - offs[t]] + wts[t]; if (v < d) d = v; } DT[q] = d; } }
    const cells = []; for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) { const q = i + j * sy + k * sz; if (lum[q]) cells.push([(i - c0) * g, (j - c0) * g, (k - c0) * g, DT[q]]); }
    const NC = cells.length;
    // ---- 3. axis candidates: supplied hint, else PCA of the lumen; fall-backs (vertical, cone-tilted) are tried if the first fails ----
    let pca;
    { let m = [0, 0, 0]; for (const c of cells) m = add(m, c); m = mul(m, 1 / cells.length);
      const C = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; for (const c of cells) { const d = sub(c, m); for (let r = 0; r < 3; r++) for (let s2 = 0; s2 < 3; s2++) C[r][s2] += d[r] * d[s2]; }
      let v = [0.3, 0.3, 0.9]; for (let it = 0; it < 60; it++) v = norm([dot(C[0], v), dot(C[1], v), dot(C[2], v)]);
      pca = v[2] < 0 ? mul(v, -1) : v; }
    const cands = [];
    if (opts.axisHint && Math.hypot(...opts.axisHint) > 0.5) cands.push(norm(opts.axisHint)); else cands.push(pca);
    if (!(opts.axisHint && Math.hypot(...opts.axisHint) > 0.5)) {
      cands.push([0, 0, 1]);
      for (const [b0, angs] of [[[0, 0, 1], [15, 30, 45]], [pca, [20]]]) { const [f1_, f2_] = basis(b0);
        for (const ang of angs) { const cnt = Math.max(6, Math.round(2 * Math.PI * Math.sin(ang * Math.PI / 180) / (15 * Math.PI / 180)));
          for (let k = 0; k < cnt; k++) { const t = k * 2 * Math.PI / cnt, d = add(mul(f1_, Math.cos(t)), mul(f2_, Math.sin(t))); cands.push(norm(add(mul(b0, Math.cos(ang * Math.PI / 180)), mul(d, Math.sin(ang * Math.PI / 180))))); } } }
          }
    const BINS = 81;     // h = -40..40
    function profile(ax) {
      const cnt = new Float64Array(BINS), sum = Array.from({ length: BINS }, () => [0, 0, 0]);
      for (const c of cells) { const h = dot(c, ax), b = Math.round(h) + 40; if (b < 0 || b >= BINS) continue; cnt[b]++; sum[b][0] += c[0]; sum[b][1] += c[1]; sum[b][2] += c[2]; }
      const area = Float64Array.from(cnt, (v) => v * g * g * g);                  // cells per 1 mm slab * g^3 = mm^2
      return { cnt, area, As: smooth1(area, 1.5), cen: sum.map((s, b) => (cnt[b] ? mul(s, 1 / cnt[b]) : null)) };
    }
    function findLevels(P, near) {
      const A = P.As; let best = null;
      for (let b = 8; b < BINS - 8; b++) {
        if (!(A[b] >= A[b - 1] && A[b] > A[b + 1])) continue;
        let lm = 1e18, rm = 1e18; for (let k = Math.max(0, b - 15); k <= b; k++) lm = Math.min(lm, A[k]); for (let k = b; k <= Math.min(BINS - 1, b + 15); k++) rm = Math.min(rm, A[k]);
        const prom = A[b] - Math.max(lm, rm);
        if (A[b] > 300 && prom >= 0.06 * A[b] && Math.abs(b - 40) <= 28 && (!near || Math.abs(b - near) <= 5) && (!best || prom > best.prom)) best = { b, prom };
      }
      if (!best) return null;
      let bs = best.b, ba = bs; while (ba > 1 && A[ba - 1] < A[ba] && A[ba - 1] > 0.08 * A[bs]) ba--;
      if (ba > 1 && A[ba - 1] <= 0.08 * A[bs]) ba--;                               // lumen ends (closed leaflets): annulus level = last bin with lumen
      return { bs, ba, Asin: A[bs], prom: best.prom };
    }
    function analyse(a0) {
    let a = a0;
    let P = profile(a), lv = findLevels(P);
    if (!lv) return fail('no-sinuses', 'No bulge of the sinuses of Valsalva was found along the axis near the seed (area profile has no interior maximum). Put the seed in the middle of the sinuses (not in the ascending aorta or LV) and make sure the root is opacified.', { axis: a });
    // axis = line through the maximal-inscribed-ball centres of the slabs around the sinuses (re-slab along the new axis, a few iterations)
    function ridge(ax, lvl) {            // slab centres of the sinus-to-STJ part (centroid of the cells within 12 mm of the DT ridge point: robust to boundary noise, not to oblique bowls)
      const sum = Array.from({ length: BINS }, () => [0, 0, 0]), cnt = new Float64Array(BINS);
      for (const c of cells) { const b = Math.round(dot(c, ax)) + 40; if (b < 0 || b >= BINS) continue; cnt[b]++; sum[b][0] += c[0]; sum[b][1] += c[1]; sum[b][2] += c[2]; }
      const pts = []; for (let b = Math.max(0, lvl.bs - 1); b <= Math.min(BINS - 1, lvl.bs + 7); b++) if (cnt[b] > 150) pts.push([b - 40, mul(sum[b], 1 / cnt[b])]);
      return pts;
    }
    function fitAxis(pts) {
      const hm = pts.reduce((u, q) => u + q[0], 0) / pts.length, cm = pts.reduce((u, q) => add(u, q[1]), [0, 0, 0]).map((v) => v / pts.length);
      let sxx = 0, sxc = [0, 0, 0]; for (const [h, c] of pts) { sxx += (h - hm) * (h - hm); sxc = add(sxc, mul(sub(c, cm), h - hm)); }
      return sxx > 1e-9 ? norm(sxc) : null;
    }
    for (let it = 0; it < 6; it++) {
      const pts = ridge(a, lv); if (opts.debug) console.log('ridge', pts.map(([h, c]) => h + ':' + c.map((v) => v.toFixed(1)).join('/')).join(' ')); if (pts.length < 6) break;
      let a2 = fitAxis(pts); if (!a2 || dot(a2, a) < 0.9) break; if (dot(a2, a) < 0) a2 = mul(a2, -1);
      const conv = dot(a2, a) > 0.99996; a = a2; P = profile(a); lv = findLevels(P, lv.bs) || lv;
      if (opts.debug) console.log('axis it', it, 'levels', lv.ba - 40, lv.bs - 40, 'axis', a.map((v) => v.toFixed(3)).join(','));
      if (conv) break;
    }
    const hs = lv.bs - 40, ha = lv.ba - 40, Asin = lv.Asin, Aann = P.As[lv.ba];
    const cpts = ridge(a, lv); if (cpts.length < 4) return fail('axis-fit', 'Could not fit the root axis (too few lumen slices around the sinuses).');
    let L0 = [0, 0, 0]; for (const [h, c] of cpts) L0 = add(L0, sub(c, mul(a, dot(c, a)))); L0 = mul(L0, 1 / cpts.length);   // axis point (perpendicular to a, relative to the seed)
    const [e1, e2] = basis(a);
    const rsin = Math.sqrt(Asin / Math.PI), rann = Math.sqrt(Math.max(Aann, 0) / Math.PI), closed = Aann < 0.2 * Asin;
    const rcut = closed ? Math.max(1, 0.55 * rsin) : rann + 0.7, hlo = closed ? ha - 3 : ha, hhi = hs + 2;
    // ---- 4. angular pocket depth ----
    const NB = 72, depth = new Float64Array(NB).fill(Infinity), sel = [];
    for (const c of cells) {
      const h = dot(c, a); if (h < hlo || h > hhi) continue;
      const q = sub(sub(c, mul(a, h)), L0), rho = Math.hypot(...q); if (rho < rcut) continue;
      const th = Math.atan2(dot(q, e2), dot(q, e1)), bi = ((Math.floor(th / (2 * Math.PI) * NB) % NB) + NB) % NB;
      if (h < depth[bi]) depth[bi] = h; sel.push([h, th, rho, c]);
    }
    for (let b = 0; b < NB; b++) if (!isFinite(depth[b])) depth[b] = hhi + 4;
    let D = Float64Array.from(depth); for (let pass = 0; pass < 2; pass++) { const o = new Float64Array(NB); for (let b = 0; b < NB; b++) o[b] = 0.25 * D[(b + NB - 1) % NB] + 0.5 * D[b] + 0.25 * D[(b + 1) % NB]; D = o; }
    let bestT = null;
    for (let b1 = 0; b1 < NB; b1++) for (let g1 = 12; g1 <= 36; g1++) for (let g2 = 12; g2 <= 36; g2++) {
      const g3 = NB - g1 - g2; if (g3 < 12 || g3 > 36) continue;
      const b2 = (b1 + g1) % NB, b3 = (b2 + g2) % NB, dev = ((g1 - 24) ** 2 + (g2 - 24) ** 2 + (g3 - 24) ** 2) * 25 / 24 * 0.002;   // degrees^2 -> mm
      const sc = D[b1] + D[b2] + D[b3] + dev * 3;
      if (!bestT || sc < bestT.sc) bestT = { sc, b: [b1, b2, b3], gaps: [g1, g2, g3] };
    }
    if (!bestT) return fail('no-pockets', 'Could not identify three sinus pockets.');
    // refine each nadir: lowest cells within +-20 degrees of the pocket centre
    const pk = [];
    for (let i = 0; i < 3; i++) {
      const thc = (bestT.b[i] + 0.5) / NB * 2 * Math.PI, S = sel.filter((s) => Math.abs(Math.atan2(Math.sin(s[1] - thc), Math.cos(s[1] - thc))) < 20 * Math.PI / 180);
      if (S.length < 5) return fail('no-pockets', 'A sinus pocket had too few lumen voxels.');
      const hmin = Math.min(...S.map((s) => s[0])), W = S.map((s) => Math.exp(-(s[0] - hmin) / 0.7)); let ws = 0, hh = 0, cx = 0, cy = 0;
      S.forEach((s, k) => { ws += W[k]; hh += W[k] * s[0]; cx += W[k] * Math.cos(s[1]); cy += W[k] * Math.sin(s[1]); });
      const rs = S.filter((s) => s[0] <= hmin + 1.0).map((s) => s[2]).sort((x, y) => x - y), r90 = rs[Math.min(rs.length - 1, Math.floor(rs.length * 0.9))];
      const th = Math.atan2(cy, cx), h = hh / ws;
      pk.push({ th, h, r: r90, hmin, hRaw: h, pos: add(seed, add(add(L0, mul(a, h)), mul(add(mul(e1, Math.cos(th)), mul(e2, Math.sin(th))), r90))) });
    }
    // ---- sub-voxel correction: the lowest *visible* lumen sits where the wedge between leaflet and wall is ~1.5-2 mm wide; the hinge (nadir) is where the wedge closes.
    // Partial-volume width w(h) = integral of (HU - soft)/(lumen - soft) across the wedge, extrapolated linearly to w = 0 (clipped to <= 4 mm below the lowest visible cell).
    {
      let softs = []; for (let q = 0; q < N; q += 7) if (inSphere[q] && !lum[q] && H[q] > -150 && H[q] < 120) softs.push(H[q]); softs.sort((x, y) => x - y); const soft = softs.length ? softs[softs.length >> 1] : 40;
      const SL = 0.8, NS = 20, acc = pk.map(() => new Float64Array(NS)), hb = pk.map((q) => q.hmin - 2);
      for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const q0 = [(i - c0) * g, (j - c0) * g, (k - c0) * g], h = dot(q0, a); if (h < hlo - 2 || h > hhi + 4) continue;
        const q = sub(sub(q0, mul(a, h)), L0), rho = Math.hypot(...q); if (rho < rcut) continue;
        const th = Math.atan2(dot(q, e2), dot(q, e1));
        for (let m = 0; m < 3; m++) {
          if (Math.abs(Math.atan2(Math.sin(th - pk[m].th), Math.cos(th - pk[m].th))) > 15 * Math.PI / 180 || rho > pk[m].r + 1.5) continue;
          const sj = Math.floor((h - hb[m]) / SL); if (sj < 0 || sj >= NS) continue;
          const fr = (H[i + j * sy + k * sz] - soft) / (mu - soft); acc[m][sj] += fr < 0 ? 0 : fr > 1 ? 1 : fr;
        }
      }
      pk.forEach((q, m) => {
        const arc = q.r * 30 * Math.PI / 180, wmax = Math.min(3.0, 0.7 * (q.r - rcut)), xs = [], ys = [];
        for (let sj = 0; sj < NS; sj++) { const w = acc[m][sj] * g * g * g / (SL * arc); if (w >= 0.7 && w <= wmax) { xs.push(hb[m] + (sj + 0.5) * SL); ys.push(w); } }
        if (opts.debug) console.log('pocket',m,'hmin',q.hmin.toFixed(2),'r',q.r.toFixed(1),'wmax',wmax.toFixed(1),'w:',Array.from(acc[m]).map((v)=>(v*g*g*g/(SL*arc)).toFixed(1)).join(' '));
        if (xs.length < 3) return;
        const mx = xs.reduce((u, v) => u + v, 0) / xs.length, my = ys.reduce((u, v) => u + v, 0) / ys.length; let sxy = 0, sxx = 0; for (let t = 0; t < xs.length; t++) { sxy += (xs[t] - mx) * (ys[t] - my); sxx += (xs[t] - mx) ** 2; }
        if (sxx < 1e-6 || sxy <= 0) return; const slope = sxy / sxx, h0 = mx - my / slope, down = q.hmin - h0;
        if (down > 0 && down <= 2.5 && q.h - down > hlo - 4) { q.h -= down; q.corr = down; q.pos = sub(q.pos, mul(a, down)); }
      });
    }
    // relief: commissural directions are shallower than the pockets
    const dN = pk.map((q) => q.hmin); let dc = [];
    for (let b = 0; b < NB; b++) { const d = Math.min(...pk.map((q) => { const t = (b + 0.5) / NB * 2 * Math.PI; return Math.abs(Math.atan2(Math.sin(t - q.th), Math.cos(t - q.th))); })); if (d > 50 * Math.PI / 180) dc.push(D[b]); }
    dc.sort((x, y) => x - y); const relief = (dc.length ? dc[dc.length >> 1] : hhi) - dN.reduce((s, v) => s + v, 0) / 3;
    if (relief < 1.5) return fail('flat', `The sinus floor is flat (pocket relief ${relief.toFixed(1)} mm) - no distinct sinus pockets were found. Is the seed in the aortic root and the root opacified well enough (no motion/blur)?`, { relief, axis: a });
    // ---- trefoil check: at sinus level the lumen must be three-lobed (lobes at the pockets, shallower at the commissures); a round tube / LV is rejected ----
    const rb = Array.from({ length: NB }, () => []);
    for (const c of cells) { const h = dot(c, a); if (h < hs - 3 || h > hs + 3) continue; const q = sub(sub(c, mul(a, h)), L0), th = Math.atan2(dot(q, e2), dot(q, e1)), bi = ((Math.floor(th / (2 * Math.PI) * NB) % NB) + NB) % NB; rb[bi].push(Math.hypot(...q)); }
    const Rb = rb.map((v) => { if (v.length < 4) return NaN; v.sort((x, y) => x - y); return v[Math.floor(v.length * 0.9)]; });
    const angDiff = (t1, t2) => Math.abs(Math.atan2(Math.sin(t1 - t2), Math.cos(t1 - t2)));
    const ext = (th0, wdeg, fn) => { const vals = []; for (let b = 0; b < NB; b++) { const t = (b + 0.5) / NB * 2 * Math.PI; if (angDiff(t, th0) <= wdeg * Math.PI / 180 && Rb[b] === Rb[b]) vals.push(Rb[b]); } return vals.length ? fn(...vals) : NaN; };
    const lobeR = pk.map((q) => ext(q.th, 15, Math.max)), thSorted = pk.map((q) => q.th).sort((x, y) => x - y);
    const commR = [0, 1, 2].map((i) => { const t1 = thSorted[i], t2 = thSorted[(i + 1) % 3] + (i === 2 ? 2 * Math.PI : 0); return ext((t1 + t2) / 2, 15, Math.min); });
    const lobeContrast = lobeR.reduce((x, y) => x + y, 0) / 3 - commR.reduce((x, y) => x + y, 0) / 3;
    const meanLobe = lobeR.reduce((x, y) => x + y, 0) / 3;
    if (!(lobeContrast >= Math.max(2.5, 0.15 * meanLobe))) return fail('not-trefoil', `The cross-section at the sinus level is not three-lobed (lobe-to-commissure radius difference ${isFinite(lobeContrast) ? lobeContrast.toFixed(1) : 'n/a'} mm, need ≥ ${Math.max(2.5, 0.15 * meanLobe).toFixed(1)} mm). The seed may be in the ascending aorta / LV / another chamber, or the root is not opacified well enough.`, { lobeContrast, axis: a });
    // ---- 5. labels ----
    const sorted = pk.slice().sort((x, y) => ((x.th % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - ((y.th % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));   // increasing theta = counter-clockwise from the aorta (right-handed about a)
    const proj = (v) => { const d = dot(v, a); return norm(sub(v, mul(a, d))); };
    const priors = {}; for (const k of ORDER) priors[k] = proj(PRIOR[k]);
    const scores = [0, 1, 2].map((r) => { let s = 0; for (let j = 0; j < 3; j++) { const q = sorted[j], dir = norm(sub(sub(q.pos, seed), add(L0, mul(a, dot(sub(q.pos, seed), a))))); s += dot(dir, priors[ORDER[(j + r) % 3]]); } return s; });
    let br = 0; for (let r = 1; r < 3; r++) if (scores[r] > scores[br]) br = r;
    const second = Math.max(...scores.filter((_, r) => r !== br)), margin = (scores[br] - second) / 3;
    const nadirs = {}, th = {}; for (let j = 0; j < 3; j++) { const lab = ORDER[(j + br) % 3]; nadirs[lab] = sorted[j].pos; th[lab] = sorted[j]; }
    // ---- 6. commissures H_NL / H_NR / H_LR: angular midpoint between adjacent nadir directions; height = apex of the cusp attachment (lowest lumen where the sinus floor meets the wall between two sinuses),
    //         radius = lumen wall at that angle/height (sub-voxel, from ray marching through the resampled HU) ----
    const wrapA = (x) => Math.atan2(Math.sin(x), Math.cos(x)), D2R = Math.PI / 180;
    const nadirH = pk.reduce((u, q) => u + q.h, 0) / 3;
    const comm = (() => {
      const softs = []; for (let q = 0; q < N; q += 7) if (inSphere[q] && !lum[q] && H[q] > -150 && H[q] < 120) softs.push(H[q]); softs.sort((x, y) => x - y);
      const soft = softs.length ? softs[softs.length >> 1] : 40, midHU = 0.5 * (mu + soft);
      const hAt = (x, y, z) => { const fx = x / g + c0, fy = y / g + c0, fz = z / g + c0, i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz); if (i < 0 || j < 0 || k < 0 || i >= n - 1 || j >= n - 1 || k >= n - 1) return NaN;
        const tx = fx - i, ty = fy - j, tz = fz - k, b = i + j * sy + k * sz; let v = 0;
        for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) v += H[b + dx + dy * sy + dz * sz] * (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty) * (dz ? tz : 1 - tz); return v; };
      const polar = cells.map((c) => { const h = dot(c, a), q = sub(sub(c, mul(a, h)), L0); return [h, Math.atan2(dot(q, e2), dot(q, e1)), Math.hypot(...q)]; }).filter((u) => u[2] >= rcut);
      const out = { pos: {}, ang: {}, height: {}, radius: {}, crown: {}, notchDev: {}, found: {}, flags: [] };
      const pairs = [['NL', 'NCC', 'LCC', 'RCC'], ['NR', 'NCC', 'RCC', 'LCC'], ['LR', 'LCC', 'RCC', 'NCC']];
      const med = (v) => { v = v.slice().sort((x, y) => x - y); return v[v.length >> 1]; };
      for (const [nm, X, Y, Z] of pairs) {
        const d = wrapA(th[Y].th - th[X].th), tm = th[X].th + d / 2; out.ang[nm] = tm;
        const thirdIn = Math.abs(wrapA(th[Z].th - tm)) < Math.abs(d) / 2; if (thirdIn) out.flags.push('arc ' + nm);
        const W = polar.filter((u) => Math.abs(wrapA(u[1] - tm)) < 5 * D2R && u[0] > hs - 3 && u[0] < hs + 24);
        let hc = NaN, rmaxW = NaN;
        if (W.length >= 12) {
          const rs = W.map((u) => u[2]).sort((x, y) => x - y); rmaxW = rs[Math.floor(rs.length * 0.9)];
          // crown profile: lowest wall-side lumen cell per 3-degree bin; the apex is the top of this (sharp) crown, taken as the highest 3-bin running mean within +-12 degrees of the midpoint
          const fl = []; for (let b = -4; b <= 4; b++) { const lo = (b - 0.5) * 3 * D2R, hi = (b + 0.5) * 3 * D2R, S = W.filter((u) => u[2] >= rmaxW - 2.0 && wrapA(u[1] - tm) >= lo && wrapA(u[1] - tm) < hi); if (S.length >= 2) { const m0 = Math.min(...S.map((u) => u[0])); const low = S.filter((u) => u[0] <= m0 + 0.6); fl.push([b, low.reduce((x, y) => x + y[0], 0) / low.length]); } else fl.push([b, NaN]); }
          let bestV = -1e9, bestB = 0; for (let i = 1; i < fl.length - 1; i++) { const v = [fl[i - 1][1], fl[i][1], fl[i + 1][1]]; if (v.some((x) => x !== x)) continue; const m3 = (v[0] + v[1] + v[2]) / 3; if (m3 > bestV) { bestV = m3; bestB = fl[i][0]; } }
          if (bestV > -1e8) { hc = bestV; out.crownAngDev = out.crownAngDev || {}; out.crownAngDev[nm] = Math.abs(bestB) * 3; }
        }
        out.crown[nm] = hc; (out.rmaxW = out.rmaxW || {})[nm] = rmaxW;
      }
      const crowns = pairs.map(([nm]) => out.crown[nm]).filter((v) => v === v);
      const crownMed = crowns.length ? med(crowns) : NaN;
      let usedFallback = false;
      for (const [nm, X, Y] of pairs) {
        let hc = out.crown[nm]; const ok = hc === hc && hc - nadirH >= 6 && hc - nadirH <= 30 && Math.abs(hc - crownMed) <= 6;
        if (!ok) { hc = crownMed === crownMed && crownMed - nadirH >= 6 && crownMed - nadirH <= 30 ? crownMed : nadirH + 17; usedFallback = true; out.found[nm] = false; } else out.found[nm] = true;
        out.height[nm] = hc;
        // radial position: first mid-HU crossing going outward along rays at tm +-0..4 deg, slab hc+0.5..hc+1.5
        const rr_ = []; const tm = out.ang[nm];
        for (const dA of [-4, -2, 0, 2, 4]) for (const dh of [0.5, 1.0, 1.5]) {
          const t = tm + dA * D2R, dir = add(mul(e1, Math.cos(t)), mul(e2, Math.sin(t))), base = add(L0, mul(a, hc + dh));
          if (!(hAt(...add(base, mul(dir, Math.max(1, rcut)))) > midHU)) continue;
          let prev = Math.max(1, rcut), found = NaN; for (let r = prev + 0.2; r < 32; r += 0.2) { const v = hAt(...add(base, mul(dir, r))); if (v !== v) break; if (v < midHU) { const v0 = hAt(...add(base, mul(dir, prev))); found = prev + 0.2 * (v0 - midHU) / (v0 - v); break; } prev = r; }
          if (found === found) rr_.push(found);
        }
        let rad = rr_.length >= 4 ? med(rr_) : NaN; if (rad !== rad) { out.found[nm] = false; usedFallback = true; rad = out.rmaxW[nm] === out.rmaxW[nm] ? out.rmaxW[nm] : 0.9 * rsin; }
        out.radius[nm] = rad;
        const dir = add(mul(e1, Math.cos(tm)), mul(e2, Math.sin(tm)));
        out.pos[nm] = add(seed, add(add(L0, mul(a, hc)), mul(dir, rad)));
        // notch check: the minimum wall radius between the two lobes should sit near the midpoint angle
        const rows = polar.filter((u) => u[0] >= hc + 1 && u[0] <= hc + 4), byB = {};
        for (const u of rows) { const dd = wrapA(u[1] - tm) / D2R; if (Math.abs(dd) > 40) continue; const b = Math.round(dd / 4); (byB[b] = byB[b] || []).push(u[2]); }
        const prof = Object.keys(byB).map((b) => [+b * 4, med(byB[b].sort((x, y) => x - y).slice(Math.max(0, byB[b].length - 4)))]).filter((u) => byB[u[0] / 4].length >= 3);
        out.notchDev[nm] = NaN; if (prof.length >= 7) { let best = prof[0]; for (const u of prof) if (u[1] < best[1]) best = u; const edge = Math.max(prof[0][1], prof[prof.length - 1][1]); out.notchDev[nm] = Math.abs(best[0]); out.notchDepth = Math.max(out.notchDepth || 0, edge - best[1]); }
      }
      out.usedFallback = usedFallback;
      const hs3 = pairs.map(([nm]) => out.height[nm]), hmean = hs3.reduce((u, v) => u + v, 0) / 3, hsd = Math.sqrt(hs3.reduce((u, v) => u + (v - hmean) ** 2, 0) / 3);
      const nd = pairs.map(([nm]) => out.notchDev[nm]).filter((v) => v === v), ndMean = nd.length ? nd.reduce((u, v) => u + v, 0) / nd.length : NaN;
      const nFound = pairs.filter(([nm]) => out.found[nm]).length;
      out.heightSD = hsd; out.rise = hmean - nadirH; out.meanHeight = hmean; out.nFound = nFound; out.notchDevMean = ndMean;
      const cFound = nFound / 3, cHsd = Math.max(0, 1 - Math.max(0, hsd - 1.5) / 5), cRise = Math.max(0, Math.min(1, (out.rise - 3) / 6)), cNotch = ndMean === ndMean ? Math.max(0, 1 - Math.max(0, ndMean - 8) / 17) : 0.4;
      out.score = 0.35 * cFound + 0.2 * cHsd + 0.2 * cRise + 0.25 * cNotch;
      return out;
    })();
    // ---- confidence ----
    const gapDev = Math.max(...bestT.gaps.map((x) => Math.abs(x * 5 - 120)));
    const hStd = Math.sqrt(pk.reduce((s, q) => s + (q.h - pk.reduce((t, w) => t + w.h, 0) / 3) ** 2, 0) / 3);
    const cLobe = Math.min(1, lobeContrast / 4), cRelief = Math.min(1, relief / 6), cGap = Math.max(0, 1 - gapDev / 50), cPlan = Math.max(0, 1 - hStd / 4), cProm = Math.min(1, lv.prom / (0.2 * Asin)), cAssign = Math.min(1, margin / 0.45);
    let conf0 = Math.round(100 * (0.20 * cRelief + 0.20 * cLobe + 0.15 * cGap + 0.15 * cPlan + 0.10 * cProm + 0.20 * cAssign));
    let conf = Math.max(0, conf0 - Math.round(15 * (1 - comm.score)));
    if (gapDev > 35) return fail('irregular', `The three pockets found are not ~120° apart (${bestT.gaps.map((x) => x * 5).join('/')}°) - probably not the sinuses of Valsalva.`, { axis: a });
    if (hStd > 3.5) return fail('tilted', `The three pockets found are at very different heights (SD ${hStd.toFixed(1)} mm) - probably not the sinus floors.`, { axis: a });
    const warnings = [];
    if (!closed) warnings.push('Valve appears open / lumen continuous with the LVOT: nadirs may be placed up to a few mm too high (hinge hidden behind the leaflets).');
    if (margin < 0.2) warnings.push('Cusp naming is uncertain (root rotation unusual): check the labels, use "Rotate labels" if needed.');
    if (gapDev > 30) warnings.push('The three pockets are not ~120° apart (largest deviation ' + Math.round(gapDev) + '°).');
    if (hStd > 3) warnings.push('The three nadirs are at quite different heights (SD ' + hStd.toFixed(1) + ' mm) - nadir plane may be tilted or a pocket missed.');
    if (comm.nFound < 3) warnings.push('Commissures: ' + (3 - comm.nFound) + ' of 3 commissure heights could not be measured from the lumen (cusp attachment not visible) - a typical height above the nadir plane was used. Check H markers.');
    if (comm.heightSD > 3) warnings.push('Commissure apex heights differ by SD ' + comm.heightSD.toFixed(1) + ' mm - H markers uncertain.');
    if (comm.notchDevMean === comm.notchDevMean && comm.notchDevMean > 12) warnings.push('The inter-sinus notch is ' + Math.round(comm.notchDevMean) + '° from the midpoint between adjacent nadirs - commissure angles ambiguous, verify H markers.');
    if (comm.rise < 4) warnings.push('Commissures are only ' + comm.rise.toFixed(1) + ' mm above the nadir plane - atypically low; verify H markers.');
    const commissures = { NL: comm.pos.NL, NR: comm.pos.NR, LR: comm.pos.LR };
    const ns = ORDER.map((k) => nadirs[k]), cen = mul(add(add(ns[0], ns[1]), ns[2]), 1 / 3), diam = (Math.hypot(...sub(ns[0], ns[1])) + Math.hypot(...sub(ns[1], ns[2])) + Math.hypot(...sub(ns[2], ns[0]))) / 3 * 2 / Math.sqrt(3);
    return { ok: true, nadirs, commissures, commissureInfo: { angles: comm.ang, heights: comm.height, radii: comm.radius, found: comm.found, usedFallback: comm.usedFallback, heightSD: comm.heightSD, riseAboveNadirs: comm.rise, notchDeviationDeg: comm.notchDevMean, score: Math.round(100 * comm.score) }, nadirConfidence: conf0, confidence: conf, quality: conf >= 70 ? 'good' : conf >= 45 ? 'fair' : 'poor', warnings, axis: a, axisPoint: add(seed, L0), thresholdHU: Math.round(T), lumenHU: Math.round(mu),
      sinusLevel: hs, annulusLevel: ha, sinusAreaMm2: Math.round(Asin), closedValve: closed, relief, lobeContrast, gaps: bestT.gaps.map((x) => x * 5), heightSD: hStd, labelMargin: margin, labelScores: scores,
      nadirPlaneDiameterMm: diam, cells: NC, ms: Date.now() - t0, order: ORDER.slice() };
    }
    let bestRes = null, firstFail = null, tries = 0;
    for (const c of cands) {
      if (tries++ > 0 && opts.maxTries && tries > opts.maxTries) break;
      const r = analyse(c); r.tries = tries;
      if (r.ok) { if (!bestRes || r.confidence > bestRes.confidence) bestRes = r; if (r.confidence >= 75) break; } else if (!firstFail) firstFail = r;
    }
    return bestRes ? Object.assign(bestRes, { ms: Date.now() - t0 }) : firstFail;
  }

  /* cyclic relabelling (keeps the RCC -> LCC -> NCC handedness): positions move RCC <- NCC? -> returns new {NCC,LCC,RCC} where each label takes the position of the previous label in ORDER */
  function rotateLabels(nadir) { const o = {}; for (let j = 0; j < 3; j++) o[ORDER[j]] = nadir[ORDER[(j + 2) % 3]]; return o; }
  /* H labels follow a nadir relabel: each cusp label moves to the next one (see rotateLabels) and a commissure is named after the pair of cusps it lies between */
  const HPAIR = { NL: ['NCC', 'LCC'], NR: ['NCC', 'RCC'], LR: ['LCC', 'RCC'] };
  function rotateH(Hm) { const mv = {}; for (let j = 0; j < 3; j++) mv[ORDER[(j + 2) % 3]] = ORDER[j]; const o = {};
    for (const k of Object.keys(HPAIR)) { const [x, y] = HPAIR[k].map((c) => mv[c]), nk = Object.keys(HPAIR).find((q) => HPAIR[q].includes(x) && HPAIR[q].includes(y)); o[nk] = Hm[k]; } return o; }
  return { detect, rotateLabels, rotateH, ORDER, PRIOR, HPAIR };
});
