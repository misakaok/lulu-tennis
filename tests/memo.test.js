// 前端内存缓存 utils/memo.js
const assert = require('assert');

const fresh = () => { delete require.cache[require.resolve('../utils/memo')]; return require('../utils/memo'); };
const T = [];
const test = (name, fn) => T.push({ name, fn });

test('并发的相同请求只发一次，调用方修改不污染缓存', async () => {
  const memo = fresh();
  let n = 0;
  const fn = () => new Promise((r) => setTimeout(() => r([{ v: ++n }]), 10));
  const [a, b] = await Promise.all([memo.get('k', 'matches', fn), memo.get('k', 'matches', fn)]);
  assert.strictEqual(n, 1);
  assert.deepStrictEqual(a, b);
  a[0].v = 99;
  assert.strictEqual((await memo.get('k', 'matches', fn))[0].v, 1);
  assert.strictEqual(n, 1);
});
test('按集合作废 / 全部作废', async () => {
  const memo = fresh();
  let n = 0;
  const fn = () => ++n;
  await memo.get('k', 'matches', fn);
  memo.invalidate(['players']); await memo.get('k', 'matches', fn); assert.strictEqual(n, 1);
  memo.invalidate(['matches']); await memo.get('k', 'matches', fn); assert.strictEqual(n, 2);
  memo.invalidate(); await memo.get('k', 'matches', fn); assert.strictEqual(n, 3);
});
test('失败不缓存；进行中被作废的结果不写回', async () => {
  const memo = fresh();
  await memo.get('e', 'x', () => Promise.reject(new Error('net'))).catch(() => {});
  let ok = 0; await memo.get('e', 'x', () => { ok++; return 1; }); assert.strictEqual(ok, 1);
  let m = 0;
  const p = memo.get('z', 'x', () => new Promise((r) => setTimeout(() => r(++m), 10)));
  memo.invalidate(); await p;
  await memo.get('z', 'x', () => ++m); assert.strictEqual(m, 2);
});
test('超过 TTL 重新拉取', async () => {
  const memo = fresh();
  const realNow = Date.now;
  let t = 1e12; Date.now = () => t;
  try {
    let n = 0;
    await memo.get('k', 'c', () => ++n);
    t += memo.TTL_MS - 1; await memo.get('k', 'c', () => ++n); assert.strictEqual(n, 1);
    t += 2; await memo.get('k', 'c', () => ++n); assert.strictEqual(n, 2);
  } finally { Date.now = realNow; }
});

module.exports = T;
