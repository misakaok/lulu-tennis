// 编辑球员资料：昵称、性别、网球等级（自评）。不上传照片、不填简介（个人主体小程序不能有用户生成内容的分享）
// 比赛场数、胜率、排名由比赛记录自动计算，这里不能改。
// 所有关联（战绩、报名）都按用户 ID，改昵称不影响。
const db = require('../../utils/db');
const R = require('../../utils/rating');

Page({
  data: {
    name: '', gender: '', level: R.DEFAULT_LEVEL, levels: R.SELF_LEVELS, isNew: true, saving: false, tip: '',
  },

  onLoad(options) {
    this.fromSignup = options && options.from === 'signup';
    const p = db.cachedProfile();
    if (p) this.fill(p);
    if (this.fromSignup) this.setData({ tip: '报名前请先设置昵称，大家在报名名单里会看到' });
    db.getMyProfile().then((x) => { if (x) this.fill(x); }).catch((e) => console.error(e));
  },

  fill(p) {
    this.avatar = p.avatar || ''; // 以前传过的照片：不显示，保存时原样带回
    this.setData({ name: p.name || '', gender: p.gender || '', level: typeof p.level === 'number' ? p.level : R.DEFAULT_LEVEL, isNew: false });
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
    if (this.data.saving) return;
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中', mask: true });
    try {
      await db.saveMyProfile({ name, avatar: this.avatar, level: this.data.level, gender: this.data.gender });
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
