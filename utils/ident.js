// 用户身份：一律用 openid（记录里系统写入的 _openid，前端不能伪造）作为稳定的用户 ID。
// 昵称只用于展示：改昵称不影响历史记录，同名也拿不到别人的权限。
//
// 记录里的身份字段：
//   matches.aIds / bIds   与 a / b 一一对应的用户 ID，'' 表示这个位置没有绑定账号
//   signups._openid       报名人；signups.partnerId 搭档
//   draws.uidOf           { 参赛名: 用户 ID }，生成签表时从报名记录 / 球员列表取的快照
//   players.formerNames   改名前用过的昵称（保留给本人，别人不能再用）
//
// 旧数据：没有 ID 的位置保持「未绑定」。它们照常显示在战绩和统计里，
// 但不能用来确认赛果、评价或获得任何权限。系统不会只凭昵称自动绑定。

// 只有「唯一」的当前昵称才能对应到 ID；出现同名资料时一律不绑定
function uidByName(players) {
  const map = {}, dup = {};
  (players || []).forEach((p) => {
    if (!p.uid || !p.name) return;
    if (map[p.name] && map[p.name] !== p.uid) dup[p.name] = 1;
    map[p.name] = p.uid;
  });
  Object.keys(dup).forEach((n) => { delete map[n]; });
  return map;
}

function nameByUid(players) {
  const map = {};
  (players || []).forEach((p) => { if (p.uid && p.name) map[p.uid] = p.name; });
  return map;
}

// 仅用于展示：旧记录（没有 ID）里的旧昵称 → 本人现在的昵称。
// 条件：恰好一个账号曾用过这个昵称，且现在没有人用它。不写回数据库，也不带任何权限。
function aliasOf(players) {
  const owners = {}, current = {};
  (players || []).forEach((p) => {
    if (!p.uid) return;
    current[p.name] = 1;
    (p.formerNames || []).forEach((n) => { (owners[n] = owners[n] || {})[p.uid] = p.name; });
  });
  const out = {};
  Object.keys(owners).forEach((n) => {
    const ids = Object.keys(owners[n]);
    if (ids.length === 1 && !current[n]) out[n] = owners[n][ids[0]];
  });
  return out;
}

// 统计身份（场数、胜率、排名、等级分都按它累计，见 utils/rules.js computeRank、utils/rating.js）：
//   有账号的位置 → 用户 ID；旧记录没有 ID 时，名字能唯一对应到一个账号 → 这个账号（保持旧战绩照常计入）；
//   否则 → 'n:' + 名字（单独统计，不算到任何账号上）。
// 所以两个账号即使同名，统计也是分开的。
const NAME_KEY = 'n:';
function keyOf(players, name, uid) {
  if (uid) return uid;
  const u = uidByName(players)[name];
  return u || NAME_KEY + name;
}
// 只有名字时（签表参赛名、挑战页等）查统计用的身份
function keyResolver(players) {
  const byName = uidByName(players);
  return (name, uid) => uid || byName[name] || NAME_KEY + name;
}

// 读取比赛时换成「当前昵称」展示：有 ID 的位置跟着用户走；保留原始名字在 aRaw / bRaw；统计身份在 aKeys / bKeys
function normalizeMatches(list, players) {
  const byUid = nameByUid(players), alias = aliasOf(players), byName = uidByName(players);
  return (list || []).map((m) => {
    const out = Object.assign({}, m);
    ['a', 'b'].forEach((k) => {
      const ids = m[k + 'Ids'] || [];
      out[k + 'Raw'] = m[k] || [];
      out[k] = (m[k] || []).map((n, i) => (ids[i] && byUid[ids[i]]) || (ids[i] ? n : alias[n] || n));
      out[k + 'Keys'] = out[k].map((n, i) => (typeof ids[i] === 'string' && ids[i]) || byName[n] || NAME_KEY + n);
    });
    return out;
  });
}

function idsFor(names, uidOf) { return (names || []).map((n) => (uidOf && uidOf[n]) || ''); }

// 赛事里「参赛名 → 用户 ID」：先用签表快照，再用报名记录覆盖（报名记录是本人写的，_openid 最可信）
// 云函数用完全相同的规则在服务端重新计算，不信任前端写进比赛记录的 ID
function drawUids(draw, signups) {
  const out = Object.assign({}, (draw && draw.uidOf) || {});
  (signups || []).forEach((s) => {
    if (s.partner && s.partnerId) out[s.partner] = s.partnerId;
  });
  (signups || []).forEach((s) => { if (s.name && s._openid) out[s.name] = s._openid; });
  return out;
}

module.exports = { uidByName, nameByUid, aliasOf, normalizeMatches, idsFor, drawUids, keyOf, keyResolver, NAME_KEY };
