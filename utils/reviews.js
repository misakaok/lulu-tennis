// 对手评价汇总（匿名）：和竞技等级分开展示，不参与排名和水平分计算
const cloud = require('./cloud');

const LABELS = { manner: '球品礼仪', punctual: '守时守约', level: '水平相符' };

function view(p) {
  if (!p || !p.count) return { count: 0, text: '暂无对手评价' };
  return {
    count: p.count, overall: p.overall.toFixed(1), few: p.count < 3,
    dims: Object.keys(LABELS).map((k) => ({ k, t: LABELS[k], v: p.avg[k].toFixed(1), w: Math.round((p.avg[k] / 5) * 100) })),
    recent: p.recent || [],
    text: `${p.overall.toFixed(1)} 分 · ${p.count} 条评价`,
  };
}

// 按用户 ID 查询（改昵称不影响口碑）；失败时返回 null（例如云函数还没部署），页面不显示这一块即可
async function summary(ids) {
  const list = (ids || []).filter(Boolean);
  try {
    const r = list.length ? await cloud.cached('reviewSummary', { ids: list }) : { players: {} };
    const out = {};
    (ids || []).forEach((k) => { if (k) out[k] = view(r.players[k]); });
    return out;
  } catch (e) {
    console.warn('[对手评价]', e.message);
    return null;
  }
}

module.exports = { summary, view, LABELS };
