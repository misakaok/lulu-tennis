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

// 不计入水平分的场次：弃权、中途退赛（computeRatings 只算 outcome 为 normal 的）、成绩取消（退赛后这些记录已作废，不在正式战绩里）、
// 轮空（没有对手、没有比赛记录，直接进入下一轮）。场数、胜率也一样只算正常完赛的（rules.isNormal）。比赛详情、活动录分页、对阵表共用这几句
const UNRATED = {
  walkover: '弃权：没有实际打完的比分，不计入水平分、场数和胜率',
  retired: '中途退赛：比赛没有打完，已打的局分保留，但不计入水平分、场数和胜率',
  void: '成绩已取消：不计入水平分、场数和胜率',
  bye: '轮空：这一轮没有对手，直接进入下一轮，不计入水平分、场数和胜率',
};
const unratedOf = (kind) => (UNRATED[kind] ? { title: '本场未计入水平分', text: UNRATED[kind] } : null);

// 同一份比赛 + 球员数组只算一次水平分：排行榜、球员主页、活动报名名单都传共享数据（db.matchesShared / playersShared，
// 只读、没变时是同一个数组），切页面不再各算一遍。按数组引用认（WeakMap，临时数组用完就回收），
// 再核对长度防止有人往同一个数组里加了记录。结果是共享的：调用方只能读，不能改（tests/client.test.js 检查）
const ratingsMemo = new WeakMap();
function ratingsOf(matches, players) {
  matches = matches || []; players = players || [];
  const c = ratingsMemo.get(matches);
  if (c && c.p === players && c.mn === matches.length && c.pn === players.length) return c.r;
  const r = computeRatings(matches, startLevelsFrom(players));
  ratingsMemo.set(matches, { p: players, mn: matches.length, pn: players.length, r });
  return r;
}

/* ---------- 赛前交手预览 & 「如果打成 X:Y」水平分模拟（纯计算，不改正式算法，不暴露两位小数或涨跌数字） ---------- */
function curStateOf(ratings, startLevels, key, name) {
  const r = ratings && ratings.players && key ? ratings.players[key] : null;
  if (r) return { rating: typeof r.rating === 'number' ? r.rating : r.level, played: r.played || 0 };
  if (key && typeof startLevels[key] === 'number') return { rating: startLevels[key], played: 0 };
  if (name && (!key || key === name || key.indexOf('n:') === 0) && typeof startLevels[name] === 'number') {
    return { rating: startLevels[name], played: 0 };
  }
  return { rating: DEFAULT_LEVEL, played: 0 };
}

function teamKeysOf(m, side) {
  const ks = m[side + 'Keys'];
  return (ks && ks.length ? ks : (m[side] || [])).slice().sort().join('\x00');
}

function scorePresets(setGames) {
  return setGames === 4
    ? [[4, 0], [4, 1], [4, 2], [4, 3], [3, 4], [2, 4], [1, 4], [0, 4]]
    : [[6, 0], [6, 2], [6, 4], [7, 6], [6, 7], [4, 6], [2, 6], [0, 6]];
}

/**
 * 模拟一场假设比分对某一方水平分的影响（严格复用 computeRatings 的公式、防炸鱼和定级期规则）。
 * 界面只展示 fmt 的 0.5 档位和 ↑ / ↓ 箭头，不暴露两位小数或涨跌数字。
 */
function simulateMatch(ratings, players, opts) {
  if (!opts) return null;
  const aKeys = (opts.aKeys || []).filter(Boolean);
  const bKeys = (opts.bKeys || []).filter(Boolean);
  if (!aKeys.length || !bKeys.length) return null;
  const ga = Math.max(0, Number(opts.gamesA) || 0);
  const gb = Math.max(0, Number(opts.gamesB) || 0);
  const total = ga + gb;
  if (!total) return null;

  const start = startLevelsFrom(players);
  const aNames = opts.aNames || [], bNames = opts.bNames || [];
  const A = aKeys.map((k, i) => curStateOf(ratings, start, k, aNames[i]));
  const B = bKeys.map((k, i) => curStateOf(ratings, start, k, bNames[i]));
  const ra = avg(A.map((x) => x.rating)), rb = avg(B.map((x) => x.rating));

  const side = opts.mySide === 'b' ? 'b' : opts.mySide === 'a' ? 'a'
    : (opts.myKey && bKeys.indexOf(opts.myKey) >= 0 ? 'b' : 'a');
  const idx = side === 'a' ? aKeys.indexOf(opts.myKey) : bKeys.indexOf(opts.myKey);
  const me = side === 'a' ? (A[idx >= 0 ? idx : 0]) : (B[idx >= 0 ? idx : 0]);
  const mine = side === 'a' ? ra : rb;
  const opp = side === 'a' ? rb : ra;
  const gMine = side === 'a' ? ga : gb;
  const won = opts.winner ? opts.winner === side : gMine > total - gMine;

  const S = gMine / total;
  const E = expectedShare(mine, opp);
  const weight = Math.min(1, total / 10);
  const prov = me.played < PROVISIONAL;
  const K = prov ? K_NEW : K_EST;
  const raw = K * (S - E) * weight;
  let delta = raw;
  if (won && mine - opp > NO_FARM_GAP) delta = Math.min(delta, 0);
  const before = me.rating;
  const after = clamp(before + delta);
  const farm = delta !== raw;
  const clamped = after !== before + delta;
  const d = clamped ? round2(after - before) : round2(delta);
  const dir = d > 0 ? 'up' : d < 0 ? 'down' : 'flat';
  const t0 = fmt(before), t1 = fmt(after);
  const tierUp = Number(t1) > Number(t0);
  const tierDown = Number(t1) < Number(t0);
  const digits = Math.round(S * 100) === Math.round(E * 100) && S !== E ? 1 : 0;

  let summary;
  if (clamped && dir === 'flat') summary = `已到${raw > 0 ? '上限 ' + MAX_LEVEL.toFixed(1) : '下限 ' + MIN_LEVEL.toFixed(1)}，水平分不再变化`;
  else if (dir === 'up') summary = won ? '得局率高于赛前预期，水平分上升' : '虽败犹荣：得局率高于赛前预期，水平分仍会上升';
  else if (dir === 'down') summary = won ? '赢了但拿到的局数低于赛前预期，水平分下降' : '得局率低于赛前预期，水平分下降';
  else if (farm) summary = `赛前高出对方 ${NO_FARM_GAP} 以上赢球不加分，水平分不变`;
  else summary = '得局率接近赛前预期，水平分基本不变';

  const tierText = t0 !== t1
    ? `${tierUp ? '升档' : '降档'} ${t0} → ${t1}`
    : dir === 'flat' ? `显示档位仍为 ${t0}` : `水平分微调，显示档位仍为 ${t0}`;

  return {
    side, dir, arrow: fmtDelta(d),
    title: dir === 'up' ? '水平分上升' : dir === 'down' ? '水平分下降' : '水平分不变',
    summary, beforeTier: t0, afterTier: t1, tierUp, tierDown, tierText,
    shareText: `${gMine}/${total} 局 · ${pctOf(S, digits)}`,
    expectedText: pctOf(E, digits),
    mineLv: fmt(mine), oppLv: fmt(opp),
    prov, provText: prov ? `定级中 ${me.played + 1}/${PROVISIONAL}` : '',
    shortNote: weight < 1 ? `不足 10 局，变化幅度按 ${total}/10 折算` : '',
  };
}

/**
 * 赛前交手预览：双方水平档位、预期得局比例、局势参考、历史交手与近 5 场状态（单打）。
 */
function matchupPreview(ratings, players, matches, opts) {
  if (!opts) return null;
  const aKeys = (opts.aKeys || []).filter(Boolean);
  const bKeys = (opts.bKeys || []).filter(Boolean);
  if (!aKeys.length || !bKeys.length) return null;
  const aNames = opts.aNames || [], bNames = opts.bNames || [];
  const start = startLevelsFrom(players);
  const A = aKeys.map((k, i) => curStateOf(ratings, start, k, aNames[i]));
  const B = bKeys.map((k, i) => curStateOf(ratings, start, k, bNames[i]));
  const ra = avg(A.map((x) => x.rating)), rb = avg(B.map((x) => x.rating));
  const E = expectedShare(ra, rb);
  const aSharePct = Math.round(E * 100), bSharePct = 100 - aSharePct;
  const gap = Math.abs(ra - rb);
  const sg = opts.setGames === 4 ? 4 : 6;
  const aLabel = aNames.join(' / ') || 'A 方';
  const bLabel = bNames.join(' / ') || 'B 方';
  const fav = ra >= rb ? aLabel : bLabel;

  let outlook;
  if (gap < 0.15) outlook = '双方水平接近，预计会打得比较胶着';
  else if (gap < 0.45) outlook = `${fav} 略占上风，预计在 ${sg === 4 ? '4:2' : '6:4'} 左右`;
  else if (gap < 0.85) outlook = `${fav} 纸面占优，预计在 ${sg === 4 ? '4:1 ~ 4:2' : '6:2 ~ 6:3'} 左右`;
  else outlook = `${fav} 纸面优势较大，下风方多拿几局也能涨分`;

  const normal = (matches || []).filter((m) => (!m.outcome && !m.walkover) || m.outcome === 'normal');
  const akSig = aKeys.slice().sort().join('\x00');
  const bkSig = bKeys.slice().sort().join('\x00');
  let aWin = 0, bWin = 0;
  normal.forEach((m) => {
    const mkA = teamKeysOf(m, 'a'), mkB = teamKeysOf(m, 'b');
    if (mkA === akSig && mkB === bkSig) { if (m.winner === 'a') aWin++; else if (m.winner === 'b') bWin++; }
    else if (mkA === bkSig && mkB === akSig) { if (m.winner === 'b') aWin++; else if (m.winner === 'a') bWin++; }
  });
  const h2hPlayed = aWin + bWin;

  const formOf = (key) => {
    const out = [];
    const sorted = normal.slice().sort((x, y) => String(x.date || '').localeCompare(String(y.date || '')) || timeOf(x) - timeOf(y));
    sorted.forEach((m) => {
      const ksA = m.aKeys || m.a || [], ksB = m.bKeys || m.b || [];
      if (ksA.indexOf(key) >= 0) out.push(m.winner === 'a' ? 'w' : 'l');
      else if (ksB.indexOf(key) >= 0) out.push(m.winner === 'b' ? 'w' : 'l');
    });
    return out.slice(-5);
  };
  const single = aKeys.length === 1 && bKeys.length === 1;
  return {
    aLv: fmt(ra), bLv: fmt(rb),
    aSharePct, bSharePct, outlook, double: !single,
    h2h: { played: h2hPlayed, aWin, bWin, text: h2hPlayed ? `历史交手 ${h2hPlayed} 场 · ${aWin} - ${bWin}` : '此前还没有正式交手记录' },
    formA: single ? formOf(aKeys[0]) : [],
    formB: single ? formOf(bKeys[0]) : [],
    presets: scorePresets(sg).map(([a, b]) => ({ a, b, label: `${a}:${b}` })),
  };
}

module.exports = {
  DEFAULT_LEVEL, PROVISIONAL, NO_FARM_GAP, SELF_LEVELS,
  expectedShare, computeRatings, ratingsOf, startLevelsFrom, ratingOf, levelOf, tierOf, fmt, fmtDelta, whyOf, unratedOf,
  simulateMatch, matchupPreview, scorePresets,
};
