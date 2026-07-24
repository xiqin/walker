import { element, listen } from '../dom.js';
import { createModalFocusTrap } from './modal-focus.js';

/** 创建互斥的 loading、empty、error 和 content 状态容器。 */
export function createFeedback(options = {}) {
  const documentRef = options.document || document;
  const root = element('section', { document: documentRef, className: 'feedback', attributes: { 'aria-live': 'polite' } });

  /** 统一替换反馈状态内容。 */
  function show(state, ...children) {
    root.dataset.state = state;
    root.replaceChildren(...children);
  }

  return {
    element: root,
    showLoading(message = '正在加载') {
      show('loading', element('p', { document: documentRef, className: 'feedback__loading', text: message }));
    },
    showEmpty(message = '暂无数据') {
      show('empty', element('p', { document: documentRef, className: 'feedback__empty', text: message }));
    },
    showError(error, retry) {
      const children = [element('p', { document: documentRef, className: 'feedback__error', text: error?.message || '请求失败' })];
      if (retry) {
        const button = element('button', { document: documentRef, className: 'button', text: '重试', attributes: { type: 'button' } });
        listen(button, 'click', retry);
        children.push(button);
      }
      show('error', ...children);
    },
    showContent(content) {
      show('content', content);
    },
  };
}

/** 创建全局非阻塞 toast。 */
export function createToast(options = {}) {
  const documentRef = options.document || document;
  const root = element('div', { document: documentRef, className: 'toast', attributes: { role: 'status', 'aria-live': 'polite' } });
  let timer = null;

  /** 显示 toast，并在超时后隐藏。 */
  function show(message, tone = 'neutral', duration = 4000) {
    if (timer) clearTimeout(timer);
    root.textContent = String(message);
    root.dataset.tone = tone;
    root.className = 'toast show';
    timer = duration > 0 ? setTimeout(() => { root.className = 'toast'; }, duration) : null;
  }

  return { element: root, show, hide: () => { root.className = 'toast'; if (timer) clearTimeout(timer); timer = null; } };
}

/** 创建返回 Promise<boolean> 的语义确认对话框。 */
export function createConfirm(options = {}) {
  const documentRef = options.document || document;
  const id = options.id || 'confirm-' + Math.random().toString(36).slice(2);
  const root = element('div', { document: documentRef, className: 'confirm', attributes: { role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': id + '-title', 'aria-describedby': id + '-message' } });
  const title = element('h2', { document: documentRef, text: options.title || '请确认操作', attributes: { id: id + '-title' } });
  const message = element('p', { document: documentRef, className: 'confirm__message', attributes: { id: id + '-message' } });
  const accept = element('button', { document: documentRef, className: 'button button--danger', text: '确认', attributes: { type: 'button' } });
  const cancel = element('button', { document: documentRef, className: 'button', text: '取消', attributes: { type: 'button' } });
  root.append(title, message, element('div', { document: documentRef, className: 'confirm__actions' }, accept, cancel));
  root.hidden = true;
  root.inert = true;
  let pending = null;

  /** 请求用户明确确认目标与后果。 */
  function ask(text, trigger = documentRef.activeElement) {
    if (pending) pending(false);
    message.textContent = String(text);
    root.hidden = false;
    root.inert = false;
    focusTrap.focusInitial(accept);
    return new Promise(resolve => {
      const finish = value => {
        if (pending !== finish) return;
        pending = null;
        root.hidden = true;
        root.inert = true;
        offAccept();
        offCancel();
        if (trigger?.focus) trigger.focus();
        resolve(value);
      };
      pending = finish;
      const offAccept = listen(accept, 'click', () => finish(true));
      const offCancel = listen(cancel, 'click', () => finish(false));
    });
  }

  const focusTrap = createModalFocusTrap({
    document: documentRef,
    container: root,
    isActive: () => Boolean(pending),
    onEscape: () => pending?.(false),
  });
  return { element: root, title, message, accept, cancel, ask, cleanup: () => { if (pending) pending(false); focusTrap.cleanup(); } };
}
