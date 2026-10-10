/*!
 * public/app.js - william-bot-1-core key panel logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-0BD9E433
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
/* ============================================================================
 * app.js —— 威廉马丁策略基站 · 共享运行时
 * 提供：WB_SHELL 壳渲染（顶栏+侧栏+模式横幅）、API 封装、轮询器、格式化、
 *       新鲜度徽标、Toast、确认弹窗、系统抽屉、价格轴、显示偏好。
 * 零框架、零 CDN、离线可用。全部注释为中文。
 * ========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------
   * WB_SHELL —— 壳配置：改这里即可定制导航/顶栏
   * key 对应 WB.shell.init(activeKey) 传入的当前页标识；
   * href 为页面内锚点或外链（external=true 新标签打开）。
   * ------------------------------------------------------------------ */
  const WB_SHELL = {
    brand: { icon: '🦞', name: '威廉策略基站' },
    navGroups: [
      {
        title: '监控',
        items: [
          { key: 'overview',    icon: '📈', text: '概览',   href: '#overview' },
          { key: 'baskets',     icon: '🧺', text: '篮子',   href: '#baskets', badgeId: 'nav-baskets-count' },
          { key: 'candidates',  icon: '🎯', text: '候选池', href: '#candidates' },
          { key: 'pnl',         icon: '💰', text: '收益',   href: '#pnl' },
        ],
      },
      {
        title: '研究 / 运行',
        items: [
          { key: 'verify', icon: '🔍', text: '验算', href: '#verify' },
          { key: 'report', icon: '📄', text: '报告', href: '#report' },
          { key: 'log',    icon: '🧾', text: '日志', href: '#log' },
        ],
      },
      {
        title: '设置',
        items: [
          { key: 'policy', icon: '⚙️', text: '参数', href: '#policy' },
        ],
      },
      {
        title: null, // 外链组，无标题，用分隔线
        dividerBefore: true,
        items: [
        ],
      },
    ],
    /* 顶栏右侧按钮（系统抽屉内容由调用方通过 WB.drawer.open 填充） */
    topbarButtons: [
      { key: 'pause',   text: '暂停调度', aria: '暂停或恢复调度' },
      { key: 'refresh', text: '刷新',     aria: '刷新数据' },
      { key: 'density', text: '密度',     aria: '切换显示密度（舒适/紧凑）' },
      { key: 'system',  text: '系统',     aria: '打开系统状态抽屉' },
    ],
  };

  /** 全局命名空间 */
  const WB = { SHELL: WB_SHELL };

  /* ================== 工具：HTML 转义 ================== */

  /**
   * HTML 转义，防注入。
   * @param {*} s 任意输入
   * @returns {string} 转义后的字符串
   */
  WB.esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  /* ================== 显示偏好 WB.prefs ==================
   * 存 localStorage["wb-prefs"]；密度切换应用到 body[data-density]。 */

  const PREFS_KEY = 'wb-prefs';

  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }

  WB.prefs = {
    /**
     * 读取偏好。
     * @param {string} key 键名
     * @param {*} def 默认值
     */
    get(key, def) {
      const v = loadPrefs()[key];
      return v === undefined ? def : v;
    },
    /**
     * 写入偏好；key === 'density' 时同步应用到 body[data-density]。
     * @param {string} key 键名
     * @param {*} val 值
     */
    set(key, val) {
      const p = loadPrefs();
      p[key] = val;
      try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch (e) { /* 隐私模式忽略 */ }
      if (key === 'density') WB.prefs.applyDensity();
    },
    /** 把存储的密度偏好应用到 <body>（comfort=默认不挂属性）。 */
    applyDensity() {
      const d = WB.prefs.get('density', 'comfort');
      if (d === 'compact') document.body.setAttribute('data-density', 'compact');
      else document.body.removeAttribute('data-density');
    },
  };
  // 启动即应用密度
  if (document.body) WB.prefs.applyDensity();
  else document.addEventListener('DOMContentLoaded', () => WB.prefs.applyDensity());

  /* ================== API 封装 WB.api ==================
   * 统一：成功返回解析后的 JSON；任何失败（网络/超时/HTTP 非 2xx/ok:false）
   * 都抛出 { ok:false, error } 形态的错误对象。 */

  const API_TIMEOUT = 10000; // 10s

  /**
   * 底层 fetch 封装（带 10s 超时）。
   * @param {string} path 以 / 开头的接口路径
   * @param {object} [opts] fetch 选项
   * @returns {Promise<object>} 解析后的 JSON
   * @throws {{ok:false, error:string, status?:number}}
   */
  async function apiFetch(path, opts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), API_TIMEOUT);
    try {
      const resp = await fetch(path, Object.assign({ signal: ctrl.signal }, opts));
      let data = null;
      try { data = await resp.json(); } catch (e) { data = null; }
      if (!resp.ok) {
        throw { ok: false, error: (data && data.error) || ('HTTP ' + resp.status), status: resp.status };
      }
      if (data && data.ok === false) {
        throw { ok: false, error: data.error || '接口返回 ok:false', status: resp.status, data };
      }
      return data;
    } catch (e) {
      if (e && e.ok === false) throw e;
      if (e && e.name === 'AbortError') throw { ok: false, error: '请求超时（10s）' };
      throw { ok: false, error: (e && e.message) || '网络错误' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 带重试的请求包装：网络错误 / 超时 / 5xx → 退避重试 2 次（共 3 次机会）。
   * 业务错误（ok:false / 4xx）不重试，避免掩盖真实问题。
   * 目的：移动端弱网下不再"一次失败就弹网络错误、模块留骨架"。
   */
  async function apiRetry(path, opts) {
    const waits = [350, 1000];
    let last = null;
    for (let i = 0; i <= waits.length; i++) {
      try { return await apiFetch(path, opts); }
      catch (e) {
        last = e;
        const transient = !(e && e.status) || (e && e.status >= 500);
        if (!transient || i === waits.length) break;
        await new Promise((r) => setTimeout(r, waits[i]));
      }
    }
    throw last || { ok: false, error: '网络错误' };
  }

  WB.api = {
    /** @param {string} path GET 接口路径 */
    get(path) { return apiRetry(path); },
    /**
     * @param {string} path POST 接口路径
     * @param {object} [body] JSON body
     */
    post(path, body) {
      return apiRetry(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? '{}' : JSON.stringify(body),
      });
    },
  };

  /* ================== 轮询器 WB.poll ================== */

  /**
   * 轮询器：立即执行一次 fn，此后每 ms 毫秒一次；
   * 页面隐藏（document.hidden）时自动暂停，回前台立即补一次并恢复。
   * @param {Function} fn 每次执行的函数（可为 async；异常被吞掉并 console.warn）
   * @param {number} ms 间隔毫秒
   * @returns {Function} stop() 停止轮询
   */
  WB.poll = function (fn, ms) {
    let timer = null;
    let stopped = false;
    let running = false;

    async function tick() {
      if (stopped || running || document.hidden) return;
      running = true;
      try { await fn(); } catch (e) { console.warn('[WB.poll]', e); }
      running = false;
    }
    function start() {
      if (timer || stopped) return;
      timer = setInterval(tick, ms);
    }
    function stopTimer() {
      if (timer) { clearInterval(timer); timer = null; }
    }
    function onVis() {
      if (document.hidden) stopTimer();
      else { tick(); start(); } // 回前台立即补一次
    }
    document.addEventListener('visibilitychange', onVis);
    tick();
    start();
    return function stop() {
      stopped = true;
      stopTimer();
      document.removeEventListener('visibilitychange', onVis);
    };
  };

  /* ================== 格式化 WB.fmt ================== */

  WB.fmt = {
    /**
     * 数字：千分位 + 固定小数位；非法值回退 '--'。
     * @param {number} n 数值
     * @param {number} [d=2] 小数位
     */
    num(n, d) {
      if (d === undefined) d = 2;
      const v = Number(n);
      if (!isFinite(v)) return '--';
      return v.toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
    },
    /**
     * 美元：自动按数量级选小数位（大数 2 位，小数 4 位）。
     * @param {number} n 数值
     */
    usd(n) {
      const v = Number(n);
      if (!isFinite(v)) return '--';
      const d = Math.abs(v) >= 100 ? 2 : Math.abs(v) >= 1 ? 2 : 4;
      return WB.fmt.num(v, d) + ' U';
    },
    /**
     * 百分比：输入已是百分数（如 1.81 表示 1.81%）。
     * @param {number} n 百分数
     * @param {number} [d=2] 小数位
     */
    pct(n, d) {
      if (d === undefined) d = 2;
      const v = Number(n);
      if (!isFinite(v)) return '--';
      return WB.fmt.num(v, d) + '%';
    },
    /**
     * 相对时间："5.8s 前" / "3 分钟 前" / "2.1 小时 前" / "昨天"。
     * @param {number|string|Date} ts 毫秒时间戳（秒级小于 1e12 会自动×1000）
     */
    ago(ts) {
      let t = Number(ts);
      if (!isFinite(t)) return '--';
      if (t < 1e12) t *= 1000; // 兼容秒级时间戳
      const sec = (Date.now() - t) / 1000;
      if (sec < 0) return '刚刚';
      if (sec < 60) return sec.toFixed(1) + 's 前';
      if (sec < 3600) return Math.floor(sec / 60) + ' 分钟 前';
      if (sec < 86400) return (sec / 3600).toFixed(1) + ' 小时 前';
      return Math.floor(sec / 86400) + ' 天 前';
    },
    /**
     * 绝对时间："MM/DD HH:mm:ss"。
     * @param {number} ts 毫秒时间戳（秒级自动×1000）
     */
    time(ts) {
      let t = Number(ts);
      if (!isFinite(t)) return '--';
      if (t < 1e12) t *= 1000;
      const d = new Date(t);
      const p = (x) => String(x).padStart(2, '0');
      return p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' +
             p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    },
  };

  /* ================== 新鲜度徽标 ================== */

  /**
   * 新鲜度等级：''（绿）/ 'is-warn'（黄）/ 'is-crit'（红）。
   * @param {number} ageSec 数据年龄（秒）
   * @param {{warn?:number, crit?:number}} [th] 阈值，默认 {warn:60, crit:300}
   */
  WB.freshClass = function (ageSec, th) {
    const warn = (th && th.warn) || 60;
    const crit = (th && th.crit) || 300;
    if (!isFinite(ageSec)) return 'is-crit';
    if (ageSec > crit) return 'is-crit';
    if (ageSec > warn) return 'is-warn';
    return '';
  };

  /**
   * 新鲜度徽标 HTML：色点 + 相对时间，超阈值变色。
   * @param {number} ts 毫秒时间戳（秒级自动×1000）
   * @param {{warn?:number, crit?:number}} [th] 阈值（秒）
   * @returns {string} .wb-fresh 的 HTML
   */
  WB.freshHTML = function (ts, th) {
    let t = Number(ts);
    if (!isFinite(t)) {
      return '<span class="wb-fresh is-crit"><i class="fresh-dot"></i>--</span>';
    }
    if (t < 1e12) t *= 1000;
    const ageSec = (Date.now() - t) / 1000;
    const cls = WB.freshClass(ageSec, th);
    return '<span class="wb-fresh ' + cls + '"><i class="fresh-dot"></i>' +
           WB.esc(WB.fmt.ago(t)) + '</span>';
  };

  /* ================== 通用小件 ================== */

  /**
   * 徽标 HTML。
   * @param {string} text 文本
   * @param {string} [type='neutral'] success|warning|danger|brand|neutral
   */
  WB.badge = function (text, type) {
    const t = ['success', 'warning', 'danger', 'brand', 'neutral'].includes(type) ? type : 'neutral';
    return '<span class="wb-badge is-' + t + '">' + WB.esc(text) + '</span>';
  };

  /**
   * 空态 HTML（居中 emoji + 指引文字）。
   * @param {string} text 主文案
   * @param {string} [hint] 指引小字
   * @param {string} [emoji='🗂️'] 图标
   */
  WB.empty = function (text, hint, emoji) {
    return '<div class="wb-empty">' +
      '<div class="empty-emoji">' + WB.esc(emoji || '🗂️') + '</div>' +
      '<div class="empty-text">' + WB.esc(text || '暂无数据') + '</div>' +
      (hint ? '<div class="empty-hint">' + WB.esc(hint) + '</div>' : '') +
      '</div>';
  };

  /* ================== Toast ================== */

  let toastBox = null;

  /**
   * 右上浮层提示。
   * @param {string} msg 文案
   * @param {string} [type='info'] success|error|info
   * @param {number} [ms=3000] 停留毫秒
   */
  WB.toast = function (msg, type, ms) {
    if (!toastBox) {
      toastBox = document.createElement('div');
      toastBox.className = 'wb-toast-box';
      document.body.appendChild(toastBox);
    }
    const icon = { success: '✅', error: '⛔', info: 'ℹ️' }[type] || 'ℹ️';
    const el = document.createElement('div');
    el.className = 'wb-toast is-' + (['success', 'error', 'info'].includes(type) ? type : 'info');
    el.setAttribute('role', 'status');
    el.innerHTML = '<span>' + icon + '</span><span>' + WB.esc(msg) + '</span>';
    toastBox.appendChild(el);
    setTimeout(() => {
      el.classList.add('is-out');
      setTimeout(() => el.remove(), 300);
    }, ms || 3000);
  };

  /* ================== 二次确认 WB.confirm ================== */

  /**
   * 危险操作二次确认弹窗（Promise 化）。
   * @param {string} title 标题
   * @param {string} body 说明正文
   * @returns {Promise<boolean>} true=确认，false=取消
   */
  WB.confirm = function (title, body) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'wb-modal';
      wrap.setAttribute('role', 'dialog');
      wrap.setAttribute('aria-modal', 'true');
      wrap.innerHTML =
        '<div class="modal-card">' +
          '<div class="modal-title">' + WB.esc(title) + '</div>' +
          '<div class="modal-body">' + WB.esc(body) + '</div>' +
          '<div class="modal-foot">' +
            '<button class="wb-btn" data-act="cancel">取消</button>' +
            '<button class="wb-btn is-danger" data-act="ok">确认执行</button>' +
          '</div>' +
        '</div>';
      function done(v) {
        wrap.remove();
        document.removeEventListener('keydown', onKey);
        resolve(v);
      }
      function onKey(e) { if (e.key === 'Escape') done(false); }
      wrap.addEventListener('click', (e) => {
        const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
        if (act === 'ok') done(true);
        else if (act === 'cancel' || e.target === wrap) done(false);
      });
      document.addEventListener('keydown', onKey);
      document.body.appendChild(wrap);
      const okBtn = wrap.querySelector('[data-act="ok"]');
      if (okBtn) okBtn.focus();
    });
  };

  /* ================== 右侧抽屉 WB.drawer ================== */

  let drawerEl = null, maskEl = null;

  function ensureDrawer() {
    if (drawerEl) return;
    maskEl = document.createElement('div');
    maskEl.className = 'wb-mask';
    maskEl.addEventListener('click', () => WB.drawer.close());
    drawerEl = document.createElement('aside');
    drawerEl.className = 'wb-drawer';
    drawerEl.setAttribute('role', 'dialog');
    document.body.appendChild(maskEl);
    document.body.appendChild(drawerEl);
  }

  WB.drawer = {
    /**
     * 打开右侧抽屉（系统状态等内容由调用方填充 HTML）。
     * @param {string} title 标题
     * @param {string} html 内容 HTML
     */
    open(title, html) {
      ensureDrawer();
      drawerEl.innerHTML =
        '<div class="drawer-head"><span>' + WB.esc(title) + '</span>' +
        '<button class="drawer-close" aria-label="关闭抽屉">✕</button></div>' +
        '<div class="drawer-body">' + (html || '') + '</div>';
      drawerEl.querySelector('.drawer-close').addEventListener('click', () => WB.drawer.close());
      maskEl.classList.add('is-open');
      drawerEl.classList.add('is-open');
    },
    /** 关闭抽屉。 */
    close() {
      if (!drawerEl) return;
      maskEl.classList.remove('is-open');
      drawerEl.classList.remove('is-open');
    },
  };

  /* ================== 价格轴 WB.priceAxis ==================
   * 按 DESIGN.md §6.1：横向 100% 轴，左端=爆仓、右端=止盈，两端外扩 8%；
   * 5 类刻度（liq▲/stop■/avg◆/add▼/tp▲）+ 现价游标 + 两条距离带；
   * 游标进入止损 10% 区加 .near-stop，进入爆仓 15% 区加 .near-liq（L3 pulse）；
   * side='short' 时整体镜像（dir="short"）。
   * liq 为空时的 liquidationPx 回退由调用方负责（传入前选好值）。 */

  /**
   * 渲染价格轴（DOM 生成，非 canvas）。
   * @param {HTMLElement} container 挂载容器
   * @param {object} o 参数
   * @param {number} o.liq 爆仓价（调用方：liqPxReal 优先，缺则 liquidationPx）
   * @param {number} o.stop 止损价
   * @param {number} o.avg 均价
   * @param {number} o.add 下一加仓价
   * @param {number} o.tp 止盈价
   * @param {number} o.price 现价
   * @param {number} [o.atrPct] ATR%（用于距离带归一化标注）
   * @param {string} [o.side='long'] long|short（short 自动镜像）
   */
  WB.priceAxis = function (container, o) {
    if (!container) return;
    o = o || {};
    const side = o.side === 'short' ? 'short' : 'long';
    /** 严格转数：null/undefined/'' 一律视为缺失（避免 Number(null)===0 误判） */
    const num = (v) => (v === null || v === undefined || v === '') ? NaN : Number(v);
    const liq = num(o.liq), tp = num(o.tp), price = num(o.price);

    // 轴两端缺失：无法定位，回退为提示（liq 回退由调用方处理，此处仍缺则放弃渲染）
    if (!isFinite(liq) || !isFinite(tp) || liq === tp) {
      container.innerHTML = '<div class="tiny muted">价格轴数据不足（缺爆仓/止盈价）</div>';
      return;
    }
    const lo = Math.min(liq, tp), hi = Math.max(liq, tp);
    const span = hi - lo;
    const left = lo - span * 0.08, right = hi + span * 0.08; // 两端各外扩 8%
    const width = right - left;

    /** 价格 → 百分比定位（0~100），short 时镜像，并夹在 [2,98] 防爆边 */
    function pos(p) {
      let r = (num(p) - left) / width * 100;
      if (side === 'short') r = 100 - r;
      return Math.max(2, Math.min(98, r));
    }

    const ticks = [
      { key: 'liq',  v: liq,    mark: '▲', name: '爆仓' },
      { key: 'stop', v: o.stop, mark: '■', name: '止损' },
      { key: 'avg',  v: o.avg,  mark: '◆', name: '均价' },
      { key: 'add',  v: o.add,  mark: '▼', name: '加仓' },
      { key: 'tp',   v: tp,     mark: '▲', name: '止盈' },
    ];

    let html = '<div class="pa-track"></div>';
    for (const t of ticks) {
      const v = num(t.v);
      if (!isFinite(v)) continue;
      html += '<i class="pa-tick is-' + t.key + '" style="left:' + pos(v).toFixed(2) + '%">' +
              '<s class="pa-mark">' + t.mark + '</s>' +
              '<b class="pa-label">' + t.name + ' ' + WB.esc(WB.fmt.num(v, 4)) + '</b></i>';
    }

    // 现价游标
    if (isFinite(price)) {
      html += '<i class="pa-cursor" style="left:' + pos(price).toFixed(2) + '%">' +
              '<b class="pa-cursor-label">现价 ' + WB.esc(WB.fmt.num(price, 4)) + '</b></i>';
    }

    // 危险区判定：以「止损→爆仓」为死亡区间做归一
    const stop = num(o.stop);
    let nearStop = false, nearLiq = false;
    if (isFinite(price) && isFinite(stop) && stop !== liq) {
      const deathSpan = Math.abs(stop - liq);
      nearStop = Math.abs(price - stop) / deathSpan < 0.10; // 距止损 <10% 区间
      nearLiq = Math.abs(price - liq) / deathSpan < 0.15;   // 距爆仓 <15% 区间
    }

    // 距离带：现价→止损（band-stop）、现价→爆仓（band-liq）
    if (isFinite(price)) {
      const atr = num(o.atrPct);
      /** 距离带 HTML：两端定位 + 百分比标注（按 ATR% 归一：距离/atrPct） */
      function band(cls, target) {
        const t = num(target);
        if (!isFinite(t) || t === price) return '';
        const a = pos(price), b = pos(t);
        const l = Math.min(a, b), w = Math.max(1.5, Math.abs(b - a));
        const distPct = Math.abs(price - t) / price * 100;
        let label = WB.fmt.num(distPct, 1) + '%';
        if (isFinite(atr) && atr > 0) label += ' · ' + WB.fmt.num(distPct / atr, 1) + '×ATR';
        return '<div class="pa-band ' + cls + '" style="left:' + l.toFixed(2) + '%;width:' + w.toFixed(2) + '%">' +
               '<span class="band-label">' + WB.esc(label) + '</span></div>';
      }
      html = band('band-liq', liq) + band('band-stop', stop) + html;
    }

    container.classList.add('wb-price-axis');
    container.setAttribute('dir', side);
    container.classList.toggle('near-stop', nearStop);
    container.classList.toggle('near-liq', nearLiq);
    container.innerHTML = html;
  };

  /* ================== 壳渲染 WB.shell ================== */

  WB.shell = {
    /**
     * 渲染壳：顶栏（品牌+模式角标 slot / 中 3 生命体征 slot / 右按钮区）
     * + 侧栏（分组导航 + 底部状态 slot）+ 模式横幅 slot，全部挂到 #shell。
     * 按钮点击通过 hooks 回调 + CustomEvent('wb:shell') 双通道通知调用方。
     * @param {string} activeKey 当前导航项 key（对应 WB_SHELL 里的 key）
     * @param {object} [hooks] 回调 { onPause, onRefresh, onSystem, onNav }
     */
    init(activeKey, hooks) {
      const root = document.getElementById('shell');
      if (!root) return;
      const cfg = WB_SHELL;
      hooks = hooks || {};

      /* ---- 顶栏 ---- */
      const btns = cfg.topbarButtons.map(b =>
        '<button class="wb-btn is-ghost" id="tb-btn-' + b.key + '" aria-label="' + WB.esc(b.aria) + '">' +
        '<span class="btn-text-optional">' + WB.esc(b.text) + '</span></button>'
      ).join('');

      const header =
        '<header class="wb-topbar">' +
          '<div class="tb-left">' +
            '<button class="wb-hamburger" id="tb-hamburger" aria-label="打开导航菜单">☰</button>' +
            '<span class="wb-brand">' + cfg.brand.icon +
              '<span class="brand-text">' + WB.esc(cfg.brand.name) + '</span></span>' +
            '<span id="tb-mode"><!-- 模式角标 slot：WB.shell.setMode() 填充 --></span>' +
          '</div>' +
          '<div class="tb-mid" id="tb-vitals"><!-- 生命体征 slot：权益/今日盈亏/心跳 --></div>' +
          '<div class="tb-right">' + btns + '</div>' +
        '</header>' +
        '<div class="wb-mode-line"></div>' +
        '<div class="wb-banner" id="wb-banner"><!-- 模式横幅 slot --></div>';

      /* ---- 侧栏 ---- */
      let nav = '';
      for (const g of cfg.navGroups) {
        if (g.dividerBefore) nav += '<div class="wb-nav-divider"></div>';
        nav += '<div class="wb-nav-group">';
        if (g.title) nav += '<div class="wb-nav-title">' + WB.esc(g.title) + '</div>';
        for (const it of g.items) {
          const active = it.key === activeKey ? ' is-active' : '';
          const target = it.external ? ' target="_blank" rel="noopener"' : '';
          const badge = it.badgeId
            ? '<span class="nav-badge num" id="' + it.badgeId + '" hidden></span>' : '';
          nav += '<a class="wb-nav-item' + active + '" href="' + WB.esc(it.href) + '"' +
                 ' data-key="' + WB.esc(it.key) + '"' + target + '>' +
                 '<span class="nav-icon">' + it.icon + '</span>' +
                 '<span class="nav-text">' + WB.esc(it.text) + '</span>' + badge + '</a>';
        }
        nav += '</div>';
      }
      const sidebar =
        '<aside class="wb-sidebar" id="wb-sidebar">' + nav +
          '<div class="wb-sidebar-foot" id="sidebar-foot"><!-- 底部状态 slot：候选池 n · 篮子 m --></div>' +
        '</aside>';

      root.innerHTML = header + sidebar;

      /* ---- 交互：汉堡（≤390px 全屏抽屉导航） ---- */
      const ham = document.getElementById('tb-hamburger');
      if (ham) {
        ham.addEventListener('click', () => {
          const open = document.body.classList.toggle('nav-open');
          ham.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
        });
      }
      // 窄屏点击导航后自动收起
      root.querySelectorAll('.wb-nav-item').forEach(a => {
        a.addEventListener('click', (e) => {
          document.body.classList.remove('nav-open');
          const item = findNavItem(a.getAttribute('data-key'));
          if (item && item.external) return; // 外链默认行为
          if (hooks.onNav) hooks.onNav(item && item.key, e);
        });
      });

      /* ---- 顶栏按钮：hooks + CustomEvent 双通道 ---- */
      const hookMap = { pause: 'onPause', refresh: 'onRefresh', density: 'onDensity', system: 'onSystem' };
      for (const key of Object.keys(hookMap)) {
        const el = document.getElementById('tb-btn-' + key);
        if (!el) continue;
        el.addEventListener('click', () => {
          document.dispatchEvent(new CustomEvent('wb:shell', { detail: { action: key } }));
          const fn = hooks[hookMap[key]] || WB.shell[hookMap[key]];
          if (typeof fn === 'function') fn(el);
          else if (key === 'system') WB.drawer.open('系统状态', '<p class="muted tiny">调用方未提供系统状态内容（WB.shell.onSystem）。</p>');
        });
      }
      WB.shell.syncDensityBtn();
    },

    /**
     * 顶栏「密度」按钮默认行为：舒适/紧凑互切并记忆（页面可用 hooks.onDensity 覆盖）。
     * @param {HTMLElement} [el] 按钮元素
     */
    onDensity(el) {
      const next = WB.prefs.get('density', 'comfort') === 'compact' ? 'comfort' : 'compact';
      WB.prefs.set('density', next);
      WB.shell.syncDensityBtn();
      WB.toast(next === 'compact' ? '已切换：紧凑密度' : '已切换：舒适密度', 'info');
    },

    /** 同步密度按钮文案为当前状态。 */
    syncDensityBtn() {
      const el = document.getElementById('tb-btn-density');
      if (el) el.textContent = WB.prefs.get('density', 'comfort') === 'compact' ? '密度·紧凑' : '密度·舒适';
    },

    /**
     * 设置模式（角标 + body[data-mode] + 模式横幅）。
     * @param {string} mode 'live' | 'dry-run'
     * @param {string} [bannerText] 横幅文案（空则不显示横幅）
     */
    setMode(mode, bannerText) {
      const isLive = mode === 'live';
      document.body.setAttribute('data-mode', isLive ? 'live' : 'dry-run');
      const slot = document.getElementById('tb-mode');
      if (slot) {
        slot.innerHTML = WB.badge(isLive ? '实盘 · 会真下单' : 'dry-run · 只预览', isLive ? 'danger' : 'success');
      }
      const banner = document.getElementById('wb-banner');
      if (banner) {
        banner.className = 'wb-banner ' + (isLive ? 'is-live' : 'is-dry');
        banner.textContent = bannerText || '';
      }
    },

    /**
     * 更新侧栏导航徽标（如篮子在仓数）。
     * @param {string} badgeId 徽标元素 id（WB_SHELL 里配置的 badgeId）
     * @param {number|string} n 数值；空则隐藏
     */
    setNavBadge(badgeId, n) {
      const el = document.getElementById(badgeId);
      if (!el) return;
      if (n === null || n === undefined || n === '') { el.hidden = true; return; }
      el.hidden = false;
      el.textContent = String(n);
    },

    /**
     * 填充顶栏中部生命体征（3 项：权益/今日盈亏/心跳）。
     * @param {Array<{label:string, value:string, cls?:string}>} vitals
     */
    setVitals(vitals) {
      const slot = document.getElementById('tb-vitals');
      if (!slot) return;
      slot.innerHTML = (vitals || []).map(v =>
        '<span class="tb-vital"><span class="v-label">' + WB.esc(v.label) + '</span>' +
        '<span class="v-value ' + WB.esc(v.cls || '') + '">' + v.value + '</span></span>'
      ).join('<span class="tb-sep"></span>');
    },

    /** 填充侧栏底部状态（如「候选池 10 · 篮子 4」）。 */
    setSidebarFoot(html) {
      const el = document.getElementById('sidebar-foot');
      if (el) el.innerHTML = html;
    },
  };

  /** 按 key 查导航项 */
  function findNavItem(key) {
    for (const g of WB_SHELL.navGroups) {
      for (const it of g.items) if (it.key === key) return it;
    }
    return null;
  }

  /* ---- 导出全局命名空间 ---- */
  window.WB = WB;
})();
