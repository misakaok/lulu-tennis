// LULU 积分：海报规则的结算（utils/cup.js）+ 云函数 cupSave / cupList 的权限、去重和更正（在内存数据库里跑真实代码）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const createEnv = require('./mock-cloud');
const C = require('../utils/cup');

const T = [];
const test = (name, fn) => T.push({ name, fn });
// 页面里 cloud.cached / fresh / peek（内存缓存）在测试里都直接走 call
const viaCall = (c) => Object.assign(c, { cached: (a, d) => c.call(a, d), fresh: (a, d) => c.call(a, d), peek: () => undefined });
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

test('新周赛、月赛：10／8／6／4；女子单打冠军按组别拿 10、15 或 20 分，双打仍平分', () => {
  for (const kind of ['weekly', 'monthly']) {
    for (const [pointGroup, champion] of [['open', 10], ['3.0', 15], ['3.5', 20]]) {
      const rs = settle(stop({ kind, pointGroup }));
      assert.deepStrictEqual(rs.map((r) => r.total), [champion, 8, 6, 6, 4, 4]);
    }
    assert.strictEqual(settle(stop({ kind, pointGroup: '3.5' }, { champion: ['bob'], runnerUp: ['alice'] }))[0].total, 10);
  }
  const doubles = settle(stop({ format: 'double', pointGroup: '3.5' }, { champion: ['alice', 'fay'], runnerUp: ['bob', 'carl'], semis: [['dora', 'eve']], floor: [['gus', 'hal']] }));
  assert.deepStrictEqual(doubles.map((r) => r.total), [5, 5, 4, 4, 3, 3, 2, 2]);
  assert.match(C.cleanStop(stop({ pointGroup: '4.5' }), TODAY).error, /积分组别不正确/);
});

test('历史规则按组别结算，同天可以有不同组；发布后更正沿用原组别和记分规则', async () => {
  const env = setup();
  const first = ok(await save(env, 'group301', stop({ pointGroup: '3.0' })));
  const second = ok(await save(env, 'group351', stop({ pointGroup: '3.5' })));
  assert.deepStrictEqual([first.stop.results[0].total, second.stop.results[0].total], [15, 20]);
  no(await save(env, 'group352', stop({ pointGroup: '3.5' })), /已经有一站/);
  const old = ok(await save(env, 'oldRound1', stop({ date: '2026-11-21' })));
  assert.strictEqual(old.stop.results[0].total, 40);
  const fixed = ok(await save(env, 'group351', stop({ pointGroup: '3.0' }, { semis: [['carl']] })));
  assert.strictEqual(fixed.stop.pointGroup, '3.5');
  assert.strictEqual(fixed.stop.results[0].total, 20);
  assert.strictEqual(totalOf(await listOf(env), 2026, 'single', 'alice'), 40, '年终只取最高组');
});

test('现行规则：3.5 组女子前三个名次档加分，各种活动加分给到每位参赛者', () => {
  const places = { runnerUp: ['fay'], semis: [['dora'], ['carl']], floor: [['eve']] };
  for (const [kind, extra] of [['weekly', 0], ['monthly', 0], ['quarterly', 2], ['halfYear', 5], ['yearFinal', 10]]) {
    const rs = settle(stop({ kind, pointGroup: '3.5', scoreVersion: C.SCORE_VERSION }, places));
    assert.deepStrictEqual(rs.map((r) => r.total), [15 + extra, 11 + extra, 6 + extra, 7 + extra, 2 + extra]);
  }
  for (const pointGroup of ['3.0', 'open']) {
    const rs = settle(stop({ kind: 'weekly', pointGroup, scoreVersion: C.SCORE_VERSION }, places));
    assert.deepStrictEqual(rs.map((r) => r.total), [10, 8, 6, 6, 2]);
  }
  const d = settle(stop({ kind: 'halfYear', format: 'double', pointGroup: '3.5', scoreVersion: C.SCORE_VERSION }, {
    champion: ['alice', 'fay'], runnerUp: ['bob', 'carl'], semis: [], floor: [['dora', 'eve']],
  }));
  assert.deepStrictEqual(d.map((r) => r.total), [10, 10, 9, 9, 6, 6]);
  assert.strictEqual(C.pointsText(d[0]), '10 ÷ 2 + 5');
});

test('年终单打、双打各取最高组；各组明细仍可查询，撤下一站后重选最高组', async () => {
  const env = setup();
  const rs = (kind, pointGroup, more) => stop(Object.assign({ kind, pointGroup, scoreVersion: C.SCORE_VERSION }, more || {}));
  ok(await save(env, 'cupNew351', rs('quarterly', '3.5')));
  ok(await save(env, 'cupNew301', rs('weekly', '3.0')));
  ok(await save(env, 'cupNew302', rs('monthly', '3.0')));
  ok(await save(env, 'cupNew352', stop({ kind: 'yearFinal', pointGroup: '3.5', scoreVersion: C.SCORE_VERSION, format: 'double' }, {
    champion: ['alice', 'fay'], runnerUp: ['bob', 'carl'], floor: [], semis: [],
  })));
  const row = C.mine(await listOf(env, 'alice'), 'alice', 2026).single;
  assert.deepStrictEqual([row.pointGroup, row.total], ['3.0', 20]);
  assert.deepStrictEqual(row.groups.map((g) => [g.pointGroup, g.total]), [['3.0', 20], ['3.5', 17]]);
  assert.deepStrictEqual(row.sources.map((s) => s.stopId).sort(), ['cupNew301', 'cupNew302']);
  const double = C.mine(await listOf(env, 'alice'), 'alice', 2026).double;
  assert.deepStrictEqual([double.pointGroup, double.total], ['3.5', 15]);
  ok(await asAdmin(env, 'cupRemove', { id: 'cupNew302', reason: '录错了这一站' }));
  const updated = C.mine(await listOf(env, 'alice'), 'alice', 2026).single;
  assert.deepStrictEqual([updated.pointGroup, updated.total], ['3.5', 17]);
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

test('更正已发布的站：原来就有的人后来被移出成员、资料也没了，照样保留（性别奖励不变），能更正其他名次；新加进来的仍须是正式成员', async () => {
  const env = setup();
  ok(await save(env, 'stop20261122w', stop()));
  const before = (await listOf(env)).find((x) => x.id === 'stop20261122w');
  const aliceBefore = before.results.find((r) => r.key === 'alice');
  assert.strictEqual(aliceBefore.total, 40, '女生夺冠 30 + 10');
  // Alice 被移出成员、资料删掉；Eve 被移出但资料还在
  env.coll('members').alice.status = 'removed';
  delete env.coll('players').p_alice;
  env.coll('members').eve.status = 'removed';
  // 更正：亚军 / 四强对调，Alice、Eve 原地保留
  const fix = ok(await save(env, 'stop20261122w', stop({}, { runnerUp: ['carl'], semis: [['bob'], ['dora']] })));
  assert.strictEqual(fix.how, 'fix');
  const st = env.coll('cup_stops').stop20261122w;
  assert.deepStrictEqual(st.places.champion, ['alice']);
  assert.strictEqual(st.results.find((r) => r.key === 'alice').total, 40, '没有资料也按原来的结算认女生，奖励不变');
  assert.strictEqual(st.results.find((r) => r.key === 'carl').tier, 'runnerUp');
  assert.ok(st.results.some((r) => r.key === 'eve'));
  // 把一位已移出、原来不在这一站的人加进来：拒绝
  env.coll('members').gus.status = 'removed';
  no(await save(env, 'stop20261122w', stop({}, { runnerUp: ['carl'], semis: [['bob'], ['dora']], floor: [['eve'], ['gus']] })), /不是正式成员/);
  // 草稿不算「原来就有」：草稿里有已移出的人，保存 / 发布都拒绝
  ok(await save(env, 'stop20261101w', stop({ date: '2026-11-01' }, { champion: ['hal'], runnerUp: ['bob'], floor: [] }), false));
  env.coll('members').hal.status = 'removed';
  no(await save(env, 'stop20261101w', stop({ date: '2026-11-01' }, { champion: ['hal'], runnerUp: ['fay'], floor: [] }), true), /不是正式成员/);
});
test('手动补录的站：读到之后、写入之前被另一位管理员改了，后提交的拒绝，不整条覆盖', async () => {
  const env = setup();
  ok(await save(env, 'stop20261122w', stop()));
  let reads = 0;
  env.beforeDocGet = (c, id) => {
    if (c !== 'cup_stops' || id !== 'stop20261122w') return;
    if (++reads === 2) { // cupSave 先读一次（getDoc），事务里再读一次：中间另一位管理员把亚军改成了 Carl
      const d = env.coll('cup_stops').stop20261122w;
      d.places.runnerUp = ['carl']; d.fixes = 1;
    }
  };
  no(await save(env, 'stop20261122w', stop({}, { champion: ['bob'], runnerUp: ['alice'] })), /另一位管理员/);
  env.beforeDocGet = null;
  // （内存数据库的事务失败会整体回滚，连同上面模拟的「另一位管理员」的改动；这里只核对这次提交没有写进去）
  assert.deepStrictEqual(env.coll('cup_stops').stop20261122w.places.champion, ['alice'], '没有把这次的名次写进去');
  assert.ok(!Object.values(env.coll('requests')).some((x) => x.type === 'cup' && x.how === 'fix'), '没写入就不留档');
  // 草稿同样核对
  ok(await save(env, 'stop20261101w', stop({ date: '2026-11-01' }), false));
  reads = 0;
  env.beforeDocGet = (c, id) => { if (c === 'cup_stops' && id === 'stop20261101w' && ++reads === 2) env.coll('cup_stops').stop20261101w.places.champion = ['carl']; };
  no(await save(env, 'stop20261101w', stop({ date: '2026-11-01' }, { champion: ['bob'], runnerUp: ['alice'] }), false), /另一位管理员/);
  env.beforeDocGet = null;
  ok(await save(env, 'stop20261101w', stop({ date: '2026-11-01' }, { champion: ['bob'], runnerUp: ['alice'] }), false));
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
    '../../utils/cloud': viaCall({ call: async (action, data) => { calls.push([action, data]); return action === 'listMembers' ? { active: people } : { status: 'published', how: 'publish' }; } }),
  }, wx);
  const p = Object.assign({}, def, { data: plain(def.data), setData(o) { Object.assign(this.data, o); } });
  await p.onLoad({});
  assert.strictEqual(p.data.ok, true);
  const uids = ['alice', 'bob', 'carl'];
  const open = (slot, i, j) => p.openPick({ currentTarget: { dataset: { slot, i, j } } });
  const tap = (uid) => p.tapPick({ detail: { uid } }); // member-sheet 的 pick 事件
  const pick = (slot, i, j, v) => { open(slot, i, j); tap(uids[v]); };
  open('champion', 0, 0);
  assert.deepStrictEqual(p.data.sheet.list.map((x) => x.name + ' · ' + x.g), ['Alice · 女', 'Bob · 男', 'Carl · 男'], '没设置资料的不能选');
  // 弹层组件：搜索只在本机按名字筛（不分大小写），清空恢复全部；点名字发 pick
  const sheetDef = loadDef('components/member-sheet/member-sheet.js', {}, wx);
  const events = [];
  const sh = Object.assign({}, sheetDef.methods, { data: Object.assign(plain(sheetDef.data), { list: p.data.sheet.list }), setData(o) { Object.assign(this.data, o); }, triggerEvent: (n, d) => events.push([n, d]) });
  sheetDef.lifetimes.attached.call(sh);
  assert.strictEqual(sh.data.shown.length, 3);
  sh.onQ({ detail: { value: 'B' } });
  assert.deepStrictEqual(sh.data.shown.map((x) => x.uid), ['bob'], '搜索只在本机按名字筛');
  sh.onQ({ detail: { value: '' } });
  assert.strictEqual(sh.data.shown.length, 3);
  sh.tap({ currentTarget: { dataset: { uid: 'carl' } } });
  assert.deepStrictEqual(plain(events), [['pick', { uid: 'carl' }]]);
  p.closePick();
  assert.strictEqual(p.data.sheet, null);
  pick('champion', 0, 0, 0); pick('runnerUp', 0, 0, 1);
  assert.deepStrictEqual(p.data.preview.lines.map((l) => [l.tier, l.names, l.base, l.bonus, l.total]), [['冠军', 'Alice', 10, 0, 10], ['亚军', 'Bob', 8, 0, 8]]);
  p.setPointGroup({ currentTarget: { dataset: { v: '3.5' } } });
  assert.strictEqual(p.data.preview.lines[0].total, 15);
  pick('semis', 0, 0, 2);
  assert.strictEqual(p.data.preview.lines.length, 3, '四强可以少于 2 个');
  open('semis', 1, 0);
  assert.deepStrictEqual(p.data.sheet.list.map((x) => x.tag), ['冠军', '亚军', '四强'], '已在别的名次里的标出名次');
  tap('carl');
  assert.deepStrictEqual(plain(p.places.semis), [[''], ['carl']], '点了已在别处的：挪过来，原来的位置空出');
  pick('semis', 0, 0, 2);
  // 单打的参加保底：一次多选，已在冠军 / 亚军 / 四强的不能选，再打开保留已选
  p.places.semis = [[''], ['']];
  p.byUid.dora = { uid: 'dora', name: 'Dora', gender: 'f' }; p.people.push(p.byUid.dora);
  p.addFloor();
  assert.strictEqual(p.data.sheet.multi, true);
  tap('alice');
  assert.strictEqual(p.data.sheet.sub, '已选 0 人', '冠军不能再选进保底');
  assert.ok(p.data.sheet.list.find((x) => x.uid === 'alice').off, '已在别的名次里的变灰');
  tap('carl'); tap('dora');
  assert.strictEqual(p.data.sheet.sub, '已选 2 人');
  p.confirmPick();
  assert.deepStrictEqual(plain(p.places.floor), [['carl'], ['dora']]);
  p.addFloor();
  assert.deepStrictEqual(p.data.sheet.list.filter((x) => x.on).map((x) => x.uid), ['carl', 'dora'], '再打开保留已选');
  tap('carl'); p.confirmPick();
  assert.deepStrictEqual(plain(p.places.floor), [['dora']], '取消勾选就从保底里去掉');
  p.people.pop(); delete p.byUid.dora;
  p.places.floor = []; pick('semis', 0, 0, 2);
  p.setKind({ currentTarget: { dataset: { v: 'monthly' } } });
  assert.strictEqual(p.data.hasFloor, true, '现行月赛有 2 分参加保底');
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
    ['Alice（和 Bob）', '10 ÷ 2', 0, 5], ['Bob（和 Alice）', '10 ÷ 2', 0, 5], ['Carl（和 Xia）', '8 ÷ 2', 0, 4], ['Xia（和 Carl）', '8 ÷ 2', 0, 4],
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
  assert.strictEqual(sent[1].stop.kind, 'monthly'); assert.strictEqual(sent[1].stop.pointGroup, '3.5'); assert.strictEqual(sent[1].publish, true);
  const key = sent[1].key;
  p.publish();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(calls.filter((c) => c[0] === 'cupSave').pop()[1].key, key, '再点一次发布还是同一站');
  // 不是管理员：直接打开也不能用
  const def2 = loadDef('pages/cup-edit/cup-edit.js', { '../../utils/member': { status: async () => ({ status: 'active', isAdmin: false }) }, '../../utils/cloud': viaCall({ call: async () => ({}) }) }, wx);
  const q = Object.assign({}, def2, { data: plain(def2.data), setData(o) { Object.assign(this.data, o); } });
  await q.onLoad({});
  assert.strictEqual(q.data.ok, false); assert.strictEqual(q.data.authError, '只有管理员可以补录积分');
});

test('补录页：手动补录保存草稿后不会凭空出现「来自活动」卡片；参加保底的提示和按钮不同时出现', async () => {
  // setData 按小程序的路径写法（'from.stale'）更新，才能看出把 null 写成 { stale: false } 的问题
  const setPath = function (o) {
    Object.keys(o).forEach((k) => {
      const ks = k.split('.'); let t = this.data;
      ks.slice(0, -1).forEach((x) => { if (!t[x] || typeof t[x] !== 'object') t[x] = {}; t = t[x]; });
      t[ks[ks.length - 1]] = o[k];
    });
  };
  const wx = { hideShareMenu() {}, setNavigationBarTitle() {}, showToast() {}, navigateBack() {}, showModal: (o) => o.success && o.success({ confirm: true }) };
  const def = loadDef('pages/cup-edit/cup-edit.js', {
    '../../utils/member': { status: async () => ({ status: 'active', isAdmin: true }) },
    '../../utils/cloud': viaCall({ call: async (action) => (action === 'listMembers' ? { active: [{ uid: 'alice', nickname: 'Alice' }, { uid: 'bob', nickname: 'Bob' }] } : { status: 'draft', id: 'stopX' }) }),
  }, wx);
  const p = Object.assign({}, def, { data: plain(def.data), setData: setPath });
  await p.onLoad({});
  assert.strictEqual(p.data.from, null);
  p.places.champion = ['alice']; p.places.runnerUp = ['bob']; p.render();
  await p.submit(false);
  assert.strictEqual(p.data.editing, true);
  assert.strictEqual(p.data.from, null, '手动补录保存草稿后 from 仍为空（不出现「来自活动」、不锁定类别 / 形式 / 组别）');
  // 从活动结算的：保存后照旧把 stale 清掉
  p.setData({ from: { title: '周赛', notes: [], stale: true } });
  await p.submit(false);
  assert.deepStrictEqual(plain(p.data.from), { title: '周赛', notes: [], stale: false });

  // 模板：「参加保底」那一块按 showPointGroup / hasFloor 各种组合，按钮和「月赛没有参加保底分」不同时出现
  const wxml = read('pages/cup-edit/cup-edit.wxml');
  const i = wxml.indexOf('bindtap="addFloor"');
  const block = wxml.slice(wxml.lastIndexOf('<view wx:if="{{hasFloor}}"', i), wxml.indexOf('月赛没有参加保底分', i) + 40);
  const nodes = [...block.matchAll(/<view (wx:if|wx:elif|wx:else)(?:="\{\{([^}]*)\}\}")?[^>]*>/g)].map((m) => ({ kind: m[1], cond: m[2], idx: m.index }));
  assert.strictEqual(nodes.length, 3, block);
  const evalIn = (st, c) => Function('hasFloor', 'showPointGroup', 'return (' + c + ');')(st.hasFloor, st.showPointGroup);
  for (const hasFloor of [true, false]) {
    for (const showPointGroup of [true, false]) {
      const st = { hasFloor, showPointGroup };
      const shown = []; let chain = false;
      nodes.forEach((n) => {
        if (n.kind === 'wx:if') { chain = evalIn(st, n.cond); if (chain) shown.push(n.idx); }
        else if (n.kind === 'wx:elif') { if (!chain && evalIn(st, n.cond)) { chain = true; shown.push(n.idx); } }
        else if (!chain) { chain = true; shown.push(n.idx); }
      });
      const text = shown.map((x) => block.slice(x, block.indexOf('</view>', x)));
      const btn = text.some((t) => /addFloor/.test(t)), none = text.some((t) => /月赛没有参加保底分/.test(t));
      assert.ok(!(btn && none), `hasFloor=${hasFloor} showPointGroup=${showPointGroup}：不能同时出现「添加参加保底」和「月赛没有参加保底分」`);
      assert.strictEqual(btn, hasFloor);
      if (!hasFloor && !showPointGroup) assert.ok(none, '没有保底的旧月赛照旧提示');
    }
  }
});

test('补录页撤下：已发布的站「撤下这一站」、草稿「删除这份草稿」；先选固定原因再确认，取消任何一步都不调用云函数', async () => {
  const calls = [];
  let answer = '录错了这一站', confirm = true;
  const wx = { hideShareMenu() {}, setNavigationBarTitle() {}, showToast() {}, navigateBack() {}, showModal: (o) => o.success && o.success({ confirm }) };
  const published = { id: 'stop20261122w', date: YESTERDAY, year: 2026, kind: 'weekly', format: 'single', status: 'published', fixes: 0, places: { champion: ['alice'], runnerUp: ['bob'], semis: [], floor: [] }, results: [] };
  const def = loadDef('pages/cup-edit/cup-edit.js', {
    '../../utils/member': { status: async () => ({ status: 'active', isAdmin: true }) },
    '../../utils/pick': { reason: async (kind) => { calls.push(['pick', kind]); return answer; } },
    '../../utils/cloud': viaCall({ call: async (action, data) => { calls.push([action, data]); return action === 'listMembers' ? { active: [{ uid: 'alice', nickname: 'Alice' }, { uid: 'bob', nickname: 'Bob' }] } : action === 'cupList' ? { list: [published] } : { removed: true }; } }),
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

// 「我的」页和个人明细页：固定今天是 2026-11-23（「今年」= 2026），在沙盒里跑真实页面代码
function loadPage(file, deps, wx) {
  const vm = require('vm');
  const { createRequire } = require('module');
  const filename = path.resolve(__dirname, '..', file);
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : ['2026-11-23T12:00:00+08:00'])); } static now() { return new RealDate('2026-11-23T12:00:00+08:00').getTime(); } }
  let def;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (id) => deps[id] || createRequire(filename)(id), wx, console, setTimeout, Date: FakeDate,
    Page: (d) => { def = d; }, Component: (d) => { def = d; },
  });
  return Object.assign({}, def, { data: plain(def.data), setData(o, cb) { Object.assign(this.data, plain(o)); if (cb) cb(); } });
}
const profOf = (env) => {
  const prof = {};
  Object.values(env.coll('players')).forEach((x) => { prof[x._openid] = { name: x.name, gender: x.gender || '', shown: x.shown === true }; });
  return prof;
};
const minePages = (env, me, list) => {
  const deps = {
    '../../utils/cloud': { cached: async (a) => { assert.strictEqual(a, 'cupList'); return { list: list(), admin: false }; } },
    '../../utils/db': { playersShared: async () => [], profilesOf: () => profOf(env), myOpenid: async () => me },
    '../../utils/memo': { invalidate() {} },
  };
  const nav = [];
  const wx = { hideShareMenu() {}, navigateTo: (o) => nav.push(o.url), stopPullDownRefresh() {} };
  return { deps, wx, nav };
};

test('我的积分（C.mine / myYears / latestOf）：按用户 ID 认自己；单打、双打分开，遭遇赛单独；按比赛日期归年度；草稿不算', () => {
  const st = (id, date, kind, format, champion, runnerUp, status) => {
    const c = C.cleanStop({ date, kind, format, places: { champion, runnerUp, semis: [], floor: [] } }, TODAY);
    assert.ok(c.ok, c.error);
    return Object.assign({ id, status: status || 'published' }, c.rec, { results: C.results(c.rec, (u) => g[u] || '') });
  };
  const list = [
    st('s1', '2026-11-22', 'weekly', 'single', ['alice'], ['bob']),             // Alice 单打冠军 30 + 10
    st('s2', '2026-11-15', 'monthly', 'double', ['alice', 'fay'], ['bob', 'carl']), // 双打冠军 60 ÷ 2 = 30
    st('s3', '2026-11-08', 'encounter', 'single', ['bob'], ['alice']),          // 遭遇赛亚军 28：单独统计
    st('s4', '2025-12-30', 'weekly', 'single', ['bob'], ['alice']),             // 跨年：算 2025
    st('s5', '2026-11-23', 'weekly', 'double', ['alice', 'bob'], ['carl', 'dora'], 'draft'), // 草稿不算
  ];
  const m = C.mine(list, 'alice', 2026);
  assert.deepStrictEqual([m.single.total, m.single.stops, m.single.champions], [40, 1, 1]);
  assert.deepStrictEqual([m.double.total, m.double.stops], [30, 1], '双打按个人：一队名次分的一半');
  assert.deepStrictEqual([m.encounter.total, m.encounter.stops], [28, 1], '遭遇赛单独，不进单打年终榜');
  assert.deepStrictEqual(m.double.sources[0].team, ['alice', 'fay']);
  assert.deepStrictEqual([C.mine(list, 'alice', 2025).single.total, C.mine(list, 'alice', 2025).single.stops], [20, 1], '2025-12-30 那站归 2025 年');
  assert.deepStrictEqual(C.myYears(list, 'alice'), [2026, 2025]);
  assert.deepStrictEqual(C.myYears(list, 'gus'), []);
  const l = C.latestOf(list, 'alice');
  assert.deepStrictEqual([l.stopId, l.date, l.tier, l.total, l.board], ['s1', '2026-11-22', 'champion', 40, 'single'], '最近一站不算草稿');
  assert.strictEqual(C.latestOf(list, 'gus'), null);
  assert.strictEqual(C.mine(list, 'gus', 2026).single.total, 0);
  // 和年度榜同一套累计
  assert.strictEqual(C.board(list, 2026, 'double').find((r) => r.key === 'alice').total, m.double.total);
});

test('我的积分：没开公开展示也能看到自己的总分和明细；双打搭档没授权显示「球友」；管理员更正、撤下后刷新看到新结果', async () => {
  const env = setup();
  ok(await save(env, 'stop20261122w', stop()));                       // Alice 单打冠军 40
  ok(await save(env, 'stopdouble01', stop({ format: 'double', date: '2026-11-15' }, { champion: ['alice', 'fay'], runnerUp: ['bob', 'carl'], semis: [], floor: [] })));
  ok(await save(env, 'stop20251230', stop({ date: '2025-12-30' }, { champion: ['bob'], runnerUp: ['alice'] })));
  env.coll('players').p_alice.shown = false; // Alice 自己没开公开展示
  env.coll('players').p_fay.shown = false;   // 搭档 Fay 也没开
  const forAlice = () => listOf(env, 'alice');
  // 接口：自己的用户 ID 不匿名，搭档换成匿名编号
  const l0 = await forAlice();
  const d = l0.find((x) => x.id === 'stopdouble01');
  assert.ok(d.results.some((r) => r.key === 'alice'), '自己照常');
  assert.ok(!JSON.stringify(l0).includes('"fay"'), '没授权的搭档拿不到用户 ID');
  assert.deepStrictEqual([C.mine(l0, 'alice', 2026).single.total, C.mine(l0, 'alice', 2026).double.total, C.mine(l0, 'alice', 2025).single.total], [40, 15, 20]);

  // 「我的」页卡片
  let cur = l0;
  const { deps, wx, nav } = minePages(env, 'alice', () => cur);
  const me = loadPage('pages/me/me.js', Object.assign({ '../../utils/growth': require('../utils/growth') }, deps), wx);
  await me.loadCup();
  assert.deepStrictEqual(plain(me.data.cup), { year: 2026, any: true, single: '40', double: '15', encounter: '', last: { date: '11-22', kind: '周赛', format: '单打', tier: '冠军', total: '40', which: 'single', year: 2026 } });
  me.openCup();
  assert.strictEqual(nav.pop(), '/pages/cup-mine/cup-mine?year=2026&which=single');

  // 个人明细
  const page = loadPage('pages/cup-mine/cup-mine.js', deps, wx);
  page.onLoad({ year: '2026', which: 'single' });
  await new Promise((r) => setTimeout(r, 0)); await page.load();
  assert.deepStrictEqual(plain(page.data.years), [2026, 2025]);
  assert.deepStrictEqual(plain(page.data.sum), { total: '40', stops: 1, champions: 1 });
  assert.deepStrictEqual(plain(page.data.items.map((x) => [x.date, x.kind, x.tier, x.base, x.bonus, x.bonusText, x.total])), [['11-22', '周赛', '冠军', '30', '10', '女生夺冠奖励', '40']]);
  assert.strictEqual(page.data.meHidden, true, '自己没开：提示积分榜上显示「球友」');
  page.setWhich({ currentTarget: { dataset: { v: 'double' } } });
  assert.deepStrictEqual(plain(page.data.items.map((x) => [x.date, x.tier, x.partner, x.base, x.split, x.total])), [['11-15', '冠军', '球友', '15', '一队 30 分，两人平分', '15']], '搭档没授权：「球友」');
  page.setYear({ currentTarget: { dataset: { v: 2025 } } });
  page.setWhich({ currentTarget: { dataset: { v: 'single' } } });
  assert.deepStrictEqual(plain([page.data.sum.total, page.data.items[0].date, page.data.items[0].tier]), ['20', '12-30', '亚军'], '跨年：2025-12-30 在 2025 年');
  page.setWhich({ currentTarget: { dataset: { v: 'encounter' } } });
  assert.deepStrictEqual([page.data.sum.total, page.data.items.length], ['0', 0]);

  // 管理员更正：Alice 从冠军改成亚军 → 刷新后单打 20
  ok(await save(env, 'stop20261122w', stop({}, { champion: ['bob'], runnerUp: ['alice'] })));
  cur = await forAlice();
  await me.loadCup();
  assert.deepStrictEqual([me.data.cup.single, me.data.cup.last.tier, me.data.cup.last.total], ['20', '亚军', '20']);
  page.setYear({ currentTarget: { dataset: { v: 2026 } } });
  page.setWhich({ currentTarget: { dataset: { v: 'single' } } });
  page.onPullDownRefresh(); await new Promise((r) => setTimeout(r, 0)); await page.load();
  assert.deepStrictEqual(plain([page.data.sum.total, page.data.items[0].tier]), ['20', '亚军']);
  // 管理员撤下双打那站 → 双打 0；再撤下单打 → 今年暂无积分，最近一站是去年那站（写全日期）
  ok(await asAdmin(env, 'cupRemove', { id: 'stopdouble01', reason: '录错了这一站' }));
  ok(await asAdmin(env, 'cupRemove', { id: 'stop20261122w', reason: '录错了这一站' }));
  cur = await forAlice();
  await me.loadCup();
  assert.deepStrictEqual(plain([me.data.cup.any, me.data.cup.single, me.data.cup.double, me.data.cup.last.date]), [false, '0', '0', '2025-12-30']);
  me.openCup();
  assert.strictEqual(nav.pop(), '/pages/cup-mine/cup-mine?year=2025&which=single', '今年没有：打开最近一站那一年');
  const wxml = read('pages/me/me.wxml');
  assert.ok(/今年暂无积分/.test(wxml) && /单打积分/.test(wxml) && /双打积分/.test(wxml));
});

test('我的积分：页面只读 cupList、不能分享、只在「我的」进入；没有自由文字', () => {
  const js = read('pages/cup-mine/cup-mine.js'), json = JSON.parse(read('pages/cup-mine/cup-mine.json'));
  assert.ok(!/cloud\.call\(|cupSave|cupRemove/.test(js) && /cloud\.cached\('cupList'\)/.test(js));
  assert.ok(/hideShareMenu/.test(js) && !/onShareAppMessage|onShareTimeline/.test(js));
  assert.strictEqual(json.enableShareAppMessage, false); assert.strictEqual(json.enableShareTimeline, false);
  assert.ok(JSON.parse(read('app.json')).pages.includes('pages/cup-mine/cup-mine'));
  assert.ok(!/<input|<textarea/.test(read('pages/cup-mine/cup-mine.wxml')));
  const users = fs.readdirSync(path.resolve(__dirname, '..', 'pages')).filter((d) => d !== 'cup-mine' && fs.existsSync(path.resolve(__dirname, '..', 'pages', d, d + '.js')) && /cup-mine/.test(read(`pages/${d}/${d}.js`)));
  assert.deepStrictEqual(users, ['me']);
});

/* ---------- 积分活动：创建 LULU 积分活动 → 完赛后结算（2026-11-23） ---------- */
const D = require('../utils/draw');
const E = require('../utils/event');
const NAMES = ['Alice', 'Bob', 'Carl', 'Dora', 'Eve', 'Fay', 'Gus', 'Hal'];
// 放一个已生成对阵的积分活动（发起人是管理员）；双打 entrants 是「A / B」，报名记录带搭档
function cupDraw(env, id, o) {
  o = o || {};
  const dbl = o.type === 'double';
  const ents = dbl ? ['Alice / Bob', 'Carl / Dora', 'Eve / Fay', 'Gus / Hal'] : NAMES;
  const teams = {};
  if (dbl) ents.forEach((t) => { teams[t] = t.split(' / '); });
  env.put('draws', Object.assign({ _id: id, _openid: ADMIN, title: '周末内部赛', status: 'drawn', type: dbl ? 'double' : 'single', mode: 'bracket', size: 8, date: YESTERDAY, entrants: ents, teams, lines: D.makeBracket(ents, [], 8), cup: { kind: o.kind || 'weekly' } }));
  ents.forEach((t, i) => {
    const [n, partner] = t.split(' / ');
    env.put('signups', Object.assign({ _id: `su_${id}_${i}`, _openid: n.toLowerCase(), drawId: id, name: n }, partner ? { partner, partnerId: partner.toLowerCase() } : {}));
  });
}
const schOf = (env, id) => E.scheduleOf(Object.assign({}, env.coll('draws')[id]), Object.values(env.coll('matches')).filter((m) => m.drawId === id));
// 按名字先后定胜负（名字靠前的赢），打完所有能打的场次
async function playAll(env, id, upTo) {
  for (let k = 0; k < 60; k++) { // 8 人一组循环有 28 场
    const x = schOf(env, id).find((y) => y.ready && !y.done && (!upTo || upTo(y)));
    if (!x) return;
    ok(await env.call(ADMIN, 'recordEventMatch', { drawId: id, key: x.key, sets: [x.a < x.b ? { a: 4, b: 1 } : { a: 1, b: 4 }] }));
  }
}
const fromDrawOf = async (env, id) => ok(await asAdmin(env, 'cupFromDraw', { drawId: id }));
const settleDraw = (env, id, fresh, o) => asAdmin(env, 'cupSave', Object.assign({ key: 'cWhatever01', drawId: id, publish: true, stop: { date: fresh.date, kind: fresh.kind, format: fresh.format, places: fresh.places } }, o || {}));
const stopsOf = (env, id) => Object.values(env.coll('cup_stops')).filter((x) => x.drawId === id);
const uidsOf = (names) => names.map((n) => n.toLowerCase());

test('积分活动：创建时默认不计；周赛、月赛、遭遇赛都可以循环＋淘汰或单淘汰（签数不限），只有分组循环不行；只有管理员能建；普通活动编辑不接受积分设置', async () => {
  const env = setup();
  const mk = (draw) => asAdmin(env, 'createDraw', { draw: Object.assign({ title: '周末内部赛', mode: 'bracket', size: 8, date: YESTERDAY }, draw) });
  const plainId = ok(await mk({})).id;
  assert.ok(!('cup' in env.coll('draws')[plainId]), '默认不计入');
  const wid = ok(await mk({ cup: { kind: 'weekly', extra: 1 } })).id;
  assert.deepStrictEqual(env.coll('draws')[wid].cup, { kind: 'weekly', pointGroup: 'open', scoreVersion: C.SCORE_VERSION });
  ok(await mk({ cup: { kind: 'monthly' }, type: 'double' }));
  const quarterId = ok(await mk({ size: 16, cup: { kind: 'quarterly', pointGroup: '3.5', scoreVersion: C.SCORE_VERSION } })).id;
  assert.deepStrictEqual(E.publicDraw(env.coll('draws')[quarterId]).cup, { kind: 'quarterly', pointGroup: '3.5', scoreVersion: C.SCORE_VERSION });
  no(await mk({ cup: { kind: 'encounter', scoreVersion: C.SCORE_VERSION } }), /请选择当前的积分类别/);
  // 周赛（2026-11-24 用户要求放开）：单淘汰不限 8 签，也可以循环＋淘汰；只有分组循环（没有最后一轮）不行
  ok(await mk({ cup: { kind: 'weekly' }, size: 16 }));
  ok(await mk({ cup: { kind: 'weekly' }, size: 12 }));
  ok(await mk({ cup: { kind: 'weekly' }, mode: 'groups_ko', groupCount: 2, advance: 2 }));
  no(await mk({ cup: { kind: 'weekly' }, mode: 'groups', groupCount: 2 }), /周赛要有最后一轮，请把活动形式改成「循环＋淘汰」或「单淘汰」/);
  // 月赛（2026-11-24 用户要求放开）：单淘汰几签都行，也可以循环＋淘汰；只有分组循环（没有最后一轮）不行
  no(await mk({ cup: { kind: 'monthly' }, mode: 'groups', groupCount: 2 }), /月赛要有最后一轮/);
  ok(await mk({ cup: { kind: 'monthly' }, size: 16 }));
  ok(await mk({ cup: { kind: 'monthly' }, size: 4 }));
  ok(await mk({ cup: { kind: 'monthly' }, mode: 'groups_ko', groupCount: 2, advance: 2 }));
  no(await mk({ cup: { kind: 'encounter' }, mode: 'groups', groupCount: 2 }), /最后一轮/);
  ok(await mk({ cup: { kind: 'encounter' }, mode: 'groups_ko', groupCount: 2, advance: 2 }));
  ok(await mk({ cup: { kind: 'encounter' }, size: 16 }));
  no(await mk({ cup: { kind: 'team' } }), /请选择有效积分类别/);
  no(await mk({ cup: 'weekly' }), /请选择有效积分类别/);
  ok(await mk({ cup: false })); ok(await mk({ cup: null }));
  no(await env.call('alice', 'createDraw', { draw: { title: '周末内部赛', mode: 'bracket', size: 8, cup: { kind: 'weekly' } } }), /管理员/);
  // 编辑活动信息不能加上 / 改掉积分设置
  ok(await asAdmin(env, 'updateDrawInfo', { drawId: plainId, info: { title: '改个名字', date: YESTERDAY, cup: { kind: 'weekly' } } }));
  ok(await asAdmin(env, 'updateDrawInfo', { drawId: wid, info: { title: '改个名字', date: YESTERDAY, cup: null } }));
  assert.ok(!('cup' in env.coll('draws')[plainId]));
  assert.deepStrictEqual(env.coll('draws')[wid].cup, { kind: 'weekly', pointGroup: 'open', scoreVersion: C.SCORE_VERSION });
  // 下发：只认三种类别；标签文字
  assert.strictEqual(E.publicDraw({ cup: { kind: 'x' } }).cup, undefined);
  assert.strictEqual(E.publicDraw({}).cup, undefined);
  assert.deepStrictEqual(E.publicDraw({ cup: { kind: 'weekly', extra: 1 } }).cup, { kind: 'weekly' });
  assert.strictEqual(C.drawCupText({}), '');
  assert.strictEqual(C.drawCupText({ cup: { kind: 'monthly' } }), 'LULU 积分 · 月赛');
  // 普通 / 旧活动：不能结算积分
  no(await asAdmin(env, 'cupFromDraw', { drawId: plainId }), /没有设置计入 LULU 积分/);
  no(await asAdmin(env, 'cupSave', { key: 'cWhatever01', drawId: plainId, stop: stop() }), /没有设置计入 LULU 积分/);
  no(await asAdmin(env, 'cupFromDraw', { drawId: 'nope' }), /活动不存在/);
});

test('管理员可从活动详情更正积分类别，保留报名、对阵、积分组别和规则版本', async () => {
  const env = setup();
  cupDraw(env, 'editCup');
  const draw = env.coll('draws').editCup;
  draw.status = 'signup';
  draw.cup = { kind: 'weekly', pointGroup: '3.5', scoreVersion: C.SCORE_VERSION };
  const change = { drawId: 'editCup', fromKind: 'weekly', kind: 'monthly' };
  const signups = JSON.stringify(env.coll('signups'));
  const lines = JSON.stringify(draw.lines);
  no(await env.call('alice', 'updateDrawCupKind', change), /只有管理员/);
  const updated = ok(await asAdmin(env, 'updateDrawCupKind', change));
  assert.deepStrictEqual(updated.cup, { kind: 'monthly', pointGroup: '3.5', scoreVersion: C.SCORE_VERSION });
  assert.deepStrictEqual(env.coll('draws').editCup.cup, updated.cup);
  assert.strictEqual(JSON.stringify(env.coll('signups')), signups);
  assert.strictEqual(JSON.stringify(env.coll('draws').editCup.lines), lines);
  assert.strictEqual(ok(await asAdmin(env, 'updateDrawCupKind', change)).same, true);
  no(await asAdmin(env, 'updateDrawCupKind', Object.assign({}, change, { kind: 'quarterly' })), /刷新后再修改/);
  no(await asAdmin(env, 'updateDrawCupKind', { drawId: 'editCup', fromKind: 'monthly', kind: 'encounter' }), /有效积分类别/);
  const audits = Object.values(env.coll('requests')).filter((r) => r.type === 'editCupKind');
  assert.deepStrictEqual(audits.map((r) => [r.before, r.after]), [['weekly', 'monthly']]);

  cupDraw(env, 'legacyEdit');
  ok(await asAdmin(env, 'updateDrawCupKind', { drawId: 'legacyEdit', fromKind: 'weekly', kind: 'encounter' }));
  assert.deepStrictEqual(env.coll('draws').legacyEdit.cup, { kind: 'encounter' });
  env.coll('draws').legacyEdit.size = 16;
  ok(await asAdmin(env, 'updateDrawCupKind', { drawId: 'legacyEdit', fromKind: 'encounter', kind: 'weekly' }), '16 签单淘汰也能改成周赛');
  assert.deepStrictEqual([env.coll('draws').legacyEdit.mode, env.coll('draws').legacyEdit.size], ['bracket', 16], '更正类别不改活动形式');
  env.coll('draws').legacyEdit.mode = 'groups';
  no(await asAdmin(env, 'updateDrawCupKind', { drawId: 'legacyEdit', fromKind: 'weekly', kind: 'monthly' }), /月赛要有最后一轮/);
});

// 真实流程：管理员创建积分活动 → 8 位成员报名 → 生成对阵 → 打完 → 按对阵预填名次 → 发布
async function cupFlow(env, kind, draw, makeDraw) {
  const id = ok(await asAdmin(env, 'createDraw', { draw: Object.assign({ title: '周末内部赛', date: YESTERDAY, cup: { kind, scoreVersion: C.SCORE_VERSION } }, draw) })).id;
  for (const n of NAMES) ok(await env.call(n.toLowerCase(), 'signUp', { drawId: id }));
  const d = env.coll('draws')[id];
  ok(await asAdmin(env, 'generateDraw', { drawId: id, draw: Object.assign({ entrants: NAMES, settingsVersion: d.settingsVersion || 0, rosterVersion: d.rosterVersion || 0 }, makeDraw()) }));
  return id;
}
test('积分活动「循环＋淘汰」：周赛、月赛各打一场，小组前 2 名进入淘汰阶段，完赛后从淘汰阶段预填冠军、亚军、四强并结算', async () => {
  for (const kind of ['weekly', 'monthly']) {
    const env = setup();
    const id = await cupFlow(env, kind, { mode: 'groups_ko', groupCount: 2, advance: 2 }, () => ({ groups: D.makeGroups(NAMES, [], 2) }));
    const d = () => env.coll('draws')[id];
    assert.deepStrictEqual([d().mode, d().groupCount, d().advance, d().cup.kind], ['groups_ko', 2, 2, kind], kind + '：活动形式按管理员选的保存');
    const ms = () => Object.values(env.coll('matches')).filter((m) => m.drawId === id);
    // 先打完小组赛：淘汰阶段的对阵由各组前 2 名填上
    assert.ok(schOf(env, id).filter((x) => x.key[0] === 'k').every((x) => !x.ready), '小组赛没打完，淘汰阶段还不能打');
    await playAll(env, id, (x) => x.key[0] === 'g');
    const tops = E.groupsFor(d(), ms()).map((g) => g.table.slice(0, 2).map((r) => r.name));
    const ko = schOf(env, id).filter((x) => x.key[0] === 'k');
    const first = ko.filter((x) => x.ready);
    assert.strictEqual(first.length, 2, '4 强那一轮两场都能打了');
    assert.deepStrictEqual(first.map((x) => [x.a, x.b]).flat().sort(), tops.flat().sort(), '进入淘汰阶段的是各组前 2 名');
    first.forEach((x) => assert.ok(!tops.some((t) => t.includes(x.a) && t.includes(x.b)), '同组的两人第一轮不碰'));
    assert.ok(!C.fromDraw(d(), ms(), {}).done, '淘汰阶段没打完不能结算');
    await playAll(env, id);
    // 名次从淘汰阶段带入
    const f = (await fromDrawOf(env, id)).fresh;
    assert.ok(f.done);
    const view = E.knockoutFor(d(), ms());
    const fin = view.rounds[view.rounds.length - 1].matches[0];
    const semis = view.rounds[view.rounds.length - 2].matches.map((m) => (m.a.win ? m.b.name : m.a.name));
    assert.deepStrictEqual(f.places.champion, uidsOf([view.champion.name]));
    assert.deepStrictEqual(f.places.runnerUp, uidsOf([fin.a.win ? fin.b.name : fin.a.name]));
    assert.deepStrictEqual(f.places.semis.map((x) => x[0]).sort(), uidsOf(semis).sort());
    const outInGroups = NAMES.filter((n) => !tops.flat().includes(n));
    assert.ok(C.hasFloor(kind, 'open', C.SCORE_VERSION), '现行规则周赛、月赛都有参加保底');
    assert.deepStrictEqual(f.places.floor.map((x) => x[0]).sort(), uidsOf(outInGroups).sort(), '小组没出线、实际打过球的 4 位带入参加保底');
    // 管理员核对后发布：分值照现行规则
    ok(await settleDraw(env, id, f));
    const [st] = stopsOf(env, id);
    assert.strictEqual(st.status, 'published');
    // 分值和补录同一套（现行规则冠军 10、亚军 8、四强 6、保底 2），不因活动形式改变
    const base = (tier) => st.results.filter((r) => r.tier === tier).map((r) => r.base);
    assert.deepStrictEqual([base('champion'), base('runnerUp'), base('semi'), base('floor')], [[10], [8], [6, 6], [2, 2, 2, 2]]);
  }
});
test('积分活动「循环＋淘汰」只分 1 组（前 2 名直接打最后一轮）：冠军、亚军照常带入，提示没有 4 强那一轮', async () => {
  const env = setup();
  const id = await cupFlow(env, 'weekly', { mode: 'groups_ko', groupCount: 1, advance: 2 }, () => ({ groups: D.makeGroups(NAMES.slice(0, 8), [], 1) }));
  await playAll(env, id);
  const f = (await fromDrawOf(env, id)).fresh;
  assert.ok(f.done);
  assert.deepStrictEqual([f.places.champion, f.places.runnerUp, f.places.semis], [['alice'], ['bob'], []]);
  assert.ok(f.notes.some((x) => /没有 4 强那一轮/.test(x)), JSON.stringify(f.notes));
});
test('积分周赛不再固定 8 签：单淘汰 16 签创建、生成对阵、完赛预填名次；切换积分类别不改签数', async () => {
  const env = setup();
  const id = await cupFlow(env, 'weekly', { mode: 'bracket', size: 16 }, () => ({ lines: D.makeBracket(NAMES, [], 16) }));
  const d = env.coll('draws')[id];
  assert.deepStrictEqual([d.mode, d.size, d.cup.kind], ['bracket', 16, 'weekly']);
  await playAll(env, id);
  const f = (await fromDrawOf(env, id)).fresh;
  assert.ok(f.done);
  assert.deepStrictEqual([f.places.champion, f.places.runnerUp.length, f.places.semis.length], [['alice'], 1, 2], '按名字先后定胜负：Alice 冠军');
  ok(await settleDraw(env, id, f));
  // 报名中的 12 签周赛：管理员把类别更正成月赛再改回周赛，签数、形式都不变
  const id2 = ok(await asAdmin(env, 'createDraw', { draw: { title: '周末内部赛', date: YESTERDAY, mode: 'bracket', size: 12, cup: { kind: 'weekly', scoreVersion: C.SCORE_VERSION } } })).id;
  ok(await asAdmin(env, 'updateDrawCupKind', { drawId: id2, fromKind: 'weekly', kind: 'monthly' }));
  ok(await asAdmin(env, 'updateDrawCupKind', { drawId: id2, fromKind: 'monthly', kind: 'weekly' }));
  assert.deepStrictEqual([env.coll('draws')[id2].mode, env.coll('draws')[id2].size, env.coll('draws')[id2].cup.kind], ['bracket', 12, 'weekly']);
});

test('积分类别更正与发布结算同时发生，活动和积分站的类别仍然一致', async () => {
  const env = setup();
  cupDraw(env, 'kindRace');
  await playAll(env, 'kindRace');
  const { fresh } = await fromDrawOf(env, 'kindRace');
  const change = { drawId: 'kindRace', fromKind: 'weekly', kind: 'monthly' };
  const both = await Promise.all([asAdmin(env, 'updateDrawCupKind', change), settleDraw(env, 'kindRace', fresh)]);
  assert.strictEqual(both.filter((r) => r.ok).length, 1, JSON.stringify(both));
  const draw = env.coll('draws').kindRace;
  if (both[0].ok) {
    assert.strictEqual(draw.cup.kind, 'monthly');
    assert.strictEqual(stopsOf(env, 'kindRace').length, 0);
    const current = await fromDrawOf(env, 'kindRace');
    ok(await settleDraw(env, 'kindRace', current.fresh, { publish: false }));
  } else {
    assert.strictEqual(draw.cup.kind, 'weekly');
  }
  assert.strictEqual(stopsOf(env, 'kindRace')[0].kind, draw.cup.kind);
  const kind = draw.cup.kind === 'weekly' ? 'monthly' : 'weekly';
  no(await asAdmin(env, 'updateDrawCupKind', { drawId: 'kindRace', fromKind: draw.cup.kind, kind }), /已有积分结算记录/);
});

test('活动顶部修改积分类别：取消保留原类别，确认后标签立即更新', async () => {
  const env = setup();
  cupDraw(env, 'editTag');
  let confirm = false;
  let menus = 0;
  const dv = loadDef('pages/draw-view/draw-view.js', {
    '../../utils/db': {}, '../../utils/pick': {}, '../../utils/share-card': {},
    '../../utils/cloud': { call: async (action, data) => ok(await asAdmin(env, action, data)) },
  }, {
    showActionSheet({ itemList, success }) { menus++; success({ tapIndex: itemList.indexOf('月赛') }); },
    showModal({ success }) { success({ confirm }); },
    showToast() {},
  });
  const page = {
    id: 'editTag', d: env.coll('draws').editTag, editCupKind: dv.editCupKind,
    data: { cupTag: 'LULU 积分 · 周赛', canEditCup: false, ready: true },
    setData(data) { Object.assign(this.data, data); },
  };
  await page.editCupKind();
  assert.strictEqual(menus, 0);
  page.data.canEditCup = true;
  await page.editCupKind();
  assert.strictEqual(env.coll('draws').editTag.cup.kind, 'weekly');
  confirm = true;
  await page.editCupKind();
  assert.strictEqual(page.data.cupTag, 'LULU 积分 · 月赛');
  assert.strictEqual(env.coll('draws').editTag.cup.kind, 'monthly');
  assert.strictEqual(page.data.cupKindBusy, false);
  assert.match(read('pages/draw-view/draw-view.wxml'), /wx:if="{{canEditCup}}"[^>]*bindtap="editCupKind"/);
});

test('积分活动结算：没打完不能结算；非管理员不能操作；名次按对阵预填（退赛的不带入保底）；重复提交、同时提交都只有一站；再次进入打开原站', async () => {
  const env = setup();
  cupDraw(env, 'dw1');
  env.coll('draws').dw1.withdrawals = [{ entrant: 'Hal', stage: 'ko', policy: 'walkover' }]; // Hal 第一场前退赛：对手弃权胜
  await playAll(env, 'dw1', (x) => x.round === 1); // 只打完第一轮
  const f0 = await fromDrawOf(env, 'dw1');
  assert.deepStrictEqual([f0.fresh.done, f0.stop, f0.stale], [false, null, false]);
  no(await settleDraw(env, 'dw1', Object.assign({}, f0.fresh, { places: stop().places })), /还有场次没打完/);
  no(await env.call('alice', 'cupFromDraw', { drawId: 'dw1' }), /只有管理员/);
  no(await env.call('alice', 'cupSave', { drawId: 'dw1', key: 'cWhatever01', stop: stop(), publish: true }), /只有管理员/);
  await playAll(env, 'dw1');
  assert.ok(schOf(env, 'dw1').every((x) => x.done));

  // 预填：冠军 Alice（名字靠前的赢）；亚军 = 另一半区最靠前的；四强 = 两个半区里 4 强那一轮输的；保底 = 第一轮输的（不含退赛的 Hal）
  const L = env.coll('draws').dw1.lines.map((x) => x.name);
  const min = (xs) => xs.slice().sort()[0], max = (xs) => xs.slice().sort()[1];
  const pairW = [0, 1, 2, 3].map((i) => min(L.slice(i * 2, i * 2 + 2))), pairL = [0, 1, 2, 3].map((i) => max(L.slice(i * 2, i * 2 + 2)));
  const halfW = [min(pairW.slice(0, 2)), min(pairW.slice(2))];
  const f = await fromDrawOf(env, 'dw1');
  assert.strictEqual(f.fresh.done, true);
  assert.match(f.key, /^d[0-9a-f]{24}$/);
  assert.deepStrictEqual([f.fresh.date, f.fresh.kind, f.fresh.format], [YESTERDAY, 'weekly', 'single']);
  assert.deepStrictEqual(f.fresh.places.champion, ['alice']);
  assert.deepStrictEqual(f.fresh.places.runnerUp, uidsOf([halfW.find((n) => n !== 'Alice')]));
  assert.deepStrictEqual(f.fresh.places.semis.map((x) => x[0]).sort(), uidsOf([max(pairW.slice(0, 2)), max(pairW.slice(2))]).sort());
  assert.deepStrictEqual(f.fresh.places.floor.map((x) => x[0]).sort(), uidsOf(pairL.filter((n) => n !== 'Hal')).sort(), '退赛的 Hal 不带入参加保底');
  assert.ok(f.fresh.notes.some((x) => /Hal 退赛了/.test(x)) && f.fresh.notes.some((x) => /弃权/.test(x)), '有退赛、弃权：提示核对');

  // 类别不能改
  no(await settleDraw(env, 'dw1', Object.assign({}, f.fresh, { kind: 'monthly', places: Object.assign({}, f.fresh.places, { floor: [] }) })), /类别和单打 \/ 双打不能改/);
  // 两位管理员同时点发布：只生成一站
  const both = await Promise.all([settleDraw(env, 'dw1', f.fresh), settleDraw(env, 'dw1', f.fresh, { key: 'cOtherKey99' })]);
  assert.ok(both.some((r) => r.ok), JSON.stringify(both));
  both.filter((r) => !r.ok).forEach((r) => assert.match(r.error, /另一位管理员/));
  assert.strictEqual(stopsOf(env, 'dw1').length, 1);
  assert.strictEqual(Object.keys(env.coll('cup_stops')).length, 1, '前端传的编号不算数');
  assert.strictEqual(stopsOf(env, 'dw1')[0]._id, f.key);
  // 再点一次：什么都不变
  const again = ok(await settleDraw(env, 'dw1', f.fresh));
  assert.deepStrictEqual([again.id, again.same], [f.key, true]);
  assert.strictEqual(stopsOf(env, 'dw1').length, 1);
  assert.strictEqual(totalOf(await listOf(env), 2026, 'single', 'alice'), 40, '只算一次：周赛女生冠军 30 + 10');
  // 再次进入：打开原来那一站
  const f2 = await fromDrawOf(env, 'dw1');
  assert.deepStrictEqual([f2.stop.id, f2.stop.status, f2.stop.drawId, f2.stale], [f.key, 'published', 'dw1', false]);
  // 活动结算的站不能当补录的站改（也不能拿活动的编号补录）
  no(await save(env, f.key, stop()), /从活动结算的/);
});

test('季度活动按创建时的组别和规则结算；仅实际打过球的球员可得保底和季度加分', async () => {
  const env = setup();
  cupDraw(env, 'groupDraw', { kind: 'quarterly' });
  const draw = env.coll('draws').groupDraw;
  draw.cup.pointGroup = '3.5';
  draw.cup.scoreVersion = C.SCORE_VERSION;
  draw.withdrawals = [{ entrant: 'Hal', stage: 'ko', policy: 'walkover' }];
  await playAll(env, 'groupDraw');
  const { fresh } = await fromDrawOf(env, 'groupDraw');
  assert.strictEqual(fresh.pointGroup, '3.5');
  assert.strictEqual(C.drawCupText(E.publicDraw(draw)), 'LULU 积分 · 季度赛 · 3.5 组');
  assert.ok(fresh.places.floor.length > 0);
  assert.ok(!fresh.places.floor.flat().includes('hal'));
  no(await settleDraw(env, 'groupDraw', Object.assign({}, fresh, {
    places: Object.assign({}, fresh.places, { floor: fresh.places.floor.concat([['hal']]) }),
  })), /参加保底只给有实际打球记录/);
  const r = ok(await settleDraw(env, 'groupDraw', fresh, {
    stop: { date: fresh.date, kind: fresh.kind, format: fresh.format, pointGroup: '3.0', scoreVersion: 0, places: fresh.places },
  }));
  assert.strictEqual(r.stop.pointGroup, '3.5');
  assert.strictEqual(r.stop.scoreVersion, C.SCORE_VERSION);
  assert.strictEqual(r.stop.results[0].total, 17);
  assert.ok(r.stop.results.filter((x) => x.tier === 'floor').every((x) => x.total === 4));
});

test('积分活动：改了最后一轮的比分 → 提示重新核对，发布更正沿用原编号，年度榜按新名次；撤下后不能再结算', async () => {
  const env = setup();
  cupDraw(env, 'dw2');
  await playAll(env, 'dw2');
  const f = await fromDrawOf(env, 'dw2');
  ok(await settleDraw(env, 'dw2', f.fresh));
  const runner = f.fresh.places.runnerUp[0];
  let list = await listOf(env);
  assert.deepStrictEqual([totalOf(list, 2026, 'single', 'alice'), totalOf(list, 2026, 'single', runner)], [40, 20]);
  // 发起人把最后一轮改成对方赢
  const fin = schOf(env, 'dw2').find((x) => x.stage === '最后一轮');
  ok(await env.call(ADMIN, 'recordEventMatch', { drawId: 'dw2', key: fin.key, sets: [fin.winner === 'a' ? { a: 1, b: 4 } : { a: 4, b: 1 }] }));
  const g2 = await fromDrawOf(env, 'dw2');
  assert.strictEqual(g2.stale, true, '名次变了：提示重新核对');
  assert.deepStrictEqual([g2.fresh.places.champion, g2.fresh.places.runnerUp], [[runner], ['alice']]);
  const r = ok(await settleDraw(env, 'dw2', g2.fresh));
  assert.deepStrictEqual([r.id, r.how], [f.key, 'fix']);
  assert.strictEqual(stopsOf(env, 'dw2').length, 1);
  assert.strictEqual(stopsOf(env, 'dw2')[0].fixes, 1);
  list = await listOf(env);
  assert.deepStrictEqual([totalOf(list, 2026, 'single', 'alice'), totalOf(list, 2026, 'single', runner)], [20, 30 + (g[runner] === 'f' ? 10 : 0)], '更正后按新名次，不重复加分');
  assert.strictEqual((await fromDrawOf(env, 'dw2')).stale, false);
  assert.ok(list.every((x) => !('drawId' in x)), '成员的积分榜不带活动 ID');
  assert.strictEqual(ok(await asAdmin(env, 'cupList', {})).list.find((x) => x.id === f.key).drawId, 'dw2', '管理员补录页要用');
  // 已发布之后，活动有场次被撤销（活动又变成没打完）：还能更正，不会只剩撤下一条路
  const finM = Object.values(env.coll('matches')).find((m) => m.drawId === 'dw2' && m.drawKey === fin.key);
  ok(await asAdmin(env, 'revokeMatch', { matchId: finM._id, confirmImpact: true }));
  assert.strictEqual((await fromDrawOf(env, 'dw2')).fresh.done, false);
  const fixAgain = g2.fresh.places;
  ok(await settleDraw(env, 'dw2', Object.assign({}, g2.fresh, { places: Object.assign({}, fixAgain, { semis: fixAgain.semis.slice(0, 1) }) })));
  assert.strictEqual(stopsOf(env, 'dw2')[0].fixes, 2);
  // 撤下：再进来提示已撤下，不能再结算
  ok(await asAdmin(env, 'cupRemove', { id: f.key, reason: '录错了这一站' }));
  const g3 = await fromDrawOf(env, 'dw2');
  assert.deepStrictEqual([g3.removed, g3.stop], [true, null]);
  no(await settleDraw(env, 'dw2', g2.fresh), /已经撤下/);
  assert.strictEqual(totalOf(await listOf(env), 2026, 'single', 'alice'), 0);
});

test('积分活动：双打两人平分进双打榜、单打榜不受影响；外部平台的比赛照样「补录一站」；普通活动、日常比赛不产生积分', async () => {
  const env = setup();
  cupDraw(env, 'dw3', { type: 'double', kind: 'monthly' });
  await playAll(env, 'dw3');
  const f = await fromDrawOf(env, 'dw3');
  assert.deepStrictEqual([f.fresh.format, f.fresh.kind, f.fresh.places.champion, f.fresh.places.floor], ['double', 'monthly', ['alice', 'bob'], []], '月赛没有保底');
  ok(await settleDraw(env, 'dw3', f.fresh));
  ok(await save(env, 'cExternal01', stop({ date: '2026-11-20' }, { semis: [], floor: [] }))); // 外部平台：补录一站（Alice 单打冠军 40、Bob 亚军 20）
  // 普通活动打完也不会有积分
  cupDraw(env, 'dw4');
  delete env.coll('draws').dw4.cup;
  await playAll(env, 'dw4');
  const list = await listOf(env);
  assert.strictEqual(list.length, 2);
  assert.deepStrictEqual([totalOf(list, 2026, 'double', 'alice'), totalOf(list, 2026, 'double', 'bob')], [30, 30], '月赛双打冠军 60 两人平分');
  assert.strictEqual(totalOf(list, 2026, 'single', 'alice'), 40, '单打榜只有补录的那一站');
  assert.strictEqual(totalOf(list, 2026, 'single', 'bob'), 20, '补录那站的亚军；双打的分不进单打榜');
  f.fresh.places.runnerUp.concat(...f.fresh.places.semis).forEach((u) => assert.strictEqual(totalOf(list, 2026, 'single', u), 0, '双打的名次不进单打榜'));
  const m = C.mine(list, 'alice', 2026);
  assert.deepStrictEqual([m.single.total, m.double.total], [40, 30]);
});

test('积分活动页面：创建页默认不计、开启 / 换类别不改已选的活动形式（推不出名次只提示）、不匹配不能创建；详情页只给管理员结算入口；结算页按活动预填、类别锁定、发布用云端编号', async () => {
  const env = setup();
  // 创建页
  const nj = read('pages/draw-new/draw-new.js'), nw = read('pages/draw-new/draw-new.wxml');
  assert.ok(/cupOn: false/.test(nj) && /计入 LULU 积分/.test(nw) && /不计入/.test(nw));
  assert.ok(!/CFG_KEY[^\n]*cup/.test(nj), '不记住上次的积分设置');
  let toast = '';
  const dn = loadDef('pages/draw-new/draw-new.js', { '../../utils/db': {}, '../../utils/places': {} }, { showToast: (o) => { toast = o.title; } });
  const pg = { data: { mode: 'groups', size: 16, cupOn: false, cupKind: 'weekly', fromSignup: false, cupErr: '', cupNote: '' }, setData(o) { Object.assign(this.data, o); }, changed(o) { Object.assign(this.data, o); this.checkCup(); }, refresh() { this.checkCup(); } };
  ['setCup', 'setCupKind', 'checkCup', 'cupOk'].forEach((k) => { pg[k] = dn[k]; });
  assert.ok(!('fitCup' in dn), '不再自动改活动形式');
  const tap = (v) => ({ currentTarget: { dataset: { v } } });
  const form = () => [pg.data.mode, pg.data.size, pg.data.groupCount, pg.data.advance];
  // 分组循环推不出名次：开启积分只提示，不改成单淘汰
  Object.assign(pg.data, { groupCount: 3, advance: 1 });
  pg.setCup(tap('1'));
  assert.deepStrictEqual(form(), ['groups', 16, 3, 1], '开启周赛：已选的形式、签数、组数、进入下一轮的人数都不动');
  assert.match(pg.data.cupErr, /周赛要有最后一轮，请把活动形式改成「循环＋淘汰」或「单淘汰」/);
  assert.strictEqual(pg.cupOk(), false);
  assert.match(toast, /循环＋淘汰/);
  pg.setCupKind(tap('monthly'));
  assert.deepStrictEqual(form(), ['groups', 16, 3, 1], '换类别也不动');
  assert.match(pg.data.cupErr, /月赛要有最后一轮/);
  // 管理员自己改成循环＋淘汰：周赛、月赛都可以
  pg.changed({ mode: 'groups_ko' });
  assert.deepStrictEqual([pg.data.cupErr, pg.cupOk()], ['', true]);
  assert.match(pg.data.cupNote, /月赛：循环＋淘汰或单淘汰.*名次从淘汰阶段带入/);
  pg.setCupKind(tap('weekly'));
  assert.deepStrictEqual([form(), pg.data.cupErr], [['groups_ko', 16, 3, 1], ''], '换回周赛：循环＋淘汰保留');
  // 单淘汰：签数照选的（不再固定 8 签）
  pg.changed({ mode: 'bracket', size: 12 });
  pg.setCupKind(tap('monthly')); pg.setCupKind(tap('weekly'));
  assert.deepStrictEqual([form(), pg.data.cupErr], [['bracket', 12, 3, 1], ''], '周赛单淘汰 12 签');
  pg.setCupKind(tap('encounter'));
  assert.deepStrictEqual([pg.data.cupErr, pg.data.size], ['', 12]);
  pg.setCup(tap('0'));
  assert.deepStrictEqual([pg.data.cupOn, pg.data.cupErr, form()], [false, '', ['bracket', 12, 3, 1]]);

  // 详情页：只有管理员看到结算卡
  cupDraw(env, 'dw5');
  const viaCloud = viaCall({ call: async (a, d) => { const r = await asAdmin(env, a, d); if (!r.ok) throw new Error(r.error); return r; } });
  const dv = loadDef('pages/draw-view/draw-view.js', { '../../utils/db': {}, '../../utils/cloud': viaCloud, '../../utils/pick': {}, '../../utils/share-card': {} }, {});
  const view = { id: 'dw5', d: env.coll('draws').dw5, items: schOf(env, 'dw5'), data: { cupBox: null }, setData(o) { Object.assign(this.data, plain(o)); }, loadCupBox: dv.loadCupBox };
  await view.loadCupBox(false);
  assert.strictEqual(view.data.cupBox, null, '普通成员看不到');
  assert.ok(!view.data.canEditCup);
  await view.loadCupBox(true);
  assert.deepStrictEqual([view.data.cupBox.btn, /全部场次结束后/.test(view.data.cupBox.note)], ['', true], '没打完：只有说明');
  await playAll(env, 'dw5');
  view.items = schOf(env, 'dw5');
  await view.loadCupBox(true);
  assert.strictEqual(view.data.cupBox.btn, '结算 LULU 积分');
  const dvw = read('pages/draw-view/draw-view.wxml');
  assert.ok(/wx:if="{{cupTag}}"/.test(dvw) && /bindtap="openCupSettle"/.test(dvw));
  assert.ok(/item\.cupTag/.test(read('pages/draw/draw.wxml')), '活动列表显示积分标签');

  // 结算页：按活动预填，类别锁定，发布后编号是云端给的；再次打开是原来那一站
  const mkEdit = () => {
    const def = loadDef('pages/cup-edit/cup-edit.js', { '../../utils/member': { status: async () => ({ status: 'active', isAdmin: true }) }, '../../utils/cloud': viaCloud, '../../utils/pick': {} },
      { hideShareMenu() {}, setNavigationBarTitle() {}, showToast() {}, navigateBack() {}, showModal: (o) => o.success({ confirm: true }) });
    return Object.assign({}, def, { data: plain(def.data), setData(o) {
      Object.keys(o).forEach((k) => { const ks = k.split('.'); let t = this.data; ks.slice(0, -1).forEach((x) => { t = t[x]; }); t[ks[ks.length - 1]] = plain(o[k]); });
    } });
  };
  const ce = mkEdit();
  await ce.onLoad({ drawId: 'dw5' });
  assert.strictEqual(ce.data.authError, '');
  assert.deepStrictEqual([ce.data.kind, ce.data.format, ce.data.date, ce.data.editing], ['weekly', 'single', YESTERDAY, false]);
  assert.ok(ce.data.from && ce.data.from.title === '周末内部赛');
  ce.setKind(tap('monthly')); ce.setFormat(tap('double'));
  assert.deepStrictEqual([ce.data.kind, ce.data.format], ['weekly', 'single'], '类别、单打 / 双打跟活动走');
  assert.ok(!ce.data.preview.error, JSON.stringify(ce.data.preview));
  assert.strictEqual(ce.data.preview.lines[0].names, 'Alice');
  await ce.submit(true);
  const st = stopsOf(env, 'dw5');
  assert.strictEqual(st.length, 1);
  assert.strictEqual(ce.key, st[0]._id);
  const ce2 = mkEdit();
  await ce2.onLoad({ drawId: 'dw5' });
  assert.deepStrictEqual([ce2.key, ce2.data.editing, ce2.data.published, ce2.data.from.stale], [st[0]._id, true, true, false], '再次进入打开原来那一站');
  // 从积分页打开这一站：同样跟活动走，保存带上活动
  const ce3 = mkEdit();
  await ce3.onLoad({ id: st[0]._id });
  assert.ok(ce3.data.from && ce3.drawId === 'dw5');
  await view.loadCupBox(true);
  assert.strictEqual(view.data.cupBox.btn, '查看积分');
  assert.strictEqual(view.data.canEditCup, false);
  // 没打完的活动从结算页进来：直接提示
  cupDraw(env, 'dw6');
  const ce4 = mkEdit();
  await ce4.onLoad({ drawId: 'dw6' });
  assert.match(ce4.data.authError, /还有场次没打完/);
});

test('授权说明：写明 LULU 积分榜和各站积分明细，没同意时显示「球友」', () => {
  const text = require('../utils/consent').TEXT;
  assert.ok(/LULU 积分榜和各站积分明细/.test(text.split('\n')[0]), '同意的展示位置里有积分榜和各站明细');
  assert.ok(/LULU 积分榜和各站积分明细（含双打搭档）里你的名字显示为「球友」/.test(text));
  const pf = read('pages/profile/profile.wxml');
  assert.ok(/展示在排行榜、LULU 积分、/.test(pf) && /LULU 积分里显示为「球友」/.test(pf) && /仍显示昵称/.test(pf), '资料页的勾选说明（精简成两行）同步');
});

module.exports = T;
