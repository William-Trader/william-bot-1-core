/*!
 * modules/scheduler.js - william-bot-1-core key engine logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-C8B70F9E
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
/**
 * 马丁机器人调度器（B 方）· modules/scheduler.js
 *
 * 契约：design/MARTIN-BOT-SPEC.md §3（B 的接口契约）
 *   §3.3 节奏：选品刷新 5min · 篮子巡检 30s · 日结 00:05
 *   §2.3 引擎只经 stubs/index.js 解析（A 已交付 modules/{martin,risk,store}.js → 用真件；缺件回落桩）
 *
 * 设计要点
 *   1) 全部用 setInterval 驱动（无 sleeper 空转）；每次 tick 的结果落盘：
 *      data/candidates.json（选品）· data/state.json（篮子/账户，走 store）· data/scheduler.json（心跳）
 *   2) 跨进程：调度器单独跑（systemd wb-core-scheduler）；HTTP 面板由 server.js 进程读同一批文件。
 *      两边都可能改 state.json ⇒ 统一走 withLock()（原子创建锁文件 + 陈旧锁回收）。
 *   3) dry-run 铁律：cfg.live !== true 时，任何下单路径都**不调用** okx-trade，
 *      只返回 preview 并落 paper 篮子；orderRequests 计数恒为 0。
 *   4) state 形状以 A 的 modules/store.js emptyState() 为准（equity/dayStartEquity/day/circuitBreaker(bool)/
 *      cooldowns/baskets/closed/log…），B 只**追加**字段：events/curve/counters/dailyLog/todayPnlUsd/todayPnlPct。
 *
 * 独立运行：node modules/scheduler.js        （systemd 用）
 */
const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const engines = require('../stubs');           // { martin, risk, store, engineInfo }
const universe = require('./universe');        // 只读复用（已完成件，不改）

const ROOT = path.join(__dirname, '..');
const INTERVALS = { screenMs: 5 * 60 * 1000, basketMs: 30 * 1000, daily: '00:05' };
const DAILY_H = 0, DAILY_M = 5;
const MAX_EVENTS = 120, MAX_CURVE = 480, MAX_HISTORY = 40, MAX_DAILY = 30;
const PAPER_EQUITY = Number(process.env.MARTIN_EQUITY || 1000);   // dry-run 纸面权益（USD）
const CLOSE_EVENTS = ['take_profit', 'stop_loss', 'time_stop', 'trend_flip', 'liquidation', 'manual_close'];

/* ── 路径与文件 ─────────────────────────────────── */
function dataDir() { return process.env.MARTIN_DATA_DIR || path.join(ROOT, 'data'); }
/** state 路径：优先 A 的 env 口径 MARTIN_STATE_PATH，其次随 MARTIN_DATA_DIR */
function statePath() { return process.env.MARTIN_STATE_PATH || path.join(dataDir(), 'state.json'); }
const F = {
  candidates: () => path.join(dataDir(), 'candidates.json'),
  policy: () => path.join(dataDir(), 'policy.json'),
  scheduler: () => path.join(dataDir(), 'scheduler.json'),
  control: () => path.join(dataDir(), 'control.json'),
  backtest: () => path.join(dataDir(), 'backtest-martin-latest.json'),
};
function paths() { return { dataDir: dataDir(), candidates: F.candidates(), policy: F.policy(), scheduler: F.scheduler(), control: F.control(), state: statePath() }; }
function readJson(p, dflt = null) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return dflt; } }
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, p);
  return { ok: true, path: p };
}
const storeLoad = () => engines.store.load(statePath());
const storeSave = (s) => engines.store.save(s, statePath());
function storeLog(s, msg, level = 'info', ts) {
  if (typeof engines.store.log === 'function') return engines.store.log(s, msg, level, ts);
  return s;   // store.log 是 A 的扩展能力，缺件时退化为只写 events
}

/* ── 策略参数（契约 §2.1，以引擎 DEFAULT_POLICY 为基准）── */

/** 认领幽灵仓为本地篮子（带风控），用于"OKX 有仓、本地无篮"且无浮盈的情况 */
function adoptPhantomPos(rp, s, policy) {
  try {
    const price = Number(rp.avgPx) || 0, sz = Math.abs(Number(rp.pos)) || 0;
    const lev = Number(rp.lever) || Number(policy && policy.leverage) || 3;
    if (!price || !sz) return false;
    s.baskets = s.baskets || [];
    s.baskets.push({
      id: rp.instId + '-' + (rp.posSide || 'long') + '-' + Date.now(), instId: rp.instId,
      side: (rp.posSide === 'short' ? 'short' : 'long'), sector: 'Other',
      paper: false, auto: true, adopted: true, adoptedAt: Date.now(), openedAt: Number(rp.cTime || Date.now()),
      regimeAtOpen: 'unknown', lastRegime: 'unknown', lastPrice: price, lastQuoteAt: Date.now(),
      levels: [{ idx: 0, ts: Number(rp.cTime || Date.now()), price, contracts: sz, marginUsd: Number(rp.margin || 0), reason: 'adopted_phantom', levelNo: 1 }],
      avgPx: price, contracts: sz, marginUsd: Number(rp.margin || 0), upl: Number(rp.upl || 0),
      policy: Object.assign({}, JSON.parse(JSON.stringify(policy || {})), { leverage: lev }),
      liqPxReal: Number(rp.liqPx) > 0 ? Number(rp.liqPx) : null,
    });
    return true;
  } catch (e) { return false; }
}


/** Maker 优先入场（2026-09-22）：挂 post_only 限价，超时撤单转市价。
    默认关闭（policy.makerEntryEnabled=false）→ 行为与原来的市价下单完全一致。
    仅当 symbol 24h 成交额 >= makerEntryMinNotionalUsd 时才尝试挂单（深流动性才挂得住）。 */
async function placeEntryOrder({ basket, sz, price, s }) {
  const trade = require('./okx-trade');
  const policy = basket.policy || {};
  const mk = (s.makerEntry = s.makerEntry || { attempts: 0, filled: 0, fallback: 0, canceled: 0 });
  const side = basket.side === 'long' ? 'buy' : 'sell';
  const base = { instId: basket.instId, side, sz, tdMode: policy.marginMode, posSide: basket.side };
  let useMaker = policy.makerEntryEnabled === true;
  if (useMaker) {
    const thr = Number(policy.makerEntryMinNotionalUsd) || 0;
    if (thr > 0) {
      try {
        const cand = readJson(F.candidates(), null) || {};
        const pick = (cand.picked || []).find((x) => x.instId === basket.instId);
        useMaker = Number((pick && pick.notionalUsd) || 0) >= thr;
      } catch (e) { useMaker = false; }
    }
  }
  if (!useMaker || !(Number(price) > 0)) {
    return trade.placeOrder(Object.assign({ ordType: 'market' }, base));
  }
  // 挂 post_only：买单挂在现价下方、卖单挂在上方（提高成交概率且保证 maker）
  const off = (Number(policy.makerEntryOffsetPct) || 0.05) / 100;
  const px = basket.side === 'long' ? Number(price) * (1 - off) : Number(price) * (1 + off);
  mk.attempts++;
  let ordId = null;
  try {
    const r = await trade.placeOrder(Object.assign({ ordType: 'post_only', px: px.toFixed(10).replace(/0+$/, '').replace(/\.$/, '') }, base));
    ordId = r && r.result && r.result[0] && (r.result[0].ordId || r.result[0].clOrdId) || null;
    if (!r || !r.sent || !ordId) throw new Error('挂单未返回 ordId');
  } catch (e) {
    logEvent(mkEvent('maker_entry_fail', { instId: basket.instId, error: String(e.message || e).slice(0, 110) }));
    return trade.placeOrder(Object.assign({ ordType: 'market' }, base));   // 挂单失败 → 直接市价
  }
  const waitMs = Number(policy.makerEntryTimeoutMs) || 4000;
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    await sleep(400);
    try {
      const d = await trade.okxPrivate('GET', '/api/v5/trade/order?instId=' + basket.instId + '&ordId=' + ordId);
      const row = (Array.isArray(d) ? d[0] : (d && d.data && d.data[0])) || {};
      if (String(row.state) === 'filled') { mk.filled++; return { ok: true, sent: true, maker: true, ordId, result: d }; }
      if (String(row.state) === 'canceled') break;
    } catch (e) { /* 查询失败继续等 */ }
  }
  try { await trade.cancelOrder({ instId: basket.instId, ordId }); mk.canceled++; } catch (e) {}
  mk.fallback++;
  logEvent(mkEvent('maker_entry_timeout', { instId: basket.instId, waitedMs: waitMs, note: '未成交 → 转市价' }));
  return trade.placeOrder(Object.assign({ ordType: 'market' }, base));
}

const BASE_POLICY = Object.freeze({ ...((engines.martin && engines.martin.DEFAULT_POLICY) || {}), ...{
  firstMarginPct: 1, leverage: 3, marginMode: 'isolated', spacingMode: 'atr', spacingAtrMult: 1.0,
  spacingPct: 0.8, multiplier: 1.5, maxLevels: 6, takeProfitPct: 0.8, hardStopPct: 4,
  timeStopHours: 48, cooldownHours: 4, maxBaskets: 3, dailyLossPct: 6, maxFundingAbs: 0.001,
  minAtrPct: 0.4, maxAtrPct: 8, mmr: 0.005, blackSwanPct: 5,
  // 智能保证金（风险预算驱动）——2026-09-21 接入
  sizingMode: 'risk', basketRiskBudgetPct: 2, maxTotalOccupancyPct: 45, riskK: 1.2,
  // 趋势/选品/逆转优化（2026-09-22，默认关闭=旧行为）
  entryVr5Max: 0, entryAdxMax: 0, entryRfMin: 0, entrySkipTrend: 'off', entryAtrPctMax: 0,
  trendFlipMode: 'now', trendFlipConfirmBars: 2, trendFlipReducePct: 50,
  layeredStopEnabled: false, layeredStopFromLevel: 3, layeredStopAtrMult: 4,
  partialTpEnabled: false, partialTpAtPct: 0.8, partialTpFracPct: 50,
  // 幽灵仓/孤儿单处理（2026-09-22）
  phantomActionEnabled: true, phantomHarvestMinProfitUsd: 0.1,
  // Maker 优先入场（默认关闭；开启后深流动性品种挂 post_only 限价，超时转市价）
  makerEntryEnabled: false, makerEntryMinNotionalUsd: 150000000, makerEntryOffsetPct: 0.05, makerEntryTimeoutMs: 4000,
} });
const POLICY_NUM = Object.keys(BASE_POLICY).filter((k) => typeof BASE_POLICY[k] === 'number');
const POLICY_ENUM = { sizingMode: ['risk','fixed'], stopMode: ['atr','equity'], spacingMode: ['atr', 'pct'], marginMode: ['isolated', 'cross'], entryZMode: ['revert','filter'], makerFirst: ['off','on'], tpOrderType: ['market','limit'],
  // 2026-09-22 新增枚举/开关型参数（否则被“非正数”校验拦下）
  trendFlipMode: ['now','confirm','half'], entrySkipTrend: ['off','on'],
  partialTpEnabled: ['off','on'], layeredStopEnabled: ['off','on'],
  makerEntryEnabled: ['off','on'], phantomActionEnabled: ['off','on'] };

function getPolicy() {
  const saved = readJson(F.policy(), null) || {};
  const merged = { ...BASE_POLICY, ...saved };
  const warnings = [];
  for (const k of POLICY_NUM) if (saved[k] !== undefined && !Number.isFinite(Number(saved[k]))) { warnings.push(`policy.${k} 非数字，已用基准值`); merged[k] = BASE_POLICY[k]; }
  return { ok: true, dryRun: !cfg.live, policy: merged, defaults: { ...BASE_POLICY }, warnings };
}
/** 满层累计保证金占用（占权益 %）：首单 × (1+m+m²+…) */
function occupiedPct(p) { let s = 0, m = Number(p.firstMarginPct); for (let i = 0; i < Number(p.maxLevels); i++) { s += m; m *= Number(p.multiplier); } return s; }
function capPolicy(p) {
  const out = { ...p };
  while (out.maxLevels > 1 && occupiedPct(out) * out.maxBaskets > 65) out.maxLevels -= 1;
  return out;
}
function savePolicy(patch = {}) {
  const next = { ...getPolicy().policy };
  const rejected = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in BASE_POLICY)) { rejected.push(`${k} 非策略参数`); continue; }
    if (POLICY_ENUM[k]) { if (!POLICY_ENUM[k].includes(v)) { rejected.push(`${k}=${v} 非法`); continue; } next[k] = v; continue; }
    const n = Number(v);
    const ZERO_OK = ['takeProfitPct', 'entryZMin', 'entryZWin', 'makerTimeoutBars', 'cooldownHours'];
    if (!Number.isFinite(n) || (n <= 0 && !ZERO_OK.includes(k))) { rejected.push(`${k}=${v} 非正数`); continue; }
    next[k] = n;
  }
  if (next.multiplier >= 2 && next.maxLevels > 4) { rejected.push('倍数≥2 时层数上限 4（活命设计），已自动收敛'); }
  const sanitized = capPolicy(next);
  writeJson(F.policy(), sanitized);
  logEvent(mkEvent('policy', { keys: Object.keys(patch || {}).join(',') || '无' }));
  return { ok: true, policy: sanitized, rejected, occupiedPct: +occupiedPct(sanitized).toFixed(2), note: `满层占权益 ${occupiedPct(sanitized).toFixed(1)}% × 篮子 ${sanitized.maxBaskets} 个（安全上限 65%）` };
}

/* ── 控制面（面板 → 调度器，跨进程）────────────── */
function getControl() {
  return { paused: false, autoOpen: process.env.MARTIN_AUTO_OPEN === '1', equity: PAPER_EQUITY, updatedAt: null, ...(readJson(F.control(), {}) || {}) };
}
function setControl(patch) { const next = { ...getControl(), ...patch, updatedAt: Date.now() }; writeJson(F.control(), next); return next; }

/* ── 状态锁（跨进程串行化 state.json 读改写）──── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 锁超时不再让进程退出（2026-09-22）：记录并跳过本轮 */
async function withLockSafely(fn, opts) {
  try { return await withLock(fn, opts); }
  catch (e) {
    const msg = String((e && e.message) || e);
    try { logEvent(mkEvent('lock_timeout', { note: msg.slice(0, 120) })); } catch (e2) {}
    if (/锁等待超时/.test(msg)) return { ok: false, reason: 'lock_timeout' };
    throw e;
  }
}

async function withLock(fn, { timeoutMs = 20000, staleMs = 45000 } = {}) {   // 2026-09-22：4s→20s（篮子巡检内含 OKX 网络 IO，原超时导致一天崩 244 次）
  const lock = path.join(path.dirname(statePath()), '.state.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const t0 = Date.now();
  for (;;) {
    try { fs.writeFileSync(lock, `${process.pid}@${Date.now()}`, { flag: 'wx' }); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try { const st = fs.statSync(lock); if (Date.now() - st.mtimeMs > staleMs) fs.unlinkSync(lock); } catch { /* 已释放 */ }
      if (Date.now() - t0 > timeoutMs) throw new Error('state 锁等待超时（另一进程正在写）');
      await sleep(25);
    }
  }
  // fn 可能是 async：必须 await 后再释放，否则锁会在异步体完成前被放掉
  try { return await fn(); } finally { try { fs.unlinkSync(lock); } catch { /* 已释放 */ } }
}

/* ── state 归一化（A 的 emptyState + B 附加字段）── */
function normState(s) {
  const st = s || {};
  st.baskets = st.baskets || [];
  st.closed = st.closed || [];
  st.log = st.log || [];
  st.cooldowns = st.cooldowns || {};
  st.events = st.events || [];        // B 附加：面板时间线
  st.curve = st.curve || [];          // B 附加：资金曲线
  st.dailyLog = st.dailyLog || [];    // B 附加：日结记录
  st.counters = st.counters || { opens: 0, closes: 0, adds: 0, blocked: 0, orderRequests: 0 };
  st.todayPnlUsd = Number(st.todayPnlUsd || 0);
  st.todayPnlPct = Number(st.todayPnlPct || 0);
  st.circuitBreaker = st.circuitBreaker === true;
  return st;
}
const fmtUsd = (v) => (v === null || v === undefined || Number.isNaN(Number(v)) ? '--' : `${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(2)}U`);
const breakerInfo = (s) => ({ tripped: s.circuitBreaker === true, reason: s.circuitBreakerReason || null, at: s.circuitBreakerAt || null });

/* ── 事件时间线 ─────────────────────────────────── */
const EVENT_TEXT = {
  open: (e) => `开篮 ${e.instId} ${e.side === 'long' ? '多' : '空'} @ ${e.price} · 首单 ${e.contracts} 张 / ${e.marginUsd}U`,
  add: (e) => `加仓 ${e.instId} 第 ${e.levelNo ?? ''} 层 @ ${e.addPx ?? e.price} · ${e.contracts} 张 / ${e.marginUsd}U`,
  add_blocked: (e) => `加仓被拦 ${e.instId}：${e.reason || ''}`,
  take_profit: (e) => `止盈平仓 ${e.instId} · ${fmtUsd(e.pnlUsd ?? e.upl)}（${(e.uplPct ?? 0).toFixed(2)}%）`,
  stop_loss: (e) => `硬止损平仓 ${e.instId} · ${fmtUsd(e.pnlUsd ?? e.upl)}（止损价 ${e.stopPx ?? '--'}）`,
  time_stop: (e) => `时间止损平仓 ${e.instId} · 持仓 ${e.hours ?? '--'}h · ${fmtUsd(e.pnlUsd ?? e.upl)}`,
  trend_flip: (e) => `趋势反转离场 ${e.instId} · ${fmtUsd(e.pnlUsd ?? e.upl)}`,
  liquidation: (e) => `⚠ 逐仓爆仓 ${e.instId} @ ${e.liqPx ?? '--'} · ${fmtUsd(e.pnlUsd ?? e.upl)}`,
  manual_close: (e) => `手动平仓 ${e.instId} · ${fmtUsd(e.pnlUsd ?? e.upl)}`,
  screen: (e) => `选品刷新：候选 ${e.picked} 个 / 全市场 ${e.swaps} 个 · 耗时 ${(e.tookMs / 1000).toFixed(1)}s`,
  screen_fail: (e) => `选品失败：${e.error}`,
  daily: (e) => `日结 ${e.day}：当日 ${fmtUsd(e.pnlUsd)}（${(e.pnlPct ?? 0).toFixed(2)}%）· 权益 ${fmtUsd(e.equityEnd)}`,
  pause: () => '调度已暂停（巡检继续，不再开新篮子）',
  resume: () => '调度已恢复',
  policy: (e) => `策略参数已更新（${e.keys}）`,
  circuit: (e) => `⛔ 熔断：${e.reason}`,
  circuit_reset: () => '熔断已由人工解除',
  backtest: (e) => `回测已触发（jobId ${e.jobId}）`,
};
const WARN_TYPES = ['stop_loss', 'circuit', 'screen_fail', 'add_blocked', 'liquidation'];
function mkEvent(type, data = {}) {
  return {
    ts: Date.now(), type, level: WARN_TYPES.includes(type) ? 'warn' : 'info',
    text: (EVENT_TEXT[type] || ((e) => `${type} ${JSON.stringify(e)}`))(data), data,
  };
}
/** 写事件：A 的 log[]（供 A/主控消费）+ B 的 events[]（面板时间线，带 type/level/data） */
function logEvent(ev) {
  try {
    const s = normState(storeLoad());
    storeLog(s, ev.text, ev.level, ev.ts);
    s.events = [...s.events, ev].slice(-MAX_EVENTS);
    storeSave(s);
    return ev;
  } catch (e) { return { ...ev, text: `${ev.text}（落盘失败：${e.message}）` }; }
}

/* ── 心跳 / 调度器自身状态 ─────────────────────── */
let mem = { running: false, startedAt: null, lastTick: null, lastScreenAt: null, lastBasketTickAt: null, lastDailyAt: null, lastDailyDay: null, screenOk: null, screenErr: null, ticks: { screen: 0, baskets: 0, daily: 0 }, orderRequests: 0, lastOrderAt: null, lastOrderResult: null };
function writeHeartbeat(patch = {}) {
  mem = { ...mem, ...patch, ts: Date.now() };
  const persist = { ...mem };
  writeJson(F.scheduler(), { ...persist, dryRun: !cfg.live, intervals: INTERVALS, engine: engines.engineInfo() });
  return persist;
}
function heartbeat() {
  const disk = readJson(F.scheduler(), null);
  if (!disk) return { running: false, stale: true, heartbeatAgeSec: null, note: '调度器未运行过（无 data/scheduler.json）', engine: engines.engineInfo() };
  const age = (Date.now() - (disk.ts || 0)) / 1000;
  const staleAfter = (INTERVALS.basketMs * 4) / 1000;
  return { ...disk, heartbeatAgeSec: +age.toFixed(1), stale: age > staleAfter, staleAfterSec: staleAfter };
}

/* ── 账户权益 ──────────────────────────────────── */
async function getEquity(state) {
  const ctl = getControl();
  if (cfg.live && cfg.hasCreds) {
    try {
      const trade = require('./okx-trade');
      const bal = await trade.balance();
      const b = (bal || [])[0];
      if (b && b.totalEq) return { equity: Number(b.totalEq), source: 'okx.account' };
    } catch { /* 回落纸面 */ }
  }
  const fromState = Number(state && state.equity) || Number(state && state.dayStartEquity) || 0;
  return { equity: fromState || Number(ctl.equity) || PAPER_EQUITY, source: cfg.live ? 'paper(fallback)' : 'paper(dry-run)' };
}

/* ── 选品：5 分钟 ───────────────────────────────── */
/** @param {{screenFn?:Function, options?:object}} deps 注入 screen 便于离线自检 */
async function tickScreen(deps = {}) {
  const screenFn = deps.screenFn || universe.screen;
  const t0 = Date.now();
  try {
    // 单层名义预算 = 权益 × 首单% × 杠杆：最小下单都放不下的品种不入选
    let maxLayerNotional = null;
    try {
      const st = normState(storeLoad());
      const eqv = (await getEquity(st)).equity;
      const pol = getPolicy().policy;
      maxLayerNotional = eqv * Number(pol.firstMarginPct) / 100 * Number(pol.leverage);
    } catch (e) { /* 取不到预算就不启用该过滤 */ }
    // 分级门槛 + 失败兜底（2026-09-22）：先 20M，不足再放宽到 10M/5M；彻底失败则保留上一轮
    const baseOpts = deps.options || { top: 20, maxLayerNotional };
    const tiers = [Number(baseOpts.minVolUsd) || 2e7, 1e7, 5e6];
    let r = null, usedVol = null;
    for (const v of tiers) {
      try { r = await screenFn({ ...baseOpts, minVolUsd: v }); usedVol = v; } catch (e) { r = null; }
      const pickedN = (r && r.picked) ? r.picked.length : 0;
      const scannedN = (r && r.universe) ? Number(r.universe.scanned || 0) : 0;
      if (pickedN >= 8 || scannedN === 0) break;   // 够用 / 彻底失败 → 不再往下放宽
    }
    if (!r || !(r.picked || []).length) {
      const prevExists = (() => { try { return require('fs').existsSync(F.candidates()); } catch (e) { return false; } })();
      logEvent(mkEvent('screen_empty', { kept: prevExists, note: '选品 0 结果，保留上一轮候选池（不再用空池覆盖）' }));
      return { ok: false, error: '选品返回空结果', keptPrevious: prevExists };
    }
    const doc = {
      ok: true, updatedAt: Date.now(), bar: r.bar || '1H', tookMs: r.tookMs ?? (Date.now() - t0),
      universe: r.universe || null, picked: r.picked || [], rejectedSample: r.rejectedSample || [],
      source: deps.screenFn ? 'injected' : 'universe.screen',
    };
    writeJson(F.candidates(), doc);
    logEvent(mkEvent('screen', { picked: doc.picked.length, swaps: doc.universe ? doc.universe.swaps : 0, tookMs: doc.tookMs }));
    writeHeartbeat({ lastTick: Date.now(), lastScreenAt: Date.now(), screenOk: true, screenErr: null, ticks: { ...mem.ticks, screen: mem.ticks.screen + 1 } });
    return { ok: true, updatedAt: doc.updatedAt, picked: doc.picked.length, tookMs: doc.tookMs };
  } catch (e) {
    const err = String(e.message || e).slice(0, 200);
    logEvent(mkEvent('screen_fail', { error: err }));
    writeHeartbeat({ lastTick: Date.now(), screenOk: false, screenErr: err, ticks: { ...mem.ticks, screen: mem.ticks.screen + 1 } });
    return { ok: false, error: err, keptPrevious: fs.existsSync(F.candidates()) };
  }
}

/* ── 行情（价 + ATR + 状态）────────────────────── */
/** 返回 universe.classifyRegime 全量字段（A 的 shouldOpen 震荡分支要用 regime.price/ema50） */
async function marketOf(instId) {
  if (process.env.MARTIN_OFFLINE === '1') throw new Error('MARTIN_OFFLINE=1（离线模式：用已落盘的候选池/篮子价快照）');
  const candles = await universe.candlesOf(instId, '1H', 260);
  if (!candles || candles.length < 60) throw new Error(`K 线不足（${candles ? candles.length : 0}）`);
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2] || last;
  const price = last.c;
  const rg = universe.classifyRegime(candles);
  const trs = [];
  for (let i = candles.length - 14; i < candles.length; i++) trs.push(Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c)));
  const atr = trs.reduce((a, b) => a + b, 0) / (trs.length || 1);
  return {
    price, atr, atrPct: universe.atrPct(candles, 14), bars: candles.length,
    barChangePct: prev.c ? +(((last.c - prev.c) / prev.c) * 100).toFixed(4) : null,
    regime: { ...rg, allow: rg.allow || [] },
  };
}

/* ── 篮子巡检：30 秒 ───────────────────────────── */
/** @param {{marketFn?:Function}} deps 注入行情函数便于离线自检 */
async function tickBaskets(deps = {}) {
  const marketFn = deps.marketFn || marketOf;
  const ctl = getControl();
  const policy = getPolicy().policy;
  const res = { ok: true, at: Date.now(), checked: 0, events: [], errors: [], opened: [], settled: null };

    /* ── 锁外预取（2026-09-22）────────────────────────────────────────
     篮子巡检原本在持锁期间做 N 次行情拉取 + 持仓/权益查询（每篮 0.3~1s），
     导致另一进程频繁抢锁超时→进程退出（一天崩 244 次）。
     现在把这些网络 IO 全部移到锁外，锁内只做「用快照决策 + 落盘」。 */
  const __snapState = normState(storeLoad());
  const __openNow = __snapState.baskets.filter((x) => !x.closed);
  const pre = { prices: {}, positions: null, equity: null };
  for (const b of __openNow) {
    try { pre.prices[b.instId] = await marketFn(b.instId); }
    catch (e) { res.errors.push(`prefetch ${b.instId}: ${String(e.message || e).slice(0, 60)}`); pre.prices[b.instId] = null; }
  }
  try { pre.positions = await require('./okx-trade').positions(); } catch (e) { pre.positions = null; }
  try { pre.orders = await require('./okx-trade').pendingOrders(); } catch (e) { pre.orders = []; }
  try { pre.equity = (await getEquity(__snapState)).equity; } catch (e) { pre.equity = null; }

await withLockSafely(async () => {
    const s = normState(storeLoad());
    s.mode = cfg.live ? 'live' : 'dry-run';
    s.paused = !!ctl.paused;

    /* -1) 止盈挂单同步：成交则由交易所状态决定归档（maker 成交） */
    if (cfg.live) {
      for (const b of s.baskets.filter((x) => !x.closed)) {
        try {
          // 已有篮子若还没挂止盈单 → 补挂（适配机制上线前开的仓）
          if (!b.tpOrder && tpLimitOnLive(b)) { const tp = await placeTpLimit(b); if (tp.ok) tpStatsInit(s).placed++; }
          const r = await syncTpOrder(b, s);
          if (r && r.filled) {
            s.closed = [...(s.closed || []), b];
            s.baskets = s.baskets.filter((x) => x !== b);
            logEvent(mkEvent('tp_maker_filled', { instId: b.instId, side: b.side, fillPx: r.fillPx, pnlUsd: r.pnl && r.pnl.upl, note: '止盈限价单由交易所以 maker 成交' }));
          }
        } catch (e) { logEvent(mkEvent('tp_sync_fail', { instId: b.instId, error: String(e.message || e).slice(0, 120) })); }
      }
    }

    /* 0) 持仓对账：用 OKX 真实持仓校正篮子（张数/保证金/均价/爆仓价）
          —— 计划张数 ≠ 实际成交张数时，本地算的爆仓价会乐观，必须对账。 */
    if (cfg.live) {
      try {
        const trade = require('./okx-trade');
        const realPos = pre.positions || (await trade.positions());
        const list = (Array.isArray(realPos) ? realPos : []).filter((x) => Number(x.pos) !== 0);
        s.reconciliation = { at: Date.now(), count: list.length, fixed: 0 };
        for (const b of s.baskets.filter((x) => !x.closed)) {
          const rp = list.find((x) => x.instId === b.instId && (x.posSide === (b.side === 'long' ? 'long' : 'short')));
          if (!rp) {
            // 本地有篮子但交易所无持仓 → 记录 + 连续 2 轮仍无仓则自动归档（防"幽灵仓位"显示在面板上）
            b.posMissingTicks = (b.posMissingTicks || 0) + 1;
            if (!b.posMissingAt) {
              b.posMissingAt = Date.now();
              logEvent(mkEvent('pos_missing', { instId: b.instId, side: b.side, note: '本地有篮子但交易所无持仓（疑被强平/手动平仓/未成交）' }));
            }
            if (b.posMissingTicks >= 2) {
              closeBasket(b, b.lastPrice || (b.levels || []).slice(-1)[0]?.price || b.avgPx || 0, Date.now(), 'phantom_pos_missing');
              s.closed = [...(s.closed || []), b];
              s.baskets = s.baskets.filter((x) => x !== b);
              logEvent(mkEvent('phantom_closed', { instId: b.instId, side: b.side, ticks: b.posMissingTicks, note: '交易所确认无持仓 → 已把本地篮子归档为 phantom，不再显示/管理' }));
              res.events.push({ type: 'phantom_closed', instId: b.instId, side: b.side });
            }
            continue;
          }
          b.posMissingAt = null; b.posMissingTicks = 0;
          const realContracts = Math.abs(Number(rp.pos));
          const realMargin = Number(rp.margin);
          const realAvg = Number(rp.avgPx);
          const realLiq = Number(rp.liqPx) > 0 ? Number(rp.liqPx) : null;
          const drift = Math.abs(realContracts - Number(b.contracts || 0)) > 1e-9
            || Math.abs(realMargin - Number(b.marginUsd || 0)) > 1e-6
            || (realAvg > 0 && Math.abs(realAvg - Number(b.avgPx || 0)) > 1e-9);
          const before = { contracts: b.contracts, marginUsd: b.marginUsd, avgPx: b.avgPx, liqPx: b.liquidationPx };
          if (drift) {
            b.contracts = realContracts; b.marginUsd = realMargin;
            if (realAvg > 0) b.avgPx = realAvg;
            if (Array.isArray(b.levels) && b.levels.length === 1) {
              b.levels[0].contracts = realContracts; b.levels[0].marginUsd = realMargin;
              if (realAvg > 0) b.levels[0].price = realAvg;
            }
            s.reconciliation.fixed++;
            logEvent(mkEvent('reconcile', { instId: b.instId, side: b.side, before, actual: { contracts: realContracts, marginUsd: realMargin, avgPx: realAvg, liqPx: realLiq } }));
          }
          b.liqPxReal = realLiq;
          b.liqPxRealAt = Date.now();
        }
      } catch (e) {
        logEvent(mkEvent('reconcile_fail', { error: String(e && e.message || e).slice(0, 140) }));
      }
    }
    s.policy = policy;
    const eqSrc = pre.equity ? { equity: pre.equity, source: 'prefetch' } : await getEquity(s);
    const eq = eqSrc.equity;
    // 每轮用真实权益刷新（原来只在为空时写 → 面板权益永远停在旧值）
    s.equity = eq;
    if (!s.dayStartEquity || s.day !== dayKey()) { s.dayStartEquity = eq; s.day = dayKey(); }
    s.day = s.day || dayKey();


    /* 0b) 反向幽灵仓处理（2026-09-22）：OKX 有仓、本地无篮
           · 浮盈 > max(0.10U, 1.5×预估往返费) 且连续 2 轮 → 市价平仓兑现（老板要求：浮盈有利润则平）
           · 无利可图 → 认领为篮子并纳入风控（绝不市价平亏损仓）
           · 孤儿挂单（无持仓且无篮子）→ 撤销，防止无仓卖单成交开出反向仓 */
    if (cfg.live && policy.phantomActionEnabled !== false) {
      try {
        const trade = require('./okx-trade');
        const okxPos = (pre.positions || []).filter((x) => Number(x.pos) !== 0);
        s.phantoms = s.phantoms || {};
        const seen = new Set();
        for (const rp of okxPos) {
          const side = rp.posSide === 'short' ? 'short' : 'long';
          const key = rp.instId + '|' + side;
          seen.add(key);
          const hasBasket = s.baskets.some((b) => !b.closed && b.instId === rp.instId && String(b.side) === side);
          if (hasBasket) { delete s.phantoms[key]; continue; }
          const ph = s.phantoms[key] || (s.phantoms[key] = { instId: rp.instId, side, firstSeenAt: Date.now(), ticks: 0 });
          ph.ticks = (ph.ticks || 0) + 1;
          const upl = Number(rp.upl) || 0;
          ph.upl = upl;
          const notional = Math.abs(Number(rp.pos)) * Number(rp.avgPx);
          const estFee = notional * 0.001;
          const minProfit = Math.max(Number(policy.phantomHarvestMinProfitUsd) || 0.10, estFee * 1.5);
          if (ph.ticks >= 2 && upl > minProfit) {
            try {
              const r = await trade.closePosition({ instId: rp.instId, posSide: side, mgnMode: policy.marginMode, autoCxl: true });
              logEvent(mkEvent('phantom_harvest', { instId: rp.instId, side, upl: +upl.toFixed(4), minProfit: +minProfit.toFixed(4), ok: !!(r && (r.sent || r.ok)) }));
              res.events.push({ type: 'phantom_harvest', instId: rp.instId, side, upl });
              delete s.phantoms[key];
            } catch (e) { logEvent(mkEvent('phantom_harvest_fail', { instId: rp.instId, error: String(e.message || e).slice(0, 110) })); }
          } else if (ph.ticks >= 2) {
            if (adoptPhantomPos(rp, s, policy)) {
              logEvent(mkEvent('phantom_adopt', { instId: rp.instId, side, upl: +upl.toFixed(4), note: '幽灵仓无浮盈 → 认领纳入风控（不市价平）' }));
              delete s.phantoms[key];
            }
          }
        }
        for (const k of Object.keys(s.phantoms)) if (!seen.has(k)) delete s.phantoms[k];
        for (const o of (pre.orders || [])) {
          const hasPos = okxPos.some((x) => x.instId === o.instId);
          const hasB = s.baskets.some((b) => !b.closed && b.instId === o.instId);
          if (!hasPos && !hasB) {
            try {
              await trade.cancelOrder({ instId: o.instId, ordId: o.ordId });
              logEvent(mkEvent('cancel_orphan_order', { instId: o.instId, ordId: o.ordId, note: '无持仓无篮子的挂单 → 已撤，防误开仓' }));
            } catch (e) { logEvent(mkEvent('cancel_orphan_fail', { instId: o.instId, error: String(e.message || e).slice(0, 90) })); }
          }
        }
      } catch (e) { logEvent(mkEvent('phantom_guard_fail', { error: String(e.message || e).slice(0, 110) })); }
    }

    // 1) 逐篮子：拉行情 → onPrice → 落盘 → 记事件
    for (const b of s.baskets.filter((x) => !x.closed)) {
      res.checked++;
      let m;
      try { m = pre.prices[b.instId] || (await marketFn(b.instId)); } catch (e) { res.errors.push(`${b.instId}: ${String(e.message || e).slice(0, 80)}`); continue; }
      if (!m || !m.price) { res.errors.push(`${b.instId}: 行情为空`); continue; }

      b.lastPrice = m.price; b.lastAtr = m.atr; b.lastAtrPct = m.atrPct;
      b.lastRegime = m.regime ? m.regime.regime : null; b.lastQuoteAt = Date.now();
      let out;
      try {
        out = engines.martin.onPrice(b, { price: m.price, atr: m.atr, regime: m.regime, atrPct: m.atrPct, ts: Date.now() });
      } catch (e) { res.errors.push(`${b.instId} onPrice: ${String(e.message || e).slice(0, 80)}`); continue; }

      const nb = (out && out.basket) || b;            // 引擎原地更新并返回同一对象
      for (const ev of (out && out.events) || []) {
        if (ev.type === 'add') s.counters.adds++;
        if (ev.type === 'add_blocked') s.counters.blocked++;
        const e2 = mkEvent(ev.type, { ...ev, instId: nb.instId });
        storeLog(s, e2.text, e2.level, e2.ts);
        s.events = [...s.events, e2].slice(-MAX_EVENTS);
        res.events.push({ ...ev, instId: nb.instId, text: e2.text });
        await executeEvent(ev, nb, s);                // ← 唯一的下单出口（dry-run 空转）
      }
      if (nb.closed) {                                // 已平仓 → 移入 closed[] + 冷却
        s.baskets = s.baskets.filter((x) => x.id !== nb.id);
        finishBasket(s, nb, policy);
      } else {
        s.baskets = s.baskets.map((x) => (x.id === nb.id ? nb : x));
      }
    }

    // 2) 当日盈亏（口径与 A 的 risk.settleDay 一致：(equity − dayStartEquity)/dayStartEquity）
    syncTodayPnl(s);
    await refreshTodayPnl(s);   // 交易所口径（剔除入金），每轮存盘

    // 3) 熔断（盘中即时置位；闸门判定仍由 A 的 risk.gate 负责）
    if (s.todayPnlPct <= -Number(policy.dailyLossPct) && !s.circuitBreaker) {
      s.circuitBreaker = true; s.circuitBreakerAt = Date.now();
      s.circuitBreakerReason = `当日亏损 ${s.todayPnlPct.toFixed(2)}% ≤ −${policy.dailyLossPct}%`;
      const e2 = mkEvent('circuit', { reason: s.circuitBreakerReason });
      storeLog(s, e2.text, e2.level, e2.ts);
      s.events = [...s.events, e2].slice(-MAX_EVENTS);
      res.events.push({ type: 'circuit', reason: s.circuitBreakerReason });
    }

    // 4) 自动开篮（默认关：MARTIN_AUTO_OPEN=1 或面板 control.autoOpen）
    if (ctl.autoOpen && !ctl.paused && !s.circuitBreaker) {
      const cand = readJson(F.candidates(), null);
      for (const pick of ((cand && cand.picked) || []).slice(0, 6)) {
        if (s.baskets.length >= policy.maxBaskets) break;
        const r = await tryOpen(pick, s, policy, eq, { auto: true, marketFn });
        if (r.ok) res.opened.push(r.basket.id);
      }
    }

    // 5) 权益曲线 + 落盘 + 心跳
    s.curve = [...s.curve, { ts: Date.now(), equity: s.equity }].slice(-MAX_CURVE);
    s.counters.orderRequests = mem.orderRequests;
    s.ts = Date.now();
    storeSave(s);

    // 6) 日结（同一 setInterval 内做时间判定，不额外起 sleeper）
    const d = dailyDue();
    if (d.due) res.settled = dailySettle(d.day);
    return null;
  });

  writeHeartbeat({ lastTick: Date.now(), lastBasketTickAt: Date.now(), ticks: { ...mem.ticks, baskets: mem.ticks.baskets + 1 } });
  return res;
}

/** 当日盈亏：与 A 的 settleDay 同一口径 */
/* ── 今日盈亏（交易所口径，剔除入金）────────────────────────────
   旧口径 = equity − dayStartEquity → 把「入金」也算成盈亏，入金当天会显示反号。
   新口径 = 今日已实现 + 手续费 + 资金费 + 当前未实现（全部来自 OKX，与入金无关）。
   缓存 60s，避免 30s 巡检每次都打账单接口。 */
let __todayCache = { at: 0, day: null, v: null };
async function refreshTodayPnl(s) {
  const day = dayKey();
  if (__todayCache.at && __todayCache.day === day && Date.now() - __todayCache.at < 60000 && __todayCache.v) {
    Object.assign(s, __todayCache.v);
    return s;
  }
  try {
    const trade = require('./okx-trade');
    const d = await trade.okxPrivate('GET', '/api/v5/account/bills?instType=SWAP&limit=100');
    const rows = Array.isArray(d) ? d : [];
    const t0 = new Date(); t0.setHours(0, 0, 0, 0);
    let realized = 0, fees = 0, funding = 0, n = 0;
    for (const r of rows) {
      if (Number(r.ts) < t0.getTime()) continue;
      n++;
      if (String(r.type) === '8') { funding += Number(r.pnl || 0); continue; }   // 资金费
      realized += Number(r.pnl || 0);
      fees += Number(r.fee || 0);
    }
    let upl = 0;
    try { const ps = await trade.positions(); upl = (Array.isArray(ps) ? ps : []).reduce((a, x) => a + Number(x.upl || 0), 0); } catch (e) {}
    const total = realized + fees + funding + upl;
    const base = Number(s.dayStartEquity) > 0 ? Number(s.dayStartEquity) : null;
    const v = {
      todayRealizedUsd: +realized.toFixed(4),
      todayFeesUsd: +fees.toFixed(4),
      todayFundingUsd: +funding.toFixed(4),
      todayUnrealizedUsd: +upl.toFixed(4),
      todayPnlUsd: __todayPnl(s).usd,
      todayPnlPct: __todayPnl(s).pct,
      todayPnlSource: 'okx.bills+tradepnl',
      todayBills: n,
      todayAt: Date.now(),
    };
    v.todayPnlOkxUsd = v.todayPnlUsd;
    v.todayPnlAt = Date.now();
    __todayCache = { at: Date.now(), day, v };
    Object.assign(s, v);
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 180);
    s.todayPnlError = msg;
    s.todayPnlSource = 'error';
    try { logEvent(mkEvent('today_pnl_fail', { error: msg })); } catch (e2) {}
  }
  return s;
}

/* 系统健康：服务 + timers（systemctl 只读，60s 缓存，避免每次请求都 fork） */
let __sysCache = { at: 0, v: null };
function systemHealth() {
  if (__sysCache.at && Date.now() - __sysCache.at < 60000 && __sysCache.v) return __sysCache.v;
  const { execFileSync } = require('child_process');
  const units = ['william-bot-1', 'wb-core-scheduler', 'nginx'];
  const timers = ['wb-core-verify.timer', 'wb-core-carry.timer'];
  const sh = (args) => { try { return execFileSync('systemctl', args, { encoding: 'utf8', timeout: 4000 }).trim(); } catch (e) { return ''; } };
  const services = units.map((u) => ({ name: u, active: sh(['is-active', u]) === 'active', state: sh(['is-active', u]) || 'unknown' }));
  const timersOut = timers.map((t) => {
    const act = sh(['is-active', t]);
    let next = null;
    try {
      const lt = sh(['list-timers', t, '--no-pager', '--output=json']);
      const j = JSON.parse(lt || '[]');
      if (j && j[0]) next = j[0].next || null;
    } catch (e) { next = null; }
    return { name: t, active: act === 'active', next };
  });
  const v = {
    services, timers: timersOut,
    servicesSummary: services.map((x) => `${x.name}:${x.active ? 'active' : 'down'}`).join(' · '),
    timersSummary: timersOut.map((x) => `${x.name}:${x.active ? 'ok' : 'off'}`).join(' · '),
    at: Date.now(),
  };
  __sysCache = { at: Date.now(), v };
  return v;
}

function syncTodayPnl(s) {
  // 防线：调度器刚用「交易所口径」刷新过（3 分钟内）→ 不要用「权益差」覆盖（入金会算错）
  if (s.todayPnlSource === 'okx.bills+tradepnl' && s.todayAt && Date.now() - Number(s.todayAt) < 180e3) return s;
  const base = Number(s.dayStartEquity) || Number(s.equity) || PAPER_EQUITY;
  s.todayPnlUsd = +((Number(s.equity) || base) - base).toFixed(4);
  s.todayPnlPct = base ? +((s.todayPnlUsd / base) * 100).toFixed(4) : 0;
  return s;
}
/** 篮子平仓入账：closed[] + 权益 + 冷却 */
function finishBasket(s, b, policy) {
  /* 记账完整性守卫（2026-09-22）：任何关闭路径都必须留下 原因/时间/盈亏，
     否则统计口径会被静默污染（历史上有 11 笔 reason=空、pnl=0，把胜率分母做大了）。 */
  try {
    if (!b.closedAt) b.closedAt = Date.now();
    if (!b.closeReason) b.closeReason = 'unknown_close';
    if (b.realizedPnl === undefined || b.realizedPnl === null) {
      const px = Number(b.closePrice) || Number(b.lastPrice) || (b.levels || []).slice(-1)[0]?.price || 0;
      try { const pn = px > 0 ? engines.martin.basketPnl(b, px) : null; b.realizedPnl = pn ? pn.upl : null; } catch (e) { b.realizedPnl = null; }
    }
    b.pnlKnown = b.realizedPnl !== null && b.realizedPnl !== undefined;
  } catch (e) { /* 守卫失败不影响主流程 */ }
  const pnl = Number(b.realizedPnl || b.finalUpl || 0);
  s.closed = [...s.closed, b].slice(-MAX_HISTORY);
  s.equity = +((Number(s.equity) || Number(s.dayStartEquity) || PAPER_EQUITY) + pnl).toFixed(4);
  s.counters.closes++;
  // 冷却只在「被迫离场」后登记（止盈/手动平仓不罚）；口径见 design §五.5
  if (['stop_loss', 'liquidation', 'time_stop', 'trend_flip'].includes(b.closeReason)) {
    if (typeof engines.risk.markCooldown === 'function') engines.risk.markCooldown(s, b.instId, policy, Date.now());
  }
  if (typeof engines.risk.pruneCooldowns === 'function') engines.risk.pruneCooldowns(s, Date.now());
  syncTodayPnl(s);
  return pnl;
}

/* ── 下单出口（唯一）──────────────────────────── */
/**
 * dry-run 铁律：live !== true 时**不调用** okx-trade 的任何写接口。
 * 成交语义：open/add → placeOrder；其余平仓类 → closePosition（结算所强平 liquidation 不发单）。
 */
/* ── 止盈挂 maker 限价单（policy.tpOrderType='limit'）────────────────────────
   依据：data/tp-maker-report-20260921.md —— 止盈改 maker 每笔省 3bps/名义（5→2bps），
   单笔期望 4.36→4.80bps；盈亏平衡成交率 p*=0.85，低于则不如市价。
   安全设计（防"已平仓又反向开仓"）：
     · 挂单存续期间，内部市价止盈被抑制；
     · 任何市价平仓前先撤挂单，并复查交易所持仓是否仍在；
     · 挂单成交/撤销一律以交易所状态为准（syncTpOrder）。
   统计 s.tpStats 用于实测成交率，与 p*=0.85 对比。 */
function tpStatsInit(s) { if (!s.tpStats) s.tpStats = { placed: 0, filled: 0, canceled: 0, replaced: 0, fellBackMarket: 0, marketTp: 0, lastAt: null }; return s.tpStats; }
function tpOrderPriceOf(b) { try { return engines.martin.takeProfitPrice(b, b.lastAtrPct ?? b.atrAtOpenPct); } catch (e) { return null; } }
function tpLimitOn(policy) { return String((policy && policy.tpOrderType) || 'market') === 'limit'; }
/** 执行开关以「当前全局 policy」为准；篮子自带 policy 仅作回退（存量篮子是旧值） */
function tpLimitOnLive(b) {
  try {
    const gp = getPolicy().policy;
    if (!(gp && gp.tpOrderType)) return tpLimitOn(b && b.policy);
    if (!tpLimitOn(gp)) return false;
    // 分层（2026-09-22）：成交率仅 40% ≪ 盈亏平衡 85% → 默认市价；
    // 仅当该品种 24h 成交额 ≥ tpLimitMinNotionalUsd 时才用 maker 挂单（深流动性才挂得住）
    const thr = Number(gp.tpLimitMinNotionalUsd) || 0;
    if (!thr) return true;
    const cand = readJson(F.candidates(), null) || {};
    const pick = (cand.picked || []).find((x) => x.instId === b.instId);
    return Number((pick && pick.notionalUsd) || 0) >= thr;
  } catch (e) { return tpLimitOn(b && b.policy); }
}

async function placeTpLimit(b) {
  if (!cfg.live || !tpLimitOnLive(b)) return { ok: false, skipped: true };
  const trade = require('./okx-trade');
  const px = tpOrderPriceOf(b);
  const contracts = (b.levels || []).reduce((a, l) => a + Number(l.contracts || 0), 0);
  if (!(px > 0) || !(contracts > 0)) return { ok: false, error: '止盈价/张数不可用' };
  const side = b.side === 'long' ? 'sell' : 'buy';
  const r = await trade.placeOrder({ instId: b.instId, side, ordType: 'post_only', sz: contracts, px, tdMode: b.policy.marginMode, posSide: b.side, reduceOnly: true });
  const ordId = r && r.sent && r.result && r.result[0] && r.result[0].ordId;
  if (ordId) { b.tpOrder = { ordId, px, contracts, at: Date.now() }; return { ok: true, ordId, px, contracts }; }
  return { ok: false, error: JSON.stringify(r).slice(0, 160) };
}

async function cancelTpLimit(b) {
  if (!b.tpOrder || !b.tpOrder.ordId || !cfg.live) return { ok: false, skipped: true };
  const trade = require('./okx-trade');
  const ordId = b.tpOrder.ordId;
  try { await trade.cancelOrder({ instId: b.instId, ordId }); } catch (e) { /* 已成交/已撤 → 忽略 */ }
  b.tpOrder = null;
  return { ok: true };
}

/** 以交易所为准同步止盈挂单；返回 { filled } */
async function syncTpOrder(b, s) {
  if (!cfg.live || !tpLimitOnLive(b) || !b.tpOrder || !b.tpOrder.ordId) return { filled: false };
  const trade = require('./okx-trade');
  const st = tpStatsInit(s);
  let o = null;
  try { const d = await trade.okxPrivate('GET', `/api/v5/trade/order?instId=${b.instId}&ordId=${b.tpOrder.ordId}`); o = (d || [])[0] || null; }
  catch (e) { return { filled: false, error: String(e.message || e).slice(0, 120) }; }
  st.lastAt = Date.now();
  if (!o) { b.tpOrder = null; return { filled: false, unknown: true }; }
  if (o.state === 'filled') {
    const fillPx = Number(o.avgPx || b.tpOrder.px);
    const pnl = closeBasket(b, fillPx, Date.now(), 'take_profit_maker');
    st.filled++;
    b.tpOrder = null;
    return { filled: true, fillPx, pnl };
  }
  if (o.state === 'canceled' || o.state === 'partially_filled') { b.tpOrder = null; return { filled: false, cleared: o.state }; }
  return { filled: false, resting: o.state };
}

async function executeEvent(ev, basket, state) {
  const preview = orderPreviewFor(ev, basket);
  if (!cfg.live) return { sent: false, dryRun: true, preview, note: 'dry-run：仅记录，未发送任何订单' };
  if (ev.type === 'add_blocked' || ev.type === 'liquidation') return { sent: false, dryRun: false, preview, note: `${ev.type}：无需/不能发单（交易所强平或闸门拦截）` };
  const trade = require('./okx-trade');
  try {
    mem.orderRequests++;
    mem.lastOrderAt = Date.now();
    let r;
    if (ev.type === 'add' || ev.type === 'open') {
      // 首层开仓前把「交易所侧杠杆」设成策略杠杆（2026-09-22 修：此前只改本地算法，OKX 上一直是旧的 3x）
      if (ev.type === 'open' && typeof trade.setLeverage === 'function') {
        try {
          const lv = Number(basket.policy && basket.policy.leverage) || 0;
          if (lv > 0) {
            const lr = await trade.setLeverage({ instId: basket.instId, lever: lv, mgnMode: basket.policy.marginMode, posSide: basket.side });
            logEvent(mkEvent('set_leverage', { instId: basket.instId, lever: lv, ok: !!(lr && (lr.sent || lr.ok)) }));
          }
        } catch (e) { logEvent(mkEvent('set_leverage_fail', { instId: basket.instId, error: String(e.message || e).slice(0, 110) })); }
      }
      r = await placeEntryOrder({ basket, sz: preview.sz, price: Number(ev && ev.price) || Number(basket.lastPrice) || Number(basket.avgPx) || 0, s });
      // 开仓/加仓后：重挂止盈限价单（均价变了 → 止盈价也变了）
      if (tpLimitOnLive(basket)) {
        await cancelTpLimit(basket);
        const tp = await placeTpLimit(basket);
        if (tp.ok) tpStatsInit(state).placed++; else logEvent(mkEvent('tp_limit_fail', { instId: basket.instId, error: String(tp.error || tp.skipped).slice(0, 120) }));
      }
    } else {
      // 市价平仓：先撤止盈挂单，再复查交易所持仓是否仍在（防"已成交又反向开仓"）
      await cancelTpLimit(basket);
      let stillOpen = true;
      try { const ps = await trade.positions(basket.instId); stillOpen = (Array.isArray(ps) ? ps : []).some((x) => Number(x.pos) !== 0); }
      catch (e) { stillOpen = true; }
      if (!stillOpen) {
        if (state) tpStatsInit(state).fellBackMarket++;
        return { sent: false, dryRun: false, preview, note: '复查发现持仓已不存在（止盈单已成交）→ 不再市价平仓' };
      }
      r = await trade.closePosition({ instId: basket.instId, mgnMode: basket.policy.marginMode, posSide: basket.side });
    }
    mem.lastOrderResult = { ok: !!(r && r.ok), dryRun: !!(r && r.dryRun), sent: !!(r && r.sent) };
    if (state) state.lastOrderResult = mem.lastOrderResult;
    return { sent: !!(r && r.sent), dryRun: !(r && r.sent), preview, result: r };
  } catch (e) {
    mem.lastOrderResult = { ok: false, error: String(e.message || e).slice(0, 120) };
    return { sent: false, dryRun: false, preview, error: mem.lastOrderResult.error };
  }
}
function orderPreviewFor(ev, b) {
  const isAdd = ev && (ev.type === 'add' || ev.type === 'open');
  const contracts = isAdd ? (ev.contracts || (b.levels || []).slice(-1)[0]?.contracts || 0)
    : (b.levels || []).reduce((a, l) => a + Number(l.contracts || 0), 0);
  return {
    instId: b.instId, tdMode: (b.policy || {}).marginMode || 'isolated', posSide: b.side,
    side: b.side === 'long' ? (isAdd ? 'buy' : 'sell') : (isAdd ? 'sell' : 'buy'),
    ordType: 'market', sz: contracts,
    ...(isAdd ? {} : { reduceOnly: true }),
    note: 'dry-run 预览（未发送）',
  };
}

/* ── 开篮（面板/调度器共用）────────────────────── */
/**
 * 决策链：候选池 → martin.shouldOpen（方向）→ risk.gate（状态闸门）→ martin.newBasket → 落盘
 * dry-run：newBasket 建纸面篮子 + executeEvent 只出预览，绝不发单。
 */
async function tryOpen(pick, s, policy, eq, { auto = false, marketFn = marketOf, side = null } = {}) {
  const instId = pick.instId;
  if (s.circuitBreaker) return { ok: false, reason: `熔断中：${s.circuitBreakerReason || ''}`, stage: 'circuit' };

  // 开仓前**实时重判**状态（契约 §三 方向切换规则 1）；离线/失败时用候选池快照兜底
  let m = {
    price: pick.last, atr: null, atrPct: pick.atrPct, barChangePct: null,
    regime: { regime: pick.regime, allow: pick.allowDirections || [], adx: pick.adx, price: pick.last, ema50: null, ema200: null },
  };
  try { const live = await marketFn(instId); if (live && live.price) m = live; } catch { /* 快照兜底 */ }

  const openBaskets = s.baskets.filter((b) => !b.closed);
  const so = engines.martin.shouldOpen({
    policy, regime: m.regime, funding: Number(pick.fundingPct || 0) / 100, atrPct: m.atrPct ?? null,
    equity: eq, openBaskets, sector: pick.sector, todayPnlPct: s.todayPnlPct || 0, barChangePct: m.barChangePct ?? null,
  });
  if (!so.ok) return { ok: false, reason: so.reason, stage: 'shouldOpen' };
  // 同品种同方向去重（原设计只按板块去重，同品种会被重复开篮 → 产生幽灵仓/双倍风险）
  const dup = openBaskets.find((x) => !x.closed && x.instId === instId && x.side === (side || so.side));
  if (dup) return { ok: false, reason: `${instId} ${side || so.side} 已有篮子（同品种同方向去重）`, stage: 'dedup' };
  const dupAnySide = openBaskets.find((x) => !x.closed && x.instId === instId);
  if (dupAnySide) return { ok: false, reason: `${instId} 已有篮子（同品种去重，避免双向对锁）`, stage: 'dedup' };
  // 智能保证金：风险预算驱动定首层仓位（引擎缺失/失败则回退固定口径）
  let effPolicy = policy;
  try {
    const margin = require('./margin');
    if (String(policy && policy.sizingMode || 'risk') === 'risk') {
      const plan = margin.planBasket({
        equity: eq, atrPct: m.atrPct, price: m.price,
        instrument: { ctVal: pick.ctVal, lotSz: pick.lotSz, minSz: pick.minSz, maxLever: pick.maxLever },
        policy, openBaskets, sector: pick.sector, score: pick.score && pick.score.total,
      });
      if (!plan || !plan.ok) {
        const why = (plan && (plan.reason || (plan.warnings || [])[0])) || '智能保证金判定不可开';
        return { ok: false, reason: '智能保证金：' + why, stage: 'margin', plan };
      }
      const eff = +(Number(plan.layer1MarginUsd) / eq * 100).toFixed(4);
      if (eff > 0) effPolicy = { ...policy, firstMarginPct: eff, __marginPlan: plan };
    }
  } catch (e) { /* 引擎不可用 → 保持固定口径 */ }

  const gt = engines.risk.gate({
    state: s, policy: effPolicy, equity: eq, todayPnlPct: s.todayPnlPct || 0, funding: Number(pick.fundingPct || 0) / 100,
    sector: pick.sector, openBaskets, instId, atrPct: m.atrPct ?? null, barChangePct: m.barChangePct ?? null, now: Date.now(),
  });
  if (!gt.allow) return { ok: false, reason: gt.reason, stage: 'risk.gate' };

  const chosen = side && (m.regime.allow || []).includes(side) ? side : so.side;
  const b = engines.martin.newBasket({
    instId, side: chosen, sector: pick.sector, price: m.price, atr: m.atr, policy: effPolicy,
    instrument: { ctVal: pick.ctVal, lotSz: pick.lotSz, minSz: pick.minSz, maxLever: pick.maxLever },
    equity: eq, regime: m.regime, ts: Date.now(),
  });
  if (!b) return { ok: false, reason: '首单张数为 0（保证金不足 minSz），跳过', stage: 'newBasket' };
  b.paper = !cfg.live;
  b.auto = !!auto;
  b.lastPrice = m.price; b.lastAtr = m.atr; b.lastAtrPct = m.atrPct; b.lastRegime = m.regime.regime; b.lastQuoteAt = Date.now();

  const exec = await executeEvent({ type: 'open' }, b, s);      // dry-run：只出预览
  const ev = mkEvent('open', { instId, side: chosen, price: m.price, contracts: b.levels[0].contracts, marginUsd: b.levels[0].marginUsd });
  storeLog(s, ev.text, ev.level, ev.ts);
  s.baskets = [...s.baskets, b];
  s.events = [...s.events, ev].slice(-MAX_EVENTS);
  s.counters.opens++;
  return { ok: true, basket: b, exec, event: ev, dryRun: !cfg.live, sent: exec.sent, reason: so.reason };
}

async function openBasket({ instId, side = null } = {}) {
  if (!instId) return { ok: false, error: '需要 instId' };
  const cand = readJson(F.candidates(), null);
  const pick = cand && (cand.picked || []).find((p) => p.instId === instId);
  const u = pick || {
    instId, sector: 'Other', last: 0, fundingPct: 0, atrPct: null, regime: 'unclear', allowDirections: [],
    ctVal: 1, lotSz: 0, minSz: 0, maxLever: 0,
  };
  const policy = getPolicy().policy;
  const out = await withLockSafely(async () => {
    const s = normState(storeLoad());
    s.policy = policy; s.paused = !!getControl().paused;
    const eq = (await getEquity(s)).equity;
    if (!s.equity) s.equity = eq;
    if (!s.dayStartEquity) s.dayStartEquity = eq;
    syncTodayPnl(s);          // 派生量在使用点重算：state 可能由另一进程在上一个 tick 写入
    const r = await tryOpen(u, s, policy, eq, { side });
    if (r.ok) storeSave(s);
    return r;
  });
  if (!out.ok) return { ok: false, error: out.reason, stage: out.stage, dryRun: !cfg.live, sent: false, orderRequests: mem.orderRequests };
  return {
    ok: true, dryRun: !cfg.live, sent: out.sent, paper: !cfg.live,
    basket: decorateBasket(out.basket, policy), preview: out.exec.preview, reason: out.reason,
    orderRequests: mem.orderRequests,
    note: cfg.live ? '实盘：已提交真实订单' : 'dry-run：未发送任何订单，仅创建纸面篮子（不产生交易请求）',
  };
}

/** 面板「平仓」入口（契约 §3.1 POST /api/martin/close/:id，dry-run 只预览） */
async function closeBasket({ id, reason = 'manual_close' } = {}) {
  if (!id) return { ok: false, error: '需要篮子 id' };
  const policy = getPolicy().policy;
  const out = await withLockSafely(async () => {
    const s = normState(storeLoad());
    const b = s.baskets.find((x) => x.id === id);
    if (!b) return { ok: false, reason: `篮子 ${id} 不存在（可能已平仓）` };
    syncTodayPnl(s);
    let price = b.lastPrice;
    if (!price) { try { price = (await marketOf(b.instId)).price; } catch { price = (b.levels || []).slice(-1)[0].price; } }
    const pn = engines.martin.basketPnl(b, price);
    const preview = { instId: b.instId, mgnMode: policy.marginMode, posSide: b.side, reduceOnly: true, sz: pn.contracts, note: 'dry-run 预览（未发送）' };
    const exec = await executeEvent({ type: reason }, b, s);       // dry-run：只出预览
    if (typeof engines.martin.closeBasket === 'function') engines.martin.closeBasket(b, price, Date.now(), reason);
    else { b.closed = true; b.closedAt = Date.now(); b.closeReason = reason; b.realizedPnl = pn.upl; b.closePrice = price; }
    s.baskets = s.baskets.filter((x) => x.id !== id);
    finishBasket(s, b, policy);
    const e2 = mkEvent(reason, { instId: b.instId, pnlUsd: b.realizedPnl, uplPct: pn.uplPct });
    storeLog(s, e2.text, e2.level, e2.ts);
    s.events = [...s.events, e2].slice(-MAX_EVENTS);
    storeSave(s);
    return { ok: true, basket: b, pnl: pn, preview, exec, sent: exec.sent };
  });
  if (!out.ok) return { ok: false, error: out.reason, dryRun: !cfg.live, sent: false, orderRequests: mem.orderRequests };
  return { ok: true, dryRun: !cfg.live, sent: out.sent, preview: out.preview, pnl: out.pnl, closed: out.basket, orderRequests: mem.orderRequests, note: cfg.live ? '实盘：已提交平仓' : 'dry-run：未发送任何订单（仅预览）' };
}

/* ── 日结：每日 00:05 ──────────────────────────── */
function dayKey(d = new Date()) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function dailyDue(now = new Date()) {
  const due = new Date(now); due.setHours(DAILY_H, DAILY_M, 0, 0);
  const last = readJson(F.scheduler(), {}) || {};
  const today = dayKey(now);
  return { due: now >= due && last.lastDailyDay !== today, day: today, at: due.getTime() };
}
/** 结算当日盈亏、重置熔断（**需人工确认解除** → autoReset:false） */
function dailySettle(day = dayKey()) {
  const policy = getPolicy().policy;
  const s = normState(storeLoad());
  s.policy = policy;
  const equity = Number(s.equity) || Number(s.dayStartEquity) || PAPER_EQUITY;
  const start = Number(s.dayStartEquity) || equity;
  const pnlUsd = +(equity - start).toFixed(4);
  const pnlPct = start ? +((pnlUsd / start) * 100).toFixed(4) : 0;
  const rec = {
    day, pnlUsd, pnlPct, equityEnd: equity, startEquity: start,
    trades: s.closed.filter((h) => dayKey(new Date(h.closedAt || 0)) === day).length,
    stopLoss: s.closed.filter((h) => h.closeReason === 'stop_loss' && dayKey(new Date(h.closedAt || 0)) === day).length,
    openBaskets: s.baskets.length,
  };
  s.dailyLog = [...s.dailyLog, rec].slice(-MAX_DAILY);

  let settleSummary = null;
  if (typeof engines.risk.settleDay === 'function') {
    const r = engines.risk.settleDay(s, { equity, dayStartEquity: start, day, ts: Date.now(), autoReset: false });
    settleSummary = r.summary;
  } else {
    s.day = day; s.dayStartEquity = equity;
  }
  s.todayPnlUsd = 0; s.todayPnlPct = 0;
  const e2 = mkEvent('daily', { ...rec });
  storeLog(s, e2.text, e2.level, e2.ts);
  s.events = [...s.events, e2].slice(-MAX_EVENTS);
  storeSave(s);
  writeHeartbeat({ lastDailyAt: Date.now(), lastDailyDay: day, lastTick: Date.now(), ticks: { ...mem.ticks, daily: mem.ticks.daily + 1 } });
  const b = breakerInfo(s);
  return {
    ok: true, ...rec, settle: settleSummary, circuitBreaker: b,
    note: b.tripped ? '熔断仍生效，需人工确认解除（POST /api/martin/resume {confirmBreaker:true}）' : '当日盈亏已归零，熔断未触发',
  };
}

/* ── 调度循环 ──────────────────────────────────── */
let timers = { screen: null, basket: null };
function start(opts = {}) {
  if (timers.screen || timers.basket) return { ok: true, already: true, intervals: INTERVALS };
  fs.mkdirSync(dataDir(), { recursive: true });
  writeHeartbeat({ running: true, startedAt: Date.now(), lastTick: Date.now() });
  const guard = (name, fn) => async () => { try { await fn(opts); } catch (e) { writeHeartbeat({ [`${name}Err`]: String(e.message || e).slice(0, 200) }); } };
  timers.screen = setInterval(guard('screen', tickScreen), INTERVALS.screenMs);
  timers.basket = setInterval(guard('basket', tickBaskets), INTERVALS.basketMs);
  // 库模式（被 server.js require）才 unref，避免占住宿主进程；
  // 常驻入口（systemd）必须 keepAlive，否则事件循环排空后进程直接退出
  if (!opts.keepAlive) { timers.screen.unref?.(); timers.basket.unref?.(); }
  guard('screen', tickScreen)(); guard('basket', tickBaskets)();   // 启动即跑一次，不等 5 分钟
  return { ok: true, startedAt: Date.now(), intervals: INTERVALS, engine: engines.engineInfo(), dryRun: !cfg.live };
}
function stop() {
  if (timers.screen) clearInterval(timers.screen);
  if (timers.basket) clearInterval(timers.basket);
  timers = { screen: null, basket: null };
  writeHeartbeat({ running: false, stoppedAt: Date.now() });
  return { ok: true, running: false };
}
function pause(note) {
  const c = setControl({ paused: true });
  logEvent(mkEvent('pause', {}));
  return { ok: true, paused: true, control: c, note: note || '巡检继续（监控已有篮子），不再开新篮子' };
}
function resume({ confirmBreaker = false, autoOpen = undefined } = {}) {
  const c = setControl({ paused: false, ...(autoOpen === undefined ? {} : { autoOpen: !!autoOpen }) });
  let breakerCleared = false;
  if (confirmBreaker) {
    const s = normState(storeLoad());
    if (s.circuitBreaker) {
      s.circuitBreaker = false; s.circuitBreakerAt = null; s.circuitBreakerReason = null;
      storeLog(s, '熔断已由人工解除', 'info', Date.now());
      s.events = [...s.events, mkEvent('circuit_reset', {})].slice(-MAX_EVENTS);
      storeSave(s);
      breakerCleared = true;
    }
  }
  logEvent(mkEvent('resume', {}));
  return { ok: true, paused: false, control: c, breakerCleared, note: breakerCleared ? '熔断已人工解除' : '熔断状态未变（需 confirmBreaker:true 且确实处于熔断）' };
}

/* ── 展示用装饰（只读计算，不落盘）────────────── */
function decorateBasket(b, policy) {
  const price = b.lastPrice || (b.levels || []).slice(-1)[0]?.price || 0;
  const pn = engines.martin.basketPnl(b, price);
  const M = engines.martin;
  const nextAddPx = M.nextAddPrice(b, b.lastAtr || b.atrAtOpen || pn.avgPx * 0.01);
  const liqPx = M.liquidationPrice(b, (b.policy || policy).mmr);
  const tpPx = typeof M.takeProfitPrice === 'function' ? M.takeProfitPrice(b) : null;
  const stopPx = typeof M.stopPrice === 'function' ? M.stopPrice(b) : null;
  return {
    id: b.id, instId: b.instId, side: b.side, sector: b.sector, paper: !!b.paper, auto: !!b.auto,
    openedAt: b.openedAt, heldH: +((Date.now() - Number(b.openedAt || Date.now())) / 3600e3).toFixed(2),
    regimeAtOpen: b.regimeAtOpen, lastRegime: b.lastRegime, lastPrice: price, lastQuoteAt: b.lastQuoteAt || null,
    levels: (b.levels || []).map((l) => ({ ...l, levelNo: Number(l.idx) + 1 })),
    levelCount: (b.levels || []).length, maxLevels: Number((b.policy || policy).maxLevels),
    avgPx: pn.avgPx, contracts: pn.contracts, notionalUsd: pn.notionalUsd, marginUsd: pn.marginUsd,
    upl: pn.upl, uplPct: pn.uplPct, nextAddPx, takeProfitPx: tpPx, stopPx,
    liquidationPx: liqPx,                       // 本地估算
    liqPxReal: b.liqPxReal ?? null,             // OKX 真实爆仓价（对账得来）
    posMissingAt: b.posMissingAt ?? null,       // 本地有篮子但交易所无持仓的首次发现时间
    stopUsd: b.stopUsd ?? null, atrAtOpen: b.atrAtOpen ?? null, atrPct: b.lastAtrPct ?? null,
  };
}

/* ── 面板只读接口 ─────────────────────────────── */
function getCandidates() {
  const d = readJson(F.candidates(), null);
  if (!d) return { ok: false, error: '尚无选品结果（等调度器跑一次选品刷新）', dryRun: !cfg.live, updatedAt: null, picked: [] };
  return { ok: true, dryRun: !cfg.live, updatedAt: d.updatedAt, ageSec: +((Date.now() - (d.updatedAt || 0)) / 1000).toFixed(1), bar: d.bar, tookMs: d.tookMs, universe: d.universe, picked: d.picked, rejectedSample: d.rejectedSample, source: d.source };
}
function getBaskets() {
  const policy = getPolicy().policy;
  const ctl = getControl();
  const s = normState(storeLoad());
  const baskets = s.baskets.filter((b) => !b.closed).map((b) => decorateBasket(b, policy));
  // 面板「资金效率」卡需要：权益 / 闲置 / 占用率 / 满层上限 / 单层名义预算（契约补齐）
  const __st = normState(storeLoad());
  const __eq = Number(__st.equity) || Number(__st.dayStartEquity) || 0;
  const __geo = (() => { let sum = 1, t = 1; const lv = Number(policy.maxLevels) || 1, m = Number(policy.multiplier) || 1; for (let i = 1; i < lv; i++) { t *= m; sum += t; } return sum; })();
  const __capPct = (Number(policy.firstMarginPct) || 0) * __geo * (Number(policy.maxBaskets) || 0);
  const __used = +baskets.reduce((a, b) => a + (Number(b.marginUsd) || 0), 0).toFixed(4);
  return {
    ok: true, dryRun: !cfg.live, count: baskets.length, maxBaskets: policy.maxBaskets, paused: !!ctl.paused,
    equity: +__eq.toFixed(4),                                       // ← 面板资金效率卡需要
    idleUsd: +(Math.max(0, __eq - __used)).toFixed(4),
    usagePct: __eq ? +((__used / __eq) * 100).toFixed(4) : null,
    layerBudgetUsd: +( __eq * (Number(policy.firstMarginPct) || 0) / 100 * (Number(policy.leverage) || 1)).toFixed(4),
    occupancyCapPct: +__capPct.toFixed(2),
    todayPnlUsd: __todayPnl(__st).usd, todayPnlPct: __todayPnl(__st).pct,
    baskets,
    history: s.closed.slice(-20).map((h) => ({ id: h.id, instId: h.instId, side: h.side, sector: h.sector, closeReason: h.closeReason, closedAt: h.closedAt, realizedPnl: h.realizedPnl, levelCount: (h.levels || []).length, paper: !!h.paper })),
    totals: { marginUsed: +baskets.reduce((a, b) => a + b.marginUsd, 0).toFixed(2), upl: +baskets.reduce((a, b) => a + b.upl, 0).toFixed(2) },
  };
}
/* 今日盈亏取值：优先交易所口径（入金不算盈亏），否则回落 state 旧值 */
function __todayPnl(s) {
  const fresh = s && s.todayPnlOkxUsd !== undefined && s.todayPnlAt && Date.now() - Number(s.todayPnlAt) < 180e3;
  const usd = fresh ? Number(s.todayPnlOkxUsd) : Number(s.todayPnlUsd || 0);
  const base = Number(s && s.dayStartEquity) || Number(s && s.equity) || 0;
  const pct = fresh ? (base ? +((usd / base) * 100).toFixed(4) : null) : (s && s.todayPnlPct !== undefined ? s.todayPnlPct : null);
  return { usd, pct, src: fresh ? 'okx.bills+tradepnl' : (s && s.todayPnlSource) || null };
}
function getState() {

  const s = normState(storeLoad());
  const hb = heartbeat();
  const ctl = getControl();
  const policy = getPolicy().policy;
  const cand = readJson(F.candidates(), null);
  return {
    ok: true, ts: Date.now(), mode: cfg.live ? 'live' : 'dry-run', dryRun: !cfg.live,
    safeBanner: cfg.live ? '★ 实盘模式：开篮/平仓会发送真实订单' : 'dry-run：开篮/平仓只返回预览，绝不发送真实订单',
    engine: engines.engineInfo(),
    scheduler: hb,
    candidates: cand ? { updatedAt: cand.updatedAt, ageSec: +((Date.now() - cand.updatedAt) / 1000).toFixed(1), count: (cand.picked || []).length, source: cand.source } : { updatedAt: null, count: 0 },
    openBaskets: s.baskets.filter((b) => !b.closed).length,
    equity: Number(s.equity) || Number(s.dayStartEquity) || ctl.equity,
    dayStartEquity: Number(s.dayStartEquity) || 0, day: s.day,
    todayPnlUsd: __todayPnl(s).usd, todayPnlPct: __todayPnl(s).pct, todayPnlSource: __todayPnl(s).src,
    // 前端契约：services/timers 需为「可读字符串」（前端会直接渲染；对象会被 JSON.stringify 成乱码）
    log: (s.events || []).slice(-80),           // 前端「日志」区读 st.log（与 events 同源）
    events: s.events || [],
    services: systemHealth().servicesSummary,
    units: systemHealth().servicesSummary,
    timers: systemHealth().timersSummary,
    servicesList: systemHealth().services, timersList: systemHealth().timers,
    servicesSummary: systemHealth().servicesSummary, timersSummary: systemHealth().timersSummary,
    todayRealizedUsd: s.todayRealizedUsd ?? null, todayFeesUsd: s.todayFeesUsd ?? null,
    todayFundingUsd: s.todayFundingUsd ?? null, todayUnrealizedUsd: s.todayUnrealizedUsd ?? null,
    circuitBreaker: breakerInfo(s),
    policy, occupiedPct: +occupiedPct(policy).toFixed(2),
    cooldowns: Object.keys(s.cooldowns || {}).length,
    paused: !!ctl.paused, autoOpen: !!ctl.autoOpen,
    counters: { ...s.counters, orderRequests: mem.orderRequests },
    orderGuard: { dryRun: !cfg.live, orderRequests: mem.orderRequests, lastOrderAt: mem.lastOrderAt, lastOrderResult: mem.lastOrderResult, note: 'dry-run 下该计数恒为 0' },
    curve: s.curve.slice(-240),
    events: s.events.slice(-80).reverse(),
    dailyLog: s.dailyLog.slice(-14),
  };
}
async function getBacktest() {
  const dir = dataDir();
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^backtest-martin-\d+\.json$/.test(f)).sort(); } catch { /* 无目录 */ }
  let doc = readJson(F.backtest(), null);
  let file = files[files.length - 1] || null;
  if (!doc && file) doc = readJson(path.join(dir, file), null);
  if (!doc) return { ok: false, error: '尚无回测结果（A 的 scripts/martin-backtest.js 产出 data/backtest-martin-YYYYMMDD.json）', summary: null, verdict: null, perSymbol: [], symbols: [], file: null };
  return { ok: true, file, generatedAt: doc.generatedAt || doc.ts || null, days: doc.days, bars: doc.bars, feeBps: doc.feeBps, fundingIncluded: doc.fundingIncluded, summary: doc.summary || null, verdict: doc.verdict || null, perSymbol: doc.perSymbol || [], symbols: doc.symbols || [] };
}
/** 触发回测（后台跑，返回 jobId）；A 的脚本未交付时如实报缺 */
async function runBacktest(extraArgs = []) {
  const jobId = `bt-${Date.now().toString(36)}`;
  const script = path.join(ROOT, 'scripts', 'martin-backtest.js');
  if (!fs.existsSync(script)) return { ok: false, jobId: null, error: '回测脚本 scripts/martin-backtest.js 尚未交付（A 负责），无法触发', gate: '未过回测门槛不得开启 LIVE=1' };
  try {
    const { spawn } = require('child_process');
    const logFd = fs.openSync(path.join(dataDir(), `backtest-${jobId}.log`), 'a');
    const p = spawn(process.execPath, [script, ...extraArgs], { cwd: ROOT, detached: true, stdio: ['ignore', logFd, logFd], env: process.env });
    p.unref();
    logEvent(mkEvent('backtest', { jobId }));
    return { ok: true, jobId, pid: p.pid, log: `data/backtest-${jobId}.log`, note: '后台运行；完成后 data/backtest-martin-YYYYMMDD.json 就绪，面板「收益」区块会显示 summary/verdict' };
  } catch (e) { return { ok: false, jobId: null, error: String(e.message || e).slice(0, 160) }; }
}
function getLogs() {
  const s = normState(storeLoad());
  return { ok: true, events: s.events.slice(-100).reverse(), log: (s.log || []).slice(-100).reverse() };
}

/* ── 独立进程入口（systemd wb-core-scheduler）─── */
if (require.main === module) {
  const r = start({ keepAlive: true });
  console.log(`[scheduler] 启动 · dry-run=${r.dryRun} · 选品 ${INTERVALS.screenMs / 60000}min / 巡检 ${INTERVALS.basketMs / 1000}s / 日结 ${INTERVALS.daily}`);
  console.log(`[scheduler] 引擎来源：${r.engine.source}（真件 ${r.engine.real.join(',') || '无'}；桩 ${r.engine.stub.join(',') || '无'}）`);
  console.log(`[scheduler] 数据目录：${dataDir()} · state：${statePath()}`);
  process.on('SIGTERM', () => { stop(); process.exit(0); });
  process.on('SIGINT', () => { stop(); process.exit(0); });
}

module.exports = {
  systemHealth,
  start, stop, pause, resume, INTERVALS,
  tickScreen, tickBaskets, dailySettle, dailyDue, dayKey,
  openBasket, closeBasket, tryOpen, executeEvent, runBacktest,
  getCandidates, getBaskets, getState, getPolicy, savePolicy, getBacktest, getLogs, heartbeat, getControl, setControl,
  paths, dataDir, statePath, decorateBasket, normState, BASE_POLICY, marketOf, withLock, engines, orderPreviewFor,
};
