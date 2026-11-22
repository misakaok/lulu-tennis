// 表单行为：手动名称不会被其他选项覆盖，地图返回的可编辑文字不进入表单数据。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const T = [];
const test = (name, fn) => T.push({ name, fn });
const plain = (v) => JSON.parse(JSON.stringify(v));

function load(file, wx, kind, deps, globals) {
  const filename = path.resolve(__dirname, '..', file);
  let def;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (id) => deps && deps[id] || createRequire(filename)(id), wx, [kind]: (d) => { def = d; }, ...globals,
  });
  return Object.assign({}, kind === 'Component' ? def.methods : def, {
    data: plain(def.data),
    setData(p) {
      Object.entries(p).forEach(([key, value]) => {
        const parts = key.split('.');
        let target = this.data;
        parts.slice(0, -1).forEach((part) => { target = target[part]; });
        target[parts[parts.length - 1]] = value;
      });
    },
  });
}

test('发布页面：普通成员直接进入创建和编辑页不会显示表单或提交，管理员可进入', async () => {
  let submitted = 0, loaded = 0;
  let member = { status: 'active', isAdmin: false, uid: 'alice' };
  const deps = {
    '../../utils/member': { status: async () => member },
    '../../utils/db': {
      addDraw() { submitted++; }, generateDraw() { submitted++; },
      cachedPlayersFull: () => [], fetchPlayersFull: async () => { loaded++; return []; }, fetchMatches: async () => [],
      getDraw: async () => ({ _openid: 'alice', title: '历史活动' }),
    },
  };
  const wx = { getStorageSync: () => ({}), setNavigationBarTitle() {} };
  const p = load('pages/draw-new/draw-new.js', wx, 'Page', deps);
  await p.onLoad({});
  assert.strictEqual(p.data.canPublish, false);
  assert.match(p.data.authError, /管理员/);
  await p.publishSignup(); await p.save();
  assert.strictEqual(submitted, 0); assert.strictEqual(loaded, 0);
  const e = load('pages/event-edit/event-edit.js', wx, 'Page', deps);
  e.id = 'legacy'; await e.load();
  assert.match(e.data.error, /管理员/); assert.strictEqual(e.data.value, null);
  member = { status: 'active', isAdmin: true, uid: 'admin' };
  const a = load('pages/draw-new/draw-new.js', wx, 'Page', deps);
  await a.onLoad({});
  assert.strictEqual(a.data.canPublish, true); assert.strictEqual(a.data.authError, '');
});

test('活动列表：管理员入口随服务端身份（60 秒缓存）变化，普通成员不能通过处理函数进入创建页', async () => {
  let admin = false, navigations = 0;
  const deps = {
    // 列表页只用缓存版身份决定按钮显示，不每次切 tab 都实时调云函数
    '../../utils/member': { statusCached: async () => ({ status: 'active', isAdmin: admin }), status: async () => { throw new Error('列表页不应实时查身份'); } },
    '../../utils/db': { drawsShared: async () => [], matchesShared: async () => [], myOpenid: async () => 'alice', fetchMySignups: async () => [] },
  };
  const p = load('pages/draw/draw.js', { navigateTo() { navigations++; }, showToast() {} }, 'Page', deps);
  await p.load(); p.goNew();
  assert.strictEqual(p.data.canPublish, false); assert.strictEqual(navigations, 0);
  admin = true; await p.load(); p.goNew();
  assert.strictEqual(p.data.canPublish, true); assert.strictEqual(navigations, 1);
  admin = false; await p.load(); p.goNew();
  assert.strictEqual(p.data.canPublish, false); assert.strictEqual(navigations, 1);
});

test('战绩页：「记一场」用缓存版身份显示，和读数据同时进行；查不到身份时收起按钮，列表照常显示', async () => {
  let admin = true, fail = false, realtime = 0, rendered = 0;
  const deps = {
    '../../utils/member': {
      statusCached: async () => { if (fail) throw new Error('网络异常'); return { status: 'active', isAdmin: admin }; },
      status: async () => { realtime++; return { status: 'active', isAdmin: admin }; },
    },
    '../../utils/db': {
      cachedMatchesAll: () => [], cachedPlayersFull: () => [], cachedProfile: () => null,
      matchesAllShared: async () => [], playersShared: async () => [], myOpenid: async () => 'alice',
    },
  };
  const p = load('pages/index/index.js', { showToast() {}, getStorageSync: () => '' }, 'Page', deps);
  p.render = () => { rendered++; };
  p.sig = null;
  await p.load();
  assert.strictEqual(p.data.canRecordDaily, true);
  admin = false; p.sig = null; await p.load();
  assert.strictEqual(p.data.canRecordDaily, false);
  admin = true; fail = true; p.sig = null; await p.load();
  assert.strictEqual(p.data.canRecordDaily, false);
  assert.strictEqual(rendered, 3); assert.strictEqual(p.data.loading, false);
  assert.strictEqual(realtime, 0);
});

test('普通用户无法经日常录分页提交；管理员入口经实时身份校验', async () => {
  let admin = false, submitted = 0, loaded = 0;
  const deps = { '../../utils/member': { status: async () => ({ status: 'active', isAdmin: admin }) }, '../../utils/db': { addMatch() { submitted++; } } };
  const p = load('pages/add/add.js', {}, 'Page', deps);
  p.loadPlayers = async () => { loaded++; };
  await p.onShow(); await p.submit();
  assert.strictEqual(p.data.canRecordDaily, false); assert.match(p.data.authError, /管理员/);
  assert.strictEqual(submitted, 0); assert.strictEqual(loaded, 0);
  admin = true; await p.onShow();
  assert.strictEqual(p.data.canRecordDaily, true); assert.strictEqual(loaded, 1);
  admin = false; await p.onShow();
  assert.strictEqual(p.data.canRecordDaily, false);
});

test('创建和编辑：名称手动输入，改日期、单双打、组别、赛制都不会覆盖', () => {
  const wx = { setStorageSync() {} };
  const p = load('pages/draw-new/draw-new.js', wx, 'Page');
  p.selected = []; p.seeds = []; p.players = []; p.date = '2026-11-14';
  assert.strictEqual(p.data.title, '');
  p.onTitle({ detail: { value: '周末球友赛' } });
  p.onInfo({ detail: { date: '2026-11-14' } });
  assert.strictEqual(p.data.title, '周末球友赛');
  const pick = (v) => ({ currentTarget: { dataset: { v } } });
  p.setCategory(pick('m'));
  assert.strictEqual(p.data.title, '周末球友赛');
  p.setType(pick('double')); p.setCategory(pick('mixed')); p.setMode(pick('groups_ko'));
  assert.strictEqual(p.data.title, '周末球友赛');
  p.onInfo({ detail: { date: '2026-11-15' } });
  assert.strictEqual(p.data.title, '周末球友赛');
  p.setType(pick('single'));
  assert.strictEqual(p.data.title, '周末球友赛');
  const e = load('pages/event-edit/event-edit.js', wx, 'Page');
  e.onTitle({ detail: { value: '女子双打友谊赛' } });
  e.onInfo({ detail: { date: '2026-11-16' } });
  assert.strictEqual(e.data.title, '女子双打友谊赛');
});

test('名称为空时创建和编辑都不提交', async () => {
  let submitted = 0;
  const deps = { '../../utils/db': { addDraw() { submitted++; }, updateDrawInfo() { submitted++; } } };
  const wx = { showToast() {}, showModal() {} };
  const p = load('pages/draw-new/draw-new.js', wx, 'Page', deps);
  p.data.title = '   ';
  await p.publishSignup();
  const e = load('pages/event-edit/event-edit.js', wx, 'Page', deps);
  e.info = { date: '2026-11-14' };
  await e.save();
  assert.strictEqual(submitted, 0); assert.strictEqual(p.data.saving, false); assert.strictEqual(e.data.saving, false);
});

test('分享范围：球员主页和挑战没有分享回调并关闭分享配置；活动分享保留活动名称；赛季总结页已删除', () => {
  const deps = { '../../utils/db': {}, '../../utils/cloud': {} };
  const wx = {};
  const pl = load('pages/player/player.js', wx, 'Page', deps);
  assert.strictEqual(pl.onShareAppMessage, undefined);
  const ch = load('pages/challenge/challenge.js', wx, 'Page', deps);
  assert.strictEqual(ch.onShareAppMessage, undefined);
  const dv = load('pages/draw-view/draw-view.js', wx, 'Page', deps);
  dv.id = 'd1'; dv.data.draw = { title: '周末球友赛' }; dv.data.signing = true;
  assert.strictEqual(dv.onShareAppMessage().title, '周末球友赛 开始报名啦，点击报名');
  assert.ok(/open-type="share"/.test(fs.readFileSync(path.resolve(__dirname, '..', 'pages/draw-view/draw-view.wxml'), 'utf8')));
  assert.ok(!fs.existsSync(path.resolve(__dirname, '..', 'pages/summary')) && JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'app.json'), 'utf8')).pages.indexOf('pages/summary/summary') < 0);
  for (const p of ['player', 'challenge']) {
    const j = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'pages', p, p + '.json'), 'utf8'));
    assert.strictEqual(j.enableShareAppMessage, false, p); assert.strictEqual(j.enableShareTimeline, false, p);
  }
});

test('挑战书旧链接：不加载球员、不记录比分、不提供分享', () => {
  let hidden = 0;
  const p = load('pages/challenge/challenge.js', { hideShareMenu() { hidden++; } }, 'Page');
  p.onLoad({ from: '任意文字', to: 'Bob' });
  assert.strictEqual(hidden, 1); assert.strictEqual(p.goRecord, undefined);
  assert.strictEqual(p.onShareAppMessage, undefined);
  assert.deepStrictEqual(plain(p.data), {});
});

test('场地表单：旧的场地文字和 location 里的旧地图文字不回填；新选的地点名称和地址随表单提交（云端检测后才保存）', () => {
  const wx = { chooseLocation({ success }) { success({ latitude: 32, longitude: 122, name: '用户编辑的地图名', address: '用户编辑的地图地址' }); } };
  const c = load('components/event-form/event-form.js', wx, 'Component');
  let value;
  c.triggerEvent = (_, v) => { value = plain(v); };
  c.init({ date: '2026-11-14', venue: '旧自定义球场', location: { latitude: 31, longitude: 121, name: '旧地图文字' } });
  assert.strictEqual(value.venue, '');
  assert.deepStrictEqual(value.location, { latitude: 31, longitude: 121 });
  assert.strictEqual(value.place, null);
  assert.strictEqual(c.data.locText, '已选择地图位置');
  c.pickLocation();
  assert.strictEqual(value.venue, '');
  assert.deepStrictEqual(value.location, { latitude: 32, longitude: 122 });
  assert.deepStrictEqual(value.place, { name: '用户编辑的地图名', address: '用户编辑的地图地址' });
  assert.strictEqual(c.data.locText, '用户编辑的地图名');
  c.onCourt({ detail: { value: '3' } });
  assert.strictEqual(value.venue, '3 号场');
  c.clearLocation();
  assert.strictEqual(value.location, null); assert.strictEqual(value.place, null); assert.strictEqual(value.venue, '3 号场');
  // 编辑已有活动：显示云端保存过的地点名称
  c.init({ date: '2026-11-14', location: { latitude: 31, longitude: 121 }, place: { name: '已保存的地点', address: '某路 1 号' } });
  assert.strictEqual(c.data.locText, '已保存的地点');
  assert.deepStrictEqual(value.place, { name: '已保存的地点', address: '某路 1 号' });
});

test('分享封面：只画日期、时间和人数（不画活动名称、昵称），报名人数和页面一致，没有赛事用语', () => {
  const Card = require('../utils/share-card');
  const d = { status: 'signup', date: '2026-11-21', startTime: '14:00', title: '用户填的名称', entrants: ['张三'] };
  const a = Card.cardInfo(d, { people: 10, cap: 8, wait: 2 });
  assert.deepStrictEqual(plain(a), { date: '11月21日', sub: '周六 14:00', tag: '报名中', label: '已报名', num: '8', unit: '/ 8 人', extra: '候补 2 人' });
  assert.deepStrictEqual(plain(Card.cardInfo({ status: 'signup' }, { people: 3 })), { date: '时间待定', sub: '', tag: '报名中', label: '已报名', num: '3', unit: '人', extra: '' });
  assert.deepStrictEqual(plain(Card.cardInfo({ status: 'playing', date: '2026-1-5' }, { entrants: 4, unit: '队' })), { date: '1月5日', sub: '周一', tag: '', label: '参加', num: '4', unit: '队', extra: '' });
  // 画的时候只出现这些固定格式的文字
  const texts = [];
  const noop = () => {};
  const ctx = new Proxy({}, { get: (o, k) => k === 'fillText' ? (t) => texts.push(t)
    : k === 'measureText' ? (t) => ({ width: String(t).length * 40 })
    : k === 'createLinearGradient' ? () => ({ addColorStop: noop }) : (k in o ? o[k] : noop), set: (o, k, v) => { o[k] = v; return true; } });
  Card.paint(ctx, a);
  assert.deepStrictEqual(texts, ['LULU网球', '报名中', '11月21日', '周六 14:00', '已报名', '8', '/ 8 人', '候补 2 人']);
  assert.ok(!texts.some((t) => /用户填的名称|张三|小组赛|淘汰赛|赛事|参赛|圈/.test(t)));
  // 活动详情页：报名人数变了才重画，分享时没画好就等它（微信最多等 3 秒），否则用固定封面
  const view = fs.readFileSync(path.join(__dirname, '../pages/draw-view/draw-view.js'), 'utf8');
  assert.ok(/imageUrl: this\.cover \|\| Card\.FALLBACK/.test(view) && /promise: this\.coverJob/.test(view));
  for (const p of ['pages/gate/gate.js', 'pages/members/members.js']) assert.ok(/imageUrl: SHARE_IMAGE/.test(fs.readFileSync(path.join(__dirname, '..', p), 'utf8')), p);
  assert.ok(fs.existsSync(path.join(__dirname, '..', Card.FALLBACK)));
});

/* ---------- 种子设置（原「分开排位」）：叫法改成种子，生成逻辑和数据结构不变 ---------- */
const tap = (dataset) => ({ currentTarget: { dataset } });
function seedPage(extraDeps) {
  const toasts = [];
  const fail = (t) => { throw new Error('不应出错：' + (t.content || t.title)); };
  const wx = { setStorageSync() {}, getStorageSync: () => ({}), setNavigationBarTitle() {}, showToast: (t) => toasts.push(t.title), showModal: fail, vibrateShort() {}, pageScrollTo() {}, redirectTo() {} };
  const p = load('pages/draw-new/draw-new.js', wx, 'Page', extraDeps, { setTimeout: () => {}, console });
  p.selected = []; p.seeds = []; p.players = []; p.date = '2026-11-22';
  p.setData({ canPublish: true, entry: 'pick' });
  return { p, toasts };
}
// 淘汰赛的位置：1 号种子在上半区第一个签位，2 号种子在下半区
const halves = (lines, seedNo) => { const i = lines.findIndex((x) => x && x.seed === seedNo); return i < lines.length / 2 ? 'top' : 'bottom'; };

test('种子选手（单打手选）：点选、取消、上移调整顺序，1、2 号种子分在上下半区', () => {
  const { p, toasts } = seedPage();
  p.players = ['A', 'B', 'C', 'D', 'E', 'F']; p.selected = p.players.slice();
  p.refresh();
  assert.strictEqual(p.data.seedChips.length, 6);
  p.toggleSeed(tap({ name: 'C' })); p.toggleSeed(tap({ name: 'A' })); p.toggleSeed(tap({ name: 'E' }));
  assert.deepStrictEqual(plain(p.data.seedList.map((x) => [x.seed, x.name])), [[1, 'C'], [2, 'A'], [3, 'E']]);
  p.seedUp(tap({ i: 1 }));
  assert.deepStrictEqual(plain(p.seeds), ['A', 'C', 'E']);
  p.toggleSeed(tap({ name: 'C' })); // 取消后后面的顺延
  assert.deepStrictEqual(plain(p.data.seedList.map((x) => [x.seed, x.name])), [[1, 'A'], [2, 'E']]);
  assert.strictEqual(p.data.seedChips.find((x) => x.name === 'E').seed, 2);
  assert.match(p.data.seedInfo, /^建议选 2 位，最多 4 位（1、2 号种子分在上下半区）$/);
  assert.match(p.data.info, /首轮 2 个轮空（种子优先轮空）/);
  p.toggleSeed(tap({ name: 'B' })); p.toggleSeed(tap({ name: 'D' })); p.toggleSeed(tap({ name: 'F' })); // 8 签最多 4 个
  assert.strictEqual(p.seeds.length, 4); assert.strictEqual(toasts.pop(), '最多选 4 位种子选手');
  for (let k = 0; k < 20; k++) {
    const before = toasts.length;
    p.doDraw();
    assert.strictEqual(toasts.length, before, '生成预览不报错');
    const lines = p.data.preview.lines;
    assert.deepStrictEqual(plain(p.data.preview.seeds), ['A', 'E', 'B', 'D'], '保存的仍是 seeds 名单');
    assert.strictEqual(lines[0].name, 'A'); assert.strictEqual(lines[0].seed, 1);
    assert.strictEqual(halves(lines, 1), 'top'); assert.strictEqual(halves(lines, 2), 'bottom');
    assert.strictEqual(lines.find((x) => x && x.seed === 2).name, 'E');
    assert.strictEqual(lines[1].bye, true, '1 号种子优先轮空');
  }
  p.autoSeeds();
  assert.strictEqual(toasts.pop(), '已按水平推荐 2 位种子选手');
  const xml = fs.readFileSync(path.join(__dirname, '../pages/draw-new/draw-new.wxml'), 'utf8');
  assert.ok(/\{\{type === 'double' \? '种子队伍' : '种子选手'\}\}/.test(xml) && /\{\{item\.seed\}\} 号种子/.test(xml) && !/分开排位|号位/.test(xml));
});

test('种子队伍（双打按队设置）：按队伍点选和推荐，分组按蛇形分配', () => {
  const { p, toasts } = seedPage();
  p.setType(tap({ v: 'double' }));
  p.setMode(tap({ v: 'groups' })); p.setGroups(tap({ v: 2 }));
  p.players = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']; p.selected = p.players.slice();
  p.refresh();
  const teams = ['A / B', 'C / D', 'E / F', 'G / H'];
  assert.deepStrictEqual(plain(p.data.seedChips.map((x) => x.name)), teams, '种子按队伍选，不按个人');
  p.toggleSeed(tap({ name: 'G / H' })); p.toggleSeed(tap({ name: 'C / D' }));
  assert.deepStrictEqual(plain(p.data.seedList.map((x) => [x.seed, x.name])), [[1, 'G / H'], [2, 'C / D']]);
  assert.match(p.data.seedInfo, /^建议选 2 支，最多 4 支（按蛇形分到各组）$/);
  p.toggleSeed(tap({ name: 'A / B' }));
  p.doDraw();
  const pv = p.data.preview;
  assert.deepStrictEqual(plain(pv.seeds), ['G / H', 'C / D', 'A / B']);
  assert.deepStrictEqual(plain(pv.teams['G / H']), ['G', 'H']);
  const groupOf = (name) => pv.groups.findIndex((g) => g.members.some((m) => m.name === name && m.seed));
  assert.deepStrictEqual([groupOf('G / H'), groupOf('C / D'), groupOf('A / B')], [0, 1, 1], '蛇形：1→A，2→B，3→B');
  p.autoSeeds();
  assert.strictEqual(toasts.pop(), '已按水平推荐 2 支种子队伍');
  p.setType(tap({ v: 'single' }));
  assert.deepStrictEqual(plain(p.seeds), [], '换单双打后清空种子');
});

test('报名后：按水平推荐种子，发起人可以取消、换人、调整顺序再生成，名单里去掉的人不再是种子', async () => {
  let sent = null;
  const players = ['Ann', 'Ben', 'Cat', 'Dan', 'Eve'].map((name, i) => ({ name, uid: 'u' + i, level: [3, 4.5, 2.5, 4, 3.5][i] }));
  const deps = {
    '../../utils/member': { status: async () => ({ status: 'active', isAdmin: true }) },
    '../../utils/db': {
      cachedPlayersFull: () => [], fetchPlayersFull: async () => players, fetchMatches: async () => [],
      getDraw: async () => ({ _id: 'd1', title: '周日内部赛', mode: 'bracket', size: 8, type: 'single', status: 'signup' }),
      fetchSignups: async () => players.map((x, i) => ({ _id: 's' + i, _openid: x.uid, name: x.name, createdAt: i })),
      generateDraw: async (id, draw) => { sent = { id, draw }; },
    },
  };
  const { p, toasts } = seedPage(deps);
  p.setData({ canPublish: false });
  await p.onLoad({ id: 'd1' });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(p.data.fromSignup, true);
  assert.deepStrictEqual(plain(p.seeds), ['Ben', 'Dan'], '按水平推荐 2 位');
  p.toggleSeed(tap({ name: 'Dan' })); p.toggleSeed(tap({ name: 'Eve' })); p.toggleSeed(tap({ name: 'Dan' }));
  p.seedUp(tap({ i: 1 }));
  assert.deepStrictEqual(plain(p.data.seedList.map((x) => x.seed + ' 号种子 ' + x.name)), ['1 号种子 Eve', '2 号种子 Ben', '3 号种子 Dan']);
  p.togglePlayer(tap({ name: 'Ben' })); // 发起人把 Ben 从名单里去掉
  assert.deepStrictEqual(plain(p.seeds), ['Eve', 'Dan']);
  p.doDraw();
  assert.strictEqual(p.data.preview.lines.find((x) => x && x.seed === 1).name, 'Eve');
  await p.save();
  assert.strictEqual(toasts.pop(), '已生成');
  assert.strictEqual(sent.id, 'd1');
  assert.deepStrictEqual(plain(sent.draw.seeds), ['Eve', 'Dan']);
  assert.ok(sent.draw.lines.some((x) => x && x.name === 'Dan' && x.seed === 2));
});

test('旧活动的种子名单：活动详情按「N 号种子」显示，单打叫种子选手、双打叫种子队伍；活动列表显示种子数', async () => {
  const show = async (d) => {
    const deps = {
      '../../utils/db': { fetchDrawDetail: async () => ({ draw: d, profile: null, signups: [] }), fetchMatches: async () => [], myOpenid: async () => 'x' },
      '../../utils/member': { isAdminLocal: () => false },
    };
    const v = load('pages/draw-view/draw-view.js', { setNavigationBarTitle() {} }, 'Page', deps);
    v.id = d._id; v.makeCover = () => {}; v.renderSchedule = () => {};
    await v.load();
    assert.strictEqual(v.data.error, '');
    return v.data;
  };
  // 旧版本创建的活动：没有 type 字段（按单打）、seeds 只是名字数组
  const single = await show({ _id: 'old1', title: '老活动', mode: 'bracket', size: 8, status: 'drawn', entrants: ['老张', '老李', '小王'], seeds: ['老张', '老李'], lines: [] });
  assert.strictEqual(single.seedLabel, '种子选手');
  assert.deepStrictEqual(plain(single.seedRows), [{ no: 1, name: '老张' }, { no: 2, name: '老李' }]);
  const dbl = await show({ _id: 'old2', title: '老双打', mode: 'groups', groupCount: 2, type: 'double', status: 'drawn', entrants: ['A / B', 'C / D'], seeds: ['C / D'], groups: [] });
  assert.strictEqual(dbl.seedLabel, '种子队伍');
  assert.deepStrictEqual(plain(dbl.seedRows), [{ no: 1, name: 'C / D' }]);
  const none = await show({ _id: 'old3', title: '没种子', mode: 'bracket', size: 8, status: 'drawn', entrants: ['A', 'B'], lines: [] });
  assert.deepStrictEqual(plain(none.seedRows), []);
  const xml = fs.readFileSync(path.join(__dirname, '../pages/draw-view/draw-view.wxml'), 'utf8');
  assert.ok(/wx:if="\{\{seedRows\.length\}\}"/.test(xml) && /\{\{item\.no\}\} 号种子 \{\{item\.name\}\}/.test(xml) && !/分开排位/.test(xml));

  const list = load('pages/draw/draw.js', { showToast() {} }, 'Page', {
    '../../utils/member': { statusCached: async () => ({ status: 'active', isAdmin: false }) },
    '../../utils/db': {
      drawsShared: async () => [
        { _id: 'old1', title: '老活动', mode: 'bracket', size: 8, status: 'drawn', entrants: ['老张', '老李', '小王'], seeds: ['老张', '老李'] },
        { _id: 'old2', title: '老双打', mode: 'groups', groupCount: 2, type: 'double', status: 'drawn', entrants: ['A / B', 'C / D'], seeds: ['C / D'] },
        { _id: 'old3', title: '没种子', mode: 'bracket', size: 8, status: 'drawn', entrants: ['A', 'B'] },
      ],
      matchesShared: async () => [], myOpenid: async () => 'x', fetchMySignups: async () => [],
    },
  });
  await list.load();
  const meta = Object.fromEntries(list.data.shown.map((x) => [x._id, x.meta.replace(/ /g, ' ')]));
  assert.match(meta.old1, / · 种子选手 2 位$/);
  assert.match(meta.old2, / · 种子队伍 1 支$/);
  assert.ok(!/种子/.test(meta.old3));
});

module.exports = T;
