const assert = require('assert');
const path = require('path');
const T = [];
const test = (name, fn) => T.push({ name, fn });
const tick = () => new Promise((r) => setTimeout(r, 5));
function client(call) {
  const cloudPath = require.resolve('../utils/cloud');
  const photoPath = require.resolve('../utils/photo');
  const old = require.cache[cloudPath];
  require.cache[cloudPath] = { id: cloudPath, filename: cloudPath, loaded: true, exports: { call } };
  delete require.cache[photoPath];
  const P = require(photoPath);
  return { P, restore() { P.clear(); delete require.cache[photoPath]; if (old) require.cache[cloudPath] = old; else delete require.cache[cloudPath]; } };
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
module.exports = T;
