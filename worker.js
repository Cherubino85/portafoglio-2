/* worker.js — punto di ingresso su Cloudflare Workers.
 *
 * Come si dividono i compiti:
 * - i file statici in sito/ vengono serviti direttamente da Cloudflare, senza
 *   passare da qui: sono gratuiti e illimitati anche sul piano libero
 * - questo Worker si attiva solo quando nessun file corrisponde, cioe' per
 *   /api/*, che e' l'unica cosa che consuma richieste
 *
 * Le credenziali Myfxbook arrivano da env, non dal codice: si impostano nel
 * pannello Cloudflare come Secret e non compaiono mai nel repository.
 */
import * as dati from './data.js';

const risposta = (codice, corpo) => new Response(JSON.stringify(corpo), {
  status: codice,
  headers: { 'content-type': 'application/json; charset=utf-8',
             'cache-control': 'no-store' }
});

/* Il risultato gia' calcolato si tiene da parte: il limite del piano libero
   e' sul tempo di CPU, non sull'attesa della rete, quindi ricalcolare a ogni
   apertura e' lo spreco piu' costoso che si possa fare. */
const CACHE_ESITO = new Map();
const TTL_ESITO = 60e3;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      // rete di sicurezza: se il file non esiste, lo dice il servizio statico
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Non trovato', { status: 404 });
    }

    dati.impostaAmbiente(env);
    const q = Object.fromEntries(url.searchParams);

    try {
      if (q.diagnostica === '1') return risposta(200, await dati.diagnostica());
      if (q.campi === '1') return risposta(200, await dati.campi());

      const chiave = url.pathname + '?' + url.search;
      const salvato = CACHE_ESITO.get(chiave);
      if (!q.force && salvato && Date.now() - salvato.t < TTL_ESITO)
        return risposta(200, salvato.v);

      const opzioni = { from: q.from, to: q.to, force: q.force === '1' };
      const out = q.id ? await dati.account(q.id, opzioni) : await dati.home(opzioni);
      CACHE_ESITO.set(chiave, { t: Date.now(), v: out });
      if (CACHE_ESITO.size > 40) CACHE_ESITO.delete(CACHE_ESITO.keys().next().value);
      return risposta(200, out);
    } catch (e) {
      return risposta(e.status || 500, { errore: e.message });
    }
  }
};
