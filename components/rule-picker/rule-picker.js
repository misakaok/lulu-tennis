// 一套比赛规则：每盘局数（4 / 6 局制）、抢七（金球 / 占先）、盘数（一盘 / 三盘两胜）
Component({
  options: { addGlobalClass: true },
  properties: {
    value: { type: Object, value: { setGames: 4, noAd: true, bestOf: 1 } },
    disabled: { type: Boolean, value: false },
  },
  methods: {
    set(e) {
      if (this.data.disabled) return;
      const { k, v } = e.currentTarget.dataset;
      const val = Object.assign({ setGames: 4, noAd: true, bestOf: 1 }, this.data.value);
      val[k] = k === 'noAd' ? v === '1' : Number(v);
      this.triggerEvent('change', val);
    },
  },
});
