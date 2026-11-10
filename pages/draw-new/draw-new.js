// 创建球友活动：先定好赛制（单双打、局制、金球、盘数、淘汰 / 小组），再开放报名或直接选人抽签
const D = require('../../utils/draw');
const E = require('../../utils/event');
const R = require('../../utils/rating');
const db = require('../../utils/db');
const ID = require('../../utils/ident');
const cloud = require('../../utils/cloud');

const pad = (n) => (n < 10 ? '0' + n : '' + n);
const SIZES = [8, 12, 16, 24, 32];
const GROUPS = [2, 3, 4, 6, 8];
const CFG_KEY = 'last_event_rules';
const DEF_RULE = { setGames: 4, noAd: true, bestOf: 1 };

Page({
  data: {
    title: '', mode: 'bracket', size: 8, groupCount: 4, entry: 'signup',
    type: 'single', advance: 2, byRound: false, koInfo: '',
    rules: { group: DEF_RULE, ko: DEF_RULE, rounds: {} }, koRoundList: [], rulesSum: [],
    sizes: SIZES, groupOpts: GROUPS,
    chips: [], seedChips: [], seedList: [], teamList: [], newName: '',
    info: '', seedInfo: '', canDraw: false, preview: null, saving: false,
    fromSignup: false, // 从「报名」进来：用报名名单抽签，赛制已锁定
  },

  onLoad(options) {
    const d = new Date();
    this.date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    this.selected = []; // 选中的球员（双打按顺序两两组队）
    this.seeds = [];    // 种子（参赛单位：单打是名字，双打是「张三 / 李四」）
    this.avatarOf = {};
    this.players = [];
    this.setPlayers(db.cachedPlayersFull());
    let last = {};
    try { last = wx.getStorageSync(CFG_KEY) || {}; } catch (e) {}
    // 记住上次的赛制设置（含分阶段 / 分轮次规则）
    const st = E.stageRules(last);
    this.setData({ type: E.cfgOf(last).type, rules: st, byRound: Object.keys(st.rounds).length > 0 });
    if (options && options.id) {
      this.drawId = options.id;
      this.setData({ fromSignup: true, entry: 'pick' });
      wx.setNavigationBarTitle({ title: '截止报名 · 生成签表' });
      this.loadSignups();
    } else {
      this.setData({ title: `${d.getMonth() + 1}月${d.getDate()}日 内部赛` });
      this.loadPlayers();
    }
    this.refresh();
  },

  setPlayers(full) {
    this.nameUid = Object.assign(this.nameUid || {}, ID.uidByName(full));
    const names = full.map((p) => { if (p.avatar) this.avatarOf[p.name] = p.avatar; return p.name; });
    this.players.forEach((n) => { if (names.indexOf(n) < 0) names.push(n); });
    this.players = names;
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
      signups.forEach((s) => {
        if (s.avatar) this.avatarOf[s.name] = s.avatar;
        if (s.partner && s.partnerAvatar) this.avatarOf[s.partner] = s.partnerAvatar;
      });
      this.ratings = R.computeRatings(matches, R.startLevelsFrom(full));
      this.signUid = ID.drawUids(null, signups); // 报名记录是本人写的，ID 最可靠
      const cfg = E.cfgOf(draw), st = E.stageRules(draw);
      // 双打：已经带搭档的先排，单人报名的排在后面按顺序两两配对
      const names = [];
      const push = (n) => { if (n && names.indexOf(n) < 0) names.push(n); };
      if (cfg.type === 'double') {
        signups.filter((s) => s.partner).forEach((s) => { push(s.name); push(s.partner); });
        signups.filter((s) => !s.partner).forEach((s) => push(s.name));
      } else signups.forEach((s) => push(s.name));
      names.forEach((n) => { if (this.players.indexOf(n) < 0) this.players.push(n); });
      this.selected = names.slice();
      this.setData({
        title: draw.title, mode: draw.mode, size: draw.size || 8, groupCount: draw.groupCount || 4, advance: draw.advance === 1 ? 1 : 2,
        type: cfg.type, rules: st, byRound: Object.keys(st.rounds).length > 0,
      });
      this.recommendSeeds(true);
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '读取报名名单失败', icon: 'none' });
    }
  },

  isDouble() { return this.data.type === 'double'; },

  // 参赛单位和双打队伍
  entrants() {
    if (!this.isDouble()) { this.teams = null; return this.selected.slice(); }
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

  levelOf(name) { return this.ratings ? R.levelOf(this.ratings, name, db.cachedPlayersFull()) : R.DEFAULT_LEVEL; },
  levelOfEnt(ent) {
    const ms = this.membersOf(ent);
    return ms.reduce((s, n) => s + this.levelOf(n), 0) / ms.length;
  },

  isGroups() { return this.data.mode !== 'bracket'; }, // 小组赛、小组赛＋淘汰赛都要先分组
  maxSeeds(n) { return D.maxSeeds(this.isGroups() ? 'groups' : 'bracket', this.isGroups() ? this.data.groupCount : this.data.size, n); },
  recSeeds(n) { return Math.min(this.maxSeeds(n), this.isGroups() ? this.data.groupCount : D.nextPow2(this.data.size) / 4); },

  // 按水平分推荐种子
  recommendSeeds(silent) {
    const ents = this.entrants();
    const sorted = ents.slice().sort((a, b) => this.levelOfEnt(b) - this.levelOfEnt(a));
    this.seeds = sorted.slice(0, this.recSeeds(ents.length));
    this.setData({ preview: null });
    this.refresh();
    if (!silent) wx.showToast({ title: `已按水平选出 ${this.seeds.length} 个种子`, icon: 'none' });
  },

  refresh() {
    const { mode, size, groupCount, entry } = this.data;
    const dbl = this.isDouble();
    const ents = this.entrants();
    const n = ents.length, unit = dbl ? '队' : '人';
    const max = this.maxSeeds(n);
    this.seeds = this.seeds.filter((s) => ents.indexOf(s) >= 0).slice(0, max);
    const odd = dbl && this.selected.length % 2 === 1;

    let info = '', ok = false;
    if (entry === 'signup') {
      ok = true;
      info = (mode === 'bracket' ? `创建后分享到群里，大家点「我要报名」，最多 ${size} ${unit}` : `创建后分享到群里，大家点「我要报名」，报完再分 ${groupCount} 组`)
        + (dbl ? '。报名时可以选搭档，没搭档的由你来配对' : '');
    } else if (odd) info = `已选 ${this.selected.length} 人，双打还差 1 人才能凑成一队`;
    else if (mode === 'bracket') {
      const byes = D.nextPow2(size) - n;
      if (n < 2) info = dbl ? `按顺序点选球员，每 2 人组成一队（${size} 签最多 ${size} 队）` : `请选择参赛球员（${size} 签最多 ${size} 人）`;
      else if (n > size) info = `已有 ${n} ${unit}，超过了 ${size} 签，请减少 ${n - size} ${unit}或选更大的签`;
      else { ok = true; info = `已有 ${n} / ${size} ${unit}` + (byes ? ` · 首轮 ${byes} 个轮空（排名靠前的种子优先轮空）` : ''); }
    } else if (n < groupCount * 2) info = `分 ${groupCount} 组至少需要 ${groupCount * 2} ${unit}，现在 ${n} ${unit}`;
    else {
      ok = true;
      const lo = Math.floor(n / groupCount), hi = Math.ceil(n / groupCount);
      info = `已有 ${n} ${unit} · 分 ${groupCount} 组，每组 ${lo === hi ? lo : lo + '~' + hi} ${unit}`;
    }
    const seedInfo = `建议设 ${this.recSeeds(n)} 个种子，最多 ${max} 个` + (this.isGroups() ? '（种子按蛇形分到各组）' : '（1、2 号种子分在上下半区）');
    const lv = (x) => (this.ratings ? R.fmt(x) : '');
    const chip = (ent) => ({
      name: ent, avatar: this.avatarOf[this.membersOf(ent)[0]] || '', level: lv(this.levelOfEnt(ent)),
    });

    this.setData(Object.assign({
      chips: this.players.map((p) => {
        const i = this.selected.indexOf(p);
        return { name: p, avatar: this.avatarOf[p] || '', level: lv(this.levelOf(p)), on: i >= 0, team: dbl && i >= 0 ? Math.floor(i / 2) + 1 : 0 };
      }),
      teamList: dbl ? ents.map((t, i) => ({ no: i + 1, name: t, level: lv(this.levelOfEnt(t)) })).concat(odd ? [{ no: ents.length + 1, name: this.selected[this.selected.length - 1] + ' / ？', level: '' }] : []) : [],
      seedChips: ents.map((p) => Object.assign(chip(p), { seed: this.seeds.indexOf(p) + 1 })),
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
      koInfo: d.mode === 'groups_ko' ? `${d.groupCount} 组 × ${d.advance} 人 = ${q} 人进入淘汰赛（${E.koSize(d)} 签${E.koSize(d) > q ? `，${E.koSize(d) - q} 个轮空给排名靠前的小组第一` : ''}）` : '',
    };
  },
  // 首个阶段的规则也写在顶层（旧版本页面和战绩列表用）
  cfg() {
    const d = this.draft(), st = E.stageRules(d);
    return Object.assign({ type: this.data.type }, E.hasGroups(d) ? st.group : st.ko);
  },
  saveCfg() { try { wx.setStorageSync(CFG_KEY, Object.assign(this.cfg(), { rules: this.draft().rules })); } catch (e) {} },
  changed(data) {
    if (this.data.fromSignup) return; // 报名时就定好了，不能再改
    this.setData(Object.assign({ preview: null }, data));
    this.saveCfg();
    this.refresh();
  },

  onTitle(e) { this.setData({ title: e.detail.value }); },
  onInfo(e) { this.info = e.detail; },

  // 时间地点（公开）和联系人（单独通过云函数保存，不进 draws）
  infoFields() {
    const i = this.info || {};
    return { date: i.date || this.date, startTime: i.startTime || '', venue: (i.venue || '').trim(), location: i.location || null };
  },
  async saveContact(id) {
    const c = (this.info || {}).contact;
    if (!c || !(c.name || c.phone || c.wechat)) return;
    try { await cloud.call('saveContact', { drawId: id, contact: c }); }
    catch (e) { wx.showModal({ title: '活动已创建，联系人未保存', content: e.message + '\n可以稍后在活动详情里「编辑」补上。', showCancel: false }); throw e; }
  },
  setEntry(e) { this.setData({ entry: e.currentTarget.dataset.v, preview: null }); this.refresh(); },
  setMode(e) { this.changed({ mode: e.currentTarget.dataset.v }); },
  setSize(e) { this.changed({ size: Number(e.currentTarget.dataset.v) }); },
  setGroups(e) { this.changed({ groupCount: Number(e.currentTarget.dataset.v) }); },
  setType(e) { this.seeds = []; this.changed({ type: e.currentTarget.dataset.v }); },
  setAdvance(e) { this.changed({ advance: Number(e.currentTarget.dataset.v) }); },
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

  onNewName(e) { this.setData({ newName: e.detail.value }); },
  addNew() {
    const name = this.data.newName.trim();
    if (!name) return;
    if (this.players.indexOf(name) < 0) {
      this.players.push(name);
      db.addPlayer(name).catch((err) => console.error(err));
    }
    if (this.selected.indexOf(name) < 0) this.selected.push(name);
    this.setData({ newName: '', preview: null });
    this.refresh();
  },

  toggleSeed(e) {
    const name = e.currentTarget.dataset.name;
    const i = this.seeds.indexOf(name);
    const max = this.maxSeeds(this.entrants().length);
    if (i >= 0) this.seeds.splice(i, 1);
    else if (this.seeds.length >= max) {
      wx.showToast({ title: `最多 ${max} 个种子`, icon: 'none' });
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

  avatarsOf(names) {
    const out = {};
    names.forEach((n) => { if (this.avatarOf[n]) out[n] = this.avatarOf[n]; });
    return out;
  },

  // 保存到 draws：活动形式、分阶段 / 分轮次规则；顶层 setGames 等是首个阶段的规则（兼容旧版本）
  settings() {
    const d = this.draft();
    const rules = { group: d.rules.group, ko: d.rules.ko, rounds: {} };
    if (E.hasKo(d)) E.koRounds(d).forEach((r) => { if (d.rules.rounds[r.players]) rules.rounds[r.players] = d.rules.rounds[r.players]; });
    return Object.assign({ mode: d.mode, size: d.size, groupCount: d.groupCount, advance: d.advance, rules }, this.cfg());
  },

  doDraw() {
    if (!this.data.canDraw) { wx.showToast({ title: this.data.info, icon: 'none' }); return; }
    try {
      const ents = this.entrants();
      const base = Object.assign(this.settings(), {
        entrants: ents, seeds: this.seeds.slice(), results: {},
        teams: this.teams || {}, avatars: this.avatarsOf(this.selected), uidOf: this.uidsOf(this.selected),
      });
      const preview = !this.isGroups()
        ? Object.assign(base, { lines: D.makeBracket(ents, this.seeds, this.data.size) })
        : Object.assign(base, { groups: D.makeGroups(ents, this.seeds, this.data.groupCount) });
      this.setData({ preview });
      wx.vibrateShort({ type: 'medium' });
      setTimeout(() => wx.pageScrollTo({ selector: '#preview', duration: 300 }), 50);
    } catch (err) {
      wx.showToast({ title: err.message, icon: 'none' });
    }
  },

  // 开放报名：只保存活动设置，抽签等报名结束后再做
  async publishSignup() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    try {
      const id = await db.addDraw(Object.assign(this.settings(), this.infoFields(), {
        title: this.data.title.trim() || '内部赛', status: 'signup', results: {},
      }));
      try { await this.saveContact(id); } catch (e) { setTimeout(() => wx.redirectTo({ url: '/pages/draw-view/draw-view?id=' + id }), 1500); return; }
      wx.showToast({ title: '已创建', icon: 'success' });
      setTimeout(() => wx.redirectTo({ url: '/pages/draw-view/draw-view?id=' + id }), 600);
    } catch (e) {
      console.error(e);
      wx.showModal({ title: '创建失败', content: e.message || '请稍后再试', showCancel: false });
    } finally {
      this.setData({ saving: false });
    }
  },

  async save() {
    const p = this.data.preview;
    if (!p || this.data.saving) return;
    this.setData({ saving: true });
    try {
      let id = this.drawId;
      if (id) {
        await db.generateDraw(id, p);
      } else {
        id = await db.addDraw(Object.assign({}, p, this.infoFields(), { title: this.data.title.trim() || '内部赛', status: 'drawn' }));
        try { await this.saveContact(id); } catch (e) { /* 已提示，可稍后编辑补上 */ }
      }
      wx.showToast({ title: '已生成', icon: 'success' });
      setTimeout(() => wx.redirectTo({ url: '/pages/draw-view/draw-view?id=' + id }), 600);
    } catch (e) {
      console.error(e);
      wx.showModal({ title: '保存失败', content: e.message || '请稍后再试', showCancel: false });
    } finally {
      this.setData({ saving: false });
    }
  },
});
