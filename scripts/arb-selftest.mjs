/*!
 * scripts/arb-selftest.mjs - william-bot-1-core key backtest/optimize logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-79E32D1C
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
#!/usr/bin/env node
/**
 * arb 模块自检（纯函数，不发任何网络请求；退出码 0 = 全过）
 * 覆盖：费率换算 / 三步净收益 / 空盘口与缺数据降级 / 采样统计 / 回本期数 / 基差年化 / 路径闭合
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const arb = require(path.join(__dirname, '..', 'modules', 'arb.js'));

let pass = 0; const fails = [];
function ok(name, cond, extra = '') { if (cond) pass++; else fails.push(`${name} ${extra}`); }
function near(name, got, want, tol = 1e-6) {
  const d = Math.abs(Number(got) - Number(want));
  ok(name, d <= tol, `(got ${got} want ${want} diff ${d})`);
}
function book(bids, asks, ts = 1) { return { data: [{ ts: String(ts), bids: bids.map(([p, s]) => [String(p), String(s), '0', '1']), asks: asks.map(([p, s]) => [String(p), String(s), '0', '1']) }] }; }
const bkOf = (map) => (p) => map[p];

/* ── 1. 费率换算 ── */
const F = arb.fees('Lv1');
ok('fee: spotTaker = 0.0010 (0.10%)', F.spotTaker === 0.001);
ok('fee: swapTaker = 0.0005 (0.05%)', F.swapTaker === 0.0005);
near('fee: toBps(0.001) = 10bps', arb.toBps(0.001), 10, 1e-9);
near('fee: toPct(0.001) = 0.1%', arb.toPct(0.001), 0.1, 1e-9);
near('fee: 覆盖项生效', arb.fees('Lv1', { spotTaker: 0.0005 }).spotTaker, 0.0005, 1e-12);
ok('fee: 未知档回落到 Lv1', arb.fees('VIP9').spotTaker === 0.001);

/* ── 2. 盘口解析 / 空盘口降级 ── */
const pb = arb.parseBook(book([[59990, 2]], [[60000, 3]]));
ok('parseBook: ok', pb.ok === true);
near('parseBook: mid', pb.mid, 59995, 1e-9);
near('parseBook: spreadBps', pb.spreadBps, (10 / 59995) * 10000, 1e-4);
const pbEmpty = arb.parseBook({ data: [{}] });
ok('parseBook: 空盘口 → ok:false', pbEmpty.ok === false);
ok('parseBook: 空盘口 → 有 reason', typeof pbEmpty.reason === 'string' && pbEmpty.reason.includes('盘口为空'));
const pbNull = arb.parseBook(null);
ok('parseBook: 数据缺失 → ok:false 且不抛错', pbNull.ok === false && pbNull.mid === null);
ok('parseBook: 非法价位被过滤', arb.parseBook(book([[0, 5], [59990, 2]], [['x', 1], [60000, 3]])).bid1.px === 59990);

/* ── 3. 吃盘口（买/卖 + 深度不足）── */
const wb = arb.walkBuy([{ px: 100, sz: 1 }, { px: 101, sz: 1 }], 150);
ok('walkBuy: 深度足够', wb.ok === true);
near('walkBuy: 得到数量', wb.got, 1 + 50 / 101, 1e-9);
near('walkBuy: vwap', wb.vwap, 150 / (1 + 50 / 101), 1e-9);
ok('walkBuy: 用满 2 档', wb.used === 2);
const wbFail = arb.walkBuy([{ px: 100, sz: 1 }], 500);
ok('walkBuy: 深度不足 → ok:false + unfilled', wbFail.ok === false && wbFail.unfilled === 400);
const ws = arb.walkSell([{ px: 100, sz: 1 }, { px: 99, sz: 2 }], 2);
ok('walkSell: 深度足够', ws.ok === true);
near('walkSell: 得到 quote', ws.got, 100 + 99, 1e-9);
ok('walkSell: 深度不足 → ok:false', arb.walkSell([{ px: 100, sz: 0.1 }], 1).ok === false);
near('roundDownTo', arb.roundDownTo(0.00166667, 0.00000001), 0.00166667, 1e-12);
near('roundUpTo', arb.roundUpTo(1.000000001, 0.01), 1.01, 1e-12);

/* ── 4. 路径闭合 ── */
const legs1 = arb.cycleFrom(['BTC-USDT', 'ETH-BTC', 'ETH-USDT'], 'USDT');
ok('cycleFrom: 3 步闭合', Array.isArray(legs1) && legs1.length === 3);
ok('cycleFrom: 方向判定 buy/buy/sell', legs1.map((l) => l.dir).join(',') === 'buy,buy,sell');
ok('cycleFrom: 不闭合 → null', arb.cycleFrom(['BTC-USDT', 'ETH-USDT'], 'USDT') === null);
ok('cycleFrom: 资产不匹配 → null', arb.cycleFrom(['BTC-USDT', 'XRP-ETH', 'ETH-USDT'], 'USDT') === null);

/* ── 5. 三角：三步净收益（扣 3 次吃单费）── */
/* 一致价格：BTC 60000 / ETH 3000（ETH-BTC = 1/20）
 * 路径 USDT→BTC→ETH→USDT，100 USDT 起步，3 步各扣 0.10% */
function triBooks(ethBid) {
  return bkOf({
    'BTC-USDT': arb.parseBook(book([[59999, 1]], [[60000, 1]])),
    'ETH-BTC': arb.parseBook(book([[0.049999, 1]], [[0.05, 1]])),
    'ETH-USDT': arb.parseBook(book([[ethBid, 1]], [[ethBid + 1, 1]])),
  });
}
const tri = arb.runTriangle({ bookOf: triBooks(3006), pairs: ['BTC-USDT', 'ETH-BTC', 'ETH-USDT'], startAmount: 100, feeTaker: F.spotTaker });
ok('triangle: ok', tri.ok === true && tri.steps.length === 3);
// 独立闭式核算（不调用模块内部逻辑）：100/(60000) *0.999 /0.05 *0.999 *3006 *0.999
const closed = 100 * (1 / 60000) * 0.999 / 0.05 * 0.999 * 3006 * 0.999;
near('triangle: 净额闭式一致', tri.endAmount, closed, 1e-9);
near('triangle: netPct', tri.netPct, (closed / 100 - 1) * 100, 1e-6);
near('triangle: 毛收益 ≈ +0.20%', tri.grossPct, 0.2, 0.002);
near('triangle: 费用 ≈ 3×0.10%', tri.feePct, 0.3, 0.005);
ok('triangle: 毛为正但净为负 → 不可执行', tri.grossPct > 0 && tri.netPct < 0 && tri.executable === false);
ok('triangle: 每步都扣了费', tri.steps.every((s) => s.feePaid > 0));
ok('triangle: netBps 与 netPct 一致', Math.abs(tri.netBps * 0.01 - tri.netPct) < 1e-6);
const triWin = arb.runTriangle({ bookOf: triBooks(3010), pairs: ['BTC-USDT', 'ETH-BTC', 'ETH-USDT'], startAmount: 100, feeTaker: F.spotTaker });
ok('triangle: 毛 33bps → 扣 30bps 后净为正 → 可执行', triWin.grossPct > 0.33 && triWin.netPct > 0 && triWin.executable === true);
near('triangle: 净 ≈ 毛 − 费', triWin.netPct, triWin.grossPct - triWin.feePct, 1e-9);
const triNoFee = arb.runTriangle({ bookOf: triBooks(3006), pairs: ['BTC-USDT', 'ETH-BTC', 'ETH-USDT'], startAmount: 100, feeTaker: 0 });
near('triangle: 零费率时净 = 毛', triNoFee.netPct, triNoFee.grossPct, 1e-9);

/* ── 6. 三角：空盘口 / 缺数据降级 ── */
const triDeg = arb.runTriangle({ bookOf: () => undefined, pairs: ['BTC-USDT', 'ETH-BTC', 'ETH-USDT'], startAmount: 100, feeTaker: F.spotTaker });
ok('triangle降级: 盘口缺失 → ok:false + degraded', triDeg.ok === false && triDeg.degraded === true && triDeg.netPct === null);
ok('triangle降级: 有原因说明', String(triDeg.reason).includes('盘口缺失'));
const triDegEmpty = arb.runTriangle({ bookOf: bkOf({ 'BTC-USDT': arb.parseBook({ data: [{}] }) }), pairs: ['BTC-USDT', 'ETH-BTC', 'ETH-USDT'], startAmount: 100, feeTaker: F.spotTaker });
ok('triangle降级: 空盘口 → ok:false（不返回 NaN）', triDegEmpty.ok === false && triDegEmpty.netPct === null && Number.isNaN(triDegEmpty.netPct) === false);
const triDegDepth = arb.runTriangle({ bookOf: triBooks(3006), pairs: ['BTC-USDT', 'ETH-BTC', 'ETH-USDT'], startAmount: 1e9, feeTaker: F.spotTaker });
ok('triangle降级: 深度不足 → ok:false', triDegDepth.ok === false && String(triDegDepth.reason).includes('深度不足'));
const triDegAmt = arb.runTriangle({ bookOf: triBooks(3006), pairs: ['BTC-USDT', 'ETH-BTC', 'ETH-USDT'], startAmount: 0, feeTaker: F.spotTaker });
ok('triangle降级: 起点非法 → ok:false', triDegAmt.ok === false && String(triDegAmt.reason).includes('startAmount'));
const triDegPath = arb.runTriangle({ bookOf: triBooks(3006), pairs: ['BTC-USDT', 'ETH-USDT'], startAmount: 100, feeTaker: F.spotTaker });
ok('triangle降级: 路径不闭合 → ok:false', triDegPath.ok === false && String(triDegPath.reason).includes('不闭合'));

/* ── 7. 采样统计 ── */
const st = arb.sampleStats([-2, -1, 0, 1, 2, 3], { thresholdBps: 0 });
ok('sampleStats: rounds/valid', st.rounds === 6 && st.valid === 6 && st.invalid === 0);
near('sampleStats: median(最近秩)', st.medianBps, 0);
near('sampleStats: p95', st.p95Bps, 3);
near('sampleStats: min/max', st.minBps, -2); near('sampleStats: max', st.maxBps, 3);
near('sampleStats: mean', st.meanBps, 0.5);
ok('sampleStats: positive 计数（>0）', st.positive === 3);
ok('sampleStats: aboveThreshold 计数（>阈值）', st.aboveThreshold === 3);
near('sampleStats: bestRound 指向最大值', st.bestRound, 5);
const st2 = arb.sampleStats([null, 1, undefined, 2], { thresholdBps: 0 });
ok('sampleStats: null/undefined 计为 invalid 且不进分布', st2.rounds === 4 && st2.valid === 2 && st2.invalid === 2);
near('sampleStats: 有效样本 median', st2.medianBps, 1);
const st3 = arb.sampleStats([], { thresholdBps: 0 });
ok('sampleStats: 空序列不炸', st3.rounds === 0 && st3.medianBps === null && st3.positive === 0);
const st4 = arb.sampleStats([0.5, 0.5, 0.5], { thresholdBps: 0 });
ok('sampleStats: 全为 0.5bps 且阈值 0 → aboveThreshold=3', st4.aboveThreshold === 3 && st4.positive === 3);
ok('stats: 空数组 → 全 null', arb.stats([]).median === null && arb.stats([]).n === 0);

/* ── 8. 资金费率套利（delta 中性）── */
const fa = arb.fundingArb({ rateNow: 0.0001, notional: 100, lever: 3, fee: F, slipBps: 0 });
ok('funding: ok', fa.ok === true);
near('funding: 单期费率 0.01% → 1bps', fa.rateBpsPerPeriod, 1, 1e-9);
near('funding: 毛年化 = 0.01%×1095 = 10.95%', fa.grossAnnualPct, 10.95, 1e-6);
near('funding: 成本 = 2×(0.10%+0.05%) = 0.30%', fa.costPctOfNotional, 0.3, 1e-9);
near('funding: 净年化(名义) = 10.65%', fa.netAnnualPctOfNotional, 10.65, 1e-6);
near('funding: 资金占用倍数 = 1 + 1/3', fa.capitalMultiple, 1 + 1 / 3, 1e-4);
near('funding: 净年化(本金) = 10.65/1.3333', fa.netAnnualPctOfCapital, 10.65 / (1 + 1 / 3), 1e-6);
near('funding: 回本期数 = 0.30%/0.01% = 30 期', fa.breakEvenPeriods, 30, 1e-9);
near('funding: 每期收入 = 0.01 USDT', fa.incomePerPeriodUsd, 0.01, 1e-9);
ok('funding: 可执行', fa.executable === true);
const faNeg = arb.fundingArb({ rateNow: -0.0001, notional: 100, lever: 3, fee: F });
ok('funding: 负费率 → 不可执行且回本期数 null', faNeg.executable === false && faNeg.breakEvenPeriods === null && faNeg.note !== null);
const faStat = arb.fundingArb({ rateNow: 0.0005, rateStat: 0.0001, notional: 100, lever: 3, fee: F });
near('funding: rateStat 覆盖 rateNow（用中位数）', faStat.rateUsed, 0.0001, 1e-12);
ok('funding: 保留 rateNow 原值', faStat.rateNow === 0.0005);
const faSlip = arb.fundingArb({ rateNow: 0.0001, notional: 100, lever: 3, fee: F, slipBps: 2 });
near('funding: 滑点计入成本（4×2bps=0.08%）', faSlip.costPctOfNotional, 0.38, 1e-9);
ok('funding: 参数非法 → ok:false', arb.fundingArb({ rateNow: 0.0001, notional: 0, fee: F }).ok === false && arb.fundingArb({ rateNow: 0.0001, fee: null }).ok === false);
ok('funding: 缺失费率 → ok:false', arb.fundingArb({ rateNow: null, notional: 100, fee: F }).ok === false);
ok('funding: rateNow=undefined 也降级', arb.fundingArb({ notional: 100, fee: F }).ok === false);
ok('funding: fundingSpread 费率缺失 → ok:false', arb.fundingSpread({ rateA: null, fee: F }).ok === false);

/* 永续-永续费率差 */
const fs = arb.fundingSpread({ rateA: 0.0003, rateB: 0.0001, notional: 100, lever: 3, fee: F });
near('fundingSpread: 差 = 0.02% = 2bps', fs.spreadBpsPerPeriod, 2, 1e-9);
near('fundingSpread: 成本 = 4×0.05% = 0.20%', fs.costPctOfNotional, 0.2, 1e-9);
near('fundingSpread: 回本期数 = 10', fs.breakEvenPeriods, 10, 1e-6);
ok('fundingSpread: 可执行', fs.executable === true);

/* ── 9. 期现基差 ── */
const ba = arb.basisArb({ spotPx: 60000, perpPx: 60600, daysToExpiry: 90, fee: F, slipBps: 0, lever: 3, kind: 'future' });
ok('basis: ok', ba.ok === true);
near('basis: 基差 = 1%', ba.basisPct, 1, 1e-9);
near('basis: 年化 = 1%×365/90', ba.annualizedBasisPct, (1 / 90) * 365, 1e-4);
near('basis: 净持仓期收益 = 1% − 0.30%', ba.netAnnualPctOfNotional, ((0.01 - 0.003) / 90) * 365 * 100, 1e-4);
near('basis: 净年化(本金)', ba.netAnnualPctOfCapital, (((0.01 - 0.003) / 90) * 365 * 100) / (1 + 1 / 3), 1e-4);
near('basis: 回本天数 = 0.30%/1%×90', ba.breakEvenDays, 27, 1e-6);
ok('basis: 可执行', ba.executable === true);
const baSmall = arb.basisArb({ spotPx: 60000, perpPx: 60100, daysToExpiry: 90, fee: F, kind: 'future' });
ok('basis: 基差 16.7bps < 成本 30bps → 不可执行', baSmall.executable === false);
const baPerp = arb.basisArb({ spotPx: 60000, perpPx: 60060, fee: F, slipBps: 0, kind: 'perp' });
ok('basis: 永续口径年化为 null 且有说明', baPerp.annualizedBasisPct === null && typeof baPerp.note === 'string');
ok('basis: 价格缺失 → ok:false', arb.basisArb({ spotPx: 0, perpPx: 1, fee: F }).ok === false && arb.basisArb({ spotPx: 1, perpPx: null, fee: F }).ok === false);
ok('basis: 反向（贴水）也应被识别', arb.basisArb({ spotPx: 60000, perpPx: 59400, fee: F, kind: 'perp' }).direction.includes('反向'));

/* ── 10. 三角路径枚举（只用真实存在的交易对）── */
const insts = {
  'BTC-USDT': {}, 'ETH-USDT': {}, 'SOL-USDT': {}, 'ETH-BTC': {}, 'SOL-BTC': {},
};
insts['BTC-USDT'].lotSz = 1e-8; insts['ETH-USDT'].lotSz = 1e-8;
const triEnum = arb.enumTriangles(insts, { hubs: ['BTC', 'ETH'], others: ['SOL', 'XRP'] });
ok('enumTriangles: 有结果', triEnum.length > 0);
ok('enumTriangles: 每个路径的三个交易对都存在', triEnum.every((c) => c.pairs.every((p) => Boolean(insts[p]))));
ok('enumTriangles: 每个路径都能闭合', triEnum.every((c) => Array.isArray(arb.cycleFrom(c.pairs, 'USDT'))));
ok('enumTriangles: 不含不存在的 SOL-ETH', triEnum.every((c) => !c.pairs.includes('SOL-ETH')));
ok('enumTriangles: maxPaths 生效', arb.enumTriangles(insts, { hubs: ['BTC', 'ETH'], others: ['SOL'], maxPaths: 1 }).length === 1);

/* ── 汇总 ── */
console.log(`\narb-selftest: ${pass} 项通过, ${fails.length} 项失败`);
if (fails.length) { for (const f of fails) console.log('  FAIL ' + f); process.exit(1); }
console.log('全部通过 ✔');
process.exit(0);
