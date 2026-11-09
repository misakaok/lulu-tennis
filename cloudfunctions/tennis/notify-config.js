// 订阅消息模板配置（微信公众平台 → 功能 → 订阅消息 → 公共模板库 选模板后，把模板 ID 和字段名填在这里）
//
// id 留空 = 不发这类通知（小程序端也不会弹出订阅请求）。改完要重新部署云函数 tennis。
// fields：左边是程序里的含义（不要改），右边是你选的模板里对应的字段名（如 thing1、time2，在模板详情里能看到）。
//   用不到的含义可以删掉；模板里有、这里没有的字段不会填（模板要求必填的字段一定要对上，否则发送失败）。
//   字段类型决定长度限制，程序会自动截断：thing 20 字、name 10 字、phrase 5 字、character_string 32 位。
//
// 推荐的模板（在公共模板库里搜索标题）：
//   confirm 「比赛结果通知」或「待确认提醒」：对方录了比分，提醒你确认
//   request 「审核提醒」或「申请待处理提醒」：有人提交了改分 / 退赛 / 成员申请，提醒处理人
//   result  「审核结果通知」或「申请结果通知」：你的申请被处理了
module.exports = {
  // 点通知打开小程序的哪个版本：'formal' 正式版 / 'trial' 体验版 / 'developer' 开发版
  // 现在大家用的是体验版，所以是 trial；正式发布后改成 formal
  state: 'trial',
  templates: {
    confirm: {
      id: '',
      fields: { title: 'thing1', score: 'character_string2', opponent: 'thing3', time: 'time4' },
    },
    request: {
      id: '',
      fields: { type: 'thing1', applicant: 'thing2', reason: 'thing3', time: 'time4' },
    },
    result: {
      id: '',
      fields: { type: 'thing1', result: 'phrase2', note: 'thing3', time: 'time4' },
    },
  },
};
