// 4～8 人智能均衡双打排班器（纯本地工具，不建活动、不写数据库）
//   - 按当前水平分找两队平均水平最接近的组合（1 块场穷举 3 种分法；2 块场 8 人穷举全部 105 种分法）
//   - 多轮模式优先让每人上场次数最均衡、避免连着轮休、并尽量不重复搭档
const R = require('../../utils/rating');

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
// 确定性轻抖动：换一组方案（seed++）时能翻出不同的优质均衡组合
function jitter(seed, round, idx) {
  const x = Math.sin((seed + 1) * 97.3 + (round + 1) * 31.7 + idx * 13.1) * 10000;
  return (x - Math.floor(x)) * 0.08;
}

// 4 个人拆成 2v2 的全部 3 种分法
function splits4(ps) {
  const [a, b, c, d] = ps;
  return [
    [[a, b], [c, d]],
    [[a, c], [b, d]],
    [[a, d], [b, c]],
  ];
}

// 8 个人拆成 2 块场（每场 2v2）的全部 105 种无序分法
function splits8(ps) {
  const out = [];
  // 先挑 4 人去 1 号场（固定 ps[0] 在 1 号场避免两场互换重复：C(7,3) = 35）
  for (let i = 1; i < 8; i++) {
    for (let j = i + 1; j < 8; j++) {
      for (let k = j + 1; k < 8; k++) {
        const g1 = [ps[0], ps[i], ps[j], ps[k]];
        const g2 = ps.filter((_, idx) => idx !== 0 && idx !== i && idx !== j && idx !== k);
        const s1 = splits4(g1), s2 = splits4(g2);
        for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) out.push([s1[x], s2[y]]);
      }
    }
  }
  return out;
}

function matchCost(match, partnerCnt, oppCnt, seed, round, idx) {
  const [[a1, a2], [b1, b2]] = match;
  const ra = (a1.lv + a2.lv) / 2, rb = (b1.lv + b2.lv) / 2;
  const gap = Math.abs(ra - rb);
  const pRep = (partnerCnt[pairKey(a1.id, a2.id)] || 0) + (partnerCnt[pairKey(b1.id, b2.id)] || 0);
  const oRep = (oppCnt[pairKey(a1.id, b1.id)] || 0) + (oppCnt[pairKey(a1.id, b2.id)] || 0)
    + (oppCnt[pairKey(a2.id, b1.id)] || 0) + (oppCnt[pairKey(a2.id, b2.id)] || 0);
  return gap * 10 + pRep * 2.4 + oRep * 0.45 + jitter(seed, round, idx);
}

function balanceTag(gap) {
  if (gap < 0.18) return { text: '势均力敌', cls: 'lime' };
  if (gap < 0.45) return { text: '比较均衡', cls: 'solid' };
  return { text: '略有差距', cls: '' };
}

/**
 * 生成双打均衡排班
 * roster: [{ id, name, level }]（4～8 人）
 * opts: { rounds: 1..6, courts: 1|2, seed: 0.. }
 */
function schedule(rawRoster, opts) {
  const roster = (rawRoster || []).slice(0, 8).map((p, i) => ({
    id: String(p.id || 'p' + i),
    name: String(p.name || `${i + 1} 号`),
    lv: typeof p.level === 'number' && isFinite(p.level) ? p.level : R.DEFAULT_LEVEL,
  }));
  if (roster.length < 4) return null;
  const o = opts || {};
  const courts = o.courts === 2 && roster.length >= 8 ? 2 : 1;
  const roundCount = Math.max(1, Math.min(6, Math.floor(Number(o.rounds) || 4)));
  const seed = Number(o.seed) || 0;
  const need = courts * 4;

  const played = {}, rested = {}, partnerCnt = {}, oppCnt = {};
  let lastRest = {};
  roster.forEach((p) => { played[p.id] = 0; rested[p.id] = 0; });

  const rounds = [];
  for (let r = 0; r < roundCount; r++) {
    // 挑本轮上场的 need 人：先按已上场次数最少，其次上轮轮休过优先上场
    const ranked = roster.slice().sort((x, y) => {
      const dp = played[x.id] - played[y.id];
      if (dp !== 0) return dp;
      const dr = (lastRest[y.id] ? 1 : 0) - (lastRest[x.id] ? 1 : 0);
      if (dr !== 0) return dr;
      return jitter(seed, r, roster.indexOf(x)) - jitter(seed, r, roster.indexOf(y));
    });
    const onCourt = ranked.slice(0, need);
    const rest = ranked.slice(need);
    lastRest = {};
    rest.forEach((p) => { rested[p.id]++; lastRest[p.id] = 1; });

    let bestMatches = null, bestScore = Infinity;
    if (courts === 1) {
      splits4(onCourt).forEach((m, idx) => {
        const sc = matchCost(m, partnerCnt, oppCnt, seed, r, idx);
        if (sc < bestScore) { bestScore = sc; bestMatches = [m]; }
      });
    } else {
      splits8(onCourt).forEach((pair, idx) => {
        const sc = matchCost(pair[0], partnerCnt, oppCnt, seed, r, idx * 2)
          + matchCost(pair[1], partnerCnt, oppCnt, seed, r, idx * 2 + 1);
        if (sc < bestScore) { bestScore = sc; bestMatches = pair; }
      });
    }

    const matches = bestMatches.map(([[a1, a2], [b1, b2]], ci) => {
      [a1, a2, b1, b2].forEach((p) => { played[p.id]++; });
      const pkA = pairKey(a1.id, a2.id), pkB = pairKey(b1.id, b2.id);
      partnerCnt[pkA] = (partnerCnt[pkA] || 0) + 1;
      partnerCnt[pkB] = (partnerCnt[pkB] || 0) + 1;
      [[a1, b1], [a1, b2], [a2, b1], [a2, b2]].forEach(([x, y]) => {
        const ok = pairKey(x.id, y.id);
        oppCnt[ok] = (oppCnt[ok] || 0) + 1;
      });
      const ra = (a1.lv + a2.lv) / 2, rb = (b1.lv + b2.lv) / 2;
      const shareA = Math.round(R.expectedShare(ra, rb) * 100);
      const tag = balanceTag(Math.abs(ra - rb));
      return {
        court: ci + 1,
        a: `${a1.name} / ${a2.name}`,
        b: `${b1.name} / ${b2.name}`,
        aIds: [a1.id, a2.id],
        bIds: [b1.id, b2.id],
        aLv: R.fmt(ra), bLv: R.fmt(rb),
        shareA, shareB: 100 - shareA,
        tag: tag.text, tagCls: tag.cls,
      };
    });

    rounds.push({
      round: r + 1,
      matches,
      rest: rest.map((p) => p.name),
      restIds: rest.map((p) => p.id),
      restText: rest.map((p) => p.name).join('、'),
    });
  }

  const summary = roster.map((p) => ({ id: p.id, name: p.name, lv: R.fmt(p.lv), played: played[p.id], rest: rested[p.id] }));
  return { count: roster.length, courts, roundCount, rounds, summary };
}

/** 生成可复制到微信群的双打排班纯文本 */
// nameOf（可选）：id → 外传名字（pkg-tools/utils/mask.js，没同意公开展示的写「球友」）；不传照常用名字
function formatSchedule(res, nameOf) {
  if (!res || !res.rounds || !res.rounds.length) return '';
  const side = (ids, text) => (!nameOf ? text : Array.isArray(ids) ? ids.map(nameOf).join(' / ') : '球友');
  const lines = [`【双打均衡排班】${res.count} 人 · ${res.roundCount} 轮（${res.courts} 块场）`];
  res.rounds.forEach((r) => {
    if (r.matches.length === 1) {
      const m = r.matches[0];
      const restText = !nameOf ? r.restText : Array.isArray(r.restIds) ? r.restIds.map(nameOf).join('、') : (r.restText ? '球友' : '');
      lines.push(`第 ${r.round} 轮：${side(m.aIds, m.a)}  vs  ${side(m.bIds, m.b)}${restText ? `（轮休：${restText}）` : ''}`);
    } else {
      lines.push(`第 ${r.round} 轮：`);
      r.matches.forEach((m) => lines.push(`  ${m.court} 号场：${side(m.aIds, m.a)}  vs  ${side(m.bIds, m.b)}`));
    }
  });
  lines.push('上场统计：' + res.summary.map((s) => `${nameOf ? nameOf(s.id) : s.name} ${s.played}轮`).join('、'));
  lines.push('（由 LULU 网球按当前水平自动排班）');
  return lines.join('\n');
}

module.exports = { schedule, formatSchedule };
