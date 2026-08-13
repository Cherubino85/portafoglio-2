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
 * La sessione Myfxbook e' legata all'IP: si fa login a ogni richiesta e la si
 * usa subito, quindi l'IP variabile del serverless non e' un problema.
 */

const BASE = 'https://www.myfxbook.com/api';

async function chiama(path, params = {}) {
  const url = new URL(`${BASE}/${path}.json`);
  for (const [k, v] of Object.entries(params))
    if (v != null && v !== '') url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`Myfxbook ${path}: HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`Myfxbook ${path}: ${j.message || 'errore'}`);
  return j;
}

async function login(email, password) {
  const j = await chiama('login', { email, password });
  if (!j.session) throw new Error('Myfxbook: login senza sessione');
  return j.session;
}
const logout = (session) => chiama('logout', { session }).catch(() => {});
const listaConti = (session) => chiama('get-my-accounts', { session }).then(j => j.accounts || []);
const serieGiornaliera = (session, id, start, end) =>
  chiama('get-data-daily', { session, id, start, end }).then(j => j.dataDaily || []);
const storico = (session, id) =>
  chiama('get-history', { session, id }).then(j => j.history || []);

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
function normalize(conto, dataDaily, history, idx = 0) {
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
  let prevBal = null, prevGe = null;
  for (const r of rows) {
    const date = r._iso;
    const bal = Number(r.balance) || 0;
    const profit = Number(r.profit) || 0;

    const balanceRet = (prevBal && prevBal !== 0) ? profit / prevBal : 0;

    // growthEquity e' una percentuale CUMULATA: il rendimento del passo e'
    // il rapporto fra due cumulate, non la loro differenza.
    const ge = Number(r.growthEquity);
    let equityRet = 0;
    if (prevGe != null && Number.isFinite(ge)) {
      const denom = 1 + prevGe / 100;
      if (denom > 0.0001) equityRet = (1 + ge / 100) / denom - 1;
    }

    series.push({ date, balanceRet, equityRet, swap: swapPerGiorno[date] || 0 });
    prevBal = bal;
    if (Number.isFinite(ge)) prevGe = ge;
  }

  return {
    id: String(conto.id != null ? conto.id : idx + 1),
    name: conto.name || `Conto ${idx + 1}`,
    currency: conto.currency || 'EUR',
    balance: Number(conto.balance) || 0,
    equity: Number(conto.equity) || Number(conto.balance) || 0,
    gainPct: Number(conto.gain) || 0,
    drawdownPct: Number(conto.drawdown) || 0,
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

/** Scarica tutto il necessario e restituisce i conti gia' normalizzati. */
async function raccogli({ email, password, start, end }) {
  const session = await login(email, password);
  try {
    const conti = await listaConti(session);
    const out = [];
    for (let i = 0; i < conti.length; i++) {
      const c = conti[i];
      const [daily, hist] = await Promise.all([
        serieGiornaliera(session, c.id, start, end).catch(() => []),
        storico(session, c.id).catch(() => [])
      ]);
      out.push(normalize(c, daily, hist, i));
    }
    return out;
  } finally { await logout(session); }
}

module.exports = {
  login, logout, listaConti, serieGiornaliera, storico,
  normalize, appiattisci, toIso, cambi, raccogli
};
