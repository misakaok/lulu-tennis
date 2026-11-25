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

// 使用记录（打球时长）的快捷时长
const QUICK = [30, 60, 90, 120, 150, 180].map((m) => ({ m: String(m), t: m < 60 ? `${m} 分钟` : `${m / 60} 小时` }));
const tagCls = (st) => (st === 'over' ? 'bad' : st === 'soon' ? 'warn' : st === 'ok' ? 'lime' : '');

function playView(r, s) {
  const p = s.play;
  return {
    hours: p.hours, target: p.target, pct: p.pct, state: p.state, text: p.text, cls: tagCls(p.state), sessions: p.sessions,
    since: p.since ? `${p.since} 穿线以后` : '还没有穿线记录，算全部使用记录',
    rows: s.plays.map((l) => ({ id: l.id, date: l.date, text: K.minutesText(l.minutes), cur: !p.since || l.date >= p.since })),
  };
}

Page({
  data: {
    id: '', loading: true, error: '', r: null, s: null, rows: [], filter: 'all', shown: [],
    p: null, showOld: false, pe: null, quick: QUICK, today: '', playBusy: false, // pe：正在新增 / 修改的使用记录
  },

  onLoad(o) {
    wx.hideShareMenu();
    this.setData({ id: decodeURIComponent((o && o.id) || ''), today: today() });
    // 先显示：本机记着的球拍列表（或 60 秒内刚读过的）里有这支拍就直接画出来，不再先闪「正在读取…」；onShow 照常读云端再更正。
    // 只是显示，记录、修改、删除照旧由云端核对
    const c = API.cachedList();
    if (c && c.rackets.some((x) => x.id === this.data.id)) this.show(c);
  },
  onShow() { this.load(); }, // 编辑、记录后回来刷新
  onPullDownRefresh() {
    require('../../utils/memo').invalidate();
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    const seq = this.loadSeq = (this.loadSeq || 0) + 1; // onShow 和下拉刷新同时读：只认最后一次，旧结果不盖新结果
    try {
      const d = await API.load();
      if (seq !== this.loadSeq) return;
      this.show(d);
    } catch (e) {
      if (seq !== this.loadSeq) return;
      // 已经画过（本机上次的记录或之前读到的）：保留着，只轻提示；从来没画出来过才整页显示读取失败
      if (this.drawn) wx.showToast({ title: '网络异常，显示的是上次的记录', icon: 'none' });
      else this.setData({ loading: false, error: e.message || '读取失败' });
    }
  },
  show({ rackets, logs }) {
    const r = rackets.find((x) => x.id === this.data.id);
    if (!r) { this.drawn = false; this.setData({ loading: false, error: '球拍不存在，可能已被删除' }); return; }
    this.drawn = true; // 画过有效内容：之后刷新失败不冲成整页报错
    const s = K.summary(r, logs, today());
    wx.setNavigationBarTitle({ title: K.racketTitle(r) });
    this.rows = s.timeline.map(rowOf);
    const reminders = s.reminders.map((x) => Object.assign({}, x, {
      detail: [x.due ? '下次 ' + x.due : '', x.hours ? `已打 ${x.played} / ${x.hours} 小时` : ''].filter(Boolean).join(' · '),
    }));
    this.setData({
      loading: false, error: '',
      r: { no: r.no, brand: r.brand, model: r.model, title: K.racketTitle(r), name: K.racketName(r), status: K.STATUS[r.status], retired: r.status === 'retired', bought: r.bought, tags: r.tags || [] },
      s: { stringCount: s.stringCount, maintCount: s.maintCount, last: s.lastString, cost: s.cost ? money(s.cost) : '', reminders, hasRemind: Object.keys(r.remind || {}).length > 0 },
      p: playView(r, s),
    });
    this.apply();
  },
  setFilter(e) { this.setData({ filter: e.currentTarget.dataset.v }); this.apply(); },
  apply() {
    const f = this.data.filter;
    this.setData({ shown: (this.rows || []).filter((x) => f === 'all' || x.kind === f) });
  },
  retry() { this.setData({ loading: true, error: '' }); this.load(); },

  addString() { wx.navigateTo({ url: `/pkg-tools/racket-log/racket-log?racket=${encodeURIComponent(this.data.id)}&kind=string` }); },
  addMaint() { wx.navigateTo({ url: `/pkg-tools/racket-log/racket-log?racket=${encodeURIComponent(this.data.id)}&kind=maint` }); },
  edit() { wx.navigateTo({ url: '/pkg-tools/racket-edit/racket-edit?id=' + encodeURIComponent(this.data.id) }); },
  openLog(e) { wx.navigateTo({ url: '/pkg-tools/racket-log/racket-log?id=' + encodeURIComponent(e.currentTarget.dataset.id) }); },

  /* ---------- 使用记录（打球时长）：在这一页的弹层里新增、修改、删除 ---------- */
  toggleOld() { this.setData({ showOld: !this.data.showOld }); },
  playAdd() { this.setData({ pe: { id: '', date: today(), minutes: '' }, today: today() }); },
  playOpen(e) {
    const id = e.currentTarget.dataset.id;
    API.load().then(({ logs }) => {
      const l = logs.find((x) => x.id === id && x.kind === 'play');
      if (!l) { wx.showToast({ title: '记录不存在，可能已被删除', icon: 'none' }); this.load(); return; }
      this.setData({ pe: { id: l.id, date: l.date, minutes: String(l.minutes) }, today: today() });
    }).catch((err) => wx.showToast({ title: err.message || '读取失败', icon: 'none' }));
  },
  playCancel() { if (!this.data.playBusy) this.setData({ pe: null }); },
  playDate(e) { this.setData({ 'pe.date': e.detail.value }); },
  playMinutes(e) { this.setData({ 'pe.minutes': String(e.detail.value || '').replace(/\D/g, '').slice(0, 3) }); },
  playQuick(e) { this.setData({ 'pe.minutes': e.currentTarget.dataset.m }); },
  async playSave() {
    const pe = this.data.pe;
    if (!pe || this.data.playBusy) return;
    if (!/^\d+$/.test(pe.minutes)) { wx.showToast({ title: '请填打球分钟数', icon: 'none' }); return; }
    const c = K.cleanLog({ kind: 'play', date: pe.date, minutes: Number(pe.minutes) }, today());
    if (!c.ok) { wx.showToast({ title: c.msg, icon: 'none' }); return; }
    this.setData({ playBusy: true });
    try {
      await API.saveLog(pe.id, this.data.id, c.rec);
      this.setData({ pe: null, playBusy: false });
      wx.showToast({ title: '已保存', icon: 'success' });
      this.load();
    } catch (err) {
      this.setData({ playBusy: false });
      wx.showToast({ title: err.message || '保存失败', icon: 'none' });
    }
  },
  playRemove() {
    const pe = this.data.pe;
    if (!pe || !pe.id || this.data.playBusy) return;
    wx.showModal({
      title: '删除这条打球记录？', content: '删除后无法恢复，已打时长和提醒会同步更新。', confirmText: '删除', confirmColor: '#b34d4d',
      success: (m) => {
        if (!m.confirm) return;
        this.setData({ playBusy: true });
        API.removeLog(pe.id).then(() => {
          this.setData({ pe: null, playBusy: false });
          wx.showToast({ title: '已删除', icon: 'success' });
          this.load();
        }).catch((err) => { this.setData({ playBusy: false }); wx.showToast({ title: err.message || '删除失败', icon: 'none' }); });
      },
    });
  },
});
