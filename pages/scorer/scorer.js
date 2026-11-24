// 场边记分：给 A、B 双方逐分记分，规则和完赛判断都在 utils/scorer.js（复用 utils/rules.js）。
// 只存在本机（一个草稿：规则 + 得分顺序，不含球员姓名或身份），离开页面、关掉小程序后可以继续。
// 完赛后由正式成员点「带入日常录分」，到原来的日常录分页（pages/add）选球员、核对后提交；
// 这里不写正式战绩，正式提交成功后录分页才清掉这份草稿。没有实时同步、分享或上传。
// 活动场次：从活动录分页（pages/score）点「场边记分」进来（?go=1），规则是这一场的规则、不能改；完赛后「带入这一场录分」
//   回到那一场的录分页预填局分，由本人核对后提交（录分页走原来的 recordEventMatch）。双方名字由录分页放在内存里（S.labelsOf）。
const S = require('../../utils/scorer');

const SIDES = ['我在 A 方', '我在 B 方'];

Page({
  data: {
    mode: 'setup', // setup 选规则 / resume 有草稿：继续还是新一场 / live 记分中
    authError: '', hasDraft: false,
    cfg: { setGames: 4, noAd: true, bestOf: 1 },
    v: null, // S.view 的结果
    ev: false, names: { a: 'A 方', b: 'B 方' }, evTitle: '', // 活动场次：双方名字（没有就是 A 方 / B 方）
  },

  onLoad(o) {
    let last = {};
    try { last = wx.getStorageSync('last_rules') || {}; } catch (e) {}
    this.setData({ cfg: S.cfgOf(last) });
    this.state = S.loadDraft();
    if (!this.state) return;
    // 活动录分页刚开好的这一场：直接进入记分
    if (o && o.go === '1') { this.render('live'); this.keepOn(true); return; }
    this.render('resume');
  },

  async onShow() {
    // 从录分页回来：正式提交成功后草稿已被清掉，回到选规则
    const d = S.loadDraft();
    if (this.state && !d) { this.state = null; this.setData({ mode: 'setup', hasDraft: false, v: null }); }
    if (this.data.mode === 'live') this.keepOn(true);
    // 只在本机记分，场边信号不好时也能用；明确不是正式成员才拦住（app.js 启动时也会校验并清掉本机数据）
    try {
      const r = await require('../../utils/member').statusCached();
      this.setData({ authError: r.status === 'active' ? '' : '成为正式成员后才能使用场边记分' });
    } catch (e) {}
  },
  onHide() { this.keepOn(false); },
  onUnload() { this.keepOn(false); },
  keepOn(on) { try { wx.setKeepScreenOn({ keepScreenOn: on, fail() {} }); } catch (e) {} },

  /* ---------- 选规则 ---------- */
  setOpt(e) {
    const { k, v } = e.currentTarget.dataset;
    const cfg = Object.assign({}, this.data.cfg);
    cfg[k] = k === 'noAd' ? v === '1' : Number(v);
    this.setData({ cfg: S.cfgOf(cfg) });
  },

  startNew() {
    if (this.data.authError) return;
    const go = () => {
      this.state = S.start(this.data.cfg);
      S.saveDraft(this.state);
      this.render('live');
      this.keepOn(true);
    };
    const old = S.loadDraft();
    if (!old || !old.points) { go(); return; }
    wx.showModal({
      title: '开始新一场？',
      content: '本机只保存一场记分，开始新一场会覆盖上一场' + (S.resultOf(old) ? '（已完赛、还没带入录分）' : '（还没打完）') + '。',
      confirmText: '覆盖', confirmColor: '#b34d4d',
      success: (r) => { if (r.confirm) go(); },
    });
  },

  // 有草稿时：继续记分 / 开始新一场（先去选规则，真正开始时才确认覆盖）
  resume() {
    if (this.data.authError) return;
    this.state = S.loadDraft();
    if (!this.state) { this.setData({ mode: 'setup', hasDraft: false, v: null }); return; }
    this.render('live');
    this.keepOn(true);
  },
  goSetup() {
    if (this.state) this.setData({ cfg: Object.assign({}, this.state.cfg) });
    this.setData({ mode: 'setup', hasDraft: !!S.loadDraft() });
    this.keepOn(false);
  },
  backToDraft() { this.state = S.loadDraft(); if (this.state) this.render('resume'); },

  /* ---------- 记分 ---------- */
  render(mode) {
    const ev = !!(this.state && this.state.ev);
    const l = ev ? S.labelsOf(this.state.ev) : null;
    const names = { a: (l && l.a) || 'A 方', b: (l && l.b) || 'B 方' };
    const v = this.state ? S.view(this.state) : null;
    if (v && l) { // 有名字时，获胜、占先的文字也写名字
      if (v.done) v.resultText = `${names[v.winner]} ${Math.max(v.won.a, v.won.b)}:${Math.min(v.won.a, v.won.b)} 获胜`;
      v.callText = v.callText.replace(/^A 方/, names.a + ' ').replace(/^B 方/, names.b + ' ');
    }
    this.setData({ mode: mode || this.data.mode, hasDraft: !!this.state, v, ev, names, evTitle: ev ? (l && l.title) || '活动场次' : '' });
  },

  point(e) {
    if (!this.state || this.data.authError) return;
    const next = S.addPoint(this.state, e.currentTarget.dataset.side);
    if (next === this.state) return; // 完赛后锁住
    this.state = next;
    S.saveDraft(next);
    this.render();
    try { wx.vibrateShort({ type: 'light', fail() {} }); } catch (err) {}
  },

  undo() {
    if (!this.state || !this.state.points) return;
    this.state = S.undo(this.state);
    S.saveDraft(this.state);
    this.render();
  },

  /* ---------- 带入日常录分 ---------- */
  // 录分页里自己固定在 A 方：先问自己在哪一方，在 B 方就把比分对调。这里不写正式战绩
  // 活动场次：A / B 就是对阵表里的两方，不用对调，回到这一场的录分页预填
  handoff() {
    if (!this.state || !S.resultOf(this.state) || this.data.authError) return;
    if (this.state.ev) { this.toFixture(); return; }
    const id = this.state.id;
    wx.showActionSheet({
      itemList: SIDES,
      success: (r) => {
        const side = r.tapIndex === 1 ? 'b' : 'a';
        // 从「记一场」页进来的：退回去，由那一页 onShow 取走标记后预填（已经选好的球员照样保留）
        const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
        const prev = pages[pages.length - 2];
        const open = () => wx.navigateTo({ url: `/pages/add/add?scorer=${id}&side=${side}` });
        if (prev && prev.route === 'pages/add/add') {
          S.setDailyPending(id, side);
          // 没退回去（连点、页面栈变了）就清掉标记、照旧打开新的录分页，免得以后打开「记一场」被旧草稿预填
          wx.navigateBack({ fail: () => { S.takeDailyPending(); open(); } });
          return;
        }
        open();
      },
    });
  },
  toFixture() {
    const { drawId, key } = this.state.ev;
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    const prev = pages[pages.length - 2];
    // 从这一场的录分页进来的：退回去，由录分页 onShow 取走标记后预填（不叠一层新的录分页）
    if (prev && prev.route === 'pages/score/score' && prev.drawId === drawId && prev.key === key) {
      S.setPending(this.state);
      wx.navigateBack();
      return;
    }
    wx.redirectTo({ url: `/pages/score/score?drawId=${encodeURIComponent(drawId)}&key=${encodeURIComponent(key)}&scorer=${this.state.id}` });
  },
});
