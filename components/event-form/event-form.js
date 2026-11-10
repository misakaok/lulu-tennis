// 活动信息表单（创建球友活动和编辑活动共用）：日期、开始时间、场地、地图定位、联系人
// 联系人不写进 draws（draws 所有人可读），由页面通过云函数单独保存，按可见范围返回
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const EMPTY = {
  date: '', startTime: '', venue: '', location: null,
  contact: { name: '', phone: '', wechat: '', visibility: 'participants' },
};

Component({
  options: { addGlobalClass: true },
  properties: {
    value: { type: Object, value: null, observer: 'init' },
  },
  data: { v: EMPTY, today: '', locText: '' },
  lifetimes: { attached() { if (!this.inited) this.init(this.data.value); } },
  methods: {
    init(val) {
      this.inited = true;
      const v = Object.assign({}, EMPTY, val || {});
      v.contact = Object.assign({}, EMPTY.contact, (val && val.contact) || {});
      if (!v.date) v.date = today();
      this.setData({ v, today: today(), locText: this.locText(v.location) });
      this.emit();
    },
    locText(l) { return l ? (l.name || l.address || '已选位置') : ''; },
    emit() { this.triggerEvent('change', JSON.parse(JSON.stringify(this.data.v))); },
    set(path, value) { this.setData({ ['v.' + path]: value }); this.emit(); },

    onDate(e) { this.set('date', e.detail.value); },
    onTime(e) { this.set('startTime', e.detail.value); },
    onInput(e) { this.set(e.currentTarget.dataset.k, e.detail.value); },
    setVis(e) { this.set('contact.visibility', e.currentTarget.dataset.v); },

    // 地图选点：需要在 app.json 声明 requiredPrivateInfos: ["chooseLocation"]
    pickLocation() {
      wx.chooseLocation({
        success: (r) => {
          const loc = { latitude: r.latitude, longitude: r.longitude, name: r.name || '', address: r.address || '' };
          const data = { 'v.location': loc };
          if (!this.data.v.venue && r.name) data['v.venue'] = r.name;
          this.setData(Object.assign(data, { locText: this.locText(loc) }));
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
