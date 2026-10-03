const D = require('../src/js/dicom.js'), V = require('../src/js/volume.js'), P = require('../src/js/phantom.js');
const W = require('./dicomwriter.js');
const { test, near, ok, summary } = require('./harness.js');
const { File } = require('buffer');
console.log('DICOM / volume geometry checks');
const mkFile = (buf, name) => new File([buf], name);
(async () => {
  const ph = P.generate();
  const slices = W.volumeToSlices(ph.volume);
  await test('round trip: phantom -> explicit-VR DICOM (shuffled order, with undefined-length sequence + fake patient name) -> parsed volume identical', async () => {
    const order = slices.map((_, i) => i).sort((a, b) => ((a * 7919) % 211) - ((b * 7919) % 211));
    const files = order.map((i) => mkFile(W.writeSlice(slices[i]), 'IM' + i));
    files.push(mkFile(Buffer.from('this is not dicom, just text padding'.repeat(10)), 'README.txt'));
    const scan = await D.loadFiles(files);
    ok(scan.series.length === 1, 'series ' + scan.series.length); ok(scan.skipped['not-dicom'] === 1);
    ok(scan.series[0].recs.length === slices.length);
    const g = await D.buildVolume(scan.series[0]);
    ok(g.dims.join() === ph.volume.dims.join(), 'dims ' + g.dims);
    let diff = 0; for (let n = 0; n < g.data.length; n++) if (g.data[n] !== ph.volume.data[n]) diff++;
    ok(diff === 0, diff + ' voxel differences');
    near(g.origin[2], -230, 1e-6); near(g.vk[2], 2, 1e-6);
    // privacy: parser never exposes patient tags
    const keys = Object.keys(scan.series[0].recs[0].tags).join(',');
    ok(!/name|patient|birth|id$/i.test(keys.replace(/seriesUID|forUID/g, '')), 'tags exposed: ' + keys);
    ok(!JSON.stringify(scan.series[0].recs[0].tags).includes('DOE'), 'patient name leaked');
  });
  await test('implicit VR little endian parses identically', async () => {
    const files = slices.slice(0, 20).map((s, i) => mkFile(W.writeSlice(s, { implicit: true }), 'I' + i));
    const scan = await D.loadFiles(files); const g = await D.buildVolume(scan.series[0]);
    ok(g.dims[2] === 20); let d = 0; for (let n = 0; n < g.data.length; n++) if (g.data[n] !== ph.volume.data[n]) d++; ok(d === 0, d + ' diffs');
  });
  await test('Deflated Explicit VR LE transfer syntax (1.2.840.10008.1.2.1.99) parses identically', async () => {
    const files = slices.slice(0, 12).map((s, i) => mkFile(W.writeSlice(s, { deflate: true, ts: '1.2.840.10008.1.2.1.99' }), 'Z' + i));
    const scan = await D.loadFiles(files); ok(scan.series.length === 1 && scan.series[0].recs.length === 12, 'series/recs');
    const g = await D.buildVolume(scan.series[0]); let d = 0; for (let n = 0; n < g.data.length; n++) if (g.data[n] !== ph.volume.data[n]) d++; ok(d === 0, d + ' diffs');
  });
  await test('ZIP (deflate) input is read in-browser-style and gives identical volume', async () => {
    const z = W.zip(slices.slice(0, 30).map((s, i) => ({ name: 'series/IM' + i + '.dcm', data: W.writeSlice(s) })));
    const scan = await D.loadFiles([mkFile(z, 'study.zip')]); ok(scan.series.length === 1 && scan.series[0].recs.length === 30);
    const g = await D.buildVolume(scan.series[0]); let d = 0; for (let n = 0; n < g.data.length; n++) if (g.data[n] !== ph.volume.data[n]) d++; ok(d === 0);
  });
  await test('ZIP (stored) works too', async () => {
    const z = W.zip(slices.slice(0, 5).map((s, i) => ({ name: 'IM' + i, data: W.writeSlice(s) })), true);
    const scan = await D.loadFiles([mkFile(z, 'x.zip')]); ok(scan.series[0].recs.length === 5);
  });
  await test('oblique orientation + anisotropic PixelSpacing: voxel->patient mapping is correct (linear field reproduced at arbitrary patient points)', async () => {
    // IOP: rotate axial grid by 20deg about patient x then 15 deg about z
    const rotz = (a, v) => [Math.cos(a) * v[0] - Math.sin(a) * v[1], Math.sin(a) * v[0] + Math.cos(a) * v[1], v[2]];
    const rotx = (a, v) => [v[0], Math.cos(a) * v[1] - Math.sin(a) * v[2], Math.sin(a) * v[1] + Math.cos(a) * v[2]];
    const tf = (v) => rotz(0.26, rotx(0.35, v));
    const rdir = tf([1, 0, 0]), cdir = tf([0, 1, 0]), ndir = tf([0, 0, 1]);
    const rows = 24, cols = 30, nz = 12, ps = [0.7, 0.9], dz = 2.5, o = [-30, 12, 100];
    const field = (P) => 0.8 * P[0] - 0.5 * P[1] + 0.3 * P[2];
    const files = [];
    for (let k = 0; k < nz; k++) {
      const ipp = [o[0] + k * dz * ndir[0], o[1] + k * dz * ndir[1], o[2] + k * dz * ndir[2]];
      const px = new Int16Array(rows * cols);
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const P = [ipp[0] + i * ps[1] * rdir[0] + j * ps[0] * cdir[0], ipp[1] + i * ps[1] * rdir[1] + j * ps[0] * cdir[1], ipp[2] + i * ps[1] * rdir[2] + j * ps[0] * cdir[2]];
        px[j * cols + i] = Math.round(field(P) * 20); // scale to keep precision
      }
      files.push(mkFile(W.writeSlice({ ipp, iop: [...rdir, ...cdir], ps, rows, cols, pixels: px, signed: true, slope: 0.05, intercept: 0, instance: nz - k }), 'O' + k));
    }
    const scan = await D.loadFiles(files.reverse()); const g = await D.buildVolume(scan.series[0]);
    const vol = new V.Volume(g);
    near(vol.spacing[0], 0.9, 1e-4, 'col spacing = PixelSpacing[1]'); near(vol.spacing[1], 0.7, 1e-4, 'row spacing = PixelSpacing[0]'); near(vol.spacing[2], 2.5, 1e-4);
    for (const [fi, fj, fk] of [[3.3, 4.1, 2.2], [20.5, 10.25, 7.7], [0, 0, 0], [29, 23, 11]]) {
      const Pt = vol.toPatient(fi, fj, fk), got = vol.sample(Pt), want = field(Pt);
      near(got, want, 0.55, 'field at voxel ' + [fi, fj, fk]); // volume stores integer HU (rounding error <= 0.5)
      const back = vol.toVoxel(Pt); near(back[0], fi, 1e-6); near(back[1], fj, 1e-6); near(back[2], fk, 1e-6);
    }
    ok(isNaN(vol.sample([1000, 1000, 1000])), 'outside -> NaN');
  });
  await test('unsupported codec (JPEG 2000, 1.2.840.10008.1.2.4.90) is rejected with a clear category, not mis-parsed', async () => {
    const f = [mkFile(W.writeSlice(slices[0], { compressed: true, ts: '1.2.840.10008.1.2.4.90' }), 'J.dcm')];
    const scan = await D.loadFiles(f); ok(scan.series.length === 0 && scan.skipped['unsupported-codec'] === 1 && scan.badCodecs['1.2.840.10008.1.2.4.90'] === 1);
  });
  await test('MPR plane render of axial plane through the aorta shows contrast (>250 HU) at the descending aorta location', async () => {
    const vol = new V.Volume(ph.volume);
    const c = ph.truth.centreline, i = Math.round(c.pts.length * 0.15), Pc = c.pts[i];
    ok(vol.sample(Pc) > 300, 'HU at centreline ' + vol.sample(Pc));
    const buf = new Uint32Array(64 * 64); vol.renderPlane(buf, 64, 64, [Pc[0] - 32, Pc[1] - 32, Pc[2]], [1, 0, 0], [0, 1, 0], 200, 700);
    ok(buf[32 * 64 + 32] !== buf[0]);
  });
  summary();
})();
