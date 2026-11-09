// 头像本地缓存（utils/avatar.js 的 localFile / saveLocal / clearFiles）
const assert = require('assert');
const path = require('path');

const T = [];
const test = (name, fn) => T.push({ name, fn });
const ROOT = path.resolve(__dirname, '..');

function setup(opts) {
  opts = opts || {};
  const storage = {}, disk = {};
  let downloads = 0;
  global.wx = {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getStorageSync: (k) => storage[k], setStorageSync: (k, v) => { storage[k] = JSON.parse(JSON.stringify(v)); }, removeStorageSync: (k) => { delete storage[k]; },
    getFileSystemManager: () => ({
      accessSync: (p) => { if (!disk[p]) throw new Error('no such file'); },
      unlinkSync: (p) => { delete disk[p]; },
      mkdirSync: () => {},
      rmdirSync: (dir) => { Object.keys(disk).forEach((p) => { if (p.startsWith(dir)) delete disk[p]; }); },
      saveFile: ({ tempFilePath, filePath, success }) => { disk[filePath] = tempFilePath; success(); },
    }),
    downloadFile: ({ url, success, fail }) => {
      downloads++;
      if (opts.noDomain) fail({ errMsg: 'downloadFile:fail url not in domain list' });
      else success({ statusCode: 200, tempFilePath: 'tmp://' + url });
    },
  };
  delete require.cache[path.join(ROOT, 'utils/avatar.js')];
  const A = require(path.join(ROOT, 'utils/avatar.js'));
  return { A, disk, storage, downloads: () => downloads };
}
const ID = (n) => `cloud://env1.x/avatars/u${n}/${n}.jpg`;

test('下载过的头像存在本地，下次直接用本地文件', () => {
  const { A, disk } = setup();
  assert.strictEqual(A.localFile(ID(1)), '');
  A.saveLocal(ID(1), 'https://tmp/1.jpg');
  const p = A.localFile(ID(1));
  assert.ok(p.startsWith('wxfile://usr/avatars/') && p.endsWith('.jpg'));
  assert.ok(disk[p]);
  A.saveLocal(ID(1), 'https://tmp/1-new-link.jpg'); // 已经存过，不重复下载
  assert.strictEqual(Object.keys(disk).length, 1);
});
test('文件被系统清掉了就当没缓存；换照片（新 fileID）不会用旧图', () => {
  const { A, disk } = setup();
  A.saveLocal(ID(1), 'https://tmp/1.jpg');
  Object.keys(disk).forEach((k) => delete disk[k]);
  assert.strictEqual(A.localFile(ID(1)), '');
  assert.strictEqual(A.localFile(ID(2)), '');
});
test('域名没配置：失败一次后本次运行不再尝试，也不影响显示', () => {
  const { A, downloads } = setup({ noDomain: true });
  A.saveLocal(ID(1), 'https://tmp/1.jpg');
  A.saveLocal(ID(2), 'https://tmp/2.jpg');
  assert.strictEqual(downloads(), 1);
  assert.strictEqual(A.localFile(ID(1)), '');
});
test('超过 300 张时删最久没用的；清理时文件一起删除', () => {
  const { A, disk } = setup();
  const realNow = Date.now; let t = 1e12; Date.now = () => ++t;
  try {
    for (let i = 0; i < 302; i++) A.saveLocal(ID(i), `https://tmp/${i}.jpg`);
    assert.strictEqual(Object.keys(disk).length, 300);
    assert.strictEqual(A.localFile(ID(0)), ''); assert.strictEqual(A.localFile(ID(1)), '');
    assert.ok(A.localFile(ID(301)));
    A.clearFiles();
    assert.strictEqual(Object.keys(disk).length, 0);
    assert.strictEqual(A.localFile(ID(301)), '');
  } finally { Date.now = realNow; }
});
test('不是云文件、不是 https 链接的不缓存', () => {
  const { A, disk } = setup();
  A.saveLocal('/images/avatar-default.png', 'https://tmp/x.jpg');
  A.saveLocal(ID(1), 'wxfile://tmp/local.jpg');
  assert.strictEqual(Object.keys(disk).length, 0);
});

module.exports = T;
