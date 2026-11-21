// 表单行为：手动名称不会被其他选项覆盖，地图返回的可编辑文字不进入表单数据。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const T = [];
const test = (name, fn) => T.push({ name, fn });
const plain = (v) => JSON.parse(JSON.stringify(v));

function load(file, wx, kind, deps) {
  const filename = path.resolve(__dirname, '..', file);
  let def;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (id) => deps && deps[id] || createRequire(filename)(id), wx, [kind]: (d) => { def = d; },
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

test('场地表单：旧文字和地图文字不回填，只保留坐标并从固定编号中选择', () => {
  const wx = { chooseLocation({ success }) { success({ latitude: 32, longitude: 122, name: '用户编辑的地图名', address: '用户编辑的地图地址' }); } };
  const c = load('components/event-form/event-form.js', wx, 'Component');
  let value;
  c.triggerEvent = (_, v) => { value = plain(v); };
  c.init({ date: '2026-11-14', venue: '旧自定义球场', location: { latitude: 31, longitude: 121, name: '旧地图文字' } });
  assert.strictEqual(value.venue, '');
  assert.deepStrictEqual(value.location, { latitude: 31, longitude: 121 });
  assert.strictEqual(c.data.locText, '已选择地图位置');
  c.pickLocation();
  assert.strictEqual(value.venue, '');
  assert.deepStrictEqual(value.location, { latitude: 32, longitude: 122 });
  c.onCourt({ detail: { value: '3' } });
  assert.strictEqual(value.venue, '3 号场');
  c.clearLocation();
  assert.strictEqual(value.location, null); assert.strictEqual(value.venue, '3 号场');
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

module.exports = T;
