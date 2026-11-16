// 球员主页：底部「我的」（自己）和报名名单 / 排行榜点进来的别人主页共用这一个组件和同一套数据。
//   uid：要看的球员的用户 ID。是不是本人由当前登录账号判断，只有本人看得到「编辑资料」。
//   统计数据都按正式战绩自动计算，页面上不能改。
const db = require('../../utils/db');
const PV = require('../../utils/player');
const Anim = require('../../utils/anim');

const RECENT = 5;

Component({
  options: { addGlobalClass: true },
  properties: {
    uid: { type: String, value: '', observer: 'load' },
  },
  data: { loaded: false, isSelf: false, view: null, recent: [], total: 0, allBadges: false, h2h: null },
  lifetimes: { attached() { if (this.data.uid) this.load(); }, detached() { Anim.stop(this); } },
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
      // 数据和上次一样（先画缓存再画新数据、切换 tab、从子页面返回）就不重算、不重新渲染
      const sig = JSON.stringify([profiles || {}, players || [], matches || [], uid, this.myId || '']);
      if (sig === this.sig) return;
      this.sig = sig;
      const v = PV.playerView(profiles, players, matches, uid);
      const tagsOf = v.tagsOf; delete v.tagsOf; // 全部比赛的亮点标签：只用来算交手记录，不放进 setData
      this.view = v;
      // 看别人的主页时：我和 TA 的交手记录（按用户 ID）
      const me = this.myId && this.myId !== uid && profiles ? profiles[this.myId] : null;
      // 比赛等级、场数、胜负、胜率第一次显示时从 0 滚到实际值（排名不滚）
      const nums = v.profile ? { 'view.level.match': v.level.match, 'view.stats.matches': v.stats.matches, 'view.stats.wl': v.stats.wl, 'view.stats.rate': v.stats.rate } : {};
      this.setData(Object.assign({
        h2h: me && v.profile ? PV.h2hView(matches, this.myId, me.name, uid, v.profile.name, tagsOf) : null,
        view: v, isSelf: !!this.myId && this.myId === uid,
        recent: v.rows.slice(0, RECENT), total: v.rows.length,
      }, Anim.roll(this, nums)));
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
    openPlayer(e) { const u = e.currentTarget.dataset.uid; if (u) wx.navigateTo({ url: '/pages/player/player?uid=' + encodeURIComponent(u) }); },
    openMatch(e) { wx.navigateTo({ url: '/pages/match/match?id=' + e.currentTarget.dataset.id }); },
    openSummary(e) { wx.navigateTo({ url: `/pages/summary/summary?uid=${encodeURIComponent(this.data.uid)}&season=${e.currentTarget.dataset.s}` }); },
    allHistory() { wx.navigateTo({ url: '/pages/history/history?uid=' + encodeURIComponent(this.data.uid) }); },
  },
});
