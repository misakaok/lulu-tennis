// 活动首页「我的下一场」：用首页已有的活动、战绩和我的报名算出来，不再逐个活动请求详情。
// 只在小程序端用（不进云函数共享文件）；不修改传进来的共享数据。
//
// 1. 下一场（nextMatch）：
//   · 已生成对阵（不是报名中）、按用户 ID（ID.drawUids / ID.idsFor）确定我在其中一方、还没结束的场次；
//     已录分、轮空、弃权、退赛结算、成绩取消的都算结束。「A 组第 1」这类占位没有成员，不会算成我的。
//   · 我已经退赛的活动不再显示。
//   · 日期：单场安排优先，没有就沿用活动日期；昨天及更早的未录分场次不显示（留在活动详情里），今天的照常显示。
//   排序：有日期的在前 → 同一天已定开打时间的在前（按时间）→ 时间待定 → 日期待定的最后；
//   同一优先级：同一活动按现有场次顺序（scheduleOf 已按轮次排好），不同活动按活动开始时间、再按活动列表顺序。
//
// 2. 我报名的活动（signedDraws）：
//   · 报名中（status === 'signup'）、未删除、未提前结束、我有报名记录（自己报或被搭档带上）、今天及以后或日期待定。
//   · 排序：有日期的按日期、开始时间排（同一天时间待定在后），日期待定放最后；最多 5 个。
const E = require('./event');
const ID = require('./ident');

const CAL_DURATION = 3600; // 写进手机日历的默认时长：1 小时
const CAL_ALARM = 3600;    // 开始前 1 小时提醒
const SIGNED_MAX = 5;      // 「我报名的活动」最多显示 5 个

const p2 = (n) => String(n).padStart(2, '0');
function todayOf(now) {
  now = now || new Date();
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
}

function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
  if (!m) return '';
  const y = +m[1], mo = +m[2], dd = +m[3];
  const d = new Date(Date.UTC(y, mo - 1, dd));
  return d.getUTCFullYear() === y && d.getUTCMonth() === mo - 1 && d.getUTCDate() === dd ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

function parseTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  if (!m) return '';
  const hh = +m[1], mm = +m[2];
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59 ? `${p2(hh)}:${p2(mm)}` : '';
}

// 一律按北京时间（+08:00）换算成 Unix 秒，不受手机时区影响
const bjtSec = (date, time) => Math.floor(Date.parse(`${date}T${time}:00+08:00`) / 1000);

// 共用：按日期、时间、场地与备注生成写进手机日历的参数（纯计算，不调微信接口；内容会离开小程序，不带任何人名和用户 ID）
function buildCal(d, date, time, court, description) {
  const dt = parseDate(date);
  if (!dt) return null; // 日期待定：写不进日历
  const useTime = parseTime(time);
  const allDay = !useTime;
  const startTime = bjtSec(dt, allDay ? '00:00' : useTime);
  if (!Number.isFinite(startTime)) return null;
  const endTime = allDay ? startTime : startTime + CAL_DURATION;
  // 地点：地图选点名称地址 + 场地编号（都没有或场地待定就不写）
  const place = E.placeOf(d.place);
  const loc = [];
  if (place) {
    if (place.name) loc.push(place.name);
    if (place.address && place.address !== place.name) loc.push(place.address);
  }
  if (court) loc.push(court);
  const cal = {
    title: `LULU 网球 · ${E.titleOf(d)}`,
    startTime,
    endTime,
    allDay,
    location: loc.join(' '),
    description: description || '',
  };
  // 有具体开打 / 活动时间时提前 1 小时提醒；全天日程交给微信默认提醒
  if (!allDay) {
    cal.alarm = true;
    cal.alarmOffset = CAL_ALARM;
  }
  return cal;
}

// 下一场写进手机日历的参数
function calOf(d, x, date, time, slot) {
  const slotTime = parseTime(time);
  const sameDay = !slot.date || slot.date === d.date;
  const actTime = sameDay ? parseTime(d.startTime) : '';
  const timeNote = slotTime ? '' : actTime ? `本场时间待定，活动 ${actTime} 开始` : '本场时间待定';
  return buildCal(d, date, slotTime || actTime, slot.court || d.venue || '', [x.stage, timeNote].filter(Boolean).join(' · '));
}

function cmp(x, y) {
  for (let i = 0; i < x.length; i++) {
    if (x[i] < y[i]) return -1;
    if (x[i] > y[i]) return 1;
  }
  return 0;
}

// 返回 null（没有符合条件的场次）或卡片要显示的内容
function nextMatch(draws, matches, myId, signups, today) {
  if (!myId) return null;
  today = today || todayOf();
  const byDraw = {}, sigBy = {};
  (matches || []).forEach((m) => { if (m && m.drawId) (byDraw[m.drawId] = byDraw[m.drawId] || []).push(m); });
  (signups || []).forEach((s) => { if (s && s.drawId) (sigBy[s.drawId] = sigBy[s.drawId] || []).push(s); });
  let best = null;
  (draws || []).forEach((d, di) => {
    if (!d || d.deleted || d.status === 'signup' || d.endedAt) return;
    const uidOf = ID.drawUids(d, sigBy[d._id] || []);
    if (!Object.keys(uidOf).some((n) => uidOf[n] === myId)) return; // 这个活动里没有我：不用展开场次
    const wd = E.withdrawalsOf(d);
    E.scheduleOf(d, byDraw[d._id] || []).forEach((x, xi) => {
      if (x.done) return;
      const aIds = ID.idsFor(x.aMembers, uidOf), bIds = ID.idsFor(x.bMembers, uidOf);
      const side = aIds.indexOf(myId) >= 0 ? 'a' : bIds.indexOf(myId) >= 0 ? 'b' : '';
      if (!side || wd[x[side]]) return;
      const slot = x.slot || {};
      const date = slot.date || d.date || '';
      if (date && date < today) return;
      const time = slot.time || '';
      const key = [date ? 0 : 1, date, time ? 0 : 1, time, d.startTime || '', di, xi];
      if (!best || cmp(key, best.key) < 0) best = { key, d, x, side, uidOf, date, time, slot };
    });
  });
  return best && viewOf(best, myId);
}

function viewOf(b, myId) {
  const { d, x, side, uidOf, date, time, slot } = b;
  const other = side === 'a' ? 'b' : 'a';
  const double = E.cfgOf(d).type === 'double';
  const mine = side === 'a' ? x.aMembers : x.bMembers;
  const theirs = other === 'a' ? x.aMembers : x.bMembers;
  const partners = double ? mine.filter((n) => uidOf[n] !== myId) : [];
  const people = (names) => names.map((n) => ({ name: n, uid: uidOf[n] || '' })); // 首字圆 / 照片（<pl-av>）
  const oppTbd = !!(other === 'a' ? x.tbdA : x.tbdB) || !theirs.length;
  // 本场没有单独定开打时间：活动开始时间只是集合时间，不当成本场时间；改到别的日子的场次不提活动时间
  let note = '';
  if (!time) note = d.startTime && (!slot.date || slot.date === d.date) ? `活动 ${d.startTime} 开始 · 本场时间待定` : '本场时间待定';
  return {
    drawId: d._id, key: x.key,
    title: E.titleOf(d), stage: x.stage, double,
    dateText: date ? E.dayText(date) : '日期待定',
    time, note,
    court: slot.court || d.venue || '场地待定',
    partner: partners.join(E.TEAM_SEP),
    partnerP: people(partners),
    opponent: oppTbd ? '待定' : theirs.join(E.TEAM_SEP),
    oppP: oppTbd ? [] : people(theirs),
    oppTbd,
    cal: calOf(d, x, date, time, slot),
  };
}

// 「我报名的活动」：报名中、未删除未提前结束、我有报名记录、今天及以后或日期待定，最多 5 个
function signedDraws(draws, signups, myId, today) {
  if (!myId) return [];
  today = today || todayOf();
  const mine = {};
  (signups || []).forEach((s) => {
    if (s && s.drawId && !mine[s.drawId] && (s._openid === myId || s.partnerId === myId)) mine[s.drawId] = s;
  });
  const rows = [];
  (draws || []).forEach((d, di) => {
    if (!d || !d._id || d.deleted || d.status !== 'signup' || d.endedAt) return;
    const s = mine[d._id];
    if (!s) return;
    const date = parseDate(d.date);
    if (date && date < today) return;
    const time = parseTime(d.startTime);
    const p = E.placeOf(d.place);
    const place = (p && p.name) || '';
    const court = d.venue || '';
    const waiting = s.waiting === true; // 旧版云函数没有 waiting 时按「已报名」处理
    const double = E.cfgOf(d).type === 'double';
    const partner = double ? ((s._openid === myId ? s.partner : s.name) || '') : '';
    const desc = waiting ? '报名中（目前在候补） · 对阵生成后时间可能调整' : '报名中 · 对阵生成后时间可能调整';
    rows.push({
      key: [date ? 0 : 1, date, time ? 0 : 1, time, di],
      view: {
        drawId: d._id,
        title: E.titleOf(d),
        dateText: date ? E.dayText(date) : '日期待定',
        time,
        place,
        court,
        waiting,
        double,
        partner,
        cal: buildCal(d, date, time, court, desc),
      },
    });
  });
  rows.sort((a, b) => cmp(a.key, b.key));
  return rows.slice(0, SIGNED_MAX).map((x) => x.view);
}

module.exports = { nextMatch, signedDraws, todayOf };
