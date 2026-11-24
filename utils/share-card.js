// 活动分享卡片封面：在页面上隐藏的 2d 画布里画「日期 + 报名人数」，导出临时图片给 onShareAppMessage 用。
// 只画日期、时间和人数这些固定格式的内容，不画活动名称、昵称（名称已经在卡片标题里）。
// 画不出来（基础库太旧、画布取不到）时，调用方退回固定封面 FALLBACK。
const FALLBACK = '/images/share.jpg'; // 固定封面：底图 + 「LULU 网球」（邀请、准入页分享，以及画布画不出来时）
const BG = '/images/share-bg.jpg'; // 画布底图：俯拍淡紫球场，右上一个网球、一条白线（2026-11-22 界面配图）
const W = 1000, H = 800; // 5:4，微信分享卡片的比例
const WEEK = '日一二三四五六';

// 卡片上要画的内容（纯函数，方便测试）。counts：报名中 { people, cap, wait }，其他状态 { entrants, unit }
function cardInfo(d, counts) {
  let date = '时间待定', sub = '';
  if (d && /^\d{4}-\d{1,2}-\d{1,2}$/.test(d.date || '')) {
    const [y, m, dd] = d.date.split('-').map(Number);
    date = `${m}月${dd}日`;
    sub = '周' + WEEK[new Date(y, m - 1, dd).getDay()];
  }
  if (d && /^\d{1,2}:\d{2}$/.test(d.startTime || '')) sub += (sub ? ' ' : '') + d.startTime;
  const c = counts || {};
  if (d && d.status === 'signup') {
    const people = c.people || 0, wait = c.wait || 0;
    return {
      date, sub, tag: '报名中', label: '已报名',
      num: String(people - wait), unit: c.cap ? `/ ${c.cap} 人` : '人',
      extra: wait ? `候补 ${wait} 人` : '',
    };
  }
  return { date, sub, tag: '', label: '参加', num: String(c.entrants || 0), unit: c.unit || '人', extra: '' };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function ball(ctx, cx, cy, r) {
  ctx.fillStyle = '#C9E33A';
  ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.92)';
  ctx.lineWidth = Math.max(2, r * 0.09);
  ctx.beginPath(); ctx.arc(cx - r * 0.95, cy, r * 0.88, -0.95, 0.95); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx + r * 0.95, cy, r * 0.88, Math.PI - 0.95, Math.PI + 0.95); ctx.stroke();
}

const FONT = '"PingFang SC", "Helvetica Neue", sans-serif';

// bg：加载好的底图（画布 createImage）；没有就画原来的淡紫渐变 + 小球
function paint(ctx, info, bg) {
  if (bg) {
    ctx.drawImage(bg, 0, 0, W, H); // 底图里已经有网球（右侧中间偏上），左上不再画小球
  } else {
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#A3A3CB'); g.addColorStop(1, '#8484B6');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 6;
    ctx.strokeRect(40, 40, W - 80, H - 80);
    ctx.beginPath(); ctx.moveTo(W / 2, 40); ctx.lineTo(W / 2, H - 40); ctx.stroke();
    ball(ctx, 112, 118, 30);
  }
  ctx.textBaseline = 'alphabetic';

  // 左上：名字
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `bold 40px ${FONT}`;
  ctx.fillText('LULU 网球', bg ? 80 : 160, 133);

  // 右上：报名中标签（正向状态用黄绿）
  if (info.tag) {
    ctx.font = `bold 36px ${FONT}`;
    const tw = ctx.measureText(info.tag).width + 56;
    roundRect(ctx, W - 80 - tw, 88, tw, 64, 32);
    ctx.fillStyle = '#C9E33A'; ctx.fill();
    ctx.fillStyle = '#2E3600';
    ctx.fillText(info.tag, W - 80 - tw + 28, 133);
  }

  // 中间：日期大字 + 星期、时间
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `bold ${info.date.length > 6 ? 120 : 150}px ${FONT}`;
  ctx.fillText(info.date, 80, 360);
  if (info.sub) {
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.font = `48px ${FONT}`;
    ctx.fillText(info.sub, 86, 440);
  }

  // 底部白色计分板：已报名 8 / 16 人
  roundRect(ctx, 80, 520, W - 160, 200, 36);
  ctx.fillStyle = '#FFFFFF'; ctx.fill();
  let x = 130;
  ctx.fillStyle = '#6E6EA3';
  ctx.font = `bold 44px ${FONT}`;
  ctx.fillText(info.label, x, 645);
  x += ctx.measureText(info.label).width + 28;
  ctx.fillStyle = '#3A3A5C';
  ctx.font = `bold 120px ${FONT}`;
  ctx.fillText(info.num, x, 668);
  x += ctx.measureText(info.num).width + 20;
  ctx.fillStyle = '#6E6EA3';
  ctx.font = `bold 48px ${FONT}`;
  ctx.fillText(info.unit, x, 645);
  if (info.extra) {
    ctx.font = `36px ${FONT}`;
    ctx.fillStyle = '#8E8EB0';
    const ew = ctx.measureText(info.extra).width;
    ctx.fillText(info.extra, W - 130 - ew, 643);
  }
}

// 底图加载不出来（基础库太旧、超时）就返回 null，照旧画渐变
function loadBg(canvas) {
  if (!canvas || typeof canvas.createImage !== 'function') return Promise.resolve(null);
  return new Promise((ok) => {
    const img = canvas.createImage();
    const timer = setTimeout(() => ok(null), 1500);
    img.onload = () => { clearTimeout(timer); ok(img); };
    img.onerror = () => { clearTimeout(timer); ok(null); };
    img.src = BG;
  });
}

// canvas：页面上 <canvas type="2d"> 的节点。返回临时图片路径
async function render(canvas, info) {
  const bg = await loadBg(canvas);
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  paint(ctx, info, bg);
  const r = await new Promise((ok, bad) => wx.canvasToTempFilePath({
    canvas, x: 0, y: 0, width: W, height: H, destWidth: W, destHeight: H, fileType: 'jpg', quality: 0.9, success: ok, fail: bad, // JPG 比 PNG 导出快、文件小一半
  }));
  return r.tempFilePath;
}

module.exports = { FALLBACK, BG, W, H, cardInfo, paint, render, loadBg };
