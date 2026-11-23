// LULU 积分：海报规则的结算（utils/cup.js）+ 云函数 cupSave / cupList 的权限、去重和更正（在内存数据库里跑真实代码）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const createEnv = require('./mock-cloud');
const C = require('../utils/cup');

const T = [];
const test = (name, fn) => T.push({ name, fn });
const ok = (r) => { assert.ok(r && r.ok, JSON.stringify(r)); return r; };
const no = (r, re) => { assert.strictEqual(r && r.ok, false, '应该被拒绝：' + JSON.stringify(r)); if (re) assert.match(r.error, re); return r; };
const read = (f) => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');

const TODAY = '2026-11-23';
const YESTERDAY = '2026-11-22'; // 「昨天那站」
const ADMIN = 'admin';
const stop = (o, places) => Object.assign({ date: YESTERDAY, kind: 'weekly', format: 'single', places: Object.assign({ champion: ['alice'], runnerUp: ['bob'], semis: [['carl'], ['dora']], floor: [['eve'], ['fay']] }, places || {}) }, o || {});
const g = { alice: 'f', fay: 'f', bob: 'm', carl: 'm', dora: 'f', eve: 'm' };
const settle = (s) => { const c = C.cleanStop(s, TODAY); assert.ok(c.ok, c.error); return C.results(c.rec, (id) => g[id] || ''); };
const byTier = (rs, tier) => rs.filter((r) => r.tier === tier);

function setup() {
  const env = createEnv();
  env.load();
  env.members([[ADMIN, '管理员'], ['alice', 'Alice'], ['bob', 'Bob'], ['carl', 'Carl'], ['dora', 'Dora'], ['eve', 'Eve'], ['fay', 'Fay'], ['gus', 'Gus'], ['hal', 'Hal']]);
  Object.keys(g).forEach((u) => { env.coll('players')['p_' + u].gender = g[u]; });
  return env;
}
// 管理员只来自环境变量 ADMIN_OPENIDS
async function asAdmin(env, action, data, uid) {
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = uid || ADMIN;
  try { return await env.call(uid || ADMIN, action, data); }
  finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
}
const save = (env, key, s, publish) => asAdmin(env, 'cupSave', { key, stop: s, publish: publish !== false });
const listOf = async (env, uid) => ok(await env.call(uid || 'gus', 'cupList', {})).list;
const totalOf = (list, year, which, key) => (C.board(list, year, which).find((r) => r.key === key) || { total: 0 }).total;

test('海报规则：周赛女子单打冠军 30 + 10 = 40，男子冠军 30；亚军 20、四强 12、参加保底 5', () => {
  const rs = settle(stop());
  const ch = byTier(rs, 'champion')[0];
  assert.deepStrictEqual([ch.base, ch.bonus, ch.total, ch.bonusText], [30, 10, 40, '女生夺冠奖励']);
  assert.strictEqual(settle(stop({}, { champion: ['bob'], runnerUp: ['alice'] })).find((r) => r.tier === 'champion').total, 30);
  assert.deepStrictEqual(byTier(rs, 'runnerUp').map((r) => r.total), [20]);
  assert.deepStrictEqual(byTier(rs, 'semi').map((r) => [r.total, r.bonus]), [[12, 0], [12, 0]], '女生只有夺冠才有奖励（四强的 Dora 没有）');
  assert.deepStrictEqual(byTier(rs, 'floor').map((r) => r.total), [5, 5], '参加保底的女生也没有奖励');
  assert.strictEqual(rs.length, 6, '每条记录只取一个名次档位');
});

test('海报规则：月赛 60 / 40 / 24、女生夺冠 +20、没有参加保底；遭遇赛 40 / 28 / 16 / 保底 6、没有女生奖励', () => {
  const m = settle(stop({ kind: 'monthly' }, { floor: [] }));
  assert.deepStrictEqual(m.map((r) => [r.tier, r.total]), [['champion', 80], ['runnerUp', 40], ['semi', 24], ['semi', 24]]);
  const bad = C.cleanStop(stop({ kind: 'monthly' }), TODAY);
  assert.ok(!bad.ok); assert.match(bad.error, /月赛没有参加保底分/);
  assert.strictEqual(C.POINTS.monthly.floor, null, '月赛不推算保底分');
  const e = settle(stop({ kind: 'encounter' }));
  assert.deepStrictEqual(e.map((r) => [r.tier, r.base, r.bonus]), [['champion', 40, 0], ['runnerUp', 28, 0], ['semi', 16, 0], ['semi', 16, 0], ['floor', 6, 0], ['floor', 6, 0]]);
});

test('双打：一队的名次分两人平分（保留小数，保底 5 分每人 2.5），不加女生奖励；搭档交换录入顺序结果一样；比赛形式只有单打、双打（海报上没有三人团队）', () => {
  const d = settle(stop({ format: 'double' }, { champion: ['alice', 'fay'], runnerUp: ['bob', 'carl'], semis: [['dora', 'eve']], floor: [['gus', 'hal']] }));
  assert.deepStrictEqual(d.map((r) => [r.tier, r.key, r.teamBase, r.base, r.bonus, r.total]), [
    ['champion', 'alice', 30, 15, 0, 15], ['champion', 'fay', 30, 15, 0, 15],
    ['runnerUp', 'bob', 20, 10, 0, 10], ['runnerUp', 'carl', 20, 10, 0, 10],
    ['semi', 'dora', 12, 6, 0, 6], ['semi', 'eve', 12, 6, 0, 6],
    ['floor', 'gus', 5, 2.5, 0, 2.5], ['floor', 'hal', 5, 2.5, 0, 2.5],
  ], '女子双打冠军也没有女生奖励；保底 5 分平分成 2.5，不取整');
  assert.deepStrictEqual(d[0].team, ['alice', 'fay']);
  assert.strictEqual(C.pointsText(d[0]), '30 ÷ 2');
  const m = settle(stop({ kind: 'monthly', format: 'double' }, { champion: ['alice', 'fay'], runnerUp: ['bob', 'carl'], semis: [['dora', 'eve']], floor: [] }));
  assert.deepStrictEqual(m.map((r) => r.total), [30, 30, 20, 20, 12, 12], '月赛双打 60 / 40 / 24 平分');
  const swapped = settle(stop({ format: 'double' }, { champion: ['fay', 'alice'], runnerUp: ['carl', 'bob'], semis: [['eve', 'dora']], floor: [['hal', 'gus']] }));
  assert.deepStrictEqual(swapped, d, '搭档顺序互换，结算结果完全一样');
  assert.strictEqual(C.teamKey(['carl', 'bob']), C.teamKey(['bob', 'carl']));
  assert.deepStrictEqual(C.FORMATS.map((x) => x.value), ['single', 'double']);
  assert.match(C.cleanStop(stop({ kind: 'encounter', format: 'team' }, { champion: ['alice', 'bob', 'carl'], runnerUp: ['dora', 'eve', 'fay'], semis: [], floor: [] }), TODAY).error, /请选择比赛形式/);
  assert.match(C.cleanStop(stop({ format: 'double' }, { champion: ['alice'] }), TODAY).error, /请选满 2 位球员/);
});

test('录入校验：只能补录已结束的日期，冠军和亚军必填，同一位球员只能出现一次，四强最多 2 个，多余字段丢掉', () => {
  assert.ok(C.cleanStop(stop({ date: TODAY }), TODAY).ok, '当天打完的也可以补录');
  assert.match(C.cleanStop(stop({ date: '2026-11-24' }), TODAY).error, /只能补录已经结束的比赛日期/);
  assert.ok(!C.cleanStop(stop({ date: '2026-02-30' }), TODAY).ok);
  assert.match(C.cleanStop(stop({}, { champion: [] }), TODAY).error, /冠军/);
  assert.match(C.cleanStop(stop({}, { runnerUp: null }), TODAY).error, /亚军/);
  assert.match(C.cleanStop(stop({}, { floor: [['alice']] }), TODAY).error, /只能出现一次/);
  assert.match(C.cleanStop(stop({}, { semis: [['carl'], ['dora'], ['gus']] }), TODAY).error, /四强最多 2 个/);
  assert.ok(!C.cleanStop(stop({ kind: 'yearly' }), TODAY).ok);
  const c = C.cleanStop(Object.assign(stop(), { note: '自由文字', bonus: 99 }), TODAY);
  assert.deepStrictEqual(Object.keys(c.rec).sort(), ['date', 'format', 'kind', 'places', 'year']);
  assert.strictEqual(c.rec.year, 2026);
});

test('昨天那站：管理员补录发布 → 成员看到、计入 2026 单打年终榜；草稿成员看不到、不进榜；积分单独存储，不写比赛记录', async () => {
  const env = setup();
  const before = JSON.stringify(env.coll('matches'));
  const d = ok(await save(env, 'stop20261122w', stop(), false));
  assert.strictEqual(d.status, 'draft');
  assert.deepStrictEqual(await listOf(env), [], '草稿成员看不到');
  assert.strictEqual((await asAdmin(env, 'cupList', {})).list.length, 1, '管理员看得到草稿');
  assert.strictEqual(C.board((await asAdmin(env, 'cupList', {})).list, 2026, 'single').length, 0, '草稿不进榜');
  const p = ok(await save(env, 'stop20261122w', stop()));
  assert.strictEqual(p.status, 'published'); assert.strictEqual(p.how, 'publish');
  const list = await listOf(env);
  assert.strictEqual(list.length, 1);
  assert.deepStrictEqual(list[0].results.find((r) => r.tier === 'champion'), { tier: 'champion', ids: ['alice'], key: 'alice', base: 30, bonus: 10, bonusText: '女生夺冠奖励', total: 40 });
  const row = C.board(list, 2026, 'single')[0];
  assert.deepStrictEqual([row.key, row.total, row.rank, row.stops], ['alice', 40, 1, 1]);
  assert.deepStrictEqual(row.sources.map((s) => [s.stopId, s.date, s.tier, s.total]), [['stop20261122w', YESTERDAY, 'champion', 40]], '每条总分能查到来源场次');
  assert.strictEqual(C.board(list, 2026, 'double').length, 0);
  assert.strictEqual(JSON.stringify(env.coll('matches')), before, '不写比赛记录（不影响战绩和水平分）');
  assert.ok(env.coll('cup_stops').stop20261122w, '存在单独的 cup_stops');
});

test('重复发布不加分：同一站再发一次什么都不变；同一天同类同形式另开一站被拒绝，要在原站更正', async () => {
  const env = setup();
  ok(await save(env, 'stopweekly01', stop()));
  const again = ok(await save(env, 'stopweekly01', stop()));
  assert.strictEqual(again.same, true);
  const swapped = ok(await save(env, 'stopweekly01', stop({}, { semis: [['dora'], ['carl']], floor: [['fay'], ['eve']] })));
  assert.strictEqual(swapped.same, true, '同一名次档位里换了录入顺序也算没变');
  no(await save(env, 'stopweekly02', stop()), /这一天已经有一站周赛 · 单打的积分，请在那一站里更正/);
  const list = await listOf(env);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(totalOf(list, 2026, 'single', 'alice'), 40);
  const logs = Object.values(env.coll('requests')).filter((x) => x.type === 'cup');
  assert.strictEqual(logs.length, 1, '没变化的重复发布不留档');
});

test('更正名次：更新原站结算，年度榜总分跟着变；记更正次数，留档带改前改后', async () => {
  const env = setup();
  ok(await save(env, 'stop20261122w', stop()));
  ok(await save(env, 'stop20261115m', stop({ date: '2026-11-15', kind: 'monthly' }, { champion: ['bob'], runnerUp: ['carl'], semis: [['alice'], ['eve']], floor: [] })));
  let list = await listOf(env);
  assert.strictEqual(totalOf(list, 2026, 'single', 'alice'), 64, '周赛冠军 40 + 月赛四强 24');
  assert.strictEqual(totalOf(list, 2026, 'single', 'bob'), 80, '周赛亚军 20 + 月赛冠军 60');
  // 昨天那站更正：冠军其实是 Bob，Alice 是亚军
  const fix = ok(await save(env, 'stop20261122w', stop({}, { champion: ['bob'], runnerUp: ['alice'] })));
  assert.strictEqual(fix.how, 'fix');
  list = await listOf(env);
  assert.strictEqual(list.length, 2, '还是两站，没有多出一站');
  assert.strictEqual(totalOf(list, 2026, 'single', 'alice'), 44, '亚军 20 + 月赛四强 24');
  assert.strictEqual(totalOf(list, 2026, 'single', 'bob'), 90, '周赛冠军 30（男生没有奖励）+ 月赛冠军 60');
  const s = list.find((x) => x.id === 'stop20261122w');
  assert.strictEqual(s.fixes, 1); assert.strictEqual(s.status, 'published');
  const log = Object.values(env.coll('requests')).filter((x) => x.type === 'cup' && x.how === 'fix');
  assert.strictEqual(log.length, 1);
  assert.deepStrictEqual(log[0].from.places.champion, ['alice']); assert.deepStrictEqual(log[0].to.places.champion, ['bob']);
  assert.strictEqual(log[0].by, ADMIN); assert.strictEqual(log[0].byAdmin, true);
  // 已发布的站再保存草稿也是更正（不会退回草稿让积分消失）
  assert.strictEqual(ok(await save(env, 'stop20261122w', stop(), false)).status, 'published');
});

test('单双打分别累计、遭遇赛不进年终榜、按实际日期归入年度；双打搭档顺序互换仍算同一队', async () => {
  const env = setup();
  ok(await save(env, 'stopsingle01', stop()));
  ok(await save(env, 'stopdouble01', stop({ format: 'double' }, { champion: ['bob', 'carl'], runnerUp: ['alice', 'fay'], semis: [], floor: [['dora', 'eve']] })));
  ok(await save(env, 'stopdouble02', stop({ date: '2026-11-08', kind: 'monthly', format: 'double' }, { champion: ['fay', 'alice'], runnerUp: ['carl', 'bob'], semis: [], floor: [] })));
  ok(await save(env, 'stopencnt001', stop({ date: '2026-11-20', kind: 'encounter' }, { floor: [] })));
  ok(await save(env, 'stopencdbl01', stop({ date: '2026-11-21', kind: 'encounter', format: 'double' }, { champion: ['alice', 'bob'], runnerUp: ['dora', 'eve'], semis: [], floor: [] })));
  ok(await save(env, 'stop2025last', stop({ date: '2025-12-30' }, { floor: [] })));
  const list = await listOf(env);
  assert.strictEqual(totalOf(list, 2026, 'single', 'alice'), 40, '单打只有周赛那一站（遭遇赛、双打、去年的都不算）');
  const dbl = C.board(list, 2026, 'double');
  assert.deepStrictEqual(dbl.map((r) => [r.key, r.total, r.rank]), [['alice', 40, 1], ['fay', 40, 1], ['bob', 35, 3], ['carl', 35, 3], ['dora', 2.5, 5], ['eve', 2.5, 5]],
    '双打按个人累计两人平分的分：周赛亚军 20 ÷ 2 + 月赛冠军 60 ÷ 2 = 40；周赛冠军 30 ÷ 2 + 月赛亚军 40 ÷ 2 = 35；保底 5 ÷ 2 = 2.5');
  assert.deepStrictEqual(dbl[0].sources.map((s) => [s.stopId, s.total, s.team.join('|')]), [['stopdouble01', 10, 'alice|fay'], ['stopdouble02', 30, 'alice|fay']], '来源场次带着这一站的搭档');
  // 换了搭档也累计到同一个人
  ok(await save(env, 'stopdouble03', stop({ date: '2026-11-01', format: 'double' }, { champion: ['alice', 'dora'], runnerUp: ['bob', 'eve'], semis: [], floor: [] })));
  assert.strictEqual(totalOf(await listOf(env), 2026, 'double', 'alice'), 55);
  const enc = C.board(list, 2026, 'encounter');
  assert.deepStrictEqual(enc.map((r) => [r.key, r.total]), [['alice', 60], ['bob', 48], ['dora', 30], ['carl', 16], ['eve', 14]],
    '遭遇赛单独统计，女生夺冠也没有奖励：单打 40 / 28 / 16 / 16 + 双打平分 20 / 20 / 14 / 14');
  assert.strictEqual(totalOf(list, 2025, 'single', 'alice'), 40, '2025-12-30 那站归入 2025 年');
  assert.deepStrictEqual(C.years(list), [2026, 2025]);
});

test('权限：普通成员不能新增、发布、更正，也不能经网关写；非成员看不到积分；只能录正式成员', async () => {
  const env = setup();
  no(await env.call('alice', 'cupSave', { key: 'stopbyalice1', stop: stop(), publish: true }), /只有管理员可以操作/);
  ok(await save(env, 'stop20261122w', stop()));
  no(await env.call('bob', 'cupSave', { key: 'stop20261122w', stop: stop({}, { champion: ['bob'], runnerUp: ['alice'] }), publish: true }), /只有管理员可以操作/);
  no(await env.call('alice', 'data', { op: 'add', coll: 'cup_stops', data: stop({ status: 'published' }) }));
  no(await env.call('alice', 'data', { op: 'update', coll: 'cup_stops', id: 'stop20261122w', data: { status: 'draft' } }));
  no(await env.call('alice', 'data', { op: 'get', coll: 'cup_stops' }));
  assert.deepStrictEqual(Object.keys(env.coll('cup_stops')), ['stop20261122w']);
  assert.deepStrictEqual((await listOf(env, 'alice'))[0].places.champion, ['alice'], '没被改动');
  const outsider = await env.call('stranger', 'cupList', {});
  assert.strictEqual(outsider.ok, false); assert.strictEqual(outsider.code, 'NOT_MEMBER');
  // 名次里只能是正式成员（被移除的、没加入的都不行）
  env.coll('members').hal.status = 'removed';
  no(await save(env, 'stopmonthly1', stop({ kind: 'monthly' }, { champion: ['hal'], floor: [] })), /Hal不是正式成员/);
  no(await save(env, 'stopmonthly1', stop({ kind: 'monthly' }, { champion: ['nobody'], floor: [] })), /不是正式成员/);
  no(await save(env, 'bad', stop()), /编号/);
  no(await save(env, 'stopfuture01', stop({ date: '2099-01-01' })), /只能补录已经结束的比赛日期/);
});

test('撤下一站：只有管理员、原因只能从固定选项选；撤下后成员看不到、年度榜去掉这一站的分，记录保留并留档；撤下后可以重新补录', async () => {
  const env = setup();
  ok(await save(env, 'stop20261122w', stop()));
  ok(await save(env, 'stop20261115m', stop({ date: '2026-11-15', kind: 'monthly' }, { champion: ['bob'], runnerUp: ['carl'], semis: [['alice'], ['eve']], floor: [] })));
  assert.strictEqual(totalOf(await listOf(env), 2026, 'single', 'alice'), 64);
  no(await env.call('alice', 'cupRemove', { id: 'stop20261122w', reason: '录错了这一站' }), /只有管理员可以操作/);
  no(await asAdmin(env, 'cupRemove', { id: 'stop20261122w' }), /请选择原因/);
  no(await asAdmin(env, 'cupRemove', { id: 'stop20261122w', reason: '我自己写的原因' }), /固定选项/);
  no(await asAdmin(env, 'cupRemove', { id: 'stop20261122w', reason: '活动取消' }), /固定选项/, '别的原因组的选项也不行');
  no(await asAdmin(env, 'cupRemove', { id: 'nosuchstop01', reason: '录错了这一站' }), /没找到这一站/);
  const r = ok(await asAdmin(env, 'cupRemove', { id: 'stop20261122w', reason: '录错了这一站' }));
  assert.strictEqual(r.removed, true);
  let list = await listOf(env);
  assert.deepStrictEqual(list.map((s) => s.id), ['stop20261115m'], '成员看不到撤下的站');
  assert.deepStrictEqual((await asAdmin(env, 'cupList', {})).list.map((s) => s.id), ['stop20261115m'], '管理员列表里也没有了');
  assert.strictEqual(totalOf(list, 2026, 'single', 'alice'), 24, '年度榜去掉这一站的 40 分');
  const doc = env.coll('cup_stops').stop20261122w;
  assert.ok(doc && doc.deleted === true && doc.deleteReason === '录错了这一站' && doc.deletedBy === ADMIN, '软删除，记录保留');
  assert.strictEqual(ok(await asAdmin(env, 'cupRemove', { id: 'stop20261122w', reason: '重复录入' })).same, true, '重复撤下不重复留档');
  const logs = Object.values(env.coll('requests')).filter((x) => x.type === 'cup' && x.how === 'remove');
  assert.strictEqual(logs.length, 1);
  assert.deepStrictEqual([logs[0].by, logs[0].reason, logs[0].wasStatus, logs[0].from.places.champion[0]], [ADMIN, '录错了这一站', 'published', 'alice']);
  no(await save(env, 'stop20261122w', stop()), /已经撤下/, '撤下的站不能再保存回来');
  ok(await save(env, 'stop20261122b', stop({}, { champion: ['bob'], runnerUp: ['alice'] })), '撤下后同一天同类同形式可以重新补录');
  list = await listOf(env);
  assert.strictEqual(totalOf(list, 2026, 'single', 'bob'), 90);
  // 草稿也能删
  ok(await save(env, 'stopdraft001', stop({ format: 'double' }, { champion: ['alice', 'bob'], runnerUp: ['carl', 'dora'], semis: [], floor: [] }), false));
  ok(await asAdmin(env, 'cupRemove', { id: 'stopdraft001', reason: '比赛没有打' }));
  assert.ok(!(await asAdmin(env, 'cupList', {})).list.some((s) => s.id === 'stopdraft001'));
});

test('代码审查修复：读取出错不会把已有的站整条覆盖；数据库返回的字段顺序变了，原样重发仍算没变化', async () => {
  const env = setup();
  ok(await save(env, 'stop20261122w', stop()));
  ok(await save(env, 'stop20261122w', stop({}, { champion: ['bob'], runnerUp: ['alice'] })));
  assert.strictEqual(env.coll('cup_stops').stop20261122w.fixes, 1);
  // 读取这一站时出错（getDoc 返回 null）：不能按新建处理把它覆盖掉
  env.beforeDocGet = async (coll) => { if (coll === 'cup_stops') throw new Error('timeout'); };
  no(await save(env, 'stop20261122w', stop({}, { champion: ['gus'], runnerUp: ['bob'] })), /刷新后再试/);
  env.beforeDocGet = null;
  const d = env.coll('cup_stops').stop20261122w;
  assert.deepStrictEqual([d.fixes, d.places.champion[0], d.status], [1, 'bob', 'published'], '原来的站没被动过');
  // 字段顺序被打乱（数据库返回的顺序不保证）：内容一样，重发仍是 same
  const pl = d.places;
  d.places = { floor: pl.floor, semis: pl.semis, runnerUp: pl.runnerUp, champion: pl.champion };
  d.results = d.results.map((r) => { const o = {}; Object.keys(r).reverse().forEach((k) => { o[k] = r[k]; }); return o; });
  assert.strictEqual(ok(await save(env, 'stop20261122w', stop({}, { champion: ['bob'], runnerUp: ['alice'] }))).same, true);
  assert.strictEqual(env.coll('cup_stops').stop20261122w.fixes, 1, '没有多算一次更正');
});

test('代码审查修复：积分组件连续刷新只认最后一次的结果；点来源场次在组件里查位置再滚动；积分页下拉刷新等积分读完才停', async () => {
  const resolvers = [];
  const scrolls = [];
  const def = loadDef('components/cup-board/cup-board.js', {
    '../../utils/cloud': { cached: () => new Promise((r) => resolvers.push(r)) },
    '../../utils/db': { playersShared: async () => [], profilesOf: () => ({}), myOpenid: async () => 'me' },
    '../../utils/member': { isAdminLocal: () => false },
  }, { pageScrollTo: (o) => scrolls.push(o) });
  const events = [];
  const c = Object.assign({}, def.methods, {
    data: plain(def.data), setData(o, cb) { Object.assign(this.data, o); if (cb) cb(); }, triggerEvent: (n) => events.push(n),
    createSelectorQuery: () => { const q = { select: () => ({ boundingClientRect: () => q }), selectViewport: () => ({ scrollOffset: () => q }), exec: (cb) => cb([{ top: 500 }, { scrollTop: 100 }]) }; return q; },
  });
  const mk = (date) => ({ list: [{ id: 's-' + date, date, year: 2026, kind: 'weekly', format: 'single', status: 'published', places: {}, results: [{ tier: 'champion', ids: ['me'], key: 'me', base: 30, bonus: 0, total: 30 }] }] });
  const first = c.load(), second = c.load();
  await new Promise((r) => setImmediate(r));
  resolvers[1](mk('2026-11-22')); await second; // 新的先回来
  resolvers[0](mk('2026-11-15')); await first;  // 旧的晚回来：不能覆盖
  assert.strictEqual(c.data.stops[0].date, '2026-11-22');
  assert.deepStrictEqual(events, ['loaded'], '只有最后一次读完才通知');
  c.goStop({ currentTarget: { dataset: { id: 's-2026-11-22' } } });
  assert.strictEqual(c.data.openStop, 's-2026-11-22');
  assert.deepStrictEqual(scrolls.map((x) => x.scrollTop), [576], '滚到这一站（页面已滚 100 + 元素位置 500 - 24）');
  assert.ok(!scrolls[0].selector, '不用页面级 selector');
  const rank = read('pages/rank/rank.js');
  assert.ok(/view === 'cup'\) \{ this\.cupPulling = true;[^\n]*return; \}/.test(rank) && /onCupLoaded\(\) \{ if \(this\.cupPulling\)/.test(rank));
  assert.ok(/bind:loaded="onCupLoaded"/.test(read('pages/rank/rank.wxml')));
});

test('界面：排行页顶部「水平排行 / LULU 积分」；补录页只给管理员；积分组件只读 cupList；cupList 是只读操作', () => {
  const rank = read('pages/rank/rank.wxml');
  assert.ok(/data-v="cup" bindtap="setView">LULU 积分/.test(rank));
  assert.ok(/<cup-board wx:if="\{\{view === 'cup'\}\}"/.test(rank));
  assert.ok(JSON.parse(read('app.json')).pages.indexOf('pages/cup-edit/cup-edit') >= 0);
  assert.ok(/ms\.status !== 'active' \|\| !ms\.isAdmin/.test(read('pages/cup-edit/cup-edit.js')));
  assert.ok(/cupList: 1/.test(read('utils/cloud.js')));
  const board = read('components/cup-board/cup-board.js');
  assert.ok(/cloud\.cached\('cupList'\)/.test(board) && !/cupSave/.test(board), '积分组件只读');
  assert.ok(/shown === true/.test(board), '榜单只显示同意公开展示的球员');
  assert.ok(/cupSave: 1, cupRemove: 1/.test(read('cloudfunctions/tennis/index.js')), 'cupSave、cupRemove 在 ADMIN_ONLY 里');
  const edit = read('pages/cup-edit/cup-edit.wxml'), ejs = read('pages/cup-edit/cup-edit.js');
  assert.ok(/class="btn-danger[^"]*"[^>]*bindtap="removeStop">\{\{published \? '撤下这一站' : '删除这份草稿'\}\}/.test(edit), '撤下按钮用 .btn-danger，只在已有的站上出现');
  assert.ok(/wx:if="\{\{editing\}\}" class="btn-danger/.test(edit));
  assert.ok(/pick\.reason\('cup'/.test(ejs), '原因从固定选项里选');
  assert.ok(!/cup_stops/.test(read('cloudfunctions/tennis/index.js').match(/const GW_(READ|WRITE) = \{[^}]*\}/g).join('')), '不在网关白名单里');
});

// 页面 / 组件在 vm 里跑（假的 wx、云函数）：补录页的预览、提交参数，积分组件的年度榜和公开展示过滤
function loadDef(file, deps, wx) {
  const vm = require('vm');
  const { createRequire } = require('module');
  const filename = path.resolve(__dirname, '..', file);
  let def;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (id) => deps[id] || createRequire(filename)(id), wx, console, setTimeout: () => {},
    Page: (d) => { def = d; }, Component: (d) => { def = d; },
  });
  return def;
}
const plain = (v) => JSON.parse(JSON.stringify(v));

test('补录页：只从正式成员里选，预览每条记录的基础分、奖励分、合计；换形式清空名次；发布带着同一个编号', async () => {
  const calls = [];
  const wx = { hideShareMenu() {}, setNavigationBarTitle() {}, showToast() {}, navigateBack() {}, showModal: (o) => o.success({ confirm: true }) };
  const people = [{ uid: 'alice', nickname: 'Alice', gender: 'f' }, { uid: 'bob', nickname: 'Bob', gender: 'm' }, { uid: 'carl', nickname: 'Carl', gender: 'm' }, { uid: 'x', nickname: '' }];
  const def = loadDef('pages/cup-edit/cup-edit.js', {
    '../../utils/member': { status: async () => ({ status: 'active', isAdmin: true }) },
    '../../utils/cloud': { call: async (action, data) => { calls.push([action, data]); return action === 'listMembers' ? { active: people } : { status: 'published', how: 'publish' }; } },
  }, wx);
  const p = Object.assign({}, def, { data: plain(def.data), setData(o) { Object.assign(this.data, o); } });
  await p.onLoad({});
  assert.strictEqual(p.data.ok, true);
  assert.deepStrictEqual(p.data.opts, ['Alice · 女', 'Bob · 男', 'Carl · 男'], '没设置资料的不能选');
  const pick = (slot, i, j, v) => p.pick({ currentTarget: { dataset: { slot, i, j } }, detail: { value: v } });
  pick('champion', 0, 0, 0); pick('runnerUp', 0, 0, 1);
  assert.deepStrictEqual(p.data.preview.lines.map((l) => [l.tier, l.names, l.base, l.bonus, l.total]), [['冠军', 'Alice', 30, 10, 40], ['亚军', 'Bob', 20, 0, 20]]);
  pick('semis', 0, 0, 2);
  assert.strictEqual(p.data.preview.lines.length, 3, '四强可以少于 2 个');
  p.setKind({ currentTarget: { dataset: { v: 'monthly' } } });
  assert.strictEqual(p.data.hasFloor, false);
  assert.deepStrictEqual(p.data.formats.map((f) => f.value), ['single', 'double'], '只有单打、双打');
  p.setFormat({ currentTarget: { dataset: { v: 'double' } } });
  assert.match(p.data.preview.error, /冠军/, '换成双打：每队人数变了，名次清空');
  pick('champion', 0, 0, 0); pick('champion', 0, 1, 1);
  assert.match(p.data.preview.error, /亚军/);
  p.setKind({ currentTarget: { dataset: { v: 'weekly' } } });
  pick('champion', 0, 0, 0); pick('champion', 0, 1, 1); pick('runnerUp', 0, 0, 2);
  assert.match(p.data.preview.error, /亚军：请选满 2 位球员/, '半队不能发布');
  p.places.runnerUp = ['carl', 'x2']; p.byUid.x2 = { uid: 'x2', name: 'Xia', gender: 'f' }; p.render();
  assert.deepStrictEqual(p.data.preview.lines.map((l) => [l.names, l.base, l.bonus, l.total]), [
    ['Alice（和 Bob）', '30 ÷ 2', 0, 15], ['Bob（和 Alice）', '30 ÷ 2', 0, 15], ['Carl（和 Xia）', '20 ÷ 2', 0, 10], ['Xia（和 Carl）', '20 ÷ 2', 0, 10],
  ], '双打预览：每人一行，两人平分，女生不加分');
  assert.match(p.data.pointsNote, /双打两人平分/);
  p.setKind({ currentTarget: { dataset: { v: 'monthly' } } });
  p.setFormat({ currentTarget: { dataset: { v: 'single' } } });
  pick('champion', 0, 0, 0); pick('runnerUp', 0, 0, 1);
  p.publish();
  await new Promise((r) => setImmediate(r));
  const sent = calls.find((c) => c[0] === 'cupSave');
  assert.ok(sent, '发布走云函数 cupSave');
  assert.deepStrictEqual(plain(sent[1].stop.places), { champion: ['alice'], runnerUp: ['bob'], semis: [], floor: [] });
  assert.strictEqual(sent[1].stop.kind, 'monthly'); assert.strictEqual(sent[1].publish, true);
  const key = sent[1].key;
  p.publish();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls.filter((c) => c[0] === 'cupSave').pop()[1].key, key, '再点一次发布还是同一站');
  // 不是管理员：直接打开也不能用
  const def2 = loadDef('pages/cup-edit/cup-edit.js', { '../../utils/member': { status: async () => ({ status: 'active', isAdmin: false }) }, '../../utils/cloud': { call: async () => ({}) } }, wx);
  const q = Object.assign({}, def2, { data: plain(def2.data), setData(o) { Object.assign(this.data, o); } });
  await q.onLoad({});
  assert.strictEqual(q.data.ok, false); assert.strictEqual(q.data.authError, '只有管理员可以补录积分');
});

test('补录页撤下：已发布的站「撤下这一站」、草稿「删除这份草稿」；先选固定原因再确认，取消任何一步都不调用云函数', async () => {
  const calls = [];
  let answer = '录错了这一站', confirm = true;
  const wx = { hideShareMenu() {}, setNavigationBarTitle() {}, showToast() {}, navigateBack() {}, showModal: (o) => o.success && o.success({ confirm }) };
  const published = { id: 'stop20261122w', date: YESTERDAY, year: 2026, kind: 'weekly', format: 'single', status: 'published', fixes: 0, places: { champion: ['alice'], runnerUp: ['bob'], semis: [], floor: [] }, results: [] };
  const def = loadDef('pages/cup-edit/cup-edit.js', {
    '../../utils/member': { status: async () => ({ status: 'active', isAdmin: true }) },
    '../../utils/pick': { reason: async (kind) => { calls.push(['pick', kind]); return answer; } },
    '../../utils/cloud': { call: async (action, data) => { calls.push([action, data]); return action === 'listMembers' ? { active: [{ uid: 'alice', nickname: 'Alice' }, { uid: 'bob', nickname: 'Bob' }] } : action === 'cupList' ? { list: [published] } : { removed: true }; } },
  }, wx);
  const p = Object.assign({}, def, { data: plain(def.data), setData(o) { Object.assign(this.data, o); } });
  await p.onLoad({ id: 'stop20261122w' });
  assert.strictEqual(p.data.editing, true); assert.strictEqual(p.data.published, true);
  const flush = () => new Promise((r) => setImmediate(r));
  answer = null; await p.removeStop(); await flush();
  assert.ok(!calls.some((c) => c[0] === 'cupRemove'), '没选原因不撤下');
  answer = '录错了这一站'; confirm = false; await p.removeStop(); await flush();
  assert.ok(!calls.some((c) => c[0] === 'cupRemove'), '确认框点取消不撤下');
  confirm = true; await p.removeStop(); await flush();
  assert.deepStrictEqual(plain(calls.filter((c) => c[0] === 'cupRemove').map((c) => c[1])), [{ id: 'stop20261122w', reason: '录错了这一站' }]);
  assert.ok(calls.every((c) => c[0] !== 'pick' || c[1] === 'cup'), '原因用 cup 这一组');
  // 新建的还没保存过：不能撤下
  const q = Object.assign({}, def, { data: plain(def.data), setData(o) { Object.assign(this.data, o); } });
  await q.onLoad({});
  const before = calls.length;
  await q.removeStop();
  assert.strictEqual(calls.length, before);
});

test('公开展示授权：普通成员的 cupList 里没同意的人换成匿名编号（自己除外、管理员不换）；年度榜、各站明细、双打搭档统一显示「球友」，名次照常', async () => {
  const env = setup();
  ok(await save(env, 'stop20261122w', stop()));
  ok(await save(env, 'stopdouble01', stop({ format: 'double' }, { champion: ['bob', 'carl'], runnerUp: ['alice', 'fay'], semis: [], floor: [] })));
  env.coll('players').p_alice.shown = false; // Alice 没同意公开展示
  // 接口：别的成员拿不到 Alice 的用户 ID；同一个人在一次返回里编号一致（分照样累计）
  const forBob = await listOf(env, 'bob');
  assert.ok(!JSON.stringify(forBob).includes('"alice"'), '普通成员拿不到没授权的人的用户 ID');
  const single = forBob.find((x) => x.id === 'stop20261122w'), dbl = forBob.find((x) => x.id === 'stopdouble01');
  const token = single.places.champion[0];
  assert.match(token, /^x[0-9a-f]{16}$/);
  assert.strictEqual(single.results[0].key, token);
  assert.ok(dbl.results.some((r) => r.key === token) && dbl.places.runnerUp.indexOf(token) >= 0, '同一次返回里两站的编号一致');
  assert.notStrictEqual((await listOf(env, 'bob'))[0].places.champion[0], token, '每次调用换一个编号，没法拿来对人');
  assert.strictEqual(C.board(forBob, 2026, 'single')[0].total, 40, '名次和分数不变');
  assert.deepStrictEqual((await listOf(env, 'alice')).find((x) => x.id === 'stop20261122w').places.champion, ['alice'], '自己看自己照常');
  assert.deepStrictEqual((await asAdmin(env, 'cupList', {})).list.find((x) => x.id === 'stop20261122w').places.champion, ['alice'], '管理员核对、更正要用真实 ID');

  const prof = {};
  Object.values(env.coll('players')).forEach((x) => { prof[x._openid] = { name: x.name, gender: x.gender || '', shown: x.shown === true }; });
  const board = async (me, list) => {
    const def = loadDef('components/cup-board/cup-board.js', {
      '../../utils/cloud': { cached: async () => ({ list, admin: false }) },
      '../../utils/db': { playersShared: async () => [], profilesOf: () => prof, myOpenid: async () => me },
      '../../utils/member': { isAdminLocal: () => false },
    }, { pageScrollTo() {}, navigateTo() {} });
    const c = Object.assign({}, def.methods, { data: plain(def.data), setData(o) { Object.assign(this.data, o); } });
    await c.load();
    return c;
  };
  const row = (r) => [r.rank, r.people.map((x) => x.name).join(' / '), r.total];
  const c = await board('bob', forBob);
  assert.deepStrictEqual(c.data.rows.map(row), [[1, '球友', 40], [2, 'Bob', 20], [3, 'Carl', 12], [3, 'Dora', 12], [5, 'Eve', 5], [5, 'Fay', 5]], '年度榜：没授权的显示「球友」，不从榜上去掉');
  assert.deepStrictEqual(plain(c.data.rows[0].people[0]), { key: token, uid: '', name: '球友', gender: '' }, '不带用户 ID（不显示照片）、不显示性别');
  assert.strictEqual(c.data.meHidden, false);
  assert.deepStrictEqual(c.data.stops[0].lines.map((l) => l.names), ['球友', 'Bob', 'Carl', 'Dora', 'Eve', 'Fay'], '各站明细');
  assert.strictEqual(c.data.stops[0].lines[0].points, '30 + 10');
  c.setWhich({ currentTarget: { dataset: { v: 'double' } } });
  assert.deepStrictEqual(c.data.rows.map(row), [[1, 'Bob', 15], [1, 'Carl', 15], [3, 'Fay', 10], [3, '球友', 10]]);
  assert.strictEqual(c.data.rows[2].sources[0].partner, '球友', '搭档明细也显示「球友」');
  assert.deepStrictEqual(c.data.stops[0].lines.map((l) => l.names), ['Bob（和 Carl 一队）', 'Carl（和 Bob 一队）', '球友（和 Fay 一队）', 'Fay（和 球友 一队）']);
  c.setWhich({ currentTarget: { dataset: { v: 'single' } } });
  c.toggleRow({ currentTarget: { dataset: { key: 'bob' } } });
  assert.strictEqual(c.data.open, 'bob');
  assert.deepStrictEqual(plain(c.data.rows[1].sources.map((s) => [s.stopId, s.kind, s.tier, s.total])), [['stop20261122w', '周赛', '亚军', 20]]);
  // 管理员的列表是真实 ID，组件照样按资料显示「球友」
  const ca = await board('carl', (await asAdmin(env, 'cupList', {})).list);
  assert.strictEqual(ca.data.rows[0].people[0].name, '球友');
  // 自己没开：自己看自己照常，有提示
  const me = await board('alice', await listOf(env, 'alice'));
  assert.strictEqual(me.data.rows[0].people[0].name, 'Alice');
  assert.strictEqual(me.data.meHidden, true);
  assert.strictEqual(me.data.rows[0].mine, true);
});

test('授权说明：写明 LULU 积分榜和各站积分明细，没同意时显示「球友」', () => {
  const text = require('../utils/consent').TEXT;
  assert.ok(/LULU 积分榜和各站积分明细/.test(text.split('\n')[0]), '同意的展示位置里有积分榜和各站明细');
  assert.ok(/LULU 积分榜和各站积分明细（含双打搭档）里你的名字显示为「球友」/.test(text));
  const pf = read('pages/profile/profile.wxml');
  assert.ok(/展示在排行榜、LULU 积分、/.test(pf) && /LULU 积分里显示为「球友」/.test(pf) && /仍显示昵称/.test(pf), '资料页的勾选说明（精简成两行）同步');
});

module.exports = T;
