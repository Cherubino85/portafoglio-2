/* engine.js — motore di calcolo del portafoglio.
 *
 * Principi, perche' qui e' facile sbagliare in modo invisibile:
 *
 * 1. VERSAMENTI E PRELIEVI NON SONO RENDIMENTO. Il rendimento del giorno si
 *    ricava dal profit, non dalla variazione del saldo: un bonifico muove il
 *    saldo e non c'entra nulla con la performance.
 * 2. I PESI DEI CONTI VENGONO DAI SALDI DI QUEL GIORNO, non dedotti a ritroso
 *    dall'equity di oggi. Con conti che ricevono versamenti, dedurli a ritroso
 *    da' pesi sbagliati e quindi un rendimento combinato sbagliato.
 * 3. SALDO ED EQUITY STANNO SULLA STESSA BASE. La curva equity non e' una
 *    curva indipendente: e' la curva del saldo moltiplicata per il rapporto
 *    equity/saldo dichiarato da Myfxbook. Cosi' il loro distacco e' esattamente
 *    quello vero, e l'equity sta sopra il saldo solo quando il flottante e'
 *    davvero positivo.
 * 4. LO SWAP E' UN RENDIMENTO, non un importo appiccicato a un grafico di
 *    percentuali: si compone come gli altri, sulla stessa base. La linea
 *    risponde a "di questo +35%, quanto e' swap".
 *
 * I rendimenti sono calcolati nella valuta del conto: sono neutrali al cambio.
 * Gli importi si convertono in euro solo per pesare e sommare.
 */

const MESI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu',
              'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

const round2 = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

function inRange(date, from, to) {
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function unionDates(accounts, from, to) {
  const set = new Set();
  for (const a of accounts)
    for (const p of a.series)
      if (inRange(p.date, from, to)) set.add(p.date);
  return [...set].sort();
}

function compound(rets) {
  const out = [];
  let acc = 1;
  for (const r of rets) { acc *= (1 + (Number(r) || 0)); out.push(acc); }
  return out;
}

/**
 * Porta un conto sull'asse delle date comune.
 * Il saldo si trascina in avanti (l'ultimo noto), i rendimenti mancanti sono
 * zero: un giorno senza rilevazione e' un giorno fermo, non un buco.
 */
function suAsse(dates, account, mappa) {
  const m = mappa || new Map(account.series.map(p => [p.date, p]));
  const bal = [], ret = [], swap = [], ge = [], gb = [], profit = [], gain = [];
  let ultimoBal = 0, ultimoGe = null, ultimoGb = null;
  for (const d of dates) {
    const p = m.get(d);
    if (p) {
      ultimoBal = p.balance || ultimoBal;
      if (p.ge != null) ultimoGe = p.ge;
      if (p.gb != null) ultimoGb = p.gb;
    }
    bal.push(ultimoBal);
    profit.push(p ? (Number(p.profit) || 0) : 0);
    ret.push(p ? p.balanceRet : 0);
    gain.push(p && p.gainVal != null ? p.gainVal : null);
    swap.push(p ? (p.swap || 0) : 0);
    ge.push(ultimoGe);
    gb.push(ultimoGb);
  }
  /* Rendimenti giornalieri RICAVATI dalle cumulate dichiarate da Myfxbook:
     il rapporto fra due cumulate, non una ricostruzione. Se la crescita del
     saldo non e' dichiarata si ripiega sui rendimenti da profit, che sono
     comunque al netto di versamenti e prelievi. */
  let anomalie = 0;
  const passo = (serie, ripiego) => serie.map((v, i) => {
    if (v == null) return Math.abs(ripiego[i]) > 0.5 ? 0 : ripiego[i];
    const prec = i > 0 ? serie[i - 1] : null;
    if (prec == null) return 0;
    const den = 1 + prec / 100;
    if (den <= 0.01) { anomalie++; return 0; }
    const r = (1 + v / 100) / den - 1;
    /* Un conto non perde meta' del capitale in un giorno ne' lo raddoppia: se
       il passo esce da questa forbice, la serie cumulata ha un salto e va
       ignorato. Propagarlo azzera la curva composta e falsa tutto il resto. */
    if (!Number.isFinite(r) || r < -0.5 || r > 1) { anomalie++; return 0; }
    return r;
  });
  /* Il rendimento del giorno viene, in ordine di preferenza:
     1. dal guadagno giornaliero DICHIARATO da Myfxbook (get-daily-gain)
     2. dal rapporto fra due cumulate, se esistono
     3. dal profit sul saldo del giorno prima
     Con la prima fonte la curva coincide con la loro e non c'e' piu' niente
     da ricostruire — ed e' per questo che i salti anomali spariscono. */
  /* Tre candidati per il rendimento giornaliero, in ordine di preferenza.
   * Non si sceglie per fede: si sceglie quello che produce un cumulato
   * PLAUSIBILE. Un conto non moltiplica per mille il proprio capitale, e una
   * curva che lo fa e' una curva letta male, non un risultato. */
  const derivato = passo(gb, ret);
  const candidati = [
    { nome: 'get-daily-gain come cumulato', ret: passo(gain, derivato) },
    { nome: 'get-daily-gain come passo',
      ret: gain.map((g, i) => g != null ? g / 100 : derivato[i]) },
    { nome: 'ricostruito dai profitti', ret: derivato }
  ];
  /* Il metro di paragone e' la curva ricostruita dai profitti: non e'
     precisissima, ma e' indipendente e nell'ordine di grandezza giusto.
     Fra le interpretazioni di get-daily-gain si sceglie quella che le somiglia
     — cioe' quella letta nel verso giusto — e si scarta chi esce di scala. */
  const fattore = (r) => {
    let f = 1;
    for (const x of r) { f *= (1 + x); if (!Number.isFinite(f)) return null; }
    return (f > 0 && f < 1e6) ? f : null;
  };
  const riferimento = fattore(derivato) || 1;
  /* Banda di tolleranza, non minima distanza: il dato di Myfxbook va preferito
     ANCHE quando si discosta dalla mia ricostruzione — e' proprio quello lo
     scopo. Si scarta solo chi esce dalla banda, cioe' chi e' stato letto nel
     verso sbagliato. */
  const gRif = riferimento - 1;                     // guadagno di riferimento
  const dentroBanda = (f) => {
    if (f == null || f <= 0.02 || f >= 50) return false;
    const g = f - 1;
    /* Se il riferimento e' quasi piatto il rapporto fra guadagni non dice
       nulla, e si torna a confrontare i fattori. */
    if (Math.abs(gRif) < 0.05) return f > riferimento / 2 && f < riferimento * 2;
    if (g === 0 || Math.sign(g) !== Math.sign(gRif)) return false;
    const rapporto = Math.abs(g / gRif);
    return rapporto > 0.5 && rapporto < 2;
  };
  const scelto = (gain.some(v => v != null) ? candidati : [])
      .map(c => ({ ...c, f: fattore(c.ret) }))
      .find(c => dentroBanda(c.f))
    || { nome: 'ricostruito dai profitti', ret: derivato };

  const retSaldo = scelto.ret;
  const retEquity = passo(ge, retSaldo);
  return { bal, ret, swap, ge, gb, gain, profit, retSaldo, retEquity, anomalie,
           cum: compound(retSaldo),
           fonte: scelto.nome,
           dichiarati: gain.filter(v => v != null).length,
           dichiarata: scelto.nome.startsWith('get-daily-gain') };
}

/**
 * buildHome(accounts, { from, to, rates })
 * rates: { CHF: 0.94, ... } cioe' 1 EUR = x valuta.
 */
function buildHome(accounts, opts = {}) {
  const { from, to, rates = {} } = opts;
  const toEur = (v, cur) => {
    if (!cur || cur === 'EUR') return Number(v) || 0;
    const r = Number(rates[cur]);
    return r > 0 ? (Number(v) || 0) / r : (Number(v) || 0);
  };

  let dates = unionDates(accounts, from, to);
  if (!dates.length) return vuoto(from, to);

  /* Una mappa data -> rilevazione per ogni conto, costruita una volta e
     riusata. Cercare dentro la serie a ogni data e' un calcolo quadratico:
     su 2.500 rilevazioni sono milioni di confronti inutili, e sul piano
     gratuito di Cloudflare il tempo di CPU e' la risorsa scarsa. */
  const mappe = accounts.map(a => new Map(a.series.map(p => [p.date, p])));

  /* Si parte dal primo giorno in cui almeno un conto ha un saldo: prima di
     quello non c'e' portafoglio, ci sono solo rilevazioni a zero che
     allungano l'asse e creano anni che non sono mai esistiti. */
  const primoVero = dates.findIndex(d => mappe.some(m => {
    const p = m.get(d);
    return p && Number(p.balance) > 0;
  }));
  if (primoVero > 0) dates = dates.slice(primoVero);

  const parti = accounts.map((a, i) => ({ a, c: suAsse(dates, a, mappe[i]) }));

  /* ---- curve combinate ----
   * Ogni conto entra con la propria curva DICHIARATA da Myfxbook. L'unica cosa
   * calcolata qui e' la combinazione fra piu' conti, che Myfxbook non fornisce
   * perche' non sa che li consideri un portafoglio solo. I pesi sono i saldi
   * di quel giorno, convertiti in euro.
   * Con un conto solo i pesi valgono 1 e la curva e' esattamente la loro. */
  const rSaldo = [], rEquity = [], rSwap = [];
  for (let i = 0; i < dates.length; i++) {
    const j = i > 0 ? i - 1 : 0;
    const pesi = parti.map(p => toEur(p.c.bal[j], p.a.currency));
    const tot = pesi.reduce((x, y) => x + y, 0);
    if (tot <= 0) { rSaldo.push(0); rEquity.push(0); rSwap.push(0); continue; }
    let a = 0, e = 0, s2 = 0;
    parti.forEach((p, k) => {
      const w = pesi[k] / tot;
      a += w * p.c.retSaldo[i];
      e += w * p.c.retEquity[i];
      const base = p.c.bal[j];
      s2 += w * (base > 0 ? p.c.swap[i] / base : 0);
    });
    rSaldo.push(a); rEquity.push(e); rSwap.push(s2);
  }
  const curvaSaldo = compound(rSaldo);
  const curvaEquity = compound(rEquity);
  const curvaSwap = compound(rSwap);

  const balancePct = [], equityPct = [], swapPct = [];
  for (let i = 0; i < dates.length; i++) {
    balancePct.push((curvaSaldo[i] - 1) * 100);
    equityPct.push((curvaEquity[i] - 1) * 100);
    swapPct.push((curvaSwap[i] - 1) * 100);
  }

  /* ---- drawdown sulla curva equity ---- */
  let maxDrawdownPct;
  if (accounts.length === 1 && !from && !to &&
      Number.isFinite(Number(accounts[0].drawdownPct)) && Number(accounts[0].drawdownPct) > 0) {
    maxDrawdownPct = Number(accounts[0].drawdownPct);   // il dichiarato vede anche l'intraday
  } else {
    let picco = -Infinity, dd = 0;
    for (const v of equityPct) {
      const val = 1 + v / 100;
      if (val > picco) picco = val;
      if (picco > 0) dd = Math.max(dd, (picco - val) / picco * 100);
    }
    maxDrawdownPct = dd;
  }

  /* ---- mesi: percentuale del mese sulla curva combinata ---- */
  const indici = new Map();
  dates.forEach((d, i) => {
    const k = d.slice(0, 7);
    if (!indici.has(k)) indici.set(k, { first: i, last: i });
    else indici.get(k).last = i;
  });
  const monthly = [];
  for (const [k, { first, last }] of indici) {
    const prima = first > 0 ? curvaSaldo[first - 1] : 1;
    const dopo = curvaSaldo[last];
    const riga = { mese: k, anno: Number(k.slice(0, 4)),
      etichetta: `${MESI[Number(k.slice(5, 7)) - 1]} ${k.slice(2, 4)}`,
      etichettaBreve: MESI[Number(k.slice(5, 7)) - 1],
      pct: prima > 0 ? round2((dopo / prima - 1) * 100) : 0,
      conti: {}, totale: 0 };
    parti.forEach(p => {
      const a = p.c.cum[first > 0 ? first - 1 : first];
      const b = p.c.cum[last];
      const capitale = toEur(p.c.bal[first > 0 ? first - 1 : first], p.a.currency);
      const g = a > 0 ? capitale * (b / a - 1) : 0;
      riga.conti[p.a.name] = round2(g);
      riga.totale += g;
    });
    riga.totale = round2(riga.totale);
    monthly.push(riga);
  }
  monthly.sort((a, b) => a.mese < b.mese ? -1 : 1);

  /* ---- somme delle statistiche dichiarate da Myfxbook ---- */
  const somma = (campo) => round2(parti.reduce(
    (t, p) => t + toEur(Number(p.a[campo]) || 0, p.a.currency), 0));
  const statistiche = {
    profitto: somma('profit'), swap: somma('interest'),
    versamenti: somma('deposits'), prelievi: somma('withdrawals'),
    saldo: somma('balance'), equity: somma('equity'),
    flottante: somma('flottante')
  };
  /* Profitto realizzato nel periodo scelto: somma dei profit giornalieri
     dichiarati da Myfxbook. Il campo profit del conto e' invece da sempre, e
     mostrarlo accanto a un rendimento di periodo fa sembrare sbagliato uno
     dei due. */
  statistiche.profittoPeriodo = round2(parti.reduce((t, p) =>
    t + toEur(p.c.profit.reduce((x, y) => x + y, 0), p.a.currency), 0));

  const primo = dates[0], ultimo_g = dates[dates.length - 1];
  const nellaFinestra = (d) => d >= primo && d <= ultimo_g;

  /* Profitto per simbolo e swap incassato: SOLO le operazioni chiuse dentro
     la finestra. Prima si sommava tutto lo storico, e quei due numeri erano
     gli unici a non rispettare il filtro. */
  const profittoSimbolo = {}, swapSimbolo = {};
  let swapFinestra = 0, operazioniFinestra = 0;
  for (const p of parti)
    for (const op of (p.a.operazioni || []))
      if (nellaFinestra(op.data)) {
        profittoSimbolo[op.simbolo] =
          (profittoSimbolo[op.simbolo] || 0) + toEur(op.risultato, p.a.currency);
        swapSimbolo[op.simbolo] =
          (swapSimbolo[op.simbolo] || 0) + toEur(op.swap, p.a.currency);
        swapFinestra += toEur(op.swap, p.a.currency);
        operazioniFinestra++;
      }

  /* Ripartizione per simbolo, convertita in euro e ordinata per peso. */
  const perSimbolo = (campo, diretto) => {
    const sorgente = diretto || null;
    if (!sorgente && parti.some(p => !p.a[campo])) return null;
    const m = {};
    if (sorgente) Object.assign(m, sorgente);
    else for (const p of parti)
      for (const [sim, v] of Object.entries(p.a[campo] || {}))
        m[sim] = (m[sim] || 0) + toEur(v, p.a.currency);
    const voci = Object.entries(m)
      .map(([simbolo, valore]) => ({ simbolo, valore: round2(valore) }))
      .filter(v => v.valore !== 0)
      .sort((a, b) => Math.abs(b.valore) - Math.abs(a.valore));
    const tot = voci.reduce((t, v) => t + Math.abs(v.valore), 0);
    return voci.map(v => Object.assign(v,
      { pct: tot > 0 ? round2(Math.abs(v.valore) / tot * 100) : 0 }));
  };
  statistiche.profittoPerSimbolo = perSimbolo(null, profittoSimbolo);
  statistiche.flottantePerSimbolo = perSimbolo('flottantePerSimbolo');

  /* Swap incassato nella finestra, e media giornaliera sui giorni di
     calendario coperti dal periodo scelto. */
  statistiche.operazioniChiuse = operazioniFinestra;
  statistiche.giorniFinestra = Math.max(1,
    Math.round((new Date(ultimo_g) - new Date(primo)) / 86400e3) + 1);

  /* Swap incassato nel periodo.
   * Se la finestra copre tutta la storia dei conti, il totale giusto e' quello
   * DICHIARATO da Myfxbook: e' completo. Lo storico operazioni che l'API
   * restituisce e' invece parziale, e sommarlo darebbe un numero piu' basso
   * del vero. Su finestre piu' strette il dichiarato non e' scomponibile e
   * resta solo la somma delle operazioni disponibili: si dice quante sono. */
  const interaSuTutti = parti.every(p =>
    (!p.a.primaRilevazione || primo <= p.a.primaRilevazione) &&
    (!p.a.ultimaRilevazione || ultimo_g >= p.a.ultimaRilevazione));
  statistiche.finestraIntera = interaSuTutti;
  statistiche.swapDichiarato = somma('interest');
  statistiche.swapFinestra = round2(swapFinestra);
  /* Le cifre in valuta sono SEMPRE quelle dichiarate da Myfxbook, sommate ai
     cambi BCE. Myfxbook non espone profitto, swap, versamenti e prelievi per
     periodo — esistono solo come totali di vita del conto. Calcolarli sul
     campione di 50 operazioni che l'API restituisce darebbe numeri che non
     coincidono con la loro pagina, ed e' esattamente cio' che va evitato. */
  statistiche.swapIncassato = statistiche.swapDichiarato;
  statistiche.swapFonte = 'totale, da Myfxbook';

  /* Rendimento assoluto: profitto sui versamenti. Formula verificata sui due
     conti — 18.258,57/26.574,31 = 68,71% e 8.147,85/15.319,06 = 53,19%,
     identici a quanto dichiara Myfxbook. */
  statistiche.absGainPct = statistiche.versamenti > 0
    ? round2(statistiche.profitto / statistiche.versamenti * 100) : 0;
  statistiche.equitySuSaldoPct = statistiche.saldo > 0
    ? round2(statistiche.equity / statistiche.saldo * 100) : 0;

  /* Swap giornaliero: quanto maturano OGGI le posizioni aperte, non la media
     di quello che e' successo prima. */
  const senzaRitmo = parti.some(p => p.a.swapAlGiorno == null);
  statistiche.swapGiornaliero = senzaRitmo ? null
    : round2(parti.reduce((t, p) => t + toEur(p.a.swapAlGiorno, p.a.currency), 0));

  /* Esposizione per simbolo sulle posizioni aperte: e' una fotografia di
     adesso, non un dato di periodo, e va detto. */
  const espo = {};
  let mancante = false;
  for (const p of parti) {
    if (!p.a.esposizionePerSimbolo) { mancante = true; continue; }
    for (const [sim, v] of Object.entries(p.a.esposizionePerSimbolo)) {
      const e = espo[sim] || (espo[sim] = { lotti: 0, posizioni: 0, flottante: 0, swap: 0 });
      e.lotti += Number(v.lotti) || 0;
      e.posizioni += Number(v.posizioni) || 0;
      e.flottante += toEur(v.flottante, p.a.currency);
      e.swap += toEur(v.swap, p.a.currency);
    }
  }
  statistiche.esposizione = mancante ? null : Object.entries(espo)
    .map(([simbolo, v]) => ({ simbolo, lotti: round2(v.lotti), posizioni: v.posizioni,
      flottante: round2(v.flottante), swap: round2(v.swap) }))
    .sort((a, b) => b.lotti - a.lotti);

  statistiche.flottantePct = statistiche.saldo > 0
    ? round2(statistiche.flottante / statistiche.saldo * 100) : 0;

  // swap sulle posizioni aperte: null se anche un solo conto non l'ha fornito
  const senzaAperte = parti.some(p => p.a.swapAperto == null);
  statistiche.swapAperto = senzaAperte ? null : somma('swapAperto');
  statistiche.swapApertoPct = (senzaAperte || !(statistiche.saldo > 0)) ? null
    : round2(statistiche.swapAperto / statistiche.saldo * 100);
  statistiche.posizioniAperte = senzaAperte ? null
    : parti.reduce((t, p) => t + (Number(p.a.quanteAperte) || 0), 0);

  const ultimo = dates.length - 1;
  const swapEur = parti.reduce((t, p) =>
    t + toEur(p.c.swap.reduce((x, y) => x + y, 0), p.a.currency), 0);

  /* ---- controlli di coerenza, esposti invece che nascosti ---- */
  const controlli = {
    baseCurve: [...new Set(parti.map(p => p.c.fonte))].join(' + '),
    giorniDichiarati: parti.reduce((t, p) => t + (p.c.dichiarati || 0), 0),
    passiAnomaliIgnorati: parti.reduce((t, p) => t + (p.c.anomalie || 0), 0),
    swapDaOperazioniChiuse: round2(swapEur),
    swapDichiarato: statistiche.swap,
    perConto: parti.map(p => ({
      conto: p.a.name,
      calcolato: round2((p.c.cum[ultimo] - 1) * 100),
      dichiarato: round2(Number(p.a.gainPct) || 0),
      scarto: round2((p.c.cum[ultimo] - 1) * 100 - (Number(p.a.gainPct) || 0))
    }))
  };

  return {
    labels: dates,
    balancePct: balancePct.map(round2),
    equityPct: equityPct.map(round2),
    swapPct: swapPct.map(round2),
    gainPct: round2(balancePct[ultimo]),
    equityGainPct: round2(equityPct[ultimo]),
    swapPctFinale: round2(swapPct[ultimo]),
    swapEur: round2(swapEur),
    capitaleEur: round2(parti.reduce((t, p) =>
      t + toEur(p.a.equity != null ? p.a.equity : p.a.balance, p.a.currency), 0)),
    maxDrawdownPct: round2(maxDrawdownPct),
    monthly,
    anni: [...new Set(monthly.map(m => m.anno))].sort(),
    statistiche,
    controlli,
    accounts: parti.map(p => {
      const eqEur = toEur(p.a.equity != null ? p.a.equity : p.a.balance, p.a.currency);
      /* La quota si misura sui SALDI: e' il capitale messo su ogni conto.
         Misurarla sulle equity la fa oscillare col flottante, che e' un'altra
         cosa e ha una scheda sua. */
      const balEur = toEur(p.a.balance, p.a.currency);
      const totEur = parti.reduce((t, q) => t + toEur(q.a.balance, q.a.currency), 0) || 1;
      return {
        id: p.a.id, name: p.a.name, currency: p.a.currency,
        balance: round2(p.a.balance),
        equity: round2(p.a.equity != null ? p.a.equity : p.a.balance),
        equityEur: round2(eqEur),
        balanceEur: round2(balEur),
        quota: round2(balEur / totEur * 100),
        gainPct: round2((p.c.cum[ultimo] - 1) * 100),
        gainTotalePct: round2(Number(p.a.gainPct) || 0),
        absGainPct: round2(Number(p.a.absGainPct) || 0),
        equityPct: round2(Number(p.a.equityPct) || 0),
        drawdownPct: round2(Number(p.a.drawdownPct) || 0),
        profit: round2(Number(p.a.profit) || 0),
        interest: round2(Number(p.a.interest) || 0),
        profittoPeriodo: round2(p.c.profit.reduce((x, y) => x + y, 0)),
        deposits: round2(Number(p.a.deposits) || 0),
        withdrawals: round2(Number(p.a.withdrawals) || 0),
        flottante: round2(Number(p.a.flottante) || 0),
        flottantePct: p.a.balance > 0
          ? round2(Number(p.a.flottante) / p.a.balance * 100) : 0,
        swapAperto: p.a.swapAperto == null ? null : round2(p.a.swapAperto),
        swapApertoPct: (p.a.swapAperto == null || !(p.a.balance > 0)) ? null
          : round2(p.a.swapAperto / p.a.balance * 100),
        quanteAperte: p.a.quanteAperte
      };
    }),
    from: dates[0], to: dates[ultimo], vuoto: false
  };
}

function vuoto(from, to) {
  return { labels: [], balancePct: [], equityPct: [], swapPct: [],
    gainPct: 0, equityGainPct: 0, swapPctFinale: 0, swapEur: 0, capitaleEur: 0,
    maxDrawdownPct: 0, monthly: [], anni: [], statistiche: {}, controlli: {},
    accounts: [], from: from || null, to: to || null, vuoto: true };
}

/** Dettaglio di un conto: stessa logica, un conto solo. */
function buildAccount(account, opts = {}) {
  const h = buildHome([account], opts);
  const m = new Map(account.series.map(p => [p.date, p]));
  let cum = 0;
  const swapValuta = h.labels.map(d => {
    const p = m.get(d);
    cum += p ? (p.swap || 0) : 0;
    return round2(cum);
  });
  return Object.assign(h, {
    account: {
      id: account.id, name: account.name, currency: account.currency,
      profittoPeriodo: h.accounts[0] ? h.accounts[0].profittoPeriodo : 0,
      balance: round2(account.balance),
      equity: round2(account.equity != null ? account.equity : account.balance),
      gainPct: round2(Number(account.gainPct) || 0),
      absGainPct: round2(Number(account.absGainPct) || 0),
      equityPct: round2(Number(account.equityPct) || 0),
      drawdownPct: round2(Number(account.drawdownPct) || 0),
      profit: round2(Number(account.profit) || 0),
      interest: round2(Number(account.interest) || 0),
      deposits: round2(Number(account.deposits) || 0),
      withdrawals: round2(Number(account.withdrawals) || 0),
      flottante: round2(Number(account.flottante) || 0),
      flottantePct: account.balance > 0
        ? round2(Number(account.flottante) / account.balance * 100) : 0,
      swapAperto: account.swapAperto == null ? null : round2(account.swapAperto),
      swapApertoPct: (account.swapAperto == null || !(account.balance > 0)) ? null
        : round2(account.swapAperto / account.balance * 100),
      quanteAperte: account.quanteAperte,
      profittoPerSimbolo: h.statistiche.profittoPerSimbolo,
      flottantePerSimbolo: h.statistiche.flottantePerSimbolo,
      esposizione: h.statistiche.esposizione,
      swapIncassato: h.statistiche.swapIncassato,
      swapFonte: h.statistiche.swapFonte,
      swapGiornaliero: h.statistiche.swapGiornaliero,
      giorniFinestra: h.statistiche.giorniFinestra,
      operazioniChiuse: h.statistiche.operazioniChiuse,
      primaOperazione: account.primaOperazione || null
    },
    swapValuta,
    swapTotaleValuta: swapValuta.length ? swapValuta[swapValuta.length - 1] : 0
  });
}

export { buildHome, buildAccount, compound, unionDates, round2 };
