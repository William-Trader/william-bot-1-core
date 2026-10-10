/*!
 * public/charts2.js - william-bot-1-core key panel logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-F6C5A288
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
/* charts2.js — 追加两张看板图（每日盈亏 / 风控仪表），与 charts.js 同主题 */
(function () {
  'use strict';
  var sigD = '', sigG = '';
  function el(id) { return document.getElementById(id); }
  function fmtU(n) { n = Number(n) || 0; return (n >= 0 ? '+' : '') + n.toFixed(2) + ' U'; }

  /* ① 每日盈亏（按日聚合 dailyLog，避免多次日结的重复条目） */
  function drawDaily(log) {
    var host = el('ch-daily'); if (!host) return;
    var byDay = {};
    (log || []).forEach(function (r) {
      var d = String(r.day || '').slice(0, 10); if (!d) return;
      byDay[d] = (byDay[d] || 0) + (Number(r.pnlUsd) || 0);
    });
    var days = Object.keys(byDay).sort().slice(-30);
    if (days.length < 1) { host.innerHTML = '<div class="ch-empty">暂无日结记录</div>'; return; }   // 1 天也画（今日柱），随天数累积自动变趋势
    var sigNow = days.length + ':' + byDay[days[days.length - 1]].toFixed(3);
    if (sigD === sigNow) return; sigD = sigNow;
    host.innerHTML = '';
    var xs = days.map(function (d) { return Math.round(new Date(d + 'T00:00:00').getTime() / 1000); });
    var ys = days.map(function (d) { return +byDay[d].toFixed(4); });
    var w = host.clientWidth || 560, h = 170;
    try {
      new uPlot({
        width: w, height: h, padding: [8, 8, 4, 8],
        cursor: { points: { size: 6 } },
        scales: { x: { time: true } },
        axes: [
          { stroke: 'rgba(255,255,255,.35)', grid: { stroke: 'rgba(255,255,255,.05)' }, font: '11px system-ui' },
          { stroke: 'rgba(255,255,255,.35)', grid: { stroke: 'rgba(255,255,255,.05)' }, font: '11px system-ui', size: 52 }
        ],
        series: [ {}, { label: (days.length > 1 ? '日盈亏(U)' : '今日盈亏(U)'), paths: uPlot.paths.bars({ size: [0.65, 20] }), points: { show: false },
          fill: function (u, i) { return ys[i] >= 0 ? 'rgba(43,164,113,.85)' : 'rgba(198,71,81,.85)'; },
          value: function (u, v) { return v == null ? '--' : fmtU(v); } } ]
      }, [xs, ys], host);
    } catch (e) { host.innerHTML = '<div class="ch-empty">图表初始化失败</div>'; }
  }

  /* ② 风控仪表：占用率 / 日亏进度 / 最近风险篮子 */
  function drawGauge(st, bd) {
    var host = el('ch-gauge'); if (!host) return;
    if (!st) { host.innerHTML = '<div class="ch-empty">等待数据…</div>'; return; }
    var eq = Number(st.equity) || 0;
    var pol = st.policy || {};
    var used = Number((bd && bd.totals && bd.totals.marginUsed) || 0);
    var capPct = Number(pol.maxTotalOccupancyPct) || 45;
    var occPct = eq ? used / eq * 100 : 0;
    var occOfCap = capPct ? Math.min(100, occPct / capPct * 100) : 0;
    var dayPnl = Number(st.todayPnlUsd) || 0;
    var lossCap = (Number(pol.dailyLossPct) || 5) / 100 * eq;
    var lossUsed = dayPnl < 0 ? Math.min(100, Math.abs(dayPnl) / Math.max(lossCap, 0.01) * 100) : 0;
    // 最近风险：距止损 %
    var rows = ((bd && bd.baskets) || []).map(function (b) {
      var px = Number(b.lastPrice) || 0, stop = Number(b.stopPx) || 0, liq = Number(b.liqPxReal) || 0;
      if (!px) return null;
      return { n: String(b.instId || '').replace('-USDT-SWAP', ''), d: stop ? Math.abs(px - stop) / px * 100 : null,
        l: liq ? Math.abs(px - liq) / px * 100 : null };
    }).filter(Boolean).sort(function (a, b) { return (a.d == null ? 999 : a.d) - (b.d == null ? 999 : b.d); }).slice(0, 4);
    var sigNow = [eq.toFixed(2), used.toFixed(2), dayPnl.toFixed(3), rows.map(function (r) { return r.n + (r.d || 0).toFixed(1); }).join('')].join('|');
    if (sigG === sigNow) return; sigG = sigNow;
    function bar(label, valTxt, pct, cls) {
      return '<div class="g-row"><div class="g-lab">' + label + '</div>' +
        '<div class="g-bar"><div class="g-fill ' + cls + '" style="width:' + Math.max(0, Math.min(100, pct)).toFixed(1) + '%"></div></div>' +
        '<div class="g-val">' + valTxt + '</div></div>';
    }
    host.innerHTML =
      bar('保证金占用', occPct.toFixed(1) + '% / 上限' + capPct + '%', occOfCap, occOfCap > 85 ? 'is-danger' : occOfCap > 60 ? 'is-warn' : 'is-ok') +
      bar('日亏进度', fmtU(dayPnl) + ' / 熔断 ' + (-lossCap).toFixed(1) + 'U', lossUsed, lossUsed > 80 ? 'is-danger' : lossUsed > 50 ? 'is-warn' : 'is-ok') +
      '<div class="g-sep">最近风险（距止损）</div>' +
      (rows.length ? rows.map(function (r) {
        var pct = r.l ? Math.min(100, Math.max(0, 100 - (r.d / r.l) * 100)) : 0;
        return '<div class="g-row"><div class="g-lab">' + r.n + '</div>' +
          '<div class="g-bar"><div class="g-fill ' + (r.d != null && r.d < 3 ? 'is-danger' : r.d != null && r.d < 8 ? 'is-warn' : 'is-ok') + '" style="width:' + pct.toFixed(1) + '%"></div></div>' +
          '<div class="g-val">' + (r.d == null ? '--' : r.d.toFixed(1) + '%') + '</div></div>';
      }).join('') : '<div class="ch-empty" style="min-height:60px">无在仓</div>');
  }

  function load() {
    if (document.hidden) return;
    fetch('/api/martin/state', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) { drawDaily(d && d.dailyLog); }).catch(function () {});
    Promise.all([
      fetch('/api/martin/state', { cache: 'no-store' }).then(function (r) { return r.json(); }),
      fetch('/api/martin/baskets', { cache: 'no-store' }).then(function (r) { return r.json(); })
    ]).then(function (a) { drawGauge(a[0], a[1]); }).catch(function () {});
  }
  var rt = null;
  window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { sigD = ''; sigG = ''; load(); }, 200); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load); else load();
  setInterval(load, 15000);
})();
