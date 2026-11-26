// 启动时主动提示微信《用户隐私保护指引》（utils/privacy.js）：在假的微信环境里跑真实的 app.js、member.js、consent.js、privacy.js，
// 覆盖首次打开、已同意后重开、拒绝后继续使用、从后台切回、和「公开展示授权」两个弹窗都要出现、旧版微信、朋友圈单页模式，
// 以及拒绝后主动选照片、地图选点、复制时停止这次操作
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const T = [];
const test = (name, fn) => T.push({ name, fn });
const root = path.resolve(__dirname, '..');
// 虚拟时间（tests/fake-clock.js）：等页面出现、弹窗、轮询都按原来的先后顺序走，只是不用真的等。
// 这个文件里的 setTimeout / clearTimeout / Date（假的微信接口、传给 app.js 的上下文）都用它
const clock = require('./fake-clock')();
const { setTimeout, clearTimeout, Date } = clock;
const later = clock.wait;

/**
 * 一次「冷启动」：新的模块实例（privacy 的状态从零开始）。o.need：后台指引是否还要用户同意；o.answer：官方弹窗里点 agree / deny；
 * o.status：memberStatus 的返回；o.noApi：旧版微信；o.settingFail：查询失败；o.scene：启动场景；o.pageAt：首个页面多久后出现
 */
function boot(o) {
  o = Object.assign({ need: true, answer: 'agree', status: { status: 'active', uid: 'me', hasProfile: true, shown: true, shownVer: 2 }, scene: 1001, pageAt: 50, consent: true }, o);
  const log = [];
  const pages = [];
  setTimeout(() => pages.push({ route: 'pages/draw/draw', options: {} }), o.pageAt);
  const store = o.store || {};
  const wx = {
    cloud: { init() {} },
    getLaunchOptionsSync: () => ({ scene: o.scene }),
    setStorageSync: (k, v) => { store[k] = v; }, getStorageSync: (k) => store[k], removeStorageSync: (k) => { delete store[k]; },
    getStorageInfoSync: () => ({ keys: Object.keys(store) }),
    showTabBarRedDot() {}, hideTabBarRedDot() {}, reLaunch: (x) => log.push('reLaunch:' + x.url),
    showToast: (x) => log.push('toast:' + x.title),
    showModal: (x) => { log.push('modal:' + x.title); setTimeout(() => x.success && x.success({ confirm: o.consent }), 10); },
  };
  if (!o.noApi) {
    wx.getPrivacySetting = (x) => { log.push('privacy:check'); setTimeout(() => (o.settingFail ? x.fail({ errMsg: 'getPrivacySetting:fail' }) : x.success({ needAuthorization: o.need, privacyContractName: '《LULU网球小程序隐私保护指引》' })), 5); };
    wx.requirePrivacyAuthorize = (x) => {
      log.push('privacy:open' + (pages.length ? '' : '(没有页面)'));
      setTimeout(() => {
        log.push('privacy:' + o.answer);
        if (o.answer === 'agree') { o.need = false; x.success({ errMsg: 'requirePrivacyAuthorize:ok' }); } else x.fail({ errMsg: 'requirePrivacyAuthorize:fail privacy permission is not authorized', errno: 104 });
      }, 40);
    };
  }
  const setShown = [];
  const stubs = {
    'utils/cloud.js': { call: async (a) => { log.push('cloud:' + a); return o.status; } },
    'utils/memo.js': { invalidate() {}, get: (k, any, fn) => fn(), ANY: 1 },
    'utils/rackets.js': { refreshBadge() {} },
    'utils/db.js': { setShown: async (v) => { setShown.push(v); }, fetchPlayersFull: async () => [], forget() {} },
  };
  const ctx = vm.createContext({ wx, getCurrentPages: () => pages, setTimeout, clearTimeout, console, Promise, Date });
  const cache = {};
  let app = null;
  function load(rel) {
    if (stubs[rel]) return stubs[rel];
    if (cache[rel]) return cache[rel].exports;
    const mod = { exports: {} };
    cache[rel] = mod;
    const abs = path.join(root, rel);
    const fn = vm.runInContext('(function (require, module, exports, App) {' + fs.readFileSync(abs, 'utf8') + '\n})', ctx, { filename: abs });
    const req = (id) => { let r = path.relative(root, path.resolve(path.dirname(abs), id)); if (!/\.js$/.test(r)) r += '.js'; return load(r); };
    fn(req, mod, mod.exports, (d) => { app = d; });
    return mod.exports;
  }
  load('app.js');
  app.onLaunch();
  return { app, log, wx, pages, setShown, privacy: load('utils/privacy.js'), load, o };
}
const settle = () => later(400 + 300); // 等页面出现、弹窗处理完、公开展示授权弹窗

test('首次打开：首个页面显示后才弹微信官方隐私指引，同意后照常；只弹一次', async () => {
  const b = boot({ pageAt: 120 });
  b.app.onShow();
  assert.strictEqual(await b.privacy.ensure(), 'agreed');
  assert.deepStrictEqual(b.log.filter((x) => /^privacy:/.test(x)), ['privacy:check', 'privacy:open', 'privacy:agree'], '页面出现之后才弹（不是「没有页面」时）');
  assert.ok(b.log.indexOf('cloud:memberStatus') >= 0, '成员校验照常');
  assert.deepStrictEqual(b.setShown, [], '同意隐私指引不会改公开展示授权（players.shown）');
});

test('已同意后重开：needAuthorization 为 false，不弹', async () => {
  const b = boot({ need: false });
  b.app.onShow();
  assert.strictEqual(await b.privacy.ensure(), 'agreed');
  await settle();
  assert.deepStrictEqual(b.log.filter((x) => /^privacy:/.test(x)), ['privacy:check']);
});

test('从后台切回：同一次打开不重复查、不重复弹（拒绝过的也一样）；下一次冷启动还没同意才再弹', async () => {
  const b = boot({ answer: 'deny' });
  b.app.onShow();
  await settle();
  b.app.onShow(); await later(50); b.app.onShow(); // 切到后台再回来两次
  await settle();
  assert.deepStrictEqual(b.log.filter((x) => /^privacy:/.test(x)), ['privacy:check', 'privacy:open', 'privacy:deny']);
  assert.strictEqual(b.log.filter((x) => x === 'cloud:memberStatus').length, 3, '成员资格每次回前台照常重新校验');
  const again = boot({ answer: 'agree' }); // 拒绝后下一次冷启动：还没同意，再问一次
  again.app.onShow();
  assert.strictEqual(await again.privacy.ensure(), 'agreed');
  const next = boot({ need: false }); // 同意之后的冷启动
  next.app.onShow();
  await next.privacy.ensure();
  assert.ok(!next.log.some((x) => x === 'privacy:open'));
});

test('拒绝后继续使用：启动流程照常（成员校验、球拍提醒等），不跳转、不报错；结果是 denied', async () => {
  const b = boot({ answer: 'deny' });
  b.app.onShow();
  assert.strictEqual(await b.privacy.ensure(), 'denied');
  await settle();
  assert.ok(b.log.indexOf('cloud:memberStatus') >= 0);
  assert.ok(!b.log.some((x) => /^reLaunch|^modal:/.test(x)), '正式成员不跳准入页，也不弹别的窗');
  assert.deepStrictEqual(b.setShown, []);
});

test('两个弹窗都要出现：先处理微信隐私指引（同意或拒绝都行），之后才弹「公开展示授权」，不叠在一起；公开展示照用户自己的选择写入', async () => {
  for (const answer of ['agree', 'deny']) {
    const b = boot({ answer, status: { status: 'active', uid: 'me', hasProfile: true, shown: null } });
    b.app.onShow();
    await settle();
    const seq = b.log.filter((x) => /^privacy:(open|agree|deny)|^modal:/.test(x));
    assert.deepStrictEqual(seq, ['privacy:open', 'privacy:' + answer, 'modal:公开展示授权'], answer);
    assert.deepStrictEqual(b.setShown, [true], '公开展示授权是用户在第二个弹窗里点的「同意」');
  }
  // 公开展示点「不同意」：写 false；隐私指引同意与否不影响
  const n = boot({ answer: 'agree', consent: false, status: { status: 'active', uid: 'me', hasProfile: true, shown: null } });
  n.app.onShow();
  await settle();
  assert.deepStrictEqual(n.setShown, [false]);
  // 不需要公开展示授权（已经选过）：只有隐私指引
  const one = boot({ status: { status: 'active', uid: 'me', hasProfile: true, shown: false } });
  one.app.onShow();
  await settle();
  assert.ok(!one.log.some((x) => /^modal:/.test(x)));
  assert.deepStrictEqual(one.setShown, []);
});

test('公开展示说明更新（第 2 版）：同意过旧版的老成员问一次「同意 / 暂不」；暂不什么都不改、之后不再自动问；同意写新版；已同意新版、不同意的都不问', async () => {
  const old = { status: 'active', uid: 'me', hasProfile: true, shown: true }; // 旧版没有 shownVer
  // 暂不：不改云端，记下来，下次冷启动不再问
  const store = {};
  const a = boot({ consent: false, status: old, store });
  a.app.onShow();
  await settle();
  assert.deepStrictEqual(a.log.filter((x) => /^modal:/.test(x)), ['modal:公开展示说明更新']);
  assert.deepStrictEqual(a.setShown, [], '暂不：小程序里照常展示，不改授权');
  const a2 = boot({ consent: false, status: old, store });
  a2.app.onShow();
  await settle();
  assert.ok(!a2.log.some((x) => /^modal:/.test(x)), '点过暂不：不再自动问');
  // 同意：写新版
  const b = boot({ consent: true, status: Object.assign({}, old, { shownVer: 1 }) });
  b.app.onShow();
  await settle();
  assert.deepStrictEqual(b.log.filter((x) => /^modal:/.test(x)), ['modal:公开展示说明更新']);
  assert.deepStrictEqual(b.setShown, [true]);
  // 已同意新版 / 不同意：不问
  for (const st of [Object.assign({}, old, { shownVer: 2 }), { status: 'active', uid: 'me', hasProfile: true, shown: false, shownVer: 0 }]) {
    const c = boot({ status: st });
    c.app.onShow();
    await settle();
    assert.ok(!c.log.some((x) => /^modal:/.test(x)), JSON.stringify(st));
  }
  // 说明里写明会进保存的对阵图、可能转发到小程序以外；同意时带上版本
  const C = require('../utils/consent');
  assert.match(C.TEXT, /保存到相册的活动对阵图/);
  assert.match(C.TEXT, /小程序以外/);
  assert.strictEqual(C.VER, 2);
  assert.ok(C.latest({ shown: true, shownVer: 2 }) && !C.latest({ shown: true }) && !C.latest({ shown: false, shownVer: 2 }));
  const dbSrc = fs.readFileSync(path.join(root, 'utils/db.js'), 'utf8');
  assert.match(dbSrc, /call\('setShown', \{ on: !!on, ver: require\('\.\/consent'\)\.VER \}\)/);
  assert.match(dbSrc, /shownVer: shown === true \? require\('\.\/consent'\)\.VER : undefined/);
});

test('旧版微信没有接口、查询失败：跳过隐私指引，启动流程和公开展示授权照常', async () => {
  for (const o of [{ noApi: true }, { settingFail: true }]) {
    const b = boot(Object.assign({ status: { status: 'active', uid: 'me', hasProfile: true, shown: null } }, o));
    b.app.onShow();
    assert.strictEqual(await b.privacy.ensure(), o.noApi ? 'unsupported' : 'error');
    await settle();
    assert.ok(!b.log.some((x) => x === 'privacy:open'));
    assert.ok(b.log.indexOf('cloud:memberStatus') >= 0);
    assert.ok(b.log.indexOf('modal:公开展示授权') >= 0, '公开展示授权不被卡住');
  }
});

test('朋友圈单页模式（场景 1154）：沿用原来的启动逻辑，不查隐私指引、不校验成员', async () => {
  const b = boot({ scene: 1154 });
  b.app.onShow();
  await settle();
  assert.ok(!b.log.some((x) => /^privacy:|^cloud:/.test(x)), b.log.join(','));
});

test('拒绝后主动选照片、地图选点、复制：微信按原有流程弹窗，这次没同意就停止（轻提示，不弹报错）', async () => {
  const b = boot({ need: false });
  const denied = { errMsg: 'chooseMedia:fail privacy permission is not authorized', errno: 104 };
  // 选照片（utils/photo.js 的 pick）
  b.wx.chooseMedia = (x) => x.fail(denied);
  b.wx.getStorageInfoSync = () => ({ keys: [] });
  const P = b.load('utils/photo.js');
  assert.strictEqual(await P.pick('album'), '', '停止这次操作，当作取消');
  assert.ok(b.log.indexOf('toast:未同意隐私保护指引，已停止这次操作') >= 0);
  assert.ok(!b.log.some((x) => /^modal:/.test(x)));
  // 后台指引没声明（112）：照常提示联系管理员补上
  b.wx.chooseMedia = (x) => x.fail({ errMsg: 'chooseMedia:fail api scope is not declared in the privacy agreement', errno: 112 });
  await assert.rejects(P.pick('camera'), /隐私保护指引/);
  // 地图选点（components/event-form）
  const src = fs.readFileSync(path.join(root, 'pkg-manage/components/event-form/event-form.js'), 'utf8');
  assert.ok(/PV\.isDenied\(e\)\) \{ PV\.stopped\(\); return; \}/.test(src), '地图选点没同意：停止，不弹「请允许位置信息」');
  // 复制（剪切板）
  const PV = b.privacy;
  b.log.length = 0;
  PV.copyFail({ errMsg: 'setClipboardData:fail privacy permission is not authorized', errno: 104 });
  PV.copyFail({ errMsg: 'setClipboardData:fail' });
  assert.deepStrictEqual(b.log, ['toast:未同意隐私保护指引，已停止这次操作', 'toast:没有复制成功，请重试']);
  ['pages/gate/gate.js', 'pkg-manage/members/members.js'].forEach((f) => {
    const s = fs.readFileSync(path.join(root, f), 'utf8');
    const calls = s.match(/wx\.setClipboardData\(\{[^\n]*/g) || [];
    assert.ok(calls.length && calls.every((c) => /fail: copyFail/.test(c)), f + '：每次复制都处理失败');
  });
  // 用微信官方弹窗：不注册自定义隐私弹窗
  const all = ['app.js', 'utils/privacy.js', 'utils/member.js', 'utils/consent.js'].map((f) => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
  assert.ok(!/onNeedPrivacyAuthorization\(/.test(all));
  assert.ok(!/setShown/.test(fs.readFileSync(path.join(root, 'utils/privacy.js'), 'utf8')), '隐私指引不碰公开展示授权');
});

module.exports = T;
