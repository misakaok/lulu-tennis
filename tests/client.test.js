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
    // 异步写：和真机一样晚一点才落盘（下一轮事件循环），落盘时走 setStorageSync（方便统计写入次数）
    // 写进发起这次写入的那个客户端（不是之后测试换上的 global.wx）
    setStorage({ key, data, success }) { const w = this; setTimeout(() => { w.setStorageSync(key, data); if (success) success(); }, 0); },
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

const tick = () => new Promise((r) => setTimeout(r, 0)); // 等异步写落盘

function seed(env) {
  env.members([['alice', 'Alice'], ['bob', 'Bob'], ['carl', 'Carl']]);
  env.put('players', { _id: 'legacy', name: 'OldTimer', createdAt: 0 }); // 只有名字的历史球员
  env.put('draws', { _id: 'd1', _openid: 'alice', title: 'T', status: 'drawn', type: 'single', mode: 'bracket', size: 2, entrants: ['Alice', 'Bob'], lines: [{ name: 'Alice' }, { name: 'Bob' }] });
  for (let i = 0; i < 25; i++) {
    env.put('matches', { _id: 'dm' + i, _openid: i % 2 ? 'alice' : 'bob', a: [i % 2 ? 'Alice' : 'Bob'], b: [i % 2 ? 'Bob' : 'Carl'], aIds: [i % 2 ? 'alice' : 'bob'], bIds: [i % 2 ? 'bob' : 'carl'], winner: 'a', sets: [{ a: 4, b: i % 4 }], date: '2026-10-' + String(1 + (i % 28)).padStart(2, '0'), createdAt: i });
  }
  // 一部分有旧的战绩快照，一部分没有：日常比赛录入即生效，都算正式
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
  assert.ok(!all1.some((m) => m.status === 'pending'), '日常比赛录入即生效，没有待确认');
  assert.ok(m1.some((m) => m._id === 'dm1') && m1.some((m) => m._id === 'dm0'), '有没有快照都计入');
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
  await tick();
  const w1 = writes, n1 = c.calls();
  assert.ok(w1 > 0);
  first[0][0].a = ['改了也不影响缓存'];
  const again = [await c.db.fetchMatches(), await c.db.fetchMatchesAll(), await c.db.fetchPlayersFull()];
  await tick();
  assert.strictEqual(writes, w1); assert.strictEqual(c.calls(), n1);
  assert.notDeepStrictEqual(again[0][0].a, ['改了也不影响缓存']);
  // 过了缓存期：重新问云函数（1 次），内容没变 → 不重新整理、不写存储
  const memo = require(path.join(ROOT, 'utils/memo.js'));
  const realNow = Date.now; const t0 = realNow();
  try {
    Date.now = () => t0 + memo.TTL_MS + 1000;
    const third = [await c.db.fetchMatches(), await c.db.fetchMatchesAll(), await c.db.fetchPlayersFull()];
    await tick();
    assert.strictEqual(c.calls(), n1 + 1); assert.strictEqual(writes, w1);
    assert.deepStrictEqual(third, again);
    // 别人改了数据：指纹变了 → 拿到新数据
    env.coll('players').p_bob.name = 'Bobby';
    Date.now = () => t0 + 2 * memo.TTL_MS + 2000;
    const ps = await c.db.fetchPlayersFull();
    await tick();
    assert.ok(ps.some((p) => p.name === 'Bobby')); assert.ok(writes > w1);
    assert.ok((await c.db.fetchMatches()).some((m) => m.a.concat(m.b).indexOf('Bobby') >= 0), '战绩里的名字跟着账号走');
    // 本机缓存被清空后：即使内容没变也重新整理并写回
    const w2 = writes;
    require(path.join(ROOT, 'utils/member.js')).clearProtected();
    c.storage.member_ok_at = Date.now();
    await c.db.fetchMatches();
    await tick();
    assert.ok(writes > w2); assert.ok(c.db.cachedMatches().length > 0);
  } finally { Date.now = realNow; }
});
test('共享数据：数据没变时返回同一个数组（页面比较引用）；复制版和共享版内容一致、互不影响；内容变了才换新数组', async () => {
  const env = createEnv(); env.load(); seed(env);
  const c = client(env, 'alice');
  const [m1, a1, p1, d1] = [await c.db.matchesShared(), await c.db.matchesAllShared(), await c.db.playersShared(), await c.db.drawsShared()];
  assert.strictEqual(await c.db.matchesShared(), m1); assert.strictEqual(await c.db.matchesAllShared(), a1);
  assert.strictEqual(await c.db.playersShared(), p1); assert.strictEqual(await c.db.drawsShared(), d1);
  assert.deepStrictEqual(await c.db.fetchMatches(), m1); assert.deepStrictEqual(await c.db.fetchMatchesAll(), a1);
  assert.deepStrictEqual(await c.db.fetchPlayersFull(), p1); assert.deepStrictEqual(await c.db.fetchDraws(), d1);
  // 正式战绩和战绩列表里的正式记录是同一批对象
  const inAll = new Set(a1);
  assert.ok(m1.every((m) => inAll.has(m)));
  const copy = await c.db.fetchMatches();
  copy[0].a = ['改了'];
  assert.notDeepStrictEqual(m1[0].a, ['改了'], '改复制版不影响共享数据');
  // 本人资料：跟着球员列表走，不读本机存储
  const pf = c.db.profilesOf(p1);
  assert.strictEqual(pf.alice.name, 'Alice'); assert.strictEqual(c.db.profilesOf(p1), pf);
  // 过了缓存期，内容没变：仍是同一个数组，也不重写本机缓存
  await tick();
  let writes = 0;
  const set = global.wx.setStorageSync;
  global.wx.setStorageSync = (k, v) => { writes++; set(k, v); };
  const memo = require(path.join(ROOT, 'utils/memo.js'));
  const realNow = Date.now; const t0 = realNow();
  try {
    Date.now = () => t0 + memo.TTL_MS + 1000;
    assert.strictEqual(await c.db.matchesShared(), m1); assert.strictEqual(await c.db.playersShared(), p1);
    assert.strictEqual(await c.db.drawsShared(), d1);
    for (let i = 0; i < 5; i++) await c.db.fetchDraws();
    await tick();
    assert.strictEqual(writes, 0, '内容没变不写本机缓存（活动列表以前每次读取都重写）');
    // 内容变了：新数组
    env.coll('players').p_bob.name = 'Bobby';
    env.coll('draws').d1.title = '新名称';
    Date.now = () => t0 + 2 * memo.TTL_MS + 2000;
    assert.notStrictEqual(await c.db.matchesShared(), m1); assert.notStrictEqual(await c.db.playersShared(), p1);
    const d2 = await c.db.drawsShared();
    assert.notStrictEqual(d2, d1); assert.strictEqual(d2[0].title, '新名称');
  } finally { Date.now = realNow; global.wx.setStorageSync = set; }
});
test('本机缓存：比赛只存一份（cache_matches_all），异步写；cachedMatches 从里面去掉待确认的；清空后晚到的写入被删掉', async () => {
  const env = createEnv(); env.load(); seed(env);
  const c = client(env, 'alice');
  c.storage.cache_matches = [{ _id: 'old' }]; // 以前版本留下的
  const official = await c.db.fetchMatches();
  assert.strictEqual(c.storage.cache_matches_all, undefined, '异步写：还没落盘');
  await tick();
  assert.strictEqual(c.storage.cache_matches, undefined, '旧的重复缓存删掉');
  assert.deepStrictEqual(c.db.cachedMatches().map((m) => m._id).sort(), official.map((m) => m._id).sort());
  assert.strictEqual(c.db.cachedMatchesAll().length, (await c.db.fetchMatchesAll()).length);
  // 写入还没落盘时缓存被清空（成员资格被取消）：落盘后删掉
  const c2 = client(env, 'alice');
  await c2.db.fetchMatches();
  require(path.join(ROOT, 'utils/member.js')).clearProtected();
  await tick();
  assert.strictEqual(c2.storage.cache_matches_all, undefined);
  assert.strictEqual(c2.storage.cache_players_full, undefined);
});
test('共享数据只读：各页面用到的统计、等级、亮点、生涯、活动进度计算都不会改动它', async () => {
  const env = createEnv(); env.load(); seed(env);
  const c = client(env, 'alice');
  const [m, all, p, d] = [await c.db.matchesShared(), await c.db.matchesAllShared(), await c.db.playersShared(), await c.db.drawsShared()];
  const before = JSON.stringify([m, all, p, d, c.db.profilesOf(p)]);
  const R = require(path.join(ROOT, 'utils/rating.js')), S = require(path.join(ROOT, 'utils/stats.js'));
  const H = require(path.join(ROOT, 'utils/highlight.js')), PV = require(path.join(ROOT, 'utils/player.js'));
  const E = require(path.join(ROOT, 'utils/event.js')), SE = require(path.join(ROOT, 'utils/season.js'));
  const { computeRank } = require(path.join(ROOT, 'utils/rules.js'));
  const st = S.playerStats(m, p);
  H.matchTags(m, st.ratings); S.boards(m, st.ratings, 'all', '2026-10'); S.genderFinder(p);
  computeRank(SE.inSeason(m, '2026'), 'all'); R.computeRatings(m, R.startLevelsFrom(p));
  const v = PV.playerView(c.db.profilesOf(p), p, m, 'alice');
  PV.h2hView(m, 'alice', 'Alice', 'bob', 'Bob', v.tagsOf);
  d.forEach((x) => { E.progressOf(x, m); E.scheduleOf(x, m); });
  // 活动详情、活动录分页（2026-11-24 起用共享版）：对阵、场次冲突、退赛／弃权、找某一场
  const SC = require(path.join(ROOT, 'utils/slot-conflict.js')), WV = require(path.join(ROOT, 'utils/withdraw-view.js'));
  d.forEach((x) => {
    const items = E.scheduleOf(x, m);
    WV.withdrawView(x, items, () => true);
    items.forEach((it) => { E.findFixture(x, m, it.key); SC.slotConflicts(x, m, {}, it.key, { date: x.date || '2026-11-29', time: '09:00', court: '1 号场' }); });
  });
  assert.strictEqual(JSON.stringify([m, all, p, d, c.db.profilesOf(p)]), before);
});
test('cloud.fresh / peek：实时读一次并留给 cached / peek（60 秒内同步取到复制版）；只能用于只读操作', async () => {
  const env = createEnv(); env.load(); seed(env);
  const c = client(env, 'alice');
  const memo = require(path.join(ROOT, 'utils/memo.js')); memo.invalidate();
  const cloud = require(path.join(ROOT, 'utils/cloud.js'));
  assert.strictEqual(cloud.peek('memberStatus'), undefined);
  const n0 = c.calls();
  const r = await cloud.fresh('memberStatus');
  assert.strictEqual(c.calls(), n0 + 1);
  const pk = cloud.peek('memberStatus');
  assert.deepStrictEqual(pk, r); pk.status = '改了';
  assert.notStrictEqual(cloud.peek('memberStatus').status, '改了');
  await cloud.cached('memberStatus');
  assert.strictEqual(c.calls(), n0 + 1, 'cached 直接用 fresh 留下的');
  await cloud.fresh('memberStatus');
  assert.strictEqual(c.calls(), n0 + 2, 'fresh 每次都实时读');
  await assert.rejects(cloud.fresh('signUp', { drawId: 'd1' }), /只有只读操作/);
  memo.invalidate();
  assert.strictEqual(cloud.peek('memberStatus'), undefined);
});
test('活动详情一次取齐（drawDetail）：1 次调用', async () => {
  const env = createEnv(); env.load(); seed(env);
  const c = client(env, 'alice');
  const r = await c.db.fetchDrawDetail('d1');
  assert.strictEqual(c.calls(), 1);
  assert.strictEqual(r.draw._id, 'd1'); assert.strictEqual(r.profile.name, 'Alice');
  assert.strictEqual(c.db.cachedProfile().name, 'Alice');
  // 录分页先用它画出来：同步取到复制版，不再调用；改了不影响下一次；任何写操作、下拉刷新都作废
  const peek = c.db.peekDrawDetail('d1');
  assert.strictEqual(c.calls(), 1);
  assert.deepStrictEqual(peek, r);
  peek.draw.title = '改了'; r.draw.title = '也改了';
  assert.notStrictEqual(c.db.peekDrawDetail('d1').draw.title, '改了');
  assert.strictEqual(c.db.peekDrawDetail('other'), null);
  require(path.join(ROOT, 'utils/memo.js')).invalidate(['signups']);
  assert.strictEqual(c.db.peekDrawDetail('d1'), null);
});
test('旧云函数和本机缓存：保留手动活动名称、历史名称快照，场地只展示固定编号', async () => {
  const env = createEnv(); env.load(); seed(env);
  Object.assign(env.coll('draws').d1, { date: '2026-11-14', title: '旧自由活动名称', venue: '旧自由球场名称', location: { latitude: 31, longitude: 121, name: '旧地图名', address: '旧地址' } });
  env.coll('matches').ev1.drawTitle = '旧自由活动名称';
  const results = [];
  for (const oldCloud of [false, true]) {
    const c = client(env, 'alice', { oldCloud });
    // 模拟尚未部署新云函数时，下发的活动和比分仍带旧文字。
    const call = wx.cloud.callFunction;
    wx.cloud.callFunction = async (args) => {
      const r = await call(args), d = args.data, out = r.result;
      if (!out.ok) return r;
      if (d.action === 'drawDetail') out.draw = JSON.parse(JSON.stringify(env.coll('draws').d1));
      if (d.action === 'data' && d.coll === 'draws') out.data = d.op === 'doc' ? env.coll('draws').d1 : [env.coll('draws').d1];
      const list = d.action === 'dataset' ? out.matches : d.action === 'data' && d.coll === 'matches' ? (Array.isArray(out.data) ? out.data : [out.data]) : [];
      (list || []).forEach((m) => { if (m && m.drawId) m.drawTitle = '旧自由活动名称'; });
      return r;
    };
    c.storage.cache_draws = [env.coll('draws').d1];
    c.storage.cache_matches_all = [env.coll('matches').ev1];
    const before = JSON.stringify(c.storage.cache_draws);
    for (const d of [c.db.cachedDraws()[0], (await c.db.fetchDraws())[0], await c.db.getDraw('d1'), (await c.db.fetchDrawDetail('d1')).draw]) {
      assert.strictEqual(d.title, '旧自由活动名称'); assert.strictEqual(d.venue, '');
      assert.deepStrictEqual(d.location, { latitude: 31, longitude: 121 });
    }
    assert.ok(before.includes('旧自由活动名称'));
    for (const m of [c.db.cachedMatches()[0], c.db.cachedMatchesAll()[0], await c.db.getMatch('ev1')]) {
      assert.strictEqual(m.drawTitle, '旧自由活动名称');
    }
    const all = await c.db.fetchMatchesAll();
    assert.strictEqual(all.find((m) => m._id === 'ev1').drawTitle, '旧自由活动名称');
    results.push(all);
  }
  assert.deepStrictEqual(results[0], results[1]);
});
test('写入后缓存作废：新录的日常比赛马上能看到', async () => {
  const env = createEnv(); env.load(); seed(env);
  const c = client(env, 'alice');
  const before = (await c.db.fetchMatchesAll()).length;
  const n = c.calls();
  await c.db.fetchMatchesAll();
  assert.strictEqual(c.calls(), n, '缓存期内不重复调用');
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = 'alice';
  try {
  await c.db.addMatch({ type: 'single', a: ['Alice'], b: ['Carl'], aIds: ['alice'], bIds: ['carl'], winner: 'a', sets: [{ a: 4, b: 0 }], date: '2026-11-05' });
  } finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
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
  await cloud.cached('ping'); await cloud.cached('ping');
  assert.strictEqual(c.calls(), 2);
  await c.db.cancelSignup('d1'); // 写操作：全部作废
  const n = c.calls();
  assert.strictEqual((await c.db.fetchMySignups()).length, 0);
  await cloud.cached('ping');
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
  await tick(); // 等异步写落盘
  assert.strictEqual(c.storage.cache_matches_all, undefined);
  assert.strictEqual(c.storage.cache_players_full, undefined);
  wx.cloud.callFunction = original;
  assert.ok((await c.db.fetchMatches()).length);
  await tick();
  assert.ok(c.storage.cache_matches_all.length);
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
      await new Promise((r) => setImmediate(r)); // 旧路径的申请异步加载
      assert.strictEqual(page.data.error, '');
      return JSON.parse(JSON.stringify(page.data));
    };
    const bundle = await render(false), old = await render(true);
    assert.deepStrictEqual(bundle, old);
    if (status === 'signup') assert.strictEqual(bundle.joined, true);
  }
});
test('删除活动：返回列表先去掉刚删的活动；只重新读活动和报名，战绩、球员沿用缓存', async () => {
  const env = createEnv(); env.load(); seed(env);
  const c = client(env, 'alice');
  const draws = await c.db.drawsShared();
  await c.db.matchesShared(); await c.db.playersShared();
  await tick();
  assert.ok(draws.some((d) => d._id === 'd1') && c.storage.cache_draws.some((d) => d._id === 'd1'));
  const other = draws.filter((d) => d._id !== 'd1');
  assert.strictEqual(c.db.withoutRemoved(other), other, '没有要去掉的，原样返回同一个数组');
  await c.db.removeDraw('d1');
  const kept = c.db.withoutRemoved(draws);
  assert.ok(kept !== draws && !kept.some((d) => d._id === 'd1'));
  await tick();
  assert.ok(!c.storage.cache_draws.some((d) => d._id === 'd1'), '本机缓存也去掉');
  const n = c.calls();
  await c.db.matchesShared(); await c.db.playersShared();
  assert.strictEqual(c.calls(), n, '战绩、球员不用重新拉');
  assert.ok(!(await c.db.drawsShared()).some((d) => d._id === 'd1'), '活动列表重新读取');
  assert.ok(c.calls() > n);
  // 撤回删除：首页提示条的数据、撤回后列表重新出现、提示条消失
  assert.strictEqual(c.db.recentRemoved().id, 'd1');
  await c.db.restoreDraw('d1');
  assert.strictEqual(c.db.recentRemoved(), null);
  assert.strictEqual(c.db.withoutRemoved(draws), draws, '撤回后不再从列表里去掉');
  assert.ok((await c.db.drawsShared()).some((d) => d._id === 'd1'), '撤回后活动列表重新读到');
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
