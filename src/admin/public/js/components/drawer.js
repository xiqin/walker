import { element, listen } from '../dom.js';
import { createModalFocusTrap } from './modal-focus.js';

/** 创建右侧详情抽屉并管理焦点恢复。 */
export function createDrawer(options = {}) {
  const documentRef = options.document || document;
  const id = options.id || 'drawer-' + Math.random().toString(36).slice(2);
  const panel = element('aside', {
    document: documentRef,
    className: 'drawer',
    attributes: { role: 'dialog', 'aria-modal': 'true', 'aria-hidden': 'true', 'aria-labelledby': id + '-title' },
  });
  const title = element('h2', { document: documentRef, text: options.title || '详情', attributes: { id: id + '-title' } });
  const closeButton = element('button', { document: documentRef, className: 'icon-button', text: '关闭', attributes: { type: 'button', 'aria-label': '关闭详情' } });
  const content = element('div', { document: documentRef, className: 'drawer__content' });
  panel.append(element('header', { document: documentRef, className: 'drawer__header' }, title, closeButton), content);
  let returnFocus = null;
  panel.hidden = true;
  panel.inert = true;

  /** 打开抽屉并渲染指定内容。 */
  function open(node, trigger) {
    returnFocus = trigger || documentRef.activeElement;
    content.replaceChildren(node);
    panel.hidden = false;
    panel.inert = false;
    panel.setAttribute('aria-hidden', 'false');
    focusTrap.focusInitial(closeButton);
  }

  /** 关闭抽屉并恢复触发控件焦点。 */
  function close() {
    panel.setAttribute('aria-hidden', 'true');
    panel.hidden = true;
    panel.inert = true;
    content.replaceChildren();
    if (returnFocus?.focus) returnFocus.focus();
    returnFocus = null;
  }

  const offClose = listen(closeButton, 'click', close);
  const focusTrap = createModalFocusTrap({
    document: documentRef,
    container: panel,
    isActive: () => !panel.hidden,
    onEscape: close,
  });
  const cleanup = () => { close(); offClose(); focusTrap.cleanup(); };
  return { element: panel, title, closeButton, content, open, close, cleanup };
}
