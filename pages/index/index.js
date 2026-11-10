const db = require('../../utils/db');
const R = require('../../utils/rating');
const { colorOf, initialOf } = require('../../utils/rules');

const PAGE = 40;        // 列表每次显示多少场，滑到底再加载
const SEARCH_MS = 300;  // 搜索防抖
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function dateLabel(str) {
  const now = new Date();
  const yest = new Date(now.getTime() - 86400000);
  if (str === ymd(now)) return '今天';
  if (str === ymd(yest)) return '昨天';
  const [y, m, d] = str.split('-').map(Number);
  const w = WEEK[new Date(y, m - 1, d).getDay()];
  return (y === now.getFullYear() ? '' : `${y}年`) + `${m}月${d}日 ${w}`;
}

function toView(m, avatarOf, deltas) {
  const d = deltas[m._id] || {};
  const side = (k) => (m[k] || []).map((n) => ({ name: n, initial: initialOf(n), color: colorOf(n), avatar: avatarOf[n] || '' }));
  const first = (k) => ((m[k + 'Keys'] || m[k] || [])[0]); // 同队两人涨跌相同，取第一位的统计身份
  const deltaText = (k) => {
    const v = (m[k] || []).length ? d[first(k)] : undefined;
    return v === undefined ? '' : R.fmtDelta(v);
  };
  return {
    _id: m._id,
    drawId: m.drawId || '',
    pending: m.status === 'pending',
    eventText: m.drawId && m.drawTitle ? `🏆 ${m.drawTitle}${m.stage ? ' · ' + m.stage : ''}` : '',
    typeText: m.type === 'double' ? '双打' : '单打',
    formatText: (m.bestOf === 1 ? '一盘' : '三盘两胜') + ` · ${m.setGames || 4}局制`
      + (m.noAd === false ? ' · 占先' : ' · 金球'),
    winner: m.winner,
    a: side('a'),
    b: side('b'),
    aDelta: deltaText('a'), bDelta: deltaText('b'),
    aUp: (d[first('a')] || 0) > 0, bUp: (d[first('b')] || 0) > 0,
    aText: (m.a || []).join(' / '),
    bText: (m.b || []).join(' / '),
    sets: (m.sets || []).map((s) => ({
      a: s.a, b: s.b, aw: s.a > s.b, bw: s.b > s.a,
      tbA: s.tbA === undefined ? '' : s.tbA, tbB: s.tbB === undefined ? '' : s.tbB,
    })),
  };
}

Page({
  data: {
    loading: true,
    groups: [],
    stat: { total: 0, month: 0, players: 0 },
    filter: 'all',
    who: '',
    more: false,
    types: [{ label: '全部', value: 'all' }, { label: '单打', value: 'single' }, { label: '双打', value: 'double' }],
  },

  onLoad() {
    this.limit = PAGE;
    this.setSource(db.cachedMatchesAll(), db.cachedPlayersFull());
    this.render();
  },
  onReachBottom() {
    if (!this.data.more) return;
    this.limit += PAGE;
    this.render();
  },
  onShow() { this.load(); },
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    this.load().then(() => wx.stopPullDownRefresh()); },

  async load() {
    try {
      const [m, p] = await Promise.all([db.fetchMatchesAll(), db.fetchPlayersFull()]);
      // 数据和上次一样（比如从详情页返回、缓存命中）就不重算、不重新渲染
      if (this.setSource(m, p)) this.render();
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '网络异常，显示的是缓存数据', icon: 'none' });
    }
    if (this.data.loading) this.setData({ loading: false });
  },

  // 换数据源：水平分涨跌、头像、顶部统计只在数据变化时算一次（搜索、筛选、翻页都不重算）
  // 返回是否有变化
  setSource(matches, players) {
    const sig = JSON.stringify([matches || [], players || []]);
    if (sig === this.sig) return false;
    this.sig = sig;
    const shown = matches || [];
    const all = shown.filter((m) => m.status !== 'pending'); // 统计和水平分涨跌只算正式战绩
    const month = ymd(new Date()).slice(0, 7);
    const names = {};
    all.forEach((m) => (m.a || []).concat(m.b || []).forEach((n) => { names[n] = 1; }));
    const avatarOf = {};
    (players || []).forEach((p) => { if (p.avatar) avatarOf[p.name] = p.avatar; });
    this.src = {
      shown, avatarOf,
      deltas: R.computeRatings(all, R.startLevelsFrom(players || [])).deltas,
      stat: { total: all.length, month: all.filter((m) => (m.date || '').indexOf(month) === 0).length, players: Object.keys(names).length },
    };
    return true;
  },

  // 列表显示正式战绩 + 待对手确认的日常比赛；按筛选条件过滤后只渲染前 limit 场
  render() {
    const { shown, avatarOf, deltas, stat } = this.src || { shown: [], avatarOf: {}, deltas: {}, stat: this.data.stat };
    const who = (this.who !== undefined ? this.who : this.data.who).trim();
    const filter = this.data.filter;
    const list = shown.filter((m) =>
      (filter === 'all' || m.type === filter) &&
      (!who || (m.a || []).concat(m.b || []).some((n) => n.indexOf(who) >= 0)));
    const groups = [];
    list.slice(0, this.limit || PAGE).forEach((m) => {
      let g = groups[groups.length - 1];
      if (!g || g.date !== m.date) { g = { date: m.date, label: dateLabel(m.date), items: [] }; groups.push(g); }
      g.items.push(toView(m, avatarOf, deltas));
    });
    this.setData({ groups, stat, more: list.length > (this.limit || PAGE) });
  },

  setFilter(e) { this.limit = PAGE; this.setData({ filter: e.currentTarget.dataset.v }); this.render(); },
  // 输入时只记下关键词，停顿 300ms 再过滤（不在每个字上重新渲染整个列表）
  onSearch(e) {
    this.who = e.detail.value;
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => { this.limit = PAGE; this.setData({ who: this.who }); this.render(); }, SEARCH_MS);
  },
  onUnload() { clearTimeout(this.searchTimer); },
  goAdd() { wx.navigateTo({ url: '/pages/add/add' }); }, // 记录日常比赛（次要入口；活动比赛在签表里录）
  // 点击比赛：详情页里可以确认赛果、评价对手；活动比赛可以从详情页进入活动
  openMatch(e) { wx.navigateTo({ url: '/pages/match/match?id=' + e.currentTarget.dataset.id }); },

  onLong(e) {
    const id = e.currentTarget.dataset.id;
    wx.showActionSheet({
      itemList: ['删除这条记录'],
      itemColor: '#e5484d',
      success: () => {
        wx.showModal({
          title: '确定删除？',
          content: '删除后所有人都看不到这条记录了',
          confirmColor: '#e5484d',
          success: async (r) => {
            if (!r.confirm) return;
            try {
              const res = await db.removeMatch(id);
              // 需要填原因 / 确认对后续场次的影响：到比赛详情里撤销
              if (res.needReason) { wx.navigateTo({ url: '/pages/match/match?id=' + id }); return; }
              wx.showToast({ title: '已删除' });
              this.load(); // 删除会作废缓存（utils/cloud.js），这里拿到的是新数据
            } catch (err) {
              console.error(err);
              wx.showModal({ title: '删除失败', content: err.message || '请稍后再试', showCancel: false });
            }
          },
        });
      },
    });
  },
});
