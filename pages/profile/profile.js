// 编辑球员资料：照片、昵称、性别、网球等级（自评）
//   照片：相册 / 拍照 → 1:1 裁剪 → 缩放成 1080×1080 → 上传 → 微信图片检测通过后才对其他球友显示（utils/photo.js、云函数 setPhoto）
// 比赛场数、胜率、排名由比赛记录自动计算，这里不能改。
// 所有关联（战绩、报名）都按用户 ID，改昵称、换照片不影响。
const db = require('../../utils/db');
const cloud = require('../../utils/cloud');
const R = require('../../utils/rating');
const RU = require('../../utils/rules');
const P = require('../../utils/photo');
const C = require('../../utils/consent');

const STATE_TEXT = {
  checking: '你已经能看到新照片了；检测通过后其他球友也能看到（一般几分钟内）',
  reject: '最近上传的照片没有通过检测，请换一张',
  error: '最近上传的照片检测出错，请重新上传',
};

Page({
  data: {
    name: '', gender: '', level: R.DEFAULT_LEVEL, levels: R.SELF_LEVELS, isNew: true, saving: false, tip: '',
    photoShow: '', photoNew: false, hasPhoto: false, stateText: '', initial: '', color: '#C9C9DE',
    shown: false, // 公开展示授权（utils/consent.js）：不默认勾选
  },

  onLoad(options) {
    this.fromSignup = options && options.from === 'signup';
    const p = db.cachedProfile();
    if (p) this.fill(p);
    if (this.fromSignup) this.setData({ tip: '报名前请先设置昵称，大家在报名名单里会看到' });
    db.getMyProfile().then((x) => { if (x) this.fill(x); else this.prefill(); }).catch((e) => console.error(e));
    this.loadPhoto();
  },

  fill(p) {
    this.avatar = p.avatar || ''; // 以前传过的旧照片（没经过检测）：不显示，保存时原样带回
    const name = p.name || '';
    this.setData({ name, gender: p.gender || '', level: typeof p.level === 'number' ? p.level : R.DEFAULT_LEVEL, isNew: false, initial: name ? RU.initialOf(name) : '', color: name ? RU.colorOf(name) : '#C9C9DE', shown: p.shown === true });
  },

  // 第一次设置资料：昵称预填准入页填的称呼（准入页写着「活动报名显示名称」），可以改；保存时照常过内容检测和重名检查
  prefill() {
    require('../../utils/member').statusCached().then((r) => {
      const name = String((r && r.name) || '').trim();
      if (!name || !this.data.isNew || this.data.name) return; // 已经有资料或自己已经开始填了，不覆盖
      this.setData({ name, initial: RU.initialOf(name), color: RU.colorOf(name) });
    }).catch(() => {});
  },

  // 当前照片和最近一次检测的状态（检测中的照片只有自己能看到预览）
  async loadPhoto() {
    try {
      const r = await cloud.call('myPhoto');
      this.photo = r;
      P.applyMine(await db.myOpenid(), this.data.name || (db.cachedProfile() || {}).name || '', r); // 顺便更新「本人马上看到」：通过 / 没通过就不再单独显示
      if (!this.photoTemp) this.setData({ photoShow: r.pendingUrl || r.url || '', hasPhoto: !!(r.url || r.pendingUrl), stateText: STATE_TEXT[r.state] || '' });
    } catch (e) { console.warn('[照片] 读取失败', e && e.message); }
  },

  /* ---------- 照片 ---------- */
  pickAlbum() { this.pick('album'); },
  pickCamera() { this.pick('camera'); },
  // 选好、裁好就直接上传（已经有资料的）：不用再点「保存」，返回其他页面马上看到；第一次设置资料的，保存资料时一起上传
  async pick(source) {
    if (!this.data.shown && !(await this.agree('上传照片需要同意公开展示'))) return; // 照片就是给其他成员看的：先授权
    let path;
    try { path = await P.pick(source); } catch (e) {
      wx.showModal({ title: '没有选好照片', content: e.message || '请重试', showCancel: false });
      return;
    }
    if (!path) return;
    this.photoTemp = path;
    this.setData({ photoShow: path, photoNew: true });
    if (!this.data.isNew) this.uploadNow();
  },
  async uploadNow() {
    if (this.data.saving) return;
    this.setData({ saving: true });
    wx.showLoading({ title: '上传照片', mask: true });
    try {
      await this.uploadPhoto();
      wx.hideLoading();
      wx.showToast({ title: '照片已设置', icon: 'success' });
    } catch (e) {
      wx.hideLoading();
      console.error(e);
      wx.showModal({ title: '照片没有上传成功', content: (e.message || '请稍后再试') + '。可以点「保存修改」重试。', showCancel: false });
    } finally {
      this.setData({ saving: false });
    }
  },
  undoPhoto() {
    this.photoTemp = '';
    const r = this.photo || {};
    this.setData({ photoShow: r.pendingUrl || r.url || '', photoNew: false });
  },
  previewPhoto() {
    if (this.data.photoShow) wx.previewImage({ urls: [this.data.photoShow], showmenu: false });
  },
  async removePhoto() {
    const go = await new Promise((done) => wx.showModal({ title: '删除照片', content: '删除后显示名字首字，可以随时重新上传。', confirmText: '删除', confirmColor: '#e5484d', success: (x) => done(x.confirm), fail: () => done(false) }));
    if (!go) return;
    wx.showLoading({ title: '删除中', mask: true });
    try {
      await cloud.call('setPhoto', { fileID: '' });
      this.photoTemp = '';
      this.photo = { url: '', pendingUrl: '', state: '' };
      P.setMine(null);
      this.setData({ photoShow: '', photoNew: false, hasPhoto: false, stateText: '' });
      db.fetchPlayersFull().catch(() => {}); // 刷新照片名单（写操作已作废缓存）
      wx.hideLoading();
      wx.showToast({ title: '已删除', icon: 'success' });
    } catch (e) {
      wx.hideLoading();
      wx.showModal({ title: '删除失败', content: e.message || '请稍后再试', showCancel: false });
    }
  },
  // 页面上隐藏的 2d 画布：把裁好的照片画成 1080×1080
  canvas() {
    return new Promise((ok, bad) => {
      wx.createSelectorQuery().in(this).select('#photo-cv').fields({ node: true }).exec((r) => {
        const node = r && r[0] && r[0].node;
        if (node) ok(node); else bad(new Error('当前微信版本不支持处理照片，请升级微信后重试'));
      });
    });
  },
  async uploadPhoto() {
    const square = await P.toSquare(await this.canvas(), this.photoTemp);
    const uid = await db.myOpenid();
    const r = await P.upload(square, uid);
    P.setMine({ uid, name: (this.data.name || '').trim(), fileID: r.fileID, src: square }); // 本人马上在所有页面看到新照片
    this.photoTemp = '';
    this.photo = Object.assign({}, this.photo, { pendingUrl: square, state: 'checking' });
    this.setData({ photoShow: square, photoNew: false, hasPhoto: true, stateText: STATE_TEXT.checking });
  },

  /* ---------- 公开展示授权 ---------- */
  // 弹出授权说明，同意后勾上；已经有资料的马上保存到云端（第一次设置资料的，点「完成」时一起保存）
  async agree(title) {
    const yes = await new Promise((done) => wx.showModal({ title: title || C.TITLE, content: C.TEXT, confirmText: '同意', cancelText: '取消', success: (x) => done(x.confirm), fail: () => done(false) }));
    if (!yes) return false;
    if (!this.data.isNew && !(await this.applyShown(true))) return false;
    this.setData({ shown: true });
    return true;
  },
  async applyShown(on) {
    wx.showLoading({ title: '保存中', mask: true });
    try {
      await db.setShown(on);
      db.fetchPlayersFull().catch(() => {}); // 刷新照片名单和排行
      wx.hideLoading();
      return true;
    } catch (e) {
      wx.hideLoading();
      wx.showModal({ title: '没有保存成功', content: (e && e.message) || '请稍后再试', showCancel: false });
      return false;
    }
  },
  async toggleShown() {
    if (this.data.saving) return;
    if (!this.data.shown) { await this.agree(); return; }
    if (this.data.isNew) { this.setData({ shown: false }); return; }
    const off = await new Promise((done) => wx.showModal({ title: '关闭公开展示', content: '关闭后，其他成员看不到你的照片，排行榜里也不显示你；你的照片会保留，重新开启后恢复显示。', confirmText: '关闭', cancelText: '取消', success: (x) => done(x.confirm), fail: () => done(false) }));
    if (off && (await this.applyShown(false))) { this.setData({ shown: false }); wx.showToast({ title: '已关闭', icon: 'success' }); }
  },

  /* ---------- 文字 ---------- */
  // type="nickname" 的输入框：键盘上方会出现「用微信昵称」
  onName(e) { this.setData({ name: e.detail.value }); },
  pickGender(e) { this.setData({ gender: e.currentTarget.dataset.v }); },
  pickLevel(e) { this.setData({ level: Number(e.currentTarget.dataset.v) }); },

  async save() {
    const name = (this.data.name || '').trim();
    if (!name) { wx.showToast({ title: '请填写昵称', icon: 'none' }); return; }
    if (name.length > 10) { wx.showToast({ title: '昵称最多 10 个字', icon: 'none' }); return; }
    if (this.data.gender !== 'm' && this.data.gender !== 'f') { wx.showToast({ title: '请选择性别', icon: 'none' }); return; }
    if (this.data.saving) return;
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中', mask: true });
    let step = '资料';
    try {
      // 先保存资料（第一次设置时要先有资料才能传照片），再上传照片提交检测
      await db.saveMyProfile({ name, avatar: this.avatar, level: this.data.level, gender: this.data.gender, shown: this.data.isNew ? !!this.data.shown : undefined }); // 第一次设置资料：带上勾选结果（不勾就是不同意，不强制）；已有资料的授权在勾选时已经单独保存，这里不带，免得旧缓存覆盖
      const withPhoto = !!this.photoTemp;
      if (withPhoto) { step = '照片'; wx.showLoading({ title: '上传照片', mask: true }); await this.uploadPhoto(); }
      wx.hideLoading();
      if (withPhoto) {
        await new Promise((done) => wx.showModal({ title: '已保存', content: '你现在就能看到新照片；照片检测通过后，其他球友也能看到（一般几分钟内）。', showCancel: false, complete: done }));
      } else wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => {
        if (getCurrentPages().length > 1) wx.navigateBack();
        else wx.switchTab({ url: '/pages/me/me' });
      }, withPhoto ? 0 : 600);
    } catch (e) {
      wx.hideLoading();
      console.error(e);
      const title = step === '照片' ? '资料已保存，照片没有上传成功' : '保存失败';
      wx.showModal({ title, content: e.message || '请稍后再试', showCancel: false });
    } finally {
      this.setData({ saving: false });
    }
  },
});
