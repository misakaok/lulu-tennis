// 数据读写。所有集合在控制台都设为「仅管理端可读写」：小程序端不直接访问数据库，
// 而是经云函数 tennis 的数据网关（utils/gateway.js），先校验成员资格，再按「成员可读、创建者可改」执行。
//   matches  比赛记录      players  球员 / 个人资料
//   draws    抽签          signups  报名
const { dedupe, tsOf, publicDraw, publicMatch } = require('./event');
const ID = require('./ident');
const OF = require('./official');
const GW = require('./gateway');
const db = () => GW;
// 受保护的缓存：只有最近 24 小时内确认过是正式成员才读（被移除后，下次校验会清空缓存和这个标记）
const cacheGet = (k, d) => {
  try {
    const ok = wx.getStorageSync('member_ok_at');
    if (!ok || Date.now() - ok > 24 * 3600 * 1000) return d;
    return wx.getStorageSync(k) || d;
  } catch (e) { return d; }
};
// 写本机缓存。单个 key 超过 1MB、或总量超过 10MB 时会写入失败：
// 这时删掉这个 key（宁可离线时不显示，也不显示一份过期很久的旧数据），并在控制台提示
const cacheSet = (k, v) => {
  try { wx.setStorageSync(k, v); } catch (e) {
    console.warn('[缓存] 写入本机缓存失败，已清除这一项：', k, (e && (e.errMsg || e.message)) || e);
    try { wx.removeStorageSync(k); } catch (e2) {}
  }
};
// 大块缓存（比赛、球员、活动列表）：异步写，不卡界面；只在内容变了、重新整理时才写。
// 写完时缓存已经被清空过（成员资格被取消，见 forget），就把刚写进去的删掉
function cacheSetLater(k, v) {
  if (typeof wx.setStorage !== 'function') { cacheSet(k, v); return; }
  const started = generation;
  const drop = () => { try { wx.removeStorageSync(k); } catch (e) {} };
  try {
    wx.setStorage({
      key: k, data: v,
      success: () => { if (started !== generation) drop(); },
      fail: (e) => { console.warn('[缓存] 写入本机缓存失败，已清除这一项：', k, (e && (e.errMsg || e.message)) || e); drop(); },
    });
  } catch (e) { drop(); }
}

// 循环分页取全部。每页 100 条（数据网关单次上限），每页都是一次云函数调用，页越大调用次数越少
// 不先查总数：读到不满一页就是最后一页（不到 100 条的集合只要 1 次调用）
// 结果按「集合 + 条件 + 排序」在内存里缓存 60 秒，并合并同时发起的相同请求（见 utils/memo.js）
const PAGE = 100;
const memo = require('./memo');
const keyOf = (name, orders, where) => JSON.stringify([name, orders || [], where || null]);
function fetchAll(name, orders, where) {
  return memo.get(keyOf(name, orders, where), name, () => fetchAllRaw(name, orders, where));
}
async function fetchAllRaw(name, orders, where) {
  const base = where ? db().collection(name).where(where) : db().collection(name);
  let all = [];
  for (let skip = 0; ; skip += PAGE) {
    let q = base;
    (orders || []).forEach(([field, dir]) => { q = q.orderBy(field, dir); });
    const res = await q.skip(skip).limit(PAGE).get();
    all = all.concat(res.data);
    if (res.data.length < PAGE) break;
  }
  return all;
}

// 当前用户 ID：云函数从微信登录态拿到的 openid（不能伪造），缓存在本机
let openidTask = null;
function myOpenid() {
  const cached = cacheGet('my_openid', '');
  if (cached) return Promise.resolve(cached);
  if (!openidTask) openidTask = require('./member').status().then((r) => r.uid).finally(() => { openidTask = null; });
  return openidTask;
}
// 同步版：本机记着的用户 ID（24 小时内确认过身份才有），只用来先画页面，权限一律由云端判断
const cachedOpenid = () => cacheGet('my_openid', '');

/* ---------- 比赛 ---------- */
// 活动里同一场改过比分时，旧记录不再计入战绩和水平分
// 名字按用户 ID 换成当前昵称（改昵称后历史记录跟着本人走），见 utils/ident.js
// 正式战绩的比分快照（verified 集合：所有人可读，只有云函数能写）
async function fetchVerified() {
  const list = await fetchAll('verified', []);
  const map = {};
  list.forEach((v) => { if (v._id !== OF.META_ID) map[v._id] = v; });
  return map;
}
async function getVerified(id) {
  try { return (await db().collection('verified').doc(id).get()).data || null; } catch (e) { return null; }
}

// 一次取齐比赛（已标好 official / pending）和球员资料：云函数 dataset，1 次调用。
// 数据太大（tooLarge）或云函数还是旧版本（未知操作）时返回 null，调用方改用分页读取。
// 带上次拿到的内容指纹（have）：内容没变时云函数只回 same，不用再下载和解析一遍。
// 返回的是原始结果（不复制），只在本文件里用，不能修改
const DS_COLLS = ['matches', 'players', 'verified'];
const ORD_MATCHES = [['date', 'desc'], ['createdAt', 'desc']];
const ORD_PLAYERS = [['createdAt', 'asc']];
const cleared = () => Object.assign(new Error('缓存已清除'), { code: 'CACHE_CLEARED' });
// 只有云函数是旧版本（未知操作）才退回分页读取（数据太大 tooLarge 在 datasetRaw 里直接返回 null）；
// 网络异常、不是成员（NOT_MEMBER）、缓存已清除都照常报错，不能悄悄改成分页再读一遍
const datasetFallback = (e) => { if (e && e.code !== 'CACHE_CLEARED' && /未知操作/.test(e.message || '')) return null; throw e; };
let generation = 0; // 清除受保护缓存后，不接受此前请求的整理结果
let lastDs = null; // 上一次取到的数据集（只在内存里）：{ hash, matches, players }
function datasetRaw() {
  return memo.raw('dataset', DS_COLLS, async () => {
    const started = generation;
    try {
      const r = await require('./cloud').call('dataset', lastDs ? { have: lastDs.hash } : {});
      if (started !== generation) throw cleared();
      if (r.tooLarge) { lastDs = null; return null; }
      if (r.same && lastDs && r.hash === lastDs.hash) return lastDs;
      const ds = { hash: r.hash || '', matches: r.matches || [], players: r.players || [] };
      lastDs = ds.hash ? ds : null;
      return ds;
    } catch (e) {
      if (/未知操作/.test((e && e.message) || '')) return null;
      throw e;
    }
  });
}

// 整理后的结果（正式战绩、战绩列表、球员列表）也放进内存缓存：缓存期内不重新整理、不重写本机存储。
// 数据集内容没变（指纹相同）时，过了缓存期也直接沿用上一次整理好的结果。
// 这些结果的有效期跟着原始数据走（见 utils/memo.js 的 deps）。
const DEP_KEYS = ['dataset', keyOf('matches', ORD_MATCHES), keyOf('players', ORD_PLAYERS), keyOf('verified', [])];
let kept = {}; // 名称 → { hash, value }
function derived(name, load, compute, noCopy) {
  return memo[noCopy ? 'raw' : 'get']('d:' + name, DS_COLLS, async () => {
    const started = generation;
    const src = await load();
    if (started !== generation) throw cleared();
    const k = kept[name];
    if (src.hash && k && k.hash === src.hash) return k.value;
    const value = compute(src);
    kept[name] = src.hash ? { hash: src.hash, value } : null;
    return value;
  }, DEP_KEYS);
}
// 本机缓存被清空时（utils/member.js 的 clearProtected）调用：忘掉沿用的结果，下次重新整理并写回本机
function forget() {
  require('./photo').clear(); generation++; kept = {}; drawsKept = null; lastDs = null;
  Object.keys(removedDraws).forEach((k) => delete removedDraws[k]); lastRemoved = null; // 刚删除的活动、「撤回」提示也是这个账号的
  prefetched = {}; msPrefetched = {}; // 点卡片时预先发出的活动详情 / 比赛状态请求：换了账号不能再用
  memo.invalidate(DS_COLLS.concat('draws'));
}

// 读全部比赛记录并标出状态：official 正式 / pending 日常比赛待对手确认 / invalid 不认可（见 utils/official.js）
async function loadMatches() {
  const ds = await datasetRaw().catch(datasetFallback);
  if (ds) return { hash: ds.hash, tagged: ds.matches, players: await playersBuilt() };
  const [raw, players, verified] = await Promise.all([
    fetchAll('matches', ORD_MATCHES),
    playersBuilt().catch(() => cachedPlayersFull()),
    fetchVerified().catch((e) => { console.error('读取 verified 集合失败，请确认已创建（所有用户可读）', e); return null; }),
  ]);
  // verified 集合还没建：先按旧规则全部计入，避免历史战绩突然消失（README 有配置说明）
  const tagged = raw.map((m) => Object.assign({}, m, { status: verified ? OF.statusOf(m, verified) : 'official' }));
  return { hash: '', tagged, players };
}

// 比赛记录整理一次，同时得到两份列表（同一批对象）：
//   official 正式战绩：战绩统计、排名、水平分、签表晋级都只用这些
//   all      战绩列表用：正式战绩 + 待对手确认的日常比赛（标 pending，不计入任何统计），按日期从新到旧
// 本机只缓存 all 一份（cachedMatches 从里面去掉待确认的），内容变了才异步写
const matchLists = () => derived('matches', loadMatches, ({ tagged, players }) => {
  const official = ID.normalizeMatches(dedupe(tagged.filter((m) => m.status === 'official')).map(publicMatch), players);
  const pending = ID.normalizeMatches(tagged.filter((m) => m.status === 'pending').map(publicMatch), players);
  const all = official.concat(pending).sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')) || (tsOf(y) - tsOf(x)));
  cacheSetLater('cache_matches_all', all);
  try { wx.removeStorageSync('cache_matches'); } catch (e) {} // 以前单独存的正式战绩（和 all 重复）
  return { official, all };
}, true);
// 复制一份给调用方（可以随便改）
const fetchMatches = () => matchLists().then((r) => memo.clone(r.official));
const fetchMatchesAll = () => matchLists().then((r) => memo.clone(r.all));
// 共享的原始结果（不复制）：只读的页面用，不能修改。数据没变时返回的是同一个数组，
// 页面可以直接比较引用（===）判断要不要重算，不用把全部数据序列化一遍
const matchesShared = () => matchLists().then((r) => r.official);
const matchesAllShared = () => matchLists().then((r) => r.all);
const cachedMatchesAll = () => cacheGet('cache_matches_all', []).map(publicMatch);
const cachedMatches = () => cacheGet('cache_matches_all', []).filter((m) => m.status !== 'pending').map(publicMatch);
// 同上，但本机还没有缓存（第一次打开、24 小时没确认过身份）时返回 null：用来区分「确实没有比赛」和「还不知道」
const cachedMatchesOrNull = () => { const a = cacheGet('cache_matches_all', null); return a ? a.filter((m) => m.status !== 'pending').map(publicMatch) : null; };

function addMatch(data) {
  return db().collection('matches').add({ data: Object.assign({}, data, { createdAt: db().serverDate() }) });
}
// 撤销 / 删除比赛：一律经云函数 revokeMatch（校验确认状态、对后续场次的影响，并留档）。
// 返回 { needReason: true, impact } 时，需要填写原因（和确认影响）后带上再调一次
function removeMatch(id, extra) {
  return require('./cloud').call('revokeMatch', Object.assign({ matchId: id }, extra || {}));
}

/* ---------- 球员 / 个人资料 ---------- */
// 球员列表：本人设置的资料（self: true）带用户 ID（uid = _openid）。
// 同名只显示一条；如果有两个账号用了同一个昵称，这个名字不绑定任何 ID（ambiguous），避免冒用。
async function playerDocs() {
  const ds = await datasetRaw().catch(datasetFallback);
  return { hash: ds ? ds.hash : '', docs: ds ? ds.players : await fetchAll('players', ORD_PLAYERS) };
}
const fetchPlayersFull = () => derived('players', playerDocs, (src) => buildPlayers(src.docs));
const playersBuilt = () => derived('players', playerDocs, (src) => buildPlayers(src.docs), true); // 不复制，不能修改
const playersShared = playersBuilt; // 只读的页面用：数据没变时是同一个数组（同 matchesShared）
// 按用户 ID 的本人资料（和 cachedProfiles 同样内容）：跟着 buildPlayers 的结果走，不用再读本机存储
const profilesByList = new WeakMap();
const profilesOf = (players) => profilesByList.get(players) || cachedProfiles();
function buildPlayers(list) {
  // 按用户 ID 的本人资料（每个账号取最早那条）：球员主页按 ID 找人，不受同名影响
  const byUid = {};
  list.forEach((p) => {
    if (!p.self || !p._openid || !p.name || byUid[p._openid]) return;
    byUid[p._openid] = { uid: p._openid, name: p.name, gender: p.gender || '', photo: p.photo || '', level: typeof p.level === 'number' ? p.level : null, formerNames: p.formerNames || [], shown: p.shown === true, shownVer: p.shown === true ? (p.shownVer || 1) : 0 };
  });
  cacheSetLater('cache_profiles', byUid);
  const map = {}, order = [];
  list.forEach((p) => {
    if (!p.name) return;
    const cur = map[p.name];
    const item = {
      name: p.name, level: typeof p.level === 'number' ? p.level : null, gender: p.gender || '',
      self: !!p.self, uid: p.self ? p._openid || '' : '', formerNames: p.self ? p.formerNames || [] : [], photo: p.self ? p.photo || '' : '',
      shown: !!p.self && p.shown === true, // 本人同意公开展示（排行榜只显示这些人）
    };
    if (!cur) { map[p.name] = item; order.push(p.name); }
    else if (item.self && cur.self && item.uid !== cur.uid) { cur.uid = ''; cur.ambiguous = true; }
    else if (item.self && !cur.self) map[p.name] = item;
  });
  const arr = order.map((n) => map[n]);
  cacheSetLater('cache_players_full', arr);
  profilesByList.set(arr, byUid);
  require('./photo').setPlayers(arr, byUid); // 头像组件按用户 ID / 名字找照片
  return arr;
}
const cachedPlayersFull = () => cacheGet('cache_players_full', []);
const cachedProfiles = () => cacheGet('cache_profiles', {});

// 我的资料记录（正常只有一条；万一因为网络重试多出几条，取最早的那条）
async function myProfileDocs() {
  const me = await myOpenid();
  const res = await db().collection('players').where({ _openid: me, self: true }).get();
  return res.data.sort((a, b) => tsOf(a) - tsOf(b));
}

async function getMyProfile() {
  const p = (await myProfileDocs())[0] || null;
  cacheSet('my_profile', p || '');
  return p;
}
const cachedProfile = () => cacheGet('my_profile', null) || null;

// 保存个人资料：经云函数 saveProfile（服务端检查昵称不和别人重复）。
// 照片另走 utils/photo.js → 云函数 setPhoto（要过图片检测）；以前传过的旧照片 avatar（没经过检测、不再显示）原样带回去，不清掉数据库里的旧值
// shown：公开展示授权（第一次设置资料必须为 true；不传就不改）
async function saveMyProfile({ name, avatar, level, gender, shown }) {
  // shownVer：同意时用户看到的是第几版授权说明（资料页、弹窗用的都是 utils/consent.js 的最新说明）
  await require('./cloud').call('saveProfile', { name, avatar: /^cloud:\/\//.test(avatar || '') ? avatar : '', level, gender, shown, shownVer: shown === true ? require('./consent').VER : undefined });
  return getMyProfile();
}
// 公开展示授权：开启 / 关闭（启动时的授权弹窗、资料页上传照片前）
async function setShown(on) {
  const r = await require('./cloud').call('setShown', { on: !!on, ver: require('./consent').VER });
  const p = cachedProfile();
  if (p) cacheSet('my_profile', Object.assign({}, p, { shown: r.shown, shownVer: r.shownVer !== undefined ? r.shownVer : (r.shown ? (p.shownVer || 1) : 0) }));
  return r.shown;
}

/* ---------- 抽签 ---------- */
// 活动列表：原始记录 60 秒内存缓存（fetchAll）；过期重新读到的内容没变，就沿用上一次整理好的同一个数组，也不重写本机缓存
const ORD_DRAWS = [['createdAt', 'desc']];
let drawsKept = null; // { sig, value }
const drawsShared = () => memo.raw('d:draws', 'draws', async () => {
  const started = generation;
  const raw = await memo.raw(keyOf('draws', ORD_DRAWS), 'draws', () => fetchAllRaw('draws', ORD_DRAWS));
  if (started !== generation) throw cleared();
  const sig = JSON.stringify(raw);
  if (drawsKept && drawsKept.sig === sig) return drawsKept.value;
  const value = raw.map(publicDraw);
  drawsKept = { sig, value };
  cacheSetLater('cache_draws', value);
  return value;
}, [keyOf('draws', ORD_DRAWS)]);
const fetchDraws = () => drawsShared().then(memo.clone);
const cachedDraws = () => cacheGet('cache_draws', []).map(publicDraw);

async function getMatch(id) {
  try { return publicMatch((await db().collection('matches').doc(id).get()).data) || null; } catch (e) { return null; }
}
async function getDraw(id) { return publicDraw((await db().collection('draws').doc(id).get()).data); }
// 活动详情页一次取齐：活动、报名名单、我的资料、退赛申请（云函数 drawDetail，1 次调用）。
// 云函数还是旧版本（未知操作）时返回 null，页面改用原来的分开读取
// 点活动卡片时先发出去（利用页面切换动画的时间），活动详情 load 第一次读取时接过这个请求，不再另发。
// 只接一次（之后的刷新、下拉照常发新请求）；期间有过写操作 / 清缓存（epoch 变了）或超过 PREFETCH_MS 没被接走的不用
const PREFETCH_MS = 10 * 1000;
let prefetched = {};
function prefetchDrawDetail(id) {
  if (!id) return;
  const cur = prefetched[id];
  if (cur && cur.epoch === memo.epoch() && Date.now() - cur.at < PREFETCH_MS) return; // 双击卡片：已经在读，不再发一次
  const task = fetchDrawDetailNow(id);
  task.catch(() => {}); // 失败不提示：详情页接过来时自己处理
  prefetched[id] = { epoch: memo.epoch(), at: Date.now(), task };
}
function fetchDrawDetail(id) {
  const p = prefetched[id];
  delete prefetched[id];
  if (p && p.epoch === memo.epoch() && Date.now() - p.at < PREFETCH_MS) return p.task;
  return fetchDrawDetailNow(id);
}
// 比赛详情的 matchState（detail：比赛记录、状态、确认情况、修改记录）：和活动详情一样，点比赛卡片时先发出去，
// 比赛详情 load 第一次读取接过来（只接一次；期间有写操作 / 清缓存或超过 PREFETCH_MS 的不用；连点两次只发一次）
let msPrefetched = {};
const matchStateNow = (id) => require('./cloud').call('matchState', { matchId: id, detail: true });
function prefetchMatchState(id) {
  if (!id) return;
  const cur = msPrefetched[id];
  if (cur && cur.epoch === memo.epoch() && Date.now() - cur.at < PREFETCH_MS) return;
  const task = matchStateNow(id);
  task.catch(() => {}); // 失败不提示：详情页接过来时自己处理
  msPrefetched[id] = { epoch: memo.epoch(), at: Date.now(), task };
}
function fetchMatchState(id) {
  const p = msPrefetched[id];
  delete msPrefetched[id];
  if (p && p.epoch === memo.epoch() && Date.now() - p.at < PREFETCH_MS) return p.task;
  return matchStateNow(id);
}
async function fetchDrawDetailNow(id) {
  let r;
  const started = generation, since = memo.epoch();
  try { r = await require('./cloud').call('drawDetail', { drawId: id }); } catch (e) {
    if (/未知操作/.test((e && e.message) || '')) return null;
    throw e;
  }
  if (started !== generation) throw cleared(); // 读的时候退出了成员身份：不把资料写回本机
  if (since === memo.epoch()) cacheSet('my_profile', r.profile || ''); // 期间有过写操作（如刚改完资料）：不让旧结果盖掉本机资料
  r.draw = publicDraw(r.draw);
  // 录分页先用它画出来（只在内存、60 秒，任何写操作、下拉刷新都作废）；读的过程中有过写操作的不放，免得旧结果盖掉
  if (memo.put(detailKey(id), memo.ANY, r, since)) keepSignups(id, r.signups);
  return memo.clone(r);
}
// 最近打开过的活动的报名名单（本机，受保护缓存：退出成员身份时清掉）：再打开活动详情时先显示上次的名单和人数，
// 云端读完再更正；报名 / 取消这些按钮仍要等云端读完（ready）。最多记 SIGNUPS_KEEP 个活动
const SIGNUPS_KEY = 'cache_draw_signups', SIGNUPS_KEEP = 10;
function keepSignups(id, list) {
  if (!id || !Array.isArray(list)) return;
  const all = Object.assign({}, cacheGet(SIGNUPS_KEY, {}));
  const n = Object.keys(all).reduce((m, k) => Math.max(m, (all[k] && all[k].n) || 0), 0) + 1; // 先后顺序（同一毫秒也分得清）
  all[id] = { n, list };
  const ids = Object.keys(all).sort((a, b) => ((all[b] && all[b].n) || 0) - ((all[a] && all[a].n) || 0));
  ids.slice(SIGNUPS_KEEP).forEach((k) => delete all[k]);
  cacheSetLater(SIGNUPS_KEY, all);
}
function cachedDrawSignups(id) {
  const x = cacheGet(SIGNUPS_KEY, {})[id];
  return x && Array.isArray(x.list) ? x.list : null;
}
const detailKey = (id) => 'drawDetail:' + id;
// 活动详情最近一次读到的结果（复制版）：从活动详情点进录分页时先用它显示，云端读完再更正；没有 / 过期返回 null
function peekDrawDetail(id) {
  const v = memo.peek(detailKey(id));
  return v ? memo.clone(v) : null;
}

// 活动的写入都经云函数（服务端逐个字段校验；只有发起人能改）
const cloudCall = (action, data) => require('./cloud').call(action, data);
// 创建球友活动：只有设置 → 开放报名；带 entrants / lines / groups → 直接生成签表。返回活动 ID
// 返回 { id, placeDropped }：placeDropped = 地点名称没通过内容检测，只保存了地图位置
async function addDraw(data) { const r = await cloudCall('createDraw', { draw: data }); return { id: r.id, placeDropped: !!r.placeDropped }; }
// 报名截止后生成签表（已经录分或登记过退赛的不能重新生成）
async function generateDraw(id, data, manual) {
  const payload = { drawId: id, draw: data };
  if (manual) payload.manual = true;
  await cloudCall('generateDraw', payload);
}
async function updateDrawSettings(id, settings, settingsVersion) { await cloudCall('updateDrawSettings', { drawId: id, settings, settingsVersion }); }
// 编辑活动信息：手动名称、日期、开始时间、场地编号、定位；公开文字先经云端检测
async function updateDrawInfo(id, info) { const r = await cloudCall('updateDrawInfo', { drawId: id, info }); return { placeDropped: !!(r && r.placeDropped) }; }
// 删除活动（软删除：签表不再显示，已录比分保留在战绩里）。管理员删除别人的活动要带原因
// 删除成功后记下来：返回活动列表时先把它从手上的列表里去掉，不用等重新读取（云端也不会再返回它）
const removedDraws = {};
let lastRemoved = null; // 最近一次删除：{ id, title, at }，活动首页据此显示「撤回」
async function removeDraw(id, reason, title) {
  await cloudCall('removeDraw', { drawId: id, reason: reason || '' });
  removedDraws[id] = 1;
  lastRemoved = { id, title: title || '', at: Date.now() };
  cacheSetLater('cache_draws', cachedDraws().filter((d) => d._id !== id));
}
// 刚删除的活动（UNDO_MS 内、还没撤回 / 关掉）：活动首页顶部显示「已删除 · 撤回」
const UNDO_MS = 5 * 60 * 1000;
function recentRemoved() {
  if (lastRemoved && Date.now() - lastRemoved.at > UNDO_MS) lastRemoved = null;
  return lastRemoved;
}
function dismissRemoved() { lastRemoved = null; }
// 置顶 / 取消置顶（管理员）
async function pinDraw(id, pinned) { await cloudCall('pinDraw', { drawId: id, pinned: !!pinned }); }
// 提前结束 / 恢复活动（发起人或管理员）
async function closeDraw(id, closed, reason) { return cloudCall('closeDraw', { drawId: id, closed: !!closed, reason: reason || '' }); }
// 撤回删除：成功后不再从列表里去掉它，重新读取就能看到
async function restoreDraw(id) {
  await cloudCall('restoreDraw', { drawId: id });
  delete removedDraws[id];
  if (lastRemoved && lastRemoved.id === id) lastRemoved = null;
}
// 去掉本次刚删除的活动；没有要去掉的就原样返回同一个数组（页面按引用判断要不要重算）
function withoutRemoved(list) {
  return (list || []).some((d) => removedDraws[d._id]) ? list.filter((d) => !removedDraws[d._id]) : list;
}
// 单场安排（发起人）：这一场的日期、时间、场地；三项都空 = 清除。返回 { slot }
function setFixtureSlot(id, key, slot) { return cloudCall('setFixtureSlot', { drawId: id, key, slot }); }

/* ---------- 报名 ---------- */
async function fetchSignups(drawId) {
  const since = memo.epoch();
  const list = await fetchAll('signups', [['createdAt', 'asc']], { drawId });
  if (since === memo.epoch()) keepSignups(drawId, list); // 报名 / 取消后重新读到的名单也记下来
  return list;
}

// 我报过名的活动（自己报的，或被搭档带上的）：活动页「我的活动」和活动详情首帧预判报名按钮用
// 云函数 mySignups 1 次调用；云函数还是旧版本（未知操作）时分开读；同步缓存一份到本机受保护存储（退出成员身份自动清掉）
const MY_SIGNUPS_KEY = 'cache_my_signups';
async function fetchMySignups() {
  const me = await myOpenid();
  return memo.get('mySignups:' + me, 'signups', async () => {
    const started = generation;
    let list;
    try { list = (await require('./cloud').call('mySignups')).list || []; } catch (e) {
      if (!/未知操作/.test((e && e.message) || '')) throw e;
      const [own, asPartner] = await Promise.all([fetchAll('signups', [], { _openid: me }), fetchAll('signups', [], { partnerId: me })]);
      list = own.concat(asPartner);
    }
    if (started === generation) cacheSetLater(MY_SIGNUPS_KEY, { uid: me, list });
    return list;
  });
}
function cachedMySignups() {
  const me = cachedOpenid();
  if (!me) return null;
  const hit = memo.peek('mySignups:' + me);
  if (Array.isArray(hit)) return hit;
  const c = cacheGet(MY_SIGNUPS_KEY, null);
  return c && c.uid === me && Array.isArray(c.list) ? c.list : null;
}

async function mySignup(drawId) {
  const me = await myOpenid();
  const res = await db().collection('signups').where({ drawId, _openid: me }).limit(1).get();
  return res.data[0] || null;
}
// 报名经云函数 signUp：参赛名取本人当前资料，搭档只传用户 ID，由服务端校验（partner 为空表示还没有搭档，由发起人配对）
async function signUp(drawId, partner) {
  const r = await require('./cloud').call('signUp', { drawId, partnerId: (partner && partner.uid) || '' });
  try { wx.removeStorageSync(MY_SIGNUPS_KEY); } catch (e) {}
  return r;
}
async function cancelSignup(drawId) {
  await require('./cloud').call('cancelSignup', { drawId });
  try { wx.removeStorageSync(MY_SIGNUPS_KEY); } catch (e) {}
}

module.exports = {
  myOpenid,
  fetchMatches, cachedMatches, cachedMatchesOrNull, fetchMatchesAll, cachedMatchesAll, matchesShared, matchesAllShared, playersShared, profilesOf, drawsShared, fetchVerified, getVerified, addMatch, removeMatch, getMatch,
  fetchPlayersFull, cachedPlayersFull, cachedProfiles,
  getMyProfile, cachedProfile, cachedOpenid, saveMyProfile, setShown,
  fetchDraws, cachedDraws, getDraw, fetchDrawDetail, prefetchDrawDetail, peekDrawDetail, prefetchMatchState, fetchMatchState, cachedDrawSignups, forget, addDraw, generateDraw, updateDrawInfo, updateDrawSettings, removeDraw, restoreDraw, pinDraw, closeDraw, recentRemoved, dismissRemoved, withoutRemoved, setFixtureSlot,
  fetchSignups, fetchMySignups, cachedMySignups, mySignup, signUp, cancelSignup,
};
