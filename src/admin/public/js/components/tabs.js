import { element, listen } from '../dom.js';

/** 创建键盘可聚焦的轻量 Tab 控件。 */
export function createTabs(options = {}) {
  const documentRef = options.document || document;
  const root = element('div', { document: documentRef, className: 'tabs', attributes: { role: 'tablist', 'aria-label': options.label || '内容切换' } });
  const buttons = new Map();
  const cleanups = [];
  const panels = new Map();
  let selected = options.selected || options.tabs?.[0]?.id || null;

  /** 更新选中状态并通知业务页面。 */
  function select(id) {
    if (!buttons.has(id)) return;
    selected = id;
    for (const [buttonId, button] of buttons) {
      const active = buttonId === id;
      button.setAttribute('aria-selected', String(active));
      button.setAttribute('tabindex', active ? '0' : '-1');
      const panel = panels.get(buttonId);
      if (panel) panel.hidden = !active;
    }
    if (options.onChange) options.onChange(id);
  }

  for (const tab of options.tabs || []) {
    const buttonId = 'tab-' + tab.id;
    const panelId = tab.panel?.attributes?.id || 'tabpanel-' + tab.id;
    const button = element('button', {
      document: documentRef,
      className: 'tab-button',
      text: tab.label,
      attributes: { id: buttonId, type: 'button', role: 'tab', 'data-tab': tab.id, 'aria-controls': panelId },
    });
    buttons.set(tab.id, button);
    if (tab.panel) {
      tab.panel.setAttribute('id', panelId);
      tab.panel.setAttribute('role', 'tabpanel');
      tab.panel.setAttribute('aria-labelledby', buttonId);
      panels.set(tab.id, tab.panel);
    }
    cleanups.push(listen(button, 'click', () => select(tab.id)));
    cleanups.push(listen(button, 'keydown', event => {
      const ids = [...buttons.keys()];
      const index = ids.indexOf(tab.id);
      let target = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') target = ids[(index + 1) % ids.length];
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') target = ids[(index - 1 + ids.length) % ids.length];
      if (event.key === 'Home') target = ids[0];
      if (event.key === 'End') target = ids[ids.length - 1];
      if (!target) return;
      event.preventDefault();
      select(target);
      buttons.get(target).focus();
    }));
    root.append(button);
  }
  if (selected) select(selected);
  return { element: root, buttons, panels, select, getSelected: () => selected, cleanup: () => cleanups.forEach(cleanup => cleanup()) };
}
