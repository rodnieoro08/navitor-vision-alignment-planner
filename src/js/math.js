/* NavMath: vector maths, centreline spline, rotation-minimising frame,
 * angular transfer and C-arm projection analysis.
 * UMD: works in browsers (window.NavMath) and node (require).
 * Patient coordinates: DICOM LPS (x -> patient LEFT, y -> POSTERIOR, z -> SUPERIOR), mm.
 * C-arm convention: LAO (+) / RAO (-);  CRAN (+) / CAUD (-).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NavMath = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = (a) => Math.sqrt(dot(a, a));
  const norm = (a) => { const l = len(a); return l > 1e-12 ? mul(a, 1 / l) : [0, 0, 0]; };
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const dist = (a, b) => len(sub(a, b));
  const wrap180 = (d) => { d = ((d + 180) % 360 + 360) % 360 - 180; return d; };

  /* ---------- centreline ---------- */
  // centripetal Catmull-Rom through control points, returns dense polyline
  function catmullRom(P, samplesPerSeg) {
    const n = P.length;
    if (n < 2) return P.slice();
    if (n === 2) {
      const out = [];
      for (let i = 0; i <= samplesPerSeg; i++) out.push(lerp(P[0], P[1], i / samplesPerSeg));
      return out;
    }
    const ext = [add(P[0], sub(P[0], P[1])), ...P, add(P[n - 1], sub(P[n - 1], P[n - 2]))];
    const out = [];
    for (let i = 1; i < ext.length - 2; i++) {
      const p0 = ext[i - 1], p1 = ext[i], p2 = ext[i + 1], p3 = ext[i + 2];
      const t0 = 0, t1 = t0 + Math.sqrt(Math.max(dist(p0, p1), 1e-6)), t2 = t1 + Math.sqrt(Math.max(dist(p1, p2), 1e-6)), t3 = t2 + Math.sqrt(Math.max(dist(p2, p3), 1e-6));
      for (let k = 0; k < samplesPerSeg; k++) {
        const t = t1 + (t2 - t1) * k / samplesPerSeg;
        const A1 = lerp(p0, p1, (t - t0) / (t1 - t0)), A2 = lerp(p1, p2, (t - t1) / (t2 - t1)), A3 = lerp(p2, p3, (t - t2) / (t3 - t2));
        const B1 = lerp(A1, A2, (t - t0) / (t2 - t0)), B2 = lerp(A2, A3, (t - t1) / (t3 - t1));
        out.push(lerp(B1, B2, (t - t1) / (t2 - t1)));
      }
    }
    out.push(P[n - 1].slice());
    return out;
  }
  function arcLengths(pts) {
    const s = [0];
    for (let i = 1; i < pts.length; i++) s.push(s[i - 1] + dist(pts[i], pts[i - 1]));
    return s;
  }
  // resample polyline at uniform arc-length step
  function resample(pts, step) {
    const s = arcLengths(pts), L = s[s.length - 1];
    const n = Math.max(2, Math.round(L / step) + 1);
    const out = [];
    let j = 0;
    for (let i = 0; i < n; i++) {
      const t = L * i / (n - 1);
      while (j < pts.length - 2 && s[j + 1] < t) j++;
      const seg = s[j + 1] - s[j];
      out.push(lerp(pts[j], pts[j + 1], seg > 1e-12 ? (t - s[j]) / seg : 0));
    }
    return out;
  }
  // Gaussian smoothing along the curve (sigma in mm), end points kept exactly.
  function gaussSmooth(pts, step, sigmaMm) {
    if (sigmaMm <= 0.01 || pts.length < 5) return pts.map((p) => p.slice());
    const sig = sigmaMm / step, half = Math.ceil(3 * sig);
    const w = []; for (let k = -half; k <= half; k++) w.push(Math.exp(-0.5 * (k / sig) * (k / sig)));
    const n = pts.length, out = [];
    for (let i = 0; i < n; i++) {
      // reflect-extrapolate about the end points (odd reflection preserves local direction)
      let acc = [0, 0, 0], ws = 0;
      for (let k = -half; k <= half; k++) {
        let j = i + k, p;
        if (j < 0) p = sub(mul(pts[0], 2), pts[Math.min(-j, n - 1)]);
        else if (j > n - 1) p = sub(mul(pts[n - 1], 2), pts[Math.max(2 * (n - 1) - j, 0)]);
        else p = pts[j];
        const ww = w[k + half];
        acc = add(acc, mul(p, ww)); ws += ww;
      }
      out.push(mul(acc, 1 / ws));
    }
    out[0] = pts[0].slice(); out[n - 1] = pts[n - 1].slice();
    return out;
  }
  function initialNormal(T) {
    // reference direction: patient anterior (-y), falling back to x
    let ref = [0, -1, 0];
    if (Math.abs(dot(ref, T)) > 0.9) ref = [1, 0, 0];
    return norm(sub(ref, mul(T, dot(ref, T))));
  }
  // Rotation-minimising frame by the double-reflection method (Wang et al. 2008)
  function rmf(pts, T, n1start) {
    const n = pts.length, N1 = new Array(n);
    N1[0] = n1start ? norm(sub(n1start, mul(T[0], dot(n1start, T[0])))) : initialNormal(T[0]);
    for (let i = 0; i < n - 1; i++) {
      const v1 = sub(pts[i + 1], pts[i]), c1 = dot(v1, v1);
      if (c1 < 1e-12) { N1[i + 1] = N1[i]; continue; }
      const rL = sub(N1[i], mul(v1, 2 / c1 * dot(v1, N1[i])));
      const tL = sub(T[i], mul(v1, 2 / c1 * dot(v1, T[i])));
      const v2 = sub(T[i + 1], tL), c2 = dot(v2, v2);
      let r = c2 < 1e-14 ? rL : sub(rL, mul(v2, 2 / c2 * dot(v2, rL)));
      r = norm(sub(r, mul(T[i + 1], dot(r, T[i + 1]))));
      N1[i + 1] = r;
    }
    return N1;
  }
  /* Build centreline object from control points. The maths is direction-agnostic; the app feeds it points ordered
   * LV APEX -> root -> arch -> DESCENDING AORTA (arc length s = 0 at the apex end). See orientCentreline().
   * opts: step (mm, default 0.5), smoothMm (Gaussian sigma, default 4) */
  function buildCentreline(ctrl, opts) {
    opts = opts || {};
    if (!ctrl || ctrl.length < 2) return null;
    const step = opts.step || 0.5, sigma = opts.smoothMm == null ? 4 : opts.smoothMm;
    let dense = catmullRom(ctrl, 24);
    dense = resample(dense, step);
    dense = gaussSmooth(dense, step, sigma);
    dense = resample(dense, step);
    const n = dense.length, T = [];
    for (let i = 0; i < n; i++) T.push(norm(sub(dense[Math.min(n - 1, i + 1)], dense[Math.max(0, i - 1)])));
    const N1 = rmf(dense, T, opts.n1start);
    const N2 = T.map((t, i) => cross(t, N1[i]));
    const s = arcLengths(dense);
    return { pts: dense, T, N1, N2, s, length: s[n - 1], step, ctrl: ctrl.map((p) => p.slice()) };
  }
  /* Order check for manually marked centreline points. The protocol order is: first point at the LV APEX, then root, arch,
   * last point in the DESCENDING aorta. Robust heuristic: the apex end lies much closer to the aortic root than the far end
   * in the descending aorta, so compare the distance of the first and last point to the centroid of the root markers
   * (rootPts = H markers, nadirs, seed - whichever exist). If the two distances differ by < minDiff mm (or there are no root
   * markers yet) fall back to height: the apex end is normally higher (z) than the descending end of a supine CT.
   * Returns {ok, basis:'root'|'z'|'none', dFirst, dLast}; ok === true when the first point is the apex end. */
  function centrelineOrder(ctrl, rootPts, minDiff) {
    if (!ctrl || ctrl.length < 2) return { ok: true, basis: 'none' };
    const a = ctrl[0], b = ctrl[ctrl.length - 1], rp = (rootPts || []).filter(Boolean), md = minDiff == null ? 10 : minDiff;
    if (rp.length) {
      const c = mul(rp.reduce((q, p) => add(q, p), [0, 0, 0]), 1 / rp.length), dF = dist(a, c), dL = dist(b, c);
      if (Math.abs(dF - dL) >= md) return { ok: dF < dL, basis: 'root', dFirst: dF, dLast: dL };
    }
    return { ok: a[2] >= b[2], basis: 'z', zFirst: a[2], zLast: b[2] };
  }
  /* Returns the control points in the canonical apex -> descending order (reversed copy if the order check fails). */
  function orientCentreline(ctrl, rootPts) {
    const chk = centrelineOrder(ctrl, rootPts), pts = ctrl.map((p) => p.slice());
    if (!chk.ok) pts.reverse();
    return { ctrl: pts, reversed: !chk.ok, check: chk };
  }
  /* Default descending-aorta level (arc length from the apex end): 80 mm of centreline beyond the highest centreline point
   * (the top of the arch), clamped to [0.1 L, 0.85 L]. */
  function defaultDescLevel(cl) {
    let zi = 0; for (let i = 0; i < cl.pts.length; i++) if (cl.pts[i][2] > cl.pts[zi][2]) zi = i;
    return Math.min(Math.max(cl.s[zi] + 80, 0.1 * cl.length), 0.85 * cl.length);
  }
  function indexAt(cl, s) {
    const n = cl.pts.length;
    const t = Math.min(Math.max(s, 0), cl.length) / cl.length * (n - 1);
    const i = Math.min(Math.floor(t), n - 2);
    return [i, t - i];
  }
  // interpolated frame at arc length s
  function frameAt(cl, s) {
    const [i, f] = indexAt(cl, s);
    const C = lerp(cl.pts[i], cl.pts[i + 1], f);
    const T = norm(lerp(cl.T[i], cl.T[i + 1], f));
    let N1 = lerp(cl.N1[i], cl.N1[i + 1], f);
    N1 = norm(sub(N1, mul(T, dot(N1, T))));
    return { C, T, N1, N2: cross(T, N1), s: Math.min(Math.max(s, 0), cl.length) };
  }
  // arc length of the centreline point closest to P
  function nearestS(cl, P) {
    let best = 1e18, bi = 0;
    for (let i = 0; i < cl.pts.length; i++) {
      const d = dist(cl.pts[i], P);
      if (d < best) { best = d; bi = i; }
    }
    // refine with projection on neighbouring segment
    let s = cl.s[bi];
    const j0 = Math.max(0, bi - 1), j1 = Math.min(cl.pts.length - 1, bi + 1);
    const seg = sub(cl.pts[j1], cl.pts[j0]), sl = dot(seg, seg);
    if (sl > 1e-12) {
      const u = dot(sub(P, cl.pts[j0]), seg) / sl;
      s = cl.s[j0] + Math.min(Math.max(u, 0), 1) * (cl.s[j1] - cl.s[j0]);
    }
    return { s, dist: best };
  }
  // angular position (deg, from N1 toward N2) and radius of P about the centreline at arc length s
  function angularPosition(cl, s, P) {
    const f = frameAt(cl, s);
    const v = sub(P, f.C), ax = dot(v, f.T);
    const vp = sub(v, mul(f.T, ax));
    return { phi: Math.atan2(dot(vp, f.N2), dot(vp, f.N1)) * R2D, rho: len(vp), axial: ax, s: f.s };
  }
  function positionFromAngle(cl, s, phiDeg, rho, axial) {
    const f = frameAt(cl, s), p = phiDeg * D2R;
    return add(add(f.C, add(mul(f.N1, rho * Math.cos(p)), mul(f.N2, rho * Math.sin(p)))), mul(f.T, axial || 0));
  }
  /* Transfer H markers to A markers.
   * H: {NL:[x,y,z],...}; opts: sD (target arc length), refMode 'own' | 'common', sCommon, radiusMode 'keep'|'mean'|'fixed', fixedR, keepAxial(false) */
  function transferMarkers(cl, H, opts) {
    const keys = Object.keys(H).filter((k) => H[k]);
    const res = {};
    const cen = keys.length ? mul(keys.reduce((a, k) => add(a, H[k]), [0, 0, 0]), 1 / keys.length) : null;
    const sCommon = opts.refMode === 'common' ? (opts.sCommon != null ? opts.sCommon : nearestS(cl, cen).s) : null;
    keys.forEach((k) => {
      const sRef = sCommon != null ? sCommon : nearestS(cl, H[k]).s;
      res[k] = angularPosition(cl, sRef, H[k]);
    });
    const rhoMean = keys.length ? keys.reduce((a, k) => a + res[k].rho, 0) / keys.length : 0;
    keys.forEach((k) => {
      const r = opts.radiusMode === 'fixed' ? opts.fixedR : opts.radiusMode === 'mean' ? rhoMean : res[k].rho;
      res[k].rhoUsed = r;
      res[k].A = positionFromAngle(cl, opts.sD, res[k].phi, r, opts.keepAxial ? res[k].axial : 0);
      res[k].phiA = res[k].phi;
    });
    return res;
  }
  // sorted angular separations (deg) between markers, for sanity check (expect ~120)
  function angularGaps(phis) {
    const a = phis.slice().sort((x, y) => x - y);
    const g = [];
    for (let i = 0; i < a.length; i++) g.push((((a[(i + 1) % a.length] - a[i]) % 360) + 360) % 360 || 360);
    return g;
  }

  /* ---------- C-arm geometry ----------
   * Beam direction d (source -> detector) in LPS for the supine head-first patient:
   *   d = ( sin(LAO) cos(CRAN), -cos(LAO) cos(CRAN), sin(CRAN) )
   * AP (0,0): d = (0,-1,0) (source posterior, detector anterior).
   * LAO+: detector moves to patient's left (+x); CRAN+: detector moves to the head (+z).
   * Image basis (viewer at detector looking toward source, standard fluoro display):
   *   up = z-component of the beam perpendicular, right = up x d   (patient left appears on image right at AP). */
  function beamDir(lao, cran) {
    const a = lao * D2R, c = cran * D2R;
    return [Math.sin(a) * Math.cos(c), -Math.cos(a) * Math.cos(c), Math.sin(c)];
  }
  function imageBasis(lao, cran) {
    const d = beamDir(lao, cran), a = lao * D2R, c = cran * D2R;
    const up = [-Math.sin(c) * Math.sin(a), Math.sin(c) * Math.cos(a), Math.cos(c)];
    const right = cross(up, d);
    return { d, up, right };
  }
  // orthographic projection into image coordinates (x right, y up), mm
  function project(P, lao, cran) {
    const b = imageBasis(lao, cran);
    return [dot(P, b.right), dot(P, b.up)];
  }
  /* Inverse of beamDir(): beam direction d (source -> detector, LPS) -> {lao, cran} in degrees (LAO, CRAN positive; unrounded).
   * d and -d are the same line of sight (mirror-image projection); the one with the source posterior (d_y <= 0, |LAO| <= 90) is returned,
   * which is the physically reachable representation. d is returned (unit, flipped if needed) as .d */
  function beamAngles(d) {
    let v = norm(d);
    if (v[1] > 1e-12 || (Math.abs(v[1]) <= 1e-12 && v[0] < 0)) v = mul(v, -1);
    return { lao: Math.atan2(v[0], -v[1]) * R2D, cran: Math.asin(Math.max(-1, Math.min(1, v[2]))) * R2D, d: v };
  }
  /* Beams belonging to the longitudinal cut plane of the stretched vessel view at one centreline level.
   * fr = {T, N1, N2} (frameAt), alphaDeg = cut-plane angle about the centreline measured from N1 toward N2 (same as renderCPR).
   * The cut plane at this level is span{T, e}, e = cos(a) N1 + sin(a) N2 (the stretched view's vertical axis); its normal is n = T x e.
   *  - edge-on: beam d = e (in the plane, perpendicular to the centreline axis) -> the plane projects to a line along the projected axis;
   *    ANY beam in the plane (d = cos(t) T + sin(t) e) keeps it edge-on and gives the same marker lateral offsets (n . (P - C)); e is the one without foreshortening of the axis.
   *  - face-on: beam d = n (perpendicular to the plane) -> the plane is seen face-on, marker lateral offsets = e . (P - C), i.e. exactly what the stretched view shows.
   * Returns { e, n, edge: beamAngles(e), face: beamAngles(n) }. */
  function cutPlaneBeams(fr, alphaDeg) {
    const a = alphaDeg * D2R, e = add(mul(fr.N1, Math.cos(a)), mul(fr.N2, Math.sin(a))), n = cross(fr.T, e);
    return { e, n, edge: beamAngles(e), face: beamAngles(n) };
  }
  function labelAngles(lao, cran) {
    const l = (lao > 0 ? 'LAO ' : lao < 0 ? 'RAO ' : 'LAO/RAO ') + Math.abs(lao) + '°';
    const c = (cran > 0 ? 'CRAN ' : cran < 0 ? 'CAUD ' : 'CRAN/CAUD ') + Math.abs(cran) + '°';
    return l + ' / ' + c;
  }
  /* Explicit 2D evaluation (used for the diagram and as independent check of the fast version).
   * axis: {C, a}; pts: array of 3D marker positions. Returns image-plane quantities, relative to C. */
  function evalViewProjected(C, a, pts, lao, cran) {
    const b = imageBasis(lao, cran);
    const pC = [dot(C, b.right), dot(C, b.up)];
    let ap = [dot(a, b.right), dot(a, b.up)];
    const l = Math.hypot(ap[0], ap[1]);
    if (l < 1e-6) return { degenerate: true };
    ap = [ap[0] / l, ap[1] / l];
    if (ap[1] < 0 || (Math.abs(ap[1]) < 1e-9 && ap[0] < 0)) ap = [-ap[0], -ap[1]];
    const nImg = [ap[1], -ap[0]]; // image-right of the axis direction
    const tilt = Math.atan2(ap[0], ap[1]) * R2D; // deg from image vertical, +ve = leaning to image right
    const out = pts.map((P) => {
      const q = [dot(P, b.right) - pC[0], dot(P, b.up) - pC[1]];
      return { x: q[0], y: q[1], s: q[0] * nImg[0] + q[1] * nImg[1], w: q[0] * ap[0] + q[1] * ap[1] };
    });
    return { degenerate: false, axisSin: l, tilt, markers: out, n3: add(mul(b.right, nImg[0]), mul(b.up, nImg[1])) };
  }
  // 3D unit vector (perpendicular to the axis, lying in the image plane) that points to IMAGE RIGHT after the projected
  // axis is oriented 'upward' on the image. Lateral offset of a marker = (P - C) . n3 ; >0 means right of the axis on the image.
  function lateralDir(a, lao, cran) {
    const b = imageBasis(lao, cran);
    let ax = dot(a, b.right), ay = dot(a, b.up);
    const l = Math.hypot(ax, ay);
    if (l < 1e-9) return null;
    ax /= l; ay /= l;
    if (ay < 0 || (Math.abs(ay) < 1e-9 && ax < 0)) { ax = -ax; ay = -ay; }
    return add(mul(b.right, ay), mul(b.up, -ax));
  }
  // classify lateral offsets into 2:1
  function classify(s, minMargin) {
    const n = s.length;
    let neg = 0, pos = 0, minAbs = 1e18;
    for (let i = 0; i < n; i++) { if (s[i] < 0) neg++; else pos++; minAbs = Math.min(minAbs, Math.abs(s[i])); }
    const is21 = (neg === 1 && pos === 2) || (neg === 2 && pos === 1);
    const valid = is21 && minAbs >= (minMargin || 0);
    let single = -1, gap = 0, pairSide = 0;
    if (is21) {
      single = neg === 1 ? s.findIndex((v) => v < 0) : s.findIndex((v) => v >= 0);
      pairSide = neg === 1 ? 1 : -1; // +1: the pair is on image RIGHT, -1: pair on image LEFT
      gap = 1e18;
      for (let i = 0; i < n; i++) if (i !== single) gap = Math.min(gap, Math.abs(s[i] - s[single]));
    }
    return { is21, valid, margin: is21 ? minAbs : 0, gap: is21 ? gap : 0, single, pairSide };
  }
  // fast evaluation: lateral offset = signed distance of marker from the plane spanned by axis and beam
  function evalViewFast(C, a, pts, lao, cran, minMargin) {
    const d = beamDir(lao, cran), m = cross(a, d), ml = len(m);
    if (ml < Math.sin(10 * D2R)) return { degenerate: true, valid: false, is21: false, margin: 0, gap: 0, s: [], single: -1 };
    let mu = mul(m, 1 / ml);
    const n3 = lateralDir(a, lao, cran);
    if (dot(mu, n3) < 0) mu = mul(mu, -1); // orient to image-right so the sign is the image side
    const s = pts.map((P) => dot(sub(P, C), mu));
    const c = classify(s, minMargin);
    c.s = s; c.degenerate = false;
    return c;
  }
  const LAO_MIN = -60, LAO_MAX = 60, CRAN_MIN = -40, CRAN_MAX = 40;
  function scanProjections(C, a, pts, opts) {
    opts = opts || {};
    const minMargin = opts.minMargin == null ? 2 : opts.minMargin;
    const nL = LAO_MAX - LAO_MIN + 1, nC = CRAN_MAX - CRAN_MIN + 1;
    const pairSide = new Int8Array(nL * nC), margin = new Float32Array(nL * nC), gap = new Float32Array(nL * nC), valid = new Uint8Array(nL * nC), is21 = new Uint8Array(nL * nC), stable = new Uint8Array(nL * nC);
    let best = 0;
    for (let ci = 0; ci < nC; ci++) for (let li = 0; li < nL; li++) {
      const r = evalViewFast(C, a, pts, LAO_MIN + li, CRAN_MIN + ci, minMargin), k = ci * nL + li;
      valid[k] = r.valid ? 1 : 0; is21[k] = r.is21 ? 1 : 0; pairSide[k] = r.pairSide || 0;
      margin[k] = r.valid ? r.margin : 0; gap[k] = r.valid ? r.gap : 0;
      if (r.valid && r.margin > best) best = r.margin;
    }
    const R = opts.stableRadius == null ? 2 : opts.stableRadius;
    for (let ci = 0; ci < nC; ci++) for (let li = 0; li < nL; li++) {
      let ok = 1;
      for (let dc = -R; dc <= R && ok; dc++) for (let dl = -R; dl <= R; dl++) {
        const c2 = ci + dc, l2 = li + dl;
        if (c2 < 0 || c2 >= nC || l2 < 0 || l2 >= nL) continue;
        if (!valid[c2 * nL + l2]) { ok = 0; break; }
      }
      stable[ci * nL + li] = ok;
    }
    return { nL, nC, margin, gap, valid, is21, stable, pairSide, best, minMargin, laoMin: LAO_MIN, cranMin: CRAN_MIN };
  }
  const gridAngles = (g, k) => ({ lao: g.laoMin + (k % g.nL), cran: g.cranMin + Math.floor(k / g.nL) });
  /* Ranked, non-maximum-suppressed candidate lists.
   * mode 'margin': by separation (ties -> smaller angle burden)
   * mode 'practical': among cells with margin >= frac*best, smallest angle burden sqrt(LAO^2+CRAN^2) first */
  function rankProjections(g, opts) {
    opts = opts || {};
    const mode = opts.mode || 'margin', frac = opts.frac == null ? 0.7 : opts.frac, nms = opts.nms == null ? 4 : opts.nms, count = opts.count || 8;
    const cand = [];
    for (let k = 0; k < g.valid.length; k++) {
      if (!g.valid[k]) continue;
      if (opts.stableOnly && !g.stable[k]) continue;
      if (opts.side === 'left' && g.pairSide[k] !== -1) continue;
      if (opts.side === 'right' && g.pairSide[k] !== 1) continue;
      const a = gridAngles(g, k);
      if (mode === 'practical' && g.margin[k] < frac * (opts.refBest != null ? opts.refBest : g.best)) continue;
      cand.push({ lao: a.lao, cran: a.cran, margin: g.margin[k], gap: g.gap[k], pairSide: g.pairSide[k], stable: !!g.stable[k], burden: Math.hypot(a.lao, a.cran) });
    }
    if (mode === 'margin') cand.sort((p, q) => (q.margin - p.margin) > 1e-6 ? 1 : (q.margin - p.margin) < -1e-6 ? -1 : p.burden - q.burden);
    else cand.sort((p, q) => (p.burden - q.burden) || (q.margin - p.margin));
    const out = [];
    for (const c of cand) {
      if (out.every((o) => Math.hypot(o.lao - c.lao, o.cran - c.cran) >= nms)) out.push(c);
      if (out.length >= count) break;
    }
    out.forEach((o, i) => { o.rank = i + 1; });
    return out;
  }

  return { D2R, R2D, add, sub, mul, dot, cross, len, norm, lerp, dist, wrap180,
    catmullRom, resample, gaussSmooth, arcLengths, rmf, buildCentreline, centrelineOrder, orientCentreline, defaultDescLevel, frameAt, nearestS, angularPosition, positionFromAngle, transferMarkers, angularGaps,
    beamDir, beamAngles, cutPlaneBeams, imageBasis, lateralDir, project, labelAngles, evalViewProjected, evalViewFast, classify, scanProjections, rankProjections, gridAngles,
    LAO_MIN, LAO_MAX, CRAN_MIN, CRAN_MAX };
});
