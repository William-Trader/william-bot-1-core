/*!
 * scripts/martin-live-optimize.js - william-bot-1-core key backtest/optimize logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-BE6CBEA9
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
#!/usr/bin/env node
/**
 * scripts/martin-live-optimize.js —— 实盘参数（101 线上 policy）+ 真实成本下的盈利参数化扫描
 *
 * 为什么单独一支：旧基线的 26 项参数漂移（takeProfitPct 0.8→0、hardStopPct 4→3、maxLevels 6→5、
 * maxBaskets 3→5、dailyLossPct 6→5、firstMarginPct 1→0.6、tpOrderType=limit、basketRiskBudgetPct=4、
 * riskK=1.2、maxTotalOccupancyPct=45、tpAtrMult=0.5、sizingMode=risk…）让旧结论不可迁移；
 * 且实测往返成本 10.02bps（手续费 9.32 + 滑点影响 0.71，单边滑点 5.46bps）比旧默认 8bps/0 高约 2bps/笔。
 * 所以本脚本：**一次载数、多组回放**（复用 martin-backtest.js 的 simulate/walkForward），
 * 全部以「实盘 policy」为基线、以真实成本为口径。
 *
 * 扫什么（对应实盘暴露的两个现象）
 *   A. 「开一层就止盈」：实盘 24 篮平均 1.33 层 / 满层率 0% / 平均持仓 0.71h（回测 3.52h）
 *      → tpAtrMult × spacingAtrMult 网格（止盈够不够远 / 加仓能不能被触发）
 *   B. 「入场频率偏高」：薄利高频被成本吃掉 → entryZMin（filter 模式）门槛
 *   C. 成本敏感度：fee 8 / 10.02 / 12 bps 下期望怎么变（这套策略每笔能吃多少成本）
 *   D. 最优组合的 5 折样本外（OOS 转负必直说）
 *
 * 用法
 *   PROXY_URL=http://127.0.0.1:17890 node scripts/martin-live-optimize.js \
 *     [--days 350] [--equity 10000] [--fee 10.02] [--slip 5] [--folds 5]
 *     [--policy data/live-policy-YYYYMMDD.json] [--out data/live-opt-YYYYMMDD.json]
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
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};

function loadPolicy(p) {
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  return j && j.policy ? j.policy : j;
}

/** 一组的全部指标（口径全部显式：成本来自 summary.costDecomposition） */
function metrics(r, days, equity0) {
  const s = r.summary;
  const tr = r.trades || [];
  const lvHist = {};
  for (const t of tr) lvHist[t.levels] = (lvHist[t.levels] || 0) + 1;
  const reasonHist = {};
  for (const t of tr) reasonHist[t.reason] = (reasonHist[t.reason] || 0) + 1;
  const c = s.costDecomposition || null;
  return {
    trades: s.trades,
    tradesPerDay: round(s.trades / days, 3),
    winRate: s.winRate,
    expectancyUsd: s.expectancyUsd,
    expectancyBps: round(Number(s.expectancyPct) * 100, 4),
    profitFactor: s.profitFactor,
    maxDDPct: s.maxDrawdownPct,
    avgLevels: s.avgLevelsUsed,
    fullLevelRate: s.level6Rate,
    avgHours: s.avgHours,
    maxHours: s.maxHours,
    stopLoss: s.stopLossCount,
    liquidation: s.liquidationCount,
    timeStop: s.timeStopCount,
    takeProfit: s.takeProfitCount,
    trendFlip: reasonHist.trend_flip || 0,
    eodClose: reasonHist.eod_close || 0,
    netPnlUsd: s.netPnlUsd,
    returnPct: s.returnPct,
    endEquity: s.endEquity,
    feesUsd: c ? c.feesUsd : round(tr.reduce((a, t) => a + t.feesUsd, 0), 4),
    slipUsd: c ? c.slipUsd : null,
    fundingUsd: c ? c.fundingUsd : round(tr.reduce((a, t) => a + t.fundingUsd, 0), 4),
    totalCostUsd: c ? c.totalCostUsd : null,
    feesBpsPerTrade: c ? c.feesBpsOfEquityPerTrade : null,
    slipBpsPerTrade: c ? c.slipBpsOfEquityPerTrade : null,
    fundingBpsPerTrade: c ? c.fundingBpsOfEquityPerTrade : null,
    totalCostBpsPerTrade: c ? c.totalCostBpsOfEquityPerTrade : null,
    costShareOfGrossPct: c ? c.totalCostShareOfGrossPct : null,
    levelsHist: lvHist,
    openingsRejected: s.counters ? s.counters.opensRejected : null,
    sizingRejected: s.counters ? s.counters.sizingRejected : null,
    occupancyRejected: s.counters ? s.counters.occupancyRejected : null,
    addBlocked: s.counters ? s.counters.addBlocked : null,
    matcherOk: true,
  };
}

const TBL = (rows, cols) => [
  cols.map((c) => String(c.label).padStart(c.w)).join(''),
  ...rows.map((r) => cols.map((c) => String(c.get(r)).padStart(c.w)).join('')),
].join('\n');

const mdTbl = (headers, rows) => [
  `| ${headers.join(' | ')} |`,
  `|${headers.map(() => '---').join('|')}|`,
  ...rows.map((r) => `| ${r.join(' | ')} |`),
].join('\n');

/** 把扫描结果写成 Markdown（原始数字表格，可追溯口径） */
function buildMd(out) {
  const c = out.costBasis;
  const b = out.baseline;
  const L = [];
  L.push(`# 实盘参数 · 真实成本 · 回测基线与盈利参数化（${out.generatedAt.slice(0, 10)}）`);
  L.push('');
  L.push(`- 工作目录：\`~/openclaw资产库/william-bot-1-core\``);
  L.push(`- 实盘 policy 来源：\`${out.policySource}\`（101 \`/opt/wb-core\` getPolicy().policy，35 键）`);
  L.push(`- 数据窗口（公共段）：${out.dataWindow.from} → ${out.dataWindow.to}，约 ${out.days} 天 / ${out.bars} 根 1H，标的 ${out.symbols.length} 个`);
  L.push(`- 成本口径（显式）：手续费 **${c.feeBpsRoundTrip}bps 往返**（每次成交 ${round(c.feeBpsRoundTrip / 2, 3)}bps）· 滑点 **${c.slipBpsPerSide}bps/单边** · 资金费 OKX 真实历史`);
  L.push(`- 成本依据：${c.evidence}`);
  L.push(`- 初始权益 $${out.equity0}（sizingMode=risk：首层由风险预算反解，bps/百分比口径与权益规模近似无关）`);
  L.push('');
  L.push('## 任务 A：实盘参数可信基线（真实成本）');
  L.push('');
  L.push(mdTbl(['指标', '值'], [
    ['笔数', b.trades], ['日均笔数', b.tradesPerDay], ['胜率%', b.winRate],
    ['单笔期望 USD', b.expectancyUsd], ['单笔期望 bps', b.expectancyBps],
    ['PF', b.profitFactor], ['最大回撤%', b.maxDDPct],
    ['平均层数', b.avgLevels], ['满层率%', b.fullLevelRate], ['平均持仓 h', b.avgHours], ['最长持仓 h', b.maxHours],
    ['止盈/止损/时间止损/趋势反转/爆仓/收尾', `${b.takeProfit}/${b.stopLoss}/${b.timeStop}/${b.trendFlip}/${b.liquidation}/${b.eodClose}`],
    ['净盈亏 USD', b.netPnlUsd], ['收益率%', b.returnPct],
  ]));
  L.push('');
  L.push('### 成本拆解（USD / 每笔占权益 bps / 占无成本毛利 %）');
  L.push('');
  L.push(mdTbl(['成本项', 'USD', '每笔 bps', '占毛利 %'], [
    ['手续费', b.feesUsd, b.feesBpsPerTrade, b.costShareOfGrossPct === null ? '-' : round((b.feesUsd / (b.feesUsd + b.slipUsd + b.fundingUsd)) * b.costShareOfGrossPct, 2)],
    ['滑点', b.slipUsd, b.slipBpsPerTrade, b.costShareOfGrossPct === null ? '-' : round((b.slipUsd / (b.feesUsd + b.slipUsd + b.fundingUsd)) * b.costShareOfGrossPct, 2)],
    ['资金费', b.fundingUsd, b.fundingBpsPerTrade, b.costShareOfGrossPct === null ? '-' : round((b.fundingUsd / (b.feesUsd + b.slipUsd + b.fundingUsd)) * b.costShareOfGrossPct, 2)],
    ['合计', b.totalCostUsd, b.totalCostBpsPerTrade, b.costShareOfGrossPct],
  ]));
  L.push('');
  L.push('### 5 折 walk-forward（样本外，逐折独立重放）');
  L.push('');
  L.push(mdTbl(['折', '区间', '笔数', '期望 USD', '胜率%', 'PF', '回撤%'], out.oosLive.perFold.map((f) => [f.fold, `${f.from} → ${f.to}`, f.trades, f.expectancyUsd, f.winRate, f.profitFactor, f.maxDrawdownPct])));
  L.push('');
  L.push(`OOS 汇总：期望 **${out.oosLive.oos.expectancyUsd} USD/笔（${round(Number(out.oosLive.oos.expectancyPct) * 100, 4)}bps）** · 胜率 ${out.oosLive.oos.winRate}% · PF ${out.oosLive.oos.profitFactor} · 正收益折 **${out.oosLive.oos.foldsPositive}/${out.oosLive.oos.folds}** · 最差折回撤 ${out.oosLive.oos.worstFoldDDPct}%`);
  L.push('');
  L.push('## 任务 B：盈利参数化（实盘口径 + 真实成本）');
  L.push('');
  L.push('### B1 网格 tpAtrMult × spacingAtrMult');
  L.push('');
  L.push(mdTbl(['tpAtrMult', 'spacingAtrMult', '笔数', '胜率%', '期望 bps', 'PF', '回撤%', '平均层数', '满层率%', '平均持仓 h', '成本占毛利%'], out.grid.map((g) => [g.tpAtrMult, g.spacingAtrMult, g.m.trades, g.m.winRate, g.m.expectancyBps, g.m.profitFactor, g.m.maxDDPct, g.m.avgLevels, g.m.fullLevelRate, g.m.avgHours, g.m.costShareOfGrossPct])));
  L.push('');
  L.push('### B2 入场门槛 entryZMin（filter 模式）');
  L.push('');
  L.push(mdTbl(['entryZMin', '笔数', '日均笔数', '胜率%', '期望 bps', 'PF', '回撤%', '成本占毛利%'], out.zsets.map((z) => [z.entryZMin, z.m.trades, z.m.tradesPerDay, z.m.winRate, z.m.expectancyBps, z.m.profitFactor, z.m.maxDDPct, z.m.costShareOfGrossPct])));
  L.push('');
  L.push('### B3 成本敏感度（slip 固定，只变手续费档）');
  L.push('');
  L.push(mdTbl(['对象', 'fee 往返 bps', '笔数', '期望 bps', 'PF', '净盈亏 USD', '成本占毛利%'], out.costSensitivity.map((x) => [x.which, x.feeBps, x.m.trades, x.m.expectancyBps, x.m.profitFactor, x.m.netPnlUsd, x.m.costShareOfGrossPct])));
  L.push('');
  L.push('### B4 网格最优的 5 折样本外');
  L.push('');
  L.push(mdTbl(['折', '区间', '笔数', '期望 USD', '胜率%', 'PF', '回撤%'], out.oosBest.perFold.map((f) => [f.fold, `${f.from} → ${f.to}`, f.trades, f.expectancyUsd, f.winRate, f.profitFactor, f.maxDrawdownPct])));
  L.push('');
  L.push(`OOS 汇总：期望 **${out.oosBest.oos.expectancyUsd} USD/笔（${round(Number(out.oosBest.oos.expectancyPct) * 100, 4)}bps）** · PF ${out.oosBest.oos.profitFactor} · 正收益折 **${out.oosBest.oos.foldsPositive}/${out.oosBest.oos.folds}** · 最差折回撤 ${out.oosBest.oos.worstFoldDDPct}%`);
  L.push('');
  L.push(`最优网格：tpAtrMult=${out.best.tpAtrMult} / spacingAtrMult=${out.best.spacingAtrMult}（按单笔期望 bps 排序）`);
  L.push('');
  L.push('### B5 小权益复核（实盘账户口径）');
  L.push('');
  L.push(mdTbl(['对象', '权益', '笔数', '期望 bps', 'PF', '被拦(尺寸/占用)', '净盈亏 USD'], out.smallEquity.map((x) => [x.label, x.equity, x.m.trades, x.m.expectancyBps, x.m.profitFactor, `${x.m.openingsRejected}(${x.m.sizingRejected}/${x.m.occupancyRejected})`, x.m.netPnlUsd])));
  L.push('');
  L.push('## 假设与限制');
  L.push('');
  for (const a of out.assumptions) L.push(`- ${a}`);
  L.push('');
  return L.join('\n');
}

async function main() {
  const days = Number(arg('days', 350));
  const equity0 = Number(arg('equity', 10000));
  const feeBps = Number(arg('fee', 10.02));
  const slipBps = Number(arg('slip', 5));
  const folds = Number(arg('folds', 5));
  const policyPath = arg('policy', path.join(DATA_DIR, 'live-policy-20260922.json'));
  const outFile = arg('out', path.join(DATA_DIR, `live-opt-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`));

  const live = { ...bt.BASE_POLICY, ...loadPolicy(policyPath) };
  console.log(`\n=== 实盘参数 · 真实成本参数化 · ${days} 天 · 权益 $${equity0} ===`);
  console.log(`policy: ${policyPath}`);
  console.log(`成本口径：fee ${feeBps}bps 往返 + slip ${slipBps}bps/单边 + OKX 真实资金费\n`);

  const data = await sw1.loadData(days, true, (s) => console.log(s));
  const bars = Math.min(...data.map((d) => d.candles.length));
  const realDays = round(bars / 24, 1);
  const winFrom = new Date(Math.max(...data.map((d) => d.candles[0].ts))).toISOString().slice(0, 16);
  const winTo = new Date(Math.min(...data.map((d) => d.candles[d.candles.length - 1].ts))).toISOString().slice(0, 16);
  console.log(`数据窗口（公共段）：${winFrom} → ${winTo}，约 ${realDays} 天 / ${bars} 根 1H，标的 ${data.length} 个\n`);

  const run = (policy, fee = feeBps, slip = slipBps) =>
    bt.simulate({ data, policy, equity0, feeBps: fee, fundingIncluded: true, slipBps: slip });

  /* ── 0. 基线：实盘参数 + 真实成本（也是 Task A 的复算） ── */
  console.log('[0] 基线（实盘 policy + 真实成本）…');
  const baseRun = run(live);
  const baseM = metrics(baseRun, realDays, equity0);
  console.log(`  笔数 ${baseM.trades} · 胜率 ${baseM.winRate}% · 期望 ${baseM.expectancyUsd} USD/笔 (${baseM.expectancyBps}bps) · PF ${baseM.profitFactor} · 回撤 ${baseM.maxDDPct}%`);
  console.log(`  平均层数 ${baseM.avgLevels} · 满层率 ${baseM.fullLevelRate}% · 平均持仓 ${baseM.avgHours}h · 成本占毛利 ${baseM.costShareOfGrossPct}%\n`);

  /* ── 1. 网格：tpAtrMult × spacingAtrMult ── */
  console.log('[1] 网格 tpAtrMult × spacingAtrMult（实盘 policy 其余项不变 + 真实成本）…');
  const grid = [];
  for (const tp of [0.5, 0.7, 1.0, 1.4]) {
    for (const sp of [1.0, 1.5, 2.0]) {
      const pol = { ...live, takeProfitPct: 0, tpAtrMult: tp, spacingAtrMult: sp };
      const r = run(pol);
      const m = metrics(r, realDays, equity0);
      grid.push({ tpAtrMult: tp, spacingAtrMult: sp, policy: pol, m });
      console.log(`  tp ${tp} × sp ${sp}: 笔 ${String(m.trades).padStart(4)} · 期望 ${String(m.expectancyBps).padStart(8)}bps · 胜率 ${String(m.winRate).padStart(6)}% · PF ${String(m.profitFactor).padStart(6)} · 回撤 ${String(m.maxDDPct).padStart(7)}% · 层 ${m.avgLevels} · 持仓 ${m.avgHours}h · 成本占毛利 ${m.costShareOfGrossPct}%`);
    }
  }

  /* ── 2. entryZMin（filter 模式）── */
  console.log('\n[2] entryZMin 入场门槛（filter 模式；实盘 policy 其余项不变）…');
  const zsets = [0, 0.5, 1.0].map((z) => {
    const pol = z > 0 ? { ...live, entryZMin: z, entryZWin: 20, entryZMode: 'filter' } : { ...live };
    const r = run(pol);
    const m = metrics(r, realDays, equity0);
    console.log(`  z≥${z}: 笔 ${String(m.trades).padStart(4)} · 期望 ${String(m.expectancyBps).padStart(8)}bps · 胜率 ${String(m.winRate).padStart(6)}% · PF ${String(m.profitFactor).padStart(6)} · 回撤 ${String(m.maxDDPct).padStart(7)}% · 日均 ${m.tradesPerDay} · 成本占毛利 ${m.costShareOfGrossPct}%`);
    return { entryZMin: z, policy: pol, m };
  });

  /* ── 3. 成本敏感度（基线 + 网格最优；含口径边界行：只加手续费 / 只加滑点）── */
  const bestGrid = [...grid].sort((a, b) => (b.m.expectancyBps ?? -1e9) - (a.m.expectancyBps ?? -1e9))[0];
  console.log(`\n[3] 成本敏感度（slip ${slipBps}；另含只加手续费 / 只加滑点 的边界行）…`);
  const costSens = [];
  const push = (which, pol, f, s) => {
    const m = metrics(run(pol, f, s), realDays, equity0);
    costSens.push({ which, feeBps: f, slipBps: s, m });
    console.log(`  ${which.padEnd(30)} fee ${String(f).padStart(5)} / slip ${String(s).padStart(4)}: 期望 ${String(m.expectancyBps).padStart(8)}bps · PF ${String(m.profitFactor).padStart(6)} · 净利 ${String(m.netPnlUsd).padStart(10)}U · 成本/毛 ${m.costShareOfGrossPct}% · 每笔成本 ${m.totalCostBpsPerTrade}bps`);
  };
  for (const f of [8, 10.02, 12]) push('实盘基线', live, f, slipBps);
  push('实盘基线（实测手续费口径）', live, 9.32, slipBps);
  push('实盘基线（不计滑点）', live, 10.02, 0);
  push('实盘基线（旧默认 8/0）', live, 8, 0);
  for (const f of [8, 10.02, 12]) push(`网格最优(tp${bestGrid.tpAtrMult}/sp${bestGrid.spacingAtrMult})`, bestGrid.policy, f, slipBps);

  /* ── 4. 最优组合的 5 折样本外 ── */
  console.log(`\n[4] 5 折 walk-forward（网格最优 tp${bestGrid.tpAtrMult}/sp${bestGrid.spacingAtrMult} + 真实成本）…`);
  const wfGrid = bt.walkForward({ data, policy: bestGrid.policy, equity0, feeBps, fundingIncluded: true, slipBps, folds });
  const perFoldGrid = wfGrid.folds.map((x) => ({ fold: x.fold, from: x.from, to: x.to, days: x.days, ...x.summary }));
  for (const f of perFoldGrid) console.log(`  折${f.fold} ${f.from} → ${f.to}: 笔 ${String(f.trades).padStart(4)} · 期望 ${String(f.expectancyUsd).padStart(9)}U (${round(Number(f.expectancyPct) * 100, 2)}bps) · PF ${f.profitFactor} · 回撤 ${f.maxDrawdownPct}%`);
  console.log(`  OOS：期望 ${wfGrid.oos.expectancyUsd}U/笔 (${round(Number(wfGrid.oos.expectancyPct) * 100, 4)}bps) · 正收益折 ${wfGrid.oos.foldsPositive}/${wfGrid.oos.folds} · 最差折回撤 ${wfGrid.oos.worstFoldDDPct}%`);

  console.log('\n[5] 5 折 walk-forward（实盘基线，做对照）…');
  const wfLive = bt.walkForward({ data, policy: live, equity0, feeBps, fundingIncluded: true, slipBps, folds });
  const perFoldLive = wfLive.folds.map((x) => ({ fold: x.fold, from: x.from, to: x.to, days: x.days, ...x.summary }));
  for (const f of perFoldLive) console.log(`  折${f.fold} ${f.from} → ${f.to}: 笔 ${String(f.trades).padStart(4)} · 期望 ${String(f.expectancyUsd).padStart(9)}U (${round(Number(f.expectancyPct) * 100, 2)}bps) · PF ${f.profitFactor} · 回撤 ${f.maxDrawdownPct}%`);
  console.log(`  OOS：期望 ${wfLive.oos.expectancyUsd}U/笔 (${round(Number(wfLive.oos.expectancyPct) * 100, 4)}bps) · 正收益折 ${wfLive.oos.foldsPositive}/${wfLive.oos.folds} · 最差折回撤 ${wfLive.oos.worstFoldDDPct}%`);

  /* ── 6. 小权益复核（实盘账户口径 ~600U：minSz 地板效应）── */
  const smallEq = Number(arg('smallEquity', 600));
  console.log(`\n[6] 小权益复核 $${smallEq}（实盘账户口径；risk 模式下 minSz 地板会让部分品种开不出来）…`);
  const small = [];
  for (const [label, pol] of [['实盘基线', live], [`网格最优(tp${bestGrid.tpAtrMult}/sp${bestGrid.spacingAtrMult})`, bestGrid.policy]]) {
    const r = bt.simulate({ data, policy: pol, equity0: smallEq, feeBps, fundingIncluded: true, slipBps });
    const m = metrics(r, realDays, smallEq);
    small.push({ label, equity: smallEq, m });
    console.log(`  ${label.padEnd(26)}: 笔 ${String(m.trades).padStart(4)} · 期望 ${String(m.expectancyBps).padStart(8)}bps · PF ${String(m.profitFactor).padStart(6)} · 被拦 ${m.openingsRejected}（尺寸 ${m.sizingRejected}/占用 ${m.occupancyRejected}）· 净利 ${m.netPnlUsd}U`);
  }

  const out = {
    ok: true,
    generatedAt: new Date().toISOString(),
    costBasis: { feeBpsRoundTrip: feeBps, slipBpsPerSide: slipBps, funding: 'OKX real history', evidence: '2026-09-22 实盘验算：往返 10.02bps（手续费 9.32 + 滑点影响 0.71），金额加权单边滑点 5.46bps' },
    policySource: policyPath,
    livePolicy: live,
    days: realDays, bars, equity0, symbols: data.map((d) => d.instId),
    dataWindow: { from: winFrom, to: winTo },
    baseline: baseM,
    baselineTrades: baseRun.trades,
    grid: grid.map((g) => ({ tpAtrMult: g.tpAtrMult, spacingAtrMult: g.spacingAtrMult, m: g.m, policy: g.policy })),
    zsets: zsets.map((z) => ({ entryZMin: z.entryZMin, m: z.m, policy: z.policy })),
    costSensitivity: costSens,
    best: { by: 'expectancyBps', tpAtrMult: bestGrid.tpAtrMult, spacingAtrMult: bestGrid.spacingAtrMult, m: bestGrid.m, policy: bestGrid.policy },
    oosBest: { perFold: perFoldGrid, oos: wfGrid.oos, trades: wfGrid.folds.reduce((a, x) => a + x.trades.length, 0) },
    oosLive: { perFold: perFoldLive, oos: wfLive.oos, trades: wfLive.folds.reduce((a, x) => a + x.trades.length, 0) },
    smallEquity: small,
    assumptions: [
      '无未来函数：决策/指标只用 i-1 及更早收盘（inherits scripts/martin-backtest.js 时序约定）',
      `成本显式：手续费 ${feeBps}bps 往返（每次成交 ${feeBps / 2}bps）+ 滑点 ${slipBps}bps/单边 + OKX 真实资金费`,
      'sizingMode=risk（实盘口径）：首层由风险预算反解，占用上限 maxTotalOccupancyPct 在开/加仓时点钳制',
      'walk-forward：逐折独立重放（重置篮子/权益），折内只用 i-1 及更早；预热 220 根 ≈ 9.2 天不开仓',
      '资金费率 OKX 仅约 3 个月深度，未覆盖区间按 0 计（少量高估）',
    ],
  };
  store.ensureDir(DATA_DIR);
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
  const mdFile = outFile.replace(/\.json$/, '.md');
  fs.writeFileSync(mdFile, buildMd(out), 'utf8');
  console.log(`\n报告：${outFile}\n      ${mdFile}`);
  return out;
}

if (require.main === module) main().catch((e) => { console.error('扫描失败：', (e && e.stack) || e); process.exit(1); });
module.exports = { main, metrics };
