const db = require('../../utils/db');
const R = require('../../utils/rating');
const RV = require('../../utils/reviews');
const { colorOf, initialOf } = require('../../utils/rules');

Page({
  data: { a: null, b: null, ok: true, reason: '', chance: 50, isMine: false, loaded: false },

  onLoad(o) {
    this.from = decodeURIComponent(o.from || '');
    this.to = decodeURIComponent(o.to || '');
    this.load();
  },

  async load() {
    let matches = db.cachedMatches(), players = db.cachedPlayersFull(), me = db.cachedProfile();
    try { [matches, players, me] = await Promise.all([db.fetchMatches(), db.fetchPlayersFull(), db.getMyProfile()]); } catch (e) { console.error(e); }
    const ratings = R.computeRatings(matches, R.startLevelsFrom(players));
    const card = (name) => {
      const p = players.find((x) => x.name === name) || {};
      const r = ratings.players[name];
      const level = R.levelOf(ratings, name, players);
      return {
        name, uid: p.uid || '', avatar: p.avatar || '', initial: initialOf(name), color: colorOf(name),
        level: R.fmt(level), raw: level, tier: R.tierOf(level), provisional: !r || r.provisional,
      };
    };
    const a = card(this.from), b = card(this.to);
    const ok = R.canChallenge(a.raw, b.raw);
    const h2h = matches.filter((m) => {
      const all = (m.a || []).concat(m.b || []);
      return m.type !== 'double' && all.indexOf(a.name) >= 0 && all.indexOf(b.name) >= 0;
    });
    const aWins = h2h.filter((m) => (m.winner === 'a' ? m.a : m.b).indexOf(a.name) >= 0).length;
    this.setData({
      a, b, ok, loaded: true,
      isMine: !!me && me.name === a.name,
      chance: Math.round(R.winChance(a.raw, b.raw) * 100),
      reason: ok ? '' : `${a.name} 的水平比 ${b.name} 高出 ${(a.raw - b.raw).toFixed(2)}，超过了 ${R.CHALLENGE_DOWN}。为了公平（防炸鱼），不能向低级别发起挑战，可以等对方来挑战你。`,
      h2h: h2h.length ? `历史交手 ${h2h.length} 场：${a.name} ${aWins} 胜 ${h2h.length - aWins} 负` : '还没有交手过',
      gain: ok ? this.preview(a.raw, b.raw) : '',
    });
    RV.summary([a.uid, b.uid]).then((rep) => { if (rep) this.setData({ repA: a.uid ? rep[a.uid] : null, repB: b.uid ? rep[b.uid] : null }); });
  },

  // 预估：4:2 赢一盘大概涨多少
  preview(ra, rb) {
    const E = R.expectedShare(ra, rb);
    const d = 0.6 * (4 / 6 - E) * 0.6;
    return d > 0 ? `如果 ${this.from} 以 4:2 赢下一盘，水平约 +${d.toFixed(2)}` : '';
  },

  goRecord() {
    try { wx.setStorageSync('prefill_match', { a: [this.from], b: [this.to] }); } catch (e) {}
    wx.navigateTo({ url: '/pages/add/add' });
  },
  goHome() { wx.switchTab({ url: '/pages/rank/rank' }); },

  onShareAppMessage() {
    return {
      title: `${this.from}（${this.data.a ? this.data.a.level : ''}）向你发起挑战！`,
      path: `/pages/challenge/challenge?from=${encodeURIComponent(this.from)}&to=${encodeURIComponent(this.to)}`,
    };
  },
});
