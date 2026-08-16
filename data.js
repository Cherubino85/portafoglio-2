'use strict';
/* data.js — decide da dove arrivano i dati.
 *
 * Con le credenziali Myfxbook nelle variabili d'ambiente usa i conti veri.
 * Senza credenziali parte con dati dimostrativi, cosi' l'app e' verificabile
 * prima di collegare qualsiasi cosa.
 */

const mfx = require('./myfxbook');
const { buildHome, buildAccount } = require('./engine');

const TTL = 5 * 60e3;               // 5 minuti: evita di ripetere il login a ogni ricarica
let cache = { t: 0, conti: null };

function credenziali() {
  const email = process.env.MYFXBOOK_EMAIL;
  const password = process.env.MYFXBOOK_PASSWORD;
  return (email && password) ? { email, password } : null;
}

async function conti(force = false) {
  if (!force && cache.conti && Date.now() - cache.t < TTL) return cache.conti;
  const cred = credenziali();
  const lista = cred ? await mfx.raccogli(cred) : dimostrativi();
  cache = { t: Date.now(), conti: lista };
  return lista;
}

async function home({ from, to, force } = {}) {
  const [lista, rates] = await Promise.all([conti(force), mfx.cambi()]);
  const out = buildHome(lista, { from, to, rates });
  out.demo = !credenziali();
  out.aggiornato = new Date().toISOString();
  return out;
}

/** Riferisce a che punto si rompe il collegamento a Myfxbook. */
async function diagnostica() {
  const cred = credenziali();
  if (!cred) return { passi: [{ passo: 'credenziali', esito: 'assenti',
    messaggio: 'MYFXBOOK_EMAIL e MYFXBOOK_PASSWORD non sono nelle variabili d\'ambiente' }] };
  const out = await mfx.verifica(cred.email, cred.password);
  out.momento = new Date().toISOString();
  return out;
}

/** Elenca i campi restituiti da Myfxbook. */
async function campi() {
  const cred = credenziali();
  if (!cred) return { errore: 'credenziali assenti' };
  return await mfx.campi(cred.email, cred.password);
}

async function account(id, { from, to, force } = {}) {
  const [lista, rates] = await Promise.all([conti(force), mfx.cambi()]);
  const c = lista.find(x => String(x.id) === String(id));
  if (!c) { const e = new Error('Conto non trovato'); e.status = 404; throw e; }
  const out = buildAccount(c, { from, to, rates });
  out.demo = !credenziali();
  out.aggiornato = new Date().toISOString();
  return out;
}

/* ---------- dati dimostrativi ---------- */
/* Due conti con l'andamento tipico di una griglia swap-positiva: salita
 * regolare interrotta da fasi di escursione avversa. Servono solo a far
 * vedere l'app funzionante prima delle credenziali. */
function dimostrativi() {
  /* Conti finti ma coerenti: saldo che cresce, due versamenti, un prelievo, e
     flottante che cambia nel tempo — cosi' la curva equity si stacca da quella
     del saldo come succede davvero su una griglia. */
  const genera = (semi, drift, swapDie, iniziale, movimenti, flottante) => {
    let s = semi, bal = iniziale, cum = 1;
    const out = [];
    for (let i = 0; i < 620; i++) {
      s = (s * 1103515245 + 12345) % 2147483648;
      const u = s / 2147483648;
      const d = new Date(Date.UTC(2024, 6, 1 + i));
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      const giorno = d.toISOString().slice(0, 10);

      const r = drift * (0.4 + u * 1.2);
      const profit = bal * r;
      bal += profit;
      if (movimenti[giorno]) bal += movimenti[giorno];   // versamento o prelievo
      cum *= (1 + r);

      const gb = (cum - 1) * 100;                        // crescita del saldo
      const rap = flottante(i / 620, u);                 // equity / saldo
      out.push({ date: giorno, balance: bal, balanceRet: r, profit,
                 swap: swapDie * (0.8 + u * 0.4),
                 ge: (1 + gb / 100) * rap * 100 - 100, gb });
    }
    return out;
  };

  const serieEur = genera(7, 0.0011, 3.8, 12000,
    { '2024-11-04': 8000, '2025-05-05': 6000, '2026-02-02': -10000 },
    (t, u) => 1 - 0.22 * Math.max(0, Math.sin(t * 5.5)) - 0.03 * u);
  const serieChf = genera(13, 0.0009, 12.9, 9000,
    { '2025-01-06': 6000 },
    (t, u) => 0.94 + 0.16 * Math.max(0, Math.sin(t * 4 + 1)) + 0.02 * u);

  const chiudi = (id, nome, valuta, serie, versati, prelevati) => {
    const u = serie[serie.length - 1];
    const rapporto = (1 + u.ge / 100) / (1 + u.gb / 100);
    const swap = serie.reduce((t, p) => t + p.swap, 0);
    const profitto = serie.reduce((t, p) => t + p.profit, 0);
    const flottante = u.balance * rapporto - u.balance;
    return { id, name: nome, currency: valuta,
      balance: u.balance, equity: u.balance * rapporto,
      flottante,
      swapAperto: valuta === 'EUR' ? Math.abs(flottante) * 0.18 : null,
      quanteAperte: valuta === 'EUR' ? 14 : 9,
      gainPct: u.gb, absGainPct: u.gb * 0.68,
      equityPct: rapporto * 100,
      drawdownPct: valuta === 'EUR' ? 49.17 : 40.39,
      profit: profitto, interest: swap,
      deposits: versati, withdrawals: prelevati,
      primaOperazione: serie[0].date, series: serie };
  };

  return [
    chiudi('1', 'Conto dimostrativo EUR', 'EUR', serieEur, 26000, 10000),
    chiudi('2', 'Conto dimostrativo CHF', 'CHF', serieChf, 15000, 0)
  ];
}

module.exports = { home, account, conti, dimostrativi, credenziali, diagnostica, campi };
