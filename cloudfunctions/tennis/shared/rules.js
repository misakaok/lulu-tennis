// 比赛规则（每场比赛可选）：
//   setGames: 4 → 每盘先到 4 局并领先 2 局，3:3 抢七
//   setGames: 6 → 每盘先到 6 局并领先 2 局（或 7:5），6:6 抢七
//   noAd: true  → 金球制：抢七先到 7 分、净胜 1 分即赢（7:6 结束）
//   noAd: false → 占先制：抢七先到 7 分且领先 2 分（可以 8:6、9:7…）
const TB_TO = 7;
const DEFAULT_CFG = { setGames: 4, noAd: true };

const tbAt = (cfg) => (cfg.setGames === 4 ? 3 : cfg.setGames);
const maxGames = (cfg) => (tbAt(cfg) === cfg.setGames ? cfg.setGames + 1 : cfg.setGames);
const isInt = (v) => typeof v === 'number' && Number.isInteger(v) && v >= 0;

function normCfg(cfg) {
  return { setGames: (cfg && cfg.setGames) === 6 ? 6 : 4, noAd: cfg && cfg.noAd !== undefined ? !!cfg.noAd : true };
}

function rulesText(cfg) {
  const T = tbAt(cfg);
  return `每盘 ${cfg.setGames} 局 · ${T}:${T} 抢七 · ${cfg.noAd ? '金球' : '占先'}`;
}

// 这一盘是否要填抢七小分：局分 3:3（6局制 6:6），或者已经填成 4:3 / 7:6
function needTiebreak(a, b, cfg) {
  const T = tbAt(cfg);
  const hi = Math.max(a, b), lo = Math.min(a, b);
  return (a === T && b === T) || (hi === T + 1 && lo === T);
}

// 抢七小分是否有效（tw 是赢家的分，tl 是输家的分）
function checkTb(tw, tl, cfg) {
  if (tw <= tl) return '抢七小分不能打平';
  if (tw < TB_TO) return `抢七要先到 ${TB_TO} 分`;
  if (cfg.noAd) {
    if (tw !== TB_TO) return `金球制抢七到 ${TB_TO} 分就结束（最多 ${TB_TO}:${TB_TO - 1}）`;
  } else {
    if (tw - tl < 2) return `占先制抢七需要领先 2 分`;
    if (tw > TB_TO && tw - tl !== 2) return `抢七超过 ${TB_TO} 分时，比分应只差 2 分`;
  }
  return '';
}

// 检查一盘比分 { a, b, tbA?, tbB? }（应先经过 cleanSet）
function checkSet(s, cfg) {
  const { a, b } = s;
  const N = cfg.setGames, T = tbAt(cfg);
  const hi = Math.max(a, b), lo = Math.min(a, b);

  if (needTiebreak(a, b, cfg)) {
    if (!isInt(s.tbA) || !isInt(s.tbB)) return { ok: false, msg: `${a}:${b} 请填写抢七小分` };
    const w = a === b ? (s.tbA > s.tbB ? 'a' : 'b') : (a > b ? 'a' : 'b');
    const tw = w === 'a' ? s.tbA : s.tbB, tl = w === 'a' ? s.tbB : s.tbA;
    if (a !== b && tw < tl) return { ok: false, msg: '抢七小分应由赢下这一盘的一方领先' };
    const err = checkTb(tw, tl, cfg);
    if (err) return { ok: false, msg: err };
    return { ok: true, winner: w, tb: true };
  }
  const w = a > b ? 'a' : 'b';
  if (hi === N && hi - lo >= 2) return { ok: true, winner: w, tb: false };
  if (T === N && hi === N + 1 && lo === N - 1) return { ok: true, winner: w, tb: false }; // 6局制的 7:5
  if (hi === lo) return { ok: false, msg: `${a}:${b} 还没打完` };
  return { ok: false, msg: `${a}:${b} 不是有效比分（每盘先到 ${N} 局并领先 2 局，${T}:${T} 抢七）` };
}

// 整理一盘：去掉无关字段；3:3 时按小分把赢家记成 4:3（6局制 7:6）
function cleanSet(s, cfg) {
  const out = { a: s.a, b: s.b };
  if (!needTiebreak(s.a, s.b, cfg)) return out;
  const ta = parseInt(s.tbA, 10), tb = parseInt(s.tbB, 10);
  if (!isNaN(ta)) out.tbA = ta;
  if (!isNaN(tb)) out.tbB = tb;
  const T = tbAt(cfg);
  if (out.a === T && out.b === T && isInt(out.tbA) && isInt(out.tbB) && out.tbA !== out.tbB) {
    if (out.tbA > out.tbB) out.a = T + 1; else out.b = T + 1;
  }
  return out;
}

// 检查整场比赛。sets 是原始输入，bestOf: 1 或 3
function checkMatch(rawSets, bestOf, cfg) {
  const sets = rawSets.map((s) => cleanSet(s, cfg));
  const need = Math.floor(bestOf / 2) + 1;
  const won = { a: 0, b: 0 };
  if (!sets.length) return { ok: false, msg: '请至少填写一盘' };
  for (let i = 0; i < sets.length; i++) {
    if (won.a === need || won.b === need) {
      return { ok: false, msg: `比赛在第 ${i} 盘已经结束，请删除多余的盘` };
    }
    const r = checkSet(sets[i], cfg);
    if (!r.ok) return { ok: false, msg: (sets.length > 1 ? `第 ${i + 1} 盘：` : '') + r.msg };
    won[r.winner]++;
  }
  if (won.a < need && won.b < need) {
    return { ok: false, undecided: true, won, msg: `盘分 ${won.a}:${won.b}，还需要再打一盘` };
  }
  return { ok: true, winner: won.a > won.b ? 'a' : 'b', won, sets };
}

// 比赛结果类型：normal 正常完赛 / walkover 弃权 / retired 中途退赛（outcome 字段；旧数据的 walkover: true 也算弃权）
// 弃权、中途退赛与正常完赛分开统计：不计入完赛场数、胜率、排名和水平分，也不开放互评；晋级按处理结果执行
const outcomeOf = (m) => (m && m.outcome) || (m && m.walkover ? 'walkover' : 'normal');
const isNormal = (m) => outcomeOf(m) === 'normal';

// 排行榜：type = 'all' | 'single' | 'double'（只算正常完赛）
function computeRank(matches, type) {
  const map = {};
  const get = (n) => map[n] || (map[n] = { name: n, played: 0, win: 0, setW: 0, setL: 0, gameW: 0, gameL: 0, recent: [] });
  matches.filter((m) => isNormal(m) && (type === 'all' || m.type === type)).forEach((m) => {
    ['a', 'b'].forEach((side) => {
      const o = side === 'a' ? 'b' : 'a';
      (m[side] || []).forEach((n) => {
        const p = get(n);
        p.played++;
        if (m.winner === side) p.win++;
        if (p.recent.length < 5) p.recent.push(m.winner === side ? 'W' : 'L');
        (m.sets || []).forEach((s) => {
          p.gameW += s[side]; p.gameL += s[o];
          if (s[side] > s[o]) p.setW++; else p.setL++;
        });
      });
    });
  });
  return Object.keys(map).map((k) => {
    const p = map[k];
    p.lose = p.played - p.win;
    p.rate = p.played ? Math.round((p.win / p.played) * 100) : 0;
    p.diff = p.gameW - p.gameL;
    return p;
  }).sort((x, y) => y.win - x.win || y.rate - x.rate || y.diff - x.diff);
}

const PALETTE = [
  'linear-gradient(135deg,#e9ff7a,#a9c62a)', 'linear-gradient(135deg,#a6d6ff,#3a8fe6)',
  'linear-gradient(135deg,#ffd2a1,#ff9a4d)', 'linear-gradient(135deg,#d6c8ff,#8b6cf0)',
  'linear-gradient(135deg,#a8f0d2,#2fb383)', 'linear-gradient(135deg,#ffc2cf,#f06b8b)',
  'linear-gradient(135deg,#fff0a6,#f2c230)', 'linear-gradient(135deg,#b9ecff,#38b6e0)',
];
function colorOf(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function initialOf(name) {
  const c = Array.from(String(name || '?'))[0] || '?';
  return c.toUpperCase();
}

module.exports = {
  outcomeOf, isNormal, DEFAULT_CFG, TB_TO, tbAt, maxGames, normCfg, rulesText,
  needTiebreak, checkTb, checkSet, cleanSet, checkMatch, computeRank, colorOf, initialOf,
};
