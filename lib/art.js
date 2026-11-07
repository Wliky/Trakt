/**
 * 海报 / 影视信息聚合：TMDB 优先，Trakt 兜底，结果落存储缓存 30 天。
 *
 * - TMDB：需要 key（v3 api_key 或 v4 Bearer token），返回指定语言的标题/简介 + image.tmdb.org 海报
 * - Trakt：无需额外 key，用 extended=images,full 返回 media.trakt.tv 海报与元数据；
 *          语言非英文时再叠加官方 translations（无 key 也能拿到中文标题/简介，覆盖率低于 TMDB）
 *
 * 语言优先级：环境变量 TMDB_LANG > 设置页保存的 cfg:tmdb_lang > zh-CN
 */

const UA = 'TraktManager/1.0.0 (+self-hosted)';
const CLIENT_ID = '201dc70c5ec6af530f12f079ea1922733f6e1085ad7b02f36d8e011b75bcea7d';
const TTL = 60 * 60 * 24 * 30;
const SEASON_TTL = 60 * 60 * 12;
// 季里出现「没有 trakt id 的集」时只缓存一小会：这类集通常是 Trakt 还没收录，
// 缓存太久会让用户在 Trakt 补齐之后仍然看到缺数据（写操作现在按集号兜底，但展示仍缺剧照/评分）
const SEASON_SHORT_TTL = 60 * 10;

// Trakt 的 genres 是英文 slug，翻一层中文（donghua = Trakt 给国漫的单列 slug）
const GENRE_ZH = {
  action: '动作', adventure: '冒险', animation: '动画', anime: '动画', donghua: '动画', comedy: '喜剧', crime: '犯罪',
  documentary: '纪录', drama: '剧情', family: '家庭', fantasy: '奇幻', history: '历史', horror: '恐怖',
  music: '音乐', mystery: '悬疑', romance: '爱情', 'science-fiction': '科幻', 'sci-fi': '科幻',
  'tv-movie': '电视电影', thriller: '惊悚', war: '战争', western: '西部', 'superhero': '超级英雄',
  'game-show': '游戏节目', 'reality': '真人秀', 'talk-show': '脱口秀', 'news': '新闻', 'soap': '肥皂剧',
};

// 英文名不靠查表：slug 本身可读，个别连字符要还原成人话
const GENRE_EN = {
  'science-fiction': 'Science Fiction',
  'sci-fi': 'Sci-Fi',
  'tv-movie': 'TV Movie',
  'game-show': 'Game Show',
  'talk-show': 'Talk Show',
  'reality': 'Reality',
  'soap': 'Soap',
  'news': 'News',
};

const titleCaseSlug = (slug) =>
  slug.replace(/-/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** Trakt slug → 展示名（只用于没走 TMDB 的兜底路径）；语言与界面共用同一个设置 */
export const genreLabel = (slug, lang = 'zh') => {
  if (!/^zh/i.test(String(lang || ''))) return GENRE_EN[slug] || titleCaseSlug(slug);
  return GENRE_ZH[slug] || slug;
};

const UNKNOWN_GENRE = {
  28: '动作', 12: '冒险', 16: '动画', 35: '喜剧', 80: '犯罪', 99: '纪录', 18: '剧情', 10751: '家庭',
  14: '奇幻', 36: '历史', 27: '恐怖', 10402: '音乐', 9648: '悬疑', 10749: '爱情', 878: '科幻',
  10770: '电视电影', 53: '惊悚', 10752: '战争', 37: '西部', 10759: '动作冒险', 10762: '儿童',
  10763: '新闻', 10764: '真人秀', 10765: '科幻奇幻', 10766: '肥皂剧', 10767: '脱口秀', 10768: '战争政治',
};

async function jsonFetch(url, headers = {}) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA, ...headers } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

const fixUrl = (u) => (!u ? '' : u.startsWith('http') ? u : `https://${u}`);

/* ── Trakt 数据源 ── */

async function traktMeta(env, type, id, lang = 'en') {
  if (!id) return null;
  const base = (env.TRAKT_PUBLIC_API_BASE || 'https://api.trakt.tv').replace(/\/$/, '');
  const kind = type === 'movie' ? 'movies' : 'shows';
  const d = await jsonFetch(`${base}/${kind}/${id}?extended=images,full`, {
    'trakt-api-version': '2',
    'trakt-api-key': env.TRAKT_CLIENT_ID || CLIENT_ID,
  });
  if (!d || !d.title) return null;
  const im = d.images || {};
  const pick = (arr, i = 0) => fixUrl(Array.isArray(arr) ? arr[i] : '');
  const out = {
    provider: 'trakt',
    title: d.title,
    year: d.year || null,
    released: d.released || (d.first_aired ? String(d.first_aired).slice(0, 10) : ''),
    overview: d.overview || '',
    tagline: d.tagline || '',
    runtime: d.runtime || 0,
    genres: (d.genres || []).map((g) => GENRE_ZH[g] || g),
    rating: d.rating ? Number(d.rating.toFixed(1)) : null,
    votes: d.votes || 0,
    status: d.status || '',
    poster: pick(im.poster) || pick(im.thumb),
    backdrop: pick(im.fanart),
    logo: pick(im.logo),
    ids: d.ids || {},
    links: { trakt: d.ids?.slug ? `https://trakt.tv/${type === 'movie' ? 'movies' : 'shows'}/${d.ids.slug}` : '' },
  };
  // Trakt 只有英文；非英文语言下再叠一层官方翻译（拿不到就保持原样）
  const tr = await traktTranslation(env, kind, id, lang);
  if (tr) {
    if (tr.title) out.title = tr.title;
    if (tr.overview) out.overview = tr.overview;
    if (tr.tagline) out.tagline = tr.tagline;
    out.translated = true;
  }
  return out;
}

/**
 * Trakt 官方译文：/movies/:id/translations/:lang、/shows/:id/translations/:lang
 * Trakt 的中文条目多写成 `zh`（country 区分 cn/tw），直接查 `zh-CN` 常常为空，
 * 所以按「完整语言 → 主语言」回退，并优先取 country=cn 的简体条目。
 */
async function traktTranslation(env, kind, id, lang) {
  if (!id || !lang || /^en\b/i.test(lang)) return null;
  const base = (env.TRAKT_PUBLIC_API_BASE || 'https://api.trakt.tv').replace(/\/$/, '');
  const want = String(lang).trim();
  const primary = want.split('-')[0].toLowerCase();
  const tries = [want];
  if (primary && primary !== want.toLowerCase()) tries.push(primary);
  const wantCountry = 'cn';
  for (const code of tries) {
    const d = await jsonFetch(`${base}/${kind}/${id}/translations/${encodeURIComponent(code)}`, {
      'trakt-api-version': '2',
      'trakt-api-key': env.TRAKT_CLIENT_ID || CLIENT_ID,
    });
    const list = Array.isArray(d) ? d.filter((x) => x && (x.title || x.overview)) : [];
    if (!list.length) continue;
    const first =
      list.find((x) => String(x.country || '').toLowerCase() === wantCountry) || list[0];
    return { title: first.title || '', overview: first.overview || '', tagline: first.tagline || '' };
  }
  return null;
}

async function traktEpisode(env, showTraktId, season, number) {
  if (!showTraktId || season == null || number == null) return null;
  const base = (env.TRAKT_PUBLIC_API_BASE || 'https://api.trakt.tv').replace(/\/$/, '');
  const d = await jsonFetch(`${base}/shows/${showTraktId}/seasons/${season}/episodes/${number}?extended=full`, {
    'trakt-api-version': '2',
    'trakt-api-key': env.TRAKT_CLIENT_ID || CLIENT_ID,
  });
  if (!d) return null;
  const sc = d.images?.screenshot || {};
  return {
    provider: 'trakt',
    title: d.title || '',
    overview: d.overview || '',
    runtime: d.runtime || 0,
    rating: d.rating ? Number(d.rating.toFixed(1)) : null,
    votes: d.votes || 0,
    first_aired: d.first_aired || '',
    // 分集封面（剧照）：Trakt 给 screenshot，TMDB 给 still，前端优先用它当分集封面
    still: fixUrl(sc.thumb || sc.medium || sc.full || ''),
    ids: d.ids || {},
  };
}

/* ── TMDB 数据源 ── */

async function tmdbMeta(env, key, type, id, lang = 'zh-CN') {
  if (!id) return null;
  const params = new URLSearchParams({ language: lang });
  const headers = {};
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  else params.set('api_key', key);

  const path = type === 'movie' ? `movie/${id}` : `tv/${id}`;
  const d = await jsonFetch(`https://api.themoviedb.org/3/${path}?${params}`, headers);
  if (!d || (!d.title && !d.name)) return null;

  const img = (p, size = 'w500') => (p ? `https://image.tmdb.org/t/p/${size}${p}` : '');
  const title = d.title || d.name;
  return {
    provider: 'tmdb',
    title,
    original_title: d.original_title || d.original_name || '',
    year: Number((d.release_date || d.first_air_date || '').slice(0, 4)) || null,
    released: d.release_date || d.first_air_date || '',
    overview: d.overview || '',
    tagline: d.tagline || '',
    runtime: d.runtime || (Array.isArray(d.episode_run_time) ? d.episode_run_time[0] : 0) || 0,
    genres: (d.genres || []).map((g) => g.name || UNKNOWN_GENRE[g.id] || '').filter(Boolean),
    rating: d.vote_average ? Number(d.vote_average.toFixed(1)) : null,
    votes: d.vote_count || 0,
    status: d.status || '',
    poster: img(d.poster_path),
    backdrop: img(d.backdrop_path, 'w1280'),
    ids: { tmdb: d.id, imdb: d.imdb_id },
    links: { tmdb: `https://www.themoviedb.org/${type === 'movie' ? 'movie' : 'tv'}/${d.id}?language=${lang.split('-')[0]}` },
  };
}

/** TMDB 鉴权：v4 令牌走 Bearer，v3 key 走查询参数 */
function tmdbAuth(key, params) {
  const headers = {};
  if (String(key).startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  else params.set('api_key', key);
  return headers;
}

const CJK = /[\u3400-\u9fff]/;

/**
 * TMDB 有几种类型压根没做翻译：tv 的 10765 在中文下也回 "Sci-Fi & Fantasy"。
 * 所以只在「中文界面 + 名字里没有汉字」时，用 TMDB 官方 id 查兜底名；id 仍以 TMDB 为准，
 * 不是自己另建分类体系。
 */
function localizeGenre(id, name, lang) {
  if (/^zh/i.test(String(lang || '')) && name && !CJK.test(name)) return UNKNOWN_GENRE[id] || name;
  return name;
}

/**
 * TMDB 官方类型清单：id 稳定、名称随语言变。
 * 详情接口在中日韩等语言下常只翻译一部分（例如 tv 的 10765 会原样回 "Sci-Fi & Fantasy"），
 * 所以中文名统一从这里取，取不到才退回详情里的 name。
 */
async function tmdbGenreIndex(ctx, key, type, lang) {
  const ck = `gl2:${type}:${lang}`;
  const cached = await ctx.store.get(ck);
  if (cached && typeof cached === 'object' && Object.keys(cached).length) {
    return new Map(Object.entries(cached));
  }
  const params = new URLSearchParams({ language: lang });
  const headers = tmdbAuth(key, params); // 先算 header：v3 key 会被塞进 params，必须在拼 URL 之前
  const d = await jsonFetch(`https://api.themoviedb.org/3/genre/${type}/list?${params}`, headers);
  const out = {};
  for (const g of d?.genres || []) if (g?.id && g?.name) out[String(g.id)] = localizeGenre(g.id, g.name, lang);
  // 空结果不落缓存：一次请求失败不该把该语言锁死 30 天
  if (Object.keys(out).length) await ctx.store.set(ck, out, TTL);
  return new Map(Object.entries(out));
}

/** 只要 TMDB 的类型名，不要海报/简介那些重字段 */
async function tmdbGenres(env, key, type, id, lang = 'zh-CN', index) {
  const params = new URLSearchParams({ language: lang });
  const headers = tmdbAuth(key, params);
  const path = type === 'movie' ? `movie/${id}` : `tv/${id}`;
  const d = await jsonFetch(`https://api.themoviedb.org/3/${path}?${params}`, headers);
  return (d?.genres || [])
    .map((g) => index?.get(String(g.id)) || localizeGenre(g.id, g.name || '', lang) || UNKNOWN_GENRE[g.id] || '')
    .filter(Boolean);
}

/**
 * 只取「真实类型」：TMDB 本地化的 genres 名称，中文名由 TMDB 返回，不再自己维护映射表。
 * 返回 Map<`${type}:${traktId|tmdbId}`, string[]>；没 key、没 tmdbId 或请求失败就不入 Map，
 * 调用方回退 Trakt 自带的 genres。缓存 30 天，键带语言——切换显示语言后类型名跟着变。
 */
export async function resolveGenres(ctx, items = []) {
  const out = new Map();
  if (!items.length) return out;
  const key = await getTmdbKey(ctx);
  if (!key) return out;
  const lang = await getTmdbLang(ctx);
  const store = ctx.store;
  const env = ctx.env || {};
  // 电影和剧集的类型集合不同（剧集有「动作冒险」「科幻奇幻」，电影是「动作」「科幻」），两套清单各取一次
  const index = new Map();
  for (const t of ['tv', 'movie']) {
    index.set(t, await tmdbGenreIndex(ctx, env, key, t, lang).catch(() => new Map()));
  }
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const it = items[cursor++];
      const type = it.type === 'movie' ? 'movie' : 'show';
      if (!it.tmdbId) continue;
      const ck = `gen3:${type}:${it.tmdbId}:${lang}`;
      let names = await store.get(ck);
      if (!Array.isArray(names) || !names.length) {
        const idx = index.get(type === 'movie' ? 'movie' : 'tv');
        names = await tmdbGenres(env, key, type, it.tmdbId, lang, idx).catch(() => []);
        if (names.length) await store.set(ck, names, TTL);
      }
      if (!names.length) continue;
      if (it.traktId) out.set(`${type}:${it.traktId}`, names);
      out.set(`${type}:${it.tmdbId}`, names);
    }
  };
  // 12 并发：一部剧一次详情请求约 200–300ms，150 部大约 3s；再高容易撞 TMDB 限流
  await Promise.all(Array.from({ length: Math.min(12, items.length) }, worker));
  return out;
}

/**
 * TMDB 标题艺术字（透明 PNG）：`/{movie|tv}/{id}/images` 的 logos。
 * 优先当前语言，其次英文，最后无文字版本；同语言里按投票分与宽度挑。
 */
async function tmdbLogo(env, key, type, id, lang = 'zh-CN') {
  if (!id) return null;
  const primary = String(lang).split('-')[0].toLowerCase();
  const params = new URLSearchParams({ include_image_language: `${primary},en,null` });
  const headers = {};
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  else params.set('api_key', key);
  const path = type === 'movie' ? `movie/${id}/images` : `tv/${id}/images`;
  const d = await jsonFetch(`https://api.themoviedb.org/3/${path}?${params}`, headers);
  const list = Array.isArray(d?.logos) ? d.logos.filter((l) => l && l.file_path) : [];
  if (!list.length) return null;
  const rank = (l) => {
    const code = String(l.iso_639_1 || l.iso_language || '').toLowerCase();
    const byLang = !code ? 1.5 : code === primary ? 3 : code === 'en' ? 2 : 1;
    return byLang * 1000 + Number(l.vote_average || 0) * 10 + Math.min(Number(l.width) || 0, 2000) / 1000;
  };
  const best = list.slice().sort((a, b) => rank(b) - rank(a))[0];
  return {
    url: `https://image.tmdb.org/t/p/w500${best.file_path}`,
    width: Number(best.width) || 0,
    height: Number(best.height) || 0,
    lang: best.iso_639_1 || best.iso_language || '',
  };
}

/** TMDB 分集：指定语言的标题 / 简介 + 剧照（still_path） */
async function tmdbEpisode(env, key, tvId, season, number, lang = 'zh-CN') {
  if (!tvId || season == null || number == null) return null;
  const params = new URLSearchParams({ language: lang });
  const headers = {};
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  else params.set('api_key', key);

  const path = `tv/${tvId}/season/${season}/episode/${number}`;
  const d = await jsonFetch(`https://api.themoviedb.org/3/${path}?${params}`, headers);
  if (!d || (!d.name && !d.overview)) return null;
  const img = (p, size = 'w780') => (p ? `https://image.tmdb.org/t/p/${size}${p}` : '');
  return {
    provider: 'tmdb',
    title: d.name || '',
    overview: d.overview || '',
    runtime: d.runtime || 0,
    rating: d.vote_average ? Number(d.vote_average.toFixed(1)) : null,
    votes: d.vote_count || 0,
    first_aired: d.air_date || '',
    still: img(d.still_path),
    ids: {},
  };
}

/* ── 对外接口 ── */

export async function getTmdbKey(ctx) {
  const env = ctx.env || {};
  const fromEnv = env.TMDB_API_KEY || env.TMDB_TOKEN || '';
  if (fromEnv) return fromEnv.trim();
  const saved = await ctx.store.get('cfg:tmdb');
  return saved?.key?.trim() || '';
}

/** 可选语言清单：界面与影视信息只提供中文、英文，后端按此校验 */
export const LANGUAGES = [
  ['zh-CN', '简体中文'],
  ['en-US', 'English'],
];

export const DEFAULT_LANG = 'zh-CN';

/** 展示语言：环境变量 TMDB_LANG > 设置页保存的 cfg:tmdb_lang > zh-CN，清单外的值一律回落中文 */
export async function getTmdbLang(ctx) {
  const fromEnv = (ctx.env?.TMDB_LANG || '').trim();
  const saved = fromEnv || (await ctx.store.get('cfg:tmdb_lang'))?.lang?.trim();
  const want = saved || DEFAULT_LANG;
  return LANGUAGES.some(([code]) => code === want) ? want : DEFAULT_LANG;
}

export async function verifyTmdbKey(key) {
  const params = new URLSearchParams();
  const headers = { 'user-agent': UA };
  if (key.startsWith('eyJ')) headers.authorization = `Bearer ${key}`;
  else params.set('api_key', key);
  try {
    const r = await fetch(`https://api.themoviedb.org/3/configuration?${params}`, { headers });
    return r.ok;
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<object|null>} 统一结构；null 表示查不到
 */
export async function resolveArt(ctx, { type = 'movie', traktId, tmdbId, season, number, title, year }) {
  const env = ctx.env || {};
  const store = ctx.store;
  const key = await getTmdbKey(ctx);
  const lang = await getTmdbLang(ctx);
  const mode = key ? 'tmdb' : 'trakt';
  // 语言进缓存键：切换语言立即生效，不必等 30 天过期
  // v4：分集/整季也要带剧集级 logo
  const cacheKey = `art4:${mode}:${lang}:${type}:${tmdbId || 't' + (traktId || '')}:${season ?? ''}:${number ?? ''}`;
  const cached = await store.get(cacheKey);
  if (cached) return cached;
  let base = null;

  // 1) TMDB（需要 key + tmdbId）
  if (key && tmdbId) base = await tmdbMeta(env, key, type === 'movie' ? 'movie' : 'show', tmdbId, lang);

  // 2) Trakt 兜底（Trakt 只认 trakt id / slug，前缀式 id 已不再解析）
  if ((!base || !base.poster) && traktId) {
    const lookup = String(traktId).includes('-') ? traktId : traktId;
    const t = await traktMeta(env, type === 'movie' ? 'movie' : 'show', lookup, lang);
    if (t) {
      if (!base) base = t;
      else {
        // TMDB 有数据但缺海报时，补齐图片
        base.poster = base.poster || t.poster;
        base.backdrop = base.backdrop || t.backdrop;
        base.logo = base.logo || t.logo;
      }
    }
  }

  if (!base) return null;
  base.lang = lang;

  // 2.5) 标题艺术字：剧名/片名级资源，分集与整季也复用（切换选集时标题不变）
  if (!base.logo && key && tmdbId) {
    const lg = await tmdbLogo(env, key, type === 'movie' ? 'movie' : 'show', tmdbId, lang);
    if (lg) {
      base.logo = lg.url;
      base.logo_size = { width: lg.width, height: lg.height };
      base.logo_lang = lg.lang;
    }
  }

  // 3) 分集补充：TMDB 分集（指定语言 + 剧照）优先，Trakt 兜底（补 trakt id、首播、剧照）
  if (type === 'episode') {
    let ep = key && tmdbId ? await tmdbEpisode(env, key, tmdbId, season, number, lang) : null;
    const tk = await traktEpisode(env, traktId, season, number);
    if (ep && tk) {
      ep.title = ep.title || tk.title;
      ep.overview = ep.overview || tk.overview;
      ep.first_aired = ep.first_aired || tk.first_aired || '';
      ep.still = ep.still || tk.still || '';
      ep.runtime = ep.runtime || tk.runtime || 0;
      ep.rating = ep.rating ?? tk.rating;
      ep.votes = ep.votes || tk.votes || 0;
      ep.ids = tk.ids || {}; // 写操作必须用 Trakt 的分集 id
    } else if (tk) {
      ep = tk;
    }
    base.episode = ep || null;
    if (ep && !base.title) base.title = ep.title;
  }

  if (title && !base.title) base.title = title;
  if (year && !base.year) base.year = year;

  await store.set(cacheKey, base, TTL);
  return base;
}

/** 一整季的分集：Trakt 提供真实条目 id，TMDB 提供本地化文案与剧照。 */
export async function resolveSeason(ctx, { traktId, tmdbId, season } = {}) {
  const env = ctx.env || {};
  const store = ctx.store;
  const key = await getTmdbKey(ctx);
  const lang = await getTmdbLang(ctx);
  const mode = key ? 'tmdb' : 'trakt';
  const cacheKey = `season:v1:${mode}:${lang}:${traktId || ''}:${tmdbId || ''}:${season ?? ''}`;
  const cached = await store.get(cacheKey);
  if (cached) return cached;

  const base = (env.TRAKT_PUBLIC_API_BASE || 'https://api.trakt.tv').replace(/\/$/, '');
  const headers = {
    'trakt-api-version': '2',
    'trakt-api-key': env.TRAKT_CLIENT_ID || CLIENT_ID,
  };
  const seasonRows = traktId ? await jsonFetch(`${base}/shows/${traktId}/seasons?extended=full`, headers) : null;
  let seasons = Array.isArray(seasonRows) ? seasonRows.filter(Boolean) : [];
  const requested = season === undefined || season === null || season === '' ? null : Number(season);
  const selected = requested ?? seasons.find((s) => Number(s.number) > 0)?.number ?? seasons[0]?.number ?? 1;
  if (!Number.isInteger(Number(selected)) || Number(selected) < 0) return null;
  const no = Number(selected);

  const params = new URLSearchParams({ language: lang });
  const tmdbHeaders = {};
  if (key.startsWith('eyJ')) tmdbHeaders.authorization = `Bearer ${key}`;
  else if (key) params.set('api_key', key);
  const [traktRows, tmdb] = await Promise.all([
    traktId ? jsonFetch(`${base}/shows/${traktId}/seasons/${no}?extended=full,images`, headers) : Promise.resolve(null),
    key && tmdbId
      ? jsonFetch(`https://api.themoviedb.org/3/tv/${tmdbId}/season/${no}?${params}`, tmdbHeaders)
      : Promise.resolve(null),
  ]);
  const tkEps = Array.isArray(traktRows) ? traktRows.filter(Boolean) : [];
  const tmEps = Array.isArray(tmdb?.episodes) ? tmdb.episodes.filter(Boolean) : [];
  if (!seasons.length && !tkEps.length && !tmEps.length) return null;

  if (!seasons.length && tmdb) {
    const today = new Date().toISOString().slice(0, 10);
    seasons = [{
      number: no,
      episode_count: tmEps.length,
      aired_episodes: tmEps.filter((e) => e.air_date && e.air_date <= today).length,
      first_aired: tmdb.air_date || '',
      ids: {},
    }];
  }
  const tkByNo = new Map(tkEps.map((e) => [Number(e.number), e]));
  const tmByNo = new Map(tmEps.map((e) => [Number(e.episode_number), e]));
  const numbers = [...new Set([...tkByNo.keys(), ...tmByNo.keys()])].filter(Number.isFinite).sort((a, b) => a - b);
  const img = (p) => (p ? `https://image.tmdb.org/t/p/w780${p}` : '');
  const episodes = numbers.map((number) => {
    const tk = tkByNo.get(number) || {};
    const tm = tmByNo.get(number) || {};
    const sc = tk.images?.screenshot || {};
    const traktStill = fixUrl(sc.thumb || sc.medium || sc.full || (Array.isArray(sc) ? sc[0] : '') || '');
    return {
      number,
      title: tm.name || tk.title || `第 ${number} 集`,
      overview: tm.overview || tk.overview || '',
      runtime: tm.runtime || tk.runtime || 0,
      first_aired: tk.first_aired || tm.air_date || '',
      still: img(tm.still_path) || traktStill,
      ids: tk.ids || {},
      rating: tm.vote_average ? Number(tm.vote_average.toFixed(1)) : tk.rating ? Number(tk.rating.toFixed(1)) : null,
      votes: tm.vote_count || tk.votes || 0,
    };
  });
  const traktFailed = Boolean(traktId) && (!Array.isArray(seasonRows) || !Array.isArray(traktRows));
  // 有 trakt id 却一条分集都没回来，属于上游没取到（不是「这季真的没有集」），别当正常结果
  const traktEmpty = Boolean(traktId) && Array.isArray(traktRows) && !tkEps.length;
  const tmdbFailed = Boolean(key && tmdbId) && !tmdb;
  // 只在 TMDB 里存在的集（Trakt 还没收录 / 编号对不上）没有 trakt id，写操作现在按季号+集号兜底
  const missingIds = episodes.filter((e) => !e.ids?.trakt).length;
  const out = {
    seasons,
    season: no,
    episodes,
    ...(missingIds ? { missingIds } : {}),
    ...(traktFailed || traktEmpty || tmdbFailed
      ? { degraded: true, message: '部分季或分集数据暂时不可用，已展示可用内容' }
      : {}),
  };
  if (!out.degraded) await store.set(cacheKey, out, missingIds ? SEASON_SHORT_TTL : SEASON_TTL);
  return out;
}

/** 图片直链：背景优先 backdrop，分集普通图优先剧照，最后退回海报。 */
export async function resolvePoster(ctx, params) {
  const data = await resolveArt(ctx, params);
  if (!data) return '';
  if (params.art === 'logo') return data.logo || '';
  if (params.art === 'backdrop') return data.backdrop || data.poster || '';
  if (data.episode?.still) return data.episode.still;
  return data.poster || '';
}
