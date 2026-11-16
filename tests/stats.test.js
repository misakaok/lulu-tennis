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

test('交手记录：按用户 ID、只算分在两边的比赛（搭档不算）；弃权不计胜负；同名账号不混', () => {
  const players = [{ name: 'Ann', uid: 'ann', self: true }, { name: 'Bob', uid: 'bob', self: true }, { name: 'Cat', uid: 'cat', self: true }, { name: 'Dan', uid: 'dan', self: true }];
  const raw = [
    m('h1', ['Ann'], ['Bob'], ['ann'], ['bob'], 'a', 4, 1, '2026-10-01'),
    m('h2', ['Bob'], ['Ann'], ['bob'], ['ann'], 'a', 4, 2, '2026-10-02'),
    m('h3', ['Ann', 'Bob'], ['Cat', 'Dan'], ['ann', 'bob'], ['cat', 'dan'], 'a', 4, 0, '2026-10-03'), // 搭档：不算交手
    m('h4', ['Ann', 'Cat'], ['Bob', 'Dan'], ['ann', 'cat'], ['bob', 'dan'], 'b', 3, 4, '2026-10-04'), // 双打对手：算
    Object.assign(m('h5', ['Ann'], ['Bob'], ['ann'], ['bob'], 'a', 0, 0, '2026-10-05'), { sets: [], outcome: 'walkover' }),
    m('h6', ['Bob'], ['Ann'], ['bob2'], ['ann'], 'a', 4, 0, '2026-10-06'), // 另一个也叫 Bob 的账号：不算
  ];
  const ms = ID.normalizeMatches(raw, players);
  const h = PV.h2hView(ms, 'ann', 'Ann', 'bob', 'Bob');
  assert.deepStrictEqual([h.played, h.win, h.lose, h.total], [3, 1, 2, 4]);
  assert.deepStrictEqual(h.rows.map((x) => x.id), ['h5', 'h4', 'h2', 'h1']);
  assert.strictEqual(h.rows[0].outcomeTag, '弃权胜');
  assert.strictEqual(h.rows[2].score, '2-4'); // 比分从「我」的角度看
  // 反过来看，胜负正好相反
  const r = PV.h2hView(ms, 'bob', 'Bob', 'ann', 'Ann');
  assert.deepStrictEqual([r.played, r.win, r.lose], [3, 2, 1]);
  assert.strictEqual(PV.h2hView(ms, 'ann', 'Ann', 'ann', 'Ann'), null);
  assert.strictEqual(PV.h2hView(ms, '', '', 'bob', 'Bob'), null);
  assert.deepStrictEqual(PV.h2hView(ms, 'cat', 'Cat', 'dan', 'Dan').rows.map((x) => x.id), ['h4']); // h3 是搭档，只有 h4 是对手
});
test('等级走势：取最近 30 场，柱高在 18～100 之间，和等级历史一致；不足 2 场不显示', () => {
  const players = [{ name: 'Ann', uid: 'ann', self: true, level: 3 }, { name: 'Bob', uid: 'bob', self: true, level: 3 }];
  const raw = [];
  for (let i = 0; i < 34; i++) raw.push(m('t' + String(i).padStart(2, '0'), ['Ann'], ['Bob'], ['ann'], ['bob'], i % 3 ? 'a' : 'b', i % 3 ? 4 : 1, i % 3 ? 1 : 4, '2026-09-' + String(1 + (i % 28)).padStart(2, '0')));
  const ms = ID.normalizeMatches(raw, players);
  const v = PV.playerView({ ann: { name: 'Ann', level: 3 }, bob: { name: 'Bob', level: 3 } }, players, ms, 'ann');
  const hist = R.computeRatings(ms, R.startLevelsFrom(players)).players.ann.history;
  assert.strictEqual(v.trend.n, 30);
  assert.strictEqual(v.trend.bars.length, 30);
  assert.ok(v.trend.bars.every((b) => b.h >= 18 && b.h <= 100));
  assert.strictEqual(v.trend.last, R.fmt(hist[hist.length - 1].level));
  assert.strictEqual(v.trend.first, R.fmt(hist[hist.length - 30].level));
  const lv = hist.slice(-30).map((x) => x.level);
  assert.strictEqual(v.trend.max, R.fmt(Math.max.apply(null, lv)));
  assert.strictEqual(v.trend.bars[lv.indexOf(Math.max.apply(null, lv))].h, 100);
  assert.strictEqual(PV.trendView(hist.slice(0, 1)), null);
  assert.strictEqual(PV.playerView({ zed: { name: 'Zed' } }, players, ms, 'zed').trend, null);
});

test('搭档统计：按搭档累计场数和胜率；最佳搭档从打满 3 场的里面选；单打不算', () => {
  const players = ['Ann', 'Bob', 'Cat', 'Dan', 'Eli'].map((n) => ({ name: n, uid: n.toLowerCase(), self: true }));
  const d = (id, a, b, w, date) => Object.assign(m(id, a, b, a.map((n) => n.toLowerCase()), b.map((n) => n.toLowerCase()), w, w === 'a' ? 4 : 1, w === 'a' ? 1 : 4, date), { type: 'double' });
  const raw = [
    d('p1', ['Ann', 'Bob'], ['Cat', 'Dan'], 'a', '2026-03-01'), d('p2', ['Ann', 'Bob'], ['Cat', 'Dan'], 'a', '2026-03-02'),
    d('p3', ['Cat', 'Dan'], ['Bob', 'Ann'], 'a', '2026-03-03'), d('p4', ['Ann', 'Bob'], ['Cat', 'Eli'], 'b', '2026-03-04'),
    d('p5', ['Ann', 'Cat'], ['Bob', 'Dan'], 'a', '2026-04-01'), d('p6', ['Ann', 'Cat'], ['Bob', 'Dan'], 'a', '2026-04-02'), d('p7', ['Dan', 'Bob'], ['Cat', 'Ann'], 'b', '2026-04-03'),
    d('p8', ['Ann', 'Dan'], ['Bob', 'Cat'], 'a', '2026-05-01'),
    m('p9', ['Ann'], ['Bob'], ['ann'], ['bob'], 'a', 4, 0, '2026-05-02'), // 单打
    Object.assign(d('pa', ['Ann', 'Bob'], ['Cat', 'Dan'], 'a', '2026-05-03'), { sets: [], outcome: 'walkover' }), // 弃权不算
  ];
  const ms = ID.normalizeMatches(raw, players);
  const pv = PV.partnersView(ms, 'ann', 'Ann');
  assert.deepStrictEqual(pv.list.map((x) => [x.name, x.played, x.win, x.rate]), [['Bob', 4, 2, 50], ['Cat', 3, 3, 100], ['Dan', 1, 1, 100]]);
  assert.strictEqual(pv.best.name, 'Cat'); // Dan 只打了 1 场，不参选
  assert.strictEqual(PV.partnersView(ms, 'eli', 'Eli').best, null);
  assert.strictEqual(PV.partnersView(ID.normalizeMatches([raw[8]], players), 'ann', 'Ann'), null);
  // 赛季总结：和 computeRank 同一个口径
  const hist = R.computeRatings(ms, R.startLevelsFrom(players)).players.ann.history;
  const s = PV.seasonSummary(ms, 'ann', 'Ann', '2026', hist);
  const rk = computeRank(ms, 'all').find((x) => x.key === 'ann');
  assert.deepStrictEqual([s.played, s.win, s.lose], [rk.played, rk.win, rk.lose]);
  assert.strictEqual(s.months[2].n, 4); assert.strictEqual(s.months[3].n, 3); assert.strictEqual(s.months[4].n, 2);
  assert.strictEqual(s.busy, '3 月（4 场）');
  assert.ok(/^Cat/.test(s.partner) && /^Bob/.test(s.partnerMost));
  assert.strictEqual(s.level.to, R.fmt(hist[hist.length - 1].level));
  assert.strictEqual(s.level.from, R.fmt(hist[0].level - hist[0].delta));
  assert.ok(!PV.seasonSummary(ms, 'ann', 'Ann', '2025', hist).has);
});
test('趣味榜单：本月活跃、当前连胜、本月进步；只算正常完赛，按单双打筛选', () => {
  const players = [{ name: 'Ann', uid: 'ann', self: true, level: 3 }, { name: 'Bob', uid: 'bob', self: true, level: 3 }, { name: 'Cat', uid: 'cat', self: true, level: 3 }];
  const raw = [
    m('b1', ['Ann'], ['Bob'], ['ann'], ['bob'], 'b', 1, 4, '2026-10-20'),
    m('b2', ['Ann'], ['Bob'], ['ann'], ['bob'], 'a', 4, 1, '2026-11-01'),
    m('b3', ['Ann'], ['Cat'], ['ann'], ['cat'], 'a', 4, 2, '2026-11-02'),
    Object.assign(m('b4', ['Cat'], ['Ann'], ['cat'], ['ann'], 'a', 0, 0, '2026-11-03'), { sets: [], outcome: 'walkover' }), // 弃权：不打断连胜，也不算场数
  ].map((x) => Object.assign({ type: 'single' }, x));
  const ms = ID.normalizeMatches(raw, players);
  const rt = R.computeRatings(ms, R.startLevelsFrom(players));
  const b = S.boards(ms, rt, 'all', '2026-11');
  assert.deepStrictEqual([b.active.ann, b.active.bob, b.active.cat], [2, 1, 1]);
  assert.deepStrictEqual([b.streak.ann, b.streak.bob, b.streak.cat], [2, 0, 0]);
  const sum = (k) => Math.round(rt.players[k].history.filter((h) => h.date.indexOf('2026-11') === 0).reduce((t, h) => t + h.delta, 0) * 100) / 100;
  assert.strictEqual(b.gain.ann, sum('ann'));
  assert.ok(b.gain.ann > 0 && b.gain.bob < 0);
  assert.deepStrictEqual(S.boards(ms, rt, 'double', '2026-11').active, {});
  assert.deepStrictEqual(S.boards(ms, rt, 'all', '2026-12').active, {});
});
test('性别查找：有用户 ID 按 ID，没有按名字；同名多个账号按名字找不到', () => {
  const g = S.genderFinder([{ name: 'Ann', uid: 'ann', gender: 'f' }, { name: 'Bob', uid: 'bob', gender: 'm' }, { name: 'Sam', uid: '', ambiguous: true, gender: 'm' }, { name: 'Zed', uid: 'zed', gender: '' }]);
  assert.deepStrictEqual([g('Ann', 'ann'), g('改过名', 'bob'), g('Ann'), g('Sam'), g('Zed', 'zed'), g('Ann', 'nobody')], ['女', '男', '女', '', '', '']);
});

module.exports = T;
