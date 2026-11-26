// 场边「升降级冲场」双打引擎（纯本地工具，不建活动、不写数据库、不占主包，退出成员身份随 clearProtected 自动清理）
//   支持 4～16 人（1～4 片场），两种国内球局最常用的实时动态玩法：
//   1. mode = 'king'（冲 1 号场 · 升降级擂台）：
//      - 2～4 片场（1 号场为最高场）；每轮录完比分后，胜方升上一片场、负方降下一片场；
//      - 1 号场胜方守擂留在 1 号场，末号场负方留在末号场（有轮休球友时优先替补进末号场，末号场负方轮出）；
//      - 每片场新凑齐 4 人后强制拆开上一轮同队搭档，重新两两配对；若打平需选出金球胜方以保证各场恒为 4 人。
//   2. mode = 'points'（按分动态配对）：
//      - 每轮按当晚个人实时排行（胜场 → 净胜分 → 总得分）重新分场，高分聚 1 号场，同场尽量 1+4 对 2+3 且避开上轮同搭档。
const R = require('../../utils/rating');

const STORAGE_KEY = 'mixer_ladder_v1';

const MODES = [
  { id: 'king', label: '冲 1 号场', sub: '赢升上一片场、输降下一片场，每轮自动拆搭档' },
  { id: 'points', label: '按分动态配对', sub: '每轮按实时积分重分场地，同档位 1+4 对 2+3' },
];

const SCORE_PRESETS = [
  { id: 'g4', label: '4 局制', hint: '如 4:2' },
  { id: 'g6', label: '6 局制', hint: '如 6:4' },
  { id: 'p11', label: '抢 11 分', hint: '如 11:8' },
  { id: 'free', label: '限时计局', hint: '任意比分' },
];

const BADGE_CLS = {
  守擂: 'king',
  稳居1场: 'king',
  '↑ 升场': 'up',
  '↓ 降场': 'down',
  轮休上场: 'rest',
  留场: 'stay',
};

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function normRoster(raw) {
  const seen = Object.create(null);
  const out = [];
  (raw || []).forEach((p, i) => {
    if (!p || out.length >= 16) return;
    const id = String(p.id || p.uid || `p${i + 1}`);
    if (seen[id]) return;
    seen[id] = 1;
    out.push({
      id,
      uid: p.uid || (String(id).startsWith('q') ? '' : id),
      name: String(p.name || `${i + 1} 号球友`),
      lv: typeof p.level === 'number' && isFinite(p.level) ? p.level : R.DEFAULT_LEVEL,
    });
  });
  return out;
}

function splits4(ps) {
  const [a, b, c, d] = ps;
  return [
    [[a, b], [c, d]],
    [[a, c], [b, d]],
    [[a, d], [b, c]],
  ];
}

// 4 人场内配对：优先拆开上一轮同队搭档（avoidPairs），其次减少历史重复搭档，再看水平/排行均衡
function bestSplit4(four, partnerCnt, avoidPairs, balanceByRank) {
  const opts = splits4(four);
  let best = opts[0], bestCost = Infinity;
  opts.forEach((pair, idx) => {
    const [[a1, a2], [b1, b2]] = pair;
    const kA = pairKey(a1.id, a2.id), kB = pairKey(b1.id, b2.id);
    const sameLast = (avoidPairs[kA] ? 1 : 0) + (avoidPairs[kB] ? 1 : 0);
    const rep = (partnerCnt[kA] || 0) + (partnerCnt[kB] || 0);
    let bal = 0;
    if (balanceByRank) {
      // 传入顺序已按实力/积分从高到低排好：[0,3] vs [1,2]（即 1+4 对 2+3）最优
      const iA = four.indexOf(a1) + four.indexOf(a2);
      const iB = four.indexOf(b1) + four.indexOf(b2);
      bal = Math.abs(iA - iB) * 1.2 + (idx === 2 ? 0 : 0.3);
    } else {
      bal = Math.abs(((a1.lv + a2.lv) - (b1.lv + b2.lv)) / 2) * 3;
    }
    const cost = sameLast * 100 + rep * 6 + bal;
    if (cost < bestCost) { bestCost = cost; best = pair; }
  });
  return best;
}

function statsFromHistory(roster, history) {
  const byId = Object.create(null);
  const partnerCnt = Object.create(null);
  roster.forEach((p, idx) => {
    byId[p.id] = {
      id: p.id, uid: p.uid, name: p.name, lv: p.lv, lvText: R.fmt(p.lv), order: idx,
      played: 0, rest: 0, win: 0, lose: 0, tie: 0,
      pf: 0, pa: 0, diff: 0,
      topPlayed: 0, topWin: 0,
      lastCourt: 0, lastRested: false,
    };
  });
  (history || []).forEach((rd) => {
    const rested = Object.create(null);
    (rd.restIds || []).forEach((id) => {
      if (byId[id]) { byId[id].rest++; rested[id] = 1; }
    });
    roster.forEach((p) => { byId[p.id].lastRested = !!rested[p.id]; });
    (rd.matches || []).forEach((m) => {
      const sa = Number(m.scoreA), sb = Number(m.scoreB);
      const valid = Number.isFinite(sa) && Number.isFinite(sb) && sa >= 0 && sb >= 0;
      const pkA = pairKey(m.a[0], m.a[1]), pkB = pairKey(m.b[0], m.b[1]);
      partnerCnt[pkA] = (partnerCnt[pkA] || 0) + 1;
      partnerCnt[pkB] = (partnerCnt[pkB] || 0) + 1;
      const winSide = m.winner === 'a' || m.winner === 'b' ? m.winner : (sa > sb ? 'a' : sb > sa ? 'b' : 'tie');
      const applySide = (sideKey, ids, mine, opp) => {
        ids.forEach((id) => {
          const s = byId[id];
          if (!s) return;
          s.played++;
          s.lastCourt = m.court;
          if (m.court === 1) s.topPlayed++;
          if (valid) {
            s.pf += mine; s.pa += opp; s.diff = s.pf - s.pa;
            if (winSide === sideKey) { s.win++; if (m.court === 1) s.topWin++; }
            else if (winSide === 'tie') s.tie++;
            else s.lose++;
          }
        });
      };
      applySide('a', m.a, sa, sb);
      applySide('b', m.b, sb, sa);
    });
  });
  return { byId, partnerCnt };
}

function buildMatchObj(court, pair, badgeMap) {
  const [[a1, a2], [b1, b2]] = pair;
  const info = (p) => {
    const badge = (badgeMap && badgeMap[p.id]) || '';
    return { id: p.id, uid: p.uid, name: p.name, badge, badgeCls: BADGE_CLS[badge] || '' };
  };
  return {
    court,
    isTop: court === 1,
    a: [a1.id, a2.id],
    b: [b1.id, b2.id],
    aPlayers: [info(a1), info(a2)],
    bPlayers: [info(b1), info(b2)],
    aText: `${a1.name} / ${a2.name}`,
    bText: `${b1.name} / ${b2.name}`,
    scoreA: '',
    scoreB: '',
    tieBreak: '',
    needTieBreak: false,
  };
}

// 启动一场新的升降级冲场局，生成第 1 轮
function startSession(rawRoster, opts) {
  const roster = normRoster(rawRoster);
  if (roster.length < 4) return null;
  const o = opts || {};
  const courts = Math.max(1, Math.min(4, Math.floor(roster.length / 4)));
  const mode = o.mode === 'points' || courts === 1 ? 'points' : 'king';
  const preset = SCORE_PRESETS.some((x) => x.id === o.preset) ? o.preset : 'g4';

  // 首轮按水平分从高到低分场（同水平保留原顺序，避免「10 号球友」排到「2 号球友」前面），每场 1+4 vs 2+3 均衡起手
  const idxMap = Object.create(null);
  roster.forEach((p, i) => { idxMap[p.id] = i; });
  const sorted = roster.slice().sort((x, y) => y.lv - x.lv || idxMap[x.id] - idxMap[y.id]);
  const need = courts * 4;
  const onCourt = sorted.slice(0, need);
  const rest = sorted.slice(need);

  const matches = [];
  for (let c = 0; c < courts; c++) {
    const four = onCourt.slice(c * 4, c * 4 + 4);
    const pair = bestSplit4(four, {}, {}, true);
    matches.push(buildMatchObj(c + 1, pair, null));
  }

  return {
    v: 1,
    mode,
    preset,
    courts,
    startedAt: Date.now(),
    roster,
    history: [],
    current: {
      round: 1,
      matches,
      restIds: rest.map((p) => p.id),
      restNames: rest.map((p) => p.name),
      restText: rest.map((p) => p.name).join('、'),
    },
  };
}

function hasValidNums(m) {
  const a = String(m.scoreA === undefined || m.scoreA === null ? '' : m.scoreA).trim();
  const b = String(m.scoreB === undefined || m.scoreB === null ? '' : m.scoreB).trim();
  if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return false;
  return Number(a) >= 0 && Number(b) >= 0 && (Number(a) > 0 || Number(b) > 0);
}

function isMatchFilled(m, mode, courts) {
  if (!hasValidNums(m)) return false;
  if (mode === 'king' && courts >= 2 && Number(m.scoreA) === Number(m.scoreB)) {
    return m.tieBreak === 'a' || m.tieBreak === 'b';
  }
  return true;
}

function canAdvance(session) {
  if (!session || !session.current || !session.current.matches) return false;
  return session.current.matches.every((m) => isMatchFilled(m, session.mode, session.courts));
}

// 更新当前轮某片场的比分
function setScore(session, court, side, value) {
  if (!session || !session.current) return session;
  const clean = String(value === undefined || value === null ? '' : value).replace(/\D/g, '').slice(0, 2);
  const isKingMulti = session.mode === 'king' && session.courts >= 2;
  const matches = session.current.matches.map((m) => {
    if (m.court !== court) return m;
    const next = Object.assign({}, m, side === 'a' ? { scoreA: clean } : { scoreB: clean });
    const tied = isKingMulti && hasValidNums(next) && Number(next.scoreA) === Number(next.scoreB);
    next.needTieBreak = tied;
    if (!tied) next.tieBreak = '';
    return next;
  });
  return Object.assign({}, session, { current: Object.assign({}, session.current, { matches }) });
}

// 冲 1 号场打平时选定金球胜方（保证上下场地互换恒为 4 人）
function setTieBreak(session, court, side) {
  if (!session || !session.current) return session;
  const val = side === 'b' ? 'b' : 'a';
  const matches = session.current.matches.map((m) => (
    m.court === court && m.needTieBreak ? Object.assign({}, m, { tieBreak: val }) : m
  ));
  return Object.assign({}, session, { current: Object.assign({}, session.current, { matches }) });
}

// 结算当前轮并生成下一轮对阵
function advanceRound(session) {
  if (!session || !session.current) return { ok: false, msg: '当前没有进行中的冲场局' };
  const cur = session.current;
  const isKingMulti = session.mode === 'king' && session.courts >= 2;
  if (!cur.matches.every(hasValidNums)) return { ok: false, msg: '请先填完本轮全部场地的比分' };
  if (isKingMulti && cur.matches.some((m) => Number(m.scoreA) === Number(m.scoreB) && m.tieBreak !== 'a' && m.tieBreak !== 'b')) {
    return { ok: false, msg: '冲 1 号场有平局，请先点选金球胜方' };
  }

  const finished = Object.assign({}, cur, {
    matches: cur.matches.map((m) => {
      const sa = Number(m.scoreA), sb = Number(m.scoreB);
      const byTieBreak = isKingMulti && sa === sb;
      const winner = sa > sb ? 'a' : sb > sa ? 'b' : (byTieBreak ? m.tieBreak : 'tie');
      return Object.assign({}, m, {
        scoreA: sa,
        scoreB: sb,
        winner,
        byTieBreak,
        needTieBreak: false,
      });
    }),
  });
  const history = session.history.concat([finished]);
  const roster = session.roster;
  const byIdRaw = Object.create(null);
  roster.forEach((p) => { byIdRaw[p.id] = p; });
  const { byId, partnerCnt } = statsFromHistory(roster, history);

  // 记录上一轮全部同队搭档，下一轮在场内优先强制拆伙
  const avoidPairs = Object.create(null);
  finished.matches.forEach((m) => {
    avoidPairs[pairKey(m.a[0], m.a[1])] = 1;
    avoidPairs[pairKey(m.b[0], m.b[1])] = 1;
  });

  const courts = session.courts;
  const badgeMap = Object.create(null);
  let nextMatches = [];
  let nextRestIds = [];

  if (isKingMulti) {
    // 冲 1 号场升降级：每片场产生胜方 2 人（上移 1 场，1 号场留场守擂）和负方 2 人（下移 1 场，末号场留场）
    const buckets = Array.from({ length: courts }, () => []);
    const droppedToLast = Object.create(null);
    finished.matches.forEach((m) => {
      const cIdx = m.court - 1;
      const winSide = m.winner === 'b' ? m.b : m.a;
      const loseSide = m.winner === 'b' ? m.a : m.b;
      if (cIdx === 0) {
        winSide.forEach((id) => { buckets[0].push(id); badgeMap[id] = '守擂'; });
      } else {
        winSide.forEach((id) => { buckets[cIdx - 1].push(id); badgeMap[id] = '↑ 升场'; });
      }
      if (cIdx === courts - 1) {
        loseSide.forEach((id) => { buckets[courts - 1].push(id); badgeMap[id] = '留场'; });
      } else {
        loseSide.forEach((id) => {
          buckets[cIdx + 1].push(id);
          badgeMap[id] = '↓ 降场';
          if (cIdx + 1 === courts - 1) droppedToLast[id] = 1;
        });
      }
    });

    // 有轮休球友（如 9～15 人非 4 倍数）：上轮轮休者优先补进最末场，末场里出场最多者（同次数时末场负方先轮出、刚从上场降下者留打）轮休
    const prevRest = finished.restIds || [];
    if (prevRest.length) {
      const lastIdx = courts - 1;
      const pool = prevRest.concat(buckets[lastIdx]);
      const pickOrder = pool.slice().sort((a, b) => {
        const ra = prevRest.indexOf(a) >= 0 ? 0 : 1;
        const rb = prevRest.indexOf(b) >= 0 ? 0 : 1;
        if (ra !== rb) return ra - rb;
        const pa = byId[a].played, pb = byId[b].played;
        if (pa !== pb) return pa - pb;
        const da = droppedToLast[a] ? 0 : 1;
        const db = droppedToLast[b] ? 0 : 1;
        if (da !== db) return da - db;
        return byId[a].order - byId[b].order;
      });
      buckets[lastIdx] = pickOrder.slice(0, 4);
      nextRestIds = pickOrder.slice(4);
      prevRest.forEach((id) => { if (buckets[lastIdx].indexOf(id) >= 0) badgeMap[id] = '轮休上场'; });
    }

    nextMatches = buckets.map((ids, ci) => {
      const four = ids.map((id) => byIdRaw[id]).filter(Boolean);
      const pair = bestSplit4(four, partnerCnt, avoidPairs, false);
      return buildMatchObj(ci + 1, pair, badgeMap);
    });
  } else {
    // 按分动态配对：先挑出上场的 courts*4 人（已打少者 & 上轮轮休者优先），再按当晚实时积分分场，每场 1+4 vs 2+3 且避开上轮搭档
    const need = courts * 4;
    const prevRest = finished.restIds || [];
    const pickOrder = roster.slice().sort((x, y) => {
      const sx = byId[x.id], sy = byId[y.id];
      const dp = sx.played - sy.played;
      if (dp !== 0) return dp;
      const dr = (prevRest.indexOf(y.id) >= 0 ? 1 : 0) - (prevRest.indexOf(x.id) >= 0 ? 1 : 0);
      if (dr !== 0) return dr;
      return sy.win - sx.win || sy.diff - sx.diff || sy.pf - sx.pf || sx.order - sy.order;
    });
    const active = pickOrder.slice(0, need);
    nextRestIds = pickOrder.slice(need).map((p) => p.id);

    // 上场人员按实时表现从高到低分入 1 号场 → N 号场
    active.sort((x, y) => {
      const sx = byId[x.id], sy = byId[y.id];
      return sy.win - sx.win || sy.diff - sx.diff || sy.pf - sx.pf || y.lv - x.lv || sx.order - sy.order;
    });
    for (let ci = 0; ci < courts; ci++) {
      const four = active.slice(ci * 4, ci * 4 + 4);
      four.forEach((p) => {
        const prev = byId[p.id].lastCourt;
        if (prevRest.indexOf(p.id) >= 0) badgeMap[p.id] = '轮休上场';
        else if (prev && ci + 1 < prev) badgeMap[p.id] = '↑ 升场';
        else if (prev && ci + 1 > prev) badgeMap[p.id] = '↓ 降场';
        else if (ci === 0 && prev === 1) badgeMap[p.id] = '稳居1场';
      });
      const pair = bestSplit4(four, partnerCnt, avoidPairs, true);
      nextMatches.push(buildMatchObj(ci + 1, pair, badgeMap));
    }
  }

  const nextRestNames = nextRestIds.map((id) => (byIdRaw[id] ? byIdRaw[id].name : ''));
  const nextSession = Object.assign({}, session, {
    history,
    current: {
      round: cur.round + 1,
      matches: nextMatches,
      restIds: nextRestIds,
      restNames: nextRestNames,
      restText: nextRestNames.join('、'),
    },
  });
  return { ok: true, session: nextSession };
}

// 撤销上一轮结算，回到上一轮继续修改比分
function undoRound(session) {
  if (!session || !session.history || !session.history.length) return null;
  const last = session.history[session.history.length - 1];
  const isKingMulti = session.mode === 'king' && session.courts >= 2;
  const restored = Object.assign({}, last, {
    matches: last.matches.map((m) => {
      const sa = String(m.scoreA), sb = String(m.scoreB);
      const tied = isKingMulti && Number(sa) === Number(sb);
      return Object.assign({}, m, {
        scoreA: sa,
        scoreB: sb,
        tieBreak: tied && (m.winner === 'a' || m.winner === 'b') ? m.winner : '',
        needTieBreak: tied,
      });
    }),
  });
  return Object.assign({}, session, {
    history: session.history.slice(0, -1),
    current: restored,
  });
}

// 实时个人排行榜：胜场 → 净胜分 → 总得分 → 1 号场胜场
function standings(session) {
  if (!session || !session.roster) return [];
  const { byId } = statsFromHistory(session.roster, session.history || []);
  const curCourt = Object.create(null);
  if (session.current) {
    (session.current.matches || []).forEach((m) => {
      m.a.concat(m.b).forEach((id) => { curCourt[id] = m.court; });
    });
  }
  const rows = session.roster.map((p) => {
    const s = byId[p.id];
    const court = curCourt[p.id] || 0;
    const recordText = s.played
      ? `${s.win}胜${s.lose}负${s.tie ? `${s.tie}平` : ''}`
      : '待开打';
    return Object.assign({}, s, {
      curCourt: court,
      curCourtText: court ? `${court}号场` : '轮休',
      diffText: s.diff > 0 ? `+${s.diff}` : `${s.diff}`,
      diffCls: s.diff > 0 ? 'pos' : s.diff < 0 ? 'neg' : '',
      recordText,
    });
  });
  rows.sort((a, b) => (
    b.win - a.win
    || b.diff - a.diff
    || b.pf - a.pf
    || (session.mode === 'king' ? (b.topWin - a.topWin) : 0)
    || a.order - b.order
  ));
  return rows.map((r, i) => Object.assign({}, r, { rank: i + 1 }));
}

// nameOf（可选）：id → 外传名字（pkg-tools/utils/mask.js，没同意公开展示的写「球友」）；不传照常用名字
const sideText = (ids, text, nameOf) => (!nameOf ? text : Array.isArray(ids) ? ids.map(nameOf).join(' / ') : '球友');

function formatCurrentRound(session, nameOf) {
  if (!session || !session.current) return '';
  const cur = session.current;
  const modeLbl = session.mode === 'king' ? '冲 1 号场升降级' : '按分动态配对';
  const lines = [`【${modeLbl} · 第 ${cur.round} 轮对阵】`];
  cur.matches.forEach((m) => {
    const tag = m.court === 1 && session.courts > 1 ? '（主擂台）' : '';
    lines.push(`${m.court} 号场${tag}：${sideText(m.a, m.aText, nameOf)}  vs  ${sideText(m.b, m.bText, nameOf)}`);
  });
  const restText = !nameOf ? cur.restText : Array.isArray(cur.restIds) ? cur.restIds.map(nameOf).join('、') : (cur.restText ? '球友' : '');
  if (restText) lines.push(`本轮轮休：${restText}`);
  lines.push('（由 LULU 网球实时生成）');
  return lines.join('\n');
}

function formatFinalReport(session, nameOf) {
  if (!session) return '';
  const rows = standings(session);
  const doneRounds = (session.history || []).length;
  const modeLbl = session.mode === 'king' ? '冲 1 号场升降级' : '按分动态配对';
  const lines = [
    `【LULU 网球 · ${modeLbl}战报】`,
    `${session.roster.length} 人 · ${session.courts} 片场 · 已打 ${doneRounds} 轮`,
    '',
    '实时排行榜：',
  ];
  rows.forEach((r) => {
    const topStr = session.mode === 'king' && r.topWin > 0 ? ` · 1号场${r.topWin}胜` : '';
    lines.push(`${r.rank}. ${nameOf ? nameOf(r.id) : r.name} — ${r.recordText} · 净胜 ${r.diffText}（得分 ${r.pf}）${topStr}`);
  });
  if (doneRounds) {
    lines.push('', '各轮比分：');
    session.history.forEach((rd) => {
      const segs = rd.matches.map((m) => {
        const tb = m.byTieBreak ? '(金球)' : '';
        return `${m.court}场 ${sideText(m.a, m.aText, nameOf)} ${m.scoreA}:${m.scoreB}${tb} ${sideText(m.b, m.bText, nameOf)}`;
      });
      lines.push(`第 ${rd.round} 轮：${segs.join(' ｜ ')}`);
    });
  }
  return lines.join('\n');
}

function loadSaved() {
  try {
    const s = typeof wx !== 'undefined' && wx.getStorageSync ? wx.getStorageSync(STORAGE_KEY) : null;
    return s && s.v === 1 && Array.isArray(s.roster) && s.current ? s : null;
  } catch (e) { return null; }
}

function saveSession(session, asyncWrite) {
  try {
    if (typeof wx === 'undefined') return;
    if (!session) { if (wx.removeStorageSync) wx.removeStorageSync(STORAGE_KEY); }
    else if (asyncWrite && typeof wx.setStorage === 'function') wx.setStorage({ key: STORAGE_KEY, data: session, fail() {} });
    else if (wx.setStorageSync) wx.setStorageSync(STORAGE_KEY, session);
  } catch (e) {}
}

module.exports = {
  STORAGE_KEY,
  MODES,
  SCORE_PRESETS,
  startSession,
  canAdvance,
  setScore,
  setTieBreak,
  advanceRound,
  undoRound,
  standings,
  formatCurrentRound,
  formatFinalReport,
  loadSaved,
  saveSession,
};
