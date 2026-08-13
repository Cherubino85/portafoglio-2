/* Service worker della dashboard.
 *
 * Due regole che qui sono deliberate, non dettagli:
 *
 * 1. Al cambio versione cancella SOLO le cache che iniziano per "portafoglio-".
 *    Le cache sono condivise da tutto il dominio: un "cancella tutto quello che
 *    non e' mio" farebbe fuori anche quelle di un'altra app ospitata sullo
 *    stesso indirizzo, e le due app si azzererebbero a vicenda a ogni apertura.
 * 2. Ignora qualsiasi richiesta sotto /simulatore/. Questo worker ha scope "/"
 *    e coprirebbe anche quel percorso finche' l'altro non si installa,
 *    finendo per servire la dashboard al posto del simulatore.
 */
const VERSIONE = 'portafoglio-v3';
const GUSCIO = [
  './', 'index.html', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSIONE)
      .then(c => Promise.allSettled(GUSCIO.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(chiavi => Promise.all(
        chiavi.filter(k => k.startsWith('portafoglio-') && k !== VERSIONE)
              .map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.startsWith('/simulatore')) return;

  const api = url.pathname.startsWith('/api/');
  const pagina = req.mode === 'navigate';

  if (api || pagina) {
    // rete per prima: il dato fresco quando c'e' linea, l'ultimo salvato quando manca
    e.respondWith(
      fetch(req).then(r => {
        const copia = r.clone();
        caches.open(VERSIONE).then(c => c.put(req, copia)).catch(() => {});
        return r;
      }).catch(() => caches.match(req).then(r => r || caches.match('index.html')))
    );
    return;
  }

  // il resto (icone, libreria dei grafici): cache per prima
  e.respondWith(
    caches.match(req).then(r => r || fetch(req).then(res => {
      const copia = res.clone();
      caches.open(VERSIONE).then(c => c.put(req, copia)).catch(() => {});
      return res;
    }))
  );
});
