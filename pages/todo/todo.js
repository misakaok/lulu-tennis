// 我的待办：下一场比赛、待我确认的比分、等待对方确认、改分申请、待评价、退赛申请（发起人）
const T = require('../../utils/todo');

Page({
  data: { loading: true, t: null, empty: false },
  onShow() { this.load(); }, // 处理完回来自动刷新：完成的事项不再显示
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },
  async load() {
    try {
      const t = await T.load();
      const empty = !t.count && !t.waiting.length && !t.myRequests.length;
      this.setData({ t, empty, loading: false });
    } catch (e) {
      console.error(e);
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败，请下拉重试', icon: 'none' });
    }
  },
  openMatch(e) { wx.navigateTo({ url: '/pages/match/match?id=' + e.currentTarget.dataset.id }); },
  openFixture(e) { const { draw, key } = e.currentTarget.dataset; wx.navigateTo({ url: `/pages/score/score?drawId=${draw}&key=${key}` }); },
  openDraw(e) { wx.navigateTo({ url: '/pages/draw-view/draw-view?id=' + e.currentTarget.dataset.draw }); },
});
