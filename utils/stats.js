// 球员数据（场数、胜率、排名、等级）：都由有效比赛记录实时计算
// 「有效」= db.fetchMatches 返回的记录：活动里改过比分只算最新一条，撤销 / 删除的不算
const R = require('./rating');
const { computeRank } = require('./rules');
const ID = require('./ident');

// 排行榜的「按水平」排序：定级完成的在前，再按水平、胜场（排行页也用这个，保证名次一致）
function rankOrder(list) {
  return list.slice().sort((x, y) => (x.provisional - y.provisional) || (y.level - x.level) || (y.win - x.win));
}

// map 按统计身份（用户 ID，或 'n:' + 名字，见 utils/ident.js）索引；只有名字时用 stats.keyOf(名字) 换算
//   rank：全体统计身份里的名次（内部用）；boardRank：排行榜上的名次——和排行榜默认榜（生涯 · 全部 · 按水平）一致，
//   只在同意公开展示的账号里排，没同意的 / 没有账号的旧名字是 0（界面显示「未公开」）。
//   界面上显示名次一律用 boardRank（球员卡、报名名单、战绩页我的卡片）。
//   profiles（db.profilesOf(players)，按用户 ID）可选：不传时用 players 里的 uid / shown
function playerStats(matches, players, profiles) {
  const ratings = R.computeRatings(matches || [], R.startLevelsFrom(players || []));
  const rows = computeRank(matches || [], 'all').map((p) => {
    const r = ratings.players[p.key];
    return Object.assign(p, { level: r ? r.level : R.DEFAULT_LEVEL, provisional: !r || r.provisional });
  });
  const map = {};
  const shownUid = {};
  if (profiles) Object.keys(profiles).forEach((u) => { if (profiles[u] && profiles[u].shown === true) shownUid[u] = 1; });
  else (players || []).forEach((p) => { if (p && p.uid && p.shown === true) shownUid[p.uid] = 1; });
  let n = 0;
  rankOrder(rows).forEach((p, i) => {
    map[p.key] = { played: p.played, win: p.win, rate: p.rate, rank: i + 1, boardRank: shownUid[p.key] ? ++n : 0, level: p.level, provisional: p.provisional };
  });
  return { map, ratings, total: rows.length, keyOf: ID.keyResolver(players || []) };
}

const GENDER = { m: '男', f: '女' };
const NONE = '暂无';
const HIDDEN = '未公开'; // 没同意公开展示：不上排行榜，也不显示名次

// 报名列表等处展示用：没有数据的显示「暂无」。有用户 ID 时按 ID 找，否则按名字
function display(stats, name, profile, uid) {
  const s = stats.map[stats.keyOf(name, uid)];
  const self = profile && typeof profile.level === 'number' ? profile.level : null;
  return {
    gender: (profile && GENDER[profile.gender]) || NONE,
    played: s && s.played ? `${s.played} 场` : NONE,
    rate: s && s.played ? `${s.rate}%` : NONE,
    rank: s && s.played ? (s.boardRank ? `第 ${s.boardRank} 名` : HIDDEN) : NONE,
    level: s && s.played ? R.fmt(s.level) + (s.provisional ? ' 定级中' : '') : self !== null ? `${R.fmt(self)} 自评` : NONE,
  };
}

// 趣味榜单（排行页）：本月活跃（本月完赛场数）、连胜（当前连胜场数）、进步（本月等级涨幅）。
// 都从同一套正式战绩和水平分算，只数正常完赛的比赛；type = 'all' | 'single' | 'double'（进步榜的等级不分单双打）
// month: 'YYYY-MM'。返回 { active, streak, gain }，各自是 { 统计身份: 数值 }
function boards(matches, ratings, type, month) {
  const { isNormal } = require('./rules');
  const { tsOf } = require('./event');
  const active = {}, streak = {}, gain = {};
  (matches || []).filter((m) => isNormal(m) && (type === 'all' || m.type === type))
    .sort((x, y) => String(x.date || '').localeCompare(String(y.date || '')) || tsOf(x) - tsOf(y))
    .forEach((m) => ['a', 'b'].forEach((side) => {
      const keys = m[side + 'Keys'] || [];
      (m[side] || []).forEach((n, i) => {
        const k = keys[i] || n;
        if (String(m.date || '').indexOf(month) === 0) active[k] = (active[k] || 0) + 1;
        streak[k] = m.winner === side ? (streak[k] || 0) + 1 : 0;
      });
    }));
  const ps = (ratings && ratings.players) || {};
  Object.keys(ps).forEach((k) => {
    const hs = (ps[k].history || []).filter((h) => String(h.date || '').indexOf(month) === 0);
    if (hs.length) gain[k] = Math.round(hs.reduce((s, h) => s + h.delta, 0) * 100) / 100;
  });
  return { active, streak, gain };
}

// 名字旁边显示性别用：有用户 ID 按 ID 找，否则按名字（同名对应多个账号时不显示）。没填返回 ''
function genderFinder(players) {
  const byUid = {}, byName = {};
  (players || []).forEach((p) => { if (p.uid) byUid[p.uid] = p.gender; if (!p.ambiguous) byName[p.name] = p.gender; });
  return (name, uid) => GENDER[uid ? byUid[uid] : byName[name]] || '';
}

module.exports = { rankOrder, playerStats, display, genderFinder, boards, GENDER, NONE, HIDDEN };
