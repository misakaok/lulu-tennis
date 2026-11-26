// 管理员常用活动模板库（纯本机存储，最多 5 套自定义模板 + 3 套快捷默认预设，退出成员身份随 clearProtected 自动清理）：
//   支持一键保存当前建活动配置（形式、单双打、组别、报名上限、全部阶段/轮次规则、开打时间、场地编号、地图定位、建议水平与积分设置），
//   套用时日期永远保持今天，不改已选球友名单，免去每次重复填表。
const E = require('../../utils/event');
const C = require('../../utils/cup');

const STORAGE_KEY = 'admin_draw_templates_v1';
const MAX_TEMPLATES = 5;

const BUILTINS = [
  {
    id: 'builtin_rot',
    builtin: true,
    name: '四人轮换双打 · 4局金球',
    mode: 'rotation', size: 8, groupCount: 4, advance: 2,
    type: 'double', category: '', limit: 0,
    rules: { group: { setGames: 4, noAd: true, bestOf: 1 }, ko: { setGames: 4, noAd: true, bestOf: 1 }, rounds: {} },
    startTime: '19:30', venue: '', location: null, place: null, level: { min: 2.5, max: 3.5 },
    cupOn: false, cupKind: 'weekly', cupPointGroup: 'open',
  },
  {
    id: 'builtin_ko8',
    builtin: true,
    name: '周末 8 签单淘汰 · 6局金球',
    mode: 'bracket', size: 8, groupCount: 4, advance: 2,
    type: 'single', category: '', limit: 0,
    rules: { group: { setGames: 6, noAd: true, bestOf: 1 }, ko: { setGames: 6, noAd: true, bestOf: 1 }, rounds: {} },
    startTime: '09:00', venue: '', location: null, place: null, level: { min: 3.0, max: 3.5 },
    cupOn: false, cupKind: 'weekly', cupPointGroup: 'open',
  },
  {
    id: 'builtin_gk',
    builtin: true,
    name: '循环＋淘汰 · 2组前2',
    mode: 'groups_ko', size: 8, groupCount: 2, advance: 2,
    type: 'single', category: '', limit: 8,
    rules: { group: { setGames: 4, noAd: true, bestOf: 1 }, ko: { setGames: 6, noAd: true, bestOf: 1 }, rounds: {} },
    startTime: '14:00', venue: '', location: null, place: null, level: null,
    cupOn: false, cupKind: 'weekly', cupPointGroup: 'open',
  },
];

function readAll() {
  try {
    const raw = typeof wx !== 'undefined' && wx.getStorageSync ? wx.getStorageSync(STORAGE_KEY) : null;
    return Array.isArray(raw) ? raw.filter((x) => x && x.id && x.mode) : [];
  } catch (e) { return []; }
}

function writeAll(list) {
  try {
    if (typeof wx !== 'undefined' && wx.setStorageSync) wx.setStorageSync(STORAGE_KEY, list);
  } catch (e) {}
}

function defaultLabel(cfg) {
  const modeLbl = E.MODES[cfg.mode] || '活动';
  const typeLbl = cfg.mode === 'rotation' ? '双打' : (cfg.type === 'double' ? '双打' : '单打');
  const lv = E.levelRangeText({ level: cfg.level });
  const parts = [cfg.startTime, lv, `${typeLbl}${modeLbl}`].filter(Boolean);
  return parts.join(' · ').slice(0, 20) || `${typeLbl}${modeLbl}`;
}

function describe(t) {
  const modeLbl = E.MODES[t.mode] || '活动';
  const typeLbl = t.mode === 'rotation' ? '双打' : (t.type === 'double' ? '双打' : '单打');
  const rule = E.normRule(t.mode === 'bracket' ? (t.rules && t.rules.ko) : (t.rules && t.rules.group));
  const parts = [modeLbl, typeLbl, E.ruleText(rule)];
  const lv = E.levelRangeText({ level: t.level });
  if (lv) parts.push(lv);
  if (t.startTime) parts.push(t.startTime);
  if (t.cupOn && C.kindText(t.cupKind)) parts.push(`积分·${C.kindText(t.cupKind)}`);
  return parts.join(' · ');
}

function buildTemplate(input) {
  const x = input || {};
  const isRot = x.mode === 'rotation';
  const mode = E.MODES[x.mode] ? x.mode : 'bracket';
  const type = isRot ? 'double' : (x.type === 'double' ? 'double' : 'single');
  const rawTitle = String(x.title || '').trim();
  const isAutoTitle = /^\d{1,2}月\d{1,2}日\s*内部赛$/.test(rawTitle);
  const rules = E.stageRules({ mode, type, rules: x.rules });
  const rec = {
    id: x.id || `tpl_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
    builtin: false,
    name: (!rawTitle || isAutoTitle) ? defaultLabel(x) : rawTitle.slice(0, 20),
    title: (!rawTitle || isAutoTitle) ? '' : rawTitle.slice(0, 20),
    mode,
    size: Number(x.size) || 8,
    groupCount: Number(x.groupCount) || 4,
    advance: x.advance === 1 ? 1 : 2,
    type,
    category: isRot && x.category === 'mixed' ? '' : (x.category || ''),
    limit: isRot || mode === 'bracket' ? 0 : (Number(x.limit) || 0),
    rules,
    startTime: x.startTime || '',
    venue: E.courtOf(x.venue),
    location: E.locationOf(x.location),
    place: x.location ? E.placeOf(x.place) : null,
    level: E.levelRangeOf(x.level),
    cupOn: !isRot && !!x.cupOn && !C.drawCupError({ mode }, x.cupKind),
    cupKind: C.kindText(x.cupKind) ? x.cupKind : 'weekly',
    cupPointGroup: C.pointGroupText(x.cupPointGroup) ? x.cupPointGroup : 'open',
    savedAt: Date.now(),
  };
  return rec;
}

function listTemplates() {
  const saved = readAll().map((t) => Object.assign({}, t, { meta: describe(t) }));
  const builtins = BUILTINS.map((t) => Object.assign({}, t, { meta: describe(t) }));
  return { saved, builtins, max: MAX_TEMPLATES };
}

function saveTemplate(input) {
  const cur = readAll();
  const rec = buildTemplate(input);
  // 同名覆盖更新，否则新增（最多 MAX_TEMPLATES 套）
  const dupIdx = cur.findIndex((x) => x.name === rec.name);
  let next;
  if (dupIdx >= 0) {
    rec.id = cur[dupIdx].id;
    next = cur.slice();
    next[dupIdx] = rec;
  } else {
    if (cur.length >= MAX_TEMPLATES) {
      return { ok: false, msg: `最多保存 ${MAX_TEMPLATES} 套模板，请先删掉不常用的` };
    }
    next = [rec].concat(cur);
  }
  writeAll(next);
  return { ok: true, rec, updated: dupIdx >= 0, all: listTemplates() };
}

function removeTemplate(id) {
  const next = readAll().filter((x) => x.id !== id);
  writeAll(next);
  return listTemplates();
}

module.exports = {
  STORAGE_KEY,
  MAX_TEMPLATES,
  BUILTINS,
  describe,
  buildTemplate,
  listTemplates,
  saveTemplate,
  removeTemplate,
};
