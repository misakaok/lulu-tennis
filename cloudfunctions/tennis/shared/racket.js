// 我的球拍（只有本人可见）：球拍档案、穿线 / 维护记录的字段校验、提醒和统计。小程序端和云函数共用（scripts/sync-shared.sh）。
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
  return { ok: true, rec: { brand: pick.brand, model: pick.model, bought, status: x.status, tags: t.tags, remind } };
}

const isTension = (v) => Number.isInteger(v) && v >= TENSION_MIN && v <= TENSION_MAX;
function cleanCost(v) {
  if (v === undefined || v === null || v === '') return { cost: null };
  const n = typeof v === 'number' ? v : Number(v);
  if (!isFinite(n) || n < 0 || n > COST_MAX) return { msg: `费用要在 0～${COST_MAX} 元之间` };
  return { cost: Math.round(n * 100) / 100 };
}

/** 整理一条穿线 / 维护记录（不含 racketId：由云端按归属校验后写入） */
function cleanLog(input, today) {
  const x = input && typeof input === 'object' ? input : {};
  if (x.kind !== 'string' && x.kind !== 'maint') return { ok: false, msg: '记录类型不对' };
  const e = checkDate(x.date, today, '日期');
  if (e) return { ok: false, msg: e };
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

const byDate = (x, y) => String(y.date).localeCompare(String(x.date)) || (y.createdAt || 0) - (x.createdAt || 0);

/**
 * 一支球拍的统计和提醒。logs 可以是本人全部记录，这里只取这支拍的
 * 提醒：最近一次该项目的记录 + 间隔；没有记录时从购入日期算；都没有就提示「还没有记录」。已退役的球拍不提醒
 */
function summary(racket, logs, today) {
  const mine = (logs || []).filter((l) => l.racketId === racket.id).sort(byDate);
  const strings = mine.filter((l) => l.kind === 'string');
  const maints = mine.filter((l) => l.kind === 'maint');
  const lastOf = (item) => (item === 'string' ? strings[0] : maints.find((l) => l.item === item)) || null;
  const reminders = [];
  if (racket.status !== 'retired') {
    Object.keys(REMIND_ITEMS).forEach((item) => {
      const every = (racket.remind || {})[item];
      if (!every) return;
      const last = lastOf(item);
      const base = last ? last.date : racket.bought || '';
      if (!base) { reminders.push({ item, label: REMIND_ITEMS[item], every, everyText: everyText(every), state: 'none', text: '还没有记录' }); return; }
      const due = addDays(base, every), left = daysBetween(today, due);
      const state = left < 0 ? 'over' : left <= SOON_DAYS ? 'soon' : 'ok';
      const text = left < 0 ? `已超过 ${-left} 天` : left === 0 ? '就是今天' : `还有 ${left} 天`;
      reminders.push({ item, label: REMIND_ITEMS[item], every, everyText: everyText(every), due, left, state, text });
    });
  }
  const order = { over: 0, soon: 1, none: 2, ok: 3 };
  reminders.sort((a, b) => order[a.state] - order[b.state] || (a.left || 0) - (b.left || 0));
  const last = strings[0] || null;
  const costs = mine.filter((l) => typeof l.cost === 'number');
  return {
    stringCount: strings.length, maintCount: maints.length,
    lastString: last ? { date: last.date, ago: agoText(daysBetween(last.date, today)), text: stringText(last), tension: tensionText(last) } : null,
    cost: Math.round(costs.reduce((s, l) => s + l.cost, 0) * 100) / 100,
    reminders, due: reminders.filter((r) => r.state === 'over' || r.state === 'soon').length,
    timeline: mine,
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
    stringCount: strings.length, maintCount: mine.length - strings.length,
    lastString: strings[0] ? strings[0].date : '', due,
  };
}

module.exports = {
  OTHER, RACKET_BRANDS, STRING_BRANDS, STATUS, MAINT_ITEMS, REMIND_ITEMS, REMIND_DAYS, RACKET_TAGS, STRING_TAGS,
  TENSION_MIN, TENSION_MAX, COST_MAX, MAX_TAGS, MAX_RACKETS, MAX_LOGS, SOON_DAYS,
  validDate, addDays, daysBetween, modelsOf, cleanRacket, cleanLog,
  racketName, racketTitle, stringText, tensionText, everyText, agoText, summary, overview,
};
