// 「本场未计入水平分」（弃权、退赛、成绩取消、轮空）和活动详情的「退赛／弃权」筛选（utils/withdraw-view.js）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const E = require('../utils/event');
const R = require('../utils/rating');
const WV = require('../utils/withdraw-view');

const T = [];
const test = (name, fn) => T.push({ name, fn });
const plain = (v) => JSON.parse(JSON.stringify(v));
const read = (f) => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
const rec = (drawId, drawKey, ea, eb, winner, extra) => Object.assign({ _id: drawId + drawKey, drawId, drawKey, ea, eb, winner: winner || 'a', sets: [{ a: 6, b: 3 }], createdAt: 1, outcome: 'normal' }, extra);
const view = (d, matches, mine) => WV.withdrawView(E.publicDraw(d), E.scheduleOf(E.publicDraw(d), matches), mine);

test('本场未计入水平分：弃权、中途退赛、成绩取消、轮空各有一句说明，水平分确实不算这些场次', () => {
  ['walkover', 'retired', 'void', 'bye'].forEach((k) => {
    const u = R.unratedOf(k);
    assert.strictEqual(u.title, '本场未计入水平分');
    assert.ok(/不计入水平分/.test(u.text), k);
  });
  assert.strictEqual(R.unratedOf('normal'), null);
  // 和 computeRatings 一致：弃权、中途退赛不进 explain，水平分不变
  const m = (id, oc, sets) => ({ _id: id, date: '2026-11-20', createdAt: 1, a: ['p'], b: ['q'], aKeys: ['p'], bKeys: ['q'], winner: 'a', sets, outcome: oc });
  const r = R.computeRatings([m('w', 'walkover', []), m('t', 'retired', [{ a: 6, b: 0 }, { a: 2, b: 0 }])], { p: 3, q: 3 });
  assert.deepStrictEqual(Object.keys(r.explain), []);
  assert.ok(!r.players.p || r.players.p.rating === 3, '水平分不变');
  // 活动录分页（弃权 / 退赛场次）和对阵表的轮空提示用同一套说明
  assert.ok(/RT\.unratedOf\(f\.outcome\)/.test(read('pages/score/score.js')) && /unrated\.title/.test(read('pages/score/score.wxml')));
  assert.ok(/R\.unratedOf\('bye'\)/.test(read('components/draw-board/draw-board.js')));
});

test('退赛／弃权：单淘汰退赛 → 退赛名单 + 判弃权的那场 + 对手进入下一轮；不带原因', () => {
  const d = {
    _id: 's1', title: '周六单打', mode: 'bracket', size: 4, status: 'drawn', date: '2026-11-22',
    entrants: ['小明', '阿杰', '小周', '小林'], lines: [{ name: '小明' }, { name: '阿杰' }, { name: '小周' }, { name: '小林' }],
    withdrawals: [{ entrant: '阿杰', stage: 'ko', policy: 'walkover', reason: '私人原因', by: 'owner', at: 1 }],
  };
  const v = view(d, [rec('s1', '0-1', '小周', '小林', 'b', { outcome: 'retired', sets: [{ a: 3, b: 2 }] })], (n) => n === '小明');
  assert.strictEqual(v.entrants.length, 1);
  assert.deepStrictEqual(plain(v.entrants[0]), { entrant: '阿杰', status: '已退赛', stage: '单淘汰阶段', policy: '下一场对手弃权胜，进入下一轮', count: 1, mine: false });
  assert.strictEqual(v.rows.length, 2);
  const [wo, rt] = v.rows;
  assert.strictEqual(wo.key, '0-0'); assert.strictEqual(wo.kind, 'walkover');
  assert.strictEqual(wo.status, '阿杰 退赛，判弃权'); assert.strictEqual(wo.winner, 'a');
  assert.strictEqual(wo.impact, '小明 进入下一轮：最后一轮 对 小林');
  assert.strictEqual(wo.unrated, '本场未计入水平分');
  assert.strictEqual(rt.status, '小周 中途退赛'); assert.strictEqual(rt.impact, '小林 进入下一轮：最后一轮 对 小明');
  assert.strictEqual(v.count, 3);
  assert.ok(!/私人原因/.test(JSON.stringify(v)), '不显示退赛原因');
  // 下一轮对手还没出来：写「对手待定」
  const v2 = view(d, [], () => false);
  assert.strictEqual(v2.rows.find((x) => x.key === '0-0').impact, '小明 进入下一轮：最后一轮，对手待定');
  const v4 = view(d, [rec('s1', '0-1', '小周', '小林', 'a', { outcome: 'walkover', sets: [] })], () => false);
  assert.strictEqual(v4.rows.find((x) => x.key === '0-0').impact, '小明 进入下一轮：最后一轮 对 小周');
  assert.strictEqual(v4.rows.find((x) => x.key === '0-1').status, '小林 弃权', '没有登记退赛的弃权就写「弃权」');
  // 最后一轮的弃权
  const v3 = view(d, [rec('s1', '0-1', '小周', '小林', 'a'), rec('s1', '1-0', '小明', '小周', 'b', { outcome: 'walkover', sets: [] })], () => false);
  assert.strictEqual(v3.rows.find((x) => x.key === '1-0').impact, '小周 赢下最后一轮');
  // 赛果和积分规则不变：筛选只读赛程，赛程本身和不调用时一样
  assert.deepStrictEqual(plain(E.scheduleOf(E.publicDraw(d), [])), plain(E.scheduleOf(E.publicDraw(d), [])));
  assert.strictEqual(WV.nextKey('k0-3'), 'k1-1'); assert.strictEqual(WV.nextKey('g0-1-2'), '');
});

test('退赛／弃权：分组循环两种处理方式（判弃权 / 成绩取消）的状态和积分榜影响；没有退赛弃权时为空', () => {
  const g = {
    _id: 'g1', title: '循环', mode: 'groups', groupCount: 1, status: 'drawn', date: '2026-11-22',
    entrants: ['甲', '乙', '丙'], groups: [{ name: 'A 组', members: [{ name: '甲' }, { name: '乙' }, { name: '丙' }] }],
  };
  assert.deepStrictEqual(plain(view(g, [], () => false)), { entrants: [], rows: [], count: 0 });
  const keyOf = (a, b) => E.scheduleOf(g, []).find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a));
  const k = keyOf('乙', '丙');
  // 乙退赛、判弃权：云函数把没打的场次写成弃权记录（resolution.type = withdraw）
  const wo = Object.assign({}, g, { withdrawals: [{ entrant: '乙', stage: 'group', policy: 'walkover' }] });
  const loser = k.a === '乙' ? 'a' : 'b';
  const v = view(wo, [rec('g1', k.key, k.a, k.b, loser === 'a' ? 'b' : 'a', { outcome: 'walkover', sets: [], resolution: { type: 'withdraw', side: loser } })], () => false);
  assert.strictEqual(v.entrants[0].stage, '分组循环阶段');
  assert.ok(/没打的场次判对手弃权胜/.test(v.entrants[0].policy));
  assert.strictEqual(v.rows.length, 1);
  assert.strictEqual(v.rows[0].status, '乙 退赛，判弃权');
  assert.strictEqual(v.rows[0].impact, '积分榜上 丙 记胜、乙 记负（弃权），不算盘分和局分');
  // 丙退赛、成绩取消：TA 的场次都取消（含已打的），不能点进去录分
  const vd = Object.assign({}, g, { withdrawals: [{ entrant: '丙', stage: 'group', policy: 'void' }] });
  const k2 = keyOf('甲', '丙');
  const v2 = view(vd, [rec('g1', k2.key, k2.a, k2.b, 'a')], (n) => n === '丙');
  assert.strictEqual(v2.rows.length, 2);
  v2.rows.forEach((r) => {
    assert.strictEqual(r.kind, 'void'); assert.strictEqual(r.status, '丙 退赛，成绩取消');
    assert.strictEqual(r.impact, '这场成绩取消，不计入积分榜'); assert.strictEqual(r.winner, ''); assert.strictEqual(r.ready, false);
  });
  assert.strictEqual(v2.entrants[0].mine, true);
  assert.strictEqual(v2.entrants[0].count, 2);
});

test('活动详情页：场次里有「全部场次 / 退赛／弃权」两档，和「只看我的」一起用；不新增伤病之类的字段、不显示原因', () => {
  const js = read('pages/draw-view/draw-view.js'), xml = read('pages/draw-view/draw-view.wxml'), wv = read('utils/withdraw-view.js');
  assert.ok(/WV\.withdrawView\(d, items/.test(js), '和场次列表同一份数据');
  assert.ok(/data-v="wd" bindtap="setSchFilter">退赛／弃权/.test(xml));
  assert.ok(/schFilter === 'wd'/.test(xml));
  assert.ok(/only \? wv\.entrants\.filter/.test(js), '只看我的也生效');
  assert.ok(!/reason/.test(xml.slice(xml.indexOf('退赛／弃权：现有'), xml.indexOf('<block wx:else>', xml.indexOf('退赛／弃权：现有')))), '筛选里不显示原因');
  assert.ok(!/伤|injur/i.test(js + xml + wv), '没有伤病字段');
  assert.ok(!/require\('\.\/(db|cloud)'\)/.test(wv), '只整理现有数据，不另外读写');
});

module.exports = T;
