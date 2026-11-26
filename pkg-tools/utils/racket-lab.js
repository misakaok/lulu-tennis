// 个人装备实验室纯计算模块（100% 本人私有数据，纯前端算力，无写库、无分享）：
//   1. crossAnalyze：球拍 / 球线 × 实战战绩交叉分析（按拍胜率对比、穿线 0～8h vs 8h+ 衰减对比、常用球线寿命与胜率）
//   2. compareRackets：双拍参数与贴铅片配重并排对比（内置主流网球拍规格参考库）
//   3. recommendTension：按气温、拍面、球线材质、打法倾向与手臂敏感度计算推荐穿线磅数
const K = require('../../utils/racket');
const { isNormal } = require('../../utils/rules');
const { tsOf } = require('../../utils/event');

const FRESH_HOURS = 8; // 球线新鲜期分界（小时）：0～8h vs 8h+

// 常见系列空拍参考参数（仅作对比默认初值，用户可按自己实测微调）
const RACKET_SPECS = {
  'wilson|Pro Staff': { weight: 315, balance: 310, head: 97, pattern: '16×19', sw: 325 },
  'wilson|Blade': { weight: 305, balance: 320, head: 98, pattern: '16×19', sw: 324 },
  'wilson|Clash': { weight: 295, balance: 310, head: 100, pattern: '16×19', sw: 312 },
  'wilson|Ultra': { weight: 300, balance: 320, head: 100, pattern: '16×19', sw: 320 },
  'wilson|Shift': { weight: 300, balance: 315, head: 99, pattern: '16×20', sw: 318 },
  'wilson|Burn': { weight: 300, balance: 320, head: 100, pattern: '18×16', sw: 322 },
  'head|Speed': { weight: 300, balance: 320, head: 100, pattern: '16×19', sw: 322 },
  'head|Radical': { weight: 300, balance: 320, head: 98, pattern: '16×19', sw: 323 },
  'head|Prestige': { weight: 310, balance: 315, head: 98, pattern: '18×20', sw: 326 },
  'head|Extreme': { weight: 300, balance: 325, head: 100, pattern: '16×19', sw: 324 },
  'head|Gravity': { weight: 295, balance: 325, head: 100, pattern: '16×20', sw: 321 },
  'head|Boom': { weight: 295, balance: 315, head: 100, pattern: '16×19', sw: 316 },
  'babolat|Pure Aero': { weight: 300, balance: 320, head: 100, pattern: '16×19', sw: 324 },
  'babolat|Pure Drive': { weight: 300, balance: 320, head: 100, pattern: '16×19', sw: 321 },
  'babolat|Pure Strike': { weight: 305, balance: 320, head: 98, pattern: '16×19', sw: 325 },
  'yonex|EZONE': { weight: 300, balance: 320, head: 100, pattern: '16×19', sw: 319 },
  'yonex|VCORE': { weight: 300, balance: 320, head: 98, pattern: '16×19', sw: 322 },
  'yonex|Percept': { weight: 305, balance: 315, head: 97, pattern: '16×19', sw: 323 },
  'tecnifibre|TFight': { weight: 300, balance: 320, head: 98, pattern: '16×19', sw: 322 },
  'tecnifibre|TF40': { weight: 305, balance: 325, head: 98, pattern: '16×19', sw: 326 },
  'dunlop|CX': { weight: 305, balance: 315, head: 98, pattern: '16×19', sw: 322 },
  'dunlop|SX': { weight: 300, balance: 320, head: 100, pattern: '16×19', sw: 323 },
  'dunlop|FX': { weight: 300, balance: 320, head: 100, pattern: '16×19', sw: 320 },
  'prince|Tour': { weight: 305, balance: 310, head: 98, pattern: '16×19', sw: 321 },
  'prince|Phantom': { weight: 305, balance: 315, head: 100, pattern: '16×18', sw: 322 },
};

const COMPARE_PRESETS = [
  { id: 'blade98', label: 'Blade 98', brand: 'wilson', model: 'Blade', weight: 305, balance: 320, head: 98, pattern: '16×19', sw: 324 },
  { id: 'speedmp', label: 'Speed MP', brand: 'head', model: 'Speed', weight: 300, balance: 320, head: 100, pattern: '16×19', sw: 322 },
  { id: 'pureaero', label: 'Pure Aero', brand: 'babolat', model: 'Pure Aero', weight: 300, balance: 320, head: 100, pattern: '16×19', sw: 324 },
  { id: 'ezone100', label: 'EZONE 100', brand: 'yonex', model: 'EZONE', weight: 300, balance: 320, head: 100, pattern: '16×19', sw: 319 },
  { id: 'prostaff', label: 'Pro Staff 97', brand: 'wilson', model: 'Pro Staff', weight: 315, balance: 310, head: 97, pattern: '16×19', sw: 325 },
  { id: 'clash100', label: 'Clash 100', brand: 'wilson', model: 'Clash', weight: 295, balance: 310, head: 100, pattern: '16×19', sw: 312 },
];

const HEAD_OPTS = [95, 97, 98, 99, 100, 102, 105];
const PATTERN_OPTS = ['16×19', '16×20', '18×20', '16×18'];

const TEMP_OPTS = [
  { id: 'cold', label: '严寒 <10°C', delta: -2.5, tip: '低温下球体偏硬、线床变紧，适当降磅更护手且易出深度' },
  { id: 'cool', label: '偏凉 10~18°C', delta: -1.0, tip: '微凉天气建议降 1 磅维持弹性与甜区容错' },
  { id: 'mild', label: '舒适 18~26°C', delta: 0, tip: '标准体感温度，直接按个人常用磅数穿线即可' },
  { id: 'warm', label: '炎热 26~32°C', delta: 1.0, tip: '高温球速偏快且掉磅加快，可加 1 磅稳住出球控制' },
  { id: 'hot', label: '酷暑 >32°C', delta: 2.0, tip: '酷暑高弹环境下建议加 2 磅防出界，缩短换线间隔' },
];
const MAT_OPTS = [
  { id: 'poly', label: '聚酯单丝', base: 48, crossDiff: -2, life: '建议 10～15 小时换线，防止掉磅僵硬伤肘' },
  { id: 'hybrid', label: '子母混穿', base: 51, crossDiff: 2, life: '竖聚酯控球 + 横软线提弹，横线可比竖线高 1～2 磅' },
  { id: 'multi', label: '仿羊肠多丝', base: 53, crossDiff: 0, life: '弹性足、护手佳，起毛明显或断线前均可稳定发挥' },
  { id: 'syngut', label: '尼龙合成线', base: 52, crossDiff: 0, life: '性价比高、手感均衡，适合日常高频练习' },
];
const STYLE_OPTS = [
  { id: 'control', label: '控球稳健', delta: 1.5 },
  { id: 'balance', label: '均衡全能', delta: 0 },
  { id: 'power', label: '借力轻松', delta: -1.5 },
];
const ARM_OPTS = [
  { id: 'normal', label: '手臂正常', delta: 0 },
  { id: 'sensitive', label: '易酸痛护手', delta: -2.0 },
];

function specOfRacket(r) {
  if (!r) return { weight: 300, balance: 320, head: 100, pattern: '16×19', sw: 320 };
  const key = `${r.brand || ''}|${r.model || ''}`;
  return Object.assign({ weight: 300, balance: 320, head: 100, pattern: '16×19', sw: 320 }, RACKET_SPECS[key] || {});
}

function sideOfMatch(m, uid) {
  if (!m || !uid) return '';
  if ((m.aKeys || []).indexOf(uid) >= 0 || (m.aIds || []).indexOf(uid) >= 0) return 'a';
  if ((m.bKeys || []).indexOf(uid) >= 0 || (m.bIds || []).indexOf(uid) >= 0) return 'b';
  return '';
}

function pct(w, t) { return t ? Math.round((w / t) * 100) : 0; }
const r1 = (n) => Math.round(n * 10) / 10;

/* =========================================================================
 * 1. 「球拍 / 球线 × 实战战绩」交叉分析
 * ========================================================================= */
function crossAnalyze(rackets, logs, matches, uid, todayStr) {
  const rkList = (rackets || []).slice().sort((a, b) => (a.status === 'retired') - (b.status === 'retired') || (a.no || 0) - (b.no || 0));
  const rkById = Object.create(null);
  rkList.forEach((r) => { rkById[r.id] = r; });
  const allLogs = (logs || []).filter((l) => l && rkById[l.racketId]);
  const playLogs = allLogs.filter((l) => l.kind === 'play');
  const strLogs = allLogs.filter((l) => l.kind === 'string');

  // 按日期索引每天每支拍的打球分钟数
  const playByDate = Object.create(null);
  playLogs.forEach((l) => {
    if (!l.date) return;
    const d = playByDate[l.date] || (playByDate[l.date] = {});
    d[l.racketId] = (d[l.racketId] || 0) + (Number(l.minutes) || 0);
  });

  // 按球拍升序排列穿线记录，方便按任意比赛日期定位当时球线及已打小时数
  const strsByRk = Object.create(null);
  const playsByRk = Object.create(null);
  rkList.forEach((r) => {
    strsByRk[r.id] = strLogs
      .filter((l) => l.racketId === r.id)
      .sort((x, y) => String(x.date).localeCompare(String(y.date)) || (x.createdAt || 0) - (y.createdAt || 0));
    playsByRk[r.id] = playLogs
      .filter((l) => l.racketId === r.id)
      .sort((x, y) => String(x.date).localeCompare(String(y.date)) || (x.createdAt || 0) - (y.createdAt || 0));
  });

  const activeRackets = rkList.filter((r) => r.status !== 'retired');
  const singleActive = activeRackets.length === 1 ? activeRackets[0].id : '';

  // 给本人每一场正常完赛正式比赛匹配球拍 & 球线状态
  const myMatches = (matches || [])
    .filter((m) => isNormal(m) && sideOfMatch(m, uid))
    .slice()
    .sort((x, y) => String(x.date || '').localeCompare(String(y.date || '')) || tsOf(x) - tsOf(y));

  const rkStat = Object.create(null);
  rkList.forEach((r) => {
    const sum = K.summary(r, allLogs, todayStr);
    rkStat[r.id] = {
      id: r.id, no: r.no, brand: r.brand, model: r.model,
      title: K.racketTitle(r), name: K.racketName(r),
      retired: r.status === 'retired',
      played: 0, win: 0, lose: 0,
      singleP: 0, singleW: 0, doubleP: 0, doubleW: 0,
      gamesW: 0, gamesL: 0,
      playMin: (playsByRk[r.id] || []).reduce((s, p) => s + (p.minutes || 0), 0),
      stringCount: sum.stringCount,
      lastString: sum.lastString ? `${sum.lastString.text} · ${sum.lastString.tension}` : '暂无穿线',
    };
  });

  const fresh = { played: 0, win: 0, lose: 0, gamesW: 0, gamesL: 0 };
  const worn = { played: 0, win: 0, lose: 0, gamesW: 0, gamesL: 0 };

  const stringPerf = Object.create(null);
  const ensureStr = (name) => stringPerf[name] || (stringPerf[name] = {
    name, count: 0, broken: 0, dayGaps: [], minGaps: [], played: 0, win: 0, lose: 0,
  });

  // 先统计每种球线的穿线次数、断线与寿命
  rkList.forEach((r) => {
    const strs = strsByRk[r.id] || [];
    const pls = playsByRk[r.id] || [];
    strs.forEach((s, idx) => {
      const sn = K.stringText(s);
      const st = ensureStr(sn);
      st.count++;
      if ((s.tags || []).indexOf('断线重穿') >= 0) st.broken++;
      if (idx + 1 < strs.length) {
        const nextDate = strs[idx + 1].date;
        const d = K.daysBetween(s.date, nextDate);
        if (d > 0) st.dayGaps.push(d);
        const mins = pls.filter((p) => p.date >= s.date && p.date < nextDate).reduce((acc, p) => acc + (p.minutes || 0), 0);
        if (mins > 0) st.minGaps.push(mins);
      }
    });
  });

  let linkedMatches = 0;
  let directLinked = 0;

  myMatches.forEach((m) => {
    const side = sideOfMatch(m, uid);
    const won = m.winner === side;
    const isDbl = m.type === 'double' || ((m.a || []).length > 1);
    let gw = 0, gl = 0;
    (m.sets || []).forEach((s) => {
      const sa = Number(s.a) || 0, sb = Number(s.b) || 0;
      gw += side === 'a' ? sa : sb;
      gl += side === 'a' ? sb : sa;
    });

    // 1) 优先用比赛当天的球拍打球记录匹配；2) 仅有 1 支在用拍且无其他拍记录时归到该主力拍
    let rid = '';
    const dayMap = m.date ? playByDate[m.date] : null;
    if (dayMap) {
      const ids = Object.keys(dayMap).sort((x, y) => dayMap[y] - dayMap[x] || (rkById[x].no || 0) - (rkById[y].no || 0));
      if (ids.length) { rid = ids[0]; directLinked++; }
    } else if (singleActive) {
      const bought = rkById[singleActive].bought || '';
      if (!bought || !m.date || m.date >= bought) rid = singleActive;
    }
    if (!rid || !rkStat[rid]) return;

    linkedMatches++;
    const rs = rkStat[rid];
    rs.played++;
    if (won) rs.win++; else rs.lose++;
    rs.gamesW += gw; rs.gamesL += gl;
    if (isDbl) { rs.doubleP++; if (won) rs.doubleW++; }
    else { rs.singleP++; if (won) rs.singleW++; }

    // 查找这场比赛当天该球拍最近一次穿线，并累计该线在比赛日前（含当日）的打球小时数
    const strs = strsByRk[rid] || [];
    let curStr = null;
    for (let i = strs.length - 1; i >= 0; i--) {
      if (!m.date || strs[i].date <= m.date) { curStr = strs[i]; break; }
    }
    if (curStr) {
      const sn = K.stringText(curStr);
      const sp = ensureStr(sn);
      sp.played++;
      if (won) sp.win++; else sp.lose++;

      const minsBefore = (playsByRk[rid] || [])
        .filter((p) => p.date >= curStr.date && (!m.date || p.date <= m.date))
        .reduce((acc, p) => acc + (p.minutes || 0), 0);
      if (minsBefore > 0) {
        const hrs = minsBefore / 60;
        const bucket = hrs <= FRESH_HOURS ? fresh : worn;
        bucket.played++;
        if (won) bucket.win++; else bucket.lose++;
        bucket.gamesW += gw; bucket.gamesL += gl;
      }
    }
  });

  const racketRows = rkList.map((r) => {
    const x = rkStat[r.id];
    const gTot = x.gamesW + x.gamesL;
    return {
      id: x.id, title: x.title, name: x.name, brand: x.brand, model: x.model, retired: x.retired,
      played: x.played, win: x.win, lose: x.lose,
      rate: pct(x.win, x.played),
      rateText: x.played ? `${pct(x.win, x.played)}%` : '—',
      gameShare: gTot ? `${Math.round((x.gamesW / gTot) * 100)}%` : '—',
      singleText: x.singleP ? `单 ${x.singleW}胜${x.singleP - x.singleW}负` : '',
      doubleText: x.doubleP ? `双 ${x.doubleW}胜${x.doubleP - x.doubleW}负` : '',
      playHours: x.playMin > 0 ? `${K.hoursText(x.playMin)}h` : '0h',
      lastString: x.lastString,
    };
  }).sort((a, b) => b.played - a.played || b.rate - a.rate || (a.retired - b.retired));

  const formatBucket = (b, label) => {
    const gTot = b.gamesW + b.gamesL;
    return {
      label,
      played: b.played,
      win: b.win,
      lose: b.lose,
      rate: pct(b.win, b.played),
      rateText: b.played ? `${pct(b.win, b.played)}%` : '—',
      gameShare: gTot ? `${Math.round((b.gamesW / gTot) * 100)}%` : '—',
    };
  };
  const freshView = formatBucket(fresh, `0～${FRESH_HOURS}h 新鲜期`);
  const wornView = formatBucket(worn, `${FRESH_HOURS}h+ 衰减期`);

  let decayNote = '录完比赛顺手记球拍时长后，这里会自动对比球线前 8 小时与 8 小时后的实战表现';
  if (fresh.played > 0 && worn.played > 0) {
    const diff = freshView.rate - wornView.rate;
    if (diff >= 8) decayNote = `穿线 ${FRESH_HOURS}h 内胜率高出 ${diff}%，及时换线对你的实战手感提升明显`;
    else if (diff <= -8) decayNote = `球线磨合 ${FRESH_HOURS}h 后胜率更高（+${-diff}%），偏爱略掉磅后的柔和咬球感`;
    else decayNote = `穿线前后胜率接近（相差 ${Math.abs(diff)}%），这套球线在你的打法下掉磅容错不错`;
  } else if (fresh.played > 0 || worn.played > 0) {
    decayNote = `已关联 ${fresh.played + worn.played} 场带线龄记录的比赛，继续累计即可对比 0～${FRESH_HOURS}h 与 ${FRESH_HOURS}h+ 差异`;
  }

  const stringRows = Object.keys(stringPerf).map((k) => {
    const s = stringPerf[k];
    const avgDays = s.dayGaps.length ? Math.round(s.dayGaps.reduce((a, b) => a + b, 0) / s.dayGaps.length) : null;
    const avgHrs = s.minGaps.length ? K.hoursText(Math.round(s.minGaps.reduce((a, b) => a + b, 0) / s.minGaps.length)) : '';
    return {
      name: s.name,
      count: s.count,
      broken: s.broken,
      played: s.played,
      win: s.win,
      lose: s.lose,
      rate: pct(s.win, s.played),
      rateText: s.played ? `${pct(s.win, s.played)}%` : '—',
      lifeText: avgHrs ? `均打 ${avgHrs}h` : (avgDays !== null ? `均换 ${avgDays} 天` : `穿线 ${s.count} 次`),
      avgDaysText: avgDays !== null ? `${avgDays} 天` : '—',
    };
  }).sort((a, b) => b.played - a.played || b.count - a.count);

  return {
    totalMyMatches: myMatches.length,
    linkedMatches,
    directLinked,
    freshHours: FRESH_HOURS,
    racketRows,
    fresh: freshView,
    worn: wornView,
    decayNote,
    stringRows,
  };
}

/* =========================================================================
 * 2. 双拍参数与配重并排对比
 * ========================================================================= */
function evalSide(cfg) {
  const x = cfg || {};
  const tuned = K.tuneRacket({
    weight: x.weight || 300,
    balance: x.balance || 320,
    top: x.top || 0,
    side: x.side || 0,
    throat: x.throat || 0,
    handle: x.handle || 0,
  });
  const baseSw = Number(x.sw) > 200 ? Number(x.sw) : 320;
  const estSw = r1(baseSw + tuned.swDelta);
  const head = Number(x.head) || 100;
  const pattern = x.pattern || '16×19';
  return {
    name: x.name || '球拍',
    brand: x.brand || 'other',
    model: x.model || '',
    weight: tuned.newWeight,
    balance: tuned.newBalance,
    balTag: tuned.balTag,
    added: tuned.added,
    sw: estSw,
    head,
    pattern,
    stringInfo: x.stringInfo || '',
  };
}

function compareRackets(aCfg, bCfg) {
  const a = evalSide(aCfg);
  const b = evalSide(bCfg);
  const dw = r1(a.weight - b.weight);
  const dsw = r1(a.sw - b.sw);
  const dh = a.head - b.head;

  const fmtDiff = (v, unit, pos) => {
    if (Math.abs(v) < 0.1) return '基本一致';
    return `${v > 0 ? 'A ' + pos : 'B ' + pos} ${Math.abs(v)}${unit}`;
  };

  const rows = [
    { k: '穿铅后总重', a: `${a.weight}g`, b: `${b.weight}g`, diff: fmtDiff(dw, 'g', '重'), winA: dw > 0, winB: dw < 0 },
    { k: '平衡点', a: `${a.balance}mm`, b: `${b.balance}mm`, diff: `${a.balTag} / ${b.balTag}`, winA: false, winB: false },
    { k: '预估挥重', a: `${a.sw}`, b: `${b.sw}`, diff: fmtDiff(dsw, '', '高'), winA: dsw > 0, winB: dsw < 0 },
    { k: '拍面大小', a: `${a.head} in²`, b: `${b.head} in²`, diff: dh === 0 ? '相同拍面' : `${dh > 0 ? 'A' : 'B'} 拍面大 ${Math.abs(dh)}`, winA: dh > 0, winB: dh < 0 },
    { k: '线床密度', a: a.pattern, b: b.pattern, diff: a.pattern === b.pattern ? '相同线床' : '开放度不同', winA: false, winB: false },
  ];

  const tips = [];
  if (Math.abs(dsw) >= 6) tips.push(`${dsw > 0 ? '拍 A' : '拍 B'} 挥重更高（+${Math.abs(dsw)}），底线抽球更有穿透力；另一支网前变向更轻快`);
  if (Math.abs(dw) >= 8) tips.push(`${dw > 0 ? '拍 A' : '拍 B'} 更重 ${Math.abs(dw)}g，接大力发球抗扭更稳，长盘对体力要求也更高`);
  if (dh !== 0) tips.push(`${dh > 0 ? '拍 A' : '拍 B'} 拍面更大，甜区容错更高；较小拍面精准指向性更强`);
  if (!tips.length) tips.push('两支球拍静态参数与挥重非常接近，可直接按球线配置或场上手感轮换使用');

  return { a, b, rows, tips };
}

/* =========================================================================
 * 3. 按气温 × 拍面 × 球线 × 打法 × 手臂敏感度的穿线磅数参考器
 * ========================================================================= */
function recommendTension(input) {
  const x = input || {};
  const temp = TEMP_OPTS.find((t) => t.id === x.temp) || TEMP_OPTS[2];
  const mat = MAT_OPTS.find((m) => m.id === x.material) || MAT_OPTS[0];
  const style = STYLE_OPTS.find((s) => s.id === x.style) || STYLE_OPTS[1];
  const arm = ARM_OPTS.find((a) => a.id === x.arm) || ARM_OPTS[0];
  const head = Number(x.head) || 100;

  // 拍面补偿：100 拍面为基准；95~97 小拍面甜区紧适当降磅，102+ 大拍面略升磅控球
  const headDelta = head <= 97 ? -1.5 : head === 98 ? -0.5 : head >= 102 ? 1.5 : 0;
  const rawMain = mat.base + temp.delta + headDelta + style.delta + arm.delta;
  const clamped = Math.max(40, Math.min(60, Math.round(rawMain * 2) / 2));
  const lo = Math.max(38, Math.floor(clamped - 1));
  const hi = Math.min(62, Math.ceil(clamped + 1));
  const mainRec = Math.round(clamped);
  const crossRec = Math.max(38, Math.min(62, Math.round(clamped + mat.crossDiff)));

  const notes = [temp.tip, mat.life];
  if (arm.id === 'sensitive') notes.push('已自动为你下调 2 磅减轻震动，建议优先选细线径或软聚酯 / 多丝线');
  else if (head <= 97) notes.push(`${head} 小拍面线床偏紧，降磅 ${Math.abs(headDelta)} 磅有助于打开甜区`);
  else if (head >= 102) notes.push(`${head} 大拍面弹性充沛，略加 ${headDelta} 磅提升落点控制`);

  return {
    rangeText: `${lo} – ${hi}`,
    mainRec,
    crossRec,
    splitText: mainRec === crossRec ? `横竖同磅 ${mainRec} 磅` : `建议 竖 ${mainRec} 磅 · 横 ${crossRec} 磅`,
    tempDeltaText: temp.delta === 0 ? '常温基准 0 磅' : `气温补偿 ${temp.delta > 0 ? '+' : ''}${temp.delta} 磅`,
    headDeltaText: headDelta === 0 ? '100 标准拍面' : `拍面补偿 ${headDelta > 0 ? '+' : ''}${headDelta} 磅`,
    notes,
  };
}

module.exports = {
  FRESH_HOURS,
  RACKET_SPECS,
  COMPARE_PRESETS,
  HEAD_OPTS,
  PATTERN_OPTS,
  TEMP_OPTS,
  MAT_OPTS,
  STYLE_OPTS,
  ARM_OPTS,
  specOfRacket,
  crossAnalyze,
  compareRackets,
  recommendTension,
};
