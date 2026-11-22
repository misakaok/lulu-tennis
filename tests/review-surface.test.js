// 从 app.json 实际注册的页面及其组件检查入口，避免停用的社交内容重新进入发布包的页面。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const T = [];

T.push({ name: '所有注册页面和组件：没有相册、评价、简介、关注、联系人入口；照片只能在资料页（球员照片）上传，只经头像组件显示；球拍只有画的示意图', fn() {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  // 照片上传入口只有资料页（球员照片，经 utils/photo.js → 云函数 setPhoto 检测）；球拍用按配色画的示意图（组件 rk-art），没有照片
  const UPLOAD = { 'pages/profile/profile': 1 };
  const SHOW = { 'pages/profile/profile': 1, 'components/pl-av/pl-av': 1 }; // 动态图片只有资料页预览和头像组件
  const seen = new Set();
  const inspect = (base) => {
    if (seen.has(base)) return;
    seen.add(base);
    const rel = path.relative(root, base);
    const code = fs.readFileSync(base + '.js', 'utf8');
    const xml = fs.readFileSync(base + '.wxml', 'utf8');
    const config = JSON.parse(fs.readFileSync(base + '.json', 'utf8'));
    assert.ok(!/\b(?:call|cached|cloudCall)\s*\(\s*['"](?:submitReview|saveBio|setFollow|addEventPhotos|listEventPhotos|reviewSummary|getBios|getContact|saveContact|avatarUrls)['"]/.test(code), base);
    assert.ok(!/wx\.(?:chooseImage|chooseMedia|uploadFile|chooseAvatar)\s*\(|wx\.cloud\.uploadFile/.test(code), base + ' 不能直接选图 / 上传');
    assert.ok(!/open-type\s*=\s*['"]chooseAvatar['"]/.test(xml), base);
    if (!UPLOAD[rel]) assert.ok(!/\bP\.(?:pick|upload|put)\s*\(|['"]setPhoto['"]/.test(code), base + ' 不能上传照片');
    if (!SHOW[rel]) assert.ok(!/<image\b[^>]*\bsrc\s*=\s*['"][^'"]*\{\{/.test(xml), base + ' 动态图片只能用 <pl-av>');
    Object.values(config.usingComponents || {}).forEach((target) => {
      inspect(target.startsWith('/') ? path.join(root, target.slice(1)) : path.resolve(path.dirname(base), target));
    });
  };
  inspect(path.join(root, 'components/pl-av/pl-av')); // app.json 里的全局组件
  Object.values(app.usingComponents || {}).forEach((t) => inspect(path.join(root, t.slice(1))));
  app.pages.forEach((page) => inspect(path.join(root, page)));
  assert.ok(seen.size >= app.pages.length);
  // 照片的选取、上传只在 utils/photo.js；上传到本人目录后一律交给云函数 setPhoto 检测
  const photo = fs.readFileSync(path.join(root, 'utils/photo.js'), 'utf8');
  assert.ok(/call\('setPhoto'/.test(photo) && /cloudPath: `avatars\/\$\{uid\}\//.test(photo));
  // 球拍没有照片：不上传、不调用 racketPhoto，也没有拍照 / 相册 / 画布
  const rk = fs.readFileSync(path.join(root, 'utils/rackets.js'), 'utf8');
  assert.ok(!/racketPhoto|require\('\.\/photo'\)/.test(rk), '球拍不能上传照片');
  for (const p of ['pages/racket/racket', 'pages/racket-view/racket-view', 'pages/racket-edit/racket-edit', 'pages/racket-log/racket-log']) {
    const code = fs.readFileSync(path.join(root, p + '.js'), 'utf8') + fs.readFileSync(path.join(root, p + '.wxml'), 'utf8');
    assert.ok(!/utils\/photo|chooseMedia|chooseImage|racketPhoto|setPhoto|<canvas\b|<image\b|rk-photo/.test(code), p + ' 不能有照片');
  }
  assert.ok(!fs.existsSync(path.join(root, 'components/rk-photo')), '球拍照片组件已删除');
} });

T.push({ name: '所有注册页面和组件：文字输入只有比赛名称、昵称、称呼和搜索；没有手写新球员，不调用新增球员', fn() {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  // 仍然允许文字输入的页面：比赛名称（创建 / 编辑活动，各 1 个）、昵称（资料页）、准入页、搜索球员（只在本机筛选，不保存）
  const allowed = { 'pages/profile/profile': 9, 'pages/gate/gate': 9, 'pages/index/index': 9, 'pages/draw-new/draw-new': 1, 'pages/event-edit/event-edit': 1 };
  app.pages.forEach((page) => {
    const xml = fs.readFileSync(path.join(root, page + '.wxml'), 'utf8');
    const code = fs.readFileSync(path.join(root, page + '.js'), 'utf8');
    const texts = (xml.match(/<input\b[^>]*>/g) || []).filter((tag) => !/type\s*=\s*['"](?:number|digit)['"]/.test(tag));
    assert.ok(texts.length <= (allowed[page] || 0), page + ' 不应有多余的文字输入框');
    assert.ok(!/\baddPlayer\s*\(/.test(code), page);
  });
} });

T.push({ name: '所有注册页面和组件：没有多行文字框和可输入弹窗，原因只从固定选项里选', fn() {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  const E = require('../utils/event');
  Object.keys(E.REASONS).forEach((k) => assert.ok(E.REASONS[k].length >= 2 && E.REASONS[k].length <= 6, k + '：选择菜单最多 6 项'));
  const seen = new Set();
  const inspect = (base) => {
    if (seen.has(base)) return;
    seen.add(base);
    const code = fs.readFileSync(base + '.js', 'utf8');
    const xml = fs.readFileSync(base + '.wxml', 'utf8');
    assert.ok(!/<textarea\b|<editor\b/.test(xml), base + ' 不应有多行文字框');
    assert.ok(!/editable\s*:\s*true|placeholderText/.test(code), base + ' 不应有可输入弹窗');
    const config = JSON.parse(fs.readFileSync(base + '.json', 'utf8'));
    Object.values(config.usingComponents || {}).forEach((target) => {
      inspect(target.startsWith('/') ? path.join(root, target.slice(1)) : path.resolve(path.dirname(base), target));
    });
  };
  app.pages.forEach((page) => inspect(path.join(root, page)));
} });

T.push({ name: '所有注册页面和组件：界面文字不用赛事用语（小组赛、淘汰赛、签表、抽签、赛程、决赛、晋级等）和社交圈子用语（球友圈、社区、交友等）；「种子」只出现在种子设置相关的界面', fn() {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  const banned = /小组赛|淘汰赛|签表|分开排位|抽签|赛程|出线|决赛|晋级|赛制|参赛|赛事|球友圈|圈子|社区|社群|交友/; // 「球友圈」2026-11-19 未过审核；「比赛名称」按用户要求用在创建 / 编辑活动的名称栏
  // 「种子」只用在种子设置相关的界面（2026-11-22 用户要求把「分开排位」改成看得懂的种子设置）：
  // 创建 / 生成对阵页的种子区块、活动详情的种子名单、活动列表卡片的种子数，且只用下面几种固定说法
  const SEED_PAGES = ['pages/draw-new/draw-new', 'pages/draw-view/draw-view', 'pages/draw/draw'].map((p) => path.join(root, p));
  const seedOk = /种子(选手|队伍|优先轮空)|号种子/g;
  const seedUsed = new Set();
  const seen = new Set();
  const check = (label, text, base) => {
    const hit = text.match(banned);
    assert.ok(!hit, label + '：' + (hit && hit[0]));
    let rest = text;
    if (SEED_PAGES.indexOf(base) >= 0) {
      if (seedOk.test(text)) seedUsed.add(base);
      seedOk.lastIndex = 0;
      rest = text.replace(seedOk, '');
    }
    assert.ok(!/种子/.test(rest), label + '：「种子」只能用在种子设置相关的界面，并用「种子选手 / 种子队伍 / N 号种子」这些说法');
  };
  const inspect = (base) => {
    if (seen.has(base)) return;
    seen.add(base);
    const xml = fs.readFileSync(base + '.wxml', 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    check(base + '.wxml', xml, base);
    // 脚本里只看字符串（提示、弹窗文字），不看注释
    const code = fs.readFileSync(base + '.js', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    check(base + '.js', code, base);
    const config = JSON.parse(fs.readFileSync(base + '.json', 'utf8'));
    assert.ok(!banned.test(config.navigationBarTitleText || ''), base + '.json');
    Object.values(config.usingComponents || {}).forEach((target) => {
      inspect(target.startsWith('/') ? path.join(root, target.slice(1)) : path.resolve(path.dirname(base), target));
    });
  };
  app.pages.forEach((page) => inspect(path.join(root, page)));
  SEED_PAGES.forEach((p) => assert.ok(seedUsed.has(p), path.relative(root, p) + ' 应显示种子设置（不再用「分开排位」）'));
} });

module.exports = T;

T.push({ name: '所有页面和组件的 WXML 标签成对闭合（模板写错时开发者工具会直接报错）', fn() {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.wxml') ? [path.join(d, e.name)] : []));
  const files = ['pages', 'components'].flatMap((d) => walk(path.join(root, d)));
  assert.ok(files.length > 10);
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '').replace(/\{\{[\s\S]*?\}\}/g, 'X');
    const stack = [];
    for (const m of src.matchAll(/<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>/g)) {
      const [, close, tag, self] = m;
      if (self) continue;
      if (!close) { stack.push(tag); continue; }
      assert.strictEqual(stack.pop(), tag, `${path.relative(root, f)} 的 </${tag}> 没有对应的开始标签`);
    }
    assert.deepStrictEqual(stack, [], `${path.relative(root, f)} 有没闭合的标签`);
  }
} });

T.push({ name: '用到 player-home 的页面：页面样式的类名不和组件里的类名重名（组件共享页面样式，重名会把组件排版弄乱）', fn() {
  const used = new Set();
  const tpl = fs.readFileSync(path.join(root, 'components/player-home/player-home.wxml'), 'utf8').replace(/\{\{[\s\S]*?\}\}/g, ' ');
  for (const m of tpl.matchAll(/class="([^"]*)"/g)) m[1].split(/\s+/).filter(Boolean).forEach((c) => used.add(c));
  const pages = fs.readdirSync(path.join(root, 'pages')).filter((d) => { const j = path.join(root, 'pages', d, d + '.json'); return fs.existsSync(j) && /player-home/.test(fs.readFileSync(j, 'utf8')); });
  assert.ok(pages.length >= 1);
  for (const d of pages) {
    const css = fs.readFileSync(path.join(root, 'pages', d, d + '.wxss'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const own = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
    const clash = [...own].filter((c) => used.has(c));
    assert.deepStrictEqual(clash, [], `pages/${d} 的样式和 player-home 重名：${clash.join('、')}`);
  }
} });
