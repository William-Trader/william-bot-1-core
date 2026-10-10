/**
 * 【桩·stub】modules/store.js 的替身（B 方自测 / A 缺件时兜底）
 *
 * ⚠️ 不是交付物。语义严格镜像 A 已交付的 modules/store.js：
 *    · 路径 = env MARTIN_STATE_PATH || <repo>/data/state.json
 *    · 原子写 tmp + fsync + rename；读损坏文件不抛（留档 .corrupt-*）
 *    · state 形状与 emptyState() 一致，B 可另加字段
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_PATH = process.env.MARTIN_STATE_PATH || path.join(DATA_DIR, 'state.json');
const MAX_LOG = 500;

function emptyState(extra = {}) {
  return {
    version: 1, mode: 'dry-run', equity: null, dayStartEquity: null, day: null,
    circuitBreaker: false, circuitBreakerAt: null, circuitBreakerReason: null,
    paused: false, policy: null, cooldowns: {}, baskets: [], closed: [], log: [], savedAt: null,
    ...extra,
  };
}
function load(file = STATE_PATH) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || typeof j !== 'object') return emptyState();
    return { ...emptyState(), ...j };
  } catch (e) {
    if (e.code !== 'ENOENT') { try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignore */ } }
    return emptyState();
  }
}
function save(state, file = STATE_PATH) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const payload = { ...(state || {}), version: (state && state.version) || 1, savedAt: new Date().toISOString() };
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const buf = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  let fd;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeSync(fd, buf, 0, buf.length);
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  return file;
}
function log(state, msg, level = 'info', ts) {
  if (!state.log) state.log = [];
  state.log.push({ ts: Number(ts) || Date.now(), level, msg: String(msg).slice(0, 300) });
  if (state.log.length > MAX_LOG) state.log.splice(0, state.log.length - MAX_LOG);
  return state.log[state.log.length - 1];
}

module.exports = { load, save, emptyState, log, ensureDir: (d = DATA_DIR) => (fs.mkdirSync(d, { recursive: true }), d), DATA_DIR, STATE_PATH, STUB: true };
