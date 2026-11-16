// 所有注册的页面和组件脚本都能加载：语法错误、顶层引用错误在这里就能发现（不用等到开发者工具里报错）
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const T = [];
const test = (name, fn) => T.push({ name, fn });

function scripts() {
  const out = require(path.join(root, 'app.json')).pages.map((p) => p + '.js');
  const dir = path.join(root, 'components');
  fs.readdirSync(dir).forEach((c) => { const f = `components/${c}/${c}.js`; if (fs.existsSync(path.join(root, f))) out.push(f); });
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

module.exports = T;
