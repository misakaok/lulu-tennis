// AA 算账：纯本地费用均摊计算器（场地费 + 用球费 + 其他，支持全勤与半场 0.5 份），一键复制群账单；不接支付、不存云端
const AA = require('../../utils/aa');
const PV = require('../../utils/privacy');
const haptic = require('../../utils/haptic');

const BALL_CANS = [0, 1, 2, 3, 4];
const BALL_UNIT = 40; // 每桶参考单价（可随时直接改金额）
const MODES = [
  { v: 'jiao', t: '精确到角' },
  { v: 'yuan', t: '取整到元' },
  { v: 'cent', t: '精确到分' },
];

const cleanDigit = (v) => {
  const s = String(v || '').replace(/[^\d.]/g, '');
  const i = s.indexOf('.');
  return i < 0 ? s.slice(0, 5) : s.slice(0, i + 1) + s.slice(i + 1).replace(/\./g, '').slice(0, 2);
};

Page({
  data: {
    title: '', date: '',
    court: '', balls: '', extra: '',
    full: 4, half: 0,
    mode: 'jiao', modes: MODES, cans: BALL_CANS, ballUnit: BALL_UNIT,
    r: null, bill: '',
  },

  onLoad(o) {
    wx.hideShareMenu({ fail() {} });
    const title = o && o.title ? decodeURIComponent(o.title).slice(0, 24) : '';
    const date = o && o.date ? decodeURIComponent(o.date).slice(0, 16) : '';
    const n = o && Number(o.n) > 0 ? Math.min(64, Math.floor(Number(o.n))) : 4;
    this.setData({ title, date, full: n });
    this.recalc();
  },

  recalc() {
    const d = this.data;
    const input = { court: d.court, balls: d.balls, extra: d.extra, full: d.full, half: d.half, mode: d.mode };
    const r = AA.calc(input);
    const bill = AA.formatBill(input, { title: d.title, date: d.date });
    this.setData({ r, bill });
  },

  onMoney(e) {
    const k = e.currentTarget.dataset.k;
    if (k !== 'court' && k !== 'balls' && k !== 'extra') return;
    this.setData({ [k]: cleanDigit(e.detail.value) });
    this.recalc();
  },
  pickCan(e) {
    const c = Number(e.currentTarget.dataset.c) || 0;
    this.setData({ balls: c ? String(c * this.data.ballUnit) : '' });
    this.recalc();
    haptic.light();
  },
  stepPeople(e) {
    const { k, d } = e.currentTarget.dataset;
    if (k !== 'full' && k !== 'half') return;
    const next = Math.max(0, Math.min(64, (Number(this.data[k]) || 0) + Number(d)));
    this.setData({ [k]: next });
    this.recalc();
    haptic.light();
  },
  onPeople(e) {
    const k = e.currentTarget.dataset.k;
    if (k !== 'full' && k !== 'half') return;
    const n = Math.min(64, Number(String(e.detail.value || '').replace(/\D/g, '')) || 0);
    this.setData({ [k]: n });
    this.recalc();
  },
  setMode(e) {
    this.setData({ mode: e.currentTarget.dataset.v });
    this.recalc();
    haptic.light();
  },
  resetAll() {
    this.setData({ court: '', balls: '', extra: '', half: 0 });
    this.recalc();
    haptic.light();
  },
  copyBill() {
    if (!this.data.bill) { wx.showToast({ title: '先填写费用和人数', icon: 'none' }); return; }
    wx.setClipboardData({
      data: this.data.bill,
      success: () => { haptic.medium(); wx.showToast({ title: '已复制账单，可粘贴发群', icon: 'success' }); },
      fail: (e) => PV.copyFail(e),
    });
  },
});
