/*!
 * modules/risk.js - william-bot-1-core key engine logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-ADBB4730
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
/**
 * modules/risk.js —— 风控闸门（不可关）
 *
 * 契约：design/MARTIN-BOT-SPEC.md §2.3 risk.gate({ state, policy, equity, todayPnlPct, funding, sector, openBaskets })
 *       → { allow, reason }
 * 口径：design/马丁策略设计.md 第五章（逐仓隔离 / 相关性去重 / 日亏熔断 / 层数硬顶 / 费率闸门 / 黑天鹅）
 *
 * 说明
 * - 本模块是「开新篮子」的总闸门（含熔断/冷却等有状态项）；纯策略层方向判定在 martin.shouldOpen。
 *   B 的调度器两个都调：shouldOpen 拿方向，gate 拿状态闸门。
 * - state 形如 modules/store.js 的 emptyState()：{ circuitBreaker, cooldowns:{instId:tsMs}, ... }
 * - 契约签名里没有 instId，冷却判定需要它；额外传 `instId` 即可生效（不传则跳过冷却项）。
 */
'use strict';

const martin = require('./martin');

const pct = (v) => `${(Number(v) * 100).toFixed(4)}%`;

/**
 * 总闸门。
 * @returns {{allow:boolean, reason:string}}
 */
function gate({ state, policy, equity, todayPnlPct, funding, sector, openBaskets, instId, atrPct, barChangePct, now }) {
  const p = martin.normPolicy(policy);
  const st = state || {};
  const ts = Number(now) || Date.now();
  const eq = Number(equity);
  const count = martin.basketCount(openBaskets);

  if (!(eq > 0)) return { allow: false, reason: '权益为 0 或负' };
  if (st.paused) return { allow: false, reason: '调度已暂停（pause）' };
  if (st.circuitBreaker) {
    return { allow: false, reason: `日亏熔断中：${st.circuitBreakerReason || '已触发'}（需人工解除）` };
  }
  if (typeof todayPnlPct === 'number' && todayPnlPct <= -p.dailyLossPct) {
    return { allow: false, reason: `当日亏损熔断：${todayPnlPct.toFixed(2)}% ≤ −${p.dailyLossPct}%` };
  }
  const f = Number(funding) || 0;
  if (Math.abs(f) > p.maxFundingAbs) {
    return { allow: false, reason: `费率闸门：|${pct(f)}| > ${pct(p.maxFundingAbs)}` };
  }
  if (typeof barChangePct === 'number' && barChangePct <= -p.blackSwanPct) {
    return { allow: false, reason: `黑天鹅闸门：单根 1H ${barChangePct.toFixed(2)}%` };
  }
  if (typeof atrPct === 'number') {
    if (atrPct < p.minAtrPct) return { allow: false, reason: `波动过低：ATR% ${atrPct.toFixed(2)} < ${p.minAtrPct}` };
    if (atrPct > p.maxAtrPct) return { allow: false, reason: `波动过高：ATR% ${atrPct.toFixed(2)} > ${p.maxAtrPct}` };
  }
  if (count >= p.maxBaskets) {
    return { allow: false, reason: `篮子数上限：${count}/${p.maxBaskets}` };
  }
  if (sector && martin.basketSectors(openBaskets).includes(sector)) {
    return { allow: false, reason: `板块去重：${sector} 已有持仓篮子` };
  }
  if (Array.isArray(openBaskets) && instId && martin.basketInstIds(openBaskets).includes(instId)) {
    return { allow: false, reason: `同品种已有篮子：${instId}` };
  }
  if (instId && st.cooldowns && Number(st.cooldowns[instId]) > ts) {
    const mins = ((Number(st.cooldowns[instId]) - ts) / 60000).toFixed(1);
    return { allow: false, reason: `冷却中：${instId} 还需 ${mins} 分钟` };
  }
  return { allow: true, reason: 'ok' };
}

/** 平仓后登记冷却（B 的调度器在收到平仓事件后调用） */
function markCooldown(state, instId, policy, ts) {
  const p = martin.normPolicy(policy);
  const now = Number(ts) || Date.now();
  if (!state.cooldowns) state.cooldowns = {};
  state.cooldowns[instId] = now + p.cooldownHours * 3600e3;
  return state.cooldowns[instId];
}

/** 清掉已过期的冷却记录（避免 state.json 无限膨胀） */
function pruneCooldowns(state, ts) {
  const now = Number(ts) || Date.now();
  if (!state.cooldowns) return state;
  for (const k of Object.keys(state.cooldowns)) if (Number(state.cooldowns[k]) <= now) delete state.cooldowns[k];
  return state;
}

/**
 * 日结：结算当日盈亏、必要时置熔断；不自动解除（design §五.3 人工解除）。
 * @returns {{state:object, summary:object}}
 */
function settleDay(state, { equity, dayStartEquity, day, ts, autoReset } = {}) {
  const st = state || {};
  const start = Number(dayStartEquity);
  const eq = Number(equity);
  const pnlPct = start > 0 ? ((eq - start) / start) * 100 : 0;
  const p = martin.normPolicy(st.policy || {});
  const hit = pnlPct <= -p.dailyLossPct;
  const prev = st.circuitBreaker === true;
  const summary = { day: day || new Date(Number(ts) || Date.now()).toISOString().slice(0, 10), equity: eq, pnlPct: Number(pnlPct.toFixed(4)), breached: hit };
  if (hit) {
    st.circuitBreaker = true;
    st.circuitBreakerAt = Number(ts) || Date.now();
    st.circuitBreakerReason = `当日亏损 ${pnlPct.toFixed(2)}% ≤ −${p.dailyLossPct}%`;
  } else if (autoReset && prev) {
    st.circuitBreaker = false;
    st.circuitBreakerAt = null;
    st.circuitBreakerReason = null;
    summary.reset = true;
  }
  st.day = summary.day;
  st.dayStartEquity = eq;
  return { state: st, summary };
}

module.exports = { gate, markCooldown, pruneCooldowns, settleDay };
