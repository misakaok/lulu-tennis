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
    last: s.lastString ? `上次穿线 ${s.lastString.ago} · ${s.lastString.tension}` : '还没有穿线记录',
    alerts: s.reminders.filter((x) => x.state !== 'ok').slice(0, 3).map((x) => ({ k: x.item, t: `${x.label}${x.state === 'none' ? '：还没有记录' : x.state === 'over' ? '：已到期' : '：快到了'}`, cls: x.state === 'over' ? 'bad' : x.state === 'soon' ? 'warn' : '' })),
  };
}

Page({
  data: { loading: true, error: '', cards: [], o: null, clearing: false },

  onLoad() {
    wx.hideShareMenu(); // 私人数据不能分享
    // 先显示：本机存的上次结果（或 60 秒内刚读过的）直接画出来，不再先闪「正在读取…」；onShow 里照常读云端再更正
    const c = API.cachedList();
    if (c) { this.fromCache = true; this.show(c); }
  },
  onShow() {
    this.load();
  },
  onPullDownRefresh() {
    require('../../utils/memo').invalidate();
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    try {
      const { rackets, logs } = await API.load();
      this.fromCache = false;
      this.show({ rackets, logs });
      API.applyBadge(rackets, logs);
    } catch (e) {
      // 已经画了上次的记录：保留着，只轻提示；没有可显示的才整页显示读取失败
      if (this.fromCache) wx.showToast({ title: '网络异常，显示的是上次的记录', icon: 'none' });
      else this.setData({ loading: false, error: e.message || '读取失败' });
    }
  },
  show({ rackets, logs }) {
    const t = today();
    // 在用的排前面，已退役的放最后
    const list = rackets.slice().sort((a, b) => (a.status === 'retired') - (b.status === 'retired') || a.no - b.no);
    // 顶部卡片不做动画（2026-11-25 用户觉得动画太多）：数字直接显示，不滚
    this.setData({ loading: false, error: '', cards: list.map((r) => cardOf(r, logs, t)), o: K.overview(rackets, logs, t) });
  },
  retry() { this.setData({ loading: true, error: '' }); this.load(); },
  add() { wx.navigateTo({ url: '/pages/racket-edit/racket-edit' }); },
  open(e) { wx.navigateTo({ url: '/pages/racket-view/racket-view?id=' + encodeURIComponent(e.currentTarget.dataset.id) }); },

  clearAll() {
    if (this.data.clearing) return;
    wx.showModal({
      title: '清除全部球拍数据？', content: '会永久删除你的全部球拍、穿线和维护记录，无法恢复。',
      confirmText: '清除', confirmColor: '#b34d4d',
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ clearing: true });
        API.clear().then(() => { wx.showToast({ title: '已清除', icon: 'none' }); this.fromCache = false; return this.load(); })
          .catch((e) => wx.showToast({ title: e.message || '清除失败', icon: 'none' }))
          .then(() => this.setData({ clearing: false }));
      },
    });
  },
});
