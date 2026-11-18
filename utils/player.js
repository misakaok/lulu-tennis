// 球员主页的数据：「我的」和别人的主页共用（pages/me、pages/player、pages/history 都用这里）
//   人按用户 ID 找（profiles[uid]），比赛只用正式战绩（db.fetchMatches），
//   场数 / 胜负 / 胜率 / 排名 / 比赛等级都由比赛记录计算，和排行榜、报名名单同一套规则。
const R = require('./rating');
const S = require('./stats');
const { outcomeOf, isNormal, initialOf, colorOf } = require('./rules');
const CA = require('./career');
const SE = require('./season');
const H = require('./highlight');

const NONE = S.NONE;

// 这位球员在这场的哪一方：按统计身份（用户 ID）找；记录没有统计身份时（旧缓存）按名字
function sideOf(m, key, name) {
  for (const s of ['a', 'b']) {
    const ks = m[s + 'Keys'];
    if (ks ? ks.indexOf(key) >= 0 : (m[s] || []).indexOf(name) >= 0) return s;
  }
  return '';
}

// 一场比赛，从这位球员的角度看。tagsOf: 亮点标签（H.matchTags），不传就没有
function matchRow(m, key, name, deltaOf, tagsOf) {
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
    tags: (tagsOf && tagsOf[m._id]) || [],
  };
}

// 等级走势：最近 TREND_MAX 场比赛打完后的比赛等级，画成一排柱子（高度按这段时间的最低～最高等级换算）
const TREND_MAX = 30;
function trendView(history) {
  const h = (history || []).slice(-TREND_MAX);
  if (h.length < 2) return null;
  const lv = h.map((x) => x.level);
  const min = Math.min.apply(null, lv), max = Math.max.apply(null, lv), span = max - min;
  return {
    bars: h.map((x, i) => ({ i, h: span ? Math.round(18 + 82 * (x.level - min) / span) : 60, up: x.delta > 0, down: x.delta < 0 })),
    n: h.length, min: R.fmt(min), max: R.fmt(max),
    from: (h[0].date || '').slice(5), to: (h[h.length - 1].date || '').slice(5),
    first: R.fmt(lv[0]), last: R.fmt(lv[lv.length - 1]),
  };
}

// 交手记录：「我」和这位球员分在两边的正式比赛（单打、双打都算）。胜负只数正常完赛的，弃权 / 退赛单独列出不计数
const H2H_ROWS = 5;
function h2hView(matches, myKey, myName, key, name, tagsOf) {
  if (!myKey || !key || myKey === key) return null;
  const list = (matches || []).filter((m) => {
    const mine = sideOf(m, myKey, myName), theirs = sideOf(m, key, name);
    return mine && theirs && mine !== theirs;
  });
  const normal = list.filter(isNormal);
  const win = normal.filter((m) => m.winner === sideOf(m, myKey, myName)).length;
  const rows = list.slice()
    .sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')) || String(y._id).localeCompare(String(x._id)))
    .slice(0, H2H_ROWS).map((m) => matchRow(m, myKey, myName, {}, tagsOf));
  return { played: normal.length, win, lose: normal.length - win, total: list.length, rows };
}

// 双打搭档统计：和每位搭档一起打的正常完赛场数、胜负、胜率（按搭档的统计身份累计）。
// 「最佳搭档」= 一起打满 PARTNER_MIN 场的搭档里胜率最高的（一样就取场数多的）
const PARTNER_MIN = 3, PARTNER_ROWS = 5;
function partnersView(matches, key, name) {
  const map = {};
  (matches || []).filter(isNormal).forEach((m) => {
    const side = sideOf(m, key, name);
    if (!side) return;
    const ks = m[side + 'Keys'];
    (m[side] || []).forEach((n, i) => {
      if (ks ? ks[i] === key : n === name) return; // 自己
      const k = (ks && ks[i]) || n;
      const r = map[k] || (map[k] = { key: k, name: n, played: 0, win: 0 });
      r.name = n; r.played++;
      if (m.winner === side) r.win++;
    });
  });
  const all = Object.keys(map).map((k) => Object.assign(map[k], { lose: map[k].played - map[k].win, rate: Math.round((map[k].win / map[k].played) * 100) }))
    .sort((x, y) => y.played - x.played || y.win - x.win || String(x.name).localeCompare(String(y.name)));
  if (!all.length) return null;
  const best = all.filter((p) => p.played >= PARTNER_MIN).sort((x, y) => y.rate - x.rate || y.played - x.played)[0] || null;
  return { list: all.slice(0, PARTNER_ROWS), total: all.length, best, min: PARTNER_MIN };
}

// 赛季总结（pages/summary）：某个赛季（自然年，或 'all' = 生涯）的一页汇总。
// 场数、胜负、连胜、冠军都直接用 career()，只是先按赛季筛选比赛，和排行榜、球员主页同一个口径
function seasonSummary(matches, key, name, season, history) {
  const ms = SE.inSeason(matches || [], season);
  const hs = (history || []).filter((h) => !season || season === SE.ALL || String(h.date || '').slice(0, 4) === season);
  const c = CA.career(ms, key, name, hs);
  const months = [];
  for (let i = 1; i <= 12; i++) months.push({ m: i, n: 0 });
  ms.filter((m) => isNormal(m) && sideOf(m, key, name)).forEach((m) => { const i = Number(String(m.date || '').slice(5, 7)); if (i >= 1 && i <= 12) months[i - 1].n++; });
  const top = Math.max.apply(null, months.map((x) => x.n));
  months.forEach((x) => { x.h = top ? Math.round((x.n / top) * 100) : 0; });
  const busy = top ? months.filter((x) => x.n === top)[0] : null;
  const from = hs.length ? hs[0].level - hs[0].delta : null, to = hs.length ? hs[hs.length - 1].level : null;
  const pv = partnersView(ms, key, name);
  return {
    season, label: SE.label(season), has: c.played > 0,
    played: c.played, win: c.win, lose: c.lose, rate: c.rate + '%',
    single: `${c.single.win}胜 ${c.single.played - c.single.win}负`, double: `${c.double.win}胜 ${c.double.played - c.double.win}负`,
    singlePlayed: c.single.played, doublePlayed: c.double.played,
    bestStreak: c.bestStreak, events: c.events, finals: c.finals, titles: c.titles.map((t) => ({ title: t.title, date: t.date })),
    bagels: c.bagels, comebacks: c.comebacks,
    rival: c.rival ? `${c.rival.name}（${c.rival.played} 场，${c.rival.win} 胜 ${c.rival.lose} 负）` : '',
    partner: pv && pv.best ? `${pv.best.name}（${pv.best.played} 场，胜率 ${pv.best.rate}%）` : '',
    partnerMost: pv ? `${pv.list[0].name}（${pv.list[0].played} 场）` : '',
    level: from === null ? null : { from: R.fmt(from), to: R.fmt(to), delta: R.fmtDelta(Math.round((to - from) * 100) / 100), up: to > from, down: to < from, peak: c.peak === null ? '' : R.fmt(c.peak) },
    months, busy: busy ? `${busy.m} 月（${busy.n} 场）` : '',
  };
}

/**
 * profiles: { uid: 本人资料 }（db.cachedProfiles）；players: db.fetchPlayersFull；matches: 正式战绩
 * 返回 { profile, ambiguous, level, stats, rows, career }，没有这个人时 profile 为 null
 */
// 生涯成就和各赛季战绩（utils/career.js），整理成页面直接能用的文字
function careerView(matches, uid, name, history, pre) {
  const c = CA.career(matches, uid, name, history, pre);
  const cur = SE.current();
  const lines = [];
  if (c.single.played) lines.push({ k: '单打', v: `${c.single.win}胜 ${c.single.played - c.single.win}负` });
  if (c.double.played) lines.push({ k: '双打', v: `${c.double.win}胜 ${c.double.played - c.double.win}负` });
  if (c.rival) lines.push({ k: '老对手', v: `${c.rival.name} · 交手 ${c.rival.played} 场 ${c.rival.win}胜 ${c.rival.lose}负` });
  if (c.first) lines.push({ k: '首场比赛', v: c.first });
  return {
    has: c.played > 0 || c.finals > 0,
    // 3 × 2 的数字格；cls 给格子画分隔线（bl 左边线、bt 上边线），拿过冠军的格子高亮（hot）
    cells: [
      { n: String(c.titles.length), l: '冠军' }, { n: String(c.finals), l: '最后一轮' }, { n: String(c.events), l: '参加活动' },
      { n: String(c.bestStreak), l: '最长连胜' }, { n: String(c.streak), l: '当前连胜' }, { n: c.peak === null ? NONE : R.fmt(c.peak), l: '最高等级' },
    ].map((x, i) => Object.assign(x, { cls: [i % 3 ? 'bl' : '', i >= 3 ? 'bt' : '', i === 0 && c.titles.length ? 'hot' : ''].join(' ').trim() })),
    lines, got: c.got, total: c.badges.length, pct: c.badges.length ? Math.round((c.got / c.badges.length) * 100) : 0,
    // 徽章进度条：progress 是「已有/需要」，达成的是 100
    badges: c.badges.map((b) => { const [v, need] = String(b.progress).split('/').map(Number); return Object.assign({}, b, { pct: b.got ? 100 : need ? Math.min(100, Math.round((v / need) * 100)) : 0 }); }),
    nemesis: c.nemesis, prey: c.prey,
    titles: c.titles.map((t) => ({ title: t.title, date: t.date })),
    seasons: c.seasons.map((s) => ({ season: s.season, now: s.season === cur, played: s.played, wl: `${s.win}-${s.lose}`, rate: s.played ? s.rate + '%' : NONE, titles: s.titles })),
  };
}

// 苦主 / 福星 / 最佳拍档：三个首字圆。对方有账号时带 uid（可以点进主页）；三个都没有返回 null
function relationsView(nemesis, prey, mate, profiles) {
  if (!nemesis && !prey && !mate) return null;
  const cell = (l, d, r) => (r
    ? { l, d, name: r.name, initial: initialOf(r.name), color: colorOf(r.name), rec: `${r.win}胜 ${r.lose}负`, uid: profiles && profiles[r.key] ? r.key : '' }
    : { l, d, none: true });
  return [cell('苦主', '输给 TA 最多', nemesis), cell('福星', '赢 TA 最多', prey), cell('最佳拍档', '搭档胜率最高', mate)];
}

// 返回值里的 tagsOf（全部比赛的亮点标签）只给调用方算交手记录用，不要整个 setData
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
  const tagsOf = H.matchTags(matches || [], stats.ratings);
  const cv = careerView(matches || [], uid, p.name, r ? r.history : [], stats.ratings.pre);
  const pv = partnersView(matches || [], uid, p.name);
  const rows = mine
    .slice()
    .sort((x, y) => String(y.date || '').localeCompare(String(x.date || '')) || String(y._id).localeCompare(String(x._id)))
    .map((m) => matchRow(m, uid, p.name, deltaOf, tagsOf));
  const last = r && r.history.length ? r.history[r.history.length - 1].delta : null;
  const selfLv = typeof p.level === 'number' ? p.level : null;
  const played = st ? st.played : 0;
  return {
    profile: { uid, name: p.name, initial: initialOf(p.name), color: colorOf(p.name), gender: S.GENDER[p.gender] || '性别未填' },
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
    career: cv,
    trend: trendView(r ? r.history : []),
    partners: pv,
    relations: relationsView(cv.nemesis, cv.prey, pv && pv.best, profiles),
    tagsOf,
  };
}

module.exports = { playerView, matchRow, sideOf, careerView, trendView, h2hView, partnersView, relationsView, seasonSummary };
