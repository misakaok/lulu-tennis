// 体积与性能（阶段一）：打包忽略、球员主页不把全部比赛交给渲染层、活动首页分页、水平分 / 统计按共享数组只算一次
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

const T = [];
const test = (name, fn) => T.push({ name, fn });
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const R = require('../utils/rating');
const S = require('../utils/stats');
const PV = require('../utils/player');
const ID = require('../utils/ident');

function loadDef(file, deps, wx) {
  const filename = path.join(ROOT, file);
  let def;
  vm.runInNewContext(read(file), {
    require: (id) => (deps && deps[id]) || createRequire(filename)(id), wx: wx || {}, console, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    Page: (d) => { def = d; }, Component: (d) => { def = d; }, getCurrentPages: () => [],
  });
  return def;
}
const host = (def, data, methods) => Object.assign({}, methods || def, {
  data: Object.assign(JSON.parse(JSON.stringify(def.data)), data || {}),
  setData(o) { (this.sets = this.sets || []).push(o); Object.assign(this.data, o); },
});

// 几位球员、几十场正式比赛（按用户 ID）
function fixture(n) {
  const people = [['alice', 'Alice'], ['bob', 'Bob'], ['carl', 'Carl'], ['dora', 'Dora']];
  const players = people.map(([uid, name], i) => ({ uid, name, self: true, shown: i !== 3, gender: i % 2 ? 'f' : 'm', level: 3 }));
  const raw = [];
  for (let i = 0; i < n; i++) {
    const x = people[i % 4], y = people[(i + 1 + (i % 3)) % 4];
    if (x === y) continue;
    raw.push({ _id: 'm' + i, type: 'single', a: [x[1]], b: [y[1]], aIds: [x[0]], bIds: [y[0]], winner: i % 3 ? 'a' : 'b', sets: [{ a: 6, b: i % 5 }], date: '2026-' + String(1 + (i % 11)).padStart(2, '0') + '-1' + (i % 9), createdAt: i });
  }
  return { players, matches: ID.normalizeMatches(raw, players) };
}
const profilesOf = (players) => { const o = {}; players.forEach((p) => { o[p.uid] = p; }); return o; };

test('打包忽略 .claude 目录（本机的 Claude 设置不进小程序包）', () => {
  const cfg = JSON.parse(read('project.config.json'));
  assert.ok(cfg.packOptions.ignore.some((x) => x.type === 'folder' && x.value === '.claude'));
});

test('球员主页：渲染层只拿最近 5 场和总场数，全部比赛（rows）不随 view 传过去，逻辑层仍保留', async () => {
  const { players, matches } = fixture(30);
  const profiles = profilesOf(players);
  const def = loadDef('components/player-home/player-home.js', {
    '../../utils/db': { cachedMatchesOrNull: () => null, cachedProfiles: () => ({}), cachedPlayersFull: () => [], playersShared: async () => players, matchesShared: async () => matches, myOpenid: async () => 'alice', profilesOf: () => profiles },
  });
  const c = host(def, { uid: 'alice', mine: true }, def.methods);
  await c.load();
  const v = c.sets.map((o) => o.view).filter(Boolean).pop();
  assert.ok(v && v.profile, '画出了球员卡');
  assert.ok(!('rows' in v), 'view 里没有全部比赛');
  assert.ok(c.view.rows.length > 5, '逻辑层还在');
  assert.strictEqual(c.data.total, c.view.rows.length);
  assert.deepStrictEqual(c.data.recent.map((x) => x.id), c.view.rows.slice(0, 5).map((x) => x.id));
  assert.ok(c.sets.every((o) => !o.view || !('rows' in o.view)));
  assert.match(read('components/player-home/player-home.wxml'), /wx:for="\{\{recent\}\}"/);
  assert.ok(!/view\.rows/.test(read('components/player-home/player-home.wxml')));
});

test('活动首页：每次显示 30 个，滑到底再加 30 个；数据刷新保持已加载的个数，切换选项卡从头开始', () => {
  const def = loadDef('pages/draw/draw.js', { '../../utils/db': {} });
  const p = host(def);
  p.list = Array.from({ length: 70 }, (_, i) => ({ _id: 'd' + i, mine: i % 2 === 0 }));
  p.apply();
  assert.deepStrictEqual([p.data.shown.length, p.data.more], [30, true]);
  assert.strictEqual(p.data.shown[0]._id, 'd0');
  p.onReachBottom();
  assert.deepStrictEqual([p.data.shown.length, p.data.more], [60, true]);
  p.apply(); // 录分 / 报名后回来重新整理：不缩回 30 个
  assert.strictEqual(p.data.shown.length, 60);
  p.onReachBottom();
  assert.deepStrictEqual([p.data.shown.length, p.data.more], [70, false]);
  p.onReachBottom();
  assert.strictEqual(p.data.shown.length, 70);
  p.setTab({ currentTarget: { dataset: { v: 'mine' } } }); // 我的活动：35 个
  assert.deepStrictEqual([p.data.shown.length, p.data.more], [30, true]);
  assert.ok(p.data.shown.every((x) => x.mine));
  p.onReachBottom();
  assert.deepStrictEqual([p.data.shown.length, p.data.more], [35, false]);
  p.setTab({ currentTarget: { dataset: { v: 'next' } } });
  assert.deepStrictEqual([p.data.shown.length, p.data.more], [0, false]);
  p.setTab({ currentTarget: { dataset: { v: 'all' } } });
  assert.strictEqual(p.data.shown.length, 30);
  // 朋友圈单页模式不加载
  p.timeline = true; p.onReachBottom(); assert.strictEqual(p.data.shown.length, 30);
  assert.match(read('pages/draw/draw.wxml'), /wx:if="\{\{more && tab !== 'next'\}\}" class="d-more">上滑加载更多/);
});

test('水平分 / 统计：同一组共享数组只算一次；换了数组、数组长度变了马上重算；结果和不缓存完全一样', () => {
  const { players, matches } = fixture(60);
  const profiles = profilesOf(players);
  const r1 = R.ratingsOf(matches, players);
  assert.strictEqual(R.ratingsOf(matches, players), r1, '同一组数组：直接用上次的结果');
  assert.deepStrictEqual(r1, R.computeRatings(matches, R.startLevelsFrom(players)));
  const s1 = S.playerStats(matches, players, profiles);
  assert.strictEqual(S.playerStats(matches, players, profiles), s1);
  assert.strictEqual(s1.ratings, r1, '统计和排行榜共用同一次水平分计算');
  // 不传 profiles、换 profiles：分开缓存（名次口径不同）
  const s2 = S.playerStats(matches, players);
  assert.notStrictEqual(s2, s1);
  assert.strictEqual(s2.ratings, r1);
  // 换了数组：重算，结果和直接算一样
  const m2 = matches.slice(0, 40);
  const r2 = R.ratingsOf(m2, players);
  assert.notStrictEqual(r2, r1);
  assert.deepStrictEqual(r2, R.computeRatings(m2, R.startLevelsFrom(players)));
  const p2 = players.map((x) => Object.assign({}, x, { level: 4 }));
  assert.notStrictEqual(R.ratingsOf(matches, p2), r1);
  assert.deepStrictEqual(R.ratingsOf(matches, p2), R.computeRatings(matches, R.startLevelsFrom(p2)));
  // 同一个数组里加了记录（复制版被改了）：长度不同就重算
  const mut = matches.slice();
  const before = S.playerStats(mut, players, profiles);
  mut.push(Object.assign({}, matches[0], { _id: 'extra' }));
  const after = S.playerStats(mut, players, profiles);
  assert.notStrictEqual(after, before);
  assert.strictEqual(after.map.alice.played + after.map.bob.played, before.map.alice.played + before.map.bob.played + 2, "第一场是 Alice 对 Bob，两人各多一场");
  // 没有数组（null）：照常算，不缓存
  assert.strictEqual(S.playerStats(null, null).total, 0);
});

test('共享的统计结果只读：球员主页、报名名单、排行榜都用过之后结果不变，再用一次和第一次一样', () => {
  const { players, matches } = fixture(60);
  const profiles = profilesOf(players);
  const st = S.playerStats(matches, players, profiles);
  const snap = JSON.stringify(st);
  const v1 = JSON.stringify(PV.playerView(profiles, players, matches, 'alice'));
  PV.playerView(profiles, players, matches, 'bob');
  players.forEach((p) => S.display(st, p.name, p, p.uid));
  // 排行页：按水平 / 本月进步 / 连胜各画一遍
  const def = loadDef('pages/rank/rank.js', { '../../utils/db': { profilesOf: () => profiles } });
  const rank = host(def);
  rank.setSource(matches, players, 'alice');
  assert.strictEqual(rank.ratings, st.ratings, '排行榜和球员主页共用同一次水平分计算');
  ['level', 'win', 'active', 'streak', 'gain'].forEach((sort) => { rank.data.sort = sort; rank.render(); });
  assert.strictEqual(JSON.stringify(st), snap, '缓存的结果没被改动');
  assert.strictEqual(JSON.stringify(PV.playerView(profiles, players, matches, 'alice')), v1);
});

module.exports = T;
