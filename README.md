# 威廉机器人 1 号 · 类马丁篮子引擎（wb-core）

> OKX **类马丁篮子**交易引擎 + 回测/优化框架。**默认 dry-run**，只有显式 `LIVE=1` 才真实发单。
> ⚠️ **仅供研究与教育用途，不构成投资建议；实盘风险自负。**

**William Bot 1 (wb-core)** — a martingale-basket trading engine and backtest toolkit for OKX. **Dry-run by default**; real orders only with `LIVE=1`. Research and education only — not investment advice.

[中文](#中文) · [English](#english) · [水印清单](WATERMARK.md) · [接口契约](design/MARTIN-BOT-SPEC.md)

---

## 水印 / Watermark

核心代码（引擎 `modules/`、面板 `public/`、回测脚本 `scripts/`）已植入**可追溯水印**：

```js
/*! modules/martin.js - william-bot-1-core key engine logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-1CE3653B
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
```

水印用于**溯源**，不是防拷贝；**移除水印即违反许可**。全量清单见 [WATERMARK.md](WATERMARK.md)。

## 中文

### 是什么

一个零依赖（Node，无 `node_modules`）的 OKX 类马丁**篮子**机器人：以「篮子」为单位加仓、止盈、止损，带风控闸门、状态落盘、调度与回测。

- **默认安全**：不设 `LIVE=1` 只做 dry-run（预览，不发单）。
- **密钥不外泄**：OKX 密钥只来自环境变量 / 服务器 `config.toml`，**不写入代码、不进前端、不进日志**。
- **回测=纯模拟**：历史回放不碰交易所。

### 快速开始

```bash
node server.js              # 默认 dry-run
LIVE=1 node server.js       # 实盘（真实发单，谨慎）
PORT=3100 node server.js    # 端口（默认 3100）
```

打开 <http://127.0.0.1:3100/>

### 模块地图

| 路径 | 职责 |
|---|---|
| `modules/martin.js` | 篮子状态机（加仓 / 止盈 / 止损 / 事件） |
| `modules/risk.js` | 风控闸门（同向预算、回撤熔断、冷却、去重） |
| `modules/store.js` | 状态落盘（环形日志 / 原子写） |
| `modules/scheduler.js` | 调度与日结 |
| `modules/okx-data.js` / `okx-trade.js` | OKX 取数（只读）/ 下单（签名，默认 dry-run） |
| `modules/arb.js` / `margin.js` / `universe.js` / `verify.js` | 套利扫描 / 智能保证金 / 选品 / 验算 |
| `scripts/martin-*.js` | 回测、参数扫描、盈利优化 |
| `public/` | 面板 UI（`martin.html` 等） |
| `design/` | 接口契约与策略设计 |

### 设计文档

- [design/MARTIN-BOT-SPEC.md](design/MARTIN-BOT-SPEC.md) — 接口契约（铁律 / 文件归属 / 接口 / 验收）
- [design/马丁策略设计.md](design/马丁策略设计.md) — 选品口径、马丁政策表、风控闸门
- [design/项目介绍-v3.0.md](design/项目介绍-v3.0.md)

## English

A zero-dependency Node framework for a martingale **basket** trading engine on OKX: per-basket add / take-profit / stop-loss, risk gates, atomic state, a scheduler and a backtest toolkit.

- **Safe by default** — dry-run unless `LIVE=1` is set.
- **No secrets in code** — OKX keys come from env / a server-side `config.toml` only.
- **Backtests are pure simulation.**

See `design/MARTIN-BOT-SPEC.md` for the interface contract and `WATERMARK.md` for the watermark registry.

## 免责声明 / Disclaimer

本项目仅供学习、研究与技术交流，**不构成任何投资建议**。加密货币交易风险极高，任何实盘操作及其后果由使用者自行承担。内置策略为研究记录。

## License

**PolyForm Noncommercial License 1.0.0** — source-available, **not** OSI open source. Non-commercial use only. See [LICENSE](LICENSE).
