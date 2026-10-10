/*!
 * scripts/martin-profit-apply.js - william-bot-1-core key backtest/optimize logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-0886165B
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
#!/usr/bin/env node
/**
 * scripts/martin-profit-apply.js —— 把选型结果算成「可立即落地」的对照表（只读计算，不改线上）
 * 线上现状（policy.json 实测值）vs 可安全落地的候选（不含 5x，因交易所仍是 3x）
 */
'use strict';
if (!process.env.PROXY_URL && !process.env.HTTPS_PROXY) process.env.PROXY_URL = 'http://127.0.0.1:17890';
const bt = require('./martin-backtest');
const sw1 = require('./martin-profit-sweep');

/** 线上现状：/opt/wb-core/data/policy.json 实测（2026-09-21 17:21） */
const LIVE_EXACT = {
  firstMarginPct: 0.6, leverage: 3, marginMode: 'isolated', spacingMode: 'atr', spacingAtrMult: 1, spacingPct: 0.8,
  multiplier: 1.5, maxLevels: 5, takeProfitPct: 0, hardStopPct: 3, timeStopHours: 48, cooldownHours: 4,
  maxBaskets: 5, dailyLossPct: 5, maxFundingAbs: 0.001, minAtrPct: 0.4, maxAtrPct: 8, mmr: 0.005, blackSwanPct: 5,
  entryZMin: 0, entryZWin: 20, entryZMode: 'revert', tpAtrMult: 0.5, tpMinPct: 0.4, tpMaxPct: 2, makerFirst: 'off',
  sizingMode: 'risk', basketRiskBudgetPct: 4, maxTotalOccupancyPct: 45, riskK: 1.2, deathAtrMult: 6, maxBasketRiskPct: 3,
};
const GEOM = { ...LIVE_EXACT, multiplier: 2, maxLevels: 4, spacingAtrMult: 0.8, takeProfitPct: 0.8, dailyLossPct: 4 };
/** 2×2 因子：几何/止盈口径 × 仓位组合，用于把“到底哪个旋钮起作用”拆开 */
const G0 = { ...LIVE_EXACT };                                    // 线上几何 + ATR 止盈
const G0F = { ...LIVE_EXACT, takeProfitPct: 0.8 };               // 线上几何 + 固定止盈
const G2 = { ...LIVE_EXACT, multiplier: 2, maxLevels: 4, spacingAtrMult: 0.8, dailyLossPct: 4 };  // 新几何 + ATR 止盈
const G3 = { ...GEOM };                                          // 新几何 + 固定止盈
const S = { s0: {}, s1: { basketRiskBudgetPct: 6, maxBaskets: 2 }, s2: { basketRiskBudgetPct: 8, maxBaskets: 2 }, s3: { basketRiskBudgetPct: 6, maxBaskets: 2, maxBasketRiskPct: 2 }, s4: { basketRiskBudgetPct: 8, maxBaskets: 2, maxBasketRiskPct: 2 } };
const SETS = [
  ['现状：线上几何+ATR止盈 · 4%/5篮/兜底3%', { ...G0, ...S.s0 }],
  ['线上几何+ATR · 6%/2篮/兜底3%', { ...G0, ...S.s1 }],
  ['线上几何+ATR · 8%/2篮/兜底3%', { ...G0, ...S.s2 }],
  ['线上几何+ATR · 6%/2篮/兜底2%', { ...G0, ...S.s3 }],
  ['线上几何+ATR · 8%/2篮/兜底2%', { ...G0, ...S.s4 }],
  ['新几何+ATR · 6%/2篮/兜底3%', { ...G2, ...S.s1 }],
  ['新几何+ATR · 8%/2篮/兜底3%', { ...G2, ...S.s2 }],
  ['新几何+ATR · 6%/2篮/兜底2%', { ...G2, ...S.s3 }],
  ['新几何+ATR · 8%/2篮/兜底2%', { ...G2, ...S.s4 }],
  ['新几何+固定 · 6%/2篮/兜底3%', { ...G3, ...S.s1 }],
  ['新几何+固定 · 8%/2篮/兜底3%', { ...G3, ...S.s2 }],
];

(async () => {
  const data = await sw1.loadData(350, true, (s) => console.log(s));
  const bars = Math.min(...data.map((d) => d.candles.length));
  const days = bars / 24, eq = 10000;
  const rows = [];
  for (const [name, pol] of SETS) {
    const r = bt.simulate({ data, policy: pol, equity0: eq, feeBps: 8, fundingIncluded: true, trackOccupancy: true });
    const wf = bt.walkForward({ data, policy: pol, equity0: eq, feeBps: 8, fundingIncluded: true, folds: 5 });
    const slip5 = bt.simulate({ data, policy: pol, equity0: eq, feeBps: 8, fundingIncluded: true, slipBps: 5 });
    const small = bt.simulate({ data, policy: pol, equity0: 113, feeBps: 8, fundingIncluded: true });
    const m = sw1.metrics(r, days, eq, 8), ms = sw1.metrics(slip5, days, eq, 8), mm = sw1.metrics(small, days, 113, 8);
    const oosBps = Number((wf.oos.expectancyPct * 100).toFixed(4));
    rows.push({ name, policy: pol, exp: m.expectancyBps, dd: m.maxDDPct, eff: Number((m.expectancyBps / Math.abs(m.maxDDPct)).toFixed(4)), net: m.netPnlUsd, pf: m.profitFactor, stop: m.stopLoss, liq: m.liquidation, oosBps, oosPos: wf.oos.foldsPositive, worstFold: wf.oos.worstFoldDDPct, slip5: ms.expectancyBps, occMax: r.occupancy.maxPct, occMean: r.occupancy.meanPct, above100: r.occupancy.above100SharePct, smallBps: mm.expectancyBps, tradesDay: m.tradesPerDay });
    const x = rows[rows.length - 1];
    console.log(`  · ${name.padEnd(46)} 期望 ${String(x.exp).padStart(5)}bps · 回撤 ${String(x.dd).padStart(6)}% · 效率 ${String(x.eff).padStart(5)} · PF ${String(x.pf).padStart(5)} · 止损 ${String(x.stop).padStart(3)} · OOS ${String(x.oosBps).padStart(5)} ${x.oosPos}/5 · slip5 ${String(x.slip5).padStart(5)} · 占用峰 ${String(x.occMax).padStart(5)}% />100 ${x.above100} · 113U ${x.smallBps}bps`);
  }
  console.log('\n' + '='.repeat(160));
  const cols = [
    { l: '方案', w: 46, g: (r) => r.name }, { l: '期望bps', w: 9, g: (r) => r.exp }, { l: '回撤%', w: 8, g: (r) => r.dd },
    { l: '效率', w: 7, g: (r) => r.eff }, { l: 'PF', w: 6, g: (r) => r.pf }, { l: '止损', w: 5, g: (r) => r.stop },
    { l: 'OOSbps', w: 8, g: (r) => r.oosBps }, { l: '正折', w: 5, g: (r) => `${r.oosPos}/5` }, { l: '最差折%', w: 8, g: (r) => r.worstFold },
    { l: 'slip5bps', w: 9, g: (r) => r.slip5 }, { l: '占用峰%', w: 9, g: (r) => r.occMax }, { l: '占用均%', w: 9, g: (r) => r.occMean },
    { l: '>100%', w: 7, g: (r) => r.above100 }, { l: '113Ubps', w: 9, g: (r) => r.smallBps }, { l: '笔/日', w: 7, g: (r) => r.tradesDay },
  ];
  console.log(cols.map((c) => String(c.l).padStart(c.w)).join(''));
  for (const r of rows) console.log(cols.map((c) => String(c.g(r)).padStart(c.w)).join(''));
  require('fs').writeFileSync(require('path').join(__dirname, '..', 'data', 'profit-apply-20260921.json'), JSON.stringify({ ok: true, generatedAt: new Date().toISOString(), days, rows }, null, 2));
  console.log('\n落盘：data/profit-apply-20260921.json');
})().catch((e) => { console.error(e); process.exit(1); });
