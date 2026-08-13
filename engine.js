'use strict';
/* engine.js — motore di calcolo del portafoglio.
 *
 * Non parla con la rete e non conosce Myfxbook: riceve conti gia' normalizzati
 * (vedi myfxbook.js) e restituisce quello che la dashboard disegna.
 *
 * Convenzioni:
 * - i rendimenti giornalieri sono in forma decimale (0.012 = +1,2%)
 * - i rendimenti sono calcolati NELLA VALUTA DEL CONTO: sono quindi
 *   neutrali al cambio (il cambio muove il valore in EUR, non la performance)
 * - gli importi in valuta sono convertiti in EUR solo per i pesi e i totali
 */

const MESI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu',
              'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

/* ---------- utilita' ---------- */

function inRange(date, from, to) {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

/** Serie cumulativa composta a partire dai rendimenti di passo. */
function compound(rets) {
  const out = [];
  let acc = 1;
  for (const r of rets) { acc *= (1 + (Number(r) || 0)); out.push(acc); }
  return out;
}

/** Unione ordinata delle date di tutti i conti, filtrata sull'intervallo. */
function unionDates(accounts, from, to) {
  const set = new Set();
  for (const a of accounts)
    for (const p of a.series)
      if (inRange(p.date, from, to)) set.add(p.date);
  return [...set].sort();
}

/** Mappa data -> punto, per accesso diretto. */
function byDate(series) {
  const m = new Map();
  for (const p of series) m.set(p.date, p);
  return m;
}

/* ---------- costruzione della curva di un conto sull'asse comune ---------- */

/**
 * Riporta un conto sull'asse delle date comune.
 * Nei giorni in cui il conto non ha rilevazioni il rendimento e' 0
 * (posizione ferma), cosi' la curva non si spezza.
 */
function curveOn(dates, account) {
  const m = byDate(account.series);
  const bal = [], eq = [], swap = [];
  for (const d of dates) {
    const p = m.get(d);
    bal.push(p ? p.balanceRet : 0);
    eq.push(p ? p.equityRet : 0);
    swap.push(p ? (p.swap || 0) : 0);
  }
  return { balance: compound(bal), equity: compound(eq), swapStep: swap };
}

/* ---------- aggregazione ---------- */

/**
 * buildHome(accounts, opts)
 *
 * Combina i conti in un unico portafoglio. Il metodo e' quello di un
 * portafoglio buy-and-hold: ogni conto entra con il capitale che aveva
 * all'INIZIO della finestra e da li' compone il proprio rendimento.
 *
 *   V(t) = somma_i [ capitaleIniziale_i(EUR) * cumulato_i(t) ]
 *   rendimento(t) = V(t) / V(0) - 1
 *
 * Il capitale iniziale si ricava a ritroso dall'equity attuale:
 *   iniziale_i = attuale_i / cumulato_i(fine)
 *
 * opts: { from, to, rates } — rates: { CHF: 0.94, USD: 1.08, ... } (1 EUR = x valuta)
 */
function buildHome(accounts, opts = {}) {
  const { from, to, rates = {} } = opts;
  const toEur = (v, cur) => {
    if (!cur || cur === 'EUR') return Number(v) || 0;
    const r = Number(rates[cur]);
    return r > 0 ? (Number(v) || 0) / r : (Number(v) || 0);
  };

  const dates = unionDates(accounts, from, to);
  if (!dates.length) {
    return {
      labels: [], balancePct: [], equityPct: [], swapPct: [],
      gainPct: 0, equityGainPct: 0, swapPct_finale: 0, swapEur: 0,
      capitaleEur: 0, maxDrawdownPct: 0, monthly: [], accounts: [],
      from: from || null, to: to || null, vuoto: true
    };
  }

  const parts = accounts.map(a => {
    const c = curveOn(dates, a);
    const finale = c.balance[c.balance.length - 1] || 1;
    const finaleEq = c.equity[c.equity.length - 1] || 1;
    const attualeEur = toEur(a.equity != null ? a.equity : a.balance, a.currency);
    // capitale a inizio finestra, dedotto a ritroso dal cumulato
    const inizialeEur = finale > 0.0001 ? attualeEur / finale : attualeEur;
    return { a, c, inizialeEur, finale, finaleEq };
  });

  const V0 = parts.reduce((s, p) => s + p.inizialeEur, 0) || 1;

  const balancePct = [], equityPct = [], swapPct = [];
  let swapCum = 0;
  for (let i = 0; i < dates.length; i++) {
    let vb = 0, ve = 0, sw = 0;
    for (const p of parts) {
      vb += p.inizialeEur * p.c.balance[i];
      ve += p.inizialeEur * p.c.equity[i];
      sw += toEur(p.c.swapStep[i], p.a.currency);
    }
    swapCum += sw;
    balancePct.push((vb / V0 - 1) * 100);
    equityPct.push((ve / V0 - 1) * 100);
    swapPct.push((swapCum / V0) * 100);
  }

  /* Drawdown: sulla curva equity combinata.
   * Con un conto solo si usa il dato dichiarato da Myfxbook, che tiene conto
   * anche dell'intraday che la serie giornaliera non vede. */
  let maxDrawdownPct;
  if (accounts.length === 1 && Number.isFinite(Number(accounts[0].drawdownPct))
      && !from && !to) {
    maxDrawdownPct = Number(accounts[0].drawdownPct);
  } else {
    let picco = -Infinity, dd = 0;
    for (const v of equityPct) {
      const val = 1 + v / 100;
      if (val > picco) picco = val;
      if (picco > 0) dd = Math.max(dd, (picco - val) / picco * 100);
    }
    maxDrawdownPct = dd;
  }

  /* Attribuzione mensile: guadagno in EUR di ogni conto, mese per mese. */
  const mesi = [];
  const indexOfMonth = new Map();
  dates.forEach((d, i) => {
    const k = d.slice(0, 7);
    if (!indexOfMonth.has(k)) indexOfMonth.set(k, { first: i, last: i });
    else indexOfMonth.get(k).last = i;
  });
  for (const [k, { first, last }] of indexOfMonth) {
    const riga = { mese: k, etichetta: etichettaMese(k), conti: {}, totale: 0 };
    for (const p of parts) {
      const prima = first > 0 ? p.c.balance[first - 1] : p.c.balance[first];
      const dopo = p.c.balance[last];
      const g = p.inizialeEur * (dopo - prima);
      riga.conti[p.a.name] = round2(g);
      riga.totale += g;
    }
    riga.totale = round2(riga.totale);
    mesi.push(riga);
  }

  const capitaleEur = parts.reduce(
    (s, p) => s + toEur(p.a.equity != null ? p.a.equity : p.a.balance, p.a.currency), 0);

  return {
    labels: dates,
    balancePct: balancePct.map(round2),
    equityPct: equityPct.map(round2),
    swapPct: swapPct.map(round2),
    gainPct: round2(balancePct[balancePct.length - 1]),
    equityGainPct: round2(equityPct[equityPct.length - 1]),
    swapPctFinale: round2(swapPct[swapPct.length - 1]),
    swapEur: round2(swapCum),
    capitaleEur: round2(capitaleEur),
    maxDrawdownPct: round2(maxDrawdownPct),
    monthly: mesi,
    accounts: parts.map(p => ({
      id: p.a.id,
      name: p.a.name,
      currency: p.a.currency,
      balance: round2(p.a.balance),
      equity: round2(p.a.equity != null ? p.a.equity : p.a.balance),
      equityEur: round2(toEur(p.a.equity != null ? p.a.equity : p.a.balance, p.a.currency)),
      quota: round2(toEur(p.a.equity != null ? p.a.equity : p.a.balance, p.a.currency)
              / (capitaleEur || 1) * 100),
      gainPct: round2((p.finale - 1) * 100),
      gainTotalePct: round2(Number(p.a.gainPct) || 0),
      drawdownPct: round2(Number(p.a.drawdownPct) || 0)
    })),
    from: dates[0], to: dates[dates.length - 1], vuoto: false
  };
}

/** Dettaglio di un singolo conto: stessa logica, un conto solo. */
function buildAccount(account, opts = {}) {
  const h = buildHome([account], opts);
  const m = byDate(account.series);
  const swapSerie = h.labels.map(d => (m.get(d) ? m.get(d).swap || 0 : 0));
  let cum = 0;
  const swapCumulato = swapSerie.map(v => (cum += v, round2(cum)));
  return Object.assign(h, {
    account: {
      id: account.id, name: account.name, currency: account.currency,
      balance: round2(account.balance),
      equity: round2(account.equity != null ? account.equity : account.balance),
      gainPct: round2(Number(account.gainPct) || 0),
      drawdownPct: round2(Number(account.drawdownPct) || 0)
    },
    swapValuta: swapCumulato,
    swapTotaleValuta: swapCumulato.length ? swapCumulato[swapCumulato.length - 1] : 0
  });
}

/* ---------- formattazione ---------- */

function etichettaMese(k) {
  const [y, m] = k.split('-');
  return `${MESI[Number(m) - 1]} ${String(y).slice(2)}`;
}
function round2(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

module.exports = { buildHome, buildAccount, compound, unionDates, round2 };

/* Prova rapida:  node engine.js  */
if (require.main === module) {
  const serie = (base, n) => Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
    balanceRet: base + Math.sin(i / 3) / 500,
    equityRet: base + Math.sin(i / 2) / 300,
    swap: 12
  }));
  const conti = [
    { id: '1', name: 'Conto EUR', currency: 'EUR', balance: 32000, equity: 31000,
      gainPct: 103, drawdownPct: 49.17, series: serie(0.0015, 60) },
    { id: '2', name: 'Conto CHF', currency: 'CHF', balance: 24000, equity: 23000,
      gainPct: 57, drawdownPct: 41.0, series: serie(0.0011, 60) }
  ];
  const h = buildHome(conti, { rates: { CHF: 0.94 } });
  console.log('punti          :', h.labels.length);
  console.log('rendimento     :', h.gainPct + '%');
  console.log('equity         :', h.equityGainPct + '%');
  console.log('incidenza swap :', h.swapPctFinale + '%');
  console.log('capitale EUR   :', h.capitaleEur);
  console.log('drawdown       :', h.maxDrawdownPct + '%');
  console.log('mesi           :', h.monthly.map(m => m.etichetta + ' ' + m.totale).join(' | '));
  console.log('quote          :', h.accounts.map(a => a.name + ' ' + a.quota + '%').join(' | '));
}
