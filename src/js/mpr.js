/* NavMPR: double-oblique MPR orientation (three mutually orthogonal planes through the crosshair), pure maths (no DOM), patient (LPS, mm) coordinates.
 * Orientation O = {X, Y, Z}: orthonormal, right-handed (X x Y = Z) world vectors; identity = scanner axes (X = +x patient left, Y = +y posterior, Z = +z superior).
 * Plane normals: axial = Z, coronal = Y, sagittal = -X (so that for O = identity the views equal the classic axial / coronal / sagittal of earlier versions).
 * Each view has fixed *screen* axes (u right, v down) = the canonical patient axes projected into its plane, so its image does not rotate when the user rotates about its own normal;
 * the crosshair lines (= traces of the other two planes) tilt on screen instead (3mensio style). v = n x u, u x v = n. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NavMPR = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2], cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]], sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]], mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const len = (a) => Math.hypot(a[0], a[1], a[2]), norm = (a) => { const l = len(a); return l > 1e-12 ? mul(a, 1 / l) : [0, 0, 0]; };
  const D2R = Math.PI / 180, R2D = 180 / Math.PI;
  const EX = [1, 0, 0], EY = [0, 1, 0], EZ = [0, 0, 1];
  const NAMES = ['axial', 'coronal', 'sagittal'];

  function identity() { return { X: [1, 0, 0], Y: [0, 1, 0], Z: [0, 0, 1] }; }
  function clone(O) { return { X: O.X.slice(), Y: O.Y.slice(), Z: O.Z.slice() }; }
  function isIdentity(O, tolDeg) { const t = Math.cos((tolDeg == null ? 0.01 : tolDeg) * D2R); return dot(O.X, EX) > t && dot(O.Y, EY) > t && dot(O.Z, EZ) > t; }
  function orthonormalise(O) {                      // Gram-Schmidt keeping Z's direction priority loosely: X first, then Y, Z = X x Y (right-handed)
    const X = norm(O.X), Y = norm(sub(O.Y, mul(X, dot(O.Y, X)))); return { X, Y, Z: cross(X, Y) };
  }
  function rotVec(v, k, ang) {                      // Rodrigues, unit axis k
    const c = Math.cos(ang), s = Math.sin(ang), kv = cross(k, v), kd = dot(k, v);
    return [v[0] * c + kv[0] * s + k[0] * kd * (1 - c), v[1] * c + kv[1] * s + k[1] * kd * (1 - c), v[2] * c + kv[2] * s + k[2] * kd * (1 - c)];
  }
  /* rotate the whole orientation (all three planes) about a world axis through the crosshair by `deg` */
  function rotateAbout(O, axis, deg) { const k = norm(axis), a = deg * D2R; return orthonormalise({ X: rotVec(O.X, k, a), Y: rotVec(O.Y, k, a), Z: rotVec(O.Z, k, a) }); }

  const NORMAL = (O) => ({ axial: O.Z, coronal: O.Y, sagittal: mul(O.X, -1) });
  const REFS = { axial: [EX, EY], coronal: [EX, EZ], sagittal: [EY, EZ] };         // preferred / fallback in-plane "screen right" reference (canonical patient axes)
  /* frame of one view: {u, v, n} screen-right, screen-down, normal (u x v = n) */
  function viewFrame(O, name) {
    const n = NORMAL(O)[name], refs = REFS[name]; let u = null;
    for (const r of refs) { const p = sub(r, mul(n, dot(r, n))); if (len(p) > 0.25) { u = norm(p); break; } }
    if (!u) u = norm(cross(n, EX)) ;
    return { u, v: cross(n, u), n };
  }
  /* the other two planes as lines in a view: for each other plane (normal N) the trace direction is n x N (unit, in the view plane); screen angle in degrees, 0 = screen right, clockwise positive (y down) */
  function viewLines(O, name) {
    const f = viewFrame(O, name), N = NORMAL(O), others = NAMES.filter((k) => k !== name), out = [];
    for (const k of others) { const d = norm(cross(f.n, N[k])), sx = dot(d, f.u), sy = dot(d, f.v);
      out.push({ plane: k, dir: d, normal: N[k], screen: [sx, sy], angle: Math.atan2(sy, sx) * R2D }); }
    return out;
  }
  /* readable angles: rotation of the crosshair line pair in each view relative to the screen axes (deg, wrapped to (-90,90], clockwise on screen positive) and tilt of the axial normal from the scanner z axis */
  function wrap45(a) { a = ((a % 180) + 180) % 180; return a > 90 ? a - 180 : a; }
  function angles(O) {
    const out = { rot: {}, tiltAxial: Math.acos(Math.min(1, Math.max(-1, dot(O.Z, EZ)))) * R2D };
    for (const nm of NAMES) { const ls = viewLines(O, nm); out.rot[nm] = wrap45(ls[0].angle); }
    return out;
  }
  /* orientation whose axial normal is `dir` (e.g. the centreline tangent): Z = dir (sign chosen cranial), X = projected scanner x axis, Y = Z x X */
  function alignZ(dir) {
    let Z = norm(dir); if (len(Z) < 0.5) return identity(); if (Z[2] < 0) Z = mul(Z, -1);
    let X = sub(EX, mul(Z, dot(EX, Z))); X = len(X) > 0.2 ? norm(X) : norm(sub(EY, mul(Z, dot(EY, Z))));
    return { X, Y: cross(Z, X), Z };
  }
  /* in-plane step along a line translation: moving the plane with normal N by s mm = moving the crosshair by s * N */
  function translate(cross0, N, s) { return add(cross0, mul(N, s)); }
  function checkOrtho(O) { return { dxy: dot(O.X, O.Y), dxz: dot(O.X, O.Z), dyz: dot(O.Y, O.Z), nx: len(O.X), ny: len(O.Y), nz: len(O.Z), det: dot(cross(O.X, O.Y), O.Z) }; }

  return { identity, clone, isIdentity, rotateAbout, orthonormalise, viewFrame, viewLines, angles, alignZ, translate, checkOrtho, NORMAL, NAMES };
});
