// 抽签算法：淘汰赛签表（含种子、轮空）和小组分组

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function nextPow2(n) { let p = 1; while (p < n) p *= 2; return p; }

// 标准签表顺序：order[签位] = 该签位对应的种子排名
// 8 签 → [1,8,5,4,3,6,7,2]：1 号在最上，2 号在最下，1、2 号只会在决赛相遇
function bracketOrder(n) {
  let arr = [1];
  while (arr.length < n) {
    const size = arr.length * 2, out = [];
    arr.forEach((x, i) => {
      if (i % 2 === 0) out.push(x, size + 1 - x); else out.push(size + 1 - x, x);
    });
    arr = out;
  }
  return arr;
}

// 一个签表最多允许几个种子
function maxSeeds(mode, size, count) {
  if (mode === 'groups') return Math.min(count, size * 2); // 每组最多 2 个种子
  return Math.min(count, nextPow2(size) / 2);
}

/**
 * 淘汰赛抽签
 * entrants: 全部参赛者名字；seeds: 种子名字（按 1 号、2 号…排序）；drawSize: 签数（8/12/16/24/32）
 * 返回 lines：每个签位 { name, seed? } 或 { bye: true }
 */
function makeBracket(entrants, seeds, drawSize) {
  const P = entrants.length, n = nextPow2(drawSize);
  if (P < 2) throw new Error('至少需要 2 名参赛者');
  if (P > drawSize) throw new Error(`参赛人数 ${P} 超过了 ${drawSize} 签`);
  if (seeds.length > n / 2) throw new Error(`${drawSize} 签最多设 ${n / 2} 个种子`);

  const order = bracketOrder(n);
  const lines = new Array(n).fill(null);

  // 1. 种子：1 号、2 号固定位置；3-4 号、5-8 号、9-16 号在各自的位置组里随机
  let lo = 1;
  while (lo <= seeds.length) {
    const hi = lo <= 2 ? lo : (lo - 1) * 2;
    const idx = [];
    order.forEach((r, i) => { if (r >= lo && r <= hi) idx.push(i); });
    const pos = shuffle(idx);
    seeds.slice(lo - 1, hi).forEach((name, k) => { lines[pos[k]] = { name, seed: lo + k }; });
    lo = hi + 1;
  }

  // 2. 轮空：先按种子顺序给 1 号、2 号…种子轮空；种子不够时，剩下的轮空放在排名最高的空签位对面
  let B = n - P;
  for (let s = 1; s <= seeds.length && B > 0; s++) {
    const i = lines.findIndex((x) => x && x.seed === s);
    lines[i ^ 1] = { bye: true }; B--;
  }
  const byRank = order.map((r, i) => ({ r, i })).sort((x, y) => y.r - x.r);
  for (const { i } of byRank) {
    if (B <= 0) break;
    const partner = lines[i ^ 1];
    if (!lines[i] && !(partner && partner.bye)) { lines[i] = { bye: true }; B--; }
  }
  // 人数不到签数一半时（如 8 签只有 2 人），轮空只能互相对上：剩下的轮空按排名填进空位
  for (const { i } of byRank) {
    if (B <= 0) break;
    if (!lines[i]) { lines[i] = { bye: true }; B--; }
  }

  // 3. 其他人随机填入剩下的签位
  const rest = shuffle(entrants.filter((x) => seeds.indexOf(x) < 0));
  let k = 0;
  for (let i = 0; i < n; i++) if (!lines[i]) lines[i] = { name: rest[k++] };
  return lines;
}

/**
 * 小组分组：种子蛇形分布（1→A, 2→B, 3→C, 4→C, 5→B…），其余随机均匀分配
 */
function makeGroups(entrants, seeds, groupCount) {
  const g = groupCount;
  if (entrants.length < g * 2) throw new Error(`分 ${g} 组至少需要 ${g * 2} 人`);
  const groups = [];
  for (let i = 0; i < g; i++) groups.push({ name: String.fromCharCode(65 + i) + ' 组', members: [] });
  seeds.forEach((name, i) => {
    const round = Math.floor(i / g), p = i % g;
    groups[round % 2 === 0 ? p : g - 1 - p].members.push({ name, seed: i + 1 });
  });
  shuffle(entrants.filter((x) => seeds.indexOf(x) < 0)).forEach((name) => {
    let min = Infinity;
    groups.forEach((x) => { min = Math.min(min, x.members.length); });
    const cands = groups.filter((x) => x.members.length === min);
    cands[Math.floor(Math.random() * cands.length)].members.push({ name });
  });
  return groups;
}

function roundName(players) {
  if (players === 2) return '决赛';
  if (players === 4) return '半决赛';
  if (players === 8) return '1/4 决赛';
  return `${players} 强`;
}

/**
 * 把签表 + 已录入的胜者，展开成每一轮的对阵（轮空自动晋级）
 * results: { '轮-场': 'a' | 'b' }（旧数据）
 * lookup(key, a, b): 返回这场已录入的 { winner, sets, id }，没有就返回 null
 */
function bracketView(lines, results, lookup, prefix) {
  prefix = prefix || ''; // 小组赛＋淘汰赛里，淘汰赛场次用 'k' 前缀，和小组赛场次区分
  results = results || {};
  const rounds = [];
  let cur = lines.map((x) => Object.assign({}, x));
  let r = 0;
  while (cur.length > 1) {
    const matches = [], next = [];
    for (let i = 0; i < cur.length; i += 2) {
      const a = cur[i], b = cur[i + 1], key = `${prefix}${r}-${i / 2}`;
      const known = (x) => x && x.name;
      let w = null, auto = false, hit = null;
      if (known(a) && b.bye) { w = 'a'; auto = true; }
      else if (known(b) && a.bye) { w = 'b'; auto = true; }
      else if (known(a) && known(b)) {
        // 优先用录入的比分记录；旧签表里发起人直接选的胜者作为兜底
        hit = lookup ? lookup(key, a, b) : null;
        if (hit) w = hit.winner;
        else if (results[key] === 'a' || results[key] === 'b') w = results[key];
      }
      const hasBye = !!(a.bye || b.bye);
      matches.push({
        key, r, i: i / 2, auto, hasBye, sets: hit ? hit.sets : [], recordId: hit ? hit.id : '',
        outcome: hit ? hit.outcome || 'normal' : '', resolution: hit ? hit.resolution || null : null, virtual: !!(hit && hit.virtual),
        ready: !!(known(a) && known(b)),
        a: Object.assign({}, a, { win: w === 'a', lose: w === 'b' }),
        b: Object.assign({}, b, { win: w === 'b', lose: w === 'a' }),
      });
      if (w) next.push({ name: (w === 'a' ? a : b).name, seed: (w === 'a' ? a : b).seed });
      else if (a.bye && b.bye) next.push({ bye: true });
      else next.push({ tbd: true });
    }
    rounds.push({ name: roundName(cur.length), matches });
    cur = next;
    r++;
  }
  const champ = cur[0] && cur[0].name ? cur[0] : null;
  return { rounds, champion: champ };
}

// 改了某一场的结果后，它后面要用到这个结果的场次都要清掉
function clearDownstream(results, r, i, totalRounds) {
  const out = Object.assign({}, results);
  let rr = r + 1, ii = Math.floor(i / 2);
  while (rr < totalRounds) { delete out[`${rr}-${ii}`]; rr++; ii = Math.floor(ii / 2); }
  return out;
}

// 小组内循环赛对阵
function groupView(groups) {
  return (groups || []).map((g) => {
    const fixtures = [];
    for (let i = 0; i < g.members.length; i++) {
      for (let j = i + 1; j < g.members.length; j++) fixtures.push(`${g.members[i].name} vs ${g.members[j].name}`);
    }
    return { name: g.name, members: g.members, fixtures };
  });
}

module.exports = { shuffle, nextPow2, bracketOrder, maxSeeds, makeBracket, makeGroups, bracketView, clearDownstream, groupView, roundName };
