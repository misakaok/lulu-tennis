// 编辑球员资料：照片（相册 / 拍照，1:1 裁剪预览；微信头像分辨率太低，已去掉这个入口）、昵称、性别、网球等级（自评）、个人简介
// 比赛场数、胜率、排名由比赛记录自动计算，这里不能改。
// 所有关联（战绩、报名、评价）都按用户 ID，改昵称或换照片不影响。
const db = require('../../utils/db');
const cloud = require('../../utils/cloud');
const R = require('../../utils/rating');
const C = require('../../utils/compress');

const BIO_MAX = 60;

Page({
  data: {
    avatarShow: '', name: '', gender: '', level: R.DEFAULT_LEVEL, levels: R.SELF_LEVELS,
    bio: '', bioMax: BIO_MAX, isNew: true, saving: false, tip: '', photoNew: false, canRecrop: false,
  },

  onLoad(options) {
    this.fromSignup = options && options.from === 'signup';
    const p = db.cachedProfile();
    if (p) this.fill(p);
    if (this.fromSignup) this.setData({ tip: '报名前请先设置照片和昵称，大家在报名名单里会看到' });
    db.getMyProfile().then((x) => { if (x) this.fill(x); }).catch((e) => console.error(e));
    this.loadBio();
  },

  fill(p) {
    this.avatar = p.avatar || '';
    const d = { name: p.name || '', gender: p.gender || '', level: typeof p.level === 'number' ? p.level : R.DEFAULT_LEVEL, isNew: false };
    if (!this.avatarTemp) d.avatarShow = p.avatar || ''; // 已经选了新照片就不要被覆盖
    this.setData(d);
  },

  async loadBio() {
    try {
      const uid = await db.myOpenid();
      const r = await cloud.call('getBios', { ids: [uid] });
      this.bio0 = r.bios[uid] || '';
      if (!this.bioTouched) this.setData({ bio: this.bio0 });
    } catch (e) { this.bio0 = null; } // 云函数不可用：保存时不动简介
  },

  /* ---------- 照片 ---------- */
  // 从相册选或拍照 → 1:1 裁剪 → 预览（保存时才上传）
  pickAlbum() { this.pick('album'); },
  pickCamera() { this.pick('camera'); },
  pick(source) {
    wx.chooseMedia({
      count: 1, mediaType: ['image'], sourceType: [source], sizeType: ['original'], camera: 'front', // 取原图：裁剪后由 utils/compress.js 统一压缩，避免微信先压一遍再裁导致模糊
      success: (r) => {
        const f = r.tempFiles && r.tempFiles[0];
        if (f) this.crop(f.tempFilePath);
      },
      fail: (e) => {
        if (/cancel/.test(e.errMsg || '')) return;
        wx.showModal({ title: source === 'camera' ? '无法打开相机' : '无法打开相册', content: '请在小程序设置里允许使用相机 / 相册。', showCancel: false });
      },
    });
  },
  crop(src) {
    this.cropSrc = src;
    if (!wx.cropImage) { // 基础库低于 2.26.0 没有裁剪：直接用原图，显示时按正方形居中
      this.setPhoto(src, src);
      wx.showToast({ title: '当前微信版本不支持裁剪，已使用原图', icon: 'none' });
      return;
    }
    wx.cropImage({
      src, cropScale: '1:1',
      success: (r) => this.setPhoto(r.tempFilePath, src),
      fail: (e) => { if (!/cancel/.test(e.errMsg || '')) wx.showToast({ title: '裁剪失败，请重试', icon: 'none' }); },
    });
  },
  recrop() { if (this.cropSrc) this.crop(this.cropSrc); },
  setPhoto(tempPath, cropSrc) {
    this.avatarTemp = tempPath;
    this.cropSrc = cropSrc || '';
    this.setData({ avatarShow: tempPath, photoNew: true, canRecrop: !!cropSrc && !!wx.cropImage });
  },
  undoPhoto() {
    this.avatarTemp = '';
    this.cropSrc = '';
    this.setData({ avatarShow: this.avatar || '', photoNew: false, canRecrop: false });
  },

  /* ---------- 文字 ---------- */
  // type="nickname" 的输入框：键盘上方会出现「用微信昵称」
  onName(e) { this.setData({ name: e.detail.value }); },
  pickGender(e) { this.setData({ gender: e.currentTarget.dataset.v }); },
  pickLevel(e) { this.setData({ level: Number(e.currentTarget.dataset.v) }); },
  onBio(e) { this.bioTouched = true; this.setData({ bio: e.detail.value }); },

  async save() {
    const name = (this.data.name || '').trim();
    const bio = (this.data.bio || '').replace(/\s+/g, ' ').trim();
    if (!this.data.avatarShow) { wx.showToast({ title: '请先选择一张照片', icon: 'none' }); return; }
    if (!name) { wx.showToast({ title: '请填写昵称', icon: 'none' }); return; }
    if (name.length > 10) { wx.showToast({ title: '昵称最多 10 个字', icon: 'none' }); return; }
    if (bio.length > BIO_MAX) { wx.showToast({ title: `简介最多 ${BIO_MAX} 字`, icon: 'none' }); return; }
    if (this.data.saving) return;
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中', mask: true });
    try {
      // 简介先过内容安全检测：不通过就整体不保存，方便用户修改
      if (this.bioTouched && bio !== (this.bio0 || '')) {
        if (this.bio0 === null && !bio) { /* 云函数不可用且没填简介：跳过 */ } else {
          await cloud.call('saveBio', { bio });
          this.bio0 = bio;
        }
      }
      // 球员照片：先裁成正方形（选图时已裁），再压缩到 ≤800px；压缩失败不上传原图
      let temp = this.avatarTemp;
      if (temp) {
        try { temp = (await C.compress(temp, 'avatar')).path; }
        catch (ce) { console.error('照片压缩失败', ce); throw new Error('照片压缩失败，请重试'); }
      }
      await db.saveMyProfile({ name, avatar: this.avatar, avatarTemp: temp, level: this.data.level, gender: this.data.gender });
      this.avatarTemp = '';
      wx.hideLoading();
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => {
        if (getCurrentPages().length > 1) wx.navigateBack();
        else wx.switchTab({ url: '/pages/me/me' });
      }, 600);
    } catch (e) {
      wx.hideLoading();
      console.error(e);
      wx.showModal({ title: '保存失败', content: e.message || '请稍后再试', showCancel: false });
    } finally {
      this.setData({ saving: false });
    }
  },
});
