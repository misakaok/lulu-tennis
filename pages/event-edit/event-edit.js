// 编辑活动信息（仅管理员）：手动名称、日期、开始时间、场地编号、定位
const db = require('../../utils/db');
const E = require('../../utils/event');

Page({
  data: { loading: true, error: '', title: '', value: null, saving: false },

  onLoad(o) { this.id = o.id; this.load(); },

  async load() {
    try {
      const [d, member] = await Promise.all([db.getDraw(this.id), require('../../utils/member').status()]);
      const myId = member.uid;
      const owner = !!myId && d._openid === myId;
      if (member.status !== 'active' || !member.isAdmin) throw new Error('只有管理员可以编辑活动');
      if (!owner) wx.setNavigationBarTitle({ title: '编辑活动（管理员）' });
      this.info = null;
      this.setData({
        loading: false, title: d.title || '',
        value: { date: d.date, startTime: d.startTime || '', venue: d.venue || '', location: d.location || null },
      });
    } catch (e) {
      console.error(e);
      this.setData({ loading: false, error: e.message || '加载失败' });
    }
  },

  onTitle(e) { this.setData({ title: e.detail.value }); },
  onInfo(e) { this.info = e.detail; },

  async save() {
    if (this.data.saving || !this.info) return;
    const i = this.info;
    const title = this.data.title.trim();
    if (!title || title.length > E.TITLE_MAX) {
      wx.showToast({ title: title ? `比赛名称最多 ${E.TITLE_MAX} 个字` : '请填写比赛名称', icon: 'none' });
      return;
    }
    this.setData({ saving: true });
    try {
      await db.updateDrawInfo(this.id, {
        title, date: i.date, startTime: i.startTime || '', venue: E.courtOf(i.venue), location: E.locationOf(i.location),
      });
      wx.showToast({ title: '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (e) {
      console.error(e);
      wx.showModal({ title: '保存失败', content: e.message || '请稍后再试', showCancel: false });
    } finally {
      this.setData({ saving: false });
    }
  },
});
