/* NavPhantom: synthetic CT-like phantom (contrast-filled aorta tube from the descending end ("bifurcation") to the LV "apex" with an arch (its internal truth centreline runs descending -> apex; demoCtrl() returns the app's marking order apex -> descending),
 * aortic root with three commissure nodules and three nadir nodules). No patient data. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./math.js'));
  else root.NavPhantom = factory(root.NavMath);
})(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';
  // internal control points descending end -> apex, LPS mm
  const CTRL = [[28, 52, -210], [28, 52, -120], [30, 48, -30], [31, 42, 50], [30, 32, 110], [22, 14, 145], [4, 0, 152], [-14, -6, 135],
    [-22, -12, 105], [-24, -16, 70], [-24, -18, 35], [-22, -18, 5], [-12, -14, -30], [6, -10, -65], [22, -4, -95]];
  const COMM_DEG = { NR: 35, NL: 155, LR: 275 };      // commissure angular positions about the root centreline (RMF, from N1 toward N2)
  const CUSP_DEG = { RCC: 335, NCC: 95, LCC: 215 };   // cusp-centre (nadir) angular positions
  const sm = (a, b, x) => { const t = Math.min(Math.max((x - a) / (b - a), 0), 1); return t * t * (3 - 2 * t); };

  function generate(opts) {
    opts = opts || {};
    const sp = opts.spacing || 2, nx = 128, ny = 128, nz = Math.round(420 / sp);
    const dims = [nx, ny, nz], origin = [-128, -100, -230];
    const data = new Int16Array(nx * ny * nz);
    const cl = M.buildCentreline(CTRL, { smoothMm: 0, step: 0.7 });
    const sRoot = M.nearestS(cl, CTRL[10]).s, sA0 = M.nearestS(cl, CTRL[4]).s, sA1 = M.nearestS(cl, CTRL[8]).s, L = cl.length;
    const rad = (s) => {
      let r = 11 + 3 * sm(sA0 - 20, sA0 + 10, s) + 1.5 * sm(sA1 - 10, sA1 + 20, s);
      const bump = sm(sRoot - 28, sRoot - 14, s) * (1 - sm(sRoot + 2, sRoot + 12, s));
      r = r * (1 - bump) + 17.5 * bump;
      const lv = sm(sRoot + 8, sRoot + 45, s); r = r * (1 - lv) + 26 * lv;
      const tp = sm(L - 30, L, s); return r * (1 - tp) + 9 * tp;
    };
    let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296 - 0.5;
    // background: air, body ellipse, spine
    let p = 0;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, p++) {
      const x = origin[0] + i * sp, y = origin[1] + j * sp;
      let v = -1000;
      if ((x / 115) ** 2 + ((y - 25) / 85) ** 2 < 1) v = 40;
      if ((x - 5) ** 2 + (y - 88) ** 2 < 14 * 14) v = 250;
      data[p] = v + rnd() * 16;
    }
    const splat = (c, r, hu) => {
      const i0 = Math.max(0, Math.floor((c[0] - r - origin[0]) / sp)), i1 = Math.min(nx - 1, Math.ceil((c[0] + r - origin[0]) / sp));
      const j0 = Math.max(0, Math.floor((c[1] - r - origin[1]) / sp)), j1 = Math.min(ny - 1, Math.ceil((c[1] + r - origin[1]) / sp));
      const k0 = Math.max(0, Math.floor((c[2] - r - origin[2]) / sp)), k1 = Math.min(nz - 1, Math.ceil((c[2] + r - origin[2]) / sp));
      for (let k = k0; k <= k1; k++) for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const x = origin[0] + i * sp - c[0], y = origin[1] + j * sp - c[1], z = origin[2] + k * sp - c[2];
        if (x * x + y * y + z * z <= r * r) data[(k * ny + j) * nx + i] = hu + rnd() * 16;
      }
    };
    for (let i = 0; i < cl.pts.length; i++) splat(cl.pts[i], rad(cl.s[i]), 350);
    // landmarks
    const H = {}, nadir = {};
    for (const k of Object.keys(COMM_DEG)) { H[k] = M.positionFromAngle(cl, sRoot - 3, COMM_DEG[k], 16.5, 0); splat(H[k], 2.6, 1000); }
    for (const k of Object.keys(CUSP_DEG)) { nadir[k] = M.positionFromAngle(cl, sRoot + 9, CUSP_DEG[k], 13, 0); splat(nadir[k], 2.2, 700); }
    return {
      volume: { dims, data, origin, vi: [sp, 0, 0], vj: [0, sp, 0], vk: [0, 0, sp], info: { desc: 'Synthetic phantom (no patient data)', modality: 'PHANTOM', slices: nz, rows: ny, cols: nx, downsample: 1, pixelSpacing: [sp, sp], sliceStep: sp }, warnings: [] },
      truth: { ctrl: CTRL.map((q) => q.slice()), H, nadir, commDeg: COMM_DEG, cuspDeg: CUSP_DEG, sRoot, centreline: cl, length: L, radius: rad,
        /* default demo control points: every ~40 mm of arc length, always including both ends */
        // app marking order: LV apex first -> root -> arch -> descending aorta (the phantom's own centreline runs the other way)
        demoCtrl() { const n = Math.round(L / 40), out = []; for (let i = 0; i <= n; i++) out.push(M.frameAt(cl, L * (n - i) / n).C); return out; } }
    };
  }
  /* ---------- aortic-root phantom: three bulging sinuses of Valsalva with known cusp nadirs (for testing the nadir detector) ----------
   * Anatomy (LPS: x + left, y + posterior, z + superior). Root axis a points LV -> aorta (flow direction, superior/right/slightly posterior).
   * Viewed from the aorta looking toward the LV, RCC -> LCC -> NCC runs counter-clockwise (= right-handed rotation about a).
   * RCC anterior(-right), LCC left(-posterior), NCC posterior(-right). Cusp nadir = lowest point of each sinus (hinge, h = 0 on the annular plane).
   * opts: spacing [sx,sy,sz] (default 0.75 iso), noise (HU sd, default 25), variant 'closed' (leaflets closed: lumen ends at the leaflets; default)
   * | 'open' (lumen continuous with LVOT/LV), axisDir, rotDeg (rotates the whole cusp configuration about the axis), lead (extras: coronaries + left atrium), seed offset. */
  function generateRoot(opts) {
    opts = opts || {};
    const sp = Array.isArray(opts.spacing) ? opts.spacing : [opts.spacing || 0.75, opts.spacing || 0.75, opts.spacing || 0.75];
    const nx = opts.nx || 128, ny = opts.ny || 128, nz = opts.nz || Math.round(128 * 0.75 / sp[2]);
    const noise = opts.noise == null ? 25 : opts.noise, variant = opts.variant || 'closed', extras = opts.extras !== false;
    const a = M.norm(opts.axisDir || [-0.35, 0.25, 0.9]);
    const e1 = M.norm(M.cross([0, 0, 1], a)), e2 = M.cross(a, e1);            // e1 x e2 = a  (right-handed about a)
    const proj = (v) => { const d = M.dot(v, a); return M.norm([v[0] - d * a[0], v[1] - d * a[1], v[2] - d * a[2]]); };
    const rot = (opts.rotDeg || 0) * Math.PI / 180;
    const anat = { RCC: [-0.30, -0.95, 0], LCC: [0.85, 0.05, 0], NCC: [-0.60, 0.80, 0] };   // typical cusp directions in the axial plane (LPS)
    const dirs = {}, ang = {};
    for (const k of Object.keys(anat)) { const p0 = proj(anat[k]), th = Math.atan2(M.dot(p0, e2), M.dot(p0, e1)) + rot; ang[k] = th; dirs[k] = M.add(M.mul(e1, Math.cos(th)), M.mul(e2, Math.sin(th))); }
    const dims = [nx, ny, nz], ctr = [0, 0, 0], origin = [ctr[0] - (nx - 1) * sp[0] / 2, ctr[1] - (ny - 1) * sp[1] / 2, ctr[2] - (nz - 1) * sp[2] / 2];
    const data = new Int16Array(nx * ny * nz);
    const smstep = (e0, e1_, x) => { const t = Math.min(Math.max((x - e0) / (e1_ - e0), 0), 1); return t * t * (3 - 2 * t); };
    const C0 = [0, 0, -6].map((v, i) => v + (opts.centre ? opts.centre[i] : 0));          // annular-plane centre (patient mm)
    const wrap = (d) => { d = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; return d; };
    const cusps = Object.keys(ang);
    const wallR = (th, h) => {
      const base = 12 + 2 * smstep(0, 22, h) + 1.5 * smstep(22, 45, h);
      let g = 0; for (const k of cusps) { const d = wrap(th - ang[k]) * 180 / Math.PI; g += Math.exp(-((d / 36) * (d / 36))); }
      const bell = h > 0 && h < 22 ? Math.pow(Math.sin(Math.PI * h / 22), 1.5) : 0;
      return base + 5 * bell * g;
    };
    const commH = opts.commHeight == null ? 18 : opts.commHeight;                     // height of the commissure apex (top of the cusp attachment line) above the nadir plane
    // sinus floor (cusp attachment line): 0 at each cusp centre, rising to commH at the commissure = angular midpoint of the two adjacent cusps (sharp apex, like the semilunar attachment crown)
    const floorH = (th) => {
      let X = cusps[0], dm = 1e9; for (const k of cusps) { const dd = Math.abs(wrap(th - ang[k])); if (dd < dm) { dm = dd; X = k; } }
      const sgn = wrap(th - ang[X]) >= 0 ? 1 : -1; let gap = 2 * Math.PI;
      for (const k of cusps) if (k !== X) { const dg = wrap(ang[k] - ang[X]) * sgn; if (dg > 0 && dg < gap) gap = dg; }
      return commH * Math.min(1, dm / (gap / 2)) ** 2;
    };
    const la = M.add(C0, M.add(M.mul(dirs.NCC, 41), M.mul(a, 8)));                       // left atrium: bright blob behind the NCC, separated by wall
    const coro = [['LCC', 15], ['RCC', 15]].map(([k, hh]) => ({ o: M.add(C0, M.add(M.mul(a, hh), M.mul(dirs[k], 14))), d: M.norm(M.add(dirs[k], M.mul(a, 0.25))) }));
    const inLumen = (x, y, z) => {
      const q = [x - C0[0], y - C0[1], z - C0[2]], h = M.dot(q, a), qa = [q[0] - h * a[0], q[1] - h * a[1], q[2] - h * a[2]], rho = Math.hypot(qa[0], qa[1], qa[2]);
      if (h >= 0 && h < 120) {
        const th = Math.atan2(M.dot(qa, e2), M.dot(qa, e1)), R = wallR(th, h);
        if (rho < R) {
          if (variant === 'open') { const tube = 11 + 0.5 * smstep(0, 10, h); if (rho < tube || h >= floorH(th)) return true; }
          else { const w = Math.min(1, Math.pow(rho / 12, 1.5)), Hs = 9 + (floorH(th) - 9) * w; if (h >= Hs) return true; }
        }
      }
      if (variant === 'open' && h < 0 && h > -70) { if (rho < 11 + 14 * smstep(-2, -32, h)) return true; }
      if (extras) {
        if (Math.hypot(x - la[0], y - la[1], z - la[2]) < 20) return true;
        for (const c of coro) { const v = [x - c.o[0], y - c.o[1], z - c.o[2]], t = M.dot(v, c.d); if (t > -6 && t < 22 && Math.hypot(v[0] - t * c.d[0], v[1] - t * c.d[1], v[2] - t * c.d[2]) < 1.6) return true; }
      }
      return false;
    };
    let seed = 987654321; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    const SS = [-0.25, 0.25];
    let p = 0;
    for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++, p++) {
      const x = origin[0] + i * sp[0], y = origin[1] + j * sp[1], z = origin[2] + k * sp[2];
      let f = 0; for (const dz of SS) for (const dy of SS) for (const dx of SS) if (inLumen(x + dx * sp[0], y + dy * sp[1], z + dz * sp[2])) f++;
      f /= 8; data[p] = Math.round(40 + 310 * f + (noise ? gauss() * noise : 0));
    }
    const nadir = {};
    for (const k of cusps) nadir[k] = M.add(C0, M.mul(dirs[k], wallR(ang[k], 0)));         // wall at the hinge, h = 0
    // commissures: angular midpoint of the two adjacent cusps (arc not containing the third), at the apex height, on the wall
    const commissure = {}, commAngles = {};
    for (const [nm, X, Y, Z] of [['NL', 'NCC', 'LCC', 'RCC'], ['NR', 'NCC', 'RCC', 'LCC'], ['LR', 'LCC', 'RCC', 'NCC']]) {
      const d = wrap(ang[Y] - ang[X]), mid = ang[X] + d / 2; commAngles[nm] = mid;
      const dir = M.add(M.mul(e1, Math.cos(mid)), M.mul(e2, Math.sin(mid)));
      commissure[nm] = M.add(C0, M.add(M.mul(a, commH), M.mul(dir, wallR(mid, commH))));
    }
    const so = opts.seedOffset || [2.5, -2, 12];
    return {
      volume: { dims, data, origin, vi: [sp[0], 0, 0], vj: [0, sp[1], 0], vk: [0, 0, sp[2]], info: { desc: 'Synthetic aortic-root phantom (no patient data)', modality: 'PHANTOM', slices: nz, rows: ny, cols: nx, downsample: 1, pixelSpacing: [sp[1], sp[0]], sliceStep: sp[2] }, warnings: [] },
      truth: { nadir, commissure, commAngles, commHeight: commH, axis: a, e1, e2, annulusCentre: C0, cuspDirs: dirs, cuspAngles: ang, seed: M.add(M.add(C0, [so[0], so[1], 0]), M.mul(a, so[2])), variant }
    };
  }
  return { generate, generateRoot, CTRL, COMM_DEG, CUSP_DEG };
});
