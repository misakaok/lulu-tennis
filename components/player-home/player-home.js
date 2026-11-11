// 球员主页：底部「我的」（自己）和报名名单 / 排行榜点进来的别人主页共用这一个组件和同一套数据。
//   uid：要看的球员的用户 ID。是不是本人由当前登录账号判断，只有本人看得到「编辑资料」。
//   统计数据都按正式战绩自动计算，页面上不能改。
const db = require('../../utils/db');
const PV = require('../../utils/player');

const RECENT = 5;

Component({
  options: { addGlobalClass: true },
  properties: {
    uid: { type: String, value: '', observer: 'load' },
  },
  data: { loaded: false, isSelf: false, view: null, recent: [], total: 0, allBadges: false },
  lifetimes: { attached() { if (this.data.uid) this.load(); } },
  pageLifetimes: { show() { if (this.loadedOnce) this.load(); } }, // 编辑资料后回来刷新

  methods: {
    async load() {
      const uid = this.data.uid;
      if (!uid) return;
      this.loadedOnce = true;
      // 先用缓存画出来，再拉最新数据
      this.render(db.cachedProfiles(), db.cachedPlayersFull(), db.cachedMatches(), uid);
      try {
        const [players, matches, myId] = await Promise.all([
          db.fetchPlayersFull(), db.fetchMatches(), db.myOpenid().catch(() => ''),
        ]);
        this.myId = myId;
        this.render(db.cachedProfiles(), players, matches, uid);
      } catch (e) { console.error(e); }
      this.setData({ loaded: true });
    },

    render(profiles, players, matches, uid) {
      const v = PV.playerView(profiles, players, matches, uid);
      this.view = v;
      this.setData({
        view: v, isSelf: !!this.myId && this.myId === uid,
        recent: v.rows.slice(0, RECENT), total: v.rows.length,
      });
    },

    toggleBadges() { this.setData({ allBadges: !this.data.allBadges }); },
    badgeTip(e) {
      const b = this.data.view.career.badges[e.currentTarget.dataset.i];
      if (b) wx.showToast({ title: `${b.name}：${b.desc}${b.got ? '（已达成）' : '（' + b.progress + '）'}`, icon: 'none' });
    },

    edit() {
      if (!this.data.isSelf) return; // 只有本人能编辑
      wx.navigateTo({ url: '/pages/profile/profile' });
    },
    openMatch(e) { wx.navigateTo({ url: '/pages/match/match?id=' + e.currentTarget.dataset.id }); },
    allHistory() { wx.navigateTo({ url: '/pages/history/history?uid=' + encodeURIComponent(this.data.uid) }); },

    challenge() {
      const me = db.cachedProfile();
      const v = this.data.view;
      if (!me) { wx.showToast({ title: '先在「我的」里设置资料', icon: 'none' }); return; }
      wx.navigateTo({ url: `/pages/challenge/challenge?from=${encodeURIComponent(me.name)}&to=${encodeURIComponent(v.profile.name)}` });
    },
  },
});
