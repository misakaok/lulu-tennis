// 头像显示
//   数据库里永远只保存云文件 fileID（cloud://环境ID.存储桶/avatars/xxx.jpg），
//   显示前用 wx.cloud.getTempFileURL 换成 HTTPS 临时链接（只缓存在本机，过期前自动重新获取）。
//   不能把 cloud:// 直接交给 <image>：解析失败时它会被当成相对路径，拼成 /pages/xx/cloud://... 加载失败。
const DEFAULT = '/images/avatar-default.png';
const MAX_AGE = 30 * 60;           // 临时链接有效期（秒）：短一些，减少移除成员后旧链接还能用的时间
const SAFE_MS = 25 * 60 * 1000;    // 本机缓存 25 分钟，早于链接过期（云函数发的链接 30 分钟有效）
const FAIL_MS = 10 * 60 * 1000;    // 获取失败的文件 10 分钟内不重复请求
const BATCH = 50;                  // getTempFileURL 每次最多 50 个
const KEY = 'avatar_url_cache';

const isCloud = (s) => typeof s === 'string' && s.indexOf('cloud://') === 0;
// 可以直接显示的地址：HTTPS、选头像后的本地临时文件、小程序包内图片
const isDirect = (s) => typeof s === 'string' && /^(https?:\/\/|wxfile:\/\/|\/)/.test(s);

// cloud://tennis-7g8x.7465-tennis-7g8x-1300000000/avatars/a.jpg → tennis-7g8x
function envOf(fileID) {
  const m = /^cloud:\/\/([^./]+)\.[^/]+\/.+/.exec(fileID || '');
  return m ? m[1] : '';
}

let mem = null, saveTimer = null;
function cache() {
  if (!mem) {
    try { mem = wx.getStorageSync(KEY) || {}; } catch (e) { mem = {}; }
    const now = Date.now();
    Object.keys(mem).forEach((k) => { if (!mem[k] || mem[k].exp <= now) delete mem[k]; });
  }
  return mem;
}
function persist() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; try { wx.setStorageSync(KEY, cache()); } catch (e) {} }, 300);
}

// 已经拿到的显示地址（拿不到返回 ''，不发请求）
function peek(src) {
  if (!src) return '';
  if (!isCloud(src)) return isDirect(src) ? src : '';
  const c = cache()[src];
  return c && c.exp > Date.now() ? c.url : '';
}

let pending = {}, flushTimer = null;
function schedule() { if (!flushTimer) flushTimer = setTimeout(flush, 0); } // 同一时刻的请求合并成一批

async function flush() {
  flushTimer = null;
  const waiters = pending;
  pending = {};
  const ids = Object.keys(waiters);
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const now = Date.now();
    const got = viaCloud ? {} : await fetchDirect(chunk);
    // 客户端没有读取权限（STORAGE_EXCEED_AUTHORITY）的，改由云函数取（只限 avatars/ 目录）
    const retry = chunk.filter((id) => !got[id] || (!got[id].url && (viaCloud || got[id].denied)));
    if (retry.length) {
      const fromCloud = await fetchCloud(retry);
      retry.forEach((id) => { if (fromCloud[id]) got[id] = fromCloud[id]; });
    }
    chunk.forEach((id) => {
      const g = got[id] || { err: '获取失败' };
      if (g.url) cache()[id] = { url: g.url, exp: now + SAFE_MS };
      else {
        cache()[id] = { url: '', err: g.err, exp: now + (g.transient ? 60 * 1000 : FAIL_MS) };
        console.warn('[头像] 获取临时链接失败', id, g.err);
      }
      (waiters[id] || []).forEach((fn) => fn((cache()[id] || {}).url || ''));
    });
  }
  persist();
}

const DENIED = /EXCEED_AUTHORITY|PERMISSION|denied|-403|-502003/i;
let viaCloud = true; // 仅限成员：云存储只允许本人直接读自己的文件，别人的照片一律经云函数（校验成员资格）取链接

// 小程序端直接取：云存储安全规则允许读 avatars/ 时最快
async function fetchDirect(chunk) {
  const out = {};
  try {
    const res = await wx.cloud.getTempFileURL({ fileList: chunk.map((fileID) => ({ fileID, maxAge: MAX_AGE })) });
    (res.fileList || []).forEach((f) => {
      const err = f.errMsg || 'status ' + f.status;
      out[f.fileID] = f.status === 0 && f.tempFileURL ? { url: f.tempFileURL } : { err, denied: DENIED.test(err) };
    });
  } catch (e) {
    const err = e.errMsg || e.message || String(e);
    chunk.forEach((id) => { out[id] = { err, denied: DENIED.test(err), transient: !DENIED.test(err) }; });
  }
  return out;
}

// 云函数兜底：服务端不受存储安全规则限制，云函数只放行当前环境 avatars/ 下的文件
async function fetchCloud(chunk) {
  const out = {};
  try {
    const r = await wx.cloud.callFunction({ name: 'tennis', data: { action: 'avatarUrls', fileIDs: chunk } });
    const res = (r && r.result) || {};
    if (!res.ok) throw new Error(res.error || '云函数返回失败');
    let anyOk = false;
    chunk.forEach((id) => {
      const f = (res.files || {})[id] || {};
      if (f.url) { out[id] = { url: f.url }; anyOk = true; } else out[id] = { err: f.error || '云函数未返回链接', reason: f.error, env: f.env };
    });
    if (anyOk) viaCloud = true;
  } catch (e) {
    const err = String((e && (e.errMsg || e.message)) || e);
    console.warn('[头像] 云函数兜底不可用（请部署 tennis 云函数，并在云存储设置安全规则）', err);
    chunk.forEach((id) => { out[id] = { err, transient: true }; });
  }
  return out;
}

// fileID → 显示地址；失败返回 ''（调用方显示默认头像）
function resolve(src, force) {
  if (!src) return Promise.resolve('');
  if (!isCloud(src)) return Promise.resolve(isDirect(src) ? src : '');
  if (!envOf(src)) { console.warn('[头像] fileID 格式不对', src); return Promise.resolve(''); }
  if (!force) {
    const c = cache()[src];
    if (c && c.exp > Date.now()) return Promise.resolve(c.url || '');
  }
  return new Promise((res) => { (pending[src] = pending[src] || []).push(res); schedule(); });
}

// 显示出错（比如缓存的临时链接已经失效）：清掉缓存，下次重新获取
function invalidate(src) { if (cache()[src]) { delete cache()[src]; persist(); } }

/* ---------- 头像图片本地缓存 ---------- */
// 临时链接每 25 分钟换一次，链接一换图片就要重新下载。这里把下载过的头像按 fileID 存在手机本地：
//   换照片会生成新的 fileID，所以不会显示旧图；最多 FILE_MAX 张，超过删最久没用的。
//   真机上 wx.downloadFile 需要在公众平台把临时链接的域名加进「downloadFile 合法域名」；
//   没配置时下载会失败，本次运行就不再尝试，照常用临时链接显示，不影响使用。
//   被移出成员时（utils/member.js 清缓存）连同文件一起删除。
const FILE_KEY = 'avatar_files';  // { fileID: { path, at } }
const FILE_MAX = 300;
let files = null, filesOn = true, filesTimer = null;
const saving = {};
const fsm = () => (wx.getFileSystemManager ? wx.getFileSystemManager() : null);
const fileDir = () => `${(wx.env && wx.env.USER_DATA_PATH) || ''}/avatars`;
function hashOf(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0; return h.toString(16) + s.length.toString(16); }
function fileMap() {
  if (!files) { try { files = wx.getStorageSync(FILE_KEY) || {}; } catch (e) { files = {}; } }
  return files;
}
function persistFiles() {
  if (filesTimer) return;
  filesTimer = setTimeout(() => { filesTimer = null; try { wx.setStorageSync(FILE_KEY, fileMap()); } catch (e) {} }, 500);
}
// 已缓存在本地的图片路径（文件不在了就返回 ''）
function localFile(src) {
  const f = isCloud(src) && fileMap()[src];
  if (!f) return '';
  try { fsm().accessSync(f.path); } catch (e) { delete fileMap()[src]; persistFiles(); return ''; }
  f.at = Date.now();
  persistFiles();
  return f.path;
}
function dropLocal(src) {
  const f = fileMap()[src];
  if (!f) return;
  try { fsm().unlinkSync(f.path); } catch (e) {}
  delete fileMap()[src];
  persistFiles();
}
function evict() {
  const keys = Object.keys(fileMap());
  if (keys.length <= FILE_MAX) return;
  keys.sort((a, b) => fileMap()[a].at - fileMap()[b].at).slice(0, keys.length - FILE_MAX).forEach(dropLocal);
}
// 拿到临时链接后在后台下载并存到本地；失败不影响显示
function saveLocal(src, url) {
  const fs = fsm();
  if (!filesOn || !fs || !isCloud(src) || !/^https:\/\//.test(url || '') || saving[src] || fileMap()[src]) return;
  saving[src] = 1;
  const done = () => { delete saving[src]; };
  wx.downloadFile({
    url,
    success: (r) => {
      if (r.statusCode !== 200 || !r.tempFilePath) { done(); return; }
      const ext = ((src.match(/\.(\w{2,4})$/) || [])[1] || 'jpg').toLowerCase();
      const path = `${fileDir()}/${hashOf(src)}.${ext}`;
      try { fs.mkdirSync(fileDir(), true); } catch (e) {}
      fs.saveFile({
        tempFilePath: r.tempFilePath, filePath: path,
        success: () => { fileMap()[src] = { path, at: Date.now() }; evict(); persistFiles(); done(); },
        fail: done,
      });
    },
    fail: (e) => {
      done();
      // 域名没配置 / 没有权限：本次运行不再尝试
      if (/domain|url not in|合法域名|permission/i.test((e && e.errMsg) || '')) filesOn = false;
    },
  });
}
// 清掉全部本地头像文件（被移出成员时）
function clearFiles() {
  try { fsm().rmdirSync(fileDir(), true); } catch (e) {}
  files = {};
  try { wx.removeStorageSync(FILE_KEY); } catch (e) {}
}

function currentEnv() {
  try { const app = getApp(); if (app && app.globalData && app.globalData.envId) return app.globalData.envId; } catch (e) {}
  try { return wx.getStorageSync('cloud_env') || ''; } catch (e) { return ''; }
}
function rememberEnv(fileID) { const env = envOf(fileID); if (env) { try { wx.setStorageSync('cloud_env', env); } catch (e) {} } }

/**
 * 头像诊断：逐个检查云文件是否存在、是否同一个环境、有没有读取权限
 * 返回 { total, ok, missing[], denied[], other[], malformed[], envs{env:数量}, appEnv, envMismatch[] }
 */
async function diagnose(list) {
  const ids = [];
  (list || []).forEach((x) => { if (x && ids.indexOf(x) < 0) ids.push(x); });
  const appEnv = currentEnv();
  const r = { total: ids.length, ok: 0, missing: [], denied: [], rescued: [], notAvatar: [], other: [], malformed: [], envs: {}, appEnv, envMismatch: [] };
  const cloud = [];
  ids.forEach((id) => {
    if (isCloud(id)) {
      const env = envOf(id);
      if (!env) { r.malformed.push(id); return; }
      r.envs[env] = (r.envs[env] || 0) + 1;
      if (appEnv && env !== appEnv) r.envMismatch.push(id);
      cloud.push(id);
    } else if (isDirect(id) && !/^(wxfile:|http:\/\/tmp)/.test(id)) r.ok++;
    else r.malformed.push(id); // 本地临时文件被存进了数据库，别人看不到
  });
  for (let i = 0; i < cloud.length; i += BATCH) {
    const chunk = cloud.slice(i, i + BATCH);
    const got = await fetchDirect(chunk);
    const denied = [];
    chunk.forEach((id) => {
      const g = got[id] || {};
      if (g.url) { r.ok++; cache()[id] = { url: g.url, exp: Date.now() + SAFE_MS }; }
      else if (g.denied) denied.push(id);
      else if (/NONEXIST|not ?exist|not found|-404/i.test(g.err || '')) r.missing.push(id);
      else r.other.push(id + '（' + (g.err || '未知错误') + '）');
    });
    if (!denied.length) continue;
    // 小程序端没有读取权限：看云函数能不能兜底
    const fc = await fetchCloud(denied);
    denied.forEach((id) => {
      const f = fc[id] || {};
      if (f.url) { r.ok++; r.rescued.push(id); cache()[id] = { url: f.url, exp: Date.now() + SAFE_MS }; }
      else if (f.reason === 'ENV_MISMATCH') { if (r.envMismatch.indexOf(id) < 0) r.envMismatch.push(id); r.denied.push(id); }
      else if (f.reason === 'NOT_AVATAR') { r.notAvatar.push(id); r.denied.push(id); }
      else if (/NONEXIST|not ?exist|not found|-404/i.test(f.err || '')) r.missing.push(id);
      else r.denied.push(id);
    });
  }
  persist();
  return r;
}

function reportText(r) {
  const lines = [`共 ${r.total} 个头像，正常 ${r.ok} 个`];
  const envs = Object.keys(r.envs);
  if (envs.length > 1) lines.push(`⚠️ 头像来自 ${envs.length} 个不同的云环境：${envs.join('、')}`);
  if (r.envMismatch.length) lines.push(`⚠️ ${r.envMismatch.length} 个不属于当前环境 ${r.appEnv}`);
  if (r.missing.length) lines.push(`❌ ${r.missing.length} 个云文件不存在（已被删除）`);
  if (r.rescued.length) lines.push(`✅ ${r.rescued.length} 个由云函数代取，正常显示（别人的照片都经云函数发放，这是正常的）`);
  if (r.notAvatar.length) lines.push(`❌ ${r.notAvatar.length} 个头像不在 avatars/ 目录，云函数不代取：请本人重新上传头像`);
  if (r.denied.length - r.notAvatar.length > 0) lines.push(`🔒 ${r.denied.length - r.notAvatar.length} 个云函数也取不到：请确认 tennis 云函数已部署（不要为此放宽云存储规则）`);
  if (r.malformed.length) lines.push(`❌ ${r.malformed.length} 个地址无效（不是云文件）`);
  if (r.other.length) lines.push(`❓ ${r.other.length} 个其他错误：${r.other[0]}`);
  if (r.ok === r.total) lines.push('✅ 全部可以正常显示');
  else lines.push('有问题的头像会显示默认头像，本人重新设置一次头像即可恢复');
  return lines.join('\n');
}

module.exports = { DEFAULT, isCloud, isDirect, envOf, peek, resolve, invalidate, currentEnv, rememberEnv, diagnose, reportText, localFile, saveLocal, dropLocal, clearFiles };
