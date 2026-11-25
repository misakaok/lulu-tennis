// 编辑活动信息（仅管理员）：手动名称、日期、开始时间、场地编号、定位、建议水平
const db = require('../../utils/db');
const E = require('../../utils/event');

Page({
  data: { loading: true, error: '', title: '', value: null, saving: false },

  onLoad(o) { this.id = o.id; this.preview(); this.load(); },

  // 从活动详情点「编辑」进来（2026-11-24 用户嫌打开慢）：本机 24 小时内确认过是管理员，就先用活动详情刚读到的活动
  //   （内存里 60 秒，db.peekDrawDetail）填好表单；云端身份和活动读完后，内容没变就不动（免得冲掉正在改的），
  //   变了再重填，不是管理员就收起。保存仍由云端 updateDrawInfo 校验
  preview() {
    const M = require('../../utils/member');
    if (!M.knownActive() || !M.isAdminLocal()) return;
    const pre = db.peekDrawDetail(this.id);
    if (pre && pre.draw) this.fill(pre.draw, db.cachedOpenid());
  },

  async load() {
    try {
      const [d, member] = await Promise.all([db.getDraw(this.id), require('../../utils/member').status()]);
      if (member.status !== 'active' || !member.isAdmin) throw new Error('只有管理员可以编辑活动');
      this.fill(d, member.uid);
    } catch (e) {
      console.error(e);
      this.shownSig = '';
      this.setData({ loading: false, error: e.message || '加载失败', value: null });
    }
  },

  fill(d, myId) {
    const owner = !!myId && d._openid === myId;
    const title = d.title || '';
    const value = { date: d.date, startTime: d.startTime || '', venue: d.venue || '', location: d.location || null, place: d.place || null, level: E.levelRangeOf(d.level) };
    const sig = JSON.stringify([title, value, owner]);
    if (sig === this.shownSig) return; // 和已经填好的一样：不重填
    this.shownSig = sig;
    wx.setNavigationBarTitle({ title: owner ? '编辑活动信息' : '编辑活动（管理员）' });
    this.info = null;
    this.setData({ loading: false, error: '', title, value });
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
    const levelErr = E.levelError(i.level);
    if (levelErr) { wx.showToast({ title: levelErr, icon: 'none' }); return; }
    this.setData({ saving: true });
    try {
      // 建议水平每次都明确带上：null = 清空（云端只有没收到这个字段时才保留原值，给旧版小程序用）
      const r = await db.updateDrawInfo(this.id, {
        title, date: i.date, startTime: i.startTime || '', venue: E.courtOf(i.venue), location: E.locationOf(i.location), place: E.placeOf(i.place),
        level: E.levelRangeOf(i.level),
      });
      wx.showToast(r && r.placeDropped ? { title: '已保存。地点名称没通过安全检测，只保存了地图位置', icon: 'none', duration: 2500 } : { title: '已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (e) {
      console.error(e);
      wx.showModal({ title: '保存失败', content: e.message || '请稍后再试', showCancel: false });
    } finally {
      this.setData({ saving: false });
    }
  },
});
