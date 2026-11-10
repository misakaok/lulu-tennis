// 我的：就是自己的球员主页（和报名名单 / 排行榜点进去的球员主页共用 components/player-home），
// 另外加上只有自己看得到的：待办（待确认比分 / 待评价）、水平分说明、头像检测。
const db = require('../../utils/db');
const A = require('../../utils/avatar');
const cloud = require('../../utils/cloud');
const R = require('../../utils/rating');
const T = require('../../utils/todo');

Page({
  data: { myId: '', myIdTail: '', todo: null, rules: [], checking: false, isAdmin: false },

  onLoad() {
    this.setData({
      rules: [
        `每人从自评等级开始（没有自评默认 ${R.fmt(R.DEFAULT_LEVEL)}），每打一场正式比赛都会按局数自动调整，得到「比赛等级」。`,
        '看的是「得局率」：输了但比预期打得好也会涨分，赢了但比预期差也会降分。',
        `前 ${R.PROVISIONAL} 场是「定级中」，分数变化更快；之后逐渐稳定。`,
        `防炸鱼：水平高出对手 ${R.NO_FARM_GAP} 以上时，赢了也不加分。`,
        '日常比赛要对手确认后才计入；活动比赛录分后直接计入。',
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
      const ms = await require('../../utils/member').status(); // 顺便确认管理员身份（服务端决定）
      if (ms.uid !== this.data.myId || ms.isAdmin !== this.data.isAdmin) this.setData({ myId: ms.uid, myIdTail: String(ms.uid || '').slice(-6), isAdmin: ms.isAdmin });
    } catch (e) { console.error(e); }
    // 待办入口：下一场比赛、待我确认、等对方确认、改分申请、待评价（状态变了自动更新）
    T.load().then((t) => this.setData({
      todo: {
        count: t.count, next: t.next[0] || null,
        lines: [
          t.next.length ? `下一场 ${t.next.length}` : '', t.toConfirm.length ? `待我确认 ${t.toConfirm.length}` : '',
          t.toRespond.length ? `改分申请 ${t.toRespond.length}` : '', t.withdraws.length ? `退赛申请 ${t.withdraws.length}` : '',
          t.toReview.length ? `待评价 ${t.toReview.length}` : '', t.waiting.length + t.myRequests.length ? `等对方 ${t.waiting.length + t.myRequests.length}` : '',
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

  // 检查所有头像：云文件是否存在、环境是否一致、有没有读取权限
  async checkAvatars() {
    if (this.data.checking) return;
    this.setData({ checking: true });
    try {
      const [players, draws] = await Promise.all([db.fetchPlayersFull(), db.fetchDraws().catch(() => [])]);
      const ids = players.map((p) => p.avatar);
      draws.forEach((d) => Object.keys(d.avatars || {}).forEach((k) => ids.push(d.avatars[k])));
      const r = await A.diagnose(ids.filter(Boolean));
      console.log('[头像诊断]', r);
      wx.showModal({ title: '头像检测结果', content: A.reportText(r), showCancel: false });
    } catch (e) {
      console.error(e);
      wx.showModal({ title: '检测失败', content: '请稍后再试', showCancel: false });
    } finally {
      this.setData({ checking: false });
    }
  },
});
