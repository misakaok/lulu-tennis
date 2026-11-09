// 球员主页（看别人）：和「我的」共用 components/player-home。按用户 ID 打开：/pages/player/player?uid=xxx
// 打开的是自己时直接跳到「我的」，保证自己的主页只有一个入口和一份数据。
const db = require('../../utils/db');

Page({
  data: { uid: '' },
  async onLoad(o) {
    const uid = decodeURIComponent(o.uid || '');
    const me = await db.myOpenid().catch(() => '');
    if (uid && uid === me) { wx.switchTab({ url: '/pages/me/me' }); return; }
    this.setData({ uid });
    const p = db.cachedProfiles()[uid];
    if (p) wx.setNavigationBarTitle({ title: p.name + ' 的主页' });
  },
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    const c = this.selectComponent('#home');
    Promise.resolve(c ? c.load() : null).then(() => wx.stopPullDownRefresh());
  },
  onShareAppMessage() {
    const p = db.cachedProfiles()[this.data.uid];
    return { title: p ? `${p.name} 的网球主页` : '球员主页', path: '/pages/player/player?uid=' + encodeURIComponent(this.data.uid) };
  },
});
