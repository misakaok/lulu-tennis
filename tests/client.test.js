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
  env.put('matches', { _id: 'fake', _openid: 'carl', drawId: 'd1', drawKey: '0-0', a: ['Alice'], b: ['Carl'], winner: 'b', sets: [{ a: 0, b: 4 }], date: '2026-11-02', createdAt: 101 }); // 绕过签表写的活动比分：不认可
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
  for (let i = 0; i < 1000; i++) env.put('matches', { _id: 'big' + i, _openid: 'alice', a: ['Alice'], b: ['Bob'], aIds: ['alice'], bIds: ['bob'], winner: 'a', sets: [{ a: 4, b: 0 }], note: big, date: '2026-09-01', createdAt: 1000 + i });
  const r = await env.call('alice', 'dataset');
  assert.ok(r.ok && r.tooLarge);
  const c = client(env, 'alice');
  const ms = await c.db.fetchMatchesAll();
  assert.ok(ms.length > 1000);
});
test('dataset：球员只返回前端要用的字段；带上次的指纹、内容没变时只回 same', async () => {
  const env = createEnv(); env.load(); seed(env);
  env.coll('players').p_alice.secretNote = 'x';
  const r = await env.call('alice', 'dataset');
  assert.ok(r.ok && r.hash && r.matches.length && r.players.length);
  assert.ok(r.players.every((p) => !('secretNote' in p)));
  const same = await env.call('alice', 'dataset', { have: r.hash });
  assert.ok(same.ok && same.same && same.hash === r.hash && !same.matches && !same.players);
  env.coll('players').p_bob.name = 'Bobby';
  const changed = await env.call('alice', 'dataset', { have: r.hash });
  assert.ok(changed.ok && !changed.same && changed.hash !== r.hash && changed.players.some((p) => p.name === 'Bobby'));
});
test('整理后的结果也缓存：缓存期内不重写本机存储；过期后内容没变就沿用，变了才重新整理', async () => {
  const env = createEnv(); env.load(); seed(env);
  const c = client(env, 'alice');
  let writes = 0;
  const set = global.wx.setStorageSync;
  global.wx.setStorageSync = (k, v) => { writes++; set(k, v); };
  const first = [await c.db.fetchMatches(), await c.db.fetchMatchesAll(), await c.db.fetchPlayersFull()];
  const w1 = writes, n1 = c.calls();
  assert.ok(w1 > 0);
  first[0][0].a = ['改了也不影响缓存'];
  const again = [await c.db.fetchMatches(), await c.db.fetchMatchesAll(), await c.db.fetchPlayersFull()];
  assert.strictEqual(writes, w1); assert.strictEqual(c.calls(), n1);
  assert.notDeepStrictEqual(again[0][0].a, ['改了也不影响缓存']);
  // 过了缓存期：重新问云函数（1 次），内容没变 → 不重新整理、不写存储
  const memo = require(path.join(ROOT, 'utils/memo.js'));
  const realNow = Date.now; const t0 = realNow();
  try {
    Date.now = () => t0 + memo.TTL_MS + 1000;
    const third = [await c.db.fetchMatches(), await c.db.fetchMatchesAll(), await c.db.fetchPlayersFull()];
    assert.strictEqual(c.calls(), n1 + 1); assert.strictEqual(writes, w1);
    assert.deepStrictEqual(third, again);
    // 别人改了数据：指纹变了 → 拿到新数据
    env.coll('players').p_bob.name = 'Bobby';
    Date.now = () => t0 + 2 * memo.TTL_MS + 2000;
    const ps = await c.db.fetchPlayersFull();
    assert.ok(ps.some((p) => p.name === 'Bobby')); assert.ok(writes > w1);
    assert.ok((await c.db.fetchMatches()).some((m) => m.a.concat(m.b).indexOf('Bobby') >= 0), '战绩里的名字跟着账号走');
    // 本机缓存被清空后：即使内容没变也重新整理并写回
    const w2 = writes;
    require(path.join(ROOT, 'utils/member.js')).clearProtected();
    c.storage.member_ok_at = Date.now();
    await c.db.fetchMatches();
    assert.ok(writes > w2); assert.ok(c.db.cachedMatches().length > 0);
  } finally { Date.now = realNow; }
});
test('活动详情一次取齐（drawDetail）：1 次调用', async () => {
  const env = createEnv(); env.load(); seed(env);
  const c = client(env, 'alice');
  const r = await c.db.fetchDrawDetail('d1');
  assert.strictEqual(c.calls(), 1);
  assert.strictEqual(r.draw._id, 'd1'); assert.strictEqual(r.profile.name, 'Alice');
  assert.strictEqual(c.db.cachedProfile().name, 'Alice');
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
test('分页读取不先查总数：不满一页的集合只调用 1 次，超过一页的也能读全', async () => {
  const env = createEnv(); env.load(); seed(env);
  const c = client(env, 'alice');
  assert.strictEqual((await c.db.fetchDraws()).length, 1);
  assert.strictEqual(c.calls(), 1);
  for (let i = 0; i < 230; i++) env.put('signups', { _id: 's' + i, _openid: 'u' + i, drawId: 'd1', name: 'N' + i, createdAt: i });
  const n = c.calls();
  const su = await c.db.fetchSignups('d1');
  assert.strictEqual(su.length, 230);
  assert.deepStrictEqual(su.map((s) => s._id), Array.from({ length: 230 }, (_, i) => 's' + i));
  assert.strictEqual(c.calls() - n, 3);
});
test('我的报名：1 次调用，旧版云函数时分开读，结果一致；只读操作的缓存在写入后作废', async () => {
  const env = createEnv(); env.load(); seed(env);
  env.coll('draws').d1.status = 'signup'; env.coll('draws').d1.size = 8;
  await env.call('alice', 'signUp', { drawId: 'd1' });
  const c = client(env, 'alice');
  const a = await c.db.fetchMySignups();
  assert.strictEqual(c.calls(), 1); assert.strictEqual(a.length, 1);
  await c.db.fetchMySignups(); assert.strictEqual(c.calls(), 1, '缓存期内不重复调用');
  const cloud = require(path.join(ROOT, 'utils/cloud.js'));
  await cloud.cached('myTodos'); await cloud.cached('myTodos');
  assert.strictEqual(c.calls(), 2);
  await c.db.cancelSignup('d1'); // 写操作：全部作废
  const n = c.calls();
  assert.strictEqual((await c.db.fetchMySignups()).length, 0);
  await cloud.cached('myTodos');
  assert.strictEqual(c.calls(), n + 2);
  // 旧版云函数
  await env.call('alice', 'signUp', { drawId: 'd1' });
  const real = env.call;
  env.call = (uid, action, data) => (action === 'mySignups' ? Promise.resolve({ ok: false, error: '未知操作' }) : real(uid, action, data));
  const old = client(env, 'alice');
  assert.deepStrictEqual(await old.db.fetchMySignups(), await (async () => { env.call = real; return client(env, 'alice').db.fetchMySignups(); })());
});

test('原始 dataset 冻结后仍能整理；修改返回的嵌套数组不污染指纹复用的数据', async () => {
  const env = createEnv(); env.load(); seed(env);
  env.coll('players').p_bob.formerNames = ['Robert'];
  const c = client(env, 'alice');
  const memo = require('../utils/memo');
  const raw = memo.raw;
  let dataset;
  const freeze = (v) => { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
  memo.raw = (...args) => raw(...args).then((v) => { if (args[0] === 'dataset') { dataset = v; freeze(v); } return v; });
  const ms = await c.db.fetchMatchesAll();
  const ps = await c.db.fetchPlayersFull();
  const original = JSON.stringify(dataset);
  ms[0].sets[0].a = 999; ms[0].aRaw.push('污染');
  ps.find((p) => p.uid === 'bob').formerNames.push('污染');
  memo.invalidate();
  const again = await c.db.fetchMatchesAll();
  assert.notStrictEqual(again[0].sets[0].a, 999);
  assert.strictEqual(JSON.stringify(dataset), original);
  assert.ok(!(await c.db.fetchPlayersFull()).find((p) => p.uid === 'bob').formerNames.includes('污染'));
});
test('forget：未完成的数据集请求不能恢复已清空的整理结果和本机缓存', async () => {
  const env = createEnv(); env.load(); seed(env);
  const c = client(env, 'alice');
  const original = wx.cloud.callFunction;
  let release, started;
  const ready = new Promise((r) => { started = r; });
  wx.cloud.callFunction = async (args) => {
    const result = await original(args);
    if (args.data.action === 'dataset') { started(); await new Promise((r) => { release = r; }); }
    return result;
  };
  const pending = c.db.fetchMatches();
  await ready;
  c.db.forget(); release();
  await assert.rejects(pending, /缓存已清除/);
  assert.strictEqual(c.storage.cache_matches, undefined);
  assert.strictEqual(c.storage.cache_players_full, undefined);
  wx.cloud.callFunction = original;
  assert.ok((await c.db.fetchMatches()).length);
  assert.ok(c.storage.cache_matches.length);
});
test('draw-view：报名中和已出签表的 bundle / 旧路径渲染一致（包括被搭档带上）', async () => {
  for (const status of ['signup', 'drawn']) {
    const env = createEnv(); env.load(); seed(env);
    env.coll('draws').d1.status = status;
    env.put('signups', { _id: 's1', drawId: 'd1', _openid: 'bob', name: 'Bob', partner: 'Alice', partnerId: 'alice', createdAt: 1 });
    const render = async (old) => {
      client(env, 'alice');
      const call = wx.cloud.callFunction;
      if (old) wx.cloud.callFunction = (args) => args.data.action === 'drawDetail' ? Promise.resolve({ result: { ok: false, error: '未知操作' } }) : call(args);
      wx.setNavigationBarTitle = () => {};
      let definition;
      const previous = global.Page;
      global.Page = (d) => { definition = d; };
      const file = require.resolve('../pages/draw-view/draw-view'); delete require.cache[file];
      try { require(file); } finally { global.Page = previous; }
      const page = Object.assign({}, definition, { id: 'd1', data: JSON.parse(JSON.stringify(definition.data)), setData(p) { Object.assign(this.data, p); } });
      await page.load();
      await new Promise((r) => setImmediate(r)); // 旧路径的联系人、相册、申请分别异步加载
      assert.strictEqual(page.data.error, '');
      return JSON.parse(JSON.stringify(page.data));
    };
    const bundle = await render(false), old = await render(true);
    assert.deepStrictEqual(bundle, old);
    if (status === 'signup') assert.strictEqual(bundle.joined, true);
  }
});
test('新增只读接口不清缓存；cached 拒绝写操作，避免把写入结果缓存', async () => {
  const env = createEnv(); env.load(); seed(env);
  const c = client(env, 'alice');
  const memo = require('../utils/memo'), cloud = require('../utils/cloud');
  let calls = 0;
  const probe = () => memo.get('probe', memo.ANY, () => ++calls);
  await probe();
  for (const [action, data] of [['drawDetail', { drawId: 'd1' }], ['mySignups', {}], ['dataset', {}], ['matchState', { matchId: 'dm0', detail: true }]]) {
    await cloud.call(action, data); await probe(); assert.strictEqual(calls, 1, action);
  }
  const n = c.calls();
  assert.throws(() => cloud.cached('cancelSignup', { drawId: 'd1' }), /只读/);
  assert.strictEqual(c.calls(), n);
});

module.exports = T;
