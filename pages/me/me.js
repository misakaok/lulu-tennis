// 我的：就是自己的球员主页（和报名名单 / 排行榜点进去的球员主页共用 components/player-home），
// 不显示近期比赛（player-home 的 mine）；下面是只有自己看得到的：成长档案（带一个小摘要）、成员管理（管理员，放最下面）。
const G = require('../../utils/growth');
const C = require('../../utils/cup');
const CUP_KEY = 'cache_cup_mine'; // 「我的 LULU 积分」卡上次的结果：{ uid, cup }

const pad = (n) => (n < 10 ? '0' : '') + n;
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

Page({
  data: { myId: '', isAdmin: false, pendingApply: 0, gw: null, cup: null }, // gw：成长档案摘要，读完之前是 null（只显示标题，不先闪「记第一场」）

  // 球员卡（按 myId 显示）和成员管理入口先按本机记得的身份显示（24 小时内确认过），不等云端；load 拿到身份后再更正
  onLoad() {
    wx.hideShareMenu({ fail() {} }); // 战绩、排行、我的（带昵称和战绩）不能转发，菜单里不显示转发；只有活动首页能分享
    const M = require('../../utils/member');
    if (!M.knownActive()) return;
    let myId = '';
    try { myId = wx.getStorageSync('my_openid') || ''; } catch (e) {}
    // 我的 LULU 积分：先显示本机记着的上一次结果（同一账号、同一年），云端读完再更正（2026-11-24 用户嫌出来慢）
    let cup = null;
    try { const c = wx.getStorageSync(CUP_KEY); if (c && c.uid === myId && c.cup && c.cup.year === C.thisYear()) cup = c.cup; } catch (e) {}
    this.setData(Object.assign({ myId, isAdmin: M.isAdminLocal() }, cup ? { cup } : {}));
  },
  onShow() { this.load(); this.loadGrowth(); this.loadCup(); },
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存（管理员刚更正 / 撤下的积分也马上看到）
    const c = this.selectComponent('#home');
    Promise.all([this.load(), this.loadGrowth(), this.loadCup(), c ? c.load() : null]).then(() => wx.stopPullDownRefresh());
  },

  // 我的 LULU 积分（2026-11-23 用户要求）：今年的单打 / 双打积分（遭遇赛有分才显示）+ 最近一站。
  // 数据是排行页积分榜同一个 cupList（只有已发布、没撤下的站）；按当前账号的用户 ID 认自己的记录（没开公开展示也能看到自己，cupList 不会把自己匿名）。
  // 读不到就不显示这张卡（不显示「暂无积分」，免得误以为分没了）
  async loadCup() {
    const seq = this.cupSeq = (this.cupSeq || 0) + 1;
    try {
      const [r, myId] = await Promise.all([require('../../utils/cloud').cached('cupList'), require('../../utils/db').myOpenid()]);
      if (seq !== this.cupSeq) return;
      const list = (r && r.list) || [];
      const year = C.thisYear();
      // cached 在 60 秒内返回同一个数组：数据、账号、年度都没变就不重算（每次切回「我的」都会调）
      const key = [myId, year].join('|');
      if (list === this.cupSrc && key === this.cupKey) return;
      this.cupSrc = list; this.cupKey = key;
      const m = C.mine(list, myId, year);
      const n = C.numText;
      const l = C.latestOf(list, myId);
      const cup = {
        year, any: m.single.stops + m.double.stops + m.encounter.stops > 0,
        single: n(m.single.total), double: n(m.double.total), encounter: m.encounter.stops ? n(m.encounter.total) : '',
        last: l ? { date: l.year === year ? l.date.slice(5) : l.date, kind: C.stopKindText(l), format: C.formatText(l.format), tier: C.tierText(l.tier), total: n(l.total), which: l.board, year: l.year } : null,
      };
      if (JSON.stringify(cup) !== JSON.stringify(this.data.cup)) {
        this.setData({ cup });
        try { wx.setStorage({ key: CUP_KEY, data: { uid: myId, cup }, fail() {} }); } catch (e) {} // 只存本人这张卡的几个数；退出成员身份时 clearProtected 清掉
      }
    } catch (e) { console.error(e); }
  },
  openCup() {
    const l = this.data.cup && this.data.cup.last;
    // 今年有积分就看今年；今年没有、但以前有：直接打开最近一站那一年
    const year = this.data.cup && !this.data.cup.any && l ? l.year : C.thisYear();
    wx.navigateTo({ url: `/pages/cup-mine/cup-mine?year=${year}&which=${l && l.year === year ? l.which : 'single'}` });
  },

  // 成长档案摘要：只有本人的记录（云函数按 OPENID 读，内存缓存 60 秒）；读不到就显示入口说明
  async loadGrowth() {
    try {
      const s = G.summary(await require('../../utils/archive').list(), today());
      const gw = { played: s.played, rate: s.rate, month: s.thisMonth.played, trend: s.trend.map((t) => ({ ym: t.ym, label: t.label, h: t.played ? t.h : 0 })) };
      if (JSON.stringify(gw) !== JSON.stringify(this.data.gw)) this.setData({ gw });
    } catch (e) { console.error(e); if (!this.data.gw) this.setData({ gw: { played: 0 } }); } // 读不到：显示入口说明
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
