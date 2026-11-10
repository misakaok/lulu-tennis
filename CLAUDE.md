# CLAUDE.md · LULU网球（微信小程序 + 云开发）

和用户交流用中文。项目进度、权限和部署说明见 `docs/项目进度.md`。

## 必须遵守
- **改了 `utils/rules.js` / `utils/draw.js` / `utils/event.js` / `utils/official.js` 后，运行 `scripts/sync-shared.sh`**：它们会被复制进 `cloudfunctions/tennis/shared/`，供云函数使用。之后要重新部署云函数 `tennis`。
- **身份与权限**：只用云端获取的 openid（`cloud.getWXContext().OPENID`），不用昵称，也不信任客户端传来的身份。
- **数据访问**：小程序端不能调用 `wx.cloud.database()`，读写一律经 `utils/db.js` → `utils/gateway.js` → 云函数的 `data` 操作。
  - 新增集合一律设为「仅管理端可读写」。
  - 需要被前端读写的集合，要加进网关的白名单（`GW_READ` / `GW_WRITE` / `GW_OPS`）。
  - 网关的写权限只剩两项：`matches` 只能新增日常比赛；`players` 只能新增「只有名字」的球员。报名（`signUp`/`cancelSignup`）、本人资料（`saveProfile`）、活动（`createDraw`/`generateDraw`/`updateDrawInfo`/`removeDraw`）、撤销（`revokeMatch`）都走专门的云函数操作，由服务端校验字段。不要再把这些集合的写权限开放给网关。
  - 活动删除是软删除（`deleted: true`）：网关不返回已删除的活动，`loadDraw`/`loadFixture` 会拒绝操作，已录比分保留在战绩里。
- **管理员的活动权限**：管理员可以编辑任何活动的信息（名称、时间、场地、联系人）和删除活动（必须填原因），都会留档；生成签表、录分、裁定改分、处理退赛、单场安排（`setFixtureSlot`）仍然只有发起人能做。不要再扩大管理员的活动权限，也不要让管理员绕过 `manageDraw`。
- **成员资格**：云函数的新操作默认要求正式成员，不要随意加进 `PUBLIC`。管理员只来自环境变量 `ADMIN_OPENIDS`，不要做「第一个注册的人自动成为管理员」之类的逻辑。
- **系统回调**：`wxa_media_check` 推送走 `exports.main` 开头的专门分支，不经过成员校验；带 `userInfo` 的调用不能冒充推送。
- **可信写入**：云函数写入的活动记录没有 `_openid`。`recordedBy`、`rulingSig` 只在记录没有 `_openid` 时才可信。
- **统计口径**：只有一套正式战绩（`utils/official.js` + `verified`）。不要新增第二套统计，弃权、退赛、轮空用 `isNormal` 排除在统计之外。
- **统计身份**：场数、胜率、排名、等级分按「统计身份」累计（`utils/ident.js` 的 `aKeys`/`bKeys`）：有账号用用户 ID，旧记录名字唯一对应账号时算到该账号，否则为 `'n:' + 名字`。查统计时有用户 ID 就用 ID（`stats.map[uid]`、`ratings.players[uid]`），只有名字时用 `stats.keyOf(名字)` 或 `R.levelOf / R.ratingOf`，不要直接按名字取。
- **一次性读取**：`utils/db.js` 读战绩和球员优先用云函数 `dataset`（1 次调用）；数据超过大小限制或云函数是旧版本时，自动退回分页读取。两种方式结果必须一致（`tests/client.test.js`）。`dataset` 带内容指纹（`hash` / `have`），内容没变只回 `same`；球员资料只下发 `buildPlayers` 用到的字段，前端要用新字段时记得加进 `DATASET_PLAYER_FIELDS`。活动详情页用 `drawDetail` 一次取齐，旧版云函数时退回分开读取。
- **不做的东西**：订阅消息、头像本地缓存（要配 downloadFile 合法域名）已经移除，不要再加回来；活动信息不填街道地址，只有场地名称和地图定位。提醒只做小程序内的「待办」。
- **单场安排**：某一场的日期、时间、场地存在 `draws.slots[场次 key]`，只由 `setFixtureSlot` 写入（发起人）；`E.scheduleOf` 会把它带在每一场的 `slot` / `slotText` 上，没排的场次沿用活动的日期、时间和场地。重新生成签表会清空。
- **赛季和生涯成就**：赛季 = 比赛日期的自然年（`utils/season.js`），只是在同一套正式战绩上按日期筛选；等级分不分赛季。生涯成就（`utils/career.js`）全部由正式战绩实时计算，不存数据库。冠军按「活动决赛的比赛记录」认定。两者都不是第二套统计，场数、胜负必须和 `computeRank` 一致（`tests/career.test.js`）。
- **关注**：`follows` 集合只经 `setFollow` / `followInfo` 读写。只公开人数，谁关注了谁只有本人看得到；关注不带任何权限。
- **活动比分**：只能经 `recordEventMatch` / `resolveFixture` 写入，每场一条记录。会推翻后续已录分场次的改动，必须由发起人确认影响并填写原因。
- **前端缓存**：`utils/db.js` 的列表读取经 `utils/memo.js` 在内存里缓存 60 秒，写操作成功后由 `utils/cloud.js` 自动作废。整理后的结果（正式战绩、战绩列表、球员列表）也在这层缓存里，本机存储只在重新整理时写；`memo.raw` 不复制，只给 `utils/db.js` 内部用。新增**只读**的云函数操作时，要加进 `utils/cloud.js` 的 `READ_ONLY`（否则每次调用都会清空缓存）；写操作不用加。只读操作要缓存结果时用 `cloud.cached(action, data)`（自己的任何写操作和下拉刷新都会作废，别人的操作最长晚 60 秒看到），不要用在需要实时的地方。
- **列表类接口**：要逐场计算比赛状态时，先调用 `prefetch()` 一次查齐数据，再调用 `matchState(..., cache)`。不要在循环里单独查数据库。写入流程不要传预取过的 cache，避免读到旧数据。
- **申请处理**：改分、退赛等申请用 `claim()`（原子领取）防重复和防并发，并保留申请人、处理人、原因和时间。
- **文件**：数据库只存 fileID，永远不保存临时链接。图片链接由云函数校验资格后发放，有效期要短（目前 30 分钟）。
- **内容安全**：用户文字（评价、简介）必须通过 `msgSecCheck`，照片必须通过 `mediaCheckAsync` 后才能公开。检测失败、超时、接口无权限时，一律不保存或不公开。
- **上传前压缩**：照片上传前先压缩（`utils/compress.js`）。压缩失败时提示重试，不上传原图。
- **文档**：不要在文档或代码里写入密码、密钥、管理员 openid 或临时图片链接。

## 测试
- 运行 `node tests/run.js`：不需要安装依赖，会在内存数据库里跑真实的云函数代码（`tests/mock-cloud.js`），并检查共享文件是否已同步。
- 改云函数的权限、业务规则时，在 `tests/cloud.test.js` 里补对应的用例。
- 提交前钩子：`git config core.hooksPath .githooks`。启用后，测试不通过就不能提交。

## 界面约定
- 主题色为淡紫 `#A3A3CB`；浅色背景上的紫色文字用 `#6E6EA3`；渐变为 `#A3A3CB → #8484B6`。
- 项目开启了新版组件样式（`style: v2`），按钮自带内边距和固定宽度。需要居中时用 `padding: 0` + flex 居中（参考 `button.share`）。
- 不要用与 `app.wxss` 全局类同名的修饰类（例如 `.empty`），否则会被全局样式覆盖。
