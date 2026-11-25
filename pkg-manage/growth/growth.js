// 成长档案（只有本人可见）：私人比赛记录的统计、最近 6 个月走势和记录列表；另列一块正式战绩的摘要。
//   私人记录和正式战绩分开统计，不相加：正式战绩的数字和排行榜、球员主页同一个口径（utils/player.js）。
//   私人记录只经云函数按本人 OPENID 读写（utils/archive.js），这里没有任何查看别人档案的入口。
const A = require('../../utils/archive');
const G = require('../../utils/growth');
const db = require('../../utils/db');
const PV = require('../../utils/player');

const pad = (n) => (n < 10 ? '0' + n : '' + n);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

function rowOf(r) {
  return {
    id: r.id, date: r.date, md: r.date.slice(5).replace('-', '/'),
    type: G.TYPES[r.type] || '', kind: r.points11 ? '练习赛 · 抢11分' : (G.KINDS[r.kind] || ''), formal: r.kind === 'formal',
    win: r.result === 'win', score: G.scoreText(r), tags: r.tags || [],
  };
}
// 按月分组：[{ ym, label, rows, sum }]
function groupByMonth(list) {
  const out = [], at = {};
  list.forEach((r) => {
    const ym = r.date.slice(0, 7);
    if (!at[ym]) { at[ym] = { ym, label: `${ym.slice(0, 4)} 年 ${Number(ym.slice(5))} 月`, rows: [], win: 0 }; out.push(at[ym]); }
    at[ym].rows.push(rowOf(r));
    if (r.result === 'win') at[ym].win++;
  });
  out.forEach((g) => { g.sum = `${g.rows.length} 场 · ${g.win} 胜 ${g.rows.length - g.win} 负`; });
  return out;
}
const diffText = (a, b) => (a === b ? '和上月持平' : a > b ? `比上月多 ${a - b} 场` : `比上月少 ${b - a} 场`);

// 正式战绩摘要（只读，和球员主页一致）
// 用这次读到的内存结果（共享版，只读）：本机缓存是异步写的，读完马上同步读 cachedProfiles / cachedPlayersFull / cachedMatches 可能还是空的
function officialOf(myId, t, players, matches) {
  const v = PV.playerView(db.profilesOf(players), players, matches, myId);
  if (!v.profile) return null;
  const c = v.career, ym = t.slice(0, 7);
  const month = v.rows.filter((r) => r.outcome === 'normal' && r.date.slice(0, 7) === ym).length;
  const pct = (x) => (x.played ? Math.round((x.win / x.played) * 100) + '%' : '—');
  return {
    played: c.played, win: c.win, lose: c.lose, rate: c.played ? c.rate + '%' : '—', month,
    single: `${c.single.played} 场 · 胜率 ${pct(c.single)}`, double: `${c.double.played} 场 · 胜率 ${pct(c.double)}`,
  };
}

Page({
  data: { loading: true, error: '', has: false, s: null, groups: [], official: null, monthDiff: '', clearing: false },

  onLoad() { wx.hideShareMenu(); }, // 私人档案不能分享
  // 先画后更正（2026-11-25 用户嫌从「我的」点进来先空白）：私人记录只用 60 秒内存里的（「我的」页刚读过，A.peek），
  // 不写也不读本机存储；正式战绩摘要先用本机缓存算；之后照常读云端静默更正
  early() {
    const t = today();
    const list = A.peek ? A.peek() : null;
    if (list) this.show(list, t);
    try {
      const myId = (db.cachedOpenid && db.cachedOpenid()) || '';
      if (myId && !this.data.official && db.cachedPlayersFull && db.cachedMatches) {
        const official = officialOf(myId, t, db.cachedPlayersFull() || [], db.cachedMatches() || []);
        if (official) this.setData({ official });
      }
    } catch (e) { console.warn('[成长档案] 本机战绩算不出摘要，等云端', e); }
  },
  onShow() { this.early(); this.load(); },
  onPullDownRefresh() {
    require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    this.load().then(() => wx.stopPullDownRefresh());
  },
  show(raw, t) {
    const list = raw.filter((r) => G.validDate(r.date)).sort((x, y) => y.date.localeCompare(x.date) || y.createdAt - x.createdAt);
    const s = G.summary(list, t);
    this.drawn = true; // 画过有效内容：之后刷新失败不冲成整页报错
    this.setData({
      loading: false, error: '', has: list.length > 0, s,
      monthDiff: diffText(s.thisMonth.played, s.lastMonth.played),
      groups: groupByMonth(list),
    });
  },

  async load() {
    const t = today();
    const seq = this.loadSeq = (this.loadSeq || 0) + 1; // onShow 和下拉刷新同时读：只认最后一次，旧结果不盖新结果
    // 正式战绩只是附带的摘要：失败不影响私人记录
    const official = Promise.all([db.myOpenid(), db.playersShared(), db.matchesShared()])
      .then(([myId, players, matches]) => { if (seq === this.loadSeq) this.setData({ official: officialOf(myId, t, players, matches) }); })
      .catch((e) => console.warn('正式战绩读取失败', e.message));
    try {
      const list = await A.list();
      if (seq !== this.loadSeq) return;
      this.show(list, t);
    } catch (e) {
      if (seq !== this.loadSeq) return;
      // 已经画过（内存里刚读过的或之前读到的）：保留着，只轻提示；从来没画出来过才整页显示读取失败
      if (this.drawn) wx.showToast({ title: e.message || '网络异常，显示的是上次的记录', icon: 'none' });
      else this.setData({ loading: false, error: e.message || '读取失败' });
    }
    await official;
  },

  add() { wx.navigateTo({ url: '/pkg-manage/growth-edit/growth-edit' }); },
  open(e) { wx.navigateTo({ url: '/pkg-manage/growth-edit/growth-edit?id=' + encodeURIComponent(e.currentTarget.dataset.id) }); },
  retry() { this.setData({ loading: true, error: '' }); this.load(); },
  goHistory() {
    db.myOpenid().then((uid) => wx.navigateTo({ url: '/pkg-manage/history/history?uid=' + encodeURIComponent(uid) })).catch(() => {});
  },

  // 清除本人的全部私人记录（两次确认；正式战绩不受影响）
  clearAll() {
    if (this.data.clearing) return;
    wx.showModal({
      title: '清除全部私人记录？',
      content: '会永久删除你在成长档案里记录的全部比赛，无法恢复。正式战绩、排行和等级不受影响。',
      confirmText: '清除', confirmColor: '#b34d4d',
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ clearing: true });
        A.clear().then((n) => {
          wx.showToast({ title: `已清除 ${n} 条`, icon: 'none' });
          this.drawn = false; // 清除后读不到：不留着已清除的记录
          return this.load();
        }).catch((e) => wx.showToast({ title: e.message || '清除失败', icon: 'none' }))
          .then(() => this.setData({ clearing: false }));
      },
    });
  },
});
