/* =====================================================================
   live.js — licenza e telemetria dell'expert, su D1.
   Versione 1.1, 10/09/2026 (v1 il 08/09). Sostituisce worker-live.js del 23/08.

   Contratto di rete: e' quello che GridTelemetry.mqh gia' invia
   (23/08, invariato): l'expert e' chiuso, il Worker si adatta.

     POST /licenza  {chiave, conto, broker, simbolo}
                    -> {valida: true|false, scadenza, messaggio}
                    L'expert legge solo "valida" (JsonValue piatto).
     POST /griglia  {chiave, conto, simbolo, magico, evento, ts,
                     posizioni, lotti, flottante, breakEven,
                     livelloMargine, pipChiamata, pipStopOut,
                     swapGiorno, livelliResidui, fermo,
                     + campi del conto facoltativi (expert v1.1):
                     saldo, equity, margine, margineLibero,
                     posizioniConto, lottiConto, flottanteConto,
                     swapAperto, valuta, server, leva}
                    -> {ok: true}   (esito ignorato dall'expert)
     (la lettura per la Console sta in auth.js: GET /api/live, per
      sessione; l'endpoint provvisorio /live con la chiave come Bearer
      e' stato tolto il 10/09)

   PRINCIPIO DA NON VIOLARE (deciso 23/08): il flusso e' a senso unico.
   Nessuna risposta contiene un comando che l'expert esegue sul conto.
   Un canale che possa ordinare operazioni su un conto altrui e'
   gestione di portafogli, attivita' riservata (art. 166 TUF).

   SECONDO PRINCIPIO (deciso 23/08): il controllo di licenza non deve
   mai poter danneggiare il conto. Qui si risponde; e' l'expert che,
   a licenza non valida, smette di APRIRE e continua a gestire.
   Un errore del Worker (5xx) vale per l'expert come "nessuna
   risposta" e apre la tolleranza di sette giorni: percio' ogni
   percorso qui risponde 200 con valida false solo quando la risposta
   e' certa, e 4xx/5xx quando non lo e'.
   ===================================================================== */

const LIMITE_CORPO = 8 * 1024;          // byte: piu' di cosi' non e' l'expert

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  });

const ora = () => Math.floor(Date.now() / 1000);
const giornoUtc = (sec) => new Date(sec * 1000).toISOString().slice(0, 10);

/* ---- lettura difensiva del corpo --------------------------------- */
async function leggiCorpo(request) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > LIMITE_CORPO) return { errore: 'corpo troppo grande' };
  let testo;
  try { testo = await request.text(); } catch { return { errore: 'corpo non leggibile' }; }
  if (testo.length > LIMITE_CORPO) return { errore: 'corpo troppo grande' };
  try { return { dati: JSON.parse(testo) }; } catch { return { errore: 'JSON non valido' }; }
}

const num = (v, alt = null) => { const n = Number(v); return Number.isFinite(n) ? n : alt; };
const intero = (v, alt = null) => { const n = num(v); return n === null ? alt : Math.trunc(n); };
const testo = (v, max = 64) => (v == null ? '' : String(v)).slice(0, max);
const simboloValido = (s) => /^[A-Za-z0-9._#&!+-]{1,32}$/.test(s);

/* ---- idempotenza (deciso 04/09) ---------------------------------------
   Per le scritture irreversibili che arriveranno da webhook e da
   strumenti di amministrazione: a chiave gia' vista si restituisce
   l'esito salvato senza rieseguire. L'attivazione di una licenza dal
   lato expert e' idempotente per costruzione (stesso conto -> stesso
   esito) e non ne ha bisogno.
   -------------------------------------------------------------------- */
export async function conRicevuta(env, chiaveIdem, operazione, esegui) {
  if (!chiaveIdem) return esegui();
  const gia = await env.DB.prepare('SELECT esito FROM ricevute WHERE chiave = ?')
    .bind(chiaveIdem).first();
  if (gia) return JSON.parse(gia.esito);
  const esito = await esegui();
  await env.DB.prepare('INSERT OR IGNORE INTO ricevute (chiave, operazione, esito, creata) VALUES (?,?,?,?)')
    .bind(chiaveIdem, operazione, JSON.stringify(esito), ora()).run();
  return esito;
}

/* ---- licenza --------------------------------------------------------- */
async function verificaLicenza(env, chiave, conto, broker) {
  const lic = await env.DB.prepare(
    'SELECT chiave, scadenza, attiva, max_conti FROM licenze WHERE chiave = ?'
  ).bind(chiave).first();

  if (!lic) return { valida: false, messaggio: 'chiave sconosciuta' };
  if (!lic.attiva) return { valida: false, messaggio: 'licenza disattivata' };
  if (lic.scadenza && lic.scadenza < ora())
    return { valida: false, scadenza: lic.scadenza, messaggio: 'licenza scaduta' };

  const adesso = ora();
  const mia = await env.DB.prepare(
    'SELECT conto FROM attivazioni WHERE chiave = ? AND conto = ?'
  ).bind(chiave, conto).first();

  if (mia) {
    await env.DB.prepare('UPDATE attivazioni SET ultima = ? WHERE chiave = ? AND conto = ?')
      .bind(adesso, chiave, conto).run();
    return { valida: true, scadenza: lic.scadenza || 0 };
  }

  const usate = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM attivazioni WHERE chiave = ?'
  ).bind(chiave).first();

  if ((usate?.n || 0) >= lic.max_conti) {
    return {
      valida: false,
      messaggio: `chiave gia' attivata su ${lic.max_conti} cont${lic.max_conti === 1 ? 'o' : 'i'}`
    };
  }

  await env.DB.prepare(
    'INSERT INTO attivazioni (chiave, conto, broker, prima, ultima) VALUES (?,?,?,?,?)'
  ).bind(chiave, conto, broker, adesso, adesso).run();

  return { valida: true, scadenza: lic.scadenza || 0, messaggio: 'attivata' };
}

export async function gestisciLicenza(request, env) {
  if (request.method !== 'POST') return json({ valida: false, messaggio: 'metodo' }, 405);
  const { dati, errore } = await leggiCorpo(request);
  if (errore) return json({ valida: false, messaggio: errore }, 400);

  const chiave = testo(dati.chiave, 64).trim();
  const conto = intero(dati.conto);
  const broker = testo(dati.broker, 64);
  if (!chiave || !conto) return json({ valida: false, messaggio: 'chiave o conto mancanti' }, 400);

  try {
    return json(await verificaLicenza(env, chiave, conto, broker));
  } catch (e) {
    // errore nostro: per l'expert vale "nessuna risposta", non "non valida"
    return json({ valida: false, messaggio: 'errore del server: ' + e.message }, 500);
  }
}

/* ---- telemetria ------------------------------------------------------ */
export async function gestisciGriglia(request, env) {
  if (request.method !== 'POST') return json({ ok: false }, 405);
  const { dati: d, errore } = await leggiCorpo(request);
  if (errore) return json({ ok: false, errore }, 400);

  const chiave = testo(d.chiave, 64).trim();
  const conto = intero(d.conto);
  const simbolo = testo(d.simbolo, 32);
  const magico = intero(d.magico, 0);
  if (!chiave || !conto || !simboloValido(simbolo)) return json({ ok: false }, 400);

  // Si scrive solo per chiavi note: niente righe per chiunque conosca l'URL.
  const lic = await env.DB.prepare('SELECT attiva FROM licenze WHERE chiave = ?').bind(chiave).first();
  if (!lic) return json({ ok: false, errore: 'chiave sconosciuta' }, 403);

  const ricevuto = ora();
  const evento = testo(d.evento, 32) || 'battito';
  const posizioni = intero(d.posizioni, 0);
  const lotti = num(d.lotti, 0);
  const flottante = num(d.flottante, 0);
  const fermo = testo(d.fermo, 200);

  // campi non previsti dallo schema: conservati, non persi
  const noti = new Set(['chiave','conto','simbolo','magico','evento','ts','posizioni','lotti',
    'flottante','breakEven','livelloMargine','pipChiamata','pipStopOut','swapGiorno',
    'livelliResidui','fermo','saldo','equity','margine','margineLibero','posizioniConto',
    'lottiConto','flottanteConto','swapAperto','valuta','server','leva','broker']);
  const extra = {};
  for (const k of Object.keys(d)) if (!noti.has(k)) extra[k] = d[k];

  const scritture = [
    env.DB.prepare(`
      INSERT INTO griglia_stato (chiave, conto, simbolo, magico, ts_expert, ricevuto, evento,
        posizioni, lotti, flottante, break_even, livello_margine, pip_chiamata, pip_stop_out,
        swap_giorno, livelli_residui, fermo, extra)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
      ON CONFLICT(chiave, conto, simbolo, magico) DO UPDATE SET
        ts_expert=?5, ricevuto=?6, evento=?7, posizioni=?8, lotti=?9, flottante=?10,
        break_even=?11, livello_margine=?12, pip_chiamata=?13, pip_stop_out=?14,
        swap_giorno=?15, livelli_residui=?16, fermo=?17, extra=?18
    `).bind(chiave, conto, simbolo, magico, intero(d.ts), ricevuto, evento,
      posizioni, lotti, flottante, num(d.breakEven), num(d.livelloMargine),
      num(d.pipChiamata), num(d.pipStopOut), num(d.swapGiorno), intero(d.livelliResidui),
      fermo, Object.keys(extra).length ? JSON.stringify(extra) : null)
  ];

  if (evento !== 'battito') {
    scritture.push(env.DB.prepare(`
      INSERT INTO griglia_eventi (chiave, conto, simbolo, magico, ts_expert, ricevuto, evento,
        posizioni, lotti, flottante, fermo) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).bind(chiave, conto, simbolo, magico, intero(d.ts), ricevuto, evento,
      posizioni, lotti, flottante, fermo));
  }

  // Campi del conto: facoltativi, dall'expert v1.1. Alimentano Monitor.
  if (d.equity != null || d.saldo != null) {
    const saldo = num(d.saldo), equity = num(d.equity), flottanteConto = num(d.flottanteConto),
      swapAperto = num(d.swapAperto), posConto = intero(d.posizioniConto);
    scritture.push(env.DB.prepare(`
      INSERT INTO conto_stato (chiave, conto, ricevuto, valuta, saldo, equity, margine,
        margine_libero, livello_margine, posizioni, lotti, flottante, swap_aperto, broker, server, leva)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)
      ON CONFLICT(chiave, conto) DO UPDATE SET ricevuto=?3, valuta=?4, saldo=?5, equity=?6,
        margine=?7, margine_libero=?8, livello_margine=?9, posizioni=?10, lotti=?11,
        flottante=?12, swap_aperto=?13, broker=?14, server=?15, leva=?16
    `).bind(chiave, conto, ricevuto, testo(d.valuta, 8), saldo, equity, num(d.margine),
      num(d.margineLibero), num(d.livelloMargine), posConto, num(d.lottiConto),
      flottanteConto, swapAperto, testo(d.broker, 64), testo(d.server, 64), num(d.leva)));
    scritture.push(env.DB.prepare(`
      INSERT INTO conto_giorno (chiave, conto, giorno, saldo, equity, flottante, swap_aperto, posizioni)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
      ON CONFLICT(chiave, conto, giorno) DO UPDATE SET saldo=?4, equity=?5, flottante=?6,
        swap_aperto=?7, posizioni=?8
    `).bind(chiave, conto, giornoUtc(ricevuto), saldo, equity, flottanteConto, swapAperto, posConto));
  }

  try {
    await env.DB.batch(scritture);
  } catch (e) {
    return json({ ok: false, errore: e.message }, 500);
  }
  // Risposta deliberatamente muta: nessun comando puo' tornare indietro.
  return json({ ok: true });
}

/* ---- instradamento: una riga in index.js ----------------------------- */
export async function instradaLive(request, env) {
  const p = new URL(request.url).pathname;
  if (p === '/licenza') return gestisciLicenza(request, env);
  if (p === '/griglia') return gestisciGriglia(request, env);
  return null;
}
