/*!
 * modules/policy-schema.js - william-bot-1-core key engine logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-53A29BCF
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
/**
 * 策略参数模式（单一事实来源）
 * 用途：给面板生成设置表单、给保存接口做边界校验、给预设提供模板
 * 说明：字段与 modules/martin.js 的 DEFAULT_POLICY 一一对应；改这里即可全场生效。
 */

const FIELDS = [
  /* ── 仓位 ── */
  { key: 'firstMarginPct', group: '仓位', label: '首单保证金', unit: '% 权益', type: 'number', min: 0.1, max: 20, step: 0.1, danger: 5, hint: '首层占账户权益的百分比。本金小的时候 1% 就是最小可用单。' },
  { key: 'leverage', group: '仓位', label: '杠杆', unit: 'x', type: 'number', min: 1, max: 20, step: 1, danger: 10, hint: '越高爆仓越近。逐仓下只影响本篮子。' },
  { key: 'marginMode', group: '仓位', label: '保证金模式', type: 'enum', options: ['isolated', 'cross'], hint: '逐仓=单篮子风险隔离（强烈建议）；全仓会把风险传导到全账户。' },
  { key: 'maxBaskets', group: '仓位', label: '最大同时篮子', unit: '个', type: 'number', min: 1, max: 5, step: 1, danger: 3, hint: '同时持有的篮子数。篮子越多，满层时占用权益越大。' },

  /* ── 加仓 ── */
  /* ── 保证金（智能保证金引擎，2026-09-21 合并） ── */
  { key: 'sizingMode', group: '保证金', label: '仓位口径', type: 'enum', options: ['risk', 'fixed'], hint: 'risk=按「死亡线风险预算」反解首层名义（推荐）；fixed=旧口径（首单保证金 %）。' },
  { key: 'basketRiskBudgetPct', group: '保证金', label: '每篮风险预算', unit: '% 权益', type: 'number', min: 0.2, max: 8, step: 0.1, danger: 4, hint: '单篮在死亡线被止损时的亏损预算。× 最大篮子数必须 ≤12%。' },
  { key: 'maxTotalOccupancyPct', group: '保证金', label: '全场占用上限', unit: '% 权益', type: 'number', min: 5, max: 60, step: 1, danger: 45, hint: '所有篮子保证金占用之和的上限；超出则缩量或拒开（而不是硬开）。' },
  { key: 'riskK', group: '保证金', label: '反解系数 k', unit: '（在分母）', type: 'number', min: 0.3, max: 3, step: 0.05, hint: '在分母：k<1 会放大名义（0.75 ⇒ 死亡线亏损≈预算×1.333）；要「不超预算」应 ≥1。' },

  { key: 'multiplier', group: '加仓', label: '加仓倍数', unit: 'x', type: 'number', min: 1.0, max: 2.5, step: 0.1, danger: 2.0, hint: '每层保证金 = 上一层 × 该倍数。>2.0 时层数必须 ≤4（下方会校验）。' },
  { key: 'maxLevels', group: '加仓', label: '最大层数', unit: '层', type: 'number', min: 1, max: 10, step: 1, danger: 8, hint: '加满后只等止盈/止损，不再加仓。' },
  { key: 'spacingMode', group: '加仓', label: '间距模式', type: 'enum', options: ['atr', 'pct'], hint: 'atr=按波动自适应（推荐）；pct=固定百分比。' },
  { key: 'spacingAtrMult', group: '加仓', label: 'ATR 间距倍数', unit: '×ATR', type: 'number', min: 0.3, max: 3, step: 0.1, hint: '间距 = ATR(14) × 该值。太小=频繁加仓，太大=加不上。' },
  { key: 'spacingPct', group: '加仓', label: '百分比间距', unit: '%', type: 'number', min: 0.2, max: 5, step: 0.1, hint: '仅当间距模式为 pct 时生效。' },

  /* ── 止盈止损 ── */
  { key: 'takeProfitPct', group: '止盈止损', label: '整篮止盈', unit: '%', type: 'number', min: 0, max: 5, step: 0.1, hint: '整篮均价浮盈达到该值即全平。这是马丁的主要利润来源。设为 0 = 改用「盈利能力」组的波动缩放止盈（tpAtrMult）。' },
  { key: 'hardStopPct', group: '止盈止损', label: '硬止损', unit: '% 权益', type: 'number', min: 0.5, max: 20, step: 0.5, hint: '整篮浮亏达到该值直接砍仓。⚠️ 这是唯一的保命闸门，别关。' },
  { key: 'stopMode', group: '止盈止损', label: '止损口径', type: 'enum', options: ['atr', 'equity'], hint: 'atr=按价格空间（ATR 死亡线，任何层数都可达，推荐）；equity=按占权益金额（旧口径，浅篮子会变成"无止损"）。' },
  { key: 'deathAtrMult', group: '止盈止损', label: '死亡线倍数', unit: '×ATR', type: 'number', min: 2, max: 12, step: 0.5, danger: 9, hint: '止损距离 = 该值 × ATR%（相对整篮均价）。越大越能扛回撤、单次亏得越多；该值 × ATR% 必须小于 1/杠杆。' },
  { key: 'maxBasketRiskPct', group: '止盈止损', label: '整篮风险兜底', unit: '% 权益', type: 'number', min: 0.5, max: 15, step: 0.5, hint: '整篮浮亏达到该值立即平仓（金额口径，任何层数都可达，兜住浅篮子）。' },
  { key: 'timeStopHours', group: '止盈止损', label: '时间止损', unit: '小时', type: 'number', min: 1, max: 168, step: 1, hint: '超时未止盈则平仓，释放保证金。' },
  { key: 'cooldownHours', group: '止盈止损', label: '品种冷却', unit: '小时', type: 'number', min: 0, max: 48, step: 1, hint: '某品种止损后多久不再开它。' },

  /* ── 风控 ── */
  { key: 'dailyLossPct', group: '风控', label: '日亏熔断', unit: '% 权益', type: 'number', min: 1, max: 20, step: 0.5, hint: '当日亏损达到该值→停止开新篮子（人工解除）。' },
  { key: 'maxFundingAbs', group: '风控', label: '费率闸门', unit: '绝对值', type: 'number', min: 0, max: 0.005, step: 0.0001, hint: '资金费率绝对值超过该值就不开新仓（0.001 = 0.10%）。' },
  { key: 'blackSwanPct', group: '风控', label: '黑天鹅闸门', unit: '% 单根', type: 'number', min: 1, max: 20, step: 1, hint: '单根 K 线跌幅超过该值时不加仓（先看是不是基本面事件）。' },
  { key: 'mmr', group: '风控', label: '维持保证金率', unit: '小数', type: 'number', min: 0.001, max: 0.02, step: 0.001, hint: '用于估算爆仓价（分层档位会略有差异，属估算）。' },

  /* ── 选品过滤 ── */
  { key: 'minAtrPct', group: '选品过滤', label: '最小 ATR%', unit: '%', type: 'number', min: 0, max: 3, step: 0.1, hint: '波动太小赚不够手续费，直接不开。' },
  { key: 'maxAtrPct', group: '选品过滤', label: '最大 ATR%', unit: '%', type: 'number', min: 2, max: 20, step: 0.5, hint: '波动太大容易被插针打穿。' },

  /* ── regime 选品过滤（2026-09-22 追加；默认全关 = 旧行为） ── */
  { key: 'entryVr5Max', group: '选品过滤', label: '入场 vr5 上限', unit: '(0=关)', type: 'number', min: 0, max: 2, step: 0.05, hint: '方差比 vr5（<1 均值回归）。只做「vr5 < 该值」的首单（做空波动率）。0 = 关。指标缺失时不拦。' },
  { key: 'entryAdxMax', group: '选品过滤', label: '入场 ADX 上限', unit: '(0=关)', type: 'number', min: 0, max: 60, step: 1, hint: 'ADX(14) 低于该值才开首单（弱趋势/震荡）。0 = 关。' },
  { key: 'entryRfMin', group: '选品过滤', label: '入场 rf 下限', unit: '(0=关)', type: 'number', min: 0, max: 1, step: 0.05, hint: '回归频率 rf 高于该值才开首单（爱回归的品种/时段）。0 = 关。' },
  { key: 'entrySkipTrend', group: '选品过滤', label: '只做震荡', type: 'enum', options: ['off', 'on'], hint: 'on = 只在 range 状态开首单（trend_up/trend_down/unclear 跳过）。默认 off。' },
  { key: 'entryAtrPctMax', group: '选品过滤', label: '入场 ATR% 上限', unit: '(0=关)', type: 'number', min: 0, max: 8, step: 0.5, hint: '当根 ATR% 超过该值不开首单（避开刚放量/高波动入场）。0 = 关。' },

  /* ── 信号逆转（2026-09-22 追加；默认 now = 旧行为） ── */
  { key: 'trendFlipMode', group: '止盈止损', label: '趋势反转处理', type: 'enum', options: ['now', 'confirm', 'half'], hint: 'now = 反向确认即刻平篮（旧行为）；confirm = 连续 N 根才平；half = 先减仓一半保留止损、再持续 N 根平剩余。' },
  { key: 'trendFlipConfirmBars', group: '止盈止损', label: '反转确认根数', unit: '根', type: 'number', min: 2, max: 6, step: 1, hint: 'confirm/half 模式下的确认根数（按 1H bar 去重计数）。' },
  { key: 'trendFlipReducePct', group: '止盈止损', label: '反转减仓比例', unit: '%', type: 'number', min: 10, max: 90, step: 5, hint: 'half 模式首次反向时减掉的张数比例。' },

  /* ── 降止损率（2026-09-22 追加；默认关 = 旧行为） ── */
  { key: 'layeredStopEnabled', group: '止盈止损', label: '分层止损', type: 'enum', options: ['off', 'on'], hint: 'on = 深篮（层数 ≥ 阈值）用更紧的死亡线倍数收紧尾部风险；浅篮不变。' },
  { key: 'layeredStopFromLevel', group: '止盈止损', label: '收紧起始层', unit: '层', type: 'number', min: 2, max: 6, step: 1, hint: '从第几层开始收紧死亡线（仅分层止损开启时生效）。' },
  { key: 'layeredStopAtrMult', group: '止盈止损', label: '深篮死亡线', unit: '×ATR', type: 'number', min: 1, max: 12, step: 0.5, hint: '深篮用的死亡线倍数（只在比原死亡线更紧时生效，不会放宽止损）。' },
  { key: 'partialTpEnabled', group: '止盈止损', label: '部分止盈', type: 'enum', options: ['off', 'on'], hint: 'on = 浮盈达阈值先平掉一部分降低暴露，剩余继续持有（不改止盈价/止损位）。' },
  { key: 'partialTpAtPct', group: '止盈止损', label: '部分止盈阈值', unit: '%', type: 'number', min: 0.1, max: 3, step: 0.05, hint: '相对均价的浮盈达到该值触发部分止盈。' },
  { key: 'partialTpFracPct', group: '止盈止损', label: '部分止盈比例', unit: '%', type: 'number', min: 10, max: 90, step: 5, hint: '一次平掉的张数比例。' },

  /* ── 盈利能力（2026-09-21 追加；以下默认值均等于「不生效」→ 与旧版行为一致） ── */
  { key: 'entryZMin', group: '盈利能力', label: '入场 z 门槛', unit: '|z|', type: 'number', min: 0, max: 3, step: 0.1, hint: '价格偏离均线 |z| 达到该值才开首单（0 = 关，状态允许就开）。只作用于开首单，加仓不受影响。' },
  { key: 'entryZWin', group: '盈利能力', label: 'z 计算窗口', unit: '根', type: 'number', min: 10, max: 200, step: 5, hint: 'z-score 的 SMA/stdev 窗口（1H 根），只用已收盘数据。' },
  { key: 'entryZMode', group: '盈利能力', label: 'z 方向口径', type: 'enum', options: ['revert', 'filter'], hint: 'revert = 方向取回归方向（偏离上轨做空/下轨做多）；filter = 只做与状态方向一致的偏离（回测实测占优）。' },
  { key: 'tpAtrMult', group: '盈利能力', label: '波动止盈倍数', unit: '×ATR%', type: 'number', min: 0, max: 2, step: 0.05, hint: '止盈 = clamp(该值 × ATR%, 下限, 上限)；仅当「整篮止盈」= 0 时生效（默认 0.8 固定口径不变）。' },
  { key: 'tpMinPct', group: '盈利能力', label: '波动止盈下限', unit: '%', type: 'number', min: 0.1, max: 2, step: 0.05, hint: 'ATR 缩放的止盈下限（低波动时不会止盈太小）。' },
  { key: 'tpMaxPct', group: '盈利能力', label: '波动止盈上限', unit: '%', type: 'number', min: 0.2, max: 5, step: 0.1, hint: 'ATR 缩放的止盈上限（高波动时不贪）。' },
  { key: 'makerFirst', group: '盈利能力', label: 'maker 优先', type: 'enum', options: ['off', 'on'], hint: 'on = 入场/加仓先挂 post_only 限价（吃低费率），超时转市价；止盈止损仍市价。默认 off = 旧行为。' },
  { key: 'makerTimeoutBars', group: '盈利能力', label: 'maker 超时', unit: '根', type: 'number', min: 0, max: 6, step: 1, hint: '挂单多少根 K 未成交就转市价；0 = 不转（只在 makerFirst=on 时生效）。' },
  /* ── 止盈执行（2026-09-21 追加；纯追加，默认 market = 旧行为） ── */
  { key: 'tpOrderType', group: '盈利能力', label: '止盈挂单方式', type: 'enum', options: ['market', 'limit'], hint: 'market = 止盈市价平仓（taker，旧行为）；limit = 止盈挂 post_only 限价（maker 费率，省手续费，但不保证成交）。止损/爆仓/时间止损始终市价。' },
];

const PRESETS = {
  '盈利优化(实盘口径)': {
    /* 第三轮扫描结论：在 sizingMode=risk 口径下，降层几何 G（1.5/6层 G=20.78 → 2.0/4层 G=15）
     * + 间距 ATR×0.8，单笔期望 1.93→3.57bps、回撤 −16.35%→−12.51%、PF 1.86→1.97（详见 data/profit-opt-report2-*.md）
     * ⚠ risk 模式下真正的仓位来自 basketRiskBudgetPct，firstMarginPct 仅作为 fixed 回退值 */
    firstMarginPct: 0.5, leverage: 3, marginMode: 'isolated', maxBaskets: 2,
    multiplier: 2.0, maxLevels: 4, spacingMode: 'atr', spacingAtrMult: 0.8, spacingPct: 0.8,
    takeProfitPct: 0.8, hardStopPct: 3, timeStopHours: 48, cooldownHours: 4, blackSwanPct: 5,
    sizingMode: 'risk', basketRiskBudgetPct: 6, maxTotalOccupancyPct: 45, riskK: 1.2,
    deathAtrMult: 6, maxBasketRiskPct: 3, dailyLossPct: 4,
    minAtrPct: 0.4, maxAtrPct: 8, mmr: 0.005, maxFundingAbs: 0.001,
    entryZMin: 0, entryZWin: 20, entryZMode: 'revert', tpAtrMult: 0.5, tpMinPct: 0.4, tpMaxPct: 2,
    makerFirst: 'off', makerTimeoutBars: 1,
  },
  '盈利优化·放大(需交易所真 5x)': {
    /* ★ 第四轮“最佳赚钱效率”选型（效率 = 期望bps ÷ |回撤%| = 0.826，全场最高）
     * 参数：杠杆 5x · 预算 8%/2篮 · 兜底 2% · 占用上限 45% · 几何 2.0/4层/间距0.8 · 固定止盈 0.8%
     * 实测：期望 7.07bps（线上 1.93）· 回撤 −8.56%（线上 −16.35）· 5折OOS 7.14bps 5/5 · 占用峰值 55.8% · 113U 6.91bps
     * ⚠1 必须先把交易所侧杠杆真正设成 5x（scheduler 未调 setLeverage）
     * ⚠2 预算8%×2篮 = 16% 总风险：服务器规则 ≤20% 可存（本地镜像的 margin.js 仍是旧 12% 规则会报错）
     * ⚠3 代价：只 2 个并发篮子（集中度）· 兜底2% 使止损次数从 39 升到 126 */
    firstMarginPct: 0.5, leverage: 5, marginMode: 'isolated', maxBaskets: 2,
    multiplier: 2.0, maxLevels: 4, spacingMode: 'atr', spacingAtrMult: 0.8, spacingPct: 0.8,
    takeProfitPct: 0.8, hardStopPct: 3, timeStopHours: 48, cooldownHours: 4, blackSwanPct: 5,
    sizingMode: 'risk', basketRiskBudgetPct: 8, maxTotalOccupancyPct: 45, riskK: 1.2,
    deathAtrMult: 6, maxBasketRiskPct: 2, dailyLossPct: 4,
    minAtrPct: 0.4, maxAtrPct: 8, mmr: 0.005, maxFundingAbs: 0.001,
    entryZMin: 0, entryZWin: 20, entryZMode: 'revert', tpAtrMult: 0.5, tpMinPct: 0.4, tpMaxPct: 2,
    makerFirst: 'off', makerTimeoutBars: 1,
  },
  /* ── 2026-09-22 三项优化定稿（选品/趋势过滤 + 信号逆转 + 降止损率）─────────────────────────
   * 全部基于实盘 policy（101 /opt/wb-core）+ 实测成本 fee 10.02bps 往返 / slip 5bps/单边。
   * 实测（350 天 · 8 标的 · $10000 · 5 折 OOS，脚本 scripts/martin-regime-final.js）：
   *   基线 live                ：6768 笔 · 期望 2.17bps · 止损 28(0.414%) · 回撤 -7.28% · OOS 2.1692 5/5
   *   “选品+部分止盈”预设(A+B+C)：5143 笔 · 期望 3.14bps · 止损 16(0.311%) · 回撤 -6.47% · OOS 3.1373 5/5 · 胜率 96.52%
   *   “最少止损”预设(A+B+C)     ：5896 笔 · 期望 3.04bps · 止损 15(0.254%) · 回撤 -7.26% · OOS 3.0321 5/5
   * ⚠ 两个预设只差 vr5 阈值（1.0 vs 1.1）；都含 trendFlipMode='half'（B）、partialTp（C）
   * ⚠ 需要调度器接线（本次未改 scheduler.js）：
   *   1) 开首单前传入 vr5（方差比，用 i-1 及更早 300 根 1H）—— 缺失时该过滤自动不生效（fail-open）；
   *   2) 实现「部分止盈」（浮盈达 0.8% 时 reduceOnly 平掉 50% 张数）与「反转减半」（反向趋势首根平 50%）。
   */
  '选品+部分止盈(A+B+C 推荐)': {
    firstMarginPct: 0.6, leverage: 3, marginMode: 'isolated', maxBaskets: 5,
    spacingMode: 'atr', spacingAtrMult: 1, spacingPct: 0.8,
    multiplier: 1.5, maxLevels: 5, takeProfitPct: 0, hardStopPct: 3,
    timeStopHours: 48, cooldownHours: 4, blackSwanPct: 5, dailyLossPct: 5, maxFundingAbs: 0.001,
    minAtrPct: 0.4, maxAtrPct: 8, mmr: 0.005, stopMode: 'atr', deathAtrMult: 6, maxBasketRiskPct: 3,
    entryZMin: 0, entryZWin: 20, entryZMode: 'revert', tpAtrMult: 0.5, tpMinPct: 0.4, tpMaxPct: 2,
    makerFirst: 'off', makerTimeoutBars: 1, tpOrderType: 'limit',
    sizingMode: 'risk', basketRiskBudgetPct: 4, maxTotalOccupancyPct: 45, riskK: 1.2,
    entryVr5Max: 1.0, entryAdxMax: 0, entryRfMin: 0, entrySkipTrend: 'off', entryAtrPctMax: 0,
    trendFlipMode: 'half', trendFlipConfirmBars: 2, trendFlipReducePct: 50,
    layeredStopEnabled: 'off', layeredStopFromLevel: 3, layeredStopAtrMult: 4,
    partialTpEnabled: 'on', partialTpAtPct: 0.8, partialTpFracPct: 50,
  },
  '选品优化·最少止损(A+B+C)': {
    firstMarginPct: 0.6, leverage: 3, marginMode: 'isolated', maxBaskets: 5,
    spacingMode: 'atr', spacingAtrMult: 1, spacingPct: 0.8,
    multiplier: 1.5, maxLevels: 5, takeProfitPct: 0, hardStopPct: 3,
    timeStopHours: 48, cooldownHours: 4, blackSwanPct: 5, dailyLossPct: 5, maxFundingAbs: 0.001,
    minAtrPct: 0.4, maxAtrPct: 8, mmr: 0.005, stopMode: 'atr', deathAtrMult: 6, maxBasketRiskPct: 3,
    entryZMin: 0, entryZWin: 20, entryZMode: 'revert', tpAtrMult: 0.5, tpMinPct: 0.4, tpMaxPct: 2,
    makerFirst: 'off', makerTimeoutBars: 1, tpOrderType: 'limit',
    sizingMode: 'risk', basketRiskBudgetPct: 4, maxTotalOccupancyPct: 45, riskK: 1.2,
    entryVr5Max: 1.1, entryAdxMax: 0, entryRfMin: 0, entrySkipTrend: 'off', entryAtrPctMax: 0,
    trendFlipMode: 'half', trendFlipConfirmBars: 2, trendFlipReducePct: 50,
    layeredStopEnabled: 'off', layeredStopFromLevel: 3, layeredStopAtrMult: 4,
    partialTpEnabled: 'on', partialTpAtPct: 0.8, partialTpFracPct: 50,
  },
  '实盘小额(当前)': { firstMarginPct: 1, leverage: 3, marginMode: 'isolated', maxBaskets: 1, multiplier: 1.5, maxLevels: 6, spacingMode: 'atr', spacingAtrMult: 1, takeProfitPct: 0.8, hardStopPct: 3, dailyLossPct: 3, timeStopHours: 48, cooldownHours: 4, blackSwanPct: 5 },
  '保守': { firstMarginPct: 0.5, leverage: 2, marginMode: 'isolated', maxBaskets: 1, multiplier: 1.3, maxLevels: 5, spacingMode: 'atr', spacingAtrMult: 1.2, takeProfitPct: 0.6, hardStopPct: 2, dailyLossPct: 2, timeStopHours: 24, cooldownHours: 8, blackSwanPct: 4 },
  '标准': { firstMarginPct: 1, leverage: 3, marginMode: 'isolated', maxBaskets: 2, multiplier: 1.5, maxLevels: 6, spacingMode: 'atr', spacingAtrMult: 1, takeProfitPct: 0.8, hardStopPct: 4, dailyLossPct: 6, timeStopHours: 48, cooldownHours: 4, blackSwanPct: 5 },
  '激进': { firstMarginPct: 2, leverage: 5, marginMode: 'isolated', maxBaskets: 3, multiplier: 2.0, maxLevels: 4, spacingMode: 'pct', spacingPct: 0.8, takeProfitPct: 0.8, hardStopPct: 6, dailyLossPct: 8, timeStopHours: 72, cooldownHours: 2, blackSwanPct: 5 },
};

const byKey = Object.fromEntries(FIELDS.map((f) => [f.key, f]));

/** 校验一批参数：返回 { ok, policy, errors, warnings, clamped } */
function validate(patch = {}, base = {}) {
  const errors = [], warnings = [], clamped = [];
  const out = { ...base };
  for (const [k, raw] of Object.entries(patch)) {
    const f = byKey[k];
    if (!f) { warnings.push(`未知参数 ${k}（已忽略）`); continue; }
    if (f.type === 'enum') {
      if (!f.options.includes(raw)) { errors.push(`${f.label} 只能是 ${f.options.join(' / ')}`); continue; }
      out[k] = raw; continue;
    }
    const v = Number(raw);
    if (!Number.isFinite(v)) { errors.push(`${f.label} 必须是数字`); continue; }
    let x = v;
    if (v < f.min) { x = f.min; clamped.push(`${f.label} 从 ${v} 提到下限 ${f.min}`); }
    if (v > f.max) { x = f.max; clamped.push(`${f.label} 从 ${v} 压到上限 ${f.max}`); }
    out[k] = x;
  }
  // 组合规则
  const m = { ...base, ...out };
  if (Number(m.multiplier) > 2.0 && Number(m.maxLevels) > 4) errors.push('加仓倍数 >2.0 时最大层数必须 ≤4（否则满层保证金会失控）');
  const geo = (() => { let s = 1, t = 1; for (let i = 1; i < Number(m.maxLevels); i++) { t *= Number(m.multiplier); s += t; } return s; })();
  const fullOccupancy = Number(m.firstMarginPct) * geo * Number(m.maxBaskets);
  if (fullOccupancy > 60) errors.push(`满层保证金占用约 ${fullOccupancy.toFixed(1)}% 权益（>60%），太危险：请降首单/倍数/层数/篮子数`);
  else if (fullOccupancy > 35) warnings.push(`满层保证金占用约 ${fullOccupancy.toFixed(1)}% 权益（建议 ≤35%）`);
  if (Number(m.hardStopPct) >= Number(m.dailyLossPct)) warnings.push(`硬止损 ${m.hardStopPct}% ≥ 日亏熔断 ${m.dailyLossPct}%，熔断可能永远触发不了`);
  if (Number(m.spacingMode) === 'pct' && Number(m.spacingPct) >= Number(m.takeProfitPct)) warnings.push('百分比间距 ≥ 止盈幅度：一次加仓就能直接止盈，实际会退化成单层交易');
  if (Number(m.maxAtrPct) <= Number(m.minAtrPct)) errors.push('最大 ATR% 必须大于最小 ATR%');
  if (Number(m.maxBaskets) > 3) warnings.push('同时 >3 个篮子，相关性风险显著上升（同板块会同时爆）');
  return { ok: errors.length === 0, policy: out, errors, warnings, clamped, meta: { fullOccupancyPct: +fullOccupancy.toFixed(1), levels: Number(m.maxLevels), multiplier: Number(m.multiplier) } };
}

module.exports = { FIELDS, PRESETS, byKey, validate };
