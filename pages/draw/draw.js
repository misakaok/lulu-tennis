const db = require('../../utils/db');
const E = require('../../utils/event');

// 我和这个赛事的关系（按用户 ID）：我发起 / 已报名 / 参赛中 / 已结束
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
    if (!signing && role.entrant) roleTags.push(finished ? '已结束' : '参赛中');
    else if (!signing && finished && role.owner) roleTags.push('已结束');
  }
  return {
    _id: d._id, signing, mine: !!role, roleTags,
    title: d.title,
    modeText: d.mode === 'groups_ko' ? `小组赛＋淘汰赛 · ${d.groupCount} 组` : isG ? `小组赛 · ${d.groupCount} 组` : `淘汰赛 · ${d.size} 签`,
    typeText: cfg.type === 'double' ? '双打' : '单打',
    count: (d.entrants || []).length,
    unit: cfg.type === 'double' ? '队' : '人',
    seeds: (d.seeds || []).length,
    date: d.date || '',
    champion, progress, isG,
  };
}

Page({
  data: { list: [], shown: [], loading: true, tab: 'all', mineCount: 0 },
  onLoad() { this.draws = db.cachedDraws(); this.matches = db.cachedMatches(); this.render(); },
  onShow() { this.load(); },
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },
  render() {
    const signed = {};
    (this.signups || []).forEach((s) => { signed[s.drawId] = 1; });
    const list = (this.draws || []).map((d) => toView(d, this.matches || [], this.myId, signed));
    this.list = list;
    this.setData({ mineCount: list.filter((x) => x.mine).length });
    this.apply();
  },
  apply() { this.setData({ shown: this.data.tab === 'mine' ? this.list.filter((x) => x.mine) : this.list }); },
  setTab(e) { this.setData({ tab: e.currentTarget.dataset.v }); this.apply(); },
  async load() {
    try {
      const [list, matches, myId] = await Promise.all([db.fetchDraws(), db.fetchMatches().catch(() => db.cachedMatches()), db.myOpenid().catch(() => '')]);
      this.draws = list; this.matches = matches; this.myId = myId;
      this.signups = myId ? await db.fetchMySignups().catch(() => []) : [];
      this.render();
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '网络异常，显示的是缓存数据', icon: 'none' });
    }
    this.setData({ loading: false });
  },
  goNew() { wx.navigateTo({ url: '/pages/draw-new/draw-new' }); },
  open(e) { wx.navigateTo({ url: '/pages/draw-view/draw-view?id=' + e.currentTarget.dataset.id }); },
});
