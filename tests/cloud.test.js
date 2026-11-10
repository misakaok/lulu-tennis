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
test('撤销：已确认的活动比分只有发起人能撤销，必须填原因', async () => {
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

/* ---------- 活动 ---------- */
const settings = { mode: 'bracket', type: 'single', size: 4, setGames: 4, noAd: true, bestOf: 1, rules: { ko: { setGames: 4, noAd: true, bestOf: 1 }, rounds: {} } };
test('活动：网关不能直接写 draws', async () => {
  const env = setup();
  no(await env.call('owner', 'data', { op: 'update', coll: 'draws', id: 'd1', data: { withdrawals: [] } }));
  no(await env.call('owner', 'data', { op: 'add', coll: 'draws', data: { title: 'x' } }));
  no(await env.call('owner', 'data', { op: 'remove', coll: 'draws', id: 'd1' }));
});
test('活动：创建 → 报名 → 生成签表（用真实的抽签结果），uidOf 只认能证明的对应', async () => {
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
test('活动：小组赛签表用真实分组结果；名单不一致时拒绝', async () => {
  const env = setup();
  const s = Object.assign({}, settings, { mode: 'groups', groupCount: 2, advance: 1 });
  const ents = ['A1', 'A2', 'A3', 'A4'];
  const id = ok(await env.call('owner', 'createDraw', { draw: Object.assign({ title: 'G', entrants: ents, seeds: [], teams: {}, groups: D.makeGroups(ents, [], 2), uidOf: {} }, s) })).id;
  assert.strictEqual(env.coll('draws')[id].status, 'drawn');
  no(await env.call('owner', 'createDraw', { draw: Object.assign({ entrants: ents, groups: D.makeGroups(['A1', 'A2', 'A3', 'X'], [], 2) }, s) }), /签位|小组/);
});
test('活动：编辑信息只改允许的字段', async () => {
  const env = setup();
  ok(await env.call('owner', 'updateDrawInfo', { drawId: 'd1', info: { title: '新名字', date: '2026-12-01', venue: '球场', status: 'drawn', location: { latitude: 1, longitude: 2, name: 'n' } } }));
  const d = env.coll('draws').d1;
  assert.strictEqual(d.title, '新名字'); assert.strictEqual(d.status, 'signup'); assert.strictEqual(d.location.latitude, 1);
  no(await env.call('alice', 'updateDrawInfo', { drawId: 'd1', info: { title: 'x' } }), /发起人/);
});
test('活动：删除是软删除，列表不再返回，联系人和照片删除，申请作废', async () => {
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
  assert.deepStrictEqual(Object.keys(env.coll('event_photos')).sort(), ['p3', 'p9'], '删除失败的和别的活动的照片记录保留');
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
    assert.ok(!Object.prototype.hasOwnProperty.call(d, 'adminConfig'), '不再返回管理员配置诊断数据');
    // 同一账号有重复资料时，取最早的那条（和其他页面一致），与数据库返回顺序无关
    env.put('players', { _id: 'a_dup', _openid: 'veg', self: true, name: '旧的重复资料', createdAt: 99 });
    const keys = Object.keys(env.coll('players'));
    const reordered = {}; ['a_dup'].concat(keys.filter((k) => k !== 'a_dup')).forEach((k) => { reordered[k] = env.coll('players')[k]; });
    env.store.players = reordered;
    const d3 = ok(await env.call('boss', 'listMembers'));
    assert.strictEqual(d3.active.find((x) => x.uid === 'veg').nickname, '花椰菜');
    no(await env.call('alice', 'listMembers'), /管理员/);
    // 中文逗号、引号也能识别
    process.env.ADMIN_OPENIDS = '"boss"，veg；ghost';
    const d2 = ok(await env.call('boss', 'listMembers'));
    assert.deepStrictEqual(d2.active.filter((x) => x.admin).map((x) => x.uid).sort(), ['boss', 'ghost', 'veg']);
    assert.ok(!Object.prototype.hasOwnProperty.call(d2, 'adminConfig'));
    assert.ok(ok(await env.call('veg', 'memberStatus')).isAdmin);
  } finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
});

test('数据核对：找出冒名报名、搭档名字不符、同活动同名；曾用名不算问题；只有管理员能用', async () => {
  const env = setup();
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = 'owner';
  try {
    env.coll('players').p_bob.formerNames = ['Bobby'];
    env.put('signups', { _id: 's1', _openid: 'alice', drawId: 'd1', name: 'Alice' });               // 正常
    env.put('signups', { _id: 's2', _openid: 'bob', drawId: 'd1', name: 'Bobby' });                 // 曾用名，正常
    env.put('signups', { _id: 's3', _openid: 'eve', drawId: 'd1', name: 'Carl' });                  // 冒名
    env.put('signups', { _id: 's4', _openid: 'carl', drawId: 'd2', name: 'Carl', partner: 'Bob', partnerId: 'eve' }); // 搭档名字不符
    env.put('signups', { _id: 's5', _openid: 'carl', drawId: 'd1', name: 'Carl' });                 // 和 s3 同活动同名
    const r = ok(await env.call('owner', 'auditSignups'));
    assert.strictEqual(r.total, 5);
    const has = (id, re) => r.issues.some((x) => x.id.startsWith(id) && re.test(x.problem));
    assert.ok(has('s3', /对不上/)); assert.ok(has('s4', /搭档/)); assert.ok(has('s3', /同一活动/)); assert.ok(has('s5', /同一活动/));
    assert.ok(!r.issues.some((x) => x.id.startsWith('s1') || x.id.startsWith('s2')));
    no(await env.call('alice', 'auditSignups'), /管理员/);
  } finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
});
test('活动申请列表：申请人昵称批量取，只看自己的（发起人看全部）', async () => {
  const env = setup();
  env.coll('draws').d1.status = 'drawn';
  env.put('requests', { _id: 'r1', type: 'withdraw', drawId: 'd1', requesterId: 'alice', status: 'pending', createdAt: 1 });
  env.put('requests', { _id: 'r2', type: 'withdraw', drawId: 'd1', requesterId: 'bob', status: 'pending', createdAt: 2 });
  const o = ok(await env.call('owner', 'drawRequests', { drawId: 'd1' }));
  assert.deepStrictEqual(o.list.map((x) => x.requester), ['Bob', 'Alice']);
  const a = ok(await env.call('alice', 'drawRequests', { drawId: 'd1' }));
  assert.deepStrictEqual(a.list.map((x) => x.id), ['r1']);
});
test('相册数量：只数审核通过的', async () => {
  const env = setup();
  ['pass', 'pass', 'checking', 'reject'].forEach((st, i) => env.put('event_photos', { _id: 'ph' + i, drawId: 'd1', status: st }));
  assert.strictEqual(ok(await env.call('alice', 'eventPhotoCount', { drawId: 'd1' })).count, 2);
});

test('清空战绩：默认关闭、要口令、只有管理员；只删战绩相关的数据', async () => {
  const env = setup();
  const old = [process.env.ADMIN_OPENIDS, process.env.ALLOW_RESET_SCORES];
  process.env.ADMIN_OPENIDS = 'owner';
  try {
    const id = ok(await daily(env, 'alice', 'bob'))._id;
    ok(await env.call('bob', 'confirmResult', { matchId: id }));
    env.put('reviews', { _id: 'rv', matchId: id, reviewerId: 'alice', targetId: 'bob' });
    env.put('requests', { _id: 'sc_x', type: 'score', status: 'pending' });
    env.put('requests', { _id: 'wd_x', type: 'withdraw', drawId: 'd1', status: 'pending' });
    env.put('bios', { _id: 'alice', bio: 'hi' });
    env.coll('draws').d1.results = { old: 1 };
    no(await env.call('owner', 'resetScores', { confirm: '清空全部战绩' }), /默认关闭/);
    process.env.ALLOW_RESET_SCORES = 'yes';
    no(await env.call('owner', 'resetScores', { confirm: '清空' }), /口令/);
    no(await env.call('alice', 'resetScores', { confirm: '清空全部战绩' }), /管理员/);
    const r = ok(await env.call('owner', 'resetScores', { confirm: '清空全部战绩' }));
    assert.deepStrictEqual([r.counts.matches, r.counts.confirms, r.counts.reviews, r.counts.requests], [1, 1, 1, 1]);
    assert.strictEqual(Object.keys(env.coll('matches')).length, 0);
    assert.deepStrictEqual(Object.keys(env.coll('verified')), ['__legacy_migrated__'], '保留迁移标记');
    assert.ok(env.coll('requests').wd_x, '退赛申请保留');
    assert.deepStrictEqual(env.coll('draws').d1.results, {});
    assert.ok(env.coll('draws').d2 && env.coll('members').alice && env.coll('players').p_alice && env.coll('bios').alice, '活动、成员、资料、简介保留');
    assert.ok(Object.values(env.coll('requests')).some((x) => x.type === 'resetScores'), '留档');
    // 清空后排行、待办正常
    assert.strictEqual(ok(await env.call('alice', 'myTodos')).toConfirm.length, 0);
  } finally {
    if (old[0] === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old[0];
    if (old[1] === undefined) delete process.env.ALLOW_RESET_SCORES; else process.env.ALLOW_RESET_SCORES = old[1];
  }
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

/* ---------- 活动详情一次取齐 ---------- */
test('drawDetail：各部分和原来分开调用的结果一致；联系人可见范围不变；非成员、已删除的活动拿不到', async () => {
  const env = setup();
  ok(await env.call('alice', 'signUp', { drawId: 'd1' }));
  ok(await env.call('bob', 'signUp', { drawId: 'd1' }));
  ok(await env.call('owner', 'saveContact', { drawId: 'd1', contact: { name: '王教练', phone: '13800000000', wechat: 'wx1', visibility: 'participants' } }));
  env.put('event_photos', { _id: 'ph1', drawId: 'd1', status: 'pass' });
  env.put('event_photos', { _id: 'ph2', drawId: 'd1', status: 'checking' });
  for (const u of ['alice', 'eve', 'owner']) {
    const r = ok(await env.call(u, 'drawDetail', { drawId: 'd1' }));
    assert.strictEqual(r.draw._id, 'd1');
    assert.deepStrictEqual(r.signups.map((s) => s._openid), ['alice', 'bob']);
    assert.strictEqual(r.profile._openid, u);
    const c = ok(await env.call(u, 'getContact', { drawId: 'd1' }));
    delete c.ok;
    assert.deepStrictEqual(r.contact, c);
    assert.strictEqual(r.photoCount, ok(await env.call(u, 'eventPhotoCount', { drawId: 'd1' })).count);
    assert.strictEqual(r.requests, null, '报名阶段没有退赛申请');
  }
  assert.strictEqual(ok(await env.call('alice', 'drawDetail', { drawId: 'd1' })).contact.phone, '13800000000');
  assert.strictEqual(ok(await env.call('eve', 'drawDetail', { drawId: 'd1' })).contact.phone, undefined, '没报名的人看不到电话');
  // 签表生成后带上退赛申请（和 drawRequests 一致）
  env.coll('draws').d1.status = 'drawn';
  const rq = ok(await env.call('alice', 'drawRequests', { drawId: 'd1' }));
  delete rq.ok;
  assert.deepStrictEqual(ok(await env.call('alice', 'drawDetail', { drawId: 'd1' })).requests, rq);
  // 非成员、已删除、不存在
  const out = await env.call('stranger', 'drawDetail', { drawId: 'd1' });
  assert.strictEqual(out.code, 'NOT_MEMBER');
  env.coll('draws').d1.deleted = true;
  no(await env.call('alice', 'drawDetail', { drawId: 'd1' }), /不存在/);
  no(await env.call('alice', 'drawDetail', { drawId: 'nope' }), /不存在/);
});

test('mySignups：返回自己报的和被搭档带上的，不含别人的', async () => {
  const env = setup();
  ok(await env.call('alice', 'signUp', { drawId: 'd1' }));
  ok(await env.call('bob', 'signUp', { drawId: 'd2', partnerId: 'alice' }));
  ok(await env.call('eve', 'signUp', { drawId: 'd1' }));
  const r = ok(await env.call('alice', 'mySignups'));
  assert.deepStrictEqual(r.list.map((s) => s.drawId).sort(), ['d1', 'd2']);
  assert.ok(r.list.every((s) => s._openid === 'alice' || s.partnerId === 'alice'));
  assert.strictEqual((await env.call('stranger', 'mySignups')).code, 'NOT_MEMBER');
});
test('matchState（detail）：顺带返回比赛记录和状态；不带 detail 时不返回', async () => {
  const env = setup();
  env.put('matches', { _id: 'm1', _openid: 'alice', a: ['Alice'], b: ['Bob'], aIds: ['alice'], bIds: ['bob'], winner: 'a', sets: [{ a: 4, b: 1 }], date: '2026-11-01', createdAt: 5 });
  const plain = ok(await env.call('bob', 'matchState', { matchId: 'm1' }));
  assert.ok(!('match' in plain) && !('status' in plain));
  const d = ok(await env.call('bob', 'matchState', { matchId: 'm1', detail: true }));
  assert.strictEqual(d.match._id, 'm1'); assert.strictEqual(d.status, 'pending');
  ['match', 'status'].forEach((k) => delete d[k]);
  assert.deepStrictEqual(d, plain);
  ok(await env.call('bob', 'confirmResult', { matchId: 'm1' }));
  assert.strictEqual(ok(await env.call('bob', 'matchState', { matchId: 'm1', detail: true })).status, 'official');
  delete env.coll('verified').m1; // 两方已确认，但快照因旧数据等原因缺失：本次查询会补齐
  assert.strictEqual(ok(await env.call('bob', 'matchState', { matchId: 'm1', detail: true })).status, 'official');
  const gone = ok(await env.call('bob', 'matchState', { matchId: 'nope', detail: true }));
  assert.strictEqual(gone.match, null); assert.strictEqual(gone.status, '');
});

test('drawDetail：超过 1000 条报名也读全；退赛申请严格保持原有可见范围', async () => {
  const env = setup();
  for (let i = 1004; i >= 0; i--) env.put('signups', { _id: 's' + i, drawId: 'd1', _openid: 'u' + i, createdAt: i });
  const r = ok(await env.call('owner', 'drawDetail', { drawId: 'd1' }));
  assert.strictEqual(r.signups.length, 1005);
  assert.strictEqual(r.signups[0]._id, 's0');
  assert.strictEqual(r.signups[1004]._id, 's1004');
  env.coll('draws').d1.status = 'drawn';
  for (const uid of ['alice', 'bob']) env.put('requests', { _id: uid, drawId: 'd1', requesterId: uid, type: 'withdraw', status: 'pending', reason: uid, createdAt: 1 });
  for (const uid of ['owner', 'alice', 'eve']) {
    const b = ok(await env.call(uid, 'drawDetail', { drawId: 'd1' }));
    const old = ok(await env.call(uid, 'drawRequests', { drawId: 'd1' })); delete old.ok;
    assert.deepStrictEqual(b.requests, old);
    assert.strictEqual(b.requests.list.length, uid === 'owner' ? 2 : uid === 'alice' ? 1 : 0);
  }
});
test('matchState：弃权退赛也返回发起人身份；detail 不绕过成员校验', async () => {
  const env = setup();
  for (const outcome of ['walkover', 'retired']) {
    env.put('matches', { _id: 'special', drawId: 'd1', drawKey: '0-0', outcome, recordedBy: 'alice', a: ['Alice'], b: ['Bob'], aIds: ['alice'], bIds: ['bob'], winner: 'a', sets: [{ a: 4, b: 0 }] });
    assert.strictEqual(ok(await env.call('owner', 'matchState', { matchId: 'special', detail: true })).isOwner, true);
    assert.strictEqual(ok(await env.call('alice', 'matchState', { matchId: 'special', detail: true })).isOwner, false);
  }
  for (const action of ['matchState', 'dataset', 'drawDetail', 'mySignups']) {
    assert.strictEqual((await env.call('stranger', action, { matchId: 'special', drawId: 'd1', detail: true })).code, 'NOT_MEMBER');
  }
});

test('管理员可以编辑 / 删除别人的活动：留档；删除必须填原因；其他活动操作仍然不行', async () => {
  const env = setup();
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = 'admin';
  try {
    env.put('members', { _id: 'admin', status: 'active' });
    env.put('draws', { _id: 'd9', _openid: 'owner', title: '周末赛', status: 'signup', type: 'single', mode: 'bracket', size: 4 });
    env.put('event_contacts', { _id: 'd9', name: '张三', phone: '13800000000', visibility: 'participants' });
    // 普通成员不行
    no(await env.call('alice', 'updateDrawInfo', { drawId: 'd9', info: { title: 'x' } }));
    no(await env.call('alice', 'removeDraw', { drawId: 'd9', reason: '不要了' }));
    // 管理员编辑：成功、留档；能看到完整联系人并修改；手填的地址不再保存
    ok(await env.call('admin', 'updateDrawInfo', { drawId: 'd9', info: { title: '周末赛（改期）', date: '2026-11-22', venue: '新球场', address: '某某路 1 号' } }));
    assert.strictEqual(env.coll('draws').d9.title, '周末赛（改期）');
    assert.strictEqual(env.coll('draws').d9.address, undefined);
    const log = Object.values(env.coll('requests')).find((x) => x.type === 'adminEditDraw');
    assert.strictEqual(log.before.title, '周末赛'); assert.strictEqual(log.after.venue, '新球场');
    assert.strictEqual(ok(await env.call('admin', 'getContact', { drawId: 'd9' })).phone, '13800000000');
    ok(await env.call('admin', 'saveContact', { drawId: 'd9', contact: { name: '李四', phone: '13900000000' } }));
    // 管理员不能生成签表、处理退赛
    no(await env.call('admin', 'generateDraw', { drawId: 'd9', draw: {} }), /发起人/);
    no(await env.call('admin', 'handleWithdraw', { drawId: 'd9', entrant: 'x', approve: true, reason: '测试一下' }), /发起人/);
    // 管理员删除：必须填原因
    no(await env.call('admin', 'removeDraw', { drawId: 'd9' }), /原因/);
    ok(await env.call('admin', 'removeDraw', { drawId: 'd9', reason: '重复发布了' }));
    assert.ok(env.coll('draws').d9.deleted && env.coll('draws').d9.deletedByAdmin);
    const dl = Object.values(env.coll('requests')).find((x) => x.type === 'deleteDraw');
    assert.ok(dl.byAdmin && dl.reason === '重复发布了');
    // 发起人自己删除不需要原因
    env.put('draws', { _id: 'd8', _openid: 'owner', title: 'T', status: 'signup', type: 'single', mode: 'bracket', size: 4 });
    ok(await env.call('owner', 'removeDraw', { drawId: 'd8' }));
  } finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
});

test('订阅消息已移除：没有 notifyTemplates 操作；录分、申请、审核照常', async () => {
  const env = setup();
  assert.strictEqual((await env.call('alice', 'notifyTemplates')).error, '未知操作');
  const id = ok(await env.call('alice', 'data', { op: 'add', coll: 'matches', data: { a: ['Alice'], b: ['Bob'], aIds: ['alice'], bIds: ['bob'], winner: 'a', sets: [{ a: 4, b: 2 }], date: '2026-11-01' } }))._id;
  ok(await env.call('bob', 'confirmResult', { matchId: id }));
  ok(await env.call('bob', 'requestScoreChange', { matchId: id, sets: [{ a: 4, b: 1 }], reason: '记错了' }));
  ok(await env.call('alice', 'respondScoreChange', { requestId: 'sc_' + id, accept: true }));
  ok(await env.call('newbie', 'applyMember', { name: '新人' }));
});

/* ---------- 单场安排 ---------- */
test('单场安排：只有发起人能排；待定场次也能排；清空即取消；重新生成签表后作废', async () => {
  const env = setup();
  const ents = ['Alice', 'Bob', 'Carl', 'Eve'];
  env.put('draws', { _id: 'd5', _openid: 'owner', title: '周末赛', status: 'drawn', type: 'single', mode: 'bracket', size: 4, date: '2026-11-21', entrants: ents, lines: ents.map((n) => ({ name: n })) });
  no(await env.call('alice', 'setFixtureSlot', { drawId: 'd5', key: '0-0', slot: { time: '09:00' } }), /发起人/);
  no(await env.call('owner', 'setFixtureSlot', { drawId: 'd5', key: '9-9', slot: { time: '09:00' } }), /找不到/);
  no(await env.call('owner', 'setFixtureSlot', { drawId: 'd1', key: '0-0', slot: { time: '09:00' } }), /签表生成后/);
  // 只收合法的日期、时间；场地限长；别的字段不收
  const r = ok(await env.call('owner', 'setFixtureSlot', { drawId: 'd5', key: '0-0', slot: { date: '2026-11-22', time: '9点', court: ' 3 号场 ', hack: 1 } }));
  assert.deepStrictEqual(r.slot, { date: '2026-11-22', time: '', court: '3 号场' });
  ok(await env.call('owner', 'setFixtureSlot', { drawId: 'd5', key: '1-0', slot: { time: '15:30' } })); // 决赛对阵还没定，也能先排
  assert.deepStrictEqual(Object.keys(env.coll('draws').d5.slots).sort(), ['0-0', '1-0']);
  // 赛程里带出安排（前端和云函数共用 utils/event.js）
  const E = require('../utils/event');
  const sch = E.scheduleOf(Object.assign({}, env.coll('draws').d5), []);
  assert.strictEqual(sch.find((x) => x.key === '0-0').slotText, '11月22日 周日 · 3 号场');
  assert.strictEqual(sch.find((x) => x.key === '1-0').slotText, '15:30');
  assert.strictEqual(sch.find((x) => x.key === '0-1').slot, null);
  // 三项都空：取消这一场的安排
  assert.strictEqual(ok(await env.call('owner', 'setFixtureSlot', { drawId: 'd5', key: '0-0', slot: {} })).slot, null);
  assert.deepStrictEqual(Object.keys(env.coll('draws').d5.slots), ['1-0']);
  // 重新生成签表：原来的安排作废
  ok(await env.call('owner', 'generateDraw', { drawId: 'd5', draw: { entrants: ents, seeds: [], teams: {}, lines: D.makeBracket(ents, [], 4), uidOf: {}, avatars: {} } }));
  assert.deepStrictEqual(env.coll('draws').d5.slots, {});
});

/* ---------- 关注 ---------- */
test('关注：只能关注有资料的正式成员，不能关注自己；重复关注只有一条；只公开人数', async () => {
  const env = setup();
  no(await env.call('alice', 'setFollow', { targetId: 'alice' }), /自己/);
  no(await env.call('alice', 'setFollow', { targetId: 'nobody' }), /正式成员/);
  env.put('members', { _id: 'ghost', status: 'active' }); // 是成员但没设置资料
  no(await env.call('alice', 'setFollow', { targetId: 'ghost' }), /资料/);
  assert.strictEqual((await env.call('stranger', 'setFollow', { targetId: 'bob' })).code, 'NOT_MEMBER');
  ok(await env.call('alice', 'setFollow', { targetId: 'bob' }));
  ok(await env.call('alice', 'setFollow', { targetId: 'bob' }));
  ok(await env.call('alice', 'setFollow', { targetId: 'carl' }));
  ok(await env.call('eve', 'setFollow', { targetId: 'bob' }));
  assert.strictEqual(Object.keys(env.coll('follows')).length, 3);
  assert.ok(Object.values(env.coll('follows')).every((f) => f.followerId && f.targetId && !f._openid));
  // 我自己：关注了谁、多少人关注我
  const mine = ok(await env.call('alice', 'followInfo'));
  assert.deepStrictEqual(mine.following.slice().sort(), ['bob', 'carl']);
  assert.strictEqual(mine.followers, 0);
  assert.strictEqual(mine.target, undefined);
  // 看别人的主页：只有粉丝数和「我有没有关注」，拿不到 TA 关注了谁、谁关注了 TA
  const bob = ok(await env.call('carl', 'followInfo', { uid: 'bob' }));
  assert.deepStrictEqual(bob.target, { uid: 'bob', followers: 2, following: false });
  assert.deepStrictEqual(bob.following, []);
  assert.strictEqual(ok(await env.call('alice', 'followInfo', { uid: 'bob' })).target.following, true);
  // 取消关注（没关注过也不报错）
  ok(await env.call('alice', 'setFollow', { targetId: 'bob', on: false }));
  ok(await env.call('alice', 'setFollow', { targetId: 'bob', on: false }));
  assert.strictEqual(ok(await env.call('bob', 'followInfo')).followers, 1);
  // 网关读不到 follows
  no(await env.call('alice', 'data', { op: 'get', coll: 'follows' }));
});

module.exports = T;
