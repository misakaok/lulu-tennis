// 数据读写。所有集合在控制台都设为「仅管理端可读写」：小程序端不直接访问数据库，
// 而是经云函数 tennis 的数据网关（utils/gateway.js），先校验成员资格，再按「成员可读、创建者可改」执行。
//   matches  比赛记录      players  球员 / 个人资料
//   draws    抽签          signups  报名
const { dedupe, tsOf } = require('./event');
const { rememberEnv, isCloud } = require('./avatar');
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

// 当前用户的 openid。
// 不用 '{openid}' 占位符：它只在「自定义安全规则」下会被替换，
// 在「所有用户可读，仅创建者可读写」这种基础权限下查不到任何东西。
// 做法：写一条临时记录，读回它的 _openid（系统自动写入的创建者），再删掉；结果缓存在本机。
// 当前用户 ID：云函数从微信登录态拿到的 openid（不能伪造），缓存在本机
let openidTask = null;
function myOpenid() {
  const cached = cacheGet('my_openid', '');
  if (cached) return Promise.resolve(cached);
  if (!openidTask) openidTask = require('./member').status().then((r) => r.uid).finally(() => { openidTask = null; });
  return openidTask;
}

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
const datasetFallback = (e) => { if (e.code === 'CACHE_CLEARED') throw e; return null; };
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
function forget() { generation++; kept = {}; lastDs = null; memo.invalidate(DS_COLLS); }

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

// 正式战绩：战绩统计、排名、水平分、签表晋级、互评都只用这些
function fetchMatches() {
  return derived('matches', loadMatches, ({ tagged, players }) => {
    const list = ID.normalizeMatches(dedupe(tagged.filter((m) => m.status === 'official')), players);
    cacheSet('cache_matches', list);
    return list;
  });
}
const cachedMatches = () => cacheGet('cache_matches', []);

// 战绩列表用：正式战绩 + 待对手确认的日常比赛（标 pending，不计入任何统计）
function fetchMatchesAll() {
  return derived('matchesAll', loadMatches, ({ tagged, players }) => {
    const official = dedupe(tagged.filter((m) => m.status === 'official'));
    const pending = tagged.filter((m) => m.status === 'pending');
    const list = ID.normalizeMatches(official.concat(pending), players)
      .sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')) || (tsOf(y) - tsOf(x)));
    cacheSet('cache_matches_all', list);
    return list;
  });
}
const cachedMatchesAll = () => cacheGet('cache_matches_all', []);

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
const playersBuilt = () => derived('players', playerDocs, (src) => buildPlayers(src.docs), true); // 本文件内部用：不复制，不能修改
function buildPlayers(list) {
  // 按用户 ID 的本人资料（每个账号取最早那条）：球员主页按 ID 找人，不受同名影响
  const byUid = {};
  list.forEach((p) => {
    if (!p.self || !p._openid || !p.name || byUid[p._openid]) return;
    byUid[p._openid] = { uid: p._openid, name: p.name, avatar: p.avatar || '', gender: p.gender || '', level: typeof p.level === 'number' ? p.level : null, formerNames: p.formerNames || [] };
  });
  cacheSet('cache_profiles', byUid);
  const map = {}, order = [];
  list.forEach((p) => {
    if (!p.name) return;
    const cur = map[p.name];
    const item = {
      name: p.name, avatar: p.avatar || '', level: typeof p.level === 'number' ? p.level : null, gender: p.gender || '',
      self: !!p.self, uid: p.self ? p._openid || '' : '', formerNames: p.self ? p.formerNames || [] : [],
    };
    if (!cur) { map[p.name] = item; order.push(p.name); }
    else if (item.self && cur.self && item.uid !== cur.uid) { cur.uid = ''; cur.ambiguous = true; }
    else if (item.self && !cur.self) map[p.name] = item;
    else if (!cur.avatar && item.avatar) cur.avatar = item.avatar;
  });
  const arr = order.map((n) => map[n]);
  cacheSet('cache_players_full', arr);
  cacheSet('cache_players', order);
  return arr;
}
const cachedPlayersFull = () => cacheGet('cache_players_full', []);
const cachedProfiles = () => cacheGet('cache_profiles', {});

async function fetchPlayers() { return (await fetchPlayersFull()).map((p) => p.name); }
const cachedPlayers = () => cacheGet('cache_players', []);

async function addPlayer(name) {
  const col = db().collection('players');
  const { total } = await col.where({ name }).count();
  if (total === 0) await col.add({ data: { name, createdAt: db().serverDate() } });
}

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

// 上传头像（选图、裁剪得到的是临时文件，要传到云存储，别人才能看到）
async function uploadAvatar(tempPath) {
  const ext = (tempPath.match(/\.(\w+)$/) || [])[1] || 'jpg';
  const res = await wx.cloud.uploadFile({
    // 放在 avatars/<本人用户 ID>/ 下：一看路径就知道是谁的照片；读写权限由云存储安全规则控制（见 README）
    cloudPath: `avatars/${await myOpenid()}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`,
    filePath: tempPath,
  });
  rememberEnv(res.fileID); // 记下当前云环境，头像诊断时用来比对
  return res.fileID; // 数据库只存 fileID，显示时再换临时链接（见 utils/avatar.js）
}

// 保存个人资料：经云函数 saveProfile（服务端检查昵称不和别人重复、照片在本人目录下）
async function saveMyProfile({ name, avatar, avatarTemp, level, gender }) {
  // 只把云文件 fileID 存进数据库：本地临时路径先上传；HTTPS 临时链接会过期，绝不保存
  if (!avatarTemp && avatar && !isCloud(avatar) && /^(wxfile:|http:\/\/tmp)/.test(avatar)) avatarTemp = avatar;
  const fileID = avatarTemp ? await uploadAvatar(avatarTemp) : (isCloud(avatar) ? avatar : '');
  await require('./cloud').call('saveProfile', { name, avatar: fileID || '', level, gender });
  return getMyProfile();
}

/* ---------- 抽签 ---------- */
async function fetchDraws() {
  const list = await fetchAll('draws', [['createdAt', 'desc']]);
  cacheSet('cache_draws', list);
  return list;
}
const cachedDraws = () => cacheGet('cache_draws', []);

async function getMatch(id) {
  try { return (await db().collection('matches').doc(id).get()).data || null; } catch (e) { return null; }
}
async function getDraw(id) { return (await db().collection('draws').doc(id).get()).data; }
// 活动详情页一次取齐：活动、报名名单、我的资料、联系人、相册数量、退赛申请（云函数 drawDetail，1 次调用）。
// 云函数还是旧版本（未知操作）时返回 null，页面改用原来的分开读取
async function fetchDrawDetail(id) {
  let r;
  try { r = await require('./cloud').call('drawDetail', { drawId: id }); } catch (e) {
    if (/未知操作/.test((e && e.message) || '')) return null;
    throw e;
  }
  cacheSet('my_profile', r.profile || '');
  return r;
}

// 活动的写入都经云函数（服务端逐个字段校验；只有发起人能改）
const cloudCall = (action, data) => require('./cloud').call(action, data);
// 创建球友活动：只有设置 → 开放报名；带 entrants / lines / groups → 直接生成签表。返回活动 ID
async function addDraw(data) { return (await cloudCall('createDraw', { draw: data })).id; }
// 报名截止后生成签表（已经录分或登记过退赛的不能重新生成）
async function generateDraw(id, data) { await cloudCall('generateDraw', { drawId: id, draw: data }); }
// 编辑活动信息：名称、日期、开始时间、场地、定位
async function updateDrawInfo(id, info) { await cloudCall('updateDrawInfo', { drawId: id, info }); }
// 删除活动（软删除：签表不再显示，已录比分保留在战绩里）。管理员删除别人的活动要带原因
async function removeDraw(id, reason) { await cloudCall('removeDraw', { drawId: id, reason: reason || '' }); }
// 单场安排（发起人）：这一场的日期、时间、场地；三项都空 = 清除。返回 { slot }
function setFixtureSlot(id, key, slot) { return cloudCall('setFixtureSlot', { drawId: id, key, slot }); }

/* ---------- 报名 ---------- */
function fetchSignups(drawId) { return fetchAll('signups', [['createdAt', 'asc']], { drawId }); }

// 我报过名的活动（自己报的，或被搭档带上的）：活动页「我的活动」用
// 云函数 mySignups 1 次调用；云函数还是旧版本（未知操作）时分开读
async function fetchMySignups() {
  const me = await myOpenid();
  return memo.get('mySignups:' + me, 'signups', async () => {
    try { return (await require('./cloud').call('mySignups')).list || []; } catch (e) {
      if (!/未知操作/.test((e && e.message) || '')) throw e;
    }
    const [own, asPartner] = await Promise.all([fetchAll('signups', [], { _openid: me }), fetchAll('signups', [], { partnerId: me })]);
    return own.concat(asPartner);
  });
}

async function mySignup(drawId) {
  const me = await myOpenid();
  const res = await db().collection('signups').where({ drawId, _openid: me }).limit(1).get();
  return res.data[0] || null;
}
// 报名经云函数 signUp：参赛名取本人当前资料，搭档只传用户 ID，由服务端校验（partner 为空表示还没有搭档，由发起人配对）
async function signUp(drawId, partner) {
  await require('./cloud').call('signUp', { drawId, partnerId: (partner && partner.uid) || '' });
}
async function cancelSignup(drawId) {
  await require('./cloud').call('cancelSignup', { drawId });
}

module.exports = {
  myOpenid,
  fetchMatches, cachedMatches, fetchMatchesAll, cachedMatchesAll, fetchVerified, getVerified, addMatch, removeMatch, getMatch,
  fetchPlayersFull, cachedPlayersFull, cachedProfiles, fetchPlayers, cachedPlayers, addPlayer,
  getMyProfile, cachedProfile, saveMyProfile,
  fetchDraws, cachedDraws, getDraw, fetchDrawDetail, forget, addDraw, generateDraw, updateDrawInfo, removeDraw, setFixtureSlot,
  fetchSignups, fetchMySignups, mySignup, signUp, cancelSignup,
};
