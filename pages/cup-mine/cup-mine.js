// 我的 LULU 积分（个人明细，2026-11-23 用户要求）：从「我的」页积分卡片进来。
//   数据和排行页的积分榜同一来源（云函数 cupList，只有已发布、没撤下的站），按 utils/cup.js 的 mine 用当前账号的用户 ID 认自己的记录，
//   没开公开展示也能看到自己的总分和明细（cupList 不会把自己换成匿名编号）。只有本人看得到，不能分享。
//   切换年度、单打 / 双打 / 遭遇赛（遭遇赛单独统计，不进年终榜）；每站列出名次、基础分、奖励分、合计；
//   双打写搭档：没同意公开展示的搭档显示「球友」（普通成员拿到的已经是匿名编号，这里再按资料兜底）。
//   管理员更正、撤下后：下拉刷新（作废内存缓存）就能看到新结果。
const cloud = require('../../utils/cloud');
const db = require('../../utils/db');
const C = require('../../utils/cup');

const memo = require('../../utils/memo');

const num = C.numText;
const WHICH_TEXT = { single: '单打', double: '双打', encounter: '遭遇赛' };
const TABS = C.BOARDS.map((b) => ({ value: b.value, label: WHICH_TEXT[b.value] }));

Page({
  data: { loading: true, error: '', years: [], year: 0, which: 'single', whichText: '单打', tabs: TABS, sum: null, items: [], meHidden: false },
  onLoad(o) {
    wx.hideShareMenu({ fail() {} }); // 个人积分只给自己看，不能分享
    const which = C.BOARDS.some((b) => b.value === o.which) ? o.which : 'single';
    this.setData({ which, whichText: WHICH_TEXT[which], year: Number(o.year) || C.thisYear() });
    this.early();
    this.load();
  },
  // 第一帧就画（2026-11-25 用户嫌点进来先空白）：60 秒内读过的 cupList（「我的」页卡片刚读过）优先，
  // 没有就用积分榜存在本机的上次结果（cache_cup_board，只认同一账号）；云端读完再静默更正
  early() {
    try {
      const myId = (db.cachedOpenid && db.cachedOpenid()) || '';
      if (!myId) return;
      let r = cloud.peek ? cloud.peek('cupList') : undefined;
      if (!r) { const c = wx.getStorageSync && wx.getStorageSync('cache_cup_board'); r = c && c.uid === myId && c.r && Array.isArray(c.r.list) ? c.r : null; }
      if (!r) return;
      this.apply(r, (db.cachedPlayersFull && db.cachedPlayersFull()) || [], myId);
      this.drawn = true;
      this.setData({ loading: false });
    } catch (e) { console.warn('[我的积分] 本机结果画不出来，等云端', e); }
  },
  onPullDownRefresh() {
    memo.invalidate(); // 下拉刷新：不用内存缓存，管理员刚更正 / 撤下的马上看到
    this.load().then(() => wx.stopPullDownRefresh());
  },
  async load() {
    const seq = this.seq = (this.seq || 0) + 1; // 连续刷新只认最后一次
    try {
      const [r, players, myId] = await Promise.all([cloud.cached('cupList'), db.playersShared(), db.myOpenid()]);
      if (seq !== this.seq) return;
      this.apply(r, players, myId);
      this.drawn = true;
    } catch (e) {
      if (seq !== this.seq) return;
      console.warn(e.message);
      // 已经画过（本机的上次结果）：保留画面，只轻提示
      if (this.drawn) wx.showToast({ title: '积分没有更新，下拉刷新再试', icon: 'none' });
      else this.setData({ error: '积分没有读取成功，下拉刷新再试一次' });
    }
    if (this.data.loading) this.setData({ loading: false });
  },
  apply(r, players, myId) {
    this.list = (r && r.list) || [];
    this.prof = db.profilesOf(players || []);
    this.myId = myId || '';
    this.mineOf = {}; // 按年度缓存 C.mine 的结果：切换单打 / 双打、年度时不重算
    // 年份：我拿过积分的年份 + 今年 + 当前选中的（从卡片带过来的），新的在前
    const mine = C.myYears(this.list, this.myId);
    const set = {};
    mine.concat([C.thisYear(), this.data.year]).forEach((y) => { if (y) set[y] = 1; });
    const years = Object.keys(set).map(Number).sort((a, b) => b - a);
    const me = this.prof[this.myId];
    this.render({ years, error: '', meHidden: !!me && me.shown !== true && mine.length > 0 });
  },
  // 搭档：同意了公开展示（或者是自己）才显示名字，否则「球友」
  nameOf(id) {
    const p = this.prof[id];
    if (!p || (id !== this.myId && p.shown !== true)) return '球友';
    return p.name || '球友';
  },
  // extra：和这次渲染一起 setData 的其他字段（切换时的 which / year、读取后的 years 等）
  render(extra) {
    const d = Object.assign({ which: this.data.which, year: this.data.year }, extra);
    const cache = this.mineOf || (this.mineOf = {});
    const m = cache[d.year] || (cache[d.year] = C.mine(this.list || [], this.myId, d.year));
    const cur = m[d.which];
    const sources = cur.groups.flatMap((g) => g.sources).sort((a, b) => b.date.localeCompare(a.date));
    const items = sources.map((s, i) => ({
      i, stopId: s.stopId, date: s.date.slice(5), kind: C.stopKindText(s), format: C.formatText(s.format), tier: C.tierText(s.tier),
      champion: s.tier === 'champion', counted: (s.pointGroup || 'open') === cur.pointGroup,
      partner: s.team ? s.team.filter((id) => id !== this.myId).map((id) => this.nameOf(id)).join(' / ') : '',
      base: num(s.base), bonus: s.bonus ? num(s.bonus) : '', bonusText: s.bonusText, total: num(s.total),
      split: s.split ? `一队 ${num(s.teamBase)} 分，两人平分` : '',
    }));
    this.setData(Object.assign({}, extra, {
      sum: { total: num(cur.total), stops: cur.stops, champions: cur.champions },
      bestGroup: d.which !== 'encounter' && cur.stops ? C.pointGroupText(cur.pointGroup) : '',
      groupTotals: cur.groups.length > 1 ? cur.groups.map((g) => ({ name: C.pointGroupText(g.pointGroup), total: num(g.total) })) : [],
      items,
    }));
  },
  setWhich(e) { const which = e.currentTarget.dataset.v; this.render({ which, whichText: WHICH_TEXT[which] }); },
  setYear(e) { this.render({ year: Number(e.currentTarget.dataset.v) }); },
  openShown() { wx.navigateTo({ url: '/pages/profile/profile' }); },
});
