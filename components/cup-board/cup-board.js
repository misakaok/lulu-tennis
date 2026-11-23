// 排行页「LULU 积分」：年度榜（单打 / 双打年终榜、遭遇赛）+ 每条总分的来源场次 + 每站名次。
//   数据只来自云函数 cupList（已发布的站；管理员另外能看到草稿），按 utils/cup.js 的 board 实时累加，不存累计分。
//   公开展示授权（2026-11-23 用户要求统一）：年度榜、各站明细、双打搭档里，没同意公开展示的人（players.shown 不是 true）名字一律显示「球友」，
//   不显示性别和照片，名次照常（不从榜上去掉）；本人看自己照常显示。普通成员的 cupList 里这些人已经是匿名编号（云函数 cupMask），这里再按资料兜底。
//   管理员入口：「补录一站」、每站「更正」（进 pages/cup-edit），权限由云函数判断，这里只决定显示哪些按钮
const cloud = require('../../utils/cloud');
const db = require('../../utils/db');
const C = require('../../utils/cup');
const member = require('../../utils/member');
const S = require('../../utils/stats');

Component({
  options: { addGlobalClass: true }, // 用 app.wxss 的 .card / .seg / .ui-tag / .btn-line 等全局样式
  properties: {
    tick: { type: Number, value: 0, observer() { if (this.ready) this.load(); } }, // 排行页 onShow / 下拉刷新时加一，重新读取
  },
  data: {
    loading: true, error: '', admin: false, which: 'single', boards: C.BOARDS, year: 0, years: [],
    rows: [], stops: [], drafts: [], open: '', openStop: '', meHidden: false,
  },
  lifetimes: {
    attached() { this.ready = true; this.load(); },
  },
  methods: {
    async load() {
      const seq = this.seq = (this.seq || 0) + 1; // 连续刷新时只认最后一次（旧的结果晚回来也不覆盖新的）
      try {
        const [r, players, myId] = await Promise.all([cloud.cached('cupList'), db.playersShared(), db.myOpenid().catch(() => '')]);
        if (seq !== this.seq) return;
        this.list = (r && r.list) || [];
        this.prof = db.profilesOf(players || []);
        this.myId = myId || '';
        const years = C.years(this.list);
        const y = years.indexOf(this.data.year) >= 0 ? this.data.year : years[0] || new Date().getFullYear();
        this.setData({ admin: !!(r && r.admin) || member.isAdminLocal(), years, year: y, error: '' });
        this.render();
      } catch (e) {
        if (seq !== this.seq) return;
        console.warn(e.message);
        this.setData({ error: '积分没有读取成功，下拉刷新再试一次' });
      }
      if (this.data.loading) this.setData({ loading: false });
      if (this.triggerEvent) this.triggerEvent('loaded'); // 排行页据此停下拉刷新
    },
    // 能不能显示这个人：同意了公开展示，或者是自己
    open(id) { return id === this.myId || (!!this.prof[id] && this.prof[id].shown === true); },
    nameOf(id) { return this.open(id) && this.prof[id] ? this.prof[id].name || '球友' : '球友'; },
    genderOf(id) { return this.open(id) ? S.GENDER[(this.prof[id] || {}).gender] || '' : ''; },
    people(ids) { return ids.map((id) => ({ key: id, uid: this.open(id) ? id : '', name: this.nameOf(id), gender: this.genderOf(id) })); },
    teamText(ids) { return ids.map((id) => this.nameOf(id)).join(' / '); },
    render() {
      const list = this.list || [], which = this.data.which, year = this.data.year;
      const all = C.board(list, year, which);
      const rows = all.map((r) => ({
        key: r.key, rank: r.rank, total: r.total, stops: r.stops, champions: r.champions,
        people: this.people(r.ids), mine: r.ids.indexOf(this.myId) >= 0,
        sources: r.sources.map((s, i) => ({
          i, stopId: s.stopId, date: s.date.slice(5), kind: C.kindText(s.kind), tier: C.tierText(s.tier),
          points: C.pointsText(s), total: s.total, bonusText: s.bonusText,
          partner: s.team ? s.team.filter((id) => r.ids.indexOf(id) < 0).map((id) => this.nameOf(id)).join(' / ') : '', // 双打：这一站的搭档
        })),
      }));
      const inBoard = (s) => Number(s.year) === Number(year) && C.boardOfStop(s) === which;
      const stopView = (s) => ({
        id: s.id, date: s.date, kind: C.kindText(s.kind), format: C.formatText(s.format), draft: s.status !== 'published', fixes: s.fixes || 0,
        // 双打一队两条（两人各拿一半）：名字写「Alice（和 Fay 一队）」
        lines: (s.results || []).map((x, i) => ({
          i, tier: C.tierText(x.tier), points: C.pointsText(x), total: x.total, bonusText: x.bonusText || '',
          names: this.teamText(x.ids) + (x.team ? `（和 ${x.team.filter((id) => x.ids.indexOf(id) < 0).map((id) => this.nameOf(id)).join(' / ')} 一队）` : ''),
        })),
      });
      const stops = list.filter((s) => s.status === 'published' && inBoard(s)).map(stopView);
      const drafts = this.data.admin ? list.filter((s) => s.status !== 'published').map(stopView) : [];
      const meIn = list.some((s) => (s.results || []).some((x) => x.ids.indexOf(this.myId) >= 0));
      const me = this.prof[this.myId];
      this.setData({ rows, stops, drafts, meHidden: meIn && !!me && me.shown !== true });
    },
    setWhich(e) { this.setData({ which: e.currentTarget.dataset.v, open: '', openStop: '' }); this.render(); },
    setYear(e) { this.setData({ year: Number(e.currentTarget.dataset.v), open: '', openStop: '' }); this.render(); },
    toggleRow(e) { const k = e.currentTarget.dataset.key; this.setData({ open: this.data.open === k ? '' : k }); },
    toggleStop(e) { const k = e.currentTarget.dataset.id; this.setData({ openStop: this.data.openStop === k ? '' : k }); },
    // 来源场次 → 展开那一站的名次
    goStop(e) {
      const id = e.currentTarget.dataset.id;
      this.setData({ openStop: id }, () => {
        // 页面级的 pageScrollTo({ selector }) 找不到组件里面的元素：在组件里查位置，再按页面滚动距离换算
        const q = this.createSelectorQuery();
        q.select('#cup-stop-' + id).boundingClientRect();
        q.selectViewport().scrollOffset();
        q.exec((res) => {
          const r = res && res[0], v = res && res[1];
          if (r && v) wx.pageScrollTo({ scrollTop: Math.max(0, v.scrollTop + r.top - 24), duration: 300, fail() {} });
        });
      });
    },
    addStop() { wx.navigateTo({ url: '/pages/cup-edit/cup-edit' }); },
    fixStop(e) { wx.navigateTo({ url: '/pages/cup-edit/cup-edit?id=' + encodeURIComponent(e.currentTarget.dataset.id) }); },
    openShown() { this.triggerEvent('shown'); },
  },
});
