// 球员头像：有通过检测的照片就显示照片，否则显示「彩色圆 + 名字首字」
//   用法：<pl-av class="avatar sm" uid="{{p.uid}}" name="{{p.name}}" />（class 直接用页面里原来首字圆的样式）
//   有用户 ID 按 ID 找照片，只有名字时按名字找（同名的不算）；preview 为 true 时点击查看大图
//   本人有照片在检测时，本人看到的是这张新照片（utils/photo.js 的 ownSrc），别人看到的仍是已通过的
const P = require('../../utils/photo');
const R = require('../../utils/rules');

Component({
  options: { virtualHost: true, styleIsolation: 'apply-shared' }, // 页面里原来首字圆的样式（含 .r1 .avatar.big 这类组合选择器）照样生效
  externalClasses: ['class'],
  properties: {
    uid: { type: String, value: '', observer: 'refresh' },
    name: { type: String, value: '', observer: 'refresh' },
    preview: { type: Boolean, value: false },
  },
  data: { url: '', initial: '', color: '#C9C9DE' },
  lifetimes: {
    attached() { P.subs.add(this); this.refresh(); },
    detached() { P.subs.delete(this); },
  },
  methods: {
    refresh() {
      const { uid, name } = this.data;
      const own = P.ownSrc(uid, name);
      const fileID = own ? '' : P.fileOf(uid, name);
      this.own = own;
      const d = { initial: name ? R.initialOf(name) : '', color: name ? R.colorOf(name) : '#C9C9DE', url: own || (fileID ? P.peek(fileID) : '') };
      if (fileID !== this.fileID) this.retried = false;
      this.fileID = fileID;
      if (d.url !== this.data.url || d.initial !== this.data.initial || d.color !== this.data.color) this.setData(d);
      if (fileID && !d.url) P.resolve(fileID).then((url) => { if (this.fileID === fileID && url && url !== this.data.url) this.setData({ url }); });
    },
    onErr() {
      if (this.own) { // 本人检测中照片的链接过期了：重新查一次（本机文件出错就改回已通过的照片）
        const own = this.own;
        this.own = '';
        this.setData({ url: '' });
        if (/^https?:/.test(own)) P.syncMine(true); else P.setMine(null);
        return;
      }
      const fileID = this.fileID;
      this.setData({ url: '' });
      if (!fileID || this.retried) return;
      this.retried = true; // 链接可能过期了：重新取一次
      P.invalidate(fileID);
      P.resolve(fileID).then((url) => { if (this.fileID === fileID && url) this.setData({ url }); });
    },
    onTap() {
      if (this.data.preview && this.data.url) wx.previewImage({ urls: [this.data.url], current: this.data.url, showmenu: false });
    },
  },
});
