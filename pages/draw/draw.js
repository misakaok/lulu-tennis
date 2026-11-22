const db = require('../../utils/db');
const E = require('../../utils/event');
const NX = require('../../utils/next-match');

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
  // 我和活动的关系（状态另外显示在右上角，这里不再重复「已结束」）
  const roleTags = [];
  if (role) {
    if (role.owner) roleTags.push('我发起');
    if (signing && role.signed) roleTags.push('已报名');
    if (!signing && role.entrant) roleTags.push(finished ? '参加过' : '参加中');
  }
  const modeText = d.mode === 'groups_ko' ? `${E.MODES.groups_ko} · ${d.groupCount} 组` : isG ? `${E.MODES.groups} · ${d.groupCount} 组` : `${E.MODES.bracket} · ${d.size} 签`;
  const typeText = (E.categoryText(d) && E.categoryOf(d) !== 'mixed' ? E.categoryText(d) : '') + (E.categoryOf(d) === 'mixed' ? '混双' : cfg.type === 'double' ? '双打' : '单打');
  const meta = [modeText, typeText];
  if (E.levelRangeText(d)) meta.push('建议水平 ' + E.levelRangeText(d)); // 没设置（含旧活动）整项不显示
  if (!signing) meta.push(`${(d.entrants || []).length} ${cfg.type === 'double' ? '队' : '人'}`);
  if ((d.seeds || []).length) meta.push(cfg.type === 'double' ? `种子队伍 ${d.seeds.length} 支` : `种子选手 ${d.seeds.length} 位`);
  return {
    _id: d._id, signing, mine: !!role, roleTags,
    title: d.title,
    meta: meta.map((x) => x.replace(/ /g, '\u00a0')).join(' · '), // 每一项内部用不换行空格：只在项与项之间换行，「2 个」不会拆开
    date: d.date || '',
    day: dayOf(d.date),
    status: signing ? { text: '报名中', cls: 'lime' } : finished ? { text: '已结束', cls: '' } : { text: '进行中', cls: 'solid' },
    st: signing ? 'sign' : finished ? 'done' : 'play', // 日期块色带：报名中黄绿 / 进行中淡紫 / 已结束灰
    champion, progress, isG,
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

Page({
  data: { list: [], shown: [], loading: true, tab: 'all', mineCount: 0, next: null, nextStale: false, canPublish: false },
  onLoad() { this.draws = db.cachedDraws(); this.matches = db.cachedMatches(); this.render(); },
  onShow() {
    // 刚删除了活动：先从手上的列表里去掉马上显示，再在后台重新读取
    const kept = db.withoutRemoved(this.draws);
    if (kept !== this.draws) { this.draws = kept; this.render(); }
    this.load();
  },
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
    // 我的下一场：录分、改时间场地之后活动 / 战绩会重新读到新数组，这里跟着重算
    this.today = NX.todayOf();
    this.setData({ mineCount: list.filter((x) => x.mine).length, next: NX.nextMatch(this.draws, this.matches, this.myId, this.signups, this.today) });
    this.apply();
  },
  apply() {
    const tab = this.data.tab;
    this.setData({ shown: tab === 'all' ? this.list : tab === 'mine' ? this.list.filter((x) => x.mine) : [] });
  },
  setTab(e) { this.setData({ tab: e.currentTarget.dataset.v }); this.apply(); },

  async load() {
    // 「我的下一场」要靠最新的战绩、我的身份和我的报名算：其中任何一项没读到（用了缓存或空值），算出来的就可能不对，
    // 这时在「我的下一场」里提示网络异常，不直接说「暂无下一场」
    let stale = false;
    const soft = (p, fallback) => p.catch(() => { stale = true; return fallback(); });
    try {
      const [list, matches, myId, signups, member] = await Promise.all([
        db.drawsShared(), soft(db.matchesShared(), () => db.cachedMatches()), soft(db.myOpenid(), () => ''), soft(db.fetchMySignups(), () => []), // 活动、比赛用共享数据（只读）
        // 「创建活动」按钮只决定显示（创建页打开时实时校验身份，云函数也会校验）：用 60 秒缓存，不每次切 tab 都调云函数
        require('../../utils/member').statusCached().catch(() => null),
      ]);
      const canPublish = !!member && member.status === 'active' && !!member.isAdmin;
      if (canPublish !== this.data.canPublish) this.setData({ canPublish });
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
      this.setData({ canPublish: false });
      console.error(e);
      wx.showToast({ title: '网络异常，显示的是缓存数据', icon: 'none' });
    }
    if (stale !== this.data.nextStale) this.setData({ nextStale: stale });
    if (this.data.loading) this.setData({ loading: false });
  },
  goNew() { if (!this.data.canPublish) return; wx.navigateTo({ url: '/pages/draw-new/draw-new' }); },
  open(e) { wx.navigateTo({ url: '/pages/draw-view/draw-view?id=' + e.currentTarget.dataset.id }); },
  // 我的下一场 → 活动详情的「场次」页签，并定位到这一场（录分仍从那里的场次入口进）
  openNext() {
    const n = this.data.next;
    if (n) wx.navigateTo({ url: `/pages/draw-view/draw-view?id=${n.drawId}&tab=schedule&key=${encodeURIComponent(n.key)}` });
  },
});
