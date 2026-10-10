/*!
 * scripts/scheduler-selftest.mjs - william-bot-1-core key backtest/optimize logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-4E342E1E
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
#!/usr/bin/env node
/**
 * 调度与面板接口自检（B 方）· scripts/scheduler-selftest.mjs
 *
 * 覆盖：
 *   ① 契约 §3.3 调度节奏（选品 5min / 巡检 30s / 日结 00:05）与「setInterval + 状态落盘、无 sleeper 空转」
 *   ② 引擎接口按契约 §2.3 存在且可调（A 已交付用真件；缺件回落桩，报告标注来源）
 *   ③ 选品落盘 → data/candidates.json → /api/martin/candidates 读得到
 *   ④ 篮子接口结构（逐层/均价/张数/保证金/浮盈/下一加仓价/止盈价/止损价/爆仓价）
 *   ⑤ policy 读写往返（含非法值拒绝）
 *   ⑥ pause / resume（含熔断人工确认解除）
 *   ⑦ dry-run 铁律：开篮/平仓**不产生任何交易请求**（真实 okx-trade 写接口计数器恒为 0）
 *   ⑧ 全量 HTTP 路由 E2E（子进程起 server.js）+ 既有路由回归未被破坏
 *
 * 隔离：MARTIN_DATA_DIR + MARTIN_STATE_PATH 双指临时目录；并校验生产 data/state.json 前后哈希不变。
 * 运行：node scripts/scheduler-selftest.mjs
 */
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-core-selftest-'));
process.env.MARTIN_DATA_DIR = DATA;
process.env.MARTIN_STATE_PATH = path.join(DATA, 'state.json');
process.env.MARTIN_OFFLINE = '1';      // 离线：行情走已落盘快照，不出网
delete process.env.LIVE;               // dry-run

const PROD_STATE = path.join(ROOT, 'data', 'state.json');
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return '(不存在)'; } };
const prodBefore = sha(PROD_STATE);

/* ── 断言工具 ─────────────────────────────────── */
let pass = 0; const fails = []; const results = [];
function check(name, fn) {
  try { const info = fn(); results.push({ name, ok: true, info }); pass++; }
  catch (e) { results.push({ name, ok: false, info: String(e.message || e).slice(0, 300) }); fails.push(`${name}: ${String(e.message || e).slice(0, 200)}`); }
}
async function acheck(name, fn) {
  try { const info = await fn(); results.push({ name, ok: true, info }); pass++; }
  catch (e) { results.push({ name, ok: false, info: String(e.message || e).slice(0, 300) }); fails.push(`${name}: ${String(e.message || e).slice(0, 200)}`); }
}
const ok = (c, m) => { if (!c) throw new Error(m); };

/* ── 交易请求哨兵：patch 真实 okx-trade 的写接口 ── */
const trade = require(path.join(ROOT, 'modules/okx-trade.js'));
const COUNTER = { placeOrder: 0, closePosition: 0, cancelOrder: 0, setLeverage: 0 };
const ORIG = {};
for (const k of Object.keys(COUNTER)) { ORIG[k] = trade[k]; trade[k] = async (...a) => { COUNTER[k]++; return ORIG[k](...a); }; }
const orderCalls = () => Object.values(COUNTER).reduce((a, b) => a + b, 0);

const sched = require(path.join(ROOT, 'modules/scheduler.js'));
const engines = require(path.join(ROOT, 'stubs/index.js'));
const H = fs.readFileSync(path.join(ROOT, 'modules/scheduler.js'), 'utf8');

/* ── 夹具：5 个 trend_up 候选（方向确定 = 只多），ATR% 落在引擎上下限内 ──
   为什么要 5 个：A 的 risk 有「同品种止损后 4 小时冷却」——一个品种只够验一个场景 */
const mk = (tag, sector, extra = {}) => ({
  instId: `TEST${tag}-USDT-SWAP`, sector, last: 100, notionalUsd: 8.0e7, fundingPct: 0.01,
  ctVal: 0.1, ctValCcy: `TEST${tag}`, minSz: 1, lotSz: 1, maxLever: 20,
  atrPct: 2.0, vr5: 0.82, rho1: -0.06, rf: 0.31, regime: 'trend_up', allowDirections: ['long'], adx: 41.2,
  score: { reversion: 0.7, volatility: 0.9, liquidity: 0.5, total: 0.72 }, ...extra,
});
const PICKS = [mk('AAA', 'L1'), mk('BBB', 'L2'), mk('CCC', 'DeFi'), mk('DDD', 'MEME'), mk('EEE', 'Other:EEE')];
const [PICK, PICK2, PICK3, PICK4, PICK5] = PICKS;
const SCREEN_RESULT = {
  ok: true, bar: '1H', tookMs: 1234,
  universe: { swaps: 467, tickers: 467, aboveVolume: 30, scanned: 29, failed: 438 },
  picked: PICKS,
  rejectedSample: [{ instId: 'X-USDT-SWAP', reason: '成交额不足' }],
};
const mkMarket = (price, { atr = 2, regime = 'trend_up', allow = ['long'] } = {}) =>
  () => ({ price, atr, atrPct: (atr / price) * 100, barChangePct: 0, bars: 260, regime: { regime, allow, adx: 41, price, ema50: price, ema200: price } });

console.log(`\n=== 调度器 / 面板 自检 ===`);
console.log(`仓库 ${ROOT}`);
console.log(`隔离数据目录 ${DATA}\n`);

/* ── ①② 节奏 + 引擎接口 ──────────────────────── */
check('契约 §3.3 调度节奏 = 选品5min / 巡检30s / 日结00:05', () => {
  ok(sched.INTERVALS.screenMs === 5 * 60 * 1000, `screenMs=${sched.INTERVALS.screenMs}`);
  ok(sched.INTERVALS.basketMs === 30 * 1000, `basketMs=${sched.INTERVALS.basketMs}`);
  ok(sched.INTERVALS.daily === '00:05', `daily=${sched.INTERVALS.daily}`);
  return `setInterval 间隔 ${sched.INTERVALS.basketMs / 1000}s 巡检 / ${sched.INTERVALS.screenMs / 60000}min 选品 / 日结 ${sched.INTERVALS.daily}`;
});
check('无 sleeper 空转：循环只用 setInterval + 状态落盘', () => {
  ok(/setInterval\(/.test(H), '未使用 setInterval');
  ok(!/while\s*\(\s*true\s*\)/.test(H), '存在 while(true) 空转');
  ok(!/setTimeout\([^)]*tick/.test(H), '用 setTimeout 递归代替 setInterval（变相空转）');
  ok(/storeSave\(/.test(H), '未落盘状态');
  return 'setInterval 两路（选品/巡检）+ store.save，无 while(true)/setTimeout 递归';
});
check('引擎接口按契约 §2.3 全部可达', () => {
  const need = {
    martin: ['sizeForMargin', 'nextAddPrice', 'basketPnl', 'liquidationPrice', 'shouldOpen', 'onPrice', 'newBasket'],
    risk: ['gate'], store: ['load', 'save'],
  };
  for (const [mod, fns] of Object.entries(need)) for (const f of fns) ok(typeof engines[mod][f] === 'function', `${mod}.${f} 缺失`);
  const i = engines.engineInfo();
  return `来源=${i.source}（真件 ${i.real.join(',') || '无'} / 桩 ${i.stub.join(',') || '无'}）`;
});
check('sizeForMargin 张数换算（保证金×杠杆/(面值×价)，对齐 lotSz，不足 minSz 返回 0）', () => {
  const c = engines.martin.sizeForMargin({ marginUsd: 10, leverage: 3, price: 100, ctVal: 0.1, lotSz: 1, minSz: 1 });
  ok(c === 3, `期望 3 张，得到 ${c}`);
  const zero = engines.martin.sizeForMargin({ marginUsd: 0.5, leverage: 3, price: 100, ctVal: 0.1, lotSz: 10, minSz: 10 });
  ok(zero === 0, `不足 minSz 应返回 0，得到 ${zero}`);
  return `10U×3x/(0.1×100) = ${c} 张；不足 minSz → ${zero}`;
});

/* ── ③ 选品落盘 ──────────────────────────────── */
await acheck('tickScreen 注入选品 → 落盘 candidates.json', async () => {
  const r = await sched.tickScreen({ screenFn: async () => SCREEN_RESULT });
  ok(r.ok, `tickScreen 失败：${r.error}`);
  const p = path.join(DATA, 'candidates.json');
  ok(fs.existsSync(p), '未生成 candidates.json');
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  ok(doc.picked.length === 5, `picked=${doc.picked.length}`);
  ok(doc.picked[0].allowDirections.length === 1, '缺 allowDirections');
  return `candidates.json ${fs.statSync(p).size}B · ${doc.picked.length} 候选 · 指标齐全（ATR%/VR5/ρ₁/RF/ADX/方向/总分）`;
});
check('候选池接口读到 data/candidates.json 内容', () => {
  const d = sched.getCandidates();
  ok(d.ok === true, 'ok!=true');
  ok(d.picked.length === 5 && d.picked[0].instId === PICK.instId, '内容与落盘不一致');
  ok(typeof d.ageSec === 'number' && d.universe.swaps === 467, 'ageSec/universe 缺失');
  return `updatedAt=${new Date(d.updatedAt).toISOString()} age=${d.ageSec}s · ${d.picked.length} 个候选`;
});
check('数据目录：默认 = 仓库 data/，env 可覆盖（MARTIN_DATA_DIR / MARTIN_STATE_PATH）', () => {
  ok(sched.paths().candidates === path.join(DATA, 'candidates.json'), `candidates=${sched.paths().candidates}`);
  ok(sched.statePath() === path.join(DATA, 'state.json'), `state=${sched.statePath()}`);
  const out = execFileSync(process.execPath, ['-e', "delete process.env.MARTIN_DATA_DIR;delete process.env.MARTIN_STATE_PATH;const s=require('./modules/scheduler.js');console.log(s.paths().candidates+'|'+s.paths().state)"], { cwd: ROOT, encoding: 'utf8' }).trim();
  const [c, st] = out.split('|');
  ok(c === path.join(ROOT, 'data', 'candidates.json'), `默认候选池路径 ${c}`);
  ok(st === path.join(ROOT, 'data', 'state.json'), `默认 state 路径 ${st}`);
  return `隔离时 ${path.basename(DATA)}/…；默认 data/candidates.json + data/state.json`;
});

/* ── ⑦ dry-run 开篮 ──────────────────────────── */
let opened = null;
await acheck('dry-run 开篮：返回预览、不建真实单（交易请求计数 = 0）', async () => {
  const before = orderCalls();
  const r = await sched.openBasket({ instId: PICK.instId });
  ok(r.ok === true, `开篮被拒：${r.error}（stage=${r.stage}）`);
  ok(r.dryRun === true && r.sent === false, `dryRun=${r.dryRun} sent=${r.sent}`);
  ok(r.preview && r.preview.instId === PICK.instId && r.preview.sz > 0, '预览缺 sz');
  ok(orderCalls() === before, `dry-run 却产生了交易请求：${JSON.stringify(COUNTER)}`);
  opened = r.basket;
  ok(opened.paper === true, 'dry-run 篮子未标 paper');
  ok(opened.side === 'long', `trend_up 候选应只做多，得到 ${opened.side}`);
  ok(opened.levels.length === 1 && opened.levels[0].contracts === 3, `首单张数=${opened.levels[0] && opened.levels[0].contracts}`);
  return `${r.basket.id} · ${r.basket.side} · 首单 ${r.basket.levels[0].contracts} 张 / ${r.basket.levels[0].marginUsd}U · 预览 sz=${r.preview.sz} · orderCalls=${orderCalls()}`;
});
check('篮子接口结构完整（契约 §3.2 区块②）', () => {
  const d = sched.getBaskets();
  ok(d.ok && d.count === 1, `count=${d.count}`);
  const b = d.baskets[0];
  for (const k of ['avgPx', 'contracts', 'marginUsd', 'upl', 'uplPct', 'nextAddPx', 'takeProfitPx', 'stopPx', 'liquidationPx', 'levelCount', 'levels']) ok(b[k] !== undefined, `缺字段 ${k}`);
  ok(b.nextAddPx < b.avgPx, '多头下一加仓价应低于均价');
  ok(b.takeProfitPx > b.avgPx, '多头止盈价应高于均价');
  ok(b.liquidationPx > 0 && b.liquidationPx < b.avgPx, `爆仓价 ${b.liquidationPx} 应在均价下方`);
  ok(b.levels[0].levelNo === 1, `层号应从 1 显示，得到 ${b.levels[0].levelNo}`);
  return `均价${b.avgPx} 张数${b.contracts} 保证金${b.marginUsd}U 浮盈${b.upl}(${b.uplPct}%) 加仓${b.nextAddPx} 止盈${b.takeProfitPx} 止损${b.stopPx} 爆仓${b.liquidationPx}`;
});

/* ── 巡检：加仓 / 爆仓 / 止盈 ─────────────────── */
await acheck('巡检 tickBaskets：击穿下一加仓价 → onPrice 出 add 事件并落第 2 层', async () => {
  const r = await sched.tickBaskets({ marketFn: mkMarket(97.9) });
  ok(r.ok && r.checked === 1, `checked=${r.checked} errors=${r.errors.join(';')}`);
  ok(r.events.some((e) => e.type === 'add'), `无 add 事件：${JSON.stringify(r.events)}`);
  const d = sched.getBaskets();
  ok(d.baskets[0].levelCount === 2, `层数=${d.baskets[0].levelCount}`);
  ok(d.baskets[0].levels[1].marginUsd > d.baskets[0].levels[0].marginUsd, '加仓保证金未按倍数放大');
  ok(orderCalls() === 0, `dry-run 产生交易请求：${JSON.stringify(COUNTER)}`);
  return `L1@100×3张 → L2×${d.baskets[0].levels[1].contracts}张（保证金 ${d.baskets[0].levels[0].marginUsd}→${d.baskets[0].levels[1].marginUsd}U）· orderCalls=0`;
});
await acheck('巡检 tickBaskets：跌穿逐仓爆仓价 → liquidation 平仓（不入库、不发单）', async () => {
  const liq = sched.getBaskets().baskets[0].liquidationPx;
  ok(liq > 0, `爆仓价异常：${liq}`);
  const r = await sched.tickBaskets({ marketFn: mkMarket(liq - 1) });
  ok(r.events.some((e) => e.type === 'liquidation'), `无 liquidation 事件：${JSON.stringify(r.events)}`);
  const d = sched.getBaskets();
  ok(d.count === 0 && d.history.length === 1, `未平仓：count=${d.count} hist=${d.history.length}`);
  ok(d.history[0].closeReason === 'liquidation', `平仓原因=${d.history[0].closeReason}`);
  ok(orderCalls() === 0, '爆仓路径不应发单');
  const s = sched.getState();
  ok(s.cooldowns === 0 || s.cooldowns >= 0, 'cooldowns 字段缺失');
  return `爆仓价 ${liq} → 触发价 ${liq - 1} · 平仓原因 ${d.history[0].closeReason} · 已实现 ${d.history[0].realizedPnl}U · 无交易请求`;
});
await acheck('冷却生效：刚止损/爆仓的品种在 cooldownHours 内被闸门拒绝', async () => {
  const r = await sched.openBasket({ instId: PICK.instId });
  ok(r.ok === false && /冷却/.test(r.error), `应因冷却被拒，实际：${JSON.stringify(r).slice(0, 160)}`);
  const st = engines.store.load(sched.statePath());
  ok(Number(st.cooldowns[PICK.instId]) > Date.now(), '未登记冷却');
  return `${PICK.instId} 冷却到 ${new Date(Number(st.cooldowns[PICK.instId])).toLocaleTimeString('zh-CN', { hour12: false })}（+${Math.round((Number(st.cooldowns[PICK.instId]) - Date.now()) / 60000)}min）→ 拒绝：${r.error}`;
});
await acheck('巡检 tickBaskets：触及整篮止盈 → 平仓、入 closed[]、权益与当日盈亏更新', async () => {
  const r0 = await sched.openBasket({ instId: PICK2.instId });
  ok(r0.ok, `重开失败：${r0.error}`);
  const eq0 = sched.getState().equity;
  const pnl0 = sched.getState().todayPnlUsd;
  const tp = sched.getBaskets().baskets[0].takeProfitPx;
  const r = await sched.tickBaskets({ marketFn: mkMarket(tp + 0.5) });
  ok(r.events.some((e) => e.type === 'take_profit'), `无 take_profit 事件：${JSON.stringify(r.events)}`);
  const d = sched.getBaskets();
  ok(d.count === 0 && d.history.length === 2, `count=${d.count} hist=${d.history.length}`);
  ok(d.history[1].realizedPnl > 0, `已实现盈亏 ${d.history[1].realizedPnl} 应为正`);
  const s = sched.getState();
  ok(s.equity > eq0, `权益未增加 ${eq0}→${s.equity}`);
  ok(s.todayPnlUsd > pnl0, `当日盈亏未改善 ${pnl0}→${s.todayPnlUsd}`);
  ok(s.events.some((e) => /止盈/.test(e.text)), '时间线缺止盈事件');
  ok(orderCalls() === 0, `dry-run 产生交易请求：${JSON.stringify(COUNTER)}`);
  return `止盈价 ${tp} → 平仓 ${d.history[1].realizedPnl}U · 权益 ${eq0}→${s.equity} · 当日 ${pnl0}→${s.todayPnlUsd}U（均含前面爆仓亏损）`;
});

/* ── 平仓接口（dry-run 只预览）────────────────── */
await acheck('dry-run 平仓：只返回预览，不发单，账务正确', async () => {
  await sched.openBasket({ instId: PICK3.instId });
  const id = sched.getBaskets().baskets[0].id;
  const before = orderCalls();
  const r = await sched.closeBasket({ id });
  ok(r.ok === true, `平仓失败：${r.error}`);
  ok(r.dryRun === true && r.sent === false, `dryRun=${r.dryRun} sent=${r.sent}`);
  ok(r.preview.reduceOnly === true, '平仓预览应 reduceOnly');
  ok(orderCalls() === before, `dry-run 却发单：${JSON.stringify(COUNTER)}`);
  ok(sched.getBaskets().history.length === 3, '历史未追加');
  return `篮子 ${id} 平仓 · ${r.pnl.upl}U · 预览 ${JSON.stringify(r.preview)} · orderCalls=${orderCalls()}`;
});

/* ── ⑤ policy 往返 ───────────────────────────── */
check('policy 读写往返 + 非法值拒绝（契约 §3.1）', () => {
  const before = sched.getPolicy().policy;
  const w = sched.savePolicy({ takeProfitPct: 1.2, maxLevels: 9, multiplier: 2, bogusKey: 1, leverage: -3, spacingMode: 'x' });
  ok(w.ok && w.policy.takeProfitPct === 1.2, '正常值未写入');
  for (const kw of ['bogusKey', 'leverage', 'spacingMode']) ok(w.rejected.some((x) => x.includes(kw)), `${kw} 未被拒绝`);
  const after = sched.getPolicy().policy;
  ok(after.takeProfitPct === 1.2, '回读不一致');
  ok(after.multiplier === 2 && after.maxLevels <= 4, `倍数 2.0 未收敛层数：${after.maxLevels}`);
  ok(fs.existsSync(path.join(DATA, 'policy.json')), 'policy.json 未落盘');
  sched.savePolicy({ takeProfitPct: before.takeProfitPct, multiplier: before.multiplier, maxLevels: before.maxLevels });
  return `takeProfitPct=${after.takeProfitPct}，倍率 2.0 → 层数收敛到 ${after.maxLevels}，拒绝 ${w.rejected.length} 项：${w.rejected.map((x) => x.split('=')[0]).join(',')}`;
});

/* ── ⑥ pause/resume + 熔断 ───────────────────── */
await acheck('pause/resume：暂停期间拒绝开新篮子，恢复后放行', async () => {
  const p = sched.pause();
  ok(p.ok && sched.getState().paused === true, '未进入暂停');
  const r1 = await sched.openBasket({ instId: PICK4.instId });
  ok(r1.ok === false, '暂停期间仍可开篮');
  const r2 = sched.resume({});
  ok(r2.ok && sched.getState().paused === false, '未恢复');
  const r3 = await sched.openBasket({ instId: PICK4.instId });
  ok(r3.ok === true, `恢复后开篮失败：${r3.error}`);
  await sched.closeBasket({ id: r3.basket.id });
  return `暂停 → 拒绝（${r1.error}）→ 恢复 → 开篮成功 ${r3.basket.id}`;
});
await acheck('熔断：日亏超限即时置位 → 拒绝开篮 → 人工确认后解除', async () => {
  const st = engines.store.load(sched.statePath());
  st.equity = (st.dayStartEquity || 1000) * 0.9;     // −10% < −6% 熔断线
  engines.store.save(st, sched.statePath());
  const t = await sched.tickBaskets({ marketFn: mkMarket(100) });
  ok(t.events.some((e) => e.type === 'circuit'), `未触发熔断：${JSON.stringify(t.events)}`);
  const s1 = sched.getState();
  ok(s1.circuitBreaker.tripped === true, `熔断未置位：${JSON.stringify(s1.circuitBreaker)}`);
  const r1 = await sched.openBasket({ instId: PICK5.instId });
  ok(r1.ok === false, '熔断期间仍可开篮');
  ok(/熔断/.test(r1.error), `拒绝原因应提到熔断：${r1.error}`);
  const rr = sched.resume({ confirmBreaker: true });
  ok(rr.breakerCleared === true && sched.getState().circuitBreaker.tripped === false, '人工解除失败');
  const st2 = engines.store.load(sched.statePath());
  st2.equity = st2.dayStartEquity;
  engines.store.save(st2, sched.statePath());
  const r2 = await sched.openBasket({ instId: PICK5.instId });
  ok(r2.ok === true, `解除后仍不能开篮：${r2.error}`);
  await sched.closeBasket({ id: r2.basket.id });
  return `当日 ${s1.todayPnlPct}% → 熔断(${s1.circuitBreaker.reason}) → 拒绝 → 人工解除 → 可开篮`;
});
await acheck('日结 dailySettle：结算当日盈亏、归零、熔断保持待人工确认', async () => {
  // 心跳里先记账「今日已日结」，避免 tickBaskets 的 00:05 判定重复触发
  const hbFile = path.join(DATA, 'scheduler.json');
  const hb = JSON.parse(fs.readFileSync(hbFile, 'utf8'));
  hb.lastDailyDay = '2026-09-21';
  fs.writeFileSync(hbFile, JSON.stringify(hb));
  const st = engines.store.load(sched.statePath());
  st.dailyLog = [];
  st.circuitBreaker = true; st.circuitBreakerReason = '测试用';
  st.closed = [...st.closed, { id: 'x', instId: PICK.instId, sector: PICK.sector, closeReason: 'stop_loss', closedAt: Date.now(), realizedPnl: -5, levels: [] }];
  engines.store.save(st, sched.statePath());
  const r = sched.dailySettle('2026-09-21');
  ok(r.ok === true, '日结失败');
  const s = sched.getState();
  ok(s.todayPnlPct === 0 && s.todayPnlUsd === 0, '当日盈亏未归零');
  ok(s.dailyLog.length === 1 && s.dailyLog[0].day === '2026-09-21', '日结记录未落盘');
  ok(s.circuitBreaker.tripped === true, '熔断应保持（需人工确认解除）');
  sched.resume({ confirmBreaker: true });
  return `日结 ${s.dailyLog[0].day}：${s.dailyLog[0].pnlUsd}U / ${s.dailyLog[0].pnlPct}% · 权益 ${s.dailyLog[0].equityEnd} · 熔断保持 tripped=true（人工可解除）`;
});

/* ── ⑧ HTTP E2E ──────────────────────────────── */
const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), MARTIN_DATA_DIR: DATA, MARTIN_STATE_PATH: path.join(DATA, 'state.json'), MARTIN_OFFLINE: '1', LIVE: '', OKX_CONFIG: '/nonexistent/okx.toml' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childLog = '';
child.stdout.on('data', (d) => { childLog += d; });
child.stderr.on('data', (d) => { childLog += d; });
const jget = async (p) => { const r = await fetch(BASE + p, { signal: AbortSignal.timeout(8000) }); return { status: r.status, ctype: r.headers.get('content-type') || '', body: await r.json() }; };
const jpost = async (p, b) => { const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}), signal: AbortSignal.timeout(8000) }); return { status: r.status, body: await r.json() }; };
let up = false;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(BASE + '/health', { signal: AbortSignal.timeout(1000) }); if (r.ok) { up = true; break; } } catch { /* 等启动 */ }
  await new Promise((r) => setTimeout(r, 200));
}
check('server.js 起得来（既有底座未被破坏）', () => {
  ok(up, `子进程未监听 ${PORT}；日志：${childLog.slice(0, 300)}`);
  return `http://127.0.0.1:${PORT} 已监听`;
});

if (up) {
  await acheck('GET /health 与 /api/config 语义未变（既有路由回归）', async () => {
    const h = await jget('/health');
    ok(h.body.ok === true && h.body.service === 'william-bot-1-core' && h.body.live === false, JSON.stringify(h.body).slice(0, 120));
    const c = await jget('/api/config');
    ok(c.body.ok === true && c.body.dryRun === true && Array.isArray(c.body.modules), JSON.stringify(c.body).slice(0, 120));
    return `health{ok, live=false} · config{dryRun=true, modules=${c.body.modules.length}}`;
  });
  await acheck('GET /api/martin/candidates：面板①区全部列可得', async () => {
    const r = await jget('/api/martin/candidates');
    ok(r.status === 200 && r.body.ok === true, JSON.stringify(r.body).slice(0, 160));
    const p = r.body.picked[0];
    for (const k of ['instId', 'sector', 'last', 'notionalUsd', 'atrPct', 'vr5', 'rho1', 'rf', 'adx', 'regime', 'allowDirections', 'score']) ok(p[k] !== undefined, `候选缺字段 ${k}`);
    return `HTTP 200 · ${r.body.picked.length} 候选 · 字段齐全（品种/板块/现价/成交额/ATR%/VR5/ρ₁/回归频率/ADX/状态/允许方向/总分）`;
  });
  await acheck('GET /api/martin/baskets：结构 + 逐层明细', async () => {
    const r = await jget('/api/martin/baskets');
    ok(r.status === 200 && r.body.ok === true && Array.isArray(r.body.baskets), JSON.stringify(r.body).slice(0, 160));
    ok(typeof r.body.totals.marginUsed === 'number' && Array.isArray(r.body.history), '缺 totals/history');
    return `baskets=${r.body.baskets.length} history=${r.body.history.length} 占用=${r.body.totals.marginUsed}U`;
  });
  await acheck('GET /api/martin/state：模式/心跳/候选池/熔断/曲线/事件', async () => {
    const b = (await jget('/api/martin/state')).body;
    ok(b.ok === true && b.mode === 'dry-run' && b.dryRun === true, JSON.stringify(b).slice(0, 160));
    for (const k of ['scheduler', 'candidates', 'circuitBreaker', 'orderGuard', 'curve', 'events', 'engine', 'policy']) ok(b[k] !== undefined, `缺字段 ${k}`);
    ok(b.orderGuard.orderRequests === 0, `dry-run 下 orderRequests=${b.orderGuard.orderRequests} 应为 0`);
    return `mode=${b.mode} 篮子=${b.openBaskets} 今日=${b.todayPnlUsd}U 心跳=${b.scheduler.heartbeatAgeSec ?? '无'}s 引擎=${b.engine.source} 曲线点数=${b.curve.length}`;
  });
  await acheck('policy 经 HTTP 读写往返', async () => {
    const before = (await jget('/api/martin/policy')).body.policy;
    const w = await jpost('/api/martin/policy', { spacingAtrMult: 1.2 });
    ok(w.body.ok === true && w.body.policy.spacingAtrMult === 1.2, JSON.stringify(w.body).slice(0, 160));
    const after = (await jget('/api/martin/policy')).body.policy;
    ok(after.spacingAtrMult === 1.2, '回读不一致');
    await jpost('/api/martin/policy', { spacingAtrMult: before.spacingAtrMult });
    return `spacingAtrMult ${before.spacingAtrMult} → 1.2 → 读回 ${after.spacingAtrMult}（已还原）`;
  });
  await acheck('POST /api/martin/open（dry-run 预览）+ 篮子数变化 + orderRequests 仍为 0', async () => {
    const n0 = (await jget('/api/martin/baskets')).body.count;
    const r = await jpost('/api/martin/open', { instId: PICK3.instId });   // CCC 是手动平仓，不在冷却期
    ok(r.status === 200 && r.body.ok === true, JSON.stringify(r.body).slice(0, 200));
    ok(r.body.dryRun === true && r.body.sent === false, 'dry-run 语义不符');
    ok(r.body.preview && r.body.preview.sz > 0, '缺预览');
    const n1 = (await jget('/api/martin/baskets')).body.count;
    ok(n1 === n0 + 1, `篮子数 ${n0}→${n1}`);
    const st = (await jget('/api/martin/state')).body;
    ok(st.orderGuard.orderRequests === 0 && orderCalls() === 0, `发了交易请求：${JSON.stringify(COUNTER)}`);
    return `开篮（纸面）→ 篮子 ${n0}→${n1} · preview.sz=${r.body.preview.sz} · orderRequests=0`;
  });
  await acheck('POST /api/martin/close/:id（dry-run 预览）', async () => {
    const bs = (await jget('/api/martin/baskets')).body.baskets;
    ok(bs.length >= 1, '无篮子可平');
    const r = await jpost('/api/martin/close/' + encodeURIComponent(bs[0].id), {});
    ok(r.status === 200 && r.body.ok === true, JSON.stringify(r.body).slice(0, 200));
    ok(r.body.dryRun === true && r.body.sent === false && r.body.preview.reduceOnly === true, 'dry-run 语义不符');
    const st = (await jget('/api/martin/state')).body;
    ok(st.orderGuard.orderRequests === 0 && orderCalls() === 0, '发了交易请求');
    return `平仓预览 ${JSON.stringify(r.body.preview)} · 已实现 ${r.body.pnl.upl}U · orderRequests=0`;
  });
  await acheck('POST /api/martin/pause → state.paused=true → resume', async () => {
    const p = await jpost('/api/martin/pause', {});
    ok(p.body.ok === true, JSON.stringify(p.body));
    ok((await jget('/api/martin/state')).body.paused === true, 'state 未反映暂停');
    const rr = await jpost('/api/martin/resume', {});
    ok(rr.body.ok === true && (await jget('/api/martin/state')).body.paused === false, '未恢复');
    return '暂停/恢复经 HTTP 生效并落盘';
  });
  await acheck('GET /api/martin/backtest + POST run-backtest：结构正确、如实反映脚本状态', async () => {
    const r = await jget('/api/martin/backtest');
    ok(r.status === 200, `status=${r.status}`);
    ok('verdict' in r.body && (r.body.summary === null || typeof r.body.summary === 'object'), 'summary/verdict 类型不符');
    const scriptExists = fs.existsSync(path.join(ROOT, 'scripts', 'martin-backtest.js'));
    const t = await jpost('/api/martin/run-backtest', {});
    ok(t.status === 200, `status=${t.status}`);
    if (scriptExists) {
      ok(t.body.ok === false || typeof t.body.jobId === 'string', '脚本存在时应返回 jobId');
      ok(Array.isArray(r.body.perSymbol) && Array.isArray(r.body.symbols), '缺 perSymbol/symbols');
      return `脚本存在 → 触发返回 ${t.body.ok ? 'jobId=' + t.body.jobId : '拒绝:' + t.body.error}；回测读取 ${r.body.ok ? 'ok（file=' + r.body.file + '）' : '如实报缺'}`;
    }
    ok(t.body.ok === false && t.body.jobId === null && /尚未交付/.test(t.body.error || ''), JSON.stringify(t.body).slice(0, 200));
    return `脚本缺失时如实报缺：${t.body.error}`;
  });
  await acheck('面板 /martin.html 与既有 / 均可访问（静态服务兼容）', async () => {
    const m = await fetch(BASE + '/martin.html', { signal: AbortSignal.timeout(8000) });
    const html = await m.text();
    ok(m.status === 200 && /text\/html/.test(m.headers.get('content-type') || ''), `status=${m.status}`);
    for (const kw of ['候选池', '篮子', '收益', '日志', '允许方向', '回归频率', 'dry-run', '爆仓价', '下一加仓价']) ok(html.includes(kw), `面板缺关键内容：${kw}`);
    const idx = await fetch(BASE + '/', { signal: AbortSignal.timeout(8000) });
    ok(idx.status === 200, `既有首页 status=${idx.status}`);
    return `/martin.html ${html.length}B（4 区块 + 候选池全部列）· 既有 / 200`;
  });
}
child.kill('SIGTERM');
await new Promise((r) => setTimeout(r, 300));

/* ── 生产数据未被污染 + dry-run 总闸 ─────────── */
check('隔离有效：生产 data/state.json 前后哈希一致', () => {
  const after = sha(PROD_STATE);
  ok(after === prodBefore, `生产 state.json 被改动（${prodBefore.slice(0, 12)} → ${after.slice(0, 12)}）`);
  return `sha256 ${after.slice(0, 16)}… 未变（自检全程写在 ${path.basename(DATA)}/）`;
});
check('dry-run 铁律总闸：全程 0 次真实交易请求', () => {
  ok(orderCalls() === 0, `调用统计 ${JSON.stringify(COUNTER)}`);
  return `placeOrder/closePosition/cancelOrder/setLeverage 调用次数 = 0（${JSON.stringify(COUNTER)}）`;
});

/* ── 输出 ─────────────────────────────────────── */
console.log('── 结果 ────────────────────────────────────────────────');
for (const r of results) console.log(`${r.ok ? '✅' : '❌'} ${r.name}\n     ${r.info}`);
console.log('────────────────────────────────────────────────────────');
const eng = engines.engineInfo();
console.log(`引擎来源：${eng.source}（真件 ${eng.real.join(',') || '无'} / 桩 ${eng.stub.join(',') || '无'}）`);
console.log(`通过 ${pass}/${results.length}`);
if (fails.length) { console.log('\n失败项：'); fails.forEach((f) => console.log('  · ' + f)); }
fs.rmSync(DATA, { recursive: true, force: true });
console.log(`临时数据目录已清理：${DATA}\n`);
process.exit(fails.length ? 1 : 0);
