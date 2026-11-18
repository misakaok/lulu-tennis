// 成员资格（前端）：云函数每次都会校验，这里负责「被拒绝时」清掉受保护的缓存、跳到准入页
// 触发时机：小程序启动 / 回到前台、任何云函数返回 NOT_MEMBER
const GATE = '/pages/gate/gate';
const KEEP = { my_openid: 1, last_rules: 1, last_event_rules: 1, after_gate: 1 };

function clearProtected() {
  require('./memo').invalidate();
  try { require('./db').forget(); } catch (e) {} // 本机缓存清空后，下次读取要重新整理并写回
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

// 同时发起的校验合并成一次（回到前台时 app.js 和当前页面会各调一次）；不缓存结果，每次新的校验都问云函数
let statusTask = null;
function status() {
  if (!statusTask) statusTask = fetchStatus().finally(() => { statusTask = null; });
  return statusTask;
}
// 只用来显示（「我的」页的用户 ID、管理员入口、待审核数）：结果在内存里缓存 60 秒（utils/memo.js），
// 自己的任何写操作、下拉刷新都会作废；正在进行的校验直接复用。不能用来判断成员资格（那个用 status / check）
function statusCached() {
  const memo = require('./memo');
  return memo.get('memberStatus', memo.ANY, status);
}
async function fetchStatus() {
  const cloud = require('./cloud');
  const r = await cloud.call('memberStatus');
  try {
    wx.setStorageSync('my_openid', r.uid);
    wx.setStorageSync('is_admin', !!r.isAdmin); // 只用来决定显示哪些按钮，权限由云函数判断
    if (r.status === 'active') wx.setStorageSync('member_ok_at', Date.now()); else clearProtected();
  } catch (e) {}
  applyBadge(r);
  if (r.status === 'active') require('./rackets').refreshBadge(); // 球拍穿线 / 维护到期提醒（只在确认是正式成员后查）
  return r;
}

// 管理员：有新的加入申请待审核时，底部「我的」上显示红点（处理完自动消失）。当前不在 tab 页时设置会失败，忽略即可
const ME_TAB = 4; // 底部第 5 个（活动、战绩、排行、球拍、我的）
function applyBadge(r) {
  try {
    const n = r && r.isAdmin && r.status === 'active' ? r.pendingApply || 0 : 0;
    if (n > 0) wx.showTabBarRedDot({ index: ME_TAB, fail() {} });
    else wx.hideTabBarRedDot({ index: ME_TAB, fail() {} });
  } catch (e) {}
}

// 启动 / 回到前台时重新校验；不是正式成员就清缓存、去准入页
async function check() {
  try {
    const r = await status();
    if (r.status !== 'active') kickout(r.status);
    return r;
  } catch (e) { return null; } // 网络问题：不处理（云函数仍会拦截所有数据请求）
}

// 当前用户是不是管理员（本机记录，只用于界面显示；最近一次校验成员资格时更新）
function isAdminLocal() { try { return !!wx.getStorageSync('is_admin'); } catch (e) { return false; } }

module.exports = { status, statusCached, check, kickout, clearProtected, isAdminLocal, GATE };
