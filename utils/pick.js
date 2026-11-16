// 原因一律从固定选项里选（E.REASONS），不让用户手写文字：个人主体不能有「自己写文字给别人看」的内容。
// 取消返回 null。title 只有安卓会显示在选项上方。
const E = require('./event');

function reason(kind, title) {
  const list = E.REASONS[kind] || [];
  return new Promise((resolve) => wx.showActionSheet({
    alertText: title || '请选择原因', itemList: list,
    success: (r) => resolve(list[r.tapIndex] || null), fail: () => resolve(null),
  }));
}

module.exports = { reason };
