// End-to-end checks in headless Chrome (playwright-core + system Chrome). Loads the app from the static server AND from file://.
const { chromium } = require('playwright-core');
const fs = require('fs'), path = require('path'), cp = require('child_process');
const { test, near, ok, summary } = require('./harness.js');
const root = path.join(__dirname, '..'), shots = process.env.NVAP_SHOTS ? path.resolve(process.env.NVAP_SHOTS) : path.join(root, 'tests', 'out', 'screenshots'); // default: untracked; NVAP_SHOTS=screenshots refreshes the committed reference images
const port = process.env.NVAP_PORT || fs.readFileSync(path.join(root, '.port'), 'utf8').trim(); // run_all.sh starts its own server and passes NVAP_PORT
const W = require('./dicomwriter.js'), PH = require('../src/js/phantom.js');
fs.mkdirSync(shots, { recursive: true });
if (!fs.existsSync(path.join(__dirname, 'out', 'phantom_dicom.zip'))) cp.execSync('node make_sample_dicom.js', { cwd: __dirname });

async function screenPos(pg, key, P) {
  return pg.evaluate(([k, P]) => { const v = NavApp.views[k]; v.canvas.scrollIntoView({ block: 'center' }); const [x, y] = v.toScreen(P), r = v.canvas.getBoundingClientRect(); return [r.left + x * r.width / v.W, r.top + y * r.height / v.H]; }, [key, P]);
}
const setCross = (pg, P) => pg.evaluate((P) => { NavApp.S.cross = P.slice(); NavApp.renderNow(); }, P);
async function clickAt(pg, key, P, opts) { await setCross(pg, P); const [x, y] = await screenPos(pg, key, P); await pg.mouse.click(x, y, opts); await pg.waitForTimeout(30); }

(async () => {
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', args: ['--no-sandbox'] });
  const requests = [], errors = [];
  async function newPage(url) {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
    const pg = await ctx.newPage();
    pg.on('request', (r) => requests.push(r.url())); pg.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
    pg.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push('console.error ' + m.text()); });
    await pg.goto(url); return pg;
  }
  const truth = await (async () => { const t = PH.generate().truth; return t; })();
  console.log('E2E (headless Chrome)');

  // ---------- 1. DICOM zip load through the real file input ----------
  const pg = await newPage('http://127.0.0.1:' + port + '/');
  await test('page loads, disclaimer visible, no JS errors', async () => {
    const t = await pg.textContent('#disclaimer'); ok(/not validated/i.test(t) && /No patient data leaves this browser/i.test(t));
    ok(/INVESTIGATIONAL/.test(await pg.textContent('.badge')));
  });
  await test('DICOM .zip loaded via file input -> volume with correct patient geometry', async () => {
    await pg.setInputFiles('#inZip', path.join(__dirname, 'out', 'phantom_dicom.zip'));
    await pg.waitForFunction(() => NavApp.S.vol, null, { timeout: 60000 });
    const g = await pg.evaluate(() => { const v = NavApp.S.vol; return { dims: v.dims, origin: v.origin, vk: v.vk, vi: v.vi, hu: v.sample([30, 50, 0]), status: document.getElementById('loadStatus').textContent }; });
    ok(g.dims.join() === '128,128,210', 'dims ' + g.dims); near(g.origin[0], -128, 1e-6); near(g.origin[2], -230, 1e-6); near(g.vk[2], 2, 1e-6); near(g.vi[0], 2, 1e-6);
    ok(g.hu > 300, 'aorta HU at (30,50,0): ' + g.hu);
    await pg.screenshot({ path: path.join(shots, '01_load_dicom_zip.png') });
  });
  await test('series list shown; skipped-file categories reported', async () => { ok(/Series found/.test(await pg.textContent('#seriesList'))); });
  await test('unsupported codec (JPEG 2000) is rejected with an explanatory message naming the codec (no crash)', async () => {
    const sl = W.volumeToSlices(PH.generate().volume)[0];
    await pg.setInputFiles('#inFiles', [{ name: 'c.dcm', mimeType: 'application/dicom', buffer: W.writeSlice(sl, { compressed: true, ts: '1.2.840.10008.1.2.4.90' }) }]);
    await pg.waitForFunction(() => /JPEG 2000/.test(document.getElementById('loadStatus').textContent) && /cannot decode/.test(document.getElementById('loadStatus').textContent), null, { timeout: 10000 });
  });
  await test('MIXED FOLDER: lossless-JPEG (.70, multi-fragment+BOT) CT + other series + RGB + no-geometry + text -> series list, best series pre-selected & auto-decoded, voxel-identical', async () => {
    const dir = path.join(__dirname, 'out', 'phantom_ljpeg70'), files = fs.readdirSync(dir).filter((f) => /\.dcm$/.test(f)).sort().map((f) => ({ name: f, mimeType: 'application/dicom', buffer: fs.readFileSync(path.join(dir, f)) }));
    const sls = W.volumeToSlices(PH.generate().volume), mk = (n, o, uid) => { for (let k = 0; k < n; k++) { const s = Object.assign({}, sls[k % sls.length], { ipp: [0, 0, k * (o.dz || 3)], instance: k + 1 }); files.push({ name: uid + '_' + k + '.dcm', mimeType: 'application/dicom', buffer: W.writeSlice(s, Object.assign({ seriesUID: uid }, o)) }); } };
    mk(60, { desc: 'Calcium Score 3.0', dz: 3, thickness: 3 }, '5.1'); mk(40, { desc: 'Lung 1.0 B70', dz: 1, thickness: 1 }, '5.2'); mk(30, { desc: 'Screen Save', rgb: true }, '5.3'); mk(2, { desc: 'Scout', noGeometry: true }, '5.4');
    for (let i = 0; i < 5; i++) files.push({ name: 'notes' + i + '.txt', mimeType: 'text/plain', buffer: Buffer.from('hello ' + i) });
    await pg.evaluate(() => { NavApp.S.vol = null; });
    await pg.setInputFiles('#inFiles', files);
    await pg.waitForFunction(() => NavApp.S.vol && /Loaded 210 slices/.test(document.getElementById('loadStatus').textContent), null, { timeout: 90000 });
    const r = await pg.evaluate(() => { const v = NavApp.S.vol, rows = [...document.querySelectorAll('#seriesList tr')].map((t) => t.textContent); let h = 0; for (let n = 0; n < v.data.length; n += 7) h = (h * 31 + v.data[n]) | 0; return { dims: v.dims, h, rows, list: document.getElementById('seriesList').textContent, sel: !!document.querySelector('#seriesList tr.sel'), st: document.getElementById('loadStatus').textContent, codec: v.meta.codec }; });
    const vol = PH.generate().volume; let h = 0; for (let n = 0; n < vol.data.length; n += 7) h = (h * 31 + vol.data[n]) | 0;
    ok(r.dims.join() === '128,128,210', 'dims ' + r.dims); ok(r.h === h, 'voxel checksum differs from phantom: ' + r.h + ' vs ' + h);
    ok(/Series found \(3\)/.test(r.list) && /Calcium Score/.test(r.list) && /Lung 1\.0/.test(r.list) && /Test CTA/.test(r.list), r.list.slice(0, 300)); ok(r.sel, 'selected row marked');
    ok(/Skipped/.test(r.list) && /30 colour/.test(r.list) && /2 images without position/.test(r.list) && /5 non-DICOM/.test(r.list), 'skip summary: ' + r.list.slice(-300)); ok(/lossless/i.test(r.codec || ''), 'codec ' + r.codec);
    await pg.evaluate(() => document.querySelector('#seriesList').scrollIntoView({ block: 'center' }));
    await pg.screenshot({ path: path.join(shots, '09_series_list_compressed_mixed_folder.png') });
  });
  await test('choosing another series from the list loads only that series (Calcium Score: 60 slices, 3 mm)', async () => {
    await pg.evaluate(() => { const rows = [...document.querySelectorAll('#seriesList button[data-act=series]')]; const tr = rows.find((b) => /Calcium/.test(b.closest('tr').textContent)); tr.click(); });
    await pg.waitForFunction(() => /Loaded 60 slices/.test(document.getElementById('loadStatus').textContent), null, { timeout: 30000 });
  });

  await test('drag-and-drop (synthetic DataTransfer with a File) loads the zip', async () => {
    await pg.evaluate(() => { NavApp.S.vol = null; });
    await pg.evaluate(async (port) => { const b = await (await fetch('/tests/out/phantom_dicom.zip')).blob(), dt = new DataTransfer(); dt.items.add(new File([b], 'phantom_dicom.zip'));
      document.getElementById('drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); }, port);
    await pg.waitForFunction(() => NavApp.S.vol && /Loaded 210 slices/.test(document.getElementById('loadStatus').textContent), null, { timeout: 60000 });
  });
  // ---------- 2. real mouse placement of markers ----------
  // reload DICOM again (previous status error does not clear volume, but be explicit)
  await pg.setInputFiles('#inZip', path.join(__dirname, 'out', 'phantom_dicom.zip'));
  await pg.waitForFunction(() => /Loaded 210 slices/.test(document.getElementById('loadStatus').textContent), null, { timeout: 60000 });
  await pg.click('#tabs button[data-tab=mark]');
  const ctrl = truth.demoCtrl().map((p) => p.map((v) => Math.round(v * 10) / 10));
  await test('Mark tab MPR grid fills the main-panel width (no large vacant gutter on the right): 2x2 cells stretch beyond the old 480 px cap', async () => {
    // ensure a wide viewport so the old max-480 layout would leave a visible gutter
    await pg.setViewportSize({ width: 1500, height: 1000 });
    await pg.waitForTimeout(200);
    const r = await pg.evaluate(() => {
      const layout = document.querySelector('#tab-mark .markLayout'), grid = document.querySelector('#tab-mark .mprGrid'), aside = document.getElementById('markPanel');
      const lr = layout.getBoundingClientRect(), gr = grid.getBoundingClientRect(), ar = aside.getBoundingClientRect();
      const cells = [...grid.querySelectorAll(':scope > .vwrap')].map((v) => { const b = v.getBoundingClientRect(); return { w: b.width, h: b.height }; });
      const cs = getComputedStyle(grid), cols = cs.gridTemplateColumns.split(/\s+/).map((x) => parseFloat(x));
      const canvas = document.getElementById('cvAxial').getBoundingClientRect();
      return {
        layoutW: lr.width, gridW: gr.width, asideW: ar.width, gap: lr.right - gr.right,
        cells, cols, canvasW: canvas.width, canvasH: canvas.height,
        gridFills: Math.abs(gr.right - lr.right) < 4 && gr.left > ar.right - 2
      };
    });
    ok(r.gridFills, 'grid should reach the right edge of markLayout: gap=' + r.gap.toFixed(1) + ' layoutW=' + r.layoutW.toFixed(0) + ' gridW=' + r.gridW.toFixed(0));
    ok(r.gap < 8, 'vacant gutter on the right must be < 8 px, got ' + r.gap.toFixed(1));
    ok(r.cells.length === 4, '2x2 cells');
    ok(r.cells.every((c) => c.w > 500), 'each cell wider than the old 480 px cap: ' + JSON.stringify(r.cells.map((c) => Math.round(c.w))));
    ok(r.cols.length === 2 && r.cols.every((c) => c > 500), '1fr columns: ' + r.cols);
    ok(r.canvasW > 500 && Math.abs(r.canvasW - r.canvasH) < 3, 'axial canvas fills its cell square: ' + r.canvasW + 'x' + r.canvasH);
    ok(r.asideW >= 280 && r.asideW <= 320, 'sidebar stays ~300 px usable: ' + r.asideW);
    console.log('       (markLayout ' + Math.round(r.layoutW) + ' px · grid ' + Math.round(r.gridW) + ' px · cell ~' + Math.round(r.cells[0].w) + ' px · right gutter ' + r.gap.toFixed(1) + ' px)');
  });
  await test('place centreline (17 pts) + H + nadir markers with real mouse clicks on the axial view', async () => {
    await pg.click('[data-tool="cl"]');
    for (const P of ctrl) await clickAt(pg, 'axial', P);
    for (const k of ['NL', 'NR', 'LR']) { await pg.click(`[data-tool="H.${k}"]`); await clickAt(pg, 'axial', truth.H[k]); }
    for (const k of ['NCC', 'LCC', 'RCC']) { await pg.click(`[data-tool="nadir.${k}"]`); await clickAt(pg, 'axial', truth.nadir[k]); }
    const r = await pg.evaluate(() => { const m = NavApp.S.m; return { ncl: m.cl.length, H: m.H, nadir: m.nadir, cl: m.cl }; });
    ok(r.ncl === ctrl.length, 'cl points ' + r.ncl);
    ctrl.forEach((P, i) => { const d = Math.hypot(...P.map((v, a) => v - r.cl[i][a])); ok(d < 1.2, 'cl ' + i + ' off by ' + d.toFixed(2)); });
    for (const k of ['NL', 'NR', 'LR']) { const d = Math.hypot(...truth.H[k].map((v, a) => v - r.H[k][a])); ok(d < 1.2, 'H_' + k + ' off by ' + d.toFixed(2) + ' mm'); }
    await pg.screenshot({ path: path.join(shots, '02_mark_mpr.png') });
  });
  await test('nadir plane / H separations shown in marker summary', async () => { const t = await pg.textContent('#markSummary'); ok(/H angular separations/.test(t) && /Annular \(nadir\) plane/.test(t), t); });

  const tr = {}, zst = {};
  // ---------- 2b. mouse-only per-view zoom controls (Windows PC without trackpad): − / slider / + / Fit in each MPR title bar ----------
  await test('ZOOM CONTROLS: Axial/Coronal/Sagittal each have − / slider / + / Fit in the title row (not over the image, no extra height); Cursor panel and other tabs have none', async () => {
    const r = await pg.evaluate(() => {
      const bars = [...document.querySelectorAll('#tab-mark .zoombar')].map((z) => { const t = z.closest('.vtitle'), w = z.closest('.vwrap'), c = w.querySelector('canvas'), tb = t.getBoundingClientRect(), cb = c.getBoundingClientRect(), zb = z.getBoundingClientRect();
        return { view: z.dataset.view, inTitle: !!t, btns: [...z.querySelectorAll('button')].map((b) => b.textContent), slider: !!z.querySelector('input[type=range]'), titleH: tb.height, aboveCanvas: zb.bottom <= cb.top + 0.5, canvasW: cb.width, canvasH: cb.height, bg: getComputedStyle(z.querySelector('button')).backgroundColor }; });
      return { bars, info: !!document.querySelector('#tab-mark .vwrap.info .zoombar'), others: document.querySelectorAll('.zoombar').length };
    });
    ok(r.bars.map((b) => b.view).join() === 'axial,coronal,sagittal', 'views ' + r.bars.map((b) => b.view)); ok(!r.info, 'Cursor panel must not have zoom controls'); ok(r.others === 3, 'zoom bars total ' + r.others);
    r.bars.forEach((b) => { ok(b.inTitle && b.slider && b.btns.join('|') === '−|+|Fit', b.view + ' controls ' + b.btns); ok(b.titleH <= 24, b.view + ' title row height ' + b.titleH); ok(b.aboveCanvas, b.view + ' controls overlap the image');
      ok(b.canvasW > 500 && Math.abs(b.canvasW - b.canvasH) < 3, b.view + ' canvas still large+square ' + b.canvasW + 'x' + b.canvasH);
      const m = b.bg.match(/\d+/g).map(Number); ok(m[0] + m[1] + m[2] < 200, 'dark theme button bg ' + b.bg); });
  });
  await test('ZOOM CONTROLS (real mouse): + zooms the axial view ×1.25 about the crosshair (crosshair + markers stay registered, slice/other views unchanged); clicks after zoom map to the right patient position', async () => {
    await pg.evaluate(() => document.getElementById('cvAxial').scrollIntoView({ block: 'center' }));
    const st = () => pg.evaluate(() => { const v = NavApp.views, S = NavApp.S, a = v.axial; return { mm: a.mm, cu: a.cu, cv: a.cv, fitMm: a.fitMm, cmm: v.coronal.mm, smm: v.sagittal.mm, cross: S.cross.slice(), cs: a.toScreen(S.cross), hs: ['NL', 'NR', 'LR'].map((k) => a.toScreen(S.m.H[k])), lab: a.zbar.lab.textContent, sl: +a.zbar.inp.value,
      px: (() => { const c = a.canvas.getContext('2d').getImageData(0, 0, a.W, a.H).data; let h = 0; for (let i = 0; i < c.length; i += 97) h = (h * 31 + c[i]) | 0; return h; })() }; });
    const s0 = await st(); near(s0.mm, s0.fitMm, 1e-12, 'axial starts at Fit'); ok(s0.lab === '100%', 'label ' + s0.lab); zst.s0 = s0;
    await pg.click('.zoombar[data-view=axial] [data-z=in]'); await pg.waitForTimeout(80);
    const s1 = await st();
    near(s0.mm / s1.mm, 1.25, 1e-9, 'zoom factor'); ok(s1.lab === '125%', 'label ' + s1.lab); near(s1.sl, Math.round(100 * Math.log2(1.25)), 0, 'slider follows');
    near(s1.cs[0], s0.cs[0], 1e-6, 'crosshair x stays'); near(s1.cs[1], s0.cs[1], 1e-6, 'crosshair y stays');
    s0.hs.forEach((p, i) => { near(s1.hs[i][0], s0.cs[0] + 1.25 * (p[0] - s0.cs[0]), 1e-6, 'H marker x registered'); near(s1.hs[i][1], s0.cs[1] + 1.25 * (p[1] - s0.cs[1]), 1e-6, 'H marker y registered'); });
    ok(s1.cross.every((v, i) => v === s0.cross[i]), 'zoom moved the crosshair/slice'); ok(s1.cmm === s0.cmm && s1.smm === s0.smm, 'other views changed zoom'); ok(s1.px !== s0.px, 'axial pixels unchanged after zoom');
    await pg.click('.zoombar[data-view=axial] [data-z=in]'); await pg.click('.zoombar[data-view=axial] [data-z=in]'); await pg.waitForTimeout(60);
    const s2 = await st(); near(s0.mm / s2.mm, Math.pow(1.25, 3), 1e-9, '3 clicks'); ok(s2.lab === '195%', 'label ' + s2.lab);
    await pg.screenshot({ path: path.join(shots, '19_mpr_zoom_controls.png') });
    // a real Navigate click after zooming lands on the patient position under the mouse
    await pg.click('[data-tool="nav"]'); const W = [s0.cross[0] + 12, s0.cross[1] - 9, s0.cross[2]];
    const [x, y] = await screenPos(pg, 'axial', W); await pg.mouse.click(x, y); await pg.waitForTimeout(60);
    const c = await pg.evaluate(() => NavApp.S.cross.slice()); const d = Math.hypot(c[0] - W[0], c[1] - W[1]); ok(d < 0.25, 'click after zoom off by ' + d.toFixed(3) + ' mm'); near(c[2], W[2], 1e-9, 'axial click keeps z');
    await setCross(pg, s0.cross);
  });
  await test('ZOOM CONTROLS (real mouse): − zooms out; dragging the zoom slider changes zoom (label + px/mm overlay follow); Fit restores the exact fitted zoom AND pan', async () => {
    const s0 = zst.s0, zl = () => pg.evaluate(() => ({ z: NavApp.zoomOf(NavApp.views.axial), mm: NavApp.views.axial.mm, cu: NavApp.views.axial.cu, cv: NavApp.views.axial.cv, lab: NavApp.views.axial.zbar.lab.textContent }));
    for (let i = 0; i < 4; i++) await pg.click('.zoombar[data-view=axial] [data-z=out]');
    await pg.waitForTimeout(60); let z = await zl(); near(z.z, 0.8, 1e-9, 'zoom after 3× + and 4× −'); ok(z.lab === '80%', 'label ' + z.lab);
    const box = await pg.locator('.zoombar[data-view=axial] input[type=range]').boundingBox(), v0 = await pg.evaluate(() => +NavApp.views.axial.zbar.inp.value);
    const fx = (v) => box.x + 7 + (box.width - 14) * (v + 100) / 500;          // thumb centre for value v on a -100..400 slider
    await pg.mouse.move(fx(v0), box.y + box.height / 2); await pg.mouse.down(); for (let i = 1; i <= 8; i++) await pg.mouse.move(fx(v0) + (fx(250) - fx(v0)) * i / 8, box.y + box.height / 2); await pg.mouse.up(); await pg.waitForTimeout(80);
    z = await zl(); ok(z.z > 4 && z.z < 7.5, 'slider drag zoom ' + z.z.toFixed(2)); ok(z.lab === Math.round(z.z * 100) + '%', 'label ' + z.lab);
    await pg.click('.zoombar[data-view=axial] [data-z=fit]'); await pg.waitForTimeout(60);
    z = await zl(); near(z.mm, s0.mm, 1e-12, 'Fit mm'); near(z.cu, s0.cu, 1e-9, 'Fit cu'); near(z.cv, s0.cv, 1e-9, 'Fit cv'); ok(z.lab === '100%', 'label ' + z.lab);
    // Fit also undoes a pan (shift-drag) and works per view (coronal)
    const cz = () => pg.evaluate(() => { const v = NavApp.views.coronal; return { mm: v.mm, cu: v.cu, cv: v.cv }; }); const c0 = await cz();
    await pg.click('.zoombar[data-view=coronal] [data-z=in]'); const cb = await pg.locator('#cvCoronal').boundingBox();
    await pg.keyboard.down('Shift'); await pg.mouse.move(cb.x + 200, cb.y + 200); await pg.mouse.down(); await pg.mouse.move(cb.x + 260, cb.y + 230, { steps: 4 }); await pg.mouse.up(); await pg.keyboard.up('Shift');
    const c1 = await cz(); ok(c1.mm < c0.mm && (c1.cu !== c0.cu || c1.cv !== c0.cv), 'coronal zoom+pan'); near((await zl()).mm, s0.mm, 1e-12, 'axial untouched by coronal zoom');
    await pg.click('.zoombar[data-view=coronal] [data-z=fit]'); await pg.waitForTimeout(60); const c2 = await cz(); near(c2.mm, c0.mm, 1e-12, 'coronal Fit mm'); near(c2.cu, c0.cu, 1e-9); near(c2.cv, c0.cv, 1e-9);
  });
  await test('ZOOM: + / − / 0 keys zoom the hovered view; Ctrl+wheel (mouse) / pinch still zooms and the zoom bar follows it (additive, Mac behaviour unchanged)', async () => {
    await pg.evaluate(() => { const a = document.activeElement; if (a && a.blur) a.blur(); NavApp.views.sagittal.canvas.scrollIntoView({ block: 'center' }); });
    await pg.waitForTimeout(60);
    const sb = await pg.locator('#cvSagittal').boundingBox(); await pg.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2); await pg.waitForTimeout(40);
    const sz = () => pg.evaluate(() => ({ z: NavApp.zoomOf(NavApp.views.sagittal), lab: NavApp.views.sagittal.zbar.lab.textContent, sl: +NavApp.views.sagittal.zbar.inp.value, hover: NavApp.S.hover }));
    ok((await sz()).hover === 'sagittal', 'hover sagittal after move');
    await pg.keyboard.press('+'); await pg.waitForTimeout(60); near((await sz()).z, 1.25, 1e-9, '+ key'); await pg.keyboard.press('-'); await pg.keyboard.press('-'); await pg.waitForTimeout(60); near((await sz()).z, 0.8, 1e-9, '- key');
    await pg.keyboard.press('0'); await pg.waitForTimeout(60); near((await sz()).z, 1, 1e-12, '0 key = Fit');
    await pg.keyboard.down('Control'); await pg.mouse.wheel(0, -120); await pg.keyboard.up('Control'); await pg.waitForTimeout(80);
    const w = await sz(); ok(w.z > 1.1, 'ctrl+wheel zoom ' + w.z); ok(w.lab === Math.round(w.z * 100) + '%' && w.sl === Math.round(100 * Math.log2(w.z)), 'bar follows wheel zoom ' + JSON.stringify(w));
    await pg.click('.zoombar[data-view=sagittal] [data-z=fit]'); await pg.waitForTimeout(40); near((await sz()).z, 1, 1e-12, 'Fit after wheel');
  });

  // ---------- 3. transfer ----------
  await test('A markers computed; transferred angle == H angle; A close to analytic ground truth of the phantom', async () => {
    const r = await pg.evaluate((truthIn) => {
      const S = NavApp.S, M = NavApp.M, P = NavPhantom.generate().truth;
      const cl = P.centreline, sT = M.nearestS(cl, S.axis.C).s, out = { sD: S.sD, sH: S.sH, len: S.cl.length, angH: {}, angA: {}, dTruth: {} };
      for (const k of ['NL', 'NR', 'LR']) {
        out.angH[k] = S.tr[k].phi; const a = M.angularPosition(S.cl, S.sD, S.m.A[k].pos); out.angA[k] = a.phi;
        const At = M.positionFromAngle(cl, sT, P.commDeg[k], 16.5, 0); out.dTruth[k] = M.dist(At, S.m.A[k].pos);
      } return out;
    });
    Object.assign(tr, r);
    for (const k of ['NL', 'NR', 'LR']) { near(((r.angA[k] - r.angH[k] + 540) % 360) - 180, 0, 0.05, 'angle transfer ' + k); ok(r.dTruth[k] < 3.0, 'A_' + k + ' vs phantom analytic truth: ' + r.dTruth[k].toFixed(2) + ' mm'); }
    console.log('       (A vs analytic truth, mm: ' + Object.values(r.dTruth).map((x) => x.toFixed(2)).join(', ') + '; sD=' + r.sD.toFixed(1) + ' mm, centreline ' + r.len.toFixed(1) + ' mm)');
  });
  await pg.click('#tabs button[data-tab=transfer]'); await pg.waitForTimeout(600);
  await test('transfer tab renders (cross-sections, polar, straightened view, table)', async () => {
    ok(/Marker transfer/.test(await pg.textContent('#transferTable')));
    await pg.screenshot({ path: path.join(shots, '03_transfer.png'), fullPage: true });
  });
  await test('drag A_NL in the descending cross-section -> marked manual; reset button restores computed position', async () => {
    const before = await pg.evaluate(() => NavApp.S.m.A.NL.pos.slice());
    const [x, y] = await screenPos(pg, 'xdesc', before);
    await pg.mouse.move(x, y); await pg.mouse.down(); await pg.mouse.move(x + 20, y + 10, { steps: 5 }); await pg.mouse.up(); await pg.waitForTimeout(100);
    const after = await pg.evaluate(() => ({ p: NavApp.S.m.A.NL.pos.slice(), man: NavApp.S.m.A.NL.manual }));
    ok(after.man, 'manual flag'); const d = Math.hypot(...before.map((v, i) => v - after.p[i])); ok(d > 3 && d < 8, 'moved ' + d.toFixed(2) + ' mm (expected ~5 mm = 22 px * 0.23)');
    await pg.click('#btnResetA'); await pg.waitForTimeout(100);
    const reset = await pg.evaluate(() => NavApp.S.m.A.NL.pos.slice()); ok(Math.hypot(...before.map((v, i) => v - reset[i])) < 1e-6, 'restored');
  });
  await test('moving the descending-level slider moves A markers along the centreline and keeps the angle', async () => {
    const r = await pg.evaluate(() => { const S = NavApp.S, M = NavApp.M, a0 = M.angularPosition(S.cl, S.sD, S.m.A.NR.pos).phi, s0 = S.sD;
      const el = document.getElementById('descLevel'); el.value = String(s0 - 60); el.dispatchEvent(new Event('input'));
      const a1 = M.angularPosition(S.cl, S.sD, S.m.A.NR.pos).phi; return { s0, s1: S.sD, a0, a1 }; });
    near(r.s0 - r.s1, 60, 0.6); near(((r.a1 - r.a0 + 540) % 360) - 180, 0, 0.05, 'angle preserved by transfer, per RMF');
    await pg.evaluate(() => document.getElementById('btnDescDefault').click());
  });

  // ---------- 3b. stretched view: C-arm angulation of the cut plane (overlay + "use in C-arm tab") ----------
  const cprTxt = () => pg.evaluate(() => document.getElementById('cprReadout').textContent);
  const parseAng = (t, lab, lvl) => { const seg = t.slice(t.indexOf(lvl)); const m = new RegExp(lab + '[^:]*:\\s*(LAO|RAO|LAO/RAO) (\\d+)° / (CRAN|CAUD|CRAN/CAUD) (\\d+)°').exec(seg); if (!m) return null; return [(m[1] === 'RAO' ? -1 : 1) * +m[2], (m[3] === 'CAUD' ? -1 : 1) * +m[4]]; };
  await test('stretched view overlay: shows edge-on + face-on C-arm angulation (LAO/CRAN) for descending and annulus level, with left/right marker split / 2:1 status', async () => {
    await pg.evaluate(() => { const el = document.getElementById('cprAngle'); el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    const t = await cprTxt(); ok(/Cut plane 0°/.test(t) && /Descending level/.test(t) && /Annulus level/.test(t) && /Edge-on \(beam in plane\)/.test(t) && /Face-on \(beam ⟂ plane\)/.test(t), t);
    ok(/\d+ left \/ \d+ right/.test(t) && /(2:1 ✓|not 2:1)/.test(t), t); ok(await pg.isVisible('#cprReadout'), 'overlay visible');
    await pg.screenshot({ path: path.join(shots, '15_stretched_carm_angulation.png'), fullPage: true });
  });
  await test('C-arm angulation panel fills the area beside the stretched view: bottom level with the canvas bottom (±8 px), no clipped overflow, readable font, at 1500x1000 and 1280x800', async () => {
    for (const [w, h] of [[1280, 800], [1500, 1000]]) {
      await pg.setViewportSize({ width: w, height: h }); await pg.waitForTimeout(250);
      const r = await pg.evaluate(() => { const c = document.getElementById('cvCPR').getBoundingClientRect(), el = document.getElementById('cprReadout'), p = el.getBoundingClientRect(), wr = document.getElementById('cprStage').getBoundingClientRect();
        return { cb: c.bottom, ct: c.top, pb: p.bottom, pt: p.top, pr: p.right, wr: wr.right, pw: p.width, ww: wr.width, sh: el.scrollHeight, ch: el.clientHeight, sw: el.scrollWidth, cw: el.clientWidth, fs: parseFloat(getComputedStyle(el).fontSize), txt: el.textContent }; });
      ok(Math.abs(r.pb - r.cb) <= 8, w + ': panel bottom ' + r.pb + ' vs canvas bottom ' + r.cb);
      ok(Math.abs(r.pt - r.ct) <= 8, w + ': panel top ' + r.pt + ' vs canvas top ' + r.ct);
      ok(Math.abs(r.pr - r.wr) <= 2 && r.pw >= 0.4 * r.ww, w + ': panel uses the right-hand width ' + r.pw + '/' + r.ww);
      ok(r.sh <= r.ch && r.sw <= r.cw, w + ': clipped overflow ' + JSON.stringify(r));
      ok(r.fs >= 11, w + ': font ' + r.fs + ' px'); ok(/Descending level/.test(r.txt) && /Annulus level/.test(r.txt), 'content intact');
    }
    await pg.locator('#cprStage').scrollIntoViewIfNeeded(); await pg.screenshot({ path: path.join(shots, '20_cprpanel_fill.png') });
  });
  await test('C-arm tab: Selected projection heading/labels/inputs enlarged (18-20 px text, >=90x38 px inputs), green result >= 26 px', async () => {
    await pg.evaluate(() => NavApp.setTab('carm')); await pg.waitForTimeout(150);
    const r = await pg.evaluate(() => { const fs = (e) => parseFloat(getComputedStyle(e).fontSize), hd = document.getElementById('selLao').closest('.card').querySelector('h2'), lb = document.getElementById('selLao').closest('label'), a = document.getElementById('selLao').getBoundingClientRect(), c = document.getElementById('selCran').getBoundingClientRect();
      return { h: fs(hd), l: fs(lb), i: fs(document.getElementById('selLao')), a: [a.width, a.height], c: [c.width, c.height], big: fs(document.getElementById('selBig')), bg: getComputedStyle(document.getElementById('selLao')).backgroundColor }; });
    ok(r.h >= 18 && r.l >= 18 && r.i >= 18, JSON.stringify(r)); ok(r.a[0] >= 90 && r.a[1] >= 38 && r.c[0] >= 90 && r.c[1] >= 38, 'input size ' + JSON.stringify(r));
    ok(r.big >= 26, 'result font ' + r.big); ok(r.bg === 'rgb(18, 24, 31)', 'dark input ' + r.bg);
    await pg.screenshot({ path: path.join(shots, '21_selected_projection_bigger.png') });
    await pg.evaluate(() => NavApp.setTab('transfer')); await pg.waitForTimeout(150);
  });
  await test('Overlap panel: "Use in C-arm tab" buttons are large (16-18 px text, >=40 px tall); disabled ones still look disabled', async () => {
    const r = await pg.evaluate(() => [...document.querySelectorAll('#ovBody button[data-ovuse]')].map((b) => { const c = getComputedStyle(b), q = b.getBoundingClientRect(); return { fs: parseFloat(c.fontSize), h: q.height, w: q.width, dis: b.disabled, op: parseFloat(c.opacity), cur: parseFloat(getComputedStyle(b.parentElement.querySelector('.ovcur')).fontSize) }; }));
    ok(r.length >= 1, 'no overlap buttons');
    r.forEach((b) => { ok(b.fs >= 16 && b.fs <= 18 && b.h >= 40 && b.w >= 150 && b.cur >= 13, JSON.stringify(b)); ok(b.dis ? b.op <= 0.6 : b.op === 1, 'disabled look ' + JSON.stringify(b)); });
  });
  await test('Cut-plane angle primary slider sits under the stretched view (full width); compact sidebar twin stays in sync (one logical control)', async () => {
    const loc = await pg.evaluate(() => {
      const under = document.getElementById('cprAngle'), side = document.getElementById('cprAngleSide'), bar = document.getElementById('cprSliderBar');
      const wrap = document.getElementById('cvCPR').closest('.vwrap');
      return {
        underInWrap: !!(under && wrap && wrap.contains(under) && bar && wrap.contains(bar)),
        underAfterCanvas: !!(under && (under.compareDocumentPosition(document.getElementById('cvCPR')) & Node.DOCUMENT_POSITION_PRECEDING)),
        underBeforeButtons: !!(under && (under.compareDocumentPosition(document.getElementById('btnCprEdge')) & Node.DOCUMENT_POSITION_FOLLOWING)),
        sideInAside: !!(side && document.querySelector('#tab-transfer aside.panel').contains(side)),
        label: bar ? bar.textContent.trim().slice(0, 20) : '',
        ids: { under: !!under, side: !!side, outU: !!document.getElementById('cprAngleO'), outS: !!document.getElementById('cprAngleSideO') }
      };
    });
    ok(loc.underInWrap && loc.underAfterCanvas && loc.underBeforeButtons, 'primary under stretched view: ' + JSON.stringify(loc));
    ok(loc.sideInAside && loc.ids.under && loc.ids.side && loc.ids.outU && loc.ids.outS, 'sidebar twin present: ' + JSON.stringify(loc));
    ok(/Cut-plane angle/.test(loc.label), 'label ' + loc.label);
  });
  await test('moving the cut-plane slider with REAL keyboard/mouse events changes the overlay live; angles equal the independent maths (edge-on = beam along e, face-on = beam along n) at both levels', async () => {
    const sl = pg.locator('#cprAngle'); await sl.focus(); const seen = new Set();
    seen.add(await cprTxt());
    for (let i = 0; i < 4; i++) { for (let k = 0; k < 25; k++) await pg.keyboard.press('ArrowRight'); seen.add(await cprTxt()); }
    ok(seen.size === 5, 'overlay text should change at each of the 4 slider moves: ' + seen.size);
    await pg.waitForTimeout(250); const a100 = await pg.evaluate(() => NavApp.S.p.cprAngle); ok(a100 >= 96 && a100 <= 100 && (await pg.textContent('#cprAngleO')) === a100 + '°' && (await pg.textContent('#cprAngleSideO')) === a100 + '°' && +await pg.inputValue('#cprAngleSide') === a100 && new RegExp('Cut plane ' + a100 + '°').test(await cprTxt()), 'under-view + sidebar twin synced at ' + a100 + '° / label ' + await pg.textContent('#cprAngleO'));
    await sl.evaluate((el) => el.scrollIntoView({ block: 'center' })); const box = await sl.boundingBox(); await pg.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2); await pg.waitForTimeout(100);       // click the middle of the track -> ~180°
    const a = await pg.evaluate(() => NavApp.S.p.cprAngle); ok(a > 160 && a < 200, 'slider click -> ' + a);
    // independent check in the page: angles from first principles (no use of cutPlaneBeams)
    const r = await pg.evaluate(() => { const S = NavApp.S, M = NavApp.M, D = Math.PI / 180, out = [];
      for (const [key, s] of [['desc', S.sD], ['ann', S.sH]]) { const f = M.frameAt(S.cl, s), al = S.p.cprAngle * D;
        const e = [0, 1, 2].map((i) => Math.cos(al) * f.N1[i] + Math.sin(al) * f.N2[i]), n = M.cross(f.T, e);
        const ang = (v) => { if (v[1] > 0) v = v.map((x) => -x); return [Math.round(Math.atan2(v[0], -v[1]) / D), Math.round(Math.asin(v[2]) / D)]; };
        const B = NavApp.cprBeams().levels[key]; out.push({ key, edge: ang(e), face: ang(n), uiEdge: [B.edge.lao, B.edge.cran], uiFace: [B.face.lao, B.face.cran] }); } return out; });
    const t = await cprTxt();
    for (const q of r) { ok(JSON.stringify(q.edge) === JSON.stringify(q.uiEdge) && JSON.stringify(q.face) === JSON.stringify(q.uiFace), 'angles ' + JSON.stringify(q));
      const lvl = q.key === 'desc' ? 'Descending level' : 'Annulus level', e = parseAng(t, 'Edge-on', lvl), f = parseAng(t, 'Face-on', lvl);
      ok(JSON.stringify(e) === JSON.stringify(q.edge) && JSON.stringify(f) === JSON.stringify(q.face), lvl + ' text ' + JSON.stringify([e, f]) + ' vs ' + JSON.stringify([q.edge, q.face])); }
    console.log('       (cut plane ' + a + '°: descending edge-on ' + r[0].edge + ' face-on ' + r[0].face + '; annulus edge-on ' + r[1].edge + ' face-on ' + r[1].face + ')');
  });
  await test('face-on(alpha) == edge-on(alpha+90) in the UI; overlay changes with the angle', async () => {
    const g = async (al) => { await pg.evaluate((al) => { const el = document.getElementById('cprAngle'); el.value = String(al); el.dispatchEvent(new Event('input', { bubbles: true })); }, al); await pg.waitForTimeout(150); return pg.evaluate(() => { const D = NavApp.cprBeams().levels.desc; return { e: [D.edge.lao, D.edge.cran], f: [D.face.lao, D.face.cran], txt: document.getElementById('cprReadout').textContent }; }); };
    const a = await g(40), b = await g(130), c = await g(300);
    ok(JSON.stringify(a.f) === JSON.stringify(b.e), 'face(40) ' + a.f + ' vs edge(130) ' + b.e); ok(a.txt !== b.txt && b.txt !== c.txt, 'text should change');
  });
  await test('under-view Cut-plane slider: drag/set updates overlay, C-arm angulation panel and sidebar twin live; sidebar twin drives the under-view slider too', async () => {
    const under = pg.locator('#cprAngle'), side = pg.locator('#cprAngleSide');
    await under.focus();
    // set via the under-view control (dispatch input as if dragged)
    await pg.evaluate(() => { const el = document.getElementById('cprAngle'); el.value = '45'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await pg.waitForTimeout(250);
    let st = await pg.evaluate(() => ({ a: NavApp.S.p.cprAngle, u: +document.getElementById('cprAngle').value, s: +document.getElementById('cprAngleSide').value, ou: document.getElementById('cprAngleO').textContent, os: document.getElementById('cprAngleSideO').textContent, ov: document.getElementById('cprReadout').textContent, h: (() => { const d = document.getElementById('cvCPR').getContext('2d').getImageData(0, 0, 100, 60).data; let h = 0; for (let i = 0; i < d.length; i += 17) h = (h * 33 + d[i]) | 0; return h; })() }));
    ok(st.a === 45 && st.u === 45 && st.s === 45 && st.ou === '45°' && st.os === '45°', 'under-view set -> both synced: ' + JSON.stringify(st));
    ok(/Cut plane 45°/.test(st.ov) && /Edge-on/.test(st.ov) && /Face-on/.test(st.ov), 'overlay updated: ' + st.ov.slice(0, 120));
    const hash45 = st.h;
    // real mouse drag on the under-view slider thumb area (click toward the right end)
    const box = await under.boundingBox(); ok(box && box.width > 80, 'slider visible under the view');
    // drag the thumb across the track (more reliable than a single click on some Chrome builds)
    await pg.mouse.move(box.x + box.width * 0.15, box.y + box.height / 2); await pg.mouse.down();
    await pg.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 12 }); await pg.mouse.up();
    await pg.waitForTimeout(350);
    st = await pg.evaluate(() => ({ a: NavApp.S.p.cprAngle, s: +document.getElementById('cprAngleSide').value, ou: document.getElementById('cprAngleO').textContent, os: document.getElementById('cprAngleSideO').textContent, ov: document.getElementById('cprReadout').textContent, h: (() => { const d = document.getElementById('cvCPR').getContext('2d').getImageData(0, 0, 100, 60).data; let h = 0; for (let i = 0; i < d.length; i += 17) h = (h * 33 + d[i]) | 0; return h; })() }));
    ok(st.a > 45 && st.a < 320 && st.s === st.a && st.ou === st.a + '°' && st.os === st.a + '°', 'drag under-view -> synced at ' + st.a);
    ok(new RegExp('Cut plane ' + st.a + '°').test(st.ov), 'overlay follows drag');
    ok(st.h !== hash45, 'stretched view re-rendered after drag (hash ' + hash45 + ' -> ' + st.h + ')');
    const afterDrag = st.a;
    // drive from the sidebar twin
    await pg.evaluate(() => { const el = document.getElementById('cprAngleSide'); el.value = '120'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    await pg.waitForTimeout(250);
    st = await pg.evaluate(() => ({ a: NavApp.S.p.cprAngle, u: +document.getElementById('cprAngle').value, s: +document.getElementById('cprAngleSide').value, ou: document.getElementById('cprAngleO').textContent, os: document.getElementById('cprAngleSideO').textContent, ov: document.getElementById('cprReadout').textContent }));
    ok(st.a === 120 && st.u === 120 && st.s === 120 && st.ou === '120°' && st.os === '120°', 'sidebar twin drives under-view: ' + JSON.stringify(st));
    ok(/Cut plane 120°/.test(st.ov), 'overlay follows sidebar'); ok(afterDrag !== 120, 'value actually changed from drag position');
    // keyboard on the under-view slider
    await under.focus(); await pg.keyboard.press('ArrowRight'); await pg.keyboard.press('ArrowRight'); await pg.waitForTimeout(200);
    const aKey = await pg.evaluate(() => NavApp.S.p.cprAngle); ok(aKey === 122, 'ArrowRight on under-view slider -> ' + aKey);
    ok((await pg.textContent('#cprAngleSideO')) === '122°' && +await pg.inputValue('#cprAngleSide') === 122, 'sidebar twin follows keyboard');
    await pg.locator('#cprSliderBar').scrollIntoViewIfNeeded(); await pg.screenshot({ path: path.join(shots, '18_cutplane_slider_under_stretched.png'), fullPage: true });
    // restore 0 for following tests
    await pg.evaluate(() => { const el = document.getElementById('cprAngle'); el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true })); });
  });
  await test('"Use edge-on / face-on angle in C-arm tab": selects that projection (1° grid) in the C-arm tab; the C-arm tab evaluation equals the overlay status; out-of-range angles disable the button', async () => {
    const out = [];
    for (const kind of ['edge', 'face']) {
      // find a cut-plane angle for which the beam is inside the C-arm range
      const al = await pg.evaluate((kind) => { for (let a = 0; a < 360; a += 5) { const el = document.getElementById('cprAngle'); el.value = String(a); el.dispatchEvent(new Event('input', { bubbles: true })); if (NavApp.cprBeams().levels.desc[kind].inRange) return a; } return -1; }, kind);
      ok(al >= 0, 'no in-range angle for ' + kind); await pg.waitForTimeout(200);
      const exp = await pg.evaluate((kind) => { const D = NavApp.cprBeams().levels.desc[kind]; return { lao: D.lao, cran: D.cran, st: D.status }; }, kind);
      await pg.click(kind === 'edge' ? '#btnCprEdge' : '#btnCprFace'); await pg.waitForTimeout(150);
      const sel = await pg.evaluate(() => ({ s: NavApp.S.sel, man: NavApp.S.selManual, ev: (() => { const e = NavApp.selEval(); return e && { is21: e.is21, margin: e.margin, left: e.s.filter((v) => v < 0).length }; })() }));
      ok(sel.s.lao === exp.lao && sel.s.cran === exp.cran && sel.man === true, 'selected ' + JSON.stringify(sel.s) + ' expected ' + exp.lao + '/' + exp.cran);
      ok(sel.ev && sel.ev.is21 === exp.st.is21 && Math.abs(sel.ev.margin - (exp.st.is21 ? exp.st.margin : 0)) < 1e-9 && sel.ev.left === exp.st.left, 'C-arm evaluation differs from overlay status ' + JSON.stringify([sel.ev, exp.st]));
      ok(/currently selected in the C-arm tab/.test(await pg.textContent('#cprUseMsg')), 'confirmation message');
      await pg.click('#tabs button[data-tab=carm]'); await pg.waitForTimeout(400);
      ok((await pg.inputValue('#selLao')) === String(exp.lao) && (await pg.inputValue('#selCran')) === String(exp.cran), 'C-arm tab selectors show ' + (await pg.inputValue('#selLao')) + '/' + (await pg.inputValue('#selCran')));
      await pg.click('#tabs button[data-tab=transfer]'); await pg.waitForTimeout(300); out.push(kind + ' ' + exp.lao + '/' + exp.cran + ' at ' + al + '°');
    }
    const aOut = await pg.evaluate(() => { for (let a = 0; a < 360; a++) { const el = document.getElementById('cprAngle'); el.value = String(a); el.dispatchEvent(new Event('input', { bubbles: true })); if (!NavApp.cprBeams().levels.desc.edge.inRange) return a; } return null; });
    await pg.waitForTimeout(200); const dis = await pg.evaluate((a) => ({ a, disabled: document.getElementById('btnCprEdge').disabled, txt: document.getElementById('cprReadout').textContent, sel: JSON.stringify(NavApp.S.sel) }), aOut);
    ok(dis && dis.disabled && /outside ±60°/.test(dis.txt), 'out-of-range case: ' + JSON.stringify(dis)); const sel0 = dis.sel;
    await pg.evaluate(() => document.getElementById('btnCprEdge').click()); ok((await pg.evaluate(() => JSON.stringify(NavApp.S.sel))) === sel0, 'disabled button must not change the selection');
    console.log('       (' + out.join('; ') + ')');
    await pg.evaluate(() => { const el = document.getElementById('cprAngle'); el.value = '0'; el.dispatchEvent(new Event('input', { bubbles: true })); NavApp.S.selManual = false; NavApp.rerank(); });   // restore automatic selection for the following tests
  });

  // ---------- 4. C-arm ----------
  await pg.click('#tabs button[data-tab=carm]'); await pg.waitForTimeout(600);
  await test('scan equals brute-force explicit projection classification over the whole 121x81 grid', async () => {
    const r = await pg.evaluate(() => { const S = NavApp.S, M = NavApp.M, g = S.scan, pts = ['NL', 'NR', 'LR'].map((k) => S.m.A[k].pos); let mism = 0, valid = 0, n = 0;
      for (let ci = 0; ci < g.nC; ci++) for (let li = 0; li < g.nL; li++) { const lao = -60 + li, cran = -40 + ci, p = M.evalViewProjected(S.axis.C, S.axis.a, pts, lao, cran), k = ci * g.nL + li;
        if (p.degenerate || p.axisSin < Math.sin(10 * Math.PI / 180) * 0 + 0) { continue; }
        const mdeg = M.evalViewFast(S.axis.C, S.axis.a, pts, lao, cran, S.p.minMargin); if (mdeg.degenerate) continue;
        const c = M.classify(p.markers.map((q) => q.s), S.p.minMargin); n++; if (c.valid) valid++; if (c.valid !== !!g.valid[k] || (c.valid && Math.abs(c.margin - g.margin[k]) > 1e-4)) mism++; }
      return { mism, valid, n, best: g.best }; });
    ok(r.mism === 0, r.mism + ' mismatches'); ok(r.valid > 100, 'valid cells ' + r.valid); console.log('       (' + r.n + ' grid views compared, ' + r.valid + ' valid 2:1, best margin ' + r.best.toFixed(2) + ' mm)');
  });
  await test('heat map click selects that projection; lists and diagrams update', async () => {
    const [x, y] = await pg.evaluate(() => { const cv = document.getElementById('cvHeat'); cv.scrollIntoView({ block: 'center' }); const r = cv.getBoundingClientRect(), H = NavViews.HM; return [r.left + (H.ox + (-20 + 60) * H.cell + H.cell / 2) * r.width / cv.width, r.top + (H.oy + (40 - 10) * H.cell + H.cell / 2) * r.height / cv.height]; });
    await pg.mouse.click(x, y); await pg.waitForTimeout(200);
    const sel = await pg.evaluate(() => NavApp.S.sel); ok(sel.lao === -20 && sel.cran === 10, JSON.stringify(sel));
    ok(/RAO 20° \/ CRAN 10°/.test(await pg.textContent('#selBig')));
    ok(/lateral offsets/.test(await pg.textContent('#selInfo')));
  });
  await test('best-ranked projection really is 2:1 (explicit projection check) with margin >= min', async () => {
    await pg.evaluate(() => { const b = NavApp.S.rankBest[0]; NavApp.selectProjection(b.lao, b.cran); }); await pg.waitForTimeout(200);
    const r = await pg.evaluate(() => { const S = NavApp.S, M = NavApp.M, pts = ['NL', 'NR', 'LR'].map((k) => S.m.A[k].pos), p = M.evalViewProjected(S.axis.C, S.axis.a, pts, S.sel.lao, S.sel.cran); const c = M.classify(p.markers.map((q) => q.s), 0); return { c, sel: S.sel, s: p.markers.map((q) => q.s), best: S.rankBest[0] }; });
    ok(r.c.is21, '2:1'); ok(r.c.margin >= 2 - 1e-6); near(r.c.margin, r.best.margin, 1e-3);
    console.log('       best separation: LAO ' + r.sel.lao + ' CRAN ' + r.sel.cran + ' margin ' + r.c.margin.toFixed(2) + ' mm, offsets ' + r.s.map((v) => v.toFixed(1)).join('/'));
  });
  await test('select a practical (small-angle) option and screenshot the C-arm tab', async () => {
    await pg.evaluate(() => { const b = NavApp.S.rankPrac[0]; NavApp.selectProjection(b.lao, b.cran); }); await pg.waitForTimeout(300);
    await pg.screenshot({ path: path.join(shots, '04_carm.png'), fullPage: true });
  });

  // ---------- 5. summary / print ----------
  await pg.click('#tabs button[data-tab=summary]'); await pg.fill('#sumId', 'TEST-001'); await pg.fill('#sumAge', '81'); await pg.waitForTimeout(300);
  await test('summary contains projection + coordinates + disclaimer; no patient name / DICOM IDs', async () => {
    const t = await pg.textContent('#printArea');
    ok(/Selected C-arm projection/.test(t) && /ID: TEST-001/.test(t) && /age 81/.test(t) && /NOT VALIDATED/.test(t) && /A_NL/.test(t) && /H_NR/.test(t) && /LPS/.test(t));
    ok(!/DOE|JANE|SYNTH-ID/.test(t), 'no name/ID leakage');
    ok(/(LAO|RAO)[^/]*\/ (CRAN|CAUD)/.test(t) || /AP|0°/.test(t));
    await pg.screenshot({ path: path.join(shots, '05_summary.png'), fullPage: true });
  });
  await test('print-to-PDF produces a single A4 page', async () => {
    await pg.emulateMedia({ media: 'print' }); const f = path.join(shots, '06_summary_print.pdf');
    await pg.pdf({ path: f, format: 'A4', printBackground: true, margin: { top: '8mm', bottom: '8mm', left: '8mm', right: '8mm' } }); await pg.emulateMedia({ media: 'screen' });
    const info = cp.execSync('pdfinfo "' + f + '"').toString(), pages = +/Pages:\s+(\d+)/.exec(info)[1]; const txt = cp.execSync('pdftotext "' + f + '" -').toString();
    ok(pages === 1, 'pages ' + pages); ok(/Selected C-arm projection/.test(txt) && /TEST-001/.test(txt) && !/DOE|SYNTH-ID/.test(txt) && !/Load CT/.test(txt), 'pdf text');
    cp.execSync('pdftoppm -png -r 70 "' + f + '" "' + path.join(shots, '06_summary_print') + '"');
  });
  await test('session JSON export/import round-trips markers (no image data)', async () => {
    const [dl] = await Promise.all([pg.waitForEvent('download'), pg.evaluate(() => document.getElementById('btnSaveSession').click())]);
    const f = path.join(__dirname, 'out', 'session.json'); await dl.saveAs(f); const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    ok(j.format === 'navitor-align-session' && j.markers.cl.length === ctrl.length && JSON.stringify(j).length < 20000, 'size ' + JSON.stringify(j).length);
    await pg.evaluate(() => document.getElementById('btnClearAll').click()); ok((await pg.evaluate(() => NavApp.S.m.cl.length)) === 0);
    await pg.setInputFiles('#inSession', f); await pg.waitForFunction(() => NavApp.S.m.cl.length === 17 && NavApp.S.scan); 
  });
  await test('Alt+click deletes a marker; Navigate click moves crosshair; wheel scrolls slice', async () => {
    await pg.click('#tabs button[data-tab=mark]'); await pg.waitForTimeout(200);
    const n0 = await pg.evaluate(() => NavApp.S.m.cl.length), P = await pg.evaluate(() => NavApp.S.m.cl[5].slice());
    await pg.click('[data-tool="nav"]'); await pg.keyboard.down('Alt'); await clickAt(pg, 'axial', P); await pg.keyboard.up('Alt');
    ok((await pg.evaluate(() => NavApp.S.m.cl.length)) === n0 - 1, 'deleted');
    const z0 = await pg.evaluate(() => NavApp.S.cross[2]); const [x, y] = await screenPos(pg, 'axial', P); await pg.mouse.move(x, y); await pg.mouse.wheel(0, -100); await pg.waitForTimeout(100);
    ok((await pg.evaluate(() => NavApp.S.cross[2])) > z0, 'slice moved');
  });

  // ---------- 6. synthetic phantom via UI + single-file build from file:// ----------
  const pf = await newPage('file://' + path.join(root, 'index.html'));
  await test('single-file index.html works from file:// : phantom + demo markers -> projection computed', async () => {
    await pf.click('#btnPhantom'); await pf.waitForFunction(() => NavApp.S.vol); await pf.click('#btnDemoMarkers'); await pf.waitForFunction(() => NavApp.S.scan && NavApp.S.sel);
    const r = await pf.evaluate(() => ({ sel: NavApp.S.sel, best: NavApp.S.scan.best, nA: Object.values(NavApp.S.m.A).filter(Boolean).length }));
    ok(r.nA === 3 && r.best > 2, JSON.stringify(r)); await pf.click('#tabs button[data-tab=help]'); await pf.screenshot({ path: path.join(shots, '07_help.png'), fullPage: true });
    await pf.click('#tabs button[data-tab=mark]'); await pf.waitForTimeout(400); await pf.screenshot({ path: path.join(shots, '08_phantom_mark_filescheme.png') });
  });
  // ---------- 3. scrolling / navigation (regression: CT images did not re-render when the crosshair moved) ----------
  const imgHash = (pg, name) => pg.evaluate((name) => { const c = NavApp.views[name].off, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0, nz = 0; for (let i = 0; i < d.length; i += 4) { h = (h * 31 + d[i] + 7 * d[i + 1]) | 0; if (d[i] !== 0x1A) nz++; } return { h, nz }; }, name);   // CT image only (offscreen), not the overlay
  const cross = (pg) => pg.evaluate(() => NavApp.S.cross.slice());
  const centre = (pg, name) => pg.evaluate((n) => { const r = NavApp.views[n].canvas.getBoundingClientRect(); NavApp.views[n].canvas.scrollIntoView({ block: 'center' }); const q = NavApp.views[n].canvas.getBoundingClientRect(); return [q.left + q.width / 2, q.top + q.height / 2]; }, name);
  const kOf = async (pg, name) => +(/^(\d+)\//.exec(await pg.evaluate((n) => NavApp.views[n].bar.lab.textContent, name))[1]);   // 1-based slice number from the k/N label
  const labelOf = (pg, name) => pg.evaluate((n) => NavApp.views[n].bar.lab.textContent, name);
  // synthetic 512x512x500 CT-like volume (0.68 x 0.68 x 0.75 mm, z 800..1174.25 like the reported z~964), every slice different
  async function loadBigVolume(pg, descending) {
    await pg.evaluate((desc) => {
      const nx = 512, ny = 512, nz = 500, data = new Int16Array(nx * ny * nz);
      for (let k = 0; k < nz; k++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) { const r = Math.hypot(x - 256, y - 256); data[(k * ny + y) * nx + x] = r < 200 ? Math.round(150 + 120 * Math.sin((x + 3 * k) * 0.05) * Math.cos(y * 0.04 + k * 0.1)) : -1000; }
      const vol = new NavVolume.Volume({ dims: [nx, ny, nz], data, origin: [-174, -160, desc ? 1174.25 : 800], vi: [0.68, 0, 0], vj: [0, 0.68, 0], vk: [0, 0, desc ? -0.75 : 0.75], info: { desc: 'big' }, warnings: [] });
      NavApp.setVolume(vol, 'synthetic 512x512x500'); NavApp.setTab('mark');
    }, !!descending);
    await pg.waitForTimeout(300);
  }
  const pgs = await newPage('http://127.0.0.1:' + port + '/');
  await test('SCROLL (trackpad): 512x512x500 volume - axial CT image really changes; small fractional deltas accumulate (not 1 slice/event); inertia tail; page does not scroll', async () => {
    await loadBigVolume(pgs, false);
    ok(/^\d+\/500/.test(await labelOf(pgs, 'axial')), 'label ' + await labelOf(pgs, 'axial'));
    const [x, y] = await centre(pgs, 'axial'); await pgs.mouse.move(x, y);
    const h0 = await imgHash(pgs, 'axial'), k0 = await kOf(pgs, 'axial'), sy0 = await pgs.evaluate(() => window.scrollY);
    ok(h0.nz > 20000, 'axial image not blank: ' + h0.nz + ' non-background px');
    for (let i = 0; i < 25; i++) await pgs.mouse.wheel(0, -4);                  // 25 tiny events = 100 px  -> exactly 3 slices
    await pgs.waitForTimeout(150);
    const k1 = await kOf(pgs, 'axial'), h1 = await imgHash(pgs, 'axial');
    ok(k1 - k0 === 3 || (k1 - k0 === 4 && k0 === 1), 'tiny-delta accumulation: 100 px should be 3 slices, got ' + (k1 - k0)); ok(h1.h !== h0.h, 'axial image pixels did not change after trackpad scroll');
    const seq = [40, 38, 34, 30, 26, 22, 18, 15, 12, 9, 7, 5, 4];              // swipe + inertia (sum 260 px -> 8 slices)
    for (const d of seq) { await pgs.mouse.wheel(0, d); await pgs.waitForTimeout(8); }
    await pgs.waitForTimeout(150); const k2 = await kOf(pgs, 'axial'), h2 = await imgHash(pgs, 'axial');
    ok(k1 - k2 === 8, 'inertia sequence (260 px) should move 8 slices caudally, moved ' + (k1 - k2)); ok(h2.h !== h1.h, 'image unchanged after reverse scroll');
    ok(await pgs.evaluate(() => window.scrollY) === sy0, 'page scrolled underneath the view');
    ok(/^\d+\/500/.test(await labelOf(pgs, 'axial')));
  });
  await test('SCROLL: classic mouse notch (deltaY 100) = 1 slice, deltaMode=1 lines (3 lines = 1 slice), works on coronal and sagittal and updates the other views; no click/focus needed', async () => {
    for (const name of ['axial', 'coronal', 'sagittal']) {
      const [x, y] = await centre(pgs, name), ci = { axial: 2, coronal: 1, sagittal: 0 }[name], sg = { axial: 1, coronal: 1, sagittal: -1 }[name];
      await pgs.mouse.move(x, y); await pgs.mouse.wheel(0, -4); await pgs.mouse.wheel(0, 4); await pgs.mouse.wheel(0, -100); await pgs.waitForTimeout(40);   // first step snaps onto a slice plane
      const c0 = await cross(pgs), h0 = await imgHash(pgs, name), kk0 = await kOf(pgs, name);
      await pgs.mouse.wheel(0, -100); await pgs.waitForTimeout(80); const c1 = await cross(pgs), h1 = await imgHash(pgs, name);
      const step = [0.68, 0.68, 0.75][ci]; near(sg * (c1[ci] - c0[ci]), step, 1e-6, name + ' notch step'); ok(h1.h !== h0.h, name + ' image unchanged after wheel'); ok((await kOf(pgs, name)) === kk0 + 1 || (await kOf(pgs, name)) === kk0 - 1, 'k label');
      await pgs.evaluate((n) => { const c = NavApp.views[n].canvas, r = c.getBoundingClientRect(); c.dispatchEvent(new WheelEvent('wheel', { deltaY: -3, deltaMode: 1, clientX: r.left + 50, clientY: r.top + 50, bubbles: true, cancelable: true })); }, name);
      await pgs.waitForTimeout(80); const c2 = await cross(pgs); near(sg * (c2[ci] - c1[ci]), step, 1e-6, name + ' line-mode step');
      const other = await cross(pgs); for (let a = 0; a < 3; a++) if (a !== ci) near(other[a], c0[a], 1e-9, name + ' scroll moved another axis');
    }
  });
  await test('crosshair/click navigation re-renders the other views (sagittal+coronal CT images change when the axial crosshair is moved)', async () => {
    const hs = await imgHash(pgs, 'sagittal'), hc = await imgHash(pgs, 'coronal'); const [x, y] = await centre(pgs, 'axial');
    await pgs.click('[data-tool="nav"]'); await pgs.mouse.click(x + 90, y - 40); await pgs.waitForTimeout(100);
    ok((await imgHash(pgs, 'sagittal')).h !== hs.h, 'sagittal image stale'); ok((await imgHash(pgs, 'coronal')).h !== hc.h, 'coronal image stale');
  });
  await test('KEYBOARD: Up/Down/PageUp/PageDown step the hovered view (Shift = 5), no focus needed; slider + k/N label follow; slider drags the slice', async () => {
    const [x, y] = await centre(pgs, 'coronal'); await pgs.mouse.move(x, y); await pgs.keyboard.press('ArrowUp'); await pgs.keyboard.press('ArrowDown'); const c0 = await cross(pgs), l0 = await labelOf(pgs, 'coronal');
    await pgs.keyboard.press('ArrowUp'); let c = await cross(pgs); near(c[1] - c0[1], 0.68, 1e-6, 'ArrowUp');
    await pgs.keyboard.press('Shift+ArrowDown'); c = await cross(pgs); near(c[1] - c0[1], 0.68 - 5 * 0.68, 1e-6, 'Shift+ArrowDown');
    await pgs.keyboard.press('PageUp'); await pgs.keyboard.press('PageDown'); await pgs.keyboard.press('PageDown'); c = await cross(pgs); near(c[1] - c0[1], 0.68 - 5 * 0.68 - 0.68, 1e-6, 'Page keys');
    ok(c[0] === c0[0] && c[2] === c0[2], 'other axes moved'); ok((await labelOf(pgs, 'coronal')) !== l0, 'label unchanged');
    const [ax, ay] = await centre(pgs, 'axial'); await pgs.mouse.move(ax, ay); await pgs.keyboard.press('ArrowUp'); await pgs.keyboard.press('ArrowDown'); const z0 = (await cross(pgs))[2]; await pgs.keyboard.press('ArrowUp'); near((await cross(pgs))[2] - z0, 0.75, 1e-6, 'hover axial');
    const sl = pgs.locator('.slicebar input[aria-label="Axial slice"]'); await sl.fill('100'); await pgs.waitForTimeout(60);
    near((await cross(pgs))[2], 800 + 100 * 0.75, 1e-6, 'slider k=100'); ok(/^101\/500/.test(await labelOf(pgs, 'axial')), 'label ' + await labelOf(pgs, 'axial'));
    await pgs.screenshot({ path: path.join(shots, '10_mpr_scroll_sliders.png') });
  });
  await test('PINCH (ctrlKey wheel, small deltaY) zooms the view and does NOT scroll slices; zooming does not change the CT slice', async () => {
    const [x, y] = await centre(pgs, 'axial'); await pgs.mouse.move(x, y); const c0 = await cross(pgs), m0 = await pgs.evaluate(() => NavApp.views.axial.mm), h0 = await imgHash(pgs, 'axial');
    await pgs.keyboard.down('Control'); for (let i = 0; i < 6; i++) await pgs.mouse.wheel(0, -8); await pgs.keyboard.up('Control'); await pgs.waitForTimeout(100);
    const c1 = await cross(pgs), m1 = await pgs.evaluate(() => NavApp.views.axial.mm);
    ok(m1 < m0 * 0.7, 'zoom factor ' + (m0 / m1).toFixed(2)); ok(c1.every((v, i) => v === c0[i]), 'pinch moved the slice'); ok((await imgHash(pgs, 'axial')).h !== h0.h, 'zoomed image identical');
    await pgs.keyboard.down('Control'); for (let i = 0; i < 6; i++) await pgs.mouse.wheel(0, 8); await pgs.keyboard.up('Control'); await pgs.waitForTimeout(60);
    near(await pgs.evaluate(() => NavApp.views.axial.mm), m0, m0 * 0.02, 'zoom out returns');
  });
  await test('invert-scroll checkbox reverses wheel direction', async () => {
    let [x, y] = await centre(pgs, 'axial'); await pgs.mouse.move(x, y); const z0 = (await cross(pgs))[2];
    await pgs.check('#chkInvScroll');                                                          // check() may scroll the Cursor panel into view, moving the canvas
    ;([x, y] = await centre(pgs, 'axial')); await pgs.mouse.move(x, y); await pgs.mouse.wheel(0, -100); await pgs.waitForTimeout(60);
    try { ok((await cross(pgs))[2] < z0, 'direction not reversed'); } finally { await pgs.uncheck('#chkInvScroll'); }   // always clear so later wheel tests stay un-inverted
  });
  await test('REAL DICOM path: 500 slices stored head-first (descending IPP + instance numbers) load, k/N correct, wheel-up moves cranially and the image/HU follow the right slice', async () => {
    const sls = [], rows = 160, cols = 160, nz = 500, z0 = 1174.25;
    for (let k = 0; k < nz; k++) { const px = new Uint16Array(rows * cols).fill(1024); const val = 1024 + (k % 400);            // slice index k (in file order) is encoded in the pixel value
      for (let i = 0; i < px.length; i++) px[i] = val + ((i % cols) > 80 ? 5 : 0);
      sls.push({ ipp: [-50, -60, z0 - k * 0.75], iop: [1, 0, 0, 0, 1, 0], ps: [0.7, 0.7], rows, cols, pixels: px, signed: false, slope: 1, intercept: -1024, instance: nz - k }); }
    const files = sls.map((s, k) => ({ name: 'IM' + String(k).padStart(4, '0'), mimeType: 'application/dicom', buffer: W.writeSlice(s, { seriesUID: '7.7.7' }) }));
    await pgs.evaluate(() => { NavApp.S.vol = null; }); await pgs.click('#tabs button[data-tab=load]');
    await pgs.setInputFiles('#inFiles', files); await pgs.waitForFunction(() => NavApp.S.vol && /Loaded 500 slices/.test(document.getElementById('loadStatus').textContent), null, { timeout: 120000 });
    await pgs.click('#tabs button[data-tab=mark]'); await pgs.waitForTimeout(200);
    const lab = await labelOf(pgs, 'axial'); ok(/^\d+\/500/.test(lab), lab);
    const [x, y] = await centre(pgs, 'axial'); await pgs.mouse.move(x, y);
    const huAt = () => pgs.evaluate(() => { const v = NavApp.S.vol; return Math.round(v.sample([v.bbox.centre[0] - 30, v.bbox.centre[1], NavApp.S.cross[2]])); });
    await pgs.mouse.wheel(0, -100); await pgs.mouse.wheel(0, 100); await pgs.waitForTimeout(60);                // snap onto a slice plane
    const zs = (await cross(pgs))[2], k0 = await kOf(pgs, 'axial'), h0 = await imgHash(pgs, 'axial'), hu0 = await huAt();
    for (let i = 0; i < 10; i++) await pgs.mouse.wheel(0, -4);                   // 40 px -> 1 slice superiorly
    await pgs.waitForTimeout(100); const zn = (await cross(pgs))[2], hu1 = await huAt(), h1 = await imgHash(pgs, 'axial');
    near(zn - zs, 0.75, 1e-6, 'one slice cranial'); ok((await kOf(pgs, 'axial')) === k0 + 1, 'k label'); ok(h1.h !== h0.h, 'axial pixels did not change');
    ok(hu1 === hu0 - 1, 'HU follows file order: slice above is file index k-1 -> value -1 (' + hu0 + ' -> ' + hu1 + ')');
    // all slice positions reachable end to end
    for (let i = 0; i < 70; i++) await pgs.keyboard.press('Shift+ArrowUp'); const top = (await cross(pgs))[2]; near(top, 1174.25, 1e-6, 'top end clamps at last slice'); ok(/^500\/500/.test(await labelOf(pgs, 'axial')), await labelOf(pgs, 'axial'));
  });

  // ---------- auto-detect nadirs + colour scheme (synthetic root phantom generated in the page) ----------
  const pga = await newPage('http://127.0.0.1:' + port + '/');
  await pga.evaluate(() => { const g = NavPhantom.generateRoot({ rotDeg: 20, noise: 30 }); window.__g = g; NavApp.setVolume(new NavVolume.Volume(g.volume), 'synthetic aortic root'); NavApp.setTab('mark'); });
  const T = await pga.evaluate(() => window.__g.truth);
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const nadirErr = async () => { const n = await pga.evaluate(() => NavApp.S.m.nadir); return ['NCC', 'LCC', 'RCC'].map((k) => n[k] ? dist(n[k], T.nadir[k]) : null); };
  const HKs = ['NL', 'NR', 'LR'];
  const herrPage = async () => pga.evaluate(([T]) => { const H = NavApp.S.m.H, a = T.axis, out = {}; const sub = (u, v) => u.map((x, i) => x - v[i]), dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
    const perp = (v) => { const h = dot(v, a); return v.map((x, i) => x - h * a[i]); };
    for (const k of ['NL', 'NR', 'LR']) { if (!H[k]) { out[k] = null; continue; } const q1 = perp(sub(T.commissure[k], T.annulusCentre)), q2 = perp(sub(H[k], T.annulusCentre));
      out[k] = { d: Math.hypot(...sub(H[k], T.commissure[k])), ang: Math.acos(Math.min(1, dot(q1, q2) / Math.hypot(...q1) / Math.hypot(...q2))) * 180 / Math.PI }; } return out; }, [T]);
  await test('COLOURS: NCC yellow, LCC red, RCC green; H unchanged (NL red, NR green, LR blue); centreline cyan; centreline != any nadir/H colour', async () => {
    const c = await pga.evaluate(() => ({ n: NavApp.GROUPS.nadir.color, h: NavApp.GROUPS.H.color, cl: NavApp.CL_COLOR }));
    ok(c.n.NCC === '#ffd600' && c.n.LCC === '#d50000' && c.n.RCC === '#00c853', JSON.stringify(c.n)); ok(c.h.NL === '#ff5252' && c.h.NR === '#69f0ae' && c.h.LR === '#448aff', JSON.stringify(c.h)); ok(c.cl === '#00e5ff');
    ok(![...Object.values(c.n), ...Object.values(c.h)].includes(c.cl), 'centreline colour reused');
    const dots = await pga.evaluate(() => [...document.querySelectorAll('#toolList .toolrow')].map((r) => [r.querySelector('.tbtn').textContent, r.querySelector('.dot').style.background]));
    const col = (re) => dots.find((d) => re.test(d[0]))[1];
    ok(/255, 214, 0|ffd600/i.test(col(/NCC/)), col(/NCC/)); ok(/213, 0, 0|d50000/i.test(col(/LCC/)), col(/LCC/)); ok(/0, 200, 83|00c853/i.test(col(/RCC/)), col(/RCC/)); ok(/0, 229, 255|00e5ff/i.test(col(/entreline/)), col(/entreline/));
  });
  await test('auto-detect with NO seed and no centreline: helpful message (no error, no markers)', async () => {
    await pga.click('#btnAutoNadir'); await pga.waitForTimeout(150);
    const t = await pga.textContent('#autoNadirOut'); ok(/starting point|seed/i.test(t), t); ok((await nadirErr()).every((e) => e === null));
  });
  await test('"Set root seed" tool: real click in the axial view sets the seed; "Seed = crosshair" also works', async () => {
    await pga.evaluate((c) => { NavApp.S.cross = c; NavApp.renderNow(); }, T.seed);
    await pga.click('#toolList .tbtn[data-tool=seed]'); const [x, y] = await screenPos(pga, 'axial', T.seed); await pga.mouse.click(x, y); await pga.waitForTimeout(80);
    let sd = await pga.evaluate(() => NavApp.S.seed); ok(sd && dist(sd, T.seed) < 2, 'seed ' + sd); ok(await pga.evaluate(() => NavApp.S.tool) === 'nav');
    await pga.evaluate(() => { NavApp.S.seed = null; NavApp.S.cross = NavApp.S.vol.bbox.centre.slice(); }); await pga.evaluate((c) => { NavApp.S.cross = c.map((v) => v + 0.2); NavApp.renderNow(); }, T.seed);
    await pga.click('#btnSeedCross'); sd = await pga.evaluate(() => NavApp.S.seed); ok(sd && dist(sd, T.seed) < 2, 'seed from crosshair ' + sd);
  });
  await test('Auto-detect nadirs + commissures: 3 nadirs within 3 mm and 3 commissures within 3.5 mm / 6° of the known truth, correct NCC/LCC/RCC labels, confidence badge + EXPERIMENTAL/verify warning', async () => {
    await pga.click('#btnAutoNadir'); await pga.waitForFunction(() => /confidence/i.test(document.getElementById('autoNadirOut').textContent), null, { timeout: 60000 });
    const e = await nadirErr(); console.log('       e2e phantom nadir errors NCC/LCC/RCC (mm): ' + e.map((v) => v.toFixed(2)).join(' / ')); ok(e.every((v) => v !== null && v < 3), e.join());
    const he = await herrPage(); console.log('       e2e phantom H_NL / H_NR / H_LR errors (mm / deg about the true axis): ' + HKs.map((k) => he[k].d.toFixed(2) + ' / ' + he[k].ang.toFixed(1)).join('   |   ')); ok(HKs.every((k) => he[k] && he[k].d < 3.5 && he[k].ang < 6), JSON.stringify(he));
    ok(await pga.evaluate(() => NavApp.S.auto.hsrc.NL === 'auto' && NavApp.S.auto.hsrc.NR === 'auto' && NavApp.S.auto.hsrc.LR === 'auto'), 'H sources not auto');
    const t = await pga.textContent('#autoNadirOut'); ok(/verify/i.test(t) && /EXPERIMENTAL/i.test(t) && /commissures/i.test(t), t);
    ok(/Auto-detect nadirs \+ commissures/.test(await pga.textContent('#btnAutoNadir')) && /nadirs \+ commissures/i.test(await pga.textContent('#markPanel h3:nth-of-type(2)')), 'button/heading not renamed'); ok(await pga.evaluate(() => !!document.querySelector('#autoNadirOut .autoBadge')));
    ok(await pga.evaluate(() => !document.getElementById('btnUndoNadir').disabled && !document.getElementById('btnRotNadir').disabled));
    await pga.screenshot({ path: path.join(shots, '11_auto_nadirs.png') });
  });
  await test('markers remain draggable after auto-detect (real mouse drag marks it manual)', async () => {
    const p0 = await pga.evaluate(() => NavApp.S.m.nadir.LCC.slice()); await setCross(pga, p0); const [x, y] = await screenPos(pga, 'axial', p0);
    await pga.mouse.move(x, y); await pga.mouse.down(); await pga.mouse.move(x + 14, y + 9, { steps: 4 }); await pga.mouse.up(); await pga.waitForTimeout(60);
    const r = await pga.evaluate(() => ({ p: NavApp.S.m.nadir.LCC, src: NavApp.S.auto.src.LCC })); ok(dist(r.p, p0) > 0.5, 'did not move: ' + dist(r.p, p0)); ok(r.src === 'manual', 'src ' + r.src);
    await pga.evaluate((p) => { NavApp.S.m.nadir.LCC = p; NavApp.S.auto.src.LCC = 'auto'; NavApp.onChanged(); }, p0);
  });
  await test('H markers remain draggable after auto-detect (real mouse drag marks it manual, others stay auto)', async () => {
    const p0 = await pga.evaluate(() => NavApp.S.m.H.NR.slice()); await setCross(pga, p0); const [x, y] = await screenPos(pga, 'axial', p0);
    await pga.mouse.move(x, y); await pga.mouse.down(); await pga.mouse.move(x - 12, y + 8, { steps: 4 }); await pga.mouse.up(); await pga.waitForTimeout(60);
    const r = await pga.evaluate(() => ({ p: NavApp.S.m.H.NR, s: NavApp.S.auto.hsrc })); ok(dist(r.p, p0) > 0.5, 'did not move: ' + dist(r.p, p0)); ok(r.s.NR === 'manual' && r.s.NL === 'auto', JSON.stringify(r.s));
    await pga.evaluate((p) => { NavApp.S.m.H.NR = p; NavApp.S.auto.hsrc.NR = 'auto'; NavApp.onChanged(); }, p0);
  });
  await test('Rotate labels cycles the three points cyclically (3 clicks = identity), keeps 3 markers, handedness preserved', async () => {
    const n0 = await pga.evaluate(() => JSON.parse(JSON.stringify(NavApp.S.m.nadir)));
    await pga.click('#btnRotNadir'); const n1 = await pga.evaluate(() => JSON.parse(JSON.stringify(NavApp.S.m.nadir)));
    ok(['NCC', 'LCC', 'RCC'].every((k) => n1[k] && dist(n1[k], n0[k]) > 5), 'labels did not move');
    ok(['NCC', 'LCC', 'RCC'].some((k) => dist(n1[k], n0.NCC) < 1e-6) && ['NCC', 'LCC', 'RCC'].some((k) => dist(n1[k], n0.LCC) < 1e-6));
    // cyclic: RCC->LCC->NCC->RCC order is preserved (each position moved to the next label)
    const nxt = { RCC: 'LCC', LCC: 'NCC', NCC: 'RCC' }, prv = { RCC: 'NCC', LCC: 'RCC', NCC: 'LCC' };
    const same = ['NCC', 'LCC', 'RCC'].every((k) => dist(n1[k], n0[nxt[k]]) < 1e-6), same2 = ['NCC', 'LCC', 'RCC'].every((k) => dist(n1[k], n0[prv[k]]) < 1e-6); ok(same || same2, 'not a cyclic rotation');
    // H labels follow: each H lies angularly between the two cusps its name says (about the true root axis)
    const hb = await pga.evaluate(([T]) => { const dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2], sub = (u, v) => u.map((x, i) => x - v[i]); const ang = (P) => { const q = sub(P, T.annulusCentre), h = dot(q, T.axis), qq = q.map((x, i) => x - h * T.axis[i]); return Math.atan2(dot(qq, T.e2), dot(qq, T.e1)) * 180 / Math.PI; };
      const wr = (x) => Math.abs(((x + 540) % 360) - 180), n = NavApp.S.m.nadir, H = NavApp.S.m.H, pair = { NL: ['NCC', 'LCC'], NR: ['NCC', 'RCC'], LR: ['LCC', 'RCC'] };
      return Object.keys(pair).every((k) => pair[k].every((c) => wr(ang(H[k]) - ang(n[c])) < 80)); }, [T]); ok(hb, 'H labels did not follow the rotated cusp labels');
    ok(await pga.evaluate(() => NavApp.S.auto.hsrc.NL === 'auto'), 'hsrc not rotated');
    await pga.click('#btnRotNadir'); await pga.click('#btnRotNadir'); const n3 = await pga.evaluate(() => NavApp.S.m.nadir);
    ok(['NCC', 'LCC', 'RCC'].every((k) => dist(n3[k], n0[k]) < 1e-6), 'three rotations are not identity');
    const he = await herrPage(); ok(HKs.every((k) => he[k] && he[k].d < 3.5), 'H not back at their commissures after 3 rotations: ' + JSON.stringify(he));
  });
  await test('Undo auto-nadirs restores the previous (empty) state; second undo is disabled', async () => {
    await pga.click('#btnUndoNadir'); ok((await nadirErr()).every((e) => e === null), 'markers not removed'); ok(await pga.evaluate(() => document.getElementById('btnUndoNadir').disabled));
    ok(await pga.evaluate(() => ['NL', 'NR', 'LR'].every((k) => NavApp.S.m.H[k] === null)), 'H markers not removed by undo');
  });
  await test('Undo restores previously hand-placed nadirs (not just empty)', async () => {
    await pga.evaluate(([n, h]) => { NavApp.S.m.nadir.NCC = n.NCC.map((v) => v + 4); NavApp.S.m.H.NL = h.NL.map((v) => v + 7); NavApp.S.m.H.LR = h.LR.map((v) => v - 5); NavApp.onChanged(); }, [T.nadir, T.commissure]);
    const before = await pga.evaluate(() => NavApp.S.m.nadir.NCC.slice()), hBefore = await pga.evaluate(() => JSON.parse(JSON.stringify(NavApp.S.m.H))); await pga.click('#btnAutoNadir'); await pga.waitForFunction(() => /confidence/i.test(document.getElementById('autoNadirOut').textContent), null, { timeout: 60000 });
    ok((await nadirErr()).every((e) => e < 3)); await pga.click('#btnUndoNadir'); const after = await pga.evaluate(() => NavApp.S.m.nadir); ok(dist(after.NCC, before) < 1e-6 && !after.LCC && !after.RCC, 'not restored');
    const hAfter = await pga.evaluate(() => JSON.parse(JSON.stringify(NavApp.S.m.H))); ok(JSON.stringify(hAfter) === JSON.stringify(hBefore) && hAfter.NL && !hAfter.NR && hAfter.LR, 'hand-placed H markers not restored: ' + JSON.stringify(hAfter));
    ok(/replaced|Undo/i.test('Undo'), '');
  });
  await test('session JSON saves + reloads the root seed (and old sessions without a seed still load)', async () => {
    const sd = await pga.evaluate(() => NavApp.S.seed.slice()); const [dl] = await Promise.all([pga.waitForEvent('download'), pga.evaluate(() => document.getElementById('btnSaveSession').click())]);
    const f = path.join(__dirname, 'out', 'session_seed.json'); await dl.saveAs(f); const o = JSON.parse(fs.readFileSync(f, 'utf8')); ok(o.markers.seed && dist(o.markers.seed, sd) < 1e-6, 'seed not in JSON');
    await pga.evaluate(() => { NavApp.S.seed = null; NavApp.onChanged(); }); await pga.setInputFiles('#inSession', f); await pga.waitForFunction(() => NavApp.S.seed, null, { timeout: 10000 });
    ok(dist(await pga.evaluate(() => NavApp.S.seed), sd) < 1e-6);
    delete o.markers.seed; fs.writeFileSync(f, JSON.stringify(o)); await pga.setInputFiles('#inSession', f); await pga.waitForTimeout(300); ok((await pga.evaluate(() => NavApp.S.seed)) === null);
  });
  await test('failure case: seed in air -> friendly message (not an error), markers untouched', async () => {
    await pga.evaluate(() => { NavApp.S.seed = NavApp.S.vol.bbox.centre.map((v, i) => v + [0, 0, 0][i]); const b = NavApp.S.vol.bbox; NavApp.S.seed = [b.lo[0] + 2, b.lo[1] + 2, b.lo[2] + 2]; NavApp.onChanged(); });
    const m0 = JSON.stringify(await pga.evaluate(() => [NavApp.S.m.nadir, NavApp.S.m.H])); await pga.click('#btnAutoNadir'); await pga.waitForTimeout(1500);
    const t = await pga.textContent('#autoNadirOut'); ok(/not|no |couldn|outside|move the seed|try/i.test(t) && !/TypeError|undefined|NaN/.test(t), t); ok(JSON.stringify(await pga.evaluate(() => [NavApp.S.m.nadir, NavApp.S.m.H])) === m0, 'markers changed on failure');
    ok(await pga.evaluate(() => !document.getElementById('btnAutoNadir').disabled), 'button stays usable');
  });
  await test('failure case: the plain tube phantom (no sinuses) -> graceful message, no markers; summary labels auto-detected nadirs as experimental', async () => {
    await pga.evaluate(() => { NavApp.loadPhantom(); NavApp.setTab('mark'); const t = NavApp.S.truth || null; const g = NavApp.S; NavApp.S.seed = NavApp.S.vol.bbox.centre.slice(); NavApp.onChanged(); });
    await pga.click('#btnAutoNadir'); await pga.waitForTimeout(3500);
    const t = await pga.textContent('#autoNadirOut'); ok(t.length > 20 && !/TypeError/.test(t), t); ok((await nadirErr()).every((e) => e === null), 'markers placed on a phantom without sinuses');
    await pga.evaluate(() => { NavApp.demoMarkers(); NavApp.S.auto.src.NCC = 'auto'; NavApp.S.auto.hsrc = { NL: 'auto' }; NavApp.S.auto.result = { confidence: 83 }; NavApp.onChanged(); });
    const sum = await pga.evaluate(() => { NavApp.buildSummary(); return document.getElementById('printArea').textContent; }); ok(/auto-detected \(EXPERIMENTAL, conf 83%\)/.test(sum), sum.slice(0, 300)); ok(/H_NL[^A]*auto-detected \(EXPERIMENTAL/.test(sum) && /H_NR[^A]*user-marked/.test(sum), 'H rows in summary');
    const c = await pga.evaluate(() => document.getElementById('printArea').innerHTML); ok(/ffd600/i.test(c) && /d50000/i.test(c) && /00c853/i.test(c), 'summary nadir colours');
  });

  // ---------- oblique / double-oblique MPR (3mensio-style rotatable crosshair) ----------
  const pgm = await newPage('http://127.0.0.1:' + port + '/');
  const G = [4, 2, 1];
  await pgm.evaluate((G) => { const n = 100, data = new Int16Array(n * n * n), o = -(n - 1) / 2; let p = 0;
    for (let k = 0; k < n; k++) for (let j = 0; j < n; j++) for (let i = 0; i < n; i++, p++) data[p] = Math.round(1000 + G[0] * (o + i) + G[1] * (o + j) + G[2] * (o + k));
    NavApp.setVolume(new NavVolume.Volume({ dims: [n, n, n], data, origin: [o, o, o], vi: [1, 0, 0], vj: [0, 1, 0], vk: [0, 0, 1], info: {} }), 'linear-field test volume'); NavApp.setTab('mark');
    NavApp.S.wl = { c: 1000, w: 1000 }; NavApp.S.cross = [2, -3, 4]; NavApp.fitViews(); NavApp.renderNow(); }, G);
  const mscr = async (pg, name, x, y) => pg.evaluate(([n, x, y]) => { const v = NavApp.views[n]; v.canvas.scrollIntoView({ block: 'center' }); const r = v.canvas.getBoundingClientRect(); return [r.left + x * r.width / v.W, r.top + y * r.height / v.H]; }, [name, x, y]);
  const orient = () => pgm.evaluate(() => JSON.parse(JSON.stringify(NavApp.S.orient)));
  const ang = () => pgm.evaluate(() => NavApp.Q.angles(NavApp.S.orient));
  const imgHU = (name, pts) => pgm.evaluate(([n, pts]) => { const v = NavApp.views[n]; v.draw(); const d = v.off.getContext('2d').getImageData(0, 0, v.W, v.H).data, wl = NavApp.S.wl;
    return pts.map(([x, y]) => { const g = d[(y * v.W + x) * 4], P = v.toWorld(x, y); return { got: g / 255 * wl.w + wl.c - wl.w / 2, want: 1000 + [4, 2, 1][0] * P[0] + [4, 2, 1][1] * P[1] + [4, 2, 1][2] * P[2], P }; }); }, [name, pts]);
  const grid = []; for (let y = 40; y < 420; y += 60) for (let x = 40; x < 420; x += 60) grid.push([x, y]);
  const imgOk = async (name, tol) => { const r = await imgHU(name, grid); const inside = r.filter((q) => Math.abs(q.P[0]) < 48 && Math.abs(q.P[1]) < 48 && Math.abs(q.P[2]) < 48); ok(inside.length > 12, name + ' too few in-volume samples'); const worst = Math.max(...inside.map((q) => Math.abs(q.got - q.want))); ok(worst <= tol, name + ' worst |dHU| ' + worst.toFixed(2)); return inside.length; };
  const mHash = async (name) => pgm.evaluate((n) => { const v = NavApp.views[n]; v.draw(); const d = v.off.getContext('2d').getImageData(0, 0, v.W, v.H).data; let h = 0; for (let i = 0; i < d.length; i += 13) h = (h * 31 + d[i]) | 0; return h; }, name);
  await test('OBLIQUE: crosshair lines have visible end handles inside every MPR view (4 per view), orientation starts at scanner axes, Reset is disabled', async () => {
    for (const n of ['axial', 'coronal', 'sagittal']) { const g = await pgm.evaluate((n) => { const v = NavApp.views[n], cg = NavApp.crossGeom(v); return { hs: cg.lines.flatMap((l) => l.handles), W: v.W, H: v.H }; }, n); ok(g.hs.length === 4 && g.hs.every((h) => h[0] > 0 && h[0] < g.W && h[1] > 0 && h[1] < g.H), n + ' handles ' + JSON.stringify(g.hs)); }
    ok(await pgm.evaluate(() => NavApp.Q.isIdentity(NavApp.S.orient))); ok(await pgm.evaluate(() => document.getElementById('btnResetOrient').disabled)); ok(/not rotated/.test(await pgm.textContent('#orientInfo')));
    await imgOk('axial', 4.2); await imgOk('coronal', 4.2); await imgOk('sagittal', 4.2);
  });
  let ax0, cor0;
  await test('DRAG HANDLE (real mouse) on the axial view by exactly +30°: coronal+sagittal planes rotate 30° about the axial normal, axial image unchanged, all 3 views show the right HU, angles displayed', async () => {
    ax0 = await mHash('axial'); cor0 = await mHash('coronal');
    const g = await pgm.evaluate(() => { const v = NavApp.views.axial, cg = NavApp.crossGeom(v); return { cs: cg.cs, h: cg.lines[0].handles[1], W: v.W, H: v.H }; });
    const dx = g.h[0] - g.cs[0], dy = g.h[1] - g.cs[1], R = Math.hypot(dx, dy), a0 = Math.atan2(dy, dx), a1 = a0 + 30 * Math.PI / 180, to = [g.cs[0] + R * Math.cos(a1), g.cs[1] + R * Math.sin(a1)];
    const [x0, y0] = await mscr(pgm, 'axial', g.h[0], g.h[1]), [x1, y1] = await mscr(pgm, 'axial', to[0], to[1]);
    await pgm.mouse.move(x0, y0); await pgm.mouse.down(); await pgm.mouse.move((x0 + x1) / 2, (y0 + y1) / 2, { steps: 5 }); await pgm.mouse.move(x1, y1, { steps: 5 }); await pgm.mouse.up(); await pgm.waitForTimeout(120);
    const O = await orient(), c = Math.cos(Math.PI / 6), s = Math.sin(Math.PI / 6);
    near(O.X[0], c, 0.01, 'X.x'); near(O.X[1], s, 0.01, 'X.y'); near(O.Z[2], 1, 1e-6, 'Z stays z'); near(Math.abs((await ang()).rot.axial), 30, 0.8, 'axial lines angle');
    ok(/axial 30\.\d°|axial 29\.\d°/.test(await pgm.textContent('#orientInfo')), await pgm.textContent('#orientInfo'));
    ok(!(await pgm.evaluate(() => document.getElementById('btnResetOrient').disabled)));
    ok((await mHash('axial')) === ax0, 'axial image changed while rotating about its own normal'); ok((await mHash('coronal')) !== cor0, 'coronal image did not change');
    const nC = await imgOk('coronal', 4.2), nS = await imgOk('sagittal', 4.2); await imgOk('axial', 4.2); console.log('       rotated 30° via handle: ' + (await ang()).rot.axial.toFixed(2) + '° measured; ' + (nC + nS) + ' coronal/sagittal pixels match the analytic HU field');
    const cr = await pgm.evaluate(() => NavApp.S.cross); near(cr[0], 2, 1e-6); near(cr[1], -3, 1e-6); near(cr[2], 4, 1e-6, 'crosshair must not move when rotating');
    const sc = await pgm.evaluate(() => { const v = NavApp.views.coronal, p = v.toScreen(NavApp.S.cross); return p; }); ok(Math.abs(sc[0] - 230) < 400, 'cross on screen'); await pgm.screenshot({ path: path.join(shots, '12_oblique_rotated.png') });
  });
  await test('rotated-view interactions: wheel steps along the ROTATED normal (1 mm), arrow keys too, cursor/LPS readout + HU follow, W/L + zoom + pan still work', async () => {
    const n = await pgm.evaluate(() => NavApp.mprFrame('coronal').n); near(n[0], -0.5, 0.01, 'coronal normal.x'); near(n[1], Math.cos(Math.PI / 6), 0.01);
    const [mx, my] = await mscr(pgm, 'coronal', 100, 200); await pgm.mouse.move(mx, my); await pgm.mouse.wheel(0, -100); await pgm.mouse.wheel(0, 100); await pgm.waitForTimeout(40);    // snap onto a slice plane of the oblique stack first
    const c0 = await pgm.evaluate(() => NavApp.S.cross.slice()); await pgm.mouse.wheel(0, -100); await pgm.waitForTimeout(80);
    const c1 = await pgm.evaluate(() => NavApp.S.cross.slice()), d = c1.map((v, i) => v - c0[i]); near(Math.hypot(...d), 1, 0.02, 'one notch = 1 mm'); near(Math.abs(d[0] * n[0] + d[1] * n[1] + d[2] * n[2]), 1, 0.02, 'along the normal'); ok(Math.abs(d[2]) < 1e-6, 'no z motion for a z-rotation');
    await pgm.keyboard.press('ArrowDown'); const c2 = await pgm.evaluate(() => NavApp.S.cross.slice()); near(Math.hypot(...c2.map((v, i) => v - c1[i])), 1, 0.02, 'arrow key 1 mm');
    const lab = await pgm.evaluate(() => NavApp.views.coronal.bar.lab.textContent); ok(/oblique/.test(lab), lab);
    // click-navigate in the rotated coronal view -> crosshair = exact patient position under the mouse, readout agrees
    const [px, py] = await mscr(pgm, 'coronal', 300, 150); await pgm.mouse.click(px, py); await pgm.waitForTimeout(60);
    const want = await pgm.evaluate(() => NavApp.views.coronal.toWorld(300, 150)), got = await pgm.evaluate(() => NavApp.S.cross.slice()); ok(Math.hypot(...want.map((v, i) => v - got[i])) < 0.6, 'click -> ' + got + ' want ' + want);
    const info = await pgm.textContent('#cursorInfo'); const hu = +/HU: (-?\d+)/.exec(info)[1]; ok(Math.abs(hu - (1000 + 4 * got[0] + 2 * got[1] + got[2])) <= 1.5, info);
    ok(info.includes(got.map((v) => v.toFixed(1)).join(', ')) || /LPS mm/.test(info), info);
    // W/L (right drag), zoom (ctrl+wheel), pan (shift-drag) in the rotated view
    const wl0 = await pgm.evaluate(() => ({ ...NavApp.S.wl })), [rx, ry] = await mscr(pgm, 'coronal', 200, 300);
    await pgm.mouse.move(rx, ry); await pgm.mouse.down({ button: 'right' }); await pgm.mouse.move(rx + 40, ry + 20, { steps: 3 }); await pgm.mouse.up({ button: 'right' }); const wl1 = await pgm.evaluate(() => ({ ...NavApp.S.wl })); ok(wl1.w !== wl0.w && wl1.c !== wl0.c, 'W/L unchanged');
    await pgm.evaluate((w) => { NavApp.S.wl = w; }, wl0);
    const mm0 = await pgm.evaluate(() => NavApp.views.coronal.mm); await pgm.keyboard.down('Control'); await pgm.mouse.wheel(0, -120); await pgm.keyboard.up('Control'); const mm1 = await pgm.evaluate(() => NavApp.views.coronal.mm); ok(mm1 < mm0, 'zoom did not work');
    const cu0 = await pgm.evaluate(() => NavApp.views.coronal.cu); await pgm.keyboard.down('Shift'); await pgm.mouse.move(rx, ry); await pgm.mouse.down(); await pgm.mouse.move(rx + 50, ry, { steps: 3 }); await pgm.mouse.up(); await pgm.keyboard.up('Shift'); ok(Math.abs((await pgm.evaluate(() => NavApp.views.coronal.cu)) - cu0) > 1, 'pan did not work');
    await imgOk('coronal', 4.2);
  });
  await test('TRANSLATE: dragging a crosshair line body (axial view) moves the crosshair along that plane\'s normal by the dragged distance; orientation unchanged', async () => {
    await pgm.evaluate(() => { NavApp.S.cross = [2, -3, 4]; NavApp.fitViews(); NavApp.renderNow(); });
    const g = await pgm.evaluate(() => { const v = NavApp.views.axial, cg = NavApp.crossGeom(v), f = NavApp.mprFrame('axial'), ln = cg.lines[1]; return { cs: cg.cs, d: ln.d, N: ln.normal, mm: v.mm, sd: [ln.normal[0] * f.u[0] + ln.normal[1] * f.u[1] + ln.normal[2] * f.u[2], ln.normal[0] * f.v[0] + ln.normal[1] * f.v[1] + ln.normal[2] * f.v[2]] }; });
    const O0 = await orient(), t = 90, start = [g.cs[0] + g.d[0] * t, g.cs[1] + g.d[1] * t], mv = 10 / g.mm, end = [start[0] + g.sd[0] * mv, start[1] + g.sd[1] * mv];
    const [x0, y0] = await mscr(pgm, 'axial', start[0], start[1]), [x1, y1] = await mscr(pgm, 'axial', end[0], end[1]);
    await pgm.mouse.move(x0, y0); await pgm.mouse.down(); await pgm.mouse.move(x1, y1, { steps: 6 }); await pgm.mouse.up(); await pgm.waitForTimeout(80);
    const c = await pgm.evaluate(() => NavApp.S.cross.slice()), d = [c[0] - 2, c[1] + 3, c[2] - 4]; near(d[0] * g.N[0] + d[1] * g.N[1] + d[2] * g.N[2], 10, 0.5, 'moved along N'); near(Math.hypot(...d), 10, 0.6, 'distance'); near(d[2], 0, 1e-6);
    const O1 = await orient(); near(O1.X[0], O0.X[0], 1e-9); near(O1.Z[2], 1, 1e-9);
  });
  await test('DOUBLE-OBLIQUE: drag a coronal-view handle by +20°: axial plane tilts 20° from the scanner plane, three planes stay orthogonal, all 3 views still show the analytic HU', async () => {
    const g = await pgm.evaluate(() => { const v = NavApp.views.coronal, cg = NavApp.crossGeom(v); return { cs: cg.cs, h: cg.lines[1].handles[0] }; });
    const dx = g.h[0] - g.cs[0], dy = g.h[1] - g.cs[1], R = Math.hypot(dx, dy), a0 = Math.atan2(dy, dx), a1 = a0 + 20 * Math.PI / 180;
    const [x0, y0] = await mscr(pgm, 'coronal', g.h[0], g.h[1]), [x1, y1] = await mscr(pgm, 'coronal', g.cs[0] + R * Math.cos(a1), g.cs[1] + R * Math.sin(a1));
    await pgm.mouse.move(x0, y0); await pgm.mouse.down(); await pgm.mouse.move(x1, y1, { steps: 8 }); await pgm.mouse.up(); await pgm.waitForTimeout(120);
    const a = await ang(); near(a.tiltAxial, 20, 0.8, 'axial tilt'); const o = await pgm.evaluate(() => NavApp.Q.checkOrtho(NavApp.S.orient)); near(o.dxy, 0, 1e-9); near(o.dxz, 0, 1e-9); near(o.dyz, 0, 1e-9); near(o.det, 1, 1e-9);
    for (const n of ['axial', 'coronal', 'sagittal']) await imgOk(n, 4.2);
    await pgm.screenshot({ path: path.join(shots, '13_oblique_double.png') });
  });
  await test('markers are placed in patient space in rotated views (real click with the Nadir tool): position == the pixel\'s patient position, on the plane through the crosshair; summary/transfer data unaffected', async () => {
    await pgm.click('#toolList .tbtn[data-tool="nadir.NCC"]'); const [px, py] = await mscr(pgm, 'sagittal', 180, 260); await pgm.mouse.click(px, py); await pgm.waitForTimeout(60);
    const r = await pgm.evaluate(() => { const v = NavApp.views.sagittal; return { m: NavApp.S.m.nadir.NCC, want: v.toWorld(180, 260), depth: v.depth(NavApp.S.m.nadir.NCC) }; });
    ok(r.m && Math.hypot(...r.m.map((x, i) => x - r.want[i])) < 0.2, JSON.stringify(r)); ok(Math.abs(r.depth) < 0.2, 'not on the plane: ' + r.depth);
    // drag the marker in the oblique view: stays on the plane, moves with the mouse
    const [sx, sy] = await mscr(pgm, 'sagittal', 180, 260); await pgm.mouse.move(sx, sy); await pgm.mouse.down(); await pgm.mouse.move(sx + 30, sy + 12, { steps: 4 }); await pgm.mouse.up(); await pgm.waitForTimeout(60);
    const r2 = await pgm.evaluate(() => { const v = NavApp.views.sagittal; return { m: NavApp.S.m.nadir.NCC, want: v.toWorld(180 + 30 * v.W / v.canvas.getBoundingClientRect().width, 260 + 12 * v.H / v.canvas.getBoundingClientRect().height), depth: v.depth(NavApp.S.m.nadir.NCC) }; });
    ok(Math.abs(r2.depth) < 0.3 && Math.hypot(...r2.m.map((x, i) => x - r.m[i])) > 1, 'marker did not drag in the oblique view'); ok(await pgm.evaluate(() => NavApp.S.tool) !== undefined);
    await pgm.evaluate(() => { NavApp.S.tool = 'nav'; NavApp.S.m.nadir.NCC = null; NavApp.onChanged(); });
  });
  await test('Reset orientation restores the scanner planes; images identical to the initial ones', async () => {
    await pgm.click('#btnResetOrient'); await pgm.waitForTimeout(80); ok(await pgm.evaluate(() => NavApp.Q.isIdentity(NavApp.S.orient))); ok(await pgm.evaluate(() => document.getElementById('btnResetOrient').disabled));
    for (const n of ['axial', 'coronal', 'sagittal']) await imgOk(n, 4.2);
    const f = await pgm.evaluate(() => [NavApp.mprFrame('axial'), NavApp.mprFrame('coronal'), NavApp.mprFrame('sagittal')]); near(f[0].n[2], 1, 1e-12); near(f[1].n[1], 1, 1e-12); near(f[2].n[0], -1, 1e-12);
  });
  await test('ALIGN TO CENTRELINE (phantom aorta): axial normal == local centreline tangent; markers/projection results unchanged by rotating the view (maths stays in patient space); orientation saved in the session', async () => {
    await pgm.evaluate(() => { NavApp.loadPhantom(); NavApp.demoMarkers(); NavApp.setTab('mark'); });
    const before = await pgm.evaluate(() => ({ m: JSON.stringify(NavApp.S.m), sel: JSON.stringify(NavApp.S.sel), best: JSON.stringify(NavApp.S.rankBest && NavApp.S.rankBest[0]), sD: NavApp.S.sD, sH: NavApp.S.sH }));
    const P = await pgm.evaluate(() => { const cl = NavApp.S.cl, q = NavApp.M.frameAt(cl, cl.length * 0.35); NavApp.S.cross = q.C.slice(); NavApp.fitViews(); NavApp.renderNow(); return { T: q.T, C: q.C }; });
    ok(await pgm.evaluate(() => !document.getElementById('btnAlignCl').disabled)); await pgm.click('#btnAlignCl'); await pgm.waitForTimeout(100);
    const n = await pgm.evaluate(() => NavApp.mprFrame('axial').n); const cosA = Math.abs(n[0] * P.T[0] + n[1] * P.T[1] + n[2] * P.T[2]); ok(cosA > 0.9995, 'axial normal vs tangent cos ' + cosA); ok(n[2] > 0, 'cranial sign');
    const t = await pgm.evaluate(() => NavApp.Q.angles(NavApp.S.orient).tiltAxial); ok(t >= 0, 'tilt ' + t);
    // rotate with a real handle drag too, then verify that nothing patient-space changed
    const g = await pgm.evaluate(() => { const v = NavApp.views.axial, cg = NavApp.crossGeom(v); return { cs: cg.cs, h: cg.lines[0].handles[0] }; });
    const [x0, y0] = await mscr(pgm, 'axial', g.h[0], g.h[1]); await pgm.mouse.move(x0, y0); await pgm.mouse.down(); await pgm.mouse.move(x0 + 25, y0 + 40, { steps: 5 }); await pgm.mouse.up(); await pgm.waitForTimeout(100);
    const after = await pgm.evaluate(() => ({ m: JSON.stringify(NavApp.S.m), sel: JSON.stringify(NavApp.S.sel), best: JSON.stringify(NavApp.S.rankBest && NavApp.S.rankBest[0]), sD: NavApp.S.sD, sH: NavApp.S.sH }));
    ok(before.m === after.m && before.sel === after.sel && before.best === after.best && before.sD === after.sD && before.sH === after.sH, 'patient-space data changed by view rotation');
    await pgm.screenshot({ path: path.join(shots, '14_oblique_align_centreline.png') });
    const [dl] = await Promise.all([pgm.waitForEvent('download'), pgm.evaluate(() => document.getElementById('btnSaveSession').click())]); const f = path.join(__dirname, 'out', 'session_orient.json'); await dl.saveAs(f);
    const o = JSON.parse(fs.readFileSync(f, 'utf8')); ok(o.orient && o.orient.X && o.orient.Z, 'orient not in session'); const keep = await orient();
    await pgm.click('#btnResetOrient'); await pgm.setInputFiles('#inSession', f); await pgm.waitForTimeout(300); const back = await orient(); near(back.Z[0], keep.Z[0], 1e-6); near(back.X[1], keep.X[1], 1e-6);
    await pgm.click('#btnResetOrient');
  });


  // ---------- centreline order: LV apex -> root -> arch -> descending aorta (order checks, either entry order gives identical results, old sessions) ----------
  const pgo = await newPage('http://127.0.0.1:' + port + '/');
  await pgo.evaluate(() => { NavApp.loadPhantom(); NavApp.demoMarkers(); NavApp.setTab('mark'); });
  const snap = async () => { await pgo.waitForTimeout(150); return pgo.evaluate(() => { const S = NavApp.S; return { A: ['NL', 'NR', 'LR'].map((k) => S.m.A[k].pos), sH: S.sH, sD: S.sD, best: S.rankBest.map((b) => [b.lao, b.cran, +b.margin.toFixed(6)]), prac: S.rankPrac.map((b) => [b.lao, b.cran, +b.margin.toFixed(6)]), sel: S.sel, len: S.cl.length, rev: S.clRev, warn: document.getElementById('clWarn').textContent, cl0: S.m.cl[0], cln: S.m.cl[S.m.cl.length - 1] }; }); };
  const maxd = (a, b) => Math.max(...a.A.map((p, i) => Math.hypot(...p.map((v, j) => v - b.A[i][j]))));
  let base;
  await test('centreline UI: heading "Centreline (Apex → descending aorta)"; demo markers are apex-first, no order warning, C1 = apex end, A markers + 2:1 ranking exist', async () => {
    ok(await pgo.evaluate(() => [...document.querySelectorAll('h3')].some((h) => h.textContent === 'Centreline (Apex → descending aorta)')), 'heading');
    base = await snap(); ok(base.warn === '' && base.rev === false, 'warn "' + base.warn + '"'); ok(base.best.length > 0 && base.prac.length > 0, 'ranked results');
    const d = await pgo.evaluate(() => { const S = NavApp.S, M = NavApp.M, c = M.mul(['NL', 'NR', 'LR'].map((k) => S.m.H[k]).reduce((a, p) => M.add(a, p), [0, 0, 0]), 1 / 3); return [M.dist(S.m.cl[0], c), M.dist(S.m.cl[S.m.cl.length - 1], c)]; });
    ok(d[0] < d[1] - 20, 'C1 is the end nearer the root: ' + d.map((x) => x.toFixed(0)));
    ok(base.sD > base.sH, 'descending level is farther from the apex than the annulus: ' + base.sD.toFixed(0) + ' vs ' + base.sH.toFixed(0));
    const lst = await pgo.textContent('#clList'); ok(/C1\s*apex/.test(lst) && /C17\s*desc\./.test(lst), 'list hints: ' + lst.slice(0, 60));
  });
  await test('flow axis for the auto-detect hint = +tangent (apex -> descending): points from the LV towards the arch at the root', async () => {
    const r = await pgo.evaluate(() => { const S = NavApp.S, M = NavApp.M, c = M.mul(['NL', 'NR', 'LR'].map((k) => S.m.H[k]).reduce((a, p) => M.add(a, p), [0, 0, 0]), 1 / 3), q = M.nearestS(S.cl, c), f = NavApp.flowAxisAt(c);
      const lv = M.frameAt(S.cl, Math.max(0, q.s - 15)).C, ao = M.frameAt(S.cl, q.s + 15).C, dir = M.norm(M.sub(ao, lv)); return { dot: M.dot(f, dir), len: M.len(f) }; });
    ok(r.dot > 0.9 && Math.abs(r.len - 1) < 1e-6, JSON.stringify(r));
  });
  await test('reversing the entered points: warning appears (names the apex), results IDENTICAL (A markers, levels, rankings, selection); Reverse again clears the warning', async () => {
    await pgo.click('#btnClReverse'); await pgo.waitForTimeout(100);
    const r = await snap(); ok(r.rev === true && /reversed/.test(r.warn) && /apex/i.test(r.warn), 'warn "' + r.warn + '"');
    ok(JSON.stringify(r.cl0) === JSON.stringify(base.cln) && JSON.stringify(r.cln) === JSON.stringify(base.cl0), 'list really reversed');
    ok(maxd(r, base) < 1e-9, 'A markers differ by ' + maxd(r, base)); ok(r.sH === base.sH && r.sD === base.sD && r.len === base.len, 'levels/length differ');
    ok(JSON.stringify(r.best) === JSON.stringify(base.best) && JSON.stringify(r.prac) === JSON.stringify(base.prac) && JSON.stringify(r.sel) === JSON.stringify(base.sel), 'rankings/selection differ');
    const sum = await pgo.evaluate(() => { NavApp.buildSummary(); return document.getElementById('printArea').textContent; }); ok(/Selected C-arm projection|LAO|RAO/.test(sum));
    await pgo.click('#btnClReverse'); await pgo.waitForTimeout(100);
    const r2 = await snap(); ok(r2.warn === '' && r2.rev === false && maxd(r2, base) < 1e-9, 'back to the original: "' + r2.warn + '"');
  });
  await test('order check falls back to height (z) without root markers; still warns on a reversed list and results stay unchanged once markers return', async () => {
    const H = await pgo.evaluate(() => { const S = NavApp.S, h = JSON.parse(JSON.stringify(S.m.H)), n = JSON.parse(JSON.stringify(S.m.nadir)); S.m.cl.reverse(); S.m.H = { NL: null, NR: null, LR: null }; S.m.nadir = { NCC: null, LCC: null, RCC: null }; NavApp.onChanged(); window.__keep = { h, n }; });
    await pgo.waitForTimeout(150); const Hw = await pgo.evaluate(() => document.getElementById('clWarn').textContent);
    ok(/reversed/.test(Hw) && /lower \(z\)/.test(Hw), 'z fallback warning "' + Hw + '"');
    await pgo.evaluate(() => { const S = NavApp.S; S.m.cl.reverse(); NavApp.onChanged(); }); await pgo.waitForTimeout(150); ok((await pgo.evaluate(() => document.getElementById('clWarn').textContent)) === '', 'no warning for apex-first without root markers');
    await pgo.evaluate(() => { const S = NavApp.S; S.m.H = window.__keep.h; S.m.nadir = window.__keep.n; S.m.A = { NL: null, NR: null, LR: null }; S.selManual = false; NavApp.onChanged(); });
    const r = await snap(); ok(maxd(r, base) < 1e-9 && JSON.stringify(r.best) === JSON.stringify(base.best), 'results after re-adding markers differ');
  });
  await test('"Align to centreline" gives the same orientation whichever way the points were entered (cranial-pointing axial normal)', async () => {
    const al = () => pgo.evaluate(() => { const S = NavApp.S, M = NavApp.M; S.cross = M.frameAt(S.cl, S.sH).C.slice(); NavApp.alignToCentreline(); return JSON.parse(JSON.stringify(S.orient)); });
    const o1 = await al(); await pgo.click('#btnClReverse'); const o2 = await al(); await pgo.click('#btnClReverse'); await pgo.evaluate(() => NavApp.resetOrient());
    ok(o1.Z[2] > 0 && o2.Z[2] > 0, 'axial normal points cranially'); for (const k of ['X', 'Y', 'Z']) o1[k].forEach((v, i) => near(v, o2[k][i], 1e-9, 'orient ' + k));
  });
  await test('session v2: saves clOrder "apex-first"; reloading is lossless; OLD sessions (bifurcation -> apex, no clOrder) are detected and reversed, with levels converted, giving identical results', async () => {
    const [dl] = await Promise.all([pgo.waitForEvent('download'), pgo.evaluate(() => document.getElementById('btnSaveSession').click())]);
    const f = path.join(__dirname, 'out', 'session_v2.json'); await dl.saveAs(f); const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    ok(j.version === 2 && j.clOrder === 'apex-first', 'version/clOrder ' + j.version + ' ' + j.clOrder); ok(JSON.stringify(j.markers.cl) === JSON.stringify(base.cl0 && (await pgo.evaluate(() => NavApp.S.m.cl))), 'cl saved as is');
    // an old-format file: reversed centreline, no clOrder, version 1, user-set levels measured from the old (bifurcation) end
    const old = JSON.parse(JSON.stringify(j)); old.version = 1; delete old.clOrder; old.markers.cl.reverse(); delete old.markers.A; old.params.annAuto = false; old.params.annS = base.len - base.sH; old.params.descS = base.len - base.sD - 20;
    const fo = path.join(__dirname, 'out', 'session_v1_old.json'); fs.writeFileSync(fo, JSON.stringify(old));
    await pgo.evaluate(() => { document.getElementById('btnClearAll').click(); });
    await pgo.setInputFiles('#inSession', fo); await pgo.waitForFunction(() => NavApp.S.m.cl.length === 17 && NavApp.S.scan);
    const st = await pgo.textContent('#loadStatus'); ok(/converted from bifurcation → apex/.test(st), st);
    const r = await snap(); ok(r.rev === false && r.warn === '', 'after conversion the list is apex-first: "' + r.warn + '"'); ok(JSON.stringify(r.cl0) === JSON.stringify(base.cl0), 'C1 is the apex end again');
    near(r.sH, base.sH, 1e-6, 'annulus level converted'); near(r.sD, base.sD + 20, 1e-6, 'descending level converted (+20 mm toward the descending aorta)');
    // old session whose centreline is already apex-first: kept
    const keep = JSON.parse(JSON.stringify(j)); keep.version = 1; delete keep.clOrder; const fk = path.join(__dirname, 'out', 'session_v1_apexfirst.json'); fs.writeFileSync(fk, JSON.stringify(keep));
    await pgo.setInputFiles('#inSession', fk); await pgo.waitForFunction(() => /already looks apex-first/.test(document.getElementById('loadStatus').textContent)); ok(JSON.stringify((await snap()).cl0) === JSON.stringify(base.cl0), 'kept');
    // new file loads without any conversion note
    await pgo.setInputFiles('#inSession', f); await pgo.waitForFunction(() => /Markers loaded\.$/.test(document.getElementById('loadStatus').textContent));
    const r3 = await snap(); ok(maxd(r3, base) < 1e-9, 'v2 reload lossless');
  });
  await test('auto-detect from the centreline alone scans the APEX end (first 70 mm): synthetic root, centreline entered apex-first AND reversed -> same nadirs (< 3 mm from truth)', async () => {
    const pgr = await newPage('http://127.0.0.1:' + port + '/');
    await pgr.evaluate(() => { const g = NavPhantom.generateRoot({ rotDeg: 20, noise: 30 }); window.__g = g; NavApp.setVolume(new NavVolume.Volume(g.volume), 'synthetic aortic root'); NavApp.setTab('mark'); });
    const Tr = await pgr.evaluate(() => window.__g.truth), a = Tr.axis, C0 = Tr.annulusCentre, pt = (t) => C0.map((v, i) => Math.round((v + a[i] * t) * 10) / 10);
    const e1 = Tr.e1, up = (q, d, u) => q.map((v, i) => Math.round((v + d * e1[i] + u * (i === 2 ? 1 : 0)) * 10) / 10), top = pt(80);
    const apexFirst = [pt(-45), pt(-20), pt(5), pt(40), top, up(top, 40, 15), up(top, 90, -20), up(top, 95, -110), up(top, 95, -220)];   // LV (below the annulus) -> root -> ascending aorta -> arch -> descending aorta (the phantom axis points along the flow)
    const flow = await pgr.evaluate(([c, C0]) => { NavApp.S.m.cl = c; NavApp.onChanged(); return NavApp.flowAxisAt(C0); }, [apexFirst, C0]);
    ok(flow[0] * a[0] + flow[1] * a[1] + flow[2] * a[2] > 0.99, 'flow axis ' + flow);
    const res = [];
    for (const order of [apexFirst, apexFirst.slice().reverse()]) {
      await pgr.evaluate(([c]) => { NavApp.S.m.cl = c; NavApp.S.m.nadir = { NCC: null, LCC: null, RCC: null }; NavApp.S.m.H = { NL: null, NR: null, LR: null }; NavApp.S.seed = null; NavApp.onChanged(); }, [order]);
      await pgr.click('#btnAutoNadir'); await pgr.waitForFunction(() => !document.getElementById('btnAutoNadir').disabled, null, { timeout: 60000 }); await pgr.waitForTimeout(200);
      res.push(await pgr.evaluate(() => ({ n: NavApp.S.m.nadir, txt: document.getElementById('autoNadirOut').textContent })));
    }
    for (const r of res) for (const k of ['NCC', 'LCC', 'RCC']) { ok(r.n[k], 'nadir ' + k + ' missing: ' + r.txt.slice(0, 200)); ok(dist(r.n[k], Tr.nadir[k]) < 3, k + ' err ' + dist(r.n[k], Tr.nadir[k]).toFixed(2)); }
    ok(JSON.stringify(res[0].n) === JSON.stringify(res[1].n), 'nadirs differ between entry orders');
  });

  // ---------- best-suggestion highlight: GREEN + BOLD with sufficient contrast (C-arm tab selected projection, rank-1 rows, printed summary) ----------
  const pgg = await newPage('http://127.0.0.1:' + port + '/');
  await pgg.evaluate(() => { NavApp.loadPhantom(); NavApp.demoMarkers(); });
  await pgg.click('#tabs button[data-tab=carm]'); await pgg.waitForTimeout(700);
  const styleOf = (sel) => pgg.evaluate((sel) => {
    const el = document.querySelector(sel); if (!el) return null;
    const rgb = (c) => { const m = /rgba?\(([^)]+)\)/.exec(c); const v = m[1].split(',').map((x) => parseFloat(x)); return { r: v[0], g: v[1], b: v[2], a: v.length > 3 ? v[3] : 1 }; };
    const lin = (u) => { u /= 255; return u <= 0.03928 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4); }, lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
    let bg = null; for (let e = el; e; e = e.parentElement) { const c = rgb(getComputedStyle(e).backgroundColor); if (c.a > 0.95) { bg = c; break; } }
    if (!bg) bg = { r: 255, g: 255, b: 255 };
    const cs = getComputedStyle(el), fg = rgb(cs.color), L1 = lum(fg), L2 = lum(bg);
    return { weight: +cs.fontWeight, color: [fg.r, fg.g, fg.b], bg: [bg.r, bg.g, bg.b], contrast: (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05), text: el.textContent };
  }, sel);
  const isGreen = (c) => c[1] >= 150 && c[1] > c[0] + 60 && c[1] > c[2] + 40;
  await test('suggested projection line (C-arm tab "Selected projection" angles) is GREEN and BOLD with contrast >= 7:1 on the dark theme', async () => {
    const st = await styleOf('#selBig'); ok(/LAO|RAO/.test(st.text) && /CRAN|CAUD/.test(st.text), 'text ' + st.text);
    ok(st.weight >= 700, 'weight ' + st.weight); ok(isGreen(st.color), 'colour ' + st.color); ok(st.contrast >= 7, 'contrast ' + st.contrast.toFixed(2) + ' on ' + st.bg);
    console.log('       (selected projection "' + st.text + '": weight ' + st.weight + ', rgb(' + st.color + ') on rgb(' + st.bg + '), contrast ' + st.contrast.toFixed(1) + ':1)');
  });
  await test('best-suggestion rows (rank 1 of the best-separation and practical lists) are green+bold with good contrast; other ranks are not highlighted', async () => {
    const n = await pgg.evaluate(() => document.querySelectorAll('#rankTables b.sugg').length); ok(n === 2, 'expected 2 highlighted rows, found ' + n);
    for (let i = 1; i <= 2; i++) { const st = await styleOf('#rankTables table:nth-of-type(' + i + ') b.sugg'); ok(st && st.weight >= 700 && isGreen(st.color) && st.contrast >= 4.5, 'row style ' + JSON.stringify(st)); }
    const other = await pgg.evaluate(() => { const rows = [...document.querySelectorAll('#rankTables tr[data-lao]')].filter((r) => !r.querySelector('b.sugg')); const c = getComputedStyle(rows[0].querySelector('b')).color; return { n: rows.length, c }; });
    ok(other.n > 0 && !/rgb\(0, 230, 118\)/.test(other.c), 'non-best rows must not be green: ' + JSON.stringify(other));
  });
  await test('printed summary (print media, white paper): selected projection angle line is bold green with contrast >= 4.5:1; best entries in "Alternatives" are green too; still exactly one page', async () => {
    await pgg.click('#tabs button[data-tab=summary]'); await pgg.waitForTimeout(500); await pgg.emulateMedia({ media: 'print' });
    const st = await styleOf('#printArea .big'); ok(st && /LAO|RAO/.test(st.text), 'text ' + (st && st.text));
    ok(st.weight >= 700, 'weight ' + st.weight); ok(st.color[1] > st.color[0] + 40 && st.color[1] > st.color[2] + 40, 'colour ' + st.color); ok(st.contrast >= 4.5 && st.bg.every((v) => v === 255), 'contrast ' + st.contrast.toFixed(2) + ' on ' + st.bg);
    const sumTxt = await pgg.evaluate(() => document.getElementById('printArea').textContent); ok(/arc length from the LV apex end/.test(sumTxt) && !/from bifurcation/.test(sumTxt), 'summary level wording');
    const alt = await styleOf('#printArea b.sugg'); ok(alt && alt.weight >= 700 && alt.contrast >= 4.5, 'alternatives ' + JSON.stringify(alt));
    const f = path.join(__dirname, 'out', 'summary_green.pdf'); await pgg.pdf({ path: f, format: 'A4', printBackground: true, margin: { top: '8mm', bottom: '8mm', left: '8mm', right: '8mm' } });
    ok(/Pages:\s+1\b/.test(cp.execSync('pdfinfo "' + f + '"').toString()), 'summary must stay one page'); await pgg.emulateMedia({ media: 'screen' });
    console.log('       (printed angle "' + st.text + '": weight ' + st.weight + ', rgb(' + st.color + ') on white, contrast ' + st.contrast.toFixed(1) + ':1)');
  });


  // ---------- Overlap projection panel (Transfer tab): "Overlap projection (2 right / 1 left)" ----------
  await pgg.click('#tabs button[data-tab=transfer]'); await pgg.waitForTimeout(700);
  await test('Transfer tab has the panel "Overlap projection (2 right / 1 left)" with entries: overlapping markers, angles, residual, separation, range flag, schematic canvas and "Use in C-arm tab" button', async () => {
    const t = await pgg.textContent('#ovPanel h2'); ok(t === 'Overlap projection (2 right / 1 left)', 'title ' + t);
    ok(await pgg.isVisible('#ovPanel'), 'panel visible on the Transfer tab');
    const rows = await pgg.evaluate(() => [...document.querySelectorAll('#ovBody .ovrow')].map((r) => ({ txt: r.textContent, canvas: !!r.querySelector('canvas'), btn: r.querySelector('button[data-ovuse]') ? r.querySelector('button[data-ovuse]').textContent : null })));
    ok(rows.length >= 1, 'entries: ' + rows.length);
    for (const r of rows) { ok(/A_\w\w \+ A_\w\w overlap right, A_\w\w left/.test(r.txt), 'overlap description: ' + r.txt.slice(0, 80)); ok(/(LAO|RAO)[^/]*\/ (CRAN|CAUD)/.test(r.txt), 'angles'); ok(/overlap residual \d+\.\d\d mm/.test(r.txt) && /\d+\.\d mm from the pair/.test(r.txt), 'residual + separation'); ok(/within|outside/.test(r.txt), 'range flag'); ok(r.canvas && r.btn === 'Use in C-arm tab', 'canvas + button'); }
    const noteTxt = await pgg.textContent('#ovBody'); ok(/image <b>RIGHT<\/b>|image RIGHT/.test(noteTxt) || /RIGHT/.test(noteTxt), 'convention stated');
    await pgg.locator('#ovPanel').scrollIntoViewIfNeeded(); await pgg.screenshot({ path: path.join(shots, '16_overlap_projection_panel.png') });
  });
  await test('overlap values are consistent with an independent projection in the browser: the pair projects onto one point (< 0.5 mm), lies to the image RIGHT of the lone marker, ranking in-range first / small angles first', async () => {
    const r = await pgg.evaluate(() => {
      const M = NavApp.M, S = NavApp.S, ov = NavApp.overlapInfo(), f = M.frameAt(S.cl, S.sD), A = ['NL', 'NR', 'LR'].map((k) => S.m.A[k].pos);
      const lat = (P, lao, cran) => { const ap = M.project(f.T, lao, cran), l = Math.hypot(ap[0], ap[1]); let ux = ap[0] / l, uy = ap[1] / l; if (uy < 0) { ux = -ux; uy = -uy; } const q = M.project(M.sub(P, f.C), lao, cran); return q[0] * uy - q[1] * ux; };
      return { n: ov.items.length, best: ov.best && ov.best.label, items: ov.items.map((it) => { const a = M.project(A[it.pair[0]], it.lao, it.cran), b = M.project(A[it.pair[1]], it.lao, it.cran);
        return { label: it.label, ov: Math.hypot(a[0] - b[0], a[1] - b[1]), res: it.residual, right: (lat(A[it.pair[0]], it.lao, it.cran) + lat(A[it.pair[1]], it.lao, it.cran)) / 2 - lat(A[it.lone], it.lao, it.cran), burden: it.burden, inRange: it.inRange, shown: document.querySelectorAll('#ovBody .ovrow')[it.rank - 1].textContent.includes(it.label) }; }) };
    });
    ok(r.n >= 1 && r.best, 'has a best suggestion'); r.items.forEach((it) => { ok(it.ov < 0.5 && Math.abs(it.ov - it.res) < 1e-6, 'overlap ' + it.ov); ok(it.right > 2, 'pair right of lone: ' + it.right); ok(it.shown, 'displayed ' + it.label); });
    const key = r.items.map((i) => (i.inRange ? 0 : 1000) + i.burden); ok(key.every((v, n) => n === 0 || key[n - 1] <= v), 'ranking order');
    console.log('       (phantom + demo markers, overlap suggestions: ' + r.items.map((i) => i.label + ' res ' + i.res.toFixed(2) + ' mm').join(' | ') + ')');
  });
  await test('best overlap suggestion angle text (#ovBig and the rank-1 entry) is GREEN and BOLD (computed style) with contrast >= 7:1 on the dark theme; other entries are not green', async () => {
    const big = await styleOf('#ovBig'); ok(big && /LAO|RAO/.test(big.text) && /CRAN|CAUD/.test(big.text), 'text ' + (big && big.text));
    ok(big.weight >= 700, 'weight ' + big.weight); ok(isGreen(big.color), 'colour ' + big.color); ok(big.contrast >= 7, 'contrast ' + big.contrast.toFixed(2));
    const row = await styleOf('#ovBody .ovrow b.sugg'); ok(row && row.weight >= 700 && isGreen(row.color) && row.contrast >= 7 && row.text === big.text, 'row ' + JSON.stringify(row));
    const n = await pgg.evaluate(() => document.querySelectorAll('#ovBody b.sugg').length); ok(n === 1, 'only the best entry is highlighted, found ' + n);
    const same = await pgg.evaluate(() => { const a = getComputedStyle(document.getElementById('ovBig')), b = getComputedStyle(document.getElementById('selBig')); return a.color === b.color && a.fontWeight === b.fontWeight && a.fontSize === b.fontSize; }); ok(same, 'same styling as #selBig');
    console.log('       (overlap suggestion "' + big.text + '": weight ' + big.weight + ', rgb(' + big.color + ') on rgb(' + big.bg + '), contrast ' + big.contrast.toFixed(1) + ':1)');
  });
  await test('schematic fluoro view is drawn (dark screen, coloured diamonds, not blank) for every entry', async () => {
    const r = await pgg.evaluate(() => [...document.querySelectorAll('#ovBody canvas')].map((cv) => { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; let col = 0, dark = 0; for (let i = 0; i < d.length; i += 4) { const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]); if (mx < 30) dark++; else if (mx - mn > 80) col++; } return { col, dark, n: d.length / 4 }; }));
    ok(r.length >= 1); r.forEach((x) => { ok(x.dark > 0.7 * x.n, 'dark screen ' + x.dark / x.n); ok(x.col > 150, 'coloured marker pixels ' + x.col); });
  });
  await test('"Use in C-arm tab" button selects exactly that angle in the C-arm tab (selected projection updates, marked manual); an out-of-range entry would be disabled', async () => {
    const before = await pgg.evaluate(() => NavApp.overlapInfo().items.map((i) => ({ lao: i.lao, cran: i.cran, label: i.label, inRange: i.inRange })));
    const k = before.length - 1; ok(before[k].inRange, 'last entry in range');
    await pgg.click(`#ovBody button[data-ovuse="${k + 1}"]`); await pgg.waitForTimeout(300);
    let st = await pgg.evaluate(() => ({ sel: NavApp.S.sel, man: NavApp.S.selManual, cur: [...document.querySelectorAll('#ovBody .ovcur')].map((e) => e.textContent) }));
    ok(st.sel.lao === before[k].lao && st.sel.cran === before[k].cran && st.man, 'selection ' + JSON.stringify(st.sel)); ok(/currently selected/.test(st.cur[k]) && !st.cur.some((c, i) => i !== k && c), 'selected marker shown only on that entry: ' + JSON.stringify(st.cur));
    await pgg.click('#ovBody button[data-ovuse="1"]'); await pgg.waitForTimeout(300);
    await pgg.click('#tabs button[data-tab=carm]'); await pgg.waitForTimeout(500);
    const big = await pgg.textContent('#selBig'); ok(big === before[0].label, 'C-arm tab shows ' + big + ' expected ' + before[0].label);
    const ev = await pgg.evaluate(() => { const e = NavApp.selEval(), A = ['NL', 'NR', 'LR'], b = NavApp.overlapInfo().best; return { s: e.s, pair: b.pair, lone: b.lone, is21: e.is21, valid: e.valid, margin: e.margin, info: document.getElementById('selInfo').textContent.split('\n')[0] }; });
    ok(Math.abs(ev.s[ev.pair[0]] - ev.s[ev.pair[1]]) < 0.3 && (ev.s[ev.pair[0]] + ev.s[ev.pair[1]]) / 2 > ev.s[ev.lone] + 2, 'C-arm tab (existing lateral-offset logic) agrees: pair overlapped (' + ev.s.map((v) => v.toFixed(2)) + ') and to the image right of the lone marker');
    console.log('       (selected in C-arm tab: ' + ev.info + ' | existing 2:1 status: is21=' + ev.is21 + ' valid=' + ev.valid + ' margin ' + ev.margin.toFixed(1) + ' mm)');
    await pgg.screenshot({ path: path.join(shots, '17_overlap_used_in_carm.png'), fullPage: true });
    const vals = await pgg.evaluate(() => [document.getElementById('selLao').value, document.getElementById('selCran').value]); ok(+vals[0] === before[0].lao && +vals[1] === before[0].cran, 'angle inputs ' + vals);
    await pgg.click('#tabs button[data-tab=transfer]'); await pgg.waitForTimeout(400);
  });
  await test('printed summary includes the best overlap projection (bold green on white, contrast >= 4.5:1; angle text equals the Transfer-tab best), still exactly one page', async () => {
    const best = await pgg.evaluate(() => NavApp.overlapInfo().best.label);
    await pgg.click('#tabs button[data-tab=summary]'); await pgg.waitForTimeout(500); await pgg.emulateMedia({ media: 'print' });
    const h = await pgg.evaluate(() => [...document.querySelectorAll('#printArea h2')].map((e) => e.textContent)); ok(h.includes('Overlap projection (2 right / 1 left)'), 'headings ' + h.join('|'));
    const st = await styleOf('#printArea .ovbig b.sugg'); ok(st && st.text === best, 'printed text ' + (st && st.text) + ' vs ' + best); ok(st.weight >= 700, 'weight ' + st.weight);
    ok(st.color[1] > st.color[0] + 40 && st.color[1] > st.color[2] + 40, 'green ' + st.color); ok(st.contrast >= 4.5 && st.bg.every((v) => v === 255), 'contrast ' + st.contrast.toFixed(2));
    const txt = await pgg.evaluate(() => document.querySelector('#printArea .ovbig').parentElement.textContent); ok(/overlap right, A_\w\w left/.test(txt) && /overlap residual \d+\.\d\d mm/.test(txt) && /to the image left of the pair/.test(txt), 'summary text: ' + txt.slice(0, 200));
    const f = path.join(__dirname, 'out', 'summary_overlap.pdf'); await pgg.pdf({ path: f, format: 'A4', printBackground: true, margin: { top: '8mm', bottom: '8mm', left: '8mm', right: '8mm' } });
    ok(/Pages:\s+1\b/.test(cp.execSync('pdfinfo "' + f + '"').toString()), 'summary must stay one page'); await pgg.emulateMedia({ media: 'screen' });
    console.log('       (printed overlap projection "' + st.text + '": weight ' + st.weight + ', rgb(' + st.color + ') on white, contrast ' + st.contrast.toFixed(1) + ':1)');
  });
  // degenerate / unreachable cases on a separate page
  const pgd = await newPage('http://127.0.0.1:' + port + '/');
  await pgd.evaluate(() => { NavApp.loadPhantom(); NavApp.demoMarkers(); }); await pgd.click('#tabs button[data-tab=transfer]'); await pgd.waitForTimeout(600);
  const setA = (P) => pgd.evaluate((P) => { ['NL', 'NR', 'LR'].forEach((k, i) => { NavApp.S.m.A[k] = { pos: P[i], manual: true }; }); NavApp.onChanged(); }, P);
  await test('collinear A markers -> clear "Degenerate marker geometry … collinear" message, no suggestion, no green text', async () => {
    const P = await pgd.evaluate(() => { const M = NavApp.M, S = NavApp.S, f = M.frameAt(S.cl, S.sD); return [-10, 0, 10].map((t) => M.add(f.C, M.add(M.mul(f.N1, t), M.mul(f.N2, 0.3 * t)))); });
    await setA(P); await pgd.waitForTimeout(500);
    const t = await pgd.textContent('#ovBody'); ok(/Degenerate marker geometry/.test(t) && /collinear/.test(t), 'message: ' + t.slice(-250)); ok(!(await pgd.$('#ovBig')) && !(await pgd.$('#ovBody b.sugg')) && !(await pgd.$('#ovBody .ovrow')), 'nothing suggested');
  });
  await test('overlap beams outside the C-arm range only -> message names the range, entries flagged, button DISABLED, no green best suggestion; the summary then says so', async () => {
    const found = await pgd.evaluate(() => { const M = NavApp.M, S = NavApp.S, f = M.frameAt(S.cl, S.sD);
      for (const sg of [1, -1]) for (let t = 0; t < 360; t += 2) { const d = M.add(M.mul(f.N1, Math.cos(t * M.D2R)), M.mul(f.N2, Math.sin(t * M.D2R))), nr = M.cross(f.T, d), c = M.add(f.C, M.mul(nr, 2 * sg));
        const P = [M.add(c, M.mul(d, 9)), M.sub(c, M.mul(d, 9)), M.sub(f.C, M.mul(nr, 8 * sg))], r = M.overlapProjections(f.C, f.T, P, { minSep: 2 }); if (r.status === 'out-of-range') return { P, labels: r.items.map((i) => i.label) }; }
      return null; });
    ok(found, 'a purely out-of-range configuration was constructed'); await setA(found.P); await pgd.waitForTimeout(500);
    const r = await pgd.evaluate(() => ({ t: document.getElementById('ovBody').textContent, big: !!document.getElementById('ovBig'), sugg: document.querySelectorAll('#ovBody b.sugg').length, dis: [...document.querySelectorAll('#ovBody button[data-ovuse]')].map((b) => b.disabled), best: NavApp.overlapInfo().best }));
    ok(/outside the C-arm range/.test(r.t) && /⚠/.test(r.t), 'message: ' + r.t.slice(-300)); ok(!r.big && r.sugg === 0 && r.best === null, 'no green suggestion'); ok(r.dis.length >= 1 && r.dis.every(Boolean), 'buttons disabled ' + r.dis);
    await pgd.click('#tabs button[data-tab=summary]'); await pgd.waitForTimeout(400); const s = await pgd.textContent('#printArea'); ok(/Overlap projection \(2 right \/ 1 left\)/.test(s) && /outside the C-arm range/.test(s), 'summary mentions unreachable');
    await pgd.click('#tabs button[data-tab=transfer]');
  });
  await test('no A markers yet -> panel explains that all three A markers are needed (fresh page)', async () => {
    const pgn = await newPage('http://127.0.0.1:' + port + '/'); await pgn.click('#tabs button[data-tab=transfer]'); await pgn.waitForTimeout(400);
    ok(await pgn.isVisible('#ovPanel') && /Overlap projection \(2 right \/ 1 left\)/.test(await pgn.textContent('#ovPanel h2')), 'panel title'); const t = await pgn.textContent('#ovBody'); ok(/needs all three A markers/.test(t), t.slice(-120)); ok(!(await pgn.$('#ovBig')), 'no suggestion');
  });

  await test('no external network requests were made (only local server / file / blob / data)', async () => {
    const bad = requests.filter((u) => !/^(http:\/\/127\.0\.0\.1:|file:|blob:|data:)/.test(u)); ok(bad.length === 0, bad.join(','));
  });
  await test('no uncaught JS errors / console errors in any page', async () => { ok(errors.length === 0, errors.join('\n')); });
  await browser.close(); summary();
})().catch((e) => { console.error('E2E crashed', e); process.exit(2); });
