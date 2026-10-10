/*!
 * scripts/margin-selftest.mjs - william-bot-1-core key backtest/optimize logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-5D340DDA
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
#!/usr/bin/env node
/**
 * scripts/margin-selftest.mjs —— 智能保证金系统自检（exit 0 = 全绿）
 *
 * 覆盖：
 *   1) 反解公式正确性（给定 riskBudget/d/G/k 反推 N1）
 *   2) 层几何 / 死亡线距离 / 杠杆不影响风险
 *   3) 最小下单放不下 → ok:false 且原因可读
 *   4) 总占用上限生效（缩到上限或拒绝）
 *   5) sizingMode:'fixed' 与旧 martin 口径逐字节一致（回归）
 *   6) allocate：板块去重 / 篮子上限 / 贪心顺序
 *   7) 空/异常输入降级不抛
 *   8) rebalanceHint 只给建议、不改 state
 *   9) 真实候选池分配表（读 data/candidates.json + PROXY 拉行情；失败则跳过，不影响 exit 0）
 *
 * 用法：PROXY_URL=http://127.0.0.1:17890 node scripts/margin-selftest.mjs [--no-live] [--equity 113]
 */
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const margin = require(path.join(root, 'modules/margin.js'));
const martin = require(path.join(root, 'modules/martin.js'));

let passed = 0;
const failures = [];
const results = [];
function check(name, fn) {
  try { fn(); passed++; results.push(`  ✓ ${name}`); }
  catch (e) { failures.push({ name, msg: (e && e.message) || String(e) }); results.push(`  ✗ ${name}\n      ${(e && e.message) || e}`); }
}
function ok(c, msg = '断言失败') { if (!c) throw new Error(msg); }
function eq(a, b, msg) {
  const A = typeof a === 'number' ? Number(a.toFixed(10)) : a;
  const B = typeof b === 'number' ? Number(b.toFixed(10)) : b;
  if (A !== B) throw new Error(`${msg || '不相等'}：实际 ${a} ≠ 期望 ${b}`);
}
function near(a, b, tol, msg) { if (Math.abs(Number(a) - Number(b)) > tol) throw new Error(`${msg || '超容差'}：实际 ${a} vs 期望 ${b}（容差 ${tol}）`); }

const PO = { ...martin.DEFAULT_POLICY };
const ETH = { ctVal: 0.1, lotSz: 0.01, minSz: 0.01, maxLever: 100 };
const UNI = { ctVal: 1, lotSz: 1, minSz: 1, maxLever: 50 };          // 最小下单名义 ≈ 价格 × 1
const ARB = { ctVal: 10, lotSz: 0.1, minSz: 0.1, maxLever: 50 };
// 小面值夹具：价格 100 时最小下单名义仅 $10，能放进 $20 风险预算（用于闸门类断言）
const SMALL = { ctVal: 0.1, lotSz: 1, minSz: 1, maxLever: 100 };
const SMALL_AT = { ctVal: 0.1, lotSz: 0.1, minSz: 0.1, maxLever: 100 };

console.log('\n=== margin-selftest ===\n');

/* 1. 反解公式 ─────────────────────────────────── */
check('反解公式：N1 = riskBudgetUsd / (G × d × k)', () => {
  eq(margin.solveFirstNotional({ riskBudgetUsd: 100, d: 0.05, G: 2, k: 0.75 }), 100 / (2 * 0.05 * 0.75), '手算样例');
  eq(margin.solveFirstNotional({ riskBudgetUsd: 2.26, d: 0.0432, G: 20.78125, k: 0.75 }), 2.26 / (20.78125 * 0.0432 * 0.75), '真实参数样例');
  eq(margin.solveFirstNotional({ riskBudgetUsd: 100, d: 0, G: 2, k: 0.75 }), null, 'd=0 应返回 null 而不是 Infinity');
  eq(margin.solveFirstNotional({ riskBudgetUsd: 100, d: 0.05, G: 2, k: 0 }), null, 'k=0 应返回 null');
});
check('反解：k 在分母 ⇒ k<1 会放大名义（方向不能搞反）', () => {
  const a = margin.solveFirstNotional({ riskBudgetUsd: 100, d: 0.05, G: 2, k: 0.75 });
  const b = margin.solveFirstNotional({ riskBudgetUsd: 100, d: 0.05, G: 2, k: 1 });
  ok(a > b, `k=0.75 的名义 ${a} 应大于 k=1 的 ${b}（k<1 = 放大）`);
  near(a / b, 1 / 0.75, 1e-9, '放大倍数 = 1/k');
});
check('层几何 G = Σ multiplier^(i-1)', () => {
  const g = margin.layerGeometry(6, 1.5);
  eq(g.G, 20.78125, 'G(6,1.5)');
  eq(g.factors.join(','), '1,1.5,2.25,3.375,5.0625,7.59375', '逐层因子');
  eq(margin.layerGeometry(1, 1.5).G, 1, '单层 G=1');
  eq(margin.layerGeometry(4, 2).G, 15, 'G(4,2)');
});
check('死亡线距离 d = deathAtrMult × atrPct%', () => {
  eq(margin.deathDistance(2.16, 2), 0.0432, 'UNI atr 2.16% × 2');
  eq(margin.deathDistance(1, 1), 0.01, 'atr 1% × 1');
});
check('planBasket 的 detail.targetFirstNotionalUsd 与反解公式一致', () => {
  const plan = margin.planBasket({ equity: 113, atrPct: 2.16, price: 8.635, instrument: UNI, policy: { ...PO, maxBaskets: 1 } });
  const p = margin.normMarginPolicy({ ...PO, maxBaskets: 1 });
  const g = margin.layerGeometry(p.maxLevels, p.multiplier);
  const d = margin.deathDistance(2.16, p.deathAtrMult);
  ok(plan.detail, '应有 detail');
  near(plan.detail.targetFirstNotionalUsd, margin.solveFirstNotional({ riskBudgetUsd: 113 * (p.basketRiskBudgetPct / 100), d, G: g.G, k: p.riskK }), 1e-4, '反解一致');
  near(plan.detail.targetTotalNotionalUsd, plan.detail.targetFirstNotionalUsd * g.G, 1e-3, 'N_total = N1×G');
  near(plan.detail.targetTotalMarginUsd, (plan.detail.targetFirstNotionalUsd * g.G) / p.leverage, 1e-3, 'margin = N_total/杠杆');
});
check('riskAtDeath：单层手算（1 张 @100，d=5% → 亏 5）', () => {
  const r = margin.riskAtDeath({ levels: [{ price: 100, contracts: 1 }], ctVal: 1, d: 0.05, side: 'long', price: 100 });
  eq(r.deathPx, 95, '死亡线价');
  eq(r.lossUsd, 5, '死亡线亏损');
  const s = margin.riskAtDeath({ levels: [{ price: 100, contracts: 1 }], ctVal: 1, d: 0.05, side: 'short', price: 100 });
  eq(s.deathPx, 105, '空单死亡线在上方');
  eq(s.lossUsd, 5, '空单亏损同为 5');
});
check('杠杆只影响占用、不影响风险', () => {
  const base = { equity: 1000, atrPct: 2, price: 100, instrument: SMALL, policy: { ...PO, maxBaskets: 1 } };
  const a = margin.planBasket({ ...base, policy: { ...PO, maxBaskets: 1, leverage: 3 } });
  const b = margin.planBasket({ ...base, policy: { ...PO, maxBaskets: 1, leverage: 10 } });
  ok(a.ok && b.ok, `两档都应可开：${a.reason || ''}${b.reason || ''}`);
  eq(b.riskAtDeathUsd, a.riskAtDeathUsd, '风险（死亡线亏损）必须与杠杆无关');
  eq(b.totalNotionalUsd, a.totalNotionalUsd, '总名义与杠杆无关');
  near(b.totalMarginUsd, a.totalMarginUsd * (3 / 10), 0.02, '占用按杠杆反比缩小');
});

/* 3. 可行性（最小下单） ───────────────────────── */
check('最小下单放不下 → ok:false 且原因可读', () => {
  const plan = margin.planBasket({ equity: 113, atrPct: 2.16, price: 8.635, instrument: UNI, policy: { ...PO, maxBaskets: 1 } });
  eq(plan.ok, false, 'UNI(最小 1 张 ≈ $8.64) 在 113U/2% 预算下应判放不下');
  ok(/放不下/.test(plan.reason), `原因应含「放不下」，实际：${plan.reason}`);
  ok(/最小下单名义/.test(plan.reason), '原因应说明最小下单名义');
  eq(plan.layer1Contracts, 0, '拒绝时不应给张数');
  eq(plan.schedule.length, 0, '拒绝时不应给排程');
});
check('反解落在 1~1.5× 容忍带内 → 用最小合法张数并告警（不直接拒）', () => {
  // 预算卡在最小下单的 1.0~1.5 倍之间
  const plan = margin.planBasket({ equity: 113, atrPct: 2.16, price: 8.635, instrument: UNI, policy: { ...PO, maxBaskets: 1, basketRiskBudgetPct: 3.4 } });
  const n1 = plan.detail.targetFirstNotionalUsd;
  if (n1 * 1.5 >= plan.detail.minNotionalUsd) {
    eq(plan.ok, true, '容忍带内应放行');
    ok(plan.warnings.some((w) => /最小/.test(w)) || plan.layer1Contracts > 0, '应给最小张数或告警');
  }
});
check('异常输入降级不抛（空对象/负数/NaN/缺字段）', () => {
  const cases = [
    undefined, {}, { equity: 0 }, { equity: -5 }, { equity: 113 }, { equity: 113, price: 0 },
    { equity: 113, price: 100, instrument: null }, { equity: 113, price: 100, instrument: {}, atrPct: 2 },
    { equity: NaN, price: 100, instrument: ETH, atrPct: 2 }, { equity: 113, price: 100, instrument: ETH, atrPct: 0 },
    { equity: 113, price: 100, instrument: ETH, atrPct: NaN }, { equity: 113, price: 100, instrument: ETH, atrPct: 2, policy: { riskK: 0 } },
  ];
  for (const c of cases) {
    const r = margin.planBasket(c);
    ok(r && r.ok === false, `应降级为 ok:false：${JSON.stringify(c)}`);
    ok(typeof r.reason === 'string' && r.reason.length > 0, '应给出可读原因');
    ok(Array.isArray(r.schedule), 'schedule 应为数组');
  }
});

/* 4. 占用上限 ─────────────────────────────────── */
check('占用上限：已有占用接近上限 → 缩到上限', () => {
  const p = { ...PO, maxBaskets: 1, maxTotalOccupancyPct: 20, leverage: 3 };
  const eq0 = 1000;
  const open = [{ instId: 'X', marginUsd: 100 }];             // 已用 100U，上限 200U
  const plan = margin.planBasket({ equity: eq0, atrPct: 2, price: 100, instrument: SMALL, policy: p, openBaskets: open });
  ok(plan.ok, `应仍可开（缩量）：${plan.reason || ''}`);
  ok(plan.totalMarginUsd <= 200 * 1.0002, `总占用应 ≤ 上限，实际 ${plan.totalMarginUsd}`);
  ok(plan.detail.shrunkByOccupancy === true, '应标记因占用上限被缩');
  ok(plan.warnings.some((w) => /占用上限/.test(w)), '应告警占用上限');
});
check('占用上限：已满 → ok:false 并说明', () => {
  const p = { ...PO, maxBaskets: 1, maxTotalOccupancyPct: 10 };
  const plan = margin.planBasket({ equity: 1000, atrPct: 2, price: 100, instrument: SMALL, policy: p, openBaskets: [{ instId: 'X', marginUsd: 150 }] });
  eq(plan.ok, false, '已满应拒绝');
  ok(/占用上限/.test(plan.reason), `原因：${plan.reason}`);
});
check('allocate：总占用不超上限（5 篮场景封顶）', () => {
  const p = { ...PO, maxBaskets: 5, maxTotalOccupancyPct: 45 };
  const cands = ['A', 'B', 'C', 'D', 'E'].map((s, i) => ({
    instId: s + '-USDT-SWAP', sector: 'S' + i, price: 100, atrPct: 2, score: 1 - i * 0.01,
    instrument: SMALL,
  }));
  const r = margin.allocate(cands, { equity: 1000, policy: p, openBaskets: [] });
  ok(r.ok, 'allocate 应成功返回');
  ok(r.totals.occupancyPct <= 45 * 1.0002, `总占用 ${r.totals.occupancyPct}% 应 ≤ 45%`);
  ok(r.allocations.length + r.rejected.length === 5, '每个候选都要有归宿（接受或拒绝）');
});

/* 5. fixed 回归（逐字节） ─────────────────────── */
check('sizingMode:fixed 与 martin 旧口径逐字节一致', () => {
  const p = { ...PO, maxBaskets: 1, sizingMode: 'fixed', firstMarginPct: 1, leverage: 3 };
  const equity = 10000, price = 100, atrPct = 2, atrPx = (atrPct / 100) * price;
  const plan = margin.planBasket({ equity, atrPct, price, instrument: ETH, policy: p });
  ok(plan.ok, 'fixed 规划应成功');
  const ref = martin.newBasket({ instId: 'R', side: 'long', sector: 's', price, atr: atrPx, policy: p, instrument: ETH, equity, ts: 1 });
  ok(ref, '参考篮子应可建');
  eq(plan.layer1MarginUsd, ref.levels[0].marginUsd, '第 1 层保证金');
  eq(plan.layer1Contracts, ref.levels[0].contracts, '第 1 层张数');
  eq(plan.layer1NotionalUsd, Number((ETH.ctVal * ref.levels[0].contracts * ref.levels[0].price).toFixed(8)), '第 1 层名义');
  // 第 2、3 层与 martin.nextAddPrice / levelMargin / sizeForMargin 对齐
  const probe = { ...ref, levels: [...ref.levels] };
  for (let i = 1; i <= 2; i++) {
    const addPx = martin.nextAddPrice(probe, atrPx);
    const m = martin.levelMargin(ref, i);
    const c = martin.sizeForMargin({ marginUsd: m, leverage: p.leverage, price: addPx, ctVal: ETH.ctVal, lotSz: ETH.lotSz, minSz: ETH.minSz });
    eq(plan.schedule[i].addPx, addPx, `第 ${i + 1} 层挂单价`);
    eq(plan.schedule[i].marginUsd, m, `第 ${i + 1} 层保证金`);
    eq(plan.schedule[i].contracts, c, `第 ${i + 1} 层张数`);
    probe.levels.push({ idx: i, ts: 1, price: addPx, contracts: c, marginUsd: m, reason: 'add' });
  }
  eq(plan.schedule.length, margin.layerGeometry(p.maxLevels, p.multiplier).levels, '排程层数');
});
check('fixed 模式的层保证金与 martin 一致（几何列）', () => {
  const p = { ...PO, maxBaskets: 1, sizingMode: 'fixed', firstMarginPct: 1, multiplier: 1.5, maxLevels: 6 };
  const plan = margin.planBasket({ equity: 10000, atrPct: 2, price: 100, instrument: ETH, policy: p });
  const first = plan.schedule[0].marginUsd;
  for (let i = 0; i < 6; i++) near(plan.schedule[i].marginUsd, first * Math.pow(1.5, i), 1e-6, `第 ${i + 1} 层`);
});

/* 6. allocate 语义 ────────────────────────────── */
check('allocate：板块去重生效', () => {
  const p = { ...PO, maxBaskets: 5 };
  const cands = [
    { instId: 'A-USDT-SWAP', sector: 'MEME', price: 100, atrPct: 2, score: 0.9, instrument: SMALL },
    { instId: 'B-USDT-SWAP', sector: 'MEME', price: 100, atrPct: 2, score: 0.8, instrument: SMALL },
  ];
  const r = margin.allocate(cands, { equity: 1000, policy: p, openBaskets: [] });
  eq(r.allocations.length, 1, `同板块只应放行 1 个（实际 ${r.allocations.length}，拒绝：${r.rejected.map((x) => x.reason).join(' | ')}）`);
  eq(r.rejected.length, 1, '另一个应被拒');
  ok(/板块去重/.test(r.rejected[0].reason), `原因：${r.rejected[0].reason}`);
});
check('allocate：篮子上限生效 + 按 score 从高到低贪心', () => {
  const p = { ...PO, maxBaskets: 2, maxTotalOccupancyPct: 60 };
  const cands = ['A', 'B', 'C', 'D'].map((s, i) => ({
    instId: s, sector: 'S' + i, price: 100, atrPct: 2, score: [0.5, 0.9, 0.7, 0.3][i],
    instrument: SMALL,
  }));
  const r = margin.allocate(cands, { equity: 1000, policy: p, openBaskets: [] });
  eq(r.allocations.length, 2, `应只放 2 个（实际 ${r.allocations.length}：${r.rejected.map((x) => x.reason).join(' | ')}）`);
  eq(r.allocations[0].instId, 'B', '应先取 score 最高的 B');
  eq(r.allocations[1].instId, 'C', '再取次高 C');
  ok(r.rejected.some((x) => /篮子上限/.test(x.reason)), '应有篮子上限拒绝');
});
check('allocate：已有篮子参与去重与占用', () => {
  const p = { ...PO, maxBaskets: 3, maxTotalOccupancyPct: 20 };
  const open = [{ instId: 'OPEN-USDT-SWAP', sector: 'MEME', levels: [{ contracts: 1, price: 100, marginUsd: 90 }] }];
  const cands = [
    { instId: 'M-USDT-SWAP', sector: 'MEME', price: 100, atrPct: 2, score: 0.9, instrument: SMALL },
    { instId: 'N-USDT-SWAP', sector: 'L1', price: 100, atrPct: 2, score: 0.8, instrument: SMALL },
  ];
  const r = margin.allocate(cands, { equity: 1000, policy: p, openBaskets: open });
  ok(r.rejected.some((x) => x.instId === 'M-USDT-SWAP' && /板块去重/.test(x.reason)), 'MEME 应被已有篮子挡住');
  ok(r.totals.existingMarginUsd >= 90, '应体现已有占用');
  ok(r.totals.occupancyPct <= 20 * 1.0002, `含已有占用后的总占用应 ≤ 20%，实际 ${r.totals.occupancyPct}%`);
});
check('allocate：空/异常输入不抛', () => {
  for (const c of [null, undefined, [], [null, undefined], [{ instId: 'X' }]]) {
    const r = margin.allocate(c, { equity: 113, policy: PO, openBaskets: [] });
    ok(r && typeof r.ok === 'boolean', '应返回结构体');
  }
  const r2 = margin.allocate([{ instId: 'X', price: 100, atrPct: 2, instrument: { ctVal: 1, lotSz: 1, minSz: 1 } }], { equity: 0, policy: PO });
  eq(r2.ok, false, '零权益应 ok:false');
});

/* 7. rebalanceHint ───────────────────────────── */
check('rebalanceHint：只给建议、不改 state；过小→scale_up，过大→scale_down', () => {
  const p = { ...PO, maxBaskets: 1 };
  const state = {
    baskets: [{
      id: 'b1', instId: 'X-USDT-SWAP', side: 'long', sector: 'L1', ctVal: 1, lotSz: 1, minSz: 1, maxLever: 100,
      policy: { ...p, leverage: 3 }, stopUsd: 40, equityAtOpen: 1000, atrAtOpen: 2,
      levels: [{ idx: 0, ts: 1, price: 100, contracts: 1, marginUsd: 33.33 }],
      closed: false,
    }],
  };
  const snapshot = JSON.stringify(state);
  const small = margin.rebalanceHint(state, { equity: 1000, policy: p, marks: { 'X-USDT-SWAP': { price: 100, atrPct: 2 } } });
  ok(small.ok, '应返回 ok');
  eq(small.hints.length, 1, '一个篮子一条建议');
  ok(['scale_up', 'hold', 'scale_down', 'review'].includes(small.hints[0].action), `动作应合法：${small.hints[0].action}`);
  eq(JSON.stringify(state), snapshot, 'rebalanceHint 不得修改传入 state');
  ok(/建议/.test(small.note), '应声明只给建议');
  // 权益放大 20 倍 → 目标名义应远大于当前 → scale_up
  const big = margin.rebalanceHint(state, { equity: 20000, policy: p, marks: { 'X-USDT-SWAP': { price: 100, atrPct: 2 } } });
  eq(big.hints[0].action, 'scale_up', '权益放大 20 倍应建议扩容');
});
check('rebalanceHint：缺 marks / 空 state 降级不抛', () => {
  ok(margin.rebalanceHint(null, { equity: 113, policy: PO }).ok === true || margin.rebalanceHint(null, { equity: 113, policy: PO }).ok === false, '空 state 不抛');
  const s = { baskets: [{ id: 'b', instId: 'X', side: 'long', ctVal: 1, levels: [{ contracts: 1, price: 100 }] }] };
  const r = margin.rebalanceHint(s, { equity: 0, policy: PO });
  eq(r.ok, false, '零权益应 ok:false');
  const r2 = margin.rebalanceHint({ baskets: [{ id: 'b', instId: 'X', side: 'long', ctVal: 1, lotSz: 1, minSz: 1, atrAtOpen: 0, levels: [{ contracts: 1, price: 100 }] }] }, { equity: 113, policy: PO });
  ok(r2.hints.length === 1, '缺 ATR 应给一条 unknown/review 建议');
});

/* 8. 参数校验 ────────────────────────────────── */
check('validateMarginPolicy：总风险 >12% 报错、占用上限 >60% 报错', () => {
  const bad = margin.validateMarginPolicy({ ...PO, basketRiskBudgetPct: 5, maxBaskets: 3 });
  eq(bad.ok, false, '5% × 3 = 15% 应报错');
  ok(bad.errors.some((e) => /总风险超限/.test(e)), `错误：${bad.errors.join('; ')}`);
  const bad2 = margin.validateMarginPolicy({ ...PO, maxTotalOccupancyPct: 70 });
  eq(bad2.ok, false, '占用 70% 应报错');
  const good = margin.validateMarginPolicy({ ...PO, basketRiskBudgetPct: 2, maxBaskets: 3, maxTotalOccupancyPct: 45, riskK: 0.75 });
  eq(good.ok, true, `合规组合应通过：${good.errors.join('; ')}`);
  ok(good.warnings.some((w) => /riskK/.test(w)), 'k<1 应给放大告警');
  eq(good.effective.totalRiskPct, 6, '总风险 = 2%×3 = 6%');
});

/* 9. 真实候选池 ──────────────────────────────── */
const live = !process.argv.includes('--no-live');
const equityArg = (() => { const i = process.argv.indexOf('--equity'); return i >= 0 ? Number(process.argv[i + 1]) : 113; })();

async function liveSection() {
  const candFile = path.join(root, 'data', 'candidates.json');
  if (!fs.existsSync(candFile)) { console.log('  ⚠ 跳过：无 data/candidates.json'); return null; }
  const raw = JSON.parse(fs.readFileSync(candFile, 'utf8'));
  const picked = raw.picked || [];
  let swaps = null, tickers = null;
  try {
    process.env.PROXY_URL = process.env.PROXY_URL || 'http://127.0.0.1:17890';
    const uni = require(path.join(root, 'modules', 'universe.js'));
    [swaps, tickers] = await Promise.all([uni.allSwaps(), uni.allTickers()]);
  } catch (e) {
    console.log(`  ⚠ 跳过实时行情（${String(e.message || e).slice(0, 60)}）→ 用 candidates.json 自带价格`);
  }
  const instMap = new Map((swaps || []).map((d) => [d.instId, d]));
  const pxMap = new Map((tickers || []).map((d) => [d.instId, Number(d.last)]));
  const cands = picked.map((c) => {
    const ins = instMap.get(c.instId) || {};
    return {
      instId: c.instId, sector: c.sector, score: c.score,
      price: pxMap.get(c.instId) || c.last, atrPct: c.atrPct,
      allowDirections: c.allowDirections, regime: c.regime,
      instrument: {
        ctVal: Number(ins.ctVal || c.ctVal), lotSz: Number(ins.lotSz || 0),
        minSz: Number(ins.minSz || c.minSz), maxLever: Number(ins.lever || c.maxLever), ctValCcy: ins.ctValCcy || c.ctValCcy,
      },
      source: c,
    };
  });
  return { cands, raw, livePrices: Boolean(tickers) };
}

console.log(results.join('\n'));

if (live) {
  try {
    const L = await liveSection();
    if (L && L.cands.length) {
      const eqU = equityArg;
      const pad = (s, n) => String(s).padEnd(n);
      const r2 = (v, n = 4) => (v === null || v === undefined ? '--' : Number(v).toFixed(n));
      console.log(`\n${'─'.repeat(112)}`);
      console.log(`【真实候选池分配表】equity=$${eqU} · 行情来源=${L.livePrices ? '实时（PROXY）' : 'candidates.json 快照'} · 候选 ${L.cands.length} 个`);
      const pol = { ...PO, maxBaskets: 5, basketRiskBudgetPct: 2, maxTotalOccupancyPct: 45, riskK: 0.75, deathAtrMult: 2, leverage: 3 };
      const val = margin.validateMarginPolicy(pol);
      console.log(`参数：risk 模式 · 每篮风险预算 ${pol.basketRiskBudgetPct}% 权益 · 占用上限 ${pol.maxTotalOccupancyPct}% · k=${pol.riskK} · 死亡线=${pol.deathAtrMult}×ATR · 杠杆 ${pol.leverage}x`);
      console.log(`校验：${val.ok ? '通过' : '不通过 ' + val.errors.join('; ')}${val.warnings.length ? ' ｜ 告警：' + val.warnings.join('; ') : ''}`);
      const riskBudget = eqU * pol.basketRiskBudgetPct / 100;
      console.log(`本篮风险预算 = $${eqU} × ${pol.basketRiskBudgetPct}% = $${r2(riskBudget, 2)} ；金额兜底 = $${eqU} × ${PO.hardStopPct}% = $${r2(eqU * PO.hardStopPct / 100, 2)}\n`);
      console.log('  ' + pad('品种', 17) + pad('板块', 11) + pad('价', 10) + pad('ATR%', 7) + pad('反解N1', 10) + pad('可开?', 9) + pad('首层张数', 10) + pad('总名义', 11) + pad('总保证金', 10) + pad('死亡线亏损', 11) + pad('风险%权益', 10) + '占用%');
      console.log('  ' + '─'.repeat(108));
      for (const c of L.cands.slice().sort((a, b) => (b.score?.total || 0) - (a.score?.total || 0))) {
        const plan = margin.planBasket({ equity: eqU, atrPct: c.atrPct, price: c.price, instrument: c.instrument, policy: pol, openBaskets: [], sector: c.sector, score: c.score });
        const inst = c.instId.replace('-USDT-SWAP', '');
        if (plan.ok) {
          console.log('  ' + pad(inst, 17) + pad(c.sector, 11) + pad(r2(c.price, c.price < 10 ? 5 : 2), 10) + pad(r2(c.atrPct, 2), 7) + pad(r2(plan.detail.targetFirstNotionalUsd, 3), 10) + pad('✓', 9) + pad(plan.layer1Contracts, 10) + pad(r2(plan.totalNotionalUsd, 2), 11) + pad(r2(plan.totalMarginUsd, 2), 10) + pad(r2(plan.riskAtDeathUsd, 2), 11) + pad(r2(plan.riskPctEquity, 3), 10) + r2(plan.occupancyPct, 2));
        } else {
          console.log('  ' + pad(inst, 17) + pad(c.sector, 11) + pad(r2(c.price, c.price < 10 ? 5 : 2), 10) + pad(r2(c.atrPct, 2), 7) + pad('--', 10) + pad('✗ 拒', 9) + pad('--', 10) + pad('--', 11) + pad('--', 10) + pad('--', 11) + pad('--', 10) + '--');
          console.log('      ↳ ' + plan.reason);
        }
      }
      const alloc = margin.allocate(L.cands, { equity: eqU, policy: pol, openBaskets: [] });
      console.log(`\n【贪心分配】接受 ${alloc.allocations.length} 篮 / 拒绝 ${alloc.rejected.length} 个`);
      console.log(`  总保证金 $${r2(alloc.totals.marginUsd, 2)}（占用 ${r2(alloc.totals.occupancyPct, 2)}% / 上限 ${alloc.totals.occupancyCapPct}%）· 总名义 $${r2(alloc.totals.notionalUsd, 2)} · 最坏亏损 $${r2(alloc.totals.worstLossUsd, 2)}（${r2(alloc.totals.worstLossPctEquity, 2)}% 权益）`);
      for (const a of alloc.allocations) console.log(`  ✓ ${pad(a.instId, 17)} 首层 ${a.layer1Contracts} 张 · 总保证金 $${r2(a.totalMarginUsd, 2)} · 死亡线亏损 $${r2(a.riskAtDeathUsd, 2)} · 占用 ${r2(a.occupancyPct, 2)}%${a.warnings.length ? ' ｜ ' + a.warnings[0] : ''}`);
      for (const x of alloc.rejected) console.log(`  ✗ ${pad(x.instId, 17)} ${x.reason}`);

      // 「5 个篮子」场景
      const five = margin.allocate(L.cands, { equity: eqU, policy: { ...pol, maxBaskets: 5 }, openBaskets: [] });
      const cap = eqU * pol.maxTotalOccupancyPct / 100;
      console.log(`\n【5 篮场景】权益 $${eqU} · 占用上限 $${r2(cap, 2)}（${pol.maxTotalOccupancyPct}%）`);
      console.log(`  实际：${five.allocations.length} 篮 / 总保证金 $${r2(five.totals.marginUsd, 2)}（${r2(five.totals.occupancyPct, 2)}%）/ 总名义 $${r2(five.totals.notionalUsd, 2)} / 最坏亏损 $${r2(five.totals.worstLossUsd, 2)} = ${r2(five.totals.worstLossPctEquity, 2)}% 权益`);
      console.log(`  被拒 ${five.rejected.length} 个：` + (five.rejected.slice(0, 4).map((x) => x.instId.replace('-USDT-SWAP', '') + '(' + x.reason.slice(0, 24) + ')').join(' · ') || '无'));

      // fixed vs risk 对比
      console.log(`\n【与旧 fixed 口径对比】同权益 $${eqU}，fixed=首单 ${PO.firstMarginPct}% 保证金 ×${PO.leverage}x；risk=每篮风险预算 ${pol.basketRiskBudgetPct}%`);
      console.log('  ' + pad('品种', 17) + pad('fixed首层名义', 14) + pad('fixed总名义', 12) + pad('fixed死亡线亏损', 15) + pad('fixed风险%', 11) + pad('risk首层名义', 13) + pad('risk总名义', 11) + pad('risk死亡线亏损', 14) + pad('risk风险%', 10));
      console.log('  ' + '─'.repeat(118));
      for (const c of L.cands.slice(0, 8)) {
        const pf = margin.planBasket({ equity: eqU, atrPct: c.atrPct, price: c.price, instrument: c.instrument, policy: { ...pol, sizingMode: 'fixed', firstMarginPct: PO.firstMarginPct, maxBaskets: 1 }, openBaskets: [] });
        const pr = margin.planBasket({ equity: eqU, atrPct: c.atrPct, price: c.price, instrument: c.instrument, policy: { ...pol, maxBaskets: 1 }, openBaskets: [] });
        const inst = c.instId.replace('-USDT-SWAP', '');
        const f = (p) => (p.ok ? [r2(p.layer1NotionalUsd, 2), r2(p.totalNotionalUsd, 2), r2(p.riskAtDeathUsd, 2), r2(p.riskPctEquity, 2)] : ['拒', '--', '--', '--']);
        const a = f(pf), b = f(pr);
        console.log('  ' + pad(inst, 17) + pad(a[0], 14) + pad(a[1], 12) + pad(a[2], 15) + pad(a[3], 11) + pad(b[0], 13) + pad(b[1], 11) + pad(b[2], 14) + pad(b[3], 10));
      }
      console.log('');
    }
  } catch (e) {
    console.log(`\n⚠ 真实候选池段跳过（${String(e.message || e).slice(0, 120)}）—— 不影响断言结果`);
  }
}

if (failures.length) {
  console.log(`\n✗ 失败 ${failures.length} 项 / 共 ${passed + failures.length} 项`);
  for (const f of failures) console.log(`  · ${f.name}\n    ${f.msg}`);
  process.exit(1);
}
console.log(`\n✓ 全部通过：${passed} 项（反解公式 / 可行性与占用上限 / fixed 回归 / allocate 语义 / 异常降级 / 再平衡建议 / 参数校验）\n`);
process.exit(0);
