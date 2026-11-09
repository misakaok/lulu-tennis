// 订阅消息：云函数在录分、申请、处理结果时通知对应的人
const assert = require('assert');
const createEnv = require('./mock-cloud');

const T = [];
const test = (name, fn) => T.push({ name, fn });
const ok = (r) => { assert.ok(r && r.ok, JSON.stringify(r)); return r; };

const CFG = {
  state: 'trial',
  templates: {
    confirm: { id: 'T_CONFIRM', fields: { title: 'thing1', score: 'character_string2', opponent: 'thing3', time: 'time4' } },
    request: { id: 'T_REQUEST', fields: { type: 'thing1', applicant: 'thing2', reason: 'thing3', time: 'time4' } },
    result: { id: 'T_RESULT', fields: { type: 'thing1', result: 'phrase2', note: 'thing3', time: 'time4' } },
  },
};
function setup(cfg) {
  const env = createEnv();
  env.load(undefined, cfg === undefined ? CFG : cfg);
  env.members([['alice', 'Alice'], ['bob', 'Bob'], ['owner', 'Owner']]);
  ['alice', 'bob', 'owner', 'admin', 'newbie'].forEach((u) => { env.subscribed[u] = true; });
  return env;
}
const daily = (env) => env.call('alice', 'data', { op: 'add', coll: 'matches', data: { a: ['Alice'], b: ['Bob'], aIds: ['alice'], bIds: ['bob'], winner: 'a', sets: [{ a: 4, b: 2 }], date: '2026-11-01' } });

test('日常比赛录入后通知对手确认，内容符合模板长度限制', async () => {
  const env = setup();
  const id = ok(await daily(env))._id;
  assert.strictEqual(env.sent.length, 1);
  const s = env.sent[0];
  assert.strictEqual(s.touser, 'bob'); assert.strictEqual(s.templateId, 'T_CONFIRM'); assert.strictEqual(s.miniprogramState, 'trial');
  assert.strictEqual(s.page, 'pages/match/match?id=' + id);
  assert.strictEqual(s.data.thing1.value, '日常比赛'); assert.strictEqual(s.data.thing3.value, 'Alice');
  assert.match(s.data.character_string2.value, /^[\x21-\x7e]+$/); assert.match(s.data.time4.value, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});
test('对方没订阅：跳过，不影响录入', async () => {
  const env = setup();
  env.subscribed.bob = false;
  ok(await daily(env));
  assert.strictEqual(env.sent.length, 0);
  assert.strictEqual(Object.keys(env.coll('matches')).length, 1);
});
test('改分申请通知对方，处理结果通知申请人', async () => {
  const env = setup();
  const id = ok(await daily(env))._id;
  ok(await env.call('bob', 'confirmResult', { matchId: id }));
  env.sent.length = 0;
  const req = ok(await env.call('bob', 'requestScoreChange', { matchId: id, sets: [{ a: 2, b: 4 }], reason: '记反了' }));
  assert.deepStrictEqual(env.sent.map((x) => [x.touser, x.templateId]), [['alice', 'T_REQUEST']]);
  assert.strictEqual(env.sent[0].data.thing2.value, 'Bob'); assert.strictEqual(env.sent[0].data.thing3.value, '记反了');
  env.sent.length = 0;
  ok(await env.call('alice', 'respondScoreChange', { requestId: req.requestId, accept: true }));
  assert.deepStrictEqual(env.sent.map((x) => [x.touser, x.templateId, x.data.phrase2.value]), [['bob', 'T_RESULT', '已同意']]);
});
test('成员申请通知管理员，审核结果通知申请人', async () => {
  const env = setup();
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = 'admin';
  try {
    ok(await env.call('newbie', 'applyMember', { name: '小王', note: '周六一起打球的朋友介绍的，想加入大家一起打比赛记录战绩' }));
    assert.deepStrictEqual(env.sent.map((x) => [x.touser, x.templateId]), [['admin', 'T_REQUEST']]);
    assert.ok(env.sent[0].data.thing3.value.length <= 20, 'thing 类型最多 20 字');
    env.sent.length = 0;
    ok(await env.call('admin', 'reviewMember', { uid: 'newbie', approve: true }));
    assert.deepStrictEqual(env.sent.map((x) => [x.touser, x.data.phrase2.value]), [['newbie', '已通过']]);
  } finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
});
test('没配置模板：不发送；模板 ID 接口非成员也能取', async () => {
  const env = setup({ state: 'formal', templates: { confirm: { id: '', fields: {} } } });
  ok(await daily(env));
  assert.strictEqual(env.sent.length, 0);
  assert.deepStrictEqual(ok(await env.call('stranger', 'notifyTemplates')).templates, {});
  const env2 = setup();
  assert.deepStrictEqual(ok(await env2.call('stranger', 'notifyTemplates')).templates, { confirm: 'T_CONFIRM', request: 'T_REQUEST', result: 'T_RESULT' });
});

test('赛事录分后通知对方；发起人代录时通知双方', async () => {
  const env = setup();
  env.put('draws', { _id: 'd1', _openid: 'owner', title: '周末赛', status: 'drawn', type: 'single', mode: 'bracket', size: 2, entrants: ['Alice', 'Bob'], lines: [{ name: 'Alice' }, { name: 'Bob' }] });
  env.put('signups', { _id: 'sa', _openid: 'alice', drawId: 'd1', name: 'Alice' });
  env.put('signups', { _id: 'sb', _openid: 'bob', drawId: 'd1', name: 'Bob' });
  ok(await env.call('alice', 'recordEventMatch', { drawId: 'd1', key: '0-0', sets: [{ a: 4, b: 1 }] }));
  assert.deepStrictEqual(env.sent.map((x) => x.touser), ['bob']);
  assert.match(env.sent[0].data.thing1.value, /周末赛/);
  env.sent.length = 0;
  ok(await env.call('owner', 'recordEventMatch', { drawId: 'd1', key: '0-0', sets: [{ a: 4, b: 2 }] }));
  assert.deepStrictEqual(env.sent.map((x) => x.touser).sort(), ['alice', 'bob']);
});

module.exports = T;
