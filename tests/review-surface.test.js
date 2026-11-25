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
    // 动态图片只能用 <pl-av>；例外是包里的静态配图按编号取（如徽章 /images/badges/{{id}}.png），不是用户上传的
    if (!SHOW[rel]) assert.ok(!/<image\b[^>]*\bsrc\s*=\s*['"](?!\/images\/)[^'"]*\{\{/.test(xml), base + ' 动态图片只能用 <pl-av>');
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
  // 例外只有包里的静态界面配图（/images/ 下的固定图片，不是用户上传的）：空状态插画
  const FIXED_ART = /<image class="[\w-]+" src="\/images\/[\w-]+\.(?:png|jpg)" mode="aspectFit" \/>/g;
  assert.ok(!/racket-hero\.png/.test(fs.readFileSync(path.join(root, 'pages/racket/racket.wxml'), 'utf8')), '球拍页顶部卡片不再放重复的球拍插图');
  for (const p of ['pages/racket/racket', 'pages/racket-view/racket-view', 'pages/racket-edit/racket-edit', 'pages/racket-log/racket-log']) {
    const code = fs.readFileSync(path.join(root, p + '.js'), 'utf8') + fs.readFileSync(path.join(root, p + '.wxml'), 'utf8').replace(FIXED_ART, '');
    assert.ok(!/utils\/photo|chooseMedia|chooseImage|racketPhoto|setPhoto|<canvas\b|<image\b|rk-photo/.test(code), p + ' 不能有照片');
  }
  assert.ok(!fs.existsSync(path.join(root, 'components/rk-photo')), '球拍照片组件已删除');
} });

T.push({ name: '活动首页顶部轮播：只换背景（固定底图 + 2 张淡入淡出），文字按钮不动；只有活动首页有；切走页面停、朋友圈单页不转', fn() {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  app.pages.forEach((page) => {
    const xml = fs.readFileSync(path.join(root, page + '.wxml'), 'utf8');
    if (page !== 'pages/draw/draw') assert.ok(!/hero-slide/.test(xml), page + '：轮播只在活动首页（每页最多一张背景图的唯一例外）');
  });
  const xml = fs.readFileSync(path.join(root, 'pages/draw/draw.wxml'), 'utf8');
  const hero = xml.slice(xml.indexOf('<view class="hero bg-host">'), xml.indexOf('<view class="hero-in">'));
  assert.deepStrictEqual((hero.match(/src="([^"]+)"/g) || []), ['src="/images/hero-court.jpg"', 'src="/images/hero-2.jpg"', 'src="/images/hero-3.jpg"']);
  assert.ok(!/<text|hero-title|hero-btn/.test(hero), '文字和按钮不在轮播里');
  const css = fs.readFileSync(path.join(root, 'pages/draw/draw.wxss'), 'utf8');
  (css.match(/\.hero-[\w-]+(?:\.[\w-]+)? \{[^}]*\}/g) || []).forEach((r) => {
    const t = (r.match(/transition:\s*([^;]+)/) || [])[1];
    if (t) assert.ok(/^opacity\b/.test(t.trim()), '轮播只动 opacity：' + r);
  });
  const js = fs.readFileSync(path.join(root, 'pages/draw/draw.js'), 'utf8');
  assert.ok(/onHide\(\) \{ this\.heroStop\(\); \}/.test(js) && /onUnload\(\) \{ this\.heroStop\(\); \}/.test(js), '切走页面停');
  assert.ok(/if \(this\.timeline\) return;\n\s*this\.heroStart\(\);/.test(js), '朋友圈单页模式不启动轮播');
} });

T.push({ name: '界面配图：背景图只用包里的静态图片（.bg-host 卡片里的 .bg-img），文件存在、压缩过；文字和按钮仍是页面组件', fn() {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  const used = {};
  const comps = fs.readdirSync(path.join(root, 'components')).filter((c) => fs.existsSync(path.join(root, 'components', c, c + '.wxml'))).map((c) => 'components/' + c + '/' + c);
  app.pages.concat(comps).forEach((page) => {
    const xml = fs.readFileSync(path.join(root, page + '.wxml'), 'utf8');
    (xml.match(/<image\b[^>]*class="bg-img"[^>]*>/g) || []).forEach((tag) => {
      const src = (tag.match(/\bsrc="([^"]*)"/) || [])[1] || '';
      assert.ok(/^\/images\/[\w-]+\.(?:jpg|png)$/.test(src), page + ' 背景图只能是包里的静态图片：' + src);
      assert.ok(/mode="aspectFill"/.test(tag), page + ' 背景图铺满卡片');
      used[src] = 1;
    });
    // 背景图卡片：图片是第一个子元素，卡片带 bg-host
    (xml.match(/<view [^>]*class="[^"]*\bbg-host\b[^"]*"[^>]*>\s*<image\b[^>]*>/g) || []).forEach((m) => assert.ok(/class="bg-img"/.test(m), page));
    assert.strictEqual((xml.match(/class="bg-img"/g) || []).length, (xml.match(/class="[^"]*\bbg-host\b/g) || []).length, page + ' 每个 bg-host 一张背景图');
  });
  // 主包有 2MB 上限：配图压缩后放进来，单张不超过 80KB
  // 空状态插画和其他静态配图也一起查：文件存在、不超过 80KB
  app.pages.concat(comps).forEach((page) => {
    const xml = fs.readFileSync(path.join(root, page + '.wxml'), 'utf8');
    (xml.match(/<image\b[^>]*\bsrc="\/images\/[^"{]+"/g) || []).forEach((tag) => { used[tag.match(/src="([^"]+)"/)[1]] = 1; }); // 按编号取的（徽章）在 player-card 测试里逐个查
    assert.ok(!/empty-ball/.test(xml), page + ' 空状态用插画 .empty-art');
  });
  Object.keys(used).forEach((src) => {
    const f = path.join(root, src.slice(1));
    assert.ok(fs.existsSync(f), src + ' 不存在');
    assert.ok(fs.statSync(f).size < 80 * 1024, src + ' 太大');
  });
  ['hero-court.jpg', 'hero-2.jpg', 'hero-3.jpg', 'bg-score.jpg', 'bg-mine.jpg', 'bg-event.jpg', 'bg-card.jpg', 'bg-gate.jpg', 'bg-growth.jpg', 'art-ball.png', 'art-net.png', 'art-basket.png', 'art-trophy.png']
    .forEach((f) => assert.ok(used['/images/' + f], f + ' 没用上'));
  const draw = fs.readFileSync(path.join(root, 'pages/draw/draw.wxml'), 'utf8');
  assert.ok(/class="hero-title">活动</.test(draw) && /class="hero-btn"[^>]*bindtap="goNew"/.test(draw), '标题和按钮不放进图片里');
  const css = fs.readFileSync(path.join(root, 'app.wxss'), 'utf8');
  // 图片垫在卡片内容下面：卡片自成一层（z-index: 0），图片 z-index: -1
  assert.ok(/\.bg-host \{ position: relative; overflow: hidden; z-index: 0; \}/.test(css) && /\.bg-img \{ position: absolute;[^}]*z-index: -1; \}/.test(css));
} });

T.push({ name: '所有注册页面和组件：文字输入只有比赛名称、昵称、称呼和搜索；没有手写新球员，不调用新增球员', fn() {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  // 仍然允许文字输入的页面：比赛名称（创建 / 编辑活动，各 1 个）、昵称（资料页）、准入页、搜索球员（首页；选人弹层 member-sheet，只在本机筛选，不保存）
  const allowed = { 'pages/profile/profile': 9, 'pages/gate/gate': 9, 'pages/index/index': 9, 'pages/draw-new/draw-new': 1, 'pages/event-edit/event-edit': 1, 'components/member-sheet/member-sheet': 1 };
  const comps = fs.readdirSync(path.join(root, 'components')).map((c) => `components/${c}/${c}`).filter((c) => fs.existsSync(path.join(root, c + '.wxml')));
  app.pages.concat(comps).forEach((page) => {
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

// 卡片里的列表行（上边框分隔 + 上下内边距）：最后一行的下边距会叠在卡片 30rpx 内边距上，底部比顶部多出一截留白
// （报名名单、成员管理、球员主页的交手 / 近期比赛都出过这个问题）。这类行都要有「:last-child { padding-bottom: 0 }」。
T.push({ name: '界面：卡片里带分隔线的列表行，第一行上面不画线、最后一行不再多出下边距', fn() {
  const files = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) walk(f); else if (e.name.endsWith('.wxss')) files.push(f);
  });
  ['pages', 'components'].forEach((d) => walk(path.join(root, d)));
  const missing = [];
  files.forEach((f) => {
    const css = fs.readFileSync(f, 'utf8');
    const re = /(^|\n)\.([\w-]+)\s*\{([^}]*)\}/g;
    let m;
    while ((m = re.exec(css))) {
      const cls = m[2], body = m[3];
      const esc = cls.replace(/-/g, '\\-');
      const divided = /border-top:\s*1rpx solid/.test(body) || new RegExp('\\.' + esc + ' \\+ \\.' + esc + '\\s*\\{[^}]*border-top:\\s*1rpx solid').test(css);
      if (!divided || !/padding:\s*[1-9]\d*rpx 0\s*[;}]/.test(body + '}')) continue;
      const fix = new RegExp('\\.' + cls + ':last-child\\s*\\{[^}]*padding-bottom:\\s*0');
      if (!fix.test(css)) missing.push(path.relative(root, f) + ' .' + cls);
    }
  });
  assert.deepStrictEqual(missing, []);
  // 「第一行上面不画分隔线」不能用 :first-of-type：小程序里标题、提示文字和行都是 view，它选中的是卡片里第一个 view，
  // 第一行上面照样有线。用「.行 + .行 { border-top }」只在两行之间画线
  const firstOfType = files.filter((f) => /:(first|last)-of-type/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(root, f));
  assert.deepStrictEqual(firstOfType, []);
} });

T.push({ name: '只有活动首页能分享：战绩、排行、球拍、我的这 4 个 tab 页不能转发、不能分享到朋友圈（配置关掉、onLoad 隐藏菜单、没有分享处理函数）', fn() {
  for (const n of ['index', 'rank', 'racket', 'me']) {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, `pages/${n}/${n}.json`), 'utf8'));
    const js = fs.readFileSync(path.join(root, `pages/${n}/${n}.js`), 'utf8');
    assert.strictEqual(cfg.enableShareAppMessage, false, n); assert.strictEqual(cfg.enableShareTimeline, false, n);
    assert.ok(/wx\.hideShareMenu\(/.test(js) && !/onShareAppMessage|onShareTimeline/.test(js), n);
  }
} });

T.push({ name: '读取期间不放「正在读取 / 读取中 / 加载中」之类的占位文字（2026-11-25 用户要求）：先空着，读完直接出现', fn() {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.wxml') ? [path.join(d, e.name)] : []));
  ['pages', 'components'].flatMap((d) => walk(path.join(root, d))).forEach((f) => {
    const xml = fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    assert.ok(!/正在读取|读取中…|加载中…/.test(xml), path.relative(root, f) + ' 里还有读取中的占位文字');
  });
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

T.push({ name: '界面上的名称统一写「LULU 网球」（中间有空格）：页面、组件、utils 和 app.json 里不再出现「LULU网球」', fn() {
  const bad = [];
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((f) => {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p);
    else if (/\.(js|json|wxml|wxss)$/.test(f.name) && fs.readFileSync(p, 'utf8').indexOf('LULU网球') >= 0) bad.push(path.relative(root, p));
  });
  ['pages', 'components', 'utils'].forEach((d) => walk(path.join(root, d)));
  if (fs.readFileSync(path.join(root, 'app.json'), 'utf8').indexOf('LULU网球') >= 0) bad.push('app.json');
  assert.deepStrictEqual(bad, []);
} });
