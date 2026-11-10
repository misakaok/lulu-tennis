// 头像图片：传入数据库里的原始 fileID（或 HTTPS / 本地临时路径）
//   cloud:// 自动换成 HTTPS 临时链接；拿不到或加载出错时显示默认头像（出错会先重新获取一次）
//   用法：<av-img class="avatar sm" src="{{p.avatar}}" />（class 直接用页面里的样式）
const A = require('../../utils/avatar');

Component({
  options: { virtualHost: true }, // 不生成外层节点，class / style 直接作用在图片上
  externalClasses: ['class'],
  properties: {
    src: { type: String, value: '', observer: 'load' },
    style: { type: String, value: '' },
  },
  data: { url: '' },
  lifetimes: {
    attached() { if (this.cur !== this.data.src) this.load(); },
  },
  methods: {
    load() {
      const src = this.data.src || '';
      if (this.cur === src && this.data.url) return;
      this.cur = src;
      this.retried = false;
      if (!src) { this.setData({ url: A.DEFAULT }); return; }
      const now = A.peek(src);
      if (now) { this.setData({ url: now }); return; }
      if (!A.isCloud(src)) { this.setData({ url: A.DEFAULT }); return; }
      this.setData({ url: '' }); // 获取中：先留空（保留样式里的底色）
      A.resolve(src).then((url) => {
        if (this.cur === src) this.setData({ url: url || A.DEFAULT });
      });
    },
    onErr() {
      const src = this.cur;
      if (!src || this.data.url === A.DEFAULT) return;
      console.warn('[头像] 图片加载失败', src, this.data.url);
      if (A.isCloud(src) && !this.retried) {
        this.retried = true; // 缓存的临时链接可能失效了，重新获取一次
        A.invalidate(src);
        A.resolve(src, true).then((url) => {
          if (this.cur === src) this.setData({ url: url && url !== this.data.url ? url : A.DEFAULT });
        });
        return;
      }
      this.setData({ url: A.DEFAULT });
    },
  },
});
