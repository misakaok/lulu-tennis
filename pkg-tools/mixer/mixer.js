// 4～8 人智能均衡双打排班器：选到场成员（或直接按编号 4/6/8 人），按当前水平自动排均衡组合与公平轮换，纯本地
const MX = require('../utils/mixer');
const db = require('../../utils/db');
const R = require('../../utils/rating');
const PV = require('../../utils/privacy');
const haptic = require('../../utils/haptic');

const ROUND_OPTS = [1, 3, 4, 5, 6];

Page({
  data: {
    all: [], // 可选成员：[{ id, name, level, lvText, on }]
    picked: [],
    rounds: 4, roundOpts: ROUND_OPTS,
    courts: 1, canTwo: false,
    seed: 0, res: null,
  },

  onLoad() {
    wx.hideShareMenu({ fail() {} });
    this.buildList(db.cachedPlayersFull ? db.cachedPlayersFull() : [], db.cachedMatches ? db.cachedMatches() : []);
    this.loadFresh();
  },

  async loadFresh() {
    try {
      const [players, matches] = await Promise.all([
        db.playersShared ? db.playersShared() : Promise.resolve([]),
        db.matchesShared ? db.matchesShared() : Promise.resolve([]),
      ]);
      this.buildList(players, matches);
    } catch (e) {}
  },

  buildList(players, matches) {
    const ratings = R.ratingsOf(matches || [], players || []);
    const pickedMap = {};
    if (!this.demoMode) (this.data.picked || []).forEach((p) => { pickedMap[p.id] = 1; });
    const list = (players || []).filter((p) => p && p.name && p.uid).map((p) => {
      const lv = R.levelOf(ratings, p.name, players, p.uid);
      return { id: p.uid, name: p.name, level: lv, lvText: R.fmt(lv), on: !!pickedMap[p.uid] };
    });
    // 按是否已选 + 水平高低排好，方便挑选
    list.sort((a, b) => (b.on ? 1 : 0) - (a.on ? 1 : 0) || b.level - a.level || a.name.localeCompare(b.name));
    // 已进入编号占位快速排班时：后台云端成员回来只刷新可选名单，不冲掉当前已排的占位球友
    if (this.demoMode) { this.setData({ all: list }); return; }
    const picked = list.filter((x) => x.on);
    this.setData({ all: list, picked });
    if (picked.length >= 4) this.compute(picked, this.data.rounds, this.data.courts, this.data.seed);
  },

  togglePlayer(e) {
    const id = e.currentTarget.dataset.id;
    const all = this.data.all.slice();
    const idx = all.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const cur = all[idx];
    const cnt = all.filter((x) => x.on).length;
    if (!cur.on && cnt >= 8) { wx.showToast({ title: '最多选 8 位球友', icon: 'none' }); return; }
    this.demoMode = false;
    all[idx] = Object.assign({}, cur, { on: !cur.on });
    const picked = all.filter((x) => x.on);
    const courts = picked.length >= 8 ? this.data.courts : 1;
    this.setData({ all, picked, courts, canTwo: picked.length >= 8 });
    this.compute(picked, this.data.rounds, courts, this.data.seed);
    haptic.light();
  },

  // 临时约球免选人：直接用 4 / 6 / 8 位编号占位快速排轮换表
  quickDemo(e) {
    const n = Number(e.currentTarget.dataset.n) || 6;
    this.demoMode = true;
    const all = this.data.all.map((x) => Object.assign({}, x, { on: false }));
    const picked = [];
    for (let i = 1; i <= n; i++) picked.push({ id: 'q' + i, name: `${i} 号球友`, level: 2.5, lvText: '2.5', on: true });
    const courts = n >= 8 ? 2 : 1;
    this.setData({ all, picked, courts, canTwo: n >= 8, seed: 0 });
    this.compute(picked, this.data.rounds, courts, 0);
    haptic.light();
  },

  clearPick() {
    this.demoMode = false;
    const all = this.data.all.map((x) => Object.assign({}, x, { on: false }));
    this.setData({ all, picked: [], courts: 1, canTwo: false, res: null });
    haptic.light();
  },

  setRounds(e) {
    const rounds = Number(e.currentTarget.dataset.v) || 4;
    this.setData({ rounds });
    this.compute(this.data.picked, rounds, this.data.courts, this.data.seed);
    haptic.light();
  },

  setCourts(e) {
    const courts = Number(e.currentTarget.dataset.v) === 2 && this.data.picked.length >= 8 ? 2 : 1;
    this.setData({ courts });
    this.compute(this.data.picked, this.data.rounds, courts, this.data.seed);
    haptic.light();
  },

  reroll() {
    if (this.data.picked.length < 4) return;
    const seed = this.data.seed + 1;
    this.setData({ seed });
    this.compute(this.data.picked, this.data.rounds, this.data.courts, seed);
    haptic.medium();
  },

  compute(picked, rounds, courts, seed) {
    if (!picked || picked.length < 4) { this.setData({ res: null }); return; }
    const res = MX.schedule(picked, { rounds, courts, seed });
    this.setData({ res });
  },

  copyPlan() {
    const text = MX.formatSchedule(this.data.res);
    if (!text) return;
    wx.setClipboardData({
      data: text,
      success: () => { haptic.medium(); wx.showToast({ title: '已复制排班表，可粘贴发群', icon: 'success' }); },
      fail: (e) => PV.copyFail(e),
    });
  },
});
