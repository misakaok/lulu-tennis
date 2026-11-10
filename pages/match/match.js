// 比赛详情（战绩列表 / 我的待办点进来）：比分 + 赛果确认 + 对手互评
const db = require('../../utils/db');
const cloud = require('../../utils/cloud');
const ID = require('../../utils/ident');
const OF = require('../../utils/official');
const E = require('../../utils/event');
const { colorOf, initialOf } = require('../../utils/rules');

Page({
  data: { loading: true, error: '', m: null, revocable: false, preset: null },
  onLoad(o) { this.id = o.id; this.load(); },

  async load() {
    try {
      // 云函数 matchState（detail）一次带回比赛记录、状态和赛果确认情况；确认情况直接交给 match-social，它不用再调一次
      const [st, players, myId] = await Promise.all([
        cloud.call('matchState', { matchId: this.id, detail: true }).catch(() => null),
        db.fetchPlayersFull().catch(() => db.cachedPlayersFull()), db.myOpenid().catch(() => ''),
      ]);
      let raw, status, preset = null;
      if (st && st.match !== undefined) {
        raw = st.match; status = st.status || '';
        preset = Object.assign({}, st); delete preset.match;
      } else { // 云函数还是旧版本，或这次调用失败：分开读
        const [r, ver] = await Promise.all([db.getMatch(this.id), db.getVerified(this.id)]);
        raw = r; status = raw ? OF.statusOf(raw, ver ? { [this.id]: ver } : {}) : '';
      }
      const m = raw ? ID.normalizeMatches([raw], players)[0] : null; // 有 ID 的位置显示当前昵称
      if (!m) throw new Error('比赛记录不存在，可能已被撤销');
      const av = {};
      players.forEach((p) => { av[p.name] = p.avatar; });
      const side = (k) => (m[k] || []).map((n) => ({ name: n, avatar: av[n] || '', initial: initialOf(n), color: colorOf(n) }));
      // 录入人可以撤销；赛事发起人也可以，由 match-social 按云函数 matchState 返回的 isOwner 判断（不用再读一次赛事）
      const revocable = !!myId && (m._openid || m.recordedBy) === myId;
      this.setData({
        loading: false,
        revocable,
        status, preset,
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
