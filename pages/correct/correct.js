// 修改比分：
//   mode=edit    日常比赛、对方还没确认：录入人直接改，改完等对方确认
//   mode=request 已双方确认：参赛者提交「申请修改比分」（新比分 + 原因），对方同意后才生效；赛事可由发起人裁定
// 赛制自动沿用这一场（赛事按阶段 / 轮次规则），处理前正式战绩、排名、晋级都不变。
const db = require('../../utils/db');
const cloud = require('../../utils/cloud');
const E = require('../../utils/event');
const ID = require('../../utils/ident');

Page({
  data: { loading: true, error: '', mode: 'request', aLabel: '', bLabel: '', current: '', ruleText: '', setGames: 4, noAd: true, bestOf: 1, init: [], reason: '', check: { ok: false, msg: '' }, submitting: false },

  onLoad(o) { this.id = o.matchId; this.setData({ mode: o.mode === 'edit' ? 'edit' : 'request' }); wx.setNavigationBarTitle({ title: o.mode === 'edit' ? '修改比分' : '申请修改比分' }); this.load(); },

  async load() {
    try {
      const [raw, players] = await Promise.all([db.getMatch(this.id), db.fetchPlayersFull().catch(() => db.cachedPlayersFull())]);
      if (!raw) throw new Error('比赛记录不存在');
      const m = ID.normalizeMatches([raw], players)[0];
      let rule = { setGames: m.setGames === 6 ? 6 : 4, noAd: m.noAd !== false, bestOf: m.bestOf === 3 ? 3 : 1 };
      if (m.drawId && m.drawKey) { const d = await db.getDraw(m.drawId); d._id = m.drawId; rule = E.ruleFor(d, m.drawKey); }
      this.m = m;
      this.setData({
        loading: false, aLabel: m.a.join(' / '), bLabel: m.b.join(' / '), current: E.scoreText(m.sets),
        ruleText: E.ruleText(rule), setGames: rule.setGames, noAd: rule.noAd, bestOf: rule.bestOf, init: m.sets || [],
      });
    } catch (e) { this.setData({ loading: false, error: e.message }); }
  },
  onSets(e) {
    this.res = e.detail;
    const r = e.detail;
    this.setData({ check: r.ok ? { ok: true, msg: `改为：${(r.winner === 'a' ? this.data.aLabel : this.data.bLabel)} 以 ${Math.max(r.won.a, r.won.b)}:${Math.min(r.won.a, r.won.b)} 获胜` } : { ok: false, msg: r.msg } });
  },
  onReason(e) { this.setData({ reason: e.detail.value }); },

  async submit() {
    if (this.data.submitting) return; // 防重复提交（云函数里也有同一场只能有一条待处理申请的校验）
    if (!this.res || !this.res.ok) { wx.showToast({ title: this.data.check.msg || '请填写正确比分', icon: 'none' }); return; }
    const reason = this.data.reason.trim();
    if (this.data.mode === 'request' && reason.length < 2) { wx.showToast({ title: '请填写修改原因', icon: 'none' }); return; }
    this.setData({ submitting: true });
    try {
      if (this.data.mode === 'edit') await cloud.call('editMatchScore', { matchId: this.id, sets: this.res.sets });
      else await cloud.call('requestScoreChange', { matchId: this.id, sets: this.res.sets, reason });
      wx.showToast({ title: this.data.mode === 'edit' ? '已修改，等对方确认' : '已提交，等对方处理', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
    } catch (e) {
      wx.showModal({ title: '提交失败', content: e.message, showCancel: false });
    } finally { this.setData({ submitting: false }); }
  },
});
