"""Independent oracles for the test-encoder streams (tests/out/jpegcases):
  * Richter libjpeg (pylibjpeg-libjpeg): all Pt=0 cases (8/12/16-bit, predictors 1-7, restarts)
  * libjpeg-turbo 3.x (imagecodecs.jpeg8_decode): ALL 8-bit cases, including point transform Pt=2
Known: Richter libjpeg and imagecodecs' SOF3 codec decode Pt>0 streams differently from libjpeg-turbo / T.81
(they disagree with each other too); DICOM CT in practice uses Pt=0, so Pt>0 is only verified against libjpeg-turbo (8-bit)."""
import json, os, sys, numpy as np, libjpeg, imagecodecs
d = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'out', 'jpegcases')
cases = json.load(open(os.path.join(d, 'cases.json'))); bad = 0; nr = nt = 0
for c in cases:
    data = open(os.path.join(d, c['name'] + '.jpg'), 'rb').read()
    exp = np.fromfile(os.path.join(d, c['name'] + '.raw'), '<u2').reshape(c['H'], c['W'])
    if c['pt'] == 0:
        got = libjpeg.decode(data).astype(np.uint16).reshape(exp.shape); nr += 1
        if not np.array_equal(got, exp): print('MISMATCH libjpeg', c['name']); bad += 1
    if c['P'] == 8:
        got = imagecodecs.jpeg8_decode(data).astype(np.uint16).reshape(exp.shape); nt += 1
        if not np.array_equal(got, exp): print('MISMATCH libjpeg-turbo', c['name']); bad += 1
print(f'oracles: Richter libjpeg {nr} Pt=0 cases, libjpeg-turbo {nt} 8-bit cases (incl. Pt=2); mismatches: {bad}'); sys.exit(1 if bad else 0)
