// 比赛亮点标签：爆冷、逆转、抢七、送蛋、终结连胜。
//   全部由正式战绩和水平分实时算出，不存数据库，只看正常完赛的比赛（isNormal），不是第二套统计。
//   生涯徽章（utils/career.js）用的是这里同一组判断，标签和徽章不会对不上。
const { isNormal } = require('./rules');
const { tsOf } = require('./event');

const UPSET_GAP = 0.3;   // 爆冷：赛前比赛等级比对手低 0.3 以上还赢了（有人还在定级期的比赛不算，等级还不准）
const STOP_MIN = 3;      // 终结连胜：对手赛前至少 3 连胜

const other = (side) => (side === 'a' ? 'b' : 'a');
const hasTb = (s) => s.tbA !== undefined && s.tbB !== undefined;

// side 这一方赢下的抢七盘数
const tbWins = (m, side) => (m.sets || []).filter((s) => hasTb(s) && s[side] > s[other(side)]).length;
// side 这一方有没有送蛋（一盘没让对手拿到一局）
const bagelBy = (m, side) => (m.sets || []).some((s) => s[side] > s[other(side)] && s[other(side)] === 0 && s[side] >= 4);
// side 这一方是不是逆转获胜（先丢一盘后赢下比赛）
const comebackBy = (m, side) => {
  const sets = m.sets || [];
  return m.winner === side && sets.length > 1 && sets[0][side] < sets[0][other(side)];
};
// side 这一方是不是爆冷获胜。pre: 水平分算法带出的赛前等级 { 比赛 id: { a, b, prov } }（computeRatings().pre）
const upsetBy = (m, side, pre) => {
  const p = pre && pre[m._id];
  return !!p && !p.prov && m.winner === side && p[other(side)] - p[side] >= UPSET_GAP - 1e-9;
};

// 和生涯成就同一个先后顺序：比赛日期，再按录入时间
const byTime = (x, y) => String(x.date || '').localeCompare(String(y.date || '')) || tsOf(x) - tsOf(y);

/**
 * matches: 正式战绩（带 aKeys / bKeys）；ratings: computeRatings 的结果（取 pre）
 * 返回 { 比赛 id: [{ k, t, cls }] }，没有亮点的比赛不在里面。cls 是 .ui-tag 的修饰类
 */
function matchTags(matches, ratings) {
  const pre = (ratings && ratings.pre) || {};
  const streak = {}, out = {};
  (matches || []).filter(isNormal).sort(byTime).forEach((m) => {
    const w = m.winner, l = other(w);
    if (w !== 'a' && w !== 'b') return;
    const keys = (side) => (m[side] || []).map((n, i) => (m[side + 'Keys'] || [])[i] || n);
    const tags = [];
    if (upsetBy(m, w, pre)) tags.push({ k: 'upset', t: '爆冷', cls: 'solid' });
    if (comebackBy(m, w)) tags.push({ k: 'comeback', t: '逆转', cls: '' });
    const ended = Math.max.apply(null, [0].concat(keys(l).map((k) => streak[k] || 0)));
    if (ended >= STOP_MIN) tags.push({ k: 'stop', t: `终结 ${ended} 连胜`, cls: '' });
    if ((m.sets || []).some(hasTb)) tags.push({ k: 'tb', t: '抢七', cls: '' });
    if (bagelBy(m, w)) tags.push({ k: 'bagel', t: '送蛋', cls: '' });
    keys(w).forEach((k) => { streak[k] = (streak[k] || 0) + 1; });
    keys(l).forEach((k) => { streak[k] = 0; });
    if (tags.length && m._id) out[m._id] = tags;
  });
  return out;
}

module.exports = { matchTags, tbWins, bagelBy, comebackBy, upsetBy, byTime, UPSET_GAP, STOP_MIN };
