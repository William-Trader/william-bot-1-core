/*!
 * scripts/martin-profit-pick.js - william-bot-1-core key backtest/optimize logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-FA8BDECF
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
#!/usr/bin/env node
/**
 * scripts/martin-profit-pick.js —— 决赛圈选型：最佳「赚钱效率」
 *
 * 效率定义（透明）：
 *   主指标 edgePerDD = 单笔期望(bps) ÷ |最大回撤%|      —— 每承担 1% 回撤能换到多少边际收益
 *   参考指标 riskEff  = 收益率% ÷ |最大回撤%|            —— 复利放大，仅参考
 *   可行门槛：占用从未超权益（>100% 占比 = 0）· 爆仓 0 · 5 折全为正 · 期望 > 0
 * 两个口径都跑：20% 总风险（服务器放宽规则）与 12% 总风险（严格规则），便于按 B 侧规则落地。
 *
 * 用法：PROXY_URL=http://127.0.0.1:17890 node scripts/martin-profit-pick.js [--days 350] [--fee 8] [--folds 5]
 */
'use strict';

if (!process.env.PROXY_URL && !process.env.HTTPS_PROXY) process.env.PROXY_URL = 'http://127.0.0.1:17890';

const fs = require('fs');
const path = require('path');
const store = require('../modules/store');
const bt = require('./martin-backtest');
const sw1 = require('./martin-profit-sweep');

const DATA_DIR = path.join(__dirname, '..', 'data');
const round = (v, n = 4) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(n)) : null);
const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};

/** 第三轮推荐几何（保持不变） */
const GEOM = { ...bt.BASE_POLICY, multiplier: 2, maxLevels: 4, spacingAtrMult: 0.8, takeProfitPct: 0.8 };
const live = (patch) => ({
  ...GEOM, sizingMode: 'risk', basketRiskBudgetPct: 4, maxTotalOccupancyPct: 45, riskK: 1.2,
  deathAtrMult: 6, maxBasketRiskPct: 3, maxBaskets: 5, dailyLossPct: 4, ...patch,
});
/** 现在线上（旧几何 + 旧风控），做基准对照 */
const LIVE_NOW = { ...bt.BASE_POLICY, sizingMode: 'risk', basketRiskBudgetPct: 4, maxTotalOccupancyPct: 45, riskK: 1.2, deathAtrMult: 6, maxBasketRiskPct: 3, maxBaskets: 5, dailyLossPct: 4 };

const FINALS = [
  ['线上现状（1.5/6层·3x·4%/5篮·兜底3%）', LIVE_NOW],
  ['② 3x·预算6%/2篮·兜底3%（=12%）', live({ basketRiskBudgetPct: 6, maxBaskets: 2 })],
  ['③ 3x·预算5%/2篮·兜底2%（=10%）', live({ basketRiskBudgetPct: 5, maxBaskets: 2, maxBasketRiskPct: 2 })],
  ['④ 3x·预算5%/4篮·兜底3%（=20%）', live({ basketRiskBudgetPct: 5, maxBaskets: 4 })],
  ['⑤ 5x·预算6%/2篮·兜底3%（=12%）', live({ leverage: 5, basketRiskBudgetPct: 6, maxBaskets: 2 })],
  ['⑥ 5x·预算6%/2篮·兜底2%（=12%）', live({ leverage: 5, basketRiskBudgetPct: 6, maxBaskets: 2, maxBasketRiskPct: 2 })],
  ['⑦ 5x·预算8%/2篮·兜底2%（=16%）', live({ leverage: 5, basketRiskBudgetPct: 8, maxBaskets: 2, maxBasketRiskPct: 2 })],
  ['⑧ 5x·预算8%/2篮·兜底3%（=16%）', live({ leverage: 5, basketRiskBudgetPct: 8, maxBaskets: 2 })],
  ['⑨ 5x·占用60%·预算6%/3篮·兜底2%', live({ leverage: 5, maxTotalOccupancyPct: 60, basketRiskBudgetPct: 6, maxBaskets: 3, maxBasketRiskPct: 2 })],
];

async function main() {
  const days = Number(arg('days', 350));
  const equity0 = Number(arg('equity', 10000));
  const feeBps = Number(arg('fee', 8));
  const folds = Number(arg('folds', 5));
  const outFile = arg('out', path.join(DATA_DIR, `profit-pick-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`));

  console.log(`\n=== 决赛圈选型 · ${days} 天 · ${feeBps}bps · 账户 $${equity0} · ${folds} 折 ===`);
  const data = await sw1.loadData(days, true, console.log);
  const bars = Math.min(...data.map((d) => d.candles.length));
  const realDays = round(bars / 24, 1);
  store.ensureDir(DATA_DIR);

  const rows = [];
  for (const [name, pol] of FINALS) {
    const r = bt.simulate({ data, policy: pol, equity0, feeBps, fundingIncluded: true, trackOccupancy: true });
    const wf = bt.walkForward({ data, policy: pol, equity0, feeBps, fundingIncluded: true, folds });
    const slip5 = bt.simulate({ data, policy: pol, equity0, feeBps, fundingIncluded: true, slipBps: 5 });
    const small = bt.simulate({ data, policy: pol, equity0: 113, feeBps, fundingIncluded: true });
    const m = sw1.metrics(r, realDays, equity0, feeBps);
    const ms = sw1.metrics(slip5, realDays, equity0, feeBps);
    const mm = sw1.metrics(small, realDays, 113, feeBps);
    const oosBps = round(Number(wf.oos.expectancyPct) * 100, 4);
    const edgePerDD = m.maxDDPct ? round(m.expectancyBps / Math.abs(m.maxDDPct), 4) : null;
    const rec = {
      name, policy: pol,
      expectancyBps: m.expectancyBps, maxDDPct: m.maxDDPct, netPnlUsd: m.netPnlUsd, returnPct: m.returnPct,
      edgePerDD, riskEff: m.riskEff, profitFactor: m.profitFactor, tradesPerDay: m.tradesPerDay,
      stopLoss: m.stopLoss, liquidation: m.liquidation,
      oosBps, oosPositive: wf.oos.foldsPositive, worstFoldDD: wf.oos.worstFoldDDPct,
      slip5NetUsd: ms.netPnlUsd, slip5Bps: ms.expectancyBps,
      occMean: r.occupancy.meanPct, occMax: r.occupancy.maxPct, occAbove100: r.occupancy.above100SharePct,
      feasible: r.occupancy.feasible && m.liquidation === 0,
      smallTrades: mm.trades, smallBps: mm.expectancyBps, smallNet: mm.netPnlUsd,
      occupancyRejected: r.summary.counters.occupancyRejected, sizingRejected: r.summary.counters.sizingRejected,
    };
    rows.push(rec);
    console.log(`  · ${name.padEnd(34)} 期望 ${String(m.expectancyBps).padStart(5)}bps · 回撤 ${String(m.maxDDPct).padStart(6)}% · 效率 ${String(edgePerDD).padStart(5)} · 净 ${String(m.netPnlUsd).padStart(9)}U · PF ${String(m.profitFactor).padStart(5)} · OOS ${String(oosBps).padStart(5)} ${wf.oos.foldsPositive}/${folds} · 占用峰 ${String(r.occupancy.maxPct).padStart(5)}% · 113U ${String(mm.expectancyBps).padStart(5)}bps`);
  }

  const report = {
    ok: true, generatedAt: new Date().toISOString(),
    metric: 'edgePerDD = 单笔期望bps ÷ |最大回撤%|（主）· riskEff = 收益率÷回撤（参考，受复利放大）',
    days: realDays, equity0, feeBps, folds, symbols: data.map((d) => d.instId), geometry: { multiplier: 2, maxLevels: 4, spacingAtrMult: 0.8, takeProfitPct: 0.8 },
    rows,
  };
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
  report.outFile = outFile;

  const cols = [
    { label: '档位', w: 34, get: (r) => r.name },
    { label: '期望bps', w: 9, get: (r) => r.expectancyBps },
    { label: '回撤%', w: 8, get: (r) => r.maxDDPct },
    { label: '效率(期望/DD)', w: 13, get: (r) => r.edgePerDD },
    { label: '净U', w: 10, get: (r) => r.netPnlUsd },
    { label: 'PF', w: 6, get: (r) => r.profitFactor },
    { label: '止损/爆', w: 9, get: (r) => `${r.stopLoss}/${r.liquidation}` },
    { label: 'OOSbps', w: 8, get: (r) => r.oosBps },
    { label: '正收益折', w: 9, get: (r) => `${r.oosPositive}/${folds}` },
    { label: '最差折DD%', w: 10, get: (r) => r.worstFoldDD },
    { label: 'slip5期望bps', w: 12, get: (r) => r.slip5Bps },
    { label: '占用峰值%', w: 10, get: (r) => r.occMax },
    { label: '>100%', w: 7, get: (r) => r.occAbove100 },
    { label: '可行', w: 6, get: (r) => (r.feasible ? '是' : '否') },
    { label: '113U期望bps', w: 12, get: (r) => r.smallBps },
  ];
  console.log('\n' + '='.repeat(170));
  const out = [cols.map((c) => String(c.label).padStart(c.w)).join('')];
  for (const r of rows) out.push(cols.map((c) => String(c.get(r)).padStart(c.w)).join(''));
  console.log(out.join('\n'));

  const ranked = rows.filter((r) => r.feasible && r.oosPositive === folds && r.expectancyBps > 0).sort((a, b) => b.edgePerDD - a.edgePerDD);
  console.log('\n' + '='.repeat(170));
  console.log('【按赚钱效率排序（已过滤：可行 + 5 折全正 + 期望>0）】');
  ranked.forEach((r, i) => console.log(`  ${i + 1}. ${r.name}  →  效率 ${r.edgePerDD}（期望 ${r.expectancyBps}bps ÷ 回撤 ${Math.abs(r.maxDDPct)}%）· OOS ${r.oosBps}bps · 占用峰 ${r.occMax}% · 113U ${r.smallBps}bps`));
  console.log(`\n报告：${outFile}`);
  return report;
}

if (require.main === module) main().catch((e) => { console.error('选型失败：', e && e.stack || e); process.exit(1); });
module.exports = { FINALS, GEOM, live };
