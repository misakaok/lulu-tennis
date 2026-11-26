const E = require('../../utils/event');
const R = require('../../utils/rating');
const haptic = require('../../utils/haptic');

// 把每盘局分拆成逐盘等宽列（含抢七上标、是否赢下该盘），用于 TNNS Live 风格对齐排版
function setColsOf(sets, side) {
  const opp = side === 'a' ? 'b' : 'a';
  const tbKey = side === 'a' ? 'tbA' : 'tbB';
  return (sets || []).map((s) => {
    const v = Number(s[side]), o = Number(s[opp]);
    const tb = s[tbKey];
    return {
      v: Number.isFinite(v) ? String(v) : '',
      w: Number.isFinite(v) && Number.isFinite(o) && v > o,
      tb: tb !== undefined && tb !== null && tb !== '' ? String(tb) : '',
    };
  });
}

// 参赛者（单打 1 人 / 双打 2 人）的头像列表：交给全局 <pl-av> 渲染真实头像或彩色首字圆
function avatarsOf(d, ent) {
  if (!ent) return [];
  const uidOf = (d && d.uidOf) || {};
  return E.membersOf(d, ent).map((name) => ({ name, uid: uidOf[name] || '' }));
}

// 显示对阵表（单淘汰）或分组循环积分榜，结果由活动里录入的比分算出
Component({
  properties: {
    draw: { type: Object, value: null },      // 活动（draws 里的一条）
    matches: { type: Array, value: [] },      // 这个活动已录入的比分
    editable: { type: Boolean, value: false }, // 点比赛能否进入录分
    me: { type: String, value: '' },           // 当前用户昵称，用来高亮
  },
  data: { rounds: [], champion: null, groups: [], colH: 0, isDouble: false, activeRound: 0, scrollInto: '' },
  observers: {
    'draw, matches, me'(d, matches, me) {
      if (!d) return;
      const isMe = (ent) => !!me && E.membersOf(d, ent).indexOf(me) >= 0;
      const isDouble = E.cfgOf(d).type === 'double';
      let groups = [], rounds = [], champion = null, colH = 0, koPending = false;
      const raw = E.hasGroups(d) ? E.groupsFor(d, matches || []) : [];
      if (E.hasGroups(d)) {
        const adv = d.mode === 'groups_ko' ? (d.advance === 1 ? 1 : 2) : 0;
        groups = raw.map((g) => {
          // 组内对阵按轮次分节（第 1 轮 / 第 2 轮…），每场独立白卡
          const byRound = [], rMap = Object.create(null);
          g.fixtures.forEach((f) => {
            const hasSets = !!(f.sets && f.sets.length);
            const aTag = f.outcome === 'walkover' ? (f.winner === 'a' ? '弃权胜' : '弃权')
              : f.outcome === 'retired' && f.winner === 'b' ? '退赛'
              : f.outcome === 'void' ? '取消' : '';
            const bTag = f.outcome === 'walkover' ? (f.winner === 'b' ? '弃权胜' : '弃权')
              : f.outcome === 'retired' && f.winner === 'a' ? '退赛' : '';
            const item = Object.assign({}, f, {
              aAvs: avatarsOf(d, f.a),
              bAvs: avatarsOf(d, f.b),
              aSets: setColsOf(f.sets, 'a'),
              bSets: setColsOf(f.sets, 'b'),
              hasSets,
              aTag,
              bTag,
              mineA: isMe(f.a),
              mineB: isMe(f.b),
            });
            const rk = String(f.round || 1);
            if (!rMap[rk]) {
              rMap[rk] = { round: f.round || 1, label: `第 ${f.round || 1} 轮`, done: 0, total: 0, items: [] };
              byRound.push(rMap[rk]);
            }
            rMap[rk].total++;
            if (f.done) rMap[rk].done++;
            rMap[rk].items.push(item);
          });
          return {
            name: g.name, done: g.done, total: g.fixtures.length,
            table: g.table.map((r) => Object.assign({}, r, {
              avs: avatarsOf(d, r.name),
              mine: isMe(r.name),
              q: adv && r.rank && r.rank <= adv,
              wdText: r.withdrawn === 'void' ? '退赛·成绩取消' : r.withdrawn ? '退赛' : '',
            })),
            roundGroups: byRound,
          };
        });
      }
      if (E.hasKo(d)) {
        const v = d.mode === 'groups_ko' ? E.knockoutFor(d, matches || [], raw) : E.bracketFor(d, matches || []);
        koPending = d.mode === 'groups_ko' && !v.complete;
        v.rounds.forEach((rd, rIdx) => {
          rd.id = `rd-${rIdx}`;
          rd.matches.forEach((m) => {
            const hasSets = !!(m.sets && m.sets.length);
            ['a', 'b'].forEach((k) => {
              const x = m[k];
              x.avs = !x.bye && !x.tbd && x.name ? avatarsOf(d, x.name) : [];
              x.setCols = setColsOf(m.sets, k);
              x.mine = !!x.name && isMe(x.name);
              // 结果标签：轮空 / 弃权胜 / 弃权负 / 退赛（不生成虚假局分）
              x.tag = '';
              if (m.auto && x.win) x.tag = '轮空';
              else if (m.outcome === 'walkover') x.tag = x.win ? '弃权胜' : x.lose ? '弃权负' : '';
              else if (m.outcome === 'retired' && x.lose) x.tag = '退赛';
            });
            m.hasSets = hasSets;
            m.done = !!(m.a.win || m.b.win);
            m.lit = !!((m.a && m.a.name) || (m.b && m.b.name));
          });
        });
        rounds = v.rounds; champion = v.champion;
        colH = (rounds.length ? rounds[0].matches.length : 0) * 168;
      }
      const activeRound = this.data.activeRound < rounds.length ? this.data.activeRound : 0;
      const next = {
        groups, rounds, champion, colH, isDouble, activeRound,
        both: d.mode === 'groups_ko', koPending, advance: d.advance === 1 ? 1 : 2,
      };
      const sig = JSON.stringify(next);
      if (sig === this._boardSig) return;
      this._boardSig = sig;
      this.setData(next);
    },
  },
  methods: {
    jumpRound(e) {
      const i = Number(e.currentTarget.dataset.i);
      if (!Number.isInteger(i) || i < 0 || i >= this.data.rounds.length) return;
      haptic.light();
      this.setData({ activeRound: i, scrollInto: `rd-${i}` });
    },
    tapMatch(e) {
      if (!this.data.editable) return;
      const { r, i } = e.currentTarget.dataset;
      const m = this.data.rounds[r].matches[i];
      // 轮空没有比赛记录：点了说明一下（直接进入下一轮，本场未计入水平分）；两边都轮空的空位不提示
      if (m.hasBye) { if (m.auto) wx.showToast({ title: `轮空直接进入下一轮，${R.unratedOf('bye').title}`, icon: 'none', duration: 2500 }); return; }
      if (m.auto) return;
      this.triggerEvent('open', { key: m.key, ready: m.ready });
    },
    tapFixture(e) {
      if (!this.data.editable) return;
      this.triggerEvent('open', { key: e.currentTarget.dataset.key, ready: true });
    },
  },
});
