// 管理员运营统计与结构化报表导出引擎（纯前端计算，仅管理员页面调用，只读不改共享数组）：
//   1. 按时间段 / 建议水平档位统计活动成局率与平均参与人数
//   2. 统计正式成员近 30 / 90 天活跃出勤分层与明细
//   3. 按自然年生成 3 份一键可复制的结构化报表（年度汇总文本、成员出勤 CSV、年度 LULU 积分 CSV）
const C = require('../../utils/cup');
const E = require('../../utils/event');
const R = require('../../utils/rating');
const S = require('../../utils/stats');
const SE = require('../../utils/season');
const { isNormal } = require('../../utils/rules');

const SLOTS = [
  { id: 'wd_day', label: '工作日白天' },
  { id: 'wd_night', label: '工作日晚场' },
  { id: 'we_am', label: '周末上午' },
  { id: 'we_pm', label: '周末下午' },
  { id: 'we_night', label: '周末晚场' },
];

const LEVEL_BUCKETS = [
  { id: 'none', label: '不限水平' },
  { id: 'low', label: '2.5 及以下' },
  { id: 'mid', label: '2.5 – 3.0' },
  { id: 'high', label: '3.0 – 3.5' },
  { id: 'pro', label: '3.5 以上' },
];

function shiftDays(ymd, delta) {
  const d = new Date(ymd + 'T00:00:00Z');
  if (isNaN(d.getTime())) return ymd;
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function slotOfDraw(d) {
  const dt = d && d.date ? new Date(d.date + 'T00:00:00Z') : null;
  const dow = dt && !isNaN(dt.getTime()) ? dt.getUTCDay() : 6; // 默认按周末归类
  const isWe = dow === 0 || dow === 6;
  const hour = d && typeof d.startTime === 'string' && /^\d{1,2}:/.test(d.startTime)
    ? Number(d.startTime.split(':')[0])
    : -1;
  if (!isWe) return hour >= 18 ? 'wd_night' : 'wd_day';
  if (hour >= 18) return 'we_night';
  if (hour >= 12) return 'we_pm';
  return 'we_am';
}

function levelBucketOfDraw(d) {
  const lv = E.levelRangeOf(d && d.level);
  if (!lv) return 'none';
  const mid = (lv.min + lv.max) / 2;
  if (lv.max <= 2.5) return 'low';
  if (mid <= 3.0) return 'mid';
  if (mid <= 3.5) return 'high';
  return 'pro';
}

function entrantsCountOf(d) {
  const arr = (d && d.entrants) || [];
  if (!arr.length) return 0;
  return arr.reduce((acc, x) => acc + String(x || '').split(' / ').filter(Boolean).length, 0);
}

function csvCell(v) {
  const s = String(v === undefined || v === null ? '' : v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildCsv(header, rows) {
  return [header].concat(rows).map((line) => line.map(csvCell).join(',')).join('\n');
}

function opsReport(input) {
  const x = input || {};
  const today = x.today || new Date().toISOString().slice(0, 10);
  const d30 = shiftDays(today, -30);
  const d90 = shiftDays(today, -90);

  const draws = (x.draws || []).filter((d) => d && !d.deleted);
  const matches = (x.matches || []).filter(isNormal);
  const players = x.players || [];
  const members = x.members || [];
  const stops = (x.stops || []).filter((s) => s && !s.deleted && s.status === 'published');

  // 可选报表年份（合并比赛与积分站年份）
  const ySet = Object.create(null);
  ySet[Number(today.slice(0, 4))] = 1;
  SE.seasonsIn(matches).forEach((s) => { ySet[Number(s)] = 1; });
  C.years(stops).forEach((y) => { ySet[Number(y)] = 1; });
  const years = Object.keys(ySet).map(Number).filter(Boolean).sort((a, b) => b - a);
  const year = years.indexOf(Number(x.year)) >= 0 ? Number(x.year) : years[0];
  const yearStr = String(year);

  /* ---------- 1. 活动成局率分析（时间段 & 水平档位） ---------- */
  // 未来尚未截止的报名中活动不计入未成局分母
  const settledDraws = draws.filter((d) => !(d.status === 'signup' && d.date && d.date > today));
  const slotMap = Object.create(null);
  SLOTS.forEach((s) => { slotMap[s.id] = { id: s.id, label: s.label, total: 0, formed: 0, peopleSum: 0 }; });
  const lvMap = Object.create(null);
  LEVEL_BUCKETS.forEach((b) => { lvMap[b.id] = { id: b.id, label: b.label, total: 0, formed: 0, peopleSum: 0 }; });

  let formedTotal = 0, endedEarly = 0, yearDraws = 0, yearFormed = 0;
  settledDraws.forEach((d) => {
    const formed = d.status !== 'signup';
    const people = entrantsCountOf(d);
    if (formed) formedTotal++;
    if (d.endedAt) endedEarly++;
    if (String(d.date || '').slice(0, 4) === yearStr) {
      yearDraws++;
      if (formed) yearFormed++;
    }
    const sb = slotMap[slotOfDraw(d)];
    sb.total++;
    if (formed) { sb.formed++; sb.peopleSum += people; }
    const lb = lvMap[levelBucketOfDraw(d)];
    lb.total++;
    if (formed) { lb.formed++; lb.peopleSum += people; }
  });

  const finalizeBuckets = (order, map) => order.map((o) => {
    const b = map[o.id];
    return {
      id: b.id,
      label: b.label,
      total: b.total,
      formed: b.formed,
      rate: b.total ? Math.round((b.formed / b.total) * 100) : 0,
      avgPeople: b.formed ? Math.round((b.peopleSum / b.formed) * 10) / 10 : 0,
    };
  }).filter((b) => b.total > 0);

  const bySlot = finalizeBuckets(SLOTS, slotMap);
  const byLevel = finalizeBuckets(LEVEL_BUCKETS, lvMap);
  const formRate = settledDraws.length ? Math.round((formedTotal / settledDraws.length) * 100) : 0;

  /* ---------- 2. 正式成员近 30 / 90 天活跃出勤统计 ---------- */
  const ratings = R.ratingsOf ? R.ratingsOf(matches, players) : R.computeRatings(matches, R.startLevelsFrom(players));
  const profByUid = Object.create(null);
  players.forEach((p) => {
    const uid = p && (p.uid || p._openid);
    if (uid) profByUid[uid] = p;
  });

  // 合并正式成员列表（若传了 members 则以正式成员为准，否则退回 players）
  const baseMembers = members.length
    ? members.map((m) => ({
      uid: m.uid,
      name: m.nickname || m.name || (profByUid[m.uid] && profByUid[m.uid].name) || `成员 ${(m.uid || '').slice(-4)}`,
      gender: S.GENDER[m.gender || (profByUid[m.uid] && profByUid[m.uid].gender)] || '',
    }))
    : players.filter((p) => p && (p.uid || p._openid)).map((p) => ({
      uid: p.uid || p._openid,
      name: p.name || '成员',
      gender: S.GENDER[p.gender] || '',
    }));

  const mMap = Object.create(null);
  baseMembers.forEach((m) => {
    if (!m.uid || mMap[m.uid]) return;
    mMap[m.uid] = {
      uid: m.uid, name: m.name, gender: m.gender,
      m30: 0, m90: 0, mYear: 0, wYear: 0, total: 0, lastDate: '',
    };
  });

  let yearMatchesCount = 0;
  const yearActiveUids = Object.create(null);

  matches.forEach((m) => {
    const date = m.date || '';
    const inYear = date.slice(0, 4) === yearStr;
    if (inYear) yearMatchesCount++;
    const in30 = date >= d30 && date <= today;
    const in90 = date >= d90 && date <= today;
    ['a', 'b'].forEach((side) => {
      const won = m.winner === side;
      const ks = m[side + 'Keys'] || m[side + 'Ids'] || [];
      ks.forEach((uid) => {
        const rec = mMap[uid];
        if (!rec) return;
        rec.total++;
        if (in30) rec.m30++;
        if (in90) rec.m90++;
        if (inYear) { rec.mYear++; if (won) rec.wYear++; yearActiveUids[uid] = 1; }
        if (date > rec.lastDate) rec.lastDate = date;
      });
    });
  });

  let hotCount = 0, active30 = 0, active90 = 0, warmCount = 0, coldCount = 0;
  const memberRows = Object.keys(mMap).map((uid) => {
    const rec = mMap[uid];
    const r = ratings.players && ratings.players[uid];
    const levelText = r ? R.fmt(r.level) : '待定级';
    let tier = 'cold';
    let tierText = '90天未出勤';
    if (rec.m30 >= 4) { tier = 'hot'; tierText = '高活跃'; hotCount++; active30++; active90++; }
    else if (rec.m30 >= 1) { tier = 'active'; tierText = '近30天活跃'; active30++; active90++; }
    else if (rec.m90 >= 1) { tier = 'warm'; tierText = '31~90天出勤'; warmCount++; active90++; }
    else { coldCount++; }
    return Object.assign({}, rec, {
      levelText,
      yearRate: rec.mYear ? Math.round((rec.wYear / rec.mYear) * 100) : 0,
      tier,
      tierText,
    });
  }).sort((a, b) => b.m30 - a.m30 || b.m90 - a.m90 || b.lastDate.localeCompare(a.lastDate) || a.name.localeCompare(b.name));

  const totalMembers = memberRows.length;
  const active30Rate = totalMembers ? Math.round((active30 / totalMembers) * 100) : 0;
  const active90Rate = totalMembers ? Math.round((active90 / totalMembers) * 100) : 0;

  /* ---------- 3. 赛季末一键导出 / 复制报表（年度总结 + 出勤 CSV + 积分 CSV） ---------- */
  const nameOf = (uid) => (mMap[uid] && mMap[uid].name) || (profByUid[uid] && profByUid[uid].name) || '成员';
  const singleBoard = C.board(stops, year, 'single');
  const doubleBoard = C.board(stops, year, 'double');
  const yearStops = stops.filter((s) => Number(s.year) === year).sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));

  const lines = [
    `【LULU 网球 · ${year} 年度运营汇总报表】`,
    `统计日期：${today}`,
    '',
    '一、年度核心指标',
    `- 正式成员：${totalMembers} 人（近30天活跃 ${active30} 人 / ${active30Rate}%，近90天活跃 ${active90} 人 / ${active90Rate}%）`,
    `- 年度活动：共 ${yearDraws} 场，成局 ${yearFormed} 场（历史总成局率 ${formRate}%）`,
    `- 年度完赛：共 ${yearMatchesCount} 场正式比赛，年度上场 ${Object.keys(yearActiveUids).length} 人`,
    `- 年度 LULU 积分站：已发布 ${yearStops.length} 站`,
  ];

  const topActive = memberRows.filter((m) => m.mYear > 0).slice().sort((a, b) => b.mYear - a.mYear || b.wYear - a.wYear).slice(0, 10);
  if (topActive.length) {
    lines.push('', '二、年度出勤榜 Top10');
    topActive.forEach((m, i) => lines.push(`${i + 1}. ${m.name}（${m.levelText}）— ${m.mYear} 场 · ${m.wYear}胜${m.mYear - m.wYear}负（胜率 ${m.yearRate}%）`));
  }
  if (singleBoard.length) {
    lines.push('', `三、${year} 单打年终积分榜 Top10`);
    singleBoard.slice(0, 10).forEach((r) => {
      const grp = r.pointGroup !== 'open' ? ` [${C.pointGroupText(r.pointGroup)}]` : '';
      lines.push(`${r.rank}. ${r.ids.map(nameOf).join(' / ')}${grp} — ${C.numText(r.total)} 分（${r.stops} 站，${r.champions} 冠）`);
    });
  }
  if (doubleBoard.length) {
    lines.push('', `四、${year} 双打年终积分榜 Top10`);
    doubleBoard.slice(0, 10).forEach((r) => {
      const grp = r.pointGroup !== 'open' ? ` [${C.pointGroupText(r.pointGroup)}]` : '';
      lines.push(`${r.rank}. ${r.ids.map(nameOf).join(' / ')}${grp} — ${C.numText(r.total)} 分（${r.stops} 站，${r.champions} 冠）`);
    });
  }
  if (bySlot.length) {
    lines.push('', '五、活动时段成局率');
    bySlot.forEach((b) => lines.push(`- ${b.label}：成局 ${b.formed}/${b.total}（${b.rate}%）· 均 ${b.avgPeople} 人`));
  }

  const membersCsv = buildCsv(
    ['昵称', '性别', '比赛等级', `${year}场数`, `${year}胜场`, `${year}胜率`, '近30天场数', '近90天场数', '最近出勤日期'],
    memberRows.map((m) => [m.name, m.gender || '-', m.levelText, m.mYear, m.wYear, m.mYear ? m.yearRate + '%' : '-', m.m30, m.m90, m.lastDate || '-']),
  );

  const cupCsvRows = [];
  [['单打年终榜', singleBoard], ['双打年终榜', doubleBoard]].forEach(([label, board]) => {
    board.forEach((r) => {
      cupCsvRows.push([label, r.rank, r.ids.map(nameOf).join(' / '), C.pointGroupText(r.pointGroup) || '不分组', C.numText(r.total), r.stops, r.champions]);
    });
  });
  const cupCsv = buildCsv(['榜别', '名次', '姓名', '积分组别', '总分', '站数', '冠军数'], cupCsvRows);

  return {
    today,
    year,
    years,
    overview: {
      totalMembers,
      active30,
      active30Rate,
      active90,
      active90Rate,
      hotCount,
      warmCount,
      coldCount,
      settledDraws: settledDraws.length,
      formedTotal,
      formRate,
      endedEarly,
      yearMatchesCount,
      yearStopsCount: yearStops.length,
    },
    bySlot,
    byLevel,
    memberRows,
    exports: {
      summaryText: lines.join('\n'),
      membersCsv,
      cupCsv,
      cupCount: cupCsvRows.length,
    },
  };
}

module.exports = {
  SLOTS,
  LEVEL_BUCKETS,
  shiftDays,
  slotOfDraw,
  levelBucketOfDraw,
  opsReport,
};
