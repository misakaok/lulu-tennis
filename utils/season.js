// 赛季：按比赛日期的自然年划分（2026 赛季 = 2026-01-01 ～ 2026-12-31）。
// 只是在同一套正式战绩上按日期筛选，口径和生涯统计完全一样，不是第二套统计。
// 水平分不分赛季：始终用全部比赛连续计算。
const ALL = 'all';

const seasonOf = (m) => {
  const y = String((m && m.date) || '').slice(0, 4);
  return /^\d{4}$/.test(y) ? y : '';
};
const current = () => String(new Date().getFullYear());

// 有比赛的赛季，从新到旧；当前赛季总在里面
function seasonsIn(matches) {
  const set = { [current()]: 1 };
  (matches || []).forEach((m) => { const s = seasonOf(m); if (s) set[s] = 1; });
  return Object.keys(set).sort().reverse();
}

const inSeason = (matches, season) => (!season || season === ALL ? matches || [] : (matches || []).filter((m) => seasonOf(m) === season));
const label = (season) => (!season || season === ALL ? '生涯' : `${season} 赛季`);

module.exports = { ALL, seasonOf, current, seasonsIn, inSeason, label };
