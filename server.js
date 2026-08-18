/* server.js — server locale di sviluppo. Su Cloudflare non viene usato:
   la' l'ingresso e' worker.js. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as dati from './data.js';

const QUI = path.dirname(fileURLToPath(import.meta.url));
const TIPI = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.webmanifest':'application/manifest+json; charset=utf-8', '.png':'image/png',
  '.svg':'image/svg+xml', '.ico':'image/x-icon' };

dati.impostaAmbiente(process.env);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const q = Object.fromEntries(url.searchParams);

  if (url.pathname.startsWith('/api/')) {
    try {
      let out;
      if (q.diagnostica === '1') out = await dati.diagnostica();
      else if (q.campi === '1') out = await dati.campi();
      else out = q.id
        ? await dati.account(q.id, { from:q.from, to:q.to, force:q.force==='1' })
        : await dati.home({ from:q.from, to:q.to, force:q.force==='1' });
      res.writeHead(200, {'content-type':'application/json; charset=utf-8','cache-control':'no-store'});
      return res.end(JSON.stringify(out));
    } catch (e) {
      res.writeHead(e.status || 500, {'content-type':'application/json; charset=utf-8'});
      return res.end(JSON.stringify({ errore: e.message }));
    }
  }

  const nome = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const est = path.extname(nome);
  if (!TIPI[est] || nome.includes('..')) { res.writeHead(404); return res.end('Non trovato'); }
  fs.readFile(path.join(QUI, 'sito', nome), (err, buf) => {
    if (err) { res.writeHead(404, {'content-type':'text/plain'}); return res.end('Non trovato'); }
    res.writeHead(200, { 'content-type': TIPI[est] });
    res.end(buf);
  });
}).listen(process.env.PORT || 3000,
  () => console.log('Dashboard su http://localhost:' + (process.env.PORT || 3000)));
