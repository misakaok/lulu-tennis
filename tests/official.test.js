const assert = require('assert');
const OF = require('../utils/official');

module.exports = [{
  name: '正式战绩兼容：日常旧记录全部计入，活动旧记录仍严格核对快照',
  fn() {
    const daily = { _id: 'daily', _openid: 'alice', a: ['A'], b: ['B'], sets: [{ a: 4, b: 1 }], winner: 'a' };
    const stale = { daily: { snap: '旧比分' } };
    assert.strictEqual(OF.statusOf(daily, {}), 'official');
    assert.strictEqual(OF.statusOf(daily, stale), 'official');
    assert.strictEqual(OF.statusOf(Object.assign({}, daily, { aIds: [], bIds: [] }), {}), 'official');
    const event = Object.assign({}, daily, { _id: 'event', drawId: 'draw', drawKey: 'k1-0' });
    assert.strictEqual(OF.statusOf(event, {}), 'invalid');
    const verified = { event: { snap: OF.snapOf(event), legacy: true } };
    assert.strictEqual(OF.statusOf(event, verified), 'official');
    assert.strictEqual(OF.statusOf(Object.assign({}, event, { winner: 'b' }), verified), 'invalid');
    const serverEvent = Object.assign({}, event);
    delete serverEvent._openid;
    assert.strictEqual(OF.statusOf(serverEvent, {}), 'official');
  },
}];
