const db = require('../../utils/db');
const R = require('../../utils/rating');
const S = require('../../utils/stats');
const { computeRank, colorOf, initialOf } = require('../../utils/rules');
const ID = require('../../utils/ident');

Page({
  data: {
    filter: 'all', sort: 'level',
    types: [{ label: '全部', value: 'all' }, { label: '单打', value: 'single' }, { label: '双打', value: 'double' }],
    top: [], ranked: [], loading: true, myKey: '',
  },

  onLoad() {
    this.all = db.cachedMatches();
    this.players = db.cachedPlayersFull();
    this.me = db.cachedProfile();
    this.render();
  },
  onShow() { this.load(); },
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    this.load().then(() => wx.stopPullDownRefresh()); },

  async load() {
    try {
      const [m, p, me] = await Promise.all([db.fetchMatches(), db.fetchPlayersFull(), db.getMyProfile()]);
      this.all = m; this.players = p; this.me = me;
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '网络异常，显示的是缓存数据', icon: 'none' });
    }
    this.setData({ loading: false });
    this.render();
  },

  setFilter(e) { this.setData({ filter: e.currentTarget.dataset.v }); this.render(); },
  setSort(e) { this.setData({ sort: e.currentTarget.dataset.v }); this.render(); },

  render() {
    const players = this.players || [];
    const avatarOf = {};
    players.forEach((p) => { if (p.avatar) avatarOf[p.name] = p.avatar; });
    // 水平分始终用全部比赛（单打 + 双打）计算
    this.ratings = R.computeRatings(this.all || [], R.startLevelsFrom(players));
    const list = computeRank(this.all || [], this.data.filter).map((p) => {
      const r = this.ratings.players[p.key];
      const level = r ? r.level : R.DEFAULT_LEVEL;
      return Object.assign(p, {
        level, levelText: R.fmt(level), provisional: !r || r.provisional,
        initial: initialOf(p.name), color: colorOf(p.name), avatar: avatarOf[p.name] || '',
        diffText: (p.diff > 0 ? '+' : '') + p.diff,
      });
    });
    if (this.data.sort === 'level') {
      // 定级完成的排前面，再按水平从高到低
      list.splice(0, list.length, ...S.rankOrder(list)); // 和报名列表里的「排名」用同一个排序
    }
    list.forEach((p, i) => { p.rank = i + 1; });
    const top = list.length >= 3 ? [list[1], list[0], list[2]] : list.slice(0, 3);
    this.setData({ top, ranked: list, myKey: this.me ? this.me._openid || '' : '' });
  },

  // 点球员 → 球员主页（主页上可以发起挑战、评价）
  // 排行按统计身份：key 不是 'n:' 开头的就是用户 ID
  tapPlayer(e) {
    const key = e.currentTarget.dataset.key || '';
    const uid = key && key.indexOf(ID.NAME_KEY) !== 0 ? key : '';
    if (this.me && uid && uid === this.me._openid) { wx.switchTab({ url: '/pages/me/me' }); return; }
    if (!uid) { wx.showToast({ title: '这位球员没有绑定账号', icon: 'none' }); return; }
    wx.navigateTo({ url: '/pages/player/player?uid=' + encodeURIComponent(uid) });
  },
});
