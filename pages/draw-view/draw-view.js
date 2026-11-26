// 活动详情：报名 → 签表 / 积分榜 → 赛程 → 点比赛录分
const E = require('../../utils/event');
const db = require('../../utils/db');
const ID = require('../../utils/ident');
const cloud = require('../../utils/cloud');
const pick = require('../../utils/pick');
const C = require('../../utils/cup');
const SC = require('../../utils/slot-conflict');
const WV = require('../../utils/withdraw-view'); // 「退赛／弃权」筛选：只整理现有的赛程和退赛名单
const Card = require('../../utils/share-card'); // 分享卡片封面（不指定时微信截页面顶部，有时截成空白）
const COVER_DELAY_MS = 800; // 进页面后等一会儿再画封面；这期间分享会等它画完（微信最多等 3 秒）
const S = require('../../utils/stats');
const haptic = require('../../utils/haptic');
const { colorOf, initialOf } = require('../../utils/rules');

const NO_PARTNER = '暂时没有搭档（由发起人配对）';

function modeText(d) {
  if (d.mode === 'rotation') return `${E.MODES.rotation} · 三轮换搭档`;
  if (d.mode === 'groups') return `${E.MODES.groups} · ${d.groupCount} 组`;
  if (d.mode === 'groups_ko') return `${E.MODES.groups_ko} · ${d.groupCount} 组 · 每组前 ${d.advance === 1 ? 1 : 2} 名进入下一轮`;
  return `${E.MODES.bracket} · ${d.size} 签`;
}

function cupStateOf(d, items, r) {
  const list = items || [];
  const ended = !!(d && d.endedAt);
  const wait = { note: ended ? '活动已提前结束（未打满全部场次）；如需记入积分，可先恢复活动补完或到排行页手动补录一站' : '全部场次结束后，可以在这里结算积分', btn: '' };
  const done = (r && r.fresh && typeof r.fresh.done === 'boolean') ? r.fresh.done : (list.length > 0 && list.every((x) => x.done));
  const s = r && r.stop;
  if (r && !s && r.manual) return { cupBox: null, canEditCup: false };
  if (r && r.removed) return { cupBox: { note: '这个活动的积分已经撤下', btn: '' }, canEditCup: false };
  // 已经发布过、后来又有场次被撤销 / 重新打开：积分照旧有效，留着入口好更正
  if (!done) return { cupBox: s && s.status === 'published' ? { note: '有场次撤销或重新打开了，已发布的积分照旧有效；需要时打开核对更正', warn: true, btn: '查看积分', primary: false } : wait, canEditCup: !s };
  if (!s) return { cupBox: { note: '名次按对阵自动带入，核对后再发布', btn: '结算 LULU 积分', primary: true }, canEditCup: true };
  if (r.stale) return { cupBox: { note: '赛果改过，名次和' + (s.status === 'published' ? '已发布的积分' : '草稿') + '对不上，请重新核对' + (s.status === 'published' ? '并发布更正' : ''), warn: true, btn: '重新核对积分', primary: true }, canEditCup: false };
  if (s.status !== 'published') return { cupBox: { note: '已保存草稿，成员还看不到', btn: '继续结算', primary: true }, canEditCup: false };
  return { cupBox: { note: '已发布' + (s.fixes ? ` · 更正过 ${s.fixes} 次` : ''), btn: '查看积分', primary: false }, canEditCup: false };
}

Page({
  data: {
    draw: null, meta: '', levelText: '', formatText: '', seedLabel: '', seedRows: [], error: '', myName: '', myId: '',
    cupTag: '', cupBox: null, canEditCup: false, cupKindBusy: false, isRot: false, rotRounds: [],
    ready: false, btnReady: false, signupsKnown: false, signing: false, ended: false, endReason: '', canClose: false, canReopen: false, closeBusy: false, posterBtnText: '生成对阵图',
    isDouble: false, signups: [], signCount: '', signText: '', signNote: '', joined: false, isOwner: false, full: false, busy: false,
    partnerOpts: [], info: null, adminSheet: null, adminBusy: false, // adminSheet：管理员代报名的选人弹层（components/member-sheet）
    matches: [], tab: 'board', schedule: [], onlyMine: false, focus: '', progress: '', todo: 0, slotEdit: null,
    schFilter: 'all', wdView: { entrants: [], rows: [] }, wdCount: 0, // 场次：全部 / 退赛／弃权
    courts: E.COURTS.map((c) => c || '沿用活动场地'),
  },

  onLoad(options) {
    this.id = options.id;
    // 从活动首页「我的下一场」进来：打开「场次」并定位到这一场（只定位一次，返回本页刷新时不再跳）
    if (options.tab === 'schedule') { this.setData({ tab: 'schedule' }); this.focusKey = decodeURIComponent(options.key || ''); }
    this.preview();
    // 进页面马上开始读（活动首页点卡片时已经预先发出，这里直接接过来），不等 onShow；紧接着的第一次 onShow 不再重复读
    this.skipShow = true;
    this.load();
  },
  onShow() { // 从录分页 / 资料页 / 抽签页回来时刷新
    if (this.skipShow) { this.skipShow = false; return; }
    this.load();
  },
  onUnload() { this.gone = true; clearTimeout(this.focusTimer); }, // 关闭后不再画分享封面
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    this.load().then(() => wx.stopPullDownRefresh()); },

  // 先用本机已有的数据画出来（活动列表的本机缓存 + 本机战绩），云端 drawDetail 读完再更正。
  //   报名中的活动：内存里 60 秒内读过的详情（peekDrawDetail）、上次的名单（cachedDrawSignups）或我的报名缓存（cachedMySignups）
  //   能确定报名状态时，第一帧同步画出报名 / 取消 / 截止报名 / 删除等按钮（btnReady: true），避免页面打开后按钮延迟蹦出与宽度跳动；
  //   云端读完（ready: true）后再按最新结果更正，名单为空时仍在 ready 前不提示「还没有人报名」。
  preview() {
    let d = null, signups = null, me = null, peekCup = null;
    try {
      const peek = db.peekDrawDetail(this.id);
      if (peek && peek.draw) { d = peek.draw; signups = peek.signups || null; me = peek.profile || null; peekCup = peek.cup || null; }
      if (!d) d = db.cachedDraws().find((x) => x && x._id === this.id) || null;
      if (d && !signups) signups = db.cachedDrawSignups(this.id);
    } catch (e) { d = null; }
    if (!d) return;
    me = me || db.cachedProfile();
    try {
      const all = db.cachedMatches();
      const myId = db.cachedOpenid() || (me && me._openid) || '';
      let extra = null;
      if (d.status === 'signup') {
        const players = db.cachedPlayersFull();
        if (Array.isArray(signups)) {
          const mine = signups.find((s) => !!myId && s._openid === myId) || null;
          extra = Object.assign(this.buildSignupPatch(d, signups, mine, players, false, all, myId), { btnReady: true, signupsKnown: true });
        } else {
          const mySu = db.cachedMySignups ? db.cachedMySignups() : null;
          if (Array.isArray(mySu)) {
            const joined = mySu.some((s) => s && s.drawId === this.id);
            this.partnerPool = players.filter((p) => p.uid && p.uid !== myId);
            extra = {
              joined,
              full: false,
              partnerOpts: [NO_PARTNER].concat(this.partnerPool.map((p) => p.name)),
              btnReady: true,
            };
          }
        }
      } else {
        extra = { btnReady: true };
      }
      this.show(d, all, me, myId, null, null, extra);
      if (d.status !== 'signup' && peekCup && require('../../utils/member').isAdminLocal() && C.drawCupOf(d)) this.applyCup(peekCup);
    } catch (e) { console.warn('[活动详情] 本机缓存画不出来，等云端', e); }
  },

  // 防乱序：onShow、下拉刷新、处理退赛后都会调 load，几次请求先后回来时只用最后一次的结果（旧的晚到也不画）
  load() {
    const p = this.loadNow();
    this.loadP = p;
    return p;
  },
  async loadNow() {
    const seq = this.loadSeq = (this.loadSeq || 0) + 1;
    const stale = () => seq !== this.loadSeq || this.gone;
    try {
      // 活动、报名名单、我的资料、退赛申请：云函数 drawDetail 一次取齐。比赛和球员用共享版（只读，不复制，
      // 和排行榜、球员主页共用一次水平分计算）同时读；drawDetail 先回来就先用本机的比赛 / 球员画出人数和名单，不干等
      const shared = { all: null, players: null };
      const allP = db.matchesShared().catch(() => db.cachedMatches()).then((x) => (shared.all = x));
      const playersP = db.playersShared().then((x) => (shared.players = { players: x, shared: true }), () => (shared.players = { players: db.cachedPlayersFull() }));
      const [bundle, myId] = await Promise.all([db.fetchDrawDetail(this.id), db.myOpenid().catch(() => '')]);
      let d, me, signups;
      if (bundle) { d = bundle.draw; me = bundle.profile; signups = bundle.signups; }
      else { // 云函数还是旧版本：分开读取
        [d, me, signups] = await Promise.all([
          db.getDraw(this.id),
          db.getMyProfile().catch(() => db.cachedProfile()),
          db.fetchSignups(this.id).catch(() => []),
        ]);
      }
      if (stale()) return;
      const fresh = { bundle, signups };
      if (shared.all && shared.players) {
        await this.show(d, shared.all, me, myId, Object.assign(fresh, { players: shared.players }), stale);
      } else {
        // 共享数据还在路上（比如战绩缓存刚过期、要重新读全部）：先用本机的画，回来后再按最新的整理一遍（排名、胜率、场次）
        await this.show(d, db.cachedMatches(), me, myId, Object.assign({}, fresh, { players: { players: db.cachedPlayersFull() }, early: true }), stale);
        const [all] = await Promise.all([allP, playersP]);
        if (stale()) return;
        await this.show(d, all, me, myId, Object.assign(fresh, { players: shared.players, again: true }), stale);
      }
      if (stale()) return;
      this.loaded = true;
      // 不漏消息（utils/alerts.js）：云端读完就算看过这个活动（首页卡片的标签、tab 数字跟着去掉）。
      // 在这页里自己报名、取消、生成对阵后会重新读，也按最新内容记成看过，自己的操作不会再被提示
      require('../../utils/alerts').seeDraw(d, myId, signups, shared.all || db.cachedMatches());
    } catch (e) {
      if (stale()) return;
      console.error(e);
      // 只画过本机缓存、云端没读到：不留着缓存的内容（可能已被删除）
      this.setData(this.loaded ? { error: '活动加载失败，可能已被删除' } : { error: '活动加载失败，可能已被删除', draw: null, ready: false, btnReady: false, signupsKnown: false });
    }
  },

  // fresh：云端结果 { bundle, signups }；null 表示只是本机缓存的预览
  async show(d, all, me, myId, fresh, stale, previewExtra) {
    const signups = fresh ? fresh.signups : [];
    this.uidOf = ID.drawUids(d, signups); // 「我的比赛」按用户 ID 判断
    d._id = d._id || this.id;
    this.d = d;
    this.allMatches = all;
    wx.setNavigationBarTitle({ title: d.title || '活动' });
    const signing = d.status === 'signup';
    const ended = !!d.endedAt;
    const endReason = ended && E.REASONS.close.indexOf(d.endReason) >= 0 ? d.endReason : '';
    const cfg = E.cfgOf(d);
    const n = (d.entrants || []).length;
    const unit = cfg.type === 'double' && !E.isRotation(d) ? '队' : '人';
    const meta = modeText(d) + (E.categoryText(d) ? ' · ' + E.categoryText(d) : '') + (ended ? ' · 已结束' : signing ? ' · 报名中' : ` · ${n} ${unit}`);
    // 种子名单（旧活动也一样）：单打「种子选手」、双打「种子队伍」，按顺序显示「1 号种子 张三」
    const seedRows = (Array.isArray(d.seeds) ? d.seeds : []).filter((s) => typeof s === 'string' && s).map((name, i) => ({ no: i + 1, name }));
    const seedLabel = cfg.type === 'double' ? '种子队伍' : '种子选手';
    const matches = all.filter((m) => m.drawId === this.id);
    // 随机生成仍由发起人操作；管理员也可手动排对阵。
    const isAdmin = require('../../utils/member').isAdminLocal();
    const isOwner = !!myId && d._openid === myId; // 活动文档已经读到了，不用再查一次
    const canManage = isOwner || isAdmin;
    const p0 = signing ? { done: 0, total: 0, champion: '' } : E.progressOf(d, matches);
    const naturallyDone = !signing && (!!p0.champion || (p0.total > 0 && p0.done === p0.total));
    const canClose = canManage && !ended && !naturallyDone;
    const canReopen = canManage && ended;
    const canEditMatchups = isAdmin && !signing && !ended && !E.isRotation(d) && !matches.length &&
      !Object.keys(d.results || {}).length && !(d.withdrawals || []).length;
    // 积分标签能不能点（管理员更正类别）：报名中一定还没结算，第一帧就定下来；已生成对阵的由 loadCupBox 按云端结果更正，
    // 这里不先清成 false（否则每次回到这页标签都会先变样再变回来）。顶部所有内容一次 setData，不分几帧蹦出来
    const cupOn = isAdmin && !!C.drawCupOf(d);
    const posterBtnText = naturallyDone ? '生成战果图' : '生成对阵图';
    const top = {
      draw: d, meta, levelText: E.levelRangeText(d), cupTag: C.drawCupText(d), seedLabel, seedRows, error: '', signing, ended, endReason, myName: (me && me.name) || '', myId,
      formatText: cfg.type === 'double' ? '双打' : '单打', rulesSum: E.rulesSummary(d), isDouble: cfg.type === 'double', isRot: E.isRotation(d), matches,
      isOwner, canManage, canClose, canReopen, canEdit: isAdmin, canPublish: isOwner && isAdmin, canEditMatchups, posterBtnText, info: this.infoOf(d),
    };
    if (signing) { top.canEditCup = cupOn; top.cupBox = null; this.cupSeq = (this.cupSeq || 0) + 1; } // 报名中：取消还在路上的结算查询
    else if (!cupOn) top.canEditCup = false;
    if (!fresh) { // 预览：同一次 setData 合并已缓存的报名名单和按钮状态，首帧直接到位
      if (previewExtra) Object.assign(top, previewExtra);
      this.setData(top);
      if (!signing) this.renderSchedule(true);
      return;
    }
    this.setData(top);
    if (signing) {
      await this.loadSignups(d, all, fresh.bundle ? signups : null, fresh.players, { ready: true, btnReady: true, signupsKnown: true });
      if (stale && stale()) return;
      // 管理员：顺手预读成员列表（内存里 60 秒），点「＋ 添加报名」时选人弹层马上出来
      if (isAdmin && !this.membersAsked) { this.membersAsked = true; cloud.cached('listMembers').catch(() => {}); }
    } else {
      this.signupSeq = (this.signupSeq || 0) + 1; // 已出签表：取消此前还在路上的报名名单刷新
      this.shareCounts = { entrants: n, unit };
      this.makeCover();
      this.renderSchedule();
      // 退赛申请和积分结算随 drawDetail 一起回来，不靠战绩：拿到就直接画（和 ready 同时出来，不再等二次云函数）。
      // 旧版云函数没带 cup / requests 时，等最新战绩回来的那一遍再兜底单独查，免得 early 阶段调两次
      if (fresh.bundle && fresh.bundle.requests) { this.reqSeq = (this.reqSeq || 0) + 1; this.applyRequests(fresh.bundle.requests); }
      const hasCup = !!(fresh.bundle && fresh.bundle.cup);
      if (hasCup && isAdmin && C.drawCupOf(d)) this.applyCup(fresh.bundle.cup);
      else if (!isAdmin || !C.drawCupOf(d)) { this.cupSeq = (this.cupSeq || 0) + 1; if (this.data.cupBox !== null || this.data.canEditCup) this.setData({ cupBox: null, canEditCup: false }); }
      if (!fresh.early) {
        if (!hasCup) this.loadCupBox(isAdmin);
        if (!fresh.bundle) this.loadRequests();
      }
    }
    if (stale && stale()) return;
    if (!this.data.ready || !this.data.btnReady) this.setData({ ready: true, btnReady: true });
  },

  /* ---------- LULU 积分活动：管理员结算（全部场次结束后；云端 drawDetail / cupFromDraw / cupSave 再校验管理员和完赛） ---------- */
  applyCup(r) {
    this.cupSeq = (this.cupSeq || 0) + 1;
    const { cupBox, canEditCup } = cupStateOf(this.d, this.items, r);
    if (canEditCup !== !!this.data.canEditCup || JSON.stringify(cupBox) !== JSON.stringify(this.data.cupBox)) {
      this.setData({ cupBox, canEditCup });
    }
  },
  async loadCupBox(isAdmin) {
    const seq = this.cupSeq = (this.cupSeq || 0) + 1;
    const set = (cupBox, canEditCup = false) => {
      if (seq === this.cupSeq && (canEditCup !== !!this.data.canEditCup || JSON.stringify(cupBox) !== JSON.stringify(this.data.cupBox))) {
        this.setData({ cupBox, canEditCup });
      }
    };
    if (!isAdmin || !C.drawCupOf(this.d)) { set(null); return; }
    try {
      const r = await cloud.call('cupFromDraw', { drawId: this.id });
      const { cupBox, canEditCup } = cupStateOf(this.d, this.items, r);
      set(cupBox, canEditCup);
    } catch (e) {
      console.warn(e.message);
      set({ note: '暂时读不到积分结算情况，下拉刷新重试', btn: '' });
    }
  },
  openCupSettle() { wx.navigateTo({ url: '/pkg-manage/cup-edit/cup-edit?drawId=' + encodeURIComponent(this.id) }); },
  async editCupKind() {
    if (!this.data.ready || !this.data.canEditCup || this.data.cupKindBusy) return; // 只画了本机缓存时先不让改
    const cup = C.drawCupOf(this.d);
    if (!cup) return;
    const choices = C.kindsForVersion(cup.scoreVersion).filter((k) => k.value !== cup.kind && !C.drawCupError(this.d, k.value));
    if (!choices.length) { wx.showToast({ title: '当前活动没有其他可选类别', icon: 'none' }); return; }
    this.setData({ cupKindBusy: true });
    try {
      const picked = await new Promise((resolve) => wx.showActionSheet({ itemList: choices.map((k) => k.label), success: resolve, fail: () => resolve(null) }));
      const choice = picked && choices[picked.tapIndex];
      if (!choice) return;
      const before = C.KINDS.find((k) => k.value === cup.kind);
      const confirmed = await new Promise((resolve) => wx.showModal({
        title: '修改积分类别',
        content: `将${before.label}改为${choice.label}？已报名的球友和对阵安排会保留。`,
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false),
      }));
      if (!confirmed) return;
      const r = await cloud.call('updateDrawCupKind', { drawId: this.id, kind: choice.value, fromKind: cup.kind });
      this.d = Object.assign({}, this.d, { cup: r.cup });
      this.setData({ draw: this.d, cupTag: C.drawCupText(this.d) });
      wx.showToast({ title: '积分类别已修改', icon: 'success' });
    } catch (e) {
      wx.showModal({ title: '修改失败', content: e.message || '请刷新后重试', showCancel: false });
    } finally {
      this.setData({ cupKindBusy: false });
    }
  },

  /* ---------- 时间地点 ---------- */
  infoOf(d) {
    const WEEK = '日一二三四五六';
    let when = d.date || '';
    if (d.date) { const [y, m, dd] = d.date.split('-').map(Number); when = `${m}月${dd}日 周${WEEK[new Date(y, m - 1, dd).getDay()]}`; }
    if (d.startTime) when += ' ' + d.startTime;
    const loc = E.locationOf(d.location);
    if (!d.venue && !loc && !d.startTime) return { when, empty: true };
    // 地点：云端检测过的名称和地址（publicDraw 已处理）；以前的活动只有坐标，显示「已设置地图位置」
    const place = loc ? d.place || { name: '已设置地图位置', address: '' } : null;
    return { when, venue: d.venue || '', place, canNav: !!loc };
  },

  /* ---------- 退赛（签表生成后）：球员申请，发起人处理；发起人也可以直接登记 ---------- */
  async loadRequests() {
    const seq = this.reqSeq = (this.reqSeq || 0) + 1;
    try {
      const r = await cloud.call('drawRequests', { drawId: this.id });
      if (seq !== this.reqSeq || this.gone) return;
      this.applyRequests(r);
    } catch (e) { console.warn(e.message); }
  },
  applyRequests(r) {
    {
      const wd = E.withdrawalsOf(this.d);
      const POL = { walkover: '未赛场次判对手弃权胜', void: '取消全部小组成绩' };
      this.setData({
        wdPending: r.list.filter((x) => x.type === 'withdraw' && x.status === 'pending'),
        myWd: r.list.find((x) => x.type === 'withdraw' && !r.owner) || null,
        canWithdraw: !r.owner || r.myEntrants.length ? r.myEntrants.some((e) => !wd[e]) : false,
        withdrawn: (r.withdrawals || []).map((w) => ({ entrant: w.entrant, text: w.stage === 'group' ? POL[w.policy] || '' : w.stage === 'rotation' ? '没打的轮次判弃权负' : '单淘汰阶段退赛，下一场对手弃权胜' })),
        wdOwner: r.owner,
        wdCandidates: (this.d.entrants || []).filter((e) => !wd[e]),
      });
    }
  },
  // 防连点：选原因、确认、提交、刷新整个过程只走一次；结束（成功、失败、取消）后才能再点
  once(name, fn) {
    if (this[name]) return undefined; // 正在进行：直接忽略（不返回 Promise）
    this[name] = true;
    const done = () => { this[name] = false; };
    return Promise.resolve().then(fn).then((v) => { done(); return v; }, (e) => { done(); throw e; });
  },
  requestWithdraw() {
    return this.once('wdLock', async () => {
      const reason = await pick.reason('withdraw', '退赛原因（发起人会看到）');
      if (!reason) return;
      try { await cloud.call('requestWithdraw', { drawId: this.id, reason }); wx.showToast({ title: '已提交，等发起人处理', icon: 'none' }); await this.loadRequests(); }
      catch (e) { wx.showModal({ title: '提交失败', content: e.message, showCancel: false }); }
    });
  },
  // 小组赛还有没打完的场次：必须由发起人明确选择处理方式（没有默认）
  needPolicy() {
    const d = this.d;
    if (!E.hasGroups(d)) return false;
    return d.mode === 'groups' || (this.items || []).some((x) => /^g/.test(x.key) && !x.done);
  },
  pickPolicy(entrant) {
    return new Promise((resolve) => wx.showActionSheet({
      itemList: ['已赛成绩保留，未赛场次判对手弃权胜', '取消该球员全部小组成绩（含已打的）'],
      success: (r) => resolve(r.tapIndex === 0 ? 'walkover' : 'void'), fail: () => resolve(null),
    }));
  },
  doWithdraw(base) { return this.once('wdLock', () => this.doWithdrawNow(base)); },
  async doWithdrawNow(base) {
    let policy;
    if (this.needPolicy()) { policy = await this.pickPolicy(base.entrant); if (!policy) return; }
    const reason = await pick.reason('withdraw', '退赛原因（会留档）');
    if (!reason) return;
    const data = Object.assign({ drawId: this.id, approve: true, policy, reason }, base);
    try {
      let r = await cloud.call('handleWithdraw', data);
      if (r.needConfirm) {
        const list = r.impact.map((x) => `${x.stage}：${x.a} vs ${x.b} ${x.score}`).join('\n');
        const ok = await new Promise((res) => wx.showModal({ title: '会影响后续比赛', content: `下面已录分的比赛对阵会变化，比分将作废并留档：\n${list}`, confirmText: '确认处理', confirmColor: '#e5484d', success: (x) => res(x.confirm) }));
        if (!ok) return;
        r = await cloud.call('handleWithdraw', Object.assign(data, { confirmImpact: true }));
      }
      wx.showToast({ title: '已处理退赛', icon: 'success' });
      await this.load();
    } catch (e) { wx.showModal({ title: '处理失败', content: e.message, showCancel: false }); }
  },
  approveWithdraw(e) { const x = this.data.wdPending[e.currentTarget.dataset.i]; return x ? this.doWithdraw({ requestId: x.id, entrant: x.entrant }) : undefined; },
  rejectWithdraw(e) {
    const x = this.data.wdPending[e.currentTarget.dataset.i];
    if (!x) return undefined;
    return this.once('wdLock', async () => {
      const reason = await pick.reason('keep', '拒绝退赛申请的原因');
      if (!reason) return;
      try { await cloud.call('handleWithdraw', { drawId: this.id, requestId: x.id, approve: false, reason }); wx.showToast({ title: '已拒绝', icon: 'none' }); await this.loadRequests(); }
      catch (err) { wx.showModal({ title: '处理失败', content: err.message, showCancel: false }); }
    });
  },
  ownerWithdraw(e) { const entrant = this.data.wdCandidates[Number(e.detail.value)]; return entrant ? this.doWithdraw({ entrant }) : undefined; },

  openMap() {
    const d = this.d, loc = d.location;
    if (loc && typeof loc.latitude === 'number') {
      const p = d.place || {};
      wx.openLocation({ latitude: loc.latitude, longitude: loc.longitude, name: p.name || d.venue || '活动场地', address: p.address || '', scale: 16 });
    }
  },
  // 点报名名单里的球员 → 球员主页（按用户 ID 打开，和「我的」同一套页面）
  openAA() {
    const d = this.d;
    if (!d) return;
    let n = 0;
    if (d.status === 'signup') {
      n = (this.data.signups || []).filter((s) => !s.waiting).reduce((acc, s) => acc + ((s.members && s.members.length) || 1), 0);
    } else {
      const wd = {};
      (d.withdrawals || []).forEach((w) => { if (w && w.entrant) wd[w.entrant] = 1; });
      const active = (d.entrants || []).filter((e) => e && !wd[e]);
      n = active.reduce((acc, e) => acc + String(e).split(' / ').filter(Boolean).length, 0);
    }
    const q = `title=${encodeURIComponent(d.title || '')}&date=${encodeURIComponent(d.date || '')}&n=${n || 4}`;
    wx.navigateTo({ url: '/pkg-tools/aa/aa?' + q });
  },
  openPoster() {
    if (!this.d || this.d.status === 'signup') return;
    haptic.light();
    wx.navigateTo({ url: '/pkg-tools/draw-poster/draw-poster?id=' + encodeURIComponent(this.id) });
  },
  openPlayer(e) {
    const uid = e.currentTarget.dataset.uid;
    if (!uid) { wx.showToast({ title: '这位球员没有绑定账号', icon: 'none' }); return; }
    if (uid === this.data.myId) { wx.switchTab({ url: '/pages/me/me' }); return; }
    wx.navigateTo({ url: '/pages/player/player?uid=' + encodeURIComponent(uid) });
  },
  goEdit() { if (!this.data.canEdit) return; wx.navigateTo({ url: '/pkg-manage/event-edit/event-edit?id=' + this.id }); },
  goEditSettings() {
    if (this.data.canEdit && this.data.signing) wx.navigateTo({ url: '/pkg-manage/draw-new/draw-new?id=' + encodeURIComponent(this.id) + '&settings=1' });
  },

  /* ---------- 报名 ---------- */
  buildSignupPatch(d, list, mine, players, shared, matches, myId) {
    this.signupRows = list;
    const stats = S.playerStats(matches || db.cachedMatches(), players, shared && db.profilesOf ? db.profilesOf(players) : undefined);
    const profOf = {};
    players.forEach((p) => { profOf[p.name] = p; });
    const byUid = {};
    players.forEach((p) => { if (p.uid) byUid[p.uid] = p; });
    const person = (snapName, uid) => {
      const cur = uid && byUid[uid];
      const name = cur ? cur.name : snapName;
      return Object.assign({
        name, uid: uid || '', initial: initialOf(name), color: colorOf(name),
      }, S.display(stats, name, cur || profOf[name], uid));
    };
    const st = E.signupStatus(d, list);
    const capP = st.cap, wait = st.wait;
    const signups = list.map((s, i) => {
      const members = [person(s.name, s._openid)];
      if (s.partner) members.push(person(s.partner, s.partnerId));
      return Object.assign({ _id: s._id, no: i + 1, solo: !s.partner, waiting: !!wait[s._id], members }, members[0]);
    });
    const waitPeople = st.waiting;
    const takenId = {};
    let people = 0;
    list.forEach((s) => { people += s.partner ? 2 : 1; if (s._openid) takenId[s._openid] = 1; if (s.partnerId) takenId[s.partnerId] = 1; });
    this.partnerPool = players.filter((p) => p.uid && p.uid !== myId && !takenId[p.uid]);
    const partnerOpts = [NO_PARTNER].concat(this.partnerPool.map((p) => p.name));
    this.shareCounts = { people, cap: capP, wait: waitPeople };
    return {
      signups, partnerOpts,
      joined: !!mine || (!!myId && !!takenId[myId]),
      full: st.full,
      signText: st.text, signNote: st.note,
      myWaiting: !!mine && !!wait[mine._id] || signups.some((x) => x.waiting && x.members.some((p) => p.uid && p.uid === myId)),
      signCount: (capP ? `${people - waitPeople} / ${capP} 人` : `${people} 人`) + (waitPeople ? ` · 候补 ${waitPeople} 人` : ''),
    };
  },

  // preloaded：drawDetail 已经带回来的报名名单（没有就重新读，报名 / 取消后用）
  // pl：{ players, shared }（load 已经读到的球员；shared = db.playersShared 的共享数组）。不传就自己读共享版
  async loadSignups(d, matches, preloaded, pl, extra) {
    const seq = this.signupSeq = (this.signupSeq || 0) + 1;
    let list, mineDoc, got;
    if (preloaded && pl) {
      list = preloaded; mineDoc = null; got = pl;
    } else {
      [list, mineDoc, got] = await Promise.all([
        preloaded || db.fetchSignups(this.id), preloaded ? null : db.mySignup(this.id),
        pl || db.playersShared().then((players) => ({ players, shared: true }), () => ({ players: db.cachedPlayersFull() })),
      ]);
    }
    if (seq !== this.signupSeq || this.gone) return; // 后发的新刷新已经开始 / 页面已关：不让旧名单盖掉新的
    const myId = this.data.myId;
    const mine = preloaded ? list.find((s) => !!myId && s._openid === myId) : mineDoc;
    const patch = this.buildSignupPatch(d, list, mine, got.players || [], !!got.shared, matches, myId);
    if (extra) Object.assign(patch, extra);
    this.setData(patch);
    this.makeCover();
  },

  // 管理员代报名（补录外部活动）：在选人弹层里选正式成员，双打接着选搭档（可以不带），确认后由云端 adminAddSignup
  //   按本人报名同一套规则校验（组别、性别、重名、搭档），并留档。已在名单里的（含被带的搭档）不出现
  async openAdminSignup() {
    if (!this.data.canEdit || !this.data.signing || this.data.adminBusy) return;
    if (!this.data.ready && this.loadP) { try { await this.loadP; } catch (e) {} }
    if (!this.data.canEdit || !this.data.signing) return;
    this.setData({ adminBusy: true });
    try {
      const { active } = await cloud.cached('listMembers'); // 进页面时预读过；60 秒内的就直接用（报名照样由云端按规则校验）
      const taken = new Set((this.signupRows || []).flatMap((s) => [s._openid, s.partnerId]).filter(Boolean));
      this.adminPool = (active || []).filter((m) => m.uid && m.nickname && !taken.has(m.uid))
        .map((m) => ({ uid: m.uid, name: m.nickname, g: S.GENDER[m.gender] || '' }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      if (!this.adminPool.length) { wx.showToast({ title: '没有可添加的球友', icon: 'none' }); return; }
      this.adminPlayer = null;
      this.setData({ adminSheet: { title: '添加报名', sub: '选择要报名的球友', list: this.adminPool, extra: '' } });
    } catch (e) { wx.showToast({ title: e.message || '读取成员失败', icon: 'none' }); }
    finally { this.setData({ adminBusy: false }); }
  },
  adminPick(e) {
    const p = (this.adminPool || []).find((m) => m.uid === e.detail.uid);
    if (!p) return;
    if (this.adminPlayer) { this.confirmAdminSignup(this.adminPlayer, p); return; }
    if (!this.data.isDouble || this.data.isRot) { this.confirmAdminSignup(p, null); return; }
    this.adminPlayer = p; // 双打：接着选搭档
    this.setData({ adminSheet: { title: `选择 ${p.name} 的搭档`, sub: '也可以不带搭档', list: this.adminPool.filter((m) => m.uid !== p.uid), extra: '不带搭档' } });
  },
  adminSolo() { if (this.adminPlayer) this.confirmAdminSignup(this.adminPlayer, null); },
  closeAdminSheet() { this.adminPlayer = null; this.setData({ adminSheet: null }); },
  confirmAdminSignup(player, partner) {
    this.closeAdminSheet();
    wx.showModal({
      title: '添加报名？', content: `把 ${partner ? player.name + ' / ' + partner.name : player.name} 加进报名名单（会留档）`, confirmText: '添加',
      success: (r) => { if (r.confirm) this.saveAdminSignup(player, partner); },
    });
  },
  async saveAdminSignup(player, partner) {
    if (this.data.adminBusy) return;
    this.setData({ adminBusy: true });
    try {
      const r = await cloud.call('adminAddSignup', { drawId: this.id, playerId: player.uid, partnerId: partner ? partner.uid : '' });
      await this.loadSignups(this.d, this.allMatches);
      wx.showToast({ title: r.already ? '这位球友已报名' : r.waiting ? '已添加到候补' : '已添加', icon: 'none' });
    } catch (e) { wx.showModal({ title: '添加失败', content: e.message || '请稍后再试', showCancel: false }); }
    finally { this.setData({ adminBusy: false }); }
  },

  // 双打：先在弹出的列表里选搭档
  joinDouble(e) {
    const i = Number(e.detail.value);
    this.join(i > 0 ? this.partnerPool[i - 1] : null);
  },

  // 在第一个 await 之前就上锁：读资料的那一下连点两次也只报一次名（busy 要等读完资料才设）
  join(partnerPick) {
    if (this.data.busy) return undefined;
    return this.once('joinLock', () => this.joinNow(partnerPick));
  },
  async joinNow(partnerPick) {
    const pick = partnerPick && partnerPick.uid ? partnerPick : null;
    let me = db.cachedProfile();
    try { me = await db.getMyProfile(); } catch (e) {}
    if (!me) {
      wx.showModal({
        title: '先设置昵称', content: '报名名单里会显示你的昵称', confirmText: '去设置',
        success: (r) => { if (r.confirm) wx.navigateTo({ url: '/pkg-manage/profile/profile?from=signup' }); },
      });
      return;
    }
    this.setData({ busy: true });
    try {
      let partner = null;
      if (pick) {
        const list = await db.fetchSignups(this.id);
        if (list.some((s) => s._openid === pick.uid || s.partnerId === pick.uid)) {
          wx.showToast({ title: `${pick.name} 已经报名了`, icon: 'none' });
          await this.loadSignups(this.d, this.allMatches);
          return;
        }
        partner = { name: pick.name, uid: pick.uid };
      }
      const res = await db.signUp(this.id, partner);
      haptic.medium();
      wx.showToast(res && res.waiting ? { title: '名额已满，已排进候补', icon: 'none' } : { title: '报名成功', icon: 'success' });
      await this.loadSignups(this.d, this.allMatches);
    } catch (e) {
      console.error(e);
      wx.showModal({ title: '报名失败', content: e.message || '请稍后再试', showCancel: false });
    } finally { this.setData({ busy: false }); }
  },

  // 防连点：确认框弹出到取消完成（或点了「取消」）之间再点不会再弹一次、不会重复提交
  quit() {
    if (this.data.busy) return undefined;
    return this.once('quitLock', async () => {
      const ok = await new Promise((resolve) => wx.showModal({
        title: '取消报名？',
        content: this.data.isDouble && !this.data.isRot ? '会连同你的搭档一起取消' : '',
        success: (r) => resolve(!!r.confirm), fail: () => resolve(false),
      }));
      if (!ok) return;
      this.setData({ busy: true });
      try {
        const mine = await db.mySignup(this.id);
        if (!mine) { wx.showToast({ title: '是搭档帮你报的名，请让 TA 取消', icon: 'none' }); return; }
        await db.cancelSignup(this.id);
        await this.loadSignups(this.d, this.allMatches);
        wx.showToast({ title: '已取消' });
      } catch (e) { wx.showModal({ title: '取消失败', content: e.message || '请稍后再试', showCancel: false }); }
      finally { this.setData({ busy: false }); }
    });
  },

  async startDraw() {
    if (!this.data.canEdit || !this.data.signing || (this.data.isRot && !this.data.canPublish)) return;
    if (!this.data.ready && this.loadP) { try { await this.loadP; } catch (e) {} }
    if (!this.data.canEdit || !this.data.signing) return;
    if (this.data.signups.length < 2) { wx.showToast({ title: '报名的还不够', icon: 'none' }); return; }
    // 四人轮换：要报满 4 位（候补的不算）才能生成
    if (this.data.isRot && this.data.signups.filter((s) => !s.waiting).length < E.ROTATION_SIZE) { wx.showToast({ title: '四人轮换双打要报满 4 位才能生成对阵', icon: 'none' }); return; }
    wx.navigateTo({ url: '/pkg-manage/draw-new/draw-new?id=' + encodeURIComponent(this.id) + (this.data.canPublish ? '' : '&manual=1') });
  },
  editDrawMatchups() {
    if (this.data.canEdit && this.data.canEditMatchups) wx.navigateTo({ url: '/pkg-manage/draw-new/draw-new?id=' + encodeURIComponent(this.id) + '&manual=1' });
  },

  /* ---------- 签表 / 赛程 ---------- */
  renderSchedule(preview) {
    const d = this.d, me = this.data.myName;
    const list = E.scheduleOf(d, this.data.matches);
    // 名字后面带性别（读个人资料，按账号找）；双打的队名和成员名对不上时只显示队名
    const gOf = S.genderFinder(db.cachedPlayersFull());
    const uidOf = this.uidOf || {};
    const side = (members) => members.map((n) => ({ name: n, uid: uidOf[n] || '', initial: initialOf(n), color: colorOf(n), gender: gOf(n, uidOf[n]) }));
    const setCols = (sets, s) => {
      const opp = s === 'a' ? 'b' : 'a', tbk = s === 'a' ? 'tbA' : 'tbB';
      return (sets || []).map((x) => {
        const v = Number(x[s]), o = Number(x[opp]), tb = x[tbk];
        return { v: Number.isFinite(v) ? String(v) : '', w: Number.isFinite(v) && Number.isFinite(o) && v > o, tb: tb !== undefined && tb !== null && tb !== '' ? String(tb) : '' };
      });
    };
    const items = list.map((x) => {
      const hasSets = !!(x.sets && x.sets.length);
      const scoreNote = x.done ? (x.outcome && x.outcome !== 'normal' ? (x.outcomeText || x.score || '') : (hasSets ? '' : (x.score || ''))) : '';
      return Object.assign({}, x, {
        aP: side(x.aMembers), bP: side(x.bMembers),
        aG: !x.tbdA && x.aMembers.join(' / ') === x.a, bG: !x.tbdB && x.bMembers.join(' / ') === x.b,
        aText: x.tbdA ? x.labelA || '待定' : x.a, bText: x.tbdB ? x.labelB || '待定' : x.b,
        aSets: setCols(x.sets, 'a'), bSets: setCols(x.sets, 'b'), hasSets, scoreNote,
        mine: !!this.data.myId && ID.idsFor(x.aMembers.concat(x.bMembers), this.uidOf).indexOf(this.data.myId) >= 0,
        status: x.done ? 'done' : x.ready ? 'ready' : 'tbd',
      });
    });
    const done = items.filter((x) => x.done).length;
    const p = E.progressOf(d, this.data.matches);
    this.items = items;
    // 退赛／弃权：参赛状态 + 赛程影响（谁进入下一轮、积分榜怎么记），和场次列表同一份数据；「只看我的」一样生效
    const my = this.data.myId;
    const wv = WV.withdrawView(d, items, (name) => !!my && ID.idsFor(E.membersOf(d, name), this.uidOf).indexOf(my) >= 0);
    const only = this.data.onlyMine;
    // 四人轮换：按轮次显示搭档、对手和状态；「你这轮和谁搭档、对谁」按用户 ID 认
    const ended = !!d.endedAt;
    let rotRounds = [];
    if (E.isRotation(d)) {
      rotRounds = items.map((x) => {
        const aIds = ID.idsFor(x.aMembers, uidOf), bIds = ID.idsFor(x.bMembers, uidOf);
        const side = my && aIds.indexOf(my) >= 0 ? 'a' : my && bIds.indexOf(my) >= 0 ? 'b' : '';
        const mates = side ? (side === 'a' ? x.aMembers : x.bMembers).filter((n, i) => (side === 'a' ? aIds : bIds)[i] !== my) : [];
        const opps = side === 'a' ? x.bMembers : side === 'b' ? x.aMembers : [];
        const st = x.done ? (x.outcome && x.outcome !== 'normal' ? x.outcomeText || '已完赛' : side ? (x.winner === side ? '你们赢了' : '你们输了') : '已完赛') : ended ? '未进行' : side ? '待录分' : '待赛';
        return {
          key: x.key, round: x.round, aP: x.aP, bP: x.bP, winner: x.winner, done: x.done, score: x.score, st, win: !!side && x.done && x.winner === side,
          me: side ? `你和 ${mates.join('、')} 搭档，对手 ${opps.join('、')}` : '',
          canScore: !x.done && !ended && (side !== '' || this.data.isOwner),
        };
      });
    }
    this.setData({
      rotRounds,
      wdView: { entrants: only ? wv.entrants.filter((x) => x.mine) : wv.entrants, rows: only ? wv.rows.filter((x) => x.mine) : wv.rows },
      wdCount: wv.count,
      schedule: this.data.onlyMine ? items.filter((x) => x.mine) : items,
      todo: ended ? 0 : items.filter((x) => x.mine && x.ready && !x.done).length,
      progress: p.champion ? `冠军：${p.champion}` : ended ? `已提前结束 · 完赛 ${done} / ${items.length} 场` : `已完成 ${done} / ${items.length} 场`,
    });
    this.focusFixture(preview);
  },
  // preview：本机缓存画的，找不到这一场先不放弃，等云端读完再找一次
  focusFixture(preview) {
    const key = this.focusKey;
    if (!key) return;
    const found = (this.items || []).some((x) => x.key === key);
    if (!found && preview) return;
    this.focusKey = '';
    if (!found) return;
    this.setData({ focus: key });
    setTimeout(() => { if (!this.gone) wx.pageScrollTo({ selector: '#sch-' + key, offsetTop: -24, duration: 300, fail() {} }); }, 50); // 等这次渲染完再滚
    this.focusTimer = setTimeout(() => { if (!this.gone) this.setData({ focus: '' }); }, 2400); // 高亮一会儿就恢复
  },

  /* ---------- 单场安排（发起人）：这一场具体哪天、几点、哪片场地 ---------- */
  // 对阵还没确定的场次也可以先排；没排的场次沿用活动的日期、时间和场地
  planSlot(e) {
    const x = (this.items || []).find((i) => i.key === e.currentTarget.dataset.key);
    if (!x || !this.data.isOwner) return;
    const s = x.slot || {};
    this.setData({ slotEdit: { key: x.key, title: `${x.stage} · ${x.aText} vs ${x.bText}`, date: s.date || '', time: s.time || '', court: E.courtOf(s.court), courtIndex: E.COURTS.indexOf(E.courtOf(s.court)), had: !!x.slot, defDate: this.d.date || '' } });
  },
  slotDate(e) { this.setData({ 'slotEdit.date': e.detail.value }); },
  slotTime(e) { this.setData({ 'slotEdit.time': e.detail.value }); },
  slotCourt(e) {
    const index = Number(e.detail.value);
    this.setData({ 'slotEdit.court': E.COURTS[index] || '', 'slotEdit.courtIndex': index });
  },
  slotCancel() { this.setData({ slotEdit: null }); },
  slotClear() { this.saveSlot({ date: '', time: '', court: '' }); },
  slotSave() {
    const s = this.data.slotEdit;
    const slot = { date: s.date, time: s.time, court: E.courtOf(s.court) };
    if (!slot.date && !slot.time && !slot.court) { wx.showToast({ title: '请至少填一项', icon: 'none' }); return; }
    // 同一天同一开打时间：同一片场地、同一位球员（按用户 ID）已经排在别的场次 → 先提示，可以返回修改或仍然保存
    const hits = SC.slotConflicts(this.d, this.data.matches, this.uidOf, s.key, slot);
    if (!hits.length) { this.saveSlot(slot); return; }
    wx.showModal({
      title: '时间场地有冲突', content: SC.conflictText(hits, slot, this.d),
      cancelText: '返回修改', confirmText: '仍然保存',
      success: (r) => { if (r.confirm) this.saveSlot(slot); }, // 返回修改：安排面板保持打开
    });
  },
  async saveSlot(slot) {
    if (this.data.busy) return;
    const key = this.data.slotEdit.key;
    this.setData({ busy: true });
    try {
      const r = await db.setFixtureSlot(this.id, key, slot);
      const slots = Object.assign({}, this.d.slots || {});
      if (r.slot) slots[key] = r.slot; else delete slots[key];
      this.d.slots = slots;
      this.setData({ slotEdit: null });
      this.renderSchedule();
      wx.showToast({ title: r.slot ? '已保存安排' : '已清除安排', icon: 'none' });
    } catch (e) { wx.showModal({ title: '保存失败', content: e.message || '请稍后再试', showCancel: false }); }
    finally { this.setData({ busy: false }); }
  },

  setTab(e) {
    const v = e.currentTarget.dataset.v;
    if (v !== this.data.tab) haptic.light();
    this.setData({ tab: v });
  },
  toggleMine() { haptic.light(); this.setData({ onlyMine: !this.data.onlyMine }); this.renderSchedule(); },
  setSchFilter(e) {
    const v = e.currentTarget.dataset.v === 'wd' ? 'wd' : 'all';
    if (v !== this.data.schFilter) haptic.light();
    this.setData({ schFilter: v });
  },
  // 退赛／弃权里的场次：能打开的（有对阵的）进录分页查看；成绩取消的场次没有可看的比分
  tapWd(e) {
    const r = (this.data.wdView.rows || []).find((x) => x.key === e.currentTarget.dataset.key);
    if (!r) return;
    if (!r.ready) { wx.showToast({ title: '这场因退赛已取消，没有比分', icon: 'none' }); return; }
    this.openMatch(r.key, true);
  },

  // 点签表 / 积分榜 / 赛程里的某一场 → 录分页（已录的可以查看或修改）
  onOpen(e) { this.openMatch(e.detail.key, e.detail.ready); },
  // 四人轮换：从这一轮直接进场边记分（录分页加载完自动打开记分器，完赛后带回这一轮、核对后正式提交）
  openRotScorer(e) { wx.navigateTo({ url: `/pkg-manage/score/score?drawId=${this.id}&key=${e.currentTarget.dataset.key}&start=scorer` }); },
  tapItem(e) { const x = this.items.find((i) => i.key === e.currentTarget.dataset.key); if (x) this.openMatch(x.key, x.ready); },
  openMatch(key, ready) {
    if (!ready) { wx.showToast({ title: '对手还没确定，等上一轮打完', icon: 'none' }); return; }
    wx.navigateTo({ url: `/pkg-manage/score/score?drawId=${this.id}&key=${key}` });
  },

  // 提前结束活动（发起人或管理员）：下雨、时间到了或中途商议不打了，可直接结束；已录比分完整保留，可随时恢复
  async closeDraw() {
    if (!this.data.canClose || this.data.closeBusy) return;
    const reason = await pick.reason('close', '结束原因');
    if (!reason) return;
    const pinned = !!(this.d && this.d.pinnedAt);
    const go = await new Promise((done) => wx.showModal({
      title: '提前结束这个活动？',
      content: `原因：${reason}\n\n已录入的比分和战绩会完整保留，未打场次标记为未进行、不再出现在「我的下一场」${pinned ? '，并自动取消置顶' : ''}。之后如需继续可以随时恢复。`,
      confirmText: '确认结束',
      success: (x) => done(x.confirm),
      fail: () => done(false),
    }));
    if (!go) return;
    this.setData({ closeBusy: true });
    try {
      await db.closeDraw(this.id, true, reason);
      haptic.medium();
      wx.showToast({ title: '活动已结束', icon: 'success' });
      await this.load();
    } catch (e) {
      wx.showModal({ title: '结束失败', content: e.message || '请稍后再试', showCancel: false });
    } finally { this.setData({ closeBusy: false }); }
  },

  async reopenDraw() {
    if (!this.data.canReopen || this.data.closeBusy) return;
    const go = await new Promise((done) => wx.showModal({
      title: '恢复这个活动？',
      content: '恢复后活动回到原来的状态，未打场次可以继续录分或报名。',
      confirmText: '恢复活动',
      success: (x) => done(x.confirm),
      fail: () => done(false),
    }));
    if (!go) return;
    this.setData({ closeBusy: true });
    try {
      await db.closeDraw(this.id, false);
      haptic.medium();
      wx.showToast({ title: '活动已恢复', icon: 'success' });
      await this.load();
    } catch (e) {
      wx.showModal({ title: '恢复失败', content: e.message || '请稍后再试', showCancel: false });
    } finally { this.setData({ closeBusy: false }); }
  },

  remove() {
    if (!this.data.isOwner) { this.adminRemove(); return; }
    wx.showModal({
      title: '删除这个活动？',
      content: '删除后所有人都看不到这个活动了，未处理的申请会作废（已录的比分仍保留在战绩里）',
      confirmColor: '#e5484d',
      success: async (r) => {
        if (!r.confirm) return;
        this.removeNow('');
      },
    });
  },

  // 置顶 / 取消置顶（管理员，2026-11-24 用户要求）：活动列表里排在最前面
  async togglePin() {
    if (!this.data.canEdit || this.data.pinBusy) return;
    const pinned = !this.data.draw.pinnedAt;
    if (!pinned) { // 已置顶：确认后再取消，免得误点
      const go = await new Promise((done) => wx.showModal({ title: '取消置顶？', content: '取消后这个活动回到活动列表原来的位置', confirmText: '取消置顶', cancelText: '保留', success: (x) => done(x.confirm), fail: () => done(false) }));
      if (!go) return;
    }
    this.setData({ pinBusy: true });
    try {
      await db.pinDraw(this.id, pinned);
      this.d = Object.assign({}, this.d, { pinnedAt: pinned ? Date.now() : 0 });
      this.setData({ 'draw.pinnedAt': pinned ? Date.now() : 0 });
      wx.showToast({ title: pinned ? '已置顶' : '已取消置顶', icon: 'none' });
    } catch (e) {
      wx.showModal({ title: pinned ? '置顶失败' : '取消置顶失败', content: e.message || '请稍后再试', showCancel: false });
    }
    this.setData({ pinBusy: false });
  },

  // 管理员删除别人发起的活动：必须选原因（留档）
  async adminRemove() {
    const go = await new Promise((done) => wx.showModal({ title: '删除这个活动（管理员）', content: '已录比分保留在战绩里。下一步选择删除原因，会留档。', confirmText: '继续', confirmColor: '#e5484d', success: (x) => done(x.confirm), fail: () => done(false) }));
    if (!go) return;
    const reason = await pick.reason('drop', '删除原因');
    if (!reason) return;
    this.removeNow(reason);
  },
  // 删除时显示「正在删除」，删完直接返回（提示会带到上一页）
  async removeNow(reason) {
    if (this.removing) return;
    this.removing = true;
    wx.showLoading({ title: '正在删除', mask: true });
    try {
      await db.removeDraw(this.id, reason, E.titleOf(this.d));
      wx.hideLoading();
      wx.showToast({ title: '已删除' });
      wx.navigateBack();
    } catch (e) {
      wx.hideLoading();
      wx.showModal({ title: '删除失败', content: e.message || '请稍后再试', showCancel: false });
    } finally { this.removing = false; }
  },

  goHome() { wx.switchTab({ url: '/pages/draw/draw' }); },

  /* ---------- 分享封面 ---------- */
  // 内容（日期、人数）变了才重画；画好之前分享用固定封面，或等它画完（微信最多等 3 秒）
  makeCover() {
    const info = Card.cardInfo(this.d, this.shareCounts);
    const key = JSON.stringify(info);
    if (key === this.coverKey) return;
    this.coverKey = key;
    this.cover = '';
    this.coverJob = (this.coverJob || Promise.resolve()).then(async () => {
      await new Promise((r) => setTimeout(r, COVER_DELAY_MS)); // 等页面先渲染完，不和首屏抢时间
      if (key !== this.coverKey || this.gone) return; // 又变了交给后面那次画；页面已关闭就不画
      const path = await Card.render(await this.shareCanvas(), info);
      if (key === this.coverKey) this.cover = path;
    }).catch((e) => console.warn('[分享封面] 生成失败，用固定封面', e));
  },
  shareCanvas() {
    if (this.cv) return Promise.resolve(this.cv);
    return new Promise((ok, bad) => {
      wx.createSelectorQuery().in(this).select('#share-cv').fields({ node: true }).exec((r) => {
        const node = r && r[0] && r[0].node;
        if (!node) return bad(new Error('取不到画布'));
        this.cv = node;
        ok(node);
      });
    });
  },

  onShareAppMessage() {
    const d = this.data.draw;
    const t = d ? d.title : '网球';
    const base = {
      title: this.data.signing ? `${t} 开始报名啦，点击报名` : `${t} · 对阵和场次`,
      path: `/pages/draw-view/draw-view?id=${this.id}`,
      imageUrl: this.cover || Card.FALLBACK,
    };
    if (this.cover || !this.coverJob) return base;
    return Object.assign({}, base, { promise: this.coverJob.then(() => Object.assign({}, base, { imageUrl: this.cover || Card.FALLBACK })) });
  },
});
