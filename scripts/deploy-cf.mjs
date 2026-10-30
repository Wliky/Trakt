#!/usr/bin/env node
/**
 * 一键部署到 Cloudflare Workers（D1 版）
 *
 *   node scripts/deploy-cf.mjs
 *
 * 步骤：登录检查 → 确保 D1（scripts/ensure-d1.mjs）→ 建表 → deploy
 * 前置：npx wrangler@latest login，或环境变量 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const wrangler = (args) =>
  execFileSync(npx, ['--yes', `wrangler@${process.env.WRANGLER_VERSION || '4'}`, ...args], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

console.log('→ 检查 Cloudflare 登录状态');
try {
  wrangler(['whoami']);
} catch {
  console.error('\n未登录。请先执行：\n  npx wrangler@latest login\n或设置 CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID 后再运行。');
  process.exit(1);
}

console.log('→ 确保 D1 数据库');
execFileSync(process.execPath, [path.join(root, 'scripts', 'ensure-d1.mjs')], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

console.log('→ 应用表结构 schema.sql');
wrangler(['d1', 'execute', 'Trakt', '--file=./schema.sql', '--remote', '-y']);

console.log('→ 部署');
wrangler(['deploy']);

console.log('\n完成。打开输出的 workers.dev 地址即可登录。');
