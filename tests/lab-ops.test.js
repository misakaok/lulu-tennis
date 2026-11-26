// 个人涨球与装备实验室 + 管理员提效 测试：
//   1. 球拍/球线 × 战绩交叉分析 + 双拍对比器 + 气温/拍面磅数参考器（pkg-tools/utils/racket-lab.js）
//   2. 成长档案 2.0：训练打卡 + 按月高频短板 Top3 + 个人赛季目标进度条（pkg-manage/utils/training.js）
//   3. 常用活动模板库：保存/覆盖/上限/删除/套用（pkg-manage/utils/templates.js）
//   4. 管理员运营统计与一键导出：时间段/水平成局率、30/90天活跃、年度总结与 CSV（pkg-manage/utils/ops.js）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const C = require('../utils/cup');
const ID = require('../utils/ident');
const Lab = require('../pkg-tools/utils/racket-lab');
const TR = require('../pkg-manage/utils/training');
const GOAL_ANY = (k) => (k === 'matches' ? TR.GOAL_MATCH_OPTS : TR.GOAL_HOUR_OPTS).filter((x) => x > 0)[0];
const TPL = require('../pkg-manage/utils/templates');
const Ops = require('../pkg-manage/utils/ops');

const T = [];
const test = (name, fn) => T.push({ name, fn });
const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

function withWxStorage(fn) {
  const store = {};
  const had = Object.prototype.hasOwnProperty.call(global, 'wx');
  const old = global.wx;
  global.wx = {
    getStorageSync: (k) => (k in store ? JSON.parse(JSON.stringify(store[k])) : ''),
    setStorageSync: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
    removeStorageSync: (k) => { delete store[k]; },
  };
  try { return fn(store); }
  finally { if (had) global.wx = old; else delete global.wx; }
}

test('装备实验室：球拍/球线 × 战绩交叉分析（按拍对比、0~8h vs 8h+ 衰减、球线寿命与胜率）', () => {
  const players = [
    { uid: 'me', name: '小雨', level: 3.5, shown: true },
    { uid: 'op', name: '阿哲', level: 3.5, shown: true },
  ];
  const rackets = [
    { id: 'r1', no: 1, brand: 'wilson', model: 'Blade', status: 'active' },
    { id: 'r2', no: 2, brand: 'yonex', model: 'EZONE', status: 'active' },
  ];
  const logs = [
    // r1 在 10-01 穿 ALU Power，10-02/10-05 打 4h（新鲜期 0~8h），10-10 再加 6h → 累计 10h（进入 8h+ 衰减期）
    { id: 's1', racketId: 'r1', kind: 'string', date: '2026-10-01', main: { brand: 'luxilon', model: 'ALU Power' }, mains: 50, crosses: 48, cost: 120 },
    { id: 'p1', racketId: 'r1', kind: 'play', date: '2026-10-02', minutes: 120 },
    { id: 'p2', racketId: 'r1', kind: 'play', date: '2026-10-05', minutes: 120 },
    { id: 'p3', racketId: 'r1', kind: 'play', date: '2026-10-10', minutes: 360 },
    { id: 's2', racketId: 'r1', kind: 'string', date: '2026-10-20', main: { brand: 'luxilon', model: 'ALU Power' }, mains: 50, crosses: 48, tags: ['断线重穿'] },
    // r2 在 10-12 穿 RPM Blast 并打 90 分钟
    { id: 's3', racketId: 'r2', kind: 'string', date: '2026-10-12', main: { brand: 'babolat', model: 'RPM Blast' }, mains: 52, crosses: 52 },
    { id: 'p4', racketId: 'r2', kind: 'play', date: '2026-10-12', minutes: 90 },
  ];
  const raw = [
    // 10-02（r1 新鲜期 2h）胜
    { _id: 'm1', date: '2026-10-02', type: 'single', a: ['小雨'], b: ['阿哲'], aIds: ['me'], bIds: ['op'], winner: 'a', sets: [{ a: 6, b: 2 }] },
    // 10-05（r1 新鲜期 4h）胜
    { _id: 'm2', date: '2026-10-05', type: 'single', a: ['小雨'], b: ['阿哲'], aIds: ['me'], bIds: ['op'], winner: 'a', sets: [{ a: 6, b: 3 }] },
    // 10-10（r1 衰减期 10h）负
    { _id: 'm3', date: '2026-10-10', type: 'single', a: ['小雨'], b: ['阿哲'], aIds: ['me'], bIds: ['op'], winner: 'b', sets: [{ a: 4, b: 6 }] },
    // 10-12（r2 新鲜期 1.5h）负
    { _id: 'm4', date: '2026-10-12', type: 'single', a: ['小雨'], b: ['阿哲'], aIds: ['me'], bIds: ['op'], winner: 'b', sets: [{ a: 3, b: 6 }] },
  ];
  const ms = ID.normalizeMatches(raw, players);
  const res = Lab.crossAnalyze(rackets, logs, ms, 'me', '2026-11-26');
  assert.strictEqual(res.linkedMatches, 4);
  const r1Row = res.racketRows.find((x) => x.id === 'r1');
  const r2Row = res.racketRows.find((x) => x.id === 'r2');
  assert.deepStrictEqual([r1Row.played, r1Row.win, r1Row.rate], [3, 2, 67]);
  assert.deepStrictEqual([r2Row.played, r2Row.win, r2Row.rate], [1, 0, 0]);
  // 新鲜期 0~8h：m1(胜)、m2(胜)、m4(负) → 3 场 2 胜 67%；衰减期 8h+：m3(负) → 1 场 0 胜 0%
  assert.deepStrictEqual([res.fresh.played, res.fresh.win, res.fresh.rate], [3, 2, 67]);
  assert.deepStrictEqual([res.worn.played, res.worn.win, res.worn.rate], [1, 0, 0]);
  assert.match(res.decayNote, /穿线 8h 内胜率高出 67%/);
  // 球线寿命与断线统计
  const alu = res.stringRows.find((s) => /ALU Power/.test(s.name));
  assert.strictEqual(alu.count, 2);
  assert.strictEqual(alu.broken, 1);
  assert.strictEqual(alu.played, 3);
  assert.match(alu.lifeText, /均打 10h/);
});

test('装备实验室：双拍参数配重对比器 & 按气温/拍面穿线磅数参考器', () => {
  const cmp = Lab.compareRackets(
    { name: 'Blade 98', brand: 'wilson', model: 'Blade', weight: 305, balance: 320, sw: 324, head: 98, pattern: '16×19', top: 2 },
    { name: 'EZONE 100', brand: 'yonex', model: 'EZONE', weight: 300, balance: 320, sw: 319, head: 100, pattern: '16×19' },
  );
  assert.strictEqual(cmp.a.weight, 307);
  assert.ok(cmp.a.sw > cmp.b.sw + 10);
  assert.strictEqual(cmp.rows.length, 5);
  assert.ok(cmp.tips.length >= 1);

  const coldPoly = Lab.recommendTension({ temp: 'cold', material: 'poly', head: 97, style: 'power', arm: 'sensitive' });
  const hotMulti = Lab.recommendTension({ temp: 'hot', material: 'multi', head: 105, style: 'control', arm: 'normal' });
  assert.ok(coldPoly.mainRec < hotMulti.mainRec, '低温小拍面聚酯护手推荐磅数应显著低于高温大拍面多丝控球');
  assert.ok(coldPoly.mainRec >= 40 && hotMulti.mainRec <= 60);
  assert.match(coldPoly.tempDeltaText, /-2\.5/);
  assert.match(hotMulti.tempDeltaText, /\+2/);
});

test('成长档案「清除全部私人记录」：连同本机的训练打卡和赛季目标一起删，别的账号不动；只有训练打卡也显示清除按钮', () => {
  withWxStorage(() => {
    TR.addLog('u1', { date: '2026-11-10', drill: 'serve', minutes: 60, score: 4 }, '2026-11-26');
    TR.saveGoals('u1', '2025', { matches: GOAL_ANY('matches'), hours: 0, level: 0 });
    TR.saveGoals('u1', '2026', { matches: GOAL_ANY('matches'), hours: 0, level: 0 });
    TR.addLog('u2', { date: '2026-11-11', drill: 'serve', minutes: 30, score: 3 }, '2026-11-26');
    TR.saveGoals('u2', '2026', { matches: GOAL_ANY('matches'), hours: 0, level: 0 });
    TR.saveGoals('u10', '2026', { matches: GOAL_ANY('matches'), hours: 0, level: 0 }); // 前缀相近的账号
    assert.strictEqual(TR.hasAny('u1'), true);
    TR.clearAll('u1');
    assert.strictEqual(TR.loadLogs('u1').length, 0);
    assert.strictEqual(TR.loadGoals('u1', '2025').matches, 0);
    assert.strictEqual(TR.loadGoals('u1', '2026').matches, 0);
    assert.strictEqual(TR.hasAny('u1'), false);
    assert.strictEqual(TR.loadLogs('u2').length, 1, '别的账号的训练打卡不动');
    assert.ok(TR.loadGoals('u2', '2026').matches > 0 && TR.loadGoals('u10', '2026').matches > 0, '别的账号的目标不动');
    TR.clearAll(''); // 没有账号什么都不做
    assert.strictEqual(TR.loadLogs('u2').length, 1);
  });
  const js = fs.readFileSync(path.join(__dirname, '../pkg-manage/growth/growth.js'), 'utf8');
  const fn = js.slice(js.indexOf('  clearAll() {'));
  assert.ok(/A\.clear\(\)\.then\(\(n\) => \{[\s\S]{0,200}TR\.clearAll\(/.test(fn), '云端删掉之后再删本机的');
  assert.match(fn, /训练打卡和赛季目标/);
  const xml = fs.readFileSync(path.join(__dirname, '../pkg-manage/growth/growth.wxml'), 'utf8');
  assert.match(xml, /wx:if="\{\{has \|\| hasLocal\}\}" class="danger-zone"/);
});

test('成长档案 2.0：训练打卡、按月高频短板 Top3（合并比赛与训练标签）与个人赛季目标进度', () => {
  withWxStorage(() => {
    const r1 = TR.addLog('u1', { date: '2026-11-10', drill: 'serve', minutes: 60, score: 4, weakTags: ['一发掉速', '失误多'] }, '2026-11-26');
    const r2 = TR.addLog('u1', { date: '2026-11-15', drill: 'rally', minutes: 90, score: 5, weakTags: ['反手偏浅', '失误多'] }, '2026-11-26');
    const bad = TR.addLog('u1', { date: '2026-11-20', drill: 'unknown', minutes: 60, score: 4 }, '2026-11-26');
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(bad.ok, false);
    // 不同账号隔离
    assert.strictEqual(TR.loadLogs('u2').length, 0);

    const logs = TR.loadLogs('u1');
    const sum = TR.trainingSummary(logs, '2026-11-26');
    assert.deepStrictEqual([sum.totalCount, sum.monthCount, sum.monthHours, sum.yearMin], [2, 2, 2.5, 150]);

    // 合并成长档案私人比赛的「失误多 / 体能不足」与训练打卡短板
    const growthMatches = [
      { date: '2026-11-12', tags: ['失误多', '体能不足'] },
      { date: '2026-10-05', tags: ['心态波动'] },
    ];
    const wk = TR.weaknessTop3(growthMatches, logs, '2026-11');
    assert.strictEqual(wk.top3[0].tag, '失误多');
    assert.strictEqual(wk.top3[0].count, 3, '训练 2 次 + 比赛 1 次 = 3 次');
    assert.strictEqual(wk.top3.length, 3);
    // 切到 10 月只算 10 月
    const wk10 = TR.weaknessTop3(growthMatches, logs, '2026-10');
    assert.strictEqual(wk10.top3.length, 1);
    assert.strictEqual(wk10.top3[0].tag, '心态波动');

    // 个人赛季目标
    const g = TR.saveGoals('u1', '2026', { matches: 50, hours: 20, level: 3.5 });
    const prog = TR.goalsProgress(g, { yearMatches: 25, yearTrainingMin: 600, currentLevel: 3.52 });
    assert.strictEqual(prog.items.length, 3);
    assert.strictEqual(prog.items[0].pct, 50);
    assert.strictEqual(prog.items[1].pct, 50);
    assert.strictEqual(prog.items[2].done, true, '3.52 按 0.5 档为 3.5，达成 3.5 目标');

    // 删除一条打卡
    const after = TR.removeLog('u1', r1.rec.id);
    assert.strictEqual(after.length, 1);
  });
});

test('管理员提效：常用活动模板库（最多 5 套、同名覆盖、预设内置、删除与校验）', () => {
  withWxStorage(() => {
    const init = TPL.listTemplates();
    assert.strictEqual(init.saved.length, 0);
    assert.strictEqual(init.builtins.length, 3);

    for (let i = 1; i <= 5; i++) {
      const r = TPL.saveTemplate({
        title: `模板${i}`, mode: 'bracket', size: 8, type: 'single',
        rules: { ko: { setGames: 6, noAd: true, bestOf: 1 } },
        startTime: '19:00', venue: '3号场', level: { min: 3.0, max: 3.5 },
        cupOn: true, cupKind: 'weekly', cupPointGroup: '3.5',
      });
      assert.strictEqual(r.ok, true);
    }
    // 超过 5 套新模板被拦下
    const over = TPL.saveTemplate({ title: '模板6', mode: 'bracket', size: 8, type: 'single' });
    assert.strictEqual(over.ok, false);
    // 同名模板覆盖更新成功
    const upd = TPL.saveTemplate({ title: '模板1', mode: 'groups_ko', groupCount: 2, advance: 2, type: 'double' });
    assert.strictEqual(upd.ok, true);
    assert.strictEqual(upd.updated, true);
    assert.strictEqual(upd.all.saved.length, 5);
    assert.strictEqual(upd.all.saved.find((x) => x.name === '模板1').mode, 'groups_ko');

    // 删除后可继续保存
    const afterDel = TPL.removeTemplate(upd.rec.id);
    assert.strictEqual(afterDel.saved.length, 4);
    // 编号不重复（同一毫秒连着存也不撞号，删一套不会连带删掉别的）
    const ids = afterDel.saved.map((x) => x.id);
    assert.strictEqual(new Set(ids).size, ids.length);
    const realRandom = Math.random, realNow = Date.now;
    try {
      Math.random = () => 0.5; Date.now = () => 1; // 让两套的「毫秒 + 随机数」完全一样
      const x1 = TPL.saveTemplate({ title: '撞号A', mode: 'bracket', size: 8, type: 'single' });
      assert.strictEqual(x1.ok, true);
      TPL.removeTemplate(ids[0]);
      const x2 = TPL.saveTemplate({ title: '撞号B', mode: 'bracket', size: 8, type: 'single' });
      assert.notStrictEqual(x2.rec.id, x1.rec.id);
    } finally { Math.random = realRandom; Date.now = realNow; }
  });
});

test('管理员提效：运营统计（时段/水平成局率、30/90天活跃分层）与年度总结/CSV 一键导出', () => {
  const players = [
    { uid: 'u1', name: '小安', gender: 'm', level: 3.5, shown: true },
    { uid: 'u2', name: '阿博', gender: 'm', level: 3.0, shown: true },
    { uid: 'u3', name: '小陈', gender: 'f', level: 2.5, shown: true },
    { uid: 'u4', name: '大东', gender: 'm', level: 3.0, shown: true },
  ];
  const members = players.map((p) => ({ uid: p.uid, nickname: p.name, gender: p.gender }));
  const draws = [
    // 周六上午 3.0-3.5 已成局
    { _id: 'd1', date: '2026-11-14', startTime: '09:00', status: 'drawn', mode: 'bracket', entrants: ['小安', '阿博', '小陈', '大东'], level: { min: 3.0, max: 3.5 } },
    // 周三晚场 3.0-3.5 未成局（已过日期仍 signup）
    { _id: 'd2', date: '2026-11-18', startTime: '19:30', status: 'signup', mode: 'rotation', entrants: [], level: { min: 3.0, max: 3.5 } },
    // 未来活动（仍在报名中，不应拉低成局率）
    { _id: 'd3', date: '2026-12-05', startTime: '10:00', status: 'signup', mode: 'bracket', entrants: [] },
  ];
  const rawMatches = [];
  // u1 近 30 天打 4 场（高活跃），u2 近 30 天打 2 场（正常活跃），u3 60 天前打 1 场（31~90天），u4 无比赛（90天未出勤）
  for (let i = 1; i <= 4; i++) {
    rawMatches.push({ _id: 'r' + i, date: `2026-11-1${i}`, type: 'single', a: ['小安'], b: ['阿博'], aIds: ['u1'], bIds: [i <= 2 ? 'u2' : 'u9'], winner: 'a', sets: [{ a: 6, b: 3 }] });
  }
  rawMatches.push({ _id: 'old1', date: '2026-09-20', type: 'single', a: ['小陈'], b: ['阿博'], aIds: ['u3'], bIds: ['u2'], winner: 'a', sets: [{ a: 6, b: 4 }] });
  const ms = ID.normalizeMatches(rawMatches, players);

  const stopRec = C.cleanStop({ date: '2026-11-14', kind: 'weekly', format: 'single', scoreVersion: 2, pointGroup: 'open', places: { champion: ['u1'], runnerUp: ['u2'], semis: [['u3']], floor: [] } }, '2026-11-26').rec;
  const stops = [Object.assign({ id: 'st1', status: 'published' }, stopRec, { results: C.results(stopRec, () => 'm') })];

  const rep = Ops.opsReport({ draws, matches: ms, players, members, stops, today: '2026-11-26', year: 2026 });
  assert.deepStrictEqual([rep.overview.settledDraws, rep.overview.formedTotal, rep.overview.formRate], [2, 1, 50]);
  assert.deepStrictEqual([rep.overview.totalMembers, rep.overview.hotCount, rep.overview.active30, rep.overview.warmCount, rep.overview.coldCount], [4, 1, 2, 1, 1]);
  assert.strictEqual(rep.overview.active30Rate, 50);
  assert.strictEqual(rep.overview.active90Rate, 75);
  // 报表内容检查
  assert.match(rep.exports.summaryText, /LULU 网球 · 2026 年度运营汇总报表/);
  assert.match(rep.exports.summaryText, /小安/);
  assert.match(rep.exports.membersCsv, /^昵称,性别,比赛等级/);
  assert.match(rep.exports.cupCsv, /单打年终榜,1,小安/);
  assert.ok(!/俱乐部|赛事|决赛|签表/.test(rep.exports.summaryText + rep.exports.membersCsv + rep.exports.cupCsv));
});

test('新页面与入口合规：禁分享、零俱乐部字样、成员管理已用「运营统计」替换「数据核对」', () => {
  const app = JSON.parse(read('app.json'));
  assert.ok(app.subpackages.find((s) => s.root === 'pkg-tools').pages.includes('racket-lab/racket-lab'));
  assert.ok(!app.subpackages.find((s) => s.root === 'pkg-manage').pages.includes('ops/ops'));
  const cfg = JSON.parse(read('pkg-tools/racket-lab/racket-lab.json'));
  const js = read('pkg-tools/racket-lab/racket-lab.js');
  const xml = read('pkg-tools/racket-lab/racket-lab.wxml');
  assert.strictEqual(cfg.enableShareAppMessage, false);
  assert.strictEqual(cfg.enableShareTimeline, false);
  assert.ok(/wx\.hideShareMenu\(/.test(js) && !/onShareAppMessage|onShareTimeline/.test(js));
  assert.ok(!/俱乐部/.test(xml + js));
  assert.ok(/openLab/.test(read('pages/racket/racket.wxml')));
  assert.ok(/openTrainSheet/.test(read('pkg-manage/growth/growth.wxml')) && /openGoalSheet/.test(read('pkg-manage/growth/growth.wxml')));
  assert.ok(/saveCurrentAsTemplate/.test(read('pkg-manage/draw-new/draw-new.wxml')));
  const memXml = read('pkg-manage/members/members.wxml');
  const memJs = read('pkg-manage/members/members.js');
  assert.ok(/data-v="ops"[^>]*>运营统计</.test(memXml) && !/数据核对|runAudit|auditSignups/.test(memXml + memJs));
  assert.ok(!/俱乐部/.test(memXml + memJs));
});

module.exports = T;
