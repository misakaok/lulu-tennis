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
    peekDrawDetail: () => null, cachedDrawSignups: () => null, playersShared: async () => [], profilesOf: () => ({}),
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
  // 页面：名单读完前先空着（不写读取中的提示），报名、取消、添加报名、生成对阵、删除、手动调整对阵都要 ready
  const xml = read('pages/draw-view/draw-view.wxml');
  assert.ok(/wx:if="\{\{!ready && !signups.length\}\}" class="muted"><\/view>/.test(xml), '名单读完前先空着');
  assert.ok(/wx:elif="\{\{ready && !signups.length\}\}" class="muted">还没有人报名/.test(xml), '读完前不说「还没有人报名」');
  ['ready && joined', 'ready && signing && !joined', 'canEdit && ready', 'ready && canEdit && (!isRot || canPublish)', 'ready && canManage', 'ready && canEditMatchups']
    .forEach((c) => assert.ok(xml.indexOf(`wx:if="{{${c}}}"`) >= 0, c));
});

test('活动详情：本机缓存没有这个活动照常等云端；只画过缓存、云端读不到时不留着缓存的内容', async () => {
  const base = { peekDrawDetail: () => null, cachedDrawSignups: () => null, playersShared: async () => [], profilesOf: () => ({}), cachedMatches: () => [], cachedProfile: () => null, cachedOpenid: () => '', cachedPlayersFull: () => [], matchesShared: async () => [], myOpenid: async () => '' };
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
    peekDrawDetail: () => null, cachedDrawSignups: () => null, playersShared: async () => [], profilesOf: () => ({}),
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
  const rec = { _id: 'm1', date: '2026-11-20', a: ['我'], b: ['对手'], aIds: ['me'], bIds: ['op'], aKeys: ['me'], bKeys: ['op'], winner: 'a', sets: [{ a: 6, b: 3 }], type: 'single', status: 'official' };
  const p = load('pages/match/match.js', { navigateTo() {} }, {
    '../../utils/cloud': { call: () => st.p },
    '../../utils/db': {
      cachedMatchesAll: () => [rec], cachedPlayersFull: () => [], fetchPlayersFull: async () => [], cachedMatches: () => [rec],
      cachedOpenid: () => 'me', myOpenid: async () => 'me', matchesShared: async () => [rec],
    },
    '../../utils/member': { knownActive: () => true, isAdminLocal: () => false },
  });
  p.onLoad({ id: 'm1' });
  assert.strictEqual(p.data.loading, false, '不显示「加载中…」');
  assert.strictEqual(p.data.ready, false);
  assert.deepStrictEqual([p.data.m.bigA, p.data.m.bigB, p.data.m.bigLbl, p.data.m.a[0].name], [6, 3, '局分', '我']);
  // 「这场的水平分」和亮点标签也先用本机战绩算好，云端读完不再插进一张卡片（不闪）
  assert.ok(p.data.why && !p.data.why.none, '水平分说明先显示');
  const why0 = JSON.stringify(p.data.why);
  assert.strictEqual(p.data.sheen, true, '这次启动第一次打开：记分牌扫一次高光');
  st.ok({ match: rec, status: 'official', matchId: 'm1', changes: [{ who: '我', how: 'edit', from: '6-4', to: '6-3', at: 1 }] });
  await tick(); await tick();
  assert.strictEqual(p.data.ready, true); assert.strictEqual(p.data.changes.length, 1);
  assert.strictEqual(JSON.stringify(p.data.why), why0, '云端读完水平分说明不变');
  assert.strictEqual(p.data.preset.matchId, 'm1');
  const xml = read('pages/match/match.wxml');
  assert.ok(/<view wx:if="\{\{ready \|\| preset\}\}" class="\{\{previewSocial \? '' : 'late'\}\}"><match-social /.test(xml), "match-social：普通日常比赛先画预览、不淡入，其他等 ready 淡入");
  assert.ok(!/正在读取/.test(xml), '比赛详情读云端期间不放「正在读取」占位文字');
  // 本机没有这一场：照旧等云端（页面先空着）
  const q = load('pages/match/match.js', { navigateTo() {} }, {
    '../../utils/cloud': { call: () => new Promise(() => {}) },
    '../../utils/db': { cachedMatchesAll: () => [], cachedPlayersFull: () => [], fetchPlayersFull: async () => [], myOpenid: async () => '', matchesShared: async () => [] },
    '../../utils/member': { knownActive: () => true, isAdminLocal: () => false },
  });
  q.onLoad({ id: 'm9' });
  assert.strictEqual(q.data.loading, true); assert.strictEqual(q.data.m, null);
  assert.strictEqual(q.data.sheen, false, '再打开别的比赛不再扫高光');
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
  // 没有活动详情刚读到的数据（直接打开）：照旧等云端（页面先空着）
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
  const v = load('pkg-manage/members/members.js', { showModal() {} }, { '../../utils/cloud': { peek: (a) => (a === 'listMembers' ? old : undefined), fresh: () => fresh.p } });
  const loading = v.load();
  assert.strictEqual(v.data.loading, false); assert.strictEqual(v.data.activeList.length, 1);
  fresh.ok({ active: old.active.concat([{ uid: 'b', nickname: 'Bob', gender: '' }]), pending: [], others: [], candidates: [] });
  await loading;
  assert.strictEqual(v.data.activeList.length, 2); assert.strictEqual(v.data.noGender, 1);
  // 没有读到过：照旧等
  const w = load('pkg-manage/members/members.js', { showModal() {} }, { '../../utils/cloud': { peek: () => undefined, fresh: () => new Promise(() => {}) } });
  w.load();
  assert.strictEqual(w.data.loading, true);
});

test('活动详情：管理员打开报名中的活动顺手预读成员列表（一次），「＋ 添加报名」直接用；读的时候按钮写「读取成员…」', async () => {
  const asked = [];
  const db = {
    peekDrawDetail: () => null, cachedDrawSignups: () => null, playersShared: async () => [], profilesOf: () => ({}),
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
  assert.ok(/cloud\.cached\('listMembers'\)/.test(read('pkg-manage/draw-new/draw-new.js')), '创建页也预读');
});

test('编辑活动信息：本机记得是管理员就先用活动详情刚读到的活动填好；云端一样不重填（不冲掉正在改的），不是管理员就收起', async () => {
  const mk = (known, member, draw) => {
    const st = later(), got = later();
    const p = load('pkg-manage/event-edit/event-edit.js', { setNavigationBarTitle() {} }, {
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
    const p = load('pkg-manage/draw-new/draw-new.js', { setNavigationBarTitle() {} }, { '../../utils/db': { peekDrawDetail: () => ({ draw }), getDraw: () => got.p } });
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

/* ---------- 活动详情秒开与去闪烁（2026-11-24） ---------- */
// 活动详情页：db 只给出用到的；cloud.call 可控
function viewPage(dbOver, opt) {
  opt = opt || {};
  const calls = [];
  const db = Object.assign({
    peekDrawDetail: () => null, cachedDrawSignups: () => null, cachedDraws: () => [], cachedMatches: () => [], cachedPlayersFull: () => [],
    cachedProfile: () => ({ name: '小明' }), cachedOpenid: () => 'me', profilesOf: () => ({}),
    matchesShared: async () => [], playersShared: async () => [], myOpenid: async () => 'me',
  }, dbOver);
  const v = load('pages/draw-view/draw-view.js', { setNavigationBarTitle() {}, pageScrollTo() {} }, {
    '../../utils/db': db,
    '../../utils/member': { isAdminLocal: () => opt.admin !== false },
    '../../utils/cloud': { call: (a, d) => { calls.push(a); return opt.call ? opt.call(a, d) : Promise.resolve({}); }, cached: async () => ({ active: [] }) },
  });
  const raw = v.setData;
  v.payloads = [];
  v.setData = function (p) { this.payloads.push(Object.keys(p)); return raw.call(this, p); };
  v.makeCover = () => {};
  v.calls = calls;
  return v;
}
const cupSignup = () => Object.assign(signupDraw(), { cup: { kind: 'weekly', pointGroup: 'open', scoreVersion: 2 } });
const cupDrawn = () => Object.assign(drawnDraw(), { cup: { kind: 'weekly', pointGroup: 'open', scoreVersion: 2 } });

test('积分标签不闪：报名中的积分活动第一帧（本机缓存）就能点；顶部内容一次 setData；已生成对阵的回到本页不先收起再出现', async () => {
  const detail = later();
  const v = viewPage({ cachedDraws: () => [cupSignup()], fetchDrawDetail: () => detail.p });
  v.onLoad({ id: 'd1' });
  assert.deepStrictEqual([v.data.cupTag, v.data.canEditCup, v.data.ready], ['LULU 积分 · 周赛', true, false], '本机缓存那一帧就定下来');
  const top = v.payloads.find((k) => k.includes('cupTag'));
  ['draw', 'canEditCup', 'isOwner', 'canEdit', 'canManage', 'info', 'rulesSum'].forEach((k) => assert.ok(top.includes(k), k + ' 和标签同一次 setData'));
  await v.editCupKind();
  assert.deepStrictEqual(v.calls, [], '没读完（ready 为假）点了不处理');
  detail.ok({ draw: cupSignup(), profile: { name: '小明' }, signups: [] });
  await tick(); await tick(); await tick();
  assert.strictEqual(v.data.ready, true);
  assert.ok(!v.payloads.some((k, i) => i > 0 && k.length === 1 && k[0] === 'canEditCup'), '没有单独改 canEditCup 的一帧');
  // 不是管理员：一直是不能点的标签
  const u = viewPage({ cachedDraws: () => [cupSignup()], fetchDrawDetail: () => new Promise(() => {}) }, { admin: false });
  u.onLoad({ id: 'd1' });
  assert.deepStrictEqual([u.data.cupTag, u.data.canEditCup], ['LULU 积分 · 周赛', false]);

  // 已生成对阵：canEditCup 由云端结算情况决定；回到本页（onShow → load）时保持原样，等 cupFromDraw 回来再更正
  let gate = null;
  const w = viewPage({ cachedDraws: () => [cupDrawn()], fetchDrawDetail: async () => ({ draw: cupDrawn(), profile: { name: '小明' }, signups: [], requests: { list: [], owner: false, myEntrants: [], withdrawals: [] } }) },
    { call: (a) => (a === 'cupFromDraw' ? (gate ? gate.p : Promise.resolve({ stop: null })) : Promise.resolve({})) });
  w.onLoad({ id: 'd2' });
  assert.strictEqual(w.data.canEditCup, false, '还不知道有没有结算：先按不能点');
  for (let i = 0; i < 6; i++) await tick();
  assert.strictEqual(w.data.canEditCup, true, '云端说还没结算：能点');
  gate = later();
  w.onShow(); // 紧接着 onLoad 的第一次 onShow：不重复读
  assert.strictEqual(w.calls.filter((a) => a === 'cupFromDraw').length, 1);
  w.onShow(); // 从子页面回来
  for (let i = 0; i < 6; i++) await tick();
  assert.strictEqual(w.data.canEditCup, true, '结算情况还在读：不先收起');
  gate.ok({ stop: { status: 'published' } });
  for (let i = 0; i < 4; i++) await tick();
  assert.strictEqual(w.data.canEditCup, false, '已经结算过：按云端收起');
  const css = read('pages/draw-view/draw-view.wxss');
  assert.ok(/\.h-cup \.ui-tag \{[^}]*min-height: 48rpx/.test(css), '能点、不能点的标签一样高');
});

test('报名名单秒出：本机记着上次的名单（或 60 秒内读过的详情）就先显示人数和名单，ready 仍为假、报名 / 取消等按钮不显示', async () => {
  const detail = later();
  const old = [{ _id: 's1', name: '小明', _openid: 'me', createdAt: 1 }, { _id: 's2', name: '阿杰', _openid: 'jie', createdAt: 2 }];
  const v = viewPage({ cachedDraws: () => [signupDraw()], cachedDrawSignups: (id) => (id === 'd1' ? old : null), fetchDrawDetail: () => detail.p });
  v.onLoad({ id: 'd1' });
  await tick();
  assert.deepStrictEqual([v.data.signups.length, v.data.signCount, v.data.ready], [2, '2 人', false]);
  assert.ok(v.data.signText, '报名情况文字也先显示');
  const xml = read('pages/draw-view/draw-view.wxml');
  ['ready && joined', 'ready && signing && !joined', 'canEdit && ready'].forEach((c) => assert.ok(xml.indexOf(`wx:if="{{${c}}}"`) >= 0, c + '：预览时不显示'));
  // 云端读完按最新的更正（阿杰取消了）
  detail.ok({ draw: signupDraw(), profile: { name: '小明' }, signups: old.slice(0, 1) });
  for (let i = 0; i < 4; i++) await tick();
  assert.deepStrictEqual([v.data.signups.length, v.data.signCount, v.data.ready, v.data.joined], [1, '1 人', true, true]);
  // 60 秒内读过（内存里的详情）：优先用它
  const peek = { draw: signupDraw(), profile: { name: '小明' }, signups: old };
  const p = viewPage({ peekDrawDetail: () => peek, cachedDrawSignups: () => [], fetchDrawDetail: () => new Promise(() => {}) });
  p.onLoad({ id: 'd1' });
  await tick();
  assert.deepStrictEqual([p.data.draw.title, p.data.signups.length, p.data.ready], ['周六约球', 2, false]);
  // 本机什么都没有：名单先空着，等云端
  const q = viewPage({ cachedDraws: () => [signupDraw()], fetchDrawDetail: () => new Promise(() => {}) });
  q.onLoad({ id: 'd1' });
  await tick();
  assert.deepStrictEqual([q.data.signups.length, q.data.signCount], [0, '']);
});

test('报名名单不等全部战绩：drawDetail 先回来就先用本机的比赛 / 球员画出人数和名单，共享数据回来后再更新排名', async () => {
  const ms = later(), ps = later();
  const su = [{ _id: 's1', name: '小明', _openid: 'me', createdAt: 1 }];
  const v = viewPage({
    cachedDraws: () => [], fetchDrawDetail: async () => ({ draw: signupDraw(), profile: { name: '小明' }, signups: su }),
    matchesShared: () => ms.p, playersShared: () => ps.p,
    cachedPlayersFull: () => [{ name: '小明', uid: 'me', self: true, shown: true }],
  });
  v.onLoad({ id: 'd1' });
  for (let i = 0; i < 4; i++) await tick();
  assert.deepStrictEqual([v.data.signCount, v.data.signups.length, v.data.ready, v.data.joined], ['1 人', 1, true, true], '全部战绩还在读，名单已经出来');
  assert.strictEqual(v.data.signups[0].played, '暂无');
  // 全部战绩和球员回来：按最新的重算场数
  const rec = { _id: 'm1', date: '2026-11-01', a: ['小明'], b: ['阿杰'], aIds: ['me'], bIds: ['jie'], aKeys: ['me'], bKeys: ['jie'], winner: 'a', sets: [{ a: 6, b: 2 }], type: 'single' };
  ms.ok([rec]); ps.ok([{ name: '小明', uid: 'me', self: true, shown: true }, { name: '阿杰', uid: 'jie', self: true, shown: true }]);
  for (let i = 0; i < 6; i++) await tick();
  assert.strictEqual(v.data.signups[0].played, '1 场');
  assert.strictEqual(v.calls.length, 0, '没有多调云函数');
  // 已生成对阵的活动：退赛申请随 drawDetail 回来，战绩还在读时就和 ready 一起出来；积分结算等战绩回来再查（只查一次）
  const ms2 = later();
  const w = viewPage({
    cachedDraws: () => [], matchesShared: () => ms2.p,
    fetchDrawDetail: async () => ({ draw: cupDrawn(), profile: { name: '小明' }, signups: [], requests: { list: [], owner: false, myEntrants: ['小明'], withdrawals: [] } }),
  }, { call: () => Promise.resolve({ stop: null }) });
  w.loadRequests = () => { throw new Error('不该单独读申请'); };
  w.onLoad({ id: 'd2' });
  for (let i = 0; i < 4; i++) await tick();
  assert.deepStrictEqual([w.data.ready, w.data.canWithdraw], [true, true], '战绩还在读，退赛申请已经出来');
  assert.strictEqual(w.calls.filter((a) => a === 'cupFromDraw').length, 0);
  ms2.ok([]);
  for (let i = 0; i < 6; i++) await tick();
  assert.strictEqual(w.calls.filter((a) => a === 'cupFromDraw').length, 1);
  assert.strictEqual(w.data.canWithdraw, true);
});

// 真实的 utils（db / memo / cloud / member），云函数由测试控制
function realClient(handler) {
  const storage = { member_ok_at: Date.now(), my_openid: 'me' };
  const calls = [];
  global.wx = {
    getStorageSync: (k) => storage[k], setStorageSync: (k, v) => { storage[k] = plain(v); }, setStorage: ({ key, data, success }) => { storage[key] = plain(data); if (success) success(); },
    removeStorageSync: (k) => { delete storage[k]; }, getStorageInfoSync: () => ({ keys: Object.keys(storage) }), reLaunch() {}, showToast() {},
    cloud: { callFunction: async ({ data }) => { calls.push(data.action); return { result: await handler(data) }; } },
  };
  global.getCurrentPages = () => [];
  Object.keys(require.cache).forEach((k) => { if (k.startsWith(path.join(ROOT, 'utils'))) delete require.cache[k]; });
  const req = (m) => require(path.join(ROOT, 'utils', m + '.js'));
  return { db: req('db'), memo: req('memo'), member: req('member'), storage, calls };
}
test('点卡片预取活动详情：详情页第一次读取接过这个请求（只调 1 次云函数），只接一次；期间有写操作 / 清缓存就不用', async () => {
  let n = 0;
  const c = realClient(async (d) => (d.action === 'drawDetail' ? { ok: true, draw: { _id: d.drawId, title: 'T' + (++n), status: 'signup' }, profile: null, signups: [{ _id: 's' + n }] } : { ok: true }));
  c.db.prefetchDrawDetail('d1');
  const r = await c.db.fetchDrawDetail('d1');
  assert.deepStrictEqual([r.draw.title, c.calls.filter((a) => a === 'drawDetail').length], ['T1', 1], '接过预取的请求');
  assert.strictEqual((await c.db.fetchDrawDetail('d1')).draw.title, 'T2', '只接一次：刷新照常发新请求');
  // 预取之后有写操作（缓存作废）：不用旧的
  c.db.prefetchDrawDetail('d1');
  await new Promise((res) => setTimeout(res, 0));
  c.memo.invalidate();
  assert.strictEqual((await c.db.fetchDrawDetail('d1')).draw.title, 'T4');
  // 退出成员身份：预取的作废
  c.db.prefetchDrawDetail('d1');
  c.member.clearProtected();
  c.storage.member_ok_at = Date.now();
  assert.strictEqual((await c.db.fetchDrawDetail('d1')).draw.title, 'T6');
  // 双击卡片：同一个活动只发一次
  const before = c.calls.filter((a) => a === 'drawDetail').length;
  c.db.prefetchDrawDetail('d1'); c.db.prefetchDrawDetail('d1');
  assert.strictEqual(c.calls.filter((a) => a === 'drawDetail').length, before + 1, '连点两次只发一次');
  assert.strictEqual((await c.db.fetchDrawDetail('d1')).draw.title, 'T7');
  // 别的活动的预取不影响
  c.db.prefetchDrawDetail('d9');
  assert.strictEqual((await c.db.fetchDrawDetail('d1')).draw.title, 'T9');
  // 报名名单记在本机（受保护缓存），最多 10 个活动；退出成员身份时清掉
  assert.deepStrictEqual(c.db.cachedDrawSignups('d1'), [{ _id: 's9' }]);
  for (let i = 0; i < 12; i++) await c.db.fetchDrawDetail('x' + i);
  assert.strictEqual(Object.keys(c.storage.cache_draw_signups).length, 10);
  assert.ok(c.db.cachedDrawSignups('x11') && !c.db.cachedDrawSignups('x0'));
  c.member.clearProtected();
  assert.strictEqual(c.storage.cache_draw_signups, undefined);
  delete global.wx;
});

// 比赛详情的「比分状态」秒出（2026-11-25 用户嫌从战绩点进日常比赛时下面那块晚出来）
function matchPage(rec, opts) {
  opts = opts || {};
  const calls = [], used = [];
  const st = later();
  const p = load('pages/match/match.js', { navigateTo() {} }, {
    '../../utils/cloud': { call: (a, d) => { calls.push(a); return st.p; } },
    '../../utils/db': {
      cachedMatchesAll: () => [rec], cachedPlayersFull: () => [], cachedMatches: () => [rec], cachedOpenid: () => opts.me || 'me',
      myOpenid: async () => opts.me || 'me', matchesShared: async () => [rec],
      playersShared: async () => { used.push('playersShared'); return []; }, fetchPlayersFull: async () => { used.push('fetchPlayersFull'); return []; },
      fetchMatchState: (id) => { calls.push('fetchMatchState:' + id); return st.p; },
    },
    '../../utils/member': { knownActive: () => true, isAdminLocal: () => !!opts.admin },
  });
  return { p, st, calls, used };
}
const dailyRec = (x) => Object.assign({ _id: 'm1', date: '2026-11-20', a: ['我'], b: ['对手'], aIds: ['me'], bIds: ['op'], aKeys: ['me'], bKeys: ['op'], winner: 'a', sets: [{ a: 6, b: 3 }], type: 'single', status: 'official', _openid: 'op' }, x || {});
const cloudState = (x) => Object.assign({ matchId: 'm1', match: dailyRec(), status: 'official', changes: [], finished: true, daily: true, confirmed: false, drawId: '', drawKey: '', outcome: 'normal', sides: { a: '', b: '录入' }, mySide: 'a', canConfirm: false, unbound: false, request: null, canEdit: true, canRequestChange: false, canAdminFix: false }, x || {});

test('比赛详情：普通日常比赛第一帧就按本机身份画出「比分状态」（预览），云端回来原样替换；管理员被撤销时按钮按云端收起', async () => {
  const a = matchPage(dailyRec(), { admin: true });
  a.p.onLoad({ id: 'm1' });
  const pre = a.p.data.preset;
  assert.strictEqual(a.p.data.ready, false);
  assert.strictEqual(a.p.data.previewSocial, true);
  assert.deepStrictEqual([pre.preview, pre.matchId, pre.daily, pre.finished, pre.confirmed, pre.mySide], [true, 'm1', true, true, false, 'a']);
  assert.deepStrictEqual([pre.canEdit, pre.canAdminFix, pre.canAdminRevoke, pre.canRequestChange, pre.reason], [true, true, true, false, '']);
  assert.strictEqual(a.p.data.revocable, true, '参加者可以撤销');
  assert.deepStrictEqual(a.calls, ['fetchMatchState:m1'], '接过点卡片时预读的 matchState，不另发');
  // 云端：其实已经不是管理员了
  a.st.ok(cloudState({ canAdminFix: false }));
  for (let i = 0; i < 4; i++) await tick();
  assert.strictEqual(a.p.data.ready, true);
  assert.strictEqual(a.p.data.preset.preview, undefined, '换成云端的正式状态');
  assert.deepStrictEqual([a.p.data.preset.canAdminFix, !!a.p.data.preset.canAdminRevoke], [false, false]);
  assert.strictEqual(a.p.data.previewSocial, true, '卡片已经在了，不再淡入一次');
  assert.deepStrictEqual(a.used, ['playersShared'], '球员用共享版（不复制）');
  // 不是参加者、也不是录入人：没有修改、撤销，写明原因
  const b = matchPage(dailyRec({ aIds: ['x'], aKeys: ['x'] }), { me: 'me' });
  b.p.onLoad({ id: 'm1' });
  assert.deepStrictEqual([b.p.data.preset.mySide, b.p.data.preset.canEdit, b.p.data.preset.canAdminFix, b.p.data.revocable], ['', false, false, false]);
  assert.match(b.p.data.preset.reason, /不是这场比赛的参加者/);
  // 录入人（不在场上）也能改、能撤销
  const c = matchPage(dailyRec({ aIds: ['x'], aKeys: ['x'], _openid: 'me' }));
  c.p.onLoad({ id: 'm1' });
  assert.deepStrictEqual([c.p.data.preset.canEdit, c.p.data.revocable], [true, true]);
});

test('比赛详情：活动比赛、待确认、弃权 / 退赛、管理员更正过的不猜「比分状态」，等云端 ready 再淡入', () => {
  [{ drawId: 'd1', drawKey: '0-0' }, { status: 'pending' }, { outcome: 'walkover' }, { outcome: 'retired' }, { walkover: true }, { lastChange: { how: 'admin' } }].forEach((x) => {
    const a = matchPage(dailyRec(x), { admin: true });
    a.p.onLoad({ id: 'm1' });
    assert.ok(a.p.data.m, '记分牌照样先画');
    assert.deepStrictEqual([a.p.data.preset, a.p.data.previewSocial], [null, false], JSON.stringify(x));
  });
  const xml = read('pages/match/match.wxml');
  const expr = xml.match(/<view wx:if="\{\{([^"]+)\}\}" class="[^"]*"><match-social /)[1];
  const show = new Function('ready', 'preset', 'return !!(' + expr + ')');
  assert.deepStrictEqual([show(false, null), show(true, null), show(false, { preview: true })], [false, true, true]);
});

test('比赛详情：从改分页回来连读两次，先发的后回来不覆盖', async () => {
  const st1 = later(), st2 = later();
  const queue = [st1.p, st2.p];
  const rec = dailyRec();
  const p = load('pages/match/match.js', { navigateTo() {} }, {
    '../../utils/cloud': { call: () => new Promise(() => {}) },
    '../../utils/db': {
      cachedMatchesAll: () => [rec], cachedPlayersFull: () => [], cachedMatches: () => [rec], cachedOpenid: () => 'me',
      myOpenid: async () => 'me', matchesShared: async () => [rec], playersShared: async () => [], fetchMatchState: () => queue.shift(),
    },
    '../../utils/member': { knownActive: () => true, isAdminLocal: () => false },
  });
  p.onLoad({ id: 'm1' }); p.onShow(); p.onShow();
  st2.ok(cloudState({ changes: [{ who: '我', how: 'edit', from: '6-4', to: '6-3', at: 1 }, { who: '我', how: 'edit', from: '6-3', to: '6-2', at: 2 }] }));
  for (let i = 0; i < 4; i++) await tick();
  assert.strictEqual(p.data.changes.length, 2);
  st1.ok(cloudState());
  for (let i = 0; i < 4; i++) await tick();
  assert.strictEqual(p.data.changes.length, 2, '旧结果不覆盖新结果');
});

function socialComp(call) {
  let def;
  const nav = [], modal = [];
  vm.runInNewContext(read('components/match-social/match-social.js'), {
    Component: (d) => { def = d; }, require: (id) => (/cloud$/.test(id) ? { call } : {}), console,
    wx: { navigateTo: (o) => nav.push(o.url), showModal: (o) => modal.push(o.title), showToast() {} },
  });
  const c = Object.assign({ data: Object.assign({ matchId: '', preset: null, revocable: false }, plain(def.data)), setData(p) { Object.assign(this.data, p); } }, def.methods);
  c.update = (p) => { Object.assign(c.data, p); return def.observers['matchId, preset'].call(c); };
  c.show = () => def.pageLifetimes.show.call(c);
  return { c, nav, modal };
}
test('match-social：预览态挂上后紧接着的第一次 onShow 不再发 matchState；点按钮不动作；云端状态传进来原样替换，之后从改分页回来照常刷新', async () => {
  let n = 0;
  const { c, nav, modal } = socialComp(async () => { n++; return cloudState(); });
  c.update({ matchId: 'm1', preset: { matchId: 'm1', preview: true, finished: true, daily: true, confirmed: false, sides: {}, mySide: 'a', canEdit: true, canAdminFix: true, canAdminRevoke: true } });
  assert.strictEqual(c.data.st.preview, true);
  c.show();
  assert.strictEqual(n, 0, '页面第一次 onShow 不重复读');
  c.edit(); c.adminFix(); c.requestChange(); c.revoke();
  assert.deepStrictEqual([nav, modal], [[], []], '预览态点按钮不跳转、不弹窗');
  const before = c.data.st;
  c.update({ preset: cloudState({ canAdminFix: false }) });
  assert.notStrictEqual(c.data.st, null, '替换时不先清空（不闪）');
  assert.ok(before.preview && !c.data.st.preview && c.data.st.canAdminFix === false, '按云端结果更正');
  assert.strictEqual(n, 0);
  c.edit();
  assert.deepStrictEqual(nav, ['/pkg-manage/correct/correct?matchId=m1&mode=edit'], '拿到云端结果后按钮照常');
  c.show(); await tick();
  assert.strictEqual(n, 1, '从改分页回来照常刷新');
});

test('点比赛卡片预读 matchState：比赛详情第一次读取接过去（只调 1 次），只接一次；连点只发一次；写操作 / 清缓存 / 超过 10 秒不用', async () => {
  let n = 0;
  const c = realClient(async (d) => (d.action === 'matchState' ? { ok: true, matchId: d.matchId, detail: d.detail, n: ++n } : { ok: true }));
  const cnt = () => c.calls.filter((a) => a === 'matchState').length;
  c.db.prefetchMatchState('m1');
  const r = await c.db.fetchMatchState('m1');
  assert.deepStrictEqual([r.n, r.detail, cnt()], [1, true, 1], '接过预读的请求，带 detail');
  assert.strictEqual((await c.db.fetchMatchState('m1')).n, 2, '只接一次：之后照常发新请求');
  c.db.prefetchMatchState('m1'); c.db.prefetchMatchState('m1');
  assert.strictEqual(cnt(), 3, '连点两次只发一次');
  assert.strictEqual((await c.db.fetchMatchState('m1')).n, 3);
  // 预读之后有写操作：不用
  c.db.prefetchMatchState('m1');
  c.memo.invalidate();
  assert.strictEqual((await c.db.fetchMatchState('m1')).n, 5);
  // 退出成员身份（forget）：清掉
  c.db.prefetchMatchState('m1');
  c.member.clearProtected();
  c.storage.member_ok_at = Date.now();
  assert.strictEqual((await c.db.fetchMatchState('m1')).n, 7);
  // 超过 10 秒没被接走：不用
  const now = Date.now, t0 = now();
  c.db.prefetchMatchState('m1');
  Date.now = () => t0 + 10001;
  try { assert.strictEqual((await c.db.fetchMatchState('m1')).n, 9); } finally { Date.now = now; }
  // 别的比赛的预读不影响
  c.db.prefetchMatchState('m9');
  assert.strictEqual((await c.db.fetchMatchState('m1')).n, 11);
  delete global.wx;
  // 三个入口都在跳转前预读
  [['pages/index/index.js', '  openMatch(e)'], ['pkg-manage/history/history.js', '  openMatch(e)'], ['components/player-home/player-home.js', '    openMatch(e)']].forEach(([f, head]) => {
    const src = read(f);
    const body = src.slice(src.indexOf(head), src.indexOf('},', src.indexOf(head)));
    assert.ok(/db\.prefetchMatchState\(id\);\s*wx\.navigateTo\(\{ url: '\/pages\/match\/match\?id=' \+ id \}\)/.test(body), f);
  });
});

/* ---------- 二级页秒开（2026-11-25）：先用本机 / 内存里已有的画，云端读完再更正；权限照样以云端为准 ---------- */
test('球员主页：本机记得自己的用户 ID 就同步判断，别人的主页第一帧就把 uid 交给 player-home；本机不记得时后台确认是自己再跳「我的」', async () => {
  const nav = [], titles = [];
  const wx = { hideShareMenu() {}, switchTab: (o) => nav.push(o.url), setNavigationBarTitle: (o) => titles.push(o.title) };
  const me = later();
  const mk = (cached) => load('pages/player/player.js', wx, { '../../utils/db': { cachedOpenid: () => cached, cachedProfiles: () => ({ bob: { name: 'Bob' } }), myOpenid: () => me.p } });
  const a = mk('me');
  a.onLoad({ uid: 'bob' });
  assert.deepStrictEqual([a.data.uid, titles, nav], ['bob', ['Bob 的主页'], []], '不等 myOpenid，第一帧就有 uid 和标题');
  const b = mk('me');
  b.onLoad({ uid: 'me' });
  assert.deepStrictEqual([b.data.uid, nav], ['', ['/pages/me/me']], '自己的主页直接去「我的」');
  nav.length = 0;
  const c = mk('');
  c.onLoad({ uid: 'me' });
  assert.strictEqual(c.data.uid, 'me', '本机不记得：先照常显示');
  me.ok('me'); await tick(); await tick();
  assert.deepStrictEqual(nav, ['/pages/me/me'], '后台确认是自己再跳');
});

function addPage(over) {
  const shared = later();
  const db = Object.assign({
    cachedPlayersFull: () => [{ name: '我', uid: 'me' }, { name: '阿杰', uid: 'jie' }, { name: '小周', uid: 'zhou' }],
    cachedProfile: () => ({ name: '我' }), cachedOpenid: () => 'me',
    playersShared: () => shared.p, fetchPlayersFull: async () => { throw new Error('应该用共享版'); },
    getMyProfile: async () => ({ name: '我' }), myOpenid: async () => 'me',
  }, over || {});
  const p = load('pages/add/add.js', { getStorageSync: () => ({}) }, {
    '../../utils/db': db,
    '../../utils/scorer': { takeDailyPending: () => null, loadDraft: () => null, resultOf: () => null },
  });
  return { p, shared };
}
test('记一场：打开第一帧就按本机资料把自己填进 A 方、光标落到对手；云端读完用共享球员，不冲掉已经选好的对手', async () => {
  const { p, shared } = addPage();
  p.onLoad({});
  assert.deepStrictEqual([p.slots.a[0], p.data.me, p.data.noProfile, p.active], ['我', '我', false, 'b0']);
  assert.strictEqual(p.data.slotsA[0].name, '我');
  assert.ok(p.data.chips.every((c) => c.name !== '我'), '自己不在可选名单里');
  p.pick('阿杰');
  assert.strictEqual(p.slots.b[0], '阿杰');
  const done = p.loadPlayers();
  shared.ok([{ name: '我', uid: 'me' }, { name: '阿杰', uid: 'jie' }, { name: '小周', uid: 'zhou' }, { name: '小林', uid: 'lin' }]);
  await done;
  assert.deepStrictEqual([p.slots.a[0], p.slots.b[0]], ['我', '阿杰'], '已经选好的对手保留');
  assert.ok(p.data.chips.some((c) => c.name === '小林'), '换上最新名单');
  // 本机没有资料：先不填（也不先显示「去设置资料」），等云端
  const q = addPage({ cachedProfile: () => null }).p;
  q.onLoad({});
  assert.deepStrictEqual([q.slots.a[0], q.data.noProfile, q.active], ['', false, 'a0']);
});

function correctPage(rec, over) {
  const got = later(), calls = [];
  const db = Object.assign({
    cachedMatchesAll: () => [rec], cachedPlayersFull: () => [], cachedDraws: () => [],
    getMatch: () => { calls.push('getMatch'); return got.p; }, playersShared: async () => { calls.push('playersShared'); return []; },
    fetchPlayersFull: async () => { calls.push('fetchPlayersFull'); return []; },
    getDraw: async () => { calls.push('getDraw'); return null; }, peekDrawDetail: () => null,
  }, over || {});
  const p = load('pkg-manage/correct/correct.js', { setNavigationBarTitle() {} }, { '../../utils/db': db, '../../utils/cloud': {} });
  return { p, got, calls };
}
test('改分页：先用本机战绩这一场画出表单；云端一样不重画（不冲掉正在改的局分），变了才重画；活动规则先用活动详情刚读到的', async () => {
  const rec = dailyRec({ setGames: 6, noAd: false, bestOf: 3, sets: [{ a: 6, b: 3 }, { a: 6, b: 4 }] });
  const { p, got, calls } = correctPage(rec);
  p.onLoad({ matchId: 'm1', mode: 'edit' });
  assert.deepStrictEqual([p.data.loading, p.data.aLabel, p.data.bLabel, p.data.current, p.data.setGames, p.data.noAd, p.data.bestOf], [false, '我', '对手', '6:3  6:4', 6, false, 3]);
  const init0 = p.data.init, n0 = p.sets();
  got.ok(rec); await tick(); await tick();
  assert.strictEqual(p.data.init, init0, '内容一样：不重画（局分组件不会被重置）');
  assert.strictEqual(p.sets(), n0);
  assert.ok(calls.includes('playersShared') && !calls.includes('fetchPlayersFull'), '球员用共享版');
  // 别人刚改过比分：按最新的重画
  const b = correctPage(rec);
  b.p.onLoad({ matchId: 'm1', mode: 'edit' });
  b.got.ok(Object.assign({}, rec, { sets: [{ a: 6, b: 3 }, { a: 7, b: 5 }] })); await tick(); await tick();
  assert.deepStrictEqual([b.p.data.current, plain(b.p.data.init)], ['6:3  7:5', [{ a: 6, b: 3 }, { a: 7, b: 5 }]]);
  // 活动比赛：活动详情 60 秒内读过就直接用它的规则，不另读活动
  const draw = { _id: 'd1', title: 'T', mode: 'bracket', size: 2, rules: { ko: { setGames: 6, noAd: true, bestOf: 1 } } };
  const ev = dailyRec({ drawId: 'd1', drawKey: '0-0', setGames: 4, sets: [{ a: 6, b: 2 }] });
  const c = correctPage(ev, { peekDrawDetail: () => ({ draw }) });
  c.p.onLoad({ matchId: 'm1', mode: 'admin' });
  assert.strictEqual(c.p.data.setGames, 6, '第一帧就是活动这一场的规则');
  c.got.ok(ev); await tick(); await tick();
  assert.ok(!c.calls.includes('getDraw'));
  // 本机没有这一场：照旧等云端
  const d = correctPage(dailyRec({ _id: 'zz' }));
  d.p.onLoad({ matchId: 'm1', mode: 'edit' });
  assert.strictEqual(d.p.data.loading, true);
});

test('我的积分：60 秒内读过的 cupList 或积分榜存在本机的上次结果（只认同一账号）第一帧就画；云端读不到时保留画面、只轻提示', async () => {
  const toasts = [];
  const mk = (peek, stored, cached) => load('pkg-manage/cup-mine/cup-mine.js', { hideShareMenu() {}, getStorageSync: (k) => (k === 'cache_cup_board' ? stored : undefined), showToast: (o) => toasts.push(o.title) }, {
    '../../utils/cloud': { peek: (a) => (a === 'cupList' ? peek : undefined), cached: () => cached.p },
    '../../utils/db': { cachedOpenid: () => 'me', cachedPlayersFull: () => [], profilesOf: () => ({}), playersShared: async () => [], myOpenid: async () => 'me' },
  });
  const c1 = later();
  const a = mk({ list: [] }, null, c1);
  a.onLoad({ year: '2026', which: 'single' });
  assert.deepStrictEqual([a.data.loading, a.data.error, a.data.sum.total], [false, '', '0'], '内存里的结果：第一帧就画');
  c1.bad(new Error('网络异常')); await tick(); await tick();
  assert.deepStrictEqual([a.data.error, a.data.loading, toasts.length], ['', false, 1], '读不到：保留画面，只轻提示');
  const b = mk(undefined, { uid: 'me', r: { list: [] } }, later());
  b.onLoad({});
  assert.strictEqual(b.data.loading, false, '本机上次的结果（同一账号）');
  const c = mk(undefined, { uid: 'other', r: { list: [] } }, later());
  c.onLoad({});
  assert.strictEqual(c.data.loading, true, '别的账号存的不用');
});

test('成长档案：从「我的」进来用 60 秒内存里的私人记录第一帧就画（A.peek 只读内存、不碰本机存储）；编辑记录也先填好', async () => {
  // utils/archive.js 的 peek 只看 cloud.peek；整个档案的读写不出现本机存储
  const arch = read('utils/archive.js');
  assert.ok(/cloud\.peek\('growthList'\)/.test(arch) && !/Storage/.test(arch.replace(/\/\/.*$/gm, '')), 'archive 不读写本机存储');
  // 本机只记「上次用的局制」（growth_rules，输入习惯），不存任何记录
  ['pkg-manage/growth/growth.js', 'pkg-manage/growth-edit/growth-edit.js'].forEach((f) => {
    const calls = read(f).match(/[sg]etStorage(Sync)?\([^)]*\)/g) || [];
    assert.ok(calls.every((c) => /\(CFG_KEY/.test(c)), f + '：' + calls.join(' '));
  });
  assert.ok(/const CFG_KEY = 'growth_rules'/.test(read('pkg-manage/growth-edit/growth-edit.js')));
  const rec = { id: 'g1', date: '2026-11-20', type: 'single', kind: 'practice', result: 'win', setGames: 4, noAd: true, bestOf: 1, sets: [{ a: 4, b: 2 }], tags: [], createdAt: 1 };
  const listed = later();
  let lists = 0;
  const A = { peek: () => [rec], list: () => { lists++; return listed.p; } };
  const g = load('pkg-manage/growth/growth.js', { hideShareMenu() {} }, {
    '../../utils/archive': A,
    '../../utils/db': { cachedOpenid: () => '', myOpenid: () => new Promise(() => {}), playersShared: async () => [], matchesShared: async () => [] },
  });
  g.onLoad(); g.onShow();
  assert.deepStrictEqual([g.data.loading, g.data.has, g.data.groups.length], [false, true, 1], '第一帧就有记录');
  assert.strictEqual(lists, 1, '照常读云端静默更正');
  const e = load('pkg-manage/growth-edit/growth-edit.js', { hideShareMenu() {}, setNavigationBarTitle() {} }, { '../../utils/archive': A });
  e.onLoad({ id: 'g1' });
  assert.deepStrictEqual([e.data.ready, e.data.date, lists], [true, '2026-11-20', 1], '编辑：内存里有这条直接填好，不再读');
  const f = load('pkg-manage/growth-edit/growth-edit.js', { hideShareMenu() {}, setNavigationBarTitle() {} }, { '../../utils/archive': { peek: () => null, list: () => { lists++; return new Promise(() => {}); } } });
  f.onLoad({ id: 'g1' });
  assert.deepStrictEqual([f.data.ready, lists], [false, 2], '内存里没有：照旧读');
});

test('编辑球拍 / 记穿线维护：只用 60 秒内存里刚读过的列表先填表单（peekList 不读本机存的上次结果）；没有照旧读云端', () => {
  // peekList：内存没有时不看本机的 cache_rackets（可能是旧的，不拿旧数据填表单）
  const peekOnly = { rackets: [{ id: 'r1', no: 1, brand: 'wilson', model: 'Blade' }], logs: [{ id: 'l1', racketId: 'r1', kind: 'maint', date: '2026-11-20', item: '换手胶', tags: [] }] };
  let mem;
  global.wx = { getStorageSync: (k) => (k === 'cache_rackets' ? { uid: 'me', rackets: peekOnly.rackets, logs: [] } : k === 'my_openid' ? 'me' : undefined) };
  Object.keys(require.cache).forEach((k) => { if (k.startsWith(path.join(ROOT, 'utils'))) delete require.cache[k]; });
  const cloudMod = require(path.join(ROOT, 'utils', 'cloud.js'));
  const realPeek = cloudMod.peek;
  cloudMod.peek = (a) => (a === 'racketList' ? mem : undefined);
  const API = require(path.join(ROOT, 'utils', 'rackets.js'));
  try {
    mem = undefined;
    assert.strictEqual(API.peekList(), null, '内存没有：不读本机存的');
    assert.ok(API.cachedList(), '（列表页的 cachedList 照旧可以用本机的先显示）');
    mem = peekOnly;
    assert.strictEqual(API.peekList().rackets[0].id, 'r1');
  } finally { cloudMod.peek = realPeek; delete global.wx; }
  let loads = 0;
  const api = (pre) => ({ peekList: () => pre, load: () => { loads++; return new Promise(() => {}); } });
  const wx = { hideShareMenu() {}, setNavigationBarTitle() {}, showToast() {} };
  const e = load('pkg-tools/racket-edit/racket-edit.js', wx, { '../../utils/rackets': api(peekOnly) });
  e.onLoad({ id: 'r1' });
  assert.deepStrictEqual([e.data.ready, e.data.title, loads], [true, '1 号拍', 0], '编辑球拍：直接填好');
  const l = load('pkg-tools/racket-log/racket-log.js', wx, { '../../utils/rackets': api(peekOnly) });
  l.onLoad({ id: 'l1' });
  assert.deepStrictEqual([l.data.ready, l.data.kind, l.data.mitem, loads], [true, 'maint', '换手胶', 0], '编辑维护记录：直接填好');
  const n = load('pkg-tools/racket-log/racket-log.js', wx, { '../../utils/rackets': api(peekOnly) });
  n.onLoad({ racket: 'r1', kind: 'string' });
  assert.deepStrictEqual([n.data.ready, loads], [true, 0], '新记穿线：直接填好');
  const m = load('pkg-tools/racket-edit/racket-edit.js', wx, { '../../utils/rackets': api(null) });
  m.onLoad({ id: 'r1' });
  assert.deepStrictEqual([m.data.ready, loads], [false, 1], '内存里没有：照旧读云端');
});

function cupEditPage(o) {
  const status = later(), mem = later();
  const people = [{ uid: 'alice', nickname: 'Alice', gender: 'f' }, { uid: 'bob', nickname: 'Bob', gender: 'm' }];
  const calls = [];
  const p = load('pkg-manage/cup-edit/cup-edit.js', { hideShareMenu() {}, setNavigationBarTitle() {}, showToast() {} }, {
    '../../utils/member': { status: () => status.p, knownActive: () => o.known !== false, isAdminLocal: () => o.admin !== false },
    '../../utils/cloud': {
      peek: (a) => (a === 'listMembers' ? (o.peekMem === undefined ? { active: people } : o.peekMem) : a === 'cupList' ? o.peekList : undefined),
      cached: (a) => { calls.push('cached:' + a); return a === 'listMembers' ? mem.p : Promise.resolve(o.peekList || { list: [] }); },
      call: (a) => { calls.push('call:' + a); return new Promise(() => {}); },
    },
  });
  return { p, status, mem, people, calls };
}
test('补录积分：本机记得是管理员、内存里有成员名单就先画表单，云端校验在后台；不是管理员马上收起；云端名单一样不冲掉已选的名次', async () => {
  const a = cupEditPage({});
  const done = a.p.onLoad({});
  assert.strictEqual(a.p.data.ok, true, '不等身份校验，表单已经出来');
  a.p.openPick({ currentTarget: { dataset: { slot: 'champion', i: 0, j: 0 } } });
  a.p.tapPick({ detail: { uid: 'alice' } });
  a.status.ok({ status: 'active', isAdmin: true }); a.mem.ok({ active: a.people });
  await done;
  assert.deepStrictEqual(plain(a.p.places.champion), ['alice'], '云端一样：已选的名次保留');
  // 云端名单多了一个人：换上最新名单，已选的照样保留
  const b = cupEditPage({});
  const done2 = b.p.onLoad({});
  b.p.places.champion = ['bob'];
  b.status.ok({ status: 'active', isAdmin: true }); b.mem.ok({ active: b.people.concat([{ uid: 'carl', nickname: 'Carl' }]) });
  await done2;
  assert.deepStrictEqual([plain(b.p.places.champion), !!b.p.byUid.carl], [['bob'], true]);
  // 云端说不是管理员：收起
  const c = cupEditPage({});
  const done3 = c.p.onLoad({});
  assert.strictEqual(c.p.data.ok, true);
  c.status.ok({ status: 'active', isAdmin: false });
  await done3;
  assert.deepStrictEqual([c.p.data.ok, c.p.data.authError], [false, '只有管理员可以补录积分']);
  // 本机不记得是管理员 / 内存里没有名单 / 从活动结算：照旧等
  for (const [o, opt] of [[{ admin: false }, {}], [{ peekMem: null }, {}], [{}, { drawId: 'd1' }]]) {
    const d = cupEditPage(o);
    d.p.onLoad(opt);
    assert.strictEqual(d.p.data.ok, false, JSON.stringify([o, opt]));
  }
  // 更正一站（不是活动结算的）：内存里有这一站就先画；积分列表用 cached，不绕过内存缓存
  const stop = { id: 's1', status: 'published', date: '2026-11-20', kind: 'weekly', format: 'single', pointGroup: 'open', scoreVersion: 2, fixes: 0, places: { champion: ['alice'], runnerUp: ['bob'], semis: [], floor: [] } };
  const e = cupEditPage({ peekList: { list: [stop] } });
  const done4 = e.p.onLoad({ id: 's1' });
  assert.deepStrictEqual([e.p.data.ok, e.p.data.editing, plain(e.p.places.champion)], [true, true, ['alice']]);
  assert.ok(e.calls.includes('cached:cupList') && !e.calls.includes('call:cupList'));
  e.p.places.champion = ['bob']; e.p.places.runnerUp = ['alice']; // 正在更正
  e.status.ok({ status: 'active', isAdmin: true }); e.mem.ok({ active: e.people });
  await done4;
  assert.deepStrictEqual(plain([e.p.places.champion, e.p.places.runnerUp]), [['bob'], ['alice']], '云端这一站没变：不冲掉正在改的名次');
  const f = cupEditPage({ peekList: { list: [Object.assign({}, stop, { drawId: 'd1' })] } });
  f.p.onLoad({ id: 's1' });
  assert.strictEqual(f.p.data.ok, false, '活动结算的站要读活动：等云端');
});

function drawNewPage(pre) {
  const got = later(), sg = later(), calls = [];
  const players = [{ name: '小明', uid: 'me' }, { name: '阿杰', uid: 'jie' }, { name: '小周', uid: 'zhou' }, { name: '小林', uid: 'lin' }];
  const p = load('pkg-manage/draw-new/draw-new.js', { getStorageSync: () => ({}), setNavigationBarTitle() {}, showToast() {}, pageScrollTo() {}, vibrateShort() {} }, {
    '../../utils/member': { status: () => new Promise(() => {}), knownActive: () => true, isAdminLocal: () => true },
    '../../utils/db': {
      peekDrawDetail: () => pre, cachedPlayersFull: () => players, cachedMatches: () => [],
      getDraw: () => got.p, fetchSignups: () => sg.p,
      playersShared: async () => { calls.push('playersShared'); return players; }, matchesShared: async () => { calls.push('matchesShared'); return []; },
      fetchPlayersFull: async () => { calls.push('fetchPlayersFull'); return players; }, fetchMatches: async () => { calls.push('fetchMatches'); return []; },
    },
  });
  return { p, got, sg, calls };
}
test('截止报名 · 生成对阵：活动详情刚读过就第一帧画出这个活动的规则和报名名单（不闪上次的默认）；云端版本和名单没变不冲掉已调整的勾选', async () => {
  const draw = Object.assign(signupDraw(), { groupCount: 1, limit: 0, settingsVersion: 2 });
  const signups = ['小明', '阿杰', '小周', '小林'].map((n, i) => ({ _id: 's' + i, name: n, _openid: ['me', 'jie', 'zhou', 'lin'][i] }));
  const a = drawNewPage({ draw, signups });
  a.p.onLoad({ id: 'd1' });
  assert.deepStrictEqual([a.p.data.title, a.p.data.mode, a.p.data.fromSignup, plain(a.p.selected)], ['周六约球', 'groups', true, ['小明', '阿杰', '小周', '小林']], '第一帧就是这个活动');
  a.p.togglePlayer({ currentTarget: { dataset: { name: '小林' } } }); // 管理员去掉一个人
  a.got.ok(draw); a.sg.ok(signups);
  for (let i = 0; i < 6; i++) await tick();
  assert.deepStrictEqual(plain(a.p.selected), ['小明', '阿杰', '小周'], '云端一样：不冲掉调整');
  assert.ok(a.calls.includes('playersShared') && a.calls.includes('matchesShared') && !a.calls.includes('fetchPlayersFull') && !a.calls.includes('fetchMatches'), '用共享版');
  assert.strictEqual(a.p.settingsVersion, 2);
  // 期间有人新报名：按最新的重画
  const b = drawNewPage({ draw, signups });
  b.p.onLoad({ id: 'd1' });
  b.p.togglePlayer({ currentTarget: { dataset: { name: '小林' } } });
  b.got.ok(Object.assign({}, draw, { rosterVersion: 1 })); b.sg.ok(signups.concat([{ _id: 's9', name: '阿强', _openid: 'q' }]));
  for (let i = 0; i < 6; i++) await tick();
  assert.deepStrictEqual(plain(b.p.selected), ['小明', '阿杰', '小周', '小林', '阿强']);
  assert.strictEqual(b.p.rosterVersion, 1, '生成时带最新版本');
  // 活动详情没读过：照旧等云端
  const c = drawNewPage(null);
  c.p.onLoad({ id: 'd1' });
  assert.deepStrictEqual(plain(c.p.selected), []);
});

test('成员管理：在「我的」点入口先发出成员列表的实时读取，成员管理页接过去（只发一次）；只接一次，写操作 / 退出 / 超过 10 秒不用', async () => {
  let n = 0;
  const c = realClient(async (d) => (d.action === 'listMembers' ? { ok: true, active: [], n: ++n } : { ok: true }));
  const cloud = require(path.join(ROOT, 'utils', 'cloud.js'));
  const cnt = () => c.calls.filter((a) => a === 'listMembers').length;
  cloud.prefetch('listMembers'); cloud.prefetch('listMembers');
  assert.strictEqual(cnt(), 1, '连点两次只发一次');
  assert.strictEqual((await cloud.fresh('listMembers')).n, 1, '成员管理页接过预读');
  assert.strictEqual(cnt(), 1);
  assert.strictEqual(cloud.peek('listMembers').n, 1, '结果照样留给 peek / cached');
  assert.strictEqual((await cloud.fresh('listMembers')).n, 2, '只接一次：下拉刷新照常实时读');
  cloud.prefetch('listMembers');
  c.memo.invalidate();
  assert.strictEqual((await cloud.fresh('listMembers')).n, 4, '期间有写操作：不用');
  cloud.prefetch('listMembers');
  c.member.clearProtected(); c.storage.member_ok_at = Date.now();
  assert.strictEqual((await cloud.fresh('listMembers')).n, 6, '退出成员身份：不用');
  const now = Date.now, t0 = now();
  cloud.prefetch('listMembers');
  Date.now = () => t0 + 10001;
  try { assert.strictEqual((await cloud.fresh('listMembers')).n, 8, '超过 10 秒：不用'); } finally { Date.now = now; }
  assert.throws(() => cloud.prefetch('cupSave'), /只读/);
  delete global.wx;
  const me = read('pages/me/me.js');
  const body = me.slice(me.indexOf('openMembers()'), me.indexOf('openGrowth()'));
  assert.ok(/cloud\.prefetch\('listMembers'\);\s*wx\.navigateTo\(\{ url: '\/pkg-manage\/members\/members' \}\)/.test(body), '跳转前先发');
  assert.ok(/cloud\.fresh\('listMembers'\)/.test(read('pkg-manage/members/members.js')), '成员管理页照旧 fresh（接过预读）');
});

module.exports = T;
