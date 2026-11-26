// 外传时的名字：存进相册的图、复制到剪贴板的文字会离开小程序，
// 没同意最新版公开展示说明（utils/consent.js 的 latest：shown === true 且 shownVer >= 2）的人一律写「球友」，本人照常（2026-11-26 用户要求）。
// 只同意过旧版说明的老成员：小程序里照常展示，但旧说明没写「会被保存、转发到小程序以外」，所以这里也写「球友」。
// 认不出用户 ID 的（没有账号的旧名字）、资料还没读到的，也按没同意处理。
// 同一份图 / 文字里不止一位「球友」时按出现顺序编号（「球友1」「球友2」），免得几轮对阵分不清谁是谁。
const C = require('../../utils/consent');

const FRIEND = '球友';

// 这个用户 ID 能不能露名字
function shownBy(profiles, myId) {
  return (uid) => !!uid && (uid === myId || C.latest(profiles && profiles[uid]));
}

// entries：按出现顺序的 [{ id, uid, name }]（id 在这一份里唯一；同一 id 出现多次只算一次）
// 返回 id → 外传用的名字
function labelsOf(entries, ok) {
  const out = Object.create(null);
  const hidden = [];
  const used = new Set(); // 露出来的真名：编号要避开（真名恰好叫「球友」「球友1」时不撞，免得分不清）
  (entries || []).forEach((e) => {
    if (!e || e.id === undefined || e.id === null || e.id in out) return;
    if (ok(e.uid)) { out[e.id] = String(e.name || ''); used.add(out[e.id]); } else { out[e.id] = FRIEND; hidden.push(e.id); }
  });
  if (hidden.length > 1 || (hidden.length === 1 && used.has(FRIEND))) {
    let k = 0;
    hidden.forEach((id) => {
      do { k++; } while (used.has(FRIEND + k));
      out[id] = FRIEND + k;
    });
  }
  return out;
}

// 简便写法：按 { profiles, myId } 把一组人换成外传名字，返回 (id) => 名字（不在名单里的一律「球友」）
function masker(entries, profiles, myId) {
  const map = labelsOf(entries, shownBy(profiles, myId));
  return (id) => (id in map ? map[id] : FRIEND);
}

module.exports = { FRIEND, shownBy, labelsOf, masker };
