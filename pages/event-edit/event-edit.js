// 编辑赛事信息（只有发起人）：名称、日期、开始时间、场地、地址、定位、联系人
const db = require('../../utils/db');
const cloud = require('../../utils/cloud');

Page({
  data: { loading: true, error: '', title: '', value: null, saving: false, contactNote: '' },

  onLoad(o) { this.id = o.id; this.load(); },

  async load() {
    try {
      const [d, owner] = await Promise.all([db.getDraw(this.id), db.isMine('draws', this.id)]);
      if (!owner) throw new Error('只有赛事发起人可以编辑');
      let contact = null, contactNote = '';
      try {
        const c = await cloud.call('getContact', { drawId: this.id });
        if (c.has) contact = { name: c.name, phone: c.phone, wechat: c.wechat, visibility: c.visibility };
      } catch (e) { contactNote = e.message; }
      this.info = null;
      this.setData({
        loading: false, title: d.title || '', contactNote,
        value: { date: d.date, startTime: d.startTime || '', venue: d.venue || '', address: d.address || '', location: d.location || null, contact },
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
    if (!title) { wx.showToast({ title: '请填写赛事名称', icon: 'none' }); return; }
    this.setData({ saving: true });
    try {
      const ok = await db.updateDraw(this.id, {
        title, date: i.date, startTime: i.startTime || '', venue: (i.venue || '').trim(), address: (i.address || '').trim(),
        location: i.location ? db.cmdSet(i.location) : null,
      });
      if (!ok) throw new Error('只有赛事发起人可以编辑');
      await cloud.call('saveContact', { drawId: this.id, contact: i.contact });
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
