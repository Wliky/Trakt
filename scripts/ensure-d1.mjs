#!/usr/bin/env node
/**
 * 确保 D1 数据库 Trakt 存在，并把 database_id 写回 wrangler.toml。
 * 只把 id 打到 stdout（其余日志走 stderr），方便 shell 捕获：
 *   ID=$(node scripts/ensure-d1.mjs)
 *
 * 兼容新版 wrangler：`d1 create` 不再支持 --json，因此创建后统一用
 * `d1 list --json` 回查 id，并对纯文本输出保留 UUID 正则兜底。
 *
 * 需要环境里已有 CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID，或本地已 wrangler login。
 * 调试时可用 WRANGLER_BIN 指向自定义 wrangler 可执行文件。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tomlPath = path.join(root, 'wrangler.toml');
const DB_NAME = 'Trakt';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const log = (...a) => console.error(...a);

const customBin = process.env.WRANGLER_BIN;
// WRANGLER_BIN 指向 .mjs/.js 时用当前 node 执行，方便用测试桩替换 wrangler
const isScript = Boolean(customBin && /\.(mjs|js|cjs)$/i.test(customBin));
const cmd = isScript ? process.execPath : customBin || (process.platform === 'win32' ? 'npx.cmd' : 'npx');
const baseArgs = isScript ? [customBin] : customBin ? [] : ['--yes', `wrangler@${process.env.WRANGLER_VERSION || '4'}`];

/** 运行 wrangler，返回 {ok, out, err}，不抛异常 */
function wrangler(args) {
  try {
    const out = execFileSync(cmd, [...baseArgs, ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      // Windows 上 .cmd/.bat 必须走 shell，否则 Node 22 抛 EINVAL
      shell: process.platform === 'win32',
    });
    return { ok: true, out, err: '' };
  } catch (e) {
    return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || e.message || '') };
  }
}

const parseJSON = (text) => {
  const i = text.search(/[[{]/);
  if (i < 0) return null;
  try {
    return JSON.parse(text.slice(i));
  } catch {
    return null;
  }
};

/** 从列表 JSON 里找 Trakt 的 id */
function idFromList(json) {
  if (!json) return '';
  const arr = Array.isArray(json) ? json : json.result || json.database || [];
  const list = Array.isArray(arr) ? arr : [];
  const hit = list.find((d) => String(d?.name || d?.database_name || '').toLowerCase() === DB_NAME.toLowerCase());
  return hit ? hit.uuid || hit.id || hit.database_id || '' : '';
}

/** 从纯文本里抓 UUID（优先取 Trakt 所在行） */
function idFromText(text) {
  const line = String(text)
    .split(/\r?\n/)
    .find((l) => l.toLowerCase().includes(DB_NAME.toLowerCase()) && UUID_RE.test(l));
  if (line) return line.match(UUID_RE)[0];
  const any = String(text).match(UUID_RE);
  return any ? any[0] : '';
}

function findExisting() {
  const j = wrangler(['d1', 'list', '--json']);
  if (j.ok) {
    const id = idFromList(parseJSON(j.out));
    if (id) return id;
  }
  // 老版本可能不支持 --json，退回文本解析
  const t = wrangler(['d1', 'list']);
  if (t.ok) {
    const id = idFromText(t.out);
    if (id) return id;
  }
  return '';
}

let toml = fs.readFileSync(tomlPath, 'utf8');
let id = (toml.match(/\[\[d1_databases\]\][\s\S]*?database_id\s*=\s*"([^"]*)"/) || [])[1] || '';

if (id && !id.startsWith('REPLACE')) {
  log(`✓ wrangler.toml 已有 D1：${id}`);
} else {
  log('→ 查询已有 D1 数据库');
  id = findExisting();

  if (!id) {
    log(`→ 创建 D1 数据库 ${DB_NAME}（不带 --json）`);
    const created = wrangler(['d1', 'create', DB_NAME]);
    if (!created.ok && /already exists|already owned/i.test(created.err + created.out)) {
      log('  已存在，重新查询 id');
    } else if (!created.ok) {
      log('✗ d1 create 失败：' + (created.err || created.out).trim().split('\n').slice(-3).join(' '));
    }
    // 创建输出里可能直接带 database_id
    id = created.ok ? idFromText(created.out) : '';
    // 统一用 list 回查（新版 wrangler 的 create 无 --json）
    if (!id) id = findExisting();
  }

  if (!id) {
    log('✗ 未能获取 database_id。请手动执行：npx wrangler d1 create ' + DB_NAME + '，把 id 填进 wrangler.toml');
    process.exit(1);
  }

  toml = toml.replace(/database_id\s*=\s*"[^"]*"/, `database_id = "${id}"`);
  fs.writeFileSync(tomlPath, toml, 'utf8');
  log(`✓ database_id 已写入 wrangler.toml：${id}`);
}

process.stdout.write(id);
