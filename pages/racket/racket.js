// 我的球拍（底部「球拍」tab，只有本人可见）：全部球拍、累计穿线 / 维护次数和小程序内提醒（tab 上的数字）。
//   数据只经云函数按本人 OPENID 读写（utils/rackets.js），没有任何查看别人球拍、分享或交易的入口。
const API = require('../../utils/rackets');
const K = require('../../utils/racket');

const pad = (n) => (n < 10 ? '0' + n : '' + n);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function cardOf(r, logs, t) {
  const s = K.summary(r, logs, t);
  return {
    id: r.id, no: r.no, brand: r.brand, model: r.model, title: K.racketTitle(r), name: K.racketName(r), status: K.STATUS[r.status] || '', retired: r.status === 'retired',
    stringCount: s.stringCount, maintCount: s.maintCount,
    hasString: !!s.lastString,
    last: s.lastString ? `上次穿线 ${s.lastString.ago} · ${s.lastString.tension}` : '点击记录穿线、换手胶或打球时长 ›',
    alerts: s.reminders.filter((x) => x.state === 'over' || x.state === 'soon').slice(0, 3).map((x) => ({ k: x.item, t: `${x.label} · ${x.state === 'over' ? '已到期' : '快到了'}`, cls: x.state === 'over' ? 'bad' : 'warn' })),
  };
}

function statsView(rackets, logs, t) {
  const y = K.yearlyStats(rackets, logs, t);
  const chips = [];
  if (y.yearCost > 0) {
    const parts = [];
    if (y.stringCost > 0) parts.push(`穿线 ¥${y.stringCost}`);
    if (y.maintCost > 0) parts.push(`维护 ¥${y.maintCost}`);
    if (parts.length) chips.push(parts.join(' · '));
  }
  if (y.avgHours) chips.push(`每条线均打 ${y.avgHours}h`);
  if (!y.brokenYear && y.brokenAll > 0) chips.push(`累计断线 ${y.brokenAll} 次`);
  if (y.topString) chips.push(`常用 ${y.topString.name}（${y.topString.count} 次）`);
  return {
    year: y.year,
    costText: y.yearCost > 0 ? `¥${y.yearCost}` : '¥0',
    avgText: y.avgDays !== null ? `${y.avgDays} 天` : '—',
    hoursText: y.yearPlayMin > 0 ? `${y.yearPlayHours}h` : '0h',
    badge: y.brokenYear > 0 ? `今年断线 ${y.brokenYear} 次` : (y.allCost > y.yearCost ? `累计 ¥${y.allCost}` : ''),
    chips,
    hasData: y.hasData,
  };
}

Page({
  data: { loading: true, error: '', cards: [], o: null, st: null, scrolling: false, paused: false },

  onLoad() {
    wx.hideShareMenu(); // 私人数据不能分享
    // 先显示：本机存的上次结果（或 60 秒内刚读过的）直接画出来，不再先闪「正在读取…」；onShow 里照常读云端再更正
    const c = API.cachedList();
    if (c) this.show(c);
  },
  onShow() {
    if (this.data.paused) this.setData({ paused: false });
    this.load();
  },
  onHide() { this.stopDock(true); },
  onUnload() { this.stopDock(true); },
  stopDock(pause) {
    clearTimeout(this.scrollTimer); this.scrollTimer = null;
    const patch = {};
    if (this.data.scrolling) patch.scrolling = false;
    if (pause && !this.data.paused) patch.paused = true;
    if (Object.keys(patch).length) this.setData(patch);
  },
  // 上下滑动时半隐贴右边（只切一次状态，不逐帧 setData）；停滑 420ms 后滑回右下角
  onPageScroll() {
    if (!this.data.cards.length) return;
    if (!this.data.scrolling) this.setData({ scrolling: true });
    clearTimeout(this.scrollTimer);
    this.scrollTimer = setTimeout(() => {
      this.scrollTimer = null;
      if (this.data.scrolling) this.setData({ scrolling: false });
    }, 420);
  },
  onPullDownRefresh() {
    require('../../utils/memo').invalidate();
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    const seq = this.loadSeq = (this.loadSeq || 0) + 1; // onShow 和下拉刷新同时读：只认最后一次
    try {
      const { rackets, logs } = await API.load();
      if (seq !== this.loadSeq) return;
      this.show({ rackets, logs });
      API.applyBadge(rackets, logs);
    } catch (e) {
      if (seq !== this.loadSeq) return;
      // 已经画过（本机上次的记录或之前读到的）：保留着，只轻提示；从来没画出来过才整页显示读取失败
      if (this.drawn) wx.showToast({ title: '网络异常，显示的是上次的记录', icon: 'none' });
      else this.setData({ loading: false, error: e.message || '读取失败' });
    }
  },
  show({ rackets, logs }) {
    const t = today();
    // 在用的排前面，已退役的放最后
    const list = rackets.slice().sort((a, b) => (a.status === 'retired') - (b.status === 'retired') || a.no - b.no);
    this.drawn = true;
    // 顶部卡片不做动画（2026-11-25 用户觉得动画太多）：数字直接显示，不滚
    this.setData({ loading: false, error: '', cards: list.map((r) => cardOf(r, logs, t)), o: K.overview(rackets, logs, t), st: statsView(rackets, logs, t) });
  },
  retry() { this.setData({ loading: true, error: '' }); this.load(); },
  // 点击添加球拍（空态按钮与右下角悬浮 LULU 挂件共用）：直接跳转，不打断颠球循环
  add() {
    clearTimeout(this.scrollTimer); this.scrollTimer = null;
    if (this.data.scrolling) this.setData({ scrolling: false });
    wx.navigateTo({ url: '/pkg-tools/racket-edit/racket-edit' });
  },
  open(e) { wx.navigateTo({ url: '/pkg-tools/racket-view/racket-view?id=' + encodeURIComponent(e.currentTarget.dataset.id) }); },
  openTune() { wx.navigateTo({ url: '/pkg-tools/racket-tune/racket-tune' }); },
});
