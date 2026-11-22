// 生涯成就：全部由正式战绩（db.fetchMatches）实时计算，不单独存数据，也不能手动修改。
//   场数、胜负、胜率只算正常完赛的比赛（isNormal），和排行榜、球员主页同一个口径；
//   冠军 / 亚军看活动决赛的比赛记录（弃权胜也算夺冠）；活动删除后比分还在，冠军也还在。
const { isNormal } = require('./rules');
const { tsOf } = require('./event');
const SE = require('./season');
const H = require('./highlight');

// 这位球员在这场的哪一方：按统计身份找；旧缓存里的记录没有统计身份时按名字
function sideOf(m, key, name) {
  for (const s of ['a', 'b']) {
    const ks = m[s + 'Keys'];
    if (ks ? ks.indexOf(key) >= 0 : (m[s] || []).indexOf(name) >= 0) return s;
  }
  return '';
}
const isFinal = (m) => !!m.drawId && /(^|· )(决赛|最后一轮)$/.test(m.stage || ''); // 旧记录存的是「决赛」，现在叫「最后一轮」
const pct = (win, played) => (played ? Math.round((win / played) * 100) : 0);

const REVENGE_AFTER = 3; // 复仇：对同一位对手连输几场后赢回来
const RELATION_MIN = 2;  // 苦主 / 福星：至少输 / 赢过这么多场
// 比赛日期在第几周（周一到周日算一周），用来数「连续几周有比赛」；日期不对返回 null
const weekOf = (date) => { const t = Date.parse(String(date || '') + 'T00:00:00Z'); return isNaN(t) ? null : Math.floor((t / 86400000 + 3) / 7); };

// 成就徽章：need 是达成条件，v 取当前进度
const BADGES = [
  { id: 'debut', name: '初登场', desc: '完成第一场正式比赛', need: 1, v: (c) => c.played },
  { id: 'win1', name: '首胜', desc: '赢下第一场比赛', need: 1, v: (c) => c.win },
  { id: 'p10', name: '常客', desc: '打满 10 场', need: 10, v: (c) => c.played },
  { id: 'p50', name: '老将', desc: '打满 50 场', need: 50, v: (c) => c.played },
  { id: 'p100', name: '百场', desc: '打满 100 场', need: 100, v: (c) => c.played },
  { id: 's3', name: '三连胜', desc: '连赢 3 场', need: 3, v: (c) => c.bestStreak },
  { id: 's5', name: '五连胜', desc: '连赢 5 场', need: 5, v: (c) => c.bestStreak },
  { id: 's10', name: '十连胜', desc: '连赢 10 场', need: 10, v: (c) => c.bestStreak },
  { id: 'final', name: '闯到最后', desc: '打进一次活动的最后一轮', need: 1, v: (c) => c.finals },
  { id: 'champ', name: '冠军', desc: '在一次活动中夺冠', need: 1, v: (c) => c.titles.length },
  { id: 'champ3', name: '三冠王', desc: '在 3 次活动中夺冠', need: 3, v: (c) => c.titles.length },
  { id: 'ev5', name: '活动达人', desc: '参加 5 次活动', need: 5, v: (c) => c.events },
  { id: 'bagel', name: '送蛋', desc: '一盘没让对手拿到一局', need: 1, v: (c) => c.bagels },
  { id: 'comeback', name: '逆转', desc: '先丢一盘后赢下比赛', need: 1, v: (c) => c.comebacks },
  { id: 'both', name: '单双全能', desc: '单打和双打都赢过', need: 2, v: (c) => (c.single.win ? 1 : 0) + (c.double.win ? 1 : 0) },
  { id: 'tb5', name: '抢七之王', desc: '赢下 5 次抢七', need: 5, v: (c) => c.tbWins },
  { id: 'iron', name: '铁人', desc: '一天打 3 场', need: 3, v: (c) => c.bestDay },
  { id: 'giant', name: '巨人杀手', desc: `定级后，赢下等级比自己高 ${H.UPSET_GAP} 以上的对手`, need: 1, v: (c) => c.upsets },
  { id: 'weeks4', name: '全勤', desc: '连续 4 周都有比赛', need: 4, v: (c) => c.bestWeeks },
  { id: 'social', name: '社交达人', desc: '和 10 位不同的搭档打过双打', need: 10, v: (c) => c.partners },
  { id: 'revenge', name: '复仇', desc: `对同一位对手连输 ${REVENGE_AFTER} 场后赢回来`, need: 1, v: (c) => c.revenges },
];

/**
 * matches: 正式战绩（带 aKeys / bKeys）；key: 统计身份（用户 ID）；name: 当前昵称；
 * history: 这位球员的水平分变化（ratings.players[key].history），用来取最高水平
 * pre: 每场赛前双方的等级（ratings.pre），用来认「巨人杀手」；不传就不算
 */
function career(matches, key, name, history, pre) {
  const mine = (matches || []).filter((m) => sideOf(m, key, name))
    .sort((x, y) => String(x.date || '').localeCompare(String(y.date || '')) || tsOf(x) - tsOf(y));
  const c = {
    played: 0, win: 0, lose: 0, rate: 0, titles: [], finals: 0, events: 0, streak: 0, bestStreak: 0,
    peak: null, single: { played: 0, win: 0 }, double: { played: 0, win: 0 }, first: '', bagels: 0, comebacks: 0, rival: null, seasons: [],
    tbWins: 0, bestDay: 0, upsets: 0, bestWeeks: 0, partners: 0, revenges: 0, nemesis: null, prey: null,
  };
  const draws = {}, bySeason = {}, opp = {}, days = {}, weeks = {}, mates = {};
  const seasonRow = (s) => bySeason[s] || (bySeason[s] = { season: s, played: 0, win: 0, titles: 0 });
  mine.forEach((m) => {
    const side = sideOf(m, key, name), o = side === 'a' ? 'b' : 'a', won = m.winner === side;
    const season = SE.seasonOf(m);
    if (m.drawId) draws[m.drawId] = 1;
    if (isFinal(m)) {
      c.finals++;
      if (won) { c.titles.push({ title: m.drawTitle || '活动', date: m.date || '', season }); if (season) seasonRow(season).titles++; }
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
    if (H.bagelBy(m, side)) c.bagels++;
    if (H.comebackBy(m, side)) c.comebacks++;
    if (H.upsetBy(m, side, pre)) c.upsets++;
    c.tbWins += H.tbWins(m, side);
    if (m.date) { days[m.date] = (days[m.date] || 0) + 1; if (days[m.date] > c.bestDay) c.bestDay = days[m.date]; }
    const wk = weekOf(m.date);
    if (wk !== null) weeks[wk] = 1;
    const myKeys = m[side + 'Keys'];
    (m[side] || []).forEach((n, i) => { if (myKeys ? myKeys[i] !== key : n !== name) mates[(myKeys && myKeys[i]) || n] = 1; });
    let revenge = false;
    (m[o] || []).forEach((n, i) => {
      const k = (m[o + 'Keys'] || [])[i] || n;
      const r = opp[k] || (opp[k] = { key: k, name: n, played: 0, win: 0, ls: 0 });
      r.name = n; r.played++;
      if (won) { r.win++; if (r.ls >= REVENGE_AFTER) revenge = true; r.ls = 0; } else r.ls++; // ls：对 TA 的连败
    });
    if (revenge) c.revenges++;
  });
  c.lose = c.played - c.win;
  c.rate = pct(c.win, c.played);
  c.events = Object.keys(draws).length;
  (history || []).forEach((h) => { if (typeof h.level === 'number' && (c.peak === null || h.level > c.peak)) c.peak = h.level; });
  // 交手最多的对手（至少 2 场）
  const rivals = Object.keys(opp).map((k) => opp[k]).sort((x, y) => y.played - x.played || y.win - x.win);
  if (rivals.length && rivals[0].played >= 2) c.rival = { name: rivals[0].name, played: rivals[0].played, win: rivals[0].win, lose: rivals[0].played - rivals[0].win };
  // 苦主：输给 TA 最多（负多于胜）；福星：赢 TA 最多（胜多于负）。都至少 RELATION_MIN 场
  const rel = (r) => ({ key: r.key, name: r.name, played: r.played, win: r.win, lose: r.played - r.win });
  const all = rivals.map(rel);
  c.nemesis = all.filter((r) => r.lose >= RELATION_MIN && r.lose > r.win).sort((x, y) => y.lose - x.lose || x.win - y.win)[0] || null;
  c.prey = all.filter((r) => r.win >= RELATION_MIN && r.win > r.lose).sort((x, y) => y.win - x.win || x.lose - y.lose)[0] || null;
  c.partners = Object.keys(mates).length;
  let run = 0, prev = null;
  Object.keys(weeks).map(Number).sort((x, y) => x - y).forEach((w) => { run = prev !== null && w === prev + 1 ? run + 1 : 1; prev = w; if (run > c.bestWeeks) c.bestWeeks = run; });
  c.titles.reverse(); // 最近的冠军在前
  c.seasons = Object.keys(bySeason).sort().reverse().map((s) => {
    const r = bySeason[s];
    return Object.assign(r, { lose: r.played - r.win, rate: pct(r.win, r.played) });
  });
  c.badges = BADGES.map((b) => {
    const v = b.v(c);
    return { id: b.id, name: b.name, desc: b.desc, got: v >= b.need, progress: v >= b.need ? '' : `${v}/${b.need}` };
  });
  c.got = c.badges.filter((b) => b.got).length;
  return c;
}

module.exports = { career, sideOf, isFinal, BADGES };
