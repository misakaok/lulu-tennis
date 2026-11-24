// 选球员的底部弹层（2026-11-24 用户要求：人多了系统滚轮不好选）：顶部按名字搜索，下面带头像的名字点选。
//   补录积分（pages/cup-edit）、管理员代报名（pages/draw-view）共用。
//   list：[{ uid, name, g（性别）, tag（右侧小字，如「冠军」）, on（选中）, off（变灰） }]，由页面算好；
//   搜索只在本机按名字筛选，不保存、不上传。点名字触发 pick（{ uid }），多选时「确定」触发 confirm，关闭触发 close；
//   extra 有文字时底部多一个次要按钮（如代报名选搭档时的「不带搭档」），点了触发 extra。
//   页面用 wx:if 控制显示：每次打开都是新的，搜索框是空的。弹层不关、直接换场景（代报名选完第一位接着选搭档、标题变了、
//   可选的人换了一批）时也清空搜索词；多选时只是勾选状态变了（同一批人）不清空
Component({
  options: { addGlobalClass: true }, // 用 app.wxss 的 .btn-line / .btn-primary / .gd / .avatar
  properties: {
    title: { type: String, value: '选择球员', observer: 'filter' },
    sub: { type: String, value: '点名字选中' },
    multi: { type: Boolean, value: false },
    list: { type: Array, value: [], observer: 'filter' },
    empty: { type: String, value: '没有可选的球友' },
    extra: { type: String, value: '' },
  },
  data: { q: '', shown: [] },
  lifetimes: { attached() { this.filter(); } },
  methods: {
    filter() {
      const list = this.data.list || [];
      const scene = this.data.title + '|' + list.map((x) => x.uid).join(',');
      if (this.scene !== undefined && scene !== this.scene && this.data.q) this.setData({ q: '' });
      this.scene = scene;
      const q = this.data.q.trim().toLowerCase();
      this.setData({ shown: q ? list.filter((x) => x.name.toLowerCase().indexOf(q) >= 0) : list });
    },
    onQ(e) { this.setData({ q: e.detail.value }); this.filter(); },
    tap(e) { this.triggerEvent('pick', { uid: e.currentTarget.dataset.uid }); },
    confirm() { this.triggerEvent('confirm'); },
    more() { this.triggerEvent('extra'); },
    close() { this.triggerEvent('close'); },
    noop() {},
  },
});
