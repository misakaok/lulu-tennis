// 微信《用户隐私保护指引》（2026-11-23 用户要求启动时主动提示）：用微信官方弹窗，完整指引在微信公众平台后台配置。
//   冷启动、首个页面显示后查一次 wx.getPrivacySetting：只有 needAuthorization === true（还没同意过）才调 wx.requirePrivacyAuthorize。
//   同一次打开（进程没被销毁）只查一次：从后台切回、再次 onShow 都复用这次的结果，不重复弹；已同意的用户不会弹。
//   拒绝 / 关闭：照常使用不需要授权的功能；以后用户主动拍照、选照片、地图选点、复制时，微信会按原有流程再弹官方窗口，
//   这次没同意就停止这次操作（isDenied 判断，调用处静默停止并轻提示）。不注册 wx.onNeedPrivacyAuthorization（用微信官方弹窗，不自己画）。
//   旧版微信没有这两个接口、或查询失败：直接跳过，启动流程照常。
//   和「公开展示授权」（utils/consent.js，players.shown）是两回事：同意隐私指引不会改 shown；两个都要弹时先处理隐私指引（consent 等 ready()）。
//   朋友圈单页模式（utils/timeline.js）：app.js 不调用这里，沿用原来的启动逻辑。

const WAIT_PAGE_MS = 5000; // 等首个页面出现最多等多久（官方弹窗要在页面上显示）
const AFTER_PAGE_MS = 300; // 页面出现后再等一下，等它渲染出来

let task = null;

function call(fn, opt) {
  return new Promise((resolve) => {
    try { fn(Object.assign({}, opt, { success: (r) => resolve({ ok: true, r }), fail: (e) => resolve({ ok: false, e }) })); }
    catch (e) { resolve({ ok: false, e }); }
  });
}

// 等到首个页面已经显示（getCurrentPages 有页面），超时也继续（让微信自己处理）
function waitPage() {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
      if (pages && pages.length) { setTimeout(resolve, AFTER_PAGE_MS); return; }
      if (Date.now() - t0 >= WAIT_PAGE_MS) { resolve(); return; }
      setTimeout(tick, 100);
    };
    tick();
  });
}

/**
 * 结果：'agreed'（已同意，或这次点了同意）/ 'denied'（拒绝或关闭）/ 'unsupported'（旧版微信没有接口）/ 'error'（查询失败）
 */
async function run() {
  if (typeof wx.getPrivacySetting !== 'function' || typeof wx.requirePrivacyAuthorize !== 'function') return 'unsupported';
  const s = await call(wx.getPrivacySetting);
  if (!s.ok || !s.r) return 'error';
  if (s.r.needAuthorization !== true) return 'agreed';
  await waitPage();
  const a = await call(wx.requirePrivacyAuthorize);
  return a.ok ? 'agreed' : 'denied';
}

// 启动时调用（app.js onShow）：同一次打开只执行一次，之后返回同一个结果
function ensure() {
  if (!task) task = run().catch(() => 'error');
  return task;
}
// 等隐私指引处理完（公开展示授权弹窗之前用）；没有启动过检查（比如测试、朋友圈单页）就不等
function ready() { return task || Promise.resolve('skipped'); }

// 接口失败是不是因为用户没同意隐私指引（官方弹窗里拒绝 / 关闭）：errno 104
const isDenied = (e) => !!e && (e.errno === 104 || /privacy permission is not authorized/i.test(e.errMsg || ''));
// 后台指引里没声明这项（真机才会拦）：errno 112
const isUndeclared = (e) => !!e && (e.errno === 112 || /not declared in the privacy/i.test(e.errMsg || ''));
// 没同意就停止这次操作：只轻提示一下，不弹窗、不报错
function stopped() {
  try { wx.showToast({ title: '未同意隐私保护指引，已停止这次操作', icon: 'none' }); } catch (e) {}
}

// 复制（剪切板也属于隐私接口）失败：没同意隐私指引就停止，其他原因轻提示
function copyFail(e) {
  if (isDenied(e)) { stopped(); return; }
  try { wx.showToast({ title: '没有复制成功，请重试', icon: 'none' }); } catch (x) {}
}

module.exports = { ensure, ready, isDenied, isUndeclared, stopped, copyFail, WAIT_PAGE_MS };
