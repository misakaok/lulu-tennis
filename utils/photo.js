// 球员照片
//   数据库只存已通过微信图片检测的 fileID（players.photo，由云函数写入），显示前经云函数 photoUrls 换 30 分钟临时链接。
//   列表头像用 320×320 缩略图（photoUrls 默认发缩略图），并存到本机（utils/photo-cache.js），下次直接用本机文件；
//   点开看大图才取原图（full）。本机文件要等这次启动拿到最新球员资料（setPlayers）后才用：期间有人关了公开展示、换了照片，
//   先按最新资料删掉本机文件，不会多显示。
//   没有照片、链接拿不到、加载出错时，组件 components/pl-av 显示「彩色圆 + 名字首字」。
//   上传：相册 / 拍照 → 1:1 裁剪 → 画布缩放成 1080×1080 的 JPG → 上传到 avatars/<用户 ID>/ → 云函数 setPhoto 提交检测。
//   本人马上看到：检测期间本人在所有页面看到自己的新照片（本机文件，重启后经云函数 myPhoto 取本人专用链接），
//   其他球友等检测通过、players.photo 换成这张之后才看到。
const SIZE = 1080;                 // 照片边长（像素）
const QUALITY = 0.9;               // JPG 质量
const SAFE_MS = 25 * 60 * 1000;    // 链接缓存 25 分钟，早于云函数发的链接过期（30 分钟）
const FAIL_MS = 60 * 1000;         // 拿不到链接的照片 1 分钟内不重复请求
const BATCH = 50;
const MINE_KEY = 'photo_pending';  // 本机记一下「我有照片在检测」：只有这时才在启动后查 myPhoto
const MINE_DAYS = 3;               // 超过 3 天还没结果就不再显示，以资料页查到的状态为准
const READY_WAIT_MS = 4000;        // 本机有缩略图时，最多等 4 秒最新球员资料；等不到就照常取链接
const L = require('./photo-cache');

/* ---------- 用户 ID / 名字 → 照片 fileID ---------- */
let byUid = null, byName = null;
const subs = new Set(); // 正在显示的头像组件：照片名单变了就刷新
let ready = false;      // 这次启动已经拿到最新球员资料（本机缩略图可以用了）
let readyWaiters = [];
const settleReady = (ok) => { const w = readyWaiters; readyWaiters = []; w.forEach((fn) => fn(ok)); };
function whenReady() {
  if (ready) return Promise.resolve(true);
  return new Promise((res) => {
    const timer = setTimeout(() => { readyWaiters = readyWaiters.filter((f) => f !== done); res(false); }, READY_WAIT_MS);
    const done = (ok) => { clearTimeout(timer); res(ok); };
    readyWaiters.push(done);
  });
}
// 这张照片现在还公开吗（按最新的照片名单）
const isPublic = (fileID) => !!fileID && !!byUid && (Object.keys(byUid).some((k) => byUid[k] === fileID) || Object.keys(byName).some((k) => byName[k] === fileID));

// utils/db.js 整理球员资料（buildPlayers，数据来自云端）后调用；cached 为 true 表示是本机缓存的旧资料（seed）
const refreshAll = () => subs.forEach((c) => { try { c.refresh(); } catch (e) {} });
function setPlayers(players, profiles, cached) {
  const u = {}, n = {};
  Object.keys(profiles || {}).forEach((k) => { const p = profiles[k]; if (p && p.photo) u[k] = p.photo; });
  (players || []).forEach((p) => { if (p && p.uid && !p.ambiguous && p.photo) n[p.name] = p.photo; });
  const changed = !byUid || JSON.stringify(u) !== JSON.stringify(byUid) || JSON.stringify(n) !== JSON.stringify(byName);
  byUid = u; byName = n;
  if (!cached) {
    L.prune(new Set(Object.keys(u).map((k) => u[k]).concat(Object.keys(n).map((k) => n[k])))); // 不再公开的照片：本机文件删掉
    if (!ready) { ready = true; settleReady(true); }
  }
  if (mine && mine.fileID && u[mine.uid] === mine.fileID) { setMine(null); return; } // 检测通过了：大家看到的就是这张
  if (changed) refreshAll();
  syncMine(); // 启动后第一次拿到球员资料时，顺便看看本人有没有照片在检测（只查一次）
}
function seed() {
  if (byUid) return;
  try { const db = require('./db'); setPlayers(db.cachedPlayersFull(), db.cachedProfiles(), true); } catch (e) { byUid = {}; byName = {}; }
  syncMine();
}

/* ---------- 本人检测中的照片（只在本机显示给自己） ---------- */
let mine = null;     // { uid, name, fileID, src }
let synced = false;
const POLL_MS = [60, 180, 600].map((s) => s * 1000); // 上传后过一会儿查一下结果：通过就换成正式照片，没通过就不再显示
let polls = [];
const store = (v) => { try { if (v) wx.setStorageSync(MINE_KEY, v); else wx.removeStorageSync(MINE_KEY); } catch (e) {} };
function setMine(v) {
  const before = mine && mine.fileID;
  mine = v && v.src ? v : null;
  if (!mine || mine.fileID !== before) { polls.forEach(clearTimeout); polls = []; }
  if (mine && !polls.length) polls = POLL_MS.map((ms) => setTimeout(() => { if (mine) syncMine(true); }, ms));
  if (v && v.uid) store({ uid: v.uid, name: v.name || '', fileID: v.fileID || '', at: Date.now() });
  else if (!v) store(null);
  refreshAll();
}
// 本人的头像：有检测中的新照片就返回它的显示地址，否则 ''
function ownSrc(uid, name) {
  if (!mine) return '';
  return (uid ? uid === mine.uid : !!name && name === mine.name) ? mine.src : '';
}
// 启动后第一次显示头像时：本机记着有照片在检测，就查一次 myPhoto（本人专用链接，30 分钟）
async function syncMine(force) {
  if (synced && !force) return;
  synced = true;
  let flag = null;
  try { flag = wx.getStorageSync(MINE_KEY) || null; } catch (e) {}
  if (!flag || !flag.uid || Date.now() - (flag.at || 0) > MINE_DAYS * 86400000) { if (flag) store(null); return; }
  const had = mine;
  try {
    const r = await require('./cloud').call('myPhoto');
    if (mine !== had) return; // 等结果期间已经删掉 / 换了新照片：以新的为准
    applyMine(flag.uid, flag.name, r);
  } catch (e) { console.warn('[照片] 查询检测状态失败', e && e.message); }
}
// 按 myPhoto 的结果更新：还在检测就显示本人专用链接；通过、没通过、删除了都不再单独显示
function applyMine(uid, name, r) {
  if (r && r.state === 'checking' && r.pendingUrl) {
    if (!mine || mine.fileID !== r.pending) setMine({ uid, name, fileID: r.pending || '', src: r.pendingUrl }); // 本机文件还在就接着用
  } else if (mine) {
    // 刚通过检测：先把正式照片记上（不等下一次读球员资料），免得本人先看到旧照片
    if (r && r.photo && r.photo === mine.fileID) {
      seed();
      byUid[uid] = r.photo;
      if (mine.name) byName[mine.name] = r.photo;
      if (r.url) urls[r.photo] = { url: r.url, exp: Date.now() + SAFE_MS };
    }
    setMine(null);
  } else store(null);
}
// 有用户 ID 按 ID 找；只有名字时按名字找（同名的不算）
function fileOf(uid, name) {
  seed();
  return (uid ? byUid[uid] : byName[name]) || '';
}

/* ---------- fileID → 临时链接 ---------- */
const urls = {}; // fileID → { url, exp }
let pending = {}, timer = null;
const inFlight = new Map();
const retriedAt = new Map();
let generation = 0;

function peek(fileID) {
  if (ready && fileID) { const local = L.get(fileID); if (local) return local; }
  const c = urls[fileID];
  return c && c.exp > Date.now() ? c.url : '';
}
// skipLocal：等最新资料超时了，这次不用本机文件
function resolve(fileID, skipLocal) {
  if (!fileID) return Promise.resolve('');
  if (!skipLocal && L.has(fileID)) {
    if (ready) return Promise.resolve(L.get(fileID));
    const epoch = generation;
    return whenReady().then((ok) => {
      if (epoch !== generation) return '';
      return ok && L.has(fileID) ? L.get(fileID) : resolve(fileID, true);
    });
  }
  const c = urls[fileID];
  if (c && c.exp > Date.now()) return Promise.resolve(c.url);
  if (inFlight.has(fileID)) return inFlight.get(fileID);
  const task = new Promise((res) => {
    (pending[fileID] = pending[fileID] || []).push(res);
    if (!timer) timer = setTimeout(flush, 0); // 同一时刻的请求合并成一批
  });
  inFlight.set(fileID, task);
  task.then(() => { if (inFlight.get(fileID) === task) inFlight.delete(fileID); });
  return task;
}
async function flush() {
  timer = null;
  const epoch = generation;
  const waiters = pending;
  pending = {};
  const ids = Object.keys(waiters);
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    if (epoch !== generation) { chunk.forEach((id) => waiters[id].forEach((fn) => fn(''))); continue; }
    let files = {}, thumbs = {};
    try {
      const r = await require('./cloud').call('photoUrls', { fileIDs: chunk });
      files = r.files || {}; thumbs = r.thumbs || {};
    } catch (e) { console.warn('[照片] 获取链接失败', e && e.message); }
    if (epoch !== generation) { chunk.forEach((id) => waiters[id].forEach((fn) => fn(''))); continue; }
    const now = Date.now();
    chunk.forEach((id) => {
      urls[id] = files[id] ? { url: files[id], exp: now + SAFE_MS } : { url: '', exp: now + FAIL_MS };
      waiters[id].forEach((fn) => fn(urls[id].url));
      if (files[id] && thumbs[id]) L.save(id, files[id], isPublic); // 只存缩略图（旧版云函数发的是原图，不存）
    });
  }
}
// 显示出错（链接失效、本机文件坏了）：清掉，下次重新获取
function invalidate(fileID) {
  if (L.has(fileID)) { L.drop(fileID); return; }
  const now = Date.now();
  if (retriedAt.has(fileID) && now - retriedAt.get(fileID) < FAIL_MS) return;
  retriedAt.set(fileID, now);
  delete urls[fileID];
}

// 点开看大图：取原图链接（不存本机）；取不到返回 ''
const fullUrls = {};
const fullFlight = new Map();
function full(fileID) {
  if (!fileID) return Promise.resolve('');
  const c = fullUrls[fileID];
  if (c && c.exp > Date.now()) return Promise.resolve(c.url);
  if (fullFlight.has(fileID)) return fullFlight.get(fileID); // 先取好的（组件显示时）和点开时的合并成一次
  const epoch = generation;
  const task = (async () => {
    try {
      const url = ((await require('./cloud').call('photoUrls', { fileIDs: [fileID], full: true })).files || {})[fileID] || '';
      if (url && epoch === generation) fullUrls[fileID] = { url, exp: Date.now() + SAFE_MS };
      return epoch === generation ? url : '';
    } catch (e) { console.warn('[照片] 获取原图失败', e && e.message); return ''; }
    finally { fullFlight.delete(fileID); }
  })();
  fullFlight.set(fileID, task);
  return task;
}

function clear() {
  generation++;
  L.clearAll();
  ready = false; settleReady(false);
  Object.keys(fullUrls).forEach((k) => delete fullUrls[k]);
  fullFlight.clear();
  mine = null; synced = false; store(null);
  polls.forEach(clearTimeout); polls = [];
  byUid = {}; byName = {};
  Object.keys(urls).forEach((k) => delete urls[k]);
  inFlight.clear(); retriedAt.clear();
  if (timer) clearTimeout(timer);
  timer = null;
  const old = pending; pending = {};
  Object.keys(old).forEach((id) => old[id].forEach((fn) => fn('')));
  subs.forEach((c) => { try { c.refresh(); } catch (e) {} });
}

/* ---------- 上传 ---------- */
const p = (fn, o) => new Promise((ok, bad) => fn(Object.assign({}, o, { success: ok, fail: bad })));

// 选图并裁剪：返回裁好的本地临时路径；取消返回 ''
async function pick(source) {
  let r;
  try {
    // 取原图：裁剪、缩放后统一压一次，避免先被压缩再放大变糊
    r = await p(wx.chooseMedia, { count: 1, mediaType: ['image'], sourceType: [source], sizeType: ['original'], camera: 'front' });
  } catch (e) {
    const msg = (e && e.errMsg) || '';
    const no = e && e.errno;
    if (/cancel/.test(msg)) return '';
    console.error('[照片] 选图失败', no, msg);
    // 112：后台「用户隐私保护指引」没声明这项（真机才会拦，模拟器不拦）；104：用户没同意隐私保护指引
    if (no === 112 || /not declared in the privacy/i.test(msg)) throw new Error(`小程序还没有声明使用${source === 'camera' ? '摄像头' : '相册照片'}，请联系管理员在后台「用户隐私保护指引」里补上`);
    // 104：微信弹了隐私保护指引、用户没同意 → 停止这次操作（轻提示，不再弹报错）
    if (require('./privacy').isDenied(e)) { require('./privacy').stopped(); return ''; }
    if (/auth den|authorize/i.test(msg)) throw new Error(source === 'camera' ? '没有使用摄像头的权限，请点右上角「…」→ 设置，打开摄像头' : '没有访问相册的权限，请在手机设置里允许微信访问照片');
    throw new Error((source === 'camera' ? '无法打开相机' : '无法打开相册') + (msg ? '（' + msg.replace(/^chooseMedia:fail\s*/, '') + '）' : ''));
  }
  const src = r.tempFiles && r.tempFiles[0] && r.tempFiles[0].tempFilePath;
  if (!src) return '';
  if (!wx.cropImage) return src; // 基础库低于 2.26.0 没有裁剪：缩放时居中取正方形
  try { return (await p(wx.cropImage, { src, cropScale: '1:1' })).tempFilePath; } catch (e) {
    if (/cancel/.test((e && e.errMsg) || '')) return '';
    throw new Error('裁剪失败，请重试');
  }
}

// 用页面上的 2d 画布把照片画成 SIZE×SIZE（不是正方形就居中裁），导出 JPG
async function toSquare(canvas, src) {
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d');
  const img = canvas.createImage();
  await new Promise((ok, bad) => { img.onload = ok; img.onerror = () => bad(new Error('照片读取失败，请换一张')); img.src = src; });
  const s = Math.min(img.width, img.height);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, SIZE, SIZE);
  const r = await p(wx.canvasToTempFilePath, { canvas, x: 0, y: 0, width: SIZE, height: SIZE, destWidth: SIZE, destHeight: SIZE, fileType: 'jpg', quality: QUALITY });
  return r.tempFilePath;
}

// 上传到 avatars/<用户 ID>/，再交给云函数提交检测（检测通过后才对其他球友显示）
async function upload(filePath, uid) {
  const name = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  let fileID;
  try { fileID = (await wx.cloud.uploadFile({ cloudPath: `avatars/${uid}/${name}.jpg`, filePath })).fileID; } catch (e) {
    console.error('[照片] 上传失败', e);
    throw new Error('照片上传失败，请检查网络后重试');
  }
  const r = await require('./cloud').call('setPhoto', { fileID });
  // 服务端会把照片复制一份再检测，通过后公开的是那一份（r.pending）；旧版云函数没有就用上传的编号
  return Object.assign({}, r, { fileID: r.pending || fileID });
}

module.exports = { SIZE, clear, setPlayers, fileOf, peek, resolve, full, invalidate, subs, pick, toSquare, upload, setMine, ownSrc, syncMine, applyMine };
