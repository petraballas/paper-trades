'use strict';
/* Paper-trading bot (VIRTUAL money only). Never connects to an exchange account, uses no API keys.
   Takes the same signals as the signals board (core.js is the board's signal engine, byte-for-byte),
   simulates fills / SL / TP on public 1m-5m candles and writes state.json. */
const fs = require('fs');
const { analyze, detect, detectSMC, HTF, tfMs } = require('./core.js');

const RULES = { START: 1000, RISK: 0.02, RISK_BY_STR: { 4: 0.02, 5: 0.03 }, RISK_MIN: 0.01, RISK_MAX: 0.03, LEVS: [5, 10, 20, 25, 50], LEV: 50, MARGIN_CAP: 0.09, LIQ_X: 1.5, SETUPS: ['breakout', 'bounce', 'pullback', 'smc'], MIN_STR: 4, MAX_OPEN: 10, FEE: 0.00055, MMR: 0.005, PENDING_BARS: 24, TP1_PART: 0.5 };
const CFG = { TOP: 100, TFS: ['15m', '1h', '4h'], CONC: 8, TIMEOUT: 12000 }; // TOP = universe size (USDT perps by 24h turnover)
const STABLE = /^(USDT|USDC|USDE|FDUSD|TUSD|DAI|BUSD|USDD|PYUSD|USD1|USDS|USDG|USDP|USDQ|USDR|USDX|USD0|RLUSD|BFUSD|LUSD|SUSD|GUSD|FRAX|CRVUSD|GHO|EUR|EURC|EURI|XAUT|PAXG)$/;
const STATE = process.argv[2] || 'state.json';
const NOW = Date.now();
const log = (...a) => console.log(new Date().toISOString(), ...a);

/* per-host request throttle: keeps us under public rate limits (Bybit 600/5s, OKX candles 40/2s, Gate 200/10s) */
const RL_MS = { 'api.bybit.com': 25, 'www.okx.com': 60, 'api.gateio.ws': 55 }, RL_NEXT = {};
async function throttle(url) { let h = ''; try { h = new URL(url).host; } catch (e) { } const gap = RL_MS[h]; if (!gap) return; const now = Date.now(), at = Math.max(now, RL_NEXT[h] || 0); RL_NEXT[h] = at + gap; if (at > now) await new Promise(r => setTimeout(r, at - now)); }
async function getJSON(url, ms = CFG.TIMEOUT) {
  await throttle(url);
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'paper-trades-bot' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
async function retry(fn) { for (let a = 0; ; a++) { try { return await fn(); } catch (e) { if (a < 2 && !/HTTP 40[04]|API/.test(e.message)) { await new Promise(r => setTimeout(r, 1000 * (a + 1))); continue; } throw e; } } }
async function pool(items, n, fn) { let i = 0; const run = async () => { while (i < items.length) { const k = i++; try { await fn(items[k], k); } catch (e) { } } }; await Promise.all(Array.from({ length: n }, run)); }

/* ---------- providers (same endpoints and mapping as the board) ---------- */
const IV = { // interval names per provider
  bybit: { '1m': '1', '5m': '5', '15m': '15', '1h': '60', '4h': '240' },
  okx: { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1H', '4h': '4H' },
  gate: { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h' },
  binance: { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h', '4h': '4h' },
};
const P = {
  bybit: {
    name: 'Bybit', base: 'https://api.bybit.com', id: b => b + 'USDT',
    async tickers() {
      const j = await getJSON(this.base + '/v5/market/tickers?category=linear'); if (j.retCode !== 0) throw new Error(j.retMsg);
      return j.result.list.filter(x => x.symbol.endsWith('USDT')).map(x => ({ id: x.symbol, base: x.symbol.replace(/USDT$/, ''), last: +x.lastPrice, turnover: +x.turnover24h, funding: x.fundingRate === '' ? null : +x.fundingRate }));
    },
    async klines(id, tf, limit = 300) {
      const j = await getJSON(`${this.base}/v5/market/kline?category=linear&symbol=${id}&interval=${IV.bybit[tf]}&limit=${limit}`); if (j.retCode !== 0) throw new Error('API ' + j.retMsg);
      return j.result.list.map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[6] })).reverse();
    },
  },
  okx: {
    name: 'OKX', base: 'https://www.okx.com', id: b => b + '-USDT-SWAP',
    async tickers() {
      const j = await getJSON(this.base + '/api/v5/market/tickers?instType=SWAP');
      return j.data.filter(x => x.instId.endsWith('-USDT-SWAP')).map(x => ({ id: x.instId, base: x.instId.split('-')[0], last: +x.last, turnover: +x.volCcy24h * +x.last, funding: null }));
    },
    async klines(id, tf, limit = 300) {
      const j = await getJSON(`${this.base}/api/v5/market/candles?instId=${id}&bar=${IV.okx[tf]}&limit=${Math.min(limit, 300)}`);
      if (j.code && j.code !== '0') throw new Error('API ' + j.msg);
      return j.data.map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[7] })).reverse();
    },
  },
  gate: {
    name: 'Gate', base: 'https://api.gateio.ws/api/v4', id: b => b + '_USDT',
    async tickers() {
      const j = await getJSON(this.base + '/futures/usdt/tickers');
      return j.map(x => ({ id: x.contract, base: x.contract.replace(/_USDT$/, ''), last: +x.last, turnover: +x.volume_24h_quote, funding: x.funding_rate === undefined ? null : +x.funding_rate }));
    },
    async klines(id, tf, limit = 300) {
      const j = await getJSON(`${this.base}/futures/usdt/candlesticks?contract=${id}&interval=${IV.gate[tf]}&limit=${limit}`);
      return j.map(r => ({ t: r.t * 1000, o: +r.o, h: +r.h, l: +r.l, c: +r.c, v: +r.sum }));
    },
  },
  binance: { // spot mirror — last-resort source for price tracking only (not for signals)
    name: 'Binance spot', base: 'https://data-api.binance.vision', id: b => b + 'USDT',
    async klines(id, tf, limit = 300) {
      const j = await getJSON(`${this.base}/api/v3/klines?symbol=${id}&interval=${IV.binance[tf]}&limit=${limit}`);
      return j.map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[7] }));
    },
  },
};
const ALL = ['bybit', 'okx', 'gate'];
let PROV = null;
const DEAD = {};

async function loadTickers() {
  let err;
  for (const k of ALL) {
    try { const t = await P[k].tickers(); if (!t.length) throw new Error('empty'); PROV = k; return t; }
    catch (e) { err = e; DEAD[k] = 1; log('tickers fail', k, e.message); }
  }
  throw err;
}
async function cryptoSet() {
  try { const j = await getJSON('https://api.bybit.com/v5/market/instruments-info?category=linear&limit=1000'); return new Set(j.result.list.filter(x => ['', 'innovation', 'adventure'].includes(x.symbolType || '')).map(x => x.baseCoin)); } catch (e) { }
  try { const j = await getJSON('https://www.okx.com/api/v5/public/instruments?instType=SWAP'); return new Set(j.data.filter(x => x.instCategory === '1').map(x => x.instId.split('-')[0])); } catch (e) { }
  return null;
}
async function klines(base, tf, limit = 300, extra = []) {
  const ord = [PROV, ...ALL.filter(k => k !== PROV && !DEAD[k]), ...extra].filter(Boolean);
  let err; for (const k of ord) { try { const b = await retry(() => P[k].klines(P[k].id(base), tf, limit)); if (b && b.length) return { bars: b, src: k }; throw new Error('empty'); } catch (e) { err = e; } }
  throw err;
}


/* all closed 1m candles from `from` to now, paginated (covers gaps up to ~3 days) */
const RANGE = {
  async okx(id, from) { // /candles has the latest 300; /history-candles pages back in time
    let out = [], after = '', guard = 0;
    while (guard++ < 45) {
      const ep = guard === 1 ? 'candles' : 'history-candles';
      const j = await getJSON(`https://www.okx.com/api/v5/market/${ep}?instId=${id}&bar=1m&limit=${guard === 1 ? 300 : 100}${after ? '&after=' + after : ''}`);
      if (j.code && j.code !== '0') throw new Error('API ' + j.msg);
      const b = j.data.map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] }));
      if (!b.length) break; out = out.concat(b); const oldest = b[b.length - 1].t; if (oldest <= from) break; after = oldest;
    }
    return out;
  },
  async bybit(id, from) { let out = [], end = NOW, g = 0; while (g++ < 6) { const j = await getJSON(`https://api.bybit.com/v5/market/kline?category=linear&symbol=${id}&interval=1&limit=1000&start=${from}&end=${end}`); if (j.retCode !== 0) throw new Error('API ' + j.retMsg); const b = j.result.list.map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] })); if (!b.length) break; out = out.concat(b); const o = b[b.length - 1].t; if (o <= from) break; end = o - 1; } return out; },
  async gate(id, from) { let out = [], f = Math.floor(from / 1000), g = 0; while (g++ < 6) { const to = Math.min(Math.floor(NOW / 1000), f + 1999 * 60); const j = await getJSON(`https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${id}&interval=1m&from=${f}&to=${to}`); out = out.concat(j.map(r => ({ t: r.t * 1000, o: +r.o, h: +r.h, l: +r.l, c: +r.c }))); if (to >= Math.floor(NOW / 1000)) break; f = to + 60; } return out; },
  async binance(id, from) { let out = [], st = from, g = 0; while (g++ < 6) { const j = await getJSON(`https://data-api.binance.vision/api/v3/klines?symbol=${id}&interval=1m&limit=1000&startTime=${st}`); const b = j.map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4] })); out = out.concat(b); if (b.length < 1000) break; st = b[b.length - 1].t + 6e4; } return out; },
};
async function range1m(base, from) {
  const ord = [PROV, ...ALL.filter(k => k !== PROV && !DEAD[k]), 'binance'].filter(Boolean);
  let err; for (const k of ord) {
    try { const raw = await retry(() => RANGE[k](P[k].id(base), from)); const m = new Map(); raw.forEach(b => m.set(b.t, b)); const b = [...m.values()].sort((x, y) => x.t - y.t);
      if (!b.length) throw new Error('empty'); if (b[0].t > from + 6e4 && NOW - from < 3 * 864e5) throw new Error('gap not covered'); return { bars: b, src: k }; }
    catch (e) { err = e; }
  }
  throw err;
}

/* ---------- state ---------- */
function load() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch (e) { }
  return { v: 1, created: NOW, rules: RULES, balance: RULES.START, positions: [], pending: [], closed: [], equity: [], seen: {}, nextId: 1, runs: 0 };
}
const st = load();
const dirN = p => p.dir === 'long' ? 1 : -1;
const fee = notional => notional * RULES.FEE;
const r8 = x => +(+x).toPrecision(10);
// leverage is per position: new ones use RULES.LEV, older positions/orders without .lev were opened at 20x and keep it
const levOf = p => p.lev || 20;
function liqPrice(entry, dir, lev = RULES.LEV) { return dir === 'long' ? entry * (1 - 1 / lev + RULES.MMR) : entry * (1 + 1 / lev - RULES.MMR); }
function unreal(p) { return p.last == null ? 0 : p.qty * (p.last - p.fill) * dirN(p); }
function equity() { return st.balance + st.positions.reduce((s, p) => s + unreal(p), 0); }
function usedMargin() { return st.positions.reduce((s, p) => s + p.margin, 0) + st.pending.reduce((s, o) => s + o.margin, 0); }

function closePart(p, qty, price, reason, t) {
  const pnl = qty * (price - p.fill) * dirN(p), f = fee(qty * price);
  st.balance += pnl - f; p.realized = (p.realized || 0) + pnl - f; p.fees += f;
  p.fills = p.fills || []; p.fills.push({ t, price: r8(price), qty: r8(qty), reason, pnl: +(pnl - f).toFixed(4) });
  p.qty = r8(p.qty - qty);
}
function finish(p, reason, t) {
  p.closedAt = t; p.result = reason; p.pnl = +p.realized.toFixed(4); p.status = 'closed';
  p.margin0 = p.margin; delete p.margin; delete p.last;
  st.positions = st.positions.filter(x => x !== p); st.closed.unshift(p);
  log('CLOSE', p.base, p.dir, reason, p.pnl);
}
function openFromOrder(o, price, t) {
  const notional = o.qty * price, f = fee(notional);
  st.balance -= f;
  const p = Object.assign({}, o, { status: 'open', fill: r8(price), filledAt: t, fees: f, realized: -f, qty0: o.qty, tp1Hit: false, be: false, lev: levOf(o), liq: r8(liqPrice(price, o.dir, levOf(o))), margin: notional / levOf(o), last: price });
  delete p.expires; st.positions.push(p); log('OPEN', p.base, p.dir, p.tf, p.type, 'qty', p.qty, '@', price);
  return p;
}

/* one candle against an open position. Conservative: stop/liquidation checked before targets */
function stepPos(p, c, fillCandle) {
  const L = p.dir === 'long', t = c.t;
  const stopHit = L ? c.l <= p.sl : c.h >= p.sl, liqHit = L ? c.l <= p.liq : c.h >= p.liq;
  const liqFirst = L ? p.liq >= p.sl : p.liq <= p.sl; // liquidation sits before the stop
  if (liqHit && liqFirst) { // isolated margin lost
    closePart(p, p.qty, p.liq, 'LIQ', t); const loss = p.margin; // force loss = remaining margin (approx)
    finish(p, 'LIQ', t); return true;
  }
  if (stopHit) { closePart(p, p.qty, p.sl, p.be ? 'BE' : 'SL', t); finish(p, p.be ? (p.tp1Hit ? 'TP1+BE' : 'BE') : 'SL', t); return true; }
  if (fillCandle) return false; // unknown intra-candle order on the fill candle → targets wait for next candle
  if (!p.tp1Hit && (L ? c.h >= p.tp1 : c.l <= p.tp1)) {
    const q = r8(p.qty0 * RULES.TP1_PART); closePart(p, q, p.tp1, 'TP1', t);
    p.tp1Hit = true; p.be = true; p.sl = p.fill; p.tp1At = t;
    p.margin = p.qty * p.fill / levOf(p); log('TP1', p.base);
  }
  if (p.tp1Hit && (L ? c.h >= p.tp2 : c.l <= p.tp2)) { closePart(p, p.qty, p.tp2, 'TP2', t); finish(p, 'TP2', t); return true; }
  return false;
}
function stepOrder(o, c) { // pending limit at signal entry
  const L = o.dir === 'long';
  if (c.t >= o.expires) { cancel(o, 'expired', c.t); return 'done'; }
  const touch = L ? c.l <= o.entry : c.h >= o.entry;
  const invalid = L ? (c.h >= o.tp1 || c.l <= o.sl) : (c.l <= o.tp1 || c.h >= o.sl);
  if (!touch && invalid) { cancel(o, 'invalid', c.t); return 'done'; }
  if (touch) { st.pending = st.pending.filter(x => x !== o); const p = openFromOrder(o, o.entry, c.t); stepPos(p, c, true); return 'filled'; }
  return null;
}
function cancel(o, why, t) { st.pending = st.pending.filter(x => x !== o); st.cancelled = st.cancelled || []; st.cancelled.unshift(Object.assign({}, o, { status: 'cancelled', why, at: t })); st.cancelled = st.cancelled.slice(0, 100); log('CANCEL', o.base, why); }

async function track(tickMap) {
  const items = [...st.positions, ...st.pending];
  await pool(items, CFG.CONC, async it => {
    const from = it.cursor || NOW, ms = 6e4;
    if (NOW - from < ms) { const tk = tickMap[it.base]; if (tk) it.last = tk.last; return; }
    let bars; try { bars = (await range1m(it.base, from)).bars; } catch (e) { log('track fail', it.base, e.message); return; }
    for (const c of bars) {
      if (c.t < from || c.t + ms > NOW) continue; // closed candles after cursor only
      it.cursor = c.t + ms;
      if (it.status === 'pending') { const r = stepOrder(it, c); if (r === 'filled') { const p = st.positions.find(x => x.id === it.id); if (!p) return; it = p; it.cursor = c.t + ms; continue; } if (r === 'done') return; }
      else if (stepPos(it, c, false)) return;
    }
    const tk = tickMap[it.base]; it.last = tk ? tk.last : bars[bars.length - 1].c;
  });
}

/* Universe of up to CFG.TOP coins × 3 TFs. To keep each 60s iteration fast, 1h/4h are rescanned only when a new candle
   of that TF has closed (and for the first SETTLE ms after the close, in case the exchange finalises the bar late);
   otherwise their signals and trends are reused from st.scanCache. 15m is scanned every iteration. */
const SETTLE = 3 * 6e4;
async function scan(top) {
  const an = {}, found = [], trend = {}; st.scanCache = st.scanCache || {}; const scanned = [];
  for (const tf of CFG.TFS.slice().reverse()) { // 4h → 1h → 15m (higher timeframe first, as on the board)
    const ms = tfMs(tf), bar = Math.floor(NOW / ms), c = st.scanCache[tf];
    const fresh = tf !== '15m' && c && c.bar === bar && NOW - bar * ms > SETTLE && (NOW - c.at) < ms && c.n >= Math.min(top.length, CFG.TOP) * 0.8;
    if (fresh) { // reuse
      Object.assign(trend, Object.fromEntries(Object.entries(c.trends).map(([k, v]) => [k + tf, v])));
      const inTop = Object.fromEntries(top.map(x => [x.base, x]));
      for (const sg of c.sigs) if (inTop[sg.coin.base]) found.push(Object.assign({}, sg, { coin: inTop[sg.coin.base] }));
      continue;
    }
    const sigs = [], trends = {}; scanned.push(tf);
    await pool(top, CFG.CONC, async coin => {
      const { bars } = await klines(coin.base, tf, 300); const a = analyze(bars, tf); if (!a) return; an[coin.base + tf] = a;
      trends[coin.base] = a.trend; trend[coin.base + tf] = a.trend;
      const htfTrend = tf === '4h' ? (a.e50[a.n] > a.e50[a.n - 10] ? 1 : -1) * (a.trend !== 0 ? 1 : 0) : (trend[coin.base + HTF[tf]] || 0);
      const d = detect(a, tf, coin, htfTrend).filter(s => RULES.SETUPS.includes(s.type)).sort((p, q) => q.strength - p.strength || q.rr - p.rr);
      if (d.length) sigs.push(d[0]);
      if (RULES.SETUPS.includes('smc')) { const m = detectSMC(a, tf, coin, htfTrend); if (m.length) sigs.push(m[0]); }
    });
    found.push(...sigs);
    if (tf !== '15m') st.scanCache[tf] = { bar, at: NOW, n: Object.keys(trends).length, trends, sigs: sigs.map(sg => Object.assign({}, sg, { coin: { base: sg.coin.base, last: sg.coin.last } })) };
  }
  st.scanned = scanned;
  return found;
}

/* Dynamic sizing (only for signals that already passed the 4★ bar — sizing never lowers the quality bar or tries to fill slots).
   Risk by strength: 4★ 2%, 5★ 3%; ×0.5 after 3 losses in a row or drawdown > 10%; clamped to 1–3% of equity.
   Leverage: lowest of LEVS where margin ≤ 9% of equity (keeps room if more good setups come, up to 10)
   and liquidation is at least 1.5× the stop distance from entry. Otherwise the trade is skipped. */
function sizing(s, eq) {
  let riskPct = RULES.RISK_BY_STR[Math.min(5, s.strength)] || RULES.RISK; const notes = [];
  const last3 = st.closed.slice(0, 3); // newest first
  if (last3.length === 3 && last3.every(t => (t.pnl || 0) < 0)) { riskPct *= 0.5; notes.push('×0.5 после 3 убытков подряд'); }
  else { const peak = Math.max(RULES.START, ...st.equity.map(x => x.e)); const dd = 1 - eq / peak; if (dd > 0.10) { riskPct *= 0.5; notes.push(`×0.5: просадка ${(dd * 100).toFixed(1)}%`); } }
  riskPct = Math.min(RULES.RISK_MAX, Math.max(RULES.RISK_MIN, riskPct));
  const dist = Math.abs(s.entry - s.sl), risk$ = eq * riskPct, qty = risk$ / dist, notional = qty * s.entry, distPct = dist / s.entry;
  for (const lev of RULES.LEVS) {
    const liqDist = 1 / lev - RULES.MMR; // distance to liquidation as a fraction of entry
    if (liqDist < RULES.LIQ_X * distPct) return { ok: false, skip: 'liq', why: lev === RULES.LEVS[0] ? `стоп ${(distPct * 100).toFixed(2)}%: даже при ${lev}x ликвидация ближе 1.5× стопа` : `стоп ${(distPct * 100).toFixed(2)}%: при ${lev}x ликвидация ближе 1.5× стопа, а на меньшем плече маржа > 9% эквити` };
    const margin = notional / lev;
    if (margin <= RULES.MARGIN_CAP * eq) return { ok: true, lev, riskPct, risk$, qty, margin, why: `${Math.min(5, s.strength)}★ → риск ${+(riskPct * 100).toFixed(2)}%, плечо ${lev}x${notes.length ? ' (' + notes.join(', ') + ')' : ''}` };
  }
  return { ok: false, skip: 'margin', why: `маржа > ${RULES.MARGIN_CAP * 100}% эквити даже при ${RULES.LEVS[RULES.LEVS.length - 1]}x` };
}
function act(signals, tickMap) {
  const fresh = signals.filter(s => s.strength >= RULES.MIN_STR).sort((a, b) => b.strength - a.strength || b.t - a.t || b.rr - a.rr);
  for (const s of fresh) {
    const key = s.key + '@' + s.t;
    if (st.seen[key]) continue;
    const base = s.coin.base;
    const same = b => b.replace(/^1000+/, '') === base.replace(/^1000+/, ''); // PEPE vs 1000PEPE across providers = same coin
    if (st.positions.some(p => same(p.base)) || st.pending.some(o => same(o.base))) { continue; }
    if (st.positions.length + st.pending.length >= RULES.MAX_OPEN) { st.seen[key] = { t: NOW, skip: 'max10' }; continue; }
    const eq = equity();
    const sz = sizing(s, eq);
    if (!sz.ok) { st.seen[key] = { t: NOW, skip: sz.skip }; log('SKIP', sz.skip, base, s.dir, s.tf, s.type, sz.why); continue; }
    const { lev, riskPct, qty, margin } = sz, free = eq - usedMargin();
    if (margin > free) { st.seen[key] = { t: NOW, skip: 'margin' }; log('SKIP margin', base, margin.toFixed(2), free.toFixed(2)); continue; }
    st.seen[key] = { t: NOW, id: st.nextId };
    const last = tickMap[base] ? tickMap[base].last : s.coin.last, L = s.dir === 'long';
    const o = { id: st.nextId++, key, base, tf: s.tf, type: s.type, dir: s.dir, strength: s.strength, why: s.why, tags: s.tags, signalAt: s.t,
      entry: r8(s.entry), sl: r8(s.sl), sl0: r8(s.sl), tp1: r8(s.tp1), tp2: r8(s.tp2), rr: +s.rr.toFixed(2), qty: r8(qty), risk: +sz.risk$.toFixed(2), lev, riskPct: +(riskPct * 100).toFixed(2), sizeWhy: sz.why,
      margin, createdAt: NOW, cursor: Math.floor(NOW / 6e4) * 6e4 + 6e4, expires: s.t + RULES.PENDING_BARS * tfMs(s.tf), status: 'pending' };
    if (L ? last <= s.entry : last >= s.entry) { const p = openFromOrder(o, last, NOW); p.cursor = o.cursor; }  // market already at / better than entry → fill now
    else { o.last = last; st.pending.push(o); log('PENDING', base, s.dir, s.tf, '@', s.entry); }
  }
}

function stats() {
  const eq = equity();
  const pt = { t: NOW, e: +eq.toFixed(2), b: +st.balance.toFixed(2) }, lp = st.equity[st.equity.length - 1], lp2 = st.equity[st.equity.length - 2];
  if (lp && lp2 && lp.t - lp2.t < 4.5 * 6e4) st.equity[st.equity.length - 1] = pt; else st.equity.push(pt); // ~5-min resolution
  if (st.equity.length > 4000) { // thin out: keep every 3rd of the oldest half
    const half = st.equity.length >> 1; st.equity = st.equity.slice(0, half).filter((_, i) => i % 3 === 0).concat(st.equity.slice(half));
  }
  const cut = NOW - 14 * 864e5; for (const k in st.seen) if (st.seen[k].t < cut) delete st.seen[k];
  if (st.closed.length > 1000) st.closed = st.closed.slice(0, 1000);
  st.used = +usedMargin().toFixed(2); st.equityNow = +eq.toFixed(2); st.free = +(eq - usedMargin()).toFixed(2);
}

(async () => {
  const t0 = Date.now();
  let tickers = [], top = [];
  try {
    const [all, cs] = await Promise.all([loadTickers(), cryptoSet()]);
    tickers = all;
    top = all.filter(x => !STABLE.test(x.base) && x.turnover > 0 && x.last > 0 && (!cs || cs.has(x.base))).sort((a, b) => b.turnover - a.turnover).slice(0, CFG.TOP);
  } catch (e) { log('no tickers', e.message); }
  const tickMap = Object.fromEntries(tickers.map(x => [x.base, x]));
  await track(tickMap);
  let signals = [];
  const tTrack = Date.now() - t0;
  if (top.length) { try { signals = await scan(top); } catch (e) { log('scan fail', e.message); } }
  st.scanMs = Date.now() - t0 - tTrack; st.trackMs = tTrack;
  act(signals, tickMap);
  st.runs++; st.lastRun = NOW; st.source = PROV ? P[PROV].name : null; st.universe = top.map(c => c.base);
  st.lastSignals = signals.map(s => ({ base: s.coin.base, tf: s.tf, type: s.type, dir: s.dir, strength: s.strength, entry: r8(s.entry), sl: r8(s.sl), tp1: r8(s.tp1), tp2: r8(s.tp2), t: s.t }));
  st.rules = RULES; stats();
  st.runMs = Date.now() - t0;
  fs.writeFileSync(STATE, JSON.stringify(st));
  log('done', 'src', st.source, 'signals', signals.length, '≥4★', signals.filter(s => s.strength >= 4).length, 'open', st.positions.length, 'pending', st.pending.length, 'eq', st.equityNow, (st.runMs / 1000).toFixed(1) + 's');
})().catch(e => { console.error(e); process.exit(1); });
