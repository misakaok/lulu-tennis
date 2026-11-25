// 活动录分：从签表 / 赛程点进来，双方和赛制都已确定，只填局分
// 场边记分：还没录分的场次可以点「场边记分」逐分记（pages/scorer，只在本机、用这一场的规则），完赛后回到这里预填局分，
//   仍由本人核对后点「提交比分」（recordEventMatch）；提交成功才清掉那份记分草稿
const E = require('../../utils/event');
const SC = require('../utils/scorer');
const RT = require('../../utils/rating');
const R = require('../../utils/rules');
const db = require('../../utils/db');
const cloud = require('../../utils/cloud');
const pick = require('../../utils/pick');
const ID = require('../../utils/ident');
const haptic = require('../../utils/haptic');

const pad = (n) => (n < 10 ? '0' + n : '' + n);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

Page({
  data: {
    loading: true, error: '',
    title: '', stage: '', slotText: '', formatText: '', ruleStage: '', ruleText: '', ruleCustom: false, typeText: '', setGames: 4, noAd: true, bestOf: 1,
    sideA: [], sideB: [], aLabel: '', bLabel: '',
    date: '', today: '',
    done: false, resultSets: [], winner: '',
    editing: false, init: [], canEdit: false, reason: '', withdrawReasons: E.REASONS.withdraw,
    check: { ok: false, msg: '' }, submitting: false,
    recordId: '', revocable: false,
    isOwner: false, outcomeText: '', unrated: null, retire: null, busy: false,
    scorerOk: false, scorerResume: false, fromScorer: false,
    // 未开打场次的赛前交手预览 & 「如果打成 X:Y」水平分模拟
    pre: null, simOpen: false, simSide: 'a', simSideLabel: '', simIdx: 2, simRes: null, simCanSwitch: false,
    rkOpen: false, rkBusy: false, rkList: [], rkId: '', rkMin: '60', rkDate: '', // 首次录分完成后顺手记球拍时长
  },

  onLoad(options) {
    this.drawId = options.drawId;
    this.key = options.key;
    this.pendingScorer = options.scorer || ''; // 记分页 redirectTo 过来：加载完再预填
    this.autoScorer = options.start === 'scorer'; // 从活动详情的「场边记分」进来：加载完直接打开记分器（只打开一次）
    const t = today();
    this.setData({ date: t, today: t });
    this.preview();
    this.load();
  },

  // 从活动详情点进来：先用活动详情刚读到的活动和报名（内存里 60 秒，db.peekDrawDetail）+ 本机战绩画出来（2026-11-24 用户嫌打开慢），
  // 云端读完后这一场没变化就不动（免得冲掉正在填的局分），变了再按最新的重画。提交时云端照样核对对阵版本
  preview() {
    const pre = db.peekDrawDetail(this.drawId);
    if (!pre || !pre.draw) return;
    const me = pre.profile || db.cachedProfile();
    const players = db.cachedPlayersFull ? db.cachedPlayersFull() : [];
    try { this.apply(pre.draw, db.cachedMatches(), me, pre.signups || [], db.cachedOpenid() || (me && me._openid) || '', false, players); }
    catch (e) { this.shownSig = ''; } // 本机数据找不到这一场：不显示错误，等云端
  },

  async load() {
    try {
      // 活动、报名名单、我的资料：云函数 drawDetail 一次取齐（原来分开读 3 次）；云函数还是旧版本时分开读
      const [bundle, matches, myId, players] = await Promise.all([
        db.fetchDrawDetail(this.drawId),
        db.matchesShared(), // 共享版（只读，不复制）：这页只拿来找这一场
        db.myOpenid().catch(() => ''),
        db.playersShared ? db.playersShared().catch(() => []) : Promise.resolve([]),
      ]);
      let d, me, signups;
      if (bundle) { d = bundle.draw; me = bundle.profile; signups = bundle.signups || []; }
      else {
        [d, me, signups] = await Promise.all([
          db.getDraw(this.drawId),
          db.getMyProfile().catch(() => db.cachedProfile()),
          db.fetchSignups(this.drawId).catch(() => []),
        ]);
      }
      this.apply(d, matches, me, signups, myId, true, players);
    } catch (e) {
      console.error(e);
      this.shownSig = '';
      this.setData({ loading: false, error: e.message || '加载失败，请稍后再试' });
    }
  },

  // fresh：云端结果。和已经画出来的（本机预览）一样就不重画
  apply(d, matches, me, signups, myId, fresh, players) {
    const owner = !!myId && d._openid === myId; // 活动文档已经读到了，不用再查一次
    const f = E.findFixture(d, matches, this.key);
    if (!f) throw new Error('找不到这场比赛，对阵表可能已经重新生成');
    if (!f.ready) throw new Error(f.void ? '这场比赛因退赛已取消（成绩不计）' : '对手还没确定，等上一轮打完再来录分');

    const person = (n) => ({ name: n, initial: R.initialOf(n), color: R.colorOf(n) });

    // 参赛者按用户 ID 判断（报名记录 / 签表快照），不看昵称；旧签表里没绑定 ID 的只能由发起人录
    const uidOf = ID.drawUids(d, signups);
    this.ids = { a: ID.idsFor(f.aMembers, uidOf), b: ID.idsFor(f.bMembers, uidOf) };
    const inMatch = !!myId && this.ids.a.concat(this.ids.b).indexOf(myId) >= 0;
    const endedUnplayed = !!d.endedAt && !f.done;
    this.inMatch = inMatch;
    if (!f.done && !endedUnplayed && inMatch) this.warmRackets();
    const myName = me && me.name;
    const canEdit = !endedUnplayed && (owner || inMatch || (!f.done && !E.isRotation(d) && require('../../utils/member').isAdminLocal()));
    const cfg = E.ruleFor(d, this.key); // 这一场所在阶段 / 轮次的规则（如决赛单独用 6 局制）
    const rec0 = f.done && f.recordId ? matches.find((m) => m._id === f.recordId) : null;
    const ps = players || [];
    const sig = JSON.stringify([d.drawVersion || 0, d.title, f, cfg, owner, inMatch, canEdit, !!(me && me.name), rec0 && [rec0.date, rec0._openid, rec0.recordedBy], (matches || []).length, ps.length]);
    if (fresh && sig === this.shownSig) return; // 本机预览画的就是最新的：不重画
    this.shownSig = sig;
    this.d = d; this.f = f; this.cfg = cfg;
    this.drawVersion = d.drawVersion || 0;
    this.res = { ok: false, msg: '' };
    let revocable = false;
    const scheduled = (f.slot && f.slot.date) || d.date;
    let date = scheduled && scheduled <= this.data.today ? scheduled : this.data.date;
    if (f.done && f.recordId) {
      const rec = rec0;
      if (rec && rec.date) date = rec.date;
      revocable = owner || (!!rec && !!myId && (rec._openid || rec.recordedBy) === myId); // 只是显示按钮，云函数会再校验
    }
    // 未开打场次：算赛前交手预览和水平分模拟底数（纯算力，复用共享战绩）
    let pre = null, simSide = 'a', simSideLabel = f.a, simIdx = 2, simRes = null, simCanSwitch = true;
    this.simCtx = null;
    if (!f.done) {
      const aKeys = f.aMembers.map((n, i) => this.ids.a[i] || ID.keyOf(ps, n));
      const bKeys = f.bMembers.map((n, i) => this.ids.b[i] || ID.keyOf(ps, n));
      const ratings = RT.ratingsOf(matches || [], ps);
      pre = RT.matchupPreview(ratings, ps, matches || [], { aKeys, bKeys, aNames: f.aMembers, bNames: f.bMembers, setGames: cfg.setGames });
      if (pre) {
        const myInA = !!myId && this.ids.a.indexOf(myId) >= 0;
        const myInB = !!myId && this.ids.b.indexOf(myId) >= 0;
        simSide = myInB ? 'b' : 'a';
        simCanSwitch = !(myInA || myInB);
        simSideLabel = myInA || myInB ? '你' : (simSide === 'a' ? f.a : f.b);
        this.simCtx = {
          ratings, players: ps, aKeys, bKeys, aNames: f.aMembers, bNames: f.bMembers,
          myKey: myInA || myInB ? myId : '', aLabel: f.a, bLabel: f.b, presets: pre.presets,
        };
        const def = pre.presets[simIdx] || pre.presets[0];
        if (def) {
          simRes = RT.simulateMatch(ratings, ps, {
            aKeys, bKeys, aNames: f.aMembers, bNames: f.bMembers,
            mySide: simSide, myKey: this.simCtx.myKey, gamesA: def.a, gamesB: def.b,
          });
        }
      }
    }
    wx.setNavigationBarTitle({ title: f.done ? '比赛结果' : '录入比分' });
    this.setData({
      loading: false, error: '', date,
      title: d.title, stage: f.stage, slotText: f.done ? '' : f.slotText || '', formatText: E.formatText(cfg),
      ruleStage: cfg.stage, ruleText: E.ruleText(cfg), ruleCustom: !!cfg.custom, typeText: cfg.type === 'double' ? '双打' : '单打',
      setGames: cfg.setGames, noAd: cfg.noAd, bestOf: cfg.bestOf,
      sideA: f.aMembers.map(person), sideB: f.bMembers.map(person),
      aLabel: f.a, bLabel: f.b,
      done: f.done, winner: f.winner, isOwner: !!owner && !endedUnplayed, outcomeText: f.outcomeText || '',
      unrated: f.done && f.outcome && f.outcome !== 'normal' ? RT.unratedOf(f.outcome) : null, // 弃权 / 退赛（含退赛后判的弃权）：本场未计入水平分
      resultSets: f.sets.map((s) => ({
        a: s.a, b: s.b, aw: s.a > s.b, bw: s.b > s.a,
        tbA: s.tbA === undefined ? '' : s.tbA, tbB: s.tbB === undefined ? '' : s.tbB,
      })),
      canEdit, recordId: f.done ? f.recordId || '' : '', revocable,
      reason: canEdit ? '' : (endedUnplayed ? '这个活动已提前结束，未打场次不再录分（如需继续可由发起人或管理员在活动详情恢复）' : (myName ? '只有这场的球员或活动发起人可以录分' : '设置昵称后，这场的球员才能录分')),
      editing: !f.done && canEdit,
      init: [],
      pre, simSide, simSideLabel, simIdx, simRes, simCanSwitch,
    });
    this.refreshScorer();
    if (this.autoScorer) { this.autoScorer = false; if (this.data.scorerOk && !this.pendingScorer) this.openScorer(); }
    if (this.pendingScorer) { const id = this.pendingScorer; this.pendingScorer = ''; this.applyScorer(id); }
  },

  /* ---------- 赛前水平分模拟 ---------- */
  toggleSim() { this.setData({ simOpen: !this.data.simOpen }); },
  pickSim(e) {
    const i = Number(e.currentTarget.dataset.i);
    if (!this.simCtx || !this.simCtx.presets[i]) return;
    this.runSim(i, this.data.simSide);
  },
  switchSimSide() {
    if (!this.simCtx || !this.data.simCanSwitch) return;
    this.runSim(this.data.simIdx, this.data.simSide === 'a' ? 'b' : 'a');
  },
  runSim(idx, side) {
    const c = this.simCtx;
    const p = c && c.presets[idx];
    if (!p) return;
    const res = RT.simulateMatch(c.ratings, c.players, {
      aKeys: c.aKeys, bKeys: c.bKeys, aNames: c.aNames, bNames: c.bNames,
      mySide: side, myKey: c.myKey, gamesA: p.a, gamesB: p.b,
    });
    const label = c.myKey ? '你' : (side === 'a' ? c.aLabel : c.bLabel);
    this.setData({ simIdx: idx, simSide: side, simSideLabel: label, simRes: res });
  },

  onShow() {
    // 从场边记分「带入这一场录分」退回来：取走标记预填（还没加载完就等加载完）
    const id = SC.takePending(this.drawId, this.key);
    if (id) { if (this.f) this.applyScorer(id); else this.pendingScorer = id; }
    else if (this.f) this.refreshScorer(); // 从记分页返回：按钮文字跟着草稿变（继续 / 开始）
  },

  /* ---------- 场边记分 ---------- */
  // 只给能录这一场的人，而且这一场还没有比分。
  refreshScorer() {
    const d = SC.loadDraft();
    const mine = SC.sameEv(d, this.drawId, this.key, this.drawVersion || 0) && SC.sameCfg(d.cfg, this.cfg);
    this.setData({ scorerOk: !!this.data.canEdit && !this.f.done, scorerResume: mine && !!d.points });
  },
  openScorer() {
    if (!this.data.scorerOk) return;
    const f = this.f;
    const ev = { drawId: this.drawId, key: this.key };
    if (this.drawVersion) ev.drawVersion = this.drawVersion;
    SC.setLabels(ev, { a: f.a, b: f.b, title: f.stage });
    const go = () => wx.navigateTo({ url: '/pkg-manage/scorer/scorer?go=1' });
    const d = SC.loadDraft();
    if (SC.sameEv(d, this.drawId, this.key, this.drawVersion || 0) && SC.sameCfg(d.cfg, this.cfg)) { go(); return; } // 这一场已经在记：接着记
    const fresh = () => { SC.saveDraft(SC.start(this.cfg, Date.now(), ev)); go(); };
    if (!d || !d.points) { fresh(); return; }
    wx.showModal({
      title: '开始这一场的场边记分？',
      content: '本机只保存一场记分，开始后会覆盖上一场' + (SC.resultOf(d) ? '（已完赛、还没带入录分）' : '（还没打完）') + '。',
      confirmText: '覆盖', confirmColor: '#b34d4d',
      success: (r) => { if (r.confirm) fresh(); },
    });
  },
  // 预填场边记分的结果：只认这一场、已完赛、规则和这一场一样的草稿；不自动提交
  applyScorer(id) {
    const d = SC.loadDraft();
    const r = d && d.id === id && SC.sameEv(d, this.drawId, this.key, this.drawVersion || 0) ? SC.resultOf(d) : null;
    if (!r) { wx.showToast({ title: '没找到这一场已完赛的场边记分', icon: 'none' }); return; }
    if (!SC.sameCfg(d.cfg, this.cfg)) {
      wx.showModal({ title: '规则不一样', content: `这一场的规则已改为「${E.ruleText(this.cfg)}」，和场边记分时不同，请按这一场的规则填写局分。`, showCancel: false });
      return;
    }
    if (!this.data.canEdit) { wx.showToast({ title: this.data.reason || '你不能录这一场', icon: 'none' }); return; }
    this.scorerId = id;
    this.setData({ editing: true, init: r.sets, fromScorer: true, scorerOk: false });
    wx.showToast({ title: '已填好局分，核对后提交', icon: 'none' });
  },

  onDate(e) { this.setData({ date: e.detail.value }); },

  startEdit() { this.setData({ editing: true, init: this.f.sets }); },
  cancelEdit() { this.setData({ editing: false }); },

  onSets(e) {
    this.res = e.detail;
    const r = this.res;
    let check;
    if (r.ok) {
      const wn = r.winner === 'a' ? this.f.a : this.f.b;
      check = { ok: true, msg: `${wn} 以 ${Math.max(r.won.a, r.won.b)}:${Math.min(r.won.a, r.won.b)} 获胜` };
    } else check = { ok: false, msg: r.msg };
    this.setData({ check });
  },

  async submit() {
    if (this.data.submitting) return;
    const r = this.res, f = this.f, d = this.d, cfg = this.cfg;
    if (!r || !r.ok) { wx.showToast({ title: this.data.check.msg || '请完善比分', icon: 'none' }); return; }
    if (!this.data.canEdit) { wx.showToast({ title: this.data.reason, icon: 'none' }); return; }
    this.setData({ submitting: true });
    try {
      // 活动比分只能经云函数写入：服务端按签表重新核对双方和本场规则，每一场只有一条记录（改比分是覆盖）
      const res = await this.withImpact('recordEventMatch', {
        drawId: this.drawId, key: this.key, drawVersion: this.drawVersion || 0, date: this.data.date, sets: r.sets,
      });
      if (!res) return;
      const draftBefore = this.scorerId ? SC.loadDraft() : null;
      if (this.scorerId) { SC.clearDraft(this.scorerId); this.scorerId = ''; } // 正式提交成功才清掉场边记分草稿
      haptic.medium();
      if (!f.done && this.inMatch && this.openRkPrompt(r.sets, this.data.date || today(), draftBefore)) return;
      wx.showToast({ title: f.done ? '比分已更新' : '比分已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 700);
    } catch (e) {
      console.error(e);
      wx.showModal({ title: '保存失败', content: e.message || '请稍后再试', showCancel: false });
    } finally {
      this.setData({ submitting: false });
    }
  },

  /* ---------- 本人首次录分完成后顺手记入球拍时长（有在役球拍时弹出，纯可选） ---------- */
  warmRackets() {
    try {
      const API = require('../../utils/rackets');
      const K = require('../../utils/racket');
      const c = API.cachedList && API.cachedList();
      if (c && Array.isArray(c.rackets)) { this.liveRks = K.liveRackets(c.rackets); return; }
      if (API.load) API.load().then((r) => { if (r && Array.isArray(r.rackets)) this.liveRks = K.liveRackets(r.rackets); }, () => {});
    } catch (e) {}
  },
  openRkPrompt(sets, date, draft) {
    let list = this.liveRks;
    if (!list) {
      try {
        const API = require('../../utils/rackets');
        const K = require('../../utils/racket');
        const c = API.cachedList && API.cachedList();
        if (c && Array.isArray(c.rackets)) list = K.liveRackets(c.rackets);
      } catch (e) {}
    }
    if (!list || !list.length) return false;
    const K = require('../../utils/racket');
    const el = draft && draft.startedAt && draft.endedAt ? Math.round((draft.endedAt - draft.startedAt) / 60000) : 0;
    const est = el >= 5 && el <= 600 ? el : K.estimateMatchMins(sets);
    this.setData({ rkOpen: true, rkBusy: false, rkList: list, rkId: list[0].id, rkMin: String(est), rkDate: date });
    return true;
  },
  pickRk(e) { this.setData({ rkId: e.currentTarget.dataset.id }); },
  rkMinQuick(e) { this.setData({ rkMin: e.currentTarget.dataset.m }); },
  rkMinInput(e) { this.setData({ rkMin: String(e.detail.value || '').replace(/\D/g, '').slice(0, 3) }); },
  skipRkLog() {
    if (this.data.rkBusy) return;
    this.setData({ rkOpen: false });
    wx.navigateBack();
  },
  async saveRkLog() {
    if (this.data.rkBusy) return;
    if (!this.data.rkId) { wx.showToast({ title: '请先选择球拍', icon: 'none' }); return; }
    if (!/^\d+$/.test(this.data.rkMin)) { wx.showToast({ title: '请填打球分钟数', icon: 'none' }); return; }
    const K = require('../../utils/racket');
    const API = require('../../utils/rackets');
    const d = this.data.rkDate || today();
    const chk = K.cleanLog({ kind: 'play', date: d, minutes: Number(this.data.rkMin) }, today());
    if (!chk.ok) { wx.showToast({ title: chk.msg, icon: 'none' }); return; }
    this.setData({ rkBusy: true });
    try {
      await API.saveLog('', this.data.rkId, chk.rec);
      this.setData({ rkOpen: false, rkBusy: false });
      haptic.medium();
      wx.showToast({ title: '已记入球拍时长', icon: 'success' });
      if (API.refreshBadge) API.refreshBadge();
      setTimeout(() => wx.navigateBack(), 600);
    } catch (err) {
      this.setData({ rkBusy: false });
      wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
    }
  },

  goBack() { wx.navigateBack(); },

  /* ---------- 影响后续比赛时：先列出影响，确认（并选原因）后再提交 ---------- */
  async withImpact(action, data) {
    let r = await cloud.call(action, data);
    if (r.needConfirm) {
      const list = r.impact.map((x) => `${x.stage}：${x.a} vs ${x.b} ${x.score}`).join('\n');
      const ok = await new Promise((res) => wx.showModal({ title: '会影响后续比赛', content: `下面已录分的比赛对阵会变化，比分将作废并留档：\n${list}`, confirmText: '继续', confirmColor: '#e5484d', success: (x) => res(x.confirm) }));
      if (!ok) return null;
      const reason = data.reason || (await pick.reason('fix', '处理原因（会留档）'));
      if (!reason) return null;
      r = await cloud.call(action, Object.assign({}, data, { confirmImpact: true, reason }));
    }
    return r;
  },

  /* ---------- 发起人：赛前弃权 / 中途退赛（不伪造局分，必须选原因） ---------- */
  pickSide(title) {
    return new Promise((resolve) => wx.showActionSheet({ itemList: [`${this.data.aLabel}`, `${this.data.bLabel}`], success: (r) => resolve(r.tapIndex === 0 ? 'a' : 'b'), fail: () => resolve(null) }));
  },
  async walkover() {
    if (this.data.busy) return;
    const side = await this.pickSide('谁弃权？');
    if (!side) return;
    const reason = await pick.reason('withdraw', '弃权原因');
    if (!reason) return;
    this.setData({ busy: true });
    try {
      const r = await this.withImpact('resolveFixture', { drawId: this.drawId, key: this.key, kind: 'walkover', loser: side, reason });
      if (r) { wx.showToast({ title: '已判弃权', icon: 'success' }); setTimeout(() => wx.navigateBack(), 700); }
    } catch (e) { wx.showModal({ title: '处理失败', content: e.message, showCancel: false }); }
    finally { this.setData({ busy: false }); }
  },
  async retireStart() {
    const side = await this.pickSide('谁中途退赛？');
    if (!side) return;
    this.setData({ retire: { side, name: side === 'a' ? this.data.aLabel : this.data.bLabel, sets: [{ a: '', b: '' }], reason: '' } });
  },
  retireInput(e) {
    const { i, k } = e.currentTarget.dataset;
    this.setData({ [`retire.sets[${i}].${k}`]: e.detail.value });
  },
  retireAddSet() { if (this.data.retire.sets.length < 3) this.setData({ 'retire.sets': this.data.retire.sets.concat([{ a: '', b: '' }]) }); },
  retireReason(e) { this.setData({ 'retire.reason': e.currentTarget.dataset.v }); },
  retireCancel() { this.setData({ retire: null }); },
  async retireSubmit() {
    if (this.data.busy) return;
    const rt = this.data.retire;
    const sets = rt.sets.filter((s) => s.a !== '' || s.b !== '').map((s) => ({ a: parseInt(s.a, 10) || 0, b: parseInt(s.b, 10) || 0 }));
    if (!sets.length) { wx.showToast({ title: '请填写实际已打的局分', icon: 'none' }); return; }
    if (!E.reasonOf(rt.reason)) { wx.showToast({ title: '请选择退赛原因', icon: 'none' }); return; }
    this.setData({ busy: true });
    try {
      const r = await this.withImpact('resolveFixture', { drawId: this.drawId, key: this.key, kind: 'retired', loser: rt.side, reason: rt.reason, sets, date: this.data.date });
      if (r) { wx.showToast({ title: '已记录退赛', icon: 'success' }); setTimeout(() => wx.navigateBack(), 700); }
    } catch (e) { wx.showModal({ title: '处理失败', content: e.message, showCancel: false }); }
    finally { this.setData({ busy: false }); }
  },
  onRevoked() { setTimeout(() => wx.navigateBack(), 600); }, // 回到活动页，签表 / 积分榜重新计算
});
