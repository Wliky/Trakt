// Trakt Manager 前端：无框架，hash 路由 + 服务端会话
// 通用渲染片段（标题单元 / 海报 / 空态 / 错误态 / 分页器）在 ui.js
import { esc, titleCell, posterImg, loadingBox, emptyState, errorState, bindRetry, mountPager, ICON } from './ui.js';
import { initI18n, t, getLang, setLang, LANGS } from './i18n.js';

// 前端版本：排查缓存时在控制台执行 __TM_VERSION__，对不上就是浏览器还在用旧文件
window.__TM_VERSION__ = '20261101g';

const state = {
  user: null,
  route: 'dashboard',
  query: new URLSearchParams(),
  // 观看历史：与追剧页同构的日历视图（按月缓存 + 选中日期 + 评分/剧评索引）
  history: { type: 'all', month: '', selected: '', data: null, cache: new Map(), aux: null },
  ratings: { type: 'movies', page: 1, limit: 25, data: [], meta: null },
  favorites: { data: [], loaded: false, q: '', selected: new Set() },
  lists: { data: [], loaded: false, open: new Set(), items: {} },
  watchlist: { data: [], q: '', selected: new Set() },
  userLists: { data: null, error: '', promise: null }, // 详情页「加入列表」用
  search: { q: '', type: 'all', page: 1, limit: 20, data: [], meta: null, watchlist: null },
  library: { tab: 'watchlist' },
  calendar: { month: '', selected: '', data: null, cache: new Map() }, // 追剧页：整月排期缓存 + 选中日期
};

// 列表页 → 详情 → 返回时的滚动位置（按进入详情前的 hash 记录，只恢复一次）
const scrollMemory = new Map();
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

const $ = (sel, root = document) => root.querySelector(sel);
const app = () => $('#app');

// 长期设备令牌：cookie 丢失时免验证码恢复登录
const DEVICE_KEY = 'tm_device';
const deviceToken = () => {
  try {
    return localStorage.getItem(DEVICE_KEY) || '';
  } catch {
    return '';
  }
};
function apiHeaders(extra = {}) {
  const h = { ...extra };
  const d = deviceToken();
  if (d) h['x-tm-device'] = d;
  return h;
}

/**
 * 提示条。两种用法：toast(msg, true) 表示错误；toast(msg, { undo }) 带「撤销」按钮。
 * 撤销按钮默认 12 秒后随提示条消失，超时就无法再撤销（期间用户可能又做了别的操作）。
 */
function toast(msg, opts = {}) {
  const o = typeof opts === 'boolean' ? { error: opts } : opts || {};
  const el = $('#toast');
  clearTimeout(toast.t);
  el.innerHTML = `<span>${esc(msg)}</span>`;
  el.className = `toast show${o.error ? ' err' : ''}${o.undo ? ' undoable' : ''}`;
  if (o.undo) {
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm';
    btn.textContent = '撤销';
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await o.undo();
      } catch (e) {
        toast(e.message, true);
      }
    };
    el.appendChild(btn);
  }
  toast.t = setTimeout(() => (el.className = 'toast'), o.ms || (o.undo ? 12000 : 2600));
}

/** 有限时间内可撤销的提示（默认 12s 后不可撤销） */
function undoToast(msg, undo, ms) {
  toast(msg, { undo, ms });
}

/** Trakt 列表型条目 → 写操作所需的段名与 id（列表的 add/remove 都用这一份） */
function itemRef(it) {
  if (it?.movie) return { seg: 'movies', art: 'movie', ids: it.movie.ids, title: it.movie.title };
  if (it?.show) return { seg: 'shows', art: 'show', ids: it.show.ids, title: it.show.title };
  if (it?.episode)
    return { seg: 'episodes', art: 'episode', ids: it.episode.ids, title: it.show?.title || it.episode.title };
  return null;
}

/** 批量写操作：按 movies/shows/episodes 分组，一次请求带多条，减少 Trakt 调用 */
function groupRefs(items) {
  const groups = {};
  items.forEach((it) => {
    const ref = itemRef(it);
    if (!ref) return;
    (groups[ref.seg] ||= []).push({ ids: ref.ids });
  });
  return groups;
}

/** 列表页关键词筛选：原始标题 + 已本地化的中文标题都参与匹配 */
function matchesQuery(it, q) {
  if (!q) return true;
  const m = it?.movie || it?.show || it?.episode || {};
  const ref = itemRef(it);
  const local = ref ? locCache.get(locKeyFor(ref.art, ref.ids, it.episode?.season, it.episode?.number))?.title : '';
  const text = `${m.title || ''} ${it?.show?.title || ''} ${local || ''}`.toLowerCase();
  return text.includes(q);
}

const pad2 = (n) => String(n ?? '').padStart(2, '0');
/** 本地日期 → YYYY-MM-DD / YYYY-MM */
const ymd = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const monthKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;

const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return ymd(d);
};

const fmtClock = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** 具体时间点统一展示到分钟：2026-10-01 20:30 */
const fmtDateTime = (iso) => {
  const day = fmtDate(iso);
  if (!day) return '';
  const hm = fmtClock(iso);
  return hm ? `${day} ${hm}` : day;
};

const isEn = () => getLang() === 'en-US';

const fmtDur = (min) => {
  const m = Number(min || 0);
  const en = isEn();
  if (!m) return en ? '0m' : '0 分钟';
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return en ? `${d}d ${h}h` : `${d} 天 ${h} 小时`;
  if (h > 0) return en ? `${h}h ${m % 60}m` : `${h} 小时 ${m % 60} 分`;
  return en ? `${m}m` : `${m} 分钟`;
};

const num = (n) => Number(n || 0).toLocaleString(isEn() ? 'en-US' : 'zh-CN');

const EN_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** 周期文案：中文「2026 年 11 月」，英文「Nov 2026」；m=0 表示整年 */
const periodLabel = (y, m) => (isEn() ? (m ? `${EN_MONTHS[m - 1]} ${y}` : String(y)) : m ? `${y} 年 ${m} 月` : `${y} 年`);

/**
 * 服务端统一返回结构 → 成功数据 / 可读异常
 * 约定字段：ok status kind message waitSec retryAfter pagination
 * kind：network（连不上上游）、auth（凭证失效）、rate（限流）、server（上游 5xx）、client（请求有误）
 */
/** 统一异常：message 给人看，kind/waitSec/status 给错误态与重试用 */
function apiError(message, info = {}) {
  return Object.assign(new Error(message), info);
}

function unwrap(json) {
  const wait = Number(json.waitSec || json.retryAfter || 0);
  const waitTip = wait > 0 ? `，请等待约 ${wait} 秒再试` : '，请稍后再试';
  const base = { kind: json.kind || '', waitSec: wait, status: json.status };
  if (json.kind === 'network') throw apiError(`连不上 Trakt：${json.message || '网络异常'}`, base);
  if (json.status === 401 || json.status === 403 || json.kind === 'auth') {
    state.user = null;
    renderLogin();
    throw apiError('登录已失效，请重新登录', { ...base, kind: 'auth' });
  }
  if (json.kind === 'rate' || json.status === 429 || json.status === 420) {
    throw apiError(`请求过于频繁，Trakt 已限流${waitTip}`, { ...base, kind: 'rate' });
  }
  if (json.kind === 'server') throw apiError(`Trakt 服务暂时不可用${waitTip}`, { ...base, kind: 'server' });
  if (json.status >= 400) throw apiError(json.message || json.data?.error || `Trakt 返回 ${json.status}`, base);
  return json;
}

async function api(path, { method = 'GET', query, body } = {}) {
  const resp = await fetch('/api/trakt', {
    method: 'POST',
    headers: apiHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ method, path, query, body }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.error || `请求失败（HTTP ${resp.status}）`);
  return unwrap(json);
}

/** 本项目自己的 JSON 接口（/api/calendar 一类聚合端点，不走 /api/trakt 透传） */
async function getJson(path) {
  const resp = await fetch(path, { headers: apiHeaders() });
  const json = await resp.json().catch(() => ({}));
  const status = json.status ?? resp.status;
  // 路由不存在时响应是 HTML，json() 会得到 {}：别把它误报成「Trakt 返回 404」
  if (!json.ok && status === 404 && !json.message) {
    throw apiError(`接口 ${path.split('?')[0]} 不存在（404），服务端可能还是旧版本，重启或更新后重试`, { status, kind: 'api' });
  }
  if (!json.ok) return unwrap({ ...json, status });
  return json;
}

/** 在容器里渲染错误态并接上「重试」（retry 为空时只渲染，不给按钮动作） */
function showError(el, err, retry) {
  if (!el) return;
  el.innerHTML = errorState(err);
  if (retry) bindRetry(el, retry);
}

/* ───────── 海报 / 详情 ───────── */

function artQuery(kind, ids = {}, season, number) {
  const p = new URLSearchParams({ type: kind, v: '2' });
  if (ids.trakt) p.set('trakt', ids.trakt);
  if (ids.tmdb) p.set('tmdb', ids.tmdb);
  if (season != null && season !== '') p.set('season', season);
  if (number != null && number !== '') p.set('number', number);
  return p.toString();
}

function thumb(kind, ids, season, number) {
  return posterImg(`/api/poster?${artQuery(kind, ids, season, number)}`);
}

function rowAttrs(kind, ids, season, number, title, act) {
  return `data-kind="${kind}" data-ids='${esc(JSON.stringify(ids || {}))}' data-act='${esc(JSON.stringify(act || null))}'
    data-season="${season ?? ''}" data-number="${number ?? ''}" data-title="${esc(title || '')}"`;
}

/**
 * 海报网格里的一张卡片：片单 / 搜索 / 继续观看共用同一套结构与尺寸。
 * 上面封面（可带类型角标），下面标题 + 副标题 + 操作区；
 * 点击整卡进详情（bindRowClick 认 .media-card[data-kind]），按钮点击不触发。
 * opts.badge 封面左上角标，opts.subAttrs 副标题的本地化属性。
 */
function mediaCard(kind, ids, title, sub = '', extra = '', season = '', number = '', opts = {}) {
  // 卡片标题始终是影片/剧名（分集卡也显示剧名），本地化按 show 查
  return `<div class="media-card" ${rowAttrs(kind, ids, season, number, title)}>
    <div class="media-poster">${opts.badge ? `<span class="media-badge">${esc(opts.badge)}</span>` : ''}${thumb(kind === 'episode' ? 'show' : kind, ids)}</div>
    <div class="media-body">
      <div class="media-title" ${locAttrs(kind === 'episode' ? 'show' : kind, ids)} title="${esc(title || '')}">${esc(title || '未知')}</div>
      <div class="media-sub" ${opts.subAttrs || ''}>${sub}</div>
      ${extra}
    </div>
  </div>`;
}

/* ── 标题/简介本地化：按设置里的显示语言异步替换（服务端 art 缓存 30 天） ── */
const locCache = new Map();

const locKeyFor = (type, ids, season, number) =>
  [['movie', 'episode'].includes(type) ? type : 'show', ids?.trakt || '', ids?.tmdb || '', season ?? '', number ?? ''].join(':');

function locAttrs(type, ids, season, number) {
  const t = ['movie', 'episode'].includes(type) ? type : 'show';
  const a = [
    `data-loc-type="${t}"`,
    `data-loc-trakt="${esc(ids?.trakt || '')}"`,
    `data-loc-tmdb="${esc(ids?.tmdb || '')}"`,
  ];
  if (season != null && season !== '' && number != null && number !== '') {
    a.push(`data-loc-season="${esc(season)}"`, `data-loc-number="${esc(number)}"`);
  }
  return a.join(' ');
}

/** 副标题（年份 + 简介）：标记成 overview 字段，按语言重写 */
function locSubAttrs(type, ids, year, max = 70) {
  return `${locAttrs(type, ids)} data-loc-field="overview" data-loc-prefix="${esc(year || '')}" data-loc-max="${max}"`;
}

/** 日历格子悬停提示：带上当天条目的 key，等标题语言化后重拼 title */
function locTipAttr(day, list) {
  if (!list?.length) return '';
  const payload = { p: day, k: list.map((x) => locKeyFor(x.type, x.ids, x.season, x.number)) };
  return ` data-loc-tip="${esc(JSON.stringify(payload))}"`;
}

function locKeyOf(el) {
  return [el.dataset.locType, el.dataset.locTrakt, el.dataset.locTmdb, el.dataset.locSeason || '', el.dataset.locNumber || ''].join(':');
}

function parseLocKey(key) {
  const [type, trakt, tmdb, season, number] = String(key).split(':');
  return { key, type, trakt, tmdb, season, number };
}

function locTipData(el) {
  try {
    const o = JSON.parse(el.dataset.locTip || '{}');
    return { day: o.p || '', keys: Array.isArray(o.k) ? o.k.filter(Boolean) : [] };
  } catch {
    return { day: '', keys: [] };
  }
}

function locClip(text, max) {
  const s = String(text || '').trim();
  if (!s) return '';
  const n = Number(max) || 0;
  return n > 0 && s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 把一个本地化结果写回元素（标题 / 副标题简介） */
function locApply(el, info) {
  if (!info) return;
  if ((el.dataset.locField || 'title') === 'overview') {
    const text = locClip(info.overview, el.dataset.locMax);
    if (!text) return;
    el.textContent = [el.dataset.locPrefix || '', text].filter(Boolean).join(' · ');
    return;
  }
  if (!info.title) return;
  el.textContent = info.title;
  if (el.hasAttribute('title')) el.title = info.title;
}

/** 批量把 [data-loc-*] 的标题/简介、[data-loc-tip] 的悬停提示换成显示语言；查不到就保持原文 */
async function localize(root = document) {
  const els = [...root.querySelectorAll('[data-loc-type]')];
  const tips = [...root.querySelectorAll('[data-loc-tip]')];
  if (!els.length && !tips.length) return;

  const keys = new Set();
  els.forEach((el) => {
    const key = locKeyOf(el);
    el.dataset.locKey = key;
    keys.add(key);
  });
  tips.forEach((el) => locTipData(el).keys.forEach((k) => keys.add(k)));

  const missing = [...keys].filter((k) => !locCache.has(k));
  if (missing.length) {
    try {
      const r = await fetch('/api/meta/batch', {
        method: 'POST',
        headers: apiHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ items: missing.map(parseLocKey) }),
      });
      if (r.ok) {
        const j = await r.json();
        Object.entries(j.data || {}).forEach(([k, v]) => {
          if (v?.title) locCache.set(k, v);
        });
      }
    } catch {
      /* 语言化失败保持原文 */
    }
  }

  els.forEach((el) => locApply(el, locCache.get(el.dataset.locKey)));
  tips.forEach((el) => {
    const { day, keys: list } = locTipData(el);
    const names = list.map((k) => locCache.get(k)?.title || '');
    if (!names.length || names.some((n) => !n)) return;
    el.title = day ? `${day} · ${names.join('、')}` : names.join('、');
  });
}

/** 切换显示语言后，清掉所有「按语言缓存」的前端数据 */
function clearLangCaches() {
  locCache.clear();
  state.history.cache.clear();
  state.history.aux = null;
  state.calendar.cache.clear();
  if (detailView) {
    detailView.seasonCache?.clear?.();
    detailView.meta = null;
  }
}

function bindRowClick(root = document) {
  root.querySelectorAll('tr[data-kind], .media-card[data-kind]').forEach((tr) => {
    tr.classList.add('row-click');
    tr.onclick = (e) => {
      if (e.target.closest('button, a, input, select, .checkbox')) return;
      openDetail({
        type: tr.dataset.kind,
        ids: JSON.parse(tr.dataset.ids || '{}'),
        act: JSON.parse(tr.dataset.act || 'null'),
        season: tr.dataset.season,
        number: tr.dataset.number,
        title: tr.dataset.title,
      });
    };
  });
}

function detailHref({ type, ids = {}, season, number }) {
  const kind = ['movie', 'show', 'episode', 'season'].includes(type) ? type : 'movie';
  const p = new URLSearchParams({ type: kind });
  if (ids.trakt) p.set('trakt', ids.trakt);
  if (ids.tmdb) p.set('tmdb', ids.tmdb);
  if (season !== undefined && season !== null && season !== '') p.set('s', season);
  if (kind === 'episode' && number !== undefined && number !== null && number !== '') p.set('e', number);
  return `#/detail?${p}`;
}

/** 进详情前记录窗口滚动 + 列表内滚动容器（Watchlist 等表格是内部滚动） */
function snapshotScroll() {
  const spots = {};
  document.querySelectorAll('#page-body [id]').forEach((el) => {
    if (el.scrollTop > 0) spots[el.id] = el.scrollTop;
  });
  return { y: window.scrollY, spots };
}

function restoreScroll(mem) {
  window.scrollTo(0, mem?.y || 0);
  Object.entries(mem?.spots || {}).forEach(([id, top]) => {
    const el = document.getElementById(id);
    if (el && top > 0) el.scrollTop = top;
  });
}

function openDetail({ type, ids, season, number }) {
  const next = detailHref({ type, ids, season, number });
  // 只在列表页进入详情时记位置；详情内切换季/集不覆盖
  if (state.route !== 'detail') scrollMemory.set(location.hash || '#/dashboard', snapshotScroll());
  if (location.hash === next) route();
  else location.hash = next;
}

let detailView = null;
let detailToken = 0;

/** 该剧的观看记录 → S{季}E{集} → 观看次数（最多翻 5 页 × 100 条） */
async function watchedEpisodeMap(showTrakt) {
  const map = new Map();
  for (let page = 1; page <= 5; page += 1) {
    const r = await api(`/sync/history/shows/${showTrakt}`, { query: { page, limit: 100 } });
    (r.data || []).forEach((it) => {
      const ep = it.episode || {};
      if (ep.season == null || ep.number == null) return;
      const k = `S${ep.season}E${ep.number}`;
      map.set(k, (map.get(k) || 0) + 1);
    });
    const meta = r.pagination || {};
    if (!meta.pageCount || page >= meta.pageCount) break;
  }
  return map;
}

/* ── 详情里的写操作（双向：写完立即回读 Trakt 状态）── */

const todayStr = () => ymd(new Date());

/** 5 星半星控件：每颗星左右两半各代表 1 分，共 10 档；Trakt 评分仍写 1–10 的整数 */
function ratingStarsHtml(rating, disabled = '') {
  return Array.from({ length: 5 }, (_, i) => {
    const left = i * 2 + 1;
    const right = i * 2 + 2;
    return `<span class="rating-star">
      <button type="button" class="rating-half left${rating >= left ? ' on' : ''}" data-v="${left}" role="radio" aria-checked="${rating === left}" aria-label="${left} 分（半星）" title="${left} 分"${disabled}><span aria-hidden="true">★</span></button>
      <button type="button" class="rating-half right${rating >= right ? ' on' : ''}" data-v="${right}" role="radio" aria-checked="${rating === right}" aria-label="${right} 分" title="${right} 分"${disabled}><span aria-hidden="true">★</span></button>
    </span>`;
  }).join('');
}

function listOptionsHtml() {
  const s = state.userLists;
  if (!s.data) return `<option value="">${s.error ? '列表读取失败' : '加载中…'}</option>`;
  if (!s.data.length) return '<option value="">暂无自定义列表</option>';
  return s.data
    .map((l) => `<option value="${esc(l.ids.trakt)}">${esc(l.name)}（${num(l.item_count)}）</option>`)
    .join('');
}

function actionsInner(st, released, actType, canAct = true) {
  const count = st?.watched?.count || 0;
  const last = st?.watched?.last;
  const rating = Number(st?.rating || 0);
  const wl = Boolean(st?.watchlist);
  const favorite = st?.favorite;
  const disabled = canAct ? '' : ' disabled';
  const listsReady = Boolean(state.userLists.data?.length);
  return `
    <div class="op-row">
      <div class="op-row-top">
        <span class="op-label">观看</span>
        <span class="op-value" id="st-watch">${count ? `已看 ${count} 次${last ? ` · ${fmtDateTime(last)}` : ''}` : '未标记'}</span>
      </div>
      <div class="op-row-ctl">
        <button class="btn btn-sm ${count ? 'btn-danger' : 'btn-primary'}" id="btn-watch-toggle"${disabled}>${count ? '取消观看' : '标记已看'}</button>
      </div>
    </div>
    <div class="op-row">
      <div class="op-row-top">
        <span class="op-label">评分</span>
        <span class="op-value" id="st-rating">${rating ? `${rating} 分` : '未评分'}</span>
      </div>
      <div class="rating-control">
        <div class="rating-row">
          <div class="rating-picker" id="rating-picker" role="radiogroup" aria-label="评分（1–10 分，半星 1 分）">${ratingStarsHtml(rating, disabled)}</div>
        </div>
        <div class="rating-exact">
          <input class="rating-input" id="rating-input" type="number" min="0" max="10" step="1" inputmode="numeric" placeholder="0–10" value="${rating || ''}" aria-label="精确评分（0 到 10 分，0 为清除）"${disabled} />
          <button class="btn btn-sm" id="rating-apply"${disabled}>应用</button>
          <button class="btn btn-sm rating-clear" id="rating-clear"${disabled}${rating ? '' : ' hidden'}>清除</button>
        </div>
      </div>
    </div>
    <div class="op-row">
      <div class="op-row-top">
        <span class="op-label">待看</span>
        <span class="op-value" id="st-wl">${wl ? '已在待看列表' : '不在待看列表'}</span>
      </div>
      <div class="op-row-ctl"><button class="btn btn-sm" id="btn-wl"${disabled}>${wl ? '移出待看' : '加入待看'}</button></div>
    </div>
    ${actType === 'movie' || actType === 'show' ? `<div class="op-row">
      <div class="op-row-top">
        <span class="op-label">收藏</span>
        <span class="op-value" id="st-fav">${favorite == null ? '状态未知' : favorite ? '已收藏' : '未收藏'}</span>
      </div>
      <div class="op-row-ctl"><button class="btn btn-sm" id="btn-fav"${!canAct || favorite == null ? ' disabled' : ''}>${favorite ? '移出收藏' : '加入收藏'}</button></div>
    </div>
    <div class="op-row">
      <div class="op-row-top">
        <span class="op-label">列表</span>
        <span class="op-value" id="st-list">${state.userLists.error ? '列表读取失败' : listsReady ? '可加入自定义列表' : '选择后加入'}</span>
      </div>
      <div class="op-row-ctl list-picker-row">
        <select id="list-pick" aria-label="选择要加入的列表"${disabled || !listsReady ? ' disabled' : ''}>${listOptionsHtml()}</select>
        <button class="btn btn-sm" id="btn-list-add"${disabled || !listsReady ? ' disabled' : ''}>加入</button>
      </div>
    </div>` : ''}`;
}

function paintActions(ctx, st) {
  const box = $('#action-box');
  if (!box) return;
  const canAct = Boolean(ctx.ids?.trakt || ctx.ids?.slug);
  box.innerHTML = actionsInner(st, ctx.released, ctx.type, canAct);
  if (!canAct) box.insertAdjacentHTML('beforeend', '<p class="note">缺少 Trakt 条目 id，当前只能浏览，无法写入。</p>');
  if (st?.degraded) box.insertAdjacentHTML('beforeend', `<p class="note">${esc(st.message || '部分状态暂时不可用')}</p>`);
  bindActions(ctx, st || {});
}

/** 本地日期 + 时分 → UTC ISO（按浏览器时区换算）；非法返回空串 */
function localDateTime(date, time) {
  if (!date) return '';
  const hm = /^\d{1,2}:\d{2}$/.test(String(time || '')) ? String(time) : '12:00';
  const d = new Date(`${date}T${hm.padStart(5, '0')}:00`);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

/**
 * 观看时间选择。
 * perEpisode=true 表示多选：「发布日」按每一集自己的首播日写入，不再共用某一集的日期；
 * catchUp 是前面未看且未选集的集数，大于 0 时给出「连带补标」勾选项。
 */
function chooseWatchDate({ released = '', title = '', perEpisode = false, catchUp = 0, missingAir = 0 } = {}) {
  const now = new Date();
  const today = ymd(now);
  const nowTime = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const canRelease = Boolean(released) || perEpisode;
  const releaseLabel = perEpisode
    ? '各集发布日（分别按各自首播日写入）'
    : `发布日${released ? `（${esc(released)}）` : '（暂无）'}`;
  return new Promise((resolve) => {
    openModal(`<h3 class="watch-date-title">选择观看时间</h3>
      <p class="watch-date-sub">${esc(title || '标记已看')}</p>
      <div class="watch-date-options" role="radiogroup" aria-label="观看时间">
        <label><input type="radio" name="watch-when" value="now" /> <span>现在</span></label>
        <label${canRelease ? '' : ' class="is-disabled"'}><input type="radio" name="watch-when" value="released"${canRelease ? '' : ' disabled'} /> <span>${releaseLabel}</span></label>
        <label><input type="radio" name="watch-when" value="custom" /> <span>指定时间</span></label>
        <label><input type="radio" name="watch-when" value="unknown" /> <span>未知日期</span></label>
      </div>
      ${catchUp > 0 ? `<div class="watch-date-catch"><label><input type="checkbox" id="watch-catch-up" /> <span>连带标记前面未看的 ${catchUp} 集</span></label></div>` : ''}
      ${perEpisode && missingAir > 0 ? `<p class="note">有 ${missingAir} 集缺少首播日，选「各集发布日」时会跳过它们。</p>` : ''}
      <div class="field" id="watch-custom-field" hidden>
        <label for="watch-custom-date">观看时间</label>
        <div class="watch-date-inputs">
          <input type="date" id="watch-custom-date" value="${today}" />
          <input type="time" id="watch-custom-time" step="60" value="${nowTime}" />
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn" data-close>取消</button>
        <button class="btn btn-primary" id="watch-date-confirm" disabled>确认</button>
      </div>`, 'modal-date');
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      document.removeEventListener('keydown', onKey);
      $('#modal-root').innerHTML = '';
      resolve(value);
    };
    const onKey = (e) => { if (e.key === 'Escape') finish(null); };
    document.addEventListener('keydown', onKey);
    $('#modal-root').querySelector('.modal-backdrop').onclick = (e) => {
      if (e.target.classList.contains('modal-backdrop')) finish(null);
    };
    $('#modal-root').querySelectorAll('[data-close]').forEach((b) => { b.onclick = () => finish(null); });
    const confirm = $('#watch-date-confirm');
    const customField = $('#watch-custom-field');
    const customDate = $('#watch-custom-date');
    const customTime = $('#watch-custom-time');
    const sync = () => {
      const when = $('#modal-root').querySelector('input[name="watch-when"]:checked')?.value || '';
      customField.hidden = when !== 'custom';
      confirm.disabled = !when || (when === 'custom' && (!customDate.value || !customTime.value));
    };
    $('#modal-root').querySelectorAll('input[name="watch-when"]').forEach((r) => {
      r.onchange = () => { sync(); if (r.value === 'custom' && r.checked) customDate.focus(); };
    });
    customDate.oninput = sync;
    customTime.oninput = sync;
    confirm.onclick = () => {
      const when = $('#modal-root').querySelector('input[name="watch-when"]:checked')?.value;
      if (!when) return;
      // 多选才有「连带标记前面未看的集」；单选时不返回该字段
      const catchBox = $('#watch-catch-up');
      const extra = catchBox ? { includePrevious: Boolean(catchBox.checked) } : {};
      if (when === 'custom') {
        const at = localDateTime(customDate.value, customTime.value);
        if (!customDate.value || !at) return;
        finish({ when, date: customDate.value, at, ...extra });
        return;
      }
      finish({ when, ...extra });
    };
    requestAnimationFrame(() => $('#modal-root').querySelector('input[name="watch-when"]:not(:disabled)')?.focus());
  });
}

function bindActions(ctx, st) {
  const { type, ids, season, number } = ctx;
  const after = async (j, action) => {
    paintActions(ctx, j);
    await ctx.onUpdated?.(j, action);
  };
  const toggle = $('#btn-watch-toggle');
  if (toggle) {
    toggle.onclick = async () => {
      const watched = (st?.watched?.count || 0) > 0;
      let choice = null;
      if (!watched) {
        choice = await chooseWatchDate({ released: ctx.released, title: ctx.title });
        if (!choice) return;
      }
      toggle.disabled = true;
      try {
        const j = watched
          ? await runAction({ type, ids, season, number, action: 'unwatch' })
          : await runAction({ type, ids, season, number, action: 'watch', when: choice.when, date: choice.date, at: choice.at });
        toast(watched ? '已取消观看' : j.note ? `已标记（${j.note}）` : '已标记为已看');
        await after(j, watched ? 'unwatch' : 'watch');
      } catch (e) {
        toast(e.message, true);
        toggle.disabled = false;
      }
    };
  }

  bindRating(ctx, st, after);

  const wl = $('#btn-wl');
  if (wl) {
    wl.onclick = async () => {
      const inList = Boolean(st?.watchlist);
      wl.disabled = true;
      try {
        const j = await runAction({ type, ids, action: inList ? 'watchlist_remove' : 'watchlist_add' });
        toast(inList ? '已移出待看' : '已加入待看');
        await after(j, inList ? 'watchlist_remove' : 'watchlist_add');
      } catch (e) {
        toast(e.message, true);
        wl.disabled = false;
      }
    };
  }

  const fav = $('#btn-fav');
  if (fav) {
    fav.onclick = async () => {
      const favorited = Boolean(st?.favorite);
      fav.disabled = true;
      try {
        const j = await runAction({ type, ids, action: favorited ? 'favorite_remove' : 'favorite_add' });
        toast(favorited ? '已移出收藏' : '已加入收藏');
        await after(j, favorited ? 'favorite_remove' : 'favorite_add');
      } catch (e) {
        toast(e.message, true);
        fav.disabled = false;
      }
    };
  }

  bindListPicker(ctx);
}

/** 评分星条即时重画：hover 预览也走这里，离开时用真实分复原 */
function paintRatingPicker(value) {
  const picker = $('#rating-picker');
  if (!picker) return;
  const v = Math.max(0, Math.min(10, Number(value) || 0));
  picker.querySelectorAll('.rating-half').forEach((b) => {
    const n = Number(b.dataset.v);
    b.classList.toggle('on', n <= v);
    b.setAttribute('aria-checked', String(n === v));
  });
  const read = $('#st-rating');
  if (read) read.textContent = v ? `${v} 分` : '未评分';
}

function bindRating(ctx, st, after) {
  const picker = $('#rating-picker');
  if (!picker) return;
  const { type, ids } = ctx;
  const current = () => Number(st?.rating || 0);
  const submit = async (value, sameClears = true) => {
    const cur = current();
    const clear = value === 0 || (sameClears && value === cur);
    if (!clear && (!Number.isInteger(value) || value < 1 || value > 10)) return toast('评分需为 0–10 的整数', true);
    if (clear && !cur) return;
    try {
      const j = clear ? await runAction({ type, ids, action: 'unrate' }) : await runAction({ type, ids, action: 'rate', rating: value });
      toast(clear ? '已清除评分' : `已评分 ${value}`);
      await after(j, clear ? 'unrate' : 'rate');
    } catch (e) {
      toast(e.message, true);
      paintRatingPicker(cur);
    }
  };
  picker.querySelectorAll('.rating-half').forEach((btn) => {
    const v = Number(btn.dataset.v);
    btn.onmouseenter = () => paintRatingPicker(v);
    btn.onfocus = () => paintRatingPicker(v);
    btn.onmouseleave = () => paintRatingPicker(current());
    btn.onblur = () => paintRatingPicker(current());
    btn.onclick = () => submit(v);
  });
  const input = $('#rating-input');
  const commit = () => {
    const raw = input?.value.trim();
    if (!raw) return;
    const v = Number(raw);
    if (!Number.isInteger(v) || v < 0 || v > 10) return toast('评分需为 0–10 的整数', true);
    submit(v, false);
  };
  $('#rating-apply')?.addEventListener('click', commit);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
  });
  $('#rating-clear')?.addEventListener('click', () => submit(0));
}

/** 详情页「加入列表」：列表清单懒加载一次，之后各条目共用 */
async function loadUserLists(force = false) {
  const s = state.userLists;
  if (s.data && !force) return s.data;
  if (s.promise) return s.promise;
  s.promise = api('/users/me/lists')
    .then((r) => {
      s.data = (r.data || []).filter(Boolean);
      s.error = '';
      return s.data;
    })
    .catch((e) => {
      s.error = e.message;
      throw e;
    })
    .finally(() => {
      s.promise = null;
    });
  return s.promise;
}

function bindListPicker(ctx) {
  const pick = $('#list-pick');
  const add = $('#btn-list-add');
  if (!pick || !add) return;
  const canAct = Boolean(ctx.ids?.trakt || ctx.ids?.slug);
  const seg = ctx.type === 'show' ? 'shows' : 'movies';
  const ids = ctx.ids || {};
  const hint = $('#st-list');
  const fill = () => {
    pick.innerHTML = listOptionsHtml();
    const empty = !canAct || !state.userLists.data?.length;
    pick.disabled = empty;
    add.disabled = empty;
    if (!hint) return;
    if (state.userLists.error) hint.textContent = '列表读取失败';
    else if (state.userLists.data && !state.userLists.data.length) hint.textContent = '还没有自定义列表';
    else if (state.userLists.data) hint.textContent = '可加入自定义列表';
  };
  fill();
  if (!state.userLists.data) {
    loadUserLists()
      .then(() => {
        if ($('#list-pick') === pick) fill();
      })
      .catch(() => {
        if (hint) hint.textContent = '列表读取失败';
      });
  }
  add.onclick = async () => {
    const listId = pick.value;
    const list = (state.userLists.data || []).find((l) => String(l.ids.trakt) === String(listId));
    if (!list) return toast('请选择列表', true);
    add.disabled = true;
    add.textContent = '加入中…';
    try {
      await api(`/users/me/lists/${listId}/items`, { method: 'POST', body: { [seg]: [{ ids }] } });
      list.item_count = Number(list.item_count || 0) + 1;
      if (hint) hint.textContent = `已加入「${list.name}」`;
      add.textContent = '已加入';
      pick.querySelectorAll('option').forEach((o) => {
        if (String(o.value) === String(listId)) o.textContent = `${list.name}（${num(list.item_count)}）`;
      });
      toast(`已加入「${list.name}」`);
    } catch (e) {
      add.disabled = false;
      add.textContent = '加入';
      toast(e.message, true);
    }
  };
}

async function runAction(payload) {
  const r = await fetch('/api/action', {
    method: 'POST',
    headers: apiHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
  if (!j.ok) throw new Error(j.message || '操作失败');
  ovCache.clear(); // 写完立刻回概览时不要拿旧统计
  return j;
}

/** 本项目自己的写接口（不走 /api/trakt 透传）；失败直接抛错 */
async function postLocal(path, payload) {
  const r = await fetch(path, {
    method: 'POST',
    headers: apiHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
  if (!j.ok) throw new Error(j.message || '操作失败');
  ovCache.clear();
  return j;
}

/* ───────── 登录 ───────── */

function renderLogin(step = 'email', email = '') {
  // 两个步骤一次性渲染，切换只做显隐，避免整页重渲染导致输入框失焦 / 打不进字
  app().innerHTML = `
  <div class="login-wrap">
    <div class="card login-card">
      <div class="brand" style="padding:0">
        <div class="brand-mark">T</div>
        <div class="brand-text">
          <div class="brand-name">Trakt Manager</div>
          <div class="brand-sub">数据管理面板</div>
        </div>
      </div>

      <div id="step-email">
        <h2>邮箱登录</h2>
        <p class="login-hint">使用 Trakt 账号邮箱登录，会向邮箱发送 6 位验证码。无需创建 OAuth 应用，不占用授权名额。</p>
        <div class="field">
          <label for="login-email">邮箱</label>
          <input id="login-email" type="email" placeholder="you@example.com" autocomplete="email" value="${esc(email)}" />
        </div>
        <button class="btn btn-primary btn-block" id="btn-send">发送验证码</button>
      </div>

      <div id="step-otp" hidden>
        <h2>输入验证码</h2>
        <p class="login-hint" id="otp-hint"></p>
        <div class="field">
          <label for="login-otp">6 位验证码</label>
          <input id="login-otp" class="otp-input" type="tel" inputmode="numeric" autocomplete="one-time-code"
                 maxlength="6" placeholder="——————" spellcheck="false" />
          <div class="input-foot">
            <span id="otp-err" class="err-text"></span>
            <button type="button" class="link-btn" id="btn-paste">粘贴验证码</button>
          </div>
        </div>
        <button class="btn btn-primary btn-block" id="btn-verify">登录</button>
        <div style="height:8px"></div>
        <button class="btn btn-block" id="btn-back">换邮箱 / 重新发送</button>
      </div>

      <div class="divider"></div>
      <p class="note">
        登录走的是 Trakt 网页版的官方认证链路（<b>auth.trakt.tv</b> 邮箱验证码 → 会话 → OIDC 授权码 → 令牌），
        凭证只保存在本服务端，浏览器仅持有 HttpOnly 会话 cookie。令牌约 7 天有效，会自动轮换续期。
      </p>
    </div>
  </div>`;

  const showOtp = (mail) => {
    $('#step-email').hidden = true;
    $('#step-otp').hidden = false;
    $('#otp-hint').innerHTML = `验证码已发送至 <b>${esc(mail)}</b>，5 分钟内有效。若没收到请检查垃圾邮件。`;
    $('#otp-err').textContent = '';
    const input = $('#login-otp');
    input.value = '';
    input.focus();
    setTimeout(() => input.focus(), 60);
  };
  const showEmail = (mail) => {
    $('#step-otp').hidden = true;
    $('#step-email').hidden = false;
    if (mail) $('#login-email').value = mail;
    $('#login-email').focus();
  };

  const send = async () => {
    const emailVal = $('#login-email').value.trim();
    if (!emailVal) return toast('请输入邮箱', true);
    const btn = $('#btn-send');
    btn.disabled = true;
    btn.textContent = '发送中…';
    try {
      const r = await fetch('/api/auth/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: emailVal }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.message || '发送失败');
      toast('验证码已发送');
      showOtp(emailVal);
    } catch (e) {
      toast(e.message, true);
      $('#otp-err').textContent = e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = '发送验证码';
    }
  };

  const verify = async () => {
    const otp = $('#login-otp').value.replace(/\D/g, '');
    if (otp.length !== 6) {
      $('#otp-err').textContent = '请输入 6 位数字验证码';
      return;
    }
    const btn = $('#btn-verify');
    btn.disabled = true;
    btn.textContent = '登录中…';
    $('#otp-err').textContent = '';
    try {
      const r = await fetch('/api/auth/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ otp }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.message || '登录失败');
      state.user = j.user;
      location.hash = '#/dashboard';
      await boot(true);
    } catch (e) {
      $('#otp-err').textContent = e.message;
      toast(e.message, true);
      btn.disabled = false;
      btn.textContent = '登录';
    }
  };

  $('#btn-send').onclick = send;
  $('#login-email').onkeydown = (e) => e.key === 'Enter' && send();
  $('#btn-back').onclick = () => showEmail($('#login-email').value.trim());

  const otpInput = $('#login-otp');
  // 过滤非数字（输入法、粘贴、拖入都走这里）
  otpInput.addEventListener('input', () => {
    const digits = otpInput.value.replace(/\D/g, '').slice(0, 6);
    if (otpInput.value !== digits) otpInput.value = digits;
    $('#otp-err').textContent = '';
    if (digits.length === 6) verify();
  });
  otpInput.onkeydown = (e) => {
    if (e.key === 'Enter') verify();
  };
  $('#btn-verify').onclick = verify;
  // 键盘在预览面板/内嵌 webview 里被拦截时的兜底
  $('#btn-paste').onclick = async () => {
    try {
      const text = await navigator.clipboard.readText();
      const digits = (text || '').replace(/\D/g, '').slice(0, 6);
      if (digits.length === 6) {
        otpInput.value = digits;
        await verify();
      } else {
        $('#otp-err').textContent = '剪贴板里没有 6 位数字';
      }
    } catch {
      $('#otp-err').textContent = '无法读取剪贴板，请手动输入';
    }
  };

  if (step === 'otp' && email) showOtp(email);
  else showEmail(email);
}

/* ───────── 外壳 ───────── */

// 标签存中文源文，渲染后由 i18n 的 observer 翻译。
// 这里千万不要用 t()：模块加载时就固化了语言，服务端改语言后导航会留在旧语言里。
const NAV = [
  // 概览是默认页，排在最前；搜索紧随其下
  ['dashboard', ICON.grid, '概览'],
  ['search', ICON.search, '搜索'],
  ['tracking', ICON.play, '追剧'],
  ['records', ICON.history, '记录'],
  ['library', ICON.layers, '片单'],
  ['settings', ICON.settings, '设置'],
];

/**
 * 旧的独立页 hash → 新地址（收藏夹里的老链接照样能用）。
 * 片单已取消标题下方的 tab 条，待看 / 收藏 改为表格工具条内切换。
 */
const LEGACY_ROUTES = {
  progress: 'tracking',
  calendar: 'tracking',
  history: 'records?tab=history',
  ratings: 'records?tab=ratings',
  lists: 'library',
  favorites: 'library?tab=favorites',
  stats: 'dashboard',
};

/* ───────── 主题（设计令牌配套，见 styles.css 的 :root） ───────── */

const THEME_KEY = 'tm_theme';
const THEME_LABEL = { auto: '跟随系统', dark: '深色', light: '浅色' };

/* 图标统一来自 ui.js 的 ICON 表，避免一处 emoji、一处 SVG 两套语言 */
const THEME_ICON = { auto: ICON.auto, dark: ICON.moon, light: ICON.sun };

function themeMode() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === 'light' || v === 'dark' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

/** 系统偏好解析：auto 模式下唯一的口径 */
function systemTheme() {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/**
 * 写入 <html data-theme>：auto 也解析成具体值。
 * 这样 CSS 只需要一份 [data-theme="light"] 令牌层，不必再为媒体查询复制一遍浅色变量。
 */
function setTheme(mode) {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {}
  document.documentElement.dataset.theme = mode === 'auto' ? systemTheme() : mode;
}

/* 系统主题变化：auto 模式下页面常开也要即时跟随 */
if (typeof matchMedia === 'function') {
  const themeMq = matchMedia('(prefers-color-scheme: light)');
  const syncSystemTheme = () => {
    if (themeMode() === 'auto') document.documentElement.dataset.theme = systemTheme();
  };
  if (themeMq.addEventListener) themeMq.addEventListener('change', syncSystemTheme);
  else if (themeMq.addListener) themeMq.addListener(syncSystemTheme);
}

/* ───────── 沉浸背景：TMDB / Trakt 封面，来源在设置里选 ───────── */
/*
 * 图片不直连 image.tmdb.org：统一走 /api/poster?...&art=backdrop 的服务端代理，
 * 与海报同一条链路（同源、可缓存、规避 ORB）。这里只负责「选图 + 交叉淡入」。
 */

const BG_KEY = 'tm_bg';
const BG_LAST_KEY = 'tm_bg_last';
const BG_SOURCES = {
  off: '关闭',
  recent: '最近观看',
  favorites: '收藏',
  watchlist: '待看',
  rated: '我的高分',
};
const BG_DIMS = { soft: '柔和', medium: '标准', strong: '厚重' };
// 选项文案直接按语言取：<option> 里的文字是拼出来的，走不到字典
const BG_SOURCES_EN = { off: 'Off', recent: 'Recently watched', favorites: 'Favorites', watchlist: 'Watchlist', rated: 'My top rated' };
const BG_DIMS_EN = { soft: 'Soft', medium: 'Standard', strong: 'Strong' };
const bgLabel = (k) => (isEn() ? BG_SOURCES_EN[k] || k : BG_SOURCES[k]);
const bgDimLabel = (k) => (isEn() ? BG_DIMS_EN[k] || k : BG_DIMS[k]);
const BG_ROTATE_MS = 45000;

function bgPref() {
  try {
    const raw = JSON.parse(localStorage.getItem(BG_KEY) || '{}');
    return {
      source: BG_SOURCES[raw.source] ? raw.source : 'recent',
      dim: BG_DIMS[raw.dim] ? raw.dim : 'medium',
    };
  } catch {
    return { source: 'recent', dim: 'medium' };
  }
}

function bgSavePref(patch) {
  const next = { ...bgPref(), ...patch };
  try {
    localStorage.setItem(BG_KEY, JSON.stringify(next));
  } catch {}
  applyBackdrop({ reload: true });
  return next;
}

const bgCache = new Map();
let bgItems = [];
let bgCursor = 0;
let bgTimer = null;
let bgFrame = 0;

function backdropUrl(it) {
  const p = new URLSearchParams({ type: it.type || 'movie', art: 'backdrop', v: '4' });
  if (it.trakt) p.set('trakt', it.trakt);
  if (it.tmdb) p.set('tmdb', it.tmdb);
  return `/api/poster?${p.toString()}`;
}

async function bgFetch(source) {
  if (bgCache.has(source)) return bgCache.get(source);
  const r = await fetch(`/api/backdrops?source=${encodeURIComponent(source)}`, { headers: apiHeaders() });
  const j = await r.json().catch(() => ({}));
  const items = j.ok && Array.isArray(j.items) ? j.items : [];
  if (items.length) bgCache.set(source, items);
  return items;
}

/** 双图层交叉淡入：始终往「当前不显示」的那层写，加载完再切 opacity */
function bgPaint(url) {
  const frames = document.querySelectorAll('#backdrop .bd-frame');
  if (!frames.length) return;
  const show = frames[bgFrame % frames.length];
  const hide = frames[(bgFrame + 1) % frames.length];
  const probe = new Image();
  probe.onload = () => {
    show.style.backgroundImage = `url("${url}")`;
    show.classList.add('on');
    hide.classList.remove('on');
    try {
      localStorage.setItem(BG_LAST_KEY, url);
    } catch {}
    bgFrame += 1;
    // 预取下一张，切图时不出现空白
    const next = bgItems[(bgCursor + 1) % Math.max(bgItems.length, 1)];
    if (next) new Image().src = backdropUrl(next);
  };
  probe.src = url;
}

function bgStep() {
  if (!bgItems.length) return;
  bgPaint(backdropUrl(bgItems[bgCursor % bgItems.length]));
  bgCursor += 1;
}

function bgStopTimer() {
  if (bgTimer) clearInterval(bgTimer);
  bgTimer = null;
}

function bgStartTimer() {
  bgStopTimer();
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || bgItems.length < 2) return;
  bgTimer = setInterval(() => {
    if (!document.hidden) bgStep();
  }, BG_ROTATE_MS);
}

async function applyBackdrop({ reload = false } = {}) {
  const pref = bgPref();
  const root = document.documentElement;
  root.dataset.bg = pref.source === 'off' ? 'off' : 'on';
  root.dataset.bgDim = pref.dim;

  if (pref.source === 'off') {
    bgStopTimer();
    bgItems = [];
    document.querySelectorAll('#backdrop .bd-frame').forEach((el) => {
      el.classList.remove('on');
      el.style.backgroundImage = '';
    });
    return;
  }

  // 上次的图先顶上去，避免进页面时先空一拍
  if (!reload) {
    try {
      const last = localStorage.getItem(BG_LAST_KEY);
      if (last) bgPaint(last);
    } catch {}
  }

  if (reload) bgCache.delete(pref.source);
  let items = [];
  try {
    items = await bgFetch(pref.source);
  } catch {
    items = [];
  }
  bgItems = items;
  bgCursor = 0;
  if (!bgItems.length) {
    bgStopTimer();
    return;
  }
  bgStep();
  bgStartTimer();
}

/** 背景层：两张图层 + 一层遮罩，遮罩强度由 data-bg-dim 决定 */
function backdropLayer() {
  return `<div class="backdrop" id="backdrop" aria-hidden="true">
    <div class="bd-frame"></div><div class="bd-frame"></div><div class="bd-veil"></div>
  </div>`;
}

function shell() {
  const name = state.user?.name || state.user?.username || 'U';
  const initial = name.slice(0, 1).toUpperCase();
  const mode = themeMode();
  app().innerHTML = `
  ${backdropLayer()}
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">T</div>
        <div class="brand-text">
          <div class="brand-name">Trakt Manager</div>
          <div class="brand-sub">数据管理面板</div>
        </div>
      </div>
      <nav class="nav">${NAV.map(([k, ic, label]) => `<div class="nav-item" data-nav="${k}"><span class="ic">${ic}</span>${label}</div>`).join('')}</nav>
      <div class="sidebar-foot">
        <div class="user-chip">
          ${state.user?.avatar
            ? `<img class="avatar avatar-img" id="user-avatar" src="/api/avatar" alt="${esc(name)}" />`
            : `<div class="avatar">${esc(initial)}</div>`}
          <div class="user-meta">
            <div class="user-name">${esc(name)}</div>
            <div class="user-sub">@${esc(state.user?.username || '')}</div>
          </div>
          <div class="foot-actions">
            <button class="icon-btn" id="btn-theme" title="主题：${THEME_LABEL[mode]}（点击切换）" aria-label="切换主题">${THEME_ICON[mode]}</button>
            <button class="icon-btn" id="btn-logout" title="退出登录" aria-label="退出登录">${ICON.power}</button>
          </div>
        </div>
      </div>
    </aside>
    <main class="main" id="view"></main>
  </div>`;

  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.onclick = () => {
      location.hash = `#/${el.dataset.nav}`;
    };
  });
  // 头像取不到（未设置 / 代理失败）时回落到首字母
  const avatar = $('#user-avatar');
  if (avatar) {
    avatar.onerror = () => {
      const fallback = document.createElement('div');
      fallback.className = 'avatar';
      fallback.textContent = initial;
      avatar.replaceWith(fallback);
    };
  }
  $('#btn-theme').onclick = () => {
    const order = ['auto', 'dark', 'light'];
    const next = order[(order.indexOf(themeMode()) + 1) % order.length];
    setTheme(next);
    const btn = $('#btn-theme');
    btn.innerHTML = THEME_ICON[next];
    btn.title = `主题：${THEME_LABEL[next]}（点击切换）`;
  };
  $('#btn-logout').onclick = async () => {
    if (!(await confirmDialog('退出登录？', '会清除本机的登录状态与设备令牌，下次进入需要重新输入邮箱验证码。'))) return;
    await fetch('/api/auth/logout', { method: 'POST', headers: apiHeaders() });
    try { localStorage.removeItem(DEVICE_KEY); } catch {}
    state.user = null;
    renderLogin();
  };
  applyBackdrop();
  route();
}

function route() {
  const raw = location.hash.replace(/^#\/?/, '') || 'dashboard';
  const [key, qs = ''] = raw.split('?');
  // 老地址（#/progress、#/stats…）重定向到合并后的分节，不留在历史里
  if (LEGACY_ROUTES[key]) {
    location.replace(`#/${LEGACY_ROUTES[key]}`);
    return;
  }
  state.route = key === 'detail' ? 'detail' : NAV.some(([k]) => k === key) ? key : 'dashboard';
  state.query = new URLSearchParams(qs);
  if (state.route !== 'detail') {
    detailToken += 1;
    detailView = null;
    document.documentElement.style.removeProperty('--detail-tint-rgb');
  }
  $('#view').classList.toggle('detail-view', state.route === 'detail');
  document.querySelectorAll('[data-nav]').forEach((el) => el.classList.toggle('active', el.dataset.nav === state.route));
  const done = PAGES[state.route]();
  // 从详情返回：等本页内容（含异步列表）画完再滚回原位置，避免被空内容夹到 0
  const remembered = state.route !== 'detail' ? scrollMemory.get(location.hash || '#/dashboard') : null;
  if (remembered) {
    scrollMemory.delete(location.hash || '#/dashboard');
    Promise.resolve(done)
      .catch(() => {})
      .then(() => requestAnimationFrame(() => requestAnimationFrame(() => restoreScroll(remembered))));
  }
}

/** 把筛选/搜索/页码写进 hash（如 #/search?q=abc&page=2），刷新与前进后退都能还原 */
function setQuery(patch) {
  const q = new URLSearchParams(state.query);
  Object.entries(patch).forEach(([k, v]) => {
    if (v === '' || v === null || v === undefined) q.delete(k);
    else q.set(k, String(v));
  });
  const qs = q.toString();
  const next = `#/${state.route}${qs ? `?${qs}` : ''}`;
  if (location.hash === next) route();
  else location.hash = next;
}

window.addEventListener('hashchange', () => {
  if (state.user) route();
});

function head(title, sub, actions = '') {
  return `<div class="page-head"><div><h1>${esc(title)}</h1><div class="sub">${esc(sub)}</div></div>
    <div class="toolbar">${actions}</div></div>`;
}

/**
 * 全站唯一的「导出」控件：记录 / 评分管理 / 片单都用同一颗按钮 + 同一份菜单，
 * 避免一处是下拉、一处是直跳的样式分叉。
 * urlFor(format) 返回下载地址；返回空串表示当前不能导出（提示由调用方自己发）。
 */
function exportMenu(id) {
  return `<div class="menu-wrap" id="${id}-wrap">
    <button class="seg-btn" id="${id}" aria-haspopup="menu" aria-expanded="false">导出<span class="caret" aria-hidden="true">▾</span></button>
    <div class="cal-menu export-menu" id="${id}-menu" role="menu" hidden>
      <button role="menuitem" data-fmt="csv">导出 CSV</button>
      <button role="menuitem" data-fmt="json">导出 JSON</button>
    </div>
  </div>`;
}

function mountExportMenu(id, urlFor) {
  const btn = document.getElementById(id);
  const menu = document.getElementById(`${id}-menu`);
  if (!btn || !menu) return;
  const close = () => {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    if (!menu.hidden) return close();
    if (!urlFor('csv')) return;
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  };
  menu.querySelectorAll('[data-fmt]').forEach((b) => {
    b.onclick = () => {
      close();
      const url = urlFor(b.dataset.fmt);
      if (url) window.location = url;
    };
  });
  menu.onclick = (e) => e.stopPropagation();
  const onDocClick = () => {
    close();
    if (!menu.isConnected) document.removeEventListener('click', onDocClick);
  };
  document.addEventListener('click', onDocClick);
}

/* ───────── 概览 ───────── */

const PAGES = {};

function readDetailParams(query) {
  const type = ['movie', 'show', 'episode', 'season'].includes(query.get('type')) ? query.get('type') : '';
  const ids = { trakt: query.get('trakt') || '', tmdb: query.get('tmdb') || '' };
  const season = query.get('s');
  const number = query.get('e');
  if (!type) throw new Error('链接缺少有效的条目类型');
  if (!ids.trakt && !ids.tmdb) throw new Error('链接缺少 trakt 或 tmdb id');
  if ((type === 'season' || type === 'episode') && (season === null || !/^\d+$/.test(season))) {
    throw new Error('季或分集链接缺少有效的季号');
  }
  if (type === 'episode' && (number === null || !/^\d+$/.test(number))) {
    throw new Error('分集链接缺少有效的集号');
  }
  return { type, ids, season: season === null ? undefined : Number(season), number: number === null ? undefined : Number(number) };
}

async function loadDetailWatched(showTrakt) {
  if (!showTrakt) return new Map();
  try {
    const r = await api(`/shows/${showTrakt}/progress/watched`);
    const map = new Map();
    (r.data?.seasons || []).forEach((season) => {
      (season.episodes || []).forEach((ep) => {
        if (ep.completed) map.set(`S${season.number}E${ep.number}`, 1);
      });
    });
    // 同一份响应里就有续播位置，顺手记下来给「上次看到 / 下一集」用，不额外打接口
    if (detailView) {
      detailView.progress = {
        aired: Number(r.data?.aired) || 0,
        completed: Number(r.data?.completed) || 0,
        last: r.data?.last_episode || null,
        next: r.data?.next_episode || null,
      };
    }
    return map;
  } catch {
    return watchedEpisodeMap(showTrakt);
  }
}

function currentDetailTarget(view, type = view.params.type) {
  const { ids } = view.params;
  if (type === 'season') type = 'show';
  if (type === 'episode') {
    const ep = view.episodes.find((e) => Number(e.number) === Number(view.params.number));
    return {
      type,
      ids: ep?.ids || {},
      season: view.season,
      number: view.params.number,
      released: String(ep?.first_aired || '').slice(0, 10),
      title: ep?.title || `第 ${view.params.number} 集`,
    };
  }
  if (type === 'season') {
    const season = view.seasons.find((s) => Number(s.number) === Number(view.season));
    return {
      type,
      ids: season?.ids || {},
      season: view.season,
      released: String(season?.first_aired || '').slice(0, 10),
      title: view.season === 0 ? '特别篇' : `第 ${view.season} 季`,
    };
  }
  return {
    type,
    ids,
    released: String(view.meta?.released || '').slice(0, 10),
    title: view.meta?.title || '',
  };
}

/** 读主题色变量并转为 [r,g,b] */
function cssVarRgb(name) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return [13, 14, 16];
}

/** 封面图降采样取主色，与页面底色 82:18 混合为融合色写入 :root 的 --detail-tint-rgb（全局，含侧边栏；失败回落纯底色） */
function paintDetailTint(url) {
  const root = document.documentElement;
  const bg = cssVarRgb('--bg');
  const apply = (r, g, b) => root.style.setProperty('--detail-tint-rgb', `${Math.round(r)},${Math.round(g)},${Math.round(b)}`);
  const fallback = () => apply(bg[0], bg[1], bg[2]);
  const img = new Image();
  img.onload = () => {
    try {
      const cv = document.createElement('canvas');
      cv.width = 24;
      cv.height = 14;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, 24, 14);
      const d = ctx.getImageData(0, 0, 24, 14).data;
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
        if (lum < 16 || lum > 240) continue;
        r += d[i];
        g += d[i + 1];
        b += d[i + 2];
        n += 1;
      }
      if (!n) return fallback();
      apply(bg[0] * 0.82 + (r / n) * 0.18, bg[1] * 0.82 + (g / n) * 0.18, bg[2] * 0.82 + (b / n) * 0.18);
    } catch {
      fallback();
    }
  };
  img.onerror = fallback;
  img.src = url;
}

function renderDetailShell() {
  document.documentElement.style.removeProperty('--detail-tint-rgb');
  $('#view').innerHTML = `
    <section class="detail-hero" id="detail-hero">
      <div class="detail-backdrop" id="detail-backdrop"></div>
      <div class="detail-hero-shade"></div>
      <div class="detail-hero-inner">
        <button class="detail-back" id="detail-back" type="button">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M15 5l-7 7 7 7M8 12h11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
          返回
        </button>
        <div class="detail-hero-content" id="detail-hero-content">
          <div class="detail-copy"><div class="detail-kicker">正在加载</div><div class="skeleton" style="height:46px;width:min(520px,80%);margin:14px 0"></div><div class="skeleton" style="height:15px;width:min(620px,92%)"></div></div>
        </div>
      </div>
    </section>
    <div class="detail-lower">
      <section class="detail-actions-wrap" id="detail-actions-wrap" aria-label="条目管理"></section>
      <section class="detail-body" id="detail-body">${loadingBox()}</section>
    </div>`;
  $('#detail-back').onclick = () => {
    if (history.length > 1) history.back();
    else location.hash = '#/dashboard';
  };
}

const D_ICON_INFO = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5h.01"/></svg>';
const D_ICON_EXT = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/><path d="M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5"/></svg>';

function renderDetailHero() {
  const v = detailView;
  if (!v?.meta || state.route !== 'detail' || !state.user) return;
  const backdrop = $('#detail-backdrop');
  const content = $('#detail-hero-content');
  if (!backdrop || !content) return;
  const meta = v.meta;
  const target = v.target;
  const titleQuery = artQuery(v.params.type === 'movie' ? 'movie' : 'show', v.params.ids);
  const episodeSelected = target.type === 'episode';
  const backdropQuery = episodeSelected
    ? artQuery('episode', v.params.ids, v.season, target.number)
    : titleQuery;
  const backdropUrl = `/api/poster?${backdropQuery}${episodeSelected ? '' : '&art=backdrop'}`;
  backdrop.style.backgroundImage = `url("${backdropUrl}")`;
  paintDetailTint(backdropUrl);
  let info;
  if (episodeSelected) {
    const ep = v.episodes.find((e) => Number(e.number) === Number(target.number)) || {};
    const code = `S${pad2(v.season)}E${pad2(target.number)}`;
    info = {
      kicker: '选集',
      title: meta.title || target.title,
      sub: `${code} · ${ep.title || `第 ${target.number} 集`}`,
      logoSub: `${code} · ${ep.title || `第 ${target.number} 集`}`,
      facts: [
        ep.first_aired ? fmtDate(ep.first_aired) : '播出时间未知',
        ep.runtime ? `${ep.runtime} 分钟` : '',
        ep.rating ? `★ ${ep.rating}` : '',
      ],
      overview: ep.overview,
      returnable: true,
    };
  } else {
    info = {
      kicker: target.type === 'movie' ? '电影' : `剧集${meta.status ? ` · ${meta.status}` : ''}`,
      title: meta.title || target.title,
      sub: meta.original_title && meta.original_title !== meta.title ? meta.original_title : '',
      facts: [
        meta.year || '',
        meta.runtime ? `${meta.runtime} 分钟` : '',
        meta.rating ? `★ ${meta.rating}` : '',
        meta.votes ? `${num(meta.votes)} 人评分` : '',
      ],
      overview: meta.overview,
      returnable: false,
    };
  }
  // 切换选集只替换剧照与文案，剧名艺术字保持剧集级资源
  const logoUrl = `/api/poster?${titleQuery}&art=logo`;
  const artLogo = meta.logo ? logoUrl : '';
  content.innerHTML = `
    <div class="detail-copy">
      <div class="detail-kicker">${esc(info.kicker)}</div>
      <div class="detail-title-wrap${artLogo ? ' has-logo' : ''}">
        ${artLogo ? `<img class="detail-logo" src="${logoUrl}" alt="${esc(meta.title || info.title || '')}" onerror="const w=this.closest('.detail-title-wrap');if(w)w.classList.remove('has-logo');this.remove()" />` : ''}
        <h1 class="detail-page-title">${esc(info.title || '未命名')}</h1>
      </div>
      ${info.logoSub ? `<div class="detail-page-sub detail-sub-logo">${esc(info.logoSub)}</div>` : ''}
      ${info.sub && info.sub !== info.title ? `<div class="detail-page-sub detail-sub-plain">${esc(info.sub)}</div>` : ''}
      <div class="detail-page-facts">${info.facts.filter(Boolean).map((f) => `<span>${esc(f)}</span>`).join('<i>·</i>')}</div>
      ${target.type === 'movie' || target.type === 'show' ? (meta.genres || []).length ? `<div class="detail-page-genres">${meta.genres.map((g) => `<span class="chip">${esc(g)}</span>`).join('')}</div>` : '' : ''}
      <p class="detail-page-overview">${esc(info.overview || '暂无简介')}</p>
      <div class="detail-page-links">
        ${info.returnable ? `<button class="btn btn-sm detail-link" id="detail-show-info" type="button">${D_ICON_INFO}返回剧集简介</button>` : ''}
        ${meta.links?.tmdb ? `<a class="btn btn-sm detail-link" href="${esc(meta.links.tmdb)}" target="_blank" rel="noreferrer">${D_ICON_EXT}TMDB</a>` : ''}
        ${meta.links?.trakt ? `<a class="btn btn-sm detail-link" href="${esc(meta.links.trakt)}" target="_blank" rel="noreferrer">${D_ICON_EXT}Trakt</a>` : ''}
      </div>
    </div>`;
  const showInfo = $('#detail-show-info');
  if (showInfo) showInfo.onclick = () => selectDetailTarget('show', v.season);
  renderDetailActions(info);
}

/** 管理已从封面右侧移到封面下方：不遮剧照，且与下方剧集管理同宽、同一套卡片语言 */
function renderDetailActions(info = {}) {
  const v = detailView;
  const wrap = $('#detail-actions-wrap');
  if (!v || !wrap) return;
  wrap.innerHTML = `
    <div class="card item-manager" id="item-manager" aria-label="条目管理">
      <div class="item-manager-head">
        <div class="item-manager-title"><span>${ICON.settings}</span><h2>管理</h2></div>
        <p class="item-manager-sub">${esc(v.target?.title || v.meta?.title || info.title || '')}</p>
      </div>
      <div id="action-box">${v.stateReady ? '' : loadingBox()}</div>
    </div>`;
  if (v.stateReady) paintActions({ ...v.target, onUpdated: detailActionUpdated }, v.state || {});
}

const EPISODE_PAGE_SIZE = 50;

function episodePageFor(number) {
  return Math.floor(Math.max(0, Number(number) - 1) / EPISODE_PAGE_SIZE);
}

function filteredDetailEpisodes(v) {
  const q = String(v.episodeQuery || '').trim().toLowerCase();
  const status = v.episodeStatus || 'all';
  const today = todayStr();
  return v.episodes.filter((ep) => {
    const watched = Boolean(v.watched.get(`S${v.season}E${ep.number}`));
    const air = String(ep.first_aired || '').slice(0, 10);
    const future = Boolean(air && air > today);
    if (status === 'watched' && !watched) return false;
    if (status === 'unwatched' && (watched || future)) return false;
    if (status === 'unaired' && !future) return false;
    const haystack = `${ep.number} ${pad2(ep.number)} ${ep.title || ''}`.toLowerCase();
    return !q || haystack.includes(q);
  });
}

/** 多选选中的集号集合（同一季内复用一个 Set） */
function detailSelection(v) {
  if (!(v.episodeSelection instanceof Set)) v.episodeSelection = new Set();
  return v.episodeSelection;
}

function detailEpisodeRow(v, ep) {
  const key = `S${v.season}E${ep.number}`;
  const watched = Boolean(v.watched.get(key));
  const air = String(ep.first_aired || '').slice(0, 10);
  const future = Boolean(air && air > todayStr());
  const selected = v.target?.type === 'episode' && Number(v.target.number) === Number(ep.number);
  const picked = detailSelection(v).has(Number(ep.number));
  const code = `S${pad2(v.season)}E${pad2(ep.number)}`;
  const title = ep.title || `第 ${ep.number} 集`;
  return `<tr class="episode-row${selected ? ' is-selected' : ''}" data-detail-episode="${ep.number}" tabindex="0" aria-selected="${selected}" aria-label="查看 ${esc(code)} ${esc(title)}">
    <td class="episode-check-cell"><input type="checkbox" class="checkbox episode-check" data-episode-check="${ep.number}" aria-label="选择 ${esc(code)}"${picked ? ' checked' : ''} /></td>
    <td><div class="episode-ident">
      <span class="episode-table-art"><img loading="lazy" src="/api/poster?${artQuery('episode', v.params.ids, v.season, ep.number)}" alt="" onerror="this.closest('.episode-table-art').classList.add('thumb-empty');this.remove()" /></span>
      <span class="episode-code">${code}</span>
    </div></td>
    <td class="episode-title-cell"><strong>${esc(title)}</strong></td>
    <td class="episode-date-cell">${esc(air || '—')}</td>
    <td class="episode-runtime-cell">${ep.runtime ? `${ep.runtime} 分钟` : '—'}</td>
    <td><span class="chip${watched ? ' ok' : ''}">${watched ? '已看' : future ? '未播' : '未看'}</span></td>
    <td class="episode-action-cell"><button type="button" class="btn btn-sm episode-watch${watched ? '' : ' btn-primary'}" data-episode-watch="${ep.number}">${watched ? '取消已看' : '标记看过'}</button></td>
  </tr>`;
}

function paintEpisodeManager(v) {
  const root = $('#episode-manager');
  if (!root) return;
  const filtered = filteredDetailEpisodes(v);
  const pageCount = Math.max(1, Math.ceil(filtered.length / EPISODE_PAGE_SIZE));
  v.episodePage = Math.min(Math.max(0, Number(v.episodePage) || 0), pageCount - 1);
  const start = v.episodePage * EPISODE_PAGE_SIZE;
  const pageEps = filtered.slice(start, start + EPISODE_PAGE_SIZE);
  $('#episode-rows', root).innerHTML = pageEps.map((ep) => detailEpisodeRow(v, ep)).join('') ||
    '<tr><td colspan="7"><div class="episode-empty">没有匹配的分集</div></td></tr>';
  paintEpisodeSelection(v, pageEps);
  $('#episode-result-count', root).textContent = `${filtered.length} 集`;
  const watched = v.episodes.filter((ep) => v.watched.get(`S${v.season}E${ep.number}`)).length;
  $('#season-progress', root).textContent = `本季已看 ${watched}/${v.episodes.length}`;
  const pages = $('#episode-pages', root);
  pages.hidden = pageCount <= 1;
  pages.innerHTML = pageCount <= 1 ? '' : Array.from({ length: pageCount }, (_, i) => {
    const from = i * EPISODE_PAGE_SIZE + 1;
    const to = Math.min(filtered.length, (i + 1) * EPISODE_PAGE_SIZE);
    return `<button type="button" class="episode-page${i === v.episodePage ? ' active' : ''}" data-episode-page="${i}" aria-pressed="${i === v.episodePage}">${from}–${to}</button>`;
  }).join('');
}

/** 多选：把 Set 里的集号还原成当前季里确实存在的分集号（升序） */
function selectedDetailEpisodeNumbers(v) {
  const picked = detailSelection(v);
  return v.episodes
    .filter((ep) => picked.has(Number(ep.number)))
    .map((ep) => Number(ep.number))
    .sort((a, b) => a - b);
}

/** 补标用：比所选最大集号更早、且当前未看的集（不含已选） */
function previousUnwatchedNumbers(v, numbers) {
  if (!numbers.length) return [];
  const max = Math.max(...numbers.map(Number));
  return v.episodes
    .filter((ep) => Number(ep.number) < max && !v.watched.get(`S${v.season}E${ep.number}`))
    .map((ep) => Number(ep.number))
    .sort((a, b) => a - b);
}

function paintEpisodeSelection(v, pageEps = []) {
  const bar = $('#episode-selection-bar');
  const label = $('#episode-selection-label');
  const all = $('#episode-check-all');
  const nums = selectedDetailEpisodeNumbers(v);
  if (bar && label) {
    bar.hidden = nums.length === 0;
    if (nums.length) {
      const shown = nums.slice(0, 12).map((n) => `E${pad2(n)}`).join('、');
      label.textContent = nums.length > 12 ? `已选 ${nums.length} 集：${shown} 等` : `已选 ${nums.length} 集：${shown}`;
    }
  }
  if (all) {
    const pageNums = pageEps.map((ep) => Number(ep.number));
    const pickedAll = pageNums.filter((n) => detailSelection(v).has(n));
    all.checked = pageNums.length > 0 && pickedAll.length === pageNums.length;
    all.indeterminate = pickedAll.length > 0 && pickedAll.length < pageNums.length;
    all.disabled = pageNums.length === 0;
  }
}

/**
 * 多选标记已看：复用整季批量接口，但只写选中的集号。
 * 选「各集发布日」时由服务端按每一集自己的 first_aired 写入，不再共用某一集的日期。
 */
async function runSelectedWatch(btn) {
  const v = detailView;
  if (!v) return;
  const nums = selectedDetailEpisodeNumbers(v);
  if (!nums.length) return toast('先勾选要标记的分集', true);
  const trakt = Number(v.params.ids?.trakt);
  if (!trakt) return toast('这个条目缺少 Trakt id，无法操作', true);

  const catchUp = previousUnwatchedNumbers(v, nums);
  const missingAir = v.episodes.filter((ep) => nums.includes(Number(ep.number)) && !String(ep.first_aired || '').slice(0, 10)).length;
  const choice = await chooseWatchDate({
    perEpisode: true,
    title: `${v.meta?.title || ''} 已选 ${nums.length} 集`,
    catchUp: catchUp.length,
    missingAir,
  });
  if (!choice) return;

  const target = new Set(nums);
  if (choice.includePrevious) catchUp.forEach((n) => target.add(n));
  const episodes = [...target].sort((a, b) => a - b);
  const payload = { ids: { trakt }, season: Number(v.season), action: 'watch', episodes };
  if (choice.when) payload.when = choice.when;
  if (choice.when === 'custom') {
    payload.date = choice.date;
    payload.at = choice.at;
  }

  const old = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = '正在处理…';
  }
  try {
    const r = await postLocal('/api/season/watch', payload);
    const skipped = r.skipped ? `，跳过 ${r.skipped} 集（无首播日）` : '';
    const caught = choice.includePrevious && catchUp.length ? `（含补标 ${catchUp.length} 集）` : '';
    toast(`多选已标记：新增 ${r.added} 集，已存在 ${r.existing} 集${caught}${skipped}`);
    detailSelection(v).clear();
    await detailActionUpdated(null, 'watch');
  } catch (e) {
    toast(e.message, true);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = old;
    }
  }
}

async function toggleDetailEpisode(number, btn) {
  const v = detailView;
  const ep = v?.episodes.find((e) => Number(e.number) === Number(number));
  if (!v || !ep?.ids?.trakt) return toast('缺少分集 id，无法操作', true);
  const watched = Boolean(v.watched.get(`S${v.season}E${ep.number}`));
  let choice = null;
  if (!watched) {
    choice = await chooseWatchDate({
      released: String(ep.first_aired || '').slice(0, 10),
      title: `${v.meta?.title || ''} S${pad2(v.season)}E${pad2(ep.number)}`,
    });
    if (!choice) return;
  }
  btn.disabled = true;
  try {
    await runAction({
      type: 'episode', ids: ep.ids, season: v.season, number: ep.number,
      action: watched ? 'unwatch' : 'watch', ...(choice || {}),
    });
    toast(watched ? '已取消观看' : '已标记为已看');
    await detailActionUpdated(null, watched ? 'unwatch' : 'watch');
    if (v.target?.type === 'episode' && Number(v.target.number) === Number(ep.number)) await loadDetailTargetState();
  } catch (e) {
    toast(e.message, true);
    btn.disabled = false;
  }
}

function renderDetailBody() {
  const v = detailView;
  if (!v || state.route !== 'detail' || !state.user) return;
  const body = $('#detail-body');
  if (!body) return;
  if (v.params.type === 'movie') {
    body.innerHTML = '';
    body.hidden = true;
    return;
  }
  body.hidden = false;
  if (!v.seasons.length && !v.episodes.length) {
    body.innerHTML = emptyState('暂无分集数据', { icon: 'tv', hint: '稍后刷新重试' });
    return;
  }
  body.innerHTML = `
    <section class="card episode-manager" id="episode-manager" aria-label="剧集管理">
      <div class="episode-manager-head">
        <div>
          <div class="episode-manager-title"><span>${ICON.layers}</span><h2>剧集管理</h2></div>
          <p>选集查看剧照、简介与操作</p>
        </div>
        <div class="episode-manager-progress">
          <strong id="season-progress"></strong>
          ${progressText(v) ? `<span>${esc(progressText(v)).replace(/^ · /, '')}</span>` : ''}
        </div>
      </div>
      <div class="episode-toolbar">
        <label class="episode-season-control"><span>季</span><select id="detail-season-select" aria-label="选择季">
          ${v.seasons.map((s) => `<option value="${s.number}"${Number(s.number) === Number(v.season) ? ' selected' : ''}>${Number(s.number) === 0 ? '特别篇' : `第 ${s.number} 季`} · ${s.episode_count || 0} 集</option>`).join('')}
        </select></label>
        <label class="episode-search"><span>${ICON.search}</span><input id="episode-query" type="search" value="${esc(v.episodeQuery || '')}" placeholder="搜索集数或标题" autocomplete="off" /></label>
        <select id="episode-status" aria-label="筛选观看状态">
          <option value="all"${(v.episodeStatus || 'all') === 'all' ? ' selected' : ''}>全部状态</option>
          <option value="unwatched"${v.episodeStatus === 'unwatched' ? ' selected' : ''}>未看</option>
          <option value="watched"${v.episodeStatus === 'watched' ? ' selected' : ''}>已看</option>
          <option value="unaired"${v.episodeStatus === 'unaired' ? ' selected' : ''}>未播</option>
        </select>
        <div class="episode-batch">
          <button type="button" class="btn btn-sm" data-season-all="watch">整季已看</button>
          <button type="button" class="btn btn-sm" data-season-all="unwatch">整季取消</button>
        </div>
        <div class="episode-toolbar-pager">
          <span id="episode-result-count" class="sub"></span>
          <div class="episode-pages" id="episode-pages" role="group" aria-label="分集分页"></div>
        </div>
      </div>
      ${v.watchedDegraded ? '<p class="note">观看状态暂未同步，列表可能不是最新。</p>' : ''}
      <div class="episode-selection-bar" id="episode-selection-bar" hidden>
        <span id="episode-selection-label"></span>
        <div class="episode-selection-actions">
          <button type="button" class="btn btn-sm btn-primary" id="episode-selection-watch">标记所选已看</button>
          <button type="button" class="btn btn-sm" id="episode-selection-clear">清空选择</button>
        </div>
      </div>
      <div class="episode-table-wrap">
        <table class="episode-table">
          <thead><tr><th class="episode-check-cell"><input type="checkbox" class="checkbox" id="episode-check-all" aria-label="选择本页全部分集" /></th><th>集</th><th>标题</th><th class="episode-date-cell">首播</th><th class="episode-runtime-cell">时长</th><th>状态</th><th>操作</th></tr></thead>
          <tbody id="episode-rows"></tbody>
        </table>
      </div>
    </section>`;
  const root = $('#episode-manager');
  root.querySelectorAll('[data-season-all]').forEach((btn) => {
    btn.onclick = () => runSeasonAll(btn.dataset.seasonAll, btn);
  });
  $('#detail-season-select', root).onchange = (e) => {
    v.episodeQuery = '';
    v.episodeStatus = 'all';
    v.episodePage = 0;
    detailSelection(v).clear(); // 换季就换一批候选，旧选择不该跨季残留
    selectDetailTarget('show', Number(e.target.value));
  };
  $('#episode-selection-watch', root).onclick = () => runSelectedWatch($('#episode-selection-watch', root));
  $('#episode-selection-clear', root).onclick = () => {
    detailSelection(v).clear();
    paintEpisodeManager(v);
  };
  $('#episode-check-all', root).onchange = (e) => {
    const picked = detailSelection(v);
    const boxes = [...root.querySelectorAll('.episode-check')];
    boxes.forEach((box) => {
      const number = Number(box.dataset.episodeCheck);
      if (e.target.checked) picked.add(number);
      else picked.delete(number);
    });
    paintEpisodeManager(v);
  };
  $('#episode-query', root).oninput = (e) => {
    v.episodeQuery = e.target.value;
    v.episodePage = 0;
    paintEpisodeManager(v);
  };
  $('#episode-status', root).onchange = (e) => {
    v.episodeStatus = e.target.value;
    v.episodePage = 0;
    paintEpisodeManager(v);
  };
  root.addEventListener('click', (e) => {
    // 勾选框只切换多选，不再触发「选中该集看详情」
    const check = e.target.closest('.episode-check');
    if (check) {
      const number = Number(check.dataset.episodeCheck);
      const picked = detailSelection(v);
      if (picked.has(number)) picked.delete(number);
      else picked.add(number);
      paintEpisodeManager(v);
      return;
    }
    const watch = e.target.closest('[data-episode-watch]');
    if (watch) {
      toggleDetailEpisode(Number(watch.dataset.episodeWatch), watch);
      return;
    }
    const page = e.target.closest('[data-episode-page]');
    if (page) {
      v.episodePage = Number(page.dataset.episodePage) || 0;
      paintEpisodeManager(v);
      return;
    }
    const row = e.target.closest('tr[data-detail-episode]');
    if (row) selectDetailTarget('episode', v.season, Number(row.dataset.detailEpisode));
  });
  root.addEventListener('keydown', (e) => {
    if (!['Enter', ' '].includes(e.key)) return;
    const row = e.target.closest('tr[data-detail-episode]');
    if (!row || e.target !== row) return;
    e.preventDefault();
    selectDetailTarget('episode', v.season, Number(row.dataset.detailEpisode));
  });
  paintEpisodeManager(v);
}

/** 详情页副标题里的续播信息：已看 x/y 集 · 下一集 SxxExx */
function progressText(v) {
  const p = v?.progress;
  if (!p || (!p.aired && !p.completed)) return '';
  const en = getLang() === 'en-US';
  const done = `${p.completed}${p.aired ? `/${p.aired}` : ''}`;
  const parts = [en ? `Watched ${done}` : `已看 ${done} 集`];
  if (p.next) parts.push(`${en ? 'next' : '下一集'} S${pad2(p.next.season)}E${pad2(p.next.number)}`);
  else if (p.aired && p.completed >= p.aired) parts.push(en ? 'all caught up' : '已看完');
  return ` · ${parts.join(' · ')}`;
}

/**
 * 整季批量：一次请求交给服务端读分集 + 分批写 /sync/history，
 * 前端不再循环打 N 次接口（单集接口在弱网下很容易只成功一半）。
 */
async function runSeasonAll(action, btn) {
  const v = detailView;
  if (!v) return;
  const trakt = Number(v.params.ids?.trakt);
  const season = Number(v.season);
  if (!trakt) {
    toast('这个条目缺少 Trakt id，无法整季操作', true);
    return;
  }
  const seasonMeta = v.seasons.find((s) => Number(s.number) === season);
  let payload = { ids: { trakt }, season, action };

  if (action === 'watch') {
    const picked = await chooseWatchDate({
      released: String(seasonMeta?.first_aired || '').slice(0, 10),
      title: season === 0 ? '特别篇（整季）' : `第 ${season} 季（整季）`,
    });
    if (!picked) return;
    payload = { ...payload, ...picked };
  } else {
    const marked = v.episodes.filter((e) => v.watched.get(`S${season}E${e.number}`)).length;
    const ok = await confirmDialog(
      `取消第 ${season} 季的全部「已看」记录？`,
      `会删除该季已标记的观看记录（当前 ${marked} 集），不可撤销。`
    );
    if (!ok) return;
  }

  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '正在处理…';
  try {
    const r = await postLocal('/api/season/watch', payload);
    if (action === 'watch') {
      const skipped = r.skipped ? `，跳过 ${r.skipped} 集（无首播日）` : '';
      toast(`整季已标记：新增 ${r.added} 集，已存在 ${r.existing} 集${skipped}`);
    } else {
      toast(`已取消 ${r.removed} 集`);
    }
    await detailActionUpdated(null, action);
  } catch (e) {
    toast(e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

async function detailActionUpdated(_state, action) {
  if (!detailView || state.route !== 'detail' || !['watch', 'unwatch'].includes(action)) return;
  const v = detailView;
  const token = detailToken;
  try {
    const watched = await loadDetailWatched(v.params.ids.trakt);
    if (v !== detailView || token !== detailToken) return;
    v.watched = watched;
    v.watchedDegraded = false;
    renderDetailBody();
  } catch {
    v.watchedDegraded = true;
    renderDetailBody();
  }
}

async function loadDetailTargetState() {
  const v = detailView;
  if (!v) return;
  const revision = ++v.stateRevision;
  const token = detailToken;
  v.stateReady = false;
  renderDetailHero();
  const target = v.target;
  if (!target.ids?.trakt) {
    v.state = {};
    v.stateReady = true;
    renderDetailHero();
    return;
  }
  try {
    const j = await getJson(`/api/state?type=${target.type}&trakt=${encodeURIComponent(target.ids.trakt)}`);
    if (v !== detailView || token !== detailToken || revision !== v.stateRevision) return;
    v.state = j;
  } catch (e) {
    if (v !== detailView || token !== detailToken || revision !== v.stateRevision) return;
    v.state = { degraded: true, message: e.message };
  }
  v.stateReady = true;
  renderDetailHero();
}

async function selectDetailTarget(type, season, number) {
  const v = detailView;
  if (!v || state.route !== 'detail') return;
  const token = detailToken;
  const selection = ++v.selection;
  try {
    const body = $('#detail-body');
    if (!body) return;
    if (type !== 'movie' && Number(season) !== Number(v.season)) {
      body.innerHTML = loadingBox();
      let data = v.seasonCache.get(Number(season));
      if (!data) {
        const p = new URLSearchParams({ season });
        if (v.params.ids.trakt) p.set('trakt', v.params.ids.trakt);
        if (v.params.ids.tmdb) p.set('tmdb', v.params.ids.tmdb);
        data = await getJson(`/api/season?${p}`);
        v.seasonCache.set(Number(season), data);
      }
      if (v !== detailView || token !== detailToken || selection !== v.selection) return;
      v.season = Number(season);
      v.episodes = data.episodes || [];
      v.episodePage = 0;
    }
    if (type === 'episode' && number !== undefined) {
      const episodes = filteredDetailEpisodes(v);
      const index = episodes.findIndex((ep) => Number(ep.number) === Number(number));
      v.episodePage = index >= 0 ? Math.floor(index / EPISODE_PAGE_SIZE) : 0;
    }
    v.params = { ...v.params, type, season: v.season, number: type === 'episode' ? Number(number) : undefined };
    v.target = currentDetailTarget(v, type);
    const href = detailHref({ type, ids: v.params.ids, season: type === 'movie' ? undefined : v.season, number: v.params.number });
    if (location.hash !== href) history.pushState(null, '', href);
    state.query = new URLSearchParams(href.split('?')[1] || '');
    renderDetailHero();
    renderDetailBody({ centerActive: true });
    await loadDetailTargetState();
  } catch (e) {
    if (v !== detailView || token !== detailToken || selection !== v.selection || !state.user) return;
    const body = $('#detail-body');
    if (body) showError(body, e, () => selectDetailTarget(type, season, number));
  }
}

async function renderDetailPage() {
  const token = ++detailToken;
  let params;
  try {
    params = readDetailParams(state.query);
  } catch (e) {
    detailView = null;
    $('#view').innerHTML = `<section class="detail-invalid"><h1>无法打开详情</h1>${errorState(e)}<div class="toolbar" style="margin-top:16px"><a class="btn" href="#/dashboard">返回概览</a></div></section>`;
    return;
  }
  const v = {
    params,
    meta: null,
    seasons: [],
    season: params.season,
    episodes: [],
    watched: new Map(),
    watchedDegraded: false,
    episodePage: 0,
    seasonCache: new Map(),
    target: null,
    state: null,
    stateReady: false,
    stateRevision: 0,
    selection: 0,
    episodeSelection: new Set(), // 多选选中的集号（同一季内）
  };
  detailView = v;
  renderDetailShell();
  const isShow = params.type !== 'movie';
  try {
    const seasonQuery = new URLSearchParams();
    if (params.ids.trakt) seasonQuery.set('trakt', params.ids.trakt);
    if (params.ids.tmdb) seasonQuery.set('tmdb', params.ids.tmdb);
    if (params.season !== undefined) seasonQuery.set('season', params.season);
    const [meta, seasonData, watched] = await Promise.all([
      getJson(`/api/meta?${artQuery(isShow ? 'show' : 'movie', params.ids)}`),
      isShow ? getJson(`/api/season?${seasonQuery}`) : Promise.resolve(null),
      isShow
        ? loadDetailWatched(params.ids.trakt).catch(() => { v.watchedDegraded = true; return new Map(); })
        : Promise.resolve(new Map()),
    ]);
    if (v !== detailView || token !== detailToken || state.route !== 'detail') return;
    v.meta = meta.data;
    v.watched = watched;
    if (isShow) {
      v.seasons = seasonData.seasons || [];
      v.season = Number(seasonData.season);
      v.episodes = seasonData.episodes || [];
      v.episodePage = params.type === 'episode' && params.number !== undefined ? episodePageFor(params.number) : 0;
      v.seasonCache.set(v.season, seasonData);
    }
    v.target = currentDetailTarget(v);
    renderDetailHero();
    renderDetailBody({ centerActive: true });
    await loadDetailTargetState();
  } catch (e) {
    if (v !== detailView || token !== detailToken || !state.user) return;
    const content = $('#detail-hero-content');
    const body = $('#detail-body');
    if (!content || !body) return;
    content.innerHTML = '<div class="detail-copy"><div class="detail-kicker">详情</div><h1 class="detail-page-title">暂时无法加载</h1><p class="detail-page-overview">请检查网络连接后重试。</p></div>';
    showError(body, e, () => renderDetailPage());
  }
}

PAGES.detail = renderDetailPage;

/* ───────── 记录（历史 + 评分） ───────── */

/** 按 ?tab=ratings 切换历史 / 评分两个视图，默认历史 */
PAGES.records = async () => {
  const ratings = state.query.get('tab') === 'ratings';
  await (ratings ? PAGES.ratings() : PAGES.history());
};

/* ───────── 搜索：能搜到就能直接操作 ───────── */

const SEARCH_TYPES = [['all', '全部'], ['movie', '电影'], ['show', '剧集']];

/** 待看集合：卡片按钮要能显示「已在待看」，否则重复点会静默成功、提示还会说谎 */
async function loadWatchlistKeys() {
  try {
    // 这里只关心 id，用默认最小扩展就够，别拉 full
    const r = await api('/sync/watchlist');
    const set = new Set();
    for (const it of r.data || []) {
      const m = it?.movie || it?.show;
      const id = m?.ids?.trakt;
      if (id) set.add(`${it.movie ? 'movie' : 'show'}:${id}`);
    }
    return set;
  } catch {
    return new Set();
  }
}

const searchKey = (kind, ids) => (ids?.trakt ? `${kind}:${ids.trakt}` : '');

PAGES.search = async () => {
  const st = state.search;
  // 搜索不进 URL、不落 localStorage：刷新后一律回到空态，也不留历史记录
  if (state.query.toString()) history.replaceState(null, '', '#/search');

  $('#view').innerHTML =
    head('搜索', 'Trakt 全站搜索：点条目进详情，可直接加入待看', '') +
    `<section class="card episode-manager search-manager">
      <div class="episode-toolbar search-bar">
        <div class="seg" id="s-type" role="group" aria-label="按类型筛选">
          ${SEARCH_TYPES.map(([v, l]) => `<button data-stype="${v}" class="${st.type === v ? 'active' : ''}">${l}</button>`).join('')}
        </div>
        <label class="episode-search search-input">
          <span aria-hidden="true">${ICON.search}</span>
          <input id="s-q" type="search" value="${esc(st.q)}" placeholder="搜索电影或剧集，中英文都行"
            autocomplete="off" spellcheck="false" aria-label="搜索电影或剧集">
        </label>
        <div class="episode-toolbar-pager">
          <span class="lib-count" id="s-hint"></span>
          <button class="btn btn-primary btn-sm" id="s-go">搜索</button>
        </div>
      </div>
      <div class="episode-table-wrap search-table-wrap" id="s-result"></div>
      <div class="pager" id="s-pager" hidden></div>
    </section>`;

  const submit = () => {
    const q = $('#s-q').value.trim();
    if (!q) {
      $('#s-q').focus();
      return;
    }
    st.q = q;
    st.page = 1;
    runSearch();
  };
  $('#s-go').onclick = submit;
  $('#s-q').onkeydown = (e) => {
    if (e.key === 'Enter') submit();
    if (e.key === 'Escape') $('#s-q').blur();
  };
  $('#s-type')
    .querySelectorAll('[data-stype]')
    .forEach((el) => {
      el.onclick = () => {
        if (st.type === el.dataset.stype) return;
        st.type = el.dataset.stype;
        $('#s-type')
          .querySelectorAll('[data-stype]')
          .forEach((b) => b.classList.toggle('active', b === el));
        st.page = 1;
        if (st.q) runSearch();
      };
    });
  // 桌面端按 / 直接聚焦搜索框，省一次鼠标
  const onSlash = (e) => {
    const box = $('#s-q');
    if (!box) return document.removeEventListener('keydown', onSlash);
    const tag = document.activeElement?.tagName;
    if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') {
      e.preventDefault();
      box.focus();
      box.select();
    }
  };
  document.addEventListener('keydown', onSlash);

  if (!st.q) {
    renderSearchEmpty();
    return;
  }
  // 待看状态只拉一次，之后加入待看时本地增量维护
  if (!st.watchlist) st.watchlist = await loadWatchlistKeys();
  await runSearch();
};

/** 空态：和结果同一个容器，没搜索前只给一句引导 */
function renderSearchEmpty() {
  const box = $('#s-result');
  const pager = $('#s-pager');
  if (!box) return;
  if (pager) pager.hidden = true;
  const hint = $('#s-hint');
  if (hint) hint.textContent = '';
  box.innerHTML = `<div class="lib-empty">${emptyState('输入关键词开始搜索', {
    icon: 'search',
    hint: '结果来自 Trakt 全站，不受「只能操作已看内容」的限制',
  })}</div>`;
}

async function runSearch() {
  const st = state.search;
  const box = $('#s-result');
  const pager = $('#s-pager');
  if (!box) return;
  box.innerHTML = loadingBox();
  if (pager) pager.hidden = true;
  // 「全部」走组合端点，单类型走独立端点
  const path = st.type === 'all' ? '/search/movie,show' : `/search/${st.type}`;
  try {
    const r = await api(path, { query: { query: st.q, page: st.page, limit: st.limit, extended: 'full' } });
    const rows = (r.data || []).filter((it) => it.movie || it.show);
    st.data = rows;
    st.meta = r.pagination;
    const hint = $('#s-hint');
    if (!rows.length) {
      if (hint) hint.textContent = '';
      box.innerHTML = `<div class="lib-empty">${emptyState(`没有找到与「${st.q}」匹配的影视`, {
        icon: 'search',
        hint: '换个关键词，或试试原名',
      })}</div>`;
      return;
    }
    if (hint) {
      const total = Number(st.meta?.item_count) || 0;
      hint.textContent = total > rows.length ? `本页 ${rows.length} 条 · 共 ${num(total)} 条` : `找到 ${rows.length} 条结果`;
    }
    box.innerHTML = `<table class="episode-table lib-table search-table">
      <thead><tr>
        <th class="lib-cover-cell" aria-label="封面"></th>
        <th>标题</th>
        <th class="lib-score-cell">评分</th>
        <th class="lib-ops-cell">操作</th>
      </tr></thead>
      <tbody>${rows
        .map((it, i) => {
          const kind = it.type === 'show' ? 'show' : 'movie';
          const m = it.movie || it.show || {};
          return searchRow(it, i, st.watchlist?.has(searchKey(kind, m.ids)));
        })
        .join('')}</tbody>
    </table>`;
    bindRowClick(box);
    localize(box);

    box.querySelectorAll('.s-wl').forEach((b) => {
      b.onclick = async () => {
        const it = st.data[Number(b.dataset.idx)];
        const kind = it.type === 'show' ? 'show' : 'movie';
        const m = it.movie || it.show;
        const seg = kind === 'show' ? 'shows' : 'movies';
        const key = searchKey(kind, m.ids);
        b.disabled = true;
        try {
          await api('/sync/watchlist', { method: 'POST', body: { [seg]: [{ ids: m.ids }] } });
          st.watchlist?.add(key);
          b.classList.remove('s-wl');
          b.textContent = '已在待看';
          undoToast('已加入待看', async () => {
            await api('/sync/watchlist/remove', { method: 'POST', body: { [seg]: [{ ids: m.ids }] } });
            st.watchlist?.delete(key);
            toast('已撤销');
          });
        } catch (e) {
          toast(e.message, true);
          b.disabled = false;
        }
      };
    });

    mountPager(pager, st.meta || { page: 1, pageCount: 1, itemCount: rows.length }, (p) => {
      st.page = p;
      runSearch();
    }, num);
  } catch (e) {
    showError(box, e, runSearch);
  }
}

/** 搜索结果行：与片单表格同一套单元格（封面 / 标题+副标题 / 评分 / 操作） */
function searchRow(it, i, inWatchlist) {
  const kind = it.type === 'show' ? 'show' : 'movie';
  const m = it.movie || it.show || {};
  const ids = m.ids || {};
  const overview = String(m.overview || '').trim();
  const sub = [
    m.year,
    kind === 'movie' ? '电影' : '剧集',
    overview ? `${overview.slice(0, 80)}${overview.length > 80 ? '…' : ''}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const rating = Number(m.rating) || 0;
  const action = inWatchlist
    ? `<button class="btn btn-sm" data-idx="${i}" disabled>已在待看</button>`
    : `<button class="btn btn-sm s-wl" data-idx="${i}">加入待看</button>`;
  return `<tr class="episode-row lib-row" data-kind="${kind}" data-ids='${esc(JSON.stringify(ids))}' data-title="${esc(m.title || '')}">
    <td class="lib-cover-cell"><span class="lib-art">${posterImg(`/api/poster?${artQuery(kind, ids)}`, '')}</span></td>
    <td class="lib-title-cell">
      <div class="lib-name" ${locAttrs(kind, ids)}>${esc(m.title || '未知')}</div>
      <div class="lib-sub">${esc(sub)}</div>
    </td>
    <td class="lib-score-cell"><span class="lib-num">${rating ? `★ ${rating.toFixed(1)}` : '—'}</span></td>
    <td class="lib-ops-cell"><div class="lib-ops">${action}</div></td>
  </tr>`;
}

/* ───────── 追剧：整月大日历 + 当天剧集 ───────── */

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
const WEEKDAY_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const weekdayName = (i) => (isEn() ? WEEKDAY_EN : WEEKDAY)[i];
/** 日历侧栏日期：中文「9 月 30 日」/ 英文「Sep 30」 */
const mdLabel = (m, d) => (isEn() ? `${EN_MONTHS[m - 1]} ${d}` : `${m} 月 ${d} 日`);

const CAL_WEEK = ['一', '二', '三', '四', '五', '六', '日'];
const CAL_ICON = `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`;

PAGES.tracking = async () => {
  $('#view').innerHTML =
    head('追剧', '按月查看看在剧集的播出排期，点某天在右侧看当天剧集', '') + '<div id="page-body"></div>';
  await renderCalendarPage();
};

async function renderCalendarPage() {
  const host = $('#page-body');
  if (!host) return;
  const st = state.calendar;
  const now = new Date();
  const today = ymd(now);
  const qm = state.query.get('m') || '';
  st.month = /^\d{4}-\d{2}$/.test(qm) ? qm : monthKey(now);

  const qd = state.query.get('d') || '';
  st.selected =
    /^\d{4}-\d{2}-\d{2}$/.test(qd) && qd.startsWith(st.month)
      ? qd
      : st.month === today.slice(0, 7)
        ? today
        : `${st.month}-01`;

  host.innerHTML = `<div class="cal-wrap">
    <div class="card cal-card">
      <div class="cal-head">
        <b id="cal-title"></b>
        <span class="sub" id="cal-sub"></span>
        <div class="spacer"></div>
        <button class="btn btn-sm" id="cal-today">今天</button>
        <button class="btn btn-sm" id="cal-prev" title="上一月">‹</button>
        <button class="btn btn-sm" id="cal-next" title="下一月">›</button>
      </div>
      <div class="cal-week">${(isEn() ? ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] : CAL_WEEK).map((w) => `<span>${w}</span>`).join('')}</div>
      <div class="cal-grid" id="cal-grid">${loadingBox('正在读取播出排期…')}</div>
      <div class="cal-foot"><i class="cal-dot on"></i><span>已播出</span><i class="cal-dot"></i><span>待播出</span>
        <div class="spacer"></div><span class="sub">来自「在看」列表 · 悬停格子可看当天剧名</span></div>
    </div>
    <div class="card cal-side" id="cal-side">${loadingBox()}</div>
  </div>`;

  const step = (n) => {
    const [y, m] = st.month.split('-').map(Number);
    setQuery({ m: monthKey(new Date(y, m - 1 + n, 1)), d: '' });
  };
  $('#cal-prev').onclick = () => step(-1);
  $('#cal-next').onclick = () => step(1);
  $('#cal-today').onclick = () => setQuery({ m: '', d: '' });

  await loadCalendar();
};

async function loadCalendar() {
  const st = state.calendar;
  const grid = $('#cal-grid');
  if (!grid) return;
  try {
    let data = st.cache.get(st.month);
    if (!data) {
      grid.innerHTML = loadingBox('正在读取播出排期…');
      const tz = -new Date().getTimezoneOffset();
      data = await getJson(`/api/calendar?month=${encodeURIComponent(st.month)}&tz=${tz}`);
      st.cache.set(st.month, data);
    }
    st.data = data;
    renderCalendarGrid();
    renderCalendarDay();
  } catch (e) {
    showError(grid, e, loadCalendar);
    const side = $('#cal-side');
    if (side) side.innerHTML = '';
  }
}

function renderCalendarGrid() {
  const st = state.calendar;
  const grid = $('#cal-grid');
  if (!grid) return;
  const [y, m] = st.month.split('-').map(Number);
  const title = $('#cal-title');
  const sub = $('#cal-sub');
  if (title) title.textContent = periodLabel(y, m);
  if (sub) sub.textContent = st.data?.total ? `共 ${st.data.total} 集` : '';

  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const total = new Date(y, m, 0).getDate();
  const rows = Math.ceil((lead + total) / 7);
  const today = ymd(new Date());
  const days = st.data?.days || {};
  const cells = [];

  for (let i = 0; i < rows * 7; i++) {
    const n = i - lead + 1;
    const date = new Date(y, m - 1, n);
    if (n < 1 || n > total) {
      cells.push(`<div class="cal-cell out"><span class="cal-d">${date.getDate()}</span></div>`);
      continue;
    }
    const key = ymd(date);
    const list = days[key] || [];
    // 格子里只放封面，多剧就叠着放（最多三张 + 余数），文字信息交给右侧面板
    const posters = list
      .slice(0, 3)
      .map((e) => posterImg(`/api/poster?${artQuery('show', { trakt: e.show.trakt, tmdb: e.show.tmdb })}`, `cal-poster${e.aired ? '' : ' pending'}`))
      .join('');
    const more = list.length > 3 ? `<span class="cal-more">+${list.length - 3}</span>` : '';
    const tip = list.length ? `${key} · ${list.map((e) => e.show.title).join('、')}` : `${key} · 无排期`;
    const tipAttr = locTipAttr(
      key,
      list.map((e) => ({
        type: 'show',
        ids: { trakt: e.show.trakt ?? e.show.ids?.trakt, tmdb: e.show.tmdb ?? e.show.ids?.tmdb },
      }))
    );
    const cls = ['cal-cell'];
    if (key === today) cls.push('today');
    if (key === st.selected) cls.push('sel');
    cells.push(`<button class="${cls.join(' ')}" data-cday="${key}" title="${esc(tip)}"${tipAttr}>
      <span class="cal-d">${n}</span>
      <span class="cal-stack">${posters}${more}</span>
    </button>`);
  }
  grid.innerHTML = cells.join('');
  localize(grid);
  grid.querySelectorAll('[data-cday]').forEach((el) => {
    el.onclick = () => selectCalendarDay(el.dataset.cday);
  });
}

/**
 * 换选中日期只重画格子选中态 + 右侧面板，不重跑路由（避免整页闪一下、也不丢滚动位置）。
 * URL 仍然同步，刷新或分享后能回到同一天。
 */
function selectCalendarDay(key) {
  const st = state.calendar;
  if (!key || key === st.selected) return;
  st.selected = key;
  const q = new URLSearchParams(state.query);
  q.set('d', key);
  state.query = q;
  history.replaceState(null, '', `#/tracking?${q.toString()}`);
  document.querySelectorAll('#cal-grid [data-cday]').forEach((el) => {
    el.classList.toggle('sel', el.dataset.cday === key);
  });
  renderCalendarDay();
}

function renderCalendarDay() {
  const st = state.calendar;
  const side = $('#cal-side');
  if (!side) return;
  const day = st.selected;
  const list = (st.data?.days || {})[day] || [];
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const head = `<div class="cal-side-head">
    <div class="cal-side-date">${mdLabel(m, d)}</div>
    <div class="sub">${weekdayName(date.getDay())}${list.length ? (isEn() ? ` · ${list.length} ${plural(list.length, 'show', 'shows')}` : ` · ${list.length} 部剧`) : ''}</div>
  </div>`;

  if (!list.length) {
    side.innerHTML =
      head +
      `<div class="cal-empty">
        <span class="cal-empty-ico">${CAL_ICON}</span>
        <b class="cal-empty-title">这一天，暂无更新</b>
        <p class="cal-empty-hint">没有排期的剧仍会检查服务更新。预计播出不代表服务已上架。</p>
        <a class="btn btn-sm" href="#/library?tab=lists">追踪列表</a>
      </div>`;
    side.onclick = null;
    return;
  }

  side.innerHTML =
    head +
    `<div class="cal-list">${list.map(calItem).join('')}</div>
     <div class="cal-note">播出日期按 Trakt 排期展示，实际平台上线时间可能有出入。</div>`;

  side.querySelectorAll('[data-cday-item]').forEach((el) => {
    el.onclick = (ev) => {
      if (ev.target.closest('button')) return;
      openCalendarItem(list[Number(el.dataset.cdayItem)]);
    };
  });
  // 点空白处收起菜单（用 onclick 而不是 addEventListener：innerHTML 换了但节点还在，避免重复绑定）
  side.onclick = () => side.querySelectorAll('.cal-menu').forEach((x) => (x.hidden = true));
  side.querySelectorAll('.cal-kebab').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const menu = b.closest('.cal-item').querySelector('.cal-menu');
      const open = menu.hidden;
      side.querySelectorAll('.cal-menu').forEach((x) => (x.hidden = true));
      menu.hidden = !open;
    };
  });
  side.querySelectorAll('[data-cal-act]').forEach((b) => {
    b.onclick = async (ev) => {
      ev.stopPropagation();
      const item = list[Number(b.dataset.idx)];
      const ep = item.episode || {};
      const base = { type: 'episode', ids: ep.ids || {}, season: ep.season, number: ep.number };
      b.disabled = true;
      try {
        if (b.dataset.calAct === 'watch') {
          const choice = await chooseWatchDate({
            released: String(ep.first_aired || '').slice(0, 10),
            title: `${item.show?.title || ''} S${pad2(ep.season)}E${pad2(ep.number)}`,
          });
          if (!choice) { b.disabled = false; return; }
          await runAction({ ...base, action: 'watch', when: choice.when, date: choice.date, at: choice.at });
          toast(`已标记 S${pad2(ep.season)}E${pad2(ep.number)} 已看`);
          b.textContent = '已看';
        } else if (b.dataset.calAct === 'watchlist') {
          await runAction({ ...base, action: 'watchlist_add' });
          undoToast('已加入待看', async () => {
            await runAction({ ...base, action: 'watchlist_remove' });
            toast('已撤销');
          });
          b.textContent = '待看 ✓';
        } else {
          openCalendarItem(item);
          b.disabled = false;
        }
      } catch (e) {
        toast(e.message, true);
        b.disabled = false;
      }
    };
  });
  localize(side);
}

function openCalendarItem(it) {
  const show = it.show || {};
  const ep = it.episode || {};
  openDetail({
    type: 'episode',
    ids: { trakt: show.trakt, tmdb: show.tmdb },
    act: { type: 'episode', ids: ep.ids || {} },
    season: ep.season,
    number: ep.number,
    title: `${show.title} S${pad2(ep.season)}E${pad2(ep.number)}`,
  });
}

function calItem(it, i) {
  const show = it.show || {};
  const ep = it.episode || {};
  const at = new Date(it.first_aired || '');
  const hm = Number.isNaN(at.getTime()) ? '' : `${pad2(at.getHours())}:${pad2(at.getMinutes())}`;
  const meta = [show.year || '', hm].filter(Boolean).join(' · ');
  const code = `S${pad2(ep.season)} · E${pad2(ep.number)}`;
  return `<div class="cal-item" data-cday-item="${i}">
    <div class="cal-item-poster">${posterImg(`/api/poster?${artQuery('show', { trakt: show.trakt, tmdb: show.tmdb })}`, 'cal-cover')}</div>
    <div class="cal-item-body">
      <div class="cal-item-top">
        <b class="cal-item-title" ${locAttrs('show', { trakt: show.trakt, tmdb: show.tmdb })}>${esc(show.title || '—')}</b>
        <button class="cal-kebab" title="更多操作">⋯</button>
      </div>
      <span class="chip ${it.aired ? '' : 'ok'}">${it.aired ? '已播出' : '待播出'}</span>
      <div class="cal-item-meta">${esc(meta || '—')}</div>
      <div class="cal-item-ep">${esc(code)}${ep.title ? ` · ${esc(ep.title)}` : ''}</div>
      <div class="cal-menu" hidden>
        <button data-cal-act="watch" data-idx="${i}">标记本集已看</button>
        <button data-cal-act="watchlist" data-idx="${i}">加入待看</button>
        <button data-cal-act="open" data-idx="${i}">打开详情</button>
      </div>
    </div>
  </div>`;
}

/* ───────── 概览：观看节奏 / 类型分布（原「统计」页已并入） ───────── */

// Trakt 的 genres 是英文 slug，还会出现 donghua 这种它自己的分类；这张表只做兜底。
// 正常路径是服务端向 TMDB 要真实类型，直接返回本地化中文名（lib/art.js resolveGenres）。
const GENRE_ZH = {
  action: '动作', adventure: '冒险', animation: '动画', anime: '动画', donghua: '动画', comedy: '喜剧', crime: '犯罪',
  documentary: '纪录', drama: '剧情', family: '家庭', fantasy: '奇幻', history: '历史', horror: '恐怖',
  music: '音乐', mystery: '悬疑', romance: '爱情', 'science-fiction': '科幻', 'sci-fi': '科幻',
  thriller: '惊悚', war: '战争', western: '西部', 'tv-movie': '电视电影', 'game-show': '游戏节目',
  reality: '真人秀', 'talk-show': '脱口秀', news: '新闻', 'soap-opera': '肥皂剧',
};

const OV_COLORS = ['#ed1c24', '#ff7a45', '#ffb020', '#35c48a', '#4a9eff', '#a06bff'];
const OV_TTL = 2 * 60 * 1000; // 和服务端「当月短缓存」对齐：换个设备记的一笔最多 2 分钟就能看到
const ovCache = new Map();
let ovStepAt = 0; // 月份步进的节流时间戳，跨重渲染共享，防止一次点击走两格

/** 分钟 → 小时（一位小数，>=10 小时取整，避免长数字挤爆卡片） */
function ovHours(min) {
  const h = Number(min || 0) / 60;
  if (!h) return '0';
  return h >= 10 ? String(Math.round(h)) : String(Math.round(h * 10) / 10);
}

function ovMonday(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return x;
}

function ovShiftMonth(y, m, step) {
  return monthKey(new Date(y, m - 1 + step, 1));
}

/**
 * 概览数据全部由服务端聚合（/api/stats）：一年的观看记录可能有几千条，
 * 浏览器逐页拉再自己算既慢、又会被页数上限截断。
 * 服务端按用户时区把记录折成「天 / 小时」，这里只把对象还原成 Map 给渲染用。
 */
async function ovLoad(period, month) {
  const tz = -new Date().getTimezoneOffset(); // 东为正，与 /api/calendar 的 tz 参数一致
  const key = `${period}:${month}:${tz}`;
  const hit = ovCache.get(key);
  if (hit && Date.now() - hit.at < OV_TTL) return hit.data;

  const q = `period=${encodeURIComponent(period)}&month=${encodeURIComponent(month)}&tz=${tz}`;
  // 续播点和统计一起拉：两张卡同屏出现，串行会白等一个来回
  const [r, cont] = await Promise.all([
    getJson(`/api/stats?${q}`),
    api('/sync/playback', { query: { extended: 'full' } })
      .then((x) => x.data || [])
      .catch(() => []),
  ]);
  const data = {
    start: r.start,
    end: r.end,
    minutes: r.minutes || 0,
    movies: r.movies || 0,
    episodes: r.episodes || 0,
    plays: r.plays || 0,
    untagged: r.untagged || 0,
    days: new Map(Object.entries(r.days || {})),
    genres: new Map(Object.entries(r.genres || {})),
    truncated: !!r.truncated,
    week: { ...(r.week || {}), days: new Map(Object.entries(r.week?.days || {})) },
    fav: r.fav || null,
    // Trakt 的续播点：progress 是百分比，paused_at 决定先后，取最近停下的几条。
    // 同一部剧可能有多集的续播点，只留最近那一集，免得一张小卡被同一部剧占满。
    continue: (Array.isArray(cont) ? cont : [])
      .filter((x) => x && (x.movie || x.episode))
      .sort((a, b) => String(b.paused_at || '').localeCompare(String(a.paused_at || '')))
      .filter((() => {
        const seen = new Set();
        return (x) => {
          const ids = x.movie?.ids || x.show?.ids || {};
          const k = x.movie ? `m:${ids.trakt || ids.tmdb}` : `s:${ids.trakt || ids.tmdb}`;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        };
      })())
      .slice(0, 40),
    compare: r.compare || null,
    rated: r.rated || { count: 0, avg: 0, dist: {}, recent: [] },
  };
  ovCache.set(key, { at: Date.now(), data });
  return data;
}

/* ── 渲染零件 ── */

/**
 * 柱状图：一根柱子按「电影 / 剧集」上下分段堆叠，配色与卡片右上角图例（ovChips）同一套。
 * split 缺省、或这根柱没有类型明细时退回单色柱，免得没数据的地方画成空白。
 */
function ovBars(values, labels, split) {
  const max = Math.max(1, ...values);
  return `<div class="ov-chart">${values
    .map((v, i) => {
      const h = v ? Math.max(6, Math.round((v / max) * 100)) : 2;
      const m = split?.m?.[i] || 0;
      const e = split?.e?.[i] || 0;
      const tip = `${esc(labels?.[i] || '')}${v ? ` · ${v} 次` : ''}${m || e ? `（电影 ${m} · 剧集 ${e}）` : ''}`;
      if (!v || (m === 0 && e === 0)) return `<i class="ov-bar-empty" style="height:${h}%" title="${tip}"></i>`;
      const mp = Math.round((m / (m + e)) * 100);
      return `<i style="height:${h}%" title="${tip}"><b class="ov-bar-m" style="flex:${mp} 1 0"></b><b class="ov-bar-e" style="flex:${100 - mp} 1 0"></b></i>`;
    })
    .join('')}</div>`;
}

/** 对比文案：持平 / 多·少 X / 上周为零就算「新增观看」 */
function ovCmpText(cur, prev, unit = '小时') {
  const a = Number(cur) || 0;
  const b = Number(prev) || 0;
  if (!b) return a ? { text: '新增观看', tone: 'up' } : { text: '持平', tone: 'flat' };
  const diff = a - b;
  if (!diff) return { text: '持平', tone: 'flat' };
  const v = unit === '次' ? num(Math.abs(diff)) : ovHours(Math.abs(diff));
  return { text: `${diff > 0 ? '多' : '少'} ${v} ${unit}`, tone: diff > 0 ? 'up' : 'down' };
}

function ovCmp(label, cur, prev, unit) {
  const { text, tone } = ovCmpText(cur, prev, unit);
  return `<div class="ov-cmp">${esc(label)} <b class="cmp-${tone}">${esc(text)}</b></div>`;
}

/** 电影 / 剧集的图例点 */
function ovChips() {
  return `<div class="ov-chips">
    <span><i class="ov-dot" style="background:${OV_COLORS[1]}"></i>电影</span>
    <span><i class="ov-dot" style="background:${OV_COLORS[4]}"></i>剧集</span>
  </div>`;
}

function ovTiles(min, movies, episodes) {
  const en = isEn();
  return `<div class="ov-tiles">${[
    ['时长', ovHours(min), en ? 'h' : '小时'],
    ['电影', num(movies), en ? '' : '部'],
    ['剧集', num(episodes), en ? '' : '集'],
  ]
    .map(([k, v, u]) => `<div class="ov-tile"><div class="ov-tile-k">${k}</div><div class="ov-tile-v">${esc(v)}<span>${u}</span></div></div>`)
    .join('')}</div>`;
}

function ovHeatMonth(y, m, days, selected) {
  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const total = new Date(y, m, 0).getDate();
  const today = ymd(new Date());
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<span class="ov-cell blank"></span>');
  for (let d = 1; d <= total; d++) {
    const key = `${y}-${pad2(m)}-${pad2(d)}`;
    const rec = days.get(key);
    const plays = rec?.plays || 0;
    const lv = !plays ? 0 : plays <= 1 ? 1 : plays <= 3 ? 2 : plays <= 6 ? 3 : 4;
    const cls = ['ov-cell', `lv${lv}`];
    if (key > today) cls.push('future');
    if (key === today) cls.push('today');
    if (key === selected) cls.push('sel');
    const tip = `${key} · ${plays} 次${rec?.minutes ? ` · ${fmtDur(rec.minutes)}` : ''}`;
    // 月历格子可点：点某天，"今日观看"就切成那一天的 24 小时分布
    cells.push(
      `<button type="button" class="${cls.join(' ')}" data-ovday="${key}" title="${esc(tip)}"${key > today ? ' disabled' : ''}>${d}</button>`
    );
  }
  while (cells.length % 7) cells.push('<span class="ov-cell blank"></span>');
  return `<div class="ov-heat">
    <div class="ov-heat-head">${(isEn() ? ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] : ['一', '二', '三', '四', '五', '六', '日']).map((w) => `<span>${w}</span>`).join('')}</div>
    <div class="ov-heat-grid">${cells.join('')}</div>
  </div>`;
}

function ovYearChart(y, days) {
  const counts = new Array(12).fill(0);
  const mcounts = new Array(12).fill(0);
  const ecounts = new Array(12).fill(0);
  days.forEach((rec, key) => {
    if (!key.startsWith(`${y}-`)) return;
    const i = Number(key.slice(5, 7)) - 1;
    counts[i] += rec.plays;
    mcounts[i] += rec.movies || 0;
    ecounts[i] += rec.episodes || 0;
  });
  const labels = Array.from({ length: 12 }, (_, i) => `${i + 1} 月`);
  return `<div class="ov-year">${ovBars(counts, labels, { m: mcounts, e: ecounts })}
    <div class="ov-axis wide">${labels.map((l) => `<span>${l.replace(' 月', '')}</span>`).join('')}</div></div>`;
}

/** 单日 24 小时分布；点月历换天时就换这一张卡 */
function ovDayCard(day, key, cmp) {
  const today = ymd(new Date());
  const [y, m, d] = String(key || today).split('-').map(Number);
  const hours = day?.hours || new Array(24).fill(0);
  const hm = day?.hm || new Array(24).fill(0);
  const he = day?.he || new Array(24).fill(0);
  const labels = hours.map((_, i) => `${pad2(i)}:00`);
  const title = key === today ? '今日观看' : `${m} 月 ${d} 日观看`;
  return `<div class="card ov-card ov-mini ov-day">
    <div class="ov-head">
      <div class="ov-head-main"><b>${title}</b><span class="sub">${fmtDate(new Date(y, m - 1, d).toISOString())}</span></div>
      <div class="ov-head-side">${cmp ? ovCmp('比前一天', cmp.cur, cmp.prev) : ''}${ovChips()}</div>
    </div>
    ${ovBars(hours, labels, { m: hm, e: he })}
    <div class="ov-axis"><span>00:00</span><span>12:00</span><span>24:00</span></div>
    ${ovTiles(day?.minutes || 0, day?.movies || 0, day?.episodes || 0)}
  </div>`;
}

function ovWeekCard(agg, cmp) {
  const mon = ovMonday(new Date());
  const dates = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    return d;
  });
  const names = isEn() ? ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] : ['一', '二', '三', '四', '五', '六', '日'];
  const vals = dates.map((d) => agg.days.get(ymd(d))?.plays || 0);
  const mvals = dates.map((d) => agg.days.get(ymd(d))?.movies || 0);
  const evals = dates.map((d) => agg.days.get(ymd(d))?.episodes || 0);
  let minutes = 0;
  let movies = 0;
  let episodes = 0;
  dates.forEach((d) => {
    const rec = agg.days.get(ymd(d));
    if (!rec) return;
    minutes += rec.minutes;
    movies += rec.movies;
    episodes += rec.episodes;
  });
  return `<div class="card ov-card ov-mini">
    <div class="ov-head">
      <div class="ov-head-main"><b>本周观看</b><span class="sub">${fmtDate(dates[0].toISOString())} — ${fmtDate(dates[6].toISOString())}</span></div>
      <div class="ov-head-side">${cmp ? ovCmp('比上周同期', cmp.cur, cmp.prev) : ''}${ovChips()}</div>
    </div>
    ${ovBars(vals, names.map((n) => `周${n}`), { m: mvals, e: evals })}
    <div class="ov-axis">${names.map((n) => `<span>${n}</span>`).join('')}</div>
    ${ovTiles(minutes, movies, episodes)}
  </div>`;
}

function ovFeelCard(rated, label) {
  const head = `<div class="ov-head"><b>观影感受</b><span class="sub">${esc(label)}</span></div>`;
  const foot = `<div class="ov-foot"><span class="sub">共 ${rated.count} 次感受</span>
    <a class="btn btn-sm" href="#/records?tab=ratings">查看全部</a></div>`;
  if (!rated.count) {
    return `<div class="card ov-card ov-feel">${head}
      <div class="ov-feel-empty">所选时段暂无观影感受</div>${foot}</div>`;
  }
  const max = Math.max(1, ...Object.values(rated.dist));
  const dist = Array.from({ length: 10 }, (_, i) => {
    const n = rated.dist[i + 1] || 0;
    return `<div class="ov-dist-col" title="${i + 1} 分 · ${n} 次"><i style="height:${n ? Math.max(8, Math.round((n / max) * 100)) : 3}%"></i><span>${i + 1}</span></div>`;
  }).join('');
  const list = rated.recent
    .map(
      (it) => `<div class="ov-feel-row">
        <span class="ov-feel-title" ${locAttrs(it.kind, it.ids)}>${esc(it.title || '—')}</span>
        <span class="rating-badge">${esc(it.rating)}</span>
      </div>`
    )
    .join('');
  return `<div class="card ov-card ov-feel">${head}
    <div class="ov-feel-body">
      <div class="ov-feel-left">
        <div class="ov-num">${rated.avg.toFixed(1)}</div>
        <div class="sub">平均分 · ${rated.count} 次评分</div>
        <div class="ov-dist">${dist}</div>
      </div>
      <div class="ov-feel-right">${list}</div>
    </div>${foot}</div>`;
}

/** 相对时间：续播点看「多久前停的」比绝对时间有用 */
function ovAgo(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const min = Math.round((Date.now() - t) / 60000);
  const en = isEn();
  if (min < 1) return en ? 'just now' : '刚刚';
  if (min < 60) return en ? `${min}m ago` : `${min} 分钟前`;
  const h = Math.round(min / 60);
  if (h < 24) return en ? `${h}h ago` : `${h} 小时前`;
  const d = Math.round(h / 24);
  if (d < 30) return en ? `${d}d ago` : `${d} 天前`;
  return fmtDate(iso);
}

/** 还剩多少：进度换算成分钟，缺 runtime 就不显示（别硬编一个数） */
function ovLeft(runtime, pct) {
  const rt = Number(runtime) || 0;
  if (!rt || pct >= 100) return '';
  const m = Math.max(1, Math.round((rt * (100 - pct)) / 100));
  if (isEn()) return m < 60 ? `${m}m left` : m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m left` : `${Math.floor(m / 60)}h left`;
  if (m < 60) return `剩 ${m} 分`;
  return m % 60 ? `剩 ${Math.floor(m / 60)} 时 ${m % 60} 分` : `剩 ${Math.floor(m / 60)} 时`;
}

/**
 * 继续观看：Trakt 续播点按暂停时间倒序，卡片内滚轮浏览。
 * 每行给「标题 / 分集名 / SxxExx · 时长 · 多久前 / 进度条」，右侧百分比 + 剩余时长。
 */
function ovContinueCard(list) {
  const rows = (Array.isArray(list) ? list : []).slice(0, 40);
  const head = `<div class="ov-head">
    <div class="ov-head-main"><b>继续观看</b>${rows.length ? `<span class="sub">${rows.length} 条</span>` : ''}</div>
    <span class="sub">按暂停时间倒序</span>
  </div>`;
  if (!rows.length) {
    return `<div class="card ov-card ov-cont">${head}
      <div class="ov-empty">
        <b>没有看到一半的条目</b>
        <span class="sub">播放器上报续播点后会出现在这里</span>
      </div>
    </div>`;
  }
  const items = rows
    .map((it) => {
      const mv = it.movie;
      const ep = it.episode || {};
      const ids = mv ? mv.ids || {} : it.show?.ids || {};
      const kind = mv ? 'movie' : 'show';
      const title = mv ? mv.title : it.show?.title || ep.title || '未知条目';
      const pct = Math.max(0, Math.min(100, Math.round(Number(it.progress) || 0)));
      const code = !mv && ep.season != null && ep.number != null ? `S${pad2(ep.season)}E${pad2(ep.number)}` : '电影';
      const when = ovAgo(it.paused_at);
      const runtime = Number(ep.runtime || mv?.runtime || it.show?.runtime) || 0;
      const left = ovLeft(runtime, pct);
      const epName = !mv ? String(ep.title || '').trim() : '';
      const total = runtime ? fmtDur(runtime) : '';
      const whenFull = it.paused_at ? fmtDateTime(it.paused_at) : '';
      const href = detailHref({ type: mv ? 'movie' : 'episode', ids, season: ep.season, number: ep.number });
      const tip = [title, epName, code, total ? `共 ${total}` : '', whenFull].filter(Boolean).join(' · ');
      return `<a class="ov-cont-item" href="${href}" title="${esc(tip)}">
      <span class="ov-cont-art">${posterImg(`/api/poster?${artQuery(kind, ids)}`, 'ov-cont-poster')}</span>
      <span class="ov-cont-meta">
        <span class="ov-cont-title" ${locAttrs(kind, ids)}>${esc(title)}</span>
        ${epName ? `<span class="ov-cont-ep" ${locAttrs('episode', it.show?.ids || ids, ep.season, ep.number)}>${esc(epName)}</span>` : ''}
        <span class="sub">${esc([code, total, when].filter(Boolean).join(' · '))}</span>
        <span class="ov-cont-bar"><i style="width:${pct}%"></i></span>
      </span>
      <span class="ov-cont-side">
        <b class="ov-cont-pct">${pct}%</b>
        ${left ? `<span class="ov-cont-left">${esc(left)}</span>` : ''}
      </span>
    </a>`;
    })
    .join('');
  return `<div class="card ov-card ov-cont">${head}<div class="ov-cont-list">${items}</div></div>`;
}

function ovGenreCard(agg, label) {
  const head = `<div class="ov-head">
    <div class="ov-head-main"><b>观看类型</b></div>
    <span class="sub">${esc(label)}</span>
  </div>`;
  const top = [...agg.genres.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const slices = top.map(([g, v], i) => ({ name: GENRE_ZH[g] || g, v, color: OV_COLORS[i] }));
  if (agg.untagged > 0) slices.push({ name: '未分类', v: agg.untagged, color: OV_COLORS[5] });
  const total = slices.reduce((s, x) => s + x.v, 0);
  const tiles = ovTiles(agg.minutes, agg.movies, agg.episodes);
  if (!total) {
    return `<div class="card ov-card ov-genre">${head}${emptyState('所选时段暂无观看记录', { icon: 'chart' })}${tiles}</div>`;
  }
  let acc = 0;
  const stops = slices
    .map((s) => {
      const from = (acc / total) * 100;
      acc += s.v;
      return `${s.color} ${from.toFixed(1)}% ${((acc / total) * 100).toFixed(1)}%`;
    })
    .join(', ');
  const legend = slices
    .map(
      (s) => `<div class="ov-leg"><i style="background:${s.color}"></i><span>${esc(s.name)}</span>
        <b>${Math.round((s.v / total) * 100)}%</b></div>`
    )
    .join('');
  return `<div class="card ov-card ov-genre">${head}
    <div class="ov-genre-body">
      <div class="ov-donut" style="background:conic-gradient(${stops})">
        <div class="ov-donut-hole"><b>${esc(slices[0].name)}</b><span>${Math.round((slices[0].v / total) * 100)}%</span></div>
      </div>
      <div class="ov-leg-list">${legend}</div>
    </div>${tiles}</div>`;
}

/** 英文单复数：plural(1,'movie') → movie / plural(3,'movie') → movies */
const plural = (n, one, many = `${one}s`) => (Number(n) === 1 ? one : many);

function ovRender(period, y, m, data) {
  const en = isEn();
  const label = periodLabel(y, period === 'year' ? 0 : m);
  const today = ymd(new Date());
  const todayRec = data.days.get(today) || data.week.days.get(today) || null;
  const activeDays = [...data.days.values()].filter((d) => d.plays > 0).length;
  const shownDays = period === 'year' ? 365 : new Date(y, m, 0).getDate();
  const picked = period === 'month' && today.startsWith(`${y}-${pad2(m)}`) ? today : '';
  const heat = period === 'year' ? ovYearChart(y, data.days) : ovHeatMonth(y, m, data.days, picked);
  const legend =
    period === 'year'
      ? `<span class="sub">${data.truncated ? '数据较多，只统计了最近的一部分' : `共 ${num(data.plays)} 次观看`}</span>`
      : `<span class="sub">少</span>${['lv0', 'lv1', 'lv2', 'lv3', 'lv4']
          .map((lv) => `<i class="ov-cell ${lv}"></i>`)
          .join('')}<span class="sub">多</span>`;

  const cm = data.compare || {};
  return `<div class="card ov-card ov-main">
      <div class="ov-head">
        <div class="ov-head-main"><b>${period === 'year' ? '本年观看' : '本月观看'}</b>
          <span class="sub">${data.truncated ? '仅统计最近部分' : `${activeDays} / ${shownDays} 天有记录`}</span></div>
        ${cm.month ? ovCmp('比上月同期', cm.month.cur, cm.month.prev) : ''}
      </div>
      <div class="ov-main-body">
        <div class="ov-total">
          <div class="ov-kicker">累计观看</div>
          <div class="ov-num">${ovHours(data.minutes)}<span class="ov-unit">小时</span></div>
          <div class="ov-total-note">${
            isEn()
              ? `Stories on ${activeDays} ${activeDays === 1 ? 'day' : 'days'} ${period === 'year' ? 'this year' : 'this month'}`
              : `${period === 'year' ? '这一年' : '这个月'}，有 ${activeDays} 天与好故事相遇`
          }</div>
        </div>
        <div class="ov-cal">${heat}</div>
      </div>
      <div class="ov-main-foot">
        <div class="ov-total-stats">
          <span><b>${num(data.movies)}</b> ${en ? plural(data.movies, 'movie') : '部电影'}</span>
          <span><b>${num(data.episodes)}</b> ${en ? plural(data.episodes, 'episode') : '集剧集'}</span>
          <span><b>${num(data.plays)}</b> ${en ? plural(data.plays, 'play') : '次观看'}</span>
        </div>
        <div class="ov-legend">${legend}</div>
      </div>
    </div>
    ${ovContinueCard(data.continue)}
    ${ovDayCard(todayRec, today, cm.day)}
    ${ovWeekCard(data.week, cm.week)}
    ${ovFeelCard(data.rated, label)}
    ${ovGenreCard(data, label)}`;
}

PAGES.dashboard = async () => {
  const now = new Date();
  const period = state.query.get('period') === 'year' ? 'year' : 'month';
  const qm = state.query.get('m') || '';
  const month = /^\d{4}-\d{2}$/.test(qm) ? qm : monthKey(now);
  const [y, m] = month.split('-').map(Number);
  const label = periodLabel(y, period === 'year' ? 0 : m);

  const unit = period === 'year' ? '年' : '月';
  $('#view').innerHTML =
    head('概览', '观看节奏、类型分布与近期动态', `
      <div class="ov-period">
        <div class="ov-seg" role="tablist" aria-label="统计周期">
          <button type="button" class="ov-seg-btn ${period === 'month' ? 'active' : ''}" data-ovp="month" role="tab" aria-selected="${period === 'month'}">月度</button>
          <button type="button" class="ov-seg-btn ${period === 'year' ? 'active' : ''}" data-ovp="year" role="tab" aria-selected="${period === 'year'}">年度</button>
        </div>
        <span class="ov-period-sep" aria-hidden="true"></span>
        <button type="button" class="seg-btn ov-step" data-ovstep="-1" title="上一${unit}" aria-label="上一${unit}">‹</button>
        <b class="ov-monthlabel">${esc(label)}</b>
        <button type="button" class="seg-btn ov-step" data-ovstep="1" title="下一${unit}" aria-label="下一${unit}">›</button>
      </div>`) +
    `<div class="ov-grid" id="ov-root">
      <div class="card ov-card">${loadingBox('正在读取观看记录…')}</div>
      <div class="card ov-card">${loadingBox()}</div>
    </div>`;

  // 周期控件一律以地址栏的最新值为基准：连点/双击时如果用渲染那一刻的闭包，
  // 会拿旧年月再算一次，看起来就像「点一次跳了两格」
  const ovCur = () => {
    const raw = state.query.get('m') || '';
    const key = /^\d{4}-\d{2}$/.test(raw) ? raw : monthKey(new Date());
    const [cy, cm] = key.split('-').map(Number);
    return { period: state.query.get('period') === 'year' ? 'year' : 'month', key, y: cy, m: cm };
  };
  document.querySelectorAll('[data-ovp]').forEach((el) => {
    el.onclick = () => {
      const target = el.dataset.ovp === 'year' ? 'year' : 'month';
      const cur = ovCur();
      if (cur.period === target) return; // 已经在当前视图，别再多跑一次路由
      // 换周期时保住当前年月：看的是 2025 年就进 2025 年报，切回月度还是那个月
      setQuery({ period: target === 'month' ? '' : 'year', m: cur.key });
    };
  });
  document.querySelectorAll('[data-ovstep]').forEach((el) => {
    el.onclick = () => {
      if (Date.now() - ovStepAt < 150) return; // 双击 / 连点合并成一次
      ovStepAt = Date.now();
      const step = Number(el.dataset.ovstep) > 0 ? 1 : -1;
      const cur = ovCur();
      setQuery({ m: cur.period === 'year' ? `${cur.y + step}-01` : ovShiftMonth(cur.y, cur.m, step) });
    };
  });

  try {
    const data = await ovLoad(period, month);
    const root = $('#ov-root');
    if (!root) return;
    root.innerHTML = ovRender(period, y, m, data);
    localize(root);
    // 月历点某天：只换「单日观看」那张卡，不重跑路由
    root.querySelectorAll('[data-ovday]').forEach((el) => {
      el.onclick = () => {
        const key = el.dataset.ovday;
        const card = root.querySelector('.ov-day');
        if (card) card.outerHTML = ovDayCard(data.days.get(key), key, data.compare?.day);
        root.querySelectorAll('[data-ovday]').forEach((c) => c.classList.toggle('sel', c.dataset.ovday === key));
      };
    });
  } catch (e) {
    showError($('#ov-root'), e, () => PAGES.dashboard());
  }
};

/* ───────── 观看历史 ───────── */

PAGES.history = async () => {
  const st = state.history;
  $('#view').innerHTML =
    head('记录', '按月回看观看记录，点某天在右侧看详情', `
      <div class="seg" id="hist-type-seg" role="group" aria-label="按类型筛选">
        ${[['all', '全部'], ['movies', '电影'], ['episodes', '剧集']]
          .map(([v, l]) => `<button data-type="${v}" class="${st.type === v ? 'active' : ''}">${l}</button>`)
          .join('')}
      </div>
      <div class="seg" role="group" aria-label="导出">${exportMenu('hist-export')}</div>
      <div class="seg" role="group" aria-label="评分管理"><button id="hist-ratings">评分管理</button></div>`) +
    '<div id="page-body"><div id="hist-cal"></div></div>';

  $('#hist-ratings').onclick = () => setQuery({ tab: 'ratings' });
  $('#hist-type-seg')
    .querySelectorAll('[data-type]')
    .forEach((btn) => {
      btn.onclick = () => {
        if (st.type === btn.dataset.type) return;
        st.type = btn.dataset.type;
        st.cache.clear();
        $('#hist-type-seg')
          .querySelectorAll('[data-type]')
          .forEach((b) => b.classList.toggle('active', b === btn));
        loadHistoryCalendar();
      };
    });
  // 导出接口按电影/剧集分端点，「全部」没有对应上游端点，所以先选类型
  mountExportMenu('hist-export', (format) => {
    if (st.type === 'all') {
      toast('请先把类型切换为电影或剧集，再导出', true);
      return '';
    }
    return `/api/export?kind=history&type=${st.type}&format=${format}`;
  });

  await renderHistoryCalendar();
};

/** 与追剧页同构：左月历 + 右当日详情，URL 的 m/d 参数与追剧页一致 */
async function renderHistoryCalendar() {
  const host = $('#hist-cal');
  if (!host) return;
  const st = state.history;
  const now = new Date();
  const today = ymd(now);
  const qm = state.query.get('m') || '';
  st.month = /^\d{4}-\d{2}$/.test(qm) ? qm : monthKey(now);
  const qd = state.query.get('d') || '';
  st.selected =
    /^\d{4}-\d{2}-\d{2}$/.test(qd) && qd.startsWith(st.month)
      ? qd
      : st.month === today.slice(0, 7)
        ? today
        : `${st.month}-01`;

  host.innerHTML = `<div class="cal-wrap">
    <div class="card cal-card">
      <div class="cal-head">
        <b id="cal-title"></b>
        <span class="sub" id="cal-sub"></span>
        <div class="spacer"></div>
        <button class="btn btn-sm" id="cal-today">今天</button>
        <button class="btn btn-sm" id="cal-prev" title="上一月">‹</button>
        <button class="btn btn-sm" id="cal-next" title="下一月">›</button>
      </div>
      <div class="cal-week">${(isEn() ? ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] : CAL_WEEK).map((w) => `<span>${w}</span>`).join('')}</div>
      <div class="cal-grid" id="cal-grid">${loadingBox('正在读取观看历史…')}</div>
      <div class="cal-foot"><i class="cal-dot on"></i><span>已观看</span>
        <div class="spacer"></div><span class="sub">来自 Trakt 观看历史 · 悬停格子可看当天片名</span></div>
    </div>
    <div class="card cal-side" id="cal-side">${loadingBox()}</div>
  </div>`;

  const step = (n) => {
    const [y, m] = st.month.split('-').map(Number);
    setQuery({ m: monthKey(new Date(y, m - 1 + n, 1)), d: '' });
  };
  $('#cal-prev').onclick = () => step(-1);
  $('#cal-next').onclick = () => step(1);
  $('#cal-today').onclick = () => setQuery({ m: '', d: '' });

  await loadHistoryCalendar();
}

async function loadHistoryCalendar() {
  const st = state.history;
  const grid = $('#cal-grid');
  if (!grid) return;
  try {
    let data = st.cache.get(st.month);
    if (!data) {
      grid.innerHTML = loadingBox('正在读取观看历史…');
      data = await fetchHistoryMonth(st.month, st.type);
      st.cache.set(st.month, data);
    }
    st.data = data;
    // 评分 / 剧评索引只拉一次（与月份无关），失败不阻塞历史本体
    if (!st.aux) {
      histAux().then(() => {
        if (state.route === 'records' && $('#cal-side')) renderHistoryDay();
      }).catch(() => {});
    }
    renderHistoryGrid();
    renderHistoryDay();
  } catch (e) {
    showError(grid, e, loadHistoryCalendar);
    const side = $('#cal-side');
    if (side) side.innerHTML = '';
  }
}

/** 整月观看历史：/sync/history 带日期范围分页拉取，按本地日期折成「天」 */
async function fetchHistoryMonth(month, type) {
  const [y, m] = month.split('-').map(Number);
  const path = type === 'all' ? '/sync/history' : `/sync/history/${type}`;
  // Trakt 的 start_at/end_at 按 UTC 解析且 end_at 是「当天 00:00」（不含当天）：
  // 前后各扩一天，再按本地日期折天时只保留本月，避免漏掉月末日与跨时区边界的记录
  const start = ymd(new Date(y, m - 1, 0));
  const end = ymd(new Date(y, m, 2));
  const items = [];
  for (let page = 1; page <= 10; page++) {
    const r = await api(path, {
      query: { start_at: start, end_at: end, limit: 100, page },
    });
    const rows = r.data || [];
    items.push(...rows);
    if (page >= Number(r.pagination?.pageCount || 1) || !rows.length) break;
  }
  const days = {};
  for (const it of items) {
    const at = new Date(it.watched_at || '');
    if (Number.isNaN(at.getTime())) continue;
    // 子端点（/sync/history/{type}）条目不带 type 字段，按载荷形态补全
    if (!it.type) it.type = it.episode ? 'episode' : it.movie ? 'movie' : '';
    const key = ymd(at);
    if (!key.startsWith(month)) continue;
    (days[key] = days[key] || []).push(it);
  }
  Object.values(days).forEach((list) => list.sort((a, b) => new Date(a.watched_at) - new Date(b.watched_at)));
  return { days, total: items.length };
}

/** 评分与剧评索引：trakt id → 评分 / 评论列表（全量分页，进入记录页拉一次） */
async function histAux() {
  const st = state.history;
  if (st.aux) return st.aux;
  const ratings = { episode: new Map(), movie: new Map(), show: new Map() };
  const comments = { episode: new Map(), movie: new Map(), show: new Map() };
  const rawComments = [];
  const pull = async (path, fn) => {
    for (let page = 1; page <= 20; page++) {
      const r = await api(path, { query: { limit: 100, page } });
      const rows = r.data || [];
      rows.forEach(fn);
      if (page >= Number(r.pagination?.pageCount || 1) || !rows.length) break;
    }
  };
  const rateFn = (kind, pick) => (it) => {
    const id = pick(it)?.ids?.trakt;
    if (id) ratings[kind].set(id, it);
  };
  await Promise.all([
    pull('/users/me/ratings/episodes', rateFn('episode', (it) => it.episode)),
    pull('/users/me/ratings/movies', rateFn('movie', (it) => it.movie)),
    pull('/users/me/ratings/shows', rateFn('show', (it) => it.show)),
    pull('/users/me/comments', (it) => {
      const text = String(it.comment?.comment || '').trim();
      if (!text) return;
      const kind = it.episode ? 'episode' : it.movie ? 'movie' : it.show ? 'show' : '';
      const id = kind ? it[kind]?.ids?.trakt : null;
      if (!id) return;
      const list = comments[kind].get(id) || [];
      list.push({ text, spoiler: !!it.comment?.spoiler, created_at: it.comment?.created_at || '' });
      comments[kind].set(id, list);
    }),
  ]);
  st.aux = { ratings, comments, rawComments };
  return st.aux;
}

function renderHistoryGrid() {
  const st = state.history;
  const grid = $('#cal-grid');
  if (!grid) return;
  const [y, m] = st.month.split('-').map(Number);
  const title = $('#cal-title');
  const sub = $('#cal-sub');
  if (title) title.textContent = periodLabel(y, m);
  if (sub) sub.textContent = st.data?.total ? `共 ${st.data.total} 条记录` : '';

  const lead = (new Date(y, m - 1, 1).getDay() + 6) % 7;
  const total = new Date(y, m, 0).getDate();
  const rows = Math.ceil((lead + total) / 7);
  const today = ymd(new Date());
  const days = st.data?.days || {};
  const cells = [];

  for (let i = 0; i < rows * 7; i++) {
    const n = i - lead + 1;
    const date = new Date(y, m - 1, n);
    if (n < 1 || n > total) {
      cells.push(`<div class="cal-cell out"><span class="cal-d">${date.getDate()}</span></div>`);
      continue;
    }
    const key = ymd(date);
    // 同剧当天看再多集也只算一部：格子按「部」叠封面
    const groups = histGroups(days[key] || [], null);
    const posters = groups
      .slice(0, 3)
      .map((g) => posterImg(`/api/poster?${artQuery(g.kind, g.ids)}`, 'cal-poster'))
      .join('');
    const more = groups.length > 3 ? `<span class="cal-more">+${groups.length - 3}</span>` : '';
    const tip = groups.length ? `${key} · ${groups.map((g) => g.title).join('、')}` : `${key} · 无观看记录`;
    const tipAttr = locTipAttr(key, groups.map((g) => ({ type: g.kind, ids: g.ids })));
    const cls = ['cal-cell'];
    if (key === today) cls.push('today');
    if (key === st.selected) cls.push('sel');
    cells.push(`<button class="${cls.join(' ')}" data-cday="${key}" title="${esc(tip)}"${tipAttr}>
      <span class="cal-d">${n}</span>
      <span class="cal-stack">${posters}${more}</span>
    </button>`);
  }
  grid.innerHTML = cells.join('');
  localize(grid);
  grid.querySelectorAll('[data-cday]').forEach((el) => {
    el.onclick = () => selectHistoryDay(el.dataset.cday);
  });
}

/** 与追剧页一致：换日期只重画选中态与右侧面板，URL 同步可刷新回到同一天 */
function selectHistoryDay(key) {
  const st = state.history;
  if (!key || key === st.selected) return;
  st.selected = key;
  const q = new URLSearchParams(state.query);
  q.set('d', key);
  state.query = q;
  history.replaceState(null, '', `#/records?${q.toString()}`);
  document.querySelectorAll('#cal-grid [data-cday]').forEach((el) => {
    el.classList.toggle('sel', el.dataset.cday === key);
  });
  renderHistoryDay();
}

/** 当天记录按「剧 / 电影」聚合成组，并挂上评分与剧评（aux 未就绪时先只显示历史本体） */
function histGroups(list, aux) {
  const map = new Map();
  for (const it of list) {
    const isEp = !!it.episode || it.type === 'episode';
    const show = it.show || {};
    const movie = it.movie || {};
    const key = isEp ? `show:${show.ids?.trakt}` : `movie:${movie.ids?.trakt}`;
    if (!map.has(key)) {
      map.set(key, {
        kind: isEp ? 'show' : 'movie',
        ids: isEp ? show.ids || {} : movie.ids || {},
        title: (isEp ? show.title : movie.title) || '—',
        year: (isEp ? show.year : movie.year) || '',
        items: [],
      });
    }
    map.get(key).items.push(it);
  }
  return [...map.values()].map((g) => {
    const eps = g.items.filter((it) => it.episode).map((it) => it.episode);
    eps.sort((a, b) => a.season - b.season || a.number - b.number);
    const times = g.items
      .map((it) => new Date(it.watched_at || ''))
      .filter((d) => !Number.isNaN(d.getTime()))
      .sort((a, b) => a - b);
    let rating = null;
    let reviews = [];
    if (aux) {
      if (g.kind === 'movie') {
        rating = aux.ratings.movie.get(g.ids.trakt)?.rating ?? null;
        reviews = [...(aux.comments.movie.get(g.ids.trakt) || [])];
      } else {
        // 集评分取当天看过集里最新的一条；都没有则回落到剧集评分
        const rated = g.items
          .map((it) => aux.ratings.episode.get(it.episode?.ids?.trakt))
          .filter(Boolean)
          .sort((a, b) => new Date(b.rated_at || 0) - new Date(a.rated_at || 0));
        rating = rated[0]?.rating ?? aux.ratings.show.get(g.ids.trakt)?.rating ?? null;
        reviews = [...(aux.comments.show.get(g.ids.trakt) || [])];
        const seen = new Set(reviews.map((r) => r.text));
        g.items.forEach((it) => {
          (aux.comments.episode.get(it.episode?.ids?.trakt) || []).forEach((r) => {
            if (!seen.has(r.text)) {
              seen.add(r.text);
              reviews.push(r);
            }
          });
        });
      }
    }
    return { ...g, eps, times, rating, reviews };
  });
}

function renderHistoryDay() {
  const st = state.history;
  const side = $('#cal-side');
  if (!side) return;
  const day = st.selected;
  const list = (st.data?.days || {})[day] || [];
  const groups = histGroups(list, st.aux);
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const head = `<div class="cal-side-head">
    <div class="cal-side-date">${mdLabel(m, d)}</div>
    <div class="sub">${weekdayName(date.getDay())}${
      list.length
        ? isEn()
          ? ` · ${list.length} ${plural(list.length, 'play', 'plays')} · ${groups.length} ${plural(groups.length, 'title', 'titles')}`
          : ` · ${list.length} 条记录 · ${groups.length} 部`
        : ''
    }</div>
  </div>`;

  if (!list.length) {
    side.innerHTML =
      head +
      `<div class="cal-empty">
        <span class="cal-empty-ico">${CAL_ICON}</span>
        <b class="cal-empty-title">这一天，没有观看记录</b>
        <p class="cal-empty-hint">在详情页标记已看后，记录会按观看日期出现在这里。</p>
        <a class="btn btn-sm" href="#/search">去找点看的</a>
      </div>`;
    side.onclick = null;
    return;
  }

  side.innerHTML = head + `<div class="cal-list">${groups.map(histItem).join('')}</div>`;

  side.querySelectorAll('[data-hday-item]').forEach((el) => {
    el.onclick = (ev) => {
      if (ev.target.closest('button')) return;
      const g = groups[Number(el.dataset.hdayItem)];
      openDetail({ type: g.kind, ids: g.ids });
    };
  });
  side.onclick = () => side.querySelectorAll('.cal-menu').forEach((x) => (x.hidden = true));
  side.querySelectorAll('.cal-kebab').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const menu = b.closest('.cal-item').querySelector('.cal-menu');
      const open = menu.hidden;
      side.querySelectorAll('.cal-menu').forEach((x) => (x.hidden = true));
      menu.hidden = !open;
    };
  });
  side.querySelectorAll('[data-hact]').forEach((b) => {
    b.onclick = async (ev) => {
      ev.stopPropagation();
      const g = groups[Number(b.dataset.idx)];
      if (b.dataset.hact === 'open') {
        openDetail({ type: g.kind, ids: g.ids });
        return;
      }
      b.disabled = true;
      try {
        await removeHistoryGroup(g);
      } finally {
        b.disabled = false;
      }
    };
  });
  localize(side);
}

function histItem(g, i) {
  const hm = (d) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const timeText = g.times.length
    ? `${isEn() ? 'Watched' : '观看'} ${hm(g.times[0])}${
        g.times.length > 1
          ? `–${hm(g.times[g.times.length - 1])} · ${isEn() ? `${g.times.length} ${plural(g.times.length, 'play', 'plays')}` : `共 ${g.times.length} 次`}`
          : ''
      }`
    : '';
  const meta = [g.year || '', timeText].filter(Boolean).join(' · ');
  // 集数：单集给集名，多集给「共看 N 集」与集号列表；电影只显示年份（在 meta 里）
  let epLine = '';
  if (g.eps.length === 1) {
    const ep = g.eps[0];
    epLine = `S${pad2(ep.season)} · E${pad2(ep.number)}${ep.title ? ` · ${esc(ep.title)}` : ''}`;
  } else if (g.eps.length > 1) {
    epLine = `${isEn() ? `${g.eps.length} ${plural(g.eps.length, 'episode', 'episodes')}:` : `共看 ${g.eps.length} 集：`}${g.eps
      .map((ep) => `S${pad2(ep.season)}E${pad2(ep.number)}`)
      .join(' · ')}`;
  }
  const rateLine = g.rating
    ? `<div class="hist-rate"><span class="rating-badge">${esc(g.rating)}</span><span class="sub">我的评分</span></div>`
    : '';
  const reviewHtml = g.reviews.length
    ? g.reviews
        .map(
          (r) =>
            `<div class="hist-review">${r.spoiler ? '<span class="chip red">剧透</span>' : ''}${esc(r.text)}</div>`
        )
        .join('')
    : '';
  return `<div class="cal-item" data-hday-item="${i}">
    <div class="cal-item-poster">${posterImg(`/api/poster?${artQuery(g.kind, g.ids)}`, 'cal-cover')}</div>
    <div class="cal-item-body">
      <div class="cal-item-top">
        <b class="cal-item-title" ${locAttrs(g.kind, g.ids)}>${esc(g.title)}</b>
        <button class="cal-kebab" title="更多操作">⋯</button>
      </div>
      <span class="chip ok">已观看</span>${g.kind === 'movie' ? ' <span class="chip red">电影</span>' : ''}
      <div class="cal-item-meta">${esc(meta || '—')}</div>
      ${epLine ? `<div class="cal-item-ep hist-eps">${epLine}</div>` : ''}
      ${rateLine}
      ${reviewHtml}
      <div class="cal-menu" hidden>
        <button data-hact="open" data-idx="${i}">打开详情</button>
        <button data-hact="del" data-idx="${i}">删除当天这部${g.kind === 'movie' ? '电影' : '剧'}的记录</button>
      </div>
    </div>
  </div>`;
}

/** 删除一组（当天同剧/同电影）观看记录，12 秒内可撤销；完成后刷新当月日历 */
async function removeHistoryGroup(g) {
  const ids = g.items.map((it) => it.id).filter(Boolean);
  if (!ids.length) return;
  if (!(await confirmDialog(`删除《${g.title}》当天的 ${ids.length} 条观看记录？`, '删除后 Trakt 端的观看历史会同步减少。下面的提示条里有 12 秒的撤销机会。')))
    return;
  const st = state.history;
  const reload = async () => {
    st.cache.delete(st.month);
    await loadHistoryCalendar();
  };
  try {
    await api('/sync/history/remove', { method: 'POST', body: { ids } });
    undoToast(`已删除 ${ids.length} 条记录`, async () => {
      await restoreHistory(g.items);
      toast('已恢复删除的记录');
      await reload();
    });
    await reload();
  } catch (e) {
    toast(e.message, true);
  }
}

/** 批量删除的反向操作：按原始条目（含 watched_at）重新写回历史 */
async function restoreHistory(items) {
  const payload = {};
  items.forEach((it) => {
    const isEp = it.type === 'episode' || !!it.episode;
    const ids = isEp ? it.episode?.ids : it.movie?.ids;
    if (!ids) return;
    const key = isEp ? 'episodes' : 'movies';
    (payload[key] = payload[key] || []).push({ ids, watched_at: it.watched_at });
  });
  for (const key of Object.keys(payload)) {
    await api('/sync/history', { method: 'POST', body: { [key]: payload[key] } });
  }
}

/* ───────── 评分 ───────── */

const TYPE_LABEL = { movies: '电影', shows: '剧集', episodes: '分集', seasons: '季' };

PAGES.ratings = async () => {
  const st = state.ratings;
  $('#view').innerHTML =
    head('评分管理', '改分即时生效，0 分等于删除评分；下方汇总同一分类下的剧评', `
      <div class="seg" role="group" aria-label="导出">${exportMenu('rating-export')}</div>
      <div class="seg" role="group" aria-label="返回记录"><button id="rating-history">${ICON.back} 返回记录</button></div>`) +
    `<div id="page-body">
      <div class="card">
        <div class="hint-bar">
          <div class="seg" role="group" aria-label="按类型筛选">
            ${Object.entries(TYPE_LABEL)
              .map(([k, v]) => `<button class="${st.type === k ? 'active' : ''}" data-rtype="${k}">${v}</button>`)
              .join('')}
          </div>
          <div style="flex:1"></div>
          <span class="sub">共 <b id="rating-count">—</b> 条</span>
        </div>
        <div class="table-wrap" id="rating-body">${loadingBox()}</div>
        <div class="pager" id="rating-pager" hidden></div>
      </div>
      <div class="card" style="margin-top:14px">
        <div class="hint-bar">
          <b>剧评</b>
          <div style="flex:1"></div>
          <span class="sub" id="comment-count">—</span>
        </div>
        <div id="comment-body">${loadingBox()}</div>
      </div>
    </div>`;

  $('#rating-history').onclick = () => setQuery({ tab: '' });
  document.querySelectorAll('[data-rtype]').forEach((el) => {
    el.onclick = () => {
      st.type = el.dataset.rtype;
      st.page = 1;
      st.commentShown = 20;
      PAGES.ratings();
    };
  });
  mountExportMenu('rating-export', (format) => `/api/export?kind=ratings&type=${st.type}&format=${format}`);
  await Promise.all([loadRatings(), loadRatingComments()]);
};

async function loadRatings() {
  const st = state.ratings;
  if (!$('#rating-body')) return; // 切到别的 tab 了
  $('#rating-body').innerHTML = loadingBox();
  try {
    const r = await api(`/users/me/ratings/${st.type}`, { query: { page: st.page, limit: st.limit } });
    st.data = r.data || [];
    st.meta = r.pagination;
    $('#rating-count').textContent = num(r.pagination?.itemCount || st.data.length);
    renderRatings();
  } catch (e) {
    showError($('#rating-body'), e, loadRatings);
  }
}

function ratingItem(it) {
  if (it.movie) return { title: it.movie.title, sub: it.movie.year, ids: it.movie.ids, kind: 'movies', art: 'movie', artIds: it.movie.ids };
  if (it.show) return { title: it.show.title, sub: it.show.year, ids: it.show.ids, kind: 'shows', art: 'show', artIds: it.show.ids };
  if (it.episode) {
    return {
      title: `${it.show?.title || ''}`,
      sub: `S${String(it.episode.season).padStart(2, '0')}E${String(it.episode.number).padStart(2, '0')} · ${it.episode.title || ''}`,
      ids: it.episode.ids,
      kind: 'episodes',
      art: 'episode',
      artIds: it.show?.ids || {},
      act: { type: 'episode', ids: it.episode.ids },
      season: it.episode.season,
      number: it.episode.number,
    };
  }
  if (it.season) {
    return { title: `${it.show?.title || ''} 第 ${it.season.number} 季`, sub: '', ids: it.season.ids, kind: 'seasons', art: 'show', artIds: it.show?.ids || {}, act: { type: 'season', ids: it.season.ids } };
  }
  return { title: '—', sub: '', ids: {}, kind: 'movies', art: 'movie', artIds: {} };
}

function renderRatings() {
  const st = state.ratings;
  if (!st.data.length) {
    $('#rating-body').innerHTML = emptyState('还没有评分记录', { icon: 'star' });
    $('#rating-pager').hidden = true;
    return;
  }
  $('#rating-body').innerHTML = `<table>
    <thead><tr><th class="col-poster"></th><th>标题</th><th style="width:90px">评分</th><th style="width:120px">改分</th><th style="width:70px"></th><th style="text-align:right;width:110px">评分时间</th></tr></thead>
    <tbody>${st.data
      .map((it, i) => {
        const m = ratingItem(it);
        return `<tr ${rowAttrs(m.art, m.artIds, m.season, m.number, m.title, m.act)}>
          <td class="col-poster">${thumb(m.art === 'episode' ? 'show' : m.art, m.artIds)}</td>
          <td>${titleCell(m.title, m.sub, locAttrs(m.art, m.artIds, m.season, m.number))}</td>
          <td><span class="rating-badge">${esc(it.rating)}</span></td>
          <td>
            <select class="rate-set" data-idx="${i}">
              <option value="">—</option>
              ${Array.from({ length: 10 }, (_, k) => 10 - k)
                .map((v) => `<option value="${v}" ${Number(it.rating) === v ? 'selected' : ''}>${v}</option>`)
                .join('')}
            </select>
          </td>
          <td><button class="btn btn-sm btn-danger rate-del" data-idx="${i}">删除</button></td>
          <td class="num" style="text-align:right;white-space:nowrap">${esc(fmtDateTime(it.rated_at))}</td>
        </tr>`;
      })
      .join('')}</tbody></table>`;

  bindRowClick($('#rating-body'));
  localize($('#rating-body'));

  document.querySelectorAll('.rate-set').forEach((sel) => {
    sel.onchange = async () => {
      const idx = Number(sel.dataset.idx);
      const it = st.data[idx];
      const m = ratingItem(it);
      const rating = Number(sel.value);
      if (!rating) return;
      try {
        await api('/sync/ratings', { method: 'POST', body: { [m.kind]: [{ ids: m.ids, rating }] } });
        it.rating = rating;
        toast(`已改为 ${rating} 分`);
        renderRatings();
      } catch (e) {
        toast(e.message, true);
      }
    };
  });
  document.querySelectorAll('.rate-del').forEach((btn) => {
    btn.onclick = async () => {
      const idx = Number(btn.dataset.idx);
      const it = st.data[idx];
      const m = ratingItem(it);
      try {
        await api('/sync/ratings', { method: 'POST', body: { [m.kind]: [{ ids: m.ids, rating: 0 }] } });
        toast('评分已删除');
        await loadRatings();
      } catch (e) {
        toast(e.message, true);
      }
    };
  });

  mountPager($('#rating-pager'), st.meta || { page: 1, pageCount: 1, itemCount: st.data.length }, (p) => {
    st.page = p;
    loadRatings();
  }, num);
}

/* ── 评分管理页的剧评汇总 ── */

/** 评论条目属于哪个分类（episode 同时带 show，必须先判） */
function commentKindOf(it) {
  if (it.episode) return 'episodes';
  if (it.season) return 'seasons';
  if (it.movie) return 'movies';
  if (it.show) return 'shows';
  return '';
}

/** 评论指向的条目：标题 / 副标题 / 详情页参数 / 对应评分键 */
function commentTarget(it) {
  if (it.episode) {
    const e = it.episode;
    return {
      title: it.show?.title || e.title || '—',
      sub: `S${String(e.season).padStart(2, '0')}E${String(e.number).padStart(2, '0')}${e.title ? ` · ${e.title}` : ''}`,
      kind: 'episode',
      ids: it.show?.ids || {},
      season: e.season,
      number: e.number,
      ratingKind: 'episode',
      ratingKey: e.ids?.trakt,
    };
  }
  if (it.season) {
    return {
      title: it.show?.title || '—',
      sub: `第 ${it.season.number} 季`,
      kind: 'show',
      ids: it.show?.ids || {},
      ratingKind: '',
      ratingKey: '',
    };
  }
  if (it.movie) {
    return {
      title: it.movie.title,
      sub: it.movie.year,
      kind: 'movie',
      ids: it.movie.ids || {},
      ratingKind: 'movie',
      ratingKey: it.movie.ids?.trakt,
    };
  }
  if (it.show) {
    return {
      title: it.show.title,
      sub: it.show.year,
      kind: 'show',
      ids: it.show.ids || {},
      ratingKind: 'show',
      ratingKey: it.show.ids?.trakt,
    };
  }
  return null;
}

async function loadRatingComments() {
  if (!$('#comment-body')) return;
  $('#comment-body').innerHTML = loadingBox();
  try {
    const aux = await histAux();
    state.ratings.comments = aux.rawComments || [];
    renderRatingComments();
  } catch (e) {
    if ($('#comment-body')) showError($('#comment-body'), e, loadRatingComments);
  }
}

function renderRatingComments() {
  const st = state.ratings;
  const box = $('#comment-body');
  if (!box) return;
  const aux = state.history.aux;
  const list = (st.comments || [])
    .filter((it) => commentKindOf(it) === st.type)
    .sort((a, b) => String(b.comment?.created_at || '').localeCompare(String(a.comment?.created_at || '')));
  const count = $('#comment-count');
  if (count) count.textContent = `共 ${num(list.length)} 条`;

  if (!list.length) {
    box.innerHTML = emptyState('这个分类还没有剧评', { icon: 'edit', hint: '在 Trakt 网页或详情页写过的剧评会汇总到这里' });
    return;
  }

  const shown = Math.min(st.commentShown || 20, list.length);
  const page = list.slice(0, shown);
  box.innerHTML = `<div class="cmt-list">${page
    .map((it, i) => {
      const t = commentTarget(it);
      const c = it.comment || {};
      const rating = (t?.ratingKind && aux?.ratings?.[t.ratingKind]?.get(t.ratingKey)?.rating) || 0;
      return `<div class="cmt-item" data-cmt="${i}">
        <div class="cmt-head">
          <b class="cmt-title" ${locAttrs(t?.kind, t?.ids, t?.season, t?.number)}>${esc(t?.title || '—')}</b>
          ${rating ? `<span class="rating-badge">${esc(rating)}</span>` : ''}
          ${c.spoiler ? '<span class="chip red">剧透</span>' : ''}
          ${c.review ? '<span class="chip">长评</span>' : ''}
          <span class="sub cmt-date">${esc(fmtDateTime(c.created_at))}</span>
        </div>
        ${t?.sub ? `<div class="cmt-sub">${esc(t.sub)}</div>` : ''}
        <div class="cmt-text clamp">${esc(String(c.comment || '').trim())}</div>
        <button class="cmt-toggle" data-cmt-toggle="${i}">展开全文</button>
      </div>`;
    })
    .join('')}</div>
  ${list.length > shown ? `<div class="cmt-more"><button class="btn btn-sm" id="cmt-more">再显示 ${num(Math.min(20, list.length - shown))} 条</button></div>` : ''}`;

  box.querySelectorAll('[data-cmt-toggle]').forEach((b) => {
    b.onclick = (ev) => {
      ev.stopPropagation();
      const text = b.closest('.cmt-item').querySelector('.cmt-text');
      const clamped = text.classList.toggle('clamp');
      b.textContent = clamped ? '展开全文' : '收起';
    };
  });
  box.querySelectorAll('[data-cmt]').forEach((el) => {
    el.onclick = (ev) => {
      if (ev.target.closest('button')) return;
      const t = commentTarget(page[Number(el.dataset.cmt)]);
      if (t) openDetail({ type: t.kind, ids: t.ids, season: t.season, number: t.number });
    };
  });
  const more = $('#cmt-more');
  if (more) {
    more.onclick = () => {
      st.commentShown = shown + 20;
      renderRatingComments();
    };
  }
  localize(box);
}

/* ───────── 片单：待看 / 收藏 共用一个表格，切换在工具条里 ───────── */

const LIB_TABS = [
  ['watchlist', '待看'],
  ['favorites', '收藏'],
];

const libState = () => (state.library.tab === 'favorites' ? state.favorites : state.watchlist);

/** 把 watchlist / favorites 的条目统一成表格行需要的信息（表格里要显示年份、类型、时长、评分、加入时间） */
function libEntry(it) {
  const en = isEn();
  if (it?.movie) {
    const m = it.movie;
    return {
      kind: 'movie',
      ids: m.ids || {},
      title: m.title || '未知条目',
      sub: [m.year, en ? 'Movie' : '电影', m.runtime ? (en ? `${m.runtime}m` : `${m.runtime} 分钟`) : ''].filter(Boolean).join(' · '),
      badge: '电影',
      rating: Number(m.rating) || 0,
      votes: Number(m.votes) || 0,
      genres: m.genres || [],
      date: it.listed_at || it.favorited_at || '',
    };
  }
  const s = it?.show;
  if (!s) return null;
  const ep = it.episode || null;
  const code = ep && ep.season != null && ep.number != null ? `S${pad2(ep.season)}E${pad2(ep.number)}` : '';
  const per = s.runtime ? (en ? `${s.runtime}m/ep` : `${s.runtime} 分钟/集`) : '';
  const total = s.aired_episodes ? (en ? `${s.aired_episodes} eps` : `共 ${s.aired_episodes} 集`) : '';
  return {
    kind: ep ? 'episode' : 'show',
    ids: s.ids || {},
    title: s.title || '未知条目',
    sub: [s.year, ep ? en ? 'Episode' : '分集' : en ? 'Show' : '剧集', code, per, total].filter(Boolean).join(' · '),
    badge: ep ? '分集' : '剧集',
    rating: Number(s.rating) || 0,
    votes: Number(s.votes) || 0,
    genres: s.genres || [],
    date: it.listed_at || it.favorited_at || '',
    season: ep?.season,
    number: ep?.number,
  };
}

PAGES.library = async () => {
  // 老链接带 ?tab=favorites 时直接落在收藏；其余一律看待看
  if (state.query.get('tab') === 'favorites') state.library.tab = 'favorites';
  $('#view').innerHTML =
    head('片单', '待看、收藏与自定义列表；切换在表格顶部，勾选后可批量处理', '') +
    `<section class="card episode-manager lib-manager">
      <div class="episode-toolbar lib-bar">
        <div class="seg" id="lib-seg">
          ${LIB_TABS.map(([v, l]) => `<button data-lib="${v}" class="${state.library.tab === v ? 'active' : ''}">${l}<span class="chip" id="lib-n-${v}">–</span></button>`).join('')}
        </div>
        <label class="episode-search lib-search"><span>${ICON.search}</span><input id="lib-q" type="search" placeholder="筛选标题…" aria-label="筛选标题" value="${esc(libState().q)}" autocomplete="off"></label>
        <label class="media-pick"><input type="checkbox" class="checkbox lib-all-check" aria-label="全选当前结果"> 全选</label>
        <div class="episode-toolbar-pager">
          <span class="lib-count" id="lib-count">—</span>
          <div class="seg" role="group" aria-label="片单操作">${exportMenu('lib-export')}</div>
        </div>
      </div>
      <div class="episode-selection-bar" id="lib-bulk" hidden>
        <span id="lib-sel">已选 0 项</span>
        <div class="episode-selection-actions">
          <button class="btn btn-sm" id="lib-cancel">取消选择</button>
          <button class="btn btn-sm btn-danger" id="lib-bulk-del">移除</button>
        </div>
      </div>
      <div class="episode-table-wrap lib-table-wrap" id="lib-body">${loadingBox()}</div>
    </section>
    <div class="card" style="margin-top:16px">
      <div class="hint-bar"><b>自定义列表</b><div style="flex:1"></div><span class="sub">点击展开查看条目</span>
        <button class="btn btn-primary btn-sm" id="list-new">新建列表</button></div>
      <div id="lists-body">${loadingBox()}</div>
    </div>`;

  $('#list-new').onclick = () => createListDialog();
  $('#lib-seg')
    .querySelectorAll('[data-lib]')
    .forEach((btn) => {
      btn.onclick = () => {
        if (state.library.tab === btn.dataset.lib) return;
        state.library.tab = btn.dataset.lib;
        $('#lib-seg')
          .querySelectorAll('[data-lib]')
          .forEach((b) => b.classList.toggle('active', b === btn));
        $('#lib-q').value = libState().q;
        syncLibraryExport();
        renderLibrary();
      };
    });
  const q = $('#lib-q');
  q.oninput = () => {
    libState().q = q.value.trim();
    libState().selected.clear();
    renderLibrary();
  };
  $('#lib-cancel').onclick = () => {
    libState().selected.clear();
    renderLibrary();
  };
  $('#lib-bulk-del').onclick = () => {
    const picked = [...libState().selected];
    if (state.library.tab === 'favorites') removeFavorites(picked);
    else removeWatchlist(picked);
  };
  mountExportMenu('lib-export', (format) => `/api/export?kind=watchlist&format=${format}`);
  syncLibraryExport();

  await Promise.all([loadWatchlist(), loadFavorites(), loadLists()]);
};

/** 收藏没有导出端点，切到收藏时把整块导出控件藏起来 */
function syncLibraryExport() {
  const wrap = $('#lib-export-wrap');
  if (wrap) wrap.hidden = state.library.tab === 'favorites';
}

/** 表格：勾选 / 封面 / 标题（年份·类型·时长） / 评分 / 加入时间 / 操作，整行可点进详情 */
function libRow(it, i, isFav, st) {
  const e = libEntry(it);
  if (!e) return '';
  const art = e.kind === 'movie' ? 'movie' : 'show';
  const date = e.date ? fmtDate(e.date) : '—';
  const full = e.date ? fmtDateTime(e.date) : '';
  const score = e.rating ? `★ ${e.rating.toFixed(1)}` : '—';
  const scoreTip = e.rating && e.votes ? (isEn() ? `${e.votes} ratings` : `${e.votes} 人评分`) : '';
  const rowTip = [e.title, e.genres.slice(0, 3).join(isEn() ? ', ' : '、')].filter(Boolean).join(' · ');
  return `<tr class="episode-row lib-row${st.selected.has(i) ? ' is-selected' : ''}" data-kind="${e.kind}" data-ids='${JSON.stringify(e.ids)}' data-season="${e.season ?? ''}" data-number="${e.number ?? ''}" title="${esc(rowTip)}">
    <td class="episode-check-cell"><input type="checkbox" class="checkbox lib-check" data-i="${i}" aria-label="选择 ${esc(e.title)}"${st.selected.has(i) ? ' checked' : ''}></td>
    <td class="lib-cover-cell"><span class="lib-art">${posterImg(`/api/poster?${artQuery(art, e.ids)}`, '')}</span></td>
    <td class="lib-title-cell">
      <div class="lib-name" ${locAttrs(e.kind, e.ids)}>${esc(e.title)}</div>
      <div class="lib-sub">${esc(e.sub)}</div>
    </td>
    <td class="lib-score-cell"><span class="lib-num"${scoreTip ? ` title="${esc(scoreTip)}"` : ''}>${score}</span></td>
    <td class="lib-date-cell"${full ? ` title="${esc(full)}"` : ''}><span class="lib-num">${esc(date)}</span></td>
    <td class="lib-ops-cell"><div class="lib-ops"><button class="btn btn-sm btn-danger lib-del" data-idx="${i}">${isFav ? '取消收藏' : '移除'}</button></div></td>
  </tr>`;
}

function renderLibrary() {
  const host = $('#lib-body');
  if (!host) return;
  const isFav = state.library.tab === 'favorites';
  const st = isFav ? state.favorites : state.watchlist;
  const q = String(st.q || '').toLowerCase();
  const allRows = Array.isArray(st.data) ? st.data : [];
  const rows = allRows.map((it, i) => ({ it, i })).filter(({ it }) => matchesQuery(it, q));

  const count = $('#lib-count');
  if (count) count.textContent = q ? `匹配 ${rows.length} / ${allRows.length}` : `共 ${allRows.length} 项`;
  const nWl = $('#lib-n-watchlist');
  if (nWl) nWl.textContent = String(state.watchlist.data.length);
  const nFav = $('#lib-n-favorites');
  if (nFav) nFav.textContent = String(state.favorites.data.length);
  const del = $('#lib-bulk-del');
  if (del) del.textContent = isFav ? '取消收藏' : '移除';

  if (!allRows.length) {
    host.innerHTML = emptyState(isFav ? '还没有收藏的电影或剧集' : 'Watchlist 是空的', { icon: isFav ? 'heart' : 'list' });
    syncLibraryBulk();
    return;
  }
  if (!rows.length) {
    host.innerHTML = emptyState(`没有匹配「${st.q}」的条目`, { icon: 'search' });
    syncLibraryBulk();
    return;
  }

  host.innerHTML = `<table class="episode-table lib-table">
    <thead><tr>
      <th class="episode-check-cell"><input type="checkbox" class="checkbox lib-all-check" aria-label="全选当前结果"></th>
      <th class="lib-cover-cell" aria-label="封面"></th>
      <th>标题</th>
      <th class="lib-score-cell">评分</th>
      <th class="episode-date-cell lib-date-cell">加入时间</th>
      <th class="lib-ops-cell">操作</th>
    </tr></thead>
    <tbody>${rows.map(({ it, i }) => libRow(it, i, isFav, st)).join('')}</tbody>
  </table>`;

  bindRowClick(host);
  localize(host);

  host.querySelectorAll('.lib-check').forEach((box) => {
    box.onchange = () => {
      const i = Number(box.dataset.i);
      if (box.checked) st.selected.add(i);
      else st.selected.delete(i);
      syncLibraryBulk();
    };
  });
  // 工具条和表头各有一个全选框，两个都绑上（表头那个在 host 内，工具条那个在 host 外）
  document.querySelectorAll('.lib-all-check').forEach((all) => {
    all.onchange = () => {
      rows.forEach(({ i }) => (all.checked ? st.selected.add(i) : st.selected.delete(i)));
      renderLibrary();
    };
  });
  host.querySelectorAll('.lib-del').forEach((btn) => {
    btn.onclick = () => {
      const i = Number(btn.dataset.idx);
      if (isFav) removeFavorites([i]);
      else removeWatchlist([i]);
    };
  });

  syncLibraryBulk();
}

function syncLibraryBulk() {
  const isFav = state.library.tab === 'favorites';
  const st = isFav ? state.favorites : state.watchlist;
  const q = String(st.q || '').toLowerCase();
  const visible = (st.data || [])
    .map((it, i) => ({ it, i }))
    .filter(({ it }) => matchesQuery(it, q))
    .map(({ i }) => i);
  const picked = visible.filter((i) => st.selected.has(i)).length;
  const bulk = $('#lib-bulk');
  if (bulk) bulk.hidden = picked === 0;
  const sel = $('#lib-sel');
  if (sel) sel.textContent = `已选 ${picked} 项`;
  document.querySelectorAll('.lib-all-check').forEach((all) => {
    all.checked = visible.length > 0 && picked === visible.length;
    all.indeterminate = picked > 0 && picked < visible.length;
  });
}

async function removeFavorites(indices) {
  const st = state.favorites;
  const items = indices.map((i) => st.data[i]).filter(Boolean);
  if (!items.length) return;
  if (!(await confirmDialog(`取消收藏 ${items.length} 项？`, '会同步到你的 Trakt 账号；操作后可在提示条里撤销。'))) return;
  const groups = groupRefs(items);
  try {
    for (const [seg, arr] of Object.entries(groups)) {
      await api('/sync/favorites/remove', { method: 'POST', body: { [seg]: arr } });
    }
    st.selected.clear();
    undoToast(`已取消收藏 ${items.length} 项`, async () => {
      for (const [seg, arr] of Object.entries(groups)) {
        await api('/sync/favorites', { method: 'POST', body: { [seg]: arr } });
      }
      toast('已恢复收藏');
      if ($('#lib-body')) loadFavorites();
    });
    if ($('#lib-body')) loadFavorites();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ───────── 片单：加载与批量操作 ───────── */

async function loadWatchlist() {
  try {
    const r = await api('/sync/watchlist', { query: { extended: 'full' } });
    state.watchlist.data = (r.data || []).filter(Boolean);
    state.watchlist.selected.clear();
    renderLibrary();
  } catch (e) {
    if (!state.watchlist.data.length) showError($('#lib-body'), e, loadWatchlist);
  }
}

async function loadFavorites() {
  try {
    const r = await api('/users/me/favorites', { query: { extended: 'full' } });
    state.favorites.data = (r.data || []).filter(Boolean);
    state.favorites.selected.clear();
    renderLibrary();
  } catch (e) {
    if (!state.favorites.data.length) showError($('#lib-body'), e, loadFavorites);
  }
}

async function removeWatchlist(indices) {
  const st = state.watchlist;
  const items = indices.map((i) => st.data[i]).filter(Boolean);
  if (!items.length) return;
  if (!(await confirmDialog(`从 Watchlist 移除 ${items.length} 项？`, '会同步到你的 Trakt 账号；操作后可在提示条里撤销。'))) return;
  const groups = groupRefs(items);
  try {
    for (const [seg, arr] of Object.entries(groups)) {
      await api('/sync/watchlist/remove', { method: 'POST', body: { [seg]: arr } });
    }
    st.selected.clear();
    undoToast(`已从 Watchlist 移除 ${items.length} 项`, async () => {
      for (const [seg, arr] of Object.entries(groups)) {
        await api('/sync/watchlist', { method: 'POST', body: { [seg]: arr } });
      }
      toast('已恢复');
      loadWatchlist();
    });
    loadWatchlist();
  } catch (e) {
    toast(e.message, true);
  }
}

async function loadLists() {
  const st = state.lists;
  try {
    const r = await api('/users/me/lists');
    st.data = r.data || [];
    if (!st.data.length) {
      $('#lists-body').innerHTML = emptyState('还没有自定义列表，点右上角新建', { icon: 'list' });
      return;
    }
    $('#lists-body').innerHTML = st.data
      .map(
        (l) => `<div class="list-row" data-list="${l.ids.trakt}">
        <div class="list-main">
          <div class="list-title">${esc(l.name)} ${l.privacy === 'private' ? '<span class="chip">私有</span>' : ''}</div>
          <div class="list-sub">${esc(l.description || '无描述')} · ${num(l.item_count)} 项</div>
        </div>
        <div class="toolbar">
          <button class="btn btn-sm list-toggle" data-id="${l.ids.trakt}">展开</button>
          <button class="btn btn-sm list-add" data-id="${l.ids.trakt}" data-name="${esc(l.name)}">加条目</button>
          <button class="btn btn-sm btn-danger list-del" data-id="${l.ids.trakt}" data-name="${esc(l.name)}">删除</button>
        </div>
      </div>
      <div id="list-items-${l.ids.trakt}" hidden style="border-top:1px solid var(--border)"></div>`
      )
      .join('');

    document.querySelectorAll('.list-toggle').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.id;
        const box = $(`#list-items-${id}`);
        if (!box.hidden) {
          box.hidden = true;
          state.lists.open.delete(String(id));
          btn.textContent = '展开';
          return;
        }
        box.hidden = false;
        state.lists.open.add(String(id));
        btn.textContent = '收起';
        await loadListItems(id, box);
      };
    });

    // 整页重渲染后把展开状态恢复回来，否则自定义列表会全部收起
    for (const id of state.lists.open) {
      const box = $(`#list-items-${id}`);
      const btn = document.querySelector(`.list-toggle[data-id="${id}"]`);
      if (!box || !btn) continue;
      box.hidden = false;
      btn.textContent = '收起';
      loadListItems(id, box);
    }

    document.querySelectorAll('.list-del').forEach((btn) => {
      btn.onclick = async () => {
        if (!(await confirmDialog(`删除列表「${btn.dataset.name}」？`, '列表及其条目会一并删除，无法恢复。'))) return;
        try {
          await api(`/users/me/lists/${btn.dataset.id}`, { method: 'DELETE' });
          toast('列表已删除');
          state.userLists.data = null;
          loadLists();
        } catch (e) {
          toast(e.message, true);
        }
      };
    });

    document.querySelectorAll('.list-add').forEach((btn) => {
      btn.onclick = () => addItemDialog(btn.dataset.id, btn.dataset.name);
    });
  } catch (e) {
    showError($('#lists-body'), e, loadLists);
  }
}

/** 列表条目的选中集合（按列表 id 分开存，切换列表互不影响） */
function listSel(id) {
  if (!state.lists.sel) state.lists.sel = {};
  if (!state.lists.sel[id]) state.lists.sel[id] = new Set();
  return state.lists.sel[id];
}

/** 展开某个自定义列表的条目（供「展开」按钮与错误态重试共用） */
async function loadListItems(id, box) {
  box.innerHTML = loadingBox();
  try {
    const [mv, sh] = await Promise.all([
      api(`/users/me/lists/${id}/items/movies`),
      api(`/users/me/lists/${id}/items/shows`),
    ]);
    const items = [...(mv.data || []), ...(sh.data || [])].filter(Boolean);
    if (!items.length) {
      box.innerHTML = emptyState('列表为空', { icon: 'inbox' });
      return;
    }

    const sel = listSel(id);
    const segOf = (it) => (it.movie ? 'movies' : 'shows');
    const objOf = (it) => it.movie || it.show || {};
    const keyOf = (it) => {
      const o = objOf(it);
      return `${segOf(it)}:${o.ids?.trakt || o.ids?.slug || ''}`;
    };
    const byKey = new Map(items.map((it) => [keyOf(it), it]));
    const allChecked = items.every((it) => sel.has(keyOf(it)));

    const gridHtml = `<div class="media-grid">${items
      .map((it) => {
        const m = objOf(it);
        const art = it.movie ? 'movie' : 'show';
        const key = keyOf(it);
        return mediaCard(
          art,
          m.ids,
          m.title,
          m.year ? `<span class="media-date">${esc(String(m.year))}</span>` : '',
          `<div class="media-actions">
            <label class="media-pick"><input type="checkbox" class="checkbox li-check" data-key="${esc(key)}" aria-label="选择 ${esc(m.title || '该条目')}"${sel.has(key) ? ' checked' : ''}> 选择</label>
            <button class="btn btn-sm btn-danger li-rm" data-key="${esc(key)}">移除</button>
          </div>`,
          '',
          '',
          { badge: it.movie ? '电影' : '剧集' }
        );
      })
      .join('')}</div>`;

    box.innerHTML = `
      <div class="bulk-bar" id="li-bulk-${id}"${sel.size ? '' : ' hidden'}>
        <span id="li-sel-${id}">已选 ${sel.size} 项</span>
        <div style="flex:1"></div>
        <button class="btn btn-sm" data-li-clear="${id}">取消选择</button>
        <button class="btn btn-sm btn-danger" data-li-del="${id}">移出该列表</button>
      </div>
      <div class="hint-bar" style="padding:8px 12px">
        <label class="media-pick"><input type="checkbox" class="checkbox" id="li-all-${id}"${allChecked ? ' checked' : ''}> 全选</label>
      </div>
      ${gridHtml}`;

    bindRowClick(box);
    localize(box);

    const syncBulk = () => {
      const bar = $(`#li-bulk-${id}`);
      if (bar) bar.hidden = sel.size === 0;
      const n = $(`#li-sel-${id}`);
      if (n) n.textContent = `已选 ${sel.size} 项`;
      const all = $(`#li-all-${id}`);
      if (all) {
        all.checked = items.every((it) => sel.has(keyOf(it)));
        all.indeterminate = sel.size > 0 && !all.checked;
      }
    };

    box.querySelectorAll('.li-check').forEach((cb) => {
      cb.onchange = () => {
        const key = cb.dataset.key;
        if (cb.checked) sel.add(key);
        else sel.delete(key);
        syncBulk();
      };
    });

    const allBox = $(`#li-all-${id}`);
    if (allBox) {
      allBox.onchange = () => {
        if (allBox.checked) items.forEach((it) => sel.add(keyOf(it)));
        else sel.clear();
        loadListItems(id, box);
      };
    }

    box.querySelectorAll('[data-li-clear]').forEach((b) => {
      b.onclick = () => {
        sel.clear();
        loadListItems(id, box);
      };
    });

    box.querySelectorAll('[data-li-del]').forEach((b) => {
      b.onclick = () => removeListItems(id, [...sel]);
    });

    box.querySelectorAll('.li-rm').forEach((b) => {
      b.onclick = async () => {
        const it = byKey.get(b.dataset.key);
        if (!it) return;
        const m = objOf(it);
        if (!(await confirmRemove(m.title || '该条目', '该列表'))) return;
        try {
          const seg = segOf(it);
          const ids = m.ids;
          await api(`/users/me/lists/${id}/items/remove`, { method: 'POST', body: { [seg]: [{ ids }] } });
          sel.delete(keyOf(it));
          undoToast('已从列表移除', async () => {
            await api(`/users/me/lists/${id}/items`, { method: 'POST', body: { [seg]: [{ ids }] } });
            toast('已恢复');
            await loadListItems(id, $(`#list-items-${id}`));
          });
          await loadListItems(id, box);
        } catch (e) {
          toast(e.message, true);
        }
      };
    });

    syncBulk();
  } catch (e) {
    showError(box, e, () => loadListItems(id, box));
  }
}

/** 批量从自定义列表移除：一次请求带上全部条目（Trakt 支持数组），失败即整体报错 */
async function removeListItems(id, keys) {
  if (!keys.length) return;
  if (!(await confirmDialog(`从列表移除 ${keys.length} 项？`, '会同步到你的 Trakt 账号；操作后可在提示条里撤销。'))) return;
  const groups = { movies: [], shows: [] };
  for (const key of keys) {
    const [seg, ref] = key.split(':');
    if (!groups[seg] || !ref) continue;
    groups[seg].push({ ids: /^\d+$/.test(ref) ? { trakt: Number(ref) } : { slug: ref } });
  }
  const total = groups.movies.length + groups.shows.length;
  if (!total) return;
  try {
    await api(`/users/me/lists/${id}/items/remove`, { method: 'POST', body: groups });
    listSel(id).clear();
    undoToast(`已移除 ${total} 项`, async () => {
      await api(`/users/me/lists/${id}/items`, { method: 'POST', body: groups });
      toast('已恢复');
      await loadListItems(id, $(`#list-items-${id}`));
    });
    await loadListItems(id, $(`#list-items-${id}`));
  } catch (e) {
    toast(e.message, true);
  }
}

function createListDialog() {
  openModal(`
    <h3>新建列表</h3>
    <div class="field"><label>名称</label><input id="nl-name" type="text" placeholder="例如：2026 待看" /></div>
    <div class="field"><label>描述（可选）</label><input id="nl-desc" type="text" placeholder="一句话说明" /></div>
    <div class="field"><label>隐私</label>
      <select id="nl-privacy">
        <option value="private">私有</option>
        <option value="public">公开</option>
      </select>
    </div>
    <div class="modal-actions">
      <button class="btn" data-close>取消</button>
      <button class="btn btn-primary" id="nl-ok">创建</button>
    </div>`);

  $('#nl-ok').onclick = async () => {
    const name = $('#nl-name').value.trim();
    if (!name) return toast('请输入名称', true);
    try {
      await api('/users/me/lists', {
        method: 'POST',
        body: { name, description: $('#nl-desc').value.trim(), privacy: $('#nl-privacy').value, display_numbers: true, allow_comments: false },
      });
      closeModal();
      toast('列表已创建');
      loadLists();
    } catch (e) {
      toast(e.message, true);
    }
  };
}

function addItemDialog(listId, listName) {
  openModal(`
    <h3>向「${esc(listName)}」添加</h3>
    <div class="field"><label>搜索电影或剧集</label>
      <div class="toolbar"><input id="ai-q" type="text" placeholder="输入标题后回车" style="flex:1" />
      <button class="btn btn-sm" id="ai-go">搜索</button></div>
    </div>
    <div id="ai-results" style="max-height:260px;overflow:auto"></div>
    <div class="modal-actions"><button class="btn" data-close>关闭</button></div>`);

  const search = async () => {
    const q = $('#ai-q').value.trim();
    if (!q) return;
    const box = $('#ai-results');
    box.innerHTML = loadingBox();
    try {
      const r = await api('/search/movie,show', { query: { query: q, limit: 12 } });
      const rows = (r.data || []).filter(Boolean);
      if (!rows.length) {
        box.innerHTML = emptyState('没有匹配结果', { icon: 'search' });
        return;
      }
      box.innerHTML = rows
        .map((it, i) => {
          const m = it.movie || it.show || {};
          return `<div class="list-row" style="padding:9px 4px">
            <div class="list-main"><div class="list-title" ${locAttrs(it.type, m.ids)}>${esc(m.title)}</div>
            <div class="list-sub">${esc(m.year || '')} · ${it.type === 'movie' ? '电影' : '剧集'}</div></div>
            <button class="btn btn-sm ai-add" data-i="${i}">加入</button>
          </div>`;
        })
        .join('');
      localize(box);
      document.querySelectorAll('.ai-add').forEach((b) => {
        b.onclick = async () => {
          const it = rows[Number(b.dataset.i)];
          const key = it.type === 'movie' ? 'movies' : 'shows';
          const ids = (it.movie || it.show).ids;
          try {
            await api(`/users/me/lists/${listId}/items`, { method: 'POST', body: { [key]: [{ ids }] } });
            toast('已加入列表');
            b.textContent = '已加入';
            b.disabled = true;
          } catch (e) {
            toast(e.message, true);
          }
        };
      });
    } catch (e) {
      showError(box, e, search);
    }
  };
  $('#ai-go').onclick = search;
  $('#ai-q').onkeydown = (e) => e.key === 'Enter' && search();
  $('#ai-q').focus();
}

/* ───────── 设置 ───────── */

/** 设置卡片头：图标 + 标题 + 一行说明，五张卡共用同一结构 */
const settingsHead = (icon, title, sub) =>
  `<div class="settings-head"><span class="settings-ic">${icon}</span><div><h2>${title}</h2><p>${sub}</p></div></div>`;

/** 运行状态的一行：左标签右数值，数值由各自的 id 填充 */
const davRow = (label, id, init = '—') =>
  `<div class="dav-row"><span class="dav-row-label">${label}</span><span class="dav-row-value" id="${id}">${init}</span></div>`;

PAGES.settings = async () => {
  const bg = bgPref();
  const mode = themeMode();
  $('#view').innerHTML =
    head('设置', '外观、媒体来源与数据备份', '') +
    `<div class="settings">
    <section class="card settings-card">
      ${settingsHead(ICON.palette, '外观与语言', '主题、语言与全局背景')}
      <div class="settings-row">
        <div>
          <div class="settings-name">主题</div>
          <div class="settings-hint">跟随系统或固定深浅色</div>
        </div>
        <div class="settings-ctl">
          <div class="seg" id="theme-seg">
            ${['auto', 'dark', 'light']
              .map(
                (k) =>
                  `<button type="button" data-theme-opt="${k}" class="${mode === k ? 'active' : ''}">${THEME_ICON[k]}${THEME_LABEL[k]}</button>`
              )
              .join('')}
          </div>
        </div>
      </div>
      <div class="settings-row">
        <div>
          <div class="settings-name">语言</div>
          <div class="settings-hint">界面与影视信息共用一套，切换后整页刷新</div>
        </div>
        <div class="settings-ctl">
          <div class="seg" id="lang-seg"></div>
        </div>
      </div>
      <div id="lang-status" class="settings-status"></div>
      <div class="settings-row">
        <div>
          <div class="settings-name">沉浸背景</div>
          <div class="settings-hint">影视封面轮播与暗度</div>
        </div>
        <div class="settings-ctl">
          <select id="bg-source">
            ${Object.keys(BG_SOURCES)
              .map((k) => `<option value="${k}"${bg.source === k ? ' selected' : ''}>${bgLabel(k)}</option>`)
              .join('')}
          </select>
          <select id="bg-dim">
            ${Object.keys(BG_DIMS)
              .map(
                (k) =>
                  `<option value="${k}"${bg.dim === k ? ' selected' : ''}>${isEn() ? 'Dim: ' : '遮罩：'}${bgDimLabel(k)}</option>`
              )
              .join('')}
          </select>
        </div>
      </div>
      <div id="bg-status" class="settings-status"></div>
    </section>

    <section class="card settings-card">
      ${settingsHead(ICON.key, '媒体数据源', '影视标题、简介与高清剧照')}
      <div class="settings-row" style="display:block">
        <div class="settings-hint" style="max-width:none">
          Key 仅保存在服务端。可在 themoviedb.org 免费申请。
        </div>
        <div class="toolbar" style="margin-top:12px">
          <input id="tmdb-key" type="text" placeholder="粘贴 v3 key（32 位）或 v4 Read Access Token" style="flex:1;min-width:260px" />
          <button class="btn btn-primary" id="tmdb-save">保存并校验</button>
          <button class="btn" id="tmdb-clear">清除</button>
        </div>
        <div id="tmdb-status" class="settings-status" style="margin-top:10px"></div>
      </div>
    </section>

    <section class="card settings-card">
      ${settingsHead(ICON.database, '数据备份与恢复', '版本化 JSON，只含你的观影数据，不含任何凭据')}
      <div class="settings-hint" style="max-width:none">
        ${isEn()
          ? 'Backups include <b>watch history, ratings, watchlist, favorites, custom lists (with items) and display language</b>. If pagination is incomplete, the preview says so. Restoring <b>writes to your Trakt account</b>: existing items are skipped, rating conflicts overwritten, failures reported separately.'
          : '备份包含<b>观看历史、评分、待看清单、收藏、自定义列表（含条目）和显示语言</b>；分页拉不全时会在预览里如实提示。恢复会<b>写入你的 Trakt 账号</b>：已存在的跳过、评分冲突覆盖、失败部分单独报告。'}
      </div>
      <div class="settings-foot">
        <button class="btn" id="backup-preview">查看备份范围</button>
        <button class="btn btn-primary" id="backup-download">下载完整备份</button>
        <button class="btn" id="restore-pick">从备份文件恢复…</button>
        <input id="restore-file" type="file" accept=".json,application/json" hidden />
      </div>
      <div id="backup-status" class="settings-status" style="margin-top:10px"></div>
    </section>

    <section class="card settings-card dav-card">
      ${settingsHead(ICON.cloud, 'WebDAV 云备份', '填一个网盘 / NAS 目录（坚果云、Nextcloud、群晖），按计划自动上传并只保留最近 N 份')}
      <div class="settings-hint dav-card-hint">
        ${isEn()
          ? 'The password stays on the server: never in backups, never sent to the browser. Schedules use <b>your browser timezone</b>.'
          : '密码只保存在服务端，不会出现在备份文件里，也不会下发到浏览器；排程按<b>你的浏览器时区</b>折算。'}
      </div>
      <div class="dav-toggle-row">
        <div>
          <div class="dav-toggle-label">启用自动备份</div>
          <div class="dav-toggle-hint" id="dav-enabled-hint">未启用 · 保存后可手动备份</div>
        </div>
        <label class="switch" aria-label="启用自动备份">
          <input id="dav-enabled" type="checkbox" />
          <span class="switch-track"></span>
        </label>
      </div>
      <div class="dav-grid">
        <div class="dav-config">
          <div class="dav-block-title">连接</div>
          <div class="dav-form">
            <div class="dav-field"><label>服务器地址</label>
              <input class="dav-input" id="dav-url" type="text" placeholder="https://example.com" autocomplete="off" spellcheck="false" />
            </div>
            <div class="dav-field"><label>备份路径</label>
              <input class="dav-input" id="dav-path" type="text" placeholder="/Trakt" autocomplete="off" spellcheck="false" />
              <div class="dav-field-hint">留空则存到根目录，首次备份会自动创建子目录</div>
            </div>
            <div class="dav-field"><label>用户名</label><input class="dav-input" id="dav-user" type="text" autocomplete="off" /></div>
            <div class="dav-field"><label>密码 / 应用专用密码</label><input class="dav-input" id="dav-pass" type="password" autocomplete="new-password" placeholder="已保存则留空" /></div>
          </div>

          <div class="dav-block-title">备份计划</div>
          <div class="dav-form">
            <div class="dav-field"><label>备份周期</label>
              <select class="dav-input" id="dav-freq">
                <option value="daily">每天</option>
                <option value="weekly">每周</option>
                <option value="monthly">每月</option>
              </select>
            </div>
            <div class="dav-field"><label>执行时间（本地时区）</label>
              <input class="dav-input" id="dav-time" type="time" step="60" autocomplete="off" />
            </div>
            <div class="dav-field" id="dav-week-wrap" style="display:none"><label>星期</label>
              <select class="dav-input" id="dav-week">
                <option value="1">周一</option><option value="2">周二</option><option value="3">周三</option>
                <option value="4">周四</option><option value="5">周五</option><option value="6">周六</option>
                <option value="0">周日</option>
              </select>
            </div>
            <div class="dav-field" id="dav-day-wrap" style="display:none"><label>每月几号</label>
              <select class="dav-input" id="dav-day">
                ${Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}">${i + 1} 号</option>`).join('')}
              </select>
            </div>
            <div class="dav-field"><label>保留份数</label><input class="dav-input" id="dav-keep" type="number" min="1" max="100" value="10" /></div>
          </div>
          <div class="dav-actions">
            <button class="btn" id="dav-test">测试连接</button>
            <button class="btn btn-primary" id="dav-save">保存设置</button>
          </div>
          <div id="dav-status" class="note" style="margin-top:12px"></div>
        </div>

        <div class="dav-summary">
          <div class="dav-block-title">运行状态</div>
          <div class="dav-rows">
            ${davRow('上次备份', 'dav-last-time', '尚无记录')}
            ${davRow('备份结果', 'dav-last-result')}
            ${davRow('备份文件', 'dav-last-file')}
            ${davRow('下次备份', 'dav-next-time')}
            ${davRow('备份数量', 'dav-counts')}
            ${davRow('当前计划', 'dav-plan')}
          </div>
          <div class="dav-block-title" style="margin-top:18px">手动操作</div>
          <button class="btn btn-primary dav-primary-wide" id="dav-run">立即备份一次</button>
          <div class="dav-secondary">
            <button class="btn" id="dav-files-btn">查看远端备份</button>
            <button class="btn" id="dav-download-btn">下载本地备份</button>
            <button class="btn" id="dav-preview-btn">查看备份范围</button>
            <button class="btn" id="dav-restore-btn">从文件恢复</button>
          </div>
        </div>
      </div>
    </section>
    <div id="dav-files"></div>

    <section class="card settings-card">
      ${settingsHead(ICON.info, '运行状态', '当前生效的数据源与缓存策略')}
      <div id="provider-info" class="settings-hint" style="max-width:none;font-size:var(--fs-sm);line-height:1.9">…</div>
    </section>
    </div>`;

  const paint = (s) => {
    const t = s.tmdb || {};
    $('#tmdb-status').innerHTML = t.configured
      ? isEn()
        ? `Configured: <b>${esc(t.preview || '')}</b> (${t.source === 'env' ? 'environment variable' : 'saved'})`
        : `已配置：<b>${esc(t.preview || '')}</b>（${t.source === 'env' ? '环境变量' : '已保存'}）`
      : isEn()
        ? 'Not configured: falling back to <b>Trakt</b> data, so some metadata may be incomplete.'
        : '未配置：使用 <b>Trakt</b> 数据，中文信息可能不完整。';

    // 语言只有一个来源：服务端的 cfg:tmdb_lang。界面与影视信息共用这一套，
    // 菜单里的中文/English 也就是 TMDB 的 zh-CN/en-US，切一次两边同时变。
    const current = s.lang || getLang();
    const opts = LANGS.slice();
    if (!opts.some(([code]) => code === current)) opts.push([current, current]);
    const locked = s.langSource === 'env';
    $('#lang-seg').innerHTML = opts
      .map(
        ([code, label]) =>
          `<button type="button" data-lang-opt="${esc(code)}" class="${code === current ? 'active' : ''}"${locked ? ' disabled' : ''}>${esc(label)}</button>`
      )
      .join('');
    $('#lang-status').textContent = locked
      ? isEn()
        ? `Fixed by the server (TMDB_LANG): ${current}`
        : `由服务端 TMDB_LANG 固定：${current}`
      : isEn()
        ? `Current: ${current}`
        : `当前：${current}`;
    $('#provider-info').innerHTML = isEn()
      ? `<div>Source: <b>${s.provider === 'tmdb' ? 'TMDB' : 'Trakt'}</b> · same-origin image proxy · 30-day cache</div>`
      : `<div>数据源：<b>${s.provider === 'tmdb' ? 'TMDB' : 'Trakt'}</b> · 同源图片代理 · 缓存 30 天</div>`;
  };

  const load = async () => {
    try {
      const r = await fetch('/api/settings', { headers: apiHeaders() });
      const j = await r.json();
      paint(j);
    } catch (e) {
      $('#tmdb-status').textContent = '读取设置失败：' + e.message;
    }
  };
  await load();

  $('#tmdb-save').onclick = async () => {
    const key = $('#tmdb-key').value.trim();
    if (!key) return toast('请先粘贴 key', true);
    const btn = $('#tmdb-save');
    btn.disabled = true;
    btn.textContent = '校验中…';
    try {
      const r = await fetch('/api/settings', {
        method: 'POST',
        headers: apiHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tmdbKey: key }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.message || '保存失败');
      toast('TMDB 已启用');
      $('#tmdb-key').value = '';
      await load();
    } catch (e) {
      $('#tmdb-status').innerHTML = `<span style="color:#ff6b70">${esc(e.message)}</span>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '保存并校验';
    }
  };

  // ── 外观：主题 / 沉浸背景（即时生效，不用保存按钮） ──
  document.querySelectorAll('#theme-seg [data-theme-opt]').forEach((b) => {
    b.onclick = () => {
      setTheme(b.dataset.themeOpt);
      document.querySelectorAll('#theme-seg [data-theme-opt]').forEach((x) => {
        x.classList.toggle('active', x === b);
      });
      const btn = $('#btn-theme');
      if (btn) btn.innerHTML = THEME_ICON[themeMode()];
    };
  });

  const bgNow = bgPref();
  $('#bg-status').textContent =
    bgNow.source === 'off'
      ? isEn()
        ? 'Off — the page uses a solid background.'
        : '当前已关闭，页面使用纯色背景。'
      : isEn()
        ? `Source “${bgLabel(bgNow.source)}” · dim “${bgDimLabel(bgNow.dim)}”, artwork rotates every 45s.`
        : `当前来源「${BG_SOURCES[bgNow.source]}」· 遮罩「${BG_DIMS[bgNow.dim]}」，每 45 秒自动切换封面。`;

  $('#bg-source').onchange = async (e) => {
    const next = bgSavePref({ source: e.target.value });
    const st = $('#bg-status');
    if (next.source === 'off') {
      st.textContent = isEn() ? 'Off — the page uses a solid background.' : '已关闭，页面使用纯色背景。';
      return;
    }
    st.textContent = isEn() ? 'Fetching artwork…' : '正在取图…';
    const items = await bgFetch(next.source).catch(() => []);
    st.textContent = items.length
      ? isEn()
        ? `Enabled “${bgLabel(next.source)}”: rotating ${items.length} artworks every 45s.`
        : `已启用「${BG_SOURCES[next.source]}」：${items.length} 张封面轮播，每 45 秒切换。`
      : isEn()
        ? 'No artwork available for this source — try another one.'
        : '暂时取不到封面：该来源下没有可用条目，换个来源试试。';
  };
  $('#bg-dim').onchange = (e) => {
    bgSavePref({ dim: e.target.value });
  };

  $('#lang-seg').onclick = async (e) => {
    const btn = e.target.closest('[data-lang-opt]');
    if (!btn || btn.disabled || btn.classList.contains('active')) return;
    const lang = btn.dataset.langOpt;
    btn.disabled = true;
    try {
      const r = await fetch('/api/settings', {
        method: 'POST',
        headers: apiHeaders({ 'content-type': 'application/json' }),
        body: JSON.stringify({ tmdbLang: lang }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.message || '保存失败');
      setLang(lang);
      clearLangCaches();
      state.dirty = true;
      location.reload();
    } catch (err) {
      btn.disabled = false;
      toast(err.message, true);
    }
  };

  $('#tmdb-clear').onclick = async () => {
    await fetch('/api/settings', {
      method: 'POST',
      headers: apiHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ tmdbKey: '' }),
    });
    toast('已清除，回到 Trakt 数据源');
    await load();
  };

  // ── 备份 / 恢复 ──
  const apiJson = async (path, opts = {}) => {
    const r = await fetch(path, {
      method: opts.method || 'GET',
      headers: apiHeaders(opts.body ? { 'content-type': 'application/json' } : {}),
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    let j = null;
    try {
      j = await r.json();
    } catch {
      throw new Error(`服务端返回异常（HTTP ${r.status}）`);
    }
    if (!r.ok || j.ok === false) throw new Error(j.message || j.error || `HTTP ${r.status}`);
    return j;
  };

  const backupCounts = (c = {}) =>
    `<table style="margin:12px 0">
      <tbody>
        ${[
          ['观看历史', c.history],
          ['评分', c.ratings],
          ['待看清单', c.watchlist],
          ['收藏', c.favorites],
          ['自定义列表', c.lists],
          ['列表条目', c.listItems],
        ]
          .map(([k, v]) => `<tr><td style="padding:8px 12px;color:var(--muted)">${k}</td><td style="padding:8px 12px;text-align:right"><b>${num(v)}</b></td></tr>`)
          .join('')}
      </tbody>
    </table>`;

  const downloadBackup = async (btn) => {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '生成中…';
    try {
      const r = await fetch('/api/backup', { headers: apiHeaders() });
      if (!r.ok) {
        let j = {};
        try {
          j = await r.json();
        } catch {}
        throw new Error(j.message || `生成备份失败（HTTP ${r.status}）`);
      }
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `trakt-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      $('#backup-status').textContent = `备份已生成并开始下载（${fmtDateTime(new Date().toISOString())}）。`;
    } catch (e) {
      $('#backup-status').innerHTML = `<span style="color:#ff6b70">${esc(e.message)}</span>`;
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  };

  $('#backup-download').onclick = (e) => downloadBackup(e.currentTarget);

  $('#backup-preview').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '统计中…';
    try {
      const meta = await apiJson('/api/backup?preview=1');
      openModal(`<h3>备份范围预览</h3>
        <p class="note">账号「${esc(meta.user?.username || '')}」 · 备份不含任何令牌 / key / 密码。</p>
        ${backupCounts(meta.counts)}
        ${
          Object.values(meta.truncated || {}).some(Boolean)
            ? `<p class="note" style="color:#ffb454">注意：部分数据超过单次拉取上限，备份会被标记为不完整：<b>${esc(
                Object.entries(meta.truncated)
                  .filter(([, v]) => v)
                  .map(([k]) => k)
                  .join('、')
              )}</b>。建议分批处理或稍后重试。</p>`
            : '<p class="note">所有分页数据均完整拉取。</p>'
        }
        ${(meta.warnings || []).map((w) => `<p class="note" style="color:#ffb454">${esc(w)}</p>`).join('')}
        <div class="modal-actions"><button class="btn" data-close>关闭</button>
        <button class="btn btn-primary" id="bprev-dl">下载完整备份</button></div>`);
      $('#bprev-dl').onclick = (ev) => downloadBackup(ev.currentTarget);
    } catch (err) {
      $('#backup-status').innerHTML = `<span style="color:#ff6b70">${esc(err.message)}</span>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '查看备份范围';
    }
  };

  const SCOPE_LABELS = {
    history: '观看历史',
    ratings: '评分',
    watchlist: '待看清单',
    favorites: '收藏',
    lists: '自定义列表',
    settings: '显示语言',
  };

  const previewRow = (key, s) => {
    const bits = [
      s.new !== undefined ? `新增 ${num(s.new)}` : '',
      s.newLists !== undefined ? `新列表 ${num(s.newLists)} / 新条目 ${num(s.newItems)}` : '',
      s.duplicate ? `已存在 ${num(s.duplicate)}` : '',
      s.existing ? `已存在 ${num(s.existing)}` : '',
      s.existingItems ? `列表已有 ${num(s.existingItems)}` : '',
      s.unchanged ? `分数相同 ${num(s.unchanged)}` : '',
      s.conflict ? `冲突覆盖 ${num(s.conflict)}` : '',
      s.invalid ? `无效 ${num(s.invalid)}` : '',
      s.invalidItems ? `无效条目 ${num(s.invalidItems)}` : '',
    ].filter(Boolean);
    return `<tr>
      <td style="padding:8px 10px"><input class="checkbox rs" type="checkbox" data-s="${key}" checked /></td>
      <td style="padding:8px 10px">${SCOPE_LABELS[key]}</td>
      <td style="padding:8px 10px">${bits.length ? bits.join(' · ') : '无变化'}</td>
    </tr>`;
  };

  const openRestoreResult = (res, scopes) => {
    const s = res.report.sections;
    const rows = scopes
      .map((k) => {
        const x = s[k];
        if (!x) return '';
        const bits = [
          x.added !== undefined ? `写入 ${num(x.added)}` : '',
          x.applied !== undefined ? `应用 ${num(x.applied)}` : '',
          x.listsCreated ? `新建列表 ${num(x.listsCreated)}` : '',
          x.listsKept ? `沿用列表 ${num(x.listsKept)}` : '',
          x.existing ? `上游已存在 ${num(x.existing)}` : '',
          x.skipped ? `跳过 ${num(x.skipped)}` : '',
          x.invalid ? `无效 ${num(x.invalid)}` : '',
          x.failed ? `失败 ${num(x.failed)}` : '',
        ].filter(Boolean);
        return `<tr><td style="padding:8px 10px">${SCOPE_LABELS[k]}</td><td style="padding:8px 10px">${bits.join(' · ') || '无变化'}</td></tr>`;
      })
      .join('');
    const errs = (res.report.errors || []).slice(0, 10);
    openModal(`<h3>${res.ok ? '恢复完成' : '恢复完成（有失败项）'}</h3>
      <table style="margin:12px 0"><tbody>${rows}</tbody></table>
      ${res.partial ? `<p class="note" style="color:#ffb454">部分条目写入失败，Trakt 不支持回滚；上面如实列出失败项，未受影响的范围已完成。${errs.length ? '<br/>' + errs.map(esc).join('<br/>') : ''}</p>` : '<p class="note">已按上游响应核对写入计数，全部成功。</p>'}
      <div class="modal-actions"><button class="btn btn-primary" data-close>完成</button></div>`);
    state.dirty = true;
    toast(res.ok ? '恢复已完成' : '恢复完成，但有部分失败项', res.ok ? {} : true);
  };

  const openRestorePreview = async (backup, sourceLabel) => {
    const res = await apiJson('/api/restore', { method: 'POST', body: { backup, dryRun: true } });
    const keys = res.scopes.filter((k) => res.preview.sections[k]);
    if (!keys.length) {
      toast('备份里没有可恢复的范围');
      return;
    }
    const warnHtml = res.warnings.map((w) => `<p class="note" style="color:#ffb454">${esc(w)}</p>`).join('');
    openModal(`<h3>恢复预览</h3>
      <p class="note">来源：${esc(sourceLabel)} · 备份时间 ${esc(fmtDateTime(res.backup.createdAt))} · 账号「${esc(res.backup.user?.username || '')}」。<br/>
        只写入勾选范围；已存在的跳过，评分不同会覆盖为备份里的分数。Trakt 不支持回滚，请确认后再执行。</p>
      ${warnHtml}
      <table style="margin:12px 0"><tbody>
        ${keys.map((k) => previewRow(k, res.preview.sections[k])).join('')}
      </tbody></table>
      <p class="note">合计：新增 ${num(res.preview.totals.new)} · 跳过 ${num(res.preview.totals.skip)} · 冲突覆盖 ${num(res.preview.totals.conflict)} · 无效 ${num(res.preview.totals.invalid)}</p>
      <div class="modal-actions"><button class="btn" data-close>取消</button>
      <button class="btn btn-danger" id="rs-go">确认恢复</button></div>`);

    $('#rs-go').onclick = async (ev) => {
      const picked = [...document.querySelectorAll('.rs')].filter((c) => c.checked).map((c) => c.dataset.s);
      if (!picked.length) return toast('请至少选择一个恢复范围', true);
      const labels = picked.map((k) => SCOPE_LABELS[k]).join('、');
      const yes = await confirmDialog('确认执行恢复？', `将把 ${labels} 写入你的 Trakt 账号。已存在的条目会跳过，评分冲突会被覆盖；Trakt 不支持回滚。`);
      if (!yes) return;
      const btn = ev.currentTarget;
      btn.disabled = true;
      btn.textContent = '恢复中…';
      try {
        const out = await apiJson('/api/restore', { method: 'POST', body: { backup, dryRun: false, confirm: true, scopes: picked } });
        openRestoreResult(out, picked);
      } catch (e) {
        toast(e.message, true);
        btn.disabled = false;
        btn.textContent = '确认恢复';
      }
    };
  };

  $('#restore-pick').onclick = () => $('#restore-file').click();
  $('#restore-file').onchange = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 16 * 1024 * 1024) return toast('备份文件超过 16 MB，无法用于恢复', true);
    try {
      const backup = JSON.parse(await file.text());
      await openRestorePreview(backup, `本地文件「${file.name}」`);
    } catch (err) {
      toast(`备份文件读取失败：${err.message}`, true);
    }
  };

  // ── WebDAV 自动备份 ──
  const DAV_FREQ_LABEL = isEn()
    ? { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' }
    : { daily: '每天', weekly: '每周', monthly: '每月' };
  const nowHm = () => {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };
  /** 服务端只存 hour / minute 两个数，这里拼成 input[type=time] 要的 "HH:MM" */
  const davTimeOf = (c = {}) => {
    if (c.hour === undefined && c.minute === undefined) return nowHm();
    const h = Math.max(0, Math.min(23, Math.round(Number(c.hour ?? 0))));
    const m = Math.max(0, Math.min(59, Math.round(Number(c.minute ?? 0))));
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };
  /** "HH:MM" → { hour, minute }；空值或非法值回落到当前时刻 */
  const parseDavTime = (v) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
    if (!m) {
      const [h, mi] = nowHm().split(':');
      return { hour: Number(h), minute: Number(mi) };
    }
    return { hour: Math.max(0, Math.min(23, Number(m[1]))), minute: Math.max(0, Math.min(59, Number(m[2]))) };
  };

  const davAgo = (ms) => {
    const diff = Date.now() - Number(ms || 0);
    if (!Number.isFinite(diff) || diff < 0) return '';
    const min = Math.floor(diff / 60000);
    const en = isEn();
    if (min < 1) return en ? 'just now' : '刚刚';
    if (min < 60) return en ? `${min}m ago` : `${min} 分钟前`;
    const h = Math.floor(min / 60);
    if (h < 24) return en ? `${h}h ago` : `${h} 小时前`;
    const d = Math.floor(h / 24);
    if (d < 30) return en ? `${d}d ago` : `${d} 天前`;
    const mo = Math.floor(d / 30);
    if (en) return mo < 12 ? `${mo}mo ago` : `${Math.floor(mo / 12)}y ago`;
    return mo < 12 ? `${mo} 个月前` : `${Math.floor(mo / 12)} 年前`;
  };

  const paintDavHint = () => {
    const en = isEn();
    const freq = DAV_FREQ_LABEL[$('#dav-freq').value] || (en ? 'Daily' : '每天');
    const { hour, minute } = parseDavTime($('#dav-time').value);
    const time = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    const keep = Math.max(1, Math.min(100, Number($('#dav-keep').value || 10)));
    $('#dav-enabled-hint').textContent = $('#dav-enabled').checked
      ? en
        ? `Enabled · runs ${freq.toLowerCase()} at ${time}`
        : `已启用 · ${freq} ${time} 自动执行备份`
      : en
        ? 'Disabled · you can still back up manually'
        : '未启用 · 保存后可手动备份';
    $('#dav-plan').textContent = en ? `${freq} at ${time} · keep ${keep}` : `${freq} ${time} · 保留 ${keep} 份`;
  };

  const paintDav = (c = {}) => {
    const davUrl = splitDav(c.url);
    $('#dav-url').value = davUrl.base;
    $('#dav-path').value = davUrl.path;
    $('#dav-user').value = c.username || '';
    $('#dav-pass').value = '';
    $('#dav-freq').value = c.frequency || 'daily';
    // 从未配置过时，默认就是「此刻」（用户添加这项设置的时刻），不是服务端的 03:00 兜底值
    $('#dav-time').value = c.configured === false ? nowHm() : davTimeOf(c);
    $('#dav-week').value = String(c.weekday ?? 1);
    $('#dav-day').value = String(c.day ?? 1);
    $('#dav-keep').value = c.keep ?? 10;
    $('#dav-enabled').checked = Boolean(c.enabled);
    $('#dav-week-wrap').style.display = (c.frequency || 'daily') === 'weekly' ? '' : 'none';
    $('#dav-day-wrap').style.display = (c.frequency || 'daily') === 'monthly' ? '' : 'none';
    paintDavHint();

    const events = [];
    if (Number(c.lastRunAt)) events.push({ at: Number(c.lastRunAt), kind: '定时', res: c.lastResult });
    if (Number(c.lastManualAt)) events.push({ at: Number(c.lastManualAt), kind: '手动', res: c.lastManualResult });
    events.sort((a, b) => b.at - a.at);
    const latest = events[0];

    if (!c.configured && !latest) {
      $('#dav-last-time').textContent = '尚未配置';
      $('#dav-last-result').textContent = '—';
      $('#dav-last-file').textContent = '—';
      $('#dav-counts').textContent = '—';
    } else if (!latest) {
      $('#dav-last-time').textContent = '尚无记录';
      $('#dav-last-result').textContent = '—';
      $('#dav-last-file').textContent = '—';
      $('#dav-counts').textContent = '—';
    } else {
      $('#dav-last-time').innerHTML = `${esc(fmtDateTime(new Date(latest.at).toISOString()))}<span class="note" style="display:block;font-size:11px">${esc(davAgo(latest.at))} · ${esc(latest.kind)}</span>`;
      const res = latest.res;
      if (!res) {
        $('#dav-last-result').textContent = '—';
        $('#dav-last-file').textContent = '—';
        $('#dav-counts').textContent = '—';
      } else if (res.ok) {
        $('#dav-last-result').innerHTML = '<span class="dav-ok">成功</span><span class="note" style="display:block;font-size:11px">已备份到 WebDAV</span>';
        $('#dav-last-file').textContent = res.name || '—';
        $('#dav-counts').textContent = res.counts
          ? `历史 ${num(res.counts.history)} · 评分 ${num(res.counts.ratings)} · 列表 ${num(res.counts.lists)}`
          : '—';
      } else {
        $('#dav-last-result').innerHTML = `<span class="dav-bad">失败</span><span class="note" style="display:block;font-size:11px">${esc(res.message || '未知错误')}</span>`;
        $('#dav-last-file').textContent = '—';
        $('#dav-counts').textContent = '—';
      }
    }
    $('#dav-next-time').textContent = c.enabled && c.nextRunAt
      ? fmtDateTime(new Date(c.nextRunAt).toISOString())
      : c.enabled
        ? '保存后计算'
        : '未启用';
    $('#dav-status').textContent = '';
    $('#dav-files').innerHTML = '';
  };

  // 界面把「服务器地址 / 备份路径」拆成两栏，提交时再拼成完整 URL（老配置只有 url，读出来自动拆开）。
  // 末段才是备份目录，前面整段留给服务器地址——坚果云的根是 https://dav.jianguoyun.com/dav，
  // 如果把 /dav 挪进「备份路径」，用户会以为它多余而删掉，拼出来的地址就全错了。
  const splitDav = (raw) => {
    const s = String(raw || '').trim();
    if (!s) return { base: '', path: '' };
    try {
      const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
      const p = u.pathname.replace(/\/+$/, '');
      if (!p || p === '/') return { base: u.origin, path: '' };
      const cut = p.lastIndexOf('/');
      // 只有一段路径（https://dav.jianguoyun.com/dav）时整段都属于服务器地址
      if (cut <= 0) return { base: `${u.origin}${p}`, path: '' };
      return { base: `${u.origin}${p.slice(0, cut)}`, path: p.slice(cut) };
    } catch {
      return { base: s, path: '' };
    }
  };
  const joinDav = () => {
    const base = $('#dav-url').value.trim().replace(/\/+$/, '');
    if (!base) return '';
    let path = $('#dav-path').value.trim().replace(/\/+$/, '');
    if (path && !path.startsWith('/')) path = `/${path}`;
    return `${base}${path}`;
  };

  const davForm = () => ({
    url: joinDav(),
    username: $('#dav-user').value.trim(),
    ...($('#dav-pass').value ? { password: $('#dav-pass').value } : {}),
    enabled: $('#dav-enabled').checked,
    frequency: $('#dav-freq').value,
    ...parseDavTime($('#dav-time').value),
    weekday: Number($('#dav-week').value || 1),
    day: Number($('#dav-day').value || 1),
    keep: Number($('#dav-keep').value || 10),
    tz: -new Date().getTimezoneOffset(),
  });

  const saveDav = async (notify = true) => {
    const j = await apiJson('/api/backup/dav', { method: 'POST', body: davForm() });
    paintDav(j.config);
    $('#dav-status').innerHTML = '<span class="dav-ok">配置已保存</span>';
    if (notify) toast('WebDAV 配置已保存');
    return j.config;
  };

  $('#dav-freq').onchange = () => {
    const v = $('#dav-freq').value;
    $('#dav-week-wrap').style.display = v === 'weekly' ? '' : 'none';
    $('#dav-day-wrap').style.display = v === 'monthly' ? '' : 'none';
    paintDavHint();
  };
  $('#dav-time').oninput = paintDavHint;
  $('#dav-time').onchange = paintDavHint;
  $('#dav-keep').oninput = paintDavHint;
  $('#dav-enabled').onchange = paintDavHint;

  $('#dav-save').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await saveDav();
    } catch (err) {
      $('#dav-status').innerHTML = `<span class="dav-bad">${esc(err.message)}</span>`;
    } finally {
      btn.disabled = false;
    }
  };

  $('#dav-test').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '测试中…';
    try {
      const j = await apiJson('/api/backup/dav/test', { method: 'POST', body: davForm() });
      $('#dav-status').innerHTML = `<span class="dav-ok">${j.needsCreate ? '连接成功，目录不存在，首次备份时会自动创建' : '连接成功，目录可访问'}</span>`;
      toast('WebDAV 连接成功');
    } catch (err) {
      $('#dav-status').innerHTML = `<span class="dav-bad">${esc(err.message)}</span>`;
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '测试连接';
    }
  };

  /* 分段备份：每页单独一次请求，Worker 每次只发 1 个子请求。
     Workers 免费计划单次调用最多 50 个子请求，数据量大的账号一次拉不完，拆成多轮就能拉全。 */
  const DAV_CHUNK_PAGES = 200; // 单类数据最多 200 页（20000 条）

  /** 快速路径够不够用：探测历史条数与列表个数，估算会撞上限就改走分段 */
  const davNeedChunked = async () => {
    try {
      const [h, l] = await Promise.all([
        api('/sync/history', { query: { limit: 1, page: 1 } }),
        api('/users/me/lists', { query: { limit: 1, page: 1 } }),
      ]);
      const histPages = Math.min(Math.ceil(Number(h.pagination?.itemCount || 0) / 100), 18);
      const lists = Math.min(Number(l.pagination?.itemCount || 0), 100);
      // 快速路径固定开销：评分 4 页 + 待看 3 + 收藏 3 + 列表 1，每个列表条目再按 2 页估
      return histPages + 4 + 3 + 3 + 1 + lists * 2 > 28;
    } catch {
      return false; // 探测失败先走快速路径，真被截断了再降级
    }
  };

  /** 逐页拉全：每页一次独立请求，3 页并发，track 用来刷新进度 */
  const davPullAll = async (path, query, track, { limit = 100, maxPages = DAV_CHUNK_PAGES } = {}) => {
    const load = (page) => api(path, { query: { ...query, limit, page } });
    const first = await load(1);
    const rows = Array.isArray(first.data) ? first.data.slice() : [];
    const pageCount = Math.max(1, Number(first.pagination?.pageCount || 1));
    const total = Math.min(pageCount, maxPages);
    track(1, total);
    let page = 2;
    while (page <= total) {
      const wave = [];
      for (let i = 0; i < 3 && page <= total; i += 1, page += 1) wave.push(page);
      const got = await Promise.all(wave.map(load));
      for (const g of got) if (Array.isArray(g.data)) rows.push(...g.data);
      track(page - 1, total);
    }
    return { rows, truncated: pageCount > total };
  };

  /** 分段备份：浏览器拼好整份 JSON，再交给服务端一次 PUT（只花 2 个子请求） */
  const davBackupChunked = async () => {
    const box = $('#dav-status');
    const show = (t) => {
      box.innerHTML = `<span class="note">${esc(t)}</span>`;
    };
    const track = (label) => (done, total) => show(total > 1 ? `${label} ${done}/${total} 页…` : `${label}…`);

    show('读取观看历史…');
    const history = await davPullAll('/sync/history', {}, track('观看历史'));
    const ratings = {};
    for (const t of ['movies', 'shows', 'episodes', 'seasons']) {
      show(`读取评分（${t}）…`);
      ratings[t] = (await davPullAll(`/users/me/ratings/${t}`, {}, track(`评分 ${t}`))).rows;
    }
    show('读取待看…');
    const watchlist = await davPullAll('/sync/watchlist', {}, track('待看'));
    show('读取收藏…');
    const favorites = await davPullAll('/users/me/favorites', {}, track('收藏'));
    show('读取自定义列表…');
    const listsRes = await davPullAll('/users/me/lists', {}, track('列表'), { limit: 100, maxPages: 1 });

    const lists = [];
    for (const l of listsRes.rows.slice(0, 100)) {
      const id = l?.ids?.trakt || l?.id;
      if (!id) continue;
      show(`读取列表「${l.name || id}」…`);
      const items = await davPullAll(`/users/me/lists/${id}/items`, {}, track(`列表「${l.name || id}」`), { limit: 100, maxPages: 100 });
      lists.push({ ...l, items: items.rows, itemsTruncated: items.truncated });
    }

    const data = { history: history.rows, ratings, watchlist: watchlist.rows, favorites: favorites.rows, lists };
    const payload = {
      format: 'trakt-manager-backup',
      version: 1,
      createdAt: new Date().toISOString(),
      app: 'trakt-manager',
      user: { username: state.user?.username || '', name: state.user?.name || '' },
      settings: { displayLanguage: getLang() },
      data,
      counts: {
        history: data.history.length,
        ratings: Object.values(ratings).reduce((n, r) => n + r.length, 0),
        watchlist: data.watchlist.length,
        favorites: data.favorites.length,
        lists: lists.length,
        listItems: lists.reduce((n, l) => n + l.items.length, 0),
      },
      truncated: {
        history: history.truncated,
        ratings: Object.values(ratings).some((r) => r.truncated),
        watchlist: watchlist.truncated,
        favorites: favorites.truncated,
        budget: false,
        listItems: lists.some((l) => l.itemsTruncated),
      },
      warnings: [],
    };

    show('上传到 WebDAV…');
    return apiJson('/api/backup/dav/upload', { method: 'POST', body: { payload } });
  };

  $('#dav-run').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '备份中…';
    try {
      await saveDav(false);
      let j;
      if (await davNeedChunked()) {
        j = await davBackupChunked();
      } else {
        j = await apiJson('/api/backup/dav/run', { method: 'POST', body: {} });
        // 估算没算准、被预算截断：删掉这份残缺文件，改走分段重来
        if (j.truncated?.budget) {
          await apiJson('/api/backup/dav/delete', { method: 'POST', body: { name: j.name } }).catch(() => {});
          toast('数据量超出单次上限，改走分段备份');
          j = await davBackupChunked();
        }
      }
      paintDav(j.config);
      const cut = j.truncated && Object.values(j.truncated).some(Boolean)
        ? `<span class="note" style="display:block">数据量超过单次请求上限，本次备份是部分的（观看历史 ${num(j.counts?.history || 0)} 条等），恢复时请留意</span>`
        : '';
      $('#dav-status').innerHTML = `<span class="dav-ok">已上传「${esc(j.name)}」</span>${cut}${j.cleanupWarning ? `<span class="note" style="display:block">${esc(j.cleanupWarning)}</span>` : ''}`;
      toast(cut ? '已备份（部分数据）' : '已备份到 WebDAV');
    } catch (err) {
      $('#dav-status').innerHTML = `<span class="dav-bad">${esc(err.message)}</span>`;
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = '立即备份一次';
    }
  };

  $('#dav-download-btn').onclick = () => $('#backup-download').click();
  $('#dav-preview-btn').onclick = () => $('#backup-preview').click();
  $('#dav-restore-btn').onclick = () => $('#restore-pick').click();

  const renderDavFiles = (files) => {
    const box = $('#dav-files');
    if (!files.length) {
      box.innerHTML = `<div class="card card-pad dav-files-card">
        <div class="dav-files-head"><div class="dav-panel-title">远端备份文件</div><span class="note">共 0 份</span></div>
        <p class="note" style="margin:0">远端目录里还没有本应用的备份文件。</p>
      </div>`;
      return;
    }
    box.innerHTML = `<div class="card card-pad dav-files-card">
      <div class="dav-files-head"><div class="dav-panel-title">远端备份文件</div><span class="note">共 ${files.length} 份 · 恢复前会先预览</span></div>
      <table style="margin:0"><thead><tr><th>文件</th><th>大小</th><th></th></tr></thead><tbody>
      ${files
        .map((f, i) => `<tr>
          <td style="padding:8px 10px">${esc(f.name)}</td>
          <td style="padding:8px 10px;color:var(--muted)">${num(Math.max(1, Math.round((f.size || 0) / 1024)))} KB</td>
          <td style="padding:8px 10px;white-space:nowrap;text-align:right">
            <button class="btn dav-file-btn" data-fi="${i}">恢复</button>
            <button class="btn dav-file-btn" data-di="${i}">删除</button>
          </td>
        </tr>`)
        .join('')}
    </tbody></table></div>`;
    document.querySelectorAll('[data-fi]').forEach((b) => {
      b.onclick = async () => {
        const name = files[Number(b.dataset.fi)].name;
        b.disabled = true;
        b.textContent = '取回中…';
        try {
          const j = await apiJson(`/api/backup/dav/file?name=${encodeURIComponent(name)}`);
          await openRestorePreview(j.backup, `WebDAV 备份「${name}」`);
        } catch (err) {
          toast(err.message, true);
        } finally {
          b.disabled = false;
          b.textContent = '恢复';
        }
      };
    });
    document.querySelectorAll('[data-di]').forEach((b) => {
      b.onclick = async () => {
        const f = files[Number(b.dataset.di)];
        const yes = await confirmDialog(`删除远端备份「${f.name}」？`, '只删除网盘上的这一份备份文件，不影响你的 Trakt 数据。');
        if (!yes) return;
        try {
          await apiJson('/api/backup/dav/delete', { method: 'POST', body: { name: f.name } });
          toast('远端备份已删除');
          files.splice(Number(b.dataset.di), 1);
          renderDavFiles(files);
        } catch (err) {
          toast(err.message, true);
        }
      };
    });
  };

  $('#dav-files-btn').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '读取中…';
    try {
      const j = await apiJson('/api/backup/dav/files');
      renderDavFiles(j.files || []);
      $('#dav-files').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      $('#dav-status').innerHTML = `<span class="dav-bad">${esc(err.message)}</span>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '查看远端备份';
    }
  };

  try {
    paintDav((await apiJson('/api/backup/dav')).config);
  } catch (e) {
    $('#dav-status').textContent = '读取 WebDAV 配置失败：' + e.message;
  }
};

/* ───────── 通用弹层 ───────── */

function openModal(html, extraClass = '') {
  $('#modal-root').innerHTML = `<div class="modal-backdrop"><div class="card modal ${extraClass}">${html}</div></div>`;
  document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = closeModal));
  $('.modal-backdrop').onclick = (e) => {
    if (e.target.classList.contains('modal-backdrop')) closeModal();
  };
}
function closeModal() {
  $('#modal-root').innerHTML = '';
  if (state.dirty) {
    state.dirty = false;
    if (PAGES[state.route]) PAGES[state.route]();
  }
}

function confirmDialog(title, desc = '') {
  return new Promise((resolve) => {
    openModal(`<h3>${esc(title)}</h3><p class="note">${esc(desc)}</p>
      <div class="modal-actions"><button class="btn" data-close>取消</button>
      <button class="btn btn-danger" id="cf-ok">确认</button></div>`);
    $('#cf-ok').onclick = () => {
      closeModal();
      resolve(true);
    };
    document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => { closeModal(); resolve(false); }));
  });
}

/** 单条破坏性操作的统一确认：写清「改的是哪里的什么数据」，避免用户误以为只改本地 */
function confirmRemove(name, where) {
  return confirmDialog(`移出${where}：「${name}」？`, `这会同步到你的 Trakt 账号，不再显示在${where}里。`);
}

/* ───────── 启动 ───────── */

async function boot(skipSession = false) {
  setTheme(themeMode()); // 登录页也要跟随主题
  if (!skipSession) {
    try {
      const r = await fetch('/api/session', { headers: apiHeaders() });
      const j = await r.json();
      state.user = j.loggedIn ? j.user : null;
    } catch {
      state.user = null;
    }
  }
  if (!state.user) {
    renderLogin();
    return;
  }
  try {
    const r = await fetch('/api/settings', { headers: apiHeaders() });
    const j = await r.json();
    // 语言只有一个来源：服务端 cfg:tmdb_lang（接口与 TMDB 影视信息共用）。
    // 本地 tm_lang 只负责登录页和首屏闪一下，登录后一律以服务端为准。
    if (LANGS.some(([code]) => code === j.lang) && getLang() !== j.lang) setLang(j.lang);
  } catch {}
  shell();
}

initI18n();
boot();
