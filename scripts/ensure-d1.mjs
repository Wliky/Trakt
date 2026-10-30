#!/usr/bin/env node
/**
 * 确保 D1 数据库 Trakt 存在，并把 database_id 写回 wrangler.toml。
 * 只把 id 打到 stdout（其余日志走 stderr），方便 shell 捕获：
 *   ID=$(node scripts/ensure-d1.mjs)
 *
 * 需要环境里已有 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID，或本地已 wrangler login。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tomlPath = path.join(root, 'wrangler.toml');
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const log = (...a) => console.error(...a);

const run = (args) =>
  execFileSync(npx, ['--yes', 'wrangler@latest', ...args], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const parse = (out) => {
  const i = out.search(/[[{]/);
  if (i < 0) throw new Error('无法解析 wrangler 输出：' + out.slice(0, 200));
  return JSON.parse(out.slice(i));
};

const pickId = (obj) => {
  const list = Array.isArray(obj) ? obj : obj.result || obj.result_info || [];
  const arr = Array.isArray(list) ? list : [list];
  const hit = arr.find((d) => String(d?.name || '').toLowerCase() === 'trakt');
  return hit ? hit.uuid || hit.id || '' : '';
};

let toml = fs.readFileSync(tomlPath, 'utf8');
let id = (toml.match(/\[\[d1_databases\]\][\s\S]*?database_id\s*=\s*"([^"]*)"/) || [])[1] || '';

if (!id || id.startsWith('REPLACE')) {
  log('→ 查询已有的 D1 数据库列表');
  try {
    id = pickId(parse(run(['d1', 'list', '--json'])));
  } catch (e) {
    log('  d1 list 失败，将直接创建：' + String(e.message).slice(0, 160));
  }
}

if (!id) {
  log('→ 创建 D1 数据库 Trakt');
  const created = parse(run(['d1', 'create', 'Trakt', '--json']));
  const obj = Array.isArray(created) ? created[0] : created.result || created;
  id = obj.uuid || obj.id || '';
}

if (!id) {
  log('✗ 未能获取 database_id');
  process.exit(1);
}

if (!toml.includes(id)) {
  toml = toml.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${id}"`);
  fs.writeFileSync(tomlPath, toml, 'utf8');
  log(`✓ database_id 已写入 wrangler.toml：${id}`);
} else {
  log(`✓ 复用已有 D1：${id}`);
}

process.stdout.write(id);
