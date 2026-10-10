/*!
 * scripts/martin-profit-sweep.js - william-bot-1-core key backtest/optimize logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-92A28718
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
#!/usr/bin/env node
/**
 * scripts/martin-profit-sweep.js —— 盈利能力三项优化扫描（入场 z-score / 波动止盈 / maker 优先）
 *
 * 目的：把「单笔期望（bps）」做高，而不是把交易次数做多。三项各自单独量化 + 最优组合 + 样本外。
 * 铁律：无未来函数（指标只用 i-1 及更早收盘，z-score 同口径）；成本 8bps 往返（可由 --fee 改）+ 真实资金费。
 *
 * 用法
 *   PROXY_URL=http://127.0.0.1:17890 node scripts/martin-profit-sweep.js [--days 350] [--equity 10000]
 *     [--fee 8] [--makerFee 2] [--folds 5] [--out data/profit-sweep-YYYYMMDD.json]
 *
 * 输出：data/profit-sweep-YYYYMMDD.json（含每项对比表、组合、逐折样本外、原始逐笔可复核字段）
 */
'use strict';

if (!process.env.PROXY_URL && !process.env.HTTPS_PROXY) process.env.PROXY_URL = 'http://127.0.0.1:17890';

const fs = require('fs');
const path = require('path');
const martin = require('../modules/martin');
const store = require('../modules/store');
const uni = require('../modules/universe');
const bt = require('./martin-backtest');

const DATA_DIR = path.join(__dirname, '..', 'data');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (v, n = 4) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(n)) : null);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}

/* ── 数据（与主回测同源、同缓存） ─────────────────── */

async function loadData(days, fundingIncluded, log) {
  const targetBars = Math.ceil(days * 24);
  const swaps = await (async () => {
    for (let i = 0; i < 4; i++) {
      try { return await uni.allSwaps(); }
      catch (e) { log(`  ↻ 规格拉取失败（${String(e.message || e).slice(0, 50)}），重试`); await sleep(1500 * (i + 1)); }
    }
    throw new Error('合约规格拉取失败（4 次重试）');
  })();
  const instMap = new Map(swaps.map((d) => [d.instId, d]));
  const data = [];
  for (const instId of bt.ALL) {
    const ins = instMap.get(instId);
    if (!ins) { log(`  ⚠ ${instId} 无规格，跳过`); continue; }
    const { rows: candles } = await bt.fetchCandles(instId, '1H', targetBars, (s) => log(s));
    if (candles.length < 300) { log(`  ⚠ ${instId} K线不足（${candles.length}），跳过`); continue; }
    let funding = [];
    if (fundingIncluded) funding = (await bt.fetchFunding(instId, candles[0].ts, (s) => log(s))).rows;
    data.push({
      instId, sector: bt.sectorOf(instId),
      instrument: {
        ctVal: Number(ins.ctVal || 1), ctValCcy: ins.ctValCcy,
        lotSz: Number(ins.lotSz || 0), minSz: Number(ins.minSz || 0),
        tickSz: Number(ins.tickSz || 0), maxLever: Number(ins.lever || 0),
      },
      candles, funding,
    });
  }
  return data;
}

/* ── 指标汇总（含用户要的列：笔数/胜率/期望bps/PF/回撤/日均笔数/手续费占比） ── */

function metrics(r, days, equity0, feeBps = null, makerFeeBps = null, lev = 3) {
  const s = r.summary;
  const tr = r.trades || [];
  const grossWin = tr.filter((t) => t.pnlUsd > 0).reduce((a, t) => a + t.pnlUsd, 0);
  const fees = tr.reduce((a, t) => a + t.feesUsd, 0);
  const meanEq = tr.length ? mean(tr.map((t) => Number(t.equityAtOpen) || equity0)) : equity0;
  /* maker 相对 taker 省下的手续费（同成交、只换费率）：每笔 maker 侧名义 × 费率差 / 权益 */
  let makerSaveBps = null;
  if (makerFeeBps !== null && makerFeeBps !== undefined && feeBps !== null) {
    const diff = (feeBps / 2 - makerFeeBps) / 10000;      // 单边费率差（小数）
    const per = [];
    for (const t of tr) {
      const mk = (t.levelsDetail || []).filter((l) => l.fillType === 'maker');
      if (!mk.length) continue;
      const notional = mk.reduce((a, l) => a + Number(l.marginUsd) * lev, 0);   // 名义 = 保证金 × 杠杆
      per.push((notional * diff) / (Number(t.equityAtOpen) || equity0) * 10000);
    }
    makerSaveBps = per.length ? round(mean(per), 4) : null;
  }
  return {
    trades: s.trades,
    winRate: s.winRate,
    expectancyUsd: s.expectancyUsd,
    expectancyBps: round(Number(s.expectancyPct) * 100, 4),          // 1% = 100bps
    profitFactor: s.profitFactor,
    maxDDPct: s.maxDrawdownPct,
    riskEff: s.maxDrawdownPct ? round(s.returnPct / Math.abs(s.maxDrawdownPct), 2) : null,   // 收益率/回撤
    tradesPerDay: round(s.trades / days, 3),
    avgLevels: s.avgLevelsUsed,
    stopLoss: s.stopLossCount,
    liquidation: s.liquidationCount,
    timeStop: s.timeStopCount,
    feesUsd: round(fees, 2),
    feeShareOfGrossPct: grossWin > 0 ? round((fees / grossWin) * 100, 2) : null,
    feeBpsPerTrade: tr.length ? round((fees / tr.length / meanEq) * 10000, 3) : null,
    makerFeeSaveBps: makerSaveBps,
    netPnlUsd: s.netPnlUsd,
    returnPct: s.returnPct,
    counters: s.counters,
  };
}

function table(rows, cols) {
  const head = cols.map((c) => String(c.label).padStart(c.w)).join('');
  const out = [head];
  for (const r of rows) out.push(cols.map((c) => String(c.get(r)).padStart(c.w)).join(''));
  return out.join('\n');
}

/* ── 扫描定义 ─────────────────────────────────── */

const BASE = { ...bt.BASE_POLICY };

const Z_SETS = [
  { name: 'A0 基线 z=0（状态允许就开）', policy: { ...BASE } },
  ...[20, 50].flatMap((win) => [0.5, 1.0, 1.5].map((z) => ({
    name: `A z≥${z.toFixed(1)}/win${win} 回归方向`, policy: { ...BASE, entryZMin: z, entryZWin: win, entryZMode: 'revert' },
  }))),
  ...[20, 50].flatMap((win) => [1.0, 1.5].map((z) => ({
    name: `A z≥${z.toFixed(1)}/win${win} 仅过滤`, policy: { ...BASE, entryZMin: z, entryZWin: win, entryZMode: 'filter' },
  }))),
];

const TP_SETS = [
  { name: 'B0 基线 固定止盈 0.8%', policy: { ...BASE } },
  ...[0.4, 0.5, 0.7].map((m) => ({
    name: `B ATR×${m}（钳 0.4~2%）`, policy: { ...BASE, takeProfitPct: 0, tpAtrMult: m },
  })),
];

const MAKER_SETS = [
  { name: 'C0 基线 taker 4bps/侧（8bps 往返）', policy: { ...BASE }, feeBps: 8, makerFeeBps: null },
  { name: 'C1 maker 4bps/侧（同价，隔离时机效应）', policy: { ...BASE, makerFirst: 'on' }, feeBps: 8, makerFeeBps: 4 },
  { name: 'C2 真实档 Lv1：maker 2 / taker 5', policy: { ...BASE, makerFirst: 'on' }, feeBps: 10, makerFeeBps: 2 },
  { name: 'C3 真实档 taker 5bps/侧（10bps 往返）', policy: { ...BASE }, feeBps: 10, makerFeeBps: null },
];

async function main() {
  const days = Number(arg('days', 350));
  const equity0 = Number(arg('equity', 10000));
  const feeBps = Number(arg('fee', 8));
  const makerFeeBps = Number(arg('makerFee', 2));
  const folds = Number(arg('folds', 5));
  const outFile = arg('out', path.join(DATA_DIR, `profit-sweep-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`));
  const log = (s) => console.log(s);

  console.log(`\n=== 盈利能力三项扫描 · ${days} 天 1H · 权益 $${equity0} · 成本口径 ${feeBps}bps 往返 ===`);
  console.log(`代理：${process.env.PROXY_URL}`);
  console.log('[1/4] 载入行情（缓存优先）…');
  const data = await loadData(days, true, log);
  const bars = Math.min(...data.map((d) => d.candles.length));
  const realDays = round(bars / 24, 1);
  console.log(`  标的 ${data.length} 个 · 公共窗口 ${realDays} 天 / ${bars} 根`);
  store.ensureDir(DATA_DIR);

  const runs = [];
  const pick = (recs) => recs.filter((r) => r.metrics.trades > 0).slice().sort((a, b) => b.metrics.expectancyBps - a.metrics.expectancyBps)[0];
  const exec = (set, fee = feeBps, makerFee = null) => {
    const t0 = Date.now();
    const r = bt.simulate({ data, policy: set.policy, equity0, feeBps: fee, fundingIncluded: true, slipBps: 0, makerFeeBps: makerFee });
    const rec = {
      name: set.name, policy: set.policy, feeBps: fee, makerFeeBps: makerFee,
      metrics: metrics(r, realDays, equity0, fee, makerFee), tookMs: Date.now() - t0,
    };
    runs.push(rec);
    console.log(`  · ${set.name.padEnd(36)} 笔数 ${String(rec.metrics.trades).padStart(5)} · 期望 ${String(rec.metrics.expectancyBps).padStart(8)}bps (${String(rec.metrics.expectancyUsd).padStart(8)}U) · 胜率 ${String(rec.metrics.winRate).padStart(6)}% · PF ${String(rec.metrics.profitFactor).padStart(6)} · 回撤 ${String(rec.metrics.maxDDPct).padStart(6)}% · ${(rec.tookMs / 1000).toFixed(1)}s`);
    return rec;
  };

  console.log('\n[2/4] 三项单独扫描 …');
  const zRecs = Z_SETS.map((s) => exec(s));
  const tpRecs = TP_SETS.map((s) => exec(s));
  const makerRecs = MAKER_SETS.map((s) => exec(s, s.feeBps, s.makerFeeBps));

  /* 组合效果：2×2×2 全因子（z 门 / ATR 止盈 / maker 优先），全部用真实费率档 Lv1（maker 2 / taker 5） */
  const zRep = pick(zRecs.slice(1)) || { policy: { entryZMin: 0 } };
  const tpRep = pick(tpRecs.slice(1)) || { policy: { tpAtrMult: 0.7 } };
  const RAW_FEE = 10, RAW_MAKER = makerFeeBps;
  const grid = [];
  for (const zOn of [false, true]) {
    for (const tpOn of [false, true]) {
      for (const mkOn of [false, true]) {
        const pol = { ...BASE };
        if (zOn) { pol.entryZMin = zRep.policy.entryZMin; pol.entryZWin = zRep.policy.entryZWin; pol.entryZMode = zRep.policy.entryZMode || 'revert'; }
        if (tpOn) { pol.takeProfitPct = 0; pol.tpAtrMult = tpRep.policy.tpAtrMult; }
        if (mkOn) pol.makerFirst = 'on';
        grid.push({ name: `G z${zOn ? 'on' : 'off'}/TP${tpOn ? 'atr' : 'fix'}/maker${mkOn ? 'on' : 'off'}`, policy: pol });
      }
    }
  }
  console.log(`\n[3/4] 组合全因子（z=${zRep.policy.entryZMin}/${zRep.policy.entryZWin} · TP=ATR×${tpRep.policy.tpAtrMult} · 真实费率档 maker${RAW_MAKER}/taker5）…`);
  const gridRecs = grid.map((s) => exec(s, RAW_FEE, RAW_MAKER));
  const bestCombo = pick(gridRecs) || { policy: { ...BASE }, name: '—' };
  console.log(`  → 全窗口最优组合：${bestCombo.name}`);
  const comboPolicy = bestCombo.policy;

  /* 样本外：基线 / 最优期望 / 最优总盈利 —— 三者用同一真实费率档（maker 2 / taker 5） */
  console.log(`\n[4/4] walk-forward ${folds} 折样本外（统一真实费率档 taker ${RAW_FEE / 2}bps/侧）…`);
  const byNet = gridRecs.filter((r) => r.metrics.trades > 0).slice().sort((a, b) => b.metrics.netPnlUsd - a.metrics.netPnlUsd)[0];
  const wfBase = bt.walkForward({ data, policy: BASE, equity0, feeBps: RAW_FEE, fundingIncluded: true, slipBps: 0, folds, makerFeeBps: null });
  const wfCombo = bt.walkForward({ data, policy: comboPolicy, equity0, feeBps: RAW_FEE, fundingIncluded: true, slipBps: 0, folds, makerFeeBps: bestCombo.makerFeeBps });
  const wfNet = byNet && byNet.name !== bestCombo.name
    ? bt.walkForward({ data, policy: byNet.policy, equity0, feeBps: RAW_FEE, fundingIncluded: true, slipBps: 0, folds, makerFeeBps: byNet.makerFeeBps })
    : null;
  const foldRows = (wf) => wf.folds.map((f) => ({
    fold: f.fold, from: f.from, to: f.to, days: f.days,
    trades: f.summary.trades, winRate: f.summary.winRate,
    expectancyBps: round(Number(f.summary.expectancyPct) * 100, 4),
    expectancyUsd: f.summary.expectancyUsd, profitFactor: f.summary.profitFactor,
    maxDDPct: f.summary.maxDrawdownPct,
  }));
  const baseFolds = foldRows(wfBase), comboFolds = foldRows(wfCombo);

  /* ── 上线候选：统一在历史基线口径 8bps 下做全窗口 + 5 折样本外（含逐品种） ── */
  console.log(`\n[5/5] 上线候选 OOS 对照（成本口径 ${feeBps}bps 往返）…`);
  const CANDIDATES = [
    { name: 'P0 基线（固定止盈 0.8%）', policy: { ...BASE }, fee: feeBps, mk: null },
    { name: 'P1 波动止盈 ATR×0.5', policy: { ...BASE, takeProfitPct: 0, tpAtrMult: 0.5 }, fee: feeBps, mk: null },
    { name: 'P2 波动止盈 ATR×0.4', policy: { ...BASE, takeProfitPct: 0, tpAtrMult: 0.4 }, fee: feeBps, mk: null },
    { name: 'P3 波动止盈 ATR×0.7', policy: { ...BASE, takeProfitPct: 0, tpAtrMult: 0.7 }, fee: feeBps, mk: null },
    { name: 'P4 ATR×0.5 + maker 优先', policy: { ...BASE, takeProfitPct: 0, tpAtrMult: 0.5, makerFirst: 'on' }, fee: feeBps, mk: 2 },
    { name: 'P5 z 门槛 1.5/filter（固定止盈）', policy: { ...BASE, entryZMin: 1.5, entryZWin: 20, entryZMode: 'filter' }, fee: feeBps, mk: null },
    { name: 'P6 z 门槛 1.5/filter + ATR×0.5', policy: { ...BASE, entryZMin: 1.5, entryZWin: 20, entryZMode: 'filter', takeProfitPct: 0, tpAtrMult: 0.5 }, fee: feeBps, mk: null },
  ];
  const candOut = [];
  for (const c of CANDIDATES) {
    const r = bt.simulate({ data, policy: c.policy, equity0, feeBps: c.fee, fundingIncluded: true, slipBps: 0, makerFeeBps: c.mk });
    const oosR = bt.walkForward({ data, policy: c.policy, equity0, feeBps: c.fee, fundingIncluded: true, slipBps: 0, folds, makerFeeBps: c.mk });
    candOut.push({
      name: c.name, policy: c.policy, feeBps: c.fee, makerFeeBps: c.mk,
      full: metrics(r, realDays, equity0, c.fee, c.mk), perSymbol: r.perSymbol,
      oos: { ...oosR.oos, perFold: foldRows(oosR) },
    });
    const m = candOut[candOut.length - 1];
    console.log(`  · ${c.name.padEnd(28)} 全窗口期望 ${String(m.full.expectancyBps).padStart(7)}bps / 净 ${String(m.full.netPnlUsd).padStart(9)}U / 回撤 ${String(m.full.maxDDPct).padStart(6)}% ‖ OOS ${String(round(Number(m.oos.expectancyPct) * 100, 4)).padStart(7)}bps · 正收益折 ${m.oos.foldsPositive}/${folds} · 最差折回撤 ${m.oos.worstFoldDDPct}%`);
  }

  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    note: '盈利能力三项扫描：入场 z-score 门槛 / 波动缩放止盈 / maker 优先执行。无未来函数；OOS 为逐折独立重放的合并期望。',
    days: realDays, bars, equity0, feeBps, makerFeeBpsDefault: makerFeeBps, folds,
    symbols: data.map((d) => d.instId),
    realFeeTier: {
      source: '/api/v5/account/config + /api/v5/account/trade-fee（101 服务器只读读取）',
      level: 'Lv1', feeType: '0', ruleType: 'normal',
      swapMakerBps: 2, swapTakerBps: 5, spotMakerBps: 8, spotTakerBps: 10,
    },
    runs: runs.map((r) => ({ ...r, trades: undefined })),
    zSweep: zRecs.map((r) => ({ name: r.name, policy: r.policy, ...r.metrics })),
    tpSweep: tpRecs.map((r) => ({ name: r.name, policy: r.policy, ...r.metrics })),
    makerSweep: makerRecs.map((r) => ({ name: r.name, policy: r.policy, feeBps: r.feeBps, makerFeeBps: r.makerFeeBps, ...r.metrics })),
    combos: gridRecs.map((r) => ({ name: r.name, policy: r.policy, feeBps: r.feeBps, makerFeeBps: r.makerFeeBps, ...r.metrics })),
    candidates: candOut,
    combo: { name: bestCombo.name, policy: comboPolicy, feeBps: RAW_FEE, makerFeeBps: RAW_MAKER, ...bestCombo.metrics },
    oos: {
      feeBpsUsed: RAW_FEE,
      baseline: { policy: BASE, feeBps: RAW_FEE, ...wfBase.oos, perFold: baseFolds },
      combo: { name: bestCombo.name, policy: comboPolicy, feeBps: RAW_FEE, makerFeeBps: bestCombo.makerFeeBps, ...wfCombo.oos, perFold: comboFolds },
      bestNet: wfNet ? { name: byNet.name, policy: byNet.policy, feeBps: RAW_FEE, makerFeeBps: byNet.makerFeeBps, ...wfNet.oos, perFold: foldRows(wfNet) } : null,
    },
    assumptions: [
      'z-score 的 SMA/stdev 窗口只用 i-1 及更早收盘；触发仍用 i-1 收盘，成交用当根 open',
      'z 门槛只作用于「开首单」；加仓/止盈/止损口径不变',
      'ATR 止盈 = clamp(tpAtrMult × 当期 ATR%, tpMinPct, tpMaxPct)，且仅当 takeProfitPct ≤ 0 时启用（默认 takeProfitPct=0.8 → 行为与旧版逐字节一致）',
      'maker 优先：入场先挂 post_only 限价（锚定信号根 open），下一根未触及 → 超时 1 根后转市价（taker，成交在超时根收盘）；加仓是提前挂在目标层价上的限价单，触及即 maker；止盈/止损始终 taker',
      '成本：每次成交按单边费率计（feeBps 往返 = feeBps/2 单边）；maker 成交按 makerFeeBps 单边',
      '资金费：OKX 历史仅 ~3 个月深度，未覆盖区间按 0 计（与主回测同口径）',
    ],
  };
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
  report.outFile = outFile;

  /* ── 打印 ── */
  const cols = [
    { label: '组', w: 34, get: (r) => r.name },
    { label: '笔数', w: 7, get: (r) => r.trades },
    { label: '胜率%', w: 8, get: (r) => r.winRate },
    { label: '期望bps', w: 9, get: (r) => r.expectancyBps },
    { label: '期望USD', w: 9, get: (r) => r.expectancyUsd },
    { label: 'PF', w: 7, get: (r) => r.profitFactor },
    { label: '回撤%', w: 8, get: (r) => r.maxDDPct },
    { label: '笔/日', w: 7, get: (r) => r.tradesPerDay },
    { label: '费占比%', w: 9, get: (r) => r.feeShareOfGrossPct },
    { label: '收益/回撤', w: 10, get: (r) => r.riskEff },
    { label: '净盈亏U', w: 10, get: (r) => r.netPnlUsd },
    { label: '均层', w: 6, get: (r) => r.avgLevels },
  ];
  console.log('\n' + '='.repeat(120));
  console.log('【1】入场 z-score 门槛');
  console.log(table(zRecs.map((r) => ({ ...r.metrics, name: r.name })), cols));
  console.log('\n【2】波动缩放止盈');
  console.log(table(tpRecs.map((r) => ({ ...r.metrics, name: r.name })), cols));
  console.log('\n【3】maker 优先执行');
  console.log(table(makerRecs.map((r) => ({ ...r.metrics, name: r.name })), cols));
  console.log('\n【4】组合全因子（真实费率档 maker' + RAW_MAKER + 'bps / taker 5bps）');
  console.log(table(gridRecs.map((r) => ({ ...r.metrics, name: r.name })), cols));
  const fc = [
    { label: '折', w: 4, get: (r) => r.fold },
    { label: '区间', w: 34, get: (r) => `${r.from} → ${r.to}` },
    { label: '笔数', w: 7, get: (r) => r.trades },
    { label: '胜率%', w: 8, get: (r) => r.winRate },
    { label: '期望bps', w: 9, get: (r) => r.expectancyBps },
    { label: '期望USD', w: 10, get: (r) => r.expectancyUsd },
    { label: 'PF', w: 7, get: (r) => r.profitFactor },
    { label: '回撤%', w: 8, get: (r) => r.maxDDPct },
  ];
  console.log('\n' + '='.repeat(120));
  console.log(`【5】样本外（walk-forward ${folds} 折）— 基线`);
  console.log(table(baseFolds, fc));
  console.log(`  OOS：期望 ${wfBase.oos.expectancyUsd} USD/笔（${round(Number(wfBase.oos.expectancyPct) * 100, 4)}bps）· 胜率 ${wfBase.oos.winRate}% · PF ${wfBase.oos.profitFactor} · 正收益折 ${wfBase.oos.foldsPositive}/${folds} · 最差折回撤 ${wfBase.oos.worstFoldDDPct}%`);
  console.log(`\n【6】样本外（walk-forward ${folds} 折）— 全窗口期望最优组合：${bestCombo.name}`);
  console.log(table(comboFolds, fc));
  console.log(`  OOS：期望 ${wfCombo.oos.expectancyUsd} USD/笔（${round(Number(wfCombo.oos.expectancyPct) * 100, 4)}bps）· 胜率 ${wfCombo.oos.winRate}% · PF ${wfCombo.oos.profitFactor} · 正收益折 ${wfCombo.oos.foldsPositive}/${folds} · 最差折回撤 ${wfCombo.oos.worstFoldDDPct}%`);
  if (wfNet) {
    console.log(`\n【7】样本外（walk-forward ${folds} 折）— 全窗口总盈利最优组合：${byNet.name}`);
    console.log(table(foldRows(wfNet), fc));
    console.log(`  OOS：期望 ${wfNet.oos.expectancyUsd} USD/笔（${round(Number(wfNet.oos.expectancyPct) * 100, 4)}bps）· 胜率 ${wfNet.oos.winRate}% · PF ${wfNet.oos.profitFactor} · 正收益折 ${wfNet.oos.foldsPositive}/${folds} · 最差折回撤 ${wfNet.oos.worstFoldDDPct}%`);
  }
  console.log('\n' + '='.repeat(120));
  console.log(`【8】上线候选 OOS 对照（${feeBps}bps 往返，${folds} 折）`);
  const ocols = [
    { label: '候选', w: 30, get: (r) => r.name },
    { label: '全窗期望bps', w: 12, get: (r) => r.full.expectancyBps },
    { label: '全窗净U', w: 11, get: (r) => r.full.netPnlUsd },
    { label: '全窗回撤%', w: 11, get: (r) => r.full.maxDDPct },
    { label: '全窗笔数', w: 9, get: (r) => r.full.trades },
    { label: 'OOS期望bps', w: 11, get: (r) => round(Number(r.oos.expectancyPct) * 100, 4) },
    { label: 'OOS胜率%', w: 10, get: (r) => r.oos.winRate },
    { label: 'OOS PF', w: 8, get: (r) => r.oos.profitFactor },
    { label: '正收益折', w: 9, get: (r) => `${r.oos.foldsPositive}/${folds}` },
    { label: '最差折回撤%', w: 12, get: (r) => r.oos.worstFoldDDPct },
  ];
  console.log(table(candOut, ocols));
  const p1 = candOut.find((c) => c.name.startsWith('P1'));
  if (p1) {
    console.log('\n  P1 逐品种（全窗口）：');
    console.log(`  ${'品种'.padEnd(17)}${'笔数'.padStart(6)}${'胜率%'.padStart(9)}${'期望%'.padStart(9)}${'最多层'.padStart(8)}${'止损'.padStart(6)}${'回撤%'.padStart(8)}`);
    for (const p of p1.perSymbol) console.log(`  ${p.instId.padEnd(17)}${String(p.trades).padStart(6)}${String(p.winRate).padStart(9)}${String(p.expectancyPct).padStart(9)}${String(p.maxLevels).padStart(8)}${String(p.stopLossCount).padStart(6)}${String(p.maxDDPct).padStart(8)}`);
  }
  console.log('\n' + '='.repeat(120));
  return report;
}

if (require.main === module) main().catch((e) => { console.error('扫描失败：', e && e.stack || e); process.exit(1); });
module.exports = { loadData, metrics, BASE, Z_SETS, TP_SETS, MAKER_SETS };
