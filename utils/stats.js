// 球员数据（场数、胜率、排名、等级）：都由有效比赛记录实时计算
// 「有效」= db.fetchMatches 返回的记录：活动里改过比分只算最新一条，撤销 / 删除的不算
const R = require('./rating');
const { computeRank } = require('./rules');
const ID = require('./ident');

// 排行榜的「按水平」排序：只按水平高低，再按胜场（排行页也用这个，保证名次一致）。
// 定级中（没打满 R.PROVISIONAL 场）的不排后面、照样有名次，只在界面上标「定级中」（2026-11-25 用户选的）
function rankOrder(list) {
  return list.slice().sort((x, y) => (y.level - x.level) || (y.win - x.win));
}

// map 按统计身份（用户 ID，或 'n:' + 名字，见 utils/ident.js）索引；只有名字时用 stats.keyOf(名字) 换算
//   rank：全体统计身份里的名次（内部用）；boardRank：排行榜上的名次——和排行榜默认榜（生涯 · 全部 · 按水平）一致，
//   只在同意公开展示的账号里排（定级中的也排）；没同意的 / 没有账号的旧名字是 0（shown 为假，界面显示「未公开」）。
//   界面上显示名次一律用 boardRank（球员卡、报名名单、战绩页我的卡片）。
//   profiles（db.profilesOf(players)，按用户 ID）可选：不传时用 players 里的 uid / shown
//   同一组（比赛、球员、资料）数组引用只算一次（见 R.ratingsOf），结果共享、只读
const statsMemo = new WeakMap();
function playerStats(matches, players, profiles) {
  if (!matches || !players) return computeStats(matches, players, profiles);
  const c = statsMemo.get(matches);
  if (c && c.p === players && c.pf === profiles && c.mn === matches.length && c.pn === players.length) return c.r;
  const r = computeStats(matches, players, profiles);
  statsMemo.set(matches, { p: players, pf: profiles, mn: matches.length, pn: players.length, r });
  return r;
}
function computeStats(matches, players, profiles) {
  const ratings = R.ratingsOf(matches || [], players || []);
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
    const shown = !!shownUid[p.key];
    map[p.key] = { played: p.played, win: p.win, rate: p.rate, rank: i + 1, boardRank: shown ? ++n : 0, shown, level: p.level, provisional: p.provisional };
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
    rank: rankText(s, (n) => `第 ${n} 名`),
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

// 名次显示（球员卡、报名名单共用）：没比赛「暂无」、没同意公开「未公开」、其余按 fmt 写名次（定级中的也有名次）
function rankText(s, fmt) {
  if (!s || !s.played) return NONE;
  if (!s.boardRank) return HIDDEN;
  return fmt(s.boardRank);
}

module.exports = { rankOrder, playerStats, display, rankText, genderFinder, boards, GENDER, NONE, HIDDEN };
