// 水平分（类似 NTRP）：内部按两位小数精确计算（如 2.55 / 2.95 / 3.14），界面上按 0.5 一档显示（2.5 / 3.0 / 3.5，见 fmt）
//
// 算法（参考 UTR 的「按局数」思路）：
//   1. 每人有一个起始水平：自评水平，没有自评的默认 2.50
//   2. 每场比赛按时间顺序计算：
//        预期得局率 E = 1 / (1 + 10^(-(我方水平 - 对方水平) / 1.4))
//        实际得局率 S = 我方赢的局数 / 总局数
//        变化 = K × (S − E) × 场次权重
//      所以输了但比预期打得好也会涨，赢了但比预期差也会降
//   3. 前 5 场是「定级中」，K 更大，水平变化更快
//   4. 防炸鱼：高出对手 0.5 以上时，赢球不加分（最多为 0）
//   5. 双打：两人平均分作为队伍水平，两人变化相同
//   6. 挑战：只能向不低于自己 0.3 以上的人发起挑战

const ID = require('./ident');

const DEFAULT_LEVEL = 2.5;
const MIN_LEVEL = 1.0;
const MAX_LEVEL = 7.0;
const SCALE = 1.4;            // 水平差 0.5 → 预期得局率约 70%
const K_NEW = 1.2;            // 定级期
const K_EST = 0.6;            // 定级后
const PROVISIONAL = 5;        // 前 5 场为定级期
const NO_FARM_GAP = 0.5;      // 防炸鱼：高出 0.5 以上赢球不加分
const CHALLENGE_DOWN = 0.3;   // 不能挑战比自己低 0.3 以上的人

const SELF_LEVELS = [
  { v: 1.5, t: '1.5 刚开始学，还不太能回球' },
  { v: 2.0, t: '2.0 能简单对拉几拍' },
  { v: 2.5, t: '2.5 能稳定对拉，会发球' },
  { v: 3.0, t: '3.0 中速球稳定，有方向控制' },
  { v: 3.5, t: '3.5 能控制深度和旋转，会上网' },
  { v: 4.0, t: '4.0 有得分武器，比赛经验丰富' },
  { v: 4.5, t: '4.5 力量和变化都好，常打比赛' },
];

const round2 = (x) => Math.round(x * 100) / 100;
const clamp = (x) => Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, x));
const avg = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;

function expectedShare(ra, rb) { return 1 / (1 + Math.pow(10, -(ra - rb) / SCALE)); }
// 赢下整场的概率（只用于显示）
function winChance(ra, rb) { return 1 / (1 + Math.pow(10, -(ra - rb) / 0.8)); }

function timeOf(m) {
  const t = m.createdAt ? new Date(m.createdAt).getTime() : 0;
  return isNaN(t) ? 0 : t;
}

/**
 * matches: 全部比赛（带 aKeys / bKeys 统计身份，见 utils/ident.js；没有时按名字）
 * startLevels: { 统计身份或名字: 自评水平 }（startLevelsFrom）
 * 返回 { players: { 统计身份: { key, name, level, played, provisional, history } }, deltas: { 比赛id: { 统计身份: 变化 } },
 *        pre: { 比赛id: { a, b, prov } } 赛前双方的等级（双打是两人平均）、是否有人还在定级期，亮点标签「爆冷」用，
 *        explain: { 比赛id: { 统计身份: 这一场实际参与计算的数据 } }（比赛详情「这场为什么涨分 / 掉分」用，见 whyOf）}
 * explain 只是把下面计算时用到的值原样记下来，不参与计算，不改变 players / deltas / pre 的结果
 */
function computeRatings(matches, startLevels) {
  startLevels = startLevels || {};
  const P = {}, deltas = {}, pre = {}, explain = {};
  const startOf = (k, n) => {
    if (typeof startLevels[k] === 'number') return startLevels[k];
    // 账号（用户 ID）没有自评就用默认值，不按名字去借别人的；只有按名字统计的才按名字找
    if (k === n || k.indexOf('n:') === 0) return typeof startLevels[n] === 'number' ? startLevels[n] : DEFAULT_LEVEL;
    return DEFAULT_LEVEL;
  };
  const get = (k, n) => P[k] || (P[k] = { key: k, name: n, rating: startOf(k, n), played: 0, history: [] });
  const team = (m, side) => { const ks = m[side + 'Keys'] || []; return (m[side] || []).map((n, i) => get(ks[i] || n, n)); };

  // 弃权、中途退赛不计入水平分
  const list = matches.filter((m) => !m.outcome && !m.walkover || m.outcome === 'normal').sort((a, b) =>
    (a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : timeOf(a) - timeOf(b));

  list.forEach((m) => {
    const A = team(m, 'a'), B = team(m, 'b');
    if (!A.length || !B.length) return;
    let ga = 0, gb = 0;
    (m.sets || []).forEach((s) => { ga += s.a || 0; gb += s.b || 0; });
    const total = ga + gb;
    if (!total) return;

    const ra = avg(A.map((p) => p.rating)), rb = avg(B.map((p) => p.rating));
    if (m._id) pre[m._id] = { a: round2(ra), b: round2(rb), prov: A.concat(B).some((p) => p.played < PROVISIONAL) };
    const S = ga / total, E = expectedShare(ra, rb);
    const weight = Math.min(1, total / 10); // 局数太少的比赛影响小一些
    const d = {}, x = {};
    const update = (team, side, s, e, mine, opp, won, gMine, gOpp) => team.forEach((p) => {
      const prov = p.played < PROVISIONAL;
      const K = prov ? K_NEW : K_EST;
      const raw = K * (s - e) * weight;
      let delta = raw;
      if (won && mine - opp > NO_FARM_GAP) delta = Math.min(delta, 0); // 防炸鱼
      const before = p.rating;
      p.rating = clamp(p.rating + delta);
      x[p.key] = {
        side, before, after: p.rating, raw, delta, K, weight, prov, playedBefore: p.played, size: team.length,
        mine, opp, share: s, expected: e, games: gMine, oppGames: gOpp, won,
        farm: delta !== raw, clamped: p.rating !== before + delta,
      };
      p.played++;
      d[p.key] = round2(delta);
      p.history.push({ id: m._id, date: m.date, level: round2(p.rating), delta: round2(delta) });
    });
    update(A, 'a', S, E, ra, rb, m.winner === 'a', ga, gb);
    update(B, 'b', 1 - S, 1 - E, rb, ra, m.winner === 'b', gb, ga);
    if (m._id) { deltas[m._id] = d; explain[m._id] = x; }
  });

  Object.keys(P).forEach((k) => {
    const p = P[k];
    p.level = round2(p.rating);
    p.provisional = p.played < PROVISIONAL;
  });
  return { players: P, deltas, pre, explain };
}

// 从球员资料里取自评水平：有账号的按用户 ID，只有名字的球员按名字（同名的账号不按名字给）
function startLevelsFrom(players) {
  const out = {};
  (players || []).forEach((p) => {
    if (!p || !p.name || typeof p.level !== 'number') return;
    if (p.uid) out[p.uid] = p.level;
    else if (!p.ambiguous) out[p.name] = p.level;
  });
  return out;
}

// 按名字（或用户 ID）找某人的比赛等级记录：先换成统计身份
function ratingOf(ratings, name, players, uid) {
  const k = ID.keyOf(players || [], name, uid);
  return ratings.players[k] || null;
}
function levelOf(ratings, name, players, uid) {
  const r = ratingOf(ratings, name, players, uid);
  if (r) return r.level;
  const p = (players || []).find((x) => (uid ? x.uid === uid : x.name === name));
  return p && typeof p.level === 'number' ? p.level : DEFAULT_LEVEL;
}

function tierOf(level) {
  if (level < 2.0) return '入门';
  if (level < 2.5) return '初级';
  if (level < 3.0) return '初中级';
  if (level < 3.5) return '中级';
  if (level < 4.0) return '中高级';
  if (level < 4.5) return '高级';
  return '精英';
}

// 能不能发起挑战：对方不能比自己低 0.3 以上
function canChallenge(myLevel, targetLevel) {
  return targetLevel >= round2(myLevel - CHALLENGE_DOWN);
}

// 显示：等级四舍五入到 0.5 一档（3.03 → 3.0、3.27 → 3.5，2026-11-18 用户要求）；排序、比较、计算一律用精确值。
// 涨跌只显示方向箭头，不显示数字（一场通常只动零点零几，和 0.5 一档的等级对不上）；没变化显示空
const fmt = (x) => (Math.round(x * 2) / 2).toFixed(1);
const fmtDelta = (d) => (d > 0 ? '↑' : d < 0 ? '↓' : '');

/**
 * 「这场为什么涨分 / 掉分」：只用 computeRatings 记下的这一场实际计算数据（explain），不按今天的等级倒推。
 * 方向和战绩列表的 ↑ / ↓ 一致（同一个 deltas 值）；只有计算结果支持的原因才写：
 *   涨 / 跌看实际得局率和赛前预期谁高；赢球没涨是因为「赛前高出对手 0.5 以上不加分」时（本来会涨）才说这条规则；
 *   到了上下限、局数少（不到 10 局按比例）、定级中、双打按两人平均，各自确有其事时才附上说明。
 * 等级只经 fmt 按 0.5 档显示，不显示变化的数字。没有这场的计算数据返回 null（由页面说明不计分的原因）
 */
const pctOf = (x, digits) => (Math.round(x * Math.pow(10, 2 + digits)) / Math.pow(10, digits)).toFixed(digits) + '%';
function whyOf(ratings, matchId, key) {
  const x = ratings && ratings.explain && ratings.explain[matchId] && ratings.explain[matchId][key];
  if (!x) return null;
  const d = x.clamped ? round2(x.after - x.before) : round2(x.delta);
  const dir = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  const dbl = x.size > 1;
  const you = dbl ? '你们' : '你';
  const result = x.won ? '这场赢了' : '这场输了';
  let reason;
  if (x.clamped && dir === 'flat') reason = `水平分已经到了${x.raw > 0 ? '上限 ' + MAX_LEVEL.toFixed(1) : '下限 ' + MIN_LEVEL.toFixed(1)}，这场没有再变化`;
  else if (dir === 'up') reason = x.won ? `${result}，${you}的得局率也高于赛前预期，水平分上升了` : `${result}，但${you}的得局率高于赛前预期，水平分上升了`;
  else if (dir === 'down') reason = x.won ? `${result}，但${you}拿到的局数低于赛前预期，水平分下降了` : `${result}，${you}的得局率低于赛前预期，水平分下降了`;
  else if (x.farm) reason = `${result}，按得局率本来会上升，但赛前${you}的水平比对方高 ${NO_FARM_GAP} 以上，按「高出对手 ${NO_FARM_GAP} 以上赢球不加分」的规则，水平分没有上升`;
  else reason = `${you}的得局率和赛前预期几乎一样，水平分基本没有变化`;
  const t0 = fmt(x.before), t1 = fmt(x.after);
  const tierText = t0 !== t1 ? `显示档位 ${t0} → ${t1}` : dir === 'flat' ? `显示档位仍为 ${t0}` : `本场水平分有变化，显示档位仍为 ${t0}`;
  const total = x.games + x.oppGames;
  const notes = [];
  if (x.clamped && dir !== 'flat') notes.push(`水平分到了${x.after >= MAX_LEVEL ? '上限 ' + MAX_LEVEL.toFixed(1) : '下限 ' + MIN_LEVEL.toFixed(1)}，变化在这里停住`);
  if (x.weight < 1) notes.push(`这场一共 ${total} 局（不到 10 局），变化幅度按 ${total}/10 计算`);
  if (dbl) notes.push('双打按两人平均水平作为队伍水平，同队两人这场的变化相同');
  // 两个得局率四舍五入成整数一样、实际不一样时多显示一位小数，让方向对得上
  const digits = Math.round(x.share * 100) === Math.round(x.expected * 100) && x.share !== x.expected ? 1 : 0;
  return {
    dir, arrow: fmtDelta(d), title: dir === 'up' ? '水平分上升' : dir === 'down' ? '水平分下降' : '水平分没有变化',
    reason, tierText, notes,
    prov: x.prov, provText: x.prov ? `定级中 ${x.playedBefore + 1}/${PROVISIONAL}` : '',
    provNote: x.prov ? `前 ${PROVISIONAL} 场是定级期，每场水平分变化更快` : '',
    double: dbl,
    shareText: `${x.games}/${total} 局 · ${pctOf(x.share, digits)}`,
    expectedText: pctOf(x.expected, digits),
    mineLv: fmt(x.mine), oppLv: fmt(x.opp),
  };
}

module.exports = {
  DEFAULT_LEVEL, PROVISIONAL, NO_FARM_GAP, CHALLENGE_DOWN, SELF_LEVELS,
  expectedShare, winChance, computeRatings, startLevelsFrom, ratingOf, levelOf, tierOf, canChallenge, fmt, fmtDelta, whyOf,
};
