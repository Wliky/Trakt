# AGENTS.md — 接手前先读这个

## 这是什么

Trakt 数据管理面板（自托管 Web app）。零依赖 Node 服务，可本地跑 / Docker / Cloudflare Workers + D1。

- 线上：https://trakt.wliky.workers.dev
- 仓库：https://github.com/Wliky/trakt

## 技术栈与目录

```
server.js            Node 适配层（node:http → Web Request）+ 静态资源
worker.js            Cloudflare Workers 入口（D1 + Assets）
lib/core.js          全部后端逻辑：路由 / 登录链路 / 白名单透传 / 导出 / 写操作
lib/art.js           海报与影视信息（TMDB 优先，Trakt 兜底，缓存 30 天）
lib/dav.js           WebDAV 客户端（PROPFIND/MKCOL/PUT/GET/DELETE，零依赖）
lib/store-node.js    本地存储（data/db.json，原子写）
lib/store-d1.js      D1 存储（表 kv）
public/              前端，无构建：index.html + ui.js（公共零件）+ app.js（页面与路由）+ styles.css
schema.sql           D1 建表
scripts/             deploy-cf.mjs（一键部署）、ensure-d1.mjs（确保库存在）
```

## 本地跑

```bash
cp .env.example .env    # 可选；server.js 启动时自动加载 .env（Node 20.12+）
node server.js          # http://localhost:8787，零依赖，不用 npm install
```

优先级 **真实环境变量 > `.env` > 默认值**（`process.loadEnvFile` 不覆盖已有变量）；`ENV_FILE=none` 关闭自动加载。启动日志会打印「配置来源 / COOKIE_SECURE / TMDB 是否已配」，排查配置先看这三行。

## 部署

- **GitHub Actions**：push main 即部署（`.github/workflows/deploy.yml`，官方 wrangler-action@v3）
- 部署报 `Trigger configuration for "trakt" was only partially updated` 时先别慌：**脚本其实已经上线**，失败的只是 cron 触发器。免费账户的 Cron Triggers 上限是 **5 个（全账户所有 Worker 合计）**，用满了就会这样——去别的 Worker 删掉多余的 cron 再重跑（判据：`/ui.js`、`/api/backup` 能正常响应就说明代码已生效）
- **本地**：`node scripts/deploy-cf.mjs`（需 `npx wrangler login` 或 CLOUDFLARE_API_TOKEN/ACCOUNT_ID）

## 登录方式（别改成 OAuth）

Trakt 已无账号密码登录。本项目复刻**Trakt 网页版**链路：`auth.trakt.tv/auth/magic` 邮箱验证码 → 会话 cookie → OIDC authorize(PKCE) → `/oauth/token` 换令牌，数据走 `apiz.trakt.tv`。用的是网页版公开 client_id，所以**不需要注册 OAuth 应用、不占应用名额**。会话 180 天 + `x-tm-device` 设备令牌（cookie 丢失免验证码）。

## 六个必须知道的坑

1. **不要让浏览器直连 `media.trakt.tv` 海报**：本机会被 ORB 拦（`ERR_BLOCKED_BY_ORB`），表现为全裂图。`/api/poster` 必须服务端代取字节同源输出；降级的 302 要用 `no-store`，否则浏览器把重定向缓存 30 天。
2. **剧集写入用 episode 自己的 trakt id**，海报/元数据用所属剧 id —— 前端 `data-act`（写操作）与 `data-ids`（展示）是分开的，别合并。
3. **Trakt 出站必须带 User-Agent**：不带会被 Cloudflare 拦成 403 HTML。
4. **Trakt 不再解析前缀式 id**（`tmdb-603`、`imdb-tt…` 都是 404），只认 trakt 数字 id 或 slug。
5. **新版 wrangler 移除了 `d1 create --json`**（`d1 list --json` 还在）；Node 22 不能直接 spawn `.cmd`，Windows 下要 `shell: true`。
6. **Workers 侧不能 import 任何 `node:` 模块**：存储是 store-d1.js / store-node.js 两份实现，改一边要同步另一边。

## 前端信息架构（改导航先看这里）

导航只有 6 项，顺序固定：**概览 / 搜索 / 追剧 / 记录 / 片单 / 设置**（概览排最前且是默认页——`route()` 的兜底与登录成功后都落 `#/dashboard`，搜索紧跟在概览下方；改顺序只动 `NAV` 数组，侧边栏和移动端底栏都按它渲染）。页面骨架只有一套：`head(title, sub, actions)` 画 `<h1>` + 副标题 + 右侧工具条，各 `PAGES.xxx` 自己调它，再往 `#view`（需要二次渲染的页再套一层 `#page-body`）写内容——**没有 `SECTIONS` / `sectionPage()` 这类分节包装函数**，也不要再加回来。

- `追剧`：只有播出日历，不拆 tab（`#/tracking?m=2026-10&d=2026-10-31`）：左侧整月日历、右侧当天剧集；当天无排期时右侧显示空态提示。`/api/calendar` 的条目带 `show.tmdb`，海报和全局一样走 TMDB 优先、Trakt 兜底
- `记录`：`#/records?tab=history|ratings`，`PAGES.records` 只做分发，`PAGES.history` / `PAGES.ratings` 各自画 `head()`。右上角是 `.seg` 类型筛选 + 各自独立的 `.seg` 导出下拉、`.seg`「评分管理」/「返回记录」（**每个动作按钮单独一个分段外框，不要并进同一个 seg**），动作按钮一律 `.seg-btn`（与分段按钮同一规格），别退回成 `.btn` 边框按钮；导出统一走 `exportMenu(id)` + `mountExportMenu(id, urlFor)`（记录 / 评分管理 / 片单共用，`#lib-export-wrap` 整块显隐）
- `片单`：待看 / 收藏在**表格工具条内**的 `.seg#lib-seg` 切换（`#/library?tab=favorites` 兼容老链接），表格上方**不再有大标题块**（只有 `head()` 的页面标题），条目数走工具条里的 `#lib-count`；下面是自定义列表卡片，展开后条目仍是海报网格

旧的独立页 hash 由 `LEGACY_ROUTES` 重定向（`#/progress`、`#/calendar` → `#/tracking`，`#/history`/`#/ratings`/`#/lists`/`#/favorites`/`#/stats` 各自归位），「统计」整页已并入概览，不要再单独加回来。

概览的数据源是服务端聚合端点 `/api/stats?period=month|year&month=YYYY-MM&tz=480`：服务端分页拉 `/sync/history`（最多 50 页 / 5000 条，超出标 `truncated`）并按浏览器时区折成「天 + 24 小时分布 + 类型权重」，评分与最近收藏同批返回，缓存 300 秒；写操作 bump `statsver:{user}` 让旧缓存立即失效。前端不再自己翻页累加。播出日历走 `/api/calendar?month=YYYY-MM&tz=480`（同样按浏览器时区分组 + 10 分钟缓存），前端不直接拼 `/calendars/my/shows` 的原始结构。

**拉排期必须用 `/calendars/my/shows/{start}/{days}`**：`{start}/{end}` 形态在 Trakt 上会截断，只回开头几天（实测 2026-10 只到 8 号、29 条），表现就是「日历到 9 号之后没数据」。

**语言（阶段 9）**：只有真源一个——服务端 `cfg:tmdb_lang`（设置页 `tmdbLang`，env `TMDB_LANG` 可覆盖），`/api/settings` 下发、`localStorage.tm_lang` 只是本机镜像（给登录页兜底），**不要在前端单独切**。界面文案走 `public/i18n.js` 的运行时字典，中文是源语言，缺条目就原样输出——新增界面文案若要英文，必须在 `EN` 里补同一条，**含 `…` `/` `、` 全角标点的键一定要加引号**，否则整个模块语法错误、i18n 全挂。

**影视名不查字典**（TMDB/Trakt 返回的名字按语言取，走服务端 `/api/meta/batch`）：任何新渲染的片名/剧名/集名都要挂 `locAttrs(type, ids, season, number)` 或 `locSubAttrs()`，并在写完 `innerHTML` 之后调 `localize(root)`；表格、概览里的动态卡（继续观看 `ovContinueCard`、观影感受 `ovFeelCard`）、弹窗搜索结果都算。漏了就是「界面中文、片名英文」——这类数据字典里永远查不到，加词条没用。

整季批量写 `/api/season/watch`（服务端读整季后分批写，`when=released` 用每集 `first_aired`）；续播点走 `/sync/playback`，详情页复用 `progress/watched` 的 `next_episode`。

**沉浸背景（阶段 10–11）**：全站封面层 `#backdrop` 由 `shell()` 注入，来源在设置里选（`tm_bg={source,dim}`，`off|recent|favorites|watchlist|rated`，45 秒轮播、双图层交叉淡入）；候选走 `/api/backdrops?source=`（缓存 10 分钟），图片必须继续走 `/api/poster?...&art=backdrop`，**不要让浏览器直连 image.tmdb.org**。

**视图三种形态**（`tm_view` 列表/网格偏好已删除，不要再加回来）：

- 搜索页：与片单同构——工具条（`.seg#s-type` + `.episode-search` 搜索框 `#s-q` + 右侧 `#s-hint` 与「搜索」按钮）+ 结果表格（`.episode-table.lib-table.search-table`，封面 / 标题 / 评分 / 操作，复用 `.lib-art` / `.lib-name` / `.lib-sub` / `.lib-num` / `.lib-ops`）。**搜索不进 URL、不落 localStorage**：刷新即回到空态，没有「最近搜索」和示例词，翻页只改内存里的 `state.search.page`（`/` 快捷键仍在）
- 片单：待看/收藏是**表格**，复用详情页 `.episode-table` 骨架（`#lib-body`，列：勾选 / 封面 / 标题+副标题 / 评分 / 加入时间 / 操作），`.lib-table{min-width:660px}`（≤720px 隐藏日期列、620px；≤560px 再隐藏评分列并放开 min-width，保证手机竖屏不横向滚），封面 `.lib-art` 必须 `display:block` 才能撑出 2:3，封面列宽一律走 `.lib-table th.lib-cover-cell`（**不要改回 nth-child**，搜索表封面在第 1 列、片单在第 2 列）；全选用 `.lib-all-check`（工具条一个、表头左上角一个，**别用重复 id**，否则只有 DOM 里靠前的那个生效），选中后出 `.episode-selection-bar`
- 海报网格：自定义列表条目与概览动态卡共用 `mediaCard()` 与同一条 `.media-grid` 栅格（搜索已改成表格，不再走这套）（`minmax(156px,1fr)`，≤560px 118px），卡片是「上封面（类型角标）+ 下标题/副标题/操作」，标题带 `data-loc-*`；新增卡片统一用 `mediaCard()`，不要另写一套

**控件补充约定**：页头 / 工具条里的动作按钮（导出、评分管理、返回）一律 `.seg-btn`（与 `.seg > button` 同一规格），每个动作单独一个 `.seg` 外框，不要并进同一组，也不要退回 `.btn` 边框按钮；搜索框（`#s-q`、`#lib-q` 等 `input[type=search]`）的原生 `×` 必须重画——走 `::-webkit-search-cancel-button` + `--input-clear` mask（颜色跟随 `currentColor`），否则深色输入框里是个看不见的黑叉。

「继续观看」在**概览**（`ovContinueCard()`，`/sync/playback` 与 `/api/stats` 同批 `Promise.all` 拉，空数组就渲染空态），每行「标题 / 分集名 / SxxExx · 时长 · 多久前 / 进度条」，标题和分集名都要挂 `data-loc-*`。设计规范见 `design-system/trakt-manager/MASTER.md`（§6.1 沉浸背景）。

## 备份与恢复（阶段 6）

- 格式固定 `format: trakt-manager-backup` / `version: 1`，改结构必须升 version 并同步 `validateBackup()`，否则旧备份会被拒。
- **备份绝不包含凭据**：token / cookie / TMDB key / WebDAV 密码都不进 JSON，测试逐项断言。
- 恢复是「默认 dry-run + 显式 `confirm:true`」；`/api/restore` 先拉当前数据算差异再写，**Trakt 无事务，没有回滚**，失败只回 `partial:true` + 逐段 errors，重跑幂等（已存在的跳过）。
- WebDAV 配置存 `cfg:dav`（密码在服务端，`GET /api/backup/dav` 只回 `hasPassword`）；排程在 Node 用 `setInterval`、Workers 用 cron，都调 `runDueBackups()`，靠 `dav:lock` 防重入。
- 设置页把「服务器地址」和「备份路径」拆成两个输入框，服务端仍只存一个 `url`：前端 `splitDav()` / `joinDav()`（`public/app.js`）负责拆合，新增字段时两边都要改；执行时间是 `#dav-time` 的 `input[type=time] step=60`（**可选到分钟**，与详情页「指定时间」同款控件）、几号是 `#dav-day` 的 `select`（不是手填数字）；服务端把时分拆成 `hour` + `minute` 两个数字存 `cfg:dav`，`backupDue()` / `nextBackupAt()` 都按分钟算，**新增字段必须同步 `normalizeDavConf()` 与 `publicDavConf()`**；前端互转走 `davTimeOf()` / `parseDavTime()`，从未配置过时默认取「此刻」（`nowHm()`），不要写死 03:00。
- 设置页 DAV 区是左右两栏 `.dav-grid`（左：连接 + 备份计划 + 保存；右：运行状态 6 行 + 手动操作）：**字段一律两列排布，别用 `.dav-field.full` 独占整行**，两栏信息量要接近——左栏加字段就给右栏补一行状态，反之亦然。
- 远端文件名只认 `^trakt-backup-[A-Za-z0-9._-]+\.json$`（读和删都校验），改命名规则时两处 `davFileName()` 与校验正则要一起改。
- 单类数据上限 50 页 / 5000 条，超出只在 `truncated` 标注；自定义列表最多备份 100 个。

## 现状

- 已验证：本地 Node 全流程、Workers + D1（SQLite 仿真端到端）、**本地 Workers 运行时（`wrangler dev` + 本地 D1，14 项探测：Assets 走新版静态资源、未登录接口 401、D1 读写会话与 WebDAV 配置、密码不回传）**、线上 `/api/health`、登录页、静态资源、越权拦截、海报链路、写操作（标记已看四种时间模式/取消/评分/待看）、`/api/calendar` 整月聚合与缓存（桩数据 + 真实账号整月 86 条 / 31 天）、`/api/stats` 聚合与缓存（桩数据 5 例 + 真实账号 2026 年 1444 条 / 972 小时 / 291 天，首次 3.7s、缓存 11ms，页面渲染正常）、备份/恢复/WebDAV（桩 Trakt + 内存 WebDAV：凭据不外泄、dry-run 预览、恢复跳过与覆盖、定时幂等、路径穿越拦截）
- 未验证：真实 Trakt 账号的完整登录（需邮箱验证码）与真实写入；TMDB key 分支（设置页可填）；真实网盘（坚果云 / Nextcloud）上的 WebDAV 上传与在真实账号上执行恢复
- 部署：CI（`.github/workflows/deploy.yml`）已加质量门禁（`npm test` + `wrangler deploy --dry-run`）+ 部署后冒烟（`/api/health` 200、`/api/backup` 401、`/ui.js` 200）；**线上 `https://trakt.wliky.workers.dev` 截至 2026-10-31 仍是阶段 1 前后的旧版本**（`/ui.js` 与 `/api/backup` 均 404、`app.js` 58 KB vs 本地 190 KB），阶段 2–6 未上线，需要 push 到 `main` 或本地 `node scripts/deploy-cf.mjs` 才生效
