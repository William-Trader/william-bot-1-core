/*!
 * modules/store.js - william-bot-1-core key engine logic
 * (c) 2026 William-Trader (https://github.com/William-Trader)
 * WM: WBC-71889ED7
 * SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0
 * Removing this mark violates the license.
 */
/**
 * modules/store.js —— 篮子与账户状态落盘（原子写 data/state.json）
 *
 * 契约：design/MARTIN-BOT-SPEC.md §2.3 store.load() / store.save(state)
 * 原子性：写 `<file>.tmp-<pid>-<rand>` → fsync → rename（同目录 rename 是 POSIX 原子操作）。
 *          进程崩在写一半时，state.json 仍是上一份完整快照，tmp 文件不会污染读取。
 *
 * state 形状（emptyState() 给默认值，B 可自行加字段，本模块不校验）：
 * {
 *   version, mode:'dry-run'|'live', equity, dayStartEquity, day,
 *   circuitBreaker, circuitBreakerAt, circuitBreakerReason, paused:false,
 *   policy:{...}, cooldowns:{ instId: tsMs }, baskets:[...], closed:[...],
 *   log:[{ts, level, msg}], savedAt
 * }
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_PATH = process.env.MARTIN_STATE_PATH || path.join(DATA_DIR, 'state.json');

function ensureDir(dir = DATA_DIR) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  return dir;
}

function emptyState(extra = {}) {
  return {
    version: 1,
    mode: 'dry-run',
    equity: null,
    dayStartEquity: null,
    day: null,
    circuitBreaker: false,
    circuitBreakerAt: null,
    circuitBreakerReason: null,
    paused: false,
    policy: null,
    cooldowns: {},
    baskets: [],
    closed: [],
    log: [],
    savedAt: null,
    ...extra,
  };
}

/** 读取状态；文件缺失/损坏 → 返回 emptyState（不抛，保证服务能起） */
function load(file = STATE_PATH) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(txt);
    if (!j || typeof j !== 'object') return emptyState();
    return { ...emptyState(), ...j };
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // 损坏文件留档，便于事后排查（不阻塞启动）
      try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* ignore */ }
    }
    return emptyState();
  }
}

/** 原子写状态；返回写入路径 */
function save(state, file = STATE_PATH) {
  const dir = path.dirname(file);
  ensureDir(dir);
  const payload = { ...(state || {}), version: (state && state.version) || 1, savedAt: new Date().toISOString() };
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const buf = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
  let fd;
  try {
    fd = fs.openSync(tmp, 'w', 0o600);
    fs.writeSync(fd, buf, 0, buf.length);
    fs.fsyncSync(fd);          // 数据落到磁盘后再 rename
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
  return file;
}

/** 追加一条日志（数组尾部截断，防止 state.json 无限增长） */
function log(state, msg, level = 'info', ts) {
  if (!state.log) state.log = [];
  state.log.push({ ts: Number(ts) || Date.now(), level, msg: String(msg).slice(0, 300) });
  const MAX = 500;
  if (state.log.length > MAX) state.log.splice(0, state.log.length - MAX);
  return state.log[state.log.length - 1];
}

module.exports = { load, save, emptyState, log, ensureDir, DATA_DIR, STATE_PATH };
