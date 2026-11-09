// 准入页：不是正式成员时所有页面都会跳到这里（云函数也会拦截一切数据请求）
//   none 未申请 → 填写称呼提交申请（或用管理员给的邀请链接直接加入）
//   pending 待审核 / rejected 申请未通过 / removed 成员资格已取消 / active 已是成员
const cloud = require('../../utils/cloud');
const member = require('../../utils/member');

const TEXT = {
  none: { t: '仅限内部球友使用', d: '这是内部球友的小程序。提交加入申请，管理员审核通过后就能使用。' },
  pending: { t: '申请已提交，等待审核', d: '管理员审核通过后就能使用。可以下拉刷新查看最新状态。' },
  rejected: { t: '申请未通过', d: '如有疑问可以联系管理员，也可以修改说明后重新申请。' },
  removed: { t: '成员资格已取消', d: '你已不能查看和使用内部数据。如有疑问请联系管理员，也可以重新申请。' },
  active: { t: '你已是正式成员', d: '欢迎回来！' },
};

Page({
  data: { loading: true, status: 'none', title: '', desc: '', reason: '', invite: '', name: '', note: '', busy: false, myId: '', myIdTail: '' },
  onLoad(o) {
    this.setData({ invite: o.invite || '' });
    member.clearProtected(); // 进了准入页就清掉受保护的缓存
  },
  onShow() { this.load(); require('../../utils/notify').prefetch(); },
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    this.load().then(() => wx.stopPullDownRefresh()); },
  async load() {
    try {
      const r = await member.status();
      const tx = TEXT[r.status] || TEXT.none;
      this.setData({ loading: false, status: r.status, title: tx.t, desc: tx.d, reason: r.reason || '', name: this.data.name || r.name || '', myId: r.uid || '', myIdTail: String(r.uid || '').slice(-6) });
    } catch (e) {
      this.setData({ loading: false, title: '网络异常', desc: e.message || '请稍后下拉刷新' });
    }
  },
  // 复制自己的用户 ID：设置管理员时要用（只能复制自己的）
  copyMyId() {
    const id = this.data.myId;
    if (!id) return;
    wx.setClipboardData({ data: id, success: () => wx.showToast({ title: '已复制，发给管理员即可', icon: 'none' }) });
  },
  onName(e) { this.setData({ name: e.detail.value }); },
  onNote(e) { this.setData({ note: e.detail.value }); },
  async apply() {
    if (this.data.busy) return;
    require('../../utils/notify').ask(['result']); // 审核结果出来时通知我
    if (!this.data.name.trim()) { wx.showToast({ title: '请填写你的称呼', icon: 'none' }); return; }
    this.setData({ busy: true });
    try { await cloud.call('applyMember', { name: this.data.name, note: this.data.note }); wx.showToast({ title: '已提交申请', icon: 'success' }); await this.load(); }
    catch (e) { wx.showModal({ title: '提交失败', content: e.message, showCancel: false }); }
    finally { this.setData({ busy: false }); }
  },
  async accept() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try { await cloud.call('acceptInvite', { code: this.data.invite, name: this.data.name }); wx.showToast({ title: '已加入', icon: 'success' }); await this.load(); }
    catch (e) { wx.showModal({ title: '无法加入', content: e.message, showCancel: false }); }
    finally { this.setData({ busy: false }); }
  },
  enter() {
    let to = '';
    try { to = wx.getStorageSync('after_gate') || ''; wx.removeStorageSync('after_gate'); } catch (e) {}
    const tabs = ['/pages/draw/draw', '/pages/index/index', '/pages/rank/rank', '/pages/me/me'];
    if (!to || tabs.indexOf(to) >= 0) wx.reLaunch({ url: to || '/pages/draw/draw' });
    else wx.reLaunch({ url: to });
  },
  onShareAppMessage() { return { title: 'LULU网球', path: '/pages/gate/gate' }; }, // 分享出去也只能看到准入页
});
