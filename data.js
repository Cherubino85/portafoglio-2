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
  const giorni = 420;
  const serie = (semi, drift, ampiezza, swapDie) => {
    let s = semi, bal = 1;
    const out = [];
    for (let i = 0; i < giorni; i++) {
      s = (s * 1103515245 + 12345) % 2147483648;
      const u = s / 2147483648;
      const d = new Date(Date.UTC(2025, 5, 1 + i));
      if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
      // il balance sale in modo regolare: la griglia incassa i take profit
      const balanceRet = drift * (0.6 + u * 0.8);
      bal *= (1 + balanceRet);
      // il flottante e' quasi sempre negativo e in certe fasi molto profondo:
      // e' li' che l'equity si stacca dal balance ed emerge il drawdown
      const fase = Math.sin(i / 61) + 0.35 * Math.sin(i / 17);
      const flottante = -Math.max(0, fase) * ampiezza * 22 * (0.75 + u * 0.5);
      const ge = (bal * (1 + flottante) - 1) * 100;   // come growthEquity
      out.push({
        date: d.toISOString().slice(0, 10),
        balanceRet,
        equityRet: 0,
        _ge: ge,
        swap: swapDie * (0.8 + u * 0.4)
      });
    }
    // equityRet dal cumulato, come fa myfxbook.js con growthEquity
    let prev = null;
    for (const p of out) {
      if (prev != null) {
        const den = 1 + prev / 100;
        p.equityRet = den > 0.0001 ? (1 + p._ge / 100) / den - 1 : 0;
      }
      prev = p._ge;
      delete p._ge;
    }
    return out;
  };
  return [
    { id: '1', name: 'Protocollo MADRE (EUR/USD)', currency: 'EUR',
      balance: 32180, equity: 31740, gainPct: 103.4, drawdownPct: 49.17,
      series: serie(7, 0.0011, 0.010, 3.8) },
    { id: '2', name: 'Protocollo CHF (GBP/CHF)', currency: 'CHF',
      balance: 23050, equity: 22610, gainPct: 57.2, drawdownPct: 41.3,
      series: serie(13, 0.0009, 0.012, 12.9) }
  ];
}

module.exports = { home, account, conti, dimostrativi, credenziali, diagnostica };
