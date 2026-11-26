// 活动高清对阵 / 战果长图绘制（纯本机 Canvas 2D，淡紫 × 网球黄绿 × TNNS Live 逐盘比分条风格，不上传云端）
//   支持全部 4 种活动形式：单淘汰（bracket）、分组循环（groups）、循环＋淘汰（groups_ko）、四人轮换双打（rotation）。
const E = require('../../utils/event');
const C = require('../../utils/cup');
const { colorOf, initialOf } = require('../../utils/rules');

const W = 750;
const PAD = 36;
const CARD_W = W - PAD * 2; // 678
const FONT = '"PingFang SC", "Helvetica Neue", sans-serif';
const NUM_FONT = '"DIN Alternate", "Avenir Next Condensed", "PingFang SC", sans-serif';

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

function setColsOf(sets, side) {
  const opp = side === 'a' ? 'b' : 'a';
  const tbKey = side === 'a' ? 'tbA' : 'tbB';
  return (sets || []).map((s) => {
    const v = Number(s[side]), o = Number(s[opp]), tb = s[tbKey];
    return {
      v: Number.isFinite(v) ? String(v) : '',
      w: Number.isFinite(v) && Number.isFinite(o) && v > o,
      tb: tb !== undefined && tb !== null && tb !== '' ? String(tb) : '',
    };
  });
}

function formatWhen(d) {
  const day = E.dayText(d.date || '');
  return [day || d.date || '', d.startTime || ''].filter(Boolean).join(' ');
}

function formatPlace(d) {
  const parts = [];
  if (d.place && d.place.name) parts.push(d.place.name);
  else if (d.place && d.place.address) parts.push(d.place.address);
  if (d.venue) parts.push(d.venue);
  return parts.join(' · ');
}

// 整理绘图模型（纯数据，便于计算精准画布总高度和单测校验）
function buildModel(draw, matches, opts) {
  const d = draw || {};
  const ms = matches || [];
  const o = opts || {};
  const compact = !!o.compact;
  const cfg = E.cfgOf(d);
  const isDouble = cfg.type === 'double';
  const isRot = E.isRotation(d);
  const progress = E.progressOf(d, ms);
  const ended = !!d.endedAt;
  const allDone = progress.total > 0 && (!!progress.champion || progress.done === progress.total);

  const slotsMap = Object.create(null);
  E.scheduleOf(d, ms).forEach((item) => {
    if (item && item.key && item.slotText) slotsMap[item.key] = item.slotText;
  });

  const modeLbl = E.MODES[d.mode] || E.MODES.bracket;
  const catLbl = E.categoryText(d);
  const entCnt = (d.entrants || []).length;
  const unit = isDouble && !isRot ? '队' : '人';
  const when = formatWhen(d);
  const place = formatPlace(d);
  const rulesSum = E.rulesSummary(d);
  const ruleLine = rulesSum.length ? rulesSum[0].text : '';

  const tags = [];
  const cupTag = C.drawCupText(d);
  if (cupTag) tags.push({ text: cupTag, solid: true });
  if (ruleLine) tags.push({ text: ruleLine, solid: false });
  const lv = E.levelRangeText(d);
  if (lv) tags.push({ text: `建议 ${lv}`, solid: false });

  let statusText = '对阵安排';
  let statusLime = false;
  if (allDone) { statusText = '最终战果'; statusLime = true; }
  else if (ended) { statusText = `已结束 · ${progress.done}/${progress.total} 场`; }
  else if (progress.done > 0) { statusText = `进行中 · ${progress.done}/${progress.total} 场`; }

  let runnerUp = '';
  let groups = [];
  let rounds = [];
  let rotRounds = [];

  if (isRot) {
    rotRounds = E.rotationFor(d, ms).map((f) => ({
      label: `第 ${f.round} 轮`,
      slot: slotsMap[f.key] || '',
      aName: f.a,
      bName: f.b,
      aMembers: E.membersOf(d, f.a),
      bMembers: E.membersOf(d, f.b),
      winner: f.winner || '',
      done: !!f.done,
      setsA: setColsOf(f.sets, 'a'),
      setsB: setColsOf(f.sets, 'b'),
      tagA: f.outcome === 'walkover' ? (f.winner === 'a' ? '弃权胜' : '弃权') : f.outcome === 'retired' && f.winner === 'b' ? '退赛' : '',
      tagB: f.outcome === 'walkover' ? (f.winner === 'b' ? '弃权胜' : '弃权') : f.outcome === 'retired' && f.winner === 'a' ? '退赛' : '',
    }));
  } else {
    const rawGroups = E.hasGroups(d) ? E.groupsFor(d, ms) : [];
    const adv = d.mode === 'groups_ko' ? (d.advance === 1 ? 1 : 2) : 0;
    if (E.hasGroups(d)) {
      groups = rawGroups.map((g) => ({
        name: g.name,
        done: g.done,
        total: g.fixtures.length,
        advance: adv,
        table: g.table.map((r) => ({
          rank: r.rank,
          name: r.name,
          members: E.membersOf(d, r.name),
          win: r.win,
          lose: r.lose,
          diffText: r.gameDiff > 0 ? `+${r.gameDiff}` : `${r.gameDiff}`,
          q: !!(adv && r.rank && r.rank <= adv),
          withdrawn: r.withdrawn || '',
        })),
        fixtures: compact ? [] : g.fixtures.map((f) => ({
          label: `R${f.round || 1}`,
          slot: slotsMap[f.key] || '',
          aName: f.a,
          bName: f.b,
          aMembers: E.membersOf(d, f.a),
          bMembers: E.membersOf(d, f.b),
          winner: f.winner || '',
          done: !!f.done,
          setsA: setColsOf(f.sets, 'a'),
          setsB: setColsOf(f.sets, 'b'),
          tagA: f.outcome === 'walkover' ? (f.winner === 'a' ? '弃权胜' : '弃权')
            : f.outcome === 'retired' && f.winner === 'b' ? '退赛'
            : f.outcome === 'void' ? '取消' : '',
          tagB: f.outcome === 'walkover' ? (f.winner === 'b' ? '弃权胜' : '弃权')
            : f.outcome === 'retired' && f.winner === 'a' ? '退赛' : '',
        })),
      }));
    }
    if (E.hasKo(d)) {
      const v = d.mode === 'groups_ko' ? E.knockoutFor(d, ms, rawGroups) : E.bracketFor(d, ms);
      rounds = (v.rounds || []).map((rd) => {
        const items = (rd.matches || []).map((m, mi) => {
          const aName = m.a.bye ? '轮空' : (m.a.name || m.a.label || '待定');
          const bName = m.b.bye ? '轮空' : (m.b.name || m.b.label || '待定');
          const tagOf = (x) => {
            if (m.auto && x.win) return '轮空';
            if (m.outcome === 'walkover') return x.win ? '弃权胜' : x.lose ? '弃权' : '';
            if (m.outcome === 'retired' && x.lose) return '退赛';
            return '';
          };
          return {
            label: rd.matches.length === 1 ? rd.name : `第 ${mi + 1} 场`,
            slot: m.key ? (slotsMap[m.key] || '') : '',
            aName,
            bName,
            aMembers: !m.a.bye && !m.a.tbd && m.a.name ? E.membersOf(d, m.a.name) : [],
            bMembers: !m.b.bye && !m.b.tbd && m.b.name ? E.membersOf(d, m.b.name) : [],
            aMuted: !!(m.a.bye || m.a.tbd || !m.a.name),
            bMuted: !!(m.b.bye || m.b.tbd || !m.b.name),
            winner: m.a.win ? 'a' : m.b.win ? 'b' : '',
            done: !!(m.a.win || m.b.win),
            auto: !!m.auto,
            setsA: setColsOf(m.sets, 'a'),
            setsB: setColsOf(m.sets, 'b'),
            tagA: tagOf(m.a),
            tagB: tagOf(m.b),
          };
        });
        return { name: rd.name, matches: items };
      });
      if (progress.champion && rounds.length) {
        const lastRd = rounds[rounds.length - 1];
        const fin = lastRd && lastRd.matches && lastRd.matches[0];
        if (fin && fin.done) runnerUp = fin.winner === 'a' ? fin.bName : fin.aName;
      }
    }
  }

  const subParts = [modeLbl, isDouble ? '双打' : '单打', catLbl, entCnt ? `${entCnt} ${unit}` : '', when].filter(Boolean);
  return {
    title: E.titleOf(d),
    subtitle: subParts.join(' · '),
    place,
    tags,
    statusText,
    statusLime,
    isDouble,
    isRot,
    hasGroups: groups.length > 0,
    champion: progress.champion || '',
    championMembers: progress.champion ? E.membersOf(d, progress.champion) : [],
    runnerUp,
    entrants: d.entrants || [],
    groups,
    rounds,
    rotRounds,
  };
}

// 计算精准总高度（与 paint 使用同一套尺寸常数，绝不截断也不留大白边）
const HERO_H_BASE = 224;
const CHAMP_H = 112;
const MATCH_H = 122;
const MATCH_GAP = 14;
const SEC_GAP = 22;

function measureHeight(m) {
  let y = PAD;
  y += HERO_H_BASE + (m.place ? 30 : 0) + (m.tags.length ? 46 : 0) + SEC_GAP;
  if (m.champion) y += CHAMP_H + SEC_GAP;

  if (m.isRot) {
    // 4 人名单条 + 3 轮对阵卡
    y += 72 + 16;
    y += m.rotRounds.length * (MATCH_H + 14) + 28 + SEC_GAP;
  } else {
    if (m.groups.length) {
      m.groups.forEach((g) => {
        let gh = 68 + 34 + g.table.length * 52 + 18;
        if (g.fixtures.length) {
          const rows = Math.ceil(g.fixtures.length / 2);
          gh += 38 + rows * MATCH_H + Math.max(0, rows - 1) * MATCH_GAP + 14;
        }
        y += gh + SEC_GAP;
      });
    }
    if (m.rounds.length) {
      y += 42; // 「单淘汰阶段 / 各轮对阵」分节标题
      m.rounds.forEach((rd) => {
        const cols = rd.matches.length === 1 ? 1 : 2;
        const rows = Math.ceil(rd.matches.length / cols);
        y += 42 + rows * MATCH_H + Math.max(0, rows - 1) * MATCH_GAP + 18;
      });
    }
  }

  y += 58; // 底部页脚
  return Math.max(760, Math.round(y));
}

function avatarFill(ctx, name, cx, cy, r) {
  const raw = String(colorOf(name) || '');
  const hexes = raw.match(/#[0-9a-fA-F]{3,8}/g);
  if (hexes && hexes.length >= 2 && typeof ctx.createLinearGradient === 'function') {
    const g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r);
    g.addColorStop(0, hexes[0]);
    g.addColorStop(1, hexes[1]);
    return g;
  }
  return (hexes && hexes[0]) || '#C9C9E4';
}

function drawAvatars(ctx, members, cx, cy, r) {
  const list = (members || []).slice(0, 2);
  if (!list.length) return 0;
  const step = r * 1.45;
  list.forEach((name, idx) => {
    const x = cx + idx * step;
    ctx.beginPath();
    ctx.arc(x, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = avatarFill(ctx, name, x, cy, r);
    ctx.fill();
    if (idx > 0) {
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#2E2E4A';
    ctx.font = `bold ${Math.round(r * 1.05)}px ${FONT}`;
    ctx.fillText(initialOf(name), x, cy + 0.5);
  });
  ctx.textAlign = 'left';
  return list.length === 2 ? r * 2 + step : r * 2;
}

// 绘制单张 TNNS Live 风格对阵卡片
function drawMatchCard(ctx, m, x, y, w, h, spotlight) {
  roundRect(ctx, x, y, w, h, 20);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.strokeStyle = spotlight ? 'rgba(154, 188, 22, 0.55)' : 'rgba(132, 132, 182, 0.18)';
  ctx.lineWidth = spotlight ? 2 : 1.5;
  ctx.stroke();

  // 顶行：轮次/场次标签 + 时间场地或状态
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = spotlight ? '#587400' : '#70708C';
  ctx.font = `bold 19px ${FONT}`;
  ctx.fillText(m.label || '', x + 18, y + 22);

  const rightHint = m.slot || (m.auto ? '轮空' : m.done ? '已完赛' : '待打');
  ctx.textAlign = 'right';
  ctx.fillStyle = m.slot ? '#6E6EA3' : (m.done ? '#70708C' : '#A4A4BC');
  ctx.font = `${m.slot ? 'bold ' : ''}18px ${FONT}`;
  ctx.fillText(fitText(ctx, rightHint, w - 120), x + w - 18, y + 22);
  ctx.textAlign = 'left';

  // 分隔线
  ctx.beginPath();
  ctx.moveTo(x + 16, y + 38);
  ctx.lineTo(x + w - 16, y + 38);
  ctx.strokeStyle = '#F2F2F8';
  ctx.lineWidth = 1;
  ctx.stroke();

  const hasAnySets = !!(m.setsA.length || m.setsB.length);
  const reserveDot = !!(m.done && hasAnySets);
  const drawSide = (rowY, name, members, sets, tag, isWin, isLose, isMuted) => {
    const midY = rowY + 19;
    // 胜方左侧紫色竖条
    if (isWin) {
      roundRect(ctx, x + 10, rowY + 6, 4.5, 26, 2.5);
      ctx.fillStyle = spotlight ? '#95B815' : '#8484B6';
      ctx.fill();
    }
    let tx = x + 22;
    if (members && members.length) {
      const avW = drawAvatars(ctx, members, tx + 13, midY, 13);
      tx += avW + 10;
    }

    // 右侧比分框 / 状态标签（胜负两行均预留 16px 胜方圆点列，确保逐盘比分垂直对齐）
    let rightEdge = x + w - 16;
    if (reserveDot) {
      if (isWin) {
        ctx.beginPath();
        ctx.arc(rightEdge - 5, midY, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = '#C9E33A';
        ctx.fill();
      }
      rightEdge -= 16;
    }
    if (sets.length) {
      const boxW = 32, boxH = 28, gap = 5;
      const totalW = sets.length * boxW + (sets.length - 1) * gap;
      let bx = rightEdge - totalW;
      sets.forEach((sc) => {
        roundRect(ctx, bx, midY - boxH / 2, boxW, boxH, 7);
        ctx.fillStyle = sc.w ? '#EAEAF7' : '#F5F5FA';
        ctx.fill();
        ctx.textAlign = 'center';
        ctx.fillStyle = sc.w ? '#2E2E4A' : '#9A9AB4';
        ctx.font = `${sc.w ? 'bold ' : ''}21px ${NUM_FONT}`;
        ctx.fillText(sc.v, bx + (sc.tb ? boxW / 2 - 4 : boxW / 2), midY + 1);
        if (sc.tb) {
          ctx.font = `bold 12px ${NUM_FONT}`;
          ctx.fillText(sc.tb, bx + boxW - 7, midY - 6);
        }
        bx += boxW + gap;
      });
      rightEdge -= totalW + 8;
      ctx.textAlign = 'left';
    }
    // 中途退赛同时有局分和「退赛」标签时一并画出；无局分时画状态标签或「胜」
    if (tag) {
      ctx.font = `bold 16px ${FONT}`;
      const tw = ctx.measureText(tag).width + 16;
      roundRect(ctx, rightEdge - tw, midY - 12, tw, 24, 10);
      ctx.fillStyle = isWin ? '#E9F5BE' : '#FFF5DC';
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.fillStyle = isWin ? '#365C00' : '#9A6A00';
      ctx.fillText(tag, rightEdge - tw / 2, midY + 0.5);
      rightEdge -= tw + 8;
      ctx.textAlign = 'left';
    } else if (!sets.length && isWin) {
      roundRect(ctx, rightEdge - 36, midY - 12, 36, 24, 10);
      ctx.fillStyle = '#C9E33A';
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.fillStyle = '#2E3600';
      ctx.font = `bold 17px ${FONT}`;
      ctx.fillText('胜', rightEdge - 18, midY + 0.5);
      rightEdge -= 44;
      ctx.textAlign = 'left';
    }

    // 名称
    const maxNameW = Math.max(60, rightEdge - tx);
    ctx.textAlign = 'left';
    ctx.fillStyle = isWin ? '#2E2E4A' : isMuted ? '#B0B0C6' : isLose ? '#9A9AB4' : '#323252';
    ctx.font = `${isWin ? 'bold ' : ''}22px ${FONT}`;
    ctx.fillText(fitText(ctx, name, maxNameW), tx, midY + 0.5);
  };

  drawSide(y + 42, m.aName, m.aMembers, m.setsA, m.tagA, m.winner === 'a', m.done && m.winner !== 'a', !!m.aMuted);
  drawSide(y + 80, m.bName, m.bMembers, m.setsB, m.tagB, m.winner === 'b', m.done && m.winner !== 'b', !!m.bMuted);
}

function paint(ctx, model, genDate) {
  const m = model || {};
  const H = measureHeight(m);

  // 整体淡紫冷雾底色
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, '#E8E8F6');
  bg.addColorStop(0.35, '#F2F2F8');
  bg.addColorStop(1, '#ECECF6');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // ── 1. 顶部淡紫主头卡 ──
  let y = PAD;
  const heroH = HERO_H_BASE + (m.place ? 30 : 0) + (m.tags.length ? 46 : 0);
  roundRect(ctx, PAD, y, CARD_W, heroH, 32);
  const hg = ctx.createLinearGradient(PAD, y, PAD + CARD_W, y + heroH);
  hg.addColorStop(0, '#A7A7D0');
  hg.addColorStop(1, '#7D7DB2');
  ctx.fillStyle = hg;
  ctx.fill();

  // 淡球场几何纹理（裁切在头卡圆角内）
  ctx.save();
  roundRect(ctx, PAD, y, CARD_W, heroH, 32);
  ctx.clip();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.13)';
  ctx.lineWidth = 3;
  ctx.strokeRect(PAD + 380, y + 66, 360, 210);
  ctx.beginPath();
  ctx.moveTo(PAD + 530, y + 66);
  ctx.lineTo(PAD + 530, y + 276);
  ctx.stroke();
  ctx.restore();

  ctx.textBaseline = 'middle';
  // 品牌胶囊
  roundRect(ctx, PAD + 28, y + 26, 142, 38, 19);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.fill();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `bold 21px ${FONT}`;
  ctx.fillText('LULU 网球', PAD + 28 + 71, y + 45);

  // 右上状态胶囊
  ctx.font = `bold 21px ${FONT}`;
  const stW = Math.max(120, ctx.measureText(m.statusText || '').width + 36);
  roundRect(ctx, PAD + CARD_W - 28 - stW, y + 26, stW, 38, 19);
  ctx.fillStyle = m.statusLime ? '#C9E33A' : 'rgba(255, 255, 255, 0.22)';
  ctx.fill();
  ctx.fillStyle = m.statusLime ? '#2E3600' : '#FFFFFF';
  ctx.fillText(m.statusText || '', PAD + CARD_W - 28 - stW / 2, y + 45);

  // 活动标题
  ctx.textAlign = 'left';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `bold 40px ${FONT}`;
  ctx.fillText(fitText(ctx, m.title || '网球活动', CARD_W - 56), PAD + 28, y + 114);

  // 活动概要（形式 · 单双打 · 人数 · 日期时间）
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.font = `23px ${FONT}`;
  ctx.fillText(fitText(ctx, m.subtitle || '', CARD_W - 56), PAD + 28, y + 162);

  let innerY = y + 194;
  if (m.place) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.84)';
    ctx.font = `21px ${FONT}`;
    ctx.fillText(fitText(ctx, `场地：${m.place}`, CARD_W - 56), PAD + 28, innerY);
    innerY += 32;
  }

  if (m.tags && m.tags.length) {
    let tx = PAD + 28;
    const tagY = innerY + 2;
    m.tags.forEach((tg) => {
      ctx.font = `bold 20px ${FONT}`;
      const tw = ctx.measureText(tg.text).width + 28;
      if (tx + tw > PAD + CARD_W - 24) return;
      roundRect(ctx, tx, tagY, tw, 36, 18);
      ctx.fillStyle = tg.solid ? '#5E5E96' : 'rgba(255, 255, 255, 0.2)';
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(tg.text, tx + 14, tagY + 18);
      tx += tw + 10;
    });
  }
  y += heroH + SEC_GAP;

  // ── 2. 冠军高光横幅（完赛出冠军时展示） ──
  if (m.champion) {
    roundRect(ctx, PAD, y, CARD_W, CHAMP_H, 28);
    const cg = ctx.createLinearGradient(PAD, y, PAD + CARD_W, y + CHAMP_H);
    cg.addColorStop(0, '#F7FBE2');
    cg.addColorStop(1, '#FFFFFF');
    ctx.fillStyle = cg;
    ctx.fill();
    ctx.strokeStyle = '#C9E33A';
    ctx.lineWidth = 3;
    ctx.stroke();

    // 黄绿「冠军」徽章
    roundRect(ctx, PAD + 24, y + 32, 82, 48, 24);
    ctx.fillStyle = '#C9E33A';
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.fillStyle = '#2E3600';
    ctx.font = `bold 24px ${FONT}`;
    ctx.fillText('冠军', PAD + 24 + 41, y + 56);

    let cx = PAD + 124;
    if (m.championMembers && m.championMembers.length) {
      const avW = drawAvatars(ctx, m.championMembers, cx + 22, y + 56, 22);
      cx += avW + 14;
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = '#2E2E4A';
    ctx.font = `bold 34px ${FONT}`;
    ctx.fillText(fitText(ctx, m.champion, PAD + CARD_W - cx - 24), cx, y + (m.runnerUp ? 42 : 56));
    if (m.runnerUp) {
      ctx.fillStyle = '#70708C';
      ctx.font = `21px ${FONT}`;
      ctx.fillText(fitText(ctx, `亚军：${m.runnerUp}`, PAD + CARD_W - cx - 24), cx, y + 78);
    }
    y += CHAMP_H + SEC_GAP;
  }

  // ── 3A. 四人轮换双打 ──
  if (m.isRot) {
    // 球友条
    roundRect(ctx, PAD, y, CARD_W, 72, 24);
    ctx.fillStyle = '#FFFFFF';
    ctx.fill();
    ctx.textAlign = 'left';
    ctx.fillStyle = '#70708C';
    ctx.font = `bold 21px ${FONT}`;
    ctx.fillText('本场球友', PAD + 24, y + 36);
    ctx.fillStyle = '#2E2E4A';
    ctx.font = `bold 24px ${FONT}`;
    ctx.fillText(fitText(ctx, (m.entrants || []).join(' · '), CARD_W - 150), PAD + 128, y + 36);
    y += 72 + 16;

    m.rotRounds.forEach((rd) => {
      drawMatchCard(ctx, rd, PAD, y, CARD_W, MATCH_H, false);
      y += MATCH_H + 14;
    });
    ctx.textAlign = 'center';
    ctx.fillStyle = '#84849E';
    ctx.font = `20px ${FONT}`;
    ctx.fillText('三轮换搭档，每人和另外三位各搭档一次', W / 2, y + 12);
    ctx.textAlign = 'left';
    y += 28 + SEC_GAP;
  }

  // ── 3B. 分组循环（每组独立白卡：积分榜 + 可选 2 列组内对阵） ──
  if (m.groups && m.groups.length) {
    m.groups.forEach((g) => {
      const rows = g.fixtures.length ? Math.ceil(g.fixtures.length / 2) : 0;
      const gh = 68 + 34 + g.table.length * 52 + 18 + (rows ? 38 + rows * MATCH_H + Math.max(0, rows - 1) * MATCH_GAP + 14 : 0);
      roundRect(ctx, PAD, y, CARD_W, gh, 28);
      ctx.fillStyle = '#FFFFFF';
      ctx.fill();
      ctx.strokeStyle = 'rgba(132, 132, 182, 0.14)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // 组标题行
      roundRect(ctx, PAD + 24, y + 20, 82, 34, 17);
      ctx.fillStyle = '#EFEFF8';
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.fillStyle = '#4F4F7D';
      ctx.font = `bold 22px ${FONT}`;
      ctx.fillText(g.name, PAD + 24 + 41, y + 37);

      ctx.textAlign = 'left';
      ctx.fillStyle = '#70708C';
      ctx.font = `21px ${FONT}`;
      ctx.fillText(`积分榜${g.advance ? ` · 前 ${g.advance} 名进入单淘汰` : ''}`, PAD + 118, y + 37);

      ctx.textAlign = 'right';
      ctx.fillStyle = '#84849E';
      ctx.font = `20px ${FONT}`;
      ctx.fillText(`${g.done}/${g.total} 场`, PAD + CARD_W - 24, y + 37);
      ctx.textAlign = 'left';

      // 表头
      const thY = y + 78;
      ctx.fillStyle = '#9090AA';
      ctx.font = `19px ${FONT}`;
      ctx.fillText('名次', PAD + 24, thY);
      ctx.fillText(m.isDouble ? '队伍' : '球友', PAD + 88, thY);
      ctx.textAlign = 'right';
      ctx.fillText('胜-负', PAD + CARD_W - 116, thY);
      ctx.fillText('净胜局', PAD + CARD_W - 24, thY);
      ctx.textAlign = 'left';

      ctx.beginPath();
      ctx.moveTo(PAD + 24, thY + 18);
      ctx.lineTo(PAD + CARD_W - 24, thY + 18);
      ctx.strokeStyle = '#EFEFF7';
      ctx.lineWidth = 1;
      ctx.stroke();

      // 积分榜行
      let ry = thY + 24;
      g.table.forEach((r, ri) => {
        if (ri > 0) {
          ctx.beginPath();
          ctx.moveTo(PAD + 24, ry);
          ctx.lineTo(PAD + CARD_W - 24, ry);
          ctx.strokeStyle = '#F5F5FA';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
        const midY = ry + 26;
        // 名次圆
        ctx.beginPath();
        ctx.arc(PAD + 42, midY, 15, 0, Math.PI * 2);
        ctx.fillStyle = r.q ? '#C9E33A' : '#F2F2F8';
        ctx.fill();
        ctx.textAlign = 'center';
        ctx.fillStyle = r.q ? '#2E3600' : '#70708C';
        ctx.font = `bold 20px ${NUM_FONT}`;
        ctx.fillText(r.rank ? String(r.rank) : '—', PAD + 42, midY + 0.5);

        // 头像 + 名称
        let nx = PAD + 74;
        const avW = drawAvatars(ctx, r.members, nx + 14, midY, 14);
        nx += avW + 10;
        ctx.textAlign = 'left';
        ctx.fillStyle = r.withdrawn ? '#A4A4BC' : '#2E2E4A';
        ctx.font = `${r.q ? 'bold ' : ''}24px ${FONT}`;
        const nm = r.withdrawn ? `${r.name}（退赛）` : r.name;
        ctx.fillText(fitText(ctx, nm, PAD + CARD_W - 210 - nx), nx, midY + 0.5);

        // 胜-负 & 净胜局
        ctx.textAlign = 'right';
        ctx.fillStyle = '#323252';
        ctx.font = `bold 24px ${NUM_FONT}`;
        ctx.fillText(`${r.win}-${r.lose}`, PAD + CARD_W - 116, midY + 0.5);
        ctx.fillStyle = r.diffText.startsWith('+') ? '#477200' : '#84849E';
        ctx.font = `bold 22px ${NUM_FONT}`;
        ctx.fillText(r.diffText, PAD + CARD_W - 24, midY + 0.5);
        ctx.textAlign = 'left';
        ry += 52;
      });

      // 组内各场对阵（2 列网格）
      if (g.fixtures.length) {
        let fy = ry + 12;
        ctx.fillStyle = '#70708C';
        ctx.font = `bold 20px ${FONT}`;
        ctx.fillText('组内对阵', PAD + 24, fy + 14);
        fy += 36;
        const innerW = CARD_W - 48;
        const colW = (innerW - MATCH_GAP) / 2;
        g.fixtures.forEach((f, fi) => {
          const col = fi % 2;
          const row = Math.floor(fi / 2);
          const fx = PAD + 24 + col * (colW + MATCH_GAP);
          const curY = fy + row * (MATCH_H + MATCH_GAP);
          drawMatchCard(ctx, f, fx, curY, colW, MATCH_H, false);
        });
      }
      y += gh + SEC_GAP;
    });
  }

  // ── 3C. 单淘汰各轮对阵（2 列网格，最后一轮居中全宽展示） ──
  if (m.rounds && m.rounds.length) {
    ctx.textAlign = 'left';
    ctx.fillStyle = '#323252';
    ctx.font = `bold 26px ${FONT}`;
    ctx.fillText(m.hasGroups ? '单淘汰阶段' : '各轮对阵', PAD + 4, y + 16);
    y += 42;

    m.rounds.forEach((rd, rIdx) => {
      const isFinal = rIdx === m.rounds.length - 1 && rd.matches.length === 1;
      // 轮次标题条
      roundRect(ctx, PAD, y + 2, 116, 30, 15);
      ctx.fillStyle = isFinal ? '#C9E33A' : '#E6E6F4';
      ctx.fill();
      ctx.textAlign = 'center';
      ctx.fillStyle = isFinal ? '#2E3600' : '#4F4F7D';
      ctx.font = `bold 20px ${FONT}`;
      ctx.fillText(rd.name, PAD + 58, y + 17);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#84849E';
      ctx.font = `20px ${FONT}`;
      ctx.fillText(`${rd.matches.length} 场`, PAD + 128, y + 17);
      y += 42;

      const cols = rd.matches.length === 1 ? 1 : 2;
      const colW = cols === 1 ? CARD_W : (CARD_W - MATCH_GAP) / 2;
      const rows = Math.ceil(rd.matches.length / cols);
      rd.matches.forEach((item, mi) => {
        const col = mi % cols;
        const row = Math.floor(mi / cols);
        const mx = PAD + col * (colW + MATCH_GAP);
        const my = y + row * (MATCH_H + MATCH_GAP);
        drawMatchCard(ctx, item, mx, my, colW, MATCH_H, isFinal);
      });
      y += rows * MATCH_H + Math.max(0, rows - 1) * MATCH_GAP + 18;
    });
  }

  // ── 4. 底部简洁页脚 ──
  ctx.textAlign = 'center';
  ctx.fillStyle = '#9090AA';
  ctx.font = `20px ${FONT}`;
  ctx.fillText(`LULU 网球 · 活动对阵与战果${genDate ? ' · ' + genDate : ''}`, W / 2, H - 28);
  ctx.textAlign = 'left';
  return H;
}

async function render(canvas, draw, matches, opts) {
  const o = opts || {};
  const model = o.model || buildModel(draw, matches, o);
  const H = measureHeight(model);
  // 兼顾清晰度与 iOS/Android 画布物理高度上限（<= 3840px，避免超长 16 人循环图导出空白）
  const dpr = Math.min(1.5, 3840 / Math.max(H, 1));
  const cw = Math.round(W * dpr);
  const ch = Math.round(H * dpr);
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  if (typeof ctx.setTransform === 'function') ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  else if (typeof ctx.scale === 'function') ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);
  paint(ctx, model, o.genDate || '');
  const r = await new Promise((ok, bad) => wx.canvasToTempFilePath({
    canvas, destWidth: cw, destHeight: ch,
    fileType: 'jpg', quality: 0.92, success: ok, fail: bad,
  }));
  return { filePath: r.tempFilePath, width: W, height: H, model };
}

module.exports = {
  W,
  buildModel,
  measureHeight,
  paint,
  render,
};
