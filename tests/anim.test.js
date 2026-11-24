// 数字滚动 utils/anim.js（纯展示：只影响显示过程，最后一帧必须是原值）
const assert = require('assert');
const Anim = require('../utils/anim');

const T = [];
const clock = require('./fake-clock')(); // 虚拟时间：动画照常一帧帧走，不用真的等它放完
const test = (name, fn) => T.push({ name, fn: () => clock.run(fn) });
const wait = clock.wait;
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

test('leave / enter：切换 tab 回来时重播（动画类、数字从 0 再滚到原值）；只是被子页面盖住时不重播', async () => {
  const p = page({ play: true, me: { played: 12, rate: 58 } });
  Anim.roll(p, { 'me.played': 12, 'me.rate': 58 });
  await wait(Anim.MS + 150);
  global.getCurrentPages = () => [p, {}]; // 点进详情页
  Anim.leave(p);
  assert.strictEqual(p.data.play, true);
  assert.deepStrictEqual(Anim.enter(p), {});
  global.getCurrentPages = () => [{}]; // 切到别的 tab
  Anim.leave(p);
  assert.strictEqual(p.data.play, false);
  assert.deepStrictEqual(p.data.me, { played: '0', rate: '0' });
  // 切走期间数据变了：仍停在 0，回来时滚到新值
  assert.deepStrictEqual(Anim.roll(p, { 'me.played': 13, 'me.rate': 60 }), { 'me.played': '0', 'me.rate': '0' });
  p.data.me = { played: '0', rate: '0' };
  const back = Anim.enter(p);
  assert.deepStrictEqual(back, { play: true, 'me.played': '0', 'me.rate': '0' });
  p.setData(back);
  await wait(Anim.MS + 150);
  assert.deepStrictEqual(p.data.me, { played: 13, rate: 60 });
  assert.deepStrictEqual(Anim.enter(p), {}); // 只重播一次
  delete global.getCurrentPages;
});

test('页面接入：战绩、排行的入场动画类都随 play 切换，并在 onHide / onShow 里调用 leave / enter', () => {
  const fs = require('fs');
  const path = require('path');
  ['index', 'rank'].forEach((n) => {
    const base = path.join(__dirname, '..', 'pages', n, n);
    const wxml = fs.readFileSync(base + '.wxml', 'utf8'), js = fs.readFileSync(base + '.js', 'utf8');
    assert.ok(!/'ani-(in|grow-x)'\s*:\s*''|class="[^"]*\bani-(in|grow-x)\b[^{"]*"/.test(wxml.replace(/play \? 'ani-(in|grow-x)'/g, '')), n + ' 有不随 play 切换的动画类');
    assert.ok(/onHide\(\)\s*\{\s*Anim\.leave\(this\)/.test(js) && /Anim\.enter\(this\)/.test(js), n + ' 没有接入 leave / enter');
  });
});

module.exports = T;
