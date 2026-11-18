// 球拍示意图：按品牌 / 系列配色画一支通用的球拍（utils/racket-art.js），不画品牌标志、不用产品图，也没有照片上传。
//   用法：<rk-art class="rk-ph" brand="{{r.brand}}" model="{{r.model}}" />（大小、圆角、底色由页面的 class 决定）
const A = require('../../utils/racket-art');

Component({
  options: { virtualHost: true, styleIsolation: 'apply-shared' },
  externalClasses: ['class'],
  properties: {
    brand: { type: String, value: '', observer: 'paint' },
    model: { type: String, value: '', observer: 'paint' },
  },
  data: { c: A.artOf('', '') },
  lifetimes: { attached() { this.paint(); } },
  methods: {
    paint() {
      const c = A.artOf(this.data.brand, this.data.model);
      if (c.f !== this.data.c.f || c.a !== this.data.c.a || c.g !== this.data.c.g) this.setData({ c });
    },
  },
});
