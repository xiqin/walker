import { listen } from '../dom.js';

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** 创建基本模态焦点循环，并返回初始聚焦和清理接口。 */
export function createModalFocusTrap(options) {
  const documentRef = options.document || document;

  /** 返回模态框内当前可聚焦控件。 */
  function getFocusable() {
    return [...options.container.querySelectorAll(FOCUSABLE_SELECTOR)].filter(control => !control.hidden && !control.inert && !control.disabled);
  }

  /** 将焦点放到指定控件或第一个可聚焦控件。 */
  function focusInitial(preferred) {
    const target = preferred || getFocusable()[0] || options.container;
    if (target?.focus) target.focus();
  }

  const offKeydown = listen(documentRef, 'keydown', event => {
    if (!options.isActive()) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      options.onEscape?.();
      return;
    }
    if (event.key !== 'Tab') return;
    const controls = getFocusable();
    if (controls.length === 0) {
      event.preventDefault();
      focusInitial();
      return;
    }
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && documentRef.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && documentRef.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  return { focusInitial, cleanup: offKeydown };
}
