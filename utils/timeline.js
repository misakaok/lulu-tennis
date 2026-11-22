// 朋友圈「单页模式」（场景值 1154）：从朋友圈点开时进入。没有登录身份，不能跳转到其他页面，
// 底部是微信自带的「前往小程序」按钮。这时不校验成员资格（校验失败会跳准入页，而单页模式不能跳）、
// 不读任何数据，活动首页只显示固定的介绍（见 pages/draw）。点「前往小程序」后是正常启动，照常校验
const SCENE = 1154;
function isTimeline() {
  try { const o = wx.getLaunchOptionsSync(); return !!o && o.scene === SCENE; } catch (e) { return false; }
}
module.exports = { SCENE, isTimeline };
