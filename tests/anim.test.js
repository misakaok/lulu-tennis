// 数字滚动 utils/anim.js（纯展示：只影响显示过程，最后一帧必须是原值）
const assert = require('assert');
const Anim = require('../utils/anim');

const T = [];
const test = (name, fn) => T.push({ name, fn });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 模拟页面：setData 支持 'a.b' 路径
const page = (data) => ({
  data, frames: 0,
  setData(o) {
    this.frames++;
    Object.keys(o).forEach((k) => { const ks = k.split('.'); let t = this.data; while (ks.length > 1) t = t[ks.shift()]; t[ks[0]] = o[k]; });
  },
});

test('rollText：文字里的数字按进度缩小，小数位数和其他文字不变', () => {
  assert.strictEqual(Anim.rollText('12胜 5负', 0.5), '6胜 3负');
  assert.strictEqual(Anim.rollText('3.52', 0.5), '1.76');
  assert.strictEqual(Anim.rollText('62%', 0), '0%');
  assert.strictEqual(Anim.rollText(40, 1), '40');
  assert.strictEqual(Anim.rollText('暂无', 0.3), '暂无');
});

test('roll：起始帧从 0 开始，结束后是原值（类型不变）；每个页面只滚一次', async () => {
  const p = page({ me: { played: 12, rate: 58, level: '3.52' } });
  const first = Anim.roll(p, { 'me.played': 12, 'me.rate': 58, 'me.level': '3.52' });
  assert.deepStrictEqual(first, { 'me.played': '0', 'me.rate': '0', 'me.level': '0.00' });
  await wait(Anim.MS + 150);
  assert.deepStrictEqual(p.data.me, { played: 12, rate: 58, level: '3.52' });
  assert.ok(p.frames > 3);
  assert.deepStrictEqual(Anim.roll(p, { 'me.played': 13 }), {});
});

test('roll：没有数据（0、暂无）时不滚，等有数据再滚；滚动中重新渲染会停下，不再改数据', async () => {
  const p = page({ s: { n: 0, t: '暂无' } });
  assert.deepStrictEqual(Anim.roll(p, { 's.n': 0, 's.t': '暂无' }), {});
  assert.deepStrictEqual(Anim.roll(p, { 's.n': 20, 's.t': '暂无' }), { 's.n': '0' }); // 没有数字的字段不参与
  await wait(80);
  assert.deepStrictEqual(Anim.roll(p, { 's.n': 21 }), {}); // 新的渲染：停下
  p.data.s.n = 21;
  const frames = p.frames;
  await wait(Anim.MS);
  assert.strictEqual(p.data.s.n, 21);
  assert.strictEqual(p.frames, frames);
});

module.exports = T;
