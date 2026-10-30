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

import { resolveArt, resolvePoster, getTmdbKey, verifyTmdbKey } from './art.js';

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
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
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

// ── 路径白名单（前端只能访问这些 Trakt 接口）──────────────

const ALLOW = [
  ['GET', /^\/users\/me$/],
  ['GET', /^\/users\/me\/stats$/],
  ['GET', /^\/users\/me\/watched\/(movies|shows)$/],
  ['GET', /^\/users\/me\/ratings\/(movies|shows|episodes|seasons)(\/[^/]+)?$/],
  ['GET', /^\/users\/me\/watchlist\/(movies|shows)$/],
  ['GET', /^\/users\/me\/favorites(\/(movies|shows))?$/],
  ['GET', /^\/users\/me\/lists$/],
  ['GET', /^\/users\/me\/lists\/[^/]+\/items(\/[^/]+)?$/],
  ['GET', /^\/sync\/history(\/(movies|shows|episodes))?(\/[^/]+)?$/],
  ['GET', /^\/sync\/watchlist(\/(movies|shows|episodes|seasons))?(\/[^/]+)?$/],
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

async function exportData(cfg, account, kind, type) {
  const rows = [];
  const limit = 100;
  for (let page = 1; page <= 100; page++) {
    let path;
    let query = { page, limit };
    if (kind === 'history') {
      path = `/sync/history/${type || 'movies'}`;
    } else if (kind === 'ratings') {
      path = `/users/me/ratings/${type || 'movies'}`;
    } else if (kind === 'watchlist') {
      path = '/sync/watchlist';
    } else {
      throw new Error('unsupported kind');
    }
    const r = await traktFetch(cfg, account, path, { query });
    if (r.status !== 200 || !Array.isArray(r.data) || r.data.length === 0) break;
    rows.push(...r.data);
    const pageCount = Number(r.headers.get('x-pagination-page-count') || 1);
    if (page >= pageCount) break;
  }

  const flat = rows.map((it) => {
    const base = {
      type: it.type || '',
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
      base.type = it.type || '';
      base.listed_at = it.listed_at || '';
    }
    return base;
  });

  if (!flat.length) return { empty: true, rows: [] };
  const cols = Object.keys(flat[0]);
  const csv = ['\ufeff' + cols.join(','), ...flat.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n');
  return { empty: false, csv, list: flat, cols };
}

// ── 双向同步：状态读取与写入 ─────────────────────────────

const TYPE_PATH = { movie: 'movies', show: 'shows', episode: 'episodes', season: 'seasons' };

function describeError(r) {
  const d = r.data;
  if (typeof d === 'string') return d.slice(0, 120) || `HTTP ${r.status}`;
  return d?.error_description || d?.error || d?.message || `HTTP ${r.status}`;
}

/** 读 Trakt 端的真实状态（已看次数/最近时间、评分、是否待看） */
async function readState(cfg, account, type, traktId) {
  const seg = TYPE_PATH[type] || 'movies';
  if (!traktId) return { watched: { count: 0, last: null }, rating: null, watchlist: false };
  const [hist, rate, wl] = await Promise.all([
    type === 'season'
      ? Promise.resolve({ status: 404, data: [] })
      : traktFetch(cfg, account, `/sync/history/${seg}/${traktId}`),
    traktFetch(cfg, account, `/users/me/ratings/${seg}/${traktId}`),
    traktFetch(cfg, account, `/sync/watchlist/${seg}/${traktId}`),
  ]);
  const list = Array.isArray(hist.data) ? hist.data : [];
  const last = list.map((w) => w.watched_at).filter(Boolean).sort().pop() || null;
  const rating = rate.status === 200 && typeof rate.data?.rating === 'number' ? rate.data.rating : null;
  const wlData = wl.status === 200 ? wl.data : null;
  const watchlist = Boolean(
    wlData && ((Array.isArray(wlData) && wlData.length) || wlData.listed_at || Object.keys(wlData).length)
  );
  return { watched: { count: list.length, last }, rating, watchlist };
}

/** 把「现在 / 发布日 / 自定义 / 未知」换算成 Trakt 接受的 watched_at */
async function resolveWhen(ctx, when, { type, date, traktId, tmdbId, season, number }) {
  if (when === 'custom') return date ? `${String(date).slice(0, 10)}T12:00:00.000Z` : null;
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
  return new Date().toISOString();
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
      return json(
        {
          loggedIn: true,
          user: { username: account.username, name: account.name || account.username },
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
      // 拉一次 /users/me 验证令牌 + 取用户名
      const me = await traktFetch(
        cfg,
        { access: t.access },
        '/users/me',
        {}
      );
      const username = me.data?.username || me.data?.user?.username || pending.email.split('@')[0];
      const account = {
        username,
        name: me.data?.name || username,
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
          user: { username, name: account.name },
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

      let r = await traktFetch(cfg, account, target, { method, query: body.query, body: body.body });

      if (r.status === 401 && account.refresh) {
        const refreshed = await refreshAccount(ctx, cfg, sid, account);
        if (refreshed.ok) {
          r = await traktFetch(cfg, refreshed.account, target, { method, query: body.query, body: body.body });
        }
      }

      return json(
        {
          status: r.status,
          data: r.data,
          pagination: {
            page: Number(r.headers.get('x-pagination-page') || 1),
            pageCount: Number(r.headers.get('x-pagination-page-count') || 1),
            itemCount: Number(r.headers.get('x-pagination-item-count') || (Array.isArray(r.data) ? r.data.length : 0)),
            limit: Number(r.headers.get('x-pagination-limit') || 0),
          },
          retryAfter: r.retryAfter,
        },
        200
      );
    }

    // 导出
    if (path === '/api/export' && req.method === 'GET') {
      const { error, account } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const kind = url.searchParams.get('kind') || 'history';
      const type = url.searchParams.get('type') || 'movies';
      const format = url.searchParams.get('format') === 'json' ? 'json' : 'csv';
      const res = await exportData(cfg, account, kind, type);
      const stamp = new Date().toISOString().slice(0, 10);
      if (format === 'json') {
        return new Response(JSON.stringify(res.list || [], null, 2), {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'content-disposition': `attachment; filename="trakt-${kind}-${type}-${stamp}.json"`,
          },
        });
      }
      return new Response(res.csv || '', {
        headers: {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="trakt-${kind}-${type}-${stamp}.csv"`,
        },
      });
    }

    // 条目状态：是否已看 / 评分 / 是否在待看（双向同步的读取侧）
    if (path === '/api/state' && req.method === 'GET') {
      const { error, account } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const type = url.searchParams.get('type') || 'movie';
      const traktId = url.searchParams.get('trakt');
      if (!traktId) return json({ ok: false, message: '缺少 trakt id' }, 400);
      const state = await readState(cfg, account, type, traktId);
      return json({ ok: true, ...state });
    }

    // 写操作：标记已看 / 取消已看 / 评分 / 待看
    if (path === '/api/action' && req.method === 'POST') {
      const { error, account } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const body = await readJson(req);
      const type = ['show', 'episode', 'season'].includes(body.type) ? body.type : 'movie';
      const ids = body.ids || {};
      if (!ids.trakt && !ids.slug) return json({ ok: false, message: '缺少条目 id' }, 400);
      const seg = TYPE_PATH[type];
      const action = String(body.action || '');

      if (action === 'watch') {
        let at = await resolveWhen(ctx, body.when, {
          type,
          date: body.date,
          traktId: ids.trakt,
          tmdbId: ids.tmdb,
          season: body.season,
          number: body.number,
        });
        let note = '';
        if (!at) {
          at = new Date().toISOString();
          note = '该条目没有可用的发布日期，已按当前时间记录';
        }
        let r = await traktFetch(cfg, account, '/sync/history', {
          method: 'POST',
          body: { [seg]: [{ ids, watched_at: at }] },
        });
        // Trakt 若不接受这个日期（如 1970 占位），退回不传 watched_at
        if (r.status >= 400 && body.when === 'unknown') {
          r = await traktFetch(cfg, account, '/sync/history', { method: 'POST', body: { [seg]: [{ ids }] } });
          if (r.status < 400) note = 'Trakt 不接受占位日期，已按当前时间记录';
        }
        if (r.status >= 400) return json({ ok: false, message: `标记失败：${describeError(r)}` }, 502);
        return json({ ok: true, at, note, ...(await readState(cfg, account, type, ids.trakt)) });
      }

      if (action === 'unwatch') {
        const r = await traktFetch(cfg, account, '/sync/history/remove', {
          method: 'POST',
          body: { [seg]: [{ ids }] },
        });
        if (r.status >= 400) return json({ ok: false, message: `取消失败：${describeError(r)}` }, 502);
        const removed = r.data?.deleted?.[seg] ?? 0;
        return json({ ok: true, removed, ...(await readState(cfg, account, type, ids.trakt)) });
      }

      if (action === 'rate' || action === 'unrate') {
        const rating = action === 'unrate' ? 0 : Math.max(0, Math.min(10, Number(body.rating) || 0));
        const r = await traktFetch(cfg, account, '/sync/ratings', {
          method: 'POST',
          body: { [seg]: [{ ids, rating }] },
        });
        if (r.status >= 400) return json({ ok: false, message: `评分失败：${describeError(r)}` }, 502);
        return json({ ok: true, rating, ...(await readState(cfg, account, type, ids.trakt)) });
      }

      if (action === 'watchlist_add' || action === 'watchlist_remove') {
        const p = action === 'watchlist_add' ? '/sync/watchlist' : '/sync/watchlist/remove';
        const r = await traktFetch(cfg, account, p, { method: 'POST', body: { [seg]: [{ ids }] } });
        if (r.status >= 400) return json({ ok: false, message: `待看操作失败：${describeError(r)}` }, 502);
        return json({ ok: true, ...(await readState(cfg, account, type, ids.trakt)) });
      }

      return json({ ok: false, message: `未知操作：${action}` }, 400);
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

    // 媒体源设置（TMDB key）
    if (path === '/api/settings' && req.method === 'GET') {
      const { error } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const key = await getTmdbKey(ctx);
      const fromEnv = Boolean(ctx.env?.TMDB_API_KEY || ctx.env?.TMDB_TOKEN);
      return json({
        tmdb: {
          configured: Boolean(key),
          source: fromEnv ? 'env' : key ? 'saved' : 'none',
          preview: key ? `${key.slice(0, 6)}…${key.slice(-4)}` : '',
        },
        provider: key ? 'tmdb' : 'trakt',
      });
    }

    if (path === '/api/settings' && req.method === 'POST') {
      const { error } = await currentAccount(req, ctx, cfg);
      if (error) return error;
      const body = await readJson(req);
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
