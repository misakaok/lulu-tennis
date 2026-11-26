// 成员管理（仅管理员；管理员身份由云函数环境变量 ADMIN_OPENIDS 决定，云函数逐个操作校验）
//   待审核：批准 / 拒绝（填原因）   成员：移除（填原因，立即生效，不删历史记录）
//   历史球友：升级前设置过资料的账号，管理员确认后再导入   邀请：生成一次性邀请链接
//   运营统计：活动时段/水平成局率、成员近 30/90 天活跃出勤、年度结构化报表与 CSV 一键复制
const cloud = require('../../utils/cloud');
const db = require('../../utils/db');
const pick = require('../../utils/pick');
const haptic = require('../../utils/haptic');
const { copyFail } = require('../../utils/privacy'); // 剪切板是隐私接口：没同意隐私指引就停止这次复制
const SHARE_IMAGE = require('../../utils/share-card').FALLBACK; // 分享卡片封面（不指定时微信截页面顶部，有时截成空白）
const Ops = require('../utils/ops');

const pad = (n) => (n < 10 ? '0' + n : '' + n);
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const MAIN_TABS = ['pending', 'active', 'import', 'invite', 'ops'];
const OPS_TABS = [
  { value: 'draws', label: '成局率' },
  { value: 'members', label: '出勤活跃' },
  { value: 'export', label: '年度导出' },
];
const OPS_FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'active30', label: '近30天活跃' },
  { value: 'warm', label: '31~90天' },
  { value: 'cold', label: '90天未出勤' },
];

Page({
  data: {
    tab: 'pending', tabIdx: 0, d: null, loading: true, picked: {}, lastInvite: '',
    activeList: [], noGender: 0, onlyNoGender: false,
    // 运营统计标签页
    opsTabs: OPS_TABS, opsTab: 'draws', opsTabIdx: 0,
    opsFilters: OPS_FILTERS, opsFilter: 'all', opsMembers: [],
    opsReport: null, opsYear: new Date().getFullYear(),
    opsExpKind: 'summary', opsExpText: '',
  },
  onShow() {
    this.load();
    if (this.data.tab === 'ops') this.loadOps(true);
  },
  onPullDownRefresh() {
    require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    const tasks = [this.load()];
    if (this.data.tab === 'ops') tasks.push(this.loadOps(true));
    Promise.all(tasks).then(() => wx.stopPullDownRefresh());
  },
  // 先用 60 秒内读到过的成员列表马上显示（活动详情、创建活动页给管理员预读过），再实时读一次更正（2026-11-24 用户嫌打开慢）
  async load() {
    const pre = !this.d && cloud.peek('listMembers');
    if (pre) { this.d = pre; this.setData(Object.assign({ d: pre, loading: false }, this.activeView())); }
    try {
      const d = await cloud.fresh('listMembers');
      this.d = d;
      this.setData(Object.assign({ d, loading: false }, this.activeView()));
      if (this.opsRaw) this.computeOps(this.data.opsYear);
    } catch (e) {
      this.setData({ loading: false });
      wx.showModal({ title: '无法打开', content: e.message, showCancel: false, success: () => wx.navigateBack() });
    }
  },
  setTab(e) {
    const v = e.currentTarget.dataset.v;
    const idx = MAIN_TABS.indexOf(v);
    if (v !== this.data.tab) haptic.light();
    this.setData({ tab: v, tabIdx: idx >= 0 ? idx : 0 });
    if (v === 'ops') this.loadOps();
  },

  /* ---------- 运营统计（成局率 / 出勤活跃 / 年度导出） ---------- */
  async loadOps(force) {
    if (!force && this.opsRaw) { this.computeOps(this.data.opsYear); return; }
    const seq = this.opsSeq = (this.opsSeq || 0) + 1;
    // 先用本机缓存画出来，再静默读共享数据更正
    if (!this.opsRaw) {
      this.opsRaw = {
        draws: (db.cachedDraws && db.cachedDraws()) || [],
        matches: (db.cachedMatches && db.cachedMatches()) || [],
        players: (db.cachedPlayersFull && db.cachedPlayersFull()) || [],
        stops: (cloud.peek('cupList') && cloud.peek('cupList').list) || [],
      };
      this.computeOps(this.data.opsYear);
    }
    try {
      const [draws, matches, players, cupRes] = await Promise.all([
        db.drawsShared().catch(() => db.cachedDraws()),
        db.matchesShared().catch(() => db.cachedMatches()),
        db.playersShared().catch(() => db.cachedPlayersFull()),
        cloud.cached('cupList').catch(() => null),
      ]);
      if (seq !== this.opsSeq) return;
      this.opsRaw = {
        draws: draws || [],
        matches: matches || [],
        players: players || [],
        stops: (cupRes && cupRes.list) || [],
      };
      this.computeOps(this.data.opsYear);
    } catch (e) {
      if (seq !== this.opsSeq) return;
      wx.showToast({ title: '运营数据读取失败', icon: 'none' });
    }
  },
  computeOps(year) {
    if (!this.opsRaw) return;
    const members = (this.d && this.d.active) || [];
    const report = Ops.opsReport(Object.assign({ today: todayStr(), year, members }, this.opsRaw));
    const opsMembers = this.filterOpsMembers(report.memberRows, this.data.opsFilter);
    const opsExpText = this.pickOpsExport(report, this.data.opsExpKind);
    this.setData({ opsReport: report, opsYear: report.year, opsMembers, opsExpText });
  },
  filterOpsMembers(rows, flt) {
    const list = rows || [];
    if (flt === 'active30') return list.filter((m) => m.m30 >= 1);
    if (flt === 'warm') return list.filter((m) => m.tier === 'warm');
    if (flt === 'cold') return list.filter((m) => m.tier === 'cold');
    return list;
  },
  pickOpsExport(report, kind) {
    if (!report || !report.exports) return '';
    if (kind === 'members') return report.exports.membersCsv;
    if (kind === 'cup') return report.exports.cupCsv;
    return report.exports.summaryText;
  },
  setOpsTab(e) {
    const v = e.currentTarget.dataset.v;
    const idx = OPS_TABS.findIndex((x) => x.value === v);
    if (idx < 0 || v === this.data.opsTab) return;
    haptic.light();
    this.setData({ opsTab: v, opsTabIdx: idx });
  },
  setOpsFilter(e) {
    const v = e.currentTarget.dataset.v || 'all';
    if (v === this.data.opsFilter) return;
    haptic.light();
    const opsMembers = this.filterOpsMembers(this.data.opsReport ? this.data.opsReport.memberRows : [], v);
    this.setData({ opsFilter: v, opsMembers });
  },
  setOpsYear(e) {
    const y = Number(e.currentTarget.dataset.v);
    if (!y || y === this.data.opsYear) return;
    haptic.light();
    this.computeOps(y);
  },
  setOpsExpKind(e) {
    const k = e.currentTarget.dataset.v || 'summary';
    if (k === this.data.opsExpKind) return;
    haptic.light();
    this.setData({ opsExpKind: k, opsExpText: this.pickOpsExport(this.data.opsReport, k) });
  },
  copyOpsExport() {
    const k = this.data.opsExpKind;
    const text = this.pickOpsExport(this.data.opsReport, k);
    if (!text) { wx.showToast({ title: '暂无可复制数据', icon: 'none' }); return; }
    const label = k === 'members' ? '成员出勤 CSV' : k === 'cup' ? 'LULU 积分 CSV' : '年度汇总报表';
    wx.setClipboardData({ data: text, fail: copyFail, success: () => { haptic.medium(); wx.showToast({ title: `已复制${label}`, icon: 'success' }); } });
  },

  // 成员列表：没填性别的数一下（含还没设置资料、但加入时留了昵称的），可以只看他们
  activeView(only = this.data.onlyNoGender) {
    const all = (this.d && this.d.active) || [];
    const missing = all.filter((m) => !m.gender && (m.nickname || m.name));
    return { activeList: only ? missing : all, noGender: missing.length, onlyNoGender: only };
  },
  toggleNoGender() { this.setData(this.activeView(!this.data.onlyNoGender)); },
  // 复制用户 ID（openid）：设置管理员时粘贴到云函数环境变量 ADMIN_OPENIDS，避免手抄出错
  copyId(e) {
    const uid = e.currentTarget.dataset.uid;
    wx.setClipboardData({ data: uid, success: () => wx.showToast({ title: '已复制用户 ID', icon: 'none' }), fail: copyFail });
  },
  async run(action, data, ok) {
    if (this.busy) return;
    this.busy = true;
    try { const r = await cloud.call(action, data); if (ok) wx.showToast({ title: ok, icon: 'none' }); await this.load(); return r; }
    catch (e) { wx.showModal({ title: '操作失败', content: e.message, showCancel: false }); return null; }
    finally { this.busy = false; }
  },
  approve(e) { this.run('reviewMember', { uid: e.currentTarget.dataset.uid, approve: true }, '已批准'); },
  async reject(e) {
    const reason = await pick.reason('member', '拒绝原因（申请人会看到）');
    if (!reason) return;
    this.run('reviewMember', { uid: e.currentTarget.dataset.uid, approve: false, reason }, '已拒绝');
  },
  async remove(e) {
    const { uid, name } = e.currentTarget.dataset;
    const go = await new Promise((done) => wx.showModal({ title: `移除 ${name || '该成员'}`, content: '移除后立即不能使用，历史比分和记录保留。下一步选择原因。', confirmText: '继续', confirmColor: '#e5484d', success: (x) => done(x.confirm), fail: () => done(false) }));
    if (!go) return;
    const reason = await pick.reason('member', '移除原因');
    if (!reason) return;
    this.run('removeMember', { uid, reason }, '已移除');
  },
  // 替没选性别的成员补选（点已有的性别可以更正）；成员本人之后仍可在编辑资料里改。
  // 还没设置资料的（fresh）：先说明会用 TA 加入时的昵称替 TA 建好资料（云端 setMemberGender 建、留档）
  async setGender(e) {
    const { uid, name, gender, fresh } = e.currentTarget.dataset;
    if (fresh) {
      const go = await new Promise((done) => wx.showModal({
        title: `替 ${name} 建好资料？`, content: `TA 还没设置资料。选好性别后，会用 TA 加入时的昵称「${name}」替 TA 建好资料（会留档），之后就能报名、被选进积分；TA 以后可以在编辑资料里改昵称和性别。`,
        confirmText: '选性别', success: (x) => done(x.confirm), fail: () => done(false),
      }));
      if (!go) return;
    }
    wx.showActionSheet({
      alertText: `${name || '该成员'}的性别${gender ? '（现在是' + (gender === 'm' ? '男' : '女') + '）' : ''}`, itemList: ['男', '女'],
      success: (r) => this.run('setMemberGender', { uid, gender: r.tapIndex === 0 ? 'm' : 'f' }, '已保存'),
    });
  },
  // 照片已经过微信检测才公开；万一有不合适的，管理员可以移除（改回首字圆，留档），成员可以重新上传
  async clearPhoto(e) {
    const { uid, name } = e.currentTarget.dataset;
    const go = await new Promise((done) => wx.showModal({ title: `移除${name || '该成员'}的照片`, content: '移除后显示名字首字，TA 可以重新上传。', confirmText: '移除', confirmColor: '#e5484d', success: (x) => done(x.confirm), fail: () => done(false) }));
    if (go) this.run('adminClearPhoto', { uid }, '已移除照片');
  },
  restore(e) { this.run('reviewMember', { uid: e.currentTarget.dataset.uid, approve: true }, '已恢复为成员'); },
  // 一键清空「已拒绝 / 已移除」：只是从列表里收起，不删记录（云端 clearMemberHistory，留档）
  async clearOthers() {
    const n = ((this.d && this.d.others) || []).length;
    if (!n) return;
    const go = await new Promise((done) => wx.showModal({
      title: `清空这 ${n} 人？`, content: '只是不再显示在这里，不删除记录，TA 们仍然不能使用小程序。以后重新申请或用邀请码加入时，会照常出现在待审核或成员里。',
      confirmText: '清空', success: (x) => done(x.confirm), fail: () => done(false),
    }));
    if (go) this.run('clearMemberHistory', {}, '已清空');
  },
  pick(e) { const uid = e.currentTarget.dataset.uid; this.setData({ [`picked.${uid}`]: !this.data.picked[uid] }); },
  async importPicked() {
    const uids = Object.keys(this.data.picked).filter((u) => this.data.picked[u]);
    if (!uids.length) { wx.showToast({ title: '先勾选要导入的球友', icon: 'none' }); return; }
    const r = await this.run('importMembers', { uids }, '');
    if (r) { this.setData({ picked: {} }); wx.showToast({ title: `已导入 ${r.imported} 人`, icon: 'none' }); }
  },
  async invite() {
    const r = await this.run('createInvite', { days: 7 }, '');
    if (r) { this.setData({ lastInvite: r.code, tab: 'invite', tabIdx: MAIN_TABS.indexOf('invite') }); wx.showToast({ title: '已生成，点「发给球友」', icon: 'none' }); }
  },
  copyCode(e) { wx.setClipboardData({ data: e.currentTarget.dataset.code, fail: copyFail, success: () => wx.showToast({ title: '邀请码已复制', icon: 'none' }) }); },
  revoke(e) { this.run('revokeInvite', { code: e.currentTarget.dataset.code }, '已作废'); },
  onShareAppMessage(e) {
    const code = (e && e.target && e.target.dataset && e.target.dataset.code) || this.data.lastInvite;
    return { title: '邀请你加入 LULU 网球', path: '/pages/gate/gate?invite=' + code, imageUrl: SHARE_IMAGE };
  },
});
