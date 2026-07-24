/** 创建只使用安全文本和属性的 DOM 节点。 */
export function element(tagName, options = {}, ...children) {
  const documentRef = options.document || document;
  const node = documentRef.createElement(tagName);
  if (options.className) node.className = options.className;
  if (options.text != null) node.textContent = String(options.text);
  if (options.style != null) node.setAttribute('style', String(options.style));
  if (options.attributes) {
    for (const [name, value] of Object.entries(options.attributes)) {
      if (value != null) node.setAttribute(name, value);
    }
  }
  if (options.dataset) Object.assign(node.dataset, options.dataset);
  if (children.length > 0) node.append(...children.filter(Boolean));
  return node;
}

/** 绑定事件并返回对应清理函数。 */
export function listen(target, type, listener, options) {
  target.addEventListener(type, listener, options);
  return () => target.removeEventListener(type, listener, options);
}

/** 原子替换容器内容，避免遗留旧页面节点。 */
export function replace(container, ...children) {
  container.replaceChildren(...children.filter(Boolean));
  return container;
}

/** 设置按钮或表单控件的 busy 可访问状态。 */
export function setBusy(control, busy, busyText) {
  control.disabled = Boolean(busy);
  control.setAttribute('aria-busy', String(Boolean(busy)));
  if (busyText != null && busy) {
    if (!control.dataset.idleText) control.dataset.idleText = control.textContent;
    control.textContent = busyText;
  } else if (!busy && control.dataset.idleText) {
    control.textContent = control.dataset.idleText;
    delete control.dataset.idleText;
  }
}

/** 合并多个清理函数为幂等 cleanup。 */
export function combineCleanups(...cleanups) {
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    for (const cleanup of cleanups.reverse()) {
      if (typeof cleanup === 'function') cleanup();
    }
  };
}
