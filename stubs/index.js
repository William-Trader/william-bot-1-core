/**
 * 引擎解析器（B 方所有）：优先加载 A 的真件，缺失时回落到本地桩。
 *
 * 用法：
 *   const { martin, risk, store, engineInfo } = require('./stubs');   // 或 require('../stubs')
 *   engineInfo() -> { source:'real'|'stub'|'mixed', real:[], stub:[], missing:[] }
 *
 * 说明：这是"接口防空洞"，不是业务代码。A 交付 modules/{martin,risk,store}.js 后
 *      无需改任何 B 方代码，重启即自动切换；缺失项会在面板与自检里显式标注。
 */
const NAME = ['martin', 'risk', 'store'];

function tryReal(name) {
  try { return { mod: require(`../modules/${name}`), ok: true }; }
  catch (e) {
    if (e.code === 'MODULE_NOT_FOUND' && String(e.message).includes(`/${name}'`)) return { mod: null, ok: false, err: 'MODULE_NOT_FOUND' };
    return { mod: null, ok: false, err: String(e.message || e).slice(0, 120) };
  }
}

const resolved = {};
const meta = { real: [], stub: [], missing: [], errors: {} };

for (const n of NAME) {
  const r = tryReal(n);
  if (r.ok) { resolved[n] = r.mod; meta.real.push(n); }
  else {
    resolved[n] = require(`./${n}`);      // 桩
    meta.missing.push(n);
    if (r.err !== 'MODULE_NOT_FOUND') meta.errors[n] = r.err;
  }
}

/** 每个接口是"真件"还是"桩" */
function apiSource() {
  const real = new Set(meta.real);
  return {
    martin: {
      sizeForMargin: real.has('martin') ? 'real' : 'stub',
      nextAddPrice: real.has('martin') ? 'real' : 'stub',
      basketPnl: real.has('martin') ? 'real' : 'stub',
      liquidationPrice: real.has('martin') ? 'real' : 'stub',
      shouldOpen: real.has('martin') ? 'real' : 'stub',
      onPrice: real.has('martin') ? 'real' : 'stub',
      newBasket: real.has('martin') ? 'real' : 'stub',
    },
    risk: { gate: real.has('risk') ? 'real' : 'stub' },
    store: { load: real.has('store') ? 'real' : 'stub', save: real.has('store') ? 'real' : 'stub' },
  };
}

function engineInfo() {
  const source = meta.missing.length === 0 ? 'real' : (meta.real.length === 0 ? 'stub' : 'mixed');
  return { source, real: [...meta.real], stub: [...meta.missing], missing: [...meta.missing], resolveErrors: { ...meta.errors }, api: apiSource() };
}

module.exports = { martin: resolved.martin, risk: resolved.risk, store: resolved.store, engineInfo, STUB_DIR: `stubs/` };
