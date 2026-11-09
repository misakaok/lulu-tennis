// 订阅消息：弹出「允许发送通知」请求。
// 微信的一次性订阅：每点一次「允许」，才能收到一条对应的通知，所以在常用操作（报名、录分、确认、提交申请）时顺便请求。
// wx.requestSubscribeMessage 必须在点击事件里同步调用（前面不能有 await），所以模板 ID 提前取好放在本机（notify_tmpl）。
// 云函数里没配置模板时（cloudfunctions/tennis/notify-config.js），这里什么都不做。
const KEY = 'notify_tmpl';
const KINDS = ['confirm', 'request', 'result']; // 比分待确认、有新申请待处理、申请处理结果（一次最多请求 3 个）

let ids = null;
function cached() {
  if (!ids) { try { ids = wx.getStorageSync(KEY) || {}; } catch (e) { ids = {}; } }
  return ids;
}

// 启动时取一次模板 ID（失败没关系，下次再取）
function prefetch() {
  return require('./cloud').call('notifyTemplates').then((r) => {
    ids = r.templates || {};
    try { wx.setStorageSync(KEY, ids); } catch (e) {}
    return ids;
  }).catch(() => cached());
}

const available = () => KINDS.filter((k) => cached()[k]).length > 0;

// 在点击事件里调用（不要放在 await 后面）。kinds 不传就请求全部三类。返回 Promise<{ accepted: 允许了几类 }>
function ask(kinds) {
  const list = (kinds || KINDS).map((k) => cached()[k]).filter(Boolean);
  if (!list.length || !wx.requestSubscribeMessage) return Promise.resolve({ accepted: 0, unavailable: true });
  return new Promise((resolve) => {
    wx.requestSubscribeMessage({
      tmplIds: list,
      success: (r) => resolve({ accepted: list.filter((id) => r[id] === 'accept').length }),
      fail: () => resolve({ accepted: 0 }),
    });
  });
}

module.exports = { prefetch, ask, available, KINDS };
