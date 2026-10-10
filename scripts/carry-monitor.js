/*!
 * scripts/carry-monitor.js - william-bot-1-core key backtest/optimize logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-C3804BE3
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
#!/usr/bin/env node
/**
 * 资金费套利常驻监测（只读）
 * 每 30 分钟跑一次 funding 扫描，落盘摘要 data/carry.json；年化净收益 ≥ 阈值时置 alert=true。
 * 用法：PROXY_URL=http://127.0.0.1:7890 node scripts/carry-monitor.js [--threshold 20]
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DATA_DIR = process.env.MARTIN_DATA_DIR || path.join(__dirname, '..', 'data');
const THRESHOLD = Number((process.argv.find((a) => a.startsWith('--threshold')) || '').split('=')[1] || 20); // 年化净 %（占名义）

function runScan() {
  const env = { ...process.env, PROXY_URL: process.env.PROXY_URL || 'http://127.0.0.1:7890' };
  const out = execFileSync(process.execPath, [path.join(__dirname, 'arb-scan.js'), '--mode', 'funding', '--json'],
    { env, encoding: 'utf8', timeout: 300000, maxBuffer: 32 * 1024 * 1024 });
  return JSON.parse(out);
}

function pick(rows) {
  const items = (rows || []).map((r) => {
    const now = r.now || {};
    return {
      instId: r.instId, spotPair: r.spotPair,
      fundingNow: r.fundingNow,
      medianRate: r.history ? r.history.median : null,
      positiveShare: r.history ? r.history.positiveShare : null,
      grossAnnualPct: now.grossAnnualPct ?? null,
      netAnnualPct: now.netAnnualPctOfNotional ?? null,
      capitalUsd: now.capitalUsd ?? null,
      executable: !!r.executable,
      note: r.note || null,
    };
  });
  items.sort((a, b) => (b.netAnnualPct || -999) - (a.netAnnualPct || -999));
  return items;
}

try {
  const t0 = Date.now();
  const raw = runScan();
  const rows = (raw.fundingScan && raw.fundingScan.rows) || [];
  const items = pick(rows);
  const best = items[0] || null;
  const alert = !!(best && best.executable && Number(best.netAnnualPct) >= THRESHOLD);
  const out = {
    ok: true, at: Date.now(), tookMs: Date.now() - t0,
    scanned: (raw.fundingScan && raw.fundingScan.scanned) || items.length,
    thresholdPctNet: THRESHOLD,
    alert,
    best,
    top: items.filter((x) => x.executable).slice(0, 8),
    note: alert
      ? `★ 资金费套利窗口：${best.instId} 年化净 ${best.netAnnualPct}%（阈值 ${THRESHOLD}%）`
      : `暂无达标机会（最优净年化 ${best ? best.netAnnualPct : '-'}% < 阈值 ${THRESHOLD}%）`,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'carry.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ ok: true, alert, best: out.best, note: out.note }, null, 1));
} catch (e) {
  const err = { ok: false, at: Date.now(), error: String((e && e.message) || e).slice(0, 200) };
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(path.join(DATA_DIR, 'carry.json'), JSON.stringify(err, null, 1)); } catch {}
  console.error(JSON.stringify(err));
  process.exit(1);
}
