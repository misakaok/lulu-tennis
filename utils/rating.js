// 水平分（类似 NTRP，保留两位小数，如 2.55 / 2.95 / 3.14）
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
 * matches: 全部比赛；startLevels: { 名字: 自评水平 }
 * 返回 { players: { 名字: { level, played, provisional, history } }, deltas: { 比赛id: { 名字: 变化 } } }
 */
function computeRatings(matches, startLevels) {
  startLevels = startLevels || {};
  const P = {}, deltas = {};
  const get = (n) => P[n] || (P[n] = { name: n, rating: startLevels[n] || DEFAULT_LEVEL, played: 0, history: [] });

  // 弃权、中途退赛不计入水平分
  const list = matches.filter((m) => !m.outcome && !m.walkover || m.outcome === 'normal').sort((a, b) =>
    (a.date || '') < (b.date || '') ? -1 : (a.date || '') > (b.date || '') ? 1 : timeOf(a) - timeOf(b));

  list.forEach((m) => {
    const A = (m.a || []).map(get), B = (m.b || []).map(get);
    if (!A.length || !B.length) return;
    let ga = 0, gb = 0;
    (m.sets || []).forEach((s) => { ga += s.a || 0; gb += s.b || 0; });
    const total = ga + gb;
    if (!total) return;

    const ra = avg(A.map((p) => p.rating)), rb = avg(B.map((p) => p.rating));
    const S = ga / total, E = expectedShare(ra, rb);
    const weight = Math.min(1, total / 10); // 局数太少的比赛影响小一些
    const d = {};
    const update = (team, s, e, mine, opp, won) => team.forEach((p) => {
      const K = p.played < PROVISIONAL ? K_NEW : K_EST;
      let delta = K * (s - e) * weight;
      if (won && mine - opp > NO_FARM_GAP) delta = Math.min(delta, 0); // 防炸鱼
      p.rating = clamp(p.rating + delta);
      p.played++;
      d[p.name] = round2(delta);
      p.history.push({ id: m._id, date: m.date, level: round2(p.rating), delta: round2(delta) });
    });
    update(A, S, E, ra, rb, m.winner === 'a');
    update(B, 1 - S, 1 - E, rb, ra, m.winner === 'b');
    if (m._id) deltas[m._id] = d;
  });

  Object.keys(P).forEach((k) => {
    const p = P[k];
    p.level = round2(p.rating);
    p.provisional = p.played < PROVISIONAL;
  });
  return { players: P, deltas };
}

// 从球员资料里取自评水平
function startLevelsFrom(players) {
  const out = {};
  (players || []).forEach((p) => { if (p && p.name && typeof p.level === 'number') out[p.name] = p.level; });
  return out;
}

function levelOf(ratings, name, players) {
  const r = ratings.players[name];
  if (r) return r.level;
  const p = (players || []).find((x) => x.name === name);
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

const fmt = (x) => x.toFixed(2);
const fmtDelta = (d) => (d > 0 ? '+' : d < 0 ? '−' : '±') + Math.abs(d).toFixed(2);

module.exports = {
  DEFAULT_LEVEL, PROVISIONAL, NO_FARM_GAP, CHALLENGE_DOWN, SELF_LEVELS,
  expectedShare, winChance, computeRatings, startLevelsFrom, levelOf, tierOf, canChallenge, fmt, fmtDelta,
};
