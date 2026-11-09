// 统计按统计身份（用户 ID）计算：utils/ident.js normalizeMatches → rules.computeRank / rating.computeRatings / stats / player
const assert = require('assert');
const ID = require('../utils/ident');
const S = require('../utils/stats');
const R = require('../utils/rating');
const PV = require('../utils/player');
const { computeRank } = require('../utils/rules');

const T = [];
const test = (name, fn) => T.push({ name, fn });

const m = (id, a, b, aIds, bIds, winner, ga, gb, date) => ({ _id: id, a, b, aIds, bIds, winner, sets: [{ a: ga, b: gb }], date, createdAt: id.length });
const profiles = (list) => { const o = {}; list.forEach((p) => { if (p.uid) o[p.uid] = p; }); return o; };

test('两个账号同名：统计分开，各自主页只有自己的比赛', () => {
  // fetchPlayersFull 对同名账号会合并成一条 ambiguous（uid 为空）
  const players = [{ name: 'Sam', uid: '', ambiguous: true, self: true }, { name: 'Bob', uid: 'bob', self: true, level: 3 }];
  const raw = [
    m('x1', ['Sam'], ['Bob'], ['sam1'], ['bob'], 'a', 4, 1, '2026-10-01'),
    m('x2', ['Sam'], ['Bob'], ['sam2'], ['bob'], 'b', 1, 4, '2026-10-02'),
    m('x3', ['Sam'], ['Bob'], ['sam2'], ['bob'], 'b', 2, 4, '2026-10-03'),
  ];
  const ms = ID.normalizeMatches(raw, players);
  const st = S.playerStats(ms, players);
  assert.deepStrictEqual([st.map.sam1.played, st.map.sam1.win], [1, 1]);
  assert.deepStrictEqual([st.map.sam2.played, st.map.sam2.win], [2, 0]);
  assert.strictEqual(st.map.bob.played, 3);
  const prof = { sam1: { name: 'Sam' }, sam2: { name: 'Sam' }, bob: { name: 'Bob' } };
  const v1 = PV.playerView(prof, players, ms, 'sam1'), v2 = PV.playerView(prof, players, ms, 'sam2');
  assert.deepStrictEqual(v1.rows.map((x) => x.id), ['x1']);
  assert.deepStrictEqual(v2.rows.map((x) => x.id).sort(), ['x2', 'x3']);
  assert.strictEqual(v1.stats.rate, '100%'); assert.strictEqual(v2.stats.rate, '0%');
  assert.ok(!v1.ambiguous);
});
test('改名：带 ID 的旧记录跟着账号走，统计和主页都算到本人', () => {
  const players = [{ name: 'Alicia', uid: 'alice', self: true, formerNames: ['Alice'] }, { name: 'Bob', uid: 'bob', self: true }];
  const ms = ID.normalizeMatches([m('r1', ['Alice'], ['Bob'], ['alice'], ['bob'], 'a', 4, 2, '2026-10-01')], players);
  assert.deepStrictEqual(ms[0].a, ['Alicia']); assert.deepStrictEqual(ms[0].aKeys, ['alice']);
  const st = S.playerStats(ms, players);
  assert.strictEqual(st.map.alice.win, 1);
  assert.strictEqual(S.display(st, 'Alicia', null, 'alice').played, '1 场');
  assert.strictEqual(S.display(st, 'Alicia', null).played, '1 场', '只有名字时按唯一昵称找到账号');
});
test('旧记录（没有 ID）：名字唯一对应账号的照常计入；同名的不算到任何账号', () => {
  const players = [{ name: 'Bob', uid: 'bob', self: true }, { name: 'Sam', uid: '', ambiguous: true, self: true }];
  const ms = ID.normalizeMatches([m('o1', ['Bob'], ['Sam'], [], [], 'a', 4, 0, '2026-01-01')], players);
  assert.deepStrictEqual(ms[0].aKeys, ['bob']);
  assert.deepStrictEqual(ms[0].bKeys, ['n:Sam']);
  const st = S.playerStats(ms, players);
  assert.strictEqual(st.map.bob.played, 1);
  assert.strictEqual(st.map['n:Sam'].played, 1);
  assert.ok(!st.map.sam1 && !st.map.sam2);
});
test('排行和等级分：按身份累计，带展示名字；水平分涨跌按身份记', () => {
  const players = [{ name: 'A', uid: 'a', self: true, level: 3 }, { name: 'B', uid: 'b', self: true, level: 3 }];
  const ms = ID.normalizeMatches([m('k1', ['A'], ['B'], ['a'], ['b'], 'a', 4, 0, '2026-10-01')], players);
  const rows = computeRank(ms, 'all');
  assert.deepStrictEqual(rows.map((r) => [r.key, r.name, r.win]), [['a', 'A', 1], ['b', 'B', 0]]);
  const rt = R.computeRatings(ms, R.startLevelsFrom(players));
  assert.ok(rt.deltas.k1.a > 0 && rt.deltas.k1.b < 0);
  assert.strictEqual(R.levelOf(rt, 'A', players), rt.players.a.level);
  assert.strictEqual(R.levelOf(rt, 'Nobody', players), R.DEFAULT_LEVEL);
});
test('自评水平：账号按用户 ID 取，不借用同名球员的', () => {
  const players = [{ name: 'Sam', uid: '', ambiguous: true, self: true, level: 4.5 }, { name: 'Bob', uid: 'bob', self: true, level: 2 }];
  const sl = R.startLevelsFrom(players);
  assert.strictEqual(sl.bob, 2); assert.ok(!('Sam' in sl));
});
test('旧缓存里的比赛没有统计身份时，仍按名字计算（不报错）', () => {
  const rows = computeRank([{ _id: 'c1', a: ['A'], b: ['B'], winner: 'a', sets: [{ a: 4, b: 1 }] }], 'all');
  assert.deepStrictEqual(rows.map((r) => r.key), ['A', 'B']);
  const rt = R.computeRatings([{ _id: 'c1', a: ['A'], b: ['B'], winner: 'a', sets: [{ a: 4, b: 1 }] }], { A: 3 });
  assert.strictEqual(rt.players.A.name, 'A');
});

module.exports = T;
