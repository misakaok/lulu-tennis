// 生涯成就：全部由正式战绩（db.fetchMatches）实时计算，不单独存数据，也不能手动修改。
//   场数、胜负、胜率只算正常完赛的比赛（isNormal），和排行榜、球员主页同一个口径；
//   冠军 / 亚军看赛事决赛的比赛记录（弃权胜也算夺冠）；赛事删除后比分还在，冠军也还在。
const { isNormal } = require('./rules');
const { tsOf } = require('./event');
const SE = require('./season');

// 这位球员在这场的哪一方：按统计身份找；旧缓存里的记录没有统计身份时按名字
function sideOf(m, key, name) {
  for (const s of ['a', 'b']) {
    const ks = m[s + 'Keys'];
    if (ks ? ks.indexOf(key) >= 0 : (m[s] || []).indexOf(name) >= 0) return s;
  }
  return '';
}
const isFinal = (m) => !!m.drawId && /(^|· )决赛$/.test(m.stage || '');
const pct = (win, played) => (played ? Math.round((win / played) * 100) : 0);

// 成就徽章：need 是达成条件，v 取当前进度
const BADGES = [
  { id: 'debut', icon: '🎾', name: '初登场', desc: '完成第一场正式比赛', need: 1, v: (c) => c.played },
  { id: 'win1', icon: '✌️', name: '首胜', desc: '赢下第一场比赛', need: 1, v: (c) => c.win },
  { id: 'p10', icon: '🔟', name: '常客', desc: '打满 10 场', need: 10, v: (c) => c.played },
  { id: 'p50', icon: '💪', name: '老将', desc: '打满 50 场', need: 50, v: (c) => c.played },
  { id: 'p100', icon: '💯', name: '百场', desc: '打满 100 场', need: 100, v: (c) => c.played },
  { id: 's3', icon: '🔥', name: '三连胜', desc: '连赢 3 场', need: 3, v: (c) => c.bestStreak },
  { id: 's5', icon: '🚀', name: '五连胜', desc: '连赢 5 场', need: 5, v: (c) => c.bestStreak },
  { id: 's10', icon: '👑', name: '十连胜', desc: '连赢 10 场', need: 10, v: (c) => c.bestStreak },
  { id: 'final', icon: '🥈', name: '决赛选手', desc: '打进一次赛事决赛', need: 1, v: (c) => c.finals },
  { id: 'champ', icon: '🏆', name: '冠军', desc: '赢得一项赛事', need: 1, v: (c) => c.titles.length },
  { id: 'champ3', icon: '🏅', name: '三冠王', desc: '赢得 3 项赛事', need: 3, v: (c) => c.titles.length },
  { id: 'ev5', icon: '📅', name: '赛事达人', desc: '参加 5 项赛事', need: 5, v: (c) => c.events },
  { id: 'bagel', icon: '🥚', name: '送蛋', desc: '一盘没让对手拿到一局', need: 1, v: (c) => c.bagels },
  { id: 'comeback', icon: '🔄', name: '逆转', desc: '先丢一盘后赢下比赛', need: 1, v: (c) => c.comebacks },
  { id: 'both', icon: '🤝', name: '单双全能', desc: '单打和双打都赢过', need: 2, v: (c) => (c.single.win ? 1 : 0) + (c.double.win ? 1 : 0) },
];

/**
 * matches: 正式战绩（带 aKeys / bKeys）；key: 统计身份（用户 ID）；name: 当前昵称；
 * history: 这位球员的水平分变化（ratings.players[key].history），用来取最高水平
 */
function career(matches, key, name, history) {
  const mine = (matches || []).filter((m) => sideOf(m, key, name))
    .sort((x, y) => String(x.date || '').localeCompare(String(y.date || '')) || tsOf(x) - tsOf(y));
  const c = {
    played: 0, win: 0, lose: 0, rate: 0, titles: [], finals: 0, events: 0, streak: 0, bestStreak: 0,
    peak: null, single: { played: 0, win: 0 }, double: { played: 0, win: 0 }, first: '', bagels: 0, comebacks: 0, rival: null, seasons: [],
  };
  const draws = {}, bySeason = {}, opp = {};
  const seasonRow = (s) => bySeason[s] || (bySeason[s] = { season: s, played: 0, win: 0, titles: 0 });
  mine.forEach((m) => {
    const side = sideOf(m, key, name), o = side === 'a' ? 'b' : 'a', won = m.winner === side;
    const season = SE.seasonOf(m);
    if (m.drawId) draws[m.drawId] = 1;
    if (isFinal(m)) {
      c.finals++;
      if (won) { c.titles.push({ title: m.drawTitle || '赛事', date: m.date || '', season }); if (season) seasonRow(season).titles++; }
    }
    if (!isNormal(m)) return; // 弃权、中途退赛：不算场数、胜负和连胜
    c.played++;
    if (!c.first) c.first = m.date || '';
    const t = m.type === 'double' ? c.double : c.single;
    t.played++;
    if (season) seasonRow(season).played++;
    if (won) {
      c.win++; t.win++; c.streak++;
      if (c.streak > c.bestStreak) c.bestStreak = c.streak;
      if (season) seasonRow(season).win++;
    } else c.streak = 0;
    const sets = m.sets || [];
    if (sets.some((s) => s[side] > s[o] && s[o] === 0 && s[side] >= 4)) c.bagels++;
    if (won && sets.length > 1 && sets[0][side] < sets[0][o]) c.comebacks++;
    (m[o] || []).forEach((n, i) => {
      const k = (m[o + 'Keys'] || [])[i] || n;
      const r = opp[k] || (opp[k] = { key: k, name: n, played: 0, win: 0 });
      r.name = n; r.played++; if (won) r.win++;
    });
  });
  c.lose = c.played - c.win;
  c.rate = pct(c.win, c.played);
  c.events = Object.keys(draws).length;
  (history || []).forEach((h) => { if (typeof h.level === 'number' && (c.peak === null || h.level > c.peak)) c.peak = h.level; });
  // 交手最多的对手（至少 2 场）
  const rivals = Object.keys(opp).map((k) => opp[k]).sort((x, y) => y.played - x.played || y.win - x.win);
  if (rivals.length && rivals[0].played >= 2) c.rival = { name: rivals[0].name, played: rivals[0].played, win: rivals[0].win, lose: rivals[0].played - rivals[0].win };
  c.titles.reverse(); // 最近的冠军在前
  c.seasons = Object.keys(bySeason).sort().reverse().map((s) => {
    const r = bySeason[s];
    return Object.assign(r, { lose: r.played - r.win, rate: pct(r.win, r.played) });
  });
  c.badges = BADGES.map((b) => {
    const v = b.v(c);
    return { id: b.id, icon: b.icon, name: b.name, desc: b.desc, got: v >= b.need, progress: v >= b.need ? '' : `${v}/${b.need}` };
  });
  c.got = c.badges.filter((b) => b.got).length;
  return c;
}

module.exports = { career, sideOf, isFinal, BADGES };
