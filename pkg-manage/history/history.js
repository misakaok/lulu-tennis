// 某位球员的全部正式战绩（和主页「近期比赛」同一份数据）：支持活动/日常、单双打、胜负、日期筛选与每页 5 场翻页
const db = require('../../utils/db');
const PV = require('../../utils/player');
const haptic = require('../../utils/haptic');

const PAGE = 5;
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shortDate = (str) => {
  if (!str) return '';
  const y = String(new Date().getFullYear());
  return str.indexOf(y + '-') === 0 ? str.slice(5) : str.slice(2);
};

Page({
  data: {
    uid: '', name: '', sum: null,
    filter: 'all', typeFilter: 'all', resFilter: 'all',
    pickDate: '', pickShort: '', today: ymd(new Date()),
    hasFilter: false, fltWin: 0, fltLose: 0,
    shown: [], page: 1, totalPages: 1, totalCount: 0, pageOpts: ['第 1 页'], loading: true,
  },
  onLoad(o) {
    this.page = 1;
    this.setData({ uid: decodeURIComponent(o.uid || ''), today: ymd(new Date()) });
    this.render(db.cachedProfiles(), db.cachedPlayersFull(), db.cachedMatches());
    this.load();
  },
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    this.load().then(() => wx.stopPullDownRefresh()); },
  async load() {
    const seq = this.loadSeq = (this.loadSeq || 0) + 1; // 连着读两次（下拉刷新）：只认最后一次
    try {
      // 共享版（只读，不复制），资料跟着这次拿到的球员列表走：本机缓存是异步写的，这时同步读 cachedProfiles / cachedMatches 可能还是空的
      const [players, matches] = await Promise.all([db.playersShared(), db.matchesShared()]);
      if (seq !== this.loadSeq) return;
      this.render(db.profilesOf(players), players, matches);
    } catch (e) { console.error(e); }
    if (seq === this.loadSeq) this.setData({ loading: false });
  },
  render(profiles, players, matches) {
    const v = PV.playerView(profiles, players, matches, this.data.uid);
    if (v.profile) wx.setNavigationBarTitle({ title: v.profile.name + ' 的战绩' });
    this.rows = v.rows;
    this.setData({
      name: v.profile ? v.profile.name : '',
      // 顶部数字卡：场数、胜、负、胜率（和球员卡同一份统计）
      sum: v.profile ? { matches: v.stats.matches === PV.NONE ? '0' : v.stats.matches, win: v.stats.win, lose: v.stats.lose, rate: v.stats.rate === PV.NONE ? '—' : v.stats.rate } : null,
    });
    this.apply();
  },
  setFilter(e) {
    const v = e.currentTarget.dataset.v;
    if (v !== this.data.filter) haptic.light();
    this.page = 1;
    this.setData({ filter: v });
    this.apply();
  },
  toggleType(e) {
    const v = e.currentTarget.dataset.v;
    haptic.light();
    this.page = 1;
    this.setData({ typeFilter: this.data.typeFilter === v ? 'all' : v });
    this.apply();
  },
  toggleRes(e) {
    const v = e.currentTarget.dataset.v;
    haptic.light();
    this.page = 1;
    this.setData({ resFilter: this.data.resFilter === v ? 'all' : v });
    this.apply();
  },
  onPickDate(e) {
    const d = e && e.detail && e.detail.value;
    if (!d) return;
    haptic.light();
    this.page = 1;
    this.setData({ pickDate: d, pickShort: shortDate(d) });
    this.apply();
  },
  clearDate() {
    if (!this.data.pickDate) return;
    haptic.light();
    this.page = 1;
    this.setData({ pickDate: '', pickShort: '' });
    this.apply();
  },
  resetFilters() {
    haptic.light();
    this.page = 1;
    this.setData({ filter: 'all', typeFilter: 'all', resFilter: 'all', pickDate: '', pickShort: '' });
    this.apply();
  },
  apply() {
    const { filter, typeFilter, resFilter, pickDate } = this.data;
    const list = (this.rows || []).filter((r) => {
      if (filter === 'event' && !r.isEvent) return false;
      if (filter === 'daily' && r.isEvent) return false;
      if (typeFilter !== 'all' && r.type !== typeFilter) return false;
      if (resFilter === 'win' && (r.outcomeTag || !r.win)) return false;
      if (resFilter === 'lose' && (r.outcomeTag || r.win)) return false;
      if (pickDate && r.date !== pickDate) return false;
      return true;
    });
    let fltWin = 0, fltLose = 0;
    list.forEach((r) => { if (!r.outcomeTag) { if (r.win) fltWin++; else fltLose++; } });
    const totalCount = list.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / PAGE));
    const page = Math.min(Math.max(1, this.page || 1), totalPages);
    this.page = page;
    const start = (page - 1) * PAGE;
    const pageOpts = [];
    for (let i = 1; i <= totalPages; i++) pageOpts.push(`第 ${i} 页`);
    const hasFilter = filter !== 'all' || typeFilter !== 'all' || resFilter !== 'all' || !!pickDate;
    this.setData({
      shown: list.slice(start, start + PAGE),
      page, totalPages, totalCount, pageOpts, hasFilter, fltWin, fltLose,
    });
  },
  goPage(next) {
    const tp = this.data.totalPages || 1;
    const p = Math.min(Math.max(1, next), tp);
    if (p === (this.page || 1)) return;
    haptic.light();
    this.page = p;
    this.apply();
    if (typeof wx !== 'undefined' && wx.pageScrollTo) wx.pageScrollTo({ scrollTop: 0, duration: 220 });
  },
  prevPage() { this.goPage((this.page || 1) - 1); },
  nextPage() { this.goPage((this.page || 1) + 1); },
  pickPage(e) {
    const idx = Number(e && e.detail && e.detail.value);
    if (!Number.isFinite(idx)) return;
    this.goPage(idx + 1);
  },
  openMatch(e) { // 先发出比赛状态请求（比赛详情第一次读取接过去）
    const id = e.currentTarget.dataset.id;
    db.prefetchMatchState(id);
    wx.navigateTo({ url: '/pkg-manage/match/match?id=' + id });
  },
});
