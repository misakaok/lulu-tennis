// 修改比分：
//   mode=edit    日常比赛：录入人或参赛者直接改，改完立即生效
//   mode=request 比分已锁定（双方确认过 / 管理员更正过）：参赛者提交「申请修改比分」（新比分 + 原因），对方同意后才生效；活动可由发起人裁定
//   mode=admin   管理员更正比分（日常比赛、活动比赛都可以，不用填原因，留档）：直接生效；活动比赛影响后续场次时先确认
// 赛制自动沿用这一场（活动按阶段 / 轮次规则），处理前正式战绩、排名、晋级都不变。
const db = require('../../utils/db');
const cloud = require('../../utils/cloud');
const E = require('../../utils/event');
const ID = require('../../utils/ident');

Page({
  data: { loading: true, error: '', mode: 'request', aLabel: '', bLabel: '', current: '', ruleText: '', setGames: 4, noAd: true, bestOf: 1, init: [], reason: '', reasons: E.REASONS.score, check: { ok: false, msg: '' }, submitting: false },

  onLoad(o) {
    this.id = o.matchId;
    const mode = o.mode === 'edit' || o.mode === 'admin' ? o.mode : 'request';
    this.setData({ mode });
    wx.setNavigationBarTitle({ title: mode === 'edit' ? '修改比分' : mode === 'admin' ? '更正比分' : '申请修改比分' });
    this.preview();
    this.load();
  },

  // 先用本机战绩里的这一场（+ 本机活动列表 / 活动详情刚读到的规则）画出表单（2026-11-25 用户嫌打开先空白），
  // 云端读完内容一样就不重画（不冲掉正在改的局分），变了才按最新的重画；提交照样由云端核对
  preview() {
    try {
      const m = ((db.cachedMatchesAll && db.cachedMatchesAll()) || []).find((x) => x && x._id === this.id);
      if (!m) return;
      const players = (db.cachedPlayersFull && db.cachedPlayersFull()) || [];
      let draw = null;
      if (m.drawId && m.drawKey) {
        const pre = db.peekDrawDetail && db.peekDrawDetail(m.drawId);
        draw = (pre && pre.draw) || ((db.cachedDraws && db.cachedDraws()) || []).find((d) => d && d._id === m.drawId) || null;
      }
      this.show(ID.normalizeMatches([m], players)[0], draw);
    } catch (e) { console.warn('[改分] 本机缓存画不出来，等云端', e); }
  },

  async load() {
    try {
      const [raw, players] = await Promise.all([db.getMatch(this.id), (db.playersShared || db.fetchPlayersFull)().catch(() => db.cachedPlayersFull())]);
      if (!raw) throw new Error('比赛记录不存在');
      const m = ID.normalizeMatches([raw], players)[0]; // normalizeMatches 不改动传入的（共享）球员数组
      // 活动已删除（软删除，网关读不到）时沿用比赛记录自带的规则，和云端 ruleOfMatch 找不到活动时一样；
      // 60 秒内在活动详情读过这个活动就直接用（任何写操作都会作废那份结果）
      let draw = null;
      if (m.drawId && m.drawKey) {
        const pre = db.peekDrawDetail && db.peekDrawDetail(m.drawId);
        draw = pre && pre.draw ? pre.draw : await db.getDraw(m.drawId).catch(() => null);
      }
      this.show(m, draw);
    } catch (e) { this.setData({ loading: false, error: e.message }); }
  },
  // 画表单；内容签名（比分 + 规则 + 双方名字）和已经画出来的一样就不重画
  show(m, draw) {
    let rule = { setGames: m.setGames === 6 ? 6 : 4, noAd: m.noAd !== false, bestOf: m.bestOf === 3 ? 3 : 1 };
    if (draw) { const d = Object.assign({}, draw, { _id: m.drawId }); rule = E.ruleFor(d, m.drawKey); }
    this.m = m;
    const view = { aLabel: m.a.join(' / '), bLabel: m.b.join(' / '), current: E.scoreText(m.sets), rule: [rule.setGames, rule.noAd, rule.bestOf], sets: m.sets || [] };
    const sig = JSON.stringify(view);
    if (sig === this.shownSig) { if (this.data.loading || this.data.error) this.setData({ loading: false, error: '' }); return; }
    this.shownSig = sig;
    this.setData({
      loading: false, error: '', aLabel: view.aLabel, bLabel: view.bLabel, current: view.current,
      ruleText: E.ruleText(rule), setGames: rule.setGames, noAd: rule.noAd, bestOf: rule.bestOf, init: m.sets || [],
    });
  },
  onSets(e) {
    this.res = e.detail;
    const r = e.detail;
    this.setData({ check: r.ok ? { ok: true, msg: `改为：${(r.winner === 'a' ? this.data.aLabel : this.data.bLabel)} 以 ${Math.max(r.won.a, r.won.b)}:${Math.min(r.won.a, r.won.b)} 获胜` } : { ok: false, msg: r.msg } });
  },
  onReason(e) { this.setData({ reason: e.currentTarget.dataset.v }); }, // 原因只从固定选项里选

  async submit() {
    if (this.data.submitting) return; // 防重复提交（云函数里也有同一场只能有一条待处理申请的校验）
    if (!this.res || !this.res.ok) { wx.showToast({ title: this.data.check.msg || '请填写正确比分', icon: 'none' }); return; }
    const reason = E.reasonOf(this.data.reason);
    const mode = this.data.mode;
    if (mode === 'request' && !reason) { wx.showToast({ title: '请选择修改原因', icon: 'none' }); return; }
    this.setData({ submitting: true });
    try {
      if (mode === 'edit') await cloud.call('editMatchScore', { matchId: this.id, sets: this.res.sets });
      else if (mode === 'admin') {
        const data = { matchId: this.id, sets: this.res.sets };
        const r = await cloud.call('adminFixScore', data);
        if (r.needConfirm) {
          // 活动比赛：会改变后续已录分的场次，列出影响，确认后才执行（受影响的比分作废并留档）
          const list = (r.impact || []).map((x) => `${x.stage}：${x.a} vs ${x.b} ${x.score}`).join('\n');
          const go = await new Promise((done) => wx.showModal({ title: '会影响后续比赛', content: `更正后，下面已录分的比赛对阵会变化，比分将作废：\n${list}`, confirmText: '确认更正', confirmColor: '#e5484d', success: (x) => done(x.confirm), fail: () => done(false) }));
          if (!go) return;
          const r2 = await cloud.call('adminFixScore', Object.assign(data, { confirmImpact: true }));
          if (r2.needConfirm) throw new Error('比分刚刚有变动，请重试');
        }
      }
      else await cloud.call('requestScoreChange', { matchId: this.id, sets: this.res.sets, reason });
      wx.showToast({ title: mode === 'edit' ? '已修改' : mode === 'admin' ? '已更正，新比分生效' : '已提交，等对方处理', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 800);
    } catch (e) {
      wx.showModal({ title: '提交失败', content: e.message, showCancel: false });
    } finally { this.setData({ submitting: false }); }
  },
});
