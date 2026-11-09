#!/usr/bin/env node
// 运行全部测试：node tests/run.js（不需要安装依赖；云函数用 tests/mock-cloud.js 的内存数据库）
// 也会检查 utils/ 和 cloudfunctions/tennis/shared/ 里的共享文件是否一致
const fs = require('fs');
const path = require('path');

(async () => {
  let pass = 0, fail = 0;
  const root = path.resolve(__dirname, '..');
  for (const f of ['rules', 'draw', 'event', 'official']) {
    const a = fs.readFileSync(path.join(root, 'utils', f + '.js'), 'utf8');
    const b = fs.readFileSync(path.join(root, 'cloudfunctions/tennis/shared', f + '.js'), 'utf8');
    if (a === b) pass++; else { fail++; console.log(`✗ 共享文件不一致：utils/${f}.js，请运行 scripts/sync-shared.sh`); }
  }
  const files = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.js')).sort();
  for (const f of files) {
    console.log(`\n${f}`);
    for (const t of require(path.join(__dirname, f))) {
      const err = console.error;
      console.error = () => {}; // 云函数里的 console.error（预期内的失败日志）不打印
      try { await t.fn(); pass++; console.log(`  ✓ ${t.name}`); }
      catch (e) { fail++; console.log(`  ✗ ${t.name}\n    ${(e && e.stack) || e}`); }
      finally { console.error = err; }
    }
  }
  console.log(`\n${pass} 通过，${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
