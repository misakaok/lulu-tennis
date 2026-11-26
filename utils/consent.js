// 公开展示授权（2026-11-20 审核要求：向其他成员展示昵称、照片前要让本人知情并授权）
//   同意：昵称和照片在排行榜、LULU 积分榜和各站积分明细、战绩、活动名单、球员主页展示给本小程序的其他成员
//   不同意：照片只有自己能看到（服务端不下发），排行榜里不显示；LULU 积分榜、各站积分明细（含双打搭档）里名字显示「球友」（服务端 cupMask 不下发用户 ID）；参加活动、录分时报名名单、对阵表、比分记录里仍显示昵称
//   第一次设置资料时在资料页勾选（不强制，不同意也能保存资料、报名、录分）；老成员还没选的，启动后弹窗问一次（memberStatus 带回 shown: null）；
//   之后在「编辑资料」里随时开关。授权状态只存在云端（players.shown），经云函数 saveProfile / setShown 写入
//   说明分版本（players.shownVer，2026-11-26）：第 2 版加了「保存的对阵图、复制的排班文字可能被转发到小程序以外」。
//   只有同意第 2 版的人，名字和照片才进存出去的图和文字（pkg-tools/utils/mask.js）；同意过第 1 版的老成员小程序里照常展示，启动时问一次新版
const TITLE = '公开展示授权';
const VER = 2; // 下面这段说明的版本：给用户看的说明改了内容就加一，云端 SHOWN_VER 一起改
const TEXT = '同意后，你的昵称和照片会在排行榜、LULU 积分榜和各站积分明细、战绩、活动报名名单和球员主页中展示给本小程序的其他成员；'
  + '成员保存到相册的活动对阵图、战果图里也会有你的昵称和照片，复制出去的排班文字里也会有你的昵称，这些可能被转发到小程序以外（比如微信群）。\n'
  + '不同意：你的照片只有自己能看到，排行榜里不显示你，LULU 积分榜和各站积分明细（含双打搭档）里你的名字显示为「球友」，保存出去的对阵图和复制的文字里也显示为「球友」；参加活动、录入比分时，其他成员仍会在小程序里的报名名单、对阵表、比赛记录和比赛统计里看到你的昵称。\n'
  + '可以随时在「我的 → 编辑资料」里更改。';
const SKIP_KEY = 'consent_v2_skip'; // 老成员在「说明更新」弹窗点了「暂不」：之后不再自动问（资料页还能点进来确认）

// 这份资料同意的是不是最新版说明（存出去的图和文字只认最新版）
const latest = (p) => !!p && p.shown === true && (p.shownVer || 1) >= VER;

// 弹窗询问，结果写到云端。返回 true / false；网络出错返回 null（下次再问）
function ask(opt) {
  const o = opt || {};
  return new Promise((done) => wx.showModal({
    title: o.title || TITLE, content: o.content || TEXT, confirmText: '同意', cancelText: o.cancelText || '不同意',
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

// 启动 / 回到前台校验成员资格后调用（本次打开只问一次）：
//   已设置资料、还没选过的老成员问是否同意；同意过旧版说明的问一次新版（「同意 / 暂不」，暂不什么都不改、之后不再自动问）
let asked = false;
function skipped() { try { return !!wx.getStorageSync(SKIP_KEY); } catch (e) { return false; } }
function checkOnLaunch(status) {
  if (asked || !status || status.status !== 'active' || !status.hasProfile) return;
  const update = status.shown === true && (status.shownVer || 1) < VER;
  if (status.shown !== null && !(update && !skipped())) return;
  const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
  const cur = pages.length ? pages[pages.length - 1].route : '';
  if (cur === 'pkg-manage/profile/profile' || cur === 'pages/gate/gate') return; // 资料页上有勾选项，不重复问
  asked = true;
  // 启动时微信隐私指引也要弹：先等它处理完（同意 / 拒绝都行），两个弹窗不叠在一起；隐私指引不会改 players.shown
  require('./privacy').ready().then(() => {
    const ps = typeof getCurrentPages === 'function' ? getCurrentPages() : [];
    const now = ps.length ? ps[ps.length - 1].route : '';
    if (now === 'pkg-manage/profile/profile' || now === 'pages/gate/gate') { asked = false; return; } // 等待期间进了资料页：那里有勾选项
    if (!update) { ask(); return; }
    ask({ title: '公开展示说明更新', cancelText: '暂不', keepOnCancel: true }).then((yes) => {
      if (yes === false) { try { wx.setStorageSync(SKIP_KEY, 1); } catch (e) {} }
    });
  });
}

module.exports = { TITLE, TEXT, VER, latest, ask, checkOnLaunch };
