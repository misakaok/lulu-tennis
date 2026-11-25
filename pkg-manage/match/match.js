// 比赛详情（战绩列表 / 我的待办点进来）：比分 + 赛果确认
const db = require('../../utils/db');
const cloud = require('../../utils/cloud');
const ID = require('../../utils/ident');
const OF = require('../../utils/official');
const E = require('../../utils/event');
const R = require('../../utils/rating');
const H = require('../../utils/highlight');
const Anim = require('../../utils/anim');
const member = require('../../utils/member');
const { outcomeOf } = require('../../utils/rules');

// 「这场为什么涨分 / 掉分」：只给本人看自己参加的正式比赛（按统计身份认人，不看昵称）。
//   数据来自这一场实际参与计算的值（R.computeRatings 的 explain，和排行榜同一套正式战绩、同一个起始水平），不按今天的等级倒推。
//   弃权 / 退赛、没有局分的旧记录只说明能确认的状态；不在正式战绩里的（或战绩没读到的）不显示
function whyView(all, ratings, m, myId) {
  if (!myId) return null;
  const rec = (all || []).find((x) => x._id === m._id);
  if (!rec) return null;
  const mine = (rec.aKeys || []).indexOf(myId) >= 0 || (rec.bKeys || []).indexOf(myId) >= 0;
  if (!mine) return null;
  const oc = outcomeOf(rec);
  if (oc === 'walkover' || oc === 'retired') { const u = R.unratedOf(oc); return { none: u.text, noneTitle: u.title }; }
  const w = R.whyOf(ratings, m._id, myId);
  return w || { none: '这场没有可用的局分记录，没有参与水平分计算', noneTitle: '本场未计入水平分' };
}

// 记分牌：页面上显示的这一场（比分、双方、性别）。本机缓存预览和云端结果共用
function boardOf(m, players) {
  const gOf = require('../../utils/stats').genderFinder(players);
  const side = (k) => (m[k] || []).map((n, i) => {
    const key = (m[k + 'Keys'] || [])[i] || '';
    const uid = (m[k + 'Ids'] || [])[i] || (key && key.indexOf(ID.NAME_KEY) !== 0 ? key : '');
    return { name: n, uid, gender: gOf(n, uid) };
  });
  // 记分牌中间的大比分：多盘显示盘数，只打一盘显示局数；弃权没有比分
  const sets = (m.sets || []).map((s) => ({ a: s.a, b: s.b, aw: s.a > s.b, bw: s.b > s.a, tbA: s.tbA === undefined ? '' : s.tbA, tbB: s.tbB === undefined ? '' : s.tbB }));
  const oc = outcomeOf(m), hasTb = sets.some((s) => s.tbA !== '' || s.tbB !== '');
  let big = ['-', '-'], bigLbl = oc === 'walkover' ? '弃权' : '';
  if (sets.length === 1) { big = [sets[0].a, sets[0].b]; bigLbl = oc === 'retired' ? '中途退赛' : '局分'; }
  else if (sets.length) { big = [sets.filter((s) => s.aw).length, sets.filter((s) => s.bw).length]; bigLbl = oc === 'retired' ? '中途退赛' : '盘分'; }
  return {
    _id: m._id, date: m.date, winner: m.winner, drawId: m.drawId || '',
    event: m.drawTitle ? `${m.drawTitle}${m.stage ? ' · ' + m.stage : ''}` : '',
    format: E.formatText(E.cfgOf(m)),
    a: side('a'), b: side('b'),
    sets, typeText: m.type === 'double' ? '双打' : '单打',
    bigA: big[0], bigB: big[1], bigLbl, showSets: sets.length > 1 || hasTb,
    loseText: oc === 'walkover' ? '弃权' : oc === 'retired' ? '退赛' : '负',
  };
}

// 普通日常比赛（正常赛果、不是待确认、没被管理员更正过）的「比分状态」先按本机知道的身份画出来（2026-11-25 用户嫌下面那块晚出来）：
//   日常比赛录分即生效，录入人和参加者能直接改，管理员能更正 / 撤销，和云端 matchState 的结果一样；
//   带 preview 标记：match-social 里点按钮不动作，云端结果回来原样替换（万一其实已锁定、有改分申请、管理员被撤销，按云端更正）。
//   活动比赛、弃权 / 退赛、管理员更正过的（可能已锁定）都不猜，照旧等云端
function previewSocial(m, myId, admin) {
  if (!m || m.drawId || m.status === 'pending' || (m.outcome && m.outcome !== 'normal') || m.walkover || (m.lastChange && m.lastChange.how === 'admin')) return null;
  const mySide = myId ? ((m.aIds || []).indexOf(myId) >= 0 ? 'a' : (m.bIds || []).indexOf(myId) >= 0 ? 'b' : '') : '';
  const isRecorder = !!myId && (m._openid || m.recordedBy) === myId;
  return {
    preset: {
      matchId: m._id, preview: true, finished: true, daily: true, confirmed: false,
      drawId: '', drawKey: '', outcome: 'normal', sides: {}, mySide,
      canConfirm: false, unbound: false, request: null,
      canEdit: isRecorder || !!mySide, canRequestChange: false, canAdminFix: admin, canAdminRevoke: admin,
      reason: mySide ? '' : '你不是这场比赛的参加者（按账号判断，不看昵称）',
    },
    revocable: isRecorder || !!mySide,
  };
}

// 亮点标签和「这场的水平分」：都在正式战绩上算（和战绩列表同一套），水平分只算一次
function extrasOf(all, players, m, myId) {
  // 共享数组（db.matchesShared / playersShared）时和战绩页、排行榜共用同一次水平分和亮点计算（按引用缓存，结果只读）
  const ratings = R.ratingsOf ? R.ratingsOf(all, players) : R.computeRatings(all || [], R.startLevelsFrom(players || []));
  return { tags: (H.tagsOf || H.matchTags)(all || [], ratings)[m._id] || [], why: whyView(all, ratings, m, myId) };
}

Page({
  data: { loading: true, ready: false, error: '', m: null, revocable: false, preset: null, previewSocial: false, changes: [], tags: [], why: null, whyOpen: false, sheen: false },
  onLoad(o) {
    this.id = o.id;
    this.sheen = Anim.once('match-hero'); // 记分牌的高光一次启动只扫一次：每点开一场都扫一道太闪（2026-11-25 用户要求）
    this.preview();
    if (this.sheen) this.setData({ sheen: true });
    this.load();
  },
  // 先用本机战绩里的这一场画记分牌（2026-11-24 用户嫌打开慢），云端 matchState 读完再更正；
  // 亮点标签和「这场的水平分」也先用本机战绩算好（2026-11-25 用户嫌读完又闪一下：记分牌变高、卡片插进来），
  // 修改记录等云端读完（ready）才显示，出现时淡入；确认 / 改分 / 撤销（match-social）普通日常比赛第一帧就画（见 previewSocial），
  // 其他比赛也等 ready
  preview() {
    try {
      const list = db.cachedMatchesAll(); // 本机只存这一份；去掉待确认的就是正式战绩（和 db.cachedMatches 一样，不再读一遍本机存储）
      const m = list.find((x) => x && x._id === this.id);
      if (!m) return;
      const players = db.cachedPlayersFull();
      const board = boardOf(m, players);
      const myId = (db.cachedOpenid && db.cachedOpenid()) || '';
      if (myId) this.myId = myId;
      let extra = {};
      try {
        extra = extrasOf(list.filter((x) => x && x.status !== 'pending'), players, board, myId);
      } catch (e) { console.warn('[比赛详情] 本机战绩算不出亮点 / 水平分，等云端', e); }
      const social = previewSocial(m, myId, member.knownActive() && member.isAdminLocal());
      if (social) Object.assign(extra, { preset: social.preset, revocable: social.revocable, previewSocial: true });
      this.setData(Object.assign({ loading: false, m: board, status: m.status === 'pending' ? 'pending' : 'official' }, extra));
    } catch (e) { console.warn('[比赛详情] 本机缓存画不出来，等云端', e); }
  },
  onShow() { if (this.shown) this.load(); this.shown = true; }, // 从改分页回来：比分和修改记录要刷新

  async load() {
    const seq = this.loadSeq = (this.loadSeq || 0) + 1; // 连着读了两次（从改分页回来）：只认最后一次
    try {
      // 云函数 matchState（detail）一次带回比赛记录、状态和赛果确认情况；确认情况直接交给 match-social，它不用再调一次。
      // 从战绩 / 球员主页 / 全部比赛点进来时已经预读（db.prefetchMatchState），第一次读取接过那个请求
      const ms = db.fetchMatchState ? db.fetchMatchState(this.id) : cloud.call('matchState', { matchId: this.id, detail: true });
      const [st, players, myId, all] = await Promise.all([
        ms.catch(() => null),
        // 球员、正式战绩都用共享版（只读，和战绩页 / 排行页同一个数组，不复制）
        (db.playersShared || db.fetchPlayersFull)().catch(() => db.cachedPlayersFull()), db.myOpenid().catch(() => ''),
        db.matchesShared().catch(() => db.cachedMatches() || []), // 只用来算这一场的亮点标签和水平分说明
      ]);
      if (seq !== this.loadSeq) return;
      if (myId) this.myId = myId;
      let raw, status, preset = null;
      if (st && st.match !== undefined) {
        raw = st.match; status = st.status || '';
        preset = Object.assign({}, st); delete preset.match;
      } else { // 云函数还是旧版本，或这次调用失败：分开读
        const [r, ver] = await Promise.all([db.getMatch(this.id), db.getVerified(this.id)]);
        if (seq !== this.loadSeq) return;
        raw = r; status = raw ? OF.statusOf(raw, ver ? { [this.id]: ver } : {}) : '';
      }
      const m = raw ? ID.normalizeMatches([E.publicMatch(raw)], players)[0] : null; // 有 ID 的位置显示当前昵称
      if (!m) throw new Error('比赛记录不存在，可能已被撤销');
      // 录入人可以撤销；日常比赛的参加者也可以；活动发起人由 match-social 按云函数 matchState 返回的 isOwner 判断（不用再读一次活动）
      const inDaily = !m.drawId && (m.aIds || []).concat(m.bIds || []).indexOf(myId) >= 0;
      const revocable = !!myId && ((m._openid || m.recordedBy) === myId || inDaily);
      // 比分修改记录（云函数 matchState 带回；旧版云函数没有就不显示）
      const HOW = { edit: '修改了比分', request: '申请修改，对方已同意', rule: '裁定修改', admin: '更正了比分' };
      const p2 = (n) => String(n).padStart(2, '0');
      const changes = ((st && st.changes) || []).map((c, i) => {
        const d = c.at ? new Date(c.at) : null;
        return { i, when: d ? `${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}` : '', text: `${c.who}${HOW[c.how] || '修改了比分'}`, from: c.from, to: c.to };
      });
      // 亮点标签（爆冷、逆转、终结连胜…）：和战绩列表同一套算法；水平分只算一次，「为什么涨分 / 掉分」也用这一份
      const { tags, why } = extrasOf(all, players, m, myId);
      this.setData({
        loading: false, ready: true, changes, tags, why,
        revocable,
        status, preset, // 先画过预览的 previewSocial 保持不变：卡片已经在了，不再淡入一次（云端没给状态时组件自己读，读完再替换）
        m: boardOf(m, players),
      });
    } catch (e) {
      if (seq !== this.loadSeq) return;
      console.error(e);
      this.setData({ loading: false, ready: false, m: null, error: e.message || '加载失败' });
    }
  },
  toggleWhy() { this.setData({ whyOpen: !this.data.whyOpen }); },
  openEvent() { if (this.data.m.drawId) wx.navigateTo({ url: '/pages/draw-view/draw-view?id=' + this.data.m.drawId }); },
  // 点头像或名字 → 球员主页（点自己直接跳「我的」，旧记录没绑定账号轻提示）
  openPlayer(e) {
    const uid = e.currentTarget.dataset.uid || '';
    if (!uid) { wx.showToast({ title: '这位球员没有绑定账号', icon: 'none' }); return; }
    const me = this.myId || (db.cachedOpenid && db.cachedOpenid()) || '';
    if (me && uid === me) { wx.switchTab({ url: '/pages/me/me' }); return; }
    wx.navigateTo({ url: '/pages/player/player?uid=' + encodeURIComponent(uid) });
  },
  onRevoked() { setTimeout(() => wx.navigateBack(), 600); },
});
