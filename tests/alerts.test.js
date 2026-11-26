// 小程序里不漏消息（utils/alerts.js，1.3.0）：tab 角标 + 卡片小标签，全部在本机比较「现在」和「上次看过」
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const D = require('../utils/draw');
const T = [];
const test = (name, fn) => T.push({ name, fn });
const root = path.resolve(__dirname, '..');

// 每个测试一份新的模块实例 + 假的微信存储和角标
function fresh(store) {
  store = store || {};
  const badges = { act: '', dot: false, calls: [] };
  global.wx = {
    getStorageSync: (k) => store[k], setStorageSync: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
    setTabBarBadge: (o) => { badges.act = o.text; badges.calls.push(['set', o.index]); },
    removeTabBarBadge: (o) => { badges.act = ''; badges.calls.push(['remove', o.index]); },
    showTabBarRedDot: (o) => { badges.dot = true; badges.calls.push(['dot', o.index]); },
    hideTabBarRedDot: (o) => { badges.dot = false; badges.calls.push(['nodot', o.index]); },
  };
  const file = require.resolve('../utils/alerts');
  delete require.cache[file];
  return { A: require(file), store, badges };
}
const done = () => { delete global.wx; };

const sign = (id, o) => Object.assign({ _id: id, title: id, status: 'signup', type: 'single', mode: 'bracket', size: 8, date: '2026-12-06', startTime: '19:30' }, o);
const ENTS = ['我', '阿哲', '小雨', '林晨'];
const LINES = D.makeBracket(ENTS, [], 4); // 随机排签：固定用同一份，「我」在哪一场下面现查
const drawn = (id, o) => Object.assign({
  _id: id, title: id, status: 'drawn', type: 'single', mode: 'bracket', size: 4, date: '2026-12-06', startTime: '19:30',
  entrants: ENTS, lines: LINES, uidOf: { 我: 'me', 阿哲: 'u2', 小雨: 'u3', 林晨: 'u4' }, drawVersion: 1,
}, o);
const su = (drawId, waiting) => (waiting === undefined ? { _id: 's-' + drawId, drawId, _openid: 'me' } : { _id: 's-' + drawId, drawId, _openid: 'me', waiting });
const tagOf = (A, id) => (A.drawTagOf(id) || {}).text || '';

test('第一次只记底、不提示；之后新发布的报名中活动标「新活动」，点进详情（seeDraw）就消失，「活动」tab 数字跟着变', () => {
  const { A, badges } = fresh();
  A.updateDraws([sign('a'), drawn('b')], [], [], 'me');
  assert.strictEqual(tagOf(A, 'a'), '', '升级后第一次：只记底');
  assert.strictEqual(badges.act, '');
  A.updateDraws([sign('n1'), sign('n2', { endedAt: 5 }), drawn('n3', { uidOf: {} }), sign('a'), drawn('b')], [], [], 'me');
  assert.deepStrictEqual([tagOf(A, 'n1'), tagOf(A, 'n2'), tagOf(A, 'n3')], ['新活动', '', ''], '已提前结束的、和我无关的已生成对阵不算新');
  assert.strictEqual(badges.act, '1');
  assert.deepStrictEqual(badges.calls[badges.calls.length - 1], ['set', A.ACT_TAB]);
  const v = A.version();
  A.seeDraw(sign('n1'), 'me', [], []);
  assert.strictEqual(tagOf(A, 'n1'), '');
  assert.ok(A.version() > v, '页面据此重画');
  assert.strictEqual(badges.act, '');
  A.updateDraws([sign('n1'), sign('a'), drawn('b')], [], [], 'me');
  assert.strictEqual(tagOf(A, 'n1'), '', '看过的不再提示');
  // 我已经报名了（比如在别的手机上报的）：不算「新活动」
  A.updateDraws([sign('n4'), sign('n1')], [], [su('n4')], 'me');
  assert.strictEqual(tagOf(A, 'n4'), '');
  done();
});

test('候补：在候补 → 名单里「已递补」，名单里 → 候补「进入候补」；旧版云函数（没有 waiting）不出这两种', () => {
  const { A } = fresh();
  A.updateDraws([sign('a'), sign('b'), sign('c')], [], [su('a', true), su('b', false), su('c')], 'me');
  A.updateDraws([sign('a'), sign('b'), sign('c')], [], [su('a', false), su('b', true), su('c')], 'me');
  assert.deepStrictEqual([tagOf(A, 'a'), tagOf(A, 'b'), tagOf(A, 'c')], ['已递补', '进入候补', '']);
  // 又变回去：和看过的一样，标签消失
  A.updateDraws([sign('a'), sign('b'), sign('c')], [], [su('a', true), su('b', false), su('c', true)], 'me');
  assert.deepStrictEqual([tagOf(A, 'a'), tagOf(A, 'b'), tagOf(A, 'c')], ['', '', ''], '旧版（null）→ 新版：不提示');
  // 活动详情读完：按完整名单算候补，记成看过（和云端 waiting 同一算法）
  const two = sign('t', { size: 1 });
  const list = [{ _id: 'x1', drawId: 't', _openid: 'u2', createdAt: 1 }, { _id: 's-t', drawId: 't', _openid: 'me', createdAt: 2 }];
  A.updateDraws([two], [], [su('t', true)], 'me');
  A.seeDraw(two, 'me', list, []);
  A.updateDraws([two], [], [su('t', false)], 'me');
  assert.strictEqual(tagOf(A, 't'), '已递补');
  done();
});

test('对阵已出：我报名的活动生成对阵、重新排对阵；对阵里没有我的不提示', () => {
  const { A } = fresh();
  A.updateDraws([sign('k'), sign('o')], [], [su('k'), su('o')], 'me');
  A.updateDraws([drawn('k'), drawn('o', { uidOf: { 阿哲: 'u2' } })], [], [su('k'), su('o')], 'me');
  assert.deepStrictEqual([tagOf(A, 'k'), tagOf(A, 'o')], ['对阵已出', '']);
  A.seeDraw(drawn('k'), 'me', [], []);
  A.updateDraws([drawn('k', { drawVersion: 2 })], [], [], 'me');
  assert.strictEqual(tagOf(A, 'k'), '对阵已出', '重新排了对阵');
  // 管理员直接带名单建的活动（第一次见就已经有我）
  A.updateDraws([drawn('k', { drawVersion: 2 }), drawn('z')], [], [], 'me');
  assert.strictEqual(tagOf(A, 'z'), '对阵已出');
  done();
});

test('时间有变：活动日期 / 开始时间 / 地点、我的场次的单场安排变了；别人的场次、新出现的场次不算；和我无关的活动不算', () => {
  const { A } = fresh();
  const base = drawn('k');
  A.updateDraws([base, drawn('o', { uidOf: {} })], [], [], 'me');
  A.updateDraws([drawn('k', { startTime: '20:00' }), drawn('o', { uidOf: {}, startTime: '20:00' })], [], [], 'me');
  assert.deepStrictEqual([tagOf(A, 'k'), tagOf(A, 'o')], ['时间有变', '']);
  A.seeDraw(drawn('k', { startTime: '20:00' }), 'me', [], []);
  // 别人的场次改了场地：不提示；我的场次改了时间：提示；还没定对手的下一轮不算我的
  const sched = require('../utils/event').scheduleOf(drawn('k'), []);
  const mine = sched.find((x) => x.aMembers.concat(x.bMembers).indexOf('我') >= 0).key;
  const other = sched.find((x) => x.aMembers.length && x.aMembers.concat(x.bMembers).indexOf('我') < 0).key;
  A.updateDraws([drawn('k', { startTime: '20:00', slots: { [other]: { court: '3' }, '1-0': { time: '22:00' } } })], [], [], 'me');
  assert.strictEqual(tagOf(A, 'k'), '');
  A.updateDraws([drawn('k', { startTime: '20:00', slots: { [mine]: { time: '21:00' } } })], [], [], 'me');
  assert.strictEqual(tagOf(A, 'k'), '时间有变');
  // 地点（地图选点）变了
  const { A: B } = fresh();
  B.updateDraws([sign('p')], [], [su('p')], 'me');
  B.updateDraws([sign('p', { location: { latitude: 31.2, longitude: 121.4 }, place: { name: '球场', address: '某路' } })], [], [su('p')], 'me');
  assert.strictEqual(tagOf(B, 'p'), '时间有变');
  done();
});

test('已提前结束；同时有几种变化只显示最重要的一个（已递补 > 对阵已出 > 新活动 > 时间有变 > 进入候补 > 已提前结束）', () => {
  const { A } = fresh();
  A.updateDraws([drawn('k'), sign('w')], [], [su('w', true)], 'me');
  A.updateDraws([drawn('k', { endedAt: 9 }), sign('w', { date: '2026-12-07' })], [], [su('w', false)], 'me');
  assert.deepStrictEqual([tagOf(A, 'k'), tagOf(A, 'w')], ['已提前结束', '已递补']);
  A.updateDraws([drawn('k', { endedAt: 9, drawVersion: 3, date: '2026-12-08' })], [], [], 'me');
  assert.strictEqual(tagOf(A, 'k'), '对阵已出');
  assert.deepStrictEqual(A.ORDER.map((k) => A.TAGS[k].text), ['已递补', '对阵已出', '新活动', '时间有变', '进入候补', '已提前结束']);
  done();
});

test('比赛：别人录了「新」、别人改了「比分有改动」；我自己录的 / 改的不提示；离开战绩页算看过；看战绩时小红点收起', () => {
  const { A, badges } = fresh();
  const m = (id, o) => Object.assign({ _id: id, aIds: ['me'], bIds: ['u2'], sets: [{ a: 6, b: 3 }], winner: 'a', recordedBy: 'u2', createdAt: 1 }, o);
  A.updateMatches([m('old')], 'me');
  assert.strictEqual(A.matchTagOf('old'), '', '第一次只记底');
  A.updateMatches([m('old'), m('n1', { createdAt: 2 }), m('mine', { recordedBy: 'me', createdAt: 3 }), m('x', { aIds: ['u3'], createdAt: 4 })], 'me');
  assert.deepStrictEqual([A.matchTagOf('n1'), A.matchTagOf('mine'), A.matchTagOf('x')], ['新', '', ''], '我录的、和我无关的不提示');
  assert.strictEqual(badges.dot, true);
  assert.deepStrictEqual(badges.calls[badges.calls.length - 1], ['dot', A.MATCH_TAB]);
  A.viewMatches(true);
  assert.strictEqual(badges.dot, false, '正在看战绩：小红点收起');
  A.seeMatches('me');
  A.viewMatches(false);
  assert.strictEqual(A.matchTagOf('n1'), '');
  assert.strictEqual(badges.dot, false);
  // 改比分：别人改的提示，我改的不提示
  const edited = m('n1', { createdAt: 2, sets: [{ a: 6, b: 4 }], lastChange: { how: 'edit', by: 'u2' } });
  const mineEdit = m('old', { sets: [{ a: 6, b: 0 }], lastChange: { how: 'edit', by: 'me' } });
  A.updateMatches([mineEdit, edited, m('mine', { recordedBy: 'me', createdAt: 3 })], 'me');
  assert.deepStrictEqual([A.matchTagOf('n1'), A.matchTagOf('old')], ['比分有改动', '']);
  // 管理员更正（lastChange.by 是管理员）也算别人改的
  A.seeMatches('me');
  A.updateMatches([m('old', { sets: [{ a: 7, b: 5 }], lastChange: { how: 'admin', by: 'admin' } })], 'me');
  assert.strictEqual(A.matchTagOf('old'), '比分有改动');
  done();
});

test('换账号不串、退出成员身份（reset）清掉；读取失败（不是数组）保留上次的；本机记录按账号存', () => {
  const store = {};
  const { A, badges } = fresh(store);
  A.updateDraws([sign('a')], [], [], 'me');
  A.updateDraws([sign('a'), sign('b')], [], [], 'me');
  assert.strictEqual(tagOf(A, 'b'), '新活动');
  A.updateDraws(null, [], [], 'me');
  A.updateDraws([sign('a')], [], null, 'me');
  assert.strictEqual(tagOf(A, 'b'), '新活动', '读取失败不更新');
  // 换成另一个账号：重新记底，不带出上一个人的标签
  A.updateDraws([sign('a'), sign('b'), sign('c')], [], [], 'u9');
  assert.deepStrictEqual([tagOf(A, 'b'), tagOf(A, 'c')], ['', '']);
  assert.strictEqual(store[A.KEY].uid, 'u9');
  A.reset();
  assert.strictEqual(badges.act, '');
  // 冷启动（新的模块实例）读本机记录：同一账号接着比
  const again = fresh(store);
  again.A.updateDraws([sign('a'), sign('b'), sign('c'), sign('d')], [], [], 'u9');
  assert.strictEqual(tagOf(again.A, 'd'), '新活动');
  done();
});

test('Gemini 审查后补的：自己建的活动不算新；删除后撤回不误报；退赛了的活动不再提示；「我的下一场」只看这一场；比赛水位线', () => {
  const { A } = fresh();
  A.updateDraws([sign('a'), drawn('k')], [], [], 'me');
  // 管理员自己建的（报名中、还没点开）：不标「新活动」
  A.updateDraws([sign('a'), drawn('k'), sign('mine', { _openid: 'me' })], [], [], 'me');
  assert.strictEqual(tagOf(A, 'mine'), '');
  // 删除（列表里暂时没有）后 5 分钟内撤回：看过的记录还在，不误报「新活动 / 对阵已出」
  A.updateDraws([drawn('k')], [], [], 'me');
  A.updateDraws([sign('a'), drawn('k')], [], [], 'me');
  assert.deepStrictEqual([tagOf(A, 'a'), tagOf(A, 'k')], ['', '']);
  // 我退赛了：之后改时间不提示
  const out = { withdrawals: [{ entrant: '我' }] };
  A.updateDraws([drawn('k', out)], [], [], 'me');
  A.updateDraws([drawn('k', Object.assign({ startTime: '21:00' }, out))], [], [], 'me');
  assert.strictEqual(tagOf(A, 'k'), '');
  // 「我的下一场」：同一活动别的场次变了不标，这一场或活动级变了才标
  const { A: B } = fresh();
  const sched = require('../utils/event').scheduleOf(drawn('k'), []);
  const mineKey = sched.find((x) => x.aMembers.concat(x.bMembers).indexOf('我') >= 0).key;
  B.updateDraws([drawn('k')], [], [], 'me');
  B.updateDraws([drawn('k', { slots: { [mineKey]: { time: '21:00' } } })], [], [], 'me');
  assert.deepStrictEqual([B.nextMoved('k', mineKey), B.nextMoved('k', 'zz')], [true, false]);
  B.updateDraws([drawn('k', { slots: { [mineKey]: { time: '21:00' } }, date: '2026-12-09' })], [], [], 'me');
  assert.strictEqual(B.nextMoved('k', 'zz'), true, '活动日期变了：哪一场都算');
  // 比赛：只记最近 MAX_MATCHES 场；撤销最新一场后更早的一场顶进来，不算「新」
  const { A: M } = fresh();
  const mk = (i) => ({ _id: 'm' + i, aIds: ['me'], bIds: ['u2'], sets: [{ a: 6, b: 1 }], winner: 'a', recordedBy: 'u2', createdAt: i });
  const all = Array.from({ length: M.MAX_MATCHES + 1 }, (_, i) => mk(i + 1));
  M.updateMatches(all, 'me');
  M.updateMatches(all.slice(0, -1), 'me'); // 撤销最新的一场：m1 顶进最近 200 场
  assert.deepStrictEqual(M.matchTags(), {});
  M.updateMatches(all.slice(0, -1).concat(mk(999)), 'me');
  assert.deepStrictEqual(M.matchTags(), { m999: '新' }, '真正新录的照常提示');
  done();
});

test('Gemini 代码审查后补的：没标签时基线跟到最新（旧云函数升级后递补、被搭档带上后改时间、进下一轮后排时间都不漏）', () => {
  const E = require('../utils/event');
  // ① 旧版云函数（w = null）→ 新版在候补（不提示）→ 递补：要提示「已递补」
  const { A } = fresh();
  A.updateDraws([sign('a')], [], [su('a')], 'me');
  A.updateDraws([sign('a')], [], [su('a', true)], 'me');
  assert.strictEqual(tagOf(A, 'a'), '');
  A.updateDraws([sign('a')], [], [su('a', false)], 'me');
  assert.strictEqual(tagOf(A, 'a'), '已递补');
  // ② 看过、没报名 → 被搭档带上（不提示）→ 改开始时间：要提示「时间有变」
  const { A: B } = fresh();
  B.updateDraws([sign('b')], [], [], 'me');
  B.seeDraw(sign('b'), 'me', [], []);
  B.updateDraws([sign('b')], [], [{ _id: 'p1', drawId: 'b', _openid: 'u2', partnerId: 'me', waiting: false }], 'me');
  assert.strictEqual(tagOf(B, 'b'), '');
  B.updateDraws([sign('b', { startTime: '20:30' })], [], [{ _id: 'p1', drawId: 'b', _openid: 'u2', partnerId: 'me', waiting: false }], 'me');
  assert.strictEqual(tagOf(B, 'b'), '时间有变');
  // ③ 赢了第一轮、下一轮出现（不提示）→ 发起人给下一轮排时间：要提示「时间有变」
  const { A: K } = fresh();
  const d = drawn('k');
  const semi = E.scheduleOf(d, []).find((x) => x.aMembers.concat(x.bMembers).indexOf('我') >= 0);
  const side = semi.aMembers.indexOf('我') >= 0 ? 'a' : 'b';
  const won = { _id: 'w1', drawId: 'k', drawKey: semi.key, ea: semi.a, eb: semi.b, winner: side, sets: [side === 'a' ? { a: 4, b: 1 } : { a: 1, b: 4 }], createdAt: 5 };
  K.updateDraws([d], [], [], 'me');
  K.updateDraws([d], [won], [], 'me');
  const fin = E.scheduleOf(d, [won]).find((x) => !x.done && x.key !== semi.key && x.aMembers.concat(x.bMembers).indexOf('我') >= 0);
  assert.ok(fin, '我进了下一轮');
  assert.strictEqual(tagOf(K, 'k'), '');
  K.updateDraws([drawn('k', { slots: { [fin.key]: { time: '21:00' } } })], [won], [], 'me');
  assert.strictEqual(tagOf(K, 'k'), '时间有变');
  assert.strictEqual(K.nextMoved('k', fin.key), true);
  done();
});

test('Gemini 代码审查后补的：和我无关了的活动提前结束不提示；已提前结束的再改时间不提示；结束时顺手改时间显示「已提前结束」；我建的对阵不提示', () => {
  // 报名排在候补、对阵里没有我 → 提前结束：不提示
  const { A } = fresh();
  const out = drawn('k', { entrants: ['阿哲', '小雨', '林晨', '石头'], lines: D.makeBracket(['阿哲', '小雨', '林晨', '石头'], [], 4), uidOf: { 阿哲: 'u2', 小雨: 'u3', 林晨: 'u4', 石头: 'u5' } });
  A.updateDraws([sign('k')], [], [su('k', true)], 'me');
  A.updateDraws([out], [], [], 'me');
  assert.strictEqual(tagOf(A, 'k'), '');
  A.updateDraws([Object.assign({}, out, { endedAt: 9 })], [], [], 'me');
  assert.strictEqual(tagOf(A, 'k'), '');
  // 我在对阵里：提前结束同时改了开始时间 → 显示「已提前结束」；之后再改日期不提示
  const { A: B } = fresh();
  B.updateDraws([drawn('e')], [], [], 'me');
  B.updateDraws([drawn('e', { endedAt: 9, startTime: '08:00' })], [], [], 'me');
  assert.strictEqual(tagOf(B, 'e'), '已提前结束');
  B.seeDraw(drawn('e', { endedAt: 9, startTime: '08:00' }), 'me', [], []);
  B.updateDraws([drawn('e', { endedAt: 9, startTime: '08:00', date: '2026-12-31' })], [], [], 'me');
  assert.strictEqual(tagOf(B, 'e'), '');
  // 管理员自己带名单建的、已经生成对阵（里面有自己）：不标「对阵已出」
  const { A: C } = fresh();
  C.updateDraws([sign('a')], [], [], 'me');
  C.updateDraws([sign('a'), drawn('own', { _openid: 'me' })], [], [], 'me');
  assert.strictEqual(tagOf(C, 'own'), '');
  done();
});

test('Gemini 代码审查后补的：比赛「新 / 比分有改动」看最后一次是谁改的；坏数据和不完整的输入不出错、不更新', () => {
  const { A } = fresh();
  const mk = (id, o) => Object.assign({ _id: id, aIds: ['me'], bIds: ['u2'], sets: [{ a: 4, b: 1 }], winner: 'a', createdAt: 1 }, o);
  A.updateMatches([mk('m0', { recordedBy: 'u2' })], 'me');
  // 别人录的、我还没看到就自己改了：不提示；我录的、我还没看到就被别人改了：「比分有改动」
  A.updateMatches([mk('m1', { recordedBy: 'u2', lastChange: { by: 'me' }, createdAt: 2 }), mk('m2', { recordedBy: 'me', lastChange: { by: 'u2' }, createdAt: 3 }), mk('m0', { recordedBy: 'u2' })], 'me');
  assert.deepStrictEqual(A.matchTags(), { m2: '比分有改动' });
  // 活动：比赛没读到（不是数组）不更新；坐标缺经度不出错
  const { A: B } = fresh();
  B.updateDraws([sign('a')], [], [], 'me');
  B.updateDraws([sign('a'), sign('n')], null, [], 'me');
  assert.strictEqual(tagOf(B, 'n'), '', '比赛没读到：不更新');
  B.updateDraws([sign('a', { location: { latitude: 31.2 } }), sign('n')], [], [], 'me');
  assert.strictEqual(tagOf(B, 'n'), '新活动');
  // 换账号第一次记底：版本号照样变（页面会重画、去掉上一个账号的标签）
  const v = B.version();
  B.updateDraws([sign('a')], [], [], 'other');
  assert.ok(B.version() > v);
  done();
});

test('Gemini 代码审查后补的：列表里暂时没有的活动留最近消失的 MAX_GONE 个（活动再多也留着，删最早消失的）；详情页按这个活动的比赛、和云端同一候补口径记看过', () => {
  const { A, store } = fresh();
  const many = Array.from({ length: 400 }, (_, i) => drawn('d' + i));
  A.updateDraws(many, [], [], 'me');
  const g = A.MAX_GONE;
  // 一批一批消失：先消失 old0..，后消失 new0..
  A.updateDraws(many.slice(g), [], [], 'me');
  A.updateDraws(many.slice(2 * g), [], [], 'me');
  const seen = store[A.KEY].draws;
  assert.ok(many.slice(g, 2 * g).every((d) => d._id in seen), '刚消失的留着（活动有 400 个也留）');
  assert.ok(many.slice(0, g).every((d) => !(d._id in seen)), '最早消失的删掉');
  // 刚删除又撤回：不误报
  A.updateDraws(many.slice(g), [], [], 'me');
  assert.strictEqual(Object.keys(A.matchTags()).length + many.slice(g, 2 * g).filter((d) => tagOf(A, d._id)).length, 0);
  // seeDraw：传全站比赛也只认这个活动的；已提前结束的报名中活动不算候补（和云端一致）
  const { A: B, store: st2 } = fresh();
  B.updateDraws([sign('x', { endedAt: 3, size: 2 })], [], [su('x')], 'me');
  B.seeDraw(sign('x', { endedAt: 3, size: 2 }), 'me', [{ _id: 'o', _openid: 'u2', drawId: 'x', createdAt: 1 }, { _id: 's-x', _openid: 'me', drawId: 'x', createdAt: 2 }, { _id: 'o2', _openid: 'u3', drawId: 'x', createdAt: 0 }], []);
  assert.strictEqual(st2[B.KEY].draws.x.w, null);
  done();
});

test('战绩页（真的跑页面）：读到就记成看过、小红点消失，这次停留照常显示；点进某场回来只去掉那一场（读不到也去掉）；退到后台回来照常；切 tab 回来全部去掉；换账号不串', async () => {
  const vm = require('vm');
  const { createRequire } = require('module');
  const clock = require('./fake-clock')();
  const { A, badges } = fresh();
  const app = {};
  Object.assign(global.wx, { onAppHide: (f) => { app.hide = f; }, onAppShow: (f) => { app.show = f; } });
  delete require.cache[require.resolve('../utils/alerts')];
  const A2 = require('../utils/alerts'); // 重新加载：接上假的 onAppHide / onAppShow
  const stack = [];
  global.getCurrentPages = () => stack;
  const mk = (id, by, t) => ({ _id: id, type: 'single', a: ['我'], b: ['阿哲'], aIds: ['me'], bIds: ['u2'], sets: [{ a: 4, b: 1 }], winner: 'a', recordedBy: by, date: '2026-11-2' + t, createdAt: t });
  const st = { all: [mk('m1', 'me', 1)], fail: false };
  const fakeDb = {
    cachedMatchesAll: () => [], cachedPlayersFull: () => [], cachedOpenid: () => 'me', cachedProfile: () => null,
    matchesAllShared: async () => { if (st.fail) throw new Error('net'); return st.all; },
    matchesShared: async () => st.all, playersShared: async () => [], myOpenid: async () => 'me',
    profilesOf: () => ({}), prefetchMatchState() {},
  };
  const member = { statusCached: async () => ({ status: 'active' }), knownActive: () => true };
  const file = path.join(root, 'pages/index/index.js');
  let def;
  Object.assign(global.wx, { hideShareMenu() {}, showToast() {}, navigateTo() {} });
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    require: (id) => ({ '../../utils/db': fakeDb, '../../utils/member': member }[id] || createRequire(file)(id)),
    wx: global.wx, console, Page: (d) => { def = d; }, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
  });
  const p = Object.assign({}, def, { data: JSON.parse(JSON.stringify(def.data)), setData(o) { Object.assign(this.data, o); } });
  const shown = () => { const o = {}; p.data.groups.forEach((g) => g.items.forEach((x) => { if (x.alert) o[x._id] = x.alert; })); return o; };
  const tabAway = async () => { p.onHide(); await clock.wait(Anim.LEAVE_MS + 10); };
  const Anim = require('../utils/anim');
  await clock.run(async () => {
    stack.push(p);
    p.onLoad(); p.onShow(); await clock.wait(1); await p.load();
    assert.deepStrictEqual(shown(), {}, '第一次只记底');
    // 别人录了两场我参加的
    st.all = [mk('m3', 'u2', 3), mk('m2', 'u2', 2), mk('m1', 'me', 1)];
    await tabAway(); p.onShow(); await p.load();
    assert.deepStrictEqual(shown(), { m2: '新', m3: '新' });
    assert.deepStrictEqual([A2.matchTags(), badges.dot], [{}, false], '读到就算看过：小红点不会再出来');
    // 点进 m2 再回来（这次网络读不到）：只去掉 m2，而且不用等云端
    p.openMatch({ currentTarget: { dataset: { id: 'm2' } } });
    p.onHide(); stack.push({}); await clock.wait(Anim.LEAVE_MS + 10);
    stack.pop(); st.fail = true; p.onShow();
    assert.deepStrictEqual(shown(), { m3: '新' });
    await p.load(); st.fail = false;
    assert.deepStrictEqual(shown(), { m3: '新' });
    // 退到后台再回来：照常显示
    p.onHide(); app.hide(); await clock.wait(Anim.LEAVE_MS + 10); app.show(); p.onShow(); await p.load();
    assert.deepStrictEqual(shown(), { m3: '新' });
    // 刚切走马上回来（还没过 LEAVE_MS）：照常显示
    p.onHide(); p.onShow(); await clock.wait(Anim.LEAVE_MS + 10);
    assert.deepStrictEqual(shown(), { m3: '新' });
    // 切到别的 tab 再回来：全部去掉
    await tabAway(); p.onShow();
    assert.deepStrictEqual(shown(), {});
    await p.load();
    assert.deepStrictEqual(shown(), {}, '看过的不再出现');
    // 换账号：上一个账号留下的标签不显示
    st.all = [mk('m4', 'u2', 4)].concat(st.all);
    await tabAway(); p.onShow(); await p.load();
    assert.deepStrictEqual(shown(), { m4: '新' });
    p.onHide(); stack.push({}); await clock.wait(Anim.LEAVE_MS + 10); // 进了子页面（比如退出成员身份的流程）
    A2.reset(); stack.pop(); p.onShow();
    assert.deepStrictEqual(shown(), {});
  });
  delete global.getCurrentPages;
  done();
});

test('tab 页显示时强制重设角标（上一次在非 tab 页设置，失败回调可能晚到）；首页从详情回来马上去掉看过的标签', () => {
  const { A, badges } = fresh();
  A.updateDraws([sign('a')], [], [], 'me');
  A.updateDraws([sign('a'), sign('n')], [], [], 'me');
  const n = badges.calls.length;
  A.applyBadges();
  assert.strictEqual(badges.calls.length, n, '没变化：不重复设');
  A.applyBadges(true);
  assert.deepStrictEqual(badges.calls.slice(n), [['set', A.ACT_TAB], ['nodot', A.MATCH_TAB]]);
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  for (const f of ['pages/rank/rank.js', 'pages/racket/racket.js', 'pages/me/me.js']) assert.match(read(f), /require\('\.\.\/\.\.\/utils\/alerts'\)\.applyBadges\(true\)/, f);
  assert.match(read('pages/index/index.js'), /A\.applyBadges\(true\);/);
  const draw = read('pages/draw/draw.js');
  assert.match(draw, /A\.applyBadges\(true\); \/\/ 从非 tab 页回来/);
  assert.match(draw, /if \(kept !== this\.draws \|\| \(this\.draws && A\.version\(\) !== this\.alertVer\)\) \{ this\.draws = kept; this\.render\(\); \}/);
  done();
});

test('tab 下标和 app.json 一致；页面接上了（首页卡片 / 我的下一场 / 战绩卡片 / 详情记成看过 / 成员校验 / 退出清掉）；标签文字不用赛事和消息推送说法', () => {
  const { A } = fresh();
  const tabs = require('../app.json').tabBar.list.map((x) => x.pagePath);
  assert.strictEqual(tabs[A.ACT_TAB], 'pages/draw/draw');
  assert.strictEqual(tabs[A.MATCH_TAB], 'pages/index/index');
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  assert.match(read('pages/draw/draw.js'), /if \(!stale\) \{ A\.updateMatches\(matches, myId\); A\.updateDraws\(list, matches, signups, myId\); \}/);
  assert.match(read('pages/draw/draw.wxml'), /wx:if="\{\{item\.alert\}\}" class="ui-tag \{\{item\.alert\.cls\}\} d-alert"/);
  assert.match(read('pages/draw/draw.wxml'), /wx:if="\{\{next\.moved\}\}"/);
  assert.match(read('pages/index/index.wxml'), /wx:if="\{\{item\.alert\}\}"/);
  assert.match(read('pages/index/index.js'), /A\.seeMatches\(this\.myId\)/);
  assert.match(read('pages/draw-view/draw-view.js'), /require\('\.\.\/\.\.\/utils\/alerts'\)\.seeDraw\(d, myId, signups,/);
  assert.match(read('utils/member.js'), /require\('\.\/alerts'\)\.refresh\(\)/);
  assert.match(read('utils/member.js'), /require\('\.\/alerts'\)\.reset\(\)/);
  const words = Object.values(A.TAGS).map((t) => t.text).concat(Object.values(A.MATCH_TAGS)).join('');
  assert.ok(!/赛事|晋级|决赛|签表|通知|消息|推送/.test(words), words);
  done();
});

module.exports = T;
