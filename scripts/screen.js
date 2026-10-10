/*!
 * scripts/screen.js - william-bot-1-core key backtest/optimize logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-415010E1
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
#!/usr/bin/env node
/**
 * 选品 CLI：抓全市场 → 回归性/波动率/流动性打分 → 打印候选池
 * 用法：node scripts/screen.js [--top 12] [--minVol 50000000] [--maxFunding 0.001] [--preScan 50] [--bar 1H] [--json]
 */
const uni = require('../modules/universe');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const flag = (n) => process.argv.includes('--' + n);

(async () => {
  const opt = {
    top: Number(arg('top', 12)),
    minVolUsd: Number(arg('minVol', 50000000)),
    maxFundingAbs: Number(arg('maxFunding', 0.001)),
    minAgeDays: Number(arg('minAge', 30)),
    preScan: Number(arg('preScan', 50)),
    bar: arg('bar', '1H'),
  };
  console.log(`\n抓取全市场（USDT 永续）…  条件：成交额≥${(opt.minVolUsd / 1e6).toFixed(0)}M · |费率|≤${(opt.maxFundingAbs * 100).toFixed(3)}% · 上市≥${opt.minAgeDays}天 · 扫描前 ${opt.preScan} 个\n`);
  const r = await uni.screen(opt);
  if (flag('json')) { console.log(JSON.stringify(r, null, 2)); return; }

  console.log(`全市场 ${r.universe.swaps} 个永续 / ${r.universe.tickers} 个行情 · 通过成交额 ${r.universe.aboveVolume} · 进入指标计算 ${r.universe.scanned} · 淘汰 ${r.universe.failed} · 耗时 ${(r.tookMs / 1000).toFixed(1)}s\n`);
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  const num = (v, d = 2) => (v === null || v === undefined ? '--' : Number(v).toFixed(d));
  console.log(pad('#', 3) + pad('品种', 20) + pad('板块', 8) + pad('现价', 12) + pad('成交额', 10) + pad('ATR%', 7) + pad('VR5', 7) + pad('ρ₁', 7) + pad('回归频率', 9) + pad('ADX', 6) + pad('状态', 11) + pad('方向', 10) + '总分');
  console.log('-'.repeat(126));
  r.picked.forEach((p, i) => {
    console.log(
      pad(i + 1, 3) + pad(p.instId.replace('-USDT-SWAP', ''), 20) + pad(p.sector, 8) +
      pad(num(p.last, p.last < 10 ? 5 : 1), 12) + pad((p.notionalUsd / 1e6).toFixed(0) + 'M', 10) +
      pad(num(p.atrPct), 7) + pad(num(p.vr5, 3), 7) + pad(num(p.rho1, 3), 7) + pad(num(p.rf, 2), 9) +
      pad(p.adx === null ? '--' : num(p.adx, 1), 6) + pad(p.regime, 11) + pad((p.allowDirections || []).join('/') || '不开新仓', 10) +
      p.score.total.toFixed(3)
    );
  });
  console.log('\n评分口径：总分 = 0.45×回归性 + 0.35×波动率 + 0.20×流动性；回归性 = 0.4×(1−VR5) + 0.3×(−ρ₁) + 0.3×回归频率');
  console.log('VR5 < 1 且 ρ₁ < 0 表示均值回归特征（马丁友好）；regime=range 才允许双向，trend_up 只做多、trend_down 只做空。');
  if (r.rejectedSample.length) {
    console.log('\n淘汰样本：');
    r.rejectedSample.slice(0, 8).forEach((x) => console.log(`  · ${x.instId}: ${x.reason}`));
  }
  console.log('');
})();
