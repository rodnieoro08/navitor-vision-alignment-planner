// Builds the single-file app: inlines CSS + JS into index.html (no external requests, no CDN).
const fs = require('fs'), path = require('path');
const src = path.join(__dirname, 'src');
const js = ['math.js', 'volume.js', 'codecs.js', 'dicom.js', 'nadir.js', 'mpr.js', 'phantom.js', 'views.js', 'app.js'].map((f) => '/* ==== ' + f + ' ==== */\n' + fs.readFileSync(path.join(src, 'js', f), 'utf8')).join('\n');
if (/<\/script/i.test(js)) throw new Error('JS contains </script');
const css = fs.readFileSync(path.join(src, 'css', 'style.css'), 'utf8');
const html = fs.readFileSync(path.join(src, 'index.template.html'), 'utf8').replace('/*__CSS__*/', () => css).replace('/*__JS__*/', () => js);
fs.writeFileSync(path.join(__dirname, 'index.html'), html);
console.log('index.html written: ' + (html.length / 1024).toFixed(0) + ' kB');
