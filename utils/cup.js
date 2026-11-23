// LULU 积分（2026-11-23 用户给的海报规则）：比赛可能在其他平台打完，由管理员按最终名次补录一站，这里负责校验和结算。
//   共享文件（scripts/sync-shared.sh 复制到云函数）：前端预览和云函数发布用同一套计算；发布时以云端按球员资料算出的结果为准。
//   积分单独存在 cup_stops（仅管理端），不进正式战绩、水平分和排行口径。
//   只按海报明确列出的规则结算：每站一个名次档位只取一次；保底分只给管理员选进「参加保底」的；
//   女生夺冠奖励只在单打、按个人资料的性别（f）自动算，双打不加；
//   双打（2026-11-23 用户要求）：一队的名次分两人平分，记到个人（周赛保底 5 分平分后每人 2.5，保留小数不取整），双打年终榜按个人累计；
//   比赛形式只有单打、双打（海报上没有三人团队，2026-11-23 用户确认去掉）；
//   月赛没有保底分，也不加海报没列的奖励；首版只做赛后积分（没有让分、金球优势）。

const KINDS = [
  { value: 'weekly', label: '周赛' },
  { value: 'monthly', label: '月赛' },
  { value: 'encounter', label: '遭遇赛' },
];
const FORMATS = [
  { value: 'single', label: '单打', size: 1 },
  { value: 'double', label: '双打', size: 2 },
];
const TIERS = [
  { value: 'champion', label: '冠军' },
  { value: 'runnerUp', label: '亚军' },
  { value: 'semi', label: '四强' },
  { value: 'floor', label: '参加保底' },
];
// 海报：周赛 30 / 20 / 12 / 保底 5 / 女生夺冠 +10；月赛 60 / 40 / 24 / 无保底 / 女生夺冠 +20；遭遇赛 40 / 28 / 16 / 保底 6 / 无奖励
const POINTS = {
  weekly: { champion: 30, runnerUp: 20, semi: 12, floor: 5, femaleChampion: 10 },
  monthly: { champion: 60, runnerUp: 40, semi: 24, floor: null, femaleChampion: 20 },
  encounter: { champion: 40, runnerUp: 28, semi: 16, floor: 6, femaleChampion: 0 },
};
const MAX_SEMI = 2;
const MAX_FLOOR = 64;
// 年终榜：周赛、月赛按单打 / 双打分别累加（双打按个人：每站拿这一队名次分的一半，换了搭档也累计到同一个人）；遭遇赛单独统计（不进年终榜）
const BOARDS = [
  { value: 'single', label: '单打年终榜' },
  { value: 'double', label: '双打年终榜' },
  { value: 'encounter', label: '遭遇赛' },
];

const labelOf = (list, v) => (list.find((x) => x.value === v) || {}).label || '';
const kindText = (v) => labelOf(KINDS, v);
const formatText = (v) => labelOf(FORMATS, v);
const tierText = (v) => labelOf(TIERS, v);
const sizeOf = (format) => (FORMATS.find((x) => x.value === format) || {}).size || 0;
const hasFloor = (kind) => !!POINTS[kind] && POINTS[kind].floor !== null;
// 一队 / 一人：用户 ID 排序后拼起来，双打搭档交换录入顺序仍是同一队
const teamKey = (ids) => ids.slice().sort().join('|');
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ymd = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/**
 * 校验管理员录入的一站：stop = { date, kind, format, places: { champion, runnerUp, semis: [], floor: [] } }，
 * 每个名次是一组用户 ID（单打 1 位、双打 2 位）。today：今天（YYYY-MM-DD，只能补录已经结束的日期）。
 * 返回 { ok: true, rec } 或 { ok: false, error }；rec 里的每一队按用户 ID 排好序，多余字段丢掉
 */
function cleanStop(stop, today) {
  const s = stop || {};
  const bad = (error) => ({ ok: false, error });
  if (!ymd(s.date)) return bad('请选择比赛日期');
  if (today && s.date > today) return bad('只能补录已经结束的比赛日期');
  if (s.date < '2020-01-01') return bad('比赛日期不对');
  if (!POINTS[s.kind]) return bad('请选择周赛、月赛或遭遇赛');
  const f = FORMATS.find((x) => x.value === s.format);
  if (!f) return bad('请选择比赛形式');
  const p = s.places || {};
  const seen = {};
  const entry = (ids, what) => {
    if (!Array.isArray(ids) || ids.length !== f.size || !ids.every((x) => typeof x === 'string' && ID_RE.test(x))) {
      return { error: `${what}：${f.size === 1 ? '请选择 1 位球员' : '请选满 2 位球员（两人一队）'}` };
    }
    for (const id of ids) {
      if (seen[id]) return { error: '同一位球员在这一站只能出现一次' };
      seen[id] = 1;
    }
    return { ids: ids.slice().sort() };
  };
  const list = (v) => (v === undefined || v === null ? [] : v);
  if (!Array.isArray(list(p.semis)) || !Array.isArray(list(p.floor))) return bad('名次格式不对');
  if (list(p.semis).length > MAX_SEMI) return bad(`四强最多 ${MAX_SEMI} 个`);
  if (list(p.floor).length && !hasFloor(s.kind)) return bad(`${kindText(s.kind)}没有参加保底分`);
  if (list(p.floor).length > MAX_FLOOR) return bad(`参加保底最多 ${MAX_FLOOR} 个`);
  const c = entry(p.champion, '冠军');
  if (c.error) return bad(c.error);
  const r = entry(p.runnerUp, '亚军');
  if (r.error) return bad(r.error);
  const semis = [], floor = [];
  for (const x of list(p.semis)) { const e = entry(x, '四强'); if (e.error) return bad(e.error); semis.push(e.ids); }
  for (const x of list(p.floor)) { const e = entry(x, '参加保底'); if (e.error) return bad(e.error); floor.push(e.ids); }
  // 四强、参加保底不分先后：按队排好序，换了录入顺序也是同一份结果（重复发布不会被当成更正）
  const byKey = (x, y) => (teamKey(x) < teamKey(y) ? -1 : teamKey(x) > teamKey(y) ? 1 : 0);
  semis.sort(byKey); floor.sort(byKey);
  return {
    ok: true,
    rec: { date: s.date, year: Number(s.date.slice(0, 4)), kind: s.kind, format: s.format, places: { champion: c.ids, runnerUp: r.ids, semis, floor } },
  };
}

/**
 * 按名次结算一站：每个名次档位只取一次，返回每条记录的基础分、奖励分、合计。
 * 单打一个名次一条；双打一个名次两条：两人各一条，各拿这一队名次分的一半
 * （teamBase 是这一队的名次分，split = 2，team 是这一队的两个人）。
 * genderOf(用户 ID) → 'm' / 'f' / ''（个人资料里的性别）；女生夺冠奖励只在单打冠军
 */
function results(rec, genderOf) {
  const pt = POINTS[rec.kind];
  const out = [];
  const add = (tier, ids) => {
    const base = pt[tier];
    let bonus = 0, bonusText = '';
    if (tier === 'champion' && rec.format === 'single' && pt.femaleChampion && genderOf && genderOf(ids[0]) === 'f') {
      bonus = pt.femaleChampion; bonusText = '女生夺冠奖励';
    }
    if (rec.format === 'double') { // 两人平分（保留小数）
      const half = base / 2, team = ids.slice().sort();
      team.forEach((id) => out.push({ tier, ids: [id], key: id, team, teamBase: base, split: 2, base: half, bonus: 0, bonusText: '', total: half }));
      return;
    }
    out.push({ tier, ids: ids.slice(), key: teamKey(ids), base, bonus, bonusText, total: base + bonus });
  };
  const p = rec.places;
  add('champion', p.champion);
  add('runnerUp', p.runnerUp);
  (p.semis || []).forEach((ids) => add('semi', ids));
  if (hasFloor(rec.kind)) (p.floor || []).forEach((ids) => add('floor', ids));
  return out;
}

// 这一站进哪个榜：周赛 / 月赛按单打、双打分；遭遇赛单独
function boardOfStop(stop) {
  if (stop.kind === 'encounter') return 'encounter';
  return stop.format === 'single' || stop.format === 'double' ? stop.format : '';
}

/**
 * 年度榜：只算已发布的站（status === 'published'），按比赛实际日期归入年度；每站用发布时存下的结算结果（results），
 * 同一站重发 / 更正只是更新这一站，不会重复加分。返回 [{ key, ids, total, stops, champions, rank, sources: [...] }]，
 * 同分并列（名次相同），排序：总分 → 冠军次数 → 用户 ID（稳定）
 */
function board(stops, year, which) {
  const rows = {};
  (stops || []).forEach((s) => {
    if (!s || s.status !== 'published' || Number(s.year) !== Number(year) || boardOfStop(s) !== which) return;
    (s.results || []).forEach((r) => {
      const row = rows[r.key] || (rows[r.key] = { key: r.key, ids: r.ids.slice(), total: 0, stops: 0, champions: 0, sources: [] });
      row.total += r.total;
      row.stops += 1;
      if (r.tier === 'champion') row.champions += 1;
      row.sources.push({ stopId: s.id || s._id, date: s.date, kind: s.kind, format: s.format, tier: r.tier, base: r.base, bonus: r.bonus, bonusText: r.bonusText || '', total: r.total, team: r.team || null, teamBase: r.teamBase, split: r.split || 0 });
    });
  });
  const list = Object.keys(rows).map((k) => rows[k]);
  list.forEach((r) => r.sources.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)));
  list.sort((a, b) => b.total - a.total || b.champions - a.champions || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  list.forEach((r, i) => { r.rank = i && list[i - 1].total === r.total ? list[i - 1].rank : i + 1; });
  return list;
}

// 有已发布积分的年份（新的在前）
function years(stops) {
  const set = {};
  (stops || []).forEach((s) => { if (s && s.status === 'published' && s.year) set[s.year] = 1; });
  return Object.keys(set).map(Number).sort((a, b) => b - a);
}

// 一条积分的文字：「30」「30 + 10」，双打「30 ÷ 2」（两人平分）
const pointsText = (r) => (r.split ? `${r.teamBase} ÷ ${r.split}` : r.bonus ? `${r.base} + ${r.bonus}` : String(r.base));

module.exports = {
  KINDS, FORMATS, TIERS, POINTS, BOARDS, MAX_SEMI, MAX_FLOOR,
  kindText, formatText, tierText, sizeOf, hasFloor, teamKey, cleanStop, results, boardOfStop, board, years, pointsText,
};
