// 页面层的几处回归：战绩页长按撤销、球员战绩 / 成长档案首次打开、退赛被拒后再申请、已删除活动的比赛改分
// 页面在 vm 里跑（假的 wx）；需要真实数据的用 tests/mock-cloud.js 的内存数据库 + 真实的 utils/db.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const createEnv = require('./mock-cloud');
const fakeClock = require('./fake-clock');

const T = [];
const test = (name, fn) => T.push({ name, fn });
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

// 加载页面定义；deps 里的模块替换真实模块，其余照常 require（和真实的 utils/db.js 共用同一份缓存）
function loadPage(file, wx, deps, extra) {
  const filename = path.join(ROOT, file);
  let def;
  vm.runInNewContext(read(file), Object.assign({
    require: (id) => (deps && deps[id]) || createRequire(filename)(id), wx, console,
    Page: (d) => { def = d; }, Component: (d) => { def = d; }, getCurrentPages: () => [],
  }, extra));
  return Object.assign({}, def, {
    data: plain(def.data),
    setData(o) {
      Object.keys(o).forEach((k) => {
        const ks = k.split('.'); let t = this.data;
        ks.slice(0, -1).forEach((x) => { if (!t[x] || typeof t[x] !== 'object') t[x] = {}; t = t[x]; });
        t[ks[ks.length - 1]] = o[k];
      });
    },
  });
}

// 真实的 utils/db.js 接内存云函数。本机存储的异步写（wx.setStorage）先排队、不落盘：
// 模拟「云端已经读到、本机缓存还没写完」的那一刻
function realClient(env, uid) {
  const storage = { member_ok_at: Date.now(), my_openid: uid };
  const queued = [];
  const wx = {
    getStorageSync: (k) => storage[k], setStorageSync: (k, v) => { storage[k] = plain(v); },
    setStorage: (o) => queued.push(o), removeStorageSync: (k) => { delete storage[k]; }, getStorageInfoSync: () => ({ keys: Object.keys(storage) }),
    cloud: { callFunction: async ({ data }) => ({ result: await env.call(uid, data.action, data) }) },
    setNavigationBarTitle() {}, hideShareMenu() {}, showToast() {}, showModal() {}, stopPullDownRefresh() {},
  };
  global.wx = wx;
  global.getCurrentPages = () => [];
  Object.keys(require.cache).forEach((k) => { if (k.startsWith(path.join(ROOT, 'utils'))) delete require.cache[k]; });
  const db = require(path.join(ROOT, 'utils/db.js'));
  return { wx, db, storage, queued };
}
function seed(env) {
  env.members([['alice', 'Alice'], ['bob', 'Bob'], ['carl', 'Carl'], ['owner', 'Owner']]);
  for (let i = 0; i < 6; i++) {
    env.put('matches', { _id: 'dm' + i, _openid: 'alice', type: 'single', a: ['Alice'], b: [i % 2 ? 'Bob' : 'Carl'], aIds: ['alice'], bIds: [i % 2 ? 'bob' : 'carl'], winner: i < 4 ? 'a' : 'b', sets: [{ a: i < 4 ? 4 : 1, b: i < 4 ? 1 : 4 }], date: '2026-11-0' + (i + 1), createdAt: i });
  }
}

// 极简 WXML 渲染：只认 wx:if / wx:elif / wx:else 和 {{表达式}}（够用来核对某一块在不同数据下显示什么）。
// 输出可见的文字，带 bindtap 的元素额外标成 [tap:方法名]
function renderWxml(xml, data) {
  xml = xml.replace(/<!--[\s\S]*?-->/g, '');
  const root = { children: [] }, stack = [root];
  const re = /<(\/?)([a-z-]+)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[5] !== undefined) { if (m[5].trim()) stack[stack.length - 1].children.push({ text: m[5].trim() }); continue; }
    if (m[1]) { stack.pop(); continue; }
    const attrs = {};
    (m[3].match(/[^\s=]+(?:="[^"]*")?/g) || []).forEach((a) => { const i = a.indexOf('='); attrs[i < 0 ? a : a.slice(0, i)] = i < 0 ? '' : a.slice(i + 2, -1); });
    const node = { tag: m[2], attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!m[4]) stack.push(node);
  }
  const scope = new Proxy({}, { has: (t, k) => k !== Symbol.unscopables, get: (t, k) => data[k] });
  const ev = (e) => Function('s', `with (s) { return (${e}); }`)(scope);
  const val = (s) => { const w = /^\{\{([\s\S]*)\}\}$/.exec(s); return w ? ev(w[1]) : s; };
  const text = (s) => s.replace(/\{\{([\s\S]*?)\}\}/g, (x, e) => String(ev(e)));
  const out = [];
  const walk = (nodes) => {
    let chain = null; // 当前 if / elif 链是否已经有一项显示
    nodes.forEach((n) => {
      if (n.text) { out.push(text(n.text)); chain = null; return; }
      const a = n.attrs;
      let show = true;
      if ('wx:if' in a) { show = !!val(a['wx:if']); chain = show; }
      else if ('wx:elif' in a) { show = chain === false && !!val(a['wx:elif']); if (show) chain = true; }
      else if ('wx:else' in a) { show = chain === false; chain = null; }
      else chain = null;
      if (!show || 'wx:for' in a) return; // 列表这里用不到，略过
      if (a.bindtap) out.push(`[tap:${a.bindtap}]`);
      walk(n.children);
    });
  };
  walk(root.children);
  return out.join(' ');
}

/* ---------- 战绩页长按撤销 ---------- */
test('战绩页长按删除：云端要求确认影响（needConfirm）或填原因（needReason）时去比赛详情处理，不提示「已删除」', async () => {
  for (const [res, goDetail] of [[{ needConfirm: true, impact: [{ stage: '决赛', a: 'A', b: 'B' }] }, true], [{ needReason: true }, true], [{ ok: true, removed: 1 }, false]]) {
    const navs = [], toasts = []; let loads = 0;
    const wx = {
      getStorageSync: () => '', showActionSheet: (o) => o.success({ tapIndex: 0 }), showModal: (o) => o.success({ confirm: true }),
      navigateTo: (o) => navs.push(o.url), showToast: (o) => toasts.push(o.title),
    };
    const p = loadPage('pages/index/index.js', wx, { '../../utils/db': { removeMatch: async (id) => { assert.strictEqual(id, 'm1'); return res; } } });
    p.load = () => { loads++; };
    p.onLong({ currentTarget: { dataset: { id: 'm1' } } });
    await flush();
    if (goDetail) {
      assert.deepStrictEqual(navs, ['/pages/match/match?id=m1'], JSON.stringify(res));
      assert.ok(!toasts.includes('已删除'), '没删掉就不能提示已删除');
      assert.strictEqual(loads, 0);
    } else {
      assert.deepStrictEqual(navs, []); assert.deepStrictEqual(toasts, ['已删除']); assert.strictEqual(loads, 1);
    }
  }
});
test('战绩页长按删除：非发起人管理员撤销会推翻后续场次的活动比赛，真实云函数返回 needConfirm，页面不提示「已删除」、记录仍在', async () => {
  const env = createEnv(); env.load();
  env.members([['alice', 'Alice'], ['bob', 'Bob'], ['carl', 'Carl'], ['eve', 'Eve'], ['admin', 'Admin']]);
  const D = require('../utils/draw');
  const E = require('../utils/event');
  const ents = ['Alice', 'Bob', 'Carl', 'Eve'];
  env.put('draws', { _id: 'd5', _openid: 'owner', title: '周末赛', status: 'drawn', type: 'single', mode: 'bracket', size: 4, entrants: ents, lines: D.makeBracket(ents, [], 4) });
  ents.forEach((n) => env.put('signups', { _id: 's_' + n, _openid: n.toLowerCase(), drawId: 'd5', name: n }));
  const sch = () => E.scheduleOf(Object.assign({}, env.coll('draws').d5), Object.values(env.coll('matches')).filter((x) => x.drawId === 'd5'));
  const won = (f, who) => [f.aMembers[0] === who ? { a: 4, b: 1 } : { a: 1, b: 4 }];
  const semis = sch().filter((x) => x.ready);
  const ids = [];
  for (const f of semis) ids.push((await env.call(f.aMembers[0].toLowerCase(), 'recordEventMatch', { drawId: 'd5', key: f.key, sets: won(f, f.aMembers[0]) })).matchId);
  const fin = sch().find((x) => x.ready && !semis.some((s) => s.key === x.key));
  assert.ok((await env.call(fin.aMembers[0].toLowerCase(), 'recordEventMatch', { drawId: 'd5', key: fin.key, sets: won(fin, fin.aMembers[0]) })).ok);
  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = 'admin';
  try {
    const navs = [], toasts = [];
    const c = realClient(env, 'admin');
    Object.assign(c.wx, { showActionSheet: (o) => o.success({ tapIndex: 0 }), showModal: (o) => o.success({ confirm: true }), navigateTo: (o) => navs.push(o.url), showToast: (o) => toasts.push(o.title) });
    const p = loadPage('pages/index/index.js', c.wx, {});
    p.load = () => {};
    p.onLong({ currentTarget: { dataset: { id: ids[0] } } });
    await flush(60);
    assert.deepStrictEqual(navs, ['/pages/match/match?id=' + ids[0]]);
    assert.ok(!toasts.includes('已删除'));
    assert.ok(env.coll('matches')[ids[0]], '记录没有被删');
  } finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
});

/* ---------- 首次打开：本机缓存还没写完 ---------- */
test('球员战绩页第一次打开：用这次从云端拿到的资料和比赛，不等本机缓存落盘（不空白）', async () => {
  const env = createEnv(); env.load(); seed(env);
  const c = realClient(env, 'alice');
  const p = loadPage('pkg-manage/history/history.js', c.wx, {});
  p.onLoad({ uid: 'alice' });
  assert.strictEqual(p.data.sum, null, '本机没有缓存时先空着');
  await p.load();
  assert.ok(c.queued.length > 0, '本机缓存还在排队、没写进存储');
  assert.ok(!c.storage.cache_profiles && !c.storage.cache_matches_all);
  assert.strictEqual(p.data.name, 'Alice');
  assert.deepStrictEqual(plain(p.data.sum), { matches: '6', win: '4', lose: '2', rate: '67%' });
  assert.deepStrictEqual([p.data.shown.length, p.data.totalCount, p.data.totalPages], [5, 6, 2]);
  assert.strictEqual(p.data.loading, false);
});
test('成长档案第一次打开：正式战绩摘要用这次从云端拿到的资料和比赛，不等本机缓存落盘', async () => {
  const env = createEnv(); env.load(); seed(env);
  const c = realClient(env, 'alice');
  const p = loadPage('pkg-manage/growth/growth.js', c.wx, {});
  p.onLoad();
  await p.load();
  assert.ok(!c.storage.cache_profiles && !c.storage.cache_matches_all, '本机缓存还没写完');
  assert.ok(p.data.official, '正式战绩摘要不因本机缓存没落盘而缺失');
  assert.deepStrictEqual([p.data.official.played, p.data.official.win, p.data.official.lose, p.data.official.rate], [6, 4, 2, '67%']);
  assert.strictEqual(p.data.official.single, '6 场 · 胜率 67%');
  assert.strictEqual(p.data.official.double, '0 场 · 胜率 —');
  assert.strictEqual(p.data.loading, false);
  // 这两页只读共享数据，不改动它
  const [players, matches] = await Promise.all([c.db.playersShared(), c.db.matchesShared()]);
  const before = JSON.stringify([players, matches]);
  await p.load();
  assert.strictEqual(JSON.stringify([await c.db.playersShared(), await c.db.matchesShared()]), before);
  for (const f of ['pkg-manage/history/history.js', 'pkg-manage/growth/growth.js']) {
    const code = read(f).replace(/\/\/.*$/gm, '');
    assert.ok(!/cachedProfiles\(\)|cachedPlayersFull\(\)|cachedMatches\(\)/.test(code.slice(code.indexOf('load()'))), f + '：读完云端后不再同步读本机缓存');
  }
});

/* ---------- 退赛被拒后再申请 ---------- */
test('退赛申请被拒绝后：保留「发起人拒绝了你的退赛申请」，仍显示「申请退赛」按钮，能再次申请；等待处理时不显示按钮', async () => {
  const env = createEnv(); env.load();
  env.members([['alice', 'Alice'], ['bob', 'Bob'], ['owner', 'Owner']]);
  env.put('draws', { _id: 'd1', _openid: 'owner', title: 'T', status: 'drawn', type: 'single', mode: 'bracket', size: 2, entrants: ['Alice', 'Bob'], lines: [{ name: 'Alice' }, { name: 'Bob' }] });
  env.put('signups', { _id: 's1', _openid: 'alice', drawId: 'd1', name: 'Alice' });
  env.put('signups', { _id: 's2', _openid: 'bob', drawId: 'd1', name: 'Bob' });
  const clock = fakeClock();
  const ctx = { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, Date: clock.Date };
  const wx = { getStorageSync: () => '', setStorageSync() {}, removeStorageSync() {}, showToast() {}, hideShareMenu() {}, setNavigationBarTitle() {} };
  const def = loadPage('pages/draw-view/draw-view.js', wx, {}, ctx);
  const xml = read('pages/draw-view/draw-view.wxml');
  const block = xml.slice(xml.indexOf('<!-- 退赛 -->'), xml.indexOf('<!-- 单场安排'));
  const view = async () => {
    const page = Object.assign({}, def, { data: plain(def.data), d: Object.assign({ _id: 'd1' }, env.coll('draws').d1) });
    page.applyRequests(await env.call('alice', 'drawRequests', { drawId: 'd1' }));
    return renderWxml(block, Object.assign({ signing: false }, page.data));
  };
  assert.match(await view(), /\[tap:requestWithdraw\] 申请退赛/);
  const req = await env.call('alice', 'requestWithdraw', { drawId: 'd1', reason: '受伤' });
  assert.ok(req.ok);
  let v = await view();
  assert.match(v, /你的退赛申请等待发起人处理/);
  assert.ok(!/requestWithdraw/.test(v), '等待处理时不显示按钮');
  assert.ok((await env.call('owner', 'handleWithdraw', { drawId: 'd1', requestId: req.requestId, approve: false, reason: '已经开赛，请打完' })).ok);
  v = await view();
  assert.match(v, /发起人拒绝了你的退赛申请：已经开赛，请打完/);
  assert.match(v, /\[tap:requestWithdraw\] 申请退赛/, '被拒绝后仍可再次申请');
  // 再次申请：云端接受，页面回到「等待处理」（取最新的那条申请）
  assert.ok((await env.call('alice', 'requestWithdraw', { drawId: 'd1', reason: '身体不适' })).ok);
  v = await view();
  assert.match(v, /你的退赛申请等待发起人处理/);
  assert.ok(!/拒绝了你的退赛申请|requestWithdraw/.test(v));
});

/* ---------- 已软删除活动的比赛改分 ---------- */
test('改分页：比赛所属活动已删除（读不到）时不报错，沿用比赛记录自带的规则（和云端 ruleOfMatch 一致）', async () => {
  const env = createEnv(); env.load();
  env.members([['alice', 'Alice'], ['bob', 'Bob']]);
  env.put('draws', { _id: 'dd', _openid: 'owner', title: '删掉的活动', status: 'drawn', type: 'single', mode: 'bracket', size: 2, entrants: ['Alice', 'Bob'], lines: [{ name: 'Alice' }, { name: 'Bob' }], deleted: true, rules: { setGames: 6, noAd: false, bestOf: 3 } });
  env.put('matches', { _id: 'evm', drawId: 'dd', drawKey: '0-0', type: 'single', a: ['Alice'], b: ['Bob'], aIds: ['alice'], bIds: ['bob'], winner: 'a', setGames: 6, noAd: false, bestOf: 3, sets: [{ a: 6, b: 3 }, { a: 6, b: 4 }], outcome: 'normal', date: '2026-11-01', createdAt: 1 });
  const c = realClient(env, 'alice');
  await assert.rejects(() => c.db.getDraw('dd'), '已删除的活动网关读不到');
  for (const mode of ['request', 'admin']) {
    const p = loadPage('pkg-manage/correct/correct.js', c.wx, {});
    p.onLoad({ matchId: 'evm', mode });
    await flush(60);
    assert.strictEqual(p.data.error, '', mode);
    assert.strictEqual(p.data.loading, false);
    assert.deepStrictEqual([p.data.setGames, p.data.noAd, p.data.bestOf], [6, false, 3]);
    assert.deepStrictEqual(plain(p.data.init), [{ a: 6, b: 3 }, { a: 6, b: 4 }]);
  }
  // 活动还在：照旧按活动这一场的规则
  const E = require('../utils/event');
  env.coll('draws').dd.deleted = false;
  const p = loadPage('pkg-manage/correct/correct.js', c.wx, {});
  p.onLoad({ matchId: 'evm', mode: 'request' });
  await flush(60);
  const d = Object.assign({ _id: 'dd' }, env.coll('draws').dd);
  const rule = E.ruleFor(E.publicDraw(d), '0-0');
  assert.deepStrictEqual([p.data.setGames, p.data.noAd, p.data.bestOf], [rule.setGames, rule.noAd, rule.bestOf]);
  assert.strictEqual(p.data.error, '');
});

module.exports = T;
