// Tiny static file server (no dependencies). Usage: node serve.js [port]   (0 or omitted = pick a free port)
const http = require('http'), fs = require('fs'), path = require('path');
const root = __dirname, types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.md': 'text/plain; charset=utf-8' };
const srv = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.normalize(path.join(root, p));
  if (!f.startsWith(root) || /node_modules|\.git/.test(f) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(res);
});
srv.listen(+process.argv[2] || 0, '127.0.0.1', () => { const port = srv.address().port; fs.writeFileSync(path.join(root, '.port'), String(port)); console.log('Navitor alignment planner: http://127.0.0.1:' + port + '/'); });
