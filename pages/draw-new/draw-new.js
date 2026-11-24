// 创建球友活动：先定好赛制（单双打、局制、金球、盘数、淘汰 / 小组），再开放报名或直接选人抽签
const D = require('../../utils/draw');
const E = require('../../utils/event');
const R = require('../../utils/rating');
const db = require('../../utils/db');
const ID = require('../../utils/ident');
const PL = require('../../utils/places');
const C = require('../../utils/cup');
const cloud = require('../../utils/cloud');

const pad = (n) => (n < 10 ? '0' + n : '' + n);
const SIZES = [8, 12, 16, 24, 32];
const GROUPS = [1, 2, 3, 4, 6, 8]; // 1 组 = 所有人一个小组大循环
// 分组循环的报名上限（单打按人、双打按队）；双打多一个「2 队」= 4 人，凑一场双打用
const LIMITS = { single: [0, 6, 8, 12, 16, 24, 32], double: [0, 2, 6, 8, 12, 16, 24, 32] };
const CFG_KEY = 'last_event_rules';
const DEF_RULE = { setGames: 4, noAd: true, bestOf: 1 };

// 地点名称没通过内容检测：活动照常创建，只保存了地图位置（提示会带到下一页）
const PLACE_DROPPED = { title: '已创建。地点名称没通过安全检测，只保存了地图位置', icon: 'none', duration: 2500 };

Page({
  data: {
    canPublish: false, authError: '', title: '', mode: 'bracket', size: 8, groupCount: 4, entry: 'signup',
    type: 'single', advance: 2, byRound: false, koInfo: '',
    category: '', limit: 0, limits: LIMITS.single, waitInfo: '',
    rules: { group: DEF_RULE, ko: DEF_RULE, rounds: {} }, koRoundList: [], rulesSum: [],
    sizes: SIZES, groupOpts: GROUPS,
    chips: [], seedChips: [], seedList: [], teamList: [],
    info: '', seedInfo: '', canDraw: false, preview: null, manualOpts: [], manualIndexes: [], manualLabels: [], saving: false,
    manualOnly: false, editingMatchups: false,
    pre: [], preSheet: null, // 开放报名时先加入的球友：[{ key, ids, who, playerId, partnerId, text, names }]；preSheet 是选人弹层
    recentPlaces: [], heroTop: '', heroSub: '',
    cupOn: false, cupKind: 'weekly', cupKinds: C.ACTIVE_KINDS, cupPointGroup: 'open', cupPointGroups: C.POINT_GROUPS, cupErr: '', cupNote: '', cupText: '',
    fromSignup: false, // 从「报名」进来：用报名名单抽签，赛制已锁定
    editingSettings: false, settingsLoading: false, fixedRotation: false,
  },

  async onLoad(options) {
    const editingSettings = !!(options && options.id && options.settings === '1');
    // 每次打开都实时校验身份；本机记得是管理员（24 小时内确认过）就先显示表单、校验在后台跑，不通过再收起（提交仍由云端校验）
    const M = require('../../utils/member');
    const check = M.status().then((m) => (m.status === 'active' && m.isAdmin ? '' : '只有管理员可以发布活动'), () => '身份校验失败，请返回后重试');
    const lock = (err) => { if (err) this.setData({ canPublish: false, authError: err }); return !!err; };
    if (M.knownActive() && M.isAdminLocal()) check.then(lock);
    else if (lock(await check)) return;
    this.setData({ canPublish: true, authError: '' });
    const d = new Date();
    this.date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    this.selected = []; // 选中的球员（双打按顺序两两组队）
    this.seeds = [];    // 种子（参赛单位：单打是名字，双打是「张三 / 李四」）
    this.players = [];
    if (editingSettings) {
      this.drawId = options.id;
      this.setData({ editingSettings: true, settingsLoading: true });
      await this.loadSettings();
      return;
    }
    this.setPlayers(db.cachedPlayersFull());
    let last = {};
    try { last = wx.getStorageSync(CFG_KEY) || {}; } catch (e) {}
    // 记住上次的赛制设置（含分阶段 / 分轮次规则）
    const st = E.stageRules(last);
    const lastType = E.cfgOf(last).type;
    this.setData({ type: lastType, limits: LIMITS[lastType === 'double' ? 'double' : 'single'], rules: st, byRound: Object.keys(st.rounds).length > 0 });
    if (options && options.id) {
      this.drawId = options.id;
      this.setData({ fromSignup: true, entry: 'pick', manualOnly: options.manual === '1' });
      wx.setNavigationBarTitle({ title: '截止报名 · 生成对阵' });
      this.loadSignups();
    } else {
      this.setData({ title: `${d.getMonth() + 1}月${d.getDate()}日 内部赛` }); // 默认填好当天的名称，可以改
      this.loadPlayers();
      this.loadRecentPlaces();
    }
    this.refresh();
  },

  async loadSettings() {
    try {
      const d = await db.getDraw(this.drawId);
      if (d.status !== 'signup') throw new Error('对阵生成后不能修改活动规则');
      const { type } = E.cfgOf(d);
      const rules = E.stageRules(d), cup = C.drawCupOf(d);
      this.settingsVersion = d.settingsVersion || 0;
      wx.setNavigationBarTitle({ title: '修改活动规则' });
      this.setData({
        title: d.title, mode: d.mode, size: d.size || 8, groupCount: d.groupCount || 4, advance: d.advance === 1 ? 1 : 2,
        type, category: E.categoryOf(d), rules, byRound: Object.keys(rules.rounds).length > 0,
        limit: d.limit || 0, limits: LIMITS[type], fixedRotation: E.isRotation(d),
        cupOn: !!cup, cupKind: cup ? cup.kind : 'weekly', cupText: C.drawCupText(d),
      });
      this.refresh();
      this.setData({ settingsLoading: false });
    } catch (e) {
      this.setData({ canPublish: false, settingsLoading: false, authError: e.message || '读取活动失败' });
    }
  },

  setPlayers(full) {
    this.fullPlayers = full || []; // levelOf 用：不在排序比较里反复读本机存储
    this.nameUid = Object.assign(this.nameUid || {}, ID.uidByName(full));
    const names = full.map((p) => p.name);
    this.players.forEach((n) => { if (names.indexOf(n) < 0) names.push(n); });
    this.players = names;
  },

  // 最近使用的地点：先用本机缓存的活动马上显示，再用最新的活动列表更新（读不到就保持缓存的）
  loadRecentPlaces() {
    this.setData({ recentPlaces: PL.recentPlaces(db.cachedDraws()) });
    return db.drawsShared().then((list) => { this.setData({ recentPlaces: PL.recentPlaces(list) }); }).catch(() => {});
  },

  async loadPlayers() {
    try {
      const [full, matches] = await Promise.all([db.fetchPlayersFull(), db.fetchMatches()]);
      this.setPlayers(full);
      this.ratings = R.computeRatings(matches, R.startLevelsFrom(full));
      this.refresh();
    } catch (e) { console.error(e); }
  },

  // 报名模式：读取活动设置和报名名单，默认全部参赛，按水平推荐种子
  async loadSignups() {
    try {
      const [draw, signups, full, matches] = await Promise.all([
        db.getDraw(this.drawId), db.fetchSignups(this.drawId), db.fetchPlayersFull(), db.fetchMatches(),
      ]);
      this.setPlayers(full);
      this.ratings = R.computeRatings(matches, R.startLevelsFrom(full));
      const editingMatchups = draw.status !== 'signup';
      if (editingMatchups && (!this.data.manualOnly || E.isRotation(draw) || Object.keys(draw.results || {}).length ||
          (draw.withdrawals || []).length || matches.some((m) => m.drawId === this.drawId))) throw new Error('当前活动不能调整对阵');
      this.originalMatchups = editingMatchups ? draw : null;
      this.signUid = ID.drawUids(draw, signups);
      const cfg = E.cfgOf(draw), st = E.stageRules(draw);
      this.settingsVersion = draw.settingsVersion || 0;
      this.rosterVersion = draw.rosterVersion || 0;
      this.drawVersion = draw.drawVersion || 0;
      // 双打：已经带搭档的先排，单人报名的排在后面按顺序两两配对
      const names = [];
      const push = (n) => { if (n && names.indexOf(n) < 0) names.push(n); };
      // 候补的不默认参赛：留在可选名单里，发起人想让谁上可以自己点
      const wait = E.waitingOf(signups, E.capacityOf(draw));
      const inList = signups.filter((s) => !wait[s._id]), waiting = signups.filter((s) => wait[s._id]);
      if (editingMatchups) {
        (draw.entrants || []).forEach((ent) => E.membersOf(draw, ent).forEach(push));
      } else if (cfg.type === 'double') {
        inList.filter((s) => s.partner).forEach((s) => { push(s.name); push(s.partner); });
        let solos = inList.filter((s) => !s.partner).map((s) => s.name);
        // 混双：没搭档的按「一男一女」交替排，按顺序两两配对时尽量凑成混双（性别读个人资料）
        if (E.categoryOf(draw) === 'mixed') {
          const gOf = require('../../utils/stats').genderFinder(full);
          const men = solos.filter((n) => gOf(n, this.signUid[n]) === '男'), women = solos.filter((n) => gOf(n, this.signUid[n]) === '女');
          const rest = solos.filter((n) => men.indexOf(n) < 0 && women.indexOf(n) < 0);
          const mixed = [];
          while (men.length && women.length) { mixed.push(men.shift()); mixed.push(women.shift()); }
          solos = mixed.concat(men, women, rest);
        }
        solos.forEach(push);
      } else inList.forEach((s) => push(s.name));
      names.forEach((n) => { if (this.players.indexOf(n) < 0) this.players.push(n); });
      waiting.forEach((s) => [s.name, s.partner].forEach((n) => { if (n && this.players.indexOf(n) < 0) this.players.push(n); }));
      this.selected = names.slice();
      this.setData({
        category: E.categoryOf(draw), limit: draw.limit || 0, cupText: C.drawCupText(draw),
        waitInfo: !editingMatchups && waiting.length ? `有 ${waiting.length} 条报名在候补，没有默认选上；需要的话可以在下面的名单里点选` : '',
        editingMatchups,
        title: draw.title, mode: draw.mode, size: draw.size || 8, groupCount: draw.groupCount || 4, advance: draw.advance === 1 ? 1 : 2,
        type: cfg.type, limits: LIMITS[cfg.type === 'double' ? 'double' : 'single'], rules: st, byRound: Object.keys(st.rounds).length > 0,
      });
      if (editingMatchups) {
        this.seeds = (draw.seeds || []).slice();
        wx.setNavigationBarTitle({ title: '手动调整对阵' });
        this.refresh();
        if (this.data.canDraw) this.doDraw();
      } else {
        this.recommendSeeds(true);
      }
    } catch (e) {
      console.error(e);
      this.setData({ canPublish: false, authError: e.message || '读取报名名单失败' });
    }
  },

  isDouble() { return this.data.type === 'double'; },

  // 参赛单位和双打队伍
  entrants() {
    if (!this.isDouble() || this.isRot()) { this.teams = null; return this.selected.slice(); } // 四人轮换：参加者是 4 位球员，搭档每轮由公式定
    const out = [], teams = {};
    for (let i = 0; i + 1 < this.selected.length; i += 2) {
      const pair = [this.selected[i], this.selected[i + 1]];
      const label = E.teamLabel(pair);
      teams[label] = pair;
      out.push(label);
    }
    this.teams = teams;
    return out;
  },
  membersOf(ent) { return (this.teams && this.teams[ent]) || [ent]; },

  levelOf(name) { return this.ratings ? R.levelOf(this.ratings, name, this.fullPlayers || []) : R.DEFAULT_LEVEL; },
  levelOfEnt(ent) {
    const ms = this.membersOf(ent);
    return ms.reduce((s, n) => s + this.levelOf(n), 0) / ms.length;
  },

  isGroups() { return this.data.mode !== 'bracket' && !this.isRot(); }, // 小组赛、小组赛＋淘汰赛都要先分组
  isRot() { return this.data.mode === 'rotation'; },
  maxSeeds(n) {
    if (this.isRot()) return 0; // 四人轮换没有种子
    return D.maxSeeds(this.isGroups() ? 'groups' : 'bracket', this.isGroups() ? this.data.groupCount : this.data.size, n);
  },
  recSeeds(n) { if (this.isRot()) return 0; return Math.min(this.maxSeeds(n), this.isGroups() ? this.data.groupCount : D.nextPow2(this.data.size) / 4); },
  // 种子的叫法：单打「N 位种子选手」，双打「N 支种子队伍」（只在种子设置相关的界面用「种子」）
  seedUnit() { return this.isDouble() ? '支' : '位'; },
  seedName() { return this.isDouble() ? '种子队伍' : '种子选手'; },

  // 按水平分推荐种子
  recommendSeeds(silent) {
    const ents = this.entrants();
    const sorted = ents.slice().sort((a, b) => this.levelOfEnt(b) - this.levelOfEnt(a));
    this.seeds = sorted.slice(0, this.recSeeds(ents.length));
    this.setData({ preview: null });
    this.refresh();
    if (!silent) wx.showToast({ title: `已按水平推荐 ${this.seeds.length} ${this.seedUnit()}${this.seedName()}`, icon: 'none' });
  },

  // 顶部概要：形式 · 签数 / 组数 · 参加方式；日期 · 时间 · 单双打 · 组别
  setHero() {
    const { mode, size, groupCount, entry, type, category, fromSignup } = this.data;
    const i = this.info || {};
    const top = mode === 'rotation' ? [E.MODES.rotation, '4 人', fromSignup ? '' : '开放报名']
      : [E.MODES[mode], mode === 'bracket' ? `${size} 签` : (groupCount === 1 ? '大循环' : `${groupCount} 组`), fromSignup ? '' : (entry === 'signup' ? '开放报名' : '我来选人')];
    if (this.data.editingSettings && this.data.cupText) top.unshift(this.data.cupText);
    else if (this.data.cupOn && !fromSignup) top.unshift(C.drawCupText({ cup: { kind: this.data.cupKind, pointGroup: this.data.cupPointGroup } }));
    const cat = { m: '男子', f: '女子', mixed: '混双' }[category] || '';
    const sub = (fromSignup ? [] : [E.dayText(i.date) || '日期待定', i.startTime || '时间待定']).concat([type === 'double' ? '双打' : '单打', cat]);
    const heroTop = top.filter(Boolean).join(' · '), heroSub = sub.filter(Boolean).join(' · ');
    if (heroTop !== this.data.heroTop || heroSub !== this.data.heroSub) this.setData({ heroTop, heroSub });
  },
  refresh() {
    this.setHero();
    this.checkCup();
    const { mode, size, groupCount, entry } = this.data;
    const dbl = this.isDouble();
    const ents = this.entrants();
    const n = ents.length, unit = dbl ? '队' : '人';
    const max = this.maxSeeds(n);
    this.seeds = this.seeds.filter((s) => ents.indexOf(s) >= 0).slice(0, max);
    const odd = dbl && !this.isRot() && this.selected.length % 2 === 1;

    let info = '', ok = false;
    const rot = this.isRot();
    if (rot && entry === 'signup') { ok = true; info = '创建后发给球友，每人单独报名（不用选搭档）；报满 4 位后由你确认生成三轮对阵，之后报名的进候补'; }
    else if (rot) {
      ok = n === E.ROTATION_SIZE;
      info = ok ? '已选 4 位 · 三轮换搭档，每人和另外三位各搭档一次' : `已选 ${n} 位，四人轮换双打要正好 4 位`;
    } else if (entry === 'signup') {
      ok = true;
      info = (mode === 'bracket' ? `创建后发给球友，球友点「我要报名」，最多 ${size} ${unit}` : (groupCount === 1 ? '创建后发给球友，球友点「我要报名」，报完所有人打一个大循环' : `创建后发给球友，球友点「我要报名」，报完再分 ${groupCount} 组`))
        + (dbl ? '。报名时可以选搭档，没搭档的由你来配对' : '');
    } else if (odd) info = `已选 ${this.selected.length} 人，双打还差 1 人才能凑成一队`;
    else if (mode === 'bracket') {
      const byes = D.nextPow2(size) - n;
      if (n < 2) info = dbl ? `按顺序点选球员，每 2 人组成一队（${size} 签最多 ${size} 队）` : `请选择参加的球员（${size} 签最多 ${size} 人）`;
      else if (n > size) info = `已有 ${n} ${unit}，超过了 ${size} 签，请减少 ${n - size} ${unit}或选更大的签`;
      else { ok = true; info = `已有 ${n} / ${size} ${unit}` + (byes ? ` · 首轮 ${byes} 个轮空` + (this.seeds.length ? '（种子优先轮空）' : '') : ''); }
    } else if (n < groupCount * 2) info = `分 ${groupCount} 组至少需要 ${groupCount * 2} ${unit}，现在 ${n} ${unit}`;
    else {
      ok = true;
      const lo = Math.floor(n / groupCount), hi = Math.ceil(n / groupCount);
      info = groupCount === 1 ? `已有 ${n} ${unit} · 大循环，每${unit}打 ${n - 1} 场` : `已有 ${n} ${unit} · 分 ${groupCount} 组，每组 ${lo === hi ? lo : lo + '~' + hi} ${unit}`;
    }
    const su = this.seedUnit();
    const seedInfo = `建议选 ${this.recSeeds(n)} ${su}，最多 ${max} ${su}` + (this.isGroups() ? '（按蛇形分到各组）' : '（1、2 号种子分在上下半区）');
    const lv = (x) => (this.ratings ? R.fmt(x) : '');
    const chip = (ent) => ({
      name: ent, level: lv(this.levelOfEnt(ent)),
    });

    this.setData(Object.assign({
      chips: this.players.map((p) => {
        const i = this.selected.indexOf(p);
        return { name: p, level: lv(this.levelOf(p)), on: i >= 0, team: dbl && !this.isRot() && i >= 0 ? Math.floor(i / 2) + 1 : 0 };
      }),
      teamList: dbl && !this.isRot() ? ents.map((t, i) => ({ no: i + 1, name: t, level: lv(this.levelOfEnt(t)) })).concat(odd ? [{ no: ents.length + 1, name: this.selected[this.selected.length - 1] + ' / ？', level: '' }] : []) : [],
      seedChips: this.isRot() ? [] : ents.map((p) => Object.assign(chip(p), { seed: this.seeds.indexOf(p) + 1 })),
      seedList: this.seeds.map((p, i) => Object.assign(chip(p), { seed: i + 1 })),
      info, seedInfo, canDraw: ok,
    }, this.ruleView()));
  },

  // 当前设置组成的「草稿活动」，用来计算淘汰赛轮次和赛制一览
  draft() {
    const { mode, size, groupCount, advance, type, rules, byRound } = this.data;
    return { mode, size, groupCount, advance, type, rules: { group: rules.group, ko: rules.ko, rounds: byRound ? rules.rounds : {} } };
  },
  ruleView() {
    const d = this.draft(), st = E.stageRules(d);
    const ko = E.hasKo(d) ? E.koRounds(d) : [];
    const q = d.groupCount * d.advance;
    return {
      koRoundList: ko.map((r) => ({ players: r.players, name: r.name, custom: !!st.rounds[r.players], rule: st.rounds[r.players] || st.ko, text: E.ruleText(st.ko) })),
      rulesSum: E.rulesSummary(d),
      koInfo: d.mode === 'groups_ko' ? `${d.groupCount} 组 × ${d.advance} 人 = ${q} 人进入单淘汰（${E.koSize(d)} 签${E.koSize(d) > q ? `，${E.koSize(d) - q} 个轮空给排名靠前的小组第一` : ''}）` : '',
    };
  },
  // 首个阶段的规则也写在顶层（旧版本页面和战绩列表用）
  cfg() {
    const d = this.draft(), st = E.stageRules(d);
    return Object.assign({ type: this.data.type }, E.hasGroups(d) || E.isRotation(d) ? st.group : st.ko);
  },
  saveCfg() {
    if (this.isRot()) return; // 四人轮换固定双打，不记进「上次的设置」（不然下次普通活动默认成双打）
    try { wx.setStorageSync(CFG_KEY, Object.assign(this.cfg(), { rules: this.draft().rules })); } catch (e) {}
  },
  changed(data) {
    if (this.data.fromSignup) return; // 报名时就定好了，不能再改
    const next = Object.assign({}, this.data, data);
    // 小组赛＋淘汰赛只分 1 组时，只出线第 1 名就没有淘汰赛了：固定前 2 名打决赛
    if (next.mode === 'groups_ko' && next.groupCount === 1 && next.advance !== 2) data = Object.assign({}, data, { advance: 2 });
    this.setData(Object.assign({ preview: null }, data));
    if (!this.data.editingSettings) this.saveCfg();
    this.refresh();
  },

  onTitle(e) { if (!this.data.fromSignup) this.setData({ title: e.detail.value }); },
  onInfo(e) { this.info = e.detail; this.setHero(); },

  inputTitle() {
    const title = this.data.title.trim();
    if (!title || title.length > E.TITLE_MAX) {
      wx.showToast({ title: title ? `比赛名称最多 ${E.TITLE_MAX} 个字` : '请填写比赛名称', icon: 'none' });
      return '';
    }
    return title;
  },

  // 时间地点
  infoFields() {
    const i = this.info || {};
    return { date: i.date || this.date, startTime: i.startTime || '', venue: E.courtOf(i.venue), location: E.locationOf(i.location), place: E.placeOf(i.place), level: E.levelRangeOf(i.level) };
  },
  // 建议水平（可选，只作参考）：表单里选的不合法时不提交
  levelOk() {
    const err = E.levelError((this.info || {}).level);
    if (err) wx.showToast({ title: err, icon: 'none' });
    return !err;
  },
  // LULU 积分：周赛、月赛选上时直接切成单淘汰 8 签；之后改了形式 / 签数就提示不匹配，不能创建
  setCup(e) {
    const on = e.currentTarget.dataset.v === '1';
    if (on === this.data.cupOn) return;
    this.setData({ cupOn: on });
    if (on) this.fitCup(this.data.cupKind); else this.refresh();
  },
  setCupKind(e) { this.setData({ cupKind: e.currentTarget.dataset.v }); this.fitCup(e.currentTarget.dataset.v); },
  setCupPointGroup(e) {
    const group = C.pointGroupOf(this.data.cupKind, e.currentTarget.dataset.v);
    if (group) this.changed({ cupPointGroup: group });
  },
  fitCup(kind) {
    if ((kind === 'weekly' || kind === 'monthly') && C.drawCupError(this.data, kind)) this.changed({ mode: 'bracket', size: C.DRAW_SIZE });
    else if (C.drawCupError(this.data, kind)) this.changed({ mode: 'bracket' });
    else this.refresh();
  },
  checkCup() {
    const { cupOn, cupKind } = this.data;
    const cupErr = cupOn ? C.drawCupError(this.data, cupKind) : '';
    const cupNote = cupOn ? C.drawCupNote(cupKind) : '';
    if (cupErr !== this.data.cupErr || cupNote !== this.data.cupNote) this.setData({ cupErr, cupNote });
  },
  cupOk() {
    if (this.data.fromSignup || !this.data.cupOn) return true;
    const err = C.drawCupError(this.data, this.data.cupKind);
    if (err) wx.showToast({ title: err, icon: 'none' });
    return !err;
  },
  setEntry(e) {
    if (this.isRot()) return; // 四人轮换只能开放报名
    this.setData({ entry: e.currentTarget.dataset.v, preview: null }); this.refresh();
  },
  // 四人轮换：固定双打、开放报名、没有混双和报名上限，不计 LULU 积分
  setMode(e) {
    const mode = e.currentTarget.dataset.v;
    if (this.data.editingSettings && (this.data.fixedRotation || mode === 'rotation')) return;
    if (mode !== 'rotation') { this.changed({ mode }); return; }
    this.seeds = [];
    this.changed({ mode, type: 'double', limits: LIMITS.double, entry: 'signup', limit: 0, cupOn: false, category: this.data.category === 'mixed' ? '' : this.data.category });
  },
  setSize(e) { this.changed({ size: Number(e.currentTarget.dataset.v) }); },
  setGroups(e) {
    const groupCount = Number(e.currentTarget.dataset.v), { limit, entry } = this.data;
    if (limit && entry === 'signup' && groupCount * 2 > limit) {
      wx.showToast({ title: `报名上限 ${limit} ${this.isDouble() ? '队' : '人'}，最多分 ${GROUPS.filter((g) => g * 2 <= limit).pop() || 1} 组`, icon: 'none' });
      return;
    }
    this.changed({ groupCount });
  },
  setType(e) {
    if (this.isRot() || this.data.editingSettings) return;
    const type = e.currentTarget.dataset.v;
    this.seeds = [];
    const next = { type, limits: LIMITS[type === 'double' ? 'double' : 'single'] };
    if (type !== 'double' && this.data.category === 'mixed') next.category = ''; // 单打没有混双
    if (next.limits.indexOf(this.data.limit) < 0) next.limit = 0; // 「2 队」只有双打有
    this.changed(next);
  },
  setCategory(e) { if (!this.data.editingSettings) this.changed({ category: e.currentTarget.dataset.v }); },
  // 报名上限：分的组数要放得下（每组至少 2 队 / 人），否则截止报名后生成不了，组数跟着减少（例如「2 队」只能 1 组）
  setLimit(e) {
    if (this.data.fromSignup) return;
    const limit = Number(e.currentTarget.dataset.v);
    const next = { limit };
    if (limit && this.data.groupCount * 2 > limit) {
      next.groupCount = GROUPS.filter((g) => g * 2 <= limit).pop() || 1;
      wx.showToast({ title: `报名上限 ${limit} ${this.isDouble() ? '队' : '人'}，最多分 ${next.groupCount} 组`, icon: 'none' });
    }
    this.changed(next);
  },
  setAdvance(e) { if (this.data.groupCount !== 1) this.changed({ advance: Number(e.currentTarget.dataset.v) }); },
  // 某个阶段 / 轮次的规则变了：stage = 'group' | 'ko' | 轮次人数（'2' = 决赛）
  onRule(e) {
    const stage = String(e.currentTarget.dataset.stage);
    const rules = JSON.parse(JSON.stringify(this.data.rules));
    if (stage === 'group' || stage === 'ko') rules[stage] = e.detail;
    else rules.rounds[stage] = e.detail;
    this.changed({ rules });
  },
  setByRound(e) { this.changed({ byRound: e.currentTarget.dataset.v === '1' }); },
  toggleRound(e) {
    const p = String(e.currentTarget.dataset.p);
    const rules = JSON.parse(JSON.stringify(this.data.rules));
    if (e.detail.value) rules.rounds[p] = Object.assign({}, rules.ko); // 从统一规则复制一份再改
    else delete rules.rounds[p];
    this.changed({ rules });
  },

  togglePlayer(e) {
    const name = e.currentTarget.dataset.name;
    const i = this.selected.indexOf(name);
    if (i >= 0) this.selected.splice(i, 1);
    else this.selected.push(name);
    this.setData({ preview: null });
    this.refresh();
  },
  selectAll() { this.selected = this.players.slice(); this.setData({ preview: null }); this.refresh(); },
  clearAll() { this.selected = []; this.seeds = []; this.setData({ preview: null }); this.refresh(); },

  // 双打：把已选球员随机重新配对
  shufflePairs() {
    this.selected = D.shuffle(this.selected);
    this.seeds = [];
    this.setData({ preview: null });
    this.recommendSeeds(true);
    wx.showToast({ title: '已随机配对', icon: 'none' });
  },

  toggleSeed(e) {
    const name = e.currentTarget.dataset.name;
    const i = this.seeds.indexOf(name);
    const max = this.maxSeeds(this.entrants().length);
    if (i >= 0) this.seeds.splice(i, 1);
    else if (this.seeds.length >= max) {
      wx.showToast({ title: `最多选 ${max} ${this.seedUnit()}${this.seedName()}`, icon: 'none' });
      return;
    } else this.seeds.push(name);
    this.setData({ preview: null });
    this.refresh();
  },
  autoSeeds() { this.recommendSeeds(false); },

  seedUp(e) {
    const i = Number(e.currentTarget.dataset.i);
    if (i <= 0) return;
    const t = this.seeds[i - 1]; this.seeds[i - 1] = this.seeds[i]; this.seeds[i] = t;
    this.setData({ preview: null });
    this.refresh();
  },

  // 参赛名 → 用户 ID 的快照：报名记录优先，其次是球员列表里唯一的昵称；都没有就不绑定
  uidsOf(names) {
    const out = {};
    names.forEach((n) => { const u = (this.signUid || {})[n] || (this.nameUid || {})[n]; if (u) out[n] = u; });
    return out;
  },

  // 保存到 draws：活动形式、分阶段 / 分轮次规则；顶层 setGames 等是首个阶段的规则（兼容旧版本）
  settings() {
    const d = this.draft();
    const rules = { group: d.rules.group, ko: d.rules.ko, rounds: {} };
    if (E.hasKo(d)) E.koRounds(d).forEach((r) => { if (d.rules.rounds[r.players]) rules.rounds[r.players] = d.rules.rounds[r.players]; });
    const extra = {};
    if (this.data.category && (this.data.category !== 'mixed' || this.isDouble())) extra.category = this.data.category;
    if (this.data.limit && d.mode !== 'bracket' && this.data.entry === 'signup') extra.limit = this.data.limit;
    if (!this.data.fromSignup && !this.data.editingSettings && this.data.cupOn) {
      extra.cup = C.drawCupOf({ cup: { kind: this.data.cupKind, pointGroup: this.data.cupPointGroup, scoreVersion: C.SCORE_VERSION } });
    }
    return Object.assign({ mode: d.mode, size: d.size, groupCount: d.groupCount, advance: d.advance, rules }, extra, this.cfg());
  },

  doDraw(e) {
    if (!this.data.canDraw) { wx.showToast({ title: this.data.info, icon: 'none' }); return; }
    try {
      const ents = this.entrants();
      const base = Object.assign(this.settings(), {
        entrants: ents, seeds: this.seeds.slice(), results: {},
        teams: this.teams || {}, uidOf: this.uidsOf(this.selected),
      });
      const manual = !this.isRot() && (this.data.manualOnly || (e && e.currentTarget.dataset.manual === 'yes'));
      if (manual) {
        const old = this.originalMatchups;
        const oldEntrants = old && old.entrants || [];
        const sameEntrants = oldEntrants.length === ents.length && oldEntrants.every((name) => ents.includes(name));
        if (old && old.avatars) base.avatars = old.avatars;
        const slot = (name) => {
          if (!name) return { bye: true };
          const seed = base.seeds.indexOf(name) + 1;
          return seed ? { name, seed } : { name };
        };
        let positions, manualLabels;
        if (this.isGroups()) {
          const groups = sameEntrants && old.groups ? old.groups.map((g) => ({ name: g.name, members: g.members.map((s) => slot(s.name)) }))
            : Array.from({ length: base.groupCount }, (_, i) => ({
              name: String.fromCharCode(65 + i) + ' 组',
              members: ents.filter((_, j) => j % base.groupCount === i).map(slot),
            }));
          base.groups = groups;
          positions = groups.flatMap((g) => g.members);
          manualLabels = groups.flatMap((g) => g.members.map((_, i) => `${g.name} · ${i + 1}`));
        } else {
          base.lines = sameEntrants && old.lines ? old.lines.map((s) => slot(s && s.name))
            : Array.from({ length: D.nextPow2(base.size) }, (_, i) => slot(ents[i]));
          positions = base.lines;
          manualLabels = positions.map((_, i) => `签位 ${i + 1}`);
        }
        const manualOpts = positions.some((s) => s.bye) ? ents.concat('轮空') : ents;
        const manualIndexes = positions.map((s) => s.bye ? ents.length : ents.indexOf(s.name));
        this.setData({ preview: base, manualOpts, manualIndexes, manualLabels });
        setTimeout(() => wx.pageScrollTo({ selector: '#preview', duration: 300 }), 50);
        return;
      }
      // 四人轮换：按名单顺序排三轮（云端按同一个公式重新算，不信任这里的预览）
      const preview = this.isRot() ? Object.assign(base, { teams: {}, rotRounds: E.rotationPairs(ents).map(([a, b]) => `${E.teamLabel(a)} 对 ${E.teamLabel(b)}`) })
        : !this.isGroups()
        ? Object.assign(base, { lines: D.makeBracket(ents, this.seeds, this.data.size) })
        : Object.assign(base, { groups: D.makeGroups(ents, this.seeds, this.data.groupCount) });
      this.setData({ preview, manualOpts: [], manualIndexes: [] });
      wx.vibrateShort({ type: 'medium' });
      setTimeout(() => wx.pageScrollTo({ selector: '#preview', duration: 300 }), 50);
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' });
    }
  },

  setManualSlot(e) {
    const { preview, manualOpts, manualIndexes, saving } = this.data;
    if (!preview || !manualOpts.length || saving) return;
    const i = Number(e.currentTarget.dataset.i), j = Number(e.detail.value);
    const positions = preview.lines ? preview.lines.slice() : preview.groups.flatMap((g) => g.members);
    if (!positions[i] || !Number.isInteger(j) || j < 0 || j >= manualOpts.length) return;
    if (manualIndexes[i] === j) return;
    const from = manualIndexes.indexOf(j);
    if (from < 0) return;
    [positions[i], positions[from]] = [positions[from], positions[i]];
    const indexes = manualIndexes.slice();
    [indexes[i], indexes[from]] = [indexes[from], indexes[i]];
    if (preview.lines) this.setData({ 'preview.lines': positions, manualIndexes: indexes });
    else {
      let offset = 0;
      const groups = preview.groups.map((g) => {
        const members = positions.slice(offset, offset + g.members.length);
        offset += g.members.length;
        return { name: g.name, members };
      });
      this.setData({ 'preview.groups': groups, manualIndexes: indexes });
    }
  },

  // 开放报名：只保存活动设置，抽签等报名结束后再做
  async publishSignup() {
    if (!this.data.canPublish || this.data.editingSettings) return;
    if (this.data.saving) return;
    const title = this.inputTitle();
    if (!title || !this.levelOk() || !this.cupOk()) return;
    const info = this.infoFields();
    if (info.date < this.date) { wx.showToast({ title: '开放报名请选择今天或之后', icon: 'none' }); return; }
    this.setData({ saving: true });
    try {
      const r = await db.addDraw(Object.assign(this.settings(), info, {
        title, status: 'signup', results: {},
      }));
      const id = r.id;
      const go = () => wx.redirectTo({ url: '/pages/draw-view/draw-view?id=' + id });
      const fails = await this.addPreSignups(id);
      if (fails.length) { // 活动已经建好：没加进去的列出来，之后在活动详情里补
        wx.showModal({ title: '活动已创建', content: `有 ${fails.length} 条没加进报名名单：\n${fails.join('\n')}\n可以在活动详情里用「＋ 添加报名」再加`, showCancel: false, complete: go });
        return;
      }
      wx.showToast(r.placeDropped ? PLACE_DROPPED : { title: this.data.pre.length ? `已创建，先加入 ${this.data.pre.length} 条报名` : '已创建', icon: r.placeDropped || this.data.pre.length ? 'none' : 'success' });
      setTimeout(go, 600);
    } catch (e) {
      console.error(e);
      wx.showModal({ title: '创建失败', content: e.message || '请稍后再试', showCancel: false });
    } finally {
      this.setData({ saving: false });
    }
  },

  // 开放报名时先加入的球友（2026-11-24 用户要求）：已经确定参加的先选好，活动创建后逐条代报名
  //   （云端 adminAddSignup，按本人报名同一套规则校验组别、性别、重名、搭档，留档）；按选的顺序报名，名额满了的进候补。
  //   双打可以带搭档；改成单打 / 四人轮换时，选好的搭档拆成各自单独报名
  async openPre() {
    if (this.data.saving) return;
    if (!this.prePool) {
      try {
        const { active } = await cloud.call('listMembers');
        const G = require('../../utils/stats').GENDER;
        this.prePool = (active || []).filter((m) => m.uid && m.nickname)
          .map((m) => ({ uid: m.uid, name: m.nickname, g: G[m.gender] || '' }))
          .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      } catch (e) { wx.showToast({ title: e.message || '读取成员失败', icon: 'none' }); return; }
    }
    this.prePlayer = null;
    const list = this.preFree();
    if (!list.length) { wx.showToast({ title: '没有可添加的球友', icon: 'none' }); return; }
    this.setData({ preSheet: { title: '先加入的球友', sub: '选择已经确定参加的', list, extra: '' } });
  },
  preFree(except) {
    const used = new Set(this.data.pre.flatMap((x) => x.ids));
    return this.prePool.filter((m) => !used.has(m.uid) && m.uid !== except);
  },
  prePick(e) {
    const p = (this.prePool || []).find((m) => m.uid === e.detail.uid);
    if (!p) return;
    if (this.prePlayer) { this.addPre(this.prePlayer, p); return; }
    if (this.data.type !== 'double' || this.isRot()) { this.addPre(p, null); return; }
    this.prePlayer = p; // 双打：接着选搭档
    this.setData({ preSheet: { title: `选择 ${p.name} 的搭档`, sub: '也可以不带搭档', list: this.preFree(p.uid), extra: '不带搭档' } });
  },
  preSolo() { if (this.prePlayer) this.addPre(this.prePlayer, null); },
  closePre() { this.prePlayer = null; this.setData({ preSheet: null }); },
  addPre(a, b) {
    const who = b ? [a, b] : [a];
    const row = { key: a.uid, ids: who.map((m) => m.uid), who: who.map((m) => m.name), playerId: a.uid, partnerId: b ? b.uid : '', text: who.map((m) => m.name).join(' / '), names: who.map((m) => m.name).join('、') };
    this.prePlayer = null;
    this.setData({ pre: this.data.pre.concat([row]), preSheet: null });
  },
  removePre(e) { const pre = this.data.pre.slice(); pre.splice(Number(e.currentTarget.dataset.i), 1); this.setData({ pre }); },
  // 活动建好后逐条代报名，返回没加进去的「名字：原因」
  async addPreSignups(drawId) {
    const pairs = this.data.type === 'double' && !this.isRot();
    const rows = pairs ? this.data.pre : this.data.pre.flatMap((x) => x.ids.map((id, k) => ({ playerId: id, partnerId: '', text: x.who[k] })));
    const fails = [];
    for (const x of rows) {
      try { await cloud.call('adminAddSignup', { drawId, playerId: x.playerId, partnerId: x.partnerId }); }
      catch (e) { fails.push(`${x.text}：${e.message || '添加失败'}`); }
    }
    return fails;
  },

  async saveSettings() {
    if (!this.data.canPublish || !this.data.editingSettings || this.data.settingsLoading || this.data.saving || !this.cupOk()) return;
    this.setData({ saving: true });
    try {
      await db.updateDrawSettings(this.drawId, this.settings(), this.settingsVersion);
      wx.showToast({ title: '规则已更新', icon: 'success' });
      wx.navigateBack();
    } catch (e) {
      wx.showModal({ title: '保存失败', content: e.message || '请稍后再试', showCancel: false });
    } finally {
      this.setData({ saving: false });
    }
  },

  async save() {
    if (!this.data.canPublish) return;
    const p = this.data.preview;
    if (!p || this.data.saving) return;
    const title = this.drawId ? this.data.title : this.inputTitle();
    if (!title || (!this.drawId && (!this.levelOk() || !this.cupOk()))) return;
    this.setData({ saving: true });
    try {
      let id = this.drawId, dropped = false;
      if (id) {
        await db.generateDraw(id, Object.assign({}, p, {
          settingsVersion: this.settingsVersion || 0, rosterVersion: this.rosterVersion || 0, drawVersion: this.drawVersion || 0,
        }), this.data.manualOpts.length > 0);
      } else {
        const r = await db.addDraw(Object.assign({}, p, this.infoFields(), { title, status: 'drawn' }));
        id = r.id; dropped = r.placeDropped;
      }
      wx.showToast(dropped ? PLACE_DROPPED : { title: this.data.editingMatchups ? '对阵已更新' : '已生成', icon: 'success' });
      if (this.data.manualOnly) wx.navigateBack({ fail: () => wx.redirectTo({ url: '/pages/draw-view/draw-view?id=' + id }) });
      else setTimeout(() => wx.redirectTo({ url: '/pages/draw-view/draw-view?id=' + id }), 600);
    } catch (e) {
      console.error(e);
      wx.showModal({ title: '保存失败', content: e.message || '请稍后再试', showCancel: false });
    } finally {
      this.setData({ saving: false });
    }
  },
});
