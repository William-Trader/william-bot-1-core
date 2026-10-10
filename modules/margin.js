/*!
 * modules/margin.js - william-bot-1-core key engine logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-52B6D531
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
/**
 * modules/margin.js —— 智能保证金系统
 *   风险预算驱动（按「死亡线亏损」反解首层名义） + 可行性感知（最小下单放不下就拒） + 全场占用上限
 *
 * ── 核心口径（务必分清：风险 ≠ 占用）───────────────────────────────
 *   · 风险：由「总名义 N_total」与「死亡线距离 d」共同决定，**与杠杆无关**；
 *           加杠杆只会让你少占用保证金，不会让你少亏一分钱。
 *   · 占用：totalMargin = N_total / leverage，**只受杠杆影响**。
 *   返回值里这两件事分开给：riskAtDeathUsd / riskPctEquity（风险）
 *   与 totalMarginUsd / occupancyPct（占用）。
 *
 * ── 反解公式 ────────────────────────────────────────────────────
 *   死亡线距离      d  = deathAtrMult × atrPct%            （价格比例，无量纲）
 *   层几何          g(i) = multiplier^(i-1)，G = Σ_{i=1..maxLevels} g(i)
 *   本篮风险预算    riskBudgetUsd = equity × basketRiskBudgetPct%
 *   首层名义        N1 = riskBudgetUsd / (G × d × riskK)
 *   总名义          N_total = N1 × G
 *   总保证金        totalMargin = N_total / leverage
 *
 *   ⚠ riskK 的方向（别搞反）：k 在**分母**，k<1 会把名义**放大**。
 *     k = 0.75 ⇒ N_total × d = riskBudget / k = 1.33 × 预算，
 *     即「死亡线亏损」按单点近似约为预算的 1.33 倍（不是 0.75 倍）。
 *     若要「死亡线亏损 ≤ 预算」应取 k ≥ 1；本模块按需求默认 0.75，
 *     并在返回值 warnings 里把放大倍数写出来，避免误读。
 *
 * ── 兼容性 ──────────────────────────────────────────────────────
 *   本模块**不依赖**外部新增参数：deathAtrMult / sizingMode / basketRiskBudgetPct /
 *   maxTotalOccupancyPct / riskK 缺失时用 MARGIN_DEFAULTS；
 *   policy 里若已存在（外部后来加上了）则**以 policy 为准**。
 *   金额兜底兼容两种命名：maxBasketRiskPct（新）或 hardStopPct（旧）。
 *
 *   sizingMode:'fixed' = 完全走 modules/martin.js 的旧口径（首单保证金 %），
 *   逐字节一致（本模块在 fixed 下直接调用 martin 的原语，不自己算）。
 */
'use strict';

const martin = require('./martin');

const MARGIN_DEFAULTS = Object.freeze({
  sizingMode: 'risk',          // risk = 风险预算反解（默认）｜fixed = 旧口径（首单保证金 %）
  basketRiskBudgetPct: 2,      // 每篮死亡线亏损预算（% 权益）
  maxTotalOccupancyPct: 45,    // 全场保证金占用上限（% 权益）
  riskK: 0.75,                 // 反解系数（在分母；k<1 放大名义，见文件头）
  deathAtrMult: 2.0,           // 死亡线距离 = deathAtrMult × ATR%（policy 无此项时的默认）
});

const round = (v, n = 6) => {
  const x = Number(v);
  if (!Number.isFinite(x)) return 0;
  return Number(x.toFixed(n));
};
const pctToFrac = (v) => Number(v) / 100;

/* ── 参数归一 ───────────────────────────────────── */

/** 合并 martin 策略参数与保证金参数；policy 优先，缺项用 MARGIN_DEFAULTS */
function normMarginPolicy(policy) {
  const base = martin.normPolicy(policy || {});
  const p = { ...base };
  for (const k of Object.keys(MARGIN_DEFAULTS)) {
    const cur = p[k];
    const need = cur === undefined || cur === null || (typeof MARGIN_DEFAULTS[k] === 'number' && !Number.isFinite(Number(cur)));
    if (need) p[k] = MARGIN_DEFAULTS[k];
  }
  p.sizingMode = p.sizingMode === 'fixed' ? 'fixed' : 'risk';
  p.basketRiskBudgetPct = Number(p.basketRiskBudgetPct);
  p.maxTotalOccupancyPct = Number(p.maxTotalOccupancyPct);
  p.riskK = Number(p.riskK);
  p.deathAtrMult = Number(p.deathAtrMult);
  // 金额兜底：兼容新命名 maxBasketRiskPct 与旧命名 hardStopPct
  const mb = p.maxBasketRiskPct !== undefined && p.maxBasketRiskPct !== null ? p.maxBasketRiskPct : p.hardStopPct;
  p.moneyBackstopPct = Number.isFinite(Number(mb)) ? Number(mb) : 0;
  p.moneyBackstopUsdOf = 'maxBasketRiskPct|hardStopPct';
  return p;
}

/** 组合校验：返回 { ok, errors, warnings }（不抛） */
function validateMarginPolicy(policy) {
  const p = normMarginPolicy(policy);
  const errors = [];
  const warnings = [];
  if (!['risk', 'fixed'].includes(p.sizingMode)) errors.push(`sizingMode 只能是 risk / fixed（当前 ${p.sizingMode}）`);
  if (!(p.basketRiskBudgetPct > 0)) errors.push('basketRiskBudgetPct 必须为正数（% 权益/篮）');
  if (!(p.riskK > 0)) errors.push('riskK 必须为正数（在分母）');
  if (!(p.deathAtrMult > 0)) errors.push('deathAtrMult 必须为正数');
  if (p.maxTotalOccupancyPct > 60) errors.push(`maxTotalOccupancyPct ${p.maxTotalOccupancyPct}% > 60%：占用上限过高`);
  if (!(p.maxTotalOccupancyPct > 0)) errors.push('maxTotalOccupancyPct 必须为正数');
  const totalRiskPct = p.basketRiskBudgetPct * Number(p.maxBaskets);
  if (totalRiskPct > 40) errors.push(`总风险超限：basketRiskBudgetPct ${p.basketRiskBudgetPct}% × maxBaskets ${p.maxBaskets} = ${round(totalRiskPct, 2)}% > 40%`);
  else if (totalRiskPct > 20) warnings.push(`总风险 ${round(totalRiskPct, 2)}%（>20% 设计建议线；已按 A+C 方案上调上限至 40%，由 5% 日亏熔断与 3% 单篮兜底先截断）`);
  else if (totalRiskPct > 12) warnings.push(`总风险偏高：${p.basketRiskBudgetPct}% × ${p.maxBaskets} 篮 = ${round(totalRiskPct, 2)}%（>12% 的设计建议线；实际亏损由每篮 maxBasketRiskPct ${p.maxBasketRiskPct}% 兜底先截断）`);
  if (p.riskK < 1) warnings.push(`riskK=${p.riskK} < 1：名义被放大 ${round(1 / p.riskK, 3)} 倍（死亡线亏损 ≈ 预算 × ${round(1 / p.riskK, 3)}）`);
  if (totalRiskPct > 8) warnings.push(`总风险预算 ${round(totalRiskPct, 2)}% 偏高（建议 ≤8%）`);
  return { ok: errors.length === 0, errors, warnings, effective: { sizingMode: p.sizingMode, basketRiskBudgetPct: p.basketRiskBudgetPct, maxTotalOccupancyPct: p.maxTotalOccupancyPct, riskK: p.riskK, deathAtrMult: p.deathAtrMult, totalRiskPct: round(totalRiskPct, 2) } };
}

/* ── 纯函数：几何 / 反解 / 风险 ─────────────────── */

/** 层几何：g(i)=multiplier^(i-1)，G=Σg(i) */
function layerGeometry(maxLevels, multiplier) {
  const n = Math.max(1, Math.floor(Number(maxLevels) || 1));
  const m = Number(multiplier) > 0 ? Number(multiplier) : 1;
  const factors = [];
  let g = 1, G = 0;
  for (let i = 1; i <= n; i++) { factors.push(g); G += g; g *= m; }
  return { levels: n, multiplier: m, factors, G: round(G, 8) };
}

/** 死亡线距离 d（价格比例）：deathAtrMult × atrPct% */
function deathDistance(atrPct, deathAtrMult) {
  return round(pctToFrac(Number(atrPct)) * Number(deathAtrMult), 10);
}

/** 反解首层名义：N1 = riskBudgetUsd / (G × d × k) */
function solveFirstNotional({ riskBudgetUsd, d, G, k }) {
  const den = Number(G) * Number(d) * Number(k);
  if (!(den > 0)) return null;
  return Number(riskBudgetUsd) / den;
}

/** 最小合法张数：≥ minSz 且是 lotSz 整数倍 */
function minLegalContracts(lotSz, minSz) {
  const step = Number(lotSz) > 0 ? Number(lotSz) : (Number(minSz) > 0 ? Number(minSz) : 1);
  const min = Number(minSz) > 0 ? Number(minSz) : step;
  const n = Math.ceil((min - step * 1e-9) / step);
  return round(Math.max(1, n) * step, 10);
}

/** 逐层挂单价：首层=现价，其后按 policy 间距向不利侧推进（与 martin.nextAddPrice 同口径） */
function levelPrices({ price, atrPct, levels, spacingMode, spacingAtrMult, spacingPct, side }) {
  const dir = side === 'short' ? 1 : -1;                       // 空单向上加仓
  const atrPx = pctToFrac(Number(atrPct)) * Number(price);
  const out = [Number(price)];
  for (let i = 1; i < levels; i++) {
    const prev = out[i - 1];
    const sp = spacingMode === 'pct' ? prev * pctToFrac(spacingPct) : atrPx * Number(spacingAtrMult);
    const px = prev + dir * sp;
    if (!(px > 0)) break;
    out.push(round(px, 10));
  }
  return out;
}

/**
 * 死亡线亏损（用**实际可下单**的层算，不是单点近似）
 * 死亡线价 P_d = price × (1 − d·dir)；亏损 = |P_d − 均价| × 总币量
 */
function riskAtDeath({ levels, ctVal, d, side, price }) {
  const dir = side === 'short' ? -1 : 1;
  const placed = (levels || []).filter((l) => Number(l.contracts) > 0);
  const contracts = placed.reduce((a, l) => a + Number(l.contracts), 0);
  const qty = contracts * Number(ctVal);
  if (!(qty > 0)) return { qty: 0, avgPx: 0, deathPx: 0, lossUsd: 0, levelsUsed: 0 };
  const avgPx = placed.reduce((a, l) => a + Number(l.contracts) * Number(l.price), 0) / contracts;
  const deathPx = Number(price) * (1 - Number(d) * dir);
  const lossUsd = Math.abs(avgPx - deathPx) * qty;
  return { qty: round(qty, 8), avgPx: round(avgPx, 10), deathPx: round(deathPx, 10), lossUsd: round(lossUsd, 6), levelsUsed: placed.length };
}

/** 已占用保证金：兼容 martin 篮子（含 levels）与「纯 {marginUsd}」对象 */
function sumOpenMargin(openBaskets) {
  if (!Array.isArray(openBaskets)) return 0;
  return round(openBaskets.reduce((a, b) => {
    if (!b) return a;
    if (Array.isArray(b.levels) && b.levels.length) return a + martin.totalMargin(b);
    return a + (Number(b.marginUsd) || 0);
  }, 0), 6);
}

/* ── 主入口：单篮规划 ───────────────────────────── */

function fail(reason, extra = {}) {
  return {
    ok: false, reason,
    layer1MarginUsd: 0, layer1Contracts: 0, layer1NotionalUsd: 0,
    totalMarginUsd: 0, totalNotionalUsd: 0, riskAtDeathUsd: 0, riskPctEquity: 0,
    schedule: [], occupancyPct: 0,
    warnings: extra.warnings || [], detail: extra.detail || {},
  };
}

/**
 * 规划一个篮子（不落盘、不下单，纯计算）
 * @param {object} o { equity, atrPct, price, instrument, policy, openBaskets, sector, score, side }
 * @returns {object} 契约字段见文件头；异常输入返回 ok:false（不抛）
 */
function planBasket(o = {}) {
  const warnings = [];
  const { equity, atrPct, price, instrument, policy, openBaskets, sector, score, side } = o;
  const ins = instrument || {};
  const ctVal = Number(ins.ctVal);
  const lotSz = Number(ins.lotSz);
  const minSz = Number(ins.minSz);
  const maxLever = Number(ins.maxLever);
  const p = normMarginPolicy(policy);
  const sd = side === 'short' ? 'short' : 'long';
  const eq = Number(equity), px = Number(price), a = Number(atrPct);

  /* ── 输入守卫（降级不抛） ── */
  if (!(eq > 0)) return fail('权益必须为正数（当前 ' + equity + '）');
  if (!(px > 0)) return fail('价格必须为正数（当前 ' + price + '）');
  if (!(ctVal > 0)) return fail('合约面值 ctVal 缺失或非法');
  if (!(a > 0)) return fail('ATR% 缺失或非法（无死亡线距离可用）');
  if (!(p.deathAtrMult > 0)) return fail('deathAtrMult 必须为正数');
  if (!(p.riskK > 0)) return fail('riskK 必须为正数');
  if (!(Number(p.leverage) > 0)) return fail('leverage 必须为正数');
  if (!(p.basketRiskBudgetPct > 0)) return fail('basketRiskBudgetPct 必须为正数');

  const lev = maxLever > 0 ? Math.min(Number(p.leverage), maxLever) : Number(p.leverage);
  if (lev !== Number(p.leverage)) warnings.push(`杠杆被该品种上限压到 ${lev}×（策略要 ${p.leverage}×）`);

  const geo = layerGeometry(p.maxLevels, p.multiplier);
  const d = deathDistance(a, p.deathAtrMult);
  const riskBudgetUsd = round(eq * pctToFrac(p.basketRiskBudgetPct), 6);
  const minNotionalUsd = round(ctVal * (minSz > 0 ? minSz : (lotSz > 0 ? lotSz : 1)) * px, 8);
  const existingMarginUsd = sumOpenMargin(openBaskets);
  const capUsd = round(eq * pctToFrac(p.maxTotalOccupancyPct), 6);
  const remainingUsd = round(capUsd - existingMarginUsd, 6);
  const moneyBackstopUsd = p.moneyBackstopPct > 0 ? round(eq * pctToFrac(p.moneyBackstopPct), 6) : null;

  const detail = {
    sizingMode: p.sizingMode, leverage: lev, atrPx: round(pctToFrac(a) * px, 10), d: round(d, 8),
    G: geo.G, levels: geo.levels, multiplier: geo.multiplier, riskK: p.riskK,
    riskBudgetUsd, minNotionalUsd, existingMarginUsd, occupancyCapUsd: capUsd, remainingUsd,
    moneyBackstopUsd, deathAtrMult: p.deathAtrMult, basketRiskBudgetPct: p.basketRiskBudgetPct,
    maxTotalOccupancyPct: p.maxTotalOccupancyPct,
  };

  if (p.sizingMode === 'fixed') {
    return planFixed({ p, sd, eq, px, a, ins, ctVal, lotSz, minSz, lev, geo, d, warnings, detail, riskBudgetUsd, moneyBackstopUsd, existingMarginUsd, capUsd, remainingUsd });
  }

  /* ── risk 模式 ── */
  const n1Target = solveFirstNotional({ riskBudgetUsd, d, G: geo.G, k: p.riskK });
  if (!(n1Target > 0)) return fail('反解首层名义失败（参数导致分母非正）', { detail, warnings });
  detail.targetFirstNotionalUsd = round(n1Target, 8);
  detail.targetTotalNotionalUsd = round(n1Target * geo.G, 8);
  detail.targetTotalMarginUsd = round((n1Target * geo.G) / lev, 8);

  if (p.riskK < 1) {
    warnings.push(`riskK=${p.riskK}<1：死亡线亏损按单点近似 = 预算 × ${round(1 / p.riskK, 3)}（${round(riskBudgetUsd / p.riskK, 4)}U），不是 ${round(riskBudgetUsd * p.riskK, 4)}U`);
  }

  /* 占用上限：先看还有没有额度（账户级封锁优先于品种级「放不下」） */
  if (!(remainingUsd > 0)) {
    return fail(`占用上限已满：已有占用 $${round(existingMarginUsd, 4)} ≥ 上限 $${round(capUsd, 4)}（权益 ${round(eq, 2)} × ${p.maxTotalOccupancyPct}%）`, { detail, warnings });
  }

  /* 可行性：最小下单名义 > N1×1.5 → 放不下 */
  const feasibleCeil = n1Target * 1.5;
  if (minNotionalUsd > feasibleCeil) {
    return fail(
      `放不下：最小下单名义 $${round(minNotionalUsd, 4)} > 反解首层名义 $${round(n1Target, 4)} × 1.5 = $${round(feasibleCeil, 4)}`
      + `（该品种最小 ${minSz} 张 × ${ctVal} 面值 × $${round(px, 6)} 就超预算；需提高 basketRiskBudgetPct 或加大权益）`,
      { detail, warnings }
    );
  }

  /* 额度不够目标占用 → 按额度缩 */
  let n1 = n1Target;
  const totalMarginTarget = (n1Target * geo.G) / lev;
  if (existingMarginUsd + totalMarginTarget > capUsd) {
    const n1Cap = (remainingUsd * lev) / geo.G;
    if (!(n1Cap > 0)) {
      return fail(`占用上限已满：已有占用 $${round(existingMarginUsd, 4)} ≥ 上限 $${round(capUsd, 4)}`, { detail, warnings });
    }
    n1 = Math.min(n1Target, n1Cap);
    warnings.push(`占用上限触发：总保证金从 $${round(totalMarginTarget, 4)} 缩到 $${round((n1 * geo.G) / lev, 4)}（上限 $${round(capUsd, 4)}，已用 $${round(existingMarginUsd, 4)}）`);
    detail.shrunkByOccupancy = true;
  }

  /* 逐层合法张数 */
  const margin1Target = n1 / lev;
  let c1 = martin.sizeForMargin({ marginUsd: margin1Target, leverage: lev, price: px, ctVal, lotSz, minSz });
  if (!c1) {
    // 反解不足最小下单，但仍在 1.5× 容忍内 → 用最小合法下单并显式告警
    c1 = minLegalContracts(lotSz, minSz);
    warnings.push(`反解首层不足最小下单，已用最小合法张数 ${c1}（实际风险略超预算）`);
  }
  const baseMarginRaw = (ctVal * c1 * px) / lev;      // 未取整：用于推张数（取整会丢张）
  const baseMargin = round(baseMarginRaw, 6);         // 只用于展示/对齐 martin 的层保证金口径
  const priceLadder = levelPrices({ price: px, atrPct: a, levels: geo.levels, spacingMode: p.spacingMode, spacingAtrMult: p.spacingAtrMult, spacingPct: p.spacingPct, side: sd });

  const schedule = [];
  let totalMarginUsd = 0, totalNotionalUsd = 0;
  const levelsForRisk = [];
  for (let i = 0; i < geo.levels; i++) {
    const lvlPrice = priceLadder[i];
    if (!(lvlPrice > 0)) { warnings.push(`第 ${i + 1} 层挂单价非法，阶梯在此截断`); break; }
    // ⚠ 用「未取整」的保证金推张数：若用 round(…,6) 后的值反推，
    //   0.9999995 这类边界会被 floor 成 0 张 → 误判「不可下单」（篮子空转的根因之一）
    const marginRaw = i === 0 ? baseMarginRaw : baseMarginRaw * geo.factors[i];
    const contracts = i === 0
      ? c1
      : martin.sizeForMargin({ marginUsd: marginRaw, leverage: lev, price: lvlPrice, ctVal, lotSz, minSz });
    const notionalUsd = round(ctVal * contracts * lvlPrice, 8);
    const marginUsd = round(notionalUsd / lev, 6);        // 占用一律由「实际成交名义 / 杠杆」得出，与 notional 自洽
    schedule.push({ level: i + 1, marginUsd, contracts, notionalUsd, addPx: round(lvlPrice, 10), placeable: contracts > 0 });
    if (contracts > 0) {
      totalMarginUsd = round(totalMarginUsd + marginUsd, 6);
      totalNotionalUsd = round(totalNotionalUsd + notionalUsd, 8);
      levelsForRisk.push({ price: lvlPrice, contracts });
    } else {
      warnings.push(`第 ${i + 1} 层张数不足 minSz（保证金预算 $${marginUsd}）→ 该层不可下单，实际阶梯变浅`);
    }
  }
  if (!schedule.length || schedule[0].contracts <= 0) return fail('首层不可下单（张数不足 minSz）', { detail, warnings });

  const risk = riskAtDeath({ levels: levelsForRisk, ctVal, d, side: sd, price: px });
  const totalMarginAfter = round(existingMarginUsd + totalMarginUsd, 6);
  const occupancyPct = round((totalMarginAfter / eq) * 100, 4);

  if (totalMarginAfter > capUsd * 1.0002) {
    return fail(`占用上限冲突：缩到上限后实际仍需 $${round(totalMarginUsd, 4)} 保证金，剩余额度仅 $${round(remainingUsd, 4)}（最小下单张数吃掉额度）`, { detail, warnings });
  }
  if (risk.moneyBackstopUsd !== undefined) { /* noop：保持字段顺序稳定 */ }
  if (moneyBackstopUsd !== null && risk.lossUsd > moneyBackstopUsd) {
    warnings.push(`死亡线亏损 $${round(risk.lossUsd, 2)} > 金额兜底 $${moneyBackstopUsd}（${p.moneyBackstopPct}% 权益）→ 兜底会先触发`);
  }
  if (riskBudgetUsd > 0) {
    detail.riskVsBudgetRatio = round(risk.lossUsd / riskBudgetUsd, 4);
    if (risk.lossUsd > riskBudgetUsd * 1.05) {
      warnings.push(`实际死亡线亏损 $${round(risk.lossUsd, 2)} 超风险预算 $${round(riskBudgetUsd, 2)} 的 ${round(risk.lossUsd / riskBudgetUsd, 3)} 倍（含加仓摊低均价与张数取整）`);
    } else if (risk.lossUsd < riskBudgetUsd * 0.5) {
      warnings.push(`实际死亡线亏损 $${round(risk.lossUsd, 2)} 只有预算 $${round(riskBudgetUsd, 2)} 的 ${round(risk.lossUsd / riskBudgetUsd, 3)} 倍（张数取整导致欠配，利用率偏低）`);
    }
  }

  return {
    ok: true,
    layer1MarginUsd: schedule[0].marginUsd,
    layer1Contracts: schedule[0].contracts,
    layer1NotionalUsd: schedule[0].notionalUsd,
    totalMarginUsd,
    totalNotionalUsd,
    riskAtDeathUsd: risk.lossUsd,
    riskPctEquity: round((risk.lossUsd / eq) * 100, 4),
    schedule,
    occupancyPct,
    warnings,
    detail: { ...detail, avgEntryPx: risk.avgPx, deathPx: risk.deathPx, levelsPlaced: risk.levelsUsed, placedCount: schedule.filter((s) => s.placeable).length },
    riskDetail: risk,
  };
}

/** fixed 模式：完全走 martin 旧口径（保证与既有实现逐字节一致） */
function planFixed({ p, sd, eq, px, a, ins, ctVal, lotSz, minSz, lev, geo, d, warnings, detail, riskBudgetUsd, moneyBackstopUsd, existingMarginUsd, capUsd, remainingUsd }) {
  const basket = martin.newBasket({
    instId: detail.instId || 'PLAN', side: sd, sector: 'plan', price: px, atr: pctToFrac(a) * px,
    policy: { ...p, leverage: lev }, instrument: ins, equity: eq, ts: 1, regime: null,
  });
  if (!basket) return fail('fixed 口径：首单张数不足 minSz', { detail: { ...detail, sizingMode: 'fixed' }, warnings });

  const atrPx = pctToFrac(a) * px;
  const priceLadder = [basket.levels[0].price];
  const schedule = [{ level: 1, marginUsd: basket.levels[0].marginUsd, contracts: basket.levels[0].contracts, notionalUsd: round(ctVal * basket.levels[0].contracts * basket.levels[0].price, 8), addPx: basket.levels[0].price, placeable: true }];
  const probe = { ...basket, levels: [...basket.levels] };
  for (let i = 1; i < geo.levels; i++) {
    const addPx = martin.nextAddPrice(probe, atrPx);
    if (addPx === null) break;
    const marginUsd = martin.levelMargin(basket, i);
    const contracts = martin.sizeForMargin({ marginUsd, leverage: lev, price: addPx, ctVal, lotSz, minSz });
    schedule.push({ level: i + 1, marginUsd, contracts, notionalUsd: round(ctVal * contracts * addPx, 8), addPx, placeable: contracts > 0 });
    if (contracts <= 0) warnings.push(`第 ${i + 1} 层张数不足 minSz（保证金预算 $${marginUsd}）→ 该层不可下单`);
    probe.levels.push({ idx: i, ts: 1, price: addPx, contracts: contracts || minLegalContracts(lotSz, minSz), marginUsd, reason: 'add' });
    priceLadder.push(addPx);
  }
  const placed = schedule.filter((s) => s.contracts > 0);
  const totalMarginUsd = round(placed.reduce((x, s) => x + s.marginUsd, 0), 6);
  const totalNotionalUsd = round(placed.reduce((x, s) => x + s.notionalUsd, 0), 8);
  const risk = riskAtDeath({ levels: placed.map((s) => ({ price: s.addPx, contracts: s.contracts })), ctVal, d, side: sd, price: px });
  const totalMarginAfter = round(existingMarginUsd + totalMarginUsd, 6);
  const occupancyPct = round((totalMarginAfter / eq) * 100, 4);
  if (totalMarginAfter > capUsd * 1.0002) {
    warnings.push(`fixed 口径不受风险预算约束：占用 $${totalMarginAfter} 已超上限 $${capUsd}（fixed 模式只报告，不缩放）`);
  }
  if (moneyBackstopUsd !== null && risk.lossUsd > moneyBackstopUsd) warnings.push(`死亡线亏损 $${round(risk.lossUsd, 2)} > 金额兜底 $${moneyBackstopUsd} → 兜底会先触发`);

  return {
    ok: true,
    layer1MarginUsd: schedule[0].marginUsd,
    layer1Contracts: schedule[0].contracts,
    layer1NotionalUsd: schedule[0].notionalUsd,
    totalMarginUsd,
    totalNotionalUsd,
    riskAtDeathUsd: risk.lossUsd,
    riskPctEquity: round((risk.lossUsd / eq) * 100, 4),
    schedule,
    occupancyPct,
    warnings,
    detail: { ...detail, sizingMode: 'fixed', targetFirstNotionalUsd: null, avgEntryPx: risk.avgPx, deathPx: risk.deathPx, levelsPlaced: risk.levelsUsed, riskVsBudgetRatio: riskBudgetUsd > 0 ? round(risk.lossUsd / riskBudgetUsd, 4) : null },
    riskDetail: risk,
  };
}

/* ── 多品种贪心分配 ─────────────────────────────── */

const scoreOf = (c) => {
  if (!c) return 0;
  if (typeof c.score === 'number') return c.score;
  if (c.score && typeof c.score.total === 'number') return c.score.total;
  return 0;
};

/**
 * 按 score 从高到低贪心分配：板块去重 + 篮子上限 + 每篮各自风险预算 + 总占用不超上限
 * @param {Array} candidates [{ instId, sector, price|last, atrPct, instrument, score }]
 * @returns {object} { ok, allocations, rejected, totals }
 */
function allocate(candidates, { equity, policy, openBaskets } = {}) {
  const p = normMarginPolicy(policy);
  const eq = Number(equity);
  const list = Array.isArray(candidates) ? candidates.filter(Boolean).slice() : [];
  const open = Array.isArray(openBaskets) ? openBaskets.filter(Boolean) : [];
  const maxBaskets = Math.max(1, Math.floor(Number(p.maxBaskets) || 1));
  const allocations = [];
  const rejected = [];
  if (!(eq > 0)) return { ok: false, reason: '权益必须为正数', allocations, rejected, totals: null };

  const sortable = list.slice().sort((a, b) => scoreOf(b) - scoreOf(a));
  const runOpen = open.slice();                    // 运行中的篮子（含已接受的），用于去重与占用
  const sectorsInUse = new Set(martin.basketSectors(open));

  for (const c of sortable) {
    const instId = c.instId;
    const sector = c.sector || 'Other';
    const price = Number(c.price !== undefined ? c.price : c.last);
    const atrPct = Number(c.atrPct);
    const instrument = c.instrument || {
      ctVal: c.ctVal, lotSz: c.lotSz, minSz: c.minSz, maxLever: c.maxLever, ctValCcy: c.ctValCcy,
    };
    if (runOpen.length >= maxBaskets) {
      rejected.push({ instId, sector, score: scoreOf(c), reason: `篮子上限 ${maxBaskets} 已满` });
      continue;
    }
    if (sectorsInUse.has(sector)) {
      rejected.push({ instId, sector, score: scoreOf(c), reason: `板块去重：${sector} 已有篮子` });
      continue;
    }
    const plan = planBasket({
      equity: eq, atrPct, price, instrument, policy: p, openBaskets: runOpen, sector, score: scoreOf(c),
      side: c.side || (Array.isArray(c.allowDirections) && c.allowDirections.length === 1 ? c.allowDirections[0] : 'long'),
    });
    if (!plan.ok) {
      rejected.push({ instId, sector, score: scoreOf(c), reason: plan.reason, detail: plan.detail, warnings: plan.warnings });
      continue;
    }
    allocations.push({
      instId, sector, score: scoreOf(c), side: c.side || 'long', price,
      ...plan,
    });
    sectorsInUse.add(sector);
    runOpen.push({ instId, sector, levels: plan.schedule.filter((s) => s.contracts > 0).map((s) => ({ contracts: s.contracts, price: s.addPx, marginUsd: s.marginUsd })) });
  }

  const marginUsd = round(allocations.reduce((a, x) => a + x.totalMarginUsd, 0), 6);
  const existingMarginUsd = sumOpenMargin(open);
  const worstLossUsd = round(allocations.reduce((a, x) => a + x.riskAtDeathUsd, 0), 6);
  const capUsd = round(eq * pctToFrac(p.maxTotalOccupancyPct), 6);
  const totals = {
    buckets: allocations.length,
    openBaskets: open.length,
    marginUsd,
    existingMarginUsd,
    marginIncludingOpenUsd: round(existingMarginUsd + marginUsd, 6),
    occupancyPct: round(((existingMarginUsd + marginUsd) / eq) * 100, 4),
    occupancyCapUsd: capUsd,
    occupancyCapPct: p.maxTotalOccupancyPct,
    notionalUsd: round(allocations.reduce((a, x) => a + x.totalNotionalUsd, 0), 6),
    worstLossUsd,
    worstLossPctEquity: round((worstLossUsd / eq) * 100, 4),
  };
  return { ok: true, sizingMode: p.sizingMode, equity: eq, allocations, rejected, totals };
}

/* ── 权益变化后的再平衡建议（只建议，不自动改仓） ── */

/**
 * @param {object} state 存盘状态（只用 state.baskets）
 * @param {object} o { equity, policy, marks?: { instId: { price, atrPct } } }
 * @returns {object} { ok, hints:[{instId, basketId, action, currentNotionalUsd, targetNotionalUsd, ratio, reason}], note }
 */
function rebalanceHint(state, { equity, policy, marks } = {}) {
  const p = normMarginPolicy(policy);
  const eq = Number(equity);
  const baskets = (state && Array.isArray(state.baskets) ? state.baskets : []).filter((b) => b && !b.closed);
  const hints = [];
  if (!(eq > 0)) return { ok: false, reason: '权益必须为正数', hints, note: '只给建议，不自动改仓' };
  for (const b of baskets) {
    const mk = (marks && marks[b.instId]) || {};
    const price = Number(mk.price) || martin.avgPrice(b);
    const atrPct = Number(mk.atrPct) || (Number(b.atrAtOpen) && price > 0 ? (Number(b.atrAtOpen) / price) * 100 : null);
    if (!(price > 0) || !(atrPct > 0)) {
      hints.push({ instId: b.instId, basketId: b.id || null, action: 'unknown', reason: '缺少该篮当前价/ATR，无法重算（可传 marks）', currentNotionalUsd: null, targetNotionalUsd: null, ratio: null });
      continue;
    }
    const currentContracts = martin.totalContracts(b);
    const currentNotionalUsd = round(Number(b.ctVal) * currentContracts * price, 8);
    const others = baskets.filter((x) => x !== b);
    const plan = planBasket({
      equity: eq, atrPct, price, instrument: { ctVal: b.ctVal, lotSz: b.lotSz, minSz: b.minSz, maxLever: b.maxLever },
      policy: p, openBaskets: others, sector: b.sector, side: b.side,
    });
    if (!plan.ok) {
      hints.push({ instId: b.instId, basketId: b.id || null, action: 'review', reason: `按当前权益规划失败：${plan.reason}`, currentNotionalUsd, targetNotionalUsd: null, ratio: null });
      continue;
    }
    const targetNotionalUsd = plan.totalNotionalUsd;
    const ratio = currentNotionalUsd > 0 ? round(targetNotionalUsd / currentNotionalUsd, 4) : null;
    let action = 'hold', reason = '与风险预算一致（±25% 内），无需动作';
    if (ratio !== null && ratio > 1.25) { action = 'scale_up'; reason = `权益/波动变化后预算允许更大仓位：目标名义 ${targetNotionalUsd}U ≈ 当前 ${currentNotionalUsd}U 的 ${ratio} 倍`; }
    else if (ratio !== null && ratio < 0.8) { action = 'scale_down'; reason = `当前名义超出预算：目标 ${targetNotionalUsd}U ≈ 当前 ${currentNotionalUsd}U 的 ${ratio} 倍（建议在下一层/反弹时缩）`; }
    else if (ratio === null) { action = 'review'; reason = '当前名义为 0，无法比较'; }
    hints.push({ instId: b.instId, basketId: b.id || null, action, reason, currentNotionalUsd, targetNotionalUsd, ratio, targetMarginUsd: plan.totalMarginUsd, currentMarginUsd: round(martin.totalMargin(b), 6), targetRiskAtDeathUsd: plan.riskAtDeathUsd });
  }
  return { ok: true, equity: eq, hints, note: '只给建议，不自动改仓（避免与执行层耦合）' };
}

module.exports = {
  MARGIN_DEFAULTS,
  normMarginPolicy,
  validateMarginPolicy,
  // 纯函数（自检直接断言）
  layerGeometry,
  deathDistance,
  solveFirstNotional,
  levelPrices,
  riskAtDeath,
  minLegalContracts,
  sumOpenMargin,
  // 主入口
  planBasket,
  allocate,
  rebalanceHint,
};
