/*!
 * scripts/martin-regime-combos.js - william-bot-1-core key backtest/optimize logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-4DFAA9C1
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
#!/usr/bin/env node
/**
 * scripts/martin-regime-combos.js —— 阶段 2：把阶段 1 的有效件组合起来，找「期望↑ 且 止损率↓」的组合
 *
 * 阶段 1（scripts/martin-regime-sweep.js）结论：
 *   · Task A：vr5 阈值能降止损（28→17@1.0）但期望略降；adx 上限 ≡ 只做 range，反而拖低期望（range 之外的趋势态本来在赚钱）
 *   · Task B：confirm / half 都让胜率↑（95.27→96.4/96.1%）但期望略降（2.17→2.12/2.11）、止损数略升
 *   · Task C：maxLevels↓ 让期望↑但止损率↑、回撤与最大单笔都恶化；layeredStop 双输；partialTp(0.6%,50%) 期望↑、回撤↓
 * 本脚本：partialTp 阈值网格 + vr5 阈值网格 + 组合（含 Task B），全部给 5 折 OOS 与成本敏感度。
 *
 * 用法：
 *   node scripts/martin-regime-combos.js [--days 350] [--equity 10000] [--fee 10.02] [--slip 5] [--folds 5]
 */
'use strict';

if (!process.env.PROXY_URL && !process.env.HTTPS_PROXY) process.env.PROXY_URL = 'http://127.0.0.1:17890';

const fs = require('fs');
const path = require('path');
const bt = require('./martin-backtest');
const sw = require('./martin-regime-sweep');
const martin = require('../modules/martin');

const DATA_DIR = path.join(__dirname, '..', 'data');
const round = (v, n = 4) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(n)) : null);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};

/** 更细的止损/尾部口径（老板验收要的列） */
function tail(r) {
  const tr = r.trades || [];
  const stops = tr.filter((t) => sw.isStop(t.reason));
  const sorted = [...tr].map((t) => t.pnlUsd).sort((a, b) => a - b);
  const worst5 = sorted.slice(0, Math.max(1, Math.round(sorted.length * 0.05)));
  const flipTrades = tr.filter((t) => t.reason === 'trend_flip');
  const stopSum = stops.reduce((a, t) => a + t.pnlUsd, 0);
  const flipSum = flipTrades.reduce((a, t) => a + t.pnlUsd, 0);
  return {
    stopCount: stops.length,
    stopRate: round((stops.length / (tr.length || 1)) * 100, 3),
    stopPnlSumUsd: round(stopSum, 2),
    avgStopLossUsd: stops.length ? round(mean(stops.map((t) => t.pnlUsd)), 4) : null,
    worstStopUsd: stops.length ? round(Math.min(...stops.map((t) => t.pnlUsd)), 4) : null,
    maxSingleLossUsd: sorted.length ? round(sorted[0], 4) : null,
    tail5MeanUsd: round(mean(worst5), 4),
    trendFlipCount: flipTrades.length,
    trendFlipPnlSumUsd: round(flipSum, 2),
    avgFlipPnlUsd: flipTrades.length ? round(mean(flipTrades.map((t) => t.pnlUsd)), 4) : null,
    reasons: tr.reduce((a, t) => (a[t.reason] = (a[t.reason] || 0) + 1, a), {}),
  };
}

function variants(live) {
  const V = [];
  const add = (g, name, patch, note) => V.push({ g, name, note, policy: { ...live, ...patch } });
  add('base', 'live', {}, '实盘 policy 基线');
  /* partialTp 阈值 × 比例网格 */
  for (const at of [0.5, 0.6, 0.7, 0.8]) add('ptp', `ptp${at}%_50%`, { partialTpEnabled: true, partialTpAtPct: at, partialTpFracPct: 50 });
  add('ptp', 'ptp0.6%_30%', { partialTpEnabled: true, partialTpAtPct: 0.6, partialTpFracPct: 30 });
  add('ptp', 'ptp0.6%_70%', { partialTpEnabled: true, partialTpAtPct: 0.6, partialTpFracPct: 70 });
  /* vr5 阈值细网格 */
  for (const v of [1.1, 1.05, 1.0, 0.95]) add('vr5', `vr5<=${v}`, { entryVr5Max: v });
  /* 组合 */
  add('combo', 'ptp0.6%+vr5<=1.0', { partialTpEnabled: true, partialTpAtPct: 0.6, partialTpFracPct: 50, entryVr5Max: 1.0 });
  add('combo', 'ptp0.6%+vr5<=0.95', { partialTpEnabled: true, partialTpAtPct: 0.6, partialTpFracPct: 50, entryVr5Max: 0.95 });
  add('combo', 'ptp0.6%+vr5<=1.05', { partialTpEnabled: true, partialTpAtPct: 0.6, partialTpFracPct: 50, entryVr5Max: 1.05 });
  add('combo', 'ptp0.6%+flipConfirm2', { partialTpEnabled: true, partialTpAtPct: 0.6, partialTpFracPct: 50, trendFlipMode: 'confirm', trendFlipConfirmBars: 2 });
  add('combo', 'ptp0.6%+flipHalf', { partialTpEnabled: true, partialTpAtPct: 0.6, partialTpFracPct: 50, trendFlipMode: 'half', trendFlipReducePct: 50, trendFlipConfirmBars: 2 });
  add('combo', 'ptp0.6%+vr5<=1.0+flipHalf', { partialTpEnabled: true, partialTpAtPct: 0.6, partialTpFracPct: 50, entryVr5Max: 1.0, trendFlipMode: 'half', trendFlipReducePct: 50, trendFlipConfirmBars: 2 });
  add('combo', 'ptp0.6%+entryAtr<2.0', { partialTpEnabled: true, partialTpAtPct: 0.6, partialTpFracPct: 50, entryAtrPctMax: 2.0 });
  add('combo', 'ptp0.6%+maxLevels4', { partialTpEnabled: true, partialTpAtPct: 0.6, partialTpFracPct: 50, maxLevels: 4 });
  return V;
}

async function main() {
  const days = Number(arg('days', 350));
  const equity0 = Number(arg('equity', 10000));
  const feeBps = Number(arg('fee', 10.02));
  const slipBps = Number(arg('slip', 5));
  const folds = Number(arg('folds', 5));
  const policyPath = arg('policy', path.join(DATA_DIR, 'live-policy-20260922.json'));
  const outFile = arg('out', path.join(DATA_DIR, `regime-combos-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`));
  const live = { ...bt.BASE_POLICY, ...JSON.parse(fs.readFileSync(policyPath, 'utf8')).policy };

  console.log(`\n=== 组合扫描 · ${days} 天 · 权益 $${equity0} · fee ${feeBps}bps · slip ${slipBps}bps ===`);
  const data = await sw.loadData(days, true, true, (s) => console.log(s));
  const bars = Math.min(...data.map((d) => d.candles.length));
  const realDays = round(bars / 24, 1);
  const zWinOf = (pol) => (martin.normPolicy(pol).entryZMin > 0 ? Math.max(2, Math.floor(martin.normPolicy(pol).entryZWin)) : 0);
  const run = (policy, fee = feeBps, slip = slipBps) => {
    for (const d of data) d.ind = sw.indicators2(d.instId, d.candles, zWinOf(policy));
    return bt.simulate({ data, policy, equity0, feeBps: fee, slipBps: slip, fundingIncluded: true });
  };

  const V = variants(live);
  const results = [];
  console.log(`[1/2] 全窗口 ${V.length} 组 …`);
  for (const v of V) {
    const r = run(v.policy);
    const m = sw.metrics(r, realDays, equity0);
    const t = tail(r);
    results.push({ g: v.g, name: v.name, note: v.note, policy: v.policy, m, t, trades: r.trades });
    console.log(`  · ${(v.g + '/' + v.name).padEnd(26)} 笔 ${String(m.trades).padStart(5)} · 期望 ${String(m.expectancyBps).padStart(7)}bps · 胜率 ${String(m.winRate).padStart(6)}% · PF ${String(m.profitFactor).padStart(6)} · 回撤 ${String(m.maxDDPct).padStart(7)}% · 止损 ${String(t.stopCount).padStart(3)}(${String(t.stopRate).padStart(6)}%) · 均止损 ${String(t.avgStopLossUsd).padStart(9)} · 单笔最差 ${String(t.maxSingleLossUsd).padStart(10)}`);
  }
  console.log(`\n[2/2] 5 折 OOS …`);
  for (const x of results) {
    const wf = sw.walkForward2({ data, policy: x.policy, equity0, feeBps, slipBps, folds });
    x.oos = wf.oos;
    x.perFold = wf.folds.map((f) => ({ fold: f.fold, from: new Date(f.from).toISOString().slice(0, 10), to: new Date(f.to).toISOString().slice(0, 10), trades: f.summary.trades, expectancyBps: round(Number(f.summary.expectancyPct) * 100, 4), winRate: f.summary.winRate, profitFactor: f.summary.profitFactor, maxDDPct: f.summary.maxDrawdownPct, stopCount: f.summary.stopLossCount + f.summary.liquidationCount + (f.summary.riskStopCount || 0) }));
    console.log(`  · ${x.name.padEnd(26)} OOS ${String(x.oos.expectancyBps).padStart(7)}bps · 正折 ${x.oos.foldsPositive}/${x.oos.folds} · 最差折 ${String(x.oos.worstFoldExpectancyBps).padStart(7)}bps · 最差回撤 ${x.oos.worstFoldDDPct}%`);
  }

  /* 成本敏感度：基线 + 「期望↑且止损率↓」候选（自动挑）+ 最高期望组 */
  const cands = results.filter((x) => x.g !== 'base');
  const best = [...cands].sort((a, b) => (b.m.expectancyBps ?? -1e9) - (a.m.expectancyBps ?? -1e9))[0];
  const both = cands
    .filter((x) => x.m.expectancyBps > results[0].m.expectancyBps && x.t.stopRate < results[0].t.stopRate)
    .sort((a, b) => (b.m.expectancyBps - a.m.expectancyBps));
  const pick = both[0] || null;
  console.log(`\n[附加] 成本敏感度…（最高期望：${best.name}；期望↑且止损率↓：${pick ? pick.name : '无'}）`);
  const costSens = [];
  const sensList = [['live', live], ['bestExp:' + best.name, best.policy], ...(pick ? [['bothOh:' + pick.name, pick.policy]] : [])];
  for (const [label, pol] of sensList) {
    for (const f of [8, 10.02, 12]) {
      const r = run(pol, f, slipBps);
      const m = sw.metrics(r, realDays, equity0); const t = tail(r);
      costSens.push({ label, feeBps: f, slipBps, m, t });
      console.log(`  ${label.padEnd(24)} fee ${String(f).padStart(5)}: 期望 ${String(m.expectancyBps).padStart(7)}bps · PF ${String(m.profitFactor).padStart(6)} · 止损 ${t.stopCount}(${t.stopRate}%) · 单笔最差 ${t.maxSingleLossUsd}`);
    }
  }

  /* rf 指标分布（解释 rf 过滤为何只剩 ~90 笔） */
  const rfVals = [];
  for (const d of data) {
    const ind = sw.indicators2(d.instId, d.candles, 0);
    for (const x of ind) if (x && Number.isFinite(x.rf)) rfVals.push(x.rf);
  }
  const q = (p) => { const s = [...rfVals].sort((a, b) => a - b); return round(s[Math.min(s.length - 1, Math.floor(s.length * p))], 4); };
  const vrVals = [];
  for (const d of data) { const ind = sw.indicators2(d.instId, d.candles, 0); for (const x of ind) if (x && Number.isFinite(x.vr5)) vrVals.push(x.vr5); }
  const qv = (p) => { const s = [...vrVals].sort((a, b) => a - b); return round(s[Math.min(s.length - 1, Math.floor(s.length * p))], 4); };
  const dist = { rf: { n: rfVals.length, p10: q(0.1), p25: q(0.25), p50: q(0.5), p75: q(0.75), p90: q(0.9), shareAbove05: round((rfVals.filter((v) => v >= 0.5).length / (rfVals.length || 1)) * 100, 2) }, vr5: { n: vrVals.length, p10: qv(0.1), p25: qv(0.25), p50: qv(0.5), p75: qv(0.75), p90: qv(0.9) } };
  console.log(`\n指标分布：rf 中位 ${dist.rf.p50}（≥0.5 占 ${dist.rf.shareAbove05}%）· vr5 中位 ${dist.vr5.p50}（p10 ${dist.vr5.p10} / p90 ${dist.vr5.p90}）`);

  const out = {
    ok: true, generatedAt: new Date().toISOString(),
    costBasis: { feeBpsRoundTrip: feeBps, slipBpsPerSide: slipBps },
    livePolicy: live, days: realDays, bars, equity0, folds, policySource: policyPath,
    baseline: { m: results[0].m, t: results[0].t },
    results: results.map((x) => ({ g: x.g, name: x.name, policy: x.policy, m: x.m, t: x.t, oos: x.oos, perFold: x.perFold })),
    costSensitivity: costSens, indicatorDistribution: dist,
    verdictCandidates: { bestExpectancy: best.name, bothImprove: pick ? pick.name : null },
  };
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n报告已写：${outFile}`);
}

if (require.main === module) main().catch((e) => { console.error('组合扫描失败：', e && e.stack || e); process.exit(1); });
