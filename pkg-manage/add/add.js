// 记录日常比赛（不属于活动的约球）：自己固定在 A 方，搭档和对手只能选已注册球员（按用户 ID 关联）。
// 提交后直接生效，计入正式战绩和排名，不需要对手确认（见 utils/official.js）。
// 活动里的比赛不在这里录：从活动签表 / 赛程点对应场次录分。
const R = require('../../utils/rules');
const ID = require('../../utils/ident');
const S = require('../../utils/stats');
const SC = require('../utils/scorer');
const haptic = require('../../utils/haptic');
const DB = require('../../utils/db');
const { fetchPlayersFull, cachedPlayersFull, addMatch, getMyProfile, cachedProfile, myOpenid } = DB;

const pad = (n) => (n < 10 ? '0' + n : '' + n);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const CFG_KEY = 'last_rules';
const dayOf = (d) => { const m = /^\d{4}-(\d{2})-(\d{2})$/.exec(d || ''); return m ? `${Number(m[1])}月${Number(m[2])}日` : ''; };

Page({
  data: {
    canRecordDaily: false, authError: '', date: '', today: '', type: 'single', bestOf: 3, setGames: 4, noAd: true,
    slotsA: [], slotsB: [], chips: [], me: '', noProfile: false,
    aLabel: 'A 方', bLabel: 'B 方',
    check: { ok: false, msg: '' }, submitting: false, rulesText: '', dayText: '',
    fromScorer: false, initSets: [], scorerResume: false, // 从场边记分带过来的规则和盘分（只预填，仍要选球员、核对后提交）
    rkOpen: false, rkBusy: false, rkList: [], rkId: '', rkMin: '60', rkDate: '', // 录完顺手记球拍时长弹层
  },

  onLoad(options) {
    SC.takeDailyPending(); // 新打开的录分页不接之前没被取走的标记（只给退回的那一页用）
    const t = today();
    let last = {};
    try { last = wx.getStorageSync(CFG_KEY) || {}; } catch (e) {}
    const cfg = R.normCfg(last);
    this.slots = { a: ['', ''], b: ['', ''] };
    this.active = 'a0';
    // 自己先按本机记的资料填进 A 方、光标落到对手（2026-11-25 用户嫌打开后自己的名字晚半拍才出来）；云端读完 loadPlayers 再更正
    const full0 = cachedPlayersFull() || [];
    this.myId = (DB.cachedOpenid && DB.cachedOpenid()) || '';
    this.setPlayers(full0);
    const me0 = cachedProfile && cachedProfile();
    const myName0 = this.myId && me0 && me0.name && ID.uidByName(full0)[me0.name] === this.myId ? me0.name : '';
    this.res = { ok: false, msg: '请至少填写一盘' };
    const init = { date: t, dayText: dayOf(t), today: t, setGames: cfg.setGames, noAd: cfg.noAd, bestOf: last.bestOf === 1 ? 1 : 3 };
    const sc = this.scorerPrefill(options || {});
    if (sc) Object.assign(init, { setGames: sc.setGames, noAd: sc.noAd, bestOf: sc.bestOf, initSets: sc.sets, fromScorer: true }); // 不改「上次用的规则」
    if (myName0) {
      this.slots.a[0] = myName0;
      this.active = this.order(init.type).find((k) => !this.slots[k[0]][+k[1]]) || null;
      Object.assign(init, { me: myName0, noProfile: false });
    }
    this.setData(init);
    this.refresh();
  },

  // 场边记分「带入日常录分」：只读本机草稿里已完赛的那一场（按 id 对上），预填规则和盘分；这里不自动提交，
  // 正式提交成功后才清掉那份草稿，取消返回仍可回到记分页。side = 'b'：记分时自己在 B 方，比分对调（录分页里自己固定在 A 方）
  scorerPrefill(options) {
    if (!options.scorer) return null;
    const d = SC.loadDraft();
    const r = d && d.id === options.scorer ? SC.handoff(d, options.side === 'b' ? 'b' : 'a') : null;
    if (!r) { wx.showToast({ title: '没找到已完赛的场边记分', icon: 'none' }); return null; }
    this.scorerId = d.id;
    return r;
  },

  async onShow() {
    // 从场边记分「带入日常录分」退回来：预填规则和盘分（球员不动）；按钮文字跟着草稿变（继续 / 开始）
    const back = SC.takeDailyPending();
    if (back) {
      const sc = this.scorerPrefill({ scorer: back.id, side: back.side });
      if (sc) { this.setData({ setGames: sc.setGames, noAd: sc.noAd, bestOf: sc.bestOf, initSets: sc.sets, fromScorer: true }); this.refresh(); }
    }
    this.refreshScorer();
    this.warmRackets();
    // 每次打开都实时校验；本机记得是正式成员（24 小时内确认过）就先显示、同时读球员，不等校验（不通过再收起，提交仍由云端校验）
    const M = require('../../utils/member');
    const check = M.status();
    const early = M.knownActive();
    if (early && !this.data.canRecordDaily) this.setData({ canRecordDaily: true, authError: '' });
    const players = early ? this.loadPlayers() : null;
    try {
      const member = await check;
      if (member.status !== 'active') {
        this.setData({ canRecordDaily: false, authError: '成为正式成员后才能记录比赛' }); return;
      }
      if (!this.data.canRecordDaily || this.data.authError) this.setData({ canRecordDaily: true, authError: '' });
      await (players || this.loadPlayers());
    } catch (e) { this.setData({ canRecordDaily: false, authError: '身份校验失败，请返回后重试' }); }
  },

  // 场边记分入口（2026-11-23 从战绩页右下角挪到这里）：本机有一场还没打完的日常记分就写「继续场边记分」；已经带入比分就不再显示
  refreshScorer() {
    const d = SC.loadDraft();
    const resume = !!(d && !d.ev && d.points && !SC.resultOf(d));
    if (resume !== this.data.scorerResume) this.setData({ scorerResume: resume });
  },
  openScorer() { wx.navigateTo({ url: '/pkg-manage/scorer/scorer' }); },

  // 只有已注册（设置过资料、昵称唯一）的球员可选：战绩按账号累计
  setPlayers(full) {
    this.uidOf = ID.uidByName(full);
    this.genderOf = {};
    full.forEach((p) => { if (p.uid) this.genderOf[p.name] = S.GENDER[p.gender] || ''; });
    this.players = full.filter((p) => p.uid && this.uidOf[p.name] === p.uid && p.uid !== this.myId).map((p) => p.name);
  },

  async loadPlayers() {
    try {
      // 球员用共享版（和战绩页同一个数组，不复制；setPlayers 只读）；已经选好的搭档、对手不动
      const [full, me, myId] = await Promise.all([(DB.playersShared || fetchPlayersFull)(), getMyProfile().catch(() => cachedProfile()), myOpenid().catch(() => '')]);
      this.myId = myId;
      this.setPlayers(full);
      const myName = me && ID.uidByName(full)[me.name] === myId ? me.name : '';
      this.slots.a[0] = myName; // 自己固定在 A 方
      if (this.active === 'a0') this.active = this.order().find((k) => !this.slots[k[0]][+k[1]]) || null;
      this.setData({ me: myName, noProfile: !myName });
      this.refresh();
    } catch (e) { console.error(e); }
  },
  goProfile() { wx.navigateTo({ url: '/pkg-manage/profile/profile' }); },

  resetSets() { const c = this.selectComponent('#sets'); if (c) c.reset(); },
  // 局分组件每次修改都会把校验结果传过来
  onSets(e) { this.res = e.detail; this.refresh(); },

  cfg() { return { setGames: this.data.setGames, noAd: this.data.noAd }; },
  order(type) { return (type || this.data.type) === 'double' ? ['a0', 'a1', 'b0', 'b1'] : ['a0', 'b0']; },

  /* ---------- 计算界面数据 ---------- */
  refresh() {
    const cfg = this.cfg();
    const dbl = this.data.type === 'double';
    const n = dbl ? 2 : 1;
    const mk = (side) => {
      const arr = [];
      for (let i = 0; i < n; i++) {
        const key = side + i, name = this.slots[side][i];
        arr.push({
          key, name, active: this.active === key,
          placeholder: (side === 'a' ? 'A' : 'B') + ' 方' + (dbl ? `球员${i + 1}` : '球员'),
          initial: name ? R.initialOf(name) : '', color: name ? R.colorOf(name) : '',
        });
      }
      return arr;
    };
    const aNames = this.slots.a.slice(0, n), bNames = this.slots.b.slice(0, n);
    const used = aNames.concat(bNames).filter(Boolean);

    const res = this.res;
    let check;
    if (!this.slots.a[0]) check = { ok: false, msg: '请先设置自己的昵称' };
    else if (used.length < n * 2) check = { ok: false, msg: dbl ? '请选择搭档和两名对手' : '请选择对手' };
    else if (res.ok) {
      const wn = (res.winner === 'a' ? aNames : bNames).join(' / ');
      check = { ok: true, msg: `${wn} 以 ${Math.max(res.won.a, res.won.b)}:${Math.min(res.won.a, res.won.b)} 获胜` };
    } else check = { ok: false, msg: res.msg };
    this.result = res.ok && used.length === n * 2 ? { sets: res.sets, winner: res.winner, won: res.won, a: aNames, b: bNames } : null;

    this.setData({
      slotsA: mk('a'), slotsB: mk('b'),
      chips: this.players.map((p) => ({ name: p, used: used.indexOf(p) >= 0, gender: (this.genderOf || {})[p] || '' })),
      aLabel: aNames.filter(Boolean).join('/') || 'A 方',
      bLabel: bNames.filter(Boolean).join('/') || 'B 方',
      check,
      rulesText: R.rulesText(cfg),
    });
  },

  saveCfg() {
    try { wx.setStorageSync(CFG_KEY, { setGames: this.data.setGames, noAd: this.data.noAd, bestOf: this.data.bestOf }); } catch (e) {}
  },

  goEvents() { wx.switchTab({ url: '/pages/draw/draw' }); },

  /* ---------- 基本信息 ---------- */
  onDate(e) { this.setData({ date: e.detail.value, dayText: dayOf(e.detail.value) }); },

  setType(e) {
    const type = e.currentTarget.dataset.v;
    if (type === this.data.type) return;
    if (type === 'single') { this.slots.a[1] = ''; this.slots.b[1] = ''; }
    this.setData({ type });
    this.active = this.order().find((k) => !this.slots[k[0]][+k[1]]) || null;
    this.refresh();
  },

  setBestOf(e) {
    this.setData({ bestOf: Number(e.currentTarget.dataset.v) }); // 局分组件会自己去掉多余的盘
    this.saveCfg(); this.refresh();
  },

  setGames(e) {
    const setGames = Number(e.currentTarget.dataset.v);
    if (setGames === this.data.setGames) return;
    this.setData({ setGames });
    this.saveCfg(); this.refresh();
  },

  setNoAd(e) {
    this.setData({ noAd: e.currentTarget.dataset.v === '1' });
    this.saveCfg(); this.refresh();
  },

  /* ---------- 选球员 ---------- */
  tapSlot(e) {
    const key = e.currentTarget.dataset.key;
    if (key === 'a0') { wx.showToast({ title: '日常比赛里你固定在 A 方', icon: 'none' }); return; }
    if (this.active === key && this.slots[key[0]][+key[1]]) this.slots[key[0]][+key[1]] = ''; // 再点一次清空
    this.active = key;
    this.refresh();
  },

  pickPlayer(e) { this.pick(e.currentTarget.dataset.name); },

  pick(name) {
    if (!this.active || this.active === 'a0') { wx.showToast({ title: '先点上面的一个位置', icon: 'none' }); return; }
    if (this.players.indexOf(name) < 0) return;
    ['a', 'b'].forEach((sd) => { this.slots[sd] = this.slots[sd].map((x) => (x === name ? '' : x)); });
    this.slots[this.active[0]][+this.active[1]] = name;
    this.active = this.order().find((k) => !this.slots[k[0]][+k[1]]) || null;
    this.refresh();
  },

  /* ---------- 保存 ---------- */
  async submit() {
    if (!this.data.canRecordDaily) return;
    if (this.data.submitting) return;
    const r = this.result;
    if (!r) { wx.showToast({ title: this.data.check.msg || '请完善比分', icon: 'none' }); return; }
    const aIds = ID.idsFor(r.a, this.uidOf), bIds = ID.idsFor(r.b, this.uidOf);
    if (aIds[0] !== this.myId || aIds.concat(bIds).some((x) => !x)) { wx.showToast({ title: '双方都要是已注册球员', icon: 'none' }); return; }
    this.setData({ submitting: true });
    try {
      const res = await addMatch({
        date: this.data.date, type: this.data.type, bestOf: this.data.bestOf,
        setGames: this.data.setGames, noAd: this.data.noAd,
        a: r.a, b: r.b, aIds, bIds,
        sets: r.sets, winner: r.winner, setsWon: r.won,
      });
      haptic.medium();
      const draftBefore = this.scorerId ? SC.loadDraft() : null;
      if (this.scorerId) { SC.clearDraft(this.scorerId); this.scorerId = ''; } // 正式提交成功才清掉对应的场边记分草稿
      const nextUrl = '/pkg-manage/match/match?id=' + res._id;
      const playDate = this.data.date || today();
      this.resetSets();
      if (this.openRkPrompt(r.sets, playDate, draftBefore, nextUrl)) return;
      wx.showToast({ title: '已记录，计入战绩', icon: 'success' });
      // 去比赛详情：录错了可以在那里直接改
      setTimeout(() => wx.redirectTo({ url: nextUrl }), 700);
    } catch (e) {
      console.error(e);
      wx.showModal({
        title: '保存失败',
        content: e.message || '请检查网络后再试一次',
        showCancel: false,
      });
    } finally {
      this.setData({ submitting: false });
    }
  },

  /* ---------- 录完比赛顺手记入球拍打球时长（有在役球拍时弹出，纯可选） ---------- */
  warmRackets() {
    try {
      const API = require('../../utils/rackets');
      const K = require('../../utils/racket');
      const c = API.cachedList && API.cachedList();
      if (c && Array.isArray(c.rackets)) { this.liveRks = K.liveRackets(c.rackets); return; }
      if (API.load) API.load().then((r) => { if (r && Array.isArray(r.rackets)) this.liveRks = K.liveRackets(r.rackets); }, () => {});
    } catch (e) {}
  },
  openRkPrompt(sets, date, draft, nextUrl) {
    let list = this.liveRks;
    if (!list) {
      try {
        const API = require('../../utils/rackets');
        const K = require('../../utils/racket');
        const c = API.cachedList && API.cachedList();
        if (c && Array.isArray(c.rackets)) list = K.liveRackets(c.rackets);
      } catch (e) {}
    }
    if (!list || !list.length) return false;
    const K = require('../../utils/racket');
    const el = draft && draft.startedAt && draft.endedAt ? Math.round((draft.endedAt - draft.startedAt) / 60000) : 0;
    const est = el >= 5 && el <= 600 ? el : K.estimateMatchMins(sets);
    this.afterRkUrl = nextUrl;
    this.setData({ rkOpen: true, rkBusy: false, rkList: list, rkId: list[0].id, rkMin: String(est), rkDate: date });
    return true;
  },
  pickRk(e) { this.setData({ rkId: e.currentTarget.dataset.id }); },
  rkMinQuick(e) { this.setData({ rkMin: e.currentTarget.dataset.m }); },
  rkMinInput(e) { this.setData({ rkMin: String(e.detail.value || '').replace(/\D/g, '').slice(0, 3) }); },
  // 弹层内容拦住点击、什么都不做：catchtap 写空字符串拦不住，点里面的选项会冒泡到遮罩把弹层关掉
  noop() {},
  skipRkLog() {
    if (this.data.rkBusy) return;
    const url = this.afterRkUrl;
    this.setData({ rkOpen: false });
    if (url) wx.redirectTo({ url });
  },
  async saveRkLog() {
    if (this.data.rkBusy) return;
    if (!this.data.rkId) { wx.showToast({ title: '请先选择球拍', icon: 'none' }); return; }
    if (!/^\d+$/.test(this.data.rkMin)) { wx.showToast({ title: '请填打球分钟数', icon: 'none' }); return; }
    const K = require('../../utils/racket');
    const API = require('../../utils/rackets');
    const d = this.data.rkDate || today();
    const chk = K.cleanLog({ kind: 'play', date: d, minutes: Number(this.data.rkMin) }, today());
    if (!chk.ok) { wx.showToast({ title: chk.msg, icon: 'none' }); return; }
    this.setData({ rkBusy: true });
    try {
      await API.saveLog('', this.data.rkId, chk.rec);
      const url = this.afterRkUrl;
      this.setData({ rkOpen: false, rkBusy: false });
      haptic.medium();
      wx.showToast({ title: '已记入球拍时长', icon: 'success' });
      if (API.refreshBadge) API.refreshBadge();
      if (url) setTimeout(() => wx.redirectTo({ url }), 600);
    } catch (err) {
      this.setData({ rkBusy: false });
      wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
    }
  },
});
