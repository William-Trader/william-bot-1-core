/*!
 * scripts/verify-report.js - william-bot-1-core key backtest/optimize logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-572584F5
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
#!/usr/bin/env node
/**
 * scripts/verify-report.js —— 实盘验算报告 CLI（**只读**）
 *
 * 产出：data/verify-YYYYMMDD.json（新文件，不覆盖任何既有文件）+ 终端表格
 *
 * 用法
 *   node scripts/verify-report.js                                   # 本机：读 data/state.json，无 OKX 证据 → 如实标注「数据不足」
 *   node scripts/verify-report.js --okx-snapshot /tmp/okx.json       # 用快照（生产机抓的 fills/bills）
 *   node scripts/verify-report.js --live-okx                         # 直连 OKX（只读 GET；需 /root/.okx/config.toml）
 *   node scripts/verify-report.js --state /opt/wb-core/data/state.json --data /opt/wb-core/data --backtest data/backtest-martin-20260921.json
 *
 * 参数
 *   --state <file>        状态文件（默认 env MARTIN_STATE_PATH 或 <data>/state.json）
 *   --data <dir>          数据目录（默认 env MARTIN_DATA_DIR 或 ./data）
 *   --backtest <file>     回测报告（默认 <data> 下最新 backtest-martin-*.json）
 *   --okx-snapshot <file> OKX 证据快照（{capturedAt,balance,positions,fills,bills}）
 *   --live-okx            直连 OKX 只读接口取证据（与 --okx-snapshot 互斥，snapshot 优先）
 *   --min-trades <n>      样本门槛（默认 20；不足即「结论不可用」）
 *   --no-instrument       不去 OKX 取合约规格（离线）
 *   --proxy <url>         代理（默认 PROXY_URL / config.js 默认值）
 *   --quiet               只落盘，不打印表格
 *
 * 铁律：本脚本不做任何写操作（除了产出自己的 data/verify-*.json），不下单、不改 state、不碰别人的文件。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const verify = require('../modules/verify');

const ROOT = path.join(__dirname, '..');

/* ── 参数 ── */
function parseArgs(argv) {
  const a = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) { a._.push(t); continue; }
    const k = t.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) a[k] = true;
    else { a[k] = next; i++; }
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));
const dataDir = args.data ? path.resolve(String(args.data)) : (process.env.MARTIN_DATA_DIR || path.join(ROOT, 'data'));
const statePath = args.state ? path.resolve(String(args.state)) : (process.env.MARTIN_STATE_PATH || path.join(dataDir, 'state.json'));
const minTrades = args['min-trades'] !== undefined ? Number(args['min-trades']) : verify.MIN_TRADES_DEFAULT;
if (!Number.isFinite(minTrades) || minTrades < 1) { console.error('--min-trades 必须为正整数'); process.exit(2); }
const proxy = args.proxy ? String(args.proxy) : (process.env.PROXY_URL || process.env.HTTPS_PROXY || null);
if (proxy) process.env.PROXY_URL = proxy;

/* ── 终端表格（东亚宽度对齐） ── */
const w = (s) => [...String(s === null || s === undefined ? '--' : s)].reduce((a, ch) => a + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1), 0);
const pad = (s, n) => String(s === null || s === undefined ? '--' : s) + ' '.repeat(Math.max(0, n - w(s)));
const nf = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '--' : Number(v).toFixed(d));
const pct = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '--' : `${Number(v) >= 0 ? '' : ''}${Number(v).toFixed(d)}%`);
function table(cols, rows) {
  const widths = cols.map((c, i) => Math.max(w(c.h), ...rows.map((r) => w(r[i]))));
  const line = (cells) => '  ' + cells.map((c, i) => pad(c, widths[i])).join('  ');
  return [line(cols.map((c) => c.h)), '  ' + widths.map((x) => '─'.repeat(x)).join('  '), ...rows.map(line)].join('\n');
}
const ts2s = (ts) => (ts ? new Date(Number(ts)).toISOString().replace('T', ' ').slice(0, 19) : '--');

async function main() {
  const out = { generatedFor: new Date().toISOString() };

  /* 1) state（只读） */
  const st = verify.readState(statePath);
  if (!st.ok) {
    console.error(`✗ 读不到 state：${st.path}（${st.error}）`);
    process.exit(3);
  }
  const state = st.state || {};

  /* 2) 回测报告（只读，取最新） */
  const bt = verify.readBacktest(dataDir, args.backtest ? path.resolve(String(args.backtest)) : null);

  /* 3) 合约规格 ctVal：state 篮子优先，缺的再走 OKX 公共接口（无密钥） */
  const ctValByInst = verify.ctValFromState(state);
  const evidence = await verify.loadOkxEvidence({
    snapshotPath: args['okx-snapshot'] ? path.resolve(String(args['okx-snapshot'])) : null,
    live: !!args['live-okx'],
    ctValByInst,
  });
  if (!args['no-instrument']) {
    const need = [...new Set([...(evidence.fills || []).map((f) => f.instId), ...((state.baskets || []).concat(state.closed || [])).map((b) => b.instId)])]
      .filter((x) => x && !(Number(ctValByInst[x]) > 0));
    if (need.length) {
      const fetched = await verify.ctValFromOkx(need, { proxy });
      for (const [k, v] of Object.entries(fetched)) if (!(Number(ctValByInst[k]) > 0)) ctValByInst[k] = v;
    }
  }
  // 补齐到成交明细上（bps 换算需要）
  if (evidence.fills) evidence.fills = verify.annotateCtVal(evidence.fills, ctValByInst);

  /* 4) 组装报告（纯函数） */
  const report = verify.buildReport({
    state, backtest: bt.backtest, okx: evidence, now: Date.now(), minTrades,
    meta: {
      statePath: st.path, backtestFile: bt.ok ? path.basename(bt.path) : null, ctValByInst,
      extra: { dataDir, proxy: proxy ? '(已配置)' : '(未配置)', backtestError: bt.ok ? null : bt.error },
    },
  });
  report.source = { kind: 'verify-report', statePath: st.path, dataDir };

  /* 5) 落盘（只写自己的 verify-YYYYMMDD.json） */
  const d = new Date();
  const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  fs.mkdirSync(dataDir, { recursive: true });
  const outPath = path.join(dataDir, `verify-${day}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 1));
  out.path = outPath;

  if (!args.quiet) print(report, outPath);
  process.exit(0);
}

function print(r, outPath) {
  const L = [];
  const S = r.slippage, C = r.costs, LV = r.levels, P = r.pnl, CMP = r.comparison;
  L.push('');
  L.push('══════════ 实盘验算报告（只读） ══════════');
  L.push(`生成时间   ${ts2s(Date.parse(r.generatedAt))}Z`);
  L.push(`state      ${r.meta.statePath}（mode=${r.meta.mode} day=${r.meta.day} savedAt=${r.meta.stateSavedAt || '--'}）`);
  L.push(`OKX 证据   ${r.meta.okxSource}${r.meta.okxCapturedAt ? ' @ ' + r.meta.okxCapturedAt : ''}${Object.keys(r.meta.okxErrors || {}).length ? ' · 错误 ' + JSON.stringify(r.meta.okxErrors) : ''}`);
  L.push(`回测对照   ${r.meta.backtestFile || '(无)'}${r.meta.backtestError ? '（' + r.meta.backtestError + '）' : ''}`);
  L.push(`权益/持仓  ${nf(r.headline.equityUsd, 2)} U · 持仓 ${r.headline.openBaskets} 个 · 已平仓 ${r.headline.closedBaskets} 笔`);
  L.push('');

  /* 样本量 */
  const g = r.headline.sample;
  L.push(`① 样本量声明：${g.note}  →  ${r.headline.conclusion}`);
  L.push('');

  /* 滑点 */
  L.push(`② 成交滑点实测（不利为正；${S.matchNote}）`);
  if (!S.ok) {
    L.push(`   ⚠ 数据不足：${S.reason}`);
  } else {
    const rows = S.rows.map((p) => [ts2s(p.ts), p.instId.replace('-USDT-SWAP', ''), p.kind, p.execSide, nf(p.expectedPx, 6), nf(p.fillPx, 6), nf(p.slipBps, 2), nf(p.notionalUsd, 2), p.fills]);
    L.push(table([
      { h: '时间(UTC)' }, { h: '标的' }, { h: '类型' }, { h: '成交向' }, { h: '信号价' }, { h: '实际成交' }, { h: '滑点bps' }, { h: '名义U' }, { h: '笔数' },
    ], rows));
  }
  const s = S.stats;
  L.push(`   汇总：n=${s.n}（开/加 ${s.nEntry} · 平 ${s.nExit}） 均值 ${nf(s.avgBps, 2)} bps · 中位 ${nf(s.medianBps, 2)} · p90 ${nf(s.p90Bps, 2)} · 名义加权 ${nf(s.notionalWeightedBps, 2)} · 区间 [${nf(s.minBps, 2)}, ${nf(s.maxBps, 2)}] · 往返 ${nf(s.roundTripBps, 2)} bps`);
  if (S.reconcile.stats.n) L.push(`   对账复核（reconcile 事件：引擎计划均价 vs OKX 真实均价）：n=${S.reconcile.stats.n} · 均值 ${nf(S.reconcile.stats.avgBps, 2)} bps`);
  L.push(`   未撮配：引擎事件 ${S.unmatchedEvents.length} 个 · OKX 成交 ${S.unmatchedFills} 笔（历史成交/非本机活动）`);
  L.push('');

  /* 费用 */
  L.push('③ 费用与资金费');
  if (!C.ok) {
    L.push(`   ⚠ 数据不足：${C.reason}`);
  } else {
    if (C.scope) L.push(`   口径范围：本机器人（${C.scope.instIds.map((x) => String(x).replace('-USDT-SWAP', '')).join(',') || '--'}）${C.scope.from ? ' 从 ' + C.scope.from.slice(0, 16) : ''}`);
    if (C.feeByInstId.length) L.push(table([
      { h: '标的' }, { h: '成交笔' }, { h: '手续费U' }, { h: '名义U' }, { h: '单边bps' },
    ], C.feeByInstId.map((x) => [x.instId.replace('-USDT-SWAP', ''), x.fills, nf(x.feeUsd, 6), nf(x.notionalUsd, 2), nf(x.avgBps, 3)])));
    L.push(`   手续费合计 ${nf(C.feeUsd, 6)} U（OKX fee 负=支出）· 单边均值 ${nf(C.feeSideBps, 3)} bps · 往返 ${nf(C.roundTripFeeBps, 3)} bps${C.feeMissingCtVal ? ` · ${C.feeMissingCtVal} 笔缺 ctVal 未计入 bps` : ''}`);
    if (C.accountWide && (C.accountWide.feeFills > C.feeFills || C.accountWide.fundingEntries > C.fundingEntries)) {
      L.push(`   全账户（含非本机器人活动）：手续费 ${nf(C.accountWide.feeUsd, 6)} U / ${C.accountWide.feeFills} 笔 · 资金费 ${nf(C.accountWide.fundingUsd, 6)} U / ${C.accountWide.fundingEntries} 条 → 不能用全账户口径替代`);
    }
    if (C.fundingEntries) L.push(`   资金费：${C.fundingEntries} 条 · 合计 ${nf(C.fundingUsd, 6)} U（负=支出）· 窗口 ${C.fundingWindow ? C.fundingWindow.from.slice(0, 16) + ' → ' + C.fundingWindow.to.slice(0, 16) : '--'}`);
    else L.push('   资金费：本机器人范围内无 type=8 账单');
  }
  L.push('');

  /* 层数 */
  L.push('④ 层数分布');
  if (!LV.ok) L.push(`   ⚠ 数据不足：${LV.reason}`);
  else {
    const dist = Object.entries(LV.closed.distribution).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `${k}层×${v}`).join(' · ');
    L.push(`   已平仓 ${LV.closed.n} 笔：平均 ${nf(LV.closed.avgLevels, 2)} 层 · 满层率 ${pct(LV.closed.fullLevelRate)} · 最深 ${LV.closed.maxLevelsSeen} 层 · 分布 ${dist}`);
    L.push(`   平均持仓 ${nf(LV.closed.avgHours, 2)}h（中位 ${nf(LV.closed.medianHours, 2)}h · 最长 ${nf(LV.closed.maxHours, 2)}h）`);
  }
  const LO = LV.open;
  if (LO && LO.n) {
    const dist = Object.entries(LO.distribution).sort((a, b) => Number(a[0]) - Number(b[0])).map(([k, v]) => `${k}层×${v}`).join(' · ');
    L.push(`   当前持仓 ${LO.n} 个：平均 ${nf(LO.avgLevels, 2)} 层 · 分布 ${dist} · 已持 ${nf(LO.avgHours, 2)}h`);
  }
  L.push('');

  /* 盈亏 */
  L.push('⑤ 盈亏结构');
  if (!P.ok) L.push(`   ⚠ 数据不足：${P.reason}`);
  else {
    L.push(`   笔数 ${P.trades} · 胜率 ${pct(P.winRate)} · 单笔期望 ${nf(P.expectancyUsd, 4)} U (${nf(P.expectancyPermille, 3)}‰ 权益) · PF ${nf(P.profitFactor, 3)}`);
    L.push(`   毛盈 ${nf(P.grossWinUsd, 4)} U / 毛亏 ${nf(P.grossLossUsd, 4)} U · 净 ${nf(P.netUsd, 4)} U · 最好 ${nf(P.bestUsd, 4)} / 最差 ${nf(P.worstUsd, 4)}`);
    L.push(`   最大回撤 ${pct(P.maxDrawdownPct)}（口径：${P.drawdownSource}，${P.curvePoints} 点）`);
    if (P.reasons.length) L.push(table([{ h: '离场原因' }, { h: '笔数' }, { h: '占比' }, { h: '盈亏U' }], P.reasons.map((x) => [x.reason, x.n, pct(x.sharePct), nf(x.pnlUsd, 4)])));
  }
  L.push('');

  /* 回测对比 */
  L.push('⑥ 回测 vs 实盘（并排 + 偏差）');
  const bts = CMP.backtest;
  if (!bts) L.push('   ⚠ 无回测报告可比（--backtest 或 data/backtest-martin-*.json）');
  else {
    L.push(`   回测：${bts.file} · ${bts.days} 天 · 成本 ${bts.feeBps}bps 双边 / 滑点假设 ${bts.slipBps}bps · verdict=${bts.verdict ? (bts.verdict.meetsGate ? 'meetsGate' : 'no-gate') : '--'}`);
    L.push(table([{ h: '指标' }, { h: '实盘' }, { h: '回测' }, { h: '偏差' }, { h: '备注' }],
      CMP.rows.map((x) => [x.metric, nf(x.live, 4), nf(x.backtest, 4), nf(x.delta, 4), x.note])));
    const d = CMP.costDrag;
    L.push(`   成本拖累：实测往返 ${nf(d.liveRoundTripBps, 2)} bps vs 回测假设 ${nf(d.btRoundTripBps, 2)} bps → 缺口 ${nf(d.gapBps, 2)} bps；回测单笔期望 ${nf(d.btExpectancyBps, 2)} bps(名义) → 被吃掉 ${d.dragPct === null ? '--（回测期望非正/不可比）' : pct(d.dragPct)}`);
  }
  L.push('');

  /* 口径不一致 */
  L.push('⑦ 口径不一致 / 发现');
  if (!r.findings.length) L.push('   （无）');
  else for (const f of r.findings) L.push(`   [${f.level}] ${f.text}`);
  if (CMP.policyDrift.diffs.length) {
    L.push('');
    L.push('   参数差异明细：');
    L.push(table([{ h: '参数' }, { h: '回测基线' }, { h: '实盘' }], CMP.policyDrift.diffs.map((x) => [x.key, String(x.backtest), String(x.live)])));
  }
  L.push('');

  /* 持仓对账 */
  if (r.positions.reconciled.length) {
    L.push('⑧ 持仓对账（OKX 真实爆仓价）');
    L.push(table([{ h: '标的' }, { h: 'OKX liqPx' }, { h: '对账时间(UTC)' }, { h: 'posMissingAt' }],
      r.positions.reconciled.map((x) => [x.instId.replace('-USDT-SWAP', ''), nf(x.liqPxReal, 6), ts2s(x.at), x.posMissingAt ? ts2s(x.posMissingAt) : '-'])));
    L.push('');
  }

  L.push(`结论：${r.headline.conclusion}`);
  L.push(`落盘：${outPath}`);
  L.push('');
  console.log(L.join('\n'));
}

main().catch((e) => { console.error(`✗ 验算失败：${e && e.stack || e}`); process.exit(1); });
