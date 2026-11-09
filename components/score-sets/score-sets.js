const R = require('../../utils/rules');

const emptySet = () => ({ a: 0, b: 0, tbA: '', tbB: '' });
const fromRecord = (s) => ({
  a: s.a, b: s.b,
  tbA: s.tbA === undefined ? '' : String(s.tbA), tbB: s.tbB === undefined ? '' : String(s.tbB),
});

// 局分录入：每盘 +/−，3:3（6 局制 6:6）时多出两个抢七小分格子
// 每次修改都会触发 change 事件，detail 是 rules.checkMatch 的结果
Component({
  options: { addGlobalClass: true },
  properties: {
    setGames: { type: Number, value: 4 },
    noAd: { type: Boolean, value: true },
    bestOf: { type: Number, value: 3 },
    aLabel: { type: String, value: 'A 方' },
    bLabel: { type: String, value: 'B 方' },
    init: { type: Array, value: [] }, // 修改已有比分时传入原来的局分
  },
  data: { setsView: [], canAddSet: false, tbLabel: '', tbHint: '' },

  lifetimes: {
    attached() {
      if (!this.sets) this.sets = this.data.init && this.data.init.length ? this.data.init.map(fromRecord) : [emptySet()];
      this.refresh();
    },
  },

  observers: {
    'setGames, noAd'() {
      if (!this.sets) return;
      const cfg = this.cfg(), max = R.maxGames(cfg);
      this.sets.forEach((s) => {
        s.a = Math.min(s.a, max); s.b = Math.min(s.b, max);
        if (!R.needTiebreak(s.a, s.b, cfg)) { s.tbA = ''; s.tbB = ''; }
      });
      this.refresh();
    },
    bestOf(v) {
      if (!this.sets) return;
      if (v === 1) this.sets = this.sets.slice(0, 1);
      this.refresh();
    },
    init(v) {
      if (v && v.length) { this.sets = v.map(fromRecord); this.refresh(); }
    },
  },

  methods: {
    cfg() { return { setGames: this.data.setGames, noAd: this.data.noAd }; },

    reset() { this.sets = [emptySet()]; this.refresh(); },

    refresh() {
      if (!this.sets) this.sets = [emptySet()];
      const cfg = this.cfg();
      const res = R.checkMatch(this.sets, this.data.bestOf, cfg);
      const T = R.tbAt(cfg);
      this.setData({
        setsView: this.sets.map((s) => {
          const c = R.cleanSet(s, cfg); // 3:3 填了小分后，赢家显示高亮
          return { a: s.a, b: s.b, tbA: s.tbA, tbB: s.tbB, needTb: R.needTiebreak(s.a, s.b, cfg), aw: c.a > c.b, bw: c.b > c.a };
        }),
        canAddSet: this.data.bestOf === 3 && this.sets.length < 3 && !!res.undecided,
        tbLabel: `${T}:${T} 抢七小分`,
        tbHint: cfg.noAd ? `先到 ${R.TB_TO} 分，净胜 1 分即赢` : `先到 ${R.TB_TO} 分且领先 2 分`,
      });
      this.triggerEvent('change', res);
    },

    step(e) {
      const { i, side, d } = e.currentTarget.dataset;
      const cfg = this.cfg(), s = this.sets[i];
      s[side] = Math.max(0, Math.min(R.maxGames(cfg), s[side] + Number(d)));
      if (!R.needTiebreak(s.a, s.b, cfg)) { s.tbA = ''; s.tbB = ''; }
      this.refresh();
    },

    onTb(e) {
      const { i, side } = e.currentTarget.dataset;
      this.sets[i][side === 'a' ? 'tbA' : 'tbB'] = e.detail.value;
      this.refresh();
    },

    addSet() { this.sets.push(emptySet()); this.refresh(); },
    removeSet(e) { this.sets.splice(Number(e.currentTarget.dataset.i), 1); this.refresh(); },
  },
});
