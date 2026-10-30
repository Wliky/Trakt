# trakt

自托管的 Trakt 数据管理面板：**邮箱验证码登录**，不用创建 OAuth 应用、不占用授权名额，直接管理观看历史 / 评分 / 收藏 / 片单，并出统计报表。

零依赖（只用 Node 内置模块），可本地跑、Docker 跑，或部署到 Cloudflare Workers（D1 存储）。

## 双向同步（点条目即可改 Trakt）

点任意一行打开详情，底部是三个操作区，**每次写完立刻回读 Trakt 状态**，不存本地影子数据：

| 操作 | 行为 |
| --- | --- |
| 观看 | 未看时按钮是「标记已看」，下拉选时间；已看时按钮变「取消观看」，再点即撤销 |
| 评分 | 1–10 直接点；点当前分数等于清除评分（对应 Trakt `rating: 0`） |
| 待看 | 「加入待看」/「移出待看」切换 Watchlist |

「标记已看」的四种时间模式：

| 模式 | 取值 |
| --- | --- |
| 现在 | 当前时间 ISO |
| 发布日 | 读元数据里的上映/首播日（Trakt `released`、分集 `first_aired`，TMDB 下为 `release_date`/`air_date`），当日 12:00 UTC |
| 选择日期 | 自定义日期，当日 12:00 UTC |
| 未知日期 | 用 `1970-01-01T12:00:00Z` 占位；若 Trakt 拒收该日期，自动改为不传 `watched_at` 并提示 |

剧集用 **episode 自己的 id** 写入（海报/元数据用所属剧的 id），季只提供评分，不提供观看/待看。

## 登录保持

- 会话 cookie 有效期 **180 天**，活跃使用按滑动窗口自动续期（7 天内有访问就顺延）。
- 登录成功后额外下发一个**长期设备令牌**，前端存 `localStorage` 并在每个请求带 `x-tm-device` 头。cookie 被清、换端口访问（`localhost` ↔ `127.0.0.1`）、内嵌 webview 丢 cookie 时，用它直接恢复登录，不用再收验证码。
- 「退出登录」会同时删服务端会话和设备令牌。

## 功能

| 模块 | 能做什么 |
| --- | --- |
| 概览 | 电影/剧集观看数、累计时长、评分总数、最近观看（带海报） |
| 观看历史 | 按电影/剧集切换、日期区间筛选、分页、勾选批量删除、导出 CSV/JSON |
| 评分 | 电影/剧集/分集/季 四类，逐条改分（1–10），0 分即删除评分 |
| 收藏 | Favorites 列表查看与取消收藏 |
| 片单 | Watchlist 查看/移除；自定义列表展开条目、加条目（搜片）、移除条目、新建/删除列表 |
| 统计 | 总时长构成、评分分布（1–10 柱状图）、评论数 |
| 设置 | 可选接入 TMDB（中文标题/简介、高清海报） |
| 全局 | 每行左侧海报缩略图，点任意一行弹出详情：海报、年份、时长、评分人数、类型、简介、TMDB/Trakt 外链 |

## 海报与影视信息（TMDB / Trakt 双源）

| | Trakt（默认，零配置） | TMDB（可选） |
| --- | --- | --- |
| 需要 key | 否 | 是（免费申请） |
| 海报 | `media.trakt.tv` | `image.tmdb.org` |
| 标题/简介语言 | 原始语言（多为英文） | 中文（`zh-CN`） |
| 元数据 | 年份/时长/类型/评分/简介 | 同左 + 原始标题/投票数 |

在「设置」页粘贴 TMDB key（v3 32 位 key 或 v4 Read Access Token）即可切换，保存时会先校验；TMDB 查不到条目时自动回落 Trakt。查询结果缓存 **30 天**（存储里 `art:*`），换 key 后按 provider 分开缓存。

**海报一律由服务端代取图片字节、同源输出**（`/api/poster` → `image/*` 字节流），不把浏览器直连 CDN 的 URL 暴露给 `<img>`。原因：`media.trakt.tv` 在部分网络环境下会被浏览器 **ORB 拦截**（`ERR_BLOCKED_BY_ORB`，同环境下 `image.tmdb.org` 正常），表现为海报全是裂图；服务端中转可同时规避 ORB、防盗链与混合内容问题。取图失败时才降级成 302 重定向。


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

环境变量（可写 `.env` 后自行 source，或直接 `PORT=9000 node server.js`）：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `DATA_DIR` | `./data` | 存储目录（`db.json`：账号令牌 + 会话） |
| `COOKIE_SECURE` | `auto` | 强制 Secure cookie；HTTPS 反代后设 `true`，本机 http 设 `false` |
| `TRAKT_API_BASE` | `https://apiz.trakt.tv` | 数据域，可切 `https://api.trakt.tv` |
| `TRAKT_AUTH_BASE` | `https://auth.trakt.tv` | 认证域 |
| `TRAKT_CLIENT_ID` | 内置网页版值 | 想换成自己应用时填这里 |
| `TMDB_API_KEY` | 空 | TMDB v3 key；也可在「设置」页粘贴后存到服务端 |
| `TMDB_TOKEN` | 空 | TMDB v4 Read Access Token（与上者二选一） |
| `TMDB_LANG` | `zh-CN` | TMDB 元数据语言 |

### Docker

```bash
docker compose up -d --build     # 数据落在 ./data
```

或：

```bash
docker build -t trakt-manager .
docker run -d -p 8787:8787 -v "$PWD/data:/app/data" -e COOKIE_SECURE=false trakt-manager
```

### Cloudflare Workers + D1（推荐线上）

代码已适配：`worker.js` 复用同一套 `lib/core.js`，静态资源走 Workers Assets，**数据存 D1（绑定变量 `DB`，库名 `Trakt`）**。免费计划即可。

#### 方式 A：GitHub Actions 自动部署（推上去就发）

仓库里已经带好 `.github/workflows/deploy.yml`：push 到 `main` 或手动 `Run workflow` 时，它会自动

1. 检查密钥 → 2. 确保 D1 数据库 `Trakt` 存在（不存在就建）→ 3. 执行 `schema.sql` 建表 → 4. `wrangler deploy`

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

等价的手动步骤：

```bash
npx wrangler@latest d1 create Trakt                     # 记下 database_id
npx wrangler@latest d1 execute Trakt --file=./schema.sql --remote -y
npx wrangler@latest deploy                              # 先把 id 填进 wrangler.toml
```

#### 注意

- **存储不互通**：Node 版令牌在 `data/db.json`，Workers 版在 D1 的 `kv` 表，切过去要重新登录一次（之后有设备令牌就不用再收验证码）。
- `COOKIE_SECURE=true` 已写死进 `wrangler.toml` 的 vars，Workers 全站 HTTPS，不能改 false。
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
├── lib/store-d1.js            存储实现（Cloudflare D1）
├── lib/store-node.js          存储实现（本地 JSON 文件）
├── public/                    前端（无构建：index.html + app.js + styles.css）
├── schema.sql                 D1 表结构
├── scripts/deploy-cf.mjs      一键部署
├── scripts/ensure-d1.mjs      确保 D1 存在并回写 database_id
├── .github/workflows/deploy.yml   push 即自动部署
├── Dockerfile / docker-compose.yml
└── wrangler.toml
```

## 内部接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/session` | 当前登录状态 |
| POST | `/api/auth/start` | 发验证码（同会话 60s 冷却，OTP 最多试 5 次） |
| POST | `/api/auth/verify` | 验证码 → 换令牌 → 建会话 |
| POST | `/api/auth/logout` | 退出（删服务端会话） |
| POST | `/api/trakt` | Trakt 透传，`{method,path,query,body}`，**仅白名单路径** |
| GET | `/api/export` | 导出历史/评分/Watchlist，`kind`+`type`+`format=csv\|json` |
| GET | `/api/poster` | 海报图片字节（服务端代取、同源输出），`type`+`trakt`/`tmdb` |
| GET | `/api/meta` | 影视信息（标题/简介/时长/类型/评分） |
| GET | `/api/state` | 条目当前状态：已看次数/最近时间、评分、是否待看 |
| POST | `/api/action` | 写操作：`watch`/`unwatch`/`rate`/`unrate`/`watchlist_add`/`watchlist_remove` |
| GET/POST | `/api/settings` | 读取/设置 TMDB key（POST 会先校验） |

前端拿不到任意 Trakt 路径：`/api/trakt` 只放行 `sync/*`、`users/me/*`、`search/*` 里声明过的方法与形态。

## 注意

- `data/db.json` 里是明文 access/refresh token，等同 Trakt 账号权限，别提交到 git、别对外暴露端口。
- 登录走 Trakt 网页版协议，**Trakt 侧改版会失效**。若某天第 ③ 步报「授权请求未返回授权码」，先看 `TRAKT_API_BASE` / `TRAKT_AUTH_BASE` 是否变更。
- 邮件验证码由 Trakt 发送；收不到先看垃圾箱，或换 `magic` 登录页面的官方入口确认账号邮箱。
- Trakt 限流为 5 分钟内 1000 次左右，批量删除/导出会自动分页，别并发猛刷。

## 未验证项

本次交付只做了本机冒烟（页面渲染、鉴权守卫、白名单、出站连通性、Trakt 海报链路）。**真实账号的完整登录与写操作需要你用自己的邮箱跑一次验证码流程**——首次登录时请留意第 ③ 步是否顺利拿到令牌。

TMDB 分支（填 key 后的中文元数据/海报）尚未用真实 key 跑过：key 校验接口已通（无效 key 正确返回 400），但 `zh-CN` 标题与 TMDB 海报的实际渲染需要你填一个 key 后确认。

写操作（标记已看/取消/评分/待看）是在本地假上游上完整验证的（含日期换算、状态回读、双向切换），**真实 Trakt 账号上的写入还没有跑过**——尤其「未知日期」用 1970 占位是否被 Trakt 接受，需要真实账号确认一次。
