// 赛事：把签表 / 分组和录入的比分串起来
//
// 赛事里的每一场比分都存在 matches 集合里，并带上
//   drawId  所属赛事（draws 里的 _id）
//   drawKey 是哪一场：淘汰赛 '轮-场'（如 '0-3'），小组赛 'g组-i-j'（如 'g0-1-2'），
//           小组赛＋淘汰赛里的淘汰赛 'k轮-场'（如 'k1-0'）
//   ea / eb 录入时双方的参赛名（单打是名字，双打是 '张三 / 李四'）
// 签表、积分榜、赛程都由这些记录实时算出来，所以任何参赛者都能录分，
// 不需要改 draws 里的数据（draws 只有发起人能改）。
const D = require('./draw');

const TEAM_SEP = ' / ';

// 赛事设置（旧签表没有这些字段时用默认值）
function cfgOf(d) {
  d = d || {};
  return {
    type: d.type === 'double' ? 'double' : 'single',
    setGames: d.setGames === 6 ? 6 : 4,
    noAd: d.noAd !== false,
    bestOf: d.bestOf === 3 ? 3 : 1,
  };
}

function formatText(cfg) {
  const T = cfg.setGames === 4 ? 3 : cfg.setGames;
  return [
    cfg.type === 'double' ? '双打' : '单打',
    cfg.bestOf === 3 ? '三盘两胜' : '一盘定胜负',
    `${cfg.setGames} 局制 · ${T}:${T} 抢七`,
    cfg.noAd ? '金球' : '占先',
  ].join(' · ');
}

/* ---------- 赛制：赛事形式 + 分阶段 / 分轮次规则 ---------- */
// mode: 'bracket' 淘汰赛 | 'groups' 小组赛 | 'groups_ko' 小组赛＋淘汰赛（每组前 advance 名进入淘汰赛）
// rules: { group: 规则, ko: 规则, rounds: { '2': 决赛规则, '4': 半决赛规则, ... } }
//   规则 = { setGames: 4|6, noAd: 金球?, bestOf: 1|3 }；rounds 的键是这一轮的人数（2 = 决赛）
// 旧赛事没有 rules：所有场次都用顶层的 setGames / noAd / bestOf
const MODES = { bracket: '淘汰赛', groups: '小组赛', groups_ko: '小组赛＋淘汰赛' };
const hasGroups = (d) => !!d && (d.mode === 'groups' || d.mode === 'groups_ko');
const hasKo = (d) => !!d && (d.mode !== 'groups');

function normRule(r, fb) {
  r = r || {}; fb = fb || {};
  const sg = r.setGames || fb.setGames, bo = r.bestOf || fb.bestOf;
  return {
    setGames: sg === 6 ? 6 : 4,
    noAd: r.noAd !== undefined ? !!r.noAd : fb.noAd !== false,
    bestOf: bo === 3 ? 3 : 1,
  };
}
function ruleText(r) {
  const T = r.setGames === 4 ? 3 : r.setGames;
  return `${r.setGames} 局制 · ${T}:${T} 抢七 · ${r.noAd ? '金球' : '占先'} · ${r.bestOf === 3 ? '三盘两胜' : '一盘'}`;
}
const sameRule = (x, y) => x.setGames === y.setGames && x.noAd === y.noAd && x.bestOf === y.bestOf;

// 淘汰赛签数（2 的幂）：淘汰赛按签数；小组赛＋淘汰赛按出线人数
function koSize(d) {
  if (!d) return 2;
  if (d.mode === 'groups_ko') return D.nextPow2(Math.max(2, (d.groupCount || 2) * (d.advance || 2)));
  return D.nextPow2(d.size || 8);
}
// 淘汰赛有哪些轮次：[{ players: 8, name: '1/4 决赛' }, { players: 4, ... }, { players: 2, name: '决赛' }]
function koRounds(d) {
  const out = [];
  for (let n = koSize(d); n >= 2; n /= 2) out.push({ players: n, name: D.roundName(n) });
  return out;
}

function stageRules(d) {
  const legacy = normRule(d);
  const r = (d && d.rules) || null;
  if (!r) return { group: legacy, ko: legacy, rounds: {} };
  const ko = normRule(r.ko, legacy);
  const rounds = {};
  Object.keys(r.rounds || {}).forEach((k) => { if (r.rounds[k]) rounds[k] = normRule(r.rounds[k], ko); });
  return { group: normRule(r.group, legacy), ko, rounds };
}

// 某一场比赛适用的规则（录分时自动使用）
function ruleFor(d, key) {
  const type = cfgOf(d).type;
  const s = stageRules(d);
  if (/^g/.test(key || '')) return Object.assign({ type, stage: '小组赛' }, s.group);
  const r = parseInt(String(key || '0').replace(/^k/, ''), 10) || 0;
  const players = Math.max(2, koSize(d) >> r);
  const custom = s.rounds[players];
  return Object.assign({ type, stage: `淘汰赛 · ${D.roundName(players)}`, custom: !!custom }, custom || s.ko);
}

// 赛事详情里展示的赛制：每个阶段一行；单独设置过的轮次也列出来
function rulesSummary(d) {
  const s = stageRules(d), out = [];
  if (hasGroups(d)) out.push({ stage: '小组赛', text: ruleText(s.group) });
  if (hasKo(d)) {
    const rs = koRounds(d), custom = rs.filter((x) => s.rounds[x.players] && !sameRule(s.rounds[x.players], s.ko));
    const others = rs.filter((x) => custom.indexOf(x) < 0);
    if (others.length) out.push({ stage: custom.length ? `淘汰赛（${others.map((x) => x.name).join('、')}）` : '淘汰赛', text: ruleText(s.ko) });
    custom.forEach((x) => out.push({ stage: x.name, text: ruleText(s.rounds[x.players]), hl: true }));
  }
  return out;
}

const teamLabel = (names) => names.filter(Boolean).join(TEAM_SEP);
const membersOf = (d, ent) => (d && d.teams && d.teams[ent]) || [ent];

function tsOf(m) {
  const t = m && m.createdAt;
  if (!t) return 0;
  if (typeof t === 'number') return t;
  const v = new Date(t).getTime();
  return isNaN(v) ? 0 : v;
}

// 同一场比赛被录了多次（改比分）时，只保留最新的一条
function dedupe(list) {
  const best = {};
  const k = (m) => m.drawId + '#' + m.drawKey;
  (list || []).forEach((m) => { if (m.drawId && m.drawKey && (!best[k(m)] || tsOf(m) >= tsOf(best[k(m)]))) best[k(m)] = m; });
  return (list || []).filter((m) => !m.drawId || !m.drawKey || best[k(m)] === m);
}

function indexFor(matches, drawId) {
  const idx = {};
  (matches || []).forEach((m) => {
    if (!drawId || m.drawId !== drawId || !m.drawKey) return;
    if (!idx[m.drawKey] || tsOf(m) >= tsOf(idx[m.drawKey])) idx[m.drawKey] = m;
  });
  return idx;
}

function flipSets(sets) {
  return (sets || []).map((s) => {
    const o = { a: s.b, b: s.a };
    if (s.tbB !== undefined) o.tbA = s.tbB;
    if (s.tbA !== undefined) o.tbB = s.tbA;
    return o;
  });
}

function scoreText(sets) {
  return (sets || []).map((s) => `${s.a}:${s.b}` + (s.tbA !== undefined && s.tbB !== undefined ? `(${s.tbA}:${s.tbB})` : '')).join('  ');
}

// 记录 m 是不是 ea vs eb 这场；返回按 ea 在前方向的结果
function resultFor(m, ea, eb) {
  if (!m) return null;
  const outcome = m.outcome || (m.walkover ? 'walkover' : 'normal');
  const base = { id: m._id, record: m, outcome, resolution: m.resolution || null };
  if (m.ea === ea && m.eb === eb) return Object.assign(base, { winner: m.winner, sets: m.sets || [] });
  if (m.ea === eb && m.eb === ea) return Object.assign(base, { winner: m.winner === 'a' ? 'b' : 'a', sets: flipSets(m.sets) });
  return null; // 对阵已经变了（比如前一轮改了比分），这条记录不再算这场
}

/* ---------- 退赛 ---------- */
// draws.withdrawals: [{ entrant, stage: 'group' | 'ko', policy: 'walkover' | 'void', reason, by, at }]（只由云函数写入）
//   小组赛退赛必须由发起人明确选择处理方式（没有默认）：
//     walkover 「已赛成绩保留，未赛场次判对手弃权胜」：未赛场次由云函数写成弃权记录；退赛者不能出线
//     void     「取消该球员全部小组成绩」：TA 参与的小组赛（含已打的）都不计入积分榜；其他人只按彼此间的比赛排名
//   淘汰赛退赛：TA 下一场（对手确定后）自动判对手弃权胜，不生成虚假比分和记录
function withdrawalsOf(d) {
  const out = {};
  ((d && d.withdrawals) || []).forEach((w) => { if (w && w.entrant) out[w.entrant] = w; });
  return out;
}
// 淘汰赛：一方已退赛且这场还没有记录 → 对手弃权胜（虚拟结果，不是比赛记录）
function koLookup(d, idx) {
  const wd = withdrawalsOf(d);
  return (key, a, b) => {
    const hit = resultFor(idx[key], a.name, b.name);
    if (hit) return hit;
    const wa = wd[a.name], wb = wd[b.name];
    if (!wa && !wb) return null;
    const w = wa && !wb ? 'b' : 'a';
    return { winner: w, sets: [], id: '', outcome: 'walkover', virtual: true, resolution: { type: 'withdraw', reason: (wa || wb).reason || '', side: w === 'a' ? 'b' : 'a' } };
  };
}

/* ---------- 淘汰赛 ---------- */
function bracketFor(d, matches) {
  const idx = indexFor(matches, d._id);
  return D.bracketView(d.lines || [], d.results || {}, koLookup(d, idx));
}

/* ---------- 小组赛 ---------- */
// 单循环轮转法：尽量让每个人隔一场再打
function roundRobin(n) {
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(i);
  if (n % 2) ids.push(-1);
  const m = ids.length, rounds = [];
  for (let r = 0; r < m - 1; r++) {
    const pairs = [];
    for (let k = 0; k < m / 2; k++) {
      const x = ids[k], y = ids[m - 1 - k];
      if (x >= 0 && y >= 0) pairs.push(x < y ? [x, y] : [y, x]);
    }
    rounds.push(pairs);
    ids.splice(1, 0, ids.pop());
  }
  return rounds;
}

// 小组排名：胜场 → 两人同胜场看交手 → 净胜盘 → 净胜局
// 小组排名：胜场 → 两人同胜场看交手 → 净胜盘 → 净胜局
//   弃权场次：算胜负，不算盘和局；中途退赛：胜负按处理结果，已打的盘局照算
//   退赛（withdrawn）的球员排在最后、不能出线；成绩被取消（void）的球员和 TA 的场次都不计入
function standings(members, fixtures, wd) {
  wd = wd || {};
  const row = {};
  members.forEach((p, i) => {
    row[p.name] = { name: p.name, seed: p.seed || 0, order: i, played: 0, win: 0, lose: 0, setW: 0, setL: 0, gameW: 0, gameL: 0, wo: 0 };
  });
  fixtures.forEach((f) => {
    if (!f.done || f.void) return;
    const A = row[f.a], B = row[f.b];
    A.played++; B.played++;
    if (f.winner === 'a') { A.win++; B.lose++; } else { B.win++; A.lose++; }
    if (f.outcome === 'walkover') { (f.winner === 'a' ? B : A).wo++; return; }
    const lastOpen = f.outcome === 'retired' ? f.sets.length - 1 : -1; // 中途退赛：最后一盘没打完，只算局不算盘
    f.sets.forEach((s, si) => {
      if (si === lastOpen || s.a === s.b) { A.gameW += s.a; A.gameL += s.b; B.gameW += s.b; B.gameL += s.a; return; }
      A.gameW += s.a; A.gameL += s.b; B.gameW += s.b; B.gameL += s.a;
      if (s.a > s.b) { A.setW++; B.setL++; } else { B.setW++; A.setL++; }
    });
  });
  const h2h = (x, y) => {
    const f = fixtures.find((g) => g.done && ((g.a === x.name && g.b === y.name) || (g.a === y.name && g.b === x.name)));
    if (!f) return 0;
    return (f.a === x.name) === (f.winner === 'a') ? -1 : 1;
  };
  const all = Object.keys(row).map((k) => {
    const r = row[k];
    r.setDiff = r.setW - r.setL;
    r.gameDiff = r.gameW - r.gameL;
    r.withdrawn = wd[r.name] ? wd[r.name].policy || 'walkover' : '';
    return r;
  });
  const list = all.filter((r) => !r.withdrawn);
  list.sort((x, y) => y.win - x.win || y.setDiff - x.setDiff || y.gameDiff - x.gameDiff || x.order - y.order);
  let out = [];
  for (let i = 0; i < list.length;) {
    let j = i;
    while (j < list.length && list[j].win === list[i].win) j++;
    const block = list.slice(i, j);
    if (block.length === 2 && h2h(block[0], block[1]) > 0) block.reverse();
    out = out.concat(block);
    i = j;
  }
  out.forEach((r, k) => { r.rank = k + 1; });
  // 退赛的排在最后，不占名次、不能出线
  all.filter((r) => r.withdrawn).forEach((r) => { r.rank = 0; out.push(r); });
  return out;
}

function groupsFor(d, matches) {
  const idx = indexFor(matches, d._id);
  const wd = withdrawalsOf(d);
  const voided = (n) => !!(wd[n] && wd[n].policy === 'void');
  return (d.groups || []).map((g, gi) => {
    const members = g.members || [];
    const fixtures = [];
    roundRobin(members.length).forEach((pairs, r) => pairs.forEach(([i, j]) => {
      const a = members[i].name, b = members[j].name, key = `g${gi}-${i}-${j}`;
      const res = resultFor(idx[key], a, b);
      const v = voided(a) || voided(b); // 成绩取消的球员参与的场次：不再进行，也不计入积分榜
      fixtures.push({
        key, round: r + 1, stage: `${g.name} · 第 ${r + 1} 轮`, a, b, ready: !v,
        done: !!res || v, void: v, winner: res && !v ? res.winner : '', sets: res ? res.sets : [], recordId: res ? res.id : '',
        outcome: v ? 'void' : res ? res.outcome : '', resolution: res ? res.resolution : null,
      });
    }));
    return { name: g.name, members, fixtures, table: standings(members, fixtures, wd), done: fixtures.filter((f) => f.done).length };
  });
}

/* ---------- 小组赛＋淘汰赛：按小组排名生成淘汰赛签表 ---------- */
// 小组第一按小组顺序当种子（A1 = 1 号、B1 = 2 号…），轮空优先给排名靠前的小组第一；
// 小组第二交叉对阵（A1 对 B2、B1 对 A2…），同组的两人分在上下半区。
// 小组赛没全部打完之前，签表显示「A 组第 1」这样的占位，不能录分。
// 小组赛改了比分导致排名变化，签表跟着变；对不上的淘汰赛旧比分自动不算（和淘汰赛改分规则一致）。
function koLines(d, groups) {
  const G = groups.length, adv = d.advance === 1 ? 1 : 2;
  const complete = G > 0 && groups.every((g) => g.fixtures.length > 0 && g.done === g.fixtures.length);
  const n = koSize(d), order = D.bracketOrder(n), lines = new Array(n).fill(null);
  const letter = (gi) => String(groups[gi].name).replace(/\s*组$/, '');
  const q = (gi, rank) => {
    const row = groups[gi].table.filter((r) => !r.withdrawn)[rank - 1]; // 退赛的不能出线，由下一名递补
    if (!row) return { bye: true };
    return complete ? { name: row.name, from: `${letter(gi)}${rank}` } : { tbd: true, label: `${letter(gi)} 组第 ${rank}` };
  };
  const pos = (seed) => order.indexOf(seed);
  for (let gi = 0; gi < G; gi++) lines[pos(gi + 1)] = q(gi, 1);
  if (adv === 2) {
    const B = n - G * 2;
    for (let s = 1; s <= B; s++) lines[pos(s) ^ 1] = { bye: true };
    const placed = {};
    for (let gi = 0; gi < G; gi++) {
      const p = pos(gi + 1) ^ 1;
      if (lines[p]) continue;
      let gj = (gi ^ 1) < G && !placed[gi ^ 1] ? gi ^ 1 : -1;
      for (let j = 0; gj < 0 && j < G; j++) if (j !== gi && !placed[j]) gj = j;
      if (gj >= 0) { lines[p] = q(gj, 2); placed[gj] = 1; }
    }
    // 剩下的小组第二（对应的小组第一轮空了）：放到自己小组第一的另一个半区，且首轮不碰同组
    const half = n / 2;
    for (let gk = 0; gk < G; gk++) {
      if (placed[gk]) continue;
      const other = pos(gk + 1) < half ? [half, n] : [0, half];
      const empty = (lo, hi) => { const out = []; for (let i = lo; i < hi; i++) if (!lines[i]) out.push(i); return out; };
      const sameGroup = (i) => { const p = lines[i ^ 1]; return p && p.from && p.from[0] === letter(gk) || (p && p.label && p.label[0] === letter(gk)); };
      const cands = empty(other[0], other[1]).concat(empty(0, n));
      const i = cands.find((x) => !sameGroup(x));
      lines[i !== undefined ? i : cands[0]] = q(gk, 2);
      placed[gk] = 1;
    }
  }
  for (let i = 0; i < n; i++) if (!lines[i]) lines[i] = { bye: true };
  return { lines, complete };
}

function knockoutFor(d, matches, groups) {
  const idx = indexFor(matches, d._id);
  const { lines, complete } = koLines(d, groups || groupsFor(d, matches));
  const v = D.bracketView(lines, {}, koLookup(d, idx), 'k');
  return Object.assign(v, { complete });
}

/* ---------- 赛程（所有场次的列表） ---------- */
// 结果说明：弃权胜 / 弃权负、中途退赛、成绩取消；正常完赛就是比分
function outcomeText(x) {
  if (x.outcome === 'void') return '退赛，成绩取消';
  if (!x.done || !x.outcome || x.outcome === 'normal') return '';
  const loser = x.winner === 'a' ? x.b : x.a;
  if (x.outcome === 'walkover') return `${loser} 弃权`;
  if (x.outcome === 'retired') return `${loser} 中途退赛`;
  return '';
}
function item(d, x) {
  const ot = outcomeText(x);
  return Object.assign(x, {
    aMembers: x.tbdA ? [] : membersOf(d, x.a),
    bMembers: x.tbdB ? [] : membersOf(d, x.b),
    score: [x.outcome === 'walkover' || x.outcome === 'void' ? '' : scoreText(x.sets), ot].filter(Boolean).join(' · '),
    outcomeText: ot,
  });
}

function koItems(d, view, stagePrefix) {
  const out = [];
  view.rounds.forEach((rd) => rd.matches.forEach((m) => {
    if (m.hasBye) return;
    out.push(item(d, {
      key: m.key, round: m.r + 1, stage: stagePrefix + rd.name,
      a: m.a.name || '', b: m.b.name || '', tbdA: !m.a.name, tbdB: !m.b.name,
      labelA: m.a.label || '', labelB: m.b.label || '', // 小组赛还没打完时显示「A 组第 1」
      ready: m.ready, done: !!(m.a.win || m.b.win), winner: m.a.win ? 'a' : m.b.win ? 'b' : '',
      sets: m.sets || [], recordId: m.recordId || '', outcome: m.outcome || '', resolution: m.resolution || null, virtual: !!m.virtual,
    }));
  }));
  return out;
}

function withRule(d, x) {
  const r = ruleFor(d, x.key);
  return Object.assign(x, { rule: r, ruleText: ruleText(r), ruleCustom: !!r.custom });
}

function scheduleOf(d, matches) {
  if (!d || d.status === 'signup') return [];
  let out = [];
  if (hasGroups(d)) {
    const groups = groupsFor(d, matches);
    const all = [];
    groups.forEach((g) => g.fixtures.forEach((f) => all.push(f)));
    all.sort((x, y) => x.round - y.round); // 按轮次穿插各组
    out = all.map((f) => item(d, Object.assign({}, f)));
    if (d.mode === 'groups_ko') out = out.concat(koItems(d, knockoutFor(d, matches, groups), '淘汰赛 · '));
  } else out = koItems(d, bracketFor(d, matches), '');
  return out.map((x) => withRule(d, x));
}

function findFixture(d, matches, key) {
  return scheduleOf(d, matches).find((x) => x.key === key) || null;
}

// 改一场比分 / 登记退赛之前，看会影响哪些「已经有比分记录」的后续场次：
// 对比改动前后的赛程，对阵变了、或变成不能打的已录场次都算受影响（不会被静默覆盖）
function impactOf(dBefore, mBefore, dAfter, mAfter, exceptKey) {
  const after = {};
  scheduleOf(dAfter, mAfter).forEach((x) => { after[x.key] = x; });
  return scheduleOf(dBefore, mBefore).filter((x) => {
    if (x.key === exceptKey || !x.done || !x.recordId) return false;
    const y = after[x.key];
    return !y || !y.recordId || y.recordId !== x.recordId || y.a !== x.a || y.b !== x.b;
  }).map((x) => ({ key: x.key, stage: x.stage, a: x.a, b: x.b, score: x.score, recordId: x.recordId }));
}

// 列表页用：进度和冠军
function progressOf(d, matches) {
  const s = scheduleOf(d, matches);
  let champion = '';
  if (d.mode === 'groups_ko' && d.groups) champion = (knockoutFor(d, matches).champion || {}).name || '';
  else if (d.mode !== 'groups' && d.lines) champion = (bracketFor(d, matches).champion || {}).name || '';
  return { done: s.filter((x) => x.done).length, total: s.length, champion };
}

module.exports = {
  TEAM_SEP, cfgOf, formatText, teamLabel, membersOf, tsOf, dedupe, indexFor, flipSets, scoreText, resultFor,
  bracketFor, roundRobin, standings, groupsFor, scheduleOf, findFixture, progressOf,
  withdrawalsOf, outcomeText, impactOf, MODES, hasGroups, hasKo, normRule, ruleText, sameRule, koSize, koRounds, stageRules, ruleFor, rulesSummary, koLines, knockoutFor,
};
