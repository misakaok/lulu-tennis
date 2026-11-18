// 我的球拍的数据读写（球拍档案、穿线 / 维护记录，只有本人可见）：一律经云函数，身份由云端 OPENID 决定。
// 读取在内存里缓存 60 秒（cloud.cached）；保存、删除都是写操作，成功后自动作废缓存（utils/cloud.js）。不写本机存储。
const cloud = require('./cloud');

// 云函数还是旧版本（没有这些操作）时返回「未知操作」：换成用户看得懂的提示
const friendly = (e) => { throw /未知操作/.test((e && e.message) || '') ? new Error('这个功能正在更新，请稍后再试') : e; };
const load = () => cloud.cached('racketList').then((r) => ({ rackets: r.rackets || [], logs: r.logs || [] }), friendly);
const saveRacket = (id, racket) => cloud.call('racketSave', { id: id || '', racket }).then((r) => r.id);
const removeRacket = (id) => cloud.call('racketRemove', { id });
const saveLog = (id, racketId, log) => cloud.call('racketLogSave', { id: id || '', racketId, log }).then((r) => r.id);
const removeLog = (id) => cloud.call('racketLogRemove', { id });
const clear = () => cloud.call('racketClear', { confirm: true });

// 底部「球拍」tab 上的数字：穿线 / 维护到期或 7 天内到期的项数（小程序内提醒）。
// 当前页面不是 tab 页时设置会失败，忽略即可（回到 tab 页时会再设）；读取失败（如云函数还是旧版本）不显示
const RACKET_TAB = 3;
const pad = (n) => (n < 10 ? '0' + n : '' + n);
function applyBadge(rackets, logs) {
  const d = new Date();
  const n = require('./racket').overview(rackets, logs, `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`).due;
  try {
    if (n > 0) wx.setTabBarBadge({ index: RACKET_TAB, text: n > 99 ? '99+' : String(n), fail() {} });
    else wx.removeTabBarBadge({ index: RACKET_TAB, fail() {} });
  } catch (e) {}
  return n;
}
const refreshBadge = () => load().then(({ rackets, logs }) => applyBadge(rackets, logs)).catch(() => 0);

module.exports = { load, saveRacket, removeRacket, saveLog, removeLog, clear, applyBadge, refreshBadge, RACKET_TAB };
