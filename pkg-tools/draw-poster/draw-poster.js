// 活动高清对阵 / 战果图预览与保存页（纯本机 Canvas 2D，不上传云端、不走微信转发接口）
const db = require('../../utils/db');
const DP = require('../utils/draw-poster');
const Mask = require('../utils/mask');
const P = require('../../utils/photo');
const E = require('../../utils/event');
const ID = require('../../utils/ident');
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
    // 外传名字要的报名（认用户 ID）、资料（看授权）、本人 ID 也先用本机的，读不到的按没同意处理
    this.myId = db.cachedOpenid ? db.cachedOpenid() : '';
    this.signups = (peek && peek.signups) || (db.cachedDrawSignups ? db.cachedDrawSignups(this.id) : null) || [];
    this.profiles = db.cachedProfiles ? db.cachedProfiles() : {};
    this.profilesFresh = false; // 本机记着的授权可能是旧的：拿到这次云端的最新资料之前只预览、不让存
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
      const [bundle, allMatches, players, myId] = await Promise.all([
        db.fetchDrawDetail ? db.fetchDrawDetail(this.id).catch(() => null) : Promise.resolve(null),
        db.matchesShared ? db.matchesShared().catch(() => (db.cachedMatches ? db.cachedMatches() : [])) : Promise.resolve([]),
        db.playersShared ? db.playersShared().catch(() => null) : Promise.resolve(null),
        db.myOpenid ? db.myOpenid().catch(() => '') : Promise.resolve(''),
      ]);
      if (this.gone) return;
      if (myId) this.myId = myId;
      if (bundle && Array.isArray(bundle.signups)) this.signups = bundle.signups;
      const d = (bundle && bundle.draw) || (db.getDraw ? await db.getDraw(this.id).catch(() => null) : null);
      if (this.gone) return;
      // 读不到最新资料时按谁都没同意处理（不沿用本机记着的旧授权）。
      // 换上最新授权和下面重画之间不能有 await：否则这段时间里能把按旧授权画的图存走
      this.profiles = players && db.profilesOf ? (db.profilesOf(players) || {}) : {};
      this.profilesFresh = true;
      if (!d) {
        if (this.drawDoc) this.drawNow(false); // 活动读不到：照旧用本机的活动，但按最新授权重画
        else this.setData({ error: '未找到这个活动，可能已被删除' });
        return;
      }
      if (d.status === 'signup') {
        this.drawSeq = (this.drawSeq || 0) + 1; // 作废还在画的那张
        this.posterPath = '';
        this.setData({ ready: false, canSave: false, error: '活动还在报名中，生成对阵后再来保存长图' });
        return;
      }
      this.applySource(d, allMatches || []);
    } catch (e) {
      if (this.gone) return;
      this.profiles = {};
      this.profilesFresh = true;
      if (this.drawDoc) this.drawNow(false);
      else this.setData({ error: '活动读取失败，请返回重试' });
    }
  },

  applySource(draw, allMatches) {
    const d = Object.assign({}, draw, { _id: draw._id || this.id });
    const matches = (allMatches || []).filter((m) => m && m.drawId === d._id);
    this.drawDoc = d;
    this.drawMatches = matches;
    this.drawNow(false);
  },

  // 外传名字：没同意公开展示的人写「球友」，本人照常（pkg-tools/utils/mask.js）
  nameOfFor(d) {
    const uidOf = ID.drawUids(d, this.signups || []);
    const people = [];
    (d.entrants || []).forEach((ent) => E.membersOf(d, ent).forEach((n) => people.push({ id: n, uid: uidOf[n] || '', name: n })));
    return Mask.masker(people, this.profiles || {}, this.myId || '');
  },

  // 图上画照片的人：同意了最新版说明的（名字露出来的）和本人，只画通过检测、正在公开的照片（缩略图，本机文件或临时链接）。
  // 本人检测中的新照片（P.ownSrc）不画：这张图会被存走、转发到小程序以外，没过检测的照片不能外传。
  // 照片和授权都只认这次从云端读到的资料（this.profiles），读不到就谁的照片都不画；返回 { 图上的名字: 地址 }。
  // 换链接最多等 DP.PHOTO_WAIT_MS，没拿到的画首字圆，不让页面一直不能保存
  async photoSrcs(d) {
    if (!this.profilesFresh) return {};
    const uidOf = ID.drawUids(d, this.signups || []);
    const ok = Mask.shownBy(this.profiles || {}, this.myId || '');
    const out = {};
    const tasks = [];
    (d.entrants || []).forEach((ent) => E.membersOf(d, ent).forEach((n) => {
      const uid = uidOf[n] || '';
      if (!ok(uid) || out[n] !== undefined || /^球友\d*$/.test(n)) return; // 真名就叫「球友N」的不画，免得和换掉的名字撞
      out[n] = '';
      const prof = (this.profiles || {})[uid];
      const fileID = (prof && prof.photo) || '';
      if (!fileID) return;
      const seen = P.peek(fileID);
      if (seen) { out[n] = seen; return; }
      tasks.push(P.resolve(fileID).then((u) => { out[n] = u || ''; }).catch(() => {}));
    }));
    await DP.within(Promise.all(tasks), DP.PHOTO_WAIT_MS);
    return Object.assign({}, out); // 超时后晚到的链接不再改这一份
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
    const model = DP.buildModel(this.drawDoc, this.drawMatches || [], { compact, nameOf: this.nameOfFor(this.drawDoc) });
    const sig = JSON.stringify([compact, model, !!this.profilesFresh]); // 拿到最新授权后重画一次（这时才画照片）
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
          const photos = await this.photoSrcs(this.drawDoc).catch(() => ({}));
          if (seq !== this.drawSeq || this.gone) return;
          const stale = () => seq !== this.drawSeq || this.gone;
          const out = await DP.render(node, this.drawDoc, this.drawMatches || [], { compact, model, genDate: todayStr(), photos, stale });
          if (!out || stale()) return; // 又有新的一轮在画：这一轮不碰画布、不出图
          this.posterPath = out.filePath;
          this.setData({ busy: false, canSave: !!this.profilesFresh }); // 还没核对完授权的那一版不亮「保存」
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

  // 拿到这次云端的最新授权之前不让存、不让全屏预览（全屏预览可以长按保存）
  notChecked() {
    if (this.profilesFresh) return false;
    wx.showToast({ title: '正在核对球友的公开展示设置，请稍等', icon: 'none' });
    return true;
  },

  previewPoster() {
    if (!this.posterPath || this.notChecked()) return;
    haptic.light();
    wx.previewImage({ urls: [this.posterPath], current: this.posterPath });
  },

  savePoster() {
    if (!this.posterPath) { wx.showToast({ title: '长图还在生成中', icon: 'none' }); return; }
    if (this.notChecked()) return;
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
