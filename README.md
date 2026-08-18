# Portafoglio Forex — dashboard su Cloudflare Workers

I conti MT4 aggregati via API Myfxbook. PWA installabile, funziona offline
sull'ultimo dato scaricato.

## Struttura

```
wrangler.jsonc     configurazione Cloudflare
worker.js          punto di ingresso: gestisce /api/*
engine.js          calcoli: rendimenti, attribuzione, swap, drawdown
myfxbook.js        client API Myfxbook + normalizzazione + cambi BCE
data.js            dati reali o dimostrativi, cache 5 minuti
server.js          server locale di sviluppo (non usato in produzione)
package.json
sito/              i file pubblici: index.html, sw.js, manifest, icone
```

I sorgenti stanno FUORI da `sito/`, quindi non sono raggiungibili dal web:
e' un miglioramento rispetto alla versione Netlify, dove la radice pubblicata
li esponeva.

## Come funziona il traffico

Cloudflare prova prima a servire un file da `sito/`. Solo se nessun file
corrisponde entra in gioco `worker.js` — cioe' unicamente per `/api/*`.
Le richieste ai file statici sono gratuite e illimitate anche sul piano
libero: consuma solo l'API, che con la cache viene chiamata di rado.

## Deploy

1. https://dash.cloudflare.com -> Compute (Workers) -> crea un Worker
   collegandolo al repository GitHub.
2. Nelle impostazioni del Worker aggiungi due **Secret**:
   - `MYFXBOOK_EMAIL`
   - `MYFXBOOK_PASSWORD`
   Vanno inseriti come Secret, non come variabili in chiaro.
3. Ogni push su `main` ripubblica automaticamente.

## Prova in locale
```
MYFXBOOK_EMAIL=... MYFXBOOK_PASSWORD=... node server.js
```
Senza credenziali parte con dati dimostrativi.

## Limite da tenere d'occhio

Il piano gratuito concede 10 ms di CPU per richiesta. L'attesa delle risposte
di Myfxbook non conta. Il calcolo sulla finestra predefinita "Dal 2023" costa
meno di 1 ms; sullo storico completo dal 2016 sta intorno ai 7 ms. Se un
giorno lo storico completo dovesse superare il limite, la soluzione e'
spostare il calcolo delle curve nel browser: il Worker restituirebbe le serie
grezze e il resto lo farebbe la pagina.
