// 活动相册：浏览（网格 + 放大左右滑）、上传（多选 / 拍照，进度和失败重试）、管理（删自己的；发起人管全部）
// 权限、可见范围和内容安全检测都在云函数 tennis 里按用户 ID 处理，这里只按返回结果显示。
// 照片存在独立目录 event-photos/<活动 ID>/<上传者 ID>/，数据库只存 fileID，展示链接由云函数发放。
const db = require('../../utils/db');
const cloud = require('../../utils/cloud');
const C = require('../../utils/compress');

const MAX = 9;

function upload(cloudPath, filePath, onProgress) {
  return new Promise((resolve, reject) => {
    const task = wx.cloud.uploadFile({ cloudPath, filePath, success: (r) => resolve(r.fileID), fail: reject });
    if (task && task.onProgressUpdate) task.onProgressUpdate((p) => onProgress(p.progress));
  });
}

Page({
  data: {
    title: '', photos: [], queue: [], canUpload: false, isOwner: false, manage: false,
    loading: true, error: '', passCount: 0, uploading: false,
  },

  onLoad(o) {
    this.drawId = o.id;
    this.q = [];
    if (o.title) this.setData({ title: decodeURIComponent(o.title) });
    this.load();
  },
  onPullDownRefresh() { require('../../utils/memo').invalidate(); // 下拉刷新：不用内存缓存
    this.load().then(() => wx.stopPullDownRefresh()); },

  async load() {
    try {
      const r = await cloud.call('listEventPhotos', { drawId: this.drawId });
      this.setData({ photos: r.photos, canUpload: r.canUpload, isOwner: r.isOwner, passCount: r.passCount, loading: false, error: '' });
    } catch (e) {
      this.setData({ loading: false, error: e.message });
    }
  },

  /* ---------- 浏览 ---------- */
  preview(e) {
    const p = this.data.photos[e.currentTarget.dataset.i];
    if (!p || !p.url) return;
    const urls = this.data.photos.filter((x) => x.url).map((x) => x.url);
    wx.previewImage({ urls, current: p.url }); // 放大、左右滑动
  },

  /* ---------- 上传 ---------- */
  addPhotos() {
    if (!this.data.canUpload) { wx.showToast({ title: '报名后可以上传照片', icon: 'none' }); return; }
    wx.showActionSheet({ itemList: ['从相册选择', '拍照'], success: (r) => this.choose(r.tapIndex === 1 ? 'camera' : 'album') });
  },
  choose(source) {
    wx.chooseMedia({
      count: MAX, mediaType: ['image'], sourceType: [source], sizeType: ['compressed'],
      success: (r) => this.enqueue((r.tempFiles || []).map((f) => f.tempFilePath)),
      fail: (e) => {
        if (/cancel/.test(e.errMsg || '')) return;
        wx.showModal({ title: source === 'camera' ? '无法打开相机' : '无法打开相册', content: '请在小程序设置里允许使用相机 / 相册。', showCancel: false });
      },
    });
  },
  enqueue(paths) {
    paths.forEach((path, i) => this.q.push({ key: Date.now() + '-' + i, path, progress: 0, state: 'waiting', fileID: '', err: '' }));
    this.showQueue();
    this.run();
  },
  showQueue() {
    const text = { waiting: '等待上传', compressing: '压缩中', uploading: '上传中', saving: '提交审核', failed: '失败，点重试', done: '已提交' };
    this.setData({ queue: this.q.map((x) => Object.assign({}, x, { stateText: text[x.state] })) });
  },
  async run() {
    if (this.running) return;
    this.running = true;
    this.setData({ uploading: true });
    let uid = '';
    try { uid = await db.myOpenid(); } catch (e) {}
    for (let item = this.q.find((x) => x.state === 'waiting'); item; item = this.q.find((x) => x.state === 'waiting')) {
      try {
        if (!item.fileID) { // 已经传好的失败项重试时只需要重新登记
          // 逐张压缩后再上传；压缩失败直接报错让用户重试，不上传原图
          if (!item.small) {
            item.state = 'compressing'; this.showQueue();
            try { item.small = (await C.compress(item.path, 'event')).path; }
            catch (ce) { console.error('照片压缩失败', ce); throw new Error('压缩失败，点重试'); }
          }
          item.state = 'uploading'; this.showQueue();
          const ext = (item.path.match(/\.(\w+)$/) || [])[1] || 'jpg';
          const cloudPath = `event-photos/${this.drawId}/${uid}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
          item.fileID = await upload(cloudPath, item.small, (p) => { item.progress = p; this.showQueue(); });
        }
        item.state = 'saving'; item.progress = 100; this.showQueue();
        const r = await cloud.call('addEventPhotos', { drawId: this.drawId, fileIDs: [item.fileID] });
        const res = (r.photos || [])[0] || {};
        if (res.error) throw new Error(res.error);
        item.state = 'done';
      } catch (e) {
        item.state = 'failed';
        item.err = (e && e.message) || '上传失败';
        console.error('照片上传失败', e);
      }
      this.showQueue();
    }
    this.running = false;
    this.q = this.q.filter((x) => x.state !== 'done');
    this.showQueue();
    this.setData({ uploading: false });
    if (!this.q.length) wx.showToast({ title: '已上传，审核通过后大家可见', icon: 'none' });
    this.load();
  },
  retryUpload(e) {
    const item = this.q.find((x) => x.key === e.currentTarget.dataset.key);
    if (!item || item.state !== 'failed') return;
    item.state = 'waiting'; item.err = '';
    this.showQueue();
    this.run();
  },
  dropUpload(e) {
    this.q = this.q.filter((x) => x.key !== e.currentTarget.dataset.key || x.state !== 'failed');
    this.showQueue();
  },

  /* ---------- 管理 ---------- */
  toggleManage() { this.setData({ manage: !this.data.manage }); },
  delPhoto(e) {
    const p = this.data.photos[e.currentTarget.dataset.i];
    if (!p || !p.canDelete) return;
    wx.showModal({
      title: '删除这张照片？', content: p.mine ? '' : `这是 ${p.uploaderName} 上传的照片（你是活动发起人）`, confirmColor: '#e5484d',
      success: async (r) => {
        if (!r.confirm) return;
        try { await cloud.call('deleteEventPhoto', { photoId: p.id }); wx.showToast({ title: '已删除' }); this.load(); }
        catch (err) { wx.showModal({ title: '删除失败', content: err.message, showCancel: false }); }
      },
    });
  },
  async retryCheck(e) {
    const p = this.data.photos[e.currentTarget.dataset.i];
    try { await cloud.call('retryPhotoCheck', { photoId: p.id }); wx.showToast({ title: '已重新提交审核', icon: 'none' }); this.load(); }
    catch (err) { wx.showModal({ title: '重试失败', content: err.message, showCancel: false }); }
  },
});
