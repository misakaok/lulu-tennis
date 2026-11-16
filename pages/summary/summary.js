// 赛季总结：某位球员某个赛季（自然年）的一页汇总。/pages/summary/summary?uid=xxx&season=2026
// 全部由正式战绩实时计算（utils/player.js seasonSummary → utils/career.js），不存数据库，口径和排行榜、球员主页一致
const db = require('../../utils/db');
const R = require('../../utils/rating');
const PV = require('../../utils/player');
const SE = require('../../utils/season');
const Anim = require('../../utils/anim');
const { initialOf, colorOf } = require('../../utils/rules');

Page({
  data: { loading: true, s: null, name: '', initial: '', color: '', seasons: [], season: '' },
  onLoad(o) {
    wx.hideShareMenu();
    this.uid = decodeURIComponent(o.uid || '');
    this.setData({ season: /^\d{4}$/.test(o.season || '') ? o.season : SE.current() });
    this.render(db.cachedProfiles(), db.cachedPlayersFull(), db.cachedMatches());
    this.load();
  },
  onUnload() { Anim.stop(this); },
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    this.load().then(() => wx.stopPullDownRefresh()); },
  async load() {
    try {
      const [players, matches] = await Promise.all([db.fetchPlayersFull(), db.fetchMatches()]);
      this.render(db.cachedProfiles(), players, matches);
    } catch (e) { console.error(e); }
    this.setData({ loading: false });
  },
  render(profiles, players, matches) {
    this.src = { profiles, players, matches };
    const p = profiles && profiles[this.uid];
    if (!p) { this.setData({ s: null, name: '' }); return; }
    const r = R.computeRatings(matches || [], R.startLevelsFrom(players || [])).players[this.uid];
    const mine = (matches || []).filter((m) => PV.sideOf(m, this.uid, p.name));
    const s = PV.seasonSummary(matches || [], this.uid, p.name, this.data.season, r ? r.history : []);
    wx.setNavigationBarTitle({ title: `${p.name} · ${s.label}` });
    const nums = s.has ? { 's.played': s.played, 's.win': s.win, 's.lose': s.lose, 's.rate': s.rate } : {}; // 第一次显示时数字从 0 滚到实际值
    this.setData(Object.assign({ s, name: p.name, initial: initialOf(p.name), color: colorOf(p.name), seasons: SE.seasonsIn(mine) }, Anim.roll(this, nums)));
  },
  setSeason(e) {
    this.setData({ season: e.currentTarget.dataset.v });
    if (this.src) this.render(this.src.profiles, this.src.players, this.src.matches);
  },
});
