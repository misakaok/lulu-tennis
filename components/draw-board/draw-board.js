const E = require('../../utils/event');

// 显示签表（淘汰赛）或小组积分榜（小组赛），结果由赛事里录入的比分算出
Component({
  properties: {
    draw: { type: Object, value: null },      // 赛事（draws 里的一条）
    matches: { type: Array, value: [] },      // 这个赛事已录入的比分
    editable: { type: Boolean, value: false }, // 点比赛能否进入录分
    me: { type: String, value: '' },           // 当前用户昵称，用来高亮
  },
  data: { rounds: [], champion: null, groups: [], colH: 0 },
  observers: {
    'draw, matches, me'(d, matches, me) {
      if (!d) return;
      const av = d.avatars || {};
      const avsOf = (ent) => E.membersOf(d, ent).map((n) => av[n] || '').filter(Boolean).slice(0, 2);
      const isMe = (ent) => !!me && E.membersOf(d, ent).indexOf(me) >= 0;
      const games = (sets, side) => (sets || []).map((s) => s[side]).join(' ');
      let groups = [], rounds = [], champion = null, colH = 0, koPending = false;
      const raw = E.hasGroups(d) ? E.groupsFor(d, matches || []) : [];
      if (E.hasGroups(d)) {
        const adv = d.mode === 'groups_ko' ? (d.advance === 1 ? 1 : 2) : 0;
        groups = raw.map((g) => ({
          name: g.name, done: g.done, total: g.fixtures.length,
          table: g.table.map((r) => Object.assign({}, r, { avs: avsOf(r.name), mine: isMe(r.name), q: adv && r.rank && r.rank <= adv, wdText: r.withdrawn === 'void' ? '退赛·成绩取消' : r.withdrawn ? '退赛' : '' })),
          fixtures: g.fixtures.map((f) => Object.assign({}, f, {
            score: f.outcome === 'void' ? '取消' : f.outcome === 'walkover' ? '弃权' : E.scoreText(f.sets) + (f.outcome === 'retired' ? ' 退赛' : ''),
            mine: isMe(f.a) || isMe(f.b),
          })),
        }));
      }
      if (E.hasKo(d)) {
        const v = d.mode === 'groups_ko' ? E.knockoutFor(d, matches || [], raw) : E.bracketFor(d, matches || []);
        koPending = d.mode === 'groups_ko' && !v.complete;
        v.rounds.forEach((rd) => rd.matches.forEach((m) => {
          ['a', 'b'].forEach((k) => {
            const x = m[k];
            x.avs = x.name ? avsOf(x.name) : [];
            x.games = games(m.sets, k);
            x.mine = !!x.name && isMe(x.name);
            // 结果标签：轮空晋级 / 弃权胜 / 弃权负 / 中途退赛（不生成虚假局分）
            x.tag = '';
            if (m.auto && x.win) x.tag = '轮空晋级';
            else if (m.outcome === 'walkover') x.tag = x.win ? '弃权胜' : x.lose ? '弃权负' : '';
            else if (m.outcome === 'retired' && x.lose) x.tag = '退赛';
          });
          m.done = !!(m.a.win || m.b.win);
        }));
        if (v.champion) v.champion.avs = avsOf(v.champion.name);
        rounds = v.rounds; champion = v.champion;
        colH = (rounds.length ? rounds[0].matches.length : 0) * 150;
      }
      this.setData({ groups, rounds, champion, colH, both: d.mode === 'groups_ko', koPending, advance: d.advance === 1 ? 1 : 2 });
    },
  },
  methods: {
    tapMatch(e) {
      if (!this.data.editable) return;
      const { r, i } = e.currentTarget.dataset;
      const m = this.data.rounds[r].matches[i];
      if (m.auto || m.hasBye) return;
      this.triggerEvent('open', { key: m.key, ready: m.ready });
    },
    tapFixture(e) {
      if (!this.data.editable) return;
      this.triggerEvent('open', { key: e.currentTarget.dataset.key, ready: true });
    },
  },
});
