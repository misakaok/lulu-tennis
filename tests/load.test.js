// 所有注册的页面和组件脚本都能加载：语法错误、顶层引用错误在这里就能发现（不用等到开发者工具里报错）
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const T = [];
const test = (name, fn) => T.push({ name, fn });

function scripts() {
  const app = require(path.join(root, 'app.json'));
  const pages = (app.pages || []).concat((app.subpackages || []).flatMap((s) => (s.pages || []).map((p) => `${s.root}/${p}`)));
  const out = pages.map((p) => p + '.js');
  ['components', 'pkg-manage/components'].forEach((base) => {
    const dir = path.join(root, base);
    if (!fs.existsSync(dir)) return;
    fs.readdirSync(dir).forEach((c) => { const f = `${base}/${c}/${c}.js`; if (fs.existsSync(path.join(root, f))) out.push(f); });
  });
  return out;
}

test('所有页面和组件脚本都能加载，并各注册一次 Page / Component', () => {
  const saved = { Page: global.Page, Component: global.Component, wx: global.wx, getApp: global.getApp };
  let n = 0;
  global.Page = (o) => { assert.ok(o && typeof o === 'object'); n++; };
  global.Component = global.Page;
  global.getApp = () => ({ globalData: {} });
  if (!global.wx) global.wx = new Proxy({}, { get: () => () => ({}) });
  try {
    scripts().forEach((f) => {
      const full = path.join(root, f), before = n;
      delete require.cache[require.resolve(full)];
      try { require(full); } catch (e) { throw new Error(`${f} 加载失败：${e.message}`); }
      assert.strictEqual(n, before + 1, `${f} 应该注册一次`);
    });
  } finally { Object.assign(global, saved); }
});

// 页面 / 组件里调用的 this.xxx() 都要有定义：删功能时漏删的调用（如 2026-11-21 报名成功后调用已删除的 loadContact，
// 报名其实成功了却弹「报名失败」）在这里就能发现
const BUILTIN = new Set(['setData', 'triggerEvent', 'selectComponent', 'selectAllComponents', 'selectOwnerComponent', 'createSelectorQuery',
  'createIntersectionObserver', 'getOpenerEventChannel', 'getTabBar', 'getPageId', 'animate', 'clearAnimation', 'hasBehavior', 'getRelationNodes', 'groupSetData']);
test('页面和组件里调用的 this 方法都有定义（没有删功能时漏删的调用）', () => {
  const saved = { Page: global.Page, Component: global.Component, wx: global.wx, getApp: global.getApp };
  let def = null;
  global.Page = (o) => { def = o; };
  global.Component = (o) => { def = Object.assign({}, o, o.methods, o.lifetimes, o.pageLifetimes); };
  global.getApp = () => ({ globalData: {} });
  if (!global.wx) global.wx = new Proxy({}, { get: () => () => ({}) });
  const bad = [];
  try {
    scripts().forEach((f) => {
      const full = path.join(root, f);
      delete require.cache[require.resolve(full)];
      require(full);
      const src = fs.readFileSync(full, 'utf8');
      const set = new Set([...src.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*=[^=]/g)].map((m) => m[1])); // 运行时挂上去的
      new Set([...src.matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1])).forEach((n) => {
        if (typeof def[n] !== 'function' && !BUILTIN.has(n) && !set.has(n)) bad.push(`${f}: this.${n}()`);
      });
    });
  } finally { Object.assign(global, saved); }
  assert.deepStrictEqual(bad, [], '调用了没有定义的方法');
});

module.exports = T;
