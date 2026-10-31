# trakt

自托管的 Trakt 数据管理面板：**邮箱验证码登录**，不用创建 OAuth 应用、不占用授权名额，直接管理观看历史 / 评分 / 收藏 / 片单，并出统计报表。

零依赖（只用 Node 内置模块），可本地跑、Docker 跑，或部署到 Cloudflare Workers（D1 存储）。

> 📚 开发规范与阶段规划见 [`trakt_project_docs/`](trakt_project_docs/)（Skill：[`.agents/skills/personal-trakt-manager/`](.agents/skills/personal-trakt-manager/)）；项目审计与规划文档见 [`docs/`](docs/)（审计结论：[`docs/PROJECT_AUDIT.md`](docs/PROJECT_AUDIT.md)）。

## 双向同步（点条目即可改 Trakt）

点任意一行进入全屏详情页，右侧是操作卡，**每次写完立刻回读 Trakt 状态**，不存本地影子数据：

| 操作 | 行为 |
| --- | --- |
| 观看 | 未看时按钮是「标记已看」，必须先选时间（不默认「现在」）；已看时按钮变「取消观看」，再点即撤销 |
| 评分 | 5 星半星（0.5–10 档）点选，也可输入精确数字；点当前档位或输入 0 等于清除评分（对应 Trakt `rating: 0`） |
| 待看 | 「加入待看」/「移出待看」切换 Watchlist |
| 收藏 | 仅电影与剧；「加入收藏」/「取消收藏」切换 Favorites |
| 加入列表 | 选一个自定义列表后「加入」，写 `/users/me/lists/{id}/items` |

「标记已看」的四种时间模式：

| 模式 | 取值 |
| --- | --- |
| 现在 | 当前时间 ISO |
| 发布日 | 读元数据里的上映/首播日（Trakt `released`、分集 `first_aired`，TMDB 下为 `release_date`/`air_date`），当日 12:00 UTC |
| 选择日期 | 自定义日期，当日 12:00 UTC |
| 未知日期 | 用 `1970-01-01T12:00:00Z` 占位；若 Trakt 拒收该日期，自动改为不传 `watched_at` 并提示 |

剧集用 **episode 自己的 id** 写入（海报/元数据用所属剧的 id）；季按季号整季写入，支持已看 / 评分 / 待看，收藏仅限电影与剧。

## 登录保持

- 会话 cookie 有效期 **180 天**，活跃使用按滑动窗口自动续期（7 天内有访问就顺延）。
- 登录成功后额外下发一个**长期设备令牌**，前端存 `localStorage` 并在每个请求带 `x-tm-device` 头。cookie 被清、换端口访问（`localhost` ↔ `127.0.0.1`）、内嵌 webview 丢 cookie 时，用它直接恢复登录，不用再收验证码。
- 「退出登录」会同时删服务端会话和设备令牌。

## 功能

导航分 6 项，其中「记录」「片单」两组是多 tab 分节（旧地址 `#/progress`、`#/calendar`、`#/stats` 等会自动跳到新位置）：

| 模块 | 能做什么 |
| --- | --- |
| 概览 | 本月/年度仪表盘：累计小时 + 每日热力图、今日/本周观看曲线、评分均分与分布、观看类型环形图、最近收藏、「继续观看」续播点卡片（`/sync/playback` 按暂停时间倒序取 6 条）；月度/年度切换与翻页写在 URL 里（`#/dashboard?period=year&m=2026-10`） |
| 搜索 | 搜 Trakt 全站电影/剧集（不限已看），可直接「加入待看」，点行开详情做标记 / 评分 / 待看；类型筛选、分页、搜索状态写在 URL 里（`#/search?q=…&page=2`） |
| 追剧 | 整页大日历（不拆 tab）：格子只放封面（多剧叠放，最多 3 张 + 余数），点某天右侧列出当天剧集（海报/年份/集号/标题），可标记已看、加入待看、打开详情；支持今天、上一月/下一月，月份与选中日期写在 URL 里（`#/tracking?m=2026-10&d=2026-10-31`） |
| 记录 · 观看历史 | 按电影/剧集切换、日期区间筛选、分页、勾选批量删除（删除后提示条里有 12 秒撤销）、导出 CSV/JSON |
| 记录 · 评分 | 电影/剧集/分集/季 四类，逐条改分（1–10），0 分即删除评分 |
| 片单 · 待看 / 我的列表 | Watchlist 查看/移除（可撤销），关键词筛选 + 多选批量移出；自定义列表展开条目、加条目（搜片）、多选批量移除条目（可撤销）、新建/删除列表；列表 ↔ 海报网格视图可切换 |
| 片单 · 收藏 | Favorites 列表查看与取消收藏（可撤销），关键词筛选 + 多选批量取消；同样支持列表 ↔ 海报网格 |
| 设置 | 可选接入 TMDB（中文标题/简介、高清海报）；界面语言（简中/英文，独立于下面的 TMDB 显示语言）；可选显示语言（简中/繁中/英/日/韩）；数据备份：下载整账号备份、范围预览、从文件恢复、WebDAV 定时备份（开关 + 周期/时间/保留份数 + 远端列表/恢复/删除） |
| 全局 | 每行左侧海报缩略图，点任意一行进入全屏详情页 `#/detail?…`（可刷新 / 分享 / 后退），返回列表时恢复原滚动位置 |
| 详情页 | 全宽背景 hero + 右侧操作卡：已看（强制先选日期）/ 5 星半星评分（可输精确数字）/ 待看 / 收藏 / 加入列表；电影、剧集、季、分集共用同一页，季与集可切回剧集简介 |
| 剧集详情 | hero 下方「季 tab + 横向分集卡」：列出全部季（已播/总集数、首播日，可整季标记已看），展开某季看全部分集（含**未看**与**未播**），单集可看中文简介 + 剧照，并直接标记已看 / 评分 / 加待看 |

## 海报与影视信息（TMDB / Trakt 双源）

| | Trakt（默认，零配置） | TMDB（可选） |
| --- | --- | --- |
| 需要 key | 否 | 是（免费申请） |
| 海报 | `media.trakt.tv` | `image.tmdb.org` |
| 标题/简介语言 | 官方译文（有则中文，否则英文） | 指定语言（默认 `zh-CN`） |
| 分集简介/剧照 | 英文简介 + `screenshot` 剧照 | 指定语言简介 + `still` 剧照 |
| 元数据 | 年份/时长/类型/评分/简介 | 同左 + 原始标题/投票数 |

**显示语言**：设置页可选 `zh-CN / zh-TW / en-US / ja-JP / ko-KR`，优先级为环境变量 `TMDB_LANG` > 设置页保存值 > `zh-CN`。语言会进缓存键（切语言立即生效，不用等 30 天过期）。
未配 TMDB key 时也不会全英文：会额外请求 Trakt 官方译文（`/movies|shows/{id}/translations/{lang}`）覆盖标题与简介；**分集没有官方译文**，想看中文分集简介必须配 TMDB key。

在「设置」页粘贴 TMDB key（v3 32 位 key 或 v4 Read Access Token）即可切换，保存时会先校验；TMDB 查不到条目时自动回落 Trakt。查询结果缓存 **30 天**（存储里 `art:*`），换 key 或换语言后按 provider+语言分开缓存。

**海报一律由服务端代取图片字节、同源输出**（`/api/poster` → `image/*` 字节流），不把浏览器直连 CDN 的 URL 暴露给 `<img>`。原因：`media.trakt.tv` 在部分网络环境下会被浏览器 **ORB 拦截**（`ERR_BLOCKED_BY_ORB`，同环境下 `image.tmdb.org` 正常），表现为海报全是裂图；服务端中转可同时规避 ORB、防盗链与混合内容问题。取图失败时才降级成 302 重定向。


## 备份与恢复

- **导出**（给人看）：`/api/export`，按历史 / 评分 / 待看分类型导出 CSV 或 JSON。
- **备份**（给机器恢复）：`/api/backup` 下载 `trakt-manager-backup` v1 JSON，覆盖观看历史、四类评分、待看、收藏、自定义列表与非敏感设置，**不含任何令牌 / key / 密码**。单类数据最多 50 页（5000 条），拉不全时在 `truncated` 里如实标注。
- **恢复**：`/api/restore` 默认只做 dry-run（逐范围列出「新增 / 已存在 / 冲突覆盖 / 无效」），真正写入必须带 `confirm:true`；已存在的跳过、评分冲突按备份覆盖、列表按 trakt id → slug → 名称复用。Trakt 没有批量事务，**中途失败不回滚**，接口返回 `partial:true` 与逐段错误，重跑幂等（已存在的会跳过）。
- **WebDAV 自动备份**（设置页）：填网盘 / NAS 的 WebDAV 目录（坚果云、Nextcloud、群晖），按每天 / 每周 / 每月 + 本地时区整点上传，只保留最近 N 份；可测试连接、立即备份、列远端备份并直接恢复或删除。密码只存服务端（接口只回 `hasPassword`），远端文件只认 `trakt-backup-*.json`。
- 排程：本地 `server.js` 每小时检查一次，Workers 侧由 cron 每小时触发，都按用户时区判断「本天 / 本周 / 本月是否已跑」，并用 `dav:lock` 防重入。

## 登录原理（为什么不用建 OAuth 应用）

Trakt 早已移除账号密码登录（`/oauth/token` 只认 `authorization_code` / `refresh_token`）。本项目复刻的是 **Trakt 网页版自己的登录链路**，复用网页版公开的 client_id，所以既没有回调地址、也不需要注册新应用：

```
① POST auth.trakt.tv/auth/magic            email        → 邮箱收到 6 位验证码（5 分钟）
② POST auth.trakt.tv/auth/magic/submit     email + otp  → Set-Cookie 会话（Better Auth）
③ GET  auth.trakt.tv/api/auth/oauth2/authorize  带会话 cookie + PKCE(S256)
                                             → 302 或 {redirect,url} 里取授权码
④ POST auth.trakt.tv/oauth/token           grant_type=authorization_code
                                             → access_token / refresh_token
```

之后数据请求发到网页版数据域 `apiz.trakt.tv`，头为 `Authorization: Bearer …` + `trakt-api-key: <网页版 client_id>`。

- access_token 约 **7 天**有效；refresh_token **单次使用后会轮换**，服务端每次刷新都写回新值。
- 401 时自动刷新并重试一次；刷新锁按账号串行，避免并发轮换互相覆盖。
- 浏览器只拿到 `HttpOnly; SameSite=Lax` 的会话 cookie，**令牌永不下发到前端**。

## 运行

```bash
cd trakt-manager
node server.js          # 打开 http://localhost:8787
```

要求 Node 18+（推荐 22）。无 npm 依赖，不需要 `npm install`。

环境变量写进 `.env` 即可，`server.js` 启动时**自动加载**（Node 20.12+ 内置 `process.loadEnvFile`；更老的 Node 用 `node --env-file=.env server.js`）：

```bash
cp .env.example .env    # 按需改端口 / 目录 / TMDB key
node server.js          # 启动日志会打印「配置来源: .env（路径）」
```

优先级 **真实环境变量 > `.env` > 代码默认值**，所以 `PORT=9000 node server.js` 一定赢过文件里的 `PORT`。`ENV_FILE=/abs/path` 可指定别的文件，`ENV_FILE=none` 关闭自动加载。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data` | 存储目录（`db.json`：账号令牌 + 会话） |
| `COOKIE_SECURE` | `auto` | 强制 Secure cookie；HTTPS 反代后设 `true`，本机 http 设 `false` |
| `TRAKT_API_BASE` | `https://apiz.trakt.tv` | 数据域，可切 `https://api.trakt.tv` |
| `TRAKT_AUTH_BASE` | `https://auth.trakt.tv` | 认证域 |
| `TRAKT_CLIENT_ID` | 内置网页版值 | 想换成自己应用时填这里 |
| `TRAKT_USER_AGENT` | `TraktManager/1.0.0 (+self-hosted)` | 出站 UA，Trakt 缺它会被拦 403 |
| `TMDB_API_KEY` | 空 | TMDB v3 key；也可在「设置」页粘贴后存到服务端 |
| `TMDB_TOKEN` | 空 | TMDB v4 Read Access Token（与上者二选一） |
| `TMDB_LANG` | `zh-CN` | TMDB 元数据语言 |
| `ENV_FILE` | `<仓库>/.env` | 指定 env 文件路径；`none` 关闭自动加载 |

### Docker

```bash
cp .env.example .env             # 可选：TMDB key / 端口等
docker compose up -d --build     # 数据落在 ./data
```

`docker-compose.yml` 里已把 `COOKIE_SECURE`、`TMDB_*`、`TRAKT_*` 都映射成 `"${VAR:-默认}"`，compose 会自动读同目录 `.env` 做插值，**写了就生效，不用改 compose 文件**。

或不用 compose：

```bash
docker build -t trakt-manager .
docker run -d -p 8787:8787 -v "$PWD/data:/app/data" --env-file .env trakt-manager
```

`.dockerignore` 已排除 `.env*`，密钥不会进镜像层；容器内配置只来自运行时 `environment` / `--env-file`。

### Cloudflare Workers + D1（推荐线上）

代码已适配：`worker.js` 复用同一套 `lib/core.js`，静态资源走 Workers Assets，**数据存 D1（绑定变量 `DB`，库名 `Trakt`）**。免费计划即可。

#### 方式 A：GitHub Actions 自动部署（推上去就发）

仓库里已经带好 `.github/workflows/deploy.yml`：push 到 `main` 或手动 `Run workflow` 时，它会先过质量门禁再部署：

1. **质量门禁**（`test` 作业）：`npm test`（67 项）→ `wrangler deploy --dry-run` 打包校验；任一步失败就**不进入部署**
2. 检查密钥 → 确保 D1 数据库 `Trakt` 存在（不存在就建）→ 执行 `schema.sql` 建表 → `wrangler deploy`
3. **部署后冒烟**：探测线上 `/api/health` 200、`/api/backup` 401、`/ui.js` 200；不符合就判失败，专抓「部署成功但线上还是旧版本」

你只需要在仓库 **Settings → Secrets and variables → Actions** 里加两个 Secret：

| Secret | 取值 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare Dashboard → My Profile → API Tokens → Create Token，权限给 **Workers Scripts: Edit** + **D1: Edit** + **Account Settings: Read** |
| `CLOUDFLARE_ACCOUNT_ID` | Dashboard 右侧栏的 Account ID（或 `wrangler whoami` 里的 Account ID） |

加完在 Actions 里点一次 **Run workflow** 即可，日志最后会打印 `https://<worker>.<子域>.workers.dev`。

#### 方式 B：本地命令行部署

```bash
cd trakt
npx wrangler@latest login        # 或 export CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
node scripts/deploy-cf.mjs       # 自动建 D1、写 database_id、建表、部署
```

带 `APP_URL` 还会在部署后自检（不符直接非零退出，抓「部署成功但线上还是旧版本」）：

```bash
APP_URL=https://trakt.wliky.workers.dev node scripts/deploy-cf.mjs
#   ✓ /api/health → 200
#   ✓ /api/backup → 401
#   ✓ /ui.js → 200
```

等价的手动步骤：

```bash
npx wrangler@latest d1 create Trakt                     # 记下 database_id
npx wrangler@latest d1 execute Trakt --file=./schema.sql --remote -y
npx wrangler@latest deploy                              # 先把 id 填进 wrangler.toml
```

#### 注意

- **存储不互通**：Node 版令牌在 `data/db.json`，Workers 版在 D1 的 `kv` 表，切过去要重新登录一次（之后有设备令牌就不用再收验证码）。
- `COOKIE_SECURE=true` 已写死进 `wrangler.toml` 的 vars，Workers 全站 HTTPS，不能改 false。
- **业务密钥不要写进 `wrangler.toml` 的 `[vars]`**（那个文件会进仓库）：`TMDB_API_KEY` / `TMDB_TOKEN` / `TRAKT_CLIENT_ID` 用 `npx wrangler secret put <名字>` 注入，或在设置页填 TMDB key。CI 里只放 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 两个仓库 Secret。
- 部署后自检三条（未登录应分别返回 200 / 401 / 200）：
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' https://trakt.wliky.workers.dev/api/health
  curl -s -o /dev/null -w '%{http_code}\n' https://trakt.wliky.workers.dev/api/backup
  curl -s -o /dev/null -w '%{http_code}\n' https://trakt.wliky.workers.dev/ui.js
  ```
  `/api/backup` 返回 404 说明线上还是阶段 1 前后的老版本（缺 `/ui.js`、缺备份接口），需要重新部署。
- `lib/store-d1.js`（D1）与 `lib/store-node.js`（本地文件）是两份实现，接口一致；**Workers 侧不能 import 任何 `node:` 模块**，改存储逻辑时两边都要动。
- D1 表结构只有一张 `kv(key, value, exp)`，`schema.sql` 里带幂等的 `CREATE TABLE IF NOT EXISTS`，重复执行安全。
- 海报是服务端中转的，每张图算一次 Worker 请求（免费额度 10 万/天）。

## 目录结构

```
trakt/
├── server.js                  Node 适配层（http → Web Request，静态资源 + SPA 回退）
├── worker.js                  Cloudflare Workers 入口
├── lib/core.js                路由 / 登录链路 / 接口白名单 / 导出 / 写操作
├── lib/art.js                 海报与影视信息（TMDB / Trakt 双源 + 缓存）
├── lib/dav.js                 WebDAV 客户端（备份上传 / 列表 / 取回 / 删除）
├── lib/store-d1.js            存储实现（Cloudflare D1）
├── lib/store-node.js          存储实现（本地 JSON 文件）
├── public/                    前端（无构建：index.html + app.js + ui.js + i18n.js + styles.css）
├── schema.sql                 D1 表结构
├── scripts/deploy-cf.mjs      一键部署
├── scripts/ensure-d1.mjs      确保 D1 存在并回写 database_id
├── tests/                     零依赖单元测试（node --test）
├── .github/workflows/deploy.yml   push 即自动部署
├── Dockerfile / docker-compose.yml
└── wrangler.toml
```

本地测试：

```bash
npm test            # 等价于 node --test
```

覆盖：存储契约（FileStore 与 D1Store 同一套用例）、路由鉴权与白名单、统一出站层（`callTrakt`）的 401 重放 / 限流退避 / 网络收敛、写操作的请求体形态与写后回读、导出格式、备份与恢复（凭据不外泄 / dry-run 预览 / 跳过与覆盖语义 / 坏备份拒绝 / WebDAV 上传与保留策略 / 远端文件名校验 / 定时幂等与锁）、前端通用片段（`public/ui.js` 的标题单元 / 空态 / 错误态 / 分页器）。测试全部用桩 `fetch`，不会打真实 Trakt 或真实网盘。

## 内部接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/session` | 当前登录状态 |
| POST | `/api/auth/start` | 发验证码（同会话 60s 冷却，OTP 最多试 5 次） |
| POST | `/api/auth/verify` | 验证码 → 换令牌 → 建会话 |
| POST | `/api/auth/logout` | 退出（删服务端会话） |
| POST | `/api/trakt` | Trakt 透传，`{method,path,query,body}`，**仅白名单路径** |
| GET | `/api/export` | 导出历史/评分/Watchlist，`kind`+`type`+`format=csv\|json` |
| GET | `/api/backup` | 下载版本化备份（`trakt-manager-backup` v1）；`?preview=1` 只回计数与告警 |
| POST | `/api/restore` | 恢复：默认 dry-run 预览；写入需 `dryRun:false` + `confirm:true`，可带 `scopes` |
| GET/POST | `/api/backup/dav` | 读取 / 保存 WebDAV 配置（密码留空 = 沿用旧值，`clearPassword` 清空） |
| POST | `/api/backup/dav/test` | 测试连接（可测未保存的表单值），目录不存在时回 `needsCreate` |
| POST | `/api/backup/dav/run` | 立即备份一次（不写排程的 `lastRunAt`），成功后按 `keep` 清理最旧文件 |
| GET | `/api/backup/dav/files` | 远端备份列表（只列 `trakt-backup-*.json`） |
| GET | `/api/backup/dav/file` | 取回并校验某个远端备份（`name` 必须匹配本应用命名） |
| POST | `/api/backup/dav/delete` | 删除某个远端备份（同样限制文件名） |
| GET | `/api/poster` | 海报图片字节（服务端代取、同源输出），`type`+`trakt`/`tmdb` |
| GET | `/api/meta` | 影视信息（标题/简介/时长/类型/评分） |
| GET | `/api/state` | 条目当前状态：已看次数/最近时间、评分、是否待看 |
| GET | `/api/calendar` | 整月播出排期（`month=YYYY-MM&tz=480`，`tz` 为浏览器时区分钟、东为正），按用户当天分组、字段裁剪，服务端缓存 10 分钟 |
| GET | `/api/stats` | 概览聚合（`period=month\|year&month=YYYY-MM&tz=480`）：分页拉历史后按用户时区折「天/小时/类型」，评分与最近收藏同批返回；缓存 5 分钟，写操作后立即失效 |
| POST | `/api/action` | 写操作：`watch`/`unwatch`/`rate`/`unrate`/`watchlist_add`/`watchlist_remove`/`favorite_add`/`favorite_remove` |
| POST | `/api/season/watch` | 整季批量标记/取消：`{ids, season, action: watch\|unwatch, when}`，服务端读整季后按 `BACKUP_CHUNK` 分批写，回 `requested/added/existing/skipped/removed/failed` |
| GET/POST | `/api/settings` | 读取/设置 TMDB key 与显示语言（`tmdbKey` / `tmdbLang`，前者会先校验） |

前端拿不到任意 Trakt 路径：`/api/trakt` 只放行 `sync/*`（含 `sync/playback` 续播点）、`users/me/*`、`search/*`、`shows/*/seasons`（季与分集）、`shows/*/progress`（单剧进度，详情页复用它的 `next_episode`）、`calendars/my/*`（播出排期）、`*/translations/*`（官方译文）里声明过的方法与形态。整月排期另有 `/api/calendar` 聚合端点，前端不直接拼 Trakt 日历。

## 注意

- `data/db.json` 里是明文 access/refresh token，等同 Trakt 账号权限，别提交到 git、别对外暴露端口。
- 登录走 Trakt 网页版协议，**Trakt 侧改版会失效**。若某天第 ③ 步报「授权请求未返回授权码」，先看 `TRAKT_API_BASE` / `TRAKT_AUTH_BASE` 是否变更。
- 邮件验证码由 Trakt 发送；收不到先看垃圾箱，或换 `magic` 登录页面的官方入口确认账号邮箱。
- Trakt 限流为 5 分钟内 1000 次左右，批量删除/导出会自动分页，别并发猛刷。

## 未验证项

本次交付只做了本机冒烟（页面渲染、鉴权守卫、白名单、出站连通性、Trakt 海报链路）。**真实账号的完整登录与写操作需要你用自己的邮箱跑一次验证码流程**——首次登录时请留意第 ③ 步是否顺利拿到令牌。

TMDB 分支（填 key 后的中文元数据/海报）尚未用真实 key 跑过：key 校验接口已通（无效 key 正确返回 400），但 `zh-CN` 标题与 TMDB 海报的实际渲染需要你填一个 key 后确认。

写操作（标记已看/取消/评分/待看）是在本地假上游上完整验证的（含日期换算、状态回读、双向切换），**真实 Trakt 账号上的写入还没有跑过**——尤其「未知日期」用 1970 占位是否被 Trakt 接受，需要真实账号确认一次。

备份恢复与 WebDAV 是在桩上游上验证的（内存 WebDAV + 假 Trakt）：**还没在你的真实账号上跑过「备份 → 改数据 → 恢复」**，也没连过真实网盘。首次使用建议先点「查看备份范围」确认计数，再对单个范围（如 `ratings`）试恢复，确认无误后再全量恢复；真实网盘请先用「测试连接」验证 PROPFIND/MKCOL 权限。

概览的逐日时长与类型分布依赖 `/sync/history?extended=full` 返回的 `runtime` / `genres`（Trakt 不提供按天聚合的时长），缺这两个字段的条目只计次数、计入「未分类」。`/api/stats` 已用真实账号只读验证：2026 年 1444 次 / 972 小时 / 291 天有记录（首次 3.7s、缓存 11ms），2026-10 为 95 次 / 51 小时 / 28 天，浏览器端渲染与类型环图正常；`/api/calendar` 的整月排期结构已用桩数据测过，真实账号下「在看」剧集的排期密度需要实际确认。

阶段 9 的五项功能只在桩数据上验收过：**片单多选批量移除、整季批量标记/取消**都写 Trakt，真实账号上的分批写入与部分失败回执还没跑过；**界面 i18n** 覆盖导航、页头、表头、按钮、空态与设置页短标签，长说明段落仍是中文（未逐条翻译）；**网格视图**只在桌面宽度核对过，390px 移动端与超长英文标题的排版需要实机确认；**续播点**用的是桩 `paused_at`，真实账号的进度百分比与「已看完」边界值待确认。
