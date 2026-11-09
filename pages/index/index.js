const db = require('../../utils/db');
const R = require('../../utils/rating');
const { colorOf, initialOf } = require('../../utils/rules');

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
  const deltaText = (k) => {
    const v = (m[k] || []).length ? d[m[k][0]] : undefined; // 同队两人涨跌相同
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
    aUp: (d[(m.a || [])[0]] || 0) > 0, bUp: (d[(m.b || [])[0]] || 0) > 0,
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
    types: [{ label: '全部', value: 'all' }, { label: '单打', value: 'single' }, { label: '双打', value: 'double' }],
  },

  onLoad() {
    this.all = db.cachedMatchesAll();
    this.players = db.cachedPlayersFull();
    this.render();
  },
  onShow() { this.load(); },
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },

  async load() {
    try {
      const [m, p] = await Promise.all([db.fetchMatchesAll(), db.fetchPlayersFull()]);
      this.all = m; this.players = p;
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '网络异常，显示的是缓存数据', icon: 'none' });
    }
    this.setData({ loading: false });
    this.render();
  },

  // 列表显示正式战绩 + 待对手确认的日常比赛；统计和水平分涨跌只算正式战绩
  render() {
    const shown = this.all || [];
    const all = shown.filter((m) => m.status !== 'pending');
    const month = ymd(new Date()).slice(0, 7);
    const names = {};
    all.forEach((m) => (m.a || []).concat(m.b || []).forEach((n) => { names[n] = 1; }));

    const who = this.data.who.trim();
    const list = shown.filter((m) =>
      (this.data.filter === 'all' || m.type === this.data.filter) &&
      (!who || (m.a || []).concat(m.b || []).some((n) => n.indexOf(who) >= 0)));

    const players = this.players || [];
    const avatarOf = {};
    players.forEach((p) => { if (p.avatar) avatarOf[p.name] = p.avatar; });
    const { deltas } = R.computeRatings(all, R.startLevelsFrom(players));
    const groups = [];
    list.forEach((m) => {
      let g = groups[groups.length - 1];
      if (!g || g.date !== m.date) { g = { date: m.date, label: dateLabel(m.date), items: [] }; groups.push(g); }
      g.items.push(toView(m, avatarOf, deltas));
    });

    this.setData({
      groups,
      stat: { total: all.length, month: all.filter((m) => (m.date || '').indexOf(month) === 0).length, players: Object.keys(names).length },
    });
  },

  setFilter(e) { this.setData({ filter: e.currentTarget.dataset.v }); this.render(); },
  onSearch(e) { this.setData({ who: e.detail.value }); this.render(); },
  goAdd() { wx.navigateTo({ url: '/pages/add/add' }); }, // 记录日常比赛（次要入口；赛事比赛在签表里录）
  // 点击比赛：详情页里可以确认赛果、评价对手；赛事比赛可以从详情页进入赛事
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
              const ok = await db.removeMatch(id);
              if (ok) { wx.showToast({ title: '已删除' }); this.load(); }
              else wx.showToast({ title: '只能删除自己录入的记录', icon: 'none' });
            } catch (err) {
              console.error(err);
              wx.showToast({ title: '删除失败', icon: 'none' });
            }
          },
        });
      },
    });
  },
});
