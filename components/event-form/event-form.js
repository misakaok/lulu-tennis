// 活动信息表单（创建球友活动和编辑活动共用）：日期、开始时间、场地、地图定位
const E = require('../../utils/event');
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const EMPTY = { date: '', startTime: '', venue: '', location: null, place: null };

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
      v.place = v.location ? E.placeOf(v.place) : null; // 只认云端检测过的 draws.place，不认旧的 location.name
      if (!v.date) v.date = today();
      this.setData({ v, today: today(), locText: this.locText(v.location, v.place), courtIndex: E.COURTS.indexOf(v.venue) });
      this.emit();
    },
    locText(l, p) { return l ? (p && (p.name || p.address)) || '已选择地图位置' : ''; },
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
          // 地点名称和地址一起提交；保存时云端先做内容检测，通过才保存、给成员看
          const place = loc ? E.placeOf(r) : null;
          this.setData({ 'v.location': loc, 'v.place': place, locText: this.locText(loc, place) });
          this.emit();
        },
        fail: (e) => {
          if (/cancel/.test(e.errMsg || '')) return;
          wx.showModal({ title: '无法打开地图', content: '请在小程序设置里允许使用位置信息。', showCancel: false });
        },
      });
    },
    clearLocation() { this.setData({ 'v.location': null, 'v.place': null, locText: '' }); this.emit(); },
  },
});
