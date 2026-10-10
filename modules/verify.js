/*!
 * modules/verify.js - william-bot-1-core key engine logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-294CE7D4
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
/**
 * modules/verify.js —— 实盘验算核心（**只读**：不写 state、不下单、不碰其它模块的文件）
 *
 * 目的：把「回测里假设的东西」和「实盘真正成交的东西」并排摆出来，缺口在哪一目了然。
 *   · 成交滑点实测：引擎信号价/理论成交价 vs OKX 实际成交均价（VWAP）→ bps
 *   · 费用与资金费：OKX 成交明细（fills-history）与账单（account/bills）
 *   · 层数分布 / 满层率 / 持仓时长
 *   · 盈亏结构：胜率 / 单笔期望 / PF / 最大回撤 / 离场原因占比
 *   · 回测 vs 实盘：逐项并排 + 偏差 + 成本拖累
 *   · 样本量声明：< minTrades 笔平仓即「样本不足，结论不可用」
 *
 * 数据来源（全部只读）
 *   1) state（`MARTIN_STATE_PATH` 或 --state）：baskets[] / closed[] / events[] / curve[] / policy
 *   2) OKX：trade/fills-history（真实成交与手续费）、account/bills（资金费等）、account/positions
 *      —— 运行态直接调用（生产机上跑）或喂一份快照 JSON（本机跑，--okx-snapshot）
 *   3) 回测报告 data/backtest-martin-*.json（A 侧产物，只读）
 *
 * 口径约定（重要的都写在这里，避免事后扯皮）
 *   · `unfavBps(expected, fill, execSide)`：**不利为正**。买入成交价高于预期 → 正；
 *     卖出成交价低于预期 → 正。`execSide` 是「这笔成交的方向」（buy/sell），不是持仓方向。
 *   · 手续费：OKX fills/bills 里 `fee` 与 `pnl` 是负数表示支出；本模块统一换算成
 *     `feeUsd`（正数 = 成本）并在报告里标注符号。
 *   · 单边手续费 bps = |fee| / (fillSz × ctVal × fillPx) × 1e4。ctVal 取自 okx-data.instrument()
 *     或 state 篮子里的 ctVal；取不到时该笔不进 bps 统计（只进总额），并计入 `missingCtVal`。
 *   · 快照/证据的 `capturedAt` 必须写进报告；跑的是「哪个时点的账」不能含糊。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MIN_TRADES_DEFAULT = 20;        // < 该笔数 = 样本不足，结论不可用
const FILL_MATCH_WINDOW_MS = 900000;  // 引擎事件 ↔ OKX 成交的撮配时窗（15 分钟；原 3 分钟导致 46 笔未撮配）

/* ══ 数值工具（纯函数） ══════════════════════════════ */

const num = (v, d = 0) => { const x = Number(v); return Number.isFinite(x) ? x : d; };
const roundN = (v, n = 6) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(Number(v).toFixed(n)));
const isNum = (v) => Number.isFinite(Number(v)) && v !== null && v !== undefined && v !== '';
const sumBy = (arr, f) => (arr || []).reduce((a, x) => a + num(f(x)), 0);

function mean(arr) {
  const a = (arr || []).filter((x) => isNum(x)).map(Number);
  return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
}
function median(arr) {
  const a = (arr || []).filter((x) => isNum(x)).map(Number).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}
/** 分位数（线性插值，p ∈ 0~1） */
function percentile(arr, p) {
  const a = (arr || []).filter((x) => isNum(x)).map(Number).sort((x, y) => x - y);
  if (!a.length) return null;
  const idx = Math.min(a.length - 1, Math.max(0, (a.length - 1) * num(p)));
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

/* ══ 1. 滑点（纯函数） ══════════════════════════════ */

/**
 * 成交滑点（bps，**不利为正**）。
 * @param {number} expectedPx 信号价/理论成交价
 * @param {number} fillPx     实际成交价
 * @param {'buy'|'sell'} execSide 成交方向（buy=买、sell=卖）
 * @returns {number|null} null = 参数不足（价格非正 / execSide 非法）
 */
function unfavBps(expectedPx, fillPx, execSide) {
  const e = num(expectedPx, NaN), f = num(fillPx, NaN);
  if (!(e > 0) || !(f > 0)) return null;
  if (execSide !== 'buy' && execSide !== 'sell') return null;
  const dir = execSide === 'sell' ? -1 : 1;
  return ((f - e) / e) * 10000 * dir;
}

/** 往返滑点（bps）：单边 × 2 —— 用于「开+平」一次完整交易的滑点成本。 */
function roundTripBps(sideBps) { return isNum(sideBps) ? Number(sideBps) * 2 : null; }

/** 持仓方向 → 成交方向 */
function execSideOf(basketSide, kind) {
  const isLong = basketSide === 'long';
  if (kind === 'exit') return isLong ? 'sell' : 'buy';
  return isLong ? 'buy' : 'sell';     // entry / add
}

/** 成交明细按 ordId 聚合成 VWAP（同一笔单可能被拆成多笔成交） */
function vwapByOrder(fills) {
  const g = new Map();
  for (const f of fills || []) {
    const key = f.ordId || `${f.instId}|${f.ts}|${f.fillPx}`;
    const cur = g.get(key) || { ordId: key, instId: f.instId, execSide: f.side, posSide: f.posSide, sz: 0, notional: 0, fee: 0, ts: num(f.fillTime || f.ts), fills: 0, idxPx: [] };
    const sz = Math.abs(num(f.fillSz)), px = num(f.fillPx), ctVal = num(f.__ctVal, 0);
    cur.sz += sz; cur.notional += ctVal > 0 ? sz * ctVal * px : 0; cur.fee += num(f.fee);
    cur.ts = Math.min(cur.ts || Infinity, num(f.fillTime || f.ts)); cur.fills++;
    if (isNum(f.fillIdxPx) && num(f.fillIdxPx) > 0) cur.idxPx.push(num(f.fillIdxPx));
    g.set(key, cur);
  }
  return [...g.values()].map((o) => ({
    ...o,
    fillPx: null,                                   // VWAP 需要 ctVal；无 ctVal 时退回简单均值
  })).map((o) => {
    const rows = (fills || []).filter((f) => (f.ordId || `${f.instId}|${f.ts}|${f.fillPx}`) === o.ordId);
    const szSum = rows.reduce((a, f) => a + Math.abs(num(f.fillSz)), 0);
    const pxAvg = szSum > 0 ? rows.reduce((a, f) => a + Math.abs(num(f.fillSz)) * num(f.fillPx), 0) / szSum : null;
    return { ...o, fillPx: roundN(pxAvg, 10), idxPxAvg: roundN(mean(o.idxPx), 10) };
  }).sort((a, b) => a.ts - b.ts);
}

/** 引擎事件 → 期望价与成交方向（引擎事件自带 side/price/fillPx/triggerPx）；非法/无价 → null */function expectedFromEvent(ev) {
  if (!ev || typeof ev !== 'object') return null;
  const d = (ev.data && typeof ev.data === 'object') ? ev.data : {};
  const t = ev.type;
  const closing = ['take_profit', 'stop_loss', 'time_stop', 'trend_flip', 'liquidation', 'risk_stop', 'manual_close'].includes(t);
  const opening = t === 'open' || t === 'add';
  if (!closing && !opening) return null;
  const px = closing
    ? (isNum(d.fillPx) ? num(d.fillPx) : num(d.triggerPx))
    : (isNum(d.price) ? num(d.price) : (isNum(d.addPx) ? num(d.addPx) : num(d.fillPx)));
  if (!(px > 0)) return null;
  const basketSide = d.side === 'long' || d.side === 'short' ? d.side : null;
  if (!basketSide) return null;
  return { kind: closing ? 'exit' : (t === 'open' ? 'open' : 'add'), expectedPx: px, basketSide, execSide: execSideOf(basketSide, closing ? 'exit' : 'entry'), instId: d.instId || ev.instId || null };
}

/**
 * 引擎事件 ↔ OKX 真实成交 撮配（同标的、时窗内、方向一致，一笔成交只用一次）
 * @returns {{pairs:Array, unmatchedEvents:Array, unmatchedFills:number, note:string}}
 */
function matchEventsToFills({ events, fills, windowMs = FILL_MATCH_WINDOW_MS } = {}) {
  const evs = (events || []).map((e) => ({ ev: e, exp: expectedFromEvent(e) })).filter((x) => x.exp && x.exp.instId);
  const orders = vwapByOrder(fills || []);
  const used = new Set();
  const pairs = [], unmatchedEvents = [];
  for (const { ev, exp } of evs.sort((a, b) => num(a.ev.ts) - num(b.ev.ts))) {
    const ts = num(ev.ts);
    let best = null, bestDt = Infinity;
    for (const o of orders) {
      if (used.has(o.ordId)) continue;
      if (o.instId !== exp.instId) continue;
      if (o.execSide !== exp.execSide) continue;
      const dt = Math.abs(num(o.ts) - ts);
      if (dt <= windowMs && dt < bestDt) { best = o; bestDt = dt; }
    }
    if (!best) { unmatchedEvents.push({ ts, type: ev.type, instId: exp.instId, expectedPx: exp.expectedPx }); continue; }
    used.add(best.ordId);
    const ctVal = num((fills || []).find((f) => f.ordId === best.ordId)?.__ctVal, 0);
    const notionalUsd = ctVal > 0 && best.fillPx > 0 ? best.sz * ctVal * best.fillPx : null;
    pairs.push({
      instId: exp.instId, kind: exp.kind, bundle: ev.type, basketSide: exp.basketSide, execSide: exp.execSide,
      ts, expectedPx: roundN(exp.expectedPx, 10), fillPx: best.fillPx, fillSz: roundN(best.sz, 10),
      ordId: best.ordId, fills: best.fills, dtMs: bestDt, idxPxAvg: best.idxPxAvg ?? null,
      ctVal: ctVal > 0 ? ctVal : null,
      notionalUsd: roundN(notionalUsd, 6),
      slipBps: roundN(unfavBps(exp.expectedPx, best.fillPx, exp.execSide), 4),
      vsIdxBps: roundN(unfavBps(best.idxPxAvg, best.fillPx, exp.execSide), 4),
    });
  }
  return {
    pairs, unmatchedEvents, unmatchedFills: orders.length - used.size,
    note: `撮配时窗 ±${windowMs / 1000}s；成交按 ordId 聚合为 VWAP`,
  };
}

/** 滑点汇总 */
function slipStats(pairs) {
  const rows = (pairs || []).filter((p) => isNum(p.slipBps));
  const vals = rows.map((p) => num(p.slipBps));
  const exits = rows.filter((p) => p.kind === 'exit').map((p) => num(p.slipBps));
  const weighted = (() => {
    const w = rows.filter((p) => isNum(p.notionalUsd) && num(p.notionalUsd) > 0);
    const tw = sumBy(w, (p) => p.notionalUsd);
    return tw > 0 ? sumBy(w, (p) => num(p.slipBps) * num(p.notionalUsd)) / tw : null;
  })();
  return {
    n: rows.length,
    avgBps: roundN(mean(vals), 4), medianBps: roundN(median(vals), 4),
    p90Bps: roundN(percentile(vals, 0.9), 4), minBps: roundN(vals.length ? Math.min(...vals) : null, 4),
    maxBps: roundN(vals.length ? Math.max(...vals) : null, 4),
    notionalWeightedBps: roundN(weighted, 4),
    totalNotionalUsd: roundN(sumBy(rows, (p) => p.notionalUsd), 4),
    nEntry: rows.length - exits.length, nExit: exits.length,
    roundTripBps: roundN(roundTripBps(mean(vals)), 4),
  };
}

/** `reconcile` 事件里的独立滑点估计：引擎计划均价 vs OKX 真实均价 */
function slipFromReconcile(events) {
  const rows = [];
  for (const e of events || []) {
    if (e.type !== 'reconcile') continue;
    const d = e.data || {};
    const before = num(d.before && d.before.avgPx, NaN), actual = num(d.actual && d.actual.avgPx, NaN);
    if (!(before > 0) || !(actual > 0)) continue;
    const basketSide = d.side === 'long' || d.side === 'short' ? d.side : null;
    if (!basketSide) continue;
    const execSide = execSideOf(basketSide, 'entry');
    rows.push({ instId: d.instId, ts: e.ts, expectedPx: roundN(before, 10), fillPx: roundN(actual, 10), slipBps: roundN(unfavBps(before, actual, execSide), 4) });
  }
  return { rows, stats: slipStats(rows) };
}

/* ══ 2. 费用与资金费（纯函数） ═══════════════════════ */

/**
 * 按「本机器人范围」过滤成交/账单：只看 state 里出现过的标的 + 首个篮子开仓时点之后。
 * 为什么要这一步：OKX 账户可能同时有别的手动/其它策略活动，全账户口径会把别人的手续费算到马丁头上。
 */
function filterByScope(rows, { instIds = null, fromTs = null, toTs = null, tsField = null } = {}) {
  // 语义区分：null/undefined = 不按标的过滤；**空集合 = 本机器人没碰过任何标的 → 什么都不属于它**
  const ids = instIds instanceof Set ? instIds : (Array.isArray(instIds) ? new Set(instIds) : null);
  return (rows || []).filter((r) => {
    if (ids && !ids.has(r.instId)) return false;
    const ts = num(tsField ? r[tsField] : (r.fillTime !== undefined ? r.fillTime : r.ts), 0);
    if (fromTs !== null && ts && ts < num(fromTs)) return false;
    if (toTs !== null && ts && ts > num(toTs)) return false;
    return true;
  });
}

/** state 里出现过的标的集合（本机器人碰过的品种） */
function botInstIds(state) {
  const s = new Set();
  for (const b of [...((state && state.baskets) || []), ...((state && state.closed) || [])]) if (b && b.instId) s.add(b.instId);
  for (const e of (state && state.events) || []) { const id = (e.data && e.data.instId) || e.instId; if (id) s.add(id); }
  return s;
}

/** 手续费统计：`fee` 负数为支出 → feeUsd 正数表示成本 */
function feeStats(fills, { ctValByInst = {} } = {}) {
  const rows = (fills || []).filter((f) => isNum(f.fee) && num(f.fee) !== 0);
  let missingCtVal = 0;
  const per = {};
  const bpsList = [];
  for (const f of rows) {
    // 只读：不动调用方的数组（ctVal 优先用明细上的标注，其次查规格表）
    const ctVal = num(f.__ctVal, 0) || num(ctValByInst[f.instId], 0);
    const notional = ctVal > 0 ? Math.abs(num(f.fillSz)) * ctVal * num(f.fillPx) : 0;
    const feeUsd = -num(f.fee);                       // OKX: 负=支出 → 取正=成本
    const k = f.instId || 'unknown';
    per[k] = per[k] || { instId: k, fills: 0, feeUsd: 0, notionalUsd: 0, bpsSum: 0, bpsN: 0 };
    per[k].fills++; per[k].feeUsd += feeUsd; per[k].notionalUsd += notional;
    if (notional > 0) { const b = (feeUsd / notional) * 10000; per[k].bpsSum += b; per[k].bpsN++; bpsList.push(b); }
    else missingCtVal++;
  }
  const list = Object.values(per).map((x) => ({ ...x, feeUsd: roundN(x.feeUsd, 6), notionalUsd: roundN(x.notionalUsd, 4), avgBps: x.bpsN ? roundN(x.bpsSum / x.bpsN, 4) : null }));
  return {
    n: rows.length, feeUsd: roundN(sumBy(rows, (f) => -num(f.fee)), 6),
    avgBps: roundN(mean(bpsList), 4), medianBps: roundN(median(bpsList), 4),
    byInstId: list, missingCtVal,
  };
}

/** 资金费统计（bills type=8）：pnl 负 = 支出 */
function fundingStats(bills) {
  const rows = (bills || []).filter((b) => String(b.type) === '8');
  const per = {};
  for (const b of rows) {
    const k = b.instId || 'unknown';
    per[k] = per[k] || { instId: k, entries: 0, fundingUsd: 0 };
    per[k].entries++; per[k].fundingUsd += num(b.pnl);
  }
  const list = Object.values(per).map((x) => ({ ...x, fundingUsd: roundN(x.fundingUsd, 6) }));
  return {
    n: rows.length, fundingUsd: roundN(sumBy(rows, (b) => num(b.pnl)), 6),
    byInstId: list,
    window: rows.length ? { from: new Date(Math.min(...rows.map((r) => num(r.ts)))).toISOString(), to: new Date(Math.max(...rows.map((r) => num(r.ts)))).toISOString() } : null,
  };
}

/* ══ 3. 层数 / 时长（纯函数） ═══════════════════════ */

function levelStats(baskets, { maxLevels = null } = {}) {
  const rows = baskets || [];
  const dist = {};
  for (const b of rows) {
    const n = (b.levels || []).length;
    dist[n] = (dist[n] || 0) + 1;
  }
  const counts = rows.map((b) => (b.levels || []).length);
  const cap = num(maxLevels, 0) || num(rows[0] && (rows[0].policy || {}).maxLevels, 0) || 6;
  const full = counts.filter((c) => c >= cap).length;
  const hours = rows.map((b) => (isNum(b.closedAt) && isNum(b.openedAt) ? (num(b.closedAt) - num(b.openedAt)) / 3600e3 : null));
  return {
    n: rows.length, avgLevels: roundN(mean(counts), 4), medianLevels: roundN(median(counts), 4),
    maxLevelsSeen: counts.length ? Math.max(...counts) : null,
    fullLevelCount: full, fullLevelRate: rows.length ? roundN((full / rows.length) * 100, 2) : null,
    distribution: dist,
    avgHours: roundN(mean(hours), 4), medianHours: roundN(median(hours), 4),
    maxHours: roundN(hours.filter(isNum).length ? Math.max(...hours.filter(isNum)) : null, 4),
  };
}

/* ══ 4. 盈亏结构（纯函数） ═══════════════════════════ */

/** 最大回撤（%）：以序列自身峰值为基准 */
function maxDrawdownPct(series) {
  const s = (series || []).map(Number).filter((x) => Number.isFinite(x));
  if (s.length < 2) return { pct: null, peak: null, trough: null, note: '序列不足 2 点' };
  let peak = s[0], worst = 0, peakAt = 0, worstAt = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] > peak) { peak = s[i]; peakAt = i; }
    const dd = peak > 0 ? ((s[i] - peak) / peak) * 100 : 0;
    if (dd < worst) { worst = dd; worstAt = i; }
  }
  return { pct: roundN(worst, 4), peak: peakAt, trough: worstAt, note: null };
}

function pnlStats(closed, { equity0 = null } = {}) {
  const rows = closed || [];
  const pnl = rows.map((b) => num(b.realizedPnl !== undefined && b.realizedPnl !== null ? b.realizedPnl : b.finalUpl));
  const wins = pnl.filter((x) => x > 0), losses = pnl.filter((x) => x < 0);
  const grossWin = sumBy(wins, (x) => x), grossLoss = sumBy(losses, (x) => -x);
  const eqBase = num(equity0, 0) || mean(rows.map((b) => b.equityAtOpen)) || null;
  const reasons = {};
  for (const b of rows) { const k = b.closeReason || 'unknown'; reasons[k] = reasons[k] || { reason: k, n: 0, pnlUsd: 0 }; reasons[k].n++; reasons[k].pnlUsd += num(b.realizedPnl); }
  return {
    trades: rows.length, wins: wins.length, losses: losses.length,
    winRate: rows.length ? roundN((wins.length / rows.length) * 100, 2) : null,
    expectancyUsd: roundN(mean(pnl), 6),
    expectancyPermille: eqBase ? roundN((mean(pnl) / eqBase) * 1000, 4) : null,
    profitFactor: grossLoss > 0 ? roundN(grossWin / grossLoss, 4) : (grossWin > 0 ? null : null),
    grossWinUsd: roundN(grossWin, 6), grossLossUsd: roundN(grossLoss, 6),
    netUsd: roundN(sumBy(pnl, (x) => x), 6),
    bestUsd: roundN(pnl.length ? Math.max(...pnl) : null, 6), worstUsd: roundN(pnl.length ? Math.min(...pnl) : null, 6),
    reasons: Object.values(reasons).map((r) => ({ ...r, pnlUsd: roundN(r.pnlUsd, 6), sharePct: rows.length ? roundN((r.n / rows.length) * 100, 2) : null })),
  };
}

/** 权益曲线回撤：state.curve 优先；无曲线时用平仓盈亏重建（标注重建口径） */
function equityDrawdown(state) {
  const curve = ((state && state.curve) || []).map((p) => num(p.equity)).filter((x) => Number.isFinite(x) && x > 0);
  if (curve.length >= 2) {
    const dd = maxDrawdownPct(curve);
    return { ...dd, source: 'state.curve', points: curve.length };
  }
  const closed = (state && state.closed) || [];
  if (closed.length >= 2) {
    const base = num(state.dayStartEquity) || num(state.equity) || 0;
    let run = base; const series = [base];
    for (const b of closed.sort((a, c) => num(a.closedAt) - num(c.closedAt))) { run += num(b.realizedPnl); series.push(run); }
    return { ...maxDrawdownPct(series), source: '重建（平仓盈亏累加）', points: series.length };
  }
  return { pct: null, source: '无数据', points: curve.length, note: '权益曲线点不足且已平仓 < 2 笔' };
}

/* ══ 5. 回测对比 ═══════════════════════════════════ */

/** 回测里「一笔交易」的名义价值均值（保证金之和 × 杠杆） */
function backtestAvgNotional(backtest) {
  const trades = (backtest && backtest.trades) || [];
  if (!trades.length) return null;
  const lev = num((backtest && backtest.params && backtest.params.leverage) || 3, 3);
  const notionals = trades.map((t) => sumBy(t.levelsDetail || [], (l) => l.marginUsd) * lev).filter((x) => x > 0);
  return mean(notionals);
}

/** 成本拖累：实测往返成本 vs 回测往返成本，按回测单笔期望（名义 bps）折算被吃掉的比例 */
function costDrag({ liveSlipSideBps = null, btSlipSideBps = null, liveFeeSideBps = null, btFeeSideBps = null, btExpectancyBps = null } = {}) {
  const live = isNum(liveSlipSideBps) && isNum(liveFeeSideBps) ? 2 * (num(liveSlipSideBps) + num(liveFeeSideBps)) : null;
  const bt = isNum(btSlipSideBps) && isNum(btFeeSideBps) ? 2 * (num(btSlipSideBps) + num(btFeeSideBps)) : null;
  const gap = live !== null && bt !== null ? live - bt : null;
  return {
    liveRoundTripBps: roundN(live, 4), btRoundTripBps: roundN(bt, 4), gapBps: roundN(gap, 4),
    btExpectancyBps: roundN(btExpectancyBps, 4),
    dragPct: gap !== null && isNum(btExpectancyBps) && num(btExpectancyBps) > 0 ? roundN((gap / num(btExpectancyBps)) * 100, 2) : null,
    note: '往返成本 = 2 ×（单边滑点 + 单边手续费）；拖累 = 成本缺口 / 回测单笔期望（同口径名义 bps）',
  };
}

/** 实盘参数 vs 回测基线参数 */
function policyDrift(livePolicy, btPolicy) {
  const keys = [...new Set([...Object.keys(livePolicy || {}), ...Object.keys(btPolicy || {})])].sort();
  const rows = [];
  for (const k of keys) {
    const l = livePolicy ? livePolicy[k] : undefined, b = btPolicy ? btPolicy[k] : undefined;
    if (l === undefined && b === undefined) continue;
    const same = String(l) === String(b);
    rows.push({ key: k, live: l === undefined ? '(未设置)' : l, backtest: b === undefined ? '(回测无此项)' : b, same });
  }
  return { rows, diffs: rows.filter((r) => !r.same) };
}

/* ══ 6. 样本量门槛 ═══════════════════════════════════ */

function sampleGate(n, minTrades = MIN_TRADES_DEFAULT) {
  const count = num(n);
  const sufficient = count >= minTrades;
  return { n: count, minTrades, sufficient, note: sufficient ? `样本 ${count} 笔 ≥ ${minTrades} 笔，结论可用` : `样本不足（${count} < ${minTrades} 笔），结论不可用` };
}

/* ══ 7. 读取器（只读） ═══════════════════════════════ */

function readJsonSafe(p) {
  try { return { ok: true, data: JSON.parse(fs.readFileSync(p, 'utf8')), path: p }; }
  catch (e) { return { ok: false, error: String(e.message || e).slice(0, 200), path: p }; }
}

function readState(statePath) {
  const r = readJsonSafe(statePath);
  if (!r.ok) return { ok: false, error: r.error, path: r.path, state: null };
  return { ok: true, path: r.path, state: r.data };
}

function listBacktestFiles(dataDir) {
  try {
    return fs.readdirSync(dataDir).filter((f) => /^backtest-martin-.+\.json$/.test(f)).map((f) => path.join(dataDir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  } catch { return []; }
}

/** 回测报告：显式路径优先，否则取 dataDir 里最新一份 */
function readBacktest(dataDir, explicitPath = null) {
  const p = explicitPath || listBacktestFiles(dataDir)[0] || null;
  if (!p) return { ok: false, error: '未找到 data/backtest-martin-*.json', path: null, backtest: null };
  const r = readJsonSafe(p);
  if (!r.ok) return { ok: false, error: r.error, path: p, backtest: null };
  return { ok: true, path: p, backtest: r.data };
}

/** 最新一份验算报告（server.js 的 GET /api/verify/report 用） */
function latest(dataDir) {
  try {
    const files = fs.readdirSync(dataDir).filter((f) => /^verify-\d{8}\.json$/.test(f)).sort();
    if (!files.length) return { ok: false, error: '尚无验算报告（跑 scripts/verify-report.js 生成 data/verify-YYYYMMDD.json）', file: null };
    const p = path.join(dataDir, files[files.length - 1]);
    const r = readJsonSafe(p);
    if (!r.ok) return { ok: false, error: r.error, file: files[files.length - 1] };
    return { ok: true, file: files[files.length - 1], report: r.data };
  } catch (e) { return { ok: false, error: String(e.message || e).slice(0, 160), file: null }; }
}

/* ── OKX 证据：运行态直连 或 快照文件 ── */

/** 给成交明细补 ctVal（fee/slip 的 bps 换算需要），便于后续纯函数使用 */
function annotateCtVal(fills, ctValByInst) {
  return (fills || []).map((f) => ({ ...f, __ctVal: num(ctValByInst[f.instId], 0) }));
}

/** 从 state 里收集各标的 ctVal（篮子记录自带） */
function ctValFromState(state) {
  const out = {};
  for (const b of [...((state && state.baskets) || []), ...((state && state.closed) || [])]) {
    if (b && b.instId && isNum(b.ctVal) && num(b.ctVal) > 0) out[b.instId] = num(b.ctVal);
  }
  return out;
}

/** 标的规格（只读公共接口，无需密钥）；缺网/失败时返回空表不抛 */
async function ctValFromOkx(instIds, { proxy, timeoutMs = 12000 } = {}) {
  const out = {};
  let okxData = null;
  try { okxData = require('./okx-data'); } catch { return out; }
  for (const instId of instIds || []) {
    try {
      if (proxy) process.env.PROXY_URL = proxy;
      const ins = await okxData.instrument(instId);
      if (ins && isNum(ins.ctVal) && num(ins.ctVal) > 0) out[instId] = num(ins.ctVal);
    } catch { /* 单个失败不影响其它 */ }
  }
  return out;
}

/**
 * 装载 OKX 证据（只读）。
 * @param {{snapshotPath?:string, live?:boolean, ctValByInst?:object}} opt
 * @returns {Promise<{ok, source, capturedAt, balance, positions, fills, bills, error}>}
 */
async function loadOkxEvidence({ snapshotPath = null, live = false, ctValByInst = {} } = {}) {
  if (snapshotPath) {
    const r = readJsonSafe(snapshotPath);
    if (!r.ok) return { ok: false, source: `snapshot:${snapshotPath}`, error: r.error, fills: [], bills: [], positions: [], balance: null };
    const d = r.data || {};
    const evidence = {
      balance: d.balance || null, positions: d.positions || [], fills: annotateCtVal(d.fills || [], ctValByInst), bills: d.bills || [],
      errors: { balance: d.balanceErr, positions: d.positionsErr, fills: d.fillsErr, bills: d.billsErr },
    };
    const someOk = !d.fillsErr || !d.billsErr;
    return { ok: someOk, source: `snapshot:${snapshotPath}`, capturedAt: d.capturedAt || null, ...evidence, error: someOk ? null : (d.fillsErr || d.billsErr) };
  }
  if (!live) return { ok: false, source: 'none', error: '未提供 OKX 证据（--okx-snapshot <file> 或 --live-okx）', fills: [], bills: [], positions: [], balance: null };
  const trade = require('./okx-trade');
  const out = { ok: true, source: 'okx-api(live)', capturedAt: new Date().toISOString(), balance: null, positions: [], fills: [], bills: [], errors: {} };
  const grab = async (key, p) => { try { out[key] = await trade.okxPrivate('GET', p); } catch (e) { out.errors[key] = String(e.message || e).slice(0, 180); out.ok = false; } };
  await grab('balance', '/api/v5/account/balance');
  await grab('positions', '/api/v5/account/positions?instType=SWAP');
  await grab('fills', '/api/v5/trade/fills-history?instType=SWAP&limit=100');
  await grab('bills', '/api/v5/account/bills?instType=SWAP&limit=100');
  out.fills = annotateCtVal(out.fills || [], ctValByInst);
  return out;
}

/* ══ 8. 组装报告 ════════════════════════════════════ */

/**
 * 组装一份完整验算报告（纯函数：不读盘、不下单）。
 * @param {{state, backtest, okx, now?, minTrades?, meta?}} input
 */
function buildReport({ state, backtest = null, okx = null, now = Date.now(), minTrades = MIN_TRADES_DEFAULT, meta = {} } = {}) {
  const st = state || {};
  const open = ((st.baskets) || []).filter((b) => !b.closed);
  const closed = ((st.closed) || []).slice().sort((a, b) => num(a.closedAt) - num(b.closedAt));
  const events = ((st.events) || []).concat(((st.log) || []).map((l) => ({ ts: l.ts, type: l.type || 'log', level: l.level, text: l.msg })));
  const livePolicy = st.policy || {};
  const btPolicy = (backtest && backtest.runs && backtest.runs[0] && backtest.runs[0].policy) || (backtest && backtest.params) || {};
  const btSummary = (backtest && backtest.summary) || {};

  /* 1) 滑点 */
  const okxFills = (okx && okx.fills) || [];
  const match = matchEventsToFills({ events: (st.events || []), fills: okxFills });
  const slip = slipStats(match.pairs);
  const rec = slipFromReconcile(st.events || []);
  const slipInsufficient = slip.n === 0;
  const slipSection = {
    ok: !slipInsufficient,
    reason: slipInsufficient ? (okxFills.length ? '有 OKX 成交明细，但没有能撮配上的引擎事件（缺开/平仓事件或时窗过窄）' : '无 OKX 成交明细（未提供凭据/快照）') : null,
    stats: slip, rowTripBps: slip.roundTripBps, matchNote: match.note,
    rows: match.pairs, unmatchedEvents: match.unmatchedEvents, unmatchedFills: match.unmatchedFills,
    reconcile: { stats: rec.stats, rows: rec.rows },
  };

  /* 2) 费用 / 资金费（两套口径：本机器人范围 / 全账户） */
  const allFills = okxFills;
  const allBills = (okx && okx.bills) || [];
  const botIds = botInstIds(st);
  const openTs = [...((st.baskets) || []), ...((st.closed) || [])].map((b) => num(b.openedAt, 0)).filter((x) => x > 0);
  const scopeFrom = openTs.length ? Math.min(...openTs) - 3600e3 : null;
  const scopedFills = filterByScope(allFills, { instIds: botIds, fromTs: scopeFrom });
  const scopedBills = filterByScope(allBills, { instIds: botIds, fromTs: scopeFrom });
  const fees = feeStats(scopedFills, { ctValByInst: meta.ctValByInst || {} });
  const funding = fundingStats(scopedBills);
  const accountFees = feeStats(allFills, { ctValByInst: meta.ctValByInst || {} });
  const accountFunding = fundingStats(allBills);
  const costInsufficient = fees.n === 0 && funding.n === 0;
  const costSection = {
    ok: !costInsufficient,
    reason: costInsufficient ? (allFills.length || allBills.length ? 'OKX 有成交/账单，但都不属于本机器人范围（标的/时间窗不匹配）' : '无 OKX 成交/账单（未提供凭据/快照）') : null,
    scope: { instIds: [...botIds], from: scopeFrom ? new Date(scopeFrom).toISOString() : null, note: '范围 = state 出现过的标的 ∩ 首个篮子开仓前 1h 之后' },
    feeSideBps: fees.avgBps, feeMedianBps: fees.medianBps, feeUsd: fees.feeUsd, feeFills: fees.n, feeByInstId: fees.byInstId, feeMissingCtVal: fees.missingCtVal,
    fundingUsd: funding.fundingUsd, fundingEntries: funding.n, fundingByInstId: funding.byInstId, fundingWindow: funding.window,
    roundTripFeeBps: fees.avgBps === null ? null : roundN(fees.avgBps * 2, 4),
    accountWide: { feeUsd: accountFees.feeUsd, feeFills: accountFees.n, feeSideBps: accountFees.avgBps, fundingUsd: accountFunding.fundingUsd, fundingEntries: accountFunding.n },
  };

  /* 3) 层数 / 时长：已平仓为主，持仓单列 */
  const levelClosed = levelStats(closed, { maxLevels: num(livePolicy.maxLevels, 0) || null });
  const levelOpen = levelStats(open, { maxLevels: num(livePolicy.maxLevels, 0) || null });
  const levelSection = { ok: closed.length > 0, reason: closed.length ? null : '无已平仓篮子（只有持仓单，层数分布还不成立）', closed: levelClosed, open: levelOpen };

  /* 4) 盈亏结构 */
  const pnl = pnlStats(closed, { equity0: num(st.equity, 0) || null });
  const dd = equityDrawdown(st);
  const pnlSection = {
    ok: closed.length > 0, reason: closed.length ? null : '无已平仓篮子，盈亏结构未成立',
    ...pnl, maxDrawdownPct: dd.pct, drawdownSource: dd.source, curvePoints: dd.points,
    openCount: open.length, openMarginUsd: roundN(sumBy(open, (b) => (isNum(b.marginUsd) ? b.marginUsd : sumBy(b.levels || [], (l) => l.marginUsd))), 4),
    equity: roundN(st.equity, 6), dayStartEquity: roundN(st.dayStartEquity, 6),
  };

  /* 5) 回测对比 */
  const btExpectancyBps = (() => {
    const notion = backtestAvgNotional(backtest);
    return notion > 0 && isNum(btSummary.expectancyUsd) ? (num(btSummary.expectancyUsd) / notion) * 10000 : null;
  })();
  const drag = costDrag({
    liveSlipSideBps: slip.avgBps, btSlipSideBps: num((backtest && backtest.slipBps), 0),
    liveFeeSideBps: fees.avgBps, btFeeSideBps: backtest && isNum(backtest.feeBps) ? num(backtest.feeBps) / 2 : null,
    btExpectancyBps,
  });
  const drift = policyDrift(livePolicy, btPolicy);
  const cmpRows = [
    { metric: '单边手续费 (bps)', live: fees.avgBps, backtest: backtest && isNum(backtest.feeBps) ? roundN(num(backtest.feeBps) / 2, 4) : null, delta: null, note: '回测 feeBps 是双边口径 → /2 对齐' },
    { metric: '单边滑点 (bps)', live: slip.avgBps, backtest: backtest ? num(backtest.slipBps, 0) : null, delta: null, note: '回测 slipBps 默认 0（未施加滑点）' },
    { metric: '往返总成本 (bps)', live: drag.liveRoundTripBps, backtest: drag.btRoundTripBps, delta: drag.gapBps, note: drag.note },
    { metric: '胜率 (%)', live: pnl.winRate, backtest: isNum(btSummary.winRate) ? num(btSummary.winRate) : null, delta: null, note: '' },
    { metric: '单笔期望 (USD)', live: pnl.expectancyUsd, backtest: isNum(btSummary.expectancyUsd) ? num(btSummary.expectancyUsd) : null, delta: null, note: '权益基数不同，USD 不可直接比' },
    { metric: '单笔期望 (‰ 权益)', live: pnl.expectancyPermille, backtest: isNum(btSummary.expectancyPct) ? roundN(num(btSummary.expectancyPct) * 10, 4) : null, delta: null, note: '实盘按当前权益；回测 expectancyPct 为相对初始权益 %' },
    { metric: '盈亏比 PF', live: pnl.profitFactor, backtest: isNum(btSummary.profitFactor) ? num(btSummary.profitFactor) : null, delta: null, note: '' },
    { metric: '最大回撤 (%)', live: dd.pct, backtest: isNum(btSummary.maxDrawdownPct) ? num(btSummary.maxDrawdownPct) : null, delta: null, note: `实盘口径：${dd.source}` },
    { metric: '平均层数', live: levelClosed.avgLevels, backtest: isNum(btSummary.avgLevelsUsed) ? num(btSummary.avgLevelsUsed) : null, delta: null, note: '' },
    { metric: '满层率 (%)', live: levelClosed.fullLevelRate, backtest: isNum(btSummary.level6Rate) ? num(btSummary.level6Rate) : null, delta: null, note: '回测 level6Rate 是「满 maxLevels」口径' },
    { metric: '平均持仓 (h)', live: levelClosed.avgHours, backtest: isNum(btSummary.avgHours) ? num(btSummary.avgHours) : null, delta: null, note: '' },
  ].map((r) => ({ ...r, delta: r.delta !== null ? r.delta : (isNum(r.live) && isNum(r.backtest) ? roundN(num(r.live) - num(r.backtest), 4) : null) }));

  /* 6) 口径不一致 / 发现 */
  const findings = [];
  if (isNum(costSection.feeSideBps) && backtest && isNum(backtest.feeBps)) {
    const btSide = num(backtest.feeBps) / 2;
    if (num(costSection.feeSideBps) > btSide + 0.05) {
      findings.push({
        level: 'warn', key: 'fee_mismatch',
        text: `实测单边手续费 ${costSection.feeSideBps} bps > 回测假设 ${btSide} bps（${roundN(num(backtest.feeBps), 2)}bps 双边）→ 回测低估 ${roundN(((num(costSection.feeSideBps) - btSide) / btSide) * 100, 1)}%`,
      });
    }
  }
  if (backtest && num(backtest.slipBps, 0) === 0 && !slipInsufficient) {
    findings.push({ level: 'info', key: 'slip_not_modeled', text: `回测未施加滑点（slipBps=0），实测单边 ${slip.avgBps} bps（n=${slip.n}）→ 口径缺口应显式相加` });
  }
  if (drift.diffs.length) {
    findings.push({ level: 'warn', key: 'policy_drift', text: `实盘参数与回测基线不一致 ${drift.diffs.length} 项：${drift.diffs.map((d) => `${d.key}:${d.backtest}→${d.live}`).join('、')}` });
  }
  const floorNote = open.map((b) => {
    const planned = num(b.firstMarginUsd, 0), actual = num(b.marginUsd, 0) || sumBy(b.levels || [], (l) => l.marginUsd);
    if (planned > 0 && actual > 0 && Math.abs(actual - planned) / planned > 0.05) {
      const eq = num(b.equityAtOpen, 0);
      return { instId: b.instId, plannedUsd: roundN(planned, 4), actualUsd: roundN(actual, 4), plannedPct: eq ? roundN((planned / eq) * 100, 3) : null, actualPct: eq ? roundN((actual / eq) * 100, 3) : null };
    }
    return null;
  }).filter(Boolean);
  if (floorNote.length) {
    findings.push({ level: 'warn', key: 'size_floor', text: `小资金 + 整张合约下限（minSz/lotSz）使实际首单保证金低于政策比例：${floorNote.map((x) => `${x.instId} 计划 ${x.plannedUsd}U(${x.plannedPct}%) → 实际 ${x.actualUsd}U(${x.actualPct}%)`).join('；')} → 层保证金表（1%/1.5%/2.25%…）在实盘不成立` });
  }
  const liqDrift = open.filter((b) => isNum(b.liqPxReal) && isNum(b.liqPxRealAt)).map((b) => ({ instId: b.instId, liqPxReal: b.liqPxReal, at: b.liqPxRealAt, posMissingAt: b.posMissingAt ?? null }));
  if (open.some((b) => b.posMissingAt)) {
    findings.push({ level: 'alert', key: 'pos_missing', text: `有篮子被判定「交易所无持仓」（posMissingAt 已置位）：${open.filter((b) => b.posMissingAt).map((b) => `${b.instId}@${new Date(b.posMissingAt).toISOString()}`).join('、')} —— 疑被强平/手动平，本地账与交易所账已分叉` });
  }
  if (st.reconciliation) {
    findings.push({ level: st.reconciliation.fixed > 0 ? 'warn' : 'info', key: 'reconcile', text: `对账：最近一次 OKX 持仓对账 ${new Date(num(st.reconciliation.at)).toISOString()} · 仓位 ${st.reconciliation.count} 个 · 修正 ${st.reconciliation.fixed} 个` });
  }
  /* 全账户 vs 本机器人：账户共用时的口径提醒 */
  if (accountFees.n > fees.n && Math.abs(accountFees.feeUsd) > Math.abs(fees.feeUsd) * 1.5) {
    findings.push({ level: 'info', key: 'shared_account', text: `账户里有非本机器人活动：全账户手续费 ${accountFees.feeUsd} U（${accountFees.n} 笔）vs 本机器人范围 ${fees.feeUsd} U（${fees.n} 笔）→ 汇报口径必须写“本机器人范围”，不能用全账户` });
  }
  /* 权益是否真的在跟账户刷新（实盘最容易悄悄错的口径） */
  const curveVals = ((st.curve) || []).map((p) => num(p.equity));
  const okxEq = (() => {
    const b = okx && okx.balance; const arr = Array.isArray(b) ? b : (b ? [b] : []);
    const row = arr.find((x) => x && x.ccy === 'USDT') || arr[0];
    return row && isNum(row.totalEq) ? num(row.totalEq) : null;
  })();
  if (curveVals.length >= 3 && curveVals.every((v) => v === curveVals[0]) && okxEq !== null && isNum(st.equity)) {
    const diff = okxEq - num(st.equity);
    findings.push({
      level: Math.abs(diff) > 0.01 ? 'warn' : 'info', key: 'equity_frozen',
      text: `state.equity 在 ${curveVals.length} 个曲线点上完全不变（${roundN(st.equity, 4)} U），OKX 实时权益 ${roundN(okxEq, 4)} U（差 ${roundN(diff, 4)} U）→ 实盘权益只在为空时写入，未随账户刷新；当日盈亏/最大回撤/日亏熔断都建立在冻结值上`,
    });
  }

  /* 7) 样本量 + 结论可用性 */
  const gate = sampleGate(closed.length, minTrades);
  const sections = [
    { key: 'slippage', title: '成交滑点实测', ok: slipSection.ok, reason: slipSection.reason },
    { key: 'costs', title: '费用与资金费', ok: costSection.ok, reason: costSection.reason },
    { key: 'levels', title: '层数分布', ok: levelSection.ok, reason: levelSection.reason },
    { key: 'pnl', title: '盈亏结构', ok: pnlSection.ok, reason: pnlSection.reason },
  ];

  return {
    ok: true, version: 1, generatedAt: new Date(now).toISOString(),
    meta: {
      statePath: meta.statePath || null, stateSavedAt: st.savedAt || null,
      mode: st.mode || null, day: st.day || null,
      okxSource: okx ? okx.source : 'none', okxCapturedAt: okx ? okx.capturedAt : null, okxErrors: (okx && okx.errors) || {},
      backtestFile: meta.backtestFile || null, backtestGeneratedAt: backtest ? (backtest.generatedAt || null) : null,
      minTrades, ...((meta.extra) || {}),
    },
    headline: {
      equityUsd: roundN(st.equity, 6), openBaskets: open.length, closedBaskets: closed.length,
      sample: gate,
      usable: gate.sufficient && (slipSection.ok || costSection.ok),
      conclusion: gate.sufficient ? (slipSection.ok ? '样本达标，可用滑点/成本结论' : '样本达标但缺 OKX 成交证据，滑点仍需补数') : '样本不足，结论不可用（只作过程观测）',
    },
    slippage: slipSection,
    costs: costSection,
    levels: levelSection,
    pnl: pnlSection,
    comparison: { rows: cmpRows, costDrag: drag, policyDrift: drift, backtest: backtest ? { file: meta.backtestFile || null, days: backtest.days, feeBps: backtest.feeBps, slipBps: num(backtest.slipBps, 0), summary: btSummary, verdict: backtest.verdict || null } : null },
    findings,
    positions: { reconciled: liqDrift },
    sections,
  };
}

module.exports = {
  MIN_TRADES_DEFAULT, FILL_MATCH_WINDOW_MS,
  // 纯函数
  unfavBps, roundTripBps, execSideOf, vwapByOrder, expectedFromEvent, matchEventsToFills,
  slipStats, slipFromReconcile, feeStats, fundingStats, levelStats, maxDrawdownPct, pnlStats,
  equityDrawdown, backtestAvgNotional, costDrag, policyDrift, sampleGate, buildReport,
  filterByScope, botInstIds,
  // 读取器（只读）
  readState, readBacktest, listBacktestFiles, latest, loadOkxEvidence, ctValFromState, ctValFromOkx, annotateCtVal,
  // 工具
  mean, median, percentile, roundN,
};
