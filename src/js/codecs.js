/* NavCodecs: hand-written pixel decoders for DICOM encapsulated transfer syntaxes (no libraries).
 *  - JPEG Lossless, Non-Hierarchical (SOF3): Process 14 (1.2.840.10008.1.2.4.57) and SV1 (…4.70):
 *    Huffman coding, predictors 1-7, 2-16 bit precision, point transform, restart intervals, 0xFF00 stuffing, single component.
 *  - JPEG Baseline (SOF0, …4.50) and Extended sequential Huffman (SOF1, 8/12 bit, …4.51): single component, float IDCT.
 *  - RLE Lossless (…5), 8/16-bit, single sample per pixel.
 * NOT supported (clear error): JPEG 2000, JPEG-LS, progressive/arithmetic/hierarchical JPEG, multi-component JPEG. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NavCodecs = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const TS_NAMES = {
    '1.2.840.10008.1.2.4.50': 'JPEG Baseline (Process 1)', '1.2.840.10008.1.2.4.51': 'JPEG Extended (Process 2 & 4)',
    '1.2.840.10008.1.2.4.57': 'JPEG Lossless (Process 14)', '1.2.840.10008.1.2.4.70': 'JPEG Lossless SV1', '1.2.840.10008.1.2.5': 'RLE Lossless',
    '1.2.840.10008.1.2.4.80': 'JPEG-LS Lossless', '1.2.840.10008.1.2.4.81': 'JPEG-LS Near-lossless', '1.2.840.10008.1.2.4.90': 'JPEG 2000 Lossless', '1.2.840.10008.1.2.4.91': 'JPEG 2000',
    '1.2.840.10008.1.2.4.201': 'HTJ2K Lossless', '1.2.840.10008.1.2.4.202': 'HTJ2K RPCL', '1.2.840.10008.1.2.4.203': 'HTJ2K', '1.2.840.10008.1.2.4.52': 'JPEG Extended (Process 3 & 5)',
    '1.2.840.10008.1.2.4.53': 'JPEG Spectral Selection', '1.2.840.10008.1.2.4.55': 'JPEG Full Progression', '1.2.840.10008.1.2.4.58': 'JPEG Lossless (Process 15)', '1.2.840.10008.1.2.4.66': 'MPEG/other'
  };
  const SUPPORTED = new Set(['1.2.840.10008.1.2.4.50', '1.2.840.10008.1.2.4.51', '1.2.840.10008.1.2.4.57', '1.2.840.10008.1.2.4.70', '1.2.840.10008.1.2.5']);
  const tsName = (ts) => (TS_NAMES[ts] ? TS_NAMES[ts] + ' (' + ts + ')' : ts);

  /* ---------- encapsulated pixel data ---------- */
  // u8: buffer, off: offset of first item after the (7FE0,0010) header. Returns fragments + basic offset table.
  function parseEncapsulated(u8, off) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), frags = [], bot = [];
    let p = off, first = true;
    for (;;) {
      if (p + 8 > u8.length) throw new Error('Truncated encapsulated pixel data');
      const g = dv.getUint16(p, true), e = dv.getUint16(p + 2, true), l = dv.getUint32(p + 4, true);
      if (g === 0xFFFE && e === 0xE0DD) break;
      if (g !== 0xFFFE || e !== 0xE000) throw new Error('Malformed encapsulated pixel data');
      if (p + 8 + l > u8.length) throw new Error('Truncated pixel data fragment');
      if (first) { for (let i = 0; i + 4 <= l; i += 4) bot.push(dv.getUint32(p + 8 + i, true)); first = false; } else frags.push([p + 8, l]);
      p += 8 + l;
    }
    return { frags, bot };
  }
  // Single-frame image: concatenate all fragments (the offset table only matters for multi-frame data).
  function joinFragments(u8, off) {
    const { frags } = parseEncapsulated(u8, off);
    if (frags.length === 1) return u8.subarray(frags[0][0], frags[0][0] + frags[0][1]);
    let n = 0; frags.forEach((f) => { n += f[1]; });
    const out = new Uint8Array(n); let o = 0;
    frags.forEach((f) => { out.set(u8.subarray(f[0], f[0] + f[1]), o); o += f[1]; });
    return out;
  }

  /* ---------- JPEG ---------- */
  const ZZ = new Uint8Array([0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63]);
  function buildLut(counts, symbols) { // 16-bit lookahead table: (len << 8) | symbol ; 0 = invalid
    const lut = new Int32Array(65536); let code = 0, k = 0;
    for (let l = 1; l <= 16; l++) {
      for (let i = 0; i < counts[l - 1]; i++, k++) {
        const lo = code << (16 - l), hi = lo + (1 << (16 - l));
        if (hi > 65536) throw new Error('Invalid Huffman table');
        const v = (l << 8) | symbols[k]; for (let j = lo; j < hi; j++) lut[j] = v;
        code++;
      }
      code <<= 1;
    }
    return lut;
  }
  function parseJpeg(u8) {
    if (u8.length < 4 || u8[0] !== 0xFF || u8[1] !== 0xD8) throw new Error('Not a JPEG stream (no SOI)');
    let p = 2; const J = { dc: {}, ac: {}, q: {}, ri: 0, frame: null, scan: null, sof: -1 };
    while (p < u8.length) {
      while (p < u8.length && u8[p] !== 0xFF) p++;
      while (p < u8.length && u8[p] === 0xFF) p++;
      const m = u8[p++];
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7) || m === 0) continue;
      if (m === 0xD9) break;
      const len = (u8[p] << 8) | u8[p + 1], end = p + len; let q = p + 2;
      if (m === 0xDB) { while (q < end) { const pq = u8[q] >> 4, tq = u8[q] & 15; q++; const t = new Int32Array(64); for (let i = 0; i < 64; i++) { t[i] = pq ? (u8[q] << 8) | u8[q + 1] : u8[q]; q += pq ? 2 : 1; } J.q[tq] = t; } }
      else if (m === 0xC4) { while (q < end) { const tc = u8[q] >> 4, th = u8[q] & 15; q++; const counts = u8.subarray(q, q + 16); q += 16; let n = 0; for (let i = 0; i < 16; i++) n += counts[i]; const syms = u8.subarray(q, q + n); q += n; (tc ? J.ac : J.dc)[th] = buildLut(counts, syms); } }
      else if (m === 0xDD) J.ri = (u8[q] << 8) | u8[q + 1];
      else if (m === 0xC0 || m === 0xC1 || m === 0xC3) {
        J.sof = m; J.frame = { precision: u8[q], height: (u8[q + 1] << 8) | u8[q + 2], width: (u8[q + 3] << 8) | u8[q + 4], nf: u8[q + 5], comps: [] };
        for (let i = 0; i < J.frame.nf; i++) J.frame.comps.push({ id: u8[q + 6 + i * 3], hv: u8[q + 7 + i * 3], tq: u8[q + 8 + i * 3] });
      }
      else if ((m >= 0xC2 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC)) throw new Error('Unsupported JPEG process (SOF' + (m - 0xC0) + ': progressive / hierarchical / arithmetic / lossless-arithmetic)');
      else if (m === 0xDA) {
        if (!J.frame) throw new Error('SOS before SOF');
        const ns = u8[q++]; const comps = []; for (let i = 0; i < ns; i++) { comps.push({ cs: u8[q], td: u8[q + 1] >> 4, ta: u8[q + 1] & 15 }); q += 2; }
        J.scan = { ns, comps, ss: u8[q], se: u8[q + 1], ah: u8[q + 2] >> 4, al: u8[q + 2] & 15, start: end }; break;
      }
      p = end;
    }
    if (!J.frame || !J.scan) throw new Error('JPEG stream without frame/scan');
    if (J.frame.height === 0) throw new Error('JPEG with DNL (height 0) is not supported');
    return J;
  }
  // remove 0xFF00 stuffing; split at RSTn markers. Returns {buf, starts[], ends[]}
  function unstuff(u8, start) {
    const buf = new Uint8Array(u8.length - start + 8), starts = [0], ends = [];
    let o = 0, i = start; const n = u8.length;
    while (i < n) {
      const b = u8[i];
      if (b !== 0xFF) { buf[o++] = b; i++; continue; }
      const nx = u8[i + 1];
      if (nx === 0) { buf[o++] = 0xFF; i += 2; }
      else if (nx >= 0xD0 && nx <= 0xD7) { ends.push(o); starts.push(o); i += 2; }
      else if (nx === 0xFF) { i++; }
      else break; // EOI or other marker
    }
    ends.push(o);
    return { buf, starts, ends };
  }
  function decodeLossless(J, u8) {
    const f = J.frame, sc = J.scan, W = f.width, H = f.height, P = f.precision, Pt = sc.al, ss = sc.ss;
    if (f.nf !== 1 || sc.ns !== 1) throw new Error('Multi-component lossless JPEG is not supported (grayscale only)');
    if (ss < 1 || ss > 7) throw new Error('Invalid lossless predictor ' + ss);
    if (P < 2 || P > 16) throw new Error('Unsupported lossless precision ' + P);
    const lut = J.dc[sc.comps[0].td]; if (!lut) throw new Error('Missing Huffman table');
    const total = W * H, out = new Uint16Array(total), ri = J.ri > 0 ? J.ri : total, seg = unstuff(u8, sc.start);
    const dflt = 1 << (P - Pt - 1);
    let idx = 0, si = 0;
    while (idx < total) {
      if (si >= seg.starts.length) throw new Error('Not enough scan data (truncated JPEG)');
      const buf = seg.buf, end = seg.ends[si]; let pos = seg.starts[si], bits = 0, cnt = 0;
      const segEnd = Math.min(total, idx + ri), iStart = idx;
      let x = idx % W;
      while (idx < segEnd) {
        while (cnt < 16) { bits = (bits << 8) | (pos < end ? buf[pos] : 0); pos++; cnt += 8; }
        const e = lut[(bits >>> (cnt - 16)) & 0xFFFF]; if (e === 0) throw new Error('Corrupt Huffman data');
        cnt -= e >> 8; const s = e & 255; let diff;
        if (s === 0) diff = 0;
        else if (s === 16) diff = 32768;
        else {
          while (cnt < s) { bits = (bits << 8) | (pos < end ? buf[pos] : 0); pos++; cnt += 8; }
          diff = (bits >>> (cnt - s)) & ((1 << s) - 1); cnt -= s;
          if (diff < (1 << (s - 1))) diff -= (1 << s) - 1;
        }
        let pred;
        if (idx === iStart) pred = dflt;
        else if (idx < iStart + W || idx < W) pred = out[idx - 1];
        else if (x === 0) pred = out[idx - W];
        else {
          const ra = out[idx - 1], rb = out[idx - W], rc = out[idx - W - 1];
          switch (ss) { case 1: pred = ra; break; case 2: pred = rb; break; case 3: pred = rc; break; case 4: pred = ra + rb - rc; break; case 5: pred = ra + ((rb - rc) >> 1); break; case 6: pred = rb + ((ra - rc) >> 1); break; default: pred = (ra + rb) >> 1; }
        }
        out[idx++] = (pred + diff) & 0xFFFF;
        if (++x === W) x = 0;
      }
      si++;
    }
    if (Pt > 0) for (let i = 0; i < total; i++) out[i] = (out[i] << Pt) & 0xFFFF;
    return { data: out, width: W, height: H, precision: P };
  }
  // Baseline / extended sequential Huffman DCT, one component.
  const COS = (() => { const c = new Float64Array(64); for (let x = 0; x < 8; x++) for (let u = 0; u < 8; u++) c[x * 8 + u] = (u === 0 ? Math.SQRT1_2 : 1) * Math.cos((2 * x + 1) * u * Math.PI / 16) / 2; return c; })();
  function idct8(coef, out, tmp) {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { let s = 0; for (let u = 0; u < 8; u++) s += COS[x * 8 + u] * coef[y * 8 + u]; tmp[y * 8 + x] = s; }
    for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) { let s = 0; for (let v = 0; v < 8; v++) s += COS[y * 8 + v] * tmp[v * 8 + x]; out[y * 8 + x] = s; }
  }
  function decodeDct(J, u8) {
    const f = J.frame, sc = J.scan, W = f.width, H = f.height, P = f.precision;
    if (f.nf !== 1 || sc.ns !== 1) throw new Error('Multi-component JPEG (colour) is not supported');
    const dcl = J.dc[sc.comps[0].td], acl = J.ac[sc.comps[0].ta], q = J.q[f.comps[0].tq];
    if (!dcl || !acl || !q) throw new Error('Missing JPEG table');
    const seg = unstuff(u8, sc.start), bw = Math.ceil(W / 8), bh = Math.ceil(H / 8), nBlocks = bw * bh, ri = J.ri > 0 ? J.ri : nBlocks;
    const out = new Uint16Array(W * H), coef = new Float64Array(64), blk = new Float64Array(64), tmp = new Float64Array(64), maxv = (1 << P) - 1, off = 1 << (P - 1);
    let b = 0, si = 0;
    while (b < nBlocks) {
      if (si >= seg.starts.length) throw new Error('Truncated JPEG');
      const buf = seg.buf, end = seg.ends[si]; let pos = seg.starts[si], bits = 0, cnt = 0, dcp = 0;
      const need = (n) => { while (cnt < n) { bits = (bits << 8) | (pos < end ? buf[pos] : 0); pos++; cnt += 8; } };
      const get = (n) => { if (n === 0) return 0; need(n); const v = (bits >>> (cnt - n)) & ((1 << n) - 1); cnt -= n; return v; };
      const sym = (lut) => { need(16); const e = lut[(bits >>> (cnt - 16)) & 0xFFFF]; if (e === 0) throw new Error('Corrupt Huffman data'); cnt -= e >> 8; return e & 255; };
      const ext = (v, s) => (v < (1 << (s - 1)) ? v - (1 << s) + 1 : v);
      const stop = Math.min(nBlocks, b + ri);
      for (; b < stop; b++) {
        coef.fill(0);
        const s = sym(dcl); dcp += s ? ext(get(s), s) : 0; coef[0] = dcp * q[0];
        for (let k = 1; k < 64;) { const rs = sym(acl), r = rs >> 4, ss = rs & 15; if (ss === 0) { if (r === 15) { k += 16; continue; } break; } k += r; if (k > 63) break; coef[ZZ[k]] = ext(get(ss), ss) * q[k]; k++; }
        idct8(coef, blk, tmp);
        const bx = (b % bw) * 8, by = Math.floor(b / bw) * 8;
        for (let y = 0; y < 8 && by + y < H; y++) for (let x = 0; x < 8 && bx + x < W; x++) { let v = Math.round(blk[y * 8 + x]) + off; out[(by + y) * W + bx + x] = v < 0 ? 0 : v > maxv ? maxv : v; }
      }
      si++;
    }
    return { data: out, width: W, height: H, precision: P };
  }
  function jpegDecode(u8) {
    const J = parseJpeg(u8);
    return J.sof === 0xC3 ? decodeLossless(J, u8) : decodeDct(J, u8);
  }

  /* ---------- RLE ---------- */
  function rleDecode(u8, rows, cols, bytesPer) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), nseg = dv.getUint32(0, true), n = rows * cols;
    if (nseg !== bytesPer) throw new Error('RLE: expected ' + bytesPer + ' segment(s), found ' + nseg);
    const planes = [];
    for (let s = 0; s < nseg; s++) {
      let p = dv.getUint32(4 + 4 * s, true); const end = s + 1 < nseg ? dv.getUint32(8 + 4 * s, true) : u8.length, plane = new Uint8Array(n); let o = 0;
      while (o < n && p < end) {
        const c = u8[p++];
        if (c < 128) { const l = c + 1; for (let i = 0; i < l && o < n; i++) plane[o++] = u8[p++]; }
        else if (c > 128) { const l = 257 - c, v = u8[p++]; for (let i = 0; i < l && o < n; i++) plane[o++] = v; }
      }
      if (o < n) throw new Error('RLE: truncated segment');
      planes.push(plane);
    }
    if (bytesPer === 1) return planes[0];
    const out = new Uint16Array(n); for (let i = 0; i < n; i++) out[i] = (planes[0][i] << 8) | planes[1][i];
    return out;
  }

  return { TS_NAMES, SUPPORTED, tsName, parseEncapsulated, joinFragments, jpegDecode, parseJpeg, rleDecode };
});
