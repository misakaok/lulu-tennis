// 活动信息表单（创建球友活动和编辑活动共用）：日期、开始时间、场地、地图定位、建议水平
const E = require('../../utils/event');
const R = require('../../utils/rating');
const PL = require('../../utils/places');
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

const EMPTY = { date: '', startTime: '', venue: '', location: null, place: null, level: null };
// 建议水平的选项沿用自评等级（下拉里带说明，选完只显示数字）
const LEVEL_VALUES = R.SELF_LEVELS.map((x) => x.v);
const LEVEL_OPTS = R.SELF_LEVELS.map((x) => x.t);

Component({
  options: { addGlobalClass: true },
  properties: {
    value: { type: Object, value: null, observer: 'init' },
    // 最近使用的地点（新建活动页传入，utils/places.js 的 recentPlaces）：点选直接填回位置和地点名称，不打开地图
    recent: { type: Array, value: [] },
  },
  data: { v: EMPTY, today: '', locText: '', locKey: '', courts: E.COURTS.map((c) => c || '待定'), courtIndex: 0, levelOpts: LEVEL_OPTS, levelView: null },
  lifetimes: { attached() { if (!this.inited) this.init(this.data.value); } },
  methods: {
    init(val) {
      this.inited = true;
      const v = Object.assign({}, EMPTY, val || {});
      v.venue = E.courtOf(v.venue);
      v.location = E.locationOf(v.location);
      v.place = v.location ? E.placeOf(v.place) : null; // 只认云端检测过的 draws.place，不认旧的 location.name
      v.level = E.levelRangeOf(v.level); // 旧活动没有、或不合法的按没设置
      if (!v.date) v.date = today();
      this.setData({ v, today: today(), locText: this.locText(v.location, v.place), locKey: PL.keyOf(v.location), courtIndex: E.COURTS.indexOf(v.venue), levelView: this.levelView(v.level) });
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
    // 已经选了位置时，地图打开就停在这个位置：只有坐标、没有名称的（以前的活动）点一下球场就能补上名称
    pickLocation() {
      const cur = this.data.v.location;
      wx.chooseLocation(Object.assign(cur ? { latitude: cur.latitude, longitude: cur.longitude } : {}, {
        success: (r) => {
          const loc = E.locationOf(r);
          // 地点名称和地址一起提交；保存时云端先做内容检测，通过才保存、给成员看
          const place = loc ? E.placeOf(r) : null;
          this.setLocation(loc, place);
        },
        fail: (e) => {
          if (/cancel/.test(e.errMsg || '')) return;
          wx.showModal({ title: '无法打开地图', content: '请在小程序设置里允许使用位置信息。', showCancel: false });
        },
      }));
    },
    clearLocation() { this.setLocation(null, null); },
    setLocation(loc, place) {
      this.setData({ 'v.location': loc, 'v.place': loc ? place : null, locText: this.locText(loc, place), locKey: PL.keyOf(loc) });
      this.emit();
    },
    // 选最近使用的地点：只填位置和地点名称（场地编号不跟着带过来）；保存时照样由云端检测地点文字
    pickRecent(e) {
      const r = (this.data.recent || [])[Number(e.currentTarget.dataset.i)];
      const loc = r && E.locationOf(r.location);
      if (!loc) return;
      this.setLocation(loc, E.placeOf(r.place));
    },

    // 建议水平：只选了一头时另一头跟着取同一档；最低选得比最高还高（或反过来）时，另一头跟过去，保证最低 ≤ 最高
    levelView(l) {
      return l ? { min: R.fmt(l.min), max: R.fmt(l.max), minIndex: LEVEL_VALUES.indexOf(l.min), maxIndex: LEVEL_VALUES.indexOf(l.max) } : null;
    },
    setLevel(level) {
      const l = E.levelRangeOf(level);
      this.setData({ 'v.level': l, levelView: this.levelView(l) });
      this.emit();
    },
    onLevelMin(e) {
      const min = LEVEL_VALUES[Number(e.detail.value)], cur = this.data.v.level;
      if (min === undefined) return;
      this.setLevel({ min, max: cur && cur.max >= min ? cur.max : min });
    },
    onLevelMax(e) {
      const max = LEVEL_VALUES[Number(e.detail.value)], cur = this.data.v.level;
      if (max === undefined) return;
      this.setLevel({ min: cur && cur.min <= max ? cur.min : max, max });
    },
    clearLevel() { this.setLevel(null); },
  },
});
