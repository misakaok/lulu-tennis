// 用邀请码加入后：还没设置资料的先去资料页（昵称预填、性别必选，可以稍后再设置），完成后回到原来要去的页面
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const T = [];
const test = (name, fn) => T.push({ name, fn });
const plain = (v) => JSON.parse(JSON.stringify(v));
// 虚拟时间（tests/fake-clock.js）：保存后延时返回等不用真的等；页面上下文里的 setTimeout 也用它
const clock = require('./fake-clock')();
const { setTimeout, clearTimeout } = clock;
const tick = (ms) => clock.wait(ms || 0);

function load(file, wx, deps, globals) {
  const filename = path.resolve(__dirname, '..', file);
  let def;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), Object.assign({
    require: (id) => (deps && deps[id]) || createRequire(filename)(id), wx, Page: (d) => { def = d; }, setTimeout, clearTimeout, console,
  }, globals));
  return Object.assign({}, def, { data: plain(def.data), setData(p) { Object.keys(p).forEach((k) => { this.data[k] = p[k]; }); } });
}

function wxStub(store, nav) {
  return {
    getStorageSync: (k) => store[k] || '', removeStorageSync: (k) => { delete store[k]; }, setStorageSync: (k, v) => { store[k] = v; },
    reLaunch: (o) => nav.push(o.url), switchTab: (o) => nav.push('tab:' + o.url), navigateBack: () => nav.push('back'),
    showToast() {}, showModal(o) { (o.complete || o.success || (() => {}))({ confirm: true }); }, showLoading() {}, hideLoading() {},
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release' } }),
  };
}

function gate(state, store, nav) {
  return load('pages/gate/gate.js', wxStub(store, nav), {
    '../../utils/cloud': { call: async (action) => { assert.strictEqual(action, 'acceptInvite'); state.status = 'active'; return {}; } },
    '../../utils/member': { clearProtected() {}, status: async () => ({ status: state.status, hasProfile: state.hasProfile, name: '小林', uid: 'lin' }) },
    '../../utils/share-card': { FALLBACK: '' },
  });
}

test('邀请码加入：还没设置资料 → 先去资料页；已有资料（例如重新被邀请的老成员）→ 照常进小程序', async () => {
  const store = {}, nav = [];
  const state = { status: 'none', hasProfile: false };
  const g = gate(state, store, nav);
  g.onLoad({});
  await g.load();
  g.setData({ code: 'abc123', name: '小林' });
  await g.accept();
  assert.deepStrictEqual(nav, ['/pages/profile/profile?from=gate']);

  const nav2 = [], store2 = { after_gate: '/pages/draw-view/draw-view?id=d1' };
  const g2 = gate({ status: 'none', hasProfile: true }, store2, nav2);
  g2.onLoad({});
  await g2.load();
  g2.setData({ code: 'abc123', name: '小林' });
  await g2.accept();
  assert.deepStrictEqual(nav2, ['/pages/draw-view/draw-view?id=d1'], '有资料：直接回到分享的活动');

  // 老成员回到准入页（状态已经是正式成员，不是刚用邀请码加入）：不强行带去资料页
  const nav3 = [];
  const g3 = gate({ status: 'active', hasProfile: false }, {}, nav3);
  g3.onLoad({});
  await g3.load();
  g3.enter();
  assert.deepStrictEqual(nav3, ['/pages/draw/draw']);
});

function profile(store, nav, saved) {
  return load('pages/profile/profile.js', wxStub(store, nav), {
    '../../utils/db': {
      cachedProfile: () => null, getMyProfile: async () => null, myOpenid: async () => 'lin',
      saveMyProfile: async (p) => { saved.push(plain(p)); },
    },
    '../../utils/cloud': { call: async () => ({}) },
    '../../utils/photo': { ownSrc: () => '', peek: () => '', fileOf: () => '', applyMine() {} },
    '../../utils/member': { statusCached: async () => ({ name: '小林' }) },
  }, { getCurrentPages: () => [{}] });
}

test('刚加入的资料页：昵称预填准入时的昵称、性别必选；保存或「稍后再设置」后回到原来要去的页面', async () => {
  const store = { after_gate: '/pages/draw-view/draw-view?id=d1' }, nav = [], saved = [];
  const p = profile(store, nav, saved);
  p.onLoad({ from: 'gate' });
  await tick();
  assert.strictEqual(p.data.fromGate, true);
  assert.match(p.data.tip, /性别/);
  assert.strictEqual(p.data.name, '小林', '昵称预填准入时填的');
  await p.save();
  assert.deepStrictEqual(saved, [], '没选性别不保存');
  p.pickGender({ currentTarget: { dataset: { v: 'f' } } });
  await p.save();
  assert.strictEqual(saved.length, 1); assert.strictEqual(saved[0].gender, 'f'); assert.strictEqual(saved[0].shown, false, '公开展示不默认勾选');
  await tick(650);
  assert.deepStrictEqual(nav, ['/pages/draw-view/draw-view?id=d1']);
  assert.strictEqual(store.after_gate, undefined);

  // 稍后再设置：不保存，直接进小程序（不强制）
  const nav2 = [], saved2 = [];
  const q = profile({}, nav2, saved2);
  q.onLoad({ from: 'gate' });
  q.later();
  assert.deepStrictEqual(nav2, ['/pages/draw/draw']); assert.deepStrictEqual(saved2, []);

  const xml = fs.readFileSync(path.join(__dirname, '../pages/profile/profile.wxml'), 'utf8');
  assert.ok(/wx:if="\{\{fromGate\}\}"[^>]*bindtap="later">稍后再设置</.test(xml));

  // 平时从「我的」进来编辑：保存后照旧返回
  const nav3 = [];
  const r = profile({}, nav3, []);
  r.onLoad({});
  await tick();
  r.pickGender({ currentTarget: { dataset: { v: 'm' } } });
  await r.save();
  await tick(650);
  assert.deepStrictEqual(nav3, ['tab:/pages/me/me']);
});

module.exports = T;
