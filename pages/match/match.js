// 比赛详情（战绩列表 / 我的待办点进来）：比分 + 赛果确认 + 对手互评
const db = require('../../utils/db');
const ID = require('../../utils/ident');
const OF = require('../../utils/official');
const E = require('../../utils/event');
const { colorOf, initialOf } = require('../../utils/rules');

Page({
  data: { loading: true, error: '', m: null, revocable: false },
  onLoad(o) { this.id = o.id; this.load(); },

  async load() {
    try {
      const [raw, players, myId, ver] = await Promise.all([
        db.getMatch(this.id), db.fetchPlayersFull().catch(() => db.cachedPlayersFull()), db.myOpenid().catch(() => ''),
        db.getVerified(this.id),
      ]);
      const status = raw ? OF.statusOf(raw, ver ? { [this.id]: ver } : {}) : '';
      const m = raw ? ID.normalizeMatches([raw], players)[0] : null; // 有 ID 的位置显示当前昵称
      if (!m) throw new Error('比赛记录不存在，可能已被撤销');
      const av = {};
      players.forEach((p) => { av[p.name] = p.avatar; });
      const side = (k) => (m[k] || []).map((n) => ({ name: n, avatar: av[n] || '', initial: initialOf(n), color: colorOf(n) }));
      let revocable = !!myId && (m._openid || m.recordedBy) === myId;
      if (!revocable && m.drawId) revocable = await db.isMine('draws', m.drawId).catch(() => false);
      this.setData({
        loading: false,
        revocable,
        status,
        m: {
          _id: m._id, date: m.date, winner: m.winner, drawId: m.drawId || '',
          event: m.drawTitle ? `${m.drawTitle}${m.stage ? ' · ' + m.stage : ''}` : '',
          format: E.formatText(E.cfgOf(m)),
          a: side('a'), b: side('b'), aText: (m.a || []).join(' / '), bText: (m.b || []).join(' / '),
          sets: (m.sets || []).map((s) => ({ a: s.a, b: s.b, aw: s.a > s.b, bw: s.b > s.a, tbA: s.tbA === undefined ? '' : s.tbA, tbB: s.tbB === undefined ? '' : s.tbB })),
        },
      });
    } catch (e) {
      console.error(e);
      this.setData({ loading: false, error: e.message || '加载失败' });
    }
  },
  openEvent() { if (this.data.m.drawId) wx.navigateTo({ url: '/pages/draw-view/draw-view?id=' + this.data.m.drawId }); },
  onRevoked() { setTimeout(() => wx.navigateBack(), 600); },
});
