// 赛后：确认赛果、比分纠错，以及撤销赛果
// 所有资格判断（是否参赛、是否结束、是否已确认）都由云函数完成，
// 这里只按云函数返回的状态显示按钮，按钮被绕过也提交不成功。
const cloud = require('../../utils/cloud');
const pick = require('../../utils/pick');

Component({
  options: { addGlobalClass: true },
  properties: {
    matchId: { type: String, value: '' },
    preset: { type: Object, value: null }, // 页面已经取到的 matchState 结果：第一次直接用，不再调云函数
    revocable: { type: Boolean, value: false }, // 前端提示用：录入人、日常比赛的参加者（云函数会再校验）
  },
  // 多字段监听器在同批属性更新后执行，不依赖 Promise 微任务的调度时机。
  observers: { 'matchId, preset'() { this.load(true); } },
  data: { st: null, loading: false, busy: false, err: '' },
  // 从改分页 / 活动录分页回来刷新。比赛详情先画的预览（st.preview，普通日常比赛第一帧就挂上）不刷新：
  // 那时页面自己正在读 matchState、读完传 preset 进来，紧接着的第一次 onShow 不能再发一次
  pageLifetimes: { show() { if (this.loaded && !this.isPreview()) this.load(); } },
  methods: {
    // 本机身份画的预览（还没拿到云端结果）：按钮照样显示（不闪），点了不动作，免得按过期的本机身份（如管理员已被撤销）操作
    isPreview() { return !!(this.data.st && this.data.st.preview); },
    async load(usePreset) {
      const id = this.data.matchId;
      if (!id) return;
      const seq = this.loadSeq = (this.loadSeq || 0) + 1;
      const changed = this.loadedId !== id;
      const pre = usePreset === true && this.data.preset && this.data.preset.matchId === id ? this.data.preset : null;
      this.loaded = true; this.loadedId = id;
      if (changed) this.setData({ st: null, err: '' });
      if (!pre) this.setData({ loading: true });
      try {
        const st = pre ? Object.assign({}, pre) : await cloud.call('matchState', { matchId: id });
        if (seq !== this.loadSeq || this.data.matchId !== id) return;
        const sides = st.sides || {};
        this.setData({
          st: Object.assign(st, {
            sideA: sides.a ? (sides.a === '录入' ? '录入方' : sides.a + ' 已确认') : '待确认',
            sideB: sides.b ? (sides.b === '录入' ? '录入方' : sides.b + ' 已确认') : '待确认',
          }),
          err: '', loading: false,
        });
      } catch (e) { if (seq === this.loadSeq && this.data.matchId === id) this.setData({ err: e.message, loading: false }); }
    },
    async confirm() {
      if (this.data.busy) return;
      this.setData({ busy: true });
      try {
        await cloud.call('confirmResult', { matchId: this.data.matchId });
        wx.showToast({ title: '已确认', icon: 'success' });
        await this.load();
      } catch (e) { wx.showModal({ title: '无法确认', content: e.message, showCancel: false }); }
      this.setData({ busy: false });
    },
    /* ---------- 比分纠错 ---------- */
    edit() {
      if (this.isPreview()) return;
      const st = this.data.st;
      // 活动比赛在赛程里改（自动沿用本场规则）；日常比赛到修改页
      if (st.drawId) wx.navigateTo({ url: `/pages/score/score?drawId=${st.drawId}&key=${st.drawKey}` });
      else wx.navigateTo({ url: `/pages/correct/correct?matchId=${this.data.matchId}&mode=edit` });
    },
    adminFix() { if (!this.isPreview()) wx.navigateTo({ url: `/pages/correct/correct?matchId=${this.data.matchId}&mode=admin` }); },
    requestChange() { if (!this.isPreview()) wx.navigateTo({ url: `/pages/correct/correct?matchId=${this.data.matchId}&mode=request` }); },
    async act(action, data, okText) {
      if (this.data.busy) return null; // 防重复点击（云函数里还有原子领取，重复处理只会生效一次）
      this.setData({ busy: true });
      try {
        const r = await cloud.call(action, data);
        if (okText && !r.needConfirm) wx.showToast({ title: okText, icon: 'none' });
        return r;
      } catch (e) { wx.showModal({ title: '操作失败', content: e.message, showCancel: false }); return null; }
      finally { this.setData({ busy: false }); }
    },
    async respond(e) {
      const accept = e.currentTarget.dataset.v === '1';
      const note = accept ? '' : await pick.reason('decline', '拒绝修改的原因');
      if (note === null) return;
      const r = await this.act('respondScoreChange', { requestId: this.data.st.request.id, accept, note }, accept ? '已同意，新比分生效' : '已拒绝，保留原比分');
      if (r) { this.load(); this.triggerEvent('changed'); }
    },
    async rule(e) {
      const accept = e.currentTarget.dataset.v === '1';
      const reason = await pick.reason('rule', accept ? '裁定：采用新比分' : '裁定：保留原比分');
      if (!reason) return;
      const data = { requestId: this.data.st.request.id, accept, reason };
      let r = await this.act('ruleScoreChange', data, accept ? '已裁定，新比分生效' : '已裁定，保留原比分');
      if (r && r.needConfirm) {
        // 会改变后续已录分的比赛：明确列出影响，确认后才执行（受影响的比分作废并留档）
        const list = r.impact.map((x) => `${x.stage}：${x.a} vs ${x.b} ${x.score}`).join('\n');
        const ok = await new Promise((res) => wx.showModal({ title: '会影响后续比赛', content: `采用新比分后，下面已录分的比赛对阵会变化，比分将作废：\n${list}`, confirmText: '确认裁定', confirmColor: '#e5484d', success: (x) => res(x.confirm) }));
        if (!ok) return;
        r = await this.act('ruleScoreChange', Object.assign(data, { confirmImpact: true }), '已裁定，后续比赛已重新安排');
      }
      if (r) { this.load(); this.triggerEvent('changed'); }
    },
    async cancelRequest() {
      const r = await this.act('cancelScoreChange', { requestId: this.data.st.request.id }, '已撤回');
      if (r) this.load();
    },

    revoke() {
      if (this.isPreview()) return;
      wx.showModal({
        title: '撤销这场比赛的赛果？',
        content: '比分会被删除，战绩、排名、水平分和后面的对阵随之更新，已有的确认不再生效。',
        confirmText: '撤销', confirmColor: '#e5484d',
        success: async (r) => {
          if (!r.confirm) return;
          try {
            let res = await cloud.call('revokeMatch', { matchId: this.data.matchId });
            if (res.needConfirm) {
              // 管理员撤销会推翻后续已录分的比赛：列出影响，确认后才执行（不用填原因，照样留档）
              const lines = (res.impact || []).map((x) => `${x.stage}：${x.a} vs ${x.b} ${x.score}`).join('\n');
              const go = await new Promise((done) => wx.showModal({
                title: '会影响后续比赛', content: `撤销后，下面已录分的比赛比分将作废：\n${lines}`,
                confirmText: '确认撤销', confirmColor: '#e5484d', success: (x) => done(x.confirm), fail: () => done(false),
              }));
              if (!go) return;
              res = await cloud.call('revokeMatch', { matchId: this.data.matchId, confirmImpact: true });
              if (res.needConfirm || res.needReason) { wx.showToast({ title: '比分刚刚有变动，请重试', icon: 'none' }); this.load(); return; }
            }
            if (res.needReason) {
              // 发起人撤销已确认 / 弃权退赛 / 影响后续场次的比分：必须选原因；有影响时先列出并确认
              const impact = res.impact || [];
              if (impact.length) {
                const lines = impact.map((x) => `${x.stage}：${x.a} vs ${x.b} ${x.score}`).join('\n');
                const go = await new Promise((done) => wx.showModal({
                  title: '会影响后续比赛', content: `撤销后，下面已录分的比赛比分将作废：\n${lines}`,
                  confirmText: '继续', confirmColor: '#e5484d', success: (x) => done(x.confirm), fail: () => done(false),
                }));
                if (!go) return;
              }
              const reason = await pick.reason('fix', '撤销原因（会留档）');
              if (!reason) return;
              res = await cloud.call('revokeMatch', { matchId: this.data.matchId, reason, confirmImpact: true });
              if (res.needReason) { wx.showToast({ title: '比分刚刚有变动，请重试', icon: 'none' }); this.load(); return; }
            }
            wx.showToast({ title: '已撤销', icon: 'success' });
            this.triggerEvent('revoked');
          } catch (err) { wx.showModal({ title: '撤销失败', content: err.message, showCancel: false }); }
        },
      });
    },
  },
});
