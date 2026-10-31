// 前端通用片段：纯渲染 + 局部绑定，无框架、无构建（浏览器 ES Module）
// 业务与路由逻辑仍留在 app.js，这里只放各列表页共用的「原子件」

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const num = (n) => Number(n || 0).toLocaleString('zh-CN');

/* 线性图标：统一 24 视框 / currentColor 描边，尺寸交给 CSS。
   不用 emoji 当图标——各平台字形与基线不一致，视觉无法统一。 */
const svg = (body) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

/* 16 视框小图标：侧栏按钮 / 返回等 15px 场景 */
const svg16 = (body) =>
  `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;

export const ICON = {
  grid: svg('<rect x="3" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6"/>'),
  play: svg('<path d="M7.5 4.8 19 12 7.5 19.2z"/>'),
  history: svg('<path d="M3.2 12a8.8 8.8 0 1 0 2.9-6.5"/><path d="M3 4.6V9.2h4.6"/><path d="M12 7.8v4.6l3.2 1.9"/>'),
  list: svg('<path d="M8.5 6h12M8.5 12h12M8.5 18h12"/><circle cx="4" cy="6" r="1.1" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.1" fill="currentColor" stroke="none"/>'),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="m20.2 20.2-3.4-3.4"/>'),
  settings: svg('<path d="M4 7.5h8M18.5 7.5H20M4 16.5h1.5M12 16.5h8"/><circle cx="15.2" cy="7.5" r="2.3"/><circle cx="8.8" cy="16.5" r="2.3"/>'),
  tv: svg('<rect x="2.8" y="7" width="18.4" height="12.6" rx="2.2"/><path d="m8.2 3.2 3.8 3.8 3.8-3.8"/>'),
  heart: svg('<path d="M12 20.2s-7.2-4.5-7.2-9.4A4.2 4.2 0 0 1 12 8.2a4.2 4.2 0 0 1 7.2 2.6c0 4.9-7.2 9.4-7.2 9.4Z"/>'),
  chart: svg('<path d="M4 20V11M10 20V4.5M16 20v-6.5M22 20H2"/>'),
  star: svg('<path d="m12 3.7 2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>'),
  edit: svg('<path d="M4 20h4L20 8l-4-4L4 16z"/><path d="m14.5 5.5 4 4"/>'),
  inbox: svg('<path d="M3.4 13.6h4.3l1.4 2.4h5.8l1.4-2.4h4.3"/><path d="M6.2 4.6h11.6l2.8 9v4.2a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2v-4.2z"/>'),
  alert: svg('<path d="M12 4.4 20.8 19.6H3.2z"/><path d="M12 9.9v4.3"/><circle cx="12" cy="17.2" r="1" fill="currentColor" stroke="none"/>'),
  layers: svg('<path d="m12 3.6 8.4 4.5-8.4 4.5-8.4-4.5z"/><path d="m3.6 12.4 8.4 4.5 8.4-4.5"/><path d="m3.6 16.6 8.4 4.5 8.4-4.5"/>'),
  palette: svg('<path d="M12 3.4a8.6 8.6 0 1 0 0 17.2c1.3 0 2-.9 2-1.9 0-.9-.6-1.4-.6-2.2 0-.9.8-1.6 1.8-1.6h1.3c2 0 3.5-1.5 3.5-3.5 0-4.5-3.7-8-8-8Z"/><circle cx="8.5" cy="9.3" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="7.5" r="1" fill="currentColor" stroke="none"/><circle cx="7" cy="13.2" r="1" fill="currentColor" stroke="none"/>'),
  key: svg('<circle cx="8.2" cy="8.2" r="4.2"/><path d="m11.2 11.2 8.4 8.4M16.6 16.6l1.9-1.9M14.4 14.4l1.9-1.9"/>'),
  database: svg('<ellipse cx="12" cy="6.2" rx="7.4" ry="3.1"/><path d="M4.6 6.2v5.6c0 1.7 3.3 3.1 7.4 3.1s7.4-1.4 7.4-3.1V6.2"/><path d="M4.6 11.8v5.6c0 1.7 3.3 3.1 7.4 3.1s7.4-1.4 7.4-3.1v-5.6"/>'),
  cloud: svg('<path d="M7.6 18.4h9.1a3.5 3.5 0 0 0 .4-7 5.1 5.1 0 0 0-9.8-1.1 3.8 3.8 0 0 0 .3 8.1Z"/>'),
  info: svg('<circle cx="12" cy="12" r="8.6"/><path d="M12 11.2v5.1"/><circle cx="12" cy="8.1" r="1" fill="currentColor" stroke="none"/>'),
  sun: svg16('<circle cx="8" cy="8" r="3"/><path d="M8 1.2v1.6M8 13.2v1.6M1.2 8h1.6M13.2 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1"/>'),
  moon: svg16('<path d="M13 9.4A5.6 5.6 0 0 1 6.6 3a5.6 5.6 0 1 0 6.4 6.4Z"/>'),
  auto: svg16('<circle cx="8" cy="8" r="6"/><path d="M8 2a6 6 0 0 0 0 12Z" fill="currentColor" stroke="none"/>'),
  power: svg16('<path d="M8 2.2v5.4"/><path d="M4.6 4.4a5.4 5.4 0 1 0 6.8 0"/>'),
  back: svg16('<path d="M9.5 3.5 5 8l4.5 4.5"/>'),
};

/** 标题两行单元：主标题 + 副标题（副标题为空时不渲染）；attrs 用于挂本地化标记 */
export function titleCell(title, sub = '', attrs = '', subAttrs = '') {
  const a = attrs ? ` ${attrs}` : '';
  const s = subAttrs ? ` ${subAttrs}` : '';
  return `<div class="title-cell"><div class="title-main"${a}>${esc(title || '—')}</div>${
    sub ? `<div class="title-sub"${s}>${esc(sub)}</div>` : ''
  }</div>`;
}

/** 海报/缩略图：加载失败自动降级为占位块，不再显示裂图 */
export function posterImg(src, cls = 'thumb') {
  return `<img class="${cls}" loading="lazy" alt="" src="${esc(src)}"
    onerror="this.classList.add('thumb-empty');this.removeAttribute('src')" />`;
}

/** 首次加载骨架（不用 spinner） */
export function loadingBox(label = '') {
  return `<div class="empty"><span class="skeleton" style="display:inline-block;width:180px"></span>${
    label ? `<div class="title-sub" style="margin-top:8px">${esc(label)}</div>` : ''
  }</div>`;
}

/** 空态：无数据 / 无筛选结果，可给下一步引导 */
export function emptyState(text, { icon = 'inbox', hint = '' } = {}) {
  return `<div class="empty"><span class="em">${ICON[icon] || ICON.inbox}</span>${esc(text)}${
    hint ? `<div class="title-sub" style="margin-top:6px">${esc(hint)}</div>` : ''
  }</div>`;
}

/**
 * 错误态：与空态区分开，带原因摘要与「重试」按钮。
 * err 可以是 Error 或字符串；带 kind/waitSec（服务端出站层下发）时给出对应原因与等待建议。
 */
export function errorState(err, { retryLabel = '重试' } = {}) {
  const msg = typeof err === 'string' ? err : err?.message || '加载失败';
  const wait = Number(err?.waitSec || 0);
  const cause =
    err?.kind === 'network'
      ? '连不上 Trakt（本机网络或上游不可达）'
      : err?.kind === 'rate'
        ? `被 Trakt 限流${wait ? `，建议等待约 ${wait} 秒再试` : '，请稍后再试'}`
        : err?.kind === 'server'
          ? 'Trakt 服务暂时不可用，稍后自动恢复'
          : err?.kind === 'auth'
            ? '登录已失效，请重新登录'
            : '';
  return `<div class="error-box">
    <span class="em">${ICON.alert}</span>
    <div class="error-msg">${esc(msg)}</div>
    ${cause ? `<div class="error-cause">${esc(cause)}</div>` : ''}
    <div class="modal-actions" style="justify-content:center;margin-top:12px">
      <button class="btn btn-sm" data-retry>${esc(retryLabel)}</button>
    </div>
  </div>`;
}

/** 绑定错误态里的「重试」按钮 */
export function bindRetry(root, fn) {
  root.querySelectorAll('[data-retry]').forEach((b) => (b.onclick = fn));
}

/**
 * 通用分页器：计数 + 上一页 / 跳页 / 下一页。
 * meta: { page, pageCount, itemCount }；onGo(page) 决定怎么重新取数。
 * 只依赖传入元素的 querySelector，便于单测。
 */
export function mountPager(el, meta, onGo, fmt = num) {
  const page = Math.max(1, Number(meta?.page || 1));
  const pageCount = Math.max(1, Number(meta?.pageCount || 1));
  const hasCount = meta?.itemCount != null && meta.itemCount !== '';
  el.hidden = false;
  el.innerHTML = `<div>第 ${page} / ${pageCount} 页${hasCount ? ` · 共 ${fmt(meta.itemCount)} 条` : ''}</div>
    <div class="pager-btns">
      <button class="btn btn-sm" data-pg="prev" ${page <= 1 ? 'disabled' : ''}>上一页</button>
      <input data-pg="jump" type="number" min="1" max="${pageCount}" value="${page}" />
      <button class="btn btn-sm" data-pg="go">跳转</button>
      <button class="btn btn-sm" data-pg="next" ${page >= pageCount ? 'disabled' : ''}>下一页</button>
    </div>`;
  const q = (s) => el.querySelector(s);
  q('[data-pg="prev"]').onclick = () => onGo(Math.max(1, page - 1));
  q('[data-pg="next"]').onclick = () => onGo(Math.min(pageCount, page + 1));
  q('[data-pg="go"]').onclick = () => {
    const v = Number(q('[data-pg="jump"]').value) || 1;
    onGo(Math.min(pageCount, Math.max(1, v)));
  };
}
