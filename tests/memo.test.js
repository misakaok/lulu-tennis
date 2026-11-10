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
test('由其他缓存算出来的结果（deps）：有效期从原始数据算起，不会活得更久', async () => {
  const memo = fresh();
  const realNow = Date.now;
  let t = 1e12; Date.now = () => t;
  try {
    let n = 0;
    await memo.get('src', 'c', () => 1);
    t += memo.TTL_MS - 10;
    await memo.get('d', 'c', () => ++n, ['src']);
    t += 5; await memo.get('d', 'c', () => ++n, ['src']); assert.strictEqual(n, 1);
    t += 10; await memo.get('d', 'c', () => ++n, ['src']); assert.strictEqual(n, 2, '原始数据过期后，整理结果也要重算');
    const v = { x: 1 };
    assert.strictEqual(await memo.raw('r', 'c', () => v), v, 'raw 不复制');
    assert.notStrictEqual(await memo.get('r', 'c', () => v), v);
  } finally { Date.now = realNow; }
});

test('ANY：任意集合写入都作废，普通缓存保持；从零时钟开始的依赖也限制有效期', async () => {
  const memo = fresh();
  let n = 0;
  await memo.get('any', memo.ANY, () => ++n);
  await memo.get('ordinary', 'matches', () => ++n);
  memo.invalidate(['players']);
  assert.strictEqual(await memo.get('ordinary', 'matches', () => ++n), 2);
  assert.strictEqual(await memo.get('any', memo.ANY, () => ++n), 3);
  const realNow = Date.now;
  let t = 0; Date.now = () => t;
  try {
    await memo.raw('src0', 'c', () => 1);
    t = memo.TTL_MS - 1;
    await memo.get('dep0', 'c', () => ++n, ['src0']);
    t += 2;
    assert.strictEqual(await memo.get('dep0', 'c', () => ++n, ['src0']), 5);
  } finally { Date.now = realNow; }
});

module.exports = T;
