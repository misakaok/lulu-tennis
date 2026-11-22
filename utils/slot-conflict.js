// 「安排时间场地」保存前的冲突提示（只在小程序端；只提示，不拦截，保存照常走 setFixtureSlot）。
// 第一版只查同一活动里、同一天、同一个明确开打时间、还没结束的场次：
//   · 场地冲突：两场单独排在同一片场地（只比较单场安排里选的场地；没单独排场地、只沿用活动场地的不算，2026-11-22 用户选的）
//   · 球员冲突：同一位球员同时在两场（按用户 ID，双打四位都查；对阵待定的一方没有确定的球员，只查已确定的）
// 日期没单独排的沿用活动日期；开打时间只认单场安排的 time——只有活动开始时间、没有单场开打时间的场次不查。
// 正在编辑的这一场本身不算。
const E = require('./event');
const ID = require('./ident');

// d：活动；matches：这个活动的比赛记录；uidOf：参加名 → 用户 ID（ID.drawUids）；key：正在编辑的场次；slot：要保存的 { date, time, court }
function slotConflicts(d, matches, uidOf, key, slot) {
  const s = slot || {};
  const date = s.date || (d && d.date) || '', time = s.time || '';
  if (!d || !date || !time) return [];
  const court = E.courtOf(s.court);
  const list = E.scheduleOf(d, matches || []);
  const self = list.find((x) => x.key === key);
  if (!self) return [];
  const people = (x) => {
    const names = (x.aMembers || []).concat(x.bMembers || []);
    const ids = ID.idsFor(names, uidOf);
    const out = {};
    names.forEach((n, i) => { if (ids[i] && !out[ids[i]]) out[ids[i]] = n; });
    return out; // 用户 ID → 名字（没有账号的不查）
  };
  const mine = people(self);
  const out = [];
  list.forEach((x) => {
    if (x.key === key || x.done) return;
    const t = x.slot || {};
    if (!t.time || t.time !== time || (t.date || d.date || '') !== date) return;
    const reasons = [];
    const xCourt = E.courtOf(t.court);
    if (court && xCourt === court) reasons.push(`同一片场地（${court}）`);
    const theirs = people(x);
    const both = Object.keys(mine).filter((u) => theirs[u]).map((u) => mine[u]);
    if (both.length) reasons.push(`${both.join('、')} 同时在这两场`);
    if (reasons.length) {
      out.push({
        key: x.key, stage: x.stage,
        a: x.tbdA ? x.labelA || '待定' : x.a, b: x.tbdB ? x.labelB || '待定' : x.b,
        reasons, court: reasons[0].indexOf('同一片场地') === 0, players: both,
      });
    }
  });
  return out;
}

// 弹窗里的说明：哪几场、为什么（最多列 3 场）
const SHOW_MAX = 3;
function conflictText(hits, slot, d) {
  const s = slot || {};
  const when = [E.dayText(s.date || (d && d.date) || ''), s.time].filter(Boolean).join(' ');
  const lines = hits.slice(0, SHOW_MAX).map((h) => `· ${h.stage}：${h.a} vs ${h.b}\n  ${h.reasons.join('；')}`);
  if (hits.length > SHOW_MAX) lines.push(`另外还有 ${hits.length - SHOW_MAX} 场`);
  return `${when} 已经排了：\n${lines.join('\n')}`;
}

module.exports = { slotConflicts, conflictText };
