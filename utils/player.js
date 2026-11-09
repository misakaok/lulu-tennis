// 球员主页的数据：「我的」和别人的主页共用（pages/me、pages/player、pages/history 都用这里）
//   人按用户 ID 找（profiles[uid]），比赛只用正式战绩（db.fetchMatches），
//   场数 / 胜负 / 胜率 / 排名 / 比赛等级都由比赛记录计算，和排行榜、报名名单同一套规则。
const R = require('./rating');
const S = require('./stats');
const { outcomeOf, isNormal } = require('./rules');

const NONE = S.NONE;

function sideOf(m, name) {
  if ((m.a || []).indexOf(name) >= 0) return 'a';
  if ((m.b || []).indexOf(name) >= 0) return 'b';
  return '';
}

// 一场比赛，从这位球员的角度看
function matchRow(m, name, deltaOf) {
  const side = sideOf(m, name), o = side === 'a' ? 'b' : 'a';
  const h = deltaOf[m._id];
  return {
    id: m._id, date: m.date || '', md: (m.date || '').slice(5),
    event: m.drawId ? `${m.drawTitle || '赛事'}${m.stage ? ' · ' + m.stage : ''}` : '日常比赛',
    isEvent: !!m.drawId,
    opp: (m[o] || []).join(' / '),
    partner: (m[side] || []).filter((n) => n !== name).join(' / '),
    score: (m.sets || []).map((s) => {
      const x = s[side], y = s[o], tx = side === 'a' ? s.tbA : s.tbB, ty = side === 'a' ? s.tbB : s.tbA;
      return `${x}-${y}` + (tx !== undefined && ty !== undefined ? `(${tx}-${ty})` : '');
    }).join(' '),
    win: m.winner === side,
    // 弃权 / 中途退赛：单独标出，不计入完赛场数和胜率
    outcome: outcomeOf(m), outcomeTag: outcomeOf(m) === 'walkover' ? (m.winner === side ? '弃权胜' : '弃权负') : outcomeOf(m) === 'retired' ? (m.winner === side ? '对手退赛' : '中途退赛') : '',
    delta: h ? R.fmtDelta(h.delta) : '', up: !!h && h.delta > 0, down: !!h && h.delta < 0,
  };
}

/**
 * profiles: { uid: 本人资料 }（db.cachedProfiles）；players: db.fetchPlayersFull；matches: 正式战绩
 * 返回 { profile, ambiguous, level, stats, rows }，没有这个人时 profile 为 null
 */
function playerView(profiles, players, matches, uid) {
  const p = uid && profiles ? profiles[uid] : null;
  if (!p) return { profile: null, rows: [] };
  const merged = (players || []).find((x) => x.name === p.name);
  // 两个账号用了同一个昵称：按名字算的统计分不清是谁的，宁可不显示，也不把别人的战绩算到这里
  const ambiguous = !!(merged && merged.ambiguous);
  const stats = S.playerStats(matches || [], players || []);
  const st = ambiguous ? null : stats.map[p.name];
  const r = ambiguous ? null : stats.ratings.players[p.name];
  const mine = ambiguous ? [] : (matches || []).filter((m) => sideOf(m, p.name));
  const wins = mine.filter((m) => isNormal(m) && m.winner === sideOf(m, p.name)).length;
  const deltaOf = {};
  (r ? r.history : []).forEach((h) => { deltaOf[h.id] = h; });
  const rows = mine
    .slice()
    .sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')) || String(y._id).localeCompare(String(x._id)))
    .map((m) => matchRow(m, p.name, deltaOf));
  const last = r && r.history.length ? r.history[r.history.length - 1].delta : null;
  const selfLv = typeof p.level === 'number' ? p.level : null;
  const played = st ? st.played : 0;
  return {
    profile: { uid, name: p.name, avatar: p.avatar || '', gender: S.GENDER[p.gender] || '性别未公开' },
    ambiguous,
    level: {
      // 比赛等级（由比赛算）和自评等级分开显示；没有就是「暂无」
      match: r ? R.fmt(r.level) : NONE,
      self: selfLv !== null ? R.fmt(selfLv) : NONE,
      tier: r ? R.tierOf(r.level) + '球员' : selfLv !== null ? R.tierOf(selfLv) + '球员（自评）' : '等级未知',
      provisional: !!r && r.provisional, played: r ? r.played : 0, need: R.PROVISIONAL,
      last: last === null ? '' : R.fmtDelta(last), up: last > 0, down: last < 0,
    },
    stats: {
      rank: played ? '#' + st.rank : NONE,
      matches: played ? String(played) : NONE,
      wl: played ? `${wins}胜 ${played - wins}负` : NONE,
      rate: played ? st.rate + '%' : NONE,
    },
    rows,
  };
}

module.exports = { playerView, matchRow, sideOf };
