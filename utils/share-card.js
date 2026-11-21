// 活动分享卡片封面：在页面上隐藏的 2d 画布里画「日期 + 报名人数」，导出临时图片给 onShareAppMessage 用。
// 只画日期、时间和人数这些固定格式的内容，不画活动名称、昵称（名称已经在卡片标题里）。
// 画不出来（基础库太旧、画布取不到）时，调用方退回固定封面 FALLBACK。
const FALLBACK = '/images/share.png';
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

function paint(ctx, info) {
  // 背景：淡紫渐变 + 很淡的球场线
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#A3A3CB'); g.addColorStop(1, '#8484B6');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 6;
  ctx.strokeRect(40, 40, W - 80, H - 80);
  ctx.beginPath(); ctx.moveTo(W / 2, 40); ctx.lineTo(W / 2, H - 40); ctx.stroke();
  ctx.textBaseline = 'alphabetic';

  // 左上：小球 + 名字
  ball(ctx, 112, 118, 30);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `bold 40px ${FONT}`;
  ctx.fillText('LULU网球', 160, 133);

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

// canvas：页面上 <canvas type="2d"> 的节点。返回临时图片路径
async function render(canvas, info) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  paint(ctx, info);
  const r = await new Promise((ok, bad) => wx.canvasToTempFilePath({
    canvas, x: 0, y: 0, width: W, height: H, destWidth: W, destHeight: H, fileType: 'png', success: ok, fail: bad,
  }));
  return r.tempFilePath;
}

module.exports = { FALLBACK, W, H, cardInfo, paint, render };
