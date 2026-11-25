// 球员主页（顶部是球员卡）：底部「我的」（自己）和报名名单 / 排行榜点进来的别人主页共用这一个组件和同一套数据。
//   uid：要看的球员的用户 ID。是不是本人由当前登录账号判断，只有本人看得到「编辑资料」。
//   统计数据都按正式战绩自动计算，页面上不能改。
const db = require('../../utils/db');
const PV = require('../../utils/player');
const RT = require('../../utils/rating');
const Anim = require('../../utils/anim');

const RECENT = 5;

Component({
  options: { addGlobalClass: true },
  properties: {
    uid: { type: String, value: '', observer: 'load' },
    mine: { type: Boolean, value: false }, // 「我的」页：不显示近期比赛（生涯成就里留一个「全部比赛」入口）
  },
  data: {
    loaded: false, cached: false, isSelf: false, view: null, recent: [], form: [], total: 0, allBadges: false, h2h: null,
    report: null, // 球风与年度数据二级页入口摘要
    simOpen: false, simGames: 6, simPresets: [], simIdx: 2, simRes: null, // 别人的主页：「如果和 TA 打一场」水平分模拟
  },
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
      // 看别人的主页时：我和 TA 的交手记录（按用户 ID）+ 模拟交手底数
      const me = this.myId && this.myId !== uid && profiles ? profiles[this.myId] : null;
      this.simCtx = me && v.profile ? {
        ratings: RT.ratingsOf(matches || [], players || []),
        players: players || [],
        myId: this.myId, myName: me.name, oppId: uid, oppName: v.profile.name,
      } : null;
      const simPatch = this.simCtx ? this.buildSim(this.data.simGames, this.data.simIdx) : { simPresets: [], simRes: null };
      // 球员卡上的比赛等级、场数、胜率第一次显示时从 0 滚到实际值（排名不滚）
      const nums = v.profile ? { 'view.level.match': v.level.match, 'view.stats.matches': v.stats.matches, 'view.stats.rate': v.stats.rate } : {};
      // 渲染层只要最近 RECENT 场、总场数与报告入口摘要：全部比赛与深度图表（含等级走势）放在二级页 pages/report，减轻主页渲染体积
      const shown = Object.assign({}, v);
      delete shown.rows; delete shown.trend; delete shown.heatmap; delete shown.clutch; delete shown.relations; delete shown.partners; delete shown.style;
      let report = null;
      if (v.profile && (v.rows.length > 0 || v.trend || v.heatmap || v.relations || v.partners)) {
        const bits = [];
        if (v.heatmap) bits.push(`${v.heatmap.year} 出勤 ${v.heatmap.days} 天`);
        if (v.clutch && v.clutch.tb.played) bits.push(`抢七 ${v.clutch.tb.rate}`);
        if (v.partners && v.partners.best) bits.push(`最佳拍档 ${v.partners.best.name}`);
        report = {
          sub: bits.length ? bits.join(' · ') : '五维球风、等级走势、热力图与关键分',
          tag: v.style && v.style.unlocked && v.style.tags[0] ? v.style.tags[0]
            : (v.style ? `${v.style.played}/${v.style.need} 场解锁球风` : ''),
          unlocked: !!(v.style && v.style.unlocked),
        };
      }
      const form = (v.rows || []).filter((r) => r.outcome === 'normal').slice(0, RECENT).map((r, i) => ({ i, w: r.win }));
      this.setData(Object.assign({
        h2h: me && v.profile ? PV.h2hView(matches, this.myId, me.name, uid, v.profile.name, tagsOf) : null,
        view: shown, report, isSelf: !!this.myId && this.myId === uid,
        recent: v.rows.slice(0, RECENT), form, total: v.rows.length,
      }, simPatch, Anim.roll(this, nums)));
    },

    buildSim(setGames, idx) {
      const c = this.simCtx;
      if (!c) return { simPresets: [], simRes: null };
      const sg = setGames === 4 ? 4 : 6;
      const presets = RT.scorePresets(sg).map(([a, b]) => ({ a, b, label: `${a}:${b}` }));
      const i = idx >= 0 && idx < presets.length ? idx : 2;
      const p = presets[i];
      const res = RT.simulateMatch(c.ratings, c.players, {
        aKeys: [c.myId], bKeys: [c.oppId], aNames: [c.myName], bNames: [c.oppName],
        mySide: 'a', myKey: c.myId, gamesA: p.a, gamesB: p.b,
      });
      return { simGames: sg, simPresets: presets, simIdx: i, simRes: res };
    },
    toggleSim() { this.setData({ simOpen: !this.data.simOpen }); },
    setSimGames(e) {
      const g = Number(e.currentTarget.dataset.g) === 4 ? 4 : 6;
      this.setData(this.buildSim(g, this.data.simIdx));
    },
    pickSim(e) {
      const i = Number(e.currentTarget.dataset.i);
      this.setData(this.buildSim(this.data.simGames, i));
    },
    openReport() {
      if (!this.data.uid) return;
      wx.navigateTo({ url: '/pkg-tools/report/report?uid=' + encodeURIComponent(this.data.uid) });
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
    openMatch(e) { // 先发出比赛状态请求（比赛详情第一次读取接过去）
      const id = e.currentTarget.dataset.id;
      db.prefetchMatchState(id);
      wx.navigateTo({ url: '/pages/match/match?id=' + id });
    },
    allHistory() { wx.navigateTo({ url: '/pkg-manage/history/history?uid=' + encodeURIComponent(this.data.uid) }); },
  },
});
