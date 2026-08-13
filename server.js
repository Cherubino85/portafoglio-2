'use strict';
/* server.js — server locale di sviluppo. In produzione non serve:
 * su Netlify gli stessi endpoint girano come functions. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const dati = require('./data');

const TIPI = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.webmanifest':'application/manifest+json; charset=utf-8', '.png':'image/png',
  '.svg':'image/svg+xml', '.ico':'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(url.searchParams);
  const json = (code, corpo) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store' });
    res.end(JSON.stringify(corpo));
  };
  try {
    if (url.pathname === '/api/home')
      return json(200, await dati.home({ from: q.from, to: q.to, force: q.force === '1' }));
    if (url.pathname === '/api/account')
      return json(200, await dati.account(q.id, { from: q.from, to: q.to, force: q.force === '1' }));
  } catch (e) {
    return json(e.status || 500, { errore: e.message });
  }
  // file statici da public/
  let p = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : url.pathname);
  if (!p.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404, {'content-type':'text/plain'}); return res.end('Non trovato'); }
    res.writeHead(200, { 'content-type': TIPI[path.extname(p)] || 'application/octet-stream' });
    res.end(buf);
  });
});

const PORTA = process.env.PORT || 3000;
server.listen(PORTA, () => console.log(`Dashboard su http://localhost:${PORTA}`));
