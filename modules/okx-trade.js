/*!
 * modules/okx-trade.js - william-bot-1-core key engine logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-8B049E06
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
/**
 * 【模块 2】OKX 下单（签名私有接口）
 *
 * ⚠️ 默认 **dry-run**：只做参数校验与预览，不发任何真实请求。
 *    要真正下单，启动时设 `LIVE=1`（见 config.js 的 live 开关）。
 * 凭据从 /root/.okx/config.toml 读（与 okx CLI 共用），密钥不出本机。
 */
const crypto = require('crypto');
const { execFile } = require('child_process');
const cfg = require('../config');

function sign(method, requestPath, bodyStr) {
  const ts = new Date().toISOString().replace(/\.(\d{3})Z$/, '.$1Z');
  const msg = ts + method.toUpperCase() + requestPath + (bodyStr || '');
  const sign = crypto.createHmac('sha256', cfg.creds.secretKey).update(msg).digest('base64');
  return {
    'OK-ACCESS-KEY': cfg.creds.apiKey,
    'OK-ACCESS-SIGN': sign,
    'OK-ACCESS-TIMESTAMP': ts,
    'OK-ACCESS-PASSPHRASE': cfg.creds.passphrase,
    'Content-Type': 'application/json',
    ...(cfg.creds.demo ? { 'x-simulated-trading': '1' } : {}),
  };
}

/** 私有请求（签名 + 代理 + UA） */
function okxPrivate(method, requestPath, body, timeoutMs = 20000) {
  if (!cfg.hasCreds) return Promise.reject(new Error('未配置 OKX 凭据（/root/.okx/config.toml）'));
  const bodyStr = body ? JSON.stringify(body) : '';
  const headers = sign(method, requestPath, bodyStr);
  const args = ['-s', '--max-time', String(Math.ceil(timeoutMs / 1000)), '-A', cfg.userAgent, '-x', cfg.proxy, '-X', method.toUpperCase()];
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`);
  if (bodyStr) args.push('-d', bodyStr);
  args.push(cfg.baseUrl + requestPath);
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/curl', args, { encoding: 'utf8', timeout: timeoutMs + 3000 }, (err, stdout) => {
      if (err) return reject(new Error(`curl ${err.message}`));
      let j;
      try { j = JSON.parse(stdout); } catch { return reject(new Error(`非 JSON 响应：${String(stdout).slice(0, 80)}`)); }
      if (j.code && j.code !== '0') return reject(new Error(`OKX ${j.code}: ${j.msg || ''} ${JSON.stringify((j.data || [])[0] || {}).slice(0, 120)}`));
      resolve(j.data);
    });
  });
}

/* ── 只读查询 ───────────────────────────────────── */

const balance = () => okxPrivate('GET', '/api/v5/account/balance');
const positions = (instId) => okxPrivate('GET', '/api/v5/account/positions' + (instId ? `?instType=SWAP&instId=${instId}` : '?instType=SWAP'));
const pendingOrders = (instId) => okxPrivate('GET', '/api/v5/trade/orders-pending' + (instId ? `?instId=${instId}` : ''));
const config = () => okxPrivate('GET', '/api/v5/account/config');

/* ── 写操作（全部过 dry-run 闸门）────────────────── */

/** 下单参数校验 + 预览（不发请求） */
function previewOrder(p) {
  const need = ['instId', 'side', 'sz'];
  const missing = need.filter((k) => p[k] === undefined || p[k] === null || p[k] === '');
  if (missing.length) return { ok: false, error: `缺少必填字段: ${missing.join(', ')}` };
  if (!['buy', 'sell'].includes(p.side)) return { ok: false, error: "side 必须是 buy | sell" };
  const ordType = p.ordType || 'limit';
  if (!['limit', 'market', 'post_only', 'fok', 'ioc'].includes(ordType)) return { ok: false, error: `ordType 不支持: ${ordType}` };
  if (ordType === 'limit' && !p.px) return { ok: false, error: '限价单必须给 px' };
  if (Number(p.sz) <= 0) return { ok: false, error: 'sz（张数）必须 > 0' };
  return {
    ok: true, dryRun: !cfg.live,
    request: {
      instId: p.instId, tdMode: p.tdMode || cfg.defaults.tdMode, side: p.side, ordType,
      sz: String(p.sz), ...(p.px ? { px: String(p.px) } : {}),
      ...(p.posSide ? { posSide: p.posSide } : {}), ...(p.reduceOnly ? { reduceOnly: true } : {}),
      ...(p.tpTriggerPx || p.slTriggerPx ? {
        attachAlgoOrds: [{
          ...(p.tpTriggerPx ? { tpTriggerPx: String(p.tpTriggerPx), tpOrdPx: p.tpOrdPx != null ? String(p.tpOrdPx) : '-1' } : {}),
          ...(p.slTriggerPx ? { slTriggerPx: String(p.slTriggerPx), slOrdPx: p.slOrdPx != null ? String(p.slOrdPx) : '-1' } : {}),
        }],
      } : {}),
      ...(p.clOrdId ? { clOrdId: p.clOrdId } : {}),
    },
  };
}

/** 下单：dry-run 时只返回预览；LIVE=1 时发真实请求 */
async function placeOrder(p) {
  const pre = previewOrder(p);
  if (!pre.ok) return pre;
  if (!cfg.live) return { ok: true, dryRun: true, sent: false, request: pre.request, note: 'dry-run：未发送任何订单（要真下单设 LIVE=1）' };
  const data = await okxPrivate('POST', '/api/v5/trade/order', pre.request);
  return { ok: true, dryRun: false, sent: true, request: pre.request, result: data };
}

/** 撤单 */
async function cancelOrder({ instId, ordId }) {
  if (!instId || !ordId) return { ok: false, error: '需要 instId 与 ordId' };
  if (!cfg.live) return { ok: true, dryRun: true, sent: false, request: { instId, ordId } };
  const data = await okxPrivate('POST', '/api/v5/trade/cancel-order', { instId, ordId });
  return { ok: true, dryRun: false, sent: true, result: data };
}

/** 市价平仓（整个标的按方向） */
async function closePosition({ instId, mgnMode, posSide, ccy, autoCxl }) {
  if (!instId) return { ok: false, error: '需要 instId' };
  const body = { instId, mgnMode: mgnMode || cfg.defaults.tdMode, ...(posSide ? { posSide } : {}), ...(ccy ? { ccy } : {}), ...(autoCxl ? { autoCxl: true } : {}) };
  if (!cfg.live) return { ok: true, dryRun: true, sent: false, request: body };
  const data = await okxPrivate('POST', '/api/v5/trade/close-position', body);
  return { ok: true, dryRun: false, sent: true, result: data };
}

/** 设置杠杆（逐仓需带 posSide） */
  async function setLeverage({ instId, lever, mgnMode, posSide } = {}) {
    if (!instId || !lever) return { ok: false, error: '需要 instId 与 lever' };
    // 本账户 long_short_mode：posSide 必填（缺省会被 OKX 拒 51000）；逐仓按 instId+posSide 生效
    const body = { instId, lever: String(lever), mgnMode: mgnMode || cfg.defaults.tdMode };
    if (posSide) body.posSide = posSide;
    if (!cfg.live) return { ok: true, dryRun: true, sent: false, request: body };
    const data = await okxPrivate('POST', '/api/v5/account/set-leverage', body);
    const row = (Array.isArray(data) ? data[0] : (data && data.data && data.data[0])) || {};
    const code = String(row.code || (data && data.code) || '0');
    if (code !== '0') return { ok: false, dryRun: false, sent: true, error: row.sMsg || ('set-leverage 失败 code=' + code), result: data };
    return { ok: true, dryRun: false, sent: true, lever: row.lever || String(lever), posSide: row.posSide || posSide || null, result: data };
  }

module.exports = { sign, okxPrivate, balance, positions, pendingOrders, config, previewOrder, placeOrder, cancelOrder, closePosition, setLeverage, live: () => cfg.live };
