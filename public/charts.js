/*!
 * public/charts.js - william-bot-1-core key panel logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-DF508F03
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
/* charts.js — 直观可视化层（自托管 uPlot；只读接口，不改任何交易逻辑）
   三个模块：
     ① 权益曲线（时间序列，uPlot）
     ② 每笔盈亏柱状 + 累计曲线（uPlot）
     ③ 篮子风险距离条（纯 CSS，无需图表库：距止损/距爆仓的百分比）
   性能：仅当数据签名变化时重绘；窗口缩放时防抖重绘；页面隐藏时不轮询。 */
(function () {
  'use strict';
  var API = { state: '/api/martin/state', baskets: '/api/martin/baskets' };
  var charts = { eq: null, pnl: null };
  var sig = { eq: '', pnl: '', risk: '' };

  function el(id) { return document.getElementById(id); }
  function css(v, fb) { try { var s = getComputedStyle(document.documentElement).getPropertyValue(v).trim(); return s || fb; } catch (e) { return fb; } }
  function fmtUsd(n) { n = Number(n) || 0; return (n >= 0 ? '+' : '') + n.toFixed(2) + ' U'; }

  /* ── ① 权益曲线 ─────────────────────────────────────────── */
  function drawEquity(curve) {
    var host = el('ch-equity');
    if (!host) return;
    var pts = (curve || []).map(function (p) { return [Math.round(Number(p.ts) / 1000), Number(p.equity)]; }).filter(function (p) { return isFinite(p[0]) && isFinite(p[1]); });
    if (pts.length < 2) { host.innerHTML = '<div class="ch-empty">暂无足够权益点（等巡检累积）</div>'; return; }
    var sigNow = pts.length + ':' + pts[pts.length - 1][1].toFixed(2);
    if (sig.eq === sigNow && charts.eq) return;
    sig.eq = sigNow;
    host.innerHTML = '';
    var w = host.clientWidth || 600, h = 190;
    var data = [pts.map(function (p) { return p[0]; }), pts.map(function (p) { return p[1]; })];
    var opts = {
      width: w, height: h, padding: [8, 8, 4, 8],
      cursor: { y: false, points: { size: 6 } },
      scales: { x: { time: true }, y: { range: function (u, mn, mx) { var pad = Math.max((mx - mn) * 0.15, 0.5); return [mn - pad, mx + pad]; } } },
      axes: [
        { stroke: css('--ds-text-color-secondary', '#9aa0a6'), grid: { stroke: 'rgba(255,255,255,.05)' }, ticks: { stroke: 'rgba(255,255,255,.10)' }, font: '11px system-ui' },
        { stroke: css('--ds-text-color-secondary', '#9aa0a6'), grid: { stroke: 'rgba(255,255,255,.05)' }, ticks: { stroke: 'rgba(255,255,255,.10)' }, font: '11px system-ui', size: 52 }
      ],
      series: [
        {},
        { label: '权益(U)', stroke: css('--ds-brand-8', '#4582e6'), width: 2,
          fill: 'rgba(69,130,230,.14)',
          value: function (u, v) { return v == null ? '--' : v.toFixed(2) + ' U'; } }
      ]
    };
    try { charts.eq = new uPlot(opts, data, host); } catch (e) { host.innerHTML = '<div class="ch-empty">图表初始化失败</div>'; }
  }

  /* ── ② 每笔盈亏 + 累计 ──────────────────────────────────── */
  function drawPnl(closed) {
    var host = el('ch-pnl');
    if (!host) return;
    var rows = (closed || []).filter(function (x) {
      return x && x.closedAt && x.realizedPnl !== undefined && x.realizedPnl !== null && isFinite(Number(x.realizedPnl));
    })
      .sort(function (a, b) { return Number(a.closedAt) - Number(b.closedAt); });
    if (rows.length < 2) { host.innerHTML = '<div class="ch-empty">暂无已平仓记录</div>'; return; }
    var sigNow = rows.length + ':' + rows[rows.length - 1].closedAt;
    if (sig.pnl === sigNow && charts.pnl) return;
    sig.pnl = sigNow;
    host.innerHTML = '';
    var xs = rows.map(function (r) { return Math.round(Number(r.closedAt) / 1000); });
    var pnl = rows.map(function (r) { return Number(r.realizedPnl) || 0; });
    var cum = [], s = 0; pnl.forEach(function (v) { s += v; cum.push(+s.toFixed(4)); });
    var w = host.clientWidth || 600, h = 190;
    var opts = {
      width: w, height: h, padding: [8, 8, 4, 8],
      cursor: { points: { size: 6 } },
      scales: { x: { time: true } },
      axes: [
        { stroke: 'rgba(255,255,255,.35)', grid: { stroke: 'rgba(255,255,255,.05)' }, font: '11px system-ui' },
        { stroke: 'rgba(255,255,255,.35)', grid: { stroke: 'rgba(255,255,255,.05)' }, font: '11px system-ui', size: 52 }
      ],
      series: [
        {},
        { label: '单笔(U)', paths: uPlot.paths.bars({ size: [0.6, 12] }), points: { show: false },
          fill: function (u, i) { return pnl[i] >= 0 ? 'rgba(43,164,113,.85)' : 'rgba(198,71,81,.85)'; },
          value: function (u, v) { return v == null ? '--' : fmtUsd(v); } },
        { label: '累计(U)', stroke: '#e8b339', width: 2, points: { show: false },
          value: function (u, v) { return v == null ? '--' : fmtUsd(v); } }
      ]
    };
    try { charts.pnl = new uPlot(opts, [xs, pnl, cum], host); } catch (e) { host.innerHTML = '<div class="ch-empty">图表初始化失败</div>'; }
  }

  /* ── ③ 篮子风险距离条（纯 CSS，最直观） ─────────────────── */
  function drawRisk(baskets) {
    var host = el('ch-risk');
    if (!host) return;
    var bs = (baskets && baskets.baskets) || [];
    var sigNow = bs.map(function (b) { return b.instId + (b.levelCount || 0) + (b.stopPx || 0) + (b.lastPrice || 0); }).join('|');
    if (sig.risk === sigNow) return;
    sig.risk = sigNow;
    if (!bs.length) { host.innerHTML = '<div class="ch-empty">当前无在仓篮子</div>'; return; }
    var html = bs.map(function (b) {
      var px = Number(b.lastPrice) || 0, avg = Number(b.avgPx) || px, stop = Number(b.stopPx) || 0, liq = Number(b.liqPxReal) || Number(b.liquidationPx) || 0;
      if (!px) return '';
      var short = String(b.side) === 'short';
      var dStop = stop ? Math.abs(px - stop) / px * 100 : null;
      var dLiq = liq ? Math.abs(px - liq) / px * 100 : null;
      var upl = Number(b.upl) || 0;
      // 风险条：以「距爆仓」为 100% 基准，标出止损位置
      var stopPctOnBar = (dStop != null && dLiq) ? Math.min(100, Math.max(0, 100 - (dStop / dLiq) * 100)) : 0;
      var name = String(b.instId || '').replace('-USDT-SWAP', '');
      var cls = upl >= 0 ? 'up' : 'down';
      return '<div class="risk-row">' +
        '<div class="risk-name">' + name + '<span class="risk-side">' + (short ? '空' : '多') + ' ×' + (b.levelCount || 1) + '层</span></div>' +
        '<div class="risk-bar"><div class="risk-fill"></div><div class="risk-stop" style="left:' + stopPctOnBar.toFixed(1) + '%" title="止损位置"></div></div>' +
        '<div class="risk-num"><span class="' + cls + '">' + fmtUsd(upl) + '</span>' +
          '<span class="risk-dist">距止损 ' + (dStop == null ? '--' : dStop.toFixed(1) + '%') + ' · 距爆仓 ' + (dLiq == null ? '--' : dLiq.toFixed(1) + '%') + '</span></div>' +
        '</div>';
    }).join('');
    host.innerHTML = html || '<div class="ch-empty">暂无数据</div>';
  }

  /* ── 数据拉取与重绘 ─────────────────────────────────────── */
  function load() {
    if (document.hidden) return;
    fetch(API.state, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      drawEquity(d && d.curve);
    }).catch(function () {});
    fetch(API.baskets, { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
      drawRisk(d);
      drawPnl((d && d.history) || []);          // ← 平仓记录来自 baskets.history
    }).catch(function () {});
  }

  var rt = null;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { charts.eq = null; charts.pnl = null; sig = { eq: '', pnl: '', risk: '' }; load(); }, 200); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load); else load();
  setInterval(load, 15000);   // 15 秒一刷（不跟主页面轮询抢带宽）
})();
