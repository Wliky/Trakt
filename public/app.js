// Trakt Manager 前端：无框架，hash 路由 + 服务端会话

const state = {
  user: null,
  route: 'dashboard',
  history: { type: 'movies', page: 1, limit: 25, startAt: '', endAt: '', selected: new Set(), data: [], meta: null },
  ratings: { type: 'movies', page: 1, limit: 25, data: [], meta: null },
  favorites: { data: [], loaded: false },
  lists: { data: [], loaded: false, open: new Set(), items: {} },
  stats: { data: null },
};

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

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, isErr = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast show${isErr ? ' err' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.className = 'toast'), 2600);
}

const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const fmtDur = (min) => {
  const m = Number(min || 0);
  if (!m) return '0 分钟';
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m % 60} 分`;
  return `${m} 分钟`;
};

const num = (n) => Number(n || 0).toLocaleString('zh-CN');

async function api(path, { method = 'GET', query, body } = {}) {
  const resp = await fetch('/api/trakt', {
    method: 'POST',
    headers: apiHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ method, path, query, body }),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(json.error || `请求失败（HTTP ${resp.status}）`);
  if (json.status === 401) {
    state.user = null;
    renderLogin();
    throw new Error('登录已失效，请重新登录');
  }
  if (json.status === 420) throw new Error('请求过于频繁，Trakt 已限流，请稍后再试');
  if (json.status >= 400) throw new Error(json.data?.error || `Trakt 返回 ${json.status}`);
  return json;
}

const loading = () => `<div class="empty"><span class="skel" style="display:inline-block;width:180px"></span></div>`;
const emptyBox = (text, emoji = '🗂') => `<div class="empty"><span class="em">${emoji}</span>${esc(text)}</div>`;

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
  return `<img class="thumb" loading="lazy" alt="" src="/api/poster?${artQuery(kind, ids, season, number)}"
    onerror="this.classList.add('thumb-empty');this.removeAttribute('src')" />`;
}

function rowAttrs(kind, ids, season, number, title, act) {
  return `data-kind="${kind}" data-ids='${esc(JSON.stringify(ids || {}))}' data-act='${esc(JSON.stringify(act || null))}'
    data-season="${season ?? ''}" data-number="${number ?? ''}" data-title="${esc(title || '')}"`;
}

function bindRowClick(root = document) {
  root.querySelectorAll('tr[data-kind]').forEach((tr) => {
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

function providerNote() {
  const p = state.tmdbProvider;
  if (!p) return '';
  return p === 'tmdb' ? '<span class="chip ok">TMDB</span>' : '<span class="chip">Trakt 海报</span>';
}

async function openDetail({ type, ids, act, season, number, title }) {
  openModal(`<div id="detail-box" class="detail">${loading()}</div>`, 'modal-wide');
  const q = artQuery(type, ids, season, number);
  // 写操作用真实条目 id（剧集用 episode id，季用 season id），海报/元数据用所属剧集/影片 id
  const actType = act?.type || type;
  const actIds = act?.ids?.trakt ? act.ids : ids;
  try {
    const [metaRes, stateRes] = await Promise.all([
      fetch(`/api/meta?${q}`, { headers: apiHeaders() }),
      actIds.trakt ? fetch(`/api/state?type=${actType}&trakt=${actIds.trakt}`, { headers: apiHeaders() }) : Promise.resolve(null),
    ]);
    const j = await metaRes.json();
    if (!j.ok) throw new Error(j.message || '未找到信息');
    const d = j.data;
    const st = stateRes ? await stateRes.json().catch(() => null) : null;
    const ep = d.episode || null;
    const posterSrc = `/api/poster?${q}`;
    const poster = `<img class="detail-poster" src="${esc(posterSrc)}" alt=""
      onerror="this.classList.add('thumb-empty');this.removeAttribute('src')" />`;
    const facts = [
      d.year || '',
      d.runtime ? `${d.runtime} 分钟` : '',
      d.rating ? `★ ${d.rating}` : '',
      d.votes ? `${num(d.votes)} 人评分` : '',
    ].filter(Boolean);
    const released = String(ep?.first_aired || d.released || '').slice(0, 10);
    const ctx = { type: actType, ids: actIds, artType: type, season, number, released };

    $('#detail-box').innerHTML = `
      ${poster}
      <div class="detail-main">
        <div class="detail-title">${esc(d.title || title || '')}</div>
        ${d.original_title && d.original_title !== d.title ? `<div class="detail-sub">${esc(d.original_title)}</div>` : ''}
        <div class="detail-facts">${facts.map((f) => `<span>${esc(f)}</span>`).join('<i>·</i>')}</div>
        ${d.genres?.length ? `<div class="detail-genres">${d.genres.map((g) => `<span class="chip">${esc(g)}</span>`).join('')}</div>` : ''}
        ${ep ? `<div class="detail-ep">S${String(season).padStart(2, '0')}E${String(number).padStart(2, '0')} · ${esc(ep.title || '')}
          ${ep.first_aired ? `<span class="num">· ${esc(fmtDate(ep.first_aired))}</span>` : ''}</div>` : ''}
        <p class="detail-overview">${esc(ep?.overview || d.overview || '暂无简介')}</p>
        <div class="actions" id="action-box"></div>
        <div class="detail-links">
          ${d.links?.tmdb ? `<a class="btn btn-sm" href="${esc(d.links.tmdb)}" target="_blank" rel="noreferrer">TMDB</a>` : ''}
          ${d.links?.trakt ? `<a class="btn btn-sm" href="${esc(d.links.trakt)}" target="_blank" rel="noreferrer">Trakt</a>` : ''}
          <span class="spacer" style="flex:1"></span>
          <span class="sub">${d.provider === 'tmdb' ? '数据源 TMDB' : '数据源 Trakt'}</span>
        </div>
      </div>`;

    paintActions(ctx, st);
  } catch (e) {
    $('#detail-box').innerHTML = emptyBox(e.message, '⚠️');
  }
}

/* ── 详情里的写操作（双向：写完立即回读 Trakt 状态）── */

const todayStr = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function actionsInner(st, released, actType) {
  const count = st?.watched?.count || 0;
  const last = st?.watched?.last;
  const rating = Number(st?.rating || 0);
  const wl = Boolean(st?.watchlist);
  const watchRow = actType === 'season' ? '' : `
    <div class="action-row">
      <span class="action-label">观看</span>
      <span class="action-value" id="st-watch">${count ? `已看 ${count} 次${last ? ` · ${fmtDate(last)}` : ''}` : '未标记'}</span>
      <div class="action-ctl">
        <select id="when-mode" ${count ? 'disabled title="已标记，先取消再来"' : ''}>
          <option value="now">现在</option>
          <option value="released" ${released ? '' : 'disabled'}>发布日${released ? `（${released}）` : '（暂无）'}</option>
          <option value="custom">选择日期</option>
          <option value="unknown">未知日期</option>
        </select>
        <input type="date" id="when-date" value="${todayStr()}" hidden />
        <button class="btn btn-sm ${count ? 'btn-danger' : 'btn-primary'}" id="btn-watch-toggle">${count ? '取消观看' : '标记已看'}</button>
      </div>
    </div>`;

  return `
    ${watchRow}
    <div class="action-row">
      <span class="action-label">评分</span>
      <div class="stars" id="stars">
        ${Array.from({ length: 10 }, (_, i) => i + 1)
          .map((v) => `<button class="star ${v <= rating ? 'on' : ''}" data-v="${v}" title="${v} 分">${v}</button>`)
          .join('')}
      </div>
      <span class="action-value" id="st-rating">${rating ? `${rating} 分` : '未评分'}</span>
    </div>
    ${actType === 'season' ? '' : `<div class="action-row">
      <span class="action-label">待看</span>
      <span class="action-value" id="st-wl">${wl ? '已在待看列表' : '不在待看列表'}</span>
      <div class="action-ctl">
        <button class="btn btn-sm" id="btn-wl">${wl ? '移出待看' : '加入待看'}</button>
      </div>
    </div>`}`;
}

function paintActions(ctx, st) {
  const box = $('#action-box');
  if (!box) return;
  box.innerHTML = actionsInner(st, ctx.released, ctx.type);
  bindActions(ctx, st || {});
}

function bindActions(ctx, st) {
  const { type, ids, season, number } = ctx;
  const mode = $('#when-mode');
  const dateInput = $('#when-date');

  if (mode) {
    mode.onchange = () => {
      const custom = mode.value === 'custom';
      dateInput.hidden = !custom;
      if (custom) dateInput.focus();
    };
  }

  const toggle = $('#btn-watch-toggle');
  if (toggle) {
    toggle.onclick = async () => {
      const watched = (st?.watched?.count || 0) > 0;
      toggle.disabled = true;
      try {
        let j;
        if (watched) {
          j = await runAction({ type, ids, action: 'unwatch' });
          toast('已取消观看');
        } else {
          const when = mode.value;
          if (when === 'custom' && !dateInput.value) throw new Error('请选择日期');
          j = await runAction({
            type, ids, season, number, action: 'watch', when,
            date: when === 'custom' ? dateInput.value : undefined,
          });
          toast(j.note ? `已标记（${j.note}）` : '已标记为已看');
        }
        state.dirty = true;
        paintActions(ctx, j);
      } catch (e) {
        toast(e.message, true);
        toggle.disabled = false;
      }
    };
  }

  document.querySelectorAll('#stars .star').forEach((btn) => {
    btn.onclick = async () => {
      const v = Number(btn.dataset.v);
      const cur = Number(st?.rating || 0);
      try {
        const j = v === cur ? await runAction({ type, ids, action: 'unrate' }) : await runAction({ type, ids, action: 'rate', rating: v });
        toast(v === cur ? '已清除评分' : `已评分 ${v}`);
        state.dirty = true;
        paintActions(ctx, j);
      } catch (e) {
        toast(e.message, true);
      }
    };
  });

  const wl = $('#btn-wl');
  if (wl) {
    wl.onclick = async () => {
      const inList = Boolean(st?.watchlist);
      try {
        const j = await runAction({ type, ids, action: inList ? 'watchlist_remove' : 'watchlist_add' });
        toast(inList ? '已移出待看' : '已加入待看');
        state.dirty = true;
        paintActions(ctx, j);
      } catch (e) {
        toast(e.message, true);
      }
    };
  }
}

async function runAction(payload) {
  const r = await fetch('/api/action', {
    method: 'POST',
    headers: apiHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({ ok: false, message: `HTTP ${r.status}` }));
  if (!j.ok) throw new Error(j.message || '操作失败');
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
        <div>
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

const NAV = [
  ['dashboard', '◈', '概览'],
  ['history', '▤', '观看历史'],
  ['ratings', '★', '评分'],
  ['favorites', '♥', '收藏'],
  ['lists', '☰', '片单'],
  ['stats', '◔', '统计'],
  ['settings', '⚙', '设置'],
];

function shell() {
  const initial = (state.user?.name || state.user?.username || 'U').slice(0, 1).toUpperCase();
  app().innerHTML = `
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">
        <div class="brand-mark">T</div>
        <div>
          <div class="brand-name">Trakt Manager</div>
          <div class="brand-sub">数据管理面板</div>
        </div>
      </div>
      ${NAV.map(([k, ic, label]) => `<div class="nav-item" data-nav="${k}"><span class="ic">${ic}</span>${label}</div>`).join('')}
      <div class="sidebar-foot">
        <div class="user-chip">
          <div class="avatar">${esc(initial)}</div>
          <div class="user-meta">
            <div class="user-name">${esc(state.user?.name || state.user?.username)}</div>
            <div class="user-sub">@${esc(state.user?.username)}</div>
          </div>
        </div>
        <button class="btn btn-sm btn-block" id="btn-logout">退出登录</button>
      </div>
    </aside>
    <main class="main" id="view"></main>
  </div>`;

  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.onclick = () => {
      location.hash = `#/${el.dataset.nav}`;
    };
  });
  $('#btn-logout').onclick = async () => {
    await fetch('/api/auth/logout', { method: 'POST', headers: apiHeaders() });
    try { localStorage.removeItem(DEVICE_KEY); } catch {}
    state.user = null;
    renderLogin();
  };
  route();
}

function route() {
  const key = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?')[0];
  state.route = NAV.some(([k]) => k === key) ? key : 'dashboard';
  document.querySelectorAll('[data-nav]').forEach((el) => el.classList.toggle('active', el.dataset.nav === state.route));
  PAGES[state.route]();
}

window.addEventListener('hashchange', () => {
  if (state.user) route();
});

function head(title, sub, actions = '') {
  return `<div class="page-head"><div><h1>${esc(title)}</h1><div class="sub">${esc(sub)}</div></div>
    <div class="toolbar">${actions}</div></div>`;
}

/* ───────── 概览 ───────── */

const PAGES = {};

PAGES.dashboard = async () => {
  const view = $('#view');
  view.innerHTML = head('概览', '你的 Trakt 观看数据总览') + `<div class="grid grid-4" id="dash-stats">${'<div class="card stat"><div class="skel" style="width:60%"></div></div>'.repeat(4)}</div>
    <div style="height:16px"></div>
    <div class="card">
      <div class="hint-bar">最近观看 <span class="spacer" style="flex:1"></span><a class="btn btn-sm" href="#/history">查看全部</a></div>
      <div id="dash-recent">${loading()}</div>
    </div>`;

  try {
    const [s, recent] = await Promise.all([
      api('/users/me/stats'),
      api('/sync/history', { query: { limit: 8, page: 1 } }),
    ]);
    const d = s.data || {};
    const cards = [
      ['电影观看', num(d.movies?.plays), `${num(d.movies?.collected)} 部在收藏库`],
      ['剧集观看', num(d.episodes?.plays), `${num(d.shows?.watched)} 部剧集在追`],
      ['总观看时长', fmtDur((d.movies?.minutes || 0) + (d.episodes?.minutes || 0)), '约 ' + ((d.movies?.days_to_watch || 0) + (d.episodes?.days_to_watch || 0)) + ' 天'],
      ['评分次数', num(d.ratings?.total), d.ratings?.distribution ? `均分 ${avgRating(d.ratings.distribution).toFixed(1)}` : ''],
    ];
    $('#dash-stats').innerHTML = cards
      .map(
        ([label, value, hint]) => `<div class="card stat"><div class="stat-label">${label}</div>
        <div class="stat-value">${esc(value)}</div><div class="stat-hint">${esc(hint)}</div></div>`
      )
      .join('');

    const rows = recent.data || [];
    $('#dash-recent').innerHTML = rows.length ? `<table><tbody>${rows.map(recentRow).join('')}</tbody></table>` : emptyBox('还没有观看记录');
  } catch (e) {
    $('#dash-recent').innerHTML = emptyBox(e.message, '⚠️');
  }
};

function avgRating(dist) {
  let total = 0;
  let count = 0;
  for (const [k, v] of Object.entries(dist || {})) {
    total += Number(k) * Number(v);
    count += Number(v);
  }
  return count ? total / count : 0;
}

function recentRow(it) {
  const isEp = it.type === 'episode';
  const title = isEp ? it.show?.title : it.movie?.title;
  const sub = isEp ? `S${String(it.episode?.season).padStart(2, '0')}E${String(it.episode?.number).padStart(2, '0')} · ${it.episode?.title || ''}` : `${it.movie?.year || ''}`;
  const ids = isEp ? it.show?.ids : it.movie?.ids;
  const kind = isEp ? 'episode' : 'movie';
  return `<tr ${rowAttrs(kind, ids, isEp ? it.episode?.season : '', isEp ? it.episode?.number : '', title)}>
    <td class="col-poster">${thumb(kind === 'episode' ? 'show' : kind, ids)}</td>
    <td class="col-type"><span class="chip ${isEp ? '' : 'red'}">${isEp ? '剧集' : '电影'}</span></td>
    <td><div class="title-cell"><div class="title-main">${esc(title || '—')}</div><div class="title-sub">${esc(sub)}</div></div></td>
    <td class="num" style="text-align:right;white-space:nowrap">${esc(fmtDate(it.watched_at))}</td>
  </tr>`;
}

/* ───────── 观看历史 ───────── */

PAGES.history = async () => {
  const st = state.history;
  const view = $('#view');
  view.innerHTML =
    head('观看历史', '查看、筛选、删除观看记录（会同步影响 Trakt 端数据）', `
      <select id="hist-limit">
        ${[25, 50, 100].map((n) => `<option value="${n}" ${st.limit === n ? 'selected' : ''}>每页 ${n}</option>`).join('')}
      </select>
      <button class="btn btn-sm" id="hist-export-csv">导出 CSV</button>
      <button class="btn btn-sm" id="hist-export-json">导出 JSON</button>`) +
    `<div class="card">
      <div class="hint-bar">
        <div class="tabs">
          <button class="tab ${st.type === 'movies' ? 'active' : ''}" data-htype="movies">电影</button>
          <button class="tab ${st.type === 'episodes' ? 'active' : ''}" data-htype="episodes">剧集</button>
        </div>
        <input type="date" id="hist-start" value="${st.startAt}" title="开始日期" />
        <span style="color:var(--muted)">→</span>
        <input type="date" id="hist-end" value="${st.endAt}" title="结束日期" />
        <button class="btn btn-sm" id="hist-filter">筛选</button>
        <button class="btn btn-sm" id="hist-reset">重置</button>
        <div style="flex:1"></div>
        <button class="btn btn-sm btn-danger" id="hist-del" disabled>删除选中 (0)</button>
      </div>
      <div class="table-wrap" id="hist-body">${loading()}</div>
      <div class="pager" id="hist-pager" hidden></div>
    </div>`;

  document.querySelectorAll('[data-htype]').forEach((el) => {
    el.onclick = () => {
      st.type = el.dataset.htype;
      st.page = 1;
      st.selected.clear();
      PAGES.history();
    };
  });
  $('#hist-limit').onchange = (e) => {
    st.limit = Number(e.target.value);
    st.page = 1;
    loadHistory();
  };
  $('#hist-filter').onclick = () => {
    st.startAt = $('#hist-start').value;
    st.endAt = $('#hist-end').value;
    st.page = 1;
    st.selected.clear();
    loadHistory();
  };
  $('#hist-reset').onclick = () => {
    st.startAt = '';
    st.endAt = '';
    st.page = 1;
    st.selected.clear();
    PAGES.history();
  };
  $('#hist-export-csv').onclick = () => {
    window.location = `/api/export?kind=history&type=${st.type}&format=csv`;
  };
  $('#hist-export-json').onclick = () => {
    window.location = `/api/export?kind=history&type=${st.type}&format=json`;
  };
  $('#hist-del').onclick = () => removeHistory();

  await loadHistory();
};

async function loadHistory() {
  const st = state.history;
  const body = $('#hist-body');
  body.innerHTML = loading();
  try {
    const r = await api(`/sync/history/${st.type}`, {
      query: { page: st.page, limit: st.limit, start_at: st.startAt || undefined, end_at: st.endAt || undefined },
    });
    st.data = r.data || [];
    st.meta = r.pagination;
    renderHistory();
  } catch (e) {
    body.innerHTML = emptyBox(e.message, '⚠️');
  }
}

function renderHistory() {
  const st = state.history;
  const pager = $('#hist-pager');
  const delBtn = $('#hist-del');
  const isEp = st.type === 'episodes';

  if (!st.data.length) {
    $('#hist-body').innerHTML = emptyBox('该条件下没有观看记录', '📭');
    pager.hidden = true;
    delBtn.disabled = true;
    delBtn.textContent = '删除选中 (0)';
    return;
  }

  $('#hist-body').innerHTML = `<table>
    <thead><tr>
      <th class="row-sel"><input type="checkbox" class="checkbox" id="hist-all" /></th>
      <th class="col-poster"></th>
      <th>标题</th>
      <th class="col-type">类型</th>
      <th style="text-align:right">观看时间</th>
    </tr></thead>
    <tbody>${st.data
      .map((it, i) => {
        const title = isEp ? it.show?.title : it.movie?.title;
        const sub = isEp
          ? `S${String(it.episode?.season).padStart(2, '0')}E${String(it.episode?.number).padStart(2, '0')} · ${it.episode?.title || ''}`
          : `${it.movie?.year || ''} · trakt:${it.movie?.ids?.trakt || ''}`;
        const ids = isEp ? it.show?.ids : it.movie?.ids;
        const kind = isEp ? 'episode' : 'movie';
        const act = isEp ? { type: 'episode', ids: it.episode?.ids || {} } : null;
        return `<tr ${rowAttrs(kind, ids, isEp ? it.episode?.season : '', isEp ? it.episode?.number : '', title, act)}>
          <td><input type="checkbox" class="checkbox hist-ck" data-idx="${i}" ${st.selected.has(it.id) ? 'checked' : ''} /></td>
          <td class="col-poster">${thumb(isEp ? 'show' : kind, ids)}</td>
          <td><div class="title-cell"><div class="title-main">${esc(title || '—')}</div><div class="title-sub">${esc(sub)}</div></div></td>
          <td><span class="chip ${isEp ? '' : 'red'}">${isEp ? '剧集' : '电影'}</span></td>
          <td class="num" style="text-align:right;white-space:nowrap">${esc(fmtDate(it.watched_at))}</td>
        </tr>`;
      })
      .join('')}</tbody></table>`;

  bindRowClick($('#hist-body'));

  document.querySelectorAll('.hist-ck').forEach((ck) => {
    ck.onchange = () => {
      const it = st.data[Number(ck.dataset.idx)];
      if (ck.checked) st.selected.add(it.id);
      else st.selected.delete(it.id);
      updateDelBtn();
    };
  });
  const all = $('#hist-all');
  all.onchange = () => {
    st.data.forEach((it) => (all.checked ? st.selected.add(it.id) : st.selected.delete(it.id)));
    document.querySelectorAll('.hist-ck').forEach((ck) => (ck.checked = all.checked));
    updateDelBtn();
  };

  const meta = st.meta || { page: 1, pageCount: 1, itemCount: st.data.length };
  pager.hidden = false;
  pager.innerHTML = `<div>第 ${meta.page} / ${meta.pageCount} 页 · 共 ${num(meta.itemCount)} 条</div>
    <div class="pager-btns">
      <button class="btn btn-sm" id="pg-prev" ${meta.page <= 1 ? 'disabled' : ''}>上一页</button>
      <input id="pg-jump" type="number" min="1" max="${meta.pageCount}" value="${meta.page}" />
      <button class="btn btn-sm" id="pg-go">跳转</button>
      <button class="btn btn-sm" id="pg-next" ${meta.page >= meta.pageCount ? 'disabled' : ''}>下一页</button>
    </div>`;
  $('#pg-prev').onclick = () => {
    st.page = Math.max(1, st.page - 1);
    loadHistory();
  };
  $('#pg-next').onclick = () => {
    st.page = Math.min(meta.pageCount, st.page + 1);
    loadHistory();
  };
  $('#pg-go').onclick = () => {
    const p = Math.min(meta.pageCount, Math.max(1, Number($('#pg-jump').value) || 1));
    st.page = p;
    loadHistory();
  };
  updateDelBtn();
}

function updateDelBtn() {
  const n = state.history.selected.size;
  const btn = $('#hist-del');
  if (!btn) return;
  btn.disabled = n === 0;
  btn.textContent = `删除选中 (${n})`;
}

async function removeHistory() {
  const st = state.history;
  const ids = [...st.selected];
  if (!ids.length) return;
  if (!(await confirmDialog(`确认删除 ${ids.length} 条观看记录？`, '删除后 Trakt 端的观看历史会同步减少，且不可撤销。'))) return;
  try {
    await api('/sync/history/remove', { method: 'POST', body: { ids } });
    toast(`已删除 ${ids.length} 条记录`);
    st.selected.clear();
    await loadHistory();
  } catch (e) {
    toast(e.message, true);
  }
}

/* ───────── 评分 ───────── */

const TYPE_LABEL = { movies: '电影', shows: '剧集', episodes: '分集', seasons: '季' };

PAGES.ratings = async () => {
  const st = state.ratings;
  $('#view').innerHTML =
    head('评分', '批量修改或清除你的评分（0 分等于删除评分）', `<button class="btn btn-sm" id="rating-export">导出 CSV</button>`) +
    `<div class="card">
      <div class="hint-bar">
        <div class="tabs">
          ${Object.entries(TYPE_LABEL)
            .map(([k, v]) => `<button class="tab ${st.type === k ? 'active' : ''}" data-rtype="${k}">${v}</button>`)
            .join('')}
        </div>
        <div style="flex:1"></div>
        <span class="sub">共 <b id="rating-count">—</b> 条</span>
      </div>
      <div class="table-wrap" id="rating-body">${loading()}</div>
      <div class="pager" id="rating-pager" hidden></div>
    </div>`;

  document.querySelectorAll('[data-rtype]').forEach((el) => {
    el.onclick = () => {
      st.type = el.dataset.rtype;
      st.page = 1;
      PAGES.ratings();
    };
  });
  $('#rating-export').onclick = () => {
    window.location = `/api/export?kind=ratings&type=${st.type}&format=csv`;
  };
  await loadRatings();
};

async function loadRatings() {
  const st = state.ratings;
  $('#rating-body').innerHTML = loading();
  try {
    const r = await api(`/users/me/ratings/${st.type}`, { query: { page: st.page, limit: st.limit } });
    st.data = r.data || [];
    st.meta = r.pagination;
    $('#rating-count').textContent = num(r.pagination?.itemCount || st.data.length);
    renderRatings();
  } catch (e) {
    $('#rating-body').innerHTML = emptyBox(e.message, '⚠️');
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
    $('#rating-body').innerHTML = emptyBox('还没有评分记录', '★');
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
          <td><div class="title-cell"><div class="title-main">${esc(m.title)}</div><div class="title-sub">${esc(m.sub || '')}</div></div></td>
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
          <td class="num" style="text-align:right;white-space:nowrap">${esc(fmtDate(it.rated_at))}</td>
        </tr>`;
      })
      .join('')}</tbody></table>`;

  bindRowClick($('#rating-body'));

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

  const meta = st.meta || { page: 1, pageCount: 1 };
  const pager = $('#rating-pager');
  pager.hidden = false;
  pager.innerHTML = `<div>第 ${meta.page} / ${meta.pageCount} 页</div>
    <div class="pager-btns">
      <button class="btn btn-sm" id="r-prev" ${meta.page <= 1 ? 'disabled' : ''}>上一页</button>
      <button class="btn btn-sm" id="r-next" ${meta.page >= meta.pageCount ? 'disabled' : ''}>下一页</button>
    </div>`;
  $('#r-prev').onclick = () => {
    st.page = Math.max(1, st.page - 1);
    loadRatings();
  };
  $('#r-next').onclick = () => {
    st.page = Math.min(meta.pageCount, st.page + 1);
    loadRatings();
  };
}

/* ───────── 收藏 ───────── */

PAGES.favorites = async () => {
  $('#view').innerHTML =
    head('收藏', 'Trakt 的 Favorites（最喜欢的电影/剧集）', '') +
    `<div class="card"><div class="table-wrap" id="fav-body">${loading()}</div></div>`;
  try {
    const r = await api('/users/me/favorites', { query: { extended: 'full' } });
    const rows = (r.data || []).filter(Boolean);
    if (!rows.length) {
      $('#fav-body').innerHTML = emptyBox('还没有收藏的电影或剧集', '♥');
      return;
    }
    $('#fav-body').innerHTML = `<table><thead><tr><th class="col-poster"></th><th>标题</th><th class="col-type">类型</th><th style="width:90px"></th></tr></thead><tbody>
      ${rows
        .map((it, i) => {
          const m = it.movie || it.show || {};
          const art = it.movie ? 'movie' : 'show';
          return `<tr ${rowAttrs(art, m.ids, '', '', m.title)}>
            <td class="col-poster">${thumb(art, m.ids)}</td>
            <td><div class="title-cell"><div class="title-main">${esc(m.title || '—')}</div><div class="title-sub">${esc(m.year || '')}</div></div></td>
            <td><span class="chip ${it.movie ? 'red' : ''}">${it.movie ? '电影' : '剧集'}</span></td>
            <td><button class="btn btn-sm btn-danger fav-del" data-idx="${i}">取消收藏</button></td>
          </tr>`;
        })
        .join('')}</tbody></table>`;

    bindRowClick($('#fav-body'));

    document.querySelectorAll('.fav-del').forEach((btn) => {
      btn.onclick = async () => {
        const it = rows[Number(btn.dataset.idx)];
        const key = it.movie ? 'movies' : 'shows';
        const ids = (it.movie || it.show).ids;
        try {
          await api('/sync/favorites/remove', { method: 'POST', body: { [key]: [{ ids }] } });
          toast('已取消收藏');
          PAGES.favorites();
        } catch (e) {
          toast(e.message, true);
        }
      };
    });
  } catch (e) {
    $('#fav-body').innerHTML = emptyBox(e.message, '⚠️');
  }
};

/* ───────── 片单 ───────── */

PAGES.lists = async () => {
  const st = state.lists;
  $('#view').innerHTML =
    head('片单', 'Watchlist 与自定义列表的增删管理', `<button class="btn btn-primary btn-sm" id="list-new">新建列表</button>`) +
    `<div class="card" style="margin-bottom:16px">
      <div class="hint-bar">
        <b>Watchlist</b><span class="sub" style="margin-left:8px">想看的电影/剧集</span>
        <div style="flex:1"></div>
        <button class="btn btn-sm" id="wl-export">导出 CSV</button>
      </div>
      <div class="table-wrap" id="wl-body" style="max-height:40vh">${loading()}</div>
    </div>
    <div class="card">
      <div class="hint-bar"><b>自定义列表</b><div style="flex:1"></div><span class="sub">点击展开查看条目</span></div>
      <div id="lists-body">${loading()}</div>
    </div>`;

  $('#list-new').onclick = () => createListDialog();
  $('#wl-export').onclick = () => {
    window.location = '/api/export?kind=watchlist&format=csv';
  };
  await Promise.all([loadWatchlist(), loadLists()]);
};

async function loadWatchlist() {
  try {
    const r = await api('/sync/watchlist');
    const rows = (r.data || []).filter(Boolean);
    if (!rows.length) {
      $('#wl-body').innerHTML = emptyBox('Watchlist 是空的', '📝');
      return;
    }
    $('#wl-body').innerHTML = `<table><thead><tr><th class="col-poster"></th><th>标题</th><th class="col-type">类型</th><th style="text-align:right">加入时间</th><th style="width:80px"></th></tr></thead><tbody>
      ${rows
        .map((it, i) => {
          const m = it.movie || it.show || it.episode || {};
          const kind = it.movie ? '电影' : it.show ? '剧集' : '分集';
          const art = it.movie ? 'movie' : it.show ? 'show' : 'episode';
          const artIds = it.movie ? it.movie.ids : it.show ? it.show.ids : it.show?.ids || {};
          return `<tr ${rowAttrs(art, artIds, it.episode?.season, it.episode?.number, m.title || it.show?.title)}>
            <td class="col-poster">${thumb(art === 'episode' ? 'show' : art, artIds)}</td>
            <td><div class="title-cell"><div class="title-main">${esc(m.title || '—')}</div>
              <div class="title-sub">${esc(m.year || (it.show?.title ? it.show.title : ''))}</div></div></td>
            <td><span class="chip ${it.movie ? 'red' : ''}">${kind}</span></td>
            <td class="num" style="text-align:right;white-space:nowrap">${esc(fmtDate(it.listed_at))}</td>
            <td><button class="btn btn-sm btn-danger wl-del" data-idx="${i}">移除</button></td>
          </tr>`;
        })
        .join('')}</tbody></table>`;

    bindRowClick($('#wl-body'));

    document.querySelectorAll('.wl-del').forEach((btn) => {
      btn.onclick = async () => {
        const it = rows[Number(btn.dataset.idx)];
        const key = it.movie ? 'movies' : it.show ? 'shows' : 'episodes';
        const ids = (it.movie || it.show || it.episode).ids;
        try {
          await api('/sync/watchlist/remove', { method: 'POST', body: { [key]: [{ ids }] } });
          toast('已从 Watchlist 移除');
          loadWatchlist();
        } catch (e) {
          toast(e.message, true);
        }
      };
    });
  } catch (e) {
    $('#wl-body').innerHTML = emptyBox(e.message, '⚠️');
  }
}

async function loadLists() {
  const st = state.lists;
  try {
    const r = await api('/users/me/lists');
    st.data = r.data || [];
    if (!st.data.length) {
      $('#lists-body').innerHTML = emptyBox('还没有自定义列表，点右上角新建', '☰');
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
          btn.textContent = '展开';
          return;
        }
        box.hidden = false;
        btn.textContent = '收起';
        box.innerHTML = loading();
        try {
          const [mv, sh] = await Promise.all([
            api(`/users/me/lists/${id}/items/movies`),
            api(`/users/me/lists/${id}/items/shows`),
          ]);
          const items = [...(mv.data || []), ...(sh.data || [])].filter(Boolean);
          if (!items.length) {
            box.innerHTML = emptyBox('列表为空', '📭');
            return;
          }
          box.innerHTML = `<table><tbody>${items
            .map((it) => {
              const m = it.movie || it.show || {};
              const kind = it.movie ? 'movies' : 'shows';
              const art = it.movie ? 'movie' : 'show';
              return `<tr ${rowAttrs(art, m.ids, '', '', m.title)}>
                <td class="col-poster">${thumb(art, m.ids)}</td>
                <td><div class="title-cell"><div class="title-main">${esc(m.title || '—')}</div><div class="title-sub">${esc(m.year || '')}</div></div></td>
                <td><span class="chip ${it.movie ? 'red' : ''}">${it.movie ? '电影' : '剧集'}</span></td>
                <td style="width:80px"><button class="btn btn-sm btn-danger li-rm" data-kind="${kind}" data-ids='${esc(JSON.stringify(m.ids))}' data-list="${id}">移除</button></td>
              </tr>`;
            })
            .join('')}</tbody></table>`;

          bindRowClick(box);

          document.querySelectorAll('.li-rm').forEach((b) => {
            b.onclick = async () => {
              try {
                await api(`/users/me/lists/${b.dataset.list}/items/remove`, {
                  method: 'POST',
                  body: { [b.dataset.kind]: [{ ids: JSON.parse(b.dataset.ids) }] },
                });
                toast('已从列表移除');
                b.closest('tr').remove();
              } catch (e) {
                toast(e.message, true);
              }
            };
          });
        } catch (e) {
          box.innerHTML = emptyBox(e.message, '⚠️');
        }
      };
    });

    document.querySelectorAll('.list-del').forEach((btn) => {
      btn.onclick = async () => {
        if (!(await confirmDialog(`删除列表「${btn.dataset.name}」？`, '列表及其条目会一并删除，无法恢复。'))) return;
        try {
          await api(`/users/me/lists/${btn.dataset.id}`, { method: 'DELETE' });
          toast('列表已删除');
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
    $('#lists-body').innerHTML = emptyBox(e.message, '⚠️');
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
    box.innerHTML = loading();
    try {
      const r = await api('/search/movie,show', { query: { query: q, limit: 12 } });
      const rows = (r.data || []).filter(Boolean);
      if (!rows.length) {
        box.innerHTML = emptyBox('没有匹配结果', '🔍');
        return;
      }
      box.innerHTML = rows
        .map((it, i) => {
          const m = it.movie || it.show || {};
          return `<div class="list-row" style="padding:9px 4px">
            <div class="list-main"><div class="list-title">${esc(m.title)}</div>
            <div class="list-sub">${esc(m.year || '')} · ${it.type === 'movie' ? '电影' : '剧集'}</div></div>
            <button class="btn btn-sm ai-add" data-i="${i}">加入</button>
          </div>`;
        })
        .join('');
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
      box.innerHTML = emptyBox(e.message, '⚠️');
    }
  };
  $('#ai-go').onclick = search;
  $('#ai-q').onkeydown = (e) => e.key === 'Enter' && search();
  $('#ai-q').focus();
}

/* ───────── 统计 ───────── */

PAGES.stats = async () => {
  $('#view').innerHTML =
    head('统计', '观看总量、评分分布与累计时长', `<button class="btn btn-sm" id="stats-refresh">刷新</button>`) +
    `<div class="grid grid-4" id="st-cards">${'<div class="card stat"><div class="skel" style="width:60%"></div></div>'.repeat(4)}</div>
     <div style="height:16px"></div>
     <div class="grid grid-2">
       <div class="card card-pad">
         <div class="stat-label" style="margin-bottom:14px">评分分布（1–10）</div>
         <div class="chart" id="st-dist">${loading()}</div>
       </div>
       <div class="card card-pad">
         <div class="stat-label" style="margin-bottom:14px">观看时长构成</div>
         <div id="st-dur">${loading()}</div>
       </div>
     </div>`;
  $('#stats-refresh').onclick = () => PAGES.stats();

  try {
    const r = await api('/users/me/stats');
    const d = r.data || {};
    const cards = [
      ['电影', `${num(d.movies?.plays)} 次`, `库内 ${num(d.movies?.collected)} 部 · ${fmtDur(d.movies?.minutes)}`],
      ['剧集', `${num(d.episodes?.plays)} 集`, `${num(d.shows?.watched)} 部在追 · ${fmtDur(d.episodes?.minutes)}`],
      ['评分', num(d.ratings?.total), d.ratings?.distribution ? `均分 ${avgRating(d.ratings.distribution).toFixed(2)}` : ''],
      ['评论', num((d.movies?.comments || 0) + (d.shows?.comments || 0) + (d.episodes?.comments || 0)), '影评/剧评数量'],
    ];
    $('#st-cards').innerHTML = cards
      .map(
        ([l, v, h]) => `<div class="card stat"><div class="stat-label">${l}</div><div class="stat-value">${esc(v)}</div>
        <div class="stat-hint">${esc(h)}</div></div>`
      )
      .join('');

    const dist = d.ratings?.distribution || {};
    const vals = Array.from({ length: 10 }, (_, i) => Number(dist[i + 1] || 0));
    const max = Math.max(1, ...vals);
    $('#st-dist').innerHTML = vals
      .map(
        (v, i) => `<div class="bar-col"><div class="bar-value">${v || ''}</div>
        <div class="bar" style="height:${Math.round((v / max) * 120)}px"></div><div class="bar-label">${i + 1}</div></div>`
      )
      .join('');

    const mMin = d.movies?.minutes || 0;
    const eMin = d.episodes?.minutes || 0;
    const total = Math.max(1, mMin + eMin);
    $('#st-dur').innerHTML = `
      ${progressRow('电影', mMin, total, '#ed1c24')}
      ${progressRow('剧集', eMin, total, '#ff7a45')}
      <div style="margin-top:18px;color:var(--muted);font-size:12.5px;line-height:1.8">
        累计观看 <b style="color:var(--text)">${fmtDur(total)}</b><br/>
        约合 <b style="color:var(--text)">${(total / 1440).toFixed(1)}</b> 天不间断播放
      </div>`;
  } catch (e) {
    $('#st-cards').innerHTML = emptyBox(e.message, '⚠️');
  }
};

function progressRow(label, value, total, color) {
  const pct = Math.round((value / total) * 100);
  return `<div style="margin-bottom:14px">
    <div style="display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:6px">
      <span>${label}</span><span class="num">${fmtDur(value)} · ${pct}%</span>
    </div>
    <div style="height:8px;border-radius:6px;background:var(--panel-3);overflow:hidden">
      <div style="height:100%;width:${pct}%;background:${color};border-radius:6px"></div>
    </div>
  </div>`;
}

/* ───────── 设置 ───────── */

PAGES.settings = async () => {
  $('#view').innerHTML =
    head('设置', '海报与影视信息的来源', '') +
    `<div class="card card-pad">
      <div class="stat-label">TMDB API Key（可选）</div>
      <p class="note" style="margin:10px 0 14px;max-width:720px">
        不填也能用：默认走 Trakt 自带海报与元数据。填了 TMDB key 后切换为 TMDB（中文标题/简介、高清海报），
        查不到时自动回落 Trakt。key 只保存在本服务端，不会下发到浏览器。<br/>
        免费申请：themoviedb.org → 右上头像 → Settings → API → 创建 <b>API Key (Developer)</b>，把「API Key (v3 auth)」整串粘进来。
      </p>
      <div class="toolbar">
        <input id="tmdb-key" type="text" placeholder="粘贴 v3 key（32 位）或 v4 Read Access Token" style="flex:1;min-width:260px" />
        <button class="btn btn-primary" id="tmdb-save">保存并校验</button>
        <button class="btn" id="tmdb-clear">清除</button>
      </div>
      <div id="tmdb-status" class="note" style="margin-top:12px"></div>
    </div>
    <div style="height:14px"></div>
    <div class="card card-pad">
      <div class="stat-label">当前状态</div>
      <div id="provider-info" style="margin-top:12px;font-size:13px;line-height:1.9">…</div>
    </div>`;

  const paint = (s) => {
    const t = s.tmdb || {};
    $('#tmdb-status').innerHTML = t.configured
      ? `已配置：<b>${esc(t.preview || '')}</b>（来源：${t.source === 'env' ? '环境变量' : '本机保存'}）`
      : '未配置 —— 当前使用 <b>Trakt</b> 自带海报与元数据。';
    $('#provider-info').innerHTML = `
      <div>海报/信息数据源：<b>${s.provider === 'tmdb' ? 'TMDB' : 'Trakt'}</b></div>
      <div>海报由服务端代取后同源输出（Trakt 走 <code>media.trakt.tv</code>，TMDB 走 <code>image.tmdb.org</code>），避免跨域拦截与防盗链。</div>
      <div>查询结果会缓存 30 天，减少上游压力。</div>`;
  };

  const load = async () => {
    try {
      const r = await fetch('/api/settings', { headers: apiHeaders() });
      const j = await r.json();
      state.tmdbProvider = j.provider;
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

  $('#tmdb-clear').onclick = async () => {
    await fetch('/api/settings', {
      method: 'POST',
      headers: apiHeaders({ 'content-type': 'application/json' }),
      body: JSON.stringify({ tmdbKey: '' }),
    });
    toast('已清除，回到 Trakt 数据源');
    await load();
  };
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

/* ───────── 启动 ───────── */

async function boot(skipSession = false) {
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
    state.tmdbProvider = j.provider;
  } catch {
    state.tmdbProvider = 'trakt';
  }
  shell();
}

boot();
