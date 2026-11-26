// 双打排班与升降级冲场（纯本地工具，不建活动、不写数据库）：
//   1. 均衡排班（4～8 人）：按当前水平一次性生成多轮均衡对阵与公平轮换；
//   2. 升降级冲场（4～16 人，1～4 片场）：打完一轮录比分，实时「冲 1 号场」升降级或「按分动态配对」，每轮强制拆搭档并自动统计个人排行。
const MX = require('../utils/mixer');
const LD = require('../utils/ladder');
const Mask = require('../utils/mask');
const db = require('../../utils/db');
const R = require('../../utils/rating');
const PV = require('../../utils/privacy');
const haptic = require('../../utils/haptic');

const ROUND_OPTS = [1, 3, 4, 5, 6];

function decorateMatches(session) {
  const courts = session.courts;
  const isKingMulti = session.mode === 'king' && courts >= 2;
  return (session.current.matches || []).map((m) => {
    let ruleHint = '';
    if (isKingMulti) {
      if (m.court === 1) ruleHint = '胜守擂 · 负降 2 场';
      else if (m.court === courts) ruleHint = `胜升 ${courts - 1} 场 · 负留场`;
      else ruleHint = `胜升 ${m.court - 1} 场 · 负降 ${m.court + 1} 场`;
    } else if (courts === 1) {
      ruleHint = '每轮按积分重配搭档';
    } else if (m.court === 1) {
      ruleHint = '当前高分档位';
    } else {
      ruleHint = `实时积分第 ${m.court} 档`;
    }
    return Object.assign({}, m, { ruleHint });
  });
}

Page({
  data: {
    modeTab: 'mix',
    modeTabIdx: 0,
    // 均衡排班（4～8 人）
    all: [], // 可选成员：[{ id, uid, name, level, lvText, on, ldOn }]
    picked: [],
    rounds: 4, roundOpts: ROUND_OPTS,
    courts: 1, canTwo: false,
    seed: 0, res: null,
    // 升降级冲场（4～16 人）
    ldPicked: [],
    ldCourts: 0,
    ldRestCnt: 0,
    ldMode: 'king',
    ldModes: LD.MODES,
    ldPreset: 'g4',
    ldPresets: LD.SCORE_PRESETS,
    ldSession: null,
    ldMatches: [],
    ldStandings: [],
    ldCanNext: false,
    ldModeLabel: '',
    ldPresetLabel: '',
    ldPresetHint: '',
    ldLeader: null,
    ldHistoryRev: [],
    ldHistoryOpen: false,
  },

  onLoad(options) {
    wx.hideShareMenu({ fail() {} });
    const saved = LD.loadSaved();
    if (saved) {
      this.syncLadder(saved, { resetHistoryOpen: true });
      if (!options || options.tab !== 'mix') this.setData({ modeTab: 'ladder', modeTabIdx: 1 });
    } else if (options && options.tab === 'ladder') {
      this.setData({ modeTab: 'ladder', modeTabIdx: 1 });
    }
    // 复制出去的文字：没同意公开展示的写「球友」，要资料（看授权）和本人 ID，先用本机的
    this.profiles = db.cachedProfiles ? db.cachedProfiles() : {};
    this.myId = db.cachedOpenid ? db.cachedOpenid() : '';
    this.buildList(db.cachedPlayersFull ? db.cachedPlayersFull() : [], db.cachedMatches ? db.cachedMatches() : []);
    this.loadFresh();
  },

  // people：[{ id, uid, name }]（按名单顺序）。只有「按编号速排」的「N 号球友」（id 是 q1、q2…、没有用户 ID）照常写，
  // 其他的（包括万一没有用户 ID 的）一律按授权换
  outNameOf(people) {
    const real = [], demo = Object.create(null);
    (people || []).forEach((p) => {
      if (!p) return;
      if (!p.uid && /^q\d+$/.test(String(p.id || ''))) demo[p.id] = p.name;
      else real.push({ id: p.id, uid: p.uid || '', name: p.name });
    });
    // 本机记着的授权可能是旧的：没拿到这次云端的最新资料时，真人一律写「球友」（本人照常）
    const mask = Mask.masker(real, this.profilesFresh ? (this.profiles || {}) : {}, this.myId || '');
    return (id) => (id in demo ? demo[id] : mask(id));
  },

  async loadFresh() {
    try {
      const [players, matches] = await Promise.all([
        db.playersShared ? db.playersShared() : Promise.resolve(null),
        db.matchesShared ? db.matchesShared() : Promise.resolve([]),
      ]);
      if (players && db.profilesOf) { this.profiles = db.profilesOf(players) || {}; this.profilesFresh = true; }
      if (db.myOpenid) this.myId = (await db.myOpenid().catch(() => '')) || this.myId;
      this.buildList(players || [], matches);
    } catch (e) {}
  },

  setModeTab(e) {
    const v = e.currentTarget.dataset.v === 'ladder' ? 'ladder' : 'mix';
    if (v === this.data.modeTab) return;
    this.setData({ modeTab: v, modeTabIdx: v === 'ladder' ? 1 : 0 });
    haptic.light();
  },

  buildList(players, matches) {
    const ratings = R.ratingsOf(matches || [], players || []);
    const pickedMap = {};
    const ldPickedMap = {};
    if (!this.demoMode) (this.data.picked || []).forEach((p) => { pickedMap[p.id] = 1; });
    if (!this.ldDemoMode) (this.data.ldPicked || []).forEach((p) => { ldPickedMap[p.id] = 1; });
    const list = (players || []).filter((p) => p && p.name && p.uid).map((p) => {
      const lv = R.levelOf(ratings, p.name, players, p.uid);
      return {
        id: p.uid,
        uid: p.uid,
        name: p.name,
        level: lv,
        lvText: R.fmt(lv),
        on: !!pickedMap[p.uid],
        ldOn: !!ldPickedMap[p.uid],
      };
    });
    const isLd = this.data.modeTab === 'ladder';
    list.sort((a, b) => (isLd ? (b.ldOn ? 1 : 0) - (a.ldOn ? 1 : 0) : (b.on ? 1 : 0) - (a.on ? 1 : 0)) || b.level - a.level || a.name.localeCompare(b.name));
    const patch = { all: list };
    if (!this.demoMode) patch.picked = list.filter((x) => x.on);
    if (!this.ldDemoMode) {
      const ldPicked = list.filter((x) => x.ldOn);
      patch.ldPicked = ldPicked;
      patch.ldCourts = Math.floor(ldPicked.length / 4);
      patch.ldRestCnt = ldPicked.length % 4;
    }
    this.setData(patch);
    if (!this.demoMode && patch.picked && patch.picked.length >= 4) {
      this.compute(patch.picked, this.data.rounds, this.data.courts, this.data.seed);
    }
  },

  // ──── 均衡排班（4～8 人） ────
  togglePlayer(e) {
    const id = e.currentTarget.dataset.id;
    const all = this.data.all.slice();
    const idx = all.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const cur = all[idx];
    const cnt = all.filter((x) => x.on).length;
    if (!cur.on && cnt >= 8) { wx.showToast({ title: '最多选 8 位球友', icon: 'none' }); return; }
    this.demoMode = false;
    all[idx] = Object.assign({}, cur, { on: !cur.on });
    const picked = all.filter((x) => x.on);
    const courts = picked.length >= 8 ? this.data.courts : 1;
    this.setData({ all, picked, courts, canTwo: picked.length >= 8 });
    this.compute(picked, this.data.rounds, courts, this.data.seed);
    haptic.light();
  },

  // 临时约球免选人：直接用 4 / 6 / 8 位编号占位快速排轮换表
  quickDemo(e) {
    const n = Number(e.currentTarget.dataset.n) || 6;
    this.demoMode = true;
    const all = this.data.all.map((x) => Object.assign({}, x, { on: false }));
    const picked = [];
    for (let i = 1; i <= n; i++) picked.push({ id: 'q' + i, name: `${i} 号球友`, level: 2.5, lvText: '2.5', on: true });
    const courts = n >= 8 ? 2 : 1;
    this.setData({ all, picked, courts, canTwo: n >= 8, seed: 0 });
    this.compute(picked, this.data.rounds, courts, 0);
    haptic.light();
  },

  clearPick() {
    this.demoMode = false;
    const all = this.data.all.map((x) => Object.assign({}, x, { on: false }));
    this.setData({ all, picked: [], courts: 1, canTwo: false, res: null });
    haptic.light();
  },

  setRounds(e) {
    const rounds = Number(e.currentTarget.dataset.v) || 4;
    this.setData({ rounds });
    this.compute(this.data.picked, rounds, this.data.courts, this.data.seed);
    haptic.light();
  },

  setCourts(e) {
    const courts = Number(e.currentTarget.dataset.v) === 2 && this.data.picked.length >= 8 ? 2 : 1;
    this.setData({ courts });
    this.compute(this.data.picked, this.data.rounds, courts, this.data.seed);
    haptic.light();
  },

  reroll() {
    if (this.data.picked.length < 4) return;
    const seed = this.data.seed + 1;
    this.setData({ seed });
    this.compute(this.data.picked, this.data.rounds, this.data.courts, seed);
    haptic.medium();
  },

  compute(picked, rounds, courts, seed) {
    if (!picked || picked.length < 4) { this.setData({ res: null }); return; }
    const res = MX.schedule(picked, { rounds, courts, seed });
    this.setData({ res });
  },

  copyPlan() {
    const text = MX.formatSchedule(this.data.res, this.outNameOf(this.data.picked));
    if (!text) return;
    wx.setClipboardData({
      data: text,
      success: () => { haptic.medium(); wx.showToast({ title: '已复制排班表，可粘贴发群', icon: 'success' }); },
      fail: (e) => PV.copyFail(e),
    });
  },

  // ──── 升降级冲场（4～16 人） ────
  syncLadder(session, opts) {
    this.ldSession = session || null;
    if (!session) {
      this.setData({
        ldSession: null,
        ldMatches: [],
        ldStandings: [],
        ldCanNext: false,
        ldModeLabel: '',
        ldPresetLabel: '',
        ldPresetHint: '',
        ldLeader: null,
        ldHistoryRev: [],
        ldHistoryOpen: false,
      });
      return;
    }
    const modeObj = LD.MODES.find((x) => x.id === session.mode) || LD.MODES[0];
    const presetObj = LD.SCORE_PRESETS.find((x) => x.id === session.preset) || LD.SCORE_PRESETS[0];
    const rows = LD.standings(session);
    const done = (session.history || []).length;
    const patch = {
      ldSession: session,
      ldMatches: decorateMatches(session),
      ldStandings: rows,
      ldCanNext: LD.canAdvance(session),
      ldModeLabel: modeObj.label,
      ldPresetLabel: presetObj.label,
      ldPresetHint: presetObj.hint,
      ldLeader: done && rows.length ? rows[0] : null,
      ldHistoryRev: (session.history || []).slice().reverse(),
    };
    if (opts && opts.resetHistoryOpen) patch.ldHistoryOpen = false;
    this.setData(patch);
  },

  toggleLdPlayer(e) {
    const id = e.currentTarget.dataset.id;
    const all = this.data.all.slice();
    const idx = all.findIndex((x) => x.id === id);
    if (idx < 0) return;
    const cur = all[idx];
    const cnt = all.filter((x) => x.ldOn).length;
    if (!cur.ldOn && cnt >= 16) { wx.showToast({ title: '最多选 16 位球友（4 片场）', icon: 'none' }); return; }
    this.ldDemoMode = false;
    all[idx] = Object.assign({}, cur, { ldOn: !cur.ldOn });
    const ldPicked = all.filter((x) => x.ldOn);
    this.setData({
      all,
      ldPicked,
      ldCourts: Math.floor(ldPicked.length / 4),
      ldRestCnt: ldPicked.length % 4,
    });
    haptic.light();
  },

  quickLadder(e) {
    const n = Number(e.currentTarget.dataset.n) || 8;
    this.ldDemoMode = true;
    const all = this.data.all.map((x) => Object.assign({}, x, { ldOn: false }));
    const ldPicked = [];
    for (let i = 1; i <= n; i++) {
      ldPicked.push({ id: 'q' + i, uid: '', name: `${i} 号球友`, level: 2.5, lvText: '2.5', ldOn: true });
    }
    this.setData({
      all,
      ldPicked,
      ldCourts: Math.floor(n / 4),
      ldRestCnt: n % 4,
    });
    haptic.light();
  },

  clearLdPick() {
    this.ldDemoMode = false;
    const all = this.data.all.map((x) => Object.assign({}, x, { ldOn: false }));
    this.setData({ all, ldPicked: [], ldCourts: 0, ldRestCnt: 0 });
    haptic.light();
  },

  setLdMode(e) {
    const v = e.currentTarget.dataset.v === 'points' ? 'points' : 'king';
    this.setData({ ldMode: v });
    haptic.light();
  },

  setLdPreset(e) {
    const v = e.currentTarget.dataset.v || 'g4';
    this.setData({ ldPreset: v });
    haptic.light();
  },

  startLadder() {
    if (this.data.ldPicked.length < 4) {
      wx.showToast({ title: '至少选满 4 位球友开启冲场', icon: 'none' });
      return;
    }
    const s = LD.startSession(this.data.ldPicked, { mode: this.data.ldMode, preset: this.data.ldPreset });
    if (!s) return;
    LD.saveSession(s);
    this.syncLadder(s, { resetHistoryOpen: true });
    haptic.medium();
  },

  patchCourtMatch(next, court) {
    this.ldSession = next;
    const idx = (next.current.matches || []).findIndex((m) => m.court === court);
    if (idx < 0) { this.syncLadder(next); return; }
    const cur = this.data.ldMatches[idx];
    const updated = Object.assign({}, next.current.matches[idx], { ruleHint: cur ? cur.ruleHint : '' });
    const patch = { ldCanNext: LD.canAdvance(next) };
    patch[`ldMatches[${idx}]`] = updated;
    this.setData(patch);
  },

  onLdScore(e) {
    const cur = this.ldSession || this.data.ldSession;
    if (!cur) return;
    const court = Number(e.currentTarget.dataset.court);
    const side = e.currentTarget.dataset.side;
    const next = LD.setScore(cur, court, side, e.detail.value);
    LD.saveSession(next, true);
    this.patchCourtMatch(next, court);
  },

  pickLdTieBreak(e) {
    const cur = this.ldSession || this.data.ldSession;
    if (!cur) return;
    const court = Number(e.currentTarget.dataset.court);
    const side = e.currentTarget.dataset.side;
    const next = LD.setTieBreak(cur, court, side);
    LD.saveSession(next, true);
    this.patchCourtMatch(next, court);
    haptic.light();
  },

  nextLdRound() {
    const r = LD.advanceRound(this.ldSession || this.data.ldSession);
    if (!r.ok) { wx.showToast({ title: r.msg, icon: 'none' }); return; }
    LD.saveSession(r.session);
    this.syncLadder(r.session);
    haptic.medium();
    wx.showToast({ title: `已生成第 ${r.session.current.round} 轮`, icon: 'success' });
  },

  undoLdRound() {
    const s = this.ldSession || this.data.ldSession;
    if (!s || !s.history || !s.history.length) return;
    wx.showModal({
      title: '撤回上一轮结算？',
      content: `将回到第 ${s.history.length} 轮修改比分，当前第 ${s.current.round} 轮对阵会被替换。`,
      confirmText: '撤回',
      success: (res) => {
        if (!res.confirm) return;
        const prev = LD.undoRound(this.ldSession || this.data.ldSession);
        if (!prev) return;
        LD.saveSession(prev);
        this.syncLadder(prev);
        haptic.light();
      },
    });
  },

  toggleLdHistory() {
    this.setData({ ldHistoryOpen: !this.data.ldHistoryOpen });
    haptic.light();
  },

  copyLdRound() {
    const s = this.ldSession || this.data.ldSession;
    const text = LD.formatCurrentRound(s, this.outNameOf(s && s.roster));
    if (!text) return;
    wx.setClipboardData({
      data: text,
      success: () => { haptic.medium(); wx.showToast({ title: '已复制本轮对阵', icon: 'success' }); },
      fail: (e) => PV.copyFail(e),
    });
  },

  copyLdReport() {
    const s = this.ldSession || this.data.ldSession;
    const text = LD.formatFinalReport(s, this.outNameOf(s && s.roster));
    if (!text) return;
    wx.setClipboardData({
      data: text,
      success: () => { haptic.medium(); wx.showToast({ title: '已复制实时战报', icon: 'success' }); },
      fail: (e) => PV.copyFail(e),
    });
  },

  resetLadder() {
    wx.showModal({
      title: '结束本场冲场？',
      content: '将清空当前所有轮次比分与实时排行，重新选人开局。',
      confirmText: '确认重开',
      confirmColor: '#b34d4d',
      success: (res) => {
        if (!res.confirm) return;
        LD.saveSession(null);
        this.syncLadder(null);
        haptic.medium();
      },
    });
  },
});
