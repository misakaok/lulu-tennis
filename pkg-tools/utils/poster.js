// 年度网球战报海报绘制（纯本机 Canvas 2D，淡紫网球主题，不上传云端、不走微信转发接口）
const W = 750;
const H = 1220;
const FONT = '"PingFang SC", "Helvetica Neue", sans-serif';

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

function fitText(ctx, text, maxW) {
  const s = String(text || '');
  if (!maxW || ctx.measureText(s).width <= maxW) return s;
  let out = s;
  while (out.length > 1 && ctx.measureText(out + '…').width > maxW) out = out.slice(0, -1);
  return out + '…';
}

function drawRadar(ctx, cx, cy, maxR, style) {
  const axes = (style && style.axes && style.axes.length === 5)
    ? style.axes
    : [
      { l: '局分压制', v: 0 }, { l: '关键分', v: 0 },
      { l: '硬仗韧性', v: 0 }, { l: '稳定发挥', v: 0 }, { l: '出勤活跃', v: 0 },
    ];
  const pt = (idx, ratio) => {
    const ang = (-90 + idx * 72) * Math.PI / 180;
    return [cx + Math.cos(ang) * maxR * ratio, cy + Math.sin(ang) * maxR * ratio];
  };
  // 三层五边形网格
  [1, 0.66, 0.33].forEach((r) => {
    ctx.beginPath();
    for (let i = 0; i < 5; i++) {
      const [x, y] = pt(i, r);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.strokeStyle = '#DFDFEE';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  });
  // 五条辐射轴
  for (let i = 0; i < 5; i++) {
    const [x, y] = pt(i, 1);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(x, y);
    ctx.strokeStyle = '#E8E8F4';
    ctx.lineWidth = 1.2;
    ctx.stroke();
  }
  // 数据多边形
  const unlocked = !!(style && style.unlocked);
  const ratios = unlocked
    ? axes.map((a) => Math.max(0.18, Math.min(1, (Number(a.v) || 0) / 100)))
    : [0.52, 0.52, 0.52, 0.52, 0.52];
  ctx.beginPath();
  ratios.forEach((r, i) => {
    const [x, y] = pt(i, r);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.closePath();
  ctx.fillStyle = unlocked ? 'rgba(132, 132, 182, 0.28)' : 'rgba(163, 163, 203, 0.14)';
  ctx.fill();
  ctx.strokeStyle = unlocked ? '#7272A8' : '#C4C4DC';
  ctx.lineWidth = unlocked ? 3 : 2;
  if (!unlocked && ctx.setLineDash) ctx.setLineDash([6, 5]);
  ctx.stroke();
  if (ctx.setLineDash) ctx.setLineDash([]);
  // 顶点黄绿圆点
  if (unlocked) {
    ratios.forEach((r, i) => {
      const [x, y] = pt(i, r);
      ctx.beginPath();
      ctx.arc(x, y, 5.5, 0, Math.PI * 2);
      ctx.fillStyle = '#C9E33A';
      ctx.fill();
      ctx.strokeStyle = '#587400';
      ctx.lineWidth = 2;
      ctx.stroke();
    });
  }
  // 五个轴文字标签与数值
  const offsets = [
    [0, -118, 'center'],
    [136, -34, 'left'],
    [88, 108, 'center'],
    [-88, 108, 'center'],
    [-136, -34, 'right'],
  ];
  ctx.textBaseline = 'middle';
  axes.forEach((a, i) => {
    const [dx, dy, align] = offsets[i];
    const tx = cx + dx;
    const ty = cy + dy;
    ctx.textAlign = align;
    ctx.fillStyle = '#4F4F7D';
    ctx.font = `bold 22px ${FONT}`;
    ctx.fillText(a.l, tx, ty);
    if (unlocked) {
      ctx.fillStyle = '#6E6EA3';
      ctx.font = `bold 24px ${FONT}`;
      ctx.fillText(String(a.v), tx, ty + 26);
    }
  });
  ctx.textAlign = 'left';
}

function paint(ctx, annual, genDate, avatarImg) {
  const a = annual || {};
  const year = a.year || String(new Date().getFullYear());

  // 整体淡紫雾灰底色
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#E9E9F6');
  bg.addColorStop(0.45, '#F2F2F8');
  bg.addColorStop(1, '#EFEFF7');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // 顶部淡紫战报主卡
  const hx = 36, hy = 36, hw = W - 72, hh = 286;
  roundRect(ctx, hx, hy, hw, hh, 36);
  const hg = ctx.createLinearGradient(hx, hy, hx + hw, hy + hh);
  hg.addColorStop(0, '#A8A8D0');
  hg.addColorStop(1, '#7D7DB2');
  ctx.fillStyle = hg;
  ctx.fill();

  // 极淡球场装饰线（裁切在主卡圆角内）
  ctx.save();
  roundRect(ctx, hx, hy, hw, hh, 36);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
  ctx.lineWidth = 3;
  ctx.strokeRect(hx + 360, hy + 120, 380, 220);
  ctx.beginPath();
  ctx.moveTo(hx + 520, hy + 120);
  ctx.lineTo(hx + 520, hy + 340);
  ctx.stroke();
  ctx.restore();

  // 顶行品牌标识 + 年份
  roundRect(ctx, hx + 32, hy + 28, 152, 42, 21);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `bold 22px ${FONT}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText('LULU 网球', hx + 32 + 76, hy + 49);

  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.font = `bold 24px ${FONT}`;
  ctx.fillText(`${year} 年度球场战报`, hx + hw - 32, hy + 49);

  // 球员头像（有真实头像照片时居中裁圆绘制，否则画首字圆）+ 昵称 + 等级大字
  const avX = hx + 72, avY = hy + 144, avR = 40;
  ctx.beginPath();
  ctx.arc(avX, avY, avR, 0, Math.PI * 2);
  ctx.fillStyle = a.color || '#C9C9E4';
  ctx.fill();
  if (avatarImg && avatarImg.width && avatarImg.height && typeof ctx.drawImage === 'function') {
    const iw = avatarImg.width, ih = avatarImg.height;
    const side = Math.min(iw, ih);
    const sx = (iw - side) / 2, sy = (ih - side) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(avX, avY, avR, 0, Math.PI * 2);
    ctx.clip();
    ctx.drawImage(avatarImg, sx, sy, side, side, avX - avR, avY - avR, avR * 2, avR * 2);
    ctx.restore();
  } else {
    ctx.textAlign = 'center';
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `bold 36px ${FONT}`;
    ctx.fillText(a.initial || '球', avX, avY + 1);
  }
  ctx.beginPath();
  ctx.arc(avX, avY, avR, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.88)';
  ctx.lineWidth = 4;
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `bold 40px ${FONT}`;
  ctx.fillText(fitText(ctx, a.name || 'LULU 球友', 300), hx + 130, hy + 130);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.86)';
  ctx.font = `22px ${FONT}`;
  ctx.fillText(fitText(ctx, a.tier || a.headline || '', 340), hx + 130, hy + 168);

  // 右侧比赛等级大字
  ctx.textAlign = 'right';
  ctx.fillStyle = '#FFFFFF';
  const lvStr = String(a.level || '待定级');
  ctx.font = `bold ${lvStr.length > 3 ? 34 : 62}px ${FONT}`;
  ctx.fillText(lvStr, hx + hw - 32, hy + 136);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.84)';
  ctx.font = `21px ${FONT}`;
  ctx.fillText('比赛等级', hx + hw - 32, hy + 178);

  // 底部球风标签胶囊
  ctx.textAlign = 'left';
  let tagX = hx + 32;
  const tagY = hy + 216;
  const tags = (a.style && a.style.unlocked && a.style.tags && a.style.tags.length)
    ? a.style.tags.slice(0, 3)
    : [a.style ? `正式完赛 ${a.style.played || 0}/${a.style.need || 5} 场解锁球风` : '纯正式战绩自动统计'];
  tags.forEach((t) => {
    ctx.font = `bold 22px ${FONT}`;
    const tw = ctx.measureText(t).width + 36;
    if (tagX + tw > hx + hw - 24) return;
    roundRect(ctx, tagX, tagY, tw, 42, 21);
    ctx.fillStyle = (a.style && a.style.unlocked) ? '#C9E33A' : 'rgba(255, 255, 255, 0.22)';
    ctx.fill();
    ctx.fillStyle = (a.style && a.style.unlocked) ? '#2E3600' : '#FFFFFF';
    ctx.fillText(t, tagX + 18, tagY + 21);
    tagX += tw + 12;
  });

  // 卡片 1：核心 4 项年度数字
  const c1Y = 344, c1H = 148;
  roundRect(ctx, 36, c1Y, hw, c1H, 28);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  const cells = [
    { n: String(a.played || 0), l: '年度场数' },
    { n: a.rate || '—', l: '年度胜率', hi: true },
    { n: String(a.days || 0), l: '出勤天数' },
    { n: String(a.bestStreak || 0), l: '最长连胜' },
  ];
  const cw = hw / 4;
  cells.forEach((c, i) => {
    const cx = 36 + cw * i + cw / 2;
    if (i > 0) {
      ctx.beginPath();
      ctx.moveTo(36 + cw * i, c1Y + 34);
      ctx.lineTo(36 + cw * i, c1Y + c1H - 34);
      ctx.strokeStyle = '#EFEFF6';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = c.hi ? '#587400' : '#2E2E4A';
    ctx.font = `bold 44px ${FONT}`;
    ctx.fillText(c.n, cx, c1Y + 60);
    ctx.fillStyle = '#70708C';
    ctx.font = `22px ${FONT}`;
    ctx.fillText(c.l, cx, c1Y + 108);
  });

  // 卡片 2：五维球风雷达
  const c2Y = 514, c2H = 354;
  roundRect(ctx, 36, c2Y, hw, c2H, 28);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.textAlign = 'left';
  ctx.fillStyle = '#2E2E4A';
  ctx.font = `bold 28px ${FONT}`;
  ctx.fillText('五维球风', 66, c2Y + 46);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#6E6EA3';
  ctx.font = `bold 22px ${FONT}`;
  const stSub = a.style && a.style.unlocked
    ? `按 ${a.style.played} 场完赛计算`
    : `已打 ${(a.style && a.style.played) || 0} / ${(a.style && a.style.need) || 5} 场`;
  ctx.fillText(stSub, W - 66, c2Y + 46);
  drawRadar(ctx, W / 2, c2Y + 206, 94, a.style);

  // 卡片 3：年度亮点 + 可选本人装备摘要
  const c3Y = 890, c3H = 264;
  roundRect(ctx, 36, c3Y, hw, c3H, 28);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.textAlign = 'left';
  ctx.fillStyle = '#2E2E4A';
  ctx.font = `bold 28px ${FONT}`;
  ctx.fillText(`${year} 年度亮点`, 66, c3Y + 46);
  ctx.textAlign = 'right';
  ctx.fillStyle = '#6E6EA3';
  ctx.font = `bold 22px ${FONT}`;
  ctx.fillText(`${a.win || 0}胜 ${a.lose || 0}负`, W - 66, c3Y + 46);

  const tiles = [
    { k: '年度总得局', v: `${a.gamesWon || 0} 局`, s: `失 ${a.gamesLost || 0} 局` },
    { k: '最活跃月份', v: a.bestMonth || '待刷新', s: a.days ? `共出勤 ${a.days} 天` : '今年暂未出勤' },
    { k: '抢七表现', v: a.tbRate || '暂无', s: a.tbSub || '未打到抢七' },
    a.bestMate
      ? { k: '最佳拍档', v: a.bestMate.name, s: `搭档胜率 ${a.bestMate.rate}%` }
      : a.mostOpp
        ? { k: '常打对手', v: a.mostOpp.name, s: `交手 ${a.mostOpp.count} 场 · ${a.mostOpp.win}胜${a.mostOpp.lose}负` }
        : { k: '球场节奏', v: `${a.played || 0} 场`, s: '继续保持手感' },
  ];
  const hasRk = !!(a.racket);
  const tileH = hasRk ? 68 : 82;
  const tileW = (hw - 76) / 2;
  tiles.forEach((t, i) => {
    const col = i % 2, row = Math.floor(i / 2);
    const tx = 66 + col * (tileW + 16);
    const ty = c3Y + 72 + row * (tileH + 12);
    roundRect(ctx, tx, ty, tileW, tileH, 16);
    ctx.fillStyle = '#F7F7FC';
    ctx.fill();
    ctx.textAlign = 'left';
    ctx.fillStyle = '#84849E';
    ctx.font = `20px ${FONT}`;
    ctx.fillText(t.k, tx + 18, ty + 24);
    ctx.fillStyle = '#2E2E4A';
    ctx.font = `bold 25px ${FONT}`;
    ctx.fillText(fitText(ctx, t.v, tileW - 140), tx + 18, ty + tileH - 22);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#6E6EA3';
    ctx.font = `20px ${FONT}`;
    ctx.fillText(fitText(ctx, t.s, 146), tx + tileW - 16, ty + tileH - 22);
  });

  if (hasRk) {
    const ry = c3Y + 234;
    ctx.textAlign = 'left';
    ctx.fillStyle = '#587400';
    ctx.font = `bold 21px ${FONT}`;
    const rkLine = `年度装备 · 穿线 ${a.racket.yearStrings} 次 · 打球 ${a.racket.yearPlayHours} · 养护花费 ${a.racket.spendText}`;
    ctx.fillText(fitText(ctx, rkLine, hw - 60), 66, ry);
  }

  // 底部简洁页脚
  ctx.textAlign = 'center';
  ctx.fillStyle = '#9090AA';
  ctx.font = `21px ${FONT}`;
  ctx.fillText(`LULU 网球 · 正式比赛自动统计${genDate ? ' · ' + genDate : ''}`, W / 2, H - 30);
  ctx.textAlign = 'left';
}

function loadImage(canvas, src) {
  if (!src || !canvas || typeof canvas.createImage !== 'function') return Promise.resolve(null);
  return new Promise((ok) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; clearTimeout(timer); ok(v); } };
    const timer = setTimeout(() => finish(null), 3000);
    try {
      const img = canvas.createImage();
      img.onload = () => finish(img);
      img.onerror = () => finish(null);
      img.src = src;
    } catch (e) { finish(null); }
  });
}

async function loadAvatar(canvas, opt) {
  if (!opt || !canvas || typeof canvas.createImage !== 'function') return null;
  const src = typeof opt === 'string' ? opt : (opt.src || '');
  const fileID = typeof opt === 'object' ? (opt.fileID || '') : '';
  if (src) {
    const img = await loadImage(canvas, src);
    if (img) return img;
    // 部分旧基础库不支持直接用远程 https 链接画布渲染，尝试转本机临时文件
    if (/^https?:\/\//i.test(src) && typeof wx !== 'undefined' && typeof wx.downloadFile === 'function') {
      const tmp = await new Promise((ok) => {
        wx.downloadFile({
          url: src,
          success: (r) => ok(r && r.statusCode === 200 ? r.tempFilePath : ''),
          fail: () => ok(''),
        });
      });
      if (tmp) {
        const img2 = await loadImage(canvas, tmp);
        if (img2) return img2;
      }
    }
  }
  if (fileID && /^cloud:\/\//i.test(fileID) && typeof wx !== 'undefined' && wx.cloud && typeof wx.cloud.downloadFile === 'function') {
    const tmp = await new Promise((ok) => {
      wx.cloud.downloadFile({
        fileID,
        success: (r) => ok((r && r.tempFilePath) || ''),
        fail: () => ok(''),
      });
    });
    if (tmp) return loadImage(canvas, tmp);
  }
  return null;
}

async function render(canvas, annual, genDate, avatarOpt) {
  const avatarImg = await loadAvatar(canvas, avatarOpt);
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  paint(ctx, annual, genDate, avatarImg);
  const r = await new Promise((ok, bad) => wx.canvasToTempFilePath({
    canvas, x: 0, y: 0, width: W, height: H, destWidth: W, destHeight: H,
    fileType: 'jpg', quality: 0.92, success: ok, fail: bad,
  }));
  return r.tempFilePath;
}

module.exports = { W, H, paint, render, loadAvatar };
