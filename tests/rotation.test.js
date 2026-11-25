// 四人轮换双打（2026-11-23 用户要求）：固定 4 人单独报名，满员后发起人确认生成三轮对阵，三轮换搭档；
// 每轮一条比赛记录（录分、改分、退赛沿用活动原来的流程），普通活动：不出总名次、不计 LULU 积分。在内存数据库里跑真实云函数代码
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const createEnv = require('./mock-cloud');
const E = require('../utils/event');
const C = require('../utils/cup');
const ID = require('../utils/ident');

const T = [];
const test = (name, fn) => T.push({ name, fn });
const ok = (r) => { assert.ok(r && r.ok, JSON.stringify(r)); return r; };
const no = (r, re) => { assert.strictEqual(r && r.ok, false, '应该被拒绝：' + JSON.stringify(r)); if (re) assert.match(r.error, re); return r; };
const read = (f) => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));
const ADMIN = 'admin';
const NAMES = ['Alice', 'Bob', 'Carl', 'Dora', 'Eve'];

function setup() {
  const env = createEnv();
  env.load();
  env.members([[ADMIN, '管理员']].concat(NAMES.map((n) => [n.toLowerCase(), n])));
  return env;
}
async function asAdmin(env, action, data) {
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = ADMIN;
  try { return await env.call(ADMIN, action, data); }
  finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
}
const newRotation = async (env, extra) => ok(await asAdmin(env, 'createDraw', { draw: Object.assign({ title: '周末四人轮换', mode: 'rotation', date: '2026-11-22', rules: { group: { setGames: 4, noAd: true, bestOf: 1 } } }, extra || {}) })).id;
const signAll = async (env, id, names) => { for (const n of names) ok(await env.call(n.toLowerCase(), 'signUp', { drawId: id })); };
const uidMap = (names) => { const m = {}; names.forEach((n) => { m[n] = n.toLowerCase(); }); return m; };
const generate = (env, id, names, o) => asAdmin(env, 'generateDraw', { drawId: id, draw: Object.assign({ entrants: names, uidOf: uidMap(names) }, o || {}) });
const schOf = (env, id) => E.scheduleOf(Object.assign({ _id: id }, env.coll('draws')[id]), Object.values(env.coll('matches')).filter((m) => m.drawId === id));
const recsOf = (env, id) => Object.values(env.coll('matches')).filter((m) => m.drawId === id);

test('排法：第 1 轮 A＋B 对 C＋D，第 2 轮 A＋C 对 B＋D，第 3 轮 A＋D 对 B＋C；每人三轮都上场，任意两人恰好搭档一次、对手两次', () => {
  const ents = ['A', 'B', 'C', 'D'];
  const r = E.rotationPairs(ents);
  assert.deepStrictEqual(r, [[['A', 'B'], ['C', 'D']], [['A', 'C'], ['B', 'D']], [['A', 'D'], ['B', 'C']]]);
  r.forEach(([a, b]) => assert.deepStrictEqual(a.concat(b).sort(), ents, '每一轮 4 个人都上场'));
  const partner = {}, opp = {};
  const k = (x, y) => [x, y].sort().join('');
  r.forEach(([a, b]) => {
    [a, b].forEach((t) => { partner[k(t[0], t[1])] = (partner[k(t[0], t[1])] || 0) + 1; });
    a.forEach((x) => b.forEach((y) => { opp[k(x, y)] = (opp[k(x, y)] || 0) + 1; }));
  });
  assert.deepStrictEqual(Object.keys(partner).sort(), ['AB', 'AC', 'AD', 'BC', 'BD', 'CD']);
  assert.ok(Object.values(partner).every((n) => n === 1), '任意两人恰好搭档一次');
  assert.ok(Object.values(opp).every((n) => n === 2) && Object.keys(opp).length === 6, '任意两人做对手两次');
  assert.deepStrictEqual(Object.keys(E.rotationTeams(ents)).sort(), ['A / B', 'A / C', 'A / D', 'B / C', 'B / D', 'C / D']);
  // 规则、名额、叫法
  const d = { mode: 'rotation', rules: { group: { setGames: 6, noAd: false, bestOf: 1 }, ko: { setGames: 4, noAd: true, bestOf: 1 } } };
  assert.deepStrictEqual([E.ruleFor(d, 't2').setGames, E.ruleFor(d, 't2').noAd, E.ruleFor(d, 't2').type], [6, false, 'double'], '三轮沿用活动选定的规则');
  assert.deepStrictEqual(E.rulesSummary(d).map((x) => x.stage), ['每轮']);
  assert.strictEqual(E.capacityOf(d), 4, '固定 4 个个人名额');
  assert.strictEqual(E.cfgOf(d).type, 'double');
  assert.strictEqual(E.hasKo(d) || E.hasGroups(d), false);
  assert.strictEqual(E.categoryOf(Object.assign({ category: 'mixed' }, d)), '', '没有混双');
  assert.ok(C.drawCupError(d, 'weekly') && C.drawCupError(d, 'monthly') && C.drawCupError(d, 'encounter'), '不计 LULU 积分');
  assert.deepStrictEqual(E.scheduleOf(Object.assign({ status: 'drawn', entrants: ['A', 'B', 'C'] }, d), []), [], '不是 4 人没有场次');
});

test('创建和报名：只有管理员能建；固定双打 4 人、不能直接选人；每人单独报名（不能带搭档），满 4 人后的进候补，取消后递补；不能计 LULU 积分', async () => {
  const env = setup();
  no(await env.call('alice', 'createDraw', { draw: { title: '周末四人轮换', mode: 'rotation' } }), /管理员/);
  const id = await newRotation(env, { type: 'single', size: 16, limit: 8, groupCount: 3, category: 'mixed' });
  const d = env.coll('draws')[id];
  assert.deepStrictEqual([d.mode, d.type, d.size, d.status, 'limit' in d, 'groupCount' in d, 'category' in d], ['rotation', 'double', 4, 'signup', false, false, false]);
  no(await asAdmin(env, 'createDraw', { draw: { title: '直接选人', mode: 'rotation', entrants: ['Alice', 'Bob', 'Carl', 'Dora'], uidOf: uidMap(['Alice', 'Bob', 'Carl', 'Dora']) } }), /先开放报名/);
  no(await asAdmin(env, 'createDraw', { draw: { title: '计积分', mode: 'rotation', cup: { kind: 'encounter' } } }), /最后一轮/);
  no(await env.call('alice', 'signUp', { drawId: id, partnerId: 'bob' }), /单独报名/);
  await signAll(env, id, NAMES);
  const su = () => Object.values(env.coll('signups')).filter((s) => s.drawId === id);
  assert.ok(su().every((s) => !s.partner));
  const wait = () => E.waitingOf(su(), E.capacityOf(d));
  assert.deepStrictEqual(Object.keys(wait()), [su().find((s) => s._openid === 'eve')._id], '第 5 位进候补');
  assert.strictEqual(E.signupStatus(d, su()).text, '已满 · 候补 1 人');
  assert.deepStrictEqual([E.signupStatus(d, su().slice(0, 3)).text, E.signupStatus(d, su().slice(0, 3)).note], ['已报名 3/4 人 · 还差 1 人', ''], '只剩 1 个名额也不提「带搭档报名」（轮换不能带搭档）');
  ok(await env.call('bob', 'cancelSignup', { drawId: id }));
  assert.deepStrictEqual(Object.keys(wait()), [], '有人取消，候补自动递补');
});

test('生成对阵：少于 4 人、重名、没有成员账号的都不能生成；只有发起人（管理员）能生成；生成后三轮固定，录分后不能重排', async () => {
  const env = setup();
  const id = await newRotation(env);
  await signAll(env, id, ['Alice', 'Bob', 'Carl']);
  no(await generate(env, id, ['Alice', 'Bob', 'Carl']), /正好 4 位/);
  no(await generate(env, id, ['Alice', 'Bob', 'Carl', 'Carl']), /正好 4 位|重复/);
  no(await generate(env, id, ['Alice', 'Bob', 'Carl', '路人']), /对应的成员账号/, '名单里有人没账号');
  no(await env.call('alice', 'generateDraw', { drawId: id, draw: { entrants: ['Alice', 'Bob', 'Carl', 'Dora'] } }), /管理员/);
  await signAll(env, id, ['Dora']);
  // 前端传来的分队、签位不算数：搭档由公式算
  ok(await generate(env, id, ['Alice', 'Bob', 'Carl', 'Dora'], { teams: { 'Alice / Dora': ['Alice', 'Dora'] }, lines: [{ name: 'Alice' }, { name: 'Bob' }] }));
  const d = env.coll('draws')[id];
  assert.deepStrictEqual([d.status, d.entrants, 'lines' in d, 'groups' in d], ['drawn', ['Alice', 'Bob', 'Carl', 'Dora'], false, false]);
  assert.deepStrictEqual(Object.keys(d.teams).sort(), ['Alice / Bob', 'Alice / Carl', 'Alice / Dora', 'Bob / Carl', 'Bob / Dora', 'Carl / Dora']);
  assert.deepStrictEqual(d.uidOf, { Alice: 'alice', Bob: 'bob', Carl: 'carl', Dora: 'dora' });
  const s = schOf(env, id);
  assert.deepStrictEqual(s.map((x) => [x.key, x.stage, x.a, x.b, x.ready]), [
    ['t0', '四人轮换双打 · 第 1 轮', 'Alice / Bob', 'Carl / Dora', true],
    ['t1', '四人轮换双打 · 第 2 轮', 'Alice / Carl', 'Bob / Dora', true],
    ['t2', '四人轮换双打 · 第 3 轮', 'Alice / Dora', 'Bob / Carl', true],
  ]);
  no(await env.call('alice', 'cancelSignup', { drawId: id }), /对阵表已经生成/);
  ok(await env.call('alice', 'recordEventMatch', { drawId: id, key: 't0', sets: [{ a: 4, b: 2 }] }));
  no(await generate(env, id, ['Dora', 'Carl', 'Bob', 'Alice']), /已经有比赛录分了/, '已打的轮次不会被悄悄重排');
  assert.deepStrictEqual(env.coll('draws')[id].entrants, ['Alice', 'Bob', 'Carl', 'Dora']);
});

test('录分：每轮比分归到这一轮的四个人（搭档、对手、用户 ID）；同一轮重复提交只有一条；不在这轮的人不能录；锁定后走改分申请；不出总名次', async () => {
  const env = setup();
  const id = await newRotation(env);
  await signAll(env, id, ['Alice', 'Bob', 'Carl', 'Dora']);
  ok(await generate(env, id, ['Alice', 'Bob', 'Carl', 'Dora']));
  no(await env.call('eve', 'recordEventMatch', { drawId: id, key: 't1', sets: [{ a: 4, b: 1 }] }), /只有这场的球员或活动发起人/);
  ok(await env.call('alice', 'recordEventMatch', { drawId: id, key: 't0', sets: [{ a: 4, b: 2 }] })); // Alice＋Bob 赢
  ok(await env.call('dora', 'recordEventMatch', { drawId: id, key: 't1', sets: [{ a: 1, b: 4 }] })); // Bob＋Dora 赢（Dora 在 B 方，比分按 A 方在前）
  ok(await env.call('carl', 'recordEventMatch', { drawId: id, key: 't2', sets: [{ a: 3, b: 4, tbA: 5, tbB: 7 }] })); // Bob＋Carl 赢（抢七）
  ok(await env.call('carl', 'recordEventMatch', { drawId: id, key: 't2', sets: [{ a: 2, b: 4 }] })); // 同一轮再提交：改的是同一条
  const recs = recsOf(env, id);
  assert.strictEqual(recs.length, 3, '每轮只有一条');
  const by = {};
  recs.forEach((m) => { by[m.drawKey] = m; });
  assert.deepStrictEqual(['t0', 't1', 't2'].map((k) => [by[k].a, by[k].b, by[k].aIds, by[k].bIds, by[k].winner, by[k].type]), [
    [['Alice', 'Bob'], ['Carl', 'Dora'], ['alice', 'bob'], ['carl', 'dora'], 'a', 'double'],
    [['Alice', 'Carl'], ['Bob', 'Dora'], ['alice', 'carl'], ['bob', 'dora'], 'b', 'double'],
    [['Alice', 'Dora'], ['Bob', 'Carl'], ['alice', 'dora'], ['bob', 'carl'], 'b', 'double'],
  ]);
  assert.deepStrictEqual(by.t2.sets, [{ a: 2, b: 4 }]);
  assert.ok(Object.values(env.coll('requests')).some((x) => x.type === 'edit' && x.drawKey === 't2'), '重新录分留档');
  // 进正式战绩：Bob 三轮全胜，Alice 1 胜 2 负，Carl、Dora 各 1 胜 2 负
  const S = require('../utils/stats');
  const pls = Object.values(env.coll('players')).map((x) => ({ name: x.name, uid: x._openid }));
  const st = S.playerStats(ID.normalizeMatches(recs, pls), pls, {});
  const wl = (u) => { const r = st.map[u] || {}; return [r.played, r.win]; };
  assert.deepStrictEqual([wl('bob'), wl('alice'), wl('carl'), wl('dora')], [[3, 3], [3, 1], [3, 1], [3, 1]], '每人三轮都计入；Bob 三轮全胜');
  assert.strictEqual(E.progressOf(Object.assign({ _id: id }, env.coll('draws')[id]), recs).champion, '', '不出冠军、不排总名次');
  // 管理员更正后锁定：再录要走改分申请（原来的流程）
  ok(await asAdmin(env, 'adminFixScore', { matchId: by.t0._id, sets: [{ a: 4, b: 3, tbA: 7, tbB: 4 }] }));
  no(await env.call('alice', 'recordEventMatch', { drawId: id, key: 't0', sets: [{ a: 4, b: 0 }] }), /申请修改比分/);
  assert.strictEqual(recsOf(env, id).length, 3);
});

test('退赛：发起人登记后，已打的轮次保留，没打的轮次判 TA 这一方弃权负；退赛名单写明处理方式', async () => {
  const env = setup();
  const id = await newRotation(env);
  await signAll(env, id, ['Alice', 'Bob', 'Carl', 'Dora']);
  ok(await generate(env, id, ['Alice', 'Bob', 'Carl', 'Dora']));
  ok(await env.call('alice', 'recordEventMatch', { drawId: id, key: 't0', sets: [{ a: 4, b: 2 }] }));
  ok(await env.call('dora', 'requestWithdraw', { drawId: id, reason: '临时有事' }));
  const req = Object.values(env.coll('requests')).find((x) => x.type === 'withdraw');
  const r = ok(await asAdmin(env, 'handleWithdraw', { drawId: id, requestId: req._id, approve: true, reason: '临时有事' }));
  assert.deepStrictEqual([r.stage, r.policy, r.walkovers], ['rotation', 'walkover', 2]);
  const s = schOf(env, id);
  assert.deepStrictEqual(s.map((x) => [x.key, x.done, x.outcome, x.winner]), [['t0', true, 'normal', 'a'], ['t1', true, 'walkover', 'a'], ['t2', true, 'walkover', 'b']], 'Dora 第 2 轮在 B 方、第 3 轮在 A 方：都判 Dora 这一方负');
  const WV = require('../utils/withdraw-view');
  const v = WV.withdrawView(E.publicDraw(Object.assign({ _id: id }, env.coll('draws')[id])), s, () => false);
  assert.deepStrictEqual([v.entrants[0].entrant, v.entrants[0].stage, v.entrants[0].count], ['Dora', '四人轮换', 2]);
  assert.match(v.entrants[0].policy, /没打的轮次判 TA 这一方弃权负/);
  assert.match(v.rows[0].impact, /这一轮记 Alice \/ Carl 胜（弃权）/);
  assert.deepStrictEqual(v.rows.map((x) => x.status), ['Dora 退赛，这一轮判 Bob / Dora 弃权', 'Dora 退赛，这一轮判 Alice / Dora 弃权'], '退赛的是 Dora 一个人，搭档不能写成退赛');
});

test('普通双打照旧：分组循环 2 队（4 人）可以带搭档报名，按队生成对阵、按队录分', async () => {
  const env = setup();
  const id = ok(await asAdmin(env, 'createDraw', { draw: { title: '双打内部赛', mode: 'groups', groupCount: 1, type: 'double', limit: 2 } })).id;
  ok(await env.call('alice', 'signUp', { drawId: id, partnerId: 'bob' }));
  ok(await env.call('carl', 'signUp', { drawId: id, partnerId: 'dora' }));
  const d = env.coll('draws')[id];
  assert.strictEqual(E.capacityOf(d), 4);
  ok(await asAdmin(env, 'generateDraw', { drawId: id, draw: {
    entrants: ['Alice / Bob', 'Carl / Dora'], teams: { 'Alice / Bob': ['Alice', 'Bob'], 'Carl / Dora': ['Carl', 'Dora'] },
    groups: [{ members: [{ name: 'Alice / Bob' }, { name: 'Carl / Dora' }] }], uidOf: uidMap(['Alice', 'Bob', 'Carl', 'Dora']),
  } }));
  const s = schOf(env, id);
  assert.deepStrictEqual(s.map((x) => [x.a, x.b]), [['Alice / Bob', 'Carl / Dora']]);
  ok(await env.call('bob', 'recordEventMatch', { drawId: id, key: s[0].key, sets: [{ a: 4, b: 1 }] }));
  assert.deepStrictEqual(recsOf(env, id).map((m) => [m.a, m.b, m.winner]), [[['Alice', 'Bob'], ['Carl', 'Dora'], 'a']]);
  assert.strictEqual(E.groupsFor(Object.assign({ _id: id }, env.coll('draws')[id]), recsOf(env, id))[0].table[0].name, 'Alice / Bob', '积分榜照常');
});

// 页面在沙盒里跑：require 先查 deps，其他用真实模块
function loadDef(file, deps, wx) {
  const vm = require('vm');
  const { createRequire } = require('module');
  const filename = path.resolve(__dirname, '..', file);
  let def;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (id) => deps[id] || createRequire(filename)(id), wx, console, setTimeout: () => {}, getApp: () => ({ globalData: {} }),
    Page: (x) => { def = x; }, Component: (x) => { def = x; },
  });
  return def;
}

test('活动详情：按轮次显示我这轮的搭档、对手和状态；还没录分、能录的轮次有「场边记分」，进录分页自动打开记分器，完赛后核对再提交', async () => {
  const env = setup();
  const id = await newRotation(env);
  await signAll(env, id, ['Alice', 'Bob', 'Carl', 'Dora']);
  ok(await generate(env, id, ['Alice', 'Bob', 'Carl', 'Dora']));
  ok(await env.call('carl', 'recordEventMatch', { drawId: id, key: 't0', sets: [{ a: 1, b: 4 }] })); // Carl＋Dora 赢
  const def = loadDef('pages/draw-view/draw-view.js', { '../../utils/db': { cachedPlayersFull: () => [] }, '../../utils/cloud': {}, '../../utils/pick': {}, '../../utils/share-card': {} }, {});
  const d = E.publicDraw(Object.assign({ _id: id }, env.coll('draws')[id]));
  const view = (myId, isOwner) => {
    const p = { id, d, uidOf: ID.drawUids(d, []), data: { myId, isOwner, onlyMine: false, myName: '', matches: recsOf(env, id) }, setData(o) { Object.assign(this.data, plain(o)); }, focusFixture() {} };
    def.renderSchedule.call(p);
    return p.data.rotRounds;
  };
  const bob = view('bob', false);
  assert.deepStrictEqual(bob.map((x) => [x.round, x.me, x.st, x.canScore]), [
    [1, '你和 Alice 搭档，对手 Carl、Dora', '你们输了', false],
    [2, '你和 Dora 搭档，对手 Alice、Carl', '待录分', true],
    [3, '你和 Carl 搭档，对手 Alice、Dora', '待录分', true],
  ]);
  assert.strictEqual(bob[0].score, '1:4');
  assert.deepStrictEqual(view('eve', false).map((x) => [x.me, x.st, x.canScore]), [['', '已完赛', false], ['', '待赛', false], ['', '待赛', false]], '不在这个活动的人只能看');
  assert.deepStrictEqual(view(ADMIN, true).map((x) => x.canScore), [false, true, true], '发起人可以给每一轮记分');
  const w = read('pages/draw-view/draw-view.wxml');
  assert.ok(/catchtap="openRotScorer"/.test(w) && /isRot \? '三轮对阵'/.test(w));
  assert.ok(/start=scorer/.test(read('pages/draw-view/draw-view.js')));
  const sc = read('pkg-manage/score/score.js');
  assert.ok(/options\.start === 'scorer'/.test(sc) && /this\.data\.scorerOk && !this\.pendingScorer\) this\.openScorer\(\)/.test(sc), '只给能录这一轮的人自动打开');
  assert.ok(/!isRot && myName/.test(w), '四人轮换报名不选搭档');
});

test('创建页：选「四人轮换」后固定双打、开放报名，不显示签数 / 分组 / 报名上限 / LULU 积分；按报名名单正好 4 位才能排三轮', () => {
  let stored = null;
  const def = loadDef('pkg-manage/draw-new/draw-new.js', { '../../utils/db': {}, '../utils/places': {} }, { setStorageSync: (k, v) => { stored = v; }, showToast() {}, vibrateShort() {}, pageScrollTo() {} });
  const p = Object.assign({}, def, { data: plain(def.data), setData(o) { Object.assign(this.data, plain(o)); } });
  Object.assign(p, { players: ['Alice', 'Bob', 'Carl', 'Dora', 'Eve'], selected: [], seeds: [], info: {}, date: '2026-11-23' });
  p.setData({ cupOn: true, entry: 'pick', type: 'single' });
  p.setMode({ currentTarget: { dataset: { v: 'rotation' } } });
  assert.deepStrictEqual([p.data.mode, p.data.type, p.data.entry, p.data.cupOn, p.data.limit], ['rotation', 'double', 'signup', false, 0]);
  p.setType({ currentTarget: { dataset: { v: 'single' } } });
  p.setEntry({ currentTarget: { dataset: { v: 'pick' } } });
  assert.deepStrictEqual([p.data.type, p.data.entry], ['double', 'signup']);
  assert.match(p.data.info, /每人单独报名/);
  assert.match(p.data.heroTop, /四人轮换双打 · 4 人/);
  assert.deepStrictEqual(p.settings().mode, 'rotation');
  assert.strictEqual(p.settings().cup, undefined);
  assert.ok(!stored || stored.type !== 'double', '选了四人轮换不改「上次的设置」（下次普通活动不会默认成双打）');
  p.setMode({ currentTarget: { dataset: { v: 'bracket' } } });
  assert.ok(stored && stored.type, '换回普通形式照常记住设置');
  p.setMode({ currentTarget: { dataset: { v: 'rotation' } } });
  // 截止报名后：按名单排三轮（fromSignup 时 entry = pick）
  p.setData({ fromSignup: true, entry: 'pick' });
  p.selected = ['Alice', 'Bob', 'Carl'];
  p.refresh();
  assert.deepStrictEqual([p.data.canDraw, p.data.seedChips.length, p.data.teamList.length], [false, 0, 0]);
  assert.match(p.data.info, /正好 4 位/);
  p.selected = ['Alice', 'Bob', 'Carl', 'Dora'];
  p.refresh();
  assert.strictEqual(p.data.canDraw, true);
  p.doDraw();
  assert.deepStrictEqual(p.data.preview.rotRounds, ['Alice / Bob 对 Carl / Dora', 'Alice / Carl 对 Bob / Dora', 'Alice / Dora 对 Bob / Carl']);
  assert.deepStrictEqual(p.data.preview.entrants, ['Alice', 'Bob', 'Carl', 'Dora']);
  const w = read('pkg-manage/draw-new/draw-new.wxml');
  ['参加方式', '分几组', '报名上限', '计入 LULU 积分'].forEach((label) => {
    const at = w.indexOf(`<text class="label">${label}</text>`);
    const head = w.slice(w.lastIndexOf('<view', at), at);
    assert.ok(/mode !== 'rotation'/.test(head), `${label} 在四人轮换时不显示`);
  });
});

module.exports = T;
