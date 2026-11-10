// 我的关注：关注的球友（等级、本赛季战绩）+ 他们最近的正式比赛。
// 谁关注了谁只有本人看得到（云函数 followInfo）；战绩和等级用的是和排行榜同一套正式战绩。
const db = require('../../utils/db');
const cloud = require('../../utils/cloud');
const E = require('../../utils/event');
const R = require('../../utils/rating');
const S = require('../../utils/stats');
const SE = require('../../utils/season');
const CA = require('../../utils/career');
const { computeRank, colorOf, initialOf, outcomeOf } = require('../../utils/rules');

const FEED = 30;

Page({
  data: { loading: true, error: '', list: [], feed: [], followers: 0, season: SE.current() },
  onShow() { this.load(); }, // 从球员主页取消关注后回来自动刷新
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    this.load().then(() => wx.stopPullDownRefresh()); },

  async load() {
    try {
      const [info, players, matches] = await Promise.all([
        cloud.cached('followInfo'),
        db.fetchPlayersFull().catch(() => db.cachedPlayersFull()),
        db.fetchMatches().catch(() => db.cachedMatches()),
      ]);
      const byUid = {};
      players.forEach((p) => { if (p.uid) byUid[p.uid] = p; });
      const stats = S.playerStats(matches, players);
      const season = {};
      computeRank(SE.inSeason(matches, SE.current()), 'all').forEach((p) => { season[p.key] = p; });
      const list = info.following.filter((u) => byUid[u]).map((u) => {
        const p = byUid[u], st = stats.map[u], sn = season[u];
        return {
          uid: u, name: p.name, avatar: p.avatar || '', initial: initialOf(p.name), color: colorOf(p.name),
          level: st && st.played ? R.fmt(st.level) : typeof p.level === 'number' ? R.fmt(p.level) + ' 自评' : S.NONE,
          rank: st && st.played ? '第 ' + st.rank + ' 名' : '',
          season: sn ? `本赛季 ${sn.win}胜 ${sn.lose}负` : '本赛季还没有比赛',
        };
      });
      // 动态：关注的人最近的正式比赛（从新到旧）
      const on = {};
      info.following.forEach((u) => { on[u] = 1; });
      const feed = [];
      for (const m of matches) {
        if (feed.length >= FEED) break;
        const who = ['a', 'b'].map((k) => (m[k + 'Keys'] || []).some((x) => on[x]));
        if (!who[0] && !who[1]) continue;
        const oc = outcomeOf(m);
        feed.push({
          id: m._id, md: (m.date || '').slice(5),
          event: m.drawId ? `${m.drawTitle || '赛事'}${m.stage ? ' · ' + m.stage : ''}` : '日常比赛', isEvent: !!m.drawId,
          a: (m.a || []).join(' / '), b: (m.b || []).join(' / '), aw: m.winner === 'a', bw: m.winner === 'b',
          score: oc === 'walkover' ? '弃权' : E.scoreText(m.sets) + (oc === 'retired' ? ' 退赛' : ''),
          champ: CA.isFinal(m) && ((who[0] && m.winner === 'a') || (who[1] && m.winner === 'b')), // 关注的人赢了决赛
        });
      }
      this.setData({ loading: false, error: '', list, feed, followers: info.followers });
    } catch (e) {
      console.error(e);
      this.setData({ loading: false, error: e.message || '加载失败，请下拉重试' });
    }
  },

  openPlayer(e) { wx.navigateTo({ url: '/pages/player/player?uid=' + encodeURIComponent(e.currentTarget.dataset.uid) }); },
  openMatch(e) { wx.navigateTo({ url: '/pages/match/match?id=' + e.currentTarget.dataset.id }); },
  goRank() { wx.switchTab({ url: '/pages/rank/rank' }); },
});
