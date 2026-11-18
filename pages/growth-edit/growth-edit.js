// 成长档案 · 新增 / 编辑一条私人比赛记录（只有本人可见）。
//   比分用记分组件录入（utils/rules.js 校验），胜负由比分算出；备注只能从固定标签里选，没有文字输入。
//   保存、删除都经云函数，云端按本人 OPENID 校验记录归属（utils/archive.js）。
const A = require('../../utils/archive');
const G = require('../../utils/growth');
const R = require('../../utils/rules');

const pad = (n) => (n < 10 ? '0' + n : '' + n);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const CFG_KEY = 'growth_rules'; // 记住上次用的局制，只是本机的输入习惯

Page({
  data: {
    id: '', ready: false, error: '', today: '', date: '', type: 'single', kind: 'practice',
    rule: { setGames: 4, noAd: true, bestOf: 1 }, init: [], tags: [], tagOpts: [],
    check: { ok: false, msg: '请填写比分' }, saving: false, removing: false,
    TYPES: G.TYPES, KINDS: G.KINDS, maxTags: G.MAX_TAGS,
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
    A.list().then((list) => {
      const r = list.find((x) => x.id === id);
      if (!r) { this.setData({ error: '记录不存在，可能已被删除' }); return; }
      this.setData({
        date: r.date, type: r.type, kind: r.kind, tags: r.tags || [],
        rule: { setGames: r.setGames === 6 ? 6 : 4, noAd: r.noAd !== false, bestOf: r.bestOf === 3 ? 3 : 1 },
        init: r.sets || [], ready: true,
      });
      this.refreshTags();
    }).catch((e) => this.setData({ error: e.message || '读取失败' }));
  },

  refreshTags() {
    const on = this.data.tags;
    this.setData({ tagOpts: G.NOTE_TAGS.map((t) => ({ t, on: on.indexOf(t) >= 0 })) });
  },

  onDate(e) { this.setData({ date: e.detail.value }); },
  setType(e) { this.setData({ type: e.currentTarget.dataset.v }); },
  setKind(e) { this.setData({ kind: e.currentTarget.dataset.v }); },
  onRule(e) { this.setData({ rule: e.detail }); },
  onSets(e) { this.res = e.detail; this.setData({ check: this.resultOf(e.detail) }); },
  resultOf(res) {
    if (!res.ok) return { ok: false, msg: res.msg };
    return { ok: true, win: res.winner === 'a', msg: `盘分 ${res.won.a}:${res.won.b}，${res.winner === 'a' ? '我赢了' : '我输了'}` };
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
    const c = G.clean({
      date: d.date, type: d.type, kind: d.kind, setGames: d.rule.setGames, noAd: d.rule.noAd, bestOf: d.rule.bestOf,
      sets: this.res.ok ? this.res.sets : [], tags: d.tags,
    }, d.today);
    if (!c.ok) { wx.showToast({ title: this.res.ok ? c.msg : (this.res.msg || c.msg), icon: 'none' }); return; }
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
