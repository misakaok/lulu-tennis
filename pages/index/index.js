const db = require('../../utils/db');
const R = require('../../utils/rating');
const { colorOf, initialOf, isNormal } = require('../../utils/rules');
const S = require('../../utils/stats');
const H = require('../../utils/highlight');
const Anim = require('../../utils/anim');
const haptic = require('../../utils/haptic');

const PAGE = 40;        // 列表每次显示多少场，滑到底再加载
const SEARCH_MS = 300;  // 搜索防抖
const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const pad = (n) => (n < 10 ? '0' + n : '' + n);
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function dateLabel(str) {
  const now = new Date();
  const yest = new Date(now.getTime() - 86400000);
  if (str === ymd(now)) return '今天';
  if (str === ymd(yest)) return '昨天';
  const [y, m, d] = str.split('-').map(Number);
  const w = WEEK[new Date(y, m - 1, d).getDay()];
  return (y === now.getFullYear() ? '' : `${y}年`) + `${m}月${d}日 ${w}`;
}

// 记分牌中间的比分：打多盘显示盘分，只打一盘显示局分；下面一行列出每盘（有抢七时带括号）
function scoreOf(m) {
  const sets = m.sets || [];
  const oc = m.outcome || (m.walkover ? 'walkover' : 'normal');
  const setText = sets.map((s) => `${s.a}-${s.b}` + (s.tbA !== undefined && s.tbB !== undefined ? `(${Math.min(s.tbA, s.tbB)})` : '')).join('  ');
  let big = ['-', '-'];
  if (sets.length === 1) big = [sets[0].a, sets[0].b];
  else if (sets.length) big = [sets.filter((s) => s.a > s.b).length, sets.filter((s) => s.b > s.a).length];
  return {
    bigA: big[0], bigB: big[1],
    setText: oc === 'walkover' ? '弃权' : (sets.length > 1 || /\(/.test(setText) ? setText : '') + (oc === 'retired' ? ' 中途退赛' : ''),
  };
}

function toView(m, deltas, gOf, tagsOf) {
  const d = deltas[m._id] || {};
  const side = (k) => (m[k] || []).map((n, i) => ({ name: n, uid: (m[k + 'Ids'] || [])[i] || '', initial: initialOf(n), color: colorOf(n), gender: gOf ? gOf(n, (m[k + 'Ids'] || [])[i]) : '' }));
  const first = (k) => ((m[k + 'Keys'] || m[k] || [])[0]); // 同队两人涨跌相同，取第一位的统计身份
  const deltaText = (k) => {
    const v = (m[k] || []).length ? d[first(k)] : undefined;
    return v === undefined ? '' : R.fmtDelta(v);
  };
  return {
    _id: m._id,
    drawId: m.drawId || '',
    pending: m.status === 'pending',
    tags: (tagsOf && tagsOf[m._id]) || [],
    eventText: m.drawId && m.drawTitle ? `${m.drawTitle}${m.stage ? ' · ' + m.stage : ''}` : '',
    typeText: m.type === 'double' ? '双打' : '单打',
    formatText: (m.bestOf === 1 ? '一盘' : '三盘两胜') + ` · ${m.setGames || 4}局制`
      + (m.noAd === false ? ' · 占先' : ' · 金球'),
    winner: m.winner,
    a: side('a'),
    b: side('b'),
    aDelta: deltaText('a'), bDelta: deltaText('b'),
    aUp: (d[first('a')] || 0) > 0, bUp: (d[first('b')] || 0) > 0,
    aText: (m.a || []).join(' / '),
    bText: (m.b || []).join(' / '),
    ...scoreOf(m),
  };
}

Page({
  data: {
    loading: true, play: true, // play：入场动画（切换 tab 回来时重播，见 utils/anim.js）
    groups: [],
    stat: { total: 0, month: 0, players: 0 },
    me: null, // 我的战绩卡：没有账号或还没打过比赛时不显示，顶部改为显示全部比赛的统计
    filter: 'all', canRecordDaily: false,
    who: '',
    more: false,
    types: [{ label: '全部', value: 'all' }, { label: '单打', value: 'single' }, { label: '双打', value: 'double' }],
  },

  onLoad() {
    wx.hideShareMenu({ fail() {} }); // 战绩、排行、我的（带昵称和战绩）不能转发，菜单里不显示转发；只有活动首页能分享
    this.limit = PAGE;
    // 本人 ID 先用本机记着的（资料里没有就用登录时记下的），免得顶部先画「全部比赛」卡、云端读完再换成「我的战绩」卡
    this.setSource(db.cachedMatchesAll(), db.cachedPlayersFull(), db.cachedOpenid() || (db.cachedProfile() || {})._openid || '');
    this.render();
    // 「记一场」按钮先按本机记得的身份显示（24 小时内确认过是正式成员），不等云端；load 里拿到身份后再更正
    if (require('../../utils/member').knownActive()) this.setData({ canRecordDaily: true });
  },
  onReachBottom() {
    if (!this.data.more) return;
    this.limit += PAGE;
    this.render();
  },
  onShow() {
    Anim.enter(this); // 切换 tab 回来：重播入场动画和数字滚动（从详情返回不重播）
    this.load();
  },
  onHide() { Anim.leave(this); },
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    this.load().then(() => wx.stopPullDownRefresh()); },

  async load() {
    // 「记一场」按钮只决定显示（录分页打开时实时校验身份，云函数也会校验）：身份用 60 秒缓存，和读数据同时进行，
    // 不在每次切到这页时都调一次云函数；查不到身份时收起按钮，不影响列表
    const showAdd = require('../../utils/member').statusCached()
      .then((r) => r.status === 'active', () => false)
      .then((v) => { if (v !== this.data.canRecordDaily) this.setData({ canRecordDaily: v }); });
    try {
      // 共享数据（不复制，只读）：数据没变时是同一个数组，比较引用就知道要不要重算
      // 正式战绩也拿共享版（和 matchesAllShared 同一次整理的结果，不多读）：排行榜、球员主页、比赛详情传的是同一个数组，
      // 水平分（R.ratingsOf）、球员统计（S.playerStats）、亮点标签（H.tagsOf）全站只算一次
      const [m, p, myId, official] = await Promise.all([db.matchesAllShared(), db.playersShared(), db.myOpenid().catch(() => this.myId || ''), db.matchesShared ? db.matchesShared() : null]);
      // 数据和上次一样（比如从详情页返回、缓存命中）就不重算、不重新渲染
      if (this.setSource(m, p, myId, official)) this.render();
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '网络异常，显示的是缓存数据', icon: 'none' });
    }
    await showAdd;
    if (this.data.loading) this.setData({ loading: false });
  },

  // 换数据源：水平分涨跌、顶部统计只在数据变化时算一次（搜索、筛选、翻页都不重算）
  // 比较的是数组引用（db.*Shared 数据没变时返回同一个数组），不把全部数据序列化一遍。返回是否有变化
  // official：共享的正式战绩（db.matchesShared，和 matches 里去掉待确认的一样、同样按日期从新到旧）；没有（本机缓存先画）就自己筛
  setSource(matches, players, myId, official) {
    const src = this.srcRef;
    if (src && src.m === matches && src.p === players && src.id === (myId || '') && src.o === (official || null)) return false;
    this.srcRef = { m: matches, p: players, id: myId || '', o: official || null };
    const shown = matches || [];
    const all = official || shown.filter((m) => m.status !== 'pending'); // 统计和水平分涨跌只算正式战绩
    const month = ymd(new Date()).slice(0, 7);
    const names = {};
    all.forEach((m) => (m.a || []).concat(m.b || []).forEach((n) => { names[n] = 1; }));
    this.gOf = S.genderFinder(players);
    this.myId = myId || '';
    // 和排行榜同一套口径（S.playerStats：名次按水平排序，只在同意公开展示的人里排）
    const st = S.playerStats(all, players || [], db.profilesOf(players || []));
    this.src = {
      shown,
      me: this.meCard(all, st, players || []),
      deltas: st.ratings.deltas,
      tags: H.tagsOf(all, st.ratings), // 亮点标签（爆冷、逆转…）：只在数据变化时算一次，和比赛详情共用
      stat: { total: all.length, month: all.filter((m) => (m.date || '').indexOf(month) === 0).length, players: Object.keys(names).length },
    };
    return true;
  },

  // 列表显示正式战绩 + 待对手确认的日常比赛；按筛选条件过滤后只渲染前 limit 场
  render() {
    const { shown, deltas, stat, me, tags } = this.src || { shown: [], deltas: {}, stat: this.data.stat, me: null, tags: {} };
    const who = (this.who !== undefined ? this.who : this.data.who).trim();
    const filter = this.data.filter;
    const list = shown.filter((m) =>
      (filter === 'all' || m.type === filter) &&
      (!who || (m.a || []).concat(m.b || []).some((n) => n.indexOf(who) >= 0)));
    const groups = [];
    list.slice(0, this.limit || PAGE).forEach((m) => {
      let g = groups[groups.length - 1];
      if (!g || g.date !== m.date) { g = { date: m.date, label: dateLabel(m.date), items: [] }; groups.push(g); }
      g.items.push(toView(m, deltas, this.gOf, tags));
    });
    // 顶部卡片的数字第一次显示时从 0 滚到实际值（滚动帧按路径改 data，所以 me / stat 传副本，不动 this.src 里那份）
    const nums = me
      ? { 'me.level': me.level, 'me.played': me.played, 'me.win': me.win, 'me.lose': me.lose, 'me.rate': me.rate }
      : { 'stat.total': stat.total, 'stat.month': stat.month, 'stat.players': stat.players };
    this.setData(Object.assign({ groups, stat: Object.assign({}, stat), me: me && Object.assign({}, me), more: list.length > (this.limit || PAGE) }, Anim.roll(this, nums)));
  },

  // 我的战绩卡：水平分、名次、场次、胜负、胜率、最近 6 场（只算正式战绩里正常完赛的）
  meCard(all, st, players) {
    const uid = this.myId, s = uid && st.map[uid];
    if (!s) return null;
    const p = players.find((x) => x.uid === uid) || {};
    const name = p.name || '';
    const recent = all.filter((m) => isNormal(m) && ((m.aKeys || []).indexOf(uid) >= 0 || (m.bKeys || []).indexOf(uid) >= 0))
      .slice(0, 6).map((m, i) => ({ i, w: m.winner === ((m.aKeys || []).indexOf(uid) >= 0 ? 'a' : 'b') }));
    return {
      name, uid, initial: initialOf(name), color: colorOf(name),
      level: R.fmt(s.level), levelLbl: s.provisional ? '定级中' : '水平分',
      rankText: !s.boardRank ? '未开启公开展示，不在排行榜里' : `排名第 ${s.boardRank} 位` + (s.provisional ? ' · 定级中' : ''),
      played: s.played, win: s.win, lose: s.played - s.win, rate: s.rate, recent,
    };
  },
  goMe() { wx.switchTab({ url: '/pages/me/me' }); },

  setFilter(e) { if (e.currentTarget.dataset.v !== this.data.filter) haptic.light(); this.limit = PAGE; this.setData({ filter: e.currentTarget.dataset.v }); this.render(); },
  // 输入时只记下关键词，停顿 300ms 再过滤（不在每个字上重新渲染整个列表）
  onSearch(e) {
    this.who = e.detail.value;
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => { this.limit = PAGE; this.setData({ who: this.who }); this.render(); }, SEARCH_MS);
  },
  onUnload() { clearTimeout(this.searchTimer); Anim.stop(this); },
  goAdd() { if (!this.data.canRecordDaily) return; wx.navigateTo({ url: '/pages/add/add' }); }, // 记录日常比赛（次要入口；活动比赛在签表里录）
  // 点击比赛：详情页里可以确认赛果；活动比赛可以从详情页进入活动
  openMatch(e) { // 先发出比赛状态请求，利用页面切换动画的时间（比赛详情第一次读取接过去）
    const id = e.currentTarget.dataset.id;
    db.prefetchMatchState(id);
    wx.navigateTo({ url: '/pages/match/match?id=' + id });
  },

  onLong(e) {
    const id = e.currentTarget.dataset.id;
    wx.showActionSheet({
      itemList: ['删除这条记录'],
      itemColor: '#e5484d',
      success: () => {
        wx.showModal({
          title: '确定删除？',
          content: '删除后所有人都看不到这条记录了',
          confirmColor: '#e5484d',
          success: async (r) => {
            if (!r.confirm) return;
            try {
              const res = await db.removeMatch(id);
              // 需要填原因 / 确认对后续场次的影响：到比赛详情里撤销
              if (res && (res.needReason || res.needConfirm)) { wx.navigateTo({ url: '/pages/match/match?id=' + id }); return; }
              wx.showToast({ title: '已删除' });
              this.load(); // 删除会作废缓存（utils/cloud.js），这里拿到的是新数据
            } catch (err) {
              console.error(err);
              wx.showModal({ title: '删除失败', content: err.message || '请稍后再试', showCancel: false });
            }
          },
        });
      },
    });
  },
});
