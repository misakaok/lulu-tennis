// 成长档案 · 私人比赛记录（只有本人可见）：字段校验和统计，小程序端和云函数共用（scripts/sync-shared.sh）。
//   私人记录和正式战绩（utils/official.js）是两回事：不进排行、等级分、球员主页，也不和正式战绩相加。
//   比分用 utils/rules.js 的 checkMatch 校验，胜负由比分算出，不能单独填。
//   「备注」只能从 NOTE_TAGS 里选（个人主体不放自由文字），没有对手、地点之类的文字字段。
const R = require('./rules');

const TYPES = { single: '单打', double: '双打' };
const KINDS = { practice: '练习赛', formal: '正式比赛' };
const NOTE_TAGS = ['状态好', '发挥稳定', '发球好', '接发好', '底线稳', '网前好', '失误多', '体能不足', '心态波动', '天气影响', '换了球拍', '有伤在身'];
const MAX_TAGS = 5;
const MAX_RECORDS = 2000; // 每人最多保存的私人记录数（防滥用）
const MIN_DATE = '2000-01-01';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/**
 * 整理并校验一条私人比赛记录。input 来自小程序端，today 是今天（YYYY-MM-DD，云端按北京时间算）。
 * 只取认识的字段，其余一律丢掉。返回 { ok: true, rec } 或 { ok: false, msg }
 */
function clean(input, today) {
  const x = input && typeof input === 'object' ? input : {};
  if (!validDate(x.date)) return { ok: false, msg: '请选择比赛日期' };
  if (x.date < MIN_DATE) return { ok: false, msg: '比赛日期不对' };
  if (today && x.date > today) return { ok: false, msg: '比赛日期不能晚于今天' };
  if (!TYPES[x.type]) return { ok: false, msg: '请选择单打或双打' };
  if (!KINDS[x.kind]) return { ok: false, msg: '请选择练习赛或正式比赛' };
  const cfg = R.normCfg(x);
  const bestOf = x.bestOf === 1 ? 1 : 3;
  if (!Array.isArray(x.sets) || !x.sets.length || x.sets.length > 3) return { ok: false, msg: '请填写比分' };
  const raw = x.sets.map((s) => ({
    a: Number.isInteger(s && s.a) ? s.a : NaN, b: Number.isInteger(s && s.b) ? s.b : NaN,
    tbA: s && s.tbA, tbB: s && s.tbB,
  }));
  if (raw.some((s) => isNaN(s.a) || isNaN(s.b) || s.a < 0 || s.b < 0 || s.a > R.maxGames(cfg) || s.b > R.maxGames(cfg))) return { ok: false, msg: '比分不对' };
  const res = R.checkMatch(raw, bestOf, cfg);
  if (!res.ok) return { ok: false, msg: res.msg };
  const tags = Array.isArray(x.tags) ? x.tags : [];
  if (tags.some((t) => NOTE_TAGS.indexOf(t) < 0)) return { ok: false, msg: '备注只能从选项里选' };
  const uniq = NOTE_TAGS.filter((t) => tags.indexOf(t) >= 0); // 去重，并按固定顺序存
  if (uniq.length > MAX_TAGS) return { ok: false, msg: `备注最多选 ${MAX_TAGS} 个` };
  return {
    ok: true,
    rec: {
      date: x.date, type: x.type, kind: x.kind,
      setGames: cfg.setGames, noAd: cfg.noAd, bestOf,
      sets: res.sets, result: res.winner === 'a' ? 'win' : 'lose', tags: uniq,
    },
  };
}

const pct = (win, played) => (played ? Math.round((win / played) * 100) : 0);
const ymOf = (date) => String(date || '').slice(0, 7);
// 往前数 n 个月（含本月），返回 ['2026-06', …, '2026-11']
function lastMonths(today, n) {
  let y = Number(today.slice(0, 4)), m = Number(today.slice(5, 7));
  const out = [];
  for (let i = 0; i < n; i++) {
    out.unshift(`${y}-${m < 10 ? '0' + m : m}`);
    m--; if (!m) { m = 12; y--; }
  }
  return out;
}
const byDate = (x, y) => String(y.date).localeCompare(String(x.date)) || (y.createdAt || 0) - (x.createdAt || 0);

// 比分文字（我在前，写法和球员主页的战绩一样）：「4-2 4-3(7-5)」
function scoreText(rec) {
  return (rec.sets || []).map((s) => `${s.a}-${s.b}` + (typeof s.tbA === 'number' && typeof s.tbB === 'number' ? `(${s.tbA}-${s.tbB})` : '')).join(' ');
}

/**
 * 私人记录的统计（全部由记录实时计算，删改后马上跟着变）。records 是本人的全部私人记录
 */
function summary(records, today) {
  const list = (records || []).slice().sort(byDate);
  const tally = (rows) => { const win = rows.filter((r) => r.result === 'win').length; return { played: rows.length, win, lose: rows.length - win, rate: pct(win, rows.length) }; };
  const all = tally(list);
  const months = lastMonths(today, 6);
  const thisYm = months[5], lastYm = months[4];
  const inMonth = (ym) => list.filter((r) => ymOf(r.date) === ym);
  // 当前连胜 / 连败（从最近一场往回数）、最长连胜（按时间顺序）
  let cur = 0, curWin = null;
  for (const r of list) {
    const w = r.result === 'win';
    if (curWin === null) curWin = w;
    if (w !== curWin) break;
    cur++;
  }
  let best = 0, run = 0;
  list.slice().reverse().forEach((r) => { run = r.result === 'win' ? run + 1 : 0; if (run > best) best = run; });
  const trend = months.map((ym) => Object.assign({ ym, label: Number(ym.slice(5)) + '月' }, tally(inMonth(ym))));
  const peak = Math.max(1, ...trend.map((t) => t.played));
  trend.forEach((t) => { t.h = Math.round((t.played / peak) * 100); });
  return Object.assign(all, {
    single: tally(list.filter((r) => r.type === 'single')),
    double: tally(list.filter((r) => r.type === 'double')),
    practice: tally(list.filter((r) => r.kind === 'practice')),
    formal: tally(list.filter((r) => r.kind === 'formal')),
    thisMonth: tally(inMonth(thisYm)), lastMonth: tally(inMonth(lastYm)),
    streak: { n: cur, win: !!curWin }, bestStreak: best,
    recent: list.slice(0, 10).map((r) => (r.result === 'win' ? 'W' : 'L')),
    trend,
  });
}

module.exports = { TYPES, KINDS, NOTE_TAGS, MAX_TAGS, MAX_RECORDS, clean, summary, scoreText, lastMonths, validDate };
