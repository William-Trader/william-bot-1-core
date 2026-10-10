/**
 * 【桩·stub】modules/risk.js 的替身（B 方自测 / A 缺件时兜底）
 *
 * ⚠️ 不是交付物。语义严格镜像 A 已交付的 modules/risk.js：
 *    gate / markCooldown / pruneCooldowns / settleDay
 *    · state.circuitBreaker 是**布尔**（A 的口径），另有 circuitBreakerAt / circuitBreakerReason
 *    · 冷却表 state.cooldowns = { instId: 到期毫秒 }
 *    · settleDay 默认不自动解除熔断（design §五.3 人工解除）
 */
const martin = require('./martin');
const pct = (v) => `${(Number(v) * 100).toFixed(4)}%`;

function gate({ state, policy, equity, todayPnlPct, funding, sector, openBaskets, instId, atrPct, barChangePct, now }) {
  const p = martin.normPolicy(policy);
  const st = state || {};
  const ts = Number(now) || Date.now();
  const eq = Number(equity);
  const count = martin.basketCount(openBaskets);

  if (!(eq > 0)) return { allow: false, reason: '权益为 0 或负' };
  if (st.paused) return { allow: false, reason: '调度已暂停（pause）' };
  if (st.circuitBreaker) return { allow: false, reason: `日亏熔断中：${st.circuitBreakerReason || '已触发'}（需人工解除）` };
  if (typeof todayPnlPct === 'number' && todayPnlPct <= -p.dailyLossPct) return { allow: false, reason: `当日亏损熔断：${todayPnlPct.toFixed(2)}% ≤ −${p.dailyLossPct}%` };
  const f = Number(funding) || 0;
  if (Math.abs(f) > p.maxFundingAbs) return { allow: false, reason: `费率闸门：|${pct(f)}| > ${pct(p.maxFundingAbs)}` };
  if (typeof barChangePct === 'number' && barChangePct <= -p.blackSwanPct) return { allow: false, reason: `黑天鹅闸门：单根 1H ${barChangePct.toFixed(2)}%` };
  if (typeof atrPct === 'number') {
    if (atrPct < p.minAtrPct) return { allow: false, reason: `波动过低：ATR% ${atrPct.toFixed(2)} < ${p.minAtrPct}` };
    if (atrPct > p.maxAtrPct) return { allow: false, reason: `波动过高：ATR% ${atrPct.toFixed(2)} > ${p.maxAtrPct}` };
  }
  if (count >= p.maxBaskets) return { allow: false, reason: `篮子数上限：${count}/${p.maxBaskets}` };
  if (sector && martin.basketSectors(openBaskets).includes(sector)) return { allow: false, reason: `板块去重：${sector} 已有持仓篮子` };
  if (Array.isArray(openBaskets) && instId && martin.basketInstIds(openBaskets).includes(instId)) return { allow: false, reason: `同品种已有篮子：${instId}` };
  if (instId && st.cooldowns && Number(st.cooldowns[instId]) > ts) {
    const mins = ((Number(st.cooldowns[instId]) - ts) / 60000).toFixed(1);
    return { allow: false, reason: `冷却中：${instId} 还需 ${mins} 分钟` };
  }
  return { allow: true, reason: 'ok' };
}

function markCooldown(state, instId, policy, ts) {
  const p = martin.normPolicy(policy);
  const now = Number(ts) || Date.now();
  if (!state.cooldowns) state.cooldowns = {};
  state.cooldowns[instId] = now + p.cooldownHours * 3600e3;
  return state.cooldowns[instId];
}
function pruneCooldowns(state, ts) {
  const now = Number(ts) || Date.now();
  if (!state.cooldowns) return state;
  for (const k of Object.keys(state.cooldowns)) if (Number(state.cooldowns[k]) <= now) delete state.cooldowns[k];
  return state;
}
function settleDay(state, { equity, dayStartEquity, day, ts, autoReset } = {}) {
  const st = state || {};
  const start = Number(dayStartEquity), eq = Number(equity);
  const pnlPct = start > 0 ? ((eq - start) / start) * 100 : 0;
  const p = martin.normPolicy(st.policy || {});
  const hit = pnlPct <= -p.dailyLossPct;
  const prev = st.circuitBreaker === true;
  const summary = { day: day || new Date(Number(ts) || Date.now()).toISOString().slice(0, 10), equity: eq, pnlPct: Number(pnlPct.toFixed(4)), breached: hit };
  if (hit) {
    st.circuitBreaker = true; st.circuitBreakerAt = Number(ts) || Date.now();
    st.circuitBreakerReason = `当日亏损 ${pnlPct.toFixed(2)}% ≤ −${p.dailyLossPct}%`;
  } else if (autoReset && prev) {
    st.circuitBreaker = false; st.circuitBreakerAt = null; st.circuitBreakerReason = null; summary.reset = true;
  }
  st.day = summary.day; st.dayStartEquity = eq;
  return { state: st, summary };
}

module.exports = { gate, markCooldown, pruneCooldowns, settleDay, STUB: true };
