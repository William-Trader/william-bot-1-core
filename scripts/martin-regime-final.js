/*!
 * scripts/martin-regime-final.js - william-bot-1-core key backtest/optimize logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-FDEE53F5
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
#!/usr/bin/env node
/**
 * scripts/martin-regime-final.js —— 阶段 3：定稿候选（组合 + 尾部 bps 口径 + 成本敏感 + 小权益复核 + Task B 归因）
 *
 * 阶段 1/2 结论（scripts/martin-regime-sweep.js / martin-regime-combos.js）：
 *   · Task A：只有 vr5 阈值能真降止损频次（28→15~17 次）；adx 上限 ≡ 只做 range（拖期望 -0.53bps）；rf≥0.5 只剩 93 笔不可用
 *   · Task B：单用 confirm/half 期望略降（2.17→2.12/2.11）；但配 vr5 后 half 转正（2.40→2.58）
 *   · Task C：maxLevels↓ 期望↑但止损率↑（失败）；layeredStop 期望↓止损次数↑但把最差单笔从 -352bps 砍到 -241bps；
 *            partialTp(0.6~0.8%) 期望↑、回撤↓、止损率基本持平
 * 本脚本：定稿组合 + 全部给「bps 口径」的止损/尾部指标（USD 会被复利混淆）+ 5 折 OOS + 成本敏感 + $600 小权益复核。
 *
 * 用法：node scripts/martin-regime-final.js [--days 350] [--equity 10000] [--fee 10.02] [--slip 5] [--folds 5] [--smallEquity 600]
 */
'use strict';

if (!process.env.PROXY_URL && !process.env.HTTPS_PROXY) process.env.PROXY_URL = 'http://127.0.0.1:17890';

const fs = require('fs');
const path = require('path');
const bt = require('./martin-backtest');
const sw = require('./martin-regime-sweep');

const DATA_DIR = path.join(__dirname, '..', 'data');
const round = (v, n = 4) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(n)) : null);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};

/** 尾部/止损指标（bps 口径 = 占开仓时权益），USD 会被复利放大，不能直接跨变体比较 */
function tail(r) {
  const tr = r.trades || [];
  const bps = (t) => Number(t.pnlPct) * 100;
  const stops = tr.filter((t) => sw.isStop(t.reason));
  const flips = tr.filter((t) => t.reason === 'trend_flip');
  const sortedBps = tr.map(bps).sort((a, b) => a - b);
  const tail5 = sortedBps.slice(0, Math.max(1, Math.round(sortedBps.length * 0.05)));
  return {
    stopCount: stops.length,
    stopRate: round((stops.length / (tr.length || 1)) * 100, 3),
    avgStopLossBps: stops.length ? round(mean(stops.map(bps)), 2) : null,
    worstStopBps: stops.length ? round(Math.min(...stops.map(bps)), 2) : null,
    maxSingleLossBps: sortedBps.length ? round(sortedBps[0], 2) : null,
    tail5MeanBps: round(mean(tail5), 2),
    stopLossSumBps: round(stops.reduce((a, t) => a + bps(t), 0), 1),
    trendFlipCount: flips.length,
    trendFlipSumBps: round(flips.reduce((a, t) => a + bps(t), 0), 1),
    bpsPerDay: null,
    reasons: tr.reduce((a, t) => (a[t.reason] = (a[t.reason] || 0) + 1, a), {}),
  };
}

function variants(live) {
  const V = [];
  const add = (g, name, patch, note) => V.push({ g, name, note, policy: { ...live, ...patch } });
  add('base', 'live', {}, '实盘 policy 基线（现状）');
  add('A', 'vr5<=1.1', { entryVr5Max: 1.1 }, 'Task A 最简：只加 vr5 上限 1.1');
  add('A', 'vr5<=1.0', { entryVr5Max: 1.0 }, 'Task A：vr5 上限 1.0');
  add('C', 'ptp0.6%', { partialTpEnabled: true, partialTpAtPct: 0.6, partialTpFracPct: 50 }, 'Task C：部分止盈 0.6%');
  add('C', 'ptp0.8%', { partialTpEnabled: true, partialTpAtPct: 0.8, partialTpFracPct: 50 }, 'Task C：部分止盈 0.8%');
  add('C', 'layeredStop(3,4x)', { layeredStopEnabled: true, layeredStopFromLevel: 3, layeredStopAtrMult: 4 }, 'Task C：深篮收紧死亡线');
  add('combo', 'ptp0.6%+vr5<=1.0', { partialTpEnabled: true, partialTpAtPct: 0.6, partialTpFracPct: 50, entryVr5Max: 1.0 }, 'A+C：期望↑且止损率↓');
  add('combo', 'ptp0.8%+vr5<=1.0', { partialTpEnabled: true, partialTpAtPct: 0.8, partialTpFracPct: 50, entryVr5Max: 1.0 }, 'A+C：更高期望');
  add('combo', 'ptp0.8%+vr5<=1.1', { partialTpEnabled: true, partialTpAtPct: 0.8, partialTpFracPct: 50, entryVr5Max: 1.1 }, 'A+C：更宽松 vr5');
  add('combo', 'ptp0.6%+vr5<=1.0+flipHalf', { partialTpEnabled: true, partialTpAtPct: 0.6, partialTpFracPct: 50, entryVr5Max: 1.0, trendFlipMode: 'half', trendFlipReducePct: 50, trendFlipConfirmBars: 2 }, 'A+B+C：再加反转减半');
  add('combo', 'ptp0.8%+vr5<=1.0+flipHalf', { partialTpEnabled: true, partialTpAtPct: 0.8, partialTpFracPct: 50, entryVr5Max: 1.0, trendFlipMode: 'half', trendFlipReducePct: 50, trendFlipConfirmBars: 2 }, 'A+B+C：高期望 + 反转减半');
  add('combo', 'ptp0.8%+vr5<=1.1+layeredStop', { partialTpEnabled: true, partialTpAtPct: 0.8, partialTpFracPct: 50, entryVr5Max: 1.1, layeredStopEnabled: true, layeredStopFromLevel: 3, layeredStopAtrMult: 4 }, 'A+C+C：尾部控制版');
  return V;
}

async function main() {
  const days = Number(arg('days', 350));
  const equity0 = Number(arg('equity', 10000));
  const feeBps = Number(arg('fee', 10.02));
  const slipBps = Number(arg('slip', 5));
  const folds = Number(arg('folds', 5));
  const smallEquity = Number(arg('smallEquity', 600));
  const policyPath = arg('policy', path.join(DATA_DIR, 'live-policy-20260922.json'));
  const outFile = arg('out', path.join(DATA_DIR, `regime-final-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`));
  const live = { ...bt.BASE_POLICY, ...JSON.parse(fs.readFileSync(policyPath, 'utf8')).policy };

  console.log(`\n=== 定稿候选 · ${days} 天 · 权益 $${equity0} · fee ${feeBps}bps · slip ${slipBps}bps ===`);
  const data = await sw.loadData(days, true, true, (s) => console.log(s));
  const bars = Math.min(...data.map((d) => d.candles.length));
  const realDays = round(bars / 24, 1);
  const run = (policy, eq = equity0, fee = feeBps, slip = slipBps) => {
    for (const d of data) d.ind = sw.indicators2(d.instId, d.candles, 0);
    return bt.simulate({ data, policy, equity0: eq, feeBps: fee, slipBps: slip, fundingIncluded: true });
  };

  const V = variants(live);
  const results = [];
  console.log(`[1/4] 全窗口 ${V.length} 组（bps 口径）…`);
  console.log(`  ${'变体'.padEnd(30)}${'笔数'.padStart(6)}${'胜率%'.padStart(8)}${'期望bps'.padStart(9)}${'PF'.padStart(7)}${'回撤%'.padStart(8)}${'止损次'.padStart(7)}${'止损率%'.padStart(8)}${'均止损bps'.padStart(11)}${'最差单笔bps'.padStart(12)}${'止损合计bps'.padStart(12)}${'持仓h'.padStart(8)}`);
  for (const v of V) {
    const r = run(v.policy);
    const m = sw.metrics(r, realDays, equity0);
    const t = tail(r);
    t.bpsPerDay = round(t.stopLossSumBps / realDays, 2);
    results.push({ g: v.g, name: v.name, note: v.note, policy: v.policy, m, t });
    console.log(`  ${v.name.padEnd(30)}${String(m.trades).padStart(6)}${String(m.winRate).padStart(8)}${String(m.expectancyBps).padStart(9)}${String(m.profitFactor).padStart(7)}${String(m.maxDDPct).padStart(8)}${String(t.stopCount).padStart(7)}${String(t.stopRate).padStart(8)}${String(t.avgStopLossBps).padStart(11)}${String(t.maxSingleLossBps).padStart(12)}${String(t.stopLossSumBps).padStart(12)}${String(m.avgHours).padStart(8)}`);
  }

  console.log(`\n[2/4] 5 折 OOS …`);
  for (const x of results) {
    const wf = sw.walkForward2({ data, policy: x.policy, equity0, feeBps, slipBps, folds });
    x.oos = wf.oos;
    x.perFold = wf.folds.map((f) => {
      const tr = f.summary;
      const stops = (f.trades || []).filter((t) => sw.isStop(t.reason)).length;
      return { fold: f.fold, from: new Date(f.from).toISOString().slice(0, 10), to: new Date(f.to).toISOString().slice(0, 10), trades: f.summary.trades, expectancyBps: round(Number(f.summary.expectancyPct) * 100, 4), winRate: f.summary.winRate, profitFactor: f.summary.profitFactor, maxDDPct: f.summary.maxDrawdownPct, stopCount: stops, stopRate: round((stops / (f.summary.trades || 1)) * 100, 3) };
    });
    console.log(`  · ${x.name.padEnd(30)} OOS ${String(x.oos.expectancyBps).padStart(7)}bps · 正折 ${x.oos.foldsPositive}/${x.oos.folds} · 最差折 ${String(x.oos.worstFoldExpectancyBps).padStart(7)} · 最差回撤 ${x.oos.worstFoldDDPct}%`);
  }

  /* 成本敏感度：基线 + 通过的候选（期望↑且止损率↓）+ 可选的尾部控制版 */
  const pass = results.filter((x) => x.m.expectancyBps > results[0].m.expectancyBps && x.t.stopRate < results[0].t.stopRate);
  console.log(`\n[3/4] 成本敏感度（fee 8 / 10.02 / 12）…`);
  console.log(`  满足「期望↑ 且 止损率↓」的变体：${pass.length ? pass.map((x) => x.name).join(' / ') : '无'}`);
  const costSens = [];
  const sensList = [['live', live], ...pass.map((x) => [x.name, x.policy]), ['ptp0.8%+vr5<=1.1+layeredStop', results.find((x) => x.name === 'ptp0.8%+vr5<=1.1+layeredStop').policy]];
  for (const [label, pol] of sensList) {
    for (const f of [8, 10.02, 12]) {
      const r = run(pol, equity0, f, slipBps);
      const m = sw.metrics(r, realDays, equity0); const t = tail(r);
      costSens.push({ label, feeBps: f, slipBps, expectancyBps: m.expectancyBps, profitFactor: m.profitFactor, maxDDPct: m.maxDDPct, stopCount: t.stopCount, stopRate: t.stopRate, maxSingleLossBps: t.maxSingleLossBps });
      console.log(`  ${label.padEnd(32)} fee ${String(f).padStart(5)}: 期望 ${String(m.expectancyBps).padStart(6)}bps · PF ${String(m.profitFactor).padStart(6)} · 止损 ${t.stopCount}(${t.stopRate}%) · 最差单笔 ${t.maxSingleLossBps}bps`);
    }
  }

  /* 小权益复核（实盘账户口径） */
  console.log(`\n[4/4] 小权益复核 $${smallEquity}（minSz 地板效应；实盘账户口径）…`);
  const small = [];
  for (const [label, pol] of [['live', live], ...pass.map((x) => [x.name, x.policy])]) {
    const r = run(pol, smallEquity);
    const m = sw.metrics(r, realDays, smallEquity); const t = tail(r);
    small.push({ label, equity: smallEquity, expectancyBps: m.expectancyBps, trades: m.trades, winRate: m.winRate, profitFactor: m.profitFactor, maxDDPct: m.maxDDPct, stopCount: t.stopCount, stopRate: t.stopRate, openingsRejected: m.openingsRejected, sizingRejected: r.summary.counters.sizingRejected, occupancyRejected: r.summary.counters.occupancyRejected, netPnlUsd: m.netPnlUsd });
    console.log(`  ${label.padEnd(32)} 笔 ${String(m.trades).padStart(4)} · 期望 ${String(m.expectancyBps).padStart(7)}bps · PF ${String(m.profitFactor).padStart(6)} · 止损 ${t.stopCount}(${t.stopRate}%) · 被拦 ${m.openingsRejected}（尺寸 ${r.summary.counters.sizingRejected}/占用 ${r.summary.counters.occupancyRejected}）· 净利 ${m.netPnlUsd}U`);
  }

  /* Task B：三种口径的反事实 + 归因 */
  console.log(`\n[附加] Task B 归因（trend_flip 口径对比）…`);
  const flipStats = {};
  for (const [label, patch] of [['now（现状）', {}], ['confirm2', { trendFlipMode: 'confirm', trendFlipConfirmBars: 2 }], ['half', { trendFlipMode: 'half', trendFlipReducePct: 50, trendFlipConfirmBars: 2 }]]) {
    const pol = { ...live, ...patch };
    const r = run(pol);
    const tr = r.trades || [];
    const flips = tr.filter((t) => t.reason === 'trend_flip');
    const cf = sw.flipCounterfactual(tr, data, pol, feeBps, slipBps);
    flipStats[label] = {
      trendFlipCount: flips.length, trendFlipSumBps: round(flips.reduce((a, t) => a + Number(t.pnlPct) * 100, 0), 1),
      trendFlipAvgBps: flips.length ? round(mean(flips.map((t) => Number(t.pnlPct) * 100)), 2) : null,
      reduceEvents: (r.summary.counters && r.summary.counters.trendFlipReduce) || 0,
      pendingEvents: (r.summary.counters && r.summary.counters.trendFlipPending) || 0,
      counterfactual: { held: cf.held, wouldProfit: cf.profitable, sharePct: cf.share },
    };
    console.log(`  ${label.padEnd(14)} flip 笔数 ${String(flips.length).padStart(4)} · flip 合计 ${String(flipStats[label].trendFlipSumBps).padStart(8)}bps · 均 ${String(flipStats[label].trendFlipAvgBps).padStart(7)}bps · 减仓事件 ${flipStats[label].reduceEvents} · 未确认事件 ${flipStats[label].pendingEvents} · 反事实可盈利 ${cf.profitable}/${cf.held} = ${cf.share}%`);
  }

  const out = {
    ok: true, generatedAt: new Date().toISOString(),
    costBasis: { feeBpsRoundTrip: feeBps, slipBpsPerSide: slipBps, funding: 'OKX real history（缓存）' },
    livePolicy: live, days: realDays, bars, equity0, folds, policySource: policyPath,
    baseline: { name: 'live', m: results[0].m, t: results[0].t },
    results: results.map((x) => ({ g: x.g, name: x.name, note: x.note, policy: x.policy, m: x.m, t: x.t, oos: x.oos, perFold: x.perFold })),
    passBoth: pass.map((x) => x.name),
    costSensitivity: costSens,
    smallEquity: small,
    flipAttribution: flipStats,
    notes: [
      'bps 口径 = 该笔净盈亏 / 开仓时权益 × 10000（USD 会被复利放大，跨变体比较一律用 bps）',
      '止损 = stop_loss + risk_stop + liquidation（不含时间止损/趋势反转/收尾）',
      '反事实：把被 trend_flip 平掉的篮子按原层价重建，用后续 K 线重放（含加仓/止损/止盈/时间止损），判定「不平会否盈利」',
    ],
  };
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2), 'utf8');
  console.log(`\n报告已写：${outFile}`);
}

if (require.main === module) main().catch((e) => { console.error('定稿扫描失败：', e && e.stack || e); process.exit(1); });
