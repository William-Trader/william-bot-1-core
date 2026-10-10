/*!
 * scripts/martin-profit-sweep2.js - william-bot-1-core key backtest/optimize logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-C47E0FC1
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
#!/usr/bin/env node
/**
 * scripts/martin-profit-sweep2.js —— 盈利能力第二轮：把「赚钱总量 / 风险效率」做上去
 *
 * 第一轮结论（data/profit-opt-report-20260921.md）：
 *   · z 门槛能把单笔期望抬到 3.52bps，但交易量 −82%、总盈利 −82%（单笔视角 ≠ 账户视角）
 *   · 波动止盈 ATR×0.5 不抬单笔期望，但净利 +40%、回撤 −32%（唯一真提升账户的改动）
 *   · maker 优先净收益为负
 * 本轮换目标函数：**净盈亏 / 收益÷回撤**（账户视角），并新增两项能力：
 *   A) 「实盘口径风险仓位」——sizingMode='risk' 走 modules/margin.planBasket（风险预算反解 + 占用上限），
 *      回测尺寸与实盘同口径（默认关，旧口径逐字节不变）
 *   B) 选参诚实性协议：前 70% 窗口选参 → 后 30% 留出验证 + 5 折 walk-forward + 滑点压力
 *
 * 用法
 *   PROXY_URL=http://127.0.0.1:17890 node scripts/martin-profit-sweep2.js [--days 350] [--equity 10000]
 *     [--fee 8] [--folds 5] [--isSplit 0.7] [--out data/profit-sweep2-YYYYMMDD.json]
 */
'use strict';

if (!process.env.PROXY_URL && !process.env.HTTPS_PROXY) process.env.PROXY_URL = 'http://127.0.0.1:17890';

const path = require('path');
const fs = require('fs');
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

const BASE = { ...bt.BASE_POLICY };
/** 第一轮最优锚：波动止盈 ATR×0.5 */
const ANCHOR = { ...BASE, takeProfitPct: 0, tpAtrMult: 0.5 };
/** 实盘口径（用户给的线上参数）：风险仓位 4%/篮、占用上限 45%、k=1.2、死亡线 6×ATR、金额兜底 3%、5 篮、日亏 4% */
const LIVE = {
  ...ANCHOR, sizingMode: 'risk', basketRiskBudgetPct: 4, maxTotalOccupancyPct: 45, riskK: 1.2,
  deathAtrMult: 6, maxBasketRiskPct: 3, maxBaskets: 5, dailyLossPct: 4,
};

/* ── 诊断：按平仓原因分解盈亏 ─────────────────── */
function byReason(r) {
  const m = new Map();
  for (const t of r.trades) {
    const o = m.get(t.reason) || { reason: t.reason, n: 0, net: 0, wins: 0, levels: 0, fees: 0 };
    o.n++; o.net += t.pnlUsd; if (t.pnlUsd > 0) o.wins++; o.levels += t.levels; o.fees += t.feesUsd;
    m.set(t.reason, o);
  }
  return [...m.values()].map((o) => ({
    reason: o.reason, n: o.n, netUsd: round(o.net, 2), avgUsd: round(o.net / o.n, 4),
    winRate: round((o.wins / o.n) * 100, 2), avgLevels: round(o.levels / o.n, 2), feesUsd: round(o.fees, 2),
  })).sort((a, b) => b.netUsd - a.netUsd);
}

/* ── 选参协议：前 isSplit 选参 → 后段留出验证 ── */
const sliceTo = (data, ts) => data.map((d) => ({ ...d, candles: d.candles.filter((c) => c.ts <= ts) }));

function run3(data, policy, { winStart, winEnd, cut, equity0, feeBps, makerFeeBps = null, slipBps = 0 }) {
  const full = bt.simulate({ data, policy, equity0, feeBps, fundingIncluded: true, slipBps, makerFeeBps });
  const isRun = bt.simulate({ data: sliceTo(data, cut), policy, equity0, feeBps, fundingIncluded: true, slipBps, makerFeeBps });
  const oosRun = bt.simulate({ data: sliceTo(data, winEnd), policy, equity0, feeBps, fundingIncluded: true, slipBps, makerFeeBps, startTs: cut });
  const dFull = (winEnd - winStart) / 86400e3, dIs = (cut - winStart) / 86400e3, dOos = (winEnd - cut) / 86400e3;
  return {
    full: sw1.metrics(full, dFull, equity0, feeBps, makerFeeBps),
    is: sw1.metrics(isRun, dIs, equity0, feeBps, makerFeeBps),
    oos: sw1.metrics(oosRun, dOos, equity0, feeBps, makerFeeBps),
    _runs: { full, isRun, oosRun },
  };
}

const COLS = (extra = []) => [
  { label: '组', w: 30, get: (r) => r.name },
  { label: '笔数', w: 7, get: (r) => r.full.trades },
  { label: '胜率%', w: 7, get: (r) => r.full.winRate },
  { label: '期望bps', w: 8, get: (r) => r.full.expectancyBps },
  { label: 'PF', w: 6, get: (r) => r.full.profitFactor },
  { label: '回撤%', w: 8, get: (r) => r.full.maxDDPct },
  { label: '笔/日', w: 7, get: (r) => r.full.tradesPerDay },
  { label: '净U(全窗)', w: 11, get: (r) => r.full.netPnlUsd },
  { label: '收益/回撤', w: 10, get: (r) => r.full.riskEff },
  { label: 'IS净U', w: 10, get: (r) => r.is.netPnlUsd },
  { label: '留出净U', w: 10, get: (r) => r.oos.netPnlUsd },
  { label: '留出期望bps', w: 12, get: (r) => r.oos.expectancyBps },
  ...extra,
];

function fmt(rows, cols) {
  const out = [cols.map((c) => String(c.label).padStart(c.w)).join('')];
  for (const r of rows) out.push(cols.map((c) => String(c.get(r)).padStart(c.w)).join(''));
  return out.join('\n');
}

async function main() {
  const days = Number(arg('days', 350));
  const equity0 = Number(arg('equity', 10000));
  const feeBps = Number(arg('fee', 8));
  const folds = Number(arg('folds', 5));
  const isSplit = Number(arg('isSplit', 0.7));
  const outFile = arg('out', path.join(DATA_DIR, `profit-sweep2-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`));
  const log = (s) => console.log(s);

  console.log(`\n=== 盈利能力第二轮 · ${days} 天 1H · 权益 $${equity0} · ${feeBps}bps 往返 · 选参 ${(isSplit * 100).toFixed(0)}% 窗口 ===`);
  console.log('[1/5] 载入行情（缓存优先）…');
  const data = await sw1.loadData(days, true, log);
  const winStart = Math.max(...data.map((d) => d.candles[0].ts));
  const winEnd = Math.min(...data.map((d) => d.candles[d.candles.length - 1].ts));
  const cut = winStart + (winEnd - winStart) * isSplit;
  const bars = Math.min(...data.map((d) => d.candles.length));
  const realDays = round(bars / 24, 1);
  console.log(`  标的 ${data.length} · 全窗 ${realDays} 天 · 选参段 ${new Date(cut).toISOString().slice(0, 16)} 前 / 留出段之后`);
  store.ensureDir(DATA_DIR);

  const ctx = { winStart, winEnd, cut, equity0, feeBps };

  /* ── 诊断：基线 vs ATR×0.5 vs 实盘口径，按平仓原因 ── */
  console.log('\n[2/5] 诊断：按平仓原因的盈亏分解 …');
  const diag = {};
  for (const [nm, pol] of [['基线', BASE], ['ATR×0.5', ANCHOR], ['实盘口径(risk+ATR0.5)', LIVE]]) {
    const r = bt.simulate({ data, policy: pol, equity0, feeBps, fundingIncluded: true });
    diag[nm] = { summary: r.summary, byReason: byReason(r), perSymbol: r.perSymbol };
    console.log(`  ${nm}：净 ${r.summary.netPnlUsd}U · 期望 ${sw1.metrics(r, realDays, equity0, feeBps).expectancyBps}bps · 回撤 ${r.summary.maxDrawdownPct}%`);
    for (const b of diag[nm].byReason) console.log(`     ${String(b.reason).padEnd(12)} 笔数 ${String(b.n).padStart(5)} · 净 ${String(b.netUsd).padStart(10)}U · 单笔均 ${String(b.avgUsd).padStart(9)}U · 胜率 ${String(b.winRate).padStart(6)}% · 均层 ${b.avgLevels}`);
  }

  /* ── 网格 ── */
  const grid = [];
  const add = (phase, name, policy, opts = {}) => grid.push({ phase, name, policy, ...opts });
  const A = ANCHOR;

  add('P1 频率/广度', '锚 ATR×0.5', A);
  for (const v of [0, 1, 2, 4, 8]) add('P1 频率/广度', `cooldown=${v}h`, { ...A, cooldownHours: v });
  for (const v of [12, 24, 48, 72]) add('P1 频率/广度', `timeStop=${v}h`, { ...A, timeStopHours: v });
  for (const v of [2, 3, 4, 5]) add('P1 频率/广度', `maxBaskets=${v}`, { ...A, maxBaskets: v });

  for (const v of [0.6, 0.8, 1.0, 1.3, 1.6]) add('P2 几何', `spacing=ATR×${v}`, { ...A, spacingAtrMult: v });
  for (const [tp, sp] of [[0.4, 0.8], [0.4, 1.0], [0.5, 0.8], [0.5, 1.0], [0.5, 1.3], [0.7, 1.0], [0.7, 0.6]]) {
    add('P2 几何', `TP×${tp} spacing×${sp}`, { ...BASE, takeProfitPct: 0, tpAtrMult: tp, spacingAtrMult: sp });
  }
  for (const [mult, lv] of [[1.3, 8], [1.5, 6], [1.5, 8], [1.8, 5], [2.0, 4]]) add('P2 几何', `mult=${mult}/层${lv}`, { ...A, multiplier: mult, maxLevels: lv });

  for (const v of [2, 3, 4, 6]) add('P3 尾部/闸门', `hardStop=${v}%`, { ...A, hardStopPct: v });
  for (const v of [0.0, 0.2, 0.3, 0.6]) add('P3 尾部/闸门', `minAtr=${v}%`, { ...A, minAtrPct: v });
  for (const v of [4, 6, 12]) add('P3 尾部/闸门', `maxAtr=${v}%`, { ...A, maxAtrPct: v });
  for (const v of [4, 8]) add('P3 尾部/闸门', `dailyLoss=${v}%`, { ...A, dailyLossPct: v });

  add('P4 实盘风险仓位', '实盘口径锚', LIVE);
  for (const v of [2, 3, 6]) add('P4 实盘风险仓位', `riskBudget=${v}%`, { ...LIVE, basketRiskBudgetPct: v });
  for (const v of [0.75, 1.0, 1.5]) add('P4 实盘风险仓位', `riskK=${v}`, { ...LIVE, riskK: v });
  for (const v of [30, 60]) add('P4 实盘风险仓位', `占用上限=${v}%`, { ...LIVE, maxTotalOccupancyPct: v });
  for (const v of [3, 4, 8]) add('P4 实盘风险仓位', `死亡线=${v}×ATR`, { ...LIVE, deathAtrMult: v });
  for (const v of [2, 5]) add('P4 实盘风险仓位', `金额兜底=${v}%`, { ...LIVE, maxBasketRiskPct: v });

  console.log(`\n[3/5] 网格 ${grid.length} 组（全窗 + 选参段 + 留出段）…`);
  const t0 = Date.now();
  const rows = [];
  for (const g of grid) {
    const r = run3(data, g.policy, ctx);
    rows.push({ name: g.name, phase: g.phase, policy: g.policy, ...r });
  }
  console.log(`  ${rows.length} 组完成，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  for (const ph of [...new Set(rows.map((r) => r.phase))]) {
    console.log('\n' + '='.repeat(140));
    console.log(`【${ph}】`);
    console.log(fmt(rows.filter((r) => r.phase === ph), COLS()));
  }

  /* ── 选参：只看选参段（IS），再拿留出段与 5 折验证 ── */
  console.log('\n[4/5] 按「选参段净利」排名 → 留出段 + 5 折 OOS + 滑点压力 …');
  const ranked = rows.slice().sort((a, b) => b.is.netPnlUsd - a.is.netPnlUsd);
  const top = ranked.slice(0, 6);
  const candList = [
    { name: '基线（固定止盈 0.8%）', policy: BASE },
    { name: '第一轮锚 ATR×0.5', policy: A },
    { name: '实盘口径（risk+ATR0.5）', policy: LIVE },
    ...top.map((t) => ({ name: `选参最优: ${t.name}`, policy: t.policy })),
  ];
  const cand = [];
  for (const c of candList) {
    const wf = bt.walkForward({ data, policy: c.policy, equity0, feeBps, fundingIncluded: true, slipBps: 0, folds });
    const slip = [2, 5].map((s) => {
      const r = bt.simulate({ data, policy: c.policy, equity0, feeBps, fundingIncluded: true, slipBps: s });
      return { slipBps: s, ...sw1.metrics(r, realDays, equity0, feeBps) };
    });
    const full = rows.find((r) => JSON.stringify(r.policy) === JSON.stringify(c.policy));
    cand.push({
      name: c.name, policy: c.policy,
      full: full ? full.full : sw1.metrics(bt.simulate({ data, policy: c.policy, equity0, feeBps, fundingIncluded: true }), realDays, equity0, feeBps),
      is: full ? full.is : null, oosHoldout: full ? full.oos : null,
      oos5: { ...wf.oos, perFold: wf.folds.map((f) => ({ fold: f.fold, from: f.from, to: f.to, trades: f.summary.trades, winRate: f.summary.winRate, expectancyBps: round(Number(f.summary.expectancyPct) * 100, 4), expectancyUsd: f.summary.expectancyUsd, profitFactor: f.summary.profitFactor, maxDDPct: f.summary.maxDrawdownPct })) },
      slip,
    });
    const o = cand[cand.length - 1];
    console.log(`  · ${c.name.padEnd(28)} 全窗 净 ${String(o.full.netPnlUsd).padStart(10)}U / 回撤 ${String(o.full.maxDDPct).padStart(6)}% ‖ 留出 ${o.oosHoldout ? String(o.oosHoldout.netPnlUsd).padStart(9) : '     n/a'}U ‖ 5折OOS ${String(round(Number(o.oos5.expectancyPct) * 100, 4)).padStart(6)}bps · 正收益折 ${o.oos5.foldsPositive}/${folds} · 最差折 ${o.oos5.worstFoldDDPct}% ‖ slip5bps 净 ${o.slip[1].netPnlUsd}U`);
  }

  const report = {
    ok: true, generatedAt: new Date().toISOString(),
    note: '第二轮：目标函数改为账户视角（净盈亏 / 收益÷回撤）；含实盘风险仓位口径与「选参段→留出段」诚实性协议',
    days: realDays, equity0, feeBps, folds, isSplit, isCut: new Date(cut).toISOString(), symbols: data.map((d) => d.instId),
    diagnostics: diag,
    grid: rows.map((r) => ({ phase: r.phase, name: r.name, policy: r.policy, full: r.full, is: r.is, oosHoldout: r.oos })),
    candidates: cand,
    assumptions: [
      '全部决策只用 i-1 及更早收盘；开仓成交用当根 open',
      'sizingMode=risk 时用 modules/margin.planBasket 反解首层（与实盘同口径），并用占用上限拒绝超限开仓',
      '选参只用「选参段」（前 70% 窗口）的净利排名，留出段（后 30%）与 5 折 walk-forward 只做验证，不参与选择',
      '滑点压力 2/5bps 逐次成交施加，叠在手续费之上',
    ],
  };
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
  report.outFile = outFile;

  console.log('\n' + '='.repeat(140));
  console.log('【候选对照（含诚实性验证与滑点压力）】');
  const cc = [
    { label: '候选', w: 30, get: (r) => r.name },
    { label: '全窗净U', w: 10, get: (r) => r.full.netPnlUsd },
    { label: '全窗回撤%', w: 10, get: (r) => r.full.maxDDPct },
    { label: '全窗期望bps', w: 12, get: (r) => r.full.expectancyBps },
    { label: 'IS净U', w: 10, get: (r) => (r.is ? r.is.netPnlUsd : null) },
    { label: '留出净U', w: 10, get: (r) => (r.oosHoldout ? r.oosHoldout.netPnlUsd : null) },
    { label: '留出期望bps', w: 12, get: (r) => (r.oosHoldout ? r.oosHoldout.expectancyBps : null) },
    { label: '5折OOSbps', w: 11, get: (r) => round(Number(r.oos5.expectancyPct) * 100, 4) },
    { label: '正收益折', w: 9, get: (r) => `${r.oos5.foldsPositive}/${folds}` },
    { label: '最差折回撤%', w: 12, get: (r) => r.oos5.worstFoldDDPct },
    { label: 'slip2净U', w: 10, get: (r) => r.slip[0].netPnlUsd },
    { label: 'slip5净U', w: 10, get: (r) => r.slip[1].netPnlUsd },
  ];
  console.log(fmt(cand, cc));
  console.log('\n' + '='.repeat(140));
  console.log(`报告：${outFile}`);
  return report;
}

if (require.main === module) main().catch((e) => { console.error('扫描失败：', e && e.stack || e); process.exit(1); });
module.exports = { byReason, run3, sliceTo, ANCHOR, LIVE };
