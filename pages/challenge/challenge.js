// 兼容旧挑战链接：功能已停用，不读取链接参数或球员资料。
Page({ data: {}, onLoad() { wx.hideShareMenu(); }, goHome() { wx.switchTab({ url: '/pages/rank/rank' }); } });
