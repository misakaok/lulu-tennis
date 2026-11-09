# CLAUDE.md · LULU网球（微信小程序 + 云开发）

和用户交流用中文。项目进度、权限和部署说明见 `docs/项目进度.md`。

## 必须遵守
- **改了 `utils/rules.js` / `utils/draw.js` / `utils/event.js` / `utils/official.js` 后，运行 `scripts/sync-shared.sh`**：它们会被复制进 `cloudfunctions/tennis/shared/`，供云函数使用。之后要重新部署云函数 `tennis`。
- **身份与权限**：只用云端获取的 openid（`cloud.getWXContext().OPENID`），不用昵称，也不信任客户端传来的身份。
- **数据访问**：小程序端不能调用 `wx.cloud.database()`，读写一律经 `utils/db.js` → `utils/gateway.js` → 云函数的 `data` 操作。
  - 新增集合一律设为「仅管理端可读写」。
  - 需要被前端读写的集合，要加进网关的白名单（`GW_READ` / `GW_WRITE`）。
- **成员资格**：云函数的新操作默认要求正式成员，不要随意加进 `PUBLIC`。管理员只来自环境变量 `ADMIN_OPENIDS`，不要做「第一个注册的人自动成为管理员」之类的逻辑。
- **系统回调**：`wxa_media_check` 推送走 `exports.main` 开头的专门分支，不经过成员校验；带 `userInfo` 的调用不能冒充推送。
- **可信写入**：云函数写入的赛事记录没有 `_openid`。`recordedBy`、`rulingSig` 只在记录没有 `_openid` 时才可信。
- **统计口径**：只有一套正式战绩（`utils/official.js` + `verified`）。不要新增第二套统计，弃权、退赛、轮空用 `isNormal` 排除在统计之外。
- **赛事比分**：只能经 `recordEventMatch` / `resolveFixture` 写入，每场一条记录。会推翻后续已录分场次的改动，必须由发起人确认影响并填写原因。
- **申请处理**：改分、退赛等申请用 `claim()`（原子领取）防重复和防并发，并保留申请人、处理人、原因和时间。
- **文件**：数据库只存 fileID，永远不保存临时链接。图片链接由云函数校验资格后发放，有效期要短（目前 30 分钟）。
- **内容安全**：用户文字（评价、简介）必须通过 `msgSecCheck`，照片必须通过 `mediaCheckAsync` 后才能公开。检测失败、超时、接口无权限时，一律不保存或不公开。
- **上传前压缩**：照片上传前先压缩（`utils/compress.js`）。压缩失败时提示重试，不上传原图。
- **文档**：不要在文档或代码里写入密码、密钥、管理员 openid 或临时图片链接。

## 界面约定
- 主题色为淡紫 `#A3A3CB`；浅色背景上的紫色文字用 `#6E6EA3`；渐变为 `#A3A3CB → #8484B6`。
- 项目开启了新版组件样式（`style: v2`），按钮自带内边距和固定宽度。需要居中时用 `padding: 0` + flex 居中（参考 `button.share`）。
- 不要用与 `app.wxss` 全局类同名的修饰类（例如 `.empty`），否则会被全局样式覆盖。
