const db = require('../../utils/db');
const E = require('../../utils/event');

// 我和这个活动的关系（按用户 ID）：我发起 / 已报名 / 参赛中 / 已结束
function roleOf(d, myId, signed) {
  if (!myId) return null;
  const owner = d._openid === myId;
  const entrant = Object.keys(d.uidOf || {}).some((n) => d.uidOf[n] === myId) || (d.status !== 'signup' && signed[d._id]);
  if (!owner && !signed[d._id] && !entrant) return null;
  return { owner, signed: !!signed[d._id], entrant: !!entrant };
}

function toView(d, matches, myId, signed) {
  const isG = d.mode === 'groups';
  const signing = d.status === 'signup';
  const cfg = E.cfgOf(d);
  let champion = '', progress = '', finished = false;
  if (!signing) {
    const p = E.progressOf(d, matches);
    champion = p.champion;
    finished = !!champion || (p.total > 0 && p.done === p.total);
    if (!champion) progress = p.total && p.done === p.total ? `全部 ${p.total} 场已完赛` : `已完成 ${p.done}/${p.total} 场`;
  }
  const role = roleOf(d, myId, signed);
  const roleTags = [];
  if (role) {
    if (role.owner) roleTags.push('我发起');
    if (signing && role.signed) roleTags.push('已报名');
    if (!signing && role.entrant) roleTags.push(finished ? '已结束' : '参加中');
    else if (!signing && finished && role.owner) roleTags.push('已结束');
  }
  return {
    _id: d._id, signing, mine: !!role, roleTags,
    title: d.title,
    modeText: d.mode === 'groups_ko' ? `${E.MODES.groups_ko} · ${d.groupCount} 组` : isG ? `${E.MODES.groups} · ${d.groupCount} 组` : `${E.MODES.bracket} · ${d.size} 签`,
    typeText: (E.categoryText(d) && E.categoryOf(d) !== 'mixed' ? E.categoryText(d) : '') + (E.categoryOf(d) === 'mixed' ? '混双' : cfg.type === 'double' ? '双打' : '单打'),
    count: (d.entrants || []).length,
    unit: cfg.type === 'double' ? '队' : '人',
    seeds: (d.seeds || []).length,
    date: d.date || '',
    champion, progress, isG,
  };
}

Page({
  data: { list: [], shown: [], loading: true, tab: 'all', mineCount: 0, cal: null, canPublish: false },
  onLoad() { this.draws = db.cachedDraws(); this.matches = db.cachedMatches(); this.render(); },
  onShow() { this.load(); },
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    this.load().then(() => wx.stopPullDownRefresh()); },
  render() {
    const signed = {};
    (this.signups || []).forEach((s) => { signed[s.drawId] = 1; });
    // 先按活动把比赛分好组，每个活动只看自己的比赛（不用每个活动都扫一遍全部战绩）
    const byDraw = {};
    (this.matches || []).forEach((m) => { if (m.drawId) (byDraw[m.drawId] = byDraw[m.drawId] || []).push(m); });
    const list = (this.draws || []).map((d) => toView(d, byDraw[d._id] || [], this.myId, signed));
    this.list = list;
    this.setData({ mineCount: list.filter((x) => x.mine).length });
    this.apply();
  },
  apply() {
    if (this.data.tab === 'cal') { this.applyCal(); return; }
    this.setData({ shown: this.data.tab === 'mine' ? this.list.filter((x) => x.mine) : this.list });
  },
  setTab(e) { this.setData({ tab: e.currentTarget.dataset.v }); this.apply(); },

  /* ---------- 日历：按月看活动（按活动日期），点某一天只看那天的 ---------- */
  applyCal() {
    const p2 = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const today = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
    if (!this.calYm) this.calYm = today.slice(0, 7);
    const ym = this.calYm, y = Number(ym.slice(0, 4)), mo = Number(ym.slice(5, 7));
    const inMonth = (this.list || []).filter((x) => (x.date || '').indexOf(ym) === 0);
    const byDay = {};
    inMonth.forEach((x) => { const r = byDay[x.date] || (byDay[x.date] = { n: 0, mine: false }); r.n++; if (x.mine) r.mine = true; });
    if (this.calDay && this.calDay.indexOf(ym) !== 0) this.calDay = '';
    const cells = [];
    const lead = (new Date(y, mo - 1, 1).getDay() + 6) % 7; // 周一排第一列
    for (let i = 0; i < lead; i++) cells.push({ k: 'b' + i, d: '' });
    const days = new Date(y, mo, 0).getDate();
    for (let d = 1; d <= days; d++) {
      const date = `${ym}-${p2(d)}`, r = byDay[date];
      cells.push({ k: date, d, date, n: r ? r.n : 0, mine: !!(r && r.mine), today: date === today, on: date === this.calDay });
    }
    const shown = inMonth.filter((x) => !this.calDay || x.date === this.calDay).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    this.setData({
      shown,
      cal: { title: `${y} 年 ${mo} 月`, cells, count: inMonth.length, day: this.calDay ? `${Number(this.calDay.slice(5, 7))} 月 ${Number(this.calDay.slice(8, 10))} 日` : '' },
    });
  },
  calMove(e) {
    const step = Number(e.currentTarget.dataset.v);
    const d = new Date(Number(this.calYm.slice(0, 4)), Number(this.calYm.slice(5, 7)) - 1 + step, 1);
    this.calYm = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    this.calDay = '';
    this.applyCal();
  },
  calToday() { this.calYm = ''; this.calDay = ''; this.applyCal(); },
  calPick(e) {
    const date = e.currentTarget.dataset.date;
    if (!date) return;
    this.calDay = this.calDay === date ? '' : date; // 再点一次取消
    this.applyCal();
  },
  async load() {
    try {
      const [list, matches, myId, signups, member] = await Promise.all([
        db.drawsShared(), db.matchesShared().catch(() => db.cachedMatches()), db.myOpenid().catch(() => ''), db.fetchMySignups().catch(() => []), // 活动、比赛用共享数据（只读）
        // 「创建活动」按钮只决定显示（创建页打开时实时校验身份，云函数也会校验）：用 60 秒缓存，不每次切 tab 都调云函数
        require('../../utils/member').statusCached().catch(() => null),
      ]);
      const canPublish = !!member && member.status === 'active' && !!member.isAdmin;
      if (canPublish !== this.data.canPublish) this.setData({ canPublish });
      // 数据和上次一样（切换 tab、从子页面返回、缓存命中）就不重算、不重新渲染：活动、比赛比较引用，我的报名（很少）比较内容
      const sig = JSON.stringify([myId, signups]);
      if (list !== this.draws || matches !== this.matches || sig !== this.sig) {
        this.sig = sig;
        this.draws = list; this.matches = matches; this.myId = myId; this.signups = signups;
        this.render();
      }
    } catch (e) {
      this.setData({ canPublish: false });
      console.error(e);
      wx.showToast({ title: '网络异常，显示的是缓存数据', icon: 'none' });
    }
    if (this.data.loading) this.setData({ loading: false });
  },
  goNew() { if (!this.data.canPublish) return; wx.navigateTo({ url: '/pages/draw-new/draw-new' }); },
  open(e) { wx.navigateTo({ url: '/pages/draw-view/draw-view?id=' + e.currentTarget.dataset.id }); },
});
