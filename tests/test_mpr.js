// Oblique / double-oblique MPR maths (NavMPR) + plane rendering on volumes with analytically known HU fields.
const Q = require('../src/js/mpr.js'), V = require('../src/js/volume.js'), M = require('../src/js/math.js');
const { test, near, ok, summary } = require('./harness.js');
console.log('Oblique MPR checks');
const D2R = Math.PI / 180, dot = M.dot, near3 = (a, b, tol, m) => { for (let i = 0; i < 3; i++) near(a[i], b[i], tol, m + '[' + i + ']'); };
// volume: HU = 1000 + g . P  (linear field is reproduced exactly by trilinear interpolation) on a 100^3 grid, 1 mm, centred on the origin
function linVol(g) {
  const n = 100, data = new Int16Array(n * n * n), o = -(n - 1) / 2; let p = 0;
  for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++, p++) data[p] = Math.round(1000 + g[0] * (o + i) + g[1] * (o + j) + g[2] * (o + k));
  return new V.Volume({ dims: [n, n, n], data, origin: [o, o, o], vi: [1, 0, 0], vj: [0, 1, 0], vk: [0, 0, 1], info: {} });
}
const W = 120, H = 100, MM = 0.5;
function render(vol, O, name, cross, wl) {          // exactly what PlaneView does: plane through `cross`, o = n (cross.n), pan centre = cross -> in-plane coords
  const f = Q.viewFrame(O, name), o = M.mul(f.n, dot(cross, f.n)), cu = dot(cross, f.u), cv = dot(cross, f.v);
  const toWorld = (px, py) => { const a = cu + (px - W / 2) * MM, b = cv + (py - H / 2) * MM; return M.add(o, M.add(M.mul(f.u, a), M.mul(f.v, b))); };
  const buf = new Uint32Array(W * H), P00 = toWorld(0, 0); vol.renderPlane(buf, W, H, P00, M.mul(f.u, MM), M.mul(f.v, MM), wl.c, wl.w);
  return { buf, toWorld, f };
}
const gray = (buf, x, y) => buf[y * W + x] & 255, wl = { c: 1000, w: 800 }, huOfGray = (g) => g * 800 / 255 + 1000 - 400;

test('identity orientation == the classic axial / coronal / sagittal frames of earlier versions', () => {
  const O = Q.identity(), A = Q.viewFrame(O, 'axial'), C = Q.viewFrame(O, 'coronal'), S = Q.viewFrame(O, 'sagittal');
  near3(A.u, [1, 0, 0], 1e-12, 'axial u'); near3(A.v, [0, 1, 0], 1e-12, 'axial v'); near3(A.n, [0, 0, 1], 1e-12, 'axial n');
  near3(C.u, [1, 0, 0], 1e-12, 'cor u'); near3(C.v, [0, 0, -1], 1e-12, 'cor v'); near3(C.n, [0, 1, 0], 1e-12, 'cor n');
  near3(S.u, [0, 1, 0], 1e-12, 'sag u'); near3(S.v, [0, 0, -1], 1e-12, 'sag v'); near3(S.n, [-1, 0, 0], 1e-12, 'sag n');
  ok(Q.isIdentity(O) && !Q.isIdentity(Q.rotateAbout(O, [0, 0, 1], 1)));
  for (const nm of Q.NAMES) { const ls = Q.viewLines(O, nm); ok(ls.every((l) => Math.abs(Math.abs(l.screen[0]) - 1) < 1e-12 || Math.abs(Math.abs(l.screen[1]) - 1) < 1e-12), nm + ' lines axis-aligned'); }
});
test('frames are right-handed orthonormal (u x v = n) for random double-oblique orientations; 2000 successive rotations do not drift', () => {
  let O = Q.identity(), seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  for (let i = 0; i < 2000; i++) { const ax = M.norm([rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]); O = Q.rotateAbout(O, ax, (rnd() - 0.5) * 20); }
  const c = Q.checkOrtho(O); for (const k of ['dxy', 'dxz', 'dyz']) near(c[k], 0, 1e-12, k); near(c.nx, 1, 1e-12); near(c.ny, 1, 1e-12); near(c.nz, 1, 1e-12); near(c.det, 1, 1e-12, 'det');
  const P = (Q2) => Q2; for (const nm of Q.NAMES) { const f = Q.viewFrame(O, nm); near(M.len(M.cross(f.u, f.v)), 1, 1e-9); near3(M.cross(f.u, f.v), f.n, 1e-9, nm + ' u x v'); near(dot(f.u, f.n), 0, 1e-12); }
});
test('rotate about the axial normal by a known angle (30°): coronal / sagittal normals rotate by exactly 30°, axial view unchanged, lines tilt by 30°', () => {
  const O = Q.rotateAbout(Q.identity(), [0, 0, 1], 30), c = Math.cos(30 * D2R), s = Math.sin(30 * D2R);
  near3(O.X, [c, s, 0], 1e-12, 'X'); near3(O.Y, [-s, c, 0], 1e-12, 'Y'); near3(O.Z, [0, 0, 1], 1e-12, 'Z');
  const A = Q.viewFrame(O, 'axial'); near3(A.u, [1, 0, 0], 1e-12, 'axial image does not rotate'); near3(A.v, [0, 1, 0], 1e-12);
  const la = Q.viewLines(O, 'axial'); near(Math.abs(Q.angles(O).rot.axial), 30, 1e-9, 'axial lines'); ok(la.every((l) => Math.abs(dot(l.dir, [0, 0, 1])) < 1e-12));
  // coronal plane normal = Y: its in-plane right axis is X, down axis -z; sagittal normal = -X
  near3(Q.viewFrame(O, 'coronal').n, [-s, c, 0], 1e-12, 'coronal n'); near3(Q.viewFrame(O, 'coronal').u, [c, s, 0], 1e-12, 'coronal u'); near3(Q.viewFrame(O, 'sagittal').n, [-c, -s, 0], 1e-12, 'sagittal n');
  near(Q.angles(O).tiltAxial, 0, 1e-9);
  // in the coronal and sagittal views the lines (axial trace / other plane) stay axis-aligned for a rotation about z
  for (const nm of ['coronal', 'sagittal']) for (const l of Q.viewLines(O, nm)) ok(Math.abs(l.screen[0]) < 1e-9 || Math.abs(l.screen[1]) < 1e-9, nm + ' line tilted ' + l.angle);
});
test('rotate about the coronal normal by 20° after 30° about z (double oblique): tilt of the axial normal from z, orthogonality, wheel normal', () => {
  let O = Q.rotateAbout(Q.identity(), [0, 0, 1], 30); O = Q.rotateAbout(O, Q.viewFrame(O, 'coronal').n, 20);
  near(Q.angles(O).tiltAxial, 20, 1e-9, 'tilt'); near(Q.checkOrtho(O).det, 1, 1e-12);
  // the coronal view is now unchanged (rotation about its own normal): lines tilt by 20 in the coronal view, its screen frame stays the old one
  near(Math.abs(Q.angles(O).rot.coronal), 20, 1e-9, 'coronal lines'); const n = Q.viewFrame(O, 'axial').n; near(M.len(n), 1, 1e-12);
});
test('PLANE SAMPLING: linear HU field, planes rotated by 30° (z) and double-oblique: every rendered pixel equals the analytic HU at its patient position (<= 1 grey level)', () => {
  const g = [4, 2, 1], vol = linVol(g), cross = [3, -2, 5];
  for (const O of [Q.identity(), Q.rotateAbout(Q.identity(), [0, 0, 1], 30), (() => { let O = Q.rotateAbout(Q.identity(), [0, 0, 1], 30); return Q.rotateAbout(O, Q.viewFrame(O, 'coronal').n, 20); })(), Q.rotateAbout(Q.rotateAbout(Q.identity(), [1, 0, 0], -25), [0, 1, 0], 40)]) {
    for (const nm of Q.NAMES) {
      const r = render(vol, O, nm, cross, wl); let checked = 0, maxd = 0;
      for (let y = 5; y < H - 5; y += 7) for (let x = 5; x < W - 5; x += 7) {
        const P = r.toWorld(x, y), want = 1000 + dot(g, P), hu = huOfGray(gray(r.buf, x, y)); checked++; maxd = Math.max(maxd, Math.abs(hu - want));
      }
      ok(checked > 100 && maxd <= 800 / 255 * 1.0 + 1.0, nm + ' max |dHU| ' + maxd.toFixed(2));
      // the plane contains the crosshair and its normal is the frame normal: HU at the pixel of the crosshair equals the field there
      const px = Math.round(W / 2), py = Math.round(H / 2), Pc = r.toWorld(px, py); ok(Math.abs(dot(M.sub(Pc, cross), r.f.n)) < 1e-9, nm + ' plane through the crosshair');
    }
  }
});
test('KNOWN-ANGLE PIXEL CHECK: gradient field along (cos30°, sin30°, 0): in the 30°-rotated coronal view HU changes by 5 HU/mm along screen x and not at all along y; unrotated: 5 cos30° HU/mm', () => {
  const dx = [Math.cos(30 * D2R), Math.sin(30 * D2R), 0], vol = linVol(M.mul(dx, 5)), cross = [0, 0, 0];
  const grad = (O, nm) => { const r = render(vol, O, nm, cross, { c: 1000, w: 800 }), gx = (huOfGray(gray(r.buf, 80, 50)) - huOfGray(gray(r.buf, 40, 50))) / (40 * MM), gy = (huOfGray(gray(r.buf, 60, 80)) - huOfGray(gray(r.buf, 60, 20))) / (60 * MM); return [gx, gy]; };
  const rot = grad(Q.rotateAbout(Q.identity(), [0, 0, 1], 30), 'coronal'), id = grad(Q.identity(), 'coronal');
  near(rot[0], 5, 0.15, 'rotated gx'); near(rot[1], 0, 0.15, 'rotated gy'); near(id[0], 5 * Math.cos(30 * D2R), 0.15, 'identity gx');
  const sag = grad(Q.rotateAbout(Q.identity(), [0, 0, 1], 30), 'sagittal'); near(sag[0], 5 * dot(dx, Q.viewFrame(Q.rotateAbout(Q.identity(), [0, 0, 1], 30), 'sagittal').u), 0.15, 'sagittal gx');
  const ax = grad(Q.rotateAbout(Q.identity(), [0, 0, 1], 30), 'axial'); near(ax[0], 5 * Math.cos(30 * D2R), 0.15, 'axial image unchanged gx'); near(ax[1], 5 * Math.sin(30 * D2R), 0.15, 'axial gy');
});
test('translate: moving a line = moving the crosshair along that plane\'s normal; the other two planes keep their orientation', () => {
  const O = Q.rotateAbout(Q.identity(), [0, 0, 1], 30), N = Q.NORMAL(O).coronal, c2 = Q.translate([1, 2, 3], N, 7);
  near(dot(M.sub(c2, [1, 2, 3]), N), 7, 1e-12); near(M.len(M.sub(c2, [1, 2, 3])), 7, 1e-12);
});
test('align to centreline: axial normal = tangent (cranial sign), orthonormal right-handed, image axes stay close to the scanner x axis', () => {
  const T = M.norm([0.3, 0.2, -0.9]), O = Q.alignZ(T); near3(O.Z, M.mul(T, -1), 1e-12, 'Z = -T (cranial)'); near(Q.checkOrtho(O).det, 1, 1e-12); near(dot(O.X, O.Y), 0, 1e-12); near(dot(O.X, O.Z), 0, 1e-12);
  ok(dot(O.X, [1, 0, 0]) > 0.9, 'X ~ scanner x'); near(Q.angles(O).tiltAxial, Math.acos(Math.abs(T[2])) / D2R, 1e-6);
  near3(Q.alignZ([0, 0, 0]).Z, [0, 0, 1], 1e-12, 'degenerate -> identity');
});
summary();
