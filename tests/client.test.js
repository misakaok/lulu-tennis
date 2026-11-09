// 小程序端 utils/db.js → utils/cloud.js → 云函数（内存数据库）的端到端测试
const assert = require('assert');
const path = require('path');
const createEnv = require('./mock-cloud');

const T = [];
const test = (name, fn) => T.push({ name, fn });
const ROOT = path.resolve(__dirname, '..');

// 准备一个小程序端运行环境：wx.cloud.callFunction 直接调内存里的云函数；返回新加载的 utils/db.js
function client(env, uid, opts) {
  opts = opts || {};
  const storage = {};
  let calls = 0;
  global.wx = {
    getStorageSync: (k) => storage[k], setStorageSync: (k, v) => { storage[k] = JSON.parse(JSON.stringify(v)); },
    removeStorageSync: (k) => { delete storage[k]; }, getStorageInfoSync: () => ({ keys: Object.keys(storage) }),
    cloud: {
      callFunction: async ({ data }) => {
        calls++;
        if (opts.oldCloud && data.action === 'dataset') return { result: { ok: false, error: '未知操作' } };
        return { result: await env.call(uid, data.action, data) };
      },
    },
  };
  global.getCurrentPages = () => [];
  storage.member_ok_at = Date.now();
  storage.my_openid = uid;
  Object.keys(require.cache).forEach((k) => { if (k.startsWith(path.join(ROOT, 'utils'))) delete require.cache[k]; });
  const db = require(path.join(ROOT, 'utils/db.js'));
  return { db, calls: () => calls, storage };
}

function seed(env) {
  env.members([['alice', 'Alice'], ['bob', 'Bob'], ['carl', 'Carl']]);
  env.put('players', { _id: 'legacy', name: 'OldTimer', createdAt: 0 }); // 只有名字的历史球员
  env.put('draws', { _id: 'd1', _openid: 'alice', title: 'T', status: 'drawn', type: 'single', mode: 'bracket', size: 2, entrants: ['Alice', 'Bob'], lines: [{ name: 'Alice' }, { name: 'Bob' }] });
  for (let i = 0; i < 25; i++) {
    env.put('matches', { _id: 'dm' + i, _openid: i % 2 ? 'alice' : 'bob', a: [i % 2 ? 'Alice' : 'Bob'], b: [i % 2 ? 'Bob' : 'Carl'], aIds: [i % 2 ? 'alice' : 'bob'], bIds: [i % 2 ? 'bob' : 'carl'], winner: 'a', sets: [{ a: 4, b: i % 4 }], date: '2026-10-' + String(1 + (i % 28)).padStart(2, '0'), createdAt: i });
  }
  // 一部分已确认（有正式战绩快照），一部分待确认
  const OF = require('../utils/official');
  for (let i = 0; i < 25; i += 2) env.put('verified', { _id: 'dm' + i, snap: OF.snapOf(env.coll('matches')['dm' + i]) });
  env.put('matches', { _id: 'ev1', drawId: 'd1', drawKey: '0-0', a: ['Alice'], b: ['Bob'], aIds: ['alice'], bIds: ['bob'], winner: 'b', sets: [{ a: 2, b: 4 }], outcome: 'normal', date: '2026-11-01', createdAt: 100 });
  env.put('matches', { _id: 'fake', _openid: 'carl', drawId: 'd1', drawKey: '0-0', a: ['Alice'], b: ['Carl'], winner: 'b', sets: [{ a: 0, b: 4 }], date: '2026-11-02', createdAt: 101 }); // 绕过签表写的赛事比分：不认可
}

test('一次性读取（dataset）和分页读取的结果完全一致', async () => {
  const env = createEnv(); env.load(); seed(env);
  const a = client(env, 'alice');
  const [m1, all1, p1] = [await a.db.fetchMatches(), await a.db.fetchMatchesAll(), await a.db.fetchPlayersFull()];
  const used = a.calls();
  const b = client(env, 'alice', { oldCloud: true });
  const [m2, all2, p2] = [await b.db.fetchMatches(), await b.db.fetchMatchesAll(), await b.db.fetchPlayersFull()];
  assert.deepStrictEqual(m1, m2); assert.deepStrictEqual(all1, all2); assert.deepStrictEqual(p1, p2);
  assert.ok(!m1.some((m) => m._id === 'fake'), '不认可的记录不出现');
  assert.ok(all1.some((m) => m.status === 'pending') && !m1.some((m) => m.status === 'pending'));
  assert.ok(used <= 2, `dataset 方式应该只调用 1～2 次云函数，实际 ${used} 次`);
  assert.ok(b.calls() > used * 3, `分页方式调用次数 ${b.calls()}，应该明显更多`);
});
test('数据太大时自动改回分页读取', async () => {
  const env = createEnv(); env.load(); seed(env);
  const big = 'x'.repeat(1000);
  for (let i = 0; i < 1000; i++) env.put('players', { _id: 'big' + i, name: 'P' + i, note: big, createdAt: 1000 + i });
  const r = await env.call('alice', 'dataset');
  assert.ok(r.ok && r.tooLarge);
  const c = client(env, 'alice');
  const ps = await c.db.fetchPlayersFull();
  assert.ok(ps.length > 1000);
});
test('写入后缓存作废：新录的日常比赛马上能看到', async () => {
  const env = createEnv(); env.load(); seed(env);
  const c = client(env, 'alice');
  const before = (await c.db.fetchMatchesAll()).length;
  const n = c.calls();
  await c.db.fetchMatchesAll();
  assert.strictEqual(c.calls(), n, '缓存期内不重复调用');
  await c.db.addMatch({ a: ['Alice'], b: ['Carl'], aIds: ['alice'], bIds: ['carl'], winner: 'a', sets: [{ a: 4, b: 0 }], date: '2026-11-05' });
  assert.strictEqual((await c.db.fetchMatchesAll()).length, before + 1);
});

module.exports = T;
