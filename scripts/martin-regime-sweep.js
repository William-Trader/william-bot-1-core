/*!
 * scripts/martin-regime-sweep.js - william-bot-1-core key backtest/optimize logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-D236E6DC
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
#!/usr/bin/env node
/**
 * scripts/martin-regime-sweep.js —— 马丁策略三项优化扫描（regime 选品 / 信号逆转处理 / 降止损率）
 *
 * 目的（2026-09-22 老板任务）：
 *   A. 选品/趋势过滤：入场前加波动率·趋势 regime 过滤（vr5 / adx / rf / 只做 range / ATR% 上限）
 *   B. 信号逆转处理：trend_flip 三种口径（now 立刻平 / confirm 两 bar 确认 / half 先减半）
 *   C. 降止损概率（不许靠扛单）：砍尾层（maxLevels）/ 入场时机 / 分层止损 / 部分止盈
 *
 * 铁律
 *   · 无未来函数：所有过滤量（vr5/adx/rf/ATR%）只用 i-1 及更早收盘（继承 martin-backtest.js 时序约定）
 *   · 成本显式：手续费 bps 往返 + 滑点 bps/单边 + OKX 真实资金费
 *   · 每组都给 5 折 walk-forward（样本外）
 *   · 不许通过「放宽止损 / 延长扛单」降止损率：本脚本的止损口径从 policy 直接读出，
 *     报告里同时给 stopMode / deathAtrMult / maxBasketRiskPct / timeStopHours，便于交叉核对没被偷改。
 *
 * 数据：优先读本地缓存 data/cache/candles-*-1H-<bars>.json（离线、可复现），缺失才联网拉。
 * 用法：
 *   node scripts/martin-regime-sweep.js [--days 350] [--equity 10000] [--fee 10.02] [--slip 5]
 *     [--folds 5] [--policy data/live-policy-20260922.json] [--out data/regime-sweep-YYYYMMDD.json]
 *     [--only A|B|C|all] [--quick]
 */
'use strict';

if (!process.env.PROXY_URL && !process.env.HTTPS_PROXY) process.env.PROXY_URL = 'http://127.0.0.1:17890';

const fs = require('fs');
const path = require('path');
const martin = require('../modules/martin');
const store = require('../modules/store');
const uni = require('../modules/universe');
const bt = require('./martin-backtest');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const round = (v, n = 4) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(n)) : null);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};
const flag = (n) => process.argv.includes('--' + n);

/* ── 数据：离线优先（缓存 → 联网兜底） ─────────────── */

function readCacheRows(file) {
  try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j.rows) ? j.rows : null; } catch { return null; }
}

async function loadInstruments() {
  const file = path.join(CACHE_DIR, 'instruments-swap.json');
  const cached = (() => { try { const j = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(j.rows) && j.rows.length ? j.rows : null; } catch { return null; } })();
  if (cached) return cached;
  const swaps = await uni.allSwaps();
  store.ensureDir(CACHE_DIR);
  fs.writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), rows: swaps }), 'utf8');
  return swaps;
}

/**
 * 载入回测数据。offline=true 时只读缓存（数据窗口 = 缓存窗口，可复现）；缓存缺失则联网补。
 * @returns {Array} data [{instId, sector, instrument, candles, funding}]
 */
async function loadData(days, fundingIncluded, offline, log = () => {}) {
  const targetBars = Math.ceil(days * 24);
  const swaps = await loadInstruments();
  const instMap = new Map(swaps.map((d) => [d.instId, d]));
  const data = [];
  for (const instId of bt.ALL) {
    const ins = instMap.get(instId);
    if (!ins) { log(`  ⚠ ${instId} 无规格，跳过`); continue; }
    let candles = readCacheRows(path.join(CACHE_DIR, `candles-${instId}-1H-${targetBars}.json`));
    if (!candles || candles.length < 300) {
      if (offline) { log(`  ⚠ ${instId} 缓存缺失且 offline，跳过`); continue; }
      candles = (await bt.fetchCandles(instId, '1H', targetBars, (s) => log(s))).rows;
    }
    if (!candles || candles.length < 300) { log(`  ⚠ ${instId} K线不足，跳过`); continue; }
    let funding = [];
    if (fundingIncluded) {
      funding = readCacheRows(path.join(CACHE_DIR, `funding-${instId}.json`)) || [];
      if (!funding.length && !offline) funding = (await bt.fetchFunding(instId, candles[0].ts, (s) => log(s))).rows;
    }
    data.push({
      instId, sector: bt.sectorOf(instId),
      instrument: {
        ctVal: Number(ins.ctVal || 1), ctValCcy: ins.ctValCcy,
        lotSz: Number(ins.lotSz || 0), minSz: Number(ins.minSz || 0),
        tickSz: Number(ins.tickSz || 0), maxLever: Number(ins.lever || 0),
      },
      candles, funding,
    });
  }
  return data;
}

/* ── 指标（口径 + 任务 A 需要的 vr5/rho1/rf） ──────── */

const IND_WINDOW = 300;
const LOOKBACK = 220;

/** 只用 i-1 及更早收盘；额外算 vr5/rho1/rf（任务 A 的 regime 过滤量） */
function buildIndicators2(candles, zWin = 0) {
  const ind = new Array(candles.length).fill(null);
  const zw = Number(zWin) > 0 ? Math.max(2, Math.floor(Number(zWin))) : 0;
  for (let i = LOOKBACK; i < candles.length; i++) {
    const slice = candles.slice(Math.max(0, i - IND_WINDOW), i);
    const atrPct = uni.atrPct(slice, 14);
    const rg = uni.classifyRegime(slice);
    const rets = uni.logReturns ? uni.logReturns(slice) : (() => { const r = []; for (let k = 1; k < slice.length; k++) r.push(Math.log(slice[k].c / slice[k - 1].c)); return r; })();
    const vr5 = uni.varianceRatio(rets, 5);
    const rho1 = uni.autocorr1(rets);
    const rf = uni.reversionFrequency(slice);
    const prevC = candles[i - 1].c;
    const chg1h = i >= 2 && candles[i - 2].c ? (prevC / candles[i - 2].c - 1) * 100 : null;
    let entryZ = null;
    if (zw && i >= zw) {
      const closes = [];
      for (let k = i - zw; k <= i - 1; k++) closes.push(candles[k].c);
      entryZ = martin.zScore(closes, zw);
    }
    ind[i] = {
      atrPct, atrPx: atrPct != null ? (atrPct / 100) * prevC : null,
      prevClose: prevC, chg1h, entryZ,
      vr5, rho1, rf,
      regime: { ...rg, barChangePct: chg1h, vr5, rho1, rf },
    };
  }
  return ind;
}

const indCache2 = new Map();
function indicators2(instId, candles, zWin = 0) {
  const zw = Number(zWin) > 0 ? Math.max(2, Math.floor(Number(zWin))) : 0;
  const key = `${instId}|${candles.length}|${candles[0] && candles[0].ts}|${candles[candles.length - 1] && candles[candles.length - 1].ts}|z${zw}`;
  if (!indCache2.has(key)) indCache2.set(key, buildIndicators2(candles, zw));
  return indCache2.get(key);
}

/* ── walk-forward（复用 bt.simulate；折内重算指标，无未来函数） ── */

function walkForward2({ data, policy, equity0, feeBps, slipBps, folds = 5, fundingIncluded = true }) {
  const winStart = Math.max(...data.map((d) => d.candles[0].ts));
  const winEnd = Math.min(...data.map((d) => d.candles[d.candles.length - 1].ts));
  const span = (winEnd - winStart) / folds;
  const out = [];
  const pooled = [];
  const zWin = martin.normPolicy(policy).entryZMin > 0 ? Math.max(2, Math.floor(martin.normPolicy(policy).entryZWin)) : 0;
  for (let f = 0; f < folds; f++) {
    const from = winStart + f * span;
    const to = f === folds - 1 ? winEnd : winStart + (f + 1) * span;
    const slice = data.map((d) => {
      const cs = d.candles.filter((c) => c.ts <= to);
      return { ...d, candles: cs, ind: indicators2(d.instId, cs, zWin) };
    });
    const r = bt.simulate({ data: slice, policy, equity0, feeBps, slipBps, fundingIncluded, startTs: from });
    pooled.push(...r.trades);
    out.push({ fold: f + 1, from, to, days: round((to - from) / 86400e3, 1), summary: r.summary, trades: r.trades });
  }
  const w = pooled.filter((t) => t.pnlUsd > 0);
  const gw = w.reduce((a, t) => a + t.pnlUsd, 0);
  const gl = Math.abs(pooled.filter((t) => t.pnlUsd < 0).reduce((a, t) => a + t.pnlUsd, 0));
  const oos = {
    folds, trades: pooled.length,
    expectancyUsd: pooled.length ? round(mean(pooled.map((t) => t.pnlUsd)), 4) : null,
    expectancyBps: pooled.length ? round(mean(pooled.map((t) => t.pnlPct)) * 100, 4) : null,
    winRate: pooled.length ? round((w.length / pooled.length) * 100, 2) : null,
    profitFactor: gl > 0 ? round(gw / gl, 3) : null,
    foldsPositive: out.filter((x) => x.summary.expectancyUsd > 0).length,
    worstFoldDDPct: out.length ? round(Math.min(...out.map((x) => x.summary.maxDrawdownPct)), 2) : null,
    bestFoldExpectancyBps: out.length ? round(Math.max(...out.map((x) => Number(x.summary.expectancyPct) * 100)), 4) : null,
    worstFoldExpectancyBps: out.length ? round(Math.min(...out.map((x) => Number(x.summary.expectancyPct) * 100)), 4) : null,
    stopRate: pooled.length ? round((pooled.filter((t) => isStop(t.reason)).length / pooled.length) * 100, 3) : null,
  };
  return { folds: out, oos };
}

/* ── 指标口径 ─────────────────────────────────────── */

const STOP_REASONS = ['stop_loss', 'risk_stop', 'liquidation'];
const isStop = (r) => STOP_REASONS.includes(r);

function metrics(r, days, equity0) {
  const s = r.summary;
  const tr = r.trades || [];
  const n = tr.length || 1;
  const stops = tr.filter((t) => isStop(t.reason));
  const reason = {};
  for (const t of tr) reason[t.reason] = (reason[t.reason] || 0) + 1;
  const c = s.costDecomposition || null;
  return {
    trades: s.trades,
    tradesPerDay: round(s.trades / days, 3),
    winRate: s.winRate,
    expectancyUsd: s.expectancyUsd,
    expectancyBps: round(Number(s.expectancyPct) * 100, 4),
    profitFactor: s.profitFactor,
    maxDDPct: s.maxDrawdownPct,
    netPnlUsd: s.netPnlUsd,
    returnPct: s.returnPct,
    avgLevels: s.avgLevelsUsed,
    fullLevelRate: s.level6Rate,
    avgHours: s.avgHours,
    maxHours: s.maxHours,
    // 止损口径（老板验收核心）
    stopCount: stops.length,
    stopRate: round((stops.length / n) * 100, 3),
    stopLossCount: s.stopLossCount || 0,
    riskStopCount: reason.risk_stop || 0,
    liquidationCount: s.liquidationCount || 0,
    avgStopLossUsd: stops.length ? round(mean(stops.map((t) => t.pnlUsd)), 4) : null,
    maxStopLossUsd: stops.length ? round(Math.min(...stops.map((t) => t.pnlUsd)), 4) : null,
    maxSingleLossUsd: tr.length ? round(Math.min(...tr.map((t) => t.pnlUsd)), 4) : null,
    worstTradeBps: tr.length ? round(Math.min(...tr.map((t) => t.pnlPct)) * 100, 4) : null,
    // 其它离场
    takeProfitCount: s.takeProfitCount || 0,
    timeStopCount: s.timeStopCount || 0,
    trendFlipCount: reason.trend_flip || 0,
    trendFlipReduceCount: reason.trend_flip_reduce || 0,
    partialTpCount: reason.partial_tp || 0,
    eodCount: reason.eod_close || 0,
    flipPendingEvents: (s.counters && s.counters.trendFlipPending) || 0,
    flipReduceEvents: (s.counters && s.counters.trendFlipReduce) || 0,
    partialTpEvents: (s.counters && s.counters.partialTp) || 0,
    feesUsd: c ? c.feesUsd : round(tr.reduce((a, t) => a + t.feesUsd, 0), 4),
    slipUsd: c ? c.slipUsd : null,
    fundingUsd: c ? c.fundingUsd : round(tr.reduce((a, t) => a + t.fundingUsd, 0), 4),
    totalCostUsd: c ? c.totalCostUsd : null,
    costShareOfGrossPct: c ? c.totalCostShareOfGrossPct : null,
    openingsRejected: (s.counters && s.counters.opensRejected) || 0,
    addBlocked: (s.counters && s.counters.addBlocked) || 0,
  };
}

/* ── Task B 反事实：被 trend_flip 平掉的篮子「若不平」会怎样 ── */

/**
 * 用 levelsDetail 重建篮子，按后续 K 线重放（含加仓/止损/止盈/爆仓），
 * 判定「被逆转后本可盈利」。
 * @returns {{held:number, profitable:number, share:number|null, detail:object[]}}
 */
function flipCounterfactual(trades, data, policy, feeBps, slipBps) {
  const bySym = new Map(data.map((d) => [d.instId, d]));
  const indBySym = new Map(data.map((d) => [d.instId, indicators2(d.instId, d.candles, 0)]));
  const zWin = martin.normPolicy(policy).entryZMin > 0 ? Math.max(2, Math.floor(martin.normPolicy(policy).entryZWin)) : 0;
  for (const d of data) indBySym.set(d.instId, indicators2(d.instId, d.candles, zWin));
  const sideFee = feeBps / 2 / 10000;
  let held = 0, profitable = 0;
  const detail = [];
  for (const t of trades) {
    if (t.reason !== 'trend_flip') continue;
    const d = bySym.get(t.instId);
    if (!d) continue;
    const flipTs = Date.parse(t.closedAt);
    // 重建篮子（只保留张数 > 0 的层）
    const lv = (t.levelsDetail || []).filter((l) => Number(l.contracts) > 0).map((l) => ({ idx: l.idx, ts: flipTs, price: Number(l.price), contracts: Number(l.contracts), marginUsd: Number(l.marginUsd) }));
    if (!lv.length) continue;
    const eqAtOpen = Number(t.equityAtOpen) || 10000;
    const b = {
      id: t.instId + '|cf', instId: t.instId, side: t.side, sector: t.sector,
      openedAt: flipTs, policy: martin.normPolicy(policy), ctVal: Number(d.instrument.ctVal),
      lotSz: Number(d.instrument.lotSz), minSz: Number(d.instrument.minSz), maxLever: Number(d.instrument.maxLever),
      atrAtOpen: null, atrAtOpenPct: null, equityAtOpen: eqAtOpen,
      stopUsd: round((eqAtOpen * Number(martin.normPolicy(policy).hardStopPct)) / 100, 6),
      firstMarginUsd: lv[0].marginUsd, levels: lv, closed: false, realizedPnl: 0, feesUsd: 0, fundingUsd: 0,
    };
    const feesAtStart = 0;
    // 前向重放
    let fees = feesAtStart, partial = 0, end = null;
    const startIdx = d.candles.findIndex((c) => c.ts >= flipTs);
    if (startIdx < 0) continue;
    const horizon = Math.max(1, Math.floor(Number(martin.normPolicy(policy).timeStopHours) || 48)) * 3600e3;
    for (let i = startIdx; i < d.candles.length && !end; i++) {
      const bar = d.candles[i];
      if (bar.ts - flipTs > horizon) { end = 'time_stop'; break; }
      const ind = indBySym.get(t.instId)[i];
      if (!ind) continue;
      const dir = b.side === 'long' ? 1 : -1;
      const ctx = { atr: ind.atrPx, atrPct: ind.atrPct, regime: ind.regime, ts: bar.ts, slipBps };
      // 不利路径：止损/爆仓/加仓
      let guard = 0;
      while (!b.closed && guard++ < 12) {
        const liqPx = martin.liquidationPrice(b);
        const stopPx = martin.stopPrice(b);
        const addPx = martin.nextAddPrice(b, ind.atrPx);
        const liqHit = liqPx !== null && (dir > 0 ? bar.l <= liqPx : bar.h >= liqPx);
        const stopHit = stopPx !== null && (dir > 0 ? bar.l <= stopPx : bar.h >= stopPx);
        const addHit = addPx !== null && (dir > 0 ? bar.l <= addPx : bar.h >= addPx);
        let px = null;
        if (liqHit) px = liqPx; else if (stopHit) px = stopPx; else if (addHit) px = addPx; else break;
        const before = b.levels.length;
        const rr = martin.onPrice(b, { ...ctx, price: px });
        for (const ev of rr.events) {
          if (ev.type === 'add') fees += b.ctVal * ev.contracts * ev.addPx * sideFee;
          if (ev.type === 'trend_flip_reduce' || ev.type === 'partial_tp') {
            fees += b.ctVal * ev.contracts * ev.fillPx * sideFee;
            partial += Number(ev.pnlUsd) || 0;
          }
        }
        if (b.closed) break;
        if (b.levels.length === before && !rr.events.some((e) => e.type === 'add')) break;
      }
      if (b.closed) { end = b.closeReason; break; }
      // 有利路径：部分止盈 + 整篮止盈
      const ptp = martin.partialTpPrice ? martin.partialTpPrice(b, ind.atrPct) : null;
      if (ptp !== null && (dir > 0 ? bar.h >= ptp : bar.l <= ptp)) {
        const rr = martin.onPrice(b, { ...ctx, price: ptp });
        for (const ev of rr.events) if (ev.type === 'partial_tp') { fees += b.ctVal * ev.contracts * ev.fillPx * sideFee; partial += Number(ev.pnlUsd) || 0; }
      }
      if (!b.closed) {
        const tpPx = martin.takeProfitPrice(b, ind.atrPct);
        if (tpPx !== null && (dir > 0 ? bar.h >= tpPx : bar.l <= tpPx)) {
          martin.onPrice(b, { ...ctx, price: tpPx });
          if (b.closed) { end = b.closeReason; }
        }
      }
    }
    if (!end) end = 'no_close_in_horizon';
    const exitPx = b.closePrice || (b.closed ? b.closePrice : d.candles[d.candles.length - 1].c);
    const fin = martin.basketPnl(b, b.closed ? b.closePrice : d.candles[d.candles.length - 1].c);
    if (b.closed) fees += b.ctVal * martin.totalContracts(b) * b.closePrice * sideFee;
    const net = fin.upl + partial - fees;
    held++;
    if (net > 0) profitable++;
    detail.push({ instId: t.instId, side: t.side, flipAt: t.closedAt, actualPnlUsd: t.pnlUsd, cfNetUsd: round(net, 4), cfEnd: end, cfLevels: b.levels.length });
  }
  return { held, profitable, share: held ? round((profitable / held) * 100, 2) : null, detail };
}

/* ── 参数组 ─────────────────────────────────────── */

function variants(live) {
  const V = [];
  const add = (group, name, note, patch) => V.push({ group, name, note, policy: { ...live, ...patch } });

  /* 对照组 = 实盘 policy（现状） */
  add('base', 'live', '实盘 policy（现状基线）', {});
  add('base', 'live-strictStop', '实盘 policy + 止损口径显式复核（同参数，仅声明）', {});
  add('base', 'live-flipConfirm', 'Task B 对照：trend_flip 两 bar 确认', { trendFlipMode: 'confirm', trendFlipConfirmBars: 2 });
  add('base', 'live-flipHalf', 'Task B 对照：trend_flip 先减半', { trendFlipMode: 'half', trendFlipReducePct: 50, trendFlipConfirmBars: 2 });

  /* A. regime 过滤 */
  const A = [
    ['vr5<=1.0', { entryVr5Max: 1.0 }],
    ['vr5<=0.9', { entryVr5Max: 0.9 }],
    ['vr5<=0.8', { entryVr5Max: 0.8 }],
    ['adx<=25', { entryAdxMax: 25 }],
    ['adx<=20', { entryAdxMax: 20 }],
    ['rf>=0.5', { entryRfMin: 0.5 }],
    ['rf>=0.6', { entryRfMin: 0.6 }],
    ['onlyRange', { entrySkipTrend: 'on' }],
    ['vr5<=0.9+adx<=25', { entryVr5Max: 0.9, entryAdxMax: 25 }],
    ['vr5<=0.9+rf>=0.5', { entryVr5Max: 0.9, entryRfMin: 0.5 }],
    ['vr5<=1.0+adx<=20', { entryVr5Max: 1.0, entryAdxMax: 20 }],
  ];
  for (const [n, patch] of A) add('A', n, `Task A regime 过滤：${n}`, patch);

  /* C. 降止损率（不含 A 的 regime 过滤） */
  const C = [
    ['maxLevels4', { maxLevels: 4 }],
    ['maxLevels3', { maxLevels: 3 }],
    ['entryAtr<2.0', { entryAtrPctMax: 2.0 }],
    ['entryAtr<1.5', { entryAtrPctMax: 1.5 }],
    ['layeredStop(3,4x)', { layeredStopEnabled: true, layeredStopFromLevel: 3, layeredStopAtrMult: 4 }],
    ['layeredStop(2,4x)', { layeredStopEnabled: true, layeredStopFromLevel: 2, layeredStopAtrMult: 4 }],
    ['partialTp(0.4%,50%)', { partialTpEnabled: true, partialTpAtPct: 0.4, partialTpFracPct: 50 }],
    ['partialTp(0.6%,50%)', { partialTpEnabled: true, partialTpAtPct: 0.6, partialTpFracPct: 50 }],
  ];
  for (const [n, patch] of C) add('C', n, `Task C 降止损：${n}`, patch);

  return V;
}

/* ── 主流程 ─────────────────────────────────────── */

async function main() {
  const days = Number(arg('days', 350));
  const equity0 = Number(arg('equity', 10000));
  const feeBps = Number(arg('fee', 10.02));
  const slipBps = Number(arg('slip', 5));
  const folds = Number(arg('folds', 5));
  const policyPath = arg('policy', path.join(DATA_DIR, 'live-policy-20260922.json'));
  const outFile = arg('out', path.join(DATA_DIR, `regime-sweep-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`));
  const only = arg('only', 'all');
  const offline = !flag('online');

  const live = { ...bt.BASE_POLICY, ...JSON.parse(fs.readFileSync(policyPath, 'utf8')).policy };
  console.log(`\n=== 马丁三项优化扫描 · ${days} 天 · 权益 $${equity0} · fee ${feeBps}bps 往返 · slip ${slipBps}bps/单边 ===`);
  console.log(`policy: ${policyPath} · 数据：${offline ? '离线缓存' : '联网'}\n`);

  const data = await loadData(days, true, offline, (s) => console.log(s));
  if (!data.length) { console.error('无数据'); process.exit(2); }
  const bars = Math.min(...data.map((d) => d.candles.length));
  const realDays = round(bars / 24, 1);
  console.log(`数据窗口（公共段）：${new Date(Math.max(...data.map((d) => d.candles[0].ts))).toISOString().slice(0, 16)} → ${new Date(Math.min(...data.map((d) => d.candles[d.candles.length - 1].ts))).toISOString().slice(0, 16)}，约 ${realDays} 天 / ${bars} 根 1H，标的 ${data.length} 个\n`);
  console.log(`标的：${data.map((d) => d.instId.replace('-USDT-SWAP', '')).join(', ')}\n`);

  const zWinOf = (pol) => (martin.normPolicy(pol).entryZMin > 0 ? Math.max(2, Math.floor(martin.normPolicy(pol).entryZWin)) : 0);
  const run = (policy, fee = feeBps, slip = slipBps) => {
    const zW = zWinOf(policy);
    for (const d of data) d.ind = indicators2(d.instId, d.candles, zW);
    return bt.simulate({ data, policy, equity0, feeBps: fee, slipBps: slip, fundingIncluded: true, equityCurve: false });
  };

  const V = variants(live).filter((v) => only === 'all' || v.group === only || v.group === 'base');
  const results = [];
  console.log(`[1/3] 全窗口回放 ${V.length} 组 …`);
  for (const v of V) {
    const t0 = Date.now();
    const r = run(v.policy);
    const m = metrics(r, realDays, equity0);
    results.push({ group: v.group, name: v.name, note: v.note, policy: v.policy, m, trades: r.trades, summary: r.summary });
    console.log(`  · ${(v.group + '/' + v.name).padEnd(26)} 笔 ${String(m.trades).padStart(5)} · 期望 ${String(m.expectancyBps).padStart(8)}bps · 胜率 ${String(m.winRate).padStart(6)}% · PF ${String(m.profitFactor).padStart(6)} · 回撤 ${String(m.maxDDPct).padStart(7)}% · 止损 ${String(m.stopCount).padStart(3)}(${String(m.stopRate).padStart(6)}%) · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  const baseM = results.find((x) => x.name === 'live').m;
  console.log(`\n  基线：笔 ${baseM.trades} · 期望 ${baseM.expectancyBps}bps · 胜率 ${baseM.winRate}% · PF ${baseM.profitFactor} · 回撤 ${baseM.maxDDPct}% · 止损 ${baseM.stopCount}(${baseM.stopRate}%)`);

  /* 2) 5 折 OOS：全部组（老板要求「必须给 5 折 OOS」） */
  console.log(`\n[2/3] 5 折 walk-forward（样本外）…`);
  for (const x of results) {
    const t0 = Date.now();
    const wf = walkForward2({ data, policy: x.policy, equity0, feeBps, slipBps, folds });
    x.oos = wf.oos;
    x.perFold = wf.folds.map((f) => ({ fold: f.fold, from: new Date(f.from).toISOString().slice(0, 16), to: new Date(f.to).toISOString().slice(0, 16), days: f.days, trades: f.summary.trades, expectancyUsd: f.summary.expectancyUsd, expectancyBps: round(Number(f.summary.expectancyPct) * 100, 4), winRate: f.summary.winRate, profitFactor: f.summary.profitFactor, maxDDPct: f.summary.maxDrawdownPct, stopCount: (f.summary.stopLossCount || 0) + (f.summary.liquidationCount || 0) + (f.trades || []).filter((t) => t.reason === 'risk_stop').length }));
    console.log(`  · ${x.name.padEnd(24)} OOS 期望 ${String(x.oos.expectancyBps).padStart(8)}bps · 正收益折 ${x.oos.foldsPositive}/${x.oos.folds} · 最差折 ${String(x.oos.worstFoldExpectancyBps).padStart(8)}bps · 最差回撤 ${x.oos.worstFoldDDPct}% · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  /* 3) Task B 反事实（基线 trend_flip 样本） */
  console.log(`\n[3/3] Task B 反事实：基线被 trend_flip 平掉的篮子「不平会怎样」…`);
  const baseTrades = results.find((x) => x.name === 'live').trades;
  const cf = flipCounterfactual(baseTrades, data, live, feeBps, slipBps);
  console.log(`  被 trend_flip 平仓 ${cf.held} 笔；反事实重放（含加仓/止损/止盈/时间止损）后仍盈利 ${cf.profitable} 笔 = ${cf.share}%`);
  const cfHalf = flipCounterfactual(results.find((x) => x.name === 'live-flipHalf').trades, data, live, feeBps, slipBps);
  const cfConfirm = flipCounterfactual(results.find((x) => x.name === 'live-flipConfirm').trades, data, live, feeBps, slipBps);

  /* 成本敏感度：最优候选 × fee 8/10/12 */
  const cands = results
    .filter((x) => x.name !== 'live-strictStop')
    .map((x) => ({ x, score: (x.m.expectancyBps ?? -1e9) }))
    .sort((a, b) => b.score - a.score);
  const bestBy = (g) => results.filter((x) => x.group === g).sort((a, b) => (b.m.expectancyBps ?? -1e9) - (a.m.expectancyBps ?? -1e9))[0];
  const bestA = bestBy('A'); const bestC = bestBy('C');
  const costSens = [];
  console.log(`\n[附加] 成本敏感度（最优 A=${bestA && bestA.name} / 最优 C=${bestC && bestC.name} / 基线）…`);
  for (const [label, pol] of [['live', live], [`A:${bestA && bestA.name}`, bestA && bestA.policy], [`C:${bestC && bestC.name}`, bestC && bestC.policy]].filter(([, p]) => p)) {
    for (const f of [8, 10.02, 12]) {
      const m = metrics(run(pol, f, slipBps), realDays, equity0);
      costSens.push({ label, feeBps: f, slipBps, m });
      console.log(`  ${label.padEnd(22)} fee ${String(f).padStart(5)}: 期望 ${String(m.expectancyBps).padStart(8)}bps · PF ${String(m.profitFactor).padStart(6)} · 止损 ${m.stopCount}(${m.stopRate}%)`);
    }
  }

  const out = {
    ok: true, generatedAt: new Date().toISOString(),
    costBasis: { feeBpsRoundTrip: feeBps, slipBpsPerSide: slipBps, funding: 'OKX real history（缓存）' },
    policySource: policyPath, livePolicy: live,
    days: realDays, bars, equity0, folds, symbols: data.map((d) => d.instId),
    baseline: baseM,
    results: results.map((x) => ({ group: x.group, name: x.name, note: x.note, m: x.m, oos: x.oos, perFold: x.perFold, policy: x.policy })),
    costSensitivity: costSens,
    flipCounterfactual: {
      baseline: { held: cf.held, profitable: cf.profitable, share: cf.share },
      half: { held: cfHalf.held, profitable: cfHalf.profitable, share: cfHalf.share },
      confirm: { held: cfConfirm.held, profitable: cfConfirm.profitable, share: cfConfirm.share },
      detail: cf.detail,
    },
    assumptions: [
      '无未来函数：vr5/rho1/rf/adx/ATR%/regime/z 全部只用 i-1 及更早收盘（窗口 300 根）',
      `成本显式：手续费 ${feeBps}bps 往返 + 滑点 ${slipBps}bps/单边 + OKX 真实资金费`,
      'sizingMode=risk（实盘口径）：首层由风险预算反解；占用上限在开/加仓钳制',
      '止损口径 = stop_loss + risk_stop + liquidation 三类（不含时间止损/趋势反转/收尾）',
      'walk-forward 逐折独立重放（重置篮子/权益），折内只用 i-1 及更早',
    ],
  };
  store.ensureDir(DATA_DIR);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n报告已写：${outFile}`);
  return out;
}

module.exports = { loadData, buildIndicators2, indicators2, walkForward2, metrics, flipCounterfactual, variants, isStop, STOP_REASONS };

if (require.main === module) {
  main().catch((e) => { console.error('扫描失败：', e && e.stack || e); process.exit(1); });
}
