// 「这场为什么涨分 / 掉分」：utils/rating.js 的 explain（这一场实际参与计算的数据）和 whyOf（解释文字），
// 以及比赛详情页只给本人看自己参加的正式比赛
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const R = require('../utils/rating');
const ID = require('../utils/ident');

const T = [];
const test = (name, fn) => T.push({ name, fn });
const plain = (v) => JSON.parse(JSON.stringify(v));
const round2 = (x) => Math.round(x * 100) / 100;

// 单打 / 双打一场：aKeys / bKeys 是统计身份（这里直接用用户 ID）
let seq = 0;
const one = (a, b, winner, sets, o) => Object.assign({
  _id: 'm' + (++seq), date: '2026-11-' + String(10 + seq).padStart(2, '0'), createdAt: seq,
  a, b, aKeys: a, bKeys: b, winner, sets, outcome: 'normal',
}, o || {});
// 让每个人先打满 5 场（过了定级期）、水平分不变：和同水平的陪练打成 5:5（得局率 = 预期）。返回 { pre: 这些比赛, start: 起始水平（含陪练） }
function settled(levels) {
  const pre = [], start = Object.assign({}, levels);
  Object.keys(levels).forEach((k) => { for (let i = 0; i < 5; i++) { start['pad' + k + i] = levels[k]; pre.push(one([k], ['pad' + k + i], 'a', [{ a: 5, b: 5 }])); } });
  return { pre, start };
}
const why = (list, start, id, key) => { const r = R.computeRatings(list, start); return { r, w: R.whyOf(r, id, key), x: r.explain[id][key] }; };
const noNumbers = (w) => [w.reason, w.tierText].concat(w.notes).forEach((t) => assert.ok(!/\d\.\d\d|[+-]\d/.test(t), '界面文字不显示水平分的变化数字：' + t));

test('输球涨分：输了但得局率高于赛前预期，水平分上升；档位变了写「2.5 → 3.0」', () => {
  const m = one(['me'], ['op'], 'b', [{ a: 4, b: 6 }]);
  const { w, x } = why([m], { me: 2.5, op: 3.5 }, m._id, 'me');
  assert.strictEqual(x.share, 0.4);
  assert.ok(Math.abs(x.expected - R.expectedShare(2.5, 3.5)) < 1e-12);
  assert.ok(x.share > x.expected && x.delta > 0 && !x.won);
  assert.deepStrictEqual([w.dir, w.arrow, w.title], ['up', '↑', '水平分上升']);
  assert.strictEqual(w.reason, '这场输了，但你的得局率高于赛前预期，水平分上升了');
  assert.strictEqual(w.tierText, `显示档位 2.5 → ${R.fmt(x.after)}`);
  assert.notStrictEqual(R.fmt(x.after), '2.5');
  assert.deepStrictEqual([w.shareText, w.expectedText], ['4/10 局 · 40%', `${Math.round(x.expected * 100)}%`]);
  assert.deepStrictEqual([w.mineLv, w.oppLv], ['2.5', '3.5']);
  noNumbers(w);
});

test('赢球掉分：赢了但局数低于赛前预期，水平分下降（分差不到 0.5，没有规则介入）', () => {
  const { pre, start } = settled({ me: 3.4, op: 3.0 });
  const m = one(['me'], ['op'], 'a', [{ a: 6, b: 5 }]);
  const { w, x } = why(pre.concat(m), start, m._id, 'me');
  assert.strictEqual(x.before, 3.4, '陪练场次没有改变水平分');
  assert.ok(x.won && x.share < x.expected && x.delta < 0 && !x.farm && !x.prov);
  assert.strictEqual(w.reason, '这场赢了，但你拿到的局数低于赛前预期，水平分下降了');
  assert.deepStrictEqual([w.dir, w.arrow, w.prov, w.provText], ['down', '↓', false, '']);
  assert.ok(!w.notes.some((t) => /0\.5/.test(t)), '分差规则没有生效就不提');
  noNumbers(w);
});

test('分差规则限制涨分：赛前高出对手 0.5 以上，赢球按得局率本来会涨，实际不加分；规则没改变结果时不提', () => {
  const { pre, start } = settled({ me: 4.0, op: 3.0 });
  const big = one(['me'], ['op'], 'a', [{ a: 6, b: 0 }]);
  const { w, x } = why(pre.concat(big), start, big._id, 'me');
  assert.ok(x.raw > 0 && x.delta === 0 && x.farm && x.after === x.before, '计算结果确实被规则压成 0');
  assert.deepStrictEqual([w.dir, w.arrow, w.title], ['flat', '', '水平分没有变化']);
  assert.match(w.reason, /按得局率本来会上升/);
  assert.match(w.reason, /高出对手 0\.5 以上赢球不加分/);
  assert.strictEqual(w.tierText, '显示档位仍为 4.0');
  // 同样分差，但赢得少（得局率低于预期）：本来就是下降，规则不起作用，不说这条规则
  const thin = one(['me'], ['op'], 'a', [{ a: 6, b: 4 }]);
  const t = why(pre.concat(thin), start, thin._id, 'me');
  assert.ok(!t.x.farm && t.x.delta < 0);
  assert.strictEqual(t.w.reason, '这场赢了，但你拿到的局数低于赛前预期，水平分下降了');
  assert.ok(!/0\.5/.test([t.w.reason].concat(t.w.notes).join('')));
  // 输的一方照常按得局率算
  assert.strictEqual(R.whyOf(R.computeRatings(pre.concat(big), start), big._id, 'op').dir, 'down');
});

test('档位未变：内部水平分变了，按 0.5 档显示还是 3.0，写「本场水平分有变化，显示档位仍为 3.0」', () => {
  const { pre, start } = settled({ me: 3.0, op: 3.0 });
  const m = one(['me'], ['op'], 'a', [{ a: 6, b: 4 }]);
  const { w, x } = why(pre.concat(m), start, m._id, 'me');
  assert.ok(x.after !== x.before && R.fmt(x.after) === '3.0' && R.fmt(x.before) === '3.0');
  assert.strictEqual(w.tierText, '本场水平分有变化，显示档位仍为 3.0');
  assert.strictEqual(w.reason, '这场赢了，你的得局率也高于赛前预期，水平分上升了');
  // 得局率和预期一样：没有变化
  const even = one(['me'], ['op'], 'a', [{ a: 5, b: 5 }]);
  const e = why(pre.concat(even), start, even._id, 'me');
  assert.deepStrictEqual([e.w.dir, e.w.tierText], ['flat', '显示档位仍为 3.0']);
  assert.strictEqual(e.w.reason, '你的得局率和赛前预期几乎一样，水平分基本没有变化');
});

test('双打：用双方队伍水平（两人平均）解释，「你们」，同队两人变化相同', () => {
  const m = one(['me', 'pa'], ['o1', 'o2'], 'a', [{ a: 6, b: 4 }], { type: 'double' });
  const r = R.computeRatings([m], { me: 3.0, pa: 2.0, o1: 3.0, o2: 3.0 });
  const w = R.whyOf(r, m._id, 'me'), x = r.explain[m._id].me;
  assert.strictEqual(x.mine, 2.5); assert.strictEqual(x.opp, 3.0);
  assert.ok(Math.abs(x.expected - R.expectedShare(2.5, 3.0)) < 1e-12);
  assert.strictEqual(r.explain[m._id].pa.delta, x.delta, '同队两人变化相同');
  assert.ok(w.double);
  assert.deepStrictEqual([w.mineLv, w.oppLv], ['2.5', '3.0']);
  assert.strictEqual(w.reason, '这场赢了，你们的得局率也高于赛前预期，水平分上升了');
  assert.ok(w.notes.some((t) => /两人平均/.test(t)));
  // 对方队伍：输了且得局率低于预期
  assert.strictEqual(R.whyOf(r, m._id, 'o1').reason, '这场输了，你们的得局率低于赛前预期，水平分下降了');
});

test('定级中沿用「定级中 N/5」；局数少按比例、到了上下限才附说明', () => {
  const list = [];
  for (let i = 0; i < 6; i++) list.push(one(['me'], ['op' + i], i % 2 ? 'a' : 'b', [{ a: 6, b: 4 }]));
  const r = R.computeRatings(list, {});
  assert.deepStrictEqual(list.map((m) => R.whyOf(r, m._id, 'me').provText), ['定级中 1/5', '定级中 2/5', '定级中 3/5', '定级中 4/5', '定级中 5/5', '']);
  assert.match(R.whyOf(r, list[0]._id, 'me').provNote, /前 5 场是定级期/);
  const short = one(['me'], ['op'], 'a', [{ a: 4, b: 1 }]);
  assert.ok(why([short], {}, short._id, 'me').w.notes.indexOf('这场一共 5 局（不到 10 局），变化幅度按 5/10 计算') >= 0);
  assert.ok(!why([list[0]], {}, list[0]._id, 'me').w.notes.some((t) => /不到 10 局/.test(t)), '10 局及以上不提');
  // 上限：涨到 7.0 停住；已经在 7.0 就没有变化
  const top = one(['me'], ['op'], 'a', [{ a: 6, b: 0 }]);
  const near = why([top], { me: 6.95, op: 6.95 }, top._id, 'me');
  assert.ok(near.x.clamped && near.x.after === 7);
  assert.strictEqual(near.w.dir, 'up');
  assert.ok(near.w.notes.some((t) => /上限 7\.0/.test(t)));
  const at = why([top], { me: 7.0, op: 7.0 }, top._id, 'me');
  assert.deepStrictEqual([at.w.dir, at.w.reason], ['flat', '水平分已经到了上限 7.0，这场没有再变化']);
});

test('用的是这一场实际参与计算的数据：赛前水平是当时的（不按今天的等级倒推），和战绩列表的箭头、等级记录一致；不改变原来的计算结果', () => {
  const list = [one(['me'], ['op'], 'b', [{ a: 2, b: 6 }]), one(['me'], ['op'], 'a', [{ a: 6, b: 1 }]), one(['me'], ['op'], 'b', [{ a: 3, b: 6 }])];
  const r = R.computeRatings(list, { me: 3.0, op: 3.0 });
  const xs = list.map((m) => r.explain[m._id].me);
  assert.strictEqual(xs[0].before, 3.0, '第一场用起始水平，不是今天的等级');
  assert.strictEqual(xs[1].before, xs[0].after); assert.strictEqual(xs[2].before, xs[1].after);
  list.forEach((m, i) => {
    assert.strictEqual(r.deltas[m._id].me, round2(xs[i].delta));
    assert.strictEqual(R.whyOf(r, m._id, 'me').arrow, R.fmtDelta(r.deltas[m._id].me), '和战绩列表的 ↑ / ↓ 一样');
    assert.strictEqual(r.players.me.history[i].level, round2(xs[i].after));
    assert.ok(Math.abs(r.pre[m._id].a - round2(xs[i].mine)) < 1e-9);
  });
  assert.strictEqual(r.players.me.level, round2(xs[2].after));
  // 弃权、退赛、没有局分的场次不参与计算，也就没有解释
  const wo = one(['me'], ['op'], 'a', [], { outcome: 'walkover' });
  const rt = one(['me'], ['op'], 'a', [{ a: 3, b: 1 }], { outcome: 'retired' });
  const empty = one(['me'], ['op'], 'a', []);
  const r2 = R.computeRatings(list.concat([wo, rt, empty]), { me: 3.0, op: 3.0 });
  [wo, rt, empty].forEach((m) => { assert.strictEqual(R.whyOf(r2, m._id, 'me'), null); assert.strictEqual(r2.explain[m._id], undefined); });
  assert.strictEqual(r2.players.me.level, r.players.me.level, '不计分的场次不影响结果');
  assert.strictEqual(R.whyOf(r, 'nope', 'me'), null);
  assert.strictEqual(R.whyOf(r, list[0]._id, 'stranger'), null);
});

/* ---------- 比赛详情页 ---------- */
function loadPage(deps) {
  const filename = path.resolve(__dirname, '../pages/match/match.js');
  let def;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (id) => deps[id] || createRequire(filename)(id), wx: { navigateTo() {} }, Page: (d) => { def = d; }, console, setTimeout() {},
  });
  return Object.assign({}, def, { data: plain(def.data), setData(p) { Object.assign(this.data, p); } });
}

test('比赛详情页：只给本人看自己参加的正式比赛；弃权、退赛、没有局分只说明能确认的状态；不是自己的、不在正式战绩里的不显示', async () => {
  const players = [{ name: '我', uid: 'me', self: true, level: 2.5 }, { name: '对手', uid: 'op', self: true, level: 3.5 }, { name: '路人', uid: 'x', self: true }];
  const raw = (id, o) => Object.assign({ _id: id, date: '2026-11-20', createdAt: 1, a: ['我'], b: ['对手'], aIds: ['me'], bIds: ['op'], winner: 'b', sets: [{ a: 4, b: 6 }], outcome: 'normal' }, o || {});
  const rows = {
    up: raw('up'),
    wo: raw('wo', { outcome: 'walkover', sets: [] }),
    rt: raw('rt', { outcome: 'retired', sets: [{ a: 2, b: 1 }] }),
    empty: raw('empty', { sets: [] }),
    pending: raw('pending'),
    legacy: raw('legacy', { aIds: [], a: ['老名字'] }),
  };
  const official = ID.normalizeMatches(['up', 'wo', 'rt', 'empty', 'legacy'].map((k) => rows[k]), players);
  const open = async (id, me) => {
    const p = loadPage({
      '../../utils/cloud': { call: async () => ({ match: rows[id], status: id === 'pending' ? 'pending' : 'official' }) },
      '../../utils/db': {
        fetchPlayersFull: async () => players, cachedPlayersFull: () => players, myOpenid: async () => me,
        fetchMatches: async () => official, cachedMatches: () => official,
      },
    });
    p.id = id;
    await p.load();
    assert.strictEqual(p.data.error, '', p.data.error);
    return p;
  };
  const p = await open('up', 'me');
  assert.strictEqual(p.data.why.reason, '这场输了，但你的得局率高于赛前预期，水平分上升了');
  assert.strictEqual(p.data.why.arrow, '↑');
  assert.strictEqual(p.data.whyOpen, false);
  p.toggleWhy();
  assert.strictEqual(p.data.whyOpen, true);
  assert.strictEqual((await open('up', 'op')).data.why.reason, '这场赢了，但你拿到的局数低于赛前预期，水平分下降了');
  assert.strictEqual((await open('up', 'x')).data.why, null, '没参加的人看不到');
  assert.strictEqual((await open('up', '')).data.why, null);
  const wo = (await open('wo', 'me')).data.why, rt = (await open('rt', 'me')).data.why, em = (await open('empty', 'me')).data.why;
  assert.strictEqual(wo.noneTitle, '本场未计入水平分'); assert.match(wo.none, /^弃权：.*不计入水平分/);
  assert.strictEqual(rt.noneTitle, '本场未计入水平分'); assert.match(rt.none, /^中途退赛：.*不计入水平分/);
  assert.strictEqual(em.noneTitle, '本场未计入水平分'); assert.match(em.none, /没有可用的局分记录/);
  assert.ok(/why\.noneTitle/.test(fs.readFileSync(path.resolve(__dirname, '../pages/match/match.wxml'), 'utf8')), '页面显示「本场未计入水平分」标题');
  assert.strictEqual((await open('pending', 'me')).data.why, null, '不在正式战绩里不显示');
  assert.strictEqual((await open('legacy', 'op')).data.why.dir !== undefined, true, '对方有账号照常显示');
  // 页面上等级只经 R.fmt，涨跌只有箭头；展开按钮用 .btn-line mini
  const xml = fs.readFileSync(path.resolve(__dirname, '../pages/match/match.wxml'), 'utf8');
  assert.ok(/wx:if="\{\{why\}\}"[\s\S]*只有你自己能看到/.test(xml));
  assert.ok(/class="btn-line mini"[^>]*bindtap="toggleWhy"/.test(xml));
  const js = fs.readFileSync(path.resolve(__dirname, '../pages/match/match.js'), 'utf8') + fs.readFileSync(path.resolve(__dirname, '../utils/rating.js'), 'utf8');
  assert.ok(!/delta\.toFixed|level\.toFixed|after\.toFixed|before\.toFixed/.test(js));
});

module.exports = T;
