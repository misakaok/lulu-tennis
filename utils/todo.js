// 待办：下一场比赛（按赛程实时算）+ 云函数 myTodos（待我确认 / 等对方确认 / 待评价 / 改分申请 / 退赛申请）
// 都从当前数据实时计算：已完成、取消（退赛成绩取消）或失效的事项自然不再出现
const db = require('./db');
const E = require('./event');
const ID = require('./ident');
const cloud = require('./cloud');

const WEEK = '日一二三四五六';
function whenOf(d) {
  if (!d.date) return '待安排';
  const [y, m, dd] = d.date.split('-').map(Number);
  return `${m}月${dd}日 周${WEEK[new Date(y, m - 1, dd).getDay()]}` + (d.startTime ? ' ' + d.startTime : '');
}

// 我在各个赛事里「对手已确定、还没打」的比赛
function nextMatches(draws, matches, myId, mySignups) {
  const out = [];
  (draws || []).forEach((d) => {
    if (d.status === 'signup') return;
    const uidOf = ID.drawUids(d, (mySignups || []).filter((s) => s.drawId === d._id));
    E.scheduleOf(d, matches).forEach((x) => {
      if (!x.ready || x.done || x.void) return;
      const a = ID.idsFor(x.aMembers, uidOf), b = ID.idsFor(x.bMembers, uidOf);
      const side = a.indexOf(myId) >= 0 ? 'a' : b.indexOf(myId) >= 0 ? 'b' : '';
      if (!side) return;
      out.push({
        drawId: d._id, key: x.key, title: d.title || '赛事', stage: x.stage, rule: x.ruleText,
        opp: side === 'a' ? x.b : x.a, venue: d.venue || '待安排', when: whenOf(d), sortKey: (d.date || '9999') + (d.startTime || '99:99'),
      });
    });
  });
  return out.sort((x, y) => (x.sortKey < y.sortKey ? -1 : x.sortKey > y.sortKey ? 1 : 0));
}

async function load() {
  const [draws, matches, myId] = await Promise.all([db.fetchDraws(), db.fetchMatches(), db.myOpenid()]);
  const mySignups = await db.fetchMySignups().catch(() => []);
  const next = nextMatches(draws, matches, myId, mySignups);
  let srv = { toConfirm: [], waiting: [], toReview: [], toRespond: [], myRequests: [], withdraws: [] };
  let error = '';
  try { srv = await cloud.call('myTodos'); } catch (e) { error = e.message; }
  const count = next.length + srv.toConfirm.length + srv.toReview.length + srv.toRespond.length + srv.withdraws.length;
  return Object.assign({ next, count, error }, srv);
}

module.exports = { load, nextMatches, whenOf };
