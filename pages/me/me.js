// 我的：就是自己的球员主页（和报名名单 / 排行榜点进去的球员主页共用 components/player-home），
// 另外加上只有自己看得到的：待办（待确认比分等）、水平分说明。
const db = require('../../utils/db');
const R = require('../../utils/rating');
const T = require('../../utils/todo');

Page({
  data: { myId: '', myIdTail: '', todo: null, rules: [], isAdmin: false, pendingApply: 0 },

  onLoad() {
    this.setData({
      rules: [
        `每人从自评等级开始（没有自评默认 ${R.fmt(R.DEFAULT_LEVEL)}），每打一场正式比赛都会按局数自动调整，得到「比赛等级」。`,
        '看的是「得局率」：输了但比预期打得好也会涨分，赢了但比预期差也会降分。',
        `前 ${R.PROVISIONAL} 场是「定级中」，分数变化更快；之后逐渐稳定。`,
        `防炸鱼：水平高出对手 ${R.NO_FARM_GAP} 以上时，赢了也不加分。`,
        '日常比赛和活动比赛都是录分后直接计入。',
        '双打按两人平均水平计算，两人的涨跌相同。',
      ],
    });
  },
  onShow() { this.load(); },
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    const c = this.selectComponent('#home');
    Promise.all([this.load(), c ? c.load() : null]).then(() => wx.stopPullDownRefresh());
  },

  async load() {
    try {
      // 顺便确认管理员身份（服务端决定）。只用来显示，缓存 60 秒：回到前台时 app.js 已经校验过成员资格，切换 tab 不用每次再调一次
      const ms = await require('../../utils/member').statusCached();
      if (ms.uid !== this.data.myId || ms.isAdmin !== this.data.isAdmin) this.setData({ myId: ms.uid, myIdTail: String(ms.uid || '').slice(-6), isAdmin: ms.isAdmin });
      const n = ms.isAdmin ? ms.pendingApply || 0 : 0; // 待审核的加入申请数（只有管理员有）
      if (n !== this.data.pendingApply) this.setData({ pendingApply: n });
    } catch (e) { console.error(e); }
    // 待办入口：下一场比赛、待我确认、等对方确认、改分申请（状态变了自动更新）
    T.load().then((t) => this.setData({
      todo: {
        count: t.count, next: t.next[0] || null,
        lines: [
          t.next.length ? `下一场 ${t.next.length}` : '', t.toConfirm.length ? `待我确认 ${t.toConfirm.length}` : '',
          t.toRespond.length ? `改分申请 ${t.toRespond.length}` : '', t.withdraws.length ? `退赛申请 ${t.withdraws.length}` : '',
          t.waiting.length + t.myRequests.length ? `等对方 ${t.waiting.length + t.myRequests.length}` : '',
        ].filter(Boolean),
      },
    })).catch((e) => console.warn(e.message));
  },
  // 复制自己的用户 ID：设置管理员时要用（只能复制自己的）
  copyMyId() {
    const id = this.data.myId;
    if (!id) return;
    wx.setClipboardData({ data: id, success: () => wx.showToast({ title: '已复制，发给管理员即可', icon: 'none' }) });
  },
  openMembers() { wx.navigateTo({ url: '/pages/members/members' }); },
  openTodo() { wx.navigateTo({ url: '/pages/todo/todo' }); },
  goRank() { wx.switchTab({ url: '/pages/rank/rank' }); },
});
