// Decoder checks: hand-written lossless JPEG (SOF3) / baseline JPEG / RLE decoders, encapsulated pixel data, series scan at scale.
// Needs tests/out/* produced by: node tests/make_sample_dicom.js; node tests/make_jpeg_cases.js; tests/out/venv/bin/python tests/make_compressed_series.py
const fs = require('fs'), path = require('path');
const C = require('../src/js/codecs.js'), D = require('../src/js/dicom.js'), P = require('../src/js/phantom.js');
const W = require('./dicomwriter.js'), { encodeLossless } = require('./jpegenc.js');
const { test, ok, summary } = require('./harness.js');
const { File } = require('buffer');
const out = path.join(__dirname, 'out');
const mkFile = (buf, name) => new File([buf], name);
const dirFiles = (d) => fs.readdirSync(path.join(out, d)).filter((f) => /\.dcm$/.test(f)).sort().map((f) => mkFile(fs.readFileSync(path.join(out, d, f)), f));
const ndiff = (a, b) => { let d = 0; for (let n = 0; n < a.length; n++) if (a[n] !== b[n]) d++; return d; };
console.log('Codec checks (lossless JPEG SOF3, baseline JPEG, RLE, encapsulation, big mixed folders)');
(async () => {
  const cases = JSON.parse(fs.readFileSync(path.join(out, 'jpegcases', 'cases.json'), 'utf8'));
  await test(`lossless JPEG: ${cases.length} streams (P 8/12/16, predictors 1-7, point transform 0/2, restart intervals none/1 row/3 rows, long Huffman codes, SSSS=16) decode sample-identical`, () => {
    let bad = [];
    for (const c of cases) {
      const jpg = fs.readFileSync(path.join(out, 'jpegcases', c.name + '.jpg')), raw = fs.readFileSync(path.join(out, 'jpegcases', c.name + '.raw'));
      const exp = new Uint16Array(raw.buffer, raw.byteOffset, raw.length / 2), r = C.jpegDecode(new Uint8Array(jpg));
      if (r.width !== c.W || r.height !== c.H || r.precision !== c.P || ndiff(r.data, exp)) bad.push(c.name);
    }
    ok(!bad.length, bad.length + ' mismatches, first: ' + bad.slice(0, 3));
  });
  await test('lossless JPEG: random 61x47 image with many 0xFF bytes (stuffing) at P=16, predictors 1/4/7, bit-exact', () => {
    const W_ = 61, H_ = 47, img = new Uint16Array(W_ * H_); let s = 7; for (let i = 0; i < img.length; i++) { s = (s * 1103515245 + 12345) >>> 0; img[i] = (s >>> 8) & 0xFFFF; if (i % 3 === 0) img[i] = 0xFFFF; }
    for (const ss of [1, 4, 7]) { const r = C.jpegDecode(new Uint8Array(encodeLossless(img, W_, H_, { P: 16, predictor: ss }))); ok(ndiff(r.data, img) === 0, 'ss' + ss); }
  });
  await test('corrupt / truncated streams throw or return without hanging or crashing the process', () => {
    const jpg = new Uint8Array(fs.readFileSync(path.join(out, 'jpegcases', cases[40].name + '.jpg'))); let thrown = 0;
    for (const cut of [0, 5, 30, 60, jpg.length >> 1, jpg.length - 3]) { try { C.jpegDecode(jpg.subarray(0, cut)); } catch (e) { thrown++; ok(e instanceof Error); } }
    ok(thrown >= 4, 'thrown ' + thrown);
    const bad = jpg.slice(); for (let i = 60; i < bad.length; i += 7) bad[i] ^= 0x55; try { C.jpegDecode(bad); } catch (e) { /* acceptable */ }
  });
  await test('RLE decoder rejects malformed headers', () => { let t = false; try { C.rleDecode(new Uint8Array(10), 4, 4, 16); } catch (e) { t = true; } ok(t); });
  await test('JPEG 2000 / JPEG-LS are not in the supported set and are named for the user', () => {
    ok(!C.SUPPORTED.has('1.2.840.10008.1.2.4.90') && !C.SUPPORTED.has('1.2.840.10008.1.2.4.80') && C.SUPPORTED.has('1.2.840.10008.1.2.4.57') && C.SUPPORTED.has('1.2.840.10008.1.2.4.70') && C.SUPPORTED.has('1.2.840.10008.1.2.4.50') && C.SUPPORTED.has('1.2.840.10008.1.2.5'));
    ok(/JPEG 2000/i.test(C.tsName('1.2.840.10008.1.2.4.90')));
  });

  // ---- full DICOM volumes through the app code path ----
  const ref = await D.loadFiles(dirFiles('phantom_dicom')); const refVol = await D.buildVolume(ref.series[0]);
  async function volOf(dir, tsExpected) {
    const t0 = Date.now(), scan = await D.loadFiles(dirFiles(dir)); ok(scan.series.length === 1 && scan.series[0].recs.length === 210, dir + ': series/recs ' + scan.series.length);
    ok(scan.series[0].recs[0].tags.ts === tsExpected, 'ts ' + scan.series[0].recs[0].tags.ts);
    const g = await D.buildVolume(scan.series[0]); return { g, scan, ms: Date.now() - t0 };
  }
  await test('JPEG Lossless SV1 (.70), uint16, 3 fragments + basic offset table, encoded by imagecodecs: volume voxel-identical to uncompressed', async () => {
    const { g, ms } = await volOf('phantom_ljpeg70', '1.2.840.10008.1.2.4.70'); ok(g.dims.join() === refVol.dims.join()); ok(ndiff(g.data, refVol.data) === 0, ndiff(g.data, refVol.data) + ' voxel diffs'); ok(g.info.codec); console.log('       (210 slices decoded in ' + ms + ' ms)');
  });
  await test('JPEG Lossless Process 14 (.57), SIGNED 12-bit stored, intercept 0, 4 fragments no offset table: HU voxel-identical', async () => {
    const { g } = await volOf('phantom_ljpeg57_signed12', '1.2.840.10008.1.2.4.57'); ok(ndiff(g.data, refVol.data) === 0, ndiff(g.data, refVol.data) + ' voxel diffs');
  });
  await test('RLE Lossless (.5) written by pydicom: voxel-identical', async () => {
    const { g } = await volOf('phantom_rle', '1.2.840.10008.1.2.5'); ok(ndiff(g.data, refVol.data) === 0, ndiff(g.data, refVol.data) + ' voxel diffs');
  });
  await test('JPEG Baseline (.50), 8-bit, slope 16/intercept -1024: matches libjpeg-turbo reference decode (max |diff| <= 1 stored level)', async () => {
    const { g, scan } = await volOf('phantom_baseline8', '1.2.840.10008.1.2.4.50'); const names = scan.series[0].recs.map((r) => r.src.name);
    // slices are sorted by position inside buildVolume; ref files are named by file index (= sort order of the files, same as the sorted names)
    const recs = scan.series[0].recs.slice().sort((a, b) => a.tags.ipp[2] - b.tags.ipp[2]); const nxy = g.dims[0] * g.dims[1]; let maxd = 0;
    recs.forEach((r, k) => { const rf = fs.readFileSync(path.join(out, 'phantom_baseline8_ref', r.src.name.replace('.dcm', '.raw'))); for (let n = 0; n < nxy; n++) maxd = Math.max(maxd, Math.abs(g.data[k * nxy + n] - (rf[n] * 16 - 1024))); });
    ok(maxd <= 16, 'max HU diff ' + maxd); console.log('       (max difference to libjpeg-turbo: ' + maxd / 16 + ' stored level(s))');
  });
  await test('corrupted JPEG data inside one DICOM slice yields a per-slice error message, not a hang', async () => {
    const scan = await D.loadFiles(dirFiles('phantom_ljpeg70').slice(0, 40)); const q = scan.series[0].recs[3];
    const orig = q.src.range; q.src.range = async (a, b) => { const u = await orig.call(q.src, a, b); const c = u.slice(); c.fill(0x11, 300); return c; };
    let msg = ''; try { await D.buildVolume(scan.series[0]); } catch (e) { msg = e.message; } ok(/Slice \d+\/\d+/.test(msg), 'message: ' + msg);
  });

  // ---- large mixed folder: many series, RGB secondary captures, no-geometry, no-pixel, text, compressed ----
  await test('mixed folder (~2,300 files): groups series, skips RGB / no-geometry / no-pixels / non-DICOM without blocking, pre-selects thin axial contrast series', async () => {
    const files = []; const mk = (n, o, extra) => { for (let k = 0; k < n; k++) {
      const px = new Uint16Array(32 * 32).fill(1024 + k);
      files.push(mkFile(W.writeSlice({ ipp: [0, 0, (o.z0 || 0) + k * (o.dz || 1)], iop: [1, 0, 0, 0, 1, 0], ps: [1, 1], rows: 32, cols: 32, pixels: px, signed: false, slope: 1, intercept: -1024, instance: k + 1 }, Object.assign({}, o, extra)), (o.seriesUID || 'x') + '_' + k + '.dcm')); } };
    mk(600, { seriesUID: '1.1', desc: 'CTA Aorta 0.75 Bv40', dz: 0.75, thickness: 0.75, contrast: 'IOHEXOL', imageType: 'ORIGINAL\\PRIMARY\\AXIAL' });        // the one to pick
    mk(200, { seriesUID: '1.2', desc: 'CTA Aorta 3.0 Bv40', dz: 3, thickness: 3, contrast: 'IOHEXOL' });
    mk(500, { seriesUID: '1.3', desc: 'Lung 1.0 Bl57', dz: 1, thickness: 1 });
    mk(120, { seriesUID: '1.4', desc: 'Calcium Score 3.0', dz: 3, thickness: 3 });
    mk(700, { seriesUID: '1.5', desc: 'CTA Aorta 1.0 MIP', dz: 1, thickness: 1, contrast: 'IOHEXOL', imageType: 'DERIVED\\SECONDARY' });
    mk(96, { seriesUID: '1.6', desc: 'Screen Save', rgb: true });
    mk(2, { seriesUID: '1.7', desc: 'Scout', noGeometry: true }); mk(1, { seriesUID: '1.8', desc: 'Dose Report', noPixels: true });
    for (let i = 0; i < 20; i++) files.push(mkFile(Buffer.from('notes ' + i), 'notes' + i + '.txt'));
    for (const f of dirFiles('phantom_ljpeg70')) files.push(f);   // compressed lossless-JPEG phantom series in the same folder
    files.sort(() => 0); // order irrelevant
    const t0 = Date.now(); let ticks = 0;
    const scan = await D.loadFiles(files, () => { ticks++; });
    const scanMs = Date.now() - t0;
    ok(scan.total === files.length, 'total'); ok(scan.skipped['not-grayscale'] === 96, 'rgb ' + scan.skipped['not-grayscale']); ok(scan.skipped['no-geometry'] === 2, 'nogeo ' + scan.skipped['no-geometry']);
    ok(scan.skipped['no-pixels'] === 1 && scan.skipped['not-dicom'] === 20, JSON.stringify(scan.skipped));
    ok(scan.series.length === 6, 'series ' + scan.series.length);
    const sel = scan.series.filter((s) => s.preselect); ok(sel.length === 1 && sel[0].uid === '1.1' && sel[0].recs.length === 600, 'preselect ' + (sel[0] && sel[0].desc));
    ok(scan.series[0] === sel[0], 'best first'); ok(scan.series.find((s) => s.uid === '9.9.9.1').codec, 'codec labelled');
    ok(ticks > 10, 'progress ticks ' + ticks);
    const t1 = Date.now(), g = await D.buildVolume(sel[0]); const buildMs = Date.now() - t1;
    ok(g.dims.join() === '32,32,600' && Math.abs(g.vk[2] - 0.75) < 1e-6 && g.data[0] === 0 && g.data[g.data.length - 1] === 599, 'volume ' + g.dims);
    console.log(`       (${files.length} files: scan ${scanMs} ms, selected series volume ${buildMs} ms; ${scan.series.length} series listed)`);
  });
  summary();
})();
