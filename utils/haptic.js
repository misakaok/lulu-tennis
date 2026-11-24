// 轻量触觉反馈：只给少数高价值操作（记分、主分段切换、报名 / 录分成功）轻震一下。
// 没有 wx（Node 单测）、旧版基础库没有 vibrateShort、调用失败都静默跳过，不影响原操作。
function buzz(type) {
  if (typeof wx === 'undefined' || typeof wx.vibrateShort !== 'function') return;
  try { wx.vibrateShort({ type, fail() {} }); } catch (e) { /* 低版本不支持 type 等：忽略 */ }
}
const light = () => buzz('light');
const medium = () => buzz('medium');

module.exports = { light, medium };
