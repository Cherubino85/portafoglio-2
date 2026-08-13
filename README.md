# Portafoglio Forex — dashboard personale

I conti MT4 aggregati via API Myfxbook. PWA installabile, funziona offline
sull'ultimo dato scaricato.

- Rendimento combinato in percentuale, neutrale al cambio
- Curva del saldo, curva equity (flottante incluso) e swap incassato
- Guadagno mensile per conto, convertito in euro ai cambi BCE
- Drawdown massimo, filtro per intervallo di date
- Pagina di dettaglio per singolo conto
- Capitale occultabile con un tocco

## Prova in locale
```
node server.js     # http://localhost:3000
node engine.js     # collaudo rapido del motore di calcolo
```
Senza credenziali parte con dati dimostrativi.

## Struttura
```
engine.js                 calcoli: rendimenti, attribuzione, swap, drawdown
myfxbook.js               client API Myfxbook + normalizzazione + cambi BCE
data.js                   sceglie fra dati reali e dimostrativi, con cache 5 min
server.js                 server locale di sviluppo
netlify.toml              instrada /api/* alle functions
netlify/functions/        gli stessi endpoint per il deploy
public/                   la PWA: index.html, sw.js, manifest, icone
```

## Deploy su Netlify
1. Repository GitHub collegato: **Add new site -> Import from Git**.
2. Non toccare le impostazioni: arrivano da `netlify.toml`
   (publish `public`, functions `netlify/functions`, build command vuoto).
3. **Site configuration -> Environment variables**:
   - `MYFXBOOK_EMAIL`
   - `MYFXBOOK_PASSWORD`
4. **Deploys -> Trigger deploy -> Deploy site** per rigenerare con le credenziali.

## Due punti che sono costati tempo e che qui restano risolti
- `get-data-daily` restituisce un **array di array**: va appiattito.
- `floatingPL` dell'API e' quasi sempre 0: l'equity **non** si ricostruisce come
  balance + floatingPL, si usa il campo **`growthEquity`** che Myfxbook fornisce
  gia' calcolato. E' la loro linea "Equity Growth".

## Convivenza con altre app sullo stesso dominio
Le cache del browser sono condivise da tutto il dominio. Il service worker qui
cancella **solo** le cache che iniziano per `portafoglio-` e ignora qualsiasi
richiesta sotto `/simulatore`. Anche le chiavi di memoria locale hanno prefisso
proprio (`pf:`). Senza queste tre accortezze due PWA sullo stesso indirizzo si
azzerano a vicenda.

## Un solo repository, una sola piattaforma
Questo repository deve essere collegato a **una piattaforma di deploy soltanto**.
Se resta collegato anche a un'altra (Cloudflare Workers, Pages, Vercel), quella
pubblica gli stessi file senza le Netlify Functions: la dashboard appare ma
`/api/home` risponde 404 e nessun dato compare.
