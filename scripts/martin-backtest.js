/*!
 * scripts/martin-backtest.js - william-bot-1-core key backtest/optimize logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-C7BE8A0C
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
#!/usr/bin/env node
/**
 * scripts/martin-backtest.js —— 类马丁策略 ≥180 天真实 K 线回测（默认 10bps 往返 + 单边 5bps 滑点 + 资金费率）
 *
 * 契约：design/MARTIN-BOT-SPEC.md §2.4（输出 JSON 形状与门槛）
 * 铁律：无未来函数 —— 每根 K 线的决策只用「i-1 及更早的收盘」（见下方「时序约定」）
 *
 * 时序约定（关键，别改坏）
 *   · 第 i 根 K 线上的所有决策（状态/方向/ATR/闸门）统一用 candles[0..i-1] 计算；
 *   · 开仓成交价 = 第 i 根的 open（i-1 收盘后决策，i 开盘成交，最早可实现的价格）；
 *   · 触发价是「挂单价」：加仓成交在 nextAddPrice、止盈成交在止盈价、止损成交在止损价；
 *   · 同一根 K 内先走不利路径（硬止损 → 逐层加仓），再走有利路径（止盈）—— 保守优先；
 *   · 黑天鹅判定用「上一根已收盘 K 的涨跌幅」（chg1h），不用当根。
 *
 * 成本（⚠ 2026-09-22 默认值改为实测口径，依据见下）
 *   · 默认 `--fee 10`（往返 bps）/ `--slip 5`（单边 bps）。依据：2026-09-22 实盘成交验算——
 *     101 线上 24 篮 / 41 笔实测**往返成本 10.02bps**（手续费 9.32bps + 滑点影响 0.71bps），
 *     金额加权**单边滑点 5.46bps**；旧默认（fee 8 / slip 0）等于把成本白送 ≈2bps/笔
 *     （占当时回测单笔期望 32.13bps 的 6.3%）。旧口径仍可显式传 `--fee 8 --slip 0` 复现。
 *   · 手续费：每次成交（开/加/平）按成交名义价值 × feeBps/2；一开一平合计 feeBps（往返口径）。
 *   · 滑点：每次成交按成交方向施加 slipBps 不利滑点（买入上浮/卖出下浮），**触发价不变、只推成交价**。
 *   · 资金费率：OKX /api/v5/public/funding-rate-history 真实历史，每 8 小时按当时名义价值计费
 *     （多单付费为正、空单收费为负）；取不到则该标的标 0 并在报告声明。
 *   · 成本可追溯：`--slip > 0` 时每笔写 `slipCostUsd`，汇总写 `summary.costDecomposition`
 *     （手续费 / 滑点 / 资金费各自的 USD、占权益 bps、占无成本毛利 %）。
 *   · `--policy <文件|JSON>`：把线上实盘 policy 作为回测输入（base 组与 walk-forward 都用它）。
 *
 * 用法
 *   PROXY_URL=http://127.0.0.1:17890 node scripts/martin-backtest.js [--days 350] [--equity 10000]
 *     [--fee 10] [--slip 5] [--policy data/live-policy-YYYYMMDD.json] [--no-funding] [--refresh]
 *     [--only base] [--out data/backtest-martin-YYYYMMDD.json]
 *     [--folds 0] [--makerFee 2] [--makerTimeout 1] [--tp-order market|limit]
 *     [--tp-fill-mode touch|prob|confirm] [--tp-fill-rate 1.0]
 *
 * 止盈执行模型（--tp-order，2026-09-21 追加）
 *   market（默认）：止盈按市价平仓（taker 费率 = feeBps/2）—— 与加本开关前逐字节一致；
 *   limit：止盈挂 post_only 限价，成交按 maker 费率（--makerFee）计；
 *          止损/爆仓/时间止损/趋势反转仍按 taker（要确定性）；只在触及止盈价的那根 K 内成交。
 *   ⚠ 限价挂单不保证成交 → 用 --tp-fill-mode/--tp-fill-rate 建模成交率（默认 touch/p=1 = 上界，无成交风险）。
 */
'use strict';

/* 代理必须在 require(../modules/universe) 之前设好（config.js 在加载时读 env） */
if (!process.env.PROXY_URL && !process.env.HTTPS_PROXY) process.env.PROXY_URL = 'http://127.0.0.1:17890';

const fs = require('fs');
const path = require('path');
const martin = require('../modules/martin');
const risk = require('../modules/risk');
const margin = require('../modules/margin');
const store = require('../modules/store');
const { okxGet } = require('../modules/okx-data');
const uni = require('../modules/universe');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');
const LOOKBACK = 220;   // 需要 EMA200，留 20 根缓冲
const IND_WINDOW = 300; // 指标窗口（与 universe.screen 的 300 根口径一致）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v, n = 4) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(n)) : null);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

/** 带重试的 OKX GET（长跑回测不能被单次 curl 超时/限流打断） */
async function okxGetRetry(pathAndQuery, timeoutMs = 20000, retries = 4, label = '') {
  let lastErr = null;
  for (let i = 0; i <= retries; i++) {
    try { return await okxGet(pathAndQuery, timeoutMs); }
    catch (e) {
      lastErr = e;
      if (i === retries) break;
      const wait = 800 * Math.pow(2, i) + Math.random() * 400;
      console.log(`    ↻ ${label || pathAndQuery.slice(0, 46)} 第 ${i + 1} 次失败（${String(e.message || e).slice(0, 60)}），${Math.round(wait)}ms 后重试`);
      await sleep(wait);
    }
  }
  throw lastErr;
}

const CANDIDATES = ['ETH-USDT-SWAP', 'UNI-USDT-SWAP', 'ARB-USDT-SWAP', 'ENA-USDT-SWAP', 'TRUMP-USDT-SWAP'];
const CONTROLS = ['BTC-USDT-SWAP', 'SOL-USDT-SWAP', 'DOGE-USDT-SWAP'];
const ALL = [...CANDIDATES, ...CONTROLS];

/** 板块归类（与 modules/universe.js 的 sectorOf 同表；universe 未导出该函数，这里保持同源） */
function sectorOf(instId) {
  const base = String(instId).split('-')[0];
  const MEME = ['DOGE', 'SHIB', 'PEPE', 'WIF', 'BONK', 'FLOKI', 'MEME', '1000PEPE', '1000SHIB', '1000BONK', '1000FLOKI', 'TRUMP', 'POPCAT', 'MEW', 'BOME', 'NEIRO', 'MOODENG', 'PNUT', 'ACT', 'GOAT'];
  const L1 = ['BTC', 'ETH', 'SOL', 'BNB', 'AVAX', 'ADA', 'TRX', 'TON', 'SUI', 'APT', 'NEAR', 'SEI', 'DOT', 'ATOM', 'FTM', 'S', 'INJ', 'TIA', 'ETC', 'LTC', 'BCH', 'XRP', 'HBAR', 'ALGO'];
  const L2 = ['ARB', 'OP', 'MATIC', 'POL', 'STRK', 'ZK', 'MANTA', 'METIS', 'IMX', 'BASE'];
  const DEFI = ['UNI', 'AAVE', 'CRV', 'MKR', 'COMP', 'SUSHI', 'SNX', 'LDO', 'PENDLE', 'GMX', 'DYDX', '1INCH'];
  if (MEME.includes(base)) return 'MEME';
  if (L2.includes(base)) return 'L2';
  if (DEFI.includes(base)) return 'DeFi';
  if (L1.includes(base)) return 'L1';
  return 'Other:' + base.slice(0, 3);
}

/* ── 数据抓取（带本地缓存） ─────────────────────── */

function cachePath(kind, instId, extra = '') {
  return path.join(CACHE_DIR, `${kind}-${instId}${extra}.json`);
}
function readCache(file, maxAgeMs) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || !Array.isArray(j.rows)) return null;
    if (maxAgeMs && Date.now() - Number(j.fetchedAt || 0) > maxAgeMs) return null;
    return j;
  } catch { return null; }
}
function writeCache(file, rows) {
  store.ensureDir(CACHE_DIR);
  fs.writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), rows }), 'utf8');
}

/** 历史 K 线分页（每页 100，向过去翻页） */
async function fetchCandles(instId, bar, targetBars, log) {
  const file = cachePath('candles', instId, `-${bar}-${targetBars}`);
  const cached = readCache(file, 6 * 3600e3);
  if (cached && cached.rows.length >= targetBars * 0.95) return { rows: cached.rows, cached: true };

  const out = new Map();
  let after = Date.now() + 3600e3;
  let pages = 0;
  while (out.size < targetBars && pages < 200) {
    const j = await okxGetRetry(`/api/v5/market/history-candles?instId=${instId}&bar=${bar}&limit=100&after=${after}`, 20000, 4, `${instId} K线 p${pages + 1}`);
    const rows = j.data || [];
    if (!rows.length) break;
    for (const d of rows) out.set(Number(d[0]), { ts: Number(d[0]), o: +d[1], h: +d[2], l: +d[3], c: +d[4], v: +d[5] });
    after = Number(rows[rows.length - 1][0]);
    pages++;
    await sleep(160);                      // 限流 ~10 req/s
  }
  let rows = [...out.values()].sort((a, b) => a.ts - b.ts);
  // 丢掉未收盘的当根
  const now = Date.now();
  rows = rows.filter((r) => r.ts + 3600e3 <= now);
  if (rows.length) writeCache(file, rows);
  if (log) log(`  ${instId} K线 ${rows.length} 根（${pages} 页${cached ? '' : ''}）`);
  return { rows, cached: false };
}

/** 资金费率历史分页（每 8 小时一条，向过去翻页）
 *  ⚠ OKX 只提供约 3 个月（实测 ~287 条 / 95 天）的历史，更早的拉不到 → 报告里必须声明覆盖区间
 */
async function fetchFunding(instId, sinceTs, log) {
  const file = cachePath('funding', instId);
  // 缓存接受条件：覆盖到 sinceTs，或已覆盖到「API 深度极限」（再翻页也没用，避免无意义重拉）
  const depthLimit = Date.now() - 85 * 86400e3;
  const cached = readCache(file, 6 * 3600e3);
  if (cached && cached.rows.length && Number(cached.rows[0].ts) <= Math.max(sinceTs, depthLimit) + 86400e3) {
    return { rows: cached.rows, cached: true };
  }

  const out = new Map();
  let after = Date.now() + 3600e3;
  let pages = 0;
  while (pages < 120) {
    const j = await okxGetRetry(`/api/v5/public/funding-rate-history?instId=${instId}&limit=100&after=${after}`, 20000, 4, `${instId} 费率 p${pages + 1}`);
    const rows = j.data || [];
    if (!rows.length) break;
    let oldest = Infinity;
    for (const d of rows) {
      const ts = Number(d.fundingTime);
      out.set(ts, { ts, rate: Number(d.realizedRate !== undefined && d.realizedRate !== '' ? d.realizedRate : d.fundingRate) });
      if (ts < oldest) oldest = ts;
    }
    after = oldest;
    pages++;
    await sleep(160);
    if (oldest <= sinceTs) break;
  }
  const rows = [...out.values()].filter((r) => r.ts >= sinceTs - 8 * 3600e3).sort((a, b) => a.ts - b.ts);
  if (rows.length) writeCache(file, rows);
  if (log) log(`  ${instId} 资金费率 ${rows.length} 条（${pages} 页）`);
  return { rows, cached: false };
}

/* ── 指标（只用 i-1 及更早收盘） ────────────────── */

/**
 * 指标（全部只用 i-1 及更早收盘）
 * @param {number} [zWin] >0 时额外算 entryZ（入场时机 z-score）；0 = 不算（与旧版逐字节一致）
 */
function buildIndicators(candles, zWin = 0) {
  const ind = new Array(candles.length).fill(null);
  const zw = Number(zWin) > 0 ? Math.max(2, Math.floor(Number(zWin))) : 0;
  for (let i = LOOKBACK; i < candles.length; i++) {
    const slice = candles.slice(Math.max(0, i - IND_WINDOW), i);   // ← 决不含第 i 根
    const atrPct = uni.atrPct(slice, 14);
    const rg = uni.classifyRegime(slice);
    /* Task A：regime 选品过滤量（全部只用 i-1 及更早收盘，与 slice 同口径） */
    const lr = [];
    for (let k = 1; k < slice.length; k++) lr.push(Math.log(slice[k].c / slice[k - 1].c));
    const vr5 = uni.varianceRatio(lr, 5);
    const rho1 = uni.autocorr1(lr);
    const rf = uni.reversionFrequency(slice);
    const prevC = candles[i - 1].c;
    const chg1h = i >= 2 && candles[i - 2].c ? (prevC / candles[i - 2].c - 1) * 100 : null;
    let entryZ = null;
    if (zw && i >= zw) {
      const closes = [];
      for (let k = i - zw; k <= i - 1; k++) closes.push(candles[k].c);   // ← 截止 i-1 收盘
      entryZ = martin.zScore(closes, zw);
    }
    ind[i] = {
      atrPct,
      atrPx: atrPct != null ? (atrPct / 100) * prevC : null,
      prevClose: prevC,
      chg1h,
      entryZ,
      vr5, rho1, rf,
      regime: { ...rg, barChangePct: chg1h, vr5, rho1, rf },
    };
  }
  return ind;
}

const indCache = new Map();
function indicatorsFor(instId, candles, zWin = 0) {
  const zw = Number(zWin) > 0 ? Math.max(2, Math.floor(Number(zWin))) : 0;
  const key = `${instId}|${candles.length}|${candles[0] && candles[0].ts}|${candles[candles.length - 1] && candles[candles.length - 1].ts}|${candles[0] && candles[0].c}|${candles[candles.length - 1] && candles[candles.length - 1].c}|${IND_WINDOW}|z${zw}`;
  if (!indCache.has(key)) indCache.set(key, buildIndicators(candles, zw));
  return indCache.get(key);
}

/* ── 回测核心 ──────────────────────────────────── */

/**
 * @param {object} opt
 * @param {Array}  opt.data  [{instId, sector, instrument, candles, funding}]
 * @param {object} opt.policy
 * @param {number} opt.equity0
 * @param {number} opt.feeBps  单边成本（bps）；「8bps 双边」= 4bps/边 → 传 4 即可得到往返 8bps，
 *                             默认 param 见 CLI（--fee 8 表示往返 8bps，脚本内 /2 分摊到每次成交）
 * @param {boolean} opt.fundingIncluded
 * @param {number|null} opt.makerFeeBps  maker 单边费率（bps）；null = 与 taker 同价（无差额）
 * @param {number} opt.makerTimeoutBars  maker 限价单超时根数（超时转市价，taker 成交）；null/省略 = 取 policy.makerTimeoutBars
 * @param {string} opt.sizingMode  政策 sizingMode='risk' 时用 modules/margin.js 的风险预算反解首层（实盘口径）；否则旧口径
 * @param {boolean} opt.trackOccupancy 记录占用曲线统计（默认 false → 返回体与旧版一致）
 * @param {string|null} opt.tpFillMode 止盈限价成交模型 touch|prob|confirm（仅 policy.tpOrderType='limit' 时有意义；null/省略 = touch）
 * @param {number|null} opt.tpFillRate prob 模型的成交概率（默认 1 = 必成交；prob 模型外的值不影响结果）
 * @param {string|number|null} opt.tpFillSeed prob 模型的随机盐（默认 null = 原键；多盐平均可降单个轨迹的噪声）
 */
function simulate({ data, policy, equity0 = 10000, feeBps = 8, fundingIncluded = true, equityCurve = false, slipBps = 0, startTs = undefined, makerFeeBps = null, makerTimeoutBars = null, trackOccupancy = false, tpFillMode = null, tpFillRate = null, tpFillSeed = null }) {
  const p = martin.normPolicy(policy);
  const sideFee = feeBps / 2 / 10000;      // 双边总 bps → 每次成交单边成本
  const makerOn = martin.makerFirstOn(p);
  const makerSideFee = makerFeeBps === null || makerFeeBps === undefined ? sideFee : Number(makerFeeBps) / 10000;
  /* 止盈执行模型：默认 market ⇒ tpLimitOn=false ⇒ 下面所有新分支都不进入（与旧版逐字节一致） */
  const tpLimitOn = martin.tpOrderIsLimit(p);
  const tpFillM = tpFillMode === 'prob' || tpFillMode === 'confirm' ? tpFillMode : 'touch';
  const tpFillRateN = Number.isFinite(Number(tpFillRate)) ? Number(tpFillRate) : 1;
  const tpFillSalt = tpFillSeed === null || tpFillSeed === undefined || tpFillSeed === '' ? '' : `|${tpFillSeed}`;
  const mtRaw = makerTimeoutBars === null || makerTimeoutBars === undefined ? p.makerTimeoutBars : makerTimeoutBars;
  const makerTimeout = Math.max(1, Math.floor(Number(mtRaw) || 1));
  const riskSizing = p.sizingMode === 'risk';       // 实盘口径（风险预算反解）；默认关 → 旧行为逐字节一致
  /* 指标：z-score 窗口随 policy 走（entryZMin=0 时不计算 → 与旧版本逐字节一致） */
  const zWin = p.entryZMin > 0 ? Math.max(2, Math.floor(p.entryZWin)) : 0;
  for (const s of data) s.ind = indicatorsFor(s.instId, s.candles, zWin);
  let equity = equity0;
  const tsset = new Set();
  for (const s of data) for (const b of s.candles) tsset.add(b.ts);
  const tsList = [...tsset].sort((a, b) => a - b);
  const sym = new Map(data.map((s) => [s.instId, s]));
  const barAt = new Map();
  for (const s of data) {
    const m = new Map();
    s.candles.forEach((b, idx) => m.set(b.ts, { bar: b, idx }));
    barAt.set(s.instId, m);
  }

  const lastClose = {};
  const fundPtr = {};
  for (const s of data) { fundPtr[s.instId] = 0; lastClose[s.instId] = s.candles[0].c; }

  const state = store.emptyState({ policy: p });
  const open = [];
  const trades = [];
  const curve = [];
  const counters = { breakerDays: 0, blockedByMinSz: 0, opensRejected: 0, opensOk: 0, addBlocked: 0, trendFlip: 0 };
  /* Task B/C 计数（默认参数下恒为 0 → 旧报告逐字节兼容） */
  counters.trendFlipPending = 0; counters.trendFlipReduce = 0; counters.partialTp = 0;
  if (makerOn) { counters.makerEntryFills = 0; counters.makerEntryTimeout = 0; }
  if (riskSizing) { counters.sizingRejected = 0; counters.occupancyRejected = 0; }
  if (tpLimitOn) { counters.tpMakerFills = 0; counters.tpMakerMisses = 0; }
  const tpmSaving = { usd: 0, notional: 0, makerFills: 0 };   // 止盈 maker 节省累计（仅 limit 模式）
  const pending = new Map();   // maker 挂单：instId → { side, limit, barsWaited, sector, atr, regime }
  const occCapPct = Number.isFinite(Number(p.maxTotalOccupancyPct)) && Number(p.maxTotalOccupancyPct) > 0 ? Number(p.maxTotalOccupancyPct) : null;
  const occ = trackOccupancy ? { samples: 0, sumPct: 0, maxPct: 0, aboveCapBars: 0, capPct: occCapPct, maxBaskets: 0, basketOpenBars: 0, above80Bars: 0, above100Bars: 0 } : null;
  // 费率数据覆盖度追踪（notional×小时），用于把「覆盖期内实测费率」外推到未覆盖区间
  const covStart = {};
  for (const s of data) covStart[s.instId] = s.funding && s.funding.length ? s.funding[0].ts : Infinity;
  const exposure = { covNotionalHours: 0, uncovNotionalHours: 0 };

  let curDay = null, dayStartEquity = equity, dayBreached = false;
  let peak = equity, maxDD = 0;
  let prevTs = tsList[0];

  const unrealized = () => open.reduce((a, b) => a + martin.basketPnl(b, lastClose[b.instId] || 0).upl, 0);
  const usedMargin = () => open.reduce((a, b) => a + martin.totalMargin(b), 0);

  function chargeFee(b, contracts, price, feeOverride) {
    const rate = feeOverride === undefined || feeOverride === null ? sideFee : Number(feeOverride);
    const f = b.ctVal * contracts * price * rate;
    b.feesUsd = round(b.feesUsd + f, 6);
    equity -= f;
    return f;
  }

  /**
   * 减仓 / 部分止盈事件记账（Task B/C；默认参数下不会触发 → 与旧版逐字节一致）。
   * martin.reduceExposure 已把已实现盈亏累计到 basket.partialRealizedUsd（未入 equity），
   * 这里按 taker 计费并结算到 equity；最终平仓时 finalize 再把 partialRealizedUsd 计入本笔盈亏。
   */
  function applyReduceEvents(b, evs) {
    let any = false;
    for (const ev of evs || []) {
      if (ev.type !== 'trend_flip_reduce' && ev.type !== 'partial_tp') continue;
      any = true;
      const notional = b.ctVal * Number(ev.contracts) * Number(ev.fillPx);
      const fee = notional * sideFee;
      b.feesUsd = round(b.feesUsd + fee, 6);
      equity += Number(ev.pnlUsd) - fee;
      if (slipBps > 0) b.slipCostUsd = round((Number(b.slipCostUsd) || 0) + b.ctVal * Number(ev.contracts) * Math.abs(Number(ev.fillPx) - Number(ev.triggerPx)), 8);
      if (ev.type === 'trend_flip_reduce') counters.trendFlipReduce++; else counters.partialTp++;
      b.reduceEvents = (Number(b.reduceEvents) || 0) + 1;
    }
    return any;
  }

  /** 趋势翻转等待事件计数（confirm/half：未确认不平篮，仅计数） */
  function countFlipPending(b, evs) {
    for (const ev of evs || []) if (ev.type === 'trend_flip_pending') counters.trendFlipPending++;
  }

  /** 以给定成交价开新篮子（maker 模式标记成交类型；默认参数下与旧路径完全一致）
   *  sizingMode='risk' 时改走 modules/margin.planBasket（实盘同口径：风险预算反解 + 占用上限），
   *  并把计划的第 1 层张数/保证金回写到篮子上，保证回测与实盘同尺寸。 */
  function openBasketAt(s, side, sector, ind, fillPx, ts2, isMaker) {
    const fill = martin.entryFillPx(fillPx, side, slipBps);
    let pol = p;
    let force = null;
    if (riskSizing) {
      const plan = margin.planBasket({
        equity, atrPct: ind.atrPct, price: fill, instrument: s.instrument, policy: p,
        openBaskets: open, sector, side,
      });
      if (!plan.ok) {
        counters.opensRejected++;
        if (/占用上限/.test(plan.reason)) counters.occupancyRejected++; else counters.sizingRejected++;
        return null;
      }
      const stopPct = Number.isFinite(Number(p.maxBasketRiskPct)) && Number(p.maxBasketRiskPct) > 0 ? Number(p.maxBasketRiskPct) : p.hardStopPct;
      pol = { ...p, firstMarginPct: (plan.layer1MarginUsd / equity) * 100, hardStopPct: stopPct };
      force = { contracts: plan.layer1Contracts, marginUsd: plan.layer1MarginUsd, riskAtDeathUsd: plan.riskAtDeathUsd, occupancyPct: plan.occupancyPct };
    }
    const b = martin.newBasket({
      instId: s.instId, side, sector, price: fill, atr: ind.atrPx,
      policy: pol, instrument: s.instrument, equity, ts: ts2, regime: ind.regime,
    });
    if (!b) { counters.opensRejected++; counters.blockedByMinSz++; return null; }
    if (force) {
      b.levels[0].contracts = force.contracts;
      b.levels[0].marginUsd = force.marginUsd;
      b.firstMarginUsd = force.marginUsd;
      b.riskAtDeathUsd = force.riskAtDeathUsd;
      b.occupancyPctAtOpen = force.occupancyPct;
    }
    if (slipBps > 0) {   // 滑点成本可追溯：成交价（含滑点）与触发价差额 × 名义（仅 --slip > 0 时统计）
      const lv0 = b.levels[0];
      b.slipCostUsd = round((Number(b.slipCostUsd) || 0) + b.ctVal * lv0.contracts * Math.abs(lv0.price - Number(fillPx)), 8);
    }
    chargeFee(b, b.levels[0].contracts, b.levels[0].price, makerOn && isMaker ? makerSideFee : undefined);
    b.maxUplPct = 0;
    if (makerOn) {
      b.entryFillType = isMaker ? 'maker' : 'taker_timeout';
      b.levels[0].fillType = isMaker ? 'maker' : 'taker';
    }
    open.push(b);
    counters.opensOk++;
    return b;
  }

  /** 平仓收尾；nomPx = 本次平仓的「触发价」（未加滑点），用于把滑点成本拆出来（仅 --slip > 0） */
  function finalize(b, nomPx) {
    if (slipBps > 0) {
      const np = Number(nomPx) > 0 ? Number(nomPx) : b.closePrice;
      b.slipCostUsd = round((Number(b.slipCostUsd) || 0) + b.ctVal * martin.totalContracts(b) * Math.abs(b.closePrice - np), 8);
    }
    const pnl = martin.basketPnl(b, b.closePrice);
    const partialUsd = Number(b.partialRealizedUsd) || 0;   // Task B/C 减仓已实现（默认 0）
    /* 止盈限价成交 → 平仓腿按 maker 费率计（其余离场一律 taker，要确定性）；
     * tpLimitOn=false 时 tpMakerExit 恒 false ⇒ exitRate === sideFee，数值逐位一致。 */
    const tpMakerExit = tpLimitOn && b.tpMakerFill === true && b.closeReason === 'take_profit';
    const exitRate = tpMakerExit ? makerSideFee : sideFee;
    const exitFee = b.ctVal * martin.totalContracts(b) * b.closePrice * exitRate;
    b.feesUsd = round(b.feesUsd + exitFee, 6);
    equity += pnl.upl - exitFee;
    let tpSavingUsd = 0, tpNotionalUsd = 0;
    if (tpMakerExit) {
      tpNotionalUsd = b.ctVal * martin.totalContracts(b) * b.closePrice;
      tpSavingUsd = tpNotionalUsd * (sideFee - makerSideFee);
      tpmSaving.usd += tpSavingUsd; tpmSaving.notional += tpNotionalUsd; tpmSaving.makerFills++;
    }

    const netPnl = pnl.upl + partialUsd - b.feesUsd - (fundingIncluded ? b.fundingUsd : 0);
    const eqAtOpen = Number(b.equityAtOpen) || equity0;
    // 费率覆盖度：把持仓期拆成「有费率数据」与「无费率数据」两段（按 notional×小时 计权）
    const notionalAvg = b.ctVal * martin.totalContracts(b) * martin.avgPrice(b);
    const cov0 = covStart[b.instId];
    const hrsCovered = Number.isFinite(cov0) ? Math.max(0, (b.closedAt - Math.max(b.openedAt, cov0)) / 3600e3) : 0;
    const hrsTotal = (b.closedAt - b.openedAt) / 3600e3;
    exposure.covNotionalHours += notionalAvg * hrsCovered;
    exposure.uncovNotionalHours += notionalAvg * Math.max(0, hrsTotal - hrsCovered);
    const maxLevels = Math.max(...b.levels.map((l) => l.idx)) + 1;
    const makerSides = (b.levels || []).filter((l) => l.fillType === 'maker').length;
    const trade = {
      instId: b.instId, side: b.side, sector: b.sector,
      openedAt: new Date(b.openedAt).toISOString(), closedAt: new Date(b.closedAt).toISOString(),
      levels: maxLevels, maxLevels,
      hasFullLevels: maxLevels >= p.maxLevels,
      pnlUsd: round(netPnl, 4),
      pnlPct: round((netPnl / eqAtOpen) * 100, 4),
      grossPnlUsd: round(pnl.upl + partialUsd, 4),
      feesUsd: round(b.feesUsd, 4),
      fundingUsd: round(b.fundingUsd, 4),
      reason: b.closeReason,
      hours: round((b.closedAt - b.openedAt) / 3600e3, 2),
      avgPx: round(martin.avgPrice(b), 8),
      closePrice: b.closePrice,
      levelsDetail: b.levels.map((l) => ({ idx: l.idx, ts: new Date(l.ts).toISOString(), price: l.price, contracts: l.contracts, marginUsd: l.marginUsd, reason: l.reason, atrPx: l.atrPx === undefined ? null : l.atrPx, ...(makerOn ? { fillType: l.fillType || null } : {}) })),
      maxUplPct: b.maxUplPct === undefined ? null : b.maxUplPct,
      equityAtOpen: round(eqAtOpen, 2),
    };
    if (makerOn) {   // 仅 maker 模式追加（默认 off → 报告 JSON 不变）
      trade.entryFillType = b.entryFillType || 'maker';
      trade.makerSides = makerSides;
      trade.takerSides = b.levels.length - makerSides + 1;
    }
    if (riskSizing) {   // 仅风险仓位模式追加
      trade.riskAtDeathUsd = round(Number(b.riskAtDeathUsd) || 0, 4);
      trade.occupancyPctAtOpen = b.occupancyPctAtOpen === undefined ? null : b.occupancyPctAtOpen;
    }
    if (slipBps > 0) trade.slipCostUsd = round(Number(b.slipCostUsd) || 0, 6);   // 仅 --slip > 0 写入
    if (partialUsd !== 0 || (Number(b.partialRealizedContracts) || 0) > 0) {      // 仅减仓模式追加
      trade.partialRealizedUsd = round(partialUsd, 4);
      trade.partialRealizedContracts = round(Number(b.partialRealizedContracts) || 0, 10);
      trade.reduceEvents = Number(b.reduceEvents) || 0;
    }
    if (tpLimitOn) {    // 仅止盈限价模式追加（默认 market → 报告 JSON 不变）
      trade.tpMakerExit = tpMakerExit;
      trade.tpMakerSavingUsd = round(tpSavingUsd, 6);
      trade.tpMakerNotionalUsd = round(tpNotionalUsd, 6);
      trade.tpMakerSavingBpsNotional = tpNotionalUsd > 0 ? round((tpSavingUsd / tpNotionalUsd) * 10000, 4) : 0;
      trade.tpMakerSavingBpsEquity = eqAtOpen > 0 ? round((tpSavingUsd / eqAtOpen) * 10000, 4) : 0;
    }
    trades.push(trade);
    state.closed.push({ id: b.id, instId: b.instId, reason: b.closeReason, pnlUsd: trade.pnlUsd, closedAt: b.closedAt });
    if (state.closed.length > 3000) state.closed.splice(0, state.closed.length - 3000);
    risk.markCooldown(state, b.instId, p, b.closedAt);
    const i = open.indexOf(b);
    if (i >= 0) open.splice(i, 1);
    return trade;
  }

  for (const ts of tsList) {
    /* 0) 日切：重置当日基准；回测里熔断按「当日」自动解除（实盘需人工，见 risk.settleDay(autoReset:false)） */
    const day = new Date(ts).toISOString().slice(0, 10);
    if (day !== curDay) {
      if (curDay !== null && dayBreached) counters.breakerDays++;
      curDay = day; dayStartEquity = equity; dayBreached = false;
    }

    /* 1) 资金费：落在 (prevTs, ts] 区间的费率结算 */
    if (fundingIncluded) {
      for (const s of data) {
        const f = s.funding || [];
        while (fundPtr[s.instId] < f.length && f[fundPtr[s.instId]].ts <= ts) {
          const ev = f[fundPtr[s.instId]];
          fundPtr[s.instId]++;
          if (ev.ts > prevTs) {
            for (const b of open) {
              if (b.instId !== s.instId) continue;
              const notional = b.ctVal * martin.totalContracts(b) * (lastClose[b.instId] || martin.avgPrice(b));
              const cost = notional * ev.rate * (b.side === 'long' ? 1 : -1);   // 多付空收
              b.fundingUsd = round(b.fundingUsd + cost, 6);
              equity -= cost;
            }
          }
        }
      }
    }

    /* 2) 开新篮子（决策用 i-1 收盘，成交用当根 open） */
    const trading = startTs === undefined || ts >= startTs;   // walk-forward：startTs 之前只预热，不交易
    if (trading) {
    const todayPnlPct = dayStartEquity > 0 ? ((equity + unrealized() - dayStartEquity) / dayStartEquity) * 100 : 0;
    if (todayPnlPct <= -p.dailyLossPct) dayBreached = true;

    for (const s of data) {
      const m = barAt.get(s.instId);
      const rec = m && m.get(ts);
      if (!rec) continue;
      const ind = s.ind[rec.idx];
      if (!ind) continue;

      /* 2a) maker 挂单结算：上一根挂出的 post_only 限价单，本根触及 → maker 成交；超时 → 转市价（taker） */
      if (makerOn) {
        const pd = pending.get(s.instId);
        if (pd) {
          pd.barsWaited++;
          const touched = pd.side === 'long' ? rec.bar.l <= pd.limit : rec.bar.h >= pd.limit;
          if (!touched && pd.barsWaited < makerTimeout) continue;
          const fillPx = touched ? pd.limit : rec.bar.c;
          pending.delete(s.instId);
          if (open.length >= p.maxBaskets) { counters.opensRejected++; continue; }
          const nb = openBasketAt(s, pd.side, pd.sector, ind, fillPx, ts, touched);
          if (nb) counters[touched ? 'makerEntryFills' : 'makerEntryTimeout']++;
          continue;
        }
      }

      if (open.some((b) => b.instId === s.instId)) continue;
      if (open.length >= p.maxBaskets) break;
      const fnd = fundingAt(s.funding, ts);
      const so = martin.shouldOpen({
        policy: p, regime: ind.regime, funding: fnd, atrPct: ind.atrPct, equity,
        openBaskets: open, sector: s.sector, todayPnlPct, barChangePct: ind.chg1h, entryZ: ind.entryZ,
        vr5: ind.vr5, rf: ind.rf, adx: ind.regime && ind.regime.adx,
      });
      if (!so.ok) { counters.opensRejected++; continue; }
      const g = risk.gate({
        state, policy: p, equity, todayPnlPct, funding: fnd, sector: s.sector,
        openBaskets: open, instId: s.instId, atrPct: ind.atrPct, barChangePct: ind.chg1h, now: ts,
      });
      if (!g.allow) { counters.opensRejected++; continue; }
      if (makerOn) {
        /* 先挂 post_only 限价（锚定本根 open），下一根结算：触及 = maker，超时 = 市价（taker） */
        pending.set(s.instId, { side: so.side, sector: s.sector, limit: rec.bar.o, barsWaited: 0, atr: ind.atrPx, regime: ind.regime });
        continue;
      }
      openBasketAt(s, so.side, s.sector, ind, rec.bar.o, ts, false);
    }

    /* 3) 篮子巡检：含当根新开的篮子（开仓价 = 当根 open，当根剩余行情照常参与触发）
     *    先不利路径（爆仓/止损/加仓），再有利路径（止盈） */
    for (const b of [...open]) {
      const m = barAt.get(b.instId);
      const rec = m && m.get(ts);
      if (!rec) continue;
      const st = sym.get(b.instId);
      const ind = st.ind[rec.idx];
      if (!ind) continue;
      const bar = rec.bar;
      const dir = b.side === 'long' ? 1 : -1;
      const ctxBase = { atr: ind.atrPx, atrPct: ind.atrPct, regime: ind.regime, ts, slipBps };
      /* 可用保证金：实盘口径下把「全场占用上限」也纳入 → 占用超限时加仓会被 add_blocked 拦下
       * （实盘调度器同样应传这个值；非 risk 模式不启用 → 旧行为逐字节一致） */
      const occCapUsd = riskSizing && occCapPct !== null ? (equity * occCapPct) / 100 : null;
      const freeMargin = Math.max(0, equity - usedMargin());
      const availMargin = occCapUsd === null ? freeMargin : Math.max(0, Math.min(freeMargin, occCapUsd - usedMargin()));
      let guard = 0;

      // 3-b0) 止盈限价挂单的跨根确认（confirm 模型）：上一根触及后，本根「开盘仍在止盈价之外」→ 成交
      //       （挂单在开盘瞬间被吃，时间上早于同一根内的其它离场判定；只用本根 open → 不偷看当根/未来）
      //       regime 传 null：限价成交是挂单被吃，不应被趋势反转抢占；atr 传 null（成交价就是挂单价）
      if (tpLimitOn && b.tpWait && !b.closed) {
        const lim = b.tpWait.limit;
        b.tpWait = null;
        if (tpLimitConfirmFilled(b.side, lim, bar.o)) {
          martin.onPrice(b, { ...ctxBase, regime: null, atr: null, slipBps: 0, price: lim, availableMarginUsd: availMargin });
          if (b.closed) {
            if (b.closeReason === 'take_profit') { b.tpMakerFill = true; counters.tpMakerFills++; }
            finalize(b, lim);
            continue;
          }
        }
      }

      // 3-0) 状态型离场：时间止损 / 趋势反转 —— 用 i-1 收盘判定，按当根 open 成交
      //      （调度器每 30s 巡检，不可能只在“价格碰到挂单价”那根才检查）
      if (b.levels[0].ts !== ts) {
        const r0 = martin.onPrice(b, { ...ctxBase, price: bar.o, availableMarginUsd: availMargin });
        countFlipPending(b, r0.events);
        applyReduceEvents(b, r0.events);
        for (const ev of r0.events) {
          if (ev.type === 'add') {
            if (slipBps > 0) b.slipCostUsd = round((Number(b.slipCostUsd) || 0) + b.ctVal * ev.contracts * Math.abs(ev.fillPx - ev.addPx), 8);
            chargeFee(b, ev.contracts, ev.addPx, makerOn ? makerSideFee : undefined);
            if (makerOn) { const lv0 = b.levels[b.levels.length - 1]; if (lv0) lv0.fillType = 'maker'; }
          }
        }
        if (b.closed) { finalize(b, bar.o); continue; }
      }

      // 3a) 不利路径：可能连续触发（爆仓 / 止损 / 加仓 / 加仓后再爆仓）
      while (!b.closed && guard++ < 12) {
        const liqPx = martin.liquidationPrice(b);
        const stopPx = martin.stopPrice(b);
        const addPx = martin.nextAddPrice(b, ind.atrPx);
        const liqHit = liqPx !== null && (dir > 0 ? bar.l <= liqPx : bar.h >= liqPx);
        const stopHit = stopPx !== null && (dir > 0 ? bar.l <= stopPx : bar.h >= stopPx);
        const addHit = addPx !== null && (dir > 0 ? bar.l <= addPx : bar.h >= addPx);
        let px = null;
        if (liqHit) px = liqPx;                                            // 爆仓：成交在强平价
        else if (stopHit) px = stopPx;                                     // 止损：成交在止损价
        else if (addHit) px = addPx;                                       // 加仓：成交在挂单价
        else break;
        const before = b.levels.length;
        const r = martin.onPrice(b, { ...ctxBase, price: px, availableMarginUsd: availMargin });
        countFlipPending(b, r.events);
        applyReduceEvents(b, r.events);
        for (const ev of r.events) {
          if (ev.type === 'add') {
            /* 加仓是提前挂在目标层价上的限价单，被触及即成交 → maker 计费 */
            if (slipBps > 0) b.slipCostUsd = round((Number(b.slipCostUsd) || 0) + b.ctVal * ev.contracts * Math.abs(ev.fillPx - ev.addPx), 8);
            chargeFee(b, ev.contracts, ev.addPx, makerOn ? makerSideFee : undefined);
            if (makerOn) { const lv = b.levels[b.levels.length - 1]; if (lv) lv.fillType = 'maker'; }
          }
          else if (ev.type === 'add_blocked') { counters.addBlocked++; if (/minSz/.test(ev.reason)) counters.blockedByMinSz++; }
        }
        if (b.closed) finalize(b, px);
        if (b.levels.length === before && !r.events.some((e) => e.type === 'add')) break;
      }

      // 3b) 有利路径：部分止盈（Task C，默认 off → ptpPx 恒 null）
      if (!b.closed) {
        const ptpPx = martin.partialTpPrice(b);
        const ptpHit = ptpPx !== null && (dir > 0 ? bar.h >= ptpPx : bar.l <= ptpPx);
        if (ptpHit) {
          const r = martin.onPrice(b, { ...ctxBase, price: ptpPx, availableMarginUsd: availMargin });
          applyReduceEvents(b, r.events);
          if (b.closed) { finalize(b, ptpPx); continue; }
        }
      }

      // 3c) 有利路径：整篮止盈（成交在止盈价）
      //     tpOrderType='limit'：止盈挂 post_only 限价 → 成交按 maker 计费；成交价就是挂单价（不施加滑点——
      //     限价单的代价是「可能挂不上」，由 tpFillMode/tpFillRate 建模，而不是滑点）。
      //     默认 market → tpLimitOn=false ⇒ 下面与原代码逐字节一致。
      if (!b.closed) {
        const tpPx = martin.takeProfitPrice(b, ind.atrPct);
        const tpHit = tpPx !== null && (dir > 0 ? bar.h >= tpPx : bar.l <= tpPx);
        if (tpHit) {
          const filled = !tpLimitOn || tpLimitTouchFills(tpFillM, tpFillRateN, detUniform(`${b.id}|${ts}${tpFillSalt}`));
          if (filled) {
            const r = martin.onPrice(b, { ...(tpLimitOn ? { ...ctxBase, slipBps: 0 } : ctxBase), price: tpPx, availableMarginUsd: availMargin });
            if (b.closed) {
              if (tpLimitOn && b.closeReason === 'take_profit') { b.tpMakerFill = true; counters.tpMakerFills++; }
              finalize(b, tpPx);
            }
          } else if (tpLimitOn) {
            counters.tpMakerMisses++;      // 限价未成交：继续持有（后续根再触及可再抽样/再确认）
            if (tpFillM === 'confirm') b.tpWait = { limit: tpPx, ts };
          }
        }
      }

      // 3d) 更新本篮最大浮盈（诊断）
      const cur = martin.basketPnl(b, bar.c);
      if (b.maxUplPct === undefined || cur.uplPct > b.maxUplPct) b.maxUplPct = cur.uplPct;
    }
    }

    /* 4) 记账 */
    for (const s of data) { const m = barAt.get(s.instId); const rec = m && m.get(ts); if (rec) lastClose[s.instId] = rec.bar.c; }
    const eqMtm = equity + unrealized();
    if (occ) {
      const um = usedMargin();
      const pv = equity > 0 ? (um / equity) * 100 : 0;
      occ.samples++;
      occ.sumPct += pv;
      if (pv > occ.maxPct) occ.maxPct = pv;
      if (occCapPct !== null && pv > occCapPct) occ.aboveCapBars++;
      if (pv > 80) occ.above80Bars++;
      if (pv > 100) occ.above100Bars++;
      if (open.length > occ.maxBaskets) occ.maxBaskets = open.length;
      if (open.length > 0) occ.basketOpenBars++;
    }
    if (eqMtm > peak) peak = eqMtm;
    const dd = peak > 0 ? ((eqMtm - peak) / peak) * 100 : 0;
    if (dd < maxDD) maxDD = dd;
    if (equityCurve) curve.push({ ts, equity: round(equity, 4), eqMtm: round(eqMtm, 4) });
    prevTs = ts;
  }

  /* 未平仓的按最后价强平（回测收尾，不计入 closed 的止损统计） */
  for (const b of [...open]) {
    const px = lastClose[b.instId];
    const dir = b.side === 'long' ? 1 : -1;
    const tp = martin.takeProfitPrice(b);
    martin.onPrice(b, { price: b.side === 'long' ? Math.min(px, tp) : Math.max(px, tp), atr: null, regime: null, ts: prevTs });
    if (!b.closed) { b.closed = true; b.closedAt = prevTs; b.closeReason = 'eod_close'; b.closePrice = px; }
    finalize(b, px);
  }

  /* ── 汇总 ── */
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const grossWin = trades.filter((t) => t.pnlUsd > 0).reduce((a, t) => a + t.pnlUsd, 0);
  const grossLoss = Math.abs(trades.filter((t) => t.pnlUsd < 0).reduce((a, t) => a + t.pnlUsd, 0));
  const reasonCount = (r) => trades.filter((t) => t.reason === r).length;
  const summary = {
    trades: trades.length,
    winRate: trades.length ? round((wins.length / trades.length) * 100, 2) : null,
    expectancyUsd: trades.length ? round(mean(trades.map((t) => t.pnlUsd)), 4) : null,
    expectancyPct: trades.length ? round(mean(trades.map((t) => t.pnlPct)), 4) : null,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss, 3) : (grossWin > 0 ? null : null),
    maxDrawdownPct: round(maxDD, 2),
    avgLevelsUsed: trades.length ? round(mean(trades.map((t) => t.levels)), 2) : null,
    level6Rate: trades.length ? round((trades.filter((t) => t.hasFullLevels).length / trades.length) * 100, 2) : null,
    stopLossCount: reasonCount('stop_loss'),
    riskStopCount: reasonCount('risk_stop'),
    liquidationCount: reasonCount('liquidation'),
    trendFlipCount: reasonCount('trend_flip'),
    trendFlipPendingEvents: counters.trendFlipPending,
    trendFlipReduceEvents: counters.trendFlipReduce,
    partialTpEvents: counters.partialTp,
    timeStopCount: reasonCount('time_stop'),
    takeProfitCount: reasonCount('take_profit'),
    totalFeesUsd: round(trades.reduce((a, t) => a + t.feesUsd, 0), 4),
    totalFundingUsd: round(trades.reduce((a, t) => a + t.fundingUsd, 0), 4),
    netPnlUsd: round(trades.reduce((a, t) => a + t.pnlUsd, 0), 4),
    avgHours: trades.length ? round(mean(trades.map((t) => t.hours)), 2) : null,
    maxHours: trades.length ? round(Math.max(...trades.map((t) => t.hours)), 2) : null,
    endEquity: round(equity, 2),
    returnPct: round(((equity - equity0) / equity0) * 100, 2),
    counters,
  };
  const perSymbol = data.map((s) => {
    const ts2 = trades.filter((t) => t.instId === s.instId);
    let cum = 0, pk = 0, mdd = 0;
    for (const t of ts2) { cum += t.pnlUsd; if (cum > pk) pk = cum; const d = pk > 0 ? ((cum - pk) / (equity0 + pk)) * 100 : 0; if (d < mdd) mdd = d; }
    return {
      instId: s.instId, sector: s.sector, trades: ts2.length,
      winRate: ts2.length ? round((ts2.filter((t) => t.pnlUsd > 0).length / ts2.length) * 100, 2) : null,
      expectancyPct: ts2.length ? round(mean(ts2.map((t) => t.pnlPct)), 4) : null,
      expectancyUsd: ts2.length ? round(mean(ts2.map((t) => t.pnlUsd)), 4) : null,
      maxLevels: ts2.length ? Math.max(...ts2.map((t) => t.levels)) : 0,
      stopLossCount: ts2.filter((t) => t.reason === 'stop_loss').length,
      maxDDPct: round(mdd, 2),
    };
  });
  /* 止盈限价的手续费节省（仅 limit 模式写入；market 模式报告与原版逐字节一致） */
  if (tpLimitOn) {
    const takerSideBps = round(sideFee * 10000, 6);
    const makerSideBps = round(makerSideFee * 10000, 6);
    summary.tpMaker = {
      tpOrderType: 'limit',
      fillMode: tpFillM,
      fillRate: tpFillRateN,
      takerFeeBps: takerSideBps,
      makerFeeBps: makerSideBps,
      feeDiffBps: round((sideFee - makerSideFee) * 10000, 6),
      makerFills: tpmSaving.makerFills,
      missCount: counters.tpMakerMisses,
      savingUsdTotal: round(tpmSaving.usd, 4),
      savingBpsOfNotional: tpmSaving.notional > 0 ? round((tpmSaving.usd / tpmSaving.notional) * 10000, 4) : null,
      savingBpsOfEquityPerTrade: trades.length ? round(mean(trades.map((t) => t.tpMakerSavingBpsEquity || 0)), 4) : null,
      savingUsdPerTrade: trades.length ? round(tpmSaving.usd / trades.length, 6) : null,
      note: `止盈挂 post_only 限价按 maker ${makerSideBps}bps 计（taker ${takerSideBps}bps，差 ${round((sideFee - makerSideFee) * 10000, 4)}bps/边）；止损/爆仓/时间止损/趋势反转仍 taker。成交模型 ${tpFillM}${tpFillM === 'prob' ? `（p=${tpFillRateN}）` : ''}：未成交则继续持有、后续根重试；maker 限价成交价不加滑点`,
    };
  }

  /* 成本拆解（仅 --slip > 0 时写入；口径可追溯：手续费 / 滑点 / 资金费各自占多少） */
  if (slipBps > 0) {
    const feesTot = trades.reduce((a, t) => a + (Number(t.feesUsd) || 0), 0);
    const fundTot = fundingIncluded ? trades.reduce((a, t) => a + (Number(t.fundingUsd) || 0), 0) : 0;
    const slipTot = trades.reduce((a, t) => a + (Number(t.slipCostUsd) || 0), 0);
    const netTot = trades.reduce((a, t) => a + (Number(t.pnlUsd) || 0), 0);
    const grossNoCost = netTot + feesTot + fundTot + slipTot;      // 无手续费/无滑点/无资金费的毛盈亏
    const meanEq = trades.length ? mean(trades.map((t) => Number(t.equityAtOpen) || equity0)) : equity0;
    const per = (usd) => (trades.length && meanEq > 0 ? round((usd / trades.length / meanEq) * 10000, 3) : null);
    summary.costDecomposition = {
      trades: trades.length,
      feesUsd: round(feesTot, 4), fundingUsd: round(fundTot, 4), slipUsd: round(slipTot, 4),
      totalCostUsd: round(feesTot + fundTot + slipTot, 4),
      grossPnlNoCostUsd: round(grossNoCost, 4), netPnlUsd: round(netTot, 4),
      feesBpsOfEquityPerTrade: per(feesTot),
      slipBpsOfEquityPerTrade: per(slipTot),
      fundingBpsOfEquityPerTrade: per(fundTot),
      totalCostBpsOfEquityPerTrade: per(feesTot + fundTot + slipTot),
      feesShareOfGrossPct: grossNoCost > 0 ? round((feesTot / grossNoCost) * 100, 2) : null,
      slipShareOfGrossPct: grossNoCost > 0 ? round((slipTot / grossNoCost) * 100, 2) : null,
      fundingShareOfGrossPct: grossNoCost > 0 ? round((fundTot / grossNoCost) * 100, 2) : null,
      totalCostShareOfGrossPct: grossNoCost > 0 ? round(((feesTot + fundTot + slipTot) / grossNoCost) * 100, 2) : null,
      meanEquityAtOpen: round(meanEq, 2),
      note: `成本口径：手续费 ${feeBps}bps 往返（每次成交 ${feeBps / 2}bps）· 滑点 ${slipBps}bps/单边 · 资金费 OKX 真实历史；bps 均为「占开仓时权益」口径`,
    };
  }

  const positive = summary.expectancyUsd !== null && summary.expectancyUsd > 0;
  const verdict = {
    positiveExpectancy: positive,
    meetsGate: Boolean(positive && summary.maxDrawdownPct > -25),
    note: positive
      ? (summary.maxDrawdownPct > -25 ? '期望为正且回撤 < 25%，达到上线门槛（仍需模拟盘 2 周）' : `期望为正但最大回撤 ${summary.maxDrawdownPct}% ≥ 25%，未达门槛`)
      : `期望值为负（${summary.expectancyUsd} USD/笔，${summary.expectancyPct}%/笔），未达上线门槛 —— 不建议上实盘`,
  };
  const occupancyStats = occ ? {
    meanPct: round(occ.sumPct / Math.max(1, occ.samples), 4),
    maxPct: round(occ.maxPct, 4),
    capPct: occ.capPct,
    aboveCapBars: occ.aboveCapBars,
    aboveCapSharePct: round((occ.aboveCapBars / Math.max(1, occ.samples)) * 100, 3),
    above80SharePct: round((occ.above80Bars / Math.max(1, occ.samples)) * 100, 3),
    above100SharePct: round((occ.above100Bars / Math.max(1, occ.samples)) * 100, 4),
    feasible: occ.above100Bars === 0,
    maxConcurrentBaskets: occ.maxBaskets,
    basketOpenSharePct: round((occ.basketOpenBars / Math.max(1, occ.samples)) * 100, 2),
    bars: occ.samples,
  } : undefined;
  return { trades, summary, perSymbol, verdict, equity: round(equity, 2), curve, exposure, occupancy: occupancyStats };
}

/**
 * Walk-forward 样本外验证：把公共窗口切成 n 个连续折，逐折独立重放。
 * - 每折重置篮子与权益（equity0 重新开始）；
 * - 折内决策只用 i-1 及更早：指标在本折切片上重算，切片右端截止到本折结束 → 不可能用到未来折数据；
 * - 折开始之前的 bar 只做指标预热（约 320 根，属历史数据），startTs 之前不交易。
 * @param {string|null} opt.tpFillMode 止盈限价成交模型（透传给 simulate；仅 tpOrderType='limit' 时生效）
 * @param {number|null} opt.tpFillRate prob 模型成交概率（透传）
 * @returns {{folds:Array, oos:object}}
 */
function walkForward({ data, policy, equity0 = 10000, feeBps = 8, fundingIncluded = true, slipBps = 0, folds = 5, makerFeeBps = null, makerTimeoutBars = null, tpFillMode = null, tpFillRate = null, tpFillSeed = null }) {
  const winStart = Math.max(...data.map((d) => d.candles[0].ts));
  const winEnd = Math.min(...data.map((d) => d.candles[d.candles.length - 1].ts));
  const span = (winEnd - winStart) / folds;
  const out = [];
  const pooled = [];
  for (let f = 0; f < folds; f++) {
    const from = winStart + f * span;
    const to = f === folds - 1 ? winEnd : winStart + (f + 1) * span;
    const slice = data.map((d) => {
      const cs = d.candles.filter((c) => c.ts <= to);
      return { ...d, candles: cs, ind: indicatorsFor(d.instId, cs) };
    });
    const r = simulate({ data: slice, policy, equity0, feeBps, slipBps, fundingIncluded, startTs: from, makerFeeBps, makerTimeoutBars, tpFillMode, tpFillRate, tpFillSeed });
    pooled.push(...r.trades);
    out.push({
      fold: f + 1,
      fromTs: from,
      toTs: to,
      from: new Date(from).toISOString().slice(0, 16),
      to: new Date(to).toISOString().slice(0, 16),
      days: round((to - from) / 86400e3, 1),
      summary: r.summary, perSymbol: r.perSymbol, trades: r.trades,
    });
  }
  const w = pooled.filter((t) => t.pnlUsd > 0);
  const gw = w.reduce((a, t) => a + t.pnlUsd, 0);
  const gl = Math.abs(pooled.filter((t) => t.pnlUsd < 0).reduce((a, t) => a + t.pnlUsd, 0));
  const oos = {
    folds,
    trades: pooled.length,
    expectancyUsd: pooled.length ? round(mean(pooled.map((t) => t.pnlUsd)), 4) : null,
    expectancyPct: pooled.length ? round(mean(pooled.map((t) => t.pnlPct)), 4) : null,
    winRate: pooled.length ? round((w.length / pooled.length) * 100, 2) : null,
    profitFactor: gl > 0 ? round(gw / gl, 3) : null,
    foldsPositive: out.filter((x) => x.summary.expectancyUsd > 0).length,
    worstFoldDDPct: out.length ? round(Math.min(...out.map((x) => x.summary.maxDrawdownPct)), 2) : null,
    meanFoldExpectancyUsd: out.length ? round(mean(out.map((x) => x.summary.expectancyUsd)), 4) : null,
    note: '逐折独立重放（重置篮子/权益），折内只用 i-1 及更早；OOS 为各折成交合并后的样本外期望',
  };
  return { folds: out, oos };
}

/* ── 止盈挂单（maker 限价）成交模型 ────────────────
 * 限价止盈把「成交价」从 taker 换成 maker（省 feeBps/2 − makerFeeBps 手续费），
 * 代价是「可能挂不上」—— 成交率风险必须显式建模，不能默认必成交。
 * 三种模型（纯函数 + 确定性随机 → 回测可复现）：
 *   touch   当根触及止盈价即成交（p=1，上界；不建模成交风险）
 *   prob    每次触及按概率 rate 抽样成交；未成交则继续持有，后续根再触及可再抽样
 *   confirm 当根触及不算成交；「下一根开盘仍在止盈价之外」才成交（要求跟进确认）
 */

/** 确定性 [0,1) 伪随机（FNV-1a；同一 key 必得同值 → 回测可复现，非未来函数） */
function detUniform(key) {
  const s = String(key);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return ((h >>> 8) % 16777216) / 16777216;
}

/**
 * 「触及止盈价的那一根是否立即成交」（纯函数；limit 模式下唯一的分支点）
 * @param {'touch'|'prob'|'confirm'} mode 未知值按 touch（= 旧行为）
 * @param {number} rate 成交概率（仅 prob 用；≥1 恒成交，≤0 恒不成交）
 * @param {number} u [0,1) 均匀随机数（仅 prob 用；由调用方给 → 可复现）
 * @returns {boolean}
 */
function tpLimitTouchFills(mode, rate, u) {
  const m = mode === 'prob' || mode === 'confirm' ? mode : 'touch';
  if (m === 'touch') return true;
  if (m === 'confirm') return false;      // confirm：交给下一根开盘确认，当根不算
  const p = Number(rate);
  if (rate === null || rate === undefined) return true;   // 未给概率 ⇒ 必成交（与 simulate 的默认一致）
  if (!Number.isFinite(p) || p >= 1) return true;
  if (p <= 0) return false;
  return Number(u) < p;
}

/** confirm 模型：挂单在当根开盘是否被吃（开盘仍在止盈价之外 ⇒ 价格守住，排队限价成交） */
function tpLimitConfirmFilled(side, limitPx, openPx) {
  const l = Number(limitPx), o = Number(openPx);
  if (!(l > 0) || !(o > 0)) return false;
  return side === 'short' ? o <= l : o >= l;
}

/** 某时刻的实际费率（取 ≤ ts 的最近一条；没有则 0） */
function fundingAt(list, ts) {
  if (!list || !list.length) return 0;
  let lo = 0, hi = list.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid].ts <= ts) { best = list[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best ? best.rate : 0;
}

/* ── 参数组 ───────────────────────────────────── */

const BASE_POLICY = {
  firstMarginPct: 1, leverage: 3, marginMode: 'isolated',
  spacingMode: 'atr', spacingAtrMult: 1.0, spacingPct: 0.8,
  multiplier: 1.5, maxLevels: 6, takeProfitPct: 0.8, hardStopPct: 4,
  timeStopHours: 48, cooldownHours: 4, maxBaskets: 3, dailyLossPct: 6, maxFundingAbs: 0.001,
};

const SETS = [
  { name: 'base', note: '默认政策：倍数1.5 / 6层 / 间距 ATR×1.0', policy: { ...BASE_POLICY } },
  { name: 'mult2.0-4层', note: '激进倍数：2.0 搭配 4 层（设计文档要求 2.0 必须 ≤4 层）', policy: { ...BASE_POLICY, multiplier: 2.0, maxLevels: 4 } },
  { name: 'levels4', note: '层数 4（倍数 1.5）', policy: { ...BASE_POLICY, maxLevels: 4 } },
  { name: 'spacing0.8', note: '间距 ATR×0.8（更密，成交更频繁）', policy: { ...BASE_POLICY, spacingAtrMult: 0.8 } },
  { name: 'spacing1.2', note: '间距 ATR×1.2（更疏）', policy: { ...BASE_POLICY, spacingAtrMult: 1.2 } },
];

/* ── CLI ─────────────────────────────────────── */

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const flag = (n) => process.argv.includes('--' + n);
const arg_is_file = (s) => typeof s === 'string' && /[\\/]|\.json$/.test(s) && (() => { try { return fs.statSync(s).isFile(); } catch { return false; } })();

async function main() {
  const days = Number(arg('days', 200));
  const equity0 = Number(arg('equity', 10000));
  const feeBps = Number(arg('fee', 10));           // 往返 bps；默认 10（2026-09-22 实测口径，见文件头）
  const slipBps = Number(arg('slip', 5));          // 逐次成交不利滑点（bps），默认 5（实测单边 5.46bps）
  const policyArg = arg('policy', null);           // 实盘 policy（JSON 文件或内联 JSON）→ 作为回测输入
  const makerFeeArg = arg('makerFee', null);       // maker 单边费率（bps）；不传 = 与 taker 同价
  const makerFeeBps = makerFeeArg === null ? null : Number(makerFeeArg);
  const makerTimeoutBars = Number(arg('makerTimeout', 1));   // maker 限价超时根数（超时转市价）
  const foldsN = Number(arg('folds', 0));          // walk-forward 折数，默认 0 = 关
  /* 止盈执行模型：--tp-order market（默认，= 旧行为）| limit（止盈挂 maker 限价） */
  const tpOrderArg = arg('tp-order', 'market');
  const tpLimitActive = tpOrderArg === 'limit';
  const tpFillModeArg = arg('tp-fill-mode', null);
  const tpFillMode = tpFillModeArg === 'prob' || tpFillModeArg === 'confirm' ? tpFillModeArg : (tpLimitActive ? 'touch' : null);
  const tpFillRateArg = arg('tp-fill-rate', null);
  const tpFillRate = tpFillRateArg === null || tpFillRateArg === undefined ? null : Number(tpFillRateArg);
  /** 把止盈执行模型叠到参数组上：market 时原对象原样返回（保证报告/行为逐字节兼容） */
  const withTp = (pol) => (tpLimitActive ? { ...pol, tpOrderType: 'limit' } : pol);
  const tpFillOpts = tpLimitActive ? { tpFillMode, tpFillRate } : { tpFillMode: null, tpFillRate: null };
  if (tpLimitActive && !(makerFeeBps !== null && makerFeeBps < feeBps / 2)) {
    console.log(`  ⚠ --tp-order limit 但 maker 费率没有低于 taker（makerFee=${makerFeeBps}，taker=${feeBps / 2}）⇒ 省不到钱，请显式传 --makerFee`);
  }
  const fundingIncluded = !flag('no-funding');
  const refresh = flag('refresh');
  const only = arg('only', null);
  /* 实盘 policy 注入：接受 {policy:{...}} 包装或裸 policy；键与 DEFAULT_POLICY/BASE_POLICY 合并 */
  let livePolicy = null, policySource = null;
  if (policyArg) {
    try {
      const raw = arg_is_file(policyArg) ? fs.readFileSync(policyArg, 'utf8') : policyArg;
      const j = JSON.parse(raw);
      livePolicy = j && j.policy ? j.policy : j;
      policySource = arg_is_file(policyArg) ? path.resolve(policyArg) : 'inline-json';
      if (!livePolicy || typeof livePolicy !== 'object' || Array.isArray(livePolicy)) throw new Error('policy 不是对象');
      console.log(`实盘参数注入（--policy）：${policySource}，${Object.keys(livePolicy).length} 个键`);
    } catch (e) {
      console.error(`--policy 读取/解析失败：${String(e.message || e)}`);
      process.exit(2);
    }
  }
  const BASE_RUN_POLICY = livePolicy ? { ...BASE_POLICY, ...livePolicy } : BASE_POLICY;
  const outFile = arg('out', path.join(DATA_DIR, `backtest-martin-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`));
  const targetBars = Math.ceil(days * 24);

  console.log(`\n=== 类马丁回测 · ${days} 天 1H · 权益 $${equity0} · 成本 ${feeBps}bps 往返 · 滑点 ${slipBps}bps · 资金费${fundingIncluded ? '计入' : '不计入'}${foldsN > 1 ? ` · walk-forward ${foldsN} 折` : ''} ===`);
  if (tpLimitActive) console.log(`止盈执行模型：limit（post_only 限价 · maker ${makerFeeBps === null ? feeBps / 2 : makerFeeBps}bps/taker ${feeBps / 2}bps · 成交模型 ${tpFillMode}${tpFillMode === 'prob' ? `(p=${tpFillRate === null ? 1 : tpFillRate})` : ''}）`);
  console.log(`代理：${process.env.PROXY_URL}`);

  if (refresh) { try { fs.rmSync(CACHE_DIR, { recursive: true, force: true }); } catch {} }

  console.log('\n[1/4] 取合约规格 …');
  const swaps = await (async () => {
    for (let i = 0; i < 4; i++) {
      try { return await uni.allSwaps(); }
      catch (e) { console.log(`  ↻ 规格拉取失败（${String(e.message || e).slice(0, 50)}），重试`); await sleep(1500 * (i + 1)); }
    }
    throw new Error('合约规格拉取失败（4 次重试）');
  })();
  const instMap = new Map(swaps.map((d) => [d.instId, d]));
  const missing = ALL.filter((s) => !instMap.has(s));
  if (missing.length) console.log(`  ⚠ 规格缺失：${missing.join(', ')}`);

  console.log(`\n[2/4] 拉历史（每页 100，限流 160ms）…`);
  const data = [];
  for (const instId of ALL) {
    const ins = instMap.get(instId);
    if (!ins) continue;
    const { rows: candles } = await fetchCandles(instId, '1H', targetBars, (s) => console.log(s));
    if (candles.length < 300) { console.log(`  ⚠ ${instId} K线不足（${candles.length}），跳过`); continue; }
    const since = candles[0].ts;
    let funding = [];
    if (fundingIncluded) {
      const r = await fetchFunding(instId, since, (s) => console.log(s));
      funding = r.rows;
    }
    const instrument = {
      ctVal: Number(ins.ctVal || 1), ctValCcy: ins.ctValCcy,
      lotSz: Number(ins.lotSz || 0), minSz: Number(ins.minSz || 0),
      tickSz: Number(ins.tickSz || 0), maxLever: Number(ins.lever || 0),
    };
    data.push({
      instId, sector: sectorOf(instId), instrument, candles, funding,
      ind: indicatorsFor(instId, candles),
      window: { from: new Date(candles[0].ts).toISOString(), to: new Date(candles[candles.length - 1].ts).toISOString(), bars: candles.length },
    });
  }
  if (!data.length) { console.error('没有可用数据，退出'); process.exit(2); }

  const bars = Math.min(...data.map((d) => d.candles.length));
  const realDays = round(bars / 24, 1);
  const winFrom = new Date(Math.max(...data.map((d) => d.candles[0].ts))).toISOString().slice(0, 16);
  const winTo = new Date(Math.min(...data.map((d) => d.candles[d.candles.length - 1].ts))).toISOString().slice(0, 16);
  const fundingMissing = data.filter((d) => !d.funding.length).map((d) => d.instId);
  console.log(`  数据窗口（各标的公共段）：${winFrom} → ${winTo}，约 ${realDays} 天 / ${bars} 根 1H`);
  if (fundingMissing.length) console.log(`  ⚠ 资金费率取不到（按 0 计）：${fundingMissing.join(', ')}`);

  console.log('\n[3/4] 回测（每组参数独立重放，数据/指标复用）…');
  const sets = (only ? SETS.filter((s) => s.name === only) : SETS)
    .map((s) => (livePolicy && s.name === 'base' ? { ...s, note: '实盘当前参数（--policy 注入）', policy: BASE_RUN_POLICY } : s));
  const makerActive = sets.some((st) => martin.makerFirstOn(st.policy)) || makerFeeBps !== null;
  const runs = [];
  let baseRun = null;
  for (const st of sets) {
    const t0 = Date.now();
    const r = simulate({ data, policy: withTp(st.policy), equity0, feeBps, fundingIncluded, slipBps, makerFeeBps, makerTimeoutBars, ...tpFillOpts });
    const rec = {
      name: st.name, note: st.note, policy: withTp(st.policy),
      summary: r.summary, verdict: r.verdict, perSymbol: r.perSymbol, tookMs: Date.now() - t0,
    };
    runs.push(rec);
    if (st.name === 'base') baseRun = r;
    console.log(`  · ${st.name.padEnd(12)} 笔数 ${String(r.summary.trades).padStart(5)} · 期望 ${String(r.summary.expectancyUsd).padStart(9)} USDT/笔 (${r.summary.expectancyPct}%) · 胜率 ${r.summary.winRate}% · PF ${r.summary.profitFactor} · 回撤 ${r.summary.maxDrawdownPct}% · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  const base = baseRun || simulate({ data, policy: withTp(BASE_RUN_POLICY), equity0, feeBps, fundingIncluded, slipBps, makerFeeBps, makerTimeoutBars, ...tpFillOpts });

  /* walk-forward 样本外（可选） */
  let perFold = null, oos = null;
  if (foldsN > 1) {
    const wf = walkForward({ data, policy: withTp(BASE_RUN_POLICY), equity0, feeBps, fundingIncluded, slipBps, folds: foldsN, makerFeeBps, makerTimeoutBars, ...tpFillOpts });
    perFold = wf.folds.map((x) => ({ fold: x.fold, from: x.from, to: x.to, fromTs: x.fromTs, toTs: x.toTs, days: x.days, ...x.summary }));
    oos = wf.oos;
    console.log('\n[3.5/4] walk-forward 样本外 …');
    console.log(`  ${'折'.padEnd(4)}${'区间'.padEnd(34)}${'笔数'.padStart(7)}${'期望USD'.padStart(11)}${'胜率%'.padStart(8)}${'PF'.padStart(7)}${'回撤%'.padStart(9)}`);
    for (const pf of perFold) console.log(`  ${String(pf.fold).padEnd(4)}${(pf.from + ' → ' + pf.to).padEnd(34)}${String(pf.trades).padStart(7)}${String(pf.expectancyUsd).padStart(11)}${String(pf.winRate).padStart(8)}${String(pf.profitFactor).padStart(7)}${String(pf.maxDrawdownPct).padStart(9)}`);
    console.log(`  OOS 汇总：期望 ${oos.expectancyUsd} USD/笔（${oos.expectancyPct}%）· 胜率 ${oos.winRate}% · PF ${oos.profitFactor} · 正收益折 ${oos.foldsPositive}/${oos.folds} · 最差折回撤 ${oos.worstFoldDDPct}%`);
  }

  /* 资金费覆盖度：OKX /public/funding-rate-history 只有约 3 个月深度，未覆盖区间按 0 计 —— 必须声明并估算影响 */
  const covFrom = Math.min(...data.map((d) => (d.funding && d.funding.length ? d.funding[0].ts : Infinity)));
  const winStart = Math.max(...data.map((d) => d.candles[0].ts));
  const winEnd = Math.min(...data.map((d) => d.candles[d.candles.length - 1].ts));
  const covDays = Number.isFinite(covFrom) ? round((winEnd - Math.max(covFrom, winStart)) / 86400e3, 1) : 0;
  const exp = base.exposure || { covNotionalHours: 0, uncovNotionalHours: 0 };
  const ratePerNh = exp.covNotionalHours > 0 ? base.summary.totalFundingUsd / exp.covNotionalHours : 0;
  const estMissing = round(ratePerNh * exp.uncovNotionalHours, 2);
  const uncovShare = exp.covNotionalHours + exp.uncovNotionalHours > 0
    ? round((exp.uncovNotionalHours / (exp.covNotionalHours + exp.uncovNotionalHours)) * 100, 1) : 0;
  const fundingCoverage = {
    complete: covDays >= realDays - 1,
    windowDays: realDays, coveredDays: covDays,
    coveredFrom: Number.isFinite(covFrom) ? new Date(covFrom).toISOString().slice(0, 16) : null,
    uncoveredExposureSharePct: uncovShare,
    measuredFundingUsd: base.summary.totalFundingUsd,
    estimatedMissingFundingUsd: estMissing,
    note: `OKX funding-rate-history 仅约 3 个月深度（实测 ~287 条/标的），未覆盖区间费率按 0 计；按覆盖期实测费率外推，缺口≈${estMissing} USD`,
    perSymbol: data.map((d) => ({
      instId: d.instId, entries: (d.funding || []).length,
      from: d.funding && d.funding.length ? new Date(d.funding[0].ts).toISOString().slice(0, 16) : null,
    })),
  };
  if (!fundingCoverage.complete && fundingIncluded) {
    console.log(`  ⚠ 资金费覆盖不足：窗口 ${fundingCoverage.windowDays} 天，费率数据仅覆盖 ${fundingCoverage.coveredDays} 天；未覆盖持仓占比 ${uncovShare}%，外推缺口 ≈ ${estMissing} USD`);
  }

  console.log('\n[4/4] 写报告 …');
  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    symbols: data.map((d) => d.instId),
    candidates: CANDIDATES, controls: CONTROLS,
    days: realDays, bars, feeBps,
    feeNote: `${feeBps}bps 双边（每次成交按 ${feeBps / 2}bps 计，一开一平合计 ${feeBps}bps）`,
    slipBps,
    ...(tpLimitActive ? {
      tpOrderType: 'limit',
      tpFillMode,
      tpFillRate: tpFillMode === 'prob' ? (tpFillRate === null ? 1 : tpFillRate) : null,
      tpOrderNote: `止盈挂 post_only 限价成交按 maker ${makerFeeBps === null ? feeBps / 2 : makerFeeBps}bps 计；止损/爆仓/时间止损/趋势反转仍 taker ${feeBps / 2}bps。成交模型 ${tpFillMode}${tpFillMode === 'prob' ? `（每根触及按 p=${tpFillRate === null ? 1 : tpFillRate} 抽样）` : tpFillMode === 'confirm' ? '（要求下一根开盘仍在止盈价之外）' : '（触及即成交，上界）'}；maker 限价成交价不加滑点`,
      tpFillNote: '限价挂单不保证成交：未成交则继续持有，后续根再触及可再抽样/再确认（止损/爆仓/时间止损在此期间照常按 taker 生效）',
    } : {}),
    ...(makerActive ? {
      makerFirst: true,
      makerFeeBps: makerFeeBps,
      makerTimeoutBars,
      makerNote: `maker 优先：入场先挂 post_only 限价（锚定信号根 open），下一根未触及则超时 ${makerTimeoutBars} 根后转市价（taker）；加仓挂在目标层价上命中即 maker；止盈/止损始终 taker。maker 单边 ${makerFeeBps === null ? feeBps / 2 : makerFeeBps}bps vs taker 单边 ${feeBps / 2}bps`,
    } : {}),
    slipNote: slipBps > 0
      ? `已对每次成交施加 ${slipBps}bps 不利滑点（买入上浮/卖出下浮），叠在 ${feeBps}bps 手续费之上`
      : '未施加滑点（slipBps=0）',
    folds: foldsN,
    perFold,
    oos,
    fundingIncluded,
    fundingMissing,
    fundingCoverage,
    equity0,
    params: withTp(BASE_RUN_POLICY),
    policySource: policySource || '脚本默认 BASE_POLICY（未传 --policy）',
    dataWindow: { from: winFrom, to: winTo, barsPerSymbol: data.map((d) => ({ instId: d.instId, bars: d.candles.length, from: d.window.from })) },
    trades: base.trades,
    summary: base.summary,
    perSymbol: base.perSymbol,
    verdict: base.verdict,
    runs: runs.map((r) => ({ name: r.name, note: r.note, policy: r.policy, summary: r.summary, verdict: r.verdict })),
    perSymbolBySet: runs.map((r) => ({ name: r.name, perSymbol: r.perSymbol })),
    assumptions: [
      '开仓成交价 = 信号后第一根 K 的 open；加仓/止盈/止损/平仓成交价 = 各自挂单价，再按 --slip 施加逐次不利滑点',
      '同一根 K 内先判不利路径（硬止损 → 加仓，可连续），再判有利路径（止盈）—— 保守优先',
      '状态/方向/ATR/闸门全部只用 i-1 及更早收盘（指标窗口 300 根，与 universe.screen 口径一致）',
      '日亏熔断按「当日」实现，次日 00:00 UTC 自动解除以便连续回测；实盘用 risk.settleDay(autoReset:false) 保持人工解除',
      '资金费率：OKX 历史仅约 3 个月深度，未覆盖区间按 0 计（fundingCoverage 声明实测值与外推估值）',
      '同一品种同时只允许一个篮子；板块去重 / 篮子数上限 / 费率闸门 / 冷却全部生效',
      '未平仓篮子在回测结束时按最后价强平（reason=eod_close）',
      ...(tpLimitActive ? [
        '止盈执行模型 = limit：止盈挂 post_only 限价（成交按 maker 费率、成交价 = 挂单价、不加滑点）；止损/爆仓/时间止损/趋势反转仍按 taker',
        '限价成交率由 tpFillMode/tpFillRate 建模（touch|prob|confirm）；未成交则继续持有，后续根重试',
      ] : []),
    ],
  };
  store.ensureDir(DATA_DIR);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');

  /* ── 终端汇总 ── */
  const s = base.summary;
  console.log('\n' + '='.repeat(96));
  console.log('基线（base：倍数 1.5 / 6 层 / 间距 ATR×1.0）');
  console.log('='.repeat(96));
  const rows = [
    ['交易笔数', s.trades, '最大回撤', `${s.maxDrawdownPct}%`],
    ['期望值（USD/笔）', `${s.expectancyUsd}`, '平均层数', `${s.avgLevelsUsed}`],
    ['期望值（%/笔）', `${s.expectancyPct}%`, '满层率(%)', `${s.level6Rate}%`],
    ['胜率(%)', `${s.winRate}%`, '止损次数', s.stopLossCount],
    ['盈亏比 PF', `${s.profitFactor}`, '时间止损', s.timeStopCount],
    ['总手续费', `${s.totalFeesUsd}`, '止盈次数', s.takeProfitCount],
    ['总资金费', `${s.totalFundingUsd}`, '净盈亏', `${s.netPnlUsd}`],
    ['平均持仓(h)', `${s.avgHours}`, '最长持仓(h)', `${s.maxHours}`],
    ['期末权益', `${s.endEquity}`, '收益率(%)', `${s.returnPct}%`],
  ];
  for (const [a, b, c, d] of rows) console.log(`  ${String(a).padEnd(18)}${String(b).padStart(12)}      ${String(c).padEnd(18)}${String(d).padStart(12)}`);
  console.log(`  熔断天数 ${s.counters.breakerDays} · 开仓成功 ${s.counters.opensOk} · 被拦 ${s.counters.opensRejected}（含张数不足 ${s.counters.blockedByMinSz}）· 加仓被拦 ${s.counters.addBlocked}`);

  console.log('\n分品种（base）：');
  console.log(`  ${'品种'.padEnd(17)}${'板块'.padEnd(11)}${'笔数'.padStart(6)}${'胜率%'.padStart(9)}${'期望%'.padStart(9)}${'期望USD'.padStart(11)}${'最多层'.padStart(8)}${'止损'.padStart(6)}${'回撤%'.padStart(8)}`);
  for (const p of base.perSymbol) {
    console.log(`  ${p.instId.padEnd(17)}${String(p.sector).padEnd(11)}${String(p.trades).padStart(6)}${String(p.winRate).padStart(9)}${String(p.expectancyPct).padStart(9)}${String(p.expectancyUsd).padStart(11)}${String(p.maxLevels).padStart(8)}${String(p.stopLossCount).padStart(6)}${String(p.maxDDPct).padStart(8)}`);
  }

  console.log('\n参数敏感性：');
  console.log(`  ${'组'.padEnd(14)}${'笔数'.padStart(6)}${'期望USD'.padStart(11)}${'期望%'.padStart(9)}${'胜率%'.padStart(8)}${'PF'.padStart(7)}${'回撤%'.padStart(9)}${'满层%'.padStart(8)}${'止损'.padStart(6)}`);
  for (const r of runs) console.log(`  ${r.name.padEnd(14)}${String(r.summary.trades).padStart(6)}${String(r.summary.expectancyUsd).padStart(11)}${String(r.summary.expectancyPct).padStart(9)}${String(r.summary.winRate).padStart(8)}${String(r.summary.profitFactor).padStart(7)}${String(r.summary.maxDrawdownPct).padStart(9)}${String(r.summary.level6Rate).padStart(8)}${String(r.summary.stopLossCount).padStart(6)}`);

  console.log('\n' + '='.repeat(96));
  console.log(`判定：期望值 ${base.verdict.positiveExpectancy ? '>0' : '≤0'} · 最大回撤 ${s.maxDrawdownPct}% · meetsGate=${base.verdict.meetsGate}`);
  console.log(`结论：${base.verdict.note}`);
  console.log(`报告：${outFile}`);
  console.log('='.repeat(96) + '\n');
  return report;
}

if (require.main === module) {
  main().catch((e) => { console.error('回测失败：', e && e.stack || e); process.exit(1); });
}

module.exports = { simulate, walkForward, buildIndicators, fetchCandles, fetchFunding, sectorOf, BASE_POLICY, SETS, CANDIDATES, CONTROLS, ALL, LOOKBACK, tpLimitTouchFills, tpLimitConfirmFilled, detUniform };
