// 场边记分：给 A、B 双方逐分记分，规则和完赛判断都在 utils/scorer.js（复用 utils/rules.js）。
// 只存在本机（一个草稿：规则 + 得分顺序，不含球员姓名或身份），离开页面、关掉小程序后可以继续。
// 完赛后由正式成员点「带入日常录分」，到原来的日常录分页（pages/add）选球员、核对后提交；
// 这里不写正式战绩，正式提交成功后录分页才清掉这份草稿。没有实时同步、分享或上传。
// 活动场次：从活动录分页（pages/score）点「场边记分」进来（?go=1），规则是这一场的规则、不能改；完赛后「带入这一场录分」
//   回到那一场的录分页预填局分，由本人核对后提交（录分页走原来的 recordEventMatch）。双方名字由录分页放在内存里（S.labelsOf）。
const S = require('../utils/scorer');
const haptic = require('../../utils/haptic');

const SIDES = ['我在 A 方', '我在 B 方'];
const RK_QUICK = [30, 60, 90, 120].map((m) => ({ m: String(m), t: m < 60 ? `${m} 分钟` : `${m / 60} 小时` }));
const TAG_LIST = [
  { c: 'A', t: 'ACE' }, { c: 'D', t: '双误' }, { c: 'W', t: '制胜分' }, { c: 'U', t: '非受迫失误' },
];
const pad2 = (n) => (n < 10 ? '0' + n : '' + n);
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };
const fmtSec = (s) => `${pad2(Math.floor(Math.max(0, s) / 60))}:${pad2(Math.max(0, s) % 60)}`;

// 这一分有没有拿下一局：各盘局数之和变多（盘打完时当前盘归 0、但打完的那盘多了一局），或刚好完赛
const gamesOf = (v) => (v && v.cols ? v.cols.reduce((n, c) => n + (Number(c.a) || 0) + (Number(c.b) || 0), 0) : 0);
const gameWon = (before, after) => !!after && ((after.done && !(before && before.done)) || gamesOf(after) > gamesOf(before));

Page({
  data: {
    mode: 'setup', // setup 选规则 / resume 有草稿：继续还是新一场 / live 记分中
    authError: '', hasDraft: false,
    cfg: { setGames: 4, noAd: true, bestOf: 1 },
    setupServe: '', // 选规则时提前选好的先发球方（'' | 'a' | 'b'）
    v: null, // S.view 的结果
    ev: false, names: { a: 'A 方', b: 'B 方' }, evTitle: '', // 活动场次：双方名字（没有就是 A 方 / B 方）
    // 转球拍选发球弹层
    tossOpen: false, tossSpin: false, tossRes: '', // '' | 'up' | 'down'
    // 可选极简技术统计 + 大字常亮计分板 + 热身/换边倒计时
    statOn: false, tagList: TAG_LIST, bigBoard: false,
    tmr: null, // { label, total, left, text, pct, paused, done }
    // 完赛顺手记入球拍时长弹层
    rkOpen: false, rkBusy: false, rkLoading: false, rkList: [], rkId: '', rkMin: '', rkQuick: RK_QUICK, rkLogged: null,
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
    if (this.state && !d) { this.state = null; this.setData({ mode: 'setup', hasDraft: false, v: null, rkLogged: null, bigBoard: false }); }
    if (this.data.mode === 'live') this.keepOn(true);
    if (this.data.tmr && !this.data.tmr.paused && !this.data.tmr.done && this.tmrEnd) this.runTimerLoop();
    // 只在本机记分，场边信号不好时也能用；明确不是正式成员才拦住（app.js 启动时也会校验并清掉本机数据）
    try {
      const r = await require('../../utils/member').statusCached();
      this.setData({ authError: r.status === 'active' ? '' : '成为正式成员后才能使用场边记分' });
    } catch (e) {}
  },
  onHide() { this.keepOn(false); this.stopToss(); this.pauseTimerLoop(); },
  onUnload() { this.keepOn(false); this.stopToss(); this.pauseTimerLoop(); },
  stopToss() {
    if (this.tossTimer) { clearTimeout(this.tossTimer); this.tossTimer = null; }
    if (this.data.tossSpin) this.setData({ tossSpin: false });
  },
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
      this.state = S.start(this.data.cfg, Date.now(), null, this.data.setupServe);
      S.saveDraft(this.state);
      this.rkLogMap = this.rkLogMap || {};
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
    if (this.state) this.setData({ cfg: Object.assign({}, this.state.cfg), setupServe: this.state.serve || '' });
    this.setData({ mode: 'setup', hasDraft: !!S.loadDraft(), names: { a: 'A 方', b: 'B 方' } });
    this.keepOn(false);
  },
  backToDraft() { this.state = S.loadDraft(); if (this.state) this.render('resume'); },

  /* ---------- 转球拍选发球权 ---------- */
  openToss() {
    if (this.data.authError) return;
    this.setData({ tossOpen: true, tossSpin: false, tossRes: '' });
  },
  closeToss() {
    this.stopToss();
    this.setData({ tossOpen: false });
  },
  spinCap() {
    if (this.data.tossSpin) return;
    haptic.light();
    this.setData({ tossSpin: true, tossRes: '' });
    this.tossTimer = setTimeout(() => {
      this.tossTimer = null;
      const res = Math.random() < 0.5 ? 'up' : 'down';
      this.setData({ tossSpin: false, tossRes: res });
      haptic.medium();
    }, 760);
  },
  pickServe(e) {
    const side = e.currentTarget.dataset.side;
    if (side !== 'a' && side !== 'b') return;
    haptic.light();
    if (this.data.mode === 'live' && this.state) {
      this.state = S.setServe(this.state, side);
      S.saveDraft(this.state);
      this.render();
    } else {
      this.setData({ setupServe: side });
    }
    this.closeToss();
  },
  toggleServe() {
    if (!this.state || this.data.authError) return;
    const next = this.state.serve === 'a' ? 'b' : 'a';
    this.state = S.setServe(this.state, next);
    S.saveDraft(this.state);
    this.render();
    haptic.light();
  },

  /* ---------- 记分 ---------- */
  render(mode) {
    const ev = !!(this.state && this.state.ev);
    const l = ev ? S.labelsOf(this.state.ev) : null;
    const names = { a: (l && l.a) || 'A 方', b: (l && l.b) || 'B 方' };
    const v = this.state ? S.view(this.state) : null;
    if (v && l) { // 有名字时，获胜、占先、抢七发球的文字也写名字
      if (v.done) v.resultText = `${names[v.winner]} ${Math.max(v.won.a, v.won.b)}:${Math.min(v.won.a, v.won.b)} 获胜`;
      v.callText = v.callText.replace(/^A 方/, names.a + ' ').replace(/^B 方/, names.b + ' ');
      if (v.tbServeText) v.tbServeText = v.tbServeText.replace(/^A 方/, names.a + ' ').replace(/^B 方/, names.b + ' ');
    }
    const rkLogged = (this.rkLogMap && this.state && this.rkLogMap[this.state.id]) || null;
    this.setData({ mode: mode || this.data.mode, hasDraft: !!this.state, v, ev, names, evTitle: ev ? (l && l.title) || '活动场次' : '', rkLogged });
  },

  point(e) {
    if (!this.state || this.data.authError) return;
    const next = S.addPoint(this.state, e.currentTarget.dataset.side);
    if (next === this.state) return; // 完赛后锁住
    const before = this.data.v;
    this.state = next;
    S.saveDraft(next);
    this.render();
    // 普通一分轻震；拿下一局 / 完赛 / 刚触发抢七换边重一点
    const after = this.data.v;
    const swapHit = !!(after && after.changeEnds && !(before && before.changeEnds));
    if (gameWon(before, after) || swapHit) haptic.medium(); else haptic.light();
  },

  undo() {
    if (!this.state || !this.state.points) return;
    this.state = S.undo(this.state);
    S.saveDraft(this.state);
    this.render();
    haptic.light();
  },

  /* ---------- 可选极简技术统计 & 大字常亮计分板 ---------- */
  toggleStat() {
    haptic.light();
    this.setData({ statOn: !this.data.statOn });
  },
  tagPoint(e) {
    if (!this.state || !this.state.points || this.data.authError) return;
    const code = e.currentTarget.dataset.c;
    this.state = S.tagLast(this.state, code);
    S.saveDraft(this.state);
    this.render();
    haptic.light();
  },
  toggleBig() {
    if (this.data.mode !== 'live' || !this.state) return;
    const on = !this.data.bigBoard;
    this.setData({ bigBoard: on });
    if (on) this.keepOn(true);
    haptic.light();
  },

  /* ---------- 5 分钟热身 / 90 秒换边倒计时（纯本地，按时间戳防飘移） ---------- */
  startTimer(e) {
    if (this.data.authError) return;
    const sec = Number(e.currentTarget.dataset.sec) || 90;
    const label = e.currentTarget.dataset.label || (sec >= 300 ? '热身倒计时' : '换边倒计时');
    this.pauseTimerLoop();
    this.tmrEnd = Date.now() + sec * 1000;
    this.tmrWarned = sec <= 15;
    this.setData({ tmr: { label, total: sec, left: sec, text: fmtSec(sec), pct: 100, paused: false, done: false } });
    this.keepOn(true);
    this.runTimerLoop();
    haptic.light();
  },
  toggleTimerPause() {
    const t = this.data.tmr;
    if (!t || t.done) return;
    if (t.paused) {
      this.tmrEnd = Date.now() + t.left * 1000;
      this.setData({ 'tmr.paused': false });
      this.runTimerLoop();
    } else {
      this.pauseTimerLoop();
      this.setData({ 'tmr.paused': true });
    }
    haptic.light();
  },
  stopTimer() {
    this.pauseTimerLoop();
    this.tmrEnd = 0;
    this.setData({ tmr: null });
    if (this.data.mode !== 'live') this.keepOn(false);
  },
  pauseTimerLoop() {
    if (this.tmrInt) { clearTimeout(this.tmrInt); this.tmrInt = null; }
  },
  runTimerLoop() {
    this.pauseTimerLoop();
    const tick = () => {
      const t = this.data.tmr;
      if (!t || t.paused || t.done) { this.pauseTimerLoop(); return; }
      const left = Math.max(0, Math.ceil((this.tmrEnd - Date.now()) / 1000));
      const pct = t.total > 0 ? Math.min(100, Math.round((left / t.total) * 100)) : 0;
      if (left <= 15 && left > 0 && !this.tmrWarned) { this.tmrWarned = true; haptic.light(); }
      if (left <= 0) {
        this.pauseTimerLoop();
        this.setData({ tmr: Object.assign({}, t, { left: 0, text: '00:00', pct: 0, done: true }) });
        haptic.medium();
        return;
      }
      if (left !== t.left) this.setData({ tmr: Object.assign({}, t, { left, text: fmtSec(left), pct }) });
      this.tmrInt = setTimeout(tick, 250);
    };
    tick();
  },

  /* ---------- 完赛顺手记入球拍打球时长 ---------- */
  openRkLog() {
    if (!this.state || !this.data.v || !this.data.v.done || this.data.authError) return;
    const API = require('../../utils/rackets');
    const K = require('../../utils/racket');
    const mapList = (rackets) => {
      const live = (rackets || []).filter((r) => r.status !== 'retired').sort((a, b) => a.no - b.no);
      const src = live.length ? live : (rackets || []).slice().sort((a, b) => a.no - b.no);
      return src.map((r) => ({ id: r.id, title: K.racketTitle(r), name: K.racketName(r) }));
    };
    const c = API.cachedList();
    const list = c ? mapList(c.rackets) : [];
    const el = this.data.v.elapsedMin || 0;
    const initMin = el >= 5 && el <= 600 ? String(el) : '';
    this.setData({
      rkOpen: true, rkBusy: false, rkLoading: !c,
      rkList: list, rkId: list[0] ? list[0].id : '', rkMin: initMin,
    });
    API.load().then(({ rackets }) => {
      if (!this.data.rkOpen) return;
      const fresh = mapList(rackets);
      const keep = fresh.some((x) => x.id === this.data.rkId) ? this.data.rkId : (fresh[0] ? fresh[0].id : '');
      this.setData({ rkLoading: false, rkList: fresh, rkId: keep });
    }).catch(() => {
      if (this.data.rkOpen) this.setData({ rkLoading: false });
    });
  },
  closeRkLog() { if (!this.data.rkBusy) this.setData({ rkOpen: false }); },
  pickRk(e) { this.setData({ rkId: e.currentTarget.dataset.id }); },
  rkMinInput(e) { this.setData({ rkMin: String(e.detail.value || '').replace(/\D/g, '').slice(0, 3) }); },
  rkMinQuick(e) { this.setData({ rkMin: e.currentTarget.dataset.m }); },
  goAddRacket() { this.setData({ rkOpen: false }); wx.navigateTo({ url: '/pkg-tools/racket-edit/racket-edit' }); },
  async saveRkLog() {
    if (this.data.rkBusy || !this.state) return;
    if (!this.data.rkId) { wx.showToast({ title: '请先选择球拍', icon: 'none' }); return; }
    if (!/^\d+$/.test(this.data.rkMin)) { wx.showToast({ title: '请填打球分钟数', icon: 'none' }); return; }
    const K = require('../../utils/racket');
    const API = require('../../utils/rackets');
    const d = todayStr();
    const chk = K.cleanLog({ kind: 'play', date: d, minutes: Number(this.data.rkMin) }, d);
    if (!chk.ok) { wx.showToast({ title: chk.msg, icon: 'none' }); return; }
    const rk = this.data.rkList.find((x) => x.id === this.data.rkId);
    this.setData({ rkBusy: true });
    try {
      await API.saveLog('', this.data.rkId, chk.rec);
      const info = { title: rk ? rk.title : '球拍', text: K.minutesText(chk.rec.minutes) };
      this.rkLogMap = this.rkLogMap || {};
      this.rkLogMap[this.state.id] = info;
      this.setData({ rkOpen: false, rkBusy: false, rkLogged: info });
      haptic.medium();
      wx.showToast({ title: '已记入球拍时长', icon: 'success' });
      API.refreshBadge();
    } catch (err) {
      this.setData({ rkBusy: false });
      wx.showToast({ title: (err && err.message) || '保存失败', icon: 'none' });
    }
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
        const open = () => wx.navigateTo({ url: `/pkg-manage/add/add?scorer=${id}&side=${side}` });
        if (prev && prev.route === 'pkg-manage/add/add') {
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
    if (prev && prev.route === 'pkg-manage/score/score' && prev.drawId === drawId && prev.key === key) {
      S.setPending(this.state);
      wx.navigateBack();
      return;
    }
    wx.redirectTo({ url: `/pkg-manage/score/score?drawId=${encodeURIComponent(drawId)}&key=${encodeURIComponent(key)}&scorer=${this.state.id}` });
  },
});
