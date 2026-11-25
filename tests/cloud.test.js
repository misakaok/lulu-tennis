// 云函数 tennis 的权限与业务规则测试（在内存数据库里跑真实代码）
const assert = require('assert');
const createEnv = require('./mock-cloud');
const D = require('../utils/draw');

const T = [];
const test = (name, fn) => T.push({ name, fn });
const ok = (r) => { assert.ok(r && r.ok, JSON.stringify(r)); return r; };
const no = (r, re) => { assert.strictEqual(r && r.ok, false, '应该被拒绝：' + JSON.stringify(r)); if (re) assert.match(r.error, re); return r; };

// 既有创建／发布用例明确授予本次调用管理员身份，不改变其他成员权限测试。
async function adminCall(env, uid, action, data) {
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = [old || '', uid].join(',');
  try { return await env.call(uid, action, data); }
  finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
}

function setup() {
  const env = createEnv();
  env.load();
  env.members([['alice', 'Alice'], ['bob', 'Bob'], ['eve', 'Eve'], ['owner', 'Owner'], ['carl', 'Carl']]);
  env.put('draws', { _id: 'd1', _openid: 'owner', title: 'T', status: 'signup', type: 'single', mode: 'bracket', size: 8 });
  env.put('draws', { _id: 'd2', _openid: 'owner', title: 'D', status: 'signup', type: 'double', mode: 'bracket', size: 4 });
  return env;
}

test('活动发布：只有云端配置的管理员可创建；伪造身份和旧活动所有者都不能绕过', async () => {
  const env = setup();
  const before = JSON.stringify(env.coll('draws'));
  const checks = env.textChecks.length;
  for (const uid of ['alice', 'owner']) {
    no(await env.call(uid, 'createDraw', { draw: { title: '越权发布', mode: 'bracket', size: 8 }, isAdmin: true, ownerId: 'admin', openid: 'admin' }), /管理员/);
    no(await env.call(uid, 'createDraw', { draw: { title: '直接生成', entrants: ['Alice', 'Bob'], lines: [{ name: 'Alice' }, { name: 'Bob' }] } }), /管理员/);
    no(await env.call(uid, 'generateDraw', { drawId: 'd1', draw: {} }), /管理员/);
    no(await env.call(uid, 'updateDrawInfo', { drawId: 'd1', info: { title: '修改公开名称' } }), /管理员/);
    no(await env.call(uid, 'data', { op: 'add', coll: 'draws', data: { title: '绕过网关' } }));
    no(await env.call(uid, 'data', { op: 'update', coll: 'draws', id: 'd1', data: { title: '绕过网关' } }));
  }
  assert.strictEqual(JSON.stringify(env.coll('draws')), before);
  assert.strictEqual(env.textChecks.length, checks, '在内容检测和任何写入之前拒绝越权发布');
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = 'admin';
  try {
    const id = ok(await env.call('admin', 'createDraw', { draw: { title: '管理员活动', mode: 'bracket', size: 8 } })).id;
    assert.strictEqual(env.coll('draws')[id]._openid, 'admin');
    ok(await env.call('alice', 'drawDetail', { drawId: id }));
    ok(await env.call('alice', 'signUp', { drawId: id }));
    assert.strictEqual(ok(await env.call('alice', 'cancelSignup', { drawId: id })).removed, 1);
    // 权限撤销立即生效，不依赖前端缓存或以前创建过活动。
    delete process.env.ADMIN_OPENIDS;
    no(await env.call('admin', 'createDraw', { draw: { title: '已撤销管理员' } }));
  } finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
});

test('报名中改规则：保留报名和搭档，扩大名额后候补递补，生成对阵后锁定', async () => {
  const env = setup();
  env.coll('draws').d2.size = 2;
  env.put('signups', { _id: 's1', drawId: 'd2', _openid: 'alice', name: 'Alice', partner: 'Bob', partnerId: 'bob' });
  env.put('signups', { _id: 's2', drawId: 'd2', _openid: 'carl', name: 'Carl', partner: 'Eve', partnerId: 'eve' });
  env.put('signups', { _id: 's3', drawId: 'd2', _openid: 'owner', name: 'Owner' });
  const E = require('../utils/event');
  const signups = Object.values(env.coll('signups'));
  assert.deepStrictEqual(E.waitingOf(signups, E.capacityOf(env.coll('draws').d2)), { s3: 1 });
  const before = JSON.stringify(signups);
  const args = { drawId: 'd2', settingsVersion: 0, settings: { mode: 'groups', groupCount: 1, limit: 6, type: 'single' } };
  no(await env.call('owner', 'updateDrawSettings', args), /管理员/);
  ok(await adminCall(env, 'carl', 'updateDrawSettings', args));
  const d = env.coll('draws').d2;
  assert.deepStrictEqual([d.mode, d.type, d.limit, d.settingsVersion], ['groups', 'double', 6, 1]);
  assert.deepStrictEqual(E.waitingOf(signups, E.capacityOf(d)), {});
  assert.strictEqual(JSON.stringify(Object.values(env.coll('signups'))), before);
  no(await adminCall(env, 'carl', 'updateDrawSettings', args), /已有更新/);
  const teams = { 'Alice / Bob': ['Alice', 'Bob'], 'Carl / Eve': ['Carl', 'Eve'] };
  const entrants = Object.keys(teams);
  const draw = { teams, entrants, groups: [{ members: entrants.map((name) => ({ name })) }] };
  no(await adminCall(env, 'owner', 'generateDraw', { drawId: 'd2', draw }), /已有更新/);
  ok(await adminCall(env, 'owner', 'generateDraw', { drawId: 'd2', draw: { ...draw, settingsVersion: 1 } }));
  assert.strictEqual(env.coll('draws').d2.status, 'drawn');
  no(await adminCall(env, 'carl', 'updateDrawSettings', { ...args, settingsVersion: 1 }), /对阵生成后/);

  env.coll('draws').d1.cup = { kind: 'weekly' };
  // 报名中改规则：周赛也能改成单淘汰 16 签或循环＋淘汰（和创建同一套校验），改成分组循环不行
  no(await adminCall(env, 'carl', 'updateDrawSettings', { drawId: 'd1', settingsVersion: 0, settings: { mode: 'groups', groupCount: 2 } }), /周赛要有最后一轮/);
  ok(await adminCall(env, 'carl', 'updateDrawSettings', { drawId: 'd1', settingsVersion: 0, settings: { mode: 'bracket', size: 16 } }));
  assert.deepStrictEqual([env.coll('draws').d1.size, env.coll('draws').d1.cup], [16, { kind: 'weekly' }]);
  ok(await adminCall(env, 'carl', 'updateDrawSettings', { drawId: 'd1', settingsVersion: 1, settings: { mode: 'groups_ko', groupCount: 2, advance: 2 } }));
  assert.strictEqual(env.coll('draws').d1.mode, 'groups_ko');
});

test('管理员补录外部双打：代报名、调整对阵、为实际球员录分并计入水平分', async () => {
  const env = setup();
  env.coll('draws').d2.size = 2;
  const drawId = 'd2';
  const signup = { drawId, playerId: 'alice', partnerId: 'bob' };
  no(await env.call('eve', 'adminAddSignup', { ...signup, isAdmin: true }), /管理员/);
  no(await adminCall(env, 'admin', 'adminAddSignup', { ...signup, playerId: 'stranger' }), /正式成员/);
  ok(await adminCall(env, 'admin', 'adminAddSignup', signup));
  assert.strictEqual(ok(await adminCall(env, 'admin', 'adminAddSignup', signup)).already, true);
  no(await adminCall(env, 'admin', 'adminAddSignup', { ...signup, playerId: 'bob', partnerId: '' }), /已经/);
  ok(await adminCall(env, 'admin', 'adminAddSignup', { drawId, playerId: 'carl', partnerId: 'eve' }));
  assert.deepStrictEqual(Object.values(env.coll('signups')).map((s) => [s._openid, s.partnerId]), [['alice', 'bob'], ['carl', 'eve']]);
  const teams = { 'Alice / Bob': ['Alice', 'Bob'], 'Carl / Eve': ['Carl', 'Eve'] };
  const entrants = Object.keys(teams);
  const draw = { entrants, teams, lines: entrants.map((name) => ({ name })), rosterVersion: 2,
    uidOf: { Alice: 'alice', Bob: 'bob', Carl: 'carl', Eve: 'eve' } };
  no(await env.call('eve', 'generateDraw', { drawId, draw, manual: true }), /管理员/);
  no(await adminCall(env, 'admin', 'generateDraw', { drawId, draw }), /发起人/);
  no(await adminCall(env, 'admin', 'generateDraw', { drawId, draw: { ...draw, rosterVersion: 1 }, manual: true }), /名单已有更新/);
  ok(await adminCall(env, 'admin', 'generateDraw', { drawId, draw, manual: true }));
  const key = require('../utils/event').scheduleOf(env.coll('draws').d2, []).find((f) => f.ready).key;
  env.coll('draws').d2.slots = { [key]: { date: '2026-11-22', time: '10:00' } };
  no(await adminCall(env, 'admin', 'adminAddSignup', { drawId, playerId: 'owner' }), /报名已截止/);
  const reordered = { ...draw, drawVersion: 1, lines: draw.lines.slice().reverse() };
  ok(await adminCall(env, 'admin', 'generateDraw', { drawId, draw: reordered, manual: true }));
  assert.deepStrictEqual(env.coll('draws').d2.lines, reordered.lines);
  assert.strictEqual(env.coll('draws').d2.slots[key].time, '10:00');
  const score = { drawId, key, date: '2026-11-22', sets: [{ a: 4, b: 2 }], drawVersion: 2 };
  no(await adminCall(env, 'admin', 'recordEventMatch', { ...score, drawVersion: 1 }), /对阵已更新/);
  const { matchId } = ok(await adminCall(env, 'admin', 'recordEventMatch', score));
  const record = env.coll('matches')[matchId];
  assert.deepStrictEqual([record.aIds, record.bIds, record.recordedBy, record.date], [['carl', 'eve'], ['alice', 'bob'], 'admin', score.date]);
  const { matches } = ok(await env.call('alice', 'dataset'));
  const ratings = require('../utils/rating').computeRatings(matches);
  assert.strictEqual(Object.keys(ratings.deltas[matchId]).length, 4);
  assert.ok(Object.values(ratings.deltas[matchId]).some((n) => n !== 0));
  no(await adminCall(env, 'admin', 'generateDraw', { drawId, draw: { ...reordered, drawVersion: 2 }, manual: true }), /录分/);
  assert.deepStrictEqual(Object.values(env.coll('requests')).map((r) => r.type),
    ['adminAddSignup', 'adminAddSignup', 'manualDraw', 'manualDraw', 'adminRecordEventMatch']);
});

test('日常比赛：普通成员可以记录自己参加的比赛（不用管理员），参赛双方可直接改分；锁定后对方确认，无须管理员', async () => {
  const env = setup();
  const payload = { op: 'add', coll: 'matches', isAdmin: true, openid: 'owner', data: { type: 'single', date: '2026-11-01', a: ['Alice'], b: ['Bob'], aIds: ['alice'], bIds: ['bob'], winner: 'a', sets: [{ a: 4, b: 2 }] } };
  // 不在这场里的人（客户端冒充身份字段也没用）不能录；不是正式成员不能录
  no(await env.call('eve', 'data', payload), /自己参加/);
  no(await env.call('stranger', 'data', payload));
  assert.strictEqual(Object.keys(env.coll('matches')).length, 0);
  const id = ok(await env.call('alice', 'data', payload))._id;
  const rec = env.coll('matches')[id];
  assert.strictEqual(rec._openid, 'alice'); assert.ok(!rec.isAdmin && !rec.openid);
  assert.ok(ok(await env.call('bob', 'dataset')).matches.some((m) => m._id === id)); // 录入即计入
  for (const uid of ['alice', 'bob']) assert.strictEqual(ok(await env.call(uid, 'matchState', { matchId: id })).canEdit, true);
  const before = JSON.stringify(env.coll('matches')[id]);
  assert.strictEqual(ok(await env.call('eve', 'matchState', { matchId: id })).canEdit, false);
  no(await env.call('eve', 'editMatchScore', { matchId: id, sets: [{ a: 1, b: 4 }], isAdmin: true, openid: 'alice' }), /参加者/);
  assert.strictEqual(JSON.stringify(env.coll('matches')[id]), before);
  ok(await env.call('bob', 'editMatchScore', { matchId: id, sets: [{ a: 1, b: 4 }] }));
  assert.strictEqual(env.coll('matches')[id].winner, 'b');
  const changes = Object.values(env.coll('requests')).filter((x) => x.type === 'edit');
  assert.strictEqual(changes.length, 1); assert.strictEqual(changes[0].by, 'bob');
  assert.strictEqual(ok(await env.call('alice', 'dataset')).matches.find((m) => m._id === id).winner, 'b');
  ok(await env.call('alice', 'editMatchScore', { matchId: id, sets: [{ a: 4, b: 2 }] }));
  ok(await env.call('bob', 'confirmResult', { matchId: id }));
  no(await env.call('alice', 'editMatchScore', { matchId: id, sets: [{ a: 1, b: 4 }] }), /锁定/);
  const req = ok(await env.call('bob', 'requestScoreChange', { matchId: id, sets: [{ a: 1, b: 4 }], reason: '比分录反了' }));
  no(await env.call('eve', 'respondScoreChange', { requestId: req.requestId, accept: true }), /对方球员/);
  ok(await env.call('alice', 'respondScoreChange', { requestId: req.requestId, accept: true }));
  assert.strictEqual(env.coll('matches')[id].winner, 'b');
  assert.strictEqual(env.coll('requests')[req.requestId].status, 'accepted');
});

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
// 日常录分测试夹具仅在写入时授予管理员，后续权限仍按原用户校验。
const daily = (env, uid, opp, extra) => adminCall(env, uid, 'data', { op: 'add', coll: 'matches', data: Object.assign({ type: 'single', a: ['N'], b: ['M'], aIds: [uid], bIds: [opp], winner: 'a', sets: [{ a: 4, b: 2 }], date: '2026-11-01' }, extra) });
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
  ok(await env.call('owner', 'revokeMatch', { matchId: 'ev1', reason: '录错了场次', confirmImpact: true }));
  assert.ok(!env.coll('matches').ev1);
  assert.ok(Object.values(env.coll('requests')).some((x) => x.type === 'revoke' && x.reason === '录错了场次'));
});

test('管理员更正比分：日常和活动比赛都能改，不用填原因，直接生效并留档；非管理员拒绝', async () => {
  const env = setup();
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = 'admin';
  try {
    env.put('members', { _id: 'admin', status: 'active' });
    const id = ok(await daily(env, 'alice', 'bob'))._id;
    assert.ok(ok(await env.call('bob', 'confirmResult', { matchId: id })).confirmed);
    ok(await env.call('bob', 'requestScoreChange', { matchId: id, sets: [{ a: 4, b: 1 }], reason: '比分录反了' }));
    const fix = { matchId: id, sets: [{ a: 2, b: 4 }] };
    no(await env.call('alice', 'adminFixScore', fix), /管理员/);
    no(await env.call('admin', 'adminFixScore', { matchId: id, sets: [{ a: 4, b: 2 }] }), /一样/);
    no(await env.call('admin', 'adminFixScore', { matchId: id, sets: [{ a: 9, b: 9 }] }));
    assert.ok(ok(await env.call('admin', 'matchState', { matchId: id })).canAdminFix);
    assert.ok(!ok(await env.call('alice', 'matchState', { matchId: id })).canAdminFix);
    ok(await env.call('admin', 'adminFixScore', fix)); // 不填原因
    const m = env.coll('matches')[id];
    assert.strictEqual(m.winner, 'b');
    assert.deepStrictEqual([m.sets[0].a, m.sets[0].b], [2, 4]);
    // 直接生效：双方都算确认（锁定）；原来的改分申请失效；留档
    const st = ok(await env.call('alice', 'matchState', { matchId: id, detail: true }));
    assert.ok(st.confirmed && st.status === 'official' && !st.canEdit && !st.request);
    assert.strictEqual(st.sides.b, '管理员更正');
    assert.strictEqual(env.coll('requests')['sc_' + id].status, 'stale');
    const log = Object.values(env.coll('requests')).find((x) => x.type === 'adminScore');
    assert.ok(log.byAdmin && log.by === 'admin' && log.from.winner === 'a' && log.to.winner === 'b');
    no(await env.call('alice', 'revokeMatch', { matchId: id }), /申请修改比分/);
    no(await env.call('alice', 'editMatchScore', { matchId: id, sets: [{ a: 4, b: 0 }] }), /锁定/);
    // 比赛记录里伪造 lastChange 不算锁定（只认 verified 里云函数写的标记）
    const id2 = ok(await daily(env, 'alice', 'bob', { sets: [{ a: 4, b: 0 }], lastChange: { how: 'admin' } }))._id;
    assert.ok(!ok(await env.call('bob', 'matchState', { matchId: id2 })).confirmed);

    // 活动比赛：4 人签表，半决赛和决赛都录了；更正半决赛会推翻决赛
    const ents = ['Alice', 'Bob', 'Carl', 'Eve'];
    env.put('draws', { _id: 'd5', _openid: 'owner', title: '周末赛', status: 'drawn', type: 'single', mode: 'bracket', size: 4, entrants: ents, lines: D.makeBracket(ents, [], 4) });
    ents.forEach((n) => env.put('signups', { _id: 's_' + n, _openid: n.toLowerCase(), drawId: 'd5', name: n }));
    const E = require('../utils/event');
    const sch = () => E.scheduleOf(Object.assign({}, env.coll('draws').d5), Object.values(env.coll('matches')).filter((x) => x.drawId === 'd5'));
    const semi = sch().find((x) => x.ready && x.aMembers.concat(x.bMembers).indexOf('Alice') >= 0);
    const other = sch().find((x) => x.ready && x.key !== semi.key);
    const aSide = semi.aMembers[0] === 'Alice';
    const sid = ok(await env.call('alice', 'recordEventMatch', { drawId: 'd5', key: semi.key, sets: [aSide ? { a: 4, b: 1 } : { a: 1, b: 4 }] })).matchId; // Alice 胜
    assert.ok(ok(await env.call('admin', 'matchState', { matchId: sid })).canAdminFix);
    no(await env.call('alice', 'adminFixScore', { matchId: sid, sets: [{ a: 4, b: 2 }] }), /管理员/);
    // 不改变胜者：直接生效
    ok(await env.call('admin', 'adminFixScore', { matchId: sid, sets: [aSide ? { a: 4, b: 2 } : { a: 2, b: 4 }] }));
    const es = ok(await env.call('alice', 'matchState', { matchId: sid }));
    assert.ok(es.confirmed && es.sides[aSide ? 'b' : 'a'] === '管理员更正'); // 录入的一方仍显示录入方
    no(await env.call('alice', 'recordEventMatch', { drawId: 'd5', key: semi.key, sets: [{ a: 4, b: 0 }] }), /申请修改比分/);
    // 录完另一场半决赛和决赛后，改变半决赛胜者：先返回影响，确认后决赛作废
    ok(await env.call(other.aMembers[0].toLowerCase(), 'recordEventMatch', { drawId: 'd5', key: other.key, sets: [{ a: 4, b: 0 }] }));
    const fin = sch().find((x) => x.ready && x.key !== semi.key && x.key !== other.key);
    const fid = ok(await env.call('alice', 'recordEventMatch', { drawId: 'd5', key: fin.key, sets: [{ a: 4, b: 3, tbA: 7, tbB: 5 }] })).matchId;
    const flip = { matchId: sid, sets: [aSide ? { a: 1, b: 4 } : { a: 4, b: 1 }] };
    const need = ok(await env.call('admin', 'adminFixScore', flip));
    assert.ok(need.needConfirm && need.impact.length === 1 && env.coll('matches')[fid]);
    const done = ok(await env.call('admin', 'adminFixScore', Object.assign({ confirmImpact: true }, flip)));
    assert.strictEqual(done.voided.length, 1);
    assert.ok(!env.coll('matches')[fid]);
    assert.ok(Object.values(env.coll('requests')).some((x) => x.type === 'adminScore' && x.drawId === 'd5' && x.voided.length === 1));
    // 其他活动权限不变：管理员不能判弃权
    no(await env.call('admin', 'resolveFixture', { drawId: 'd5', key: other.key, kind: 'walkover', loser: 'a', reason: '受伤' }), /发起人/);
  } finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
});

test('管理员更正比分：拒绝冒充身份、弃权退赛和无效活动旧记录', async () => {
  const env = setup();
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = 'admin';
  try {
    const id = ok(await daily(env, 'alice', 'bob'))._id;
    const fix = { matchId: id, sets: [{ a: 1, b: 4 }] };
    no(await env.call('eve', 'adminFixScore', Object.assign({}, fix, { uid: 'admin', openid: 'admin', userInfo: { openId: 'admin' } })), /管理员/);
    no(await env.call('outsider', 'adminFixScore', fix), /请先验证/);
    for (const outcome of ['walkover', 'retired', 'cancelled']) {
      env.coll('matches')[id].outcome = outcome;
      no(await env.call('admin', 'adminFixScore', fix), /弃权|退赛|取消/);
      assert.strictEqual(env.coll('matches')[id].winner, 'a');
    }
    env.put('matches', { _id: 'fakeEvent', _openid: 'alice', drawId: 'd1', drawKey: 'k1-0', a: ['Alice'], b: ['Bob'], winner: 'a', sets: [{ a: 4, b: 2 }] });
    no(await env.call('admin', 'adminFixScore', { matchId: 'fakeEvent', sets: [{ a: 1, b: 4 }] }), /不予认可/);
  } finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
});

test('日常比赛：录入即生效；普通参赛者改分留档且不重复写入、可以撤销', async () => {
  const env = setup();
  const id = ok(await daily(env, 'alice', 'bob'))._id;
  const st = ok(await env.call('bob', 'matchState', { matchId: id, detail: true }));
  assert.strictEqual(st.status, 'official');
  assert.ok(!st.canConfirm && st.canEdit && !st.reason);
  const ds = ok(await env.call('bob', 'dataset', {}));
  assert.strictEqual(ds.matches.find((m) => m._id === id).status, 'official');
  // 对手直接改，立即生效；无关的人不能改
  no(await env.call('eve', 'editMatchScore', { matchId: id, sets: [{ a: 1, b: 4 }] }), /参加者/);
  ok(await env.call('bob', 'editMatchScore', { matchId: id, sets: [{ a: 1, b: 4 }] }));
  assert.strictEqual(env.coll('matches')[id].winner, 'b');
  assert.strictEqual(ok(await env.call('alice', 'matchState', { matchId: id, detail: true })).status, 'official');
  // 改分留档：谁改的、改前改后；比分没变不重复记
  ok(await env.call('bob', 'editMatchScore', { matchId: id, sets: [{ a: 1, b: 4 }] }));
  const edits = Object.values(env.coll('requests')).filter((x) => x.type === 'edit');
  assert.strictEqual(edits.length, 1);
  assert.ok(edits[0].by === 'bob' && edits[0].matchId === id && edits[0].from.winner === 'a' && edits[0].from.sets[0].b === 2 && edits[0].to.winner === 'b');
  no(await env.call('bob', 'requestScoreChange', { matchId: id, sets: [{ a: 4, b: 1 }], reason: '比分录反了' }), /直接修改/);
  // 撤销：录入人和参加者都可以（别人乱录了自己能删掉），无关的人不行；留档不带 byAdmin
  no(await env.call('eve', 'revokeMatch', { matchId: id }), /参加者/);
  assert.strictEqual(ok(await env.call('bob', 'revokeMatch', { matchId: id })).removed, 1);
  const rv = Object.values(env.coll('requests')).filter((x) => x.type === 'revoke');
  assert.ok(rv.length === 1 && rv[0].by === 'bob' && !rv[0].byAdmin);
  assert.ok(!ok(await env.call('alice', 'dataset', {})).matches.some((m) => m._id === id));
  // 录入人照样能撤销自己录的
  const id2 = ok(await daily(env, 'alice', 'bob'))._id;
  ok(await env.call('alice', 'revokeMatch', { matchId: id2 }));
});

test('日常比赛：双打四位参加者都能撤销；锁定的比分参加者也不能撤销', async () => {
  const env = setup();
  const d = { op: 'add', coll: 'matches', data: { type: 'double', date: '2026-11-01', a: ['Alice', 'Carl'], b: ['Bob', 'Eve'], aIds: ['alice', 'carl'], bIds: ['bob', 'eve'], winner: 'a', sets: [{ a: 4, b: 2 }] } };
  const id = ok(await env.call('alice', 'data', d))._id;
  no(await env.call('owner', 'revokeMatch', { matchId: id }));
  ok(await env.call('eve', 'revokeMatch', { matchId: id })); // 对方的搭档
  const id2 = ok(await env.call('alice', 'data', d))._id;
  ok(await env.call('carl', 'revokeMatch', { matchId: id2 })); // 自己这边的搭档
  const id3 = ok(await env.call('alice', 'data', d))._id;
  ok(await env.call('bob', 'confirmResult', { matchId: id3 }));
  no(await env.call('bob', 'revokeMatch', { matchId: id3 }), /申请修改比分/);
  no(await env.call('alice', 'revokeMatch', { matchId: id3 }), /申请修改比分/);
});

test('日常比赛网关：只收白名单字段，日期 / 单双打人数 / 用户 ID / 局分都在服务端校验，胜负由服务端算', async () => {
  const env = setup();
  const bj = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const base = { type: 'single', date: '2026-11-01', bestOf: 1, setGames: 4, noAd: true, a: ['Alice'], b: ['Bob'], aIds: ['alice'], bIds: ['bob'], sets: [{ a: 4, b: 2 }] };
  const add = (extra) => env.call('alice', 'data', { op: 'add', coll: 'matches', data: Object.assign({}, base, extra) });
  // 多余字段丢掉：不能夹带内部字段、超大垃圾字段；winner / setsWon 不信客户端，createdAt 用服务器时间
  const id = ok(await add({ winner: 'b', setsWon: { a: 0, b: 9 }, rulingSig: 'x', adminSig: 'y', lastChange: { how: 'admin' }, recordedBy: 'bob', junk: 'z'.repeat(100000), createdAt: 1, _id: 'fake', _openid: 'bob' }))._id;
  const rec = env.coll('matches')[id];
  assert.notStrictEqual(id, 'fake');
  assert.deepStrictEqual(Object.keys(rec).filter((k) => k !== '_id').sort(),
    ['_openid', 'a', 'aIds', 'b', 'bIds', 'bestOf', 'createdAt', 'date', 'noAd', 'sets', 'setGames', 'setsWon', 'type', 'winner'].sort());
  assert.strictEqual(rec._openid, 'alice');
  assert.strictEqual(rec.winner, 'a');
  assert.deepStrictEqual(rec.setsWon, { a: 1, b: 0 });
  assert.notStrictEqual(rec.createdAt, 1);
  assert.ok(!ok(await env.call('bob', 'matchState', { matchId: id })).confirmed, '伪造 rulingSig / adminSig 不算锁定');
  // 今天可以，明天及以后、不合法的日期都拒绝
  ok(await add({ date: bj }));
  const tomorrow = new Date(Date.now() + 32 * 3600 * 1000).toISOString().slice(0, 10);
  for (const date of [tomorrow, '2099-01-01', '2026-02-30', '2026-13-01', '2026-1-1', '', undefined, 20261101]) no(await add({ date }), /日期/);
  // 单双打和每方人数一致、名字和 ID 一一对应
  for (const type of ['triple', '', undefined]) no(await add({ type }), /单打或双打/);
  no(await add({ type: 'double' }), /2 位/);
  no(await add({ a: ['Alice', 'Carl'], aIds: ['alice', 'carl'] }), /1 位/);
  no(await add({ a: ['Alice', 'X'] }), /1 位/);
  no(await add({ type: 'double', a: ['Alice', 'Carl'], b: ['Bob', 'Eve'], aIds: ['alice', 'carl'], bIds: ['bob'] }), /2 位/);
  // 用户 ID：不能空、不能重复（同队或对面）、都必须是已注册球员；名字去首尾空格、拒绝控制字符
  no(await add({ type: 'double', a: ['Alice', 'Carl'], b: ['Bob', 'Eve'], aIds: ['alice', ''], bIds: ['bob', 'eve'] }), /已注册/);
  no(await add({ bIds: ['   '] }), /已注册/);
  const checksBeforeGhost = env.textChecks.length;
  no(await add({ bIds: ['ghost_uid'] }), /已注册/);
  assert.strictEqual(env.textChecks.length, checksBeforeGhost, '伪造的未注册 ID 在内容检测前拒绝');
  no(await add({ b: ['Bob\nX'] }), /名字不对/);
  const trimmedId = ok(await add({ a: [' Alice '], b: [' Bob '] }))._id;
  assert.deepStrictEqual([env.coll('matches')[trimmedId].a, env.coll('matches')[trimmedId].b], [['Alice'], ['Bob']]);
  no(await add({ type: 'double', a: ['Alice', 'Carl'], b: ['Bob', 'Eve'], aIds: ['alice', 'alice'], bIds: ['bob', 'eve'] }), /重复/);
  no(await add({ type: 'double', a: ['Alice', 'Carl'], b: ['Bob', 'Eve'], aIds: ['alice', 'carl'], bIds: ['bob', 'carl'] }), /重复/);
  no(await add({ bIds: ['alice'] }), /重复/);
  ok(await add({ type: 'double', a: ['Alice', 'Carl'], b: ['Bob', 'Eve'], aIds: ['alice', 'carl'], bIds: ['bob', 'eve'] }));
  // 局分按规则校验（复用 checkMatch）
  no(await add({ sets: [{ a: 4, b: 4 }] }));
  no(await add({ sets: [] }), /局分/);
  no(await add({ sets: 'x' }), /局分/);
  no(await add({ bestOf: 3, sets: [{ a: 4, b: 2 }] }), /再打一盘/);
  no(await add({ sets: [{ a: 4, b: 2 }, { a: 4, b: 1 }] }), /已经结束/);
  no(await add({ bestOf: 5 }), /规则/);
  no(await add({ setGames: 5 }), /规则/);
  no(await add({ noAd: 'yes' }), /规则/);
  const b3 = ok(await add({ bestOf: 3, setGames: 6, noAd: false, sets: [{ a: 3, b: 6 }, { a: 6, b: 4 }, { a: 2, b: 6 }] }))._id;
  assert.strictEqual(env.coll('matches')[b3].winner, 'b');
  assert.deepStrictEqual(env.coll('matches')[b3].setsWon, { a: 1, b: 2 });
  // 活动比赛不能经网关写
  no(await add({ drawId: 'd1', drawKey: 'r0m0' }), /对阵表/);
  // 名字仍过内容检测
  env.checkText = () => ({ result: { suggest: 'risky' } });
  const n = Object.keys(env.coll('matches')).length;
  no(await add({}));
  assert.strictEqual(Object.keys(env.coll('matches')).length, n);
});

test('日常比赛：管理员也只能记录自己参加的比赛（按用户 ID）', async () => {
  const env = setup();
  no(await adminCall(env, 'eve', 'data', { op: 'add', coll: 'matches', data: { type: 'single', a: ['Alice'], b: ['Bob'], aIds: ['alice'], bIds: ['bob'], winner: 'a', sets: [{ a: 4, b: 2 }], date: '2026-11-01' } }), /自己参加/);
  no(await adminCall(env, 'eve', 'data', { op: 'add', coll: 'matches', data: { type: 'single', a: ['Eve'], b: ['Bob'], winner: 'a', sets: [{ a: 4, b: 2 }], date: '2026-11-01' } }), /自己参加/);
  ok(await adminCall(env, 'bob', 'data', { op: 'add', coll: 'matches', data: { type: 'single', a: ['Alice'], b: ['Bob'], aIds: ['alice'], bIds: ['bob'], winner: 'a', sets: [{ a: 4, b: 2 }], date: '2026-11-01' } })); // 在 B 方也可以
  assert.strictEqual(Object.keys(env.coll('matches')).length, 1);
});

test('管理员撤销：任何一场都能撤销，不用填原因，留档；活动比赛影响后续场次时先确认', async () => {
  const env = setup();
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = 'admin';
  try {
    env.put('members', { _id: 'admin', status: 'active' });
    // 已锁定、带待处理改分申请的日常比赛
    const id = ok(await daily(env, 'alice', 'bob'))._id;
    ok(await env.call('bob', 'confirmResult', { matchId: id }));
    ok(await env.call('bob', 'requestScoreChange', { matchId: id, sets: [{ a: 4, b: 1 }], reason: '比分录反了' }));
    no(await env.call('eve', 'revokeMatch', { matchId: id }));
    assert.ok(ok(await env.call('admin', 'matchState', { matchId: id })).canAdminRevoke);
    assert.ok(!ok(await env.call('alice', 'matchState', { matchId: id })).canAdminRevoke);
    assert.strictEqual(ok(await env.call('admin', 'revokeMatch', { matchId: id })).removed, 1);
    assert.ok(!env.coll('matches')[id]);
    assert.strictEqual(env.coll('requests')['sc_' + id].status, 'stale');
    assert.ok(Object.values(env.coll('requests')).some((x) => x.type === 'revoke' && x.matchId === id && x.byAdmin && x.by === 'admin'));
    // 活动比赛：撤销半决赛会推翻决赛
    const ents = ['Alice', 'Bob', 'Carl', 'Eve'];
    env.put('draws', { _id: 'd5', _openid: 'owner', title: '周末赛', status: 'drawn', type: 'single', mode: 'bracket', size: 4, entrants: ents, lines: D.makeBracket(ents, [], 4) });
    ents.forEach((n) => env.put('signups', { _id: 's_' + n, _openid: n.toLowerCase(), drawId: 'd5', name: n }));
    const E = require('../utils/event');
    const sch = () => E.scheduleOf(Object.assign({}, env.coll('draws').d5), Object.values(env.coll('matches')).filter((x) => x.drawId === 'd5'));
    const [s1, s2] = sch().filter((x) => x.ready);
    const sid = ok(await env.call(s1.aMembers[0].toLowerCase(), 'recordEventMatch', { drawId: 'd5', key: s1.key, sets: [{ a: 4, b: 1 }] })).matchId;
    ok(await env.call(s2.aMembers[0].toLowerCase(), 'recordEventMatch', { drawId: 'd5', key: s2.key, sets: [{ a: 4, b: 0 }] }));
    const fin = sch().find((x) => x.ready && x.key !== s1.key && x.key !== s2.key);
    const fid = ok(await env.call(fin.aMembers[0].toLowerCase(), 'recordEventMatch', { drawId: 'd5', key: fin.key, sets: [{ a: 4, b: 2 }] })).matchId;
    const need = ok(await env.call('admin', 'revokeMatch', { matchId: sid }));
    assert.ok(need.needConfirm && need.impact.length === 1 && env.coll('matches')[sid] && env.coll('matches')[fid]);
    const done = ok(await env.call('admin', 'revokeMatch', { matchId: sid, confirmImpact: true }));
    assert.strictEqual(done.voided.length, 1);
    assert.ok(!env.coll('matches')[sid] && !env.coll('matches')[fid]);
    // 发起人判的弃权也能撤销（没有后续影响：直接撤销）
    const wid = ok(await env.call('owner', 'resolveFixture', { drawId: 'd5', key: s1.key, kind: 'walkover', loser: 'a', reason: '未到场' })).matchId;
    assert.ok(ok(await env.call('admin', 'matchState', { matchId: wid })).canAdminRevoke);
    ok(await env.call('admin', 'revokeMatch', { matchId: wid }));
    assert.ok(!env.coll('matches')[wid]);
  } finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
});

test('成员管理：一键清空「已拒绝 / 已移除」只是收起（不删记录、不冒到历史球友）；重新申请照常出现，再被拒绝 / 移除重新显示', async () => {
  const env = setup();
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = 'admin';
  try {
    env.put('members', { _id: 'admin', status: 'active' });
    env.put('members', { _id: 'r1', status: 'rejected', name: '拒绝的', reason: '不认识这位球友' });
    env.put('members', { _id: 'bob2', status: 'removed', name: '走了' });
    env.put('players', { _id: 'p_r1', _openid: 'r1', self: true, name: '拒绝的' }); // 有本人资料
    no(await env.call('alice', 'clearMemberHistory', {}), /管理员/);
    assert.strictEqual(ok(await env.call('admin', 'listMembers')).others.length, 2);
    assert.strictEqual(ok(await env.call('admin', 'clearMemberHistory', {})).cleared, 2);
    const d = ok(await env.call('admin', 'listMembers'));
    assert.deepStrictEqual([d.others.length, d.candidates.some((c) => c.uid === 'r1')], [0, false], '收起后不显示，也不冒到历史球友');
    assert.strictEqual(env.coll('members').r1.status, 'rejected', '记录还在、仍然不是成员');
    assert.strictEqual(ok(await env.call('r1', 'memberStatus')).status, 'rejected');
    assert.ok(Object.values(env.coll('requests')).some((x) => x.type === 'adminClearMembers' && x.count === 2));
    assert.strictEqual(ok(await env.call('admin', 'clearMemberHistory', {})).cleared, 0, '再点一次没有可清的');
    // 重新申请：出现在待审核；再拒绝：重新显示在已拒绝里
    ok(await env.call('r1', 'applyMember', { name: '拒绝的' }));
    assert.ok(ok(await env.call('admin', 'listMembers')).pending.some((x) => x.uid === 'r1'));
    ok(await env.call('admin', 'reviewMember', { uid: 'r1', approve: false, reason: '不认识这位球友' }));
    assert.deepStrictEqual(ok(await env.call('admin', 'listMembers')).others.map((x) => x.uid), ['r1']);
    // 批准后再移除：也重新显示
    ok(await env.call('admin', 'reviewMember', { uid: 'r1', approve: true }));
    ok(await env.call('admin', 'removeMember', { uid: 'r1', reason: '长期不参加活动' }));
    assert.deepStrictEqual(ok(await env.call('admin', 'listMembers')).others.map((x) => x.uid), ['r1']);
  } finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
});

test('成员管理：还没设置资料的正式成员，管理员选性别时用 TA 加入时的昵称替 TA 建好资料（不替 TA 选公开展示），留档；TA 之后改的是同一份', async () => {
  const env = setup();
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = 'admin';
  try {
    env.put('members', { _id: 'admin', status: 'active' });
    env.put('members', { _id: 'jie', status: 'active', name: '杰娃儿', source: 'apply' });
    env.put('members', { _id: 'dup', status: 'active', name: 'Alice' }); // 加入时的昵称和别人重复
    env.put('members', { _id: 'gone', status: 'removed', name: '走了' });
    no(await env.call('admin', 'setMemberGender', { uid: 'dup', gender: 'f' }), /已经被其他球友使用/);
    no(await env.call('admin', 'setMemberGender', { uid: 'gone', gender: 'f' }), /正式成员/);
    const r = ok(await env.call('admin', 'setMemberGender', { uid: 'jie', gender: 'm' }));
    assert.strictEqual(r.created, true);
    const mine = Object.values(env.coll('players')).filter((p) => p._openid === 'jie' && p.self);
    assert.strictEqual(mine.length, 1);
    assert.deepStrictEqual([mine[0].name, mine[0].gender, mine[0].shown, mine[0].level], ['杰娃儿', 'm', undefined, null], '不替 TA 选公开展示授权');
    assert.ok(Object.values(env.coll('requests')).some((x) => x.type === 'adminProfile' && x.target === 'jie' && x.by === 'admin' && x.gender === 'm'));
    const row = ok(await env.call('admin', 'listMembers')).active.find((x) => x.uid === 'jie');
    assert.deepStrictEqual([row.nickname, row.gender], ['杰娃儿', 'm']);
    const st = ok(await env.call('jie', 'memberStatus'));
    assert.deepStrictEqual([st.hasProfile, st.shown], [true, null], 'TA 下次打开照常询问公开展示');
    // 再点一次 / 改性别：改的是这一份，不会多建
    ok(await env.call('admin', 'setMemberGender', { uid: 'jie', gender: 'f' }));
    ok(await env.call('jie', 'saveProfile', { name: '杰娃', gender: 'm' }));
    const after = Object.values(env.coll('players')).filter((p) => p._openid === 'jie' && p.self);
    assert.deepStrictEqual(after.map((p) => [p.name, p.gender]), [['杰娃', 'm']]);
  } finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
});

test('成员管理：管理员可以替成员补选性别（只改性别、留档）；成员列表带性别', async () => {
  const env = setup();
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = 'admin';
  try {
    env.put('members', { _id: 'admin', status: 'active' });
    env.put('members', { _id: 'ghost', status: 'active' }); // 还没设置资料，加入时也没留下昵称
    no(await env.call('alice', 'setMemberGender', { uid: 'bob', gender: 'm' }), /管理员/);
    no(await env.call('admin', 'setMemberGender', { uid: 'bob', gender: '' }), /男或女/);
    no(await env.call('admin', 'setMemberGender', { uid: 'ghost', gender: 'm' }), /没有留下可用的昵称/);
    ok(await env.call('admin', 'setMemberGender', { uid: 'bob', gender: 'm' }));
    assert.strictEqual(env.coll('players').p_bob.gender, 'm');
    assert.strictEqual(env.coll('players').p_bob.name, 'Bob');
    const row = ok(await env.call('admin', 'listMembers')).active.find((x) => x.uid === 'bob');
    assert.strictEqual(row.gender, 'm');
    ok(await env.call('admin', 'setMemberGender', { uid: 'bob', gender: 'f' })); // 选错了可以更正
    const logs = Object.values(env.coll('requests')).filter((x) => x.type === 'adminGender');
    assert.strictEqual(logs.length, 2);
    assert.ok(logs.some((x) => x.target === 'bob' && x.from === 'm' && x.to === 'f' && x.by === 'admin'));
    // 下发给前端的球员资料里也带上了
    assert.strictEqual(ok(await env.call('alice', 'dataset', {})).players.find((p) => p.name === 'Bob').gender, 'f');
  } finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
});

test('活动比赛：重新录分（改分）留档，第一次录分不记', async () => {
  const env = setup();
  const ents = ['Alice', 'Bob', 'Carl', 'Eve'];
  env.put('draws', { _id: 'd5', _openid: 'owner', title: '周末赛', status: 'drawn', type: 'single', mode: 'bracket', size: 4, entrants: ents, lines: D.makeBracket(ents, [], 4) });
  ents.forEach((n) => env.put('signups', { _id: 's_' + n, _openid: n.toLowerCase(), drawId: 'd5', name: n }));
  const E = require('../utils/event');
  const f = E.scheduleOf(Object.assign({}, env.coll('draws').d5), []).find((x) => x.ready);
  const [ua, ub] = [f.aMembers[0].toLowerCase(), f.bMembers[0].toLowerCase()];
  ok(await env.call(ua, 'recordEventMatch', { drawId: 'd5', key: f.key, sets: [{ a: 4, b: 1 }] }));
  assert.ok(!Object.values(env.coll('requests')).some((x) => x.type === 'edit'));
  ok(await env.call(ub, 'recordEventMatch', { drawId: 'd5', key: f.key, sets: [{ a: 2, b: 4 }] }));
  const log = Object.values(env.coll('requests')).filter((x) => x.type === 'edit');
  assert.strictEqual(log.length, 1);
  assert.ok(log[0].by === ub && log[0].drawId === 'd5' && log[0].drawKey === f.key && log[0].from.winner === 'a' && log[0].to.winner === 'b');
});

test('新申请提示：管理员查状态时带待审核数，普通成员没有；审核后归零', async () => {
  const env = setup();
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = 'admin,admin2';
  try {
    assert.strictEqual(ok(await env.call('admin', 'memberStatus')).pendingApply, 0);
    ok(await env.call('newbie', 'applyMember', { name: '新人' }));
    ok(await env.call('newbie2', 'applyMember', { name: '新人二' }));
    assert.strictEqual(ok(await env.call('admin', 'memberStatus')).pendingApply, 2);
    assert.strictEqual(ok(await env.call('admin2', 'memberStatus')).pendingApply, 2); // 每位管理员都能看到
    assert.ok(!('pendingApply' in ok(await env.call('alice', 'memberStatus'))));
    assert.ok(!('pendingApply' in ok(await env.call('newbie', 'memberStatus'))));
    ok(await env.call('admin', 'reviewMember', { uid: 'newbie', approve: true }));
    ok(await env.call('admin2', 'reviewMember', { uid: 'newbie2', approve: false, reason: '不认识这位球友' }));
    assert.strictEqual(ok(await env.call('admin', 'memberStatus')).pendingApply, 0);
  } finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
});

test('比分修改记录：比赛详情带回谁、从多少改成多少；不下发原因；不带 detail 不返回', async () => {
  const env = setup();
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = 'admin';
  try {
    env.put('members', { _id: 'admin', status: 'active' });
    const id = ok(await daily(env, 'alice', 'bob'))._id; // 4:2
    assert.deepStrictEqual(ok(await env.call('bob', 'matchState', { matchId: id, detail: true })).changes, []);
    ok(await env.call('bob', 'editMatchScore', { matchId: id, sets: [{ a: 4, b: 1 }] }));
    ok(await env.call('admin', 'adminFixScore', { matchId: id, sets: [{ a: 4, b: 0 }] }));
    ok(await env.call('bob', 'requestScoreChange', { matchId: id, sets: [{ a: 1, b: 4 }], reason: '比分录反了' }));
    ok(await env.call('alice', 'respondScoreChange', { requestId: 'sc_' + id, accept: true }));
    ok(await env.call('alice', 'requestScoreChange', { matchId: id, sets: [{ a: 4, b: 2 }], reason: '局数录错了' })); // 待处理的申请不算修改
    const st = ok(await env.call('eve', 'matchState', { matchId: id, detail: true }));
    assert.deepStrictEqual(st.changes.map((c) => [c.how, c.who, c.from, c.to]), [
      ['edit', 'Bob', '4:2', '4:1'], ['admin', '管理员', '4:1', '4:0'], ['request', 'Bob', '4:0', '1:4'],
    ]);
    assert.ok(st.changes.every((c) => c.at > 0) && !JSON.stringify(st.changes).includes('其实是我赢了'));
    assert.ok(!('changes' in ok(await env.call('eve', 'matchState', { matchId: id }))));
  } finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
});

test('活动组别：男子 / 女子组只收对应性别；混双搭档必须一男一女；没选性别不能报', async () => {
  const env = setup();
  const g = { alice: 'f', bob: 'm', carl: 'm', eve: 'f' };
  Object.keys(g).forEach((u) => { env.coll('players')['p_' + u].gender = g[u]; });
  const mk = async (draw) => ok(await adminCall(env, 'owner', 'createDraw', { draw: Object.assign({ title: '周末赛', mode: 'groups', groupCount: 2 }, draw) })).id;
  // 单打不能设混双；设了也不生效
  const s0 = await mk({ type: 'single', category: 'mixed' });
  assert.ok(!('category' in env.coll('draws')[s0]));
  // 女子单打
  const f1 = await mk({ type: 'single', category: 'f' });
  assert.strictEqual(env.coll('draws')[f1].category, 'f');
  no(await env.call('bob', 'signUp', { drawId: f1 }), /女子组/);
  ok(await env.call('alice', 'signUp', { drawId: f1 }));
  no(await env.call('owner', 'signUp', { drawId: f1 }), /选择性别/); // 资料里没选性别
  // 混双
  const mx = await mk({ type: 'double', category: 'mixed' });
  no(await env.call('alice', 'signUp', { drawId: mx, partnerId: 'eve' }), /一男一女/);
  no(await env.call('bob', 'signUp', { drawId: mx, partnerId: 'owner' }), /还没有选择性别/);
  ok(await env.call('alice', 'signUp', { drawId: mx, partnerId: 'bob' }));
  ok(await env.call('carl', 'signUp', { drawId: mx })); // 没搭档也能报，由发起人配对
  // 男子双打：搭档也要是男的
  const md = await mk({ type: 'double', category: 'm' });
  no(await env.call('bob', 'signUp', { drawId: md, partnerId: 'eve' }), /搭档也要是男/);
  ok(await env.call('bob', 'signUp', { drawId: md, partnerId: 'carl' }));
  // 不限组别：照旧
  const any = await mk({ type: 'single' });
  ok(await env.call('owner', 'signUp', { drawId: any }));
});

test('报名上限和候补：满了还能报，排进候补；前面有人取消自动递补', async () => {
  const env = setup();
  const E = require('../utils/event');
  const id = ok(await adminCall(env, 'owner', 'createDraw', { draw: { title: '周末赛', mode: 'groups', groupCount: 2, type: 'single', limit: 2 } })).id;
  assert.strictEqual(env.coll('draws')[id].limit, 2);
  const waitIds = () => Object.keys(E.waitingOf(Object.values(env.coll('signups')).filter((s) => s.drawId === id), E.capacityOf(env.coll('draws')[id]))).map((k) => env.coll('signups')[k]._openid).sort();
  assert.ok(!ok(await env.call('alice', 'signUp', { drawId: id })).waiting);
  assert.ok(!ok(await env.call('bob', 'signUp', { drawId: id })).waiting);
  // 给报名排个先后（内存数据库里同一毫秒写入的时间可能一样）
  const su = Object.values(env.coll('signups')).filter((s) => s.drawId === id);
  su.find((s) => s._openid === 'alice').createdAt = 1; su.find((s) => s._openid === 'bob').createdAt = 2;
  assert.ok(ok(await env.call('carl', 'signUp', { drawId: id })).waiting);
  assert.deepStrictEqual(waitIds(), ['carl']);
  ok(await env.call('alice', 'cancelSignup', { drawId: id }));
  assert.deepStrictEqual(waitIds(), []); // carl 自动递补
  // 淘汰赛：名额是签数，满了也是候补而不是拒绝
  env.coll('draws').d1.size = 2;
  ok(await env.call('alice', 'signUp', { drawId: 'd1' })); ok(await env.call('bob', 'signUp', { drawId: 'd1' }));
  assert.ok(ok(await env.call('eve', 'signUp', { drawId: 'd1' })).waiting);
  // 淘汰赛不收 limit；不合法的 limit 不保存
  const b = ok(await adminCall(env, 'owner', 'createDraw', { draw: { title: '周末赛', mode: 'bracket', size: 8, type: 'single', limit: 4 } })).id;
  assert.ok(!('limit' in env.coll('draws')[b]));
  const z = ok(await adminCall(env, 'owner', 'createDraw', { draw: { title: '周末赛', mode: 'groups', groupCount: 2, type: 'single', limit: 1 } })).id;
  assert.ok(!('limit' in env.coll('draws')[z]));
});

/* ---------- 成员内约球：建议水平、剩余名额、四人双打 ---------- */
// 内存数据库里同一毫秒写入的报名时间可能一样：每次报名后给最新的一条排上先后
const signInOrder = async (env, uid, data) => {
  const before = new Set(Object.keys(env.coll('signups')));
  const r = ok(await env.call(uid, 'signUp', data));
  const fresh = Object.keys(env.coll('signups')).find((k) => !before.has(k));
  env.coll('signups')[fresh].createdAt = (env.signSeq = (env.signSeq || 0) + 1);
  return r;
};
const statusOf = (env, id) => {
  const E = require('../utils/event');
  return E.signupStatus(env.coll('draws')[id], Object.values(env.coll('signups')).filter((s) => s.drawId === id));
};
const waitingUids = (env, id) => {
  const st = statusOf(env, id);
  return Object.keys(st.wait).map((k) => env.coll('signups')[k]._openid).sort();
};

test('建议水平：选项和自评等级一致；创建、修改、清空都由云端校验，不合法的拒绝且不写入', async () => {
  const E = require('../utils/event'), R = require('../utils/rating');
  assert.deepStrictEqual(E.LEVELS, R.SELF_LEVELS.map((x) => x.v), 'E.LEVELS 要和 SELF_LEVELS 一致');
  const env = setup();
  const base = { title: '周末约球', mode: 'groups', groupCount: 1, type: 'single' };
  const id = ok(await adminCall(env, 'owner', 'createDraw', { draw: Object.assign({ level: { min: 2.5, max: 3 } }, base) })).id;
  assert.deepStrictEqual(env.coll('draws')[id].level, { min: 2.5, max: 3 });
  const view = ok(await env.call('alice', 'drawDetail', { drawId: id })).draw;
  assert.deepStrictEqual(view.level, { min: 2.5, max: 3 });
  assert.strictEqual(E.levelRangeText(view), '2.5–3.0');
  // 上下限相同：只建议 3.0
  const one = ok(await adminCall(env, 'owner', 'createDraw', { draw: Object.assign({ level: { min: 3, max: 3 } }, base) })).id;
  assert.strictEqual(E.levelRangeText(env.coll('draws')[one]), '3.0');
  // 不设置 / 明确不设置：没有这个字段
  for (const level of [undefined, null, '']) {
    const x = ok(await adminCall(env, 'owner', 'createDraw', { draw: Object.assign({ level }, base) })).id;
    assert.ok(!('level' in env.coll('draws')[x]), String(level));
  }
  // 不合法：最低高于最高、不是选项里的值、字符串、数组，都拒绝，不写入、也不做内容检测
  const count = Object.keys(env.coll('draws')).length, checks = env.textChecks.length;
  no(await adminCall(env, 'owner', 'createDraw', { draw: Object.assign({ level: { min: 3.5, max: 3 } }, base) }), /最低不能高于最高/);
  for (const level of [{ min: 2.2, max: 3 }, { min: '2.5', max: '3.0' }, { min: 5, max: 5 }, { min: 2.5 }, '3.0', [2.5, 3]]) {
    no(await adminCall(env, 'owner', 'createDraw', { draw: Object.assign({ level }, base) }), /选项/);
  }
  assert.strictEqual(Object.keys(env.coll('draws')).length, count);
  assert.strictEqual(env.textChecks.length, checks);

  // 修改：旧客户端不带 level，原值保留；新值替换；null 清空；不合法拒绝且原值不变
  ok(await adminCall(env, 'owner', 'updateDrawInfo', { drawId: id, info: { title: '周末约球', date: '2026-11-29' } }));
  assert.deepStrictEqual(env.coll('draws')[id].level, { min: 2.5, max: 3 }, '没传就保留');
  ok(await adminCall(env, 'owner', 'updateDrawInfo', { drawId: id, info: { title: '周末约球', level: { min: 3, max: 3.5 } } }));
  assert.deepStrictEqual(env.coll('draws')[id].level, { min: 3, max: 3.5 });
  no(await adminCall(env, 'owner', 'updateDrawInfo', { drawId: id, info: { title: '周末约球', level: { min: 4, max: 3.5 } } }), /最低不能高于最高/);
  no(await adminCall(env, 'owner', 'updateDrawInfo', { drawId: id, info: { title: '改了名称', level: { min: 1, max: 3.5 } } }), /选项/);
  assert.deepStrictEqual(env.coll('draws')[id].level, { min: 3, max: 3.5 });
  assert.strictEqual(env.coll('draws')[id].title, '周末约球', '校验不过整次都不写');
  ok(await adminCall(env, 'owner', 'updateDrawInfo', { drawId: id, info: { title: '周末约球', level: null } }));
  assert.ok(!('level' in env.coll('draws')[id]), 'null = 清空');
  assert.ok(!('level' in ok(await env.call('alice', 'drawDetail', { drawId: id })).draw));
  // 管理员编辑别人的活动：留档里有改前改后的建议水平
  ok(await adminCall(env, 'alice', 'updateDrawInfo', { drawId: one, info: { title: '周末约球', level: { min: 2, max: 2.5 } } }));
  const log = Object.values(env.coll('requests')).find((x) => x.type === 'adminEditDraw' && x.drawId === one);
  assert.strictEqual(log.before.level, '3.0'); assert.strictEqual(log.after.level, '2.0–2.5');
  ok(await adminCall(env, 'alice', 'updateDrawInfo', { drawId: one, info: { title: '周末约球' } }));
  const log2 = Object.values(env.coll('requests')).filter((x) => x.type === 'adminEditDraw' && x.drawId === one)[1];
  assert.strictEqual(log2.after.level, '2.0–2.5', '没传的留档按保留的原值记');
  // 生成对阵不动建议水平
  ok(await adminCall(env, 'owner', 'updateDrawInfo', { drawId: id, info: { title: '周末约球', level: { min: 3, max: 3 } } }));
  ok(await env.call('alice', 'signUp', { drawId: id })); ok(await env.call('bob', 'signUp', { drawId: id }));
  ok(await adminCall(env, 'owner', 'generateDraw', { drawId: id, draw: { entrants: ['Alice', 'Bob'], groups: [{ members: [{ name: 'Alice' }, { name: 'Bob' }] }] } }));
  assert.deepStrictEqual(env.coll('draws')[id].level, { min: 3, max: 3 });
});

test('建议水平只作参考：旧活动按没设置；没有等级、低于或高于区间的成员，单打双打都照常报名', async () => {
  const E = require('../utils/event');
  const env = setup();
  // 旧活动：没有字段、或者存着不合法的值，都按没设置，不下发
  assert.ok(!('level' in ok(await env.call('alice', 'drawDetail', { drawId: 'd1' })).draw));
  env.coll('draws').d1.level = { min: 4.5, max: 1.5 };
  assert.ok(!('level' in ok(await env.call('alice', 'drawDetail', { drawId: 'd1' })).draw));
  assert.strictEqual(E.levelRangeText(env.coll('draws').d1), '');
  // 区间 4.0–4.5：alice 自评 2.0（低于）、bob 自评 4.5（区间内）、carl 没有自评等级、eve 4.5 以上的比赛等级也一样
  const pl = env.coll('players');
  Object.values(pl).forEach((p) => { if (p._openid === 'alice') p.level = 2; if (p._openid === 'bob') p.level = 4.5; if (p._openid === 'carl') delete p.level; });
  const single = ok(await adminCall(env, 'owner', 'createDraw', { draw: { title: '高水平约球', mode: 'groups', groupCount: 1, type: 'single', level: { min: 4, max: 4.5 } } })).id;
  for (const uid of ['alice', 'bob', 'carl']) assert.ok(!ok(await env.call(uid, 'signUp', { drawId: single })).waiting, uid);
  const dbl = ok(await adminCall(env, 'owner', 'createDraw', { draw: { title: '双打约球', mode: 'groups', groupCount: 1, type: 'double', level: { min: 1.5, max: 2 } } })).id;
  ok(await env.call('bob', 'signUp', { drawId: dbl, partnerId: 'carl' })); // 高于区间 + 没有等级
  ok(await env.call('alice', 'signUp', { drawId: dbl }));
  assert.strictEqual(Object.values(env.coll('signups')).filter((s) => s.drawId === dbl).length, 2);
});

test('四人双打：报名上限 2 队 = 4 人；3 人已报名，第 4 人补位，第 5 人候补；取消一名正式报名后候补递补', async () => {
  const env = setup();
  const id = ok(await adminCall(env, 'owner', 'createDraw', { draw: { title: '四人双打', mode: 'groups', groupCount: 1, type: 'double', limit: 2 } })).id;
  assert.strictEqual(env.coll('draws')[id].limit, 2);
  assert.strictEqual(require('../utils/event').capacityOf(env.coll('draws')[id]), 4);
  assert.strictEqual(statusOf(env, id).text, '已报名 0/4 人 · 还差 4 人');
  // 3 人：一对带搭档（占 2 个名额）+ 一个单人
  assert.ok(!(await signInOrder(env, 'alice', { drawId: id, partnerId: 'bob' })).waiting);
  assert.ok(!(await signInOrder(env, 'carl', { drawId: id })).waiting);
  let st = statusOf(env, id);
  assert.strictEqual(st.text, '已报名 3/4 人 · 还差 1 人');
  assert.match(st.note, /单人报名可以直接报上，带搭档报名会进候补/);
  assert.strictEqual(st.full, false);
  // 第 4 人补位
  assert.ok(!(await signInOrder(env, 'eve', { drawId: id })).waiting);
  st = statusOf(env, id);
  assert.strictEqual(st.text, '已报名 4/4 人 · 已满'); assert.strictEqual(st.full, true);
  // 第 5 人进候补
  assert.ok((await signInOrder(env, 'owner', { drawId: id })).waiting);
  assert.strictEqual(statusOf(env, id).text, '已满 · 候补 1 人');
  assert.deepStrictEqual(waitingUids(env, id), ['owner']);
  // 取消一名正式报名：候补自动递补
  ok(await env.call('carl', 'cancelSignup', { drawId: id }));
  assert.deepStrictEqual(waitingUids(env, id), []);
  assert.strictEqual(statusOf(env, id).text, '已报名 4/4 人 · 已满');
});

test('剩 1 个名额、排在最前面的候补是两人一组：不算空位，后面的单人也排队；有人取消后按报名先后递补', async () => {
  const env = setup();
  env.members([['dan', 'Dan']]);
  const id = ok(await adminCall(env, 'owner', 'createDraw', { draw: { title: '四人双打', mode: 'groups', groupCount: 1, type: 'double', limit: 2 } })).id;
  for (const uid of ['carl', 'eve', 'owner']) assert.ok(!(await signInOrder(env, uid, { drawId: id })).waiting);
  assert.strictEqual(statusOf(env, id).text, '已报名 3/4 人 · 还差 1 人');
  // 带搭档的两人组：只剩 1 个名额，进候补
  assert.ok((await signInOrder(env, 'alice', { drawId: id, partnerId: 'bob' })).waiting);
  let st = statusOf(env, id);
  assert.strictEqual(st.text, '已报名 3/4 人 · 候补 2 人');
  assert.ok(!/还差/.test(st.text), '剩下的 1 位不写成可以马上报名的空位');
  assert.match(st.note, /新报名也排在候补后面/);
  assert.strictEqual(st.full, true);
  // 后面来的单人：虽然剩 1 个名额，也排在两人组后面
  assert.strictEqual((await signInOrder(env, 'dan', { drawId: id })).waiting, true);
  assert.deepStrictEqual(waitingUids(env, id), ['alice', 'dan']);
  assert.strictEqual(statusOf(env, id).text, '已报名 3/4 人 · 候补 3 人');
  // 取消一位单人：两人组按顺序递补（正好 4 人），dan 继续候补
  ok(await env.call('eve', 'cancelSignup', { drawId: id }));
  assert.deepStrictEqual(waitingUids(env, id), ['dan']);
  assert.strictEqual(statusOf(env, id).text, '已满 · 候补 1 人');
  // 两人组取消（由报名人取消，连同搭档；搭档本人不能替 TA 取消）：dan 递补
  no(await env.call('bob', 'cancelSignup', { drawId: id }), /搭档/);
  ok(await env.call('alice', 'cancelSignup', { drawId: id }));
  assert.deepStrictEqual(waitingUids(env, id), []);
  assert.strictEqual(statusOf(env, id).text, '已报名 3/4 人 · 还差 1 人');
});

test('报名情况文字：不设上限只显示人数；单打满员和候补', () => {
  const E = require('../utils/event');
  const su = (n, pairs) => Array.from({ length: n }, (_, i) => Object.assign({ _id: 's' + i, createdAt: i + 1 }, pairs && pairs.indexOf(i) >= 0 ? { partner: 'P' + i } : {}));
  const open = E.signupStatus({ mode: 'groups', groupCount: 1, type: 'double' }, su(3, [0]));
  assert.strictEqual(open.text, '已报名 4 人'); assert.strictEqual(open.full, false); assert.strictEqual(open.note, '');
  assert.strictEqual(E.signupStatus({ mode: 'groups', groupCount: 1 }, []).text, '已报名 0 人');
  const single = { mode: 'groups', groupCount: 1, type: 'single', limit: 4 };
  assert.strictEqual(E.signupStatus(single, su(3)).text, '已报名 3/4 人 · 还差 1 人');
  assert.strictEqual(E.signupStatus(single, su(3)).note, '', '单打没有「带搭档」的提示');
  assert.strictEqual(E.signupStatus(single, su(6)).text, '已满 · 候补 2 人');
  // 淘汰赛：名额是签数
  assert.strictEqual(E.signupStatus({ mode: 'bracket', size: 8, type: 'single' }, su(5)).text, '已报名 5/8 人 · 还差 3 人');
});

/* ---------- 个人资料 ---------- */
test('资料：网关不能改资料，也不能新增本人资料', async () => {
  const env = setup();
  no(await env.call('eve', 'data', { op: 'update', coll: 'players', id: 'p_eve', data: { name: 'Alice' } }));
  no(await env.call('eve', 'data', { op: 'add', coll: 'players', data: { name: 'Zed', self: true, formerNames: ['x'] } }), /停用/);
  const added = Object.values(env.coll('players')).find((p) => p.name === 'Zed');
  assert.strictEqual(added, undefined, '不创建任何手写球员');
});
test('资料：服务端检查重名、旧昵称，改名记录旧昵称', async () => {
  const env = setup();
  no(await env.call('eve', 'saveProfile', { gender: 'm', name: 'Alice' }), /已经被其他球友使用/);
  ok(await env.call('alice', 'saveProfile', { name: 'Alicia', level: 3, gender: 'f' }));
  assert.deepStrictEqual(env.coll('players').p_alice.formerNames, ['Alice']);
  no(await env.call('eve', 'saveProfile', { gender: 'm', name: 'Alice' }), /以前用过/);
  ok(await env.call('alice', 'saveProfile', { gender: 'm', name: 'Alice' })); // 自己的旧昵称可以改回来
  no(await env.call('eve', 'saveProfile', { gender: 'm', name: '12345678901' }), /最多/);
});
test('资料：saveProfile 不能换照片（照片走 setPhoto），保存昵称不修改旧头像', async () => {
  const env = setup();
  for (const avatar of ['cloud://env1.x/avatars/alice/a.jpg', 'cloud://env1.x/avatars/eve/1.jpg']) {
    no(await env.call('eve', 'saveProfile', { gender: 'm', name: 'Eve', avatar }), /升级/);
  }
  env.coll('players').p_eve.avatar = 'cloud://env1.x/avatars/unknown/old.jpg';
  ok(await env.call('eve', 'saveProfile', { gender: 'm', name: 'Eve', avatar: '' }));
  assert.strictEqual(env.coll('players').p_eve.avatar, 'cloud://env1.x/avatars/unknown/old.jpg');
});


test('资料：新用户第一次保存会创建本人资料', async () => {
  const env = setup();
  env.put('members', { _id: 'new', status: 'active' });
  no(await env.call('new', 'saveProfile', { name: 'Newbie', level: 2.5 }), /性别/); // 性别必填
  no(await env.call('new', 'saveProfile', { name: 'Newbie', level: 2.5, gender: '' }), /性别/);
  ok(await env.call('new', 'saveProfile', { gender: 'm', name: 'Newbie', level: 2.5, shown: true }));
  const p = Object.values(env.coll('players')).find((x) => x._openid === 'new');
  assert.ok(p.self && p.name === 'Newbie' && p.level === 2.5 && p.shown === true && p.shownAt);
});

test('公开展示授权不强制：不同意也能设置资料、报名；旧版没带授权的算「还没选」', async () => {
  const env = setup();
  env.put('members', { _id: 'n1', status: 'active' });
  env.put('members', { _id: 'n2', status: 'active' });
  ok(await env.call('n1', 'saveProfile', { gender: 'f', name: 'NoShow', shown: false }));
  const p1 = Object.values(env.coll('players')).find((x) => x._openid === 'n1');
  assert.strictEqual(p1.shown, false);
  assert.strictEqual(ok(await env.call('n1', 'memberStatus')).shown, false, '选过不同意：启动时不再问');
  ok(await env.call('n1', 'signUp', { drawId: 'd1' }));
  no(await env.call('n1', 'setPhoto', { fileID: pf('n1', 'a') }), /同意公开展示/);
  ok(await env.call('n2', 'saveProfile', { gender: 'm', name: 'OldClient' })); // 旧版小程序没有勾选项
  assert.strictEqual(Object.values(env.coll('players')).find((x) => x._openid === 'n2').shown, undefined);
  assert.strictEqual(ok(await env.call('n2', 'memberStatus')).shown, null, '还没选：启动时弹窗问');
});

test('公开展示授权：没同意的不能传照片、照片不下发；可以随时开关；只能改本人的', async () => {
  const env = setup();
  // 已经通过检测的照片，之后关闭了公开展示
  const photo = 'cloud://env1.x/player-photos/alice/r1.jpg';
  Object.assign(env.coll('players').p_alice, { photo });
  assert.strictEqual(ok(await env.call('alice', 'memberStatus')).shown, true);
  assert.strictEqual(ok(await env.call('alice', 'setShown', { on: false })).shown, false);
  assert.strictEqual(env.coll('players').p_alice.shown, false);
  assert.strictEqual(env.coll('players').p_alice.photo, photo, '关闭后照片保留，只是不下发');
  const ds = ok(await env.call('bob', 'dataset', {}));
  const a = ds.players.find((x) => x._openid === 'alice');
  assert.strictEqual(a.shown, false);
  assert.strictEqual(a.photo, undefined, 'dataset 不下发没同意的人的照片');
  const gw = ok(await env.call('bob', 'data', { op: 'get', coll: 'players', where: { _openid: 'alice' } }));
  assert.ok(gw.data.length && gw.data.every((x) => x.photo === undefined), '网关也不下发');
  assert.deepStrictEqual(ok(await env.call('bob', 'photoUrls', { fileIDs: [photo] })).files, {}, '拿不到链接');
  no(await env.call('alice', 'setPhoto', { fileID: pf('alice', 'n1') }), /同意公开展示/);
  assert.strictEqual(env.mediaChecks.length, 0);
  ok(await env.call('alice', 'setPhoto', { fileID: '' })); // 删除照片不需要授权
  // 保存资料时可以一起改；不传就不动
  ok(await env.call('bob', 'saveProfile', { name: 'Bob', gender: 'm' }));
  assert.strictEqual(env.coll('players').p_bob.shown, true);
  ok(await env.call('bob', 'saveProfile', { name: 'Bob', gender: 'm', shown: false }));
  assert.strictEqual(env.coll('players').p_bob.shown, false);
  // 老成员还没选：memberStatus 返回 null，启动时弹窗询问
  delete env.coll('players').p_eve.shown;
  const st = ok(await env.call('eve', 'memberStatus'));
  assert.strictEqual(st.hasProfile, true);
  assert.strictEqual(st.shown, null);
  ok(await env.call('eve', 'setShown', { on: true }));
  assert.strictEqual(env.coll('players').p_eve.shown, true);
  no(await env.call('eve', 'setShown', { on: 'yes' }));
  no(await env.call('eve', 'data', { op: 'update', coll: 'players', id: 'p_alice', data: { shown: true } })); // 不能经网关改别人的
  assert.strictEqual(env.coll('players').p_alice.shown, false);
  env.put('members', { _id: 'new', status: 'active' });
  no(await env.call('new', 'setShown', { on: true }), /先设置/);
  assert.strictEqual(ok(await env.call('new', 'memberStatus')).hasProfile, false);
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
  const id = ok(await adminCall(env, 'owner', 'createDraw', { draw: Object.assign({ title: '周末赛', date: '2026-11-20', withdrawals: [{ x: 1 }] }, settings) })).id;
  const d = env.coll('draws')[id];
  assert.strictEqual(d.status, 'signup'); assert.strictEqual(d._openid, 'owner'); assert.ok(!d.withdrawals);
  ok(await env.call('alice', 'signUp', { drawId: id }));
  ok(await env.call('bob', 'signUp', { drawId: id }));
  const ents = ['Alice', 'Bob', 'Carl'];
  const draw = { entrants: ents, seeds: [], teams: {}, lines: D.makeBracket(ents, [], 4), uidOf: { Alice: 'alice', Bob: 'bob', Carl: 'carl' }, avatars: {} };
  no(await env.call('alice', 'generateDraw', { drawId: id, draw }), /发起人|管理员/);
  // 伪造：把 Carl 指向 eve 的账号 → 不绑定
  ok(await adminCall(env, 'owner', 'generateDraw', { drawId: id, draw: Object.assign({}, draw, { uidOf: { Alice: 'alice', Bob: 'bob', Carl: 'eve' } }) }));
  assert.deepStrictEqual(env.coll('draws')[id].uidOf, { Alice: 'alice', Bob: 'bob' });
  ok(await adminCall(env, 'owner', 'generateDraw', { drawId: id, draw }));
  const g = env.coll('draws')[id];
  assert.strictEqual(g.status, 'drawn'); assert.strictEqual(g.lines.length, 4); assert.strictEqual(g.uidOf.Carl, 'carl');
  // 有比分后不能重新生成
  env.put('matches', { _id: 'ev_x', drawId: id, drawKey: 'k1-0', a: ['Alice'], b: ['Bob'], winner: 'a', sets: [{ a: 4, b: 1 }], outcome: 'normal', createdAt: 1 });
  no(await adminCall(env, 'owner', 'generateDraw', { drawId: id, draw }), /录分/);
});
test('活动：小组赛签表用真实分组结果；名单不一致时拒绝', async () => {
  const env = setup();
  const s = Object.assign({}, settings, { mode: 'groups', groupCount: 2, advance: 1 });
  const ents = ['A1', 'A2', 'A3', 'A4'];
  const id = ok(await adminCall(env, 'owner', 'createDraw', { draw: Object.assign({ title: '练习赛', entrants: ents, seeds: [], teams: {}, groups: D.makeGroups(ents, [], 2), uidOf: {} }, s) })).id;
  assert.strictEqual(env.coll('draws')[id].status, 'drawn');
  no(await adminCall(env, 'owner', 'createDraw', { draw: Object.assign({ title: '练习赛', entrants: ents, groups: D.makeGroups(['A1', 'A2', 'A3', 'X'], [], 2) }, s) }), /签位|小组/);
});
test('活动：编辑信息只改允许的字段', async () => {
  const env = setup();
  ok(await adminCall(env, 'owner', 'updateDrawInfo', { drawId: 'd1', info: { title: '月度赛', date: '2026-12-01', venue: '球场', status: 'drawn', location: { latitude: 1, longitude: 2, name: 'n' } } }));
  const d = env.coll('draws').d1;
  assert.strictEqual(d.title, '月度赛'); assert.strictEqual(d.status, 'signup');
  assert.strictEqual(d.venue, ''); assert.deepStrictEqual(d.location, { latitude: 1, longitude: 2 });
  no(await env.call('alice', 'updateDrawInfo', { drawId: 'd1', info: { title: '周末赛' } }), /发起人|管理员/);
});
test('活动名称和场地：名称保留手动输入且先检测，场地只选编号、地图只存合法坐标', async () => {
  const env = setup();
  const id = ok(await adminCall(env, 'owner', 'createDraw', { draw: {
    mode: 'groups_ko', groupCount: 2, type: 'double', category: 'mixed', date: '2026-11-14',
    title: '自定义活动文字', venue: '自定义球场文字', address: '自定义地址',
    location: { latitude: 31.2, longitude: 121.5, name: '地图中编辑的名称', address: '地图中编辑的地址' },
  } })).id;
  const d = env.coll('draws')[id];
  assert.strictEqual(d.title, '自定义活动文字');
  assert.ok(env.textChecks.some((c) => c.content === d.title && c.openid === 'owner' && c.version === 2));
  assert.strictEqual(d.venue, ''); assert.ok(!('address' in d));
  assert.deepStrictEqual(d.location, { latitude: 31.2, longitude: 121.5 });
  // 手动改名；只接受固定场地编号，编辑时不能改赛制。
  ok(await adminCall(env, 'owner', 'updateDrawInfo', { drawId: id, info: { date: '2026-11-15', title: '再次自定义', venue: ' 30 号场 ', type: 'single', location: { latitude: 91, longitude: 121 } } }));
  assert.strictEqual(d.title, '再次自定义'); assert.strictEqual(d.type, 'double');
  assert.strictEqual(d.venue, '30 号场'); assert.strictEqual(d.location, null);
  ok(await adminCall(env, 'owner', 'updateDrawInfo', { drawId: id, info: { title: d.title, date: d.date, venue: '31 号场', location: { latitude: 31, longitude: Infinity } } }));
  assert.strictEqual(d.venue, ''); assert.strictEqual(d.location, null);
});
test('地图地点名称：内容检测明确通过才保存并下发；没通过只存坐标；没改不重复检测；旧的 location 文字不下发', async () => {
  const env = setup();
  const loc = { latitude: 31.2, longitude: 121.5 };
  const place = { name: '某某网球中心', address: '某区某路 1 号' };
  const r = ok(await adminCall(env, 'owner', 'createDraw', { draw: { mode: 'bracket', size: 8, date: '2026-11-21', title: '内部赛', location: loc, place } }));
  assert.strictEqual(r.placeDropped, false);
  assert.ok(env.textChecks.some((x) => x.content === '某某网球中心 某区某路 1 号' && x.openid === 'owner'));
  const d = env.coll('draws')[r.id];
  assert.deepStrictEqual(d.place, place); assert.deepStrictEqual(d.location, loc);
  const seen = [
    ok(await env.call('alice', 'drawDetail', { drawId: r.id })).draw,
    ok(await env.call('alice', 'data', { op: 'doc', coll: 'draws', id: r.id })).data,
  ].map((x) => require('../utils/event').publicDraw(x));
  seen.forEach((x) => assert.deepStrictEqual(x.place, place));
  // 没改地点：不再检测
  const n = env.textChecks.length;
  ok(await adminCall(env, 'owner', 'updateDrawInfo', { drawId: r.id, info: { title: '内部赛', date: '2026-11-21', location: loc, place } }));
  assert.strictEqual(env.textChecks.filter((x) => /网球中心/.test(x.content)).length, 1);
  assert.ok(env.textChecks.length >= n);
  // 换了地点但没通过检测（违规 / 异常）：活动照常保存，只存坐标
  for (const bad of [{ errCode: 0, result: { suggest: 'risky' } }, { errCode: -1 }]) {
    env.checkText = (p) => (/新地点/.test(p.content) ? bad : { errCode: 0, result: { suggest: 'pass' } });
    const u = ok(await adminCall(env, 'owner', 'updateDrawInfo', { drawId: r.id, info: { title: '内部赛', date: '2026-11-21', location: { latitude: 30, longitude: 120 }, place: { name: '新地点' } } }));
    assert.strictEqual(u.placeDropped, true);
    assert.strictEqual(d.place, null); assert.deepStrictEqual(d.location, { latitude: 30, longitude: 120 });
  }
  env.checkText = null;
  // 清除地图位置：地点名称一起清掉；没有坐标时给了名称也不保存
  ok(await adminCall(env, 'owner', 'updateDrawInfo', { drawId: r.id, info: { title: '内部赛', date: '2026-11-21', location: null, place } }));
  assert.strictEqual(d.location, null); assert.strictEqual(d.place, null);
  // 以前版本存在 location 里的名称和地址（没检测过）：不下发
  Object.assign(d, { location: { latitude: 31, longitude: 121, name: '旧地图名', address: '旧地图地址' }, place: undefined });
  const old = require('../utils/event').publicDraw(ok(await env.call('alice', 'drawDetail', { drawId: r.id })).draw);
  assert.deepStrictEqual(old.location, { latitude: 31, longitude: 121 }); assert.strictEqual(old.place, null);
});
test('比赛名称：必填、限长；违规、人工复核、异常结果和接口报错都不写入', async () => {
  const env = setup();
  for (const title of ['', '   ', '名'.repeat(21), '赛\n事']) {
    no(await adminCall(env, 'owner', 'createDraw', { draw: Object.assign({}, settings, { title }) }), /名称/);
  }
  assert.strictEqual(env.textChecks.length, 0, '无效字段直接拒绝，不调用检测接口');
  const before = JSON.stringify(env.coll('draws').d1);
  const failed = [
    () => ({ errCode: 0, result: { suggest: 'risky' } }),
    () => ({ errCode: 0, result: { suggest: 'review' } }),
    () => ({ errCode: 87014 }),
    () => ({ errCode: 48001, result: { suggest: 'pass' } }),
    () => ({}),
    () => { throw new Error('接口不可用'); },
  ];
  for (const check of failed) {
    env.checkText = check;
    no(await adminCall(env, 'owner', 'createDraw', { draw: Object.assign({}, settings, { title: '待检测的名称' }), openid: 'evil' }), /内容|检测/);
    no(await adminCall(env, 'owner', 'updateDrawInfo', { drawId: 'd1', info: { title: '待检测的名称', date: '2026-11-22' } }), /内容|检测/);
    assert.strictEqual(Object.keys(env.coll('draws')).length, 2);
    assert.strictEqual(JSON.stringify(env.coll('draws').d1), before);
    assert.strictEqual(Object.keys(env.coll('requests')).length, 0);
  }
  assert.ok(env.textChecks.every((c) => c.openid === 'owner'), '检测身份只能来自云端调用上下文');
  env.checkText = null;
  const id = ok(await adminCall(env, 'owner', 'createDraw', { draw: Object.assign({}, settings, { title: '  周末手动名称  ' }) })).id;
  assert.strictEqual(env.coll('draws')[id].title, '周末手动名称');
  ok(await adminCall(env, 'owner', 'updateDrawInfo', { drawId: id, info: { title: '周末手动名称', date: '2026-12-01' } }));
  assert.strictEqual(env.coll('draws')[id].title, '周末手动名称', '改日期不会自动改名');
});
test('比赛名称：检测超时不创建活动', async () => {
  const env = setup();
  env.checkText = () => new Promise(() => {});
  // 检测一直不返回：用虚拟时间走完 4 秒超时，不用真的等
  const clock = require('./fake-clock')();
  no(await clock.run(() => adminCall(env, 'owner', 'createDraw', { draw: Object.assign({}, settings, { title: '检测超时测试' }) })), /检测/);
  assert.strictEqual(Object.keys(env.coll('draws')).length, 2);
});
test('球员名字和签表：昵称、手动球员、直接提交名单都需检测；小组名固定生成', async () => {
  const env = setup();
  env.checkText = () => ({ result: { suggest: 'risky' } });
  no(await env.call('alice', 'saveProfile', { name: '新昵称', gender: 'm' }), /昵称.*内容/);
  assert.strictEqual(env.coll('players').p_alice.name, 'Alice');
  no(await env.call('owner', 'data', { op: 'add', coll: 'players', data: { name: '新球员' } }), /停用/);
  assert.ok(!Object.values(env.coll('players')).some((p) => p.name === '新球员'));
  no(await daily(env, 'alice', 'bob'), /参加的球员.*内容/);
  assert.strictEqual(Object.keys(env.coll('matches')).length, 0);
  const ents = ['A1', 'A2', 'A3', 'A4'];
  const draw = Object.assign({}, settings, { title: '正常名称', mode: 'groups', groupCount: 2, entrants: ents, groups: D.makeGroups(ents, [], 2) });
  env.checkText = (p) => ({ result: { suggest: p.content === '正常名称' ? 'pass' : 'risky' } });
  no(await adminCall(env, 'owner', 'createDraw', { draw }), /参加名单.*内容/);
  assert.strictEqual(Object.keys(env.coll('draws')).length, 2);
  env.checkText = null;
  draw.groups.forEach((g) => { g.name = '不应接受的自定义组名'; });
  const id = ok(await adminCall(env, 'owner', 'createDraw', { draw })).id;
  assert.deepStrictEqual(env.coll('draws')[id].groups.map((g) => g.name), ['A 组', 'B 组']);
  assert.ok(env.textChecks.some((p) => p.content.includes('A1') && p.openid === 'owner'));
  no(await adminCall(env, 'owner', 'createDraw', { draw: Object.assign({}, settings, { title: '双打赛', type: 'double', size: 2,
    entrants: ['任意自定义队名', 'Carl / Eve'], teams: { '任意自定义队名': ['Alice', 'Bob'], 'Carl / Eve': ['Carl', 'Eve'] },
    lines: [{ name: '任意自定义队名' }, { name: 'Carl / Eve' }],
  }) }), /队伍名必须/);
});
test('原因只能从固定选项里选：手写文字一律拒绝；改分原因只给参赛者和发起人；旧的手写原因不再下发', async () => {
  const env = setup();
  Object.assign(env.coll('draws').d1, { status: 'drawn', size: 2, entrants: ['Alice', 'Bob'], lines: [{ name: 'Alice' }, { name: 'Bob' }] });
  env.put('signups', { _id: 'sa', _openid: 'alice', drawId: 'd1', name: 'Alice' });
  env.put('signups', { _id: 'sb', _openid: 'bob', drawId: 'd1', name: 'Bob' });
  const r = ok(await env.call('alice', 'recordEventMatch', { drawId: 'd1', key: '0-0', sets: [{ a: 4, b: 2 }] }));
  assert.strictEqual(env.coll('matches')[r.matchId].drawTitle, 'T', '活动比分保存手动名称快照');
  ok(await env.call('bob', 'confirmResult', { matchId: r.matchId }));
  no(await env.call('alice', 'requestScoreChange', { matchId: r.matchId, sets: [{ a: 4, b: 1 }], reason: '手写的修改原因' }), /固定选项/);
  no(await env.call('alice', 'requestScoreChange', { matchId: r.matchId, sets: [{ a: 4, b: 1 }], reason: '' }), /选择原因/);
  assert.ok(!env.coll('requests')['sc_' + r.matchId]);
  const q = ok(await env.call('alice', 'requestScoreChange', { matchId: r.matchId, sets: [{ a: 4, b: 1 }], reason: '比分录反了' }));
  for (const uid of ['alice', 'bob', 'owner']) assert.strictEqual(ok(await env.call(uid, 'matchState', { matchId: r.matchId })).request.reason, '比分录反了');
  assert.strictEqual(ok(await env.call('eve', 'matchState', { matchId: r.matchId })).request.reason, '');
  no(await env.call('bob', 'respondScoreChange', { requestId: q.requestId, accept: false, note: '手写的处理说明' }), /固定选项/);
  no(await env.call('owner', 'ruleScoreChange', { requestId: q.requestId, accept: false, reason: '手写的裁定说明' }), /固定选项/);
  assert.strictEqual(env.coll('requests')[q.requestId].status, 'pending');
  no(await env.call('alice', 'requestWithdraw', { drawId: 'd1', reason: '手写的退赛原因' }), /固定选项/);
  assert.ok(!Object.values(env.coll('requests')).some((x) => x.type === 'withdraw'));
  no(await env.call('owner', 'resolveFixture', { drawId: 'd1', key: '0-0', kind: 'walkover', loser: 'a', reason: '手写的弃权原因' }), /固定选项/);
  no(await env.call('owner', 'removeDraw', { drawId: 'd1', reason: '手写的删除原因' }), /固定选项/);
  assert.ok(!env.coll('draws').d1.deleted);
  assert.strictEqual(env.textChecks.length, 0, '固定选项的原因不需要内容检测');
  // 旧版本留下的手写原因：留在数据库里，但不再下发给任何人
  env.coll('requests')[q.requestId].reason = '旧的手写原因';
  for (const uid of ['alice', 'bob', 'owner']) assert.strictEqual(ok(await env.call(uid, 'matchState', { matchId: r.matchId })).request.reason, '');
  ok(await env.call('bob', 'respondScoreChange', { requestId: q.requestId, accept: false, note: '原比分没有问题' }));
  ok(await env.call('alice', 'requestWithdraw', { drawId: 'd1', reason: '受伤' }));
  const wd = Object.values(env.coll('requests')).find((x) => x.type === 'withdraw');
  assert.strictEqual(ok(await env.call('owner', 'drawRequests', { drawId: 'd1' })).list.find((x) => x.type === 'withdraw').reason, '受伤');
  wd.reason = '旧的手写退赛原因';
  assert.strictEqual(ok(await env.call('owner', 'drawRequests', { drawId: 'd1' })).list.find((x) => x.type === 'withdraw').reason, '');
});
test('准入：称呼先过内容检测，不接收申请说明和邀请备注；拒绝原因只能是固定选项，旧的手写内容不下发', async () => {
  const env = setup();
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = 'admin';
  try {
    env.put('members', { _id: 'admin', status: 'active' });
    env.checkText = () => ({ result: { suggest: 'risky' } });
    no(await env.call('n1', 'applyMember', { name: '不合适的称呼', note: '手写说明' }), /昵称.*内容/);
    assert.ok(!env.coll('members').n1);
    const code = ok(await env.call('admin', 'createInvite', { note: '手写备注', days: 7 })).code;
    assert.strictEqual(env.coll('invites')[code].note, '');
    no(await env.call('n1', 'acceptInvite', { code, name: '不合适的称呼' }), /昵称.*内容/);
    assert.strictEqual(env.coll('invites')[code].usedBy, '', '检测不过时不占用邀请码');
    env.checkText = null;
    ok(await env.call('n1', 'applyMember', { name: '新人', note: '手写说明' }));
    assert.strictEqual(env.coll('members').n1.note, '');
    assert.ok(env.textChecks.some((c) => c.content === '新人' && c.openid === 'n1'));
    no(await env.call('admin', 'reviewMember', { uid: 'n1', approve: false, reason: '手写的拒绝原因' }), /固定选项/);
    ok(await env.call('admin', 'reviewMember', { uid: 'n1', approve: false, reason: '不认识这位球友' }));
    assert.strictEqual(ok(await env.call('n1', 'memberStatus')).reason, '不认识这位球友');
    Object.assign(env.coll('members').n1, { reason: '旧的手写拒绝原因', note: '旧的手写说明' });
    assert.strictEqual(ok(await env.call('n1', 'memberStatus')).reason, '');
    const list = JSON.stringify(ok(await env.call('admin', 'listMembers')));
    assert.ok(!list.includes('旧的手写拒绝原因') && !list.includes('旧的手写说明'));
    no(await env.call('admin', 'removeMember', { uid: 'alice', reason: '手写的移除原因' }), /固定选项/);
    ok(await env.call('admin', 'removeMember', { uid: 'alice', reason: '本人要求退出' }));
  } finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
});
test('旧活动和比分：各读取接口保留手动名称，隐藏场地文字和处理原因，不修改原始战绩', async () => {
  const env = setup();
  Object.assign(env.coll('draws').d1, { title: '旧自定义活动', date: '2026-11-14', status: 'drawn', venue: '旧自定义球场', address: '旧地址',
    location: { latitude: 31, longitude: 121, name: '旧地图名', address: '旧地图地址' },
    slots: { '0-0': { date: '2026-11-14', time: '09:00', court: '旧场地文字' }, '0-1': { court: '2 号场' } },
    withdrawals: [{ entrant: 'Carl', stage: 'group', policy: 'walkover', reason: '旧私人退赛原因' }] });
  env.put('matches', { _id: 'legacy_title', drawId: 'd1', drawKey: '0-0', drawTitle: '旧自定义活动', date: '2026-11-14', type: 'single', a: ['Alice'], b: ['Bob'], aIds: ['alice'], bIds: ['bob'], sets: [{ a: 4, b: 1 }], winner: 'a', recordedBy: 'alice', resolution: { type: 'withdraw', reason: '旧私人处理原因' } });
  const draws = [
    ok(await env.call('alice', 'data', { op: 'get', coll: 'draws' })).data.find((d) => d._id === 'd1'),
    ok(await env.call('alice', 'data', { op: 'doc', coll: 'draws', id: 'd1' })).data,
    ok(await env.call('alice', 'drawDetail', { drawId: 'd1' })).draw,
  ];
  draws.forEach((d) => {
    assert.strictEqual(d.title, '旧自定义活动'); assert.strictEqual(d.venue, ''); assert.ok(!('address' in d));
    assert.strictEqual(d.withdrawals[0].reason, undefined);
    assert.deepStrictEqual(d.location, { latitude: 31, longitude: 121 });
    assert.strictEqual(d.slots['0-0'].court, ''); assert.strictEqual(d.slots['0-1'].court, '2 号场');
  });
  const matches = [
    ok(await env.call('alice', 'dataset')).matches.find((m) => m._id === 'legacy_title'),
    ok(await env.call('alice', 'data', { op: 'get', coll: 'matches' })).data.find((m) => m._id === 'legacy_title'),
    ok(await env.call('alice', 'data', { op: 'doc', coll: 'matches', id: 'legacy_title' })).data,
    ok(await env.call('alice', 'matchState', { matchId: 'legacy_title', detail: true })).match,
  ];
  matches.forEach((m) => { assert.strictEqual(m.drawTitle, '旧自定义活动'); assert.deepStrictEqual(m.sets, [{ a: 4, b: 1 }]); assert.strictEqual(m.resolution.reason, undefined); });
  assert.strictEqual(ok(await env.call('eve', 'drawRequests', { drawId: 'd1' })).withdrawals[0].reason, undefined);
  assert.strictEqual(env.coll('draws').d1.title, '旧自定义活动');
  assert.strictEqual(env.coll('matches').legacy_title.drawTitle, '旧自定义活动');
  assert.strictEqual(env.coll('matches').legacy_title.resolution.reason, '旧私人处理原因');
  assert.strictEqual(env.coll('draws').d1.withdrawals[0].reason, '旧私人退赛原因');
});
test('集合：云函数只访问项目进度里登记的集合（真实数据库里集合不存在会直接报错，内存数据库测不出来）；已删除的 5 个旧集合不再出现', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '../cloudfunctions/tennis/index.js'), 'utf8');
  const consts = {};
  (src.match(/\b[A-Z_]+ = '[a-z_]+'/g) || []).forEach((x) => { const [k, v] = x.split(" = '"); consts[k] = v.slice(0, -1); });
  const used = new Set();
  (src.match(/\b(?:collection|getDoc|byIds|allDocs|cget)\((?:cache, )?(?:'[a-z_]+'|[A-Z_]+)(?=[),])/g) || []).forEach((x) => {
    const m = x.match(/'([a-z_]+)'$|\(([A-Z_]+)$|, ([A-Z_]+)$/); m[2] = m[2] || m[3]; used.add(m[1] || consts[m[2]]);
  });
  Object.keys({ matches: 1, players: 1, draws: 1, signups: 1, verified: 1 }).forEach((c) => used.add(c)); // 网关按 GW_READ 白名单读
  const doc = require('fs').readFileSync(require('path').join(__dirname, '../docs/项目进度.md'), 'utf8');
  const listed = new Set((doc.match(/^\| ([a-z_]+) \| /gm) || []).map((x) => x.slice(2, -3)));
  const missing = [...used].filter((c) => !listed.has(c));
  assert.deepStrictEqual(missing, [], '云函数用到了没登记的集合（要在控制台新建，并登记到项目进度的集合表）');
  ['reviews', 'bios', 'follows', 'event_contacts', 'event_photos'].forEach((c) => {
    assert.ok(!used.has(c) && !listed.has(c) && !new RegExp("'" + c + "'").test(src), c + ' 已经在控制台删除，代码不能再访问');
  });
  assert.ok(used.size >= 14, [...used].join(','));
});

test('活动：删除是软删除，列表不再返回，申请作废；不再访问已删除的联系人 / 相册集合', async () => {
  const env = setup();
  env.put('requests', { _id: 'wd_1', type: 'withdraw', drawId: 'd1', status: 'pending' });
  no(await env.call('alice', 'removeDraw', { drawId: 'd1' }), /发起人/);
  ok(await env.call('owner', 'removeDraw', { drawId: 'd1' }));
  assert.ok(env.coll('draws').d1.deleted);
  assert.strictEqual(env.coll('requests').wd_1.status, 'cancelled');
  assert.ok(!('event_contacts' in env.store) && !('event_photos' in env.store), '集合已经删掉了：查不到也不会建');
  assert.deepStrictEqual(env.deletedFiles || [], []);
  assert.ok(Object.values(env.coll('requests')).some((x) => x.type === 'deleteDraw'), '留档');
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
test('活动申请列表：活动的审计留档再多，也不会把退赛申请挤掉（drawRequests / drawDetail 一致）', async () => {
  const env = setup();
  env.coll('draws').d1.status = 'drawn';
  for (let i = 0; i < 300; i++) env.put('requests', { _id: 'log' + i, type: i % 2 ? 'edit' : 'manualDraw', drawId: 'd1', by: 'owner', status: 'done', createdAt: 1000 + i });
  env.put('requests', { _id: 'wdA', type: 'withdraw', drawId: 'd1', requesterId: 'alice', entrant: 'Alice', status: 'pending', reason: '受伤', createdAt: 5 });
  env.put('requests', { _id: 'wdB', type: 'withdraw', drawId: 'd1', requesterId: 'bob', entrant: 'Bob', status: 'rejected', reason: '受伤', createdAt: 6 });
  env.put('requests', { _id: 'wdX', type: 'withdraw', drawId: 'd2', requesterId: 'alice', status: 'pending', createdAt: 7 });
  const o = ok(await env.call('owner', 'drawRequests', { drawId: 'd1' }));
  assert.deepStrictEqual(o.list.map((x) => x.id), ['wdB', 'wdA'], '发起人看到全部退赛申请（新的在前），不含审计留档、不含别的活动');
  assert.deepStrictEqual(ok(await env.call('alice', 'drawRequests', { drawId: 'd1' })).list.map((x) => x.id), ['wdA']);
  assert.deepStrictEqual(ok(await env.call('eve', 'drawRequests', { drawId: 'd1' })).list, []);
  const b = ok(await env.call('owner', 'drawDetail', { drawId: 'd1' }));
  assert.deepStrictEqual(b.requests.list.map((x) => x.id), ['wdB', 'wdA']);
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
test('相册已停用：不能读取照片数量；检测推送只处理球员照片，不会发布旧相册图片', async () => {
  const env = setup();
  env.put('event_photos', { _id: 'ph1', drawId: 'd1', status: 'checking', traceId: 'trace1' });
  const before = JSON.stringify(env.store);
  no(await env.call('alice', 'eventPhotoCount', { drawId: 'd1' }), /未知操作/);
  assert.strictEqual(await env.push({ trace_id: 'trace1', result: { suggest: 'pass' } }), 'success');
  delete env.store.avatar_checks; // 查不存在的记录时 mock 会建一个空集合
  assert.strictEqual(JSON.stringify(env.store), before);
});


test('清空战绩：默认关闭、要口令、只有管理员；只删战绩相关的数据', async () => {
  const env = setup();
  const old = [process.env.ADMIN_OPENIDS, process.env.ALLOW_RESET_SCORES];
  process.env.ADMIN_OPENIDS = 'owner';
  try {
    const id = ok(await daily(env, 'alice', 'bob'))._id;
    ok(await env.call('bob', 'confirmResult', { matchId: id }));
    env.put('requests', { _id: 'sc_x', type: 'score', status: 'pending' });
    env.put('requests', { _id: 'wd_x', type: 'withdraw', drawId: 'd1', status: 'pending' });
    env.coll('draws').d1.results = { old: 1 };
    no(await env.call('owner', 'resetScores', { confirm: '清空全部战绩' }), /默认关闭/);
    process.env.ALLOW_RESET_SCORES = 'yes';
    no(await env.call('owner', 'resetScores', { confirm: '清空' }), /口令/);
    no(await env.call('alice', 'resetScores', { confirm: '清空全部战绩' }), /管理员/);
    const r = ok(await env.call('owner', 'resetScores', { confirm: '清空全部战绩' }));
    assert.deepStrictEqual([r.counts.matches, r.counts.confirms, r.counts.requests], [1, 1, 1]);
    assert.ok(!('reviews' in r.counts) && !('reviews' in env.store), '不再访问已删除的 reviews 集合');
    assert.strictEqual(Object.keys(env.coll('matches')).length, 0);
    assert.deepStrictEqual(Object.keys(env.coll('verified')), ['__legacy_migrated__'], '保留迁移标记');
    assert.ok(env.coll('requests').wd_x, '退赛申请保留');
    assert.deepStrictEqual(env.coll('draws').d1.results, {});
    assert.ok(env.coll('draws').d2 && env.coll('members').alice && env.coll('players').p_alice, '活动、成员、资料保留');
    assert.ok(Object.values(env.coll('requests')).some((x) => x.type === 'resetScores'), '留档');
  } finally {
    if (old[0] === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old[0];
    if (old[1] === undefined) delete process.env.ALLOW_RESET_SCORES; else process.env.ALLOW_RESET_SCORES = old[1];
  }
});

/* ---------- 邀请码、日期 ---------- */
test('邀请码列表：累计发满 200 条（用过 / 作废 / 过期）以后，新的有效邀请照样显示', async () => {
  const env = setup();
  for (let i = 0; i < 250; i++) env.put('invites', { _id: 'u' + i, usedBy: i % 3 ? 'x' + i : '', revoked: i % 3 === 0, expiresAt: Date.now() + (i % 5 ? 1e6 : -1000), note: '' });
  env.put('invites', { _id: 'old', usedBy: '', revoked: false, expiresAt: Date.now() - 1000, note: '' });
  const code = ok(await adminCall(env, 'admin', 'createInvite', {})).code;
  const list = ok(await adminCall(env, 'admin', 'listMembers')).invites;
  assert.deepStrictEqual(list.map((x) => x.code), [code], '只列出有效的那一条，没有被前 200 条挤掉');
});
test('邀请码：过期 / 撤销的不会被占用', async () => {
  const env = setup();
  env.put('invites', { _id: 'old', usedBy: '', revoked: false, expiresAt: Date.now() - 1000 });
  env.put('invites', { _id: 'rev', usedBy: '', revoked: true, expiresAt: Date.now() + 1e6 });
  env.put('invites', { _id: 'good', usedBy: '', revoked: false, expiresAt: Date.now() + 1e6 });
  no(await env.call('x1', 'acceptInvite', { code: 'old', name: '新人' }), /过期/);
  assert.strictEqual(env.coll('invites').old.usedBy, '');
  no(await env.call('x1', 'acceptInvite', { code: 'rev', name: '新人' }), /过期/);
  no(await env.call('x1', 'acceptInvite', { code: 'good', name: '  ' }), /昵称/); // 昵称必填，没填不占用邀请码
  assert.strictEqual(env.coll('invites').good.usedBy, '');
  ok(await env.call('x1', 'acceptInvite', { code: 'good', name: '新人' }));
  assert.strictEqual(env.coll('members').x1.name, '新人');
  assert.strictEqual(env.coll('members').x1.status, 'active');
  no(await env.call('x2', 'acceptInvite', { code: 'good', name: '另一人' }), /已被使用/);  // 已经提交过申请、还在等审核的人：用邀请码直接成为正式成员，不需要管理员再审核
  env.put('invites', { _id: 'good2', usedBy: '', revoked: false, expiresAt: Date.now() + 1e6 });
  ok(await env.call('x3', 'applyMember', { name: '审核员' }));
  assert.strictEqual(env.coll('members').x3.status, 'pending');
  no(await env.call('x3', 'ping', {}), /./);
  ok(await env.call('x3', 'acceptInvite', { code: 'good2' })); // 申请时填过称呼，接受邀请时可以不再填
  assert.strictEqual(env.coll('members').x3.status, 'active');
  assert.strictEqual(env.coll('members').x3.name, '审核员');
  ok(await env.call('x3', 'ping', {}));
});
test('准入昵称：最多 10 个字；保存资料昵称后成员名单里的昵称跟着改', async () => {
  const env = setup();
  env.put('invites', { _id: 'c1', usedBy: '', revoked: false, expiresAt: Date.now() + 1e6 });
  no(await env.call('y1', 'acceptInvite', { code: 'c1', name: '一二三四五六七八九十一' }), /最多 10 个字/);
  assert.strictEqual(env.coll('invites').c1.usedBy, '', '超长不占用邀请码');
  no(await env.call('y1', 'applyMember', { name: '一二三四五六七八九十一' }), /最多 10 个字/);
  ok(await env.call('y1', 'acceptInvite', { code: 'c1', name: '小网' }));
  assert.strictEqual(env.coll('members').y1.name, '小网');
  ok(await env.call('y1', 'saveProfile', { name: '网球小王', gender: 'm' }));
  assert.strictEqual(env.coll('members').y1.name, '网球小王');
  assert.strictEqual(env.coll('members').y1.status, 'active', '只改昵称，不动成员状态');
  ok(await env.call('y1', 'saveProfile', { name: '网球大王', gender: 'm' }));
  assert.strictEqual(env.coll('members').y1.name, '网球大王');
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

/* ---------- 活动详情一次取齐 ---------- */
test('drawDetail：各部分和原来分开调用的结果一致；不再返回联系人；非成员、已删除的活动拿不到', async () => {
  const env = setup();
  ok(await env.call('alice', 'signUp', { drawId: 'd1' }));
  ok(await env.call('bob', 'signUp', { drawId: 'd1' }));
  // 联系人功能已删除：旧数据不返回，保存是空操作（旧版小程序还会调用）
  env.put('event_contacts', { _id: 'd1', name: '王教练', phone: '13800000000', wechat: 'wx1', visibility: 'all' });
  no(await env.call('owner', 'saveContact', { drawId: 'd1', contact: { name: '李四', phone: '13900000000' } }), /未知操作/);
  assert.strictEqual(env.coll('event_contacts').d1.phone, '13800000000', '不再写入');
  env.put('event_photos', { _id: 'ph1', drawId: 'd1', status: 'pass' });
  env.put('event_photos', { _id: 'ph2', drawId: 'd1', status: 'checking' });
  for (const u of ['alice', 'eve', 'owner']) {
    const r = ok(await env.call(u, 'drawDetail', { drawId: 'd1' }));
    assert.strictEqual(r.draw._id, 'd1');
    assert.deepStrictEqual(r.signups.map((s) => s._openid), ['alice', 'bob']);
    assert.strictEqual(r.profile._openid, u);
    assert.strictEqual(r.contact, undefined);
    no(await env.call(u, 'getContact', { drawId: 'd1' }), /未知操作/);
    assert.ok(!/13800000000|wx1|王教练/.test(JSON.stringify(r)));
    assert.strictEqual(r.photoCount, undefined);
    assert.strictEqual(r.requests, null, '报名阶段没有退赛申请');
  }
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
  assert.strictEqual(d.match._id, 'm1'); assert.strictEqual(d.status, 'official'); // 日常比赛录入即生效
  ['match', 'status', 'changes'].forEach((k) => delete d[k]);
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
    no(await env.call('alice', 'updateDrawInfo', { drawId: 'd9', info: { title: '周末赛' } }));
    no(await env.call('alice', 'removeDraw', { drawId: 'd9', reason: '活动取消' }));
    // 管理员编辑：成功、留档；手填的地址不再保存
    ok(await env.call('admin', 'updateDrawInfo', { drawId: 'd9', info: { title: '月度赛', date: '2026-11-22', venue: '新球场', address: '某某路 1 号' } }));
    assert.strictEqual(env.coll('draws').d9.title, '月度赛');
    assert.strictEqual(env.coll('draws').d9.address, undefined);
    const log = Object.values(env.coll('requests')).find((x) => x.type === 'adminEditDraw');
    assert.strictEqual(log.before.title, '周末赛'); assert.strictEqual(log.after.title, '月度赛'); assert.strictEqual(log.after.venue, '');
    // 管理员不能生成签表、处理退赛
    no(await env.call('admin', 'generateDraw', { drawId: 'd9', draw: {} }), /发起人|管理员/);
    no(await env.call('admin', 'handleWithdraw', { drawId: 'd9', entrant: 'x', approve: true, reason: '受伤' }), /发起人/);
    // 管理员删除：必须填原因
    no(await env.call('admin', 'removeDraw', { drawId: 'd9' }), /原因/);
    ok(await env.call('admin', 'removeDraw', { drawId: 'd9', reason: '重复创建' }));
    assert.ok(env.coll('draws').d9.deleted && env.coll('draws').d9.deletedByAdmin);
    const dl = Object.values(env.coll('requests')).find((x) => x.type === 'deleteDraw');
    assert.ok(dl.byAdmin && dl.reason === '重复创建');
    // 发起人自己删除不需要原因
    env.put('draws', { _id: 'd8', _openid: 'owner', title: 'T', status: 'signup', type: 'single', mode: 'bracket', size: 4 });
    ok(await env.call('owner', 'removeDraw', { drawId: 'd8' }));
  } finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
});

test('撤回删除：删除的人本人或管理员可以撤回；活动恢复，删除时作废的申请恢复成待处理；留档；重复撤回不改动', async () => {
  const env = setup();
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = 'admin';
  try {
    env.put('members', { _id: 'admin', status: 'active' });
    env.put('draws', { _id: 'd9', _openid: 'owner', title: '周末赛', status: 'signup', type: 'single', mode: 'bracket', size: 4 });
    env.put('requests', { _id: 'r1', drawId: 'd9', type: 'withdraw', status: 'pending', by: 'alice' });
    env.put('requests', { _id: 'r2', drawId: 'd9', type: 'withdraw', status: 'rejected', by: 'bob' });
    // 管理员误删
    ok(await env.call('admin', 'removeDraw', { drawId: 'd9', reason: '重复创建' }));
    assert.strictEqual(env.coll('requests').r1.status, 'cancelled');
    // 普通成员、活动发起人（不是删除的人）都不能撤回
    no(await env.call('alice', 'restoreDraw', { drawId: 'd9' }), /删除这个活动的人或管理员/);
    no(await env.call('owner', 'restoreDraw', { drawId: 'd9' }), /删除这个活动的人或管理员/);
    assert.ok(env.coll('draws').d9.deleted);
    // 管理员撤回：活动恢复、作废的申请恢复，别的申请不动
    ok(await env.call('admin', 'restoreDraw', { drawId: 'd9' }));
    const d = env.coll('draws').d9;
    assert.ok(!d.deleted && d.deleteReason === undefined && d.deletedBy === undefined);
    assert.strictEqual(env.coll('requests').r1.status, 'pending');
    assert.strictEqual(env.coll('requests').r2.status, 'rejected');
    const log = Object.values(env.coll('requests')).find((x) => x.type === 'restoreDraw');
    assert.ok(log && log.by === 'admin' && log.deleteReason === '重复创建');
    // 恢复后成员又能读到；再撤回一次什么都不改
    assert.strictEqual(ok(await env.call('alice', 'restoreDraw', { drawId: 'd9' })).same, true);
    assert.strictEqual(Object.values(env.coll('requests')).filter((x) => x.type === 'restoreDraw').length, 1);
    // 发起人自己删的，自己可以撤回
    ok(await env.call('owner', 'removeDraw', { drawId: 'd9' }));
    ok(await env.call('owner', 'restoreDraw', { drawId: 'd9' }));
    assert.ok(!env.coll('draws').d9.deleted);
    no(await env.call('admin', 'restoreDraw', { drawId: 'nope' }), /不存在/);
  } finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
});

test('置顶活动：只有管理员；置顶写 pinnedAt、取消去掉；留档；重复操作不改动；已删除的不能置顶', async () => {
  const env = setup();
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = 'admin';
  try {
    env.put('members', { _id: 'admin', status: 'active' });
    env.put('draws', { _id: 'd9', _openid: 'owner', title: '周末赛', status: 'signup', type: 'single', mode: 'bracket', size: 4 });
    no(await env.call('alice', 'pinDraw', { drawId: 'd9', pinned: true }));
    no(await env.call('owner', 'pinDraw', { drawId: 'd9', pinned: true }), /管理员/);
    ok(await env.call('admin', 'pinDraw', { drawId: 'd9', pinned: true }));
    assert.ok(env.coll('draws').d9.pinnedAt > 0);
    assert.strictEqual(ok(await env.call('admin', 'pinDraw', { drawId: 'd9', pinned: true })).same, true);
    // 成员读活动列表能看到置顶标记
    const list = ok(await adminCall(env, 'alice', 'data', { op: 'get', coll: 'draws' }));
    assert.ok((list.data || list).find((d) => d._id === 'd9').pinnedAt > 0);
    ok(await env.call('admin', 'pinDraw', { drawId: 'd9', pinned: false }));
    assert.strictEqual(env.coll('draws').d9.pinnedAt, undefined);
    assert.strictEqual(Object.values(env.coll('requests')).filter((x) => x.type === 'pinDraw').length, 2);
    ok(await env.call('admin', 'removeDraw', { drawId: 'd9', reason: '重复创建' }));
    no(await env.call('admin', 'pinDraw', { drawId: 'd9', pinned: true }), /已删除/);
  } finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
});

test('订阅消息已移除：没有 notifyTemplates 操作；录分、申请、审核照常', async () => {
  const env = setup();
  assert.strictEqual((await env.call('alice', 'notifyTemplates')).error, '未知操作');
  const id = ok(await adminCall(env, 'alice', 'data', { op: 'add', coll: 'matches', data: { type: 'single', a: ['Alice'], b: ['Bob'], aIds: ['alice'], bIds: ['bob'], winner: 'a', sets: [{ a: 4, b: 2 }], date: '2026-11-01' } }))._id;
  ok(await env.call('bob', 'confirmResult', { matchId: id }));
  ok(await env.call('bob', 'requestScoreChange', { matchId: id, sets: [{ a: 4, b: 1 }], reason: '比分录反了' }));
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
  no(await env.call('owner', 'setFixtureSlot', { drawId: 'd1', key: '0-0', slot: { time: '09:00' } }), /对阵表生成后/);
  // 只收合法的日期、时间和固定场地编号；别的字段不收
  const r = ok(await env.call('owner', 'setFixtureSlot', { drawId: 'd5', key: '0-0', slot: { date: '2026-11-22', time: '9点', court: ' 3 号场 ', hack: 1 } }));
  assert.deepStrictEqual(r.slot, { date: '2026-11-22', time: '', court: '3 号场' });
  const free = ok(await env.call('owner', 'setFixtureSlot', { drawId: 'd5', key: '0-1', slot: { time: '10:00', court: '自定义球场' } }));
  assert.deepStrictEqual(free.slot, { date: '', time: '10:00', court: '' });
  ok(await env.call('owner', 'setFixtureSlot', { drawId: 'd5', key: '0-1', slot: {} }));
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
  ok(await adminCall(env, 'owner', 'generateDraw', { drawId: 'd5', draw: { entrants: ents, seeds: [], teams: {}, lines: D.makeBracket(ents, [], 4), uidOf: {}, avatars: {} } }));
  assert.deepStrictEqual(env.coll('draws').d5.slots, {});
});

/* ---------- 关注 ---------- */
test('遗留内容接口已删除：旧名称一律未知操作，不访问或修改历史内容', async () => {
  const env = setup();
  env.put('reviews', { _id: 'old-review', text: '旧评价' });
  env.put('bios', { _id: 'alice', bio: '旧简介' });
  env.put('follows', { _id: 'old-follow', followerId: 'alice', targetId: 'bob' });
  const before = JSON.stringify(env.store);
  const queriesBefore = env.queries;
  const actions = 'submitReview reviewSummary pendingReviews reviewableWith saveBio getBios setFollow followInfo addEventPhotos listEventPhotos eventPhotoCount deleteEventPhoto retryPhotoCheck avatarUrls getContact saveContact'.split(' ');
  for (const action of actions) {
    no(await env.call('alice', action, { text: '新内容', drawId: 'd1', targetId: 'bob' }), /未知操作/);
    no(await adminCall(env, 'owner', action, { text: '新内容', drawId: 'd1' }), /未知操作/);
  }
  assert.strictEqual(JSON.stringify(env.store), before);
  assert.strictEqual(env.queries, queriesBefore, '被删除的操作不查询数据库');
});


test('小组赛只分 1 组（大循环）：小组赛＋淘汰赛固定前 2 名打决赛', async () => {
  const env = setup();
  const E = require('../utils/event');
  const g1 = ok(await adminCall(env, 'owner', 'createDraw', { draw: { title: '周末赛', mode: 'groups', groupCount: 1 } })).id;
  assert.strictEqual(env.coll('draws')[g1].groupCount, 1);
  const k1 = ok(await adminCall(env, 'owner', 'createDraw', { draw: { title: '周末赛', mode: 'groups_ko', groupCount: 1, advance: 1 } })).id;
  const d = env.coll('draws')[k1];
  assert.strictEqual(d.advance, 2); // 只出线第 1 名就没有淘汰赛，服务端改成前 2 名
  assert.strictEqual(E.koSize(d), 2);
  const groups = [{ name: 'A 组', fixtures: [], done: 0, table: [{ name: 'x' }, { name: 'y' }, { name: 'z' }] }];
  const { lines } = E.koLines(d, groups);
  assert.deepStrictEqual(lines.map((l) => l.label), ['A 组第 1', 'A 组第 2']); // 决赛：A1 对 A2
});


/* ---------- 球员照片 ---------- */
const frozen = (env, source) => Object.values(env.coll('avatar_checks')).find((c) => c.sourceID === source).fileID;
const pf = (uid, n) => `cloud://env1.x/avatars/${uid}/${n}.jpg`;
test('照片：提交后先检测，明确 pass 才公开；检测中只有本人能看到预览', async () => {
  const env = setup();
  const r = ok(await env.call('alice', 'setPhoto', { fileID: pf('alice', 'a1') }));
  assert.strictEqual(r.state, 'checking');
  assert.ok(/^cloud:\/\/env1\.[^/]+\/player-photos\/alice\//.test(r.pending), '返回通过后会公开的那份，前端用来认出本人刚传的照片');
  assert.strictEqual(r.traceId, undefined, 'trace_id 不下发');
  assert.deepStrictEqual(env.mediaChecks[0], { mediaUrl: 'https://tmp/' + frozen(env, pf('alice', 'a1')), mediaType: 2, version: 2, scene: 1, openid: 'alice' });
  assert.ok(!env.coll('players').p_alice.photo, '检测中不公开');
  const mine = ok(await env.call('alice', 'myPhoto'));
  assert.strictEqual(mine.state, 'checking');
  assert.ok(mine.pendingUrl);
  assert.deepStrictEqual(ok(await env.call('bob', 'photoUrls', { fileIDs: [pf('alice', 'a1')] })).files, {}, '别人拿不到检测中的照片');
  assert.strictEqual(await env.push({ trace_id: 'trace1', result: { suggest: 'pass', label: 100 }, errcode: 0 }), 'success');
  assert.strictEqual(env.coll('players').p_alice.photo, frozen(env, pf('alice', 'a1')));
  assert.deepStrictEqual(ok(await env.call('bob', 'photoUrls', { fileIDs: [frozen(env, pf('alice', 'a1')), pf('alice', 'x'), 'cloud://env1.x/event-photos/d1/a.jpg'] })).files, { [frozen(env, pf('alice', 'a1'))]: 'https://tmp/' + frozen(env, pf('alice', 'a1')) });
  const after = ok(await env.call('alice', 'myPhoto'));
  assert.strictEqual(after.state, '');
  assert.ok(after.url);
  // 重复推送：不再处理
  await env.push({ trace_id: 'trace1', result: { suggest: 'risky' } });
  assert.strictEqual(env.coll('players').p_alice.photo, frozen(env, pf('alice', 'a1')));
  // dataset 带上已通过的照片
  const ds = ok(await env.call('bob', 'dataset', {}));
  assert.strictEqual(ds.players.find((p) => p._openid === 'alice').photo, frozen(env, pf('alice', 'a1')));
});
test('照片：risky / review / 检测出错都不公开，删掉文件，保留原来的照片', async () => {
  const env = setup();
  ok(await env.call('alice', 'setPhoto', { fileID: pf('alice', 'ok') }));
  await env.push({ trace_id: 'trace1', result: { suggest: 'pass' } });
  const cases = [[{ result: { suggest: 'risky', label: 20002 } }, 'reject'], [{ result: { suggest: 'review' } }, 'reject'], [{ errcode: 1, result: {} }, 'error']];
  for (let i = 0; i < cases.length; i++) {
    const f = pf('alice', 'bad' + i);
    ok(await env.call('alice', 'setPhoto', { fileID: f }));
    await env.push(Object.assign({ trace_id: 'trace' + (i + 2) }, cases[i][0]));
    assert.strictEqual(env.coll('players').p_alice.photo, frozen(env, pf('alice', 'ok')));
    assert.ok(env.deletedFiles.includes(f));
    assert.strictEqual(ok(await env.call('alice', 'myPhoto')).state, cases[i][1]);
  }
});
test('照片：换新照片通过后删旧照片；检测中又换一张，旧的作废、晚到的 pass 不生效', async () => {
  const env = setup();
  ok(await env.call('alice', 'setPhoto', { fileID: pf('alice', 'v1') }));
  await env.push({ trace_id: 'trace1', result: { suggest: 'pass' } });
  ok(await env.call('alice', 'setPhoto', { fileID: pf('alice', 'v2') }));
  ok(await env.call('alice', 'setPhoto', { fileID: pf('alice', 'v3') }));
  assert.ok(env.deletedFiles.includes(frozen(env, pf('alice', 'v2'))), '被取代的检测中照片删掉');
  await env.push({ trace_id: 'trace2', result: { suggest: 'pass' } });
  assert.strictEqual(env.coll('players').p_alice.photo, frozen(env, pf('alice', 'v1')));
  await env.push({ trace_id: 'trace3', result: { suggest: 'pass' } });
  assert.strictEqual(env.coll('players').p_alice.photo, frozen(env, pf('alice', 'v3')));
  assert.ok(env.deletedFiles.includes(frozen(env, pf('alice', 'v1'))), '旧照片删掉');
  // 删除照片：改回首字圆
  ok(await env.call('alice', 'setPhoto', { fileID: '' }));
  assert.strictEqual(env.coll('players').p_alice.photo, '');
  assert.ok(env.deletedFiles.includes(frozen(env, pf('alice', 'v3'))));
});
test('照片：检测结果比检测记录先到也不会丢——pass 照常公开，risky 照常不公开', async () => {
  const env = setup();
  // 推送先到：先存成 early-<trace_id>，setPhoto 写完记录后接着处理
  assert.strictEqual(await env.push({ trace_id: 'trace1', result: { suggest: 'pass', label: 100 } }), 'success');
  assert.strictEqual(env.coll('avatar_checks')['early-trace1'].result, 'pass');
  const r = ok(await env.call('alice', 'setPhoto', { fileID: pf('alice', 'e1') }));
  assert.strictEqual(r.state, '');
  assert.strictEqual(env.coll('players').p_alice.photo, frozen(env, pf('alice', 'e1')));
  assert.strictEqual(env.coll('avatar_checks').trace1.status, 'pass');
  assert.ok(!env.coll('avatar_checks')['early-trace1'], '暂存的结果处理完就删掉');
  assert.strictEqual(ok(await env.call('bob', 'dataset', {})).players.find((p) => p._openid === 'alice').photo, frozen(env, pf('alice', 'e1')), '其他球友看得到');
  assert.strictEqual(ok(await env.call('alice', 'myPhoto')).state, '');
  // 不通过的结果先到：不公开，删掉检测副本，保留原来的照片
  await env.push({ trace_id: 'trace2', result: { suggest: 'risky', label: 20002 } });
  const r2 = ok(await env.call('alice', 'setPhoto', { fileID: pf('alice', 'e2') }));
  assert.strictEqual(r2.state, 'reject');
  assert.strictEqual(env.coll('players').p_alice.photo, frozen(env, pf('alice', 'e1')));
  assert.ok(env.deletedFiles.includes(frozen(env, pf('alice', 'e2'))));
  assert.strictEqual(ok(await env.call('alice', 'myPhoto')).state, 'reject');
  // 伪造的 early- 前缀不处理
  assert.strictEqual(await env.push({ trace_id: 'early-trace9', result: { suggest: 'pass' } }), 'success');
  assert.ok(!env.coll('avatar_checks')['early-early-trace9']);
});
test('照片：检测超过 1 小时没结果判为出错，删掉检测副本；晚到的 pass 不再公开，可以重新上传', async () => {
  const env = setup();
  ok(await env.call('alice', 'setPhoto', { fileID: pf('alice', 'old') }));
  await env.push({ trace_id: 'trace1', result: { suggest: 'pass' } });
  ok(await env.call('alice', 'setPhoto', { fileID: pf('alice', 'lost') }));
  const snap = frozen(env, pf('alice', 'lost'));
  assert.strictEqual(ok(await env.call('alice', 'myPhoto')).state, 'checking', '1 小时内仍是检测中');
  env.coll('avatar_checks').trace2.at = Date.now() - 61 * 60 * 1000;
  const m = ok(await env.call('alice', 'myPhoto'));
  assert.strictEqual(m.state, 'error');
  assert.strictEqual(m.pendingUrl, '', '不再给本人显示检测中的照片');
  assert.ok(m.url, '原来通过的照片照常显示');
  assert.ok(env.deletedFiles.includes(snap));
  assert.strictEqual(env.coll('players').p_alice.photoTrace, '');
  await env.push({ trace_id: 'trace2', result: { suggest: 'pass' } });
  assert.strictEqual(env.coll('players').p_alice.photo, frozen(env, pf('alice', 'old')), '晚到的结果不生效');
  ok(await env.call('alice', 'setPhoto', { fileID: pf('alice', 'again') }));
  await env.push({ trace_id: 'trace3', result: { suggest: 'pass' } });
  assert.strictEqual(env.coll('players').p_alice.photo, frozen(env, pf('alice', 'again')));
});
test('照片：只认本人 avatars/ 目录、当前环境；检测提交失败不保存；没资料不能传；每天有次数上限', async () => {
  const env = setup();
  for (const f of [pf('bob', 'a'), 'cloud://env2.x/avatars/alice/a.jpg', 'cloud://env1.x/event-photos/alice/a.jpg', 'cloud://env1.x/avatars/alice/../bob/a.jpg', pf('alice', 'a').replace('.jpg', '.png'), 'https://x/a.jpg', 123]) {
    no(await env.call('alice', 'setPhoto', { fileID: f }), /位置不对/);
  }
  env.checkMedia = () => ({ errCode: 45009, errMsg: 'limit' });
  no(await env.call('alice', 'setPhoto', { fileID: pf('alice', 'f') }), /安全检测/);
  assert.ok(env.deletedFiles.includes(pf('alice', 'f')));
  assert.strictEqual(Object.keys(env.coll('avatar_checks')).length, 0);
  env.checkMedia = () => { throw Object.assign(new Error('no permission'), { errCode: -604101 }); };
  no(await env.call('alice', 'setPhoto', { fileID: pf('alice', 'g') }), /安全检测/);
  env.checkMedia = null;
  env.put('members', { _id: 'newbie', status: 'active' });
  no(await env.call('newbie', 'setPhoto', { fileID: pf('newbie', 'a') }), /先设置/);
  for (let i = 0; i < 10; i++) ok(await env.call('bob', 'setPhoto', { fileID: pf('bob', 'n' + i) }));
  no(await env.call('bob', 'setPhoto', { fileID: pf('bob', 'n10') }), /太多/);
  no(await env.call('bob', 'setPhoto', { fileID: pf('bob', 'n9') }), /提交过/);
});
test('照片：小程序端不能冒充检测推送，网关不能写照片字段，非成员拿不到链接', async () => {
  const env = setup();
  ok(await env.call('alice', 'setPhoto', { fileID: pf('alice', 'a') }));
  env.openid = 'alice';
  no(await env.fn.main({ Event: 'wxa_media_check', trace_id: 'trace1', result: { suggest: 'pass' }, userInfo: { openId: 'alice' } }), /未知操作/);
  assert.ok(!env.coll('players').p_alice.photo);
  no(await env.call('alice', 'data', { op: 'update', coll: 'players', id: 'p_alice', data: { photo: pf('alice', 'a') } }));
  no(await env.call('alice', 'data', { op: 'add', coll: 'players', data: { name: 'X', photo: pf('alice', 'a'), self: true } }));
  assert.ok(!env.coll('players').p_alice.photo);
  await env.push({ trace_id: 'trace1', result: { suggest: 'pass' } });
  no(await env.call('stranger', 'photoUrls', { fileIDs: [pf('alice', 'a')] }), /请先验证/);
});
test('照片：管理员可以移除成员的照片（留档），普通成员不能', async () => {
  const env = setup();
  ok(await env.call('alice', 'setPhoto', { fileID: pf('alice', 'a') }));
  await env.push({ trace_id: 'trace1', result: { suggest: 'pass' } });
  no(await env.call('bob', 'adminClearPhoto', { uid: 'alice' }), /管理员/);
  assert.strictEqual(env.coll('players').p_alice.photo, frozen(env, pf('alice', 'a')));
  assert.strictEqual(ok(await adminCall(env, 'boss', 'listMembers')).active.find((x) => x.uid === 'alice').hasPhoto, true);
  ok(await adminCall(env, 'boss', 'adminClearPhoto', { uid: 'alice' }));
  assert.strictEqual(env.coll('players').p_alice.photo, '');
  assert.ok(env.deletedFiles.includes(frozen(env, pf('alice', 'a'))));
  const log = Object.values(env.coll('requests')).find((x) => x.type === 'adminPhoto');
  assert.ok(log && log.by === 'boss' && log.target === 'alice' && log.byAdmin);
});

test('照片：审核对象是不可变快照；内部字段不能经本人资料、网关或 dataset 泄露', async () => {
  const env = setup();
  const source = pf('alice', 'immutable');
  env.fileContents = { [source]: 'checked bytes' };
  ok(await env.call('alice', 'setPhoto', { fileID: source }));
  const f = frozen(env, source);
  env.fileContents[source] = 'unmoderated overwrite';
  assert.strictEqual(String(env.fileContents[f]), 'checked bytes');
  assert.ok(env.mediaChecks[0].mediaUrl.endsWith(f));
  for (const response of [
    ok(await env.call('bob', 'data', { op: 'doc', coll: 'players', id: 'p_alice' })),
    ok(await env.call('bob', 'data', { op: 'get', coll: 'players' })),
    ok(await env.call('alice', 'saveProfile', { name: 'Alice', gender: 'f' })),
    ok(await env.call('bob', 'dataset')),
  ]) assert.ok(!/photoTrace|photoRequest|photoAttempts|trace1/.test(JSON.stringify(response)));
  no(await env.call('bob', 'data', { op: 'count', coll: 'players', where: { photoTrace: 'trace1' } }));
  await env.push({ trace_id: 'trace1', result: { suggest: 'pass' } });
  assert.strictEqual(env.coll('players').p_alice.photo, f);
  assert.deepStrictEqual(ok(await env.call('bob', 'photoUrls', { fileIDs: [source] })).files, {});
});
test('照片：检测提交等待期间清除或换图，晚完成的提交不能恢复旧照片或覆盖新状态', async () => {
  const env = setup();
  let release, started;
  const entered = new Promise((r) => { started = r; });
  env.checkMedia = () => { started(); return new Promise((r) => { release = r; }); };
  const first = env.call('alice', 'setPhoto', { fileID: pf('alice', 'slow') });
  await entered;
  ok(await adminCall(env, 'boss', 'adminClearPhoto', { uid: 'alice' }));
  env.checkMedia = null;
  ok(await env.call('alice', 'setPhoto', { fileID: pf('alice', 'new') }));
  release({ errCode: 0, traceId: 'slow-trace' });
  ok(await first);
  assert.strictEqual(ok(await env.call('alice', 'myPhoto')).state, 'checking');
  await env.push({ trace_id: 'slow-trace', result: { suggest: 'pass' } });
  assert.ok(!env.coll('players').p_alice.photo);
  await env.push({ trace_id: 'trace2', result: { suggest: 'pass' } });
  assert.strictEqual(env.coll('players').p_alice.photo, frozen(env, pf('alice', 'new')));
});
test('照片：回调与清除同时发生不复活照片；仅待检测时的管理员清除也留档', async () => {
  const env = setup();
  ok(await env.call('alice', 'setPhoto', { fileID: pf('alice', 'race') }));
  await Promise.all([
    env.push({ trace_id: 'trace1', result: { suggest: 'pass' } }),
    adminCall(env, 'boss', 'adminClearPhoto', { uid: 'alice' }),
  ]);
  assert.strictEqual(env.coll('players').p_alice.photo, '');
  await env.push({ trace_id: 'trace1', result: { suggest: 'pass' } });
  assert.strictEqual(env.coll('players').p_alice.photo, '');
  ok(await env.call('alice', 'setPhoto', { fileID: pf('alice', 'pending') }));
  ok(await adminCall(env, 'boss', 'adminClearPhoto', { uid: 'alice' }));
  assert.strictEqual(Object.values(env.coll('requests')).filter((x) => x.type === 'adminPhoto').length, 2);
});
test('照片：并发重复提交只检测一次；客户端来源或 userInfo 空值不能冒充推送', async () => {
  const env = setup();
  const results = await Promise.all(Array.from({ length: 15 }, () => env.call('alice', 'setPhoto', { fileID: pf('alice', 'same') })));
  assert.strictEqual(results.filter((r) => r.ok).length, 1);
  assert.strictEqual(env.mediaChecks.length, 1);
  for (const userInfo of [null, false, {}]) no(await env.fn.main({ Event: 'wxa_media_check', trace_id: 'trace1', userInfo, result: { suggest: 'pass' } }));
  env.source = 'wx_client';
  no(await env.fn.main({ Event: 'wxa_media_check', trace_id: 'trace1', result: { suggest: 'pass' } }));
  env.source = 'wx_client,wx_callback';
  no(await env.fn.main({ Event: 'wxa_media_check', trace_id: 'trace1', result: { suggest: 'pass' } }));
  env.source = '';
  no(await env.fn.main({ Event: 'wxa_media_check', trace_id: 'trace1', result: { suggest: 'pass' } }));
  assert.ok(!env.coll('players').p_alice.photo);
});
test('照片：线上真实推送（SOURCE = wx_callback，带 userInfo）能发布照片', async () => {
  const env = setup();
  ok(await env.call('alice', 'setPhoto', { fileID: pf('alice', 'real') }));
  env.source = 'wx_callback';
  env.openid = '';
  assert.strictEqual(await env.fn.main({ Event: 'wxa_media_check', MsgType: 'event', trace_id: 'trace1', userInfo: { appId: 'wxapp', openId: '' }, result: { suggest: 'pass', label: 100 } }), 'success');
  assert.ok(/player-photos\/alice\//.test(env.coll('players').p_alice.photo));
  assert.strictEqual(env.coll('avatar_checks').trace1.status, 'pass');
});
test('照片：推送的上下文里没有环境 ID 时，通过的照片照样发布（不会当成路径不对删掉）', async () => {
  const env = setup();
  ok(await env.call('alice', 'setPhoto', { fileID: pf('alice', 'noenv') }));
  env.env = '';
  await env.push({ trace_id: 'trace1', result: { suggest: 'pass', label: 100 } });
  env.env = undefined;
  assert.ok(/player-photos\/alice\//.test(env.coll('players').p_alice.photo));
  assert.strictEqual(env.coll('avatar_checks').trace1.status, 'pass');
  assert.ok(!env.removed || !env.removed.some((f) => f === env.coll('players').p_alice.photo));
});

test('照片：回调数据库故障向上传递以便重试；重试后仍能发布', async () => {
  const env = setup();
  ok(await env.call('alice', 'setPhoto', { fileID: pf('alice', 'db-failure') }));
  env.beforeDocGet = (coll) => { if (coll === 'avatar_checks') throw new Error('database temporarily unavailable'); };
  await assert.rejects(env.push({ trace_id: 'trace1', result: { suggest: 'pass' } }), /temporarily unavailable/);
  assert.strictEqual(env.coll('avatar_checks').trace1.status, 'checking');
  env.beforeDocGet = null;
  await env.push({ trace_id: 'trace1', result: { suggest: 'pass' } });
  assert.strictEqual(env.coll('players').p_alice.photo, frozen(env, pf('alice', 'db-failure')));
});
test('照片：不同文件并发提交仍受十次上限约束；没有当前环境时拒绝上传', async () => {
  const env = setup();
  const results = await Promise.all(Array.from({ length: 15 }, (_, i) => env.call('alice', 'setPhoto', { fileID: pf('alice', 'parallel' + i) })));
  assert.strictEqual(results.filter((r) => r.ok).length, 10);
  assert.strictEqual(env.mediaChecks.length, 10);
  assert.strictEqual(env.coll('players').p_alice.photoAttempts.length, 10);
  assert.ok(env.deletedFiles.includes(pf('alice', 'parallel14')));
  env.env = '';
  no(await env.call('bob', 'setPhoto', { fileID: pf('bob', 'envless') }), /位置不对/);
});

/* ---------- 球员照片缩略图（320×320，跟着检测结果走） ---------- */
const J = require('../cloudfunctions/tennis/vendor/jpeg-js');
// 生成测试用 JPG：左半边红、右半边蓝
function jpg(w, h) {
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(x < w / 2 ? [220, 30, 30, 255] : [30, 30, 220, 255], (y * w + x) * 4);
  return J.encode({ data, width: w, height: h }, 90).data;
}
const urlsOf = (r) => ({ files: r.files, thumbs: r.thumbs });
const thumbOf = (env, source) => Object.values(env.coll('avatar_checks')).find((c) => c.sourceID === source).thumb;
test('照片缩略图：从检测快照缩成 320×320，跟着检测结果公开；photoUrls 默认发缩略图、full 发原图；缩略图编号不下发', async () => {
  const env = setup();
  const source = pf('alice', 't1');
  env.fileContents = { [source]: jpg(1080, 1080) };
  ok(await env.call('alice', 'setPhoto', { fileID: source }));
  const f = frozen(env, source), t = thumbOf(env, source);
  assert.strictEqual(t, f.replace(/\.jpg$/, '-s.jpg'), '放在快照旁边（客户端不可读写的目录）');
  assert.ok(env.mediaChecks[0].mediaUrl.endsWith(f), '检测的仍是原图快照');
  const img = J.decode(env.fileContents[t], { useTArray: true });
  assert.deepStrictEqual([img.width, img.height], [320, 320]);
  const px = (x, y) => Array.from(img.data.slice((y * 320 + x) * 4, (y * 320 + x) * 4 + 3));
  assert.ok(px(40, 160)[0] > 180 && px(40, 160)[2] < 80, '左半边红');
  assert.ok(px(280, 160)[2] > 180 && px(280, 160)[0] < 80, '右半边蓝');
  assert.ok(env.fileContents[t].length < env.fileContents[f].length / 4, '体积小得多');
  assert.deepStrictEqual(ok(await env.call('bob', 'photoUrls', { fileIDs: [f] })).files, {}, '检测中不发');
  assert.ok(!env.coll('players').p_alice.photoThumb);
  await env.push({ trace_id: 'trace1', result: { suggest: 'pass' } });
  assert.strictEqual(env.coll('players').p_alice.photo, f);
  assert.strictEqual(env.coll('players').p_alice.photoThumb, t);
  assert.deepStrictEqual(urlsOf(ok(await env.call('bob', 'photoUrls', { fileIDs: [f] }))), { files: { [f]: 'https://tmp/' + t }, thumbs: { [f]: 1 } });
  assert.deepStrictEqual(urlsOf(ok(await env.call('bob', 'photoUrls', { fileIDs: [f], full: true }))), { files: { [f]: 'https://tmp/' + f }, thumbs: {} });
  assert.deepStrictEqual(ok(await env.call('bob', 'photoUrls', { fileIDs: [t] })).files, {}, '直接拿缩略图编号换不到链接');
  for (const response of [
    ok(await env.call('bob', 'data', { op: 'doc', coll: 'players', id: 'p_alice' })),
    ok(await env.call('bob', 'data', { op: 'get', coll: 'players' })),
    ok(await env.call('alice', 'saveProfile', { name: 'Alice', gender: 'f' })),
    ok(await env.call('bob', 'dataset')),
  ]) assert.ok(!/photoThumb|-s\.jpg/.test(JSON.stringify(response)));
  no(await env.call('bob', 'data', { op: 'count', coll: 'players', where: { photoThumb: t } }));
  // 关闭公开展示：缩略图也拿不到
  ok(await env.call('alice', 'setShown', { on: false }));
  assert.deepStrictEqual(ok(await env.call('bob', 'photoUrls', { fileIDs: [f] })).files, {});
});
test('照片缩略图：不是正方形的居中取方；换新照片删旧缩略图；没通过、被取代、清除都连同缩略图删掉', async () => {
  const env = setup();
  env.fileContents = {};
  const src = (n, w = 400, h = 400) => { const s = pf('alice', n); env.fileContents[s] = jpg(w, h); return s; };
  const a = src('a', 1200, 600);
  ok(await env.call('alice', 'setPhoto', { fileID: a }));
  const ta = thumbOf(env, a);
  const img = J.decode(env.fileContents[ta], { useTArray: true });
  assert.deepStrictEqual([img.width, img.height], [320, 320]);
  await env.push({ trace_id: 'trace1', result: { suggest: 'pass' } });
  const b = src('b');
  ok(await env.call('alice', 'setPhoto', { fileID: b }));
  await env.push({ trace_id: 'trace2', result: { suggest: 'risky' } });
  assert.ok(env.deletedFiles.includes(frozen(env, b)) && env.deletedFiles.includes(thumbOf(env, b)), '没通过：快照和缩略图都删');
  assert.strictEqual(env.coll('players').p_alice.photoThumb, ta, '原来的照片不受影响');
  const c = src('c'), d = src('d');
  ok(await env.call('alice', 'setPhoto', { fileID: c }));
  ok(await env.call('alice', 'setPhoto', { fileID: d }));
  assert.ok(env.deletedFiles.includes(thumbOf(env, c)), '检测中被取代：缩略图删');
  await env.push({ trace_id: 'trace4', result: { suggest: 'pass' } });
  assert.strictEqual(env.coll('players').p_alice.photoThumb, thumbOf(env, d));
  assert.ok(env.deletedFiles.includes(frozen(env, a)) && env.deletedFiles.includes(ta), '换新照片：旧照片和旧缩略图都删');
  assert.ok(!env.deletedFiles.includes(thumbOf(env, d)));
  ok(await adminCall(env, 'boss', 'adminClearPhoto', { uid: 'alice' }));
  assert.ok(env.deletedFiles.includes(thumbOf(env, d)), '管理员移除：缩略图一起删');
  assert.strictEqual(env.coll('players').p_alice.photoThumb, '');
});
test('照片缩略图：以前没有缩略图的照片在 photoUrls 里补做一次；做不出来照常发原图；补做期间换了照片就删掉', async () => {
  const env = setup();
  const photo = 'cloud://env1.x/player-photos/alice/old1.jpg', t = 'cloud://env1.x/player-photos/alice/old1-s.jpg';
  env.fileContents = { [photo]: jpg(1080, 1080) };
  Object.assign(env.coll('players').p_alice, { photo });
  assert.deepStrictEqual(urlsOf(ok(await env.call('bob', 'photoUrls', { fileIDs: [photo] }))), { files: { [photo]: 'https://tmp/' + t }, thumbs: { [photo]: 1 } });
  assert.strictEqual(env.coll('players').p_alice.photoThumb, t);
  delete env.fileContents[t];
  ok(await env.call('bob', 'photoUrls', { fileIDs: [photo] }));
  assert.ok(!env.fileContents[t], '已经有缩略图：不再重做');
  // 解码不了：发原图，不标缩略图
  const bad = 'cloud://env1.x/player-photos/bob/old2.jpg';
  Object.assign(env.coll('players').p_bob, { photo: bad });
  assert.deepStrictEqual(urlsOf(ok(await env.call('alice', 'photoUrls', { fileIDs: [bad] }))), { files: { [bad]: 'https://tmp/' + bad }, thumbs: {} });
  assert.ok(!env.coll('players').p_bob.photoThumb);
  // 没同意公开展示：不补、不发
  const hidden = 'cloud://env1.x/player-photos/eve/old3.jpg';
  env.fileContents[hidden] = jpg(400, 400);
  Object.assign(env.coll('players').p_eve, { photo: hidden, shown: false });
  assert.deepStrictEqual(urlsOf(ok(await env.call('alice', 'photoUrls', { fileIDs: [hidden] }))), { files: {}, thumbs: {} });
  assert.ok(!env.fileContents['cloud://env1.x/player-photos/eve/old3-s.jpg']);
  // 补做期间照片被清除：刚做的缩略图删掉，不记上
  const race = 'cloud://env1.x/player-photos/carl/old4.jpg', raceT = 'cloud://env1.x/player-photos/carl/old4-s.jpg';
  const bytes = jpg(400, 400);
  Object.defineProperty(env.fileContents, race, { enumerable: true, get() { env.coll('players').p_carl.photo = ''; return bytes; } });
  Object.assign(env.coll('players').p_carl, { photo: race });
  ok(await env.call('alice', 'photoUrls', { fileIDs: [race] }));
  assert.ok(env.deletedFiles.includes(raceT));
  assert.ok(!env.coll('players').p_carl.photoThumb);
});

/* ---------- 第二批稳定性：申请领取超时、freeLock 事务、事务里文档缺失、单场安排、抢七小分、积分更正 ---------- */
// 锁定的日常比赛 + 一条待处理的改分申请（bob 提出，alice 处理）
async function lockedWithRequest(env) {
  const id = ok(await daily(env, 'alice', 'bob'))._id;
  ok(await env.call('bob', 'confirmResult', { matchId: id }));
  const req = ok(await env.call('bob', 'requestScoreChange', { matchId: id, sets: [{ a: 1, b: 4 }], reason: '比分录反了' }));
  return { id, reqId: req.requestId };
}
test('申请领取：处理中（未超时）不能重复处理；上次执行中断（领取超过 60 秒、或旧版没有领取时间）可以重新领取，两人同时回收只有一个成功', async () => {
  const env = setup();
  const { id, reqId } = await lockedWithRequest(env);
  const r = env.coll('requests')[reqId];
  Object.assign(r, { status: 'processing', claimedBy: 'alice', claimedMs: Date.now() - 5000 }); // 刚领取，云函数还在跑
  no(await env.call('alice', 'respondScoreChange', { requestId: reqId, accept: true }), /处理中/);
  no(await env.call('bob', 'cancelScoreChange', { requestId: reqId }), /处理中/);
  assert.strictEqual(env.coll('matches')[id].winner, 'a');
  // 领取 61 秒还没结束：上次执行已中断（云函数最长 60 秒），可以重新处理
  r.claimedMs = Date.now() - 61000;
  assert.strictEqual(ok(await env.call('alice', 'respondScoreChange', { requestId: reqId, accept: true })).status, 'accepted');
  assert.strictEqual(env.coll('matches')[id].winner, 'b');
  assert.strictEqual(env.coll('requests')[reqId].status, 'accepted');
  // 旧版领取的（没有 claimedMs）当作已中断；两人同时回收：只有一个成功
  const env2 = setup();
  const { reqId: q2 } = await lockedWithRequest(env2);
  Object.assign(env2.coll('requests')[q2], { status: 'processing', claimedBy: 'alice', claimedAt: 5 });
  const both = await Promise.all([env2.call('alice', 'respondScoreChange', { requestId: q2, accept: false }), env2.call('bob', 'cancelScoreChange', { requestId: q2 })]);
  assert.strictEqual(both.filter((x) => x.ok).length, 1, JSON.stringify(both));
  assert.ok(['rejected', 'cancelled'].includes(env2.coll('requests')[q2].status));
  // 管理员撤销：处理中（未超时）拒绝，中断的可以继续
  const env3 = setup();
  const { id: id3, reqId: q3 } = await lockedWithRequest(env3);
  Object.assign(env3.coll('requests')[q3], { status: 'processing', claimedBy: 'alice', claimedMs: Date.now() });
  no(await adminCall(env3, 'admin', 'revokeMatch', { matchId: id3 }), /处理中/);
  env3.coll('requests')[q3].claimedMs = Date.now() - 120000;
  ok(await adminCall(env3, 'admin', 'revokeMatch', { matchId: id3 }));
  assert.ok(!env3.coll('matches')[id3]);
  assert.strictEqual(env3.coll('requests')[q3].status, 'stale');
});
test('退赛申请领取中断：发起人可以重新处理；release 后领取时间清掉', async () => {
  const env = setup();
  env.put('draws', { _id: 'dw', _openid: 'owner', title: 'T', status: 'drawn', type: 'single', mode: 'bracket', size: 2, entrants: ['Alice', 'Bob'], lines: [{ name: 'Alice' }, { name: 'Bob' }] });
  env.put('signups', { _id: 'sa', _openid: 'alice', drawId: 'dw', name: 'Alice' });
  env.put('signups', { _id: 'sb', _openid: 'bob', drawId: 'dw', name: 'Bob' });
  const { requestId } = ok(await env.call('alice', 'requestWithdraw', { drawId: 'dw', reason: '受伤' }));
  Object.assign(env.coll('requests')[requestId], { status: 'processing', claimedBy: 'owner', claimedMs: Date.now() });
  no(await env.call('owner', 'handleWithdraw', { drawId: 'dw', requestId, approve: false, reason: '已经开赛，请打完' }), /处理中/);
  no(await env.call('alice', 'requestWithdraw', { drawId: 'dw', reason: '受伤' }), /待处理/);
  env.coll('requests')[requestId].claimedMs = Date.now() - 61000;
  assert.strictEqual(ok(await env.call('owner', 'handleWithdraw', { drawId: 'dw', requestId, approve: false, reason: '已经开赛，请打完' })).status, 'rejected');
});
test('freeLock：被拒后再次申请，归档和删除在同一事务里；同时提交两次只归档一份、只留一条待处理', async () => {
  const env = setup();
  const { id, reqId } = await lockedWithRequest(env);
  ok(await env.call('alice', 'respondScoreChange', { requestId: reqId, accept: false, note: '原比分没有问题' }));
  const ask = () => env.call('bob', 'requestScoreChange', { matchId: id, sets: [{ a: 1, b: 4 }], reason: '局数录错了' });
  const both = await Promise.all([ask(), ask()]);
  assert.strictEqual(both.filter((x) => x.ok).length, 1, JSON.stringify(both));
  const rs = Object.values(env.coll('requests')).filter((x) => x.type === 'score');
  assert.strictEqual(rs.filter((x) => x.archivedFrom === reqId).length, 1, '只归档一份');
  assert.strictEqual(rs.filter((x) => x.archivedFrom === reqId)[0].status, 'rejected');
  assert.strictEqual(env.coll('requests')[reqId].status, 'pending');
  assert.strictEqual(env.coll('requests')[reqId].reason, '局数录错了');
  // 有待处理的申请时不归档、不删除
  const before = JSON.stringify(env.coll('requests'));
  no(await ask(), /待处理/);
  assert.strictEqual(JSON.stringify(env.coll('requests')), before);
});

// 文档在事务里读的那一刻不在了（被删除 / 并发移除）：先空跑一次数出这份文档被读了几次，再在最后一次读之前删掉
const plainCopy = (v) => JSON.parse(JSON.stringify(v));
async function vanishAtLast(make, coll, id, run) {
  const e1 = make(); let n = 0;
  e1.beforeDocGet = (c, i) => { if (c === coll && i === id) n++; };
  await run(e1);
  const e2 = make(); let k = 0;
  e2.beforeDocGet = (c, i) => { if (c === coll && i === id && ++k === n) delete e2.coll(c)[i]; };
  assert.ok(n > 0, `${coll}/${id} 没被读过`);
  return run(e2);
}
test('事务里文档缺失：报名、取消报名、改规则、生成对阵、录分、照片的事务都按业务提示拒绝，不报服务器出错', async () => {
  const server = /服务器出错/;
  const bad = (r, what) => { if (r.ok === false) assert.ok(!server.test(r.error), `${what}：${r.error}`); };
  const withSignups = () => { const env = setup(); ['alice', 'bob', 'carl', 'eve'].forEach((u) => env.put('signups', { _id: 's_' + u, _openid: u, drawId: 'd1', name: u[0].toUpperCase() + u.slice(1), createdAt: 1 })); return env; };
  let r = await vanishAtLast(setup, 'draws', 'd1', (env) => env.call('alice', 'signUp', { drawId: 'd1' }));
  no(r, /截止/);
  r = await vanishAtLast(withSignups, 'draws', 'd1', (env) => env.call('alice', 'cancelSignup', { drawId: 'd1' }));
  no(r, /不能直接取消/);
  r = await vanishAtLast(setup, 'draws', 'd1', (env) => adminCall(env, 'owner', 'updateDrawSettings', { drawId: 'd1', settingsVersion: 0, settings: { mode: 'bracket', size: 4, rules: {} } }));
  no(r, /不能修改/);
  const D2 = require('../utils/draw');
  const ents = ['Alice', 'Bob', 'Carl', 'Eve'];
  r = await vanishAtLast(withSignups, 'draws', 'd1', (env) => adminCall(env, 'owner', 'generateDraw', { drawId: 'd1', draw: { entrants: ents, lines: D2.makeBracket(ents, [], 4), size: 4 } }));
  no(r, /已有更新/);
  const fixedLines = D2.makeBracket(ents, [], 4); // 抽签是随机的：几个环境共用同一份
  const drawn = () => { const env = setup(); env.put('draws', { _id: 'd5', _openid: 'owner', title: '周末赛', status: 'drawn', type: 'single', mode: 'bracket', size: 4, entrants: ents, lines: plainCopy(fixedLines) }); ents.forEach((n) => env.put('signups', { _id: 's_' + n, _openid: n.toLowerCase(), drawId: 'd5', name: n })); return env; };
  const E2 = require('../utils/event');
  const semi = E2.scheduleOf(Object.assign({}, drawn().coll('draws').d5), []).find((x) => x.ready);
  r = await vanishAtLast(drawn, 'draws', 'd5', (env) => env.call(semi.aMembers[0].toLowerCase(), 'recordEventMatch', { drawId: 'd5', key: semi.key, sets: [{ a: 4, b: 1 }] }));
  no(r, /对阵已更新/);
  // 照片：上传、清除时本人资料刚被删掉
  r = await vanishAtLast(setup, 'players', 'p_alice', (env) => env.call('alice', 'setPhoto', { fileID: pf('alice', 'v1') }));
  bad(r, 'setPhoto');
  const withPhoto = () => { const env = setup(); Object.assign(env.coll('players').p_alice, { photo: 'cloud://env1.x/player-photos/alice/old.jpg' }); return env; };
  r = await vanishAtLast(withPhoto, 'players', 'p_alice', (env) => env.call('alice', 'setPhoto', { fileID: '' }));
  bad(r, 'clearPhoto');
  // 检测结果回来时检测记录指向的资料已经不在：照常处理完，不公开、删掉检测副本
  const env = setup();
  env.put('avatar_checks', { _id: 'tz', uid: 'zed', playerId: 'p_zed', request: 'rq', status: 'checking', fileID: 'cloud://env1.x/player-photos/zed/rq.jpg', thumb: '', at: Date.now() });
  assert.strictEqual(await env.push({ trace_id: 'tz', result: { suggest: 'pass' } }), 'success');
  assert.strictEqual(env.coll('avatar_checks').tz.status, 'replaced');
  assert.ok(env.deletedFiles.includes('cloud://env1.x/player-photos/zed/rq.jpg'));
  // 检测超时（expireCheck）时资料不在：照样判为出错
  env.put('avatar_checks', { _id: 'tx', uid: 'alice', playerId: 'p_gone', request: '', status: 'checking', fileID: 'cloud://env1.x/player-photos/alice/x.jpg', at: Date.now() - 2 * 3600 * 1000 });
  ok(await env.call('alice', 'myPhoto'));
  assert.strictEqual(env.coll('avatar_checks').tx.status, 'error');
});
test('单场安排：只改这一场（slots.<key>），不覆盖别的场次；清空只去掉这一场', async () => {
  const env = setup();
  const ents = ['Alice', 'Bob', 'Carl', 'Eve'];
  env.put('draws', { _id: 'd5', _openid: 'owner', title: '周末赛', status: 'drawn', type: 'single', mode: 'bracket', size: 4, date: '2026-11-21', entrants: ents, lines: D.makeBracket(ents, [], 4), slots: {} });
  const E2 = require('../utils/event');
  const [k1, k2] = E2.scheduleOf(Object.assign({}, env.coll('draws').d5), []).filter((x) => x.ready).map((x) => x.key);
  // 两个页面都基于「没有安排」的旧数据各排一场：后保存的不会把先保存的冲掉
  const both = await Promise.all([
    env.call('owner', 'setFixtureSlot', { drawId: 'd5', key: k1, slot: { time: '09:00', court: '3 号场' } }),
    env.call('owner', 'setFixtureSlot', { drawId: 'd5', key: k2, slot: { time: '10:00' } }),
  ]);
  both.forEach(ok);
  assert.deepStrictEqual(Object.keys(env.coll('draws').d5.slots).sort(), [k1, k2].sort());
  assert.strictEqual(env.coll('draws').d5.slots[k1].time, '09:00');
  ok(await env.call('owner', 'setFixtureSlot', { drawId: 'd5', key: k1, slot: {} }));
  assert.deepStrictEqual(Object.keys(env.coll('draws').d5.slots), [k2]);
  // 很老的活动没有 slots 字段：同时排两场也走 slots.<key>，不会互相冲掉
  delete env.coll('draws').d5.slots;
  const bothOld = await Promise.all([
    env.call('owner', 'setFixtureSlot', { drawId: 'd5', key: k1, slot: { time: '08:30' } }),
    env.call('owner', 'setFixtureSlot', { drawId: 'd5', key: k2, slot: { time: '09:30' } }),
  ]);
  bothOld.forEach(ok);
  assert.deepStrictEqual(Object.keys(env.coll('draws').d5.slots).sort(), [k1, k2].sort());
  assert.strictEqual(env.coll('draws').d5.slots[k1].time, '08:30');
  assert.strictEqual(env.coll('draws').d5.slots[k2].time, '09:30');
  // 直接带名单创建的活动：初始就有 slots 对象
  const directId = ok(await adminCall(env, 'owner', 'createDraw', {
    draw: { title: '直接签表', mode: 'bracket', size: 4, entrants: ents, lines: D.makeBracket(ents, [], 4) },
  })).id;
  assert.deepStrictEqual(env.coll('draws')[directId].slots, {});
});
test('中途退赛：抢七小分必须是两边都填的合法整数；没填照常', async () => {
  const ents = ['Alice', 'Bob', 'Carl', 'Eve'];
  const fixedLines = D.makeBracket(ents, [], 4);
  const mk = () => { const env = setup(); env.put('draws', { _id: 'd5', _openid: 'owner', title: '周末赛', status: 'drawn', type: 'single', mode: 'bracket', size: 4, entrants: ents, lines: plainCopy(fixedLines), rules: { setGames: 6, noAd: true, bestOf: 3 } }); ents.forEach((n) => env.put('signups', { _id: 's_' + n, _openid: n.toLowerCase(), drawId: 'd5', name: n })); return env; };
  const E2 = require('../utils/event');
  const key = E2.scheduleOf(Object.assign({}, mk().coll('draws').d5), []).find((x) => x.ready).key;
  const go = (env, sets) => env.call('owner', 'resolveFixture', { drawId: 'd5', key, kind: 'retired', loser: 'a', reason: '受伤', sets });
  for (const tb of [['x', '5'], ['7.5', '5'], ['-1', '5'], ['7', ''], ['', '3'], [7, 'abc'], ['100', '5']]) {
    const env = mk();
    no(await go(env, [{ a: 7, b: 6, tbA: tb[0], tbB: tb[1] }]), /抢七/);
    assert.ok(!Object.values(env.coll('matches')).length, JSON.stringify(tb));
  }
  let env = mk();
  ok(await go(env, [{ a: 7, b: 6, tbA: 7, tbB: '5' }, { a: 2, b: 1 }]));
  const m = Object.values(env.coll('matches'))[0];
  assert.deepStrictEqual([m.sets[0].tbA, m.sets[0].tbB], [7, 5]);
  assert.ok(!('tbA' in m.sets[1]));
  env = mk();
  ok(await go(env, [{ a: 3, b: 2, tbA: null, tbB: null }]));
  assert.ok(!('tbA' in Object.values(env.coll('matches'))[0].sets[0]), 'null 当作没填');
});

/* ---------- 2026-11-25 云函数提速（并行查库）：返回内容不变 ---------- */
test('matchState 并行查库后返回不变：日常（参加者 / 旁人 / detail）、有待处理改分申请、活动（发起人 / 对方待确认）、被取代的旧记录不补快照', async () => {
  const env = setup();
  const id = ok(await daily(env, 'alice', 'bob'))._id;
  const d0 = ok(await env.call('alice', 'matchState', { matchId: id, detail: true }));
  assert.deepStrictEqual([d0.finished, d0.reason, d0.daily, d0.confirmed, d0.canEdit, d0.canConfirm, d0.status, d0.changes, d0.sides, d0.request],
    [true, '', true, false, true, false, 'official', [], { a: '录入', b: '' }, null]);
  assert.strictEqual(d0.match._id, id);
  const e0 = ok(await env.call('eve', 'matchState', { matchId: id }));
  assert.deepStrictEqual([e0.mySide, e0.canEdit, e0.reason, 'match' in e0, 'status' in e0], ['', false, '你不是这场比赛的参加者（按账号判断，不看昵称）', false, false]);
  // 锁定 + 改分申请：参加者看得到原因，旁人看不到；改分申请的申请人名字、确认方名字都对
  ok(await env.call('bob', 'confirmResult', { matchId: id }));
  ok(await env.call('bob', 'requestScoreChange', { matchId: id, sets: [{ a: 4, b: 1 }], reason: '比分录反了' }));
  const a1 = ok(await env.call('alice', 'matchState', { matchId: id, detail: true }));
  assert.deepStrictEqual([a1.confirmed, a1.sides, a1.canEdit, a1.canRequestChange, a1.request.requester, a1.request.reason, a1.request.canRespond, a1.request.mine],
    [true, { a: '录入', b: 'Bob' }, false, false, 'Bob', '比分录反了', true, false]);
  const e1 = ok(await env.call('eve', 'matchState', { matchId: id }));
  assert.deepStrictEqual([e1.request.reason, e1.request.canRespond, e1.request.requester], ['', false, 'Bob']);
  // 活动比赛：发起人 isOwner，对方待确认
  const ents = ['Alice', 'Bob', 'Carl', 'Eve'];
  env.put('draws', { _id: 'd5', _openid: 'owner', title: '周末赛', status: 'drawn', type: 'single', mode: 'bracket', size: 4, entrants: ents, lines: D.makeBracket(ents, [], 4) });
  ents.forEach((n) => env.put('signups', { _id: 's_' + n, _openid: n.toLowerCase(), drawId: 'd5', name: n }));
  const E = require('../utils/event');
  const semi = E.scheduleOf(Object.assign({}, env.coll('draws').d5), []).find((x) => x.ready && x.aMembers.concat(x.bMembers).indexOf('Alice') >= 0);
  const aSide = semi.aMembers[0] === 'Alice';
  const opp = (aSide ? semi.bMembers[0] : semi.aMembers[0]).toLowerCase();
  const sid = ok(await env.call('alice', 'recordEventMatch', { drawId: 'd5', key: semi.key, sets: [aSide ? { a: 4, b: 1 } : { a: 1, b: 4 }] })).matchId;
  const o = ok(await env.call('owner', 'matchState', { matchId: sid, detail: true }));
  assert.deepStrictEqual([o.isOwner, o.daily, o.confirmed, o.status, o.drawId, o.drawKey], [true, false, false, 'official', 'd5', semi.key]);
  const op = ok(await env.call(opp, 'matchState', { matchId: sid }));
  assert.deepStrictEqual([op.isOwner, op.canConfirm, op.reason], [false, true, '请先确认比分']);
  // 被取代：同一场两条云端写入的记录，旧的那条返回 supersededBy，不带确认情况，也不补 verified 快照
  const base = { type: 'single', a: ['Alice'], b: ['Bob'], aIds: ['alice'], bIds: ['bob'], drawId: 'd5', drawKey: 'zz', winner: 'a', sets: [{ a: 4, b: 1 }], date: '2026-11-02', recordedBy: 'alice', rulingSig: '' };
  env.put('matches', Object.assign({ _id: 'old1', createdAt: 1 }, base));
  env.put('matches', Object.assign({ _id: 'new1', createdAt: 2 }, base, { sets: [{ a: 4, b: 2 }] }));
  const sup = ok(await env.call('alice', 'matchState', { matchId: 'old1', detail: true }));
  assert.deepStrictEqual([sup.finished, sup.reason, sup.supersededBy, 'confirmed' in sup, 'request' in sup, sup.match._id, sup.status], [false, '这条比分已被新的记录取代', 'new1', false, false, 'old1', 'official']);
  assert.ok(!env.coll('verified').old1);
  // 不存在的比赛：照旧按原来的提示拒绝
  const gone = ok(await env.call('alice', 'matchState', { matchId: 'nope' }));
  assert.deepStrictEqual([gone.finished, gone.reason, gone.drawId, gone.outcome], [false, '比赛记录不存在（可能已被撤销）', '', '']);
  no(await env.call('alice', 'matchState', {}), /缺少比赛/);
});

test('listMembers 三个集合一起查后返回不变：待审核 / 成员 / 已拒绝（收起的不显示）/ 历史球友 / 有效邀请；取最早那条资料；超过 1000 条照样读全', async () => {
  const env = setup();
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = 'boss';
  try {
    env.put('members', { _id: 'p1', status: 'pending', name: 'P1' });
    env.put('members', { _id: 'r1', status: 'rejected', name: 'R1', reason: '不认识这位球友' });
    env.put('members', { _id: 'r2', status: 'rejected', name: 'R2', reason: '自己写的原因' });
    env.put('members', { _id: 'x1', status: 'removed', name: 'X1', archived: true });
    env.put('players', { _id: 'ghost', _openid: 'ghost', self: true, name: 'Ghost', createdAt: 0 });
    env.put('players', { _id: 'dup', _openid: 'alice', self: true, name: 'AliceNew', createdAt: 99, gender: 'f' });
    env.put('invites', { _id: 'INV1', usedBy: '', revoked: false, expiresAt: Date.now() + 86400000, note: '' });
    env.put('invites', { _id: 'INV0', usedBy: 'bob', revoked: false, expiresAt: Date.now() + 86400000 });
    env.put('invites', { _id: 'INV2', usedBy: '', revoked: true, expiresAt: Date.now() + 86400000 });
    for (let i = 0; i < 1005; i++) env.put('members', { _id: 'm' + i, status: 'active', name: 'M' + i });
    const d = ok(await env.call('boss', 'listMembers'));
    assert.deepStrictEqual(d.pending.map((x) => x.uid), ['p1']);
    assert.deepStrictEqual(d.others.map((x) => [x.uid, x.reason]), [['r1', '不认识这位球友'], ['r2', '']], '手写的旧原因不下发');
    assert.strictEqual(d.active.length, 5 + 1005 + 1, '超过 1000 位成员照样读全；不在成员表里的管理员也列出来');
    assert.ok(d.active.some((x) => x.uid === 'boss' && x.admin));
    assert.strictEqual(d.active.find((x) => x.uid === 'alice').nickname, 'Alice', '有重复资料时取最早那条');
    assert.deepStrictEqual(d.candidates, [{ uid: 'ghost', nickname: 'Ghost' }]);
    assert.deepStrictEqual(d.invites.map((x) => x.code), ['INV1']);
    no(await env.call('alice', 'listMembers'), /管理员/);
  } finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
});

module.exports = T;
