/*!
 * modules/okx-data.js - william-bot-1-core key engine logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-026E4D20
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
/**
 * 【模块 1】OKX 拉取数据（只读，无需密钥）
 * 全部走本机代理 + 浏览器 UA（OKX 会拦裸请求，返回 403 error code 1010）
 * 对外暴露的函数见文件末尾 module.exports
 */
const { execFile } = require('child_process');
const cfg = require('../config');

/** 底层 GET：curl（带代理与 UA），返回 OKX 原始 JSON */
function okxGet(pathAndQuery, timeoutMs = 15000) {
  const url = cfg.baseUrl + pathAndQuery;
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/curl', [
      '-s', '--max-time', String(Math.ceil(timeoutMs / 1000)),
      '-A', cfg.userAgent, '-x', cfg.proxy, url,
    ], { encoding: 'utf8', timeout: timeoutMs + 3000 }, (err, stdout) => {
      if (err) return reject(new Error(`curl ${err.message}`));
      try {
        const j = JSON.parse(stdout);
        if (j.code && j.code !== '0') return reject(new Error(`OKX ${j.code}: ${j.msg || ''}`));
        resolve(j);
      } catch { reject(new Error(`非 JSON 响应（前 60 字）：${String(stdout).slice(0, 60)}`)); }
    });
  });
}

/* ── 行情 ───────────────────────────────────────── */

/** 单个标的快照：现价/24h 开高低/成交量/成交额 */
async function ticker(instId = cfg.defaults.instId) {
  const j = await okxGet(`/api/v5/market/ticker?instId=${instId}`);
  const t = (j.data || [])[0] || {};
  const last = Number(t.last || 0), open = Number(t.open24h || 0);
  return {
    instId, last, open24h: open, high24h: Number(t.high24h || 0), low24h: Number(t.low24h || 0),
    vol24h: Number(t.vol24h || 0), volCcy24h: Number(t.volCcy24h || 0),
    chgPct: open ? +(((last - open) / open) * 100).toFixed(3) : null, ts: Number(t.ts || Date.now()),
  };
}

/** K 线：bar ∈ 1m/5m/15m/1H/4H/1D/1W，返回时间升序 */
async function candles(instId = cfg.defaults.instId, bar = '1H', limit = 100) {
  const j = await okxGet(`/api/v5/market/candles?instId=${instId}&bar=${bar}&limit=${Math.min(Number(limit) || 100, 300)}`);
  return (j.data || []).map((d) => ({ ts: Number(d[0]), o: +d[1], h: +d[2], l: +d[3], c: +d[4], v: +d[5] })).reverse();
}

/** 资金费率（当前 + 预测） */
async function fundingRate(instId = cfg.defaults.instId) {
  const j = await okxGet(`/api/v5/public/funding-rate?instId=${instId}`);
  const d = (j.data || [])[0] || {};
  return { instId, fundingRate: Number(d.fundingRate || 0), nextFundingRate: d.nextFundingRate ? Number(d.nextFundingRate) : null, nextFundingTime: Number(d.nextFundingTime || 0) };
}

/** 持仓量 OI（张 / 币 / 美元三口径） */
async function openInterest(instId = cfg.defaults.instId) {
  const j = await okxGet(`/api/v5/public/open-interest?instType=SWAP&instId=${instId}`);
  const d = (j.data || [])[0] || {};
  return { instId, oi: Number(d.oi || 0), oiCcy: Number(d.oiCcy || 0), oiUsd: Number(d.oiUsd || 0), ts: Number(d.ts || 0) };
}

/** 账户多空比（Rubik，ccy=BTC/ETH…，period=5m/1H/1D） */
async function longShortRatio(ccy = 'BTC', period = '5m') {
  const j = await okxGet(`/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${ccy}&period=${period}`);
  return (j.data || []).map((r) => ({ ts: Number(r[0]), ratio: Number(r[1]) }));
}

/** Taker 主动买卖量（instType=SPOT|CONTRACTS） */
async function takerVolume(ccy = 'BTC', instType = 'CONTRACTS', period = '5m') {
  const j = await okxGet(`/api/v5/rubik/stat/taker-volume?ccy=${ccy}&instType=${instType}&period=${period}`);
  return (j.data || []).map((r) => ({ ts: Number(r[0]), sell: Number(r[1]), buy: Number(r[2]) }));
}

/** 合约规格（面值 ctVal / 最小下单 minSz / 步长 lotSz / 价格精度 tickSz / 最大杠杆） */
async function instrument(instId = cfg.defaults.instId) {
  const j = await okxGet(`/api/v5/public/instruments?instType=SWAP&instId=${instId}`);
  const d = (j.data || [])[0] || {};
  return { instId, ctVal: Number(d.ctVal || 1), ctValCcy: d.ctValCcy, minSz: Number(d.minSz || 0), lotSz: Number(d.lotSz || 0), tickSz: Number(d.tickSz || 0), maxLever: Number(d.lever || 0), state: d.state };
}

/** 张数 ↔ 名义价值（USD）换算：contracts × 面值 × 价格 */
async function contractValue(instId, contracts, price) {
  const ins = await instrument(instId);
  const px = price || (await ticker(instId)).last;
  const notionalUsd = ins.ctVal * Number(contracts) * px;
  return { instId, contracts: Number(contracts), ctVal: ins.ctVal, price: px, notionalUsd: +notionalUsd.toFixed(2) };
}

/** 一步取全部关键指标（给面板/机器人用） */
async function snapshot(instId = cfg.defaults.instId) {
  const [t, fr, oi, lsr, taker, ins] = await Promise.all([
    ticker(instId), fundingRate(instId), openInterest(instId),
    longShortRatio('BTC', '5m'), takerVolume('BTC', 'CONTRACTS', '5m'), instrument(instId),
  ]);
  const l = lsr[0] || null, tk = taker[0] || null;
  return {
    instId, ts: Date.now(), ticker: t, funding: fr, oi,
    lsr: l ? l.ratio : null, takerRatio: tk && tk.sell ? +(tk.buy / tk.sell).toFixed(3) : null,
    instrument: ins,
    notionalPerContract: +(ins.ctVal * t.last).toFixed(4),
  };
}

module.exports = { okxGet, ticker, candles, fundingRate, openInterest, longShortRatio, takerVolume, instrument, contractValue, snapshot };
