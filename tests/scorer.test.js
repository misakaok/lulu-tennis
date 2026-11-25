// 场边记分：逐分状态（utils/scorer.js，规则来自 utils/rules.js）、撤销、本机草稿，以及带入日常录分页（不自动提交）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const R = require('../utils/rules');
const S = require('../pkg-manage/utils/scorer');

const T = [];
const test = (name, fn) => T.push({ name, fn });
const plain = (v) => JSON.parse(JSON.stringify(v));

const cfg = (setGames, noAd, bestOf) => ({ setGames, noAd, bestOf });
const game = (w) => w.repeat(4); // 从 0:0 连赢 4 分：金球、占先都拿下这一局
const games = (seq) => seq.split('').map(game).join(''); // 'aab' → A、A、B 各赢一局
const run = (c, pts) => S.replay(c, pts);
const st = (c, pts) => Object.assign(S.start(c, 1), { points: pts });
const to33 = games('ababab'); // 4 局制打到 3:3
const to66 = games('abababababab'); // 6 局制打到 6:6
const tbTo66 = 'ab'.repeat(6); // 抢七打到 6:6

/* ---------- 普通局 ---------- */
test('普通局：0/15/30/40；金球制 40:40 叫「金球」，下一分定局', () => {
  const c = cfg(4, true, 1);
  assert.deepStrictEqual([S.view(st(c, 'a')).callA, S.view(st(c, 'a')).callB], ['15', '0']);
  assert.deepStrictEqual([S.view(st(c, 'aab')).callA, S.view(st(c, 'aab')).callB], ['30', '15']);
  const deuce = S.view(st(c, 'aaabbb'));
  assert.deepStrictEqual([deuce.callA, deuce.callB], ['40', '40']);
  assert.match(deuce.callText, /金球/);
  const after = run(c, 'aaabbbb');
  assert.deepStrictEqual(after.games, { a: 0, b: 1 });
  assert.deepStrictEqual(after.pts, { a: 0, b: 0 });
});

test('普通局：占先制 40:40 叫「平分」，之后「占先」，净胜 2 分才拿下这一局', () => {
  const c = cfg(4, false, 1);
  assert.strictEqual(S.view(st(c, 'aaabbb')).callText, '平分');
  const adA = S.view(st(c, 'aaabbba'));
  assert.deepStrictEqual([adA.callA, adA.callB, adA.callText], ['占先', '40', 'A 方占先']);
  assert.deepStrictEqual(run(c, 'aaabbba').games, { a: 0, b: 0 });
  assert.strictEqual(S.view(st(c, 'aaabbbab')).callText, '平分'); // 回到平分
  const adB = S.view(st(c, 'aaabbbabb'));
  assert.deepStrictEqual([adB.callA, adB.callB], ['40', '占先']);
  assert.deepStrictEqual(run(c, 'aaabbbabbb').games, { a: 0, b: 1 });
  assert.deepStrictEqual(run(c, 'aaabbbaa').games, { a: 1, b: 0 });
});

/* ---------- 抢七 ---------- */
test('4 局制 3:3 抢七；金球制抢七先到 7 分即赢，记成 4:3 并通过 checkMatch', () => {
  const c = cfg(4, true, 1);
  const s = run(c, to33);
  assert.strictEqual(s.tb, true);
  assert.deepStrictEqual(s.games, { a: 3, b: 3 });
  assert.strictEqual(S.view(st(c, to33 + 'a')).callA, '1'); // 抢七用数字
  assert.strictEqual(S.view(st(c, to33 + 'a')).callText, '抢七');
  assert.strictEqual(run(c, to33 + tbTo66).done, false);
  const end = run(c, to33 + tbTo66 + 'b');
  assert.strictEqual(end.done, true);
  assert.deepStrictEqual(end.sets, [{ a: 3, b: 4, tbA: 6, tbB: 7 }]);
  const r = S.resultOf(st(c, to33 + tbTo66 + 'b'));
  assert.deepStrictEqual(r.sets, [{ a: 3, b: 4, tbA: 6, tbB: 7 }]);
  assert.strictEqual(r.winner, 'b');
  assert.ok(R.checkMatch(r.sets, 1, c).ok);
  assert.ok(R.needTiebreak(3, 3, c));
});

test('占先制抢七要净胜 2 分：7:6 不结束，9:7 结束', () => {
  const c = cfg(4, false, 1);
  assert.strictEqual(run(c, to33 + tbTo66 + 'a').done, false);
  assert.strictEqual(S.view(st(c, to33 + tbTo66 + 'a')).pointA, '赛点');
  assert.strictEqual(run(c, to33 + tbTo66 + 'ab').done, false); // 7:7
  const r = S.resultOf(st(c, to33 + tbTo66 + 'abaa'));
  assert.deepStrictEqual(r.sets, [{ a: 4, b: 3, tbA: 9, tbB: 7 }]);
  assert.ok(R.checkMatch(r.sets, 1, c).ok);
  // 先到 7 分且净胜 2 分：7:5 直接结束
  const r2 = S.resultOf(st(c, to33 + 'ab'.repeat(5) + 'aa'));
  assert.deepStrictEqual(r2.sets, [{ a: 4, b: 3, tbA: 7, tbB: 5 }]);
});

test('6 局制：6:5 还没完，7:5 拿下；6:6 抢七赢成 7:6', () => {
  const c = cfg(6, true, 1);
  const to55 = games('ababababab');
  assert.strictEqual(run(c, to55 + game('a')).done, false);
  assert.deepStrictEqual(run(c, to55 + game('a')).games, { a: 6, b: 5 });
  const r = S.resultOf(st(c, to55 + games('aa')));
  assert.deepStrictEqual(r.sets, [{ a: 7, b: 5 }]);
  assert.ok(R.checkMatch(r.sets, 1, c).ok);
  assert.strictEqual(run(c, to66).tb, true);
  const t = S.resultOf(st(c, to66 + 'a'.repeat(7)));
  assert.deepStrictEqual(t.sets, [{ a: 7, b: 6, tbA: 7, tbB: 0 }]);
  assert.ok(R.checkMatch(t.sets, 1, c).ok);
  // 4 局制在 4:2 结束，不会打到 6 局
  assert.deepStrictEqual(S.resultOf(st(cfg(4, true, 1), games('aabbaa'))).sets, [{ a: 4, b: 2 }]);
  // 6 局制 6:4 结束
  assert.deepStrictEqual(S.resultOf(st(c, games('ababababaa'))).sets, [{ a: 6, b: 4 }]);
});

test('三盘两胜：1:1 后打第三盘，2:1 完赛；完赛后锁住，再加分不生效', () => {
  const c = cfg(4, true, 3);
  const p = games('aaaa') + games('bbbb') + games('abab') + games('aa');
  const s = run(c, games('aaaa') + games('bbbb'));
  assert.strictEqual(s.done, false);
  assert.deepStrictEqual(s.won, { a: 1, b: 1 });
  assert.strictEqual(S.view(st(c, games('aaaa') + games('bbbb'))).setNo, 3);
  const done = st(c, p);
  const r = S.resultOf(done);
  assert.deepStrictEqual(r.sets, [{ a: 4, b: 0 }, { a: 0, b: 4 }, { a: 4, b: 2 }]);
  assert.deepStrictEqual([r.winner, r.won], ['a', { a: 2, b: 1 }]);
  assert.deepStrictEqual(Object.keys(r).sort(), ['bestOf', 'noAd', 'setGames', 'sets', 'winner', 'won']);
  assert.ok(R.checkMatch(r.sets, 3, c).ok);
  assert.strictEqual(S.addPoint(done, 'b'), done, '完赛后不能再加分');
  assert.strictEqual(S.view(done).resultText, 'A 方 2:1 获胜');
  // 2:0 直接结束，不打第三盘
  assert.strictEqual(run(c, games('aaaa') + games('aaaa')).done, true);
  // 没打完：没有结果，不能带入
  assert.strictEqual(S.resultOf(st(c, games('aaaa'))), null);
  assert.strictEqual(S.handoff(st(c, games('aaaa')), 'a'), null);
});

/* ---------- 撤销 ---------- */
test('撤销上一分：跨局、跨盘、撤销决定胜负的最后一分都能回到之前的状态，然后继续记分', () => {
  const c = cfg(4, false, 3);
  let s = S.start(c, 1);
  'aaa'.split('').forEach((w) => { s = S.addPoint(s, w); });
  s = S.addPoint(s, 'a'); // 拿下第一局
  assert.deepStrictEqual(run(c, s.points).games, { a: 1, b: 0 });
  s = S.undo(s); // 跨局撤销：回到 40:0
  assert.deepStrictEqual([run(c, s.points).games, S.view(s).callA, S.view(s).callB], [{ a: 0, b: 0 }, '40', '0']);

  // 跨盘：第一盘的最后一分撤销后，回到第一盘 3:x、40:0
  s = st(c, games('aaaa'));
  assert.deepStrictEqual(run(c, s.points).sets, [{ a: 4, b: 0 }]);
  s = S.undo(s);
  const back = run(c, s.points);
  assert.deepStrictEqual([back.sets, back.games, back.pts], [[], { a: 3, b: 0 }, { a: 3, b: 0 }]);

  // 抢七里赢下这一盘的那一分也能撤销
  s = st(c, to33 + 'a'.repeat(7));
  assert.strictEqual(run(c, s.points).sets.length, 1);
  s = S.undo(s);
  assert.deepStrictEqual([run(c, s.points).tb, run(c, s.points).pts], [true, { a: 6, b: 0 }]);

  // 决定胜负的最后一分：撤销后解锁，可以继续，改由另一方赢
  const full = games('aaaa') + games('bbbb') + games('aaa') + 'aaa';
  s = st(c, full + 'a');
  assert.strictEqual(S.view(s).done, true);
  s = S.undo(s);
  assert.strictEqual(S.view(s).done, false);
  assert.strictEqual(S.view(s).pointA, '赛点');
  s = S.addPoint(s, 'b');
  assert.strictEqual(S.view(s).done, false);
  assert.deepStrictEqual(S.view(s).cols.map((x) => [x.a, x.b]), [[4, 0], [0, 4], [3, 0]]);
  // 没有分可撤
  const empty = S.start(c, 1);
  assert.strictEqual(S.undo(empty), empty);
  assert.strictEqual(S.view(empty).canUndo, false);
});

/* ---------- 本机草稿 ---------- */
function mockWx(store) {
  return {
    getStorageSync: (k) => (k in store ? plain(store[k]) : ''),
    setStorageSync: (k, v) => { store[k] = plain(v); },
    removeStorageSync: (k) => { delete store[k]; },
    getStorageInfoSync: () => ({ keys: Object.keys(store) }),
  };
}
function withWx(store, fn) {
  const saved = global.wx;
  global.wx = mockWx(store); // utils/scorer.js 用全局 wx 读写本机存储，和页面拿到的是同一份 store
  return Promise.resolve().then(fn).finally(() => { global.wx = saved; });
}

test('草稿：只存规则和得分顺序（没有姓名、身份），重开后能恢复；坏数据不认，完赛后多出来的分去掉', () => withWx({}, () => {
  const c = cfg(6, false, 3);
  const s = st(c, games('aab') + 'ab');
  assert.ok(S.saveDraft(s));
  const raw = global.wx.getStorageSync(S.DRAFT_KEY);
  assert.deepStrictEqual(Object.keys(raw).sort(), ['cfg', 'createdAt', 'id', 'points', 'updatedAt', 'v']);
  assert.deepStrictEqual(Object.keys(raw.cfg).sort(), ['bestOf', 'noAd', 'setGames']);
  const d = S.loadDraft();
  assert.deepStrictEqual(d, plain(s));
  assert.deepStrictEqual(S.view(d), S.view(s)); // 恢复后记分牌一样，也能继续撤销
  assert.strictEqual(S.undo(d).points, s.points.slice(0, -1));
  // 坏数据
  assert.strictEqual(S.restore(Object.assign({}, raw, { points: 'abx' })), null);
  assert.strictEqual(S.restore(Object.assign({}, raw, { cfg: { setGames: 5, noAd: true, bestOf: 1 } })), null);
  assert.strictEqual(S.restore(Object.assign({}, raw, { v: 2 })), null);
  assert.strictEqual(S.restore(null), null);
  assert.strictEqual(S.restore(Object.assign({}, raw, { id: '<x>' })), null);
  const extra = S.restore({ v: 1, id: 'sc1', cfg: cfg(4, true, 1), points: games('aaaa') + 'bbb' });
  assert.strictEqual(extra.points, games('aaaa'));
  // 只清掉对应的那一场
  S.clearDraft('scother');
  assert.ok(S.loadDraft());
  S.clearDraft(s.id);
  assert.strictEqual(S.loadDraft(), null);
}));

test('退出成员身份（clearProtected）时，本机的场边记分草稿一起清掉', () => withWx({ scorer_draft: { v: 1 }, my_openid: 'x', last_rules: {} }, () => {
  const M = require('../utils/member');
  M.clearProtected();
  const keys = global.wx.getStorageInfoSync().keys.sort();
  assert.deepStrictEqual(keys, ['last_rules', 'my_openid']);
}));

/* ---------- 页面 ---------- */
function load(file, wx, deps, globals) {
  const filename = path.resolve(__dirname, '..', file);
  let def;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (id) => (deps && deps[id]) || createRequire(filename)(id), wx, Page: (d) => { def = d; }, console, setTimeout() {}, ...globals,
  });
  return Object.assign({}, def, {
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
const tap = (o) => ({ currentTarget: { dataset: o } });

test('记分页：选规则开始，逐分记分自动存本机；重开显示「继续记分 / 开始新一场」，覆盖前确认', async () => {
  const store = { last_rules: { setGames: 6, noAd: false, bestOf: 3 } };
  const modals = [];
  let answer = false;
  const wx = Object.assign(mockWx(store), {
    showModal: (o) => { modals.push(o); o.success({ confirm: answer }); },
    setKeepScreenOn() {}, vibrateShort() {}, navigateTo() { throw new Error('不应跳转'); },
  });
  const deps = { '../../utils/member': { statusCached: async () => ({ status: 'active' }) } };
  await withWx(store, async () => {
    const p = load('pkg-manage/scorer/scorer.js', wx, deps);
    p.onLoad(); await p.onShow();
    assert.strictEqual(p.data.mode, 'setup');
    assert.deepStrictEqual(p.data.cfg, { setGames: 6, noAd: false, bestOf: 3 }); // 默认用上次的规则
    p.setOpt(tap({ k: 'setGames', v: '4' })); p.setOpt(tap({ k: 'noAd', v: '1' })); p.setOpt(tap({ k: 'bestOf', v: '1' }));
    p.startNew();
    assert.strictEqual(modals.length, 0, '没有草稿时直接开始');
    assert.strictEqual(p.data.mode, 'live');
    'aaab'.split('').forEach((side) => p.point(tap({ side })));
    assert.deepStrictEqual([p.data.v.callA, p.data.v.callB], ['40', '15']);
    assert.strictEqual(S.loadDraft().points, 'aaab');
    assert.deepStrictEqual(Object.keys(store.scorer_draft).sort(), ['cfg', 'createdAt', 'id', 'points', 'updatedAt', 'v']); // 没有姓名、身份
    p.undo();
    assert.strictEqual(S.loadDraft().points, 'aaa');
    // 触觉反馈：普通一分轻震，拿下一局重一点，撤销轻震（4 局制、一盘：A 方连得 4 分拿下第一局）
    const buzz = [];
    const h = load('pkg-manage/scorer/scorer.js', wx, Object.assign({ '../../utils/haptic': { light: () => buzz.push('l'), medium: () => buzz.push('m') } }, deps));
    h.onLoad(); await h.onShow(); h.resume();
    h.point(tap({ side: 'a' }));
    assert.deepStrictEqual(buzz, ['m'], '第 4 分拿下一局');
    h.point(tap({ side: 'b' }));
    h.undo();
    assert.deepStrictEqual(buzz, ['m', 'l', 'l']);
    'aaaa'.split('').concat('aaaa'.split(''), 'aaaa'.split('')).forEach((side) => h.point(tap({ side })));
    assert.strictEqual(h.data.v.done, true);
    assert.strictEqual(buzz[buzz.length - 1], 'm', '完赛那一分重一点');
    S.saveDraft(Object.assign({}, S.loadDraft(), { points: 'aaa' }));

    // 小程序重开：有草稿先问继续还是新一场
    const q = load('pkg-manage/scorer/scorer.js', wx, deps);
    q.onLoad(); await q.onShow();
    assert.strictEqual(q.data.mode, 'resume');
    q.resume();
    assert.strictEqual(q.data.mode, 'live');
    assert.deepStrictEqual([q.data.v.callA, q.data.v.callB], ['40', '0']);
    q.goSetup();
    assert.strictEqual(q.data.mode, 'setup');
    assert.strictEqual(q.data.hasDraft, true);
    q.startNew(); // 取消：不覆盖
    assert.strictEqual(modals.length, 1);
    assert.match(modals[0].content, /覆盖/);
    assert.strictEqual(S.loadDraft().points, 'aaa');
    q.backToDraft();
    assert.strictEqual(q.data.mode, 'resume');
    q.goSetup();
    answer = true; q.startNew(); // 确认覆盖
    assert.strictEqual(S.loadDraft().points, '');
    assert.strictEqual(q.data.mode, 'live');
  });
});

test('记分页：不是正式成员不能开始；完赛后锁住，「带入日常录分」只跳到录分页、不写正式战绩，草稿保留', async () => {
  const store = {};
  const navs = [];
  let tapIndex = 1;
  const wx = Object.assign(mockWx(store), {
    showModal: (o) => o.success({ confirm: true }), setKeepScreenOn() {}, vibrateShort() {},
    showActionSheet: (o) => o.success({ tapIndex }), navigateTo: (o) => navs.push(o.url),
  });
  let status = 'removed';
  const deps = {
    '../../utils/member': { statusCached: async () => ({ status }) },
    '../../utils/db': new Proxy({}, { get: () => () => { throw new Error('记分页不应读写云端'); } }),
  };
  await withWx(store, async () => {
    const p = load('pkg-manage/scorer/scorer.js', wx, deps);
    p.onLoad(); await p.onShow();
    assert.match(p.data.authError, /正式成员/);
    p.startNew();
    assert.strictEqual(S.loadDraft(), null);
    status = 'active'; await p.onShow();
    p.startNew();
    (games('aaa') + 'aaa').split('').forEach((side) => p.point(tap({ side })));
    assert.strictEqual(p.data.v.done, false);
    p.point(tap({ side: 'a' }));
    assert.strictEqual(p.data.v.done, true);
    p.point(tap({ side: 'b' })); // 锁住
    assert.strictEqual(S.loadDraft().points.length, 16);
    const id = S.loadDraft().id;
    p.handoff();
    assert.deepStrictEqual(navs, [`/pkg-manage/add/add?scorer=${id}&side=b`]);
    assert.ok(S.loadDraft(), '带入时不清草稿');
    p.undo(); // 撤回最后一分可以继续
    assert.strictEqual(p.data.v.done, false);
    p.handoff(); // 没完赛不能带入
    assert.strictEqual(navs.length, 1);
  });
});

test('带入日常录分：预填规则和盘分（自己在 B 方时对调），不自动提交、不改上次的规则；提交成功才清掉草稿，失败保留', async () => {
  const c = cfg(6, false, 3);
  const pts = games('aaaaaa') + games('bbbbbb') + games('aaaaab'); // 6:0 0:6 5:1 → 还没完
  const done = st(c, pts + games('a')); // 6:0 0:6 6:1
  const store = { last_rules: { setGames: 4, noAd: true, bestOf: 1 } };
  const toasts = [];
  let added = 0, fail = false;
  const wx = Object.assign(mockWx(store), {
    showToast: (o) => toasts.push(o.title), showModal() {}, redirectTo() {},
  });
  const deps = {
    '../../utils/db': {
      cachedPlayersFull: () => [], fetchPlayersFull: async () => [], cachedProfile: () => null, getMyProfile: async () => null, myOpenid: async () => 'me',
      addMatch: async () => { added++; if (fail) throw new Error('网络'); return { _id: 'm1' }; },
    },
  };
  await withWx(store, async () => {
    S.saveDraft(done);
    const p = load('pkg-manage/add/add.js', wx, deps, { setTimeout() {} });
    p.selectComponent = () => null;
    p.onLoad({ scorer: done.id, side: 'b' });
    assert.strictEqual(added, 0, '打开录分页不提交');
    assert.strictEqual(p.data.fromScorer, true);
    assert.deepStrictEqual([p.data.setGames, p.data.noAd, p.data.bestOf], [6, false, 3]);
    assert.deepStrictEqual(p.data.initSets, [{ a: 0, b: 6 }, { a: 6, b: 0 }, { a: 1, b: 6 }]); // 对调：自己在 A 方
    assert.ok(R.checkMatch(p.data.initSets, 3, c).ok);
    assert.deepStrictEqual(store.last_rules, { setGames: 4, noAd: true, bestOf: 1 });
    // 录分页的比分组件用同样的规则校验带入的比分
    const xml = fs.readFileSync(path.join(__dirname, '../pkg-manage/add/add.wxml'), 'utf8');
    assert.ok(/<score-sets id="sets" init="\{\{initSets\}\}"/.test(xml));
    // 仍然走录分页原来的流程：没选对手不能保存
    p.data.canRecordDaily = true;
    p.onSets({ detail: R.checkMatch(p.data.initSets, 3, c) });
    await p.submit();
    assert.strictEqual(added, 0);
    // 选好球员（模拟录分页整理出来的结果）后提交：失败时草稿保留
    p.myId = 'me'; p.uidOf = { 我: 'me', 对手: 'op' };
    p.result = { sets: p.data.initSets, winner: 'b', won: { a: 1, b: 2 }, a: ['我'], b: ['对手'] };
    fail = true;
    await p.submit();
    assert.strictEqual(added, 1);
    assert.ok(S.loadDraft(), '提交失败时草稿保留');
    fail = false;
    await p.submit();
    assert.strictEqual(added, 2);
    assert.strictEqual(S.loadDraft(), null, '正式提交成功后清掉草稿');

    // 草稿对不上 / 没完赛：不预填，照常是普通录分
    S.saveDraft(st(c, pts));
    const q = load('pkg-manage/add/add.js', wx, deps, { setTimeout() {} });
    q.onLoad({ scorer: S.loadDraft().id });
    assert.strictEqual(q.data.fromScorer, false);
    assert.deepStrictEqual(q.data.initSets, []);
    assert.ok(toasts.some((t) => /没找到/.test(t)));
    // 普通「记一场」：不带参数，和原来一样，不碰草稿
    const n = load('pkg-manage/add/add.js', wx, deps, { setTimeout() {} });
    n.onLoad({});
    assert.deepStrictEqual([n.data.fromScorer, n.data.setGames, n.data.bestOf], [false, 4, 1]);
    assert.ok(S.loadDraft());
  });
});

test('战绩页右下角只有「记一场」（只给正式成员），场边记分在记一场页里面；场边记分页不开转发', () => withWx({}, () => {
  const xml = fs.readFileSync(path.join(__dirname, '../pages/index/index.wxml'), 'utf8');
  assert.ok(/<view wx:if="\{\{canRecordDaily\}\}" class="fabs">[\s\S]*bindtap="goAdd"[\s\S]*记一场/.test(xml));
  assert.ok(!/场边记分<\/view>|goScorer|fab-alt/.test(xml), '右下角不再放场边记分');
  const addXml = fs.readFileSync(path.join(__dirname, '../pkg-manage/add/add.wxml'), 'utf8');
  assert.ok(/<view wx:if="\{\{!fromScorer\}\}" class="sc-row">[\s\S]*bindtap="openScorer"/.test(addXml), '记一场页有场边记分入口（已经带入比分就不再显示）');
  const navs = [];
  const p = load('pages/index/index.js', { navigateTo: (o) => navs.push(o.url), getStorageSync: () => '' }, {
    '../../utils/db': { cachedMatchesAll: () => [], cachedPlayersFull: () => [], cachedProfile: () => null },
  });
  assert.strictEqual(p.goScorer, undefined);
  p.goAdd();
  assert.deepStrictEqual(navs, []);
  p.data.canRecordDaily = true;
  p.goAdd();
  assert.deepStrictEqual(navs, ['/pkg-manage/add/add']);
  const conf = JSON.parse(fs.readFileSync(path.join(__dirname, '../pkg-manage/scorer/scorer.json'), 'utf8'));
  assert.strictEqual(conf.enableShareAppMessage, false);
  assert.strictEqual(conf.enableShareTimeline, false);
  const code = fs.readFileSync(path.join(__dirname, '../pkg-manage/scorer/scorer.js'), 'utf8') + fs.readFileSync(path.join(__dirname, '../pkg-manage/utils/scorer.js'), 'utf8');
  assert.ok(!/onShareAppMessage|onShareTimeline|utils\/db|cloud|requestSubscribeMessage|uploadFile/.test(code.replace(/\/\/.*$/gm, '')), '只在本机，不上传、不同步、不分享');
}));

/* ---------- 活动场次：从活动录分页打开、完赛后回到这一场预填 ---------- */
test('活动场次草稿：只多存活动和场次编号（没有姓名）；编号格式不对不认；交还标记只给同一场、取一次就没了', () => withWx({}, () => {
  const c = cfg(4, true, 1);
  const s = S.start(c, 1, { drawId: 'd1', key: 'g0-1', name: 'Alice' });
  assert.deepStrictEqual(s.ev, { drawId: 'd1', key: 'g0-1' });
  assert.strictEqual(S.start(c, 1, { drawId: '<x>', key: 'g0-1' }).ev, undefined);
  assert.ok(S.saveDraft(Object.assign({}, s, { points: 'aa' })));
  const raw = global.wx.getStorageSync(S.DRAFT_KEY);
  assert.deepStrictEqual(Object.keys(raw).sort(), ['cfg', 'createdAt', 'ev', 'id', 'points', 'updatedAt', 'v']);
  assert.deepStrictEqual(raw.ev, { drawId: 'd1', key: 'g0-1' });
  assert.deepStrictEqual(S.loadDraft().ev, { drawId: 'd1', key: 'g0-1' });
  assert.strictEqual(S.restore(Object.assign({}, raw, { ev: { drawId: 'd1', key: 'k 1' } })), null);
  assert.strictEqual(S.restore(Object.assign({}, raw, { ev: 'd1' })), null);
  assert.ok(S.sameEv(S.loadDraft(), 'd1', 'g0-1') && !S.sameEv(S.loadDraft(), 'd1', 'g0-2'));
  // 名字只在内存里
  S.setLabels(s.ev, { a: 'Alice', b: 'Bob', title: '分组循环' });
  assert.deepStrictEqual(S.labelsOf(s.ev), { a: 'Alice', b: 'Bob', title: '分组循环' });
  assert.ok(!/Alice|Bob/.test(JSON.stringify(global.wx.getStorageSync(S.DRAFT_KEY))));
  S.setPending(s);
  assert.strictEqual(S.takePending('d1', 'g0-2'), '', '别的场次拿不到');
  assert.strictEqual(S.takePending('d1', 'g0-1'), s.id);
  assert.strictEqual(S.takePending('d1', 'g0-1'), '', '取一次就清掉');
}));

function scorePage(store, over) {
  const calls = [], navs = [], toasts = [], modals = [];
  let confirm = true;
  const wx = Object.assign(mockWx(store), {
    showToast: (o) => toasts.push(o.title), showModal: (o) => { modals.push(o); if (o.success) o.success({ confirm }); },
    navigateTo: (o) => navs.push(o.url), navigateBack() { navs.push('back'); }, setNavigationBarTitle() {},
  });
  const deps = {
    '../../utils/db': {},
    '../../utils/cloud': { call: async (action, data) => { calls.push({ action, data }); return { ok: true }; } },
    '../../utils/pick': { reason: async () => '' },
  };
  const p = load('pkg-manage/score/score.js', wx, deps);
  p.drawId = 'd1'; p.key = 'g0-1';
  p.cfg = { setGames: 4, noAd: true, bestOf: 1, stage: '分组循环' };
  p.f = { a: 'Alice', b: 'Bob', stage: '分组循环 · 第 1 轮', done: false, sets: [] };
  p.data.canEdit = true;
  Object.assign(p, over || {});
  return { p, calls, navs, toasts, modals, setConfirm: (v) => { confirm = v; } };
}

test('活动录分页：还没录分时有「场边记分」，用这一场的规则开一场并带上双方名字；本机另有一场先确认覆盖', async () => {
  const store = {};
  await withWx(store, async () => {
    const { p, navs, modals, setConfirm } = scorePage(store);
    p.refreshScorer();
    assert.deepStrictEqual([p.data.scorerOk, p.data.scorerResume], [true, false]);
    p.openScorer();
    assert.deepStrictEqual(navs, ['/pkg-manage/scorer/scorer?go=1']);
    const d = S.loadDraft();
    assert.deepStrictEqual(plain([d.ev, d.cfg, d.points]), [{ drawId: 'd1', key: 'g0-1' }, { setGames: 4, noAd: true, bestOf: 1 }, '']);
    assert.deepStrictEqual(S.labelsOf(d.ev), { a: 'Alice', b: 'Bob', title: '分组循环 · 第 1 轮' });
    // 记了几分回来：按钮变成「继续」，再点不重开
    S.saveDraft(Object.assign({}, d, { points: 'ab' }));
    p.onShow();
    assert.strictEqual(p.data.scorerResume, true);
    p.openScorer();
    assert.strictEqual(S.loadDraft().points, 'ab');
    assert.strictEqual(modals.length, 0);
    // 本机是另一场（日常记分）：先确认，取消就不动
    S.saveDraft(Object.assign(S.start(cfg(6, false, 3), 2), { points: 'aaa' }));
    setConfirm(false); p.openScorer();
    assert.strictEqual(modals.length, 1); assert.match(modals[0].content, /覆盖/);
    assert.strictEqual(S.loadDraft().ev, undefined);
    setConfirm(true); p.openScorer();
    assert.deepStrictEqual(S.loadDraft().ev, { drawId: 'd1', key: 'g0-1' });
    // 已经有比分、或者不能录这一场的人：没有入口
    const done = scorePage(store); done.p.f.done = true; done.p.refreshScorer();
    assert.strictEqual(done.p.data.scorerOk, false);
    const other = scorePage(store); other.p.data.canEdit = false; other.p.refreshScorer();
    assert.strictEqual(other.p.data.scorerOk, false);
    other.p.openScorer();
  });
});

test('活动录分页：完赛的场边记分退回来预填局分，不自动提交；规则变了、别的场次、没打完都不预填；提交成功才清掉草稿', async () => {
  const store = {};
  await withWx(store, async () => {
    const c = cfg(4, true, 1);
    const fin = Object.assign(S.start(c, 1, { drawId: 'd1', key: 'g0-1' }), { points: games('aaab') + games('a') }); // 4:1
    S.saveDraft(fin);
    const { p, calls, modals, toasts } = scorePage(store);
    S.setPending(fin);
    p.onShow();
    assert.strictEqual(calls.length, 0, '只预填，不提交');
    assert.deepStrictEqual([p.data.editing, p.data.fromScorer], [true, true]);
    assert.deepStrictEqual(plain(p.data.init), [{ a: 4, b: 1 }]);
    assert.ok(R.checkMatch(p.data.init, 1, c).ok);
    // 提交：走原来的 recordEventMatch，成功后才清草稿
    p.res = R.checkMatch(p.data.init, 1, c);
    await p.submit();
    assert.deepStrictEqual(calls.map((x) => x.action), ['recordEventMatch']);
    assert.deepStrictEqual(plain(calls[0].data.sets), [{ a: 4, b: 1 }]);
    assert.strictEqual(S.loadDraft(), null);
    // 规则变了：不预填，提示按这一场的规则填
    S.saveDraft(fin);
    const q = scorePage(store, {}); q.p.cfg = { setGames: 6, noAd: true, bestOf: 1 };
    q.p.applyScorer(fin.id);
    assert.strictEqual(q.p.data.fromScorer, false); assert.match(q.modals[0].content, /规则/);
    // 别的场次的草稿、没打完的：不预填
    const r2 = scorePage(store); r2.p.key = 'g0-2'; r2.p.applyScorer(fin.id);
    assert.strictEqual(r2.p.data.fromScorer, false);
    // 调整对阵后，即使同一个位置和规则没变，也不能带入原来双方的比分。
    const reordered = scorePage(store); reordered.p.drawVersion = 1; reordered.p.applyScorer(fin.id);
    assert.strictEqual(reordered.p.data.fromScorer, false);
    S.saveDraft(Object.assign({}, fin, { points: 'aaa' }));
    const r3 = scorePage(store); r3.p.applyScorer(fin.id);
    assert.strictEqual(r3.p.data.fromScorer, false);
    assert.ok(r3.toasts.length && modals.length === 0);
    // 不能录这一场的人：不预填
    S.saveDraft(fin);
    const r4 = scorePage(store); r4.p.data.canEdit = false; r4.p.applyScorer(fin.id);
    assert.strictEqual(r4.p.data.fromScorer, false);
    // 提交失败：草稿保留
    const r5 = scorePage(store); r5.p.applyScorer(fin.id);
    r5.p.withImpact = async () => { throw new Error('网络'); };
    r5.p.res = R.checkMatch(r5.p.data.init, 1, c);
    await r5.p.submit();
    assert.ok(S.loadDraft(), '提交失败不清草稿');
  });
});

test('记分页（活动场次）：直接进入记分、显示双方名字；完赛后退回这一场的录分页（或重新打开它），不读写云端', async () => {
  const store = {};
  const navs = [];
  let prev = null;
  const wx = Object.assign(mockWx(store), {
    showModal: (o) => o.success({ confirm: true }), setKeepScreenOn() {}, vibrateShort() {},
    showActionSheet() { throw new Error('活动场次不用选自己在哪一方'); },
    navigateTo: (o) => navs.push(o.url), navigateBack: () => navs.push('back'), redirectTo: (o) => navs.push('redirect ' + o.url),
  });
  const deps = {
    '../../utils/member': { statusCached: async () => ({ status: 'active' }) },
    '../../utils/db': new Proxy({}, { get: () => () => { throw new Error('记分页不应读写云端'); } }),
  };
  await withWx(store, async () => {
    const s = S.start(cfg(4, false, 1), 1, { drawId: 'd1', key: 'g0-1' });
    S.saveDraft(s);
    S.setLabels(s.ev, { a: 'Alice', b: 'Bob', title: '分组循环' });
    const p = load('pkg-manage/scorer/scorer.js', wx, deps, { getCurrentPages: () => [{ route: 'pages/draw-view/draw-view' }, prev, {}].filter(Boolean) });
    p.onLoad({ go: '1' }); await p.onShow();
    assert.strictEqual(p.data.mode, 'live');
    assert.deepStrictEqual(plain([p.data.ev, p.data.names, p.data.evTitle]), [true, { a: 'Alice', b: 'Bob' }, '分组循环']);
    (games('aaa') + 'aaab').split('').forEach((side) => p.point(tap({ side }))); // 占先制 3:0，40:15
    'bb'.split('').forEach((side) => p.point(tap({ side }))); // 40:40 → 平分
    p.point(tap({ side: 'b' }));
    assert.strictEqual(p.data.v.callText, 'Bob 占先');
    'aaa'.split('').forEach((side) => p.point(tap({ side }))); // 回到平分、A 占先、拿下 → 4:0
    assert.strictEqual(p.data.v.done, true);
    assert.strictEqual(p.data.v.resultText, 'Alice 1:0 获胜');
    // 从这一场的录分页进来：退回去并留标记
    prev = { route: 'pkg-manage/score/score', drawId: 'd1', key: 'g0-1' };
    p.handoff();
    assert.deepStrictEqual(navs, ['back']);
    assert.strictEqual(S.takePending('d1', 'g0-1'), s.id);
    // 从战绩页的「场边记分」继续的：重新打开这一场的录分页
    prev = { route: 'pages/index/index' };
    p.handoff();
    assert.strictEqual(navs[1], `redirect /pkg-manage/score/score?drawId=d1&key=g0-1&scorer=${s.id}`);
    assert.ok(S.loadDraft(), '带入时不清草稿');
    // 小程序重开后没有名字：显示 A 方 / B 方
    const q = load('pkg-manage/scorer/scorer.js', wx, deps, { getCurrentPages: () => [] });
    const saved = S.labelsOf;
    S.labelsOf = () => null;
    try { q.onLoad({}); await q.onShow(); } finally { S.labelsOf = saved; }
    assert.deepStrictEqual(plain([q.data.mode, q.data.names, q.data.evTitle]), ['resume', { a: 'A 方', b: 'B 方' }, '活动场次']);
  });
});

test('活动录分页：「场边记分」入口在录分卡片里，按钮用小号 .btn-line mini；带入后有提示', () => {
  const xml = fs.readFileSync(path.join(__dirname, '../pkg-manage/score/score.wxml'), 'utf8');
  assert.ok(/wx:if="\{\{scorerOk\}\}"[\s\S]*class="btn-line mini"[^>]*bindtap="openScorer"/.test(xml));
  assert.ok(/wx:if="\{\{fromScorer\}\}"[^>]*>已带入场边记分的局分，核对后点「提交比分」才会保存/.test(xml));
  const sxml = fs.readFileSync(path.join(__dirname, '../pkg-manage/scorer/scorer.wxml'), 'utf8');
  assert.ok(/带入这一场录分/.test(sxml));
});

test('从「记一场」进场边记分：没打完显示「继续场边记分」；完赛后「带入日常录分」退回同一页预填（不叠一层录分页，已选的球员保留）', async () => {
  const c = cfg(4, true, 1);
  const store = {};
  const navs = [];
  let backs = 0;
  const wx = Object.assign(mockWx(store), {
    showModal: (o) => o.success({ confirm: true }), setKeepScreenOn() {}, vibrateShort() {}, showToast() {},
    showActionSheet: (o) => o.success({ tapIndex: 0 }), navigateTo: (o) => navs.push(o.url), navigateBack: () => { backs++; },
  });
  const deps = {
    '../../utils/member': { statusCached: async () => ({ status: 'active' }), status: async () => ({ status: 'active' }), knownActive: () => false },
    '../../utils/db': { cachedPlayersFull: () => [], fetchPlayersFull: async () => [], cachedProfile: () => null, getMyProfile: async () => null, myOpenid: async () => 'me' },
  };
  await withWx(store, async () => {
    const add = load('pkg-manage/add/add.js', wx, deps, { setTimeout() {} });
    add.selectComponent = () => null;
    add.onLoad({});
    await add.onShow();
    assert.strictEqual(add.data.scorerResume, false);
    add.openScorer();
    assert.deepStrictEqual(navs, ['/pkg-manage/scorer/scorer']);
    add.slots.b[0] = '对手'; // 记分前已经选好的对手
    S.saveDraft(st(c, games('aa')));
    await add.onShow();
    assert.strictEqual(add.data.scorerResume, true, '没打完：继续场边记分');
    S.saveDraft(st(c, games('aaaa')));
    const sc = load('pkg-manage/scorer/scorer.js', wx, deps, { getCurrentPages: () => [{ route: 'pages/index/index' }, { route: 'pkg-manage/add/add' }, {}] });
    sc.onLoad(); await sc.onShow();
    sc.handoff();
    assert.deepStrictEqual([backs, navs.length], [1, 1], '退回记一场页，不再打开新的录分页');
    await add.onShow();
    assert.deepStrictEqual([add.data.fromScorer, add.data.setGames, add.data.bestOf], [true, 4, 1]);
    assert.deepStrictEqual(add.data.initSets, [{ a: 4, b: 0 }]);
    assert.strictEqual(add.slots.b[0], '对手', '已选的球员保留');
    await add.onShow();
    assert.deepStrictEqual(add.data.initSets, [{ a: 4, b: 0 }], '标记只用一次');
    // 不是从记一场进来的（例如重开小程序后直接打开记分页）：照旧打开新的录分页
    const sc2 = load('pkg-manage/scorer/scorer.js', wx, deps, { getCurrentPages: () => [{ route: 'pkg-manage/scorer/scorer' }] });
    sc2.onLoad(); await sc2.onShow();
    sc2.handoff();
    assert.match(navs[navs.length - 1], /^\/pkg-manage\/add\/add\?scorer=/);
  });
});

test('发球权与换边提醒（ITF 规则）：普通局逐局换发、奇数局换边；抢七 1-2-2-2 轮换与每 6 分换边；下一盘顺延发球与盘间换边', () => withWx({}, () => {
  const c = cfg(4, true, 3);
  const s0 = S.start(c, 1000, null, 'a');
  assert.strictEqual(s0.serve, 'a');
  assert.ok(S.saveDraft(s0));
  assert.strictEqual(S.loadDraft().serve, 'a');
  assert.strictEqual(S.restore(Object.assign({}, s0, { serve: 'x' })), null, '非法发球方不认');
  assert.deepStrictEqual([S.view(s0).server, S.view(s0).changeEnds], ['a', false]);
  // 1:0（奇数局结束）：换发给 B + 提示换边；打完下一局 1:1：换发给 A + 不换边
  const v10 = S.view(Object.assign({}, s0, { points: game('a') }));
  assert.deepStrictEqual([v10.server, v10.changeEnds, v10.changeText], ['b', true, '奇数局结束 · 换边']);
  const v11 = S.view(Object.assign({}, s0, { points: games('ab') }));
  assert.deepStrictEqual([v11.server, v11.changeEnds], ['a', false]);
  // 3:3 进抢七（已打 6 局，偶数）：A 先发首球，随后 1-2-2-2 轮换，第 6 分触发抢七换边
  const tbSrv = [0, 1, 2, 3, 4, 5, 6].map((n) => S.view(Object.assign({}, s0, { points: to33 + 'a'.repeat(n) })).server);
  assert.deepStrictEqual(tbSrv, ['a', 'b', 'b', 'a', 'a', 'b', 'b']);
  const vTb6 = S.view(Object.assign({}, s0, { points: to33 + 'ababab' }));
  assert.deepStrictEqual([vTb6.changeEnds, vTb6.changeText], [true, '抢七每 6 分换边']);
  // 抢七 4:3 结束（共 7 局，奇数）：第二盘由抢七首球接发方 B 先发 + 盘间换边
  const vSet2Tb = S.view(Object.assign({}, s0, { points: to33 + 'a'.repeat(7) }));
  assert.deepStrictEqual([vSet2Tb.setNo, vSet2Tb.server, vSet2Tb.changeEnds, vSet2Tb.changeText], [2, 'b', true, '盘间换边']);
  // 第一盘 4:2 结束（共 6 局，偶数）：第二盘由 A 先发 + 不换边
  const vSet2Even = S.view(Object.assign({}, s0, { points: games('aabbaa') }));
  assert.deepStrictEqual([vSet2Even.setNo, vSet2Even.server, vSet2Even.changeEnds], [2, 'a', false]);
}));

test('转球拍选发球 & 完赛顺手记入球拍打球时长', async () => {
  const store = {};
  const savedLogs = [];
  const toasts = [];
  const clock = require('./fake-clock')();
  await clock.run(async () => {
    const wx = Object.assign(mockWx(store), {
      showModal: (o) => o.success({ confirm: true }), setKeepScreenOn() {}, vibrateShort() {},
      showToast: (o) => toasts.push(o.title), navigateTo() {},
    });
    const fakeRackets = {
      cachedList: () => ({ rackets: [{ id: 'r1', no: 1, brand: 'wilson', model: 'Clash', status: 'active' }], logs: [] }),
      load: async () => ({ rackets: [{ id: 'r1', no: 1, brand: 'wilson', model: 'Clash', status: 'active' }], logs: [] }),
      saveLog: async (id, rid, log) => { savedLogs.push({ id, rid, log }); return 'l1'; },
      refreshBadge: () => Promise.resolve(0),
    };
    const deps = {
      '../../utils/member': { statusCached: async () => ({ status: 'active' }) },
      '../../utils/rackets': fakeRackets,
    };
    await withWx(store, async () => {
      const p = load('pkg-manage/scorer/scorer.js', wx, deps, { setTimeout, clearTimeout });
      p.onLoad(); await p.onShow();
      p.openToss(); p.spinCap();
      assert.strictEqual(p.data.tossSpin, true);
      await clock.wait(800);
      assert.ok(p.data.tossRes === 'up' || p.data.tossRes === 'down');
      p.pickServe(tap({ side: 'b' }));
      assert.strictEqual(p.data.setupServe, 'b');
      p.startNew();
      assert.strictEqual(p.data.v.server, 'b');
      p.toggleServe();
      assert.strictEqual(p.data.v.server, 'a');
      // 模拟打了 45 分钟完赛
      p.state = Object.assign({}, p.state, { createdAt: Date.now() - 45 * 60000, points: games('aaaa'), updatedAt: Date.now() });
      S.saveDraft(p.state);
      p.render();
      assert.strictEqual(p.data.v.done, true);
      assert.strictEqual(p.data.v.elapsedMin, 45);
      p.openRkLog();
      assert.deepStrictEqual([p.data.rkOpen, p.data.rkId, p.data.rkMin], [true, 'r1', '45']);
      await p.saveRkLog();
      assert.strictEqual(savedLogs.length, 1);
      assert.deepStrictEqual([savedLogs[0].rid, savedLogs[0].log.kind, savedLogs[0].log.minutes], ['r1', 'play', 45]);
      assert.ok(p.data.rkLogged && p.data.rkLogged.title === '1 号拍');
      assert.ok(toasts.some((t) => /已记入/.test(t)));
    });
  });
});

test('可选技术统计（ACE / 双误 / 制胜分 / 非受迫失误）与破发点 / 局势走势：双误与非受迫失误记给丢分方，撤销同步裁掉标签', () => withWx({}, () => {
  const c = cfg(4, false, 1); // 占先制 4 局
  let s = S.start(c, 1000, null, 'a');
  // A 发球局：A 得 1 分（ACE），B 连得 4 分破发（第 4 分即 15:40 破发点，记成双误 → 归 A）
  s = S.addPoint(s, 'a'); s = S.tagLast(s, 'A');
  s = S.addPoint(s, 'b'); s = S.tagLast(s, 'W'); // B 制胜分
  s = S.addPoint(s, 'b'); s = S.tagLast(s, 'U'); // A 非受迫失误
  s = S.addPoint(s, 'b'); // 15:40（B 拿到破发点）
  s = S.addPoint(s, 'b'); s = S.tagLast(s, 'D'); // A 双误丢掉破发点
  assert.ok(S.saveDraft(s));
  assert.strictEqual(S.loadDraft().tags, 'AWU.D');
  assert.strictEqual(S.restore(Object.assign({}, s, { tags: 'XYZ' })), null, '非法标签不认');
  const st = S.view(s).stats;
  assert.deepStrictEqual(st.pts, { a: 1, b: 4 });
  assert.deepStrictEqual(st.maxStreak, { a: 1, b: 4 });
  assert.deepStrictEqual(st.ace, { a: 1, b: 0 });
  assert.deepStrictEqual(st.win, { a: 0, b: 1 });
  assert.deepStrictEqual(st.ue, { a: 1, b: 0 }, '非受迫失误归丢分方 A');
  assert.deepStrictEqual(st.df, { a: 1, b: 0 }, '双误归丢分方 A');
  assert.deepStrictEqual([st.srvWon.a, st.srvTot.a], [1, 5]);
  assert.deepStrictEqual([st.bpWon.b, st.bpTot.b], [1, 1], '15:40 是 B 的破发点并兑现');
  assert.strictEqual(st.bars.length, 5);
  // 再次点同一个标签取消；撤销一分同步裁掉标签
  s = S.tagLast(s, 'D');
  assert.strictEqual(S.view(s).lastTag, '');
  s = S.undo(s);
  assert.strictEqual(s.tags, 'AWU.');
}));

test('热身 / 换边倒计时（15 秒提醒 + 到点震动 + 暂停/关闭）与大字常亮计分板模式', async () => {
  const store = {};
  const buzz = [];
  const clock = require('./fake-clock')();
  await clock.run(async () => {
    const wx = Object.assign(mockWx(store), { showModal: (o) => o.success({ confirm: true }), setKeepScreenOn() {}, vibrateShort() {} });
    const deps = {
      '../../utils/member': { statusCached: async () => ({ status: 'active' }) },
      '../../utils/haptic': { light: () => buzz.push('l'), medium: () => buzz.push('m') },
    };
    await withWx(store, async () => {
      const p = load('pkg-manage/scorer/scorer.js', wx, deps, { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, Date: clock.Date });
      p.onLoad(); await p.onShow();
      p.startNew();
      p.toggleStat(); assert.strictEqual(p.data.statOn, true);
      p.toggleBig(); assert.strictEqual(p.data.bigBoard, true);
      p.point(tap({ side: 'a' })); p.tagPoint(tap({ c: 'A' }));
      assert.strictEqual(p.data.v.lastTag, 'A');
      buzz.length = 0;
      p.startTimer(tap({ sec: '20', label: '换边倒计时' }));
      assert.deepStrictEqual([p.data.tmr.left, p.data.tmr.text, p.data.tmr.done], [20, '00:20', false]);
      await clock.wait(5200); // 剩余 ~15s → 触发一次 15s 轻震
      assert.ok(buzz.filter((x) => x === 'l').length >= 2);
      p.toggleTimerPause();
      const pausedLeft = p.data.tmr.left;
      await clock.wait(3000);
      assert.strictEqual(p.data.tmr.left, pausedLeft, '暂停期间不倒数');
      p.toggleTimerPause();
      await clock.wait((pausedLeft + 1) * 1000);
      assert.deepStrictEqual([p.data.tmr.done, p.data.tmr.text], [true, '00:00']);
      assert.strictEqual(buzz[buzz.length - 1], 'm', '到点中震提醒');
      p.stopTimer();
      assert.strictEqual(p.data.tmr, null);
    });
  });
});

module.exports = T;
