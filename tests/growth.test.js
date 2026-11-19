// 成长档案 · 私人比赛记录：字段校验、统计口径，以及云函数的本人隔离（在内存数据库里跑真实代码）
const assert = require('assert');
const createEnv = require('./mock-cloud');
const G = require('../utils/growth');

const T = [];
const test = (name, fn) => T.push({ name, fn });
const ok = (r) => { assert.ok(r && r.ok, JSON.stringify(r)); return r; };
const no = (r, re) => { assert.strictEqual(r && r.ok, false, '应该被拒绝：' + JSON.stringify(r)); if (re) assert.match(r.error, re); return r; };

const rec = (o) => Object.assign({ date: '2026-10-03', type: 'single', kind: 'practice', setGames: 4, noAd: true, bestOf: 1, sets: [{ a: 4, b: 2 }], tags: [] }, o || {});

function setup() {
  const env = createEnv();
  env.load();
  env.members([['alice', 'Alice'], ['bob', 'Bob']]);
  return env;
}

test('校验：胜负由比分算出；日期、类型、局分、备注标签都按固定规则检查，多余字段丢掉', () => {
  const c = G.clean(rec({ result: 'win', sets: [{ a: 1, b: 4 }], owner: 'bob', note: '自由文字', opponent: '张三' }), '2026-11-17');
  assert.ok(c.ok);
  assert.strictEqual(c.rec.result, 'lose', '不认客户端传来的胜负');
  assert.deepStrictEqual(Object.keys(c.rec).sort(), ['bestOf', 'date', 'kind', 'noAd', 'result', 'setGames', 'sets', 'tags', 'type']);
  const tb = G.clean(rec({ sets: [{ a: 3, b: 3, tbA: 7, tbB: 5 }] }), '2026-11-17');
  assert.ok(tb.ok); assert.deepStrictEqual(tb.rec.sets, [{ a: 4, b: 3, tbA: 7, tbB: 5 }]); assert.strictEqual(G.scoreText(tb.rec), '4-3(7-5)');
  assert.ok(G.clean(rec({ bestOf: 3, sets: [{ a: 4, b: 1 }, { a: 2, b: 4 }, { a: 4, b: 0 }] }), '2026-11-17').ok);
  assert.ok(!G.clean(rec({ bestOf: 3, sets: [{ a: 4, b: 1 }, { a: 2, b: 4 }] }), '2026-11-17').ok, '没打完');
  assert.ok(!G.clean(rec({ sets: [{ a: 4, b: 4 }] }), '2026-11-17').ok);
  assert.ok(!G.clean(rec({ sets: [] }), '2026-11-17').ok);
  assert.ok(!G.clean(rec({ date: '2026-11-18' }), '2026-11-17').ok, '不能是未来');
  assert.ok(!G.clean(rec({ date: '2026-02-30' }), '2026-11-17').ok);
  assert.ok(!G.clean(rec({ type: 'mixed' }), '2026-11-17').ok);
  assert.ok(!G.clean(rec({ kind: 'league' }), '2026-11-17').ok);
  assert.ok(!G.clean(rec({ tags: ['今天被张三打爆'] }), '2026-11-17').ok, '备注只能选固定标签');
  assert.ok(!G.clean(rec({ tags: G.NOTE_TAGS.slice(0, G.MAX_TAGS + 1) }), '2026-11-17').ok);
  assert.deepStrictEqual(G.clean(rec({ tags: ['失误多', '状态好', '失误多'] }), '2026-11-17').rec.tags, ['状态好', '失误多']);
});

test('统计：场次、单双打胜率、本月上月、6 个月走势、连胜都由记录实时算出', () => {
  const list = [
    { date: '2026-11-10', type: 'single', kind: 'practice', result: 'win' },
    { date: '2026-11-02', type: 'double', kind: 'formal', result: 'win' },
    { date: '2026-10-20', type: 'single', kind: 'formal', result: 'lose' },
    { date: '2026-06-01', type: 'single', kind: 'practice', result: 'win' },
    { date: '2026-05-31', type: 'single', kind: 'practice', result: 'win' }, // 超出 6 个月，只算总数
  ];
  const s = G.summary(list, '2026-11-17');
  assert.strictEqual(s.played, 5); assert.strictEqual(s.win, 4); assert.strictEqual(s.rate, 80);
  assert.deepStrictEqual([s.single.played, s.single.win, s.double.played, s.double.rate], [4, 3, 1, 100]);
  assert.deepStrictEqual([s.thisMonth.played, s.lastMonth.played], [2, 1]);
  assert.deepStrictEqual(s.trend.map((t) => t.ym), ['2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11']);
  assert.deepStrictEqual(s.trend.map((t) => t.played), [1, 0, 0, 0, 1, 2]);
  assert.deepStrictEqual(s.streak, { n: 2, win: true });
  assert.strictEqual(s.bestStreak, 2);
  assert.deepStrictEqual(G.lastMonths('2026-02-10', 3), ['2025-12', '2026-01', '2026-02']);
  const e = G.summary([], '2026-11-17');
  assert.deepStrictEqual([e.played, e.rate, e.streak.n], [0, 0, 0]);
});

test('云函数：记录只属于本人；别人不能读、改、删，客户端传的 owner 无效；清除只清本人', async () => {
  const env = setup();
  const id = ok(await env.call('alice', 'growthSave', { record: rec(), owner: 'bob', openid: 'bob' })).id;
  assert.strictEqual(env.coll('growth_matches')[id].owner, 'alice');
  assert.strictEqual(env.coll('growth_matches')[id]._openid, undefined);
  ok(await env.call('bob', 'growthSave', { record: rec({ sets: [{ a: 0, b: 4 }] }) }));
  const mine = ok(await env.call('alice', 'growthList', { owner: 'bob' })).list;
  assert.strictEqual(mine.length, 1); assert.strictEqual(mine[0].id, id); assert.strictEqual(mine[0].owner, undefined);
  const before = JSON.stringify(env.coll('growth_matches')[id]);
  no(await env.call('bob', 'growthSave', { id, record: rec({ sets: [{ a: 0, b: 4 }] }) }), /不存在/);
  no(await env.call('bob', 'growthRemove', { id }), /不存在/);
  assert.strictEqual(JSON.stringify(env.coll('growth_matches')[id]), before);
  // 网关读不到私人记录
  no(await env.call('bob', 'data', { op: 'get', coll: 'growth_matches', where: { owner: 'alice' } }));
  no(await env.call('bob', 'data', { op: 'doc', coll: 'growth_matches', id }));
  // 本人修改：胜负按新比分重算
  ok(await env.call('alice', 'growthSave', { id, record: rec({ sets: [{ a: 2, b: 4 }], result: 'win' }) }));
  assert.strictEqual(env.coll('growth_matches')[id].result, 'lose');
  assert.strictEqual(env.coll('growth_matches')[id].owner, 'alice');
  no(await env.call('alice', 'growthSave', { record: rec({ tags: ['自由文字'] }) }), /选项/);
  no(await env.call('alice', 'growthSave', { record: rec({ date: '2999-01-01' }) }), /晚于今天/);
  no(await env.call('alice', 'growthClear', {}), /确认/);
  ok(await env.call('alice', 'growthSave', { record: rec() }));
  assert.strictEqual(ok(await env.call('alice', 'growthClear', { confirm: true })).removed, 2);
  assert.strictEqual(ok(await env.call('alice', 'growthList')).list.length, 0);
  assert.strictEqual(ok(await env.call('bob', 'growthList')).list.length, 1, '别人的记录不受影响');
  ok(await env.call('bob', 'growthRemove', { id: ok(await env.call('bob', 'growthList')).list[0].id }));
  assert.strictEqual(Object.keys(env.coll('growth_matches')).length, 0);
});

test('云函数：不是正式成员不能使用成长档案；私人记录不进正式战绩', async () => {
  const env = setup();
  no(await env.call('stranger', 'growthSave', { record: rec() }), /请先验证/);
  no(await env.call('stranger', 'growthList'), /请先验证/);
  ok(await env.call('alice', 'growthSave', { record: rec() }));
  const ds = ok(await env.call('alice', 'dataset'));
  assert.strictEqual((ds.matches || []).length, 0);
  assert.strictEqual(Object.keys(env.coll('matches')).length, 0);
});

test('页面：成长档案和编辑页不能分享、没有文字输入，只经 utils/archive.js 读写', () => {
  const fs = require('fs'), path = require('path'), root = path.resolve(__dirname, '..');
  for (const p of ['pages/growth/growth', 'pages/growth-edit/growth-edit']) {
    const js = fs.readFileSync(path.join(root, p + '.js'), 'utf8');
    const xml = fs.readFileSync(path.join(root, p + '.wxml'), 'utf8');
    const cfg = JSON.parse(fs.readFileSync(path.join(root, p + '.json'), 'utf8'));
    assert.ok(!/onShareAppMessage|onShareTimeline/.test(js) && /wx\.hideShareMenu\(\)/.test(js), p);
    assert.strictEqual(cfg.enableShareAppMessage, false); assert.strictEqual(cfg.enableShareTimeline, false);
    assert.ok(!/<input\b|<textarea\b/.test(xml), p + ' 不能有文字输入');
    assert.ok(!/wx\.cloud\.database|getStorageSync\(['"]growth_list/.test(js), p);
  }
  const cloud = fs.readFileSync(path.join(root, 'utils/cloud.js'), 'utf8');
  assert.ok(/growthList: 1/.test(cloud), 'growthList 是只读操作');
});

module.exports = T;
