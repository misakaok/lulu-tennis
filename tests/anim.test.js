// 数字滚动 utils/anim.js（纯展示：只影响显示过程，最后一帧必须是原值）
const assert = require('assert');
const Anim = require('../utils/anim');

const T = [];
const clock = require('./fake-clock')(); // 虚拟时间：动画照常一帧帧走，不用真的等它放完
const test = (name, fn) => T.push({ name, fn: () => clock.run(fn) });
const wait = clock.wait;
// 模拟页面：setData 支持 'a.b' 路径
const page = (data) => ({
  data, frames: 0,
  setData(o, cb) {
    this.frames++;
    Object.keys(o).forEach((k) => { const ks = k.split('.'); let t = this.data; while (ks.length > 1) t = t[ks.shift()]; t[ks[0]] = o[k]; });
    if (cb) setTimeout(cb, 16); // 渲染完成后回调（下一帧）
  },
});

test('rollText：文字里的数字按进度缩小，小数位数和其他文字不变', () => {
  assert.strictEqual(Anim.rollText('12胜 5负', 0.5), '6胜 3负');
  assert.strictEqual(Anim.rollText('3.52', 0.5), '1.76');
  assert.strictEqual(Anim.rollText('62%', 0), '0%');
  assert.strictEqual(Anim.rollText(40, 1), '40');
  assert.strictEqual(Anim.rollText('暂无', 0.3), '暂无');
});

test('roll：起始帧从 0 开始，结束后是原值（类型不变）；每个页面只滚一次', async () => {
  const p = page({ me: { played: 12, rate: 58, level: '3.52' } });
  const first = Anim.roll(p, { 'me.played': 12, 'me.rate': 58, 'me.level': '3.52' });
  assert.deepStrictEqual(first, { 'me.played': '0', 'me.rate': '0', 'me.level': '0.00' });
  await wait(Anim.MS + 150);
  assert.deepStrictEqual(p.data.me, { played: 12, rate: 58, level: '3.52' });
  assert.ok(p.frames > 3);
  assert.deepStrictEqual(Anim.roll(p, { 'me.played': 13 }), {});
});

test('roll：没有数据（0、暂无）时不滚，等有数据再滚；滚动中重新渲染（缓存画完云端又画）接着滚到新值，不跳到终点', async () => {
  const p = page({ s: { n: 0, t: '暂无' } });
  assert.deepStrictEqual(Anim.roll(p, { 's.n': 0, 's.t': '暂无' }), {});
  assert.deepStrictEqual(Anim.roll(p, { 's.n': 20, 's.t': '暂无' }), { 's.n': '0' }); // 没有数字的字段不参与
  await wait(80);
  const mid = Anim.roll(p, { 's.n': 40 }); // 新的渲染：放当前进度的一帧，不是终值
  const v = Number(mid['s.n']);
  assert.ok(v > 0 && v < 40, '接着滚，不跳到 40：' + mid['s.n']);
  p.setData(mid);
  const seen = [];
  const set = p.setData.bind(p);
  p.setData = (o) => { if (o['s.n'] !== undefined) seen.push(Number(o['s.n'])); set(o); };
  await wait(Anim.MS + 150);
  assert.strictEqual(p.data.s.n, 40);
  assert.ok(seen.every((x, i) => i === 0 || x >= seen[i - 1]) && seen[0] >= v, '只往上走，不回头');
  assert.deepStrictEqual(Anim.roll(p, { 's.n': 41 }), {}, '滚完以后不再滚');
});

test('once：一次启动只返回一次 true', () => {
  assert.strictEqual(Anim.once('t-x'), true);
  assert.strictEqual(Anim.once('t-x'), false);
  assert.strictEqual(Anim.once('t-y'), true);
});

test('leave / enter：战绩、排行切换 tab 回来时重播（动画类、数字从 0 再滚到原值）；只是被子页面盖住时不重播', async () => {
  const p = page({ play: true, me: { played: 12, rate: 58 } });
  Anim.roll(p, { 'me.played': 12, 'me.rate': 58 });
  await wait(Anim.MS + 150);
  global.getCurrentPages = () => [p, {}]; // 点进详情页
  Anim.leave(p);
  assert.strictEqual(p.data.play, true);
  assert.deepStrictEqual(Anim.enter(p), {});
  // 点进详情页：onHide 时新页面还没进页面栈，稍后才进 → 也不重播（2026-11-25 用户说返回战绩页闪一下）
  global.getCurrentPages = () => [p];
  Anim.leave(p);
  global.getCurrentPages = () => [p, {}];
  await wait(Anim.LEAVE_MS + 50);
  assert.strictEqual(p.data.play, true);
  Anim.enter(p);
  // 退到后台马上又回来（还没到 LEAVE_MS）：保持原样
  global.getCurrentPages = () => [p];
  Anim.leave(p);
  Anim.enter(p);
  await wait(Anim.LEAVE_MS + 50);
  assert.strictEqual(p.data.play, true);
  global.getCurrentPages = () => [{}]; // 切到别的 tab
  Anim.leave(p);
  await wait(Anim.LEAVE_MS + 50);
  assert.strictEqual(p.data.play, false);
  assert.deepStrictEqual(p.data.me, { played: '0', rate: '0' });
  // 切走期间数据变了：仍停在 0，回来时滚到新值
  assert.deepStrictEqual(Anim.roll(p, { 'me.played': 13, 'me.rate': 60 }), { 'me.played': '0', 'me.rate': '0' });
  p.data.me = { played: '0', rate: '0' };
  const plays = [];
  const set0 = p.setData;
  p.setData = function (o, cb) { if (o.play !== undefined) plays.push(o.play); return set0.call(this, o, cb); };
  assert.deepStrictEqual(Anim.enter(p), {}, '重播自己 setData，返回空');
  // 先确认「入场前」画出来（play: false + 数字 0），下一帧才加上动画类（不挤在同一帧，免得上下弹两下）
  assert.deepStrictEqual(plays, [false]);
  await wait(40);
  assert.deepStrictEqual(plays, [false, true]);
  await wait(Anim.MS + 150);
  assert.deepStrictEqual(p.data.me, { played: 13, rate: 60 });
  Anim.enter(p);
  assert.deepStrictEqual(plays, [false, true], '只重播一次');
  delete global.getCurrentPages;
});

test('页面接入：战绩、排行的入场动画类都随 play 切换，并在 onHide / onShow 里调用 leave / enter；球拍页不重播', () => {
  const fs = require('fs');
  const path = require('path');
  ['index', 'rank'].forEach((n) => {
    const base = path.join(__dirname, '..', 'pages', n, n);
    const wxml = fs.readFileSync(base + '.wxml', 'utf8'), js = fs.readFileSync(base + '.js', 'utf8');
    // 入场动画类（含弹出、柱子升起、高光）都只能写成 play ? 'ani-xx' : …，切 tab 回来才能重播
    // 高光例外：战绩页「我的战绩」卡的高光只在第一次出现时扫一次（固定类），切 tab 回来不再扫
    const ANI = /'ani-(in|grow-[xy]|pop|score|sheen)'\s*:\s*''|class="[^"]*\bani-(in|grow-[xy]|pop|score)\b[^{"]*"/;
    assert.ok(!ANI.test(wxml.replace(/play \? 'ani-(in|grow-[xy]|pop|score|sheen)'/g, '')), n + ' 有不随 play 切换的动画类');
    (wxml.match(/play \? 'ani-[a-z-]+' : '[a-z-]*'/g) || []).forEach((x) => {
      const [, on, off] = x.match(/'(ani-[a-z-]+)' : '([a-z-]*)'/);
      const want = { 'ani-in': 'ani-wait', 'ani-grow-x': 'ani-wait-x', 'ani-grow-y': 'ani-wait-y', 'ani-pop': 'ani-wait-pop', 'ani-sheen': '' }[on];
      assert.strictEqual(off, want, n + ' ' + x);
    });
    assert.ok(/onHide\(\)\s*\{\s*Anim\.leave\(this\)/.test(js) && /Anim\.enter\(this\)/.test(js), n + ' 没有接入 leave / enter');
  });
  const idx = fs.readFileSync(path.join(__dirname, '..', 'pages', 'index', 'index.wxml'), 'utf8');
  assert.ok(/wx:if="\{\{me\}\}" class="mine bg-host ani-sheen"/.test(idx), '「我的战绩」卡高光只扫一次，不随 play 重播');
  // 比赛卡片列表不做入场动画（2026-11-25 用户要求取消），只保留按下回弹
  assert.ok(/class="mc win-\{\{item\.winner\}\}" hover-class="tap-on"/.test(idx), '战绩页比赛卡片不要入场动画');
  // 排行榜表格（名次行、胜率条）也不做动画（2026-11-25 用户要求取消），领奖台照旧
  const rkw = fs.readFileSync(path.join(__dirname, '..', 'pages', 'rank', 'rank.wxml'), 'utf8');
  assert.ok(/class="tr \{\{item\.key === myKey \? 'me' : ''\}\}" hover-class/.test(rkw), '排行榜表格行不要入场动画');
  assert.ok(/class="rate-fill" style/.test(rkw), '胜率条不要生长动画');
  assert.ok(!/\.rate-fill \{[^}]*transition/.test(fs.readFileSync(path.join(__dirname, '..', 'pages', 'rank', 'rank.wxss'), 'utf8')), '胜率条不要宽度过渡');
  // 球拍页切 tab 回来不重播（2026-11-25 用户觉得动画太多，只还原战绩、排行）
  const rk = path.join(__dirname, '..', 'pages', 'racket', 'racket');
  assert.ok(!/\bplay\b|ani-wait/.test(fs.readFileSync(rk + '.wxml', 'utf8')));
  assert.ok(!/Anim\.(leave|enter)/.test(fs.readFileSync(rk + '.js', 'utf8')));
  // 等待态一下子到位，不走卡片的按下回弹过渡（不然切 tab 回来卡片先下滑再弹上来）
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'app.wxss'), 'utf8'), /\.ani-wait, \.ani-wait-x, \.ani-wait-y, \.ani-wait-pop \{ transition: none !important; \}/);
});

test('缓动：4 次方减速（快起慢刹），两端是 0 和 1、全程单调不回头；滚动约 28ms 一帧', async () => {
  assert.strictEqual(Anim.ease(0), 0);
  assert.strictEqual(Anim.ease(1), 1);
  assert.ok(Math.abs(Anim.ease(0.5) - (1 - Math.pow(0.5, 4))) < 1e-12);
  assert.ok(Anim.ease(0.25) > 0.68, '前四分之一就走完大半');
  let prev = 0;
  for (let i = 1; i <= 100; i++) { const v = Anim.ease(i / 100); assert.ok(v >= prev && v <= 1); prev = v; }
  const p = page({ n: 0 });
  Anim.roll(p, { n: 40 });
  await wait(Anim.MS + 100);
  assert.strictEqual(p.data.n, 40);
  assert.ok(p.frames >= Math.floor(Anim.MS / 28) - 2 && p.frames <= Math.ceil(Anim.MS / 28) + 2, '帧数按 28ms 一帧');
});

test('全局动效类：高光用 ::after、只播一次停在看不见；排行领奖台按名次错峰（第 3 → 2 → 1）', () => {
  const fs = require('fs');
  const path = require('path');
  const css = fs.readFileSync(path.join(__dirname, '..', 'app.wxss'), 'utf8');
  ['ani-pop', 'ani-score', 'ani-sheen'].forEach((k) => assert.ok(new RegExp('@keyframes ' + k + ' ').test(css), k));
  const sheen = css.match(/\.ani-sheen::after \{([^}]*)\}/)[1];
  assert.ok(/pointer-events: none/.test(sheen) && /opacity: 0/.test(sheen) && /\bboth;/.test(sheen) && !/infinite/.test(sheen));
  assert.ok(/100% \{ opacity: 0;/.test(css.match(/@keyframes ani-sheen [^\n]*/)[0]), '最后停在看不见');
  assert.ok(/\.ani-in \{ animation: ani-in [^;]*cubic-bezier\(0\.22, 1, 0\.36, 1\)/.test(css));
  assert.match(css, /\.num \{ font-family: "DIN Alternate", "Avenir Next Condensed", "Roboto Condensed", -apple-system, Roboto, sans-serif;/);
  // 毛玻璃块：半透明底不低于 0.16（不支持模糊的老机型照样看得清），入场 / 按压都不缩放。
  // 底色是半透白（.hero-tag）或烟熏冷紫 rgba(56, 54, 108, …)（球员卡数据条、战绩页 .ms、比赛详情 .hset，2026-11-25 统一）
  [['pages/match/match.wxss', ['hset', 'hero-tag']], ['pages/index/index.wxss', ['ms']], ['components/player-home/player-home.wxss', ['pc-stats']]].forEach(([f, ks]) => {
    const x = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    ks.forEach((k) => {
      const rule = x.match(new RegExp('\\n\\.' + k + ' \\{([^}]*)\\}'))[1];
      if (k !== 'hero-tag') assert.ok(/background: rgba\(56, 54, 108, 0\.16\)/.test(rule), k + ' 是烟熏冷紫底（三张紫色头卡的数据块统一；0.22 偏沉，2026-11-25 调浅到 0.16）');
      assert.ok(/backdrop-filter: blur/.test(rule), k);
      const bg = rule.match(/background: rgba\((?:255, ?255, ?255|56, ?54, ?108), ?([\d.]+)\)/);
      assert.ok(bg && Number(bg[1]) >= 0.16, k);
    });
  });
  assert.ok(!/scale/.test(fs.readFileSync(path.join(__dirname, '..', 'pages/match/match.wxss'), 'utf8').match(/@keyframes hset-in [^\n]*/)[0]));
  // 动画只动 transform / opacity
  (css.match(/@keyframes [^\n]*/g) || []).forEach((k) => {
    const props = (k.match(/[{;]\s*([a-z-]+):/g) || []).map((x) => x.replace(/[{;\s:]/g, ''));
    props.forEach((x) => assert.ok(x === 'transform' || x === 'opacity', k));
  });
  const rank = fs.readFileSync(path.join(__dirname, '..', 'pages', 'rank', 'rank.wxml'), 'utf8');
  const D = "\\{\\{item\\.rank === 1 \\? 600 : item\\.rank === 2 \\? 360 : 140\\}\\}ms";
  assert.match(rank, new RegExp('class="pod r\\{\\{item\\.rank\\}\\} [^"]*" style="animation-delay:' + D + '"'));
  assert.match(rank, new RegExp(`class="pod-base \\{\\{play \\? 'ani-grow-y' : 'ani-wait-y'\\}\\} \\{\\{play \\? 'ani-sheen' : ''\\}\\}" style="animation-delay:` + D + '"'));
  assert.match(rank, /class="medal-img \{\{play \? 'ani-pop' : 'ani-wait-pop'\}\}" style="animation-delay:\{\{item\.rank === 1 \? 1040 : item\.rank === 2 \? 800 : 580\}\}ms"/);
  // 高光只给冠军台
  const rcss = fs.readFileSync(path.join(__dirname, '..', 'pages', 'rank', 'rank.wxss'), 'utf8');
  assert.ok(/\.r2 \.pod-base::after, \.r3 \.pod-base::after \{ display: none; \}/.test(rcss));
  // 入场时长统一放慢约 25%（2026-11-25 用户觉得稍快），在全局类里改，页面不再单独覆盖
  [['ani-in', '0.62s'], ['ani-grow-x', '0.94s'], ['ani-grow-y', '0.78s'], ['ani-pop', '0.52s'], ['ani-score', '0.55s']].forEach(([k, d]) =>
    assert.ok(new RegExp('\\.' + k + ' \\{[^}]*animation: ' + k + ' ' + d.replace('.', '\\.')).test(css), k + ' 应为 ' + d));
  // 呼吸光点：外圈放大淡出，只动 transform / opacity（上面的 keyframes 检查也覆盖）
  assert.match(css, /@keyframes ani-pulse \{ 0% \{ opacity: 0\.7; transform: scale\(1\); \} 100% \{ opacity: 0; transform: scale\(2\.2\); \} \}/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'pages', 'draw', 'draw.wxml'), 'utf8'), /<view wx:if="\{\{item\.st === 'sign'\}\}" class="pulse"><\/view>\{\{item\.status\.text\}\}/);
  // .bg-host 卡片的第一个子元素仍是 .bg-img（高光不插子元素）
  ['pages/index/index.wxml', 'pages/match/match.wxml', 'components/player-home/player-home.wxml'].forEach((f) => {
    const x = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
    const re = /<view [^>]*class="[^"]*\bbg-host\b[^"]*"[^>]*>\s*(<[^>]*>)/g;
    let m, n = 0;
    while ((m = re.exec(x))) { n++; assert.ok(/^<image class="bg-img"/.test(m[1]), f + '：' + m[1]); }
    assert.ok(n > 0, f);
  });
});

test('触觉反馈 utils/haptic.js：没有 wx、没有 vibrateShort、调用抛错都不报错；有就按轻 / 中震', () => {
  const H = require('../utils/haptic');
  const had = Object.prototype.hasOwnProperty.call(global, 'wx'), old = global.wx;
  try {
    delete global.wx;
    H.light(); H.medium();
    global.wx = {};
    H.light(); H.medium();
    global.wx = { vibrateShort() { throw new Error('不支持'); } };
    H.light(); H.medium();
    const got = [];
    global.wx = { vibrateShort: (o) => { got.push(o.type); assert.strictEqual(typeof o.fail, 'function'); } };
    H.light(); H.medium();
    assert.deepStrictEqual(got, ['light', 'medium']);
  } finally { if (had) global.wx = old; else delete global.wx; }
});

test('滑动胶囊：活动首页、排行（两处）、积分榜、战绩筛选都用同一个滑块，宽度按项数等分、按选中项平移；滑块只过渡 transform', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const css = read('app.wxss');
  const thumb = css.match(/\n\.seg-thumb \{([^}]*)\}/)[1];
  assert.ok(/transition: transform 0\.42s cubic-bezier\(0\.34, 1\.24, 0\.64, 1\);/.test(thumb) && !/transition:[^;]*(left|width|background)/.test(thumb));
  assert.ok(/\.seg\.has-thumb \.seg-item \{[^}]*background: transparent;/.test(css), '选中项本身不再画白底');
  const want = [
    ['pages/draw/draw.wxml', "width:33.3333%;transform:translateX({{(tab === 'all' ? 0 : tab === 'mine' ? 1 : 2) * 100}}%)"],
    ['pages/rank/rank.wxml', "width:50%;transform:translateX({{view === 'cup' ? 100 : 0}}%)"],
    ['pages/rank/rank.wxml', "width:33.3333%;transform:translateX({{(filter === 'single' ? 1 : filter === 'double' ? 2 : 0) * 100}}%)"],
    ['components/cup-board/cup-board.wxml', 'width:{{100 / boards.length}}%;transform:translateX({{whichIdx * 100}}%)'],
    ['pages/index/index.wxml', "width:33.3333%;transform:translateX({{(filter === 'single' ? 1 : filter === 'double' ? 2 : 0) * 100}}%)"],
  ];
  want.forEach(([f, style]) => {
    const x = read(f);
    assert.ok(x.indexOf('<view class="seg-track"><view class="seg-thumb" style="' + style + '"></view></view>') >= 0, f + ' ' + style);
  });
  // 积分榜：切换时滑块位置跟着选中项
  const Module = require('module');
  const vm = require('vm');
  let def;
  const file = path.join(__dirname, '..', 'components/cup-board/cup-board.js');
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: (id) => (/utils\/(cloud|db)$/.test(id) ? {} : Module.createRequire(file)(id)), Component: (d) => { def = d; }, console, setTimeout: () => 0, wx: {} });
  const c = Object.assign({}, def.methods, { data: JSON.parse(JSON.stringify(def.data)), setData(o) { Object.assign(this.data, o); }, render() {} });
  c.setWhich({ currentTarget: { dataset: { v: 'encounter' } } });
  assert.strictEqual(c.data.whichIdx, c.data.boards.findIndex((b) => b.value === 'encounter'));
  c.setWhich({ currentTarget: { dataset: { v: 'single' } } });
  assert.strictEqual(c.data.whichIdx, 0);
});

test('活动首页卡片：进行中的活动有进度条（已完成场数 / 总场数，四舍五入成百分比），报名中、已出冠军的没有', () => {
  const fs = require('fs');
  const path = require('path');
  const vm = require('vm');
  const Module = require('module');
  const E = require('../utils/event');
  const file = path.join(__dirname, '..', 'pages/draw/draw.js');
  let def;
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { require: (id) => (/utils\/db$/.test(id) ? {} : Module.createRequire(file)(id)), Page: (d) => { def = d; }, console, setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {}, wx: {}, getCurrentPages: () => [] });
  const p = Object.assign({}, def, { data: JSON.parse(JSON.stringify(def.data)), setData(o) { Object.assign(this.data, o); } });
  const drawn = { _id: 'b1', title: '周六单打', mode: 'bracket', size: 4, status: 'drawn', date: '2026-11-20', entrants: ['小明', '阿杰', '小周', '小林'], lines: [{ name: '小明' }, { name: '阿杰' }, { name: '小周' }, { name: '小林' }] };
  const sign = { _id: 'b2', title: '报名中', mode: 'bracket', size: 4, status: 'signup', date: '2026-11-30', entrants: [] };
  p.draws = [drawn, sign]; p.matches = []; p.signups = []; p.myId = '';
  p.render();
  const pr = E.progressOf(drawn, []);
  assert.ok(pr.total > 0);
  const v = p.list.find((x) => x._id === 'b1');
  assert.strictEqual(v.progressPct, Math.round((pr.done / pr.total) * 100));
  assert.strictEqual(v.progressShort, pr.done + '/' + pr.total + ' 场');
  assert.strictEqual(v.st, 'play');
  const s = p.list.find((x) => x._id === 'b2');
  assert.deepStrictEqual([s.progressShort, s.st], ['', 'sign']);
  const xml = fs.readFileSync(path.join(__dirname, '..', 'pages/draw/draw.wxml'), 'utf8');
  assert.ok(/<view wx:elif="\{\{item\.progressShort\}\}" class="d-pb">[\s\S]*?style="width:\{\{item\.progressPct\}\}%"[\s\S]*?<text class="d-pb-t num">\{\{item\.progressShort\}\}<\/text>/.test(xml));
});

test('排行榜领奖台包在「舞台卡」里（2026-11-25）：透视网球场底纹、底座长在卡片底边；筛选三行左对齐', () => {
  const fs = require('fs'), path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const xml = read('pages/rank/rank.wxml'), css = read('pages/rank/rank.wxss');
  const stage = xml.slice(xml.indexOf('<view wx:if="{{top.length}}" class="card stage">'), xml.indexOf('<!-- 完整榜单 -->'));
  assert.ok(stage.length > 0 && /<view class="stage-court"><\/view>/.test(stage));
  // 透视网球场（方向 B）：样式里的 base64 矢量线，只有线条（边线、底线、发球线、中线 + 球网虚线），没有图片 / 文字
  const m = css.match(/\.stage-court \{[^}]*url\("data:image\/svg\+xml;base64,([A-Za-z0-9+\/=]+)"\)/);
  assert.ok(m, '球场线写在样式里');
  const svg = Buffer.from(m[1], 'base64').toString('utf8');
  assert.ok(/^<svg /.test(svg) && !/<image|<text|href=/.test(svg), '只有矢量线条');
  assert.strictEqual((svg.match(/<line /g) || []).length, 8, '4 条边线 + 远端底线 + 远端发球线 + 远半场中线 + 球网（省掉近端发球线，不穿名字）');
  assert.ok(/stroke-dasharray="5 5"/.test(svg) && /id="n"/.test(svg) && /stop-opacity="0\.22"/.test(svg) && /stop-opacity="0\.02"/.test(svg), '球网是横向渐淡虚线，普通线四段渐隐');
  assert.ok(!/sc-arc|sc-mid/.test(xml + css), 'Gemini 版的中圈 / 中线已去掉');
  assert.ok(/<view class="podium \{\{top\.length >= 3 \? '' : 'few'\}\}">/.test(stage), '领奖台本身不再单独判断 top.length');
  assert.strictEqual((stage.match(/<image /g) || []).length, 1, '舞台卡里只有奖牌图标，不加图片');
  assert.ok(/\.stage \{[^}]*padding: 34rpx 20rpx 0;/.test(css) && /ellipse 46% 36% at 50% 29%/.test(css), '底部不留内边距，底座长在卡片底边；聚光对齐球网中点与第 1 名头像');
  assert.ok(/\.stage-court \{[^}]*height: 520rpx; pointer-events: none; z-index: 0;/.test(css) && /\.podium \{ position: relative; z-index: 1;/.test(css));
  // 第 1 名头像外双波水纹细环：外层 .pod-av 承载 ::before / ::after（头像本身不缩放），关键帧只在 app.wxss 动 transform / opacity
  assert.ok(/<view class="pod-av"><pl-av class="avatar big"/.test(stage), '头像包在 .pod-av 里给光环留位置');
  assert.ok(/\.r1 \.pod-av::before, \.r1 \.pod-av::after \{[^}]*z-index: -1;/.test(css) && /\.r1 \.pod-av::before \{[^}]*animation: ani-ring /.test(css) && /\.r1 \.pod-av::after \{[^}]*animation: ani-ring-sub /.test(css), '只给第 1 名加错峰双波细环');
  assert.ok(/@keyframes ani-ring /.test(read('app.wxss')) && /@keyframes ani-ring-sub /.test(read('app.wxss')), '双波细环关键帧在 app.wxss 并接受只动 transform / opacity 检查');
  assert.ok(/\.sort-row \{[^}]*justify-content: flex-start;/.test(css) && (css.match(/\.top-seg \{/g) || []).length === 1);
});

test('战绩页背景与记分牌（2026-11-25）：顶部淡紫柔幕、我的战绩卡对角柔光且内容盖在上面、比赛卡纯 CSS 球场暗纹；不加图片、不加入场动画', () => {
  const fs = require('fs'), path = require('path');
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  const xml = read('pages/index/index.wxml'), css = read('pages/index/index.wxss');
  const rule = (sel) => { const m = css.match(new RegExp('\\n' + sel.replace(/[.:()]/g, '\\$&') + ' \\{([^}]*)\\}')); return m ? m[1] : ''; };
  // 柔幕：局部层叠，垫在页面内容下面
  assert.ok(/position: relative; z-index: 0;/.test(rule('.page')));
  assert.ok(/pointer-events: none; z-index: -1;/.test(rule('.page::before')) && /#A3A3CB 0%/.test(rule('.page::before')));
  // 我的战绩卡：::before 铺满整卡（z 0），内容 z 1；背景图仍是第一个子元素；::after 留给高光
  assert.ok(/<view wx:if="\{\{me\}\}" class="mine bg-host ani-sheen"[^>]*>\s*<image class="bg-img"/.test(xml));
  assert.ok(/bottom: 0;[^}]*z-index: 0;/.test(rule('.mine::before')) && !/\.mine::after/.test(css));
  assert.ok(/\n\.mine-h, \.mine-stats, \.mine-form \{ position: relative; z-index: 1; \}/.test(css));
  // 比赛卡：俯视横向网球场底纹（SVG 矢量线，无圆圈、无图片），在最底层；双方和比分在上面；卡片不加入场动画
  assert.ok(/<view class="mc-body">\s*(<!--[^>]*-->\s*)?<view class="mc-court"><\/view>/.test(xml));
  assert.ok(!/mc-mid|mc-arc/.test(xml + css), '去掉旧的圆圈中线，改用俯视网球场线');
  const mcM = css.match(/\.mc-court \{[^}]*url\("data:image\/svg\+xml;base64,([A-Za-z0-9+\/=]+)"\)/);
  assert.ok(mcM, '比赛卡球场线写在样式里');
  const mcSvg = Buffer.from(mcM[1], 'base64').toString('utf8');
  assert.ok(/^<svg /.test(mcSvg) && !/<image|<text|<circle|href=/.test(mcSvg), '只有矢量线条、无圆圈和图片');
  assert.strictEqual((mcSvg.match(/<line /g) || []).length, 6, '上下单打边线 + 左右发球线 + 发球中线 + 竖向球网虚线');
  assert.ok(/stroke-dasharray="4 4"/.test(mcSvg), '正中是球网虚线');
  assert.ok(/pointer-events: none; z-index: 0;/.test(rule('.mc-court')) && /\n\.mc-body \.sd, \.mc-body \.sc \{ position: relative; z-index: 1; \}/.test(css));
  assert.ok(!/\.mc\.win-[ab]::before/.test(css) && /\.mc\.win-a \.mc-body::before, \.mc\.win-b \.mc-body::before \{[^}]*#A9A9D2, #7D7DB3/.test(css) && /rgba\(132, 132, 182, 0\.11\)/.test(rule('.mc.win-a')), '胜方一侧用内缩淡紫圆头短竖条 + 冷雾紫微光，不放荧光黄绿通长竖条');
  assert.ok(/class="mc win-\{\{item\.winner\}\}" hover-class="tap-on"/.test(xml) && !/class="mc [^"]*ani-/.test(xml));
  const cards = xml.slice(xml.indexOf('<view class="date">'));
  assert.ok(!/<image /.test(cards.slice(0, cards.indexOf('class="fabs"'))), '比赛卡里不放图片');
});

module.exports = T;
