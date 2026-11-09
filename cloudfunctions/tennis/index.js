// 网球小程序云函数：所有涉及「信任」的校验都在这里执行，前端按钮只是展示
//   confirmResult  对手确认赛果          submitReview   对手互评
//   matchState     某场比赛的确认 / 评价状态  pendingReviews 我待确认 / 待评价的比赛
//   reviewSummary  球员的对手评价汇总（匿名） revokeMatch    撤销赛果
//   getContact / saveContact  赛事联系人（按可见范围返回）
//   saveBio / getBios          球员个人简介（必须通过内容安全检测才保存）
//   avatarUrls                 球员头像临时链接（客户端没有云存储读取权限时兜底，只限 avatars/ 目录）
//   recordEventMatch           赛事录分：服务端校验对阵和规则，每一场只有一条记录
//   reviewableWith             从球员主页评价：列出和 TA 已确认、还没评价的交手比赛
//   addEventPhotos / listEventPhotos / eventPhotoCount / deleteEventPhoto / retryPhotoCheck  赛事相册
//   （微信图片内容安全检测是异步的：结果通过消息推送 wxa_media_check 回调到本云函数）
//
// 正式战绩（见 shared/official.js）：赛事比赛只认云函数写入的记录；日常比赛对手确认后写入 verified 快照。
//
// 身份：一律用用户 ID（openid）。调用者的 ID 来自 cloud.getWXContext()，前端无法伪造；
// 昵称只用于展示，同名、改名都不影响权限。
//   赛事比赛：双方 ID 由服务端根据报名记录（本人写的 _openid）和签表快照重新计算，不信任比赛记录里的 ID
//   普通比赛：用比赛记录里的 aIds / bIds，并要求对方本人确认，才算真的交过手
//   旧记录没有 ID 的位置视为「未绑定」，不能确认、评价，也不能被评价
//
// 用到的集合（权限都设为「仅管理端可读写」，小程序端不能直接读写）：
//   confirms        赛果确认   reviews  对手评价   event_contacts  赛事联系人   bios  个人简介   event_photos  赛事照片
// 所有用户可读、只有云函数能写：verified  正式战绩的比分快照
// 只读取的集合：matches players draws signups
const cloud = require('wx-server-sdk');
const crypto = require('crypto');
// 和小程序端共用的纯逻辑（由 scripts/sync-shared.sh 从 utils/ 复制过来）
const E = require('./shared/event');
const RULES = require('./shared/rules');
const OF = require('./shared/official');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const DIMS = ['manner', 'punctual', 'level']; // 球品礼仪、守时守约、水平相符
const TEXT_MAX = 100;
const SEC_TIMEOUT_MS = 4000; // 内容安全检测超时（云函数超时时间请在控制台调到 10 秒）
const md5 = (s) => crypto.createHash('md5').update(String(s)).digest('hex');

class Deny extends Error {}
const deny = (msg) => { throw new Deny(msg); };

/* ---------- 读取 ---------- */
async function getDoc(col, id) {
  try { const r = await db.collection(col).doc(id).get(); return r.data || null; } catch (e) { return null; }
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

const other = (s) => (s === 'a' ? 'b' : 'a');
// 比分指纹：确认后比分再被改动，原来的确认就作废
const sigOf = (m) => md5(JSON.stringify({ a: m.a || [], b: m.b || [], aIds: m.aIds || [], bIds: m.bIds || [], winner: m.winner, sets: m.sets || [] }));
// 一次「交手」：赛事里同一场改过比分仍算同一次；普通比赛就是这条记录
const encounterOf = (m) => (m.drawId && m.drawKey ? `${m.drawId}#${m.drawKey}` : m._id);

// 赛事里「参赛名 → 用户 ID」：签表快照，再用报名记录覆盖（和前端 utils/ident.js 规则相同）
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

// 比赛双方的用户 ID（'' = 未绑定）。赛事比赛在服务端重新计算，普通比赛用记录里的 ID
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
  if (m.cancelled || m.walkover || (m.outcome && m.outcome !== 'normal')) return '弃权、中途退赛或取消的比赛不开放确认和评价';
  if (!(m.a || []).length || !(m.b || []).length) return '比赛双方不完整';
  if (m.winner !== 'a' && m.winner !== 'b') return '比赛还没有结果';
  const sets = m.sets || [];
  if (!sets.length || sets.some((s) => typeof s.a !== 'number' || typeof s.b !== 'number' || s.a === s.b)) return '没有有效局分';
  return '';
}

/* ---------- 正式战绩 ---------- */
async function verifiedMap(ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 100) {
    const r = await db.collection('verified').where({ _id: _.in(ids.slice(i, i + 100)) }).limit(100).get();
    r.data.forEach((v) => { out[v._id] = v; });
  }
  return out;
}
async function statusOfMatch(m) { return OF.statusOf(m, await verifiedMap([m._id])); }

// 赛事的正式比分（云函数写入的，或升级前的旧记录），同一场只取最新
async function officialEventMatches(drawId) {
  const r = await db.collection('matches').where({ drawId }).limit(1000).get();
  const v = await verifiedMap(r.data.map((m) => m._id));
  return E.dedupe(r.data.filter((m) => OF.statusOf(m, v) === 'official'));
}

// 日常比赛双方确认后：写比分快照，从此计入正式战绩（已有且一致就不重复写）
async function markVerified(m) {
  if (m.drawId) return;
  const snap = OF.snapOf(m);
  const v = await getDoc('verified', m._id);
  if (v && v.snap === snap) return;
  await db.collection('verified').doc(m._id).set({ data: { snap, at: db.serverDate() } });
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

// 赛事里同一场被重新录过：只看正式记录，只有最新那条有效
async function supersededBy(m) {
  if (!m.drawId || !m.drawKey) return null;
  const latest = (await officialEventMatches(m.drawId)).find((x) => x.drawKey === m.drawKey);
  return latest && latest._id !== m._id ? latest._id : null;
}

// 确认状态：每一方至少有一人「录入或确认」了当前比分，才算双方确认（都按用户 ID）
async function confirmState(m, ids) {
  const sig = sigOf(m);
  const recorder = recorderOf(m);
  const recorderSide = sideOf(ids, recorder);
  const r = await db.collection('confirms').where({ matchId: m._id }).get();
  const valid = r.data.filter((c) => c.sig === sig && sideOf(ids, c.openid) === c.side);
  const sides = {};
  if (recorderSide) sides[recorderSide] = { by: 'recorder', uid: recorder };
  // 赛事发起人裁定过的比分：双方都算确认（只认云函数写入的赛事记录，小程序端记录里填这个字段无效）
  if (!m._openid && m.rulingSig && m.rulingSig === sig) { sides.a = sides.a || { by: 'ruling', uid: m.ruledBy || '' }; sides.b = sides.b || { by: 'ruling', uid: m.ruledBy || '' }; }
  valid.forEach((c) => { if (!sides[c.side]) sides[c.side] = { by: 'confirm', uid: c.openid }; });
  return { sig, recorderSide, sides, confirmed: !!(sides.a && sides.b) };
}

// 加载一场比赛并做所有通用校验；返回调用者在这场里的身份
async function loadMatch(matchId, uid, cache) {
  if (!matchId || typeof matchId !== 'string') deny('缺少比赛');
  const m = await getDoc('matches', matchId);
  let fin = finishedReason(m);
  if (!fin && (await statusOfMatch(m)) === 'invalid') fin = '这条赛事比分不是从赛事录分写入的，不予认可';
  const ids = m ? await sidesOf(m, cache) : { a: [], b: [] };
  return { m, fin, ids, side: sideOf(ids, uid) };
}

/* ---------- 赛果确认 ---------- */
async function matchState({ matchId }, uid, cache) {
  cache = cache || {};
  const { m, fin, ids, side } = await loadMatch(matchId, uid, cache);
  const base = { matchId, mySide: side, finished: !fin, reason: fin, drawId: (m && m.drawId) || '', drawKey: (m && m.drawKey) || '', outcome: (m && (m.outcome || (m.walkover ? 'walkover' : 'normal'))) || '' };
  if (fin) return base;
  const sup = await supersededBy(m);
  if (sup) return Object.assign(base, { finished: false, reason: '这条比分已被新的记录取代', supersededBy: sup });
  const st = await confirmState(m, ids);
  if (st.confirmed) await markVerified(m); // 日常比赛：双方确认后计入正式战绩
  const names = {};
  const sideText = {};
  for (const k of ['a', 'b']) {
    const s = st.sides[k];
    sideText[k] = !s ? '' : s.by === 'recorder' ? '录入' : s.by === 'ruling' ? '发起人裁定' : await nameOf(s.uid, '已确认', names);
  }
  const out = Object.assign(base, {
    confirmed: st.confirmed, sides: sideText, daily: !m.drawId,
    canConfirm: !!side && !st.sides[side],
    unbound: ids.a.concat(ids.b).some((x) => !x),
    reviews: [],
  });
  if (side) {
    const enc = encounterOf(m);
    const done = await db.collection('reviews').where({ encounter: enc, reviewerId: uid }).get();
    const doneMap = {};
    done.data.forEach((r) => { doneMap[r.targetId] = r; });
    const o = other(side);
    for (let i = 0; i < m[o].length; i++) {
      const tid = ids[o][i];
      out.reviews.push({
        targetId: tid, target: await nameOf(tid, m[o][i], names),
        done: !!(tid && doneMap[tid]), overall: tid && doneMap[tid] ? doneMap[tid].overall : 0,
        unbound: !tid, // 对方这个位置没有绑定账号：没法确认是谁，不能评价
      });
    }
    out.canReview = st.confirmed;
  }
  // 改分：没确认时录入人可以直接改（日常比赛）；已确认后参赛者只能提交申请；有待处理申请时显示出来
  out.request = await requestView(m, ids, uid);
  out.canEdit = !st.confirmed && !m.drawId && recorderOf(m) === uid;
  out.canRequestChange = st.confirmed && !!side && !out.request;
  if (m.drawId) { const dr = await getDoc('draws', m.drawId); out.isOwner = !!dr && dr._openid === uid; }
  if (!side) out.reason = '你不是这场比赛的参赛者（按账号判断，不看昵称）';
  else if (!st.confirmed) out.reason = st.sides[side] ? '等待对方确认比分' + (m.drawId ? '' : '，确认后计入正式战绩') : '请先确认比分';
  return out;
}

async function confirmResult({ matchId }, uid) {
  const cache = {};
  const { m, fin, ids, side } = await loadMatch(matchId, uid, cache);
  if (fin) deny(fin);
  if (!side) deny('只有这场比赛的参赛者本人可以确认比分');
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

/* ---------- 对手互评 ---------- */
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

async function submitReview({ matchId, targetId, scores, text }, uid) {
  const cache = {};
  const { m, fin, ids, side } = await loadMatch(matchId, uid, cache);
  if (fin) deny(fin);
  if (!side) deny('只有实际参赛的球员本人可以评价');
  if (typeof targetId !== 'string' || !targetId) deny('请选择要评价的对手');
  if (targetId === uid) deny('不能评价自己');
  if (ids[side].indexOf(targetId) >= 0) deny('不能通过对手评价给搭档打分');
  if (ids[other(side)].indexOf(targetId) < 0) deny('只能评价这场比赛中的对手');
  if (await supersededBy(m)) deny('这条比分已被新的记录取代');
  const st = await confirmState(m, ids);
  if (!st.confirmed) deny('比分还没有双方确认，暂时不能评价');

  const clean = {};
  DIMS.forEach((k) => {
    const v = scores && scores[k];
    if (!Number.isInteger(v) || v < 1 || v > 5) deny('每一项评分都要在 1～5 分之间');
    clean[k] = v;
  });
  const t = typeof text === 'string' ? text.trim() : '';
  if (t.length > TEXT_MAX) deny(`文字评价最多 ${TEXT_MAX} 字`);

  const enc = encounterOf(m);
  const id = md5(`${enc}|${uid}|${targetId}`); // 同一次交手、同一评分人、同一对手只能有一条
  if (await getDoc('reviews', id)) deny('你已经评价过这位对手了');

  if (t) {
    const res = await checkText(t, uid);
    if (res === 'risky') deny('文字评价包含不合适的内容，请修改后再提交');
    if (res !== 'pass') deny('文字评价暂时无法完成安全检测，请稍后再试；也可以清空文字，只提交星级评分');
  }

  const overall = Math.round((DIMS.reduce((s, k) => s + clean[k], 0) / DIMS.length) * 10) / 10;
  const o = other(side);
  const names = {};
  try {
    await db.collection('reviews').add({
      data: {
        _id: id, matchId, encounter: enc, drawId: m.drawId || '', matchDate: m.date || '',
        reviewerId: uid, reviewerName: await nameOf(uid, m[side][ids[side].indexOf(uid)], names),
        targetId, targetName: await nameOf(targetId, m[o][ids[o].indexOf(targetId)], names), // 名字只是提交时的快照，展示时按 ID 取最新昵称
        scores: clean, overall, text: t, createdAt: db.serverDate(),
      },
    });
  } catch (e) { deny('你已经评价过这位对手了'); }
  return { ok: true, overall };
}

// 评价是否仍然有效：比赛被撤销，或改分后双方不再是对手，评价就不再展示
async function reviewStillValid(r, cache) {
  const key = 'enc:' + r.encounter;
  if (!(key in cache)) {
    let rec = null;
    if (r.encounter.indexOf('#') > 0) {
      const [drawId, drawKey] = r.encounter.split('#');
      rec = (await db.collection('matches').where({ drawId, drawKey }).get()).data.sort((x, y) => tsOf(y) - tsOf(x))[0] || null;
    } else rec = await getDoc('matches', r.matchId);
    cache[key] = rec && !finishedReason(rec) ? { m: rec, ids: await sidesOf(rec, cache) } : null;
  }
  const e = cache[key];
  if (!e) return false;
  const s1 = sideOf(e.ids, r.reviewerId), s2 = sideOf(e.ids, r.targetId);
  return !!s1 && !!s2 && s1 !== s2;
}

async function reviewSummary({ ids }) {
  if (!Array.isArray(ids) || !ids.length) return { players: {} };
  const list = ids.filter((x) => typeof x === 'string' && x).slice(0, 50);
  if (!list.length) return { players: {} };
  const r = await db.collection('reviews').where({ targetId: _.in(list) }).limit(1000).get();
  const cache = {}, players = {};
  for (const rv of r.data.sort((x, y) => tsOf(y) - tsOf(x))) {
    if (!(await reviewStillValid(rv, cache))) continue;
    const p = players[rv.targetId] || (players[rv.targetId] = { count: 0, sum: { manner: 0, punctual: 0, level: 0 }, recent: [] });
    p.count++;
    DIMS.forEach((k) => { p.sum[k] += rv.scores[k]; });
    if (rv.text && p.recent.length < 5) p.recent.push({ text: rv.text, overall: rv.overall, date: rv.matchDate }); // 匿名展示
  }
  Object.keys(players).forEach((k) => {
    const p = players[k], avg = {};
    DIMS.forEach((d) => { avg[d] = Math.round((p.sum[d] / p.count) * 10) / 10; });
    players[k] = { count: p.count, avg, overall: Math.round(((avg.manner + avg.punctual + avg.level) / 3) * 10) / 10, recent: p.recent };
  });
  return { players };
}

// 我最近的比赛里，待我确认 / 待我评价的（按用户 ID 查找）
async function pendingReviews(_data, uid) {
  const [ra, rb] = await Promise.all([
    db.collection('matches').where({ aIds: uid }).orderBy('date', 'desc').limit(50).get(),
    db.collection('matches').where({ bIds: uid }).orderBy('date', 'desc').limit(50).get(),
  ]);
  const seen = {}, list = [], cache = {};
  const all = ra.data.concat(rb.data).sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')) || tsOf(y) - tsOf(x));
  for (const m of all) {
    if (seen[m._id] || finishedReason(m)) continue;
    seen[m._id] = 1;
    if (list.length >= 20) break;
    const s = await matchState({ matchId: m._id }, uid, cache);
    if (!s.finished || !s.mySide) continue;
    const todo = (s.reviews || []).filter((x) => !x.done && !x.unbound).map((x) => x.target);
    if (s.canConfirm || (s.canReview && todo.length)) {
      list.push({ matchId: m._id, date: m.date, opp: (s.reviews || []).map((x) => x.target), canConfirm: s.canConfirm, todo: s.canReview ? todo : [] });
    }
  }
  return { list };
}

/* ---------- 撤销赛果 ---------- */
async function revokeMatch({ matchId }, uid) {
  const m = await getDoc('matches', matchId);
  if (!m) deny('比赛记录不存在');
  let allowed = recorderOf(m) === uid;
  if (m.drawId) { const draw = await getDoc('draws', m.drawId); if (draw && draw._openid === uid) allowed = true; }
  if (!allowed) deny('只有录入人或赛事发起人可以撤销');
  const recs = m.drawId && m.drawKey
    ? (await db.collection('matches').where({ drawId: m.drawId, drawKey: m.drawKey }).get()).data
    : [m];
  for (const r of recs) {
    await db.collection('matches').doc(r._id).remove();
    await db.collection('confirms').where({ matchId: r._id }).remove();
    await db.collection('verified').doc(r._id).remove().catch(() => {});
  }
  return { ok: true, removed: recs.length };
}

/* ---------- 赛事联系人 ---------- */
const VIS = ['participants', 'all'];
// 是否报名者 / 参赛者：只看用户 ID（自己的报名记录、被搭档带上、签表快照里的 ID）
async function isParticipant(draw, uid) {
  const own = await db.collection('signups').where({ drawId: draw._id, _openid: uid }).limit(1).get();
  if (own.data.length) return true;
  const asPartner = await db.collection('signups').where({ drawId: draw._id, partnerId: uid }).limit(1).get();
  if (asPartner.data.length) return true;
  const map = await drawUidMap(draw._id, {});
  return Object.keys(map).some((n) => map[n] === uid && (draw.entrants || []).concat(...Object.values(draw.teams || {})).indexOf(n) >= 0);
}

async function getContact({ drawId }, uid) {
  const draw = await getDoc('draws', drawId);
  if (!draw) deny('赛事不存在');
  const c = await getDoc('event_contacts', drawId);
  if (!c) return { has: false };
  const owner = draw._openid === uid;
  const visible = owner || c.visibility === 'all' || (await isParticipant(draw, uid));
  const pub = { has: true, visibility: c.visibility, owner, visible };
  if (!visible) return Object.assign(pub, { name: c.name ? c.name.slice(0, 1) + '**' : '', reason: '报名后可查看联系方式' });
  return Object.assign(pub, { name: c.name || '', phone: c.phone || '', wechat: c.wechat || '' });
}

async function saveContact({ drawId, contact }, uid) {
  const draw = await getDoc('draws', drawId);
  if (!draw) deny('赛事不存在');
  if (draw._openid !== uid) deny('只有赛事发起人可以修改联系人');
  const c = contact || {};
  const s = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
  const data = { name: s(c.name, 20), phone: s(c.phone, 20), wechat: s(c.wechat, 40), visibility: VIS.indexOf(c.visibility) >= 0 ? c.visibility : 'participants' };
  if (data.phone && !/^[0-9+\- ]{5,20}$/.test(data.phone)) deny('电话号码格式不对');
  if (!data.name && !data.phone && !data.wechat) {
    await db.collection('event_contacts').doc(drawId).remove().catch(() => {});
    return { ok: true, has: false };
  }
  await db.collection('event_contacts').doc(drawId).set({ data: Object.assign(data, { ownerOpenid: uid, updatedAt: db.serverDate() }) });
  return { ok: true, has: true };
}

/* ---------- 个人简介 ---------- */
// 简介是公开文字：只能经云函数写入 bios（仅管理端可读写），必须通过内容安全检测；
// 按用户 ID 存，改昵称、换照片都不影响
const BIO_MAX = 60;
async function saveBio({ bio }, uid) {
  const t = typeof bio === 'string' ? bio.replace(/\s+/g, ' ').trim() : '';
  if (t.length > BIO_MAX) deny(`个人简介最多 ${BIO_MAX} 字`);
  if (!t) { await db.collection('bios').doc(uid).remove().catch(() => {}); return { bio: '' }; }
  const res = await checkText(t, uid);
  if (res === 'risky') deny('个人简介包含不合适的内容，请修改后再保存');
  if (res !== 'pass') deny('个人简介暂时无法完成安全检测，请稍后再试；其他资料可以先清空简介再保存');
  await db.collection('bios').doc(uid).set({ data: { bio: t, updatedAt: db.serverDate() } });
  return { bio: t };
}

async function getBios({ ids }) {
  const list = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && x).slice(0, 50);
  if (!list.length) return { bios: {} };
  const r = await db.collection('bios').where({ _id: _.in(list) }).get();
  const bios = {};
  r.data.forEach((d) => { bios[d._id] = d.bio || ''; });
  return { bios };
}

/* ---------- 头像临时链接 ---------- */
// 服务端读取云存储不受安全规则限制，所以这里必须自己把关：
//   只处理当前云环境、avatars/ 目录下的文件（球员公开照片），其他路径一律拒绝，
//   不能借这个接口读取别的私有文件；调用者必须是已登录的小程序用户（main 里已校验 OPENID）。
const AVATAR_MAX_AGE = 30 * 60; // 临时链接 30 分钟：已发出的链接在过期前仍可能有效，无法即时收回
async function avatarUrls({ fileIDs }) {
  const env = cloud.getWXContext().ENV || '';
  const list = [];
  (Array.isArray(fileIDs) ? fileIDs : []).forEach((x) => { if (typeof x === 'string' && list.indexOf(x) < 0) list.push(x); });
  const files = {}, ok = [];
  list.slice(0, 50).forEach((id) => {
    const m = /^cloud:\/\/([^./]+)\.[^/]+\/(.+)$/.exec(id);
    if (!m) files[id] = { error: 'BAD_FILEID' };
    else if (!/^avatars\//.test(m[2]) || m[2].indexOf('..') >= 0) files[id] = { error: 'NOT_AVATAR' };
    else if (env && m[1] !== env) files[id] = { error: 'ENV_MISMATCH', env: m[1] };
    else ok.push(id);
  });
  if (ok.length) {
    const r = await cloud.getTempFileURL({ fileList: ok.map((fileID) => ({ fileID, maxAge: AVATAR_MAX_AGE })) });
    (r.fileList || []).forEach((f) => {
      files[f.fileID] = f.status === 0 && f.tempFileURL ? { url: f.tempFileURL } : { error: f.errMsg || 'status ' + f.status };
    });
  }
  return { files, env };
}

/* ---------- 共用：审计记录、作废记录、局分校验 ---------- */
// requests 集合（仅管理端可读写）：改分申请、退赛申请，以及发起人的裁定 / 弃权 / 退赛处理记录
//   状态 pending → processing（领取，原子操作防并发）→ accepted / rejected / ruled / cancelled / stale / done
const REASON_MAX = 100;
const cleanReason = (r, need) => {
  const t = typeof r === 'string' ? r.trim().slice(0, REASON_MAX) : '';
  if (need && t.length < 2) deny('请填写原因（至少 2 个字）');
  return t;
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
// 一场比赛适用的规则：赛事按阶段 / 轮次；日常比赛就是录入时选的
async function ruleOfMatch(m) {
  if (m.drawId && m.drawKey) { const d = await getDoc('draws', m.drawId); if (d) { d._id = m.drawId; return E.ruleFor(d, m.drawKey); } }
  return { setGames: m.setGames === 6 ? 6 : 4, noAd: m.noAd !== false, bestOf: m.bestOf === 3 ? 3 : 1 };
}

/* ---------- 赛事录分 ---------- */
// 双方和规则都由服务端按签表 / 赛程计算：前端只传「哪一场」和局分。
// 每一场固定一条记录（_id 由赛事和场次决定），改比分就是覆盖这一条，不会出现两条。
const evId = (drawId, key) => 'ev_' + md5(`${drawId}#${key}`);
const int = (v) => (typeof v === 'number' ? v : parseInt(v, 10));

async function loadFixture(drawId, key) {
  if (typeof drawId !== 'string' || typeof key !== 'string') deny('缺少比赛');
  const draw = await getDoc('draws', drawId);
  if (!draw) deny('赛事不存在');
  if (draw.status === 'signup') deny('赛事还在报名，签表生成后才能录分');
  draw._id = drawId;
  const list = await officialEventMatches(drawId);
  const f = E.findFixture(draw, list, key);
  if (!f) deny('找不到这场比赛，签表可能已经重新生成');
  return { draw, list, f };
}

// 写入一场赛事比分（正常 / 弃权 / 中途退赛）。会先算出对后续已录分场次的影响：
//   有影响时普通参赛者不能改；发起人要看过影响清单、带 confirmImpact 和原因再提交，受影响的记录会被作废并留档
async function writeFixture({ draw, list, f }, data, opts) {
  const id = evId(draw._id, f.key);
  const map = await drawUidMap(draw._id, {});
  const doc = Object.assign({
    type: E.ruleFor(draw, f.key).type, a: f.aMembers, b: f.bMembers,
    aIds: f.aMembers.map((n) => map[n] || ''), bIds: f.bMembers.map((n) => map[n] || ''),
    drawId: draw._id, drawKey: f.key, ea: f.a, eb: f.b, drawTitle: draw.title || '', stage: f.stage,
  }, data);
  const after = list.filter((m) => m.drawKey !== f.key).concat([Object.assign({ _id: id, createdAt: Date.now() }, doc)]);
  const impact = E.impactOf(draw, list, draw, after, f.key);
  if (impact.length) {
    if (!opts.owner) deny(`这场比分会改变后续已录分的比赛（${impact.map((x) => x.stage + ' ' + x.a + ' vs ' + x.b).join('、')}），需由赛事发起人处理`);
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
  if (!owner && f.aMembers.concat(f.bMembers).map((n) => map[n] || '').indexOf(uid) < 0) deny('只有这场的参赛球员或赛事发起人可以录分');
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
    date: /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : new Date().toISOString().slice(0, 10),
    bestOf: rule.bestOf, setGames: rule.setGames, noAd: rule.noAd,
    sets: res.sets, winner: res.winner, setsWon: res.won, outcome: 'normal', recordedBy: uid,
  }, { owner, confirmImpact, reason: cleanReason(reason, !!confirmImpact) });
  if (r.needConfirm) return r;
  if (r.voided.length) await logAction({ type: 'impact', drawId, drawKey: key, matchId: r.matchId, by: uid, reason: cleanReason(reason), voided: r.voided });
  return r;
}

// 发起人处理一场赛事：赛前弃权（不填局分）/ 中途退赛（填实际已打局分）。必须填原因，留档
async function resolveFixture({ drawId, key, kind, loser, reason, sets, date, confirmImpact }, uid) {
  const ctx = await loadFixture(drawId, key);
  const { draw, f } = ctx;
  if (draw._openid !== uid) deny('只有赛事发起人可以判弃权 / 退赛');
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
    date: /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : new Date().toISOString().slice(0, 10),
    bestOf: rule.bestOf, setGames: rule.setGames, noAd: rule.noAd,
    sets: played, winner, setsWon: { a: 0, b: 0 }, outcome: kind, recordedBy: uid,
    resolution: { type: kind, side: loser, reason: why, by: uid, at: Date.now() },
  }, { owner: true, confirmImpact, reason: why });
  if (r.needConfirm) return r;
  await logAction({ type: kind, drawId, drawKey: key, matchId: r.matchId, by: uid, side: loser, entrant: loser === 'a' ? f.a : f.b, reason: why, previous: r.previous, voided: r.voided });
  return r;
}

/* ---------- 比分纠错 ---------- */
// 日常比赛：对方还没确认时，录入人可以直接改（改完等对方确认）
async function editMatchScore({ matchId, sets }, uid) {
  const { m, fin, ids } = await loadMatch(matchId, uid, {});
  if (fin) deny(fin);
  if (m.drawId) deny('赛事比赛请在签表 / 赛程里点这一场修改');
  if (recorderOf(m) !== uid) deny('只有录入人可以直接修改还没确认的比分');
  if ((await confirmState(m, ids)).confirmed) deny('比分已经双方确认，请「申请修改比分」');
  const res = checkedScore(sets, await ruleOfMatch(m));
  await db.collection('matches').doc(m._id).update({ data: { sets: res.sets, winner: res.winner, setsWon: res.won, editedAt: db.serverDate() } });
  return { ok: true };
}

// 已双方确认的比分：参赛者提交修改申请（新比分 + 原因）；处理前正式战绩、排名、晋级都不变
async function requestScoreChange({ matchId, sets, reason }, uid) {
  const { m, fin, ids, side } = await loadMatch(matchId, uid, {});
  if (fin) deny(fin);
  if (!side) deny('只有这场比赛的参赛者可以申请修改比分');
  if (await supersededBy(m)) deny('这条比分已被新的记录取代');
  const st = await confirmState(m, ids);
  if (!st.confirmed) deny(m.drawId ? '比分还没有双方确认，可以直接在赛程里修改' : '比分还没有双方确认，录入人可以直接修改');
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

// 把申请里的新比分写进比赛记录；赛事比赛会检查对后续场次的影响
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
  if (!(await claim(requestId, uid))) deny('这条申请已经处理过了');
  try {
    const m = await stillSame(req);
    if (!m) deny('比分已经变动，这条申请失效了');
    if (!accept) { await finish(requestId, { status: 'rejected', handledBy: uid, handleNote: cleanReason(note) }); return { status: 'rejected' }; }
    const r = await applyScoreChange(m, req, 'accept', uid, {});
    await finish(requestId, { status: 'accepted', handledBy: uid, handleNote: cleanReason(note), voided: r.voided || [] });
    return { status: 'accepted' };
  } catch (e) { if ((await getDoc('requests', requestId) || {}).status === 'processing') await release(requestId); throw e; }
}

// 赛事发起人裁定（必须填原因）；日常比赛没有发起人，不能单方面裁定
async function ruleScoreChange({ requestId, accept, reason, confirmImpact }, uid) {
  const req = await loadRequest(requestId, 'score');
  if (!req.drawId) deny('日常比赛没有赛事发起人，只能由对方同意或拒绝');
  const draw = await getDoc('draws', req.drawId);
  if (!draw || draw._openid !== uid) deny('只有赛事发起人可以裁定');
  const why = cleanReason(reason, true);
  if (!(await claim(requestId, uid))) deny('这条申请已经处理过了');
  try {
    const m = await stillSame(req);
    if (!m) deny('比分已经变动，这条申请失效了');
    if (!accept) { await finish(requestId, { status: 'rejected', handledBy: uid, handleNote: why, ruling: true }); return { status: 'rejected' }; }
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
async function requestView(m, ids, uid) {
  const req = await getDoc('requests', 'sc_' + m._id);
  if (!req || (req.status !== 'pending' && req.status !== 'processing')) return null;
  const draw = m.drawId ? await getDoc('draws', m.drawId) : null;
  const my = sideOf(ids, uid);
  return {
    id: req._id, reason: req.reason, from: E.scoreText(req.from.sets), to: E.scoreText(req.to.sets), toWinner: req.to.winner,
    requester: await nameOf(req.requesterId, '球友', {}), mine: req.requesterId === uid,
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
  if (!ents.length) deny('你不在这个赛事的参赛名单里');
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
  if (draw._openid !== uid) deny('只有赛事发起人可以处理退赛');
  const why = cleanReason(reason, true);
  let req = null;
  if (requestId) {
    req = await loadRequest(requestId, 'withdraw');
    if (req.drawId !== drawId) deny('申请不属于这个赛事');
    entrant = req.entrant;
    if (!(await claim(requestId, uid))) deny('这条申请已经处理过了');
  }
  try {
    if (!entrant || (draw.entrants || []).indexOf(entrant) < 0) deny('参赛者不存在');
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
    if (stage === 'group' && policy !== 'walkover' && policy !== 'void') deny('小组赛退赛请选择处理方式：未赛场次判对手弃权胜，或取消该球员全部小组成绩');
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
        date: new Date().toISOString().slice(0, 10), bestOf: rule.bestOf, setGames: rule.setGames, noAd: rule.noAd,
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

// 赛事详情：待处理的退赛申请（发起人看全部，球员看自己的）和处理记录
async function drawRequests({ drawId }, uid) {
  const draw = await loadDraw(drawId);
  const owner = draw._openid === uid;
  const r = await db.collection('requests').where({ drawId }).limit(200).get();
  const names = {};
  const list = [];
  for (const x of r.data.sort((p, q) => tsOf(q) - tsOf(p))) {
    if (!owner && x.requesterId !== uid) continue;
    list.push({
      id: x._id, type: x.type, status: x.status, entrant: x.entrant || '', reason: x.reason || '', note: x.handleNote || '',
      requester: x.requesterId ? await nameOf(x.requesterId, '球友', names) : '', stage: x.stage || '', policy: x.policy || '',
      drawKey: x.drawKey || '', at: tsOf(x),
    });
  }
  return { owner, list, withdrawals: draw.withdrawals || [], myEntrants: await entrantsOf(draw, uid) };
}

/* ---------- 待办 ---------- */
async function myTodos(_d, uid) {
  const [ra, rb] = await Promise.all([
    db.collection('matches').where({ aIds: uid }).orderBy('date', 'desc').limit(100).get(),
    db.collection('matches').where({ bIds: uid }).orderBy('date', 'desc').limit(100).get(),
  ]);
  const seen = {}, cache = {}, toConfirm = [], waiting = [], toReview = [];
  const all = ra.data.concat(rb.data).sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')) || tsOf(y) - tsOf(x));
  for (const m of all) {
    if (seen[m._id] || finishedReason(m)) continue;
    seen[m._id] = 1;
    const s = await matchState({ matchId: m._id }, uid, cache);
    if (!s.finished || !s.mySide) continue;
    const row = { matchId: m._id, date: m.date || '', title: m.drawId ? `${m.drawTitle || '赛事'}${m.stage ? ' · ' + m.stage : ''}` : '日常比赛', opp: (s.reviews || []).map((x) => x.target).join(' / '), score: E.scoreText(m.sets) };
    if (s.canConfirm) toConfirm.push(row);
    else if (!s.confirmed) waiting.push(row);
    else {
      const todo = (s.reviews || []).filter((x) => !x.done && !x.unbound).map((x) => x.target);
      if (todo.length) toReview.push(Object.assign(row, { todo }));
    }
  }
  // 改分申请：等我同意的 / 我提交的
  const reqs = (await db.collection('requests').where({ type: 'score', status: 'pending' }).limit(500).get()).data;
  const toRespond = [], myRequests = [];
  for (const q of reqs) {
    const m = await getDoc('matches', q.matchId);
    if (!m) continue;
    const ids = await sidesOf(m, cache);
    const my = sideOf(ids, uid);
    const row = { matchId: m._id, requestId: q._id, date: m.date || '', title: m.drawId ? `${m.drawTitle || '赛事'}${m.stage ? ' · ' + m.stage : ''}` : '日常比赛', from: E.scoreText(q.from.sets), to: E.scoreText(q.to.sets) };
    if (q.requesterId === uid) myRequests.push(row);
    else if (my && my !== q.requesterSide) toRespond.push(row);
    else if (m.drawId) { const d = await getDoc('draws', m.drawId); if (d && d._openid === uid) toRespond.push(Object.assign(row, { asOwner: true })); }
  }
  // 我发起的赛事里待处理的退赛申请
  const myDraws = (await db.collection('draws').where({ _openid: uid }).limit(200).get()).data;
  const withdraws = [];
  for (const d of myDraws) {
    const r = await db.collection('requests').where({ drawId: d._id, type: 'withdraw', status: 'pending' }).get();
    r.data.forEach((x) => withdraws.push({ drawId: d._id, title: d.title || '赛事', entrant: x.entrant, reason: x.reason, requestId: x._id }));
  }
  return { toConfirm, waiting, toReview, toRespond, myRequests, withdraws };
}

/* ---------- 从球员主页评价 ---------- */
// 只列出「我和 TA 实际交手、比分已双方确认、我还没评价 TA」的比赛；提交时 submitReview 还会再校验一遍
async function reviewableWith({ targetId }, uid) {
  if (typeof targetId !== 'string' || !targetId) deny('缺少球员');
  if (targetId === uid) deny('不能评价自己');
  const [ra, rb] = await Promise.all([
    db.collection('matches').where({ aIds: uid }).orderBy('date', 'desc').limit(100).get(),
    db.collection('matches').where({ bIds: uid }).orderBy('date', 'desc').limit(100).get(),
  ]);
  const seen = {}, list = [], cache = {};
  let unconfirmed = 0, reviewed = 0;
  const all = ra.data.concat(rb.data).sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')) || tsOf(y) - tsOf(x));
  for (const m of all) {
    if (seen[m._id]) continue;
    seen[m._id] = 1;
    if ((m.aIds || []).concat(m.bIds || []).indexOf(targetId) < 0) continue;
    const s = await matchState({ matchId: m._id }, uid, cache);
    if (!s.finished || !s.mySide) continue;
    const t = (s.reviews || []).find((x) => x.targetId === targetId);
    if (!t) continue; // TA 是我的搭档，不是对手
    if (t.done) { reviewed++; continue; }
    if (!s.canReview) { unconfirmed++; continue; }
    list.push({ matchId: m._id, date: m.date || '', title: m.drawId ? `${m.drawTitle || '赛事'}${m.stage ? ' · ' + m.stage : ''}` : '日常比赛', score: E.scoreText(m.sets) });
  }
  return { list, unconfirmed, reviewed };
}

/* ---------- 赛事相册 ---------- */
// 照片放在独立目录 event-photos/<赛事 ID>/<上传者 ID>/：云存储安全规则只允许上传者本人直接读，
// 其他人看到的链接全部由这里发放，而且只发「内容安全检测通过」的照片。
// 状态：checking 检测中 / pass 通过（公开）/ review 需人工复核 / reject 不通过 / error 检测失败（可重试）
const PHOTO_DIR = 'event-photos';
const PHOTO_BATCH = 9;
const PHOTO_SCENE = 4; // 内容安全场景：社交日志
const PHOTO_URL_AGE = 30 * 60;
const PHOTO_TEXT = { checking: '审核中', pass: '', review: '待人工复核，暂不公开', reject: '未通过内容审核', error: '检测失败，可重试' };

async function loadDraw(drawId) {
  if (typeof drawId !== 'string' || !drawId) deny('缺少赛事');
  const d = await getDoc('draws', drawId);
  if (!d) deny('赛事不存在');
  d._id = drawId;
  return d;
}
const canUploadPhotos = async (draw, uid) => draw._openid === uid || (await isParticipant(draw, uid));

// 提交微信异步图片检测；失败就标成 error（不公开，可以重试）
async function submitPhotoCheck(photo) {
  let patch;
  try {
    const t = await cloud.getTempFileURL({ fileList: [{ fileID: photo.fileID, maxAge: 3600 }] });
    const f = (t.fileList || [])[0] || {};
    if (f.status !== 0 || !f.tempFileURL) throw new Error('照片文件读取失败');
    const r = await cloud.openapi.security.mediaCheckAsync({ mediaUrl: f.tempFileURL, mediaType: 2, version: 2, scene: PHOTO_SCENE, openid: photo.uploaderId });
    const code = r && (r.errCode !== undefined ? r.errCode : r.errcode);
    const trace = r && (r.traceId || r.trace_id);
    if ((code && code !== 0) || !trace) throw new Error((r && (r.errMsg || r.errmsg)) || '检测提交失败');
    patch = { status: 'checking', traceId: trace, submittedAt: db.serverDate(), error: '' };
  } catch (e) {
    console.error('图片检测提交失败', photo._id, e && (e.errMsg || e.message));
    patch = { status: 'error', error: String((e && (e.errMsg || e.message)) || e).slice(0, 200) };
  }
  await db.collection('event_photos').doc(photo._id).update({ data: patch });
  return patch.status;
}

async function addEventPhotos({ drawId, fileIDs }, uid) {
  const draw = await loadDraw(drawId);
  if (!(await canUploadPhotos(draw, uid))) deny('只有赛事发起人和已报名的球员可以上传照片');
  const list = (Array.isArray(fileIDs) ? fileIDs : []).filter((x) => typeof x === 'string');
  if (!list.length) deny('请选择照片');
  if (list.length > PHOTO_BATCH) deny(`一次最多 ${PHOTO_BATCH} 张`);
  const env = cloud.getWXContext().ENV || '';
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const re = new RegExp(`^cloud://([^./]+)\\.[^/]+/${PHOTO_DIR}/${esc(drawId)}/${esc(uid)}/[\\w.-]+$`);
  const out = [];
  for (const fileID of list) {
    const m = re.exec(fileID);
    if (!m || (env && m[1] !== env)) { out.push({ fileID, error: '照片位置不对' }); continue; }
    const t = await cloud.getTempFileURL({ fileList: [{ fileID, maxAge: 60 }] });
    if (!((t.fileList || [])[0] || {}).tempFileURL) { out.push({ fileID, error: '照片还没有上传成功' }); continue; }
    const id = md5(fileID);
    const photo = { _id: id, drawId, fileID, uploaderId: uid, status: 'checking', createdAt: db.serverDate() };
    try { await db.collection('event_photos').add({ data: photo }); } catch (e) { out.push({ fileID, id, status: 'dup' }); continue; }
    out.push({ fileID, id, status: await submitPhotoCheck(photo) });
  }
  return { photos: out };
}

// 微信内容安全检测结果（消息推送 wxa_media_check）
async function onMediaCheck(ev) {
  const trace = ev.trace_id || ev.traceId;
  if (!trace) return 'success';
  const r = await db.collection('event_photos').where({ traceId: trace }).limit(1).get();
  const photo = r.data[0];
  if (!photo) return 'success';
  const res = ev.result || {};
  let status = 'review';
  if (ev.errcode && ev.errcode !== 0) status = 'error';
  else if (res.suggest === 'pass') status = 'pass';
  else if (res.suggest === 'risky') status = 'reject';
  await db.collection('event_photos').doc(photo._id).update({ data: { status, label: res.label || 0, checkedAt: db.serverDate() } });
  if (status === 'reject') await cloud.deleteFile({ fileList: [photo.fileID] }).catch(() => {}); // 违规照片直接删文件
  return 'success';
}

async function listEventPhotos({ drawId }, uid) {
  const draw = await loadDraw(drawId);
  const isOwner = draw._openid === uid;
  const r = await db.collection('event_photos').where({ drawId }).limit(1000).get();
  const all = r.data.sort((x, y) => tsOf(y) - tsOf(x));
  // 别人只能看到检测通过的；自己的照片自己能看到（标出审核状态）；发起人能看到别人未通过的条目（不给图片），用来管理
  const visible = all.filter((p) => p.status === 'pass' || p.uploaderId === uid || isOwner);
  const needUrl = visible.filter((p) => p.status === 'pass' || (p.uploaderId === uid && p.status !== 'reject'));
  const urls = {};
  for (let i = 0; i < needUrl.length; i += 50) {
    const t = await cloud.getTempFileURL({ fileList: needUrl.slice(i, i + 50).map((p) => ({ fileID: p.fileID, maxAge: PHOTO_URL_AGE })) });
    (t.fileList || []).forEach((f) => { if (f.status === 0) urls[f.fileID] = f.tempFileURL; });
  }
  const names = {};
  const photos = [];
  for (const p of visible) {
    const mine = p.uploaderId === uid;
    const url = (p.status === 'pass' || mine) ? urls[p.fileID] || '' : '';
    photos.push({
      id: p._id, url, status: p.status, statusText: PHOTO_TEXT[p.status] || '', mine,
      canDelete: mine || isOwner, canRetry: (mine || isOwner) && p.status === 'error',
      uploaderName: await nameOf(p.uploaderId, '球友', names), createdAt: tsOf(p),
    });
  }
  return { photos, isOwner, canUpload: await canUploadPhotos(draw, uid), passCount: all.filter((p) => p.status === 'pass').length };
}

async function eventPhotoCount({ drawId }) {
  if (typeof drawId !== 'string' || !drawId) return { count: 0 };
  const r = await db.collection('event_photos').where({ drawId, status: 'pass' }).limit(1000).get();
  return { count: r.data.length };
}

async function photoForManage(photoId, uid) {
  const p = typeof photoId === 'string' && photoId ? await getDoc('event_photos', photoId) : null;
  if (!p) deny('照片不存在');
  const draw = await getDoc('draws', p.drawId);
  if (p.uploaderId !== uid && !(draw && draw._openid === uid)) deny('只能删除自己上传的照片（赛事发起人可以管理全部照片）');
  return p;
}
async function deleteEventPhoto({ photoId }, uid) {
  const p = await photoForManage(photoId, uid);
  await cloud.deleteFile({ fileList: [p.fileID] }).catch(() => {});
  await db.collection('event_photos').doc(p._id).remove();
  return { ok: true };
}
async function retryPhotoCheck({ photoId }, uid) {
  const p = await photoForManage(photoId, uid);
  if (p.status !== 'error') deny('这张照片不需要重新检测');
  return { status: await submitPhotoCheck(p) };
}

const ping = async () => ({}); // 小程序启动时调用一次：触发旧记录迁移

/* ========== 成员准入（仅限内部球友） ========== */
// members（仅管理端可读写）：_id = 用户 ID（openid）
//   status: pending 待审核 / active 正式成员 / rejected 申请未通过 / removed 成员资格已取消
// invites（仅管理端可读写）：_id = 邀请码，一次性、有有效期
// 管理员：云函数环境变量 ADMIN_OPENIDS（逗号分隔的 openid），只能在云开发控制台配置，前端改不了；
//   管理员默认是成员。成员管理员和赛事发起人是两回事：管理员不因此获得任何赛事操作权限。
const ADMINS = () => String(process.env.ADMIN_OPENIDS || '').split(/[,\s]+/).filter(Boolean);
const isAdmin = (uid) => ADMINS().indexOf(uid) >= 0;
async function memberOf(uid) {
  if (isAdmin(uid)) return { status: 'active', admin: true };
  return (await getDoc('members', uid)) || { status: 'none' };
}

const PUBLIC = { memberStatus: 1, applyMember: 1, acceptInvite: 1 }; // 不是成员也能调用的
const ADMIN_ONLY = { listMembers: 1, reviewMember: 1, removeMember: 1, importMembers: 1, createInvite: 1, revokeInvite: 1 };

async function memberStatus(_d, uid) {
  const m = await memberOf(uid);
  return { uid, status: m.status, isAdmin: isAdmin(uid), reason: m.reason || '', name: m.name || '', appliedAt: tsOf({ createdAt: m.appliedAt }) };
}

async function applyMember({ name, note }, uid) {
  const m = await memberOf(uid);
  if (m.status === 'active') return { status: 'active' };
  if (m.status === 'pending') deny('已经提交过申请，请等管理员审核');
  const nm = typeof name === 'string' ? name.trim().slice(0, 20) : '';
  if (nm.length < 1) deny('请填写你的称呼，方便管理员确认');
  const data = { status: 'pending', name: nm, note: cleanReason(note), appliedAt: db.serverDate(), source: 'apply', reason: '' };
  await db.collection('members').doc(uid).set({ data: Object.assign({}, m.status === 'none' ? {} : { history: (m.history || []).concat([{ status: m.status, reason: m.reason || '', at: Date.now() }]).slice(-10) }, data) });
  return { status: 'pending' };
}

async function acceptInvite({ code, name }, uid) {
  if (typeof code !== 'string' || !code) deny('邀请码无效');
  const m = await memberOf(uid);
  if (m.status === 'active') return { status: 'active' };
  const r = await db.collection('invites').where({ _id: code, usedBy: '' }).update({ data: { usedBy: uid, usedAt: db.serverDate() } });
  if (!(r && r.stats && r.stats.updated)) deny('邀请码已被使用或已失效');
  const inv = await getDoc('invites', code);
  if (!inv || inv.expiresAt < Date.now() || inv.revoked) deny('邀请已过期，请联系管理员重新邀请');
  await db.collection('members').doc(uid).set({ data: { status: 'active', name: (typeof name === 'string' && name.trim().slice(0, 20)) || inv.note || '', source: 'invite', inviteCode: code, decidedBy: inv.createdBy, decidedAt: db.serverDate(), reason: '' } });
  return { status: 'active' };
}

async function createInvite({ note, days }, uid) {
  const d = Math.min(30, Math.max(1, int(days) || 7));
  const code = md5(`${uid}|${Date.now()}|${Math.random()}`).slice(0, 12);
  await db.collection('invites').add({ data: { _id: code, createdBy: uid, createdAt: db.serverDate(), expiresAt: Date.now() + d * 86400000, note: cleanReason(note), usedBy: '', revoked: false } });
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
  const nameOf = {};
  profiles.forEach((p) => { if (p._openid && !nameOf[p._openid]) nameOf[p._openid] = p.name; });
  const row = (m) => ({ uid: m._id, name: m.name || '', nickname: nameOf[m._id] || '', note: m.note || '', status: m.status, reason: m.reason || '', source: m.source || '', admin: isAdmin(m._id), at: tsOf({ createdAt: m.decidedAt || m.appliedAt }) });
  const candidates = Object.keys(nameOf).filter((u) => !by[u] && !isAdmin(u)).map((u) => ({ uid: u, nickname: nameOf[u] }));
  const invites = (await db.collection('invites').limit(200).get()).data.filter((x) => !x.usedBy && !x.revoked && x.expiresAt > Date.now()).map((x) => ({ code: x._id, note: x.note, expiresAt: x.expiresAt }));
  return {
    pending: all.filter((m) => m.status === 'pending').map(row),
    active: all.filter((m) => m.status === 'active').map(row).concat(ADMINS().filter((u) => !by[u]).map((u) => ({ uid: u, name: '', nickname: nameOf[u] || '', status: 'active', admin: true }))),
    others: all.filter((m) => m.status === 'rejected' || m.status === 'removed').map(row),
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
  if (isAdmin(target)) deny('管理员由云函数环境变量配置，不能在这里移除');
  const why = cleanReason(reason, true);
  const m = await getDoc('members', target);
  if (!m || m.status !== 'active') deny('不是正式成员');
  await db.collection('members').doc(target).update({ data: { status: 'removed', reason: why, removedBy: uid, removedAt: db.serverDate() } });
  return { status: 'removed' };
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
const GW_WRITE = { matches: 1, players: 1, draws: 1, signups: 1 };
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
async function dataGateway({ op, coll, where, orders, skip, limit, id, data }, uid) {
  if (!GW_READ[coll]) deny('permission denied：不能访问这个集合');
  const col = db.collection(coll);
  if (op === 'get' || op === 'count') {
    const w = where || {};
    if (typeof w !== 'object' || Object.keys(w).some((k) => !isPlain(w[k]))) deny('查询条件不支持');
    let q = Object.keys(w).length ? col.where(w) : col;
    if (op === 'count') return { total: (await q.count()).total };
    (Array.isArray(orders) ? orders : []).slice(0, 3).forEach((o) => { if (Array.isArray(o) && typeof o[0] === 'string') q = q.orderBy(o[0], o[1] === 'desc' ? 'desc' : 'asc'); });
    if (int(skip) > 0) q = q.skip(int(skip));
    return { data: (await q.limit(Math.min(100, Math.max(1, int(limit) || 20))).get()).data };
  }
  if (op === 'doc') {
    const d = typeof id === 'string' ? await getDoc(coll, id) : null;
    if (!d) deny('document not exist');
    return { data: d };
  }
  if (!GW_WRITE[coll]) deny('permission denied：这个集合只能由云函数写入');
  if (op === 'add') {
    const r = await col.add({ data: Object.assign(cleanData(data), { _openid: uid }) });
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

const ACTIONS = { data: dataGateway, memberStatus, applyMember, acceptInvite, createInvite, revokeInvite, listMembers, reviewMember, removeMember, importMembers, ping, resolveFixture, editMatchScore, requestScoreChange, respondScoreChange, ruleScoreChange, cancelScoreChange, requestWithdraw, handleWithdraw, drawRequests, myTodos, addEventPhotos, listEventPhotos, eventPhotoCount, deleteEventPhoto, retryPhotoCheck, recordEventMatch, reviewableWith, matchState, confirmResult, submitReview, reviewSummary, pendingReviews, revokeMatch, getContact, saveContact, saveBio, getBios, avatarUrls };

exports.main = async (event) => {
  // 微信消息推送（图片内容安全检测结果）：只接受推送调用；小程序端调用都会带 userInfo，不能冒充推送
  if (event && event.Event === 'wxa_media_check') {
    if (event.userInfo) return { ok: false, error: '未知操作' };
    try { return await onMediaCheck(event); } catch (e) { console.error(e); return 'success'; }
  }
  const { OPENID } = cloud.getWXContext();
  const fn = ACTIONS[event && event.action];
  if (!fn) return { ok: false, error: '未知操作' };
  if (!OPENID) return { ok: false, error: '无法识别用户' };
  try {
    // 成员资格：每次调用都从数据库重新查（不缓存），移除后下一次操作立即被拦
    if (!PUBLIC[event.action]) {
      const m = await memberOf(OPENID);
      if (m.status !== 'active') return { ok: false, code: 'NOT_MEMBER', status: m.status, error: '仅限内部球友使用' };
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
