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
const UNRATED = '待定级'; // 球员卡：还没有比赛等级 / 没填自评等级

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
    type: m.type === 'double' ? 'double' : 'single',
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

// 等级走势：最近 TREND_MAX 场比赛打完后的比赛等级，画成一排柱子（2026-11-25 用户要求修）。
//   刻度和柱子用同一把尺：纵轴按 0.5 一档取整（lo～hi），每档画一条淡线并标数字，柱子高度按真实等级落在这把尺上，
//   柱顶到哪条线就是那个水平。最低的那场离底线至少留 0.1（正好在整档上就往下多留一档），免得柱子贴底看不见。
//   档位太多（超过 2.0 的跨度）时每 1.0 标一条线。所有场次同一天时日期只写一次（sameDay）。
const TREND_MAX = 30;
const TREND_FEW = 8; // 场数不多于这个时柱子加宽
function trendView(history) {
  const h = (history || []).slice(-TREND_MAX);
  if (h.length < 2) return null;
  const lv = h.map((x) => x.level);
  const min = Math.min.apply(null, lv), max = Math.max.apply(null, lv);
  const lo = Math.max(0.5, Math.floor((min - 0.1) * 2) / 2);
  let hi = Math.ceil(max * 2) / 2;
  if (hi - lo < 0.5) hi = lo + 0.5;
  const step = hi - lo > 2 ? 1 : 0.5;
  if (step === 1 && Math.round((hi - lo) * 2) % 2) hi += 0.5; // 跨度超过 2.0 按 1.0 一档时，顶线对齐整档（保证最上一条刻度正好在 100%）
  const span = hi - lo;
  const pos = (x) => Math.round(((x - lo) / span) * 1000) / 10; // 离底线的百分比（一位小数）
  const ticks = [];
  for (let t = lo; t <= hi + 1e-9; t += step) ticks.push({ v: R.fmt(t), pos: pos(t), base: t === lo });
  const from = (h[0].date || '').slice(5), to = (h[h.length - 1].date || '').slice(5);
  return {
    bars: h.map((x, i) => ({ i, h: pos(x.level), up: x.delta > 0, down: x.delta < 0, last: i === h.length - 1 })),
    ticks: ticks.reverse(), // 从上往下
    n: h.length, few: h.length <= TREND_FEW, min: R.fmt(min), max: R.fmt(max),
    from, to, sameDay: from === to,
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

/**
 * profiles: { uid: 本人资料 }（db.cachedProfiles）；players: db.fetchPlayersFull；matches: 正式战绩
 * 返回 { profile, ambiguous, level, stats, rows, career }，没有这个人时 profile 为 null
 */
// 生涯成就和各赛季战绩（utils/career.js），整理成页面直接能用的文字
function careerView(matches, uid, name, history, pre) {
  const c = CA.career(matches, uid, name, history, pre);
  const cur = SE.current();
  // 精简为 1 行 3 格（去掉常年为 0 的「最后一轮 / 当前连胜」）；有冠军时首格高亮「冠军」，未夺冠时显示「参加活动」
  const cells = [
    c.titles.length ? { n: String(c.titles.length), l: '冠军' } : { n: String(c.events), l: '参加活动' },
    { n: String(c.bestStreak), l: '最长连胜' },
    { n: c.peak === null ? NONE : R.fmt(c.peak), l: '最高等级' },
  ].map((x, i) => Object.assign(x, { cls: [i ? 'bl' : '', i === 0 && c.titles.length ? 'hot' : ''].join(' ').trim() }));
  return {
    has: c.played > 0 || c.finals > 0,
    // 原始数字（成长档案的正式战绩摘要用；和 computeRank 同一口径）
    played: c.played, win: c.win, lose: c.lose, rate: c.rate,
    single: { played: c.single.played, win: c.single.win }, double: { played: c.double.played, win: c.double.win },
    cells,
    lines: [], got: c.got, total: c.badges.length, pct: c.badges.length ? Math.round((c.got / c.badges.length) * 100) : 0,
    // 徽章进度条：progress 是「已有/需要」，达成的是 100
    badges: c.badges.map((b) => { const [v, need] = String(b.progress).split('/').map(Number); return Object.assign({}, b, { pct: b.got ? 100 : need ? Math.min(100, Math.round((v / need) * 100)) : 0 }); }),
    nemesis: c.nemesis, prey: c.prey,
    titles: c.titles.map((t) => ({ title: t.title, date: t.date })),
    seasons: c.seasons.map((s) => ({ season: s.season, now: s.season === cur, played: s.played, wl: `${s.win}-${s.lose}`, rate: s.played ? s.rate + '%' : NONE, titles: s.titles })),
  };
}

// 年度打球黄绿热力格：统计当年（1 月～12 月）每天实际在场打球的正式比赛场数（排除赛前弃权），按周一为一周首日排成网格
const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function heatmapView(matches, key, name, nowDate) {
  const today = nowDate && /^\d{4}-\d{2}-\d{2}$/.test(nowDate) ? nowDate : todayIso();
  const year = Number(today.slice(0, 4));
  const prefix = year + '-';
  const byDay = {};
  const byMonth = {};
  let total = 0;
  (matches || []).forEach((m) => {
    if (!m || !m.date || m.date.indexOf(prefix) !== 0) return;
    if (outcomeOf(m) === 'walkover') return;
    if (!sideOf(m, key, name)) return;
    byDay[m.date] = (byDay[m.date] || 0) + 1;
    const mo = Number(m.date.slice(5, 7));
    byMonth[mo] = (byMonth[mo] || 0) + 1;
    total++;
  });
  if (!total) return null;

  const days = Object.keys(byDay).length;
  let bestMo = 0, bestMoCnt = 0;
  Object.keys(byMonth).forEach((m) => {
    const c = byMonth[m];
    if (c > bestMoCnt) { bestMoCnt = c; bestMo = Number(m); }
  });

  const DAY_MS = 86400000;
  const jan1 = Date.UTC(year, 0, 1);
  const dec31 = Date.UTC(year, 11, 31);
  const startDow = (new Date(jan1).getUTCDay() + 6) % 7; // 周一 = 0，周日 = 6
  const weeks = [];
  let curStreak = 0, maxStreak = 0, todayWeek = -1;

  for (let ws = jan1 - startDow * DAY_MS, wi = 0; ws <= dec31; ws += 7 * DAY_MS, wi++) {
    const cells = [];
    let monthLbl = '';
    let wSum = 0;
    for (let d = 0; d < 7; d++) {
      const dt = new Date(ws + d * DAY_MS);
      const iso = dt.toISOString().slice(0, 10);
      const inYear = dt.getUTCFullYear() === year;
      const n = inYear ? (byDay[iso] || 0) : 0;
      const mo = dt.getUTCMonth() + 1;
      const dd = dt.getUTCDate();
      if (inYear && dd === 1) monthLbl = `${mo}月`;
      if (iso === today) todayWeek = wi;
      wSum += n;
      cells.push({
        d: iso, md: `${mo}月${dd}日`, n,
        lv: !inYear ? -1 : n >= 4 ? 4 : n,
        fut: inYear && iso > today,
      });
    }
    if (wSum > 0) { curStreak++; if (curStreak > maxStreak) maxStreak = curStreak; }
    else curStreak = 0;
    weeks.push({ i: wi, id: 'hmw' + wi, m: monthLbl, cells });
  }
  const focusIdx = Math.max(0, (todayWeek >= 0 ? todayWeek : weeks.length - 1) - 21);
  return {
    year, total, days,
    bestMonth: bestMo ? `${bestMo}月 · ${bestMoCnt} 场` : '',
    streakWeeks: maxStreak,
    focusId: 'hmw' + focusIdx,
    weeks,
  };
}

// 关键分画像（纯从正式战绩实时算，不加新字段）：抢七胜率、胶着盘（7:5 / 抢七 / 4:3）胜率、先丢首盘逆转、单双打胜率对比
function clutchView(matches, key, name) {
  const normal = (matches || []).filter((m) => isNormal(m) && sideOf(m, key, name));
  if (normal.length < 2) return null;
  let tbTot = 0, tbWon = 0, tightTot = 0, tightWon = 0, cbTot = 0, cbWon = 0;
  let sTot = 0, sWin = 0, dTot = 0, dWin = 0;
  normal.forEach((m) => {
    const side = sideOf(m, key, name), opp = side === 'a' ? 'b' : 'a';
    const won = m.winner === side;
    const isDbl = m.type === 'double' || (m.a && m.a.length > 1);
    if (isDbl) { dTot++; if (won) dWin++; } else { sTot++; if (won) sWin++; }
    const sets = m.sets || [];
    sets.forEach((s) => {
      const a = Number(s.a) || 0, b = Number(s.b) || 0;
      const mine = side === 'a' ? a : b, theirs = side === 'a' ? b : a;
      const setWin = mine > theirs;
      const hasTb = s.tbA !== undefined && s.tbB !== undefined;
      if (hasTb) { tbTot++; if (setWin) tbWon++; }
      const diff = Math.abs(a - b), hi = Math.max(a, b);
      if (hasTb || (hi >= 4 && diff === 1) || (hi >= 7 && diff === 2)) {
        tightTot++; if (setWin) tightWon++;
      }
    });
    if (sets.length >= 2) {
      const s0m = Number(sets[0][side]) || 0, s0o = Number(sets[0][opp]) || 0;
      if (s0m < s0o) { cbTot++; if (won) cbWon++; }
    }
  });
  const pct = (w, t) => (t ? Math.round((w / t) * 100) + '%' : NONE);
  return {
    played: normal.length,
    tb: { played: tbTot, win: tbWon, rate: pct(tbWon, tbTot), sub: tbTot ? `${tbWon}胜 ${tbTot - tbWon}负` : '暂无抢七' },
    tight: { played: tightTot, win: tightWon, rate: pct(tightWon, tightTot), sub: tightTot ? `${tightWon}胜 ${tightTot - tightWon}负` : '暂无胶着盘' },
    comeback: { played: cbTot, win: cbWon, rate: pct(cbWon, cbTot), sub: cbTot ? `${cbWon}/${cbTot} 场逆转` : '暂无多盘落后' },
    single: { played: sTot, win: sWin, lose: sTot - sWin, rate: sTot ? Math.round((sWin / sTot) * 100) : 0 },
    double: { played: dTot, win: dWin, lose: dTot - dWin, rate: dTot ? Math.round((dWin / dTot) * 100) : 0 },
  };
}

// 纯 ASCII 转 Base64（不依赖 Node Buffer / 浏览器 btoa，小程序与单测通用，用来生成纯矢量五维雷达图）
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function toBase64(ascii) {
  let out = '';
  for (let i = 0; i < ascii.length; i += 3) {
    const a = ascii.charCodeAt(i);
    const b = i + 1 < ascii.length ? ascii.charCodeAt(i + 1) : 0;
    const c = i + 2 < ascii.length ? ascii.charCodeAt(i + 2) : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63]
      + (i + 1 < ascii.length ? B64[(n >> 6) & 63] : '=')
      + (i + 2 < ascii.length ? B64[n & 63] : '=');
  }
  return out;
}

// 五边形雷达图 SVG（面向淡紫球风主卡：半透白网格 + 柔白数据面 + 网球黄绿顶点；中文标签由 WXML 摆在周围）
function radarSvgUri(scores, unlocked) {
  const cx = 120, cy = 126, maxR = 96;
  const pt = (idx, ratio) => {
    const ang = (-90 + idx * 72) * Math.PI / 180;
    return [Math.round((cx + Math.cos(ang) * maxR * ratio) * 10) / 10, Math.round((cy + Math.sin(ang) * maxR * ratio) * 10) / 10];
  };
  const poly = (ratios) => ratios.map((r, i) => pt(i, r).join(',')).join(' ');
  const outer = `<polygon points="${poly([1, 1, 1, 1, 1])}" fill="rgba(56,54,108,0.14)" stroke="rgba(255,255,255,0.38)" stroke-width="1.4"/>`;
  const innerRings = [0.66, 0.33].map((r) => `<polygon points="${poly([r, r, r, r, r])}" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="1"/>`).join('');
  const spokes = [0, 1, 2, 3, 4].map((i) => {
    const [x, y] = pt(i, 1);
    return `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="rgba(255,255,255,0.22)" stroke-width="1"/>`;
  }).join('');
  let dataLayer = '';
  if (unlocked) {
    const rs = scores.map((s) => Math.max(0.22, Math.min(1, s / 100)));
    let topIdx = 0;
    for (let i = 1; i < scores.length; i++) if (scores[i] > scores[topIdx]) topIdx = i;
    const dots = rs.map((r, i) => {
      const [x, y] = pt(i, r);
      const halo = i === topIdx ? `<circle cx="${x}" cy="${y}" r="8.2" fill="rgba(201,227,58,0.34)"/>` : '';
      return `${halo}<circle cx="${x}" cy="${y}" r="${i === topIdx ? '5.2' : '4.4'}" fill="#C9E33A" stroke="#FFFFFF" stroke-width="1.8"/>`;
    }).join('');
    dataLayer = `<polygon points="${poly(rs)}" fill="rgba(255,255,255,0.24)" stroke="#FFFFFF" stroke-width="2.4" stroke-linejoin="round"/>${dots}`;
  } else {
    dataLayer = `<polygon points="${poly([0.52, 0.52, 0.52, 0.52, 0.52])}" fill="rgba(255,255,255,0.10)" stroke="rgba(255,255,255,0.48)" stroke-width="1.6" stroke-dasharray="4 4"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 240">${outer}${innerRings}${spokes}${dataLayer}</svg>`;
  return 'data:image/svg+xml;base64,' + toBase64(svg);
}

// 五维球风数据（纯从正式比赛局分与出勤计算，满 STYLE_MIN 场解锁；只用客观正向网球词，不做主观评价）
const STYLE_MIN = 5;
function styleView(matches, key, name, ratings, clutch, heatmap) {
  const normal = (matches || []).filter((m) => isNormal(m) && sideOf(m, key, name));
  const played = normal.length;
  const unlocked = played >= STYLE_MIN;
  if (!unlocked) {
    return {
      unlocked: false, played, need: STYLE_MIN, left: STYLE_MIN - played,
      pct: Math.round((played / STYLE_MIN) * 100),
      radarUri: radarSvgUri([50, 50, 50, 50, 50], false),
      axes: [
        { k: 'dom', l: '局分压制', v: 0 }, { k: 'cl', l: '关键分', v: 0 },
        { k: 'grit', l: '硬仗韧性', v: 0 }, { k: 'stb', l: '稳定发挥', v: 0 }, { k: 'act', l: '出勤活跃', v: 0 },
      ],
      tags: [],
    };
  }
  let wins = 0, gWon = 0, gTot = 0, toughMine = 0, toughTot = 0, curSt = 0, bestSt = 0;
  const preMap = (ratings && ratings.pre) || {};
  const sorted = normal.slice().sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  sorted.forEach((m) => {
    const side = sideOf(m, key, name), opp = side === 'a' ? 'b' : 'a';
    const w = m.winner === side;
    if (w) { wins++; curSt++; if (curSt > bestSt) bestSt = curSt; } else curSt = 0;
    let mg = 0, og = 0;
    (m.sets || []).forEach((s) => { mg += Number(s[side]) || 0; og += Number(s[opp]) || 0; });
    gWon += mg; gTot += mg + og;
    const pre = m._id ? preMap[m._id] : null;
    if (pre && mg + og > 0) {
      const mineLv = side === 'a' ? pre.a : pre.b;
      const oppLv = side === 'a' ? pre.b : pre.a;
      if (oppLv >= mineLv - 0.15) { toughMine += mg; toughTot += mg + og; }
    }
  });
  const clampS = (x) => Math.max(18, Math.min(99, Math.round(x)));
  const winRate = (wins / played) * 100;
  const gameRate = gTot ? (gWon / gTot) * 100 : winRate;
  const dom = clampS(gameRate * 0.65 + winRate * 0.35);
  const tightTot = clutch ? clutch.tight.played : 0;
  const tightWon = clutch ? clutch.tight.win : 0;
  const clScore = clampS(((tightWon + 1.5) / (tightTot + 3)) * 100);
  const toughRate = toughTot ? (toughMine / toughTot) * 100 : gameRate;
  const cbBonus = clutch && clutch.comeback.win > 0 ? Math.min(12, clutch.comeback.win * 6) : 0;
  const grit = clampS(toughRate * 0.85 + 10 + cbBonus);
  const stb = clampS(winRate * 0.6 + Math.min(100, bestSt * 18) * 0.4);
  const actDays = heatmap ? heatmap.days : 0;
  const act = clampS(Math.min(100, (actDays / 24) * 80 + (played >= 15 ? 20 : (played / 15) * 20)));

  const axes = [
    { k: 'dom', l: '局分压制', v: dom },
    { k: 'cl', l: '关键分', v: clScore },
    { k: 'grit', l: '硬仗韧性', v: grit },
    { k: 'stb', l: '稳定发挥', v: stb },
    { k: 'act', l: '出勤活跃', v: act },
  ];
  // 客观正向网球标签（最多 3 个，按真实指标触发）
  const tags = [];
  if (tightTot >= 2 && clScore >= 62) tags.push('关键分稳健');
  if (dom >= 68) tags.push('火力占优');
  if (toughTot >= 10 && grit >= 64) tags.push('硬仗顽强');
  if (act >= 65) tags.push('出勤活跃');
  if (clutch && clutch.double.played >= 3 && clutch.double.rate >= 60) tags.push('双打配合佳');
  if (clutch && clutch.single.played >= 3 && clutch.double.played === 0) tags.push('单打专注');
  if (!tags.length) {
    const top = axes.slice().sort((a, b) => b.v - a.v)[0];
    tags.push(top ? `${top.l}突出` : '全面发展');
  }
  return {
    unlocked: true, played, need: STYLE_MIN, left: 0, pct: 100,
    radarUri: radarSvgUri(axes.map((a) => a.v), true),
    axes,
    tags: tags.slice(0, 3),
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
  const stats = S.playerStats(matches || [], players || [], profiles);
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
  const shown = p.shown === true;
  const hm = heatmapView(matches || [], uid, p.name);
  const cl = clutchView(matches || [], uid, p.name);
  const stv = styleView(matches || [], uid, p.name, stats.ratings, cl, hm);
  return {
    profile: { uid, name: p.name, initial: initialOf(p.name), color: colorOf(p.name), gender: S.GENDER[p.gender] || '性别未填', shown },
    ambiguous,
    level: {
      // 比赛等级（由正式比赛算）和自评等级（资料里填的）分开标注；没有就是「待定级」
      match: r ? R.fmt(r.level) : UNRATED,
      self: selfLv !== null ? R.fmt(selfLv) : UNRATED,
      tier: r ? R.tierOf(r.level) + '球员' : selfLv !== null ? R.tierOf(selfLv) + '球员（自评）' : '',
      provisional: !!r && r.provisional, played: r ? r.played : 0, need: R.PROVISIONAL,
      last: last === null ? '' : R.fmtDelta(last), up: last > 0, down: last < 0,
    },
    stats: {
      rank: !played ? NONE : S.rankText(st, (n) => '#' + n), // 和排行榜一致（S.playerStats 的 boardRank）
      matches: played ? String(played) : NONE,
      wl: played ? `${wins}胜 ${played - wins}负` : NONE,
      win: String(wins), lose: String(played - wins), // 全部比赛页的数字卡用（没比赛就是 0）
      rate: played ? st.rate + '%' : NONE,
    },
    rows,
    career: cv,
    trend: trendView(r ? r.history : []),
    heatmap: hm,
    clutch: cl,
    style: stv,
    partners: pv,
    relations: relationsView(cv.nemesis, cv.prey, pv && pv.best, profiles),
    tagsOf,
  };
}

// 某一年（默认当年）的年度网球战报摘要：纯从正式比赛（及本人可选的球拍年度统计）计算，客观展示不做主观评价
function annualView(view, matches, key, name, yearStr, racketStats) {
  const year = String(yearStr || (view && view.heatmap && view.heatmap.year) || new Date().getFullYear());
  const prefix = year + '-';
  const mine = (matches || []).filter((m) => String(m.date || '').indexOf(prefix) === 0 && sideOf(m, key, name));
  const normal = mine.filter((m) => isNormal(m)).sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  let win = 0, lose = 0, gamesWon = 0, gamesLost = 0, curSt = 0, bestStreak = 0;
  const daySet = {}, monthCnt = {}, oppMap = {};
  mine.forEach((m) => {
    const d = String(m.date || '');
    if (d) {
      daySet[d] = 1;
      const mo = Number(d.slice(5, 7));
      if (mo >= 1 && mo <= 12) monthCnt[mo] = (monthCnt[mo] || 0) + 1;
    }
  });
  normal.forEach((m) => {
    const side = sideOf(m, key, name), opp = side === 'a' ? 'b' : 'a';
    const w = m.winner === side;
    if (w) { win++; curSt++; if (curSt > bestStreak) bestStreak = curSt; } else { lose++; curSt = 0; }
    (m.sets || []).forEach((s) => { gamesWon += Number(s[side]) || 0; gamesLost += Number(s[opp]) || 0; });
    const oppNames = m[opp] || [];
    const oppKeys = m[opp + 'Keys'] || oppNames;
    oppNames.forEach((on, i) => {
      const ok = oppKeys[i] || on;
      if (!on || ok === key) return;
      const cur = oppMap[ok] || { key: ok, name: on, count: 0, win: 0, lose: 0 };
      cur.name = on; cur.count++; if (w) cur.win++; else cur.lose++;
      oppMap[ok] = cur;
    });
  });
  const played = win + lose;
  const days = Object.keys(daySet).length;
  let bestMo = 0, bestMoCnt = 0;
  Object.keys(monthCnt).forEach((m) => { if (monthCnt[m] > bestMoCnt) { bestMoCnt = monthCnt[m]; bestMo = Number(m); } });
  const mostOpp = Object.keys(oppMap).map((k) => oppMap[k]).sort((a, b) => b.count - a.count || b.win - a.win)[0] || null;
  const bestMate = view && view.partners && view.partners.best ? view.partners.best : null;
  const tb = view && view.clutch && view.clutch.tb && view.clutch.tb.played ? view.clutch.tb : null;
  const rk = racketStats && racketStats.hasData ? {
    spendText: `¥${racketStats.yearCost || 0}`,
    yearStrings: racketStats.yearStrings || 0,
    yearPlayHours: racketStats.yearPlayHours || '0 小时',
    topString: racketStats.topString ? racketStats.topString.name : '',
  } : null;
  const prof = (view && view.profile) || { name: name || '', initial: initialOf(name || ''), color: colorOf(name || '') };
  const lv = (view && view.level) || { match: UNRATED, tier: '' };
  const style = (view && view.style) || { unlocked: false, played: 0, need: STYLE_MIN, axes: [], tags: [] };
  return {
    year,
    name: prof.name,
    initial: prof.initial,
    color: prof.color,
    level: lv.match,
    tier: lv.tier,
    played, win, lose,
    rate: played ? Math.round((win / played) * 100) + '%' : '—',
    days,
    gamesWon, gamesLost,
    bestStreak,
    bestMonth: bestMo ? `${bestMo}月 · ${bestMoCnt} 场` : '',
    mostOpp: mostOpp && mostOpp.count >= 2 ? mostOpp : null,
    bestMate: bestMate ? { key: bestMate.key, name: bestMate.name, rate: bestMate.rate, played: bestMate.played } : null,
    tbRate: tb ? tb.rate : '',
    tbSub: tb ? `${tb.win}胜${tb.lose}负` : '',
    style,
    racket: rk,
    headline: played
      ? `${year} 年出勤 ${days} 天 · 完赛 ${played} 场 · 赢下 ${gamesWon} 局`
      : `${year} 球场记录已就绪 · 期待下一场正式对局`,
  };
}

module.exports = { playerView, matchRow, sideOf, careerView, trendView, heatmapView, clutchView, styleView, STYLE_MIN, annualView, h2hView, partnersView, relationsView, NONE };
