/*!
 * scripts/martin-profit-check.js - william-bot-1-core key backtest/optimize logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-0FBDAA18
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
#!/usr/bin/env node
/**
 * scripts/martin-profit-check.js —— 第二轮候选的「实盘可行性」复核
 *
 * 为什么需要：第二轮网格（martin-profit-sweep2.js）里最优的那些组是在**固定 1% 首单 + 不设占用上限**
 * 的口径上跑出来的。实盘是 sizingMode=risk（风险预算 4%/篮、占用上限 45%、k=1.2、死亡线 6×ATR、
 * 金额兜底 3%、5 篮）+ 113U 小账户（最小下单张数约束）。本脚本对每个候选同时跑：
 *   ① 固定口径（含占用统计）  ② 实盘口径 risk（modules/margin.planBasket，占用上限硬拦）
 *   ③ 实盘口径 + slip 5bps    ④ 实盘口径 5 折 walk-forward   ⑤ 113U 小账户（最小下单约束下的真实摩擦）
 *
 * 用法：PROXY_URL=http://127.0.0.1:17890 node scripts/martin-profit-check.js [--days 350] [--fee 8] [--folds 5]
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

const BASE = { ...bt.BASE_POLICY };
const A = sw2.ANCHOR;                       // 第一轮锚：ATR×0.5
const CAP = { maxTotalOccupancyPct: 45 };   // 只用于占用统计口径（固定模式下不影响成交）
/** 实盘口径基线：把候选的几何换成实盘 sizingMode=risk 那一套风控参数 */
const liveOf = (geom) => ({
  ...geom, sizingMode: 'risk', basketRiskBudgetPct: 4, maxTotalOccupancyPct: 45, riskK: 1.2,
  deathAtrMult: 6, maxBasketRiskPct: 3, maxBaskets: 5, dailyLossPct: 4,
});

const CANDS = [
  ['C0 基线 固定0.8%/3篮/cd4', BASE],
  ['A1 锚 ATR×0.5', A],
  ['A2 最优净利 TP0.7/spacing0.6', { ...BASE, takeProfitPct: 0, tpAtrMult: 0.7, spacingAtrMult: 0.6 }],
  ['A3 最优回撤 mult2/层4', { ...A, multiplier: 2, maxLevels: 4 }],
  ['A4 spacing×0.8', { ...A, spacingAtrMult: 0.8 }],
  ['A5 cooldown=0', { ...A, cooldownHours: 0 }],
  ['A6 ATR0.5+sp0.8+mult2/4层', { ...A, spacingAtrMult: 0.8, multiplier: 2, maxLevels: 4 }],
  ['A7 ATR0.5+sp0.6+mult2/4层', { ...A, spacingAtrMult: 0.6, multiplier: 2, maxLevels: 4 }],
  ['A8 TP0.7+sp0.6+mult2/4层+cd0', { ...BASE, takeProfitPct: 0, tpAtrMult: 0.7, spacingAtrMult: 0.6, multiplier: 2, maxLevels: 4, cooldownHours: 0 }],
];

function cols() {
  return [
    { label: '候选', w: 30, get: (r) => r.name },
    { label: '固定净U', w: 10, get: (r) => r.fixed.netPnlUsd },
    { label: '固定回撤%', w: 10, get: (r) => r.fixed.maxDDPct },
    { label: '固定占用max%', w: 12, get: (r) => r.fixedOcc.maxPct },
    { label: '实盘净U', w: 10, get: (r) => r.live.netPnlUsd },
    { label: '实盘回撤%', w: 10, get: (r) => r.live.maxDDPct },
    { label: '实盘占用max%', w: 12, get: (r) => r.liveOcc.maxPct },
    { label: '超45%占比', w: 10, get: (r) => r.liveOcc.aboveCapSharePct },
    { label: '实盘笔数', w: 9, get: (r) => r.live.trades },
    { label: '实盘期望bps', w: 12, get: (r) => r.live.expectancyBps },
    { label: '实盘PF', w: 8, get: (r) => r.live.profitFactor },
  ];
}

function fmt(rows, cs) {
  const out = [cs.map((c) => String(c.label).padStart(c.w)).join('')];
  for (const r of rows) out.push(cs.map((c) => String(c.get(r)).padStart(c.w)).join(''));
  return out.join('\n');
}

async function main() {
  const days = Number(arg('days', 350));
  const equity0 = Number(arg('equity', 10000));
  const feeBps = Number(arg('fee', 8));
  const folds = Number(arg('folds', 5));
  const outFile = arg('out', path.join(DATA_DIR, `profit-check-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`));

  console.log(`\n=== 实盘可行性复核 · ${days} 天 · 成本 ${feeBps}bps 往返 · 账户 $${equity0} ===`);
  const data = await sw1.loadData(days, true, console.log);
  const bars = Math.min(...data.map((d) => d.candles.length));
  const realDays = round(bars / 24, 1);
  const winS = Math.max(...data.map((d) => d.candles[0].ts));
  const winE = Math.min(...data.map((d) => d.candles[d.candles.length - 1].ts));
  store.ensureDir(DATA_DIR);

  const results = [];
  for (const [name, geom] of CANDS) {
    const fixedPol = { ...geom, ...CAP, sizingMode: 'fixed' };
    const livePol = liveOf(geom);
    const rf = bt.simulate({ data, policy: fixedPol, equity0, feeBps, fundingIncluded: true, trackOccupancy: true });
    const rl = bt.simulate({ data, policy: livePol, equity0, feeBps, fundingIncluded: true, trackOccupancy: true });
    const slip = bt.simulate({ data, policy: livePol, equity0, feeBps: feeBps, fundingIncluded: true, slipBps: 5, trackOccupancy: true });
    const wf = bt.walkForward({ data, policy: livePol, equity0, feeBps, fundingIncluded: true, folds });
    const small = bt.simulate({ data, policy: livePol, equity0: 113, feeBps, fundingIncluded: true });
    const rec = {
      name, policyGeom: geom, policyLive: livePol,
      fixed: sw1.metrics(rf, realDays, equity0, feeBps), fixedOcc: rf.occupancy,
      live: sw1.metrics(rl, realDays, equity0, feeBps), liveOcc: rl.occupancy,
      liveSlip5: sw1.metrics(slip, realDays, equity0, feeBps),
      live5fold: { ...wf.oos, perFold: wf.folds.map((f) => ({ fold: f.fold, from: f.from, to: f.to, trades: f.summary.trades, expectancyBps: round(Number(f.summary.expectancyPct) * 100, 4), profitFactor: f.summary.profitFactor, maxDDPct: f.summary.maxDrawdownPct })) },
      smallAccount: { equity: 113, ...sw1.metrics(small, realDays, 113, feeBps) },
      liveReasons: sw2.byReason(rl),
      livePerSymbol: rl.perSymbol,
      liveCounters: rl.summary.counters,
    };
    results.push(rec);
    console.log(`  · ${name.padEnd(30)} 固定 ${String(rec.fixed.netPnlUsd).padStart(10)}U/${String(rec.fixed.maxDDPct).padStart(6)}% ‖ 实盘 ${String(rec.live.netPnlUsd).padStart(10)}U/${String(rec.live.maxDDPct).padStart(6)}% 占用max ${String(rec.liveOcc.maxPct).padStart(6)}% | 113U账户 ${String(rec.smallAccount.trades).padStart(5)}笔 期望 ${String(rec.smallAccount.expectancyBps).padStart(7)}bps`);
  }

  const report = {
    ok: true, generatedAt: new Date().toISOString(),
    note: '第二轮候选的实盘可行性复核：固定口径 vs 实盘风险仓位口径（含占用上限硬拦）/滑点/分折/小账户',
    days: realDays, equity0, feeBps, folds, symbols: data.map((d) => d.instId),
    livePolicyBase: liveOf(A),
    results,
    assumptions: [
      '实盘口径 = sizingMode:risk + basketRiskBudgetPct 4 + maxTotalOccupancyPct 45 + riskK 1.2 + deathAtrMult 6 + maxBasketRiskPct 3 + maxBaskets 5 + dailyLossPct 4',
      '占用统计按每根 K 的无实时保证金/权益；超 45% 占比 = 越限 K 线比例',
      '113U 小账户用于暴露最小下单张数（minSz/lotSz）带来的摩擦',
      '固定口径仅用于对照，不代表实盘',
    ],
  };
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
  report.outFile = outFile;

  console.log('\n' + '='.repeat(150));
  console.log('【固定口径 vs 实盘口径（含占用上限）】');
  console.log(fmt(results, cols()));

  const c2 = [
    { label: '候选', w: 30, get: (r) => r.name },
    { label: '实盘+slip5净U', w: 13, get: (r) => r.liveSlip5.netPnlUsd },
    { label: '5折OOSbps', w: 11, get: (r) => round(Number(r.live5fold.expectancyPct) * 100, 4) },
    { label: '正收益折', w: 9, get: (r) => `${r.live5fold.foldsPositive}/${folds}` },
    { label: '最差折回撤%', w: 12, get: (r) => r.live5fold.worstFoldDDPct },
    { label: '113U笔数', w: 10, get: (r) => r.smallAccount.trades },
    { label: '113U期望bps', w: 12, get: (r) => r.smallAccount.expectancyBps },
    { label: '113U净U', w: 10, get: (r) => r.smallAccount.netPnlUsd },
    { label: '113U回撤%', w: 10, get: (r) => r.smallAccount.maxDDPct },
    { label: '拒开(仓位)', w: 10, get: (r) => r.liveCounters.sizingRejected },
    { label: '拒开(占用)', w: 10, get: (r) => r.liveCounters.occupancyRejected },
  ];
  console.log('\n' + '='.repeat(150));
  console.log('【滑点压力 / 分折 / 小账户摩擦 / 拒开原因】');
  console.log(fmt(results, c2));

  const best = results.slice().sort((a, b) => b.live.netPnlUsd - a.live.netPnlUsd)[0];
  console.log(`\n实盘口径净利最优：${best.name}（${best.live.netPnlUsd}U · 回撤 ${best.live.maxDDPct}%）`);
  console.log('  按平仓原因：');
  for (const b of best.liveReasons) console.log(`    ${String(b.reason).padEnd(12)} ${String(b.n).padStart(5)} 笔 · 净 ${String(b.netUsd).padStart(10)}U · 单笔均 ${b.avgUsd}U`);
  console.log('  逐品种（实盘口径）：');
  for (const s of best.livePerSymbol) console.log(`    ${s.instId.padEnd(17)} ${String(s.trades).padStart(5)} 笔 · 胜率 ${String(s.winRate).padStart(6)}% · 期望 ${String(s.expectancyPct).padStart(8)}% · 最多层 ${s.maxLevels} · 回撤 ${s.maxDDPct}%`);
  console.log(`\n报告：${outFile}`);
  return report;
}

if (require.main === module) main().catch((e) => { console.error('复核失败：', e && e.stack || e); process.exit(1); });
module.exports = { CANDS, liveOf, BASE, A };
