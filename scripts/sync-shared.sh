#!/bin/sh
# 把云函数也要用的纯逻辑文件复制进 cloudfunctions/tennis/shared/（云函数上传时只包含自己的目录）
# 改了下面任何一个 utils 文件后都要运行一次，再重新部署云函数 tennis
cd "$(dirname "$0")/.." || exit 1
for f in rules draw event official; do
  cp "utils/$f.js" "cloudfunctions/tennis/shared/$f.js"
done
echo "已同步：utils/{rules,draw,event,official}.js → cloudfunctions/tennis/shared/"
