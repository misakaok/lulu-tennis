const assert = require('assert');
const path = require('path');
const T = [];
const test = (name, fn) => T.push({ name, fn });
const tick = () => new Promise((r) => setTimeout(r, 5));
function client(call) {
  const cloudPath = require.resolve('../utils/cloud');
  const photoPath = require.resolve('../utils/photo');
  const cachePath = require.resolve('../utils/photo-cache');
  const old = require.cache[cloudPath];
  require.cache[cloudPath] = { id: cloudPath, filename: cloudPath, loaded: true, exports: { call } };
  delete require.cache[photoPath];
  delete require.cache[cachePath];
  const P = require(photoPath);
  return { P, L: require(cachePath), restore() { P.clear(); delete require.cache[photoPath]; delete require.cache[cachePath]; if (old) require.cache[cloudPath] = old; else delete require.cache[cloudPath]; } };
}
test('照片列表：大量重复组件按 50 张合并；在途请求和链接缓存均去重', async () => {
  const calls = [];
  const { P, restore } = client(async (action, { fileIDs }) => {
    calls.push(fileIDs);
    await tick();
    return { files: Object.fromEntries(fileIDs.map((f) => [f, 'url:' + f])) };
  });
  try {
    const first = Array.from({ length: 1000 }, (_, i) => P.resolve('f' + i % 120));
    await tick();
    const late = Array.from({ length: 1000 }, (_, i) => P.resolve('f' + i % 120));
    await Promise.all(first.concat(late));
    assert.deepStrictEqual(calls.map((c) => c.length), [50, 50, 20]);
    await Promise.all(Array.from({ length: 120 }, (_, i) => P.resolve('f' + i)));
    assert.strictEqual(calls.length, 3);
  } finally { restore(); }
});
test('照片列表：共享坏图只重试一次；失败链接一分钟内不重复调用', async () => {
  let calls = 0;
  const { P, restore } = client(async () => { calls++; return { files: { broken: 'bad-url' } }; });
  try {
    await P.resolve('broken');
    for (let i = 0; i < 20; i++) { P.invalidate('broken'); await P.resolve('broken'); }
    assert.strictEqual(calls, 2);
    await P.resolve('missing'); await P.resolve('missing');
    assert.strictEqual(calls, 3);
  } finally { restore(); }
});
test('照片列表：成员缓存清除后，旧的在途回包不能重新缓存或显示照片', async () => {
  let release;
  const { P, restore } = client(() => new Promise((r) => { release = r; }));
  try {
    P.setPlayers([], { alice: { photo: 'private' } });
    const pending = P.resolve('private');
    await tick();
    P.clear();
    release({ files: { private: 'private-url' } });
    assert.strictEqual(await pending, '');
    assert.strictEqual(P.peek('private'), '');
    assert.strictEqual(P.fileOf('alice', ''), '');
  } finally { restore(); }
});
test('本人马上看到：上传后本人（按 ID 或名字）看到新照片，别人不受影响；通过后换成正式照片', async () => {
  const { P, restore } = client(async () => { throw new Error('不应调用云函数'); });
  try {
    P.setPlayers([{ name: 'Alice', uid: 'alice', photo: 'old' }], { alice: { photo: 'old' } });
    P.setMine({ uid: 'alice', name: 'Alice', fileID: 'new', src: 'wxfile://new.jpg' });
    assert.strictEqual(P.ownSrc('alice', 'Alice'), 'wxfile://new.jpg');
    assert.strictEqual(P.ownSrc('', 'Alice'), 'wxfile://new.jpg');
    assert.strictEqual(P.ownSrc('bob', 'Bob'), '');
    assert.strictEqual(P.ownSrc('bob', 'Alice'), '', '有 ID 时只按 ID 认');
    P.setPlayers([{ name: 'Alice', uid: 'alice', photo: 'old' }], { alice: { photo: 'old' } });
    assert.strictEqual(P.ownSrc('alice', ''), 'wxfile://new.jpg', '还在检测：继续显示新照片');
    P.setPlayers([{ name: 'Alice', uid: 'alice', photo: 'new' }], { alice: { photo: 'new' } });
    assert.strictEqual(P.ownSrc('alice', ''), '', '通过后不再单独显示');
    assert.strictEqual(P.fileOf('alice', ''), 'new');
  } finally { restore(); }
});
test('本人马上看到：查到检测结果后更新——检测中用本人专用链接，没通过就不再显示，通过就直接用正式照片', async () => {
  const { P, restore } = client(async () => { throw new Error('不应调用云函数'); });
  try {
    P.setPlayers([], { alice: { photo: 'old' } });
    P.applyMine('alice', 'Alice', { state: 'checking', pending: 'p1', pendingUrl: 'https://own/p1' });
    assert.strictEqual(P.ownSrc('alice'), 'https://own/p1');
    P.applyMine('alice', 'Alice', { state: 'reject', photo: 'old' });
    assert.strictEqual(P.ownSrc('alice'), '');
    assert.strictEqual(P.fileOf('alice'), 'old', '没通过：仍是原来的照片');
    P.setMine({ uid: 'alice', name: 'Alice', fileID: 'p2', src: 'wxfile://p2.jpg' });
    P.applyMine('alice', 'Alice', { state: 'checking', pending: 'p2', pendingUrl: 'https://own/p2' });
    assert.strictEqual(P.ownSrc('alice'), 'wxfile://p2.jpg', '本机文件还在就接着用');
    P.applyMine('alice', 'Alice', { state: '', photo: 'p2', url: 'https://ok/p2' });
    assert.strictEqual(P.ownSrc('alice'), '');
    assert.strictEqual(P.fileOf('alice'), 'p2');
    assert.strictEqual(P.fileOf('', 'Alice'), 'p2');
    assert.strictEqual(P.peek('p2'), 'https://ok/p2', '不用等下一次读资料，也不用再取链接');
  } finally { restore(); }
});
test('本人马上看到：重启后只有本机记着有照片在检测才查 myPhoto；退出成员身份时清掉', async () => {
  const mem = {};
  global.wx = { getStorageSync: (k) => mem[k], setStorageSync: (k, v) => { mem[k] = v; }, removeStorageSync: (k) => { delete mem[k]; } };
  let calls = 0;
  const { P, restore } = client(async (action) => { calls++; assert.strictEqual(action, 'myPhoto'); return { state: 'checking', pending: 'p1', pendingUrl: 'https://own/p1' }; });
  try {
    await P.syncMine(true);
    assert.strictEqual(calls, 0, '没有照片在检测：不调用');
    mem.photo_pending = { uid: 'alice', name: 'Alice', fileID: 'p1', at: Date.now() };
    await P.syncMine(true);
    assert.strictEqual(calls, 1);
    assert.strictEqual(P.ownSrc('alice'), 'https://own/p1');
    mem.photo_pending.at = Date.now() - 4 * 86400000;
    await P.syncMine(true);
    assert.strictEqual(calls, 1, '超过 3 天不再查');
    assert.ok(!mem.photo_pending);
    P.setMine({ uid: 'alice', name: 'Alice', fileID: 'p3', src: 'wxfile://p3.jpg' });
    assert.ok(mem.photo_pending);
    P.clear();
    assert.strictEqual(P.ownSrc('alice'), '');
    assert.ok(!mem.photo_pending);
  } finally { restore(); delete global.wx; }
});

test('本人马上看到：认的是服务端复制的那份；启动后第一次拿到球员资料就查一次检测状态', async () => {
  const mem = { photo_pending: { uid: 'alice', name: 'Alice', fileID: 'snap1', at: Date.now() } };
  global.wx = { getStorageSync: (k) => mem[k], setStorageSync: (k, v) => { mem[k] = v; }, removeStorageSync: (k) => { delete mem[k]; } };
  const calls = [];
  const { P, restore } = client(async (action) => { calls.push(action); return { state: 'checking', pending: 'snap1', pendingUrl: 'https://own/snap1' }; });
  try {
    P.setPlayers([], { alice: { photo: 'old' } });
    P.setPlayers([], { alice: { photo: 'old' } });
    await tick();
    assert.deepStrictEqual(calls, ['myPhoto'], '只查一次');
    assert.strictEqual(P.ownSrc('alice'), 'https://own/snap1');
    P.setPlayers([], { alice: { photo: 'snap1' } });
    assert.strictEqual(P.ownSrc('alice'), '', '正式照片就是这份：不再单独显示');
  } finally { restore(); delete global.wx; }
});
/* ---------- 缩略图本机缓存 ---------- */
// 模拟小程序的本机存储、下载和文件系统；restart() 模拟重新打开小程序（本机存储和文件还在，内存里的都没了）
function fakeWx() {
  const mem = {}, files = {}, downloads = [];
  const fw = {
    mem, files, downloads, failDownload: '',
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getStorageSync: (k) => mem[k], setStorageSync: (k, v) => { mem[k] = JSON.parse(JSON.stringify(v)); }, removeStorageSync: (k) => { delete mem[k]; },
    downloadFile({ url, success, fail }) {
      downloads.push(url);
      setTimeout(() => (fw.failDownload ? fail({ errMsg: fw.failDownload }) : success({ statusCode: 200, tempFilePath: 'tmp://' + url })), 0);
    },
    getFileSystemManager: () => ({
      mkdirSync() {}, rmdirSync(d) { Object.keys(files).filter((f) => f.indexOf(d + '/') === 0).forEach((f) => delete files[f]); },
      saveFile({ tempFilePath, filePath, success }) { files[filePath] = tempFilePath; setTimeout(success, 0); },
      unlinkSync(f) { if (!(f in files)) throw new Error('no such file'); delete files[f]; },
      statSync: (f) => ({ size: 30000 }),
      readdirSync: (d) => Object.keys(files).filter((f) => f.indexOf(d + '/') === 0).map((f) => f.slice(d.length + 1)),
    }),
  };
  return fw;
}
const snap = (uid, n) => `cloud://env1.x/player-photos/${uid}/${n}.jpg`;
const thumbsCall = (calls, isThumb = true) => async (action, d) => {
  calls.push(d);
  return { files: Object.fromEntries(d.fileIDs.map((f) => [f, (d.full ? 'https://full/' : 'https://thumb/') + f])), thumbs: isThumb && !d.full ? Object.fromEntries(d.fileIDs.map((f) => [f, 1])) : {} };
};
const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));

test('缩略图缓存：拿到缩略图链接后存到本机；重新打开后等最新资料到了直接用本机文件，不再取链接', async () => {
  const fw = fakeWx(); global.wx = fw;
  const calls = [];
  let { P, L, restore } = client(thumbsCall(calls));
  const a = snap('alice', 'r1');
  try {
    P.setPlayers([], { alice: { photo: a } });
    assert.strictEqual(await P.resolve(a), 'https://thumb/' + a);
    await wait();
    assert.deepStrictEqual(fw.downloads, ['https://thumb/' + a]);
    assert.strictEqual(P.peek(a), 'wxfile://usr/pl/alice_r1.jpg', '存好后就用本机文件');
    L._restart();
    // 重新打开：模块重新加载
    const P2 = (() => { delete require.cache[require.resolve('../utils/photo')]; return require('../utils/photo'); })();
    assert.strictEqual(P2.peek(a), '', '还没拿到最新资料：先不用本机文件');
    const pending = P2.resolve(a);
    await wait(5);
    P2.setPlayers([], { alice: { photo: a } });
    assert.strictEqual(await pending, 'wxfile://usr/pl/alice_r1.jpg');
    assert.strictEqual(calls.length, 1, '没有再调 photoUrls');
    assert.strictEqual(fw.downloads.length, 1, '没有重新下载');
    P = P2;
  } finally { P.clear(); restore(); delete global.wx; }
});
test('缩略图缓存：关掉公开展示、换照片、管理员移除（最新资料里没有了）就删本机文件；退出成员身份全部删掉', async () => {
  const fw = fakeWx(); global.wx = fw;
  const { P, L, restore } = client(thumbsCall([]));
  const a = snap('alice', 'r1'), b = snap('bob', 'r2'), b2 = snap('bob', 'r3');
  try {
    P.setPlayers([], { alice: { photo: a }, bob: { photo: b } });
    await Promise.all([P.resolve(a), P.resolve(b)]);
    await wait();
    assert.deepStrictEqual(Object.keys(fw.files).sort(), ['wxfile://usr/pl/alice_r1.jpg', 'wxfile://usr/pl/bob_r2.jpg']);
    P.setPlayers([], { alice: {}, bob: { photo: b2 } }); // alice 关了公开展示（照片不下发），bob 换了照片
    assert.deepStrictEqual(Object.keys(fw.files), [], '本机文件删掉');
    assert.ok(!L.has(a) && !L.has(b));
    await P.resolve(b2); await wait();
    assert.deepStrictEqual(Object.keys(fw.files), ['wxfile://usr/pl/bob_r3.jpg']);
    P.clear();
    assert.deepStrictEqual(Object.keys(fw.files), []);
    assert.ok(!fw.mem.photo_files);
  } finally { restore(); delete global.wx; }
});
test('缩略图缓存：下载期间照片不再公开就不留；目录里索引外的文件在启动后清掉；超过上限删最久没用的', async () => {
  const fw = fakeWx(); global.wx = fw;
  const { P, L, restore } = client(thumbsCall([]));
  try {
    fw.files['wxfile://usr/pl/old_left.jpg'] = 'x'; // 以前留下、索引里没有的
    const a = snap('alice', 'r1');
    P.setPlayers([], { alice: { photo: a } });
    assert.ok(!fw.files['wxfile://usr/pl/old_left.jpg'], '索引外的文件删掉');
    const got = P.resolve(a);
    await got;
    P.setPlayers([], { alice: {} }); // 下载还没完成就不公开了
    await wait();
    assert.deepStrictEqual(Object.keys(fw.files), []);
    L.LIMIT.count = 3;
    const ids = [1, 2, 3, 4].map((i) => snap('u' + i, 'r'));
    P.setPlayers([], Object.fromEntries(ids.map((f, i) => ['u' + (i + 1), { photo: f }])));
    for (const f of ids) { await P.resolve(f); await wait(5); }
    await wait();
    assert.deepStrictEqual(Object.keys(fw.files).sort(), ['wxfile://usr/pl/u2_r.jpg', 'wxfile://usr/pl/u3_r.jpg', 'wxfile://usr/pl/u4_r.jpg']);
  } finally { restore(); delete global.wx; }
});
test('缩略图缓存：旧版云函数发的原图不存；下载域名没配就不再试，照常用链接；本机文件坏了改用链接', async () => {
  const fw = fakeWx(); global.wx = fw;
  const calls = [];
  const { P, L, restore } = client(thumbsCall(calls, false));
  try {
    const a = snap('alice', 'r1');
    P.setPlayers([], { alice: { photo: a } });
    assert.strictEqual(await P.resolve(a), 'https://thumb/' + a);
    await wait();
    assert.deepStrictEqual(fw.downloads, [], '不是缩略图：不下载');
  } finally { restore(); }
  const c2 = client(thumbsCall(calls));
  try {
    const b = snap('bob', 'r2'), c = snap('carl', 'r3'), d = snap('dan', 'r4');
    c2.P.setPlayers([], { bob: { photo: b }, carl: { photo: c }, dan: { photo: d } });
    fw.failDownload = 'downloadFile:fail url not in domain list';
    await c2.P.resolve(b); await wait();
    await c2.P.resolve(c); await wait();
    assert.strictEqual(fw.downloads.length, 1, '域名不行：这次启动不再下载');
    assert.strictEqual(c2.P.peek(c), 'https://thumb/' + c, '照常用链接显示');
    // 本机文件坏了：删掉，改用链接
    c2.L._restart(); fw.failDownload = '';
    await c2.P.resolve(d); await wait();
    assert.ok(c2.L.has(d));
    c2.P.invalidate(d);
    assert.ok(!c2.L.has(d));
    assert.strictEqual(await c2.P.resolve(d), 'https://thumb/' + d);
  } finally { c2.restore(); delete global.wx; }
});
test('点开看大图：取原图链接（full），缓存一会儿；退出后不再用', async () => {
  const calls = [];
  const { P, restore } = client(thumbsCall(calls));
  try {
    const a = snap('alice', 'r1');
    assert.strictEqual(await P.full(a), 'https://full/' + a);
    assert.strictEqual(await P.full(a), 'https://full/' + a);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].full, true);
    P.clear();
    await P.full(a);
    assert.strictEqual(calls.length, 2);
  } finally { restore(); }
});

test('点开看大图：显示时先取好的和点开时的原图请求合并成一次', async () => {
  const calls = [];
  const { P, restore } = client(async (a, d) => { calls.push(d); await tick(); return { files: { [d.fileIDs[0]]: 'https://full/x' } }; });
  try {
    const [x, y] = await Promise.all([P.full('f1'), P.full('f1')]);
    assert.strictEqual(x, 'https://full/x'); assert.strictEqual(y, x);
    assert.strictEqual(calls.length, 1);
  } finally { restore(); }
});
test('头像组件：能看大图且有照片时用 catchtap（不触发外面卡片的跳转，比如「我的」资料卡进编辑资料），没照片时点击照常传给外面', () => {
  const wxml = require('fs').readFileSync(path.join(__dirname, '../components/pl-av/pl-av.wxml'), 'utf8');
  const views = wxml.split('\n').filter((l) => /^<view/.test(l));
  assert.strictEqual(views.length, 2);
  assert.ok(/wx:if="\{\{preview && url\}\}"/.test(views[0]) && /catchtap="onTap"/.test(views[0]));
  assert.ok(/wx:else/.test(views[1]) && !/bindtap|catchtap/.test(views[1]));
});

module.exports = T;
