/**
 * 【桩·stub】modules/martin.js 的替身（B 方自测 / A 缺件时兜底）
 *
 * ⚠️ 不是交付物。语义严格镜像 A 已交付的 modules/martin.js（契约 §2.3）：
 *    · levels[].idx 从 0 开始；篮子自带 stopUsd / equityAtOpen / atrAtOpen
 *    · sizeForMargin：张数不足 minSz → 返回 0；newBasket 同理返回 null
 *    · onPrice 判定顺序 trend_flip → liquidation → stop_loss → time_stop → take_profit → add
 *    · 事件类型额外含 liquidation（平仓）与 add_blocked（不加仓）
 *    · 导出面板/调度器要用的辅助量（avgPrice/takeProfitPrice/stopPrice/basketCount/…）
 */
const DEFAULT_POLICY = Object.freeze({
  firstMarginPct: 1, leverage: 3, marginMode: 'isolated', spacingMode: 'atr', spacingAtrMult: 1.0,
  spacingPct: 0.8, multiplier: 1.5, maxLevels: 6, takeProfitPct: 0.8, hardStopPct: 4,
  timeStopHours: 48, cooldownHours: 4, maxBaskets: 3, dailyLossPct: 6, maxFundingAbs: 0.001,
  minAtrPct: 0.4, maxAtrPct: 8, mmr: 0.005, blackSwanPct: 5,
});
const num = (v, d) => { const x = Number(v); return Number.isFinite(x) ? x : (d === undefined ? 0 : d); };
const round = (v, n = 10) => Number(num(v).toFixed(n));
function normPolicy(p) {
  const out = { ...DEFAULT_POLICY, ...(p || {}) };
  for (const k of Object.keys(DEFAULT_POLICY)) if (typeof DEFAULT_POLICY[k] === 'number') out[k] = num(out[k], DEFAULT_POLICY[k]);
  return out;
}
function floorToStep(value, step) {
  const s = num(step);
  if (!(s > 0)) return round(value);
  return round(Math.floor((num(value) + s * 1e-9) / s) * s);
}
function sizeForMargin({ marginUsd, leverage, price, ctVal, lotSz, minSz }) {
  const m = num(marginUsd), lv = num(leverage), px = num(price), cv = num(ctVal);
  if (!(m > 0) || !(lv > 0) || !(px > 0) || !(cv > 0)) return 0;
  const step = num(lotSz) > 0 ? num(lotSz) : 1;
  const contracts = floorToStep((m * lv) / (cv * px), step);
  const min = num(minSz) > 0 ? num(minSz) : step;
  return contracts < min ? 0 : contracts;
}
const dirOf = (b) => (b && b.side === 'short' ? -1 : 1);
function avgPrice(b) { const lv = (b && b.levels) || []; let c = 0, s = 0; for (const l of lv) { c += num(l.contracts); s += num(l.contracts) * num(l.price); } return c > 0 ? s / c : 0; }
function totalContracts(b) { return ((b && b.levels) || []).reduce((a, l) => a + num(l.contracts), 0); }
function totalMargin(b) { return ((b && b.levels) || []).reduce((a, l) => a + num(l.marginUsd), 0); }
function basketPnl(b, price) {
  const avg = avgPrice(b), contracts = totalContracts(b), ctVal = num(b && b.ctVal, 0), marginUsd = totalMargin(b), px = num(price);
  const qty = ctVal * contracts, upl = (px - avg) * qty * dirOf(b);
  return { avgPx: round(avg, 10), contracts: round(contracts, 10), qty: round(qty, 10), notionalUsd: round(qty * px, 6), marginUsd: round(marginUsd, 6), upl: round(upl, 6), uplPct: marginUsd > 0 ? round((upl / marginUsd) * 100, 4) : 0 };
}
function takeProfitPrice(b) { const p = normPolicy(b && b.policy), avg = avgPrice(b); return avg > 0 ? round(avg * (1 + (p.takeProfitPct / 100) * dirOf(b)), 10) : null; }
function stopPrice(b) {
  const avg = avgPrice(b), qty = num(b && b.ctVal) * totalContracts(b), stopUsd = num(b && b.stopUsd);
  if (!(avg > 0) || !(qty > 0) || !(stopUsd > 0)) return null;
  const px = avg - (stopUsd / qty) * dirOf(b);
  return px > 0 ? round(px, 10) : 0;
}
function liquidationPrice(basket, mmr) {
  const avg = avgPrice(basket), qty = num(basket && basket.ctVal) * totalContracts(basket), marginUsd = totalMargin(basket);
  const p = normPolicy(basket && basket.policy);
  const m = num(mmr, num(p.mmr, 0.005));
  if (!(avg > 0) || !(qty > 0) || !(marginUsd > 0)) return null;
  const notional = qty * avg;
  const px = avg - ((marginUsd - m * notional) / qty) * dirOf(basket);
  return Number.isFinite(px) && px > 0 ? round(px, 10) : 0;
}
function nextAddPrice(basket, atr) {
  if (!basket) return null;
  const p = normPolicy(basket.policy), lv = basket.levels || [];
  if (!lv.length || lv.length >= p.maxLevels) return null;
  const last = num(lv[lv.length - 1].price);
  let spacing = p.spacingMode === 'pct' ? (last * p.spacingPct) / 100 : num(atr) * p.spacingAtrMult;
  if (!(last > 0) || !(spacing > 0)) return null;
  const px = last - spacing * dirOf(basket);
  return px > 0 ? round(px, 10) : null;
}
function levelMargin(basket, idx) { const p = normPolicy(basket && basket.policy); return round((num(basket && basket.equityAtOpen, 100) * p.firstMarginPct / 100) * Math.pow(p.multiplier, idx), 6); }
function cumulativeMargin(basket, idx) { let s = 0; for (let k = 0; k <= idx; k++) s += levelMargin(basket, k); return round(s, 6); }
function basketCount(o) { return o === null || o === undefined ? 0 : (typeof o === 'number' ? o : (Array.isArray(o) ? o.length : 0)); }
function basketSectors(o) { return Array.isArray(o) ? o.map((b) => (typeof b === 'string' ? b : b && b.sector)).filter(Boolean) : []; }
function basketInstIds(o) { return Array.isArray(o) ? o.map((b) => (typeof b === 'string' ? b : b && b.instId)).filter(Boolean) : []; }

function newBasket({ instId, side, sector, price, atr, policy, instrument, equity, ts, regime, id }) {
  const p = normPolicy(policy), ins = instrument || {};
  const ctVal = num(ins.ctVal, 1) || 1, lotSz = num(ins.lotSz, 0), minSz = num(ins.minSz, 0), maxLever = num(ins.maxLever, 0);
  const lev = maxLever > 0 ? Math.min(p.leverage, maxLever) : p.leverage;
  const eq = num(equity), px = num(price);
  if (!(px > 0) || !(eq > 0)) return null;
  const firstMarginUsd = (eq * p.firstMarginPct) / 100;
  const contracts = sizeForMargin({ marginUsd: firstMarginUsd, leverage: lev, price: px, ctVal, lotSz, minSz });
  if (!contracts) return null;
  const now = num(ts) || Date.now();
  return {
    id: id || `${instId}-${side}-${now}`, instId, side, sector: sector || 'Other', openedAt: now,
    regimeAtOpen: regime && regime.regime ? regime.regime : (typeof regime === 'string' ? regime : null),
    policy: { ...p, leverage: lev }, ctVal, lotSz, minSz, maxLever,
    atrAtOpen: num(atr) || null, equityAtOpen: eq, stopUsd: round((eq * p.hardStopPct) / 100, 6),
    firstMarginUsd: round(firstMarginUsd, 6),
    levels: [{ idx: 0, ts: now, price: px, contracts, marginUsd: round(firstMarginUsd, 6), reason: 'entry' }],
    closed: false, closedAt: null, closeReason: null, realizedPnl: 0, feesUsd: 0, fundingUsd: 0,
  };
}
function shouldOpen({ policy, regime, funding, atrPct, equity, openBaskets, sector, todayPnlPct, barChangePct }) {
  const p = normPolicy(policy);
  if (!(num(equity) > 0)) return { ok: false, reason: '权益为 0 或负，不能开仓' };
  if (typeof todayPnlPct === 'number' && todayPnlPct <= -p.dailyLossPct) return { ok: false, reason: `当日亏损 ${todayPnlPct.toFixed(2)}% 触及熔断 −${p.dailyLossPct}%` };
  if (basketCount(openBaskets) >= p.maxBaskets) return { ok: false, reason: `篮子数已达上限 ${p.maxBaskets}` };
  if (sector && basketSectors(openBaskets).includes(sector)) return { ok: false, reason: `板块 ${sector} 已有篮子（相关性去重）` };
  const f = num(funding);
  if (Math.abs(f) > p.maxFundingAbs) return { ok: false, reason: `资金费率 ${(f * 100).toFixed(4)}% 超限` };
  if (typeof atrPct === 'number' && atrPct !== null) {
    if (atrPct < p.minAtrPct) return { ok: false, reason: `ATR% ${atrPct.toFixed(2)} 过低（<${p.minAtrPct}）` };
    if (atrPct > p.maxAtrPct) return { ok: false, reason: `ATR% ${atrPct.toFixed(2)} 过高（>${p.maxAtrPct}）` };
  }
  if (typeof barChangePct === 'number' && barChangePct <= -p.blackSwanPct) return { ok: false, reason: `黑天鹅闸门：单根 1H ${barChangePct.toFixed(2)}%` };
  const rg = regime || {}, allow = Array.isArray(rg.allow) ? rg.allow : [];
  if (!allow.length) return { ok: false, reason: `状态 ${rg.regime || 'unknown'} 不开新篮子` };
  if (allow.length > 1) {
    const px = num(rg.price), e50 = num(rg.ema50);
    return { ok: true, side: px > 0 && e50 > 0 && px < e50 ? 'long' : 'short', reason: 'ok' };
  }
  return { ok: true, side: allow[0], reason: 'ok' };
}
function closeBasket(basket, price, ts, reason) {
  const pnl = basketPnl(basket, price);
  basket.closed = true; basket.closedAt = ts; basket.closeReason = reason; basket.closePrice = round(num(price), 10);
  basket.realizedPnl = round(num(basket.realizedPnl) + pnl.upl, 6);
  basket.finalUpl = pnl.upl; basket.finalUplPct = pnl.uplPct;
  return pnl;
}
function onPrice(basket, ctx = {}) {
  const events = [];
  if (!basket || basket.closed) return { events, basket };
  const p = normPolicy(basket.policy), px = num(ctx.price), ts = num(ctx.ts) || Date.now();
  if (!(px > 0)) return { events, basket };
  const dir = dirOf(basket), rg = ctx.regime || {};
  const evBase = () => ({ instId: basket.instId, side: basket.side, ts, price: round(px, 10), levels: (basket.levels || []).length });
  const opposite = (rg.regime === 'trend_up' && basket.side === 'short') || (rg.regime === 'trend_down' && basket.side === 'long');
  if (opposite) {
    const pnl = closeBasket(basket, px, ts, 'trend_flip');
    return { events: [{ type: 'trend_flip', ...evBase(), pnlUsd: pnl.upl, uplPct: pnl.uplPct }], basket };
  }
  const lip = liquidationPrice(basket);
  if (lip !== null && ((dir > 0 && px <= lip) || (dir < 0 && px >= lip))) {
    const pnl = closeBasket(basket, px, ts, 'liquidation');
    return { events: [{ type: 'liquidation', ...evBase(), liqPx: lip, pnlUsd: pnl.upl, uplPct: pnl.uplPct }], basket };
  }
  const sl = stopPrice(basket);
  if (sl !== null && ((dir > 0 && px <= sl) || (dir < 0 && px >= sl))) {
    const pnl = closeBasket(basket, px, ts, 'stop_loss');
    return { events: [{ type: 'stop_loss', ...evBase(), stopPx: sl, pnlUsd: pnl.upl, uplPct: pnl.uplPct }], basket };
  }
  if (p.timeStopHours > 0 && ts - num(basket.openedAt) >= p.timeStopHours * 3600e3) {
    const pnl = closeBasket(basket, px, ts, 'time_stop');
    return { events: [{ type: 'time_stop', ...evBase(), hours: round((ts - basket.openedAt) / 3600e3, 2), pnlUsd: pnl.upl }], basket };
  }
  const tp = takeProfitPrice(basket);
  if (tp !== null && ((dir > 0 && px >= tp) || (dir < 0 && px <= tp))) {
    const pnl = closeBasket(basket, px, ts, 'take_profit');
    return { events: [{ type: 'take_profit', ...evBase(), tpPx: tp, pnlUsd: pnl.upl, uplPct: pnl.uplPct }], basket };
  }
  const addPx = nextAddPrice(basket, ctx.atr);
  if (addPx !== null && ((dir > 0 && px <= addPx) || (dir < 0 && px >= addPx))) {
    const idx = (basket.levels || []).length;
    const marginUsd = levelMargin(basket, idx);
    const contracts = sizeForMargin({ marginUsd, leverage: num(basket.policy.leverage, 1), price: addPx, ctVal: basket.ctVal, lotSz: basket.lotSz, minSz: basket.minSz });
    if (!contracts) return { events: [{ type: 'add_blocked', ...evBase(), reason: `第 ${idx + 1} 层张数不足 minSz`, addPx }], basket };
    basket.levels.push({ idx, ts, price: round(addPx, 10), contracts, marginUsd: round(marginUsd, 6), reason: 'add' });
    const after = basketPnl(basket, px);
    return { events: [{ type: 'add', ...evBase(), levelIdx: idx, levelNo: idx + 1, addPx: round(addPx, 10), contracts, marginUsd: round(marginUsd, 6), avgPx: after.avgPx, uplPct: after.uplPct, totalMarginUsd: after.marginUsd }], basket };
  }
  return { events, basket };
}

module.exports = {
  DEFAULT_POLICY, normPolicy, floorToStep,
  sizeForMargin, nextAddPrice, basketPnl, liquidationPrice, shouldOpen, onPrice, newBasket,
  avgPrice, totalContracts, totalMargin, takeProfitPrice, stopPrice, levelMargin, cumulativeMargin,
  basketCount, basketSectors, basketInstIds, closeBasket, STUB: true,
};
