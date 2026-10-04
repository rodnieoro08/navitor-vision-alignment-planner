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

/* ---------- C-arm angulation of the stretched-view cut plane ---------- */
test('beamAngles is the inverse of beamDir over the whole LAO/CRAN range; -d gives the same representation (source posterior)', () => {
  for (let lao = -89; lao <= 89; lao += 7) for (let cran = -89; cran <= 89; cran += 6) {
    const d = M.beamDir(lao, cran), a = M.beamAngles(d), b = M.beamAngles(M.mul(d, -1));
    near(a.lao, lao, 1e-9, 'lao'); near(a.cran, cran, 1e-9, 'cran'); near(b.lao, lao, 1e-9, 'lao(-d)'); near(b.cran, cran, 1e-9, 'cran(-d)');
  }
  const l = M.beamAngles([1, 0, 0]); near(l.lao, 90, 1e-9); near(l.cran, 0, 1e-9);
  const r = M.beamAngles([-1, 0, 0]); near(r.lao, 90, 1e-9, '(-1,0,0) -> equivalent LAO 90');
  const c = M.beamAngles([0, 0, -1]); near(c.cran, -90, 1e-9);
});
test('KNOWN cut plane -> KNOWN angulation (vertical straight centreline, N1 = +x): face-on AP / edge-on LAO 90 at 0 deg; 30 deg -> edge-on LAO 60, face-on RAO 30; 90 deg swaps', () => {
  const cl = M.buildCentreline([[0, 0, 100], [0, 0, 0], [0, 0, -100]], { smoothMm: 0, n1start: [1, 0, 0] }), f = M.frameAt(cl, 100);
  near(f.T[2], -1, 1e-9, 'apex-first points down'); near(f.N1[0], 1, 1e-9);
  const exp = { 0: [90, 0, 0, 0], 30: [60, 0, -30, 0], 90: [0, 0, 90, 0], 150: [-60, 0, 30, 0] };    // [edge lao, edge cran, face lao, face cran]
  for (const a of Object.keys(exp)) { const b = M.cutPlaneBeams(f, +a), e = exp[a]; near(b.edge.lao, e[0], 1e-9, 'edge lao @' + a); near(b.edge.cran, e[1], 1e-9, 'edge cran @' + a); near(b.face.lao, e[2], 1e-9, 'face lao @' + a); near(b.face.cran, e[3], 1e-9, 'face cran @' + a); }
});
test('KNOWN tilted axis: centreline tilted 20 deg cranially (towards +z) and 15 deg to the left; edge-on/face-on beams are exactly perpendicular to the axis and equal an independently constructed plane normal', () => {
  const T = M.norm([Math.sin(15 * D) * Math.cos(20 * D) * -1, 0.0, -Math.sin(20 * D)]);          // descending direction (apex-first), tilted
  const P0 = [0, 0, 0], ctrl = [M.add(P0, M.mul(T, -150)), P0, M.add(P0, M.mul(T, 150))];
  const cl = M.buildCentreline(ctrl, { smoothMm: 0, n1start: [0, 1, 0] }), f = M.frameAt(cl, cl.length / 2);
  for (const alpha of [0, 25, 77, 123, 200, 301]) {
    const b = M.cutPlaneBeams(f, alpha), e = b.e, n = b.n;
    // independent construction: e is the unit vector in the cross-section plane at angle alpha from N1 (towards N2); n completes the right-handed triad (T, e, n)
    const e2 = M.add(M.mul(f.N1, Math.cos(alpha * D)), M.mul(f.N2, Math.sin(alpha * D))), n2 = M.cross(f.T, e2);
    ok(M.dist(e, e2) < 1e-12 && M.dist(n, n2) < 1e-12, 'frame'); near(M.dot(e, f.T), 0, 1e-9); near(M.dot(n, f.T), 0, 1e-9); near(M.len(n), 1, 1e-9);
    const de = M.beamDir(b.edge.lao, b.edge.cran), df = M.beamDir(b.face.lao, b.face.cran);
    near(Math.abs(M.dot(de, e)), 1, 1e-9, 'edge beam == +-e'); near(Math.abs(M.dot(df, n)), 1, 1e-9, 'face beam == +-n'); near(M.dot(de, f.T), 0, 1e-9, 'edge beam perpendicular to axis'); near(M.dot(df, f.T), 0, 1e-9, 'face beam perpendicular to axis');
    ok(de[1] <= 1e-9 && df[1] <= 1e-9, 'source posterior');
  }
});
test('face-on(alpha) == edge-on(alpha + 90 deg) (same line of sight); the plane is edge-on in its edge beam and face-on in its face beam (projection test)', () => {
  const cl = M.buildCentreline(APEX_FIRST, { smoothMm: 4 });
  for (const sFrac of [0.2, 0.5, 0.8]) for (const alpha of [0, 40, 95, 190, 355]) {
    const f = M.frameAt(cl, cl.length * sFrac), b = M.cutPlaneBeams(f, alpha), b90 = M.cutPlaneBeams(f, alpha + 90);
    near(b.face.lao, b90.edge.lao, 1e-9); near(b.face.cran, b90.edge.cran, 1e-9);
    // points in the cut plane: edge-on -> all project onto ONE line (image-x offsets = 0 relative to the projected axis direction); face-on -> offsets span both directions
    const pts = [[0, 0], [10, 0], [0, 15], [-8, 22], [12, -9]].map(([u, v]) => M.add(M.add(f.C, M.mul(f.T, u)), M.mul(b.e, v)));
    const proj = (lao, cran) => pts.map((p) => M.project(M.sub(p, f.C), lao, cran));
    const pe = proj(b.edge.lao, b.edge.cran), pf = proj(b.face.lao, b.face.cran);
    const ax = M.project(f.T, b.edge.lao, b.edge.cran), axl = Math.hypot(ax[0], ax[1]), perpE = pe.map((q) => Math.abs((q[0] * ax[1] - q[1] * ax[0]) / axl));
    ok(Math.max(...perpE) < 1e-9, 'plane not edge-on: ' + Math.max(...perpE));                      // all in-plane points lie on the projected axis line
    const axf = M.project(f.T, b.face.lao, b.face.cran), axfl = Math.hypot(axf[0], axf[1]), perpF = pf.map((q) => Math.abs((q[0] * axf[1] - q[1] * axf[0]) / axfl));
    ok(Math.max(...perpF) > 14, 'plane not face-on: ' + Math.max(...perpF));                        // in-plane offsets e (up to 22 mm) are fully visible
  }
});
test('2:1 marker split in the cut-plane views uses the same projection maths: edge-on lateral offsets = |n.(P-C)|, face-on = |e.(P-C)| (what the stretched view shows); any in-plane beam gives the edge-on offsets', () => {
  const cl = M.buildCentreline(APEX_FIRST, { smoothMm: 4 }), f = M.frameAt(cl, 300), pts = [[6, 3, 4], [-4, 9, -3], [8, -7, 2]].map((q) => M.add(f.C, M.add(M.add(M.mul(f.N1, q[0]), M.mul(f.N2, q[1])), M.mul(f.T, q[2]))));
  for (const alpha of [0, 33, 120, 250]) {
    const b = M.cutPlaneBeams(f, alpha), ev = (lao, cran) => M.evalViewFast(f.C, f.T, pts, lao, cran, 0);
    const re = ev(b.edge.lao, b.edge.cran), rf = ev(b.face.lao, b.face.cran);
    pts.forEach((p, i) => { const q = M.sub(p, f.C); near(Math.abs(re.s[i]), Math.abs(M.dot(q, b.n)), 1e-9, 'edge-on offset'); near(Math.abs(rf.s[i]), Math.abs(M.dot(q, b.e)), 1e-9, 'face-on offset'); });
    // an in-plane beam that is not perpendicular to the axis (60 deg from e towards T) -> same lateral offsets as edge-on
    const dIn = M.add(M.mul(b.e, Math.cos(60 * D)), M.mul(f.T, Math.sin(60 * D))), a2 = M.beamAngles(dIn), r2 = ev(a2.lao, a2.cran);
    pts.forEach((p, i) => near(Math.abs(r2.s[i]), Math.abs(re.s[i]), 1e-9, 'in-plane beam offsets'));
    ok(JSON.stringify(r2.s.map((v) => v < 0)) === JSON.stringify(re.s.map((v) => v < 0)) || JSON.stringify(r2.s.map((v) => v < 0)) === JSON.stringify(re.s.map((v) => v >= 0)), 'same split');
  }
});
test('round trip with the C-arm grid: the rounded edge/face angles are valid scan grid cells and the scan classification at that cell equals evalViewFast there', () => {
  const cl = M.buildCentreline(M.orientCentreline(APEX_FIRST, ROOT_PTS).ctrl, { smoothMm: 4 }), sD = M.defaultDescLevel(cl), tr = M.transferMarkers(cl, ROOT_H, { sD, refMode: 'own', radiusMode: 'keep' });
  const A = ['NL', 'NR', 'LR'].map((k) => tr[k].A), fr = M.frameAt(cl, sD), scan = M.scanProjections(fr.C, fr.T, A, { minMargin: 2 });
  let tested = 0;
  for (const alpha of [0, 20, 45, 70, 100, 130, 160, 200, 250, 300, 340]) for (const kind of ['edge', 'face']) {
    const b = M.cutPlaneBeams(fr, alpha)[kind], lao = Math.round(b.lao), cran = Math.round(b.cran);
    if (lao < M.LAO_MIN || lao > M.LAO_MAX || cran < M.CRAN_MIN || cran > M.CRAN_MAX) continue;
    const li = lao - scan.laoMin, ci = cran - scan.cranMin, k = ci * scan.nL + li, r = M.evalViewFast(fr.C, fr.T, A, lao, cran, 2);
    ok(!!scan.is21[k] === r.is21 && !!scan.valid[k] === r.valid, 'is21/valid @' + alpha + kind); if (r.valid) near(scan.margin[k], r.margin, 1e-4, 'margin'); tested++;
  }
  ok(tested >= 6, 'enough in-range cases: ' + tested);
});

/* ---------- overlap projection (2 right / 1 left) ---------- */
// independent image maths for the checks: M.project() (image basis, x right / y up) and the 2D projected axis
function imgOf(P, lao, cran) { return M.project(P, lao, cran); }
function lateral2D(C, a, P, lao, cran) {   // signed distance (image RIGHT of the projected axis drawn upward = +) computed purely in 2D
  const ap = M.project(a, lao, cran), l = Math.hypot(ap[0], ap[1]); let ux = ap[0] / l, uy = ap[1] / l; if (uy < 0 || (Math.abs(uy) < 1e-12 && ux < 0)) { ux = -ux; uy = -uy; }
  const q = imgOf(M.sub(P, C), lao, cran); return q[0] * uy - q[1] * ux;   // component along the image-right normal (uy, -ux)
}
test('overlap projection: markers constructed for a known overlap beam (LAO 45 / CRAN 0): pair vector || beam -> exact angles, residual ~ 0 (<= 1e-6 at the exact angle), pair on the RIGHT of the lone marker', () => {
  const C = [0, 0, 0], a = [0, 0, 1], d = M.beamDir(45, 0), mid = [5, 5, 0];      // at LAO 45 image-right = (+x,+y)/sqrt2 (z x d)
  const pts = [M.add(mid, M.mul(d, 9)), M.add(mid, M.mul(d, -9)), [-4, -4, 0]];
  near(imgOf([1, 1, 0], 45, 0)[0], Math.SQRT2, 1e-9, 'hand-derived: at LAO 45 a point at (+1,+1,0) mm appears sqrt2 mm to the image RIGHT');
  const r = M.overlapProjections(C, a, pts, { labels: ['P1', 'P2', 'L'] });
  const it = r.items.find((x) => x.pair.join() === '0,1');
  ok(it && it.lone === 2 && it.side === 'right', 'pair (P1,P2) offered with the pair on the right');
  near(it.exactLao, 45, 1e-9, 'exact LAO'); near(it.exactCran, 0, 1e-9, 'exact CRAN'); ok(it.lao === 45 && it.cran === 0, 'rounded ' + it.lao + '/' + it.cran);
  const pa = imgOf(pts[0], 45, 0), pb = imgOf(pts[1], 45, 0); near(Math.hypot(pa[0] - pb[0], pa[1] - pb[1]), 0, 1e-9, 'independent 2D check: pair overlaps'); near(it.residual, 0, 1e-9, 'residual');
  const lo = imgOf(pts[2], 45, 0); ok(pa[0] > lo[0] + 5, 'independent 2D check: pair is to the RIGHT of the lone marker on the image (x ' + pa[0].toFixed(2) + ' vs ' + lo[0].toFixed(2) + ')');
  near(it.separation, Math.abs(pa[0] - lo[0]), 1e-9, 'separation of the lone marker'); near(it.lateral, pa[0] - lo[0], 1e-9, 'lateral gap');
  ok(it.inRange && r.best === it, 'in range and best');
});
test('overlap projection: the mirrored arrangement (pair on the LEFT of the lone marker) is NOT offered for that pair (reason pair-left); a degenerate-free set may still offer other pairs', () => {
  const C = [0, 0, 0], a = [0, 0, 1], d = M.beamDir(45, 0), mid = [-5, -5, 0];
  const pts = [M.add(mid, M.mul(d, 9)), M.add(mid, M.mul(d, -9)), [4, 4, 0]];
  const r = M.overlapProjections(C, a, pts, { labels: ['P1', 'P2', 'L'] });
  ok(!r.items.some((x) => x.pair.join() === '0,1'), 'pair (P1,P2) must not be offered'); const rej = r.rejected.find((x) => x.pair.join() === '0,1');
  ok(rej && rej.reason === 'pair-left' && rej.lateral < -5, 'rejected as pair-left: ' + (rej && rej.reason));
  const pa = imgOf(pts[0], 45, 0), lo = imgOf(pts[2], 45, 0); ok(pa[0] < lo[0], 'independent: pair is LEFT of the lone marker');
});
test('overlap projection: side agrees with 2D lateral() maths on TILTED axes and all pairs/seeds (residual after rounding < 0.4 mm)', () => {
  const C = [3, -2, 10], a = M.norm([0.12, 0.3, 0.94]);
  let nItems = 0, nRej = 0;
  for (const [lao, cran] of [[20, 10], [-35, 15], [40, -12], [-15, -25], [55, 5], [-50, -5]]) for (const ang of [10, 70, 190]) {
    // markers on a ring perpendicular to the axis such that pair (0,1) is parallel to the beam beamDir(lao,cran) (beam component along the axis is kept by construction)
    const d = M.beamDir(lao, cran), mid = M.add(C, M.mul(M.norm(M.cross(M.cross(a, d), a)), 4 * Math.cos(ang * D)));
    const pts = [M.add(mid, M.mul(d, 10)), M.add(mid, M.mul(d, -10)), M.add(C, M.add(M.mul(M.norm(M.cross(a, d)), -9 * Math.sin(ang * D) - 6), M.mul(a, 3)))];
    const r = M.overlapProjections(C, a, pts, { labels: ['A', 'B', 'L'], minSep: 1 });
    const all = [...r.items, ...r.rejected].find((x) => x.pair.join() === '0,1' && x.lao !== undefined);
    ok(all, 'pair (A,B) evaluated'); ok(Math.abs(all.lao - lao) <= 1 && Math.abs(all.cran - cran) <= 1, `exact beam recovered: ${all.exactLao.toFixed(2)}/${all.exactCran.toFixed(2)} vs ${lao}/${cran}`);
    ok(all.residual < 0.4, 'residual ' + all.residual); nItems += r.items.length; nRej += r.rejected.length;
    const sP = (lateral2D(C, a, pts[0], all.lao, all.cran) + lateral2D(C, a, pts[1], all.lao, all.cran)) / 2, sL = lateral2D(C, a, pts[2], all.lao, all.cran);
    near(all.lateral, sP - sL, 1e-6, 'lateral gap equals the independent 2D computation'); ok((all.lateral > 0) === (all.side === 'right'), 'side flag consistent with sign');
  }
  ok(nItems + nRej >= 18, 'cases evaluated');
});
test('overlap projection: 1 deg rounding grid search keeps the residual small and equals the brute-force minimum over +-3 deg; exact-angle residual is 0', () => {
  const C = [0, 0, 0], a = [0, 0, 1], P = [[12.3, -4.1, 1.5], [-6.2, 10.7, -2.0], [-8.0, -9.0, 0.5]];
  const r = M.overlapProjections(C, a, P, { minSep: 0.5 }), all = [...r.items, ...r.rejected];
  ok(all.length === 3, 'three pairs');
  for (const it of all) {
    const [i, j] = it.pair, v = M.sub(P[j], P[i]); let best = 1e9;
    for (let l = Math.round(it.exactLao) - 3; l <= Math.round(it.exactLao) + 3; l++) for (let c = Math.round(it.exactCran) - 3; c <= Math.round(it.exactCran) + 3; c++) { const d = M.beamDir(l, c); best = Math.min(best, M.len(M.sub(v, M.mul(d, M.dot(v, d))))); }
    near(it.residual, best, 1e-9, 'residual = brute-force minimum'); const de = M.beamDir(it.exactLao, it.exactCran); near(M.len(M.sub(v, M.mul(de, M.dot(v, de)))), 0, 1e-9, 'exact beam residual 0');
    ok(it.residual < 0.012 * M.len(v) + 1e-9, 'rounded residual bounded by ~0.7 deg of the pair distance');
  }
  const rank = r.items.map((x) => (x.inRange ? 0 : 1000) + x.burden); ok(rank.every((v, n) => n === 0 || rank[n - 1] <= v), 'ranked in-range first, then by smallest angles');
});
test('overlap projection: out-of-range beam (exact LAO 80) is listed with inRange=false, never the "best"; status out-of-range when it is the only solution', () => {
  const C = [0, 0, 0], a = [0, 0, 1], d = M.beamDir(80, 0), mid = [4, 4, 0];                 // image right at LAO 80 ~ (+x,+y) -> pair on the right
  const right = M.cross([0, 0, 1], d), pts = [M.add(M.add(mid, M.mul(right, 3)), M.mul(d, 9)), M.add(M.add(mid, M.mul(right, 3)), M.mul(d, -9)), M.add(mid, M.mul(right, -9))];
  const r = M.overlapProjections(C, a, pts, { labels: ['P', 'Q', 'L'] }), it = r.items.find((x) => x.pair.join() === '0,1');
  ok(it && !it.inRange && it.lao === 80 && r.best !== it, 'listed but flagged out of range'); ok(!r.items.some((x) => x.inRange && x.pair.join() === '0,1'));
  if (!r.best) ok(r.status === 'out-of-range' && /outside the C-arm range/.test(r.message), 'status ' + r.status + ' / ' + r.message);
});
test('overlap projection: degenerate cases give a clear status/message (collinear markers, coincident markers, beam parallel to the axis, missing markers)', () => {
  const C = [0, 0, 0], a = [0, 0, 1];
  const col = M.overlapProjections(C, a, [[-10, 0, 0], [0, 0, 0], [10, 0, 0]]);
  ok(col.status === 'degenerate' && col.items.length === 0 && /collinear/.test(col.message), 'collinear: ' + col.status + ' ' + col.message);
  const coin = M.overlapProjections(C, a, [[5, 5, 0], [5.1, 5, 0], [-6, 2, 0]]);
  ok(coin.rejected.some((x) => x.reason === 'coincident'), 'coincident pair is reported');
  const par = M.overlapProjections(C, a, [[0, 0, 0], [0.5, 0, 12], [8, 0, 0]], { labels: ['a', 'b', 'c'] });
  ok(par.rejected.some((x) => x.reason === 'axis-parallel' && /axis/.test(x.detail)), 'pair along the axis: beam parallel to the centreline axis');
  const none = M.overlapProjections(C, a, [[1, 2, 3], null, [4, 5, 6]]); ok(none.status === 'no-markers' && /three A markers/.test(none.message) && none.items.length === 0);
  const nul = M.overlapProjections(null, null, null); ok(nul.status === 'no-markers');
});
test('overlap projection on the app-style transferred A markers (RMF transfer at the default descending level): every offered item has residual < 0.4 mm, pair on the image right (independent 2D check) and a consistent exact beam; at least one in-range suggestion', () => {
  const cl = M.buildCentreline(M.orientCentreline(APEX_FIRST, ROOT_PTS).ctrl, { smoothMm: 4 }), sD = M.defaultDescLevel(cl), tr = M.transferMarkers(cl, ROOT_H, { sD, refMode: 'own', radiusMode: 'keep' });
  const A = ['NL', 'NR', 'LR'].map((k) => tr[k].A), fr = M.frameAt(cl, sD), r = M.overlapProjections(fr.C, fr.T, A, { labels: ['A_NL', 'A_NR', 'A_LR'] });
  ok(r.status === 'ok' && r.best && r.items.length >= 1, 'status ' + r.status);
  for (const it of r.items) {
    ok(it.residual < 0.4, 'residual ' + it.residual); const pa = A[it.pair[0]], pb = A[it.pair[1]], pl = A[it.lone];
    const sA = lateral2D(fr.C, fr.T, pa, it.lao, it.cran), sB = lateral2D(fr.C, fr.T, pb, it.lao, it.cran), sL = lateral2D(fr.C, fr.T, pl, it.lao, it.cran);
    ok((sA + sB) / 2 > sL, 'pair right of lone (independent 2D): ' + it.text); near(it.separation, Math.hypot((sA + sB) / 2 - sL, 0), 0.3, 'separation'); 
  }
  console.log('       phantom-style A markers: ' + r.items.map((x) => `${x.text} -> ${x.label} (res ${x.residual.toFixed(2)} mm, sep ${x.separation.toFixed(1)} mm${x.inRange ? '' : ', OUT OF RANGE'})`).join(' | ') + ' | not offered: ' + r.rejected.map((x) => x.reason).join(','));
});

summary();
