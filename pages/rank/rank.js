const db = require('../../utils/db');
const R = require('../../utils/rating');
const S = require('../../utils/stats');
const { computeRank, colorOf, initialOf } = require('../../utils/rules');
const ID = require('../../utils/ident');
const SE = require('../../utils/season');
const Anim = require('../../utils/anim');

const PAGE = 50; // 榜单每次显示多少名，滑到底再加载

Page({
  data: {
    filter: 'all', sort: 'level', gender: 'all', board: false, colLbl: '水平', emptyText: '',
    sorts: [{ label: '按水平', value: 'level' }, { label: '按胜场', value: 'win' }, { label: '本月活跃', value: 'active' }, { label: '连胜', value: 'streak' }, { label: '本月进步', value: 'gain' }],
    genders: [{ label: '不限', value: 'all' }, { label: '男', value: '男' }, { label: '女', value: '女' }],
    types: [{ label: '全部', value: 'all' }, { label: '单打', value: 'single' }, { label: '双打', value: 'double' }],
    top: [], ranked: [], more: false, loading: true, myKey: '', play: true, // play：入场动画（切换 tab 回来时重播）
    season: SE.ALL, seasons: [{ label: '生涯', value: SE.ALL }],
    view: 'level', cupTick: 0, // 水平排行 / LULU 积分；cupTick 加一让积分组件重新读取
  },

  onLoad() {
    this.limit = PAGE;
    this.setSource(db.cachedMatches(), db.cachedPlayersFull(), (db.cachedProfile() || {})._openid || '');
    this.render();
  },
  onShow() {
    const replay = Anim.enter(this); // 切换 tab 回来：重播领奖台、榜单的入场动画
    if (Object.keys(replay).length) this.setData(replay);
    if (this.data.view === 'cup') this.setData({ cupTick: this.data.cupTick + 1 }); // 从补录页回来：积分马上更新
    this.load();
  },
  onHide() { Anim.leave(this); },
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    // LULU 积分：只刷新积分，等积分组件读完（onCupLoaded）才停下拉
    if (this.data.view === 'cup') { this.cupPulling = true; this.setData({ cupTick: this.data.cupTick + 1 }); return; }
    this.load().then(() => wx.stopPullDownRefresh()); },
  onCupLoaded() { if (this.cupPulling) { this.cupPulling = false; wx.stopPullDownRefresh(); } },
  setView(e) { const v = e.currentTarget.dataset.v === 'cup' ? 'cup' : 'level'; if (v !== this.data.view) this.setData({ view: v }); },
  onReachBottom() {
    if (this.data.view !== 'level' || !this.data.more) return;
    this.limit += PAGE;
    this.setData({ ranked: this.list.slice(0, this.limit), more: this.list.length > this.limit });
  },

  async load() {
    try {
      // 只需要自己的用户 ID（本机有缓存），不用每次读一遍个人资料
      // 共享数据（不复制，只读）：数据没变时是同一个数组
      const [m, p, myId] = await Promise.all([db.matchesShared(), db.playersShared(), db.myOpenid().catch(() => this.myId)]);
      // 数据和上次一样（切换 tab、缓存命中）就不重算、不重新渲染
      if (this.setSource(m, p, myId)) this.render();
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '网络异常，显示的是缓存数据', icon: 'none' });
    }
    if (this.data.loading) this.setData({ loading: false });
  },

  // 换数据源：水平分只在数据变化时算一次（切换筛选 / 排序、翻页都不重算）。
  // 比较的是数组引用（db.*Shared 数据没变时返回同一个数组）。返回是否有变化
  setSource(matches, players, myId) {
    const src = this.srcRef;
    if (src && src.m === matches && src.p === players && src.id === (myId || '')) return false;
    this.srcRef = { m: matches, p: players, id: myId || '' };
    this.all = matches || []; this.players = players || []; this.myId = myId || '';
    // 水平分始终用全部比赛（单打 + 双打）计算
    this.ratings = R.computeRatings(this.all, R.startLevelsFrom(this.players));
    // 赛季（自然年）：胜负、胜率只看这个赛季的比赛；水平分不分赛季
    const seasons = [{ label: '生涯', value: SE.ALL }].concat(SE.seasonsIn(this.all).map((s) => ({ label: s, value: s })));
    if (JSON.stringify(seasons) !== JSON.stringify(this.data.seasons)) this.setData({ seasons });
    return true;
  },

  setFilter(e) { this.limit = PAGE; this.setData({ filter: e.currentTarget.dataset.v }); this.render(); },
  setSort(e) { this.limit = PAGE; this.setData({ sort: e.currentTarget.dataset.v }); this.render(); },
  setGender(e) { this.limit = PAGE; this.setData({ gender: e.currentTarget.dataset.v }); this.render(); },
  setSeason(e) { this.limit = PAGE; this.setData({ season: e.currentTarget.dataset.v }); this.render(); },

  render() {
    // 性别读个人资料：有账号按用户 ID 找，没有账号的按名字；没填（不公开）就不显示
    const gUid = {}, gName = {};
    (this.players || []).forEach((x) => { if (x.uid) gUid[x.uid] = x.gender; if (!(x.name in gName)) gName[x.name] = x.gender; });
    // 趣味榜单（本月活跃 / 连胜 / 本月进步）不分赛季：人从生涯战绩里取，再按榜单数值排
    const sort = this.data.sort, board = sort === 'active' || sort === 'streak' || sort === 'gain';
    let list = computeRank(board ? this.all || [] : SE.inSeason(this.all || [], this.data.season), this.data.filter).map((p) => {
      const r = this.ratings.players[p.key];
      const level = r ? r.level : R.DEFAULT_LEVEL;
      return Object.assign(p, {
        level, levelText: R.fmt(level), provisional: !r || r.provisional,
        uid: String(p.key).indexOf('n:') === 0 ? '' : p.key, initial: initialOf(p.name), color: colorOf(p.name),
        gender: S.GENDER[String(p.key).indexOf('n:') === 0 ? gName[p.name] : gUid[p.key]] || '',
        diffText: (p.diff > 0 ? '+' : '') + p.diff,
      });
    });
    if (sort === 'level') {
      // 定级完成的排前面，再按水平从高到低
      list.splice(0, list.length, ...S.rankOrder(list)); // 和报名列表里的「排名」用同一个排序
    }
    if (board) {
      const d = new Date();
      const month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const val = S.boards(this.all || [], this.ratings, this.data.filter, month)[sort];
      list.forEach((p) => { p.val = val[p.key] || 0; });
      list = list.filter((p) => p.val > 0).sort((x, y) => y.val - x.val || y.level - x.level);
    }
    // 只显示同意公开展示的球员（players.shown，本人授权；没有账号的旧名字没法授权，也不显示）：名次在过滤后重新排
    const prof = db.profilesOf(this.players || []);
    const shown = (uid) => !!uid && !!prof[uid] && prof[uid].shown === true;
    list = list.filter((p) => shown(p.uid));
    const meHidden = !!this.myId && !!prof[this.myId] && !shown(this.myId);
    // 按性别筛选（个人资料里填的）：名次在筛选后的榜单里重新排
    if (this.data.gender !== 'all') list = list.filter((p) => p.gender === this.data.gender);
    list.forEach((p, i) => {
      p.rank = i + 1;
      // 领奖台和榜单第一列显示什么：随排序 / 榜单变化
      if (sort === 'active') { p.mainText = p.val + ' 场'; p.mainLbl = '本月'; }
      else if (sort === 'streak') { p.mainText = p.val + ' 连胜'; p.mainLbl = '当前'; }
      else if (sort === 'gain') { p.mainText = R.fmtDelta(p.val); p.mainLbl = '本月'; }
      else if (sort === 'level') { p.mainText = p.levelText; p.mainLbl = p.provisional ? '定级中' : '水平'; }
      else { p.mainText = p.rate + '%'; p.mainLbl = '胜率'; }
      p.colText = board ? p.mainText : p.levelText;
    });
    const top = list.length >= 3 ? [list[1], list[0], list[2]] : list.slice(0, 3);
    this.list = list;
    // 榜单先显示前 limit 名，滑到底再加载
    const limit = this.limit || PAGE;
    const emptyText = sort === 'active' ? '这个月还没有比赛' : sort === 'streak' ? '现在没有人在连胜' : sort === 'gain' ? '这个月还没有人涨分' : this.data.season === 'all' ? '还没有比赛数据' : '这个赛季还没有比赛';
    this.setData({
      top, ranked: list.slice(0, limit), more: list.length > limit, myKey: this.myId || '', none: !list.length, board, meHidden,
      colLbl: sort === 'active' ? '本月' : sort === 'streak' ? '连胜' : sort === 'gain' ? '涨幅' : '水平',
      emptyText: this.data.gender !== 'all' && !list.length ? '没有符合条件的球员' : emptyText,
    });
  },

  // 本人没开启公开展示：点提示条弹出授权说明，同意后马上出现在榜单里
  async openShown() {
    if (await require('../../utils/consent').ask({ cancelText: '暂不', keepOnCancel: true })) this.load();
  },

  // 点球员 → 球员主页（只展示比赛统计）
  // 排行按统计身份：key 不是 'n:' 开头的就是用户 ID
  tapPlayer(e) {
    const key = e.currentTarget.dataset.key || '';
    const uid = key && key.indexOf(ID.NAME_KEY) !== 0 ? key : '';
    if (uid && uid === this.myId) { wx.switchTab({ url: '/pages/me/me' }); return; }
    if (!uid) { wx.showToast({ title: '这位球员没有绑定账号', icon: 'none' }); return; }
    wx.navigateTo({ url: '/pages/player/player?uid=' + encodeURIComponent(uid) });
  },
});
