// 记录日常比赛（不属于赛事的约球）：自己固定在 A 方，搭档和对手只能选已注册球员（按用户 ID 关联）。
// 提交后是「待确认」，对手确认后才计入正式战绩、排名，并开放互评（见 utils/official.js）。
// 赛事里的比赛不在这里录：从赛事签表 / 赛程点对应场次录分。
const R = require('../../utils/rules');
const ID = require('../../utils/ident');
const { fetchPlayersFull, cachedPlayersFull, addMatch, getMyProfile, cachedProfile, myOpenid } = require('../../utils/db');

const pad = (n) => (n < 10 ? '0' + n : '' + n);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const CFG_KEY = 'last_rules';

Page({
  data: {
    date: '', today: '', type: 'single', bestOf: 3, setGames: 4, noAd: true,
    slotsA: [], slotsB: [], chips: [], me: '', noProfile: false,
    aLabel: 'A 方', bLabel: 'B 方',
    check: { ok: false, msg: '' }, submitting: false, rulesText: '',
  },

  onLoad() {
    const t = today();
    let last = {};
    try { last = wx.getStorageSync(CFG_KEY) || {}; } catch (e) {}
    const cfg = R.normCfg(last);
    this.setPlayers(cachedPlayersFull());
    this.slots = { a: ['', ''], b: ['', ''] };
    this.active = 'a0';
    this.res = { ok: false, msg: '请至少填写一盘' };
    this.setData({ date: t, today: t, setGames: cfg.setGames, noAd: cfg.noAd, bestOf: last.bestOf === 1 ? 1 : 3 });
    this.refresh();
  },

  onShow() {
    this.loadPlayers().then(() => this.applyPrefill());
  },

  // 只有已注册（设置过资料、昵称唯一）的球员可选：对手要用自己的账号确认比分
  setPlayers(full) {
    this.avatarOf = {};
    this.uidOf = ID.uidByName(full);
    full.forEach((p) => { if (p.avatar) this.avatarOf[p.name] = p.avatar; });
    this.players = full.filter((p) => p.uid && this.uidOf[p.name] === p.uid && p.uid !== this.myId).map((p) => p.name);
  },

  async loadPlayers() {
    try {
      const [full, me, myId] = await Promise.all([fetchPlayersFull(), getMyProfile().catch(() => cachedProfile()), myOpenid().catch(() => '')]);
      this.myId = myId;
      this.setPlayers(full);
      const myName = me && ID.uidByName(full)[me.name] === myId ? me.name : '';
      this.slots.a[0] = myName; // 自己固定在 A 方
      if (this.active === 'a0') this.active = this.order().find((k) => !this.slots[k[0]][+k[1]]) || null;
      this.setData({ me: myName, noProfile: !myName });
      this.refresh();
    } catch (e) { console.error(e); }
  },
  goProfile() { wx.navigateTo({ url: '/pages/profile/profile' }); },

  // 从「挑战」页过来时，自动填好对手（只填已注册球员）
  applyPrefill() {
    let pre = null;
    try { pre = wx.getStorageSync('prefill_match'); wx.removeStorageSync('prefill_match'); } catch (e) {}
    if (!pre || !pre.b) return;
    const ok = (n) => (n && this.players.indexOf(n) >= 0 ? n : '');
    this.setData({ type: pre.b.length > 1 ? 'double' : 'single' });
    this.slots = { a: [this.slots.a[0], ok((pre.a || [])[1])], b: [ok(pre.b[0]), ok(pre.b[1])] };
    this.active = this.order().find((k) => !this.slots[k[0]][+k[1]]) || null;
    this.resetSets();
    this.refresh();
  },

  resetSets() { const c = this.selectComponent('#sets'); if (c) c.reset(); },
  // 局分组件每次修改都会把校验结果传过来
  onSets(e) { this.res = e.detail; this.refresh(); },

  cfg() { return { setGames: this.data.setGames, noAd: this.data.noAd }; },
  order() { return this.data.type === 'double' ? ['a0', 'a1', 'b0', 'b1'] : ['a0', 'b0']; },

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
          avatar: name ? (this.avatarOf || {})[name] || '' : '',
        });
      }
      return arr;
    };
    const aNames = this.slots.a.slice(0, n), bNames = this.slots.b.slice(0, n);
    const used = aNames.concat(bNames).filter(Boolean);

    const res = this.res;
    let check;
    if (!this.slots.a[0]) check = { ok: false, msg: '请先设置自己的头像和昵称' };
    else if (used.length < n * 2) check = { ok: false, msg: dbl ? '请选择搭档和两名对手' : '请选择对手' };
    else if (res.ok) {
      const wn = (res.winner === 'a' ? aNames : bNames).join(' / ');
      check = { ok: true, msg: `🏆 ${wn} 以 ${Math.max(res.won.a, res.won.b)}:${Math.min(res.won.a, res.won.b)} 获胜` };
    } else check = { ok: false, msg: res.msg };
    this.result = res.ok && used.length === n * 2 ? { sets: res.sets, winner: res.winner, won: res.won, a: aNames, b: bNames } : null;

    this.setData({
      slotsA: mk('a'), slotsB: mk('b'),
      chips: this.players.map((p) => ({ name: p, used: used.indexOf(p) >= 0, avatar: this.avatarOf[p] || '' })),
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
  onDate(e) { this.setData({ date: e.detail.value }); },

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
    if (this.data.submitting) return;
    const r = this.result;
    if (!r) { wx.showToast({ title: this.data.check.msg || '请完善比分', icon: 'none' }); return; }
    const aIds = ID.idsFor(r.a, this.uidOf), bIds = ID.idsFor(r.b, this.uidOf);
    if (aIds[0] !== this.myId || aIds.concat(bIds).some((x) => !x)) { wx.showToast({ title: '双方都要是已注册球员', icon: 'none' }); return; }
    require('../../utils/notify').ask(); // 顺便请求通知权限（必须在点击时同步调用）
    this.setData({ submitting: true });
    try {
      const res = await addMatch({
        date: this.data.date, type: this.data.type, bestOf: this.data.bestOf,
        setGames: this.data.setGames, noAd: this.data.noAd,
        a: r.a, b: r.b, aIds, bIds,
        sets: r.sets, winner: r.winner, setsWon: r.won,
      });
      wx.showToast({ title: '已提交，等对手确认', icon: 'success' });
      this.resetSets();
      // 去比赛详情：能看到确认状态；对手在「我的」待办里确认
      setTimeout(() => wx.redirectTo({ url: '/pages/match/match?id=' + res._id }), 700);
    } catch (e) {
      console.error(e);
      wx.showModal({
        title: '保存失败',
        content: '请检查网络，或确认云开发和数据库集合已创建。\n' + (e.errMsg || e.message || ''),
        showCancel: false,
      });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
