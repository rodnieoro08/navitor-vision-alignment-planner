// Writes the synthetic phantom as an uncompressed DICOM series + a .zip, for testing the DICOM loading path.
// Usage: node tests/make_sample_dicom.js  -> tests/out/phantom_dicom/*.dcm and tests/out/phantom_dicom.zip
const fs = require('fs'), path = require('path');
const P = require('../src/js/phantom.js'), W = require('./dicomwriter.js');
const out = path.join(__dirname, 'out', 'phantom_dicom'); fs.mkdirSync(out, { recursive: true });
const g = P.generate(), slices = W.volumeToSlices(g.volume), files = [];
slices.forEach((s, i) => { const buf = W.writeSlice(s); const name = 'IM' + String(i + 1).padStart(4, '0') + '.dcm'; fs.writeFileSync(path.join(out, name), buf); files.push({ name: 'phantom_dicom/' + name, data: buf }); });
fs.writeFileSync(path.join(__dirname, 'out', 'phantom_dicom.zip'), W.zip(files));
console.log('wrote', slices.length, 'slices to', out, 'and phantom_dicom.zip');
