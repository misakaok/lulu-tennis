// 球员主页（顶部是球员卡）：底部「我的」（自己）和报名名单 / 排行榜点进来的别人主页共用这一个组件和同一套数据。
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
    mine: { type: Boolean, value: false }, // 「我的」页：不显示近期比赛（生涯成就里留一个「全部比赛」入口）
  },
  data: { loaded: false, cached: false, isSelf: false, view: null, recent: [], total: 0, allBadges: false, h2h: null },
  lifetimes: { attached() { if (this.data.uid) this.load(); }, detached() { Anim.stop(this); } },
  pageLifetimes: { show() { if (this.loadedOnce) this.load(); } }, // 编辑资料后回来刷新

  methods: {
    async load() {
      const uid = this.data.uid;
      if (!uid) return;
      this.loadedOnce = true;
      // 第一次打开（还没画过）先用本机缓存画出来；之后切回来不再读本机存储，直接用内存里的数据。
      // 本机有比赛缓存时，「还没有正式比赛」的生涯成就卡也马上显示（cached），不用等云端（2026-11-24 用户嫌「我的」页这块出来慢）；
      // 没有缓存（第一次打开）才等云端读完，免得有比赛的人先闪一下空卡
      if (this.viewUid !== uid) {
        const cm = db.cachedMatchesOrNull();
        this.render(db.cachedProfiles(), db.cachedPlayersFull(), cm || [], uid);
        if (cm && !this.data.cached) this.setData({ cached: true });
      }
      try {
        // 共享数据（不复制，只读）：数据没变时是同一个数组，render 里比较引用就跳过
        const [players, matches, myId] = await Promise.all([
          db.playersShared(), db.matchesShared(), db.myOpenid().catch(() => ''),
        ]);
        this.myId = myId;
        this.render(db.profilesOf(players), players, matches, uid);
      } catch (e) { console.error(e); }
      this.setData({ loaded: true });
    },

    render(profiles, players, matches, uid) {
      // 数据和上次一样（切换 tab、从子页面返回）就不重算、不重新渲染：比较引用，不把全部数据序列化一遍
      const src = this.srcRef, myId = this.myId || '';
      if (src && src.pf === profiles && src.p === players && src.m === matches && src.uid === uid && src.me === myId) return;
      this.srcRef = { pf: profiles, p: players, m: matches, uid, me: myId };
      const v = PV.playerView(profiles, players, matches, uid);
      const tagsOf = v.tagsOf; delete v.tagsOf; // 全部比赛的亮点标签：只用来算交手记录，不放进 setData
      this.view = v; this.viewUid = uid;
      // 看别人的主页时：我和 TA 的交手记录（按用户 ID）
      const me = this.myId && this.myId !== uid && profiles ? profiles[this.myId] : null;
      // 球员卡上的比赛等级、场数、胜率第一次显示时从 0 滚到实际值（排名不滚）
      const nums = v.profile ? { 'view.level.match': v.level.match, 'view.stats.matches': v.stats.matches, 'view.stats.rate': v.stats.rate } : {};
      // 渲染层只要最近 RECENT 场和总场数：全部比赛（v.rows）留在逻辑层的 this.view，不随 view 传过去（比赛多了 setData 很大）
      const shown = Object.assign({}, v); delete shown.rows;
      this.setData(Object.assign({
        h2h: me && v.profile ? PV.h2hView(matches, this.myId, me.name, uid, v.profile.name, tagsOf) : null,
        view: shown, isSelf: !!this.myId && this.myId === uid,
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
    allHistory() { wx.navigateTo({ url: '/pages/history/history?uid=' + encodeURIComponent(this.data.uid) }); },
  },
});
