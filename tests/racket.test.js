// 我的球拍：字段校验、提醒和统计，以及云函数的本人隔离（在内存数据库里跑真实代码）
const assert = require('assert');
const createEnv = require('./mock-cloud');
const K = require('../utils/racket');

const T = [];
const test = (name, fn) => T.push({ name, fn });
const ok = (r) => { assert.ok(r && r.ok, JSON.stringify(r)); return r; };
const no = (r, re) => { assert.strictEqual(r && r.ok, false, '应该被拒绝：' + JSON.stringify(r)); if (re) assert.match(r.error, re); return r; };

const TODAY = '2026-11-17';
const racket = (o) => Object.assign({ brand: 'wilson', model: 'Blade', bought: '2026-01-10', status: 'active', tags: [], remind: { string: 30, overgrip: 14 } }, o || {});
const str = (o) => Object.assign({ kind: 'string', date: '2026-10-01', main: { brand: 'luxilon', model: 'ALU Power' }, cross: null, mains: 52, crosses: 50, cost: 80, feel: 4, tags: [] }, o || {});
const maint = (o) => Object.assign({ kind: 'maint', date: '2026-11-01', item: 'overgrip', cost: 15 }, o || {});

function setup() {
  const env = createEnv();
  env.load();
  env.members([['alice', 'Alice'], ['bob', 'Bob']]);
  return env;
}

test('校验：品牌、型号、球线、维护项目、备注只认固定选项；磅数、费用、手感、日期按范围；多余字段丢掉', () => {
  const r = K.cleanRacket(racket({ nickname: '我的爱拍', note: '自由文字', owner: 'bob', no: 99 }), TODAY);
  assert.ok(r.ok);
  assert.deepStrictEqual(Object.keys(r.rec).sort(), ['bought', 'brand', 'model', 'remind', 'status', 'tags']);
  assert.ok(K.cleanRacket(racket({ model: K.OTHER }), TODAY).ok);
  assert.ok(K.cleanRacket(racket({ brand: 'other', model: K.OTHER }), TODAY).ok);
  assert.ok(!K.cleanRacket(racket({ model: 'Pure Aero' }), TODAY).ok, '型号要属于这个品牌');
  assert.ok(!K.cleanRacket(racket({ brand: '自己写的牌子' }), TODAY).ok);
  assert.ok(!K.cleanRacket(racket({ bought: '2026-11-18' }), TODAY).ok);
  assert.ok(K.cleanRacket(racket({ bought: '' }), TODAY).ok, '购入日期可不填');
  assert.ok(!K.cleanRacket(racket({ status: 'sold' }), TODAY).ok, '没有交易相关的状态');
  assert.ok(!K.cleanRacket(racket({ tags: ['自由文字'] }), TODAY).ok);
  assert.ok(!K.cleanRacket(racket({ remind: { string: 33 } }), TODAY).ok, '提醒间隔只能选固定值');
  assert.ok(!K.cleanRacket(racket({ remind: { weight: 30 } }), TODAY).ok);
  assert.deepStrictEqual(K.cleanRacket(racket({ remind: { string: 0, overgrip: 14 } }), TODAY).rec.remind, { overgrip: 14 });

  const s = K.cleanLog(str({ racketId: 'x', owner: 'bob', note: '自由文字' }), TODAY);
  assert.ok(s.ok);
  assert.deepStrictEqual(Object.keys(s.rec).sort(), ['cost', 'cross', 'crosses', 'date', 'feel', 'kind', 'main', 'mains', 'tags']);
  assert.ok(!K.cleanLog(str({ main: { brand: 'luxilon', model: 'RPM Blast' } }), TODAY).ok);
  assert.ok(K.cleanLog(str({ cross: { brand: 'babolat', model: 'VS Touch' } }), TODAY).ok, '混穿');
  assert.ok(!K.cleanLog(str({ cross: { brand: 'x', model: 'y' } }), TODAY).ok);
  for (const bad of [{ mains: 29 }, { crosses: 71 }, { mains: 52.5 }, { cost: -1 }, { cost: 10000 }, { cost: 'abc' }, { feel: 6 }, { feel: 2.5 }, { date: '2026-11-18' }, { date: '2026-02-30' }, { tags: ['断线'] }]) {
    assert.ok(!K.cleanLog(str(bad), TODAY).ok, JSON.stringify(bad));
  }
  assert.strictEqual(K.cleanLog(str({ cost: '' }), TODAY).rec.cost, null);
  assert.strictEqual(K.cleanLog(str({ cost: 80.456 }), TODAY).rec.cost, 80.46);
  assert.ok(K.cleanLog(maint(), TODAY).ok);
  assert.ok(!K.cleanLog(maint({ item: '换了个自己写的东西' }), TODAY).ok);
  assert.ok(!K.cleanLog({ kind: 'other', date: TODAY }, TODAY).ok);
});

test('提醒和统计：从最近一次记录算，没有记录从购入日期算；退役不提醒；混穿、磅数文字', () => {
  const r = { id: 'r1', no: 1, brand: 'wilson', model: 'Blade', bought: '2026-01-10', status: 'active', remind: { string: 30, overgrip: 14, grip: 180 } };
  const logs = [
    { id: 'l1', racketId: 'r1', kind: 'string', date: '2026-09-01', main: { brand: 'luxilon', model: 'ALU Power' }, cross: null, mains: 52, crosses: 52, cost: 80 },
    { id: 'l2', racketId: 'r1', kind: 'string', date: '2026-10-20', main: { brand: 'luxilon', model: 'ALU Power' }, cross: { brand: 'babolat', model: 'VS Touch' }, mains: 52, crosses: 50, cost: 120 },
    { id: 'l3', racketId: 'r1', kind: 'maint', date: '2026-11-10', item: 'overgrip', cost: 15 },
    { id: 'x', racketId: 'r2', kind: 'string', date: '2026-11-16', main: { brand: 'luxilon', model: '4G' }, mains: 50, crosses: 50 },
  ];
  const s = K.summary(r, logs, TODAY);
  assert.deepStrictEqual([s.stringCount, s.maintCount, s.cost], [2, 1, 215]);
  assert.strictEqual(s.lastString.date, '2026-10-20');
  assert.strictEqual(s.lastString.text, '竖 Luxilon ALU Power / 横 Babolat VS Touch');
  assert.strictEqual(s.lastString.tension, '竖 52 · 横 50 磅');
  assert.deepStrictEqual(s.timeline.map((l) => l.id), ['l3', 'l2', 'l1']);
  const by = {}; s.reminders.forEach((x) => { by[x.item] = x; });
  assert.deepStrictEqual([by.string.due, by.string.state, by.string.left], ['2026-11-19', 'soon', 2]);
  assert.deepStrictEqual([by.overgrip.due, by.overgrip.state], ['2026-11-24', 'soon']);
  assert.deepStrictEqual([by.grip.due, by.grip.state], ['2026-07-09', 'over'], '没有底胶记录：从购入日期算');
  assert.strictEqual(s.reminders[0].item, 'grip', '已到期的排最前');
  assert.strictEqual(s.due, 3);
  assert.strictEqual(K.summary(Object.assign({}, r, { bought: '' }), [], TODAY).reminders[0].state, 'none');
  assert.strictEqual(K.summary(Object.assign({}, r, { status: 'retired' }), logs, TODAY).reminders.length, 0);
  const o = K.overview([r, { id: 'r2', no: 2, brand: 'head', model: 'Speed', status: 'retired', remind: {} }], logs, TODAY);
  assert.deepStrictEqual([o.rackets, o.inUse, o.stringCount, o.maintCount, o.lastString, o.due], [2, 1, 3, 1, '2026-11-16', 3]);
  assert.strictEqual(K.racketName({ brand: 'other', model: K.OTHER }), '其他');
  assert.strictEqual(K.racketName({ brand: 'head', model: K.OTHER }), 'Head 其他型号');
});

test('云函数：球拍和记录只属于本人；客户端传的 owner 无效；不能把记录挂到别人的球拍上', async () => {
  const env = setup();
  const a1 = ok(await env.call('alice', 'racketSave', { racket: racket(), owner: 'bob', openid: 'bob' }));
  assert.strictEqual(a1.no, 1);
  const doc = env.coll('rackets')[a1.id];
  assert.strictEqual(doc.owner, 'alice'); assert.strictEqual(doc._openid, undefined);
  assert.strictEqual(ok(await env.call('alice', 'racketSave', { racket: racket({ model: 'Clash' }) })).no, 2, '自动编号');
  const b1 = ok(await env.call('bob', 'racketSave', { racket: racket() }));
  assert.strictEqual(b1.no, 1, '每人各自编号');
  const l1 = ok(await env.call('alice', 'racketLogSave', { racketId: a1.id, log: str(), owner: 'bob' })).id;
  assert.strictEqual(env.coll('racket_logs')[l1].owner, 'alice');
  assert.strictEqual(env.coll('racket_logs')[l1].racketId, a1.id);
  // 别人：看不到、改不了、删不掉，也不能把记录挂到 alice 的球拍上
  const bl = ok(await env.call('bob', 'racketList', { owner: 'alice' }));
  assert.deepStrictEqual(bl.rackets.map((r) => r.id), [b1.id]); assert.strictEqual(bl.logs.length, 0);
  const before = JSON.stringify(env.store);
  no(await env.call('bob', 'racketSave', { id: a1.id, racket: racket({ status: 'retired' }) }), /不存在/);
  no(await env.call('bob', 'racketRemove', { id: a1.id }), /不存在/);
  no(await env.call('bob', 'racketLogSave', { racketId: a1.id, log: str() }), /不存在/);
  no(await env.call('bob', 'racketLogSave', { id: l1, racketId: b1.id, log: str() }), /不存在/);
  no(await env.call('bob', 'racketLogRemove', { id: l1 }), /不存在/);
  assert.strictEqual(JSON.stringify(env.store), before);
  no(await env.call('bob', 'data', { op: 'get', coll: 'rackets', where: { owner: 'alice' } }));
  no(await env.call('bob', 'data', { op: 'get', coll: 'racket_logs', where: { owner: 'alice' } }));
  // 本人修改：编辑记录不能换球拍、不能改类型；提醒整体替换（关掉的不残留）
  ok(await env.call('alice', 'racketLogSave', { id: l1, racketId: b1.id, log: str({ mains: 55, crosses: 53 }) }));
  assert.strictEqual(env.coll('racket_logs')[l1].racketId, a1.id);
  assert.strictEqual(env.coll('racket_logs')[l1].mains, 55);
  no(await env.call('alice', 'racketLogSave', { id: l1, log: maint() }), /类型/);
  ok(await env.call('alice', 'racketSave', { id: a1.id, racket: racket({ remind: { grip: 180 } }) }));
  assert.deepStrictEqual(env.coll('rackets')[a1.id].remind, { grip: 180 });
  assert.strictEqual(env.coll('rackets')[a1.id].no, 1, '编号不变');
  no(await env.call('alice', 'racketSave', { racket: racket({ note: 'x', tags: ['自由文字'] }) }), /选项/);
  no(await env.call('alice', 'racketLogSave', { racketId: a1.id, log: str({ date: '2999-01-01' }) }), /晚于今天/);
});

test('云函数：删除球拍连同记录一起删；清除全部只清本人；非成员不能用', async () => {
  const env = setup();
  const a1 = ok(await env.call('alice', 'racketSave', { racket: racket() })).id;
  const a2 = ok(await env.call('alice', 'racketSave', { racket: racket({ model: 'Clash' }) })).id;
  const b1 = ok(await env.call('bob', 'racketSave', { racket: racket() })).id;
  ok(await env.call('alice', 'racketLogSave', { racketId: a1, log: str() }));
  ok(await env.call('alice', 'racketLogSave', { racketId: a1, log: maint() }));
  const keep = ok(await env.call('alice', 'racketLogSave', { racketId: a2, log: str() })).id;
  ok(await env.call('bob', 'racketLogSave', { racketId: b1, log: str() }));
  assert.strictEqual(ok(await env.call('alice', 'racketRemove', { id: a1 })).logs, 2);
  const l = ok(await env.call('alice', 'racketList'));
  assert.deepStrictEqual(l.rackets.map((r) => r.id), [a2]); assert.deepStrictEqual(l.logs.map((x) => x.id), [keep]);
  assert.strictEqual(ok(await env.call('alice', 'racketSave', { racket: racket() })).no, 3, '删掉的编号不复用到在用的球拍上');
  ok(await env.call('alice', 'racketLogRemove', { id: keep }));
  no(await env.call('alice', 'racketClear', {}), /确认/);
  ok(await env.call('alice', 'racketClear', { confirm: true }));
  assert.strictEqual(ok(await env.call('alice', 'racketList')).rackets.length, 0);
  const bl = ok(await env.call('bob', 'racketList'));
  assert.deepStrictEqual([bl.rackets.length, bl.logs.length], [1, 1], '别人的不受影响');
  no(await env.call('stranger', 'racketList'), /请先验证/);
  no(await env.call('stranger', 'racketSave', { racket: racket() }), /请先验证/);
});

test('页面：我的球拍各页不能分享，没有文字输入框（费用只能填数字），只经 utils/rackets.js 读写', () => {
  const fs = require('fs'), path = require('path'), root = path.resolve(__dirname, '..');
  for (const p of ['pages/racket/racket', 'pkg-tools/racket-view/racket-view', 'pkg-tools/racket-edit/racket-edit', 'pkg-tools/racket-log/racket-log']) {
    const js = fs.readFileSync(path.join(root, p + '.js'), 'utf8');
    const xml = fs.readFileSync(path.join(root, p + '.wxml'), 'utf8');
    const cfg = JSON.parse(fs.readFileSync(path.join(root, p + '.json'), 'utf8'));
    assert.ok(!/onShareAppMessage|onShareTimeline/.test(js) && /wx\.hideShareMenu\(\)/.test(js), p);
    assert.strictEqual(cfg.enableShareAppMessage, false); assert.strictEqual(cfg.enableShareTimeline, false);
    assert.ok(!/<textarea\b/.test(xml));
    (xml.match(/<input\b[^>]*>/g) || []).forEach((tag) => assert.ok(/type="(digit|number)"/.test(tag), p + ' 只允许数字输入'));
    assert.ok(!/wx\.cloud\.database|setStorageSync/.test(js), p + ' 不写本机存储、不直连数据库');
  }
  const cloud = fs.readFileSync(path.join(root, 'utils/cloud.js'), 'utf8');
  assert.ok(/racketList: 1/.test(cloud), 'racketList 是只读操作');
});

test('球拍示意图：每个品牌、每个系列都有配色，「其他」用品牌默认配色，没选品牌用主题色；不再有照片上传', async () => {
  const A = require('../utils/racket-art');
  const hex = /^#[0-9A-F]{6}$/i;
  for (const b of K.RACKET_BRANDS) {
    assert.ok(A.ART[b.k] && A.ART[b.k]._, b.k + ' 缺默认配色');
    for (const m of b.models) assert.ok(A.ART[b.k][m], `${b.n} ${m} 缺配色`);
    for (const m of K.modelsOf(K.RACKET_BRANDS, b.k)) { const c = A.artOf(b.k, m); assert.ok(hex.test(c.f) && hex.test(c.a) && hex.test(c.g), `${b.k} ${m}`); }
    assert.deepStrictEqual(A.artOf(b.k, K.OTHER), A.artOf(b.k, '没有的型号'));
  }
  assert.strictEqual(A.artOf('', '').f, '#A3A3CB');
  // 云端：球拍照片接口已删除；以前版本留下的照片字段不下发，删除球拍时一起删文件
  const env = setup();
  const a = ok(await env.call('alice', 'racketSave', { racket: racket() })).id;
  no(await env.call('alice', 'racketPhoto', { racketId: a, fileID: 'cloud://env1.x/avatars/alice/x.jpg' }), /未知操作/);
  Object.assign(env.coll('rackets')[a], { photo: 'cloud://env1.x/racket-photos/alice/old.jpg', photoState: 'ok', photoRequest: 'r', photoTrace: 't' });
  const r = ok(await env.call('alice', 'racketList')).rackets[0];
  assert.ok(!/photo/i.test(Object.keys(r).join(',')), '不下发照片字段');
  ok(await env.call('alice', 'racketRemove', { id: a }));
  assert.ok(env.deletedFiles.includes('cloud://env1.x/racket-photos/alice/old.jpg'));
  // 以前版本提交的球拍照片检测晚到：不处理、不报错
  env.put('avatar_checks', { _id: 'old-trace', kind: 'racket', uid: 'alice', racketId: a, request: 'r', fileID: 'x', status: 'checking', at: Date.now() });
  assert.strictEqual(await env.push({ trace_id: 'old-trace', result: { suggest: 'pass' } }), 'success');
  assert.strictEqual(env.coll('avatar_checks')['old-trace'].status, 'checking');
});

/* ---------- 按实际打球时长换线 ---------- */
const play = (o) => Object.assign({ kind: 'play', date: '2026-11-10', minutes: 90 }, o || {});

test('使用记录校验：只存日期 + 整数分钟（1～600），字符串、小数、0、超范围、未来日期都拒绝；多余字段丢掉', () => {
  const r = K.cleanLog(play({ note: '自由文字', cost: 30, racketId: 'x', owner: 'bob', photo: 'x.jpg' }), TODAY);
  assert.ok(r.ok);
  assert.deepStrictEqual(r.rec, { kind: 'play', date: '2026-11-10', minutes: 90 });
  assert.ok(K.cleanLog(play({ minutes: 1 }), TODAY).ok);
  assert.ok(K.cleanLog(play({ minutes: 600 }), TODAY).ok);
  for (const m of [0, -30, 601, 90.5, '90', '', null, undefined, NaN, Infinity, [90], { v: 90 }, true]) {
    assert.ok(!K.cleanLog(play({ minutes: m }), TODAY).ok, '应拒绝 ' + JSON.stringify(m));
  }
  assert.ok(!K.cleanLog(play({ date: '2026-11-18' }), TODAY).ok, '不能晚于今天');
  assert.ok(!K.cleanLog(play({ date: '2026-02-30' }), TODAY).ok);
  // 换线时长提醒：只能选固定值，默认关闭；没带字段（旧版小程序）不写
  assert.strictEqual(K.cleanRacket(racket({ hours: 20 }), TODAY).rec.hours, 20);
  assert.strictEqual(K.cleanRacket(racket({ hours: 0 }), TODAY).rec.hours, 0);
  assert.ok(!('hours' in K.cleanRacket(racket(), TODAY).rec));
  for (const h of [12, -10, '20', null, 20.5]) assert.ok(!K.cleanRacket(racket({ hours: h }), TODAY).ok, JSON.stringify(h));
});

test('已打时长：从最近一次穿线的日期算起（当天算新线），旧记录保留不累计；同日多次穿线、补录只看日期；没有穿线算全部', () => {
  const r = { id: 'r1', no: 1, brand: 'wilson', model: 'Blade', bought: '2026-01-10', status: 'active', remind: {}, hours: 20 };
  const s1 = { id: 's1', racketId: 'r1', kind: 'string', date: '2026-10-01', main: { brand: 'luxilon', model: '4G' }, cross: null, mains: 52, crosses: 52, createdAt: 1 };
  const s2 = Object.assign({}, s1, { id: 's2', date: '2026-11-01', createdAt: 2 });
  const p = (id, date, minutes, createdAt) => ({ id, racketId: 'r1', kind: 'play', date, minutes, createdAt: createdAt || 0 });
  const logs = [s1, s2, p('a', '2026-10-05', 120), p('b', '2026-10-31', 60), p('c', '2026-11-01', 90), p('d', '2026-11-05', 120), p('x', '2026-11-06', 300)];
  logs[logs.length - 1].racketId = 'r2'; // 别的球拍不算
  let s = K.summary(r, logs, TODAY);
  assert.deepStrictEqual([s.play.since, s.play.minutes, s.play.hours, s.play.sessions, s.play.target], ['2026-11-01', 210, '3.5', 2, 20], '穿线当天（11-01）的 90 分钟算新线');
  assert.deepStrictEqual(s.plays.map((l) => l.id), ['d', 'c', 'b', 'a'], '旧球线的使用记录保留');
  assert.deepStrictEqual([s.play.state, s.play.text, s.play.pct], ['ok', '还差 16.5 小时', 18]);
  assert.ok(s.timeline.every((l) => l.kind !== 'play'), '时间线只有穿线 / 维护');
  assert.deepStrictEqual([s.stringCount, s.maintCount], [2, 0], '使用记录不算维护次数');
  // 记一条新穿线：新球线从零累计，旧记录还在
  const s3 = Object.assign({}, s1, { id: 's3', date: '2026-11-10', createdAt: 3 });
  s = K.summary(r, logs.concat(s3), TODAY);
  assert.deepStrictEqual([s.play.since, s.play.minutes, s.play.sessions, s.plays.length], ['2026-11-10', 0, 0, 4]);
  // 同一天又记了一次穿线：还是这一天，结果和录入顺序无关
  const s4 = Object.assign({}, s1, { id: 's4', date: '2026-11-10', createdAt: 0 });
  const t1 = K.summary(r, logs.concat(s3, s4, p('e', '2026-11-10', 45)), TODAY).play;
  const t2 = K.summary(r, [p('e', '2026-11-10', 45), s4, s3].concat(logs.slice().reverse()), TODAY).play;
  assert.deepStrictEqual([t1.since, t1.minutes], ['2026-11-10', 45]);
  assert.deepStrictEqual(t1, t2, '只看日期，和录入顺序无关');
  // 补录：更早的使用记录归到当时的球线；补录一条更早的穿线不会把这次清零
  s = K.summary(r, logs.concat(p('f', '2026-10-20', 600)), TODAY);
  assert.strictEqual(s.play.minutes, 210);
  s = K.summary(r, logs.concat(Object.assign({}, s1, { id: 's0', date: '2026-09-01', createdAt: 9 })), TODAY);
  assert.deepStrictEqual([s.play.since, s.play.minutes], ['2026-11-01', 210]);
  // 补录一条更晚的使用记录，日期在这次穿线之后就算进来
  s = K.summary(r, logs.concat(p('g', '2026-11-16', 30, 99)), TODAY);
  assert.strictEqual(s.play.minutes, 240);
  // 没有穿线记录：全部使用记录都算
  s = K.summary(r, logs.filter((l) => l.kind === 'play'), TODAY);
  assert.deepStrictEqual([s.play.since, s.play.minutes], ['', 390]);
  // 文字
  assert.deepStrictEqual([K.hoursText(0), K.hoursText(90), K.hoursText(100), K.hoursText(1200)], ['0', '1.5', '1.7', '20']);
  assert.deepStrictEqual([K.minutesText(45), K.minutesText(60), K.minutesText(135)], ['45 分钟', '1 小时', '2 小时 15 分钟']);
});

test('换线提醒：时长和天数合成同一条「穿线」，两个都到了只算一次；没设时长（旧球拍）照旧；退役不提醒', () => {
  const base = { id: 'r1', no: 1, brand: 'wilson', model: 'Blade', bought: '2026-01-10', status: 'active', remind: { string: 30 } };
  const str1 = { id: 's1', racketId: 'r1', kind: 'string', date: '2026-10-01', main: { brand: 'luxilon', model: '4G' }, cross: null, mains: 52, crosses: 52 };
  const p = (id, minutes) => ({ id, racketId: 'r1', kind: 'play', date: '2026-10-10', minutes });
  const stringRm = (s) => s.reminders.filter((x) => x.item === 'string');
  // 旧球拍（没有 hours）：只有按天的提醒，和以前一样
  let s = K.summary(base, [str1, p('a', 600), p('b', 600)], TODAY);
  assert.strictEqual(stringRm(s).length, 1);
  assert.deepStrictEqual([stringRm(s)[0].state, stringRm(s)[0].text, stringRm(s)[0].hours], ['over', '已超过 17 天', undefined]);
  assert.strictEqual(s.play.state, '', '没设目标就没有时长状态');
  // 两个条件都到了：仍然只有一条，due 只算 1
  s = K.summary(Object.assign({}, base, { hours: 20 }), [str1, p('a', 600), p('b', 600)], TODAY);
  assert.strictEqual(stringRm(s).length, 1);
  assert.strictEqual(s.due, 1);
  assert.deepStrictEqual([stringRm(s)[0].state, stringRm(s)[0].hours, stringRm(s)[0].played], ['over', 20, '20']);
  // 天数没到、时长到了：显示时长
  const fresh = Object.assign({}, str1, { date: '2026-11-15' });
  const p2 = (id, minutes) => ({ id, racketId: 'r1', kind: 'play', date: '2026-11-16', minutes });
  s = K.summary(Object.assign({}, base, { hours: 10 }), [fresh, p2('a', 600), p2('b', 30)], TODAY);
  assert.deepStrictEqual([stringRm(s)[0].state, stringRm(s)[0].text, s.due], ['over', '已超过 0.5 小时', 1]);
  // 打满 80%：快到了
  s = K.summary(Object.assign({}, base, { hours: 10 }), [fresh, p2('a', 480)], TODAY);
  assert.deepStrictEqual([stringRm(s)[0].state, stringRm(s)[0].text], ['soon', '还差 2 小时']);
  // 只设时长、不按天：也是一条「穿线」
  s = K.summary(Object.assign({}, base, { remind: {}, hours: 10 }), [fresh, p2('a', 600)], TODAY);
  assert.deepStrictEqual([stringRm(s).length, stringRm(s)[0].state, stringRm(s)[0].text, stringRm(s)[0].everyText, s.due], [1, 'over', '刚好打满', '满 10 小时', 1]);
  // 时长关闭（0）：不出现时长提醒
  s = K.summary(Object.assign({}, base, { remind: {}, hours: 0 }), [fresh, p2('a', 600)], TODAY);
  assert.deepStrictEqual([s.reminders.length, s.due], [0, 0]);
  // 退役：不提醒，但时长照常统计
  s = K.summary(Object.assign({}, base, { hours: 10, status: 'retired' }), [fresh, p2('a', 600)], TODAY);
  assert.deepStrictEqual([s.reminders.length, s.play.minutes, s.play.state], [0, 600, '']);
  // tab 上的数字（overview.due）同样只算一次；使用记录不算维护
  const o = K.overview([Object.assign({}, base, { hours: 20 })], [str1, p('a', 600), p('b', 600)], TODAY);
  assert.deepStrictEqual([o.due, o.maintCount, o.stringCount], [1, 0, 1]);
});

test('云函数：使用记录只属于本人；分钟数严格校验；编辑不能换类型；旧版小程序编辑球拍不清掉时长提醒；删除球拍 / 清除全部一起删', async () => {
  const env = setup();
  const a = ok(await env.call('alice', 'racketSave', { racket: racket({ hours: 20 }) })).id;
  const b = ok(await env.call('bob', 'racketSave', { racket: racket() })).id;
  assert.strictEqual(env.coll('rackets')[a].hours, 20);
  assert.strictEqual(env.coll('rackets')[b].hours, undefined, '没带字段就不写');
  const pid = ok(await env.call('alice', 'racketLogSave', { racketId: a, log: play({ note: 'x', owner: 'bob' }) })).id;
  const doc = env.coll('racket_logs')[pid];
  assert.deepStrictEqual([doc.owner, doc.racketId, doc.kind, doc.minutes, doc.note, doc._openid], ['alice', a, 'play', 90, undefined, undefined]);
  for (const m of ['90', 0, 601, 1.5, null]) no(await env.call('alice', 'racketLogSave', { racketId: a, log: play({ minutes: m }) }), /分钟/);
  // 别人：看不到、改不了、删不掉、不能挂到 alice 的球拍上
  const before = JSON.stringify(env.store);
  no(await env.call('bob', 'racketLogSave', { racketId: a, log: play() }), /不存在/);
  no(await env.call('bob', 'racketLogSave', { id: pid, racketId: b, log: play({ minutes: 5 }) }), /不存在/);
  no(await env.call('bob', 'racketLogRemove', { id: pid }), /不存在/);
  assert.strictEqual(JSON.stringify(env.store), before);
  const bl = ok(await env.call('bob', 'racketList'));
  assert.ok(!bl.logs.some((l) => l.id === pid));
  no(await env.call('bob', 'data', { op: 'get', coll: 'racket_logs', where: { kind: 'play' } }));
  no(await env.call('stranger', 'racketLogSave', { racketId: a, log: play() }), /请先验证/);
  // 本人：列表带 minutes / hours；编辑只改日期和分钟，不能换球拍、不能改成穿线
  const al = ok(await env.call('alice', 'racketList'));
  assert.deepStrictEqual([al.rackets[0].hours, al.logs[0].minutes, al.logs[0].kind], [20, 90, 'play']);
  ok(await env.call('alice', 'racketLogSave', { id: pid, racketId: b, log: play({ date: '2026-11-12', minutes: 75 }) }));
  assert.deepStrictEqual([env.coll('racket_logs')[pid].racketId, env.coll('racket_logs')[pid].date, env.coll('racket_logs')[pid].minutes], [a, '2026-11-12', 75]);
  no(await env.call('alice', 'racketLogSave', { id: pid, log: str() }), /类型/);
  const sid = ok(await env.call('alice', 'racketLogSave', { racketId: a, log: str() })).id;
  no(await env.call('alice', 'racketLogSave', { id: sid, log: play() }), /类型/);
  // 旧版小程序编辑球拍（不带 hours）：保留；新版带 0：关闭
  ok(await env.call('alice', 'racketSave', { id: a, racket: racket({ status: 'spare' }) }));
  assert.deepStrictEqual([env.coll('rackets')[a].hours, env.coll('rackets')[a].status], [20, 'spare']);
  ok(await env.call('alice', 'racketSave', { id: a, racket: racket({ hours: 0 }) }));
  assert.strictEqual(env.coll('rackets')[a].hours, 0);
  no(await env.call('alice', 'racketSave', { id: a, racket: racket({ hours: 33 }) }), /时长/);
  // 删除：逐条、删除球拍、清除全部
  const p2 = ok(await env.call('alice', 'racketLogSave', { racketId: a, log: play() })).id;
  ok(await env.call('alice', 'racketLogRemove', { id: p2 }));
  assert.ok(!env.coll('racket_logs')[p2]);
  const a2 = ok(await env.call('alice', 'racketSave', { racket: racket() })).id;
  const p3 = ok(await env.call('alice', 'racketLogSave', { racketId: a2, log: play() })).id;
  ok(await env.call('alice', 'racketRemove', { id: a }));
  assert.ok(!env.coll('racket_logs')[pid] && env.coll('racket_logs')[p3], '删除球拍只删它自己的使用记录');
  const bp = ok(await env.call('bob', 'racketLogSave', { racketId: b, log: play() })).id;
  ok(await env.call('alice', 'racketClear', { confirm: true }));
  assert.ok(!env.coll('racket_logs')[p3]);
  assert.ok(env.coll('racket_logs')[bp], '别人的不受影响');
});

test('页面：球拍详情可以记 / 改 / 删使用记录（只经 utils/rackets.js），编辑页有时长提醒且默认关闭', () => {
  const fs = require('fs'), path = require('path'), root = path.resolve(__dirname, '..');
  const vjs = fs.readFileSync(path.join(root, 'pkg-tools/racket-view/racket-view.js'), 'utf8');
  const vxml = fs.readFileSync(path.join(root, 'pkg-tools/racket-view/racket-view.wxml'), 'utf8');
  for (const fn of ['playAdd', 'playOpen', 'playSave', 'playRemove']) assert.ok(new RegExp(`bindtap="${fn}"`).test(vxml), fn);
  assert.ok(/API\.saveLog\(/.test(vjs) && /API\.removeLog\(/.test(vjs) && /kind: 'play'/.test(vjs));
  assert.ok(/<input\b[^>]*type="number"[^>]*bindinput="playMinutes"/.test(vxml), '分钟数只能填数字');
  const ejs = fs.readFileSync(path.join(root, 'pkg-tools/racket-edit/racket-edit.js'), 'utf8');
  assert.ok(/hours: 0 \}\); return;/.test(ejs), '新球拍默认关闭');
  assert.ok(/hours: K\.REMIND_HOURS\[d\.hi\]/.test(ejs), '保存时总是带上 hours（0 = 关闭）');
  assert.strictEqual(K.REMIND_HOURS[0], 0);
});

test('底部 tab：「球拍」和「我的」的下标与红点 / 数字设置一致，最多 5 个', () => {
  const fs = require('fs'), path = require('path'), root = path.resolve(__dirname, '..');
  const tabs = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).tabBar.list.map((t) => t.pagePath);
  assert.ok(tabs.length <= 5);
  const src = fs.readFileSync(path.join(root, 'utils/rackets.js'), 'utf8');
  assert.strictEqual(tabs[Number(/const RACKET_TAB = (\d+)/.exec(src)[1])], 'pages/racket/racket');
  const mem = fs.readFileSync(path.join(root, 'utils/member.js'), 'utf8');
  assert.strictEqual(tabs[Number(/const ME_TAB = (\d+)/.exec(mem)[1])], 'pages/me/me');
  for (const t of tabs) {
    const icon = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8')).tabBar.list.find((x) => x.pagePath === t);
    assert.ok(fs.existsSync(path.join(root, icon.iconPath)) && fs.existsSync(path.join(root, icon.selectedIconPath)), t);
  }
});

/* ---------- 列表页先显示、后更正：本机存一份上次的球拍列表 ---------- */
function rackKit(opts) {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const { createRequire } = require('module');
  const o = opts || {};
  const store = Object.assign({}, o.store || {});
  const sets = [];
  const toasts = [];
  const wx = {
    getStorageSync: (k) => (k in store ? store[k] : ''),
    setStorageSync: (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
    setStorage: (x) => { sets.push(x.key); store[x.key] = JSON.parse(JSON.stringify(x.data)); if (x.success) x.success(); },
    removeStorageSync: (k) => { delete store[k]; },
    showToast: (t) => toasts.push(t.title), hideShareMenu() {}, setTabBarBadge() {}, removeTabBarBadge() {}, setNavigationBarTitle() {},
  };
  const state = { epoch: 0, peek: undefined, reply: null, fail: null, onCall: null };
  const cloud = {
    cached: async () => { if (state.onCall) state.onCall(); if (state.fail) throw state.fail; return JSON.parse(JSON.stringify(state.reply)); },
    peek: () => state.peek, call: async () => ({ ok: true }),
  };
  const memo = { epoch: () => state.epoch, invalidate() { state.epoch++; } };
  const ROOT = path.resolve(__dirname, '..');
  const load = (file, deps) => {
    const filename = path.join(ROOT, file);
    const mod = { exports: {} };
    let def;
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      require: (id) => (deps[id] !== undefined ? deps[id] : createRequire(filename)(id)), module: mod, exports: mod.exports,
      wx, console, setTimeout: () => 0, clearTimeout() {}, Page: (d) => { def = d; }, getCurrentPages: () => [],
    });
    return def || mod.exports;
  };
  const API = load('utils/rackets.js', { './cloud': cloud, './memo': memo });
  const page = (file) => {
    const def = load(file || 'pages/racket/racket.js', { '../../utils/rackets': API, '../../utils/memo': memo });
    return Object.assign({}, def, { data: JSON.parse(JSON.stringify(def.data)), setData(x) { (this.sets = this.sets || []).push(x); Object.assign(this.data, x); } });
  };
  return { API, store, sets, toasts, state, page };
}
const R1 = { id: 'r1', no: 1, brand: 'wilson', model: 'Blade', status: 'active', remind: {} };
const R2 = { id: 'r2', no: 2, brand: 'wilson', model: 'Blade', status: 'active', remind: {} };
const tickR = () => new Promise((r) => setImmediate(r));
const plainR = (x) => JSON.parse(JSON.stringify(x));

test('球拍列表本机缓存：读到云端结果后存 { uid, rackets, logs }，只认同一账号；内容没变不重复写；读的期间有过作废不写；清除全部时删掉；退出成员身份时清掉', async () => {
  const k = rackKit({ store: { my_openid: 'alice' } });
  k.state.reply = { rackets: [R1], logs: [] };
  assert.strictEqual(k.API.cachedList(), null, '没读过：没有可先显示的');
  await k.API.load();
  assert.deepStrictEqual(plainR(k.store[k.API.KEY]), { uid: 'alice', rackets: [R1], logs: [] });
  await k.API.load();
  assert.strictEqual(k.sets.filter((x) => x === k.API.KEY).length, 1, '内容没变不再写');
  assert.deepStrictEqual(plainR(k.API.cachedList()), { rackets: [R1], logs: [] });
  // 60 秒内刚读过的内存结果更新：先用它
  k.state.peek = { rackets: [R1, R2], logs: [] };
  assert.strictEqual(k.API.cachedList().rackets.length, 2);
  k.state.peek = undefined;
  // 换了账号：不用别人的
  k.store.my_openid = 'bob';
  assert.strictEqual(k.API.cachedList(), null);
  k.store.my_openid = 'alice';
  // 读的期间有过作废（写操作 / 清除受保护缓存）：结果照常返回，但不写进本机
  k.state.reply = { rackets: [R1, R2], logs: [] };
  k.state.onCall = () => { k.state.epoch++; };
  assert.strictEqual((await k.API.load()).rackets.length, 2);
  assert.strictEqual(k.store[k.API.KEY].rackets.length, 1);
  k.state.onCall = null;
  // 不知道是谁（没有 my_openid）：不写
  const k2 = rackKit();
  k2.state.reply = { rackets: [R1], logs: [] };
  await k2.API.load();
  assert.ok(!(k2.API.KEY in k2.store));
  // 清除全部：本机那份马上删
  await k.API.clear();
  assert.ok(!(k.API.KEY in k.store));
  assert.strictEqual(k.API.cachedList(), null);
  // 退出成员身份（clearProtected）会清掉：不在保留名单里
  const member = require('fs').readFileSync(require('path').join(__dirname, '../utils/member.js'), 'utf8');
  assert.ok(!new RegExp(k.API.KEY).test(member.match(/const KEEP = \{[^}]*\}/)[0]));
});

test('球拍列表页：有上次的记录就直接画出来（不显示「正在读取…」），云端读完再更正；读取失败时保留上次的记录只轻提示，没有记录才整页显示读取失败', async () => {
  const k = rackKit({ store: { my_openid: 'alice' } });
  k.store[k.API.KEY] = { uid: 'alice', rackets: [R1], logs: [] };
  k.state.reply = { rackets: [R1, R2], logs: [] };
  const p = k.page();
  p.onLoad();
  assert.deepStrictEqual([p.data.loading, p.data.cards.length], [false, 1], '第一帧就有上次的球拍');
  // 顶部卡片静止（用户觉得动画太多）：数字直接是实际值，不滑入、配图不动
  assert.strictEqual(p.sets[0].o.inUse, 1); assert.ok(!('o.inUse' in p.sets[0]), '数字不滚');
  const rxml = require('fs').readFileSync(require('path').join(__dirname, '../pages/racket/racket.wxml'), 'utf8');
  assert.match(rxml, /<view class="hero">/);
  assert.ok(!/art-in|art-box/.test(rxml));
  p.onShow();
  await tickR();
  assert.deepStrictEqual([p.data.loading, p.data.error, p.data.cards.length], [false, '', 2], '云端读完更正');
  assert.strictEqual(k.store[k.API.KEY].rackets.length, 2);
  // 读取失败：保留着
  const q = k.page();
  q.onLoad();
  k.state.fail = new Error('网络异常');
  q.onShow();
  await tickR();
  assert.deepStrictEqual([q.data.error, q.data.cards.length], ['', 2]);
  assert.deepStrictEqual(k.toasts, ['网络异常，显示的是上次的记录']);
  // 没有可先显示的：先空着等云端，失败整页提示
  const k3 = rackKit({ store: { my_openid: 'alice' } });
  k3.state.fail = new Error('网络异常');
  const r = k3.page();
  r.onLoad();
  assert.strictEqual(r.data.loading, true);
  r.onShow();
  await tickR();
  assert.deepStrictEqual([r.data.loading, r.data.error], [false, '网络异常']);
});

test('球拍详情：本机记着的球拍列表里有这支拍就直接画出来，云端读完再更正；读取失败保留上次的只轻提示；本机没有这支拍照旧等云端', async () => {
  const k = rackKit({ store: { my_openid: 'alice' } });
  const L1 = { id: 'l1', racketId: 'r1', kind: 'maint', date: '2026-11-01', item: 'overgrip', cost: 15 };
  const L2 = { id: 'l2', racketId: 'r1', kind: 'maint', date: '2026-11-10', item: 'overgrip', cost: 15 };
  k.store[k.API.KEY] = { uid: 'alice', rackets: [R1, R2], logs: [L1] };
  k.state.reply = { rackets: [R1, R2], logs: [L1, L2] };
  const p = k.page('pkg-tools/racket-view/racket-view.js');
  p.onLoad({ id: 'r1' });
  assert.deepStrictEqual([p.data.loading, p.data.r && p.data.r.no, p.data.shown.length], [false, 1, 1], '第一帧就有这支拍和上次的记录');
  p.onShow();
  await tickR();
  assert.strictEqual(p.data.shown.length, 2, '云端读完更正');
  k.state.fail = new Error('网络异常');
  const q = k.page('pkg-tools/racket-view/racket-view.js');
  q.onLoad({ id: 'r1' });
  q.onShow();
  await tickR();
  assert.deepStrictEqual([q.data.error, q.data.loading], ['', false]);
  assert.deepStrictEqual(k.toasts, ['网络异常，显示的是上次的记录']);
  // 本机没有这支拍（别的手机上刚加的）：先空着等云端，失败整页提示
  const r = k.page('pkg-tools/racket-view/racket-view.js');
  r.onLoad({ id: 'r9' });
  assert.strictEqual(r.data.loading, true);
  r.onShow();
  await tickR();
  assert.deepStrictEqual([r.data.loading, r.data.error], [false, '网络异常']);
});

test('球拍页顶部卡片：一支球拍都没有时不显示底部那行（和下面「还没有球拍」重复）；有球拍才显示上次穿线 / 到期提醒', () => {
  const fs = require('fs'), path = require('path');
  const xml = fs.readFileSync(path.join(__dirname, '..', 'pages/racket/racket.wxml'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'pages/racket/racket.wxss'), 'utf8');
  assert.ok(/<view wx:if="\{\{cards\.length\}\}" class="hero-foot">/.test(xml));
  assert.ok(/还没有球拍/.test(xml));
  assert.ok(!/clearAll|清除全部球拍|danger-zone/.test(xml + css), '球拍列表页不放清除全部按钮，在每支球拍详情里按拍删除');
  assert.ok(/class="rk-n num"/.test(xml), '穿线和维护次数用记分牌窄体数字');
  assert.ok(!/class="card rk [^"]*"[^>]*hover-class="tap-on"/.test(xml), '球拍卡片点击直接进详情，不做缩放抖动');
  assert.ok(/\.page::before \{[^}]*#A3A3CB 0%/.test(css) && /rgba\(56, 54, 108, 0\.16\)/.test(css), '顶部柔紫幕与烟熏冷紫毛玻璃底条');
  assert.ok(/\.ball-add\.bouncing \.ball-btn \{[^}]*ani-ball-jump/.test(css) && /\.ball-add\.bouncing \.ball-sh \{[^}]*ani-ball-shadow/.test(css) && /\.ball-add\.bouncing \.ball-rk \{[^}]*ani-rk-juggle/.test(css), '拍面颠球按钮原地弹跳且球影、球拍同步颠球');
  assert.ok(/class="card eq-card"/.test(xml) && /装备统计/.test(xml), '球拍列表页展示装备年度花费与换线统计卡');
});

test('装备年度花费与换线 / 断线周期统计（K.yearlyStats）：拆解穿线与维护花费、计算相邻穿线平均天数与时长、统计断线与常用球线', () => {
  const rs = [
    { id: 'r1', no: 1, brand: 'wilson', model: 'Clash', status: 'active' },
    { id: 'r2', no: 2, brand: 'yonex', model: 'Percept', status: 'active' },
  ];
  const logs = [
    { id: 'l0', racketId: 'r1', kind: 'string', date: '2025-12-20', main: { brand: 'luxilon', model: 'ALU Power' }, mains: 50, crosses: 50, cost: 150, tags: [] },
    { id: 'l1', racketId: 'r1', kind: 'string', date: '2026-01-10', main: { brand: 'luxilon', model: 'ALU Power' }, mains: 50, crosses: 50, cost: 160, tags: ['断线了'] },
    { id: 'l2', racketId: 'r1', kind: 'play', date: '2026-01-10', minutes: 120 }, // 穿线当天算新线
    { id: 'l3', racketId: 'r1', kind: 'play', date: '2026-01-20', minutes: 180 },
    { id: 'l4', racketId: 'r1', kind: 'string', date: '2026-02-10', main: { brand: 'yonex', model: 'Poly Tour Pro' }, mains: 48, crosses: 48, cost: 120, tags: ['断线了'] },
    { id: 'l5', racketId: 'r2', kind: 'maint', date: '2026-03-01', item: 'overgrip', cost: 25 },
    { id: 'l6', racketId: 'r2', kind: 'play', date: '2026-03-02', minutes: 90 },
  ];
  const st = K.yearlyStats(rs, logs, '2026-11-25');
  assert.strictEqual(st.year, '2026');
  assert.deepStrictEqual([st.stringCost, st.maintCost, st.yearCost, st.allCost], [280, 25, 305, 455]);
  assert.deepStrictEqual([st.yearStrings, st.yearMaints, st.yearPlayMin, st.yearPlayHours], [2, 1, 390, '6.5']);
  assert.deepStrictEqual([st.brokenYear, st.brokenAll], [2, 2]);
  // r1 两次相邻间隔：2025-12-20 → 2026-01-10 (21 天)、2026-01-10 → 2026-02-10 (31 天) → 平均 26 天；期间时长只有第二段有 300 分钟 = 5h
  assert.deepStrictEqual([st.avgDays, st.avgHours], [26, '5']);
  assert.deepStrictEqual(st.topString, { name: 'Luxilon ALU Power', count: 2 });
  assert.strictEqual(st.hasData, true);
  // 空记录
  const empty = K.yearlyStats(rs, [], '2026-11-25');
  assert.deepStrictEqual([empty.yearCost, empty.avgDays, empty.avgHours, empty.topString, empty.hasData], [0, null, '', null, false]);
});

test('添加球拍网球按钮：点击先弹跳 320ms 再跳页，防连点；中途切走页面取消跳转', async () => {
  const fs = require('fs'), path = require('path'), vm = require('vm');
  const { createRequire } = require('module');
  const clock = require('./fake-clock')();
  await clock.run(async () => {
    const nav = [];
    const file = path.join(__dirname, '..', 'pages/racket/racket.js');
    let def;
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
      require: (id) => (id === '../../utils/rackets' ? { cachedList: () => null } : createRequire(file)(id)),
      wx: { navigateTo: (o) => nav.push(o.url), hideShareMenu() {} },
      Page: (d) => { def = d; }, setTimeout, clearTimeout, console,
    });
    const p = Object.assign({}, def, { data: JSON.parse(JSON.stringify(def.data)), setData(o) { Object.assign(this.data, o); } });
    p.add(); p.add(); // 连点只算一次
    assert.strictEqual(p.data.bouncing, true);
    assert.strictEqual(nav.length, 0, '弹跳期间还没跳页');
    await clock.wait(330);
    assert.strictEqual(p.data.bouncing, false);
    assert.deepStrictEqual(nav, ['/pkg-tools/racket-edit/racket-edit']);
    // 中途切走页面：取消定时器、不误跳页
    p.add();
    p.onHide();
    assert.strictEqual(p.data.bouncing, false);
    await clock.wait(360);
    assert.strictEqual(nav.length, 1);
  });
});

module.exports = T;
