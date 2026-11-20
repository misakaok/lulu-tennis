// 球员照片缩略图的本机缓存（只给 utils/photo.js 用）
//   只存云函数 photoUrls 标了 thumbs 的 320×320 缩略图，按 players.photo 的 fileID 存：
//   照片每次上传都是新的 fileID、内容不会变，所以文件不用判断过期，换照片自然就是新文件。
//   文件放在 wx.env.USER_DATA_PATH/pl/，索引在本机存储 photo_files：{ fileID: { f: 文件名, s: 字节数, t: 最近使用时间 } }。
//   照片不再公开（换了照片、关掉公开展示、管理员移除）就删掉（prune，由 photo.js 在拿到最新球员资料后调用）；
//   超过 LIMIT 按最近使用时间删最旧的；退出成员身份时整个删掉（clearAll）。
const KEY = 'photo_files';
const LIMIT = { count: 200, bytes: 20 * 1024 * 1024 }; // 一张约 20～40KB，200 张也就几 MB（测试可以改）
let idx = null;
let broken = false;        // 下载不了（比如 downloadFile 合法域名没配）：这次启动不再试
let swept = false;         // 本次启动是否已经清过目录里索引外的文件
let generation = 0;
const busy = new Set();

const dir = () => ((typeof wx !== 'undefined' && wx.env && wx.env.USER_DATA_PATH) || '') + '/pl';
const fsm = () => { try { return wx.getFileSystemManager(); } catch (e) { return null; } };
// 文件名取 fileID 的最后两段（用户 ID + 快照名），每个 fileID 唯一
const nameOf = (fileID) => {
  const m = /\/([^/]+)\/([^/]+)\.jpg$/.exec(String(fileID || ''));
  return m ? (m[1] + '_' + m[2]).replace(/[^\w-]/g, '_').slice(0, 120) + '.jpg' : '';
};

function load() {
  if (idx) return idx;
  try { idx = wx.getStorageSync(KEY) || {}; } catch (e) { idx = {}; }
  if (!idx || typeof idx !== 'object' || Array.isArray(idx)) idx = {};
  return idx;
}
let saveTimer = null;
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; try { wx.setStorageSync(KEY, load()); } catch (e) {} }, 300);
}
function unlink(f) { const fs = fsm(); if (fs && f) try { fs.unlinkSync(dir() + '/' + f); } catch (e) {} }
function drop(fileID) {
  const e = load()[fileID];
  if (!e) return;
  delete idx[fileID];
  unlink(e.f);
  persist();
}

// 本机有这张缩略图就返回本地路径（顺便记一下使用时间），否则 ''
function get(fileID) {
  const e = load()[fileID];
  if (!e) return '';
  e.t = Date.now(); // 只改内存，下次写索引时一起保存
  return dir() + '/' + e.f;
}
const has = (fileID) => !!load()[fileID];

// 后台下载并保存；wanted(fileID) 为 false（期间照片不再公开、被清空）就不留
function save(fileID, url, wanted) {
  const f = nameOf(fileID);
  if (!f || !url || broken || load()[fileID] || busy.has(fileID) || typeof wx === 'undefined' || !wx.downloadFile) return;
  const fs = fsm();
  if (!fs) return;
  const gen = generation;
  busy.add(fileID);
  const done = () => busy.delete(fileID);
  wx.downloadFile({
    url,
    success(r) {
      if (gen !== generation || r.statusCode !== 200 || !r.tempFilePath) return done();
      try { fs.mkdirSync(dir(), true); } catch (e) {} // 已经有了会报错，不管
      unlink(f);
      fs.saveFile({
        tempFilePath: r.tempFilePath,
        filePath: dir() + '/' + f,
        success() {
          done();
          if (gen !== generation || (wanted && !wanted(fileID))) return unlink(f);
          let s = 0;
          try { s = fs.statSync(dir() + '/' + f).size || 0; } catch (e) {}
          load()[fileID] = { f, s, t: Date.now() };
          trim();
          persist();
        },
        fail(e) { done(); console.warn('[照片] 保存缩略图失败', e && e.errMsg); },
      });
    },
    fail(e) {
      done();
      const msg = (e && e.errMsg) || '';
      if (/domain|url not in/i.test(msg)) broken = true; // 合法域名没配：这次启动不再下载，照常用临时链接显示
      console.warn('[照片] 下载缩略图失败', msg);
    },
  });
}

// 超过上限：按最近使用时间删最旧的
function trim() {
  const list = Object.keys(load()).map((k) => [k, idx[k]]).sort((a, b) => (a[1].t || 0) - (b[1].t || 0));
  let bytes = list.reduce((n, [, e]) => n + (e.s || 0), 0), count = list.length;
  for (const [k, e] of list) {
    if (count <= LIMIT.count && bytes <= LIMIT.bytes) break;
    delete idx[k]; unlink(e.f);
    count--; bytes -= e.s || 0;
  }
}

// 只留 keep 里还在公开的照片；本次启动第一次调用时，顺便删掉目录里索引外的文件（索引丢了留下的）
function prune(keep) {
  let changed = false;
  Object.keys(load()).forEach((k) => { if (!keep.has(k)) { unlink(idx[k].f); delete idx[k]; changed = true; } });
  if (!swept) {
    swept = true;
    const fs = fsm();
    let files = [];
    if (fs) try { files = fs.readdirSync(dir()); } catch (e) {}
    const known = new Set(Object.keys(idx).map((k) => idx[k].f));
    files.forEach((f) => { if (!known.has(f)) unlink(f); });
  }
  if (changed) persist();
}

// 退出成员身份 / 换账号：全部删掉
function clearAll() {
  generation++;
  busy.clear();
  const fs = fsm();
  Object.keys(load()).forEach((k) => unlink(idx[k].f));
  if (fs) try { fs.rmdirSync(dir(), true); } catch (e) {}
  idx = {};
  swept = false;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  try { wx.removeStorageSync(KEY); } catch (e) {}
}

// 测试用：模拟重新启动（丢掉内存里的状态，本机存储和文件保留）
function _restart() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; try { wx.setStorageSync(KEY, load()); } catch (e) {} }
  idx = null; broken = false; swept = false; busy.clear();
}

module.exports = { LIMIT, get, has, save, drop, prune, clearAll, _restart };
