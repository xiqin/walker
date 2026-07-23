/** 安全解码单个 hash 片段。 */
function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch (_error) {
    return segment;
  }
}

/** 将 hash 解析为页面、参数和查询对象。 */
export function parseHash(input = '') {
  const raw = input.startsWith('#') ? input.slice(1) : input;
  const [pathPart, queryPart = ''] = raw.split('?');
  const encodedSegments = pathPart.split('/').filter(Boolean);
  const segments = encodedSegments.map(decodeSegment);
  const name = segments[0] || 'dashboard';
  const query = Object.fromEntries(new URLSearchParams(queryPart));
  const params = name === 'sessions' && segments[1] ? { id: segments[1] } : {};
  const normalizedPath = encodedSegments.length > 0 ? encodedSegments.join('/') : 'dashboard';
  return { name, segments, params, query, hash: '#' + normalizedPath + (queryPart ? '?' + queryPart : '') };
}

/** 为页面生成可刷新恢复的 hash。 */
export function buildHash(name, params = {}, query = {}) {
  const segments = [name || 'dashboard'];
  if (params.id != null) segments.push(encodeURIComponent(params.id));
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value != null && value !== '') search.set(key, value);
  }
  const suffix = search.toString();
  return '#' + segments.join('/') + (suffix ? '?' + suffix : '');
}

/** 创建负责 mount、cleanup、abort 和 generation 隔离的 hash Router。 */
export function createRouter(options) {
  const windowRef = options.window || window;
  const root = options.root;
  const routes = options.routes || {};
  const fallback = options.fallback || 'dashboard';
  const sharedContext = options.context || {};
  const onRoute = options.onRoute || (() => {});
  const onAbort = options.onAbort || (() => {});
  const onError = options.onError || (() => {});
  let generation = 0;
  let current = null;
  let started = false;
  let renderedHash = null;

  /** 将页面返回值归一为只执行一次的 cleanup。 */
  function getCleanup(result) {
    const callback = typeof result === 'function' ? result : result?.cleanup;
    if (typeof callback !== 'function') return null;
    let cleaned = false;
    return () => {
      if (cleaned) return;
      cleaned = true;
      callback();
    };
  }

  /** 判断错误是否为导航取消产生的正常控制流。 */
  function isCancellation(error, lifecycle) {
    return lifecycle.controller.signal.aborted && (error?.name === 'AbortError' || error?.code === 'ABORTED');
  }

  /** 清理当前页面，规格要求 cleanup 先于 abort。 */
  function disposeCurrent() {
    const lifecycle = current;
    current = null;
    if (!lifecycle) return;
    lifecycle.cleanup?.();
    lifecycle.cleanup = null;
    if (!lifecycle.controller.signal.aborted) {
      lifecycle.controller.abort();
      onAbort();
    }
  }

  /** 根据当前 hash 挂载页面，并为异步响应提供 generation guard。 */
  async function render(hash = windowRef.location.hash) {
    disposeCurrent();
    const route = parseHash(hash);
    renderedHash = route.hash;
    const page = routes[route.name] || routes[fallback];
    const currentGeneration = ++generation;
    const lifecycle = { generation: currentGeneration, controller: new AbortController(), cleanup: null };
    current = lifecycle;
    const context = {
      ...sharedContext,
      root,
      route,
      signal: lifecycle.controller.signal,
      navigate,
      isCurrent: () => current === lifecycle && currentGeneration === generation && !lifecycle.controller.signal.aborted,
      commit(callback) {
        if (context.isCurrent()) callback();
      },
    };
    onRoute(route);
    if (!page || typeof page.mount !== 'function') return context;
    try {
      const result = await page.mount(context);
      const pageCleanup = getCleanup(result);
      if (context.isCurrent()) lifecycle.cleanup = pageCleanup;
      else pageCleanup?.();
      return context;
    } catch (error) {
      if (isCancellation(error, lifecycle)) return context;
      onError(error, route);
      throw error;
    }
  }

  /** 导航并立即执行渲染，测试和业务代码无需等待 hashchange。 */
  async function navigate(hash) {
    const target = hash.startsWith('#') ? hash : '#' + hash;
    windowRef.location.hash = target;
    return render(target);
  }

  /** 启动 hash 监听并挂载初始页面。 */
  async function start() {
    if (started) return;
    started = true;
    windowRef.addEventListener('hashchange', handleHashChange);
    return render();
  }

  /** 响应浏览器原生 hashchange。 */
  function handleHashChange() {
    if (parseHash(windowRef.location.hash).hash === renderedHash) return;
    return render().catch(() => undefined);
  }

  /** 停止 Router 并释放当前页面资源。 */
  function stop() {
    if (!started) return;
    started = false;
    windowRef.removeEventListener('hashchange', handleHashChange);
    disposeCurrent();
    generation++;
  }

  return { start, stop, navigate, render, get generation() { return generation; } };
}
