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
  no(await env.call('stranger', 'racketList'), /内部球友/);
  no(await env.call('stranger', 'racketSave', { racket: racket() }), /内部球友/);
});

test('页面：我的球拍各页不能分享，没有文字输入框（费用只能填数字），只经 utils/rackets.js 读写', () => {
  const fs = require('fs'), path = require('path'), root = path.resolve(__dirname, '..');
  for (const p of ['pages/racket/racket', 'pages/racket-view/racket-view', 'pages/racket-edit/racket-edit', 'pages/racket-log/racket-log']) {
    const js = fs.readFileSync(path.join(root, p + '.js'), 'utf8');
    const xml = fs.readFileSync(path.join(root, p + '.wxml'), 'utf8');
    const cfg = JSON.parse(fs.readFileSync(path.join(root, p + '.json'), 'utf8'));
    assert.ok(!/onShareAppMessage|onShareTimeline/.test(js) && /wx\.hideShareMenu\(\)/.test(js), p);
    assert.strictEqual(cfg.enableShareAppMessage, false); assert.strictEqual(cfg.enableShareTimeline, false);
    assert.ok(!/<textarea\b/.test(xml));
    (xml.match(/<input\b[^>]*>/g) || []).forEach((tag) => assert.ok(/type="digit"/.test(tag), p + ' 只允许数字输入'));
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

module.exports = T;
