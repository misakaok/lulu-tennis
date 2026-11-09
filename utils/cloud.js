// 调用云函数 tennis（赛果确认、互评、联系人等需要服务端校验的操作）
const NAME = 'tennis';

async function call(action, data) {
  let r;
  try {
    r = await wx.cloud.callFunction({ name: NAME, data: Object.assign({ action }, data || {}) });
  } catch (e) {
    const msg = String((e && (e.errMsg || e.message)) || e);
    if (/FUNCTION_NOT_FOUND|FunctionName|not found|-501000|-504002/i.test(msg)) {
      throw new Error('云函数 tennis 还没有部署：请在开发者工具里右键 cloudfunctions/tennis →「上传并部署：云端安装依赖」');
    }
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
  getContact: 1, getBios: 1, avatarUrls: 1, drawRequests: 1, listEventPhotos: 1, eventPhotoCount: 1, listMembers: 1, auditSignups: 1, dataset: 1, notifyTemplates: 1,
};
const GW_WRITE_OPS = { add: 1, update: 1, remove: 1 };
function invalidateAfter(action, data) {
  const memo = require('./memo');
  if (action === 'data') { if (data && GW_WRITE_OPS[data.op]) memo.invalidate([data.coll]); return; }
  if (!READ_ONLY[action]) memo.invalidate();
}

module.exports = { call };
