// 活动信息表单（创建球友活动和编辑活动共用）：日期、开始时间、场地、地图定位
const E = require('../../utils/event');
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const EMPTY = { date: '', startTime: '', venue: '', location: null };

Component({
  options: { addGlobalClass: true },
  properties: {
    value: { type: Object, value: null, observer: 'init' },
  },
  data: { v: EMPTY, today: '', locText: '', courts: E.COURTS.map((c) => c || '待定'), courtIndex: 0 },
  lifetimes: { attached() { if (!this.inited) this.init(this.data.value); } },
  methods: {
    init(val) {
      this.inited = true;
      const v = Object.assign({}, EMPTY, val || {});
      v.venue = E.courtOf(v.venue);
      v.location = E.locationOf(v.location);
      if (!v.date) v.date = today();
      this.setData({ v, today: today(), locText: this.locText(v.location), courtIndex: E.COURTS.indexOf(v.venue) });
      this.emit();
    },
    locText(l) { return l ? '已选择地图位置' : ''; },
    emit() { this.triggerEvent('change', JSON.parse(JSON.stringify(this.data.v))); },
    set(path, value) { this.setData({ ['v.' + path]: value }); this.emit(); },

    onDate(e) { this.set('date', e.detail.value); },
    onTime(e) { this.set('startTime', e.detail.value); },
    onCourt(e) {
      const courtIndex = Number(e.detail.value);
      this.setData({ courtIndex });
      this.set('venue', E.COURTS[courtIndex] || '');
    },

    // 地图选点：需要在 app.json 声明 requiredPrivateInfos: ["chooseLocation"]
    pickLocation() {
      wx.chooseLocation({
        success: (r) => {
          const loc = E.locationOf(r);
          this.setData({ 'v.location': loc, locText: this.locText(loc) });
          this.emit();
        },
        fail: (e) => {
          if (/cancel/.test(e.errMsg || '')) return;
          wx.showModal({ title: '无法打开地图', content: '请在小程序设置里允许使用位置信息。', showCancel: false });
        },
      });
    },
    clearLocation() { this.setData({ 'v.location': null, locText: '' }); this.emit(); },
  },
});
