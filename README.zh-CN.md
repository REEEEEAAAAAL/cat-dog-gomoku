<h1 align="center">🐱 Cat &amp; Dog Gomoku 🐶</h1>

<p align="center"><a href="README.md">English</a> | 简体中文</p>

<p align="center"><a href="https://cat-and-dog-gomoku-d4c9e5cfbbfc0-1513741929.tcloudbaseapp.com/gomoku/">在线游玩</a> | <a href="#截图">截图</a> | <a href="https://github.com/REEEEEAAAAAL/cat-dog-gomoku">源代码</a></p>

一个为两个人设计的在线五子棋小游戏。选择猫猫或狗狗，分享邀请，在 15×15 棋盘上一起下一局。支持手机、平板与电脑，无需注册账号，游戏界面为简体中文。

线上游戏使用有有效期与额度限制的 CloudBase 预付费环境，默认域名首次访问可能显示确认页面。

## 功能

- 支持多个私人房间同时存在、同时对局；每个房间仅限两名玩家，棋局状态独立、互不影响。通过邀请链接或十位房间码加入，房主批准、双方准备后开局。
- 连成五颗或更多棋子获胜。先预览位置，再确认落子，减少误触；支持鼠标、触摸与键盘。
- 服务端管理每回合 60 秒计时，支持断线暂停与刷新恢复；断线五分钟仍未恢复时，本局中止，不判胜负。
- 每人每局最多成功悔棋两次，双方先确认撤销范围，再由对方批准。
- 开局后可随时认输，二次确认后由服务端保存结果，无需对方同意。
- 结束后可在原棋盘回顾当前棋局：拖动进度条，或使用开局、上一步、下一步、终局四个按钮。支持切换落子编号，当前手高亮并显示落子角色与颜色。回放仅影响本地显示，双方互不影响；不包含已悔棋的落子，也不永久保存历史棋谱。
- 双方同意后换色再来一局，另有八种固定表情、本地音效和可记住设置的静音开关。每局正式开始时播放短的开局音效提示，恢复页面或过期的开局事件保持静默。
- 当前回合最后 10 秒，双方都会根据各自显示的倒计时听到逐渐加快的警示音。警示遵循静音设置和浏览器音频激活机制，在暂停、重置、切换回合或对局结束时停止；恢复后只提示当前剩余时间，不补播错过的声音。
- 仅入座玩家可使用文字聊天，支持未读提示与失败重试。单条最多 100 字，最近 50 条在刷新和同房间再来一局后保留。

不提供匹配、观战或人机对战。邀请用于申请加入，不是玩家身份凭证。恢复对局需要原浏览器会话，其他浏览器不能接管身份。主动离开会为双方关闭房间，房间在 24 小时后过期。

## 核心设计

前端使用严格类型的 TypeScript、Vite、原生 DOM/SVG 与 Web Audio。CloudBase 提供匿名会话、静态托管和 PostgreSQL HTTP RPC 后端。Vitest、PGlite 与 Playwright 分别覆盖规则、SQL 行为和浏览器流程。

- **服务端裁决。** 每次 `gomoku_command` 调用锁定房间行，校验玩家、对局、版本、回合和位置，持久化后才返回确认。浏览器不能直接读写游戏表，预览棋子只有收到服务端确认后才成为正式落子。
- **重试不重复落子。** 操作 ID 与已保存的回执避免丢失响应后重复执行。结果未知时，页面保留待确认操作，供重试与核对。刷新可恢复会话，同一浏览器的新标签页会接管原席位。
- **轮询简化部署。** 活跃的前台页面通常每五秒轮询一次；本人已准备、等待新局开始时临时约每秒轮询一次，开局后恢复通常间隔。对方更新可能延迟一个轮询周期。后台页面停止轮询，候场和终局页面两分钟无操作后也会休息。15 秒心跳租约允许短暂网络波动，过期后暂停对局。
- **恢复后继续原计时。** PostgreSQL 保存截止时间与剩余时间，双方重连并确认同步后才能继续。超时在下一次 RPC 时结算，双方都离线时也遵循这一规则，无需后台定时任务。
- **聊天独立同步。** 聊天使用独立请求和消息编号，不影响游戏操作、计时与重试。面板活跃时补充常规轮询，页面后台停止轮询。

当前维护的部署使用 CloudBase PostgreSQL 与 HTTP 轮询，没有启用 PostgreSQL Realtime。

## 文字聊天

文字聊天已上线，双方入座后即可使用。手机点击本方人物卡内的“聊天”，桌面点击表情栏下方的“聊天”。Enter 发送，Shift+Enter 换行，触屏可点击“发送”；输入法选字不会误发送。

未读数量和浅绿色按钮提示新消息。浏览旧消息或页面处于后台时保留未读，最新消息实际可见后才清除。停留在底部时自动跟随新消息，浏览历史时保持阅读位置；点击悬浮向下圆形按钮可回到最新消息，发送自己的消息也会自动滚到底部。

每条最多 100 个 Unicode 码点；服务端保留最近 50 条，同房间刷新、再来一局均可恢复。每人每两秒最多一条、每分钟最多十条。发送结果未确认时可重试，不会重复发送。房间过期后拒绝访问，删除房间时一并清理聊天数据。不提供后台推送通知。

## 本地运行

需要 Node.js 22 或更新版本及 npm，开发已在 Node.js 24 上验证。

```sh
npm ci
```

无需云凭据即可运行完整本地对局，数据库为内存中的 PostgreSQL 兼容实例：

```sh
node node_modules/vite/bin/vite.js --config game.test.config.ts --configLoader runner --host 127.0.0.1 --port 18790
```

在两个独立浏览器配置或普通窗口与无痕窗口中打开 `http://127.0.0.1:18790`，创建房间、分享邀请、批准对方并准备。本地适配器绕过 CloudBase 鉴权，停止服务即丢失数据，不能用于线上部署。

如需连接自己的 CloudBase 后端，将 `.env.example` 复制为 `.env.local`，填写 `VITE_CLOUDBASE_ENV_ID` 与 `VITE_CLOUDBASE_PUBLISHABLE_KEY`，然后运行：

```sh
npm run dev
```

后端需要 PostgreSQL 环境、匿名登录、允许访问的网页来源，以及下述数据库迁移。当前客户端配置上海地域。Vite 变量会写入浏览器构建产物，只能使用前端公开密钥，不能填写管理凭据。

布局依据可用宽高自适应：电脑和宽横屏将双方人物卡、倒计时放在棋盘右侧，平板竖屏与中等宽度窗口将双卡并排放在棋盘上方。低高度窗口精简页头、收紧间距，优先保留棋盘空间，拥挤的状态区可滚动。回放与可折叠规则位于棋盘下方；宽屏人物卡和操作区在房间状态切换时保持稳定，空间足够时显示插画。手机保留触控选点和上下人物卡，确认落子／申请悔棋在右，取消／认输在左；回放导航保持同排，邀请按钮显示复制成功时尺寸不变。

聊天使用可收起的浮层，不压缩棋盘；手机入口位于本方人物卡内，大屏入口靠近游戏操作区。

## 测试与构建

```sh
npm run typecheck
npm run lint
npm test
npm run build:cloudbase
```

单元测试在隔离的 PGlite 实例中执行真实 SQL 迁移，并控制服务端时间；同时覆盖协议、规则、音效事件、HTTP 和聊天，不需要云凭据。

浏览器测试默认使用已安装的 Microsoft Edge；设置 `GOMOKU_BROWSER=chrome` 可使用已安装的 Google Chrome。在 PowerShell 中运行本地 SQL 对局测试：

```powershell
$env:GOMOKU_LOCAL_SQL = '1'
npm run test:game-page
Remove-Item Env:GOMOKU_LOCAL_SQL
```

macOS/Linux 可使用 `GOMOKU_LOCAL_SQL=1 GOMOKU_BROWSER=chrome npm run test:game-page`。本地游戏测试阻断 CloudBase 请求，覆盖双人对局、丢失回执、刷新、悔棋、邀请、音效与响应式操作，不验证云端鉴权或实体手机。截图和失败产物写入已忽略的 `test-results/`。`tests/game-e2e/layout.spec.ts` 使用受控快照验证视口、状态切换、按钮可见性和布局稳定性；这些快照检查不替代双端 SQL 回归或真实设备、浏览器缩放验收。

线上测试需显式启用，会在目标环境创建房间和匿名会话。将 `GOMOKU_URL` 设为完整的 `/gomoku/` 地址，或设置 `GOMOKU_LIVE_LOCAL=1`，用构建后的本地预览连接所配置的后端。运行前先清除 `GOMOKU_LOCAL_SQL`。`GOMOKU_LONG_TEST=1` 额外启用五分钟离线用例。`npm run test:cloudbase-page` 检查独立诊断页，其公网测试需要 `CLOUDBASE_DIAGNOSTIC_URL`。

脚本直接调用 Node 入口，以兼容含 `&` 的 Windows 项目路径。CloudBase SDK 目前会触发 Vite 的大包提示，但不影响构建成功。

## 部署

使用自己的 CloudBase PostgreSQL 环境及已登录的 CLI。替换 `cloudbaserc.json` 中的项目环境 ID，配置匿名登录与允许的网页来源，构建前填写 `.env.local`。执行变更前核对目标及计费设置。

```sh
npm run build:cloudbase
tcb db pg migration list --env-id YOUR_ENV_ID
tcb db pg migration up --dry-run --env-id YOUR_ENV_ID
tcb db pg migration up --env-id YOUR_ENV_ID --yes
tcb db pg migration list --env-id YOUR_ENV_ID
tcb hosting deploy ./dist/cloudbase/game gomoku --env-id YOUR_ENV_ID --safe --verify
```

按顺序应用 `cloudbase/migrations/` 中的文件，不修改已应用的迁移。其中包含独立诊断结构与游戏结构。构建将游戏放入 `dist/cloudbase/game/`，诊断页放入 `dist/cloudbase/site/`，SQL 放入 `dist/cloudbase/database/`。只上传所需前端目录，诊断页可单独部署至 `gomoku-diag/`。

部署依赖数据库变更的客户端前，先核对迁移历史，仅应用待执行的迁移。

邀请使用 URL 片段，无需额外的服务端路由配置。替换前保存上一版前端构建，保留旧哈希资源；需要回退时避免使用 `--prune`。恢复保存的前端构建即可回退网页，数据库恢复需单独评估，不删除迁移历史。

## 目录

| 路径 | 用途 |
| --- | --- |
| `src/game/`、`game/` | 当前游戏界面、协议、会话和静态资源 |
| `cloudbase/migrations/` | 有序 PostgreSQL 迁移与权威游戏 RPC |
| `tests/` | 单元、SQL、浏览器测试及本地 SQL 适配器 |
| `diagnostics/cloudbase/` | 独立连接与计时诊断，以及共享 HTTP 工具 |

`game.config.ts` 和 `cloudbase-probe.config.ts` 分别构建游戏与诊断页，`build:cloudbase` 统一打包两个前端及迁移文件。

## 截图

来自线上正式界面的真实截图，由两个独立匿名玩家完成对局。平板与手机尺寸使用浏览器模拟视口，手机图为全页截图。

电脑（1280×844）、平板竖屏（768×1024）与手机（390×844）。

<img src="docs/screenshots/desktop.png" alt="电脑端对局，人物卡、倒计时和操作区位于棋盘右侧" width="700" />

<p><img src="docs/screenshots/tablet.png" alt="平板竖屏对局，双方人物卡并排位于棋盘上方" width="360" /> <img src="docs/screenshots/mobile.png" alt="390 像素手机视口下的全页对局" width="260" /></p>

低高度窗口的紧凑布局（1024×675）。

<img src="docs/screenshots/compact.png" alt="低高度紧凑布局，精简页头，棋盘与玩家操作区并排" width="700" />

26 手棋局回放至第 24 手，展示棋子编号、当前手高亮、进度条及四个回放控制按钮。

<img src="docs/screenshots/desktop-replay.png" alt="电脑端第 24／26 手回放，包含棋子编号与回放控制按钮" width="700" />

## 许可

项目代码采用 [MIT 许可证](LICENSE)。内置录音使用 CC0，来源与处理方式见 [sounds/LICENSE.txt](game/public/sounds/LICENSE.txt)。内置 Outfit 字体保留其 [SIL Open Font License](game/public/fonts/OFL-Outfit.txt)。
