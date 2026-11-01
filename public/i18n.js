/**
 * 界面文案 i18n（零依赖、无构建）
 *
 * 做法：中文是源语言（模板里本来就写中文），这里维护一份英文映射，运行时把
 * 文本节点 / title / placeholder / aria-label 换成当前语言。这样不用把 4000 多行
 * 模板里的字符串逐个抽 key，也不会因为漏改而出现「半个界面英文半个中文」的 key 缺失。
 *
 * 覆盖范围：导航、页面标题、按钮、表头、空态、批量条、设置项、详情页操作等
 * 高频界面文案；剧名/人名等数据内容永远不翻译。
 * 局限：长段落说明文案保留中文（字典里没有就原样输出）。
 */
const LANG_KEY = 'tm_lang';
const SOURCE = 'zh-CN';
export const LANGS = [
  ['zh-CN', '中文'],
  ['en-US', 'English'],
];

let lang = SOURCE;
try {
  const saved = localStorage.getItem(LANG_KEY);
  if (LANGS.some(([k]) => k === saved)) lang = saved;
} catch {}

export const getLang = () => lang;

/**
 * 切语言：先记住源文再整页重算，因此切回中文能把已翻过的节点还原。
 * 以前只换变量不重画，界面会残留上一门语言的文本（中英混排的根源）。
 */
export function setLang(next) {
  if (!LANGS.some(([k]) => k === next)) return;
  lang = next;
  try {
    localStorage.setItem(LANG_KEY, next);
  } catch {}
  document.documentElement.lang = next;
  if (typeof document !== 'undefined' && document.body) {
    ensureObserver();
    applyI18n(document.body);
  }
}

const EN = {
  // 导航与分节
  概览: 'Overview',
  追剧: 'Tracking',
  记录: 'Records',
  片单: 'Library',
  搜索: 'Search',
  设置: 'Settings',
  数据管理: 'Data manager',
  '观看历史': 'History',
  评分: 'Ratings',
  收藏: 'Favorites',
  待看: 'Watchlist',
  我的列表: 'My lists',
  统计: 'Stats',

  // 概览
  本月观看: 'This month',
  今日观看: 'Today',
  本周观看: 'This week',
  观影感受: 'How it felt',
  观看类型: 'Genres',
  继续观看: 'Continue watching',
  累计观看: 'Total watched',
  查看全部: 'View all',
  '查看全部 ›': 'View all ›',
  比上月同期: 'vs. last month',
  比上周同期: 'vs. last week',
  比前一天: 'vs. yesterday',
  这个月: 'This month',
  这一年: 'This year',
  本年观看: 'This year',
  仅统计最近部分: 'recent slice only',
  '按最近观看倒序': 'Sorted by recent activity',
  没有待看的条目: 'Nothing to continue',
  在看的剧有新一集播出时会出现在这里: 'New episodes of shows you watch show up here',
  下一集: 'Next up',
  所选时段暂无观看记录: 'No plays in this period',
  所选时段暂无观影感受: 'No ratings in this period',
  未知条目: 'Unknown item',
  未分类: 'Untagged',
  月度: 'Month',
  年度: 'Year',
  小时: 'h',
  部电影: 'movies',
  集剧集: 'episodes',
  次观看: 'plays',
  按暂停时间倒序: 'Newest pause first',
  '数据较多，只统计了最近的一部分': 'Lots of data — only the most recent part is counted',
  持平: 'No change',
  新增观看: 'New',
  少: 'Less',
  多: 'More',
  统计周期: 'Period',
  上一月: 'Previous month',
  下一月: 'Next month',
  上一年: 'Previous year',
  下一年: 'Next year',

  // 搜索
  最近搜索: 'Recent',
  清空: 'Clear',
  已加入待看: 'Added to watchlist',
  已在待看: 'In watchlist',
  已看: 'Watched',
  已观看: 'Watched',
  已播出: 'Aired',
  待播出: 'Upcoming',
  '播出日期按 Trakt 排期展示，实际平台上线时间可能有出入。':
    'Air dates come from Trakt schedules; actual release times can differ by platform.',
  '来自 Trakt 观看历史 · 悬停格子可看当天片名': "From your Trakt history · Hover a cell to see that day's titles",
  '来自「在看」列表 · 悬停格子可看当天剧名': 'From your watchlist · Hover a cell to see that day’s shows',
  '换个关键词，或试试原名': 'Try another keyword or the original title',
  输入关键词开始搜索: 'Type a keyword to start searching',
  试试这些: 'Try these',
  搜索电影或剧集: 'Search movies or shows',
  评分: 'Rating',
  '支持中英文片名与原名': 'Chinese titles, English titles, and original titles all work',
  '输入电影或剧集名称（支持中英文）': 'Movie or show name (Chinese or English)',

  // 片单表格
  加入时间: 'Added',
  操作: 'Actions',
  全选: 'Select all',
  '筛选标题…': 'Filter titles…',
  全选当前结果: 'Select all results',
  取消选择: 'Clear selection',
  '移出 Watchlist': 'Remove from Watchlist',
  取消收藏: 'Remove from favorites',
  '导出 CSV': 'Export CSV',
  '导出 JSON': 'Export JSON',
  导出: 'Export',
  返回记录: 'Back to history',
  当前计划: 'Schedule',
  自定义列表: 'Custom lists',
  'Watchlist 是空的': 'Watchlist is empty',

  // 通用
  电影: 'Movie',
  剧集: 'Show',
  分集: 'Episode',
  全部: 'All',
  类型: 'Type',
  标题: 'Title',
  年份: 'Year',
  暂无: 'None',
  未知: 'Unknown',
  取消: 'Cancel',
  确定: 'OK',
  保存: 'Save',
  '保存中…': 'Saving…',
  删除: 'Delete',
  移除: 'Remove',
  展开: 'Expand',
  收起: 'Collapse',
  重试: 'Retry',
  正在加载: 'Loading…',
  更多: 'More',
  上一页: 'Prev',
  下一页: 'Next',
  上一月: 'Prev month',
  下一月: 'Next month',
  今天: 'Today',
  全选当前结果: 'Select all results',
  取消选择: 'Clear selection',
  已选: 'Selected',
  项: 'items',
  或者: 'or',
  复制: 'Copy',
  已复制: 'Copied',
  关闭: 'Close',
  导出: 'Export',
  加入: 'Add',

  // 列表/表格
  海报: 'Poster',
  加入时间: 'Added',
  最近观看: 'Last watched',
  观看时间: 'Watched at',
  操作: 'Actions',
  '筛选标题…': 'Filter titles…',
  匹配: 'Matched',
  共: 'Total',
  没有匹配: 'No matches for',

  // 列表页
  导出CSV: 'Export CSV',
  '导出 CSV': 'Export CSV',
  移出Watchlist: 'Remove from watchlist',
  '移出 Watchlist': 'Remove from watchlist',
  取消收藏: 'Remove from favorites',
  私有: 'Private',
  无描述: 'No description',
  'Watchlist 是空的': 'Watchlist is empty',
  还没有收藏的电影或剧集: 'No favorite movies or shows yet',
  '想看的电影/剧集': 'Movies and shows you plan to watch',

  // 详情页
  剧集信息: 'Show info',
  季: 'Season',
  标记已看: 'Mark watched',
  取消标记: 'Unmark',
  取消已看: 'Unmark watched',
  加入待看: 'Add to watchlist',
  移出待看: 'Remove from watchlist',
  加入收藏: 'Add to favorites',
  移除收藏: 'Remove from favorites',
  上次看到: 'Last watched',
  继续观看: 'Continue watching',
  还差: 'left',
  已看完: 'All watched',
  暂无简介: 'No overview',
  整季已看: 'Mark season watched',
  整季取消: 'Unmark season',
  正在处理: 'Working…',
  选集: 'Selected episode',
  剧集管理: 'Episode manager',
  '选集查看剧照、简介与操作': 'Select an episode to view artwork, details, and actions',
  搜索集数或标题: 'Search number or title',
  全部状态: 'All statuses',
  已看: 'Watched',
  未看: 'Unwatched',
  未播: 'Unaired',
  状态: 'Status',
  首播: 'First aired',
  时长: 'Runtime',
  特别篇: 'Specials',
  标记看过: 'Mark watched',
  暂无分集数据: 'No episode data',
  没有匹配的分集: 'No matching episodes',
  稍后刷新重试: 'Refresh and try again later',
  暂无本集简介: 'No episode overview',
  '观看状态暂未同步，列表可能不是最新。': 'Watch status is not synced; this list may be out of date.',
  应用: 'Apply',
  确认: 'Confirm',
  语言: 'Language',
  中文: 'Chinese',
  '界面与影视信息共用一套，切换后整页刷新': 'One setting for both the interface and metadata; the page reloads after switching',
  '主题、语言与全局背景': 'Theme, language, and global background',
  '跟随系统或固定深浅色': 'Follow the system or choose a fixed theme',
  '影视封面轮播与暗度': 'Artwork rotation and dimming',
  '影视标题、简介与高清剧照': 'Titles, overviews, and high-resolution artwork',
  'Key 仅保存在服务端。可在 themoviedb.org 免费申请。': 'The key stays on the server. Get one free at themoviedb.org.',
  封面: 'Cover',
  '待看与收藏；切换在表格顶部，勾选后可批量处理':
    'Watchlist and favorites — switch at the top of the table, select rows to act in bulk',
  '搜索 Trakt 全站，可直接加入待看':
    'Search all of Trakt — add anything to your watchlist right away',

  // 详情页管理卡（已从封面右侧移到封面下方）
  管理: 'Manage',
  标记所选已看: 'Mark selected watched',
  清空选择: 'Clear selection',
  选择本页全部分集: 'Select all episodes on this page',
  '各集发布日（分别按各自首播日写入）': 'Release date (each episode uses its own air date)',
  '先勾选要标记的分集': 'Select episodes to mark first',
  '这个条目缺少 Trakt id，无法操作': 'This item has no Trakt id, so it cannot be updated',

  // 设置
  连接: 'Connection',
  账号: 'Account',
  外观: 'Appearance',
  外观与语言: 'Appearance and language',
  '外观、媒体来源与数据备份': 'Appearance, media sources and backups',
  沉浸背景: 'Immersive background',
  媒体数据源: 'Media sources',
  'WebDAV 云备份': 'WebDAV cloud backup',
  运行状态: 'Runtime status',
  '版本化 JSON，只含你的观影数据，不含任何凭据': 'Versioned JSON — only your viewing data, never credentials',
  '粘贴 v3 key（32 位）或 v4 Read Access Token': 'Paste a v3 key (32 chars) or a v4 Read Access Token',
  未启用: 'Not scheduled',
  '当前生效的数据源与缓存策略': 'Active data source and cache policy',
  '填一个网盘 / NAS 目录（坚果云、Nextcloud、群晖），按计划自动上传并只保留最近 N 份':
    'Point it at a cloud drive or NAS folder (Jianguoyun, Nextcloud, Synology); it uploads on schedule and keeps only the latest N copies',
  '密码只保存在服务端，不会出现在备份文件里，也不会下发到浏览器；排程按你的浏览器时区折算。':
    'The password stays on the server: never in backups, never sent to the browser. Schedules use your browser timezone.',
  主题: 'Theme',
  浅色: 'Light',
  深色: 'Dark',
  跟随系统: 'System',
  'TMDB API Key': 'TMDB API Key',
  未配置: 'Not configured',
  已配置: 'Configured',
  清除: 'Clear',
  备份与恢复: 'Backup & restore',
  立即备份: 'Back up now',
  恢复: 'Restore',
  退出登录: 'Sign out',

  // 登录
  登录: 'Sign in',
  邮箱: 'Email',
  发送验证码: 'Send code',
  验证码: 'Code',
  验证: 'Verify',
  '数据来自 Trakt.tv 官方 API，用 Trakt 账号邮箱登录即可。':
    'Data comes from the official Trakt API — sign in with your Trakt account email.',

  // 错误/空态
  出错: 'Something went wrong',
  '加载失败': 'Failed to load',
  '没有数据': 'No data',
  网络错误: 'Network error',
  '登录已失效，请重新登录': 'Session expired, please sign in again',

  // 键盘/其他
  '搜索电影、剧集、人物…': 'Search movies, shows, people…',
  '搜索中…': 'Searching…',

  // 登录页
  观影中心: 'Viewing Center',
  '验证码已发送至': 'Sent to',
  '，5 分钟内有效。': ', valid for 5 minutes.',
  修改邮箱: 'Change email',
  重新发送验证码: 'Resend code',
  '还没有账号？': 'No account yet?',
  创建账号: 'Create account',

  // 设置页
  '媒体来源、数据备份与恢复': 'Media sources, backups, and restore',
  'TMDB API Key（可选）': 'TMDB API key (optional)',
  保存并校验: 'Save and verify',
  清除: 'Clear',
  数据备份与恢复: 'Backup and restore',
  查看备份范围: 'Preview backup scope',
  下载完整备份: 'Download full backup',
  '从备份文件恢复…': 'Restore from file…',
  'WebDAV 备份': 'WebDAV backup',
  自动备份设置: 'Automatic backup',
  启用自动备份: 'Enable automatic backup',
  连接: 'Connection',
  备份计划: 'Schedule',
  运行状态: 'Status',
  手动操作: 'Actions',
  服务器地址: 'Server URL',
  备份路径: 'Backup path',
  '留空则存到根目录，首次备份会自动创建子目录': 'Leave blank to use the root folder; it is created on first backup',
  '服务器地址（完整 URL）': 'Server URL',
  用户名: 'Username',
  '密码 / 应用专用密码': 'Password / app password',
  备份周期: 'Backup interval',
  '执行时间（本地时区）': 'Run time (local timezone)',
  每月几号: 'Day of month',
  保留份数: 'Copies to keep',
  测试连接: 'Test connection',
  保存设置: 'Save settings',
  备份状态: 'Backup status',
  上次备份: 'Last backup',
  备份结果: 'Result',
  备份文件: 'Backup file',
  下次备份: 'Next backup',
  备份数量: 'Backup count',
  立即备份一次: 'Back up now',
  查看远端备份: 'Remote backups',
  下载本地备份: 'Download local backup',
  从文件恢复: 'Restore from file',
  当前状态: 'Current status',
  尚无记录: 'No record yet',
  尚未配置: 'Not set yet',
  切换界面语言: 'Switch language',
  '未启用 · 保存后可手动备份': 'Disabled · save first to back up manually',
  已保存则留空: 'Leave blank to keep the saved one',
  每天: 'Daily',
  每周: 'Weekly',
  每月: 'Monthly',

  // 详情页整季
  '切换季查看全部分集，点击卡片管理单集': 'Switch seasons to see every episode; click a card to manage one',
  整季已看: 'Mark season watched',
  整季取消: 'Unmark season',
  '正在处理…': 'Working…',

  // 视图切换
  '☰ 列表': '☰ List',
  '▦ 网格': '▦ Grid',
  '切换列表 / 海报网格视图': 'Toggle list / poster grid',

  // 页面标题与说明
  '待看 / 我的列表': 'Watchlist / My lists',
  'Trakt 的 Favorites（最喜欢的电影/剧集）': 'Trakt Favorites (movies & shows you love)',
  '搜索 Trakt 全站影视；点行再看详情做标记 / 评分 / 加待看':
    'Search all of Trakt; open a row to mark watched, rate, or add to your watchlist',
  '按月查看看在剧集的播出排期，点某天在右侧看当天剧集':
    'Monthly air dates; pick a day to see that day\u2019s episodes',
  '观看节奏、类型分布与近期动态': 'Watch rhythm, genres, and recent activity',
  '按月回看观看记录，点某天在右侧看详情': 'Browse history by month; pick a day for details',
};

/** 动态文案：数字/名称变化的那些，用正则处理 */
const RULES = [
  [/^第 (\d+) 季$/, 'Season $1'],
  [/^第 (\d+) 集$/, 'Episode $1'],
  [/^第 (\d+) 季 · 第 (\d+) 集$/, 'S$1E$2'],
  [/^第 (\d+) 季 · (\d+) 集$/, 'Season $1 · $2 episodes'],
  [/^特别篇 · (\d+) 集$/, 'Specials · $1 episodes'],
  [/^本季已看 (\d+)\/(\d+)$/, '$1 of $2 watched this season'],
  [/^当前：(.+)$/, 'Current: $1'],
  [/^由服务端 TMDB_LANG 固定：(.+)$/, 'Fixed by server TMDB_LANG: $1'],
  [/^共 (\d+) 项$/, '$1 items'],
  [/^共 (\d+) 集$/, '$1 episodes'],
  // 多选标记：集数、发布日提示与结果 toast 都是动态文本，用规则翻译
  [/^已选 (\d+) 集：(.+)$/, 'Selected $1 episodes: $2'],
  [/^连带标记前面未看的 (\d+) 集$/, 'Also mark $1 previous unwatched episodes'],
  [/^有 (\d+) 集缺少首播日，选「各集发布日」时会跳过它们。$/, '$1 episodes have no air date; they will be skipped for release dates'],
  [/^多选已标记：新增 (\d+) 集，已存在 (\d+) 集$/, 'Marked selected: $1 added, $2 already watched'],
  [/^多选已标记：新增 (\d+) 集，已存在 (\d+) 集（含补标 (\d+) 集）$/, 'Marked selected: $1 added, $2 already watched, including $3 catch-up episodes'],
  [/^多选已标记：新增 (\d+) 集，已存在 (\d+) 集，跳过 (\d+) 集（无首播日）$/, 'Marked selected: $1 added, $2 already watched; skipped $3 with no air date'],
  [/^多选已标记：新增 (\d+) 集，已存在 (\d+) 集（含补标 (\d+) 集），跳过 (\d+) 集（无首播日）$/, 'Marked selected: $1 added, $2 already watched, including $3 catch-up episodes; skipped $4 with no air date'],
  [/^已选 (\d+) 项$/, '$1 selected'],
  [/^匹配 (\d+) \/ (\d+)$/, '$1 of $2'],
  [/^还差 (\d+) 集$/, '$1 episodes left'],
  [/^看到第 (\d+) 集$/, 'Watched $1 episodes'],
  [/^(\d+) 项$/, '$1 items'],
  [/^(\d+) 集$/, '$1 episodes'],
  [/^(\d+) 天$/, '$1 days'],
  [/^(\d+) 小时$/, '$1 hours'],
  [/^(\d+) 分钟$/, '$1 minutes'],
  [/^(\d+) 月$/, 'Month $1'],
  // 概览里的整句动态文案
  [/^(\d{4}) 年$/, '$1'],
  [/^(\d{4}) 年 (\d{1,2}) 月$/, '$2/$1'],
  [/^这个月，有 (\d+) 天与好故事相遇$/, 'Stories on $1 days this month'],
  [/^这一年，有 (\d+) 天与好故事相遇$/, 'Stories on $1 days this year'],
  [/^(\d+) \/ (\d+) 天有记录$/, '$1 of $2 days logged'],
  [/^共 (\d+) 次观看$/, '$1 plays'],
  [/^共 (\d+) 次感受$/, '$1 ratings'],
  [/^多 (.+) 小时$/, '+$1h'],
  [/^少 (.+) 小时$/, '-$1h'],
  [/^多 (\d+) 次$/, '+$1'],
  [/^少 (\d+) 次$/, '-$1'],
  [/^(\d+) 条$/, '$1'],
  [/^(\d+) 条记录 · (\d+) 部$/, '$1 plays · $2 titles'],
  [/^共 (\d+) 条记录$/, '$1 plays'],
  [/^本页 (\d+) 条 · 共 (.+) 条$/, '$1 on this page · $2 total'],
  [/^找到 (\d+) 条结果$/, '$1 results'],
  [/^没有匹配「(.+)」的结果$/, 'No results for “$1”'],
];

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);

/** 模板里的长段落带换行缩进，比对前把空白折叠掉，字典就能写单行 */
const squash = (s) => s.replace(/\s+/g, ' ').trim();
const EN_FLAT = Object.fromEntries(Object.entries(EN).map(([k, v]) => [squash(k), v]));

/** 先按原样查，再按折叠空白查（两者都没有就返回空） */
function lookup(body) {
  if (EN[body] !== undefined) return EN[body];
  const flat = EN_FLAT[squash(body)];
  return flat;
}

function byRules(str) {
  for (const [re, rep] of RULES) if (re.test(str)) return str.replace(re, rep);
  return str;
}

/** 翻译单段文本（不含前后空白）；查不到就原样返回 */
export function t(zh) {
  if (lang === SOURCE) return zh;
  const hit = lookup(zh);
  return hit !== undefined ? hit : byRules(zh);
}

function trText(raw) {
  if (lang === SOURCE) return raw;
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
  if (!m || !m[2]) return raw;
  const body = m[2];
  const hit = lookup(body);
  const next = hit !== undefined ? hit : byRules(body);
  return next === body ? raw : m[1] + next + m[3];
}

const ATTRS = ['title', 'placeholder', 'aria-label'];

/** 属性同样记住源文，切语言时从源文重算，避免二次翻译把英文再翻一遍 */
function trAttrs(el) {
  for (const a of ATTRS) {
    const cur = el.getAttribute?.(a);
    if (!cur) continue;
    el.__i18nAttr = el.__i18nAttr || {};
    if (el.__i18nAttr[a] === undefined) el.__i18nAttr[a] = cur;
    const next = trText(el.__i18nAttr[a]);
    if (next !== cur) el.setAttribute(a, next);
  }
}

function walk(root, visit) {
  if (!root) return;
  if (root.nodeType === 3) {
    visit(root);
    return;
  }
  if (root.nodeType !== 1) return;
  if (SKIP_TAGS.has(root.tagName) || root.dataset?.i18nSkip !== undefined) return;
  trAttrs(root);
  // 属性翻译要覆盖整棵子树：新增节点通常是一个容器，placeholder 在内部的 input 上
  const elems = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (SKIP_TAGS.has(node.tagName) || node.closest('[data-i18n-skip]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (elems.nextNode()) trAttrs(elems.currentNode);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const p = node.parentElement;
      if (!p || SKIP_TAGS.has(p.tagName) || p.closest('[data-i18n-skip]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach(visit);
}

/** 文本节点：首次见到先存源文，之后永远从源文算，保证可逆 */
function translateTextNode(node) {
  if (node.__i18nSrc === undefined) node.__i18nSrc = node.nodeValue || '';
  const next = trText(node.__i18nSrc);
  if (node.nodeValue !== next) node.nodeValue = next;
}

/** 翻译一个子树（可重复调用；切语言时整页重算，切回中文即还原） */
export function applyI18n(root = document.body) {
  walk(root, translateTextNode);
}

let observer = null;

/** 监听后续渲染（只认新增节点，不监听文本变化，避免自触发死循环） */
function ensureObserver() {
  if (observer || lang === SOURCE || typeof document === 'undefined' || !document.body) return;
  observer = new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) applyI18n(n);
        else if (n.nodeType === 3) translateTextNode(n);
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

/** 首屏翻译 + 挂监听 */
export function initI18n() {
  document.documentElement.lang = lang;
  if (lang === SOURCE) return;
  applyI18n(document.body);
  ensureObserver();
}
