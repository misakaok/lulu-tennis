// 某位球员的全部正式战绩（和主页「近期比赛」同一份数据）
const db = require('../../utils/db');
const PV = require('../../utils/player');

Page({
  data: { uid: '', name: '', rows: [], summary: '', filter: 'all', shown: [], loading: true },
  onLoad(o) {
    this.setData({ uid: decodeURIComponent(o.uid || '') });
    this.render(db.cachedProfiles(), db.cachedPlayersFull(), db.cachedMatches());
    this.load();
  },
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },
  async load() {
    try {
      const [players, matches] = await Promise.all([db.fetchPlayersFull(), db.fetchMatches()]);
      this.render(db.cachedProfiles(), players, matches);
    } catch (e) { console.error(e); }
    this.setData({ loading: false });
  },
  render(profiles, players, matches) {
    const v = PV.playerView(profiles, players, matches, this.data.uid);
    if (v.profile) wx.setNavigationBarTitle({ title: v.profile.name + ' 的战绩' });
    this.rows = v.rows;
    this.setData({
      name: v.profile ? v.profile.name : '',
      summary: v.profile ? `${v.stats.matches === '暂无' ? 0 : v.stats.matches} 场 · ${v.stats.wl} · 胜率 ${v.stats.rate}` : '',
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
