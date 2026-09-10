/* =====================================================================
   auth.js — accesso alla Console: utenti, password, sessioni,
   autorizzazioni per sezione, amministrazione.
   Versione 1, 10/09/2026.

   Scelte (su delega, 08-10/09):
   * password: HMAC-SHA256(PEPPER, password) -> PBKDF2-SHA256 100.000
     iterazioni (tetto del runtime Workers) con sale casuale per utente.
     Il pepper e' il segreto PEPPER del Worker: senza, il database da
     solo non basta ad attaccare le password. Formato conservato:
     pbkdf2-sha256$<iterazioni>$<sale hex>$<hash hex>  — il fattore di
     lavoro viaggia col dato, cosi' si alza senza rompere nulla.
   * sessioni: token casuale di 32 byte nel cookie `sessione`
     (HttpOnly, Secure, SameSite=Strict); in D1 sta solo lo SHA-256.
     Durata 30 giorni, rinnovata se resta meno di una settimana.
   * token monouso (impostazione password, invito): stesso principio,
     in D1 solo l'hash; scadenza 48 ore per l'invito, 1 ora per il
     recupero.
   * accessi falliti: dopo 10 tentativi sbagliati sulla stessa mail,
     15 minuti di blocco.
   * richieste che cambiano stato: se c'e' l'intestazione Origin deve
     coincidere con l'host del Worker.
   * amministrazione: Authorization: Bearer <ADMIN_TOKEN> (segreto del
     Worker). Crea utenti e licenze, restituisce il link di invito. La
     consegna del link (mail) e' fuori da qui: fase 4.

   Sezioni: rischio | carry | backtest | proiezione | ealive | monitor
            | record.  Il ruolo `autore` vede tutto; `rischio` e `carry`
            sono libere anche senza account (decisione 08/09).
   ===================================================================== */

const ITERAZIONI = 100000;
const DURATA_SESSIONE = 30 * 86400;
const RINNOVO_SESSIONE = 7 * 86400;
const DURATA_INVITO = 48 * 3600;
const DURATA_RECUPERO = 3600;
const MAX_FALLITI = 10;
const BLOCCO_SECONDI = 15 * 60;
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 128;
const SEZIONI = new Set(['rischio', 'carry', 'backtest', 'proiezione', 'ealive', 'monitor', 'record']);
const SEZIONI_LIBERE = new Set(['rischio', 'carry']);
const FRESCO_SECONDI = 1800;

const enc = new TextEncoder();
const ora = () => Math.floor(Date.now() / 1000);
const hex = (buf) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
const unhex = (s) => new Uint8Array(s.match(/../g).map(h => parseInt(h, 16)));
const tokenCasuale = () => hex(crypto.getRandomValues(new Uint8Array(32)));
const sha256 = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

const json = (obj, status = 200, extra = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }
  });

/* ---- password ---------------------------------------------------------- */
async function conPepper(env, password) {
  if (!env.PEPPER || env.PEPPER.length < 16) throw new Error('segreto PEPPER mancante o troppo corto');
  const k = await crypto.subtle.importKey('raw', enc.encode(env.PEPPER), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(password));
}

async function derivaHash(materiale, sale, iterazioni) {
  const k = await crypto.subtle.importKey('raw', materiale, { name: 'PBKDF2' }, false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: sale, iterations: iterazioni, hash: 'SHA-256' }, k, 256);
  return hex(bits);
}

export async function hashPassword(env, password) {
  const sale = crypto.getRandomValues(new Uint8Array(16));
  const h = await derivaHash(await conPepper(env, password), sale, ITERAZIONI);
  return `pbkdf2-sha256$${ITERAZIONI}$${hex(sale)}$${h}`;
}

export async function verificaPassword(env, password, conservato) {
  if (!conservato) return false;
  const [alg, it, saleHex, atteso] = conservato.split('$');
  if (alg !== 'pbkdf2-sha256') return false;
  const h = await derivaHash(await conPepper(env, password), unhex(saleHex), Number(it));
  // confronto a tempo costante
  if (h.length !== atteso.length) return false;
  let diff = 0;
  for (let i = 0; i < h.length; i++) diff |= h.charCodeAt(i) ^ atteso.charCodeAt(i);
  return diff === 0;
}

const passwordAccettabile = (p) =>
  typeof p === 'string' && p.length >= PASSWORD_MIN && p.length <= PASSWORD_MAX;

const emailValida = (e) =>
  typeof e === 'string' && e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/* ---- cookie e sessione --------------------------------------------------- */
function leggiCookie(request, nome) {
  const c = request.headers.get('cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + nome + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : '';
}

const cookieSessione = (token, maxAge) =>
  `sessione=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

async function creaSessione(env, utenteId, request) {
  const token = tokenCasuale();
  const adesso = ora();
  await env.DB.prepare('INSERT INTO sessioni (token, utente_id, creata, scade, agente) VALUES (?,?,?,?,?)')
    .bind(await sha256(token), utenteId, adesso, adesso + DURATA_SESSIONE,
      (request.headers.get('user-agent') || '').slice(0, 200)).run();
  await env.DB.prepare('UPDATE utenti SET ultimo_accesso = ? WHERE id = ?').bind(adesso, utenteId).run();
  return cookieSessione(token, DURATA_SESSIONE);
}

/** Restituisce { utente, sessioneHash } oppure null. */
export async function sessioneCorrente(request, env) {
  const token = leggiCookie(request, 'sessione');
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const h = await sha256(token);
  const r = await env.DB.prepare(`
    SELECT s.scade, u.id, u.email, u.ruolo, u.attivo
    FROM sessioni s JOIN utenti u ON u.id = s.utente_id
    WHERE s.token = ?`).bind(h).first();
  if (!r || !r.attivo) return null;
  const adesso = ora();
  if (r.scade < adesso) {
    await env.DB.prepare('DELETE FROM sessioni WHERE token = ?').bind(h).run();
    return null;
  }
  if (r.scade - adesso < RINNOVO_SESSIONE) {
    await env.DB.prepare('UPDATE sessioni SET scade = ? WHERE token = ?').bind(adesso + DURATA_SESSIONE, h).run();
  }
  return { utente: { id: r.id, email: r.email, ruolo: r.ruolo }, sessioneHash: h };
}

export async function autorizzazioniDi(env, utente) {
  const righe = await env.DB.prepare(
    'SELECT sezione, dal, al, origine FROM autorizzazioni WHERE utente_id = ?').bind(utente.id).all();
  const adesso = ora();
  const attive = {};
  for (const s of SEZIONI_LIBERE) attive[s] = { dal: null, al: null, origine: 'libera' };
  for (const r of righe.results || []) {
    if (r.dal <= adesso && (r.al == null || r.al > adesso)) attive[r.sezione] = r;
  }
  if (utente.ruolo === 'autore') for (const s of SEZIONI) attive[s] = attive[s] || { dal: null, al: null, origine: 'autore' };
  return attive;
}

/* ---- protezioni --------------------------------------------------------- */
function origineAmmessa(request) {
  const origin = request.headers.get('origin');
  if (!origin) return true;                       // richiesta non da browser
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}

async function bloccato(env, email) {
  const r = await env.DB.prepare('SELECT n, ultimo FROM accessi_falliti WHERE email = ?').bind(email).first();
  return !!(r && r.n >= MAX_FALLITI && ora() - r.ultimo < BLOCCO_SECONDI);
}
async function segnaFallito(env, email) {
  await env.DB.prepare(`
    INSERT INTO accessi_falliti (email, n, ultimo) VALUES (?, 1, ?)
    ON CONFLICT(email) DO UPDATE SET
      n = CASE WHEN ? - ultimo > ? THEN 1 ELSE n + 1 END, ultimo = ?`)
    .bind(email, ora(), ora(), BLOCCO_SECONDI, ora()).run();
}
const azzeraFalliti = (env, email) =>
  env.DB.prepare('DELETE FROM accessi_falliti WHERE email = ?').bind(email).run();

async function leggiJson(request) {
  try { const t = await request.text(); if (t.length > 4096) return null; return JSON.parse(t); } catch { return null; }
}

/* ---- inviti e licenze (usati dall'amministrazione e, in fase 4, dal webhook) */
export async function creaInvito(env, utenteId, scopo = 'password', durata = DURATA_INVITO) {
  const token = tokenCasuale();
  const adesso = ora();
  await env.DB.prepare('INSERT INTO token_monouso (token, utente_id, scopo, creato, scade) VALUES (?,?,?,?,?)')
    .bind(await sha256(token), utenteId, scopo, adesso, adesso + durata).run();
  return token;
}

const ALFABETO_CHIAVE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function generaChiave() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  const c = Array.from(b).map(x => ALFABETO_CHIAVE[x % ALFABETO_CHIAVE.length]);
  return [0, 4, 8, 12].map(i => c.slice(i, i + 4).join('')).join('-');
}

/* ---- endpoint pubblici --------------------------------------------------- */
async function accesso(request, env) {
  if (!origineAmmessa(request)) return json({ errore: 'origine non ammessa' }, 403);
  const d = await leggiJson(request);
  const email = (d?.email || '').trim().toLowerCase();
  const password = d?.password || '';
  if (!emailValida(email) || typeof password !== 'string') return json({ errore: 'dati non validi' }, 400);
  if (await bloccato(env, email)) return json({ errore: 'troppi tentativi: riprova fra un quarto d\'ora' }, 429);

  const u = await env.DB.prepare('SELECT id, hash, attivo FROM utenti WHERE email = ?').bind(email).first();
  const ok = u && u.attivo && u.hash && await verificaPassword(env, password, u.hash);
  if (!ok) {
    await segnaFallito(env, email);
    return json({ errore: 'mail o password non corrette' }, 401);
  }
  await azzeraFalliti(env, email);
  const cookie = await creaSessione(env, u.id, request);
  return json({ ok: true }, 200, { 'set-cookie': cookie });
}

async function esci(request, env) {
  if (!origineAmmessa(request)) return json({ errore: 'origine non ammessa' }, 403);
  const s = await sessioneCorrente(request, env);
  if (s) await env.DB.prepare('DELETE FROM sessioni WHERE token = ?').bind(s.sessioneHash).run();
  return json({ ok: true }, 200, { 'set-cookie': cookieSessione('', 0) });
}

async function me(request, env) {
  const s = await sessioneCorrente(request, env);
  if (!s) return json({ accesso: false, sezioniLibere: [...SEZIONI_LIBERE] }, 200);
  return json({ accesso: true, email: s.utente.email, ruolo: s.utente.ruolo,
    autorizzazioni: await autorizzazioniDi(env, s.utente) });
}

async function impostaPassword(request, env) {
  if (!origineAmmessa(request)) return json({ errore: 'origine non ammessa' }, 403);
  const d = await leggiJson(request);
  const token = d?.token || '';
  if (!/^[0-9a-f]{64}$/.test(token)) return json({ errore: 'token non valido' }, 400);
  if (!passwordAccettabile(d?.password))
    return json({ errore: `la password deve avere fra ${PASSWORD_MIN} e ${PASSWORD_MAX} caratteri` }, 400);

  const h = await sha256(token);
  const t = await env.DB.prepare(
    'SELECT token, utente_id, scade, usato FROM token_monouso WHERE token = ? AND scopo = ?').bind(h, 'password').first();
  if (!t || t.usato || t.scade < ora()) return json({ errore: 'link scaduto o già usato' }, 400);

  const hash = await hashPassword(env, d.password);
  await env.DB.batch([
    env.DB.prepare('UPDATE utenti SET hash = ?, attivo = 1 WHERE id = ?').bind(hash, t.utente_id),
    env.DB.prepare('UPDATE token_monouso SET usato = ? WHERE token = ?').bind(ora(), h),
    env.DB.prepare('DELETE FROM sessioni WHERE utente_id = ?').bind(t.utente_id)   // cambio password = fuori da tutte le sessioni
  ]);
  const cookie = await creaSessione(env, t.utente_id, request);
  return json({ ok: true }, 200, { 'set-cookie': cookie });
}

/** Richiesta di recupero: crea il token e risponde sempre 202, mai se la mail
    esiste. La consegna del link e' del servizio mail (fase 4); fino ad
    allora l'hash sta in token_monouso e il link lo produce l'autore. */
async function richiediPassword(request, env) {
  if (!origineAmmessa(request)) return json({ errore: 'origine non ammessa' }, 403);
  const d = await leggiJson(request);
  const email = (d?.email || '').trim().toLowerCase();
  if (emailValida(email)) {
    const u = await env.DB.prepare('SELECT id FROM utenti WHERE email = ? AND attivo = 1').bind(email).first();
    if (u) await creaInvito(env, u.id, 'password', DURATA_RECUPERO);
  }
  return json({ ok: true, nota: 'se la mail è registrata, il link arriverà' }, 202);
}

/* ---- EA live per sessione: le griglie delle licenze dell'utente ------------ */
async function liveSessione(request, env) {
  const s = await sessioneCorrente(request, env);
  if (!s) return json({ errore: 'accesso richiesto' }, 401);
  const aut = await autorizzazioniDi(env, s.utente);
  if (!aut.ealive) return json({ errore: 'sezione non autorizzata' }, 403);

  const autore = s.utente.ruolo === 'autore';
  const lic = autore
    ? await env.DB.prepare('SELECT chiave FROM licenze').all()
    : await env.DB.prepare('SELECT chiave FROM licenze WHERE utente_id = ?').bind(s.utente.id).all();
  const chiavi = (lic.results || []).map(r => r.chiave);
  const adesso = ora();
  if (!chiavi.length) return json({ adesso, licenze: [], griglie: [], conti: [], attivazioni: [] });

  const segnaposto = chiavi.map(() => '?').join(',');
  const [griglie, conti, att] = await Promise.all([
    env.DB.prepare(`SELECT * FROM griglia_stato WHERE chiave IN (${segnaposto}) ORDER BY conto, simbolo`).bind(...chiavi).all(),
    env.DB.prepare(`SELECT * FROM conto_stato WHERE chiave IN (${segnaposto})`).bind(...chiavi).all(),
    env.DB.prepare(`SELECT chiave, conto, broker, prima, ultima FROM attivazioni WHERE chiave IN (${segnaposto})`).bind(...chiavi).all()
  ]);
  const conFreschezza = (r) => ({ ...r, extra: r.extra ? JSON.parse(r.extra) : null,
    secondiFa: adesso - r.ricevuto, fresco: adesso - r.ricevuto < FRESCO_SECONDI });
  return json({
    adesso,
    etichetta: 'live — telemetria dell\'expert, conto demo o reale come dichiarato dal broker',
    licenze: chiavi,
    attivazioni: att.results || [],
    conti: (conti.results || []).map(conFreschezza),
    griglie: (griglie.results || []).map(conFreschezza)
  });
}

/* ---- amministrazione ----------------------------------------------------- */
function adminOk(request, env) {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) return false;
  const a = request.headers.get('authorization') || '';
  return a === 'Bearer ' + env.ADMIN_TOKEN;
}

/** Crea utente (o lo ritrova), collega una licenza, applica autorizzazioni,
    restituisce il token d'invito. Usabile anche dal webhook del MoR. */
export async function creaUtente(env, { email, ruolo = 'cliente', chiave = null, autorizzazioni = [] }) {
  email = (email || '').trim().toLowerCase();
  if (!emailValida(email)) throw new Error('mail non valida');
  if (!['prova', 'cliente', 'autore'].includes(ruolo)) throw new Error('ruolo non valido');
  const adesso = ora();
  let u = await env.DB.prepare('SELECT id FROM utenti WHERE email = ?').bind(email).first();
  if (!u) {
    const r = await env.DB.prepare('INSERT INTO utenti (email, ruolo, creato) VALUES (?,?,?)').bind(email, ruolo, adesso).run();
    u = { id: r.meta.last_row_id };
  } else {
    await env.DB.prepare('UPDATE utenti SET ruolo = ? WHERE id = ?').bind(ruolo, u.id).run();
  }
  if (chiave) {
    const lic = await env.DB.prepare('SELECT chiave FROM licenze WHERE chiave = ?').bind(chiave).first();
    if (!lic) throw new Error('licenza sconosciuta');
    await env.DB.prepare('UPDATE licenze SET utente_id = ? WHERE chiave = ?').bind(u.id, chiave).run();
  }
  for (const a of autorizzazioni) {
    if (!SEZIONI.has(a.sezione)) throw new Error('sezione sconosciuta: ' + a.sezione);
    const al = a.giorni ? adesso + Math.trunc(a.giorni) * 86400 : null;
    await env.DB.prepare(`
      INSERT INTO autorizzazioni (utente_id, sezione, dal, al, origine) VALUES (?,?,?,?,?)
      ON CONFLICT(utente_id, sezione) DO UPDATE SET dal = excluded.dal, al = excluded.al, origine = excluded.origine`)
      .bind(u.id, a.sezione, adesso, al, a.origine || (chiave ? 'licenza' : 'manuale')).run();
  }
  const token = await creaInvito(env, u.id, 'password', DURATA_INVITO);
  return { utente_id: u.id, email, invito: token };
}

async function adminUtenti(request, env) {
  if (!adminOk(request, env)) return json({ errore: 'non autorizzato' }, 401);
  const d = await leggiJson(request);
  if (!d) return json({ errore: 'JSON non valido' }, 400);
  try {
    const r = await creaUtente(env, d);
    const base = new URL(request.url).origin;
    return json({ ...r, invito_url: `${base}/console.html#imposta=${r.invito}` });
  } catch (e) { return json({ errore: e.message }, 400); }
}

async function adminLicenze(request, env) {
  if (!adminOk(request, env)) return json({ errore: 'non autorizzato' }, 401);
  const d = await leggiJson(request) || {};
  const chiave = d.chiave || generaChiave();
  const maxConti = Math.max(1, Math.trunc(Number(d.max_conti) || 1));
  const scadenza = d.scadenza ? Math.trunc(Number(d.scadenza)) : null;
  try {
    await env.DB.prepare('INSERT INTO licenze (chiave, emessa, scadenza, attiva, max_conti, note) VALUES (?,?,?,1,?,?)')
      .bind(chiave, ora(), scadenza, maxConti, (d.note || '').slice(0, 200)).run();
    if (d.email) {
      const u = await env.DB.prepare('SELECT id FROM utenti WHERE email = ?').bind(d.email.trim().toLowerCase()).first();
      if (u) await env.DB.prepare('UPDATE licenze SET utente_id = ? WHERE chiave = ?').bind(u.id, chiave).run();
    }
    return json({ chiave, max_conti: maxConti, scadenza });
  } catch (e) { return json({ errore: e.message }, 400); }
}

/* ---- instradamento: una riga in index.js, accanto a instradaLive ---------- */
export async function instradaAuth(request, env) {
  const p = new URL(request.url).pathname;
  const m = request.method;
  if (p === '/api/accesso' && m === 'POST') return accesso(request, env);
  if (p === '/api/esci' && m === 'POST') return esci(request, env);
  if (p === '/api/me' && m === 'GET') return me(request, env);
  if (p === '/api/password/imposta' && m === 'POST') return impostaPassword(request, env);
  if (p === '/api/password/richiedi' && m === 'POST') return richiediPassword(request, env);
  if (p === '/api/live' && m === 'GET') return liveSessione(request, env);
  if (p === '/api/admin/utenti' && m === 'POST') return adminUtenti(request, env);
  if (p === '/api/admin/licenze' && m === 'POST') return adminLicenze(request, env);
  if (p.startsWith('/api/')) return json({ errore: 'percorso sconosciuto' }, 404);
  return null;
}
