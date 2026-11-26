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
    name: '', gender: '', level: R.DEFAULT_LEVEL, levels: R.SELF_LEVELS, isNew: true, saving: false, tip: '', fromGate: false,
    photoShow: '', photoNew: false,
    photoBase: '', photoReady: false, // 进页面先显示的本人头像（本机缩略图），原图（photoShow）加载完再淡入盖上，不闪 hasPhoto: false, stateText: '', initial: '', color: '#C9C9DE',
    shown: false, // 公开展示授权（utils/consent.js）：不默认勾选
    shownOld: false, // 只同意过旧版说明（2026-11-26 更新）
    photoState: '', // 最近一次检测：checking / reject / error（状态小标签的颜色）
  },

  onLoad(options) {
    this.fromSignup = options && options.from === 'signup';
    this.fromGate = options && options.from === 'gate'; // 用邀请码刚加入：先设置资料，完成或「稍后再设置」后进小程序
    const p = db.cachedProfile();
    if (p) this.fill(p);
    if (this.fromSignup) this.setData({ tip: '报名前请先设置昵称，大家在报名名单里会看到' });
    if (this.fromGate) this.setData({ fromGate: true, tip: '欢迎加入！先设置你的昵称、性别和网球等级，报名活动时会用到' });
    db.getMyProfile().then((x) => { if (x) this.fill(x); else this.prefill(); }).catch((e) => console.error(e));
    this.quickPhoto();
    this.loadPhoto();
  },

  // 先用手里现成的本人头像（检测中的新照片 / 本机缩略图 / 已取过的链接）垫底，不等联网
  async quickPhoto() {
    try {
      const uid = await db.myOpenid();
      const base = P.ownSrc(uid, '') || P.peek(P.fileOf(uid, ''));
      if (base && !this.data.photoBase && !this.photoTemp) this.setData({ photoBase: base });
    } catch (e) {}
  },
  // 换显示的照片：换了地址就先藏起来，等加载完（photoLoaded）再淡入
  show(url, extra) {
    const d = Object.assign({ photoShow: url }, extra || {});
    if (url !== this.data.photoShow) d.photoReady = false;
    this.setData(d);
  },
  photoLoaded() { if (!this.data.photoReady) this.setData({ photoReady: true }); },
  baseErr() { this.setData({ photoBase: '' }); },

  // 本机缓存先填一次、云端资料读完再填一次。云端结果晚到时，用户已经动过的项（昵称、性别、水平、公开展示）不覆盖
  fill(p) {
    this.avatar = p.avatar || ''; // 以前传过的旧照片（没经过检测）：不显示，保存时原样带回
    const ed = this.edited || {};
    const d = { isNew: false };
    if (!ed.name) d.name = p.name || '';
    if (!ed.gender) d.gender = p.gender || '';
    if (!ed.level) d.level = typeof p.level === 'number' ? p.level : R.DEFAULT_LEVEL;
    if (!ed.shown) {
      d.shown = p.shown === true;
      d.shownOld = d.shown && !C.latest(p); // 只同意过旧版说明：显示「说明已更新」那一行
    }
    const name = d.name !== undefined ? d.name : this.data.name;
    Object.assign(d, { initial: name ? RU.initialOf(name) : '', color: name ? RU.colorOf(name) : '#C9C9DE' });
    this.setData(d);
  },
  touch(k) { (this.edited = this.edited || {})[k] = true; },

  // 第一次设置资料：昵称预填准入页填的昵称，可以改；保存时照常过内容检测和重名检查，保存后云端同步到成员名单（members.name）
  prefill() {
    require('../../utils/member').statusCached().then((r) => {
      const name = String((r && r.name) || '').trim();
      if (!name || !this.data.isNew || this.data.name || (this.edited && this.edited.name)) return; // 已经有资料或自己已经改过了，不覆盖
      this.setData({ name, initial: RU.initialOf(name), color: RU.colorOf(name) });
    }).catch(() => {});
  },

  // 当前照片和最近一次检测的状态（检测中的照片只有自己能看到预览）
  async loadPhoto() {
    try {
      const r = await cloud.call('myPhoto');
      this.photo = r;
      P.applyMine(await db.myOpenid(), this.data.name || (db.cachedProfile() || {}).name || '', r); // 顺便更新「本人马上看到」：通过 / 没通过就不再单独显示
      const url = r.pendingUrl || r.url || '';
      if (!this.photoTemp) this.show(url, Object.assign({ hasPhoto: !!url, stateText: STATE_TEXT[r.state] || '', photoState: r.state || '' }, url ? {} : { photoBase: '' }));
    } catch (e) { console.warn('[照片] 读取失败', e && e.message); }
  },

  /* ---------- 照片 ---------- */
  // 点照片 / 相机角标：从相册选、拍照，有照片时还能查看大图、删除
  photoMenu() {
    if (this.data.saving) return;
    const items = [{ t: '从相册选', fn: () => this.pick('album') }, { t: '拍照', fn: () => this.pick('camera') }];
    if (this.data.photoShow || this.data.photoBase) items.push({ t: '查看大图', fn: () => this.previewPhoto() });
    if (this.data.hasPhoto && !this.data.photoNew) items.push({ t: '删除照片', fn: () => this.removePhoto() });
    wx.showActionSheet({ itemList: items.map((x) => x.t), success: (r) => items[r.tapIndex] && items[r.tapIndex].fn(), fail() {} });
  },
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
    this.show(path, { photoNew: true });
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
    this.show(r.pendingUrl || r.url || '', { photoNew: false });
  },
  previewPhoto() {
    const u = this.data.photoShow || this.data.photoBase;
    if (u) wx.previewImage({ urls: [u], showmenu: false });
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
      this.setData({ photoShow: '', photoBase: '', photoNew: false, hasPhoto: false, stateText: '', photoState: '' });
      (db.playersShared || db.fetchPlayersFull)().catch(() => {}); // 刷新照片名单（写操作已作废缓存；只为预热，不用复制）
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
    this.show(square, { photoNew: false, hasPhoto: true, stateText: STATE_TEXT.checking, photoState: 'checking' });
  },

  /* ---------- 公开展示授权 ---------- */
  // 弹出授权说明，同意后勾上；已经有资料的马上保存到云端（第一次设置资料的，点「完成」时一起保存）
  async agree(title) {
    const yes = await new Promise((done) => wx.showModal({ title: title || C.TITLE, content: C.TEXT, confirmText: '同意', cancelText: '取消', success: (x) => done(x.confirm), fail: () => done(false) }));
    if (!yes) return false;
    if (!this.data.isNew && !(await this.applyShown(true))) return false;
    // 还没拿到云端资料（isNew 为真）时只在本地勾了、没发云端：如果随后 fill 把 isNew 改成了 false，点保存仍要带上这次勾选
    this.shownPending = this.data.isNew;
    this.touch('shown');
    this.setData({ shown: true, shownOld: false });
    return true;
  },
  // 只同意过旧版说明的老成员：看新说明，点同意就记成新版（取消什么都不改，小程序里照常展示）
  confirmNew() {
    if (this.data.saving) return Promise.resolve(false);
    return this.agree('公开展示说明更新');
  },
  async applyShown(on) {
    wx.showLoading({ title: '保存中', mask: true });
    try {
      await db.setShown(on);
      (db.playersShared || db.fetchPlayersFull)().catch(() => {}); // 刷新照片名单和排行（只为预热，不用复制）
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
    if (this.data.isNew) { this.shownPending = true; this.touch('shown'); this.setData({ shown: false }); return; }
    const off = await new Promise((done) => wx.showModal({ title: '关闭公开展示', content: '关闭后，其他成员看不到你的照片，排行榜里也不显示你；你的照片会保留，重新开启后恢复显示。', confirmText: '关闭', cancelText: '取消', success: (x) => done(x.confirm), fail: () => done(false) }));
    if (off && (await this.applyShown(false))) { this.shownPending = false; this.touch('shown'); this.setData({ shown: false, shownOld: false }); wx.showToast({ title: '已关闭', icon: 'success' }); }
  },

  /* ---------- 文字 ---------- */
  // type="nickname" 的输入框：键盘上方会出现「用微信昵称」
  onName(e) { this.touch('name'); this.setData({ name: e.detail.value }); },
  pickGender(e) { this.touch('gender'); this.setData({ gender: e.currentTarget.dataset.v }); },
  pickLevel(e) { this.touch('level'); this.setData({ level: Number(e.currentTarget.dataset.v) }); },

  // 刚加入时：设置完（或稍后再设置）回到加入前要去的页面（例如分享的活动），没有就去活动 tab；和准入页 enter 一样
  goOn() {
    let to = '';
    try { to = wx.getStorageSync('after_gate') || ''; wx.removeStorageSync('after_gate'); } catch (e) {}
    const home = '/pages/draw/draw';
    wx.reLaunch({ url: to || home, fail: () => { if (to) wx.reLaunch({ url: home }); } });
  },
  later() { if (!this.data.saving) this.goOn(); },

  async save() {
    const name = (this.data.name || '').trim();
    if (!name) { wx.showToast({ title: '请填写昵称', icon: 'none' }); return; }
    if (name.length > 10) { wx.showToast({ title: '昵称最多 10 个字', icon: 'none' }); return; }
    if (this.data.gender !== 'm' && this.data.gender !== 'f') { wx.showToast({ title: '请选择性别', icon: 'none' }); return; }
    if (this.data.saving) return;
    this.setData({ saving: true }); // 先上锁：连点「完成」不会弹两个询问框
    let step = '资料';
    try {
      // 第一次建资料、完全没碰过公开展示勾选项：温和问一次（2026-11-25 用户要求，免得漏勾后在排行榜、LULU 积分里看不到自己）。
      // 仍然不默认勾选、不强制：选「暂不开启」或关掉弹窗照常保存（shown: false）；自己点过勾选（哪怕又取消）、老成员改资料都不问
      if (this.data.isNew && !this.data.shown && !(this.edited && this.edited.shown)) {
        const yes = await new Promise((done) => wx.showModal({ title: '是否开启公开展示？', content: C.TEXT, confirmText: '开启展示', cancelText: '暂不开启', success: (x) => done(!!(x && x.confirm)), fail: () => done(false) }));
        this.touch('shown');
        if (yes) { this.shownPending = true; this.setData({ shown: true }); } // 即使弹窗期间云端资料晚到把 isNew 改成 false，点保存仍要带上这次开启
      }
      wx.showLoading({ title: '保存中', mask: true });
      // 先保存资料（第一次设置时要先有资料才能传照片），再上传照片提交检测
      const sendShown = this.data.isNew || !!this.shownPending;
      await db.saveMyProfile({ name, avatar: this.avatar, level: this.data.level, gender: this.data.gender, shown: sendShown ? !!this.data.shown : undefined }); // 第一次设置资料（或进页还没读完时就点了勾选）：带上勾选结果（不勾就是不同意，不强制）；已有资料的授权在勾选时已经单独保存，这里不带，免得旧缓存覆盖
      // 资料已经建好：之后（例如照片没传上去再点保存重试、单独换照片）都按「已有资料」处理，不再当第一次设置
      this.shownPending = false;
      if (this.data.isNew) this.setData({ isNew: false });
      const withPhoto = !!this.photoTemp;
      if (withPhoto) { step = '照片'; wx.showLoading({ title: '上传照片', mask: true }); await this.uploadPhoto(); }
      wx.hideLoading();
      if (withPhoto) {
        await new Promise((done) => wx.showModal({ title: '已保存', content: '你现在就能看到新照片；照片检测通过后，其他球友也能看到（一般几分钟内）。', showCancel: false, complete: done }));
      } else wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => {
        if (this.fromGate) this.goOn();
        else if (getCurrentPages().length > 1) wx.navigateBack();
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
