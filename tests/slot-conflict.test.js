// 「安排时间场地」冲突提示：同一天同一开打时间的同场地 / 同球员（按用户 ID）
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createRequire } = require('module');
const E = require('../utils/event');
const ID = require('../utils/ident');
const SC = require('../utils/slot-conflict');
const T = [];
const test = (name, fn) => T.push({ name, fn });
const plain = (v) => JSON.parse(JSON.stringify(v));
const rec = (drawId, drawKey, ea, eb, winner) => ({ _id: drawId + drawKey, drawId, drawKey, ea, eb, winner, sets: [{ a: 6, b: 3 }], createdAt: 1 });

// 单打分组循环：4 人一组 6 场
const single = (slots, extra) => Object.assign({
  _id: 'g1', mode: 'groups', groupCount: 1, status: 'drawn', date: '2026-11-28', startTime: '14:00', venue: '',
  entrants: ['小明', '阿杰', '小周', '小林'], groups: [{ name: 'A 组', members: [{ name: '小明' }, { name: '阿杰' }, { name: '小周' }, { name: '小林' }] }],
  uidOf: { 小明: 'ming', 阿杰: 'jie', 小周: 'zhou', 小林: 'lin' }, slots: slots || {},
}, extra);
const keyOf = (d, a, b) => E.scheduleOf(d, []).find((x) => (x.a === a && x.b === b) || (x.a === b && x.b === a)).key;
const at = (time, court, date) => ({ date: date || '', time, court: court || '' });

test('同一片场地：同一天同一开打时间、同一场地已排了另一场', () => {
  const base = single();
  const k1 = keyOf(base, '小明', '阿杰'), k2 = keyOf(base, '小周', '小林');
  const d = single({ [k1]: at('15:00', '3 号场') });
  const hits = SC.slotConflicts(d, [], d.uidOf, k2, at('15:00', '3 号场'));
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].key, k1);
  assert.deepStrictEqual(plain(hits[0].reasons), ['同一片场地（3 号场）']);
  assert.ok(/小明/.test(hits[0].a + hits[0].b) && /阿杰/.test(hits[0].a + hits[0].b));
  // 别的场地、别的时间、别的日子都不算
  assert.deepStrictEqual(SC.slotConflicts(d, [], d.uidOf, k2, at('15:00', '4 号场')), []);
  assert.deepStrictEqual(SC.slotConflicts(d, [], d.uidOf, k2, at('15:30', '3 号场')), []);
  assert.deepStrictEqual(SC.slotConflicts(d, [], d.uidOf, k2, at('15:00', '3 号场', '2026-11-29')), []);
  // 日期没单独排的沿用活动日期：明确写成活动那天也算同一天
  assert.strictEqual(SC.slotConflicts(d, [], d.uidOf, k2, at('15:00', '3 号场', '2026-11-28')).length, 1);
  // 只比较单独排过的场地：没单独排场地、只沿用活动场地（5 号场）的不算，一边排了 5 号场、另一边沿用的也不算
  const v = single({ [k1]: at('15:00') }, { venue: '5 号场' });
  assert.deepStrictEqual(SC.slotConflicts(v, [], v.uidOf, k2, at('15:00')), []);
  assert.deepStrictEqual(SC.slotConflicts(v, [], v.uidOf, k2, at('15:00', '5 号场')), []);
  const v2 = single({ [k1]: at('15:00', '5 号场') }, { venue: '5 号场' });
  assert.deepStrictEqual(SC.slotConflicts(v2, [], v2.uidOf, k2, at('15:00')), []);
  assert.strictEqual(SC.slotConflicts(v2, [], v2.uidOf, k2, at('15:00', '5 号场')).length, 1);
  // 都没有场地：不算场地冲突
  assert.deepStrictEqual(SC.slotConflicts(single({ [k1]: at('15:00') }), [], d.uidOf, k2, at('15:00')), []);
});

test('同一位球员（按用户 ID）同时被排到两场；改过昵称照样认出来，没有账号的名字不查', () => {
  const base = single();
  const k1 = keyOf(base, '小明', '阿杰'), k2 = keyOf(base, '小明', '小周');
  const d = single({ [k1]: at('15:00', '3 号场') });
  const hits = SC.slotConflicts(d, [], d.uidOf, k2, at('15:00', '5 号场'));
  assert.strictEqual(hits.length, 1);
  assert.deepStrictEqual(plain(hits[0].reasons), ['小明 同时在这两场']);
  assert.deepStrictEqual(plain(hits[0].players), ['小明']);
  // 同场地又同球员：两条原因都列出
  assert.deepStrictEqual(plain(SC.slotConflicts(d, [], d.uidOf, k2, at('15:00', '3 号场'))[0].reasons), ['同一片场地（3 号场）', '小明 同时在这两场']);
  // 按用户 ID 判断：映射里没有 ID 的名字不查
  const noId = Object.assign({}, d.uidOf); delete noId['小明'];
  assert.deepStrictEqual(SC.slotConflicts(d, [], noId, k2, at('15:00', '5 号场')), []);
});

test('双打：四位球员都查，搭档（报名时带上的，按 ID）也算', () => {
  const d = {
    _id: 'dd', mode: 'groups', groupCount: 1, type: 'double', status: 'drawn', date: '2026-11-28',
    entrants: ['小明 / 小林', '阿杰 / 小周', '大王 / 小王'],
    teams: { '小明 / 小林': ['小明', '小林'], '阿杰 / 小周': ['阿杰', '小周'], '大王 / 小王': ['大王', '小王'] },
    groups: [{ name: 'A 组', members: [{ name: '小明 / 小林' }, { name: '阿杰 / 小周' }, { name: '大王 / 小王' }] }],
    uidOf: { 小明: 'ming', 阿杰: 'jie', 大王: 'da' }, // 签表快照里没有搭档的 ID
  };
  const k1 = keyOf(d, '小明 / 小林', '阿杰 / 小周'), k2 = keyOf(d, '阿杰 / 小周', '大王 / 小王'), k3 = keyOf(d, '小明 / 小林', '大王 / 小王');
  const signups = [
    { drawId: 'dd', _openid: 'ming', name: '小明', partner: '小林', partnerId: 'lin' },
    { drawId: 'dd', _openid: 'jie', name: '阿杰', partner: '小周', partnerId: 'zhou' },
    { drawId: 'dd', _openid: 'da', name: '大王', partner: '小王', partnerId: 'wang' },
  ];
  const uidOf = ID.drawUids(d, signups);
  const withSlot = Object.assign({}, d, { slots: { [k1]: at('15:00', '1 号场') } });
  const hits = SC.slotConflicts(withSlot, [], uidOf, k2, at('15:00', '2 号场'));
  assert.strictEqual(hits.length, 1);
  assert.deepStrictEqual(plain(hits[0].players), ['阿杰', '小周']);
  assert.deepStrictEqual(plain(hits[0].reasons), ['阿杰、小周 同时在这两场']);
  // 只有搭档撞上（小林的 ID 只来自报名记录）
  const onlyPartner = Object.assign({}, uidOf); delete onlyPartner['小明'];
  assert.deepStrictEqual(plain(SC.slotConflicts(withSlot, [], onlyPartner, k3, at('15:00', '2 号场'))[0].players), ['小林']);
  // 没有报名记录时搭档没有 ID：只查得到有 ID 的小明
  assert.deepStrictEqual(plain(SC.slotConflicts(withSlot, [], ID.drawUids(d, []), k3, at('15:00', '2 号场'))[0].players), ['小明']);
});

test('不误报：时间待定、编辑原场次、已结束的场次、对阵待定的一方', () => {
  const base = single();
  const k1 = keyOf(base, '小明', '阿杰'), k2 = keyOf(base, '小明', '小周');
  // 正在编辑的这场本身（原来就排在 15:00 3 号场，再保存一次）
  const d = single({ [k1]: at('15:00', '3 号场'), [k2]: at('16:00', '3 号场') });
  assert.deepStrictEqual(SC.slotConflicts(d, [], d.uidOf, k1, at('15:00', '3 号场')), []);
  // 要保存的这场没有开打时间（只有活动开始时间 14:00）：不查
  assert.deepStrictEqual(SC.slotConflicts(single({ [k1]: at('', '3 号场') }), [], d.uidOf, k2, at('', '3 号场')), []);
  // 另一场没有开打时间：也不算，哪怕活动开始时间正好是 14:00
  assert.deepStrictEqual(SC.slotConflicts(single({ [k1]: at('', '3 号场') }), [], d.uidOf, k2, at('14:00', '3 号场')), []);
  // 另一场已经录分：不算
  assert.deepStrictEqual(SC.slotConflicts(d, [rec('g1', k2, '小明', '小周', 'a')], d.uidOf, k1, at('16:00', '3 号场')), []);
  assert.strictEqual(SC.slotConflicts(d, [], d.uidOf, k1, at('16:00', '3 号场')).length, 1);
  // 单淘汰：最后一轮一方待定，只查已确定的球员；还没打的那场的两位不算进最后一轮
  const b = {
    _id: 'b1', mode: 'bracket', size: 4, status: 'drawn', date: '2026-11-28',
    entrants: ['小明', '阿杰', '小周', '小林'], lines: [{ name: '小明' }, { name: '阿杰' }, { name: '小周' }, { name: '小林' }],
    uidOf: { 小明: 'ming', 阿杰: 'jie', 小周: 'zhou', 小林: 'lin' }, slots: { '0-1': at('16:00', '1 号场') },
  };
  const ms = [rec('b1', '0-0', '小明', '阿杰', 'a')];
  assert.deepStrictEqual(SC.slotConflicts(b, ms, b.uidOf, '1-0', at('16:00', '2 号场')), []);
  b.slots = { '1-0': at('16:00', '1 号场') };
  assert.deepStrictEqual(SC.slotConflicts(b, ms, b.uidOf, '0-1', at('16:00', '2 号场')), []);
  const hit = SC.slotConflicts(b, ms, b.uidOf, '0-1', at('16:00', '1 号场'));
  assert.strictEqual(hit.length, 1); assert.deepStrictEqual(plain(hit[0].reasons), ['同一片场地（1 号场）']);
  assert.strictEqual(hit[0].b, '待定');
  // 找不到这场、活动没有日期：不查
  assert.deepStrictEqual(SC.slotConflicts(d, [], d.uidOf, 'nope', at('15:00', '3 号场')), []);
  assert.deepStrictEqual(SC.slotConflicts(single({ [k1]: at('15:00', '3 号场') }, { date: '' }), [], d.uidOf, k2, at('15:00', '3 号场')), []);
});

test('活动详情：有冲突时先提示涉及的场次和原因，「返回修改」不保存、「仍然保存」照常走 setFixtureSlot；没冲突直接保存', async () => {
  const base = single();
  const k1 = keyOf(base, '小明', '阿杰'), k2 = keyOf(base, '小明', '小周'), k3 = keyOf(base, '小周', '小林');
  const d = single({ [k1]: at('15:00', '3 号场') });
  let modal = null, answer = false;
  const saved = [];
  const filename = path.resolve(__dirname, '../pages/draw-view/draw-view.js');
  let def;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    require: (id) => (id === '../../utils/db'
      ? { setFixtureSlot: async (drawId, key, slot) => { saved.push({ drawId, key, slot: plain(slot) }); return { slot }; }, cachedPlayersFull: () => [] }
      : createRequire(filename)(id)),
    wx: {
      showModal(o) { modal = o; o.success({ confirm: answer, cancel: !answer }); },
      showToast() {},
    },
    Page: (x) => { def = x; }, console, setTimeout, clearTimeout,
  });
  const v = Object.assign({}, def, { data: plain(def.data), setData(p) { Object.keys(p).forEach((k) => { this.data[k] = p[k]; }); } });
  v.id = 'g1'; v.d = d; v.uidOf = d.uidOf; v.items = []; v.renderSchedule = () => {};
  v.data.isOwner = true; v.data.matches = [];
  const edit = (key, s) => { v.data.slotEdit = Object.assign({ key, title: '', date: '', time: '', court: '', courtIndex: 0 }, s); };

  edit(k2, { time: '15:00', court: '3 号场' });
  v.slotSave();
  assert.ok(modal, '有冲突要先提示');
  assert.strictEqual(modal.cancelText, '返回修改'); assert.strictEqual(modal.confirmText, '仍然保存');
  assert.ok(/同一片场地（3 号场）/.test(modal.content) && /小明 同时在这两场/.test(modal.content) && /阿杰/.test(modal.content), modal.content);
  assert.strictEqual(saved.length, 0, '返回修改：不保存');
  assert.ok(v.data.slotEdit, '安排面板还开着，可以接着改');

  answer = true; modal = null;
  v.slotSave();
  await new Promise((r) => setTimeout(r, 0));
  assert.ok(modal);
  assert.deepStrictEqual(saved, [{ drawId: 'g1', key: k2, slot: { date: '', time: '15:00', court: '3 号场' } }]);

  // 没有冲突：直接保存，不弹窗
  modal = null;
  edit(k3, { time: '16:00', court: '3 号场' }); // 刚保存的那场有小周，所以换个时间
  v.slotSave();
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(modal, null);
  assert.strictEqual(saved.length, 2); assert.strictEqual(saved[1].key, k3);
});

module.exports = T;
