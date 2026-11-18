// 记录 / 编辑一次穿线或维护（只有本人可见）。球线、维护项目、备注都从固定选项里选；磅数用选择器，费用只能填数字。
//   新记穿线时，默认带上这支拍上一次的球线和磅数。
const API = require('../../utils/rackets');
const K = require('../../utils/racket');

const pad = (n) => (n < 10 ? '0' + n : '' + n);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const SB_NAMES = K.STRING_BRANDS.map((b) => b.n);
const TENSIONS = [];
for (let t = K.TENSION_MIN; t <= K.TENSION_MAX; t++) TENSIONS.push(t);
const T_NAMES = TENSIONS.map((t) => t + ' 磅');
const DEFAULT_T = 52;

// 球线选择 { brand, model } ⇄ 选择器下标
const pickView = (p) => {
  const bi = p ? K.STRING_BRANDS.findIndex((b) => b.k === p.brand) : -1;
  const models = bi >= 0 ? K.modelsOf(K.STRING_BRANDS, p.brand) : [];
  return { bi, models, mi: p ? models.indexOf(p.model) : -1 };
};
const pickOf = (v) => (v.bi >= 0 && v.mi >= 0 ? { brand: K.STRING_BRANDS[v.bi].k, model: v.models[v.mi] } : null);

Page({
  data: {
    id: '', racketId: '', kind: 'string', ready: false, error: '', today: '', title: '',
    date: '', sbNames: SB_NAMES, tNames: T_NAMES, main: pickView(null), hybrid: false, cross: pickView(null),
    ti: TENSIONS.indexOf(DEFAULT_T), ci: TENSIONS.indexOf(DEFAULT_T), cost: '', feel: 0, stars: [1, 2, 3, 4, 5],
    items: Object.keys(K.MAINT_ITEMS).map((k) => ({ k, n: K.MAINT_ITEMS[k] })), mitem: '',
    tagOpts: [], tags: [], maxTags: K.MAX_TAGS, saving: false, removing: false,
  },

  onLoad(o) {
    wx.hideShareMenu();
    const q = o || {};
    const id = decodeURIComponent(q.id || ''), racketId = decodeURIComponent(q.racket || '');
    this.setData({ id, racketId, kind: q.kind === 'maint' ? 'maint' : 'string', today: today(), date: today() });
    API.load().then(({ rackets, logs }) => {
      let rid = racketId, log = null;
      if (id) {
        log = logs.find((l) => l.id === id);
        if (!log) { this.setData({ error: '记录不存在，可能已被删除' }); return; }
        rid = log.racketId;
      }
      const r = rackets.find((x) => x.id === rid);
      if (!r) { this.setData({ error: '球拍不存在，可能已被删除' }); return; }
      const kind = log ? log.kind : this.data.kind;
      wx.setNavigationBarTitle({ title: `${log ? '编辑' : '记录'}${kind === 'string' ? '穿线' : '维护'}` });
      this.setData({ racketId: rid, kind, title: `${K.racketTitle(r)} · ${K.racketName(r)}` });
      // 新记穿线：沿用这支拍上一次的球线和磅数
      const prev = log || (kind === 'string' ? logs.filter((l) => l.racketId === rid && l.kind === 'string').sort((a, b) => b.date.localeCompare(a.date))[0] : null);
      if (prev && prev.kind === 'string') {
        const hybrid = !!prev.cross && (prev.cross.brand !== prev.main.brand || prev.cross.model !== prev.main.model);
        this.setData({
          main: pickView(prev.main), hybrid, cross: pickView(hybrid ? prev.cross : null),
          ti: Math.max(0, TENSIONS.indexOf(prev.mains)), ci: Math.max(0, TENSIONS.indexOf(prev.crosses)),
        });
      }
      if (log) {
        this.setData({ date: log.date, cost: typeof log.cost === 'number' ? String(log.cost) : '', feel: log.feel || 0, tags: log.tags || [], mitem: log.item || '' });
      }
      this.setData({ ready: true });
      this.refreshTags();
    }).catch((e) => this.setData({ error: e.message || '读取失败' }));
  },

  refreshTags() {
    const on = this.data.tags;
    this.setData({ tagOpts: K.STRING_TAGS.map((t) => ({ t, on: on.indexOf(t) >= 0 })) });
  },
  onDate(e) { this.setData({ date: e.detail.value }); },
  onBrand(e) {
    const which = e.currentTarget.dataset.w, b = K.STRING_BRANDS[Number(e.detail.value)];
    const models = K.modelsOf(K.STRING_BRANDS, b.k);
    this.setData({ [which]: { bi: Number(e.detail.value), models, mi: models.length === 1 ? 0 : -1 } });
  },
  onModel(e) { this.setData({ [e.currentTarget.dataset.w + '.mi']: Number(e.detail.value) }); },
  toggleHybrid() { this.setData({ hybrid: !this.data.hybrid }); },
  onMains(e) {
    const ti = Number(e.detail.value);
    // 横线磅数原来和竖线一样时跟着变
    this.setData(this.data.ci === this.data.ti ? { ti, ci: ti } : { ti });
  },
  onCrosses(e) { this.setData({ ci: Number(e.detail.value) }); },
  onCost(e) { this.setData({ cost: e.detail.value }); },
  setFeel(e) { const v = Number(e.currentTarget.dataset.v); this.setData({ feel: this.data.feel === v ? 0 : v }); },
  setItem(e) { this.setData({ mitem: e.currentTarget.dataset.k }); },
  toggleTag(e) {
    const t = e.currentTarget.dataset.t, tags = this.data.tags.slice(), i = tags.indexOf(t);
    if (i >= 0) tags.splice(i, 1);
    else if (tags.length >= K.MAX_TAGS) { wx.showToast({ title: `最多选 ${K.MAX_TAGS} 个`, icon: 'none' }); return; }
    else tags.push(t);
    this.setData({ tags });
    this.refreshTags();
  },

  build() {
    const d = this.data;
    const cost = String(d.cost || '').trim();
    if (cost && !/^\d+(\.\d{1,2})?$/.test(cost)) return { ok: false, msg: '费用只能填数字，最多两位小数' };
    const base = { kind: d.kind, date: d.date, cost: cost ? Number(cost) : null };
    if (d.kind === 'maint') return K.cleanLog(Object.assign(base, { item: d.mitem }), d.today);
    const main = pickOf(d.main);
    if (!main) return { ok: false, msg: '请选择球线' };
    const cross = d.hybrid ? pickOf(d.cross) : null;
    if (d.hybrid && !cross) return { ok: false, msg: '请选择横线的球线' };
    return K.cleanLog(Object.assign(base, { main, cross, mains: TENSIONS[d.ti], crosses: TENSIONS[d.ci], feel: d.feel, tags: d.tags }), d.today);
  },

  async save() {
    if (this.data.saving) return;
    const c = this.build();
    if (!c.ok) { wx.showToast({ title: c.msg, icon: 'none' }); return; }
    this.setData({ saving: true });
    try {
      await API.saveLog(this.data.id, this.data.racketId, c.rec);
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 500);
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
      this.setData({ saving: false });
    }
  },

  remove() {
    if (!this.data.id || this.data.removing) return;
    wx.showModal({
      title: '删除这条记录？', content: '删除后无法恢复，统计和提醒会同步更新。', confirmText: '删除', confirmColor: '#b34d4d',
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ removing: true });
        API.removeLog(this.data.id).then(() => {
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 500);
        }).catch((e) => { wx.showToast({ title: e.message || '删除失败', icon: 'none' }); this.setData({ removing: false }); });
      },
    });
  },
});
