# Portafoglio Forex — dashboard personale

I conti MT4 aggregati via API Myfxbook. PWA installabile, funziona offline
sull'ultimo dato scaricato.

## Struttura piatta, di proposito

Tutto sta alla radice del repository. C'e' **una sola cartella**, `funzioni`,
con **un solo file** dentro.

Il motivo e' pratico: il caricamento web di GitHub perde la struttura delle
cartelle quando si trascina, e i file finiscono tutti alla radice. Con questa
struttura non c'e' niente da perdere. La cartella `funzioni` si crea scrivendone
il nome nel campo del file, non trascinandola.

Conseguenza da sapere: con `publish = "."` Netlify pubblica anche i sorgenti
(`engine.js`, `myfxbook.js`, `data.js`). Non contengono credenziali — quelle
stanno nelle variabili d'ambiente — ma sono leggibili da chi conosce
l'indirizzo. Quando la dashboard diventera' un prodotto, si sposta la parte
pubblica in una sottocartella e si cambia `publish`.

## File

```
index.html            la PWA
sw.js                 service worker
manifest.webmanifest  installazione
icon-192.png icon-512.png mask-512.png
engine.js             calcoli: rendimenti, attribuzione, swap, drawdown
myfxbook.js           client API Myfxbook + normalizzazione + cambi BCE
data.js               dati reali o dimostrativi, cache 5 minuti
server.js             server locale di sviluppo
package.json  netlify.toml  .env.example
funzioni/api.js       l'endpoint /api/*
```

## Prova in locale
```
node server.js     # http://localhost:3000
node engine.js     # collaudo del motore di calcolo
```
Senza credenziali parte con dati dimostrativi.

## Deploy su Netlify
1. **Add new site -> Import an existing project**, scegli il repository.
2. Non modificare niente nella schermata di configurazione: publish, functions
   e build command arrivano da `netlify.toml`.
3. **Site configuration -> Environment variables**: `MYFXBOOK_EMAIL` e
   `MYFXBOOK_PASSWORD`.
4. **Deploys -> Trigger deploy -> Deploy site**.

## Due punti che restano risolti
- `get-data-daily` restituisce un **array di array**: va appiattito.
- `floatingPL` e' quasi sempre 0: l'equity si prende da **`growthEquity`**,
  non da `balance + floatingPL`.

## Convivenza con altre app
Cache con prefisso `portafoglio-` (cancella solo le proprie), chiavi locali con
prefisso `pf:`, e il service worker ignora `/simulatore`. Il simulatore va
comunque tenuto su un sito suo.
