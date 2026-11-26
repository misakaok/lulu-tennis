// 场边实用工具与数据闭环测试：AA 算账、4～8 人双打均衡排班、一键复刻上次活动、五维球风与关键分统计、球拍贴铅片配重计算、战绩按日期筛选
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const AA = require('../pkg-tools/utils/aa');
const MX = require('../pkg-tools/utils/mixer');
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

module.exports = T;
