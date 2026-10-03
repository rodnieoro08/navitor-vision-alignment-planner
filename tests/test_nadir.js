// Auto-detect nadirs: synthetic aortic-root phantoms (3 bulging sinuses, known nadirs, noise, coronary stubs, adjacent left atrium) + failure modes.
const P = require('../src/js/phantom.js'), V = require('../src/js/volume.js'), N = require('../src/js/nadir.js'), M = require('../src/js/math.js');
const { test, ok, summary } = require('./harness.js');
console.log('Nadir auto-detection checks (synthetic phantoms only - NOT validated on real CT)');
const KEYS = ['NCC', 'LCC', 'RCC'], dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const table = [], htable = [];
function run(name, opts, seedFn) {
  const g = P.generateRoot(opts), vol = new V.Volume(g.volume), seed = seedFn ? seedFn(g.truth) : g.truth.seed, res = N.detect(vol, seed, {});
  return { name, g, vol, res, seed };
}
function errors(r) { const e = {}; for (const k of KEYS) e[k] = dist(r.res.nadirs[k], r.g.truth.nadir[k]); e.mean = (e.NCC + e.LCC + e.RCC) / 3; e.max = Math.max(e.NCC, e.LCC, e.RCC); return e; }
// handedness independent of the detector: seen from the aorta looking toward the LV, RCC -> LCC -> NCC must be counter-clockwise = right-handed about the flow axis
function handed(n, a) { const c = M.cross(M.sub(n.LCC, n.RCC), M.sub(n.NCC, n.LCC)); return M.dot(c, a) > 0; }
const HK = ['NL', 'NR', 'LR'];
// commissure error vs known truth: 3D distance, angle about the TRUE root axis (what matters for the protocol), height along the axis, radial
function herr(r) {
  const t = r.g.truth, a = t.axis, perp = (v) => { const h = M.dot(v, a); return [v[0] - h * a[0], v[1] - h * a[1], v[2] - h * a[2]]; }, e = {};
  for (const k of HK) { const T = t.commissure[k], D = r.res.commissures[k], q1 = perp(M.sub(T, t.annulusCentre)), q2 = perp(M.sub(D, t.annulusCentre));
    const sg = M.dot(M.cross(q1, q2), a) >= 0 ? 1 : -1; e[k] = { d: dist(T, D), ang: sg * Math.acos(Math.min(1, M.dot(q1, q2) / Math.hypot(...q1) / Math.hypot(...q2))) * 180 / Math.PI, h: M.dot(D, a) - M.dot(T, a), r: Math.hypot(...q2) - Math.hypot(...q1) }; }
  e.mean = HK.reduce((u, k) => u + e[k].d, 0) / 3; e.max = Math.max(...HK.map((k) => e[k].d)); e.angMean = HK.reduce((u, k) => u + Math.abs(e[k].ang), 0) / 3; e.angMax = Math.max(...HK.map((k) => Math.abs(e[k].ang))); return e;
}
const cases = [
  ['closed valve, default tilt', {}, 3.0, 55],
  ['closed valve, cusps rotated +25°, axis tilted, noise 25', { rotDeg: 25, axisDir: [0.2, 0.35, 0.9] }, 3.0, 55],
  ['closed valve, cusps rotated -25°, noise 40 HU', { rotDeg: -25, axisDir: [-0.5, 0, 0.87], noise: 40 }, 3.2, 55],
  ['closed valve, anisotropic 0.5x0.5x1.0 mm', { spacing: [0.5, 0.5, 1.0], nx: 192, ny: 192, nz: 96 }, 3.0, 55],
  ['open valve (lumen continuous with LV), noise 35', { variant: 'open', rotDeg: 15, axisDir: [-0.3, 0.4, 0.85], noise: 35 }, 3.5, 55],
  ['closed valve, low commissures (apex 14 mm)', { commHeight: 14, rotDeg: -10 }, 3.0, 55]
];
(async () => {
  const results = [];
  for (const [name, opts, tolMean, minConf] of cases) {
    await test(`${name}: nadirs found, correct NCC/LCC/RCC labels + handedness, mean error <= ${tolMean} mm`, () => {
      const r = run(name, opts); results.push(r);
      ok(r.res.ok, 'detection failed: ' + (r.res.message || ''));
      const e = errors(r); table.push({ name, e, conf: r.res.confidence, ms: r.res.ms, q: r.res.quality, warn: r.res.warnings.length });
      ok(handed(r.res.nadirs, r.g.truth.axis), 'RCC->LCC->NCC is not counter-clockwise seen from the aorta');
      ok(e.max <= tolMean + 1.5 && e.mean <= tolMean, `errors NCC ${e.NCC.toFixed(2)} LCC ${e.LCC.toFixed(2)} RCC ${e.RCC.toFixed(2)} mm`);
      ok(r.res.confidence >= minConf, 'confidence ' + r.res.confidence);
      // commissures
      ok(r.res.commissures && HK.every((k) => r.res.commissures[k]), 'commissures missing'); const h = herr(r); htable.push({ name, h });
      ok(h.angMax <= 6, 'commissure angle errors ' + HK.map((k) => h[k].ang.toFixed(1)).join('/') + '°'); ok(h.mean <= 2.5 && h.max <= 3.5, 'commissure position errors ' + HK.map((k) => h[k].d.toFixed(2)).join('/') + ' mm');
      ok(HK.every((k) => Math.abs(h[k].h) <= 3.0), 'commissure height errors ' + HK.map((k) => h[k].h.toFixed(2)).join('/'));
      // the three H are ordered NL, NR, LR consistently with the cusps: each H lies angularly between its two cusps (truth axis)
      const pa = (v) => { const q = M.sub(v, r.g.truth.annulusCentre), hh = M.dot(q, r.g.truth.axis), qq = M.sub(q, r.g.truth.axis.map((x) => x * hh)); return Math.atan2(M.dot(qq, r.g.truth.e2), M.dot(qq, r.g.truth.e1)) * 180 / Math.PI; };
      const wr = (x) => ((x + 540) % 360) - 180, between = (H_, A, B) => Math.abs(wr(pa(H_) - pa(A))) < 80 && Math.abs(wr(pa(H_) - pa(B))) < 80;
      ok(between(r.res.commissures.NL, r.res.nadirs.NCC, r.res.nadirs.LCC) && between(r.res.commissures.NR, r.res.nadirs.NCC, r.res.nadirs.RCC) && between(r.res.commissures.LR, r.res.nadirs.LCC, r.res.nadirs.RCC), 'H not between its cusps');
      ok(r.res.commissureInfo && r.res.commissureInfo.score >= 60 && r.res.nadirConfidence >= r.res.confidence, 'commissure score ' + (r.res.commissureInfo && r.res.commissureInfo.score));
      const ax = Math.acos(Math.min(1, M.dot(r.res.axis, r.g.truth.axis))) * 180 / Math.PI; ok(ax < 12, 'axis error ' + ax.toFixed(1) + '°');
    });
  }
  await test('seed 8 mm off-axis and 6 mm toward the ascending aorta still works (seed snapping / tolerance)', () => {
    const r = run('off', {}, (t) => M.add(M.add(t.seed, t.e1.map((v) => v * 8)), t.axis.map((v) => v * 6)));
    ok(r.res.ok, r.res.message); const e = errors(r); ok(e.mean <= 3.2, 'mean ' + e.mean.toFixed(2));
  });
  await test('axis from a supplied centreline hint (true flow axis +-8°) gives the same nadirs', () => {
    const g = P.generateRoot({}), vol = new V.Volume(g.volume), t = g.truth, tilt = M.norm(M.add(t.axis, t.e1.map((v) => v * 0.14)));
    const res = N.detect(vol, t.seed, { axisHint: tilt }); ok(res.ok, res.message); let m = 0; for (const k of KEYS) m += dist(res.nadirs[k], t.nadir[k]) / 3; ok(m <= 3.0, 'mean ' + m.toFixed(2));
  });
  await test('Rotate labels: cyclic, handedness kept, 3 rotations = identity', () => {
    const n = { NCC: [1, 0, 0], LCC: [0, 1, 0], RCC: [0, 0, 1] }, r1 = N.rotateLabels(n), r3 = N.rotateLabels(N.rotateLabels(r1));
    ok(KEYS.every((k) => r3[k] === n[k]), 'three rotations'); ok(KEYS.some((k) => r1[k] !== n[k]));
    ok(r1.LCC === n.RCC && r1.NCC === n.LCC && r1.RCC === n.NCC, 'each label moves one step along RCC->LCC->NCC');
  });
  await test('Rotate labels also rotates H labels: each commissure keeps its pair of cusps (H_NL <-> between NCC&LCC)', () => {
    const n = { NCC: [1, 0, 0], LCC: [0, 1, 0], RCC: [0, 0, 1] }, Hm = { NL: [10, 0, 0], NR: [0, 10, 0], LR: [0, 0, 10] }, rn = N.rotateLabels(n), rh = N.rotateH(Hm);
    // position-wise: the commissure that was between the points {A,B} must stay between the same two points after the relabel
    const lab = (pos, set) => Object.keys(set).find((k) => set[k] === pos);
    const between = { NL: [n.NCC, n.LCC], NR: [n.NCC, n.RCC], LR: [n.LCC, n.RCC] };
    for (const k of HK) { const [pa_, pb_] = between[k], la = lab(pa_, rn), lb = lab(pb_, rn), want = HK.find((q) => N.HPAIR[q].includes(la) && N.HPAIR[q].includes(lb)); ok(rh[want] === Hm[k], k + ' -> ' + want); }
    const r3 = N.rotateH(N.rotateH(N.rotateH(Hm))); ok(HK.every((k) => r3[k] === Hm[k]), 'three rotations'); ok(HK.every((k) => rh[k] !== Hm[k]));
  });
  await test('ambiguous commissures (unusually high cusp-attachment apex, notch 33° off the midpoint): confidence is REDUCED below the nadir-only confidence and a warning names the H markers', () => {
    const r = run('amb', { commHeight: 32 }); ok(r.res.ok, r.res.message); ok(r.res.confidence < r.res.nadirConfidence, `conf ${r.res.confidence} vs nadir-only ${r.res.nadirConfidence}`);
    ok(r.res.warnings.some((w) => /commissure|H markers/i.test(w)), r.res.warnings.join(' | ')); ok(r.res.commissureInfo.score < 90, 'score ' + r.res.commissureInfo.score);
    const clean = run('clean', {}); ok(clean.res.nadirConfidence - clean.res.confidence <= 3, 'clean case should lose <= 3 points: ' + (clean.res.nadirConfidence - clean.res.confidence));
  });
  // ----- failure modes: helpful message, no exception -----
  const gl = P.generateRoot({ noise: 25 }), vol = new V.Volume(gl.volume), t = gl.truth;
  await test('seed in air / outside the volume: friendly failure (no throw)', () => {
    const r = N.detect(vol, [200, 200, 200], {}); ok(!r.ok && /seed|contrast|lumen/i.test(r.message), r.message);
  });
  await test('seed in soft tissue far from contrast: friendly failure', () => {
    const r = N.detect(vol, M.add(t.annulusCentre, [-40, 0, 0]).map((v, i) => v + (i === 2 ? -20 : 0)), {}); ok(!r.ok, 'should fail, got conf ' + r.res); ok(typeof r.message === 'string' && r.message.length > 20);
  });
  await test('seed in the left atrium blob (bright, but no sinus pattern): fails or gives low confidence, never throws', () => {
    const la = M.add(M.add(t.annulusCentre, t.cuspDirs.NCC.map((v) => v * 41)), t.axis.map((v) => v * 8)); const r = N.detect(vol, la, {});
    ok(!r.ok || r.confidence < 60, 'LA seed gave confident result ' + (r.ok ? r.confidence : ''));
  });
  await test('existing 2 mm aorta tube phantom (no sinuses): graceful message', () => {
    const g = P.generate(), v2 = new V.Volume(g.volume), seed = g.truth.centreline.pts[Math.round(g.truth.sRoot / 0.7) - 20];
    const r = N.detect(v2, seed, {}); ok(!r.ok || r.confidence < 60, JSON.stringify(r.ok ? r.confidence : r.code)); if (!r.ok) ok(r.message.length > 20, r.message);
  });
  await test('null volume / missing seed: friendly failure', () => { ok(!N.detect(null, [0, 0, 0]).ok && !N.detect(vol, null).ok); });
  await test('very bright seed (calcification-like 1200 HU) is refused with a hint', () => {
    const d = Int16Array.from(gl.volume.data); const v3 = new V.Volume(Object.assign({}, gl.volume, { data: d.map((x) => (x > 200 ? 1200 : x)) })); const r = N.detect(v3, t.seed, {}); ok(!r.ok && /bright|calcif/i.test(r.message), r.message);
  });
  console.log('\n  Accuracy on synthetic root phantoms (distance of detected nadir to known nadir, mm):');
  for (const r of table) console.log(`   ${r.name.padEnd(62)} mean ${r.e.mean.toFixed(2)}  max ${r.e.max.toFixed(2)}  conf ${r.conf}% (${r.q}) ${r.ms} ms`);
  console.log('\n  Commissure accuracy (H_NL / H_NR / H_LR): 3D distance mm, angle about the true root axis deg (signed), height along axis mm:');
  for (const r of htable) { const h = r.h; console.log(`   ${r.name.padEnd(62)} dist mean ${h.mean.toFixed(2)} max ${h.max.toFixed(2)} | angle mean ${h.angMean.toFixed(2)}° max ${h.angMax.toFixed(2)}° (${HK.map((k) => h[k].ang.toFixed(1)).join(' / ')}) | height ${HK.map((k) => h[k].h.toFixed(2)).join(' / ')}`); }
  summary();
})();
