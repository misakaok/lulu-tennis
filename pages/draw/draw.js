const db = require('../../utils/db');
const E = require('../../utils/event');
const C = require('../../utils/cup');
const NX = require('../../utils/next-match');
const TL = require('../../utils/timeline');
const haptic = require('../../utils/haptic');
const PAGE = 30; // 活动列表每次显示多少个，滑到底再加载（和战绩页、排行页一样）

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
  let champion = '', progress = '', finished = false, progressPct = 0, progressShort = '';
  if (!signing) {
    const p = E.progressOf(d, matches);
    champion = p.champion;
    finished = !!champion || (p.total > 0 && p.done === p.total);
    if (!champion) progress = p.total && p.done === p.total ? `全部 ${p.total} 场已完赛` : `已完成 ${p.done}/${p.total} 场`;
    // 卡片底部的细进度条：已完成场数 / 总场数（没有场次、已出冠军的不画）
    if (!champion && p.total > 0) { progressPct = Math.round((p.done / p.total) * 100); progressShort = p.done + '/' + p.total + ' 场'; }
  }
  const role = roleOf(d, myId, signed);
  // 我和活动的关系（状态另外显示在右上角，这里不再重复「已结束」）
  const roleTags = [];
  if (role) {
    if (role.owner) roleTags.push('我发起');
    if (signing && role.signed) roleTags.push('已报名');
    if (!signing && role.entrant) roleTags.push(finished ? '参加过' : '参加中');
  }
  const modeText = E.isRotation(d) ? E.MODES.rotation : d.mode === 'groups_ko' ? `${E.MODES.groups_ko} · ${d.groupCount} 组` : isG ? `${E.MODES.groups} · ${d.groupCount} 组` : `${E.MODES.bracket} · ${d.size} 签`;
  const typeText = (E.categoryText(d) && E.categoryOf(d) !== 'mixed' ? E.categoryText(d) : '') + (E.categoryOf(d) === 'mixed' ? '混双' : cfg.type === 'double' ? '双打' : '单打');
  const meta = [modeText, E.isRotation(d) ? E.categoryText(d) : typeText].filter(Boolean); // 四人轮换名字里已经有「双打」
  if (E.levelRangeText(d)) meta.push('建议水平 ' + E.levelRangeText(d)); // 没设置（含旧活动）整项不显示
  if (!signing) meta.push(`${(d.entrants || []).length} ${cfg.type === 'double' && d.mode !== 'rotation' ? '队' : '人'}`);
  if ((d.seeds || []).length) meta.push(cfg.type === 'double' ? `种子队伍 ${d.seeds.length} 支` : `种子选手 ${d.seeds.length} 位`);
  return {
    _id: d._id, signing, mine: !!role, roleTags,
    cupTag: C.drawCupText(d), // LULU 积分活动：报名阶段就显示「LULU 积分 · 周赛」
    pinnedAt: Number(d.pinnedAt) || 0, // 置顶（管理员设置）：排在最前面，越晚置顶越靠前
    title: d.title,
    meta: meta.map((x) => x.replace(/ /g, '\u00a0')).join(' · '), // 每一项内部用不换行空格：只在项与项之间换行，「2 个」不会拆开
    date: d.date || '',
    day: dayOf(d.date),
    status: signing ? { text: '报名中', cls: 'lime' } : finished ? { text: '已结束', cls: '' } : { text: '进行中', cls: 'solid' },
    st: signing ? 'sign' : finished ? 'done' : 'play', // 日期块色带：报名中黄绿 / 进行中淡紫 / 已结束灰
    champion, progress, progressPct, progressShort, isG,
  };
}

// 左边日期块：大字日，小字月和星期；没有日期显示「待定」
const WEEK = '日一二三四五六';
function dayOf(date) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(date || '');
  if (!m) return { d: '待定', m: '', w: '' };
  const y = +m[1], mo = +m[2], dd = +m[3];
  return { d: String(dd), m: `${mo}月`, w: '周' + WEEK[new Date(y, mo - 1, dd).getDay()] };
}

const HERO_SLIDES = 3; // 顶部背景轮播张数（hero-court + hero-2 + hero-3）
const HERO_MS = 3000; // 每张停 3 秒（2026-11-23 用户嫌 4 秒慢）

Page({
  data: { list: [], shown: [], more: false, loading: true, undo: null, tab: 'all', mineCount: 0, next: null, nextStale: false, canPublish: false, slide: 0 },
  onLoad() {
    // 朋友圈单页模式：只显示固定介绍，不读缓存、不调云函数（见 utils/timeline.js）
    if (TL.isTimeline()) { this.timeline = true; this.setData({ timeline: true, loading: false }); return; }
    this.draws = db.cachedDraws(); this.matches = db.cachedMatches(); this.render();
    // 「创建活动」按钮先按本机记得的身份显示（24 小时内确认过的管理员），不等云端；load 里拿到身份后再更正
    const M = require('../../utils/member');
    if (M.knownActive() && M.isAdminLocal()) this.setData({ canPublish: true });
  },
  onShow() {
    if (this.timeline) return;
    this.heroStart();
    // 刚删除了活动：先从手上的列表里去掉马上显示，再在后台重新读取
    const kept = db.withoutRemoved(this.draws);
    if (kept !== this.draws) { this.draws = kept; this.render(); }
    this.showUndo();
    this.load();
  },
  // 刚删除了活动（5 分钟内）：顶部提示「已删除 · 撤回」，误删可以马上恢复（2026-11-24 用户要求）
  showUndo() {
    const r = db.recentRemoved();
    const undo = r ? { id: r.id, title: r.title } : null;
    if ((undo && undo.id) !== (this.data.undo && this.data.undo.id)) this.setData({ undo });
  },
  closeUndo() { db.dismissRemoved(); this.setData({ undo: null }); },
  async undoRemove() {
    const u = this.data.undo;
    if (!u || this.restoring) return;
    this.restoring = true;
    wx.showLoading({ title: '正在撤回', mask: true });
    try {
      await db.restoreDraw(u.id);
      wx.hideLoading();
      this.setData({ undo: null });
      wx.showToast({ title: '已撤回' });
      await this.load();
    } catch (e) {
      wx.hideLoading();
      wx.showModal({ title: '撤回失败', content: e.message || '请稍后再试', showCancel: false });
    } finally { this.restoring = false; }
  },
  onHide() { this.heroStop(); },
  onUnload() { this.heroStop(); },
  // 顶部背景轮播：3 张（0 = 底下固定的 hero-court），每 HERO_MS 换一张；切走页面就停，回来接着转；点小圆点直接切换并重新计时
  heroStart() {
    this.heroStop();
    this.heroTimer = setInterval(() => this.setData({ slide: (this.data.slide + 1) % HERO_SLIDES }), HERO_MS);
  },
  heroStop() { if (this.heroTimer) { clearInterval(this.heroTimer); this.heroTimer = null; } },
  pickSlide(e) {
    const i = Number(e.currentTarget.dataset.i);
    if (i !== this.data.slide) this.setData({ slide: i });
    this.heroStart();
  },
  onPullDownRefresh() { if (this.timeline) { wx.stopPullDownRefresh(); return; }
    require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    this.load().then(() => wx.stopPullDownRefresh()); },
  render() {
    const signed = {};
    (this.signups || []).forEach((s) => { signed[s.drawId] = 1; });
    // 先按活动把比赛分好组，每个活动只看自己的比赛（不用每个活动都扫一遍全部战绩）
    const byDraw = {};
    (this.matches || []).forEach((m) => { if (m.drawId) (byDraw[m.drawId] = byDraw[m.drawId] || []).push(m); });
    const list = (this.draws || []).map((d) => toView(d, byDraw[d._id] || [], this.myId, signed));
    // 置顶的排最前（越晚置顶越靠前），其余保持原来的顺序（按创建时间，新的在前）
    if (list.some((x) => x.pinnedAt)) list.sort((a, b) => b.pinnedAt - a.pinnedAt);
    this.list = list;
    // 我的下一场：录分、改时间场地之后活动 / 战绩会重新读到新数组，这里跟着重算
    this.today = NX.todayOf();
    this.setData({ mineCount: list.filter((x) => x.mine).length, next: NX.nextMatch(this.draws, this.matches, this.myId, this.signups, this.today) });
    this.apply();
  },
  // 只把前 limit 个交给渲染层：数据刷新（录分、报名后回来）保持已经加载的个数，切换选项卡从头开始
  apply() {
    const tab = this.data.tab;
    const all = tab === 'all' ? this.list : tab === 'mine' ? this.list.filter((x) => x.mine) : [];
    const limit = this.limit || PAGE;
    this.setData({ shown: all.slice(0, limit), more: all.length > limit });
  },
  setTab(e) { if (e.currentTarget.dataset.v !== this.data.tab) haptic.light(); this.limit = PAGE; this.setData({ tab: e.currentTarget.dataset.v }); this.apply(); },
  onReachBottom() {
    if (this.timeline || !this.data.more) return;
    this.limit = (this.limit || PAGE) + PAGE;
    this.apply();
  },

  async load() {
    // 「我的下一场」要靠最新的战绩、我的身份和我的报名算：其中任何一项没读到（用了缓存或空值），算出来的就可能不对，
    // 这时在「我的下一场」里提示网络异常，不直接说「暂无下一场」
    let stale = false;
    const soft = (p, fallback) => p.catch(() => { stale = true; return fallback(); });
    // 「创建活动」按钮只决定显示（创建页打开时实时校验身份，云函数也会校验）：用 60 秒缓存，不每次切 tab 都调云函数；
    // 单独更新，不等活动、战绩这些读完
    const showNew = require('../../utils/member').statusCached()
      .then((m) => !!m && m.status === 'active' && !!m.isAdmin, () => false)
      .then((v) => { if (v !== this.data.canPublish) this.setData({ canPublish: v }); });
    try {
      const [list, matches, myId, signups] = await Promise.all([
        db.drawsShared(), soft(db.matchesShared(), () => db.cachedMatches()), soft(db.myOpenid(), () => ''), soft(db.fetchMySignups(), () => []), // 活动、比赛用共享数据（只读）
      ]);
      // 数据和上次一样（切换 tab、从子页面返回、缓存命中）就不重算、不重新渲染：活动、比赛比较引用，我的报名（很少）比较内容
      const sig = JSON.stringify([myId, signups]);
      // 隔天再打开也要重算「我的下一场」（昨天的场次不再显示）
      if (list !== this.draws || matches !== this.matches || sig !== this.sig || NX.todayOf() !== this.today) {
        this.sig = sig;
        this.draws = list; this.matches = matches; this.myId = myId; this.signups = signups;
        this.render();
      }
    } catch (e) {
      stale = true;
      console.error(e);
      wx.showToast({ title: '网络异常，显示的是缓存数据', icon: 'none' });
    }
    if (stale !== this.data.nextStale) this.setData({ nextStale: stale });
    if (this.data.loading) this.setData({ loading: false });
    await showNew;
  },
  goNew() { if (!this.data.canPublish) return; wx.navigateTo({ url: '/pages/draw-new/draw-new' }); },
  // 点卡片先把活动详情请求发出去（页面切换动画期间并行读），详情页第一次读取直接接过来
  open(e) {
    const id = e.currentTarget.dataset.id;
    db.prefetchDrawDetail(id);
    wx.navigateTo({ url: '/pages/draw-view/draw-view?id=' + id });
  },
  // 我的下一场 → 活动详情的「场次」页签，并定位到这一场（录分仍从那里的场次入口进）
  openNext() {
    const n = this.data.next;
    if (!n) return;
    db.prefetchDrawDetail(n.drawId);
    wx.navigateTo({ url: `/pages/draw-view/draw-view?id=${n.drawId}&tab=schedule&key=${encodeURIComponent(n.key)}` });
  },
  // 右上角「转发给朋友」：只转发小程序首页，标题和封面固定（不带活动名称、人名等任何内容）；
  // 不是成员的人点开会被 utils/member.js 送到准入页，看不到数据
  onShareAppMessage() {
    return { title: 'LULU 网球 · 一起来打球', path: '/pages/draw/draw', imageUrl: '/images/share-home.jpg' };
  },
  // 「分享到朋友圈」：同样只分享首页、固定标题和封面（朋友圈缩略图是 1:1 方图）；
  // 朋友圈点开是单页模式，只显示上面的固定介绍，不读任何数据
  onShareTimeline() {
    return { title: 'LULU 网球 · 一起来打球', imageUrl: '/images/share-timeline.jpg' };
  },
});
