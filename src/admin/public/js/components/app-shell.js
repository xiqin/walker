import { element, listen } from '../dom.js';

export const NAVIGATION = [
  { label: '运行', items: [{ id: 'dashboard', label: '控制台', icon: '◎' }, { id: 'sessions', label: '会话与路由', icon: '↔' }] },
  { label: '可观测性', items: [{ id: 'activity', label: '活动与日志', icon: '▤' }, { id: 'diagnostics', label: '诊断', icon: '⌁' }] },
  { label: '系统', items: [{ id: 'connections', label: '连接与运行时', icon: '◇' }, { id: 'config', label: '配置', icon: '⚙' }, { id: 'storage', label: '存储与维护', icon: '▱' }] },
  { label: '开发', items: [{ id: 'tools', label: '调试工具', icon: '⌘' }] },
];

/** 创建四组八入口应用壳，不绑定具体页面实现。 */
export function createAppShell(options = {}) {
  const documentRef = options.document || document;
  const navigation = options.navigation || NAVIGATION;
  const mobile = options.mobile ?? globalThis.matchMedia?.('(max-width: 767px)').matches ?? false;
  const links = new Map();
  const nav = element('nav', { document: documentRef, className: 'app-sidebar', attributes: { 'aria-label': '主导航' } });
  const brand = element('div', { document: documentRef, className: 'app-brand' },
    element('strong', { document: documentRef, text: 'WALKER' }),
    element('span', { document: documentRef, text: 'LOCAL AGENT HUB' }));
  nav.append(brand);
  for (const group of navigation) {
    const section = element('section', { document: documentRef, className: 'nav-group', attributes: { 'aria-labelledby': 'nav-' + group.label } });
    section.append(element('h2', { document: documentRef, text: group.label, attributes: { id: 'nav-' + group.label } }));
    const list = element('ul', { document: documentRef, className: 'nav-list' });
    for (const item of group.items) {
      const link = element('a', {
        document: documentRef,
        className: 'nav-link',
        attributes: { href: '#' + item.id, 'data-route': item.id },
        text: item.icon + ' ' + item.label,
      });
      links.set(item.id, link);
      list.append(element('li', { document: documentRef }, link));
    }
    section.append(list);
    nav.append(section);
  }
  const main = element('main', { document: documentRef, className: 'app-main', attributes: { id: 'app-main', tabindex: '-1' } });
  const menuButton = element('button', {
    document: documentRef,
    className: 'nav-toggle',
    text: '菜单',
    attributes: { type: 'button', 'aria-controls': 'app-navigation', 'aria-expanded': 'false' },
  });
  nav.setAttribute('id', 'app-navigation');
  const content = element('div', { document: documentRef, className: 'app-content' }, menuButton, main);
  const elementRoot = element('div', { document: documentRef, className: 'app-shell', dataset: { navOpen: 'false' } }, nav, content);

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

  /** 更新当前导航入口的 aria-current。 */
  function setActiveRoute(routeName) {
    for (const [id, link] of links) {
      if (id === routeName) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
  }

  if (mobile) setNavigationOpen(false);
  const offMenu = listen(menuButton, 'click', () => setNavigationOpen(elementRoot.dataset.navOpen !== 'true', true));
  const offKeydown = listen(documentRef, 'keydown', event => {
    if (event.key === 'Escape' && elementRoot.dataset.navOpen === 'true') {
      event.preventDefault();
      setNavigationOpen(false, true);
    }
  });
  const cleanup = () => { offMenu(); offKeydown(); };
  return { element: elementRoot, nav, main, menuButton, links, setNavigationOpen, setActiveRoute, cleanup };
}
