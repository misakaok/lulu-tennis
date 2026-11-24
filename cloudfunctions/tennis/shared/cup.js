// LULU 积分（2026-11-23 用户给的海报规则）：比赛可能在其他平台打完，由管理员按最终名次补录一站，这里负责校验和结算。
//   共享文件（scripts/sync-shared.sh 复制到云函数）：前端预览和云函数发布用同一套计算；发布时以云端按球员资料算出的结果为准。
//   积分单独存在 cup_stops（仅管理端），不进正式战绩、水平分和排行口径。
//   每站只取一个名次档位，最新规则按组别和活动类别加分。
//   双打（2026-11-23 用户要求）：一队的名次分两人平分，记到个人（周赛保底 5 分平分后每人 2.5，保留小数不取整），双打年终榜按个人累计；
//   比赛形式只有单打、双打（海报上没有三人团队，2026-11-23 用户确认去掉）；
//   已有站和遭遇赛沿用原积分规则；这里只做赛后积分。

const KINDS = [
  { value: 'weekly', label: '周赛' },
  { value: 'monthly', label: '月赛' },
  { value: 'quarterly', label: '季度赛' },
  { value: 'halfYear', label: '半年赛' },
  { value: 'yearFinal', label: '年终总决赛' },
  { value: 'encounter', label: '遭遇赛' },
];
const ACTIVE_KINDS = KINDS.filter((k) => k.value !== 'encounter');
const SCORE_VERSION = 2;
const EVENT_BONUS = { quarterly: 2, halfYear: 5, yearFinal: 10 };
const eventBonusOf = (kind) => Number.isInteger(EVENT_BONUS[kind]) ? EVENT_BONUS[kind] : 0;
const kindsForVersion = (version) => version === SCORE_VERSION ? ACTIVE_KINDS : KINDS.filter((k) => !eventBonusOf(k.value));
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
const STANDARD_POINTS = { champion: 10, runnerUp: 8, semi: 6, floor: 4 };
const CURRENT_POINTS = { champion: 10, runnerUp: 8, semi: 6, floor: 2 };
const POINT_GROUPS = [
  { value: 'open', label: '不分组' },
  { value: '3.0', label: '3.0 组' },
  { value: '3.5', label: '3.5 组' },
];
const GROUP_BONUS = { '3.0': 5, '3.5': STANDARD_POINTS.champion };
const WOMEN_35_BONUS = { champion: 5, runnerUp: 3, semi: 1 };
const MAX_SEMI = 2;
const MAX_FLOOR = 64;
// 年终榜按单打、双打分开，每人各取最高组；历史遭遇赛单独统计。
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
const usesPointGroup = (kind) => !!labelOf(ACTIVE_KINDS, kind);
const pointGroupText = (v) => labelOf(POINT_GROUPS, v);
const pointGroupOf = (kind, group) => usesPointGroup(kind) && pointGroupText(group) ? group : '';
// 这一站按现行规则（scoreVersion 2）算：现行类别且标了现行版本；季度 / 半年 / 年终只有现行规则
const isCurrent = (kind, scoreVersion) => (usesPointGroup(kind) && scoreVersion === SCORE_VERSION) || eventBonusOf(kind) > 0;
// 已发布的站保存规则版本和结果，更正时仍使用对应的计分表。
function pointsOf(kind, group, scoreVersion) {
  if (isCurrent(kind, scoreVersion)) return CURRENT_POINTS;
  return pointGroupOf(kind, group) ? Object.assign({}, STANDARD_POINTS, { femaleChampion: GROUP_BONUS[group] || 0 }) : POINTS[kind];
}
const hasFloor = (kind, group, scoreVersion) => {
  const points = pointsOf(kind, group, scoreVersion);
  return !!points && points.floor !== null;
};
const stopKindText = (s) => [kindText(s.kind), s.pointGroup !== 'open' && pointGroupText(s.pointGroup)].filter(Boolean).join(' · ');
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
  if (!kindText(s.kind)) return bad('请选择有效积分类别');
  const scoreVersion = isCurrent(s.kind, s.scoreVersion) ? SCORE_VERSION : 0;
  const pointGroup = pointGroupOf(s.kind, s.pointGroup);
  if (s.pointGroup && !pointGroup) return bad('积分组别不正确');
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
  if (list(p.floor).length && !hasFloor(s.kind, pointGroup, scoreVersion)) return bad(`${kindText(s.kind)}没有参加保底分`);
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
    rec: Object.assign({ date: s.date, year: Number(s.date.slice(0, 4)), kind: s.kind, format: s.format, places: { champion: c.ids, runnerUp: r.ids, semis, floor } },
      scoreVersion ? { scoreVersion, pointGroup: pointGroup || 'open' } : pointGroup ? { pointGroup } : {}),
  };
}

/**
 * 按名次结算一站：每个名次档位只取一次，返回每条记录的基础分、奖励分、合计。
 * 单打一个名次一条；双打一个名次两条：两人各一条，各拿这一队名次分的一半
 * （teamBase 是这一队的名次分，split = 2，team 是这一队的两个人）。
 * genderOf(用户 ID) → 'm' / 'f' / ''；女生名次奖励只在单打，活动加分在双打平分基础分后给到每个人。
 */
function results(rec, genderOf) {
  const pt = pointsOf(rec.kind, rec.pointGroup, rec.scoreVersion);
  const current = isCurrent(rec.kind, rec.scoreVersion);
  const eventBonus = current ? eventBonusOf(rec.kind) : 0;
  const eventBonusText = eventBonus ? `${kindText(rec.kind)}加分 +${eventBonus}` : '';
  const out = [];
  const add = (tier, ids) => {
    const base = pt[tier];
    if (rec.format === 'double') { // 两人平分（保留小数），女生名次奖励只在单打
      const half = base / 2, team = ids.slice().sort();
      team.forEach((id) => out.push({ tier, ids: [id], key: id, team, teamBase: base, split: 2, base: half, bonus: eventBonus, bonusText: eventBonusText, total: half + eventBonus }));
      return;
    }
    let womenBonus = 0, womenBonusText = '';
    if (genderOf && genderOf(ids[0]) === 'f') {
      if (current && rec.pointGroup === '3.5' && WOMEN_35_BONUS[tier]) {
        womenBonus = WOMEN_35_BONUS[tier];
        womenBonusText = `3.5 组女生名次奖励 +${womenBonus}`;
      } else if (!current && tier === 'champion' && pt.femaleChampion) {
        womenBonus = pt.femaleChampion;
        womenBonusText = rec.pointGroup ? `${pointGroupText(rec.pointGroup)}女生夺冠奖励` : '女生夺冠奖励';
      }
    }
    const bonus = womenBonus + eventBonus;
    const bonusText = [womenBonusText, eventBonusText].filter(Boolean).join(' · ');
    out.push({ tier, ids: ids.slice(), key: teamKey(ids), base, bonus, bonusText, total: base + bonus });
  };
  const p = rec.places;
  add('champion', p.champion);
  add('runnerUp', p.runnerUp);
  (p.semis || []).forEach((ids) => add('semi', ids));
  if (pt.floor !== null) (p.floor || []).forEach((ids) => add('floor', ids));
  return out;
}

// 这一站进哪个榜：现行活动按单双打分；历史遭遇赛单独。
function boardOfStop(stop) {
  if (stop.kind === 'encounter') return 'encounter';
  return stop.format === 'single' || stop.format === 'double' ? stop.format : '';
}

/**
 * 年度榜：只算已发布的站（status === 'published'），按比赛实际日期归入年度；每站用发布时存下的结算结果（results），
 * 同一站重发 / 更正只是更新这一站，不会重复加分。每个账号取累计最高的组，groups 保留全部组的个人明细。
 * 同分并列（名次相同），排序：总分 → 冠军次数 → 用户 ID（稳定）
 */
function board(stops, year, which) {
  const players = Object.create(null);
  (stops || []).forEach((s) => {
    if (!s || s.deleted || s.status !== 'published' || Number(s.year) !== Number(year) || boardOfStop(s) !== which) return;
    const pointGroup = pointGroupOf(s.kind, s.pointGroup) || 'open';
    (s.results || []).forEach((r) => {
      const groups = players[r.key] || (players[r.key] = {});
      const row = groups[pointGroup] || (groups[pointGroup] = { key: r.key, ids: r.ids.slice(), pointGroup, total: 0, stops: 0, champions: 0, sources: [] });
      row.total += r.total;
      row.stops += 1;
      if (r.tier === 'champion') row.champions += 1;
      row.sources.push({ stopId: s.id || s._id, date: s.date, kind: s.kind, pointGroup: s.pointGroup, format: s.format, tier: r.tier, base: r.base, bonus: r.bonus, bonusText: r.bonusText || '', total: r.total, team: r.team || null, teamBase: r.teamBase, split: r.split || 0 });
    });
  });
  const list = Object.values(players).map((byGroup) => {
    const groups = Object.values(byGroup);
    groups.forEach((g) => g.sources.sort((a, b) => b.date.localeCompare(a.date)));
    groups.sort((a, b) => b.total - a.total || b.champions - a.champions || a.pointGroup.localeCompare(b.pointGroup));
    return Object.assign({}, groups[0], { groups });
  });
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

/**
 * 我的积分（「我的」页卡片和个人明细，2026-11-23 用户要求）：stops 是 cupList 的结果——自己的用户 ID 不会被换成匿名编号
 * （没开公开展示也一样），所以直接按当前账号的用户 ID 认自己的记录，不从公开榜单的名字反查。
 * 和年度榜同一套累计，只取自己那一行；groups 里保留各组的总分和来源。
 * 返回 { single, double, encounter }，每项 { total, stops, champions, sources }（sources 新的在前，同 board）
 */
function mine(stops, uid, year) {
  const out = {};
  BOARDS.forEach((b) => {
    const r = uid ? board(stops, year, b.value).find((x) => x.key === uid) : null;
    out[b.value] = r || { total: 0, stops: 0, champions: 0, sources: [], groups: [] };
  });
  return out;
}
// 我拿过积分的年份（已发布的站，新的在前）
function myYears(stops, uid) {
  const set = {};
  (stops || []).forEach((s) => {
    if (s && s.status === 'published' && s.year && (s.results || []).some((r) => r.ids.indexOf(uid) >= 0)) set[s.year] = 1;
  });
  return Object.keys(set).map(Number).sort((a, b) => b - a);
}
// 我最近一站（已发布，按比赛日期）：{ stopId, date, year, kind, format, board, tier, base, bonus, bonusText, total, team, teamBase, split }；没有返回 null
function latestOf(stops, uid) {
  let best = null;
  (stops || []).forEach((s) => {
    if (!s || s.status !== 'published' || !uid) return;
    const r = (s.results || []).find((x) => x.ids.indexOf(uid) >= 0);
    if (!r || (best && best.date >= s.date)) return;
    best = { stopId: s.id || s._id, date: s.date, year: Number(s.year), kind: s.kind, pointGroup: s.pointGroup, format: s.format, board: boardOfStop(s), tier: r.tier, base: r.base, bonus: r.bonus, bonusText: r.bonusText || '', total: r.total, team: r.team || null, teamBase: r.teamBase, split: r.split || 0 };
  });
  return best;
}

/* ---------- 积分活动（2026-11-23 用户要求：创建 LULU 积分活动 → 完赛后结算） ---------- */
// draws.cup = { kind, pointGroup? }：管理员创建活动时设定，组别在活动发布后固定。
// 所有积分类别（含周赛、月赛，2026-11-24 用户要求放开）都由管理员选形式：循环＋淘汰（各组前几名进入淘汰阶段）或单淘汰（签数按实际人数选），
// 要有最后一轮，名次才能从对阵推出来；只有分组循环、四人轮换不行。创建、报名中改规则、更正积分类别都用 drawCupError 这一套。
// 单打 / 双打跟着活动走。结算仍是补录页那一套：预填名次 → 管理员核对 → 发布（cupSave，一个活动只对应一站）
function drawCupOf(d) {
  const cup = d && d.cup;
  if (!cup || !kindText(cup.kind)) return null;
  const group = pointGroupOf(cup.kind, cup.pointGroup);
  const out = { kind: cup.kind };
  if (group) out.pointGroup = group;
  if (isCurrent(cup.kind, cup.scoreVersion)) {
    out.scoreVersion = SCORE_VERSION;
    out.pointGroup = group || 'open';
  }
  return out;
}
const drawCupText = (d) => {
  const c = drawCupOf(d);
  return c ? 'LULU 积分 · ' + stopKindText(c) : '';
};
// 活动设置 s = { mode, size } 能不能计这一类积分：返回错误文字，'' = 可以
function drawCupError(s, kind) {
  s = s || {};
  if (!kindText(kind)) return '请选择有效积分类别';
  return s.mode === 'bracket' || s.mode === 'groups_ko' ? '' : `${kindText(kind)}要有最后一轮，请把活动形式改成「循环＋淘汰」或「单淘汰」`;
}
const drawCupNote = (kind) => {
  const bonus = eventBonusOf(kind);
  return `${kindText(kind)}：循环＋淘汰或单淘汰${bonus ? ` · 每人每站额外加 ${bonus} 分` : ''} · 名次从淘汰阶段带入，结束后由管理员结算`;
};

/**
 * 从活动对阵推出这一站的名次（预填用，发布前由管理员核对）。d：活动；matches：这个活动的比赛记录；uidOf：参加名 → 用户 ID。
 * 返回 { date, kind, format, done, places: { champion, runnerUp, semis, floor }, notes }：
 *   done：已生成对阵、所有场次都有结果（没打完不能结算）；
 *   冠军 = 最后一轮胜者，亚军 = 最后一轮负者，四强 = 4 强那一轮的负者（轮空的不算）；
 *   现行积分活动只带入实际打过球的保底参赛者；旧站继续按对应规则预填。
 *   没有账号的名字留空（管理员手动选）；有弃权、退赛、留空或推不出的名次，都写进 notes 提示核对
 */
function fromDraw(d, matches, uidOf) {
  const E = require('./event');
  const c = drawCupOf(d) || {};
  const format = E.cfgOf(d).type === 'double' ? 'double' : 'single';
  const size = sizeOf(format);
  const blank = () => Array.from({ length: size }, () => '');
  const out = { date: (d && d.date) || '', kind: c.kind || '', format, done: false, places: { champion: blank(), runnerUp: blank(), semis: [], floor: [] }, notes: [] };
  if (c.pointGroup) out.pointGroup = c.pointGroup;
  if (c.scoreVersion) out.scoreVersion = c.scoreVersion;
  if (!d || d.status === 'signup') return out;
  const sch = E.scheduleOf(d, matches || []);
  out.done = sch.length > 0 && sch.every((x) => x.done);
  if (!out.done) return out;
  const notes = out.notes;
  const missing = [];
  const idsOf = (name) => {
    const ms = E.membersOf(d, name);
    const ids = ms.map((n) => (uidOf && uidOf[n]) || '');
    ms.forEach((n, i) => { if (!ids[i]) missing.push(n); });
    return ids.length === size ? ids : blank();
  };
  const view = d.mode === 'groups_ko' ? E.knockoutFor(d, matches || []) : d.mode === 'bracket' ? E.bracketFor(d, matches || []) : null;
  const placed = {};
  const take = (name) => { placed[name] = 1; return idsOf(name); };
  const rounds = (view && view.rounds) || [];
  const fin = rounds.length ? rounds[rounds.length - 1].matches[0] : null;
  if (fin && view.champion && fin.ready && (fin.a.win || fin.b.win)) {
    out.places.champion = take(view.champion.name);
    out.places.runnerUp = take(fin.a.win ? fin.b.name : fin.a.name);
  } else notes.push('推不出冠军、亚军，请按实际结果选择');
  const semiRound = rounds.find((r) => r.matches.length === 2 && rounds.indexOf(r) === rounds.length - 2);
  if (semiRound) {
    semiRound.matches.forEach((m) => {
      if (m.hasBye || !m.ready || !(m.a.win || m.b.win)) return;
      out.places.semis.push(take(m.a.win ? m.b.name : m.a.name));
    });
    if (out.places.semis.length < MAX_SEMI) notes.push(`4 强那一轮有轮空，四强只带入 ${out.places.semis.length} 个`);
  } else if (fin) notes.push('淘汰阶段没有 4 强那一轮，四强请按实际结果选择（没有可以留空）');
  const wd = E.withdrawalsOf(d);
  if (hasFloor(c.kind, c.pointGroup, c.scoreVersion)) {
    const played = new Set();
    if (c.pointGroup) {
      sch.forEach((m) => {
        if ((m.outcome === 'normal' || m.outcome === 'retired') && m.sets.length) {
          played.add(m.a);
          played.add(m.b);
        }
      });
      out.playedKeys = Array.from(played, (name) => E.membersOf(d, name).map((n) => (uidOf && uidOf[n]) || ''))
        .filter((ids) => ids.length === size && ids.every(Boolean)).map(teamKey);
    }
    const gone = [];
    (d.entrants || []).forEach((name) => {
      if (placed[name]) return;
      if (c.pointGroup ? !played.has(name) : wd[name]) { gone.push(name); return; }
      out.places.floor.push(idsOf(name));
    });
    if (gone.length) notes.push(c.pointGroup
      ? `${gone.join('、')} 暂无实际打球记录，没有带入参加保底`
      : `${gone.join('、')} 退赛了，没有带入参加保底；如果实际参加了请手动添加`);
    if (out.places.floor.length) notes.push('参加保底按对阵名单带入了其余参加的人，请核对实际到场的人');
  } else if (Object.keys(wd).length) notes.push('有人退赛，请核对名次');
  if (sch.some((x) => x.outcome && x.outcome !== 'normal')) notes.push('有弃权、中途退赛或成绩取消的场次，请核对名次');
  if (missing.length) notes.push(`${missing.join('、')} 没有对应的成员账号，请手动选择`);
  return out;
}
// 已发布的名次和对阵推出来的是否不同（只比冠军、亚军、四强；参加保底由管理员核对，不比）
function placesDiffer(a, b) {
  const k = (p) => { p = p || {}; return JSON.stringify([teamKey(p.champion || []), teamKey(p.runnerUp || []), (p.semis || []).map(teamKey).sort()]); };
  return k(a) !== k(b);
}

// 一条积分的文字：「30」「30 + 10」，双打「30 ÷ 2」（两人平分）
const basePointsText = (r) => (r.split ? `${r.teamBase} ÷ ${r.split}` : String(r.base));
const pointsText = (r) => basePointsText(r) + (r.bonus ? ` + ${r.bonus}` : '');
// 分数显示：双打平分会有 .5，最多一位小数，不显示多余的 0
const numText = (n) => String(Math.round(n * 10) / 10);
const thisYear = () => new Date().getFullYear();

module.exports = {
  KINDS, ACTIVE_KINDS, SCORE_VERSION, FORMATS, TIERS, POINTS, POINT_GROUPS, BOARDS, MAX_SEMI, MAX_FLOOR, kindsForVersion,
  usesPointGroup, pointGroupOf, pointGroupText, pointsOf, stopKindText, eventBonusOf,
  kindText, formatText, tierText, sizeOf, hasFloor, teamKey, cleanStop, results, boardOfStop, board, years, mine, myYears, latestOf, pointsText, basePointsText, numText, thisYear,
  drawCupOf, drawCupText, drawCupError, drawCupNote, fromDraw, placesDiffer,
};
