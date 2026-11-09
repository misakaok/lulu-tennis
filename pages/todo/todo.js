// 我的待办：下一场比赛、待我确认的比分、等待对方确认、改分申请、待评价、退赛申请（发起人）
const T = require('../../utils/todo');

Page({
  data: { loading: true, t: null, empty: false, canNotify: false },
  onShow() { // 处理完回来自动刷新：完成的事项不再显示
    this.load();
    const N = require('../../utils/notify');
    this.setData({ canNotify: N.available() });
    N.prefetch().then(() => this.setData({ canNotify: N.available() }));
  },
  // 开启提醒：每点一次「允许」，能收到一条对应的通知（微信一次性订阅的规则）
  enableNotify() {
    require('../../utils/notify').ask().then((r) => {
      wx.showToast({ title: r.accepted ? '已开启，有新的待办会通知你' : '没有开启通知', icon: 'none' });
    });
  },
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    this.load().then(() => wx.stopPullDownRefresh()); },
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
