/*!
 * scripts/verify-selftest.mjs - william-bot-1-core key backtest/optimize logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-BFFAEBCE
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
#!/usr/bin/env node
/**
 * scripts/verify-selftest.mjs —— 验算核心纯函数自检（exit 0 = 全绿）
 * 覆盖：滑点计算与符号 · bps 换算 · 成交聚合/撮配 · 空数据与参数不足的降级 · 层数/盈亏/回撤/成本拖累
 *
 * 用法：node scripts/verify-selftest.mjs
 */
import { createRequire } from 'module';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const V = require(path.join(root, 'modules/verify.js'));

let passed = 0;
const failures = [];
const results = [];
function check(name, fn) {
  try { fn(); passed++; results.push(`  ✓ ${name}`); }
  catch (e) { failures.push({ name, msg: (e && e.message) || String(e) }); results.push(`  ✗ ${name}\n      ${(e && e.message) || e}`); }
}
function ok(cond, msg = '断言失败') { if (!cond) throw new Error(msg); }
function eq(a, b, msg) {
  const A = typeof a === 'number' ? Number(a.toFixed(10)) : a;
  const B = typeof b === 'number' ? Number(b.toFixed(10)) : b;
  if (A !== B) throw new Error(`${msg || '不相等'}：实际 ${a} ≠ 期望 ${b}`);
}
function near(a, b, tol, msg) { if (Math.abs(Number(a) - Number(b)) > tol) throw new Error(`${msg || '差值超限'}：实际 ${a} vs 期望 ${b}（容差 ${tol}）`); }

console.log('\n=== verify-selftest ===\n');

/* ── 1. 滑点计算与符号（不利为正） ─────────────── */
check('unfavBps：买单成交价高于预期 → 正（不利）', () => {
  near(V.unfavBps(100, 100.1, 'buy'), 10, 1e-9, '10 bps');
});
check('unfavBps：买单成交价低于预期 → 负（有利）', () => {
  near(V.unfavBps(100, 99.9, 'buy'), -10, 1e-9, '-10 bps');
});
check('unfavBps：卖单成交价低于预期 → 正（不利）', () => {
  near(V.unfavBps(0.21207, 0.21206, 'sell'), 0.4716, 1e-3, '≈0.4716 bps');
});
check('unfavBps：卖单成交价高于预期 → 负（有利）', () => {
  ok(V.unfavBps(100, 100.5, 'sell') < 0, '应有利');
});
check('unfavBps：买卖反向对称（同价差、符号相反）', () => {
  near(V.unfavBps(100, 100.2, 'buy'), -V.unfavBps(100, 100.2, 'sell'), 1e-9, '对称');
});
check('unfavBps：参数不足 → null（价格 ≤0 / execSide 非法）', () => {
  eq(V.unfavBps(0, 100, 'buy'), null, 'expected=0');
  eq(V.unfavBps(100, null, 'buy'), null, 'fill=null');
  eq(V.unfavBps(100, 100, 'hold'), null, 'execSide 非法');
  eq(V.unfavBps(NaN, 100, 'buy'), null, 'NaN');
});
check('roundTripBps：单边 ×2；参数不足 → null', () => {
  eq(V.roundTripBps(3.1), 6.2, '往返');
  eq(V.roundTripBps(null), null, 'null 透传');
});
check('execSideOf：多进=买/多出=卖；空进=卖/空出=买', () => {
  eq(V.execSideOf('long', 'entry'), 'buy'); eq(V.execSideOf('long', 'exit'), 'sell');
  eq(V.execSideOf('short', 'entry'), 'sell'); eq(V.execSideOf('short', 'exit'), 'buy');
});

/* ── 2. bps 换算（费用） ───────────────────────── */
check('feeStats：OKX 实测口径 —— 0.5 张 ARB @0.21206、ctVal 10、fee -0.00053015 → 5.0 bps/边', () => {
  const fills = [{ instId: 'ARB-USDT-SWAP', fillSz: '0.5', fillPx: '0.21206', fee: '-0.00053015', ts: 1, fillTime: 1 }];
  const r = V.feeStats(fills, { ctValByInst: { 'ARB-USDT-SWAP': 10 } });
  near(r.avgBps, 5, 1e-6, '单边 5 bps');
  eq(r.n, 1, '笔数');
  near(r.feeUsd, 0.00053, 1e-9, '成本取正（feeUsd 落盘保留 6 位）');
});
check('feeStats：往返口径 = 单边 ×2（8bps 双边假设 → 4bps/边）', () => {
  const fills = [{ instId: 'X-USDT-SWAP', fillSz: '1', fillPx: '100', fee: '-0.04' }];
  const r = V.feeStats(fills, { ctValByInst: { 'X-USDT-SWAP': 1 } });
  near(r.avgBps, 4, 1e-9, '4 bps');
  near(V.roundTripBps(r.avgBps), 8, 1e-9, '往返 8 bps');
});
check('feeStats：缺 ctVal → 不进 bps 统计，只进总额并计数 missingCtVal', () => {
  const fills = [{ instId: 'NO-SPEC', fillSz: '1', fillPx: '100', fee: '-0.05' }];
  const r = V.feeStats(fills, { ctValByInst: {} });
  eq(r.avgBps, null, 'bps 应为 null');
  eq(r.missingCtVal, 1, '缺规格计数');
  near(r.feeUsd, 0.05, 1e-12, '总额仍统计');
});
check('fundingStats：bills type=8 汇总（负=支出）+ 窗口', () => {
  const bills = [
    { type: '8', instId: 'ARB-USDT-SWAP', pnl: '-0.000134', ts: 2000 },
    { type: '8', instId: 'ARB-USDT-SWAP', pnl: '-0.000066', ts: 1000 },
    { type: '2', instId: 'ARB-USDT-SWAP', pnl: '0', ts: 1500 },
  ];
  const r = V.fundingStats(bills);
  eq(r.n, 2, '只算 type=8');
  near(r.fundingUsd, -0.0002, 1e-12, '合计');
  eq(r.byInstId[0].entries, 2, '按标的');
  ok(r.window.from < r.window.to, '窗口有序');
});

/* ── 3. 成交聚合与撮配 ─────────────────────────── */
const FILLS = [
  { ordId: 'o1', instId: 'ARB-USDT-SWAP', side: 'sell', posSide: 'short', fillSz: '0.5', fillPx: '0.21206', fee: '-0.00053015', fillTime: '1789976712840', fillIdxPx: '0.21223' },
  { ordId: 'o1', instId: 'ARB-USDT-SWAP', side: 'sell', posSide: 'short', fillSz: '0.5', fillPx: '0.21206', fee: '-0.00053015', fillTime: '1789976712840', fillIdxPx: '0.21223' },
];
const EVENTS = [
  { ts: 1789976712327, type: 'open', data: { instId: 'ARB-USDT-SWAP', side: 'short', price: 0.21207, contracts: 1 } },
];
check('vwapByOrder：同一 ordId 的拆分成交合并为 VWAP（按张数加权）', () => {
  const orders = V.vwapByOrder([
    { ordId: 'a', instId: 'X', side: 'buy', fillSz: '1', fillPx: '100', fee: '-0.01', fillTime: '1000' },
    { ordId: 'a', instId: 'X', side: 'buy', fillSz: '3', fillPx: '110', fee: '-0.03', fillTime: '1000' },
  ]);
  eq(orders.length, 1, '应合并为 1 笔');
  near(orders[0].fillPx, 107.5, 1e-9, 'VWAP=(1*100+3*110)/4');
  near(orders[0].fee, -0.04, 1e-12, 'fee 求和');
  eq(orders[0].fills, 2, '原始成交笔数');
});
check('matchEventsToFills：实盘 ARB 开空事件 ↔ OKX 两笔 0.5 张成交 → 0.47 bps（不利）', () => {
  const m = V.matchEventsToFills({ events: EVENTS, fills: FILLS });
  eq(m.pairs.length, 1, '应撮配 1 笔');
  const p = m.pairs[0];
  eq(p.execSide, 'sell', '成交方向');
  near(p.slipBps, 0.4716, 5e-3, '滑点 bps');
  near(p.fillPx, 0.21206, 1e-9, 'VWAP 成交价');
  near(p.sz ?? p.fillSz, 1, 1e-9, '张数合计 1');
  eq(p.fills, 2, '合并笔数');
  eq(m.unmatchedFills, 0, '无未撮配成交');
  eq(m.unmatchedEvents.length, 0, '无未撮配事件');
});
check('matchEventsToFills：时窗外的成交不撮配（不硬凑）', () => {
  const far = FILLS.map((f) => ({ ...f, fillTime: String(1789976712840 + 600000) }));   // +10 分钟
  const m = V.matchEventsToFills({ events: EVENTS, fills: far });
  eq(m.pairs.length, 0, '窗口外不撮配');
  eq(m.unmatchedEvents.length, 1, '事件标为未撮配');
  eq(m.unmatchedFills, 1, '成交标为未用');
});
check('matchEventsToFills：成交方向不符不撮配（买单不会被塞给卖事件）', () => {
  const wrong = FILLS.map((f) => ({ ...f, side: 'buy' }));
  const m = V.matchEventsToFills({ events: EVENTS, fills: wrong });
  eq(m.pairs.length, 0, '方向不符');
});
check('matchEventsToFills：一笔成交只被用一次（不重复计数）', () => {
  const evs = [{ ts: 1000, type: 'open', data: { instId: 'X', side: 'long', price: 100 } }, { ts: 1200, type: 'open', data: { instId: 'X', side: 'long', price: 100 } }];
  const fl = [{ ordId: 'z', instId: 'X', side: 'buy', fillSz: '1', fillPx: '100', fee: '-0.01', fillTime: '1000' }];
  const m = V.matchEventsToFills({ events: evs, fills: fl });
  eq(m.pairs.length, 1, '只用一次');
  eq(m.unmatchedEvents.length, 1, '另一个事件未撮配');
});
check('matchEventsToFills：平仓事件用 fillPx 作期望价（并有 vsIdx 诊断口径）', () => {
  const evs = [{ ts: 2000, type: 'take_profit', data: { instId: 'X', side: 'short', fillPx: 99.5, triggerPx: 99.6 } }];
  const fl = [{ ordId: 'y', instId: 'X', side: 'buy', fillSz: '1', fillPx: 99.6, fee: '-0.01', fillTime: '2000' }];
  const m = V.matchEventsToFills({ events: evs, fills: fl });
  eq(m.pairs.length, 1, '撮配');
  eq(m.pairs[0].kind, 'exit', '类型 exit');
  eq(m.pairs[0].execSide, 'buy', '空头平仓=买');
  near(m.pairs[0].slipBps, V.unfavBps(99.5, 99.6, 'buy'), 1e-3, '滑点按 fillPx 期望价（报告值保留 4 位）');
});

/* ── 4. 滑点汇总 ───────────────────────────────── */
check('slipStats：均值/中位/p90/名义加权/往返；空 → 全 null 不抛', () => {
  const pairs = [
    { kind: 'open', slipBps: 1, notionalUsd: 100 },
    { kind: 'exit', slipBps: 3, notionalUsd: 200 },
    { kind: 'exit', slipBps: -2, notionalUsd: 100 },
  ];
  const s = V.slipStats(pairs);
  eq(s.n, 3, 'n');
  near(s.avgBps, 2 / 3, 1e-3, '均值');
  near(s.medianBps, 1, 1e-9, '中位');
  near(s.notionalWeightedBps, (1 * 100 + 3 * 200 + -2 * 100) / 400, 1e-9, '名义加权');
  near(s.roundTripBps, (2 / 3) * 2, 1e-3, '往返=均值×2');
  eq(s.nEntry, 1); eq(s.nExit, 2);
  const empty = V.slipStats([]);
  eq(empty.n, 0, '空 n=0');
  eq(empty.avgBps, null, '空均值 null');
  eq(empty.roundTripBps, null, '空往返 null');
});
check('slipStats：缺 notionalUsd 时名义加权为 null（不乱用 0 权重）', () => {
  const s = V.slipStats([{ kind: 'open', slipBps: 2, notionalUsd: null }]);
  eq(s.notionalWeightedBps, null, '加权 null');
  eq(s.avgBps, 2, '简单均值仍可用');
});
check('slipFromReconcile：从 reconcile 事件取「计划均价 vs 真实均价」', () => {
  const r = V.slipFromReconcile([{ ts: 1, type: 'reconcile', data: { instId: 'X', side: 'short', before: { avgPx: 0.21207 }, actual: { avgPx: 0.21206 } } }]);
  eq(r.rows.length, 1, '取到 1 条');
  near(r.rows[0].slipBps, V.unfavBps(0.21207, 0.21206, 'sell'), 1e-3, '口径一致（报告值保留 4 位）');
  eq(V.slipFromReconcile([]).rows.length, 0, '空不抛');
  eq(V.slipFromReconcile(null).stats.n, 0, 'null 不抛');
});

/* ── 5. 层数 / 盈亏 / 回撤 ─────────────────────── */
const CLOSED = [
  { realizedPnl: 5, closeReason: 'take_profit', levels: [1, 2], openedAt: 0, closedAt: 3600e3, policy: { maxLevels: 2 }, equityAtOpen: 100 },
  { realizedPnl: -3, closeReason: 'stop_loss', levels: [1], openedAt: 0, closedAt: 1800e3, policy: { maxLevels: 2 }, equityAtOpen: 100 },
  { realizedPnl: 1, closeReason: 'take_profit', levels: [1, 2], openedAt: 0, closedAt: 7200e3, policy: { maxLevels: 2 }, equityAtOpen: 100 },
];
check('levelStats：分布/平均层数/满层率/持仓时长', () => {
  const s = V.levelStats(CLOSED, { maxLevels: 2 });
  eq(s.n, 3); eq(s.distribution['2'], 2); eq(s.distribution['1'], 1);
  near(s.avgLevels, 5 / 3, 1e-3, '平均层数');
  near(s.fullLevelRate, (2 / 3) * 100, 1e-2, '满层率 %');
  near(s.avgHours, (1 + 0.5 + 2) / 3, 1e-3, '平均时长');
});
check('pnlStats：胜率/期望/PF/离场原因占比', () => {
  const p = V.pnlStats(CLOSED, { equity0: 100 });
  eq(p.trades, 3); eq(p.wins, 2); eq(p.losses, 1);
  near(p.winRate, (2 / 3) * 100, 1e-2, '胜率');
  near(p.expectancyUsd, 1, 1e-9, '期望=(5-3+1)/3');
  near(p.expectancyPermille, 10, 1e-9, '‰ 权益');
  near(p.profitFactor, 6 / 3, 1e-9, 'PF');
  const tp = p.reasons.find((r) => r.reason === 'take_profit');
  eq(tp.n, 2, '止盈笔数');
  near(tp.sharePct, (2 / 3) * 100, 1e-2, '占比');
});
check('pnlStats：空数据 → 全 null / 0，不抛（降级）', () => {
  const p = V.pnlStats([], { equity0: 100 });
  eq(p.trades, 0); eq(p.winRate, null); eq(p.expectancyUsd, null); eq(p.profitFactor, null);
});
check('maxDrawdownPct：峰值回撤（含 0 回撤与单点降级）', () => {
  near(V.maxDrawdownPct([100, 120, 90, 130]).pct, -25, 1e-9, '从 120 跌到 90 = -25%');
  near(V.maxDrawdownPct([100, 110, 120]).pct, 0, 1e-9, '单调上行 = 0');
  eq(V.maxDrawdownPct([100]).pct, null, '单点 → null');
  eq(V.maxDrawdownPct([]).pct, null, '空 → null');
  eq(V.maxDrawdownPct(null).pct, null, 'null → null');
});
check('equityDrawdown：无曲线时用平仓盈亏重建（并标注口径）', () => {
  const st = { equity: 100, closed: [{ realizedPnl: 10, closedAt: 1 }, { realizedPnl: -30, closedAt: 2 }], curve: [] };
  const d = V.equityDrawdown(st);
  ok(String(d.source).includes('重建'), '标注重建口径');
  // 序列 [100,110,80]：从峰值 110 跌到 80 = -27.27%（峰值口径，不是初始权益口径）
  near(d.pct, -27.2727, 1e-3, '回撤 -27.27%');
});

/* ── 6. 成本拖累 / 参数漂移 / 样本门槛 ─────────── */
check('costDrag：实盘往返 vs 回测往返 → 缺口与拖累比例', () => {
  const d = V.costDrag({ liveSlipSideBps: 1, btSlipSideBps: 0, liveFeeSideBps: 5, btFeeSideBps: 4, btExpectancyBps: 20 });
  near(d.liveRoundTripBps, 12, 1e-9, '实盘往返 2*(1+5)');
  near(d.btRoundTripBps, 8, 1e-9, '回测往返 2*(0+4)');
  near(d.gapBps, 4, 1e-9, '缺口 4 bps');
  near(d.dragPct, 20, 1e-9, '被吃掉 20%');
});
check('costDrag：回测期望非正/缺数 → dragPct=null（不编数字）', () => {
  eq(V.costDrag({ liveSlipSideBps: 1, btSlipSideBps: 0, liveFeeSideBps: 5, btFeeSideBps: 4, btExpectancyBps: -3 }).dragPct, null);
  eq(V.costDrag({ liveSlipSideBps: null, btSlipSideBps: 0, liveFeeSideBps: 5, btFeeSideBps: 4, btExpectancyBps: 20 }).gapBps, null);
});
check('policyDrift：列出实盘与回测基线不一致项（含回测有、实盘没设的项）', () => {
  const d = V.policyDrift({ hardStopPct: 3, maxBaskets: 1, dailyLossPct: 4 }, { hardStopPct: 4, maxBaskets: 3, dailyLossPct: 6, leverage: 3 });
  eq(d.diffs.length, 4, '四项差异（含实盘缺 leverage）');
  ok(d.diffs.some((x) => x.key === 'hardStopPct' && x.live === 3 && x.backtest === 4), '停损差异');
  ok(d.diffs.some((x) => x.key === 'leverage' && x.live === '(未设置)'), '实盘未设项应显式标注');
});
check('sampleGate：<20 笔 = 样本不足，结论不可用', () => {
  const g = V.sampleGate(1);
  eq(g.sufficient, false);
  ok(g.note.includes('样本不足'), '提示');
  eq(V.sampleGate(20).sufficient, true, '整 20 笔达标');
  eq(V.sampleGate(0).sufficient, false, '0 笔');
});

/* ── 7. 端到端组装：空数据 / 无凭据的降级 ─────── */
check('buildReport：全空 state（无 OKX、无回测）→ 不抛，四段全部标注数据不足', () => {
  const r = V.buildReport({ state: {}, okx: null, backtest: null, minTrades: 20 });
  ok(r && r.ok, '返回报告');
  eq(r.headline.closedBaskets, 0, '无平仓');
  eq(r.headline.usable, false, '不可用');
  ok(r.headline.sample.note.includes('样本不足'), '样本声明');
  for (const k of ['slippage', 'costs', 'levels', 'pnl']) {
    eq(r.sections.find((s) => s.key === k).ok, false, `${k} 应标数据不足`);
    ok(r.sections.find((s) => s.key === k).reason, `${k} 应有原因说明`);
  }
  eq(r.slippage.stats.n, 0, '滑点 n=0');
  eq(r.slippage.stats.avgBps, null, '滑点均值 null');
  eq(r.comparison.backtest, null, '无回测');
});
check('buildReport：null state 也不抛（防上游给空）', () => {
  const r = V.buildReport({ state: null, okx: null, backtest: null });
  eq(r.headline.openBaskets, 0);
  ok(Array.isArray(r.findings));
});
check('buildReport：有 OKX 证据但 state 无事件 → 滑点「有成交无事件」降级、费用段可用', () => {
  const okx = { source: 'snapshot:test', capturedAt: 't', fills: [{ ordId: 'o', instId: 'X', side: 'buy', fillSz: '1', fillPx: '100', fee: '-0.05', fillTime: '1', __ctVal: 1 }], bills: [{ type: '8', instId: 'X', pnl: '-0.001', ts: 1 }], positions: [], balance: null, errors: {} };
  const r = V.buildReport({ state: { equity: 100, baskets: [{ instId: 'X', openedAt: 0, side: 'long', levels: [{ marginUsd: 1 }], marginUsd: 1, firstMarginUsd: 1, equityAtOpen: 100 }], closed: [], events: [] }, okx, backtest: null });
  eq(r.sections.find((s) => s.key === 'slippage').ok, false, '滑点仍不足');
  ok(r.sections.find((s) => s.key === 'slippage').reason.includes('撮配'), '原因指向撮配');
  eq(r.sections.find((s) => s.key === 'costs').ok, true, '成本段可用');
  near(r.costs.feeSideBps, 5, 1e-6, '单边 5bps');
  near(r.costs.fundingUsd, -0.001, 1e-12, '资金费');
});
check('buildReport：小资金 + 整张下限 → 产出 size_floor 发现（口径不一致）', () => {
  const state = {
    equity: 113.77, closed: [], events: [], policy: { maxLevels: 6, firstMarginPct: 1 },
    baskets: [{ id: 'b', instId: 'ARB-USDT-SWAP', side: 'short', equityAtOpen: 113.77, firstMarginUsd: 1.1377, marginUsd: 0.7067, levels: [{ idx: 0, price: 0.21206, contracts: 1, marginUsd: 0.7067 }] }],
  };
  const r = V.buildReport({ state, okx: null, backtest: null });
  ok(r.findings.some((f) => f.key === 'size_floor'), '应报 size_floor');
});
check('buildReport：参数漂移与手续费口径缺口都会进 findings', () => {
  const state = { equity: 100, policy: { hardStopPct: 3, maxBaskets: 1 }, baskets: [{ instId: 'X', openedAt: 0, side: 'long', levels: [{ marginUsd: 1 }], marginUsd: 1, firstMarginUsd: 1, equityAtOpen: 100 }], closed: [], events: [] };
  const backtest = { days: 200, feeBps: 8, slipBps: 0, runs: [{ policy: { hardStopPct: 4, maxBaskets: 3 } }], summary: { expectancyUsd: 3.5, expectancyPct: 0.025, winRate: 93.9 }, trades: [{ levelsDetail: [{ marginUsd: 100 }] }] };
  const okx = { source: 'snapshot:test', capturedAt: 't', fills: [{ ordId: 'o', instId: 'X', side: 'buy', fillSz: '1', fillPx: '100', fee: '-0.05', fillTime: '1', __ctVal: 1 }], bills: [], positions: [], errors: {} };
  const r = V.buildReport({ state, okx, backtest });
  ok(r.findings.some((f) => f.key === 'fee_mismatch'), '手续费缺口');
  ok(r.findings.some((f) => f.key === 'policy_drift'), '参数漂移');
  eq(r.comparison.rows.find((x) => x.metric.includes('单边手续费')).backtest, 4, '回测单边=8/2');
  eq(r.comparison.rows.find((x) => x.metric.includes('单边滑点')).backtest, 0, '回测滑点假设 0');
});

/* ── 8. 读取器：缺失文件 / 空目录降级（不抛） ─── */
check('readState：文件不存在 → ok=false 且带 error（不抛）', () => {
  const r = V.readState(path.join(os.tmpdir(), 'definitely-not-here-verify.json'));
  eq(r.ok, false);
  ok(r.error, '有错误信息');
});
check('readBacktest：目录里没有回测文件 → ok=false（不抛）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-selftest-'));
  const r = V.readBacktest(dir);
  eq(r.ok, false);
  ok(String(r.error).includes('未找到'), '提示未找到');
  fs.rmSync(dir, { recursive: true, force: true });
});
check('latest：无报告 → ok=false；有报告 → 取最新一份', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-selftest-'));
  eq(V.latest(dir).ok, false, '空目录');
  fs.writeFileSync(path.join(dir, 'verify-20260920.json'), JSON.stringify({ v: 1 }));
  fs.writeFileSync(path.join(dir, 'verify-20260921.json'), JSON.stringify({ v: 2 }));
  const r = V.latest(dir);
  eq(r.ok, true); eq(r.file, 'verify-20260921.json'); eq(r.report.v, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});
check('loadOkxEvidence：既无快照又未开 live → ok=false 且说明（降级不当真）', async () => {
  const r = await V.loadOkxEvidence({});
  eq(r.ok, false);
  ok(r.error.includes('未提供 OKX 证据'), '说明');
  eq(r.fills.length, 0);
});
check('ctValFromState：从篮子记录收集 ctVal；annotateCtVal 把规格贴到成交上', () => {
  const map = V.ctValFromState({ baskets: [{ instId: 'ARB-USDT-SWAP', ctVal: 10 }], closed: [{ instId: 'X', ctVal: 1 }] });
  eq(map['ARB-USDT-SWAP'], 10); eq(map.X, 1);
  const fills = V.annotateCtVal([{ instId: 'ARB-USDT-SWAP', fillPx: '0.21', fillSz: '1', fee: '-0.0001' }], map);
  eq(fills[0].__ctVal, 10, '贴上 ctVal');
});
check('expectedFromEvent：无价事件/非法事件 → null（不猜价）', () => {
  eq(V.expectedFromEvent({ type: 'open', data: { instId: 'X', side: 'long' } }), null, '无价');
  eq(V.expectedFromEvent({ type: 'screen', data: {} }), null, '非交易事件');
  eq(V.expectedFromEvent(null), null, 'null');
});
check('botInstIds：从 baskets/closed/events 收集本机器人碰过的标的', () => {
  const s = V.botInstIds({ baskets: [{ instId: 'A' }], closed: [{ instId: 'B' }], events: [{ data: { instId: 'C' } }] });
  eq(s.size, 3, '三个标的');
  ok(s.has('A') && s.has('B') && s.has('C'), '集合内容');
  eq(V.botInstIds({}).size, 0, '空 state');
  eq(V.botInstIds(null).size, 0, 'null state 不抛');
});
check('filterByScope：按标的 + 时间窗过滤（账户共用时的正确口径）', () => {
  const rows = [
    { instId: 'ARB-USDT-SWAP', fillTime: '2000', fee: '-0.001' },
    { instId: 'XRP-USDT-SWAP', fillTime: '2000', fee: '-0.03' },
    { instId: 'ARB-USDT-SWAP', fillTime: '500', fee: '-0.001' },
  ];
  const ids = new Set(['ARB-USDT-SWAP']);
  eq(V.filterByScope(rows, { instIds: ids }).length, 2, '只留本机器人标的');
  eq(V.filterByScope(rows, { instIds: ids, fromTs: 1000 }).length, 1, '再压时间窗');
  eq(V.filterByScope(rows, {}).length, 3, '无范围（instIds 缺省）= 不过滤');
  eq(V.filterByScope(rows, { instIds: new Set() }).length, 0, '空集合 = 本机器人没碰过任何标的 → 全部不属于它');
  eq(V.filterByScope([], { instIds: ids }).length, 0, '空数组');
  eq(V.filterByScope(null, { instIds: ids }).length, 0, 'null 不抛');
});
check('buildReport：账户共用 → shared_account 发现；权益冻结 → equity_frozen 发现', () => {
  const state = {
    equity: 113.76667721778891, closed: [], events: [],
    baskets: [{ instId: 'ARB-USDT-SWAP', openedAt: 1789976712327, marginUsd: 0.7069, firstMarginUsd: 1.1377, equityAtOpen: 113.77, levels: [{ marginUsd: 0.7069 }] }],
    curve: [{ equity: 113.76667721778891 }, { equity: 113.76667721778891 }, { equity: 113.76667721778891 }],
  };
  const okx = {
    source: 'snapshot:test', capturedAt: 't', errors: {}, balance: [{ ccy: 'USDT', totalEq: '113.7499' }], positions: [], bills: [],
    fills: [
      { ordId: 'a', instId: 'ARB-USDT-SWAP', side: 'sell', fillSz: '1', fillPx: '0.21206', fee: '-0.00106', fillTime: '1789976712840', __ctVal: 10 },
      { ordId: 'b', instId: 'XRP-USDT-SWAP', side: 'buy', fillSz: '1', fillPx: '1.42', fee: '-0.0384', fillTime: '1789954099381', __ctVal: 100 },
      { ordId: 'c', instId: 'XRP-USDT-SWAP', side: 'sell', fillSz: '1', fillPx: '1.42', fee: '-0.0384', fillTime: '1789954099381', __ctVal: 100 },
    ],
  };
  const r = V.buildReport({ state, okx, backtest: null });
  ok(r.findings.some((f) => f.key === 'equity_frozen'), '应变到权益冻结');
  ok(r.findings.some((f) => f.key === 'shared_account'), '应变到账户共用');
  eq(r.costs.feeFills, 1, '费用只算本机器人范围（ARB 1 笔）');
  near(r.costs.feeUsd, 0.00106, 1e-9, '本机器人手续费');
  near(r.costs.accountWide.feeUsd, 0.00106 + 0.0384 * 2, 1e-9, '全账户手续费更大');
  eq(r.costs.accountWide.feeFills, 3, '全账户 3 笔');
});

/* 异步用例：与同步结果一起汇总（先 await 完再打印，避免异步失败被吞） */
const ASYNC_CHECKS = [
  ['loadOkxEvidence：快照文件不存在 → ok=false 带错误（不抛）', async () => {
    const r = await V.loadOkxEvidence({ snapshotPath: '/tmp/definitely-not-here-okx.json' });
    eq(r.ok, false);
    ok(r.error, '有错误');
  }],
];

(async () => {
  for (const [name, fn] of ASYNC_CHECKS) {
    try { await fn(); passed++; results.push(`  ✓ ${name}`); }
    catch (e) { failures.push({ name, msg: (e && e.message) || String(e) }); results.push(`  ✗ ${name}\n      ${(e && e.message) || e}`); }
  }
  console.log(results.join('\n'));
  if (failures.length) {
    console.log(`\n✗ 失败 ${failures.length} 项 / 共 ${passed + failures.length} 项\n`);
    for (const f of failures) console.log(`  · ${f.name}\n    ${f.msg}`);
    process.exit(1);
  }
  console.log(`\n✓ 全部通过：${passed} 项（滑点符号与 bps 换算 / 成交聚合撮配 / 费用资金费 / 层数盈亏回撤 / 成本拖累与参数漂移 / 空数据与缺凭据降级）\n`);
  process.exit(0);
})();
