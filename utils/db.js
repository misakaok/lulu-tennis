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
const cacheSet = (k, v) => { try { wx.setStorageSync(k, v); } catch (e) {} };

// 小程序端每次最多取 20 条，这里循环分页取全部
async function fetchAll(name, orders, where) {
  const base = where ? db().collection(name).where(where) : db().collection(name);
  const { total } = await base.count();
  let all = [];
  for (let skip = 0; skip < total; skip += 20) {
    let q = base;
    (orders || []).forEach(([field, dir]) => { q = q.orderBy(field, dir); });
    const res = await q.skip(skip).limit(20).get();
    all = all.concat(res.data);
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

// 当前用户是不是这条记录的创建者
async function isMine(collection, id) {
  const [me, res] = await Promise.all([myOpenid(), db().collection(collection).doc(id).get()]);
  return !!res.data && res.data._openid === me;
}

/* ---------- 比赛 ---------- */
// 赛事里同一场改过比分时，旧记录不再计入战绩和水平分
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

// 读全部比赛记录并标出状态：official 正式 / pending 日常比赛待对手确认 / invalid 不认可（见 utils/official.js）
async function loadMatches() {
  const [raw, players, verified] = await Promise.all([
    fetchAll('matches', [['date', 'desc'], ['createdAt', 'desc']]),
    fetchPlayersFull().catch(() => cachedPlayersFull()),
    fetchVerified().catch((e) => { console.error('读取 verified 集合失败，请确认已创建（所有用户可读）', e); return null; }),
  ]);
  // verified 集合还没建：先按旧规则全部计入，避免历史战绩突然消失（README 有配置说明）
  const tagged = raw.map((m) => Object.assign({}, m, { status: verified ? OF.statusOf(m, verified) : 'official' }));
  return { tagged, players };
}

// 正式战绩：战绩统计、排名、水平分、签表晋级、互评都只用这些
async function fetchMatches() {
  const { tagged, players } = await loadMatches();
  const list = ID.normalizeMatches(dedupe(tagged.filter((m) => m.status === 'official')), players);
  cacheSet('cache_matches', list);
  return list;
}
const cachedMatches = () => cacheGet('cache_matches', []);

// 战绩列表用：正式战绩 + 待对手确认的日常比赛（标 pending，不计入任何统计）
async function fetchMatchesAll() {
  const { tagged, players } = await loadMatches();
  const official = dedupe(tagged.filter((m) => m.status === 'official'));
  const pending = tagged.filter((m) => m.status === 'pending');
  const list = ID.normalizeMatches(official.concat(pending), players)
    .sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')) || (tsOf(y) - tsOf(x)));
  cacheSet('cache_matches_all', list);
  return list;
}
const cachedMatchesAll = () => cacheGet('cache_matches_all', []);

function addMatch(data) {
  return db().collection('matches').add({ data: Object.assign({}, data, { createdAt: db().serverDate() }) });
}
async function removeMatch(id) {
  const res = await db().collection('matches').doc(id).remove();
  return !!(res.stats && res.stats.removed);
}

/* ---------- 球员 / 个人资料 ---------- */
// 球员列表：本人设置的资料（self: true）带用户 ID（uid = _openid）。
// 同名只显示一条；如果有两个账号用了同一个昵称，这个名字不绑定任何 ID（ambiguous），避免冒用。
async function fetchPlayersFull() {
  const list = await fetchAll('players', [['createdAt', 'asc']]);
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

// 上传头像（chooseAvatar 得到的是临时文件，要传到云存储，别人才能看到）
async function uploadAvatar(tempPath) {
  const ext = (tempPath.match(/\.(\w+)$/) || [])[1] || 'jpg';
  const res = await wx.cloud.uploadFile({
    // 放在 avatars/<本人用户 ID>/ 下：一看路径就知道是谁的照片；读写权限由云存储安全规则控制（见 README）
    cloudPath: `avatars/${await myOpenid().catch(() => 'unknown')}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`,
    filePath: tempPath,
  });
  rememberEnv(res.fileID); // 记下当前云环境，头像诊断时用来比对
  return res.fileID; // 数据库只存 fileID，显示时再换临时链接（见 utils/avatar.js）
}

// 保存个人资料：昵称不能和别的球友重复
// 只拦「别人」用过的昵称：按创建者（_openid）判断，自己的旧记录不算重名
async function saveMyProfile({ name, avatar, avatarTemp, level, gender }) {
  const col = db().collection('players');
  const [me, docs, same, former] = await Promise.all([
    myOpenid(), myProfileDocs(), col.where({ name, self: true }).get(), col.where({ formerNames: name, self: true }).get(),
  ]);
  if (same.data.some((p) => p._openid !== me)) throw new Error('这个昵称已经被其他球友使用了，换一个吧');
  if (former.data.some((p) => p._openid !== me)) throw new Error('这个昵称是其他球友以前用过的，为避免混淆请换一个');
  // 只把云文件 fileID 存进数据库：本地临时路径先上传；HTTPS 临时链接会过期，绝不保存
  if (!avatarTemp && avatar && !isCloud(avatar) && /^(wxfile:|http:\/\/tmp)/.test(avatar)) avatarTemp = avatar;
  const fileID = avatarTemp ? await uploadAvatar(avatarTemp) : (isCloud(avatar) ? avatar : '');
  const data = { name, avatar: fileID || '', level, gender: gender === 'm' || gender === 'f' ? gender : '' };
  const mine = docs[0];
  if (mine) {
    // 改名：旧昵称记进 formerNames，留给本人（历史记录按用户 ID 跟着走，昵称只是展示）
    if (mine.name && mine.name !== name) {
      const fn = (mine.formerNames || []).filter((n) => n !== name);
      if (fn.indexOf(mine.name) < 0) fn.push(mine.name);
      data.formerNames = fn.slice(-10);
    }
    await col.doc(mine._id).update({ data });
    docs.slice(1).forEach((d) => col.doc(d._id).remove().catch(() => {})); // 清掉多出来的重复资料
  } else await col.add({ data: Object.assign({ self: true, createdAt: db().serverDate() }, data) });
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

async function addDraw(data) {
  const res = await db().collection('draws').add({ data: Object.assign({}, data, { createdAt: db().serverDate() }) });
  return res._id;
}
// 只有创建者能改，别人改会返回 false
async function updateDraw(id, data) {
  const res = await db().collection('draws').doc(id).update({ data });
  return !!(res.stats && res.stats.updated);
}
async function updateDrawResults(id, results) {
  return updateDraw(id, { results: db().command.set(results) });
}
// 整体替换一个对象字段（普通 update 会和旧对象合并）
const cmdSet = (v) => db().command.set(v);
async function removeDraw(id) {
  const res = await db().collection('draws').doc(id).remove();
  return !!(res.stats && res.stats.removed);
}

/* ---------- 报名 ---------- */
function fetchSignups(drawId) { return fetchAll('signups', [['createdAt', 'asc']], { drawId }); }

// 我报过名的赛事（自己报的，或被搭档带上的）：赛事页「我的赛事」用
async function fetchMySignups() {
  const me = await myOpenid();
  const [own, asPartner] = await Promise.all([fetchAll('signups', [], { _openid: me }), fetchAll('signups', [], { partnerId: me })]);
  return own.concat(asPartner);
}

async function mySignup(drawId) {
  const me = await myOpenid();
  const res = await db().collection('signups').where({ drawId, _openid: me }).limit(1).get();
  return res.data[0] || null;
}
// 双打报名时可以带上搭档（partner 为空表示还没有搭档，由发起人配对）
async function signUp(drawId, profile, partner) {
  if (await mySignup(drawId)) return;
  await db().collection('signups').add({
    data: {
      drawId, name: profile.name, avatar: profile.avatar || '', level: profile.level || null,
      partner: (partner && partner.name) || '', partnerId: (partner && partner.uid) || '', partnerAvatar: (partner && partner.avatar) || '',
      createdAt: db().serverDate(),
    },
  });
}
async function cancelSignup(drawId) {
  const s = await mySignup(drawId);
  if (s) await db().collection('signups').doc(s._id).remove();
}

module.exports = {
  myOpenid, isMine,
  fetchMatches, cachedMatches, fetchMatchesAll, cachedMatchesAll, fetchVerified, getVerified, addMatch, removeMatch, getMatch,
  fetchPlayersFull, cachedPlayersFull, cachedProfiles, fetchPlayers, cachedPlayers, addPlayer,
  getMyProfile, cachedProfile, saveMyProfile,
  fetchDraws, cachedDraws, getDraw, addDraw, updateDraw, updateDrawResults, removeDraw, cmdSet,
  fetchSignups, fetchMySignups, mySignup, signUp, cancelSignup,
};
