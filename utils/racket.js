// 我的球拍（只有本人可见）：球拍档案、穿线 / 维护 / 使用（打球时长）记录的字段校验、提醒和统计。小程序端和云函数共用（scripts/sync-shared.sh）。
//   个人主体不放自由文字：品牌、型号、球线、维护项目、备注一律从下面的固定选项里选；球拍没有昵称，按添加顺序自动编号（「1 号拍」）。
//   数字字段（磅数、费用、手感）按范围校验。提醒只在小程序内显示，不发订阅消息。

const OTHER = '其他';
// 球拍品牌和常见系列（每个品牌都可以选「其他」）
const RACKET_BRANDS = [
  { k: 'wilson', n: 'Wilson', models: ['Pro Staff', 'Blade', 'Clash', 'Ultra', 'Shift', 'Burn', 'Six.One'] },
  { k: 'head', n: 'Head', models: ['Speed', 'Radical', 'Prestige', 'Extreme', 'Gravity', 'Boom', 'Instinct'] },
  { k: 'babolat', n: 'Babolat', models: ['Pure Aero', 'Pure Drive', 'Pure Strike', 'Evo Drive', 'Boost'] },
  { k: 'yonex', n: 'Yonex', models: ['EZONE', 'VCORE', 'Percept', 'Astrel'] },
  { k: 'prince', n: 'Prince', models: ['Phantom', 'Tour', 'Textreme', 'Ripstick'] },
  { k: 'tecnifibre', n: 'Tecnifibre', models: ['TFight', 'TF40', 'Tempo', 'TF-X1'] },
  { k: 'dunlop', n: 'Dunlop', models: ['CX', 'SX', 'FX'] },
  { k: 'volkl', n: 'Völkl', models: ['V-Cell', 'V-Feel', 'Vostra'] },
  { k: 'diadem', n: 'Diadem', models: ['Nova', 'Elevate', 'Rise'] },
  { k: 'other', n: '其他品牌', models: [] },
];
// 球线品牌和常见系列
const STRING_BRANDS = [
  { k: 'luxilon', n: 'Luxilon', models: ['ALU Power', '4G', 'Element', 'Savage', 'Big Banger'] },
  { k: 'babolat', n: 'Babolat', models: ['RPM Blast', 'RPM Rough', 'VS Touch', 'Xcel'] },
  { k: 'wilson', n: 'Wilson', models: ['NXT', 'Champion\'s Choice', 'Revolve', 'Natural Gut'] },
  { k: 'yonex', n: 'Yonex', models: ['Poly Tour Pro', 'Poly Tour Strike', 'Poly Tour Rev', 'Rexis'] },
  { k: 'solinco', n: 'Solinco', models: ['Hyper-G', 'Tour Bite', 'Confidential', 'Revolution'] },
  { k: 'tecnifibre', n: 'Tecnifibre', models: ['X-One Biphase', 'Razor Code', 'NRG2', 'Multifeel', 'Black Code'] },
  { k: 'head', n: 'Head', models: ['Lynx', 'Hawk', 'Velocity', 'RIP Control'] },
  { k: 'kirschbaum', n: 'Kirschbaum', models: ['Max Power', 'Pro Line II'] },
  { k: 'signum', n: 'Signum Pro', models: ['Firestorm', 'Poly Plasma'] },
  { k: 'other', n: '其他品牌', models: [] },
];
const STATUS = { active: '在用', spare: '备用', retired: '已退役' };
const MAINT_ITEMS = { overgrip: '手胶', grip: '底胶', grommet: '护线管', guard: '护框贴', damper: '避震器', weight: '配重调整', other: '其他维护' };
// 可以设提醒的项目：穿线 + 常换的维护项目
const REMIND_ITEMS = { string: '穿线', overgrip: '手胶', grip: '底胶', grommet: '护线管', guard: '护框贴', damper: '避震器' };
const REMIND_DAYS = [0, 7, 14, 21, 30, 45, 60, 90, 120, 180, 365]; // 0 = 不提醒
const RACKET_TAGS = ['新拍', '二手', '比赛用', '训练用', '加了配重', '拍框有磕碰', '手感好', '偏重', '偏轻'];
const STRING_TAGS = ['弹性好', '控制好', '旋转好', '耐打', '手感硬', '手感软', '掉磅快', '断线了'];
const TENSION_MIN = 30, TENSION_MAX = 70; // 磅
const COST_MAX = 9999;
const MAX_TAGS = 5;
const MAX_RACKETS = 30;
const MAX_LOGS = 3000;
const SOON_DAYS = 7; // 提醒日前 7 天显示「快到了」
const MIN_DATE = '2000-01-01';
// 使用记录（kind: 'play'）：某天这支拍实际打了多少分钟，只存日期和整数分钟
const PLAY_MIN = 1, PLAY_MAX = 600; // 每条 1～600 分钟（一天打几场可以记几条）
// 按累计打球时长换线（racket.hours，0 / 没有 = 不提醒，默认关闭）：这次穿线后累计满 N 小时
const REMIND_HOURS = [0, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100];
const SOON_RATIO = 0.8; // 打满目标的 80% 显示「快到了」

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const dayNo = (s) => Math.round(new Date(s + 'T00:00:00Z').getTime() / 86400000);
const addDays = (s, n) => new Date((dayNo(s) + n) * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => dayNo(b) - dayNo(a);

const brandOf = (list, k) => list.find((b) => b.k === k) || null;
const modelsOf = (list, k) => { const b = brandOf(list, k); return b ? b.models.concat(OTHER) : []; };
function cleanPick(list, v) { // { brand, model } 都要在固定选项里
  const x = v && typeof v === 'object' ? v : {};
  const b = brandOf(list, x.brand);
  if (!b) return null;
  if (modelsOf(list, b.k).indexOf(x.model) < 0) return null;
  return { brand: b.k, model: x.model };
}
function cleanTags(tags, allowed) {
  const t = Array.isArray(tags) ? tags : [];
  if (t.some((x) => allowed.indexOf(x) < 0)) return { msg: '备注只能从选项里选' };
  const out = allowed.filter((x) => t.indexOf(x) >= 0);
  if (out.length > MAX_TAGS) return { msg: `备注最多选 ${MAX_TAGS} 个` };
  return { tags: out };
}
const checkDate = (s, today, label) => {
  if (!validDate(s) || s < MIN_DATE) return `请选择${label}`;
  if (today && s > today) return `${label}不能晚于今天`;
  return '';
};

/** 整理球拍档案。只取认识的字段；编号（no）由云端分配，不从这里来 */
function cleanRacket(input, today) {
  const x = input && typeof input === 'object' ? input : {};
  const pick = cleanPick(RACKET_BRANDS, x);
  if (!pick) return { ok: false, msg: '请选择品牌和型号' };
  let bought = '';
  if (x.bought) { const e = checkDate(x.bought, today, '购入日期'); if (e) return { ok: false, msg: e }; bought = x.bought; }
  if (!STATUS[x.status]) return { ok: false, msg: '请选择状态' };
  const t = cleanTags(x.tags, RACKET_TAGS);
  if (t.msg) return { ok: false, msg: t.msg };
  const remind = {};
  const r = x.remind && typeof x.remind === 'object' ? x.remind : {};
  for (const k of Object.keys(r)) {
    if (!REMIND_ITEMS[k] || REMIND_DAYS.indexOf(r[k]) < 0) return { ok: false, msg: '提醒间隔不对' };
    if (r[k]) remind[k] = r[k];
  }
  const rec = { brand: pick.brand, model: pick.model, bought, status: x.status, tags: t.tags, remind };
  // 换线时长提醒：没带这个字段（旧版小程序）就不写，云端编辑时保留原值；0 = 关闭
  if (x.hours !== undefined) {
    if (REMIND_HOURS.indexOf(x.hours) < 0) return { ok: false, msg: '换线时长提醒不对' };
    rec.hours = x.hours;
  }
  return { ok: true, rec };
}

const isTension = (v) => Number.isInteger(v) && v >= TENSION_MIN && v <= TENSION_MAX;
function cleanCost(v) {
  if (v === undefined || v === null || v === '') return { cost: null };
  const n = typeof v === 'number' ? v : Number(v);
  if (!isFinite(n) || n < 0 || n > COST_MAX) return { msg: `费用要在 0～${COST_MAX} 元之间` };
  return { cost: Math.round(n * 100) / 100 };
}

const isMinutes = (v) => Number.isInteger(v) && v >= PLAY_MIN && v <= PLAY_MAX; // 只认数字，不认 "90" 这样的字符串

/** 整理一条穿线 / 维护 / 使用记录（不含 racketId：由云端按归属校验后写入） */
function cleanLog(input, today) {
  const x = input && typeof input === 'object' ? input : {};
  if (x.kind !== 'string' && x.kind !== 'maint' && x.kind !== 'play') return { ok: false, msg: '记录类型不对' };
  const e = checkDate(x.date, today, '日期');
  if (e) return { ok: false, msg: e };
  if (x.kind === 'play') {
    if (!isMinutes(x.minutes)) return { ok: false, msg: `打球时长要填 ${PLAY_MIN}～${PLAY_MAX} 的整数分钟` };
    return { ok: true, rec: { kind: 'play', date: x.date, minutes: x.minutes } };
  }
  const c = cleanCost(x.cost);
  if (c.msg) return { ok: false, msg: c.msg };
  if (x.kind === 'maint') {
    if (!MAINT_ITEMS[x.item]) return { ok: false, msg: '请选择维护项目' };
    return { ok: true, rec: { kind: 'maint', date: x.date, item: x.item, cost: c.cost } };
  }
  const main = cleanPick(STRING_BRANDS, x.main);
  if (!main) return { ok: false, msg: '请选择球线' };
  let cross = null;
  if (x.cross) { cross = cleanPick(STRING_BRANDS, x.cross); if (!cross) return { ok: false, msg: '请选择横线的球线' }; }
  if (!isTension(x.mains) || !isTension(x.crosses)) return { ok: false, msg: `磅数要在 ${TENSION_MIN}～${TENSION_MAX} 磅之间` };
  const feel = x.feel === undefined || x.feel === null ? 0 : x.feel;
  if (!Number.isInteger(feel) || feel < 0 || feel > 5) return { ok: false, msg: '手感评分是 1～5 分' };
  const t = cleanTags(x.tags, STRING_TAGS);
  if (t.msg) return { ok: false, msg: t.msg };
  return { ok: true, rec: { kind: 'string', date: x.date, main, cross, mains: x.mains, crosses: x.crosses, cost: c.cost, feel, tags: t.tags } };
}

/* ---------- 展示文字 ---------- */
const nameOf = (list, p) => {
  if (!p) return '';
  const b = brandOf(list, p.brand);
  const bn = b ? (b.k === 'other' ? '' : b.n) : '';
  const m = p.model === OTHER ? (bn ? '其他型号' : '其他') : p.model;
  return [bn, m].filter(Boolean).join(' ');
};
const racketName = (r) => nameOf(RACKET_BRANDS, r);
const racketTitle = (r) => `${r.no || '?'} 号拍`;
// 球线：一样的写一次，混穿写「竖 … / 横 …」
function stringText(log) {
  const m = nameOf(STRING_BRANDS, log.main);
  if (!log.cross || (log.cross.brand === log.main.brand && log.cross.model === log.main.model)) return m;
  return `竖 ${m} / 横 ${nameOf(STRING_BRANDS, log.cross)}`;
}
const tensionText = (log) => (log.mains === log.crosses ? `${log.mains} 磅` : `竖 ${log.mains} · 横 ${log.crosses} 磅`);
const everyText = (d) => (!d ? '不提醒' : d % 30 === 0 ? `每 ${d / 30} 个月` : d % 7 === 0 ? `每 ${d / 7} 周` : `每 ${d} 天`);
const agoText = (n) => (n <= 0 ? '今天' : n === 1 ? '昨天' : n < 30 ? `${n} 天前` : n < 365 ? `${Math.floor(n / 30)} 个月前` : `${Math.floor(n / 365)} 年前`);
// 时长显示：小时保留一位小数（90 分钟 → 1.5），去掉多余的 .0
const hoursText = (min) => String(Math.round((min || 0) / 6) / 10);
const minutesText = (m) => (m < 60 ? `${m} 分钟` : `${Math.floor(m / 60)} 小时${m % 60 ? ` ${m % 60} 分钟` : ''}`);
const hoursEveryText = (h) => (h ? `满 ${h} 小时` : '不提醒');

const byDate = (x, y) => String(y.date).localeCompare(String(x.date)) || (y.createdAt || 0) - (x.createdAt || 0);
const ORDER = { over: 0, soon: 1, none: 2, ok: 3 };

/**
 * 这次球线的累计打球时长。只按日期划分，和记录的先后顺序无关（补录也一样）：
 *   「这次球线」从最近一次穿线的日期开始（同一天记了几次穿线，都是这一天），这一天及以后的使用记录都算进来；
 *   穿线当天记的时长算在新球线上；比这次穿线早的使用记录保留，算在以前的球线上，不再累计。
 *   还没有穿线记录时，算这支拍的全部使用记录。
 * 设了目标（racket.hours）且球拍没退役时给出状态：满目标 over、满 80% soon、其余 ok
 */
function playOf(racket, plays, lastString) {
  const since = lastString ? lastString.date : '';
  const cur = plays.filter((p) => !since || p.date >= since);
  const minutes = cur.reduce((s, p) => s + (p.minutes || 0), 0);
  const target = REMIND_HOURS.indexOf(racket.hours) > 0 ? racket.hours : 0; // 旧球拍没有这个字段 = 关闭
  const out = { since, minutes, hours: hoursText(minutes), sessions: cur.length, target, state: '', text: '', pct: 0 };
  if (!target) return out;
  const goal = target * 60;
  out.pct = Math.min(100, Math.round((minutes / goal) * 100));
  if (racket.status === 'retired') return out;
  out.state = minutes >= goal ? 'over' : minutes >= goal * SOON_RATIO ? 'soon' : 'ok';
  out.text = minutes > goal ? `已超过 ${hoursText(minutes - goal)} 小时` : minutes === goal ? '刚好打满' : `还差 ${Math.ceil((goal - minutes) / 6) / 10} 小时`;
  return out;
}

/**
 * 一支球拍的统计和提醒。logs 可以是本人全部记录，这里只取这支拍的
 * 提醒：最近一次该项目的记录 + 间隔；没有记录时从购入日期算；都没有就提示「还没有记录」。已退役的球拍不提醒
 * 穿线另外可以按打球时长提醒（racket.hours）：和按天的穿线提醒合成同一条「穿线」，哪个条件更急就显示哪个，
 * 两个都到了也只算一项（tab 上的数字、列表里的提示都按这一条）
 */
function summary(racket, logs, today) {
  const mine = (logs || []).filter((l) => l.racketId === racket.id).sort(byDate);
  const strings = mine.filter((l) => l.kind === 'string');
  const maints = mine.filter((l) => l.kind === 'maint');
  const plays = mine.filter((l) => l.kind === 'play');
  const lastOf = (item) => (item === 'string' ? strings[0] : maints.find((l) => l.item === item)) || null;
  const last = strings[0] || null;
  const play = playOf(racket, plays, last);
  const reminders = [];
  if (racket.status !== 'retired') {
    Object.keys(REMIND_ITEMS).forEach((item) => {
      const every = (racket.remind || {})[item] || 0;
      const hours = item === 'string' ? play.target : 0;
      if (!every && !hours) return;
      let r;
      if (!every) r = { item, label: REMIND_ITEMS[item], every: 0, everyText: hoursEveryText(hours), state: play.state, text: play.text };
      else {
        const lastLog = lastOf(item);
        const base = lastLog ? lastLog.date : racket.bought || '';
        if (!base) r = { item, label: REMIND_ITEMS[item], every, everyText: everyText(every), state: 'none', text: '还没有记录' };
        else {
          const due = addDays(base, every), left = daysBetween(today, due);
          const state = left < 0 ? 'over' : left <= SOON_DAYS ? 'soon' : 'ok';
          const text = left < 0 ? `已超过 ${-left} 天` : left === 0 ? '就是今天' : `还有 ${left} 天`;
          r = { item, label: REMIND_ITEMS[item], every, everyText: everyText(every), due, left, state, text };
        }
        if (hours && ORDER[play.state] < ORDER[r.state]) { r.state = play.state; r.text = play.text; } // 时长更急：显示时长
      }
      if (hours) Object.assign(r, { hours, played: play.hours });
      reminders.push(r);
    });
  }
  reminders.sort((a, b) => ORDER[a.state] - ORDER[b.state] || (a.left || 0) - (b.left || 0));
  const costs = mine.filter((l) => typeof l.cost === 'number');
  return {
    stringCount: strings.length, maintCount: maints.length,
    lastString: last ? { date: last.date, ago: agoText(daysBetween(last.date, today)), text: stringText(last), tension: tensionText(last) } : null,
    cost: Math.round(costs.reduce((s, l) => s + l.cost, 0) * 100) / 100,
    reminders, due: reminders.filter((r) => r.state === 'over' || r.state === 'soon').length,
    timeline: mine.filter((l) => l.kind !== 'play'), // 穿线 / 维护；使用记录单独列（plays）
    play, plays,
  };
}

/** 全部球拍的总览：球拍数、累计穿线 / 维护次数、待处理提醒数 */
function overview(rackets, logs, today) {
  const ids = {};
  (rackets || []).forEach((r) => { ids[r.id] = 1; });
  const mine = (logs || []).filter((l) => ids[l.racketId]);
  const due = (rackets || []).reduce((n, r) => n + summary(r, mine, today).due, 0);
  const strings = mine.filter((l) => l.kind === 'string').sort(byDate);
  return {
    rackets: (rackets || []).length, inUse: (rackets || []).filter((r) => r.status !== 'retired').length,
    stringCount: strings.length, maintCount: mine.filter((l) => l.kind === 'maint').length, // 使用记录不算维护
    lastString: strings[0] ? strings[0].date : '', due,
  };
}

/**
 * 装备年度花费与换线 / 断线周期统计（纯私人统计，直接复用现有 rackets / racket_logs，不加新集合）：
 * - 当年花费（总花费 / 穿线花费 / 维护花费）、当年穿线 / 维护次数、当年打球总时长、当年断线次数（标签含「断线了」）
 * - 全部记录里的平均换线周期（按每支拍相邻两次穿线的间隔天数与期间打球时长平均）、最常用球线
 */
function yearlyStats(rackets, logs, today) {
  const year = String(today || '').slice(0, 4) || String(new Date().getFullYear());
  const prefix = year + '-';
  const ids = {};
  (rackets || []).forEach((r) => { ids[r.id] = 1; });
  const mine = (logs || []).filter((l) => ids[l.racketId]);
  const round2 = (n) => Math.round(n * 100) / 100;

  let stringCost = 0, maintCost = 0, allCost = 0;
  let yearStrings = 0, yearMaints = 0, yearPlayMin = 0, brokenYear = 0, brokenAll = 0;
  const strFreq = {};

  mine.forEach((l) => {
    const inYear = String(l.date || '').indexOf(prefix) === 0;
    const cost = typeof l.cost === 'number' ? l.cost : 0;
    allCost += cost;
    if (l.kind === 'string') {
      const broken = Array.isArray(l.tags) && l.tags.indexOf('断线了') >= 0;
      if (broken) brokenAll++;
      if (inYear) { yearStrings++; stringCost += cost; if (broken) brokenYear++; }
      const sn = stringText(l);
      if (sn) {
        const cur = strFreq[sn] || { name: sn, count: 0, last: '' };
        cur.count++;
        if (String(l.date || '') > cur.last) cur.last = String(l.date || '');
        strFreq[sn] = cur;
      }
    } else if (l.kind === 'maint') {
      if (inYear) { yearMaints++; maintCost += cost; }
    } else if (l.kind === 'play') {
      if (inYear) yearPlayMin += l.minutes || 0;
    }
  });

  // 换线周期：按每支拍的时间升序找相邻两次穿线间隔（天数 + 期间累计打球分钟数）
  const dayGaps = [], minGaps = [];
  (rackets || []).forEach((r) => {
    const rLogs = mine.filter((l) => l.racketId === r.id);
    const strs = rLogs.filter((l) => l.kind === 'string').sort((x, y) => String(x.date).localeCompare(String(y.date)) || (x.createdAt || 0) - (y.createdAt || 0));
    const pLogs = rLogs.filter((l) => l.kind === 'play');
    for (let i = 1; i < strs.length; i++) {
      const a = strs[i - 1].date, b = strs[i].date;
      const d = daysBetween(a, b);
      if (d > 0) dayGaps.push(d);
      const mins = pLogs.filter((p) => p.date >= a && p.date < b).reduce((s, p) => s + (p.minutes || 0), 0);
      if (mins > 0) minGaps.push(mins);
    }
  });
  const avgDays = dayGaps.length ? Math.round(dayGaps.reduce((s, x) => s + x, 0) / dayGaps.length) : null;
  const avgHours = minGaps.length ? hoursText(Math.round(minGaps.reduce((s, x) => s + x, 0) / minGaps.length)) : '';
  const topString = Object.keys(strFreq).map((k) => strFreq[k])
    .sort((x, y) => y.count - x.count || y.last.localeCompare(x.last))[0] || null;

  stringCost = round2(stringCost);
  maintCost = round2(maintCost);
  const yearCost = round2(stringCost + maintCost);
  allCost = round2(allCost);
  return {
    year, yearCost, stringCost, maintCost, allCost,
    yearStrings, yearMaints, yearPlayMin, yearPlayHours: hoursText(yearPlayMin),
    avgDays, avgHours, brokenYear, brokenAll,
    topString: topString ? { name: topString.name, count: topString.count } : null,
    hasData: !!(yearCost || yearStrings || yearMaints || yearPlayMin || avgDays !== null || topString),
  };
}

// 球拍贴铅片配重计算（标准 27 英寸 = 685.8mm 球拍力学公式；纯前端工具，无存储）
// 四个经典配重位置距拍底距离（mm）：12 点拍顶 665、3/9 点拍框两侧 510、拍喉三角区 340、手柄内部 60
const TUNE_POS = { top: 665, side: 510, throat: 340, handle: 60 };
const RACKET_MID_MM = 342.9; // 27 英寸球拍中点（13.5 英寸）
const PT_MM = 3.175;         // 1 pt = 1/8 英寸
function tuneRacket(input) {
  const x = input || {};
  const clampN = (v, lo, hi, def) => {
    const n = Number(v);
    return isFinite(n) && n > 0 ? Math.max(lo, Math.min(hi, n)) : def;
  };
  const lead = (v) => {
    const n = Number(v);
    return isFinite(n) && n > 0 ? Math.min(40, Math.round(n * 10) / 10) : 0;
  };
  const r1 = (n) => Math.round(n * 10) / 10;
  const weight = r1(clampN(x.weight, 200, 400, 300));
  const balance = r1(clampN(x.balance, 280, 380, 320));
  const top = lead(x.top), side = lead(x.side), throat = lead(x.throat), handle = lead(x.handle);
  const added = r1(top + side + throat + handle);
  const newWeight = r1(weight + added);
  const newBalance = r1((weight * balance + top * TUNE_POS.top + side * TUNE_POS.side + throat * TUNE_POS.throat + handle * TUNE_POS.handle) / newWeight);
  const balDiff = r1(newBalance - balance);
  const ptsRaw = (RACKET_MID_MM - newBalance) / PT_MM;
  const ptsHalf = Math.round(Math.abs(ptsRaw) * 2) / 2;
  const balTag = Math.abs(ptsRaw) < 0.25 ? '均衡' : ptsRaw > 0 ? `${ptsHalf} pts 头轻` : `${ptsHalf} pts 头重`;
  // 挥重增量 ΔSW (kg·cm²，标准 10cm 支点)：(m / 1000) * (d_cm - 10)^2
  const swOf = (g, mm) => (g / 1000) * Math.pow(mm / 10 - 10, 2);
  const swDelta = r1(swOf(top, TUNE_POS.top) + swOf(side, TUNE_POS.side) + swOf(throat, TUNE_POS.throat) + swOf(handle, TUNE_POS.handle));

  let feel;
  if (added === 0) feel = '调节下方 4 个位置的铅片克数，实时看总重、平衡点和挥重变化';
  else {
    const notes = [];
    if (balDiff >= 3) notes.push('明显偏向头重，发力更穿透');
    else if (balDiff <= -3) notes.push('更偏头轻，挥拍与网前更灵活');
    else notes.push('平衡点基本保持原手感');
    if (side >= 2) notes.push('3/9 点增稳、甜区扩大');
    if (swDelta >= 12) notes.push('挥重涨幅较大，建议循序渐进试打');
    else if (swDelta >= 5) notes.push('挥重适度提升，击球更扎实');
    feel = notes.join('；');
  }
  return { weight, balance, top, side, throat, handle, added, newWeight, newBalance, balDiff, balTag, swDelta, feel };
}

// 按比赛局分估算打球时长（分钟，5 分钟取整，25～180 分钟，兜底 60 分钟）：用于录完比赛后顺手记入球拍打球时长
function estimateMatchMins(sets) {
  const arr = Array.isArray(sets) ? sets : [];
  let games = 0;
  arr.forEach((s) => { games += (Number(s && s.a) || 0) + (Number(s && s.b) || 0); });
  if (!games) return 60;
  return Math.max(25, Math.min(180, Math.round((games * 4.5) / 5) * 5));
}

// 在役球拍精简列表（按编号升序）：给录分后的顺手记时长弹层用
function liveRackets(rackets) {
  return (rackets || [])
    .filter((r) => r && r.status !== 'retired')
    .sort((a, b) => (a.no || 0) - (b.no || 0))
    .map((r) => ({ id: r.id, title: racketTitle(r), name: racketName(r) }));
}

module.exports = {
  OTHER, RACKET_BRANDS, STRING_BRANDS, STATUS, MAINT_ITEMS, REMIND_ITEMS, REMIND_DAYS, REMIND_HOURS, RACKET_TAGS, STRING_TAGS,
  TENSION_MIN, TENSION_MAX, COST_MAX, MAX_TAGS, MAX_RACKETS, MAX_LOGS, SOON_DAYS, PLAY_MIN, PLAY_MAX, SOON_RATIO,
  validDate, addDays, daysBetween, modelsOf, cleanRacket, cleanLog,
  racketName, racketTitle, stringText, tensionText, everyText, agoText, hoursText, minutesText, hoursEveryText, summary, overview, yearlyStats, tuneRacket,
  estimateMatchMins, liveRackets,
};
