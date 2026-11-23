// LULU 积分：管理员补录 / 更正一站（比赛可能在其他平台打完，只录最终名次）。
//   球员只能从正式成员名单里选（listMembers，仅管理员）；单打按人、双打两人一队。
//   预览用 utils/cup.js（和云函数同一套计算），发布以云端按球员资料算出的结果为准。权限由云函数 cupSave 判断（ADMIN_OPENIDS）。
//   新建时生成这一站的编号：重复点保存 / 发布只更新同一站；更正时沿用原来那一站的编号
const cloud = require('../../utils/cloud');
const C = require('../../utils/cup');
const S = require('../../utils/stats');
const pick = require('../../utils/pick');

const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const newKey = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
const blank = (size) => Array.from({ length: size }, () => '');
const emptyPlaces = (size) => ({ champion: blank(size), runnerUp: blank(size), semis: [blank(size), blank(size)], floor: [] });

Page({
  data: {
    ok: false, authError: '', loading: true, busy: false, editing: false, published: false, fixes: 0,
    date: '', today: '', kind: 'weekly', format: 'single', kinds: C.KINDS, formats: [],
    opts: [], slots: [], hasFloor: true, preview: null, pointsNote: '',
  },

  async onLoad(options) {
    wx.hideShareMenu({ fail() {} });
    const t = todayStr();
    this.setData({ today: t, date: t });
    try {
      const ms = await require('../../utils/member').status();
      if (ms.status !== 'active' || !ms.isAdmin) { this.setData({ loading: false, authError: '只有管理员可以补录积分' }); return; }
      const [mem, list] = await Promise.all([cloud.call('listMembers'), options.id ? cloud.call('cupList') : null]);
      // 正式成员名单：设置过资料（有昵称）的才能选
      this.people = ((mem && mem.active) || []).filter((m) => m.uid && m.nickname)
        .map((m) => ({ uid: m.uid, name: m.nickname, gender: m.gender || '' }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      this.byUid = {};
      this.people.forEach((p) => { this.byUid[p.uid] = p; });
      this.setData({ opts: this.people.map((p) => p.name + (S.GENDER[p.gender] ? ' · ' + S.GENDER[p.gender] : '')) });
      if (options.id) {
        const s = ((list && list.list) || []).find((x) => x.id === options.id);
        if (!s) { this.setData({ loading: false, authError: '没找到这一站，可能已经删除' }); return; }
        this.key = s.id;
        this.places = JSON.parse(JSON.stringify(s.places));
        while (this.places.semis.length < C.MAX_SEMI) this.places.semis.push(blank(C.sizeOf(s.format)));
        this.setData({ editing: true, published: s.status === 'published', fixes: s.fixes || 0, date: s.date, kind: s.kind, format: s.format });
        wx.setNavigationBarTitle({ title: s.status === 'published' ? '更正积分' : '补录积分' });
      } else {
        this.key = newKey();
        this.places = emptyPlaces(1);
      }
      this.setData({ ok: true, authError: '', loading: false });
      this.render();
    } catch (e) {
      this.setData({ loading: false, authError: e.message || '身份校验失败，请返回后重试' });
    }
  },

  // 换类别 / 形式：每队人数变了就清空已选的名次；月赛没有参加保底
  setDate(e) { this.setData({ date: e.detail.value }); this.render(); },
  setKind(e) {
    this.change(e.currentTarget.dataset.v, this.data.format);
  },
  setFormat(e) { this.change(this.data.kind, e.currentTarget.dataset.v); },
  change(kind, format) {
    if (C.sizeOf(format) !== C.sizeOf(this.data.format)) this.places = emptyPlaces(C.sizeOf(format));
    if (!C.hasFloor(kind)) this.places.floor = [];
    this.setData({ kind, format });
    this.render();
  },

  pick(e) {
    const { slot, i, j } = e.currentTarget.dataset;
    const p = this.people[Number(e.detail.value)];
    if (!p) return;
    const row = slot === 'semis' || slot === 'floor' ? this.places[slot][Number(i)] : this.places[slot];
    row[Number(j)] = p.uid;
    this.render();
  },
  clearCell(e) {
    const { slot, i, j } = e.currentTarget.dataset;
    const row = slot === 'semis' || slot === 'floor' ? this.places[slot][Number(i)] : this.places[slot];
    row[Number(j)] = '';
    this.render();
  },
  addFloor() {
    if (this.places.floor.length >= C.MAX_FLOOR) return;
    this.places.floor.push(blank(C.sizeOf(this.data.format)));
    this.render();
  },
  removeFloor(e) { this.places.floor.splice(Number(e.currentTarget.dataset.i), 1); this.render(); },

  // 要提交的这一站：没选满的四强 / 保底空位不提交（四强可以少于 2 个）
  stop() {
    const full = (r) => r.every(Boolean);
    const some = (r) => r.some(Boolean);
    const p = this.places;
    return {
      date: this.data.date, kind: this.data.kind, format: this.data.format,
      places: {
        champion: p.champion, runnerUp: p.runnerUp,
        semis: p.semis.filter(some), floor: C.hasFloor(this.data.kind) ? p.floor.filter(some) : [],
      },
      partial: p.semis.concat(p.floor).some((r) => some(r) && !full(r)),
    };
  },

  render() {
    const size = C.sizeOf(this.data.format), kind = this.data.kind;
    const nm = (uid) => (uid && this.byUid[uid] ? this.byUid[uid].name : uid ? '已不是正式成员' : '');
    const cells = (row, slot, i) => row.map((uid, j) => ({ j, uid, name: nm(uid), slot, i }));
    const pt = C.POINTS[kind];
    const p = this.places;
    const slots = [
      { id: 'c', slot: 'champion', i: 0, label: '冠军', pts: pt.champion, cells: cells(p.champion, 'champion', 0) },
      { id: 'r', slot: 'runnerUp', i: 0, label: '亚军', pts: pt.runnerUp, cells: cells(p.runnerUp, 'runnerUp', 0) },
    ].concat(p.semis.map((row, i) => ({ id: 's' + i, slot: 'semis', i, label: '四强', pts: pt.semi, cells: cells(row, 'semis', i) })))
      .concat(C.hasFloor(kind) ? p.floor.map((row, i) => ({ id: 'f' + i, slot: 'floor', i, label: '参加保底', pts: pt.floor, cells: cells(row, 'floor', i), removable: true })) : []);
    // 预览：和云函数同一套校验和计算；女生夺冠奖励按名单里的性别（发布时云端按球员资料重新算）
    const s = this.stop();
    const c = C.cleanStop(s, this.data.today);
    let preview;
    if (s.partial) preview = { error: `有一${size === 1 ? '位' : '队'}没选满，选满或清空后才能预览` };
    else if (!c.ok) preview = { error: c.error };
    else {
      const lines = C.results(c.rec, (uid) => (this.byUid[uid] || {}).gender || '').map((x, k) => ({
        k, tier: C.tierText(x.tier), base: x.split ? C.pointsText(x) : x.base, bonus: x.bonus, bonusText: x.bonusText, total: x.total,
        names: x.ids.map(nm).join(' / ') + (x.team ? `（和 ${x.team.filter((id) => x.ids.indexOf(id) < 0).map(nm).join(' / ')}）` : ''),
      }));
      preview = { lines, board: C.boardOfStop(c.rec) === 'encounter' ? '遭遇赛单独统计，不进年终榜' : `计入 ${c.rec.year} 年${C.formatText(c.rec.format)}年终榜` };
    }
    const fem = pt.femaleChampion && this.data.format === 'single' ? `，女生夺冠额外 +${pt.femaleChampion}` : '';
    this.setData({
      slots, preview, hasFloor: C.hasFloor(kind), size,
      formats: C.FORMATS,
      pointsNote: `${C.kindText(kind)}：冠军 ${pt.champion} · 亚军 ${pt.runnerUp} · 四强 ${pt.semi}${C.hasFloor(kind) ? ` · 参加保底 ${pt.floor}` : ' · 没有参加保底分'}${fem}${this.data.format === 'double' ? '；双打两人平分（例如保底 5 分每人 2.5），不加女生奖励' : ''}`,
    });
  },

  // 撤下一站 / 删除草稿：原因从固定选项里选，确认后软删除（留档，成员看不到、不进榜）
  async removeStop() {
    if (this.data.busy || !this.data.editing) return;
    const what = this.data.published ? '撤下这一站' : '删除这份草稿';
    const reason = await pick.reason('cup', this.data.published ? '撤下原因（会留档）' : '删除原因（会留档）');
    if (!reason) return;
    wx.showModal({
      title: what + '？',
      content: this.data.published ? '撤下后成员看不到这一站，年度榜马上去掉这一站的积分；名次录错了请用「发布更正」' : '删除后这份草稿就没有了',
      confirmText: this.data.published ? '撤下' : '删除', confirmColor: '#C0392B',
      success: async (r) => {
        if (!r.confirm) return;
        this.setData({ busy: true });
        try {
          await cloud.call('cupRemove', { id: this.key, reason });
          wx.showToast({ title: this.data.published ? '已撤下' : '已删除', icon: 'success' });
          setTimeout(() => wx.navigateBack({ fail() {} }), 700);
        } catch (e) {
          wx.showModal({ title: '没有撤下', content: e.message || '请稍后再试', showCancel: false });
        } finally { this.setData({ busy: false }); }
      },
    });
  },

  saveDraft() { this.submit(false); },
  publish() {
    const p = this.data.preview;
    if (!p || p.error) { wx.showToast({ title: (p && p.error) || '请先选好名次', icon: 'none' }); return; }
    wx.showModal({
      title: this.data.published ? '发布更正？' : '确认发布？',
      content: this.data.published ? '会更新这一站的积分，年度榜马上按新名次重新累计（不会重复加分）' : '发布后成员就能看到这一站的积分，并计入年度榜',
      confirmText: '发布',
      success: (r) => { if (r.confirm) this.submit(true); },
    });
  },
  async submit(publish) {
    if (this.data.busy) return;
    const s = this.stop();
    if (s.partial) { wx.showToast({ title: '有一队没选满', icon: 'none' }); return; }
    delete s.partial;
    this.setData({ busy: true });
    try {
      const r = await cloud.call('cupSave', { key: this.key, stop: s, publish });
      this.setData({ editing: true, published: r.status === 'published' });
      wx.showToast({ title: r.same ? '没有变化' : r.status === 'published' ? (r.how === 'fix' ? '已更正' : '已发布') : '已保存草稿', icon: r.same ? 'none' : 'success' });
      if (r.status === 'published') setTimeout(() => wx.navigateBack({ fail() {} }), 700);
    } catch (e) {
      wx.showModal({ title: '没有保存', content: e.message || '请稍后再试', showCancel: false });
    } finally { this.setData({ busy: false }); }
  },
});
