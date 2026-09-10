// Prove del modulo auth.js su un D1 simulato con node:sqlite (Node 22+).
// Uso: node test_auth.mjs  — deve stampare TUTTE LE PROVE PASSATE.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import * as auth from './auth.js';
import * as live from './live.js';

const db = new DatabaseSync(':memory:');
for (const f of ['schema.sql', 'migrazione_002.sql']) {
  const sql = fs.readFileSync(new URL('./' + f, import.meta.url), 'utf8').replace(/--[^\n]*/g, '');
  for (const st of sql.split(';')) if (st.trim()) db.exec(st);
}
const conv = (v) => (v === undefined ? null : v);
class Stmt {
  constructor(sql) { this.sql = sql; this.args = []; }
  bind(...a) { this.args = a.map(conv); return this; }
  first() { return Promise.resolve(db.prepare(this.sql).get(...this.args) ?? null); }
  all() { return Promise.resolve({ results: db.prepare(this.sql).all(...this.args) }); }
  run() { const r = db.prepare(this.sql).run(...this.args); return Promise.resolve({ meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }); }
}
const env = {
  DB: { prepare: (sql) => new Stmt(sql), batch: async (xs) => { for (const x of xs) await x.run(); } },
  PEPPER: 'pepe-di-prova-lungo-almeno-sedici-caratteri',
  ADMIN_TOKEN: 'token-amministratore-di-prova-lungo-almeno-trentadue'
};
const HOST = 'https://simulatore-dati.arwiaty.workers.dev';
const req = (path, { method = 'GET', body, cookie, headers = {} } = {}) =>
  new Request(HOST + path, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    body: body == null ? undefined : JSON.stringify(body) });
const chiama = async (r) => {
  const res = await auth.instradaAuth(r, env);
  const testo = await res.text();
  let corpo; try { corpo = JSON.parse(testo); } catch { corpo = testo; }
  return { status: res.status, corpo, cookie: res.headers.get('set-cookie') || '' };
};
const ok = (c, m) => { if (!c) { console.error('FALLITO:', m); process.exitCode = 1; } else console.log('ok  ', m); };
const cookieDa = (sc) => sc.split(';')[0];

// 0. password: hash e verifica
const h = await auth.hashPassword(env, 'una-password-lunga');
ok(h.startsWith('pbkdf2-sha256$100000$'), 'hash nel formato con fattore di lavoro');
ok(await auth.verificaPassword(env, 'una-password-lunga', h), 'verifica password corretta');
ok(!(await auth.verificaPassword(env, 'una-password-lungA', h)), 'verifica password sbagliata');
ok(!(await auth.verificaPassword({ ...env, PEPPER: 'altro-pepper-di-sedici-caratteri' }, 'una-password-lunga', h)), 'senza il pepper giusto l\'hash non torna');

// 1. amministrazione: licenza e utente
let r = await chiama(req('/api/admin/licenze', { method: 'POST', body: { note: 'prova' } }));
ok(r.status === 401, 'admin senza token: 401');
r = await chiama(req('/api/admin/licenze', { method: 'POST', body: { max_conti: 2, note: 'prova' }, headers: { authorization: 'Bearer ' + env.ADMIN_TOKEN } }));
ok(r.status === 200 && /^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/.test(r.corpo.chiave) && r.corpo.max_conti === 2, 'licenza generata nel formato XXXX-XXXX-XXXX-XXXX');
const chiave = r.corpo.chiave;
r = await chiama(req('/api/admin/utenti', { method: 'POST', headers: { authorization: 'Bearer ' + env.ADMIN_TOKEN },
  body: { email: 'Cliente@Esempio.it', ruolo: 'cliente', chiave, autorizzazioni: [{ sezione: 'ealive' }, { sezione: 'backtest', giorni: 14 }] } }));
ok(r.status === 200 && r.corpo.email === 'cliente@esempio.it' && /#imposta=[0-9a-f]{64}$/.test(r.corpo.invito_url), 'utente creato, mail normalizzata, link di invito');
const invito = r.corpo.invito;
ok(db.prepare('SELECT utente_id FROM licenze WHERE chiave = ?').get(chiave).utente_id === r.corpo.utente_id, 'licenza collegata all\'utente');
ok(db.prepare('SELECT token FROM token_monouso').get().token !== invito, 'in D1 sta l\'hash dell\'invito, non l\'invito');

// 2. imposta password con l'invito
r = await chiama(req('/api/password/imposta', { method: 'POST', body: { token: invito, password: 'corta' } }));
ok(r.status === 400, 'password troppo corta rifiutata');
r = await chiama(req('/api/password/imposta', { method: 'POST', body: { token: invito, password: 'password-del-cliente-1' }, headers: { origin: 'https://altro.sito' } }));
ok(r.status === 403, 'origine estranea rifiutata');
r = await chiama(req('/api/password/imposta', { method: 'POST', body: { token: invito, password: 'password-del-cliente-1' }, headers: { origin: HOST } }));
ok(r.status === 200 && /sessione=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict/.test(r.cookie), 'password impostata, cookie di sessione emesso');
const cookie1 = cookieDa(r.cookie);
r = await chiama(req('/api/password/imposta', { method: 'POST', body: { token: invito, password: 'password-del-cliente-2' } }));
ok(r.status === 400, 'invito riusato: rifiutato');
ok(db.prepare('SELECT token FROM sessioni').get().token !== cookie1.split('=')[1], 'in D1 sta l\'hash della sessione');

// 3. me e live per sessione
r = await chiama(req('/api/me'));
ok(r.status === 200 && r.corpo.accesso === false && r.corpo.sezioniLibere.includes('rischio'), '/api/me senza sessione: sezioni libere');
r = await chiama(req('/api/me', { cookie: cookie1 }));
ok(r.corpo.accesso === true && r.corpo.autorizzazioni.ealive && r.corpo.autorizzazioni.backtest.al > 0 && r.corpo.autorizzazioni.carry && !r.corpo.autorizzazioni.proiezione, '/api/me: ealive senza scadenza, backtest 14 giorni, carry libera, proiezione no');

// telemetria per quella licenza, poi /api/live
await live.instradaLive(new Request(HOST + '/griglia', { method: 'POST', body: JSON.stringify({ chiave, conto: 42, simbolo: 'EURUSD', magico: 1, evento: 'battito', ts: 0, posizioni: 1, lotti: 0.01, flottante: -0.5 }) }), env);
r = await chiama(req('/api/live'));
ok(r.status === 401, '/api/live senza sessione: 401');
r = await chiama(req('/api/live', { cookie: cookie1 }));
ok(r.status === 200 && r.corpo.griglie.length === 1 && r.corpo.griglie[0].simbolo === 'EURUSD' && r.corpo.griglie[0].fresco, '/api/live: la griglia della propria licenza, fresca');

// 4. un secondo utente non vede le griglie del primo; l'autore vede tutto
r = await chiama(req('/api/admin/utenti', { method: 'POST', headers: { authorization: 'Bearer ' + env.ADMIN_TOKEN }, body: { email: 'altro@esempio.it', ruolo: 'prova', autorizzazioni: [{ sezione: 'ealive', giorni: 7 }] } }));
r = await chiama(req('/api/password/imposta', { method: 'POST', body: { token: r.corpo.invito, password: 'password-di-prova-2' } }));
const cookie2 = cookieDa(r.cookie);
r = await chiama(req('/api/live', { cookie: cookie2 }));
ok(r.status === 200 && r.corpo.griglie.length === 0, 'un utente senza licenze non vede griglie altrui');
r = await chiama(req('/api/admin/utenti', { method: 'POST', headers: { authorization: 'Bearer ' + env.ADMIN_TOKEN }, body: { email: 'autore@esempio.it', ruolo: 'autore' } }));
r = await chiama(req('/api/password/imposta', { method: 'POST', body: { token: r.corpo.invito, password: 'password-autore-lunga' } }));
const cookieA = cookieDa(r.cookie);
r = await chiama(req('/api/me', { cookie: cookieA }));
ok(r.corpo.ruolo === 'autore' && r.corpo.autorizzazioni.proiezione && r.corpo.autorizzazioni.record, 'autore: tutte le sezioni');
r = await chiama(req('/api/live', { cookie: cookieA }));
ok(r.corpo.griglie.length === 1, 'autore vede le griglie di tutte le licenze');

// 5. accesso con password, tentativi sbagliati, blocco, uscita
r = await chiama(req('/api/accesso', { method: 'POST', body: { email: 'cliente@esempio.it', password: 'sbagliata-123' } }));
ok(r.status === 401, 'password sbagliata: 401');
r = await chiama(req('/api/accesso', { method: 'POST', body: { email: 'cliente@esempio.it', password: 'password-del-cliente-1' } }));
ok(r.status === 200 && r.cookie.includes('sessione='), 'accesso corretto: nuova sessione');
const cookie3 = cookieDa(r.cookie);
for (let i = 0; i < 10; i++) await chiama(req('/api/accesso', { method: 'POST', body: { email: 'cliente@esempio.it', password: 'sbagliata-' + i } }));
r = await chiama(req('/api/accesso', { method: 'POST', body: { email: 'cliente@esempio.it', password: 'password-del-cliente-1' } }));
ok(r.status === 429, 'dopo dieci errori: bloccato anche con la password giusta');
r = await chiama(req('/api/esci', { method: 'POST', cookie: cookie3 }));
ok(r.status === 200 && /Max-Age=0/.test(r.cookie), 'uscita: cookie azzerato');
r = await chiama(req('/api/me', { cookie: cookie3 }));
ok(r.corpo.accesso === false, 'dopo l\'uscita la sessione non vale più');
r = await chiama(req('/api/me', { cookie: cookie1 }));
ok(r.corpo.accesso === true, 'le altre sessioni dello stesso utente restano valide');

// 6. recupero: risposta uguale con e senza mail registrata
r = await chiama(req('/api/password/richiedi', { method: 'POST', body: { email: 'nessuno@esempio.it' } }));
const r2 = await chiama(req('/api/password/richiedi', { method: 'POST', body: { email: 'cliente@esempio.it' } }));
ok(r.status === 202 && r2.status === 202 && JSON.stringify(r.corpo) === JSON.stringify(r2.corpo), 'recupero: nessuna enumerazione delle mail');

// 7. PEPPER mancante: impostare la password fallisce rumorosamente
let esploso = false;
try { await auth.hashPassword({ ...env, PEPPER: undefined }, 'x'.repeat(12)); } catch { esploso = true; }
ok(esploso, 'senza PEPPER non si conserva nessuna password');

r = await chiama(req('/api/inesistente'));
ok(r.status === 404, 'percorso /api sconosciuto: 404');
console.log(process.exitCode ? 'CI SONO FALLIMENTI' : 'TUTTE LE PROVE PASSATE');
