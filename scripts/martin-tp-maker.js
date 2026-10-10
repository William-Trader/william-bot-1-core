/*!
 * scripts/martin-tp-maker.js - william-bot-1-core key backtest/optimize logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-C943572A
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
#!/usr/bin/env node
/**
 * scripts/martin-tp-maker.js —— 「止盈挂 maker 限价单」的量化验证（只建模与回测，不下单）
 *
 * 背景：上一轮只测了「入场挂 maker」（净收益 ≈ 0：省 0.335bps 被入场延迟 −0.34bps 抵消），
 *       止盈侧从未测过 —— 而实盘 ~96% 的平仓都是止盈。真实费率：永续 maker 2bps / taker 5bps（单边）。
 *       止盈改挂 post_only 限价（maker）⇒ 每笔止盈腿省 3bps/边。
 *
 * 本脚本回答四个问题（350 天 · 1H · 8 标的 · 真实费率 maker2/taker5 · 资金费计入 · 无未来函数）：
 *   1) 组合对比：基线（全 taker） / M1（止盈 maker） / M2（入场+止盈 maker，止损仍 taker）
 *   2) 成交率敏感性：限价挂单不保证成交 → prob(p=1.0/0.95/…) 与 confirm（下一根开盘仍在止盈价外）
 *      的净利/回撤/胜率变化 + 「盈亏平衡成交率」（低于它 maker 止盈就不划算）
 *   3) 费率档稳健性：taker/maker 取不同档时的 Δ期望 与平衡成交率
 *   4) 5 折 walk-forward 样本外（最优组 + 对照）
 *
 * 用法
 *   PROXY_URL=http://127.0.0.1:17890 node scripts/martin-tp-maker.js [--days 350] [--equity 10000]
 *     [--fee 10] [--makerFee 2] [--folds 5] [--slip 0] [--out data/tp-maker-YYYYMMDD.json]
 *
 * 产出：data/tp-maker-YYYYMMDD.json（逐笔可复核）+ data/tp-maker-report-YYYYMMDD.md（原始数字表格）
 * 铁律：默认 dry-run；本脚本只读行情、只做模拟，不触碰任何下单路径。
 */
'use strict';

if (!process.env.PROXY_URL && !process.env.HTTPS_PROXY) process.env.PROXY_URL = 'http://127.0.0.1:17890';

const fs = require('fs');
const path = require('path');
const store = require('../modules/store');
const bt = require('./martin-backtest');
const sw = require('./martin-profit-sweep');

const DATA_DIR = path.join(__dirname, '..', 'data');
const round = (v, n = 4) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(n)) : null);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pad = (s, w) => String(s === null || s === undefined ? '-' : s).padStart(w);
const arg = (name, def) => {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
};

/** 线上现状（= data/policy-applied-20260921.json 原样）：波动止盈 ATR×0.5 + 几何 2.0/4层/间距0.8 + risk 仓位 8%/2篮 */
const LIVE = {
  firstMarginPct: 0.6, leverage: 3, marginMode: 'isolated',
  spacingMode: 'atr', spacingAtrMult: 0.8, spacingPct: 0.8, multiplier: 2, maxLevels: 4,
  takeProfitPct: 0, hardStopPct: 2, timeStopHours: 48, cooldownHours: 4, maxBaskets: 2, dailyLossPct: 4,
  maxFundingAbs: 0.001, minAtrPct: 0.4, maxAtrPct: 8, mmr: 0.005, blackSwanPct: 5,
  entryZMin: 0, entryZWin: 20, entryZMode: 'revert', tpAtrMult: 0.5, tpMinPct: 0.4, tpMaxPct: 2,
  makerFirst: 'off', makerTimeoutBars: 1,
  sizingMode: 'risk', basketRiskBudgetPct: 8, maxTotalOccupancyPct: 45, riskK: 1.2,
  stopMode: 'atr', deathAtrMult: 6, maxBasketRiskPct: 2,
};

const GROUPS = [
  { key: '基线', name: '基线 taker入场/taker止盈/taker止损', policy: { ...LIVE } },
  { key: 'M1', name: 'M1   taker入场/maker止盈/taker止损', policy: { ...LIVE, tpOrderType: 'limit' } },
  { key: 'M2', name: 'M2   maker入场/maker止盈/taker止损', policy: { ...LIVE, tpOrderType: 'limit', makerFirst: 'on' } },
];

const PROB_GRID = [1.0, 0.95, 0.9, 0.85, 0.8, 0.7, 0.6, 0.5];
const SEEDS = ['', 's2', 's3'];        // prob 模型的多个随机盐 → 均值曲线，压掉单轨迹噪声

/* ── 指标行 ───────────────────────────────────── */

function row(name, r, days) {
  const s = r.summary;
  return {
    name,
    trades: s.trades,
    winRate: s.winRate,
    expectancyBps: round(Number(s.expectancyPct) * 100, 4),
    profitFactor: s.profitFactor,
    maxDDPct: s.maxDrawdownPct,
    feesUsd: round(s.totalFeesUsd, 2),
    netPnlUsd: round(s.netPnlUsd, 2),
    riskEff: s.maxDrawdownPct ? round(s.returnPct / Math.abs(s.maxDrawdownPct), 3) : null,
    returnPct: s.returnPct,
    endEquity: s.endEquity,
    tpCount: s.takeProfitCount, stopLoss: s.stopLossCount, liq: s.liquidationCount, timeStop: s.timeStopCount,
    tpMaker: s.tpMaker || null,
  };
}

function fmtTable(rows, cols) {
  const out = [cols.map((c) => String(c.h).padStart(c.w)).join('')];
  for (const r of rows) out.push(cols.map((c) => pad(c.get(r), c.w)).join(''));
  return out.join('\n');
}

const COLS = [
  { h: '组', w: 38, get: (r) => r.name },
  { h: '笔数', w: 6, get: (r) => r.trades },
  { h: '胜率%', w: 7, get: (r) => r.winRate },
  { h: '期望bps', w: 9, get: (r) => r.expectancyBps },
  { h: 'PF', w: 6, get: (r) => r.profitFactor },
  { h: '回撤%', w: 8, get: (r) => r.maxDDPct },
  { h: '手续费U', w: 11, get: (r) => r.feesUsd },
  { h: '净盈亏U', w: 12, get: (r) => r.netPnlUsd },
  { h: '收益/回撤', w: 10, get: (r) => r.riskEff },
  { h: '止盈/止损/爆/时', w: 16, get: (r) => `${r.tpCount}/${r.stopLoss}/${r.liq}/${r.timeStop}` },
  { h: '止盈maker节省U', w: 15, get: (r) => (r.tpMaker ? r.tpMaker.savingUsdTotal : '-') },
  { h: '节省bps/笔(权益)', w: 17, get: (r) => (r.tpMaker ? r.tpMaker.savingBpsOfEquityPerTrade : '-') },
];
const SENS_COLS = [
  ...COLS.slice(0, 4),
  { h: '期望区间', w: 17, get: (r) => (r.expMin === undefined ? '-' : `${r.expMin}..${r.expMax}`) },
  ...COLS.slice(4, 8),
  { h: '止盈未成交', w: 10, get: (r) => (r.missCount === undefined ? '-' : r.missCount) },
  { h: '止盈maker成交', w: 14, get: (r) => (r.makerFills === undefined ? '-' : r.makerFills) },
];

/** 线性插值求盈亏平衡成交率（网格按 p 降序；p=1 不赚 → 无平衡点） */
function breakEvenProb(grid, baseBps) {
  for (let i = 0; i < grid.length - 1; i++) {
    const a = grid[i], b = grid[i + 1];
    const da = a.expectancyBps - baseBps, db = b.expectancyBps - baseBps;
    if (da > 0 && db <= 0) return round(a.p + (b.p - a.p) * (da / (da - db)), 4);
    if (da <= 0) return null;
  }
  return null;      // 全网格为正 → 平衡点低于网格下界
}

/* ── 主流程 ───────────────────────────────────── */

async function main() {
  const days = Number(arg('days', 350));
  const equity0 = Number(arg('equity', 10000));
  const feeBps = Number(arg('fee', 10));            // 10bps 往返 = taker 5bps/边（真实档）
  const makerFeeBps = Number(arg('makerFee', 2));   // maker 2bps/边（真实档）
  const slipBps = Number(arg('slip', 0));
  const folds = Number(arg('folds', 5));
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const outFile = arg('out', path.join(DATA_DIR, `tp-maker-${stamp}.json`));
  const mdFile = arg('md', path.join(DATA_DIR, `tp-maker-report-${stamp}.md`));

  console.log(`\n=== 止盈挂 maker 限价验证 · ${days} 天 1H · 权益 $${equity0} · taker ${feeBps / 2}bps/边 · maker ${makerFeeBps}bps/边 · 滑点 ${slipBps}bps ===`);
  console.log(`代理：${process.env.PROXY_URL}`);

  console.log('\n[1/5] 载入行情（与主回测同源同缓存）…');
  const data = await sw.loadData(days, true, (s) => console.log(s));
  if (!data.length) { console.error('没有可用数据，退出'); process.exit(2); }
  const bars = Math.min(...data.map((d) => d.candles.length));
  const realDays = round(bars / 24, 1);
  console.log(`  数据：${data.length} 标的 · 公共段 ${realDays} 天 / ${bars} 根 1H`);

  const sim = (policy, opts = {}) => bt.simulate({
    data, policy, equity0,
    feeBps: opts.feeBps === undefined ? feeBps : opts.feeBps,
    fundingIncluded: true, slipBps,
    makerFeeBps: opts.makerFeeBps === undefined ? makerFeeBps : opts.makerFeeBps,
    tpFillMode: opts.tpFillMode === undefined ? null : opts.tpFillMode,
    tpFillRate: opts.tpFillRate === undefined ? null : opts.tpFillRate,
    tpFillSeed: opts.tpFillSeed === undefined ? null : opts.tpFillSeed,
  });

  /** 多盐均值行：prob 模型的成交是逐 (篮子, 根) 抽样的，单条轨迹噪声大 → 多盐均值 + 区间 */
  function probAgg(policy, p, fee, mk, seeds = SEEDS) {
    const rs = seeds.map((sd) => sim(policy, { tpFillMode: 'prob', tpFillRate: p, tpFillSeed: sd, feeBps: fee, makerFeeBps: mk }));
    const rr = rs.map((r, i) => {
      const x = row('x', r, realDays);
      x.tpMaker = r.summary.tpMaker || null;
      x.seed = seeds[i] === '' ? 'default' : seeds[i];
      return x;
    });
    const agg = { ...rr[0] };
    for (const k of ['trades', 'winRate', 'expectancyBps', 'profitFactor', 'feesUsd', 'netPnlUsd', 'riskEff', 'returnPct', 'endEquity', 'tpCount', 'stopLoss', 'liq', 'timeStop']) {
      agg[k] = round(mean(rr.map((x) => Number(x[k]) || 0)), 4);
    }
    agg.maxDDPct = round(Math.min(...rr.map((x) => x.maxDDPct)), 2);              // 回撤取最差
    agg.expMin = round(Math.min(...rr.map((x) => x.expectancyBps)), 4);
    agg.expMax = round(Math.max(...rr.map((x) => x.expectancyBps)), 4);
    agg.makerFills = round(mean(rr.map((x) => (x.tpMaker ? x.tpMaker.makerFills : 0))), 1);
    agg.missCount = round(mean(rr.map((x) => (x.tpMaker ? x.tpMaker.missCount : 0))), 1);
    agg.savingUsd = round(mean(rr.map((x) => (x.tpMaker ? x.tpMaker.savingUsdTotal : 0))), 2);
    agg.savingBpsEquity = round(mean(rr.map((x) => (x.tpMaker ? x.tpMaker.savingBpsOfEquityPerTrade : 0))), 4);
    agg.tpMaker = null;
    return {
      agg, seeds: rr.map((x) => ({ seed: x.seed, trades: x.trades, winRate: x.winRate, expectancyBps: x.expectancyBps, profitFactor: x.profitFactor, maxDDPct: x.maxDDPct, netPnlUsd: x.netPnlUsd, feesUsd: x.feesUsd, makerFills: x.tpMaker ? x.tpMaker.makerFills : null, missCount: x.tpMaker ? x.tpMaker.missCount : null })),
    };
  }

  console.log('\n[2/5] 组合对比（基线 / M1 / M2）…');
  const combo = [];
  const raw = {};
  for (const g of GROUPS) {
    const t0 = Date.now();
    const r = sim(g.policy, { tpFillMode: g.key === '基线' ? null : 'touch' });
    raw[g.key] = r;
    combo.push(row(g.name, r, realDays));
    console.log(`  · ${g.key.padEnd(5)} 笔数 ${pad(r.summary.trades, 5)} · 期望 ${pad(round(Number(r.summary.expectancyPct) * 100, 2), 8)}bps · 胜率 ${pad(r.summary.winRate, 6)}% · PF ${pad(r.summary.profitFactor, 6)} · 回撤 ${pad(r.summary.maxDrawdownPct, 7)}% · 净 ${pad(r.summary.netPnlUsd, 12)}U · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
  const baseRow = combo[0], m1Row = combo[1], m2Row = combo[2];
  console.log(`  Δ(M1−基线)：期望 ${round(m1Row.expectancyBps - baseRow.expectancyBps, 4)}bps · 手续费 ${round(m1Row.feesUsd - baseRow.feesUsd, 2)}U · 净 ${round(m1Row.netPnlUsd - baseRow.netPnlUsd, 2)}U · 回撤 ${round(m1Row.maxDDPct - baseRow.maxDDPct, 2)}pp`);
  console.log(`  Δ(M2−M1)  ：期望 ${round(m2Row.expectancyBps - m1Row.expectancyBps, 4)}bps · 手续费 ${round(m2Row.feesUsd - m1Row.feesUsd, 2)}U · 净 ${round(m2Row.netPnlUsd - m1Row.netPnlUsd, 2)}U · 回撤 ${round(m2Row.maxDDPct - m1Row.maxDDPct, 2)}pp`);

  console.log('\n[3/5] 成交率敏感性（止盈限价未成交的代价；prob 每档 ' + SEEDS.length + ' 个随机盐取均值）…');
  const sens = [];
  const sensDetail = [];
  for (const p of PROB_GRID) {
    const { agg, seeds } = probAgg(GROUPS[1].policy, p, feeBps, makerFeeBps);
    agg.p = p; agg.mode = 'prob';
    agg.name = `M1 · prob p=${p.toFixed(2)}`;
    sens.push(agg); sensDetail.push({ p, seeds });
    console.log(`  · p=${p.toFixed(2)} 期望 ${pad(agg.expectancyBps, 7)}bps [${agg.expMin}..${agg.expMax}] · 胜率 ${pad(agg.winRate, 6)}% · PF ${pad(agg.profitFactor, 6)} · 回撤 ${pad(agg.maxDDPct, 7)}% · 净 ${pad(agg.netPnlUsd, 12)}U · 止盈未成交 ${pad(agg.missCount, 6)}`);
  }
  {
    const r = sim(GROUPS[1].policy, { tpFillMode: 'confirm' });
    const rr = row('M1 · confirm（下一根开盘仍在止盈价之外）', r, realDays);
    rr.mode = 'confirm';
    if (r.summary.tpMaker) { rr.makerFills = r.summary.tpMaker.makerFills; rr.missCount = r.summary.tpMaker.missCount; rr.savingUsd = r.summary.tpMaker.savingUsdTotal; }
    sens.push(rr);
    console.log(`  · confirm  期望 ${pad(rr.expectancyBps, 7)}bps · 胜率 ${pad(rr.winRate, 6)}% · PF ${pad(rr.profitFactor, 6)} · 回撤 ${pad(rr.maxDDPct, 7)}% · 净 ${pad(rr.netPnlUsd, 12)}U · 止盈未成交 ${pad(rr.missCount, 6)}`);
  }
  const gridForBE = [m1Row, ...sens.filter((s) => s.mode === 'prob')].map((s) => ({ p: s.p === undefined ? 1 : s.p, expectancyBps: s.expectancyBps })).sort((a, b) => b.p - a.p);
  const beP = breakEvenProb(gridForBE, baseRow.expectancyBps);
  const naiveSave = m1Row.tpMaker ? m1Row.tpMaker.savingBpsOfEquityPerTrade : null;
  console.log(`  盈亏平衡成交率（线性插值，M1 期望 = 基线 ${baseRow.expectancyBps}bps）⇒ p* = ${beP === null ? '无（网格内恒为正/恒为负）' : beP}`);
  console.log(`  纯手续费节省（p=1，占权益）= ${naiveSave} bps/笔；「未成交只是晚一点止盈」的理想线下任意 p>0 都划算 —— 实测曲线把「延迟离场期间被止损/时间止损截胡」的代价算了进去`);

  console.log('\n[4/5] 费率档稳健性（taker/maker 换档时的 Δ期望 与平衡成交率）…');
  const FEE_PAIRS = [[feeBps, makerFeeBps], [8, 2], [feeBps, 3], [6, 2]];
  const feeRobust = [];
  for (const [tf, mf] of FEE_PAIRS) {
    const br = row('base', sim(GROUPS[0].policy, { feeBps: tf, makerFeeBps: mf }), realDays);
    const mr = row('M1', sim(GROUPS[1].policy, { tpFillMode: 'touch', feeBps: tf, makerFeeBps: mf }), realDays);
    const grid = [{ p: 1, expectancyBps: mr.expectancyBps }];
    for (const p of PROB_GRID.filter((x) => x < 1)) grid.push({ p, expectancyBps: probAgg(GROUPS[1].policy, p, tf, mf, ['', 's2']).agg.expectancyBps });
    grid.sort((a, b) => b.p - a.p);
    const be = breakEvenProb(grid, br.expectancyBps);
    const rec = {
      name: `taker ${tf / 2} / maker ${mf}`, takerBps: tf / 2, makerBps: mf, diffBps: round(tf / 2 - mf, 4),
      baseExpectancyBps: br.expectancyBps, m1ExpectancyBps: mr.expectancyBps,
      deltaBps: round(mr.expectancyBps - br.expectancyBps, 4),
      m1FeesUsd: mr.feesUsd, m1NetPnlUsd: mr.netPnlUsd, m1MaxDDPct: mr.maxDDPct,
      breakEvenFillRate: be, probCurve: grid,
    };
    feeRobust.push(rec);
    console.log(`  · ${rec.name}（差 ${rec.diffBps}bps/边）⇒ Δ期望 ${rec.deltaBps}bps · p* = ${be}`);
  }

  console.log('\n[5/5] 5 折 walk-forward（最优组 + 对照）…');
  const wf = {};
  const wfTargets = [
    ['基线', GROUPS[0].policy, null],
    ['M1(touch)', GROUPS[1].policy, 'touch'],
    ['M2(touch)', GROUPS[2].policy, 'touch'],
    ['M1(confirm)', GROUPS[1].policy, 'confirm'],
  ];
  for (const [k, pol, mode] of wfTargets) {
    const t0 = Date.now();
    const r = bt.walkForward({ data, policy: pol, equity0, feeBps, fundingIncluded: true, slipBps, folds, makerFeeBps, tpFillMode: mode });
    wf[k] = r;
    console.log(`  · ${k.padEnd(12)} OOS 期望 ${pad(round(Number(r.oos.expectancyPct) * 100, 4), 9)}bps · 胜率 ${pad(r.oos.winRate, 6)}% · PF ${pad(r.oos.profitFactor, 6)} · 正收益折 ${r.oos.foldsPositive}/${folds} · 最差折回撤 ${pad(r.oos.worstFoldDDPct, 7)}% · ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }

  /* ── 判定（一句话；由数字生成，不手写） ── */
  const dExp = round(m1Row.expectancyBps - baseRow.expectancyBps, 4);
  const dExpM2 = round(m2Row.expectancyBps - m1Row.expectancyBps, 4);
  const m1Wf = wf['M1(touch)'];
  const wfBps = round(Number(m1Wf.oos.expectancyPct) * 100, 4);
  const wfBaseBps = round(Number(wf['基线'].oos.expectancyPct) * 100, 4);
  let verdictOneLine;
  if (!(dExp > 0)) verdictOneLine = `不上：止盈挂 maker 在 p=1（必成交）上界下也只有 ${dExp}bps/笔，省不到钱。`;
  else if (beP === null) verdictOneLine = `可以上：连 p=${PROB_GRID[PROB_GRID.length - 1]} 都在盈亏平衡之上（无平衡点），且 Δ期望 ${dExp}bps/笔。`;
  else verdictOneLine = `可以上，但必须先确认成交率：Δ期望仅 +${dExp}bps/笔（${baseRow.expectancyBps}→${m1Row.expectancyBps}），盈亏平衡成交率 p* = ${beP}（低于它 maker 止盈反而亏）；M2（入场也挂 maker）${dExpM2 > 0 ? '更好' : '更差'}（${dExpM2}bps）→ ${dExpM2 > 0 ? '可考虑' : '不上'}。`;

  const report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    config: { days: realDays, bars, symbols: data.map((d) => d.instId), equity0, feeBps, takerSideBps: feeBps / 2, makerSideBps: makerFeeBps, slipBps, folds, policy: LIVE, probGrid: PROB_GRID, seeds: SEEDS },
    combo: combo.map((r) => ({ ...r, tpMaker: r.tpMaker || null })),
    sensitivity: sens,
    sensitivityPerSeed: sensDetail,
    breakEvenFillRate: beP,
    pureSavingBpsPerTradeAtP1: naiveSave,
    feeRobust,
    perFold: Object.fromEntries(Object.entries(wf).map(([k, v]) => [k, v.folds.map((f) => ({ fold: f.fold, from: f.from, to: f.to, trades: f.summary.trades, expectancyBps: round(Number(f.summary.expectancyPct) * 100, 4), winRate: f.summary.winRate, profitFactor: f.summary.profitFactor, maxDrawdownPct: f.summary.maxDrawdownPct, feesUsd: round(f.summary.totalFeesUsd, 2), netPnlUsd: round(f.summary.netPnlUsd, 2), stopLossCount: f.summary.stopLossCount, timeStopCount: f.summary.timeStopCount }))])),
    oos: Object.fromEntries(Object.entries(wf).map(([k, v]) => [k, { ...v.oos, expectancyBps: round(Number(v.oos.expectancyPct) * 100, 4) }])),
    tradesM1: raw['M1'].trades,
    verdictOneLine,
    notes: [
      '真实费率档：taker 5bps/边（fee 10bps 往返）、maker 2bps/边；止盈 maker 每边省 3bps',
      '限价成交模型：touch（触及即成交，上界）/ prob（每次触及按 p 抽样，未成交继续持有 → 后续根重试）/ confirm（要求下一根开盘仍在止盈价外，极端压力口径）',
      'maker 限价成交价 = 挂单价（不加滑点）；限价单的真实风险是「未成交」，由成交模型承担',
      '未成交后策略的常规巡检（按当根开盘价）仍可能市价平仓 → 按 taker 计（保守，不把这类算成 maker 节省）',
      '无未来函数：决策只用 i-1 及更早收盘；confirm 的成交判定只用当根 open',
      '绝对 U 是复利放大值（无容量上限）→ 决策看 bps / 回撤% / PF / 分折',
    ],
  };
  store.ensureDir(DATA_DIR);
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');

  const rel = (f) => path.relative(path.join(__dirname, '..'), f);
  const md = [];
  md.push(`# 止盈挂 maker 限价单 · 量化验证（${stamp}）`, '');
  md.push(`- 口径：${realDays} 天 1H · ${data.length} 标的（${data.map((d) => d.instId).join(' / ')}）· 权益 $${equity0} · 真实费率 taker **${feeBps / 2}bps/边** / maker **${makerFeeBps}bps/边** · 资金费计入 · 滑点 ${slipBps}bps · 无未来函数 · 只建模不下单`);
  md.push(`- 底座政策（= 线上现状 policy-applied-20260921）：波动止盈 ATR×0.5（takeProfitPct=0）· 几何 2.0×/4 层/间距 ATR×0.8 · risk 仓位 预算 8%/2 篮 · 兜底 2% · 3x · 占用上限 45%`);
  md.push(`- 原始数据：\`${rel(outFile)}\` · 脚本：\`scripts/martin-tp-maker.js\` · 回测开关：\`--tp-order market|limit\`（\`scripts/martin-backtest.js\`）`, '');
  md.push('## 0. 一句话判定', '');
  md.push(`> **${verdictOneLine}**`, '');
  md.push('## 1. 组合对比（真实费率 maker2/taker5）', '');
  md.push('```');
  md.push(fmtTable(combo, COLS));
  md.push('```');
  md.push(`- Δ(M1−基线)：期望 **${dExp}bps/笔** · 手续费 ${round(m1Row.feesUsd - baseRow.feesUsd, 2)}U · 净盈亏 ${round(m1Row.netPnlUsd - baseRow.netPnlUsd, 2)}U · 回撤 ${round(m1Row.maxDDPct - baseRow.maxDDPct, 2)}pp`);
  md.push(`- Δ(M2−M1)：期望 **${dExpM2}bps/笔** · 手续费 ${round(m2Row.feesUsd - m1Row.feesUsd, 2)}U · 净盈亏 ${round(m2Row.netPnlUsd - m1Row.netPnlUsd, 2)}U · 回撤 ${round(m2Row.maxDDPct - m1Row.maxDDPct, 2)}pp`);
  md.push(`- 每笔节省（M1 自身轨迹内、止盈腿）：**3bps × 止盈名义 = ${m1Row.tpMaker ? m1Row.tpMaker.savingBpsOfNotional : '-'}bps/名义**、**${naiveSave}bps/权益**；350 天合计 ${m1Row.tpMaker ? m1Row.tpMaker.savingUsdTotal : '-'}U`);
  md.push(`- ⚠ 两条轨迹的费用差（${round(m1Row.feesUsd - baseRow.feesUsd, 2)}U）小于上一条的节省额：省下的钱会复利进仓位（M1 期末权益更高）→ 单笔 bps 口径才是干净的对照`, '');
  md.push('## 2. 成交率敏感性（限价未成交的代价）', '');
  md.push(`prob 每档跑 ${SEEDS.length} 个随机盐取均值（期望区间给出种子间极差）；confirm 是确定性模型（无随机）。`, '');
  md.push('```');
  md.push(fmtTable(sens, SENS_COLS));
  md.push('```');
  md.push(`- **盈亏平衡成交率：p\\* = ${beP === null ? '无（网格内恒正或恒负）' : beP}**（M1 期望 = 基线 ${baseRow.expectancyBps}bps）`);
  md.push(`- 纯手续费节省（p=1，占权益）= ${naiveSave} bps/笔；「未成交只是晚一点止盈」的理想线下任意 p>0 都划算 —— 实测曲线把「延迟离场期间被止损/时间止损截胡」的代价算了进去`, '');
  md.push('### 2.1 每个随机盐的明细（prob）', '');
  md.push('```');
  md.push(fmtTable(sensDetail.flatMap((d) => d.seeds.map((s) => ({ ...s, p: d.p }))), [
    { h: 'p', w: 6, get: (r) => r.p },
    { h: '盐', w: 8, get: (r) => r.seed },
    { h: '笔数', w: 6, get: (r) => r.trades },
    { h: '胜率%', w: 7, get: (r) => r.winRate },
    { h: '期望bps', w: 9, get: (r) => r.expectancyBps },
    { h: 'PF', w: 6, get: (r) => r.profitFactor },
    { h: '回撤%', w: 8, get: (r) => r.maxDDPct },
    { h: '净盈亏U', w: 12, get: (r) => r.netPnlUsd },
    { h: '手续费U', w: 11, get: (r) => r.feesUsd },
    { h: 'maker成交', w: 10, get: (r) => r.makerFills },
    { h: '未成交', w: 8, get: (r) => r.missCount },
  ]));
  md.push('```', '');
  md.push('## 3. 费率档稳健性', '');
  md.push('```');
  md.push(fmtTable(feeRobust, [
    { h: '费率档', w: 20, get: (r) => r.name },
    { h: '费率差bps/边', w: 12, get: (r) => r.diffBps },
    { h: '基线期望bps', w: 12, get: (r) => r.baseExpectancyBps },
    { h: 'M1期望bps', w: 11, get: (r) => r.m1ExpectancyBps },
    { h: 'Δ期望bps', w: 10, get: (r) => r.deltaBps },
    { h: 'M1回撤%', w: 9, get: (r) => r.m1MaxDDPct },
    { h: 'M1净盈亏U', w: 12, get: (r) => r.m1NetPnlUsd },
    { h: '平衡成交率p*', w: 12, get: (r) => (r.breakEvenFillRate === null ? '无' : r.breakEvenFillRate) },
  ]));
  md.push('```', '');
  md.push('## 4. 5 折 walk-forward 样本外', '');
  md.push('```');
  md.push(fmtTable(Object.entries(wf).map(([k, v]) => ({ k, ...v.oos, expectancyBps: round(Number(v.oos.expectancyPct) * 100, 4) })), [
    { h: '组', w: 14, get: (r) => r.k }, { h: 'OOS期望bps', w: 11, get: (r) => r.expectancyBps },
    { h: 'OOS胜率%', w: 10, get: (r) => r.winRate }, { h: 'OOS PF', w: 8, get: (r) => r.profitFactor },
    { h: '正收益折', w: 9, get: (r) => `${r.foldsPositive}/${r.folds}` }, { h: '最差折回撤%', w: 12, get: (r) => r.worstFoldDDPct },
    { h: 'OOS笔数', w: 9, get: (r) => r.trades },
  ]));
  md.push('```');
  md.push('', '### 4.1 逐折明细', '');
  const FOLD_COLS = [
    { h: '折', w: 36, get: (r) => r.name },
    { h: '笔数', w: 6, get: (r) => r.trades },
    { h: '胜率%', w: 7, get: (r) => r.winRate },
    { h: '期望bps', w: 9, get: (r) => r.expectancyBps },
    { h: 'PF', w: 6, get: (r) => r.profitFactor },
    { h: '回撤%', w: 8, get: (r) => r.maxDDPct },
    { h: '手续费U', w: 11, get: (r) => r.feesUsd },
    { h: '净盈亏U', w: 12, get: (r) => r.netPnlUsd },
  ];
  for (const [k, v] of Object.entries(wf)) {
    md.push(`**${k}**`, '');
    md.push('```');
    md.push(fmtTable(v.folds.map((f) => ({
      name: `折${f.fold} ${f.from} → ${f.to}`,
      trades: f.summary.trades, winRate: f.summary.winRate,
      expectancyBps: round(Number(f.summary.expectancyPct) * 100, 4),
      profitFactor: f.summary.profitFactor, maxDDPct: f.summary.maxDrawdownPct,
      feesUsd: round(f.summary.totalFeesUsd, 2), netPnlUsd: round(f.summary.netPnlUsd, 2),
    })), FOLD_COLS));
    md.push('```', '');
  }
  md.push('## 5. 结论与前提', '');
  md.push(`- 组合：基线 ${baseRow.expectancyBps}bps → M1 ${m1Row.expectancyBps}bps（Δ ${dExp}）→ M2 ${m2Row.expectancyBps}bps（Δ vs M1 ${dExpM2}）；回撤 ${baseRow.maxDDPct}% / ${m1Row.maxDDPct}% / ${m2Row.maxDDPct}%`);
  md.push(`- 5 折 OOS：基线 ${wfBaseBps}bps（${wf['基线'].oos.foldsPositive}/${folds} 折为正）→ M1 ${wfBps}bps（${m1Wf.oos.foldsPositive}/${folds}）· 最差折回撤 ${m1Wf.oos.worstFoldDDPct}%`);
  md.push(`- 盈亏平衡成交率 p* = ${beP === null ? '无' : beP}；confirm（极端压力口径：要求价格持续在止盈价之外）下 M1 期望 ${sens[sens.length - 1].expectancyBps}bps、回撤 ${sens[sens.length - 1].maxDDPct}% → 说明本策略的止盈高度依赖「bar 内触及即成交」`);
  md.push('- 未做/未验证：真实盘口排队深度（1H K 线无法分辨 bar 内路径与队列位置）；实盘要在调度器侧挂 post_only 限价（B 侧文件，本树未改）', '');
  md.push('## 6. 假设与建模口径（供复核）', '');
  for (const n of report.notes) md.push(`- ${n}`);
  md.push('');
  fs.writeFileSync(mdFile, md.join('\n'), 'utf8');

  console.log('\n' + '='.repeat(120));
  console.log('组合对比：');
  console.log(fmtTable(combo, COLS));
  console.log('\n成交率敏感性：');
  console.log(fmtTable(sens, SENS_COLS));
  console.log('\n费率档稳健性：');
  console.log(fmtTable(feeRobust, [
    { h: '费率档', w: 20, get: (r) => r.name }, { h: 'Δ期望bps', w: 10, get: (r) => r.deltaBps },
    { h: 'M1期望bps', w: 11, get: (r) => r.m1ExpectancyBps }, { h: 'M1回撤%', w: 9, get: (r) => r.m1MaxDDPct },
    { h: '平衡成交率p*', w: 12, get: (r) => (r.breakEvenFillRate === null ? '无' : r.breakEvenFillRate) },
  ]));
  console.log('\n' + '='.repeat(120));
  console.log(`判定：${verdictOneLine}`);
  console.log(`报告：${outFile}`);
  console.log(`表格：${mdFile}`);
  console.log('='.repeat(120) + '\n');
  return report;
}

if (require.main === module) main().catch((e) => { console.error('验证失败：', e && e.stack || e); process.exit(1); });
module.exports = { LIVE, GROUPS, PROB_GRID, breakEvenProb, row };
