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

test('待办的下一场：排过的场次用单场安排的时间和场地，没排的沿用赛事的', () => {
  const { nextMatches } = require('../utils/todo');
  const ents = ['A', 'B', 'C', 'D'];
  const d = { _id: 'd1', title: '周末赛', status: 'drawn', type: 'single', mode: 'groups', groupCount: 1, date: '2026-11-21', startTime: '09:00', venue: '网球中心',
    entrants: ents, groups: [{ name: 'A 组', members: ents.map((x) => ({ name: x })) }], uidOf: { A: 'ua', B: 'ub' }, slots: {} };
  const first = nextMatches([d], [], 'ua', []);
  assert.strictEqual(first.length, 3);
  assert.ok(first.every((x) => x.when === '11月21日 周六 09:00' && x.venue === '网球中心'));
  d.slots[first[2].key] = { date: '2026-11-20', time: '19:30', court: '2 号场' };
  d.slots[first[1].key] = { date: '2026-11-22', time: '', court: '' };
  const next = nextMatches([d], [], 'ua', []);
  assert.strictEqual(next[0].key, first[2].key); // 排得更早的排在前面
  assert.strictEqual(next[0].when, '11月20日 周五 19:30');
  assert.strictEqual(next[0].venue, '网球中心 · 2 号场');
  assert.strictEqual(next[2].when, '11月22日 周日'); // 只改了日期：不沿用赛事的开始时间
});

module.exports = T;
