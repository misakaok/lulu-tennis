// 赛后：确认赛果 → 互评对手；以及撤销赛果
// 所有资格判断（是否参赛、是否对手、是否结束、是否已确认、是否重复）都由云函数完成，
// 这里只按云函数返回的状态显示按钮，按钮被绕过也提交不成功。
const cloud = require('../../utils/cloud');

Component({
  options: { addGlobalClass: true },
  properties: {
    matchId: { type: String, value: '', observer: 'load' },
    revocable: { type: Boolean, value: false }, // 前端提示用：录入人或发起人（云函数会再校验）
  },
  data: { st: null, loading: false, busy: false, err: '' },
  pageLifetimes: { show() { if (this.loaded) this.load(); } }, // 从评价页回来刷新
  methods: {
    async load() {
      const id = this.data.matchId;
      if (!id) return;
      this.loaded = true;
      this.setData({ loading: true });
      try {
        const st = await cloud.call('matchState', { matchId: id });
        const sides = st.sides || {};
        this.setData({
          st: Object.assign(st, {
            sideA: sides.a ? (sides.a === '录入' ? '录入方' : sides.a + ' 已确认') : '待确认',
            sideB: sides.b ? (sides.b === '录入' ? '录入方' : sides.b + ' 已确认') : '待确认',
          }),
          err: '', loading: false,
        });
      } catch (e) { this.setData({ err: e.message, loading: false }); }
    },
    async confirm() {
      if (this.data.busy) return;
      require('../../utils/notify').ask(); // 顺便请求通知权限（必须在点击时同步调用）
      this.setData({ busy: true });
      try {
        await cloud.call('confirmResult', { matchId: this.data.matchId });
        wx.showToast({ title: '已确认', icon: 'success' });
        await this.load();
      } catch (e) { wx.showModal({ title: '无法确认', content: e.message, showCancel: false }); }
      this.setData({ busy: false });
    },
    // 评价对象按用户 ID 传，名字只用来显示
    review(e) {
      const { id, t } = e.currentTarget.dataset;
      wx.navigateTo({ url: `/pages/review/review?matchId=${this.data.matchId}&targetId=${encodeURIComponent(id)}&target=${encodeURIComponent(t)}` });
    },
    /* ---------- 比分纠错 ---------- */
    edit() {
      const st = this.data.st;
      // 赛事比赛在赛程里改（自动沿用本场规则）；日常比赛到修改页
      if (st.drawId) wx.navigateTo({ url: `/pages/score/score?drawId=${st.drawId}&key=${st.drawKey}` });
      else wx.navigateTo({ url: `/pages/correct/correct?matchId=${this.data.matchId}&mode=edit` });
    },
    requestChange() { wx.navigateTo({ url: `/pages/correct/correct?matchId=${this.data.matchId}&mode=request` }); },
    ask(title, placeholder) {
      return new Promise((resolve) => wx.showModal({
        title, editable: true, placeholderText: placeholder,
        success: (r) => resolve(r.confirm ? (r.content || '').trim() : null), fail: () => resolve(null),
      }));
    },
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
      const note = accept ? '' : await this.ask('拒绝修改', '可以写一下原因（选填）');
      if (note === null) return;
      const r = await this.act('respondScoreChange', { requestId: this.data.st.request.id, accept, note }, accept ? '已同意，新比分生效' : '已拒绝，保留原比分');
      if (r) { this.load(); this.triggerEvent('changed'); }
    },
    async rule(e) {
      const accept = e.currentTarget.dataset.v === '1';
      const reason = await this.ask(accept ? '裁定：采用新比分' : '裁定：保留原比分', '裁定原因（必填）');
      if (reason === null) return;
      if (reason.length < 2) { wx.showToast({ title: '请填写裁定原因', icon: 'none' }); return; }
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
      wx.showModal({
        title: '撤销这场比赛的赛果？',
        content: '比分会被删除，战绩、排名、水平分和晋级结果随之更新，已有的确认和对手评价不再生效。',
        confirmText: '撤销', confirmColor: '#e5484d',
        success: async (r) => {
          if (!r.confirm) return;
          try {
            let res = await cloud.call('revokeMatch', { matchId: this.data.matchId });
            if (res.needReason) {
              // 发起人撤销已确认 / 弃权退赛 / 影响后续场次的比分：必须填原因；有影响时列出并确认
              const impact = res.impact || [];
              const lines = impact.map((x) => `${x.stage}：${x.a} vs ${x.b} ${x.score}`).join('\n');
              const ask = await new Promise((done) => wx.showModal({
                title: impact.length ? '会影响后续比赛' : '请填写撤销原因',
                content: impact.length ? `撤销后，下面已录分的比赛比分将作废：\n${lines}` : '',
                editable: true, placeholderText: '撤销原因（必填，会留档）',
                confirmText: '确认撤销', confirmColor: '#e5484d',
                success: (x) => done(x), fail: () => done({ confirm: false }),
              }));
              if (!ask.confirm) return;
              const reason = String(ask.content || '').trim();
              if (reason.length < 2) { wx.showToast({ title: '请填写原因（至少 2 个字）', icon: 'none' }); return; }
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
