// 云开发环境 ID：只有一个环境时可以留空（自动使用默认环境）
// 有多个环境时，填控制台「设置」里的环境 ID，例如 'tennis-7g8xxxx'
const ENV_ID = '';

App({
  globalData: { envId: ENV_ID },
  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
      return;
    }
    wx.cloud.init(ENV_ID ? { env: ENV_ID, traceUser: true } : { traceUser: true });
  },
  // 启动和每次回到前台都重新校验成员资格；不是正式成员就清缓存、去「仅限内部球友使用」页
  onShow() {
    require('./utils/member').check();
  },
});
