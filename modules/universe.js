/*!
 * modules/universe.js - william-bot-1-core key engine logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-4040C4AC
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
/**
 * 选品模块：抓全市场 → 硬过滤 → 回归性/波动率/流动性打分 → Top N 候选池
 *
 * 依赖：modules/okx-data.js 的 okxGet（统一代理 + UA）
 * 设计依据：design/马丁策略设计.md 第二章
 *
 * 用法：
 *   const uni = require('./modules/universe');
 *   const r = await uni.screen({ top: 10 });
 */
const { okxGet } = require('./okx-data');

const SW = 'USDT-SWAP';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 数学工具 ───────────────────────────────────── */

const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
function variance(a) { const m = mean(a); return mean(a.map((x) => (x - m) ** 2)); }
function stdev(a) { return Math.sqrt(variance(a)); }
function norm01(x) { return Math.max(0, Math.min(1, x)); }

/** 对数收益序列 */
function logReturns(candles) {
  const r = [];
  for (let i = 1; i < candles.length; i++) r.push(Math.log(candles[i].c / candles[i - 1].c));
  return r;
}
/** 方差比 VR(q)：<1 回归，>1 趋势 */
function varianceRatio(rets, q = 5) {
  if (rets.length < q * 4) return null;
  const v1 = variance(rets);
  if (!v1) return null;
  const agg = [];
  for (let i = 0; i + q <= rets.length; i += q) agg.push(rets.slice(i, i + q).reduce((a, b) => a + b, 0));
  const vq = variance(agg);
  return vq / (q * v1);
}
/** 一阶自相关 */
function autocorr1(rets) {
  if (rets.length < 10) return null;
  const m = mean(rets);
  let num = 0, den = 0;
  for (let i = 1; i < rets.length; i++) num += (rets[i] - m) * (rets[i - 1] - m);
  for (let i = 0; i < rets.length; i++) den += (rets[i] - m) ** 2;
  return den ? num / den : null;
}
/** 回归频率：偏离 SMA20 超 1.5σ 后，10 根内回到均线的比例 */
function reversionFrequency(candles, win = 20, k = 10, mult = 1.5) {
  const closes = candles.map((c) => c.c);
  let dev = 0, back = 0;
  for (let i = win; i < closes.length - k; i++) {
    const seg = closes.slice(i - win, i);
    const m = mean(seg), sd = stdev(seg);
    if (!sd) continue;
    const z = (closes[i] - m) / sd;
    if (Math.abs(z) < mult) continue;
    dev++;
    // 之后 k 根内是否回到均值
    for (let j = i + 1; j <= i + k; j++) {
      if ((z > 0 && closes[j] <= m) || (z < 0 && closes[j] >= m)) { back++; break; }
    }
  }
  return dev ? back / dev : null;
}
/** ATR%（14） */
function atrPct(candles, n = 14) {
  if (candles.length < n + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].h, l = candles[i].l, pc = candles[i - 1].c;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const atr = mean(trs.slice(-n));
  const price = candles[candles.length - 1].c;
  return price ? (atr / price) * 100 : null;
}
/** EMA */
function ema(vals, n) {
  if (vals.length < n) return null;
  const k = 2 / (n + 1);
  let e = mean(vals.slice(0, n));
  for (let i = n; i < vals.length; i++) e = vals[i] * k + e * (1 - k);
  return e;
}
/** ADX(14)（简化：用 Wilder 平滑） */
function adx(candles, n = 14) {
  if (candles.length < n * 2) return null;
  let trs = [], plusDM = [], minusDM = [];
  for (let i = 1; i < candles.length; i++) {
    const up = candles[i].h - candles[i - 1].h, dn = candles[i - 1].l - candles[i].l;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    trs.push(Math.max(candles[i].h - candles[i].l, Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c)));
  }
  const atr = mean(trs.slice(-n));
  const pdi = 100 * (mean(plusDM.slice(-n)) / (atr || 1));
  const mdi = 100 * (mean(minusDM.slice(-n)) / (atr || 1));
  const dx = 100 * Math.abs(pdi - mdi) / ((pdi + mdi) || 1);
  return { adx: dx, pdi, mdi };
}
/** 趋势状态分类 → 马丁允许方向 */
function classifyRegime(candles) {
  const closes = candles.map((c) => c.c);
  const price = closes[closes.length - 1];
  const e50 = ema(closes, 50), e200 = ema(closes, 200);
  const a = adx(candles, 14);
  const adxV = a ? a.adx : null;
  const near50 = e50 ? Math.abs(price - e50) / e50 : null;
  let regime = 'unclear', allow = [];
  if (adxV !== null && e50 && e200) {
    if (adxV < 20 && near50 !== null && near50 < 0.015) { regime = 'range'; allow = ['long', 'short']; }
    else if (adxV >= 25 && e50 > e200 && price > e50) { regime = 'trend_up'; allow = ['long']; }
    else if (adxV >= 25 && e50 < e200 && price < e50) { regime = 'trend_down'; allow = ['short']; }
    else { regime = 'unclear'; allow = []; }
  }
  return { regime, allow, adx: adxV, ema50: e50, ema200: e200, price, near50 };
}

/* ── 抓取 ───────────────────────────────────────── */

/** 全市场 USDT 永续合约（一次请求，含 ctVal/minSz 等规格） */
async function allSwaps() {
  const j = await okxGet('/api/v5/public/instruments?instType=SWAP', 25000);
  return (j.data || []).filter((d) => d.instId.endsWith(SW) && d.state === 'live');
}
/** 全市场行情快照（一次请求，200+ 条） */
async function allTickers() {
  const j = await okxGet('/api/v5/market/tickers?instType=SWAP', 25000);
  return (j.data || []).filter((d) => d.instId.endsWith(SW));
}
/** 资金费率（单品种） */
async function funding(instId) {
  const j = await okxGet(`/api/v5/public/funding-rate?instId=${instId}`, 12000);
  const d = (j.data || [])[0] || {};
  return Number(d.fundingRate || 0);
}
/** K 线（复用 data 模块的接口习惯） */
async function candlesOf(instId, bar = '1H', limit = 300) {
  const j = await okxGet(`/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${limit}`, 15000);
  return (j.data || []).map((d) => ({ ts: Number(d[0]), o: +d[1], h: +d[2], l: +d[3], c: +d[4], v: +d[5] })).reverse();
}

/** 并发映射（限流，避免触发 OKX 频率限制） */
async function mapLimit(items, limit, fn, gapMs = 120) {
  const out = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      try { out[i] = await fn(items[i], i); } catch (e) { out[i] = { __error: String(e.message || e).slice(0, 80) }; }
      if (gapMs) await sleep(gapMs);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/* ── 主流程 ─────────────────────────────────────── */

/**
 * @param {object} opt
 * @param {number} opt.top          返回前多少个（默认 10）
 * @param {number} opt.minVolUsd    24h 成交额下限（默认 5e7）
 * @param {number} opt.maxFundingAbs 资金费率绝对值上限（小数，默认 0.001 = 0.10%）
 * @param {number} opt.minAgeDays   上市天数下限（默认 30）
 * @param {number} opt.preScan      进入 K 线扫描的品种数上限（默认 50，按成交额排）
 * @param {number} opt.bar          周期（默认 1H）
 */
async function screen(opt = {}) {
  const {
    top = 20, minVolUsd = 2e7, maxFundingAbs = 0.001, minAgeDays = 30,
    preScan = 120, bar = '1H', limit = 300, concurrency = 5,
    maxLayerNotional = null,   // 单层名义预算（USD）：最小下单都放不下的品种直接淘汰，否则篮子空转
  } = opt;

  const t0 = Date.now();
  const [instruments, tickers] = await Promise.all([allSwaps(), allTickers()]);
  const instMap = new Map(instruments.map((d) => [d.instId, d]));

  // 1) 组装 + 硬过滤
  const rows = [];
  const rejected = [];
  for (const t of tickers) {
    const ins = instMap.get(t.instId);
    if (!ins) continue;
    const last = Number(t.last || 0);
    const notional = Number(t.volCcy24h || 0) * last;      // 24h 成交额（USD）
    const ageDays = ins.listTime ? (Date.now() - Number(ins.listTime)) / 86400000 : 0;
    const rec = { instId: t.instId, last, notional, ageDays, ctVal: Number(ins.ctVal || 1), ctValCcy: ins.ctValCcy, maxLever: Number(ins.lever || 0), minSz: Number(ins.minSz || 0) };
    if (notional < minVolUsd) { rejected.push({ instId: t.instId, reason: `成交额 ${(notional / 1e6).toFixed(0)}M < ${minVolUsd / 1e6}M` }); continue; }
    if (ageDays < minAgeDays) { rejected.push({ instId: t.instId, reason: `上市 ${ageDays.toFixed(0)} 天 < ${minAgeDays} 天` }); continue; }
    // 可交易性：最小下单名义 > 单层预算 → 第 1 层就会超配，直接淘汰（避免篮子开不起来/被最小手数撑爆）
    const minNotional = Number(ins.minSz || 0) * Number(ins.ctVal || 0) * last;
    rec.minNotionalUsd = +minNotional.toFixed(2);
    if (maxLayerNotional && minNotional > maxLayerNotional) {
      rejected.push({ instId: t.instId, reason: `最小下单 $${minNotional.toFixed(2)} > 单层预算 $${Number(maxLayerNotional).toFixed(2)}（放不下）` });
      continue;
    }
    rows.push(rec);
  }
  rows.sort((a, b) => b.notional - a.notional);
  const shortlist = rows.slice(0, preScan);

  // 2) 资金费率过滤
  const fundings = await mapLimit(shortlist, concurrency, (r) => funding(r.instId));
  const pass = [];
  shortlist.forEach((r, i) => {
    const f = fundings[i];
    if (f && f.__error) { rejected.push({ instId: r.instId, reason: `费率取数失败 ${f.__error}` }); return; }
    r.funding = f;
    if (Math.abs(f) > maxFundingAbs) { rejected.push({ instId: r.instId, reason: `资金费率 ${(f * 100).toFixed(4)}% 超限` }); return; }
    pass.push(r);
  });

  // 3) K 线指标
  const kl = await mapLimit(pass, concurrency, (r) => candlesOf(r.instId, bar, limit));
  const scored = [];
  pass.forEach((r, i) => {
    const cs = kl[i];
    if (!cs || cs.__error || cs.length < 120) { rejected.push({ instId: r.instId, reason: `K线不足（${cs && cs.__error ? cs.__error : (cs ? cs.length + ' 根' : '取数失败')}）` }); return; }
    const rets = logReturns(cs);
    const vr5 = varianceRatio(rets, 5);
    const rho1 = autocorr1(rets);
    const rf = reversionFrequency(cs);
    const atr = atrPct(cs, 14);
    const rg = classifyRegime(cs);
    r.metrics = { vr5, rho1, rf, atrPct: atr, ...rg, bars: cs.length };
    scored.push(r);
  });

  // 4) 打分（归一化到 0..1）
  const nrm = (key, invert = false) => {
    const vals = scored.map((r) => r.metrics[key]).filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
    if (!vals.length) return () => 0.5;
    const mn = Math.min(...vals), mx = Math.max(...vals);
    return (v) => {
      if (v === null || v === undefined || Number.isNaN(v)) return 0;
      const x = mx === mn ? 0.5 : (v - mn) / (mx - mn);
      return invert ? 1 - x : x;
    };
  };
  const nVR = nrm('vr5', true), nRho = nrm('rho1', true), nRF = nrm('rf');
  const nAtr = nrm('atrPct'), nLiq = (r) => norm01((Math.log10(r.notional) - 7.5) / 2.5);  // 3e7→0, 3e9→1

  for (const r of scored) {
    const m = r.metrics;
    const R = 0.4 * nVR(m.vr5) + 0.3 * nRho(m.rho1) + 0.3 * nRF(m.rf);
    // 波动率理想区间 1%~4%：两端衰减
    const a = m.atrPct ?? 0;
    const V = a <= 1 ? a / 1 : a >= 4 ? Math.max(0, 1 - (a - 4) / 4) : 1;
    const L = nLiq(r);
    r.scores = { reversion: +R.toFixed(4), volatility: +V.toFixed(4), liquidity: +L.toFixed(4), total: +(0.45 * R + 0.35 * V + 0.2 * L).toFixed(4) };
  }
  scored.sort((a, b) => b.scores.total - a.scores.total);

  // 5) 板块去重（同板块只留最高分）
  const sectorOf = (instId) => {
    const base = instId.split('-')[0];
    const MEME = ['DOGE','SHIB','PEPE','WIF','BONK','FLOKI','MEME','1000PEPE','1000SHIB','1000BONK','1000FLOKI','TRUMP','POPCAT','MEW','BOME','NEIRO','MOODENG','PNUT','ACT','GOAT'];
    const L1 = ['BTC','ETH','SOL','BNB','AVAX','ADA','TRX','TON','SUI','APT','NEAR','SEI','DOT','ATOM','FTM','S','INJ','TIA','ETC','LTC','BCH','XRP','HBAR','ALGO'];
    const L2 = ['ARB','OP','MATIC','POL','STRK','ZK','MANTA','METIS','IMX','BASE'];
    const DEFI = ['UNI','AAVE','CRV','MKR','COMP','SUSHI','SNX','LDO','PENDLE','GMX','DYDX','1INCH'];
    if (MEME.includes(base)) return 'MEME';
    if (L2.includes(base)) return 'L2';
    if (DEFI.includes(base)) return 'DeFi';
    if (L1.includes(base)) return 'L1';
    return 'Other:' + base.slice(0, 3);
  };
  const seen = new Set();
  const picked = [];
  for (const r of scored) {
    const s = sectorOf(r.instId);
    if (seen.has(s) && picked.length < top) continue;
    seen.add(s);
    picked.push(r);
    if (picked.length >= top) break;
  }

  return {
    ok: true, bar, tookMs: Date.now() - t0,
    universe: { swaps: instruments.length, tickers: tickers.length, aboveVolume: rows.length, scanned: scored.length, failed: rejected.length },
    picked: picked.map((r) => ({
      instId: r.instId, sector: sectorOf(r.instId), last: r.last,
      notionalUsd: Math.round(r.notional), fundingPct: +(r.funding * 100).toFixed(4), minNotionalUsd: r.minNotionalUsd ?? null,
      ctVal: r.ctVal, ctValCcy: r.ctValCcy, minSz: r.minSz, maxLever: r.maxLever,
      atrPct: +(r.metrics.atrPct ?? 0).toFixed(2), vr5: +(r.metrics.vr5 ?? 0).toFixed(3), rho1: +(r.metrics.rho1 ?? 0).toFixed(3), rf: +(r.metrics.rf ?? 0).toFixed(3),
      regime: r.metrics.regime, allowDirections: r.metrics.allow, adx: r.metrics.adx ? +r.metrics.adx.toFixed(1) : null,
      score: r.scores,
    })),
    rejectedSample: rejected.slice(0, 12),
  };
}

module.exports = { screen, allSwaps, allTickers, candlesOf, funding, classifyRegime, varianceRatio, autocorr1, reversionFrequency, atrPct, adx, ema };
