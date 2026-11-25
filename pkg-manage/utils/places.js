// 创建球友活动「最近使用的地点」：直接从已保存的活动里取，不单独建地点表。只在小程序端用。
//   · 按活动创建时间从新到旧，最多 5 个
//   · 相距 100 米以内（MERGE_M）算同一个地点，只出现一次：位置用最新那次的，名称用最近一次检测通过的
//     （同一个球场在地图上点偏一点也只出现一次；2026-11-22 用户选的）
//   · 只有坐标、没有名称的旧活动显示「历史地图位置」+ 活动日期，最多只出现 1 条（取最近的），其余名额留给有名称的地点
//   · 已删除的活动、没有有效坐标的活动不算
//   · 地点名称和地址只认云端检测过的 draws.place（publicDraw 已处理）
//   · 不带场地编号：场号在表单里单独选
const E = require('../../utils/event');

const RECENT_MAX = 5;
const MERGE_M = 100;
const keyOf = (l) => (l ? `${l.latitude.toFixed(6)},${l.longitude.toFixed(6)}` : '');

// 两个坐标相距多少米（球面距离，够用）
function distance(a, b) {
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude), dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function recentPlaces(draws, max) {
  const list = (draws || []).filter((d) => d && !d.deleted && E.locationOf(d.location))
    .map((d, i) => ({ d, i, t: E.tsOf(d) }))
    .sort((x, y) => y.t - x.t || x.i - y.i) // 没有创建时间的旧记录保持原来的顺序（列表本来就按创建时间倒序）
    .map((x) => x.d);
  // 先把 100 米以内的合并（从新到旧，后面更旧的并进前面已有的那条）
  const merged = [];
  list.forEach((d) => {
    const location = E.locationOf(d.location);
    const place = E.placeOf(d.place);
    const hit = merged.find((x) => distance(x.location, location) <= MERGE_M);
    if (!hit) merged.push({ location, place, date: d.date || '' });
    else if (!hit.place && place) hit.place = place; // 最新那次没有名称（例如没通过检测只存了坐标）：用以前检测通过的
  });
  // 再挑前 5 条：只有坐标的最多 1 条
  const out = [];
  let bare = 0;
  merged.forEach((x) => {
    if (out.length >= (max || RECENT_MAX)) return;
    if (!x.place && bare++) return;
    out.push(entry(x.location, x.place, x.date));
  });
  return out;
}

function entry(location, place, date) {
  const when = E.dayText(date);
  return {
    key: keyOf(location), location, place, date,
    name: place ? place.name || place.address : '历史地图位置',
    sub: place ? (place.name ? place.address : '') : when ? `${when}的活动` : '',
  };
}

module.exports = { recentPlaces, keyOf, distance, RECENT_MAX, MERGE_M };
