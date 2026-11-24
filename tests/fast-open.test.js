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
  assert.ok(/<view wx:if="\{\{ready\}\}" class="late"><match-social /.test(xml), "match-social 等 ready，出现时淡入");
  assert.ok(!/正在读取/.test(xml), '比赛详情读云端期间不放「正在读取」占位文字');
  // 本机没有这一场：照旧等云端（页面先空着）
  const q = load('pages/match/match.js', { navigateTo() {} }, {
    '../../utils/cloud': { call: () => new Promise(() => {}) },
    '../../utils/db': { cachedMatchesAll: () => [], cachedPlayersFull: () => [], fetchPlayersFull: async () => [], myOpenid: async () => '', matchesShared: async () => [] },
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

module.exports = T;
