// 评价对手：三个维度各 1～5 分 + 选填文字。资格和防重复都由云函数 submitReview 校验
const cloud = require('../../utils/cloud');
const db = require('../../utils/db');
const { colorOf, initialOf } = require('../../utils/rules');

const DIMS = [
  { k: 'manner', t: '球品礼仪', d: '判球诚实、尊重对手、输赢有风度' },
  { k: 'punctual', t: '守时守约', d: '准时到场、不临时放鸽子' },
  { k: 'level', t: '水平相符', d: '实际水平和他的等级分相符' },
];
const HINT = ['', '很差', '较差', '一般', '不错', '很好'];

Page({
  data: { stars: [1, 2, 3, 4, 5], target: '', avatar: '', initial: '', color: '', dims: [], text: '', submitting: false, canSubmit: false },

  onLoad(o) {
    this.matchId = o.matchId;
    this.targetId = decodeURIComponent(o.targetId || '');
    const target = decodeURIComponent(o.target || '');
    const p = db.cachedPlayersFull().find((x) => x.uid && x.uid === this.targetId) || {};
    this.scores = {};
    this.setData({ target, avatar: p.avatar || '', initial: initialOf(target), color: colorOf(target) });
    this.render();
  },

  render() {
    this.setData({
      dims: DIMS.map((x) => ({ k: x.k, t: x.t, d: x.d, v: this.scores[x.k] || 0, hint: HINT[this.scores[x.k] || 0] })),
      canSubmit: DIMS.every((x) => this.scores[x.k]),
    });
  },
  star(e) { const { k, v } = e.currentTarget.dataset; this.scores[k] = Number(v); this.render(); },
  onText(e) { this.setData({ text: e.detail.value }); },

  async submit() {
    if (this.data.submitting) return;
    if (!this.data.canSubmit) { wx.showToast({ title: '请给三项都打分', icon: 'none' }); return; }
    this.setData({ submitting: true });
    try {
      const r = await cloud.call('submitReview', { matchId: this.matchId, targetId: this.targetId, scores: this.scores, text: this.data.text.trim() });
      wx.showToast({ title: `已评价 ${r.overall} 分`, icon: 'success' });
      setTimeout(() => wx.navigateBack(), 700);
    } catch (e) {
      wx.showModal({ title: '提交失败', content: e.message, showCancel: false });
    } finally {
      this.setData({ submitting: false });
    }
  },
});
