/*!
 * server.js - william-bot-1-core key engine logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-0CDD4B10
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
/**
 * 威廉机器人 1 号 · 极简底座
 * 只有两个模块：okx-data（拉数据） + okx-trade（下单）
 *
 * 启动：PORT=3100 node server.js        （默认 dry-run，不下单）
 * 实盘：LIVE=1 PORT=3100 node server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const data = require('./modules/okx-data');
const trade = require('./modules/okx-trade');
/* ── 追加：验算报告（只读 data/verify-YYYYMMDD.json；由 scripts/verify-report.js 产出） ── */
const verifyMod = require('./modules/verify');
const VERIFY_DIR = process.env.MARTIN_DATA_DIR || path.join(__dirname, 'data');
/* ── 追加：马丁调度器（B 方，只读文件 + 触发调度；不改既有路由语义） ── */
const sched = require('./modules/scheduler');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const send = (obj, code = 200) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const instId = u.searchParams.get('instId') || cfg.defaults.instId;

  try {
    /* ── 元信息 ── */
    if (p === '/health') return send({ ok: true, service: 'william-bot-1-core', live: cfg.live, ts: Date.now() });
    if (p === '/api/config') return send({
      ok: true, live: cfg.live, dryRun: !cfg.live, profile: cfg.profile,
      hasCreds: cfg.hasCreds, creds: cfg.maskAll(), proxy: cfg.proxy,
      defaults: cfg.defaults, configPath: cfg.configPath,
      modules: ['okx-data（拉数据）', 'okx-trade（下单）'],
    });

    /* ── 模块 1：拉数据 ── */
    if (p === '/api/data/snapshot') return send({ ok: true, data: await data.snapshot(instId) });
    if (p === '/api/data/ticker') return send({ ok: true, data: await data.ticker(instId) });
    if (p === '/api/data/candles') return send({ ok: true, data: await data.candles(instId, u.searchParams.get('bar') || '1H', u.searchParams.get('limit') || 100) });
    if (p === '/api/data/funding') return send({ ok: true, data: await data.fundingRate(instId) });
    if (p === '/api/data/oi') return send({ ok: true, data: await data.openInterest(instId) });
    if (p === '/api/data/lsr') return send({ ok: true, data: await data.longShortRatio(u.searchParams.get('ccy') || 'BTC', u.searchParams.get('period') || '5m') });
    if (p === '/api/data/taker') return send({ ok: true, data: await data.takerVolume(u.searchParams.get('ccy') || 'BTC', u.searchParams.get('instType') || 'CONTRACTS', u.searchParams.get('period') || '5m') });
    if (p === '/api/data/instrument') return send({ ok: true, data: await data.instrument(instId) });
    if (p === '/api/data/contract-value') return send({ ok: true, data: await data.contractValue(instId, u.searchParams.get('size') || 1, u.searchParams.get('price') || 0) });

    /* ── 模块 2：下单 ── */
    if (p === '/api/trade/account') return send({ ok: true, data: await trade.config() });
    if (p === '/api/trade/balance') return send({ ok: true, data: await trade.balance() });
    if (p === '/api/trade/positions') return send({ ok: true, data: await trade.positions(u.searchParams.get('instId') || instId) });
    if (p === '/api/trade/orders') return send({ ok: true, data: await trade.pendingOrders(u.searchParams.get('instId') || instId) });
    if (p === '/api/trade/leverage') return send({ ok: true, data: await trade.setLeverage({ instId, lever: u.searchParams.get('lever') || cfg.defaults.lever, mgnMode: u.searchParams.get('mgnMode') || cfg.defaults.tdMode, posSide: u.searchParams.get('posSide') }) });

    /* ── 马丁面板路由（B 方追加；dry-run 时下单类接口只返回预览） ── */
    if (p === '/api/martin/candidates') return send(sched.getCandidates());
    if (p === '/api/martin/baskets') return send(sched.getBaskets());
    if (p === '/api/martin/state') {
      // 出口瘦身：去掉巨型数组，只留界面真正渲染的窗口（否则首屏要下载/解析 60KB+）
      const st = sched.getState() || {};
      const capArr = (a, n) => (Array.isArray(a) ? a.slice(-n) : a);
      const slim = { ...st };
      if (slim.log) slim.log = capArr(slim.log, 40);
      if (slim.events) slim.events = capArr(slim.events, 40);
      if (slim.curve) slim.curve = capArr(slim.curve, 120);
      if (slim.closed) slim.closed = capArr(slim.closed.map((x) => ({ instId: x.instId, side: x.side, closeReason: x.closeReason, closedAt: x.closedAt, realizedPnl: x.realizedPnl, pnlKnown: x.pnlKnown !== false, pnlSource: x.pnlSource || null, levelCount: (x.levels || []).length })), 40);
      if (slim.history) slim.history = capArr(slim.history, 20);
      // 前端看板需要：日结曲线 / 止盈统计 / 幽灵表（小字段，体积可忽略）
      if (slim.dailyLog) slim.dailyLog = capArr(slim.dailyLog, 60);
      slim.tpStats = st.tpStats || null;
      slim.phantoms = st.phantoms ? Object.keys(st.phantoms).length : 0;
      slim.reconciliation = st.reconciliation || null;
      return send(slim);
    }
    if (p === '/api/martin/backtest') return send(await sched.getBacktest());
    if (p === '/api/martin/policy' && req.method === 'GET') return send(sched.getPolicy());
    /* ── 报告接口（供面板「报告」区：列表 + 全文，只读）── */
    if (p === '/api/reports') {
      const fsx = require('fs');
      const roots = [
        { dir: '/opt/wb-core/data', prefix: 'data/', group: '运行产物' },
        { dir: '/opt/wb-core/design', prefix: 'design/', group: '设计文档' },
      ];
      const files = [];
      const walk = (dir, prefix, group, depth = 2) => {
        let ents = [];
        try { ents = fsx.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
          if (e.name.startsWith('.') || e.name.endsWith('.bak-' + e.name.split('.bak-')[1] || '')) continue;
          const full = dir + '/' + e.name;
          if (e.isDirectory() && depth > 0) { walk(full, prefix + e.name + '/', group, depth - 1); continue; }
          if (!e.isFile() || !/\.(md|txt)$/.test(e.name)) continue;
          let st = null; try { st = fsx.statSync(full); } catch { continue; }
          files.push({ name: e.name, path: prefix + e.name, mtime: st.mtimeMs, size: st.size, group });
        }
      };
      for (const r of roots) walk(r.dir, r.prefix, r.group);
      // 七月的历史报告
      try {
        for (const bucket of ['active', 'archived']) {
          for (const c of fsx.readdirSync('/opt/july/' + bucket)) {
            const rep = '/opt/july/' + bucket + '/' + c + '/reports';
            for (const f of fsx.readdirSync(rep)) {
              if (!f.endsWith('.md')) continue;
              const st = fsx.statSync(rep + '/' + f);
              files.push({ name: f, path: 'july/' + bucket + '/' + c + '/reports/' + f, mtime: st.mtimeMs, size: st.size, group: '七月报告' });
            }
          }
        }
      } catch { /* 无七月目录 */ }
      files.sort((a, b) => b.mtime - a.mtime);
      const top = files.slice(0, 200);
      // 前端契约：面板读 d.items（兼容 files 命名）
      return send({ ok: true, count: files.length, items: top, files: top });
    }
    if (p === '/api/report') {
      const fsx = require('fs');
      const path0 = require('path');
      const rel = String(u.searchParams.get('path') || '').replace(/\.\./g, '');
      let full = null;
      if (rel.startsWith('data/') || rel.startsWith('design/')) full = path0.join('/opt/wb-core', rel);
      else if (rel.startsWith('july/')) full = path0.join('/opt/july', rel.slice(5));
      if (!full || !/\.(md|txt)$/i.test(full) || !fsx.existsSync(full) || !fsx.statSync(full).isFile()) return send({ ok: false, error: 'not found' }, 404);
      return send({ ok: true, path: rel, md: fsx.readFileSync(full, 'utf8') });
    }

    /* ── 面板新增（Kimi 前端契约）：解除熔断 + 开篮预览（均不产生交易）── */
    /* ── 健康检查（Kimi 前端基座页调用）── */
    if (p === '/api/health') {
      const st = require('./modules/scheduler').getState() || {};
      const sch = st.scheduler || {};
      return send({
        ok: true, service: 'william-bot-1', mode: st.mode, dryRun: !!st.dryRun,
        equity: st.equity, openBaskets: st.openBaskets, day: st.day,
        heartbeatAgeSec: sch.heartbeatAgeSec, stale: !!sch.stale, ticks: sch.ticks,
        engine: (st.engine && st.engine.source) || null, ts: Date.now(),
        services: (() => { try { return require('./modules/scheduler').systemHealth().servicesSummary; } catch (e) { return ''; } })(),
        timers: (() => { try { return require('./modules/scheduler').systemHealth().timersSummary; } catch (e) { return ''; } })(),
      });
    }

    if (p === '/api/martin/clear-circuit-breaker' && req.method === 'POST') {
      const store = require('./modules/store');
      const st = store.load();
      const was = !!st.circuitBreaker;
      st.circuitBreaker = false; st.circuitBreakerAt = null; st.circuitBreakerReason = null;
      st.log = [...(st.log || []), { ts: Date.now(), level: 'warn', msg: '人工解除熔断（面板操作）· 当日亏损计数未清零，日结时重置' }].slice(-300);
      store.save(st);
      return send({ ok: true, wasSet: was, note: '熔断已解除' });
    }
    if (p === '/api/martin/open-preview' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const sched = require('./modules/scheduler');
        const margin = require('./modules/margin');
        const data = require('./modules/okx-data');
        const cand = sched.getCandidates() || {};
        const pick = ((cand.picked) || []).find((x) => x.instId === body.instId) || { instId: body.instId };
        const policy = (sched.getPolicy() || {}).policy || {};
        const st = sched.getState() || {};
        const eq = Number(st.equity) || 0;
        const ins = await data.instrument(body.instId).catch(() => ({}));
        const refPrice = Number(pick.last) || Number((await data.ticker(body.instId).catch(() => ({}))).last) || 0;
        const plan = margin.planBasket({
          equity: eq, atrPct: pick.atrPct, price: refPrice,
          instrument: { ctVal: ins.ctVal, lotSz: ins.lotSz, minSz: ins.minSz, maxLever: ins.maxLever },
          policy, openBaskets: [], sector: pick.sector, score: pick.score && pick.score.total,
        });
        return send({
          ok: true, dryRun: true, note: '仅预览：未下任何单',
          preview: {
            instId: body.instId, side: body.side, price: refPrice,
            canOpen: !!(plan && plan.ok), reason: (plan && plan.reason) || null,
            layer1Contracts: plan && plan.layer1Contracts, layer1NotionalUsd: plan && plan.layer1NotionalUsd,
            totalMarginUsd: plan && plan.totalMarginUsd, riskAtDeathUsd: plan && plan.riskAtDeathUsd,
            riskPctEquity: plan && plan.riskPctEquity, occupancyPct: plan && plan.occupancyPct,
            takeProfitPct: (policy.takeProfitPct > 0 ? policy.takeProfitPct : `ATR×${policy.tpAtrMult} (${policy.tpMinPct}~${policy.tpMaxPct}%)`),
            stopAtrMult: policy.deathAtrMult, maxLevels: policy.maxLevels, multiplier: policy.multiplier,
            warnings: (plan && plan.warnings) || [],
          },
        });
      } catch (e) { return send({ ok: false, error: String(e.message || e).slice(0, 200) }, 500); }
    }

    if (p === '/api/verify/report') return send(verifyMod.latest(VERIFY_DIR));
    if (p === '/api/martin/policy-schema') {
      const ps = require('./modules/policy-schema');
      const cur = sched.getPolicy();
      const c = (cur && cur.policy) || cur || {};
      const v = ps.validate({}, c);
      return send({ ok: true, fields: ps.FIELDS, presets: ps.PRESETS, current: c, meta: v.meta });
    }

    if (req.method === 'POST') {
      if (p === '/api/martin/policy') {
        const ps = require('./modules/policy-schema');
        const body = await readBody(req);
        const cur = (sched.getPolicy() || {}).policy || {};
        const v = ps.validate(body, cur);
        if (!v.ok) return send({ ok: false, stage: 'validate', errors: v.errors, warnings: v.warnings, policy: cur });
        const r = sched.savePolicy(body);
        return send({ ...r, validation: { warnings: v.warnings, clamped: v.clamped, meta: v.meta } });
      }
      if (p === '/api/martin/run-backtest') return send(await sched.runBacktest());
      if (p === '/api/martin/screen-now') return send(await sched.tickScreen());
      if (p === '/api/martin/pause') return send(sched.pause());
      if (p === '/api/martin/resume') return send(sched.resume(await readBody(req)));
      if (p === '/api/martin/open') return send(await sched.openBasket(await readBody(req)));
      const mClose = p.match(/^\/api\/martin\/close\/(.+)$/);
      if (mClose) return send(await sched.closeBasket({ ...(await readBody(req)), id: decodeURIComponent(mClose[1]) }));

      const body = await readBody(req);
      if (p === '/api/trade/order') return send({ ok: true, data: await trade.placeOrder({ ...body, instId: body.instId || instId }) });
      if (p === '/api/trade/preview') return send({ ok: true, data: trade.previewOrder({ ...body, instId: body.instId || instId }) });
      if (p === '/api/trade/cancel') return send({ ok: true, data: await trade.cancelOrder({ instId: body.instId || instId, ordId: body.ordId }) });
      if (p === '/api/trade/close') return send({ ok: true, data: await trade.closePosition({ instId: body.instId || instId, mgnMode: body.mgnMode, posSide: body.posSide, ccy: body.ccy }) });
      if (p === '/api/trade/set-leverage') return send({ ok: true, data: await trade.setLeverage({ instId: body.instId || instId, lever: body.lever, mgnMode: body.mgnMode, posSide: body.posSide }) });
    }

    /* ── 静态 ── */
    const file = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    const fp = path.join(__dirname, 'public', file);
    if (fp.startsWith(path.join(__dirname, 'public')) && fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
      return res.end(fs.readFileSync(fp));
    }
    return send({ ok: false, error: 'not found' }, 404);
  } catch (e) {
    return send({ ok: false, error: String(e.message || e).slice(0, 200) }, 500);
  }
});

server.listen(cfg.port, '127.0.0.1', () => {
  console.log(`威廉机器人 1 号 · 极简底座: http://127.0.0.1:${cfg.port}` +
    `  模式=${cfg.live ? '★ 实盘' : 'dry-run（不发单）'}  凭据=${cfg.hasCreds ? '已配置' : '缺失'}`);
});
