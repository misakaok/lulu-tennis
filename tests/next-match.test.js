// 活动首页「我的下一场」：选场次、排序、显示，以及首页三个选项卡和详情页定位
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const NX = require('../utils/next-match');
const T = [];
const test = (name, fn) => T.push({ name, fn });
const plain = (v) => JSON.parse(JSON.stringify(v));
const day = (n) => NX.todayOf(new Date(Date.now() + n * 864e5));
const TODAY = day(0);
const rec = (drawId, drawKey, ea, eb, winner, extra) => Object.assign({ _id: drawId + drawKey, drawId, drawKey, ea, eb, winner: winner || 'a', sets: [{ a: 6, b: 3 }], createdAt: 1 }, extra);

function load(file, wx, deps) {
  const filename = path.resolve(__dirname, '..', file);
  let def;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (id) => (deps && deps[id]) || createRequire(filename)(id), wx, Page: (d) => { def = d; }, setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {}, console,
  });
  return Object.assign({}, def, {
    data: plain(def.data),
    setData(p) { Object.keys(p).forEach((k) => { this.data[k] = p[k]; }); },
  });
}

// 单打单淘汰 4 人：我（小明，ID me）第一场对阿杰
const single = (extra) => Object.assign({
  _id: 's1', title: '周六单打', mode: 'bracket', size: 4, status: 'drawn', date: TODAY, startTime: '14:00', venue: '',
  entrants: ['小明', '阿杰', '小周', '小林'], lines: [{ name: '小明' }, { name: '阿杰' }, { name: '小周' }, { name: '小林' }],
  uidOf: { 小明: 'me', 阿杰: 'jie', 小周: 'zhou', 小林: 'lin' },
}, extra);

test('单打：显示活动名、轮次、日期、单场时间和场号、对手；单场安排优先', () => {
  const n = NX.nextMatch([single({ slots: { '0-0': { date: TODAY, time: '15:20', court: '3 号场' } } })], [], 'me', [], TODAY);
  assert.strictEqual(n.drawId, 's1'); assert.strictEqual(n.key, '0-0');
  assert.strictEqual(n.title, '周六单打'); assert.strictEqual(n.stage, '4 强');
  assert.strictEqual(n.time, '15:20'); assert.strictEqual(n.court, '3 号场'); assert.strictEqual(n.note, '');
  assert.ok(n.dateText && n.dateText !== '日期待定');
  assert.strictEqual(n.opponent, '阿杰'); assert.strictEqual(n.oppTbd, false); assert.strictEqual(n.double, false); assert.strictEqual(n.partner, '');
  assert.deepStrictEqual(plain(n.oppP), [{ name: '阿杰', uid: 'jie' }]);
});

test('只有活动开始时间：不当成本场开打时间；场地缺失显示「场地待定」，有活动场地就沿用', () => {
  let n = NX.nextMatch([single()], [], 'me', [], TODAY);
  assert.strictEqual(n.time, ''); assert.strictEqual(n.note, '活动 14:00 开始 · 本场时间待定'); assert.strictEqual(n.court, '场地待定');
  n = NX.nextMatch([single({ venue: '5 号场', startTime: '' })], [], 'me', [], TODAY);
  assert.strictEqual(n.note, '本场时间待定'); assert.strictEqual(n.court, '5 号场');
  // 改到别的日子但没定时间：不提活动的集合时间
  n = NX.nextMatch([single({ slots: { '0-0': { date: day(3), time: '', court: '' } } })], [], 'me', [], TODAY);
  assert.strictEqual(n.note, '本场时间待定');
  // 没有日期
  n = NX.nextMatch([single({ date: '' })], [], 'me', [], TODAY);
  assert.strictEqual(n.dateText, '日期待定');
});

test('双打被搭档带报名、改过昵称：按用户 ID 认出我，显示搭档和对手', () => {
  const d = {
    _id: 'd2', title: '周六双打', mode: 'bracket', size: 2, type: 'double', status: 'drawn', date: TODAY,
    entrants: ['小林 / 阿明', '阿杰 / 小周'], teams: { '小林 / 阿明': ['小林', '阿明'], '阿杰 / 小周': ['阿杰', '小周'] },
    lines: [{ name: '阿杰 / 小周' }, { name: '小林 / 阿明' }],
    uidOf: { 小林: 'lin', 阿杰: 'jie', 小周: 'zhou' }, // 签表快照里没有我
  };
  // 没有报名记录：认不出来
  assert.strictEqual(NX.nextMatch([d], [], 'me', [], TODAY), null);
  // 小林报名时带上我（我现在的昵称已经不叫阿明了，按 ID 认）
  const su = [{ drawId: 'd2', _openid: 'lin', name: '小林', partner: '阿明', partnerId: 'me' }];
  const n = NX.nextMatch([d], [], 'me', su, TODAY);
  assert.strictEqual(n.double, true); assert.strictEqual(n.partner, '小林'); assert.strictEqual(n.opponent, '阿杰 / 小周');
  assert.deepStrictEqual(plain(n.partnerP), [{ name: '小林', uid: 'lin' }]);
  assert.strictEqual(n.stage, '最后一轮');
  // 别人的报名记录不会把我认成别人
  assert.strictEqual(NX.nextMatch([d], [], 'jie', su, TODAY).partner, '小周');
});

test('对手待定：我已确定在一方、对手还没出来；「A 组第 1」占位不算成我的场次', () => {
  // 第一场我对阿杰已录分我胜，另一场还没打：下一场对手待定
  const n = NX.nextMatch([single()], [rec('s1', '0-0', '小明', '阿杰', 'a')], 'me', [], TODAY);
  assert.strictEqual(n.key, '1-0'); assert.strictEqual(n.stage, '最后一轮');
  assert.strictEqual(n.opponent, '待定'); assert.strictEqual(n.oppTbd, true); assert.deepStrictEqual(plain(n.oppP), []);
  // 循环＋淘汰：我小组里的场次都打完了，但小组还没结束，下一轮只有「A 组第 1」这类占位 → 没有下一场
  const g = {
    _id: 'g1', title: '循环', mode: 'groups_ko', groupCount: 2, advance: 1, status: 'drawn', date: TODAY,
    entrants: ['小明', '阿杰', '小周', '小林', '小王', '小李'],
    groups: [{ name: 'A 组', members: [{ name: '小明' }, { name: '阿杰' }, { name: '小周' }] }, { name: 'B 组', members: [{ name: '小林' }, { name: '小王' }, { name: '小李' }] }],
    uidOf: { 小明: 'me', 阿杰: 'jie', 小周: 'zhou' },
  };
  const E = require('../utils/event');
  const mineKeys = E.scheduleOf(g, []).filter((x) => x.a === '小明' || x.b === '小明').map((x) => [x.key, x.a, x.b]);
  assert.strictEqual(mineKeys.length, 2);
  const ms = mineKeys.map(([k, a, b]) => rec('g1', k, a, b, a === '小明' ? 'a' : 'b'));
  assert.strictEqual(NX.nextMatch([g], ms, 'me', [], TODAY), null);
});

test('已录分、弃权、退赛结算的场次跳过；我已退赛的活动不显示', () => {
  assert.strictEqual(NX.nextMatch([single({ size: 2, lines: [{ name: '小明' }, { name: '阿杰' }] })], [rec('s1', '0-0', '小明', '阿杰', 'b', { outcome: 'walkover' })], 'me', [], TODAY), null);
  // 对手退赛：这场判我弃权胜（虚拟结果），下一场对手待定
  const n = NX.nextMatch([single({ withdrawals: [{ entrant: '阿杰', stage: 'ko' }] })], [], 'me', [], TODAY);
  assert.strictEqual(n.key, '1-0'); assert.strictEqual(n.opponent, '待定');
  // 我退赛了：下一轮对手还没出来时也不再显示
  assert.strictEqual(NX.nextMatch([single({ withdrawals: [{ entrant: '小明', stage: 'ko' }] })], [rec('s1', '0-0', '小明', '阿杰', 'a')], 'me', [], TODAY), null);
  // 报名中的活动、没有我的活动都不算
  assert.strictEqual(NX.nextMatch([single({ status: 'signup' })], [], 'me', [], TODAY), null);
  assert.strictEqual(NX.nextMatch([single()], [], 'nobody', [], TODAY), null);
  assert.strictEqual(NX.nextMatch([single()], [], '', [], TODAY), null);
});

test('跨活动排序：有时间的按时间 → 同一天时间待定在后 → 日期待定最后；昨天的未录分场次不显示，今天已过时间的照常显示', () => {
  const mk = (id, date, time, startTime) => single({ _id: id, title: id, date, startTime: startTime || '', slots: time ? { '0-0': { date, time, court: '' } } : {} });
  const order = [
    mk('old', day(-1), '09:00'), // 昨天没录分：不显示
    mk('t-early', TODAY, '00:01'), // 今天已经过了预定时间但还没录分：照常显示
    mk('t-late', TODAY, '18:00'),
    mk('t-tbd-b', TODAY, '', '19:00'),
    mk('t-tbd-a', TODAY, '', '10:00'),
    mk('tomorrow', day(1), '08:00'),
    mk('nodate', '', ''),
  ];
  const draws = order.slice().reverse(); // 活动列表顺序和时间无关
  const seen = [];
  let left = draws;
  for (;;) {
    const n = NX.nextMatch(left, [], 'me', [], TODAY);
    if (!n) break;
    seen.push(n.drawId);
    left = left.filter((d) => d._id !== n.drawId);
  }
  assert.deepStrictEqual(seen, ['t-early', 't-late', 't-tbd-a', 't-tbd-b', 'tomorrow', 'nodate']);
});

test('同一活动同一优先级按现有场次顺序；录完一场切到下一场', () => {
  const g = {
    _id: 'g2', title: '分组', mode: 'groups', groupCount: 1, status: 'drawn', date: TODAY,
    entrants: ['小明', '阿杰', '小周', '小林'], groups: [{ name: 'A 组', members: [{ name: '小明' }, { name: '阿杰' }, { name: '小周' }, { name: '小林' }] }],
    uidOf: { 小明: 'me' },
  };
  const E = require('../utils/event');
  const mine = E.scheduleOf(g, []).filter((x) => x.a === '小明' || x.b === '小明');
  assert.strictEqual(mine.length, 3);
  const ms = [];
  mine.forEach((x) => {
    const n = NX.nextMatch([g], ms, 'me', [], TODAY);
    assert.strictEqual(n.key, x.key); assert.strictEqual(n.stage, x.stage);
    ms.push(rec('g2', x.key, x.a, x.b));
  });
  assert.strictEqual(NX.nextMatch([g], ms, 'me', [], TODAY), null);
});

test('不修改传进来的共享数据', () => {
  const draws = [single({ slots: { '0-0': { date: TODAY, time: '15:20', court: '3 号场' } } })];
  const ms = [rec('s1', '0-1', '小周', '小林')];
  const su = [{ drawId: 's1', _openid: 'me', name: '小明' }];
  const before = JSON.stringify([draws, ms, su]);
  NX.nextMatch(draws, ms, 'me', su, TODAY);
  assert.strictEqual(JSON.stringify([draws, ms, su]), before);
});

/* ---------- 活动首页 ---------- */
function homePage(state) {
  const fail = (k, v) => async () => { if (state.offline && state.offline[k]) throw new Error('网络异常'); return v(); };
  const p = load('pages/draw/draw.js', { showToast() {}, navigateTo(o) { state.nav = o.url; }, stopPullDownRefresh() {} }, {
    '../../utils/member': { statusCached: async () => ({ status: 'active', isAdmin: false }) },
    '../../utils/db': {
      cachedDraws: () => [], cachedMatches: () => state.cachedMatches || [], withoutRemoved: (x) => x, recentRemoved: () => null,
      drawsShared: fail('draws', () => state.draws), matchesShared: fail('matches', () => state.matches),
      myOpenid: fail('me', () => 'me'), fetchMySignups: fail('signups', () => state.signups || []),
    },
  });
  return p;
}

test('活动首页：三个选项卡「全部活动 / 我的活动 / 我的下一场」，默认全部活动，可以来回切换；日历已移除', async () => {
  const other = { _id: 'x', title: '别人的', mode: 'bracket', size: 2, status: 'drawn', date: TODAY, entrants: ['甲', '乙'], lines: [{ name: '甲' }, { name: '乙' }], uidOf: { 甲: 'a', 乙: 'b' } };
  const state = { draws: [single(), other], matches: [] };
  const p = homePage(state);
  await p.load();
  assert.strictEqual(p.data.tab, 'all');
  assert.deepStrictEqual(p.data.shown.map((x) => x._id), ['s1', 'x']);
  const tap = (v) => p.setTab({ currentTarget: { dataset: { v } } });
  tap('mine'); assert.deepStrictEqual(p.data.shown.map((x) => x._id), ['s1']);
  tap('next'); assert.deepStrictEqual(plain(p.data.shown), []); assert.strictEqual(p.data.next.drawId, 's1');
  tap('all'); assert.strictEqual(p.data.shown.length, 2);
  p.openNext();
  assert.strictEqual(state.nav, '/pages/draw-view/draw-view?id=s1&tab=schedule&key=0-0');

  const xml = fs.readFileSync(path.join(__dirname, '../pages/draw/draw.wxml'), 'utf8');
  const tabs = [...xml.matchAll(/class="seg-item[^"]*" data-v="(\w+)"[^>]*>([^<{]+)/g)].map((m) => [m[1], m[2]]);
  assert.deepStrictEqual(tabs, [['all', '全部活动'], ['mine', '我的活动'], ['next', '我的下一场']]);
  assert.ok(/暂无下一场/.test(xml) && /查看场次 ›/.test(xml));
  const all = ['js', 'wxml', 'wxss'].map((x) => fs.readFileSync(path.join(__dirname, '../pages/draw/draw.' + x), 'utf8')).join('\n');
  assert.ok(!/日历|cal-|applyCal|calMove|calPick/.test(all));
});

test('活动首页：返回 / 下拉刷新时重算——录分后切到下一场，改时间场地后显示最新，没有场次显示「暂无下一场」', async () => {
  const state = { draws: [single()], matches: [] };
  const p = homePage(state);
  p.setTab({ currentTarget: { dataset: { v: 'next' } } });
  await p.load();
  assert.strictEqual(p.data.next.key, '0-0'); assert.strictEqual(p.data.next.court, '场地待定');
  // 录完这一场：比赛数据换成新数组（写操作会作废缓存），回到首页时 onShow 重新读取
  state.matches = [rec('s1', '0-0', '小明', '阿杰', 'a')];
  p.onShow(); await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(p.data.next.key, '1-0'); assert.strictEqual(p.data.next.opponent, '待定');
  // 另一场也打完：对手出来了
  state.matches = state.matches.concat(rec('s1', '0-1', '小周', '小林', 'b'));
  p.onPullDownRefresh(); await new Promise((r) => setTimeout(r, 0)); // 下拉刷新：作废内存缓存后重新读取
  assert.strictEqual(p.data.next.opponent, '小林');
  // 发起人重新安排时间和场地
  state.draws = [single({ slots: { '1-0': { date: TODAY, time: '16:40', court: '7 号场' } } })];
  await p.load();
  assert.strictEqual(p.data.next.time, '16:40'); assert.strictEqual(p.data.next.court, '7 号场');
  // 最后一场也录了：没有下一场
  state.matches = state.matches.concat(rec('s1', '1-0', '小明', '小林', 'a'));
  await p.load();
  assert.strictEqual(p.data.next, null);
  assert.strictEqual(p.data.tab, 'next'); assert.deepStrictEqual(plain(p.data.shown), []);
});

test('活动详情：从「我的下一场」进来打开「场次」页签并定位到这一场', async () => {
  const scrolled = [];
  const d = single();
  const v = load('pages/draw-view/draw-view.js', { setNavigationBarTitle() {}, pageScrollTo(o) { scrolled.push(o.selector); } }, {
    '../../utils/db': { fetchDrawDetail: async () => ({ draw: d, profile: { name: '小明' }, signups: [] }), matchesShared: async () => [rec('s1', '0-0', '小明', '阿杰', 'a')], myOpenid: async () => 'me', cachedPlayersFull: () => [] },
    '../../utils/member': { isAdminLocal: () => false },
  });
  v.onLoad({ id: 's1', tab: 'schedule', key: '1-0' });
  assert.strictEqual(v.data.tab, 'schedule');
  v.makeCover = () => {}; v.loadRequests = () => {};
  await v.load();
  assert.strictEqual(v.data.focus, '1-0');
  assert.ok(v.data.schedule.some((x) => x.key === '1-0' && x.mine));
  await new Promise((r) => setTimeout(r, 80));
  assert.deepStrictEqual(scrolled, ['#sch-1-0']);
  await v.load(); // 返回本页刷新时不再跳
  await new Promise((r) => setTimeout(r, 80));
  assert.strictEqual(scrolled.length, 1);
  v.onUnload();
  const xml = fs.readFileSync(path.join(__dirname, '../pages/draw-view/draw-view.wxml'), 'utf8');
  assert.ok(/id="sch-\{\{item\.key\}\}"/.test(xml));
});

test('活动首页：断网读不到身份 / 战绩 / 我的报名时，「我的下一场」提示网络异常，不说「暂无下一场」；恢复后提示消失', async () => {
  const state = { draws: [single()], matches: [], offline: { me: true } };
  const p = homePage(state);
  p.setTab({ currentTarget: { dataset: { v: 'next' } } });
  await p.load();
  assert.strictEqual(p.data.next, null); assert.strictEqual(p.data.nextStale, true);
  // 战绩读不到、用了本机缓存：照常算出一场，但标出可能不是最新的
  state.offline = { matches: true };
  await p.load();
  assert.strictEqual(p.data.next.key, '0-0'); assert.strictEqual(p.data.nextStale, true);
  state.offline = null;
  await p.load();
  assert.strictEqual(p.data.nextStale, false);
  // 活动列表也读不到：保留原来显示的，同样提示
  state.offline = { draws: true };
  await p.load();
  assert.strictEqual(p.data.next.key, '0-0'); assert.strictEqual(p.data.nextStale, true);
  const xml = fs.readFileSync(path.join(__dirname, '../pages/draw/draw.wxml'), 'utf8');
  assert.ok(/nextStale \? '网络异常，暂时查不到你的下一场' : '暂无下一场'/.test(xml));
});

module.exports = T;
