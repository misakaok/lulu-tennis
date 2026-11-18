// 从 app.json 实际注册的页面及其组件检查入口，避免停用的社交内容重新进入发布包的页面。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const T = [];

T.push({ name: '所有注册页面和组件：没有相册、评价、简介、关注、联系人入口；照片只能在资料页上传，只经头像组件显示', fn() {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  const UPLOAD = { 'pages/profile/profile': 1 };                         // 唯一的照片上传入口（经 utils/photo.js → 云函数 setPhoto 检测）
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
    if (!UPLOAD[rel]) assert.ok(!/\bP\.(?:pick|upload)\s*\(|['"]setPhoto['"]/.test(code), base + ' 不能上传照片');
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

T.push({ name: '所有注册页面和组件：界面文字不用赛事用语（小组赛、淘汰赛、签表、种子、抽签、赛程、决赛、晋级等）', fn() {
  const app = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'));
  const banned = /小组赛|淘汰赛|签表|种子|抽签|赛程|出线|决赛|晋级|赛制|参赛|赛事/; // 「比赛名称」按用户要求用在创建 / 编辑活动的名称栏
  const seen = new Set();
  const inspect = (base) => {
    if (seen.has(base)) return;
    seen.add(base);
    const xml = fs.readFileSync(base + '.wxml', 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    const hit = xml.match(banned);
    assert.ok(!hit, base + '.wxml：' + (hit && hit[0]));
    // 脚本里只看字符串（提示、弹窗文字），不看注释
    const code = fs.readFileSync(base + '.js', 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const bad = code.match(banned);
    assert.ok(!bad, base + '.js：' + (bad && bad[0]));
    const config = JSON.parse(fs.readFileSync(base + '.json', 'utf8'));
    assert.ok(!banned.test(config.navigationBarTitleText || ''), base + '.json');
    Object.values(config.usingComponents || {}).forEach((target) => {
      inspect(target.startsWith('/') ? path.join(root, target.slice(1)) : path.resolve(path.dirname(base), target));
    });
  };
  app.pages.forEach((page) => inspect(path.join(root, page)));
} });

module.exports = T;
