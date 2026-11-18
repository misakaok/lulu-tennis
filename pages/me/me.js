// 我的：就是自己的球员主页（和报名名单 / 排行榜点进去的球员主页共用 components/player-home），
// 不显示近期比赛（player-home 的 mine）；下面是只有自己看得到的：成长档案（带一个小摘要）、成员管理（管理员，放最下面）。
const G = require('../../utils/growth');

const pad = (n) => (n < 10 ? '0' : '') + n;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

Page({
  data: { myId: '', isAdmin: false, pendingApply: 0, gw: { played: 0 } },

  onShow() { this.load(); this.loadGrowth(); },
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    const c = this.selectComponent('#home');
    Promise.all([this.load(), this.loadGrowth(), c ? c.load() : null]).then(() => wx.stopPullDownRefresh());
  },

  // 成长档案摘要：只有本人的记录（云函数按 OPENID 读，内存缓存 60 秒）；读不到就显示入口说明
  async loadGrowth() {
    try {
      const s = G.summary(await require('../../utils/archive').list(), today());
      const gw = { played: s.played, rate: s.rate, month: s.thisMonth.played, trend: s.trend.map((t) => ({ ym: t.ym, label: t.label, h: t.played ? t.h : 0 })) };
      if (JSON.stringify(gw) !== JSON.stringify(this.data.gw)) this.setData({ gw });
    } catch (e) { console.error(e); }
  },

  async load() {
    try {
      // 顺便确认管理员身份（服务端决定）。只用来显示，缓存 60 秒：回到前台时 app.js 已经校验过成员资格，切换 tab 不用每次再调一次
      const ms = await require('../../utils/member').statusCached();
      if (ms.uid !== this.data.myId || ms.isAdmin !== this.data.isAdmin) this.setData({ myId: ms.uid, isAdmin: ms.isAdmin });
      const n = ms.isAdmin ? ms.pendingApply || 0 : 0; // 待审核的加入申请数（只有管理员有）
      if (n !== this.data.pendingApply) this.setData({ pendingApply: n });
    } catch (e) { console.error(e); }
  },
  openMembers() { wx.navigateTo({ url: '/pages/members/members' }); },
  openGrowth() { wx.navigateTo({ url: '/pages/growth/growth' }); },
  addGrowth() { wx.navigateTo({ url: '/pages/growth-edit/growth-edit' }); },
});
