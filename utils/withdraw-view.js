// 活动详情「退赛／弃权」筛选：只整理现有数据，不新增字段、不改赛果和积分规则。
//   参赛状态：draws.withdrawals（publicDraw 已去掉原因）里谁退赛了、在哪个阶段、按什么方式处理；
//   赛程影响：E.scheduleOf 算出的场次里弃权、中途退赛、成绩取消的那些（含退赛后判的弃权），以及按现有对阵表算出的「谁进入下一轮」。
//   不显示任何原因（原因只给本人和发起人，见 drawRequests），不新增任何字段。只在小程序端用（不进云函数）。
const E = require('./event');
const R = require('./rating');

const KINDS = { walkover: 1, retired: 1, void: 1 };
const affected = (x) => !!x && x.done && !!KINDS[x.outcome];
const POLICY = {
  walkover: '已打的场次保留，没打的场次判对手弃权胜；积分榜上排在最后，不参与名次',
  void: '取消 TA 的全部分组循环成绩（含已打的），这些场次不计入积分榜；积分榜上排在最后，不参与名次',
};

// 单淘汰的下一场：key 是「前缀 + 轮 - 场」（前缀 '' 或循环＋淘汰的 'k'），下一轮是 轮+1、场/2
function nextKey(key) {
  const m = /^(k?)(\d+)-(\d+)$/.exec(key || '');
  return m ? `${m[1]}${Number(m[2]) + 1}-${Math.floor(Number(m[3]) / 2)}` : '';
}

function impactOf(x, byKey) {
  const W = x.winner === 'a' ? x.a : x.b, L = x.winner === 'a' ? x.b : x.a;
  if (/^g/.test(x.key)) { // 分组循环：按积分榜现有算法（E.standings）
    if (x.outcome === 'void') return '这场成绩取消，不计入积分榜';
    if (x.outcome === 'walkover') return `积分榜上 ${W} 记胜、${L} 记负（弃权），不算盘分和局分`;
    return `积分榜上 ${W} 记胜，已打的局计入局分（没打完的那一盘不算盘分）`;
  }
  const nk = nextKey(x.key), next = nk && byKey[nk];
  if (!next) return `${W} 赢下最后一轮`;
  const opp = next.a === W ? (next.tbdB ? '' : next.b) : next.b === W ? (next.tbdA ? '' : next.a) : '';
  return `${W} 进入下一轮：${next.stage}${opp ? ` 对 ${opp}` : '，对手待定'}`;
}

// 成绩取消的场次：是哪一方退赛（被取消的那位）
function voidedName(x, wd) { return wd[x.a] && wd[x.a].policy === 'void' ? x.a : x.b; }

/**
 * d：活动（publicDraw 之后的）；items：活动详情 renderSchedule 整理后的场次（E.scheduleOf + mine 等）；
 * mineOf(entrant)：这个参加者是不是我（按用户 ID）。返回 { entrants, rows, count }
 */
function withdrawView(d, items, mineOf) {
  const wd = E.withdrawalsOf(d);
  const list = items || [];
  const byKey = {};
  list.forEach((x) => { byKey[x.key] = x; });
  const rows = list.filter(affected).map((x) => {
    const kind = x.outcome;
    const loser = kind === 'void' ? voidedName(x, wd) : x.winner === 'a' ? x.b : x.a;
    const byWd = kind === 'void' || !!(x.resolution && x.resolution.type === 'withdraw') || !!wd[loser];
    const status = kind === 'void' ? `${loser} 退赛，成绩取消` : kind === 'retired' ? `${loser} 中途退赛` : byWd ? `${loser} 退赛，判弃权` : `${loser} 弃权`;
    const u = R.unratedOf(kind);
    return {
      key: x.key, stage: x.stage, a: x.aText || x.a, b: x.bText || x.b, winner: kind === 'void' ? '' : x.winner,
      kind, status, impact: impactOf(x, byKey), unrated: u.title, mine: !!x.mine, ready: !!x.ready,
    };
  });
  const entrants = Object.keys(wd).map((name) => {
    const w = wd[name], ko = w.stage !== 'group';
    return {
      entrant: name, status: '已退赛', stage: ko ? '单淘汰阶段' : '分组循环阶段',
      policy: ko ? '下一场对手弃权胜，进入下一轮' : POLICY[w.policy] || POLICY.walkover,
      count: rows.filter((r) => r.a === name || r.b === name).length,
      mine: !!(mineOf && mineOf(name)),
    };
  });
  return { entrants, rows, count: entrants.length + rows.length };
}

module.exports = { withdrawView, nextKey };
