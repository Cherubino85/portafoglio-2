'use strict';
/* myfxbook.js — client dell'API Myfxbook e normalizzazione dei dati.
 *
 * Due punti che sono costati tempo e che qui restano risolti:
 *
 * 1. get-data-daily restituisce un ARRAY DI ARRAY: ogni giorno e' un array
 *    che contiene un oggetto. Va appiattito prima di leggerlo.
 * 2. floatingPL nell'API e' quasi sempre 0 e non e' affidabile: l'equity NON
 *    va ricostruita come balance + floatingPL. Myfxbook espone gia' la propria
 *    curva equity nel campo growthEquity (percentuale cumulata). Si usa quello.
 *
 * 3. La sessione Myfxbook e' fragile. Myfxbook invalida le sessioni precedenti
 *    quando lo stesso account rifa' il login, e non gradisce l'uso in
 *    parallelo della stessa sessione. Percio' qui: la sessione si tiene e si
 *    riusa, le richieste sono SEQUENZIALI, a ogni "Invalid session" si rifa'
 *    il login UNA volta e si riprova, e non si fa mai logout — chiuderebbe
 *    una sessione che un'altra chiamata potrebbe star usando.
 */

const BASE = 'https://www.myfxbook.com/api';

async function chiama(path, params = {}) {
  const { session, ...resto } = params;
  const url = new URL(`${BASE}/${path}.json`);
  for (const [k, v] of Object.entries(resto))
    if (v != null && v !== '') url.searchParams.set(k, v);

  /* La sessione va attaccata GREZZA, senza codifica, e per ultima.
     Myfxbook non decodifica questo parametro: confronta la stringa come
     arriva. Codificarla (il '+' che diventa '%2B', per esempio) produce
     "Invalid session" istantaneo, con il login appena riuscito. */
  let indirizzo = url.toString();
  if (session) indirizzo += (indirizzo.includes('?') ? '&' : '?') + 'session=' + session;

  const r = await fetch(indirizzo, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`Myfxbook ${path}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`Myfxbook ${path}: ${j.message || 'errore'}`);
  return j;
}

async function login(email, password) {
  const j = await chiama('login', { email, password });
  if (!j.session) throw new Error('Myfxbook: login riuscito ma senza sessione');
  return j.session;
}
const listaConti = (session) => chiama('get-my-accounts', { session }).then(j => j.accounts || []);
const serieGiornaliera = (session, id, start, end) =>
  chiama('get-data-daily', { session, id, start, end }).then(j => j.dataDaily || []);
const storico = (session, id) =>
  chiama('get-history', { session, id }).then(j => j.history || []);
/* Posizioni ancora aperte: e' l'unico posto dove sta lo swap gia' maturato ma
   non ancora incassato. Lo storico contiene solo le operazioni chiuse. */
const aperte = (session, id) =>
  chiama('get-open-trades', { session, id }).then(j => j.openTrades || []);

/* ---------- gestione della sessione ---------- */

const DURATA_SESSIONE = 25 * 60e3;    // sotto la scadenza dichiarata da Myfxbook
let sessione = { valore: null, t: 0 };
const sessioneScaduta = (e) => /invalid session|session.*not.*valid/i.test((e && e.message) || '');

async function prendiSessione(email, password, forza) {
  if (!forza && sessione.valore && Date.now() - sessione.t < DURATA_SESSIONE)
    return sessione.valore;
  const s = await login(email, password);
  sessione = { valore: s, t: Date.now() };
  return s;
}

/** Esegue una chiamata; se la sessione risulta caduta, rifa' il login e riprova. */
async function conSessione(email, password, azione) {
  try {
    return await azione(await prendiSessione(email, password));
  } catch (e) {
    if (!sessioneScaduta(e)) throw e;
    sessione = { valore: null, t: 0 };
    return await azione(await prendiSessione(email, password, true));
  }
}

/* ---------- normalizzazione ---------- */

/** Appiattisce l'array di array di get-data-daily in una lista di oggetti. */
function appiattisci(dataDaily) {
  const out = [];
  for (const voce of dataDaily || []) {
    if (Array.isArray(voce)) { for (const r of voce) if (r) out.push(r); }
    else if (voce) out.push(voce);
  }
  return out;
}

/** Converte le date di Myfxbook (MM/DD/YYYY [HH:mm]) in ISO yyyy-mm-dd. */
function toIso(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/**
 * normalize(conto, dataDaily, history, idx) -> conto normalizzato per engine.js
 *
 * - balanceRet: rendimento del passo ricavato dal profit (esclude
 *   versamenti e prelievi, che muovono il balance ma non la performance)
 * - equityRet : ricavato dal rapporto tra due valori cumulati di growthEquity
 * - swap      : somma del campo "interest" delle operazioni chiuse quel giorno
 */
function normalize(conto, dataDaily, history, idx = 0, posizioniAperte = null) {
  const rows = appiattisci(dataDaily)
    .map(r => Object.assign({}, r, { _iso: toIso(r.date) }))
    .filter(r => r._iso)
    .sort((a, b) => a._iso < b._iso ? -1 : 1);

  const swapPerGiorno = {};
  for (const op of history || []) {
    const d = toIso(op.closeTime || op.openTime);
    if (!d) continue;
    const i = Number(op.interest);
    if (Number.isFinite(i) && i !== 0) swapPerGiorno[d] = (swapPerGiorno[d] || 0) + i;
  }

  const series = [];
  let prevBal = null;
  for (const r of rows) {
    const bal = Number(r.balance) || 0;
    const profit = Number(r.profit) || 0;

    /* Crescita cumulata dichiarata da Myfxbook. Il nome del campo del saldo
       non e' garantito, quindi si prova quello che c'e'; se non c'e' resta
       null e la curva viene composta dai rendimenti giornalieri. */
    const num = (...nomi) => {
      for (const k of nomi) { const v = Number(r[k]); if (Number.isFinite(v)) return v; }
      return null;
    };

    series.push({
      date: r._iso,
      balance: bal,
      // rendimento del giorno al netto di versamenti e prelievi: il profit
      // li esclude gia', il balance no
      balanceRet: (prevBal && prevBal !== 0) ? profit / prevBal : 0,
      profit,
      swap: swapPerGiorno[r._iso] || 0,
      ge: num('growthEquity'),
      gb: num('growthBalance', 'growth', 'growthBalanceEquity')
    });
    prevBal = bal;
  }

  const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

  /* Swap maturato sulle posizioni ancora aperte. Se l'endpoint non risponde
     resta null e l'interfaccia scrive "non disponibile" invece di uno zero
     che sembrerebbe un dato. */
  let swapAperto = null, quanteAperte = null;
  if (Array.isArray(posizioniAperte)) {
    quanteAperte = posizioniAperte.length;
    swapAperto = posizioniAperte.reduce((t, o) => t + (Number(o.interest) || 0), 0);
  }

  return {
    id: String(conto.id != null ? conto.id : idx + 1),
    name: conto.name || `Conto ${idx + 1}`,
    currency: conto.currency || 'EUR',
    balance: n(conto.balance),
    equity: n(conto.equity) || n(conto.balance),
    gainPct: n(conto.gain),
    drawdownPct: n(conto.drawdown),
    /* Statistiche dichiarate da Myfxbook. Si passano cosi' come sono: sono la
       fonte, e ricalcolarle per conto proprio e' esattamente il modo di
       ritrovarsi numeri che non coincidono con quelli del loro sito. */
    absGainPct: n(conto.absGain),
    equityPct: n(conto.equityPercent),
    profit: n(conto.profit),
    interest: n(conto.interest),
    deposits: n(conto.deposits),
    withdrawals: n(conto.withdrawals),
    dailyPct: n(conto.daily),
    monthlyPct: n(conto.monthly),
    /* Il flottante si prende dalla differenza dichiarata da Myfxbook, non
       dalla somma delle posizioni: e' la loro cifra, ed e' quella che si vede
       sul loro sito. */
    flottante: n(conto.equity) - n(conto.balance),
    swapAperto,
    quanteAperte,
    primaOperazione: toIso(conto.firstTradeDate),
    aggiornatoIl: toIso(conto.lastUpdateDate),
    series
  };
}

/* ---------- cambi BCE, per convertire i conti in EUR ---------- */

let cacheCambi = { t: 0, v: null };
const CAMBI_FALLBACK = { CHF: 0.94, USD: 1.08, GBP: 0.84, CAD: 1.47, AUD: 1.63, JPY: 168 };

/** 1 EUR = x valuta. Cache di 6 ore; se la rete non risponde, ultimi noti. */
async function cambi() {
  if (cacheCambi.v && Date.now() - cacheCambi.t < 6 * 3600e3) return cacheCambi.v;
  try {
    const r = await fetch('https://api.frankfurter.app/latest?from=EUR');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if (j && j.rates) {
      cacheCambi = { t: Date.now(), v: j.rates };
      return j.rates;
    }
  } catch (_) { /* si prosegue con i valori di ripiego */ }
  return cacheCambi.v || CAMBI_FALLBACK;
}

/* ---------- raccolta completa ---------- */

/**
 * Scarica tutto, una richiesta alla volta.
 *
 * get-data-daily PRETENDE start ed end in formato yyyy-mm-dd: senza intervallo
 * non restituisce nulla. Si parte dalla prima operazione del conto, non da una
 * data inventata, cosi' non si perdono rilevazioni ne' si chiedono anni vuoti.
 *
 * Se la serie giornaliera non arriva, l'errore NON viene nascosto: senza quella
 * non c'e' niente da mostrare, e un grafico vuoto senza spiegazione fa perdere
 * piu' tempo di un messaggio chiaro. Lo storico operazioni invece serve solo
 * allo swap: se manca, si prosegue senza.
 */
async function raccogli({ email, password, start, end }) {
  const conti = await conSessione(email, password, s => listaConti(s));
  const oggi = new Date().toISOString().slice(0, 10);
  const out = [];
  for (let i = 0; i < conti.length; i++) {
    const c = conti[i];
    const da = start || toIso(c.firstTradeDate) || '2010-01-01';
    const a = end || oggi;

    const daily = await conSessione(email, password, s => serieGiornaliera(s, c.id, da, a));
    if (!appiattisci(daily).length)
      throw new Error(`Myfxbook non ha restituito rilevazioni per "${c.name}" ` +
        `nell'intervallo ${da} - ${a}`);

    const hist = await conSessione(email, password, s => storico(s, c.id)).catch(() => []);
    const ap = await conSessione(email, password, s => aperte(s, c.id)).catch(() => null);
    out.push(normalize(c, daily, hist, i, ap));
  }
  return out;
}

/** Prova i passi uno per uno e riferisce dove si rompe. */
async function verifica(email, password) {
  const passi = [];
  let s;
  try {
    s = await login(email, password);
    passi.push({ passo: 'login', esito: 'ok', lunghezzaSessione: String(s).length });
  } catch (e) {
    passi.push({ passo: 'login', esito: 'errore', messaggio: e.message });
    return { passi, momento: new Date().toISOString() };
  }
  try {
    const conti = await listaConti(s);
    passi.push({ passo: 'get-my-accounts', esito: 'ok', quanti: conti.length,
      conti: conti.map(c => ({ id: c.id, nome: c.name, valuta: c.currency,
        saldo: c.balance, guadagno: c.gain, drawdown: c.drawdown })) });
    if (conti[0]) {
      const da = toIso(conti[0].firstTradeDate) || '2010-01-01';
      const a = new Date().toISOString().slice(0, 10);
      const d = appiattisci(await serieGiornaliera(s, conti[0].id, da, a));
      passi.push({ passo: 'get-data-daily', esito: 'ok', intervallo: da + ' - ' + a, righe: d.length,
        prima: d[0] && d[0].date, ultima: d[d.length - 1] && d[d.length - 1].date });
      const h = await storico(s, conti[0].id);
      passi.push({ passo: 'get-history', esito: 'ok', operazioni: (h || []).length });
    }
  } catch (e) {
    passi.push({ passo: 'lettura dati', esito: 'errore', messaggio: e.message });
  }
  return { passi, momento: new Date().toISOString() };
}

/** Elenca i campi che Myfxbook restituisce davvero, per non doverli indovinare. */
async function campi(email, password) {
  const s = await login(email, password);
  const conti = await listaConti(s);
  if (!conti.length) return { errore: 'nessun conto' };
  const c = conti[0];
  const da = toIso(c.firstTradeDate) || '2010-01-01';
  const a = new Date().toISOString().slice(0, 10);
  const righe = appiattisci(await serieGiornaliera(s, c.id, da, a));
  const storia = await storico(s, c.id).catch(() => []);
  return {
    campiDelConto: Object.keys(c),
    campiGiornalieri: righe[0] ? Object.keys(righe[0]) : [],
    esempioGiornaliero: righe[Math.floor(righe.length / 2)] || null,
    campiOperazione: storia[0] ? Object.keys(storia[0]) : [],
    campiPosizioneAperta: (await aperte(s, c.id).catch(() => []))[0]
      ? Object.keys((await aperte(s, c.id))[0]) : [],
    quanteRighe: righe.length,
    quanteOperazioni: storia.length
  };
}

module.exports = {
  login, listaConti, serieGiornaliera, storico, aperte,
  normalize, appiattisci, toIso, cambi, raccogli, verifica, campi, conSessione
};
