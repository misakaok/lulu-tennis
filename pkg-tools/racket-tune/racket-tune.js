// 球拍贴铅片配重计算器（纯前端物理公式，借鉴 RacquetTune；无文字输入、无图片、不读写数据库）
const K = require('../../utils/racket');
const haptic = require('../../utils/haptic');

const PRESETS = [
  { id: '285', label: '轻拍 285g', weight: 285, balance: 330 },
  { id: '300', label: '主流 300g', weight: 300, balance: 320 },
  { id: '305', label: '进阶 305g', weight: 305, balance: 315 },
  { id: '315', label: '重拍 315g', weight: 315, balance: 310 },
];
const SPOTS = [
  { k: 'top', n: '12 点拍顶', d: '显着增挥重、变头重，强化借力与击球穿透' },
  { k: 'side', n: '3 / 9 点两侧', d: '抗扭更稳、甜区扩大，接大力球不易翻拍' },
  { k: 'throat', n: '拍喉三角区', d: '增加整体扎实感，几乎不改变平衡点' },
  { k: 'handle', n: '手柄 / 底盖', d: '调向头轻，提升网前截击与挥拍操控感' },
];

Page({
  data: {
    presets: PRESETS, presetId: '300',
    weight: '300', balance: '320',
    top: 0, side: 0, throat: 0, handle: 0,
    spots: SPOTS, r: null,
  },

  onLoad() {
    wx.hideShareMenu({ fail() {} });
    this.recalc();
  },

  recalc() {
    const d = this.data;
    const r = K.tuneRacket({ weight: d.weight, balance: d.balance, top: d.top, side: d.side, throat: d.throat, handle: d.handle });
    this.setData({ r });
  },

  pickPreset(e) {
    const p = PRESETS.find((x) => x.id === e.currentTarget.dataset.id);
    if (!p) return;
    this.setData({ presetId: p.id, weight: String(p.weight), balance: String(p.balance) });
    this.recalc();
    haptic.light();
  },
  onBase(e) {
    const k = e.currentTarget.dataset.k;
    if (k !== 'weight' && k !== 'balance') return;
    const v = String(e.detail.value || '').replace(/[^\d.]/g, '').slice(0, 5);
    this.setData({ [k]: v, presetId: '' });
    this.recalc();
  },
  stepSpot(e) {
    const { k, d } = e.currentTarget.dataset;
    if (k !== 'top' && k !== 'side' && k !== 'throat' && k !== 'handle') return;
    const cur = Number(this.data[k]) || 0;
    const next = Math.max(0, Math.min(40, Math.round((cur + Number(d)) * 10) / 10));
    this.setData({ [k]: next });
    this.recalc();
    haptic.light();
  },
  resetLead() {
    this.setData({ top: 0, side: 0, throat: 0, handle: 0 });
    this.recalc();
    haptic.light();
  },
});
