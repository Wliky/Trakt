/**
 * 极简 WebDAV 客户端（Node / Cloudflare Workers 通用）。
 * 只实现备份所需操作：PROPFIND / MKCOL / PUT / GET / DELETE。
 */

export const BACKUP_PREFIX = 'trakt-backup-';
const TIMEOUT_MS = 20_000;
const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop>' +
  '<d:resourcetype/><d:getcontentlength/><d:getlastmodified/>' +
  '</d:prop></d:propfind>';

function base64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function joinUrl(base, name) {
  const root = base.endsWith('/') ? base : `${base}/`;
  return new URL(encodeURIComponent(name), root).toString();
}

function netMessage(err) {
  if (err?.name === 'AbortError') return 'WebDAV 连接超时（20 秒）';
  return `WebDAV 连接失败：${err?.message || err}`;
}

function failure(status, action = 'WebDAV 请求') {
  if (status === 401 || status === 403) {
    return { ok: false, kind: 'auth', status, message: 'WebDAV 认证失败，请检查用户名和密码/应用密码' };
  }
  return { ok: false, kind: 'http', status, message: `${action}失败（HTTP ${status}）` };
}

async function request(conf, { method, name, body, headers = {}, depth } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const auth = conf.username || conf.password ? `Basic ${base64Utf8(`${conf.username || ''}:${conf.password || ''}`)}` : '';
  try {
    return await fetch(name ? joinUrl(conf.url, name) : conf.url, {
      method,
      headers: {
        'user-agent': 'TraktManager/1.0 (+self-hosted WebDAV)',
        ...(depth ? { depth } : {}),
        ...(auth ? { authorization: auth } : {}),
        ...headers,
      },
      body,
      redirect: 'follow',
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function propfind(conf, depth) {
  return request(conf, {
    method: 'PROPFIND',
    depth,
    headers: { 'content-type': 'application/xml; charset=utf-8' },
    body: PROPFIND_BODY,
  });
}

export async function davTest(conf) {
  try {
    const res = await propfind(conf, '0');
    if (res.ok) return { ok: true, status: res.status, needsCreate: false };
    if (res.status === 404) return { ok: true, status: 404, needsCreate: true };
    return failure(res.status, '连接测试');
  } catch (err) {
    return { ok: false, kind: 'network', message: netMessage(err) };
  }
}

export async function davEnsureDir(conf) {
  try {
    const res = await propfind(conf, '0');
    if (res.ok) return { ok: true, created: false };
    if (res.status !== 404) return failure(res.status, '检查目录');
    const made = await request(conf, { method: 'MKCOL' });
    if ([200, 201, 204, 301, 302, 405].includes(made.status)) return { ok: true, created: true };
    if (made.status === 409) {
      return { ok: false, kind: 'http', status: 409, message: '创建目录失败：上级目录不存在，请先在网盘中建好父目录' };
    }
    return failure(made.status, '创建目录');
  } catch (err) {
    return { ok: false, kind: 'network', message: netMessage(err) };
  }
}

function xmlUnescape(text) {
  return String(text || '').replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
    const e = entity.toLowerCase();
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const n = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : _;
  });
}

function xmlTag(block, name) {
  const re = new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, 'i');
  return xmlUnescape(block.match(re)?.[1] || '').trim();
}

function fileName(href) {
  const clean = String(href || '').split('?')[0].replace(/\/+$/, '');
  const segment = clean.split('/').pop() || '';
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function parseFiles(xml, dirName) {
  const out = [];
  const blocks = String(xml || '').split(/<(?:\w+:)?response\b[^>]*>/i).slice(1);
  for (const block of blocks) {
    const href = xmlTag(block, 'href');
    if (!href || /<(?:[\w.-]+:)?collection\b/i.test(xmlTag(block, 'resourcetype'))) continue;
    const name = fileName(href);
    if (!name || name === dirName || !name.toLowerCase().endsWith('.json')) continue;
    out.push({
      name,
      size: Number(xmlTag(block, 'getcontentlength')) || 0,
      modified: xmlTag(block, 'getlastmodified'),
    });
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

export async function davList(conf) {
  try {
    const res = await propfind(conf, '1');
    if (!res.ok) return failure(res.status, '读取远端文件列表');
    const path = new URL(conf.url).pathname.replace(/\/+$/, '');
    let dirName = path.split('/').pop() || '';
    try {
      dirName = decodeURIComponent(dirName);
    } catch {
      /* 保留原目录名 */
    }
    return { ok: true, files: parseFiles(await res.text(), dirName) };
  } catch (err) {
    return { ok: false, kind: 'network', message: netMessage(err) };
  }
}

export async function davPut(conf, name, text) {
  try {
    const res = await request(conf, {
      method: 'PUT',
      name,
      body: text,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    return res.ok ? { ok: true, status: res.status } : failure(res.status, '上传备份');
  } catch (err) {
    return { ok: false, kind: 'network', message: netMessage(err) };
  }
}

export async function davGet(conf, name, { maxBytes = 25 * 1024 * 1024 } = {}) {
  try {
    const res = await request(conf, { method: 'GET', name });
    if (!res.ok) return failure(res.status, '下载远端备份');
    const length = Number(res.headers.get('content-length')) || 0;
    if (length > maxBytes) return { ok: false, message: '备份文件过大（超过 25 MB）' };
    const text = await res.text();
    if (text.length > maxBytes) return { ok: false, message: '备份文件过大（超过 25 MB）' };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, kind: 'network', message: netMessage(err) };
  }
}

export async function davDelete(conf, name) {
  try {
    const res = await request(conf, { method: 'DELETE', name });
    return res.ok || res.status === 404 ? { ok: true } : failure(res.status, '删除旧备份');
  } catch (err) {
    return { ok: false, kind: 'network', message: netMessage(err) };
  }
}
