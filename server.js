/**
 * Node 适配层：把 node:http 请求转成 Web Request，交给 lib/core.js 处理。
 * 同时负责静态资源（public/）与 SPA 回退。零依赖。
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleRequest } from './lib/core.js';
import { FileStore } from './lib/store-node.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

const store = new FileStore(DATA_DIR);
const ctx = { store, env: process.env };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  // 防目录穿越
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  let body;
  try {
    body = await fs.readFile(file);
  } catch {
    // SPA 回退
    try {
      body = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'));
    } catch {
      res.writeHead(404).end('Not Found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME['.html'] }).end(body);
    return;
  }
  const ext = path.extname(file);
  const noCache = ['.html', '.js', '.css'].includes(ext);
  res.writeHead(200, {
    'content-type': MIME[ext] || 'application/octet-stream',
    // 前端资源不缓存，改完刷新即生效；其它静态资源短缓存
    'cache-control': noCache ? 'no-cache, must-revalidate' : 'public, max-age=300',
  }).end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (!url.pathname.startsWith('/api/')) {
    await serveStatic(url.pathname, res);
    return;
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') headers.set(k, v);
    else if (Array.isArray(v)) headers.set(k, v.join(', '));
  }
  headers.set('x-forwarded-proto', req.socket.encrypted ? 'https' : req.headers['x-forwarded-proto'] || 'http');

  const request = new Request(url.toString(), {
    method: req.method,
    headers,
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
  });

  try {
    const response = await handleRequest(request, ctx);
    const out = {};
    response.headers.forEach((value, key) => {
      if (key !== 'set-cookie') out[key] = value;
    });
    const cookies = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    if (cookies.length) out['set-cookie'] = cookies;
    const buf = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, out).end(buf);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' }).end(
      JSON.stringify({ error: String(err?.message || err) })
    );
  }
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`\n  Trakt Manager 已启动 → http://${shown}:${PORT}\n  数据目录: ${DATA_DIR}\n`);
});
