// 我的球拍的数据读写（球拍档案、穿线 / 维护记录，只有本人可见）：一律经云函数，身份由云端 OPENID 决定。
// 读取在内存里缓存 60 秒（cloud.cached）；保存、删除都是写操作，成功后自动作废缓存（utils/cloud.js）。
// 列表页「先显示、后更正」（2026-11-25 用户要求，打开不再等「正在读取…」）：每次读到云端结果，本机存一份上次的
//   { uid, rackets, logs }（KEY），只认同一账号；打开时先用它画，云端读完再更正。退出成员身份时随 clearProtected 清掉
//   （不在 KEEP 里）。只给列表页先显示用，详情、编辑、删除照旧读云端。
const cloud = require('./cloud');
const memo = require('./memo');

const KEY = 'cache_rackets';
const myId = () => { try { return wx.getStorageSync('my_openid') || ''; } catch (e) { return ''; } };
let savedJson = ''; // 上次写进本机的内容：没变就不再写
function keep(r, since) {
  const uid = myId();
  if (!uid || since !== memo.epoch()) return; // 不知道是谁，或读的期间有过作废（写操作、清除受保护缓存）：不写
  const data = { uid, rackets: r.rackets, logs: r.logs };
  const json = JSON.stringify(data);
  if (json === savedJson) return;
  savedJson = json;
  const drop = () => { savedJson = ''; try { wx.removeStorageSync(KEY); } catch (e) {} };
  try {
    if (typeof wx.setStorage === 'function') wx.setStorage({ key: KEY, data, success: () => { if (since !== memo.epoch()) drop(); }, fail: () => { savedJson = ''; } });
    else wx.setStorageSync(KEY, data);
  } catch (e) { savedJson = ''; }
}
// 先显示用（同步）：60 秒内读过的内存结果最新，先用它；没有就用本机存的上次结果（只认同一账号）；都没有返回 null
function cachedList() {
  const v = cloud.peek('racketList');
  if (v) return { rackets: v.rackets || [], logs: v.logs || [] };
  try {
    const c = wx.getStorageSync(KEY);
    const uid = myId();
    if (uid && c && c.uid === uid && Array.isArray(c.rackets) && Array.isArray(c.logs)) return { rackets: c.rackets, logs: c.logs };
  } catch (e) {}
  return null;
}
// 编辑页先填表单用（同步）：只认 60 秒内存里刚读过的（球拍详情刚读过，cloud.peek；任何写操作都会作废），
// 不读本机存的上次结果（可能是旧的，不拿旧数据填表单）；没有返回 null，页面照旧等 load()
function peekList() {
  const v = cloud.peek ? cloud.peek('racketList') : undefined;
  return v ? { rackets: v.rackets || [], logs: v.logs || [] } : null;
}

// 云函数还是旧版本（没有这些操作）时返回「未知操作」：换成用户看得懂的提示
const friendly = (e) => { throw /未知操作/.test((e && e.message) || '') ? new Error('这个功能正在更新，请稍后再试') : e; };
function load() {
  const since = memo.epoch();
  return cloud.cached('racketList').then((r) => {
    const out = { rackets: r.rackets || [], logs: r.logs || [] };
    keep(out, since);
    return out;
  }, friendly);
}
const saveRacket = (id, racket) => cloud.call('racketSave', { id: id || '', racket }).then((r) => r.id);
const removeRacket = (id) => cloud.call('racketRemove', { id });
const saveLog = (id, racketId, log) => cloud.call('racketLogSave', { id: id || '', racketId, log }).then((r) => r.id);
const removeLog = (id) => cloud.call('racketLogRemove', { id });
// 清除全部：本机那份也马上删掉（云端读完之前不再显示已清除的球拍）
const clear = () => cloud.call('racketClear', { confirm: true }).then((r) => { savedJson = ''; try { wx.removeStorageSync(KEY); } catch (e) {} return r; });

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

module.exports = { load, cachedList, peekList, KEY, saveRacket, removeRacket, saveLog, removeLog, clear, applyBadge, refreshBadge, RACKET_TAB };
