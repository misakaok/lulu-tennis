// 成员管理（仅管理员；管理员身份由云函数环境变量 ADMIN_OPENIDS 决定，云函数逐个操作校验）
//   待审核：批准 / 拒绝（填原因）   成员：移除（填原因，立即生效，不删历史记录）
//   历史球友：升级前设置过资料的账号，管理员确认后再导入，不自动成为成员   邀请：生成一次性邀请链接
const cloud = require('../../utils/cloud');
const pick = require('../../utils/pick');

Page({
  data: { tab: 'pending', d: null, loading: true, picked: {}, lastInvite: '', audit: null, auditing: false },
  onShow() { this.load(); },
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    this.load().then(() => wx.stopPullDownRefresh()); },
  async load() {
    try { const d = await cloud.call('listMembers'); this.setData({ d, loading: false }); }
    catch (e) { this.setData({ loading: false }); wx.showModal({ title: '无法打开', content: e.message, showCancel: false, success: () => wx.navigateBack() }); }
  },
  setTab(e) { this.setData({ tab: e.currentTarget.dataset.v }); },
  async runAudit() {
    if (this.data.auditing) return;
    this.setData({ auditing: true });
    try { this.setData({ audit: await cloud.call('auditSignups') }); }
    catch (e) { wx.showModal({ title: '检查失败', content: e.message, showCancel: false }); }
    finally { this.setData({ auditing: false }); }
  },
  // 复制用户 ID（openid）：设置管理员时粘贴到云函数环境变量 ADMIN_OPENIDS，避免手抄出错
  copyId(e) {
    const uid = e.currentTarget.dataset.uid;
    wx.setClipboardData({ data: uid, success: () => wx.showToast({ title: '已复制用户 ID', icon: 'none' }) });
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
  // 替没选性别的成员补选（点已有的性别可以更正）；成员本人之后仍可在编辑资料里改
  setGender(e) {
    const { uid, name } = e.currentTarget.dataset;
    wx.showActionSheet({
      alertText: `${name || '该成员'}的性别`, itemList: ['男', '女'],
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
  pick(e) { const uid = e.currentTarget.dataset.uid; this.setData({ [`picked.${uid}`]: !this.data.picked[uid] }); },
  async importPicked() {
    const uids = Object.keys(this.data.picked).filter((u) => this.data.picked[u]);
    if (!uids.length) { wx.showToast({ title: '先勾选要导入的球友', icon: 'none' }); return; }
    const r = await this.run('importMembers', { uids }, '');
    if (r) { this.setData({ picked: {} }); wx.showToast({ title: `已导入 ${r.imported} 人`, icon: 'none' }); }
  },
  async invite() {
    const r = await this.run('createInvite', { days: 7 }, '');
    if (r) { this.setData({ lastInvite: r.code, tab: 'invite' }); wx.showToast({ title: '已生成，点「发给球友」', icon: 'none' }); }
  },
  copyCode(e) { wx.setClipboardData({ data: e.currentTarget.dataset.code, success: () => wx.showToast({ title: '邀请码已复制', icon: 'none' }) }); },
  revoke(e) { this.run('revokeInvite', { code: e.currentTarget.dataset.code }, '已作废'); },
  onShareAppMessage(e) {
    const code = (e && e.target && e.target.dataset && e.target.dataset.code) || this.data.lastInvite;
    return { title: '邀请你加入 LULU网球', path: '/pages/gate/gate?invite=' + code };
  },
});
