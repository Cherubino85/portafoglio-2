'use strict';
/* funzioni/api.js — un solo endpoint per entrambe le richieste.
 *
 * E' un file solo di proposito: sul web di GitHub le cartelle si creano
 * scrivendone il nome, e un file solo significa una cartella sola da creare.
 *
 * Distinzione fra le due richieste: la home non manda "id", il dettaglio si.
 * Non ci si appoggia al percorso, che dopo un rewrite di Netlify puo' arrivare
 * riscritto e cambiare senza preavviso.
 */
const dati = require('../data');

const risposta = (codice, corpo) => ({
  statusCode: codice,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  body: JSON.stringify(corpo)
});

exports.handler = async (event) => {
  const q = (event && event.queryStringParameters) || {};
  const opzioni = { from: q.from, to: q.to, force: q.force === '1' };
  try {
    const out = q.id ? await dati.account(q.id, opzioni) : await dati.home(opzioni);
    return risposta(200, out);
  } catch (e) {
    return risposta(e.status || 500, { errore: e.message });
  }
};
