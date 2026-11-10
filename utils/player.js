// 球员主页的数据：「我的」和别人的主页共用（pages/me、pages/player、pages/history 都用这里）
//   人按用户 ID 找（profiles[uid]），比赛只用正式战绩（db.fetchMatches），
//   场数 / 胜负 / 胜率 / 排名 / 比赛等级都由比赛记录计算，和排行榜、报名名单同一套规则。
const R = require('./rating');
const S = require('./stats');
const { outcomeOf, isNormal } = require('./rules');
const CA = require('./career');
const SE = require('./season');

const NONE = S.NONE;

// 这位球员在这场的哪一方：按统计身份（用户 ID）找；记录没有统计身份时（旧缓存）按名字
function sideOf(m, key, name) {
  for (const s of ['a', 'b']) {
    const ks = m[s + 'Keys'];
    if (ks ? ks.indexOf(key) >= 0 : (m[s] || []).indexOf(name) >= 0) return s;
  }
  return '';
}

// 一场比赛，从这位球员的角度看
function matchRow(m, key, name, deltaOf) {
  const side = sideOf(m, key, name), o = side === 'a' ? 'b' : 'a';
  const myKeys = m[side + 'Keys'];
  const h = deltaOf[m._id];
  return {
    id: m._id, date: m.date || '', md: (m.date || '').slice(5),
    event: m.drawId ? `${m.drawTitle || '活动'}${m.stage ? ' · ' + m.stage : ''}` : '日常比赛',
    isEvent: !!m.drawId,
    opp: (m[o] || []).join(' / '),
    partner: (m[side] || []).filter((n, i) => (myKeys ? myKeys[i] !== key : n !== name)).join(' / '),
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
 * 返回 { profile, ambiguous, level, stats, rows, career }，没有这个人时 profile 为 null
 */
// 生涯成就和各赛季战绩（utils/career.js），整理成页面直接能用的文字
function careerView(matches, uid, name, history) {
  const c = CA.career(matches, uid, name, history);
  const cur = SE.current();
  const lines = [];
  if (c.single.played) lines.push({ k: '单打', v: `${c.single.win}胜 ${c.single.played - c.single.win}负` });
  if (c.double.played) lines.push({ k: '双打', v: `${c.double.win}胜 ${c.double.played - c.double.win}负` });
  if (c.rival) lines.push({ k: '老对手', v: `${c.rival.name} · 交手 ${c.rival.played} 场 ${c.rival.win}胜 ${c.rival.lose}负` });
  if (c.first) lines.push({ k: '首场比赛', v: c.first });
  return {
    has: c.played > 0 || c.finals > 0,
    cells: [
      { n: String(c.titles.length), l: '冠军' }, { n: String(c.finals), l: '决赛' }, { n: String(c.events), l: '参加活动' },
      { n: String(c.bestStreak), l: '最长连胜' }, { n: String(c.streak), l: '当前连胜' }, { n: c.peak === null ? NONE : R.fmt(c.peak), l: '最高等级' },
    ],
    lines, badges: c.badges, got: c.got, total: c.badges.length,
    titles: c.titles.map((t) => ({ title: t.title, date: t.date })),
    seasons: c.seasons.map((s) => ({ season: s.season, now: s.season === cur, played: s.played, wl: `${s.win}-${s.lose}`, rate: s.played ? s.rate + '%' : NONE, titles: s.titles })),
  };
}

function playerView(profiles, players, matches, uid) {
  const p = uid && profiles ? profiles[uid] : null;
  if (!p) return { profile: null, rows: [] };
  // 统计按用户 ID：即使有人和 TA 同名，也不会把别人的战绩算进来
  const stats = S.playerStats(matches || [], players || []);
  const st = stats.map[uid] || null;
  const r = stats.ratings.players[uid] || null;
  const mine = (matches || []).filter((m) => sideOf(m, uid, p.name));
  const wins = mine.filter((m) => isNormal(m) && m.winner === sideOf(m, uid, p.name)).length;
  const ambiguous = false;
  const deltaOf = {};
  (r ? r.history : []).forEach((h) => { deltaOf[h.id] = h; });
  const rows = mine
    .slice()
    .sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')) || String(y._id).localeCompare(String(x._id)))
    .map((m) => matchRow(m, uid, p.name, deltaOf));
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
    career: careerView(matches || [], uid, p.name, r ? r.history : []),
  };
}

module.exports = { playerView, matchRow, sideOf, careerView };
