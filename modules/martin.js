/*!
 * modules/martin.js - william-bot-1-core key engine logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-1CE3653B
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
/**
 * modules/martin.js —— 类马丁「篮子」状态机
 *
 * 契约：design/MARTIN-BOT-SPEC.md §2.1 / §2.2 / §2.3（A 侧接口，B 的面板按此签名调用）
 * 口径：design/马丁策略设计.md 第四章（马丁政策）+ 第三章（状态→方向）
 *
 * 设计要点
 * - 逐仓、按「保证金」下首单（不按张数），便于跨品种统一风险。
 * - 加仓间距 = ATR × spacingAtrMult（atr 模式）或 上一层层价 × spacingPct%（pct 模式），
 *   由「上一层层价」起算（逐层等距网格）；层保证金 = 首单保证金 × multiplier^(k-1)。
 * - 硬止损 = 整篮浮亏达到「开仓时权益 × hardStopPct%」→ 用 basket.stopUsd 存绝对 USD，
 *   因此 onPrice 不需要 equity 参数（契约 §2.3 未给 equity）。
 * - 无未来函数：本模块是纯函数状态机，只看传入的 price/atr/regime/ts；
 *   「用 i-1 及更早收盘算 atr/regime」是调用方（回测/调度器）的职责。
 *
 * 约定（B 必须知道）
 * - sizeForMargin() 返回 0 = 不能开仓（算出来不足 minSz 或参数非法）。绝不向上取整到 minSz，
 *   否则实际占用保证金会超过政策预算。
 * - newBasket() 返回 null = 首单张数不足 minSz（资金太小/价格太高），调用方应跳过并提示。
 * - uplPct = 浮盈 / 本篮保证金占用 × 100（不是相对名义价值）。
 * - 平仓事件里的 pnlUsd 为「毛盈亏」（不含手续费/资金费）；手续费由调用方按成交额另扣。
 */
'use strict';

const DEFAULT_POLICY = Object.freeze({
  /* 契约 §2.1 */
  firstMarginPct: 1,        // 首单保证金占权益 %
  leverage: 3,              // 杠杆（逐仓）
  marginMode: 'isolated',
  spacingMode: 'atr',       // atr | pct
  spacingAtrMult: 1.0,      // 加仓间距 = ATR × 该倍数
  spacingPct: 0.8,          // pct 模式下的间距 %
  multiplier: 1.5,          // 加仓倍数
  maxLevels: 6,             // 最大层数
  takeProfitPct: 0.8,       // 整篮止盈（相对均价 %）
  hardStopPct: 4,           // 整篮硬止损（占开仓时权益 %）
  timeStopHours: 48,
  cooldownHours: 4,
  maxBaskets: 3,
  dailyLossPct: 6,          // 日亏熔断
  maxFundingAbs: 0.001,     // 开仓时 |费率| 上限（小数）
  /* ↓ 扩展项（可选，缺省即有值；B 不传也行为一致） */
  minAtrPct: 0.4,           // 低于此 ATR% 不开仓（赚不够手续费）
  maxAtrPct: 8,             // 高于此 ATR% 不开仓（插针打穿）
  mmr: 0.005,               // 维持保证金率（爆仓价估算用）
  blackSwanPct: 5,
  stopMode: 'atr',          // 止损口径：'atr'=价格空间死亡线（任何层数可达）| 'equity'=占权益金额（旧口径）
  deathAtrMult: 6,          // atr 口径：止损距离 = 该值 × ATR%（相对整篮均价）
  maxBasketRiskPct: 3,      // 金额兜底：整篮浮亏 ≥ 开仓权益该百分比 → 平仓
          // 单根 1H 反向波动 ≥ 该值 → 不加仓/不开仓
  /* ↓ 盈利能力组（2026-09-21 追加；默认值 = 旧行为，逐字节兼容） */
  entryZMin: 0,             // 入场时机：|z| ≥ 该值才开首单（0 = 关，保持旧行为）
  entryZWin: 20,            // z-score 的 SMA/stdev 窗口（根）
  entryZMode: 'revert',     // revert = 方向取回归方向（偏离上轨做空/下轨做多）；filter = 只做「与状态方向一致」的偏离
  /* ↓ regime 选品过滤（2026-09-22 追加，Task A；默认 0/off = 旧行为，逐字节兼容）
   * 过滤量全部由调用方用「i-1 及更早收盘」算好传入（回测/实盘同口径，无未来函数）：
   *   vr5 = 方差比(5)（<1 = 均值回归）；adx = ADX(14)（低 = 弱趋势）；
   *   rf  = 回归频率（高 = 爱回归）；entryAtrPctMax = 当根入场 ATR% 上限。
   * 只作用于「开首单」，不影响加仓与离场；指标缺失 → 该项不拦（fail-open，避免静默关停）。 */
  entryVr5Max: 0,           // >0：要求 vr5 < 该值才开首单（越低越均值回归）
  entryAdxMax: 0,           // >0：要求 adx < 该值才开首单（弱趋势/震荡优先）
  entryRfMin: 0,            // >0：要求 rf > 该值才开首单（回归频率高）
  entrySkipTrend: 'off',    // on = 只做 range 状态（trend_up/trend_down/unclear 一律跳过）
  entryAtrPctMax: 0,        // >0：要求当根 ATR% < 该值才开首单（避开高波动/刚放量入场）
  /* ↓ 信号逆转处理（2026-09-22 追加，Task B；默认 now = 旧行为）
   *   now     = 反向确认趋势即刻平篮（旧行为）
   *   confirm = 连续 trendFlipConfirmBars 根同向反向趋势才平（按 bar 去重计数）
   *   half    = 首次反向先减仓 trendFlipReducePct% 并保留止损；再持续 trendFlipConfirmBars 根则清剩余 */
  trendFlipMode: 'now',
  trendFlipConfirmBars: 2,
  trendFlipReducePct: 50,
  /* ↓ 分层止损（2026-09-22 追加，Task C；默认 off = 旧行为）
   * 深篮（层数 ≥ layeredStopFromLevel）改用更紧的死亡线倍数（只在更紧时生效） */
  layeredStopEnabled: false,
  layeredStopFromLevel: 3,
  layeredStopAtrMult: 4,
  /* ↓ 部分止盈（2026-09-22 追加，Task C；默认 off = 旧行为）
   * 浮盈达 partialTpAtPct%（相对均价）先平掉 partialTpFracPct% 张数降低暴露；
   * 不改整篮止盈价/止损位，剩余继续持有 */
  partialTpEnabled: false,
  partialTpAtPct: 0.4,
  partialTpFracPct: 50,
  tpAtrMult: 0.5,           // 止盈 = clamp(该值 × ATR%, tpMinPct, tpMaxPct)；仅当 takeProfitPct ≤ 0 时启用
  tpMinPct: 0.4,            // 波动止盈下限 %
  tpMaxPct: 2,              // 波动止盈上限 %
  makerFirst: 'off',        // on|off：入场/加仓 maker 优先（执行模型；off = 旧行为）
  makerTimeoutBars: 1,      // maker 限价单超时根数（超时转市价；仅 makerFirst='on' 有意义）
  /* ↓ 止盈执行模型（2026-09-21 追加；默认 'market' = 旧行为，逐字节兼容）
   * market = 止盈按市价平仓（taker 费率）；limit = 止盈挂 post_only 限价（成交按 maker 费率）。
   * ⚠ 本键只描述「止盈怎么成交」，不改变止盈价/触发条件；成交率风险由回测的
   *   tpFillMode/tpFillRate 建模（见 scripts/martin-backtest.js）。 */
  tpOrderType: 'market',
  tpLimitMinNotionalUsd: 0,
  phantomActionEnabled: true, phantomHarvestMinProfitUsd: 0.1,
  makerEntryEnabled: false, makerEntryMinNotionalUsd: 150000000, makerEntryOffsetPct: 0.05, makerEntryTimeoutMs: 4000,   // 仅 24h 成交额 ≥ 该值时用 maker 限价止盈    // market|limit
});

const num = (v, d) => {
  const x = Number(v);
  if (!Number.isFinite(x)) return d === undefined ? 0 : d;
  return x;
};
const round = (v, n = 10) => Number(num(v).toFixed(n));

function normPolicy(p) {
  const out = { ...DEFAULT_POLICY, ...(p || {}) };
  // 显式允许取 0 的字段：0 是“切换到波动止盈/关闭 z 门槛”的开关，不能被默认值吃掉
  const ZERO_OK = ['takeProfitPct', 'entryZMin', 'entryZWin', 'tpMinPct', 'tpMaxPct', 'makerTimeoutBars'];
  for (const k of Object.keys(DEFAULT_POLICY)) {
    if (typeof DEFAULT_POLICY[k] !== 'number') continue;
    const raw = out[k];
    const n = Number(raw);
    if (ZERO_OK.includes(k) && Number.isFinite(n) && n >= 0) { out[k] = n; continue; }
    out[k] = num(raw, DEFAULT_POLICY[k]);
  }
  return out;
}

const clampNum = (v, lo, hi) => { const x = num(v); const a = num(lo); const b = num(hi); return Math.min(Math.max(x, a), b); };

/* ── 盈利能力组：纯函数助手（默认参数下均为空操作） ──────── */

/** maker 优先是否开启（枚举 on|off，非法值一律按 off） */
function makerFirstOn(policy) { return normPolicy(policy).makerFirst === 'on'; }

/**
 * 布尔开关解析：同时接受 true/1/'on'/'true'（面板枚举发字符串 'on'/'off'，
 * 必须显式解析 —— 'off' 也是真值字符串，直接用会误开）。
 */
function flagOn(v) {
  if (v === true || v === 1) return true;
  if (typeof v === 'string') return ['on', 'true', '1', 'yes', 'enable', 'enabled'].includes(v.trim().toLowerCase());
  return false;
}
const layeredStopOn = (policy) => flagOn(normPolicy(policy).layeredStopEnabled);
const partialTpOn = (policy) => flagOn(normPolicy(policy).partialTpEnabled);

/** 止盈是否挂 maker 限价单（枚举 market|limit，非法值一律按 market = 旧行为） */
function tpOrderIsLimit(policy) { return normPolicy(policy).tpOrderType === 'limit'; }

/**
 * z-score：(price − SMA(win)) / stdev(win)，母体标准差。
 * ⚠ 调用方必须只传「i-1 及更早」的收盘序列（本函数不看任何未来数据）。
 * @param {number[]} closes 截至上一根收盘的收盘价序列（最后一项 = 最新已收盘价）
 * @param {number} win 窗口根数
 * @returns {number|null} null = 序列不足/stdev 为 0
 */
function zScore(closes, win) {
  const w = Math.max(2, Math.floor(num(win, 20)));
  if (!Array.isArray(closes) || closes.length < w) return null;
  const s = closes.slice(closes.length - w).map((x) => num(x));
  if (s.some((x) => !Number.isFinite(x))) return null;
  const m = s.reduce((a, b) => a + b, 0) / w;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - m) * (b - m), 0) / w);
  if (!(sd > 0)) return null;
  return (s[w - 1] - m) / sd;
}

/** 价格单位的 ATR → ATR%（相对参考价） */
function atrPctFrom(px, atrPx) {
  const a = num(atrPx); const x = num(px);
  return a > 0 && x > 0 ? (a / x) * 100 : null;
}

/**
 * 本篮当前生效的止盈幅度（%）。
 * 规则（优先级明确，避免隐式生效）：
 *   · takeProfitPct > 0 → 固定止盈（旧行为，默认）；
 *   · takeProfitPct ≤ 0 且 tpAtrMult > 0 → 波动缩放止盈 clamp(tpAtrMult × ATR%, tpMinPct, tpMaxPct)；
 *   · ATR% 取「调用方给的当前 ATR%（优先）」→「开仓时 ATR%」→ 都没有则退回 takeProfitPct。
 */
function effectiveTpPct(basket, atrPct) {
  const p = normPolicy(basket && basket.policy);
  if (p.tpAtrMult > 0 && !(p.takeProfitPct > 0)) {
    const cur = num(atrPct);
    const a = cur > 0 ? cur : num(basket && basket.atrAtOpenPct);
    if (a > 0) return round(clampNum(p.tpAtrMult * a, p.tpMinPct, p.tpMaxPct), 6);
    return p.tpMinPct;      // 波动模式但拿不到任何 ATR% → 用下限兜底（退成 0 会导致开仓即止盈）
  }
  return p.takeProfitPct;
}

/** 向下对齐步长（含浮点保护） */
function floorToStep(value, step) {
  const s = num(step);
  if (!(s > 0)) return round(value);
  const n = Math.floor((num(value) + s * 1e-9) / s);
  return round(n * s);
}

/* ── §2.3 张数换算 ─────────────────────────────── */

/**
 * 张数换算：contracts = floor(margin×lever / (ctVal×price) / lotSz) × lotSz，且 ≥ minSz
 * @returns {number} 张数；0 = 不能开仓（算出不足 minSz / 参数非法）
 */
function sizeForMargin({ marginUsd, leverage, price, ctVal, lotSz, minSz }) {
  const m = num(marginUsd), lv = num(leverage), px = num(price), cv = num(ctVal);
  if (!(m > 0) || !(lv > 0) || !(px > 0) || !(cv > 0)) return 0;
  const raw = (m * lv) / (cv * px);
  const step = num(lotSz) > 0 ? num(lotSz) : 1;
  const contracts = floorToStep(raw, step);
  const min = num(minSz) > 0 ? num(minSz) : step;
  if (contracts < min) return 0;
  return contracts;
}

/* ── 篮子几何 ──────────────────────────────────── */

/** 加权均价（按张数） */
function avgPrice(basket) {
  const lv = (basket && basket.levels) || [];
  let c = 0, s = 0;
  for (const l of lv) { c += num(l.contracts); s += num(l.contracts) * num(l.price); }
  return c > 0 ? s / c : 0;
}

function totalContracts(basket) {
  return ((basket && basket.levels) || []).reduce((a, l) => a + num(l.contracts), 0);
}

function totalMargin(basket) {
  return ((basket && basket.levels) || []).reduce((a, l) => a + num(l.marginUsd), 0);
}

function dirOf(basket) { return basket && basket.side === 'short' ? -1 : 1; }

/* ── 滑点（回测/压力测试用） ────────────────────────
 * 把成交价往不利方向推 slipBps：买入上浮、卖出下浮。
 * slipBps = 0 时乘数恰为 1，x*1 在 IEEE754 下精确等于 x → 与原行为逐位一致（回归安全）。
 * entry 用于开仓/加仓（顺着持仓方向建仓），exit 用于平仓（反方向）。
 */
function slipFactors(side, slipBps) {
  const s = num(slipBps) / 10000;
  const dir = side === 'short' ? -1 : 1;
  return { entry: 1 + dir * s, exit: 1 - dir * s };
}
/** 开仓/加仓成交价（买上浮 / 卖下浮） */
function entryFillPx(price, side, slipBps) { return num(price) * slipFactors(side, slipBps).entry; }
/** 平仓成交价（卖下浮 / 买上浮） */
function exitFillPx(price, side, slipBps) { return num(price) * slipFactors(side, slipBps).exit; }

/** §2.3 篮子浮盈（price 为当前价） */
function basketPnl(basket, price) {
  const avg = avgPrice(basket);
  const contracts = totalContracts(basket);
  const ctVal = num(basket && basket.ctVal, 0);
  const marginUsd = totalMargin(basket);
  const px = num(price);
  const qty = ctVal * contracts;                 // 币数量
  const notionalUsd = qty * px;
  const upl = (px - avg) * qty * dirOf(basket);
  return {
    avgPx: round(avg, 10),
    contracts: round(contracts, 10),
    qty: round(qty, 10),
    notionalUsd: round(notionalUsd, 6),
    marginUsd: round(marginUsd, 6),
    upl: round(upl, 6),
    uplPct: marginUsd > 0 ? round((upl / marginUsd) * 100, 4) : 0,
  };
}

/**
 * 整篮止盈价（相对均价 takeProfitPct%；tpAtrMult 模式见 effectiveTpPct）
 * @param {number} [atrPct] 当前 ATR%（可选；不传则用开仓时 ATR%，再不行退回固定止盈）
 */
function takeProfitPrice(basket, atrPct) {
  const avg = avgPrice(basket);
  if (!(avg > 0)) return null;
  const tp = effectiveTpPct(basket, atrPct);
  return round(avg * (1 + (tp / 100) * dirOf(basket)), 10);
}

/**
 * 整篮硬止损价：解 upl(P) = −stopUsd
 * long : P = avg − stopUsd/qty     short: P = avg + stopUsd/qty
 */
function stopPrice(basket) {
  const p = normPolicy(basket && basket.policy);
  const avg = avgPrice(basket);
  if (!(avg > 0)) return null;
  const dir = dirOf(basket);
  const liq = liquidationPrice(basket, p.mmr);
  const liqDist = liq && liq > 0 ? Math.abs(liq - avg) : 0;
  if (String(p.stopMode) === 'atr') {
    let atrPct = num(basket && (basket.lastAtrPct ?? basket.atrPct));
    if (!(atrPct > 0) && num(basket && basket.atrAtOpenPct) > 0) atrPct = num(basket.atrAtOpenPct);
    if (!(atrPct > 0) && num(basket && basket.atrAtOpen) > 0) atrPct = (num(basket.atrAtOpen) / avg) * 100;
    /* 分层止损（默认 off → multForThis 恒等于 deathAtrMult，逐字节兼容）：深篮收紧死亡线 */
    const lvCount = ((basket && basket.levels) || []).length;
    const multForThis = (layeredStopOn(p) && lvCount >= num(p.layeredStopFromLevel, 3))
      ? Math.min(num(p.deathAtrMult), num(p.layeredStopAtrMult, num(p.deathAtrMult)))
      : num(p.deathAtrMult);
    if (atrPct > 0) {
      let dist = avg * (multForThis * atrPct) / 100;
      if (liqDist > 0 && dist > liqDist * 0.6) dist = liqDist * 0.6;
      const px = avg - dir * dist;
      if (px > 0) return round(px, 10);
    }
  }
  // 回退：金额口径；不可达时退化为「爆仓距离的 80%」，保证浅篮子也有真实止损
  const qty = num(basket && basket.ctVal) * totalContracts(basket);
  const stopUsd = num(basket && basket.stopUsd);
  if (qty > 0 && stopUsd > 0) {
    const px2 = avg - (stopUsd / qty) * dir;
    if (px2 > 0) return round(px2, 10);
  }
  if (liqDist > 0) { const px3 = avg - dir * (liqDist * 0.8); if (px3 > 0) return round(px3, 10); }
  return null;
}

/** §2.3 爆仓价估算（逐仓线性合约，mmr 默认 policy.mmr） */
function liquidationPrice(basket, mmr) {
  const p = normPolicy(basket && basket.policy);
  const m = mmr === undefined || mmr === null ? p.mmr : num(mmr);
  const avg = avgPrice(basket);
  const qty = num(basket && basket.ctVal) * totalContracts(basket);
  const marginUsd = totalMargin(basket);
  if (!(avg > 0) || !(qty > 0) || !(marginUsd > 0)) return null;
  const perUnit = marginUsd / qty;
  const px = basket.side === 'short' ? (avg + perUnit) / (1 + m) : (avg - perUnit) / (1 - m);
  if (!Number.isFinite(px) || px <= 0) return null;   // ≤0 = 永远碰不到
  return round(px, 10);
}

/**
 * §2.3 下一加仓价；null = 已满层
 * 由「上一层层价」起算，方向向不利侧推进。
 */
function nextAddPrice(basket, atr) {
  if (!basket) return null;
  const p = normPolicy(basket.policy);
  const lv = basket.levels || [];
  if (lv.length >= p.maxLevels) return null;
  const last = lv.length ? num(lv[lv.length - 1].price) : 0;
  if (!(last > 0)) return null;
  let spacing;
  if (p.spacingMode === 'pct') spacing = (last * p.spacingPct) / 100;
  else {
    const a = num(atr);
    if (!(a > 0)) return null;
    spacing = a * p.spacingAtrMult;
  }
  if (!(spacing > 0)) return null;
  const px = last - spacing * dirOf(basket);
  return px > 0 ? round(px, 10) : null;
}

/** 第 idx 层（0 基）应下的保证金 = 首单保证金 × multiplier^idx */
function levelMargin(basket, idx) {
  const p = normPolicy(basket.policy);
  const first = num((basket.levels && basket.levels[0] && basket.levels[0].marginUsd) || basket.firstMarginUsd);
  return round(first * Math.pow(p.multiplier, idx), 6);
}

/** 第 idx 层保证金 + 前面各层 = 累计占用 */
function cumulativeMargin(basket, idx) {
  let s = 0;
  for (let k = 0; k <= idx; k++) s += levelMargin(basket, k);
  return round(s, 6);
}

/* ── 减仓 / 部分止盈（Task B、C；默认不启用） ───────
 * 按比例削减每层的张数（向下对齐 lotSz，避免出现不足 1 手的虚拟仓位）。
 * 已实现盈亏累计到 basket.partialRealizedUsd（回测/调度器应在最终平仓时把它计入本笔盈亏）。
 * 不改层价 → 均价/止盈价/死亡线不变，只减少暴露（“降低暴露”而不是“放宽止损”）。
 */
function reduceExposure(basket, { fraction, price, ts, reason } = {}) {
  if (!basket || basket.closed) return null;
  const lv = basket.levels || [];
  if (!lv.length) return null;
  const frac = clampNum(fraction, 0, 1);
  if (!(frac > 0)) return null;
  const px = num(price);
  const avg = avgPrice(basket);
  if (!(px > 0) || !(avg > 0)) return null;
  const dir = dirOf(basket);
  const ctVal = num(basket.ctVal);
  const lotSz = num(basket.lotSz);
  const tsN = num(ts) || Date.now();
  const keep = [];
  let closedContracts = 0;
  for (const l of lv) {
    const c = num(l.contracts);
    const rawKeep = c * (1 - frac);
    const k = lotSz > 0 ? floorToStep(rawKeep, lotSz) : round(rawKeep, 10);
    if (k > 0) { keep.push({ ...l, contracts: k }); closedContracts += (c - k); }
    else closedContracts += c;
  }
  closedContracts = round(closedContracts, 10);
  if (!(closedContracts > 0)) return null;
  const pnlUsd = round((px - avg) * ctVal * closedContracts * dir, 6);
  const notionalUsd = round(ctVal * closedContracts * px, 6);
  basket.levels = keep;
  basket.partialRealizedUsd = round(num(basket.partialRealizedUsd) + pnlUsd, 6);
  basket.partialRealizedContracts = round(num(basket.partialRealizedContracts) + closedContracts, 10);
  basket.realizedPnl = round(num(basket.realizedPnl) + pnlUsd, 6);
  basket.lastReduceAt = tsN;
  if (!keep.length) {          // 张数太少被减光 → 视为平仓（reason=reduce_out）
    basket.closed = true;
    basket.closedAt = tsN;
    basket.closeReason = 'reduce_out';
    basket.closePrice = round(px, 10);
  }
  return {
    contracts: closedContracts, notionalUsd, pnlUsd,
    avgPx: round(avg, 10), remainContracts: round(totalContracts(basket), 10),
    marginFreedUsd: round(notionalUsd / Math.max(1, num(basket.policy && basket.policy.leverage, 1)), 6),
    fraction: frac, reason: reason || 'reduce',
  };
}

/** 部分止盈触发价（默认 off → null，不影响旧行为） */
function partialTpPrice(basket) {
  const p = normPolicy(basket && basket.policy);
  if (!flagOn(p.partialTpEnabled)) return null;
  if (basket && basket.partialTpDone) return null;
  const avg = avgPrice(basket);
  if (!(avg > 0)) return null;
  const pctN = num(p.partialTpAtPct);
  if (!(pctN > 0)) return null;
  return round(avg * (1 + (pctN / 100) * dirOf(basket)), 10);
}

/* ── 开篮 ──────────────────────────────────────── */

/**
 * §2.3 新建篮子。price 为成交价，atr 为价格单位的 ATR（可空）。
 * @returns {object|null} null = 首单张数为 0（不足 minSz），调用方应跳过
 */
function newBasket({ instId, side, sector, price, atr, policy, instrument, equity, ts, regime, id }) {
  const p = normPolicy(policy);
  const ins = instrument || {};
  const ctVal = num(ins.ctVal, 1) || 1;
  const lotSz = num(ins.lotSz, 0);
  const minSz = num(ins.minSz, 0);
  const maxLever = num(ins.maxLever, 0);
  const lev = maxLever > 0 ? Math.min(p.leverage, maxLever) : p.leverage;
  const eq = num(equity);
  const px = num(price);
  if (!(px > 0) || !(eq > 0)) return null;

  const firstMarginUsd = (eq * p.firstMarginPct) / 100;
  const contracts = sizeForMargin({ marginUsd: firstMarginUsd, leverage: lev, price: px, ctVal, lotSz, minSz });
  if (!contracts) return null;

  const now = num(ts) || Date.now();
  return {
    id: id || `${instId}-${side}-${now}`,
    instId,
    side,
    sector: sector || 'Other',
    openedAt: now,
    regimeAtOpen: regime && regime.regime ? regime.regime : (typeof regime === 'string' ? regime : null),
    policy: { ...p, leverage: lev },
    ctVal, lotSz, minSz, maxLever,
    atrAtOpen: num(atr) || null,
    atrAtOpenPct: num(atr) > 0 ? round((num(atr) / px) * 100, 6) : null,
    equityAtOpen: eq,
    stopUsd: round((eq * p.hardStopPct) / 100, 6),        // 整篮浮亏达到即硬止损
    firstMarginUsd: round(firstMarginUsd, 6),
    levels: [{ idx: 0, ts: now, price: px, contracts, marginUsd: round(firstMarginUsd, 6), reason: 'entry', atrPx: atr === undefined || atr === null ? null : round(atr, 10) }],
    closed: false,
    closedAt: null,
    closeReason: null,
    realizedPnl: 0,
    feesUsd: 0,
    fundingUsd: 0,
  };
}

/* ── 开仓判定 ──────────────────────────────────── */

/** openBaskets 支持「数字」或「篮子数组」（契约里两种写法都出现过，这里都兼容） */
function basketCount(openBaskets) {
  if (openBaskets === null || openBaskets === undefined) return 0;
  if (typeof openBaskets === 'number') return openBaskets;
  return Array.isArray(openBaskets) ? openBaskets.length : 0;
}
function basketSectors(openBaskets) {
  if (!Array.isArray(openBaskets)) return [];
  return openBaskets.map((b) => (typeof b === 'string' ? b : b && b.sector)).filter(Boolean);
}
function basketInstIds(openBaskets) {
  if (!Array.isArray(openBaskets)) return [];
  return openBaskets.map((b) => (typeof b === 'string' ? b : b && b.instId)).filter(Boolean);
}
function pct(v) { return `${(num(v) * 100).toFixed(4)}%`; }

/**
 * §2.3 是否允许开新篮子（策略层判定：方向 + 政策闸门；不涉及熔断状态，那是 risk.gate 的事）
 * @returns {{ok:boolean, side?:'long'|'short', reason:string}}
 */
function shouldOpen({ policy, regime, funding, atrPct, equity, openBaskets, sector, todayPnlPct, barChangePct, entryZ, vr5, rf, adx }) {
  const p = normPolicy(policy);
  if (!(num(equity) > 0)) return { ok: false, reason: '权益为 0 或负，不能开仓' };
  if (typeof todayPnlPct === 'number' && todayPnlPct <= -p.dailyLossPct) {
    return { ok: false, reason: `当日亏损 ${todayPnlPct.toFixed(2)}% 触及熔断 −${p.dailyLossPct}%` };
  }
  if (basketCount(openBaskets) >= p.maxBaskets) {
    return { ok: false, reason: `篮子数已达上限 ${p.maxBaskets}` };
  }
  if (sector && basketSectors(openBaskets).includes(sector)) {
    return { ok: false, reason: `板块 ${sector} 已有篮子（相关性去重）` };
  }
  const f = num(funding);
  if (Math.abs(f) > p.maxFundingAbs) {
    return { ok: false, reason: `资金费率 ${pct(f)} 超限 ±${pct(p.maxFundingAbs)}` };
  }
  if (typeof atrPct === 'number' && atrPct !== null) {
    if (atrPct < p.minAtrPct) return { ok: false, reason: `ATR% ${atrPct.toFixed(2)} 过低（<${p.minAtrPct}，赚不够手续费）` };
    if (atrPct > p.maxAtrPct) return { ok: false, reason: `ATR% ${atrPct.toFixed(2)} 过高（>${p.maxAtrPct}，易被插针）` };
  }
  if (typeof barChangePct === 'number' && barChangePct <= -p.blackSwanPct) {
    return { ok: false, reason: `黑天鹅闸门：单根 1H ${barChangePct.toFixed(2)}%` };
  }
  /* regime 选品过滤（Task A；默认全关 → 不进任何分支，与本文件旧版本逐字节一致）。
   * 指标缺失时该项不拦（fail-open）：实盘调度器未接这些量时，行为退化为「不启用该过滤」，
   * 而不是静默把所有开仓都拦掉。 */
  {
    const rgf = regime || {};
    const vVr5 = num(vr5, NaN);
    const vVr5x = Number.isFinite(vVr5) ? vVr5 : num(rgf.vr5, NaN);
    const vRf = num(rf, NaN);
    const vRfx = Number.isFinite(vRf) ? vRf : num(rgf.rf, NaN);
    const vAdx = num(adx, NaN);
    const vAdxx = Number.isFinite(vAdx) ? vAdx : num(rgf.adx, NaN);
    if (p.entryAtrPctMax > 0 && typeof atrPct === 'number' && atrPct > p.entryAtrPctMax) {
      return { ok: false, reason: `入场时机：ATR% ${atrPct.toFixed(2)} > ${p.entryAtrPctMax}（高波动跳过）` };
    }
    if (p.entryVr5Max > 0 && Number.isFinite(vVr5x) && vVr5x >= p.entryVr5Max) {
      return { ok: false, reason: `regime 过滤：vr5 ${vVr5x.toFixed(3)} ≥ ${p.entryVr5Max}（趋势性过强）` };
    }
    if (p.entryAdxMax > 0 && Number.isFinite(vAdxx) && vAdxx >= p.entryAdxMax) {
      return { ok: false, reason: `regime 过滤：adx ${vAdxx.toFixed(1)} ≥ ${p.entryAdxMax}（趋势过强）` };
    }
    if (p.entryRfMin > 0 && Number.isFinite(vRfx) && vRfx <= p.entryRfMin) {
      return { ok: false, reason: `regime 过滤：rf ${vRfx.toFixed(3)} ≤ ${p.entryRfMin}（回归频率不足）` };
    }
    if (String(p.entrySkipTrend).toLowerCase() === 'on' && rgf.regime && rgf.regime !== 'range') {
      return { ok: false, reason: `regime 过滤：只做 range，当前 ${rgf.regime}` };
    }
  }
  const rg = regime || {};
  const allow = Array.isArray(rg.allow) ? rg.allow : [];
  if (!allow.length) return { ok: false, reason: `状态 ${rg.regime || 'unknown'} 不开新篮子` };
  /* 入场时机门槛（entryZMin > 0 才启用）：|z| 达阈值才开首单，方向取均值回归方向
   *   z > 0（价格偏离上轨）→ 做空；z < 0（下轨）→ 做多。
   *   ⚠ entryZ 由调用方用「i-1 及更早收盘」算好传入；缺省（live 未接）时不拦（保持旧行为）。
   *   默认 entryZMin = 0 → 本分支不进入，行为与本文件旧版本逐字节一致。 */
  if (p.entryZMin > 0) {
    const z = Number(entryZ);
    if (Number.isFinite(z)) {
      if (Math.abs(z) < p.entryZMin) {
        return { ok: false, reason: `入场时机：z=${z.toFixed(2)} 未达 ±${p.entryZMin}（偏离不足）` };
      }
      if (p.entryZMode === 'filter') {
        /* 只做「z 方向与状态方向一致」的偏离：状态允许 long 时要求 z < 0（下轨），允许 short 时要求 z > 0（上轨） */
        const regSide = allow.length > 1
          ? (num(rg.price) > 0 && num(rg.ema50) > 0 && num(rg.price) < num(rg.ema50) ? 'long' : 'short')
          : allow[0];
        const zSide = z > 0 ? 'short' : 'long';
        if (zSide !== regSide) {
          return { ok: false, reason: `入场时机：z=${z.toFixed(2)} 方向(${zSide}) 与状态方向(${regSide}) 不一致` };
        }
        return { ok: true, side: regSide, reason: 'ok', entryZ: round(z, 4) };
      }
      return { ok: true, side: z > 0 ? 'short' : 'long', reason: 'ok', entryZ: round(z, 4) };
    }
  }
  let side;
  if (allow.length > 1) {
    // 震荡：顺均值回归方向（价格低于 EMA50 做多，高于做空）
    const px = num(rg.price), e50 = num(rg.ema50);
    side = px > 0 && e50 > 0 && px < e50 ? 'long' : 'short';
  } else {
    side = allow[0];
  }
  return { ok: true, side, reason: 'ok' };
}

/* ── 收盘驱动（状态机核心） ─────────────────────── */

function closeBasket(basket, price, ts, reason) {
  const pnl = basketPnl(basket, price);
  basket.closed = true;
  basket.closedAt = ts;
  basket.closeReason = reason;
  basket.closePrice = round(num(price), 10);
  basket.realizedPnl = round(num(basket.realizedPnl) + pnl.upl, 6);
  basket.finalUpl = pnl.upl;
  basket.finalUplPct = pnl.uplPct;
  return pnl;
}

/**
 * §2.3 价格驱动。返回 { events, basket }；basket 为同一对象（原地更新，便于落盘）。
 *
 * 判定顺序（先用先用）：
 *   1) trend_flip  反向确认趋势（regime.regime 与持仓方向相反）→ 平仓
 *   2) liquidation 逐仓爆仓价（亏光本篮保证金）→ 平仓【扩展事件，B 面板按平仓处理】
 *   3) stop_loss   价格触及整篮硬止损价 → 平仓
 *   4) time_stop   持仓超过 timeStopHours → 平仓
 *   5) take_profit 价格触及整篮止盈价 → 平仓
 *   6) add         价格触及下一加仓价 → 加仓（可被黑天鹅闸门拦下，发 add_blocked）
 *
 * ⚠ 为什么必须有 liquidation：政策 hardStopPct 是「占开仓时权益 4%」，而首单只占权益 1%（逐仓），
 *   1~2 层的篮子浮亏根本到不了 4% 权益就会被交易所强平 —— 爆仓才是浅篮子的真实约束。
 *
 * @param {object} ctx { price, atr, regime, ts, availableMarginUsd?, slipBps? }
 *   regime 为 universe.classifyRegime() 的返回对象（可额外带 barChangePct）
 *   slipBps：逐次成交施加的不利滑点（bps）；触发价不变，只推成交价。默认 0 = 不施加。
 */
function onPrice(basket, ctx = {}) {
  const events = [];
  if (!basket || basket.closed) return { events, basket };
  const p = normPolicy(basket.policy);
  const px = num(ctx.price);
  const ts = num(ctx.ts) || Date.now();
  if (!(px > 0)) return { events, basket };
  const dir = dirOf(basket);
  const rg = ctx.regime || {};
  const slip = num(ctx.slipBps);        // bps；0 = 不施加（逐位回归原行为）
  // 当前 ATR%（波动止盈用；优先 ctx.atrPct，其次 ctx.atr 价格单位）
  const atrPctCtx = num(ctx.atrPct) > 0 ? num(ctx.atrPct) : (num(ctx.atr) > 0 ? (num(ctx.atr) / px) * 100 : null);

  const evBase = () => ({ instId: basket.instId, side: basket.side, ts, price: round(px, 10), levels: (basket.levels || []).length });

  /* 1) 趋势反转离场：口径由 trendFlipMode 决定（默认 now = 旧行为）
   *   now     → 反向确认即刻平篮
   *   confirm → 连续 N 根同向反向趋势才平（按 bar 去重计数，避免同一根多次调用被多计）
   *   half    → 首次反向先减仓 X% 并保留止损；再持续 N 根则平掉剩余 */
  const tfMode = p.trendFlipMode === 'confirm' || p.trendFlipMode === 'half' ? p.trendFlipMode : 'now';
  const needBars = Math.max(2, Math.floor(num(p.trendFlipConfirmBars, 2)));
  const opposite =
    (rg.regime === 'trend_up' && basket.side === 'short') ||
    (rg.regime === 'trend_down' && basket.side === 'long');
  if (opposite) {
    if (tfMode === 'now') {
      const pnl = closeBasket(basket, exitFillPx(px, basket.side, slip), ts, 'trend_flip');
      events.push({ type: 'trend_flip', ...evBase(), triggerPx: round(px, 10), fillPx: basket.closePrice, pnlUsd: pnl.upl, uplPct: pnl.uplPct, avgPx: pnl.avgPx });
      return { events, basket };
    }
    /* 反向趋势持续计数（同一 ts 只计一次；反向消失时归零） */
    if (num(basket.flipCountAtTs, -1) !== ts) { basket.flipBars = num(basket.flipBars) + 1; basket.flipCountAtTs = ts; }
    if (tfMode === 'confirm') {
      if (basket.flipBars >= needBars) {
        const pnl = closeBasket(basket, exitFillPx(px, basket.side, slip), ts, 'trend_flip');
        events.push({ type: 'trend_flip', ...evBase(), confirmedBars: basket.flipBars, triggerPx: round(px, 10), fillPx: basket.closePrice, pnlUsd: pnl.upl, uplPct: pnl.uplPct, avgPx: pnl.avgPx });
        return { events, basket };
      }
      events.push({ type: 'trend_flip_pending', ...evBase(), flipBars: basket.flipBars, needBars });
      // 未确认：不平篮，继续走后续止损/止盈/加仓判定（本根仍受完整止损保护）
    } else if (tfMode === 'half') {
      if (!basket.flipReduced) {
        const fillPx = exitFillPx(px, basket.side, slip);
        const rr = reduceExposure(basket, { fraction: num(p.trendFlipReducePct, 50) / 100, price: fillPx, ts, reason: 'trend_flip' });
        basket.flipReduced = true;
        if (rr) events.push({ type: 'trend_flip_reduce', ...evBase(), contracts: rr.contracts, notionalUsd: rr.notionalUsd, pnlUsd: rr.pnlUsd, avgPx: rr.avgPx, remainContracts: rr.remainContracts, reducePct: num(p.trendFlipReducePct, 50), triggerPx: round(px, 10), fillPx: round(fillPx, 10) });
        if (basket.closed) return { events, basket };
      } else if (basket.flipBars >= needBars) {
        const pnl = closeBasket(basket, exitFillPx(px, basket.side, slip), ts, 'trend_flip');
        events.push({ type: 'trend_flip', ...evBase(), confirmedBars: basket.flipBars, triggerPx: round(px, 10), fillPx: basket.closePrice, pnlUsd: pnl.upl, uplPct: pnl.uplPct, avgPx: pnl.avgPx });
        return { events, basket };
      }
    }
  } else if (num(basket.flipBars) > 0) {
    basket.flipBars = 0;      // 反向趋势消失 → 重新计数
  }

  /* 2) 爆仓（逐仓：亏光本篮保证金 → 交易所强平） */
  const lip = liquidationPrice(basket);
  if (lip !== null && ((dir > 0 && px <= lip) || (dir < 0 && px >= lip))) {
    const pnl = closeBasket(basket, exitFillPx(px, basket.side, slip), ts, 'liquidation');
    events.push({ type: 'liquidation', ...evBase(), liqPx: lip, triggerPx: round(px, 10), fillPx: basket.closePrice, pnlUsd: pnl.upl, uplPct: pnl.uplPct, avgPx: pnl.avgPx });
    return { events, basket };
  }

  /* 3) 硬止损 */
  /* 整篮风险兜底：金额口径，任何层数都可达 */
  {
    const riskPct = num(p.maxBasketRiskPct);
    const eqAtOpen = num(basket.equityAtOpen) > 0 ? num(basket.equityAtOpen)
      : (num(basket.stopUsd) > 0 && num(p.hardStopPct) > 0 ? num(basket.stopUsd) / (num(p.hardStopPct) / 100) : 0);
    if (riskPct > 0 && eqAtOpen > 0) {
      const riskUsd = eqAtOpen * riskPct / 100;
      const cur = basketPnl(basket, px);
      if (cur.upl <= -riskUsd) {
        const pnl = closeBasket(basket, exitFillPx(px, basket.side, slip), ts, 'risk_stop');
        events.push({ type: 'risk_stop', ...evBase(), riskUsd: round(riskUsd, 4), triggerPx: round(px, 10), fillPx: basket.closePrice, pnlUsd: pnl.upl, uplPct: pnl.uplPct, avgPx: pnl.avgPx });
        return { events, basket };
      }
    }
  }

  const sl = stopPrice(basket);
  if (sl !== null && ((dir > 0 && px <= sl) || (dir < 0 && px >= sl))) {
    const pnl = closeBasket(basket, exitFillPx(px, basket.side, slip), ts, 'stop_loss');
    events.push({ type: 'stop_loss', ...evBase(), stopPx: sl, triggerPx: round(px, 10), fillPx: basket.closePrice, pnlUsd: pnl.upl, uplPct: pnl.uplPct, avgPx: pnl.avgPx });
    return { events, basket };
  }

  /* 4) 时间止损 */
  if (p.timeStopHours > 0 && ts - num(basket.openedAt) >= p.timeStopHours * 3600e3) {
    const pnl = closeBasket(basket, exitFillPx(px, basket.side, slip), ts, 'time_stop');
    events.push({ type: 'time_stop', ...evBase(), hours: round((ts - basket.openedAt) / 3600e3, 2), fillPx: basket.closePrice, pnlUsd: pnl.upl, uplPct: pnl.uplPct, avgPx: pnl.avgPx });
    return { events, basket };
  }

  /* 5) 部分止盈（默认 off → partialTpPrice 恒 null，不进分支；先于整篮止盈判定） */
  const ptp = partialTpPrice(basket);
  if (ptp !== null && ((dir > 0 && px >= ptp) || (dir < 0 && px <= ptp))) {
    const fillPx = exitFillPx(px, basket.side, slip);
    const rr = reduceExposure(basket, { fraction: num(p.partialTpFracPct, 50) / 100, price: fillPx, ts, reason: 'partial_tp' });
    basket.partialTpDone = true;
    if (rr) events.push({ type: 'partial_tp', ...evBase(), contracts: rr.contracts, notionalUsd: rr.notionalUsd, pnlUsd: rr.pnlUsd, avgPx: rr.avgPx, remainContracts: rr.remainContracts, reducePct: num(p.partialTpFracPct, 50), ptPx: ptp, triggerPx: round(px, 10), fillPx: round(fillPx, 10) });
    if (basket.closed) return { events, basket };   // 张数太少被减光
  }

  /* 6) 整篮止盈 */
  const tp = takeProfitPrice(basket, atrPctCtx);
  if (tp !== null && ((dir > 0 && px >= tp) || (dir < 0 && px <= tp))) {
    const pnl = closeBasket(basket, exitFillPx(px, basket.side, slip), ts, 'take_profit');
    events.push({ type: 'take_profit', ...evBase(), tpPx: tp, triggerPx: round(px, 10), fillPx: basket.closePrice, pnlUsd: pnl.upl, uplPct: pnl.uplPct, avgPx: pnl.avgPx });
    return { events, basket };
  }

  /* 7) 加仓 */
  const addPx = nextAddPrice(basket, ctx.atr);
  if (addPx !== null && ((dir > 0 && px <= addPx) || (dir < 0 && px >= addPx))) {
    const chg = typeof rg.barChangePct === 'number' ? rg.barChangePct : null;
    const swan = chg !== null && (dir > 0 ? chg <= -p.blackSwanPct : chg >= p.blackSwanPct);
    if (swan) {
      events.push({ type: 'add_blocked', ...evBase(), reason: `黑天鹅闸门：单根 1H ${chg.toFixed(2)}%`, addPx });
      return { events, basket };
    }
    const idx = (basket.levels || []).length;
    const marginUsd = levelMargin(basket, idx);
    const avail = ctx.availableMarginUsd;
    if (typeof avail === 'number' && avail > 0 && marginUsd > avail) {
      events.push({ type: 'add_blocked', ...evBase(), reason: `可用保证金不足（需 ${marginUsd.toFixed(2)}，剩 ${avail.toFixed(2)}）`, addPx });
      return { events, basket };
    }
    const contracts = sizeForMargin({
      marginUsd, leverage: num(basket.policy.leverage, 1), price: addPx,
      ctVal: basket.ctVal, lotSz: basket.lotSz, minSz: basket.minSz,
    });
    if (!contracts) {
      events.push({ type: 'add_blocked', ...evBase(), reason: `第 ${idx + 1} 层张数不足 minSz（保证金 ${marginUsd.toFixed(2)}）`, addPx });
      return { events, basket };
    }
    basket.levels.push({ idx, ts, price: round(entryFillPx(addPx, basket.side, slip), 10), contracts, marginUsd: round(marginUsd, 6), reason: ctx.reason || 'add', atrPx: ctx.atr === undefined || ctx.atr === null ? null : round(ctx.atr, 10) });
    const after = basketPnl(basket, px);
    events.push({
      type: 'add', ...evBase(), levelIdx: idx, levelNo: idx + 1, addPx: round(addPx, 10),
      fillPx: basket.levels[basket.levels.length - 1].price,
      contracts, marginUsd: round(marginUsd, 6), avgPx: after.avgPx, uplPct: after.uplPct,
      totalMarginUsd: after.marginUsd,
    });
    return { events, basket };
  }

  return { events, basket };
}

module.exports = {
  DEFAULT_POLICY,
  normPolicy,
  floorToStep,
  // §2.3 契约
  sizeForMargin,
  nextAddPrice,
  basketPnl,
  // 盈利能力组助手
  makerFirstOn,
  tpOrderIsLimit,
  flagOn,
  layeredStopOn,
  partialTpOn,
  reduceExposure,
  partialTpPrice,
  zScore,
  atrPctFrom,
  effectiveTpPct,
  clampNum,
  liquidationPrice,
  shouldOpen,
  onPrice,
  newBasket,
  // 面板/调度器可用的辅助量
  avgPrice,
  totalContracts,
  totalMargin,
  takeProfitPrice,
  stopPrice,
  levelMargin,
  cumulativeMargin,
  basketCount,
  basketSectors,
  basketInstIds,
  slipFactors,
  entryFillPx,
  exitFillPx,
};
