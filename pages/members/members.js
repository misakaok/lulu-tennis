// 成员管理（仅管理员；管理员身份由云函数环境变量 ADMIN_OPENIDS 决定，云函数逐个操作校验）
//   待审核：批准 / 拒绝（填原因）   成员：移除（填原因，立即生效，不删历史记录）
//   历史球友：升级前设置过资料的账号，管理员确认后再导入，不自动成为成员   邀请：生成一次性邀请链接
const cloud = require('../../utils/cloud');

Page({
  data: { tab: 'pending', d: null, loading: true, picked: {}, lastInvite: '' },
  onShow() { this.load(); },
  onPullDownRefresh() { this.load().then(() => wx.stopPullDownRefresh()); },
  async load() {
    try { const d = await cloud.call('listMembers'); this.setData({ d, loading: false }); }
    catch (e) { this.setData({ loading: false }); wx.showModal({ title: '无法打开', content: e.message, showCancel: false, success: () => wx.navigateBack() }); }
  },
  setTab(e) { this.setData({ tab: e.currentTarget.dataset.v }); },
  ask(title, ph) { return new Promise((r) => wx.showModal({ title, editable: true, placeholderText: ph, success: (x) => r(x.confirm ? (x.content || '').trim() : null), fail: () => r(null) })); },
  async run(action, data, ok) {
    if (this.busy) return;
    this.busy = true;
    try { const r = await cloud.call(action, data); if (ok) wx.showToast({ title: ok, icon: 'none' }); await this.load(); return r; }
    catch (e) { wx.showModal({ title: '操作失败', content: e.message, showCancel: false }); return null; }
    finally { this.busy = false; }
  },
  approve(e) { this.run('reviewMember', { uid: e.currentTarget.dataset.uid, approve: true }, '已批准'); },
  async reject(e) {
    const reason = await this.ask('拒绝申请', '原因（必填，申请人会看到）');
    if (reason === null) return;
    if (reason.length < 2) { wx.showToast({ title: '请填写原因', icon: 'none' }); return; }
    this.run('reviewMember', { uid: e.currentTarget.dataset.uid, approve: false, reason }, '已拒绝');
  },
  async remove(e) {
    const { uid, name } = e.currentTarget.dataset;
    const reason = await this.ask(`移除 ${name || '该成员'}`, '原因（必填）。移除后立即不能使用，历史比分和记录保留');
    if (reason === null) return;
    if (reason.length < 2) { wx.showToast({ title: '请填写原因', icon: 'none' }); return; }
    this.run('removeMember', { uid, reason }, '已移除');
  },
  restore(e) { this.run('reviewMember', { uid: e.currentTarget.dataset.uid, approve: true }, '已恢复为成员'); },
  pick(e) { const uid = e.currentTarget.dataset.uid; this.setData({ [`picked.${uid}`]: !this.data.picked[uid] }); },
  async importPicked() {
    const uids = Object.keys(this.data.picked).filter((u) => this.data.picked[u]);
    if (!uids.length) { wx.showToast({ title: '先勾选要导入的球友', icon: 'none' }); return; }
    const r = await this.run('importMembers', { uids }, '');
    if (r) { this.setData({ picked: {} }); wx.showToast({ title: `已导入 ${r.imported} 人`, icon: 'none' }); }
  },
  async invite() {
    const note = await this.ask('邀请新球友', '备注（选填），例如 小王');
    if (note === null) return;
    const r = await this.run('createInvite', { note, days: 7 }, '');
    if (r) { this.setData({ lastInvite: r.code, tab: 'invite' }); wx.showToast({ title: '已生成，点「发给球友」', icon: 'none' }); }
  },
  revoke(e) { this.run('revokeInvite', { code: e.currentTarget.dataset.code }, '已作废'); },
  onShareAppMessage(e) {
    const code = (e && e.target && e.target.dataset && e.target.dataset.code) || this.data.lastInvite;
    return { title: '邀请你加入 LULU网球', path: '/pages/gate/gate?invite=' + code };
  },
});
