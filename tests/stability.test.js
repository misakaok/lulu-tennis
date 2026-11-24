// 第二批稳定性（小程序端）：积分组件的管理员按钮、选人弹层的搜索词、dataset 退回分页的条件、缓存代际保护、
// 活动详情的乱序 / 连点、资料页的异步覆盖。页面 / 组件在 vm 里跑（假的 wx）；utils 用真实代码 + 可控的云函数
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');

const T = [];
const test = (name, fn) => T.push({ name, fn });
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const plain = (v) => JSON.parse(JSON.stringify(v));
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const deferred = () => { let resolve, reject; const p = new Promise((a, b) => { resolve = a; reject = b; }); return { p, resolve, reject }; };

function loadDef(file, deps, wx, extra) {
  const filename = path.join(ROOT, file);
  let def;
  vm.runInNewContext(read(file), Object.assign({
    require: (id) => (deps && deps[id]) || createRequire(filename)(id), wx, console, setTimeout: () => 0, clearTimeout() {},
    Page: (d) => { def = d; }, Component: (d) => { def = d; }, getCurrentPages: () => [],
  }, extra));
  return def;
}
const setPath = function (o) {
  Object.keys(o).forEach((k) => {
    const ks = k.split('.'); let t = this.data;
    ks.slice(0, -1).forEach((x) => { if (!t[x] || typeof t[x] !== 'object') t[x] = {}; t = t[x]; });
    t[ks[ks.length - 1]] = o[k];
  });
};
const page = (def) => Object.assign({}, def, { data: plain(def.data), setData: setPath });
const comp = (def, data) => Object.assign({}, def.methods, { data: Object.assign(plain(def.data), data || {}), setData: setPath, triggerEvent() {} });

// 真实的 utils（db / memo / cloud / member），云函数由测试控制：handler(data) 返回 result（或抛错模拟网络异常）
function client(handler) {
  const storage = { member_ok_at: Date.now(), my_openid: 'me' };
  const calls = [];
  global.wx = {
    getStorageSync: (k) => storage[k], setStorageSync: (k, v) => { storage[k] = plain(v); }, setStorage: ({ key, data }) => { storage[key] = plain(data); },
    removeStorageSync: (k) => { delete storage[k]; }, getStorageInfoSync: () => ({ keys: Object.keys(storage) }),
    reLaunch() {}, showToast() {},
    cloud: { callFunction: async ({ data }) => { calls.push(data.action); return { result: await handler(data) }; } },
  };
  global.getCurrentPages = () => [];
  Object.keys(require.cache).forEach((k) => { if (k.startsWith(path.join(ROOT, 'utils'))) delete require.cache[k]; });
  const req = (m) => require(path.join(ROOT, 'utils', m + '.js'));
  return { db: req('db'), memo: req('memo'), cloud: req('cloud'), member: req('member'), storage, calls };
}

/* ---------- 积分组件：管理员按钮以云端为准 ---------- */
test('积分组件：云端明确返回 admin 时以云端为准（撤销管理员后按钮收起）；旧版云函数没带 admin 才看本机', async () => {
  const run = async (admin, local) => {
    const def = loadDef('components/cup-board/cup-board.js', {
      '../../utils/cloud': { cached: async () => Object.assign({ list: [] }, admin === undefined ? {} : { admin }) },
      '../../utils/db': { playersShared: async () => [], profilesOf: () => ({}), myOpenid: async () => 'me' },
      '../../utils/member': { isAdminLocal: () => local, knownActive: () => true },
    }, { pageScrollTo() {} });
    const c = comp(def, { admin: local });
    await c.load();
    return c.data.admin;
  };
  assert.strictEqual(await run(false, true), false, '本机还记着是管理员，云端说不是：收起');
  assert.strictEqual(await run(true, false), true);
  assert.strictEqual(await run(undefined, true), true, '旧版云函数：沿用本机');
  assert.strictEqual(await run(undefined, false), false);
});

/* ---------- 选人弹层：换场景清空搜索词 ---------- */
test('选人弹层：代报名选完第一位接着选搭档（同一个弹层换了一批人）、标题变了，都清空搜索词；多选只是勾选变了不清空', () => {
  const def = loadDef('components/member-sheet/member-sheet.js', {}, {});
  const people = [{ uid: 'a', name: 'Alice' }, { uid: 'b', name: 'Bob' }, { uid: 'c', name: 'Carl' }];
  const sh = comp(def, { title: '添加报名', list: people });
  const set = (k, v) => { sh.data[k] = v; sh.filter(); }; // 属性变化时组件的 observer 调 filter
  def.lifetimes.attached.call(sh);
  sh.onQ({ detail: { value: 'b' } });
  assert.deepStrictEqual(sh.data.shown.map((x) => x.uid), ['b']);
  set('list', people.map((x) => Object.assign({}, x, { on: x.uid === 'b' }))); // 多选：同一批人，勾选变了
  assert.strictEqual(sh.data.q, 'b', '勾选不清空搜索词');
  assert.deepStrictEqual(sh.data.shown.map((x) => x.uid), ['b']);
  // 代报名：选了 Bob，弹层不关，换成「选择 Bob 的搭档」（标题和名单都变）
  sh.data.title = '选择 Bob 的搭档';
  set('list', people.filter((x) => x.uid !== 'b'));
  assert.strictEqual(sh.data.q, '', '换场景清空搜索词');
  assert.deepStrictEqual(sh.data.shown.map((x) => x.uid), ['a', 'c'], '搜索词清空后显示全部可选的人');
  // 只换标题
  sh.onQ({ detail: { value: 'a' } });
  set('title', '先加入的球友');
  assert.strictEqual(sh.data.q, '');
  assert.match(read('components/member-sheet/member-sheet.js'), /title: \{ type: String, value: '选择球员', observer: 'filter' \}/);
});

/* ---------- dataset 退回分页的条件 ---------- */
test('dataset：只有「未知操作」（旧版云函数）退回分页；网络异常、不是成员不悄悄改成分页再读', async () => {
  // 网络异常
  let c = client(async (d) => { if (d.action === 'dataset') throw new Error('timeout'); return { ok: true, data: [] }; });
  await assert.rejects(() => c.db.fetchMatches(), /网络异常/);
  assert.ok(!c.calls.includes('data'), '没有退回分页读取：' + c.calls.join(','));
  // 不是成员：踢回准入页，不再分页读
  c = client(async (d) => (d.action === 'dataset' ? { ok: false, code: 'NOT_MEMBER', error: '请先验证后使用' } : { ok: true, data: [] }));
  await assert.rejects(() => c.db.fetchPlayersFull(), /验证/);
  assert.ok(!c.calls.includes('data'));
  // 旧版云函数：退回分页
  c = client(async (d) => (d.action === 'dataset' ? { ok: false, error: '未知操作' } : { ok: true, data: [] }));
  assert.deepStrictEqual(await c.db.fetchMatches(), []);
  assert.ok(c.calls.includes('data'));
});

/* ---------- 缓存代际保护 ---------- */
test('缓存代际：读的过程中有写操作 / 清除受保护缓存，晚到的 drawDetail、cloud.fresh 结果不写回缓存', async () => {
  let gate = null;
  const c = client(async (d) => {
    if (gate) await gate.p;
    if (d.action === 'drawDetail') return { ok: true, draw: { _id: 'd1', title: 'T', status: 'signup' }, profile: { name: 'Me' }, signups: [] };
    if (d.action === 'listMembers') return { ok: true, active: [{ uid: 'a' }] };
    return { ok: true };
  });
  // 没有写入：照常放进缓存并更新本机资料
  await c.db.fetchDrawDetail('d1');
  assert.ok(c.db.peekDrawDetail('d1'));
  assert.deepStrictEqual(c.storage.my_profile, { name: 'Me' });
  // 读的时候自己做了一次写操作（缓存作废，如刚改完资料）：结果照样返回给页面，但不放进缓存、也不拿旧资料盖掉本机 my_profile
  c.storage.my_profile = { name: 'NewMe' };
  c.memo.invalidate();
  gate = deferred();
  let task = c.db.fetchDrawDetail('d1');
  await flush(); c.memo.invalidate(); gate.resolve();
  assert.strictEqual((await task).draw.title, 'T');
  assert.strictEqual(c.db.peekDrawDetail('d1'), null, '旧结果没写回');
  assert.deepStrictEqual(c.storage.my_profile, { name: 'NewMe' }, '旧 drawDetail 没把新资料盖掉');
  gate = deferred();
  task = c.cloud.fresh('listMembers');
  await flush(); c.memo.invalidate(); gate.resolve();
  assert.strictEqual((await task).active.length, 1);
  assert.strictEqual(c.cloud.peek('listMembers'), undefined);
  gate = null;
  await c.cloud.fresh('listMembers');
  assert.ok(c.cloud.peek('listMembers'), '没有写入时照常留给别的页面');
  // 读的时候退出了成员身份（clearProtected）：不把本人资料写回本机
  gate = deferred();
  task = c.db.fetchDrawDetail('d1');
  await flush(); c.member.clearProtected(); gate.resolve();
  await assert.rejects(task, (e) => e.code === 'CACHE_CLEARED');
  assert.strictEqual(c.storage.my_profile, undefined);
  assert.strictEqual(c.db.peekDrawDetail('d1'), null);
  // memo.put 的 since
  assert.strictEqual(c.memo.put('k', c.memo.ANY, 1, c.memo.epoch() - 1), false);
  assert.strictEqual(c.memo.put('k', c.memo.ANY, 1, c.memo.epoch()), true);
});
test('db.forget（clearProtected）连同刚删除的活动和「撤回」提示一起清掉', async () => {
  const c = client(async () => ({ ok: true }));
  await c.db.removeDraw('d1', '重复创建', '周末赛');
  assert.strictEqual(c.db.recentRemoved().id, 'd1');
  const list = [{ _id: 'd1' }, { _id: 'd2' }];
  assert.strictEqual(c.db.withoutRemoved(list).length, 1);
  c.member.clearProtected();
  assert.strictEqual(c.db.recentRemoved(), null);
  assert.strictEqual(c.db.withoutRemoved(list), list, '换了账号不再隐藏');
});

/* ---------- 活动详情：乱序和连点 ---------- */
function drawView(over) {
  const db = Object.assign({ matchesShared: async () => [], cachedMatches: () => [], playersShared: async () => [], cachedPlayersFull: () => [], profilesOf: () => ({}), myOpenid: async () => 'me', cachedProfile: () => ({ name: 'Me' }), getMyProfile: async () => ({ name: 'Me' }) }, over.db || {});
  const wx = Object.assign({ showToast() {}, showModal() {}, setNavigationBarTitle() {}, stopPullDownRefresh() {} }, over.wx || {});
  const def = loadDef('pages/draw-view/draw-view.js', {
    '../../utils/db': db, '../../utils/cloud': over.cloud || { call: async () => ({}) }, '../../utils/pick': over.pick || {}, '../../utils/share-card': {},
  }, wx);
  const p = page(def);
  p.id = 'd1';
  return p;
}
test('活动详情 load 防乱序：先发的请求晚回来，不覆盖后发的结果；出错也只认最后一次', async () => {
  const reqs = [];
  const p = drawView({ db: { fetchDrawDetail: () => { const x = deferred(); reqs.push(x); return x.p; } } });
  const shown = [];
  p.show = async (d) => { shown.push(d.title); };
  const first = p.load(), second = p.load();
  await flush();
  reqs[1].resolve({ draw: { _id: 'd1', title: '新' }, profile: null, signups: [] });
  await second;
  reqs[0].resolve({ draw: { _id: 'd1', title: '旧' }, profile: null, signups: [] });
  await first;
  assert.deepStrictEqual(shown, ['新']);
  // 旧请求失败不把页面改成「加载失败」
  const third = p.load(), fourth = p.load();
  await flush();
  reqs[3].resolve({ draw: { _id: 'd1', title: '最新' }, profile: null, signups: [] }); await fourth;
  reqs[2].reject(new Error('网络异常')); await third;
  assert.deepStrictEqual(shown, ['新', '最新']);
  assert.ok(!p.data.error);
});
test('活动详情 loadSignups 防乱序：旧 load 已进入 loadSignups，后发的新 load 先完成时，旧名单晚到不覆盖新名单', async () => {
  const playerGates = [];
  let n = 0;
  const p = drawView({
    db: {
      fetchDrawDetail: async () => {
        const k = ++n;
        return {
          draw: { _id: 'd1', title: '报名赛', status: 'signup', type: 'single', mode: 'bracket', size: 4 },
          profile: { name: 'Me' },
          signups: k === 1 ? [{ _id: 's1', _openid: 'alice', name: 'Alice' }] : [{ _id: 's1', _openid: 'alice', name: 'Alice' }, { _id: 's2', _openid: 'bob', name: 'Bob' }],
        };
      },
      playersShared: () => { const g = deferred(); playerGates.push(g); return g.p; }, // 共享版球员在 load 里和 drawDetail 同时读
      cachedPlayersFull: () => [],
    },
  });
  p.makeCover = () => {};
  const first = p.load();
  await flush();
  assert.strictEqual(playerGates.length, 1, '第一次 load 在等球员列表（名单已先按本机球员画出）');
  const second = p.load();
  await flush();
  assert.strictEqual(playerGates.length, 2, '第二次 load 也在等球员列表');
  // 第二次先返回（2 人报名）
  playerGates[1].resolve([{ name: 'Alice', uid: 'alice', self: true }, { name: 'Bob', uid: 'bob', self: true }]);
  await second;
  assert.deepStrictEqual(p.data.signups.map((x) => x.name), ['Alice', 'Bob']);
  // 第一次晚返回（只有 1 人）：不得覆盖
  playerGates[0].resolve([{ name: 'Alice', uid: 'alice', self: true }]);
  await first;
  assert.deepStrictEqual(p.data.signups.map((x) => x.name), ['Alice', 'Bob']);
});
test('活动详情防连点：报名在第一个 await 前上锁；取消报名的确认框、退赛申请 / 处理整个过程只走一次', async () => {
  // 报名：读资料还没回来时又点了一次
  const prof = deferred(); let signs = 0;
  let p = drawView({ db: { getMyProfile: () => prof.p, signUp: async () => { signs++; return {}; } } });
  p.loadSignups = async () => {};
  const a = p.join(null), b = p.join(null);
  assert.strictEqual(b, undefined, '第二次直接忽略');
  prof.resolve({ name: 'Me' }); await a;
  assert.strictEqual(signs, 1);
  await p.join(null);
  assert.strictEqual(signs, 2, '上一次结束后可以再点');
  // 取消报名：确认框还开着时再点不弹第二个；确认后只取消一次
  const modals = []; let cancels = 0;
  p = drawView({ db: { mySignup: async () => ({ _id: 's' }), cancelSignup: async () => { cancels++; } }, wx: { showModal: (o) => modals.push(o) } });
  p.loadSignups = async () => {};
  const q1 = p.quit(); p.quit(); p.quit();
  await flush();
  assert.strictEqual(modals.length, 1);
  modals[0].success({ confirm: true }); await q1;
  assert.strictEqual(cancels, 1);
  assert.strictEqual(p.data.busy, false);
  const q2 = p.quit(); await flush(); modals[1].success({ confirm: false }); await q2;
  assert.strictEqual(cancels, 1, '点了「取消」不提交');
  assert.strictEqual(modals.length, 2, '关掉后可以再点');
  // 退赛申请：选原因的弹窗还开着时再点无效；提交只有一次
  const why = deferred(); const sent = [];
  p = drawView({ pick: { reason: () => why.p }, cloud: { call: async (action) => { sent.push(action); return { list: [], owner: false, myEntrants: [], withdrawals: [] }; } } });
  p.d = { _id: 'd1', entrants: [] };
  const w1 = p.requestWithdraw();
  assert.strictEqual(p.requestWithdraw(), undefined);
  why.resolve('受伤'); await w1;
  assert.deepStrictEqual(sent, ['requestWithdraw', 'drawRequests']);
  // 发起人处理（同意 / 拒绝）共用同一把锁
  const why2 = deferred(); const sent2 = [];
  p = drawView({ pick: { reason: () => why2.p }, cloud: { call: async (action, data) => { sent2.push(action + ':' + data.approve); return { list: [], owner: true, myEntrants: [], withdrawals: [] }; } } });
  p.d = { _id: 'd1', entrants: ['Alice'] };
  p.load = async () => {};
  p.data.wdPending = [{ id: 'r1', entrant: 'Alice' }];
  const ev = { currentTarget: { dataset: { i: 0 } } };
  const r1 = p.rejectWithdraw(ev);
  assert.strictEqual(p.approveWithdraw(ev), undefined, '拒绝还没完成时点同意无效');
  assert.strictEqual(p.rejectWithdraw(ev), undefined);
  why2.resolve('已经开赛，请打完'); await r1;
  assert.deepStrictEqual(sent2, ['handleWithdraw:false', 'drawRequests:undefined']);
});

/* ---------- 资料页 ---------- */
function profilePage(db) {
  const wx = { hideShareMenu() {}, setNavigationBarTitle() {}, showToast() {}, showModal: (o) => { if (o.complete) o.complete(); if (o.success) o.success({ confirm: true }); }, showLoading() {}, hideLoading() {}, navigateBack() {}, switchTab() {} };
  const def = loadDef('pages/profile/profile.js', {
    '../../utils/db': Object.assign({ cachedProfile: () => null, myOpenid: async () => 'me', setShown: async () => {}, fetchPlayersFull: async () => [] }, db),
    '../../utils/cloud': { call: async () => ({ url: '', state: '' }) },
    '../../utils/photo': { ownSrc: () => '', peek: () => '', fileOf: () => '', applyMine() {}, setMine() {} },
    '../../utils/member': { statusCached: async () => ({ name: '' }) },
  }, wx);
  return page(def);
}
test('资料页：云端资料晚到时不覆盖用户已经改过的昵称 / 性别 / 水平 / 公开展示，没动过的照常填', async () => {
  const cloudProfile = deferred();
  const p = profilePage({ getMyProfile: () => cloudProfile.p });
  p.onLoad({});
  p.onName({ detail: { value: '新昵称' } });
  p.pickGender({ currentTarget: { dataset: { v: 'f' } } });
  cloudProfile.resolve({ name: '旧昵称', gender: 'm', level: 3.5, shown: true });
  await flush();
  assert.strictEqual(p.data.name, '新昵称');
  assert.strictEqual(p.data.gender, 'f');
  assert.strictEqual(p.data.level, 3.5, '没动过的水平按云端填');
  assert.strictEqual(p.data.shown, true);
  assert.strictEqual(p.data.isNew, false);
  // 都没动过：云端结果全部填上
  const q = profilePage({ getMyProfile: async () => ({ name: '旧昵称', gender: 'm', level: 3, shown: false }) });
  q.onLoad({}); await flush();
  assert.deepStrictEqual([q.data.name, q.data.gender, q.data.level, q.data.shown], ['旧昵称', 'm', 3, false]);
});
test('资料页：第一次保存资料成功、照片没传上去，之后按「已有资料」处理（再保存不再当第一次、不重带授权）', async () => {
  const saved = [];
  const p = profilePage({ getMyProfile: async () => null, saveMyProfile: async (x) => { saved.push(x); } });
  p.onLoad({}); await flush();
  assert.strictEqual(p.data.isNew, true);
  p.onName({ detail: { value: '小明' } });
  p.pickGender({ currentTarget: { dataset: { v: 'm' } } });
  p.photoTemp = '/tmp/x.jpg';
  p.uploadPhoto = async () => { throw new Error('网络异常'); };
  await p.save();
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].shown, false, '第一次带上授权勾选结果');
  assert.strictEqual(p.data.isNew, false, '资料已经建好');
  assert.strictEqual(p.data.saving, false);
  await p.save();
  assert.strictEqual(saved[1].shown, undefined, '再保存是「已有资料」');
});
test('资料页：无缓存打开已有资料时，云端返回前提前勾选公开展示，点保存不会丢失；prefill 也不覆盖已编辑清空的昵称', async () => {
  const cloudProfile = deferred(), saved = [];
  let setShownCalls = 0;
  const p = profilePage({
    getMyProfile: () => cloudProfile.p,
    setShown: async () => { setShownCalls++; },
    saveMyProfile: async (x) => { saved.push(x); },
  });
  p.onLoad({});
  assert.strictEqual(p.data.isNew, true);
  // 云端资料还没回来就勾选了公开展示：此时 isNew 为真，没发 setShown
  await p.toggleShown();
  assert.strictEqual(setShownCalls, 0);
  assert.strictEqual(p.data.shown, true);
  // 随后云端资料返回（云端原本 shown: false）：isNew 变成 false，界面保持已勾选
  cloudProfile.resolve({ name: '老球友', gender: 'm', level: 3, shown: false });
  await flush();
  assert.strictEqual(p.data.isNew, false);
  assert.strictEqual(p.data.shown, true);
  // 点保存：仍要带上 shown: true，否则勾选会丢
  await p.save();
  assert.strictEqual(saved.length, 1);
  assert.strictEqual(saved[0].shown, true);
  // 再点保存：shownPending 已清，不再重复带 shown
  await p.save();
  assert.strictEqual(saved[1].shown, undefined);

  // prefill 晚到时不覆盖用户手动清空过的昵称
  const memStatus = deferred();
  const wx = { hideShareMenu() {}, setNavigationBarTitle() {}, showToast() {}, showModal() {}, showLoading() {}, hideLoading() {} };
  const def = loadDef('pages/profile/profile.js', {
    '../../utils/db': { cachedProfile: () => null, getMyProfile: async () => null, myOpenid: async () => 'me' },
    '../../utils/cloud': { call: async () => ({ url: '', state: '' }) },
    '../../utils/photo': { ownSrc: () => '', peek: () => '', fileOf: () => '', applyMine() {}, setMine() {} },
    '../../utils/member': { statusCached: () => memStatus.p },
  }, wx);
  const q = page(def);
  q.onLoad({});
  await flush();
  q.onName({ detail: { value: '临时' } });
  q.onName({ detail: { value: '' } });
  memStatus.resolve({ name: '准入昵称' });
  await flush();
  assert.strictEqual(q.data.name, '', '用户改过又清空的昵称不被 prefill 填回去');
});

module.exports = T;
