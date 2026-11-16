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

test('日常比赛：普通用户不能新增，但参赛双方可直接改分；锁定后对方确认，无须管理员', async () => {
  const env = setup();
  const payload = { op: 'add', coll: 'matches', isAdmin: true, openid: 'owner', data: { a: ['Alice'], b: ['Bob'], aIds: ['alice'], bIds: ['bob'], winner: 'a', sets: [{ a: 4, b: 2 }] } };
  for (const uid of ['alice', 'bob']) no(await env.call(uid, 'data', payload), /管理员/);
  assert.strictEqual(Object.keys(env.coll('matches')).length, 0);
  const id = ok(await adminCall(env, 'alice', 'data', payload))._id;
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
const daily = (env, uid, opp, extra) => adminCall(env, uid, 'data', { op: 'add', coll: 'matches', data: Object.assign({ a: ['N'], b: ['M'], aIds: [uid], bIds: [opp], winner: 'a', sets: [{ a: 4, b: 2 }], date: '2026-11-01' }, extra) });
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
    no(await env.call('outsider', 'adminFixScore', fix), /内部球友/);
    for (const outcome of ['walkover', 'retired', 'cancelled']) {
      env.coll('matches')[id].outcome = outcome;
      no(await env.call('admin', 'adminFixScore', fix), /弃权|退赛|取消/);
      assert.strictEqual(env.coll('matches')[id].winner, 'a');
    }
    env.put('matches', { _id: 'fakeEvent', _openid: 'alice', drawId: 'd1', drawKey: 'k1-0', a: ['Alice'], b: ['Bob'], winner: 'a', sets: [{ a: 4, b: 2 }] });
    no(await env.call('admin', 'adminFixScore', { matchId: 'fakeEvent', sets: [{ a: 1, b: 4 }] }), /不予认可/);
  } finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
});

test('日常比赛：管理员录入即生效；普通参赛者改分留档且不重复写入', async () => {
  const env = setup();
  const id = ok(await daily(env, 'alice', 'bob'))._id;
  const st = ok(await env.call('bob', 'matchState', { matchId: id, detail: true }));
  assert.strictEqual(st.status, 'official');
  assert.ok(!st.canConfirm && st.canEdit && !st.reason);
  const ds = ok(await env.call('bob', 'dataset', {}));
  assert.strictEqual(ds.matches.find((m) => m._id === id).status, 'official');
  // 不进待办
  const t = ok(await env.call('bob', 'myTodos', {}));
  assert.ok(!t.toConfirm.length && !t.waiting.length);
  assert.ok(!ok(await env.call('alice', 'myTodos', {})).waiting.length);
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
  // 撤销仍然只有录入人
  no(await env.call('bob', 'revokeMatch', { matchId: id }));
  ok(await env.call('alice', 'revokeMatch', { matchId: id }));
});

test('日常比赛：管理员也只能记录自己参加的比赛（按用户 ID）', async () => {
  const env = setup();
  no(await adminCall(env, 'eve', 'data', { op: 'add', coll: 'matches', data: { a: ['Alice'], b: ['Bob'], aIds: ['alice'], bIds: ['bob'], winner: 'a', sets: [{ a: 4, b: 2 }], date: '2026-11-01' } }), /自己参加/);
  no(await adminCall(env, 'eve', 'data', { op: 'add', coll: 'matches', data: { a: ['Eve'], b: ['Bob'], winner: 'a', sets: [{ a: 4, b: 2 }], date: '2026-11-01' } }), /自己参加/);
  ok(await adminCall(env, 'bob', 'data', { op: 'add', coll: 'matches', data: { a: ['Alice'], b: ['Bob'], aIds: ['alice'], bIds: ['bob'], winner: 'a', sets: [{ a: 4, b: 2 }], date: '2026-11-01' } })); // 在 B 方也可以
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

test('成员管理：管理员可以替成员补选性别（只改性别、留档）；成员列表带性别', async () => {
  const env = setup();
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = 'admin';
  try {
    env.put('members', { _id: 'admin', status: 'active' });
    env.put('members', { _id: 'ghost', status: 'active' }); // 还没设置资料
    no(await env.call('alice', 'setMemberGender', { uid: 'bob', gender: 'm' }), /管理员/);
    no(await env.call('admin', 'setMemberGender', { uid: 'bob', gender: '' }), /男或女/);
    no(await env.call('admin', 'setMemberGender', { uid: 'ghost', gender: 'm' }), /还没有设置资料/);
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
test('资料：禁止新头像，保存昵称不修改旧头像', async () => {
  const env = setup();
  for (const avatar of ['cloud://env1.x/avatars/alice/a.jpg', 'cloud://env1.x/avatars/eve/1.jpg']) {
    no(await env.call('eve', 'saveProfile', { gender: 'm', name: 'Eve', avatar }), /停用/);
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
  ok(await env.call('new', 'saveProfile', { gender: 'm', name: 'Newbie', level: 2.5 }));
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
  no(await adminCall(env, 'owner', 'createDraw', { draw: Object.assign({}, settings, { title: '检测超时测试' }) }), /检测/);
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
  assert.ok(!JSON.stringify(ok(await env.call('owner', 'myTodos'))).includes('旧的手写退赛原因'));
});
test('准入：称呼先过内容检测，不接收申请说明和邀请备注；拒绝原因只能是固定选项，旧的手写内容不下发', async () => {
  const env = setup();
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = 'admin';
  try {
    env.put('members', { _id: 'admin', status: 'active' });
    env.checkText = () => ({ result: { suggest: 'risky' } });
    no(await env.call('n1', 'applyMember', { name: '不合适的称呼', note: '手写说明' }), /称呼.*内容/);
    assert.ok(!env.coll('members').n1);
    const code = ok(await env.call('admin', 'createInvite', { note: '手写备注', days: 7 })).code;
    assert.strictEqual(env.coll('invites')[code].note, '');
    no(await env.call('n1', 'acceptInvite', { code, name: '不合适的称呼' }), /称呼.*内容/);
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
  const todos = ok(await env.call('bob', 'myTodos'));
  assert.ok(todos.toConfirm.every((x) => !x.title.includes('私人')));
  assert.strictEqual(ok(await env.call('eve', 'drawRequests', { drawId: 'd1' })).withdrawals[0].reason, undefined);
  assert.strictEqual(env.coll('draws').d1.title, '旧自定义活动');
  assert.strictEqual(env.coll('matches').legacy_title.drawTitle, '旧自定义活动');
  assert.strictEqual(env.coll('matches').legacy_title.resolution.reason, '旧私人处理原因');
  assert.strictEqual(env.coll('draws').d1.withdrawals[0].reason, '旧私人退赛原因');
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
test('相册已停用：不能读取照片数量或通过旧检测回调发布图片', async () => {
  const env = setup();
  env.put('event_photos', { _id: 'ph1', drawId: 'd1', status: 'checking', traceId: 'trace1' });
  const before = JSON.stringify(env.store);
  no(await env.call('alice', 'eventPhotoCount', { drawId: 'd1' }), /未知操作/);
  no(await env.call('', '', { Event: 'wxa_media_check', trace_id: 'trace1', result: { suggest: 'pass' } }), /未知操作/);
  assert.strictEqual(JSON.stringify(env.store), before);
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
  no(await env.call('x2', 'acceptInvite', { code: 'good' }), /已被使用/);  // 已经提交过申请、还在等审核的人：用邀请码直接成为正式成员，不需要管理员再审核
  env.put('invites', { _id: 'good2', usedBy: '', revoked: false, expiresAt: Date.now() + 1e6 });
  ok(await env.call('x3', 'applyMember', { name: '审核员' }));
  assert.strictEqual(env.coll('members').x3.status, 'pending');
  no(await env.call('x3', 'ping', {}), /./);
  ok(await env.call('x3', 'acceptInvite', { code: 'good2' }));
  assert.strictEqual(env.coll('members').x3.status, 'active');
  ok(await env.call('x3', 'ping', {}));
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

test('订阅消息已移除：没有 notifyTemplates 操作；录分、申请、审核照常', async () => {
  const env = setup();
  assert.strictEqual((await env.call('alice', 'notifyTemplates')).error, '未知操作');
  const id = ok(await adminCall(env, 'alice', 'data', { op: 'add', coll: 'matches', data: { a: ['Alice'], b: ['Bob'], aIds: ['alice'], bIds: ['bob'], winner: 'a', sets: [{ a: 4, b: 2 }], date: '2026-11-01' } }))._id;
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

module.exports = T;
