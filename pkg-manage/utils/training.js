// 成长档案 2.0 本地私人辅助模块（100% 本人私有、全固定选项、无自由文字输入、按 uid 隔离存储，退出成员身份随 clearProtected 自动清理）：
//   1. 结构化训练打卡（项目 + 时长 + 1~5 星完成度 + 可选固定复盘短板标签）
//   2. 按月赛后/训后高频短板 Top3（自动合并训练打卡短板 + 成长档案私人比赛负向标签）
//   3. 个人赛季目标进度条（纯数字档位：年度打球场次 / 年度训练时长 / 目标比赛等级）
const R = require('../../utils/rating');

const LOGS_KEY = 'growth_training_logs_v1';
const GOALS_KEY = 'growth_season_goals_v1';
const MAX_LOGS = 300;

const DRILLS = [
  { id: 'serve', label: '发球专项', short: '发球' },
  { id: 'rally', label: '底线多拍', short: '底线' },
  { id: 'return', label: '接发球', short: '接发' },
  { id: 'volley', label: '网前截击', short: '截击' },
  { id: 'footwork', label: '步法体能', short: '步法' },
];
const DRILL_MAP = Object.create(null);
DRILLS.forEach((d) => { DRILL_MAP[d.id] = d; });

const DURATIONS = [15, 30, 45, 60, 90, 120];
const RATINGS = [1, 2, 3, 4, 5];

// 固定复盘短板标签（含成长档案比赛里的负向备注标签，方便跨记录统一按月统计 Top3）
const WEAK_TAGS = [
  { tag: '一发掉速', drill: '发球专项' },
  { tag: '反手偏浅', drill: '底线多拍' },
  { tag: '关键分保守', drill: '模拟局分抗压' },
  { tag: '接发偏短', drill: '接发球' },
  { tag: '截击不稳', drill: '网前截击' },
  { tag: '移动偏慢', drill: '步法体能' },
  { tag: '失误多', drill: '底线多拍' },
  { tag: '体能不足', drill: '步法体能' },
  { tag: '心态波动', drill: '模拟局分抗压' },
];
const WEAK_SET = Object.create(null);
WEAK_TAGS.forEach((x) => { WEAK_SET[x.tag] = x.drill; });

const GOAL_MATCH_OPTS = [0, 20, 30, 50, 80, 100];
const GOAL_HOUR_OPTS = [0, 10, 20, 40, 60, 100];
const GOAL_LEVEL_OPTS = [0, 2.5, 3.0, 3.5, 4.0, 4.5];

const r1 = (n) => Math.round(n * 10) / 10;

function readBox(key) {
  try {
    const raw = typeof wx !== 'undefined' && wx.getStorageSync ? wx.getStorageSync(key) : null;
    return raw && typeof raw === 'object' ? raw : {};
  } catch (e) { return {}; }
}

function writeBox(key, obj) {
  try {
    if (typeof wx !== 'undefined' && wx.setStorageSync) wx.setStorageSync(key, obj);
  } catch (e) {}
}

function cleanLog(input, todayStr) {
  const x = input && typeof input === 'object' ? input : {};
  if (!DRILL_MAP[x.drill]) return { ok: false, msg: '请选择训练项目' };
  const mins = Number(x.minutes);
  if (!Number.isInteger(mins) || mins < 5 || mins > 300) return { ok: false, msg: '请选择训练时长' };
  const score = Number(x.score);
  if (!Number.isInteger(score) || score < 1 || score > 5) return { ok: false, msg: '请选择完成度' };
  const date = typeof x.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? x.date : (todayStr || '');
  if (!date || (todayStr && date > todayStr)) return { ok: false, msg: '训练日期不对' };
  const rawTags = Array.isArray(x.weakTags) ? x.weakTags : [];
  const weakTags = WEAK_TAGS.map((w) => w.tag).filter((t) => rawTags.indexOf(t) >= 0).slice(0, 3);
  return {
    ok: true,
    rec: {
      id: x.id || `tr_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
      date,
      drill: x.drill,
      minutes: mins,
      score,
      weakTags,
      createdAt: x.createdAt || Date.now(),
    },
  };
}

function loadLogs(uid) {
  if (!uid) return [];
  const box = readBox(LOGS_KEY);
  const arr = Array.isArray(box[uid]) ? box[uid] : [];
  return arr.slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || (b.createdAt || 0) - (a.createdAt || 0));
}

function addLog(uid, input, todayStr) {
  if (!uid) return { ok: false, msg: '账号未就绪' };
  const c = cleanLog(input, todayStr);
  if (!c.ok) return c;
  const box = readBox(LOGS_KEY);
  const arr = Array.isArray(box[uid]) ? box[uid].slice() : [];
  arr.unshift(c.rec);
  box[uid] = arr.slice(0, MAX_LOGS);
  writeBox(LOGS_KEY, box);
  return { ok: true, rec: c.rec, list: loadLogs(uid) };
}

function removeLog(uid, id) {
  if (!uid || !id) return [];
  const box = readBox(LOGS_KEY);
  const arr = (Array.isArray(box[uid]) ? box[uid] : []).filter((x) => x && x.id !== id);
  box[uid] = arr;
  writeBox(LOGS_KEY, box);
  return loadLogs(uid);
}

function loadGoals(uid, year) {
  const y = String(year || new Date().getFullYear());
  if (!uid) return { year: y, matches: 0, hours: 0, level: 0 };
  const box = readBox(GOALS_KEY);
  const g = box[`${uid}:${y}`];
  return {
    year: y,
    matches: g && GOAL_MATCH_OPTS.indexOf(Number(g.matches)) >= 0 ? Number(g.matches) : 0,
    hours: g && GOAL_HOUR_OPTS.indexOf(Number(g.hours)) >= 0 ? Number(g.hours) : 0,
    level: g && GOAL_LEVEL_OPTS.indexOf(Number(g.level)) >= 0 ? Number(g.level) : 0,
  };
}

function saveGoals(uid, year, input) {
  const y = String(year || new Date().getFullYear());
  if (!uid) return loadGoals('', y);
  const x = input || {};
  const rec = {
    year: y,
    matches: GOAL_MATCH_OPTS.indexOf(Number(x.matches)) >= 0 ? Number(x.matches) : 0,
    hours: GOAL_HOUR_OPTS.indexOf(Number(x.hours)) >= 0 ? Number(x.hours) : 0,
    level: GOAL_LEVEL_OPTS.indexOf(Number(x.level)) >= 0 ? Number(x.level) : 0,
  };
  const box = readBox(GOALS_KEY);
  box[`${uid}:${y}`] = rec;
  writeBox(GOALS_KEY, box);
  return rec;
}

/* ---------- 汇总统计：训练打卡摘要 + 按月高频短板 Top3 + 个人赛季目标进度 ---------- */
function trainingSummary(logs, todayStr) {
  const list = (logs || []).slice().sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || (b.createdAt || 0) - (a.createdAt || 0));
  const ym = String(todayStr || '').slice(0, 7);
  const year = String(todayStr || '').slice(0, 4);
  let monthCount = 0, monthMin = 0, yearMin = 0, totalMin = 0;
  const drillCnt = Object.create(null);

  list.forEach((l) => {
    const mins = Number(l.minutes) || 0;
    totalMin += mins;
    if (ym && String(l.date || '').slice(0, 7) === ym) { monthCount++; monthMin += mins; }
    if (year && String(l.date || '').slice(0, 4) === year) yearMin += mins;
    if (DRILL_MAP[l.drill]) drillCnt[l.drill] = (drillCnt[l.drill] || 0) + 1;
  });

  const topDrillId = Object.keys(drillCnt).sort((a, b) => drillCnt[b] - drillCnt[a])[0] || '';
  const recent = list.slice(0, 6).map((l) => ({
    id: l.id,
    date: l.date,
    md: String(l.date || '').slice(5).replace('-', '/'),
    drillLabel: (DRILL_MAP[l.drill] && DRILL_MAP[l.drill].label) || '专项训练',
    minutes: l.minutes,
    stars: '★'.repeat(l.score || 3) + '☆'.repeat(5 - (l.score || 3)),
    weakTags: l.weakTags || [],
  }));

  return {
    totalCount: list.length,
    totalHours: r1(totalMin / 60),
    monthCount,
    monthHours: r1(monthMin / 60),
    yearMin,
    yearHours: r1(yearMin / 60),
    topDrill: topDrillId ? DRILL_MAP[topDrillId].label : '',
    recent,
  };
}

function weaknessTop3(growthMatches, trainingLogs, targetYm) {
  const monthsSet = Object.create(null);
  const ym = targetYm || '';
  if (ym) monthsSet[ym] = 1;
  (growthMatches || []).forEach((m) => { if (m && m.date) monthsSet[String(m.date).slice(0, 7)] = 1; });
  (trainingLogs || []).forEach((l) => { if (l && l.date) monthsSet[String(l.date).slice(0, 7)] = 1; });
  const months = Object.keys(monthsSet).filter((k) => /^\d{4}-\d{2}$/.test(k)).sort().reverse().slice(0, 6);
  const activeYm = months.indexOf(ym) >= 0 ? ym : (months[0] || ym);

  const count = Object.create(null);
  let totalHits = 0;
  const hit = (t) => {
    if (!WEAK_SET[t]) return;
    count[t] = (count[t] || 0) + 1;
    totalHits++;
  };

  (growthMatches || []).forEach((m) => {
    if (!m || !m.date || (activeYm && String(m.date).slice(0, 7) !== activeYm)) return;
    (m.tags || []).forEach(hit);
  });
  (trainingLogs || []).forEach((l) => {
    if (!l || !l.date || (activeYm && String(l.date).slice(0, 7) !== activeYm)) return;
    (l.weakTags || []).forEach(hit);
  });

  const sorted = Object.keys(count)
    .map((tag) => ({
      tag,
      count: count[tag],
      pct: totalHits ? Math.round((count[tag] / totalHits) * 100) : 0,
      drill: WEAK_SET[tag] || '专项练习',
    }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));

  return {
    ym: activeYm,
    ymLabel: activeYm ? `${activeYm.slice(0, 4)} 年 ${Number(activeYm.slice(5))} 月` : '本月',
    months: months.map((k) => ({ ym: k, label: `${Number(k.slice(5))}月` })),
    totalHits,
    top3: sorted.slice(0, 3),
  };
}

function goalsProgress(goals, stats) {
  const g = goals || { year: String(new Date().getFullYear()), matches: 0, hours: 0, level: 0 };
  const s = stats || {};
  const yearMatches = Number(s.yearMatches) || 0;
  const yearHours = r1((Number(s.yearTrainingMin) || 0) / 60);
  const curLevel = typeof s.currentLevel === 'number' && isFinite(s.currentLevel) ? s.currentLevel : null;
  const items = [];

  if (g.matches > 0) {
    const pct = Math.min(100, Math.round((yearMatches / g.matches) * 100));
    const left = Math.max(0, g.matches - yearMatches);
    items.push({
      k: 'matches',
      label: `年度打球 ${g.matches} 场`,
      valText: `${yearMatches} / ${g.matches} 场`,
      pct,
      done: yearMatches >= g.matches,
      sub: left === 0 ? '年度目标已达成 ✓' : `还差 ${left} 场（含正式与私人记录）`,
    });
  }
  if (g.hours > 0) {
    const pct = Math.min(100, Math.round((yearHours / g.hours) * 100));
    const left = r1(Math.max(0, g.hours - yearHours));
    items.push({
      k: 'hours',
      label: `年度训练 ${g.hours} 小时`,
      valText: `${yearHours} / ${g.hours} h`,
      pct,
      done: yearHours >= g.hours,
      sub: left === 0 ? '训练目标已达成 ✓' : `还差 ${left} 小时`,
    });
  }
  if (g.level > 0) {
    const targetText = R.fmt(g.level);
    const curText = curLevel !== null ? R.fmt(curLevel) : '待定级';
    const done = curLevel !== null && Number(R.fmt(curLevel)) >= g.level;
    // 进度条以 1.5 为起点映射到目标等级
    const pct = curLevel === null ? 0 : (done ? 100 : Math.max(8, Math.min(96, Math.round(((curLevel - 1.5) / Math.max(0.5, g.level - 1.5)) * 100))));
    items.push({
      k: 'level',
      label: `冲刺比赛等级 ${targetText}`,
      valText: `${curText} → ${targetText}`,
      pct,
      done,
      sub: curLevel === null ? '完成正式比赛后显示当前比赛等级' : (done ? '已达到目标档位 ✓' : '继续保持状态向目标档位迈进'),
    });
  }

  return { year: g.year, has: items.length > 0, goals: g, items };
}

module.exports = {
  DRILLS,
  DURATIONS,
  RATINGS,
  WEAK_TAGS,
  GOAL_MATCH_OPTS,
  GOAL_HOUR_OPTS,
  GOAL_LEVEL_OPTS,
  cleanLog,
  loadLogs,
  addLog,
  removeLog,
  loadGoals,
  saveGoals,
  trainingSummary,
  weaknessTop3,
  goalsProgress,
};
