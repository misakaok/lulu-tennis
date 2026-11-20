// 公开展示授权（2026-11-20 审核要求：向其他成员展示昵称、照片前要让本人知情并授权）
//   同意：昵称和照片在排行榜、战绩、活动名单、球员主页展示给本小程序的其他成员
//   不同意：照片只有自己能看到（服务端不下发），排行榜里不显示；参加活动、录分时报名名单、对阵表、比分记录里仍显示昵称
//   第一次设置资料时在资料页勾选（不强制，不同意也能保存资料、报名、录分）；老成员还没选的，启动后弹窗问一次（memberStatus 带回 shown: null）；
//   之后在「编辑资料」里随时开关。授权状态只存在云端（players.shown），经云函数 saveProfile / setShown 写入
const TITLE = '公开展示授权';
const TEXT = '同意后，你的昵称和照片会在排行榜、战绩、活动报名名单和球员主页中展示给本小程序的其他成员。\n'
  + '不同意：你的照片只有自己能看到，排行榜里不显示你；参加活动、录入比分时，其他成员仍会在报名名单、对阵表、比赛记录和比赛统计里看到你的昵称。\n'
  + '可以随时在「我的 → 编辑资料」里更改。';

// 弹窗询问，结果写到云端。返回 true / false；网络出错返回 null（下次再问）
function ask(opt) {
  const o = opt || {};
  return new Promise((done) => wx.showModal({
    title: TITLE, content: o.content || TEXT, confirmText: '同意', cancelText: o.cancelText || '不同意',
    success: (x) => done(x.confirm), fail: () => done(null),
  })).then(async (yes) => {
    if (yes === null) return null;
    if (!yes && o.keepOnCancel) return false; // 只是点了「暂不」：不改云端的状态
    try {
      await require('./db').setShown(yes);
      require('./db').fetchPlayersFull().catch(() => {}); // 刷新照片名单和排行
      if (!yes) wx.showToast({ title: '可在编辑资料里随时开启', icon: 'none' });
      return yes;
    } catch (e) {
      wx.showToast({ title: (e && e.message) || '没有保存成功，请稍后再试', icon: 'none' });
      return null;
    }
  });
}

// 启动 / 回到前台校验成员资格后调用：已设置资料、还没选过的老成员问一次（本次打开只问一次）
let asked = false;
function checkOnLaunch(status) {
  if (asked || !status || status.status !== 'active' || !status.hasProfile || status.shown !== null) return;
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
  const cur = pages.length ? pages[pages.length - 1].route : '';
  if (cur === 'pages/profile/profile' || cur === 'pages/gate/gate') return; // 资料页上有勾选项，不重复问
  asked = true;
  ask();
}

module.exports = { TITLE, TEXT, ask, checkOnLaunch };
