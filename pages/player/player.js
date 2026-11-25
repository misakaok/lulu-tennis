// 球员主页（看别人）：和「我的」共用 components/player-home。按用户 ID 打开：/pages/player/player?uid=xxx
// 打开的是自己时直接跳到「我的」，保证自己的主页只有一个入口和一份数据。
const db = require('../../utils/db');

Page({
  data: { uid: '' },
  onLoad(o) {
    wx.hideShareMenu(); // 过审：球员主页不能分享
    const uid = decodeURIComponent(o.uid || '');
    // 第一帧就把 uid 交给 player-home（2026-11-25 用户嫌点球友主页先白一下）：本机记得自己的用户 ID 就同步判断是不是自己，
    // 不等 myOpenid；本机不记得的先照常显示，后台确认是自己再跳「我的」
    const cachedMe = (db.cachedOpenid && db.cachedOpenid()) || '';
    if (uid && cachedMe && uid === cachedMe) { wx.switchTab({ url: '/pages/me/me' }); return; }
    this.setData({ uid });
    const p = (db.cachedProfiles ? db.cachedProfiles() : {})[uid];
    if (p) wx.setNavigationBarTitle({ title: p.name + ' 的主页' });
    if (!cachedMe && uid && db.myOpenid) {
      db.myOpenid().then((me) => { if (me && me === uid) wx.switchTab({ url: '/pages/me/me' }); }).catch(() => {});
    }
  },
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    const c = this.selectComponent('#home');
    Promise.resolve(c ? c.load() : null).then(() => wx.stopPullDownRefresh());
  },
});
