# jpeg-js 0.4.4

原样复制自 npm 包 jpeg-js@0.4.4（https://github.com/jpeg-js/jpeg-js，BSD-3-Clause，见 LICENSE；decoder.js 来自 pdf.js，Apache-2.0）。
只改了 index.js 的两个相对路径（原来在 lib/ 下）。云函数用它把球员照片缩成 320×320 缩略图（见 index.js 的 makeThumb），
放在这里而不是写进 package.json，是为了测试不用安装依赖、部署也不用多装一个包。不要修改这里的文件。
