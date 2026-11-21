// 准入页：不是正式成员时所有页面都会跳到这里（云函数也会拦截一切数据请求）
//   默认「用邀请码加入」：填邀请码和昵称，提交后直接成为正式成员（或用管理员给的邀请链接，邀请码已带上）
//   没有邀请码时可以改为「提交申请」，等管理员审核
//   status：none 未申请 / pending 待审核 / rejected 申请未通过 / removed 成员资格已取消 / active 已是成员
//   mode：code 用邀请码加入 / apply 提交申请 / wait 已申请、等审核
const cloud = require('../../utils/cloud');
const member = require('../../utils/member');
const SHARE_IMAGE = require('../../utils/share-card').FALLBACK; // 分享卡片封面（不指定时微信截页面顶部，有时截成空白）

const TITLE = { none: '私人网球活动管理', pending: '申请已提交，等待审核', rejected: '申请未通过', removed: '成员资格已取消', active: '你已是正式成员' };
// 开发版预览：模拟器里管理员总是正式成员，看不到准入页。开发者工具「编译模式」用参数 preview=none / pending / rejected / removed
// 打开对应状态（可再加 invite=任意值 看邀请链接进来的样子）。只在开发版生效，按钮不会提交；体验版、正式版忽略这个参数
const PREVIEW = { none: 1, pending: 1, rejected: 1, removed: 1 };
function previewOf(o) {
  try { return wx.getAccountInfoSync().miniProgram.envVersion === 'develop' && PREVIEW[o.preview] ? o.preview : ''; } catch (e) { return ''; }
}
function descOf(status, mode, invite) {
  if (status === 'active') return '欢迎回来！';
  if (mode === 'wait') return '管理员审核通过后就能使用，可以下拉刷新查看最新状态。有邀请码可以直接加入，不用等审核。';
  if (mode === 'apply') return status === 'none' ? '没有邀请码也可以提交加入申请，管理员审核通过后就能使用。' : '可以重新提交申请，管理员审核通过后就能使用。';
  const head = status === 'removed' ? '你已不能查看和使用内部数据。' : (status === 'rejected' ? '如有疑问可以联系管理员。' : '');
  return head + (invite ? '你收到了球友邀请，填写昵称就能直接加入。' : '填写管理员给的邀请码和你的昵称，就能直接加入。');
}

Page({
  data: { loading: true, status: 'none', title: '', desc: '', reason: '', invite: '', mode: '', code: '', name: '', busy: false, myId: '', myIdTail: '' },
  onLoad(o) {
    this.preview = previewOf(o);
    this.setData({ invite: o.invite || '' });
    if (!this.preview) member.clearProtected(); // 进了准入页就清掉受保护的缓存（预览时不清，免得开发时缓存全丢）
  },
  onShow() { this.load(); },
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    this.load().then(() => wx.stopPullDownRefresh()); },
  async load() {
    try {
      const r = this.preview ? { status: this.preview, reason: '', name: '', uid: '' } : await member.status();
      const status = TITLE[r.status] ? r.status : 'none';
      // 第一次加载（或状态变了）时选默认方式：有邀请链接或没申请过 → 邀请码；已申请 → 等审核。用户自己切换过的保留
      const mode = this.data.mode && this.data.status === status ? this.data.mode : (status === 'pending' && !this.data.invite ? 'wait' : 'code');
      this.setData({ loading: false, status, mode, title: TITLE[status], desc: descOf(status, mode, this.data.invite), reason: r.reason || '', name: this.data.name || r.name || '', myId: r.uid || '', myIdTail: String(r.uid || '').slice(-6) });
    } catch (e) {
      this.setData({ loading: false, mode: this.data.mode || 'code', title: '网络异常', desc: e.message || '请稍后下拉刷新' });
    }
  },
  // 复制自己的用户 ID：设置管理员时要用（只能复制自己的）
  copyMyId() {
    const id = this.data.myId;
    if (!id) return;
    wx.setClipboardData({ data: id, success: () => wx.showToast({ title: '已复制，发给管理员即可', icon: 'none' }) });
  },
  onName(e) { this.setData({ name: e.detail.value }); },
  // 手动输入邀请码：没有邀请链接时（例如管理员口头或文字给的邀请码）也能加入；校验和链接进来的一样，都在云函数 acceptInvite
  onCode(e) { this.setData({ code: e.detail.value }); },
  switchMode(e) { const mode = e.currentTarget.dataset.mode; this.setData({ mode, desc: descOf(this.data.status, mode, this.data.invite) }); },
  async apply() {
    if (this.data.busy) return;
    if (this.preview) { wx.showToast({ title: '预览模式，不会提交', icon: 'none' }); return; }
    if (!this.data.name.trim()) { wx.showToast({ title: '请填写你的昵称', icon: 'none' }); return; }
    this.setData({ busy: true });
    try { await cloud.call('applyMember', { name: this.data.name }); wx.showToast({ title: '已提交申请', icon: 'success' }); await this.load(); }
    catch (e) { wx.showModal({ title: '提交失败', content: e.message, showCancel: false }); }
    finally { this.setData({ busy: false }); }
  },
  async accept() {
    if (this.data.busy) return;
    if (this.preview) { wx.showToast({ title: '预览模式，不会提交', icon: 'none' }); return; }
    const code = this.data.invite || (this.data.code || '').replace(/\s+/g, '').toLowerCase(); // 邀请码是小写字母数字，容忍手动输入时的空格和大写
    if (!code) { wx.showToast({ title: '请填写邀请码', icon: 'none' }); return; }
    if (!this.data.name.trim()) { wx.showToast({ title: '请填写你的昵称', icon: 'none' }); return; }
    this.setData({ busy: true });
    try { await cloud.call('acceptInvite', { code, name: this.data.name }); await this.load(); if (this.data.status === 'active') this.enter(); } // 邀请码有效就直接成为正式成员并进入小程序，不需要管理员审核，也不用再点一次
    catch (e) { wx.showModal({ title: '无法加入', content: e.message, showCancel: false }); }
    finally { this.setData({ busy: false }); }
  },
  // 回到被拦下时的页面（带参数，见 utils/member.js 的 kickout）；没有就去活动 tab。打不开时也退回活动 tab
  enter() {
    let to = '';
    try { to = wx.getStorageSync('after_gate') || ''; wx.removeStorageSync('after_gate'); } catch (e) {}
    const home = '/pages/draw/draw';
    wx.reLaunch({ url: to || home, fail: () => { if (to) wx.reLaunch({ url: home }); } });
  },
  onShareAppMessage() { return { title: 'LULU网球', path: '/pages/gate/gate', imageUrl: SHARE_IMAGE }; }, // 分享出去也只能看到准入页
});
