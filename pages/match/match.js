// 比赛详情（战绩列表 / 我的待办点进来）：比分 + 赛果确认
const db = require('../../utils/db');
const cloud = require('../../utils/cloud');
const ID = require('../../utils/ident');
const OF = require('../../utils/official');
const E = require('../../utils/event');
const R = require('../../utils/rating');
const H = require('../../utils/highlight');
const { colorOf, initialOf, outcomeOf } = require('../../utils/rules');

Page({
  data: { loading: true, error: '', m: null, revocable: false, preset: null, changes: [], tags: [] },
  onLoad(o) { this.id = o.id; this.load(); },
  onShow() { if (this.shown) this.load(); this.shown = true; }, // 从改分页回来：比分和修改记录要刷新

  async load() {
    try {
      // 云函数 matchState（detail）一次带回比赛记录、状态和赛果确认情况；确认情况直接交给 match-social，它不用再调一次
      const [st, players, myId, all] = await Promise.all([
        cloud.call('matchState', { matchId: this.id, detail: true }).catch(() => null),
        db.fetchPlayersFull().catch(() => db.cachedPlayersFull()), db.myOpenid().catch(() => ''),
        db.fetchMatches().catch(() => db.cachedMatches() || []), // 正式战绩（有缓存）：只用来算这一场的亮点标签
      ]);
      let raw, status, preset = null;
      if (st && st.match !== undefined) {
        raw = st.match; status = st.status || '';
        preset = Object.assign({}, st); delete preset.match;
      } else { // 云函数还是旧版本，或这次调用失败：分开读
        const [r, ver] = await Promise.all([db.getMatch(this.id), db.getVerified(this.id)]);
        raw = r; status = raw ? OF.statusOf(raw, ver ? { [this.id]: ver } : {}) : '';
      }
      const m = raw ? ID.normalizeMatches([E.publicMatch(raw)], players)[0] : null; // 有 ID 的位置显示当前昵称
      if (!m) throw new Error('比赛记录不存在，可能已被撤销');
      const gOf = require('../../utils/stats').genderFinder(players);
      const side = (k) => (m[k] || []).map((n, i) => ({ name: n, uid: (m[k + 'Ids'] || [])[i] || '', initial: initialOf(n), color: colorOf(n), gender: gOf(n, (m[k + 'Ids'] || [])[i]) }));
      // 录入人可以撤销；活动发起人也可以，由 match-social 按云函数 matchState 返回的 isOwner 判断（不用再读一次活动）
      const revocable = !!myId && (m._openid || m.recordedBy) === myId;
      // 比分修改记录（云函数 matchState 带回；旧版云函数没有就不显示）
      const HOW = { edit: '修改了比分', request: '申请修改，对方已同意', rule: '裁定修改', admin: '更正了比分' };
      const p2 = (n) => String(n).padStart(2, '0');
      const changes = ((st && st.changes) || []).map((c, i) => {
        const d = c.at ? new Date(c.at) : null;
        return { i, when: d ? `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}` : '', text: `${c.who}${HOW[c.how] || '修改了比分'}`, from: c.from, to: c.to };
      });
      // 记分牌中间的大比分：多盘显示盘数，只打一盘显示局数；弃权没有比分
      const sets = (m.sets || []).map((s) => ({ a: s.a, b: s.b, aw: s.a > s.b, bw: s.b > s.a, tbA: s.tbA === undefined ? '' : s.tbA, tbB: s.tbB === undefined ? '' : s.tbB }));
      const oc = outcomeOf(m), hasTb = sets.some((s) => s.tbA !== '' || s.tbB !== '');
      let big = ['-', '-'], bigLbl = oc === 'walkover' ? '弃权' : '';
      if (sets.length === 1) { big = [sets[0].a, sets[0].b]; bigLbl = oc === 'retired' ? '中途退赛' : '局分'; }
      else if (sets.length) { big = [sets.filter((s) => s.aw).length, sets.filter((s) => s.bw).length]; bigLbl = oc === 'retired' ? '中途退赛' : '盘分'; }
      // 亮点标签（爆冷、逆转、终结连胜…）：和战绩列表同一套算法
      const tags = H.matchTags(all || [], R.computeRatings(all || [], R.startLevelsFrom(players || [])))[m._id] || [];
      this.setData({
        loading: false, changes, tags,
        revocable,
        status, preset,
        m: {
          _id: m._id, date: m.date, winner: m.winner, drawId: m.drawId || '',
          event: m.drawTitle ? `${m.drawTitle}${m.stage ? ' · ' + m.stage : ''}` : '',
          format: E.formatText(E.cfgOf(m)),
          a: side('a'), b: side('b'), aText: (m.a || []).join(' / '), bText: (m.b || []).join(' / '),
          sets, typeText: m.type === 'double' ? '双打' : '单打',
          bigA: big[0], bigB: big[1], bigLbl, showSets: sets.length > 1 || hasTb,
          loseText: oc === 'walkover' ? '弃权' : oc === 'retired' ? '退赛' : '负',
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
