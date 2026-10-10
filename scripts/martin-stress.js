/*!
 * scripts/martin-stress.js - william-bot-1-core key backtest/optimize logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-BD034C0D
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
#!/usr/bin/env node
/**
 * scripts/martin-stress.js —— 上线前最后一关：三张压力表
 *
 *  表 1  滑点敏感度：手续费固定 8bps，滑点 0/1/2/3/5 bps 逐次成交施加 → 判定「edge 在 ≤X bps 滑点下仍为正」
 *  表 2  样本外：n 折 walk-forward（逐折重置篮子与权益，折内只用 i-1 及更早）→ OOS 期望 vs 全样本
 *  表 3  尾部压力：
 *        3a 真实最差窗口：每个品种按 1H/4H/24H 跌幅排最差窗口，非重叠取前 N 个 → 期间是否开篮/最深几层/是否止损爆仓/该窗口盈亏
 *        3b 合成黑天鹅：人为插入一根 −20% 的 1H K 线（报告里明确标注「合成场景」）→ 硬止损是否兜住、是否爆仓
 *
 * 用法：
 *   PROXY_URL=http://127.0.0.1:17890 node scripts/martin-stress.js --days 350 \
 *     [--fee 8] [--equity 10000] [--slips 0,1,2,3,5] [--folds 5] [--top 10] [--out data/stress-martin-YYYYMMDD.json]
 */
'use strict';

if (!process.env.PROXY_URL && !process.env.HTTPS_PROXY) process.env.PROXY_URL = 'http://127.0.0.1:17890';

const fs = require('fs');
const path = require('path');
const martin = require('../modules/martin');
const bt = require('./martin-backtest');
const { okxGet } = require('../modules/okx-data');
const uni = require('../modules/universe');

const DATA_DIR = path.join(__dirname, '..', 'data');
const round = (v, n = 4) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(n)) : null);
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const iso = (ts) => new Date(ts).toISOString().replace('T', ' ').slice(0, 16);
const pad = (s, n) => String(s).padEnd(n);
const num = (v, n = 2) => (v === null || v === undefined ? '--' : Number(v).toFixed(n));

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
const flag = (n) => process.argv.includes('--' + n);

/* ── 数据装载（与回测同源） ─────────────────────── */
async function loadData(days) {
  const targetBars = Math.ceil(days * 24);
  const swaps = await uni.allSwaps();
  const instMap = new Map(swaps.map((d) => [d.instId, d]));
  const data = [];
  for (const instId of bt.ALL) {
    const ins = instMap.get(instId);
    if (!ins) continue;
    const { rows: candles } = await bt.fetchCandles(instId, '1H', targetBars, null);
    if (candles.length < 320) continue;
    const { rows: funding } = await bt.fetchFunding(instId, candles[0].ts, null);
    data.push({
      instId, sector: bt.sectorOf(instId), funding, candles,
      instrument: { ctVal: +ins.ctVal, lotSz: +ins.lotSz, minSz: +ins.minSz, maxLever: +ins.lever },
      ind: bt.buildIndicators(candles),
    });
  }
  return data;
}

/* ── 表 1：滑点敏感度 ───────────────────────────── */
function tableSlippage(data, { policy, equity0, feeBps, slips }) {
  const rows = slips.map((s) => {
    const r = bt.simulate({ data, policy, equity0, feeBps, slipBps: s, fundingIncluded: true });
    const m = r.summary;
    return { slipBps: s, trades: m.trades, expectancyUsd: m.expectancyUsd, expectancyPct: m.expectancyPct, profitFactor: m.profitFactor, maxDrawdownPct: m.maxDrawdownPct, winRate: m.winRate, totalFeesUsd: m.totalFeesUsd, netPnlUsd: m.netPnlUsd };
  });
  const pos = rows.filter((r) => r.expectancyUsd !== null && r.expectancyUsd > 0);
  const maxPosSlip = pos.length ? Math.max(...pos.map((r) => r.slipBps)) : null;
  // 线性插值求盈亏平衡滑点
  let breakEvenSlipBps = null;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    if (a.expectancyUsd > 0 && b.expectancyUsd <= 0) {
      breakEvenSlipBps = round(a.slipBps + ((0 - a.expectancyUsd) * (b.slipBps - a.slipBps)) / (b.expectancyUsd - a.expectancyUsd), 2);
    }
  }
  const smallestNonZero = rows.find((r) => r.slipBps > 0);
  const verdict = maxPosSlip === null
    ? 'edge 在 0bps 滑点下已为负 —— 直接不建议实盘'
    : (smallestNonZero && smallestNonZero.expectancyUsd <= 0
      ? `edge 过薄：连 ${smallestNonZero.slipBps}bps 滑点都扛不住，不建议实盘`
      : `edge 在 ≤${maxPosSlip}bps 滑点下仍为正${breakEvenSlipBps !== null ? `（盈亏平衡滑点 ≈ ${breakEvenSlipBps}bps）` : '（测试范围内未转负）'}`);
  return { rows, maxPositiveSlipBps: maxPosSlip, breakEvenSlipBps, verdict };
}

/* ── 表 3a：真实最差跌幅窗口 ─────────────────────── */
function worstWindows(data, horizonBars, topN, lookbackBars) {
  const cands = [];
  for (const d of data) {
    const cs = d.candles;
    // 只看「预热期之后」的窗口：ind 在 i < LOOKBACK 时为 null，那段策略根本不可能开仓，
    // 拿它当「策略躲过了崩盘」是假象，必须排除。
    const startIdx = Math.max(horizonBars, lookbackBars) + 1;
    for (let i = startIdx; i < cs.length; i++) {
      const ret = cs[i].c / cs[i - horizonBars].c - 1;
      let lo = Infinity, hi = -Infinity;
      for (let k = i - horizonBars; k <= i; k++) { if (cs[k].l < lo) lo = cs[k].l; if (cs[k].h > hi) hi = cs[k].h; }
      cands.push({ instId: d.instId, from: cs[i - horizonBars].ts, to: cs[i].ts, ret, low: lo, high: hi });
    }
  }
  cands.sort((a, b) => a.ret - b.ret);
  const picked = [];
  for (const c of cands) {
    if (picked.length >= topN) break;
    // 同品种内不重叠（避免同一段暴跌连续刷榜）
    if (picked.some((p) => p.instId === c.instId && !(c.to <= p.from || c.from >= p.to))) continue;
    picked.push(c);
  }
  return picked;
}

function annotateWindow(w, trades, instById) {
  const opened = trades.filter((t) => t.instId === w.instId && Date.parse(t.openedAt) <= w.to && Date.parse(t.closedAt) >= w.from);
  const deepest = opened.length ? Math.max(...opened.map((t) => t.levels)) : 0;
  const stops = opened.filter((t) => t.reason === 'stop_loss').length;
  const liqs = opened.filter((t) => t.reason === 'liquidation').length;
  const pnl = opened.reduce((a, t) => a + t.pnlUsd, 0);
  return {
    instId: w.instId, from: iso(w.from), to: iso(w.to), dropPct: round(w.ret * 100, 2),
    baskets: opened.length, deepestLevel: deepest,
    stopLoss: stops, liquidations: liqs,
    windowPnlUsd: round(pnl, 2),
    maxLevelsCap: instById[w.instId] ? undefined : undefined,
  };
}

/* ── 表 3b：合成黑天鹅 ─────────────────────────── */
/** 在 atTs 处插入一根 dropPct% 的 1H K 线，并把其后所有 K 线整体平移同一比例（保持序列连续） */
function crashData(data, atTs, dropPct) {
  const factor = 1 + dropPct / 100;
  return data.map((d) => {
    const cs = d.candles;
    const idx = cs.findIndex((c) => c.ts >= atTs);
    if (idx <= 0) return d;
    const prevClose = cs[idx - 1].c;
    const out = cs.map((c, i) => {
      if (i < idx) return c;
      if (i === idx) {
        const cLow = prevClose * factor, cHigh = prevClose;
        return { ts: c.ts, o: prevClose, h: cHigh, l: cLow, c: cLow, v: c.v };
      }
      return { ts: c.ts, o: c.o * factor, h: c.h * factor, l: c.l * factor, c: c.c * factor, v: c.v };
    });
    return { ...d, candles: out, ind: bt.buildIndicators(out) };
  });
}

function crashReport(name, data, atTs, dropPct, { policy, equity0, feeBps, baseRun }) {
  const crashed = crashData(data, atTs, dropPct);
  const r = bt.simulate({ data: crashed, policy, equity0, feeBps, slipBps: 0, fundingIncluded: true });
  // 被砸到的篮子：开仓早于崩盘、平仓晚于崩盘
  const hit = r.trades.filter((t) => Date.parse(t.openedAt) <= atTs && Date.parse(t.closedAt) >= atTs);
  const barOf = {};
  for (const d of crashed) {
    const c = d.candles.find((x) => x.ts >= atTs);
    if (c) barOf[d.instId] = c;
  }
  const detail = hit.map((t) => {
    const qty = t.levelsDetail.reduce((a, l) => a + l.contracts, 0) * (crashed.find((x) => x.instId === t.instId).instrument.ctVal);
    const dir = t.side === 'long' ? 1 : -1;
    const adverse = (t.side === 'long' && dropPct < 0) || (t.side === 'short' && dropPct > 0);
    const bar = barOf[t.instId];
    // 只有「在本根崩盘 K 线上就离场」的篮子才能用跳空口径对比；
    // 若过了几根才被止损（序列整体平移的影响），拿本根极值比就没意义。
    const sameBarExit = bar ? Date.parse(t.closedAt) === bar.ts : false;
    const worstPx = bar ? (t.side === 'long' ? bar.l : bar.h) : t.closePrice;
    const useWorst = adverse && sameBarExit;
    const worstPnl = useWorst ? (worstPx - t.avgPx) * qty * dir - t.feesUsd - t.fundingUsd : null;
    return {
      instId: t.instId, side: t.side, levels: t.levels, reason: t.reason, adverse, sameBarExit,
      pnlUsd: t.pnlUsd,
      pessimisticPnlUsd: worstPnl === null ? null : round(worstPnl, 2),
      pessimisticNote: !adverse
        ? '不适用：崩盘方向对该篮有利'
        : (sameBarExit ? '按崩盘那根极值成交（模拟跳空穿越止损）' : '不适用：在崩盘后第 N 根才离场，与本根极值不可比'),
      closePrice: t.closePrice, pessimisticFillPx: useWorst ? round(worstPx, 8) : null,
    };
  });
  const pnlDelta = round(r.summary.netPnlUsd - baseRun.summary.netPnlUsd, 2);
  return {
    scenario: name, synthetic: true, atTs: iso(atTs), dropPct,
    note: `⚠ 合成场景：人为把 ${iso(atTs)} 起的行情整体下移 ${dropPct}%（该根 1H 跌幅 ${dropPct}%），其后 K 线等比平移`,
    basketsHit: detail.length,
    detail,
    stopLossTotal: r.summary.stopLossCount, liquidationTotal: r.summary.liquidationCount,
    equityEnd: r.summary.endEquity, netPnlUsd: r.summary.netPnlUsd,
    pnlVsBaselineUsd: pnlDelta,
    hardStopHeld: detail.length > 0 ? detail.every((d) => d.reason !== 'liquidation') : null,
  };
}

/* ── 主流程 ───────────────────────────────────── */
async function main() {
  const days = Number(arg('days', 350));
  const feeBps = Number(arg('fee', 8));
  const equity0 = Number(arg('equity', 10000));
  const slips = arg('slips', '0,1,2,3,5').split(',').map(Number).filter((x) => Number.isFinite(x));
  const folds = Number(arg('folds', 5));
  const topN = Number(arg('top', 10));
  const outFile = arg('out', path.join(DATA_DIR, `stress-martin-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`));

  console.log(`\n${'='.repeat(104)}`);
  console.log(`类马丁压力测试 · ${days} 天 · 权益 $${equity0} · 手续费 ${feeBps}bps 往返 · 滑点 ${slips.join('/')}bps · walk-forward ${folds} 折`);
  console.log(`代理 ${process.env.PROXY_URL}`);
  console.log('='.repeat(104));

  const t0 = Date.now();
  const data = await loadData(days);
  if (!data.length) { console.error('无数据'); process.exit(2); }
  const bars = Math.min(...data.map((d) => d.candles.length));
  const winEnd = Math.min(...data.map((d) => d.candles[d.candles.length - 1].ts));
  const winStart = Math.max(...data.map((d) => d.candles[0].ts));
  console.log(`数据：${data.length} 个品种 · 公共窗口 ${iso(winStart)} → ${iso(winEnd)} · 约 ${round((winEnd - winStart) / 86400e3, 1)} 天 / ${bars} 根 1H（${((Date.now() - t0) / 1000).toFixed(0)}s）\n`);

  const policy = bt.BASE_POLICY;
  const baseRun = bt.simulate({ data, policy, equity0, feeBps, slipBps: 0, fundingIncluded: true });
  const instById = Object.fromEntries(data.map((d) => [d.instId, d.instrument]));

  /* ── 表 1 ── */
  const slipRes = tableSlippage(data, { policy, equity0, feeBps, slips });
  console.log('【表 1】滑点敏感度（手续费固定 %dbps，滑点逐次成交施加：买入上浮/卖出下浮）', feeBps === 8 ? 8 : feeBps);
  console.log(`  ${pad('滑点bps', 10)}${pad('笔数', 8)}${pad('期望USD', 12)}${pad('期望%', 10)}${pad('PF', 8)}${pad('胜率%', 9)}${pad('最大回撤%', 11)}${pad('净盈亏USD', 12)}`);
  console.log('  ' + '-'.repeat(80));
  for (const r of slipRes.rows) {
    console.log(`  ${pad(r.slipBps, 10)}${pad(r.trades, 8)}${pad(num(r.expectancyUsd, 4), 12)}${pad(num(r.expectancyPct, 4), 10)}${pad(num(r.profitFactor, 3), 8)}${pad(num(r.winRate, 2), 9)}${pad(num(r.maxDrawdownPct, 2), 11)}${pad(num(r.netPnlUsd, 0), 12)}`);
  }
  console.log(`  → 判定：${slipRes.verdict}\n`);

  /* ── 表 2 ── */
  const wf = bt.walkForward({ data, policy, equity0, feeBps, fundingIncluded: true, slipBps: 0, folds });
  console.log(`【表 2】样本外：${folds} 折 walk-forward（逐折重置篮子/权益，折内只用 i-1 及更早）`);
  console.log(`  ${pad('折', 5)}${pad('区间', 36)}${pad('笔数', 8)}${pad('期望USD', 12)}${pad('期望%', 10)}${pad('胜率%', 9)}${pad('PF', 8)}${pad('回撤%', 9)}`);
  console.log('  ' + '-'.repeat(92));
  for (const f of wf.folds) {
    const s = f.summary;
    console.log(`  ${pad(f.fold, 5)}${pad(f.from + ' → ' + f.to, 36)}${pad(s.trades, 8)}${pad(num(s.expectancyUsd, 4), 12)}${pad(num(s.expectancyPct, 4), 10)}${pad(num(s.winRate, 2), 9)}${pad(num(s.profitFactor, 3), 8)}${pad(num(s.maxDrawdownPct, 2), 9)}`);
  }
  const full = baseRun.summary;
  const oosRel = full.expectancyPct ? round((wf.oos.expectancyPct / full.expectancyPct - 1) * 100, 1) : null;
  console.log(`  OOS 汇总：期望 ${num(wf.oos.expectancyUsd, 4)} USD/笔（${num(wf.oos.expectancyPct, 4)}%）· 胜率 ${num(wf.oos.winRate, 2)}% · PF ${num(wf.oos.profitFactor, 3)} · 正收益折 ${wf.oos.foldsPositive}/${wf.oos.folds} · 最差折回撤 ${num(wf.oos.worstFoldDDPct, 2)}%`);
  console.log(`  对比全样本 ${num(full.expectancyPct, 4)}%：OOS ${oosRel !== null && oosRel >= 0 ? '+' : ''}${oosRel}%（OOS ${wf.oos.expectancyPct > 0 ? '仍为正' : '已转负'}）\n`);

  /* ── 表 3a ── */
  console.log('【表 3a】真实最差跌幅窗口（每个品种按跌幅排序、同品种不重叠，取前 %d 个/档）', topN);
  console.log(`  注：已排除指标预热期（前 ${bt.LOOKBACK} 根 ≈ ${(bt.LOOKBACK / 24).toFixed(1)} 天，ind 为 null、不可能开仓）内的窗口`);
  const tail = {};
  for (const [label, hb] of [['1H', 1], ['4H', 4], ['24H', 24]]) {
    const ws = worstWindows(data, hb, topN, bt.LOOKBACK);
    tail[label] = ws.map((w) => annotateWindow(w, baseRun.trades, instById));
    console.log(`  ── ${label} 跌幅最大 ${ws.length} 个窗口 ──`);
    console.log(`  ${pad('品种', 18)}${pad('区间', 36)}${pad('跌幅%', 9)}${pad('开篮', 6)}${pad('最深层', 8)}${pad('止损', 6)}${pad('爆仓', 6)}${pad('窗口盈亏USD', 12)}`);
    console.log('  ' + '-'.repeat(98));
    for (const a of tail[label]) {
      console.log(`  ${pad(a.instId, 18)}${pad(a.from + ' → ' + a.to, 36)}${pad(num(a.dropPct, 2), 9)}${pad(a.baskets, 6)}${pad(a.deepestLevel || '--', 8)}${pad(a.stopLoss, 6)}${pad(a.liquidations, 6)}${pad(num(a.windowPnlUsd, 1), 12)}`);
    }
    const hit = tail[label].filter((a) => a.baskets > 0).length;
    const liq = tail[label].reduce((a, x) => a + x.liquidations, 0);
    console.log(`  → ${label}：${ws.length} 个最差窗口里 ${hit} 个期间持有篮子；共爆仓 ${liq} 次；窗口盈亏合计 ${num(tail[label].reduce((a, x) => a + x.windowPnlUsd, 0), 1)} USD\n`);
  }

  /* ── 表 3b：合成黑天鹅 ── */
  const midTs = winStart + Math.round((winEnd - winStart) / 2 / 3600e3) * 3600e3;
  const midOf = (t) => (t ? Math.round((Date.parse(t.openedAt) + Date.parse(t.closedAt)) / 2 / 3600e3) * 3600e3 : null);
  const deepestOf = (side) => baseRun.trades.filter((t) => t.side === side).reduce((a, t) => (a === null || t.levels > a.levels ? t : a), null);
  const deepLong = deepestOf('long');
  const deepShort = deepestOf('short');
  const scenarios = [
    crashReport('合成黑天鹅 @窗口中间（-20% 崩盘）', data, midTs, -20, { policy, equity0, feeBps, baseRun }),
    deepLong && crashReport(`合成黑天鹅 @最深层多单持仓期（-20% 崩盘，对持仓不利）${deepLong.instId} ${deepLong.levels}层`, data, midOf(deepLong), -20, { policy, equity0, feeBps, baseRun }),
    deepShort && crashReport(`合成黑天鹅 @最深层空单持仓期（+20% 急拉，对持仓不利）${deepShort.instId} ${deepShort.levels}层`, data, midOf(deepShort), +20, { policy, equity0, feeBps, baseRun }),
  ].filter(Boolean);
  const crashMid = scenarios[0];
  const crashDeep = scenarios[1] || scenarios[0];
  console.log('【表 3b】合成黑天鹅（⚠ 非真实行情，人为插入一根 ±20% 的 1H K 线）');
  for (const c of scenarios) {
    console.log(`  ── ${c.scenario}（${c.atTs}）──`);
    console.log(`     被砸到的篮子 ${c.basketsHit} 个｜止损总数 ${c.stopLossTotal}｜爆仓总数 ${c.liquidationTotal}｜期末权益 ${num(c.equityEnd, 0)}｜净盈亏对比基准 ${num(c.pnlVsBaselineUsd, 0)} USD`);
    if (c.detail.length) {
      console.log(`     ${pad('品种', 18)}${pad('方向', 7)}${pad('层数', 6)}${pad('平仓原因', 13)}${pad('实际盈亏', 11)}${pad('跳空悲观口径', 34)}`);
      for (const d of c.detail) {
        console.log(`     ${pad(d.instId, 18)}${pad(d.side, 7)}${pad(d.levels, 6)}${pad(d.reason, 13)}${pad(num(d.pnlUsd, 1), 11)}${pad(d.pessimisticPnlUsd === null ? (d.adverse ? '不适用（非本根离场）' : '不适用（方向有利）') : num(d.pessimisticPnlUsd, 1), 34)}`);
      }
      const adverse = c.detail.filter((d) => d.adverse);
      const comparable = adverse.filter((d) => d.pessimisticPnlUsd !== null);
      if (adverse.length) {
        console.log(`     → 其中对持仓不利的 ${adverse.length} 个：实际 ${num(adverse.reduce((a, d) => a + d.pnlUsd, 0), 1)} USD`);
        if (comparable.length) console.log(`       可比跳空悲观口径 ${comparable.length} 个：实际 ${num(comparable.reduce((a, d) => a + d.pnlUsd, 0), 1)} USD → 悲观口径合计 ${num(comparable.reduce((a, d) => a + d.pessimisticPnlUsd, 0), 1)} USD`);
        else console.log('       无可比跳空样本（不利篮子均在崩盘后第 N 根才离场）');
      } else console.log('     → 本次崩盘方向对所有持仓篮子都有利（未构成不利冲击）');
    } else {
      console.log('     崩盘时点没有持仓篮子（本轮未被砸到）');
    }
    console.log(`     硬止损是否兜住（无爆仓）：${c.hardStopHeld === null ? '不适用' : c.hardStopHeld ? '是' : '否 —— 出现爆仓'}`);
  }
  console.log('');

  /* ── 落盘 ── */
  const report = {
    ok: true, generatedAt: new Date().toISOString(),
    days, feeBps, equity0, slips, folds, topN,
    window: { from: iso(winStart), to: iso(winEnd), bars, symbols: data.length },
    symbols: data.map((d) => d.instId),
    policy,
    baseline: { summary: full, perSymbol: baseRun.perSymbol, verdict: baseRun.verdict },
    slippage: slipRes,
    walkForward: { folds: wf.folds.map((f) => ({ fold: f.fold, from: f.from, to: f.to, days: f.days, ...f.summary })), oos: wf.oos, oosVsFullPct: oosRel },
    tailWindows: tail,
    syntheticBlackSwan: scenarios,
    notes: [
      '滑点口径：每次成交（开/加/止盈/止损/平仓）都按不利方向推 slip bps，叠在手续费之上',
      '⚠ 合成黑天鹅为人为构造场景，不代表历史真实行情，仅用于检验风控兜底能力',
      '止损按止损价成交；若真实行情跳空穿越止损价，实际亏损会按「跳空悲观口径」列（按崩盘那根极值成交）',
      '资金费率受 OKX 历史深度限制（约 3 个月），未覆盖区间按 0 计',
    ],
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2), 'utf8');
  console.log(`${'='.repeat(104)}`);
  console.log(`报告：${outFile}`);
  console.log(`${'='.repeat(104)}\n`);
  return report;
}

if (require.main === module) main().catch((e) => { console.error('压力测试失败：', (e && e.stack) || e); process.exit(1); });

module.exports = { loadData, tableSlippage, worstWindows, crashData, crashReport };
