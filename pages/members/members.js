// 成员管理（仅管理员；管理员身份由云函数环境变量 ADMIN_OPENIDS 决定，云函数逐个操作校验）
//   待审核：批准 / 拒绝（填原因）   成员：移除（填原因，立即生效，不删历史记录）
//   历史球友：升级前设置过资料的账号，管理员确认后再导入，不自动成为成员   邀请：生成一次性邀请链接
const cloud = require('../../utils/cloud');
const pick = require('../../utils/pick');
const { copyFail } = require('../../utils/privacy'); // 剪切板是隐私接口：没同意隐私指引就停止这次复制
const SHARE_IMAGE = require('../../utils/share-card').FALLBACK; // 分享卡片封面（不指定时微信截页面顶部，有时截成空白）

Page({
  data: { tab: 'pending', d: null, loading: true, picked: {}, lastInvite: '', audit: null, auditing: false, activeList: [], noGender: 0, onlyNoGender: false },
  onShow() { this.load(); },
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    this.load().then(() => wx.stopPullDownRefresh()); },
  // 先用 60 秒内读到过的成员列表马上显示（活动详情、创建活动页给管理员预读过），再实时读一次更正（2026-11-24 用户嫌打开慢）
  async load() {
    const pre = !this.d && cloud.peek('listMembers');
    if (pre) { this.d = pre; this.setData(Object.assign({ d: pre, loading: false }, this.activeView())); }
    try { const d = await cloud.fresh('listMembers'); this.d = d; this.setData(Object.assign({ d, loading: false }, this.activeView())); }
    catch (e) { this.setData({ loading: false }); wx.showModal({ title: '无法打开', content: e.message, showCancel: false, success: () => wx.navigateBack() }); }
  },
  setTab(e) { this.setData({ tab: e.currentTarget.dataset.v }); },
  // 成员列表：没填性别的数一下（含还没设置资料、但加入时留了昵称的），可以只看他们
  activeView(only = this.data.onlyNoGender) {
    const all = (this.d && this.d.active) || [];
    const missing = all.filter((m) => !m.gender && (m.nickname || m.name));
    return { activeList: only ? missing : all, noGender: missing.length, onlyNoGender: only };
  },
  toggleNoGender() { this.setData(this.activeView(!this.data.onlyNoGender)); },
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
    if (r) { this.setData({ lastInvite: r.code, tab: 'invite' }); wx.showToast({ title: '已生成，点「发给球友」', icon: 'none' }); }
  },
  copyCode(e) { wx.setClipboardData({ data: e.currentTarget.dataset.code, fail: copyFail, success: () => wx.showToast({ title: '邀请码已复制', icon: 'none' }) }); },
  revoke(e) { this.run('revokeInvite', { code: e.currentTarget.dataset.code }, '已作废'); },
  onShareAppMessage(e) {
    const code = (e && e.target && e.target.dataset && e.target.dataset.code) || this.data.lastInvite;
    return { title: '邀请你加入 LULU 网球', path: '/pages/gate/gate?invite=' + code, imageUrl: SHARE_IMAGE };
  },
});
