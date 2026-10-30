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
lib/store-node.js    本地存储（data/db.json，原子写）
lib/store-d1.js      D1 存储（表 kv）
public/              前端，无构建：index.html + app.js + styles.css
schema.sql           D1 建表
scripts/             deploy-cf.mjs（一键部署）、ensure-d1.mjs（确保库存在）
```

## 本地跑

```bash
node server.js          # http://localhost:8787，零依赖，不用 npm install
```

## 部署

- **GitHub Actions**：push main 即部署（`.github/workflows/deploy.yml`，官方 wrangler-action@v3）
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

## 现状

- 已验证：本地 Node 全流程、Workers + D1（SQLite 仿真端到端）、线上 `/api/health`、登录页、静态资源、越权拦截、海报链路、写操作（标记已看四种时间模式/取消/评分/待看）
- 未验证：真实 Trakt 账号的完整登录（需邮箱验证码）与真实写入；TMDB key 分支（设置页可填）
