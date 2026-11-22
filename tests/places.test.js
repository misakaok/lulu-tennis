// 创建球友活动「最近使用的地点」：从已有活动取、去重、点选填回表单，以及创建后详情页导航到正确地点
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const createEnv = require('./mock-cloud');
const PL = require('../utils/places');
const E = require('../utils/event');
const T = [];
const test = (name, fn) => T.push({ name, fn });
const plain = (v) => JSON.parse(JSON.stringify(v));

function load(file, wx, kind, deps) {
  const filename = path.resolve(__dirname, '..', file);
  let def;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (id) => (deps && deps[id]) || createRequire(filename)(id), wx, [kind]: (d) => { def = d; }, setTimeout, clearTimeout, console,
  });
  return Object.assign({}, kind === 'Component' ? def.methods : def, {
    data: plain(def.data),
    setData(p) {
      Object.entries(p).forEach(([key, value]) => {
        const parts = key.split('.');
        let target = this.data;
        parts.slice(0, -1).forEach((part) => { target = target[part]; });
        target[parts[parts.length - 1]] = value;
      });
    },
  });
}

const A = { latitude: 31.2, longitude: 121.5 }, B = { latitude: 30.1, longitude: 120.2 };
const at = (n) => new Date(Date.UTC(2026, 10, n)).toISOString();
const draws = () => [
  { _id: 'old', date: '2026-10-01', createdAt: at(1), location: { latitude: 29, longitude: 119 }, place: null, venue: '9 号场' }, // 只有坐标的旧活动
  { _id: 'a2', date: '2026-11-20', createdAt: at(20), location: Object.assign({}, A), place: { name: '某某网球中心', address: '某区某路 1 号' }, venue: '3 号场' },
  { _id: 'b1', date: '2026-11-18', createdAt: at(18), location: Object.assign({}, B), place: { name: '', address: '某区某街 8 号' } },
  { _id: 'a1', date: '2026-11-10', createdAt: at(10), location: Object.assign({}, A), place: { name: '某某网球中心', address: '某区某路 1 号' } }, // 同一坐标
  { _id: 'del', date: '2026-11-21', createdAt: at(21), deleted: true, location: { latitude: 28, longitude: 118 }, place: { name: '删掉的活动' } },
  { _id: 'bad', date: '2026-11-22', createdAt: at(22), location: { latitude: 91, longitude: 121 }, place: { name: '坐标不对' } },
  { _id: 'none', date: '2026-11-22', createdAt: at(22), location: null },
];

test('最近使用的地点：按创建时间从新到旧，同一坐标只出现一次；删除的、没有有效坐标的不算；只有坐标的旧活动显示「历史地图位置」+ 日期', () => {
  const src = draws();
  const before = JSON.stringify(src);
  const r = PL.recentPlaces(src);
  assert.strictEqual(JSON.stringify(src), before, '不修改共享的活动列表');
  assert.deepStrictEqual(r.map((x) => x.name), ['某某网球中心', '某区某街 8 号', '历史地图位置']);
  assert.deepStrictEqual(plain(r[0].location), A); assert.deepStrictEqual(plain(r[0].place), { name: '某某网球中心', address: '某区某路 1 号' });
  assert.strictEqual(r[0].sub, '某区某路 1 号'); assert.strictEqual(r[0].date, '2026-11-20');
  assert.strictEqual(r[1].sub, ''); // 只有地址：地址当名称显示，不重复
  assert.strictEqual(r[2].place, null); assert.strictEqual(r[2].sub, E.dayText('2026-10-01') + '的活动');
  assert.ok(r.every((x) => !('venue' in x)), '不带历史活动的场号');
  // 最多 5 个
  const many = Array.from({ length: 8 }, (_, i) => ({ _id: 'm' + i, createdAt: at(i + 1), location: { latitude: 20 + i, longitude: 110 }, place: { name: '地点' + i } }));
  assert.deepStrictEqual(PL.recentPlaces(many).map((x) => x.name), ['地点7', '地点6', '地点5', '地点4', '地点3']);
  // 同一坐标最新一次没有地点名称（例如没通过检测只存了坐标）：用以前检测通过的名称
  const mixed = [{ _id: 'n', createdAt: at(5), location: A, place: null, date: '2026-11-05' }, { _id: 'o', createdAt: at(1), location: A, place: { name: '老名字', address: '' } }];
  const m = PL.recentPlaces(mixed);
  assert.strictEqual(m.length, 1); assert.strictEqual(m[0].name, '老名字'); assert.strictEqual(m[0].date, '2026-11-05');
  // 本机缓存里的创建时间是字符串、云端是日期对象，都能排
  const d1 = Object.assign(draws()[1], { createdAt: new Date(at(20)) });
  assert.strictEqual(PL.recentPlaces([draws()[2], d1])[0].name, '某某网球中心');
  assert.deepStrictEqual(PL.recentPlaces([]), []); assert.deepStrictEqual(PL.recentPlaces(null), []);
});

test('表单：点选历史地点直接填回 location 和 place，不打开地图、不带入场号；只存坐标的旧地点也能选；选完可以换地图位置或清除', () => {
  let opened = 0;
  const wx = { chooseLocation({ success }) { opened++; success({ latitude: 32, longitude: 122, name: '地图上新选的', address: '新地址' }); } };
  const c = load('components/event-form/event-form.js', wx, 'Component');
  let value;
  c.triggerEvent = (_, v) => { value = plain(v); };
  c.data.recent = PL.recentPlaces(draws());
  c.init({});
  c.onCourt({ detail: { value: '5' } }); // 场号单独选
  const tap = (i) => c.pickRecent({ currentTarget: { dataset: { i: String(i) } } });
  tap(0);
  assert.strictEqual(opened, 0, '不打开地图');
  assert.deepStrictEqual(value.location, A);
  assert.deepStrictEqual(value.place, { name: '某某网球中心', address: '某区某路 1 号' });
  assert.strictEqual(value.venue, '5 号场', '不带入历史活动的 3 号场');
  assert.strictEqual(c.data.locText, '某某网球中心'); assert.strictEqual(c.data.locKey, c.data.recent[0].key);
  tap(2); // 只有坐标的旧地点
  assert.deepStrictEqual(value.location, { latitude: 29, longitude: 119 }); assert.strictEqual(value.place, null);
  assert.strictEqual(c.data.locText, '已选择地图位置'); assert.strictEqual(value.venue, '5 号场');
  c.pickLocation(); // 换地图位置
  assert.strictEqual(opened, 1);
  assert.deepStrictEqual(value.location, { latitude: 32, longitude: 122 }); assert.deepStrictEqual(value.place, { name: '地图上新选的', address: '新地址' });
  assert.strictEqual(c.data.locKey, PL.keyOf({ latitude: 32, longitude: 122 }));
  tap(1);
  c.clearLocation();
  assert.strictEqual(value.location, null); assert.strictEqual(value.place, null); assert.strictEqual(c.data.locKey, ''); assert.strictEqual(value.venue, '5 号场');
  tap(9); // 不存在的一行：不变
  assert.strictEqual(value.location, null);

  const xml = fs.readFileSync(path.join(__dirname, '../components/event-form/event-form.wxml'), 'utf8');
  assert.ok(/最近使用的地点/.test(xml) && /bindtap="pickRecent"/.test(xml) && /bindtap="pickLocation"/.test(xml) && /bindtap="clearLocation"/.test(xml));
  assert.ok(/<event-form recent="\{\{recentPlaces\}\}" bind:change="onInfo" \/>/.test(fs.readFileSync(path.join(__dirname, '../pages/draw-new/draw-new.wxml'), 'utf8')));
  // 编辑页不传历史地点：不显示这一块
  assert.ok(!/recent=/.test(fs.readFileSync(path.join(__dirname, '../pages/event-edit/event-edit.wxml'), 'utf8')));
});

test('新建活动页：先用本机缓存的活动显示历史地点，再换成最新的活动列表；读取失败保留缓存的', async () => {
  let fresh = draws().slice(0, 2);
  const p = load('pages/draw-new/draw-new.js', {}, 'Page', {
    '../../utils/db': { cachedDraws: () => draws().slice(2, 4), drawsShared: async () => { if (!fresh) throw new Error('offline'); return fresh; } },
  });
  const pending = p.loadRecentPlaces();
  assert.deepStrictEqual(p.data.recentPlaces.map((x) => x.name), ['某区某街 8 号', '某某网球中心']);
  await pending;
  assert.deepStrictEqual(p.data.recentPlaces.map((x) => x.name), ['某某网球中心', '历史地图位置']);
  fresh = null;
  await p.loadRecentPlaces();
  assert.deepStrictEqual(p.data.recentPlaces.map((x) => x.name), ['某区某街 8 号', '某某网球中心']);
});

test('选历史地点创建活动：走 createDraw 和地点文字检测，活动详情导航到这个地点', async () => {
  const env = createEnv();
  env.load();
  env.members([['owner', 'Owner'], ['alice', 'Alice']]);
  // 表单 → 新建活动页的提交字段
  const c = load('components/event-form/event-form.js', {}, 'Component');
  const page = load('pages/draw-new/draw-new.js', {}, 'Page', { '../../utils/db': {} });
  c.triggerEvent = (_, v) => page.onInfo({ detail: plain(v) });
  c.data.recent = PL.recentPlaces(draws());
  c.init({ date: '2026-11-29' });
  c.pickRecent({ currentTarget: { dataset: { i: '0' } } });
  const fields = page.infoFields();
  assert.deepStrictEqual(plain(fields.location), A); assert.deepStrictEqual(plain(fields.place), { name: '某某网球中心', address: '某区某路 1 号' });
  assert.strictEqual(fields.venue, '');

  const old = process.env.ADMIN_OPENIDS;
  process.env.ADMIN_OPENIDS = 'owner';
  let r;
  try { r = await env.call('owner', 'createDraw', { draw: Object.assign({ mode: 'bracket', size: 8, title: '内部赛' }, plain(fields)) }); }
  finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
  assert.ok(r.ok, JSON.stringify(r)); assert.strictEqual(r.placeDropped, false);
  assert.ok(env.textChecks.some((x) => x.content === '某某网球中心 某区某路 1 号'), '地点文字照样检测');
  const detail = await env.call('alice', 'drawDetail', { drawId: r.id });
  assert.ok(detail.ok);

  let nav = null;
  const v = load('pages/draw-view/draw-view.js', { setNavigationBarTitle() {}, openLocation(o) { nav = o; } }, 'Page', {
    '../../utils/db': { fetchDrawDetail: async () => ({ draw: E.publicDraw(detail.draw), profile: null, signups: [] }), fetchMatches: async () => [], myOpenid: async () => 'alice' },
    '../../utils/member': { isAdminLocal: () => false },
  });
  v.id = r.id; v.loadSignups = async () => {};
  await v.load();
  assert.strictEqual(v.data.error, '');
  v.openMap();
  assert.deepStrictEqual(plain(nav), { latitude: 31.2, longitude: 121.5, name: '某某网球中心', address: '某区某路 1 号', scale: 16 });

  // 只有坐标的旧地点：同样能创建、能导航（名称按场地编号或「活动场地」）
  c.pickRecent({ currentTarget: { dataset: { i: '2' } } });
  c.onCourt({ detail: { value: '7' } });
  process.env.ADMIN_OPENIDS = 'owner';
  let r2;
  try { r2 = await env.call('owner', 'createDraw', { draw: Object.assign({ mode: 'bracket', size: 8, title: '内部赛' }, plain(page.infoFields())) }); }
  finally { if (old === undefined) delete process.env.ADMIN_OPENIDS; else process.env.ADMIN_OPENIDS = old; }
  assert.ok(r2.ok);
  const d2 = env.coll('draws')[r2.id];
  assert.deepStrictEqual(d2.location, { latitude: 29, longitude: 119 }); assert.strictEqual(d2.place, null); assert.strictEqual(d2.venue, '7 号场');
});

test('最近使用的地点：100 米以内算同一个地点只出现一次（位置用最新的、名称用检测通过的）；只有坐标的「历史地图位置」最多 1 条', () => {
  const near = (l, dLat) => ({ latitude: l.latitude + dLat, longitude: l.longitude }); // 纬度 0.0001° ≈ 11 米
  assert.ok(Math.abs(PL.distance(A, near(A, 0.0009)) - 100) < 2, '距离算得对（约 100 米）');
  const r = PL.recentPlaces([
    { _id: 'n3', date: '2026-11-03', createdAt: at(13), location: near(A, 0.0002), place: null }, // 最新：在某某网球中心旁边 22 米，没名称
    { _id: 'n2', date: '2026-11-02', createdAt: at(12), location: near(A, 0.0001), place: { name: '某某网球中心', address: '某区某路 1 号' } },
    { _id: 'o1', date: '2026-10-05', createdAt: at(9), location: { latitude: 29, longitude: 119 }, place: null }, // 只有坐标
    { _id: 'o2', date: '2026-10-04', createdAt: at(8), location: { latitude: 28, longitude: 118 }, place: null }, // 只有坐标，不再显示
    { _id: 'o3', date: '2026-10-03', createdAt: at(7), location: { latitude: 29.0001, longitude: 119 }, place: null }, // 和 o1 同一处
    { _id: 'f1', date: '2026-10-02', createdAt: at(6), location: near(A, 0.002), place: { name: '隔壁球场', address: '' } }, // 约 220 米：算另一个地点
    { _id: 'b1', date: '2026-10-01', createdAt: at(5), location: Object.assign({}, B), place: { name: '', address: '某区某街 8 号' } },
  ]);
  assert.deepStrictEqual(r.map((x) => x.name), ['某某网球中心', '历史地图位置', '隔壁球场', '某区某街 8 号']);
  assert.deepStrictEqual(plain(r[0].location), plain(near(A, 0.0002)), '位置用最新那次的');
  assert.strictEqual(r[0].date, '2026-11-03'); assert.strictEqual(r[0].key, PL.keyOf(near(A, 0.0002)));
  assert.strictEqual(r[1].sub, E.dayText('2026-10-05') + '的活动');
  assert.strictEqual(r.filter((x) => !x.place).length, 1);
  // 全是只有坐标的旧活动：也只出现 1 条（最近的）
  const bare = [1, 2, 3].map((i) => ({ _id: 'x' + i, date: '2026-09-0' + i, createdAt: at(i), location: { latitude: 20 + i, longitude: 110 }, place: null }));
  const rb = PL.recentPlaces(bare);
  assert.strictEqual(rb.length, 1); assert.strictEqual(rb[0].date, '2026-09-03');
  // 有名称的地点照样最多 5 个；只有坐标的那条排在它该在的位置，占一个名额
  const mix = Array.from({ length: 6 }, (_, i) => ({ _id: 'p' + i, createdAt: at(i + 10), location: { latitude: 10 + i, longitude: 100 }, place: { name: '地点' + i } }))
    .concat([{ _id: 'q', date: '2026-11-30', createdAt: at(30), location: { latitude: 40, longitude: 100 }, place: null }]);
  assert.deepStrictEqual(PL.recentPlaces(mix).map((x) => x.name), ['历史地图位置', '地点5', '地点4', '地点3', '地点2']);
});

test('只有坐标的历史位置：提示可以在地图上补名称；地图打开时停在这个位置，点选后名称就显示出来并随表单提交', () => {
  const calls = [];
  const wx = { chooseLocation(o) { calls.push({ latitude: o.latitude, longitude: o.longitude }); o.success({ latitude: 29.00002, longitude: 119.00001, name: '老地方网球场', address: '某区某路 9 号' }); } };
  const c = load('components/event-form/event-form.js', wx, 'Component');
  let value;
  c.triggerEvent = (_, v) => { value = plain(v); };
  c.data.recent = PL.recentPlaces(draws());
  c.init({});
  c.pickLocation(); // 还没选位置：地图按默认（当前位置）打开
  assert.deepStrictEqual(calls.pop(), { latitude: undefined, longitude: undefined });
  c.pickRecent({ currentTarget: { dataset: { i: '2' } } }); // 历史地图位置（只有坐标）
  assert.strictEqual(value.place, null); assert.strictEqual(c.data.locText, '已选择地图位置');
  c.pickLocation();
  assert.deepStrictEqual(calls.pop(), { latitude: 29, longitude: 119 }, '地图停在已选的位置');
  assert.deepStrictEqual(value.place, { name: '老地方网球场', address: '某区某路 9 号' });
  assert.strictEqual(c.data.locText, '老地方网球场');
  const xml = fs.readFileSync(path.join(__dirname, '../components/event-form/event-form.wxml'), 'utf8');
  assert.ok(/wx:if="\{\{v\.location && !v\.place\}\}"[^>]*>这个位置以前只存了坐标，没有名称/.test(xml));
});

module.exports = T;
