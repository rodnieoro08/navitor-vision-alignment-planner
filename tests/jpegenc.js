// Test-only lossless JPEG (SOF3) encoder: predictors 1-7, precision 2-16, point transform, restart intervals, 0xFF00 stuffing.
function encodeLossless(samples, W, H, o) {
  o = o || {}; const P = o.P || 16, ss = o.predictor || 1, pt = o.pt || 0, ri = o.ri || 0;
  const lens = o.lens || [2, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 16]; // code length per SSSS 0..16 (skewed -> exercises long codes)
  // canonical codes
  const order = lens.map((l, s) => [l, s]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const counts = new Array(16).fill(0), syms = [], code = {}; let c = 0, prev = order[0][0];
  for (const [l, s] of order) { c <<= (l - prev); prev = l; code[s] = [c, l]; c++; counts[l - 1]++; syms.push(s); }
  const out = []; const w16 = (v) => out.push((v >> 8) & 255, v & 255);
  out.push(0xFF, 0xD8);
  if (ri) { out.push(0xFF, 0xDD); w16(4); w16(ri); }
  out.push(0xFF, 0xC4); w16(2 + 1 + 16 + syms.length); out.push(0x00, ...counts, ...syms);
  out.push(0xFF, 0xC3); w16(11); out.push(P); w16(H); w16(W); out.push(1, 1, 0x11, 0);
  out.push(0xFF, 0xDA); w16(8); out.push(1, 1, 0x00, ss, 0, pt);
  let acc = 0, nb = 0, rst = 0;
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) { acc = (acc << 1) | ((v >> i) & 1); if (++nb === 8) { out.push(acc); if (acc === 0xFF) out.push(0); acc = 0; nb = 0; } } };
  const flush = () => { while (nb !== 0) put(1, 1); };
  const val = new Int32Array(W * H); for (let i = 0; i < W * H; i++) val[i] = samples[i] >> pt;
  let iStart = 0;
  for (let i = 0; i < W * H; i++) {
    if (ri && i > 0 && i % ri === 0) { flush(); out.push(0xFF, 0xD0 + (rst++ & 7)); iStart = i; }
    const x = i % W; let pred;
    if (i === iStart) pred = 1 << (P - pt - 1);
    else if (i < iStart + W || i < W) pred = val[i - 1];
    else if (x === 0) pred = val[i - W];
    else { const ra = val[i - 1], rb = val[i - W], rc = val[i - W - 1]; pred = [0, ra, rb, rc, ra + rb - rc, ra + ((rb - rc) >> 1), rb + ((ra - rc) >> 1), (ra + rb) >> 1][ss]; }
    const d = ((val[i] - pred) << 16) >> 16; let s = 0;
    if (d === -32768) s = 16; else { const m = Math.abs(d); while ((1 << s) <= m) s++; }
    put(code[s][0], code[s][1]);
    if (s > 0 && s < 16) put(d >= 0 ? d : d + (1 << s) - 1, s);
  }
  flush(); out.push(0xFF, 0xD9);
  return Buffer.from(out);
}
module.exports = { encodeLossless };
