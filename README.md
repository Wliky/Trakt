# Trakt

自托管的 Trakt 观影数据管理面板。用 Trakt 账号登录，集中管理观看历史、评分、待看与收藏，并给出观看统计。

不需要数据库、不需要构建步骤、不需要 `npm install`：只用 Node 内置模块，一个文件即可启动。

- 线上：https://trakt.wliky.workers.dev
- 仓库：https://github.com/Wliky/Trakt
- 版本：2.0.0

## 功能

- **概览**：按月、按年查看观看统计
- **搜索**：搜索全站影视，加入待看或打开详情
- **追剧**：播出日历，按天查看与标记
- **记录**：观看历史的管理与导出
- **片单**：待看与收藏的管理与导出
- **设置**：外观、语言、TMDB 与备份
- **详情页**：电影、剧集、季、分集共用一页

## 特点

- **零依赖**：后端只用 Node 内置模块，前端无构建、无框架
- **三种部署**：本机、Docker、Cloudflare Workers + D1
- **令牌不下发**：登录令牌只保存在服务端，浏览器拿不到
- **可迁移**：版本化 JSON 备份，也能定时备份到 WebDAV
- **轻量存储**：Node 版是一个 JSON 文件，Workers 版是 D1
- **双语界面**：中文与英文，深浅两套主题

## 登录

Trakt 已不支持账号密码登录。本项目复刻网页版的邮箱验证码链路，不需要注册 OAuth 应用；令牌只保存在服务端，会话 180 天有效，另有长期设备令牌可在 cookie 丢失后恢复登录。

## 部署

需要 Node 18 以上（推荐 22）。

本机：

```bash
cp .env.example .env    # 可选：端口、目录、TMDB key
node server.js          # http://localhost:8787
```

Docker（数据落在 `./data`）：

```bash
docker compose up -d --build
```

Cloudflare Workers + D1：

```bash
npx wrangler@latest login
node scripts/deploy-cf.mjs     # 建库、建表、部署
```

### 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `PORT` / `HOST` | `8787` / `0.0.0.0` | 监听端口与地址 |
| `DATA_DIR` | `./data` | 数据目录，存 `db.json` |
| `COOKIE_SECURE` | `auto` | HTTPS 反代后设 `true`，本机 http 设 `false` |
| `TRAKT_CLIENT_ID` | 内置网页版值 | 换成自己的应用时才需要 |
| `TMDB_API_KEY` / `TMDB_TOKEN` | 空 | 可选，启用 TMDB 元数据；二选一 |
| `TMDB_LANG` | `zh-CN` | 固定显示语言（`zh-CN` / `en-US`），设置后锁定界面里的语言选项 |
| `ENV_FILE` | `.env` | 指定 env 文件，`none` 关闭自动加载 |

`server.js` 会自动加载同目录的 `.env`，优先级为环境变量 > `.env` > 代码默认值。

### 持续部署

推送到 `main` 会触发仓库自带的 GitHub Actions：先做打包校验，再部署到 Workers 并探测线上接口。需要在仓库 Secrets 里配置 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`。

## 备份与恢复

- 导出：按历史、评分、待看导出 CSV 或 JSON
- 备份：版本化 JSON（`trakt-backup` v1），覆盖观看历史、评分、待看、收藏与设置
- 恢复：先预览差异再写入，已存在的条目跳过
- 自动备份：WebDAV 定时上传，只保留最近若干份

备份文件不含任何令牌与密码。

## 目录结构

```
├── server.js            Node 入口
├── worker.js            Cloudflare Workers 入口
├── lib/                 路由、登录链路、海报、存储、WebDAV
├── public/              前端（无构建：HTML + 原生 JS + CSS）
├── scripts/             Cloudflare 建库与部署
├── schema.sql           D1 表结构
└── Dockerfile / docker-compose.yml / wrangler.toml
```

## 说明

- `data/db.json` 保存明文的 access / refresh token，等同于 Trakt 账号权限，请勿提交到仓库或对外暴露端口
- Node 版数据在 `data/db.json`，Workers 版在 D1，两者不互通，切换部署方式后需重新登录
- 登录依赖 Trakt 网页版接口，Trakt 侧改版可能导致失效
- Trakt 有速率限制，批量操作与导出已自动分页
