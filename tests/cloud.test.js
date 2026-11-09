// 云函数 tennis 的权限与业务规则测试（在内存数据库里跑真实代码）
const assert = require('assert');
const createEnv = require('./mock-cloud');
const D = require('../utils/draw');

const T = [];
const test = (name, fn) => T.push({ name, fn });
const ok = (r) => { assert.ok(r && r.ok, JSON.stringify(r)); return r; };
const no = (r, re) => { assert.strictEqual(r && r.ok, false, '应该被拒绝：' + JSON.stringify(r)); if (re) assert.match(r.error, re); return r; };

function setup() {
  const env = createEnv();
  env.load();
  env.members([['alice', 'Alice'], ['bob', 'Bob'], ['eve', 'Eve'], ['owner', 'Owner'], ['carl', 'Carl']]);
  env.put('draws', { _id: 'd1', _openid: 'owner', title: 'T', status: 'signup', type: 'single', mode: 'bracket', size: 8 });
  env.put('draws', { _id: 'd2', _openid: 'owner', title: 'D', status: 'signup', type: 'double', mode: 'bracket', size: 4 });
  return env;
}

/* ---------- 报名 ---------- */
test('报名：网关不能直接写 signups', async () => {
  const env = setup();
  no(await env.call('eve', 'data', { op: 'add', coll: 'signups', data: { drawId: 'd1', name: 'Alice' } }));
});
test('报名：参赛名取本人资料，重复提交只有一条', async () => {
  const env = setup();
  ok(await env.call('alice', 'signUp', { drawId: 'd1', name: 'Hacker' }));
  const r = ok(await env.call('alice', 'signUp', { drawId: 'd1' }));
  assert.ok(r.already);
  const su = Object.values(env.coll('signups'));
  assert.strictEqual(su.length, 1);
  assert.strictEqual(su[0].name, 'Alice');
  assert.strictEqual(su[0]._openid, 'alice');
});
test('报名：昵称和别人重复时拒绝（即使资料被绕过前端改过）', async () => {
  const env = setup();
  ok(await env.call('alice', 'signUp', { drawId: 'd1' }));
  env.coll('players').p_eve.name = 'Alice';
  no(await env.call('eve', 'signUp', { drawId: 'd1' }), /重复/);
});
test('报名：搭档按 ID 校验（名字取搭档资料、非成员 / 已报名拒绝）', async () => {
  const env = setup();
  ok(await env.call('eve', 'signUp', { drawId: 'd2', partnerId: 'bob' }));
  assert.strictEqual(Object.values(env.coll('signups')).find((s) => s.drawId === 'd2').partner, 'Bob');
  no(await env.call('alice', 'signUp', { drawId: 'd2', partnerId: 'nobody' }), /正式成员/);
  no(await env.call('alice', 'signUp', { drawId: 'd2', partnerId: 'bob' }), /已经报名/);
  no(await env.call('bob', 'cancelSignup', { drawId: 'd2' }), /搭档/);
  assert.strictEqual(ok(await env.call('eve', 'cancelSignup', { drawId: 'd2' })).removed, 1);
});
test('报名：签表生成后不能报名也不能直接取消', async () => {
  const env = setup();
  ok(await env.call('alice', 'signUp', { drawId: 'd1' }));
  env.coll('draws').d1.status = 'drawn';
  no(await env.call('alice', 'cancelSignup', { drawId: 'd1' }), /退赛/);
  no(await env.call('bob', 'signUp', { drawId: 'd1' }), /截止/);
});

/* ---------- 撤销 ---------- */
const daily = (env, uid, opp, extra) => env.call(uid, 'data', { op: 'add', coll: 'matches', data: Object.assign({ a: ['N'], b: ['M'], aIds: [uid], bIds: [opp], winner: 'a', sets: [{ a: 4, b: 2 }], date: '2026-11-01' }, extra) });
test('撤销：网关不能直接改 / 删比赛', async () => {
  const env = setup();
  const id = ok(await daily(env, 'alice', 'bob'))._id;
  no(await env.call('alice', 'data', { op: 'remove', coll: 'matches', id }));
  no(await env.call('alice', 'data', { op: 'update', coll: 'matches', id, data: { winner: 'b' } }));
});
test('撤销：已确认的日常比赛不能单方面撤销；未确认的可以并留档', async () => {
  const env = setup();
  const id = ok(await daily(env, 'alice', 'bob'))._id;
  assert.ok(ok(await env.call('bob', 'confirmResult', { matchId: id })).confirmed);
  no(await env.call('alice', 'revokeMatch', { matchId: id }), /申请修改比分/);
  no(await env.call('eve', 'revokeMatch', { matchId: id }));
  const id2 = ok(await daily(env, 'alice', 'bob', { sets: [{ a: 4, b: 1 }] }))._id;
  assert.strictEqual(ok(await env.call('alice', 'revokeMatch', { matchId: id2 })).removed, 1);
  assert.ok(!env.coll('matches')[id2]);
  assert.ok(Object.values(env.coll('requests')).some((x) => x.type === 'revoke' && x.matchId === id2));
});
test('撤销：已确认的赛事比分只有发起人能撤销，必须填原因', async () => {
  const env = setup();
  env.coll('draws').d1.status = 'drawn';
  env.put('signups', { _id: 'sa', _openid: 'alice', drawId: 'd1', name: 'Alice' });
  env.put('signups', { _id: 'sb', _openid: 'bob', drawId: 'd1', name: 'Bob' });
  env.put('matches', { _id: 'ev1', drawId: 'd1', drawKey: 'k1-0', a: ['Alice'], b: ['Bob'], winner: 'a', sets: [{ a: 4, b: 2 }], outcome: 'normal', recordedBy: 'alice', createdAt: 1 });
  assert.ok(ok(await env.call('bob', 'confirmResult', { matchId: 'ev1' })).confirmed);
  no(await env.call('alice', 'revokeMatch', { matchId: 'ev1' }), /申请修改比分/);
  assert.ok(ok(await env.call('owner', 'revokeMatch', { matchId: 'ev1' })).needReason);
  assert.ok(env.coll('matches').ev1);
  ok(await env.call('owner', 'revokeMatch', { matchId: 'ev1', reason: '录错场次', confirmImpact: true }));
  assert.ok(!env.coll('matches').ev1);
  assert.ok(Object.values(env.coll('requests')).some((x) => x.type === 'revoke' && x.reason === '录错场次'));
});

/* ---------- 个人资料 ---------- */
test('资料：网关不能改资料，也不能新增本人资料', async () => {
  const env = setup();
  no(await env.call('eve', 'data', { op: 'update', coll: 'players', id: 'p_eve', data: { name: 'Alice' } }));
  ok(await env.call('eve', 'data', { op: 'add', coll: 'players', data: { name: 'Zed', self: true, formerNames: ['x'] } }));
  const added = Object.values(env.coll('players')).find((p) => p.name === 'Zed');
  assert.ok(!added.self && !added.formerNames, '只能存名字');
});
test('资料：服务端检查重名、旧昵称，改名记录旧昵称', async () => {
  const env = setup();
  no(await env.call('eve', 'saveProfile', { name: 'Alice' }), /已经被其他球友使用/);
  ok(await env.call('alice', 'saveProfile', { name: 'Alicia', level: 3, gender: 'f' }));
  assert.deepStrictEqual(env.coll('players').p_alice.formerNames, ['Alice']);
  no(await env.call('eve', 'saveProfile', { name: 'Alice' }), /以前用过/);
  ok(await env.call('alice', 'saveProfile', { name: 'Alice' })); // 自己的旧昵称可以改回来
  no(await env.call('eve', 'saveProfile', { name: '12345678901' }), /最多/);
});
test('资料：照片只认本人 avatars 目录', async () => {
  const env = setup();
  no(await env.call('eve', 'saveProfile', { name: 'Eve', avatar: 'cloud://env1.x/avatars/alice/a.jpg' }), /照片/);
  no(await env.call('eve', 'saveProfile', { name: 'Eve', avatar: 'cloud://env1.x/event-photos/d1/eve/a.jpg' }), /照片/);
  ok(await env.call('eve', 'saveProfile', { name: 'Eve', avatar: 'cloud://env1.x/avatars/eve/1-a.jpg' }));
  // 沿用原来的照片（旧路径）也可以
  env.coll('players').p_eve.avatar = 'cloud://env1.x/avatars/unknown/old.jpg';
  ok(await env.call('eve', 'saveProfile', { name: 'Eve', avatar: 'cloud://env1.x/avatars/unknown/old.jpg' }));
});
test('资料：新用户第一次保存会创建本人资料', async () => {
  const env = setup();
  env.put('members', { _id: 'new', status: 'active' });
  ok(await env.call('new', 'saveProfile', { name: 'Newbie', level: 2.5 }));
  const p = Object.values(env.coll('players')).find((x) => x._openid === 'new');
  assert.ok(p.self && p.name === 'Newbie' && p.level === 2.5);
});

/* ---------- 赛事 ---------- */
const settings = { mode: 'bracket', type: 'single', size: 4, setGames: 4, noAd: true, bestOf: 1, rules: { ko: { setGames: 4, noAd: true, bestOf: 1 }, rounds: {} } };
test('赛事：网关不能直接写 draws', async () => {
  const env = setup();
  no(await env.call('owner', 'data', { op: 'update', coll: 'draws', id: 'd1', data: { withdrawals: [] } }));
  no(await env.call('owner', 'data', { op: 'add', coll: 'draws', data: { title: 'x' } }));
  no(await env.call('owner', 'data', { op: 'remove', coll: 'draws', id: 'd1' }));
});
test('赛事：发布 → 报名 → 生成签表（用真实的抽签结果），uidOf 只认能证明的对应', async () => {
  const env = setup();
  const id = ok(await env.call('owner', 'createDraw', { draw: Object.assign({ title: '周末赛', date: '2026-11-20', withdrawals: [{ x: 1 }] }, settings) })).id;
  const d = env.coll('draws')[id];
  assert.strictEqual(d.status, 'signup'); assert.strictEqual(d._openid, 'owner'); assert.ok(!d.withdrawals);
  ok(await env.call('alice', 'signUp', { drawId: id }));
  ok(await env.call('bob', 'signUp', { drawId: id }));
  const ents = ['Alice', 'Bob', 'Carl'];
  const draw = { entrants: ents, seeds: [], teams: {}, lines: D.makeBracket(ents, [], 4), uidOf: { Alice: 'alice', Bob: 'bob', Carl: 'carl' }, avatars: {} };
  no(await env.call('alice', 'generateDraw', { drawId: id, draw }), /发起人/);
  // 伪造：把 Carl 指向 eve 的账号 → 不绑定
  ok(await env.call('owner', 'generateDraw', { drawId: id, draw: Object.assign({}, draw, { uidOf: { Alice: 'alice', Bob: 'bob', Carl: 'eve' } }) }));
  assert.deepStrictEqual(env.coll('draws')[id].uidOf, { Alice: 'alice', Bob: 'bob' });
  ok(await env.call('owner', 'generateDraw', { drawId: id, draw }));
  const g = env.coll('draws')[id];
  assert.strictEqual(g.status, 'drawn'); assert.strictEqual(g.lines.length, 4); assert.strictEqual(g.uidOf.Carl, 'carl');
  // 有比分后不能重新生成
  env.put('matches', { _id: 'ev_x', drawId: id, drawKey: 'k1-0', a: ['Alice'], b: ['Bob'], winner: 'a', sets: [{ a: 4, b: 1 }], outcome: 'normal', createdAt: 1 });
  no(await env.call('owner', 'generateDraw', { drawId: id, draw }), /录分/);
});
test('赛事：小组赛签表用真实分组结果；名单不一致时拒绝', async () => {
  const env = setup();
  const s = Object.assign({}, settings, { mode: 'groups', groupCount: 2, advance: 1 });
  const ents = ['A1', 'A2', 'A3', 'A4'];
  const id = ok(await env.call('owner', 'createDraw', { draw: Object.assign({ title: 'G', entrants: ents, seeds: [], teams: {}, groups: D.makeGroups(ents, [], 2), uidOf: {} }, s) })).id;
  assert.strictEqual(env.coll('draws')[id].status, 'drawn');
  no(await env.call('owner', 'createDraw', { draw: Object.assign({ entrants: ents, groups: D.makeGroups(['A1', 'A2', 'A3', 'X'], [], 2) }, s) }), /签位|小组/);
});
test('赛事：编辑信息只改允许的字段', async () => {
  const env = setup();
  ok(await env.call('owner', 'updateDrawInfo', { drawId: 'd1', info: { title: '新名字', date: '2026-12-01', venue: '球场', status: 'drawn', location: { latitude: 1, longitude: 2, name: 'n' } } }));
  const d = env.coll('draws').d1;
  assert.strictEqual(d.title, '新名字'); assert.strictEqual(d.status, 'signup'); assert.strictEqual(d.location.latitude, 1);
  no(await env.call('alice', 'updateDrawInfo', { drawId: 'd1', info: { title: 'x' } }), /发起人/);
});
test('赛事：删除是软删除，列表不再返回，联系人和照片删除，申请作废', async () => {
  const env = setup();
  env.put('event_contacts', { _id: 'd1', name: 'x', phone: '123456' });
  env.put('requests', { _id: 'wd_1', type: 'withdraw', drawId: 'd1', status: 'pending' });
  [['p1', 'd1', 'alice/1'], ['p2', 'd1', 'bob/2'], ['p3', 'd1', 'bob/3'], ['p9', 'd2', 'eve/9']].forEach(([id, d, f]) => env.put('event_photos', { _id: id, drawId: d, fileID: `cloud://env1.x/event-photos/${d}/${f}.jpg`, status: 'pass' }));
  env.deleteFails = ['cloud://env1.x/event-photos/d1/bob/3.jpg'];
  no(await env.call('alice', 'removeDraw', { drawId: 'd1' }), /发起人/);
  ok(await env.call('owner', 'removeDraw', { drawId: 'd1' }));
  assert.ok(env.coll('draws').d1.deleted);
  assert.ok(!env.coll('event_contacts').d1);
  assert.strictEqual(env.coll('requests').wd_1.status, 'cancelled');
  assert.deepStrictEqual(env.deletedFiles.sort(), ['cloud://env1.x/event-photos/d1/alice/1.jpg', 'cloud://env1.x/event-photos/d1/bob/2.jpg']);
  assert.deepStrictEqual(Object.keys(env.coll('event_photos')).sort(), ['p3', 'p9'], '删除失败的和别的赛事的照片记录保留');
  const log = Object.values(env.coll('requests')).find((x) => x.type === 'deleteDraw');
  assert.deepStrictEqual(log.photos.failedFiles, ['cloud://env1.x/event-photos/d1/bob/3.jpg']);
  const list = ok(await env.call('alice', 'data', { op: 'get', coll: 'draws' })).data;
  assert.ok(list.every((x) => x._id !== 'd1'));
  assert.strictEqual(ok(await env.call('alice', 'data', { op: 'count', coll: 'draws' })).total, 1);
  no(await env.call('alice', 'data', { op: 'doc', coll: 'draws', id: 'd1' }));
  no(await env.call('alice', 'signUp', { drawId: 'd1' }), /删除/);
});

/* ---------- 成员管理 ---------- */
test('成员管理：环境变量里的管理员总在「成员」里（即使以前申请过 / 被移除过）', async () => {
  const env = setup();
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = 'boss,veg,ghost';
  try {
    env.put('players', { _id: 'p_veg', _openid: 'veg', self: true, name: '花椰菜', createdAt: 9 });
    env.put('members', { _id: 'veg', status: 'pending', name: '花椰菜', appliedAt: 1 }); // 先申请过，后来被设成管理员
    env.put('members', { _id: 'boss', status: 'removed', reason: 'x' });
    const d = ok(await env.call('boss', 'listMembers'));
    const act = d.active.filter((x) => x.admin).map((x) => x.uid).sort();
    assert.deepStrictEqual(act, ['boss', 'ghost', 'veg']);
    assert.strictEqual(d.active.find((x) => x.uid === 'veg').nickname, '花椰菜');
    assert.ok(!d.pending.some((x) => x.uid === 'veg') && !d.others.some((x) => x.uid === 'boss'));
    assert.strictEqual(d.active.find((x) => x.uid === 'ghost').uidTail, 'ghost'); // 没有资料的显示 ID 尾号
    assert.strictEqual(d.adminConfig.count, 3);
    // 同一账号有重复资料时，取最早的那条（和其他页面一致），与数据库返回顺序无关
    env.put('players', { _id: 'a_dup', _openid: 'veg', self: true, name: '旧的重复资料', createdAt: 99 });
    const keys = Object.keys(env.coll('players'));
    const reordered = {}; ['a_dup'].concat(keys.filter((k) => k !== 'a_dup')).forEach((k) => { reordered[k] = env.coll('players')[k]; });
    env.store.players = reordered;
    const d3 = ok(await env.call('boss', 'listMembers'));
    assert.strictEqual(d3.active.find((x) => x.uid === 'veg').nickname, '花椰菜');
    assert.strictEqual(d.adminConfig.items.find((x) => x.tail === 'veg').nickname, '花椰菜');
    no(await env.call('alice', 'listMembers'), /管理员/);
    // 中文逗号、引号也能识别
    process.env.ADMIN_OPENIDS = '"boss"，veg；ghost';
    const d2 = ok(await env.call('boss', 'listMembers'));
    assert.deepStrictEqual(d2.active.filter((x) => x.admin).map((x) => x.uid).sort(), ['boss', 'ghost', 'veg']);
    assert.ok(d2.adminConfig.fullWidth);
    assert.ok(ok(await env.call('veg', 'memberStatus')).isAdmin);
  } finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
});

/* ---------- 邀请码、日期 ---------- */
test('邀请码：过期 / 撤销的不会被占用', async () => {
  const env = setup();
  env.put('invites', { _id: 'old', usedBy: '', revoked: false, expiresAt: Date.now() - 1000 });
  env.put('invites', { _id: 'rev', usedBy: '', revoked: true, expiresAt: Date.now() + 1e6 });
  env.put('invites', { _id: 'good', usedBy: '', revoked: false, expiresAt: Date.now() + 1e6 });
  no(await env.call('x1', 'acceptInvite', { code: 'old' }), /过期/);
  assert.strictEqual(env.coll('invites').old.usedBy, '');
  no(await env.call('x1', 'acceptInvite', { code: 'rev' }), /过期/);
  ok(await env.call('x1', 'acceptInvite', { code: 'good' }));
  assert.strictEqual(env.coll('members').x1.status, 'active');
  no(await env.call('x2', 'acceptInvite', { code: 'good' }), /已被使用/);
});
test('日期：默认日期按北京时间（UTC 早上也不会变成前一天）', async () => {
  const env = setup();
  env.coll('draws').d1.status = 'drawn';
  env.coll('draws').d1.entrants = ['Alice', 'Bob'];
  env.coll('draws').d1.lines = [{ name: 'Alice' }, { name: 'Bob' }];
  env.coll('draws').d1.size = 2;
  env.put('signups', { _id: 'sa', _openid: 'alice', drawId: 'd1', name: 'Alice' });
  env.put('signups', { _id: 'sb', _openid: 'bob', drawId: 'd1', name: 'Bob' });
  const realNow = Date.now;
  Date.now = () => Date.UTC(2026, 10, 9, 23, 30); // 北京时间 11 月 10 日 07:30
  try {
    const r = ok(await env.call('alice', 'recordEventMatch', { drawId: 'd1', key: '0-0', sets: [{ a: 4, b: 2 }] }));
    assert.strictEqual(env.coll('matches')[r.matchId].date, '2026-11-10');
  } finally { Date.now = realNow; }
});

/* ---------- 列表接口：批量查询的结果要和逐场计算一致 ---------- */
test('待办：myTodos 和逐场 matchState 结果一致，查询次数不随比赛数线性增长', async () => {
  const env = setup();
  const ids = [];
  for (let i = 0; i < 30; i++) {
    const r = ok(await daily(env, i % 2 ? 'alice' : 'bob', i % 2 ? 'bob' : 'alice', { sets: [{ a: 4, b: i % 3 }], date: '2026-10-' + (10 + (i % 20)) }));
    ids.push(r._id);
    if (i % 3 === 0) ok(await env.call(i % 2 ? 'bob' : 'alice', 'confirmResult', { matchId: r._id }));
  }
  const todo = ok(await env.call('alice', 'myTodos'));
  const budget = env.queries;
  const expect = [];
  for (const id of ids) { const s = ok(await env.call('alice', 'matchState', { matchId: id })); if (s.canConfirm) expect.push(id); }
  assert.deepStrictEqual(todo.toConfirm.map((x) => x.matchId).sort(), expect.sort());
  assert.ok(budget < 40, `myTodos 查询次数 ${budget}，应该是固定的少量批量查询`);
});

module.exports = T;
