// 球员主页：底部「我的」（自己）和报名名单 / 排行榜点进来的别人主页共用这一个组件和同一套数据。
//   uid：要看的球员的用户 ID。是不是本人由当前登录账号判断，只有本人看得到「编辑资料」。
//   统计数据都按正式战绩自动计算，页面上不能改。
const db = require('../../utils/db');
const cloud = require('../../utils/cloud');
const RV = require('../../utils/reviews');
const PV = require('../../utils/player');

const RECENT = 5;

Component({
  options: { addGlobalClass: true },
  properties: {
    uid: { type: String, value: '', observer: 'load' },
  },
  data: { loaded: false, isSelf: false, view: null, recent: [], total: 0, bio: '', rep: null, busy: false },
  lifetimes: { attached() { if (this.data.uid) this.load(); } },
  pageLifetimes: { show() { if (this.loadedOnce) this.load(); } }, // 编辑资料 / 评价后回来刷新

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
      this.loadSocial(uid);
    },

    render(profiles, players, matches, uid) {
      const v = PV.playerView(profiles, players, matches, uid);
      this.view = v;
      this.setData({
        view: v, isSelf: !!this.myId && this.myId === uid,
        recent: v.rows.slice(0, RECENT), total: v.rows.length,
      });
    },

    // 个人简介和对手评价来自云函数（按用户 ID）
    async loadSocial(uid) {
      cloud.call('getBios', { ids: [uid] }).then((r) => this.setData({ bio: r.bios[uid] || '' })).catch(() => {});
      const rep = await RV.summary([uid]);
      this.setData({ rep: rep ? rep[uid] || RV.view(null) : null });
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

    // 从主页评价：只能挑「实际交手、比分双方确认、还没评价过」的比赛，云函数列出并在提交时再校验
    async reviewTa() {
      if (this.data.busy) return;
      this.setData({ busy: true });
      try {
        const r = await cloud.call('reviewableWith', { targetId: this.data.uid });
        const name = this.data.view.profile.name;
        const go = (m) => wx.navigateTo({ url: `/pages/review/review?matchId=${m.matchId}&targetId=${encodeURIComponent(this.data.uid)}&target=${encodeURIComponent(name)}` });
        if (r.list.length === 1) go(r.list[0]);
        else if (r.list.length > 1) {
          const list = r.list.slice(0, 6);
          wx.showActionSheet({ itemList: list.map((m) => `${(m.date || '').slice(5)} ${m.title} ${m.score}`), success: (x) => go(list[x.tapIndex]) });
        } else {
          let msg = `你和 ${name} 还没有已确认比分的交手比赛。只有实际交手、比分经双方确认后才能评价`;
          if (r.unconfirmed) msg = `你们有 ${r.unconfirmed} 场比赛的比分还没双方确认，确认后才能评价`;
          else if (r.reviewed) msg = `你们交手过的比赛，你都已经评价过 ${name} 了`;
          wx.showModal({ title: '暂时不能评价', content: msg, showCancel: false });
        }
      } catch (e) {
        wx.showModal({ title: '暂时不能评价', content: e.message, showCancel: false });
      } finally { this.setData({ busy: false }); }
    },
  },
});
