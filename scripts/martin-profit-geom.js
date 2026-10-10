/*!
 * scripts/martin-profit-geom.js - william-bot-1-core key backtest/optimize logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-06633588
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
#!/usr/bin/env node
/**
 * scripts/martin-profit-geom.js —— 实盘口径下的「层几何」盈利扫描（第三轮聚焦）
 *
 * 为什么：第二轮发现两件事——
 *   ① 第一轮的 ATR×0.5 止盈优势**只在固定口径成立**；换成实盘 sizingMode=risk（仓位 ∝ 1/ATR%）
 *      后消失甚至转差（风险预算仓位把波动自适应抵消掉了）。
 *   ② 真正在两个口径下都成立的，是「降低层几何 G = Σ multiplier^k」——
 *      mult1.5/6层 G=20.78 → mult2/4层 G=15：同样风险预算下首层更大、需要的层数更少，
 *      被 trend_flip / time_stop 打穿的伤害更小。
 * 本轮固定「实盘口径」（risk 仓位 + 占用上限硬拦 + 金额兜底 3%），只扫层几何与间距，
 * 用 **5 折样本外 + 最差折回撤 + 滑点压力** 选型（并对选型本身保持怀疑，见报告）。
 *
 * 用法：PROXY_URL=http://127.0.0.1:17890 node scripts/martin-profit-geom.js [--days 350] [--fee 8] [--folds 5]
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
const G = (mult, lv) => { let s = 0, g = 1; for (let i = 0; i < lv; i++) { s += g; g *= mult; } return round(s, 4); };

const BASE = { ...bt.BASE_POLICY };
const live = (geom) => ({
  ...geom, sizingMode: 'risk', basketRiskBudgetPct: 4, maxTotalOccupancyPct: 45, riskK: 1.2,
  deathAtrMult: 6, maxBasketRiskPct: 3, maxBaskets: 5, dailyLossPct: 4,
});

/** 几何候选：固定止盈 0.8%（实盘口径下它比 ATR 止盈好），只变 (倍数, 层数, 间距) */
const GEOMS = [];
for (const [m, lv] of [[1.5, 6], [1.5, 5], [1.5, 4], [2, 4], [2, 3], [2.2, 4], [2.5, 3], [3, 3]]) {
  GEOMS.push([`mult${m}/层${lv} (G=${G(m, lv)})`, { ...BASE, multiplier: m, maxLevels: lv }]);
}
for (const [m, lv, sp] of [[2, 4, 0.8], [2, 4, 1.2], [2.5, 3, 0.8], [3, 3, 0.8]]) {
  GEOMS.push([`mult${m}/层${lv}/间距${sp} (G=${G(m, lv)})`, { ...BASE, multiplier: m, maxLevels: lv, spacingAtrMult: sp }]);
}

async function main() {
  const days = Number(arg('days', 350));
  const equity0 = Number(arg('equity', 10000));
  const feeBps = Number(arg('fee', 8));
  const folds = Number(arg('folds', 5));
  const outFile = arg('out', path.join(DATA_DIR, `profit-geom-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`));

  console.log(`\n=== 实盘口径层几何扫描 · ${days} 天 · ${feeBps}bps · 账户 $${equity0} ===`);
  const data = await sw1.loadData(days, true, console.log);
  const bars = Math.min(...data.map((d) => d.candles.length));
  const realDays = round(bars / 24, 1);
  const winS = Math.max(...data.map((d) => d.candles[0].ts));
  const winE = Math.min(...data.map((d) => d.candles[d.candles.length - 1].ts));
  const cut = winS + (winE - winS) * 0.7;
  store.ensureDir(DATA_DIR);

  const rows = [];
  for (const [name, geom] of GEOMS) {
    const pol = live(geom);
    const full = bt.simulate({ data, policy: pol, equity0, feeBps, fundingIncluded: true, trackOccupancy: true });
    const slip5 = bt.simulate({ data, policy: pol, equity0, feeBps, fundingIncluded: true, slipBps: 5, trackOccupancy: true });
    const wf = bt.walkForward({ data, policy: pol, equity0, feeBps, fundingIncluded: true, folds });
    const small = bt.simulate({ data, policy: pol, equity0: 113, feeBps, fundingIncluded: true, trackOccupancy: true });
    const isRun = sw2.run3(data, pol, { winStart: winS, winEnd: winE, cut, equity0, feeBps });
    const rec = {
      name, geom, policy: pol,
      full: sw1.metrics(full, realDays, equity0, feeBps), occ: full.occupancy,
      slip5: sw1.metrics(slip5, realDays, equity0, feeBps),
      is: isRun.is, holdout: isRun.oos,
      fold: { ...wf.oos, perFold: wf.folds.map((f) => ({ fold: f.fold, trades: f.summary.trades, expectancyBps: round(Number(f.summary.expectancyPct) * 100, 4), profitFactor: f.summary.profitFactor, maxDDPct: f.summary.maxDrawdownPct })) },
      small: sw1.metrics(small, realDays, 113, feeBps),
      counters: full.summary.counters, reasons: sw2.byReason(full), perSymbol: full.perSymbol,
      G: G(Number(geom.multiplier), Number(geom.maxLevels)),
    };
    rows.push(rec);
    console.log(`  · ${name.padEnd(30)} 净 ${String(rec.full.netPnlUsd).padStart(11)}U · 回撤 ${String(rec.full.maxDDPct).padStart(6)}% · 期望 ${String(rec.full.expectancyBps).padStart(5)}bps · PF ${String(rec.full.profitFactor).padStart(5)} ‖ 5折OOS ${String(round(Number(rec.fold.expectancyPct) * 100, 4)).padStart(5)}bps ${rec.fold.foldsPositive}/${folds} 最差折 ${String(rec.fold.worstFoldDDPct).padStart(6)}% ‖ 留出 ${String(rec.holdout.expectancyBps).padStart(5)}bps ‖ 占用峰值 ${String(rec.occ.maxPct).padStart(5)}% 超限 ${rec.occ.aboveCapSharePct}% ‖ 113U ${rec.small.trades}笔 ${rec.small.expectancyBps}bps`);
  }

  const report = {
    ok: true, generatedAt: new Date().toISOString(),
    note: '实盘口径（risk 仓位 + 占用上限硬拦）下的层几何扫描；选型看 5 折 OOS 与最差折回撤，不只看全窗净利',
    days: realDays, equity0, feeBps, folds, symbols: data.map((d) => d.instId),
    rows: rows.map((r) => ({ ...r, reasons: r.reasons, perSymbol: r.perSymbol })),
  };
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
  report.outFile = outFile;

  const cols = [
    { label: '几何', w: 30, get: (r) => r.name },
    { label: 'G', w: 8, get: (r) => r.G },
    { label: '净U', w: 11, get: (r) => r.full.netPnlUsd },
    { label: '回撤%', w: 8, get: (r) => r.full.maxDDPct },
    { label: '期望bps', w: 9, get: (r) => r.full.expectancyBps },
    { label: 'PF', w: 7, get: (r) => r.full.profitFactor },
    { label: '笔/日', w: 7, get: (r) => r.full.tradesPerDay },
    { label: 'IS期望bps', w: 10, get: (r) => r.is.expectancyBps },
    { label: '留出期望bps', w: 11, get: (r) => r.holdout.expectancyBps },
    { label: '5折OOSbps', w: 11, get: (r) => round(Number(r.fold.expectancyPct) * 100, 4) },
    { label: '正收益折', w: 9, get: (r) => `${r.fold.foldsPositive}/${folds}` },
    { label: '最差折DD%', w: 10, get: (r) => r.fold.worstFoldDDPct },
    { label: 'slip5净U', w: 10, get: (r) => r.slip5.netPnlUsd },
    { label: '占用峰值%', w: 10, get: (r) => r.occ.maxPct },
    { label: '超限占比%', w: 10, get: (r) => r.occ.aboveCapSharePct },
    { label: '113U期望bps', w: 12, get: (r) => r.small.expectancyBps },
  ];
  console.log('\n' + '='.repeat(160));
  const out = [cols.map((c) => String(c.label).padStart(c.w)).join('')];
  for (const r of rows) out.push(cols.map((c) => String(c.get(r)).padStart(c.w)).join(''));
  console.log(out.join('\n'));
  console.log('\n' + '='.repeat(160));
  console.log(`报告：${outFile}`);
  return report;
}

if (require.main === module) main().catch((e) => { console.error('扫描失败：', e && e.stack || e); process.exit(1); });
module.exports = { GEOMS, live, G };
