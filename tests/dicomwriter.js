// Minimal DICOM writer used ONLY for tests (generates synthetic series). Contains a fake patient name on purpose to prove the app never reads it.
const zlib = require('zlib');
function pad(s, n) { const b = Buffer.from(s, 'latin1'); return b.length % 2 ? Buffer.concat([b, Buffer.from([n || 0x20])]) : b; }
function tag(g, e) { const b = Buffer.alloc(4); b.writeUInt16LE(g, 0); b.writeUInt16LE(e, 2); return b; }
function el(g, e, vr, val, implicit, big) {
  const v = Buffer.isBuffer(val) ? val : val;
  const parts = [tag(g, e)];
  if (implicit) { const l = Buffer.alloc(4); l.writeUInt32LE(v.length); parts.push(l, v); }
  else if (['OB', 'OW', 'SQ', 'UN', 'UT'].includes(vr)) { const l = Buffer.alloc(8); l.write(vr, 0, 'latin1'); l.writeUInt32LE(v.length, 4); parts.push(l, v); }
  else { const l = Buffer.alloc(4); l.write(vr, 0, 'latin1'); l.writeUInt16LE(v.length, 2); parts.push(l, v); }
  return Buffer.concat(parts);
}
const us = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const ds = (arr) => pad(arr.map((v) => Number(v.toFixed(6)).toString()).join('\\'));
function undefSeq(g, e, implicit, inner) {
  // SQ of undefined length with one undefined-length item containing `inner`
  const head = implicit ? Buffer.concat([tag(g, e), Buffer.from([0xff, 0xff, 0xff, 0xff])]) : Buffer.concat([tag(g, e), Buffer.from('SQ\0\0', 'latin1'), Buffer.from([0xff, 0xff, 0xff, 0xff])]);
  const itemStart = Buffer.concat([tag(0xfffe, 0xe000), Buffer.from([0xff, 0xff, 0xff, 0xff])]);
  const itemEnd = Buffer.concat([tag(0xfffe, 0xe00d), Buffer.alloc(4)]);
  const seqEnd = Buffer.concat([tag(0xfffe, 0xe0dd), Buffer.alloc(4)]);
  return Buffer.concat([head, itemStart, inner, itemEnd, seqEnd]);
}
/* slice: {ipp, iop, ps:[rowSp,colSp], rows, cols, pixels:Int16Array(raw stored values), signed, slope, intercept, instance} */
function writeSlice(s, o) {
  o = o || {};
  const implicit = !!o.implicit, ts = o.ts || (implicit ? '1.2.840.10008.1.2' : '1.2.840.10008.1.2.1');
  const E = (g, e, vr, v) => el(g, e, vr, v, implicit);
  const innerSeq = Buffer.concat([E(0x0008, 0x1150, 'UI', pad('1.2.3', 0)), E(0x0008, 0x1155, 'UI', pad('1.2.3.4', 0))]);
  const body = [
    ...(o.imageType ? [E(0x0008, 0x0008, 'CS', pad(o.imageType))] : []),
    E(0x0008, 0x0016, 'UI', pad('1.2.840.10008.5.1.4.1.1.2', 0)), E(0x0008, 0x0060, 'CS', pad(o.modality || 'CT')), E(0x0008, 0x103e, 'LO', pad(o.desc || 'Test CTA')),
    undefSeq(0x0008, 0x1140, implicit, innerSeq),
    E(0x0010, 0x0010, 'PN', pad('DOE^JANE^TEST')), E(0x0010, 0x0020, 'LO', pad('SYNTH-ID-0001')),
    ...(o.contrast ? [E(0x0018, 0x0010, 'LO', pad(o.contrast))] : []), E(0x0018, 0x0050, 'DS', ds([o.thickness || 2])), E(0x0020, 0x000d, 'UI', pad('9.9.9', 0)), E(0x0020, 0x000e, 'UI', pad(o.seriesUID || '9.9.9.1', 0)), E(0x0020, 0x0011, 'IS', pad('3')),
    E(0x0020, 0x0013, 'IS', pad(String(s.instance))), ...(o.noGeometry ? [] : [E(0x0020, 0x0032, 'DS', ds(s.ipp)), E(0x0020, 0x0037, 'DS', ds(s.iop))]), E(0x0020, 0x0052, 'UI', pad('7.7.7', 0)),
    E(0x0028, 0x0002, 'US', us(o.rgb ? 3 : 1)), E(0x0028, 0x0004, 'CS', pad(o.rgb ? 'RGB' : 'MONOCHROME2')), ...(o.rgb ? [E(0x0028, 0x0006, 'US', us(0))] : []), E(0x0028, 0x0010, 'US', us(s.rows)), E(0x0028, 0x0011, 'US', us(s.cols)),
    E(0x0028, 0x0030, 'DS', ds(s.ps)), E(0x0028, 0x0100, 'US', us(16)), E(0x0028, 0x0101, 'US', us(16)), E(0x0028, 0x0102, 'US', us(15)), E(0x0028, 0x0103, 'US', us(s.signed ? 1 : 0)),
    E(0x0028, 0x1052, 'DS', ds([s.intercept])), E(0x0028, 0x1053, 'DS', ds([s.slope]))
  ];
  let pix;
  if (o.compressed) {
    // encapsulated pixel data (undefined length), one fake fragment
    const frag = Buffer.concat([tag(0xfffe, 0xe000), Buffer.from([4, 0, 0, 0]), Buffer.from([1, 2, 3, 4])]);
    pix = Buffer.concat([implicit ? Buffer.concat([tag(0x7fe0, 0x0010), Buffer.from([0xff, 0xff, 0xff, 0xff])]) : Buffer.concat([tag(0x7fe0, 0x0010), Buffer.from('OB\0\0', 'latin1'), Buffer.from([0xff, 0xff, 0xff, 0xff])]), tag(0xfffe, 0xe000), Buffer.alloc(4), frag, tag(0xfffe, 0xe0dd), Buffer.alloc(4)]);
  } else pix = E(0x7fe0, 0x0010, 'OW', Buffer.from(s.pixels.buffer, s.pixels.byteOffset, s.pixels.byteLength));
  const dataset = Buffer.concat(o.noPixels ? body : [...body, pix]);
  const metaBody = Buffer.concat([el(0x0002, 0x0010, 'UI', pad(ts, 0), false), el(0x0002, 0x0002, 'UI', pad('1.2.840.10008.5.1.4.1.1.2', 0), false)]);
  const meta = Buffer.concat([el(0x0002, 0x0000, 'UL', (() => { const b = Buffer.alloc(4); b.writeUInt32LE(metaBody.length); return b; })(), false), metaBody]);
  return Buffer.concat([Buffer.alloc(128), Buffer.from('DICM'), meta, o.deflate ? zlib.deflateRawSync(dataset) : dataset]);
}
// minimal ZIP writer (deflate or store)
function crc32(buf) { let c, crc = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crc ^ buf[n]) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return (crc ^ 0xffffffff) >>> 0; }
function zip(files, store) {
  const locals = [], cds = []; let off = 0;
  for (const f of files) {
    const nameB = Buffer.from(f.name), raw = f.data, comp = store ? raw : zlib.deflateRawSync(raw), crc = crc32(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(store ? 0 : 8, 8); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameB.length, 26);
    locals.push(lh, nameB, comp);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(store ? 0 : 8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(off, 42);
    cds.push(ch, nameB); off += 30 + nameB.length + comp.length;
  }
  const cd = Buffer.concat(cds), eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(files.length, 8); eo.writeUInt16LE(files.length, 10); eo.writeUInt32LE(cd.length, 12); eo.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, eo]);
}
// Convert a NavVolume-style geometry + HU data (Int16) into axial DICOM slice records (stored unsigned with intercept -1024)
function volumeToSlices(vol) {
  const [nx, ny, nz] = vol.dims, out = [];
  const ps = [Math.hypot(...vol.vj), Math.hypot(...vol.vi)]; // [row spacing, col spacing]
  const r = vol.vi.map((v) => v / ps[1]), c = vol.vj.map((v) => v / ps[0]);
  for (let k = 0; k < nz; k++) {
    const px = new Uint16Array(nx * ny);
    for (let n = 0; n < nx * ny; n++) px[n] = Math.min(65535, Math.max(0, vol.data[k * nx * ny + n] + 1024));
    out.push({ ipp: [vol.origin[0] + k * vol.vk[0], vol.origin[1] + k * vol.vk[1], vol.origin[2] + k * vol.vk[2]], iop: [...r, ...c], ps, rows: ny, cols: nx, pixels: px, signed: false, slope: 1, intercept: -1024, instance: k + 1 });
  }
  return out;
}
module.exports = { writeSlice, zip, volumeToSlices };
