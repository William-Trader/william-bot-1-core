/*!
 * scripts/martin-selftest.mjs - william-bot-1-core key backtest/optimize logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-34CD8DCD
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
#!/usr/bin/env node
/**
 * scripts/martin-selftest.mjs —— 类马丁纯函数自检（exit 0 = 全绿）
 * 覆盖：张数对齐/≥minSz · 加仓间距与倍数 · 整篮止盈价 · 硬止损 · 时间止损 · 爆仓价估算 ·
 *       风控闸门（日亏熔断/篮子数上限/费率闸门/板块去重/冷却）· 回测无未来函数不变量
 *
 * 用法：node scripts/martin-selftest.mjs
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const martin = require(path.join(root, 'modules/martin.js'));
const risk = require(path.join(root, 'modules/risk.js'));
const store = require(path.join(root, 'modules/store.js'));
const bt = require(path.join(root, 'scripts/martin-backtest.js'));

/* ── 迷你断言框架 ─────────────────────────────── */
let passed = 0;
const failures = [];
const results = [];
function check(name, fn) {
  try { fn(); passed++; results.push(`  ✓ ${name}`); }
  catch (e) { failures.push({ name, msg: e && e.message || String(e) }); results.push(`  ✗ ${name}\n      ${e && e.message || e}`); }
}
function ok(cond, msg = '断言失败') { if (!cond) throw new Error(msg); }
function eq(a, b, msg) {
  const A = typeof a === 'number' ? Number(a.toFixed(10)) : a;
  const B = typeof b === 'number' ? Number(b.toFixed(10)) : b;
  if (A !== B) throw new Error(`${msg || '不相等'}：实际 ${a} ≠ 期望 ${b}`);
}
function near(a, b, tol, msg) { if (Math.abs(a - b) > tol) throw new Error(`${msg || '差值超限'}：实际 ${a} vs 期望 ${b}（容差 ${tol}）`); }
const round4 = (v) => Number(Number(v).toFixed(4));

/* ── 夹具 ─────────────────────────────────────── */
// 老断言测「金额口径」旧路径 → 显式钉住 stopMode:'equity'；新口径由 PO_ATR 覆盖
const PO = { ...martin.DEFAULT_POLICY, stopMode: 'equity' };
const PO_ATR = { ...martin.DEFAULT_POLICY, stopMode: 'atr', deathAtrMult: 6, maxBasketRiskPct: 3 };
const ETH = { ctVal: 0.1, lotSz: 0.01, minSz: 0.01, maxLever: 100 };
const mkBasket = (over = {}) => {
  const b = martin.newBasket({
    instId: 'ETH-USDT-SWAP', side: 'long', sector: 'L1', price: 100, atr: 2,
    policy: PO, instrument: ETH, equity: 10000, ts: 1_700_000_000_000, regime: { regime: 'range', allow: ['long', 'short'] },
    ...over,
  });
  ok(b, 'newBasket 返回 null（夹具参数有问题）');
  return b;
};

console.log('\n=== martin-selftest ===\n');

/* 1. 张数换算 ─────────────────────────────────── */
check('sizeForMargin：ETH 真实规格（ctVal 0.1 / lotSz 0.01 / 价格 2664.19 / 保证金 100 / 3x）', () => {
  eq(martin.sizeForMargin({ marginUsd: 100, leverage: 3, price: 2664.19, ctVal: 0.1, lotSz: 0.01, minSz: 0.01 }), 1.12, '张数');
});
check('sizeForMargin：对齐 lotSz（返回必为 lotSz 整数倍）', () => {
  for (const [ctVal, price, lotSz] of [[0.1, 2664.19, 0.01], [1, 3.777, 1], [10, 0.5123, 0.1], [1000, 0.2077, 0.01]]) {
    const c = martin.sizeForMargin({ marginUsd: 137.4, leverage: 3, price, ctVal, lotSz, minSz: 0.01 });
    const n = c / lotSz;
    near(n, Math.round(n), 1e-6, `${ctVal}/${price} 未对齐 lotSz（${c} / ${lotSz}）`);
  }
});
check('sizeForMargin：算出不足 minSz → 返回 0（不向上取整，避免超预算占用保证金）', () => {
  eq(martin.sizeForMargin({ marginUsd: 0.1, leverage: 1, price: 100, ctVal: 0.1, lotSz: 0.01, minSz: 0.1 }), 0, '应返回 0');
  eq(martin.sizeForMargin({ marginUsd: 0, leverage: 3, price: 100, ctVal: 0.1, lotSz: 0.01, minSz: 0.01 }), 0, '零保证金应返回 0');
});
check('sizeForMargin：≥ minSz 时恒成立（随机 200 组）', () => {
  let seed = 42;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 200; i++) {
    const price = 0.5 + rnd() * 500, ctVal = [0.01, 0.1, 1, 10][i % 4], lotSz = [0.01, 0.1, 1][i % 3], minSz = lotSz * 1;
    const c = martin.sizeForMargin({ marginUsd: 50, leverage: 3, price, ctVal, lotSz, minSz });
    ok(c === 0 || c >= minSz, `算出 ${c} < minSz ${minSz}`);
    ok(c === 0 || Math.abs(c / lotSz - Math.round(c / lotSz)) < 1e-6, `未对齐 lotSz：${c}`);
  }
});
check('newBasket：首单张数不足 minSz 时返回 null', () => {
  eq(martin.newBasket({ instId: 'BTC-USDT-SWAP', side: 'long', sector: 'L1', price: 100000, atr: 100, policy: { ...PO, firstMarginPct: 0.001 }, instrument: { ctVal: 0.01, lotSz: 0.01, minSz: 0.01, maxLever: 100 }, equity: 10000 }), null, '应返回 null');
});

/* 2. 加仓几何 ─────────────────────────────────── */
check('nextAddPrice：ATR 模式 = 上一层价 − ATR×倍数（多）/ +（空）', () => {
  const b = mkBasket();
  eq(martin.nextAddPrice(b, 2), 98, '多单 ATR×1.0');
  eq(martin.nextAddPrice({ ...b, side: 'short' }, 2), 102, '空单 ATR×1.0');
  eq(martin.nextAddPrice({ ...b, policy: { ...PO, spacingAtrMult: 1.2 } }, 2), 97.6, 'ATR×1.2');
  eq(martin.nextAddPrice({ ...b, policy: { ...PO, spacingAtrMult: 0.8 } }, 2), 98.4, 'ATR×0.8');
});
check('nextAddPrice：pct 模式 = 上一层价 × 间距%', () => {
  const b = mkBasket({ policy: { ...PO, spacingMode: 'pct', spacingPct: 0.8 } });
  eq(martin.nextAddPrice(b, 2), 99.2, 'pct 0.8%');
});
check('nextAddPrice：满层返回 null', () => {
  const b = mkBasket();
  b.levels = Array.from({ length: 6 }, (_, i) => ({ idx: i, ts: 1, price: 100 - i * 2, contracts: 30, marginUsd: 100, reason: 'add' }));
  eq(martin.nextAddPrice(b, 2), null, '满 6 层应为 null');
});
check('层保证金：首单 × multiplier^(k-1)，累计 = 设计文档保证金表', () => {
  const b = mkBasket();
  eq(martin.levelMargin(b, 0), 100, '第 1 层');
  eq(martin.levelMargin(b, 1), 150, '第 2 层');
  eq(martin.levelMargin(b, 2), 225, '第 3 层');
  eq(martin.levelMargin(b, 5), 759.375, '第 6 层');
  eq(martin.cumulativeMargin(b, 5), 2078.125, '满 6 层累计 = 权益 20.78%');
});

/* 3. 篮子盈亏 / 止盈价 ─────────────────────────── */
check('basketPnl：加权均价 / 张数 / 名义 / 浮盈 / 浮盈%', () => {
  const b = mkBasket();
  b.levels = [
    { idx: 0, ts: 1, price: 100, contracts: 10, marginUsd: 33.33, reason: 'entry' },
    { idx: 1, ts: 2, price: 90, contracts: 20, marginUsd: 50, reason: 'add' },
  ];
  const p = martin.basketPnl(b, 95);
  near(p.avgPx, 93.3333333, 1e-6, '均价');
  eq(p.contracts, 30, '张数');
  near(p.notionalUsd, 285, 1e-6, '名义价值 (ctVal 0.1 × 30 × 95)');
  near(p.upl, 5, 1e-6, '浮盈 ((95−93.3333)×3)');
  near(p.uplPct, (5 / 83.33) * 100, 1e-4, '浮盈%');
});
check('basketPnl：空单方向相反', () => {
  const b = mkBasket({ side: 'short' });
  eq(martin.basketPnl(b, 90).upl, 30, '空单价格跌 10% → +30');
  eq(martin.basketPnl(b, 110).upl, -30, '空单价格涨 10% → −30');
});
check('takeProfitPrice：均价 ± takeProfitPct%', () => {
  const b = mkBasket();
  eq(martin.takeProfitPrice(b), 100.8, '多单 +0.8%');
  eq(martin.takeProfitPrice({ ...b, side: 'short' }), 99.2, '空单 −0.8%');
});
check('onPrice：触及止盈价 → take_profit 且篮子关闭', () => {
  const b = mkBasket();
  const tp = martin.takeProfitPrice(b);
  const r1 = martin.onPrice(b, { price: tp - 0.01, atr: 2, ts: b.openedAt + 3600e3 });
  eq(r1.events.length, 0, '未到价不应有事件');
  const r2 = martin.onPrice(b, { price: tp, atr: 2, ts: b.openedAt + 2 * 3600e3 });
  eq(r2.events[0].type, 'take_profit', '事件类型');
  eq(b.closed, true, '篮子应关闭');
  eq(b.closeReason, 'take_profit', '关闭原因');
  near(b.realizedPnl, 0.1 * 30 * 0.8, 0.01, '毛盈亏 = 3 币 × 0.8');
});

/* 4. 止损 / 爆仓 / 时间止损 / 趋势反转 ─────────── */
check('stopPrice：整篮浮亏 = 开仓权益 × hardStopPct% 对应的价格', () => {
  const b = martin.newBasket({
    instId: 'X-USDT-SWAP', side: 'long', sector: 'Other:X', price: 100, atr: 2,
    policy: { ...PO, firstMarginPct: 20 }, instrument: { ctVal: 1, lotSz: 1, minSz: 1, maxLever: 100 },
    equity: 10000, ts: 1,
  });
  eq(b.stopUsd, 400, 'stopUsd = 权益 4%');
  eq(b.levels[0].contracts, 60, '张数 (2000×3/100)');
  near(martin.stopPrice(b), 100 - 400 / 60, 1e-6, '止损价');   // 93.3333
  const b2 = { ...b, side: 'short' };
  near(martin.stopPrice(b2), 100 + 400 / 60, 1e-6, '空单止损价');
});
check('onPrice：触及止损价 → stop_loss；未触及不动', () => {
  const deep = { policy: { ...PO, firstMarginPct: 20, maxLevels: 1, maxBasketRiskPct: 99 }, instrument: { ctVal: 1, lotSz: 1, minSz: 1, maxLever: 100 } };
  const b = martin.newBasket({ instId: 'X-USDT-SWAP', side: 'long', sector: 'Other:X', price: 100, atr: 2, equity: 10000, ts: 1, ...deep });
  const sl = martin.stopPrice(b);
  ok(sl !== null, '止损价应可算');
  eq(martin.onPrice(b, { price: sl + 0.01, atr: 2, ts: b.openedAt + 600e3 }).events.length, 0, '止损价上方不应触发');
  eq(martin.onPrice(b, { price: 100.5, atr: 2, ts: b.openedAt + 900e3 }).events.length, 0, '均价附近不应触发');
  const r = martin.onPrice(b, { price: sl, atr: 2, ts: b.openedAt + 1200e3 });
  eq(r.events[0].type, 'stop_loss', '事件类型');
  near(r.events[0].pnlUsd, -400, 0.01, '止损毛亏 = −400');
});
check('onPrice：止损优先于加仓（同一价格两个价都碰到 → 先止损）', () => {
  const b = martin.newBasket({ instId: 'X-USDT-SWAP', side: 'long', sector: 'Other:X', price: 100, atr: 2,
    policy: { ...PO, firstMarginPct: 20 }, instrument: { ctVal: 1, lotSz: 1, minSz: 1, maxLever: 100 }, equity: 10000, ts: 1 });
  const sl = martin.stopPrice(b);          // 93.33
  eq(martin.nextAddPrice(b, 2), 98, '第 2 层价在止损价之上');
  const r = martin.onPrice(b, { price: sl, atr: 2, ts: b.openedAt + 600e3 });
  ok(['stop_loss','risk_stop'].includes(r.events[0] && r.events[0].type), '应先平仓而不是加仓（金额兜底更早触发属设计），实际=' + (r.events[0] && r.events[0].type));
  eq(b.levels.length, 1, '不应加仓');
});
check('liquidationPrice：逐仓估算（多单 < 均价，空单 > 均价；3x ≈ −33%）', () => {
  const b = mkBasket();                     // 100 价 / 30 张 / ctVal 0.1 / 保证金 100
  const liq = martin.liquidationPrice(b, 0);
  near(liq, 100 - 100 / 3, 1e-6, '多单爆仓价 (mmr=0)');       // 66.667
  const sh = martin.liquidationPrice({ ...b, side: 'short' }, 0);
  near(sh, 100 + 100 / 3, 1e-6, '空单爆仓价 (mmr=0)');        // 133.333
  ok(martin.liquidationPrice(b) < 100 && martin.liquidationPrice(b) > liq, 'mmr>0 时多单爆仓价更高 = 更近');
  ok(martin.liquidationPrice({ ...b, side: 'short' }) < sh && martin.liquidationPrice({ ...b, side: 'short' }) > 100, 'mmr>0 时空单爆仓价更低 = 更近');
});
check('【新口径】浅篮子必须有真实止损，且早于爆仓触发', () => {
  const b = mkBasket({ policy: { ...PO_ATR, firstMarginPct: 1 } });
  const sl = martin.stopPrice(b);
  ok(sl !== null && sl > 0, '浅篮子也必须有止损价（旧行为返回 null 是缺陷）');
  const liq = martin.liquidationPrice(b, 0.005);
  ok(Math.abs(sl - 100) < Math.abs(liq - 100), '止损必须早于爆仓（sl=' + sl + ' liq=' + liq + '）');
});
check('onPrice：触及爆仓价 → liquidation（首单篮子真实约束）', () => {
  const b = mkBasket();
  const liq = martin.liquidationPrice(b);
  const r = martin.onPrice(b, { price: liq - 0.01, atr: 2, ts: b.openedAt + 3600e3 });
  eq(r.events[0].type, 'liquidation', '事件类型');
  near(b.finalUpl, -100 * (1 - Number(PO.mmr || 0.005)), 1, '爆仓亏掉 ≈ 本篮保证金');
});
check('onPrice：时间止损（48h 未止盈 → time_stop）', () => {
  const b = mkBasket();
  const ts = b.openedAt + 48 * 3600e3;
  const r = martin.onPrice(b, { price: 100, atr: 2, ts });
  eq(r.events[0].type, 'time_stop', '事件类型');
  near(r.events[0].hours, 48, 0.01, '持仓小时');
});
check('onPrice：时间没到不触发时间止损', () => {
  const b = mkBasket();
  const r = martin.onPrice(b, { price: 100, atr: 2, ts: b.openedAt + 47.9 * 3600e3 });
  eq(r.events.length, 0, '不应有事件');
});
check('onPrice：反向确认趋势 → trend_flip 平仓（unclear 不乱杀）', () => {
  const b = mkBasket();
  const r0 = martin.onPrice(b, { price: 100, atr: 2, regime: { regime: 'unclear', allow: [] }, ts: b.openedAt + 600e3 });
  eq(r0.events.length, 0, 'unclear 不应离场');
  const r = martin.onPrice(b, { price: 100, atr: 2, regime: { regime: 'trend_down', allow: ['short'] }, ts: b.openedAt + 1200e3 });
  eq(r.events[0].type, 'trend_flip', '事件类型');
  eq(b.closed, true, '应平仓');
});

/* 5. 加仓链条 ─────────────────────────────────── */
check('onPrice：逐层加仓 —— 倍数、层保证金、均价、总保证金', () => {
  const b = mkBasket();
  const lv1 = martin.nextAddPrice(b, 2);
  eq(lv1, 98, '第 2 层价');
  const r1 = martin.onPrice(b, { price: lv1, atr: 2, ts: b.openedAt + 3600e3 });
  eq(r1.events[0].type, 'add', '事件类型');
  eq(r1.events[0].levelNo, 2, '层号');
  eq(b.levels.length, 2, '层数');
  eq(b.levels[1].marginUsd, 150, '第 2 层保证金 = 100×1.5');
  near(martin.basketPnl(b, 98).marginUsd, 250, 1e-6, '累计保证金 250（2.5% 权益）');
  const r2 = martin.onPrice(b, { price: 96, atr: 2, ts: b.openedAt + 7200e3 });
  eq(r2.events[0].type, 'add', '第 3 层');
  eq(b.levels[2].marginUsd, 225, '第 3 层保证金 = 100×1.5²');
  near(martin.basketPnl(b, 96).marginUsd, 475, 1e-6, '累计保证金 475（4.75% 权益）');
});
check('onPrice：满层后不再加仓（只等止盈/止损）', () => {
  const b = mkBasket({ policy: { ...PO, maxLevels: 2 } });
  martin.onPrice(b, { price: 98, atr: 2, ts: b.openedAt + 3600e3 });
  eq(b.levels.length, 2, '已满 2 层');
  const r = martin.onPrice(b, { price: 90, atr: 2, ts: b.openedAt + 7200e3 });
  eq(r.events.some((e) => e.type === 'add'), false, '不应再加仓');
  eq(b.levels.length, 2, '层数不变');
});
check('onPrice：黑天鹅闸门（上一根 1H 反向 >5%）→ 不加仓', () => {
  const b = mkBasket();
  const r = martin.onPrice(b, { price: 98, atr: 2, regime: { regime: 'range', allow: ['long', 'short'], barChangePct: -6 }, ts: b.openedAt + 3600e3 });
  eq(r.events[0].type, 'add_blocked', '事件类型');
  eq(b.levels.length, 1, '层数不变');
});
check('onPrice：可用保证金不足 → 不加仓（加仓被拦）', () => {
  const b = mkBasket();
  const r = martin.onPrice(b, { price: 98, atr: 2, ts: b.openedAt + 3600e3, availableMarginUsd: 10 });
  eq(r.events[0].type, 'add_blocked', '事件类型');
  ok(/可用保证金不足/.test(r.events[0].reason), '原因应为保证金不足');
});
check('onPrice：已平仓篮子再喂价 → 无事件、无副作用', () => {
  const b = mkBasket();
  martin.onPrice(b, { price: 100.8, atr: 2, ts: b.openedAt + 3600e3 });
  const r = martin.onPrice(b, { price: 50, atr: 2, ts: b.openedAt + 7200e3 });
  eq(r.events.length, 0, '不应有事件');
  eq(b.levels.length, 1, '层数不变');
});

/* 6. 风控闸门 ─────────────────────────────────── */
const G = (over = {}) => risk.gate({
  state: store.emptyState(), policy: PO, equity: 10000, todayPnlPct: 0,
  funding: 0.0001, sector: 'L1', openBaskets: [], instId: 'ETH-USDT-SWAP', atrPct: 1.5, ...over,
});
check('gate：正常情况放行', () => {
  const r = G();
  eq(r.allow, true, '应放行');
  eq(r.reason, 'ok', '原因');
});
check('gate：日亏熔断（−6%）', () => {
  const r = G({ todayPnlPct: -6.1 });
  eq(r.allow, false, '应拦截');
  ok(/熔断/.test(r.reason), `原因应含熔断，实际：${r.reason}`);
  eq(G({ todayPnlPct: -5.9 }).allow, true, '未到阈值应放行');
});
check('gate：state.circuitBreaker 置位 → 拦截（需人工解除）', () => {
  const st = store.emptyState({ circuitBreaker: true, circuitBreakerReason: '当日亏损 6.4%' });
  const r = G({ state: st });
  eq(r.allow, false, '应拦截');
  ok(/熔断/.test(r.reason), '原因');
});
check('gate：篮子数上限（3）', () => {
  const open = [{ instId: 'A', sector: 'X' }, { instId: 'B', sector: 'Y' }, { instId: 'C', sector: 'Z' }];
  const r = G({ openBaskets: open });
  eq(r.allow, false, '应拦截');
  ok(/篮子数上限/.test(r.reason), `原因：${r.reason}`);
  eq(G({ openBaskets: 2 }).allow, true, '数字写法也应支持');
});
check('gate：费率闸门（|funding| > 0.10%）', () => {
  const r = G({ funding: 0.0012 });
  eq(r.allow, false, '应拦截');
  ok(/费率闸门/.test(r.reason), `原因：${r.reason}`);
  eq(G({ funding: -0.0009 }).allow, true, '反向高费同理放行');
});
check('gate：板块去重（同板块已有篮子）', () => {
  const r = G({ openBaskets: [{ instId: 'DOGE-USDT-SWAP', sector: 'MEME' }], sector: 'MEME' });
  eq(r.allow, false, '应拦截');
  ok(/板块去重/.test(r.reason), `原因：${r.reason}`);
  eq(G({ openBaskets: [{ instId: 'DOGE-USDT-SWAP', sector: 'MEME' }], sector: 'L1' }).allow, true, '不同板块应放行');
});
check('gate：冷却（单品种止损后 4h）', () => {
  const now = 1_700_000_000_000;
  const st = store.emptyState({ cooldowns: { 'ETH-USDT-SWAP': now + 3600e3 } });
  const r = G({ state: st, now });
  eq(r.allow, false, '应拦截');
  ok(/冷却/.test(r.reason), `原因：${r.reason}`);
  eq(G({ state: st, now: now + 3700e3 }).allow, true, '冷却过后放行');
});
check('gate：黑天鹅 / 波动区间 / 权益为负', () => {
  eq(G({ barChangePct: -5.5 }).allow, false, '黑天鹅应拦截');
  eq(G({ atrPct: 0.2 }).allow, false, '波动过低应拦截');
  eq(G({ atrPct: 9 }).allow, false, '波动过高应拦截');
  eq(G({ equity: 0 }).allow, false, '零权益应拦截');
});
check('markCooldown / pruneCooldowns', () => {
  const st = store.emptyState();
  const t = 1_700_000_000_000;
  eq(risk.markCooldown(st, 'ETH-USDT-SWAP', PO, t), t + 4 * 3600e3, '冷却到期时间');
  risk.pruneCooldowns(st, t + 5 * 3600e3);
  eq(Object.keys(st.cooldowns).length, 0, '过期应清理');
});
check('settleDay：日结置熔断，autoReset 才自动解除', () => {
  const st = store.emptyState();
  const a = risk.settleDay(st, { equity: 9300, dayStartEquity: 10000, day: '2026-09-20', ts: 1, autoReset: false });
  eq(a.summary.breached, true, '应判熔断');
  eq(st.circuitBreaker, true, '状态置位');
  risk.settleDay(st, { equity: 9700, dayStartEquity: 9300, day: '2026-09-21', ts: 2, autoReset: false });
  eq(st.circuitBreaker, true, 'autoReset=false 不应自动解除');
  risk.settleDay(st, { equity: 9800, dayStartEquity: 9700, day: '2026-09-22', ts: 3, autoReset: true });
  eq(st.circuitBreaker, false, 'autoReset=true 才解除');
});

/* 7. 开仓判定（状态 → 方向） ───────────────────── */
check('shouldOpen：趋势状态只做顺势方向', () => {
  eq(martin.shouldOpen({ policy: PO, regime: { regime: 'trend_up', allow: ['long'] }, funding: 0, atrPct: 1.5, equity: 10000, openBaskets: [], sector: 'L1' }).side, 'long', 'trend_up → long');
  eq(martin.shouldOpen({ policy: PO, regime: { regime: 'trend_down', allow: ['short'] }, funding: 0, atrPct: 1.5, equity: 10000, openBaskets: [], sector: 'L1' }).side, 'short', 'trend_down → short');
});
check('shouldOpen：震荡状态顺均值回归方向（价格低于 EMA50 做多）', () => {
  const base = { policy: PO, funding: 0, atrPct: 1.5, equity: 10000, openBaskets: [], sector: 'L1' };
  eq(martin.shouldOpen({ ...base, regime: { regime: 'range', allow: ['long', 'short'], price: 99, ema50: 100 } }).side, 'long', '低于均线做多');
  eq(martin.shouldOpen({ ...base, regime: { regime: 'range', allow: ['long', 'short'], price: 101, ema50: 100 } }).side, 'short', '高于均线做空');
});
check('shouldOpen：unclear / 闸门不通过时拒绝并给原因', () => {
  const base = { policy: PO, funding: 0, atrPct: 1.5, equity: 10000, openBaskets: [], sector: 'L1' };
  const r = martin.shouldOpen({ ...base, regime: { regime: 'unclear', allow: [] } });
  eq(r.ok, false, 'unclear 应拒绝');
  ok(/不开新篮子/.test(r.reason), `原因：${r.reason}`);
  eq(martin.shouldOpen({ ...base, regime: { regime: 'range', allow: ['long', 'short'], price: 99, ema50: 100 }, funding: 0.01 }).ok, false, '高费率应拒绝');
  eq(martin.shouldOpen({ ...base, regime: { regime: 'range', allow: ['long', 'short'], price: 99, ema50: 100 }, todayPnlPct: -7 }).ok, false, '日亏熔断应拒绝');
});

/* 8. store 原子落盘 ───────────────────────────── */
check('store：原子写 + 读回一致；损坏文件不阻塞启动', () => {
  const os = require('os');
  const f = path.join(os.tmpdir(), `martin-selftest-${process.pid}.json`);
  const st = store.emptyState({ equity: 12345.67, baskets: [{ id: 'x' }] });
  store.save(st, f);
  const back = store.load(f);
  eq(back.equity, 12345.67, 'equity 读回');
  eq(back.baskets[0].id, 'x', '嵌套结构读回');
  ok(back.savedAt, 'savedAt 应写入');
  require('fs').writeFileSync(f, '{ 坏掉的 json');
  const rec = store.load(f);
  eq(rec.equity, null, '损坏 → 返回 emptyState');
  eq(rec.baskets.length, 0, '损坏 → 空篮子');
  require('fs').rmSync(f, { force: true });
});

/* 9. 回测不变量：无未来函数 + 可复现 ───────────── */
function genCandles(n, seed = 7, startTs = 1_700_000_000_000) {
  let s = seed;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const out = [];
  let px = 100;
  for (let i = 0; i < n; i++) {
    const drift = 0.05 * Math.sin(i / 26) + 0.02 * Math.sin(i / 6.7) + 0.0004 * Math.sin(i / 130);
    const ret = drift / 100 + (rnd() - 0.5) * 0.014;
    const o = px, c = px * (1 + ret);
    out.push({ ts: startTs + i * 3600e3, o, h: Math.max(o, c) * (1 + rnd() * 0.004), l: Math.min(o, c) * (1 - rnd() * 0.004), c });
    px = c;
  }
  return out;
}
function mkData(candles) {
  const funding = [];
  for (let ts = candles[0].ts; ts <= candles[candles.length - 1].ts; ts += 8 * 3600e3) funding.push({ ts, rate: 0.0001 });
  return [{
    instId: 'SYN-USDT-SWAP', sector: 'L1',
    instrument: { ctVal: 0.1, lotSz: 0.01, minSz: 0.01, maxLever: 100 },
    candles, funding, ind: bt.buildIndicators(candles),
  }];
}
const full = genCandles(900);
const cut = full.slice(0, 640);
const runFull = bt.simulate({ data: mkData(full), policy: bt.BASE_POLICY, equity0: 10000, feeBps: 8 });
const runCut = bt.simulate({ data: mkData(cut), policy: bt.BASE_POLICY, equity0: 10000, feeBps: 8 });

check('回测不变量：截断未来数据不改变已发生的历史成交（无未来函数）', () => {
  const cutEnd = cut[cut.length - 1].ts;
  const histFull = runFull.trades.filter((t) => Date.parse(t.closedAt) <= cutEnd && t.reason !== 'eod_close');
  const histCut = runCut.trades.filter((t) => t.reason !== 'eod_close');
  eq(histCut.length, histFull.length, '公共窗口成交笔数');
  for (let i = 0; i < histCut.length; i++) {
    eq(JSON.stringify(histCut[i]), JSON.stringify(histFull[i]), `第 ${i + 1} 笔成交不一致`);
  }
  ok(histFull.length > 0, '合成数据应至少产生 1 笔成交（否则不变量测试为空转）');
});
check('回测不变量：决策只用 i-1（首笔成交时间晚于 LOOKBACK 窗口）', () => {
  for (const t of runFull.trades) {
    ok(Date.parse(t.openedAt) >= full[bt.LOOKBACK].ts, `成交早于预热窗口：${t.openedAt}`);
  }
});
check('回测可复现：同参数两次运行结果完全一致', () => {
  const a = bt.simulate({ data: mkData(full), policy: bt.BASE_POLICY, equity0: 10000, feeBps: 8 });
  const b = bt.simulate({ data: mkData(full), policy: bt.BASE_POLICY, equity0: 10000, feeBps: 8 });
  eq(JSON.stringify(a.summary), JSON.stringify(b.summary), '汇总不一致');
  eq(JSON.stringify(a.trades), JSON.stringify(b.trades), '成交明细不一致');
});
check('回测：成本计入（手续费 > 0，资金费按费率实际结算）', () => {
  ok(runFull.summary.totalFeesUsd > 0, '应有手续费');
  ok(Math.abs(runFull.summary.totalFundingUsd) > 0, `资金费应有发生额，实际 ${runFull.summary.totalFundingUsd}`);
  const noFunding = bt.simulate({ data: mkData(full), policy: bt.BASE_POLICY, equity0: 10000, feeBps: 8, fundingIncluded: false });
  eq(noFunding.summary.totalFundingUsd, 0, 'fundingIncluded=false 应无资金费');
  ok(noFunding.summary.netPnlUsd !== runFull.summary.netPnlUsd, '资金费应影响净盈亏');
  const noFee = bt.simulate({ data: mkData(full), policy: bt.BASE_POLICY, equity0: 10000, feeBps: 0 });
  ok(noFee.summary.totalFeesUsd === 0, 'feeBps=0 应无手续费');
  ok(noFee.summary.netPnlUsd > runFull.summary.netPnlUsd, '零成本净盈亏应更高');
});
check('回测不变量：每层成交价都落在其时间戳所在 K 线的 [low, high] 内（挂单价不可能在 K 线之外）', () => {
  const bars = new Map(full.map((b) => [b.ts, b]));
  let n = 0;
  for (const t of runFull.trades) {
    for (const l of t.levelsDetail) {
      const b = bars.get(Date.parse(l.ts));
      ok(b, `找不到 ${l.ts} 的 K 线`);
      ok(l.price >= b.l - 1e-9 && l.price <= b.h + 1e-9, `${t.instId} 第 ${l.idx + 1} 层成交价 ${l.price} 越出 K 线 [${b.l}, ${b.h}]`);
      n++;
    }
    const cb = bars.get(Date.parse(t.closedAt));
    if (cb && t.reason !== 'eod_close') {
      ok(t.closePrice >= cb.l - 1e-9 && t.closePrice <= cb.h + 1e-9, `${t.instId} 平仓价 ${t.closePrice} 越出 K 线 [${cb.l}, ${cb.h}]`);
    }
  }
  ok(n > 0, '应至少检查到一个层');
});
check('回测不变量：均价 = 按张数加权层价；止盈价 = 均价×1.008（多）/×0.992（空）', () => {
  for (const t of runFull.trades) {
    const q = t.levelsDetail.reduce((a, l) => a + l.contracts, 0);
    const avg = t.levelsDetail.reduce((a, l) => a + l.contracts * l.price, 0) / q;
    near(avg, t.avgPx, 1e-5, `${t.instId} 均价`);
    if (t.reason === 'take_profit') near(avg * (t.side === 'long' ? 1.008 : 0.992), t.closePrice, 1e-5, `${t.instId} 止盈价`);
  }
});
check('回测：成交层级 ≤ maxLevels、止损/止盈原因合法、无负张数', () => {
  const legal = new Set(['take_profit', 'stop_loss', 'time_stop', 'trend_flip', 'liquidation', 'eod_close']);
  for (const t of runFull.trades) {
    ok(t.levels >= 1 && t.levels <= 6, `层数越界：${t.levels}`);
    ok(legal.has(t.reason), `非法平仓原因：${t.reason}`);
    ok(t.pnlUsd === null || Number.isFinite(t.pnlUsd), '盈亏应为有限数');
  }
});

/* 10. 滑点 ─────────────────────────────────────── */
check('slipFactors / entryFillPx / exitFillPx：买上浮卖下浮，slip=0 恰为原值', () => {
  eq(martin.slipFactors('long', 0).entry, 1, 'slip=0 entry 乘数');
  eq(martin.slipFactors('long', 0).exit, 1, 'slip=0 exit 乘数');
  near(martin.slipFactors('long', 10).entry, 1.001, 1e-12, '多单买入上浮');
  near(martin.slipFactors('long', 10).exit, 0.999, 1e-12, '多单卖出下浮');
  near(martin.slipFactors('short', 10).entry, 0.999, 1e-12, '空单卖出下浮');
  near(martin.slipFactors('short', 10).exit, 1.001, 1e-12, '空单买入上浮');
  eq(martin.entryFillPx(100, 'long', 10), 100.1, '多单买入成交价');
  eq(martin.exitFillPx(100, 'long', 10), 99.9, '多单卖出成交价');
  eq(martin.entryFillPx(100, 'long', 0), 100, 'slip=0 应为原值');
});
check('onPrice：滑点只推成交价、不改触发价（多单止盈成交价变差、盈亏变低）', () => {
  const b0 = mkBasket(); const b1 = mkBasket();
  const tp = martin.takeProfitPrice(b0);
  const r0 = martin.onPrice(b0, { price: tp, atr: 2, ts: b0.openedAt + 3600e3, slipBps: 0 });
  const r1 = martin.onPrice(b1, { price: tp, atr: 2, ts: b1.openedAt + 3600e3, slipBps: 20 });
  eq(r0.events[0].type, 'take_profit', '无滑点事件');
  eq(r1.events[0].type, 'take_profit', '有滑点事件');
  near(r1.events[0].fillPx, tp * 0.998, 1e-9, '滑点 20bps → 成交价 = 触发价×0.998');
  near(r1.events[0].triggerPx, r0.events[0].triggerPx, 1e-12, '触发价不受滑点影响');
  ok(r1.events[0].pnlUsd < r0.events[0].pnlUsd, '滑点应降低盈亏');
});
check('onPrice：空单滑点方向相反（平仓买入上浮 = 更差）', () => {
  const b = mkBasket({ side: 'short' });
  const tp = martin.takeProfitPrice(b);
  const r = martin.onPrice(b, { price: tp, atr: 2, ts: b.openedAt + 3600e3, slipBps: 20 });
  eq(r.events[0].type, 'take_profit', '事件');
  near(r.events[0].fillPx, tp * 1.002, 1e-9, '空单止盈成交价上浮 20bps');
});
check('onPrice：加仓也施加滑点（多单买得更高）', () => {
  const b = mkBasket();
  const addPx = martin.nextAddPrice(b, 2);
  const r = martin.onPrice(b, { price: addPx, atr: 2, ts: b.openedAt + 3600e3, slipBps: 50 });
  eq(r.events[0].type, 'add', '事件类型');
  near(b.levels[1].price, addPx * 1.005, 1e-9, '多单加仓成交价上浮 50bps');
  near(r.events[0].addPx, addPx, 1e-12, '挂单价不变');
});
check('回测：slipBps=0 与不传滑点结果逐字节一致（向后兼容）', () => {
  const r0 = bt.simulate({ data: mkData(full), policy: bt.BASE_POLICY, equity0: 10000, feeBps: 8, slipBps: 0 });
  eq(JSON.stringify(r0.trades), JSON.stringify(runFull.trades), 'slip=0 成交明细');
  eq(JSON.stringify(r0.summary), JSON.stringify(runFull.summary), 'slip=0 汇总');
});
check('回测：滑点越高期望越低（逐次成交都施加）', () => {
  const seq = [0, 2, 5].map((s) => bt.simulate({ data: mkData(full), policy: bt.BASE_POLICY, equity0: 10000, feeBps: 8, slipBps: s }).summary.expectancyUsd);
  ok(seq[0] > seq[1] && seq[1] > seq[2], `期望应单调下降，实际 ${seq.join(' / ')}`);
  ok(runFull.summary.totalFeesUsd > 0, '手续费基线');
});

/* 11. walk-forward 分折（样本外） ─────────────── */
const full2 = genCandles(1400, 11);
const data2 = () => mkData(full2);
const wf5 = bt.walkForward({ data: data2(), policy: bt.BASE_POLICY, equity0: 10000, feeBps: 8, folds: 5 });
check('walkForward：折数正确、区间首尾相接且覆盖整个窗口', () => {
  eq(wf5.folds.length, 5, '折数');
  for (let i = 1; i < wf5.folds.length; i++) eq(wf5.folds[i].fromTs, wf5.folds[i - 1].toTs, `第 ${i + 1} 折起点应接上一折终点`);
  ok(wf5.folds[0].fromTs < wf5.folds[4].toTs, '首折起点应早于末折终点');
  ok(wf5.folds[0].fromTs === full2[0].ts, '首折起点应为窗口起点');
  ok(wf5.folds[4].toTs === full2[full2.length - 1].ts, '末折终点应为窗口终点');
});
check('walkForward：每折成交都落在本折区间内（每折重置篮子/权益）', () => {
  let n = 0;
  for (const f of wf5.folds) {
    for (const t of f.trades) {
      ok(Date.parse(t.openedAt) >= f.fromTs, `折 ${f.fold} 成交开仓早于折起点：${t.openedAt}`);
      ok(Date.parse(t.closedAt) <= f.toTs + 3600e3, `折 ${f.fold} 成交平仓晚于折终点：${t.closedAt}`);
      n++;
    }
  }
  ok(n > 0, '分折应至少产生成交');
});
check('walkForward：篡改未来数据不改变先前各折结果（无跨折未来泄漏）', () => {
  const cut = wf5.folds[2].toTs;                   // 第 3 折终点（用数值，避免字符串丢 Z 变成本地时区）
  const tampered = full2.map((c) => (c.ts > cut ? { ...c, o: c.o * 1.5, h: c.h * 1.6, l: c.l * 1.4, c: c.c * 1.5 } : c));
  const wfT = bt.walkForward({ data: mkData(tampered), policy: bt.BASE_POLICY, equity0: 10000, feeBps: 8, folds: 5 });
  eq(wfT.folds[0].toTs, wf5.folds[0].toTs, '篡改不应改变折边界');
  for (let i = 0; i < 3; i++) {
    eq(JSON.stringify(wfT.folds[i].trades), JSON.stringify(wf5.folds[i].trades), `第 ${i + 1} 折应不受未来篡改影响`);
  }
  ok(tampered[tampered.length - 1].c !== full2[full2.length - 1].c, '篡改应确实改变了未来数据');
  ok(JSON.stringify(wfT.folds[4].trades) !== JSON.stringify(wf5.folds[4].trades), '末折（在被篡改数据上）结果应与原数据不同，证明篡改生效');
});
check('walkForward：OOS 汇总字段自洽（笔数=各折之和、期望=各折成交合并）', () => {
  const sum = wf5.folds.reduce((a, f) => a + f.trades.length, 0);
  eq(wf5.oos.trades, sum, 'OOS 笔数');
  const pooled = wf5.folds.flatMap((f) => f.trades.map((t) => t.pnlUsd));
  const want = pooled.reduce((a, b) => a + b, 0) / pooled.length;
  near(wf5.oos.expectancyUsd, want, 1e-4, 'OOS 期望');
  ok(wf5.oos.foldsPositive >= 0 && wf5.oos.foldsPositive <= 5, '正收益折数范围');
});

/* 10. 盈利能力组：z 门槛 / 波动止盈 / maker 优先 ───── */
check('zScore：母体标准差口径 + 序列不足/零方差返回 null', () => {
  near(martin.zScore([1, 2, 3, 4, 5], 5), 1.4142135623730951, 1e-9, 'z(1..5)（均值3、母体sd√2、(5−3)/√2）');
  eq(martin.zScore([1, 2, 3], 5), null, '序列不足应 null');
  eq(martin.zScore([2, 2, 2, 2], 4), null, '零方差应 null');
});
check('zScore：只用传入序列（不改入参、与后续数据无关）', () => {
  const a = [1, 3, 2, 8, 5];
  const before = JSON.stringify(a);
  const z1 = martin.zScore(a, 3);
  eq(JSON.stringify(a), before, '不应改动入参');
  const z2 = martin.zScore(a.slice(0, 3), 3);
  eq(z1, z2, 'z 只取决于窗口内数据');
});
check('shouldOpen：entryZMin=0（默认）时 entryZ 被忽略（旧行为）', () => {
  const base = { policy: PO, regime: { regime: 'range', allow: ['long', 'short'], price: 95, ema50: 100 }, funding: 0, atrPct: 1, equity: 10000, openBaskets: [] };
  const a = martin.shouldOpen(base);
  const b = martin.shouldOpen({ ...base, entryZ: -3.2 });
  eq(JSON.stringify(a), JSON.stringify(b), '默认 policy 下 entryZ 应不影响结果');
});
check('shouldOpen：z 门槛 revert 模式（偏离上轨做空 / 下轨做多）', () => {
  const p = { ...PO, entryZMin: 1.5, entryZWin: 20, entryZMode: 'revert' };
  const common = { policy: p, regime: { regime: 'range', allow: ['long', 'short'], price: 95, ema50: 100 }, funding: 0, atrPct: 1, equity: 10000, openBaskets: [] };
  eq(martin.shouldOpen({ ...common, entryZ: 1.2 }).ok, false, '|z|<门槛应拒绝');
  eq(martin.shouldOpen({ ...common, entryZ: 2.0 }).side, 'short', '偏离上轨应做空');
  eq(martin.shouldOpen({ ...common, entryZ: -2.0 }).side, 'long', '偏离下轨应做多');
});
check('shouldOpen：z 门槛 filter 模式（只做与状态方向一致的偏离）', () => {
  const p = { ...PO, entryZMin: 1.5, entryZWin: 20, entryZMode: 'filter' };
  const long = { policy: p, regime: { regime: 'trend_up', allow: ['long'] }, funding: 0, atrPct: 1, equity: 10000, openBaskets: [] };
  eq(martin.shouldOpen({ ...long, entryZ: 2.0 }).ok, false, '状态定向 long 而 z 偏上轨 → 拒绝');
  eq(martin.shouldOpen({ ...long, entryZ: -2.0 }).side, 'long', '状态 long + 下轨偏离 → 开多');
});
check('shouldOpen：entryZMin>0 但未传 entryZ（live 未接线）→ 不拦（不会把策略卡死）', () => {
  const p = { ...PO, entryZMin: 1.5 };
  const so = martin.shouldOpen({ policy: p, regime: { regime: 'range', allow: ['long', 'short'], price: 95, ema50: 100 }, funding: 0, atrPct: 1, equity: 10000, openBaskets: [] });
  eq(so.ok, true, '缺 z 数据不应拒绝开仓');
  eq(so.side, 'long', '退回 EMA50 口径');
});
check('波动止盈：takeProfitPct>0（默认）时固定口径优先（旧行为）', () => {
  const b = mkBasket();
  eq(martin.takeProfitPrice(b), 100.8, '固定止盈价 0.8%');
  eq(martin.takeProfitPrice(b, 3), 100.8, '传 ATR% 也不应改口径');
});
check('波动止盈：takeProfitPct=0 时按 clamp(tpAtrMult×ATR%, 0.4, 2)', () => {
  const p = { ...PO, takeProfitPct: 0, tpAtrMult: 0.5, tpMinPct: 0.4, tpMaxPct: 2 };
  const b = mkBasket({ policy: p });          // 均价 100，夹具 atr=2（=2%）
  eq(martin.effectiveTpPct(b, 6), 2, '0.5×6=3 → 压到上限');
  eq(martin.effectiveTpPct(b, 0.4), 0.4, '0.5×0.4=0.2 → 提到下限');
  near(martin.effectiveTpPct(b, 2), 1, 1e-9, '0.5×2=1 命中区间');
  eq(martin.takeProfitPrice(b, 2), 101, '止盈价 = 均价×1.01');
  eq(martin.takeProfitPrice(b, null), 101, '无当期 ATR% → 退回开仓时 ATR%（2%）');
  const b2 = mkBasket({ policy: p, atr: null });
  eq(martin.effectiveTpPct(b2, null), 0.4, '完全拿不到 ATR → 用下限兜底（不能退成 0）');
});
check('无未来函数：z-score 指标不受后续 K 线篡改影响', () => {
  const zwin = 20;
  const indA = bt.buildIndicators(full, zwin);
  const cutIdx = Math.floor(full.length * 0.6);
  const tampered = full.map((c, i) => (i > cutIdx ? { ...c, o: c.o * 1.3, h: c.h * 1.7, l: c.l * 0.6, c: c.c * 1.7 } : c));
  const indB = bt.buildIndicators(tampered, zwin);
  let n = 0;
  for (let i = bt.LOOKBACK; i <= cutIdx; i++) {
    eq(indB[i].entryZ, indA[i].entryZ, `第 ${i} 根 entryZ 不应受未来篡改影响`);
    n++;
  }
  ok(n > 50, `应比较足够多的点（实际 ${n}）`);
});
check('回测：z 门槛开启后交易变少且结果与基线不同（参数确实生效）', () => {
  const p = { ...bt.BASE_POLICY, entryZMin: 1.0, entryZWin: 20, entryZMode: 'filter' };
  const r = bt.simulate({ data: mkData(full), policy: p, equity0: 10000, feeBps: 8 });
  ok(r.summary.trades > 0, '仍应有交易');
  ok(r.summary.trades < runFull.summary.trades, `应减少交易（${r.summary.trades} < ${runFull.summary.trades}）`);
});
check('回测：波动止盈开启后结果与基线不同（口径生效）', () => {
  const p = { ...bt.BASE_POLICY, takeProfitPct: 0, tpAtrMult: 0.5 };
  const r = bt.simulate({ data: mkData(full), policy: p, equity0: 10000, feeBps: 8 });
  ok(r.summary.trades > 0, '应有交易');
  ok(JSON.stringify(r.trades) !== JSON.stringify(runFull.trades), '应与基线不同');
});
check('maker 优先：off（默认）时 makerFeeBps 不改变任何结果（逐字节）', () => {
  const a = bt.simulate({ data: mkData(full), policy: bt.BASE_POLICY, equity0: 10000, feeBps: 8 });
  const b = bt.simulate({ data: mkData(full), policy: bt.BASE_POLICY, equity0: 10000, feeBps: 8, makerFeeBps: 2 });
  eq(JSON.stringify(a.trades), JSON.stringify(b.trades), '成交应逐字节一致');
  eq(JSON.stringify(a.summary), JSON.stringify(b.summary), '汇总应逐字节一致');
});
check('maker 优先：on 时入场/加仓按 maker 计费、平仓仍 taker，且成交类型被标注', () => {
  const p = { ...bt.BASE_POLICY, makerFirst: 'on' };
  const r = bt.simulate({ data: mkData(full), policy: p, equity0: 10000, feeBps: 8, makerFeeBps: 2 });
  ok(r.summary.trades > 0, '应有成交');
  const st = r.summary.counters;
  ok((st.makerEntryFills || 0) + (st.makerEntryTimeout || 0) > 0, '应有入场挂单结算统计');
  ok(r.trades.some((t) => t.makerSides > 0), '应有 maker 侧成交');
  for (const t of r.trades) {
    ok(t.entryFillType === 'maker' || t.entryFillType === 'taker_timeout', `入场成交类型应被标注：${t.entryFillType}`);
    ok(t.takerSides >= 1, '平仓至少 1 次 taker');
  }
});
check('maker 优先：maker 费率降低 → 单位名义手续费更低', () => {
  const p = { ...bt.BASE_POLICY, makerFirst: 'on' };
  const r2 = bt.simulate({ data: mkData(full), policy: p, equity0: 10000, feeBps: 8, makerFeeBps: 2 });
  const r4 = bt.simulate({ data: mkData(full), policy: p, equity0: 10000, feeBps: 8, makerFeeBps: 4 });
  const rate = (r) => {
    let f = 0, n = 0;
    for (const t of r.trades) {
      f += t.feesUsd;
      n += (t.levelsDetail || []).reduce((a, l) => a + Number(l.marginUsd) * bt.BASE_POLICY.leverage, 0);
    }
    return n > 0 ? f / n : 0;
  };
  const a = rate(r2), b = rate(r4);
  ok(a < b, `maker 费率 2bps 时单位名义手续费应低于 4bps（${a.toExponential(4)} vs ${b.toExponential(4)}）`);
  /* 同构造成交对（同品种/同开仓时间/同层数/同均价）的手续费也应更低 */
  const key = (t) => `${t.instId}|${t.openedAt}|${t.levels}|${t.avgPx}`;
  const m4 = new Map(r4.trades.map((t) => [key(t), t]));
  let same = 0, cheaper = 0;
  for (const t of r2.trades) {
    const o = m4.get(key(t));
    if (!o) continue;
    same++;
    if (t.feesUsd < o.feesUsd) cheaper++;
  }
  ok(same > 0, '应能找到同构造成交');
  ok(cheaper >= Math.ceil(same * 0.5), `同构造成交多数应更便宜（${cheaper}/${same}）`);
});

/* 11. 实盘口径风险仓位（sizingMode=risk）与占用统计 ───── */
const PSC = require(path.join(root, 'modules/policy-schema.js'));
const LIVE_T = { ...bt.BASE_POLICY, sizingMode: 'risk', basketRiskBudgetPct: 4, maxTotalOccupancyPct: 45, riskK: 1.2, deathAtrMult: 6, maxBasketRiskPct: 3, maxBaskets: 3, dailyLossPct: 4 };

check('normPolicy：0 是有效开关值（takeProfitPct / entryZMin 取 0 不被默认值吃掉）', () => {
  const p = martin.normPolicy({ takeProfitPct: 0, entryZMin: 0, tpMinPct: 0.4 });
  eq(p.takeProfitPct, 0, 'takeProfitPct 应保留 0');
  eq(p.entryZMin, 0, 'entryZMin 应保留 0');
  eq(p.tpMinPct, 0.4, '正常值不变');
});
check('实盘口径：sizingMode!=risk 时与旧口径逐字节一致（新能力不改变默认行为）', () => {
  const fixed = bt.simulate({ data: mkData(full), policy: { ...bt.BASE_POLICY, sizingMode: 'fixed', maxTotalOccupancyPct: 45 }, equity0: 10000, feeBps: 8 });
  eq(JSON.stringify(fixed.trades), JSON.stringify(runFull.trades), '成交应逐字节一致');
  eq(JSON.stringify(fixed.summary), JSON.stringify(runFull.summary), '汇总应逐字节一致');
});
check('实盘口径：sizingMode=risk 走 margin.planBasket（拒开计数 + 死亡线亏损 ≈ 预算）', () => {
  const r = bt.simulate({ data: mkData(full), policy: LIVE_T, equity0: 10000, feeBps: 8 });
  ok(r.summary.trades > 0, '应有成交');
  ok(r.summary.counters.sizingRejected !== undefined, '应有 risk 模式的拒开计数');
  ok(r.summary.counters.occupancyRejected !== undefined, '应有占用类拒开计数');
  for (const t of r.trades.slice(0, 30)) {
    ok(t.riskAtDeathUsd > 0, '应记录死亡线亏损');
    const ratio = t.riskAtDeathUsd / t.equityAtOpen;
    ok(ratio > 0.005 && ratio < 0.06, `死亡线亏损应接近预算量级（实际 ${(ratio * 100).toFixed(2)}% 权益）`);
    ok(t.occupancyPctAtOpen !== null && t.occupancyPctAtOpen !== undefined, '应记录开仓时占用');
  }
});
check('实盘口径：风险预算越大 → 单笔风险敞口按比例放大（仓位随预算的方向性）', () => {
  const a = bt.simulate({ data: mkData(full), policy: { ...LIVE_T, basketRiskBudgetPct: 2 }, equity0: 10000, feeBps: 8 });
  const b = bt.simulate({ data: mkData(full), policy: { ...LIVE_T, basketRiskBudgetPct: 6 }, equity0: 10000, feeBps: 8 });
  ok(a.summary.trades > 0 && b.summary.trades > 0, '两个预算都应有成交');
  const meanRisk = (r) => r.trades.reduce((x, t) => x + t.riskAtDeathUsd, 0) / r.trades.length;
  const ra = meanRisk(a), rb = meanRisk(b);
  ok(rb > ra * 1.5, `预算 6% 的单笔死亡线敞口应明显大于 2%（${round4(rb)} vs ${round4(ra)}）`);
  const meanTrades = (r) => r.trades.length;
  ok(Math.abs(meanTrades(b) - meanTrades(a)) / Math.max(1, meanTrades(a)) < 0.5, '预算变化不应大幅改变交易笔数（只改尺寸）');
});
check('占用统计：默认不返回（不改变旧返回体），开启时给出峰值/均值/越限占比', () => {
  const off = bt.simulate({ data: mkData(full), policy: bt.BASE_POLICY, equity0: 10000, feeBps: 8 });
  eq(off.occupancy, undefined, '默认不应返回占用统计');
  const on = bt.simulate({ data: mkData(full), policy: { ...bt.BASE_POLICY, maxTotalOccupancyPct: 45 }, equity0: 10000, feeBps: 8, trackOccupancy: true });
  ok(on.occupancy && on.occupancy.bars > 0, '应统计 K 线数');
  ok(on.occupancy.maxPct >= on.occupancy.meanPct, '峰值应 ≥ 均值');
  eq(on.occupancy.capPct, 45, '上限口径');
});
check('参数表：推荐几何（倍数 2.0 / 4 层 / 间距 0.8）能通过校验，且预设已收录', () => {
  const v = PSC.validate({ multiplier: 2.0, maxLevels: 4, spacingAtrMult: 0.8, takeProfitPct: 0.8 }, {});
  eq(v.errors.length, 0, `不应报错：${v.errors.join('; ')}`);
  ok(PSC.PRESETS['盈利优化(实盘口径)'], '应存在「盈利优化(实盘口径)」预设');
});

/* 12. 止盈执行模型：tpOrderType（market 默认 / limit 挂 maker 限价） ───── */
check('tpOrderType：默认 market；tpOrderIsLimit 只认 limit（非法值/大小写不同一律按 market）', () => {
  eq(martin.DEFAULT_POLICY.tpOrderType, 'market', 'DEFAULT_POLICY 默认必须是 market（= 旧行为）');
  eq(martin.normPolicy({}).tpOrderType, 'market', 'normPolicy 默认 market');
  eq(martin.tpOrderIsLimit({}), false, '默认不是 limit');
  eq(martin.tpOrderIsLimit({ tpOrderType: 'limit' }), true, 'limit 应被识别');
  eq(martin.tpOrderIsLimit({ tpOrderType: 'LIMIT' }), false, '大小写不同 → 按 market');
  eq(martin.tpOrderIsLimit({ tpOrderType: 'maker' }), false, '非法值 → 按 market');
});
check('回测：tpOrderType 默认（含显式 market）不改变任何结果（逐字节）', () => {
  const a = bt.simulate({ data: mkData(full), policy: bt.BASE_POLICY, equity0: 10000, feeBps: 8 });
  const b = bt.simulate({ data: mkData(full), policy: { ...bt.BASE_POLICY, tpOrderType: 'market' }, equity0: 10000, feeBps: 8, makerFeeBps: 2 });
  eq(JSON.stringify(a.trades), JSON.stringify(b.trades), '成交应逐字节一致');
  eq(JSON.stringify(a.summary), JSON.stringify(b.summary), '汇总应逐字节一致');
  eq(a.summary.tpMaker, undefined, 'market 模式不应写入 tpMaker（报告无新键）');
});
check('回测：limit（touch/p=1）成交逐笔一致，仅止盈腿按 maker 计费（省 = 费率差 × 名义）', () => {
  const base = bt.simulate({ data: mkData(full), policy: bt.BASE_POLICY, equity0: 10000, feeBps: 10 });
  const lim = bt.simulate({ data: mkData(full), policy: { ...bt.BASE_POLICY, tpOrderType: 'limit' }, equity0: 10000, feeBps: 10, makerFeeBps: 2 });
  eq(lim.summary.trades, base.summary.trades, '笔数应一致（touch 模型必成交）');
  eq(
    JSON.stringify(lim.trades.map((t) => [t.instId, t.openedAt, t.reason])),
    JSON.stringify(base.trades.map((t) => [t.instId, t.openedAt, t.reason])),
    '决策序列（品种/开仓时点/离场原因）应逐笔一致',
  );
  /* 成交价只允许极小偏差：省下的手续费复利后改变了下单尺寸（位置无重排） */
  let maxRel = 0;
  lim.trades.forEach((t, i) => {
    const b2 = base.trades[i];
    const d = Math.abs(t.closePrice - b2.closePrice) / Math.max(1e-12, Math.abs(b2.closePrice));
    if (d > maxRel) maxRel = d;
  });
  ok(maxRel < 1e-4, `成交价相对偏差应极小（仅因省下的手续费复利改变尺寸；实测 ${maxRel.toExponential(3)}）`);
  ok(lim.summary.totalFeesUsd < base.summary.totalFeesUsd, '总手续费应更低');
  ok(lim.summary.netPnlUsd > base.summary.netPnlUsd, '净盈亏应更高');
  const tp = lim.summary.tpMaker;
  ok(tp && tp.makerFills > 0, '应统计 maker 止盈成交数');
  ok(tp.makerFills <= lim.summary.takeProfitCount, 'maker 成交数不应超过止盈次数（收尾强平不计 maker）');
  eq(tp.missCount, 0, 'touch 模型不应有未成交');
  near(tp.feeDiffBps, 3, 1e-9, '费率差 5−2 = 3bps');
  near(tp.savingBpsOfNotional, 3, 1e-6, '每笔节省占名义应恰为 3bps');
  ok(tp.savingBpsOfEquityPerTrade > 0, '占权益口径应 > 0');
  const sum = lim.trades.reduce((a, t) => a + (t.tpMakerSavingUsd || 0), 0);
  near(sum, tp.savingUsdTotal, 1e-3, '汇总节省应等于逐笔之和（± 汇总取整精度）');
  ok(lim.trades.every((t) => !t.tpMakerExit || t.reason === 'take_profit'), 'maker 成交只能发生在止盈腿上');
});
check('回测：limit 时非止盈离场（止损/爆仓/时间止损）仍按 taker 计费（没有节省）', () => {
  const lim = bt.simulate({ data: mkData(full), policy: { ...bt.BASE_POLICY, tpOrderType: 'limit' }, equity0: 10000, feeBps: 10, makerFeeBps: 2 });
  const nonTp = lim.trades.filter((t) => t.reason !== 'take_profit');
  ok(nonTp.length > 0, '夹具里应有非止盈离场');
  for (const t of nonTp) {
    eq(t.tpMakerExit, false, `非止盈不应是 maker 成交（${t.reason}）`);
    eq(t.tpMakerSavingUsd, 0, `非止盈不应有节省（${t.reason}）`);
  }
});
check('回测：maker 费率 = taker 时 limit 与基线完全等价（费率为 0 差 → 不产生假收益）', () => {
  const a = bt.simulate({ data: mkData(full), policy: { ...bt.BASE_POLICY, tpOrderType: 'limit' }, equity0: 10000, feeBps: 8, makerFeeBps: 4 });
  const b = bt.simulate({ data: mkData(full), policy: bt.BASE_POLICY, equity0: 10000, feeBps: 8 });
  eq(JSON.stringify(a.trades.map((t) => t.pnlUsd)), JSON.stringify(b.trades.map((t) => t.pnlUsd)), '费率差为 0 时逐笔净盈亏应一致');
  eq(a.summary.totalFeesUsd, b.summary.totalFeesUsd, '总手续费应一致');
});
check('成交模型：tpLimitTouchFills 边界（touch 恒成交 / confirm 当根不成交 / prob 的 p=0、p=1、阈值）', () => {
  eq(bt.tpLimitTouchFills('touch', 0.5, 0.99), true, 'touch 恒成交（不看随机数）');
  eq(bt.tpLimitTouchFills('touch', 0, 0.99), true, 'touch 不看 p');
  eq(bt.tpLimitTouchFills('confirm', 1, 0), false, 'confirm 当根不成交（交给下一根确认）');
  eq(bt.tpLimitTouchFills('prob', 1, 0.999999), true, 'p=1 恒成交');
  eq(bt.tpLimitTouchFills('prob', 0, 0), false, 'p=0 恒不成交');
  eq(bt.tpLimitTouchFills('prob', 0.9, 0.899), true, 'u < p → 成交');
  eq(bt.tpLimitTouchFills('prob', 0.9, 0.9), false, 'u ≥ p → 不成交（边界取左闭右开）');
  eq(bt.tpLimitTouchFills('prob', 0.9, 0.900001), false, 'u > p → 不成交');
  eq(bt.tpLimitTouchFills(undefined, 0, 0.5), true, '未传模型 → 按 touch（旧行为）');
  eq(bt.tpLimitTouchFills('nonsense', 0, 0.5), true, '未知模型 → 按 touch');
  eq(bt.tpLimitTouchFills('prob', NaN, 0.5), true, '非法 p → 按必成交（不把策略卡死）');
  eq(bt.tpLimitTouchFills('prob', null, 0.5), true, 'null p → 按必成交');
});
check('成交模型：detUniform 确定性且 ∈[0,1)；confirm 成交只看开盘', () => {
  const a = bt.detUniform('basket-1|1700000000000');
  eq(a, bt.detUniform('basket-1|1700000000000'), '同 key 必须同值（回测可复现）');
  ok(a >= 0 && a < 1, `应落在 [0,1)（实际 ${a}）`);
  const us = ['k1', 'k2', 'k3', 'k4'].map(bt.detUniform);
  ok(new Set(us).size >= 3, '不同 key 应给出不同值（防止常量实现）');
  eq(bt.tpLimitConfirmFilled('long', 100, 100), true, 'long：开盘 = 止盈价 → 成交');
  eq(bt.tpLimitConfirmFilled('long', 100, 100.5), true, 'long：开盘高于止盈价 → 成交');
  eq(bt.tpLimitConfirmFilled('long', 100, 99.9), false, 'long：开盘回到止盈价内 → 未成交');
  eq(bt.tpLimitConfirmFilled('short', 100, 100), true, 'short：开盘 = 止盈价 → 成交');
  eq(bt.tpLimitConfirmFilled('short', 100, 99.5), true, 'short：开盘低于止盈价 → 成交');
  eq(bt.tpLimitConfirmFilled('short', 100, 100.1), false, 'short：开盘回到止盈价内 → 未成交');
  eq(bt.tpLimitConfirmFilled('long', 0, 100), false, '非法挂单价 → 不成交');
  eq(bt.tpLimitConfirmFilled('long', 100, 0), false, '非法开盘价 → 不成交');
});
check('回测：prob p=1 与 touch 逐字节一致（上界一致）；p=0 退化为永远挂不上（无止盈）', () => {
  const pol = { ...bt.BASE_POLICY, tpOrderType: 'limit' };
  const touch = bt.simulate({ data: mkData(full), policy: pol, equity0: 10000, feeBps: 10, makerFeeBps: 2 });
  const p1 = bt.simulate({ data: mkData(full), policy: pol, equity0: 10000, feeBps: 10, makerFeeBps: 2, tpFillMode: 'prob', tpFillRate: 1 });
  eq(JSON.stringify(p1.trades), JSON.stringify(touch.trades), 'p=1 应与 touch 逐字节一致');
  const p08 = bt.simulate({ data: mkData(full), policy: pol, equity0: 10000, feeBps: 10, makerFeeBps: 2, tpFillMode: 'prob', tpFillRate: 0.8 });
  ok(p08.summary.tpMaker.missCount > 0, 'p=0.8 应有未成交计数');
  ok(p08.summary.tpMaker.makerFills < p1.summary.tpMaker.makerFills, 'p=0.8 的 maker 止盈成交应更少');
  ok(p08.summary.tpMaker.savingUsdTotal < p1.summary.tpMaker.savingUsdTotal, '省下的手续费应更少');
  const p0 = bt.simulate({ data: mkData(full), policy: pol, equity0: 10000, feeBps: 10, makerFeeBps: 2, tpFillMode: 'prob', tpFillRate: 0 });
  eq(p0.summary.tpMaker.makerFills, 0, 'p=0 → 一次都挂不上');
  /* 剩下的是「当根开盘就已越过止盈价」的常规巡检市价平仓（3-0 路径，taker），不是挂单成交 */
  ok(p0.summary.takeProfitCount < p1.summary.takeProfitCount, `p=0 时靠挂单成交的止盈应归零（剩余为 3-0 巡检「开盘已越过止盈价」的市价平仓：实测 ${p0.summary.takeProfitCount} vs p=1 的 ${p1.summary.takeProfitCount}）`);
  eq(p0.summary.tpMaker.savingUsdTotal, 0, 'p=0 → 零节省');
});
check('回测：confirm 模型不用当根成交（下一根开盘确认），且 maker 成交价 = 挂单价（不加滑点）', () => {
  const pol = { ...bt.BASE_POLICY, tpOrderType: 'limit' };
  const c = bt.simulate({ data: mkData(full), policy: pol, equity0: 10000, feeBps: 10, makerFeeBps: 2, tpFillMode: 'confirm' });
  const t = bt.simulate({ data: mkData(full), policy: pol, equity0: 10000, feeBps: 10, makerFeeBps: 2 });
  ok(c.summary.tpMaker.makerFills > 0, 'confirm 也应有成交（价格守住的情况）');
  ok(c.summary.tpMaker.makerFills < t.summary.tpMaker.makerFills, 'confirm 比 touch 更严 → 成交更少');
  ok(c.summary.tpMaker.missCount > t.summary.tpMaker.missCount, 'confirm 的未成交计数应更多');
  const s1 = bt.simulate({ data: mkData(full), policy: pol, equity0: 10000, feeBps: 10, makerFeeBps: 2, slipBps: 10 });
  const mk = s1.trades.filter((x) => x.tpMakerExit);
  ok(mk.length > 0, '有滑点时也应有 maker 止盈成交');
  for (const t of mk) {
    const want = t.side === 'short' ? t.avgPx * (1 - 0.008) : t.avgPx * (1 + 0.008);
    near(t.closePrice, want, Math.abs(want) * 1e-6, 'maker 限价腿成交价应等于挂单价（不受滑点影响）');
  }
  const mkt = bt.simulate({ data: mkData(full), policy: bt.BASE_POLICY, equity0: 10000, feeBps: 10, slipBps: 10 });
  const mtp = mkt.trades.filter((x) => x.reason === 'take_profit');
  ok(
    mtp.some((t) => Math.abs(t.closePrice - (t.side === 'short' ? t.avgPx * (1 - 0.008) : t.avgPx * (1 + 0.008))) > Math.abs(t.avgPx) * 1e-5),
    '（对照组）市价止盈在滑点下应低于/高于挂单价',
  );
});
check('参数表：tpOrderType 已追加（enum market|limit，默认 market，非法值被拒）', () => {
  const f = PSC.byKey.tpOrderType;
  ok(f, 'FIELDS 应含 tpOrderType');
  eq(f.type, 'enum', '应为 enum（字符串枚举）');
  eq(JSON.stringify(f.options), JSON.stringify(['market', 'limit']), '选项应为 market|limit');
  eq(PSC.validate({ tpOrderType: 'limit' }, {}).errors.length, 0, 'limit 应可保存（无错）');
  eq(PSC.validate({ tpOrderType: 'market' }, {}).errors.length, 0, 'market 应可保存（无错）');
  eq(PSC.validate({ tpOrderType: 'maker' }, {}).errors.length, 1, '非法值应报错');
  eq(PSC.validate({}, {}).errors.length, 0, '空 patch 不应因新字段报错（纯追加）');
});

/* ── 输出 ─────────────────────────────────────── */
console.log(results.join('\n'));
if (failures.length) {
  console.log(`\n✗ 失败 ${failures.length} 项 / 共 ${passed + failures.length} 项\n`);
  for (const f of failures) console.log(`  · ${f.name}\n    ${f.msg}`);
  process.exit(1);
}
console.log(`\n✓ 全部通过：${passed} 项（张数换算 / 加仓几何 / 止盈止损爆仓时间止损 / 风控闸门 / 回测不变量）\n`);
process.exit(0);
