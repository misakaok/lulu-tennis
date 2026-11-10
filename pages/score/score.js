// 活动录分：从签表 / 赛程点进来，双方和赛制都已确定，只填局分
const E = require('../../utils/event');
const R = require('../../utils/rules');
const db = require('../../utils/db');
const cloud = require('../../utils/cloud');
const ID = require('../../utils/ident');

const pad = (n) => (n < 10 ? '0' + n : '' + n);
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

Page({
  data: {
    loading: true, error: '',
    title: '', stage: '', slotText: '', formatText: '', ruleStage: '', ruleText: '', ruleCustom: false, typeText: '', setGames: 4, noAd: true, bestOf: 1,
    sideA: [], sideB: [], aLabel: '', bLabel: '',
    date: '', today: '',
    done: false, resultSets: [], winner: '',
    editing: false, init: [], canEdit: false, reason: '',
    check: { ok: false, msg: '' }, submitting: false,
    recordId: '', revocable: false,
    isOwner: false, outcomeText: '', retire: null, busy: false,
  },

  onLoad(options) {
    this.drawId = options.drawId;
    this.key = options.key;
    const t = today();
    this.setData({ date: t, today: t });
    this.load();
  },

  async load() {
    try {
      const [d, matches, me, players, signups, myId] = await Promise.all([
        db.getDraw(this.drawId),
        db.fetchMatches(),
        db.getMyProfile().catch(() => db.cachedProfile()),
        db.fetchPlayersFull().catch(() => db.cachedPlayersFull()),
        db.fetchSignups(this.drawId).catch(() => []),
        db.myOpenid().catch(() => ''),
      ]);
      const owner = !!myId && d._openid === myId; // 活动文档已经读到了，不用再查一次
      const f = E.findFixture(d, matches, this.key);
      if (!f) throw new Error('找不到这场比赛，签表可能已经重新抽过');
      if (!f.ready) throw new Error(f.void ? '这场比赛因退赛已取消（成绩不计）' : '对手还没确定，等上一轮打完再来录分');

      const avatars = Object.assign({}, d.avatars || {});
      players.forEach((p) => { if (p.avatar && !avatars[p.name]) avatars[p.name] = p.avatar; });
      const byUid = {};
      players.forEach((p) => { if (p.uid) byUid[p.uid] = p; });
      const uidMap = ID.drawUids(d, signups);
      const person = (n) => {
        const cur = byUid[uidMap[n]]; // 按账号取最新照片
        return { name: n, avatar: (cur && cur.avatar) || avatars[n] || '', initial: R.initialOf(n), color: R.colorOf(n) };
      };

      // 参赛者按用户 ID 判断（报名记录 / 签表快照），不看昵称；旧签表里没绑定 ID 的只能由发起人录
      const uidOf = ID.drawUids(d, signups);
      this.ids = { a: ID.idsFor(f.aMembers, uidOf), b: ID.idsFor(f.bMembers, uidOf) };
      const inMatch = !!myId && this.ids.a.concat(this.ids.b).indexOf(myId) >= 0;
      const myName = me && me.name;
      const canEdit = owner || inMatch;
      const cfg = E.ruleFor(d, this.key); // 这一场所在阶段 / 轮次的规则（如决赛单独用 6 局制）
      this.d = d; this.f = f; this.cfg = cfg;
      this.res = { ok: false, msg: '' };
      let revocable = false;
      if (f.done && f.recordId) {
        const rec = matches.find((m) => m._id === f.recordId);
        if (rec && rec.date) this.setData({ date: rec.date });
        revocable = owner || (!!rec && !!myId && (rec._openid || rec.recordedBy) === myId); // 只是显示按钮，云函数会再校验
      }
      wx.setNavigationBarTitle({ title: f.done ? '比赛结果' : '录入比分' });
      this.setData({
        loading: false, error: '',
        title: d.title, stage: f.stage, slotText: f.done ? '' : f.slotText || '', formatText: E.formatText(cfg),
        ruleStage: cfg.stage, ruleText: E.ruleText(cfg), ruleCustom: !!cfg.custom, typeText: cfg.type === 'double' ? '双打' : '单打',
        setGames: cfg.setGames, noAd: cfg.noAd, bestOf: cfg.bestOf,
        sideA: f.aMembers.map(person), sideB: f.bMembers.map(person),
        aLabel: f.a, bLabel: f.b,
        done: f.done, winner: f.winner, isOwner: !!owner, outcomeText: f.outcomeText || '',
        resultSets: f.sets.map((s) => ({
          a: s.a, b: s.b, aw: s.a > s.b, bw: s.b > s.a,
          tbA: s.tbA === undefined ? '' : s.tbA, tbB: s.tbB === undefined ? '' : s.tbB,
        })),
        canEdit, recordId: f.done ? f.recordId || '' : '', revocable,
        reason: canEdit ? '' : (myName ? '只有这场的参赛球员或活动发起人可以录分' : '设置头像和昵称后，参赛球员才能录分'),
        editing: !f.done && canEdit,
        init: [],
      });
    } catch (e) {
      console.error(e);
      this.setData({ loading: false, error: e.message || '加载失败，请稍后再试' });
    }
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
      check = { ok: true, msg: `🏆 ${wn} 以 ${Math.max(r.won.a, r.won.b)}:${Math.min(r.won.a, r.won.b)} 获胜` };
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
      const res = await this.withImpact('recordEventMatch', { drawId: this.drawId, key: this.key, date: this.data.date, sets: r.sets });
      if (!res) return;
      wx.showToast({ title: f.done ? '比分已更新' : '比分已保存', icon: 'success' });
      setTimeout(() => wx.navigateBack(), 700);
    } catch (e) {
      console.error(e);
      wx.showModal({ title: '保存失败', content: e.message || '请稍后再试', showCancel: false });
    } finally {
      this.setData({ submitting: false });
    }
  },

  goBack() { wx.navigateBack(); },

  /* ---------- 影响后续比赛时：先列出影响，确认（并填原因）后再提交 ---------- */
  ask(title, placeholder) {
    return new Promise((resolve) => wx.showModal({ title, editable: true, placeholderText: placeholder, success: (r) => resolve(r.confirm ? (r.content || '').trim() : null), fail: () => resolve(null) }));
  },
  async withImpact(action, data) {
    let r = await cloud.call(action, data);
    if (r.needConfirm) {
      const list = r.impact.map((x) => `${x.stage}：${x.a} vs ${x.b} ${x.score}`).join('\n');
      const ok = await new Promise((res) => wx.showModal({ title: '会影响后续比赛', content: `下面已录分的比赛对阵会变化，比分将作废并留档：\n${list}`, confirmText: '继续', confirmColor: '#e5484d', success: (x) => res(x.confirm) }));
      if (!ok) return null;
      const reason = data.reason || (await this.ask('处理原因', '必填，会留档'));
      if (!reason) return null;
      r = await cloud.call(action, Object.assign({}, data, { confirmImpact: true, reason }));
    }
    return r;
  },

  /* ---------- 发起人：赛前弃权 / 中途退赛（不伪造局分，必须填原因） ---------- */
  pickSide(title) {
    return new Promise((resolve) => wx.showActionSheet({ itemList: [`${this.data.aLabel}`, `${this.data.bLabel}`], success: (r) => resolve(r.tapIndex === 0 ? 'a' : 'b'), fail: () => resolve(null) }));
  },
  async walkover() {
    if (this.data.busy) return;
    const side = await this.pickSide('谁弃权？');
    if (!side) return;
    const reason = await this.ask(`${side === 'a' ? this.data.aLabel : this.data.bLabel} 赛前弃权`, '弃权原因（必填）');
    if (reason === null) return;
    if (reason.length < 2) { wx.showToast({ title: '请填写原因', icon: 'none' }); return; }
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
  retireReason(e) { this.setData({ 'retire.reason': e.detail.value }); },
  retireCancel() { this.setData({ retire: null }); },
  async retireSubmit() {
    if (this.data.busy) return;
    const rt = this.data.retire;
    const sets = rt.sets.filter((s) => s.a !== '' || s.b !== '').map((s) => ({ a: parseInt(s.a, 10) || 0, b: parseInt(s.b, 10) || 0 }));
    if (!sets.length) { wx.showToast({ title: '请填写实际已打的局分', icon: 'none' }); return; }
    if ((rt.reason || '').trim().length < 2) { wx.showToast({ title: '请填写退赛原因', icon: 'none' }); return; }
    this.setData({ busy: true });
    try {
      const r = await this.withImpact('resolveFixture', { drawId: this.drawId, key: this.key, kind: 'retired', loser: rt.side, reason: rt.reason.trim(), sets, date: this.data.date });
      if (r) { wx.showToast({ title: '已记录退赛', icon: 'success' }); setTimeout(() => wx.navigateBack(), 700); }
    } catch (e) { wx.showModal({ title: '处理失败', content: e.message, showCancel: false }); }
    finally { this.setData({ busy: false }); }
  },
  onRevoked() { setTimeout(() => wx.navigateBack(), 600); }, // 回到活动页，签表 / 积分榜重新计算
});
