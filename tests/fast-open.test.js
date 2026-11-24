// 打开就有内容（2026-11-24 用户嫌活动详情、比赛详情、活动录分页打开慢）：
//   先用本机已有的数据画出来，云端读完再更正；本机没有的（报名名单、确认 / 改分、修改记录）和要靠最新数据的按钮等读完再显示
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const E = require('../utils/event');
const T = [];
const test = (name, fn) => T.push({ name, fn });
const plain = (v) => JSON.parse(JSON.stringify(v));
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

function load(file, wx, deps) {
  const filename = path.join(ROOT, file);
  let def;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (id) => (deps && deps[id]) || createRequire(filename)(id), wx, Page: (d) => { def = d; }, setTimeout, clearTimeout, console,
  });
  let sets = 0;
  return Object.assign({}, def, {
    data: plain(def.data),
    setData(p) { sets++; Object.keys(p).forEach((k) => { this.data[k] = p[k]; }); },
    sets: () => sets,
  });
}
const later = () => { let ok, bad; const p = new Promise((a, b) => { ok = a; bad = b; }); return { p, ok, bad }; };
const tick = () => new Promise((r) => setTimeout(r, 0));

const signupDraw = () => ({ _id: 'd1', title: '周六约球', mode: 'groups', groupCount: 1, type: 'single', status: 'signup', date: '2026-11-29', _openid: 'boss' });
const drawnDraw = () => ({
  _id: 'd2', title: '周六单打', mode: 'bracket', size: 4, status: 'drawn', date: '2026-11-29', _openid: 'boss',
  entrants: ['小明', '阿杰', '小周', '小林'], lines: [{ name: '小明' }, { name: '阿杰' }, { name: '小周' }, { name: '小林' }],
  uidOf: { 小明: 'me', 阿杰: 'jie', 小周: 'zhou', 小林: 'lin' },
});

test('活动详情：先用活动列表的本机缓存画出标题、规则、时间地点；报名名单和报名 / 删除 / 生成对阵按钮等云端读完', async () => {
  const detail = later();
  const db = {
    cachedDraws: () => [signupDraw()], cachedMatches: () => [], cachedProfile: () => ({ name: '小明' }), cachedOpenid: () => 'me', cachedPlayersFull: () => [],
    fetchDrawDetail: () => detail.p, matchesShared: async () => [], myOpenid: async () => 'me', fetchPlayersFull: async () => [],
  };
  const v = load('pages/draw-view/draw-view.js', { setNavigationBarTitle() {} }, { '../../utils/db': db, '../../utils/member': { isAdminLocal: () => true } });
  v.makeCover = () => {};
  v.onLoad({ id: 'd1' });
  assert.strictEqual(v.data.draw.title, '周六约球', '不用等云端就有标题');
  assert.strictEqual(v.data.signing, true); assert.strictEqual(v.data.ready, false);
  assert.ok(v.data.info && v.data.rulesSum.length, '时间地点、规则先显示');
  const loading = v.load();
  detail.ok({ draw: signupDraw(), profile: { name: '小明' }, signups: [{ _id: 's1', name: '小明', _openid: 'me', createdAt: 1 }] });
  await loading;
  assert.strictEqual(v.data.ready, true); assert.strictEqual(v.data.joined, true, '读完才知道已经报名');
  assert.strictEqual(v.data.signups.length, 1);
  // 页面：名单读完前写「正在读取报名名单…」，报名、取消、添加报名、生成对阵、删除、手动调整对阵都要 ready
  const xml = read('pages/draw-view/draw-view.wxml');
  assert.ok(/wx:if="\{\{!ready\}\}" class="muted">正在读取报名名单…/.test(xml));
  ['ready && signing && !joined', 'canEdit && ready', 'ready && canEdit && (!isRot || canPublish)', 'ready && canManage', 'ready && canEditMatchups']
    .forEach((c) => assert.ok(xml.indexOf(`wx:if="{{${c}}}"`) >= 0, c));
});

test('活动详情：本机缓存没有这个活动照常等云端；只画过缓存、云端读不到时不留着缓存的内容', async () => {
  const base = { cachedMatches: () => [], cachedProfile: () => null, cachedOpenid: () => '', cachedPlayersFull: () => [], matchesShared: async () => [], myOpenid: async () => '' };
  const none = load('pages/draw-view/draw-view.js', { setNavigationBarTitle() {} }, { '../../utils/db': Object.assign({ cachedDraws: () => [] }, base), '../../utils/member': { isAdminLocal: () => false } });
  none.onLoad({ id: 'd1' });
  assert.strictEqual(none.data.draw, null);
  const v = load('pages/draw-view/draw-view.js', { setNavigationBarTitle() {} }, {
    '../../utils/db': Object.assign({ cachedDraws: () => [signupDraw()], fetchDrawDetail: async () => { throw new Error('活动不存在'); } }, base),
    '../../utils/member': { isAdminLocal: () => false },
  });
  v.onLoad({ id: 'd1' });
  assert.ok(v.data.draw);
  await v.load();
  assert.strictEqual(v.data.draw, null); assert.match(v.data.error, /活动加载失败/);
});

test('活动详情：已生成对阵的活动先用本机战绩画出场次；「我的下一场」定位等找到这一场才算数', async () => {
  const detail = later();
  const db = {
    cachedDraws: () => [drawnDraw()], cachedMatches: () => [], cachedProfile: () => ({ name: '小明' }), cachedOpenid: () => 'me', cachedPlayersFull: () => [],
    fetchDrawDetail: () => detail.p, matchesShared: async () => [], myOpenid: async () => 'me',
  };
  const v = load('pages/draw-view/draw-view.js', { setNavigationBarTitle() {}, pageScrollTo() {} }, { '../../utils/db': db, '../../utils/member': { isAdminLocal: () => false } });
  v.makeCover = () => {}; v.loadRequests = () => {};
  v.onLoad({ id: 'd2', tab: 'schedule', key: '1-0' }); // 本机缓存里还没有第 2 轮（要等第一轮录分）
  assert.ok(v.data.schedule.length >= 2 && v.data.schedule.some((x) => x.key === '0-0' && x.mine), '场次先画出来');
  assert.strictEqual(v.data.cupBox, null); assert.strictEqual(v.data.ready, false);
  const loading = v.load();
  detail.ok({ draw: drawnDraw(), profile: { name: '小明' }, signups: [], requests: { list: [], owner: false, myEntrants: ['小明'], withdrawals: [] } });
  await loading;
  assert.strictEqual(v.data.ready, true);
  assert.strictEqual(v.data.focus, '1-0', '本机缓存时没找到不放弃，云端读完再定位');
  assert.strictEqual(v.data.canWithdraw, true, '退赛申请读完才显示');
});

test('比赛详情：先用本机战绩里的这一场画记分牌；确认 / 改分 / 撤销、修改记录等云端读完（不让组件自己再调一次 matchState）', async () => {
  const st = later();
  const rec = { _id: 'm1', date: '2026-11-20', a: ['我'], b: ['对手'], aIds: ['me'], bIds: ['op'], winner: 'a', sets: [{ a: 6, b: 3 }], type: 'single', status: 'official' };
  const p = load('pages/match/match.js', { navigateTo() {} }, {
    '../../utils/cloud': { call: () => st.p },
    '../../utils/db': {
      cachedMatchesAll: () => [rec], cachedPlayersFull: () => [], fetchPlayersFull: async () => [], cachedMatches: () => [rec],
      myOpenid: async () => 'me', matchesShared: async () => [rec],
    },
  });
  p.onLoad({ id: 'm1' });
  assert.strictEqual(p.data.loading, false, '不显示「加载中…」');
  assert.strictEqual(p.data.ready, false);
  assert.deepStrictEqual([p.data.m.bigA, p.data.m.bigB, p.data.m.bigLbl, p.data.m.a[0].name], [6, 3, '局分', '我']);
  st.ok({ match: rec, status: 'official', matchId: 'm1', changes: [{ who: '我', how: 'edit', from: '6-4', to: '6-3', at: 1 }] });
  await tick(); await tick();
  assert.strictEqual(p.data.ready, true); assert.strictEqual(p.data.changes.length, 1);
  assert.strictEqual(p.data.preset.matchId, 'm1');
  const xml = read('pages/match/match.wxml');
  assert.ok(/<match-social wx:if="\{\{ready\}\}"/.test(xml), 'match-social 等 ready');
  // 本机没有这一场：照旧「加载中…」等云端
  const q = load('pages/match/match.js', { navigateTo() {} }, {
    '../../utils/cloud': { call: () => new Promise(() => {}) },
    '../../utils/db': { cachedMatchesAll: () => [], cachedPlayersFull: () => [], fetchPlayersFull: async () => [], myOpenid: async () => '', matchesShared: async () => [] },
  });
  q.onLoad({ id: 'm9' });
  assert.strictEqual(q.data.loading, true); assert.strictEqual(q.data.m, null);
});

function scorePage(peek, fresh) {
  const deps = {
    '../../utils/db': {
      peekDrawDetail: () => peek, cachedMatches: () => [], cachedProfile: () => ({ name: '小明' }), cachedOpenid: () => 'me',
      fetchDrawDetail: () => fresh.p, matchesShared: async () => [], myOpenid: async () => 'me',
    },
    '../../utils/member': { isAdminLocal: () => false },
    '../../utils/scorer': { loadDraft: () => null, sameEv: () => false, sameCfg: () => false, takePending: () => '' },
  };
  return load('pages/score/score.js', { setNavigationBarTitle() {} }, deps);
}

test('活动录分页：从活动详情点进来先用刚读到的活动显示；云端结果一样就不重画（不冲掉正在填的局分），变了才按最新的重画', async () => {
  const key = E.scheduleOf(drawnDraw(), [])[0].key;
  const fresh = later();
  const p = scorePage({ draw: drawnDraw(), profile: { name: '小明' }, signups: [] }, fresh);
  p.onLoad({ drawId: 'd2', key });
  assert.strictEqual(p.data.loading, false); assert.strictEqual(p.data.editing, true); assert.strictEqual(p.data.canEdit, true);
  assert.deepStrictEqual([p.data.aLabel, p.data.bLabel], ['小明', '阿杰']);
  p.setData({ init: [{ a: 3, b: 1 }] }); // 正在填
  const n = p.sets();
  fresh.ok({ draw: drawnDraw(), profile: { name: '小明' }, signups: [] });
  await tick(); await tick();
  assert.strictEqual(p.sets(), n, '一样：不重画');
  assert.deepStrictEqual(plain(p.data.init), [{ a: 3, b: 1 }]);
  // 对阵版本变了：按最新的重画
  const f2 = later();
  const q = scorePage({ draw: drawnDraw(), profile: { name: '小明' }, signups: [] }, f2);
  q.onLoad({ drawId: 'd2', key });
  q.setData({ init: [{ a: 3, b: 1 }] });
  f2.ok({ draw: Object.assign(drawnDraw(), { drawVersion: 2 }), profile: { name: '小明' }, signups: [] });
  await tick(); await tick();
  assert.deepStrictEqual(plain(q.data.init), []); assert.strictEqual(q.drawVersion, 2);
  // 没有活动详情刚读到的数据（直接打开）：照旧「加载中…」等云端
  const r = scorePage(null, later());
  r.onLoad({ drawId: 'd2', key });
  assert.strictEqual(r.data.loading, true);
  // 本机数据里找不到这一场：不显示错误，等云端
  const s = scorePage({ draw: drawnDraw(), profile: null, signups: [] }, later());
  s.onLoad({ drawId: 'd2', key: 'x-9' });
  assert.strictEqual(s.data.error, ''); assert.strictEqual(s.data.loading, true);
});

test('内存缓存 peek / put：有效期内同步取到，过期、正在读、作废后取不到', async () => {
  const memo = require('../utils/memo');
  memo.invalidate();
  memo.put('k', memo.ANY, { a: 1 });
  assert.deepStrictEqual(memo.peek('k'), { a: 1 });
  assert.deepStrictEqual(await memo.raw('k', memo.ANY, () => { throw new Error('不该再读'); }), { a: 1 });
  memo.invalidate(['matches']);
  assert.strictEqual(memo.peek('k'), undefined, 'ANY：任何写操作都作废');
  const slow = later();
  const t = memo.raw('s', 'x', () => slow.p);
  assert.strictEqual(memo.peek('s'), undefined, '正在读');
  slow.ok(2); await t;
  assert.strictEqual(memo.peek('s'), 2);
  const real = Date.now;
  try { const t0 = real(); Date.now = () => t0 + memo.TTL_MS + 1; assert.strictEqual(memo.peek('s'), undefined, '过期'); } finally { Date.now = real; }
  memo.invalidate();
});

test('成员管理：60 秒内读到过成员列表（活动详情 / 创建页给管理员预读过）就先显示，再实时读一次更正', async () => {
  const fresh = later();
  const old = { active: [{ uid: 'a', nickname: 'Ann', gender: 'f' }], pending: [], others: [], candidates: [] };
  const v = load('pages/members/members.js', { showModal() {} }, { '../../utils/cloud': { peek: (a) => (a === 'listMembers' ? old : undefined), fresh: () => fresh.p } });
  const loading = v.load();
  assert.strictEqual(v.data.loading, false); assert.strictEqual(v.data.activeList.length, 1);
  fresh.ok({ active: old.active.concat([{ uid: 'b', nickname: 'Bob', gender: '' }]), pending: [], others: [], candidates: [] });
  await loading;
  assert.strictEqual(v.data.activeList.length, 2); assert.strictEqual(v.data.noGender, 1);
  // 没有读到过：照旧等
  const w = load('pages/members/members.js', { showModal() {} }, { '../../utils/cloud': { peek: () => undefined, fresh: () => new Promise(() => {}) } });
  w.load();
  assert.strictEqual(w.data.loading, true);
});

test('活动详情：管理员打开报名中的活动顺手预读成员列表（一次），「＋ 添加报名」直接用；读的时候按钮写「读取成员…」', async () => {
  const asked = [];
  const db = {
    cachedDraws: () => [], fetchDrawDetail: async () => ({ draw: signupDraw(), profile: null, signups: [] }),
    matchesShared: async () => [], myOpenid: async () => 'me', fetchPlayersFull: async () => [], cachedMatches: () => [],
  };
  const cloud = { cached: async (a) => { asked.push(a); return { active: [] }; } };
  const v = load('pages/draw-view/draw-view.js', { setNavigationBarTitle() {} }, { '../../utils/db': db, '../../utils/cloud': cloud, '../../utils/member': { isAdminLocal: () => true } });
  v.makeCover = () => {}; v.id = 'd1';
  await v.load(); await v.load();
  assert.deepStrictEqual(asked, ['listMembers'], '只预读一次');
  const u = load('pages/draw-view/draw-view.js', { setNavigationBarTitle() {} }, { '../../utils/db': db, '../../utils/cloud': cloud, '../../utils/member': { isAdminLocal: () => false } });
  u.makeCover = () => {}; u.id = 'd1';
  await u.load();
  assert.strictEqual(asked.length, 1, '不是管理员不预读');
  assert.ok(read('pages/draw-view/draw-view.wxml').indexOf("{{adminBusy ? '读取成员…' : '＋ 添加报名'}}") >= 0);
  assert.ok(/cloud\.cached\('listMembers'\)/.test(read('pages/draw-new/draw-new.js')), '创建页也预读');
});

test('编辑活动信息：本机记得是管理员就先用活动详情刚读到的活动填好；云端一样不重填（不冲掉正在改的），不是管理员就收起', async () => {
  const mk = (known, member, draw) => {
    const st = later(), got = later();
    const p = load('pages/event-edit/event-edit.js', { setNavigationBarTitle() {} }, {
      '../../utils/db': { peekDrawDetail: () => ({ draw: signupDraw() }), cachedOpenid: () => 'boss', getDraw: () => got.p },
      '../../utils/member': { knownActive: () => known, isAdminLocal: () => known, status: () => st.p },
    });
    p.onLoad({ id: 'd1' });
    return { p, done: async () => { st.ok(member); got.ok(draw || signupDraw()); await tick(); await tick(); } };
  };
  const a = mk(true, { status: 'active', isAdmin: true, uid: 'boss' });
  assert.strictEqual(a.p.data.loading, false); assert.strictEqual(a.p.data.title, '周六约球');
  a.p.onTitle({ detail: { value: '周六约球（改）' } });
  await a.done();
  assert.strictEqual(a.p.data.title, '周六约球（改）', '一样：不重填');
  const b = mk(true, { status: 'active', isAdmin: false, uid: 'x' });
  await b.done();
  assert.match(b.p.data.error, /只有管理员/); assert.strictEqual(b.p.data.value, null);
  const c = mk(false, { status: 'active', isAdmin: true, uid: 'boss' });
  assert.strictEqual(c.p.data.loading, true, '本机不记得是管理员：照旧等');
  const d = mk(true, { status: 'active', isAdmin: true, uid: 'boss' }, Object.assign(signupDraw(), { title: '别人改过的名称' }));
  await d.done();
  assert.strictEqual(d.p.data.title, '别人改过的名称', '变了就按最新的重填');
});

test('修改活动规则：先用活动详情刚读到的活动填好；云端一样不重填，变了（规则版本不同）才按最新的重填', async () => {
  const mk = (fresh) => {
    const got = later();
    const draw = { _id: 'd1', title: '周六约球', mode: 'groups', groupCount: 2, type: 'single', status: 'signup', settingsVersion: 3, limit: 8 };
    const p = load('pages/draw-new/draw-new.js', { setNavigationBarTitle() {} }, { '../../utils/db': { peekDrawDetail: () => ({ draw }), getDraw: () => got.p } });
    p.drawId = 'd1'; p.selected = []; p.seeds = []; p.players = [];
    p.setData({ editingSettings: true, settingsLoading: true });
    const t = p.loadSettings();
    return { p, done: async () => { got.ok(Object.assign({}, draw, fresh)); await t; } };
  };
  const a = mk({});
  assert.deepStrictEqual([a.p.data.settingsLoading, a.p.data.mode, a.p.data.limit, a.p.settingsVersion], [false, 'groups', 8, 3]);
  a.p.setData({ limit: 12 }); // 正在改
  await a.done();
  assert.strictEqual(a.p.data.limit, 12);
  const b = mk({ settingsVersion: 4, limit: 6 });
  b.p.setData({ limit: 12 });
  await b.done();
  assert.deepStrictEqual([b.p.data.limit, b.p.settingsVersion], [6, 4]);
});

module.exports = T;
