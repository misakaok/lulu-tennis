// 正式战绩：哪些比赛记录计入战绩、排名、水平分和互评
//
//   赛事比赛：只由云函数 tennis 写入（recordEventMatch），每一场固定一条记录。
//            云函数写入的记录没有 _openid；小程序端写入的记录系统一定会带 _openid，伪造不了。
//   日常比赛：录入人写入后是「待确认」；对手确认后，云函数在 verified 集合写一份比分快照
//            （verified 所有人可读、只有云函数能写）。记录内容和快照完全一致才算正式；
//            之后录入人再改比分，就和快照对不上，回到待确认。
//   升级前的旧记录：云函数第一次运行时给当时已有的全部记录写快照（legacy），照常计入。
//
// 这个文件小程序端和云函数共用（cloudfunctions/tennis/shared/official.js 是复制件，用 scripts/sync-shared.sh 同步）。

// 稳定的序列化：对象按键名排序，保证两端算出来一样
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}

// 比分快照：双方（名字和用户 ID）、胜者、局分、所属赛事场次
function snapOf(m) {
  return canon({
    a: m.a || [], b: m.b || [], aIds: m.aIds || [], bIds: m.bIds || [],
    winner: m.winner || '', sets: m.sets || [], drawId: m.drawId || '', drawKey: m.drawKey || '',
  });
}

// 'official' 正式 | 'pending' 日常比赛待对手确认 | 'invalid' 不是云函数写入的赛事记录（不展示、不计入）
// verified: { 比赛 _id: { snap } }
function statusOf(m, verified) {
  if (m.drawId && !m._openid) return 'official';
  const v = verified && verified[m._id];
  if (v && v.snap === snapOf(m)) return 'official';
  return m.drawId ? 'invalid' : 'pending';
}

const META_ID = '__legacy_migrated__'; // verified 集合里标记「旧记录已迁移」的文档

module.exports = { canon, snapOf, statusOf, META_ID };
