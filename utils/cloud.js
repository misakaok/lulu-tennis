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
  return res;
}

module.exports = { call };
