// 表单行为：手动名称不会被其他选项覆盖，地图返回的可编辑文字不进入表单数据。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const T = [];
const test = (name, fn) => T.push({ name, fn });
// 页面里 cloud.cached / fresh / peek（内存缓存）在测试里都直接走 call
const viaCall = (c) => Object.assign(c, { cached: (a, d) => c.call(a, d), fresh: (a, d) => c.call(a, d), peek: () => undefined });
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
    '../../utils/member': { status: async () => member, knownActive: () => false, isAdminLocal: () => false },
    '../../utils/db': {
      addDraw() { submitted++; }, generateDraw() { submitted++; },
      cachedPlayersFull: () => [], fetchPlayersFull: async () => { loaded++; return []; }, fetchMatches: async () => [],
      getDraw: async () => ({ _openid: 'alice', title: '历史活动' }),
      cachedDraws: () => [], drawsShared: async () => [],
    },
  };
  const wx = { getStorageSync: () => ({}), setNavigationBarTitle() {} };
  const p = load('pkg-manage/draw-new/draw-new.js', wx, 'Page', deps);
  await p.onLoad({});
  assert.strictEqual(p.data.canPublish, false);
  assert.match(p.data.authError, /管理员/);
  await p.publishSignup(); await p.save();
  assert.strictEqual(submitted, 0); assert.strictEqual(loaded, 0);
  const e = load('pkg-manage/event-edit/event-edit.js', wx, 'Page', deps);
  e.id = 'legacy'; await e.load();
  assert.match(e.data.error, /管理员/); assert.strictEqual(e.data.value, null);
  member = { status: 'active', isAdmin: true, uid: 'admin' };
  const a = load('pkg-manage/draw-new/draw-new.js', wx, 'Page', deps);
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

test('活动页「创建球友活动」、战绩页「记一场」：本机记得身份就一打开就显示，不等云端；云端说不是再收起', async () => {
  let admin = true, active = true;
  const member = {
    knownActive: () => true, isAdminLocal: () => true,
    statusCached: async () => ({ status: active ? 'active' : 'removed', isAdmin: admin }),
  };
  const never = () => new Promise(() => {}); // 数据一直没读完：按钮也不等它
  const d = load('pages/draw/draw.js', { showToast() {} }, 'Page', {
    '../../utils/member': member,
    '../../utils/db': { cachedDraws: () => [], cachedMatches: () => [], drawsShared: never, matchesShared: never, myOpenid: never, fetchMySignups: never },
  });
  d.render = () => {};
  d.onLoad();
  assert.strictEqual(d.data.canPublish, true, '活动页打开就显示');
  admin = false; d.load(); await new Promise((r) => setImmediate(r));
  assert.strictEqual(d.data.canPublish, false, '云端说不是管理员：收起（不等活动列表读完）');
  const i = load('pages/index/index.js', { showToast() {}, getStorageSync: () => '', hideShareMenu() {} }, 'Page', {
    '../../utils/member': member,
    '../../utils/db': { cachedMatchesAll: () => [], cachedPlayersFull: () => [], cachedProfile: () => null, cachedOpenid: () => '', profilesOf: () => ({}), matchesAllShared: never, playersShared: never, myOpenid: never },
  });
  i.render = () => {};
  i.onLoad();
  assert.strictEqual(i.data.canRecordDaily, true, '战绩页打开就显示');
  active = false; i.load(); await new Promise((r) => setImmediate(r));
  assert.strictEqual(i.data.canRecordDaily, false);
});

test('「我的」页：球员卡和成员管理入口按本机记得的身份先显示；本机没记录时等云端', () => {
  const mk = (known, admin) => load('pages/me/me.js', { getStorageSync: (k) => (k === 'my_openid' ? 'alice' : ''), hideShareMenu() {} }, 'Page', {
    '../../utils/member': { knownActive: () => known, isAdminLocal: () => admin },
  });
  const a = mk(true, true); a.onLoad();
  assert.deepStrictEqual([a.data.myId, a.data.isAdmin], ['alice', true]);
  const b = mk(true, false); b.onLoad();
  assert.deepStrictEqual([b.data.myId, b.data.isAdmin], ['alice', false]);
  const c = mk(false, true); c.onLoad();
  assert.deepStrictEqual([c.data.myId, c.data.isAdmin], ['', false]);
});

test('「我的」页：LULU 积分卡先显示本机记着的上一次结果（同一账号、今年），云端读完再更正并记下；成长档案读完前只显示标题，读不到显示入口说明', async () => {
  const year = new Date().getFullYear();
  const cupOf = (single) => ({ year, any: true, single, double: '0', encounter: '', last: null });
  const mk = (stored, deps = {}) => {
    const saved = [];
    const wx = { getStorageSync: (k) => (k === 'my_openid' ? 'alice' : k === 'cache_cup_mine' ? stored : ''), setStorage: (o) => saved.push(o), hideShareMenu() {} };
    const p = load('pages/me/me.js', wx, 'Page', Object.assign({ '../../utils/member': { knownActive: () => true, isAdminLocal: () => false } }, deps));
    return { p, saved };
  };
  const a = mk({ uid: 'alice', cup: cupOf('20') }).p; a.onLoad();
  assert.deepStrictEqual(a.data.cup && a.data.cup.single, '20', '有本机结果：马上显示');
  const b = mk({ uid: 'bob', cup: cupOf('20') }).p; b.onLoad();
  assert.strictEqual(b.data.cup, null, '别的账号的不用');
  const c = mk({ uid: 'alice', cup: Object.assign(cupOf('20'), { year: year - 1 }) }).p; c.onLoad();
  assert.strictEqual(c.data.cup, null, '去年的不用');
  // 云端读完：更正并记下
  const list = [];
  const { p: d, saved } = mk({ uid: 'alice', cup: cupOf('20') }, {
    '../../utils/cloud': { cached: async () => ({ list }) }, '../../utils/db': { myOpenid: async () => 'alice' },
  });
  d.onLoad(); await d.loadCup();
  assert.strictEqual(d.data.cup.any, false, '今年其实没有积分：更正');
  assert.deepStrictEqual(plain(saved.pop()), { key: 'cache_cup_mine', data: { uid: 'alice', cup: plain(d.data.cup) } });
  // 成长档案：读完前是 null（模板只显示标题）；读不到显示入口说明
  const { p: g } = mk(null, { '../../utils/archive': { list: async () => { throw new Error('网络不好'); } } });
  assert.strictEqual(g.data.gw, null);
  await g.loadGrowth();
  assert.deepStrictEqual(plain(g.data.gw), { played: 0 });
  const xml = fs.readFileSync(path.join(__dirname, '../pages/me/me.wxml'), 'utf8');
  assert.ok(/wx:if="\{\{gw && gw\.played\}\}"/.test(xml) && /wx:elif="\{\{gw\}\}"/.test(xml));
});

test('活动列表置顶：置顶的排最前（越晚置顶越靠前），带「置顶」标签；其余保持原顺序；「我的活动」同样', () => {
  const p = load('pages/draw/draw.js', { showToast() {} }, 'Page', {
    '../../utils/member': { knownActive: () => false, isAdminLocal: () => false },
    '../../utils/db': { cachedDraws: () => [], cachedMatches: () => [] },
  });
  const base = { status: 'signup', type: 'single', mode: 'bracket', size: 4, date: '2026-11-30' };
  p.draws = [
    Object.assign({ _id: 'a', title: '新活动' }, base),
    Object.assign({ _id: 'b', title: '早置顶', pinnedAt: 100 }, base),
    Object.assign({ _id: 'c', title: '旧活动' }, base),
    Object.assign({ _id: 'd', title: '晚置顶', pinnedAt: 200 }, base),
  ];
  p.matches = []; p.myId = 'me'; p.signups = [];
  p.render();
  assert.deepStrictEqual(p.data.shown.map((x) => x._id), ['d', 'b', 'a', 'c']);
  assert.deepStrictEqual(p.data.shown.map((x) => !!x.pinnedAt), [true, true, false, false]);
  const xml = fs.readFileSync(path.resolve(__dirname, '../pages/draw/draw.wxml'), 'utf8');
  assert.ok(/wx:if="\{\{item.pinnedAt\}\}" class="ui-tag solid d-pin">置顶</.test(xml));
});

test('战绩页：「记一场」用缓存版身份显示，和读数据同时进行；查不到身份时收起按钮，列表照常显示', async () => {
  let active = true, fail = false, realtime = 0, rendered = 0;
  const deps = {
    '../../utils/member': {
      statusCached: async () => { if (fail) throw new Error('网络异常'); return { status: active ? 'active' : 'removed', isAdmin: false }; },
      status: async () => { realtime++; return { status: active ? 'active' : 'removed', isAdmin: false }; },
    },
    '../../utils/db': {
      cachedMatchesAll: () => [], cachedPlayersFull: () => [], cachedProfile: () => null,
      matchesAllShared: async () => [], playersShared: async () => [], myOpenid: async () => 'alice', profilesOf: () => ({}),
    },
  };
  const p = load('pages/index/index.js', { showToast() {}, getStorageSync: () => '' }, 'Page', deps);
  p.render = () => { rendered++; };
  p.sig = null;
  await p.load();
  assert.strictEqual(p.data.canRecordDaily, true);
  active = false; p.sig = null; await p.load();
  assert.strictEqual(p.data.canRecordDaily, false);
  active = true; fail = true; p.sig = null; await p.load();
  assert.strictEqual(p.data.canRecordDaily, false);
  assert.strictEqual(rendered, 3); assert.strictEqual(p.data.loading, false);
  assert.strictEqual(realtime, 0);
});

test('日常录分页：正式成员（不必是管理员）可以录；不是正式成员不能提交，每次打开实时校验', async () => {
  let status = 'pending', submitted = 0, loaded = 0;
  const deps = { '../../utils/member': { status: async () => ({ status, isAdmin: false }), knownActive: () => false }, '../../utils/db': { addMatch() { submitted++; } } };
  const p = load('pkg-manage/add/add.js', {}, 'Page', deps);
  p.loadPlayers = async () => { loaded++; };
  await p.onShow(); await p.submit();
  assert.strictEqual(p.data.canRecordDaily, false); assert.match(p.data.authError, /正式成员/);
  assert.strictEqual(submitted, 0); assert.strictEqual(loaded, 0);
  status = 'active'; await p.onShow();
  assert.strictEqual(p.data.canRecordDaily, true); assert.strictEqual(loaded, 1);
  status = 'removed'; await p.onShow();
  assert.strictEqual(p.data.canRecordDaily, false);
});

test('创建活动 / 记一场：本机记得身份就先显示、不等云端校验；校验不通过再收起', async () => {
  let resolve, member;
  const wait = () => new Promise((r) => { resolve = r; });
  const deps = {
    '../../utils/member': { status: () => wait(), knownActive: () => true, isAdminLocal: () => true },
    '../../utils/db': {
      cachedPlayersFull: () => [], fetchPlayersFull: async () => [], fetchMatches: async () => [],
      cachedDraws: () => [], drawsShared: async () => [],
    },
  };
  const wx = { getStorageSync: () => ({}), setNavigationBarTitle() {} };
  // 创建活动：校验还没回来，表单已经显示；回来说不是管理员 → 收起
  const p = load('pkg-manage/draw-new/draw-new.js', wx, 'Page', deps);
  const done = p.onLoad({});
  await Promise.resolve();
  assert.strictEqual(p.data.canPublish, true);
  member = { status: 'active', isAdmin: false }; resolve(member); await done; await new Promise((r) => setImmediate(r));
  assert.strictEqual(p.data.canPublish, false); assert.match(p.data.authError, /管理员/);
  // 本机不记得是管理员：照旧等校验
  deps['../../utils/member'].isAdminLocal = () => false;
  const q = load('pkg-manage/draw-new/draw-new.js', wx, 'Page', deps);
  const done2 = q.onLoad({});
  await Promise.resolve();
  assert.strictEqual(q.data.canPublish, false);
  resolve({ status: 'active', isAdmin: true }); await done2;
  assert.strictEqual(q.data.canPublish, true);
  // 记一场：先显示、同时读球员；校验不通过再收起
  let loaded = 0;
  const a = load('pkg-manage/add/add.js', {}, 'Page', deps);
  a.loadPlayers = async () => { loaded++; };
  const shown = a.onShow();
  await Promise.resolve();
  assert.strictEqual(a.data.canRecordDaily, true); assert.strictEqual(loaded, 1);
  resolve({ status: 'removed' }); await shown;
  assert.strictEqual(a.data.canRecordDaily, false); assert.match(a.data.authError, /正式成员/);
  assert.strictEqual(loaded, 1, '球员只读一次');
});

test('创建活动顶部概要：形式、签数 / 组数、参加方式，日期、时间、单双打、组别，选项一改就跟着变', () => {
  const p = load('pkg-manage/draw-new/draw-new.js', { setStorageSync() {} }, 'Page');
  p.selected = []; p.seeds = []; p.players = [];
  const pick = (v) => ({ currentTarget: { dataset: { v } } });
  p.onInfo({ detail: { date: '2026-11-22', startTime: '' } });
  assert.strictEqual(p.data.heroTop, '单淘汰 · 8 签 · 开放报名');
  assert.strictEqual(p.data.heroSub, '11月22日 周日 · 时间待定 · 单打');
  p.setSize(pick('16')); p.setEntry(pick('pick'));
  assert.strictEqual(p.data.heroTop, '单淘汰 · 16 签 · 我来选人');
  p.setMode(pick('groups')); p.setGroups(pick('1')); p.setType(pick('double')); p.setCategory(pick('mixed'));
  p.onInfo({ detail: { date: '2026-11-22', startTime: '14:00' } });
  assert.strictEqual(p.data.heroTop, '分组循环 · 大循环 · 我来选人');
  assert.strictEqual(p.data.heroSub, '11月22日 周日 · 14:00 · 双打 · 混双');
  const xml = fs.readFileSync(path.join(__dirname, '../pkg-manage/draw-new/draw-new.wxml'), 'utf8');
  assert.ok(/<image class="hero-art" src="\/images\/art-net\.png" mode="aspectFit" \/>/.test(xml) && /<view class="card-title">活动设置<\/view>/.test(xml));
  assert.ok(!/\.pill\.on \{[^}]*background: #6E6EA3/.test(fs.readFileSync(path.join(__dirname, '../pkg-manage/draw-new/draw-new.wxss'), 'utf8')), '签数等选中样式和分段选择一致，不用深紫实心块');
});

test('创建和编辑：名称手动输入，改日期、单双打、组别、赛制都不会覆盖', () => {
  const wx = { setStorageSync() {} };
  const p = load('pkg-manage/draw-new/draw-new.js', wx, 'Page');
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
  const e = load('pkg-manage/event-edit/event-edit.js', wx, 'Page');
  e.onTitle({ detail: { value: '女子双打友谊赛' } });
  e.onInfo({ detail: { date: '2026-11-16' } });
  assert.strictEqual(e.data.title, '女子双打友谊赛');
});

test('开放报名时先加入的球友：创建后按顺序逐条代报名（adminAddSignup），双打带搭档；改成单打拆成单人；没加进去的列出原因、活动照常创建', async () => {
  const calls = [], modals = [], toasts = [];
  let redirected = '';
  const members = [{ uid: 'c', nickname: 'Cat', gender: 'f' }, { uid: 'a', nickname: 'Ann', gender: 'f' }, { uid: 'b', nickname: 'Bob', gender: 'm' }, { uid: 'z', nickname: '' }];
  const cloud = { call: async (action, data) => {
    calls.push([action, plain(data || {})]);
    if (action === 'listMembers') return { active: members };
    if (action === 'adminAddSignup' && data.playerId === 'c') throw new Error('这是男子组活动，只有男球员可以报名');
    return { ok: true };
  } };
  const deps = { '../../utils/db': { addDraw: async () => ({ id: 'n1' }) }, '../../utils/cloud': viaCall(cloud) };
  const wx = { showToast: (t) => toasts.push(t.title), showModal: (o) => { modals.push(o.content); o.complete && o.complete(); }, redirectTo: (o) => { redirected = o.url; }, setStorageSync() {}, showLoading() {}, hideLoading() {} };
  const p = load('pkg-manage/draw-new/draw-new.js', wx, 'Page', deps, { setTimeout: (f) => f(), clearTimeout() {}, console });
  p.selected = []; p.seeds = []; p.players = []; p.date = '2026-11-22';
  p.setData({ canPublish: true, title: '周日约球', entry: 'signup', type: 'double', mode: 'bracket' });
  p.onInfo({ detail: { date: '2026-11-30' } });
  await p.openPre();
  assert.deepStrictEqual(p.data.preSheet.list.map((m) => m.name), ['Ann', 'Bob', 'Cat'], '没设置资料的不出现，按名字排');
  p.prePick({ detail: { uid: 'a' } });
  assert.deepStrictEqual(p.data.preSheet.list.map((m) => m.uid), ['b', 'c'], '搭档不能选自己');
  p.prePick({ detail: { uid: 'b' } });
  await p.openPre();
  assert.deepStrictEqual(p.data.preSheet.list.map((m) => m.uid), ['c'], '已选的不再出现');
  p.prePick({ detail: { uid: 'c' } }); p.preSolo();
  assert.deepStrictEqual(p.data.pre.map((x) => x.text), ['Ann / Bob', 'Cat']);
  await p.publishSignup();
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'adminAddSignup').map((c) => c[1]), [
    { drawId: 'n1', playerId: 'a', partnerId: 'b' }, { drawId: 'n1', playerId: 'c', partnerId: '' },
  ]);
  assert.match(modals.pop(), /有 1 条没加进报名名单[\s\S]*Cat：这是男子组活动/);
  assert.match(redirected, /draw-view\?id=n1/, '活动照常创建、打开详情');
  // 改成单打：搭档拆成各自单独报名；删掉一条
  calls.length = 0; redirected = '';
  p.setData({ type: 'single' });
  p.removePre({ currentTarget: { dataset: { i: 1 } } });
  await p.publishSignup();
  assert.deepStrictEqual(calls.filter((c) => c[0] === 'adminAddSignup').map((c) => [c[1].playerId, c[1].partnerId]), [['a', ''], ['b', '']]);
  assert.match(toasts.pop(), /先加入 1 条报名/);
  assert.ok(redirected);
});

test('名称为空时创建和编辑都不提交', async () => {
  let submitted = 0;
  const deps = { '../../utils/db': { addDraw() { submitted++; }, updateDrawInfo() { submitted++; } } };
  const wx = { showToast() {}, showModal() {} };
  const p = load('pkg-manage/draw-new/draw-new.js', wx, 'Page', deps);
  p.data.title = '   ';
  await p.publishSignup();
  const e = load('pkg-manage/event-edit/event-edit.js', wx, 'Page', deps);
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

test('活动首页转发和朋友圈：只分享首页，标题和封面固定，不带任何活动或成员内容', () => {
  const deps = { '../../utils/db': {}, '../../utils/event': {}, '../../utils/next-match': {}, '../../utils/timeline': { isTimeline: () => false } };
  const d = load('pages/draw/draw.js', {}, 'Page', deps);
  d.data.list = [{ title: '周末球友赛' }]; d.data.next = { title: '周末球友赛', opp: 'Bob' };
  assert.deepStrictEqual(plain(d.onShareAppMessage()), { title: 'LULU 网球 · 一起来打球', path: '/pages/draw/draw', imageUrl: '/images/share-home.jpg' });
  // 朋友圈：没有 query（不带任何参数），封面是 1:1 方图
  assert.deepStrictEqual(plain(d.onShareTimeline()), { title: 'LULU 网球 · 一起来打球', imageUrl: '/images/share-timeline.jpg' });
  for (const f of ['images/share-home.jpg', 'images/share-timeline.jpg']) {
    const img = path.resolve(__dirname, '..', f);
    assert.ok(fs.existsSync(img) && fs.statSync(img).size <= 80 * 1024, f + ' 在包里、不超过 80KB');
  }
  // 其他页面不开朋友圈
  const app = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'app.json'), 'utf8'));
  const allP = (app.pages || []).concat((app.subpackages || []).flatMap((s) => (s.pages || []).map((p) => `${s.root}/${p}`)));
  allP.filter((p) => p !== 'pages/draw/draw').forEach((p) => {
    assert.ok(!/onShareTimeline/.test(fs.readFileSync(path.resolve(__dirname, '..', p + '.js'), 'utf8')), p + ' 不开朋友圈');
  });
});

test('朋友圈单页模式（场景 1154）：活动首页只显示固定介绍，不读缓存、不调云函数；app 不校验成员（单页模式不能跳准入页）', () => {
  const boom = () => { throw new Error('单页模式不应读取数据'); };
  const deps = {
    '../../utils/db': new Proxy({}, { get: () => boom }),
    '../../utils/event': {}, '../../utils/next-match': new Proxy({}, { get: () => boom }),
    '../../utils/timeline': { isTimeline: () => true },
  };
  let stopped = 0;
  const d = load('pages/draw/draw.js', { stopPullDownRefresh() { stopped++; } }, 'Page', deps);
  d.onLoad(); d.onShow(); d.onPullDownRefresh();
  assert.strictEqual(d.data.timeline, true); assert.strictEqual(d.data.loading, false); assert.strictEqual(stopped, 1);
  const xml = fs.readFileSync(path.resolve(__dirname, '..', 'pages/draw/draw.wxml'), 'utf8');
  assert.ok(/<view wx:if="\{\{timeline\}\}" class="page">/.test(xml) && /<block wx:else>/.test(xml), '单页模式和正常页面分开');
  // utils/timeline.js：只认启动场景 1154
  const tl = (scene) => { const ctx = { module: { exports: {} }, wx: { getLaunchOptionsSync: () => ({ scene }) } };
    vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '..', 'utils/timeline.js'), 'utf8'), ctx); return ctx.module.exports.isTimeline(); };
  assert.strictEqual(tl(1154), true); assert.strictEqual(tl(1007), false); assert.strictEqual(tl(1001), false);
  // app.onShow：单页模式直接返回，不查隐私指引、不调 member.check（两者都在 return 之后）
  const appSrc = fs.readFileSync(path.resolve(__dirname, '..', 'app.js'), 'utf8');
  assert.ok(/onShow\(\) \{\s*if \(require\('\.\/utils\/timeline'\)\.isTimeline\(\)\) return;[^\n]*\n\s*require\('\.\/utils\/privacy'\)\.ensure\(\);\n\s*require\('\.\/utils\/member'\)\.check\(\);/.test(appSrc));
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
  const c = load('pkg-manage/components/event-form/event-form.js', wx, 'Component');
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
  assert.deepStrictEqual(texts, ['LULU 网球', '报名中', '11月21日', '周六 14:00', '已报名', '8', '/ 8 人', '候补 2 人']);
  assert.ok(!texts.some((t) => /用户填的名称|张三|小组赛|淘汰赛|赛事|参赛|圈/.test(t)));
  // 活动详情页：报名人数变了才重画，分享时没画好就等它（微信最多等 3 秒），否则用固定封面
  const view = fs.readFileSync(path.join(__dirname, '../pages/draw-view/draw-view.js'), 'utf8');
  assert.ok(/imageUrl: this\.cover \|\| Card\.FALLBACK/.test(view) && /promise: this\.coverJob/.test(view));
  for (const p of ['pages/gate/gate.js', 'pkg-manage/members/members.js']) assert.ok(/imageUrl: SHARE_IMAGE/.test(fs.readFileSync(path.join(__dirname, '..', p), 'utf8')), p);
  assert.ok(fs.existsSync(path.join(__dirname, '..', Card.FALLBACK)));
  // 有底图（界面配图 share-bg）：先铺底图，不再画渐变和左上的小球，文字照旧
  assert.ok(fs.existsSync(path.join(__dirname, '..', Card.BG)) && fs.statSync(path.join(__dirname, '..', Card.BG)).size < 80 * 1024);
  const calls = [], texts2 = [];
  const ctx2 = new Proxy({}, { get: (o, k) => k === 'fillText' ? (t) => texts2.push(t)
    : k === 'measureText' ? (t) => ({ width: String(t).length * 40 })
    : ['drawImage', 'createLinearGradient', 'arc'].indexOf(k) >= 0 ? (...a) => { calls.push(k); return { addColorStop: noop }; }
    : (k in o ? o[k] : noop), set: (o, k, v) => { o[k] = v; return true; } });
  const bg = {};
  Card.paint(ctx2, a, bg);
  assert.strictEqual(calls[0], 'drawImage');
  assert.ok(calls.indexOf('createLinearGradient') < 0 && calls.indexOf('arc') < 0, '有底图不画渐变和小球');
  assert.deepStrictEqual(texts2, texts);
});

test('分享封面底图：画布能加载就用，加载失败或超时（1.5 秒）、基础库没有 createImage 时返回空，照旧画渐变', async () => {
  const Card = require('../utils/share-card');
  assert.strictEqual(await Card.loadBg({}), null);
  const ok = await Card.loadBg({ createImage: () => { const img = {}; setTimeout(() => img.onload(), 0); return img; } });
  assert.ok(ok && ok.src === Card.BG);
  assert.strictEqual(await Card.loadBg({ createImage: () => { const img = {}; setTimeout(() => img.onerror(), 0); return img; } }), null);
});

/* ---------- 种子设置（原「分开排位」）：叫法改成种子，生成逻辑和数据结构不变 ---------- */
const tap = (dataset) => ({ currentTarget: { dataset } });
function seedPage(extraDeps) {
  const toasts = [];
  const fail = (t) => { throw new Error('不应出错：' + (t.content || t.title)); };
  const wx = { setStorageSync() {}, getStorageSync: () => ({}), setNavigationBarTitle() {}, showToast: (t) => toasts.push(t.title), showModal: fail, vibrateShort() {}, pageScrollTo() {}, redirectTo() {}, navigateBack() {} };
  const p = load('pkg-manage/draw-new/draw-new.js', wx, 'Page', extraDeps, { setTimeout: () => {}, console });
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
  const xml = fs.readFileSync(path.join(__dirname, '../pkg-manage/draw-new/draw-new.wxml'), 'utf8');
  assert.ok(/\{\{type === 'double' \? '种子队伍' : '种子选手'\}\}/.test(xml) && /\{\{item\.seed\}\} 号种子/.test(xml) && !/分开排位|号位/.test(xml));
});

test('补录活动：历史日期和手动调整后的签位原样保存，交换轮空不会丢掉球员', async () => {
  let saved;
  const { p } = seedPage({ '../../utils/db': { addDraw: async (draw) => { saved = draw; return { id: 'past' }; } } });
  p.players = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
  p.selected = p.players.slice();
  p.seeds = ['A'];
  p.info = { date: '2026-11-21' };
  p.setData({ title: '上次活动' });
  p.refresh();
  p.doDraw(tap({ manual: 'yes' }));
  const names = () => plain(p.data.preview.lines.map((line) => line.name || '轮空'));
  assert.deepStrictEqual(names(), ['A', '轮空', 'B', 'C', 'D', 'E', 'F', 'G'], '起始：1 号种子优先轮空，其余按名单顺序');
  const place = (i, j) => p.setManualSlot({ ...tap({ i }), detail: { value: String(j) } });
  place(3, 0); // 把 A 放在第 4 个位置
  place(2, 7); // 轮空换到第 3 个位置
  await p.save();
  assert.strictEqual(saved.date, '2026-11-21');
  assert.deepStrictEqual(plain(saved.lines.map((line) => line.name || '轮空')), ['C', 'B', '轮空', 'A', 'D', 'E', 'F', 'G']);
  assert.strictEqual(saved.lines[3].seed, 1);
  assert.deepStrictEqual(plain(p.data.manualIndexes), [2, 1, 7, 0, 3, 4, 5, 6]);
});

test('手动排对阵的起始位置：轮空分散开（不会两个轮空碰在一起，也没有人连着两轮轮空直接进最后一轮），名字按名单顺序', () => {
  const { p } = seedPage();
  p.players = ['A', 'B', 'C', 'D', 'E'];
  p.selected = p.players.slice();
  p.seeds = [];
  p.refresh();
  p.doDraw(tap({ manual: 'yes' }));
  const lines = p.data.preview.lines;
  assert.strictEqual(lines.length, 8);
  for (let i = 0; i < 8; i += 2) assert.ok(!(lines[i].bye && lines[i + 1].bye), '第一轮没有轮空对轮空');
  assert.deepStrictEqual(plain(lines.filter((x) => x.name).map((x) => x.name)), ['A', 'B', 'C', 'D', 'E']);
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
    '../../utils/member': { status: async () => ({ status: 'active', isAdmin: true }), knownActive: () => false, isAdminLocal: () => false },
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

test('成员管理：顶部数出没填性别的球友（含还没设置资料、加入时留了昵称的），可以只看他们；设置性别走 setMemberGender，没资料的先确认', async () => {
  const calls = [];
  let sheet, modal;
  const active = [{ uid: 'a', nickname: 'Ann', gender: 'f' }, { uid: 'b', nickname: 'Bob', gender: '' }, { uid: 'c', nickname: '', name: '', gender: '' }, { uid: 'd', nickname: 'Dan' }, { uid: 'j', nickname: '', name: '杰娃儿' }];
  const cloud = viaCall({ call: async (action, data) => { calls.push([action, data]); return action === 'listMembers' ? { active, pending: [], others: [], candidates: [] } : { ok: true }; } });
  const v = load('pkg-manage/members/members.js', { showToast() {}, showActionSheet: (o) => { sheet = o; }, showModal: (o) => { modal = o; } }, 'Page', { '../../utils/cloud': cloud });
  await v.load();
  assert.deepStrictEqual([v.data.noGender, v.data.activeList.length], [3, 5], '加入时也没留昵称的不算');
  v.toggleNoGender();
  assert.deepStrictEqual(v.data.activeList.map((m) => m.uid), ['b', 'd', 'j']);
  await v.setGender({ currentTarget: { dataset: { uid: 'b', name: 'Bob' } } });
  sheet.success({ tapIndex: 1 });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(plain(calls.find((c) => c[0] === 'setMemberGender')), ['setMemberGender', { uid: 'b', gender: 'f' }]);
  assert.strictEqual(v.data.onlyNoGender, true, '刷新后仍只看没填的');
  await v.setGender({ currentTarget: { dataset: { uid: 'a', name: 'Ann', gender: 'f' } } });
  assert.match(sheet.alertText, /现在是女/, '改已有的性别时写出现在是什么');
  // 还没设置资料的：先弹窗说明会替 TA 建资料，取消就不选
  sheet = null;
  const p1 = v.setGender({ currentTarget: { dataset: { uid: 'j', name: '杰娃儿', fresh: true } } });
  assert.match(modal.content, /杰娃儿/);
  modal.success({ confirm: false }); await p1;
  assert.strictEqual(sheet, null);
  const p2 = v.setGender({ currentTarget: { dataset: { uid: 'j', name: '杰娃儿', fresh: true } } });
  modal.success({ confirm: true }); await p2;
  sheet.success({ tapIndex: 0 });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(plain(calls.filter((c) => c[0] === 'setMemberGender').pop()), ['setMemberGender', { uid: 'j', gender: 'm' }]);
  v.toggleNoGender();
  assert.strictEqual(v.data.activeList.length, 5);
});

test('管理员代报名：选人弹层里只列还没报名的正式成员；双打接着选搭档（可以不带），确认后才调用 adminAddSignup', async () => {
  const calls = [], modals = [];
  const wx = { showToast() {}, showModal: (o) => { modals.push(o.content); o.success({ confirm: true }); } };
  const members = [{ uid: 'carl', nickname: 'Carl', gender: 'm' }, { uid: 'ann', nickname: 'Ann', gender: 'f' }, { uid: 'bob', nickname: 'Bob', gender: 'm' }, { uid: 'x', nickname: '' }];
  const cloud = viaCall({ call: async (action, data) => { calls.push([action, data]); return action === 'listMembers' ? { active: members } : { ok: true }; } });
  const v = load('pages/draw-view/draw-view.js', wx, 'Page', { '../../utils/cloud': cloud });
  let reloaded = 0;
  Object.assign(v, { id: 'd1', signupRows: [{ _openid: 'bob', partnerId: '' }], loadSignups: async () => { reloaded++; } });
  v.setData({ canEdit: true, signing: true, isDouble: true, isRot: false });
  await v.openAdminSignup();
  assert.deepStrictEqual(v.data.adminSheet.list.map((m) => [m.name, m.g]), [['Ann', '女'], ['Carl', '男']], '已报名的、没设置资料的不出现，按名字排');
  v.adminPick({ detail: { uid: 'ann' } });
  assert.deepStrictEqual([v.data.adminSheet.title, v.data.adminSheet.extra], ['选择 Ann 的搭档', '不带搭档']);
  assert.deepStrictEqual(v.data.adminSheet.list.map((m) => m.uid), ['carl'], '搭档不能选自己');
  v.adminPick({ detail: { uid: 'carl' } });
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(v.data.adminSheet, null);
  assert.match(modals[0], /Ann \/ Carl/);
  assert.deepStrictEqual(plain(calls.pop()), ['adminAddSignup', { drawId: 'd1', playerId: 'ann', partnerId: 'carl' }]);
  assert.strictEqual(reloaded, 1, '添加后刷新名单');
  // 不带搭档；单打选了人直接确认
  await v.openAdminSignup(); v.adminPick({ detail: { uid: 'carl' } }); v.adminSolo();
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(plain(calls.pop()), ['adminAddSignup', { drawId: 'd1', playerId: 'carl', partnerId: '' }]);
  v.setData({ isDouble: false });
  await v.openAdminSignup(); v.adminPick({ detail: { uid: 'ann' } });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(plain(calls.pop()), ['adminAddSignup', { drawId: 'd1', playerId: 'ann', partnerId: '' }]);
  // 关掉弹层不调用；不是管理员打不开
  await v.openAdminSignup(); v.closeAdminSheet();
  assert.ok(!calls.some((c) => c[0] === 'adminAddSignup'), '关掉弹层不添加');
  v.setData({ canEdit: false }); calls.length = 0;
  await v.openAdminSignup();
  assert.deepStrictEqual(calls, []);
});

test('调整活动对阵：保留现有签位和双打搭档，手动交换后保存实际位置和对阵版本', async () => {
  const draw = {
    _id: 'd1', status: 'drawn', mode: 'bracket', type: 'double', size: 4, drawVersion: 3, rosterVersion: 2,
    title: '双打活动', entrants: ['Ann / Ben', 'Cat / Dan'], teams: { 'Ann / Ben': ['Ann', 'Ben'], 'Cat / Dan': ['Cat', 'Dan'] },
    lines: [{ bye: true }, { name: 'Cat / Dan' }, { name: 'Ann / Ben' }, { bye: true }],
  };
  let saved;
  const { p } = seedPage({
    '../../utils/db': {
      getDraw: async () => draw, fetchPlayersFull: async () => [], fetchSignups: async () => [], fetchMatches: async () => [],
      generateDraw: async (id, data, manual) => { saved = { id, data, manual }; },
    },
  });
  p.drawId = 'd1';
  p.setData({ fromSignup: true, manualOnly: true });
  await p.loadSignups();
  assert.deepStrictEqual(plain(p.data.preview.lines), draw.lines);
  p.setManualSlot({ ...tap({ i: 1 }), detail: { value: '0' } });
  await p.save();
  assert.deepStrictEqual([saved.id, saved.data.drawVersion, saved.data.rosterVersion, saved.manual], ['d1', 3, 2, true]);
  assert.deepStrictEqual(plain(saved.data.teams), draw.teams);
  assert.deepStrictEqual(plain(saved.data.lines), [{ bye: true }, { name: 'Ann / Ben' }, { name: 'Cat / Dan' }, { bye: true }]);
});

test('旧活动的种子名单：活动详情按「N 号种子」显示，单打叫种子选手、双打叫种子队伍；活动列表显示种子数', async () => {
  const show = async (d) => {
    const deps = {
      '../../utils/db': { fetchDrawDetail: async () => ({ draw: d, profile: null, signups: [] }), matchesShared: async () => [], playersShared: async () => [], myOpenid: async () => 'x' },
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

/* ---------- 成员内约球：建议水平、剩余名额、四人双打 ---------- */
test('建议水平表单：选项沿用自评等级；只选一头时另一头取同一档，始终最低 ≤ 最高；可以清除；旧活动按没设置', () => {
  const R = require('../utils/rating');
  const c = load('pkg-manage/components/event-form/event-form.js', {}, 'Component');
  let value;
  c.triggerEvent = (_, v) => { value = plain(v); };
  assert.deepStrictEqual(plain(c.data.levelOpts), R.SELF_LEVELS.map((x) => x.t));
  const at = (v) => ({ detail: { value: String(R.SELF_LEVELS.findIndex((x) => x.v === v)) } });
  c.init({ date: '2026-11-29' });
  assert.strictEqual(value.level, null); assert.strictEqual(c.data.levelView, null);
  c.onLevelMin(at(2.5));
  assert.deepStrictEqual(value.level, { min: 2.5, max: 2.5 });
  c.onLevelMax(at(3));
  assert.deepStrictEqual(value.level, { min: 2.5, max: 3 });
  assert.deepStrictEqual(plain(c.data.levelView), { min: '2.5', max: '3.0', minIndex: 2, maxIndex: 3 });
  c.onLevelMin(at(3.5)); // 最低选得比最高高：最高跟过去
  assert.deepStrictEqual(value.level, { min: 3.5, max: 3.5 });
  c.onLevelMax(at(3)); // 最高选得比最低低：最低跟过去
  assert.deepStrictEqual(value.level, { min: 3, max: 3 });
  c.clearLevel();
  assert.strictEqual(value.level, null); assert.strictEqual(c.data.levelView, null);
  c.onLevelMax(at(4)); // 只选最高
  assert.deepStrictEqual(value.level, { min: 4, max: 4 });
  // 编辑已有活动：回填；旧活动没有或存着不合法的值，按没设置
  c.init({ date: '2026-11-29', level: { min: 2, max: 3.5 } });
  assert.deepStrictEqual(value.level, { min: 2, max: 3.5 });
  c.init({ date: '2026-11-29', level: { min: 4, max: 2 } });
  assert.strictEqual(value.level, null);
  c.init({ date: '2026-11-29' });
  assert.strictEqual(value.level, null);
  const xml = fs.readFileSync(path.join(__dirname, '../pkg-manage/components/event-form/event-form.wxml'), 'utf8');
  assert.ok(/建议水平/.test(xml) && /bindchange="onLevelMin"/.test(xml) && /bindchange="onLevelMax"/.test(xml) && /bindtap="clearLevel"/.test(xml));
});

test('创建和编辑：建议水平随表单提交；编辑时明确带上（清空 = null），不合法的不提交', async () => {
  const sent = [];
  const deps = { '../../utils/db': {
    addDraw: async (d) => { sent.push(['add', plain(d)]); return { id: 'n1' }; },
    updateDrawInfo: async (id, info) => { sent.push(['edit', plain(info)]); return {}; },
  } };
  const toasts = [];
  const wx = { showToast: (t) => toasts.push(t.title), showModal() {}, redirectTo() {}, navigateBack() {}, setStorageSync() {} };
  const p = load('pkg-manage/draw-new/draw-new.js', wx, 'Page', deps, { setTimeout: () => {}, console });
  p.selected = []; p.seeds = []; p.players = []; p.date = '2026-11-22';
  p.setData({ canPublish: true, title: '周日约球' });
  p.onInfo({ detail: { date: '2026-11-30', level: { min: 2.5, max: 3 } } });
  await p.publishSignup();
  assert.deepStrictEqual(sent.pop()[1].level, { min: 2.5, max: 3 });
  p.onInfo({ detail: { date: '2026-11-30', level: null } });
  await p.publishSignup();
  assert.strictEqual(sent.pop()[1].level, null);
  p.onInfo({ detail: { date: '2026-11-30', level: { min: 3.5, max: 3 } } });
  await p.publishSignup();
  assert.strictEqual(sent.length, 0); assert.match(toasts.pop(), /最低不能高于最高/);

  const e = load('pkg-manage/event-edit/event-edit.js', wx, 'Page', deps, { setTimeout: () => {}, console });
  e.id = 'd1'; e.setData({ title: '周日约球' });
  e.info = { date: '2026-11-30', level: { min: 3, max: 3 } };
  await e.save();
  assert.deepStrictEqual(sent.pop()[1].level, { min: 3, max: 3 });
  e.info = { date: '2026-11-30', level: null };
  await e.save();
  const cleared = sent.pop()[1];
  assert.ok('level' in cleared && cleared.level === null, '清空时明确传 null，云端才会移除');
  e.info = { date: '2026-11-30', level: { min: 2.2, max: 3 } };
  await e.save();
  assert.strictEqual(sent.length, 0); assert.match(toasts.pop(), /选项/);
});

test('双打报名上限：多一个「2 队」（4 人），组数跟着减到放得下；单打没有「2 队」', () => {
  const { p, toasts } = seedPage();
  p.setData({ entry: 'signup' });
  const pick = (v) => tap({ v });
  assert.ok(p.data.limits.indexOf(2) < 0, '单打没有 2');
  p.setMode(pick('groups')); p.setType(pick('double'));
  assert.deepStrictEqual(plain(p.data.limits), [0, 2, 6, 8, 12, 16, 24, 32]);
  assert.strictEqual(p.data.groupCount, 4);
  p.setLimit(pick(2));
  assert.strictEqual(p.data.limit, 2); assert.strictEqual(p.data.groupCount, 1, '2 队只能分 1 组');
  assert.match(toasts.pop(), /最多分 1 组/);
  p.setGroups(pick(2)); // 放不下：不改
  assert.strictEqual(p.data.groupCount, 1); assert.match(toasts.pop(), /最多分 1 组/);
  const s = p.settings();
  assert.strictEqual(s.limit, 2); assert.strictEqual(s.type, 'double'); assert.strictEqual(s.groupCount, 1);
  assert.strictEqual(require('../utils/event').capacityOf(s), 4);
  p.setType(pick('single'));
  assert.ok(p.data.limits.indexOf(2) < 0); assert.strictEqual(p.data.limit, 0, '切回单打，2 队的上限作废');
  const xml = fs.readFileSync(path.join(__dirname, '../pkg-manage/draw-new/draw-new.wxml'), 'utf8');
  assert.ok(/2 队 = 4 人/.test(xml));
});

test('活动详情和列表：显示建议水平和报名情况（还差 / 已满 / 候补），没设置建议水平整行不显示', async () => {
  const show = async (d, signups) => {
    const deps = {
      '../../utils/db': {
        fetchDrawDetail: async () => ({ draw: d, profile: null, signups }), matchesShared: async () => [], myOpenid: async () => 'x',
        fetchPlayersFull: async () => [], playersShared: async () => [], cachedPlayersFull: () => [], cachedMatches: () => [], profilesOf: () => ({}),
      },
      '../../utils/member': { isAdminLocal: () => false },
    };
    const v = load('pages/draw-view/draw-view.js', { setNavigationBarTitle() {} }, 'Page', deps);
    v.id = d._id; v.makeCover = () => {}; v.renderSchedule = () => {};
    await v.load();
    assert.strictEqual(v.data.error, '');
    return v.data;
  };
  const su = (rows) => rows.map((r, i) => Object.assign({ _id: 's' + i, createdAt: i + 1, drawId: 'x1' }, r));
  const dbl = { _id: 'x1', title: '四人双打', status: 'signup', mode: 'groups', groupCount: 1, type: 'double', limit: 2, level: { min: 2.5, max: 3 } };
  let v = await show(dbl, su([{ name: 'A', partner: 'B' }, { name: 'C' }]));
  assert.strictEqual(v.levelText, '2.5–3.0');
  assert.strictEqual(v.signText, '已报名 3/4 人 · 还差 1 人'); assert.strictEqual(v.full, false);
  assert.match(v.signNote, /带搭档报名会进候补/);
  v = await show(dbl, su([{ name: 'A', partner: 'B' }, { name: 'C' }, { name: 'D' }, { name: 'E' }, { name: 'F' }]));
  assert.strictEqual(v.signText, '已满 · 候补 2 人'); assert.strictEqual(v.full, true);
  assert.deepStrictEqual(v.signups.map((x) => x.waiting), [false, false, false, true, true]);
  // 剩 1 个名额、最前面的候补是两人一组：不写「还差」，报名按钮是排队候补
  v = await show(dbl, su([{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D', partner: 'E' }]));
  assert.strictEqual(v.signText, '已报名 3/4 人 · 候补 2 人'); assert.strictEqual(v.full, true);
  assert.match(v.signNote, /新报名也排在候补后面/);
  // 不设上限、没设建议水平（旧活动）
  v = await show({ _id: 'x2', title: '老活动', status: 'signup', mode: 'groups', groupCount: 2, type: 'single' }, su([{ name: 'A' }, { name: 'B' }]));
  assert.strictEqual(v.levelText, ''); assert.strictEqual(v.signText, '已报名 2 人'); assert.strictEqual(v.signNote, '');
  const xml = fs.readFileSync(path.join(__dirname, '../pages/draw-view/draw-view.wxml'), 'utf8');
  assert.ok(/wx:if="\{\{levelText\}\}"[^>]*>建议水平 \{\{levelText\}\}/.test(xml));
  assert.ok(/\{\{signText\}\}/.test(xml) && /wx:if="\{\{signing && signNote\}\}"/.test(xml));

  const list = load('pages/draw/draw.js', { showToast() {} }, 'Page', {
    '../../utils/member': { statusCached: async () => ({ status: 'active', isAdmin: false }) },
    '../../utils/db': {
      drawsShared: async () => [
        { _id: 'a', title: '约球', mode: 'groups', groupCount: 1, type: 'double', status: 'signup', level: { min: 2.5, max: 3 } },
        { _id: 'b', title: '只建议 3.0', mode: 'groups', groupCount: 1, type: 'single', status: 'signup', level: { min: 3, max: 3 } },
        { _id: 'c', title: '老活动', mode: 'bracket', size: 8, status: 'signup' },
      ],
      matchesShared: async () => [], myOpenid: async () => 'x', fetchMySignups: async () => [],
    },
  });
  await list.load();
  const meta = Object.fromEntries(list.data.shown.map((x) => [x._id, x.meta.replace(/\u00a0/g, ' ')]));
  assert.match(meta.a, / · 建议水平 2\.5–3\.0/);
  assert.match(meta.b, / · 建议水平 3\.0/);
  assert.ok(!/建议水平/.test(meta.c));
});

module.exports = T;
