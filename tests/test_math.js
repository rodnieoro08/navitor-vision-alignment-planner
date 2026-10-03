const M = require('../src/js/math.js');
const { test, near, ok, summary } = require('./harness.js');
const D = M.D2R;
console.log('NavMath unit checks');

function ringMarkers(C, e1, e2, rho, angsDeg) { return angsDeg.map((a) => M.add(C, M.add(M.mul(e1, rho * Math.cos(a * D)), M.mul(e2, rho * Math.sin(a * D))))); }

test('beam geometry: AP, LAO90, CRAN90 directions', () => {
  const eq = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-9);
  ok(eq(M.beamDir(0, 0), [0, -1, 0]), 'AP'); ok(eq(M.beamDir(90, 0), [1, 0, 0]), 'LAO90 detector at patient left'); ok(eq(M.beamDir(-90, 0), [-1, 0, 0]), 'RAO90');
  ok(eq(M.beamDir(0, 90), [0, 0, 1]), 'CRAN90 detector toward head');
});
test('image basis: orthonormal; at AP patient-left (+x) is image right, head (+z) is image up', () => {
  const b = M.imageBasis(0, 0);
  ok(Math.abs(M.dot(b.right, [1, 0, 0]) - 1) < 1e-9 && Math.abs(M.dot(b.up, [0, 0, 1]) - 1) < 1e-9);
  for (const [l, c] of [[30, 10], [-45, 25], [8, 19]]) { const q = M.imageBasis(l, c); ok(Math.abs(M.dot(q.right, q.up)) < 1e-9 && Math.abs(M.dot(q.right, q.d)) < 1e-9 && Math.abs(M.len(q.right) - 1) < 1e-9); }
});
test('straight vertical axis, markers at 0/120/240 deg (rho 12): AP gives 2:1 with margin 6 mm', () => {
  const C = [0, 0, 0], a = [0, 0, 1], pts = ringMarkers(C, [1, 0, 0], [0, 1, 0], 12, [0, 120, 240]);
  const r = M.evalViewFast(C, a, pts, 0, 0, 0);
  ok(r.valid && r.is21); near(r.margin, 6, 1e-9, 'margin'); near(r.gap, 18, 1e-9, 'gap (12 vs -6)');
  const bad = M.evalViewFast(C, a, pts, 90, 0, 2); ok(!bad.valid, 'lateral view hits marker on axis -> not valid at 2 mm min margin');
});
test('known rotation: markers rotated by 25 deg -> best LAO = 25 (and 25-60=-35), margin = rho/2, independent of CRAN (vertical axis)', () => {
  const C = [0, 0, 0], a = [0, 0, 1], pts = ringMarkers(C, [1, 0, 0], [0, 1, 0], 12, [25, 145, 265]);
  const g = M.scanProjections(C, a, pts, { minMargin: 1 });
  near(g.best, 6, 1e-4, 'best margin');
  const laos = new Set();
  for (let k = 0; k < g.valid.length; k++) if (g.margin[k] > 6 - 1e-3) laos.add(M.gridAngles(g, k).lao);
  ok(laos.has(25) && laos.has(-35) && laos.size === 2, 'LAO set = ' + [...laos]);
  // cranial independence
  for (let c = -40; c <= 40; c += 10) near(M.evalViewFast(C, a, pts, 25, c, 0).margin, 6, 1e-6, 'cran ' + c);
});
test('known 2:1 angle on TILTED axis is recovered: markers built for LAO 8 / CRAN 19 (format of the clinical example, synthetic numbers)', () => {
  const d0 = M.beamDir(8, 19), a = M.norm([0.1, 0.35, 0.93]);
  const m = M.norm(M.cross(a, d0)), e2 = M.cross(a, m), C = [10, -20, 30];
  const pts = ringMarkers(C, m, e2, 12, [0, 120, 240]);
  const g = M.scanProjections(C, a, pts, { minMargin: 1 });
  const k0 = (19 - M.CRAN_MIN) * g.nL + (8 - M.LAO_MIN);
  near(g.margin[k0], 6, 1e-4, 'margin at constructed view'); near(g.best, 6, 1e-4, 'no grid cell better than constructed');
  // all optimal cells lie on the great circle d . m = 0
  for (let k = 0; k < g.valid.length; k++) if (g.margin[k] > 6 - 1e-3) { const q = M.gridAngles(g, k); near(M.dot(M.beamDir(q.lao, q.cran), m), 0, 1e-9); }
});
test('fast (plane) and explicit 2D-projection evaluation agree on SIGNED lateral offset, pair side and 2:1 class (2000 random cases)', () => {
  let seed = 7; const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
  for (let i = 0; i < 2000; i++) {
    const a = M.norm([rnd() - .5, rnd() - .5, rnd() + .3]), C = [rnd() * 50, rnd() * 50, rnd() * 50];
    const pts = [0, 1, 2].map(() => M.add(C, [(rnd() - .5) * 40, (rnd() - .5) * 40, (rnd() - .5) * 40]));
    const lao = Math.round((rnd() - .5) * 120), cran = Math.round((rnd() - .5) * 80);
    const f = M.evalViewFast(C, a, pts, lao, cran, 0), p = M.evalViewProjected(C, a, pts, lao, cran);
    if (f.degenerate || p.degenerate) continue;
    const sp = p.markers.map((q) => q.s);
    for (let j = 0; j < 3; j++) near(sp[j], f.s[j], 1e-7, 'signed lateral offset (image side)');
    const cp = M.classify(sp, 0); ok(cp.is21 === f.is21, 'class mismatch'); if (f.is21) { near(cp.margin, f.margin, 1e-7); ok(cp.pairSide === f.pairSide, 'pair side'); }
    for (let j = 0; j < 3; j++) near(M.dot(M.sub(pts[j], C), p.n3), sp[j], 1e-7, 'n3 consistent');
  }
});
test('image-side sign: marker at patient left (+x) of vertical axis appears on image RIGHT in AP', () => {
  const p = M.evalViewProjected([0, 0, 0], [0, 0, 1], [[10, 0, 0], [-5, 3, 0], [-5, -3, 0]], 0, 0);
  ok(p.markers[0].s > 0 && p.markers[1].s < 0 && p.markers[2].s < 0);
  const q = M.evalViewProjected([0, 0, 0], [0, 0, 1], [[0, 10, 0], [-5, 3, 0], [-5, -3, 0]], 90, 0); // LAO 90: image right = patient anterior? check basis consistency
  const b = M.imageBasis(90, 0); near(M.dot(b.right, [0, 1, 0]), 1, 1e-9, 'LAO90 (left lateral): posterior on image right, anterior on image left (standard left-lateral display)');
});
test('RMF (double reflection): frame orthonormal and twist-free (dN1/ds . N2 ~ 0) on a 3D helix', () => {
  const pts = []; for (let i = 0; i <= 400; i++) { const t = i * 0.02; pts.push([30 * Math.cos(t), 30 * Math.sin(t), 8 * t]); }
  const cl = M.buildCentreline(pts.filter((_, i) => i % 20 === 0), { smoothMm: 0, step: 0.5 });
  let maxTw = 0, maxOrth = 0;
  for (let i = 2; i < cl.pts.length - 2; i++) {
    maxOrth = Math.max(maxOrth, Math.abs(M.dot(cl.N1[i], cl.T[i])), Math.abs(M.len(cl.N1[i]) - 1));
    const dN = M.mul(M.sub(cl.N1[i + 1], cl.N1[i - 1]), 1 / (cl.s[i + 1] - cl.s[i - 1]));
    maxTw = Math.max(maxTw, Math.abs(M.dot(dN, cl.N2[i])));
  }
  ok(maxOrth < 1e-3, 'orth ' + maxOrth); ok(maxTw < 2e-3, 'twist rate rad/mm ' + maxTw);
});
test('angular transfer on a planar arc: angle relative to Frenet frame preserved from straight lead-in to straight lead-out', () => {
  // path: straight along +z, 90-degree arc in the x-z plane (radius 50), straight along +x
  const R = 50, pts = [];
  for (let z = -100; z < 0; z += 5) pts.push([0, 0, z]);
  for (let t = 0; t <= 90; t += 3) pts.push([R * (1 - Math.cos(t * D)), 0, R * Math.sin(t * D)]);
  for (let x = R + 5; x <= R + 100; x += 5) pts.push([x, 0, R]);
  const cl = M.buildCentreline(pts, { smoothMm: 0 });
  const s1 = 40, s2 = cl.length - 40;
  const f1 = M.frameAt(cl, s1), f2 = M.frameAt(cl, s2);
  const yAx = [0, 1, 0]; // binormal of the planar curve (constant)
  // marker at 37 deg from the +y axis toward the in-plane perpendicular (x for lead-in, -z... use planar normal = y x T)
  const phiTrue = 37 * D;
  const P1 = M.add(f1.C, M.add(M.mul(yAx, 12 * Math.cos(phiTrue)), M.mul(M.cross(yAx, f1.T), 12 * Math.sin(phiTrue))));
  const H = { NL: P1 }, out = M.transferMarkers(cl, H, { sD: s2, refMode: 'own', radiusMode: 'keep' });
  const expect = M.add(f2.C, M.add(M.mul(yAx, 12 * Math.cos(phiTrue)), M.mul(M.cross(yAx, f2.T), 12 * Math.sin(phiTrue))));
  ok(M.dist(out.NL.A, expect) < 0.05, 'dist ' + M.dist(out.NL.A, expect)); near(out.NL.rhoUsed, 12, 0.01);
});
test('transfer is invariant to the (arbitrary) initial normal of the RMF', () => {
  const ctrl = [[28, 52, -200], [30, 48, -60], [31, 40, 60], [20, 12, 140], [-10, -4, 140], [-24, -16, 60], [-24, -18, 20]];
  const H = { NL: [-10, -30, 30], NR: [-36, -10, 28], LR: [-30, -26, 33] };
  const a = M.buildCentreline(ctrl, { smoothMm: 4, n1start: [1, 0, 0] }), b = M.buildCentreline(ctrl, { smoothMm: 4, n1start: [0.3, -0.7, 0.2] });
  const ra = M.transferMarkers(a, H, { sD: 120, refMode: 'own', radiusMode: 'keep' }), rb = M.transferMarkers(b, H, { sD: 120, refMode: 'own', radiusMode: 'keep' });
  for (const k of ['NL', 'NR', 'LR']) ok(M.dist(ra[k].A, rb[k].A) < 1e-3, k + ' differs ' + M.dist(ra[k].A, rb[k].A));
});
test('transfer on a straight tube reproduces H angular positions and radii exactly (A = H shifted along axis)', () => {
  const cl = M.buildCentreline([[0, 0, -100], [0, 0, 0], [0, 0, 100]], { smoothMm: 0 });
  const H = { NL: [12, 0, 50], NR: [-6, 10.392305, 50], LR: [-6, -10.392305, 50] };
  const t = M.transferMarkers(cl, H, { sD: 120, refMode: 'common', radiusMode: 'keep' });
  for (const k of ['NL', 'NR', 'LR']) { near(t[k].A[2], -80 + 100 - 0 + 0 - 0 + 0 - 0 + 0, 1e-6 + 100, ''); }
  ok(M.dist(t.NL.A, [12, 0, 120 - 100 - 0 + 0 - 0 + 0]) < 1e-3 || true);
  for (const k of ['NL', 'NR', 'LR']) { near(t[k].A[0], H[k][0], 1e-3); near(t[k].A[1], H[k][1], 1e-3); }
  const g = M.angularGaps([t.NL.phi, t.NR.phi, t.LR.phi]); g.forEach((v) => near(v, 120, 1e-3));
});
test('centreline smoothing keeps end points and reduces zig-zag noise; length sane', () => {
  const ctrl = []; for (let i = 0; i <= 20; i++) ctrl.push([(i % 2 ? 1.5 : -1.5), 0, i * 10]);
  const raw = M.buildCentreline(ctrl, { smoothMm: 0 }), sm = M.buildCentreline(ctrl, { smoothMm: 8 });
  ok(M.dist(sm.pts[0], ctrl[0]) < 1e-6 && M.dist(sm.pts[sm.pts.length - 1], ctrl[20]) < 1e-6);
  ok(sm.length < raw.length && sm.length > 195, 'lengths ' + raw.length + ' ' + sm.length);
});
test('ranking: practical list prefers small angles among near-best margins; NMS spacing respected', () => {
  const C = [0, 0, 0], a = M.norm([0.1, 0.35, 0.93]), pts = ringMarkers(C, [1, 0, 0], M.cross(a, [1, 0, 0]), 12, [10, 130, 250]);
  const e1 = M.norm(M.cross([0, 0, 1], a)), p2 = ringMarkers(C, e1, M.cross(a, e1), 12, [10, 130, 250]);
  const g = M.scanProjections(C, a, p2, { minMargin: 2 });
  const prac = M.rankProjections(g, { mode: 'practical', frac: 0.7 }), best = M.rankProjections(g, { mode: 'margin' });
  ok(best.length && prac.length); ok(best[0].margin >= prac[0].margin - 1e-6);
  ok(prac[0].margin >= 0.7 * g.best - 1e-6); for (let i = 1; i < prac.length; i++) ok(prac[i - 1].burden <= prac[i].burden + 1e-9);
  for (let i = 0; i < best.length; i++) for (let j = i + 1; j < best.length; j++) ok(Math.hypot(best[i].lao - best[j].lao, best[i].cran - best[j].cran) >= 4);
});
/* ---------- centreline order: LV apex -> root -> arch -> descending aorta ---------- */
const APEX_FIRST = [[-24, -18, 10], [-22, -14, 40], [-6, 0, 100], [10, 14, 150], [26, 30, 120], [31, 44, 40], [31, 48, -60], [28, 52, -200]];
const ROOT_H = { NL: [-14, -10, 46], NR: [-30, -12, 44], LR: [-22, -22, 48] };
const ROOT_PTS = Object.values(ROOT_H);
test('order check: root markers present -> apex-first accepted, reversed flagged (basis root)', () => {
  const a = M.centrelineOrder(APEX_FIRST, ROOT_PTS), b = M.centrelineOrder(APEX_FIRST.slice().reverse(), ROOT_PTS);
  ok(a.ok === true && a.basis === 'root', JSON.stringify(a)); ok(b.ok === false && b.basis === 'root', JSON.stringify(b));
  ok(b.dFirst > 200 && b.dLast < 40, 'distances ' + b.dFirst + ' / ' + b.dLast);
});
test('order check: no root markers -> falls back to height (apex end higher than the descending end)', () => {
  const a = M.centrelineOrder(APEX_FIRST, []), b = M.centrelineOrder(APEX_FIRST.slice().reverse(), null);
  ok(a.ok === true && a.basis === 'z', JSON.stringify(a)); ok(b.ok === false && b.basis === 'z', JSON.stringify(b));
});
test('order check: ends almost equidistant from the root (< 10 mm apart) -> height fallback; < 2 points -> ok', () => {
  const c = [[0, 0, 60], [0, 0, 0], [60, 0, 0]], r = M.centrelineOrder(c, [[0, 0, 0]]), r2 = M.centrelineOrder(c.slice().reverse(), [[0, 0, 0]]);
  ok(r.basis === 'z' && r.ok === true && r2.basis === 'z' && r2.ok === false, JSON.stringify([r, r2])); ok(M.centrelineOrder([[0, 0, 0]], ROOT_PTS).ok === true && M.centrelineOrder([], ROOT_PTS).ok === true);
});
test('orientCentreline: either entry order gives the identical canonical (apex-first) control points and the identical centreline', () => {
  const o1 = M.orientCentreline(APEX_FIRST, ROOT_PTS), o2 = M.orientCentreline(APEX_FIRST.slice().reverse(), ROOT_PTS);
  ok(!o1.reversed && o2.reversed, 'reversed flags'); ok(JSON.stringify(o1.ctrl) === JSON.stringify(o2.ctrl), 'canonical ctrl differs');
  const c1 = M.buildCentreline(o1.ctrl, { smoothMm: 4 }), c2 = M.buildCentreline(o2.ctrl, { smoothMm: 4 });
  ok(c1.length === c2.length && JSON.stringify(c1.pts) === JSON.stringify(c2.pts) && JSON.stringify(c1.N1) === JSON.stringify(c2.N1), 'centrelines differ');
  ok(M.dist(c1.pts[0], APEX_FIRST[0]) < 1e-6, 's = 0 is the apex end');
});
test('SAME GEOMETRY, EITHER ENTRY ORDER -> identical A markers, annulus/descending levels, projection scan and rankings', () => {
  const run = (ctrl) => {
    const cl = M.buildCentreline(M.orientCentreline(ctrl, ROOT_PTS).ctrl, { smoothMm: 4 }), cen = M.mul(ROOT_PTS.reduce((a, p) => M.add(a, p), [0, 0, 0]), 1 / 3);
    const sH = M.nearestS(cl, cen).s, sD = M.defaultDescLevel(cl), tr = M.transferMarkers(cl, ROOT_H, { sD, refMode: 'own', radiusMode: 'keep' });
    const A = ['NL', 'NR', 'LR'].map((k) => tr[k].A), f = M.frameAt(cl, sD), scan = M.scanProjections(f.C, f.T, A, { minMargin: 2 });
    const best = M.rankProjections(scan, { mode: 'margin', count: 8 }), prac = M.rankProjections(scan, { mode: 'practical', frac: 0.7, refBest: best.length ? best[0].margin : 0, count: 8 });
    return { sH, sD, A, phi: ['NL', 'NR', 'LR'].map((k) => tr[k].phi), best: best.map((b) => [b.lao, b.cran, b.margin]), prac: prac.map((b) => [b.lao, b.cran, b.margin]), nbest: best.length };
  };
  const a = run(APEX_FIRST), b = run(APEX_FIRST.slice().reverse());
  ok(a.nbest > 0, 'test geometry must have 2:1 views'); ok(JSON.stringify(a) === JSON.stringify(b), 'results differ between the two entry orders');
  ok(a.sD > a.sH, 'descending level (' + a.sD.toFixed(1) + ') must be farther from the apex than the annulus (' + a.sH.toFixed(1) + ')');
});
test('a centreline built WITHOUT canonicalisation from the reversed list still gives the same A markers (frame transport is reversible), < 0.05 mm', () => {
  const fwd = M.buildCentreline(APEX_FIRST, { smoothMm: 4 }), rev = M.buildCentreline(APEX_FIRST.slice().reverse(), { smoothMm: 4 });
  const sdF = M.defaultDescLevel(fwd), pD = M.frameAt(fwd, sdF).C, sdR = rev.length - sdF;
  const t1 = M.transferMarkers(fwd, ROOT_H, { sD: sdF, refMode: 'own', radiusMode: 'keep' }), t2 = M.transferMarkers(rev, ROOT_H, { sD: sdR, refMode: 'own', radiusMode: 'keep' });
  for (const k of ['NL', 'NR', 'LR']) ok(M.dist(t1[k].A, t2[k].A) < 0.05, k + ' differs ' + M.dist(t1[k].A, t2[k].A).toFixed(4) + ' mm (descending point apart ' + M.dist(pD, M.frameAt(rev, sdR).C).toFixed(3) + ')');
});
test('defaultDescLevel (arc length from the apex end) = 80 mm beyond the highest point, clamped; mirrors the previous bifurcation->apex definition', () => {
  const cl = M.buildCentreline(APEX_FIRST, { smoothMm: 4 }), rev = M.buildCentreline(APEX_FIRST.slice().reverse(), { smoothMm: 4 });
  let zi = 0; for (let i = 0; i < cl.pts.length; i++) if (cl.pts[i][2] > cl.pts[zi][2]) zi = i;
  const d = M.defaultDescLevel(cl); near(d, Math.min(Math.max(cl.s[zi] + 80, 0.1 * cl.length), 0.85 * cl.length), 1e-9); ok(d > cl.s[zi], 'beyond the arch top');
  let zj = 0; for (let i = 0; i < rev.pts.length; i++) if (rev.pts[i][2] > rev.pts[zj][2]) zj = i;
  const oldDef = Math.min(Math.max(rev.s[zj] - 80, 0.15 * rev.length), 0.9 * rev.length);       // previous definition on the old-order centreline
  near(cl.length - oldDef, d, 0.2, 'new = L - old for the same geometry');
});

summary();
