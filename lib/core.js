/**
 * Trakt 数据管理面板 —— 核心逻辑（Web 标准 Request/Response，同时跑在 Node 与 CF Workers）
 *
 * 登录链路（复刻 Trakt 网页版，不占用 OAuth 应用名额）：
 *   ① POST {AUTH}/auth/magic            email          → 发 6 位验证码邮件
 *   ② POST {AUTH}/auth/magic/submit     email & otp    → Set-Cookie 会话
 *   ③ GET  {AUTH}/api/auth/oauth2/authorize (带 cookie, PKCE S256) → 授权码
 *   ④ POST {AUTH}/oauth/token           grant_type=authorization_code → access/refresh
 *   之后数据请求走 {API}（网页版数据域 apiz.trakt.tv），Bearer + 官方 client_id。
 */

import { resolveArt, resolvePoster, resolveSeason, resolveGenres, getTmdbKey, getTmdbLang, verifyTmdbKey, LANGUAGES, genreLabel } from './art.js';
import {
  davTest,
  davEnsureDir,
  davList,
  davPut,
  davGet,
  davDelete,
  BACKUP_PREFIX,
} from './dav.js';

const DEFAULTS = {
  AUTH_BASE: 'https://auth.trakt.tv',
  API_BASE: 'https://apiz.trakt.tv',
  PUBLIC_API_BASE: 'https://api.trakt.tv',
  // Trakt 网页版前端硬编码的 client_id（公开常量，无需注册应用）
  CLIENT_ID: '201dc70c5ec6af530f12f079ea1922733f6e1085ad7b02f36d8e011b75bcea7d',
  REDIRECT_URI: 'https://app.trakt.tv/callback',
  SCOPE: 'public openid profile email offline_access',
  UA: 'TraktManager/1.0.0 (+self-hosted)',
  SESSION_COOKIE: 'tm_sid',
  SESSION_TTL: 60 * 60 * 24 * 180,
  DEVICE_HEADER: 'x-tm-device',
  DEVICE_TTL: 60 * 60 * 24 * 365,
  PENDING_TTL: 300,
  RESEND_COOLDOWN: 60,
  MAX_OTP_ATTEMPTS: 5,
  COOKIE_SECURE: 'auto',
};

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const COOKIE_MAX_AGE = DEFAULTS.SESSION_TTL;

// ── 小工具 ───────────────────────────────────────────────

const enc = new TextEncoder();

function b64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randHex(n = 16) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function pkce() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(verifier));
  return { verifier, challenge: b64url(digest) };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'x-frame-options': 'DENY',
      ...headers,
    },
  });
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookies(resp) {
  if (typeof resp.headers.getSetCookie === 'function') return resp.headers.getSetCookie();
  const raw = resp.headers.get('set-cookie');
  return raw ? [raw] : [];
}

function buildCookie(name, value, { maxAge = COOKIE_MAX_AGE, secure = false } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

async function readJson(req) {
  try {
    const text = await req.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/** 恢复这类大 payload 专用：带体积上限，防止把超大文件直接塞进写流程 */
async function readJsonLimited(req, maxBytes = 16 * 1024 * 1024) {
  const text = await req.text();
  if (!text) return {};
  if (text.length > maxBytes) return { __tooLarge: true, size: text.length };
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function env(ctx) {
  const e = ctx.env || {};
  return {
    AUTH_BASE: (e.TRAKT_AUTH_BASE || DEFAULTS.AUTH_BASE).replace(/\/$/, ''),
    API_BASE: (e.TRAKT_API_BASE || DEFAULTS.API_BASE).replace(/\/$/, ''),
    PUBLIC_API_BASE: (e.TRAKT_PUBLIC_API_BASE || DEFAULTS.PUBLIC_API_BASE).replace(/\/$/, ''),
    CLIENT_ID: e.TRAKT_CLIENT_ID || DEFAULTS.CLIENT_ID,
    REDIRECT_URI: e.TRAKT_REDIRECT_URI || DEFAULTS.REDIRECT_URI,
    SCOPE: e.TRAKT_SCOPE || DEFAULTS.SCOPE,
    UA: e.TRAKT_USER_AGENT || DEFAULTS.UA,
    COOKIE_SECURE: String(e.COOKIE_SECURE ?? DEFAULTS.COOKIE_SECURE).toLowerCase(),
  };
}

function isHttps(req) {
  const url = new URL(req.url);
  return url.protocol === 'https:' || req.headers.get('x-forwarded-proto') === 'https';
}

function secureCookie(req, cfg) {
  if (cfg.COOKIE_SECURE === 'true') return true;
  if (cfg.COOKIE_SECURE === 'false') return false;
  return isHttps(req);
}

// ── ① 发验证码 ────────────────────────────────────────────

async function sendMagic(cfg, email) {
  const resp = await fetch(`${cfg.AUTH_BASE}/auth/magic`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': cfg.UA,
      accept: '*/*',
      origin: cfg.AUTH_BASE,
      referer: `${cfg.AUTH_BASE}/signin`,
    },
    body: `email=${encodeURIComponent(email)}`,
  });
  const text = await resp.text().catch(() => '');
  return { ok: resp.status === 200, status: resp.status, text };
}

// ── ② 提交验证码 → 会话 cookie ────────────────────────────

async function submitOtp(cfg, email, otp) {
  const resp = await fetch(`${cfg.AUTH_BASE}/auth/magic/submit`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'user-agent': cfg.UA,
      accept: '*/*',
      origin: cfg.AUTH_BASE,
      referer: `${cfg.AUTH_BASE}/signin`,
    },
    body: `email=${encodeURIComponent(email)}&otp=${encodeURIComponent(otp)}`,
  });
  if (resp.status !== 200) {
    if (resp.status === 401) return { ok: false, message: '验证码无效或已过期，请重新输入或重新发送' };
    return { ok: false, message: `验证码校验失败（HTTP ${resp.status}）` };
  }
  for (const line of setCookies(resp)) {
    if (line.startsWith('__Secure-better-auth.session_token=')) {
      return { ok: true, cookie: line.split(';')[0] };
    }
  }
  return { ok: false, message: '登录响应异常：未收到会话 cookie' };
}

// ── ③ OIDC 授权码（带会话 cookie + PKCE）─────────────────

async function oidcAuthorize(cfg, sessionCookie, state, verifier) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(verifier));
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.CLIENT_ID,
    redirect_uri: cfg.REDIRECT_URI,
    scope: cfg.SCOPE,
    code_challenge: b64url(digest),
    code_challenge_method: 'S256',
    state,
  });
  const resp = await fetch(`${cfg.AUTH_BASE}/api/auth/oauth2/authorize?${params}`, {
    headers: {
      'user-agent': cfg.UA,
      accept: 'text/html,application/json',
      cookie: sessionCookie,
    },
    redirect: 'manual',
  });

  const pick = (target) => {
    try {
      const q = new URL(target).searchParams;
      return { state: q.get('state') || '', code: q.get('code') || '' };
    } catch {
      return { state: '', code: '' };
    }
  };

  // 路径 A：302 直接回跳
  const loc = resp.headers.get('location');
  if (resp.status >= 300 && resp.status < 400 && loc) {
    const got = pick(loc);
    if (got.state !== state) return { ok: false, message: '授权状态校验失败，请重新发起登录' };
    if (got.code) return { ok: true, code: got.code };
  }

  // 路径 B：200 + JSON（SvelteKit 的 {redirect:true,url:"..."}）
  if (resp.status === 200) {
    const data = await resp.json().catch(() => null);
    if (data && data.url) {
      const got = pick(data.url);
      if (got.state !== state) return { ok: false, message: '授权状态校验失败，请重新发起登录' };
      if (got.code) return { ok: true, code: got.code };
    }
  }
  return { ok: false, message: `授权请求未返回授权码（HTTP ${resp.status}）` };
}

// ── ④ 授权码 / 刷新令牌换 token ──────────────────────────

async function exchangeToken(cfg, body) {
  const resp = await fetch(`${cfg.AUTH_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': cfg.UA },
    body: JSON.stringify({ ...body, client_id: cfg.CLIENT_ID }),
  });
  const data = await resp.json().catch(() => null);
  if (resp.status !== 200 || !data?.access_token) {
    return { ok: false, status: resp.status, message: data?.error_description || data?.error || `HTTP ${resp.status}` };
  }
  return { ok: true, tokens: data };
}

function normalizeTokens(t) {
  const expiresAt = t.expires_at
    ? Number(t.expires_at) * 1000
    : Date.now() + Number(t.expires_in || 604800) * 1000;
  return { access: t.access_token, refresh: t.refresh_token || '', expiresAt };
}

// ── Trakt 数据接口调用 ───────────────────────────────────

async function traktFetch(cfg, account, path, { method = 'GET', query, body } = {}) {
  const url = new URL(cfg.API_BASE + path);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const resp = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${account.access}`,
      'trakt-api-version': '2',
      'trakt-api-key': cfg.CLIENT_ID,
      'content-type': 'application/json',
      'user-agent': cfg.UA,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: resp.status, data, headers: resp.headers, retryAfter: resp.headers.get('retry-after') };
}

/** Trakt 用户资料里的头像（网页版 profile 的 images.avatar.full） */
function pickAvatar(data) {
  return data?.images?.avatar?.full || data?.user?.images?.avatar?.full || '';
}

/** 头像 URL 缺失时补拉一次并写回账号；任何失败都只返回空串，不影响会话可用 */
async function ensureAvatar(ctx, cfg, account) {
  if (account.avatar) return account.avatar;
  try {
    const me = await traktFetch(cfg, account, '/users/me', { query: { extended: 'full' } });
    const url = pickAvatar(me.data);
    if (url) {
      account.avatar = url;
      await ctx.store.set(`acct:${account.username}`, account);
    }
    return url;
  } catch {
    return '';
  }
}

const refreshLocks = new Map();

async function refreshAccount(ctx, cfg, sid, account) {
  const key = account.username || sid;
  if (refreshLocks.has(key)) return refreshLocks.get(key);
  const task = (async () => {
    if (!account.refresh) return { ok: false, message: '缺少 refresh_token，请重新登录' };
    const r = await exchangeToken(cfg, { grant_type: 'refresh_token', refresh_token: account.refresh });
    if (!r.ok) return { ok: false, message: `凭证续期失败：${r.message}` };
    const t = normalizeTokens(r.tokens);
    const next = { ...account, ...t, refreshedAt: Date.now() };
    await ctx.store.set(`acct:${next.username}`, next);
    return { ok: true, account: next };
  })();
  refreshLocks.set(key, task);
  try {
    return await task;
  } finally {
    refreshLocks.delete(key);
  }
}

/** 取账号（必要时静默续期）；支持 cookie 会话 + 长期设备令牌兜底 */
async function currentAccount(req, ctx, cfg) {
  const cookies = parseCookies(req.headers.get('cookie'));
  let sid = cookies[DEFAULTS.SESSION_COOKIE];
  let sess = sid ? await ctx.store.get(`sess:${sid}`) : null;
  let viaDevice = false;

  // cookie 丢失（内嵌 webview / 换端口访问）时用设备令牌恢复，不再要求重新登录
  if (!sess) {
    const dev = req.headers.get(DEFAULTS.DEVICE_HEADER);
    if (dev) {
      const rec = await ctx.store.get(`dev:${dev}`);
      if (rec?.accountId) {
        sess = { accountId: rec.accountId, createdAt: Date.now(), lastSeen: Date.now() };
        sid = randHex(24);
        await ctx.store.set(`sess:${sid}`, sess, DEFAULTS.SESSION_TTL);
        await ctx.store.set(`dev:${dev}`, { accountId: rec.accountId, lastSeen: Date.now() }, DEFAULTS.DEVICE_TTL);
        viaDevice = true;
      }
    }
  }
  if (!sess) return { error: json({ error: '未登录' }, 401) };

  let account = await ctx.store.get(`acct:${sess.accountId}`);
  if (!account) return { error: json({ error: '账号数据缺失，请重新登录' }, 401) };

  if (account.expiresAt && account.expiresAt - 60_000 < Date.now()) {
    const r = await refreshAccount(ctx, cfg, sid, account);
    if (r.ok) account = r.account;
  }

  // 滑动续期：活跃使用就不断延长，避免 7 天后又要登录
  if (!viaDevice && Date.now() - (sess.lastSeen || sess.createdAt || 0) > 7 * 864e5) {
    await ctx.store.set(`sess:${sid}`, { ...sess, lastSeen: Date.now() }, DEFAULTS.SESSION_TTL);
  }

  return { sid, account, viaDevice };
}

// ── 统一出站层：错误分类 / 凭证重放 / 退避重试 ───────────

const RETRY_MAX = 2; // 读请求在 429 / 5xx 上的重试上限
const MAX_WAIT_MS = 3000; // 单次等待上限，超过就直接把结果交回前端

function classifyStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate';
  if (status >= 500) return 'server';
  if (status >= 400) return 'client';
  return 'ok';
}

function paginationOf(r) {
  const h = r.headers;
  const get = (k, fallback) => Number(h?.get(k) || fallback);
  return {
    page: get('x-pagination-page', 1),
    pageCount: get('x-pagination-page-count', 1),
    itemCount: get('x-pagination-item-count', Array.isArray(r.data) ? r.data.length : 0),
    limit: get('x-pagination-limit', 0),
  };
}

function backoffMs(retryAfter, attempt) {
  const ra = Number(retryAfter || 0);
  if (Number.isFinite(ra) && ra > 0) return ra * 1000;
  return 300 * 2 ** attempt;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 所有数据请求的统一出口（替代各路由里分散的 traktFetch）。
 *
 * - kind：ok / auth / rate / server / client / network，前端据此给不同文案
 * - 401/403：用 refresh_token 续期后重放一次。此时请求已被上游拒绝、没有产生副作用，
 *   所以写操作同样适用；续期失败才判定为登录失效
 * - 429 / 5xx：只有读请求做有上限的退避重放；写请求直接返回，避免重复写入
 * - 网络异常：不抛出，统一收敛成 kind=network
 *
 * @returns {Promise<{ok:boolean,status:number,data:*,headers:*,kind:string,message:string,retryAfter:?string,waitSec:number,pagination:*,account:*}>}
 */
async function callTrakt(ctx, cfg, auth, target, { method = 'GET', query, body } = {}) {
  const isRead = method === 'GET';
  const tries = isRead ? RETRY_MAX : 0;
  let account = auth?.account;
  let refreshed = false;
  let out = { ok: false, status: 0, data: null, headers: null, kind: 'network', message: '未发起请求' };

  for (let attempt = 0; attempt <= tries; attempt++) {
    let r;
    try {
      r = await traktFetch(cfg, account, target, { method, query, body });
    } catch (err) {
      return {
        ok: false,
        status: 0,
        data: null,
        headers: null,
        kind: 'network',
        message: `网络请求失败：${err?.message || err}`,
        retryAfter: null,
        waitSec: 0,
        pagination: { page: 1, pageCount: 1, itemCount: 0, limit: 0 },
        account,
      };
    }

    const kind = classifyStatus(r.status);
    out = {
      ok: kind === 'ok',
      status: r.status,
      data: r.data,
      headers: r.headers,
      kind,
      message: kind === 'ok' ? '' : describeError(r),
      retryAfter: r.retryAfter,
      waitSec: 0,
      pagination: paginationOf(r),
      account,
      refreshed,
    };
    if (out.ok) return out;

    if (kind === 'auth' && !refreshed && account?.refresh) {
      refreshed = true;
      const rr = await refreshAccount(ctx, cfg, auth.sid, account);
      if (rr.ok) {
        account = rr.account;
        continue;
      }
      out.message = rr.message || '凭证已失效，请重新登录';
      break;
    }

    if (kind === 'rate' || kind === 'server') {
      const wait = backoffMs(r.retryAfter, attempt);
      out.waitSec = Math.ceil(wait / 1000);
      if (attempt < tries && wait <= MAX_WAIT_MS) {
        await sleep(wait);
        continue;
      }
    }
    break;
  }

  out.account = account;
  out.refreshed = refreshed;
  return out;
}

// ── 路径白名单（前端只能访问这些 Trakt 接口）──────────────

const ALLOW = [
  ['GET', /^\/users\/me$/],
  ['GET', /^\/users\/me\/stats$/],
  ['GET', /^\/users\/me\/watched\/(movies|shows)$/],
  ['GET', /^\/users\/me\/ratings\/(movies|shows|episodes|seasons)(\/[^/]+)?$/],
  // 我的剧评 / 短评（记录页日历详情用）
  ['GET', /^\/users\/me\/comments$/],
  ['GET', /^\/users\/me\/watchlist\/(movies|shows)$/],
  ['GET', /^\/users\/me\/favorites(\/(movies|shows))?$/],
  ['GET', /^\/users\/me\/lists$/],
  ['GET', /^\/users\/me\/lists\/[^/]+\/items(\/[^/]+)?$/],
  // 剧集季 / 分集总览（含未看与未播的集）
  ['GET', /^\/shows\/[^/]+\/seasons(\/[^/]+(\/episodes(\/[^/]+)?)?)?$/],
  // 单剧观看进度与逐集已看状态
  ['GET', /^\/shows\/[^/]+\/progress$/],
  ['GET', /^\/shows\/[^/]+\/progress\/watched$/],
  // 播出日历：/calendars/my/shows/{start}/{days}、/calendars/my/shows/new/{start}/{days}
  ['GET', /^\/calendars\/my\/(shows|movies)(\/[^/]+){0,3}$/],
  // Trakt 官方译文（无 TMDB key 时的中文化兜底）
  ['GET', /^\/(movies|shows)\/[^/]+\/translations\/[^/]+$/],
  ['GET', /^\/sync\/history(\/(movies|shows|episodes))?(\/[^/]+)?$/],
  ['GET', /^\/sync\/watchlist(\/(movies|shows|episodes|seasons))?(\/[^/]+)?$/],
  // 续播点：读列表 / 读单条 / 删单条（id 是 playback 自己的 id，不是 trakt id）
  ['GET', /^\/sync\/playback(\/(movies|shows|episodes))?(\/[^/]+)?$/],
  ['DELETE', /^\/sync\/playback\/[^/]+$/],
  ['GET', /^\/search\/((movie|show|episode),)*(movie|show|episode)(\/[^/]+)?$/],
  ['POST', /^\/sync\/history$/],
  ['POST', /^\/sync\/history\/remove$/],
  ['POST', /^\/sync\/ratings$/],
  ['POST', /^\/sync\/watchlist(\/remove)?$/],
  ['POST', /^\/sync\/favorites(\/remove)?$/],
  ['POST', /^\/users\/me\/lists$/],
  ['PUT', /^\/users\/me\/lists\/[^/]+$/],
  ['DELETE', /^\/users\/me\/lists\/[^/]+$/],
  ['POST', /^\/users\/me\/lists\/[^/]+\/items$/],
  ['POST', /^\/users\/me\/lists\/[^/]+\/items\/remove$/],
];

function allowed(method, path) {
  return ALLOW.some(([m, re]) => m === method && re.test(path));
}

// ── 导出（CSV / JSON）────────────────────────────────────

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const EXPORT_PAGE_CAP = 100;

async function exportData(ctx, cfg, auth, kind, type) {
  const rows = [];
  const limit = 100;
  let truncated = false;
  for (let page = 1; page <= EXPORT_PAGE_CAP; page++) {
    let path;
    const query = { page, limit };
    if (kind === 'history') {
      path = `/sync/history/${type || 'movies'}`;
    } else if (kind === 'ratings') {
      path = `/users/me/ratings/${type || 'movies'}`;
    } else if (kind === 'watchlist') {
      path = '/sync/watchlist';
    } else {
      throw new Error('unsupported kind');
    }
    const r = await callTrakt(ctx, cfg, auth, path, { query });
    if (r.kind === 'network') return { error: r.message, kind: 'network' };
    if (!r.ok || !Array.isArray(r.data) || r.data.length === 0) break;
    rows.push(...r.data);
    const pageCount = Number(r.pagination?.pageCount || 1);
    if (page >= pageCount) break;
    if (page === EXPORT_PAGE_CAP) truncated = true;
  }

  const flat = rows.map((it) => {
    // 子端点（/sync/history/{type}）的条目不带 type 字段，按载荷形态补全，避免导出列全空
    const detected = it.type || (it.movie ? 'movie' : it.show ? 'show' : it.episode ? 'episode' : '');
    const base = {
      type: detected,
      title: it.movie?.title || it.show?.title || it.episode?.title || '',
      year: it.movie?.year || it.show?.year || '',
      season: it.episode?.season ?? '',
      episode: it.episode?.number ?? '',
      show: it.show?.title || '',
      watched_at: it.watched_at || '',
      rating: it.rating ?? '',
      rated_at: it.rated_at || '',
      trakt_id: it.movie?.ids?.trakt || it.show?.ids?.trakt || it.episode?.ids?.trakt || '',
    };
    if (kind === 'watchlist') {
      const meta = it.movie || it.show || it.episode || {};
      base.title = meta.title || '';
      base.type = it.type || detected;
      base.listed_at = it.listed_at || '';
    }
    return base;
  });

  if (!flat.length) return { empty: true, rows: [], list: [], truncated: false };
  const cols = Object.keys(flat[0]);
  const csv = ['\ufeff' + cols.join(','), ...flat.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n');
  return { empty: false, csv, list: flat, cols, truncated };
}

// ── 备份 / 恢复：版本化格式 + 范围预览 + 回读验证 ──────────

const BACKUP_FORMAT = 'trakt-manager-backup';
const BACKUP_VERSION = 1;
const BACKUP_MAX_PAGES = 50; // 单类数据最多 5000 条，超出如实标 truncated
const BACKUP_RATING_PAGES = 10;
const BACKUP_LISTS_MAX = 100;
const BACKUP_MAX_ITEMS = 50_000; // 恢复侧防滥用上限
const BACKUP_CHUNK = 100; // Trakt sync 接口按 100 条分批写入
const DAV_KEY = 'cfg:dav';

const RATING_TYPES = ['movies', 'shows', 'episodes', 'seasons'];

/** 备份条目 → 写操作段名 + trakt id（缺失 id 的条目会被恢复侧标为 invalid） */
function backupRef(it) {
  const seg = it?.type === 'movie' ? 'movies' : it?.type === 'show' ? 'shows' : it?.type === 'episode' ? 'episodes' : it?.type === 'season' ? 'seasons' : '';
  if (!seg) return null;
  const ids = it?.[it.type]?.ids || {};
  const trakt = Number(ids.trakt) || 0;
  if (!trakt) return null;
  return { seg, type: it.type, trakt, ids };
}

const refKey = (it) => {
  const r = backupRef(it);
  return r ? `${r.seg}:${r.trakt}` : '';
};

/** 观看记录的重复键：同一集 + 同一观看时间才算重复（同一集多次观看是合法数据） */
const historyKey = (it) => {
  const k = refKey(it);
  if (!k) return '';
  return `${k}:${String(it?.watched_at || '').slice(0, 24)}`;
};

function countData(data) {
  const ratings = data.ratings || {};
  return {
    history: (data.history || []).length,
    ratings: RATING_TYPES.reduce((n, t) => n + ((ratings[t] || []).length), 0),
    watchlist: (data.watchlist || []).length,
    favorites: (data.favorites || []).length,
    lists: (data.lists || []).length,
    listItems: (data.lists || []).reduce((n, l) => n + ((l?.items || []).length), 0),
  };
}

/**
 * 拉全账号数据生成备份。默认不含任何令牌 / cookie / TMDB key / WebDAV 密码；
 * 分页拉不全时如实标 truncated，不悄悄少备份。
 */
async function collectBackup(ctx, cfg, auth, { withListItems = true } = {}) {
  const jobs = await Promise.all([
    allPages(ctx, cfg, auth, '/sync/history', { extended: 'full', limit: 100 }, BACKUP_MAX_PAGES),
    ...RATING_TYPES.map((t) =>
      allPages(ctx, cfg, auth, `/users/me/ratings/${t}`, { limit: 100 }, BACKUP_RATING_PAGES)
    ),
    allPages(ctx, cfg, auth, '/sync/watchlist', { limit: 100 }, BACKUP_MAX_PAGES),
    allPages(ctx, cfg, auth, '/users/me/favorites', { limit: 100 }, BACKUP_MAX_PAGES),
    allPages(ctx, cfg, auth, '/users/me/lists', { limit: 100 }, 1),
  ]);

  const [history, rm, rs, re, rr, watchlist, favorites, listsRes] = jobs;
  if (history.error) {
    return { error: history.error.message || '读取观看历史失败', kind: history.error.kind, waitSec: history.error.waitSec || 0 };
  }

  const ratings = { movies: rm.rows || [], shows: rs.rows || [], episodes: re.rows || [], seasons: rr.rows || [] };
  const lists = (listsRes.rows || []).slice(0, BACKUP_LISTS_MAX);
  const warnings = [];
  let truncated = {
    history: !!history.truncated,
    ratings: [rm, rs, re, rr].some((r) => r.truncated),
    watchlist: !!watchlist.truncated,
    favorites: !!favorites.truncated,
  };
  for (const r of [watchlist, favorites, listsRes, ...Object.values(ratings)]) {
    if (r.error) warnings.push(`部分评分/待看/收藏数据读取失败：${r.error.message || '上游错误'}`);
  }
  if ((listsRes.rows || []).length > BACKUP_LISTS_MAX) warnings.push(`自定义列表超过 ${BACKUP_LISTS_MAX} 个，仅备份前 ${BACKUP_LISTS_MAX} 个`);

  const out = [];
  for (const l of lists) {
    const id = l?.ids?.trakt || l?.id;
    if (!id) continue;
    let items = [];
    let itemsTruncated = false;
    if (withListItems) {
      const got = await allPages(ctx, cfg, auth, `/users/me/lists/${id}/items`, { limit: 100 }, BACKUP_MAX_PAGES);
      if (got.error) {
        warnings.push(`列表「${l.name || id}」条目读取失败：${got.error.message || '上游错误'}`);
      } else {
        items = got.rows || [];
        itemsTruncated = !!got.truncated;
      }
    }
    out.push({ ...l, items, itemsTruncated });
  }
  truncated = { ...truncated, listItems: out.some((l) => l.itemsTruncated) };

  const data = { history: history.rows || [], ratings, watchlist: watchlist.rows || [], favorites: favorites.rows || [], lists: out };
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    createdAt: new Date().toISOString(),
    app: 'trakt-manager',
    user: { username: auth.account?.username || '', name: auth.account?.name || '' },
    // 仅含展示语言这类非敏感偏好；key / 令牌一律不进备份
    settings: { displayLanguage: await getTmdbLang(ctx) },
    data,
    counts: countData(data),
    truncated,
    warnings,
  };
}

const LANG_CODE_RE = /^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/;

/** 恢复前的格式与规模校验：坏了就拒绝，不带病进写流程 */
function validateBackup(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: '备份格式无效：根节点必须是对象' };
  if (raw.format !== BACKUP_FORMAT) return { error: `备份格式无效：需要 ${BACKUP_FORMAT}` };
  const version = Number(raw.version) || 0;
  if (version !== BACKUP_VERSION) return { error: `不支持的备份版本：${version}（当前支持 ${BACKUP_VERSION}）` };
  const d = raw.data;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return { error: '备份缺少 data 字段' };

  const arr = (v, name, cap = BACKUP_MAX_ITEMS) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new Error(`备份字段 ${name} 必须是数组`);
    if (v.length > cap) throw new Error(`备份字段 ${name} 超过 ${cap} 条上限`);
    return v;
  };

  try {
    const ratingsSrc = d.ratings && typeof d.ratings === 'object' ? d.ratings : {};
    const backup = {
      format: raw.format,
      version,
      createdAt: String(raw.createdAt || '').slice(0, 32),
      app: String(raw.app || '').slice(0, 64),
      user: {
        username: String(raw.user?.username || '').slice(0, 64),
        name: String(raw.user?.name || '').slice(0, 120),
      },
      settings:
        raw.settings && LANG_CODE_RE.test(String(raw.settings.displayLanguage || ''))
          ? { displayLanguage: String(raw.settings.displayLanguage) }
          : {},
      data: {
        history: arr(d.history, 'history'),
        ratings: {
          movies: arr(ratingsSrc.movies, 'ratings.movies'),
          shows: arr(ratingsSrc.shows, 'ratings.shows'),
          episodes: arr(ratingsSrc.episodes, 'ratings.episodes'),
          seasons: arr(ratingsSrc.seasons, 'ratings.seasons'),
        },
        watchlist: arr(d.watchlist, 'watchlist'),
        favorites: arr(d.favorites, 'favorites'),
        lists: arr(d.lists, 'lists', BACKUP_LISTS_MAX),
      },
    };
    let listItems = 0;
    for (const l of backup.data.lists) {
      if (!l || typeof l !== 'object') throw new Error('列表条目必须是对象');
      l.items = arr(l.items, `lists[${String(l.name || '').slice(0, 30)}].items`);
      listItems += l.items.length;
    }
    if (listItems > BACKUP_MAX_ITEMS) return { error: `备份里的列表条目超过 ${BACKUP_MAX_ITEMS} 条上限` };
    return { backup };
  } catch (err) {
    return { error: `备份校验失败：${err?.message || err}` };
  }
}

const RESTORE_SCOPES = ['history', 'ratings', 'watchlist', 'favorites', 'lists', 'settings'];

function normalizeScopes(input) {
  const list = Array.isArray(input) ? input : RESTORE_SCOPES;
  const out = list.filter((s) => RESTORE_SCOPES.includes(s));
  return out.length ? [...new Set(out)] : RESTORE_SCOPES;
}



// ── 恢复：预览与执行（写上游，不做本地影子库）──────────

function currentSets(current) {
  const d = current?.data || {};
  const history = new Set((d.history || []).map(historyKey).filter(Boolean));
  const ratings = {};
  for (const t of RATING_TYPES) {
    ratings[t] = new Map();
    for (const it of d.ratings?.[t] || []) {
      const k = refKey(it);
      if (k) ratings[t].set(k, Number(it.rating) || 0);
    }
  }
  const setOf = (rows) => new Set((rows || []).map(refKey).filter(Boolean));
  const listIndex = new Map();
  const listByName = new Map();
  for (const l of d.lists || []) {
    const id = l?.ids?.trakt || l?.id;
    if (id) listIndex.set(`trakt:${id}`, l);
    if (l?.ids?.slug) listIndex.set(`slug:${l.ids.slug}`, l);
    if (l?.name) listByName.set(String(l.name).toLowerCase(), l);
  }
  return { history, ratings, watchlist: setOf(d.watchlist), favorites: setOf(d.favorites), listIndex, listByName };
}

/** 恢复预览：逐范围给出「会新增 / 已存在 / 冲突覆盖 / 无效」，不写任何数据 */
function restorePreview(backup, current, scopes) {
  const cur = currentSets(current);
  const sections = {};

  if (scopes.includes('history')) {
    const rows = backup.data.history;
    const dup = new Set();
    let invalid = 0;
    for (const it of rows) {
      const k = historyKey(it);
      if (!k) invalid += 1;
      else if (cur.history.has(k)) dup.add(k);
    }
    sections.history = {
      planned: rows.length,
      new: rows.length - dup.size - invalid,
      duplicate: dup.size,
      invalid,
      note: '同一集 + 同一观看时间视为重复并跳过；同一集不同时间的多次观看会保留为多条',
    };
  }

  if (scopes.includes('ratings')) {
    const totals = { planned: 0, new: 0, unchanged: 0, conflict: 0, invalid: 0 };
    const byType = {};
    for (const t of RATING_TYPES) {
      const s = { planned: 0, new: 0, unchanged: 0, conflict: 0, invalid: 0 };
      for (const it of backup.data.ratings[t]) {
        const k = refKey(it);
        s.planned += 1;
        totals.planned += 1;
        if (!k) {
          s.invalid += 1;
          totals.invalid += 1;
          continue;
        }
        const now = cur.ratings[t].get(k);
        if (now === undefined) {
          s.new += 1;
          totals.new += 1;
        } else if (now === (Number(it.rating) || 0)) {
          s.unchanged += 1;
          totals.unchanged += 1;
        } else {
          s.conflict += 1;
          totals.conflict += 1;
        }
      }
      byType[t] = s;
    }
    sections.ratings = { ...totals, byType, note: '已存在且分数相同 → 跳过；分数不同 → 覆盖为备份里的分数' };
  }

  for (const scope of ['watchlist', 'favorites']) {
    if (!scopes.includes(scope)) continue;
    const rows = backup.data[scope];
    let existing = 0;
    let invalid = 0;
    for (const it of rows) {
      const k = refKey(it);
      if (!k) invalid += 1;
      else if (cur[scope].has(k)) existing += 1;
    }
    sections[scope] = {
      planned: rows.length,
      new: rows.length - existing - invalid,
      existing,
      invalid,
      note: '已在当前清单里的条目跳过，不会重复添加',
    };
  }

  if (scopes.includes('lists')) {
    let newLists = 0;
    let existingLists = 0;
    let newItems = 0;
    let existingItems = 0;
    let invalidItems = 0;
    for (const l of backup.data.lists) {
      const found = cur.listIndex.get(`trakt:${l?.ids?.trakt}`) || cur.listIndex.get(`slug:${l?.ids?.slug || ''}`) || cur.listByName.get(String(l?.name || '').toLowerCase());
      if (found) existingLists += 1;
      else newLists += 1;
      const curItems = new Set(((found?.items || [])).map(refKey).filter(Boolean));
      for (const it of l?.items || []) {
        const k = refKey(it);
        if (!k) invalidItems += 1;
        else if (curItems.has(k)) existingItems += 1;
        else newItems += 1;
      }
    }
    sections.lists = {
      planned: backup.data.lists.length,
      newLists,
      existingLists,
      newItems,
      existingItems,
      invalidItems,
      note: '按列表 id / slug / 名称匹配：已存在的列表不再新建，只补缺失条目；名称相同的列表会被当作同一个',
    };
  }

  if (scopes.includes('settings')) {
    const want = backup.settings?.displayLanguage || '';
    const have = current.settings?.displayLanguage || '';
    const changed = Boolean(want) && want !== have;
    sections.settings = {
      planned: want ? 1 : 0,
      new: changed ? 1 : 0,
      unchanged: want && !changed ? 1 : 0,
      conflict: 0,
      note: '只恢复显示语言这类非敏感偏好；TMDB key、登录令牌、WebDAV 密码不在备份里，也无法恢复',
    };
  }

  const totals = { new: 0, skip: 0, conflict: 0, invalid: 0 };
  for (const s of Object.values(sections)) {
    totals.new += s.new || s.newLists || 0;
    totals.skip += (s.duplicate || 0) + (s.unchanged || 0) + (s.existing || 0) + (s.existingItems || 0);
    totals.conflict += s.conflict || 0;
    totals.invalid += (s.invalid || 0) + (s.invalidItems || 0);
  }
  totals.new += sections.lists?.newItems || 0;
  return { sections, totals };
}

/** Trakt sync 写接口的回读计数：added / existing / not_found */
function syncCounts(data) {
  const sum = (obj) =>
    Object.values(obj || {}).reduce((n, v) => n + (Array.isArray(v) ? v.length : Number(v) || 0), 0);
  return { added: sum(data?.added), existing: sum(data?.existing), notFound: sum(data?.not_found) };
}

/** 把条目按段名分组、剔除无效与要跳过的，切成 Trakt 可接受的小批量 */
function groupForWrite(rows, { skip = new Set(), extra = null } = {}) {
  const groups = {};
  const stats = { invalid: 0, skipped: 0, planned: 0 };
  for (const it of rows) {
    const r = backupRef(it);
    if (!r) {
      stats.invalid += 1;
      continue;
    }
    stats.planned += 1;
    const key = extra?.key ? extra.key(it, r) : refKey(it);
    if (skip.has(key)) {
      stats.skipped += 1;
      continue;
    }
    const item = { ids: r.ids };
    if (extra?.pick) Object.assign(item, extra.pick(it));
    (groups[r.seg] ||= []).push(item);
  }
  return { groups, stats };
}

async function writeGroups(ctx, cfg, auth, path, groups, label) {
  const out = { added: 0, existing: 0, failed: 0, errors: [] };
  for (const [seg, items] of Object.entries(groups)) {
    for (let i = 0; i < items.length; i += BACKUP_CHUNK) {
      const chunk = items.slice(i, i + BACKUP_CHUNK);
      const r = await callTrakt(ctx, cfg, auth, path, { method: 'POST', body: { [seg]: chunk } });
      if (r.ok) {
        const c = syncCounts(r.data);
        out.added += c.added;
        out.existing += c.existing;
        out.failed += c.notFound;
        if (c.notFound) out.errors.push(`${label}：${c.notFound} 条在上游找不到对应条目`);
      } else {
        out.failed += chunk.length;
        out.errors.push(`${label}写入失败：${r.message}`);
      }
    }
  }
  return out;
}

/** 执行恢复：逐范围写 Trakt，用上游响应计数；失败的部分如实报告，不伪装成功 */
async function applyRestore(ctx, cfg, auth, backup, current, scopes) {
  const cur = currentSets(current);
  const report = { sections: {}, errors: [] };

  if (scopes.includes('history')) {
    const { groups, stats } = groupForWrite(backup.data.history, {
      skip: cur.history,
      extra: { key: historyKey, pick: (it) => (it.watched_at ? { watched_at: it.watched_at } : {}) },
    });
    const w = await writeGroups(ctx, cfg, auth, '/sync/history', groups, '观看历史');
    report.sections.history = { planned: stats.planned, skipped: stats.skipped, invalid: stats.invalid, ...w };
    report.errors.push(...w.errors);
  }

  if (scopes.includes('ratings')) {
    const merged = [];
    const skip = new Set();
    for (const t of RATING_TYPES) {
      for (const it of backup.data.ratings[t]) {
        const k = refKey(it);
        if (!k) continue;
        const now = cur.ratings[t].get(k);
        if (now !== undefined && now === (Number(it.rating) || 0)) skip.add(k);
        merged.push(it);
      }
    }
    const { groups, stats } = groupForWrite(merged, {
      skip,
      extra: { pick: (it) => ({ rating: Math.max(0, Math.min(10, Number(it.rating) || 0)) }) },
    });
    const w = await writeGroups(ctx, cfg, auth, '/sync/ratings', groups, '评分');
    report.sections.ratings = { planned: stats.planned, skipped: stats.skipped, invalid: stats.invalid, ...w };
    report.errors.push(...w.errors);
  }

  for (const scope of ['watchlist', 'favorites']) {
    if (!scopes.includes(scope)) continue;
    const { groups, stats } = groupForWrite(backup.data[scope], { skip: cur[scope] });
    const w = await writeGroups(ctx, cfg, auth, scope === 'watchlist' ? '/sync/watchlist' : '/sync/favorites', groups, scope === 'watchlist' ? '待看清单' : '收藏');
    report.sections[scope] = { planned: stats.planned, skipped: stats.skipped, invalid: stats.invalid, ...w };
    report.errors.push(...w.errors);
  }

  if (scopes.includes('lists')) {
    const s = { planned: backup.data.lists.length, listsCreated: 0, listsKept: 0, plannedItems: 0, added: 0, existing: 0, failed: 0, invalid: 0, errors: [] };
    for (const l of backup.data.lists) {
      const found = cur.listIndex.get(`trakt:${l?.ids?.trakt}`) || cur.listIndex.get(`slug:${l?.ids?.slug || ''}`) || cur.listByName.get(String(l?.name || '').toLowerCase());
      let targetId = found?.ids?.trakt || found?.id || null;
      if (!targetId) {
        const meta = {
          name: String(l?.name || '').slice(0, 100),
          description: String(l?.description || '').slice(0, 500),
          privacy: ['public', 'private', 'friends'].includes(l?.privacy) ? l.privacy : 'private',
          display_numbers: Boolean(l?.display_numbers),
          allow_comments: Boolean(l?.allow_comments),
          ...(l?.sort_by ? { sort_by: String(l.sort_by).slice(0, 32) } : {}),
          ...(l?.sort_how ? { sort_how: String(l.sort_how).slice(0, 32) } : {}),
        };
        if (!meta.name) {
          s.failed += (l?.items || []).length;
          s.errors.push('跳过一个没有名称的列表');
          continue;
        }
        const r = await callTrakt(ctx, cfg, auth, '/users/me/lists', { method: 'POST', body: meta });
        if (r.ok && (r.data?.ids?.trakt || r.data?.id)) {
          targetId = r.data.ids?.trakt || r.data.id;
          s.listsCreated += 1;
        } else {
          s.failed += (l?.items || []).length;
          s.errors.push(`创建列表「${meta.name}」失败：${r.message}`);
          continue;
        }
      } else {
        s.listsKept += 1;
      }

      const curItems = new Set(((found?.items || [])).map(refKey).filter(Boolean));
      const { groups, stats } = groupForWrite(l?.items || [], { skip: curItems });
      s.plannedItems += stats.planned;
      s.invalid += stats.invalid;
      const w = await writeGroups(ctx, cfg, auth, `/users/me/lists/${targetId}/items`, groups, `列表「${l?.name || targetId}」`);
      s.added += w.added;
      s.existing += w.existing;
      s.failed += w.failed;
      s.errors.push(...w.errors);
    }
    report.sections.lists = s;
    report.errors.push(...s.errors);
  }

  if (scopes.includes('settings')) {
    const want = backup.settings?.displayLanguage || '';
    const have = current.settings?.displayLanguage || '';
    if (want && want !== have) {
      if (ctx.env?.TMDB_LANG) {
        report.sections.settings = { applied: 0, skipped: 1, note: '显示语言由环境变量 TMDB_LANG 指定，本次不覆盖' };
      } else {
        await ctx.store.set('cfg:tmdb_lang', { lang: want, savedAt: Date.now() });
        report.sections.settings = { applied: 1, skipped: 0 };
      }
    } else {
      report.sections.settings = { applied: 0, skipped: 1 };
    }
  }

  if (Object.values(report.sections).some((s) => s.added)) await bumpStatsVersion(ctx, auth.account);
  return report;
}

// ── WebDAV 自动备份：配置 / 排程 / 执行 ──────────────────

function localParts(ms, tz) {
  const d = new Date(ms + tz * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return {
    y: d.getUTCFullYear(),
    m: d.getUTCMonth() + 1,
    d: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    dow: d.getUTCDay(), // 0=周日
    key: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`,
  };
}

function weekKey(ms, tz) {
  const p = localParts(ms, tz);
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

function monthKey(ms, tz) {
  const p = localParts(ms, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}`;
}

/** 到点判断：按用户时区折算的「天 / 周 / 月」内只跑一次 */
function backupDue(conf, now = Date.now()) {
  const p = localParts(now, conf.tz || 0);
  // 执行时间精确到分钟：比到点时刻早就不算到期
  if (p.hour * 60 + p.minute < (conf.hour ?? 3) * 60 + (conf.minute ?? 0)) return false;
  const last = conf.lastRunAt ? localParts(conf.lastRunAt, conf.tz || 0) : null;
  if (conf.frequency === 'weekly' && p.dow !== conf.weekday) return false;
  if (conf.frequency === 'monthly' && p.d !== conf.day) return false;
  if (!last) return true;
  if (conf.frequency === 'daily') return p.key !== last.key;
  if (conf.frequency === 'weekly') return weekKey(now, conf.tz || 0) !== weekKey(conf.lastRunAt, conf.tz || 0);
  return monthKey(now, conf.tz || 0) !== monthKey(conf.lastRunAt, conf.tz || 0);
}

/** 下一次应运行的时间（UTC 毫秒），给设置页展示 */
function nextBackupAt(conf, now = Date.now()) {
  const tz = conf.tz || 0;
  const p = localParts(now, tz);
  const hour = conf.hour ?? 3;
  const minute = conf.minute ?? 0;
  const toUtc = (y, m, d, h = hour, mi = minute) => Date.UTC(y, m - 1, d, h, mi, 0, 0) - tz * 60000;
  if (conf.frequency === 'daily') {
    let at = toUtc(p.y, p.m, p.d);
    if (at <= now) at += 864e5;
    return at;
  }
  if (conf.frequency === 'weekly') {
    const base = Date.UTC(p.y, p.m - 1, p.d);
    for (let i = 0; i < 8; i++) {
      const dayMs = base + i * 864e5;
      if (new Date(dayMs).getUTCDay() !== conf.weekday) continue;
      const at = dayMs + hour * 3600e3 + minute * 60000 - tz * 60000;
      if (at > now) return at;
    }
    return now + 864e5;
  }
  const day = Math.max(1, Math.min(28, conf.day || 1));
  let at = toUtc(p.y, p.m, day);
  if (at <= now) at = toUtc(p.y, p.m + 1, day);
  return at;
}

/** 校验并归一化 WebDAV 配置；密码留空表示沿用已保存的值 */
function normalizeDavConf(prev, body, username) {
  const b = body || {};
  const urlRaw = String(b.url ?? prev?.url ?? '').trim();
  let url = '';
  if (urlRaw) {
    if (!/^https?:\/\//i.test(urlRaw)) return { error: 'WebDAV 地址必须以 http:// 或 https:// 开头' };
    let u;
    try {
      u = new URL(urlRaw);
    } catch {
      return { error: 'WebDAV 地址格式无效' };
    }
    if (u.username || u.password) return { error: '不要把账号密码写进 URL，请分开填写' };
    url = `${u.origin}${u.pathname}`.replace(/\s+/g, '');
    if (!url.endsWith('/')) url += '/';
  }
  const enabled = b.enabled === undefined ? Boolean(prev?.enabled ?? false) : Boolean(b.enabled);
  if (enabled && !url) return { error: '启用自动备份前必须填写 WebDAV 目录地址' };
  const frequency = ['daily', 'weekly', 'monthly'].includes(b.frequency ?? prev?.frequency) ? b.frequency ?? prev?.frequency : 'daily';
  const hour = Math.max(0, Math.min(23, Math.round(Number(b.hour ?? prev?.hour ?? 3))));
  const minute = Math.max(0, Math.min(59, Math.round(Number(b.minute ?? prev?.minute ?? 0))));
  const weekday = Math.max(0, Math.min(6, Math.round(Number(b.weekday ?? prev?.weekday ?? 1))));
  const day = Math.max(1, Math.min(28, Math.round(Number(b.day ?? prev?.day ?? 1))));
  const keep = Math.max(1, Math.min(100, Math.round(Number(b.keep ?? prev?.keep ?? 10))));
  const tzRaw = Number(b.tz ?? prev?.tz ?? 0);
  const tz = Number.isFinite(tzRaw) ? Math.max(-840, Math.min(840, Math.round(tzRaw))) : 0;
  const password = b.clearPassword
    ? ''
    : b.password !== undefined && String(b.password || '').length
      ? String(b.password).slice(0, 500)
      : prev?.password || '';
  return {
    conf: {
      url,
      username: String(b.username ?? prev?.username ?? '').trim().slice(0, 200),
      password,
      enabled,
      frequency,
      hour,
      minute,
      weekday,
      day,
      keep,
      tz,
      owner: prev?.owner || username,
      savedAt: Date.now(),
      ...(prev?.lastRunAt ? { lastRunAt: prev.lastRunAt } : {}),
      ...(prev?.lastResult ? { lastResult: prev.lastResult } : {}),
      ...(prev?.lastManualAt ? { lastManualAt: prev.lastManualAt } : {}),
      ...(prev?.lastManualResult ? { lastManualResult: prev.lastManualResult } : {}),
    },
  };
}

/** 对外配置：密码只报“有没有”，绝不下发 */
function publicDavConf(conf) {
  if (!conf) {
    return { configured: false, enabled: false, frequency: 'daily', hour: 3, minute: 0, weekday: 1, day: 1, keep: 10, tz: 0, nextRunAt: null };
  }
  return {
    configured: Boolean(conf.url),
    enabled: Boolean(conf.enabled),
    url: conf.url || '',
    username: conf.username || '',
    hasPassword: Boolean(conf.password),
    frequency: conf.frequency || 'daily',
    hour: conf.hour ?? 3,
    minute: conf.minute ?? 0,
    weekday: conf.weekday ?? 1,
    day: conf.day ?? 1,
    keep: conf.keep ?? 10,
    tz: conf.tz || 0,
    owner: conf.owner || '',
    lastRunAt: conf.lastRunAt || null,
    lastResult: conf.lastResult || null,
    lastManualAt: conf.lastManualAt || null,
    lastManualResult: conf.lastManualResult || null,
    nextRunAt: conf.enabled && conf.url ? nextBackupAt(conf) : null,
  };
}

const davFileName = (at = new Date()) => {
  const s = new Date(at).toISOString();
  return `${BACKUP_PREFIX}${s.slice(0, 10).replace(/-/g, '')}-${s.slice(11, 19).replace(/:/g, '')}.json`;
};

/** 生成一次备份并上传到 WebDAV，随后按 keep 清理最旧的文件 */
async function runDavBackup(ctx, cfg, conf, account, { manual = false, now = Date.now() } = {}) {
  if (!conf?.url) return { ok: false, message: '尚未配置 WebDAV 目录地址' };
  const built = await collectBackup(ctx, cfg, { sid: '', account });
  if (built.error) return { ok: false, message: built.error, kind: built.kind, waitSec: built.waitSec || 0 };

  const ensure = await davEnsureDir(conf);
  if (!ensure.ok) return { ...ensure, message: `${ensure.message}（请确认目录已存在或允许创建）` };

  const name = davFileName(now);
  const put = await davPut(conf, name, JSON.stringify(built));
  if (!put.ok) return put;

  const result = { ok: true, name, createdAt: built.createdAt, counts: built.counts, truncated: built.truncated };
  if (Number(conf.keep) > 1) {
    const list = await davList(conf);
    if (list.ok) {
      const mine = (list.files || []).filter((f) => f.name.startsWith(BACKUP_PREFIX) && f.name.endsWith('.json'));
      const extra = mine.slice().sort((a, b) => b.name.localeCompare(a.name)).slice(Number(conf.keep));
      const removed = [];
      for (const f of extra) {
        const del = await davDelete(conf, f.name);
        if (del.ok) removed.push(f.name);
      }
      if (removed.length) result.removed = removed;
    } else {
      result.cleanupWarning = `备份已上传，但清理旧文件失败：${list.message}`;
    }
  }

  const next = { ...conf };
  if (manual) {
    next.lastManualAt = now;
    next.lastManualResult = result;
  } else {
    next.lastRunAt = now;
    next.lastResult = result;
  }
  await ctx.store.set(DAV_KEY, next);
  return { ...result, config: publicDavConf(next) };
}

/** 定时入口：Node 用 interval 轮询，Workers 用 cron 调用；store 锁防并发双跑 */
export async function runDueBackups(ctx, now = Date.now()) {
  const conf = await ctx.store.get(DAV_KEY);
  if (!conf?.enabled || !conf.url || !backupDue(conf, now)) return { ran: false, reason: 'not-due' };
  const lock = await ctx.store.get('dav:lock');
  if (lock) return { ran: false, reason: 'locked' };
  await ctx.store.set('dav:lock', { at: Date.now() }, 900);

  try {
    const account = await ctx.store.get(`acct:${conf.owner}`);
    if (!account) {
      const next = { ...conf, lastRunAt: Date.now(), lastResult: { ok: false, message: '备份账号不存在或已被清空，请重新登录后再试' } };
      await ctx.store.set(DAV_KEY, next);
      return { ran: true, ok: false, message: next.lastResult.message };
    }
    const cfg = env(ctx);
    const r = await runDavBackup(ctx, cfg, conf, account, { manual: false, now });
    return { ran: true, ...r };
  } finally {
    await ctx.store.delete('dav:lock');
  }
}

// ── 双向同步：状态读取与写入 ─────────────────────────────

const TYPE_PATH = { movie: 'movies', show: 'shows', episode: 'episodes', season: 'seasons' };

function describeError(r) {
  const d = r.data;
  if (typeof d === 'string') return d.slice(0, 120) || `HTTP ${r.status}`;
  return d?.error_description || d?.error || d?.message || `HTTP ${r.status}`;
}

/** 读 Trakt 端的真实状态（已看次数/最近时间、评分、待看、收藏）。 */
async function readState(ctx, cfg, auth, type, traktId) {
  const seg = TYPE_PATH[type] || 'movies';
  const canFavorite = type === 'movie' || type === 'show';
  if (!traktId) {
    return {
      watched: { count: 0, last: null },
      rating: null,
      watchlist: false,
      ...(canFavorite ? { favorite: false } : {}),
    };
  }
  const [hist, rate, wl, fav] = await Promise.all([
    callTrakt(ctx, cfg, auth, `/sync/history/${seg}/${traktId}`),
    callTrakt(ctx, cfg, auth, `/users/me/ratings/${seg}/${traktId}`),
    callTrakt(ctx, cfg, auth, `/sync/watchlist/${seg}/${traktId}`),
    canFavorite
      ? callTrakt(ctx, cfg, auth, '/users/me/favorites', { query: { limit: 100 } })
      : Promise.resolve(null),
  ]);
  const list = Array.isArray(hist.data) ? hist.data : [];
  const last = list.map((w) => w.watched_at).filter(Boolean).sort().pop() || null;
  const rating = rate.ok && typeof rate.data?.rating === 'number' ? rate.data.rating : null;
  const wlData = wl.ok ? wl.data : null;
  const watchlist = Boolean(
    wlData && ((Array.isArray(wlData) && wlData.length) || wlData.listed_at || Object.keys(wlData).length)
  );
  const favorite = fav
    ? fav.ok
      ? (Array.isArray(fav.data) ? fav.data : []).some((it) => String(it?.[type]?.ids?.trakt || '') === String(traktId))
      : null
    : false;
  // 状态源失败时保留 degraded；收藏读取失败用 null，不能伪装成「未收藏」。
  const failed = [hist, rate, wl, ...(fav ? [fav] : [])].filter((r) => r.kind === 'network').length;
  const degraded = failed || (fav && !fav.ok);
  return {
    watched: { count: list.length, last },
    rating,
    watchlist,
    ...(canFavorite ? { favorite } : {}),
    ...(degraded ? { degraded: true, kind: 'network', message: '部分状态读取失败，显示的可能不是最新值' } : {}),
  };
}

/** 把「现在 / 发布日 / 自定义 / 未知」换算成 Trakt 接受的 watched_at */
async function resolveWhen(ctx, when, { type, date, at, traktId, tmdbId, season, number }) {
  if (when === 'custom') {
    // 前端已按浏览器时区把「日期 + 时分」换算成 UTC 时间点；没有时分时退回当天中午
    const ts = at ? Date.parse(at) : NaN;
    if (!Number.isNaN(ts)) return new Date(ts).toISOString();
    return date ? `${String(date).slice(0, 10)}T12:00:00.000Z` : null;
  }
  if (when === 'unknown') return '1970-01-01T12:00:00.000Z';
  if (when === 'released') {
    try {
      const meta = await resolveArt(ctx, { type, traktId, tmdbId, season, number });
      const d = meta?.episode?.first_aired || meta?.released || '';
      return d ? `${String(d).slice(0, 10)}T12:00:00.000Z` : null;
    } catch {
      return null;
    }
  }
  return when === 'now' ? new Date().toISOString() : null;
}

// ── 播出日历：整月聚合 ───────────────────────────────────

const CAL_TTL = 600; // 排期一天最多变几次，10 分钟够用

/** YYYY-MM → 首日与当月天数（用 UTC 算月末，避开本地时区造成的偏移） */
function monthRange(month) {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start: `${month}-01`, days: last };
}

/**
 * 一个月「在看」剧集的播出排期，按日期分组后写进 store。
 * 只保留前端要用的字段：格子要封面 + 数量，右侧面板要剧名 / 年份 / 集号。
 *
 * 注意必须用 `/calendars/.../{start}/{days}` 形态：`{start}/{end}` 在 Trakt 上会
 * 只返回开头一小段（实测 10 月只到 8 号、29 条），看起来就是「9 号之后没数据」。
 * `tz` 是浏览器时区（分钟，东为正），用来把 UTC 的 first_aired 折算成用户当天。
 */
async function calendarMonth(ctx, cfg, auth, month, tz = 0) {
  const key = `cal:v3:${auth.account?.username || auth.sid}:${month}:${tz}`;
  const hit = await ctx.store.get(key);
  if (hit) return { ...hit, cached: true };

  const { start, days: count } = monthRange(month);
  const r = await callTrakt(ctx, cfg, auth, `/calendars/my/shows/${start}/${count}`, {
    query: { extended: 'full' },
  });
  if (!r.ok) {
    return { error: r.message || '获取播出排期失败', kind: r.kind, waitSec: r.waitSec || 0, status: r.status };
  }

  const now = Date.now();
  const shift = tz * 60000;
  const prefix = `${month}-`;
  const days = {};
  let total = 0;
  for (const it of Array.isArray(r.data) ? r.data : []) {
    const ep = it?.episode;
    const show = it?.show;
    const first = it?.first_aired || '';
    if (!ep || !show || !first) continue;
    const ts = Date.parse(first);
    if (!Number.isFinite(ts)) continue;
    const day = new Date(ts + shift).toISOString().slice(0, 10);
    if (!day.startsWith(prefix)) continue; // 日历会把下个月头一天也带回来，丢掉
    if (!days[day]) days[day] = [];
    days[day].push({
      first_aired: first,
      aired: Date.parse(first) <= now,
      show: {
        trakt: show.ids?.trakt ?? null,
        tmdb: show.ids?.tmdb ?? null,
        slug: show.ids?.slug || '',
        title: show.title || '',
        year: show.year || null,
      },
      episode: {
        season: ep.season ?? null,
        number: ep.number ?? null,
        title: ep.title || '',
        ids: ep.ids || {},
      },
    });
    total += 1;
  }
  Object.keys(days).forEach((d) => days[d].sort((a, b) => String(a.first_aired).localeCompare(String(b.first_aired))));

  const payload = { month, days, total };
  await ctx.store.set(key, payload, CAL_TTL);
  return payload;
}

// ── 概览统计：整段历史在服务端聚合 ───────────────────────

const STATS_TTL = 300; // 秒；写操作会 bump 版本号，缓存立即失效
// 当月/当年还在长数据：换个设备记一笔（手机 App、Trakt 网页）时本机看不到，所以只压 2 分钟
const STATS_TTL_LIVE = 120;
const STATS_MAX_PAGES = 50; // 历史最多 5000 条（够一个重度用户一年），超出标 truncated
const STATS_RATING_PAGES = 5; // 电影/剧集评分各取前 500 条
const STATS_CONCURRENCY = 5; // 分页并发上限，太高容易撞上 Trakt 限流

/** 统计缓存版本号：写操作后写一个新值，旧缓存键自然失去引用并在 TTL 后过期 */
async function bumpStatsVersion(ctx, account) {
  const username = account?.username;
  if (!username) return;
  const cur = Number(await ctx.store.get(`statsver:${username}`)) || 0;
  await ctx.store.set(`statsver:${username}`, cur + 1);
}

/**
 * 分页拉全（最多 maxPages 页）。
 * 第一页失败直接整体失败；后续页失败只标 truncated，不把已经拿到的数据丢掉。
 */
async function allPages(ctx, cfg, auth, target, query, maxPages) {
  const first = await callTrakt(ctx, cfg, auth, target, { query: { ...query, page: 1 } });
  if (!first.ok) return { error: first };
  const rows = Array.isArray(first.data) ? first.data.slice() : [];
  const pageCount = Math.max(1, Number(first.pagination?.pageCount || 1));
  const pages = Math.min(pageCount, maxPages);
  const rest = [];
  for (let p = 2; p <= pages; p++) rest.push(p);

  let partial = false;
  for (let i = 0; i < rest.length; i += STATS_CONCURRENCY) {
    const chunk = rest.slice(i, i + STATS_CONCURRENCY);
    const got = await Promise.all(chunk.map((p) => callTrakt(ctx, cfg, auth, target, { query: { ...query, page: p } })));
    const authFail = got.find((r) => r.kind === 'auth');
    if (authFail) return { error: authFail }; // 凭证失效就别继续打了
    for (const r of got) {
      if (r.ok && Array.isArray(r.data)) rows.push(...r.data);
      else partial = true;
    }
  }
  return { rows, truncated: pageCount > pages || partial };
}

/**
 * 观看历史 → 按天 / 按小时 / 按类型聚合。
 *
 * 口径：
 * - 日期与小时按用户时区折算（tz 分钟，东为正）；先把时间戳加偏移再取 UTC 字段，得到的就是本地日期/小时
 * - from / to（本地日期）用来裁掉「请求区间多要的那一天」，见 statsSummary 里 start_at/end_at 的处理
 * - 时长取条目自带 runtime（分集优先 episode.runtime，缺失用 show.runtime）；没有 runtime 的条目不计时长
 * - 类型优先用 TMDB 的真实类型（genreMap，见 resolveGenres），取不到才回退 Trakt 自带的 genres
 * - 类型按分钟加权；条目没有类型时给 1 的权重，让「未分类」占比不至于为 0
 * - 小时桶额外记电影/剧集各自的数量（hm / he），柱状图据此分色堆叠
 */
function aggregateHistory(rows, shift, from, to, genreMap, lang = 'zh-CN') {
  const days = {};
  const genres = {};
  let minutes = 0;
  let movies = 0;
  let episodes = 0;
  let plays = 0;
  let untagged = 0;

  for (const it of Array.isArray(rows) ? rows : []) {
    const ep = it?.episode;
    const mv = it?.movie;
    if (!ep && !mv) continue;
    const ts = Date.parse(it.watched_at || '');
    if (!Number.isFinite(ts)) continue;
    const local = new Date(ts + shift);
    const key = local.toISOString().slice(0, 10);
    if ((from && key < from) || (to && key > to)) continue;
    const hour = local.getUTCHours();
    const rt = Number((ep ? ep.runtime : mv.runtime) || it.show?.runtime || 0);

    if (!days[key]) days[key] = { plays: 0, minutes: 0, movies: 0, episodes: 0, hours: new Array(24).fill(0), hm: new Array(24).fill(0), he: new Array(24).fill(0) };
    const day = days[key];
    day.plays += 1;
    day.minutes += rt;
    day.hours[hour] += 1;
    if (ep) {
      day.episodes += 1;
      day.he[hour] += 1;
      episodes += 1;
    } else {
      day.movies += 1;
      day.hm[hour] += 1;
      movies += 1;
    }
    plays += 1;
    minutes += rt;

    const media = ep ? it.show : mv;
    const ids = media?.ids || {};
    const gkey = `${ep ? 'show' : 'movie'}:${ids.trakt || ids.tmdb || ''}`;
    const list = (gkey && genreMap?.get(gkey)) || (ep ? it.show?.genres : mv.genres) || [];
    if (!list.length) untagged += rt || 1;
    for (const g of list) {
      // 回退到 Trakt 时拿到的是 slug（donghua / action …），按共用语言转成展示名
      const name = genreLabel(g, lang);
      genres[name] = (genres[name] || 0) + (rt || 1);
    }
  }

  return { days, genres, minutes, movies, episodes, plays, untagged };
}

/**
 * 观看记录 → 需要向 TMDB 查类型的去重条目。
 * 上限 150 部：年视图可能几百部，全查会把首屏拖到十几秒，超出的部分回退 Trakt 自带的类型。
 */
function genreTargets(rows) {
  const seen = new Map();
  for (const it of Array.isArray(rows) ? rows : []) {
    const mv = it?.movie;
    const m = mv || it?.show;
    if (!m) continue;
    const type = mv ? 'movie' : 'show';
    const ids = m.ids || {};
    if (!ids.trakt && !ids.tmdb) continue;
    const k = `${type}:${ids.trakt || ids.tmdb}`;
    if (seen.has(k)) continue;
    seen.set(k, { type, traktId: ids.trakt, tmdbId: ids.tmdb });
    if (seen.size >= 150) break;
  }
  return [...seen.values()];
}

/** 用户时区下的今天（YYYY-MM-DD） */
function localToday(shift) {
  return new Date(Date.now() + shift).toISOString().slice(0, 10);
}

/** 用户时区下本周一（YYYY-MM-DD，周一为一周起点） */
function localMonday(shift) {
  const d = new Date(Date.now() + shift);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** 日期字符串加减天数（纯 UTC 日期运算，不涉及时区） */
function shiftDay(date, n) {
  const d = new Date(`${date}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** 月份字符串加减（'YYYY-MM'） */
function shiftMonth(month, n) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 把按天聚合里 [from, to] 这一段累加起来（对比窗口复用一个请求） */
function sumDays(agg, from, to) {
  const out = { minutes: 0, movies: 0, episodes: 0, plays: 0 };
  const days = agg?.days || {};
  for (const key of Object.keys(days)) {
    if (key < from || key > to) continue;
    const rec = days[key];
    out.minutes += rec.minutes || 0;
    out.movies += rec.movies || 0;
    out.episodes += rec.episodes || 0;
    out.plays += rec.plays || 0;
  }
  return out;
}

/** 最近收藏的一部（按 listed_at 取最新） */
async function latestFavorite(ctx, cfg, auth) {
  const r = await callTrakt(ctx, cfg, auth, '/users/me/favorites', { query: { extended: 'full', limit: 100 } });
  if (!r.ok || !Array.isArray(r.data)) return null;
  const rows = r.data.filter((it) => it && (it.movie || it.show));
  if (!rows.length) return null;
  const latest = rows.reduce((a, b) => (String(b.listed_at || '') > String(a.listed_at || '') ? b : a));
  const isMovie = !!latest.movie;
  const m = latest.movie || latest.show || {};
  return {
    kind: isMovie ? 'movie' : 'show',
    ids: m.ids || {},
    title: m.title || '',
    year: m.year || '',
    at: latest.listed_at || '',
  };
}

/**
 * 所选时段内的电影/剧集评分。
 * 口径：按 rated_at 的 UTC 日期落在区间内统计（评分没有精确到时分，跨时区按天差不影响结论）。
 */
async function ratingsInRange(ctx, cfg, auth, start, end, shift = 0) {
  const empty = { count: 0, avg: 0, dist: {}, recent: [] };
  const [mv, sh] = await Promise.all([
    allPages(ctx, cfg, auth, '/users/me/ratings/movies', { limit: 100 }, STATS_RATING_PAGES),
    allPages(ctx, cfg, auth, '/users/me/ratings/shows', { limit: 100 }, STATS_RATING_PAGES),
  ]);
  if (mv.error && sh.error) return { ...empty, degraded: true };

  const rows = [...(mv.rows || []), ...(sh.rows || [])]
    .filter((it) => it && (it.movie || it.show))
    .filter((it) => {
      // rated_at 是 UTC，和观看记录一样要折成用户本地日期再比区间
      const ts = Date.parse(it.rated_at || '');
      if (!Number.isFinite(ts)) return false;
      const d = new Date(ts + shift).toISOString().slice(0, 10);
      return d >= start && d <= end;
    })
    .sort((a, b) => String(b.rated_at || '').localeCompare(String(a.rated_at || '')));

  const dist = {};
  for (const it of rows) {
    const k = Number(it.rating) || 0;
    if (k) dist[k] = (dist[k] || 0) + 1;
  }
  let total = 0;
  let count = 0;
  for (const [k, v] of Object.entries(dist)) {
    total += Number(k) * v;
    count += v;
  }
  return {
    count: rows.length,
    avg: count ? total / count : 0,
    dist,
    recent: rows.slice(0, 3).map((it) => {
      const m = it.movie || it.show || {};
      return { kind: it.movie ? 'movie' : 'show', title: m.title || '', ids: m.ids || {}, rating: it.rating, rated_at: it.rated_at || '' };
    }),
    ...(mv.error || sh.error ? { degraded: true } : {}),
  };
}

/** 概览所需全部数据的服务端聚合（按用户 + 时间范围 + 时区缓存） */
/* ── 沉浸背景：按来源挑一批条目，图片仍走 /api/poster 代理（同源、带缓存） ── */

const BACKDROP_SOURCES = ['recent', 'favorites', 'watchlist', 'rated'];

async function backdropRows(cfg, account, source) {
  const query = { limit: 60, extended: 'full' };
  if (source === 'rated') {
    const [mv, sh] = await Promise.all([
      traktFetch(cfg, account, '/users/me/ratings/movies', { query }),
      traktFetch(cfg, account, '/users/me/ratings/shows', { query }),
    ]);
    return [...(mv.data || []), ...(sh.data || [])];
  }
  const path =
    source === 'favorites' ? '/users/me/favorites' : source === 'watchlist' ? '/sync/watchlist' : '/sync/history';
  const r = await traktFetch(cfg, account, path, { query });
  return Array.isArray(r.data) ? r.data : [];
}

/**
 * 背景候选：去重后最多 10 条，只回 id 与标题，URL 由前端按 /api/poster?...&art=backdrop 拼。
 * 缓存 10 分钟——背景不属于数据视图，不值得每次进页面都打上游。
 */
async function backdropSummary(ctx, cfg, auth, source) {
  const src = BACKDROP_SOURCES.includes(source) ? source : 'recent';
  const username = auth.account?.username || auth.sid;
  const key = `bd:v1:${username}:${src}`;
  const hit = await ctx.store.get(key);
  if (hit) return { ...hit, cached: true };

  let rows;
  try {
    rows = await backdropRows(cfg, auth.account, src);
  } catch {
    return { error: '读取封面失败', kind: 'network' };
  }

  const seen = new Set();
  const items = [];
  for (const it of rows) {
    const m = it?.movie || it?.show;
    if (!m) continue;
    const type = it.movie ? 'movie' : 'show';
    const ids = m.ids || {};
    if (!ids.trakt && !ids.tmdb) continue;
    const idk = `${type}:${ids.trakt || ids.tmdb}`;
    if (seen.has(idk)) continue;
    seen.add(idk);
    items.push({
      type,
      trakt: String(ids.trakt || ''),
      tmdb: String(ids.tmdb || ''),
      title: m.title || '',
      year: m.year || '',
    });
    if (items.length >= 10) break;
  }

  const payload = { source: src, items };
  await ctx.store.set(key, payload, 600);
  return payload;
}

async function statsSummary(ctx, cfg, auth, { period, month, tz }) {
  const username = auth.account?.username || auth.sid;
  const version = (await ctx.store.get(`statsver:${username}`)) || 0;
  // 语言进 key：类型名跟着共用语言走，切了语言要重新算，不能吃中文的旧缓存
  const lang = await getTmdbLang(ctx);
  const key = `stats:v5:${username}:${version}:${lang}:${period}:${month}:${tz}`;
  const hit = await ctx.store.get(key);
  if (hit) return { ...hit, cached: true };

  const shift = tz * 60000;
  const today = localToday(shift);
  const y = Number(month.slice(0, 4));
  let start;
  let end;
  if (period === 'year') {
    start = `${y}-01-01`;
    end = `${y}-12-31` > today ? today : `${y}-12-31`;
  } else {
    const { start: first, days } = monthRange(month);
    const last = `${month}-${String(days).padStart(2, '0')}`;
    start = first;
    end = last > today ? today : last;
  }
  if (end < start) end = start; // 未来的月份：收敛成一天，别让区间倒挂

  const weekStart = localMonday(shift);
  const wd = new Date(`${weekStart}T00:00:00.000Z`);
  wd.setUTCDate(wd.getUTCDate() + 6);
  const weekEnd = wd.toISOString().slice(0, 10);

  // 对比窗口：卡片右上角的「比上月同期 / 比前一天 / 比上周同期」都从这一段里取，
  // 三段挨在一起，合成一次请求（区间取它们的并集）。
  const yesterday = shiftDay(today, -1);
  const prevWeekStart = shiftDay(weekStart, -7);
  const prevWeekEnd = shiftDay(weekEnd, -7);
  let cmpStart = prevWeekStart < yesterday ? prevWeekStart : yesterday;
  let cmpEnd = prevWeekEnd > yesterday ? prevWeekEnd : yesterday;
  let prevMonthWin = null;
  if (period === 'month') {
    // 当月看到今天，历史月份看整月，上月同期取同样的天数
    const passed = month === today.slice(0, 7) ? Number(today.slice(8)) : monthRange(month).days;
    const pk = shiftMonth(month, -1);
    prevMonthWin = {
      start: `${pk}-01`,
      end: `${pk}-${String(Math.min(passed, monthRange(pk).days)).padStart(2, '0')}`,
    };
    if (prevMonthWin.start < cmpStart) cmpStart = prevMonthWin.start;
    if (prevMonthWin.end > cmpEnd) cmpEnd = prevMonthWin.end;
  }

  // Trakt 的 start_at/end_at 是按 UTC 日切的，本地时区下会把首尾两天各削掉一截
  // （+08 的「今天」白天 = UTC 昨天下午，end_at=今天 会整段丢掉），
  // 所以两端各多要一天，折成本地日期后再按 [start, end] 裁掉。
  const [main, week, cmp, fav, rated] = await Promise.all([
    allPages(
      ctx,
      cfg,
      auth,
      '/sync/history',
      { extended: 'full', limit: 100, start_at: shiftDay(start, -1), end_at: shiftDay(end, 1) },
      STATS_MAX_PAGES
    ),
    allPages(
      ctx,
      cfg,
      auth,
      '/sync/history',
      { extended: 'full', limit: 100, start_at: shiftDay(weekStart, -1), end_at: shiftDay(weekEnd, 1) },
      3
    ),
    allPages(
      ctx,
      cfg,
      auth,
      '/sync/history',
      { extended: 'full', limit: 100, start_at: shiftDay(cmpStart, -1), end_at: shiftDay(cmpEnd, 1) },
      3
    ),
    latestFavorite(ctx, cfg, auth),
    ratingsInRange(ctx, cfg, auth, start, end, shift),
  ]);
  if (main.error) {
    return { error: main.error.message || '读取观看记录失败', kind: main.error.kind, waitSec: main.error.waitSec || 0 };
  }

  // 类型名以 TMDB 为准（它是影视库的权威分类，且直接给中文名）；
  // 查不到（没配 key / 没 tmdb id / 超时）时 aggregateHistory 内部回退 Trakt genres
  const genreMap = await Promise.race([
    resolveGenres(ctx, genreTargets([...(main.rows || []), ...(week.rows || []), ...(cmp.rows || [])])),
    new Promise((r) => setTimeout(() => r(new Map()), 6000)),
  ]).catch(() => new Map());

  const agg = aggregateHistory(main.rows, shift, start, end, genreMap, lang);
  const wk = aggregateHistory(week.rows || [], shift, weekStart, weekEnd, genreMap, lang);
  const pv = aggregateHistory(cmp.rows || [], shift, cmpStart, cmpEnd, genreMap, lang);
  const todayRec = agg.days[today] || wk.days[today] || null;
  const weekSum = sumDays(wk, weekStart, weekEnd);
  const prevWeekSum = sumDays(pv, prevWeekStart, prevWeekEnd);
  const compare = {
    // 年视图没有「上月同期」，前端据此不显示这一行
    month: prevMonthWin ? { cur: agg.minutes, prev: sumDays(pv, prevMonthWin.start, prevMonthWin.end).minutes } : null,
    day: { cur: todayRec?.minutes || 0, prev: sumDays(pv, yesterday, yesterday).minutes },
    week: { cur: weekSum.minutes, prev: prevWeekSum.minutes, prevPlays: prevWeekSum.plays },
  };
  const payload = {
    period,
    month,
    start,
    end,
    tz,
    ...agg,
    truncated: !!main.truncated,
    week: { start: weekStart, end: weekEnd, ...wk },
    rated,
    fav,
    compare,
  };
  const live = period === 'year' ? month.slice(0, 4) === today.slice(0, 4) : month === today.slice(0, 7);
  await ctx.store.set(key, payload, live ? STATS_TTL_LIVE : STATS_TTL);
  return payload;
}

// ── 路由 ─────────────────────────────────────────────────

export async function handleRequest(req, ctx) {
  const cfg = env(ctx);
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/$/, '') || '/';

  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });

  try {
    // 会话查询（cookie 或设备令牌均可）
    if (path === '/api/session' && req.method === 'GET') {
      const { error, account, sid, viaDevice } = await currentAccount(req, ctx, cfg);
      if (error) return json({ loggedIn: false });
      const headers = {};
      if (viaDevice && sid) {
        headers['set-cookie'] = buildCookie(DEFAULTS.SESSION_COOKIE, sid, {
          maxAge: DEFAULTS.SESSION_TTL,
          secure: secureCookie(req, cfg),
        });
      }
      const avatar = await ensureAvatar(ctx, cfg, account);
      return json(
        {
          loggedIn: true,
          user: { username: account.username, name: account.name || account.username, avatar },
          expiresAt: account.expiresAt,
          sessionDays: Math.round(DEFAULTS.SESSION_TTL / 86400),
        },
        200,
        headers
      );
    }

    // ① 发送验证码
    if (path === '/api/auth/start' && req.method === 'POST') {
      const body = await readJson(req);
      const email = String(body.email || '').trim().toLowerCase();
      if (!EMAIL_RE.test(email)) return json({ ok: false, message: '邮箱格式无效' }, 400);

      // 同一浏览器会话 60s 冷却（Trakt 侧有发信限流）
      const cookies = parseCookies(req.headers.get('cookie'));
      const key = cookies[DEFAULTS.SESSION_COOKIE] || '';
      if (key) {
        const prev = await ctx.store.get(`pend:${key}`);
        if (prev && Date.now() - prev.createdAt < DEFAULTS.RESEND_COOLDOWN * 1000) {
          const wait = Math.ceil((DEFAULTS.RESEND_COOLDOWN * 1000 - (Date.now() - prev.createdAt)) / 1000);
          return json({ ok: false, message: `发送过于频繁，请 ${wait} 秒后再试`, retryAfter: wait }, 429);
        }
      }

      const sent = await sendMagic(cfg, email);
      if (!sent.ok) {
        return json({ ok: false, message: `发送验证码失败（HTTP ${sent.status}），请确认邮箱是否为 Trakt 账号` }, 502);
      }

      const { verifier, challenge } = await pkce();
      const pendingKey = key || randHex(16);
      await ctx.store.set(
        `pend:${pendingKey}`,
        { email, verifier, challenge, state: randHex(16), createdAt: Date.now(), attempts: 0 },
        DEFAULTS.PENDING_TTL
      );

      const headers = {};
      if (!key) {
        headers['set-cookie'] = buildCookie(DEFAULTS.SESSION_COOKIE, pendingKey, {
          maxAge: DEFAULTS.PENDING_TTL + 60,
          secure: secureCookie(req, cfg),
        });
      }
      return json({ ok: true, message: `验证码已发送至 ${email}，5 分钟内有效` }, 200, headers);
    }

    // ② 提交验证码并完成登录
    if (path === '/api/auth/verify' && req.method === 'POST') {
      const body = await readJson(req);
      const otp = String(body.otp || '').replace(/\s/g, '');
      const key = parseCookies(req.headers.get('cookie'))[DEFAULTS.SESSION_COOKIE];
      if (!key) return json({ ok: false, message: '登录会话不存在，请重新发送验证码' }, 400);

      const pending = await ctx.store.get(`pend:${key}`);
      if (!pending) return json({ ok: false, message: '登录会话已过期，请重新发送验证码' }, 400);
      if (!/^\d{6}$/.test(otp)) return json({ ok: false, message: '请输入 6 位数字验证码' }, 400);

      if (pending.attempts >= DEFAULTS.MAX_OTP_ATTEMPTS) {
        await ctx.store.delete(`pend:${key}`);
        return json({ ok: false, message: '验证码错误次数过多，请重新发送验证码' }, 429);
      }
      pending.attempts += 1;
      await ctx.store.set(`pend:${key}`, pending, DEFAULTS.PENDING_TTL);

      const sub = await submitOtp(cfg, pending.email, otp);
      if (!sub.ok) return json({ ok: false, message: sub.message }, 401);

      const auth = await oidcAuthorize(cfg, sub.cookie, pending.state, pending.verifier);
      if (!auth.ok) return json({ ok: false, message: auth.message }, 502);

      const tok = await exchangeToken(cfg, {
        grant_type: 'authorization_code',
        code: auth.code,
        redirect_uri: cfg.REDIRECT_URI,
        code_verifier: pending.verifier,
      });
      if (!tok.ok) return json({ ok: false, message: `换取令牌失败：${tok.message}` }, 502);

      const t = normalizeTokens(tok.tokens);
      // 拉一次 /users/me 验证令牌 + 取用户名与头像
      const me = await traktFetch(cfg, { access: t.access }, '/users/me', { query: { extended: 'full' } });
      const username = me.data?.username || me.data?.user?.username || pending.email.split('@')[0];
      const account = {
        username,
        name: me.data?.name || username,
        avatar: pickAvatar(me.data),
        ...t,
        email: pending.email,
        createdAt: Date.now(),
      };
      await ctx.store.set(`acct:${username}`, account);

      const sid = randHex(24);
      await ctx.store.set(`sess:${sid}`, { accountId: username, createdAt: Date.now(), lastSeen: Date.now() }, DEFAULTS.SESSION_TTL);
      // 长期设备令牌：cookie 被清/换端口访问时也能免验证码恢复登录
      const deviceToken = randHex(32);
      await ctx.store.set(`dev:${deviceToken}`, { accountId: username, createdAt: Date.now() }, DEFAULTS.DEVICE_TTL);
      await ctx.store.delete(`pend:${key}`);

      return json(
        {
          ok: true,
          user: { username, name: account.name, avatar: account.avatar },
          expiresAt: account.expiresAt,
          deviceToken,
          sessionDays: Math.round(DEFAULTS.SESSION_TTL / 86400),
        },
        200,
        {
          'set-cookie': buildCookie(DEFAULTS.SESSION_COOKIE, sid, {
            maxAge: DEFAULTS.SESSION_TTL,
            secure: secureCookie(req, cfg),
          }),
        }
      );
    }

    // 退出
    if (path === '/api/auth/logout' && req.method === 'POST') {
      const sid = parseCookies(req.headers.get('cookie'))[DEFAULTS.SESSION_COOKIE];
      if (sid) await ctx.store.delete(`sess:${sid}`);
      const dev = req.headers.get(DEFAULTS.DEVICE_HEADER);
      if (dev) await ctx.store.delete(`dev:${dev}`);
      return json({ ok: true }, 200, {
        'set-cookie': buildCookie(DEFAULTS.SESSION_COOKIE, '', { maxAge: 0, secure: secureCookie(req, cfg) }),
      });
    }

    // Trakt 接口透传（白名单 + 自动续期 + 401 重试）
    if (path === '/api/trakt' && req.method === 'POST') {
      const body = await readJson(req);
      const method = String(body.method || 'GET').toUpperCase();
      const target = String(body.path || '');
      if (!allowed(method, target)) return json({ error: `不允许的接口：${method} ${target}` }, 403);

      const { error, sid, account } = await currentAccount(req, ctx, cfg);
      if (error) return error;

      const r = await callTrakt(ctx, cfg, { sid, account }, target, { method, query: body.query, body: body.body });
      // 收藏 / 列表这类写操作也走透传，写完同样让概览统计缓存失效
      if (r.ok && method !== 'GET') await bumpStatsVersion(ctx, account);

      return json({
        ok: r.ok,
        status: r.status,
        data: r.data,
        kind: r.kind,
        message: r.message,
        retryAfter: r.retryAfter,
        waitSec: r.waitSec || 0,
        pagination: r.pagination,
      });
    }

    // 导出
    if (path === '/api/export' && req.method === 'GET') {
      const { error, sid, account } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const kind = url.searchParams.get('kind') || 'history';
      const type = url.searchParams.get('type') || 'movies';
      const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv';
      const res = await exportData(ctx, cfg, { sid, account }, kind, type);
      if (res.error) return json({ error: res.error, kind: res.kind || 'upstream' }, 502);
      // 没有数据时仍返回空文件，保持原有的「点了就下载」行为，只是额外告知是否被截断
      const stamp = new Date().toISOString().slice(0, 10);
      const extra = res.truncated ? { 'x-trakt-truncated': '1' } : {};
      if (format === 'json') {
        return new Response(JSON.stringify(res.list || [], null, 2), {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="trakt-${kind}-${type}-${stamp}.json"`,
            ...extra,
          },
        });
      }
      return new Response(res.csv || '', {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="trakt-${kind}-${type}-${stamp}.csv"`,
          ...extra,
        },
      });
    }

    // 完整备份（版本化 JSON）：preview=1 只返回范围摘要，不生成下载体
    if (path === '/api/backup' && req.method === 'GET') {
      const { error, sid, account } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const res = await collectBackup(ctx, cfg, { sid, account });
      if (res.error) return json({ ok: false, kind: res.kind, message: res.error, waitSec: res.waitSec || 0 }, 502);
      if (url.searchParams.get('preview') === '1') {
        return json({
          ok: true,
          format: res.format,
          version: res.version,
          createdAt: res.createdAt,
          user: res.user,
          counts: res.counts,
          truncated: res.truncated,
          warnings: res.warnings,
        });
      }
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      return new Response(JSON.stringify(res), {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': `attachment; filename="trakt-backup-${stamp}.json"`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        },
      });
    }

    // 恢复：dryRun（默认）只做校验 + 预览；真正写入必须显式 confirm
    if (path === '/api/restore' && req.method === 'POST') {
      const { error, sid, account } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const auth = { sid, account };
      const body = await readJsonLimited(req);
      if (body.__tooLarge) {
        return json({ ok: false, message: `备份文件过大（约 ${Math.ceil(body.size / 1048576)} MB），超出 16 MB 上限` }, 413);
      }
      const v = validateBackup(body.backup);
      if (v.error) return json({ ok: false, message: v.error }, 400);
      const backup = v.backup;
      const scopes = normalizeScopes(body.scopes);

      const current = await collectBackup(ctx, cfg, auth);
      if (current.error) {
        return json({ ok: false, kind: current.kind, message: `读取当前账号数据失败，未执行恢复：${current.error}`, waitSec: current.waitSec || 0 }, 502);
      }

      const warnings = [...(Array.isArray(backup.warnings) ? backup.warnings : [])];
      if (backup.user?.username && backup.user.username !== account.username) {
        warnings.push(`这份备份来自账号「${backup.user.username}」，当前登录的是「${account.username}」，恢复会写入当前账号`);
      }

      if (body.dryRun !== false) {
        return json({
          ok: true,
          dryRun: true,
          scopes,
          warnings,
          backup: {
            format: backup.format,
            version: backup.version,
            createdAt: backup.createdAt,
            user: backup.user,
            settings: backup.settings,
            counts: countData(backup.data),
          },
          preview: restorePreview(backup, current, scopes),
        });
      }

      if (body.confirm !== true) {
        return json({ ok: false, message: '缺少确认标记：恢复会写入你的 Trakt 账号，请先经过确认' }, 400);
      }
      const report = await applyRestore(ctx, cfg, auth, backup, current, scopes);
      return json({
        ok: report.errors.length === 0,
        partial: report.errors.length > 0,
        scopes,
        warnings,
        report,
        statsDirty: true,
      });
    }

    // WebDAV 自动备份：读取配置（密码不下发）
    if (path === '/api/backup/dav' && req.method === 'GET') {
      const { error } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      return json({ ok: true, config: publicDavConf(await ctx.store.get(DAV_KEY)) });
    }

    // 保存配置：密码留空 = 沿用旧值；clearPassword = 清空
    if (path === '/api/backup/dav' && req.method === 'POST') {
      const { error, account } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const body = await readJson(req);
      const prev = await ctx.store.get(DAV_KEY);
      const { conf, error: bad } = normalizeDavConf(prev, body, account.username);
      if (bad) return json({ ok: false, message: bad }, 400);
      await ctx.store.set(DAV_KEY, conf);
      return json({ ok: true, config: publicDavConf(conf) });
    }

    // 连接测试：可测已保存配置，也可测表单里尚未保存的值
    if (path === '/api/backup/dav/test' && req.method === 'POST') {
      const { error } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const body = await readJson(req);
      const prev = await ctx.store.get(DAV_KEY) || {};
      const cand = {
        ...prev,
        url: body.url !== undefined ? String(body.url || '').trim() : prev.url,
        username: body.username !== undefined ? String(body.username || '') : prev.username,
        password: body.password !== undefined && String(body.password || '').length ? String(body.password) : prev.password,
      };
      if (!cand.url) return json({ ok: false, message: '请先填写 WebDAV 目录地址' }, 400);
      const r = await davTest(cand);
      return json({ ok: r.ok, ...(r.ok ? { needsCreate: r.needsCreate } : { message: r.message }) }, r.ok ? 200 : 502);
    }

    // 手动立即备份一次到 WebDAV（不影响排程的 lastRunAt）
    if (path === '/api/backup/dav/run' && req.method === 'POST') {
      const { error, account } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const conf = await ctx.store.get(DAV_KEY);
      if (!conf?.url) return json({ ok: false, message: '请先保存 WebDAV 配置' }, 400);
      const r = await runDavBackup(ctx, cfg, conf, account, { manual: true });
      return json(r.ok ? r : { ok: false, message: r.message, kind: r.kind || 'dav' }, r.ok ? 200 : 502);
    }

    // 远端备份文件列表
    if (path === '/api/backup/dav/files' && req.method === 'GET') {
      const { error } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const conf = await ctx.store.get(DAV_KEY);
      if (!conf?.url) return json({ ok: false, message: '请先保存 WebDAV 配置' }, 400);
      const r = await davList(conf);
      return r.ok ? json({ ok: true, files: r.files }) : json({ ok: false, message: r.message }, 502);
    }

    // 取回某个远端备份（只认本应用命名，防止用 name 读任意远端文件）
    if (path === '/api/backup/dav/file' && req.method === 'GET') {
      const { error } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const conf = await ctx.store.get(DAV_KEY);
      if (!conf?.url) return json({ ok: false, message: '请先保存 WebDAV 配置' }, 400);
      const name = String(url.searchParams.get('name') || '');
      if (!new RegExp(`^${BACKUP_PREFIX}[A-Za-z0-9._-]+\\.json$`).test(name)) {
        return json({ ok: false, message: '文件名不合法' }, 400);
      }
      const r = await davGet(conf, name);
      if (!r.ok) return json({ ok: false, message: r.message }, 502);
      let parsed = null;
      try {
        parsed = JSON.parse(r.text);
      } catch {
        return json({ ok: false, message: '远端文件不是合法 JSON，无法用于恢复' }, 400);
      }
      const v = validateBackup(parsed);
      if (v.error) return json({ ok: false, message: `远端备份校验失败：${v.error}` }, 400);
      return json({ ok: true, backup: v.backup });
    }

    // 删除远端备份文件（同样只认本应用命名）
    if (path === '/api/backup/dav/delete' && req.method === 'POST') {
      const { error } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const conf = await ctx.store.get(DAV_KEY);
      if (!conf?.url) return json({ ok: false, message: '请先保存 WebDAV 配置' }, 400);
      const body = await readJson(req);
      const name = String(body.name || '');
      if (!new RegExp(`^${BACKUP_PREFIX}[A-Za-z0-9._-]+\\.json$`).test(name)) {
        return json({ ok: false, message: '文件名不合法' }, 400);
      }
      const r = await davDelete(conf, name);
      return r.ok ? json({ ok: true }) : json({ ok: false, message: r.message }, 502);
    }

    // 一整季的分集：本地化标题/简介/剧照与 Trakt 写操作 id 的聚合结果
    if (path === '/api/season' && req.method === 'GET') {
      const { error } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const traktId = url.searchParams.get('trakt') || '';
      const tmdbId = url.searchParams.get('tmdb') || '';
      const season = url.searchParams.get('season');
      if (!traktId && !tmdbId) return json({ ok: false, message: '缺少 trakt 或 tmdb id' }, 400);
      if (season !== null && season !== '' && (!/^\d+$/.test(season) || Number(season) > 999)) {
        return json({ ok: false, message: 'season 需为非负整数' }, 400);
      }
      const data = await resolveSeason(ctx, { traktId, tmdbId, season: season ?? undefined });
      if (!data) return json({ ok: false, kind: 'server', message: '暂时无法获取季与分集数据' }, 502);
      return json({ ok: true, ...data });
    }

    // 整季批量标记：一次读分集 + 分批 POST /sync/history，避免前端循环打接口
    if (path === '/api/season/watch' && req.method === 'POST') {
      const { error, sid, account } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const auth = { sid, account };
      const body = await readJson(req);
      const ids = body.ids || {};
      const seasonNo = Number(body.season);
      if (!ids.trakt && !ids.slug) return json({ ok: false, message: '缺少剧集 id' }, 400);
      if (!Number.isInteger(seasonNo) || seasonNo < 0 || seasonNo > 999) {
        return json({ ok: false, message: 'season 需为非负整数' }, 400);
      }
      const action = body.action === 'unwatch' ? 'unwatch' : 'watch';
      if (action === 'watch') {
        const WHEN = ['now', 'released', 'custom', 'unknown'];
        if (!WHEN.includes(body.when)) return json({ ok: false, message: '请选择观看日期' }, 400);
        if (body.when === 'custom' && !body.date && !body.at) return json({ ok: false, message: '请选择日期' }, 400);
      }

      // episodes 可选：传了就只写这些集号（多选 / 连带补标），不传才是整季
      let wanted = null;
      if (body.episodes !== undefined) {
        if (!Array.isArray(body.episodes) || !body.episodes.length) {
          return json({ ok: false, message: 'episodes 需为非空集号数组' }, 400);
        }
        wanted = new Set(body.episodes.map((n) => Number(n)));
        wanted.forEach((n) => {
          if (!Number.isInteger(n) || n < 0 || n > 999) wanted.delete(n);
        });
        if (!wanted.size) return json({ ok: false, message: '所选集号无效' }, 400);
      }

      const sr = await callTrakt(ctx, cfg, auth, `/shows/${ids.trakt || ids.slug}/seasons/${seasonNo}`, {
        query: { extended: 'episodes' },
      });
      if (!sr.ok) return json({ ok: false, kind: sr.kind, message: `读取分集失败：${sr.message}` }, 502);
      const allEps = (Array.isArray(sr.data) ? sr.data : [])
        .map((ep) => ({ trakt: Number(ep?.ids?.trakt) || 0, number: Number(ep?.number), aired: ep?.first_aired || '' }))
        .filter((ep) => ep.trakt);
      const targets = wanted ? allEps.filter((ep) => wanted.has(ep.number)) : allEps;
      if (!targets.length) return json({ ok: false, message: wanted ? '所选分集不在该季' : '该季没有可操作的分集' }, 400);

      let failed = 0;
      const errors = [];

      if (action === 'unwatch') {
        let removed = 0;
        for (let i = 0; i < targets.length; i += BACKUP_CHUNK) {
          const chunk = targets.slice(i, i + BACKUP_CHUNK).map((ep) => ({ ids: { trakt: ep.trakt } }));
          const r = await callTrakt(ctx, cfg, auth, '/sync/history/remove', {
            method: 'POST',
            body: { episodes: chunk },
          });
          if (!r.ok) {
            failed += chunk.length;
            errors.push(`取消失败：${r.message}`);
            continue;
          }
          removed += Number(r.data?.deleted?.episodes ?? chunk.length);
        }
        await bumpStatsVersion(ctx, account);
        const state = await readState(ctx, cfg, auth, 'show', ids.trakt);
        return json({ ok: failed === 0, action, requested: targets.length, removed, failed, errors, ...state });
      }

      // 观看时间：released 用每集自己的首播日；其余模式共用一个时间点
      const baseAt = body.when === 'released' ? null : await resolveWhen(ctx, body.when, { type: 'episode', date: body.date, at: body.at });
      if (body.when !== 'released' && !baseAt) {
        return json({ ok: false, message: '没有可用的观看时间，请选择其他日期' }, 400);
      }
      const items = [];
      let skipped = 0;
      for (const ep of targets) {
        const at = body.when === 'released' ? (ep.aired ? `${String(ep.aired).slice(0, 10)}T12:00:00.000Z` : '') : baseAt;
        if (!at) {
          skipped++;
          continue;
        }
        items.push({ ids: { trakt: ep.trakt }, watched_at: at });
      }
      if (!items.length) return json({ ok: false, message: '没有可分集能确定观看时间' }, 400);

      let added = 0;
      let existing = 0;
      for (let i = 0; i < items.length; i += BACKUP_CHUNK) {
        const chunk = items.slice(i, i + BACKUP_CHUNK);
        const r = await callTrakt(ctx, cfg, auth, '/sync/history', { method: 'POST', body: { episodes: chunk } });
        if (!r.ok) {
          failed += chunk.length;
          errors.push(`标记失败：${r.message}`);
          continue;
        }
        const c = syncCounts(r.data);
        added += c.added;
        existing += c.existing;
        failed += c.notFound;
      }
      await bumpStatsVersion(ctx, account);
      const state = await readState(ctx, cfg, auth, 'show', ids.trakt);
      return json({
        ok: failed === 0,
        action,
        requested: targets.length,
        added,
        existing,
        skipped,
        failed,
        errors,
        ...state,
      });
    }

    // 条目状态：是否已看 / 评分 / 是否在待看（双向同步的读取侧）
    if (path === '/api/state' && req.method === 'GET') {
      const { error, sid, account } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const type = url.searchParams.get('type') || 'movie';
      const traktId = url.searchParams.get('trakt');
      if (!traktId) return json({ ok: false, message: '缺少 trakt id' }, 400);
      const state = await readState(ctx, cfg, { sid, account }, type, traktId);
      return json({ ok: true, ...state });
    }

    // 播出日历：整月排期（大日历格子 + 右侧当天详情都吃这一份数据）
    if (path === '/api/calendar' && req.method === 'GET') {
      const { error, sid, account } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const month = String(url.searchParams.get('month') || '').slice(0, 7);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
        return json({ ok: false, message: 'month 需为 YYYY-MM' }, 400);
      }
      const tzRaw = Number(url.searchParams.get('tz') || 0);
      const tz = Number.isFinite(tzRaw) ? Math.max(-840, Math.min(840, Math.round(tzRaw))) : 0;
      const res = await calendarMonth(ctx, cfg, { sid, account }, month, tz);
      if (res.error) {
        return json({ ok: false, kind: res.kind, message: res.error, waitSec: res.waitSec }, 502);
      }
      return json({ ok: true, ...res });
    }

    // 概览统计：服务端聚合，避免前端翻几十页历史后截断
    if (path === '/api/stats' && req.method === 'GET') {
      const { error, sid, account } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const period = url.searchParams.get('period') === 'year' ? 'year' : 'month';
      const month = String(url.searchParams.get('month') || '').slice(0, 7);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
        return json({ ok: false, message: 'month 需为 YYYY-MM' }, 400);
      }
      const tzRaw = Number(url.searchParams.get('tz') || 0);
      const tz = Number.isFinite(tzRaw) ? Math.max(-840, Math.min(840, Math.round(tzRaw))) : 0;
      const res = await statsSummary(ctx, cfg, { sid, account }, { period, month, tz });
      if (res.error) {
        return json({ ok: false, kind: res.kind, message: res.error, waitSec: res.waitSec }, 502);
      }
      return json({ ok: true, ...res });
    }

    // 沉浸背景：按来源挑封面候选
    if (path === '/api/backdrops' && req.method === 'GET') {
      const { error, sid, account } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const source = String(url.searchParams.get('source') || 'recent');
      const res = await backdropSummary(ctx, cfg, { sid, account }, source);
      if (res.error) {
        return json({ ok: false, kind: res.kind, message: res.error, waitSec: res.waitSec }, 502);
      }
      return json({ ok: true, ...res });
    }

    // 写操作：标记已看 / 取消已看 / 评分 / 待看
    if (path === '/api/action' && req.method === 'POST') {
      const { error, sid, account } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const auth = { sid, account };
      const body = await readJson(req);
      const type = ['show', 'episode', 'season'].includes(body.type) ? body.type : 'movie';
      const ids = body.ids || {};
      if (!ids.trakt && !ids.slug) return json({ ok: false, message: '缺少条目 id' }, 400);
      const seg = TYPE_PATH[type];
      const action = String(body.action || '');
      if (action === 'watch') {
        const WHEN = ['now', 'released', 'custom', 'unknown'];
        if (!WHEN.includes(body.when)) return json({ ok: false, message: '请选择观看日期' }, 400);
        if (body.when === 'custom' && !body.date && !body.at) return json({ ok: false, message: '请选择日期' }, 400);
      }
      if (['favorite_add', 'favorite_remove'].includes(action) && !['movie', 'show'].includes(type)) {
        return json({ ok: false, message: '只有电影和剧集支持收藏' }, 400);
      }

      if (action === 'watch') {
        let at = await resolveWhen(ctx, body.when, {
          type,
          date: body.date,
          at: body.at,
          traktId: ids.trakt,
          tmdbId: ids.tmdb,
          season: body.season,
          number: body.number,
        });
        if (!at) {
          return json({ ok: false, message: '该条目没有可用的发布日期，请选择其他观看日期' }, 400);
        }
        let note = '';
        let r = await callTrakt(ctx, cfg, auth, '/sync/history', {
          method: 'POST',
          body: { [seg]: [{ ids, watched_at: at }] },
        });
        // Trakt 若不接受这个日期（如 1970 占位），如实失败，不悄悄改成当前时间
        if (!r.ok) return json({ ok: false, kind: r.kind, message: `标记失败：${r.message}` }, 502);
        await bumpStatsVersion(ctx, account);
        return json({ ok: true, at, note, ...(await readState(ctx, cfg, auth, type, ids.trakt)) });
      }

      if (action === 'unwatch') {
        const r = await callTrakt(ctx, cfg, auth, '/sync/history/remove', {
          method: 'POST',
          body: { [seg]: [{ ids }] },
        });
        if (!r.ok) return json({ ok: false, kind: r.kind, message: `取消失败：${r.message}` }, 502);
        await bumpStatsVersion(ctx, account);
        const removed = r.data?.deleted?.[seg] ?? 0;
        return json({ ok: true, removed, ...(await readState(ctx, cfg, auth, type, ids.trakt)) });
      }

      if (action === 'rate' || action === 'unrate') {
        const rating = action === 'unrate' ? 0 : Math.max(0, Math.min(10, Number(body.rating) || 0));
        const r = await callTrakt(ctx, cfg, auth, '/sync/ratings', {
          method: 'POST',
          body: { [seg]: [{ ids, rating }] },
        });
        if (!r.ok) return json({ ok: false, kind: r.kind, message: `评分失败：${r.message}` }, 502);
        await bumpStatsVersion(ctx, account);
        return json({ ok: true, rating, ...(await readState(ctx, cfg, auth, type, ids.trakt)) });
      }

      if (action === 'watchlist_add' || action === 'watchlist_remove') {
        const p = action === 'watchlist_add' ? '/sync/watchlist' : '/sync/watchlist/remove';
        const r = await callTrakt(ctx, cfg, auth, p, { method: 'POST', body: { [seg]: [{ ids }] } });
        if (!r.ok) return json({ ok: false, kind: r.kind, message: `待看操作失败：${r.message}` }, 502);
        await bumpStatsVersion(ctx, account);
        return json({ ok: true, ...(await readState(ctx, cfg, auth, type, ids.trakt)) });
      }

      if (action === 'favorite_add' || action === 'favorite_remove') {
        const p = action === 'favorite_add' ? '/sync/favorites' : '/sync/favorites/remove';
        const r = await callTrakt(ctx, cfg, auth, p, { method: 'POST', body: { [seg]: [{ ids }] } });
        if (!r.ok) return json({ ok: false, kind: r.kind, message: `收藏操作失败：${r.message}` }, 502);
        await bumpStatsVersion(ctx, account);
        return json({ ok: true, ...(await readState(ctx, cfg, auth, type, ids.trakt)) });
      }

      return json({ ok: false, message: `未知操作：${action}` }, 400);
    }

    // 账户头像：同源代取字节（直连 media.trakt.tv 会被 ORB 拦），仅限 trakt.tv 域
    if (path === '/api/avatar' && req.method === 'GET') {
      const { error, account } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const src = await ensureAvatar(ctx, cfg, account);
      if (!/^https:\/\/([\w.-]+\.)?trakt\.tv\//i.test(src)) return new Response(null, { status: 404 });
      try {
        const img = await fetch(src, { headers: { 'user-agent': cfg.UA, accept: 'image/*' } });
        const type = img.headers.get('content-type') || '';
        if (img.ok && type.startsWith('image/')) {
          return new Response(img.body, {
            headers: {
              'content-type': type,
              'cache-control': 'public, max-age=86400',
            },
          });
        }
      } catch {
        /* 取图失败则回落到重定向 */
      }
      return new Response(null, {
        status: 302,
        headers: { location: src, 'cache-control': 'no-store' },
      });
    }

    // 海报：服务端代取图片字节，同源输出（规避 ORB / 防盗链 / 跨域与混合内容问题）
    if (path === '/api/poster' && req.method === 'GET') {
      const { error } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const q = url.searchParams;
      const poster = await resolvePoster(ctx, {
        type: q.get('type') || 'movie',
        traktId: q.get('trakt') || '',
        tmdbId: q.get('tmdb') || '',
        season: q.get('season') ?? undefined,
        number: q.get('number') ?? undefined,
        art: q.get('art') || '',
      });
      if (!poster) return new Response(null, { status: 404 });

      try {
        const img = await fetch(poster, { headers: { 'user-agent': cfg.UA, accept: 'image/*' } });
        const type = img.headers.get('content-type') || '';
        if (img.ok && type.startsWith('image/')) {
          return new Response(img.body, {
            headers: {
              'content-type': type,
              'cache-control': 'public, max-age=2592000, immutable',
              'x-content-type-options': 'nosniff',
            },
          });
        }
      } catch {
        /* 取图失败则回落到重定向 */
      }
      return new Response(null, {
        status: 302,
        headers: { location: poster, 'cache-control': 'no-store' },
      });
    }

    // 影视信息（标题/简介/时长/类型/评分/海报）
    if (path === '/api/meta' && req.method === 'GET') {
      const { error } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const q = url.searchParams;
      const data = await resolveArt(ctx, {
        type: q.get('type') || 'movie',
        traktId: q.get('trakt') || '',
        tmdbId: q.get('tmdb') || '',
        season: q.get('season') ?? undefined,
        number: q.get('number') ?? undefined,
        title: q.get('title') || '',
        year: q.get('year') || '',
      });
      if (!data) return json({ ok: false, message: '未找到该条目信息' }, 404);
      return json({ ok: true, provider: data.provider, data });
    }

    // 批量标题本地化：列表/日历里一次换掉多条标题，命中 art 缓存时零上游请求
    if (path === '/api/meta/batch' && req.method === 'POST') {
      const { error } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const body = await readJson(req);
      const items = (Array.isArray(body?.items) ? body.items : []).filter((it) => it?.key).slice(0, 60);
      const out = {};
      const queue = [...items];
      const worker = async () => {
        while (queue.length) {
          const it = queue.shift();
          try {
            const type = ['movie', 'episode'].includes(it.type) ? it.type : 'show';
            const data = await resolveArt(ctx, {
              type,
              traktId: it.trakt || '',
              tmdbId: it.tmdb || '',
              season: it.season || undefined,
              number: it.number || undefined,
            });
            const title = type === 'episode' ? data?.episode?.title || data?.title : data?.title;
            const overview = type === 'episode' ? data?.episode?.overview || '' : data?.overview || '';
            if (title) out[it.key] = { title, year: data?.year || '', overview };
          } catch {
            /* 单条失败就保持前端原文 */
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
      return json({ ok: true, data: out });
    }

    // 媒体源设置（TMDB key）
    if (path === '/api/settings' && req.method === 'GET') {
      const { error } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const key = await getTmdbKey(ctx);
      const fromEnv = Boolean(ctx.env?.TMDB_API_KEY || ctx.env?.TMDB_TOKEN);
      const lang = await getTmdbLang(ctx);
      return json({
        tmdb: {
          configured: Boolean(key),
          source: fromEnv ? 'env' : key ? 'saved' : 'none',
          preview: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : '',
        },
        lang,
        langSource: ctx.env?.TMDB_LANG ? 'env' : (await ctx.store.get('cfg:tmdb_lang')) ? 'saved' : 'default',
        languages: LANGUAGES,
        provider: key ? 'tmdb' : 'trakt',
      });
    }

    if (path === '/api/settings' && req.method === 'POST') {
      const { error } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const body = await readJson(req);
      const hasKey = Object.prototype.hasOwnProperty.call(body || {}, 'tmdbKey');
      const hasLang = Object.prototype.hasOwnProperty.call(body || {}, 'tmdbLang');

      // 只改语言：不影响 key
      if (hasLang && !hasKey) {
        const lang = String(body.tmdbLang || '').trim();
        if (!lang) await ctx.store.delete('cfg:tmdb_lang');
        else await ctx.store.set('cfg:tmdb_lang', { lang, savedAt: Date.now() });
        const keyNow = await getTmdbKey(ctx);
        return json({
          ok: true,
          lang: await getTmdbLang(ctx),
          provider: keyNow ? 'tmdb' : 'trakt',
        });
      }

      const key = String(body.tmdbKey || '').trim();
      if (!key) {
        await ctx.store.delete('cfg:tmdb');
        return json({ ok: true, tmdb: { configured: false, source: 'none' }, provider: 'trakt' });
      }
      if (key.length < 20) return json({ ok: false, message: 'key 格式不对（v3 key 为 32 位，v4 token 更长）' }, 400);
      const valid = await verifyTmdbKey(key);
      if (!valid) return json({ ok: false, message: 'TMDB 校验失败：key 无效或网络不通' }, 400);
      await ctx.store.set('cfg:tmdb', { key, savedAt: Date.now() });
      return json({ ok: true, tmdb: { configured: true, source: 'saved' }, provider: 'tmdb' });
    }

    if (path === '/api/health') return json({ ok: true, time: Date.now() });
    return json({ error: 'Not Found' }, 404);
  } catch (err) {
    return json({ error: '服务端异常', detail: String(err?.message || err) }, 500);
  }
}
