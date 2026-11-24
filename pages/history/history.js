// 某位球员的全部正式战绩（和主页「近期比赛」同一份数据）
const db = require('../../utils/db');
const PV = require('../../utils/player');

Page({
  data: { uid: '', name: '', rows: [], sum: null, filter: 'all', shown: [], loading: true },
  onLoad(o) {
    this.setData({ uid: decodeURIComponent(o.uid || '') });
    this.render(db.cachedProfiles(), db.cachedPlayersFull(), db.cachedMatches());
    this.load();
  },
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    this.load().then(() => wx.stopPullDownRefresh()); },
  async load() {
    try {
      // 共享版（只读，不复制），资料跟着这次拿到的球员列表走：本机缓存是异步写的，这时同步读 cachedProfiles / cachedMatches 可能还是空的
      const [players, matches] = await Promise.all([db.playersShared(), db.matchesShared()]);
      this.render(db.profilesOf(players), players, matches);
    } catch (e) { console.error(e); }
    this.setData({ loading: false });
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
  setFilter(e) { this.setData({ filter: e.currentTarget.dataset.v }); this.apply(); },
  apply() {
    const f = this.data.filter;
    this.setData({ shown: (this.rows || []).filter((r) => f === 'all' || (f === 'event' ? r.isEvent : !r.isEvent)) });
  },
  openMatch(e) { wx.navigateTo({ url: '/pages/match/match?id=' + e.currentTarget.dataset.id }); },
});
