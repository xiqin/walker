import { element, listen } from '../dom.js';

export const NAVIGATION = [
  { label: '运行', items: [{ id: 'dashboard', label: '控制台', icon: '◎' }] },
  { label: '可观测性', items: [
    { id: 'sessions', label: '会话与路由', icon: '☰' },
    { id: 'logs', label: '活动与日志', icon: '▤' },
    { id: 'diagnostics', label: '诊断', icon: '⚡' },
  ] },
  { label: '系统', items: [
    { id: 'connections', label: '连接与集成', icon: '⇄' },
    { id: 'config', label: '配置', icon: '⚙' },
    { id: 'process', label: '进程管理', icon: '▣' },
    { id: 'storage', label: '存储与维护', icon: '▢' },
  ] },
  { label: '开发', items: [{ id: 'debug', label: '调试工具', icon: '⌘' }] },
];

export const ROUTE_META = {
  dashboard: ['运行控制台', '飞书长连接 · OpenCode Agent 会话实时状态'],
  sessions: ['会话与路由', 'Walker session 与 routeKey 焦点路由管理'],
  logs: ['活动与日志', 'walker logs 的可视化实时事件流'],
  diagnostics: ['诊断', '运行系统自检，定位飞书 / OpenCode / Hook / 租约异常'],
  connections: ['连接与集成', '飞书、OpenCode Server、Agent 扩展与 Runtime 环境'],
  config: ['配置', '.env 环境变量分组编辑'],
  process: ['进程管理', 'walker start / stop / status / logs'],
  storage: ['存储与维护', '.walker/ 数据目录清理与备份'],
  debug: ['调试工具', 'Hook 端点测试、命令参考与原始数据'],
};

const DOT_TONE = { green: 'var(--green)', amber: 'var(--amber)', red: 'var(--red)', gray: 'var(--text-muted)' };

/** 创建原型风格应用壳：深色侧栏 + 顶栏 + 内容视口，不绑定具体页面实现。 */
export function createAppShell(options = {}) {
  const documentRef = options.document || document;
  const navigation = options.navigation || NAVIGATION;
  const mobile = options.mobile ?? globalThis.matchMedia?.('(max-width: 767px)').matches ?? false;
  const links = new Map();

  const nav = element('nav', { document: documentRef, className: 'sidebar', attributes: { 'aria-label': '主导航' } });
  nav.setAttribute('id', 'app-navigation');

  const brand = element('div', { document: documentRef, className: 'brand' },
    element('div', { document: documentRef, className: 'brand-mark', text: 'W' }),
    element('div', { document: documentRef },
      element('div', { document: documentRef, className: 'brand-name', text: 'WALKER' }),
      element('div', { document: documentRef, className: 'brand-sub', text: '飞书 AGENT 桥接器' })));
  nav.append(brand);


  for (const group of navigation) {
    const section = element('section', { document: documentRef, className: 'nav-group', attributes: { 'aria-labelledby': 'nav-' + group.label } });
    section.append(element('div', { document: documentRef, className: 'nav-group-label', text: group.label, attributes: { id: 'nav-' + group.label } }));
    const list = element('ul', { document: documentRef, className: 'nav-list' });
    for (const item of group.items) {
      const link = element('a', {
        document: documentRef,
        className: 'nav-item',
        attributes: { href: '#' + item.id, 'data-route': item.id },
      });
      link.append(element('span', { document: documentRef, className: 'nav-icon', text: item.icon }), element('span', { document: documentRef, text: item.label }));
      links.set(item.id, link);
      list.append(element('li', { document: documentRef }, link));
    }
    section.append(list);
    nav.append(section);
  }

  const statusDot = element('div', { document: documentRef, className: 'dot', attributes: { style: `background:${DOT_TONE.gray};` } });
  const statusText = element('div', { document: documentRef, text: 'Walker 状态未知', attributes: { id: 'status-text' } });
  const statusPill = element('div', { document: documentRef, className: 'status-pill' }, statusDot, statusText);
  const footer = element('div', { document: documentRef, className: 'sidebar-footer' }, statusPill);
  nav.append(footer);

  const menuButton = element('button', {
    document: documentRef,
    className: 'nav-toggle',
    text: '菜单',
    attributes: { type: 'button', 'aria-controls': 'app-navigation', 'aria-expanded': 'false' },
  });

  const pageTitle = element('div', { document: documentRef, className: 'topbar-title', attributes: { id: 'page-title' } });
  const pageSub = element('div', { document: documentRef, className: 'topbar-sub', attributes: { id: 'page-sub' } });
  const clock = element('span', { document: documentRef, attributes: { id: 'clock' } });
  const refreshBtn = element('button', { document: documentRef, className: 'btn', text: '↻ 刷新', attributes: { type: 'button', id: 'refresh-btn' } });
  const rangeOptions = [
    { label: '最近 15 分钟', minutes: 15 },
    { label: '最近 30 分钟', minutes: 30 },
    { label: '最近 60 分钟', minutes: 60 },
    { label: '最近 2 小时', minutes: 120 },
    { label: '最近 6 小时', minutes: 360 },
    { label: '最近 24 小时', minutes: 1440 },
  ];
  let selectedMinutes = 60;
  const rangeBtn = element('button', { document: documentRef, className: 'btn', text: '🕐 最近 60 分钟 ⌄', attributes: { type: 'button', id: 'range-btn' } });
  const rangeDropdown = element('div', { document: documentRef, className: 'dropdown-menu', attributes: { id: 'range-dropdown', hidden: '' } });
  for (const option of rangeOptions) {
    const item = element('button', { document: documentRef, className: 'dropdown-item', text: option.label, attributes: { type: 'button', 'data-minutes': String(option.minutes) } });
    if (option.minutes === selectedMinutes) item.classList.add('active');
    listen(item, 'click', () => {
      selectedMinutes = option.minutes;
      rangeBtn.textContent = `🕐 ${option.label} ⌄`;
      rangeDropdown.hidden = true;
      for (const child of rangeDropdown.children) child.classList.toggle('active', Number(child.dataset.minutes) === selectedMinutes);
      viewport.dispatchEvent(new (documentRef.defaultView || globalThis).CustomEvent('walker:rangechange', { bubbles: true, detail: { minutes: selectedMinutes } }));
    });
    rangeDropdown.append(item);
  }
  const actions = element('div', { document: documentRef, className: 'topbar-actions' },
    element('span', { document: documentRef, className: 'meta-time' }, element('span', { document: documentRef, text: '最近更新 ' }), clock),
    refreshBtn,
    element('div', { document: documentRef, className: 'dropdown', attributes: { style: 'position:relative;display:inline-block;' } }, rangeBtn, rangeDropdown));
  const topbar = element('header', { document: documentRef, className: 'topbar' },
    element('div', { document: documentRef, className: 'topbar-left' }, menuButton, element('div', { document: documentRef }, pageTitle, pageSub)),
    actions);

  const viewport = element('div', { document: documentRef, className: 'content', attributes: { id: 'app-viewport' } });
  const main = element('main', { document: documentRef, className: 'main' }, topbar, viewport);
  const elementRoot = element('div', { document: documentRef, className: 'app', dataset: { navOpen: 'false' } }, nav, main);

  let currentRoute = 'dashboard';
  function setRoute(title, sub) {
    pageTitle.textContent = title == null ? '' : String(title);
    pageSub.textContent = sub == null ? '' : String(sub);
  }
  function setActiveRoute(routeName) {
    currentRoute = routeName || 'dashboard';
    for (const [id, link] of links) {
      if (id === currentRoute) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    const meta = ROUTE_META[currentRoute] || [];
    setRoute(meta[0], meta[1]);
  }
  function setStatus(text, tone = 'green') {
    statusText.textContent = String(text);
    statusDot.setAttribute('style', `background:${DOT_TONE[tone] || DOT_TONE.gray};`);
  }
  function setClock(text) { clock.textContent = String(text); }
  function refresh() {
    viewport.dispatchEvent(new (documentRef.defaultView || globalThis).CustomEvent('walker:refresh', { bubbles: true }));
  }

  /** 在移动端开关抽屉式导航。 */
  function setNavigationOpen(open, restoreFocus = false) {
    const isOpen = Boolean(open);
    elementRoot.dataset.navOpen = String(isOpen);
    menuButton.setAttribute('aria-expanded', String(isOpen));
    if (!mobile) return;
    nav.hidden = !isOpen;
    nav.inert = !isOpen;
    if (isOpen) (links.get('dashboard') || links.values().next().value)?.focus();
    else if (restoreFocus) menuButton.focus();
  }

  if (mobile) setNavigationOpen(false);
  const offMenu = listen(menuButton, 'click', () => setNavigationOpen(elementRoot.dataset.navOpen !== 'true', true));
  const offRefresh = listen(refreshBtn, 'click', refresh);
  const offRange = listen(rangeBtn, 'click', (e) => { e.stopPropagation(); rangeDropdown.hidden = !rangeDropdown.hidden; });
  const offRangeOutside = listen(documentRef, 'click', (e) => { if (!rangeBtn.contains(e.target) && !rangeDropdown.contains(e.target)) rangeDropdown.hidden = true; });
  const offKeydown = listen(documentRef, 'keydown', event => {
    if (event.key === 'Escape' && elementRoot.dataset.navOpen === 'true') {
      event.preventDefault();
      setNavigationOpen(false, true);
    }
    if (event.key === 'Escape' && !rangeDropdown.hidden) rangeDropdown.hidden = true;
  });
  const cleanup = () => { offMenu(); offRefresh(); offRange(); offRangeOutside(); offKeydown(); };
  return { element: elementRoot, nav, main, viewport, menuButton, links, setNavigationOpen, setActiveRoute, setRoute, setStatus, setClock, refresh, cleanup };
}
