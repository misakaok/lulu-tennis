// 一支球拍（只有本人可见）：基本信息、统计、提醒和穿线 / 维护时间线
const API = require('../../utils/rackets');
const K = require('../../utils/racket');

const pad = (n) => (n < 10 ? '0' + n : '' + n);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const money = (n) => (typeof n === 'number' ? '¥' + (Math.round(n * 100) / 100) : '');

function rowOf(l) {
  if (l.kind === 'maint') return { id: l.id, date: l.date, kind: 'maint', title: K.MAINT_ITEMS[l.item] || '维护', sub: '', cost: money(l.cost), tags: [] };
  return {
    id: l.id, date: l.date, kind: 'string', title: K.stringText(l), sub: K.tensionText(l), cost: money(l.cost),
    feel: l.feel ? '★★★★★'.slice(0, l.feel) + '☆☆☆☆☆'.slice(0, 5 - l.feel) : '', tags: l.tags || [],
  };
}

Page({
  data: { id: '', loading: true, error: '', r: null, s: null, rows: [], filter: 'all', shown: [] },

  onLoad(o) {
    wx.hideShareMenu();
    this.setData({ id: decodeURIComponent((o && o.id) || '') });
  },
  onShow() { this.load(); }, // 编辑、记录后回来刷新
  onPullDownRefresh() {
    require('../../utils/memo').invalidate();
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    try {
      const { rackets, logs } = await API.load();
      const r = rackets.find((x) => x.id === this.data.id);
      if (!r) { this.setData({ loading: false, error: '球拍不存在，可能已被删除' }); return; }
      const s = K.summary(r, logs, today());
      wx.setNavigationBarTitle({ title: K.racketTitle(r) });
      this.rows = s.timeline.map(rowOf);
      this.setData({
        loading: false, error: '',
        r: { no: r.no, brand: r.brand, model: r.model, title: K.racketTitle(r), name: K.racketName(r), status: K.STATUS[r.status], retired: r.status === 'retired', bought: r.bought, tags: r.tags || [] },
        s: { stringCount: s.stringCount, maintCount: s.maintCount, last: s.lastString, cost: s.cost ? money(s.cost) : '', reminders: s.reminders, hasRemind: Object.keys(r.remind || {}).length > 0 },
      });
      this.apply();
    } catch (e) {
      this.setData({ loading: false, error: e.message || '读取失败' });
    }
  },
  setFilter(e) { this.setData({ filter: e.currentTarget.dataset.v }); this.apply(); },
  apply() {
    const f = this.data.filter;
    this.setData({ shown: (this.rows || []).filter((x) => f === 'all' || x.kind === f) });
  },
  retry() { this.setData({ loading: true, error: '' }); this.load(); },

  addString() { wx.navigateTo({ url: `/pages/racket-log/racket-log?racket=${encodeURIComponent(this.data.id)}&kind=string` }); },
  addMaint() { wx.navigateTo({ url: `/pages/racket-log/racket-log?racket=${encodeURIComponent(this.data.id)}&kind=maint` }); },
  edit() { wx.navigateTo({ url: '/pages/racket-edit/racket-edit?id=' + encodeURIComponent(this.data.id) }); },
  openLog(e) { wx.navigateTo({ url: '/pages/racket-log/racket-log?id=' + encodeURIComponent(e.currentTarget.dataset.id) }); },
});
