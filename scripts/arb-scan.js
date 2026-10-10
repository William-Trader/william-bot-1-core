/*!
 * scripts/arb-scan.js - william-bot-1-core key backtest/optimize logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-8E1A88C3
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
#!/usr/bin/env node
/**
 * 【脚本】套利扫描（只读；不下单、不签名）
 *
 * 模式：
 *   --mode snapshot   一次性：费率/基差/三角 三条线全跑
 *   --mode funding    资金费率套利（delta 中性）扫描（含 7 天中位数口径）
 *   --mode basis      期现基差（永续 + 交割合约年化）
 *   --mode triangle   三角套利（真实盘口吃单，扣 3 次费）
 *   --mode poll       连续采样（默认 15 分钟 / 每 3 秒一轮）→ 统计「有没有 edge」
 *
 * 关键参数：
 *   --minutes 15 --interval 3 --notional 100 --lever 3 --level Lv1
 *   --slip-bps 0.5      每次成交的不利滑点（默认按盘口 half-spread 估算）
 *   --spot-taker / --swap-taker   覆盖费率（小数，如 0.001）
 *   --out <file>        落盘 JSON（默认打到 stdout）
 *   --quiet             不打人读摘要（stderr）
 *
 * 铁律：全部 GET 类公开接口；每个方向都扣费后判断；空盘口/缺数据降级并标注。
 */
'use strict';

process.env.PROXY_URL = process.env.PROXY_URL || 'http://127.0.0.1:7890';
const fs = require('fs');
const arb = require('../modules/arb');
const universe = require('../modules/universe');

/* ── 参数 ── */
function parseArgs(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const nxt = argv[i + 1];
    if (nxt === undefined || nxt.startsWith('--')) { o[k] = true; continue; }
    o[k] = nxt; i++;
  }
  return o;
}
const A = parseArgs(process.argv);
const MODE = A.mode || 'snapshot';
const MINUTES = Number(A.minutes || 15);
const INTERVAL = Number(A.interval || 3);
const NOTIONAL = Number(A['notional'] || 100);
const LEVER = Number(A.lever || 3);
const LEVEL = A.level || 'Lv1';
const TOP_N = Number(A.top || 25);
const QUIET = Boolean(A.quiet);
const SLIP_OVERRIDE = A['slip-bps'] !== undefined ? Number(A['slip-bps']) : null;
const FEE = arb.fees(LEVEL, {
  ...(A['spot-taker'] !== undefined ? { spotTaker: Number(A['spot-taker']) } : {}),
  ...(A['swap-taker'] !== undefined ? { swapTaker: Number(A['swap-taker']) } : {}),
  ...(A['spot-maker'] !== undefined ? { spotMaker: Number(A['spot-maker']) } : {}),
  ...(A['swap-maker'] !== undefined ? { swapMaker: Number(A['swap-maker']) } : {}),
});
const EQUITY = Number(A.equity || 113);   // 账户可用 USDT（用于「这点钱能做什么」）

const log = (...m) => { if (!QUIET) process.stderr.write(m.join(' ') + '\n'); };
const MAJORS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'BNB', 'LTC', 'ADA', 'LINK', 'AVAX', 'TON', 'TRX'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sum = (a) => a.reduce((x, y) => x + y, 0);
function fixed(x, n = 2) { return x === null || x === undefined || Number.isNaN(x) ? '-' : Number(x).toFixed(n); }
function table(rows, cols) {
  if (!rows.length) return '(空)';
  const w = cols.map((c) => Math.max(c.h.length, ...rows.map((r) => String(c.get(r)).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join(' | ');
  return [line(cols.map((c) => c.h)), w.map((x) => '-'.repeat(x)).join('-+-'), ...rows.map((r) => line(cols.map((c) => c.get(r))))].join('\n');
}

/* ── half-spread 当滑点（bps）── */
function halfSpreadBps(book) { return book && book.ok && book.spreadBps !== null ? arb.toBps(book.spreadBps / 10000) / 2 : null; }

/* ── 资金费率扫描 ── */
async function scanFunding({ withHistory = true } = {}) {
  const [swaps, swapTickers, spotInst, spotTickers] = await Promise.all([
    universe.allSwaps(), arb.tickerMap('SWAP'), arb.spotInstruments(), arb.tickerMap('SPOT'),
  ]);
  const spotSet = new Set(Object.keys(spotInst));
  const rows = swaps.map((ins) => {
    const t = swapTickers[ins.instId];
    if (!t) return null;
    const base = String(ins.instId).split('-')[0];
    return {
      instId: ins.instId, base, last: t.last,
      notional24h: t.volCcy24h * t.last,
      spotPair: `${base}-USDT`, hasSpot: spotSet.has(`${base}-USDT`),
      ctVal: Number(ins.ctVal || 1), minSz: Number(ins.minSz || 0),
    };
  }).filter(Boolean).filter((r) => r.hasSpot).sort((a, b) => b.notional24h - a.notional24h);

  const picked = rows.slice(0, TOP_N);
  const fundings = await arb.fundingBatch(picked.map((r) => r.instId));

  const bookPairs = [];
  for (const r of picked) { bookPairs.push(r.instId, r.spotPair); }
  const { books } = await arb.fetchBooks(bookPairs, { size: 5, concurrency: 6 });

  const withRate = picked.map((r) => ({ ...r, ...(fundings[r.instId] || {}) })).filter((r) => Number.isFinite(r.fundingRate));

  // 历史中位数口径：只对 |当前费率| 最大的前 10 个取（省请求）
  let hist = {};
  if (withHistory) {
    const byAbs = withRate.slice().sort((a, b) => Math.abs(b.fundingRate) - Math.abs(a.fundingRate)).slice(0, 10);
    await Promise.all(byAbs.map(async (r) => { try { hist[r.instId] = await arb.fundingHistoryStat(r.instId, { points: 21 }); } catch (e) { hist[r.instId] = { error: String(e.message).slice(0, 50) }; } }));
  }

  const out = withRate.map((r) => {
    const slipBps = SLIP_OVERRIDE !== null ? SLIP_OVERRIDE
      : (() => { const a = halfSpreadBps(books[r.instId]), b = halfSpreadBps(books[r.spotPair]); return (a === null || b === null) ? 1.0 : +(a + b).toFixed(3); })();
    const h = hist[r.instId];
    const rateStat = h && Number.isFinite(h.median) ? h.median : null;
    const f1 = arb.fundingArb({ rateNow: r.fundingRate, rateStat: null, notional: NOTIONAL, lever: LEVER, fee: FEE, slipBps });
    const f2 = rateStat !== null ? arb.fundingArb({ rateNow: r.fundingRate, rateStat, notional: NOTIONAL, lever: LEVER, fee: FEE, slipBps }) : null;
    return {
      instId: r.instId, spotPair: r.spotPair, notional24h: Math.round(r.notional24h),
      fundingNow: r.fundingRate, history: h ? { n: h.n, median: h.median, positiveShare: h.positiveShare, min: h.min, max: h.max } : null,
      slipBpsUsed: slipBps, spotSpreadBps: books[r.spotPair] ? books[r.spotPair].spreadBps : null, swapSpreadBps: books[r.instId] ? books[r.instId].spreadBps : null,
      now: f1, median: f2,
    };
  }).sort((a, b) => {
    const va = (a.median ? a.median.netAnnualPctOfCapital : a.now.netAnnualPctOfCapital) || -999;
    const vb = (b.median ? b.median.netAnnualPctOfCapital : b.now.netAnnualPctOfCapital) || -999;
    return vb - va;
  });
  return { rows: out, scanned: rows.length, spots: spotTickers ? Object.keys(spotTickers).length : 0 };
}

/* ── 期现基差扫描 ── */
async function scanBasis() {
  const [spotTickers, swapTickers, futures] = await Promise.all([
    arb.tickerMap('SPOT'), arb.tickerMap('SWAP'), arb.futureInstruments('FUTURES'),
  ]);
  const perp = [];
  for (const base of MAJORS) {
    const s = spotTickers[`${base}-USDT`], p = swapTickers[`${base}-USDT-SWAP`];
    if (!s || !p) continue;
    const { books } = await arb.fetchBooks([`${base}-USDT`, `${base}-USDT-SWAP`], { size: 5, concurrency: 4 });
    const hs = (halfSpreadBps(books[`${base}-USDT`]) || 0) + (halfSpreadBps(books[`${base}-USDT-SWAP`]) || 0);
    const slipBps = SLIP_OVERRIDE !== null ? SLIP_OVERRIDE : +hs.toFixed(3);
    const r = arb.basisArb({ spotPx: s.last, perpPx: p.last, fee: FEE, slipBps, lever: LEVER, kind: 'perp' });
    perp.push({ base, spotPx: s.last, perpPx: p.last, spotBid: s.bidPx, spotAsk: s.askPx, perpBid: p.bidPx, perpAsk: p.askPx, slipBps, ...r });
  }
  const fut = [];
  // OKX 交割合约实际都是币本位：BTC-USD-260925（无 -USDT- 交割）；排除 _UM/_UM_XPERP 永续变体
  const FUT_RE = /^([A-Z0-9]+)-(USD|USDC|USDT)-(\d{6})$/;
  for (const [instId, meta] of Object.entries(futures)) {
    const m = FUT_RE.exec(instId);
    if (!m) continue;
    const base = m[1], settle = m[2];
    const s = spotTickers[`${base}-USDT`];
    if (!s || !(meta.daysToExpiry > 0)) continue;
    const fr = await arb.tickerOne(instId).catch(() => null);
    if (!fr || !fr.last) continue;
    const r = arb.basisArb({ spotPx: s.last, perpPx: fr.last, daysToExpiry: meta.daysToExpiry, fee: FEE, slipBps: SLIP_OVERRIDE ?? 1.0, lever: LEVER, kind: 'future' });
    fut.push({ instId, base, settleCcy: settle, daysToExpiry: meta.daysToExpiry, spotPx: s.last, futPx: fr.last, ...r });
  }
  fut.sort((a, b) => (b.annualizedBasisPct ?? -999) - (a.annualizedBasisPct ?? -999));
  return { perp, futures: fut };
}

/* ── 三角套利（一次性）── */
async function scanTriangles({ spotInst = null, spotTickers = null, cycles = null } = {}) {
  const inst = spotInst || await arb.spotInstruments();
  const tick = spotTickers || await arb.tickerMap('SPOT');
  const list = cycles || arb.enumTriangles(inst, { start: 'USDT', hubs: ['BTC', 'ETH'], others: MAJORS, maxPaths: 24 });
  const pairs = [...new Set(list.flatMap((c) => c.pairs))];
  const { books, missing } = await arb.fetchBooks(pairs, { size: 5, concurrency: 8 });
  const lotOf = (p) => (inst[p] ? inst[p].lotSz : 0);
  const rows = list.map((c) => {
    const r = arb.runTriangle({ bookOf: (p) => books[p], pairs: c.pairs, startAsset: 'USDT', startAmount: NOTIONAL, feeTaker: FEE.spotTaker, lotOf });
    return { ...c, ...r, books: c.pairs.map((p) => ({ pair: p, spreadBps: books[p] ? books[p].spreadBps : null })) };
  }).sort((a, b) => (b.netBps ?? -999) - (a.netBps ?? -999));
  return { rows, pairs, missing, cycles: list.length, feePctPerStep: FEE.spotTaker * 100 };
}

/* ── 连续采样 ── */
async function poll() {
  const t0 = Date.now();
  const [spotInst, spotTickers0] = await Promise.all([arb.spotInstruments(), arb.tickerMap('SPOT')]);
  const cycles = arb.enumTriangles(spotInst, { start: 'USDT', hubs: ['BTC', 'ETH'], others: MAJORS, maxPaths: 20 });
  const pairs = [...new Set(cycles.flatMap((c) => c.pairs))];
  const lotOf = (p) => (spotInst[p] ? spotInst[p].lotSz : 0);
  const fundingIds = MAJORS.filter((b) => spotInst[`${b}-USDT`]).slice(0, 6).map((b) => `${b}-USDT-SWAP`);
  const maxRounds = Math.max(1, Math.floor((MINUTES * 60) / INTERVAL));

  const triSeries = {}; for (const c of cycles) triSeries[c.name] = [];
  const fundSeries = {}; for (const id of fundingIds) fundSeries[id] = [];
  const basisSeries = {}; for (const b of MAJORS.slice(0, 6)) basisSeries[b] = [];
  const errors = [];
  let rounds = 0, degraded = 0, swapOk = 0, spotOk = 0;

  while (Date.now() - t0 < MINUTES * 60000 && rounds < maxRounds) {
    const rt = Date.now();
    try {
      const [{ books }, swapTickers, spotTickers, fundings] = await Promise.all([
        arb.fetchBooks(pairs, { size: 5, concurrency: 8 }),
        arb.tickerMap('SWAP'), arb.tickerMap('SPOT'), arb.fundingBatch(fundingIds),
      ]);
      swapOk = Object.keys(swapTickers).length; spotOk = Object.keys(spotTickers).length;
      for (const c of cycles) {
        const r = arb.runTriangle({ bookOf: (p) => books[p], pairs: c.pairs, startAsset: 'USDT', startAmount: NOTIONAL, feeTaker: FEE.spotTaker, lotOf });
        triSeries[c.name].push(r.ok ? r.netBps : null);
        if (!r.ok) degraded++;
      }
      for (const id of fundingIds) {
        const f = fundings[id];
        if (!f || !Number.isFinite(f.fundingRate)) { fundSeries[id].push(null); continue; }
        const a = arb.fundingArb({ rateNow: f.fundingRate, notional: NOTIONAL, lever: LEVER, fee: FEE, slipBps: SLIP_OVERRIDE ?? 1.0 });
        fundSeries[id].push(a.ok ? a.netAnnualPctOfCapital : null);
      }
      for (const b of MAJORS.slice(0, 6)) {
        const s = spotTickers[`${b}-USDT`], p = swapTickers[`${b}-USDT-SWAP`];
        if (!s || !p) { basisSeries[b].push(null); continue; }
        const r = arb.basisArb({ spotPx: s.last, perpPx: p.last, fee: FEE, slipBps: SLIP_OVERRIDE ?? 1.0, lever: LEVER, kind: 'perp' });
        basisSeries[b].push(r.ok ? r.basisBps : null);
      }
      rounds++;
      if (rounds % 20 === 0) log(`  round ${rounds}/${maxRounds} (${((Date.now() - t0) / 1000).toFixed(0)}s) swaps=${swapOk} spots=${spotOk}`);
    } catch (e) {
      errors.push({ round: rounds, at: new Date().toISOString(), error: String(e.message).slice(0, 120) });
    }
    const wait = INTERVAL * 1000 - (Date.now() - rt);
    if (wait > 0) await sleep(wait);
  }

  const triStats = cycles.map((c) => {
    const s = arb.sampleStats(triSeries[c.name], { thresholdBps: 0 });
    const grossVals = triSeries[c.name].filter((x) => Number.isFinite(x));
    const feeBps = 3 * arb.toBps(FEE.spotTaker);
    return { name: c.name, pairs: c.pairs, feeBps, stats: s, series: triSeries[c.name].slice(0, 0) };
  }).sort((a, b) => (b.stats.maxBps ?? -999) - (a.stats.maxBps ?? -999));

  const crossings = sum(triStats.map((c) => c.stats.positive));
  const fundStats = fundingIds.map((id) => ({ instId: id, stats: arb.sampleStats(fundSeries[id], { thresholdBps: 0 }) }));
  const basisStats = Object.keys(basisSeries).map((b) => ({ base: b, stats: arb.sampleStats(basisSeries[b], { thresholdBps: 0 }) }));

  return {
    ok: true, mode: 'poll', startedAt: new Date(t0).toISOString(), endedAt: new Date().toISOString(),
    minutes: MINUTES, intervalSec: INTERVAL, rounds, degradedRounds: degraded, errors: errors.slice(0, 10),
    notional: NOTIONAL, lever: LEVER, level: LEVEL, fee: FEE, equityUsd: EQUITY,
    triangle: { cycles: triStats.length, pairs: pairs.length, crossingRounds: crossings, rows: triStats },
    funding: { ids: fundingIds, rows: fundStats },
    basis: { rows: basisStats },
    verdict: {
      triangleEdge: crossings === 0 ? 'none（采样期内没有任何一轮的净收益 > 0）' : `${crossings} 轮净收益 > 0`,
      triangleFeeHurdleBps: 3 * arb.toBps(FEE.spotTaker),
    },
  };
}

/* ── 主流程 ── */
(async () => {
  const result = {
    ok: true, mode: MODE, at: new Date().toISOString(),
    env: { proxy: process.env.PROXY_URL, level: LEVEL, fee: FEE, notional: NOTIONAL, lever: LEVER, equityUsd: EQUITY, slipOverride: SLIP_OVERRIDE },
  };
  if (MODE === 'funding' || MODE === 'snapshot') {
    log('== 资金费率套利（delta 中性：现货多 + 永续空）==');
    result.fundingScan = await scanFunding();
    log(table(result.fundingScan.rows.slice(0, 15), [
      { h: 'instId', get: (r) => r.instId },
      { h: '费率/期%', get: (r) => fixed(r.fundingNow * 100, 4) },
      { h: '7d中位%', get: (r) => fixed(r.history && r.history.median !== null ? r.history.median * 100 : null, 4) },
      { h: '成本%', get: (r) => fixed(r.now.costPctOfNotional, 3) },
      { h: '回本期数', get: (r) => fixed(r.median ? r.median.breakEvenPeriods : r.now.breakEvenPeriods, 1) },
      { h: '净年化/本金%(median)', get: (r) => fixed(r.median ? r.median.netAnnualPctOfCapital : r.now.netAnnualPctOfCapital, 2) },
      { h: '可执行', get: (r) => ((r.median ? r.median.executable : r.now.executable) ? 'YES' : 'no') },
    ]));
  }
  if (MODE === 'basis' || MODE === 'snapshot') {
    log('\n== 期现基差（永续 vs 现货；交割年化）==');
    result.basisScan = await scanBasis();
    log(table(result.basisScan.perp, [
      { h: 'base', get: (r) => r.base },
      { h: '基差bps', get: (r) => fixed(r.basisBps, 3) },
      { h: '成本bps', get: (r) => fixed(r.costPctOfNotional * 100, 2) },
      { h: '可捕获bps', get: (r) => fixed(r.grossCapturablePct * 100, 3) },
      { h: '可执行', get: (r) => (r.executable ? 'YES' : 'no') },
    ]));
    log(table(result.basisScan.futures.slice(0, 10), [
      { h: 'instId', get: (r) => r.instId },
      { h: '结算', get: (r) => r.settleCcy },
      { h: '剩余天', get: (r) => fixed(r.daysToExpiry, 1) },
      { h: '基差%', get: (r) => fixed(r.basisPct, 4) },
      { h: '年化%', get: (r) => fixed(r.annualizedBasisPct, 3) },
      { h: '净年化/本金%', get: (r) => fixed(r.netAnnualPctOfCapital, 3) },
      { h: '可执行', get: (r) => (r.executable ? 'YES' : 'no') },
    ]));
  }
  if (MODE === 'triangle' || MODE === 'snapshot') {
    log('\n== 三角套利（真实盘口，扣 3×吃单费）==');
    result.triangleScan = await scanTriangles();
    log(`手续费门槛 = 3 × ${arb.toBps(FEE.spotTaker)}bps = ${3 * arb.toBps(FEE.spotTaker)}bps；名义 ${NOTIONAL} USDT`);
    log(table(result.triangleScan.rows.slice(0, 12), [
      { h: '路径', get: (r) => r.name },
      { h: '毛bps', get: (r) => fixed(r.grossBps, 3) },
      { h: '净bps', get: (r) => fixed(r.netBps, 3) },
      { h: '费bps', get: (r) => fixed(r.feePct * 100, 2) },
      { h: '可执行', get: (r) => (r.ok ? (r.executable ? 'YES' : 'no') : '降级:' + (r.reason || '').slice(0, 24)) },
    ]));
  }
  if (MODE === 'poll') {
    result.poll = await poll();
  }
  const json = JSON.stringify(result, null, 2);
  if (A.out) { fs.writeFileSync(A.out, json); log(`\n已写入 ${A.out}`); }
  else process.stdout.write(json + '\n');
})().catch((e) => { console.error(JSON.stringify({ ok: false, mode: MODE, error: String(e.message), stack: String(e.stack).split('\n').slice(0, 4) }, null, 2)); process.exit(1); });
