/**
 * 海报 / 影视信息聚合：TMDB 优先，Trakt 兜底，结果落存储缓存 30 天。
 *
 * - TMDB：需要 key（v3 api_key 或 v4 Bearer token），返回中文标题/简介 + image.tmdb.org 海报
 * - Trakt：无需额外 key，用 extended=images,full 返回 media.trakt.tv 海报与元数据
 */

const UA = 'TraktManager/1.0.0 (+self-hosted)';
const CLIENT_ID = '201dc70c5ec6af530f12f079ea1922733f6e1085ad7b02f36d8e011b75bcea7d';
const TTL = 60 * 60 * 24 * 30;

// Trakt 的 genres 是英文 slug，翻一层中文
const GENRE_ZH = {
  action: '动作', adventure: '冒险', animation: '动画', anime: '动画', comedy: '喜剧', crime: '犯罪',
  documentary: '纪录', drama: '剧情', family: '家庭', fantasy: '奇幻', history: '历史', horror: '恐怖',
  music: '音乐', mystery: '悬疑', romance: '爱情', 'science-fiction': '科幻', 'sci-fi': '科幻',
  'tv-movie': '电视电影', thriller: '惊悚', war: '战争', western: '西部', 'superhero': '超级英雄',
  'game-show': '游戏节目', 'reality': '真人秀', 'talk-show': '脱口秀', 'news': '新闻', 'soap': '肥皂剧',
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

async function traktMeta(env, type, id) {
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
  return {
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
    ids: d.ids || {},
    links: { trakt: d.ids?.slug ? `https://trakt.tv/${type === 'movie' ? 'movies' : 'shows'}/${d.ids.slug}` : '' },
  };
}

async function traktEpisode(env, showTraktId, season, number) {
  if (!showTraktId || season == null || number == null) return null;
  const base = (env.TRAKT_PUBLIC_API_BASE || 'https://api.trakt.tv').replace(/\/$/, '');
  const d = await jsonFetch(`${base}/shows/${showTraktId}/seasons/${season}/episodes/${number}?extended=full`, {
    'trakt-api-version': '2',
    'trakt-api-key': env.TRAKT_CLIENT_ID || CLIENT_ID,
  });
  if (!d) return null;
  return {
    provider: 'trakt',
    title: d.title || '',
    overview: d.overview || '',
    runtime: d.runtime || 0,
    rating: d.rating ? Number(d.rating.toFixed(1)) : null,
    votes: d.votes || 0,
    first_aired: d.first_aired || '',
    ids: d.ids || {},
  };
}

/* ── TMDB 数据源 ── */

async function tmdbMeta(env, key, type, id) {
  if (!id) return null;
  const lang = env.TMDB_LANG || 'zh-CN';
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

/* ── 对外接口 ── */

export async function getTmdbKey(ctx) {
  const env = ctx.env || {};
  const fromEnv = env.TMDB_API_KEY || env.TMDB_TOKEN || '';
  if (fromEnv) return fromEnv.trim();
  const saved = await ctx.store.get('cfg:tmdb');
  return saved?.key?.trim() || '';
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
  const mode = key ? 'tmdb' : 'trakt';
  const cacheKey = `art:${mode}:${type}:${tmdbId || 't' + (traktId || '')}:${season ?? ''}:${number ?? ''}`;
  const cached = await store.get(cacheKey);
  if (cached) return cached;
  let base = null;

  // 1) TMDB（需要 key + tmdbId）
  if (key && tmdbId) base = await tmdbMeta(env, key, type === 'movie' ? 'movie' : 'show', tmdbId);

  // 2) Trakt 兜底（Trakt 只认 trakt id / slug，前缀式 id 已不再解析）
  if ((!base || !base.poster) && traktId) {
    const lookup = String(traktId).includes('-') ? traktId : traktId;
    const t = await traktMeta(env, type === 'movie' ? 'movie' : 'show', lookup);
    if (t) {
      if (!base) base = t;
      else {
        // TMDB 有数据但缺海报时，补齐图片
        base.poster = base.poster || t.poster;
        base.backdrop = base.backdrop || t.backdrop;
      }
    }
  }

  if (!base) return null;

  // 3) 分集补充
  if (type === 'episode') {
    const ep = await traktEpisode(env, traktId, season, number);
    base.episode = ep || null;
    if (ep && !base.title) base.title = ep.title;
  }

  if (title && !base.title) base.title = title;
  if (year && !base.year) base.year = year;

  await store.set(cacheKey, base, TTL);
  return base;
}

/** 只取海报直链（给 <img> 用） */
export async function resolvePoster(ctx, params) {
  const data = await resolveArt(ctx, params);
  return data?.poster || '';
}
