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

// 部署成功 ≠ 线上是新版本：设了 APP_URL 就顺手验三条（未登录口径：health 200 / backup 401 / ui.js 200）
const appUrl = (process.env.APP_URL || '').replace(/\/$/, '');
if (appUrl) {
  console.log(`→ 部署后自检（${appUrl}）`);
  const checks = [
    ['/api/health', 200],
    ['/api/backup', 401],
    ['/ui.js', 200],
  ];
  let failed = 0;
  for (const [p, want] of checks) {
    let code = 0;
    for (let i = 0; i < 6; i++) {
      try {
        code = (await fetch(appUrl + p, { redirect: 'manual' })).status;
      } catch {
        code = 0;
      }
      if (code === want) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    const ok = code === want;
    console.log(`  ${ok ? '✓' : '✗'} ${p} → ${code || '网络失败'}（期望 ${want}）`);
    if (!ok) failed++;
  }
  if (failed) {
    console.error(`\n自检失败 ${failed} 项：线上可能还在跑旧版本（缓存或旧 Worker），请检查 wrangler 输出。`);
    process.exit(1);
  }
} else {
  console.log('\n提示：设 APP_URL=https://你的域名 再运行，可自动做部署后自检。');
}

console.log('\n完成。打开输出的 workers.dev 地址即可登录。');
