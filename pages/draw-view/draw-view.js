// 赛事详情：报名 → 签表 / 积分榜 → 赛程 → 点比赛录分
const E = require('../../utils/event');
const R = require('../../utils/rating');
const db = require('../../utils/db');
const ID = require('../../utils/ident');
const cloud = require('../../utils/cloud');
const S = require('../../utils/stats');
const { colorOf, initialOf } = require('../../utils/rules');

const NO_PARTNER = '暂时没有搭档（由发起人配对）';

function modeText(d) {
  if (d.mode === 'groups') return `小组赛 · ${d.groupCount} 组`;
  if (d.mode === 'groups_ko') return `小组赛＋淘汰赛 · ${d.groupCount} 组 · 每组前 ${d.advance === 1 ? 1 : 2} 名出线`;
  return `淘汰赛 · ${d.size} 签`;
}

Page({
  data: {
    draw: null, meta: '', formatText: '', seedsText: '', error: '', myName: '', myId: '',
    signing: false, isDouble: false, signups: [], signCount: '', joined: false, isOwner: false, full: false, busy: false,
    partnerOpts: [], info: null, contact: null, contactErr: '', photoCount: -1,
    matches: [], tab: 'board', schedule: [], onlyMine: false, progress: '', todo: 0,
  },

  onLoad(options) { this.id = options.id; },
  onShow() { this.load(); }, // 从录分页 / 资料页 / 抽签页回来时刷新
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    this.load().then(() => wx.stopPullDownRefresh()); },

  async load() {
    try {
      const [d, all, me, myId, signups] = await Promise.all([
        db.getDraw(this.id),
        db.fetchMatches().catch(() => db.cachedMatches()),
        db.getMyProfile().catch(() => db.cachedProfile()),
        db.myOpenid().catch(() => ''),
        db.fetchSignups(this.id).catch(() => []),
      ]);
      this.uidOf = ID.drawUids(d, signups); // 「我的比赛」按用户 ID 判断
      // 签表照片按账号取最新的（换照片后签表也跟着变；名字仍是生成签表时的参赛名）
      const byUid = {};
      db.cachedPlayersFull().forEach((p) => { if (p.uid) byUid[p.uid] = p; });
      const av = Object.assign({}, d.avatars || {});
      Object.keys(this.uidOf).forEach((n) => { const p = byUid[this.uidOf[n]]; if (p && p.avatar) av[n] = p.avatar; });
      d.avatars = av;
      d._id = d._id || this.id;
      this.d = d;
      this.allMatches = all;
      wx.setNavigationBarTitle({ title: d.title || '赛事' });
      const signing = d.status === 'signup';
      const cfg = E.cfgOf(d);
      const n = (d.entrants || []).length;
      const unit = cfg.type === 'double' ? '队' : '人';
      const meta = modeText(d) + (signing ? ' · 报名中' : ` · ${n} ${unit}`);
      const seedsText = (d.seeds || []).map((s, i) => `${i + 1}. ${s}`).join('   ');
      const matches = all.filter((m) => m.drawId === this.id);
      this.setData({
        draw: d, meta, seedsText, error: '', signing, myName: (me && me.name) || '', myId,
        formatText: cfg.type === 'double' ? '双打' : '单打', rulesSum: E.rulesSummary(d), isDouble: cfg.type === 'double', matches,
      });
      // 编辑信息、删除：发起人或管理员（管理员只决定显示按钮，权限由云函数判断）；其他赛事操作只有发起人
      const isAdmin = require('../../utils/member').isAdminLocal();
      this.setData({ canManage: isAdmin || !!this.data.isOwner });
      db.isMine('draws', this.id).then((isOwner) => this.setData({ isOwner, canManage: isOwner || isAdmin })).catch(() => {});
      this.setData({ info: this.infoOf(d) });
      this.loadContact();
      this.loadPhotoCount();
      if (signing) await this.loadSignups(d, all);
      else { this.renderSchedule(); this.loadRequests(); }
    } catch (e) {
      console.error(e);
      this.setData({ error: '赛事加载失败，可能已被删除' });
    }
  },

  /* ---------- 时间地点 / 联系人 ---------- */
  infoOf(d) {
    const WEEK = '日一二三四五六';
    let when = d.date || '';
    if (d.date) { const [y, m, dd] = d.date.split('-').map(Number); when = `${m}月${dd}日 周${WEEK[new Date(y, m - 1, dd).getDay()]}`; }
    if (d.startTime) when += ' ' + d.startTime;
    const loc = d.location && typeof d.location.latitude === 'number' ? d.location : null;
    if (!d.venue && !d.address && !loc && !d.startTime) return { when, empty: true };
    return { when, venue: d.venue || (loc && loc.name) || '', address: d.address || (loc && loc.address) || '', canNav: !!loc };
  },

  // 联系人由云函数按可见范围返回（没报名的人看不到电话和微信）
  async loadContact() {
    try {
      const c = await cloud.call('getContact', { drawId: this.id });
      this.setData({ contact: c.has ? c : null, contactErr: '' });
    } catch (e) { this.setData({ contact: null, contactErr: e.message }); }
  },

  /* ---------- 退赛（签表生成后）：球员申请，发起人处理；发起人也可以直接登记 ---------- */
  async loadRequests() {
    try {
      const r = await cloud.call('drawRequests', { drawId: this.id });
      const wd = E.withdrawalsOf(this.d);
      const POL = { walkover: '未赛场次判对手弃权胜', void: '取消全部小组成绩' };
      this.setData({
        wdPending: r.list.filter((x) => x.type === 'withdraw' && x.status === 'pending'),
        myWd: r.list.find((x) => x.type === 'withdraw' && !r.owner) || null,
        canWithdraw: !r.owner || r.myEntrants.length ? r.myEntrants.some((e) => !wd[e]) : false,
        withdrawn: (r.withdrawals || []).map((w) => ({ entrant: w.entrant, reason: w.reason, text: w.stage === 'group' ? POL[w.policy] || '' : '淘汰赛退赛，下一场对手弃权胜' })),
        wdOwner: r.owner,
        wdCandidates: (this.d.entrants || []).filter((e) => !wd[e]),
      });
    } catch (e) { console.warn(e.message); }
  },
  ask(title, placeholder) {
    return new Promise((resolve) => wx.showModal({ title, editable: true, placeholderText: placeholder, success: (r) => resolve(r.confirm ? (r.content || '').trim() : null), fail: () => resolve(null) }));
  },
  async requestWithdraw() {
    const reason = await this.ask('申请退赛', '退赛原因（必填），发起人会看到');
    if (reason === null) return;
    if (reason.length < 2) { wx.showToast({ title: '请填写原因', icon: 'none' }); return; }
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
    const reason = await this.ask(`${base.entrant || '该球员'} 退赛`, '处理原因（必填），会留档');
    if (reason === null) return;
    if (reason.length < 2) { wx.showToast({ title: '请填写原因', icon: 'none' }); return; }
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
    const reason = await this.ask('拒绝退赛申请', '原因（必填）');
    if (!reason) return;
    try { await cloud.call('handleWithdraw', { drawId: this.id, requestId: x.id, approve: false, reason }); wx.showToast({ title: '已拒绝', icon: 'none' }); this.loadRequests(); }
    catch (err) { wx.showModal({ title: '处理失败', content: err.message, showCancel: false }); }
  },
  ownerWithdraw(e) { const entrant = this.data.wdCandidates[Number(e.detail.value)]; if (entrant) this.doWithdraw({ entrant }); },

  // 赛事相册：只数审核通过的照片（云函数统计）
  loadPhotoCount() {
    cloud.call('eventPhotoCount', { drawId: this.id }).then((r) => this.setData({ photoCount: r.count })).catch(() => this.setData({ photoCount: -1 }));
  },
  openAlbum() {
    const t = this.data.draw ? this.data.draw.title : '';
    wx.navigateTo({ url: `/pages/album/album?id=${this.id}&title=${encodeURIComponent(t)}` });
  },

  openMap() {
    const d = this.d, loc = d.location;
    if (loc && typeof loc.latitude === 'number') {
      wx.openLocation({ latitude: loc.latitude, longitude: loc.longitude, name: d.venue || loc.name || '', address: d.address || loc.address || '', scale: 16 });
    } else if (d.address) {
      wx.setClipboardData({ data: d.address });
    }
  },
  copyAddress() { if (this.d.address) wx.setClipboardData({ data: (this.d.venue ? this.d.venue + ' ' : '') + this.d.address }); },
  callPhone() { const c = this.data.contact; if (c && c.phone) wx.makePhoneCall({ phoneNumber: c.phone }); },
  copyWechat() { const c = this.data.contact; if (c && c.wechat) wx.setClipboardData({ data: c.wechat }); },
  // 点报名名单里的头像 / 昵称 → 球员主页（按用户 ID 打开，和「我的」同一套页面）
  openPlayer(e) {
    const uid = e.currentTarget.dataset.uid;
    if (!uid) { wx.showToast({ title: '这位球员没有绑定账号', icon: 'none' }); return; }
    if (uid === this.data.myId) { wx.switchTab({ url: '/pages/me/me' }); return; }
    wx.navigateTo({ url: '/pages/player/player?uid=' + encodeURIComponent(uid) });
  },
  goEdit() { wx.navigateTo({ url: '/pages/event-edit/event-edit?id=' + this.id }); },

  /* ---------- 报名 ---------- */
  async loadSignups(d, matches) {
    const [list, mine, players] = await Promise.all([
      db.fetchSignups(this.id), db.mySignup(this.id),
      db.fetchPlayersFull().catch(() => db.cachedPlayersFull()),
    ]);
    // 排名、场数、胜率、等级都从有效比赛记录实时算；性别读个人资料。没有数据显示「暂无」
    const stats = S.playerStats(matches || db.cachedMatches(), players);
    const profOf = {};
    players.forEach((p) => { profOf[p.name] = p; });
    // 报名名单按账号显示「当前」昵称和照片：改名、换照片后报名照样有效，显示也跟着更新
    const byUid = {};
    players.forEach((p) => { if (p.uid) byUid[p.uid] = p; });
    const person = (snapName, snapAvatar, uid) => {
      const cur = uid && byUid[uid];
      const name = cur ? cur.name : snapName;
      return Object.assign({
        name, uid: uid || '', avatar: (cur && cur.avatar) || snapAvatar || (profOf[name] && profOf[name].avatar) || '', initial: initialOf(name), color: colorOf(name),
      }, S.display(stats, name, cur || profOf[name], uid));
    };
    const signups = list.map((s, i) => {
      const members = [person(s.name, s.avatar, s._openid)];
      if (s.partner) members.push(person(s.partner, s.partnerAvatar, s.partnerId));
      return Object.assign({ _id: s._id, no: i + 1, solo: !s.partner, members }, members[0]);
    });
    // 按用户 ID 判断谁已经报名（自己报的 _openid，或被搭档带上的 partnerId）
    const takenId = {};
    let people = 0;
    list.forEach((s) => { people += s.partner ? 2 : 1; if (s._openid) takenId[s._openid] = 1; if (s.partnerId) takenId[s.partnerId] = 1; });
    const myId = this.data.myId;
    const isDouble = this.data.isDouble;
    const cap = d.mode === 'bracket' ? d.size * (isDouble ? 2 : 1) : 999;
    // 搭档只能选已设置资料的球员（有用户 ID），同名资料不能被选
    this.partnerPool = players.filter((p) => p.uid && p.uid !== myId && !takenId[p.uid]);
    const partnerOpts = [NO_PARTNER].concat(this.partnerPool.map((p) => p.name));
    this.setData({
      signups, partnerOpts,
      joined: !!mine || (!!myId && !!takenId[myId]),
      full: people >= cap,
      signCount: isDouble ? `${people} 人` + (d.mode === 'bracket' ? ` / 最多 ${d.size} 队` : '') : `${people}` + (d.mode === 'bracket' ? ` / ${d.size}` : '') + ' 人',
    });
  },

  // 双打：先在弹出的列表里选搭档
  joinDouble(e) {
    const i = Number(e.detail.value);
    this.join(i > 0 ? this.partnerPool[i - 1] : null);
  },

  async join(partnerPick) {
    if (this.data.busy) return;
    require('../../utils/notify').ask(); // 顺便请求通知权限（必须在点击时同步调用）
    const pick = partnerPick && partnerPick.uid ? partnerPick : null;
    let me = db.cachedProfile();
    try { me = await db.getMyProfile(); } catch (e) {}
    if (!me) {
      wx.showModal({
        title: '先设置头像和昵称', content: '报名名单里会显示你的头像和昵称', confirmText: '去设置',
        success: (r) => { if (r.confirm) wx.navigateTo({ url: '/pages/profile/profile?from=signup' }); },
      });
      return;
    }
    if (this.data.full) { wx.showToast({ title: '名额已满', icon: 'none' }); return; }
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
        partner = { name: pick.name, uid: pick.uid, avatar: pick.avatar || '' };
      }
      await db.signUp(this.id, partner);
      wx.showToast({ title: '报名成功', icon: 'success' });
      this.loadContact();
      this.loadPhotoCount(); // 报名后可以看到联系方式
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
    if (this.data.signups.length < 2) { wx.showToast({ title: '报名的还不够', icon: 'none' }); return; }
    wx.navigateTo({ url: '/pages/draw-new/draw-new?id=' + this.id });
  },

  /* ---------- 签表 / 赛程 ---------- */
  renderSchedule() {
    const d = this.d, me = this.data.myName;
    const av = d.avatars || {};
    const list = E.scheduleOf(d, this.data.matches);
    const side = (members) => members.map((n) => ({ name: n, avatar: av[n] || '', initial: initialOf(n), color: colorOf(n) }));
    const items = list.map((x) => Object.assign({}, x, {
      aP: side(x.aMembers), bP: side(x.bMembers),
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
      progress: p.champion ? `🏆 冠军：${p.champion}` : `已完成 ${done} / ${items.length} 场`,
    });
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
      title: '删除这个赛事？',
      content: '删除后所有人都看不到签表了，赛事相册的照片和联系人信息会一起删除，未处理的申请会作废（已录的比分仍保留在战绩里）',
      confirmColor: '#e5484d',
      success: async (r) => {
        if (!r.confirm) return;
        try {
          await db.removeDraw(this.id);
          wx.showToast({ title: '已删除' });
          setTimeout(() => wx.navigateBack(), 600);
        } catch (e) { wx.showModal({ title: '删除失败', content: e.message || '请稍后再试', showCancel: false }); }
      },
    });
  },

  // 管理员删除别人发起的赛事：必须填原因（留档，并通知发起人）
  async adminRemove() {
    const reason = await this.ask('删除这个赛事（管理员）', '删除原因（必填，会通知发起人）。相册照片和联系人一起删除，已录比分保留');
    if (reason === null) return;
    if (reason.length < 2) { wx.showToast({ title: '请填写原因（至少 2 个字）', icon: 'none' }); return; }
    try {
      await db.removeDraw(this.id, reason);
      wx.showToast({ title: '已删除' });
      setTimeout(() => wx.navigateBack(), 600);
    } catch (e) { wx.showModal({ title: '删除失败', content: e.message || '请稍后再试', showCancel: false }); }
  },

  goHome() { wx.switchTab({ url: '/pages/draw/draw' }); },

  onShareAppMessage() {
    const d = this.data.draw;
    const t = d ? d.title : '网球';
    return {
      title: this.data.signing ? `${t} 开始报名啦，点击报名` : `${t} · 签表和赛程`,
      path: `/pages/draw-view/draw-view?id=${this.id}`,
    };
  },
});
