// 上传前压缩：保持比例（不裁不拉伸），不放大，已经够小的不重复压缩；失败就报错，绝不悄悄上传原图
//   活动照片：长边 ≤ 1920px，目标约 500KB；球员照片（已裁成正方形）：≤ 800px，目标约 200KB
//   清晰度优先：质量最低到 60，达不到体积目标也不再往下压
// wx.compressImage 由系统处理照片方向（EXIF），只传一个边长，另一边按比例算，不会变形
const PRESET = { event: { maxEdge: 1920, target: 500 * 1024 }, avatar: { maxEdge: 800, target: 200 * 1024 } };
const p = (fn, o) => new Promise((resolve, reject) => fn(Object.assign({}, o, { success: resolve, fail: reject })));
const sizeOf = (filePath) => p(wx.getFileSystemManager().getFileInfo.bind(wx.getFileSystemManager()), { filePath }).then((r) => r.size);
const ROTATED = { left: 1, right: 1, 'left-mirrored': 1, 'right-mirrored': 1 };

async function compress(src, kind) {
  const { maxEdge, target } = PRESET[kind] || PRESET.event;
  const info = await p(wx.getImageInfo, { src });
  const rot = ROTATED[info.orientation];
  const w = rot ? info.height : info.width, h = rot ? info.width : info.height; // 显示方向的宽高
  const size = await sizeOf(info.path || src);
  if (Math.max(w, h) <= maxEdge && size <= target * 1.2) return { path: src, width: w, height: h, size, skipped: true };
  if (!wx.compressImage) throw new Error('当前微信版本不支持压缩照片，请升级微信后重试');
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  let quality = 80, out = null;
  for (let i = 0; i < 3; i++) {
    const opt = { src, quality };
    if (scale < 1) opt.compressedWidth = Math.round(w * scale);
    const r = await p(wx.compressImage, opt);
    const oi = await p(wx.getImageInfo, { src: r.tempFilePath });
    // 万一系统按原始方向理解了宽度：再按另一边压一次，保证长边不超标
    if (Math.max(oi.width, oi.height) > maxEdge * 1.05) {
      const r2 = await p(wx.compressImage, { src, quality, compressHeight: Math.round(h * scale) });
      r.tempFilePath = r2.tempFilePath;
    }
    out = { path: r.tempFilePath, size: await sizeOf(r.tempFilePath), quality };
    if (out.size <= target * 1.3 || quality <= 60) break;
    quality -= 10;
  }
  if (!out) throw new Error('压缩失败');
  return out;
}

module.exports = { compress, PRESET };
