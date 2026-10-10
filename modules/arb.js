/*!
 * modules/arb.js - william-bot-1-core key engine logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-545AD14B
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
/**
 * 【模块 3】套利扫描（只读，无密钥）
 *
 * 三条线：① 资金费率套利（delta 中性）② 期现基差 ③ 三角套利
 * 铁律：
 *   - 全部只用 GET 类公开接口；本模块不签名、不下单。
 *   - 每个方向都必须**扣掉手续费后**再判断能否执行（净收益 > 0 才算过门槛）。
 *   - 缺数据/空盘口一律「降级并说明原因」，绝不返回 NaN 或假的盈利。
 *   - 费率默认取 **实测** 的 Lv1 标准档（见 FEE_PRESETS 注释），可被调用方覆盖。
 *
 * 用法：
 *   const arb = require('./modules/arb');
 *   const bk = arb.parseBook(await okxGet('/api/v5/market/books?instId=BTC-USDT&sz=5'));
 *   const r  = arb.runTriangle({ bookOf, pairs: ['BTC-USDT','ETH-BTC','ETH-USDT'], startAsset: 'USDT', startAmount: 100, feeTaker: 0.001 });
 */
'use strict';

const { okxGet } = require('./okx-data');
const { execFile } = require('child_process');
const cfg = require('../config');

/**
 * 大响应 GET：现货全量 instruments/tickers 有几 MB，
 * okx-data.okxGet 的 execFile 默认 maxBuffer 1MB 会直接抛「stdout maxBuffer length exceeded」。
 * okx-data 是禁改文件，所以这里自带一份（同样带代理 + 浏览器 UA）。
 */
function okxGetBig(pathAndQuery, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/curl', [
      '-s', '--max-time', String(Math.ceil(timeoutMs / 1000)),
      '-A', cfg.userAgent, '-x', cfg.proxy, cfg.baseUrl + pathAndQuery,
    ], { encoding: 'utf8', timeout: timeoutMs + 3000, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) => {
      if (err) return reject(new Error(`curl ${err.message}`));
      try {
        const j = JSON.parse(stdout);
        if (j.code && j.code !== '0') return reject(new Error(`OKX ${j.code}: ${j.msg || ''}`));
        resolve(j);
      } catch { reject(new Error(`非 JSON 响应（前 60 字）：${String(stdout).slice(0, 60)}`)); }
    });
  });
}

/* ── 费率 ─────────────────────────────────────────
 * 2026-09-21 实测（101 服务器 /api/v5/account/trade-fee，账户 level=Lv1, feeType=0）：
 *   SPOT  maker 0.08%  taker 0.10%
 *   SWAP  maker 0.02%  taker 0.05%（USDT 本位 makerU/takerU）
 *   FUTURES 同 SWAP 档
 * 单位：小数（0.0010 = 0.10%），= 实际支付比例。
 */
const FEE_PRESETS = {
  Lv1: { spotMaker: 0.0008, spotTaker: 0.0010, swapMaker: 0.0002, swapTaker: 0.0005, futureMaker: 0.0002, futureTaker: 0.0005 },
};
const FEE_PRESET_META = {
  Lv1: { level: 'Lv1', feeType: '0', ruleType: 'normal', source: '实测 /api/v5/account/trade-fee 2026-09-21', vip: false },
};

/** 取一组费率（level 预置 + 覆盖项） */
function fees(level = 'Lv1', over = {}) {
  const base = FEE_PRESETS[level] || FEE_PRESETS.Lv1;
  return { ...base, ...over };
}
/** 吃单费率小数 → 百分比数值（0.001 → 0.1） */
const toPct = (x) => x * 100;
/** 小数 → bps（0.001 → 10） */
const toBps = (x) => x * 10000;

/* ── 统计 ───────────────────────────────────────── */

/** 最近秩百分位（升序样本） */
function pctile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const i = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[i];
}
/** 基础统计（含 p25/p50/p75/p95） */
function stats(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).slice().sort((a, b) => a - b);
  if (!v.length) return { n: 0, min: null, p25: null, median: null, p75: null, p95: null, max: null, mean: null };
  return {
    n: v.length,
    min: +v[0].toFixed(4), p25: +pctile(v, 25).toFixed(4), median: +pctile(v, 50).toFixed(4),
    p75: +pctile(v, 75).toFixed(4), p95: +pctile(v, 95).toFixed(4), max: +v[v.length - 1].toFixed(4),
    mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4),
  };
}

/**
 * 采样序列统计（给「有没有 edge」用）
 * @param {number[]} series 每轮的净收益（bps）
 * @returns {{rounds,valid,invalid,minBps,medianBps,p95Bps,maxBps,meanBps,positive,aboveThreshold,thresholdBps,bestRound}}
 */
function sampleStats(series, { thresholdBps = 0 } = {}) {
  const all = Array.isArray(series) ? series : [];
  const valid = all.filter((x) => typeof x === 'number' && Number.isFinite(x));
  const s = stats(valid);
  let bestRound = null;
  all.forEach((x, i) => { if (Number.isFinite(x) && (bestRound === null || x > all[bestRound])) bestRound = i; });
  return {
    rounds: all.length, valid: valid.length, invalid: all.length - valid.length,
    minBps: s.min, medianBps: s.median, p95Bps: s.p95, maxBps: s.max, meanBps: s.mean,
    positive: valid.filter((x) => x > 0).length,
    aboveThreshold: valid.filter((x) => x > thresholdBps).length,
    thresholdBps, bestRound,
  };
}

/* ── 上取整/下取整（下单步长约束）──────────────────────────────── */

/** 按 step 向下取整（张数/币数必须落在步长上） */
function roundDownTo(x, step) {
  if (!step || step <= 0) return x;
  const n = Math.floor(Number(x) / step + 1e-12);
  return +(n * step).toFixed(12);
}
/** 按 step 向上取整 */
function roundUpTo(x, step) {
  if (!step || step <= 0) return x;
  const n = Math.ceil(Number(x) / step - 1e-12);
  return +(n * step).toFixed(12);
}

/* ── 盘口 ───────────────────────────────────────── */

/** 解析 /api/v5/market/books 响应 → { ok, ts, bid:[[px,sz]], ask:[[px,sz]], bid1, ask1, mid, spreadBps } */
function parseBook(json) {
  const d = (json && json.data && json.data[0]) || json || {};
  const num = (rows) => (Array.isArray(rows) ? rows : [])
    .map((r) => ({ px: Number(r[0]), sz: Number(r[1]) }))
    .filter((l) => Number.isFinite(l.px) && Number.isFinite(l.sz) && l.px > 0 && l.sz > 0);
  const bid = num(d.bids), ask = num(d.asks);
  const bid1 = bid[0] || null, ask1 = ask[0] || null;
  const ok = Boolean(bid1 && ask1);
  const mid = ok ? (bid1.px + ask1.px) / 2 : null;
  return {
    ok, ts: Number(d.ts || 0), bid, ask, bid1, ask1, mid,
    spreadBps: ok && mid ? +(((ask1.px - bid1.px) / mid) * 10000).toFixed(4) : null,
    reason: ok ? null : `盘口为空（bid=${bid.length} ask=${ask.length}）`,
  };
}

/** 用 quote 金额吃 asks 买 base：返回可实现数量与 VWAP（吃不到 → ok:false，绝不假装成交） */
function walkBuy(asks, quoteIn) {
  let left = Number(quoteIn), got = 0, cost = 0, used = 0;
  for (const l of asks || []) {
    if (left <= 1e-12) break;
    const levelQuote = l.px * l.sz;
    const take = Math.min(left, levelQuote);
    got += take / l.px; cost += take; left -= take; used++;
  }
  if (left > 1e-9) return { ok: false, reason: `盘口深度不足：还差 ${left.toFixed(6)} quote`, got, cost, used, vwap: got ? cost / got : null, unfilled: left };
  return { ok: true, got, cost, used, vwap: got ? cost / got : null, unfilled: 0 };
}

/** 卖出 base 吃 bids 换 quote */
function walkSell(bids, baseIn) {
  let left = Number(baseIn), got = 0, used = 0;
  for (const l of bids || []) {
    if (left <= 1e-12) break;
    const take = Math.min(left, l.sz);
    got += take * l.px; left -= take; used++;
  }
  if (left > 1e-12) return { ok: false, reason: `盘口深度不足：还差 ${left.toFixed(8)} base`, got, used, unfilled: left };
  return { ok: true, got, used, unfilled: 0 };
}

/* ── 三角套利 ───────────────────────────────────── */

/**
 * 把一串交易对还原成「从 startAsset 出发、逐步走到收尾回到 startAsset」的腿序列。
 * 交易对写成 BASE-QUOTE；若当前持有 quote → 买 base（吃 ask）；持有 base → 卖 base（吃 bid）。
 * @returns {Array|null} [{pair, from, to, dir}]；不能闭合返回 null
 */
function cycleFrom(pairs, startAsset = 'USDT') {
  let cur = startAsset;
  const legs = [];
  for (const pair of pairs) {
    const parts = String(pair).split('-');
    if (parts.length !== 2) return null;
    const [b, q] = parts;
    if (b === cur) { legs.push({ pair, from: b, to: q, dir: 'sell' }); cur = q; }
    else if (q === cur) { legs.push({ pair, from: q, to: b, dir: 'buy' }); cur = b; }
    else return null;
  }
  return cur === startAsset ? legs : null;
}

/**
 * 跑一条三角/多角路径（真实盘口、吃单成交、每步扣一次 taker 费）
 * 费用按 OKX 现货口径：从**收到的币**里扣。
 * @param {object} o
 * @param {(pair:string)=>object} o.bookOf  取盘口（parseBook 的返回值）
 * @param {string[]} o.pairs                ['BTC-USDT','ETH-BTC','ETH-USDT']
 * @param {string} o.startAsset             起点资产（默认 USDT）
 * @param {number} o.startAmount            起点数量（USDT 数量）
 * @param {number} o.feeTaker               吃单费率（小数）
 * @param {(pair:string)=>number} [o.lotOf] 该交易对的 lotSz（可选，用于向下取整）
 * @returns {{ok:boolean, degraded?:boolean, reason?:string, steps:object[], netPct:number|null, grossPct:number|null, feePct:number|null}}
 */
function runTriangle({ bookOf, pairs, startAsset = 'USDT', startAmount = 100, feeTaker = 0.001, lotOf = null }) {
  const legs = cycleFrom(pairs, startAsset);
  const empty = { steps: [], netPct: null, grossPct: null, feePct: null };
  if (!legs) return { ok: false, degraded: true, reason: `路径不闭合或资产不匹配：${pairs.join('→')}`, ...empty };
  if (!(startAmount > 0)) return { ok: false, degraded: true, reason: `startAmount 非法：${startAmount}`, ...empty };

  const run = (fee) => {
    let amt = startAmount;
    const steps = [];
    for (const leg of legs) {
      const bk = typeof bookOf === 'function' ? bookOf(leg.pair) : null;
      if (!bk || !bk.ok) return { ok: false, degraded: true, reason: `${leg.pair} ${(bk && bk.reason) || '盘口缺失'}`, steps, amt };
      const lot = lotOf ? lotOf(leg.pair) : 0;
      if (leg.dir === 'buy') {
        const r = walkBuy(bk.ask, amt);
        if (!r.ok) return { ok: false, degraded: true, reason: `${leg.pair} ${r.reason}`, steps, amt };
        const out = roundDownTo(r.got * (1 - fee), lot);
        steps.push({ ...leg, px: r.vwap, inAmt: amt, outAmt: out, grossOut: r.got, feePaid: r.got * fee, levels: r.used });
        amt = out;
      } else {
        const r = walkSell(bk.bid, amt);
        if (!r.ok) return { ok: false, degraded: true, reason: `${leg.pair} ${r.reason}`, steps, amt };
        const out = roundDownTo(r.got * (1 - fee), lot);
        steps.push({ ...leg, px: r.vwap, inAmt: amt, outAmt: out, grossOut: r.got, feePaid: r.got * fee, levels: r.used });
        amt = out;
      }
    }
    return { ok: true, steps, amt };
  };

  const net = run(feeTaker);
  if (!net.ok) return { ok: false, degraded: true, reason: net.reason, steps: net.steps, netPct: null, grossPct: null, feePct: null };
  const gross = run(0);
  const netPct = (net.amt / startAmount - 1) * 100;
  const grossPct = (gross.amt / startAmount - 1) * 100;
  return {
    ok: true, degraded: false, path: pairs.join('→'), startAsset, startAmount,
    endAmount: net.amt, steps: net.steps,
    grossPct: +grossPct.toFixed(6), netPct: +netPct.toFixed(6), feePct: +(grossPct - netPct).toFixed(6),
    netBps: +toBps(netPct / 100).toFixed(4), grossBps: +toBps(grossPct / 100).toFixed(4),
    executable: netPct > 0,
  };
}

/* ── 资金费率套利（delta 中性）───────────────────── */

/** 资金费率小数 → 年化（默认 8h 一期 = 1095 期/年） */
function annualizeFunding(rate, periodsPerYear = 1095) { return Number(rate) * periodsPerYear; }

/**
 * 现货多 + 永续空（delta 中性）的净收益
 * @param {object} o
 * @param {number} o.rateNow     当前一期费率（小数，正数 = 空头收钱）
 * @param {number} [o.rateStat]  统计口径费率（如 7 天中位数）；给了就用它做主口径
 * @param {number} [o.notional]  单腿名义（USD）
 * @param {number} [o.lever]     永续腿杠杆（决定保证金占用）
 * @param {object} o.fee         fees() 的返回
 * @param {number} [o.slipBps]   每次成交的不利滑点（bps），共 4 次成交
 * @param {number} [o.periodsPerYear]
 */
function fundingArb({ rateNow, rateStat = null, notional = 100, lever = 3, fee, slipBps = 0, periodsPerYear = 1095, holdPeriods = 1 }) {
  if (!fee) return { ok: false, reason: '缺少费率模型 fee' };
  if (!(notional > 0)) return { ok: false, reason: 'notional 必须 > 0' };
  if (!(lever > 0)) return { ok: false, reason: 'lever 必须 > 0' };
  const rawRate = (rateStat !== null && rateStat !== undefined && rateStat !== '') ? rateStat : rateNow;
  if (rawRate === null || rawRate === undefined || rawRate === '' || !Number.isFinite(Number(rawRate))) {
    return { ok: false, reason: '费率缺失（rateNow/rateStat 均为 null/undefined）' };
  }
  const rate = Number(rawRate);

  const openClose = 2 * (fee.spotTaker + fee.swapTaker);       // 开+平 两条腿吃单
  const slip = 4 * (Number(slipBps) / 10000);                  // 4 次成交
  const costFrac = openClose + slip;
  const grossAnnualFrac = annualizeFunding(rate, periodsPerYear);
  const netAnnualFrac = grossAnnualFrac - costFrac;
  const capital = notional * (1 + 1 / lever);                  // 现货全额 + 永续保证金
  const netAnnualOnCapital = (netAnnualFrac * notional) / capital;
  const breakEvenPeriods = rate > 0 ? costFrac / rate : null;  // 正费率才可能回本
  const incomePerPeriodUsd = rate * notional;

  return {
    ok: true, rateNow: +Number(rateNow).toFixed(8), rateUsed: +rate.toFixed(8),
    rateBpsPerPeriod: +toBps(rate).toFixed(4), ratePctPerPeriod: +toPct(rate).toFixed(6),
    grossAnnualPct: +(grossAnnualFrac * 100).toFixed(4),
    costPctOfNotional: +(costFrac * 100).toFixed(4),
    costDetail: { roundTripFeesPct: +(openClose * 100).toFixed(4), slippagePct: +(slip * 100).toFixed(4) },
    netAnnualPctOfNotional: +(netAnnualFrac * 100).toFixed(4),
    capitalMultiple: +(capital / notional).toFixed(4), capitalUsd: +capital.toFixed(2),
    netAnnualPctOfCapital: +(netAnnualOnCapital * 100).toFixed(4),
    netAnnualUsd: +(netAnnualFrac * notional).toFixed(4),
    incomePerPeriodUsd: +incomePerPeriodUsd.toFixed(6),
    breakEvenPeriods: breakEvenPeriods === null ? null : +breakEvenPeriods.toFixed(2),
    breakEvenHours: breakEvenPeriods === null ? null : +(breakEvenPeriods * 24 / (periodsPerYear / 365)).toFixed(1),
    positives: {
      ratePositive: rate > 0,
      coversCostInOnePeriod: rate > costFrac,
      breakEvenUnder30d: breakEvenPeriods !== null && (breakEvenPeriods * 24 / (periodsPerYear / 365)) < 720,
    },
    executable: rate > 0 && netAnnualFrac > 0,
    note: rate <= 0 ? '费率为负：空头要付钱，该标的不能做现货多+永续空' : null,
  };
}

/** 永续-永续（同标的跨币种保证金，或跨期）资金费差：两腿都吃单、双份保证金 */
function fundingSpread({ rateA, rateB = null, instA = 'A', instB = 'B', notional = 100, lever = 3, fee, slipBps = 0, periodsPerYear = 1095 }) {
  if (!fee) return { ok: false, reason: '缺少费率模型 fee' };
  const missA = rateA === null || rateA === undefined || rateA === '' || !Number.isFinite(Number(rateA));
  const missB = !(rateB === null || rateB === undefined || rateB === '') && !Number.isFinite(Number(rateB));
  if (missA || missB) return { ok: false, reason: '费率缺失（rateA/rateB）' };
  const rA = Number(rateA), rB = (rateB === null || rateB === undefined || rateB === '') ? null : Number(rateB);
  // 空 A、多 B：收入 = (rateA - rateB) × 名义
  const spread = rB === null ? rA : rA - rB;
  if (!Number.isFinite(spread)) return { ok: false, reason: '费率缺失' };
  const legs = rB === null ? 2 : 4;                              // 单腿替代？两腿各开平
  const fees = legs * fee.swapTaker;
  const slip = legs * (Number(slipBps) / 10000);
  const costFrac = fees + slip;
  const grossAnnualFrac = annualizeFunding(spread, periodsPerYear);
  const capital = notional * (2 / lever);                        // 两腿各占 1/lever
  return {
    ok: true, instA, instB, rateA: rA, rateB: rB, spreadPerPeriod: +spread.toFixed(8),
    spreadBpsPerPeriod: +toBps(spread).toFixed(4),
    grossAnnualPct: +(grossAnnualFrac * 100).toFixed(4),
    costPctOfNotional: +(costFrac * 100).toFixed(4),
    netAnnualPctOfNotional: +((grossAnnualFrac - costFrac) * 100).toFixed(4),
    capitalMultiple: +(capital / notional).toFixed(4),
    netAnnualPctOfCapital: +(((grossAnnualFrac - costFrac) * notional / capital) * 100).toFixed(4),
    breakEvenPeriods: spread > 0 ? +(costFrac / spread).toFixed(2) : null,
    executable: spread > 0 && (grossAnnualFrac - costFrac) > 0,
  };
}

/* ── 期现基差 ───────────────────────────────────── */

/**
 * 基差（现货 vs 永续/交割）
 * @param {object} o
 * @param {number} o.spotPx  现货价
 * @param {number} o.perpPx  永续或交割价
 * @param {number} [o.daysToExpiry] 交割合约剩余天数；永续传 null
 * @param {object} o.fee
 * @param {number} [o.slipBps]
 * @param {number} [o.lever]
 * @param {number} [o.holdDays] 持仓天数（永续口径的年化假设）
 * @param {string} [o.kind] 'perp' | 'future'
 */
function basisArb({ spotPx, perpPx, daysToExpiry = null, fee, slipBps = 0, lever = 3, holdDays = 1, kind = 'perp' }) {
  if (!fee) return { ok: false, reason: '缺少费率模型 fee' };
  const s = Number(spotPx), p = Number(perpPx);
  if (!(s > 0) || !(p > 0)) return { ok: false, reason: '价格缺失或非法' };
  const basisPct = ((p - s) / s) * 100;
  const legFee = kind === 'future' ? fee.futureTaker : fee.swapTaker;
  const openClose = 2 * (fee.spotTaker + legFee);
  const slip = 4 * (Number(slipBps) / 10000);
  const costFrac = openClose + slip;
  const capital = 1 + 1 / lever;
  const dir = basisPct > 0 ? '买现货 + 空合约（正向）' : '空现货(或借币) + 多合约（反向，现货腿需借币 → 另计利息）';
  const out = {
    ok: true, kind, spotPx: s, perpPx: p,
    basisPct: +basisPct.toFixed(6), basisBps: +toBps(basisPct / 100).toFixed(4),
    direction: dir,
    costPctOfNotional: +(costFrac * 100).toFixed(4),
    capitalMultiple: +capital.toFixed(4),
    captureNeedsBasisAbovePct: +(costFrac * 100).toFixed(4),
    grossCapturablePct: +(Math.abs(basisPct) - costFrac * 100).toFixed(6),
    executable: Math.abs(basisPct) > costFrac * 100,
  };
  if (daysToExpiry && daysToExpiry > 0) {
    const ann = (basisPct / daysToExpiry) * 365;
    const net = ((basisPct / 100 - costFrac) / daysToExpiry) * 365;
    out.daysToExpiry = daysToExpiry;
    out.annualizedBasisPct = +ann.toFixed(4);
    out.netAnnualPctOfNotional = +(net * 100).toFixed(4);
    out.netAnnualPctOfCapital = +((net / capital) * 100).toFixed(4);
    out.breakEvenDays = +(costFrac / (Math.abs(basisPct) / 100) * daysToExpiry).toFixed(2);
  } else {
    out.annualizedBasisPct = null;
    out.netAnnualPctOfNotional = null;
    out.note = '永续无到期日：基差不会机械收敛（靠资金费收敛），此处的「基差」是溢价快照；能否赚到取决于资金费方向与持续性';
  }
  return out;
}

/* ── 取数（只读）────────────────────────────────── */

/** 批量盘口：pairs → { [pair]: parseBook }（并发，失败降级为 ok:false） */
async function fetchBooks(pairs, { size = 5, concurrency = 6 } = {}) {
  const out = {};
  const list = [...new Set(pairs)];
  let idx = 0;
  async function worker() {
    while (idx < list.length) {
      const p = list[idx++];
      try { out[p] = parseBook(await okxGet(`/api/v5/market/books?instId=${p}&sz=${size}`, 12000)); }
      catch (e) { out[p] = { ok: false, reason: `取数失败 ${String(e.message).slice(0, 50)}`, bid: [], ask: [], bid1: null, ask1: null }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return { books: out, missing: list.filter((p) => !out[p].ok) };
}

/** 现货 / 永续 bulk ticker → { [instId]: {last, bidPx, askPx, volCcy24h} } */
async function tickerMap(instType = 'SPOT') {
  const j = await okxGetBig(`/api/v5/market/tickers?instType=${instType}`, 30000);
  const out = {};
  for (const t of j.data || []) out[t.instId] = { instId: t.instId, last: Number(t.last || 0), bidPx: Number(t.bidPx || 0), askPx: Number(t.askPx || 0), volCcy24h: Number(t.volCcy24h || 0), ts: Number(t.ts || 0) };
  return out;
}

/** 现货交易对规格：{ [instId]: {base, quote, minSz, lotSz, tickSz} } */
async function spotInstruments() {
  const j = await okxGetBig('/api/v5/public/instruments?instType=SPOT', 30000);
  const out = {};
  for (const d of j.data || []) {
    if (d.state !== 'live') continue;
    const [base, quote] = String(d.instId).split('-');
    out[d.instId] = { instId: d.instId, base, quote, minSz: Number(d.minSz || 0), lotSz: Number(d.lotSz || 0), tickSz: Number(d.tickSz || 0) };
  }
  return out;
}

/** 交割合约（用于期现基差年化）：{ [instId]: {expTime, daysToExpiry, ...} } */
async function futureInstruments(instType = 'FUTURES') {
  const j = await okxGetBig(`/api/v5/public/instruments?instType=${instType}`, 30000);
  const now = Date.now();
  const out = {};
  for (const d of j.data || []) {
    if (d.state !== 'live') continue;
    out[d.instId] = { instId: d.instId, expTime: Number(d.expTime || 0), daysToExpiry: +(((Number(d.expTime || 0) - now) / 86400000)).toFixed(3), ctVal: Number(d.ctVal || 1), minSz: Number(d.minSz || 0) };
  }
  return out;
}

/** 单个 ticker（交割合约等不在 bulk 里时用） */
async function tickerOne(instId) {
  const j = await okxGet(`/api/v5/market/ticker?instId=${instId}`, 12000);
  const t = (j.data || [])[0] || {};
  return { instId, last: Number(t.last || 0), bidPx: Number(t.bidPx || 0), askPx: Number(t.askPx || 0), ts: Number(t.ts || 0) };
}

/** 单个费率（当前 + 预测） */
async function fundingOne(instId) {
  const j = await okxGet(`/api/v5/public/funding-rate?instId=${instId}`, 12000);
  const d = (j.data || [])[0] || {};
  return { instId, fundingRate: Number(d.fundingRate || 0), nextFundingRate: d.nextFundingRate ? Number(d.nextFundingRate) : null, nextFundingTime: Number(d.nextFundingTime || 0) };
}

/** 批量费率：先试逗号批量，失败则逐个取（OKX 部分版本不支持批量） */
async function fundingBatch(instIds) {
  const ids = [...new Set(instIds)];
  if (!ids.length) return {};
  try {
    const j = await okxGet(`/api/v5/public/funding-rate?instId=${ids.join(',')}`, 15000);
    const out = {};
    for (const d of j.data || []) out[d.instId] = { instId: d.instId, fundingRate: Number(d.fundingRate || 0), nextFundingRate: d.nextFundingRate ? Number(d.nextFundingRate) : null, nextFundingTime: Number(d.nextFundingTime || 0) };
    if (Object.keys(out).length) return out;
  } catch { /* 落回逐个取 */ }
  const out = {};
  let idx = 0;
  const worker = async () => {
    while (idx < ids.length) {
      const id = ids[idx++];
      try { out[id] = await fundingOne(id); } catch (e) { out[id] = { instId: id, error: String(e.message).slice(0, 60) }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
  return out;
}

/** 资金费历史的中位数/均值/正费率占比（比单点快照可信） */
async function fundingHistoryStat(instId, { points = 21 } = {}) {
  const j = await okxGet(`/api/v5/public/funding-rate-history?instId=${instId}&limit=${Math.min(points, 100)}`, 12000);
  const rates = (j.data || []).map((d) => Number(d.fundingRate)).filter(Number.isFinite);
  if (!rates.length) return { instId, n: 0, median: null, mean: null, positiveShare: null };
  const s = rates.slice().sort((a, b) => a - b);
  return {
    instId, n: rates.length,
    median: +pctile(s, 50).toFixed(8),
    mean: +(rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(8),
    current: +rates[0].toFixed(8),
    oldest: +rates[rates.length - 1].toFixed(8),
    positiveShare: +(rates.filter((x) => x > 0).length / rates.length).toFixed(3),
    min: +s[0].toFixed(8), max: +s[s.length - 1].toFixed(8),
  };
}

/**
 * 自动枚举三角路径（USDT ↔ 枢纽币 ↔ 其他币），只用真实存在的现货对
 * @returns {Array<{name:string, pairs:string[]}>}
 */
function enumTriangles(instruments, { start = 'USDT', hubs = ['BTC', 'ETH'], others = null, maxPaths = 24 } = {}) {
  const has = (b, q) => Boolean(instruments[`${b}-${q}`]);
  const liquid = others || ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'LTC', 'ADA', 'LINK', 'AVAX', 'TON', 'BNB', 'TRX'];
  const out = [];
  const seen = new Set();
  for (const h of hubs) {
    if (!has(h, start)) continue;
    for (const x of liquid) {
      if (x === h) continue;
      // 方向 1: start → h → x → start
      if (has(x, h) && has(x, start)) {
        const pairs = [`${h}-${start}`, `${x}-${h}`, `${x}-${start}`];
        const key = pairs.join('|');
        if (!seen.has(key)) { seen.add(key); out.push({ name: `${start}→${h}→${x}→${start}`, pairs }); }
      }
      // 方向 2: start → x → h → start
      if (has(x, start) && has(h, x)) {
        const pairs = [`${x}-${start}`, `${h}-${x}`, `${h}-${start}`];
        const key = pairs.join('|');
        if (!seen.has(key)) { seen.add(key); out.push({ name: `${start}→${x}→${h}→${start}`, pairs }); }
      }
      if (out.length >= maxPaths) return out;
    }
  }
  return out;
}

module.exports = {
  okxGetBig,
  FEE_PRESETS, FEE_PRESET_META, fees, toPct, toBps,
  stats, pctile, sampleStats, roundDownTo, roundUpTo,
  parseBook, walkBuy, walkSell, cycleFrom, runTriangle,
  annualizeFunding, fundingArb, fundingSpread, basisArb,
  fetchBooks, tickerMap, tickerOne, spotInstruments, futureInstruments,
  fundingOne, fundingBatch, fundingHistoryStat, enumTriangles,
};
