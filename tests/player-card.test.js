// 球员主页顶部的「LULU 球员卡」：比赛等级 / 自评等级分开标注、待定级；排名和排行榜一致并遵守公开展示授权
// （报名名单、战绩页「我的」卡片的名次也是同一个口径：S.playerStats 的 boardRank）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const ID = require('../utils/ident');
const PV = require('../utils/player');
const R = require('../utils/rating');
const T = [];
const test = (name, fn) => T.push({ name, fn });
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

const m = (id, a, b, aIds, bIds, winner, date) => ({ _id: id, a, b, aIds, bIds, winner, sets: [{ a: winner === 'a' ? 6 : 2, b: winner === 'a' ? 2 : 6 }], date, createdAt: id.length });
// Ann（同意公开）、Bob（不同意，水平最高）、Cat（同意）、Dan（还没选）、Eve（同意，没有比赛、没填自评）
const players = [
  { name: 'Ann', uid: 'ann', self: true, level: 3, gender: 'f', shown: true },
  { name: 'Bob', uid: 'bob', self: true, level: 4, gender: 'm', shown: false },
  { name: 'Cat', uid: 'cat', self: true, level: 2.5, gender: 'f', shown: true },
  { name: 'Dan', uid: 'dan', self: true, level: 3, gender: 'm' },
  { name: 'Eve', uid: 'eve', self: true, gender: 'f', shown: true },
];
const profiles = {};
players.forEach((p) => { profiles[p.uid] = { uid: p.uid, name: p.name, gender: p.gender, level: typeof p.level === 'number' ? p.level : null, shown: p.shown === true }; });
const raw = [];
for (let i = 0; i < 6; i++) {
  raw.push(m('b' + i, ['Bob'], ['Ann'], ['bob'], ['ann'], 'a', '2026-10-0' + (i + 1)));
  raw.push(m('a' + i, ['Ann'], ['Cat'], ['ann'], ['cat'], i < 5 ? 'a' : 'b', '2026-10-1' + i));
}
raw.push(m('d0', ['Dan'], ['Cat'], ['dan'], ['cat'], 'a', '2026-10-20'));
const ms = ID.normalizeMatches(raw, players);

test('球员卡：比赛等级和自评等级分开标注，没有比赛 / 没填自评的写「待定级」；定级中照常标出', () => {
  const ann = PV.playerView(profiles, players, ms, 'ann');
  const r = R.computeRatings(ms, R.startLevelsFrom(players)).players.ann;
  assert.strictEqual(ann.level.match, R.fmt(r.level));
  assert.strictEqual(ann.level.self, '3.0');
  assert.strictEqual(ann.level.provisional, false);
  const eve = PV.playerView(profiles, players, ms, 'eve');
  assert.strictEqual(eve.level.match, '待定级'); assert.strictEqual(eve.level.self, '待定级'); assert.strictEqual(eve.level.tier, '');
  assert.deepStrictEqual([eve.stats.rank, eve.stats.matches, eve.stats.rate], ['暂无', '暂无', '暂无']);
  const dan = PV.playerView(profiles, players, ms, 'dan');
  assert.strictEqual(dan.level.provisional, true); assert.strictEqual(dan.level.played, 1); assert.strictEqual(dan.level.self, '3.0');
  // 场数、胜率和生涯战绩（utils/career.js）同一套计算
  const c = require('../utils/career').career(ms, 'ann', 'Ann', [], {});
  assert.strictEqual(ann.stats.matches, String(c.played));
  assert.strictEqual(ann.stats.rate, c.rate + '%');
  // 全部比赛页顶部数字卡：胜、负和生涯战绩一致；没比赛是 0
  assert.deepStrictEqual([ann.stats.win, ann.stats.lose], [String(c.win), String(c.lose)]);
  assert.deepStrictEqual([eve.stats.win, eve.stats.lose], ['0', '0']);
});

test('不那么素：全部比赛顶部数字卡、录日常比赛顶部概要卡（日期、双方、规则）；这些页面不用 emoji', () => {
  const hist = read('pages/history/history.wxml');
  assert.ok(/class="hs"/.test(hist) && ['场数', '胜', '负', '胜率'].every((l) => hist.indexOf(`<text class="hs-l">${l}</text>`) >= 0));
  const add = read('pages/add/add.wxml');
  assert.ok(/<image class="hero-art" src="\/images\/art-ball\.png" mode="aspectFit" \/>/.test(add) && /待选对手/.test(add));
  // 界面上不用彩色 emoji（和 3D 配图风格不搭）：冠军用黄绿标签 / 奖杯插画，名次用金银铜奖牌图标（图片）；✓ ★ ✕ 这类单色符号可以
  const files = [];
  for (const dir of ['pages', 'components']) {
    for (const d of fs.readdirSync(path.join(__dirname, '..', dir))) {
      for (const ext of ['wxml', 'js']) { const f = `${dir}/${d}/${d}.${ext}`; if (fs.existsSync(path.join(__dirname, '..', f))) files.push(f); }
    }
  }
  files.push('utils/career.js');
  for (const f of files) {
    const code = read(f).replace(/\/\*[\s\S]*?\*\/|\/\/.*$|<!--[\s\S]*?-->/gm, '');
    assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(code), f + ' 里不要彩色 emoji');
  }
});

test('名次口径：球员卡、报名名单、战绩页卡片都和排行榜（生涯 · 全部 · 按水平）一致，只在同意公开展示的账号里排；没同意的显示「未公开」', async () => {
  const store = {};
  const pr = players.map((p) => Object.assign({}, p));
  const page = (() => {
    const filename = path.resolve(__dirname, '../pages/rank/rank.js');
    let def;
    vm.runInNewContext(read('pages/rank/rank.js'), {
      require: (id) => (id === '../../utils/db'
        ? { cachedMatches: () => ms, cachedPlayersFull: () => pr, cachedProfile: () => null, profilesOf: () => profiles }
        : createRequire(filename)(id)),
      wx: { getStorageSync: (k) => store[k], setStorageSync: (k, v) => { store[k] = v; }, hideShareMenu() {} }, Page: (d) => { def = d; }, console, Date,
    });
    return Object.assign({}, def, { data: JSON.parse(JSON.stringify(def.data)), setData(p) { Object.assign(this.data, p); } });
  })();
  page.onLoad();
  const board = {};
  page.list.forEach((p) => { board[p.uid] = '#' + p.rank; });
  assert.deepStrictEqual(Object.keys(board).sort(), ['ann', 'cat'], '排行榜只有同意公开的');
  for (const uid of ['ann', 'cat']) assert.strictEqual(PV.playerView(profiles, players, ms, uid).stats.rank, board[uid], uid);
  // 报名名单（S.display）和战绩页「我的」卡片用同一个名次
  const S = require('../utils/stats');
  const st = S.playerStats(ms, players, profiles);
  for (const uid of ['ann', 'cat']) assert.strictEqual(S.display(st, profiles[uid].name, profiles[uid], uid).rank, '第 ' + board[uid].slice(1) + ' 名', uid);
  assert.strictEqual(S.display(st, 'Bob', profiles.bob, 'bob').rank, '未公开');
  assert.strictEqual(S.display(st, 'Eve', profiles.eve, 'eve').rank, '暂无');
  assert.strictEqual(S.playerStats(ms, players).map.cat.boardRank, st.map.cat.boardRank, '不传 profiles 时用球员列表里的授权');
  // 活动详情的报名名单：球员列表是复制版、本机还没有资料缓存（新装 / 清缓存）时，名次照样和排行榜一致
  let su = null;
  const dv = (() => {
    const filename = path.resolve(__dirname, '../pages/draw-view/draw-view.js');
    let def;
    vm.runInNewContext(read('pages/draw-view/draw-view.js'), {
      require: (id) => (id === '../../utils/db'
        ? { fetchSignups: async () => [], mySignup: async () => null, fetchPlayersFull: async () => JSON.parse(JSON.stringify(players)), cachedPlayersFull: () => [], cachedMatches: () => ms, profilesOf: () => ({}), cachedProfiles: () => ({}) }
        : createRequire(filename)(id)),
      wx: {}, Page: (d) => { def = d; }, console, Date, setTimeout, clearTimeout,
    });
    return Object.assign({}, def, { data: JSON.parse(JSON.stringify(def.data)), setData(p) { Object.assign(this.data, p); if (p.signups) su = p.signups; } });
  })();
  dv.id = 'x';
  await dv.loadSignups({ _id: 'x', status: 'signup', mode: 'bracket', size: 8 }, ms, [
    { _id: 's1', drawId: 'x', name: 'Cat', _openid: 'cat', createdAt: 1 }, { _id: 's2', drawId: 'x', name: 'Bob', _openid: 'bob', createdAt: 2 },
  ]);
  const rk = {};
  su.forEach((g) => g.members.forEach((p) => { rk[p.uid] = p.rank; }));
  assert.deepStrictEqual(rk, { cat: '第 ' + board.cat.slice(1) + ' 名', bob: '未公开' });
  const idx = (() => {
    const filename = path.resolve(__dirname, '../pages/index/index.js');
    let def;
    vm.runInNewContext(read('pages/index/index.js'), { require: createRequire(filename), wx: { getStorageSync: () => '' }, Page: (d) => { def = d; }, console, Date });
    return def;
  })();
  const card = (uid) => idx.meCard.call({ myId: uid }, ms, st, players).rankText;
  assert.strictEqual(card('cat'), '排名第 ' + board.cat.slice(1) + ' 位');
  assert.strictEqual(card('bob'), '未开启公开展示，不在排行榜里');
  // Bob 等级最高但没同意公开、Dan 还没选：卡上不显示名次，其他数据照常
  for (const uid of ['bob', 'dan']) {
    const v = PV.playerView(profiles, players, ms, uid);
    assert.strictEqual(v.stats.rank, '未公开', uid);
    assert.notStrictEqual(v.stats.matches, '暂无');
    assert.strictEqual(v.profile.shown, false);
  }
});

test('球员卡界面：卡面不写标题；头像 / 首字圆（<pl-av>）、昵称、比赛等级在卡面，排名 / 场数 / 胜率在卡片下方；只在站内展示', () => {
  const xml = read('components/player-home/player-home.wxml');
  const card = xml.slice(xml.indexOf('<view class="pcard'), xml.indexOf('<view class="foot-note'));
  assert.ok(!/LULU 球员卡/.test(xml), '卡面不写「LULU 球员卡」标题（用户觉得显得 low）');
  assert.ok(/<pl-av wx:if="\{\{view\.profile\}\}" class="pc-photo init" uid="\{\{view\.profile\.uid\}\}" name="\{\{view\.profile\.name\}\}"/.test(card), '照片 / 首字圆走 pl-av（按公开展示授权下发）');
  assert.ok(/\{\{view\.profile\.name\}\}/.test(card));
  assert.ok(card.indexOf('比赛等级') < card.indexOf('自评等级'));
  const stats = card.slice(card.indexOf('pc-stats'));
  assert.deepStrictEqual([...stats.matchAll(/<text class="l">([^<]+)<\/text>/g)].map((x) => x[1]), ['排名', '场数', '胜率']);
  const fixed = xml.replace('<image class="bg-img" src="/images/bg-card.jpg" mode="aspectFill" />', '').split('<image class="bd-img" src="/images/badges/{{item.id}}.png" mode="aspectFit" />').join('');
  assert.ok(!/<image /.test(fixed), '照片只走 pl-av；<image> 只有卡片背景和徽章图标（包里的静态配图）');
  assert.ok(!/stats4/.test(xml), '原来卡片下面单独的数据行已并进球员卡');
  // 只有「编辑资料 / 完善资料」按钮进资料页，点卡片其他地方不跳转（2026-11-24 用户报的 bug）
  assert.ok(/<view class="pcard[^>]*>/.test(card) && !/tap=/.test(card.match(/<view class="pcard[^>]*>/)[0]), '卡片本身不绑点击');
  assert.strictEqual((card.match(/tap="edit"/g) || []).length, 1, '只有编辑资料按钮调 edit');
  // 第一版只在站内展示：没有分享、保存图片
  for (const f of ['components/player-home/player-home.js', 'pages/player/player.js']) {
    const js = read(f);
    assert.ok(!/onShareAppMessage|onShareTimeline|saveImageToPhotosAlbum|canvasToTempFilePath/.test(js), f);
  }
  // 「我的」和球员主页（排行 / 报名名单点进来）都用这个组件
  assert.ok(/<player-home id="home" uid="\{\{myId\}\}" mine \/>/.test(read('pages/me/me.wxml')));
  assert.ok(/<player-home id="home" uid="\{\{uid\}\}" \/>/.test(read('pages/player/player.wxml')));
});

T.push({ name: '生涯成就徽章：每个徽章都有图标 images/badges/<id>.png（3D 图标，不再用 emoji），没达成的灰色变淡', fn() {
  const C = require('../utils/career');
  const ids = C.career([], 'u1', '小林').badges.map((b) => b.id);
  assert.ok(ids.length >= 21);
  ids.forEach((id) => {
    const f = path.join(__dirname, '../images/badges', id + '.png');
    assert.ok(fs.existsSync(f), id + ' 没有图标');
    assert.ok(fs.statSync(f).size < 12 * 1024, id + ' 图标太大');
  });
  const xml = read('components/player-home/player-home.wxml'), css = read('components/player-home/player-home.wxss');
  assert.ok(/<image class="bd-img" src="\/images\/badges\/\{\{item\.id\}\}\.png" mode="aspectFit" \/>/.test(xml) && !/\{\{item\.icon\}\}/.test(xml));
  assert.ok(/\.bd\.off \.bd-img \{[^}]*grayscale/.test(css));
  // 还没有正式比赛：「我的」照样摆出徽章（都没达成），默认只露前 8 个，告诉本人第一个怎么拿；别人的主页不显示
  assert.ok(/wx:if="\{\{mine && \(loaded \|\| cached\) && !view\.career\.has\}\}"/.test(xml) && /index < 8 \|\| allBadges/.test(xml) && /就能拿到「初登场」/.test(xml));
  assert.strictEqual(C.career([], 'u1', '小林').badges.filter((b) => b.got).length, 0);
  // 「我的」入口图标用配图，不用 emoji
  const me = read('pages/me/me.wxml');
  assert.ok(/src="\/images\/art-basket\.png"/.test(me) && /src="\/images\/badges\/social\.png"/.test(me) && !/📈|👥/.test(me));
} });

T.push({ name: '排行榜前三：金银铜奖牌图标 images/medal-1/2/3.png（图片，不用 emoji 字符），每张不超过 12KB', fn() {
  const fs = require('fs'), path = require('path');
  for (const n of [1, 2, 3]) {
    const f = path.join(__dirname, '../images/medal-' + n + '.png');
    assert.ok(fs.existsSync(f), f); assert.ok(fs.statSync(f).size <= 12 * 1024, f);
  }
  const xml = fs.readFileSync(path.join(__dirname, '../pages/rank/rank.wxml'), 'utf8');
  assert.ok(/<image class="medal-img" src="\/images\/medal-\{\{item\.rank\}\}\.png" mode="aspectFit" \/>/.test(xml));
} });

module.exports = T;

test('「我的」生涯成就空卡：本机有比赛缓存时马上显示（cached），不等云端；没有缓存（第一次打开）才等云端读完', async () => {
  const run = async (cache) => {
    let def;
    let release;
    const wait = new Promise((r) => { release = r; });
    const db = {
      cachedMatchesOrNull: () => cache, cachedProfiles: () => ({}), cachedPlayersFull: () => [],
      playersShared: () => wait.then(() => []), matchesShared: () => wait.then(() => []), myOpenid: async () => 'u1', profilesOf: () => ({}),
    };
    const file = path.resolve(__dirname, '../components/player-home/player-home.js');
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: (id) => (id === '../../utils/db' ? db : createRequire(file)(id)), Component: (d) => { def = d; }, console, wx: {} });
    const c = Object.assign({}, def.methods, { data: Object.assign(JSON.parse(JSON.stringify(def.data)), { uid: 'u1', mine: true }), setData(o) { Object.assign(this.data, o); } });
    const p = c.load();
    const before = { cached: c.data.cached, loaded: c.data.loaded };
    release(); await p;
    return [before, c.data.loaded];
  };
  assert.deepStrictEqual(await run([]), [{ cached: true, loaded: false }, true], '有缓存（没有比赛）：云端还没回来就显示');
  assert.deepStrictEqual(await run(null), [{ cached: false, loaded: false }, true], '没有缓存：等云端');
});
