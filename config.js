/**
 * 配置：OKX 凭据 / 代理 / UA / 运行模式
 * 凭据从 /root/.okx/config.toml 的 [profiles.<name>] 读（与 okx CLI 共用一份）
 */
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = process.env.OKX_CONFIG || '/root/.okx/config.toml';
const PROFILE = process.env.OKX_PROFILE || 'live';

function readToml(text) {
  const out = { profiles: {} };
  let section = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let m = line.match(/^default_profile\s*=\s*"([^"]*)"/);
    if (m) { out.default_profile = m[1]; continue; }
    m = line.match(/^\[profiles\.([A-Za-z0-9_\-]+)\]/) || line.match(/^\[([A-Za-z0-9_\-]+)\]/);
    if (m) { section = m[1]; out.profiles[section] = out.profiles[section] || {}; continue; }
    m = line.match(/^([A-Za-z0-9_]+)\s*=\s*"([^"]*)"/) || line.match(/^([A-Za-z0-9_]+)\s*=\s*(true|false)/);
    if (m && section) {
      const v = m[2] === 'true' ? true : m[2] === 'false' ? false : m[2];
      out.profiles[section][m[1]] = v;
    }
  }
  return out;
}

let cfg = { profiles: {} };
try { cfg = readToml(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { /* 没配置也要能起 */ }
const profile = cfg.profiles[PROFILE] || {};

module.exports = {
  configPath: CONFIG_PATH,
  profile: PROFILE,
  hasCreds: Boolean(profile.api_key && profile.secret_key && profile.passphrase),
  creds: {
    apiKey: profile.api_key || '',
    secretKey: profile.secret_key || '',
    passphrase: profile.passphrase || '',
    demo: profile.demo === true,
  },
  baseUrl: process.env.OKX_BASE || 'https://www.okx.com',
  proxy: process.env.PROXY_URL || process.env.HTTPS_PROXY || 'http://127.0.0.1:7890',
  userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  port: Number(process.env.PORT || 3100),
  /** 实盘开关：默认 dry-run（只验证参数、不发单），设 LIVE=1 才真正下单 */
  live: process.env.LIVE === '1',
  /** 默认下单标的与参数（可被请求覆盖） */
  defaults: {
    instId: process.env.DEFAULT_INST || 'BTC-USDT-SWAP',
    tdMode: process.env.DEFAULT_TD_MODE || 'cross',
    lever: Number(process.env.DEFAULT_LEVER || 3),
    posSide: 'long',
  },
  mask(v) { const s = String(v || ''); return s ? s.slice(0, 6) + '…' + s.slice(-4) : '(未配置)'; },
  maskAll() {
    const c = this.creds;
    return { apiKey: this.mask(c.apiKey), secretKey: this.mask(c.secretKey), passphrase: c.passphrase ? '已配置' : '(未配置)', demo: c.demo };
  },
};
