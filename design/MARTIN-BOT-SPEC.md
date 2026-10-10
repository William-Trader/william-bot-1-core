# 类马丁全自动机器人 · 开发契约（v1）

> 项目：`/opt/wb-core`（101 服务器）· 本地副本 `~/openclaw资产库/william-bot-1-core/`
> 依据：`design/马丁策略设计.md`（选品口径、状态判定、马丁政策、风控闸门）
> 允许参考 GitHub 的策略实现与 UI 设计，但**参数与口径以本文件为准**。

## 0. 铁律（不可协商）

1. **默认 dry-run**：任何下单路径未显式 `LIVE=1` 时**不得发出真实订单**。
2. **无未来函数**：状态/信号判定只用 `i-1` 及更早的收盘数据。
3. **回测成本 8bps 双边**，含资金费率成本。
4. **期望值为负就如实报告**（我们 440 天真实数据里马丁族期望为负，不要为了"能上线"调参粉饰）。
5. 密钥只在 `/root/.okx/config.toml`，不进前端、不进日志。
6. 现有两模块（`okx-data` / `okx-trade`）与 `/api/*` 既有接口**不得破坏**。

## 1. 模块划分与文件归属

| 文件 | 负责方 | 说明 |
|---|---|---|
| `modules/universe.js` | ✅ 已完成 | 全市场选品（回归性/波动率/流动性） |
| `modules/martin.js` | **A** | 篮子状态机（开仓/逐层加仓/止盈/止损/时间止损） |
| `modules/risk.js` | **A** | 风控闸门（日亏熔断/篮子上限/板块去重/费率闸门/黑天鹅） |
| `modules/store.js` | **A** | 篮子与账户状态落盘（原子写 `data/state.json`） |
| `scripts/martin-backtest.js` | **A** | ≥180 天真实 K 线回测（8bps、无未来函数） |
| `scripts/martin-selftest.mjs` | **A** | 纯函数自检（张数换算/间距/止盈止损/爆仓价/闸门/回测不变量） |
| `modules/scheduler.js` | **B** | 定时：选品刷新 + 篮子巡检（调用 A 的接口） |
| `public/martin.html` | **B** | 马丁面板（候选池/篮子/收益/日志） |
| `server.js` 增量路由 | **B** | 只**追加**路由，不修改既有路由语义 |
| systemd 单元 | **B** | `wb-core-scheduler.service`（+ 既有 `william-bot-1`） |

## 2. A 的接口契约（B 按此对接）

### 2.1 策略参数（policy）

```js
{
  firstMarginPct: 1,        // 首单保证金占权益 %
  leverage: 3,              // 杠杆
  marginMode: 'isolated',   // 逐仓（默认）
  spacingMode: 'atr',       // atr | pct
  spacingAtrMult: 1.0,      // 加仓间距 = ATR × 该倍数
  spacingPct: 0.8,          // pct 模式下的间距 %
  multiplier: 1.5,          // 加仓倍数
  maxLevels: 6,             // 最大层数
  takeProfitPct: 0.8,       // 整篮止盈（相对均价 %）
  hardStopPct: 4,           // 整篮硬止损（占权益 %）
  timeStopHours: 48,
  cooldownHours: 4,
  maxBaskets: 3,
  dailyLossPct: 6,          // 日亏熔断
  maxFundingAbs: 0.001      // 开仓时 |费率| 上限
}
```

### 2.2 篮子（basket）结构（可 JSON 序列化）

```js
{
  id, instId, side: 'long'|'short', sector, openedAt, regimeAtOpen,
  policy, ctVal, lotSz, minSz, maxLever,
  levels: [{ idx, ts, price, contracts, marginUsd, reason: 'entry'|'add'|'re-entry' }],
  closed: false, closedAt: null, closeReason: null,
  realizedPnl: 0
}
```

### 2.3 A 导出的函数（B 直接调用）

```js
martin.sizeForMargin({ marginUsd, leverage, price, ctVal, lotSz, minSz }) -> contracts
martin.nextAddPrice(basket, atr)       -> number|null      // null=已满层
martin.basketPnl(basket, price)        -> { avgPx, contracts, notionalUsd, marginUsd, upl, uplPct }
martin.liquidationPrice(basket, mmr)   -> number|null      // 逐仓估算
martin.shouldOpen({ policy, regime, funding, atrPct, equity, openBaskets, sector, todayPnlPct }) 
                                       -> { ok, side?, reason }
martin.onPrice(basket, { price, atr, regime, ts }) -> { events: [{type:'add'|'take_profit'|'stop_loss'|'time_stop'|'trend_flip', ...}], basket }
martin.newBasket({ instId, side, sector, price, atr, policy, instrument, equity }) -> basket
risk.gate({ state, policy, equity, todayPnlPct, funding, sector, openBaskets }) -> { allow, reason }
store.load() / store.save(state)       -> 原子写（tmp + rename）
```

**事件语义**（B 只负责展示与转发，不自己判策略）：
`add` 加仓成交 · `take_profit` 整篮止盈平仓 · `stop_loss` 硬止损平仓 · `time_stop` 超时平仓 · `trend_flip` 趋势反转离场（平仓）

### 2.4 回测输出（`data/backtest-martin-YYYYMMDD.json`）

```js
{
  ok, symbols: [...], days, bars, feeBps: 8, fundingIncluded: true,
  trades: [{ instId, side, openedAt, closedAt, levels, maxLevels, pnlUsd, pnlPct, reason, hours }],
  summary: { trades, winRate, expectancyUsd, expectancyPct, profitFactor, maxDrawdownPct,
             avgLevelsUsed, level6Rate, stopLossCount, timeStopCount, totalFeesUsd, totalFundingUsd },
  perSymbol: [{ instId, trades, winRate, expectancyPct, maxLevels, maxDDPct }],
  verdict: { positiveExpectancy: bool, meetsGate: bool, note }
}
```
判定门槛：**期望值 > 0 且 最大回撤 < 25%** 才 `meetsGate: true`。

## 3. B 的接口契约（面板与调度）

### 3.1 追加的 HTTP 路由（不改既有）

| 方法 | 路径 | 返回 |
|---|---|---|
| GET | `/api/martin/candidates` | 最近一次选品结果（含 metrics/regime/允许方向/评分） |
| GET | `/api/martin/baskets` | 当前篮子（含逐层明细、均价、浮盈、下一加仓价、止盈/止损价） |
| GET | `/api/martin/policy` / POST 同路径 | 读/写策略参数（持久化 `data/policy.json`） |
| GET | `/api/martin/state` | 汇总：模式(dry-run/live)、今日盈亏、熔断状态、调度器心跳 |
| GET | `/api/martin/backtest` | 最近一次回测 summary + verdict |
| POST | `/api/martin/run-backtest` | 触发回测（后台跑，返回 jobId） |
| POST | `/api/martin/close/:id` | dry-run 下只返回预览 |
| POST | `/api/martin/pause` / `resume` | 暂停/恢复调度（不影响既有服务） |

### 3.2 面板（`public/martin.html`）

四个区块，中文，深色，与现有面板同风格：
1. **候选池**：表格（品种/板块/现价/成交额/ATR%/VR5/ρ₁/回归频率/ADX/状态/**允许方向**/总分）+ 「开篮」按钮（dry-run 时禁用并提示）。
2. **篮子**：卡片式，每篮子显示 层数进度条 / 均价 / 张数 / 保证金占用 / 浮盈 / 下一加仓价 / 止盈价 / 止损价 / 爆仓价。
3. **收益**：资金曲线（本地记录）+ 今日盈亏 + 熔断状态。
4. **日志**：调度器与篮子事件时间线。
顶部状态条：**模式（dry-run/实盘）**、调度器心跳、候选池更新时间、篮子数。

### 3.3 调度节奏

| 任务 | 间隔 | 说明 |
|---|---|---|
| 选品刷新 | 5 分钟 | 调 `universe.screen()`，结果缓存到 `data/candidates.json` |
| 篮子巡检 | 30 秒 | 拉最新价 + ATR，调 `martin.onPrice()`，落盘状态，记录事件 |
| 日结 | 每日 00:05 | 结算当日盈亏、重置熔断（需人工确认解除） |

## 4. 交付与验收

- 双方各自 `node --check` 全绿；A 出 `martin-selftest.mjs` exit 0 与回测结果；B 出 `martin.html` 真机截图。
- A 不得修改 `public/`、`server.js`；B 不得修改 `modules/martin.js|risk.js|store.js`、`scripts/martin-*.js`。
- 集成由主控（我）在 101 上完成：跑回测 → 起调度 → 开 dry-run 篮子 → 验收面板。
- **未过回测门槛不得开启 `LIVE=1`**。
