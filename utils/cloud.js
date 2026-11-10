// 调用云函数 tennis（赛果确认、互评、联系人等需要服务端校验的操作）
const NAME = 'tennis';

async function call(action, data) {
  let r;
  try {
    r = await wx.cloud.callFunction({ name: NAME, data: Object.assign({ action }, data || {}) });
  } catch (e) {
    const msg = String((e && (e.errMsg || e.message)) || e);
    if (/FUNCTION_NOT_FOUND|FunctionName|not found|-501000|-504002/i.test(msg)) {
      // 给开发者看的原因只打在控制台，用户只看到通用提示
      console.error('云函数 tennis 还没有部署：请在开发者工具里右键 cloudfunctions/tennis →「上传并部署：云端安装依赖」', msg);
      throw new Error('服务暂时不可用，请稍后再试');
    }
    console.error('[云函数调用失败]', action, msg);
    throw new Error('网络异常，请稍后再试');
  }
  const res = (r && r.result) || {};
  if (res.code === 'NOT_MEMBER') { require('./member').kickout(res.status); throw new Error(res.error || '仅限内部球友使用'); }
  if (!res.ok) throw new Error(res.error || '操作失败');
  invalidateAfter(action, data);
  return res;
}

// 写操作成功后作废前端内存缓存（utils/memo.js），保证自己刚改的数据马上能看到。
// 只读操作不作废；未列出的操作一律当作写操作（宁可多拉一次，也不显示旧数据）
const READ_ONLY = {
  memberStatus: 1, ping: 1, matchState: 1, pendingReviews: 1, reviewSummary: 1, reviewableWith: 1, myTodos: 1,
  getContact: 1, getBios: 1, avatarUrls: 1, drawRequests: 1, listEventPhotos: 1, eventPhotoCount: 1, listMembers: 1, auditSignups: 1, dataset: 1, drawDetail: 1, mySignups: 1, followInfo: 1,
};
const GW_WRITE_OPS = { add: 1, update: 1, remove: 1 };
function invalidateAfter(action, data) {
  const memo = require('./memo');
  if (action === 'data') { if (data && GW_WRITE_OPS[data.op]) memo.invalidate([data.coll]); return; }
  if (!READ_ONLY[action]) memo.invalidate();
}

// 只读操作的结果在内存里缓存 60 秒（utils/memo.js）：切换 tab、从子页面返回时不重复调用。
// 自己的任何写操作、下拉刷新都会作废；别人的操作最长晚 60 秒看到。只能用于 READ_ONLY 里的操作
function cached(action, data) {
  if (!READ_ONLY[action]) throw new Error('只有只读操作可以缓存：' + action);
  const memo = require('./memo');
  return memo.get('call:' + action + ':' + JSON.stringify(data || {}), memo.ANY, () => call(action, data));
}

module.exports = { call, cached };
