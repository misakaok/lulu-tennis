// 成长档案 · 新增 / 编辑一条私人比赛记录（只有本人可见）。
//   比分用记分组件录入（utils/rules.js 校验），胜负由比分算出；备注只能从固定标签里选，没有文字输入。
//   保存、删除都经云函数，云端按本人 OPENID 校验记录归属（utils/archive.js）。
const A = require('../../utils/archive');
const G = require('../../utils/growth');
const R = require('../../utils/rules');

const pad = (n) => (n < 10 ? '0' + n : '' + n);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const CFG_KEY = 'growth_rules'; // 记住上次用的局制，只是本机的输入习惯
const pointsValue = (s) => /^\d+$/.test(s) ? Number(s) : NaN;

Page({
  data: {
    id: '', ready: false, error: '', today: '', date: '', type: 'single', kind: 'practice',
    rule: { setGames: 4, noAd: true, bestOf: 1 }, init: [], tags: [], tagOpts: [],
    points11: false, points: { a: '', b: '' },
    check: { ok: false, msg: '请填写比分' }, saving: false, removing: false,
    maxTags: G.MAX_TAGS,
  },

  onLoad(o) {
    wx.hideShareMenu();
    const id = decodeURIComponent((o && o.id) || '');
    const t = today();
    this.res = { ok: false, msg: '请填写比分' };
    if (!id) {
      let last = {};
      try { last = wx.getStorageSync(CFG_KEY) || {}; } catch (e) {}
      const cfg = R.normCfg(last);
      this.setData({ today: t, date: t, rule: { setGames: cfg.setGames, noAd: cfg.noAd, bestOf: last.bestOf === 3 ? 3 : 1 }, ready: true });
      this.refreshTags();
      return;
    }
    wx.setNavigationBarTitle({ title: '编辑记录' });
    this.setData({ id, today: t });
    // 从成长档案点进来：60 秒内存里刚读过的列表（A.peek，不读本机存储）里有这条就直接填好，不等云端
    const pre = A.peek ? A.peek() : null;
    const hit = pre && pre.find((x) => x.id === id);
    if (hit) { this.fill(hit); return; }
    A.list().then((list) => {
      const r = list.find((x) => x.id === id);
      if (!r) { this.setData({ error: '记录不存在，可能已被删除' }); return; }
      this.fill(r);
    }).catch((e) => this.setData({ error: e.message || '读取失败' }));
  },
  fill(r) {
    const points11 = r.points11 === true;
    const score = points11 && r.sets && r.sets[0];
    this.setData({
      date: r.date, type: r.type, kind: r.kind, tags: r.tags || [],
      rule: { setGames: r.setGames === 6 ? 6 : 4, noAd: r.noAd !== false, bestOf: r.bestOf === 3 ? 3 : 1 },
      points11, points: score ? { a: String(score.a), b: String(score.b) } : { a: '', b: '' },
      init: points11 ? [] : r.sets || [], ready: true,
    });
    this.refreshTags();
    this.refreshCheck();
  },

  refreshTags() {
    const on = this.data.tags;
    this.setData({ tagOpts: G.NOTE_TAGS.map((t) => ({ t, on: on.indexOf(t) >= 0 })) });
  },

  onDate(e) { this.setData({ date: e.detail.value }); },
  setType(e) { this.setData({ type: e.currentTarget.dataset.v }); },
  setKind(e) {
    const kind = e.currentTarget.dataset.v;
    this.setData({ kind, points11: kind === 'practice' && this.data.points11 });
    this.refreshCheck();
  },
  setPointsMode(e) {
    this.setData({ points11: this.data.kind === 'practice' && e.currentTarget.dataset.v === 'points' });
    this.refreshCheck();
  },
  onPoints(e) {
    const points = Object.assign({}, this.data.points, { [e.currentTarget.dataset.side]: e.detail.value });
    this.setData({ points });
    this.refreshCheck();
  },
  onRule(e) { this.setData({ rule: e.detail }); },
  onSets(e) { this.res = e.detail; this.refreshCheck(); },
  scoreResult() {
    if (!this.data.points11) return this.res;
    const { a, b } = this.data.points;
    return G.checkPoints11([{ a: pointsValue(a), b: pointsValue(b) }]);
  },
  refreshCheck() {
    const res = this.scoreResult();
    if (!res.ok) { this.setData({ check: { ok: false, msg: res.msg } }); return; }
    const win = res.winner === 'a';
    const result = win ? '我赢了' : '我输了';
    const msg = this.data.points11 ? result : `盘分 ${res.won.a}:${res.won.b}，${result}`;
    this.setData({ check: { ok: true, win, msg } });
  },
  toggleTag(e) {
    const t = e.currentTarget.dataset.t, tags = this.data.tags.slice(), i = tags.indexOf(t);
    if (i >= 0) tags.splice(i, 1);
    else if (tags.length >= G.MAX_TAGS) { wx.showToast({ title: `最多选 ${G.MAX_TAGS} 个`, icon: 'none' }); return; }
    else tags.push(t);
    this.setData({ tags });
    this.refreshTags();
  },

  async save() {
    if (this.data.saving) return;
    const d = this.data;
    const res = this.scoreResult();
    if (!res.ok) { wx.showToast({ title: res.msg, icon: 'none' }); return; }
    const c = G.clean({
      date: d.date, type: d.type, kind: d.kind, setGames: d.rule.setGames, noAd: d.rule.noAd, bestOf: d.rule.bestOf,
      points11: d.points11, sets: res.sets, tags: d.tags,
    }, d.today);
    if (!c.ok) { wx.showToast({ title: c.msg, icon: 'none' }); return; }
    this.setData({ saving: true });
    try {
      await A.save(d.id, c.rec);
      try { wx.setStorageSync(CFG_KEY, d.rule); } catch (e) {}
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 500);
    } catch (e) {
      wx.showToast({ title: e.message || '保存失败', icon: 'none' });
      this.setData({ saving: false });
    }
  },

  remove() {
    if (!this.data.id || this.data.removing) return;
    wx.showModal({
      title: '删除这条记录？', content: '删除后无法恢复，统计会同步更新。', confirmText: '删除', confirmColor: '#b34d4d',
      success: (r) => {
        if (!r.confirm) return;
        this.setData({ removing: true });
        A.remove(this.data.id).then(() => {
          wx.showToast({ title: '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack(), 500);
        }).catch((e) => { wx.showToast({ title: e.message || '删除失败', icon: 'none' }); this.setData({ removing: false }); });
      },
    });
  },
});
