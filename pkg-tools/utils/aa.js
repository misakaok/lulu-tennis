// 活动 AA 算账（纯本地算术计算器，不涉及支付、收款码或云端存储）
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const cleanMoney = (v) => {
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return 0;
  return Math.min(99999, round2(n));
};
const cleanInt = (v, max) => {
  const n = Math.floor(Number(v) || 0);
  if (!isFinite(n) || n < 0) return 0;
  return Math.min(max || 99, n);
};
const moneyText = (n) => {
  const r = round2(n);
  return Number.isInteger(r) ? String(r) : r.toFixed(2).replace(/0$/, '');
};
const applyRound = (x, mode) => {
  if (mode === 'yuan') return Math.round(x);
  if (mode === 'cent') return round2(x);
  return Math.round(x * 10) / 10; // 默认精确到角（0.1 元）
};

/**
 * 计算场地费 + 球费 + 其他费用的 AA 均摊：全勤按 1 份，半场 / 早退按 0.5 份。
 */
function calc(input) {
  const x = input || {};
  const court = cleanMoney(x.court);
  const balls = cleanMoney(x.balls);
  const extra = cleanMoney(x.extra);
  const full = cleanInt(x.full, 64);
  const half = cleanInt(x.half, 64);
  const mode = x.mode === 'yuan' || x.mode === 'cent' ? x.mode : 'jiao';
  const total = round2(court + balls + extra);
  const shares = round2(full + half * 0.5);
  const people = full + half;
  if (total <= 0 || shares <= 0) {
    return {
      court, balls, extra, full, half, mode, total, shares, people,
      perFull: 0, perHalf: 0, collect: 0, diff: 0,
      totalText: moneyText(total), perFullText: '0', perHalfText: '0', collectText: '0', diffText: '', ready: false,
    };
  }
  const raw = total / shares;
  const perFull = full > 0 ? applyRound(raw, mode) : 0;
  const perHalf = half > 0 ? applyRound(raw * 0.5, mode) : 0;
  const collect = round2(perFull * full + perHalf * half);
  const diff = round2(collect - total);
  const diffText = diff === 0 ? '' : diff > 0 ? `按当前取整多收 ¥${moneyText(diff)}` : `按当前取整少收 ¥${moneyText(-diff)}`;
  return {
    court, balls, extra, full, half, mode, total, shares, people,
    perFull, perHalf, collect, diff,
    totalText: moneyText(total),
    perFullText: moneyText(perFull),
    perHalfText: moneyText(perHalf),
    collectText: moneyText(collect),
    diffText,
    ready: true,
  };
}

/** 生成可复制到微信群的纯文本费用明细 */
function formatBill(input, meta) {
  const r = calc(input);
  if (!r.ready) return '';
  const m = meta || {};
  const headParts = [m.title, m.date].filter(Boolean);
  const head = headParts.length ? `【网球费用均摊】${headParts.join(' · ')}` : '【网球费用均摊】';
  const items = [];
  if (r.court > 0) items.push(`场地 ¥${moneyText(r.court)}`);
  if (r.balls > 0) items.push(`用球 ¥${moneyText(r.balls)}`);
  if (r.extra > 0) items.push(`其他 ¥${moneyText(r.extra)}`);
  const peopleParts = [];
  if (r.full > 0) peopleParts.push(`全勤 ${r.full} 人`);
  if (r.half > 0) peopleParts.push(`半场 ${r.half} 人`);
  const lines = [
    head,
    `总费用：¥${r.totalText}${items.length > 1 ? `（${items.join(' + ')}）` : ''}`,
    `人数：${peopleParts.join('、')}（共 ${moneyText(r.shares)} 份）`,
  ];
  if (r.full > 0) lines.push(`· 全勤每人：¥${r.perFullText}`);
  if (r.half > 0) lines.push(`· 半场每人：¥${r.perHalfText}`);
  if (r.diffText) lines.push(`说明：实收合计 ¥${r.collectText}（${r.diffText}）`);
  lines.push('（由 LULU 网球本地计算，仅供参考）');
  return lines.join('\n');
}

module.exports = { calc, formatBill, moneyText };
