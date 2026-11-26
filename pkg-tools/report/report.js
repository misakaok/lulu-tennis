// 球风与年度数据二级页：集中展示年度战报卡（可本地生成海报图存相册）、五维球风雷达、年度打球黄绿热力图、关键分统计、对手与拍档、双打搭档表。
//   所有数据均由正式比赛比分实时计算，不接微信转发或社交分享接口。
const db = require('../../utils/db');
const PV = require('../../utils/player');
const K = require('../../utils/racket');
const Poster = require('../utils/poster');
const P = require('../../utils/photo');
const PRV = require('../../utils/privacy');
const haptic = require('../../utils/haptic');

const pad = (n) => (n < 10 ? '0' + n : '' + n);
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

Page({
  data: {
    loading: true, view: null, annual: null, hmPick: '',
    topAxisIdx: -1, hasClutchMetrics: false,
    posterOpen: false, posterBusy: false, posterReady: false,
  },

  onLoad(options) {
    wx.hideShareMenu({ fail() {} });
    const myCached = db.cachedOpenid ? db.cachedOpenid() : '';
    this.uid = decodeURIComponent((options && options.uid) || '') || myCached;
    this.myId = myCached;
    if (!this.uid) { this.setData({ loading: false }); return; }
    this.rkStats = this.readCachedRacketStats();
    // 先用本机缓存画出来，再读云端共享数据更正
    this.render(db.cachedProfiles(), db.cachedPlayersFull(), db.cachedMatches());
    this.load();
  },

  readCachedRacketStats() {
    if (!this.myId || this.myId !== this.uid) return null;
    try {
      const API = require('../../utils/rackets');
      const c = API.cachedList && API.cachedList();
      if (!c) return null;
      return K.yearlyStats(c.rackets, c.logs, todayStr());
    } catch (e) { return null; }
  },

  async load() {
    try {
      const [players, matches, myId] = await Promise.all([
        db.playersShared(), db.matchesShared(), db.myOpenid ? db.myOpenid().catch(() => this.myId || '') : Promise.resolve(this.myId || ''),
      ]);
      this.myId = myId || this.myId || '';
      if (this.myId && this.myId === this.uid) {
        try {
          const API = require('../../utils/rackets');
          if (API.load) {
            const rk = await API.load().catch(() => null);
            if (rk) this.rkStats = K.yearlyStats(rk.rackets, rk.logs, todayStr());
          }
        } catch (e) {}
      } else {
        this.rkStats = null;
      }
      this.render(db.profilesOf(players), players, matches);
    } catch (e) { console.error(e); }
    if (this.data.loading) this.setData({ loading: false });
  },

  render(profiles, players, matches) {
    if (!this.uid) return;
    const v = PV.playerView(profiles, players, matches, this.uid);
    if (!v.profile) return;
    const isSelf = !!this.myId && this.myId === this.uid;
    const year = (v.heatmap && v.heatmap.year) || String(new Date().getFullYear());
    const annual = PV.annualView(v, matches, this.uid, v.profile.name, year, isSelf ? this.rkStats : null);
    this.annual = annual; // 完整年度摘要留给本机 Canvas 海报使用
    // 视图层只传 WXML 展示所需的精简字段，避免把 annual.style（重复雷达 SVG）再传一遍
    const annualShown = annual ? {
      year: annual.year, played: annual.played, rate: annual.rate,
      days: annual.days, bestStreak: annual.bestStreak, racket: annual.racket,
    } : null;
    let topAxisIdx = -1;
    if (v.style && v.style.unlocked && v.style.axes && v.style.axes.length) {
      topAxisIdx = 0;
      for (let i = 1; i < v.style.axes.length; i++) {
        if (v.style.axes[i].v > v.style.axes[topAxisIdx].v) topAxisIdx = i;
      }
    }
    const hasClutchMetrics = !!(v.clutch && (v.clutch.tb.played || v.clutch.tight.played || v.clutch.comeback.played));
    const view = {
      profile: v.profile,
      level: v.level,
      stats: v.stats,
      trend: v.trend,
      style: v.style,
      heatmap: v.heatmap,
      clutch: v.clutch,
      relations: v.relations,
      partners: v.partners,
    };
    const title = `${v.profile.name} 的球风数据`;
    if (title !== this.lastTitle) { this.lastTitle = title; wx.setNavigationBarTitle({ title }); }
    // 云端返回与本机缓存完全一致时跳过第二次全量 setData，避免 371 格热力图与柱状图重复重绘
    const sig = JSON.stringify([isSelf, annualShown, topAxisIdx, hasClutchMetrics, view]);
    if (sig === this.renderedSig) return;
    this.renderedSig = sig;
    this.setData({
      loading: false,
      annual: annualShown,
      topAxisIdx,
      hasClutchMetrics,
      view,
      hmPick: '',
    });
  },

  hmTap(e) {
    const { md, n, lv } = e.currentTarget.dataset;
    if (Number(lv) < 0 || !md) return;
    const cnt = Number(n) || 0;
    this.setData({ hmPick: cnt ? `${md} · 打了 ${cnt} 场` : `${md} · 无正式比赛` });
  },

  openPlayer(e) {
    const u = e.currentTarget.dataset.uid;
    if (!u) return;
    const me = this.myId || (db.cachedOpenid ? db.cachedOpenid() : '');
    if (me && u === me) wx.switchTab({ url: '/pages/me/me' });
    else wx.navigateTo({ url: '/pages/player/player?uid=' + encodeURIComponent(u) });
  },

  /* ---------- 纯本机 Canvas 生成年度战报长图并保存到相册 ---------- */
  onUnload() { this.stopPosterTimer(); },
  stopPosterTimer() { if (this.posterTimer) { clearTimeout(this.posterTimer); this.posterTimer = null; } },

  async resolvePosterAvatar() {
    const name = (this.annual && this.annual.name) || '';
    const own = P.ownSrc(this.uid, name);
    if (own) return { src: own, fileID: '' };
    const fileID = P.fileOf(this.uid, name);
    if (!fileID) return null;
    const src = P.peek(fileID) || await P.resolve(fileID).catch(() => '');
    return { src, fileID };
  },

  openPoster() {
    if (!this.annual) return;
    haptic.light();
    this.stopPosterTimer();
    this.posterPath = '';
    const seq = this.posterSeq = (this.posterSeq || 0) + 1;
    const avatarP = this.resolvePosterAvatar().catch(() => null);
    const draw = (tries) => {
      if (seq !== this.posterSeq || !this.data.posterOpen) return;
      const q = wx.createSelectorQuery().in(this);
      q.select('#poster-cv').fields({ node: true, size: true }).exec(async (res) => {
        if (seq !== this.posterSeq || !this.data.posterOpen) return;
        const node = res && res[0] && res[0].node;
        if (!node) {
          // 安卓较慢机型上 wx:if 刚挂载的 2d 画布节点可能晚一帧就绪，短暂重试
          if (tries < 3) { this.posterTimer = setTimeout(() => draw(tries + 1), 60); return; }
          this.setData({ posterBusy: false });
          wx.showToast({ title: '当前微信版本暂不支持画布导出', icon: 'none' });
          return;
        }
        try {
          const avatar = await avatarP;
          if (seq !== this.posterSeq || !this.data.posterOpen) return;
          const filePath = await Poster.render(node, this.annual, todayStr(), avatar);
          if (seq !== this.posterSeq || !this.data.posterOpen) return;
          this.posterPath = filePath;
          this.setData({ posterBusy: false, posterReady: true });
        } catch (err) {
          console.error(err);
          if (seq !== this.posterSeq || !this.data.posterOpen) return;
          this.setData({ posterBusy: false });
          wx.showToast({ title: '生成失败，请重试', icon: 'none' });
        }
      });
    };
    this.setData({ posterOpen: true, posterBusy: true, posterReady: false }, () => {
      if (typeof wx.nextTick === 'function') wx.nextTick(() => draw(0));
      else this.posterTimer = setTimeout(() => draw(0), 40);
    });
  },

  closePoster() {
    this.posterSeq = (this.posterSeq || 0) + 1;
    this.stopPosterTimer();
    this.setData({ posterOpen: false, posterBusy: false });
  },

  previewPoster() {
    if (!this.posterPath) return;
    wx.previewImage({ urls: [this.posterPath], current: this.posterPath });
  },

  savePoster() {
    if (!this.posterPath) { wx.showToast({ title: '战报图还在生成中', icon: 'none' }); return; }
    wx.saveImageToPhotosAlbum({
      filePath: this.posterPath,
      success: () => {
        haptic.medium();
        wx.showToast({ title: '已保存到相册', icon: 'success' });
      },
      fail: (err) => {
        if (PRV.isDenied(err)) { PRV.stopped(); return; }
        const msg = String((err && err.errMsg) || '');
        if (/cancel/i.test(msg)) return;
        if (!PRV.isUndeclared(err) && /auth deny|authorize/i.test(msg)) {
          wx.showModal({
            title: '需要相册权限',
            content: '请在设置中开启「保存到相册」权限，开启后再点保存即可。',
            confirmText: '去设置',
            success: (r) => { if (r.confirm) wx.openSetting(); },
          });
          return;
        }
        wx.showToast({ title: '保存失败，可点大图长按保存', icon: 'none' });
      },
    });
  },
});
