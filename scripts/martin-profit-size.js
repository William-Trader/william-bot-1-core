/*!
 * scripts/martin-profit-size.js - william-bot-1-core key backtest/optimize logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-73779965
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
#!/usr/bin/env node
/**
 * scripts/martin-profit-size.js —— 第四轮：仓位放大前沿（在推荐层几何之上）
 *
 * 用户已授权「扩大仓位」。但实盘口径下放大不是线性：
 *   · 尺寸 ∝ （basketRiskBudgetPct / riskK）——riskK 在分母，k<1 直接放大名义
 *   · 而**金额兜底止损（maxBasketRiskPct，占权益%）是固定金额**：仓位越大，
 *     同样的价格逆向幅度就足以打穿兜底 → 止损「可达距离」随仓位变近、止损频率上升
 *   → 因此存在一个"尺寸最优区"，本脚本把 frontier 量出来。
 *
 * 每档都跑：全窗 + 5 折 walk-forward + slip5bps + 113U 小账户 + 占用统计，
 * 并按「最差折回撤」给出可接受的仓位上限（门槛：期望 > 0）。
 *
 * 用法：PROXY_URL=http://127.0.0.1:17890 node scripts/martin-profit-size.js [--days 350] [--fee 8] [--folds 5]
 */
'use strict';

if (!process.env.PROXY_URL && !process.env.HTTPS_PROXY) process.env.PROXY_URL = 'http://127.0.0.1:17890';

const fs = require('fs');
const path = require('path');
const store = require('../modules/store');
const bt = require('./martin-backtest');
const sw1 = require('./martin-profit-sweep');
const sw2 = require('./martin-profit-sweep2');

const DATA_DIR = path.join(__dirname, '..', 'data');
const round = (v, n = 4) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(n)) : null);
const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};

/** 第三轮推荐几何（3 项定下来的底） */
const GEOM = { ...bt.BASE_POLICY, multiplier: 2, maxLevels: 4, spacingAtrMult: 0.8, takeProfitPct: 0.8 };
/** 实盘口径底座 */
const LIVE = { ...GEOM, sizingMode: 'risk', basketRiskBudgetPct: 4, maxTotalOccupancyPct: 45, riskK: 1.2, deathAtrMult: 6, maxBasketRiskPct: 3, maxBaskets: 5, dailyLossPct: 4 };
const sizeOf = (p) => round((Number(p.basketRiskBudgetPct) / 4) * (1.2 / Number(p.riskK)), 3);   // 相对基准仓位的倍数

const SETS = [];
const add = (name, patch) => SETS.push([name, { ...LIVE, ...patch }]);
/* ① 尺寸主刻度：riskK 分母（1.2→0.4 = 仓位 ×1 → ×3） */
for (const k of [1.2, 1.0, 0.75, 0.6, 0.5, 0.4]) add(`riskK=${k}（仓位×${round(1.2 / k, 2)}）`, { riskK: k });
/* ② 风险预算（受 B 侧规则约束：预算 × 篮数 ≤ 20%） */
for (const [b, n] of [[4, 5], [5, 4], [6, 3], [8, 2]]) add(`预算${b}%/篮数${n}（×${round(b / 4, 2)}·篮${n}）`, { basketRiskBudgetPct: b, maxBaskets: n });
/* ③ 杠杆（同样名义需要更少保证金 → 占用更松；但爆仓距离更近） */
for (const lv of [2, 5]) add(`杠杆${lv}x`, { leverage: lv });
/* ④ 金额兜底（止损可达距离的另一个旋钮） */
for (const b of [2, 5, 8]) add(`兜底${b}%`, { maxBasketRiskPct: b });
/* ⑤ 占用上限（放宽 → 同尺寸能多开篮） */
for (const cap of [60, 75]) add(`占用上限${cap}%`, { maxTotalOccupancyPct: cap });
/* ⑥ 组合：放大 + 收紧兜底；放大 + 放宽占用 */
add('k=0.6 + 兜底5%', { riskK: 0.6, maxBasketRiskPct: 5 });
add('k=0.6 + 占用60% + 预算5%/4篮', { riskK: 0.6, maxTotalOccupancyPct: 60, basketRiskBudgetPct: 5, maxBaskets: 4 });
add('k=0.5 + 占用60% + 预算6%/3篮', { riskK: 0.5, maxTotalOccupancyPct: 60, basketRiskBudgetPct: 6, maxBaskets: 3 });
/* ⑦ 组合（把两个“可行杠杆”叠起来：杠杆提资本效率 + 预算提尺寸） */
for (const [lv, b, n, bs] of [[5, 4, 5, 3], [5, 5, 4, 3], [5, 6, 3, 3], [5, 8, 2, 3], [5, 6, 3, 2], [5, 8, 2, 2], [5, 4, 5, 2], [5, 5, 4, 2]]) {
  add(`杠杆${lv}x+预算${b}%/${n}篮+兜底${bs}%`, { leverage: lv, basketRiskBudgetPct: b, maxBaskets: n, maxBasketRiskPct: bs });
}
add('杠杆5x+k0.75+预算4%/5篮', { leverage: 5, riskK: 0.75 });
add('杠杆5x+占用60%+预算6%/3篮+兜底2%', { leverage: 5, maxTotalOccupancyPct: 60, basketRiskBudgetPct: 6, maxBaskets: 3, maxBasketRiskPct: 2 });

async function main() {
  const days = Number(arg('days', 350));
  const equity0 = Number(arg('equity', 10000));
  const feeBps = Number(arg('fee', 8));
  const folds = Number(arg('folds', 5));
  const outFile = arg('out', path.join(DATA_DIR, `profit-size-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`));

  console.log(`\n=== 仓位放大前沿 · ${days} 天 · ${feeBps}bps · 底座=实盘口径+推荐几何(2.0/4层/间距0.8) ===`);
  const data = await sw1.loadData(days, true, console.log);
  const bars = Math.min(...data.map((d) => d.candles.length));
  const realDays = round(bars / 24, 1);
  store.ensureDir(DATA_DIR);

  const rows = [];
  for (const [name, pol] of SETS) {
    const full = bt.simulate({ data, policy: pol, equity0, feeBps, fundingIncluded: true, trackOccupancy: true });
    const wf = bt.walkForward({ data, policy: pol, equity0, feeBps, fundingIncluded: true, folds });
    const slip = bt.simulate({ data, policy: pol, equity0, feeBps, fundingIncluded: true, slipBps: 5 });
    const small = bt.simulate({ data, policy: pol, equity0: 113, feeBps, fundingIncluded: true });
    const rec = {
      name, policy: pol, sizeMul: sizeOf(pol),
      full: sw1.metrics(full, realDays, equity0, feeBps), occ: full.occupancy,
      fold: { ...wf.oos, perFold: wf.folds.map((f) => ({ fold: f.fold, trades: f.summary.trades, expectancyBps: round(Number(f.summary.expectancyPct) * 100, 4), profitFactor: f.summary.profitFactor, maxDDPct: f.summary.maxDrawdownPct })) },
      slip5: sw1.metrics(slip, realDays, equity0, feeBps),
      small: sw1.metrics(small, realDays, 113, feeBps),
      counters: full.summary.counters, reasons: sw2.byReason(full),
      stopLossCount: full.summary.stopLossCount, liquidationCount: full.summary.liquidationCount,
      riskAtDeathMeanPct: round((full.trades.reduce((a, t) => a + t.riskAtDeathUsd, 0) / Math.max(1, full.trades.length) / equity0) * 100, 3),
    };
    rows.push(rec);
    console.log(`  · ${name.padEnd(28)} 仓位×${String(rec.sizeMul).padStart(4)} 净 ${String(rec.full.netPnlUsd).padStart(10)}U · 回撤 ${String(rec.full.maxDDPct).padStart(6)}% · 期望 ${String(rec.full.expectancyBps).padStart(5)}bps · PF ${String(rec.full.profitFactor).padStart(5)} · 止损 ${String(rec.stopLossCount).padStart(3)} 爆仓 ${rec.liquidationCount} ‖ 5折OOS ${String(round(Number(rec.fold.expectancyPct) * 100, 4)).padStart(5)}bps 最差折 ${String(rec.fold.worstFoldDDPct).padStart(6)}% ‖ 占用峰值 ${String(rec.occ.maxPct).padStart(5)}% ‖ 113U ${rec.small.expectancyBps}bps`);
  }

  const report = {
    ok: true, generatedAt: new Date().toISOString(),
    note: '第四轮：在实盘口径+推荐几何上做仓位放大前沿（riskK/预算/杠杆/兜底/占用上限）',
    days: realDays, equity0, feeBps, folds, symbols: data.map((d) => d.instId), base: LIVE,
    rows, assumptions: [
      '尺寸 ∝ basketRiskBudgetPct / riskK（k 在分母）；riskK<1 时实盘会告警「死亡线亏损超预算」',
      '金额兜底 maxBasketRiskPct 是固定 % 权益 → 仓位越大、止损可达距离越近、止损频率越高',
      '绝对 U 受复利放大，决策看 bps / 回撤 / PF / 折稳定性',
      '5 折 walk-forward 逐折独立重放；slip5 叠 5bps/侧不利滑点',
    ],
  };
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
  report.outFile = outFile;

  const cols = [
    { label: '档位', w: 34, get: (r) => r.name },
    { label: '仓位×', w: 7, get: (r) => r.sizeMul },
    { label: '杠杆', w: 5, get: (r) => r.policy.leverage },
    { label: '净U', w: 11, get: (r) => r.full.netPnlUsd },
    { label: '回撤%', w: 8, get: (r) => r.full.maxDDPct },
    { label: '期望bps', w: 9, get: (r) => r.full.expectancyBps },
    { label: 'PF', w: 7, get: (r) => r.full.profitFactor },
    { label: '止损/爆仓', w: 10, get: (r) => `${r.stopLossCount}/${r.liquidationCount}` },
    { label: '5折OOSbps', w: 11, get: (r) => round(Number(r.fold.expectancyPct) * 100, 4) },
    { label: '正收益折', w: 9, get: (r) => `${r.fold.foldsPositive}/${folds}` },
    { label: '最差折DD%', w: 10, get: (r) => r.fold.worstFoldDDPct },
    { label: 'slip5净U', w: 10, get: (r) => r.slip5.netPnlUsd },
    { label: '占用峰值%', w: 10, get: (r) => r.occ.maxPct },
    { label: '>80%占比', w: 10, get: (r) => r.occ.above80SharePct },
    { label: '>100%占比', w: 11, get: (r) => r.occ.above100SharePct },
    { label: '可行', w: 6, get: (r) => (r.occ.feasible ? '是' : '否') },
    { label: '113U期望bps', w: 12, get: (r) => r.small.expectancyBps },
  ];
  console.log('\n' + '='.repeat(180));
  const out = [cols.map((c) => String(c.label).padStart(c.w)).join('')];
  for (const r of rows) out.push(cols.map((c) => String(c.get(r)).padStart(c.w)).join(''));
  console.log(out.join('\n'));

  /* 按最差折回撤 + 占用可行性（保证金不得超权益）给仓位上限建议 */
  const feasible = rows.filter((r) => r.occ.feasible && r.full.expectancyUsd > 0 && r.fold.worstFoldDDPct >= -25);
  const feas20 = feasible.filter((r) => r.fold.worstFoldDDPct >= -20);
  const pickMax = (arr) => arr.slice().sort((a, b) => b.full.netPnlUsd - a.full.netPnlUsd)[0];
  console.log('\n' + '='.repeat(180));
  console.log(`【可行档】（占用从未超权益 且 期望>0）：${feasible.length}/${rows.length} 档；其中最差折 ≥ −20%：${feas20.length} 档`);
  const a25 = pickMax(feasible), a20 = pickMax(feas20);
  if (a25) console.log(`  · 可行中净利最大（最差折 ≥ −25%）：${a25.name}（仓位×${a25.sizeMul} · 杠杆${a25.policy.leverage}x · 净 ${a25.full.netPnlUsd}U · 回撤 ${a25.full.maxDDPct}% · 最差折 ${a25.fold.worstFoldDDPct}% · 占用峰值 ${a25.occ.maxPct}%）`);
  if (a20) console.log(`  · 可行中净利最大（最差折 ≥ −20%）：${a20.name}（仓位×${a20.sizeMul} · 杠杆${a20.policy.leverage}x · 净 ${a20.full.netPnlUsd}U · 回撤 ${a20.full.maxDDPct}% · 最差折 ${a20.fold.worstFoldDDPct}% · 占用峰值 ${a20.occ.maxPct}%）`);
  console.log(`报告：${outFile}`);
  return report;
}

if (require.main === module) main().catch((e) => { console.error('扫描失败：', e && e.stack || e); process.exit(1); });
module.exports = { SETS, GEOM, LIVE, sizeOf };
