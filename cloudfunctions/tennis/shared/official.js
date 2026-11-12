// 正式战绩：哪些比赛记录计入战绩、排名、水平分和互评
//
//   活动比赛：只由云函数 tennis 写入（recordEventMatch），每一场固定一条记录。
//            云函数写入的记录没有 _openid；小程序端写入的记录系统一定会带 _openid，伪造不了。
//   日常比赛：有一个人录了就生效，不需要对手确认（只能经云函数网关新增、经云函数修改，小程序端改不了）。
//            以前「对手确认后才计入」的规则已取消，当时还在待确认的记录也一并计入。
//            verified 集合不再决定日常比赛是否计入，只留着管理员更正的标记（adminSig）和旧快照。
//
// 这个文件小程序端和云函数共用（cloudfunctions/tennis/shared/official.js 是复制件，用 scripts/sync-shared.sh 同步）。

// 稳定的序列化：对象按键名排序，保证两端算出来一样
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

// 比分快照：双方（名字和用户 ID）、胜者、局分、所属活动场次
function snapOf(m) {
  return canon({
    a: m.a || [], b: m.b || [], aIds: m.aIds || [], bIds: m.bIds || [],
    winner: m.winner || '', sets: m.sets || [], drawId: m.drawId || '', drawKey: m.drawKey || '',
  });
}

// 'official' 正式 | 'invalid' 不是云函数写入的活动记录（不展示、不计入）
// verified: { 比赛 _id: { snap } }，只用来认升级前小程序端写入的活动旧记录
function statusOf(m, verified) {
  if (!m.drawId) return 'official';
  if (!m._openid) return 'official';
  const v = verified && verified[m._id];
  return v && v.snap === snapOf(m) ? 'official' : 'invalid';
}

const META_ID = '__legacy_migrated__'; // verified 集合里标记「旧记录已迁移」的文档

module.exports = { canon, snapOf, statusOf, META_ID };
