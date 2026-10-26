// Tiny static server for the bonfire page: node server.js [--port=4800]
const http = require('http'), fs = require('fs'), path = require('path');
const port = +((process.argv.find(a => a.startsWith('--port=')) || '').split('=')[1] || 4800);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webm': 'video/webm' };
http.createServer((req, res) => {
  // same handler Vercel runs for /api/avatar, so local dev matches production
  if (req.url.split('?')[0] === '/api/avatar') return require('./api/avatar.js')(req, res);
  if (req.url.split('?')[0] === '/wolves/list.json') {
    // which sticker files exist, so the page doesn't probe for missing numbers
    const files = fs.readdirSync(path.join(__dirname, 'wolves')).filter(f => /^\d+\.(webm|webp|png)$/.test(f));
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(files));
  }
  let u = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+$/, '/index.html');
  if (!path.extname(u)) u += '.html'; // clean URLs like Vercel: /bonfire -> bonfire.html
  const p = path.join(__dirname, u);
  if (!p.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': types[path.extname(p)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(port, '127.0.0.1', () => console.log(`bonfire on http://127.0.0.1:${port}`));
