const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const T = [];
const test = (name, fn) => T.push({ name, fn });
function component(call) {
  let def;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../components/match-social/match-social.js'), 'utf8'), {
    Component: (d) => { def = d; }, require: () => ({ call }),
  });
  const c = Object.assign({ data: Object.assign({ matchId: '', preset: null }, def.data), setData(p) { Object.assign(this.data, p); } }, def.methods);
  c.update = (p) => { Object.assign(c.data, p); return def.observers['matchId, preset'].call(c); };
  return { c, def };
}
test('match-social：同批 matchId/preset 使用预取状态；同 ID 新 preset 生效，主动刷新仍查询云端', async () => {
  let calls = 0;
  const { c } = component(async () => { calls++; return { matchId: 'm1', confirmed: true }; });
  c.update({ matchId: 'm1', preset: { matchId: 'm1', confirmed: false } });
  assert.strictEqual(c.data.st.confirmed, false); assert.strictEqual(calls, 0);
  c.update({ preset: { matchId: 'm1', confirmed: true } });
  assert.strictEqual(c.data.st.confirmed, true); assert.strictEqual(calls, 0);
  await c.load(); assert.strictEqual(calls, 1);
});
test('match-social：切换比赛后，不使用错配 preset，旧请求不能覆盖新状态', async () => {
  let resolve;
  const { c } = component(() => new Promise((r) => { resolve = r; }));
  c.update({ matchId: 'old' });
  c.update({ matchId: 'new', preset: { matchId: 'new', confirmed: true } });
  resolve({ matchId: 'old', confirmed: false });
  await Promise.resolve(); await Promise.resolve();
  assert.strictEqual(c.data.st.matchId, 'new');
  assert.strictEqual(c.data.st.confirmed, true);
});
test('撤销按钮：发起人、录入人、其他人；确认前后和弃权退赛', () => {
  const xml = fs.readFileSync(path.join(__dirname, '../components/match-social/match-social.wxml'), 'utf8');
  const expr = xml.match(/wx:if="{{([^"\n]+)}}" class="ms-revoke"/)[1];
  const show = new Function('st', 'revocable', 'return !!(' + expr + ')');
  assert.strictEqual(show(null, true), false, '状态未到位不提前显示');
  for (const confirmed of [false, true]) {
    for (const outcome of ['normal', 'walkover', 'retired']) {
      assert.strictEqual(show({ isOwner: true, confirmed, drawId: 'd', outcome }, false), true);
      assert.strictEqual(show({ confirmed, drawId: 'd', outcome }, true), !confirmed && outcome === 'normal');
      assert.strictEqual(show({ confirmed, drawId: 'd', outcome }, false), false);
    }
    assert.strictEqual(show({ confirmed, drawId: '' }, true), !confirmed);
  }
});
module.exports = T;
