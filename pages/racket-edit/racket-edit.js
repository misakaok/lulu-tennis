// 添加 / 编辑球拍（只有本人可见）：品牌、型号、购入日期、状态、备注和提醒间隔全部从固定选项里选，没有文字输入。
// 球拍没有昵称，按添加顺序由云端自动编号（「N 号拍」）。删除球拍会连同它的穿线 / 维护记录一起删除。
// 顶部是按品牌 / 系列配色的球拍示意图（组件 rk-art），选完品牌、型号马上变；没有照片上传。
const API = require('../../utils/rackets');
const K = require('../../utils/racket');

const pad = (n) => (n < 10 ? '0' + n : '' + n);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const BRAND_NAMES = K.RACKET_BRANDS.map((b) => b.n);
const BRAND_KEYS = K.RACKET_BRANDS.map((b) => b.k);
const DAY_NAMES = K.REMIND_DAYS.map(K.everyText);
const HOUR_NAMES = K.REMIND_HOURS.map(K.hoursEveryText);

Page({
  data: {
    id: '', title: '', ready: false, error: '', today: '',
    brandNames: BRAND_NAMES, brandKeys: BRAND_KEYS, bi: -1, models: [], mi: -1, pickName: '',
    bought: '', status: 'active', STATUS: K.STATUS, tagOpts: [], tags: [], maxTags: K.MAX_TAGS,
    dayNames: DAY_NAMES, reminds: [], hourNames: HOUR_NAMES, hi: 0, saving: false, removing: false,
  },

  onLoad(o) {
    wx.hideShareMenu();
    const id = decodeURIComponent((o && o.id) || '');
    this.setData({ id, today: today() });
    if (!id) { this.fill({ brand: '', model: '', bought: '', status: 'active', tags: [], remind: { string: 90, overgrip: 21 }, hours: 0 }); return; } // 按打球时长换线默认关闭
    wx.setNavigationBarTitle({ title: '编辑球拍' });
    const open = ({ rackets }) => {
      const r = rackets.find((x) => x.id === id);
      if (!r) { this.setData({ error: '球拍不存在，可能已被删除' }); return; }
      this.setData({ title: K.racketTitle(r) });
      this.fill(r);
    };
    // 从球拍详情点进来：60 秒内存里刚读过的（API.peekList，不读本机存的旧结果）有这支拍就直接填好，不等云端
    const pre = API.peekList ? API.peekList() : null;
    if (pre && pre.rackets.some((x) => x.id === id)) { open(pre); return; }
    API.load().then(open).catch((e) => this.setData({ error: e.message || '读取失败' }));
  },

  fill(r) {
    const bi = K.RACKET_BRANDS.findIndex((b) => b.k === r.brand);
    const models = bi >= 0 ? K.modelsOf(K.RACKET_BRANDS, r.brand) : [];
    this.remind = Object.assign({}, r.remind || {});
    const mi = models.indexOf(r.model);
    const hi = Math.max(0, K.REMIND_HOURS.indexOf(r.hours || 0)); // 以前的球拍没有 hours：关闭
    this.setData({ hi, bi, models, mi, pickName: this.nameOf(bi, models, mi), bought: r.bought || '', status: r.status || 'active', tags: r.tags || [], ready: true });
    this.refresh();
  },
  refresh() {
    const on = this.data.tags;
    this.setData({
      tagOpts: K.RACKET_TAGS.map((t) => ({ t, on: on.indexOf(t) >= 0 })),
      reminds: Object.keys(K.REMIND_ITEMS).map((k) => {
        const i = Math.max(0, K.REMIND_DAYS.indexOf(this.remind[k] || 0));
        return { k, label: K.REMIND_ITEMS[k], i, text: DAY_NAMES[i], on: i > 0 };
      }),
    });
  },

  onBrand(e) {
    const bi = Number(e.detail.value), b = K.RACKET_BRANDS[bi];
    const models = K.modelsOf(K.RACKET_BRANDS, b.k);
    const mi = models.length === 1 ? 0 : -1; // 「其他品牌」只有「其他」一项，直接选上
    this.setData({ bi, models, mi, pickName: this.nameOf(bi, models, mi) });
  },
  onModel(e) { const mi = Number(e.detail.value); this.setData({ mi, pickName: this.nameOf(this.data.bi, this.data.models, mi) }); },
  nameOf(bi, models, mi) { return bi >= 0 && mi >= 0 ? K.racketName({ brand: BRAND_KEYS[bi], model: models[mi] }) : ''; },
  onBought(e) { this.setData({ bought: e.detail.value }); },
  clearBought() { this.setData({ bought: '' }); },
  setStatus(e) { this.setData({ status: e.currentTarget.dataset.v }); },
  toggleTag(e) {
    const t = e.currentTarget.dataset.t, tags = this.data.tags.slice(), i = tags.indexOf(t);
    if (i >= 0) tags.splice(i, 1);
    else if (tags.length >= K.MAX_TAGS) { wx.showToast({ title: `最多选 ${K.MAX_TAGS} 个`, icon: 'none' }); return; }
    else tags.push(t);
    this.setData({ tags });
    this.refresh();
  },
  onRemind(e) {
    this.remind[e.currentTarget.dataset.k] = K.REMIND_DAYS[Number(e.detail.value)];
    this.refresh();
  },
  onHours(e) { this.setData({ hi: Number(e.detail.value) }); },

  async save() {
    if (this.data.saving) return;
    const d = this.data, b = K.RACKET_BRANDS[d.bi];
    const remind = {};
    Object.keys(this.remind).forEach((k) => { if (this.remind[k]) remind[k] = this.remind[k]; });
    const c = K.cleanRacket({ brand: b && b.k, model: d.models[d.mi], bought: d.bought, status: d.status, tags: d.tags, remind, hours: K.REMIND_HOURS[d.hi] || 0 }, d.today);
    if (!c.ok) { wx.showToast({ title: c.msg, icon: 'none' }); return; }
    this.setData({ saving: true });
    try {
      const id = await API.saveRacket(d.id, c.rec);
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => {
        if (d.id) wx.navigateBack();
        else wx.redirectTo({ url: '/pages/racket-view/racket-view?id=' + encodeURIComponent(id) });
      }, 500);
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
      this.setData({ saving: false });
    }
  },

  remove() {
    if (!this.data.id || this.data.removing) return;
    wx.showModal({
      title: '删除这支球拍？', content: '它的穿线和维护记录也会一起删除，无法恢复。如果只是不用了，可以把状态改成「已退役」。',
      confirmText: '删除', confirmColor: '#b34d4d',
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ removing: true });
        API.removeRacket(this.data.id).then(() => {
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack({ delta: 2 }), 500); // 回到球拍列表（跳过已删除球拍的详情页）
        }).catch((e) => { wx.showToast({ title: e.message || '删除失败', icon: 'none' }); this.setData({ removing: false }); });
      },
    });
  },
});
