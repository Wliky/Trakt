// 前端通用片段：纯渲染 + 局部绑定，无框架、无构建（浏览器 ES Module）
// 业务与路由逻辑仍留在 app.js，这里只放各列表页共用的「原子件」

import { getLang } from './i18n.js';

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
  calendar: svg('<rect x="3.4" y="5.2" width="17.2" height="15" rx="2.4"/><path d="M8.2 3.4v3.4M15.8 3.4v3.4M3.4 10.4h17.2"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.4"/><path d="M12 7.4V12l3.2 1.9"/>'),
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
  menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  panel: svg('<rect x="3.4" y="4.4" width="17.2" height="15.2" rx="2.4"/><path d="M9.6 4.4v15.2"/>'),
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

/**
 * 首次加载骨架（不用 spinner）：一条来回扫的进度条 + 一行「正在加载」。
 * 文案全站统一（不再按页面各写「正在读取…」），居中靠 .empty 的 grid-column 兜底，
 * 放进 7 列日历网格里也不会被压成一列宽。
 */
export function loadingBox() {
  return `<div class="empty loading-box" role="status" aria-live="polite">
    <span class="load-bar"><i></i></span>
    <span class="load-text">正在加载</span>
  </div>`;
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

/* ───────── 年月选择浮层（概览 / 追剧 / 记录 共用） ─────────
   点标题弹出：左列选年、右列选月，选完即关；‹ › 翻页按钮保持原样。
   用锚定浮层而不是居中遮罩——选年月时还看得见日历本身，也不多一次「确定」。 */

const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const isEnUi = () => getLang() === 'en-US';
const monthText = (m) => (isEnUi() ? MONTHS_EN[m - 1] : `${m} 月`);

let activePicker = null;

/** 关掉当前打开的锚定浮层（年月 / 日期 / 时间 / 星期 / 几号，没有则什么都不做） */
export function closePicker() {
  if (!activePicker) return;
  const p = activePicker;
  activePicker = null;
  p.anchor.setAttribute('aria-expanded', 'false');
  p.pop.remove();
  document.removeEventListener('pointerdown', p.onOutside, true);
  document.removeEventListener('keydown', p.onKey, true);
  window.removeEventListener('resize', p.onViewport, true);
  window.removeEventListener('scroll', p.onViewport, true);
}

/** 兼容旧名：年月浮层也走同一套 */
export const closeMonthPicker = closePicker;

/**
 * 建浮层并挂上全局关闭逻辑（外部点击 / ESC / 视口变化）。
 * 同一个触发按钮再点一次就是收起，此时返回 null。
 */
function openPicker(anchor, { cls = 'ym-pop', label = '' } = {}) {
  if (activePicker && activePicker.anchor === anchor) {
    closePicker();
    return null;
  }
  closePicker();
  const pop = document.createElement('div');
  pop.className = `pick-pop ${cls}`.trim();
  pop.setAttribute('role', 'dialog');
  if (label) pop.setAttribute('aria-label', label);
  document.body.appendChild(pop);

  // 贴在触发按钮下方；底下放不下就翻到上方，两侧留 12px 安全边
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const gap = 6;
    const left = Math.max(12, Math.min(r.left, window.innerWidth - pop.offsetWidth - 12));
    let top = r.bottom + gap;
    if (top + pop.offsetHeight > window.innerHeight - 12) top = Math.max(12, r.top - pop.offsetHeight - gap);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  };

  const onOutside = (e) => {
    if (pop.contains(e.target) || anchor.contains(e.target)) return;
    closePicker();
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    // 浮层可能开在弹窗里，别让这次 ESC 顺带把弹窗也关了
    e.stopPropagation();
    closePicker();
  };
  // 页面滚动 / 改窗口就收起；但浮层自己的滚动（时间滚轮）不算
  const onViewport = (e) => {
    const t = e && e.target;
    if (t && t.nodeType && pop.contains(t)) return;
    closePicker();
  };

  activePicker = { anchor, pop, onOutside, onKey, onViewport };
  anchor.setAttribute('aria-expanded', 'true');
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onViewport, true);
  window.addEventListener('scroll', onViewport, true);
  return { pop, place };
}

/**
 * 年月双栏的骨架。日历页的年月浮层（mountMonthPicker）与日期浮层的
 * 「切换年月」视图共用这一份 DOM，改结构只改这里。
 * startYear：年列从哪年开始（共 12 个）；selYear/selMonth：当前高亮项；
 * curYear：已经定下的年份（只有它下面的月份才高亮）。
 */
function ymColsHtml({ startYear, selYear, selMonth = 0, curYear, withMonth = true }) {
  const nowY = new Date().getFullYear();
  const years = Array.from({ length: 12 }, (_, i) => startYear + i);
  return `
      <div class="ym-col ym-years">
        <div class="ym-head">
          <button type="button" class="ym-nav" data-yshift="-1" aria-label="${isEnUi() ? 'Earlier' : '更早'}">‹</button>
          <b>${years[0]}–${years[years.length - 1]}</b>
          <button type="button" class="ym-nav" data-yshift="1" aria-label="${isEnUi() ? 'Later' : '更晚'}">›</button>
        </div>
        <div class="ym-grid">${years
          .map(
            (y) =>
              `<button type="button" class="ym-btn${y === selYear ? ' on' : ''}${y === nowY ? ' now' : ''}" data-y="${y}">${y}</button>`
          )
          .join('')}</div>
      </div>
      ${
        withMonth
          ? `<div class="ym-col ym-months">
        <div class="ym-head"><b>${selYear}${isEnUi() ? '' : ' 年'}</b></div>
        <div class="ym-grid">${Array.from({ length: 12 }, (_, i) => i + 1)
          .map(
            (m) =>
              `<button type="button" class="ym-btn${
                selYear === curYear && m === selMonth ? ' on' : ''
              }" data-m="${m}">${monthText(m)}</button>`
          )
          .join('')}</div>
      </div>`
          : ''
      }`;
}

/**
 * anchor：触发按钮；year / month：当前查看的年月；
 * withMonth=false 时只选年（概览的「年度」视图）；onPick(y, m) 由调用方写路由。
 */
export function mountMonthPicker(anchor, { year, month = 0, withMonth = true, onPick } = {}) {
  const nowY = new Date().getFullYear();
  const curY = Number(year) || nowY;
  const curM = Number(month) || 0;
  let pendingYear = curY;
  let startYear = curY - 6;

  const opened = openPicker(anchor, {
    cls: withMonth ? 'ym-pop' : 'ym-pop ym-year-only',
    label: isEnUi() ? 'Select year and month' : '选择年月',
  });
  if (!opened) return; // 再点一次同一个按钮 = 收起
  const { pop, place } = opened;

  const finish = (y, m) => {
    closePicker();
    if (onPick) onPick(y, m);
  };

  const render = () => {
    pop.innerHTML = ymColsHtml({ startYear, selYear: pendingYear, selMonth: curM, curYear: curY, withMonth });
  };

  render();
  place();

  pop.onclick = (e) => {
    const nav = e.target.closest('[data-yshift]');
    if (nav) {
      startYear += Number(nav.dataset.yshift) * 12;
      render();
      place();
      return;
    }
    const yb = e.target.closest('[data-y]');
    if (yb) {
      pendingYear = Number(yb.dataset.y);
      if (!withMonth) return finish(pendingYear, 0);
      render();
      place();
      pop.querySelector(`[data-y="${pendingYear}"]`)?.focus({ preventScroll: true });
      return;
    }
    const mb = e.target.closest('[data-m]');
    if (mb) finish(pendingYear, Number(mb.dataset.m));
  };

  pop.querySelector('.ym-btn.on')?.focus({ preventScroll: true });
}

/* ───────── 日期选择（月历） ─────────
   替代原生 <input type="date">：原生控件各浏览器长得都不一样，
   而这里的观感与「年月」浮层完全一致（同一套 .pick-pop）。 */

const DOW_CN = ['一', '二', '三', '四', '五', '六', '日'];
const DOW_EN = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const pad2 = (n) => String(n).padStart(2, '0');
const dayKey = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

/**
 * 月历浮层：周一起始，点日期即回传 "YYYY-MM-DD"；
 * clearable=true 时底部给「清除」（回传空串）。
 */
export function mountDatePicker(anchor, { value = '', onPick, clearable = false } = {}) {
  const now = new Date();
  const todayKey = dayKey(now.getFullYear(), now.getMonth() + 1, now.getDate());
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? new Date(`${value}T00:00:00`) : now;
  let viewY = start.getFullYear();
  let viewM = start.getMonth() + 1;
  // 头部年月是一个按钮：点开切到「年月双栏」（就是日历页那套 ymColsHtml），选完月回到日历
  let mode = 'day';
  let ymYear = viewY;
  let ymStart = viewY - 6;

  const opened = openPicker(anchor, { cls: 'ym-pop pick-cal', label: isEnUi() ? 'Select date' : '选择日期' });
  if (!opened) return;
  const { pop, place } = opened;

  const render = () => {
    if (mode === 'ym') {
      pop.classList.add('pick-cal-wide');
      pop.innerHTML = `
        <div class="pick-cal-head">
          <button type="button" class="ym-nav" data-back aria-label="${isEnUi() ? 'Back to calendar' : '返回日历'}">‹</button>
          <b class="pick-cal-label">${isEnUi() ? 'Year & month' : '选择年月'}</b>
          <span class="pick-head-spacer"></span>
        </div>
        <div class="pick-cal-ym">${ymColsHtml({ startYear: ymStart, selYear: ymYear, selMonth: viewM, curYear: viewY })}</div>`;
      return;
    }
    pop.classList.remove('pick-cal-wide');
    const lead = (new Date(viewY, viewM - 1, 1).getDay() + 6) % 7;
    const days = new Date(viewY, viewM, 0).getDate();
    const prevDays = new Date(viewY, viewM - 1, 0).getDate();
    const cells = [];
    for (let i = lead; i > 0; i--) {
      cells.push({ d: prevDays - i + 1, key: dayKey(viewM === 1 ? viewY - 1 : viewY, viewM === 1 ? 12 : viewM - 1, prevDays - i + 1), out: true });
    }
    for (let d = 1; d <= days; d++) cells.push({ d, key: dayKey(viewY, viewM, d), out: false });
    const tail = (7 - (cells.length % 7)) % 7;
    for (let d = 1; d <= tail; d++) {
      cells.push({ d, key: dayKey(viewM === 12 ? viewY + 1 : viewY, viewM === 12 ? 1 : viewM + 1, d), out: true });
    }
    pop.innerHTML = `
      <div class="pick-cal-head">
        <button type="button" class="ym-nav" data-nav="-1" aria-label="${isEnUi() ? 'Previous month' : '上个月'}">‹</button>
        <button type="button" class="pick-cal-title" data-ym aria-haspopup="dialog" aria-expanded="false" title="${isEnUi() ? 'Pick year & month' : '选择年月'}">${viewY}${isEnUi() ? ` ${MONTHS_EN[viewM - 1]}` : ` 年 ${viewM} 月`}<i class="pick-caret"></i></button>
        <button type="button" class="ym-nav" data-nav="1" aria-label="${isEnUi() ? 'Next month' : '下个月'}">›</button>
      </div>
      <div class="pick-dow">${(isEnUi() ? DOW_EN : DOW_CN).map((t) => `<span>${t}</span>`).join('')}</div>
      <div class="pick-days">${cells
        .map(
          (c) =>
            `<button type="button" class="pick-day${c.out ? ' out' : ''}${c.key === value ? ' on' : ''}${
              c.key === todayKey ? ' today' : ''
            }" data-d="${c.key}">${c.d}</button>`
        )
        .join('')}</div>
      <div class="pick-foot">${clearable ? `<button type="button" data-clear>${isEnUi() ? 'Clear' : '清除'}</button>` : '<span></span>'}<button type="button" data-today>${isEnUi() ? 'Today' : '今天'}</button></div>`;
  };
  render();
  place();

  pop.onclick = (e) => {
    // 头部标题 / 返回：日历 ↔ 年月双栏
    if (e.target.closest('[data-ym]')) {
      mode = 'ym';
      ymYear = viewY;
      ymStart = viewY - 6;
      render();
      place();
      pop.querySelector('.ym-btn.on')?.focus({ preventScroll: true });
      return;
    }
    if (e.target.closest('[data-back]')) {
      mode = 'day';
      render();
      place();
      return;
    }
    // 年月视图：翻年组 / 选年 / 选月（选月即回到日历）
    const shift = e.target.closest('[data-yshift]');
    if (shift) {
      ymStart += Number(shift.dataset.yshift) * 12;
      render();
      place();
      return;
    }
    const yb = e.target.closest('[data-y]');
    if (yb) {
      ymYear = Number(yb.dataset.y);
      render();
      place();
      pop.querySelector(`[data-y="${ymYear}"]`)?.focus({ preventScroll: true });
      return;
    }
    const mb = e.target.closest('[data-m]');
    if (mb) {
      viewY = ymYear;
      viewM = Number(mb.dataset.m);
      mode = 'day';
      render();
      place();
      return;
    }
    const nav = e.target.closest('[data-nav]');
    if (nav) {
      const d = new Date(viewY, viewM - 1 + Number(nav.dataset.nav), 1);
      viewY = d.getFullYear();
      viewM = d.getMonth() + 1;
      render();
      place();
      return;
    }
    const day = e.target.closest('[data-d]');
    if (day) {
      closePicker();
      onPick?.(day.dataset.d);
      return;
    }
    if (e.target.closest('[data-clear]')) {
      closePicker();
      onPick?.('');
      return;
    }
    if (e.target.closest('[data-today]')) {
      closePicker();
      onPick?.(todayKey);
    }
  };
  pop.querySelector('.pick-day.on')?.focus({ preventScroll: true });
}

/* ───────── 时间选择（时 / 分各一列滚轮） ─────────
   两列各自滚动、选中项居中吸附（上下留白由 .pick-time-pad 撑出）；
   滚动停下才改值，按「确定」或点「现在」才回传 "HH:MM"。 */

const TIME_ITEM_H = 32; // 与 styles.css 的 .pick-time-item height 一致
const TIME_VIEW_H = 160; // 与 styles.css 的 .pick-time-col height 一致

export function mountTimePicker(anchor, { value = '', onPick } = {}) {
  const now = new Date();
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
  let hh = m ? Math.min(23, Number(m[1])) : now.getHours();
  let mm = m ? Math.min(59, Number(m[2])) : now.getMinutes();

  const opened = openPicker(anchor, { cls: 'ym-pop pick-time', label: isEnUi() ? 'Select time' : '选择时间' });
  if (!opened) return;
  const { pop, place } = opened;

  const padH = (TIME_VIEW_H - TIME_ITEM_H) / 2;
  const column = (count, sel, attr, label) => `
    <div class="pick-time-col" data-col="${attr}" role="listbox" aria-label="${label}" tabindex="0">
      <div class="pick-time-pad" style="height:${padH}px"></div>
      ${Array.from({ length: count }, (_, i) => `<button type="button" class="pick-time-item${i === sel ? ' on' : ''}" data-${attr}="${i}">${pad2(i)}</button>`).join('')}
      <div class="pick-time-pad" style="height:${padH}px"></div>
    </div>`;

  pop.innerHTML = `
    <div class="pick-time-head"><span>${isEnUi() ? 'Hour' : '时'}</span><span>${isEnUi() ? 'Min' : '分'}</span></div>
    <div class="pick-time-body">
      ${column(24, hh, 'h', isEnUi() ? 'Hour' : '时')}
      ${column(60, mm, 'm', isEnUi() ? 'Minute' : '分')}
    </div>
    <div class="pick-foot"><button type="button" data-now>${isEnUi() ? 'Now' : '现在'}</button><button type="button" data-ok>${isEnUi() ? 'Done' : '确定'}</button></div>`;
  place();

  const cols = { h: pop.querySelector('[data-col="h"]'), m: pop.querySelector('[data-col="m"]') };
  const mark = (col, idx) => col.querySelectorAll('.pick-time-item').forEach((b, i) => b.classList.toggle('on', i === idx));
  const jumpTo = (col, idx) => {
    col.scrollTop = idx * TIME_ITEM_H;
  };

  jumpTo(cols.h, hh);
  jumpTo(cols.m, mm);

  // 滚动停下后再取值：scrollTop 按行高对齐，四舍五入就是选中项
  const timers = { h: 0, m: 0 };
  const watch = (key, max, set) => {
    cols[key].addEventListener(
      'scroll',
      () => {
        clearTimeout(timers[key]);
        timers[key] = setTimeout(() => {
          const i = Math.max(0, Math.min(max, Math.round(cols[key].scrollTop / TIME_ITEM_H)));
          set(i);
          mark(cols[key], i);
        }, 90);
      },
      { passive: true }
    );
  };
  watch('h', 23, (i) => (hh = i));
  watch('m', 59, (i) => (mm = i));

  // 键盘：列可聚焦，上下键逐格调
  Object.entries(cols).forEach(([key, col]) => {
    col.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const max = key === 'h' ? 23 : 59;
      const next = Math.max(0, Math.min(max, (key === 'h' ? hh : mm) + (e.key === 'ArrowDown' ? 1 : -1)));
      if (key === 'h') hh = next;
      else mm = next;
      mark(col, next);
      jumpTo(col, next);
    });
  });

  const commit = () => {
    closePicker();
    onPick?.(`${pad2(hh)}:${pad2(mm)}`);
  };

  pop.onclick = (e) => {
    const h = e.target.closest('[data-h]');
    if (h) {
      hh = Number(h.dataset.h);
      mark(cols.h, hh);
      jumpTo(cols.h, hh);
      return;
    }
    const mi = e.target.closest('[data-m]');
    if (mi) {
      mm = Number(mi.dataset.m);
      mark(cols.m, mm);
      jumpTo(cols.m, mm);
      return;
    }
    if (e.target.closest('[data-now]')) {
      const d = new Date();
      hh = d.getHours();
      mm = d.getMinutes();
      mark(cols.h, hh);
      mark(cols.m, mm);
      jumpTo(cols.h, hh);
      jumpTo(cols.m, mm);
      commit();
      return;
    }
    if (e.target.closest('[data-ok]')) commit();
  };
  cols.h.focus({ preventScroll: true });
}

/* ───────── 枚举选择（星期 / 每月几号） ───────── */

/**
 * options: [{ value, label }]，点选即回传；cols 决定网格列数。
 * width 是浮层宽度（默认 268，和日历同宽）；2–5 项的短列表传窄一点，别空半张。
 * align：选项文字居中（数字，默认）还是靠左（列表名、短语）。
 */
export function mountChoicePicker(anchor, { options = [], value = '', cols = 4, label = '', width = 268, align = 'center', onPick } = {}) {
  const opened = openPicker(anchor, { cls: 'ym-pop pick-choice', label });
  if (!opened) return;
  const { pop, place } = opened;
  const w = Math.max(120, Math.round(Number(width) || 268));
  if (w !== 268) {
    pop.style.width = `${w}px`;
    pop.style.minWidth = '0'; // .pick-pop 的 min-width: 268px 不让 < 268 的窄版生效
  }
  if (align === 'left') pop.classList.add('pick-choice-left');
  pop.innerHTML = `<div class="pick-choice-grid" style="grid-template-columns: repeat(${Math.max(1, Number(cols) || 4)}, minmax(0, 1fr))">${options
    .map(
      (o) =>
        `<button type="button" class="ym-btn${String(o.value) === String(value) ? ' on' : ''}" data-v="${esc(String(o.value))}">${esc(o.label)}</button>`
    )
    .join('')}</div>`;
  place();
  pop.onclick = (e) => {
    const b = e.target.closest('[data-v]');
    if (!b) return;
    closePicker();
    onPick?.(b.dataset.v);
  };
  pop.querySelector('.ym-btn.on')?.focus({ preventScroll: true });
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
