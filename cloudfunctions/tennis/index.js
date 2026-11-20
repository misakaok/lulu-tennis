// 网球小程序云函数：成员准入、管理员发布活动、报名、对阵、录分、比分纠错和正式战绩。
// 身份只来自 cloud.getWXContext().OPENID，所有权限在服务端校验。
// 日常比赛新增仅管理员；参赛者可修改未锁定比分，已锁定比分经对方确认。
// 评价、简介、关注、相册等内容功能接口已删除；旧数据仅由既有删除／清理流程处理。
// 球员照片：本人上传，经微信异步图片检测（消息推送 wxa_media_check）明确通过后才公开。
// 集合权限均为「仅管理端可读写」，客户端通过本云函数访问业务数据。
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
// 和小程序端共用的纯逻辑（由 scripts/sync-shared.sh 从 utils/ 复制过来）
const E = require('./shared/event');
const RULES = require('./shared/rules');
const OF = require('./shared/official');
const G = require('./shared/growth');
const K = require('./shared/racket');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const SEC_TIMEOUT_MS = 4000; // 内容安全检测超时（云函数超时时间请在控制台调到 10 秒）
const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');
// 今天的日期（北京时间）：云函数运行在 UTC，直接 toISOString 在早上 8 点前会变成前一天
const today = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

class Deny extends Error {}
const deny = (msg) => { throw new Deny(msg); };

/* ---------- 读取 ---------- */
async function getDoc(col, id) {
  try { const r = await db.collection(col).doc(id).get(); return r.data || null; } catch (e) { return null; }
}
// 按一组值批量查（每批 100 个值，结果超过 1000 条自动翻页）
async function byIds(col, values, field) {
  const f = field || '_id';
  const list = Array.from(new Set((values || []).filter((x) => typeof x === 'string' && x)));
  const chunks = [];
  for (let i = 0; i < list.length; i += 100) chunks.push(list.slice(i, i + 100));
  // 各批同时查（结果仍按批次顺序拼接）
  const parts = await Promise.all(chunks.map(async (chunk) => {
    const w = { [f]: _.in(chunk) }, out = [];
    for (let skip = 0; ; skip += 1000) {
      const r = await db.collection(col).where(w).skip(skip).limit(1000).get();
      out.push(...r.data);
      if (r.data.length < 1000) break;
    }
    return out;
  }));
  return [].concat(...parts);
}
// 先查缓存里预取好的文档（prefetch 填的；null 表示确认过不存在），没有再查数据库
async function cget(cache, col, id) {
  const d = cache && cache.docs && cache.docs[col];
  if (d && Object.prototype.hasOwnProperty.call(d, id)) return d[id];
  return getDoc(col, id);
}
const tsOf = (d) => { const t = d && d.createdAt; if (!t) return 0; const v = typeof t === 'number' ? t : new Date(t).getTime(); return isNaN(v) ? 0 : v; };

// 用户 ID → 本人资料（只用来显示当前昵称）
async function profileOf(uid) {
  if (!uid) return null;
  const r = await db.collection('players').where({ _openid: uid, self: true }).get();
  return r.data.sort((a, b) => tsOf(a) - tsOf(b))[0] || null;
}
async function nameOf(uid, fallback, cache) {
  if (!uid) return fallback || '';
  const c = cache || {};
  if (!(uid in c)) { const p = await profileOf(uid); c[uid] = p ? p.name : ''; }
  return c[uid] || fallback || '';
}

// 比分指纹：确认后比分再被改动，原来的确认就作废
const sigOf = (m) => md5(JSON.stringify({ a: m.a || [], b: m.b || [], aIds: m.aIds || [], bIds: m.bIds || [], winner: m.winner, sets: m.sets || [] }));
// 一次「交手」：活动里同一场改过比分仍算同一次；普通比赛就是这条记录

// 活动里「参赛名 → 用户 ID」：签表快照，再用报名记录覆盖（和前端 utils/ident.js 规则相同）
async function drawUidMap(drawId, cache) {
  const c = cache || {};
  if (!c['draw:' + drawId]) {
    const [draw, su] = await Promise.all([getDoc('draws', drawId), db.collection('signups').where({ drawId }).limit(1000).get()]);
    const out = Object.assign({}, (draw && draw.uidOf) || {});
    su.data.forEach((s) => { if (s.partner && s.partnerId) out[s.partner] = s.partnerId; });
    su.data.forEach((s) => { if (s.name && s._openid) out[s.name] = s._openid; });
    c['draw:' + drawId] = out;
  }
  return c['draw:' + drawId];
}

// 比赛双方的用户 ID（'' = 未绑定）。活动比赛在服务端重新计算，普通比赛用记录里的 ID
async function sidesOf(m, cache) {
  if (m.drawId && m.drawKey) {
    const map = await drawUidMap(m.drawId, cache);
    return { a: (m.a || []).map((n) => map[n] || ''), b: (m.b || []).map((n) => map[n] || '') };
  }
  const pick = (k) => (m[k] || []).map((n, i) => (typeof (m[k + 'Ids'] || [])[i] === 'string' ? m[k + 'Ids'][i] : ''));
  return { a: pick('a'), b: pick('b') };
}
const sideOf = (ids, uid) => (!uid ? '' : ids.a.indexOf(uid) >= 0 ? 'a' : ids.b.indexOf(uid) >= 0 ? 'b' : '');

// 比赛已结束：有胜者、双方都有人、至少一盘合法局分，且不是弃权 / 取消
function finishedReason(m) {
  if (!m) return '比赛记录不存在（可能已被撤销）';
  if (m.cancelled || m.walkover || (m.outcome && m.outcome !== 'normal')) return '弃权、中途退赛或取消的比赛不开放确认';
  if (!(m.a || []).length || !(m.b || []).length) return '比赛双方不完整';
  if (m.winner !== 'a' && m.winner !== 'b') return '比赛还没有结果';
  const sets = m.sets || [];
  if (!sets.length || sets.some((s) => typeof s.a !== 'number' || typeof s.b !== 'number' || s.a === s.b)) return '没有有效局分';
  return '';
}

/* ---------- 正式战绩 ---------- */
async function verifiedMap(ids) {
  const out = {}, chunks = [];
  for (let i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
  const parts = await Promise.all(chunks.map((chunk) => db.collection('verified').where({ _id: _.in(chunk) }).limit(100).get())); // 各批同时查
  parts.forEach((r) => r.data.forEach((v) => { out[v._id] = v; }));
  return out;
}
async function statusOfMatch(m, cache) {
  const d = cache && cache.docs && cache.docs.verified;
  if (d && Object.prototype.hasOwnProperty.call(d, m._id)) return OF.statusOf(m, d[m._id] ? { [m._id]: d[m._id] } : {});
  return OF.statusOf(m, await verifiedMap([m._id]));
}

// 活动的正式比分（云函数写入的，或升级前的旧记录），同一场只取最新
// 传 cache 时同一次请求里每个活动只查一次（只给只读的列表接口用；写入流程不传，保证读到最新）
async function officialEventMatches(drawId, cache) {
  const key = 'oem:' + drawId;
  if (cache && cache[key]) return cache[key];
  const r = await db.collection('matches').where({ drawId }).limit(1000).get();
  const v = await verifiedMap(r.data.map((m) => m._id));
  const out = E.dedupe(r.data.filter((m) => OF.statusOf(m, v) === 'official'));
  if (cache) cache[key] = out;
  return out;
}

// 日常比赛双方确认后：写比分快照，从此计入正式战绩（已有且一致就不重复写）
async function markVerified(m, cache) {
  if (m.drawId) return;
  const snap = OF.snapOf(m);
  const v = await cget(cache, 'verified', m._id);
  if (v && v.snap === snap) return;
  await db.collection('verified').doc(m._id).set({ data: { snap, at: db.serverDate() } });
  if (cache && cache.docs && cache.docs.verified) cache.docs.verified[m._id] = { _id: m._id, snap };
}

// 列表类接口（待办、待确认）要对很多场比赛逐场算状态：先把要用的数据一次查齐放进 cache，
// 之后 matchState 读缓存，不再每场查 6～8 次数据库。只用于只读计算，写入流程不用。
async function prefetch(ms, uid, cache) {
  if (!ms.length) return;
  const ids = ms.map((m) => m._id);
  const drawIds = Array.from(new Set(ms.map((m) => m.drawId).filter(Boolean)));
  const reqIds = ids.map((id) => 'sc_' + id);
  const [ver, cf, rq, dr, prof] = await Promise.all([
    byIds('verified', ids), byIds('confirms', ids, 'matchId'), byIds('requests', reqIds), byIds('draws', drawIds),
    db.collection('players').where({ self: true }).limit(1000).get().then((r) => r.data),
  ]);
  const docs = cache.docs = cache.docs || {};
  const put = (col, keys, rows) => {
    const d = docs[col] = docs[col] || {};
    keys.forEach((k) => { if (!Object.prototype.hasOwnProperty.call(d, k)) d[k] = null; });
    rows.forEach((r) => { d[r._id] = r; });
  };
  put('matches', [], ms); put('verified', ids, ver); put('requests', reqIds, rq); put('draws', drawIds, dr);
  cache.confirms = cache.confirms || {};
  ids.forEach((id) => { cache.confirms[id] = []; });
  cf.forEach((c) => { (cache.confirms[c.matchId] = cache.confirms[c.matchId] || []).push(c); });
  // 昵称：和 profileOf 一样取每个账号最早的那条本人资料
  const names = cache.names = cache.names || {};
  prof.sort((a, b) => tsOf(a) - tsOf(b)).forEach((p) => { if (p._openid && !(p._openid in names)) names[p._openid] = p.name || ''; });
  await Promise.all(drawIds.map((id) => Promise.all([officialEventMatches(id, cache), drawUidMap(id, cache)])));
}

// 录入人：云函数写入的记录看 recordedBy（服务端填的）；小程序端写入的记录只认系统写的 _openid
// （小程序端记录里的 recordedBy 可以随便填，不能相信）
const recorderOf = (m) => (m._openid ? m._openid : m.recordedBy || '');

// 旧记录迁移：升级后云函数第一次运行时，给当时已有的全部比赛记录写快照，照常计入战绩
let migrated = false;
async function ensureMigrated() {
  if (migrated) return;
  if (await getDoc('verified', OF.META_ID)) { migrated = true; return; }
  let skip = 0, count = 0;
  for (;;) {
    const r = await db.collection('matches').orderBy('createdAt', 'asc').skip(skip).limit(100).get();
    const v = await verifiedMap(r.data.map((m) => m._id));
    for (const m of r.data) {
      if ((m.drawId && !m._openid) || v[m._id]) continue;
      await db.collection('verified').doc(m._id).set({ data: { snap: OF.snapOf(m), legacy: true, at: db.serverDate() } });
      count++;
    }
    skip += r.data.length;
    if (r.data.length < 100) break;
  }
  await db.collection('verified').doc(OF.META_ID).set({ data: { at: db.serverDate(), count } });
  migrated = true;
}

// 活动里同一场被重新录过：只看正式记录，只有最新那条有效
async function supersededBy(m, cache) {
  if (!m.drawId || !m.drawKey) return null;
  const latest = (await officialEventMatches(m.drawId, cache)).find((x) => x.drawKey === m.drawKey);
  return latest && latest._id !== m._id ? latest._id : null;
}

// 确认状态：每一方至少有一人「录入或确认」了当前比分，才算双方确认（都按用户 ID）
async function confirmState(m, ids, cache) {
  const sig = sigOf(m);
  const recorder = recorderOf(m);
  const recorderSide = sideOf(ids, recorder);
  const pre = cache && cache.confirms && cache.confirms[m._id];
  const rows = pre || (await db.collection('confirms').where({ matchId: m._id }).get()).data;
  const valid = rows.filter((c) => c.sig === sig && sideOf(ids, c.openid) === c.side);
  const sides = {};
  if (recorderSide) sides[recorderSide] = { by: 'recorder', uid: recorder };
  // 活动发起人裁定过的比分：双方都算确认（只认云函数写入的活动记录，小程序端记录里填这个字段无效）
  if (!m._openid && m.rulingSig && m.rulingSig === sig) {
    const by = m.lastChange && m.lastChange.how === 'admin' ? 'admin' : 'ruling'; // 管理员更正的活动比分也记在这里
    sides.a = sides.a || { by, uid: m.ruledBy || '' }; sides.b = sides.b || { by, uid: m.ruledBy || '' };
  }
  // 管理员更正过的日常比分：双方都算确认。只认 verified 里云函数写的 adminSig（比赛记录里的 lastChange 只用来决定要不要查）
  if (!m.drawId && m.lastChange && m.lastChange.how === 'admin') {
    const v = await cget(cache, 'verified', m._id);
    if (v && v.adminSig === sig) { sides.a = sides.a || { by: 'admin', uid: '' }; sides.b = sides.b || { by: 'admin', uid: '' }; }
  }
  valid.forEach((c) => { if (!sides[c.side]) sides[c.side] = { by: 'confirm', uid: c.openid }; });
  return { sig, recorderSide, sides, confirmed: !!(sides.a && sides.b) };
}

// 加载一场比赛并做所有通用校验；返回调用者在这场里的身份
async function loadMatch(matchId, uid, cache) {
  if (!matchId || typeof matchId !== 'string') deny('缺少比赛');
  const m = await cget(cache, 'matches', matchId);
  let fin = finishedReason(m);
  if (!fin && (await statusOfMatch(m, cache)) === 'invalid') fin = '这条活动比分不是从活动录分写入的，不予认可';
  const ids = m ? await sidesOf(m, cache) : { a: [], b: [] };
  return { m, fin, ids, side: sideOf(ids, uid) };
}

// 这场比赛的比分修改记录（比赛详情页显示）：直接改 / 重新录、申请通过、发起人裁定、管理员更正。
// 只返回谁、什么时候、从多少改成多少；申请和裁定里填的原因是自由文字，不下发（个人主体不展示用户写的文字）
async function changeLog(m) {
  const rows = (await db.collection('requests').where({ matchId: m._id }).limit(100).get()).data;
  const names = {}, out = [];
  const text = (x) => E.scoreText((x && x.sets) || []) || (x && x.outcome === 'walkover' ? '弃权' : x && x.outcome === 'retired' ? '中途退赛' : '无局分');
  for (const q of rows) {
    if (!q.from || !q.to) continue;
    let how = '', by = '', at = tsOf(q);
    if (q.type === 'edit') { how = 'edit'; by = q.by; }
    else if (q.type === 'adminScore') how = 'admin';
    else if (q.type === 'score' && q.status === 'accepted') { how = 'request'; by = q.requesterId; at = tsOf({ createdAt: q.handledAt }) || at; }
    else if (q.type === 'score' && q.status === 'ruled') { how = 'rule'; at = tsOf({ createdAt: q.handledAt }) || at; }
    else continue;
    out.push({ at, how, who: how === 'admin' ? '管理员' : how === 'rule' ? '活动发起人' : await nameOf(by, '球友', names), from: text(q.from), to: text(q.to) });
  }
  return out.sort((x, y) => x.at - y.at);
}

/* ---------- 赛果确认 ---------- */
// detail: true（比赛详情页用）时顺带返回比赛记录和它的状态（official / pending / invalid），页面不用再分开读
async function matchState({ matchId, detail }, uid, cache) {
  cache = cache || {};
  const { m, fin, ids, side } = await loadMatch(matchId, uid, cache);
  const base = { matchId, mySide: side, finished: !fin, reason: fin, drawId: (m && m.drawId) || '', drawKey: (m && m.drawKey) || '', outcome: (m && (m.outcome || (m.walkover ? 'walkover' : 'normal'))) || '' };
  if (m && m.drawId) { const dr = await cget(cache, 'draws', m.drawId); base.isOwner = !!dr && dr._openid === uid; }
  if (m && isAdmin(uid)) base.canAdminRevoke = true; // 管理员可以撤销任何一场（包括弃权 / 退赛的）
  if (detail === true) Object.assign(base, { match: E.publicMatch(m) || null, status: m ? await statusOfMatch(m, cache) : '', changes: m ? await changeLog(m) : [] });
  if (fin) return base;
  const sup = await supersededBy(m, cache);
  if (sup) return Object.assign(base, { finished: false, reason: '这条比分已被新的记录取代', supersededBy: sup });
  const st = await confirmState(m, ids, cache);
  if (st.confirmed) {
    await markVerified(m, cache); // 日常比赛：双方确认后计入正式战绩
    if (detail === true && !m.drawId) base.status = 'official'; // 返回本次补齐快照后的状态
  }
  const names = cache.names = cache.names || {};
  const sideText = {};
  for (const k of ['a', 'b']) {
    const s = st.sides[k];
    sideText[k] = !s ? '' : s.by === 'recorder' ? '录入' : s.by === 'ruling' ? '发起人裁定' : s.by === 'admin' ? '管理员更正' : await nameOf(s.uid, '已确认', names);
  }
  const out = Object.assign(base, {
    confirmed: st.confirmed, sides: sideText, daily: !m.drawId,
    canConfirm: !!m.drawId && !!side && !st.sides[side], // 日常比赛录入后直接生效，不需要确认
    unbound: ids.a.concat(ids.b).some((x) => !x),
  });
  // 改分：没确认时录入人可以直接改（日常比赛）；已确认后参赛者只能提交申请；有待处理申请时显示出来
  out.request = await requestView(m, ids, uid, cache);
  out.canEdit = !st.confirmed && !m.drawId && (recorderOf(m) === uid || !!side); // 日常比赛：录入人和参赛者都可以直接改
  out.canRequestChange = st.confirmed && !!side && !out.request;
  out.canAdminFix = isAdmin(uid); // 管理员可以直接更正任何一场的正常比分（日常比赛、活动比赛）
  if (!side) out.reason = '你不是这场比赛的参加者（按账号判断，不看昵称）';
  else if (!st.confirmed && m.drawId) out.reason = st.sides[side] ? '等待对方确认比分' : '请先确认比分';
  return out;
}

async function confirmResult({ matchId }, uid) {
  const cache = {};
  const { m, fin, ids, side } = await loadMatch(matchId, uid, cache);
  if (fin) deny(fin);
  if (!side) deny('只有这场比赛的参加者本人可以确认比分');
  if (await supersededBy(m)) deny('这条比分已被新的记录取代，请确认最新比分');
  const st = await confirmState(m, ids);
  if (st.sides[side]) deny(st.recorderSide === side ? '比分是你这一方录入的，需要对方确认' : '你这一方已经确认过了');
  try {
    await db.collection('confirms').add({
      data: { _id: md5(`${matchId}|${uid}|${st.sig}`), matchId, sig: st.sig, side, openid: uid, createdAt: db.serverDate() },
    });
  } catch (e) { deny('你已经确认过了'); }
  return matchState({ matchId }, uid, cache);
}

/* ---------- 文字内容安全（名称、业务申请，以及停用功能的兼容操作共用） ---------- */
// 文字必须通过微信内容安全检测才能保存：只有明确「pass」才放行；
// 违规、需人工复核、接口无权限、超时、异常，一律不保存文字
async function checkText(text, uid) {
  let timer;
  const timeout = new Promise((_r, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { timeout: true })), SEC_TIMEOUT_MS); });
  try {
    const r = await Promise.race([cloud.openapi.security.msgSecCheck({ openid: uid, scene: 1, version: 2, content: text }), timeout]);
    const code = r && (r.errCode !== undefined ? r.errCode : r.errcode);
    if (code && code !== 0) return code === 87014 ? 'risky' : 'error';
    const suggest = r && r.result && r.result.suggest;
    if (suggest === 'pass') return 'pass';
    if (suggest === 'risky' || suggest === 'review') return 'risky';
    return 'error'; // 返回格式不认识，也不放行
  } catch (e) {
    const code = e && (e.errCode !== undefined ? e.errCode : e.errcode);
    if (code === 87014) return 'risky';
    console.error('内容安全检测失败', e && (e.errMsg || e.message), code);
    return 'error';
  } finally { clearTimeout(timer); }
}

async function requireSafeText(text, uid, label) {
  if (!text) return;
  const res = await checkText(text, uid);
  if (res === 'risky') deny(`${label}包含不合适的内容，请修改后再提交`);
  if (res !== 'pass') deny(`${label}暂时无法完成安全检测，请稍后再试`);
}

async function checkedTitle(value, uid) {
  const title = typeof value === 'string' ? value.trim() : '';
  if (!title) deny('请填写比赛名称');
  if (title.length > E.TITLE_MAX) deny(`比赛名称最多 ${E.TITLE_MAX} 个字`);
  if (/[\u0000-\u001f\u007f]/.test(title)) deny('比赛名称里有不支持的字符');
  await requireSafeText(title, uid, '比赛名称');
  return title;
}

// 我参加的比赛（按 aIds / bIds 查出来的两组）：去重，按日期、录入时间从新到旧
function uniqueMatches(rows) {
  const seen = {};
  return rows.filter((m) => (seen[m._id] ? false : (seen[m._id] = 1)))
    .sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')) || tsOf(y) - tsOf(x));
}

/* ---------- 撤销赛果 ---------- */
// 日常比赛：只有录入人能撤销；已经锁定的比分（以前双方确认过的、管理员更正过的）不能撤销，只能「申请修改比分」。
// 活动比赛：参赛的录入人只能撤销「还没双方确认、不影响后续场次」的正常比分；
//   其他情况（已确认、弃权 / 退赛、会推翻后续已录分场次）只有发起人能撤销，必须填原因，受影响的场次一并作废。
// 所有撤销都写处理记录，被删的比分快照留档。
// 需要原因 / 确认影响时返回 { needReason: true, impact }，前端填写后带 reason（和 confirmImpact）再提交。
// 管理员：可以撤销任何一场（日常比赛、活动比赛，包括已锁定的和弃权 / 退赛的），不用填原因，照样留档；
//   会推翻后续已录分场次时返回 { needConfirm: true, impact }，带 confirmImpact 再提交；这场待处理的改分申请随之失效。
async function revokeMatch({ matchId, reason, confirmImpact }, uid) {
  if (typeof matchId !== 'string' || !matchId) deny('缺少比赛');
  const m = await getDoc('matches', matchId);
  if (!m) deny('比赛记录不存在');
  const draw = m.drawId ? await getDoc('draws', m.drawId) : null;
  const owner = !!draw && draw._openid === uid;
  const recorder = recorderOf(m) === uid;
  const admin = isAdmin(uid);
  if (!owner && !recorder && !admin) deny('只有录入人、活动发起人或管理员可以撤销');
  const pend = await getDoc('requests', 'sc_' + m._id);
  const open = !!pend && (pend.status === 'pending' || pend.status === 'processing');
  if (open && !admin) deny('这场有待处理的改分申请，处理完之前不能撤销');
  if (open && pend.status === 'processing') deny('这场的改分申请正在处理中，请稍后再试');
  // 管理员撤销时，待处理的改分申请一并失效（原子领取，避免和对方同时处理）
  const closeReq = async () => { if (open) await finish(pend._id, { status: 'stale', handledBy: uid, handleNote: '管理员已撤销这场比赛' }); };
  const normal = (m.outcome || 'normal') === 'normal' && !m.walkover;
  const confirmed = !finishedReason(m) && (await confirmState(m, await sidesOf(m, {}))).confirmed;

  if (!(m.drawId && m.drawKey)) {
    if (!admin) {
      if (!recorder) deny('只有录入人可以撤销日常比赛');
      if (confirmed) deny('比分已经锁定，不能单方面撤销；如果比分有误，请「申请修改比分」');
    }
    if (open && !(await claim(pend._id, uid))) deny('这场的改分申请正在处理中，请稍后再试');
    const removed = await voidRecords([m._id]);
    await closeReq();
    await logAction(Object.assign({ type: 'revoke', matchId: m._id, by: uid, reason: cleanReason(reason), removed }, admin && !recorder ? { byAdmin: true } : {}));
    return { removed: removed.length, voided: [] };
  }

  // 活动比赛：同一场的所有记录（含升级前的旧记录）一起撤销；只有正式记录才会影响签表晋级
  const recs = (await db.collection('matches').where({ drawId: m.drawId, drawKey: m.drawKey }).get()).data;
  let impact = [];
  if (draw) {
    draw._id = m.drawId;
    const list = await officialEventMatches(m.drawId);
    if (list.some((x) => x.drawKey === m.drawKey)) impact = E.impactOf(draw, list, draw, list.filter((x) => x.drawKey !== m.drawKey), m.drawKey);
  }
  if (!owner && !admin) {
    if (!normal) deny('这场已由发起人按弃权 / 退赛处理，如有异议请联系发起人');
    if (confirmed) deny('比分已经双方确认，不能撤销；如果比分有误，请「申请修改比分」');
    if (impact.length) deny(`撤销会改变后续已录分的比赛（${impact.map((x) => x.stage + ' ' + x.a + ' vs ' + x.b).join('、')}），需由活动发起人处理`);
  }
  const needReason = owner && (confirmed || !normal || impact.length > 0);
  const why = cleanReason(reason);
  if (needReason && (why.length < 2 || (impact.length && !confirmImpact))) return { needReason: true, impact, confirmed };
  if (!owner && admin && impact.length && !confirmImpact) return { needConfirm: true, impact, confirmed };
  if (open && !(await claim(pend._id, uid))) deny('这场的改分申请正在处理中，请稍后再试');
  const removed = await voidRecords(recs.map((r) => r._id));
  const voided = impact.length ? await voidRecords(impact.map((x) => x.recordId)) : [];
  await closeReq();
  await logAction(Object.assign({ type: 'revoke', drawId: m.drawId, drawKey: m.drawKey, matchId: m._id, by: uid, reason: why, removed, voided }, !owner && admin ? { byAdmin: true } : {}));
  return { removed: removed.length, voided };
}

/* ---------- 报名 ---------- */
// 报名只能经云函数写入：参赛名取本人当前资料里的昵称，搭档按用户 ID 校验，客户端填的名字一律不用。
// （云函数会用「报名名 → 报名人 ID」来认定活动比赛的双方，名字能乱填就能冒充别人录分、确认、评价）
// 云函数写入的记录不会自动带 _openid，这里显式写入，和以前小程序端写的记录格式保持一致。
const suId = (drawId, uid) => 'su_' + md5(`${drawId}#${uid}`);

// 昵称是否只属于这个账号：别人正在用、以前用过的昵称都不行
async function nameOwnedBy(name, uid) {
  const [same, former] = await Promise.all([
    db.collection('players').where({ name, self: true }).limit(100).get(),
    db.collection('players').where({ formerNames: name, self: true }).limit(100).get(),
  ]);
  return !same.data.concat(former.data).some((p) => p._openid && p._openid !== uid);
}

async function signUp({ drawId, partnerId }, uid) {
  const draw = await loadDraw(drawId);
  if (draw.status && draw.status !== 'signup') deny('报名已截止');
  const me = await profileOf(uid);
  if (!me || !me.name) deny('请先设置头像和昵称');
  if (!(await nameOwnedBy(me.name, uid))) deny('你的昵称和其他球友重复，请先到个人资料里改一个');
  const list = (await db.collection('signups').where({ drawId }).limit(1000).get()).data;
  if (list.some((s) => s._openid === uid)) return { already: true };
  if (list.some((s) => s.partnerId === uid)) deny('你的搭档已经帮你报名了');
  // 参赛名不能和名单里别人的名字重复（否则无法按名字区分是谁）
  const nameTaken = (n, id) => list.some((s) => (s.name === n && s._openid !== id) || (s.partner === n && s.partnerId !== id));
  if (nameTaken(me.name, uid)) deny('报名名单里已经有同名的球友，请先改昵称');

  const double = E.cfgOf(draw).type === 'double';
  let partner = null;
  if (double && partnerId) {
    if (typeof partnerId !== 'string') deny('搭档不对');
    if (partnerId === uid) deny('不能选自己当搭档');
    if ((await memberOf(partnerId)).status !== 'active') deny('搭档还不是正式成员');
    const p = await profileOf(partnerId);
    if (!p || !p.name) deny('搭档还没有设置资料');
    if (!(await nameOwnedBy(p.name, partnerId))) deny(`搭档的昵称「${p.name}」和其他球友重复，请 TA 先改昵称`);
    if (list.some((s) => s._openid === partnerId || s.partnerId === partnerId)) deny(`${p.name} 已经报名了`);
    if (nameTaken(p.name, partnerId)) deny('报名名单里已经有和搭档同名的球友');
    partner = p;
  }
  // 组别：按个人资料里的性别校验（男子 / 女子组只收对应性别；混双的搭档必须一男一女）
  const cat = E.categoryOf(draw);
  if (cat) {
    const g = (p) => (p.gender === 'm' || p.gender === 'f' ? p.gender : '');
    const word = { m: '男', f: '女' };
    if (!g(me)) deny('这个活动按性别分组，请先在「编辑资料」里选择性别');
    if (cat !== 'mixed' && g(me) !== cat) deny(`这是${E.CATEGORIES[cat]}组活动，只有${word[cat]}球员可以报名`);
    if (partner) {
      if (!g(partner)) deny(`搭档「${partner.name}」还没有选择性别，请 TA 先在「编辑资料」里选择`);
      if (cat === 'mixed' && g(partner) === g(me)) deny('混双的搭档必须一男一女');
      if (cat !== 'mixed' && g(partner) !== cat) deny(`这是${E.CATEGORIES[cat]}组活动，搭档也要是${word[cat]}球员`);
    }
  }
  // 名额满了不拒绝：照常报名，排在名额之后的是候补（按报名先后，前面有人取消就自动递补）
  const newId = suId(drawId, uid);

  try {
    await db.collection('signups').add({
      data: {
        _id: newId, _openid: uid, drawId, name: me.name, avatar: me.avatar || '', level: typeof me.level === 'number' ? me.level : null,
        partner: partner ? partner.name : '', partnerId: partner ? partnerId : '', partnerAvatar: partner ? partner.avatar || '' : '',
        createdAt: db.serverDate(),
      },
    });
  } catch (e) { return { already: true }; } // 同一账号重复提交：_id 相同，只会有一条
  // 写入后重新读名单，按库里的报名时间算是不是候补（两人同时抢最后一个名额时，提示和实际排队一致）
  const now = (await db.collection('signups').where({ drawId }).limit(1000).get()).data;
  return { ok: true, waiting: !!E.waitingOf(now, E.capacityOf(draw))[newId] };
}

// 报名阶段可以直接取消（连同搭档）；签表生成后要走退赛申请
async function cancelSignup({ drawId }, uid) {
  const draw = await loadDraw(drawId);
  if (draw.status && draw.status !== 'signup') deny('对阵表已经生成，不能直接取消报名；请在活动页提交退赛申请');
  const mine = (await db.collection('signups').where({ drawId, _openid: uid }).get()).data;
  if (!mine.length) {
    const asPartner = await db.collection('signups').where({ drawId, partnerId: uid }).limit(1).get();
    if (asPartner.data.length) deny('是搭档帮你报的名，请让 TA 取消');
    return { removed: 0 };
  }
  for (const s of mine) await db.collection('signups').doc(s._id).remove();
  return { removed: mine.length };
}

/* ---------- 个人资料 ---------- */
// 只能经云函数保存：服务端检查昵称不和别人重复（正在用的、以前用过的都不行），照片只认本人 avatars/ 目录下的 fileID。
// 昵称会参与「参赛名 → 用户 ID」的对应，所以重名检查不能放在前端。
const NAME_MAX = 10;
const isOtherUser = (uid) => (p) => !!p._openid && p._openid !== uid;
// 公开展示授权（players.shown，2026-11-20 审核要求「获得用户知情及授权」后才向其他成员展示昵称和照片）：
//   true 本人同意在排行、战绩、活动名单、球员主页向其他成员展示昵称和照片；false / 没有 = 没同意。
//   没同意：照片不下发给任何人（dataset / 网关 / photoUrls 都去掉）、不能上传照片，排行榜里不显示（小程序端过滤）。
//   只能由本人经 saveProfile / setShown 写入，shownAt 记最近一次改动的时间。不强制：不同意也能设置资料、报名、录分，之后可以随时开关。
const isShown = (p) => !!p && p.shown === true;

async function saveProfile({ name, avatar, level, gender, shown }, uid) {
  const nm = typeof name === 'string' ? name.trim() : '';
  if (!nm) deny('请填写昵称');
  if (nm.length > NAME_MAX) deny(`昵称最多 ${NAME_MAX} 个字`);
  if (/[\u0000-\u001f\u007f]/.test(nm)) deny('昵称里有不支持的字符');
  if (gender !== 'm' && gender !== 'f') deny('请选择性别'); // 性别必填（男 / 女），没有「不公开」
  const col = db.collection('players');
  const [same, former, mineR] = await Promise.all([
    col.where({ name: nm, self: true }).limit(100).get(),
    col.where({ formerNames: nm, self: true }).limit(100).get(),
    col.where({ _openid: uid, self: true }).limit(100).get(),
  ]);
  if (same.data.some(isOtherUser(uid))) deny('这个昵称已经被其他球友使用了，换一个吧');
  if (former.data.some(isOtherUser(uid))) deny('这个昵称是其他球友以前用过的，为避免混淆请换一个');
  const docs = mineR.data.sort((a, b) => tsOf(a) - tsOf(b));
  const mine = docs[0] || null;
  if (!mine || mine.name !== nm) await requireSafeText(nm, uid, '昵称');
  // 旧头像（没经过检测）只保留原值，不展示；旧版客户端不能借这里换照片。
  const av = mine && mine.avatar || '';
  if (typeof avatar === 'string' && avatar && avatar !== av) deny('请升级小程序后在资料页上传照片'); // 照片改走 setPhoto（要过图片检测）
  const lv = typeof level === 'number' && level >= 1 && level <= 7 && Math.round(level * 2) === level * 2 ? level : null;
  const data = { name: nm, avatar: av, level: lv, gender, updatedAt: db.serverDate() };
  if (typeof shown === 'boolean' && (!mine || mine.shown !== shown)) Object.assign(data, { shown, shownAt: db.serverDate() });
  if (mine) {
    // 改名：旧昵称记进 formerNames，留给本人（历史记录按用户 ID 跟着走，昵称只是展示）
    if (mine.name && mine.name !== nm) {
      const fn = (mine.formerNames || []).filter((n) => n !== nm);
      if (fn.indexOf(mine.name) < 0) fn.push(mine.name);
      data.formerNames = fn.slice(-10);
    }
    await col.doc(mine._id).update({ data });
    for (const d of docs.slice(1)) await col.doc(d._id).remove().catch(() => {}); // 网络重试多出来的重复资料
  } else {
    await col.add({ data: Object.assign({ _openid: uid, self: true, createdAt: db.serverDate() }, data) });
  }
  return { profile: publicPlayer(Object.assign({}, mine || {}, data, { updatedAt: Date.now() })) };
}

// 公开展示授权：开启 / 关闭（启动时的授权弹窗、资料页的勾选）。关闭后照片保留但不再下发，重新开启后恢复显示
async function setShown({ on }, uid) {
  if (typeof on !== 'boolean') deny('参数不对');
  const me = await profileOf(uid);
  if (!me) deny('请先设置昵称和性别');
  if (me.shown !== on) await db.collection('players').doc(me._id).update({ data: { shown: on, shownAt: db.serverDate(), updatedAt: db.serverDate() } });
  return { shown: on };
}

/* ---------- 球员照片 ---------- */
// 本人上传 1080×1080 的正方形照片（小程序端裁剪、缩放），云存储路径 avatars/<用户 ID>/<文件名>.jpg。
// 交给微信异步图片检测（mediaCheckAsync，结果经消息推送 wxa_media_check 回到本云函数），只有明确 pass 才公开：
//   players.photo  服务端 player-photos/<用户 ID>/ 内已通过检测的不可变快照 fileID，其他球友只能看到这一张（经 photoUrls 换 30 分钟临时链接）
//   avatar_checks（仅管理端可读写）：_id = 检测的 trace_id
//     { uid, fileID, status: checking 检测中 / pass / reject 未通过 / error 检测出错 / replaced 被新照片取代, at, createdAt, checkedAt, label }
// 换照片：新照片通过检测后才替换，旧照片文件随即删除；没通过的照片文件直接删除。检测中、没通过的状态只有本人能看到。
// players.avatar 是以前上传、没经过检测的旧照片：保留原值，不再展示。
const PHOTO_DIR = 'avatars';
const PHOTO_URL_AGE = 30 * 60;      // 临时链接 30 分钟
const PHOTO_DAY_MAX = 10;           // 每人 24 小时内最多提交 10 次检测
const PHOTO_SCENE = 1;              // 检测场景：资料
const PHOTO_CHECK_MAX_MS = 60 * 60 * 1000; // 检测超过 1 小时还没结果（微信漏推、结果丢失）：判为出错，让本人重新上传
const EARLY = 'early-';             // 检测结果比检测记录先到时，先存在 avatar_checks 的 early-<trace_id>，setPhoto 写完记录后接着处理
const escRe = (x) => String(x).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// anyEnv：检测推送里用。推送不是小程序端调用，上下文里可能没有环境 ID；检测记录里的 fileID 是服务端自己复制出来的，
// 提交时已经核对过环境，这里只核对目录和用户 ID（否则会把通过的照片当成路径不对而删掉）
function photoPathOk(fileID, uid, dir = PHOTO_DIR, anyEnv = false) {
  if (typeof fileID !== 'string') return false;
  const env = cloud.getWXContext().ENV || process.env.TCB_ENV || process.env.SCF_NAMESPACE || '';
  const m = new RegExp(`^cloud://([^./]+)\\.[^/]+/${dir}/${escRe(uid)}/[\\w-]{1,64}\\.jpg$`).exec(fileID);
  return !!m && (anyEnv || (!!env && m[1] === env));
}
async function removeFiles(list) {
  const ids = list.filter(Boolean);
  if (!ids.length) return;
  try { await cloud.deleteFile({ fileList: ids }); } catch (e) { console.error('删除照片文件失败', ids, e && (e.errMsg || e.message)); }
}
async function tempUrls(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const r = await cloud.getTempFileURL({ fileList: ids.slice(i, i + 50).map((fileID) => ({ fileID, maxAge: PHOTO_URL_AGE })) });
    (r.fileList || []).forEach((f) => { if (f.status === 0 && f.tempFileURL) out[f.fileID] = f.tempFileURL; });
  }
  return out;
}
// 所有照片状态转换在同一个球员文档上串行化；事务中只做数据库操作。
async function photoTransaction(fn) {
  let result;
  await db.runTransaction(async (tx) => { result = await fn(tx); });
  return result;
}
async function replacePending(tx, p) {
  if (!p.photoTrace) return [];
  const ref = tx.collection('avatar_checks').doc(p.photoTrace);
  const c = (await ref.get()).data;
  if (!c || c.status !== 'checking') return [];
  await ref.update({ data: { status: 'replaced', checkedAt: db.serverDate() } });
  return [c.fileID];
}
async function clearPhoto(p, actor) {
  const result = await photoTransaction(async (tx) => {
    const ref = tx.collection('players').doc(p._id);
    const current = (await ref.get()).data;
    const files = await replacePending(tx, current);
    await ref.update({ data: { photo: '', photoRequest: crypto.randomBytes(16).toString('hex'), photoTrace: '', updatedAt: db.serverDate() } });
    if (actor) {
      await tx.collection('requests').doc('photo-' + crypto.randomBytes(16).toString('hex')).set({ data: {
        type: 'adminPhoto', target: p._openid, by: actor, byAdmin: true, from: current.photo || '', status: 'done', createdAt: db.serverDate(), handledAt: db.serverDate(),
      } });
    }
    return { files: files.concat(current.photo || []), removed: !!(current.photo || files.length) };
  });
  await removeFiles(result.files);
  return { removed: result.removed };
}
async function submitMediaCheck(url, uid) {
  let timer;
  const timeout = new Promise((_r, reject) => { timer = setTimeout(() => reject(new Error('timeout')), SEC_TIMEOUT_MS); });
  try {
    const r = await Promise.race([cloud.openapi.security.mediaCheckAsync({ mediaUrl: url, mediaType: 2, version: 2, scene: PHOTO_SCENE, openid: uid }), timeout]);
    const code = r && (r.errCode !== undefined ? r.errCode : r.errcode);
    const trace = r && (r.traceId || r.trace_id);
    return (code && code !== 0) || typeof trace !== 'string' || !trace ? '' : trace;
  } catch (e) {
    console.error('图片检测提交失败', e && (e.errMsg || e.message), e && (e.errCode !== undefined ? e.errCode : e.errcode));
    return '';
  } finally { clearTimeout(timer); }
}

// 本人提交新照片（fileID 由小程序端上传后带来），或 fileID 为空表示删除照片、改回首字圆
async function setPhoto({ fileID }, uid) {
  const me = await profileOf(uid);
  if (!me) deny('请先设置昵称和性别，再上传照片');
  if (fileID === '') { await clearPhoto(me); return { state: '' }; }
  if (!isShown(me)) deny('照片会展示给其他成员，请先同意公开展示后再上传');
  if (!photoPathOk(fileID, uid)) deny('照片位置不对，请重新选择');
  const col = db.collection('avatar_checks');
  if ((await col.where({ sourceID: fileID }).count()).total) deny('这张照片已经提交过了');
  const request = crypto.randomBytes(16).toString('hex');
  const oldFiles = await photoTransaction(async (tx) => {
    const ref = tx.collection('players').doc(me._id);
    const p = (await ref.get()).data;
    const attempts = (p.photoAttempts || []).filter((x) => x.at > Date.now() - 24 * 3600 * 1000);
    if (attempts.some((x) => x.fileID === fileID)) deny('这张照片已经提交过了');
    if (attempts.length >= PHOTO_DAY_MAX) deny('今天换照片的次数太多了，明天再试');
    const files = await replacePending(tx, p);
    await ref.update({ data: { photoRequest: request, photoTrace: '', photoAttempts: attempts.concat({ fileID, at: Date.now() }) } });
    return files;
  }).catch(async (e) => {
    if (e instanceof Deny && /次数太多/.test(e.message)) await removeFiles([fileID]);
    throw e;
  });
  await removeFiles(oldFiles);
  let snapshot = '', trace = '';
  try {
    // 客户端可覆盖自己的上传文件，故先复制到客户端不可读写的目录，检测和发布始终使用这个不可变快照。
    const { fileContent } = await cloud.downloadFile({ fileID });
    snapshot = (await cloud.uploadFile({ cloudPath: `player-photos/${uid}/${request}.jpg`, fileContent })).fileID;
    if (!photoPathOk(snapshot, uid, 'player-photos')) throw new Error('invalid snapshot');
    const url = (await tempUrls([snapshot]))[snapshot];
    if (url) trace = await submitMediaCheck(url, uid);
    console.log('[照片检测提交]', JSON.stringify({ trace }));
    if (!trace) throw new Error('media check unavailable');
    const active = await photoTransaction(async (tx) => {
      const ref = tx.collection('players').doc(me._id);
      const p = (await ref.get()).data;
      const current = p.photoRequest === request;
      await tx.collection('avatar_checks').doc(trace).set({ data: {
        uid, playerId: me._id, sourceID: fileID, fileID: snapshot, request,
        status: current ? 'checking' : 'replaced', at: Date.now(), createdAt: db.serverDate(),
      } });
      if (current) await ref.update({ data: { photoTrace: trace } });
      return current;
    });
    if (!active) await removeFiles([snapshot]);
    // 检测结果已经先到了（推送比上面的记录先写入）：现在补处理，结果不会丢
    const early = await getPhotoCheck(EARLY + trace);
    if (early) {
      if (active) await settleCheck(trace, early.result, early.label);
      try { await db.collection('avatar_checks').doc(EARLY + trace).remove(); } catch (e) {}
      const now = await getPhotoCheck(trace);
      if (now && now.status === 'pass') return { state: '', pending: snapshot };
      if (now && now.status !== 'checking') return { state: now.status === 'replaced' ? '' : now.status };
    }
    return active ? { state: 'checking', pending: snapshot } : { state: '' }; // pending：通过后会成为 players.photo 的那份（只给本人，前端用来认出「这就是我刚传的」）
  } catch (e) {
    await removeFiles([snapshot]);
    deny('照片暂时无法完成安全检测，请稍后再试');
  } finally { await removeFiles([fileID]); }
}

// 微信图片检测结果：状态、请求版本和公开照片在同一事务内更新，重复或过期回调不能恢复已清除的照片。
async function getPhotoCheck(trace) {
  try { return (await db.collection('avatar_checks').doc(trace).get()).data || null; }
  catch (e) {
    if (/document.*(not exist|not found)|DATABASE_DOCUMENT_NOT_EXIST/i.test((e && (e.errMsg || e.message)) || '')) return null;
    throw e;
  }
}
// 处理一次检测结果（推送到达，或 setPhoto 发现结果已经先到）：只处理仍在 checking 的记录
async function settleCheck(trace, status, label) {
  const files = await photoTransaction(async (tx) => {
    const check = tx.collection('avatar_checks').doc(trace);
    const c = (await check.get()).data;
    if (!c || c.status !== 'checking') return [];
    const ref = tx.collection('players').doc(c.playerId);
    const p = (await ref.get()).data;
    const current = p && p.self && p._openid === c.uid && p.photoRequest === c.request && p.photoTrace === trace;
    const publish = current && status === 'pass' && photoPathOk(c.fileID, c.uid, 'player-photos', true);
    console.log('[照片检测处理]', JSON.stringify({ trace, status, current: !!current, publish: !!publish }));
    await check.update({ data: { status: current ? status : 'replaced', label: Number(label) || 0, checkedAt: db.serverDate() } });
    if (current) await ref.update({ data: Object.assign({ photoTrace: '', updatedAt: db.serverDate() }, publish ? { photo: c.fileID } : {}) });
    return publish ? [p.photo].filter((f) => f && f !== c.fileID) : [c.fileID];
  });
  await removeFiles(files);
}
async function onMediaCheck(ev) {
  const trace = ev.trace_id || ev.traceId;
  if (typeof trace !== 'string' || !trace || trace.indexOf(EARLY) === 0) return 'success';
  const res = ev.result || {};
  const code = ev.errcode !== undefined ? ev.errcode : ev.errCode;
  const status = code && code !== 0 ? 'error' : res.suggest === 'pass' ? 'pass' : 'reject';
  const label = Number(res.label) || 0;
  let rec = await getPhotoCheck(trace);
  console.log('[照片检测记录]', JSON.stringify({ trace, found: !!rec, state: rec ? rec.status : '' }));
  if (!rec) {
    // 记录还没写入（setPhoto 刚拿到 trace_id）：先把结果存下来，setPhoto 写完记录后会接着处理。
    // 存完再查一次：期间 setPhoto 已经写好记录的，这里直接处理（两边重复处理时，第二次因为不再是 checking 而跳过）
    await db.collection('avatar_checks').doc(EARLY + trace).set({ data: { status: 'early', result: status, label, at: Date.now(), createdAt: db.serverDate() } });
    rec = await getPhotoCheck(trace);
    if (!rec) return 'success';
  }
  if (rec.status !== 'checking' || !rec.playerId || !rec.request) return 'success'; // 以前版本的球拍照片检测（kind: 'racket'，没有 playerId）不再处理
  await settleCheck(trace, status, label);
  return 'success';
}

// 检测中超过 PHOTO_CHECK_MAX_MS 还没结果：判为出错，删掉检测用的副本（晚到的结果因为不再是 checking 被忽略）
async function expireCheck(c) {
  const files = await photoTransaction(async (tx) => {
    const check = tx.collection('avatar_checks').doc(c._id);
    const cur = (await check.get()).data;
    if (!cur || cur.status !== 'checking') return [];
    await check.update({ data: { status: 'error', timedOut: true, checkedAt: db.serverDate() } });
    const ref = tx.collection('players').doc(cur.playerId);
    const p = (await ref.get()).data;
    if (p && p.photoTrace === c._id) await ref.update({ data: { photoTrace: '', updatedAt: db.serverDate() } });
    return [cur.fileID];
  });
  await removeFiles(files);
}

// 本人看自己的照片和最近一次提交的检测状态（检测中的照片只有本人能看到预览）
async function myPhoto(_d, uid) {
  const me = await profileOf(uid);
  const photo = (me && me.photo) || '';
  let last = (await db.collection('avatar_checks').where({ uid, request: (me && me.photoRequest) || '' }).orderBy('at', 'desc').orderBy('createdAt', 'desc').limit(1).get()).data[0] || null;
  if (last && last.status === 'checking' && Date.now() - (last.at || 0) > PHOTO_CHECK_MAX_MS) {
    await expireCheck(last);
    last = await getPhotoCheck(last._id);
  }
  const state = last && (last.status === 'checking' || last.status === 'reject' || last.status === 'error') ? last.status : '';
  const pending = state === 'checking' ? last.fileID : '';
  const urls = await tempUrls([photo, pending].filter(Boolean));
  return { photo, url: urls[photo] || '', state, pending, pendingUrl: urls[pending] || '' };
}

// 球员照片临时链接：只发放同意公开展示的球员当前已通过检测的照片（players.photo），其他文件一律不给
async function photoUrls({ fileIDs }) {
  const list = Array.from(new Set((Array.isArray(fileIDs) ? fileIDs : []).filter((x) => typeof x === 'string' && /^cloud:\/\//.test(x)))).slice(0, 100);
  if (!list.length) return { files: {} };
  const owners = await byIds('players', list, 'photo');
  const ok = Array.from(new Set(owners.filter((p) => p.self && p._openid && isShown(p) && photoPathOk(p.photo, p._openid, 'player-photos')).map((p) => p.photo)));
  return { files: await tempUrls(ok) };
}

// 管理员移除某位成员的照片（不合适的照片兜底处理）：改回首字圆，删文件，留档
async function adminClearPhoto({ uid: target }, uid) {
  if (!isAdmin(uid)) deny('只有管理员可以操作');
  if (typeof target !== 'string' || !target) deny('缺少成员');
  const p = await profileOf(target);
  if (!p) deny('这位成员还没有设置资料');
  return clearPhoto(p, uid);
}

/* ---------- 活动：创建、生成签表、编辑信息、删除 ---------- */
// draws 不再允许小程序端直接写：字段由服务端逐个校验，withdrawals 等只能由对应流程写入，
// 参赛名 → 用户 ID（uidOf）只接受报名记录或本人资料能证明的对应关系。
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const intOr = (v, lo, hi) => { const n = int(v); return Number.isInteger(n) && n >= lo && n <= hi ? n : undefined; };
const plainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function cleanInfo(i) {
  i = i || {};
  return {
    date: isDate(i.date) ? i.date : today(), startTime: typeof i.startTime === 'string' && /^\d{2}:\d{2}$/.test(i.startTime) ? i.startTime : '',
    venue: E.courtOf(i.venue), location: E.locationOf(i.location),
  };
}

function cleanSettings(s) {
  s = s || {};
  if (!E.MODES[s.mode]) deny('请选择活动形式');
  const out = { mode: s.mode, type: s.type === 'double' ? 'double' : 'single' };
  const size = intOr(s.size, 2, 128), gc = intOr(s.groupCount, 1, 16), adv = intOr(s.advance, 1, 2);
  if (size !== undefined) out.size = size;
  if (gc !== undefined) out.groupCount = gc;
  if (adv !== undefined) out.advance = adv;
  if (out.mode === 'groups_ko' && out.groupCount === 1) out.advance = 2; // 只分 1 组：前 2 名打决赛
  // 组别（按性别限制报名）和报名上限（小组赛用；淘汰赛的上限就是签数）
  if (s.category === 'm' || s.category === 'f' || (s.category === 'mixed' && out.type === 'double')) out.category = s.category;
  const lim = intOr(s.limit, 2, 128);
  if (lim !== undefined && out.mode !== 'bracket') out.limit = lim;
  const r = plainObj(s.rules) ? s.rules : {};
  const legacy = E.normRule(s);
  const ko = E.normRule(r.ko, legacy);
  const rounds = {};
  Object.keys(plainObj(r.rounds) ? r.rounds : {}).forEach((k) => { if (/^\d{1,3}$/.test(k) && plainObj(r.rounds[k])) rounds[k] = E.normRule(r.rounds[k], ko); });
  out.rules = { group: E.normRule(r.group, legacy), ko, rounds };
  return Object.assign(out, legacy);
}

// 签表结构：参赛者、搭档、种子、签位 / 分组、照片、参赛名 → 用户 ID
async function cleanStructure(drawId, settings, p, uid) {
  p = p || {};
  const ents = Array.isArray(p.entrants) ? p.entrants : [];
  if (ents.length < 2 || ents.length > 128 || ents.some((e) => typeof e !== 'string' || !e || e.length > 50)) deny('参加名单不对');
  if (new Set(ents).size !== ents.length) deny('参加名单里有重复的名字');
  const isEnt = (n) => ents.indexOf(n) >= 0;
  const teams = {};
  if (settings.type === 'double') {
    ents.forEach((e) => {
      const t = plainObj(p.teams) ? p.teams[e] : null;
      if (!Array.isArray(t) || !t.length || t.length > 2 || t.some((n) => typeof n !== 'string' || !n || n.length > 20)) deny(`「${e}」的搭档不对`);
      if (e !== E.teamLabel(t)) deny('双打队伍名必须由队员名字组成');
      teams[e] = t.slice();
    });
  }
  const people = settings.type === 'double' ? [].concat(...Object.values(teams)) : ents.slice();
  if (new Set(people).size !== people.length) deny('同一名球员不能出现在两个位置');
  const seeds = (Array.isArray(p.seeds) ? p.seeds : []).filter(isEnt);
  const slot = (x) => {
    if (x === null) return null;
    if (plainObj(x) && x.bye === true && x.name === undefined) return { bye: true }; // 轮空签位
    if (plainObj(x) && isEnt(x.name)) return Number.isInteger(x.seed) ? { name: x.name, seed: x.seed } : { name: x.name };
    return deny('签位不对');
  };
  const out = { entrants: ents.slice(), seeds, teams, results: {} };
  if (E.hasGroups(settings)) {
    if (!Array.isArray(p.groups) || !p.groups.length || p.groups.length > 16) deny('分组不对');
    out.groups = p.groups.map((g, i) => {
      if (!plainObj(g) || !Array.isArray(g.members)) deny('分组不对');
      return { name: `${String.fromCharCode(65 + i)} 组`, members: g.members.map(slot) };
    });
    const placed = [].concat(...out.groups.map((g) => g.members.map((x) => x.name)));
    if (placed.length !== ents.length || new Set(placed).size !== ents.length) deny('每位参加者必须恰好在一个小组里');
  } else {
    if (!Array.isArray(p.lines) || p.lines.length < 2 || p.lines.length > 128 || (p.lines.length & (p.lines.length - 1))) deny('对阵表不对');
    out.lines = p.lines.map(slot);
    const placed = out.lines.filter((x) => x && x.name).map((x) => x.name);
    if (placed.length !== ents.length || new Set(placed).size !== ents.length) deny('每位参加者必须恰好有一个签位');
  }
  // 照片：只收 avatars/ 下的 fileID（显示时再换临时链接）
  out.avatars = {};
  if (plainObj(p.avatars)) Object.keys(p.avatars).forEach((n) => { const v = p.avatars[n]; if (people.indexOf(n) >= 0 && typeof v === 'string' && /^cloud:\/\/[^/]+\/avatars\//.test(v)) out.avatars[n] = v; });
  // 参赛名 → 用户 ID：必须能被报名记录（本人写的）或该账号当前的本人资料证明，否则不绑定
  const want = plainObj(p.uidOf) ? p.uidOf : {};
  const pairs = Object.keys(want).filter((n) => people.indexOf(n) >= 0 && typeof want[n] === 'string' && want[n]).map((n) => [n, want[n]]);
  const [su, profs] = await Promise.all([
    drawId ? db.collection('signups').where({ drawId }).limit(1000).get().then((r) => r.data) : [],
    byIds('players', pairs.map((x) => x[1]), '_openid'),
  ]);
  const nameNow = {};
  profs.filter((x) => x.self).sort((a, b) => tsOf(a) - tsOf(b)).forEach((x) => { if (!(x._openid in nameNow)) nameNow[x._openid] = x.name; });
  const proven = (n, u) => nameNow[u] === n || su.some((s) => (s.name === n && s._openid === u) || (s.partner === n && s.partnerId === u));
  out.uidOf = {};
  const used = {};
  pairs.forEach(([n, u]) => {
    if (!proven(n, u)) return;
    if (used[u]) deny(`同一个账号不能同时是「${used[u]}」和「${n}」`);
    used[u] = n; out.uidOf[n] = u;
  });
  // 前端手动添加球员不是唯一入口；绕过前端直接发名单也必须先检测。
  const batches = [''];
  people.forEach((name) => {
    if (batches[batches.length - 1].length + name.length + 1 > 2000) batches.push('');
    batches[batches.length - 1] += name + '\n';
  });
  await Promise.all(batches.map((text) => requireSafeText(text.trim(), uid, '参加名单')));
  return out;
}

async function ownDraw(drawId, uid) {
  const d = await loadDraw(drawId);
  if (d._openid !== uid) deny('只有活动发起人可以操作');
  return d;
}
// 编辑活动信息、删除活动：发起人或管理员（环境变量 ADMIN_OPENIDS）。
// 管理员的这些操作都留档；签表、录分、裁定、退赛等其他活动操作仍然只有发起人能做。
async function manageDraw(drawId, uid) {
  const d = await loadDraw(drawId);
  const owner = d._openid === uid;
  if (!owner && !isAdmin(uid)) deny('只有活动发起人或管理员可以操作');
  return { d, owner, asAdmin: !owner };
}

// 创建球友活动：只有设置（开放报名），或连同签表一起（直接生成）
async function createDraw({ draw }, uid) {
  const p = plainObj(draw) ? draw : {};
  const settings = cleanSettings(p);
  const doc = Object.assign({}, settings, cleanInfo(p), { results: {} });
  doc.title = await checkedTitle(p.title, uid);
  if (Array.isArray(p.entrants)) Object.assign(doc, await cleanStructure('', settings, p, uid), { status: 'drawn' });
  else doc.status = 'signup';
  const r = await db.collection('draws').add({ data: Object.assign(doc, { _openid: uid, createdAt: db.serverDate() }) });
  return { id: r._id };
}

// 报名截止后生成签表；已经开始录分、登记过退赛的活动不能重新生成（会让已有比分对不上）
async function generateDraw({ drawId, draw }, uid) {
  const d = await ownDraw(drawId, uid);
  if (d.status !== 'signup') {
    if ((d.withdrawals || []).length) deny('已经登记过退赛，不能重新生成对阵表');
    if ((await officialEventMatches(drawId)).length) deny('已经有比赛录分了，不能重新生成对阵表');
  }
  const settings = cleanSettings(d); // 活动形式和规则在创建时就定了，这里不接受修改
  const s = await cleanStructure(drawId, settings, plainObj(draw) ? draw : {}, uid);
  const data = Object.assign({}, s, { status: 'drawn', results: _.set({}), teams: _.set(s.teams), avatars: _.set(s.avatars), uidOf: _.set(s.uidOf), slots: _.set({}) }); // 重新生成签表：原来的单场安排作废
  if (s.groups) { data.groups = _.set(s.groups); data.lines = _.remove(); } else { data.lines = _.set(s.lines); data.groups = _.remove(); }
  await db.collection('draws').doc(drawId).update({ data });
  return { id: drawId };
}

async function updateDrawInfo({ drawId, info }, uid) {
  const { d, asAdmin } = await manageDraw(drawId, uid);
  const i = plainObj(info) ? info : {};
  const c = cleanInfo(i);
  const title = await checkedTitle(i.title, uid);
  await db.collection('draws').doc(drawId).update({ data: Object.assign({ title }, c, { location: c.location ? _.set(c.location) : null, updatedAt: db.serverDate(), updatedBy: uid }) });
  if (asAdmin) {
    const pick = (x) => ({ title: x.title || '', date: x.date || '', startTime: x.startTime || '', venue: x.venue || '' });
    await logAction({ type: 'adminEditDraw', drawId, by: uid, before: pick(d), after: pick(Object.assign({ title }, c)) });
  }
  return {};
}

// 单场安排：这一场具体哪天、几点、哪片场地（draws.slots，按场次位置存）。只有发起人能排；
// 对阵还没确定的场次也可以先排。三项都清空 = 取消这一场的安排（沿用活动的日期、时间和场地）
async function setFixtureSlot({ drawId, key, slot }, uid) {
  const d = await ownDraw(drawId, uid);
  if (d.status === 'signup') deny('对阵表生成后才能安排比赛');
  if (typeof key !== 'string' || !key) deny('缺少比赛');
  if (!E.findFixture(d, await officialEventMatches(drawId), key)) deny('找不到这场比赛，对阵表可能已经重新生成');
  const s = plainObj(slot) ? slot : {};
  const clean = { date: isDate(s.date) ? s.date : '', time: typeof s.time === 'string' && /^\d{2}:\d{2}$/.test(s.time) ? s.time : '', court: E.courtOf(s.court) };
  const slots = Object.assign({}, plainObj(d.slots) ? d.slots : {});
  if (clean.date || clean.time || clean.court) slots[key] = clean; else delete slots[key];
  await db.collection('draws').doc(drawId).update({ data: { slots: _.set(slots) } });
  return { slot: slots[key] || null };
}

// 删除活动：软删除（签表从所有列表消失，已录比分照常保留在战绩里，参赛名 → ID 的对应也还在，确认 / 评价不受影响）。
// 旧的联系人数据（个人信息）直接删除；活动相册的照片文件和记录一起删除；还没处理的申请作废；留档。
// 管理员删除别人的活动必须填原因（留档）
async function removeDraw({ drawId, reason }, uid) {
  const { d, asAdmin } = await manageDraw(drawId, uid);
  const why = cleanReason(reason, asAdmin);
  await db.collection('draws').doc(drawId).update({ data: { deleted: true, deletedBy: uid, deletedAt: db.serverDate(), deleteReason: why, deletedByAdmin: asAdmin } });
  await db.collection('event_contacts').doc(drawId).remove().catch(() => {});
  await db.collection('requests').where({ drawId, status: 'pending' }).update({ data: { status: 'cancelled', handleNote: '活动已删除', handledAt: db.serverDate() } });
  const photos = await removeEventPhotos(drawId);
  await logAction({ type: 'deleteDraw', drawId, by: uid, byAdmin: asAdmin, reason: why, photos });
  return { photos: { removed: photos.removed, failed: photos.failed } };
}

// 删除一个活动的全部照片：先删云存储文件（每次最多 50 个），删成功的再删记录。
// 删失败的：记录保留（活动已删除，没人能看到），fileID 写进处理记录，方便在云开发控制台手动清理
async function removeEventPhotos(drawId) {
  const list = await byIds('event_photos', [drawId], 'drawId');
  let removed = 0;
  const failed = [];
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    let status = {};
    try {
      const r = await cloud.deleteFile({ fileList: chunk.map((p) => p.fileID) });
      (r.fileList || []).forEach((f) => { status[f.fileID] = f.status; });
    } catch (e) { console.error('删除活动照片文件失败', drawId, e && (e.errMsg || e.message)); status = {}; }
    for (const p of chunk) {
      if (status[p.fileID] === 0) { await db.collection('event_photos').doc(p._id).remove().catch(() => {}); removed++; }
      else failed.push(p.fileID);
    }
  }
  return { removed, failed: failed.length, failedFiles: failed.slice(0, 200) };
}

/* ---------- 共用：审计记录、作废记录、局分校验 ---------- */
// requests 集合（仅管理端可读写）：改分申请、退赛申请，以及发起人的裁定 / 弃权 / 退赛处理记录
//   状态 pending → processing（领取，原子操作防并发）→ accepted / rejected / ruled / cancelled / stale / done
// 原因只能是固定选项（E.REASONS），不接受手写文字；所以也不需要内容检测
const cleanReason = (r, need) => {
  const t = typeof r === 'string' ? r.trim() : '';
  if (!t) { if (need) deny('请选择原因'); return ''; }
  const ok = E.reasonOf(t);
  if (!ok) deny('原因只能从固定选项里选择');
  return ok;
};
async function logAction(data) {
  await db.collection('requests').add({ data: Object.assign({ status: 'done', createdAt: db.serverDate(), handledAt: db.serverDate() }, data) });
}
// 领取一条待处理的申请：只有一个人能领到（where + update 是原子的），重复点击 / 两人同时处理都只生效一次
async function claim(id, uid) {
  const r = await db.collection('requests').where({ _id: id, status: 'pending' }).update({ data: { status: 'processing', claimedBy: uid, claimedAt: db.serverDate() } });
  return !!(r && r.stats && r.stats.updated);
}
const release = (id) => db.collection('requests').doc(id).update({ data: { status: 'pending', claimedBy: '' } });
const finish = (id, data) => db.collection('requests').doc(id).update({ data: Object.assign({ handledAt: db.serverDate() }, data) });
// 同一个锁 id 上一次的申请已经处理完：先归档，再给新申请用
async function freeLock(id) {
  const old = await getDoc('requests', id);
  if (!old) return;
  if (old.status === 'pending' || old.status === 'processing') deny('已经有一条待处理的申请，请等对方处理');
  const copy = Object.assign({}, old); delete copy._id;
  await db.collection('requests').add({ data: Object.assign(copy, { archivedFrom: id }) });
  await db.collection('requests').doc(id).remove();
}

// 受影响的后续比赛记录：删除（连同确认和快照），快照写进处理记录里留底
async function voidRecords(ids) {
  const out = [];
  for (const id of ids) {
    const m = await getDoc('matches', id);
    if (!m) continue;
    out.push({ id, drawKey: m.drawKey || '', a: m.a, b: m.b, sets: m.sets, winner: m.winner, outcome: m.outcome || 'normal' });
    await db.collection('matches').doc(id).remove();
    await db.collection('confirms').where({ matchId: id }).remove();
    await db.collection('verified').doc(id).remove().catch(() => {});
  }
  return out;
}

function parseSets(sets, partial) {
  if (!Array.isArray(sets) || sets.length > 3 || (!partial && !sets.length)) deny('请填写局分');
  return sets.map((x) => {
    const o = { a: int(x && x.a), b: int(x && x.b), tbA: x && x.tbA !== undefined ? String(x.tbA) : '', tbB: x && x.tbB !== undefined ? String(x.tbB) : '' };
    if (!Number.isInteger(o.a) || !Number.isInteger(o.b) || o.a < 0 || o.b < 0 || o.a > 13 || o.b > 13) deny('局分不对');
    return o;
  });
}
function checkedScore(sets, rule) {
  const res = RULES.checkMatch(parseSets(sets), rule.bestOf, rule);
  if (!res.ok) deny(res.msg);
  return res;
}
// 一场比赛适用的规则：活动按阶段 / 轮次；日常比赛就是录入时选的
async function ruleOfMatch(m) {
  if (m.drawId && m.drawKey) { const d = await getDoc('draws', m.drawId); if (d) { d._id = m.drawId; return E.ruleFor(d, m.drawKey); } }
  return { setGames: m.setGames === 6 ? 6 : 4, noAd: m.noAd !== false, bestOf: m.bestOf === 3 ? 3 : 1 };
}

/* ---------- 活动录分 ---------- */
// 双方和规则都由服务端按签表 / 赛程计算：前端只传「哪一场」和局分。
// 每一场固定一条记录（_id 由活动和场次决定），改比分就是覆盖这一条，不会出现两条。
const evId = (drawId, key) => 'ev_' + md5(`${drawId}#${key}`);
const int = (v) => (typeof v === 'number' ? v : parseInt(v, 10));

async function loadFixture(drawId, key) {
  if (typeof drawId !== 'string' || typeof key !== 'string') deny('缺少比赛');
  const draw = await getDoc('draws', drawId);
  if (!draw) deny('活动不存在');
  if (draw.deleted) deny('活动已删除');
  if (draw.status === 'signup') deny('活动还在报名，对阵表生成后才能录分');
  draw._id = drawId;
  const list = await officialEventMatches(drawId);
  const f = E.findFixture(draw, list, key);
  if (!f) deny('找不到这场比赛，对阵表可能已经重新生成');
  return { draw, list, f };
}

// 写入一场活动比分（正常 / 弃权 / 中途退赛）。会先算出对后续已录分场次的影响：
//   有影响时普通参赛者不能改；发起人要看过影响清单、带 confirmImpact 和原因再提交，受影响的记录会被作废并留档
async function writeFixture({ draw, list, f }, data, opts) {
  const id = evId(draw._id, f.key);
  const map = await drawUidMap(draw._id, {});
  const doc = Object.assign({
    type: E.ruleFor(draw, f.key).type, a: f.aMembers, b: f.bMembers,
    aIds: f.aMembers.map((n) => map[n] || ''), bIds: f.bMembers.map((n) => map[n] || ''),
    drawId: draw._id, drawKey: f.key, ea: f.a, eb: f.b, drawTitle: E.titleOf(draw), stage: f.stage,
  }, data);
  const after = list.filter((m) => m.drawKey !== f.key).concat([Object.assign({ _id: id, createdAt: Date.now() }, doc)]);
  const impact = E.impactOf(draw, list, draw, after, f.key);
  if (impact.length) {
    if (!opts.owner) deny(`这场比分会改变后续已录分的比赛（${impact.map((x) => x.stage + ' ' + x.a + ' vs ' + x.b).join('、')}），需由活动发起人处理`);
    if (!opts.confirmImpact) return { needConfirm: true, impact };
    if (!opts.reason) deny('影响后续比赛时必须填写原因');
  }
  const old = list.find((m) => m.drawKey === f.key) || null;
  await db.collection('matches').doc(id).set({ data: Object.assign(doc, { createdAt: db.serverDate() }) });
  // 升级前小程序端写的同一场旧记录：删掉，保证一场只有一条
  const dup = (await db.collection('matches').where({ drawId: draw._id, drawKey: f.key }).get()).data.filter((m) => m._id !== id);
  const replaced = await voidRecords(dup.map((m) => m._id));
  const voided = impact.length ? await voidRecords(impact.map((x) => x.recordId)) : [];
  return { matchId: id, winner: doc.winner, replaced: replaced.length, voided, previous: old ? { sets: old.sets, winner: old.winner, outcome: old.outcome || 'normal' } : null };
}

async function recordEventMatch({ drawId, key, date, sets, confirmImpact, reason }, uid) {
  const ctx = await loadFixture(drawId, key);
  const { draw, f } = ctx;
  if (!f.ready) deny(f.void ? '这场比赛因退赛已取消' : '对手还没确定，等上一轮打完再录分');
  const map = await drawUidMap(drawId, {});
  const owner = draw._openid === uid;
  if (!owner && f.aMembers.concat(f.bMembers).map((n) => map[n] || '').indexOf(uid) < 0) deny('只有这场的球员或活动发起人可以录分');
  // 已双方确认的比分不能直接覆盖，只能走「申请修改比分」；有待处理申请时也不能改
  const cur = f.recordId ? await getDoc('matches', f.recordId) : null;
  if (cur) {
    if ((cur.outcome || 'normal') !== 'normal' && !owner) deny('这场已由发起人按弃权 / 退赛处理，如有异议请联系发起人');
    if ((cur.outcome || 'normal') === 'normal' && (await confirmState(cur, await sidesOf(cur, {}))).confirmed) deny('比分已经双方确认，如需修改请在比赛详情里「申请修改比分」');
    const pend = await getDoc('requests', 'sc_' + cur._id);
    if (pend && (pend.status === 'pending' || pend.status === 'processing')) deny('这场有待处理的改分申请，处理完之前不能改比分');
  }
  const rule = E.ruleFor(draw, key);
  const res = checkedScore(sets, rule);
  const r = await writeFixture(ctx, {
    date: /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : today(),
    bestOf: rule.bestOf, setGames: rule.setGames, noAd: rule.noAd,
    sets: res.sets, winner: res.winner, setsWon: res.won, outcome: 'normal', recordedBy: uid,
  }, { owner, confirmImpact, reason: cleanReason(reason, !!confirmImpact) });
  if (r.needConfirm) return r;
  if (r.voided.length) await logAction({ type: 'impact', drawId, drawKey: key, matchId: r.matchId, by: uid, reason: cleanReason(reason), voided: r.voided });
  // 改分留档：这一场原来已经有比分、这次改了（第一次录分不记）
  const prev = r.previous;
  if (prev && (OF.canon(prev.sets || []) !== OF.canon(res.sets) || prev.winner !== res.winner || prev.outcome !== 'normal')) {
    await logAction({ type: 'edit', drawId, drawKey: key, matchId: r.matchId, by: uid, from: prev, to: { sets: res.sets, winner: res.winner } });
  }
  return r;
}

// 发起人处理一场活动：赛前弃权（不填局分）/ 中途退赛（填实际已打局分）。必须填原因，留档
async function resolveFixture({ drawId, key, kind, loser, reason, sets, date, confirmImpact }, uid) {
  const ctx = await loadFixture(drawId, key);
  const { draw, f } = ctx;
  if (draw._openid !== uid) deny('只有活动发起人可以判弃权 / 退赛');
  if (!f.ready) deny(f.void ? '这场比赛因退赛已取消' : '对手还没确定，不能处理');
  if (kind !== 'walkover' && kind !== 'retired') deny('请选择弃权或中途退赛');
  if (loser !== 'a' && loser !== 'b') deny('请选择弃权 / 退赛的一方');
  const why = cleanReason(reason, true);
  const rule = E.ruleFor(draw, key);
  let played = [];
  if (kind === 'retired') {
    played = parseSets(sets || [], true).map((x) => {
      const o = { a: x.a, b: x.b };
      if (x.tbA !== '' && x.tbB !== '') { o.tbA = int(x.tbA); o.tbB = int(x.tbB); }
      return o;
    });
    if (!played.length) deny('中途退赛请填写实际已打的局分');
  }
  const winner = loser === 'a' ? 'b' : 'a';
  const r = await writeFixture(ctx, {
    date: /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : today(),
    bestOf: rule.bestOf, setGames: rule.setGames, noAd: rule.noAd,
    sets: played, winner, setsWon: { a: 0, b: 0 }, outcome: kind, recordedBy: uid,
    resolution: { type: kind, side: loser, reason: why, by: uid, at: Date.now() },
  }, { owner: true, confirmImpact, reason: why });
  if (r.needConfirm) return r;
  await logAction({ type: kind, drawId, drawKey: key, matchId: r.matchId, by: uid, side: loser, entrant: loser === 'a' ? f.a : f.b, reason: why, previous: r.previous, voided: r.voided });
  return r;
}

/* ---------- 比分纠错 ---------- */
// 日常比赛：录入后直接生效；录入人和参赛者都可以直接改（改完立即生效）。
// 已经锁定的比分（以前双方确认过的、管理员更正过的）不能直接改，只能申请修改或找管理员
async function editMatchScore({ matchId, sets }, uid) {
  const { m, fin, ids } = await loadMatch(matchId, uid, {});
  if (fin) deny(fin);
  if (m.drawId) deny('活动比赛请在对阵表 / 场次里点这一场修改');
  if (recorderOf(m) !== uid && !sideOf(ids, uid)) deny('只有录入人或这场比赛的参加者可以修改比分');
  if ((await confirmState(m, ids)).confirmed) deny('比分已经锁定（双方确认过或管理员更正过），请「申请修改比分」');
  const res = checkedScore(sets, await ruleOfMatch(m));
  if (OF.canon(res.sets) === OF.canon(m.sets || []) && res.winner === m.winner) return { ok: true }; // 没有变化：不写、不留档
  await db.collection('matches').doc(m._id).update({ data: { sets: res.sets, winner: res.winner, setsWon: res.won, editedAt: db.serverDate(), lastChange: { how: 'edit', by: uid, at: Date.now() } } });
  // 改分留档：谁改的、改前改后的比分（直接改立即生效，出现争议时可以查）
  await logAction({ type: 'edit', matchId: m._id, by: uid, from: { sets: m.sets || [], winner: m.winner }, to: { sets: res.sets, winner: res.winner } });
  return { ok: true };
}

// 管理员更正比分（日常比赛和活动比赛都可以）：不需要填原因，直接生效并留档（谁改的、改前改后的比分）。
// 更正后的比分算双方确认（锁定），这场待处理的改分申请随之失效。
// 活动比赛：会改变后续已录分的场次时先返回 { needConfirm, impact }，带 confirmImpact 再提交，受影响的比分作废并留档。
// 只改正常比分；弃权 / 退赛的处理、签表、退赛申请仍然只有发起人能做。
async function adminFixScore({ matchId, sets, reason, confirmImpact }, uid) {
  if (!isAdmin(uid)) deny('只有管理员可以操作');
  const { m, fin } = await loadMatch(matchId, uid, {});
  if (!m) deny('比赛记录不存在');
  if (fin) deny(fin);
  const event = !!m.drawId;
  if (event && !m.drawKey) deny('这条活动记录没有对应的场次，不能更正');
  if (await supersededBy(m)) deny('这条比分已被新的记录取代');
  const why = cleanReason(reason);
  const res = checkedScore(sets, await ruleOfMatch(m));
  if (OF.canon(res.sets) === OF.canon(m.sets || []) && res.winner === m.winner) deny('新比分和原比分一样');
  const ctx = event ? await loadFixture(m.drawId, m.drawKey) : null;
  const reqId = 'sc_' + m._id;
  const pend = await getDoc('requests', reqId);
  const open = !!pend && (pend.status === 'pending' || pend.status === 'processing');
  if (open && !(await claim(reqId, uid))) deny('这场的改分申请正在处理中，请稍后再试');
  let newId = m._id, voided = [];
  try {
    const lastChange = { how: 'admin', by: uid, at: Date.now() };
    if (event) {
      const r = await writeFixture(ctx, {
        date: m.date, bestOf: m.bestOf, setGames: m.setGames, noAd: m.noAd, recordedBy: m.recordedBy || recorderOf(m),
        sets: res.sets, winner: res.winner, setsWon: res.won, outcome: 'normal', lastChange,
      }, { owner: true, confirmImpact, reason: why || '管理员更正比分' });
      if (r.needConfirm) { if (open) await release(reqId); return r; }
      newId = r.matchId; voided = r.voided || [];
      const nm = await getDoc('matches', newId);
      await db.collection('matches').doc(newId).update({ data: { rulingSig: sigOf(nm), ruledBy: uid } });
    } else {
      await db.collection('matches').doc(m._id).update({ data: { sets: res.sets, winner: res.winner, setsWon: res.won, editedAt: db.serverDate(), lastChange } });
      const nm = await getDoc('matches', m._id);
      await db.collection('verified').doc(nm._id).set({ data: { snap: OF.snapOf(nm), adminSig: sigOf(nm), at: db.serverDate() } });
    }
    if (open) await finish(reqId, { status: 'stale', handledBy: uid, handleNote: '管理员已更正比分' });
  } catch (e) { if (open && (await getDoc('requests', reqId) || {}).status === 'processing') await release(reqId); throw e; }
  await logAction({ type: 'adminScore', matchId: newId, drawId: m.drawId || '', drawKey: m.drawKey || '', by: uid, byAdmin: true, reason: why, from: { sets: m.sets || [], winner: m.winner }, to: { sets: res.sets, winner: res.winner }, voided });
  return { ok: true, matchId: newId, voided };
}

// 已双方确认的比分：参赛者提交修改申请（新比分 + 原因）；处理前正式战绩、排名、晋级都不变
async function requestScoreChange({ matchId, sets, reason }, uid) {
  const { m, fin, ids, side } = await loadMatch(matchId, uid, {});
  if (fin) deny(fin);
  if (!side) deny('只有这场比赛的参加者可以申请修改比分');
  if (await supersededBy(m)) deny('这条比分已被新的记录取代');
  const st = await confirmState(m, ids);
  if (!st.confirmed) deny(m.drawId ? '比分还没有双方确认，可以直接在场次里修改' : '日常比赛的比分可以直接修改，不用申请');
  const why = cleanReason(reason, true);
  const res = checkedScore(sets, await ruleOfMatch(m));
  if (OF.canon(res.sets) === OF.canon(m.sets || []) && res.winner === m.winner) deny('新比分和原比分一样');
  const id = 'sc_' + m._id;
  await freeLock(id);
  try {
    await db.collection('requests').add({
      data: {
        _id: id, type: 'score', matchId: m._id, drawId: m.drawId || '', drawKey: m.drawKey || '', baseSig: st.sig,
        from: { sets: m.sets || [], winner: m.winner }, to: { sets: res.sets, winner: res.winner, setsWon: res.won },
        reason: why, requesterId: uid, requesterSide: side, status: 'pending', createdAt: db.serverDate(),
      },
    });
  } catch (e) { deny('已经有一条待处理的申请，请等对方处理'); }
  return { requestId: id };
}

// 把申请里的新比分写进比赛记录；活动比赛会检查对后续场次的影响
async function applyScoreChange(m, req, how, uid, opts) {
  const to = req.to;
  if (m.drawId && m.drawKey) {
    const ctx = await loadFixture(m.drawId, m.drawKey);
    const r = await writeFixture(ctx, Object.assign({}, {
      date: m.date, bestOf: m.bestOf, setGames: m.setGames, noAd: m.noAd, recordedBy: m.recordedBy || recorderOf(m),
      sets: to.sets, winner: to.winner, setsWon: to.setsWon, outcome: 'normal',
      lastChange: { requestId: req._id, how, by: uid, at: Date.now() },
    }), { owner: how === 'rule', confirmImpact: opts.confirmImpact, reason: opts.reason });
    if (r.needConfirm) return r;
    const nm = await getDoc('matches', r.matchId);
    const ids = await sidesOf(nm, {});
    const sig = sigOf(nm);
    if (how === 'rule') await db.collection('matches').doc(nm._id).update({ data: { rulingSig: sig, ruledBy: uid } });
    else await addConfirms(nm, sig, ids, [req.requesterId, uid]);
    return r;
  }
  await db.collection('matches').doc(m._id).update({ data: { sets: to.sets, winner: to.winner, setsWon: to.setsWon, lastChange: { requestId: req._id, how, by: uid, at: Date.now() } } });
  const nm = await getDoc('matches', m._id);
  const ids = await sidesOf(nm, {});
  const sig = sigOf(nm);
  await addConfirms(nm, sig, ids, [req.requesterId, uid]);
  if ((await confirmState(nm, ids)).confirmed) await markVerified(nm); // 日常比赛：新比分双方认可，更新正式战绩快照
  return { matchId: nm._id, voided: [] };
}
async function addConfirms(m, sig, ids, uids) {
  for (const u of uids) {
    const sd = sideOf(ids, u);
    if (!sd) continue;
    await db.collection('confirms').add({ data: { _id: md5(`${m._id}|${u}|${sig}`), matchId: m._id, sig, side: sd, openid: u, createdAt: db.serverDate() } }).catch(() => {});
  }
}

async function loadRequest(requestId, type) {
  const req = typeof requestId === 'string' && requestId ? await getDoc('requests', requestId) : null;
  if (!req || req.type !== type) deny('申请不存在');
  if (req.status !== 'pending') deny('这条申请已经处理过了');
  return req;
}
// 比分在申请之后又变了：申请失效（避免拿旧申请覆盖新比分）
async function stillSame(req) {
  const m = await getDoc('matches', req.matchId);
  if (!m || sigOf(m) !== req.baseSig) { await finish(req._id, { status: 'stale' }); return null; }
  return m;
}

// 对方同意 / 拒绝
async function respondScoreChange({ requestId, accept, note }, uid) {
  const req = await loadRequest(requestId, 'score');
  const m0 = await getDoc('matches', req.matchId);
  if (!m0) deny('比赛记录不存在');
  const ids = await sidesOf(m0, {});
  const my = sideOf(ids, uid);
  if (!my || my === req.requesterSide) deny('只有对方球员可以同意或拒绝这条申请');
  const noteText = cleanReason(note);
  if (!(await claim(requestId, uid))) deny('这条申请已经处理过了');
  try {
    const m = await stillSame(req);
    if (!m) deny('比分已经变动，这条申请失效了');
    if (!accept) {
      await finish(requestId, { status: 'rejected', handledBy: uid, handleNote: noteText });
      return { status: 'rejected' };
    }
    const r = await applyScoreChange(m, req, 'accept', uid, {});
    await finish(requestId, { status: 'accepted', handledBy: uid, handleNote: noteText, voided: r.voided || [] });
    return { status: 'accepted' };
  } catch (e) { if ((await getDoc('requests', requestId) || {}).status === 'processing') await release(requestId); throw e; }
}

// 活动发起人裁定（必须填原因）；日常比赛没有发起人，不能单方面裁定
async function ruleScoreChange({ requestId, accept, reason, confirmImpact }, uid) {
  const req = await loadRequest(requestId, 'score');
  if (!req.drawId) deny('日常比赛没有活动发起人，只能由对方同意或拒绝');
  const draw = await getDoc('draws', req.drawId);
  if (!draw || draw._openid !== uid) deny('只有活动发起人可以裁定');
  const why = cleanReason(reason, true);
  if (!(await claim(requestId, uid))) deny('这条申请已经处理过了');
  try {
    const m = await stillSame(req);
    if (!m) deny('比分已经变动，这条申请失效了');
    if (!accept) {
      await finish(requestId, { status: 'rejected', handledBy: uid, handleNote: why, ruling: true });
      return { status: 'rejected' };
    }
    const r = await applyScoreChange(m, req, 'rule', uid, { confirmImpact, reason: why });
    if (r.needConfirm) { await release(requestId); return r; }
    await finish(requestId, { status: 'ruled', handledBy: uid, handleNote: why, ruling: true, voided: r.voided || [] });
    return { status: 'ruled', voided: r.voided || [] };
  } catch (e) { if ((await getDoc('requests', requestId) || {}).status === 'processing') await release(requestId); throw e; }
}

async function cancelScoreChange({ requestId }, uid) {
  const req = await loadRequest(requestId, 'score');
  if (req.requesterId !== uid) deny('只有申请人可以撤回');
  if (!(await claim(requestId, uid))) deny('这条申请已经处理过了');
  await finish(requestId, { status: 'cancelled', handledBy: uid });
  return { status: 'cancelled' };
}

// 比赛详情里显示的申请状态
async function requestView(m, ids, uid, cache) {
  const req = await cget(cache, 'requests', 'sc_' + m._id);
  if (!req || (req.status !== 'pending' && req.status !== 'processing')) return null;
  const draw = m.drawId ? await cget(cache, 'draws', m.drawId) : null;
  const my = sideOf(ids, uid);
  const canSeeReason = req.requesterId === uid || !!my || (!!draw && draw._openid === uid);
  return {
    id: req._id, reason: canSeeReason ? E.reasonOf(req.reason) : '', from: E.scoreText(req.from.sets), to: E.scoreText(req.to.sets), toWinner: req.to.winner,
    requester: await nameOf(req.requesterId, '球友', (cache && cache.names) || {}), mine: req.requesterId === uid,
    canRespond: !!my && my !== req.requesterSide, canRule: !!draw && draw._openid === uid, canCancel: req.requesterId === uid,
    daily: !m.drawId,
  };
}

/* ---------- 退赛 ---------- */
// 报名阶段：直接取消报名（小程序端 cancelSignup）。签表生成后：球员提交申请，由发起人处理；发起人也可以直接登记
async function entrantsOf(draw, uid) {
  const map = await drawUidMap(draw._id, {});
  const teams = draw.teams || {};
  return (draw.entrants || []).filter((e) => (teams[e] || [e]).some((n) => map[n] === uid));
}
async function requestWithdraw({ drawId, reason }, uid) {
  const draw = await loadDraw(drawId);
  if (draw.status === 'signup') deny('还在报名阶段，直接「取消报名」即可');
  const ents = await entrantsOf(draw, uid);
  if (!ents.length) deny('你不在这个活动的参加名单里');
  const wd = E.withdrawalsOf(draw);
  const entrant = ents.find((e) => !wd[e]);
  if (!entrant) deny('你已经退赛了');
  const why = cleanReason(reason, true);
  const id = 'wd_' + md5(`${drawId}#${entrant}`);
  await freeLock(id);
  try {
    await db.collection('requests').add({ data: { _id: id, type: 'withdraw', drawId, entrant, requesterId: uid, reason: why, status: 'pending', createdAt: db.serverDate() } });
  } catch (e) { deny('已经提交过退赛申请，请等发起人处理'); }
  return { requestId: id };
}

// 发起人处理退赛（审批申请，或直接登记）：必须填原因；小组赛必须明确选择处理方式
async function handleWithdraw({ drawId, entrant, requestId, approve, policy, reason, confirmImpact }, uid) {
  const draw = await loadDraw(drawId);
  if (draw._openid !== uid) deny('只有活动发起人可以处理退赛');
  const why = cleanReason(reason, true);
  let req = null;
  if (requestId) {
    req = await loadRequest(requestId, 'withdraw');
    if (req.drawId !== drawId) deny('申请不属于这个活动');
    entrant = req.entrant;
    if (!(await claim(requestId, uid))) deny('这条申请已经处理过了');
  }
  try {
    if (!entrant || (draw.entrants || []).indexOf(entrant) < 0) deny('参加者不存在');
    if (!approve) {
      if (!req) deny('请选择要处理的申请');
      await finish(requestId, { status: 'rejected', handledBy: uid, handleNote: why });
      return { status: 'rejected' };
    }
    const wd = E.withdrawalsOf(draw);
    if (wd[entrant]) deny('已经登记过退赛');
    const list = await officialEventMatches(drawId);
    // 判断在哪个阶段退赛：小组赛还有没打完的场次 → 小组赛退赛（必须选处理方式），否则按淘汰赛处理
    let stage = 'ko';
    const sched = E.scheduleOf(draw, list);
    if (E.hasGroups(draw)) {
      const groupLeft = sched.some((x) => /^g/.test(x.key) && !x.done);
      if (groupLeft || draw.mode === 'groups') stage = 'group';
    }
    if (stage === 'group' && policy !== 'walkover' && policy !== 'void') deny('分组循环阶段退赛请选择处理方式：未赛场次判对手弃权胜，或取消该球员全部小组成绩');
    const entry = { entrant, stage, policy: stage === 'group' ? policy : 'walkover', reason: why, by: uid, at: Date.now(), requestId: requestId || '' };
    const draw2 = Object.assign({}, draw, { withdrawals: (draw.withdrawals || []).concat([entry]) });
    // 小组赛「未赛判弃权」：把 TA 没打的小组赛写成弃权记录（每场一条，不伪造局分）
    const woRecords = [];
    if (stage === 'group' && policy === 'walkover') {
      sched.filter((x) => /^g/.test(x.key) && !x.done && (x.a === entrant || x.b === entrant)).forEach((x) => {
        const loser = x.a === entrant ? 'a' : 'b';
        woRecords.push({ x, loser });
      });
    }
    const fake = woRecords.map(({ x, loser }) => ({ _id: evId(drawId, x.key), drawId, drawKey: x.key, ea: x.a, eb: x.b, a: x.aMembers, b: x.bMembers, winner: loser === 'a' ? 'b' : 'a', sets: [], outcome: 'walkover', createdAt: Date.now() }));
    const impact = E.impactOf(draw, list, draw2, list.concat(fake));
    if (impact.length && !confirmImpact) { if (req) await release(requestId); return { needConfirm: true, impact }; }
    await db.collection('draws').doc(drawId).update({ data: { withdrawals: draw2.withdrawals } });
    const ctx2 = { draw: draw2, list: await officialEventMatches(drawId) };
    for (const { x, loser } of woRecords) {
      const f = E.findFixture(draw2, ctx2.list, x.key) || x;
      const rule = E.ruleFor(draw2, x.key);
      await writeFixture({ draw: draw2, list: ctx2.list, f }, {
        date: today(), bestOf: rule.bestOf, setGames: rule.setGames, noAd: rule.noAd,
        sets: [], winner: loser === 'a' ? 'b' : 'a', setsWon: { a: 0, b: 0 }, outcome: 'walkover', recordedBy: uid,
        resolution: { type: 'withdraw', side: loser, reason: why, by: uid, at: Date.now() },
      }, { owner: true, confirmImpact: true, reason: why });
    }
    const voided = impact.length ? await voidRecords(impact.map((x) => x.recordId)) : [];
    if (req) await finish(requestId, { status: 'accepted', handledBy: uid, handleNote: why, stage, policy: entry.policy, voided });
    else await logAction({ type: 'withdraw', drawId, entrant, by: uid, reason: why, stage, policy: entry.policy, voided });
    return { status: 'accepted', stage, policy: entry.policy, walkovers: woRecords.length, voided };
  } catch (e) { if (req && ((await getDoc('requests', requestId)) || {}).status === 'processing') await release(requestId); throw e; }
}

// 活动详情：待处理的退赛申请（发起人看全部，球员看自己的）和处理记录
async function drawRequests({ drawId }, uid) {
  const draw = await loadDraw(drawId);
  const owner = draw._openid === uid;
  const r = await db.collection('requests').where({ drawId }).limit(200).get();
  const rows = r.data.sort((p, q) => tsOf(q) - tsOf(p)).filter((x) => owner || x.requesterId === uid);
  // 申请人昵称一次查齐（每个账号取最早的本人资料，和 profileOf 一致）
  const names = {};
  (await byIds('players', rows.map((x) => x.requesterId), '_openid')).filter((p) => p.self)
    .sort((a, b) => tsOf(a) - tsOf(b)).forEach((p) => { if (!(p._openid in names)) names[p._openid] = p.name || ''; });
  const list = rows.map((x) => ({
    id: x._id, type: x.type, status: x.status, entrant: x.entrant || '', reason: E.reasonOf(x.reason), note: E.reasonOf(x.handleNote),
    requester: x.requesterId ? names[x.requesterId] || '球友' : '', stage: x.stage || '', policy: x.policy || '',
    drawKey: x.drawKey || '', at: tsOf(x),
  }));
  return { owner, list, withdrawals: E.publicDraw(draw).withdrawals || [], myEntrants: await entrantsOf(draw, uid) };
}

/* ---------- 待办 ---------- */
async function myTodos(_d, uid) {
  // 第一轮（互不依赖，同时查）：我参加的比赛、我发起的活动、我提交的待处理改分申请
  const [ra, rb, myDraws, reqMine] = await Promise.all([
    db.collection('matches').where({ aIds: uid }).orderBy('date', 'desc').limit(100).get(),
    db.collection('matches').where({ bIds: uid }).orderBy('date', 'desc').limit(100).get(),
    db.collection('draws').where({ _openid: uid }).limit(200).get().then((r) => r.data),
    db.collection('requests').where({ type: 'score', status: 'pending', requesterId: uid }).limit(500).get().then((r) => r.data),
  ]);
  const cache = {}, toConfirm = [], waiting = [];
  const mine = uniqueMatches(ra.data.concat(rb.data));
  const all = mine.filter((m) => !finishedReason(m));
  const myDrawIds = myDraws.map((d) => d._id);
  // 第二轮（同时查）：比赛状态要用的数据、和我有关的申请
  const [, reqOnMine, reqInMyDraws] = await Promise.all([
    prefetch(all, uid, cache),
    byIds('requests', mine.map((m) => 'sc_' + m._id)), // 我参加的比赛上的改分申请（申请的 _id 固定是 sc_<比赛 ID>）
    byIds('requests', myDrawIds, 'drawId'),             // 我发起的活动里的申请（改分、退赛）
  ]);
  for (const m of all) {
    const s = await matchState({ matchId: m._id }, uid, cache);
    if (!s.finished || !s.mySide) continue;
    const row = { matchId: m._id, date: m.date || '', title: m.drawId ? `${E.publicMatch(m).drawTitle}${m.stage ? ' · ' + E.stageText(m.stage) : ''}` : '日常比赛', opp: (m[s.mySide === 'a' ? 'b' : 'a'] || []).join(' / '), score: E.scoreText(m.sets) };
    if (s.canConfirm) toConfirm.push(row);
    else if (!s.confirmed) { if (!s.daily) waiting.push(row); } // 日常比赛不需要确认，不算待办

  }
  // 改分申请：等我同意的 / 我提交的（只看和我有关的：我提交的、我参加的比赛、我发起的活动）
  const byId = {};
  reqMine.concat(reqOnMine, reqInMyDraws).forEach((q) => { if (q.type === 'score' && q.status === 'pending') byId[q._id] = q; });
  const reqs = Object.values(byId).sort((p, q) => tsOf(p) - tsOf(q));
  const matchOf = {};
  mine.forEach((m) => { matchOf[m._id] = m; });
  (await byIds('matches', reqs.map((q) => q.matchId).filter((id) => !matchOf[id]))).forEach((m) => { matchOf[m._id] = m; });
  const ownDraw = {};
  myDrawIds.forEach((id) => { ownDraw[id] = 1; });
  const toRespond = [], myRequests = [];
  for (const q of reqs) {
    const m = matchOf[q.matchId];
    if (!m) continue;
    const ids = await sidesOf(m, cache);
    const my = sideOf(ids, uid);
    const row = { matchId: m._id, requestId: q._id, date: m.date || '', title: m.drawId ? `${E.publicMatch(m).drawTitle}${m.stage ? ' · ' + E.stageText(m.stage) : ''}` : '日常比赛', from: E.scoreText(q.from.sets), to: E.scoreText(q.to.sets) };
    if (q.requesterId === uid) myRequests.push(row);
    else if (my && my !== q.requesterSide) toRespond.push(row);
    else if (m.drawId && ownDraw[m.drawId]) toRespond.push(Object.assign(row, { asOwner: true }));
  }
  // 我发起的活动里待处理的退赛申请
  const withdraws = [];
  for (const d of myDraws) {
    reqInMyDraws.filter((x) => x.drawId === d._id && x.type === 'withdraw' && x.status === 'pending')
      .forEach((x) => withdraws.push({ drawId: d._id, title: E.titleOf(d), entrant: x.entrant, reason: E.reasonOf(x.reason), requestId: x._id }));
  }
  return { toConfirm, waiting, toRespond, myRequests, withdraws };
}

async function loadDraw(drawId) {
  if (typeof drawId !== 'string' || !drawId) deny('缺少活动');
  const d = await getDoc('draws', drawId);
  if (!d) deny('活动不存在');
  if (d.deleted) deny('活动已删除');
  d._id = drawId;
  return d;
}
// 活动详情页一次取齐（只读）：活动、报名名单、我的资料、退赛申请。
async function drawDetail({ drawId }, uid) {
  if (typeof drawId !== 'string' || !drawId) deny('缺少活动');
  const draw = await getDoc('draws', drawId);
  if (!draw || draw.deleted) deny('活动不存在，可能已被删除');
  const soft = (p) => p.then((v) => ({ v }), (e) => {
    if (!(e instanceof Deny)) console.error(e);
    return { err: e instanceof Deny ? e.message : '服务器出错，请稍后再试' };
  });
  const [signups, profs, requests] = await Promise.all([
    allDocs('signups', { drawId }).then((rows) => rows.sort((a, b) => tsOf(a) - tsOf(b))),
    db.collection('players').where({ _openid: uid, self: true }).limit(100).get().then((r) => r.data),
    draw.status === 'signup' ? null : soft(drawRequests({ drawId }, uid)),
  ]);
  return {
    draw: E.publicDraw(draw), signups,
    profile: (profs.sort((a, b) => tsOf(a) - tsOf(b)).map(publicPlayer))[0] || null, // 和前端一样：取最早的那条本人资料
    requests: (requests && requests.v) || null,
  };
}

// 我报过名的活动（自己报的，或被搭档带上的）：活动页「我的活动」、待办用。前端原来要分 2～4 次读
async function mySignups(_d, uid) {
  const [own, asPartner] = await Promise.all([allDocs('signups', { _openid: uid }), allDocs('signups', { partnerId: uid })]);
  return { list: own.concat(asPartner) };
}

const ping = async () => ({}); // 小程序启动时调用一次：触发旧记录迁移

// 一次返回前端统计要用的全部数据（只读）：比赛记录（已在服务端判定 official / pending，不认可的 invalid 不返回）+ 球员资料。
// 前端原来要分别 count + 分页读三个集合（约 9 次调用），现在 1 次。
// 云函数返回的数据有大小上限：超过阈值时返回 tooLarge，前端自动改回分页读取。
// 球员资料只返回前端要用的字段（utils/db.js 的 buildPlayers）；比赛记录原样返回（很多页面直接用）。
// 返回内容的指纹 hash：前端带上次的指纹（have），内容没变就只回 same，不再下发整份数据。
const DATASET_MAX_BYTES = 900 * 1024;
const DATASET_PLAYER_FIELDS = ['_id', '_openid', 'name', 'photo', 'gender', 'level', 'formerNames', 'self', 'createdAt', 'shown'];
async function dataset({ have }) {
  const [matches, players, verified] = await Promise.all([allDocs('matches'), allDocs('players'), allDocs('verified').catch(() => null)]);
  const vmap = {};
  (verified || []).forEach((v) => { if (v._id !== OF.META_ID) vmap[v._id] = v; });
  const tagged = [];
  matches.forEach((m) => {
    const status = verified ? OF.statusOf(m, vmap) : 'official';
    if (status !== 'invalid') tagged.push(Object.assign(m, { status }));
  });
  // 顺序和原来的分页读取一致：比赛按日期、录入时间从新到旧；球员按创建时间从早到晚
  tagged.sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')) || tsOf(y) - tsOf(x));
  players.sort((a, b) => tsOf(a) - tsOf(b));
  const slim = players.map((p) => {
    const o = {};
    DATASET_PLAYER_FIELDS.forEach((k) => { if (p[k] !== undefined) o[k] = p[k]; });
    if (!isShown(p)) delete o.photo; // 没同意公开展示：照片不下发（本人也一样，本人看自己的照片走 myPhoto）
    return o;
  });
  const out = { matches: tagged.map(E.publicMatch), players: slim };
  const json = JSON.stringify(out);
  if (Buffer.byteLength(json) > DATASET_MAX_BYTES) return { tooLarge: true };
  const hash = md5(json);
  if (typeof have === 'string' && have === hash) return { same: true, hash };
  return Object.assign(out, { hash });
}

/* ========== 成员准入（仅限内部球友） ========== */
// members（仅管理端可读写）：_id = 用户 ID（openid）
//   status: pending 待审核 / active 正式成员 / rejected 申请未通过 / removed 成员资格已取消
// invites（仅管理端可读写）：_id = 邀请码，一次性、有有效期
// 管理员：云函数环境变量 ADMIN_OPENIDS（逗号分隔的 openid），只能在云开发控制台配置，前端改不了；
//   管理员默认是成员。活动权限：管理员可以编辑任何活动的信息（名称、时间、场地、联系人）和删除活动（必须填原因），都会留档；生成签表、录分、裁定改分、处理退赛仍然只有发起人能做（manageDraw）。
// 分隔符兼容英文 / 中文逗号、分号、空格和换行，去掉误加的引号
const adminTokens = () => String(process.env.ADMIN_OPENIDS || '').split(/[,，;；、\s]+/).map((x) => x.replace(/^["'“”‘’]+|["'“”‘’]+$/g, '')).filter(Boolean);
const ADMINS = () => adminTokens();
const isAdmin = (uid) => ADMINS().indexOf(uid) >= 0;
async function memberOf(uid) {
  if (isAdmin(uid)) return { status: 'active', admin: true };
  return (await getDoc('members', uid)) || { status: 'none' };
}

const PUBLIC = { memberStatus: 1, applyMember: 1, acceptInvite: 1 }; // 不是成员也能调用的
// 管理员替成员补填 / 更正性别（有些老成员没在编辑资料里选，各页面就不显示）：只改性别这一项，留档。
// 成员要先设置过资料；本人之后仍然可以在编辑资料里自己改
async function setMemberGender({ uid: target, gender }, uid) {
  if (!isAdmin(uid)) deny('只有管理员可以操作');
  if (typeof target !== 'string' || !target) deny('缺少成员');
  if (gender !== 'm' && gender !== 'f') deny('请选择男或女');
  const p = await profileOf(target);
  if (!p) deny('这位成员还没有设置资料，等 TA 设置昵称后再选性别');
  const from = p.gender === 'm' || p.gender === 'f' ? p.gender : '';
  if (from === gender) return { ok: true };
  await db.collection('players').doc(p._id).update({ data: { gender, updatedAt: db.serverDate() } });
  await logAction({ type: 'adminGender', target, by: uid, byAdmin: true, from, to: gender });
  return { ok: true };
}

const ADMIN_ONLY = { createDraw: 1, generateDraw: 1, updateDrawInfo: 1, resetScores: 1, setMemberGender: 1, adminClearPhoto: 1, adminFixScore: 1, auditSignups: 1, listMembers: 1, reviewMember: 1, removeMember: 1, importMembers: 1, createInvite: 1, revokeInvite: 1 };

async function memberStatus(_d, uid) {
  const m = await memberOf(uid);
  const out = { uid, status: m.status, isAdmin: isAdmin(uid), reason: E.reasonOf(m.reason), name: m.name || '', appliedAt: tsOf({ createdAt: m.appliedAt }) };
  // 正式成员：带上公开展示授权状态（hasProfile 已设置资料；shown true 同意 / false 不同意 / null 还没选，小程序启动时弹窗询问）
  if (m.status === 'active') {
    const me = await profileOf(uid);
    out.hasProfile = !!me;
    out.shown = me && typeof me.shown === 'boolean' ? me.shown : null;
  }
  // 管理员：顺带返回待审核的申请数，小程序里用来提示（「我的」红点 + 成员管理入口）。不发微信消息
  if (out.isAdmin) {
    const p = await db.collection('members').where({ status: 'pending' }).limit(1000).get();
    out.pendingApply = p.data.filter((x) => !isAdmin(x._id)).length;
  }
  return out;
}

async function applyMember({ name }, uid) {
  const m = await memberOf(uid);
  if (m.status === 'active') return { status: 'active' };
  if (m.status === 'pending') deny('已经提交过申请，请等管理员审核');
  const nm = typeof name === 'string' ? name.trim().slice(0, 20) : '';
  if (nm.length < 1) deny('请填写你的称呼，方便管理员确认');
  await requireSafeText(nm, uid, '称呼'); // 管理员会看到；申请说明（note）不再接收
  const data = { status: 'pending', name: nm, note: '', appliedAt: db.serverDate(), source: 'apply', reason: '' };
  await db.collection('members').doc(uid).set({ data: Object.assign({}, m.status === 'none' ? {} : { history: (m.history || []).concat([{ status: m.status, reason: m.reason || '', at: Date.now() }]).slice(-10) }, data) });
  return { status: 'pending' };
}

async function acceptInvite({ code, name }, uid) {
  if (typeof code !== 'string' || !code) deny('邀请码无效');
  const m = await memberOf(uid);
  if (m.status === 'active') return { status: 'active' };
  const nm = (typeof name === 'string' ? name.trim().slice(0, 20) : '') || m.name || ''; // 没填时沿用申请时填过的称呼
  if (!nm) deny('请填写你的称呼，方便管理员确认');
  await requireSafeText(nm, uid, '称呼'); // 先检测再占用邀请码：检测不过时邀请码还能用
  // 过期、撤销的条件放进同一个原子更新里：失效的邀请码不会被占用
  const r = await db.collection('invites').where({ _id: code, usedBy: '', revoked: false, expiresAt: _.gt(Date.now()) }).update({ data: { usedBy: uid, usedAt: db.serverDate() } });
  if (!(r && r.stats && r.stats.updated)) {
    const old = await getDoc('invites', code);
    if (old && !old.usedBy && (old.revoked || old.expiresAt <= Date.now())) deny('邀请已过期，请联系管理员重新邀请');
    deny('邀请码已被使用或已失效');
  }
  const inv = await getDoc('invites', code);
  await db.collection('members').doc(uid).set({ data: { status: 'active', name: nm, source: 'invite', inviteCode: code, decidedBy: inv.createdBy, decidedAt: db.serverDate(), reason: '' } });
  return { status: 'active' };
}

async function createInvite({ days }, uid) { // 邀请不再带备注
  const d = Math.min(30, Math.max(1, int(days) || 7));
  const code = md5(`${uid}|${Date.now()}|${Math.random()}`).slice(0, 12);
  await db.collection('invites').add({ data: { _id: code, createdBy: uid, createdAt: db.serverDate(), expiresAt: Date.now() + d * 86400000, note: '', usedBy: '', revoked: false } });
  return { code, days: d };
}
async function revokeInvite({ code }) {
  await db.collection('invites').doc(code).update({ data: { revoked: true } });
  return {};
}

// 管理员看：待审核、正式成员、未通过 / 已移除，以及「历史球友」（升级前设置过资料、还没有成员记录的账号，供管理员手动确认导入）
async function listMembers() {
  const all = (await db.collection('members').limit(1000).get()).data;
  const by = {};
  all.forEach((m) => { by[m._id] = m; });
  const profiles = (await db.collection('players').where({ self: true }).limit(1000).get()).data;
  const nameOf = {}, genderOf = {}, photoOf = {};
  // 和 profileOf 一样取每个账号最早的那条本人资料（有重复资料时，各页面显示的昵称才一致）
  profiles.sort((a, b) => tsOf(a) - tsOf(b)).forEach((p) => { if (p._openid && !nameOf[p._openid]) { nameOf[p._openid] = p.name; genderOf[p._openid] = p.gender === 'm' || p.gender === 'f' ? p.gender : ''; photoOf[p._openid] = !!p.photo; } });
  // uidTail：ID 尾号，只给管理员看，用来核对环境变量里的 openid 是不是本人
  const row = (m) => ({ uid: m._id, uidTail: String(m._id).slice(-6), name: m.name || '', nickname: nameOf[m._id] || '', gender: genderOf[m._id] || '', hasPhoto: !!photoOf[m._id], note: '', status: m.status, reason: E.reasonOf(m.reason), source: m.source || '', admin: isAdmin(m._id), at: tsOf({ createdAt: m.decidedAt || m.appliedAt }) });
  const candidates = Object.keys(nameOf).filter((u) => !by[u] && !isAdmin(u)).map((u) => ({ uid: u, nickname: nameOf[u] }));
  // 管理员一律算正式成员（和 memberOf 一致）：即使以前申请过、被拒绝或移除过，也显示在「成员」里，不出现在待审核 / 已移除中
  const invites = (await db.collection('invites').limit(200).get()).data.filter((x) => !x.usedBy && !x.revoked && x.expiresAt > Date.now()).map((x) => ({ code: x._id, note: x.note, expiresAt: x.expiresAt }));
  return {
    pending: all.filter((m) => m.status === 'pending' && !isAdmin(m._id)).map(row),
    active: all.filter((m) => m.status === 'active' || isAdmin(m._id)).map((m) => Object.assign(row(m), { status: 'active' }))
      .concat(ADMINS().filter((u) => !by[u]).map((u) => ({ uid: u, uidTail: u.slice(-6), name: '', nickname: nameOf[u] || '', gender: genderOf[u] || '', hasPhoto: !!photoOf[u], status: 'active', admin: true }))),
    others: all.filter((m) => (m.status === 'rejected' || m.status === 'removed') && !isAdmin(m._id)).map(row),
    candidates, invites,
  };
}

async function reviewMember({ uid: target, approve, reason }, uid) {
  if (typeof target !== 'string' || !target) deny('缺少成员');
  const m = await getDoc('members', target);
  if (!m) deny('没有这条申请');
  if (!approve && m.status === 'active') deny('正式成员请用「移除」');
  const why = cleanReason(reason, !approve);
  await db.collection('members').doc(target).update({ data: { status: approve ? 'active' : 'rejected', reason: approve ? '' : why, decidedBy: uid, decidedAt: db.serverDate() } });
  return { status: approve ? 'active' : 'rejected' };
}

// 移除：立即生效（之后每次调用都会重新查资格）；不删除 TA 的历史比分、报名和处理记录
async function removeMember({ uid: target, reason }, uid) {
  if (isAdmin(target)) deny('管理员不能在这里移除');
  const why = cleanReason(reason, true);
  const m = await getDoc('members', target);
  if (!m || m.status !== 'active') deny('不是正式成员');
  await db.collection('members').doc(target).update({ data: { status: 'removed', reason: why, removedBy: uid, removedAt: db.serverDate() } });
  return { status: 'removed' };
}

// 读一个集合里符合条件的全部记录（服务端每次最多 1000 条，自动翻页）
async function allDocs(col, where) {
  const out = [];
  for (let skip = 0; ; skip += 1000) {
    const q = where ? db.collection(col).where(where) : db.collection(col);
    const r = await q.skip(skip).limit(1000).get();
    out.push(...r.data);
    if (r.data.length < 1000) return out;
  }
}

// 报名数据核对（仅管理员，只读）：修复前报名记录的名字是客户端填的，可能被冒名。
// 找出：报名名字 / 搭档名字和对应账号的昵称（含曾用名）对不上的、同一活动里不同账号用同一个名字的。
async function auditSignups() {
  const [su, profs, draws] = await Promise.all([allDocs('signups'), allDocs('players', { self: true }), allDocs('draws')]);
  const prof = {};
  profs.sort((a, b) => tsOf(a) - tsOf(b)).forEach((p) => { if (p._openid && !prof[p._openid]) prof[p._openid] = p; });
  const drawOf = {};
  draws.forEach((d) => { drawOf[d._id] = d; });
  const known = (uid, name) => { const p = prof[uid]; return !!p && (p.name === name || (p.formerNames || []).indexOf(name) >= 0); };
  const issues = [];
  const add = (s, who, name, uid, problem) => {
    const d = drawOf[s.drawId];
    issues.push({
      id: s._id + '#' + who, drawId: s.drawId, drawTitle: d ? E.titleOf(d) : '（活动不存在）', drawDeleted: !!(d && d.deleted),
      who, name, uid: uid || '', uidTail: String(uid || '').slice(-6), nickname: (prof[uid] && prof[uid].name) || '', problem,
    });
  };
  const byDraw = {};
  su.forEach((s) => {
    if (!s._openid) add(s, '报名人', s.name, '', '没有报名人 ID');
    else if (!prof[s._openid]) add(s, '报名人', s.name, s._openid, '报名人没有设置资料');
    else if (!known(s._openid, s.name)) add(s, '报名人', s.name, s._openid, '报名名字和本人昵称（含曾用名）对不上');
    if (s.partner && s.partnerId && !known(s.partnerId, s.partner)) add(s, '搭档', s.partner, s.partnerId, prof[s.partnerId] ? '搭档名字和搭档账号的昵称（含曾用名）对不上' : '搭档账号没有设置资料');
    const m = byDraw[s.drawId] = byDraw[s.drawId] || {};
    [[s.name, s._openid], [s.partner, s.partnerId]].forEach(([n, u]) => { if (n && u) (m[n] = m[n] || {})[u] = s; });
  });
  Object.keys(byDraw).forEach((d) => Object.keys(byDraw[d]).forEach((n) => {
    const owners = Object.keys(byDraw[d][n]);
    if (owners.length > 1) owners.forEach((u) => add(byDraw[d][n][u], '同名', n, u, `同一活动里有 ${owners.length} 个账号用了「${n}」这个名字`));
  }));
  return { total: su.length, issues };
}

// 清空全部战绩（一次性的管理员操作，用来清掉测试数据）。两道保险：
//   1. 云函数环境变量 ALLOW_RESET_SCORES=yes（平时不要设置，用完立即删掉）；2. 确认口令「清空全部战绩」。
// 删除：比赛记录、确认、正式战绩快照（保留旧记录迁移标记）、对手评价、和比分有关的处理记录；清空签表里的比分。
// 保留：成员、球员资料、简介、活动、报名、相册、退赛申请和退赛登记。
const RESET_PHRASE = '清空全部战绩';
const SCORE_REQUEST_TYPES = ['score', 'impact', 'walkover', 'retired', 'revoke'];
async function resetScores({ confirm }, uid) {
  if (process.env.ALLOW_RESET_SCORES !== 'yes') deny('这个操作默认关闭：需要先在云函数环境变量里临时设置 ALLOW_RESET_SCORES=yes');
  if (confirm !== RESET_PHRASE) deny(`确认口令不对：请传入「${RESET_PHRASE}」`);
  const all = { _id: _.neq('') };
  const removed = async (col, where) => ((await db.collection(col).where(where).remove()).stats || {}).removed || 0;
  const out = {
    matches: await removed('matches', all),
    confirms: await removed('confirms', all),
    verified: await removed('verified', { _id: _.neq(OF.META_ID) }),
    reviews: await removed('reviews', all),
    requests: await removed('requests', { type: _.in(SCORE_REQUEST_TYPES) }),
  };
  out.drawsReset = ((await db.collection('draws').where(all).update({ data: { results: _.set({}) } })).stats || {}).updated || 0;
  await logAction({ type: 'resetScores', by: uid, counts: out });
  return { counts: out };
}

// 升级时初始化：管理员从「历史球友」里勾选确认，逐个导入为正式成员（不会自动把所有访问过的人设为成员）
async function importMembers({ uids }, uid) {
  const list = (Array.isArray(uids) ? uids : []).filter((x) => typeof x === 'string' && x).slice(0, 100);
  let n = 0;
  for (const u of list) {
    if (await getDoc('members', u)) continue;
    await db.collection('members').doc(u).set({ data: { status: 'active', source: 'import', decidedBy: uid, decidedAt: db.serverDate(), name: '' } });
    n++;
  }
  return { imported: n };
}

/* ========== 数据网关：小程序端所有数据库读写都经过这里 ========== */
// 所有集合在控制台都设为「仅管理端可读写」，小程序端不能直接访问。
// 这里先校验成员资格，再按原来的规则执行：成员可读；只有创建者能改 / 删自己的记录；新记录的 _openid 由服务端写入当前用户，不能伪造。
const GW_READ = { matches: 1, players: 1, draws: 1, signups: 1, verified: 1 };
// 可写集合按操作分开：signups 只能经 signUp / cancelSignup；matches 只能新增日常比赛，
// 修改走 editMatchScore / 改分申请，删除走 revokeMatch（否则会绕过确认、审计和对后续场次的影响检查）
// players 只能新增「只有名字」的球员（发起人手动加的参赛名），本人资料走 saveProfile；draws 走 createDraw / generateDraw / updateDrawInfo / removeDraw
const GW_WRITE = { matches: 1, players: 1 };
const GW_OPS = { matches: { add: 1 }, players: { add: 1 } };
const GW_ADD_FIELDS = { players: { name: 1, createdAt: 1 } }; // 没列出的集合不限字段
const isPlain = (v) => v === null || ['string', 'number', 'boolean'].indexOf(typeof v) >= 0;
function decode(v) {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') {
    if (v.__serverDate) return db.serverDate();
    const out = {};
    Object.keys(v).forEach((k) => { out[k] = decode(v[k]); });
    return out;
  }
  return v;
}
function cleanData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) deny('数据格式不对');
  const out = {};
  Object.keys(data).forEach((k) => {
    if (k === '_id' || k === '_openid') return; // 不能自己指定 ID 和创建者
    const v = data[k];
    out[k] = v && v.__cmd === 'set' ? _.set(decode(v.v)) : decode(v);
  });
  return out;
}
function publicPlayer(d) {
  const out = Object.assign({}, d);
  ['photoRequest', 'photoTrace', 'photoAttempts'].forEach((k) => delete out[k]);
  if (!isShown(d)) delete out.photo; // 没同意公开展示：照片不下发（和 dataset 一致）
  return out;
}
async function dataGateway({ op, coll, where, orders, skip, limit, id, data }, uid) {
  if (!GW_READ[coll]) deny('没有权限查看这些内容');
  const col = db.collection(coll);
  const visible = coll === 'draws' ? E.publicDraw : coll === 'matches' ? E.publicMatch : coll === 'players' ? publicPlayer : (d) => d;
  if (coll === 'players' && Object.keys(where || {}).concat((orders || []).map((o) => o[0])).some((k) => /^photo(Request|Trace|Attempts)(\.|$)/.test(k))) deny('查询条件不支持');
  if (op === 'get' || op === 'count') {
    const w = where || {};
    if (typeof w !== 'object' || Object.keys(w).some((k) => !isPlain(w[k]))) deny('查询条件不支持');
    const w2 = coll === 'draws' ? Object.assign({}, w, { deleted: _.neq(true) }) : w; // 已删除的活动不返回
    let q = Object.keys(w2).length ? col.where(w2) : col;
    if (op === 'count') return { total: (await q.count()).total };
    (Array.isArray(orders) ? orders : []).slice(0, 3).forEach((o) => { if (Array.isArray(o) && typeof o[0] === 'string') q = q.orderBy(o[0], o[1] === 'desc' ? 'desc' : 'asc'); });
    if (int(skip) > 0) q = q.skip(int(skip));
    return { data: (await q.limit(Math.min(100, Math.max(1, int(limit) || 20))).get()).data.map(visible) };
  }
  if (op === 'doc') {
    const d = typeof id === 'string' ? await getDoc(coll, id) : null;
    if (!d || (coll === 'draws' && d.deleted)) deny('内容不存在，可能已被删除');
    return { data: visible(d) };
  }
  if (!GW_WRITE[coll]) deny('没有权限修改这些内容');
  if (!(GW_OPS[coll] || {})[op]) deny('没有权限进行这个操作');
  if (op === 'add') {
    if (coll === 'players') deny('手动新增球员功能已停用，请使用本人资料');
    if (coll === 'matches' && !isAdmin(uid)) deny('只有管理员可以录入日常比赛');
    const clean = cleanData(data);
    const only = GW_ADD_FIELDS[coll];
    if (only) Object.keys(clean).forEach((k) => { if (!only[k]) delete clean[k]; });
    if (coll === 'players') {
      if (typeof clean.name !== 'string' || !clean.name.trim() || clean.name.length > 20 || /[\u0000-\u001f\u007f]/.test(clean.name)) deny('名字不对');
      clean.name = clean.name.trim();
      await requireSafeText(clean.name, uid, '球员名字');
    }
    // 日常比赛录入即生效，所以只有参赛者本人能录（按用户 ID，不看名字）
    if (coll === 'matches') {
      const mine = (k) => Array.isArray(clean[k]) && clean[k].indexOf(uid) >= 0;
      if (!mine('aIds') && !mine('bIds')) deny('只能记录自己参加的比赛');
      const names = [].concat(Array.isArray(clean.a) ? clean.a : [], Array.isArray(clean.b) ? clean.b : []);
      if (names.some((n) => typeof n !== 'string' || !n.trim() || n.length > 50)) deny('参加的球员名字不对');
      await requireSafeText(names.join('\n'), uid, '参加的球员');
    }
    const r = await col.add({ data: Object.assign(clean, { _openid: uid }) });
    return { _id: r._id };
  }
  if (op === 'update' || op === 'remove') {
    const d = typeof id === 'string' ? await getDoc(coll, id) : null;
    if (!d || d._openid !== uid) return { stats: op === 'update' ? { updated: 0 } : { removed: 0 } }; // 不是自己创建的：和原来的权限一样，改不了
    if (op === 'update') { await col.doc(id).update({ data: cleanData(data) }); return { stats: { updated: 1 } }; }
    await col.doc(id).remove();
    return { stats: { removed: 1 } };
  }
  deny('不支持的操作');
}

/* ---------- 成长档案：私人比赛记录（只有本人可见） ----------
 * 集合 growth_matches（仅管理端可读写，不在网关白名单里）。owner = 记录主人的用户 ID，只由云端写入；
 * 所有读写都按 cloud.getWXContext().OPENID 过滤，客户端传来的 owner / id 以外的身份字段一律忽略。
 * 不进正式战绩、排行、等级分，也没有任何「看别人档案」的接口。 */
const GROWTH = 'growth_matches';
const growthView = (d) => ({
  id: d._id, date: d.date, type: d.type, kind: d.kind, setGames: d.setGames, noAd: d.noAd, bestOf: d.bestOf,
  sets: d.sets || [], result: d.result, tags: d.tags || [], createdAt: tsOf(d),
});
async function ownGrowth(id, uid) {
  const d = typeof id === 'string' && id ? await getDoc(GROWTH, id) : null;
  if (!d || d.owner !== uid) deny('记录不存在，可能已被删除'); // 别人的记录和不存在一样处理，不透露是否存在
  return d;
}
async function growthList(_d, uid) {
  return { list: (await allDocs(GROWTH, { owner: uid })).map(growthView) };
}
async function growthSave({ id, record }, uid) {
  const c = G.clean(record, today());
  if (!c.ok) deny(c.msg);
  if (id) {
    await ownGrowth(id, uid);
    await db.collection(GROWTH).doc(id).update({ data: Object.assign({}, c.rec, { updatedAt: db.serverDate() }) });
    return { id };
  }
  const n = (await db.collection(GROWTH).where({ owner: uid }).count()).total;
  if (n >= G.MAX_RECORDS) deny(`最多保存 ${G.MAX_RECORDS} 条记录，请先删除一些旧记录`);
  const r = await db.collection(GROWTH).add({ data: Object.assign({ owner: uid }, c.rec, { createdAt: db.serverDate() }) });
  return { id: r._id };
}
async function growthRemove({ id }, uid) {
  await ownGrowth(id, uid);
  await db.collection(GROWTH).doc(id).remove();
  return { removed: 1 };
}
// 清除本人的全部私人记录（不可恢复；正式战绩不受影响）
async function growthClear({ confirm }, uid) {
  if (confirm !== true) deny('请确认要清除全部记录');
  const r = await db.collection(GROWTH).where({ owner: uid }).remove();
  return { removed: (r && r.stats && r.stats.removed) || 0 };
}

/* ---------- 我的球拍：球拍档案 + 穿线 / 维护记录（只有本人可见） ----------
 * 集合 rackets、racket_logs（都是仅管理端可读写，不在网关白名单里）。owner = 本人用户 ID，只由云端写入；
 * 记录的 racketId 只能指向本人的球拍。别人的球拍 / 记录按「不存在」处理。 */
const RACKETS = 'rackets', RLOGS = 'racket_logs';
const racketView = (d) => ({
  id: d._id, no: d.no || 0, brand: d.brand, model: d.model, bought: d.bought || '', status: d.status,
  tags: d.tags || [], remind: d.remind || {}, createdAt: tsOf(d),
}); // 以前版本留下的 photo / photoState / photoRequest / photoTrace 不下发（球拍改成按配色画的示意图，没有照片）
const rlogView = (d) => ({
  id: d._id, racketId: d.racketId, kind: d.kind, date: d.date, item: d.item || '', main: d.main || null, cross: d.cross || null,
  mains: d.mains || 0, crosses: d.crosses || 0, cost: typeof d.cost === 'number' ? d.cost : null, feel: d.feel || 0, tags: d.tags || [], createdAt: tsOf(d),
});
async function ownDoc(col, id, uid, what) {
  const d = typeof id === 'string' && id ? await getDoc(col, id) : null;
  if (!d || d.owner !== uid) deny(`${what}不存在，可能已被删除`);
  return d;
}
async function racketList(_d, uid) {
  const [rackets, logs] = await Promise.all([allDocs(RACKETS, { owner: uid }), allDocs(RLOGS, { owner: uid })]);
  return {
    rackets: rackets.map(racketView).sort((a, b) => a.no - b.no),
    logs: logs.map(rlogView),
  };
}
async function racketSave({ id, racket }, uid) {
  const c = K.cleanRacket(racket, today());
  if (!c.ok) deny(c.msg);
  if (id) {
    await ownDoc(RACKETS, id, uid, '球拍');
    await db.collection(RACKETS).doc(id).update({ data: Object.assign({}, c.rec, { remind: _.set(c.rec.remind), updatedAt: db.serverDate() }) });
    return { id };
  }
  const mine = await allDocs(RACKETS, { owner: uid });
  if (mine.length >= K.MAX_RACKETS) deny(`最多记录 ${K.MAX_RACKETS} 支球拍，请先删除不用的`);
  const no = mine.reduce((m, r) => Math.max(m, r.no || 0), 0) + 1; // 自动编号：「N 号拍」
  const r = await db.collection(RACKETS).add({ data: Object.assign({ owner: uid, no }, c.rec, { createdAt: db.serverDate() }) });
  return { id: r._id, no };
}
// 删除球拍：连同它的穿线 / 维护记录一起删除
async function racketRemove({ id }, uid) {
  const doc = await ownDoc(RACKETS, id, uid, '球拍');
  const r = await db.collection(RLOGS).where({ owner: uid, racketId: id }).remove();
  await db.collection(RACKETS).doc(id).remove();
  await removeFiles([doc.photo]); // 以前版本上传的球拍照片（现在没有照片了）一起删
  return { removed: 1, logs: (r && r.stats && r.stats.removed) || 0 };
}
async function racketLogSave({ id, racketId, log }, uid) {
  const c = K.cleanLog(log, today());
  if (!c.ok) deny(c.msg);
  if (id) {
    const old = await ownDoc(RLOGS, id, uid, '记录');
    if (old.kind !== c.rec.kind) deny('记录类型不能修改');
    await ownDoc(RACKETS, old.racketId, uid, '球拍');
    await db.collection(RLOGS).doc(id).update({ data: Object.assign({}, c.rec, { main: _.set(c.rec.main), cross: c.rec.cross ? _.set(c.rec.cross) : null, updatedAt: db.serverDate() }) });
    return { id };
  }
  await ownDoc(RACKETS, racketId, uid, '球拍');
  const n = (await db.collection(RLOGS).where({ owner: uid }).count()).total;
  if (n >= K.MAX_LOGS) deny(`最多保存 ${K.MAX_LOGS} 条记录，请先删除一些旧记录`);
  const r = await db.collection(RLOGS).add({ data: Object.assign({ owner: uid, racketId }, c.rec, { createdAt: db.serverDate() }) });
  return { id: r._id };
}
async function racketLogRemove({ id }, uid) {
  await ownDoc(RLOGS, id, uid, '记录');
  await db.collection(RLOGS).doc(id).remove();
  return { removed: 1 };
}
// 清除本人的全部球拍和记录（不可恢复）
async function racketClear({ confirm }, uid) {
  if (confirm !== true) deny('请确认要清除全部球拍数据');
  const photos = (await allDocs(RACKETS, { owner: uid })).map((r) => r.photo).filter(Boolean); // 以前版本上传的球拍照片
  const logs = await db.collection(RLOGS).where({ owner: uid }).remove();
  const rackets = await db.collection(RACKETS).where({ owner: uid }).remove();
  await removeFiles(photos);
  return { rackets: (rackets && rackets.stats && rackets.stats.removed) || 0, logs: (logs && logs.stats && logs.stats.removed) || 0 };
}

const ACTIONS = { data: dataGateway, memberStatus, applyMember, acceptInvite, createInvite, revokeInvite, listMembers, reviewMember, removeMember, importMembers, setMemberGender, ping, resolveFixture, editMatchScore, adminFixScore, requestScoreChange, respondScoreChange, ruleScoreChange, cancelScoreChange, requestWithdraw, handleWithdraw, drawRequests, myTodos, recordEventMatch, matchState, signUp, cancelSignup, saveProfile, setShown, createDraw, generateDraw, updateDrawInfo, removeDraw, auditSignups, dataset, drawDetail, mySignups, setFixtureSlot, resetScores, confirmResult, revokeMatch, setPhoto, myPhoto, photoUrls, adminClearPhoto, growthList, growthSave, growthRemove, growthClear, racketList, racketSave, racketRemove, racketLogSave, racketLogRemove, racketClear };

exports.main = async (event) => {
  // 微信消息推送（图片检测结果）：只认平台标记的来源 SOURCE = wx_callback（客户端改不了）；
  // 真推送也带 userInfo（2026-11-18 线上日志：{"source":"wx_callback","userInfo":true}），不能按 userInfo 判断。
  // 小程序端 / 开发者工具调用的 SOURCE 是 wx_client / wx_devtools 等，一律拒绝；trace_id 也从不下发给小程序端
  if (event && event.Event === 'wxa_media_check') {
    const source = String(cloud.getWXContext().SOURCE || '');
    const tags = source.split(',').map((x) => x.trim());
    if (!tags.includes('wx_callback') || tags.some((x) => /^wx_(client|devtools|localdebug)$/.test(x))) {
      console.warn('[照片检测推送] 已拒绝：不是微信推送', JSON.stringify({ source, userInfo: Object.prototype.hasOwnProperty.call(event, 'userInfo') }));
      return { ok: false, error: '未知操作' };
    }
    // 排查用：只记 trace_id 和结果，不记用户 ID
    console.log('[照片检测推送]', JSON.stringify({ trace: event.trace_id || event.traceId || '', suggest: (event.result || {}).suggest || '', label: (event.result || {}).label || 0, errcode: event.errcode !== undefined ? event.errcode : event.errCode, source }));
    try { return await onMediaCheck(event); } // 数据库故障交由平台重试，不吞掉尚未提交的结果
    catch (e) { console.error('[照片检测处理出错]', e && (e.errMsg || e.message), e && e.stack); throw e; }
  }
  const { OPENID } = cloud.getWXContext();
  const fn = ACTIONS[event && event.action];
  if (!fn) return { ok: false, error: '未知操作' };
  if (!OPENID) return { ok: false, error: '无法识别用户' };
  try {
    // 成员资格：每次调用都从数据库重新查（不缓存），移除后下一次操作立即被拦
    if (!PUBLIC[event.action]) {
      const m = await memberOf(OPENID);
      if (m.status !== 'active') return { ok: false, code: 'NOT_MEMBER', status: m.status, error: '请先验证后使用' };
      if (ADMIN_ONLY[event.action] && !isAdmin(OPENID)) return { ok: false, error: '只有管理员可以操作' };
    }
    if (event.action !== 'memberStatus') { try { await ensureMigrated(); } catch (e) { console.error('旧记录迁移失败（请确认已建 verified 集合）', e); } }
    const data = await fn(event, OPENID);
    return Object.assign({ ok: true }, data);
  } catch (e) {
    if (e instanceof Deny) return { ok: false, error: e.message };
    console.error(e);
    return { ok: false, error: '服务器出错，请稍后再试' };
  }
};
