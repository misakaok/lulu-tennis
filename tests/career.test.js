// 赛季（utils/season.js）和生涯成就（utils/career.js）：都从正式战绩计算，口径和排行榜一致
const assert = require('assert');
const SE = require('../utils/season');
const CA = require('../utils/career');
const PV = require('../utils/player');
const T = [];
const { computeRank } = require('../utils/rules');

const test = (name, fn) => T.push({ name, fn });

let n = 0;
// 一场比赛：A（ua）对 B（ub），w 是胜方
const mk = (date, w, extra) => Object.assign({
  _id: 'm' + ++n, createdAt: n, date, type: 'single', a: ['A'], b: ['B'], aKeys: ['ua'], bKeys: ['ub'], winner: w,
  sets: w === 'a' ? [{ a: 4, b: 2 }] : [{ a: 1, b: 4 }],
}, extra || {});

test('赛季：按比赛日期的自然年划分，当前赛季总在列表里；筛选后和排行榜同一个算法', () => {
  const ms = [mk('2024-12-31', 'a'), mk('2025-01-01', 'b'), mk('2025-06-01', 'a'), mk('', 'a')];
  assert.strictEqual(SE.seasonOf(ms[0]), '2024');
  assert.strictEqual(SE.seasonOf(ms[3]), '');
  const list = SE.seasonsIn(ms);
  assert.ok(list.indexOf(SE.current()) >= 0 && list.indexOf('2024') >= 0 && list.indexOf('2025') >= 0);
  assert.deepStrictEqual(list, list.slice().sort().reverse());
  assert.strictEqual(SE.inSeason(ms, SE.ALL).length, 4);
  const r = computeRank(SE.inSeason(ms, '2025'), 'all');
  const a = r.find((p) => p.key === 'ua');
  assert.deepStrictEqual([a.played, a.win, a.lose], [2, 1, 1]);
  assert.strictEqual(SE.label('2025'), '2025 赛季');
});

test('生涯：场数、连胜、冠军、赛季战绩；弃权和中途退赛不算场数，但决赛弃权胜算夺冠', () => {
  const ms = [
    mk('2025-03-01', 'a'), mk('2025-03-02', 'a'), mk('2025-03-03', 'a'), mk('2025-03-04', 'b'),
    mk('2025-05-01', 'a', { drawId: 'd1', drawTitle: '春季赛', stage: '半决赛' }),
    mk('2025-05-02', 'a', { drawId: 'd1', drawTitle: '春季赛', stage: '决赛' }),
    mk('2026-05-02', 'b', { drawId: 'd2', drawTitle: '夏季赛', stage: '淘汰赛 · 决赛' }),
    mk('2026-06-01', 'a', { drawId: 'd3', drawTitle: '秋季赛', stage: '决赛', outcome: 'walkover', sets: [] }),
    mk('2026-06-02', 'a', { drawId: 'd4', stage: '1/4 决赛', outcome: 'retired' }),
    { _id: 'x', date: '2026-07-01', a: ['C'], b: ['D'], aKeys: ['uc'], bKeys: ['ud'], winner: 'a', sets: [{ a: 4, b: 0 }] }, // 别人的比赛
  ];
  const c = CA.career(ms, 'ua', 'A', [{ level: 2.6 }, { level: 2.9 }, { level: 2.7 }]);
  assert.deepStrictEqual([c.played, c.win, c.lose, c.rate], [7, 5, 2, 71]);
  assert.strictEqual(c.bestStreak, 3);
  assert.strictEqual(c.streak, 0); // 最后一场正常完赛的比赛输了
  assert.strictEqual(c.finals, 3);
  assert.deepStrictEqual(c.titles.map((t) => t.title), ['秋季赛', '春季赛']); // 最近的在前；弃权胜也算
  assert.strictEqual(c.events, 4);
  assert.strictEqual(c.peak, 2.9);
  assert.strictEqual(c.first, '2025-03-01');
  assert.deepStrictEqual(c.rival, { name: 'B', played: 7, win: 5, lose: 2 });
  assert.deepStrictEqual(c.seasons.map((s) => [s.season, s.played, s.win, s.lose, s.titles]), [['2026', 1, 0, 1, 1], ['2025', 6, 5, 1, 1]]);
  // 对手 B 的角度：同一批比赛，胜负相反
  const b = CA.career(ms, 'ub', 'B', []);
  assert.deepStrictEqual([b.played, b.win, b.titles.length, b.finals], [7, 2, 1, 3]);
  // 和排行榜的场数、胜场一致（同一个口径）
  const rank = computeRank(ms, 'all').find((p) => p.key === 'ua');
  assert.deepStrictEqual([rank.played, rank.win], [c.played, c.win]);
});

test('徽章：达成的标出来，没达成的给进度；送蛋、逆转、单双全能', () => {
  const ms = [
    mk('2026-01-01', 'a', { sets: [{ a: 4, b: 0 }] }),
    mk('2026-01-02', 'a', { sets: [{ a: 2, b: 4 }, { a: 4, b: 1 }, { a: 4, b: 2 }] }),
    mk('2026-01-03', 'a', { type: 'double', a: ['A', 'C'], aKeys: ['ua', 'uc'], b: ['B', 'D'], bKeys: ['ub', 'ud'] }),
  ];
  const c = CA.career(ms, 'ua', 'A', []);
  const got = (id) => c.badges.find((x) => x.id === id).got;
  assert.ok(got('debut') && got('win1') && got('s3') && got('bagel') && got('comeback') && got('both'));
  assert.ok(!got('p10') && !got('champ') && !got('s5'));
  assert.strictEqual(c.badges.find((x) => x.id === 'p10').progress, '3/10');
  assert.strictEqual(c.got, 6);
  // 输的一方：没有送蛋、逆转
  const b = CA.career(ms, 'ub', 'B', []);
  assert.ok(!b.badges.find((x) => x.id === 'bagel').got && !b.badges.find((x) => x.id === 'win1').got);
  // 没打过比赛：一个徽章都没有
  assert.strictEqual(CA.career(ms, 'nobody', 'N', []).got, 0);
});

test('球员主页：带出生涯和赛季（按用户 ID，同名的人不会算进来）', () => {
  const ms = [mk('2026-02-01', 'a'), { _id: 'y', date: '2026-02-02', a: ['A'], b: ['B'], aKeys: ['other'], bKeys: ['ub'], winner: 'a', sets: [{ a: 4, b: 0 }], type: 'single' }];
  const v = PV.playerView({ ua: { name: 'A' } }, [{ name: 'A', uid: 'ua' }], ms, 'ua');
  assert.strictEqual(v.career.has, true);
  assert.deepStrictEqual(v.career.seasons.map((s) => [s.season, s.played, s.wl]), [['2026', 1, '1-0']]);
  assert.strictEqual(v.career.cells.find((x) => x.l === '最高等级').n !== '暂无', true);
  assert.strictEqual(PV.playerView({}, [], ms, 'ua').profile, null);
});

// E 对 G、F 对 H 各打 6 场，互有胜负（等级基本不动）：打完后 E、F 都过了定级期
function settled() {
  const out = [];
  for (let i = 0; i < 6; i++) {
    const w = i % 2 ? 'b' : 'a', sets = [w === 'a' ? { a: 4, b: 2 } : { a: 2, b: 4 }];
    out.push(mk('2026-02-0' + (i + 1), w, { a: ['E'], aKeys: ['ue'], b: ['G'], bKeys: ['ug'], sets }));
    out.push(mk('2026-02-0' + (i + 1), w, { a: ['F'], aKeys: ['uf'], b: ['H'], bKeys: ['uh'], sets }));
  }
  return out;
}

test('新徽章：抢七之王、铁人、全勤、社交达人、复仇、巨人杀手；弃权的比赛不算', () => {
  const tb = { sets: [{ a: 4, b: 3, tbA: 7, tbB: 5 }] };
  const ms = [
    // 连续 4 周（周一到周日算一周）：11-02、11-09、11-16、11-23 四个周一；第一天打 3 场
    mk('2026-11-02', 'a', tb), mk('2026-11-02', 'a', tb), mk('2026-11-02', 'a', tb),
    mk('2026-11-09', 'a', tb), mk('2026-11-16', 'a', tb), mk('2026-11-23', 'b', { sets: [{ a: 3, b: 4, tbA: 2, tbB: 7 }] }),
    mk('2026-11-23', 'a', { outcome: 'walkover', sets: [] }), // 弃权：不算铁人
  ];
  const c = CA.career(ms, 'ua', 'A', []);
  const got = (x, id) => x.badges.find((b) => b.id === id).got;
  assert.deepStrictEqual([c.tbWins, c.bestDay, c.bestWeeks], [5, 3, 4]);
  assert.ok(got(c, 'tb5') && got(c, 'iron') && got(c, 'weeks4'));
  assert.ok(!got(c, 'social') && !got(c, 'revenge') && !got(c, 'giant'));
  // 中间断一周：全勤从头数
  assert.strictEqual(CA.career([mk('2026-11-02', 'a'), mk('2026-11-08', 'a'), mk('2026-11-16', 'a'), mk('2026-11-17', 'a')], 'ua', 'A', []).bestWeeks, 1);
  assert.strictEqual(CA.career([mk('2026-12-28', 'a'), mk('2027-01-04', 'a')], 'ua', 'A', []).bestWeeks, 2); // 跨年也连着
  // 社交达人：10 位不同的搭档（同一位打多场只算一位）
  const dbl = [];
  for (let i = 0; i < 10; i++) dbl.push(mk('2026-10-01', 'a', { type: 'double', a: ['A', 'P' + i], aKeys: ['ua', 'p' + i], b: ['B', 'D'], bKeys: ['ub', 'ud'] }));
  dbl.push(mk('2026-10-02', 'a', { type: 'double', a: ['P0', 'A'], aKeys: ['p0', 'ua'], b: ['B', 'D'], bKeys: ['ub', 'ud'] }));
  const s = CA.career(dbl, 'ua', 'A', []);
  assert.strictEqual(s.partners, 10);
  assert.ok(got(s, 'social'));
  // 复仇：对同一位对手连输 3 场后赢回来（B 的角度不算）
  const rv = [mk('2026-09-01', 'b'), mk('2026-09-02', 'b'), mk('2026-09-03', 'b'), mk('2026-09-04', 'a')];
  assert.ok(got(CA.career(rv, 'ua', 'A', []), 'revenge'));
  assert.ok(!got(CA.career(rv, 'ub', 'B', []), 'revenge'));
  assert.ok(!got(CA.career(rv.slice(1), 'ua', 'A', []), 'revenge')); // 只连输 2 场
  // 巨人杀手：赛前等级比对手低 0.3 以上还赢了（等级由水平分算法带出）
  const R = require('../utils/rating');
  // 定级期（前 5 场）的比赛不算：等级还不准
  const first = [mk('2026-08-01', 'a')];
  const r0 = R.computeRatings(first, { ua: 2.5, ub: 3.0 });
  assert.deepStrictEqual(r0.pre[first[0]._id], { a: 2.5, b: 3, prov: true });
  assert.ok(!got(CA.career(first, 'ua', 'A', [], r0.pre), 'giant'));
  const up = settled().concat([mk('2026-08-01', 'a', { a: ['E'], aKeys: ['ue'], b: ['F'], bKeys: ['uf'] })]);
  const rt = R.computeRatings(up, { ue: 2.5, ug: 2.5, uf: 3.2, uh: 3.2 });
  assert.strictEqual(rt.pre[up[up.length - 1]._id].prov, false);
  assert.ok(got(CA.career(up, 'ue', 'E', [], rt.pre), 'giant'));
  assert.ok(!got(CA.career(up, 'uf', 'F', [], rt.pre), 'giant'));
  assert.ok(!got(CA.career(up, 'ue', 'E', [], R.computeRatings(up, { ue: 2.5, ug: 2.5, uf: 2.6, uh: 2.6 }).pre), 'giant')); // 差距不到 0.3
});

test('苦主 / 福星 / 最佳拍档：苦主负多于胜，福星胜多于负，都至少 2 场；对方有账号才能点进主页', () => {
  const vs = (date, w, k, n) => mk(date, w, { b: [n], bKeys: [k] });
  const ms = [
    vs('2026-01-01', 'b', 'ub', 'B'), vs('2026-01-02', 'b', 'ub', 'B'), vs('2026-01-03', 'a', 'ub', 'B'), // 对 B：1 胜 2 负
    vs('2026-01-04', 'a', 'uc', 'C'), vs('2026-01-05', 'a', 'uc', 'C'), vs('2026-01-06', 'a', 'uc', 'C'), vs('2026-01-07', 'b', 'uc', 'C'), // 对 C：3 胜 1 负
    vs('2026-01-08', 'b', 'n:D', 'D'), // 对 D 只输 1 场：不够
    mk('2026-01-09', 'b', { outcome: 'walkover', sets: [] }), // 弃权不算
  ];
  const c = CA.career(ms, 'ua', 'A', []);
  assert.deepStrictEqual(c.nemesis, { key: 'ub', name: 'B', played: 3, win: 1, lose: 2 });
  assert.deepStrictEqual(c.prey, { key: 'uc', name: 'C', played: 4, win: 3, lose: 1 });
  // 只和一个人打、胜多于负：TA 是福星，不会同时是苦主
  const one = CA.career([mk('2026-01-01', 'a'), mk('2026-01-02', 'a'), mk('2026-01-03', 'b'), mk('2026-01-04', 'b'), mk('2026-01-05', 'a')], 'ua', 'A', []);
  assert.strictEqual(one.nemesis, null);
  assert.strictEqual(one.prey.name, 'B');
  const v = PV.playerView({ ua: { name: 'A' }, ub: { name: 'B' } }, [{ name: 'A', uid: 'ua' }, { name: 'B', uid: 'ub' }], ms, 'ua');
  assert.deepStrictEqual(v.relations.map((x) => [x.l, x.none ? '' : x.name, x.rec || '', x.uid || '']),
    [['苦主', 'B', '1胜 2负', 'ub'], ['福星', 'C', '3胜 1负', ''], ['最佳拍档', '', '', '']]);
  assert.strictEqual(PV.relationsView(null, null, null, {}), null);
});

test('比赛亮点标签：爆冷、逆转、终结连胜、抢七、送蛋；弃权没有标签；和生涯徽章同一组判断', () => {
  const H = require('../utils/highlight');
  const R = require('../utils/rating');
  const ms = [
    mk('2026-03-01', 'a'), mk('2026-03-02', 'a'), mk('2026-03-03', 'a'), // A 三连胜
    mk('2026-03-04', 'b', { sets: [{ a: 4, b: 2 }, { a: 3, b: 4, tbA: 3, tbB: 7 }, { a: 0, b: 4 }] }), // B 逆转、抢七、送蛋，终结 A 的 3 连胜
    mk('2026-03-05', 'a', { outcome: 'walkover', sets: [] }),
  ].concat(settled(), [mk('2026-03-06', 'a', { a: ['E'], aKeys: ['ue'], b: ['F'], bKeys: ['uf'] })]); // E（约 2.5）赢 F（约 3.2）：爆冷
  const last = ms[ms.length - 1];
  const rt = R.computeRatings(ms, { ue: 2.5, ug: 2.5, uf: 3.2, uh: 3.2 });
  const tags = H.matchTags(ms, rt);
  assert.deepStrictEqual(Object.keys(tags).sort(), [ms[3]._id, last._id].sort());
  assert.deepStrictEqual(tags[ms[3]._id].map((t) => t.t), ['逆转', '终结 3 连胜', '抢七', '送蛋']);
  assert.deepStrictEqual(tags[last._id].map((t) => [t.k, t.t, t.cls]), [['upset', '爆冷', 'solid']]);
  // 徽章数的是同样的事
  const b = CA.career(ms, 'ub', 'B', [], rt.pre);
  assert.deepStrictEqual([b.comebacks, b.tbWins, b.bagels, b.upsets], [1, 1, 1, 0]);
  assert.strictEqual(CA.career(ms, 'ue', 'E', [], rt.pre).upsets, 1);
  // 球员主页的比赛行和交手记录带上标签
  const prof = { ua: { name: 'A' }, ub: { name: 'B' } }, players = [{ name: 'A', uid: 'ua' }, { name: 'B', uid: 'ub' }];
  const v = PV.playerView(prof, players, ms, 'ua');
  assert.deepStrictEqual(v.rows.find((r) => r.id === ms[3]._id).tags.map((t) => t.k), ['comeback', 'stop', 'tb', 'bagel']);
  assert.deepStrictEqual(v.rows.find((r) => r.id === ms[0]._id).tags, []);
  assert.strictEqual(PV.h2hView(ms, 'ub', 'B', 'ua', 'A', v.tagsOf).rows.find((r) => r.id === ms[3]._id).tags.length, 4);
});

test('待办的下一场：排过的场次用单场安排的时间和场地，没排的沿用活动的', () => {
  const { nextMatches } = require('../utils/todo');
  const ents = ['A', 'B', 'C', 'D'];
  const d = { _id: 'd1', title: '周末赛', status: 'drawn', type: 'single', mode: 'groups', groupCount: 1, date: '2026-11-21', startTime: '09:00', venue: '1 号场',
    entrants: ents, groups: [{ name: 'A 组', members: ents.map((x) => ({ name: x })) }], uidOf: { A: 'ua', B: 'ub' }, slots: {} };
  const first = nextMatches([d], [], 'ua', []);
  assert.strictEqual(first.length, 3);
  assert.ok(first.every((x) => x.when === '11月21日 周六 09:00' && x.venue === '1 号场' && x.title === '周末赛'));
  d.slots[first[2].key] = { date: '2026-11-20', time: '19:30', court: '2 号场' };
  d.slots[first[1].key] = { date: '2026-11-22', time: '', court: '' };
  const next = nextMatches([d], [], 'ua', []);
  assert.strictEqual(next[0].key, first[2].key); // 排得更早的排在前面
  assert.strictEqual(next[0].when, '11月20日 周五 19:30');
  assert.strictEqual(next[0].venue, '2 号场');
  assert.strictEqual(next[2].when, '11月22日 周日'); // 只改了日期：不沿用活动的开始时间
});

test('阶段名：新记录叫「最后一轮 / N 强」，旧记录的「决赛 / 半决赛 / 淘汰赛 / 小组赛」只在展示时换叫法，冠军照常认定', () => {
  const D = require('../utils/draw'), EV = require('../utils/event');
  assert.deepStrictEqual([2, 4, 8, 16].map(D.roundName), ['最后一轮', '4 强', '8 强', '16 强']);
  assert.deepStrictEqual(['决赛', '淘汰赛 · 半决赛', '淘汰赛 · 1/4 决赛', '小组赛', 'A 组 · 第 1 轮', '16 强'].map(EV.stageText),
    ['最后一轮', '单淘汰 · 4 强', '单淘汰 · 8 强', '分组循环', 'A 组 · 第 1 轮', '16 强']);
  const old = { _id: 'm', drawId: 'd', drawTitle: '春季赛', stage: '淘汰赛 · 决赛', a: ['A'], b: ['B'] };
  assert.strictEqual(EV.publicMatch(old).stage, '单淘汰 · 最后一轮');
  assert.strictEqual(old.stage, '淘汰赛 · 决赛', '原记录不动');
  const mk = (stage) => ({ _id: 'x' + stage, drawId: 'd1', drawTitle: '春季赛', stage, date: '2026-05-01', type: 'single', a: ['甲'], b: ['乙'], aIds: ['u1'], bIds: ['u2'], winner: 'a', sets: [{ a: 4, b: 1 }] });
  for (const stage of ['决赛', '淘汰赛 · 决赛', '最后一轮', '单淘汰 · 最后一轮']) assert.strictEqual(CA.career([mk(stage)], 'u1', '甲').titles.length, 1, stage);
  for (const stage of ['半决赛', '4 强', '单淘汰 · 4 强']) assert.strictEqual(CA.career([mk(stage)], 'u1', '甲').titles.length, 0, stage);
});

module.exports = T;
