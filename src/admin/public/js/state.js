/** 创建应用启动所需的最小状态。 */
export function createInitialState(overrides = {}) {
  return {
    auth: { authenticated: false, token: null },
    route: { name: 'dashboard', params: {}, query: {} },
    filters: {},
    cache: {},
    ...overrides,
  };
}

/** 创建同步、可订阅且无隐式全局的轻量状态容器。 */
export function createStore(initialState = createInitialState()) {
  let state = initialState;
  const listeners = new Set();

  /** 返回当前只读状态引用。 */
  function getState() {
    return state;
  }

  /** 仅在状态引用变化时通知订阅者。 */
  function update(updater) {
    const next = typeof updater === 'function' ? updater(state) : updater;
    if (next === state) return state;
    state = next;
    for (const listener of listeners) listener(state);
    return state;
  }

  /** 订阅状态变化并返回取消函数。 */
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** 保存指定页面的独立筛选状态。 */
  function setPageFilters(page, filters) {
    update(current => ({
      ...current,
      filters: { ...current.filters, [page]: { ...filters } },
    }));
  }

  return { getState, update, subscribe, setPageFilters };
}
