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

// modal：{ titles: [] 记下弹过的标题, consent: 资料页「是否开启公开展示？」点哪个（true 开启 / false 暂不开启 / 'fail' 关掉） }
function wxStub(store, nav, modal) {
  modal = modal || { titles: [], consent: false };
  return {
    getStorageSync: (k) => store[k] || '', removeStorageSync: (k) => { delete store[k]; }, setStorageSync: (k, v) => { store[k] = v; },
    reLaunch: (o) => nav.push(o.url), switchTab: (o) => nav.push('tab:' + o.url), navigateBack: () => nav.push('back'),
    showToast() {},
    showModal(o) {
      modal.titles.push(o.title);
      if (o.title === '是否开启公开展示？') {
        assert.deepStrictEqual([o.confirmText, o.cancelText], ['开启展示', '暂不开启']);
        assert.ok([...o.confirmText].length <= 4 && [...o.cancelText].length <= 4, '按钮最多 4 个字');
        if (modal.consent === 'fail') { if (o.fail) o.fail({}); } else if (o.success) o.success({ confirm: modal.consent === true, cancel: modal.consent !== true });
        if (o.complete) o.complete({});
        return;
      }
      (o.complete || o.success || (() => {}))({ confirm: true });
    },
    showLoading() {}, hideLoading() {},
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

function profile(store, nav, saved, modal, existing) {
  return load('pages/profile/profile.js', wxStub(store, nav, modal), {
    '../../utils/db': {
      cachedProfile: () => null, getMyProfile: async () => existing || null, myOpenid: async () => 'lin', setShown: async () => {},
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
  assert.strictEqual(saved.length, 1); assert.strictEqual(saved[0].gender, 'f'); assert.strictEqual(saved[0].shown, false, '公开展示不默认勾选（问了一次，选了「暂不开启」）');
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

test('资料页：第一次建资料没碰过公开展示勾选项，点「完成」温和问一次；开启 / 暂不开启 / 关掉弹窗都照常保存（不强制）', async () => {
  const C = require('../utils/consent');
  const run = async (consent) => {
    const saved = [], modal = { titles: [], consent };
    const p = profile({}, [], saved, modal);
    p.onLoad({});
    await tick();
    assert.strictEqual(p.data.isNew, true); assert.strictEqual(p.data.shown, false, '仍然不默认勾选');
    p.pickGender({ currentTarget: { dataset: { v: 'm' } } });
    await p.save();
    return { p, saved, modal };
  };
  const yes = await run(true);
  assert.deepStrictEqual(yes.modal.titles.slice(0, 1), ['是否开启公开展示？']);
  assert.deepStrictEqual([yes.saved.length, yes.saved[0].shown, yes.p.data.shown], [1, true, true], '选「开启展示」：按同意保存');
  const no = await run(false);
  assert.deepStrictEqual([no.saved.length, no.saved[0].shown, no.p.data.shown], [1, false, false], '选「暂不开启」：照常保存，不拦住');
  const closed = await run('fail');
  assert.deepStrictEqual([closed.saved.length, closed.saved[0].shown], [1, false], '弹窗没弹出来 / 关掉：照常保存');
  assert.strictEqual(no.p.edited.shown, true, '问过了：记为已选择');
  // 说明文字就是完整的知情说明
  const src = fs.readFileSync(path.join(__dirname, '../pages/profile/profile.js'), 'utf8');
  assert.ok(/title: '是否开启公开展示？', content: C\.TEXT, confirmText: '开启展示', cancelText: '暂不开启'/.test(src));
  assert.ok(C.TEXT.length > 20);
});

test('资料页：自己点勾过又取消、已有资料的老成员保存，都不再问；连点「完成」只问一次', async () => {
  // 第一次建资料，自己点勾（弹授权说明，同意）又点掉
  const saved = [], modal = { titles: [], consent: true };
  const p = profile({}, [], saved, modal);
  p.onLoad({}); await tick();
  p.pickGender({ currentTarget: { dataset: { v: 'm' } } });
  await p.toggleShown(); await p.toggleShown();
  assert.strictEqual(p.data.shown, false);
  modal.titles.length = 0;
  await p.save();
  assert.deepStrictEqual(modal.titles.filter((t) => t === '是否开启公开展示？'), [], '主动选过不同意：不再问');
  assert.strictEqual(saved[0].shown, false);
  // 老成员改资料（云端已有资料、没同意）
  const saved2 = [], modal2 = { titles: [], consent: true };
  const q = profile({}, [], saved2, modal2, { name: '小林', gender: 'f', level: 3, shown: false });
  q.onLoad({}); await tick();
  assert.strictEqual(q.data.isNew, false);
  await q.save();
  assert.deepStrictEqual(modal2.titles.filter((t) => t === '是否开启公开展示？'), []);
  assert.deepStrictEqual([saved2.length, saved2[0].shown], [1, undefined], '老成员保存不带授权');
  // 连点「完成」：弹窗还开着时第二次点无效，只问一次、只保存一次
  let answer;
  const saved3 = [], titles3 = [];
  const w = wxStub({}, [], { titles: titles3 });
  w.showModal = (o) => { titles3.push(o.title); if (o.title === '是否开启公开展示？') answer = () => o.success({ confirm: false }); else (o.complete || o.success || (() => {}))({ confirm: true }); };
  const r = load('pages/profile/profile.js', w, {
    '../../utils/db': { cachedProfile: () => null, getMyProfile: async () => null, myOpenid: async () => 'lin', saveMyProfile: async (x) => { saved3.push(plain(x)); } },
    '../../utils/cloud': { call: async () => ({}) },
    '../../utils/photo': { ownSrc: () => '', peek: () => '', fileOf: () => '', applyMine() {} },
    '../../utils/member': { statusCached: async () => ({ name: '小林' }) },
  }, { getCurrentPages: () => [{}] });
  r.onLoad({}); await tick();
  r.pickGender({ currentTarget: { dataset: { v: 'm' } } });
  const first = r.save(), second = r.save();
  await second;
  assert.deepStrictEqual(titles3, ['是否开启公开展示？'], '只弹一个框');
  answer(); await first;
  assert.strictEqual(saved3.length, 1);
});

test('资料页：未勾选公开展示时卡片和勾选框有淡紫描边提示，勾上后去掉', () => {
  const xml = fs.readFileSync(path.join(__dirname, '../pages/profile/profile.wxml'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../pages/profile/profile.wxss'), 'utf8');
  assert.ok(xml.indexOf(`<view class="card consent {{shown ? '' : 'cs-off'}}">`) >= 0);
  assert.ok(/\.consent\.cs-off \{[^}]*border/.test(css) && /\.cs-off \.cbox \{[^}]*border-color/.test(css));
});

module.exports = T;
