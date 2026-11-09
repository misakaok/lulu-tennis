// 成员资格（前端）：云函数每次都会校验，这里负责「被拒绝时」清掉受保护的缓存、跳到准入页
// 触发时机：小程序启动 / 回到前台、任何云函数返回 NOT_MEMBER
const GATE = '/pages/gate/gate';
const KEEP = { my_openid: 1, last_rules: 1, last_event_rules: 1, after_gate: 1, notify_tmpl: 1 }; // notify_tmpl：订阅消息模板 ID，不是隐私数据

function clearProtected() {
  require('./memo').invalidate();
  try { require('./avatar').clearFiles(); } catch (e) {} // 本地缓存的头像文件也删掉
  try {
    const info = wx.getStorageInfoSync();
    (info.keys || []).forEach((k) => { if (!KEEP[k]) wx.removeStorageSync(k); });
  } catch (e) {}
}

let kicking = false;
function kickout(status) {
  clearProtected();
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
  const cur = pages.length ? pages[pages.length - 1].route : '';
  if (cur === 'pages/gate/gate' || kicking) return;
  kicking = true;
  if (cur && cur !== 'pages/gate/gate') { try { wx.setStorageSync('after_gate', '/' + cur); } catch (e) {} }
  wx.reLaunch({ url: GATE + (status ? '?status=' + status : ''), complete: () => { kicking = false; } });
}

async function status() {
  const cloud = require('./cloud');
  const r = await cloud.call('memberStatus');
  try {
    wx.setStorageSync('my_openid', r.uid);
    if (r.status === 'active') wx.setStorageSync('member_ok_at', Date.now()); else clearProtected();
  } catch (e) {}
  return r;
}

// 启动 / 回到前台时重新校验；不是正式成员就清缓存、去准入页
async function check() {
  try {
    const r = await status();
    if (r.status !== 'active') kickout(r.status);
    return r;
  } catch (e) { return null; } // 网络问题：不处理（云函数仍会拦截所有数据请求）
}

module.exports = { status, check, kickout, clearProtected, GATE };
