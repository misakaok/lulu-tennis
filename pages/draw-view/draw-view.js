// 活动详情：报名 → 签表 / 积分榜 → 赛程 → 点比赛录分
const E = require('../../utils/event');
const R = require('../../utils/rating');
const db = require('../../utils/db');
const ID = require('../../utils/ident');
const cloud = require('../../utils/cloud');
const pick = require('../../utils/pick');
const SC = require('../../utils/slot-conflict');
const Card = require('../../utils/share-card'); // 分享卡片封面（不指定时微信截页面顶部，有时截成空白）
const COVER_DELAY_MS = 800; // 进页面后等一会儿再画封面；这期间分享会等它画完（微信最多等 3 秒）
const S = require('../../utils/stats');
const { colorOf, initialOf } = require('../../utils/rules');

const NO_PARTNER = '暂时没有搭档（由发起人配对）';

function modeText(d) {
  if (d.mode === 'groups') return `${E.MODES.groups} · ${d.groupCount} 组`;
  if (d.mode === 'groups_ko') return `${E.MODES.groups_ko} · ${d.groupCount} 组 · 每组前 ${d.advance === 1 ? 1 : 2} 名进入下一轮`;
  return `${E.MODES.bracket} · ${d.size} 签`;
}

Page({
  data: {
    draw: null, meta: '', levelText: '', formatText: '', seedLabel: '', seedRows: [], error: '', myName: '', myId: '',
    signing: false, isDouble: false, signups: [], signCount: '', signText: '', signNote: '', joined: false, isOwner: false, full: false, busy: false,
    partnerOpts: [], info: null,
    matches: [], tab: 'board', schedule: [], onlyMine: false, focus: '', progress: '', todo: 0, slotEdit: null,
    courts: E.COURTS.map((c) => c || '沿用活动场地'),
  },

  onLoad(options) {
    this.id = options.id;
    // 从活动首页「我的下一场」进来：打开「场次」并定位到这一场（只定位一次，返回本页刷新时不再跳）
    if (options.tab === 'schedule') { this.setData({ tab: 'schedule' }); this.focusKey = decodeURIComponent(options.key || ''); }
  },
  onShow() { this.load(); }, // 从录分页 / 资料页 / 抽签页回来时刷新
  onUnload() { this.gone = true; clearTimeout(this.focusTimer); }, // 关闭后不再画分享封面
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    this.load().then(() => wx.stopPullDownRefresh()); },

  async load() {
    try {
      // 活动、报名名单、我的资料、退赛申请：云函数 drawDetail 一次取齐
      const [bundle, all, myId] = await Promise.all([
        db.fetchDrawDetail(this.id),
        db.fetchMatches().catch(() => db.cachedMatches()),
        db.myOpenid().catch(() => ''),
      ]);
      let d, me, signups;
      if (bundle) { d = bundle.draw; me = bundle.profile; signups = bundle.signups; }
      else { // 云函数还是旧版本：分开读取
        [d, me, signups] = await Promise.all([
          db.getDraw(this.id),
          db.getMyProfile().catch(() => db.cachedProfile()),
          db.fetchSignups(this.id).catch(() => []),
        ]);
      }
      this.uidOf = ID.drawUids(d, signups); // 「我的比赛」按用户 ID 判断
      d._id = d._id || this.id;
      this.d = d;
      this.allMatches = all;
      wx.setNavigationBarTitle({ title: d.title || '活动' });
      const signing = d.status === 'signup';
      const cfg = E.cfgOf(d);
      const n = (d.entrants || []).length;
      const unit = cfg.type === 'double' ? '队' : '人';
      const meta = modeText(d) + (E.categoryText(d) ? ' · ' + E.categoryText(d) : '') + (signing ? ' · 报名中' : ` · ${n} ${unit}`);
      // 种子名单（旧活动也一样）：单打「种子选手」、双打「种子队伍」，按顺序显示「1 号种子 张三」
      const seedRows = (Array.isArray(d.seeds) ? d.seeds : []).filter((s) => typeof s === 'string' && s).map((name, i) => ({ no: i + 1, name }));
      const seedLabel = cfg.type === 'double' ? '种子队伍' : '种子选手';
      const matches = all.filter((m) => m.drawId === this.id);
      this.setData({
        draw: d, meta, levelText: E.levelRangeText(d), seedLabel, seedRows, error: '', signing, myName: (me && me.name) || '', myId,
        formatText: cfg.type === 'double' ? '双打' : '单打', rulesSum: E.rulesSummary(d), isDouble: cfg.type === 'double', matches,
      });
      // 发布和编辑仅管理员；生成对阵还需为发起人。历史发起人保留删除能力，云端逐项校验。
      const isAdmin = require('../../utils/member').isAdminLocal();
      const isOwner = !!myId && d._openid === myId; // 活动文档已经读到了，不用再查一次
      this.setData({ isOwner, canManage: isOwner || isAdmin, canEdit: isAdmin, canPublish: isOwner && isAdmin });
      this.setData({ info: this.infoOf(d) });
      if (signing) await this.loadSignups(d, all, bundle ? signups : null);
      else {
        this.shareCounts = { entrants: n, unit };
        this.makeCover();
        this.renderSchedule();
        if (!bundle) this.loadRequests();
        else if (bundle.requests) this.applyRequests(bundle.requests);
      }
    } catch (e) {
      console.error(e);
      this.setData({ error: '活动加载失败，可能已被删除' });
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
    try { this.applyRequests(await cloud.call('drawRequests', { drawId: this.id })); } catch (e) { console.warn(e.message); }
  },
  applyRequests(r) {
    {
      const wd = E.withdrawalsOf(this.d);
      const POL = { walkover: '未赛场次判对手弃权胜', void: '取消全部小组成绩' };
      this.setData({
        wdPending: r.list.filter((x) => x.type === 'withdraw' && x.status === 'pending'),
        myWd: r.list.find((x) => x.type === 'withdraw' && !r.owner) || null,
        canWithdraw: !r.owner || r.myEntrants.length ? r.myEntrants.some((e) => !wd[e]) : false,
        withdrawn: (r.withdrawals || []).map((w) => ({ entrant: w.entrant, text: w.stage === 'group' ? POL[w.policy] || '' : '单淘汰阶段退赛，下一场对手弃权胜' })),
        wdOwner: r.owner,
        wdCandidates: (this.d.entrants || []).filter((e) => !wd[e]),
      });
    }
  },
  async requestWithdraw() {
    const reason = await pick.reason('withdraw', '退赛原因（发起人会看到）');
    if (!reason) return;
    try { await cloud.call('requestWithdraw', { drawId: this.id, reason }); wx.showToast({ title: '已提交，等发起人处理', icon: 'none' }); this.loadRequests(); }
    catch (e) { wx.showModal({ title: '提交失败', content: e.message, showCancel: false }); }
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
  async doWithdraw(base) {
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
      this.load();
    } catch (e) { wx.showModal({ title: '处理失败', content: e.message, showCancel: false }); }
  },
  approveWithdraw(e) { const x = this.data.wdPending[e.currentTarget.dataset.i]; this.doWithdraw({ requestId: x.id, entrant: x.entrant }); },
  async rejectWithdraw(e) {
    const x = this.data.wdPending[e.currentTarget.dataset.i];
    const reason = await pick.reason('keep', '拒绝退赛申请的原因');
    if (!reason) return;
    try { await cloud.call('handleWithdraw', { drawId: this.id, requestId: x.id, approve: false, reason }); wx.showToast({ title: '已拒绝', icon: 'none' }); this.loadRequests(); }
    catch (err) { wx.showModal({ title: '处理失败', content: err.message, showCancel: false }); }
  },
  ownerWithdraw(e) { const entrant = this.data.wdCandidates[Number(e.detail.value)]; if (entrant) this.doWithdraw({ entrant }); },

  openMap() {
    const d = this.d, loc = d.location;
    if (loc && typeof loc.latitude === 'number') {
      const p = d.place || {};
      wx.openLocation({ latitude: loc.latitude, longitude: loc.longitude, name: p.name || d.venue || '活动场地', address: p.address || '', scale: 16 });
    }
  },
  // 点报名名单里的球员 → 球员主页（按用户 ID 打开，和「我的」同一套页面）
  openPlayer(e) {
    const uid = e.currentTarget.dataset.uid;
    if (!uid) { wx.showToast({ title: '这位球员没有绑定账号', icon: 'none' }); return; }
    if (uid === this.data.myId) { wx.switchTab({ url: '/pages/me/me' }); return; }
    wx.navigateTo({ url: '/pages/player/player?uid=' + encodeURIComponent(uid) });
  },
  goEdit() { if (!this.data.canEdit) return; wx.navigateTo({ url: '/pages/event-edit/event-edit?id=' + this.id }); },

  /* ---------- 报名 ---------- */
  // preloaded：drawDetail 已经带回来的报名名单（没有就重新读，报名 / 取消后用）
  async loadSignups(d, matches, preloaded) {
    const [list, mineDoc, players] = await Promise.all([
      preloaded || db.fetchSignups(this.id), preloaded ? null : db.mySignup(this.id),
      db.fetchPlayersFull().catch(() => db.cachedPlayersFull()),
    ]);
    const mine = preloaded ? list.find((s) => !!this.data.myId && s._openid === this.data.myId) : mineDoc;
    // 排名、场数、胜率、等级都从有效比赛记录实时算；性别读个人资料。没有数据显示「暂无」
    // 名次和排行榜一致：只在同意公开展示的人里排。授权直接看球员列表里的 shown——这里的 players 是复制版，
    // db.profilesOf 认不出来会退回本机缓存（第一次打开时是空的，所有人都会变成「未公开」），所以不传 profiles
    const stats = S.playerStats(matches || db.cachedMatches(), players);
    const profOf = {};
    players.forEach((p) => { profOf[p.name] = p; });
    // 报名名单按账号显示「当前」昵称：改名后报名照样有效，显示也跟着更新
    const byUid = {};
    players.forEach((p) => { if (p.uid) byUid[p.uid] = p; });
    const person = (snapName, uid) => {
      const cur = uid && byUid[uid];
      const name = cur ? cur.name : snapName;
      return Object.assign({
        name, uid: uid || '', initial: initialOf(name), color: colorOf(name),
      }, S.display(stats, name, cur || profOf[name], uid));
    };
    // 候补：名额（淘汰赛的签数 / 小组赛的报名上限）用完之后报名的，按报名先后排队，前面有人取消自动递补。
    // 报名情况的文字（还差几人 / 已满 / 候补几人）和「会不会进候补」都按 E.signupStatus，和云端 signUp 同一套
    const st = E.signupStatus(d, list);
    const capP = st.cap, wait = st.wait;
    const signups = list.map((s, i) => {
      const members = [person(s.name, s._openid)];
      if (s.partner) members.push(person(s.partner, s.partnerId));
      return Object.assign({ _id: s._id, no: i + 1, solo: !s.partner, waiting: !!wait[s._id], members }, members[0]);
    });
    const waitPeople = st.waiting;
    // 按用户 ID 判断谁已经报名（自己报的 _openid，或被搭档带上的 partnerId）
    const takenId = {};
    let people = 0;
    list.forEach((s) => { people += s.partner ? 2 : 1; if (s._openid) takenId[s._openid] = 1; if (s.partnerId) takenId[s.partnerId] = 1; });
    const myId = this.data.myId;
    const isDouble = this.data.isDouble;
    // 搭档只能选已设置资料的球员（有用户 ID），同名资料不能被选
    this.partnerPool = players.filter((p) => p.uid && p.uid !== myId && !takenId[p.uid]);
    const partnerOpts = [NO_PARTNER].concat(this.partnerPool.map((p) => p.name));
    this.setData({
      signups, partnerOpts,
      joined: !!mine || (!!myId && !!takenId[myId]),
      full: st.full, // 满了还能报，只是进候补
      signText: st.text, signNote: st.note,
      myWaiting: !!mine && !!wait[mine._id] || signups.some((x) => x.waiting && x.members.some((p) => p.uid && p.uid === myId)),
      signCount: (capP ? `${people - waitPeople} / ${capP} 人` : `${people} 人`) + (waitPeople ? ` · 候补 ${waitPeople} 人` : ''),
    });
    this.shareCounts = { people, cap: capP, wait: waitPeople };
    this.makeCover();
  },

  // 双打：先在弹出的列表里选搭档
  joinDouble(e) {
    const i = Number(e.detail.value);
    this.join(i > 0 ? this.partnerPool[i - 1] : null);
  },

  async join(partnerPick) {
    if (this.data.busy) return;
    const pick = partnerPick && partnerPick.uid ? partnerPick : null;
    let me = db.cachedProfile();
    try { me = await db.getMyProfile(); } catch (e) {}
    if (!me) {
      wx.showModal({
        title: '先设置昵称', content: '报名名单里会显示你的昵称', confirmText: '去设置',
        success: (r) => { if (r.confirm) wx.navigateTo({ url: '/pages/profile/profile?from=signup' }); },
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
      wx.showToast(res && res.waiting ? { title: '名额已满，已排进候补', icon: 'none' } : { title: '报名成功', icon: 'success' });
      await this.loadSignups(this.d, this.allMatches);
    } catch (e) {
      console.error(e);
      wx.showModal({ title: '报名失败', content: e.message || '请稍后再试', showCancel: false });
    } finally { this.setData({ busy: false }); }
  },

  quit() {
    wx.showModal({
      title: '取消报名？',
      content: this.data.isDouble ? '会连同你的搭档一起取消' : '',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          const mine = await db.mySignup(this.id);
          if (!mine) { wx.showToast({ title: '是搭档帮你报的名，请让 TA 取消', icon: 'none' }); return; }
          await db.cancelSignup(this.id);
          await this.loadSignups(this.d, this.allMatches);
          wx.showToast({ title: '已取消' });
        } catch (e) { wx.showModal({ title: '取消失败', content: e.message || '请稍后再试', showCancel: false }); }
      },
    });
  },

  startDraw() {
    if (!this.data.canPublish) return;
    if (this.data.signups.length < 2) { wx.showToast({ title: '报名的还不够', icon: 'none' }); return; }
    wx.navigateTo({ url: '/pages/draw-new/draw-new?id=' + this.id });
  },

  /* ---------- 签表 / 赛程 ---------- */
  renderSchedule() {
    const d = this.d, me = this.data.myName;
    const list = E.scheduleOf(d, this.data.matches);
    // 名字后面带性别（读个人资料，按账号找）；双打的队名和成员名对不上时只显示队名
    const gOf = S.genderFinder(db.cachedPlayersFull());
    const uidOf = this.uidOf || {};
    const side = (members) => members.map((n) => ({ name: n, uid: uidOf[n] || '', initial: initialOf(n), color: colorOf(n), gender: gOf(n, uidOf[n]) }));
    const items = list.map((x) => Object.assign({}, x, {
      aP: side(x.aMembers), bP: side(x.bMembers),
      aG: !x.tbdA && x.aMembers.join(' / ') === x.a, bG: !x.tbdB && x.bMembers.join(' / ') === x.b,
      aText: x.tbdA ? x.labelA || '待定' : x.a, bText: x.tbdB ? x.labelB || '待定' : x.b,
      mine: !!this.data.myId && ID.idsFor(x.aMembers.concat(x.bMembers), this.uidOf).indexOf(this.data.myId) >= 0,
      status: x.done ? 'done' : x.ready ? 'ready' : 'tbd',
    }));
    const done = items.filter((x) => x.done).length;
    const p = E.progressOf(d, this.data.matches);
    this.items = items;
    this.setData({
      schedule: this.data.onlyMine ? items.filter((x) => x.mine) : items,
      todo: items.filter((x) => x.mine && x.ready && !x.done).length,
      progress: p.champion ? `冠军：${p.champion}` : `已完成 ${done} / ${items.length} 场`,
    });
    this.focusFixture();
  },
  focusFixture() {
    const key = this.focusKey;
    if (!key) return;
    this.focusKey = '';
    if (!(this.items || []).some((x) => x.key === key)) return;
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

  setTab(e) { this.setData({ tab: e.currentTarget.dataset.v }); },
  toggleMine() { this.setData({ onlyMine: !this.data.onlyMine }); this.renderSchedule(); },

  // 点签表 / 积分榜 / 赛程里的某一场 → 录分页（已录的可以查看或修改）
  onOpen(e) { this.openMatch(e.detail.key, e.detail.ready); },
  tapItem(e) { const x = this.items.find((i) => i.key === e.currentTarget.dataset.key); if (x) this.openMatch(x.key, x.ready); },
  openMatch(key, ready) {
    if (!ready) { wx.showToast({ title: '对手还没确定，等上一轮打完', icon: 'none' }); return; }
    wx.navigateTo({ url: `/pages/score/score?drawId=${this.id}&key=${key}` });
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
      await db.removeDraw(this.id, reason);
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
