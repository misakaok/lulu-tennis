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
function playerStats(matches, players) {
  const ratings = R.computeRatings(matches || [], R.startLevelsFrom(players || []));
  const rows = computeRank(matches || [], 'all').map((p) => {
    const r = ratings.players[p.key];
    return Object.assign(p, { level: r ? r.level : R.DEFAULT_LEVEL, provisional: !r || r.provisional });
  });
  const map = {};
  rankOrder(rows).forEach((p, i) => { map[p.key] = { played: p.played, win: p.win, rate: p.rate, rank: i + 1, level: p.level, provisional: p.provisional }; });
  return { map, ratings, total: rows.length, keyOf: ID.keyResolver(players || []) };
}

const GENDER = { m: '男', f: '女' };
const NONE = '暂无';

// 报名列表等处展示用：没有数据的显示「暂无」。有用户 ID 时按 ID 找，否则按名字
function display(stats, name, profile, uid) {
  const s = stats.map[stats.keyOf(name, uid)];
  const self = profile && typeof profile.level === 'number' ? profile.level : null;
  return {
    gender: (profile && GENDER[profile.gender]) || NONE,
    played: s && s.played ? `${s.played} 场` : NONE,
    rate: s && s.played ? `${s.rate}%` : NONE,
    rank: s && s.played ? `第 ${s.rank} 名` : NONE,
    level: s && s.played ? R.fmt(s.level) + (s.provisional ? ' 定级中' : '') : self !== null ? `${R.fmt(self)} 自评` : NONE,
  };
}

module.exports = { rankOrder, playerStats, display, GENDER, NONE };
