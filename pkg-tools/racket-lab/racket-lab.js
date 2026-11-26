// 个人装备实验室：实战交叉分析（球拍/球线 × 战绩）+ 双拍参数配重对比 + 气温/拍面磅数参考器
const db = require('../../utils/db');
const racketsAPI = require('../../utils/rackets');
const K = require('../../utils/racket');
const haptic = require('../../utils/haptic');
const Lab = require('../utils/racket-lab');

const TABS = [
  { value: 'cross', label: '实战分析' },
  { value: 'compare', label: '双拍对比' },
  { value: 'tension', label: '磅数参考' },
];
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

Page({
  data: {
    tabs: TABS,
    tab: 'cross',
    tabIdx: 0,
    ready: false,
    cross: null,
    // 双拍对比
    presets: Lab.COMPARE_PRESETS,
    myOptions: [],
    sideA: { name: 'Blade 98', brand: 'wilson', model: 'Blade', weight: '305', balance: '320', sw: '324', head: 98, pattern: '16×19', top: 0, side: 0, handle: 0 },
    sideB: { name: 'EZONE 100', brand: 'yonex', model: 'EZONE', weight: '300', balance: '320', sw: '319', head: 100, pattern: '16×19', top: 0, side: 0, handle: 0 },
    headOpts: Lab.HEAD_OPTS,
    patternOpts: Lab.PATTERN_OPTS,
    cmp: null,
    // 磅数参考
    tempOpts: Lab.TEMP_OPTS,
    matOpts: Lab.MAT_OPTS,
    styleOpts: Lab.STYLE_OPTS,
    armOpts: Lab.ARM_OPTS,
    ten: { temp: 'mild', material: 'poly', head: 100, style: 'balance', arm: 'normal' },
    tenRes: null,
  },

  onLoad(options) {
    wx.hideShareMenu({ fail() {} });
    const t = (options && options.tab) || 'cross';
    const idx = Math.max(0, TABS.findIndex((x) => x.value === t));
    this.setData({ tab: TABS[idx].value, tabIdx: idx });
    this.recalcCompare();
    this.recalcTension();

    const c = racketsAPI.cachedList ? racketsAPI.cachedList() : null;
    const myId = (db.cachedOpenid && db.cachedOpenid()) || '';
    if (c) this.applyData(c.rackets, c.logs, db.cachedMatches() || [], myId, false);
    this.load();
  },

  async load() {
    const seq = this.seq = (this.seq || 0) + 1;
    try {
      const [rk, matches, myId] = await Promise.all([
        racketsAPI.load().catch(() => racketsAPI.cachedList()),
        db.matchesShared().catch(() => db.cachedMatches() || []),
        db.myOpenid ? db.myOpenid().catch(() => (db.cachedOpenid && db.cachedOpenid()) || '') : Promise.resolve(''),
      ]);
      if (seq !== this.seq) return;
      this.applyData((rk && rk.rackets) || [], (rk && rk.logs) || [], matches || [], myId || '', true);
    } catch (e) {
      if (seq !== this.seq) return;
      this.setData({ ready: true });
    }
  },

  applyData(rackets, logs, matches, myId, ready) {
    const today = todayStr();
    const cross = Lab.crossAnalyze(rackets, logs, matches, myId, today);
    const myOptions = (rackets || []).slice()
      .sort((a, b) => (a.status === 'retired') - (b.status === 'retired') || (a.no || 0) - (b.no || 0))
      .map((r) => {
        const sp = Lab.specOfRacket(r);
        const s = K.summary(r, logs || [], today);
        return {
          id: r.id,
          label: `${K.racketTitle(r)} ${K.racketName(r)}`,
          name: `${K.racketTitle(r)} ${K.racketName(r)}`,
          brand: r.brand || 'other',
          model: r.model || '',
          weight: String(sp.weight),
          balance: String(sp.balance),
          sw: String(sp.sw),
          head: sp.head,
          pattern: sp.pattern,
          stringInfo: s.lastString ? `${s.lastString.tension}` : '',
        };
      });

    const patch = { cross, myOptions };
    if (ready) patch.ready = true;
    // 首次载入时若有个人球拍，自动带入前两支作为对比默认项
    if (!this.initedPairs && myOptions.length) {
      this.initedPairs = true;
      patch.sideA = Object.assign({ top: 0, side: 0, handle: 0 }, myOptions[0]);
      if (myOptions.length >= 2) patch.sideB = Object.assign({ top: 0, side: 0, handle: 0 }, myOptions[1]);
    }
    this.setData(patch, () => this.recalcCompare());
  },

  setTab(e) {
    const v = e.currentTarget.dataset.v;
    const idx = TABS.findIndex((x) => x.value === v);
    if (idx < 0 || v === this.data.tab) return;
    haptic.light();
    this.setData({ tab: v, tabIdx: idx });
  },

  recalcCompare() {
    this.setData({ cmp: Lab.compareRackets(this.data.sideA, this.data.sideB) });
  },

  pickMyRacket(e) {
    const side = e.currentTarget.dataset.side === 'b' ? 'sideB' : 'sideA';
    const item = this.data.myOptions[Number(e.detail.value)];
    if (!item) return;
    haptic.light();
    this.setData({ [side]: Object.assign({ top: 0, side: 0, handle: 0 }, item) }, () => this.recalcCompare());
  },

  pickPreset(e) {
    const side = e.currentTarget.dataset.side === 'b' ? 'sideB' : 'sideA';
    const p = this.data.presets[Number(e.detail.value)];
    if (!p) return;
    haptic.light();
    this.setData({
      [side]: {
        name: p.label, brand: p.brand, model: p.model,
        weight: String(p.weight), balance: String(p.balance), sw: String(p.sw),
        head: p.head, pattern: p.pattern, top: 0, side: 0, handle: 0, stringInfo: '',
      },
    }, () => this.recalcCompare());
  },

  onSideNum(e) {
    const { side, k } = e.currentTarget.dataset;
    const key = side === 'b' ? 'sideB' : 'sideA';
    if (k !== 'weight' && k !== 'balance' && k !== 'sw') return;
    const v = String(e.detail.value || '').replace(/[^\d.]/g, '').slice(0, 5);
    this.setData({ [`${key}.${k}`]: v }, () => this.recalcCompare());
  },

  stepSideLead(e) {
    const { side, k, d } = e.currentTarget.dataset;
    const key = side === 'b' ? 'sideB' : 'sideA';
    if (k !== 'top' && k !== 'side' && k !== 'handle') return;
    const cur = Number(this.data[key][k]) || 0;
    const next = Math.max(0, Math.min(20, Math.round((cur + Number(d)) * 10) / 10));
    haptic.light();
    this.setData({ [`${key}.${k}`]: next }, () => this.recalcCompare());
  },

  pickSideHead(e) {
    const side = e.currentTarget.dataset.side === 'b' ? 'sideB' : 'sideA';
    const v = this.data.headOpts[Number(e.detail.value)];
    if (!v) return;
    this.setData({ [`${side}.head`]: v }, () => this.recalcCompare());
  },

  pickSidePattern(e) {
    const side = e.currentTarget.dataset.side === 'b' ? 'sideB' : 'sideA';
    const v = this.data.patternOpts[Number(e.detail.value)];
    if (!v) return;
    this.setData({ [`${side}.pattern`]: v }, () => this.recalcCompare());
  },

  recalcTension() {
    this.setData({ tenRes: Lab.recommendTension(this.data.ten) });
  },

  pickTen(e) {
    const { k, v } = e.currentTarget.dataset;
    if (!k) return;
    const val = k === 'head' ? Number(v) : v;
    if (this.data.ten[k] === val) return;
    haptic.light();
    this.setData({ [`ten.${k}`]: val }, () => this.recalcTension());
  },

  openTune() { wx.navigateTo({ url: '/pkg-tools/racket-tune/racket-tune' }); },
  openRacket(e) {
    const id = e.currentTarget.dataset.id;
    if (id) wx.navigateTo({ url: '/pkg-tools/racket-view/racket-view?id=' + encodeURIComponent(id) });
  },
});
