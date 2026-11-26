// 场边实用工具与数据闭环测试：AA 算账、4～8 人双打均衡排班、一键复刻上次活动、五维球风与关键分统计、球拍贴铅片配重计算、战绩按日期筛选
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const AA = require('../pkg-tools/utils/aa');
const MX = require('../pkg-tools/utils/mixer');
const LD = require('../pkg-tools/utils/ladder');
const PV = require('../utils/player');
const ID = require('../utils/ident');
const K = require('../utils/racket');

const T = [];
const test = (name, fn) => T.push({ name, fn });
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

test('AA 算账（utils/aa.js）：全勤 1 份 + 半场 0.5 份均摊、三种取整模式与群账单文案', () => {
  // 场地 200 + 用球 80 = 280，全勤 4 人 + 半场 2 人 = 5 份 → 全勤 56、半场 28
  const r = AA.calc({ court: 200, balls: 80, extra: 0, full: 4, half: 2, mode: 'jiao' });
  assert.deepStrictEqual([r.ready, r.total, r.shares, r.perFull, r.perHalf, r.diff], [true, 280, 5, 56, 28, 0]);
  const bill = AA.formatBill({ court: 200, balls: 80, full: 4, half: 2 }, { title: '周六约球', date: '2026-11-28' });
  assert.match(bill, /周六约球/);
  assert.match(bill, /全勤每人：¥56/);
  assert.match(bill, /半场每人：¥28/);
  assert.match(bill, /LULU 网球/);
  // 取整到元与精确到分
  const y = AA.calc({ court: 100, full: 3, half: 0, mode: 'yuan' });
  assert.deepStrictEqual([y.perFull, y.collect, y.diff], [33, 99, -1]);
  assert.match(y.diffText, /少收 ¥1/);
  const c = AA.calc({ court: 100, full: 3, half: 0, mode: 'cent' });
  assert.strictEqual(c.perFull, 33.33);
  // 费用或人数为 0：未就绪
  assert.strictEqual(AA.calc({ court: 0, full: 4 }).ready, false);
  assert.strictEqual(AA.calc({ court: 200, full: 0, half: 0 }).ready, false);
  assert.strictEqual(AA.formatBill({ court: 0, full: 4 }), '');
});

test('双打均衡排班（utils/mixer.js）：4 人按水平最均衡配对；6 人多轮轮休公平；8 人 2 块场全员同时上场且文案可复制', () => {
  // 4 人：高+低 vs 中+中（4.0+2.0=3.0 vs 3.5+2.5=3.0），应选出最接近组合
  const p4 = [
    { id: 'a', name: '高', level: 4.0 }, { id: 'b', name: '中高', level: 3.5 },
    { id: 'c', name: '中低', level: 2.5 }, { id: 'd', name: '低', level: 2.0 },
  ];
  const r4 = MX.schedule(p4, { rounds: 1, courts: 1, seed: 0 });
  assert.strictEqual(r4.rounds.length, 1);
  assert.strictEqual(r4.rounds[0].matches[0].tag, '势均力敌');
  assert.strictEqual(r4.rounds[0].matches[0].shareA, 50);

  // 6 人 6 轮 1 块场：每人应恰好上场 4 轮、轮休 2 轮（上场次数极差 ≤ 1）
  const p6 = [1, 2, 3, 4, 5, 6].map((i) => ({ id: 'u' + i, name: '球友' + i, level: 2 + i * 0.25 }));
  const r6 = MX.schedule(p6, { rounds: 6, courts: 1, seed: 0 });
  const plays6 = r6.summary.map((s) => s.played);
  assert.strictEqual(Math.max(...plays6) - Math.min(...plays6), 0, '6 人 6 轮每人恰好打 4 轮');
  assert.ok(r6.rounds.every((rd) => rd.rest.length === 2));

  // 8 人 4 轮 2 块场：每轮同时开 2 场、无人轮休
  const p8 = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ id: 'm' + i, name: '球员' + i, level: 2 + i * 0.2 }));
  const r8 = MX.schedule(p8, { rounds: 4, courts: 2, seed: 0 });
  assert.ok(r8.rounds.every((rd) => rd.matches.length === 2 && rd.rest.length === 0));
  assert.ok(r8.summary.every((s) => s.played === 4));
  const txt = MX.formatSchedule(r8);
  assert.match(txt, /8 人 · 4 轮（2 块场）/);
  assert.match(txt, /1 号场/);
  assert.match(txt, /2 号场/);
  assert.strictEqual(MX.schedule(p4.slice(0, 3)), null, '不足 4 人返回 null');
});

test('升降级冲场（utils/ladder.js + pkg-tools/mixer）：12 人 3 场冲 1 号场强制拆搭档、平局金球定胜负、10 人公平轮休、按分动态配对与本地恢复', () => {
  const pairSet = (rd) => {
    const s = new Set();
    rd.matches.forEach((m) => {
      const k = (x, y) => (x < y ? `${x}|${y}` : `${y}|${x}`);
      s.add(k(m.a[0], m.a[1]));
      s.add(k(m.b[0], m.b[1]));
    });
    return s;
  };

  // 1. 12 人 3 片场「冲 1 号场」：同水平按原编号顺序分场（1~4 号先上 1 号场），胜升负降、1 号场守擂、末场留场、强制拆开上轮搭档
  const eq12 = Array.from({ length: 12 }, (_, i) => ({ id: 'q' + (i + 1), name: `${i + 1} 号球友`, level: 2.5 }));
  const seq12 = LD.startSession(eq12, { mode: 'king', preset: 'g4' });
  assert.deepStrictEqual(seq12.current.matches[0].a.concat(seq12.current.matches[0].b).sort(), ['q1', 'q2', 'q3', 'q4'], '同水平编号球友 1~4 号先上 1 号场，不被字典序打乱');
  const p12 = Array.from({ length: 12 }, (_, i) => ({ id: 'u' + (i + 1), uid: 'u' + (i + 1), name: '球友' + (i + 1), level: 4.0 - i * 0.1 }));
  let s = LD.startSession(p12, { mode: 'king', preset: 'g4' });
  assert.deepStrictEqual([s.mode, s.courts, s.current.round, s.current.matches.length, s.current.restIds.length], ['king', 3, 1, 3, 0]);
  assert.strictEqual(LD.canAdvance(s), false);
  const r1Pairs = pairSet(s.current);
  const r1m1 = s.current.matches[0], r1m2 = s.current.matches[1], r1m3 = s.current.matches[2];
  // 第 1 场 A 胜（4:2），第 2 场 B 胜（2:4），第 3 场 A 胜（4:1）
  s = LD.setScore(s, 1, 'a', '4'); s = LD.setScore(s, 1, 'b', '2');
  s = LD.setScore(s, 2, 'a', '2'); s = LD.setScore(s, 2, 'b', '4');
  s = LD.setScore(s, 3, 'a', '4'); s = LD.setScore(s, 3, 'b', '1');
  assert.strictEqual(LD.canAdvance(s), true);
  let adv = LD.advanceRound(s);
  assert.strictEqual(adv.ok, true);
  s = adv.session;
  assert.strictEqual(s.current.round, 2);
  // 校验各场 4 人归属：1 号场 = 1场胜方 + 2场胜方；2 号场 = 1场负方 + 3场胜方；3 号场 = 2场负方 + 3场负方
  const idsOf = (m) => m.a.concat(m.b).sort();
  assert.deepStrictEqual(idsOf(s.current.matches[0]), r1m1.a.concat(r1m2.b).sort());
  assert.deepStrictEqual(idsOf(s.current.matches[1]), r1m1.b.concat(r1m3.a).sort());
  assert.deepStrictEqual(idsOf(s.current.matches[2]), r1m2.a.concat(r1m3.b).sort());
  // 强制拆伙：第 2 轮所有搭档组合不得与第 1 轮重复
  const r2Pairs = pairSet(s.current);
  r2Pairs.forEach((pk) => assert.ok(!r1Pairs.has(pk), '第 2 轮必须拆开上一轮搭档：' + pk));
  // 校验标签：1 号场有守擂和 ↑ 升场
  const c1Badges = s.current.matches[0].aPlayers.concat(s.current.matches[0].bPlayers).map((p) => p.badge).sort();
  assert.deepStrictEqual(c1Badges, ['↑ 升场', '↑ 升场', '守擂', '守擂']);

  // 2. 冲 1 号场平局金球定胜负与撤回恢复
  s = LD.setScore(s, 1, 'a', '3'); s = LD.setScore(s, 1, 'b', '3');
  s = LD.setScore(s, 2, 'a', '4'); s = LD.setScore(s, 2, 'b', '2');
  s = LD.setScore(s, 3, 'a', '4'); s = LD.setScore(s, 3, 'b', '1');
  assert.strictEqual(s.current.matches[0].needTieBreak, true);
  assert.strictEqual(LD.canAdvance(s), false);
  assert.strictEqual(LD.advanceRound(s).ok, false);
  s = LD.setTieBreak(s, 1, 'b');
  assert.strictEqual(LD.canAdvance(s), true);
  adv = LD.advanceRound(s);
  assert.strictEqual(adv.ok, true);
  s = adv.session;
  assert.strictEqual(s.history[1].matches[0].byTieBreak, true);
  assert.strictEqual(s.history[1].matches[0].winner, 'b');
  assert.ok(s.current.matches.every((m) => m.a.length === 2 && m.b.length === 2), '金球结算后每片场仍恒为 4 人');
  // 撤回第 2 轮结算，应完整恢复比分和金球选择
  const undone = LD.undoRound(s);
  assert.strictEqual(undone.current.round, 2);
  assert.strictEqual(undone.history.length, 1);
  assert.deepStrictEqual([undone.current.matches[0].scoreA, undone.current.matches[0].scoreB, undone.current.matches[0].needTieBreak, undone.current.matches[0].tieBreak], ['3', '3', true, 'b']);

  // 3. 10 人 2 片场（每轮 2 人轮休）：轮休者下轮优先上场，多轮后全员出场次数极差 ≤ 1
  const p10 = p12.slice(0, 10);
  let s10 = LD.startSession(p10, { mode: 'king', preset: 'g4' });
  assert.strictEqual(s10.current.restIds.length, 2);
  const firstRest = s10.current.restIds.slice();
  for (let rd = 0; rd < 4; rd++) {
    s10 = LD.setScore(s10, 1, 'a', '4'); s10 = LD.setScore(s10, 1, 'b', '2');
    s10 = LD.setScore(s10, 2, 'a', '4'); s10 = LD.setScore(s10, 2, 'b', '1');
    s10 = LD.advanceRound(s10).session;
    if (rd === 0) {
      const c2Ids = s10.current.matches[1].a.concat(s10.current.matches[1].b);
      firstRest.forEach((id) => assert.ok(c2Ids.includes(id), '上轮轮休球友下轮必须优先补进末号场'));
    }
    assert.strictEqual(s10.current.restIds.length, 2);
    const seen = new Set(s10.current.restIds);
    s10.current.matches.forEach((m) => m.a.concat(m.b).forEach((id) => seen.add(id)));
    assert.strictEqual(seen.size, 10, '每轮 10 人无遗漏无重复');
  }
  const st10 = LD.standings(s10);
  const plays10 = st10.map((r) => r.played);
  assert.ok(Math.max(...plays10) - Math.min(...plays10) <= 1, '10 人 4 轮出场次数均衡');

  // 4. 按分动态配对（8 人 2 片场）：允许平局直接结算，高分聚 1 号场
  const p8 = p12.slice(0, 8);
  let sp = LD.startSession(p8, { mode: 'points', preset: 'free' });
  sp = LD.setScore(sp, 1, 'a', '3'); sp = LD.setScore(sp, 1, 'b', '3');
  sp = LD.setScore(sp, 2, 'a', '6'); sp = LD.setScore(sp, 2, 'b', '1');
  assert.strictEqual(LD.canAdvance(sp), true, '按分动态配对允许平局');
  const p2Winners = sp.current.matches[1].a.slice();
  sp = LD.advanceRound(sp).session;
  const topIds = sp.current.matches[0].a.concat(sp.current.matches[0].b);
  p2Winners.forEach((id) => assert.ok(topIds.includes(id), '2 号场大胜方应按分升入 1 号场'));
  const stp = LD.standings(sp);
  assert.ok(stp.some((r) => r.tie === 1));

  // 5. 战报文案、页面交互与命名规范（绝不出现「墨西哥 / Mexicano」和赛事禁词）
  const roundTxt = LD.formatCurrentRound(s);
  const reportTxt = LD.formatFinalReport(s);
  assert.match(roundTxt, /冲 1 号场升降级 · 第 3 轮对阵/);
  assert.match(roundTxt, /LULU 网球/);
  assert.match(reportTxt, /实时排行榜/);
  assert.match(reportTxt, /\(金球\)/);
  assert.ok(!/墨西哥|Mexicano|赛事|晋级|淘汰赛/i.test(roundTxt + reportTxt));

  const mixerFiles = [
    read('pkg-tools/utils/ladder.js'),
    read('pkg-tools/mixer/mixer.js'),
    read('pkg-tools/mixer/mixer.wxml'),
    read('pkg-tools/mixer/mixer.json'),
  ].join('\n');
  assert.ok(!/墨西哥|Mexicano/i.test(mixerFiles), '界面和代码不使用墨西哥/Mexicano命名');
  const mixerCfg = JSON.parse(read('pkg-tools/mixer/mixer.json'));
  assert.strictEqual(mixerCfg.enableShareAppMessage, false);
  assert.strictEqual(mixerCfg.enableShareTimeline, false);

  // 6. 页面脚本端到端仿真：8 人速开 → 填分 → 结算生成第 2 轮 → 重新打开自动恢复
  const store = {};
  const mockWx = {
    hideShareMenu() {}, showToast() {}, showModal(o) { if (o.success) o.success({ confirm: true }); },
    getStorageSync: (k) => store[k],
    setStorageSync: (k, v) => { store[k] = v; },
    removeStorageSync: (k) => { delete store[k]; },
  };
  const prevWx = global.wx;
  global.wx = mockWx;
  try {
    const mixerFile = path.join(root, 'pkg-tools/mixer/mixer.js');
    const mixerReq = createRequire(mixerFile);
    let mDef;
    const runMixer = () => {
      vm.runInNewContext(read('pkg-tools/mixer/mixer.js'), {
        require: (id) => (id === '../../utils/db' ? { cachedPlayersFull: () => [], cachedMatches: () => [] } : mixerReq(id)),
        wx: mockWx,
        Page: (d) => { mDef = d; }, console, Date,
      });
      return Object.assign({}, mDef, {
        data: JSON.parse(JSON.stringify(mDef.data)),
        setData(o) { Object.assign(this.data, o); },
      });
    };
    const mp = runMixer();
    mp.onLoad({});
    assert.strictEqual(mp.data.modeTab, 'mix');
    mp.setModeTab({ currentTarget: { dataset: { v: 'ladder' } } });
    mp.quickLadder({ currentTarget: { dataset: { n: '8' } } });
    assert.deepStrictEqual([mp.data.ldPicked.length, mp.data.ldCourts], [8, 2]);
    mp.startLadder();
    assert.strictEqual(mp.data.ldSession.current.round, 1);
    mp.onLdScore({ currentTarget: { dataset: { court: '1', side: 'a' } }, detail: { value: '4' } });
    mp.onLdScore({ currentTarget: { dataset: { court: '1', side: 'b' } }, detail: { value: '2' } });
    mp.onLdScore({ currentTarget: { dataset: { court: '2', side: 'a' } }, detail: { value: '4' } });
    mp.onLdScore({ currentTarget: { dataset: { court: '2', side: 'b' } }, detail: { value: '1' } });
    mp.nextLdRound();
    assert.strictEqual(mp.data.ldSession.current.round, 2);
    assert.strictEqual(mp.data.ldStandings.length, 8);
    assert.ok(mp.data.ldLeader);
    assert.ok(store[LD.STORAGE_KEY], '进行中的冲场局已持久化到本机缓存');
    // 重新打开页面自动恢复未结束的冲场局并默认切到升降级冲场页签
    const mp2 = runMixer();
    mp2.onLoad({});
    assert.strictEqual(mp2.data.modeTab, 'ladder');
    assert.strictEqual(mp2.data.ldSession.current.round, 2);
    // 结束重开清理缓存
    mp2.resetLadder();
    assert.strictEqual(mp2.data.ldSession, null);
    assert.strictEqual(store[LD.STORAGE_KEY], undefined);
  } finally {
    if (prevWx === undefined) delete global.wx;
    else global.wx = prevWx;
  }
});

test('一键复刻上次活动（pages/draw-new）：复用形式、规则、场地、地图和建议水平；日期保持今天且不自动勾选 LULU 积分', () => {
  const filename = path.join(root, 'pkg-manage/draw-new/draw-new.js');
  let def;
  const toasts = [];
  vm.runInNewContext(read('pkg-manage/draw-new/draw-new.js'), {
    require: (id) => (id === '../../utils/db' ? { cachedDraws: () => [], drawsShared: async () => [] } : id === '../../utils/cloud' ? { cached: async () => ({}) } : createRequire(filename)(id)),
    wx: { showToast: (o) => toasts.push(o.title), getStorageSync: () => ({}) },
    Page: (d) => { def = d; }, console, Date,
  });
  const p = Object.assign({}, def, {
    data: JSON.parse(JSON.stringify(def.data)),
    setData(o) { Object.assign(this.data, o); },
    refresh() { this.refreshed = true; },
  });
  p.date = '2026-11-28';
  const prevDraw = {
    _id: 'd1', title: '上周周赛', mode: 'groups_ko', groupCount: 2, advance: 2, type: 'double',
    category: 'mixed', limit: 8, date: '2026-11-21', startTime: '19:00', venue: '3号场',
    location: { latitude: 31.2, longitude: 121.4 }, place: { name: '中央球场', address: '网球路 1 号' },
    level: { min: 2.5, max: 3.5 },
    rules: { group: { setGames: 4, noAd: true, bestOf: 1 }, ko: { setGames: 6, noAd: false, bestOf: 1 }, rounds: {} },
    cup: { kind: 'weekly', pointGroup: 'open', scoreVersion: 2 }, createdAt: 999,
  };
  const info = p.pickLastDraw([prevDraw]);
  assert.strictEqual(info.title, '上周周赛');
  p.copyLastDraw();
  assert.deepStrictEqual([p.data.mode, p.data.groupCount, p.data.type, p.data.category, p.data.limit], ['groups_ko', 2, 'double', 'mixed', 8]);
  assert.strictEqual(p.data.cupOn, false, '绝不自动勾选 LULU 积分');
  assert.strictEqual(p.data.formInit.date, '2026-11-28', '日期保持今天');
  assert.strictEqual(p.data.formInit.startTime, '19:00');
  assert.strictEqual(p.data.formInit.venue, '3号场');
  assert.deepStrictEqual(p.data.formInit.level, { min: 2.5, max: 3.5 });
  assert.strictEqual(p.refreshed, true);
  assert.ok(toasts.some((t) => /复用/.test(t)));
});

test('关键分统计（PV.clutchView）与五维球风（PV.styleView）：满 5 场解锁五维雷达与正向标签；二级页 pages/report 承接深度统计', () => {
  const players = [
    { name: '我', uid: 'me', self: true, level: 3 },
    { name: '搭', uid: 'pa', self: true, level: 3 },
    { name: '对1', uid: 'o1', self: true, level: 3 },
    { name: '对2', uid: 'o2', self: true, level: 3 },
  ];
  const raw = [
    // 单打：抢七赢 + 7:5 胶着盘赢（先丢首盘逆转）
    { _id: 'c1', date: '2026-11-01', type: 'single', a: ['我'], b: ['对1'], aIds: ['me'], bIds: ['o1'], winner: 'a', sets: [{ a: 2, b: 6 }, { a: 7, b: 6, tbA: 7, tbB: 5 }, { a: 7, b: 5 }] },
    // 单打：抢七输
    { _id: 'c2', date: '2026-11-02', type: 'single', a: ['我'], b: ['对1'], aIds: ['me'], bIds: ['o1'], winner: 'b', sets: [{ a: 3, b: 4, tbA: 4, tbB: 7 }] },
    // 双打：赢（6:2 非胶着）
    { _id: 'c3', date: '2026-11-03', type: 'double', a: ['我', '搭'], b: ['对1', '对2'], aIds: ['me', 'pa'], bIds: ['o1', 'o2'], winner: 'a', sets: [{ a: 6, b: 2 }] },
  ];
  const ms = ID.normalizeMatches(raw, players);
  const cl = PV.clutchView(ms, 'me', '我');
  assert.strictEqual(cl.played, 3);
  assert.deepStrictEqual([cl.tb.win, cl.tb.played, cl.tb.rate], [1, 2, '50%']);
  assert.deepStrictEqual([cl.tight.win, cl.tight.played, cl.tight.rate], [2, 3, '67%']); // 7:6 赢、7:5 赢、3:4 输
  assert.deepStrictEqual([cl.comeback.win, cl.comeback.played, cl.comeback.rate], [1, 1, '100%']);
  assert.deepStrictEqual([cl.single.win, cl.single.played, cl.single.rate], [1, 2, 50]);
  assert.deepStrictEqual([cl.double.win, cl.double.played, cl.double.rate], [1, 1, 100]);
  assert.strictEqual(PV.clutchView(ms.slice(0, 1), 'me', '我'), null, '不足 2 场不显示');
  // 五维球风：不足 5 场未解锁；满 5 场解锁并生成合法 SVG 雷达图
  const locked = PV.styleView(ms, 'me', '我', null, cl, null);
  assert.deepStrictEqual([locked.unlocked, locked.played, locked.left], [false, 3, 2]);
  assert.ok(locked.radarUri.startsWith('data:image/svg+xml;base64,'));
  const more = raw.concat([
    { _id: 'c4', date: '2026-11-04', type: 'single', a: ['我'], b: ['对1'], aIds: ['me'], bIds: ['o1'], winner: 'a', sets: [{ a: 6, b: 2 }] },
    { _id: 'c5', date: '2026-11-05', type: 'single', a: ['我'], b: ['对1'], aIds: ['me'], bIds: ['o1'], winner: 'a', sets: [{ a: 6, b: 3 }] },
  ]);
  const ms5 = ID.normalizeMatches(more, players);
  const st5 = PV.styleView(ms5, 'me', '我', require('../utils/rating').ratingsOf(ms5, players), PV.clutchView(ms5, 'me', '我'), PV.heatmapView(ms5, 'me', '我', '2026-11-25'));
  assert.strictEqual(st5.unlocked, true);
  assert.strictEqual(st5.axes.length, 5);
  assert.ok(st5.axes.every((a) => a.v >= 18 && a.v <= 99));
  assert.ok(st5.tags.length >= 1 && st5.tags.length <= 3);
  const decoded = Buffer.from(st5.radarUri.split(',')[1], 'base64').toString('utf8');
  assert.ok(decoded.startsWith('<svg ') && decoded.endsWith('</svg>'));
  // 二级页存在且不出现「用户画像」，不可分享
  const rptXml = read('pkg-tools/report/report.wxml');
  const rptCfg = JSON.parse(read('pkg-tools/report/report.json'));
  assert.ok(/五维球风/.test(rptXml) && /关键分统计/.test(rptXml) && !/用户画像|关键分画像/.test(rptXml));
  assert.strictEqual(rptCfg.enableShareAppMessage, false);
  assert.strictEqual(rptCfg.enableShareTimeline, false);
});

test('球拍贴铅片配重计算（K.tuneRacket）：按标准 27 英寸力学公式算新总重、新平衡点、HL/HH 点数与挥重增量', () => {
  const base = K.tuneRacket({ weight: 300, balance: 320 });
  assert.deepStrictEqual([base.newWeight, base.newBalance, base.added, base.swDelta], [300, 320, 0, 0]);
  assert.match(base.balTag, /头轻/);
  // 12 点加 2g：平衡点上移（头重方向），每 1g 约 +3.2 挥重 → 2g 约 +6.4
  const top = K.tuneRacket({ weight: 300, balance: 320, top: 2 });
  assert.strictEqual(top.newWeight, 302);
  assert.ok(top.newBalance > 322 && top.balDiff > 2);
  assert.ok(top.swDelta >= 6.2 && top.swDelta <= 6.6);
  // 手柄加 10g：明显变头轻，挥重几乎不变（< 0.3）
  const tail = K.tuneRacket({ weight: 300, balance: 320, handle: 10 });
  assert.strictEqual(tail.newWeight, 310);
  assert.ok(tail.balDiff < -8);
  assert.ok(tail.swDelta < 0.3);
  // 入口与合规：球拍页有配重计算入口，「我的」页有场边工具三格，活动详情页有 AA 算账
  assert.ok(/bindtap="openTune"/.test(read('pages/racket/racket.wxml')));
  assert.ok(/bindtap="openAA"/.test(read('pages/draw-view/draw-view.wxml')));
  const meXml = read('pages/me/me.wxml');
  assert.ok(/openScorer/.test(meXml) && /openAA/.test(meXml) && /openMixer/.test(meXml));
});

test('战绩页按日期筛选（pages/index）：选择日期查看当日比赛、单双打/本人胜负统计、相邻比赛日切换与一键清除', () => {
  const filename = path.join(root, 'pages/index/index.js');
  const req = createRequire(filename);
  const players = [
    { _openid: 'u1', uid: 'u1', name: '小雨', level: 3, shown: true },
    { _openid: 'u2', uid: 'u2', name: '阿哲', level: 3, shown: true },
    { _openid: 'u3', uid: 'u3', name: '林晨', level: 3, shown: true },
    { _openid: 'u4', uid: 'u4', name: '大维', level: 3, shown: true },
  ];
  const pf = {}; players.forEach((p) => { pf[p.uid] = p; });
  let def;
  vm.runInNewContext(read('pages/index/index.js'), {
    require: (id) => (id === '../../utils/db' ? { profilesOf: () => pf } : req(id)),
    wx: { getStorageSync: () => '' },
    Page: (d) => { def = d; },
    console, Date, setTimeout: () => 0, clearTimeout() {},
  });
  const p = Object.assign({}, def, {
    data: JSON.parse(JSON.stringify(def.data)),
    setData(o) { Object.assign(this.data, o); },
  });
  const ms = ID.normalizeMatches([
    { _id: 'm1', date: '2026-11-25', type: 'single', a: ['小雨'], b: ['阿哲'], aIds: ['u1'], bIds: ['u2'], winner: 'a', sets: [{ a: 6, b: 3 }] },
    { _id: 'm2', date: '2026-11-21', type: 'single', a: ['小雨'], b: ['阿哲'], aIds: ['u1'], bIds: ['u2'], winner: 'a', sets: [{ a: 6, b: 4 }] },
    { _id: 'm3', date: '2026-11-21', type: 'double', a: ['小雨', '林晨'], b: ['阿哲', '大维'], aIds: ['u1', 'u3'], bIds: ['u2', 'u4'], winner: 'b', sets: [{ a: 4, b: 6 }] },
    { _id: 'm4', date: '2026-11-18', type: 'single', a: ['林晨'], b: ['大维'], aIds: ['u3'], bIds: ['u4'], winner: 'a', sets: [{ a: 6, b: 2 }] },
  ], players);
  p.setSource(ms, players, 'u1', ms);
  p.render();
  assert.strictEqual(p.data.groups.length, 3);
  assert.strictEqual(p.data.daySummary, null);

  // 选中 2026-11-21：只看当天 2 场，单打 1 双打 1，4 位球友，本人 1 胜 1 负，上下相邻比赛日准确
  p.onPickDate({ detail: { value: '2026-11-21' } });
  assert.strictEqual(p.data.pickDate, '2026-11-21');
  assert.strictEqual(p.data.groups.length, 1);
  assert.strictEqual(p.data.groups[0].items.length, 2);
  assert.deepStrictEqual([p.data.daySummary.total, p.data.daySummary.single, p.data.daySummary.double, p.data.daySummary.players], [2, 1, 1, 4]);
  assert.deepStrictEqual([p.data.daySummary.myWin, p.data.daySummary.myLose], [1, 1]);
  assert.deepStrictEqual([p.data.daySummary.prev, p.data.daySummary.next], ['2026-11-18', '2026-11-25']);

  // 叠加单打筛选：当日汇总保留当天全貌并标出当前显示 1 场
  p.setFilter({ currentTarget: { dataset: { v: 'single' } } });
  assert.strictEqual(p.data.groups[0].items.length, 1);
  assert.strictEqual(p.data.daySummary.hasFilter, true);
  assert.strictEqual(p.data.daySummary.shown, 1);

  // 选一个没有比赛的日期：空列表 + 提示最近比赛日
  p.setFilter({ currentTarget: { dataset: { v: 'all' } } });
  p.onPickDate({ detail: { value: '2026-11-23' } });
  assert.strictEqual(p.data.groups.length, 0);
  assert.strictEqual(p.data.daySummary.total, 0);
  assert.strictEqual(p.data.daySummary.nearest, '2026-11-21');

  // 跳到最近比赛日 & 清除日期恢复全部
  p.jumpDate({ currentTarget: { dataset: { d: p.data.daySummary.nearest } } });
  assert.strictEqual(p.data.pickDate, '2026-11-21');
  assert.strictEqual(p.data.groups[0].items.length, 2);
  p.clearDate();
  assert.strictEqual(p.data.pickDate, '');
  assert.strictEqual(p.data.daySummary, null);
  assert.strictEqual(p.data.groups.length, 3);

  // 翻页：12 场分成 3 页（每页 5 场），支持上一页 / 下一页 / 指定页直达，切换筛选后自动回第 1 页
  const many = [];
  for (let i = 1; i <= 12; i++) {
    many.push({ _id: 'p' + i, date: `2026-11-${String(26 - Math.ceil(i / 2)).padStart(2, '0')}`, type: i % 2 ? 'single' : 'double', a: ['小雨'], b: ['阿哲'], aIds: ['u1'], bIds: ['u2'], winner: 'a', sets: [{ a: 6, b: 4 }] });
  }
  const normMany = ID.normalizeMatches(many, players);
  const countItems = () => p.data.groups.reduce((s, g) => s + g.items.length, 0);
  p.setSource(normMany, players, 'u1', normMany);
  p.render();
  assert.deepStrictEqual([p.data.page, p.data.totalPages, p.data.totalCount, countItems()], [1, 3, 12, 5]);
  p.nextPage();
  assert.deepStrictEqual([p.data.page, countItems()], [2, 5]);
  p.nextPage();
  assert.deepStrictEqual([p.data.page, countItems()], [3, 2]);
  p.nextPage(); // 尾页不动
  assert.strictEqual(p.data.page, 3);
  p.prevPage();
  assert.deepStrictEqual([p.data.page, countItems()], [2, 5]);
  p.pickPage({ detail: { value: 2 } }); // 下标 2 → 第 3 页
  assert.strictEqual(p.data.page, 3);
  p.setFilter({ currentTarget: { dataset: { v: 'single' } } }); // 切筛选回到第 1 页（6 场单打 → 2 页）
  assert.deepStrictEqual([p.data.page, p.data.totalPages, p.data.totalCount, countItems()], [1, 2, 6, 5]);
});

test('录完比赛顺手记球拍时长（K.estimateMatchMins / K.liveRackets + pages/add & pages/score）：仅有在役球拍且本人首次录分时弹出', async () => {
  assert.strictEqual(K.estimateMatchMins([{ a: 4, b: 2 }]), 25);
  assert.strictEqual(K.estimateMatchMins([{ a: 4, b: 3 }]), 30);
  assert.strictEqual(K.estimateMatchMins([{ a: 6, b: 4 }]), 45);
  assert.strictEqual(K.estimateMatchMins([{ a: 6, b: 4 }, { a: 6, b: 3 }]), 85);
  assert.strictEqual(K.estimateMatchMins([]), 60);
  const rks = [
    { id: 'r2', no: 2, brand: 'Head', model: 'Speed', status: 'active' },
    { id: 'r3', no: 3, brand: 'Babolat', model: 'Pure', status: 'retired' },
    { id: 'r1', no: 1, brand: 'Wilson', model: 'Blade', status: 'active' },
  ];
  const live = K.liveRackets(rks);
  assert.deepStrictEqual(live.map((x) => x.id), ['r1', 'r2'], '只含在役球拍并按编号升序');

  // pages/add：提交成功后若有在役球拍则弹出顺手记时长弹层，保存后写 play 日志并跳转详情
  const savedLogs = [], redirects = [];
  const rkMock = {
    cachedList: () => ({ rackets: rks, logs: [] }),
    load: async () => ({ rackets: rks, logs: [] }),
    saveLog: async (id, rid, rec) => { savedLogs.push({ rid, rec }); return 'log1'; },
    refreshBadge: () => Promise.resolve(0),
  };
  let addDef;
  const addFile = path.join(root, 'pkg-manage/add/add.js');
  const addReq = createRequire(addFile);
  vm.runInNewContext(read('pkg-manage/add/add.js'), {
    require: (id) => {
      if (id === '../../utils/rackets') return rkMock;
      if (id === '../../utils/db') return {
        fetchPlayersFull: async () => [], cachedPlayersFull: () => [], cachedProfile: () => null,
        getMyProfile: async () => null, myOpenid: async () => 'me', cachedOpenid: () => 'me',
        addMatch: async () => ({ _id: 'm99' }),
      };
      return addReq(id);
    },
    wx: {
      getStorageSync: () => ({}), setStorageSync() {}, removeStorageSync() {},
      showToast() {}, showModal() {}, redirectTo: (o) => redirects.push(o.url),
    },
    Page: (d) => { addDef = d; }, console, Date, setTimeout: (fn) => fn(),
  });
  const ap = Object.assign({}, addDef, { data: JSON.parse(JSON.stringify(addDef.data)), setData(o) { Object.assign(this.data, o); }, selectComponent: () => null });
  ap.data.canRecordDaily = true; ap.data.date = '2026-11-25';
  ap.myId = 'me'; ap.uidOf = { 我: 'me', 对手: 'op' };
  ap.result = { sets: [{ a: 6, b: 4 }], winner: 'a', won: { a: 1, b: 0 }, a: ['我'], b: ['对手'] };
  await ap.submit();
  assert.strictEqual(ap.data.rkOpen, true);
  assert.deepStrictEqual([ap.data.rkId, ap.data.rkMin], ['r1', '45']);
  assert.strictEqual(redirects.length, 0, '弹层打开时不立即跳走');
  ap.rkMinQuick({ currentTarget: { dataset: { m: '60' } } });
  await ap.saveRkLog();
  assert.strictEqual(savedLogs.length, 1);
  assert.deepStrictEqual([savedLogs[0].rid, savedLogs[0].rec.kind, savedLogs[0].rec.minutes], ['r1', 'play', 60]);
  assert.deepStrictEqual(redirects, ['/pkg-manage/match/match?id=m99']);

  // pages/score：非本人参赛或修改已有比分不弹；本人首次录分且有在役球拍才弹
  let scDef;
  const scFile = path.join(root, 'pkg-manage/score/score.js');
  const scReq = createRequire(scFile);
  let backs = 0;
  vm.runInNewContext(read('pkg-manage/score/score.js'), {
    require: (id) => {
      if (id === '../../utils/rackets') return rkMock;
      if (id === '../../utils/db') return {};
      if (id === '../../utils/cloud') return { call: async () => ({ ok: true }) };
      if (id === '../../utils/pick') return { reason: async () => '' };
      return scReq(id);
    },
    wx: { getStorageSync: () => '', showToast() {}, showModal() {}, navigateBack: () => { backs++; } },
    Page: (d) => { scDef = d; }, console, Date, setTimeout: (fn) => fn(),
  });
  const mkSc = () => Object.assign({}, scDef, {
    data: JSON.parse(JSON.stringify(scDef.data)),
    setData(o) { Object.assign(this.data, o); },
    drawId: 'd1', key: 'k1', d: {}, cfg: { setGames: 4, noAd: true, bestOf: 1 },
    f: { done: false, a: '我', b: '对手' }, res: { ok: true, sets: [{ a: 4, b: 2 }] },
  });
  const sOther = mkSc(); sOther.data.canEdit = true; sOther.inMatch = false;
  await sOther.submit();
  assert.strictEqual(sOther.data.rkOpen, false, '代别人录分不弹球拍时长');
  assert.strictEqual(backs, 1);
  const sSelf = mkSc(); sSelf.data.canEdit = true; sSelf.data.date = '2026-11-25'; sSelf.inMatch = true;
  await sSelf.submit();
  assert.strictEqual(sSelf.data.rkOpen, true);
  assert.strictEqual(sSelf.data.rkMin, '25');
  sSelf.skipRkLog();
  assert.strictEqual(sSelf.data.rkOpen, false);
  assert.strictEqual(backs, 2);
});

test('个人全部比赛页（pages/history）：活动/日常、单双打、胜负、日期多维筛选与每页 5 场翻页', () => {
  const filename = path.join(root, 'pkg-manage/history/history.js');
  const req = createRequire(filename);
  let def;
  vm.runInNewContext(read('pkg-manage/history/history.js'), {
    require: (id) => (id === '../../utils/db' ? { cachedProfiles: () => ({}), cachedPlayersFull: () => [], cachedMatches: () => [] } : req(id)),
    wx: { setNavigationBarTitle() {}, getStorageSync: () => '' },
    Page: (d) => { def = d; }, console, Date,
  });
  const p = Object.assign({}, def, { data: JSON.parse(JSON.stringify(def.data)), setData(o) { Object.assign(this.data, o); } });
  const players = [
    { _openid: 'u1', uid: 'u1', name: '小雨', level: 3, shown: true },
    { _openid: 'u2', uid: 'u2', name: '阿哲', level: 3, shown: true },
    { _openid: 'u3', uid: 'u3', name: '林晨', level: 3, shown: true },
    { _openid: 'u4', uid: 'u4', name: '大维', level: 3, shown: true },
  ];
  const pf = {}; players.forEach((x) => { pf[x.uid] = x; });
  const raw = [];
  for (let i = 1; i <= 7; i++) {
    raw.push({
      _id: 'h' + i, date: i <= 2 ? '2026-11-25' : '2026-11-20',
      drawId: i <= 3 ? 'd1' : '', drawTitle: i <= 3 ? '周六约球' : '',
      type: i % 2 ? 'single' : 'double',
      a: i % 2 ? ['小雨'] : ['小雨', '林晨'], b: i % 2 ? ['阿哲'] : ['阿哲', '大维'],
      aIds: i % 2 ? ['u1'] : ['u1', 'u3'], bIds: i % 2 ? ['u2'] : ['u2', 'u4'],
      winner: i <= 5 ? 'a' : 'b', sets: [{ a: i <= 5 ? 6 : 3, b: i <= 5 ? 3 : 6 }],
    });
  }
  const ms = ID.normalizeMatches(raw, players);
  p.data.uid = 'u1';
  p.render(pf, players, ms);
  assert.deepStrictEqual([p.data.shown.length, p.data.page, p.data.totalPages, p.data.totalCount], [5, 1, 2, 7]);
  p.nextPage();
  assert.deepStrictEqual([p.data.page, p.data.shown.length], [2, 2]);
  // 筛双打 → 3 场，回第 1 页
  p.toggleType({ currentTarget: { dataset: { v: 'double' } } });
  assert.deepStrictEqual([p.data.page, p.data.totalCount, p.data.hasFilter], [1, 3, true]);
  // 叠加只看胜 → 2 场
  p.toggleRes({ currentTarget: { dataset: { v: 'win' } } });
  assert.deepStrictEqual([p.data.totalCount, p.data.fltWin, p.data.fltLose], [2, 2, 0]);
  // 按日期 2026-11-25 筛选 → 1 场（h2）
  p.onPickDate({ detail: { value: '2026-11-25' } });
  assert.strictEqual(p.data.totalCount, 1);
  // 重置筛选 → 回到全部 7 场
  p.resetFilters();
  assert.deepStrictEqual([p.data.totalCount, p.data.hasFilter, p.data.page], [7, false, 1]);
});

test('年度球场战报与纯本机海报绘制（PV.annualView + utils/poster.js）：客观汇总年度战绩与装备，Canvas 2D 零报错绘制', () => {
  const Poster = require('../pkg-tools/utils/poster');
  const players = [
    { _openid: 'u1', uid: 'u1', name: '小雨', level: 3.5, shown: true },
    { _openid: 'u2', uid: 'u2', name: '阿哲', level: 3.0, shown: true },
  ];
  const pf = {}; players.forEach((x) => { pf[x.uid] = x; });
  const raw = [];
  for (let i = 1; i <= 5; i++) {
    raw.push({
      _id: 'y' + i, date: `2026-11-0${i}`, type: 'single',
      a: ['小雨'], b: ['阿哲'], aIds: ['u1'], bIds: ['u2'],
      winner: i <= 4 ? 'a' : 'b', sets: [{ a: i <= 4 ? 6 : 4, b: i <= 4 ? 3 : 6 }],
    });
  }
  const ms = ID.normalizeMatches(raw, players);
  const v = PV.playerView(pf, players, ms, 'u1');
  const rkStats = K.yearlyStats(
    [{ id: 'r1', no: 1, brand: 'Wilson', model: 'Blade', status: 'active' }],
    [{ id: 'l1', racketId: 'r1', kind: 'string', date: '2026-11-01', cost: 120, brand: 'Luxilon', model: 'Alu' },
      { id: 'l2', racketId: 'r1', kind: 'play', date: '2026-11-02', minutes: 90 }],
    '2026-11-25',
  );
  const ann = PV.annualView(v, ms, 'u1', '小雨', '2026', rkStats);
  assert.deepStrictEqual([ann.year, ann.played, ann.win, ann.lose, ann.rate, ann.days, ann.bestStreak], ['2026', 5, 4, 1, '80%', 5, 4]);
  assert.strictEqual(ann.mostOpp.name, '阿哲');
  assert.strictEqual(ann.racket.spendText, '¥120');

  // 模拟 Canvas 2D context 走完整个海报绘制流程（含五维雷达、装备条、无头像回退首字圆 & 有真实头像居中裁圆）
  const texts = [], draws = [];
  const noop = () => {};
  const ctx = {
    createLinearGradient: () => ({ addColorStop: noop }),
    fillRect: noop, strokeRect: noop, clearRect: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop, arcTo: noop,
    fill: noop, stroke: noop, save: noop, restore: noop, clip: noop, setLineDash: noop,
    measureText: (s) => ({ width: String(s || '').length * 16 }),
    fillText: (s) => texts.push(String(s || '')),
    drawImage: (...args) => draws.push(args),
  };
  Poster.paint(ctx, ann, '2026-11-25');
  assert.ok(texts.some((t) => /LULU 网球/.test(t)));
  assert.ok(texts.some((t) => /2026 年度球场战报/.test(t)));
  assert.ok(texts.some((t) => /五维球风/.test(t)));
  assert.ok(texts.some((t) => /¥120/.test(t)));
  assert.ok(!texts.some((t) => /用户画像|赛事/.test(t)));
  assert.strictEqual(draws.length, 0, '无真实头像时不调 drawImage，显示首字圆');
  assert.ok(texts.includes('小'), '无真实头像时绘制首字圆');

  texts.length = 0;
  const fakeImg = { width: 400, height: 200 };
  Poster.paint(ctx, ann, '2026-11-25', fakeImg);
  assert.strictEqual(draws.length, 1, '有真实头像时调用 drawImage');
  assert.deepStrictEqual(draws[0].slice(1, 5), [100, 0, 200, 200], '非正方形照片居中裁成正方形');
  assert.ok(!texts.includes('小'), '有真实头像时不叠加首字');
  // 页面合规：pages/report 仍禁用分享，无动态 <image src="{{...}}">，使用 canvas id="poster-cv"
  const rptXml = read('pkg-tools/report/report.wxml');
  assert.ok(/id="poster-cv"/.test(rptXml) && /生成战报图/.test(rptXml) && !/<image\b/.test(rptXml));
});

test('活动高清对阵 / 战果长图（utils/draw-poster.js + pkg-tools/draw-poster）：支持单淘汰、循环＋淘汰（完整/精简）、四人轮换，Canvas 2D 零报错绘制与相册保存', async () => {
  const DP = require('../pkg-tools/utils/draw-poster');
  const makeCtx = () => {
    const texts = [], badFills = [];
    const noop = () => {};
    let curFill = '';
    const ctx = {
      get fillStyle() { return curFill; },
      set fillStyle(v) { if (typeof v === 'string' && /gradient/i.test(v)) badFills.push(v); curFill = v; },
      createLinearGradient: () => ({ addColorStop: noop }),
      fillRect: noop, strokeRect: noop, clearRect: noop,
      beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop, arcTo: noop,
      fill: noop, stroke: noop, save: noop, restore: noop, clip: noop,
      setTransform: noop, scale: noop,
      measureText: (s) => ({ width: String(s || '').length * 14 }),
      fillText: (s) => texts.push(String(s || '')),
    };
    return { ctx, texts, badFills };
  };

  // 1. 单淘汰（4 签已出冠军）：含时间场地、抢七比分、冠亚军横幅
  const dKo = {
    _id: 'd-ko', title: '周六单淘汰', mode: 'bracket', size: 4, type: 'single',
    date: '2026-11-28', startTime: '19:00', venue: '3 号场',
    place: { name: '中央球场', address: '网球路 1 号' },
    entrants: ['小雨', '阿哲', '林晨', '大维'],
    lines: [{ name: '小雨' }, { name: '阿哲' }, { name: '林晨' }, { name: '大维' }],
    cup: { kind: 'weekly', pointGroup: 'open', scoreVersion: 2 },
    slots: { '1-0': { date: '2026-11-28', time: '20:30', court: '1 号场' } },
  };
  const mKo = [
    { _id: 'm1', drawId: 'd-ko', drawKey: '0-0', ea: '小雨', eb: '阿哲', winner: 'a', sets: [{ a: 3, b: 1 }], outcome: 'retired' },
    { _id: 'm2', drawId: 'd-ko', drawKey: '0-1', ea: '林晨', eb: '大维', winner: 'a', sets: [{ a: 4, b: 3, tbA: 7, tbB: 5 }] },
    { _id: 'm3', drawId: 'd-ko', drawKey: '1-0', ea: '小雨', eb: '林晨', winner: 'a', sets: [{ a: 4, b: 1 }] },
  ];
  const modKo = DP.buildModel(dKo, mKo);
  assert.deepStrictEqual([modKo.statusText, modKo.statusLime, modKo.champion, modKo.runnerUp], ['最终战果', true, '小雨', '林晨']);
  const c1 = makeCtx();
  const hKo = DP.paint(c1.ctx, modKo, '2026-11-28');
  assert.ok(hKo >= 760);
  assert.ok(c1.texts.includes('LULU 网球') && c1.texts.includes('周六单淘汰') && c1.texts.includes('冠军') && c1.texts.includes('退赛') && c1.texts.some((t) => /亚军：林晨/.test(t)));
  assert.deepStrictEqual(c1.badFills, [], 'Canvas fillStyle 不能传 CSS linear-gradient 字符串（否则头像圆会变黑）');
  assert.ok(!c1.texts.some((t) => /小组赛|淘汰赛|签表|赛程|出线|决赛|晋级|赛事|种子/.test(t)), '海报文本不含任何赛事禁词');

  // 2. 循环＋淘汰（2 组 × 3 人）：完整版含组内对阵，精简版只含积分榜与单淘汰，高度明显缩短
  const dGk = {
    _id: 'd-gk', title: '周日循环冲冠', mode: 'groups_ko', groupCount: 2, advance: 2, type: 'single',
    date: '2026-11-29', entrants: ['甲', '乙', '丙', '丁', '戊', '己'],
    groups: [
      { name: 'A 组', members: [{ name: '甲' }, { name: '乙' }, { name: '丙' }] },
      { name: 'B 组', members: [{ name: '丁' }, { name: '戊' }, { name: '己' }] },
    ],
  };
  const fullModel = DP.buildModel(dGk, [], { compact: false });
  const compModel = DP.buildModel(dGk, [], { compact: true });
  assert.strictEqual(fullModel.hasGroups, true);
  assert.strictEqual(fullModel.groups[0].fixtures.length, 3);
  assert.strictEqual(compModel.groups[0].fixtures.length, 0);
  assert.ok(DP.measureHeight(fullModel) > DP.measureHeight(compModel) + 150, '精简版高度显著低于完整版');
  const c2 = makeCtx();
  DP.paint(c2.ctx, fullModel, '2026-11-29');
  assert.ok(c2.texts.includes('A 组') && c2.texts.includes('B 组') && c2.texts.includes('单淘汰阶段'));

  // 3. 四人轮换双打
  const dRot = {
    _id: 'd-rot', title: '晚间四人轮换', mode: 'rotation', type: 'double',
    date: '2026-11-29', entrants: ['甲', '乙', '丙', '丁'],
    teams: { '甲 / 乙': ['甲', '乙'], '丙 / 丁': ['丙', '丁'], '甲 / 丙': ['甲', '丙'], '乙 / 丁': ['乙', '丁'], '甲 / 丁': ['甲', '丁'], '乙 / 丙': ['乙', '丙'] },
  };
  const modRot = DP.buildModel(dRot, []);
  assert.strictEqual(modRot.rotRounds.length, 3);
  const c3 = makeCtx();
  DP.paint(c3.ctx, modRot, '2026-11-29');
  assert.ok(c3.texts.includes('本场球友') && c3.texts.includes('第 1 轮') && c3.texts.includes('第 3 轮'));

  // 4. 页面配置、入口和端到端仿真（本机缓存即出图 → 切换精简版 → 保存相册）
  const appCfg = JSON.parse(read('app.json'));
  const toolsPkg = appCfg.subpackages.find((s) => s.root === 'pkg-tools');
  assert.ok(toolsPkg && toolsPkg.pages.includes('draw-poster/draw-poster'), '对阵图页注册在 pkg-tools 分包');
  const dpCfg = JSON.parse(read('pkg-tools/draw-poster/draw-poster.json'));
  assert.deepStrictEqual([dpCfg.enableShareAppMessage, dpCfg.enableShareTimeline], [false, false]);
  const dpXml = read('pkg-tools/draw-poster/draw-poster.wxml');
  assert.ok(/id="draw-poster-cv"/.test(dpXml) && !/<image\b[^>]*\{\{/.test(dpXml));
  assert.ok(/bindtap="openPoster"/.test(read('pages/draw-view/draw-view.wxml')));

  const savedPaths = [];
  const cMock = makeCtx().ctx;
  const fakeCanvas = { width: 0, height: 0, getContext: () => cMock };
  const mockWx = {
    hideShareMenu() {}, setNavigationBarTitle() {}, showToast() {}, showModal() {},
    nextTick: (fn) => fn(),
    createSelectorQuery: () => ({
      in() { return this; },
      select() { return this; },
      fields() { return this; },
      exec(cb) { cb([{ node: fakeCanvas }]); },
    }),
    canvasToTempFilePath: (o) => o.success({ tempFilePath: '/tmp/draw-poster.jpg' }),
    saveImageToPhotosAlbum: (o) => { savedPaths.push(o.filePath); o.success(); },
  };
  const prevWx = global.wx;
  global.wx = mockWx;
  try {
    let dpDef;
    const dpFile = path.join(root, 'pkg-tools/draw-poster/draw-poster.js');
    const dpReq = createRequire(dpFile);
    vm.runInNewContext(read('pkg-tools/draw-poster/draw-poster.js'), {
      require: (id) => (id === '../../utils/db' ? {
        peekDrawDetail: () => ({ draw: dGk }),
        cachedDraws: () => [dGk],
        cachedMatches: () => [],
        fetchDrawDetail: async () => ({ draw: dGk }),
        matchesShared: async () => [],
      } : dpReq(id)),
      wx: mockWx,
      Page: (d) => { dpDef = d; }, console, Date, setTimeout: (fn) => fn(), clearTimeout() {},
    });
    const dp = Object.assign({}, dpDef, {
      data: JSON.parse(JSON.stringify(dpDef.data)),
      setData(o, cb) { Object.assign(this.data, o); if (cb) cb(); },
    });
    dp.onLoad({ id: 'd-gk' });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(dp.data.ready, true);
    assert.strictEqual(dp.data.hasGroups, true);
    assert.strictEqual(dp.data.canSave, true);
    const fullCvH = dp.data.cvH;
    dp.setCompact({ currentTarget: { dataset: { v: '1' } } });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(dp.data.compact, true);
    assert.ok(dp.data.cvH < fullCvH, '切到精简版后画布高度收缩');
    dp.savePoster();
    assert.deepStrictEqual(savedPaths, ['/tmp/draw-poster.jpg']);
  } finally {
    if (prevWx === undefined) delete global.wx;
    else global.wx = prevWx;
  }
});

test('外传名字（pkg-tools/utils/mask.js）：存相册的图、复制的文字里没同意公开展示的写「球友」，本人照常、认不出账号的也写「球友」、几位时编号', () => {
  const Mask = require('../pkg-tools/utils/mask');
  const DP = require('../pkg-tools/utils/draw-poster');
  const profiles = { u1: { shown: true, shownVer: 2 }, u2: { shown: false }, u3: {}, me: { shown: false } };
  // 1. 基本规则：同意的露名字；没同意 / 没选 / 没账号的写球友；本人没开也照常；只有一位时不编号
  const one = Mask.masker([{ id: 'a', uid: 'u1', name: '小雨' }, { id: 'b', uid: 'u2', name: '阿哲' }, { id: 'c', uid: 'me', name: '我自己' }], profiles, 'me');
  assert.deepStrictEqual([one('a'), one('b'), one('c'), one('不在名单')], ['小雨', '球友', '我自己', '球友']);
  const many = Mask.masker([{ id: 'b', uid: 'u2', name: '阿哲' }, { id: 'x', uid: '', name: '老名字' }, { id: 'd', uid: 'u3', name: '林晨' }, { id: 'b', uid: 'u2', name: '阿哲' }], profiles, 'me');
  assert.deepStrictEqual([many('b'), many('x'), many('d')], ['球友1', '球友2', '球友3'], '同一人只编一次号，按出现顺序');
  assert.strictEqual(Mask.masker([{ id: 'a', uid: 'u1', name: '小雨' }], null, '')('a'), '球友', '资料没读到：按没同意处理');
  // 只同意过旧版说明（没有 shownVer 或 1）：小程序里照常展示，但存出去的图、复制的文字里写「球友」
  const v1 = Mask.masker([{ id: 'a', uid: 'u1', name: '小雨' }, { id: 'b', uid: 'u2', name: '阿哲' }], { u1: { shown: true }, u2: { shown: true, shownVer: 1 } }, 'me');
  assert.deepStrictEqual([v1('a'), v1('b')], ['球友1', '球友2']);
  // 露名字的人真名恰好叫「球友」「球友1」：编号避开，不会出现两个一样的
  const clash = Mask.masker([{ id: 'a', uid: 'u1', name: '球友1' }, { id: 'b', uid: 'u2', name: 'x' }, { id: 'c', uid: 'u3', name: 'y' }], { u1: { shown: true, shownVer: 2 } }, 'me');
  assert.deepStrictEqual([clash('a'), clash('b'), clash('c')], ['球友1', '球友2', '球友3']);
  const lone = Mask.masker([{ id: 'a', uid: 'u1', name: '球友' }, { id: 'b', uid: 'u2', name: 'x' }], { u1: { shown: true, shownVer: 2 } }, 'me');
  assert.deepStrictEqual([lone('a'), lone('b')], ['球友', '球友1']);

  // 2. 对阵 / 战果长图：冠军、亚军、名单、单淘汰各场都换掉，本人照常
  const dKo = {
    _id: 'd-mk', title: '周六单淘汰', mode: 'bracket', size: 4, type: 'single', date: '2026-11-28',
    entrants: ['小雨', '阿哲', '林晨', '我自己'],
    lines: [{ name: '小雨' }, { name: '阿哲' }, { name: '林晨' }, { name: '我自己' }],
    uidOf: { 小雨: 'u1', 阿哲: 'u2', 林晨: 'u3', 我自己: 'me' },
  };
  const mKo = [
    { _id: 'm1', drawId: 'd-mk', drawKey: '0-0', ea: '小雨', eb: '阿哲', winner: 'b', sets: [{ a: 1, b: 4 }] },
    { _id: 'm2', drawId: 'd-mk', drawKey: '0-1', ea: '林晨', eb: '我自己', winner: 'b', sets: [{ a: 2, b: 4 }] },
    { _id: 'm3', drawId: 'd-mk', drawKey: '1-0', ea: '阿哲', eb: '我自己', winner: 'a', sets: [{ a: 4, b: 2 }] },
  ];
  const uidOf = ID.drawUids(dKo, []);
  const nameOf = Mask.masker(dKo.entrants.map((n) => ({ id: n, uid: uidOf[n] || '', name: n })), profiles, 'me');
  const plain = DP.buildModel(dKo, mKo);
  assert.deepStrictEqual([plain.champion, plain.runnerUp], ['阿哲', '我自己'], '不传 nameOf 时和原来一样');
  const mk = DP.buildModel(dKo, mKo, { nameOf });
  assert.deepStrictEqual([mk.champion, mk.championMembers, mk.runnerUp], ['球友1', ['球友1'], '我自己']);
  assert.deepStrictEqual(mk.entrants, ['小雨', '球友1', '球友2', '我自己']);
  const allNames = JSON.stringify(mk);
  assert.ok(!/阿哲|林晨/.test(allNames), '没同意的人名字不出现在长图的任何位置');
  const texts = [];
  const noop = () => {};
  DP.paint({
    fillStyle: '', createLinearGradient: () => ({ addColorStop: noop }), fillRect: noop, strokeRect: noop, clearRect: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop, arcTo: noop, fill: noop, stroke: noop,
    save: noop, restore: noop, clip: noop, setTransform: noop, scale: noop,
    measureText: (x) => ({ width: String(x || '').length * 14 }), fillText: (x) => texts.push(String(x || '')),
  }, mk, '2026-11-28');
  assert.ok(!texts.some((x) => /阿哲|林晨/.test(x)) && texts.some((x) => /球友1/.test(x)), '画到画布上的字也换掉了');

  // 3. 双打队名按成员逐个换；分组积分榜、四人轮换同样换
  const dRot = {
    _id: 'd-rot2', title: '四人轮换', mode: 'rotation', type: 'double', date: '2026-11-29',
    entrants: ['小雨', '阿哲', '林晨', '我自己'], uidOf: dKo.uidOf,
    teams: { '小雨 / 阿哲': ['小雨', '阿哲'], '林晨 / 我自己': ['林晨', '我自己'], '小雨 / 林晨': ['小雨', '林晨'], '阿哲 / 我自己': ['阿哲', '我自己'], '小雨 / 我自己': ['小雨', '我自己'], '阿哲 / 林晨': ['阿哲', '林晨'] },
  };
  const rot = DP.buildModel(dRot, [], { nameOf });
  assert.deepStrictEqual([rot.rotRounds[0].aName, rot.rotRounds[0].aMembers], ['小雨 / 球友1', ['小雨', '球友1']]);
  assert.ok(!/阿哲|林晨/.test(JSON.stringify(rot)));
  const dGk = {
    _id: 'd-gk2', title: '循环', mode: 'groups_ko', groupCount: 1, advance: 2, type: 'single', date: '2026-11-29',
    entrants: ['小雨', '阿哲', '林晨', '我自己'], uidOf: dKo.uidOf,
    groups: [{ name: 'A 组', members: [{ name: '小雨' }, { name: '阿哲' }, { name: '林晨' }, { name: '我自己' }] }],
  };
  assert.ok(!/阿哲|林晨/.test(JSON.stringify(DP.buildModel(dGk, [], { nameOf }))), '分组积分榜和组内对阵也换掉');

  // 4. 双打排班、升降级冲场复制出去的文字
  const picked = [
    { id: 'u1', uid: 'u1', name: '小雨', level: 3.0 }, { id: 'u2', uid: 'u2', name: '阿哲', level: 3.0 },
    { id: 'u3', uid: 'u3', name: '林晨', level: 3.0 }, { id: 'me', uid: 'me', name: '我自己', level: 3.0 },
    { id: 'u5', uid: 'u5', name: '大维', level: 3.0 },
  ];
  const outOf = (list) => Mask.masker(list.map((p) => ({ id: p.id, uid: p.uid, name: p.name })), profiles, 'me');
  const res = MX.schedule(picked, { rounds: 3, courts: 1, seed: 0 });
  const plainTxt = MX.formatSchedule(res);
  const txt = MX.formatSchedule(res, outOf(picked));
  assert.ok(/阿哲/.test(plainTxt) && !/阿哲|林晨|大维/.test(txt), '排班文字里没同意的写球友（大维没资料也算）');
  assert.ok(/小雨/.test(txt) && /我自己/.test(txt) && /球友1/.test(txt) && /球友3/.test(txt));
  const s = LD.startSession(picked.concat([{ id: 'u6', uid: 'u6', name: '甲' }, { id: 'u7', uid: 'u7', name: '乙' }, { id: 'u8', uid: 'u8', name: '丙' }]), { preset: 'g4' });
  const ldOut = outOf(s.roster);
  const rTxt = LD.formatCurrentRound(s, ldOut), fTxt = LD.formatFinalReport(s, ldOut);
  assert.ok(!/阿哲|林晨|大维|甲|乙|丙/.test(rTxt + fTxt) && /球友/.test(rTxt) && /小雨/.test(fTxt));
  assert.ok(/阿哲/.test(LD.formatFinalReport(s)), '不传 nameOf 时和原来一样');
  const mixerJs = read('pkg-tools/mixer/mixer.js');
  assert.ok(/formatSchedule\(this\.data\.res, this\.outNameOf\(/.test(mixerJs) && (mixerJs.match(/this\.outNameOf\(s && s\.roster\)/g) || []).length === 2, '三处复制都换名字');

  // 5. 年度战报图只给本人生成；图里的拍档、对手按授权换
  const repXml = read('pkg-tools/report/report.wxml');
  assert.ok(/wx:if="\{\{annual && isSelf\}\}"[^>]*bindtap="openPoster"/.test(repXml), '看别人的页面不显示「生成战报图」');
  const repJs = read('pkg-tools/report/report.js');
  assert.ok(/if \(!this\.myId \|\| this\.myId !== this\.uid\) return; \/\/ 只有本人能生成/.test(repJs));
  assert.ok(/const annual = this\.posterAnnual\(\);[\s\S]{0,120}Poster\.render\(node, annual,/.test(repJs), '生成用换过名字的年度摘要');
  const repReq = createRequire(path.join(root, 'pkg-tools/report/report.js'));
  let page = null;
  vm.runInNewContext(repJs, {
    require: (id) => (id === '../../utils/db' ? {} : id === '../../utils/photo' || id === '../../utils/privacy' || id === '../../utils/haptic' ? {} : repReq(id)),
    Page: (o) => { page = o; }, console, wx: {},
  });
  const ctxp = Object.assign(Object.create(page), {
    myId: 'me', uid: 'me', freshProfiles: profiles,
    annual: { name: '我自己', bestMate: { key: 'u2', name: '阿哲', rate: 60, played: 5 }, mostOpp: { key: 'n:老名字', name: '老名字', count: 3, win: 1, lose: 2 } },
  });
  const pa = ctxp.posterAnnual();
  assert.deepStrictEqual([pa.name, pa.bestMate.name, pa.mostOpp.name, pa.bestMate.rate], ['我自己', '球友1', '球友2', 60]);
  assert.strictEqual(ctxp.annual.bestMate.name, '阿哲', '不改页面上显示用的原数据');
  ctxp.freshProfiles = { u2: { shown: true, shownVer: 2 } };
  assert.strictEqual(ctxp.posterAnnual().bestMate.name, '阿哲', '同意了就照常显示');
  ctxp.freshProfiles = null;
  assert.strictEqual(ctxp.posterAnnual().bestMate.name, '球友1', '还没拿到这次云端的最新资料：不信本机记着的授权');
  assert.ok(!/posterAnnual[\s\S]{0,600}this\.profiles\b/.test(repJs), '战报图换名不用本机缓存的资料');

  // 6. 对阵长图：拿到这次云端的最新授权之前不让存、不让全屏预览（全屏预览能长按保存）；读不到按谁都没同意
  const dpJs = read('pkg-tools/draw-poster/draw-poster.js');
  assert.ok(/previewPoster\(\) \{\n    if \(!this\.posterPath \|\| this\.notChecked\(\)\) return;/.test(dpJs));
  assert.ok(/if \(this\.notChecked\(\)\) return;/.test(dpJs.slice(dpJs.indexOf('savePoster()'))));
  assert.ok(/this\.profiles = players && db\.profilesOf \? \(db\.profilesOf\(players\) \|\| \{\}\) : \{\};/.test(dpJs), '读不到最新资料时不沿用旧授权');
  // 排班复制：同样只认这次云端的资料
  assert.ok(/this\.profilesFresh \? \(this\.profiles \|\| \{\}\) : \{\}/.test(mixerJs));
  // 常打对手（至少交手 2 场）、最佳拍档（至少搭档 3 场）都带统计身份
  const g = (id, a, b, ak, bk, w) => ({ _id: id, date: '2026-03-0' + id.slice(1), type: a.length > 1 ? 'double' : 'single', a, b, aKeys: ak, bKeys: bk, winner: w, sets: [{ a: w === 'a' ? 6 : 2, b: w === 'a' ? 2 : 6 }] });
  const ms = [
    g('x1', ['我自己'], ['阿哲'], ['me'], ['u2'], 'a'), g('x2', ['我自己'], ['阿哲'], ['me'], ['u2'], 'b'),
    g('x3', ['我自己', '林晨'], ['小雨', '大维'], ['me', 'u3'], ['u1', 'u5'], 'a'),
    g('x4', ['我自己', '林晨'], ['甲', '乙'], ['me', 'u3'], ['u6', 'u7'], 'a'),
    g('x5', ['我自己', '林晨'], ['丙', '丁'], ['me', 'u3'], ['u8', 'u9'], 'b'),
  ];
  const mine = PV.annualView({ partners: PV.partnersView(ms, 'me', '我自己') }, ms, 'me', '我自己', '2026', null);
  assert.deepStrictEqual([mine.mostOpp && mine.mostOpp.key, mine.bestMate && mine.bestMate.key], ['u2', 'u3']);
  // 更早的记录没有统计身份（key 就是名字）：拍档、对手是同一位旧名字时只算一个人
  ctxp.annual = { name: '我自己', bestMate: { key: '老王', name: '老王', rate: 60, played: 3 }, mostOpp: { key: 'n:老王', name: '老王', count: 3, win: 1, lose: 2 } };
  ctxp.freshProfiles = profiles;
  const old = ctxp.posterAnnual();
  assert.deepStrictEqual([old.bestMate.name, old.mostOpp.name], ['球友', '球友']);
  ctxp.annual = null;
  assert.strictEqual(ctxp.posterAnnual(), null, '年度摘要没了不报错');
});

test('外传名字（续）：没同意的人拿亚军、冲场打完几轮带轮休、两块场排班、编号速排照常；页面只认这次云端的授权', async () => {
  const Mask = require('../pkg-tools/utils/mask');
  const DP = require('../pkg-tools/utils/draw-poster');
  const profiles = { u1: { shown: true, shownVer: 2 }, u2: { shown: false }, me: { shown: false } };
  // 1. 没同意的人拿亚军
  const d = {
    _id: 'd-ru', title: '周日', mode: 'bracket', size: 4, type: 'single', date: '2026-11-29',
    entrants: ['小雨', '阿哲', '林晨', '我自己'], lines: [{ name: '小雨' }, { name: '阿哲' }, { name: '林晨' }, { name: '我自己' }],
    uidOf: { 小雨: 'u1', 阿哲: 'u2', 林晨: 'u3', 我自己: 'me' },
  };
  const ms = [
    { _id: 'r1', drawId: 'd-ru', drawKey: '0-0', ea: '小雨', eb: '阿哲', winner: 'b', sets: [{ a: 1, b: 4 }] },
    { _id: 'r2', drawId: 'd-ru', drawKey: '0-1', ea: '林晨', eb: '我自己', winner: 'b', sets: [{ a: 2, b: 4 }] },
    { _id: 'r3', drawId: 'd-ru', drawKey: '1-0', ea: '阿哲', eb: '我自己', winner: 'b', sets: [{ a: 2, b: 4 }] },
  ];
  const nameOf = Mask.masker(d.entrants.map((n) => ({ id: n, uid: d.uidOf[n], name: n })), profiles, 'me');
  const m = DP.buildModel(d, ms, { nameOf });
  assert.deepStrictEqual([m.champion, m.runnerUp], ['我自己', '球友1']);
  assert.ok(!/阿哲|林晨/.test(JSON.stringify(m)));

  // 2. 冲场：5 人 1 片场（每轮 1 人轮休），打完一轮后的对阵和战报（含各轮比分）
  const roster = [['u1', '小雨'], ['u2', '阿哲'], ['u3', '林晨'], ['me', '我自己'], ['u5', '大维']].map(([id, name], i) => ({ id, uid: id, name, level: 3.5 - i * 0.1 }));
  let s = LD.startSession(roster, { preset: 'g4' });
  assert.strictEqual(s.current.restIds.length, 1);
  s = LD.setScore(s, 1, 'a', '4'); s = LD.setScore(s, 1, 'b', '2');
  s = LD.advanceRound(s).session;
  const out = Mask.masker(roster.map((p) => ({ id: p.id, uid: p.uid, name: p.name })), profiles, 'me');
  const rTxt = LD.formatCurrentRound(s, out), fTxt = LD.formatFinalReport(s, out);
  assert.match(rTxt, /本轮轮休：/);
  assert.match(fTxt, /各轮比分：/);
  assert.ok(!/阿哲|林晨|大维/.test(rTxt + fTxt), '轮休、排行、各轮比分都换掉');
  // 缺 ID 数组的旧结构：传了 nameOf 也不退回原文
  const broken = { mode: 'points', courts: 1, roster: [], history: [], current: { round: 1, matches: [{ court: 1, aText: '阿哲 / 林晨', bText: '小雨 / 大维' }], restText: '老王' } };
  const bTxt = LD.formatCurrentRound(broken, out);
  assert.ok(!/阿哲|林晨|老王/.test(bTxt) && /球友/.test(bTxt));

  // 3. 两块场排班
  const eight = roster.concat([['u6', '甲'], ['u7', '乙'], ['u8', '丙']].map(([id, name]) => ({ id, uid: id, name, level: 3.0 })));
  const res = MX.schedule(eight, { rounds: 2, courts: 2, seed: 0 });
  const out8 = Mask.masker(eight.map((p) => ({ id: p.id, uid: p.uid, name: p.name })), profiles, 'me');
  const t8 = MX.formatSchedule(res, out8);
  assert.match(t8, /2 号场/);
  assert.ok(!/阿哲|林晨|大维|甲|乙|丙/.test(t8) && /小雨/.test(t8) && /我自己/.test(t8));

  // 4. 排班页 outNameOf 实际跑：编号速排照常；没拿到云端最新资料时连同意过的也写球友；没有用户 ID 的真人也换
  const mixerFile = path.join(root, 'pkg-tools/mixer/mixer.js');
  const mixerReq = createRequire(mixerFile);
  let mDef;
  vm.runInNewContext(read('pkg-tools/mixer/mixer.js'), {
    require: (id) => (id === '../../utils/db' ? {} : mixerReq(id)), wx: {}, Page: (x) => { mDef = x; }, console, Date,
  });
  const mp = Object.assign(Object.create(mDef), { profiles, myId: 'me', profilesFresh: false });
  const f1 = mp.outNameOf([{ id: 'q1', name: '1 号球友' }, { id: 'u1', uid: 'u1', name: '小雨' }, { id: 'oldx', name: '老王' }, { id: 'me', uid: 'me', name: '我自己' }]);
  assert.deepStrictEqual([f1('q1'), f1('u1'), f1('oldx'), f1('me')], ['1 号球友', '球友1', '球友2', '我自己']);
  mp.profilesFresh = true;
  const f2 = mp.outNameOf([{ id: 'u1', uid: 'u1', name: '小雨' }, { id: 'u2', uid: 'u2', name: '阿哲' }]);
  assert.deepStrictEqual([f2('u1'), f2('u2')], ['小雨', '球友']);

  // 5. 对阵长图页实际跑：本机记着阿哲同意过（旧授权）→ 第一帧露名字但不能存；云端资料读失败 → 按谁都没同意重画，之后才能存
  const texts = [];
  const noop = () => {};
  const ctx = {
    fillStyle: '', createLinearGradient: () => ({ addColorStop: noop }), fillRect: noop, strokeRect: noop, clearRect: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop, arcTo: noop, fill: noop, stroke: noop,
    save: noop, restore: noop, clip: noop, setTransform: noop, scale: noop,
    measureText: (x) => ({ width: String(x || '').length * 14 }), fillText: (x) => texts.push(String(x || '')),
  };
  const toasts = [], saved = [];
  const mockWx = {
    hideShareMenu() {}, setNavigationBarTitle() {}, showModal() {}, showToast: (o) => toasts.push(o.title),
    nextTick: (fn) => fn(),
    createSelectorQuery: () => ({ in() { return this; }, select() { return this; }, fields() { return this; }, exec(cb) { cb([{ node: { width: 0, height: 0, getContext: () => ctx } }]); } }),
    canvasToTempFilePath: (o) => o.success({ tempFilePath: '/tmp/p.jpg' }),
    saveImageToPhotosAlbum: (o) => { saved.push(o.filePath); o.success(); },
    previewImage: () => saved.push('preview'),
  };
  let release;
  const gate = new Promise((r) => { release = r; });
  const prevWx = global.wx;
  global.wx = mockWx;
  try {
    const dpFile = path.join(root, 'pkg-tools/draw-poster/draw-poster.js');
    const dpReq = createRequire(dpFile);
    let dpDef;
    vm.runInNewContext(read('pkg-tools/draw-poster/draw-poster.js'), {
      require: (id) => (id === '../../utils/db' ? {
        cachedDraws: () => [d], cachedMatches: () => ms, cachedOpenid: () => 'me',
        cachedProfiles: () => ({ u2: { shown: true, shownVer: 2 } }),
        fetchDrawDetail: async () => null, getDraw: async () => null,
        matchesShared: async () => ms,
        playersShared: async () => { await gate; throw new Error('网络异常'); },
      } : dpReq(id)),
      wx: mockWx, Page: (x) => { dpDef = x; }, console, Date, setTimeout: (fn) => fn(), clearTimeout() {},
    });
    const dp = Object.assign({}, dpDef, { data: JSON.parse(JSON.stringify(dpDef.data)), setData(o, cb) { Object.assign(this.data, o); if (cb) cb(); } });
    dp.onLoad({ id: 'd-ru' });
    await new Promise((r) => setImmediate(r));
    assert.ok(texts.some((x) => /阿哲/.test(x)), '第一帧按本机旧授权画（只是预览）');
    dp.savePoster(); dp.previewPoster();
    assert.deepStrictEqual(saved, [], '核对完之前不能存、不能全屏预览');
    assert.ok(toasts.some((x) => /核对/.test(x)));
    texts.length = 0;
    release();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert.ok(texts.length && !texts.some((x) => /阿哲|林晨/.test(x)), '云端资料读失败：按谁都没同意重画');
    dp.savePoster();
    assert.deepStrictEqual(saved, ['/tmp/p.jpg']);
  } finally {
    if (prevWx === undefined) delete global.wx; else global.wx = prevWx;
  }
});

test('对阵图画球友照片：只画同意了最新版说明的人和本人；旧版同意、没同意、没照片、加载失败都画首字圆；拿到最新授权前不画', async () => {
  const DP = require('../pkg-tools/utils/draw-poster');
  const d = {
    _id: 'd-ph', title: '周日', mode: 'bracket', size: 4, type: 'single', date: '2026-11-29',
    entrants: ['小雨', '阿哲', '林晨', '我自己'], lines: [{ name: '小雨' }, { name: '阿哲' }, { name: '林晨' }, { name: '我自己' }],
    uidOf: { 小雨: 'u1', 阿哲: 'u2', 林晨: 'u3', 我自己: 'me' },
  };
  // 照片只认这次云端资料里的 photo（通过检测、正在公开的）；本人检测中的新照片（ownSrc）不画
  const profiles = { u1: { shown: true, shownVer: 2, photo: 'cloud://x/u1.jpg' }, u2: { shown: true, photo: 'cloud://x/u2.jpg' }, u3: { shown: true, shownVer: 2 }, me: { shown: false, photo: 'cloud://x/me.jpg' } };
  // 1. 页面挑出要画照片的人
  const file = path.join(root, 'pkg-tools/draw-poster/draw-poster.js');
  const req = createRequire(file);
  let def;
  vm.runInNewContext(read('pkg-tools/draw-poster/draw-poster.js'), {
    require: (id) => (id === '../../utils/db' ? {} : id === '../../utils/photo' ? {
      ownSrc: (uid) => (uid === 'me' ? '/local/pending-me.jpg' : ''),
      fileOf: () => 'cloud://x/stale-cache.jpg',
      peek: () => '', resolve: async (f) => (/hang/.test(f) ? new Promise(() => {}) : 'https://tmp/' + f.slice(-6)),
    } : req(id)),
    wx: {}, Page: (x) => { def = x; }, console, Date, setTimeout, clearTimeout,
  });
  const pg = Object.assign(Object.create(def), { profiles, myId: 'me', signups: [], profilesFresh: false });
  assert.strictEqual(JSON.stringify(await pg.photoSrcs(d)), '{}', '拿到这次云端的最新授权之前不画照片');
  pg.profilesFresh = true;
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await pg.photoSrcs(d))), { 小雨: 'https://tmp/u1.jpg', 林晨: '', 我自己: 'https://tmp/me.jpg' }, '阿哲只同意过旧版：不画；林晨没照片：空；本人画通过检测的那张，不画检测中的');
  // 这次云端没读到（profiles 为空）：谁的照片都不画，也不拿本机旧缓存里的
  pg.profiles = {};
  assert.deepStrictEqual(JSON.parse(JSON.stringify(await pg.photoSrcs(d))), { 我自己: '' });
  // 换链接卡住：最多等 DP.PHOTO_WAIT_MS，没拿到的空着（画首字圆），不让页面一直不能保存
  pg.profiles = { u1: { shown: true, shownVer: 2, photo: 'cloud://x/hang.jpg' }, u3: { shown: true, shownVer: 2, photo: 'cloud://x/u3.jpg' } };
  const clk = require('./fake-clock')(); // 虚拟时间：不真的等 3 秒
  const slow = await clk.run(async () => {
    const t0 = clk.now();
    const r = JSON.parse(JSON.stringify(await pg.photoSrcs(d)));
    assert.ok(clk.now() - t0 <= DP.PHOTO_WAIT_MS, '最多等 PHOTO_WAIT_MS，没有一直等');
    return r;
  });
  assert.deepStrictEqual(slow, { 小雨: '', 林晨: 'https://tmp/u3.jpg', 我自己: '' });

  // 2. 画布：有图的画照片（drawImage + clip），其余照旧首字圆
  const drawn = [], texts = [];
  const noop = () => {};
  const ctx = {
    fillStyle: '', createLinearGradient: () => ({ addColorStop: noop }), fillRect: noop, strokeRect: noop, clearRect: noop,
    beginPath: noop, closePath: noop, moveTo: noop, lineTo: noop, arc: noop, arcTo: noop, fill: noop, stroke: noop,
    save: noop, restore: noop, clip: noop, setTransform: noop, scale: noop,
    drawImage: (img) => drawn.push(img.tag),
    measureText: (x) => ({ width: String(x || '').length * 14 }), fillText: (x) => texts.push(String(x || '')),
  };
  const model = DP.buildModel(d, []);
  DP.paint(ctx, model, '2026-11-29', { 小雨: { width: 320, height: 320, tag: 'yu' } });
  assert.ok(drawn.length >= 1 && drawn.every((x) => x === 'yu'), '只画了有照片的人');
  assert.ok(texts.includes('阿') && texts.includes('林'), '其他人照旧首字圆');
  drawn.length = 0;
  DP.paint(ctx, model, '2026-11-29');
  assert.deepStrictEqual(drawn, [], '不传照片：和原来一样');
  DP.paint(ctx, model, '2026-11-29', { 小雨: { width: 0, height: 0, tag: 'bad' } });
  assert.deepStrictEqual(drawn, [], '坏图（宽高为 0）退回首字圆');

  // 3. render 按地址加载：加载失败的退回首字圆，成功的画上
  const canvas = {
    width: 0, height: 0, getContext: () => ctx,
    createImage: () => { const img = { width: 320, height: 320 }; Object.defineProperty(img, 'src', { set(v) { img.tag = v; setImmediate(() => (/fail/.test(v) ? img.onerror() : img.onload())); } }); return img; },
  };
  const prevWx = global.wx;
  global.wx = { canvasToTempFilePath: (o) => o.success({ tempFilePath: '/tmp/x.jpg' }) };
  try {
    drawn.length = 0;
    await DP.render(canvas, d, [], { model, genDate: '2026-11-29', photos: { 小雨: 'https://ok/yu.jpg', 我自己: 'https://fail/me.jpg' } });
    assert.ok(drawn.includes('https://ok/yu.jpg') && !drawn.includes('https://fail/me.jpg'));
    // 加载照片期间又开始了新的一轮：这一轮不改画布大小、不画、不出图
    drawn.length = 0;
    canvas.width = 11;
    const gone = await DP.render(canvas, d, [], { model, genDate: '2026-11-29', photos: { 小雨: 'https://ok/yu.jpg' }, stale: () => true });
    assert.strictEqual(gone, null);
    assert.deepStrictEqual([canvas.width, drawn.length], [11, 0]);
  } finally {
    if (prevWx === undefined) delete global.wx; else global.wx = prevWx;
  }
});

module.exports = T;
