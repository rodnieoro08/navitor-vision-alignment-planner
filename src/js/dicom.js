/* NavDicom: hand-written, dependency-free DICOM reader for CT + minimal ZIP reader.
 * Only geometry / pixel / series-description tags are read. Patient-identifying tags (name, ID, birth date, ...) are never read or stored.
 * Transfer syntaxes: Implicit VR LE, Explicit VR LE/BE, Deflated, and encapsulated JPEG Lossless (.57/.70), JPEG Baseline/Extended (.50/.51), RLE (.5)
 * via NavCodecs. NOT supported: JPEG 2000, JPEG-LS, progressive JPEG, multi-frame / enhanced CT, colour images. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./codecs.js'));
  else root.NavDicom = factory(root.NavCodecs);
})(typeof self !== 'undefined' ? self : this, function (Codecs) {
  'use strict';
  const TAGS = {
    '00020010': ['ts', 'UI'], '00080016': ['sopClass', 'UI'], '00080060': ['modality', 'CS'], '0008103e': ['seriesDesc', 'LO'],
    '0020000e': ['seriesUID', 'UI'], '00200011': ['seriesNumber', 'IS'], '00200013': ['instanceNumber', 'IS'], '00200032': ['ipp', 'DS'],
    '00200037': ['iop', 'DS'], '00200052': ['forUID', 'UI'], '00280002': ['spp', 'US'], '00280004': ['photometric', 'CS'], '00280008': ['frames', 'IS'],
    '00280010': ['rows', 'US'], '00280011': ['cols', 'US'], '00280030': ['pixelSpacing', 'DS'], '00280100': ['bitsAllocated', 'US'],
    '00280101': ['bitsStored', 'US'], '00280103': ['pixelRep', 'US'], '00281052': ['intercept', 'DS'], '00281053': ['slope', 'DS'],
    '00180050': ['sliceThickness', 'DS'], '00181120': ['gantryTilt', 'DS'], '00080008': ['imageType', 'CS'], '00181210': ['kernel', 'SH'],
    '00180010': ['contrast', 'LO'], '00200100': ['temporalPos', 'IS'], '00200012': ['acqNumber', 'IS'], '00181060': ['triggerTime', 'DS'], '00180088': ['spacingBetween', 'DS']
  };
  const LONG_VR = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'SQ', 'UN', 'UC', 'UR', 'UT']);
  const TS_IMPLICIT = '1.2.840.10008.1.2', TS_EXPLICIT = '1.2.840.10008.1.2.1', TS_BE = '1.2.840.10008.1.2.2', TS_DEFLATE = '1.2.840.10008.1.2.1.99';
  const UNDEF = 0xFFFFFFFF;
  class NeedMore extends Error {}

  function ascii(u8, o, l) { let s = ''; for (let i = 0; i < l; i++) s += String.fromCharCode(u8[o + i]); return s; }
  const clean = (s) => s.replace(/[\0 ]+$/, '').replace(/^ +/, '');
  function hex4(n) { return n.toString(16).padStart(4, '0'); }

  function readHeader(dv, u8, p, implicit, little) {
    if (p + 8 > u8.length) throw new NeedMore();
    const g = dv.getUint16(p, little), e = dv.getUint16(p + 2, little);
    if (g === 0xFFFE) return { g, e, vr: '', len: dv.getUint32(p + 4, little), hdr: 8 };
    if (implicit) return { g, e, vr: '', len: dv.getUint32(p + 4, little), hdr: 8 };
    const vr = String.fromCharCode(u8[p + 4], u8[p + 5]);
    if (LONG_VR.has(vr)) {
      if (p + 12 > u8.length) throw new NeedMore();
      return { g, e, vr, len: dv.getUint32(p + 8, little), hdr: 12 };
    }
    return { g, e, vr, len: dv.getUint16(p + 6, little), hdr: 8 };
  }
  // skip an undefined-length sequence / fragment list starting at p (after its element header); returns offset after delimiter
  function skipUndefined(dv, u8, p, implicit, little) {
    for (;;) {
      if (p + 8 > u8.length) throw new NeedMore();
      const g = dv.getUint16(p, little), e = dv.getUint16(p + 2, little), l = dv.getUint32(p + 4, little);
      if (g === 0xFFFE && e === 0xE0DD) return p + 8;
      if (g === 0xFFFE && e === 0xE000) {
        if (l === UNDEF) p = skipItem(dv, u8, p + 8, implicit, little); else p += 8 + l;
      } else throw new Error('Malformed sequence');
    }
  }
  function skipItem(dv, u8, p, implicit, little) {
    for (;;) {
      const h = readHeader(dv, u8, p, implicit, little);
      if (h.g === 0xFFFE && h.e === 0xE00D) return p + 8;
      if (h.len === UNDEF) p = skipUndefined(dv, u8, p + h.hdr, h.vr === 'UN' ? true : implicit, little);
      else p += h.hdr + h.len;
    }
  }
  function decode(def, dv, u8, o, l, little) {
    const vr = def[1];
    if (vr === 'US') return l >= 2 ? dv.getUint16(o, little) : null;
    const s = clean(ascii(u8, o, l));
    if (vr === 'DS') return s.split('\\').map((x) => parseFloat(x));
    if (vr === 'IS') return parseInt(s, 10);
    return s;
  }
  /* Parse dataset from `u8` (whole file or header prefix). Returns tags + location of pixel data. */
  function parseHeaderBytes(u8, forceTS) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let p = 0, hasPreamble = u8.length > 132 && ascii(u8, 128, 4) === 'DICM';
    if (hasPreamble) p = 132;
    const tags = {};
    let implicit = false, little = true, metaEnd = p;
    // File meta (always explicit LE)
    if (hasPreamble || (u8.length > 8 && dv.getUint16(0, true) === 0x0002)) {
      for (;;) {
        if (p + 8 > u8.length) throw new NeedMore();
        const g = dv.getUint16(p, true);
        if (g !== 0x0002) break;
        const h = readHeader(dv, u8, p, false, true);
        if (p + h.hdr + h.len > u8.length) throw new NeedMore();
        const def = TAGS['0002' + hex4(h.e)];
        if (def) tags[def[0]] = decode(def, dv, u8, p + h.hdr, h.len, true);
        p += h.hdr + h.len;
      }
      metaEnd = p;
      if (forceTS) tags.ts = forceTS;
      const ts = tags.ts || TS_EXPLICIT;
      implicit = ts === TS_IMPLICIT; little = ts !== TS_BE;
    } else {
      // no meta header: guess implicit vs explicit from first element
      const c1 = u8[4], c2 = u8[5];
      implicit = !(c1 >= 65 && c1 <= 90 && c2 >= 65 && c2 <= 90);
      tags.ts = implicit ? TS_IMPLICIT : TS_EXPLICIT;
    }
    if (tags.ts === TS_DEFLATE) return { tags, needsInflate: true, metaEnd };
    let pixelOffset = -1, pixelLength = 0, encapsulated = false, multiframe = false;
    while (p < u8.length) {
      const h = readHeader(dv, u8, p, implicit, little);
      const key = hex4(h.g) + hex4(h.e);
      if (key === '7fe00010') {
        if (h.len === UNDEF) { encapsulated = true; }
        pixelOffset = p + h.hdr; pixelLength = h.len === UNDEF ? 0 : h.len;
        break;
      }
      if (h.len === UNDEF) { p = skipUndefined(dv, u8, p + h.hdr, h.vr === 'UN' ? true : implicit, little); continue; }
      if (h.g > 0x7FE0) break;
      if (p + h.hdr + h.len > u8.length) throw new NeedMore();
      const def = TAGS[key];
      if (def && h.g !== 0xFFFE) tags[def[0]] = decode(def, dv, u8, p + h.hdr, h.len, little);
      p += h.hdr + h.len;
    }
    return { tags, pixelOffset, pixelLength, encapsulated, little, implicit, metaEnd };
  }

  async function inflateRaw(u8) {
    const ds = new DecompressionStream('deflate-raw');
    const out = new Response(new Blob([u8]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  }

  /* ---------------- ZIP ---------------- */
  async function readZip(blob) {
    const size = blob.size, tailLen = Math.min(size, 65557);
    const tail = new Uint8Array(await blob.slice(size - tailLen, size).arrayBuffer());
    let e = -1;
    for (let i = tail.length - 22; i >= 0; i--) if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 5 && tail[i + 3] === 6) { e = i; break; }
    if (e < 0) throw new Error('Not a valid ZIP (no end-of-central-directory)');
    const dv = new DataView(tail.buffer, tail.byteOffset);
    const count = dv.getUint16(e + 10, true), cdSize = dv.getUint32(e + 12, true), cdOff = dv.getUint32(e + 16, true);
    if (count === 0xFFFF || cdOff === 0xFFFFFFFF) throw new Error('ZIP64 archives are not supported - please select the DICOM folder instead');
    const cd = new Uint8Array(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
    const cdv = new DataView(cd.buffer, cd.byteOffset);
    const entries = [];
    let p = 0;
    for (let i = 0; i < count; i++) {
      if (cdv.getUint32(p, true) !== 0x02014b50) break;
      const method = cdv.getUint16(p + 10, true), csize = cdv.getUint32(p + 20, true), usize = cdv.getUint32(p + 24, true);
      const nl = cdv.getUint16(p + 28, true), el = cdv.getUint16(p + 30, true), cl = cdv.getUint16(p + 32, true), lo = cdv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nl));
      entries.push({ name, method, csize, usize, lo });
      p += 46 + nl + el + cl;
    }
    const out = [];
    for (const en of entries) {
      if (en.name.endsWith('/') || /(^|\/)(\.|__MACOSX)/.test(en.name)) continue;
      out.push(makeSource(en.name.split('/').pop(), en.usize, async function () {
        const lh = new Uint8Array(await blob.slice(en.lo, en.lo + 30).arrayBuffer());
        const ldv = new DataView(lh.buffer);
        const start = en.lo + 30 + ldv.getUint16(26, true) + ldv.getUint16(28, true);
        const raw = new Uint8Array(await blob.slice(start, start + en.csize).arrayBuffer());
        if (en.method === 0) return raw;
        if (en.method === 8) return inflateRaw(raw);
        throw new Error('Unsupported ZIP compression method ' + en.method);
      }, en.name));
    }
    return out;
  }

  /* ---------------- sources ---------------- */
  // A source reads byte ranges lazily. Files read via Blob.slice; zip entries are decompressed once and cached until release().
  function makeSource(name, size, loader, path) {
    const s = { name, path: path || name, size, _buf: null,
      async range(a, b) {
        if (loader) { if (!s._buf) s._buf = await loader(); return s._buf.subarray(a, b == null ? undefined : b); }
        throw new Error('no loader');
      }, release() { s._buf = null; } };
    return s;
  }
  function fileSource(file) {
    const name = file.webkitRelativePath || file.name;
    return { name: file.name, path: name, size: file.size, _buf: null,
      async range(a, b) {
        if (this._buf) return this._buf.subarray(a, b == null ? undefined : b);
        return new Uint8Array(await file.slice(a, b == null ? file.size : b).arrayBuffer());
      },
      release() { this._buf = null; } };
  }
  async function expandInputs(files) {
    const out = [];
    for (const f of files) {
      let isZip = /\.zip$/i.test(f.name);
      if (!isZip && f.size > 4) { const h = new Uint8Array(await f.slice(0, 4).arrayBuffer()); isZip = h[0] === 0x50 && h[1] === 0x4b && h[2] === 3 && h[3] === 4; }
      if (isZip) out.push(...(await readZip(f))); else out.push(fileSource(f));
    }
    return out;
  }

  /* ---------------- header scan ---------------- */
  async function readRecord(src) {
    if (src.size < 140 && !src._buf) return { skip: 'not-dicom' };
    let n = 32768, info = null;
    for (;;) {
      const u8 = await src.range(0, Math.min(n, src.size));
      try { info = parseHeaderBytes(u8); break; }
      catch (e) {
        if (e instanceof NeedMore && n < src.size) { n = n < 262144 ? 262144 : n < 3e6 ? 3e6 : src.size; continue; }
        return { skip: 'not-dicom' };
      }
    }
    if (info.needsInflate) {
      const full = await src.range(0, src.size);
      const inflated = await inflateRaw(full.subarray(info.metaEnd));
      const meta = new Uint8Array(info.metaEnd + inflated.length); meta.set(full.subarray(0, info.metaEnd)); meta.set(inflated, info.metaEnd);
      src._buf = meta;
      info = parseHeaderBytes(meta, TS_EXPLICIT);
    }
    const t = info.tags;
    if (info.pixelOffset < 0 || !t.rows || !t.cols) return { skip: 'no-pixels' };
    if ((t.spp && t.spp !== 1) || (t.photometric && !/^MONOCHROME[12]$/.test(t.photometric))) return { skip: 'not-grayscale', tags: t };
    if (t.frames && t.frames > 1) return { skip: 'multiframe', tags: t };
    if (info.encapsulated && !Codecs.SUPPORTED.has(t.ts)) return { skip: 'unsupported-codec', ts: t.ts, tags: t };
    if (!info.encapsulated && t.ts && /^1\.2\.840\.10008\.1\.2\.4\./.test(t.ts)) return { skip: 'unsupported-codec', ts: t.ts, tags: t };
    if (!t.ipp || t.ipp.length < 3 || !t.iop || t.iop.length < 6) return { skip: 'no-geometry', tags: t };
    if (t.bitsAllocated !== 16 && t.bitsAllocated !== 8) return { skip: 'bits', tags: t };
    return { src, info, tags: t };
  }

  async function pool(items, n, fn) { // bounded-concurrency map that preserves order
    const out = new Array(items.length); let next = 0;
    const worker = async () => { for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i], i); } };
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
    return out;
  }
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const SKIP_LABELS = { 'not-dicom': 'non-DICOM files', 'no-pixels': 'DICOM files without pixel data (reports etc.)', 'unsupported-codec': 'images with an unsupported compression codec',
    multiframe: 'multi-frame / enhanced images', 'not-grayscale': 'colour (RGB/palette) images, e.g. secondary captures', 'no-geometry': 'images without position/orientation (e.g. scouts, reports)', bits: 'images with unsupported bit depth' };

  /* Scan: reads only small header prefixes (never decodes pixels), groups into series and describes/scored them. */
  async function scanSources(sources, onProgress) {
    const skipped = { 'not-dicom': 0, 'no-pixels': 0, 'unsupported-codec': 0, multiframe: 0, 'not-grayscale': 0, 'no-geometry': 0, bits: 0 };
    const recs = [], badCodecs = {}; let done = 0;
    await pool(sources, 8, async (src) => {
      let r; try { r = await readRecord(src); } catch (e) { r = { skip: 'not-dicom' }; }
      if (r.skip) { skipped[r.skip]++; if (r.skip === 'unsupported-codec') badCodecs[r.ts] = (badCodecs[r.ts] || 0) + 1; } else recs.push(r);
      done++; if (onProgress && (done % 25 === 0 || done === sources.length)) { onProgress(done, sources.length); await tick(); }
    });
    const bySeries = new Map();
    for (const r of recs) {
      const t = r.tags, key = (t.seriesUID || 'noseries') + '|' + t.rows + 'x' + t.cols + '|' + t.iop.map((v) => v.toFixed(3)).join(',') + '|' + (t.temporalPos == null ? '' : t.temporalPos);
      if (!bySeries.has(key)) bySeries.set(key, { key, uid: t.seriesUID, desc: t.seriesDesc || '', number: t.seriesNumber, modality: t.modality || '', rows: t.rows, cols: t.cols, recs: [] });
      bySeries.get(key).recs.push(r);
    }
    let series = [];
    for (const g of bySeries.values()) series.push(...splitDuplicates(g));
    series.forEach(describeSeries);
    series.sort((a, b) => b.score - a.score || b.recs.length - a.recs.length);
    const best = series.find((s) => s.score > 0) || null;
    series.forEach((s) => { s.preselect = s === best; });
    return { series, skipped, total: sources.length, badCodecs, skipLabels: SKIP_LABELS };
  }
  // multi-phase series sharing one SeriesUID: separate by acquisition number / trigger time when positions repeat
  function splitDuplicates(g) {
    const posKey = (r) => Math.round(dot(r.tags.ipp, cross(r.tags.iop.slice(0, 3), r.tags.iop.slice(3, 6))) * 20);
    const uniq = new Set(g.recs.map(posKey)).size;
    if (g.recs.length < 1.3 * uniq) return [g];
    for (const field of ['acqNumber', 'triggerTime']) {
      const m = new Map(); g.recs.forEach((r) => { const k = String(Array.isArray(r.tags[field]) ? r.tags[field][0] : r.tags[field]); if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
      if (m.size > 1 && [...m.values()].every((rs) => new Set(rs.map(posKey)).size >= 0.95 * rs.length)) return [...m.entries()].map(([k, rs]) => Object.assign({}, g, { recs: rs, phase: field + '=' + k }));
    }
    return [g];
  }
  function describeSeries(s) {
    const t0 = s.recs[0].tags, r = t0.iop.slice(0, 3), c = t0.iop.slice(3, 6), n = cross(r, c);
    const pos = s.recs.map((q) => dot(q.tags.ipp, n)).sort((a, b) => a - b), uniq = pos.filter((v, i) => i === 0 || v - pos[i - 1] > 0.01);
    const steps = []; for (let i = 1; i < uniq.length; i++) steps.push(uniq[i] - uniq[i - 1]); steps.sort((a, b) => a - b);
    s.step = steps.length ? steps[steps.length >> 1] : 0; s.coverage = uniq.length > 1 ? uniq[uniq.length - 1] - uniq[0] : 0; s.unique = uniq.length;
    s.thickness = t0.sliceThickness && t0.sliceThickness[0] > 0 ? t0.sliceThickness[0] : s.step;
    const ax = Math.abs(n[2]), cor = Math.abs(n[1]), sag = Math.abs(n[0]);
    s.orientation = ax > 0.9 ? 'axial' : cor > 0.9 ? 'coronal' : sag > 0.9 ? 'sagittal' : 'oblique';
    s.imageType = t0.imageType || ''; s.kernel = t0.kernel || ''; s.contrast = !!(t0.contrast && t0.contrast.length) || /cta|contrast|angio|arterial|\+c|c\+|\bcm\b/i.test(s.desc);
    s.ts = t0.ts; s.codec = Codecs.SUPPORTED.has(s.ts) ? Codecs.tsName(s.ts) : '';
    const reasons = [], bad = [];
    let sc = 0;
    if (s.modality && s.modality !== 'CT') { sc -= 100; bad.push('not CT (' + s.modality + ')'); }
    if (s.recs.length < 30) { sc -= 100; bad.push('too few slices'); }
    if (s.orientation === 'axial') { sc += 30; reasons.push('axial'); } else { sc -= 40; bad.push(s.orientation); }
    const st = s.step || s.thickness;
    if (st > 0) { sc += st <= 0.8 ? 25 : st <= 1.25 ? 20 : st <= 2.5 ? 10 : st <= 3.5 ? -5 : -30; if (st <= 1.5) reasons.push('thin ' + st.toFixed(2) + ' mm'); else bad.push('thick ' + st.toFixed(1) + ' mm'); }
    if (s.contrast) { sc += 15; reasons.push('contrast/CTA'); }
    if (/cta|angio|aort|cardiac|tavi|tavr|arterial|runoff|run-off/i.test(s.desc)) { sc += 10; reasons.push('CTA-type description'); }
    if (/localizer|scout|topogram|dose|report|screen|summary|mip|mpr|curved|cpr|vrt|3d|reformat|thick|subtract|mask/i.test(s.desc) || /LOCALIZER|SECONDARY|DOSE/i.test(s.imageType)) { sc -= 50; bad.push('localizer/derived/report-like'); }
    if (/lung|bone|b[6-9]0|sharp/i.test(s.kernel)) { sc -= 8; bad.push('sharp kernel'); }
    if (s.coverage >= 300) { sc += 10; reasons.push(Math.round(s.coverage) + ' mm coverage'); }
    if (s.recs.length > s.unique * 1.3) { sc -= 25; bad.push('repeated positions (multi-phase?)'); }
    sc += Math.min(20, s.recs.length / 50);
    s.score = sc; s.reasons = reasons; s.warnings = bad;
  }

  /* ---------------- volume build ---------------- */
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // raw stored samples of one slice as Uint8Array/Uint16Array (unsigned bit patterns, length rows*cols)
  async function sliceSamples(q) {
    const t = q.tags, info = q.info, rows = t.rows, cols = t.cols, n = rows * cols, bytesPer = t.bitsAllocated / 8;
    if (info.encapsulated) {
      const all = await q.src.range(info.pixelOffset);
      const data = Codecs.joinFragments(all, 0); // `all` starts at the first item after the pixel-data header
      if (t.ts === '1.2.840.10008.1.2.5') return Codecs.rleDecode(data, rows, cols, bytesPer);
      const r = Codecs.jpegDecode(data);
      if (r.width !== cols || r.height !== rows) throw new Error('JPEG size ' + r.width + 'x' + r.height + ' does not match DICOM ' + cols + 'x' + rows);
      if (bytesPer === 1 && r.data instanceof Uint16Array) { const o = new Uint8Array(n); for (let i = 0; i < n; i++) o[i] = r.data[i]; return o; }
      return r.data;
    }
    const raw = await q.src.range(info.pixelOffset, info.pixelOffset + n * bytesPer);
    if (raw.length < n * bytesPer) throw new Error('Truncated pixel data');
    if (bytesPer === 1) return raw.slice(0, n);
    const cpy = raw.slice(0, n * 2);
    if (info.little) return new Uint16Array(cpy.buffer);
    const dv = new DataView(cpy.buffer), o = new Uint16Array(n); for (let i = 0; i < n; i++) o[i] = dv.getUint16(i * 2, false); return o;
  }
  /* Returns { dims, data(Int16 HU), origin, vi, vj, vk, warnings[], info } -- voxel (i,j,k) -> patient LPS mm:
   *   P = origin + i*vi + j*vj + k*vk ;  vi = rowDir*colSpacing, vj = colDir*rowSpacing, vk = (IPP_last-IPP_first)/(n-1) */
  async function buildVolume(series, opts, onProgress) {
    opts = opts || {};
    const warnings = [];
    let recs = series.recs.slice();
    const t0 = recs[0].tags, iop = t0.iop, r = iop.slice(0, 3), c = iop.slice(3, 6), nrm = cross(r, c);
    recs.forEach((q) => { q.pos = dot(q.tags.ipp, nrm); });
    recs.sort((a, b) => a.pos - b.pos);
    const uniq = [recs[0]];
    for (let i = 1; i < recs.length; i++) if (Math.abs(recs[i].pos - uniq[uniq.length - 1].pos) > 0.01) uniq.push(recs[i]);
    if (uniq.length < recs.length) warnings.push((recs.length - uniq.length) + ' duplicate slice positions ignored');
    recs = uniq;
    const nz = recs.length;
    if (nz < 2) throw new Error('At least 2 slices are required to build a volume (found ' + nz + ').');
    const ps = t0.pixelSpacing || [1, 1];
    if (!t0.pixelSpacing) warnings.push('PixelSpacing missing - assuming 1 mm');
    const rows = t0.rows, cols = t0.cols;
    const first = recs[0].tags.ipp, last = recs[nz - 1].tags.ipp;
    const vk = [(last[0] - first[0]) / (nz - 1), (last[1] - first[1]) / (nz - 1), (last[2] - first[2]) / (nz - 1)];
    const meanStep = Math.hypot(...vk);
    let maxDev = 0;
    for (let i = 1; i < nz; i++) maxDev = Math.max(maxDev, Math.abs((recs[i].pos - recs[i - 1].pos) - (recs[nz - 1].pos - recs[0].pos) / (nz - 1)));
    if (maxDev > 0.1 * (recs[nz - 1].pos - recs[0].pos) / (nz - 1)) warnings.push('Non-uniform slice spacing (max deviation ' + maxDev.toFixed(2) + ' mm); the volume assumes uniform spacing - verify geometry.');
    const shear = Math.abs(dot(vk, r)) + Math.abs(dot(vk, c));
    if (shear > 0.05 * meanStep) warnings.push('Slices are not perpendicular to the stack direction (gantry tilt?) - handled as a sheared volume.');
    let f = opts.downsample || 1;
    if (!opts.downsample && rows * cols * nz > 3.2e8) { f = 2; warnings.push('Large series: in-plane resolution reduced 2x to fit in browser memory.'); }
    const nx = Math.floor(cols / f), ny = Math.floor(rows / f);
    const data = new Int16Array(nx * ny * nz);
    let lastYield = Date.now();
    for (let k = 0; k < nz; k++) {
      const q = recs[k], t = q.tags;
      let arr;
      try { arr = await sliceSamples(q); } catch (e) { throw new Error('Slice ' + (k + 1) + '/' + nz + ' (' + (q.src.name || '?') + '): ' + e.message); }
      const slope = t.slope && isFinite(t.slope[0]) ? t.slope[0] : 1, icpt = t.intercept && isFinite(t.intercept[0]) ? t.intercept[0] : 0;
      const signed = t.pixelRep === 1, bs = t.bitsStored && t.bitsStored <= t.bitsAllocated ? t.bitsStored : t.bitsAllocated;
      const mask = bs >= 16 ? 0xFFFF : (1 << bs) - 1, sh = 32 - bs;
      const conv = signed ? (v) => (v << sh) >> sh : (v) => v & mask;
      const base = k * nx * ny;
      if (f === 1) {
        for (let n = 0; n < nx * ny; n++) { const hu = Math.round(conv(arr[n]) * slope + icpt); data[base + n] = hu < -32768 ? -32768 : hu > 32767 ? 32767 : hu; }
      } else {
        for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
          let acc = 0;
          for (let yy = 0; yy < f; yy++) for (let xx = 0; xx < f; xx++) acc += conv(arr[(y * f + yy) * cols + (x * f + xx)]);
          const hu = Math.round((acc / (f * f)) * slope + icpt);
          data[base + y * nx + x] = hu < -32768 ? -32768 : hu > 32767 ? 32767 : hu;
        }
      }
      q.src.release();
      if (onProgress && (k % 5 === 0 || k === nz - 1)) onProgress(k + 1, nz);
      if (Date.now() - lastYield > 40) { await tick(); lastYield = Date.now(); }
    }
    if (t0.photometric === 'MONOCHROME1') warnings.push('Photometric interpretation MONOCHROME1 - image may appear inverted.');
    return {
      dims: [nx, ny, nz], data, origin: first.slice(),
      vi: [r[0] * ps[1] * f, r[1] * ps[1] * f, r[2] * ps[1] * f], vj: [c[0] * ps[0] * f, c[1] * ps[0] * f, c[2] * ps[0] * f], vk,
      warnings, info: { desc: series.desc, modality: series.modality, slices: nz, rows, cols, downsample: f, pixelSpacing: ps, sliceStep: meanStep, codec: series.codec || 'uncompressed' }
    };
  }

  async function loadFiles(files, onProgress) {
    const sources = await expandInputs(files);
    return scanSources(sources, onProgress);
  }

  return { parseHeaderBytes, readZip, expandInputs, fileSource, makeSource, scanSources, buildVolume, loadFiles, inflateRaw, SKIP_LABELS, TS_IMPLICIT, TS_EXPLICIT };
});
