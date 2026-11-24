// 场边记分器：逐分记分的纯逻辑（不依赖页面，tests/scorer.test.js 直接测）
// 状态只存「规则 + 每一分是谁赢的」（'a' / 'b' 组成的字符串），当前小分、局分、各盘都由 replay 从头推出来，
// 所以「撤销上一分」就是去掉最后一个字符，跨局、跨盘、撤销决定胜负的最后一分都不用特殊处理。
// 局、盘、抢七何时结束都交给 utils/rules.js（checkSet / checkTb / cleanSet / checkMatch），不在这里另写一套规则：
//   4 局制 3:3 抢七（赢成 4:3）；6 局制 6:6 抢七（赢成 7:6），也可以 7:5
//   金球：普通局 40:40 一分定局；抢七先到 7 分即赢（7:6 结束）
//   占先：普通局 40:40 后要净胜 2 分；抢七先到 7 分且净胜 2 分
// 完赛结果是原有的 { a, b, tbA?, tbB? } 结构，必须通过 rules.checkMatch，才能带到日常录分页（pages/add）。
// 本机草稿只有规则和得分顺序，不含球员姓名、用户 ID 等个人资料；退出成员身份时 utils/member.js 的 clearProtected 会清掉。
// 活动场次（从 pages/score 打开）：草稿多带一个 ev = { drawId, key }（只是活动和场次的编号，不是个人资料），规则用这一场的规则，
//   完赛后回到这一场的录分页预填局分，仍由本人核对后提交（recordEventMatch），这里不写正式战绩。
const R = require('./rules');

const DRAFT_KEY = 'scorer_draft';
const VERSION = 1;
const MAX_POINTS = 2000; // 防御：坏数据不至于让页面卡死（三盘两胜正常不到 400 分）
const CALLS = ['0', '15', '30', '40'];

function cfgOf(raw) {
  const c = R.normCfg(raw || {});
  return { setGames: c.setGames, noAd: c.noAd, bestOf: raw && Number(raw.bestOf) === 3 ? 3 : 1 };
}
const need = (cfg) => Math.floor(cfg.bestOf / 2) + 1;
const other = (s) => (s === 'a' ? 'b' : 'a');

// 普通局：这一分之后有没有人赢下这一局
function gameWinner(p, cfg) {
  const hi = p.a > p.b ? 'a' : 'b', lo = other(hi);
  if (p[hi] < 4) return '';
  if (cfg.noAd) return hi; // 金球：先到 4 分（3:3 时下一分定局）
  return p[hi] - p[lo] >= 2 ? hi : '';
}

// 抢七：用 rules.checkTb 判断（金球 7 分即赢，占先要净胜 2 分）
function tbWinner(p, cfg) {
  if (p.a === p.b) return '';
  const hi = p.a > p.b ? 'a' : 'b';
  return R.checkTb(p[hi], p[other(hi)], cfg) ? '' : hi;
}

// 从头推一遍：返回已完成的各盘、当前盘局分、当前局 / 抢七的小分、盘分、是否完赛
function replay(rawCfg, points) {
  const cfg = cfgOf(rawCfg);
  const T = R.tbAt(cfg);
  const st = { cfg, sets: [], games: { a: 0, b: 0 }, pts: { a: 0, b: 0 }, tb: false, won: { a: 0, b: 0 }, done: false, winner: '', used: 0 };
  const str = String(points || '');
  for (let i = 0; i < str.length && i < MAX_POINTS; i++) {
    const w = str[i];
    if ((w !== 'a' && w !== 'b') || st.done) break;
    st.used = i + 1;
    st.pts[w]++;
    let set = null;
    if (st.tb) {
      if (!tbWinner(st.pts, cfg)) continue;
      set = R.cleanSet({ a: T, b: T, tbA: st.pts.a, tbB: st.pts.b }, cfg); // 3:3 → 4:3（6 局制 6:6 → 7:6）
    } else {
      const gw = gameWinner(st.pts, cfg);
      if (!gw) continue;
      st.games[gw]++;
      st.pts = { a: 0, b: 0 };
      if (st.games.a === T && st.games.b === T) { st.tb = true; continue; }
      const g = { a: st.games.a, b: st.games.b };
      if (!R.checkSet(g, cfg).ok) continue; // 还没打完（含 6 局制的 6:5）
      set = g;
    }
    const r = R.checkSet(set, cfg);
    st.sets.push(set);
    st.won[r.winner]++;
    st.games = { a: 0, b: 0 }; st.pts = { a: 0, b: 0 }; st.tb = false;
    if (st.won[r.winner] === need(cfg)) { st.done = true; st.winner = r.winner; }
  }
  return st;
}

// 当前这一分的叫法：普通局 0/15/30/40、平分 / 占先 / 金球；抢七用数字
function callOf(st) {
  const p = st.pts;
  if (st.done) return { a: '', b: '', text: '' };
  if (st.tb) return { a: String(p.a), b: String(p.b), text: '抢七' };
  if (p.a >= 3 && p.b >= 3) {
    if (p.a === p.b) return { a: '40', b: '40', text: st.cfg.noAd ? '金球 · 这一分定局' : '平分' };
    const lead = p.a > p.b ? 'a' : 'b'; // 只会是占先制（金球制到这里局已经结束）
    return { a: lead === 'a' ? '占先' : '40', b: lead === 'b' ? '占先' : '40', text: (lead === 'a' ? 'A' : 'B') + ' 方占先' };
  }
  return { a: CALLS[p.a], b: CALLS[p.b], text: '' };
}

// 下一分如果是 side 赢，会不会拿下这一盘 / 整场（显示「盘点」「赛点」）
function pointFor(cfg, points, st, side) {
  if (st.done) return '';
  const nx = replay(cfg, points + side);
  if (nx.done) return '赛点';
  if (nx.sets.length > st.sets.length) return '盘点';
  return '';
}

function setText(s) {
  return `${s.a}-${s.b}` + (s.tbA !== undefined && s.tbB !== undefined ? `(${Math.min(s.tbA, s.tbB)})` : '');
}

// 完赛结果：原有的 { sets, winner, won }，并且一定能通过 rules.checkMatch；没打完返回 null
function resultOf(state) {
  if (!state) return null;
  const st = replay(state.cfg, state.points);
  if (!st.done) return null;
  const chk = R.checkMatch(st.sets, st.cfg.bestOf, st.cfg);
  if (!chk.ok) return null;
  return { setGames: st.cfg.setGames, noAd: st.cfg.noAd, bestOf: st.cfg.bestOf, sets: chk.sets, winner: chk.winner, won: chk.won };
}

// 日常录分页里自己固定在 A 方：记分时自己在 B 方，就把双方对调
function flipSets(sets) {
  return sets.map((s) => {
    const o = { a: s.b, b: s.a };
    if (s.tbA !== undefined) o.tbB = s.tbA;
    if (s.tbB !== undefined) o.tbA = s.tbB;
    return o;
  });
}
function handoff(state, side) {
  const r = resultOf(state);
  if (!r) return null;
  if (side !== 'b') return r;
  const sets = flipSets(r.sets);
  const chk = R.checkMatch(sets, r.bestOf, r);
  return Object.assign({}, r, { sets: chk.sets, winner: chk.winner, won: chk.won });
}

/* ---------- 状态：开始、加一分、撤销 ---------- */
// 场次编号和对阵版本：重排后同一编号可能换了球员，草稿必须跟着当时的版本。
function evOf(ev) {
  if (!ev || !/^[A-Za-z0-9_-]{1,64}$/.test(typeof ev.drawId === 'string' ? ev.drawId : '') ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(typeof ev.key === 'string' ? ev.key : '')) return null;
  const out = { drawId: ev.drawId, key: ev.key };
  if (ev.drawVersion !== undefined) {
    if (!Number.isSafeInteger(ev.drawVersion) || ev.drawVersion < 0) return null;
    out.drawVersion = ev.drawVersion;
  }
  return out;
}
const sameEv = (state, drawId, key, version) => !!(state && state.ev && state.ev.drawId === drawId && state.ev.key === key &&
  (version === undefined || (state.ev.drawVersion || 0) === version));
const sameCfg = (x, y) => { const a = cfgOf(x), b = cfgOf(y); return a.setGames === b.setGames && a.noAd === b.noAd && a.bestOf === b.bestOf; };

function start(cfg, now, ev) {
  const t = now || Date.now();
  const s = { v: VERSION, id: 'sc' + t.toString(36) + Math.floor(Math.random() * 1296).toString(36), cfg: cfgOf(cfg), points: '', createdAt: t, updatedAt: t };
  const e = evOf(ev);
  if (e) s.ev = e;
  return s;
}
// 完赛后锁住：再加分不生效（返回原状态）。撤销最后一分后可以继续
function addPoint(state, side, now) {
  if (!state || (side !== 'a' && side !== 'b')) return state;
  if (replay(state.cfg, state.points).done) return state;
  return Object.assign({}, state, { points: state.points + side, updatedAt: now || Date.now() });
}
function undo(state, now) {
  if (!state || !state.points) return state;
  return Object.assign({}, state, { points: state.points.slice(0, -1), updatedAt: now || Date.now() });
}

// 给页面用的视图：记分牌（各盘 + 本盘局分 + 本局小分）、叫分、盘点 / 赛点、完赛文字
function view(state) {
  const st = replay(state.cfg, state.points);
  const cfg = st.cfg;
  const call = callOf(st);
  const cols = st.sets.map((s, i) => ({ k: 's' + i, a: s.a, b: s.b, tbA: s.tbA, tbB: s.tbB, aw: s.a > s.b, bw: s.b > s.a, tbLo: s.tbA !== undefined ? Math.min(s.tbA, s.tbB) : '' }));
  if (!st.done) cols.push({ k: 'cur', a: st.games.a, b: st.games.b, cur: true });
  const res = st.done ? resultOf(state) : null;
  return {
    cfg,
    rulesText: `${cfg.setGames} 局制 · ${cfg.noAd ? '金球' : '占先'} · ${cfg.bestOf === 3 ? '三盘两胜' : '一盘'}`,
    tbText: `${R.tbAt(cfg)}:${R.tbAt(cfg)} 抢七 · ${cfg.noAd ? `先到 ${R.TB_TO} 分` : `先到 ${R.TB_TO} 分且净胜 2 分`}`,
    cols,
    setNo: st.sets.length + (st.done ? 0 : 1),
    tb: st.tb,
    callA: call.a, callB: call.b, callText: call.text,
    pointA: pointFor(cfg, state.points, st, 'a'), pointB: pointFor(cfg, state.points, st, 'b'),
    won: st.won,
    done: st.done, winner: st.winner,
    resultText: res ? `${res.winner === 'a' ? 'A' : 'B'} 方 ${Math.max(res.won.a, res.won.b)}:${Math.min(res.won.a, res.won.b)} 获胜` : '',
    setsText: (res ? res.sets : st.sets).map(setText).join('  '),
    count: state.points.length, canUndo: state.points.length > 0,
  };
}

/* ---------- 本机草稿 ---------- */
// 只认本模块写出的结构：规则合法、得分只有 a / b；完赛后多出来的分去掉
function restore(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== VERSION) return null;
  if (typeof raw.id !== 'string' || !/^sc[0-9a-z]{1,20}$/.test(raw.id)) return null;
  if (typeof raw.points !== 'string' || !/^[ab]*$/.test(raw.points) || raw.points.length > MAX_POINTS) return null;
  if (!raw.cfg || [4, 6].indexOf(raw.cfg.setGames) < 0 || typeof raw.cfg.noAd !== 'boolean' || [1, 3].indexOf(raw.cfg.bestOf) < 0) return null;
  const cfg = cfgOf(raw.cfg);
  const st = replay(cfg, raw.points);
  if (raw.ev !== undefined && !evOf(raw.ev)) return null;
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : 0);
  const out = { v: VERSION, id: raw.id, cfg, points: raw.points.slice(0, st.used), createdAt: num(raw.createdAt), updatedAt: num(raw.updatedAt) };
  if (raw.ev !== undefined) out.ev = evOf(raw.ev);
  return out;
}
function loadDraft() {
  try { return restore(wx.getStorageSync(DRAFT_KEY)); } catch (e) { return null; }
}
function saveDraft(state) {
  const d = { v: VERSION, id: state.id, cfg: state.cfg, points: state.points, createdAt: state.createdAt, updatedAt: state.updatedAt };
  const e = evOf(state.ev);
  if (e) d.ev = e;
  try { wx.setStorageSync(DRAFT_KEY, d); return true; } catch (err) { return false; }
}
// 只清掉指定的那一场（正式提交成功后）：期间又开了新的一场就不动
function clearDraft(id) {
  try {
    const d = loadDraft();
    if (!id || (d && d.id === id) || !d) wx.removeStorageSync(DRAFT_KEY);
  } catch (e) {}
}

// 活动场次完赛后「带入这一场录分」：记分页退回录分页前留个标记（只在内存里），录分页 onShow 取走后预填。
//   只认同一场（drawId + key），取一次就清掉，避免别的录分页误用
let pending = null;
function setPending(state) { pending = state && state.ev ? { id: state.id, drawId: state.ev.drawId, key: state.ev.key } : null; }
function takePending(drawId, key) {
  const p = pending;
  if (!p || p.drawId !== drawId || p.key !== key) return '';
  pending = null;
  return p.id;
}

// 日常比赛：从「记一场」页进来的，「带入日常录分」时退回那一页预填（不叠一层新的录分页），只在内存里带 id 和自己在哪一方
let dailyPending = null;
function setDailyPending(id, side) { dailyPending = id ? { id, side: side === 'b' ? 'b' : 'a' } : null; }
function takeDailyPending() { const p = dailyPending; dailyPending = null; return p; }

// 活动场次双方的名字：由录分页打开记分器时放在内存里（不写进草稿，草稿里没有姓名）；小程序重开后没有就显示 A 方 / B 方
const labels = {};
const evKey = (e) => e.drawId + '/' + e.key + '/' + (e.drawVersion || 0);
function setLabels(ev, l) {
  const e = evOf(ev);
  if (e && l) labels[evKey(e)] = { a: String(l.a || '').slice(0, 40), b: String(l.b || '').slice(0, 40), title: String(l.title || '').slice(0, 40) };
}
function labelsOf(ev) { const e = evOf(ev); return (e && labels[evKey(e)]) || null; }

module.exports = {
  DRAFT_KEY, cfgOf, replay, callOf, resultOf, flipSets, handoff, start, addPoint, undo, view, setText,
  restore, loadDraft, saveDraft, clearDraft, evOf, sameEv, sameCfg, setPending, takePending, setDailyPending, takeDailyPending, setLabels, labelsOf,
};
