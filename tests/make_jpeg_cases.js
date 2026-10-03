// Generates lossless-JPEG test streams with the JS test encoder (+ expected raw), for independent verification by libjpeg (tests/verify_jpeg_cases.py)
// and for the decoder tests.
const fs = require('fs'), path = require('path'), { encodeLossless } = require('./jpegenc.js');
const dir = path.join(__dirname, 'out', 'jpegcases'); fs.mkdirSync(dir, { recursive: true });
function image(W, H, P, seed) {
  let s = seed; const r = () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296, max = (1 << P) - 1, a = new Uint16Array(W * H);
  let v = max / 2;
  for (let i = 0; i < W * H; i++) { v += (r() - 0.5) * max * 0.08; if (r() < 0.01) v = r() < 0.5 ? 0 : max; v = Math.min(max, Math.max(0, v)); a[i] = Math.round(v); }
  a[0] = max; if (W * H > 3) { a[1] = 0; a[2] = max; a[3] = 0; } // extremes -> large differences (SSSS 15/16)
  return a;
}
const cases = []; let seed = 1;
for (const [W, H] of [[37, 29], [64, 17]]) for (const P of [8, 12, 16]) for (let ss = 1; ss <= 7; ss++) for (const pt of [0, 2]) for (const ri of [0, W, 3 * W]) {
  const img = image(W, H, P, seed++), name = `ll_${W}x${H}_p${P}_ss${ss}_pt${pt}_ri${ri / W}`;
  const enc = encodeLossless(img, W, H, { P, predictor: ss, pt, ri }), exp = new Uint16Array(W * H); for (let i = 0; i < W * H; i++) exp[i] = ((img[i] >> pt) << pt);
  fs.writeFileSync(path.join(dir, name + '.jpg'), enc); fs.writeFileSync(path.join(dir, name + '.raw'), Buffer.from(exp.buffer));
  cases.push({ name, W, H, P, ss, pt, ri: ri / W });
}
fs.writeFileSync(path.join(dir, 'cases.json'), JSON.stringify(cases));
console.log('wrote', cases.length, 'lossless JPEG cases to', dir);
