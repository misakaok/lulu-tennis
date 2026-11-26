// 小程序里不漏消息（1.3.0，2026-11-27 用户要求）：只用 tab 角标 + 卡片小标签，不推送、不做待办页。
// 全部在本机算：把「现在的样子」和「上次看过的样子」（本机记录 KEY）比较，不新增集合、不写云端。
//
// 活动（底部「活动」tab 数字）：和我有关的活动各记一份签名 drawSig；变了就出一个标签（一张卡片只显示最重要的一个）：
//   已递补 / 对阵已出 / 新活动 / 时间有变 / 进入候补 / 已提前结束。点进活动详情、云端读完就算看过（seeDraw）。
// 比赛（底部「战绩」tab 小红点）：我参加的比赛，别人录入（新）或改了比分（比分有改动）；离开战绩页算看过（seeMatches）。
//
// 规则：
//   · 第一次用（本机没有记录，或换了账号）只记底、不提示，免得升级后满屏标签。
//   · 我自己的操作不提示：我录的 / 我改的比赛直接记成看过；在活动详情里做的操作，详情页读完会按最新内容记成看过。
//   · 只用这次从云端读到的数据算（活动、战绩、我的报名任一项没读到就不更新），不用本机缓存先画，免得标签闪现又消失。
//   · 「已递补 / 进入候补」要云端 mySignups 带 waiting（旧版云函数没有时这两种标签不出现）。
// 本机记录随 utils/member.js 的 clearProtected 清掉（退出成员身份）。
const E = require('./event');
const ID = require('./ident');

const KEY = 'alerts_seen_v1';
const ACT_TAB = 0; // 底部第 1 个「活动」（和 utils/rackets.js 的 RACKET_TAB、utils/member.js 的 ME_TAB 一起改）
const MATCH_TAB = 1; // 底部第 2 个「战绩」
const MAX_MATCHES = 200; // 只记最近录入的这么多场我参加的比赛
const MAX_GONE = 50; // 列表里暂时没有的活动（刚删除、5 分钟内可能撤回）的「看过」记录先留着，最多留最近消失的这么多个

// 标签：优先级从高到低（一张卡片只显示第一个）
const TAGS = {
  back: { text: '已递补', cls: 'lime' },
  drawn: { text: '对阵已出', cls: 'solid' },
  fresh: { text: '新活动', cls: 'lime' },
  moved: { text: '时间有变', cls: 'warn' },
  wait: { text: '进入候补', cls: 'warn' },
  ended: { text: '已提前结束', cls: '' },
};
const ORDER = ['back', 'drawn', 'fresh', 'moved', 'wait', 'ended'];
const MATCH_TAGS = { new: '新', edited: '比分有改动' };

// 微信接口没有（旧基础库、测试环境）或出错：跳过，角标出问题不能影响页面
const call = (name, ...args) => { try { if (typeof wx !== 'undefined' && typeof wx[name] === 'function') return wx[name](...args); } catch (e) {} return undefined; };
// 小程序是不是退到了后台（战绩页离开时用来区分「切到别的 tab」和「退到后台」）
let appHidden = false;
call('onAppHide', () => { appHidden = true; });
call('onAppShow', () => { appHidden = false; });

/* ---------- 本机记录 ---------- */
// { uid, draws: { 活动ID: 签名 }, matches: { 比赛ID: 签名 } }；draws / matches 为 null 表示这一类还没记过底
let mem = null;
function load(uid) {
  if (mem && mem.uid === uid) return mem;
  const s = call('getStorageSync', KEY) || null;
  mem = s && s.uid === uid ? { uid, draws: s.draws || null, matches: s.matches || null, mfloor: s.mfloor || 0 } : { uid, draws: null, matches: null, mfloor: 0 };
  return mem;
}
function save() { call('setStorageSync', KEY, mem); }

/* ---------- 活动 ---------- */
const placeSig = (d) => {
  const p = E.placeOf(d.place) || null;
  const l = d.location && typeof d.location.latitude === 'number' && typeof d.location.longitude === 'number' ? [d.location.latitude.toFixed(4), d.location.longitude.toFixed(4)] : null;
  return JSON.stringify([p && [p.name, p.address], l]);
};
// mine：我在这个活动里的报名记录（自己报的，或被搭档带上的）；matches：这个活动的比赛
// waiting：true 在候补 / false 在名单里 / null 不知道（旧版云函数、没报名）
function drawSig(d, myId, mine, matches, waiting) {
  const signing = d.status === 'signup';
  const uidOf = ID.drawUids(d, mine || []);
  const wd = signing ? {} : E.withdrawalsOf(d);
  // 生成对阵后：对阵里有我、而且我没退赛（候补没进对阵的、退赛了的，之后的变化都和我无关）
  const entrant = !signing && (d.entrants || []).some((ent) => !wd[ent] && E.membersOf(d, ent).some((n) => uidOf[n] === myId));
  const slots = {};
  if (entrant) {
    E.scheduleOf(d, matches || []).forEach((x) => {
      if (x.done) return;
      const aIds = ID.idsFor(x.aMembers, uidOf), bIds = ID.idsFor(x.bMembers, uidOf);
      const side = aIds.indexOf(myId) >= 0 ? 'a' : bIds.indexOf(myId) >= 0 ? 'b' : '';
      if (side && !wd[x[side]]) slots[x.key] = x.slotText || '';
    });
  }
  return {
    s: signing ? 1 : 0,
    own: d._openid === myId ? 1 : 0, // 我发起的（管理员自己建的不算「新活动」）
    v: d.drawVersion || 0,
    e: d.endedAt ? 1 : 0,
    in: (signing ? (mine || []).length > 0 : entrant) ? 1 : 0, // 和我有关：报名中看报名记录，生成对阵后看对阵里有没有我
    w: signing && typeof waiting === 'boolean' ? waiting : null,
    info: [d.date || '', d.startTime || '', d.venue || '', placeSig(d)].join('|'),
    slots,
  };
}
// 时间有变：活动级（日期 / 开始时间 / 场地 / 地点）变了，或者我的哪几场的单场安排变了（新出现的场次不算）
function movedOf(old, cur) {
  const out = { info: false, keys: [] };
  if (!old || !cur.in || !old.in || cur.e) return out; // 已提前结束的活动再改时间地点不提示
  out.info = old.info !== cur.info;
  Object.keys(cur.slots).forEach((k) => { if (k in (old.slots || {}) && old.slots[k] !== cur.slots[k]) out.keys.push(k); });
  return out;
}
// old：看过的签名（没有 = 没看过）；返回标签 key 或 ''
function drawTag(old, cur) {
  if (!old) {
    if (cur.s && !cur.e && !cur.in && !cur.own) return 'fresh'; // 报名中、我还没点开过、也没报名、不是我建的
    if (!cur.s && cur.in && !cur.own) return 'drawn'; // 我建的活动、我自己排的对阵不提示
    return '';
  }
  const has = {};
  if (cur.s && old.w === true && cur.w === false) has.back = 1;
  if (cur.s && old.w === false && cur.w === true) has.wait = 1;
  if (cur.in && !cur.s && (old.s || !old.in || cur.v > (old.v || 0))) has.drawn = 1; // 报名中 → 生成对阵；重新排了对阵；或者新排进了对阵
  const mv = movedOf(old, cur);
  if (mv.info || mv.keys.length) has.moved = 1;
  if (cur.in && !old.e && cur.e) has.ended = 1; // 还和我有关的才提示（候补没进对阵、退赛了的不算）
  return ORDER.find((k) => has[k]) || '';
}

/* ---------- 比赛 ---------- */
const scoreSig = (m) => JSON.stringify([m.sets || [], m.outcome || 'normal', m.winner || '']);
const playsIn = (m, myId) => !!myId && ((m.aIds || []).indexOf(myId) >= 0 || (m.bIds || []).indexOf(myId) >= 0);
const recorderOf = (m) => m._openid || m.recordedBy || '';
const changerOf = (m) => (m.lastChange && m.lastChange.by) || recorderOf(m);
function myMatches(matches, myId) {
  return (matches || []).filter((m) => m && m._id && playsIn(m, myId))
    .sort((x, y) => E.tsOf(y) - E.tsOf(x)).slice(0, MAX_MATCHES);
}

/* ---------- 计算结果（内存里，页面画卡片用） ---------- */
let last = { uid: '', draws: {}, matches: {}, moved: {}, ver: 0 };
let ctx = { draws: null, matches: null, mySignups: null }; // 最近一次云端读到的数据（seeMatches 用）
const bump = () => { last.ver++; };

// 活动：draws / mySignups / matches 都必须是这次云端读到的；返回 { 活动ID: 标签 key }
function updateDraws(draws, matches, mySignups, myId) {
  if (!myId || !Array.isArray(draws) || !Array.isArray(matches) || !Array.isArray(mySignups)) return last.draws;
  const st = load(myId);
  ctx.draws = draws; ctx.mySignups = mySignups;
  const byDraw = {}, sigBy = {};
  matches.forEach((m) => { if (m && m.drawId) (byDraw[m.drawId] = byDraw[m.drawId] || []).push(m); });
  mySignups.forEach((s) => { if (s && s.drawId) (sigBy[s.drawId] = sigBy[s.drawId] || []).push(s); });
  const first = !st.draws;
  const seen = st.draws || {};
  const next = {}, tags = {}, moved = {};
  let dirty = first;
  draws.forEach((d) => {
    if (!d || !d._id || d.deleted) return;
    const mine = sigBy[d._id] || [];
    const w = mine.find((s) => typeof s.waiting === 'boolean');
    const cur = drawSig(d, myId, mine, byDraw[d._id], w ? !!w.waiting : null);
    const old = seen[d._id];
    if (first) { next[d._id] = cur; return; } // 第一次：只记底
    const t = drawTag(old, cur);
    if (t) tags[d._id] = t;
    if (t === 'moved') moved[d._id] = movedOf(old, cur);
    // 有标签：照旧留着看过时的样子（点进详情才算看过）；没标签：跟到现在的样子（比如刚被搭档带上报名、进了下一轮多出的场次，
    // 不然之后再变会比不出来）；没看过、但和我无关的（报名截止后才出现、没有我）不用记
    if (old && t) next[d._id] = old;
    else if (old) { next[d._id] = cur; if (JSON.stringify(old) !== JSON.stringify(cur)) dirty = true; }
    else if (!t && (cur.in || !cur.s)) { next[d._id] = cur; dirty = true; }
  });
  // 列表里暂时没有的（刚删除、可能撤回）先留着，接在后面：越早消失的越靠后，超过 MAX_GONE 个时删最早消失的
  const gone = Object.keys(seen).filter((id) => !(id in next));
  gone.slice(0, MAX_GONE).forEach((id) => { next[id] = seen[id]; });
  if (gone.some((id) => !(id in next))) dirty = true;
  st.draws = next;
  if (dirty) save();
  if (last.uid !== myId) last = { uid: myId, draws: {}, matches: {}, moved: {}, ver: last.ver + 1 };
  if (JSON.stringify(tags) !== JSON.stringify(last.draws) || JSON.stringify(moved) !== JSON.stringify(last.moved)) { last.draws = tags; last.moved = moved; bump(); }
  applyBadges();
  return last.draws;
}

// 比赛：matches 是这次云端读到的正式战绩；返回 { 比赛ID: 'new' | 'edited' }
function updateMatches(matches, myId) {
  if (!myId || !Array.isArray(matches)) return last.matches;
  const st = load(myId);
  ctx.matches = matches;
  const list = myMatches(matches, myId);
  const first = !st.matches;
  const seen = st.matches || {};
  // 水位线：比记过的最早一场还早录入的比赛（比如撤销了最新一场，第 201 场顶进来）不算新
  const floor = first ? 0 : (st.mfloor || 0);
  const next = {}, tags = {};
  let dirty = first;
  list.forEach((m) => {
    const cur = scoreSig(m);
    const old = seen[m._id];
    if (first || old === cur || (old === undefined && E.tsOf(m) <= floor)) { if (old !== cur) dirty = true; next[m._id] = cur; return; }
    if (changerOf(m) === myId) { next[m._id] = cur; dirty = true; return; } // 最后一次是我自己录的 / 改的
    tags[m._id] = old === undefined && recorderOf(m) !== myId ? 'new' : 'edited'; // 我录的、还没看到就被别人改了：算「比分有改动」
    if (old !== undefined) next[m._id] = old;
  });
  if (Object.keys(seen).some((id) => !(id in next) && !tags[id])) dirty = true;
  const mfloor = list.length >= MAX_MATCHES ? Math.max(floor, E.tsOf(list[list.length - 1])) : floor;
  if (mfloor !== (st.mfloor || 0)) { st.mfloor = mfloor; dirty = true; }
  st.matches = next;
  if (dirty) save();
  if (last.uid !== myId) last = { uid: myId, draws: {}, matches: {}, moved: {}, ver: last.ver + 1 };
  if (JSON.stringify(tags) !== JSON.stringify(last.matches)) { last.matches = tags; bump(); }
  applyBadges();
  return last.matches;
}

// 活动详情云端读完：按最新内容记成看过。signups：这个活动的完整报名名单（报名中才有用）
function seeDraw(d, myId, signups, matches) {
  if (!d || !d._id || !myId) return;
  const st = load(myId);
  if (!st.draws) return; // 还没记过底：首页第一次读完会把它一起记上
  const mine = (signups || []).filter((s) => s && (s._openid === myId || s.partnerId === myId));
  let waiting = null;
  // 和云端 mySignups 同一口径：只有还在报名中（没提前结束）的活动才算候补
  if (d.status === 'signup' && !d.endedAt && mine.length) waiting = !!E.waitingOf(signups, E.capacityOf(d))[mine[0]._id];
  const cur = drawSig(d, myId, mine, (matches || []).filter((m) => m && m.drawId === d._id), waiting);
  if (JSON.stringify(st.draws[d._id]) !== JSON.stringify(cur)) { st.draws[d._id] = cur; save(); }
  if (last.uid === myId && last.draws[d._id]) {
    last.draws = Object.assign({}, last.draws);
    delete last.draws[d._id];
    bump();
    applyBadges();
  }
}

// 战绩页读到就算看过（页面自己留一份，这次停留里照常显示标签）
function seeMatches(myId) {
  if (!myId || last.uid !== myId || !Object.keys(last.matches).length || !ctx.matches) return;
  const st = load(myId);
  const seen = Object.assign({}, st.matches || {});
  myMatches(ctx.matches, myId).forEach((m) => { if (last.matches[m._id]) seen[m._id] = scoreSig(m); });
  st.matches = seen;
  save();
  last.matches = {};
  bump();
  applyBadges();
}

/* ---------- tab 角标 ---------- */
let shownBadge = { act: -1, dot: -1 };
let viewing = false; // 正在看战绩页：小红点先收起
function viewMatches(on) { viewing = !!on; applyBadges(); }
// force：tab 页 onShow 时照样重设一次（上一次在非 tab 页设置，失败回调可能晚到，不能只看记下的值）
function applyBadges(force) {
  if (force) shownBadge = { act: -1, dot: -1 };
  const act = Object.keys(last.draws).length;
  const dot = !viewing && Object.keys(last.matches).length ? 1 : 0;
  // 当前不在 tab 页（比如从分享的活动链接进来）时设置会失败：失败就不记，下次再设
  const retry = (k) => () => { shownBadge[k] = -1; };
  if (act !== shownBadge.act) {
    shownBadge.act = act;
    if (act > 0) call('setTabBarBadge', { index: ACT_TAB, text: act > 99 ? '99+' : String(act), fail: retry('act') });
    else call('removeTabBarBadge', { index: ACT_TAB, fail: retry('act') });
  }
  if (dot !== shownBadge.dot) {
    shownBadge.dot = dot;
    if (dot) call('showTabBarRedDot', { index: MATCH_TAB, fail: retry('dot') });
    else call('hideTabBarRedDot', { index: MATCH_TAB, fail: retry('dot') });
  }
}

// 打开小程序停在别的页面（比如从分享的活动链接进来）也能看到角标：成员校验通过后读一次（都是共享的 60 秒缓存，和首页同时读不会重复请求）
async function refresh() {
  try {
    const db = require('./db');
    const [draws, matches, myId, mySignups] = await Promise.all([db.drawsShared(), db.matchesShared(), db.myOpenid(), db.fetchMySignups()]);
    updateMatches(matches, myId);
    updateDraws(draws, matches, mySignups, myId);
  } catch (e) {} // 读不到：保留上次的，不误判
}

// 退出成员身份 / 换账号：忘掉内存里的结果和角标
function reset() {
  mem = null;
  last = { uid: '', draws: {}, matches: {}, moved: {}, ver: last.ver + 1 };
  ctx = { draws: null, matches: null, mySignups: null };
  applyBadges();
}

const drawTagOf = (id) => (last.draws[id] ? TAGS[last.draws[id]] : null);
// 「我的下一场」这一场有没有变：活动级的变了，或者正好是这一场的单场安排变了
const nextMoved = (drawId, key) => { const m = last.draws[drawId] === 'moved' && last.moved[drawId]; return !!m && (m.info || m.keys.indexOf(key) >= 0); };
const matchTagOf = (id) => MATCH_TAGS[last.matches[id]] || '';
const matchTags = () => { const out = {}; Object.keys(last.matches).forEach((id) => { out[id] = MATCH_TAGS[last.matches[id]]; }); return out; }; // { 比赛ID: '新' | '比分有改动' }
const version = () => last.ver;
const uid = () => last.uid; // 现在这份结果是哪个账号的（reset 后为空）
const isAppHidden = () => appHidden;

module.exports = {
  KEY, ACT_TAB, MATCH_TAB, MAX_MATCHES, TAGS, ORDER, MATCH_TAGS,
  drawSig, drawTag, updateDraws, updateMatches, seeDraw, seeMatches, viewMatches, refresh, reset, applyBadges,
  drawTagOf, nextMoved, matchTagOf, matchTags, version, uid, isAppHidden, MAX_GONE,
};
