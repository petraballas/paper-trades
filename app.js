'use strict';
/* Paper demo account viewer. Reads state.json written by the bot (GitHub Actions). Virtual money only. */
const DATA = ['https://raw.githubusercontent.com/petraballas/paper-trades/data/state.json', 'state.json'];
const START = 1000;
const $ = s => document.querySelector(s);
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function fmtP(p) { if (p == null || !isFinite(p)) return '—'; const a = Math.abs(p); const d = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 3 : a >= 0.1 ? 4 : a >= 0.01 ? 5 : a >= 0.001 ? 6 : 8; return p.toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }); }
const usd = (v, sign) => v == null || !isFinite(v) ? '—' : (sign && v > 0 ? '+' : v < 0 ? '−' : '') + '$' + Math.abs(v).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (v, d = 2) => v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d) + '%';
const cls = v => v > 0 ? 'up' : v < 0 ? 'down' : 'mut';
const dt = t => new Date(t).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
function ago(ms) { const m = Math.round((Date.now() - ms) / 60000); if (m < 1) return 'только что'; if (m < 60) return m + ' мин назад'; const h = Math.floor(m / 60); if (h < 48) return h + ' ч ' + (m % 60) + ' мин назад'; return Math.floor(h / 24) + ' дн назад'; }
const TYPE_RU = { breakout: 'Пробой', bounce: 'Отскок', pullback: 'Откат', smc: 'SMC' };
const TF_RU = { '15m': '15м', '1h': '1ч', '4h': '4ч' };
const RES_RU = { TP2: 'TP2 ✓', TP1: 'TP1', 'TP1+BE': 'TP1 + БУ', BE: 'Безубыток', SL: 'Стоп', LIQ: 'Ликвидация' };
const stars = n => '★'.repeat(n) + '<span class="dim">' + '★'.repeat(5 - n) + '</span>';
const dirN = p => p.dir === 'long' ? 1 : -1;

const S = { st: null, px: {}, range: 0, histN: 30, loadedAt: 0 };

async function getState(u, hdr) {
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 12000);
  try { const r = await fetch(u, { cache: 'no-store', signal: ac.signal, headers: hdr || {} }); if (!r.ok) throw new Error(r.status); return await r.json(); } finally { clearTimeout(tm); }
}
const API = 'https://api.github.com/repos/petraballas/paper-trades/contents/state.json?ref=data';
let apiAt = 0;
async function loadState() {
  // same-origin copy (deployed by the bot every run) and raw branch copy — take the fresher one
  const got = await Promise.allSettled([getState(DATA[1] + '?t=' + Date.now()), getState(DATA[0] + '?t=' + Date.now())]);
  let j = null; for (const g of got) if (g.status === 'fulfilled' && g.value && (!j || (g.value.lastRun || 0) > (j.lastRun || 0))) j = g.value;
  if ((!j || Date.now() - (j.lastRun || 0) > 2.5 * 6e4) && Date.now() - apiAt > 3 * 6e4) { // raw CDN caches ~5 min → GitHub API for fresher data (60 req/h limit → max every 3 min)
    apiAt = Date.now(); try { const k = await getState(API + '&t=' + Date.now()); const v = JSON.parse(decodeURIComponent(escape(atob(k.content.replace(/\s/g, ''))))); if (!j || (v.lastRun || 0) > (j.lastRun || 0)) j = v; } catch (e) { }
  }
  if (j && (!S.st || (j.lastRun || 0) >= (S.st.lastRun || 0))) S.st = j;
  if (S.st) { S.loadedAt = Date.now(); render(); syncLive(); }
  else { $('#botSt').textContent = 'нет данных бота — повторяю…'; render(); }
}

/* ---------- derived ---------- */
const lastPx = p => S.px[p.base] != null ? S.px[p.base] : p.last;
const upnl = p => { const l = lastPx(p); return l == null ? 0 : p.qty * (l - p.fill) * dirN(p); };
function liveEquity() { const st = S.st; if (!st) return null; return st.balance + st.positions.reduce((s, p) => s + upnl(p), 0); }
function curve() {
  const st = S.st; if (!st) return [];
  const pts = (st.equity || []).map(x => ({ t: x.t, e: x.e }));
  if (!pts.length || pts[0].t > st.created) pts.unshift({ t: st.created, e: START });
  pts.push({ t: Date.now(), e: liveEquity() }); return pts;
}
function maxDD(pts) { let pk = -Infinity, dd = 0, ddAbs = 0; for (const p of pts) { pk = Math.max(pk, p.e); const d = (pk - p.e) / pk; if (d > dd) { dd = d; ddAbs = pk - p.e; } } return { dd: dd * 100, abs: ddAbs }; }

/* ---------- render ---------- */
function setTxt(id, v, c) { const el = $(id); if (!el) return; el.innerHTML = v; if (c !== undefined) el.className = el.className.replace(/\b(up|down|mut)\b/g, '').trim() + ' ' + c; }
function render() {
  const st = S.st;
  if (!st) { ['#open', '#pend'].forEach(id => $(id).innerHTML = '<div class="empty glass">Данных пока нет — бот запустится в ближайшие минуты.</div>'); return; }
  $('#botSt').textContent = 'бот: ' + (st.lastRun ? ago(st.lastRun) : '—') + (st.source ? ' · данные ' + st.source : '') + ' · запусков ' + (st.runs || 0);
  renderKpis(); renderOpen(); renderPend(); renderHist(); drawCurve();
}
function renderKpis() {
  const st = S.st, eq = liveEquity(), tot = eq - START;
  setTxt('#kEq', usd(eq));
  setTxt('#kPnl', usd(tot, 1) + ' (' + pct(tot / START * 100) + ') за всё время', cls(tot));
  const d0 = new Date(); d0.setHours(0, 0, 0, 0); const pts = curve(); let base = START;
  for (const p of pts) { if (p.t <= d0.getTime()) base = p.e; else break; }
  const td = eq - base; setTxt('#kToday', usd(td, 1), cls(td));
  setTxt('#kBal', usd(st.balance));
  const used = st.positions.reduce((s, p) => s + (p.margin || 0), 0) + st.pending.reduce((s, o) => s + (o.margin || 0), 0);
  setTxt('#kFree', usd(eq - used)); setTxt('#kUsed', 'в позициях ' + usd(used));
  const cl = st.closed || [], w = cl.filter(t => t.pnl > 0), l = cl.filter(t => t.pnl <= 0);
  setTxt('#kWr', cl.length ? (w.length / cl.length * 100).toFixed(0) + '%' : '—'); setTxt('#kWl', w.length + ' плюс / ' + l.length + ' минус');
  const gw = w.reduce((s, t) => s + t.pnl, 0), gl = -l.reduce((s, t) => s + t.pnl, 0);
  setTxt('#kPf', !cl.length ? '—' : gl > 0 ? (gw / gl).toFixed(2) : gw > 0 ? '∞' : '—', !cl.length ? 'mut' : gw >= gl ? 'up' : 'down');
  setTxt('#kAvg', cl.length ? 'в среднем ' + usd((gw - gl) / cl.length, 1) : '');
  const dd = maxDD(pts); setTxt('#kDd', dd.dd ? '−' + dd.dd.toFixed(1) + '%' : '0%'); setTxt('#kDd2', dd.abs ? usd(-dd.abs) : '');
  setTxt('#kN', String(cl.length)); setTxt('#kOpen', st.positions.length + ' открыто · ' + st.pending.length + ' ждут');
}
function bar(p, l) { // SL ... entry ... TP2 position bar
  const lo = Math.min(p.sl0 || p.sl, p.tp2, l), hi = Math.max(p.sl0 || p.sl, p.tp2, l), x = v => ((v - lo) / (hi - lo || 1) * 100).toFixed(1);
  const L = p.dir === 'long', e = x(p.fill || p.entry), c = x(l);
  const [a, b] = [Math.min(e, c), Math.max(e, c)], good = (l - (p.fill || p.entry)) * dirN(p) >= 0;
  return `<div class="bar"><i style="left:${a}%;width:${Math.max(1, b - a)}%;background:${good ? 'var(--green)' : 'var(--red)'}"></i><i style="left:${x(p.tp1)}%;width:2px;background:#fff6"></i><i style="left:${e}%;width:2px;background:#fff"></i></div>`;
}
function posCard(p) {
  const l = lastPx(p), u = upnl(p), roe = p.margin ? u / p.margin * 100 : 0, L = p.dir === 'long';
  const st = p.tp1Hit ? '<span class="tag ok">TP1 ✓ · стоп в БУ</span>' : '';
  return `<div class="pos glass" data-id="${p.id}">
    <div class="hd"><span class="sym">${esc(p.base)}</span><span class="tag ${p.dir}">${L ? 'Лонг' : 'Шорт'} ${p.lev || 20}x</span>${p.riskPct ? `<span class="tag">риск ${p.riskPct}%</span>` : ''}<span class="tag">${TYPE_RU[p.type] || esc(p.type)} · ${TF_RU[p.tf] || esc(p.tf)}</span><span class="stars">${stars(p.strength)}</span>${st}
      <div class="pnl ${cls(u)}" data-u="${p.id}">${usd(u, 1)}<small>${pct(roe, 1)} ROE</small></div></div>
    <div class="kv">
      <div><span>Вход</span>${fmtP(p.fill)}</div><div><span>Цена</span><b class="px" data-px="${esc(p.base)}">${fmtP(l)}</b></div>
      <div><span>Объём</span>${usd(p.qty * p.fill)}</div><div><span>Маржа</span>${usd(p.margin)}</div>
      <div><span>Стоп${p.be ? ' (БУ)' : ''}</span><b class="down">${fmtP(p.sl)}</b>${p.be ? `<div class="x">${fmtP(p.sl0)}</div>` : ''}</div>
      <div><span>TP1 · 50%</span><b class="up">${fmtP(p.tp1)}</b></div><div><span>TP2</span><b class="up">${fmtP(p.tp2)}</b></div>
      <div><span>Ликвидация</span>${fmtP(p.liq)}</div>
    </div>${bar(p, l)}
    ${p.sizeWhy ? `<div class="why"><b>⚙ ${esc(p.sizeWhy)}</b></div>` : ''}<div class="why">Открыта ${dt(p.filledAt)} · риск ${usd(p.risk)} · ${esc(p.why || '')}</div></div>`;
}
function renderOpen() {
  const a = S.st.positions || []; $('#cOpen').textContent = a.length;
  $('#open').innerHTML = a.length ? a.map(posCard).join('') : '<div class="empty glass">Сейчас нет открытых позиций — бот ждёт сигналов от 4★.</div>';
}
function renderPend() {
  const a = S.st.pending || []; $('#cPend').textContent = a.length;
  $('#pend').innerHTML = a.length ? a.map(o => { const l = lastPx(o), d = l ? (o.entry / l - 1) * 100 : null; return `<div class="pos glass">
    <div class="hd"><span class="sym">${esc(o.base)}</span><span class="tag ${o.dir}">${o.dir === 'long' ? 'Лонг' : 'Шорт'} лимит ${o.lev || 20}x</span>${o.riskPct ? `<span class="tag">риск ${o.riskPct}%</span>` : ''}<span class="tag">${TYPE_RU[o.type] || ''} · ${TF_RU[o.tf] || ''}</span><span class="stars">${stars(o.strength)}</span>
    <div class="pnl mut" style="font-size:14px">до ${dt(o.expires)}<small>до входа ${d == null ? '—' : pct(d)}</small></div></div>
    <div class="kv"><div><span>Вход</span>${fmtP(o.entry)}</div><div><span>Цена</span><b class="px" data-px="${esc(o.base)}">${fmtP(l)}</b></div><div><span>Стоп</span><b class="down">${fmtP(o.sl)}</b></div><div><span>TP1 / TP2</span><b class="up">${fmtP(o.tp1)}</b> / <b class="up">${fmtP(o.tp2)}</b></div></div>
    ${o.sizeWhy ? `<div class="why"><b>⚙ ${esc(o.sizeWhy)}</b></div>` : ''}<div class="why">Создан ${dt(o.createdAt)} · ${esc(o.why || '')}</div></div>`; }).join('') : '<div class="empty glass">Нет отложенных ордеров.</div>';
}
function renderHist() {
  const a = S.st.closed || []; $('#cHist').textContent = a.length;
  const rows = a.slice(0, S.histN).map(t => { const R = t.risk ? t.pnl / t.risk : null, rk = (t.result || '').replace('+', '');
    return `<tr><td>${dt(t.closedAt)}</td><td><b>${esc(t.base)}</b> <span class="${t.dir === 'long' ? 'up' : 'down'}">${t.dir === 'long' ? '↑' : '↓'}</span></td><td class="hm mut">${TYPE_RU[t.type] || ''} ${TF_RU[t.tf] || ''} ${'★'.repeat(t.strength || 0)}</td>
    <td><span class="res ${rk}">${RES_RU[t.result] || esc(t.result)}</span></td><td class="r ${cls(t.pnl)}"><b>${usd(t.pnl, 1)}</b></td><td class="r hm ${cls(R)}">${R == null ? '—' : (R > 0 ? '+' : '') + R.toFixed(2) + 'R'}</td></tr>`; }).join('');
  $('#hist tbody').innerHTML = rows || '<tr><td colspan="6" class="mut" style="text-align:center;padding:18px">Закрытых сделок пока нет</td></tr>';
  let m = $('#moreH'); if (a.length > S.histN) { if (!m) { m = document.createElement('button'); m.id = 'moreH'; m.className = 'more'; m.textContent = 'Показать ещё'; m.onclick = () => { S.histN += 50; renderHist(); }; $('.tblw').after(m); } } else if (m) m.remove();
}
function drawCurve() {
  const cv = $('#eqc'); if (!cv) return; const r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1; cv.width = r.width * d; cv.height = r.height * d;
  const x = cv.getContext('2d'); x.setTransform(d, 0, 0, d, 0, 0); const W = r.width, H = r.height; x.clearRect(0, 0, W, H);
  let pts = curve(); if (S.range) { const c = Date.now() - S.range * 864e5; const before = pts.filter(p => p.t < c).pop(); pts = pts.filter(p => p.t >= c); if (before) pts.unshift({ t: c, e: before.e }); }
  if (pts.length < 2) pts = [{ t: Date.now() - 36e5, e: pts[0] ? pts[0].e : START }, { t: Date.now(), e: pts[0] ? pts[0].e : START }];
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t; let lo = Math.min(...pts.map(p => p.e), START), hi = Math.max(...pts.map(p => p.e), START); const pad = (hi - lo) * 0.12 || 5; lo -= pad; hi += pad;
  const X = t => 4 + (t - t0) / (t1 - t0 || 1) * (W - 8), Y = v => 8 + (hi - v) / (hi - lo) * (H - 24);
  x.strokeStyle = 'rgba(255,255,255,.12)'; x.setLineDash([4, 5]); x.lineWidth = 1; x.beginPath(); x.moveTo(0, Y(START)); x.lineTo(W, Y(START)); x.stroke(); x.setLineDash([]);
  x.fillStyle = '#6b7399'; x.font = '11px -apple-system,Inter,sans-serif'; x.fillText('$' + START, 6, Y(START) - 4);
  const end = pts[pts.length - 1].e, col = end >= START ? '61,220,151' : '255,94,122';
  const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, `rgba(${col},.28)`); g.addColorStop(1, `rgba(${col},0)`);
  x.beginPath(); pts.forEach((p, i) => i ? x.lineTo(X(p.t), Y(p.e)) : x.moveTo(X(p.t), Y(p.e))); x.lineTo(X(t1), H); x.lineTo(X(t0), H); x.closePath(); x.fillStyle = g; x.fill();
  x.beginPath(); pts.forEach((p, i) => i ? x.lineTo(X(p.t), Y(p.e)) : x.moveTo(X(p.t), Y(p.e))); x.strokeStyle = `rgb(${col})`; x.lineWidth = 2; x.stroke();
  x.fillStyle = '#6b7399'; x.fillText(dt(t0), 6, H - 3); const s = dt(t1); x.fillText(s, W - x.measureText(s).width - 6, H - 3);
}

/* ---------- live prices (WebSocket Bybit → OKX → Gate, like the board) ---------- */
const now = () => Math.floor(Date.now() / 1000);
const chunk = (a, n) => a.reduce((r, x, i) => (i % n ? r[r.length - 1].push(x) : r.push([x]), r), []);
const WSP = {
  bybit: { name: 'Bybit', url: 'wss://stream.bybit.com/v5/public/linear', sym: b => b + 'USDT', subs: ids => chunk(ids.map(i => 'tickers.' + i), 10).map(a => ({ op: 'subscribe', args: a })), ping: () => ({ op: 'ping' }),
    parse: m => m.topic && m.data && m.data.symbol && m.data.lastPrice ? [{ id: m.data.symbol, last: m.data.lastPrice }] : null },
  okx: { name: 'OKX', url: 'wss://ws.okx.com/ws/v5/public', sym: b => b + '-USDT-SWAP', subs: ids => chunk(ids.map(i => ({ channel: 'tickers', instId: i })), 20).map(a => ({ op: 'subscribe', args: a })), ping: () => 'ping',
    parse: m => m.data && m.arg && m.arg.channel === 'tickers' ? m.data.map(d => ({ id: d.instId, last: d.last })) : null },
  gate: { name: 'Gate', url: 'wss://fx-ws.gateio.ws/v4/ws/usdt', sym: b => b + '_USDT', subs: ids => [{ time: now(), channel: 'futures.tickers', event: 'subscribe', payload: ids }], ping: () => ({ time: now(), channel: 'futures.ping' }),
    parse: m => m.channel === 'futures.tickers' && m.event === 'update' && Array.isArray(m.result) ? m.result.map(d => ({ id: d.contract, last: d.last })) : null },
};
const ORDER = ['bybit', 'okx', 'gate'];
const LIVE = { ws: null, prov: null, last: 0, key: '', tried: [], pingT: null, gen: 0 };
const liveOk = () => LIVE.ws && Date.now() - LIVE.last < 25e3;
const watchList = () => S.st ? [...new Set([...S.st.positions, ...S.st.pending].map(p => p.base))].sort() : [];
function syncLive() { const k = watchList().join(','); if (k !== LIVE.key) startLive(); }
function stopLive() { LIVE.gen++; clearInterval(LIVE.pingT); if (LIVE.ws) { try { LIVE.ws.onclose = null; LIVE.ws.close(); } catch (e) { } } LIVE.ws = null; }
function startLive(skip) {
  const bases = watchList(); LIVE.key = bases.join(',');
  if (!bases.length || typeof WebSocket === 'undefined') { stopLive(); setPill(); return; }
  if (skip && LIVE.prov) LIVE.tried.push(LIVE.prov); else if (!skip) LIVE.tried = [];
  let k = ORDER.find(x => !LIVE.tried.includes(x)); if (!k) { LIVE.tried = []; k = ORDER[0]; }
  stopLive(); const gen = LIVE.gen, W = WSP[k]; LIVE.prov = k; LIVE.last = 0;
  const map = {}; bases.forEach(b => map[W.sym(b)] = b);
  let ws; try { ws = new WebSocket(W.url); } catch (e) { return; } LIVE.ws = ws;
  ws.onopen = () => { if (gen !== LIVE.gen) return; W.subs(Object.keys(map)).forEach(m => ws.send(JSON.stringify(m))); LIVE.pingT = setInterval(() => { try { const p = W.ping(); ws.send(typeof p === 'string' ? p : JSON.stringify(p)); } catch (e) { } }, 18e3); };
  ws.onmessage = e => { if (gen !== LIVE.gen || e.data === 'pong') return; let m; try { m = JSON.parse(e.data); } catch (x) { return; } const t = W.parse(m); if (t) t.forEach(x => tick(map[x.id], +x.last)); };
  ws.onerror = () => { };
  ws.onclose = () => { if (gen !== LIVE.gen) return; const quick = !LIVE.last; LIVE.ws = null; setPill(); setTimeout(() => { if (gen === LIVE.gen) startLive(quick); }, quick ? 500 : 3000); };
  setTimeout(() => { if (gen === LIVE.gen && !LIVE.last) startLive(true); }, 8000);
  setPill();
}
const dirty = new Set();
function tick(base, p) {
  if (!base || !isFinite(p) || p <= 0) return;
  const ref = S.px[base] != null ? S.px[base] : ([...S.st.positions, ...S.st.pending].find(x => x.base === base) || {}).last;
  if (ref && Math.abs(p / ref - 1) > 0.25) return; // symbol mismatch guard (e.g. 1000x contracts)
  S.px[base] = p; LIVE.last = Date.now(); dirty.add(base);
}
function setPill() { const el = $('#live'); if (!el) return; if (!watchList().length) { el.className = 'pill live'; el.textContent = '○ нет позиций'; return; }
  if (liveOk()) { el.className = 'pill live on'; el.textContent = '● LIVE · ' + WSP[LIVE.prov].name; } else { el.className = 'pill live'; el.textContent = '○ подключение…'; } }
let prevPx = {};
function frame() {
  if (!S.st || !dirty.size) return;
  document.querySelectorAll('[data-px]').forEach(el => { const b = el.dataset.px; if (!dirty.has(b)) return; const p = S.px[b], o = prevPx[b];
    el.textContent = fmtP(p); if (o != null && p !== o) { el.classList.remove('tk-up', 'tk-dn'); void el.offsetWidth; el.classList.add(p > o ? 'tk-up' : 'tk-dn'); } });
  S.st.positions.forEach(p => { if (!dirty.has(p.base)) return; const el = document.querySelector(`[data-u="${p.id}"]`); if (!el) return; const u = upnl(p), roe = p.margin ? u / p.margin * 100 : 0;
    el.className = 'pnl ' + cls(u); el.innerHTML = usd(u, 1) + '<small>' + pct(roe, 1) + ' ROE</small>'; });
  if (S.st.pending.some(o => dirty.has(o.base))) renderPend();
  dirty.forEach(b => prevPx[b] = S.px[b]); dirty.clear();
  renderKpis(); drawCurve(); setPill();
}

/* ---------- boot ---------- */
document.querySelectorAll('#rng button').forEach(b => b.onclick = () => { document.querySelectorAll('#rng button').forEach(x => x.classList.toggle('on', x === b)); S.range = +b.dataset.r; drawCurve(); });
window.addEventListener('resize', () => drawCurve());
document.addEventListener('visibilitychange', () => { if (!document.hidden) { loadState(); if (!liveOk()) startLive(); } });
loadState();
setInterval(() => { if (!document.hidden) loadState(); }, 30e3);
setInterval(frame, 1000);
setInterval(() => { if (!document.hidden && watchList().length && !liveOk() && LIVE.ws === null) startLive(); setPill(); if (S.st) $('#botSt').textContent = 'бот: ' + ago(S.st.lastRun) + (S.st.source ? ' · данные ' + S.st.source : '') + ' · запусков ' + (S.st.runs || 0); }, 10e3);
