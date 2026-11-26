// 活动高清对阵 / 战果图预览与保存页（纯本机 Canvas 2D，不上传云端、不走微信转发接口）
const db = require('../../utils/db');
const DP = require('../utils/draw-poster');
const PRV = require('../../utils/privacy');
const haptic = require('../../utils/haptic');

const pad = (n) => (n < 10 ? '0' + n : '' + n);
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const STAGE_W_RPX = 686;

Page({
  data: {
    ready: false,
    error: '',
    drawTitle: '',
    statusText: '',
    hasGroups: false,
    compact: false,
    cvH: 1000,
    busy: false,
    canSave: false,
  },

  onLoad(options) {
    wx.hideShareMenu({ fail() {} });
    this.id = decodeURIComponent((options && options.id) || '');
    if (!this.id) { this.setData({ error: '未指定活动' }); return; }
    // 先用本机缓存立刻出图，再后台核对云端最新比分
    const peek = db.peekDrawDetail ? db.peekDrawDetail(this.id) : null;
    const cachedDraw = (peek && peek.draw)
      || (db.cachedDraws ? db.cachedDraws().find((x) => x && x._id === this.id) : null);
    const cachedMatches = db.cachedMatches ? db.cachedMatches() : [];
    if (cachedDraw && cachedDraw.status !== 'signup') {
      this.applySource(cachedDraw, cachedMatches);
    }
    this.loadFresh();
  },

  onUnload() {
    this.gone = true;
    this.stopTimer();
  },

  stopTimer() {
    if (this.drawTimer) { clearTimeout(this.drawTimer); this.drawTimer = null; }
  },

  async loadFresh() {
    try {
      const [bundle, allMatches] = await Promise.all([
        db.fetchDrawDetail ? db.fetchDrawDetail(this.id).catch(() => null) : Promise.resolve(null),
        db.matchesShared ? db.matchesShared().catch(() => (db.cachedMatches ? db.cachedMatches() : [])) : Promise.resolve([]),
      ]);
      if (this.gone) return;
      const d = (bundle && bundle.draw) || (db.getDraw ? await db.getDraw(this.id).catch(() => null) : null);
      if (this.gone) return;
      if (!d) {
        if (!this.drawDoc) this.setData({ error: '未找到这个活动，可能已被删除' });
        return;
      }
      if (d.status === 'signup') {
        this.setData({ ready: false, error: '活动还在报名中，生成对阵后再来保存长图' });
        return;
      }
      this.applySource(d, allMatches || []);
    } catch (e) {
      if (!this.gone && !this.drawDoc) this.setData({ error: '活动读取失败，请返回重试' });
    }
  },

  applySource(draw, allMatches) {
    const d = Object.assign({}, draw, { _id: draw._id || this.id });
    const matches = (allMatches || []).filter((m) => m && m.drawId === d._id);
    this.drawDoc = d;
    this.drawMatches = matches;
    this.drawNow(false);
  },

  setCompact(e) {
    const v = e.currentTarget.dataset.v === '1';
    if (v === this.data.compact) return;
    haptic.light();
    this.setData({ compact: v }, () => this.drawNow(true));
  },

  drawNow(force) {
    if (!this.drawDoc) return;
    const compact = !!this.data.compact;
    const model = DP.buildModel(this.drawDoc, this.drawMatches || [], { compact });
    const sig = JSON.stringify([compact, model]);
    if (!force && sig === this.renderedSig && (this.posterPath || this.data.busy)) return;
    this.renderedSig = sig;
    this.posterPath = '';

    const H = DP.measureHeight(model);
    const cvH = Math.round((STAGE_W_RPX * H) / DP.W);
    const navTitle = model.statusLime ? '活动战果图' : '活动对阵图';
    if (navTitle !== this.lastTitle) {
      this.lastTitle = navTitle;
      wx.setNavigationBarTitle({ title: navTitle });
    }

    this.stopTimer();
    const seq = this.drawSeq = (this.drawSeq || 0) + 1;
    const paintCanvas = (tries) => {
      if (seq !== this.drawSeq || this.gone) return;
      wx.createSelectorQuery().in(this).select('#draw-poster-cv').fields({ node: true, size: true }).exec(async (res) => {
        if (seq !== this.drawSeq || this.gone) return;
        const node = res && res[0] && res[0].node;
        if (!node) {
          if (tries < 4) { this.drawTimer = setTimeout(() => paintCanvas(tries + 1), 60); return; }
          this.renderedSig = '';
          this.setData({ busy: false });
          wx.showToast({ title: '当前微信版本暂不支持画布导出', icon: 'none' });
          return;
        }
        try {
          const out = await DP.render(node, this.drawDoc, this.drawMatches || [], { compact, model, genDate: todayStr() });
          if (seq !== this.drawSeq || this.gone) return;
          this.posterPath = out.filePath;
          this.setData({ busy: false, canSave: true });
        } catch (err) {
          console.error(err);
          if (seq !== this.drawSeq || this.gone) return;
          this.renderedSig = '';
          this.setData({ busy: false });
          wx.showToast({ title: '长图生成失败，请重试', icon: 'none' });
        }
      });
    };

    this.setData({
      ready: true,
      error: '',
      drawTitle: model.title,
      statusText: model.statusText,
      hasGroups: model.hasGroups,
      cvH,
      busy: true,
      canSave: false,
    }, () => {
      if (typeof wx.nextTick === 'function') wx.nextTick(() => paintCanvas(0));
      else this.drawTimer = setTimeout(() => paintCanvas(0), 40);
    });
  },

  previewPoster() {
    if (!this.posterPath) return;
    haptic.light();
    wx.previewImage({ urls: [this.posterPath], current: this.posterPath });
  },

  savePoster() {
    if (!this.posterPath) { wx.showToast({ title: '长图还在生成中', icon: 'none' }); return; }
    wx.saveImageToPhotosAlbum({
      filePath: this.posterPath,
      success: () => {
        haptic.medium();
        wx.showToast({ title: '已保存到相册，可发到群里', icon: 'success' });
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
        wx.showToast({ title: '保存失败，可点全屏预览长按保存', icon: 'none' });
      },
    });
  },

  goBack() { wx.navigateBack({ fail() { wx.switchTab({ url: '/pages/draw/draw' }); } }); },
});
