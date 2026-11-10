const db = require('../../utils/db');
const R = require('../../utils/rating');
const S = require('../../utils/stats');
const { computeRank, colorOf, initialOf } = require('../../utils/rules');
const ID = require('../../utils/ident');
const SE = require('../../utils/season');
const cloud = require('../../utils/cloud');

const PAGE = 50; // 榜单每次显示多少名，滑到底再加载

Page({
  data: {
    filter: 'all', sort: 'level',
    types: [{ label: '全部', value: 'all' }, { label: '单打', value: 'single' }, { label: '双打', value: 'double' }],
    top: [], ranked: [], more: false, loading: true, myKey: '',
    season: SE.ALL, seasons: [{ label: '生涯', value: SE.ALL }], onlyFollow: false, followCount: 0,
  },

  onLoad() {
    this.limit = PAGE;
    this.setSource(db.cachedMatches(), db.cachedPlayersFull(), (db.cachedProfile() || {})._openid || '');
    this.render();
  },
  onShow() { this.load(); },
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    this.load().then(() => wx.stopPullDownRefresh()); },
  onReachBottom() {
    if (!this.data.more) return;
    this.limit += PAGE;
    this.setData({ ranked: this.list.slice(0, this.limit), more: this.list.length > this.limit });
  },

  async load() {
    try {
      // 只需要自己的用户 ID（本机有缓存），不用每次读一遍个人资料
      const [m, p, myId] = await Promise.all([db.fetchMatches(), db.fetchPlayersFull(), db.myOpenid().catch(() => this.myId)]);
      // 数据和上次一样（切换 tab、缓存命中）就不重算、不重新渲染
      if (this.setSource(m, p, myId)) this.render();
      // 我关注的人（只用来筛选榜单；读不到就不显示这个筛选）
      cloud.cached('followInfo').then((r) => {
        const sig = r.following.join(',');
        if (sig === this.followSig) return;
        this.followSig = sig;
        this.following = {};
        r.following.forEach((u) => { this.following[u] = 1; });
        this.setData({ followCount: r.following.length, onlyFollow: this.data.onlyFollow && r.following.length > 0 });
        if (this.data.onlyFollow) this.render();
      }).catch(() => {});
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '网络异常，显示的是缓存数据', icon: 'none' });
    }
    if (this.data.loading) this.setData({ loading: false });
  },

  // 换数据源：水平分、头像只在数据变化时算一次（切换筛选 / 排序、翻页都不重算）。返回是否有变化
  setSource(matches, players, myId) {
    const sig = JSON.stringify([matches || [], players || [], myId || '']);
    if (sig === this.sig) return false;
    this.sig = sig;
    this.all = matches || []; this.players = players || []; this.myId = myId || '';
    this.avatarOf = {};
    this.players.forEach((p) => { if (p.avatar) this.avatarOf[p.name] = p.avatar; });
    // 水平分始终用全部比赛（单打 + 双打）计算
    this.ratings = R.computeRatings(this.all, R.startLevelsFrom(this.players));
    // 赛季（自然年）：胜负、胜率只看这个赛季的比赛；水平分不分赛季
    const seasons = [{ label: '生涯', value: SE.ALL }].concat(SE.seasonsIn(this.all).map((s) => ({ label: s, value: s })));
    if (JSON.stringify(seasons) !== JSON.stringify(this.data.seasons)) this.setData({ seasons });
    return true;
  },

  setFilter(e) { this.limit = PAGE; this.setData({ filter: e.currentTarget.dataset.v }); this.render(); },
  setSort(e) { this.limit = PAGE; this.setData({ sort: e.currentTarget.dataset.v }); this.render(); },
  setSeason(e) { this.limit = PAGE; this.setData({ season: e.currentTarget.dataset.v }); this.render(); },
  toggleFollow() { this.limit = PAGE; this.setData({ onlyFollow: !this.data.onlyFollow }); this.render(); },

  render() {
    const avatarOf = this.avatarOf || {};
    let list = computeRank(SE.inSeason(this.all || [], this.data.season), this.data.filter).map((p) => {
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
    // 只看关注：名次还是全榜的名次，只是只显示我关注的人和我自己
    if (this.data.onlyFollow) list = list.filter((p) => (this.following || {})[p.key] || p.key === this.myId);
    const top = this.data.onlyFollow ? [] : list.length >= 3 ? [list[1], list[0], list[2]] : list.slice(0, 3);
    this.list = list;
    // 榜单先显示前 limit 名，滑到底再加载
    const limit = this.limit || PAGE;
    this.setData({ top, ranked: list.slice(0, limit), more: list.length > limit, myKey: this.myId || '', none: !list.length });
  },

  // 点球员 → 球员主页（主页上可以发起挑战、评价）
  // 排行按统计身份：key 不是 'n:' 开头的就是用户 ID
  tapPlayer(e) {
    const key = e.currentTarget.dataset.key || '';
    const uid = key && key.indexOf(ID.NAME_KEY) !== 0 ? key : '';
    if (uid && uid === this.myId) { wx.switchTab({ url: '/pages/me/me' }); return; }
    if (!uid) { wx.showToast({ title: '这位球员没有绑定账号', icon: 'none' }); return; }
    wx.navigateTo({ url: '/pages/player/player?uid=' + encodeURIComponent(uid) });
  },
});
