'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'src', 'admin', 'public');
const jsDir = path.join(publicDir, 'js');
let moduleDir;

/** 将浏览器 ESM 复制到临时 module package，供 Node 直接导入真实源码。 */
function prepareModules() {
  moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-admin-ui-'));
  fs.cpSync(jsDir, path.join(moduleDir, 'js'), { recursive: true });
  fs.writeFileSync(path.join(moduleDir, 'package.json'), '{"type":"module"}\n');
}

/** 导入指定前端模块。 */
function importModule(relativePath) {
  return import(pathToFileURL(path.join(moduleDir, 'js', relativePath)).href);
}

/** 创建可观测的最小 DOM 节点。 */
function createFakeElement(tagName = 'div', ownerDocument = null) {
  const node = {
    tagName: tagName.toUpperCase(),
    children: [],
    attributes: {},
    dataset: {},
    className: '',
    textContent: '',
    hidden: false,
    inert: false,
    disabled: false,
    append(...nodes) { this.children.push(...nodes); },
    appendChild(node) { this.children.push(node); return node; },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(type, listener) { this['on' + type] = listener; },
    removeEventListener(type) { delete this['on' + type]; },
    focus() {
      this.focused = true;
      if (ownerDocument) ownerDocument.activeElement = this;
    },
    querySelectorAll() {
      const focusableTags = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
      const matches = [];
      function visit(child) {
        if (!child || typeof child !== 'object') return;
        if (focusableTags.has(child.tagName) || (child.attributes && child.attributes.tabindex !== undefined && child.attributes.tabindex !== '-1')) matches.push(child);
        for (const nested of child.children || []) visit(nested);
      }
      for (const child of this.children) visit(child);
      return matches;
    },
  };
  return node;
}

/** 创建组件测试使用的最小 document。 */
function createFakeDocument() {
  const listeners = {};
  const document = {
    activeElement: null,
    body: null,
    createElement(tagName) { return createFakeElement(tagName, document); },
    createTextNode(value) { return { nodeType: 3, textContent: String(value) }; },
    addEventListener(type, listener) { listeners[type] = listener; },
    removeEventListener(type) { delete listeners[type]; },
    dispatch(type, event = {}) { return listeners[type]?.({ type, preventDefault() { this.defaultPrevented = true; }, ...event }); },
  };
  document.body = createFakeElement('body', document);
  return document;
}

/** 创建可手动完成的 Promise。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** 递归提取节点文本。 */
function collectText(node) {
  return [node.textContent || '', ...(node.children || []).map(collectText)].join(' ');
}

test.before(prepareModules);
test.after(() => fs.rmSync(moduleDir, { recursive: true, force: true }));

test('前端模块可独立导入且不依赖构建工具', async () => {
  const modules = [
    'app.js', 'router.js', 'api.js', 'state.js', 'dom.js', 'format.js',
    'components/app-shell.js', 'components/status-card.js',
    'components/data-table.js', 'components/drawer.js',
    'components/tabs.js', 'components/feedback.js', 'components/modal-focus.js',
  ];
  for (const modulePath of modules) {
    await assert.doesNotReject(importModule(modulePath), modulePath);
  }
  const packageText = fs.readFileSync(path.join(root, 'package.json'), 'utf8');
  const source = modules.map(file => fs.readFileSync(path.join(jsDir, file), 'utf8')).join('\n');
  assert.doesNotMatch(packageText + source, /\b(?:react|vue|vite|redux)\b/i);
});

test('应用壳渲染四组九个语义导航入口', async () => {
  const { createAppShell, NAVIGATION } = await importModule('components/app-shell.js');
  const document = createFakeDocument();
  const shell = createAppShell({ document, navigation: NAVIGATION });
  assert.equal(NAVIGATION.length, 4);
  assert.equal(NAVIGATION.flatMap(group => group.items).length, 9);
  assert.deepEqual(NAVIGATION.map(group => group.label), ['运行', '可观测性', '系统', '开发']);
  assert.match(collectText(shell.element), /控制台.*会话与路由.*活动与日志.*诊断.*连接与集成.*配置.*进程管理.*存储与维护.*调试工具/);
  assert.equal(shell.nav.attributes['aria-label'], '主导航');
  assert.equal(shell.main.tagName, 'MAIN');
  assert.equal(shell.menuButton.attributes['aria-expanded'], 'false');
  shell.setNavigationOpen(true);
  assert.equal(shell.element.dataset.navOpen, 'true');
  assert.equal(shell.menuButton.attributes['aria-expanded'], 'true');
  shell.setActiveRoute('sessions');
  assert.equal(shell.links.get('sessions').attributes['aria-current'], 'page');
});

test('Router 解析并生成 Session 深链', async () => {
  const { parseHash, buildHash } = await importModule('router.js');
  assert.deepEqual(parseHash('#sessions/ses%2Falpha?tab=timeline'), {
    name: 'sessions',
    segments: ['sessions', 'ses/alpha'],
    params: { id: 'ses/alpha' },
    query: { tab: 'timeline' },
    hash: '#sessions/ses%2Falpha?tab=timeline',
  });
  assert.equal(buildHash('sessions', { id: 'ses/alpha' }, { tab: 'timeline' }), '#sessions/ses%2Falpha?tab=timeline');
});

test('快速导航依次 cleanup、abort，并阻止旧 generation 写入', async () => {
  const { createRouter } = await importModule('router.js');
  const events = [];
  const location = { hash: '#first' };
  const listeners = {};
  const window = {
    location,
    addEventListener(type, listener) { listeners[type] = listener; },
    removeEventListener(type) { delete listeners[type]; },
  };
  let firstContext;
  const router = createRouter({
    window,
    root: createFakeElement(),
    routes: {
      first: { mount(context) { firstContext = context; return () => events.push('cleanup'); } },
      second: { mount() { events.push('mount-second'); } },
    },
    context: { api: 'shared-api' },
    onAbort() { events.push('abort'); },
  });
  await router.start();
  assert.equal(firstContext.api, 'shared-api');
  assert.equal(firstContext.isCurrent(), true);
  await router.navigate('#second');
  assert.deepEqual(events, ['cleanup', 'abort', 'mount-second']);
  listeners.hashchange();
  assert.deepEqual(events, ['cleanup', 'abort', 'mount-second']);
  assert.equal(firstContext.signal.aborted, true);
  assert.equal(firstContext.isCurrent(), false);
});

test('Router 对迟到的函数和对象 cleanup 都立即且仅清理一次', async () => {
  const { createRouter } = await importModule('router.js');
  for (const shape of ['function', 'object']) {
    const pending = deferred();
    let cleanupCount = 0;
    const window = { location: { hash: '#slow' }, addEventListener() {}, removeEventListener() {} };
    const router = createRouter({
      window,
      root: createFakeElement(),
      routes: {
        slow: { mount: () => pending.promise },
        fast: { mount() {} },
      },
    });
    const slowRender = router.start();
    await router.navigate('#fast');
    const cleanup = () => { cleanupCount++; };
    pending.resolve(shape === 'function' ? cleanup : { cleanup });
    await slowRender;
    router.stop();
    assert.equal(cleanupCount, 1, shape);
  }
});

test('Router 正常消费导航取消，并把其他异步错误交给 onError', async () => {
  const { createRouter } = await importModule('router.js');
  const errors = [];
  const listeners = {};
  const pending = deferred();
  const window = {
    location: { hash: '#slow' },
    addEventListener(type, listener) { listeners[type] = listener; },
    removeEventListener(type) { delete listeners[type]; },
  };
  const router = createRouter({
    window,
    root: createFakeElement(),
    routes: {
      slow: { mount: () => pending.promise },
      fast: { mount() {} },
      broken: { async mount() { throw new Error('render failed'); } },
    },
    onError: error => errors.push(error.message),
  });
  const slowRender = router.start();
  await router.navigate('#fast');
  pending.reject(new DOMException('aborted', 'AbortError'));
  await assert.doesNotReject(slowRender);
  window.location.hash = '#broken';
  await listeners.hashchange();
  assert.deepEqual(errors, ['render failed']);
  await assert.rejects(router.navigate('#broken'), /render failed/);
  assert.deepEqual(errors, ['render failed', 'render failed']);
});

test('Router 不吞掉当前页面主动抛出的非导航 AbortError', async () => {
  const { createRouter } = await importModule('router.js');
  const errors = [];
  const router = createRouter({
    window: { location: { hash: '#broken' }, addEventListener() {}, removeEventListener() {} },
    root: createFakeElement(),
    routes: { broken: { async mount() { throw new DOMException('local abort', 'AbortError'); } } },
    onError: error => errors.push(error.message),
  });
  await assert.rejects(router.start(), /local abort/);
  assert.deepEqual(errors, ['local abort']);
});

test('API client 统一 token、JSON、busy 与成功响应', async () => {
  const { createApiClient } = await importModule('api.js');
  const busy = [];
  let request;
  const api = createApiClient({
    getToken: () => 'admin-token',
    setBusy: value => busy.push(value),
    fetch: async (url, init) => {
      request = { url, init };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  assert.deepEqual(await api.post('/api/admin/example', { value: 1 }), { ok: true });
  assert.equal(request.url, '/api/admin/example');
  assert.equal(request.init.headers.Authorization, 'Bearer admin-token');
  assert.equal(request.init.headers['Content-Type'], 'application/json');
  assert.equal(request.init.body, '{"value":1}');
  assert.deepEqual(busy, [true, false]);
});

test('API client 将网络、非 JSON、服务错误和超时归一化', async () => {
  const { createApiClient, ApiError } = await importModule('api.js');
  const cases = [
    {
      api: createApiClient({ fetch: async () => { throw new TypeError('offline'); } }),
      expected: { code: 'NETWORK_ERROR', status: 0 },
    },
    {
      api: createApiClient({ fetch: async () => new Response('broken', { status: 502, headers: { 'Content-Type': 'text/plain' } }) }),
      expected: { code: 'INVALID_RESPONSE', status: 502 },
    },
    {
      api: createApiClient({ fetch: async () => new Response('{"error":{"code":"BAD_INPUT","message":"bad"}}', { status: 400, headers: { 'Content-Type': 'application/json' } }) }),
      expected: { code: 'BAD_INPUT', status: 400 },
    },
    {
      api: createApiClient({
        fetch: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
        timeout: 5,
      }),
      expected: { code: 'TIMEOUT', status: 0 },
    },
  ];
  for (const item of cases) {
    await assert.rejects(item.api.get('/test'), error => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.code, item.expected.code);
      assert.equal(error.status, item.expected.status);
      assert.equal(typeof error.message, 'string');
      return true;
    });
  }
});

test('401 触发认证恢复并保留目标 hash', async () => {
  const { createApiClient } = await importModule('api.js');
  const { createAuthRecovery } = await importModule('app.js');
  const storage = new Map();
  const recovery = createAuthRecovery({
    getHash: () => '#sessions/s-1',
    storage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
  });
  const api = createApiClient({
    fetch: async () => new Response('{"error":{"message":"expired"}}', { status: 401, headers: { 'Content-Type': 'application/json' } }),
    onUnauthorized: recovery.remember,
  });
  await assert.rejects(api.get('/private'), { code: 'UNAUTHORIZED', status: 401 });
  assert.equal(recovery.consume(), '#sessions/s-1');
  assert.equal(recovery.consume(), null);
});

test('认证成功只消费一次保存 hash 并导航，缺失目标回退 dashboard', async () => {
  const { createAuthRecovery } = await importModule('app.js');
  const storage = new Map();
  const recovery = createAuthRecovery({
    getHash: () => '#sessions/s-1',
    storage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
  });
  const navigated = [];
  const router = { navigate: async hash => { navigated.push(hash); } };
  recovery.remember();
  const { resume } = recovery;
  assert.equal(await resume(router), '#sessions/s-1');
  assert.equal(await resume(router), '#dashboard');
  assert.deepEqual(navigated, ['#sessions/s-1', '#dashboard']);
});

test('外部取消被标记为 ABORTED 且不触发错误反馈', async () => {
  const { createApiClient } = await importModule('api.js');
  const controller = new AbortController();
  const api = createApiClient({
    fetch: (_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
  });
  const pending = api.get('/slow', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { code: 'ABORTED', status: 0 });
});

test('状态容器仅在值变化时通知并支持筛选隔离', async () => {
  const { createStore, createInitialState } = await importModule('state.js');
  const store = createStore(createInitialState());
  const seen = [];
  const unsubscribe = store.subscribe(state => seen.push(state.route.name));
  store.update(state => ({ ...state, route: { ...state.route, name: 'sessions' } }));
  store.update(state => state);
  store.setPageFilters('sessions', { status: 'active' });
  unsubscribe();
  store.update(state => ({ ...state, route: { ...state.route, name: 'config' } }));
  assert.deepEqual(seen, ['sessions', 'sessions']);
  assert.deepEqual(store.getState().filters.sessions, { status: 'active' });
});

test('DOM helper 以 textContent 安全写入动态值并可清理事件', async () => {
  const { element, listen, setBusy } = await importModule('dom.js');
  const document = createFakeDocument();
  const button = element('button', { document, text: '<img src=x onerror=alert(1)>', className: 'btn' });
  assert.equal(button.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(button.children.length, 0);
  const cleanup = listen(button, 'click', () => {});
  assert.equal(typeof button.onclick, 'function');
  cleanup();
  assert.equal(button.onclick, undefined);
  setBusy(button, true, '保存中');
  assert.equal(button.disabled, true);
  assert.equal(button.attributes['aria-busy'], 'true');
});

test('格式 helper 对缺失值、状态、ID、路径和时间提供稳定输出', async () => {
  const { formatDateTime, formatStatus, shortId, compactPath } = await importModule('format.js');
  assert.equal(formatDateTime(null), '未知');
  assert.deepEqual(formatStatus('failed'), { label: '异常', icon: '!', tone: 'danger' });
  assert.equal(shortId('session-1234567890', 10), 'sess…7890');
  assert.equal(compactPath('C:\\Users\\walker\\projects\\alpha', 18), 'C:\\…\\projects\\alpha');
});

test('反馈组件的 loading、empty、error、content 状态互斥且可恢复', async () => {
  const { createFeedback } = await importModule('components/feedback.js');
  const document = createFakeDocument();
  const feedback = createFeedback({ document });
  feedback.showLoading('正在加载');
  assert.equal(feedback.element.dataset.state, 'loading');
  assert.match(collectText(feedback.element), /正在加载/);
  feedback.showEmpty('没有数据');
  assert.equal(feedback.element.dataset.state, 'empty');
  assert.doesNotMatch(collectText(feedback.element), /正在加载/);
  feedback.showError(new Error('请求失败'), () => {});
  assert.equal(feedback.element.dataset.state, 'error');
  assert.match(collectText(feedback.element), /请求失败.*重试/);
  const content = createFakeElement('section');
  feedback.showContent(content);
  assert.equal(feedback.element.dataset.state, 'content');
  assert.equal(feedback.element.children[0], content);
});

test('通用组件公开 status card、table、drawer、tabs、toast 和 confirm', async () => {
  const document = createFakeDocument();
  const { createStatusCard } = await importModule('components/status-card.js');
  const { createDataTable } = await importModule('components/data-table.js');
  const { createDrawer } = await importModule('components/drawer.js');
  const { createTabs } = await importModule('components/tabs.js');
  const { createToast, createConfirm } = await importModule('components/feedback.js');
  const card = createStatusCard({ document, title: 'Walker', status: 'healthy', details: [['版本', '0.8.0']] });
  assert.match(collectText(card), /Walker.*正常.*版本.*0.8.0/);
  const table = createDataTable({ document, columns: [{ key: 'id', label: '会话' }], rows: [{ id: 's-1' }], caption: '活跃会话' });
  assert.equal(table.tagName, 'TABLE');
  assert.match(collectText(table), /活跃会话.*会话.*s-1/);
  const drawer = createDrawer({ document, title: '详情' });
  drawer.open(createFakeElement('p'));
  assert.equal(drawer.element.attributes['aria-hidden'], 'false');
  drawer.close();
  assert.equal(drawer.element.attributes['aria-hidden'], 'true');
  const tabs = createTabs({ document, tabs: [{ id: 'events', label: '活动' }, { id: 'logs', label: '日志' }] });
  tabs.select('logs');
  assert.equal(tabs.getSelected(), 'logs');
  assert.equal(typeof createToast({ document }).show, 'function');
  assert.equal(typeof createConfirm({ document }).ask, 'function');
});

test('移动导航关闭时 hidden/inert，打开聚焦链接且 Escape 返回菜单按钮', async () => {
  const { createAppShell } = await importModule('components/app-shell.js');
  const document = createFakeDocument();
  const shell = createAppShell({ document, mobile: true });
  assert.equal(shell.nav.hidden, true);
  assert.equal(shell.nav.inert, true);
  shell.setNavigationOpen(true);
  assert.equal(shell.nav.hidden, false);
  assert.equal(shell.nav.inert, false);
  assert.equal(document.activeElement, shell.links.get('dashboard'));
  document.dispatch('keydown', { key: 'Escape' });
  assert.equal(shell.nav.hidden, true);
  assert.equal(shell.nav.inert, true);
  assert.equal(document.activeElement, shell.menuButton);
});

test('Drawer 和 Confirm 支持 Escape、可访问名称及焦点恢复', async () => {
  const document = createFakeDocument();
  const trigger = document.createElement('button');
  trigger.focus();
  const { createDrawer } = await importModule('components/drawer.js');
  const { createConfirm } = await importModule('components/feedback.js');
  const drawer = createDrawer({ document, title: 'Session 详情' });
  drawer.open(createFakeElement('p'), trigger);
  assert.equal(drawer.element.attributes['aria-labelledby'], drawer.title.attributes.id);
  assert.equal(drawer.element.hidden, false);
  document.dispatch('keydown', { key: 'Escape' });
  assert.equal(drawer.element.hidden, true);
  assert.equal(document.activeElement, trigger);
  const confirm = createConfirm({ document, title: '确认删除' });
  const answer = confirm.ask('删除 Session s-1？', trigger);
  assert.equal(confirm.element.attributes['aria-labelledby'], confirm.title.attributes.id);
  document.dispatch('keydown', { key: 'Escape' });
  assert.equal(await answer, false);
  assert.equal(document.activeElement, trigger);
});

test('Drawer 在首末控件间循环 Tab，cleanup 后键盘监听失效', async () => {
  const document = createFakeDocument();
  const trigger = document.createElement('button');
  const firstAction = document.createElement('button');
  const lastAction = document.createElement('button');
  const content = document.createElement('section');
  content.append(firstAction, lastAction);
  const { createDrawer } = await importModule('components/drawer.js');
  const drawer = createDrawer({ document, title: '详情' });
  drawer.open(content, trigger);
  assert.equal(document.activeElement, drawer.closeButton);
  document.dispatch('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(document.activeElement, lastAction);
  document.dispatch('keydown', { key: 'Tab' });
  assert.equal(document.activeElement, drawer.closeButton);
  drawer.close();
  assert.equal(document.activeElement, trigger);
  drawer.open(content, trigger);
  drawer.cleanup();
  lastAction.focus();
  document.dispatch('keydown', { key: 'Tab' });
  assert.equal(document.activeElement, lastAction);
});

test('Confirm 在确认和取消间循环 Tab，cleanup 后键盘监听失效', async () => {
  const document = createFakeDocument();
  const trigger = document.createElement('button');
  const { createConfirm } = await importModule('components/feedback.js');
  const confirm = createConfirm({ document, title: '确认删除' });
  const answer = confirm.ask('删除对象？', trigger);
  assert.equal(document.activeElement, confirm.accept);
  document.dispatch('keydown', { key: 'Tab', shiftKey: true });
  assert.equal(document.activeElement, confirm.cancel);
  document.dispatch('keydown', { key: 'Tab' });
  assert.equal(document.activeElement, confirm.accept);
  confirm.cancel.onclick();
  assert.equal(await answer, false);
  assert.equal(document.activeElement, trigger);
  const pending = confirm.ask('再次删除？', trigger);
  confirm.cleanup();
  assert.equal(await pending, false);
  confirm.cancel.focus();
  document.dispatch('keydown', { key: 'Tab' });
  assert.equal(document.activeElement, confirm.cancel);
});

test('Tabs 建立 tabpanel 关联并支持方向键、Home 和 End', async () => {
  const document = createFakeDocument();
  const panels = {
    events: document.createElement('section'),
    logs: document.createElement('section'),
    metrics: document.createElement('section'),
  };
  const { createTabs } = await importModule('components/tabs.js');
  const tabs = createTabs({
    document,
    tabs: [
      { id: 'events', label: '活动', panel: panels.events },
      { id: 'logs', label: '日志', panel: panels.logs },
      { id: 'metrics', label: '指标', panel: panels.metrics },
    ],
  });
  assert.equal(tabs.buttons.get('events').attributes['aria-controls'], panels.events.attributes.id);
  assert.equal(panels.events.attributes['aria-labelledby'], tabs.buttons.get('events').attributes.id);
  tabs.buttons.get('events').onkeydown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(tabs.getSelected(), 'logs');
  assert.equal(document.activeElement, tabs.buttons.get('logs'));
  tabs.buttons.get('logs').onkeydown({ key: 'End', preventDefault() {} });
  assert.equal(tabs.getSelected(), 'metrics');
  tabs.buttons.get('metrics').onkeydown({ key: 'Home', preventDefault() {} });
  assert.equal(tabs.getSelected(), 'events');
  assert.equal(panels.events.hidden, false);
  assert.equal(panels.logs.hidden, true);
});

test('五层 CSS 定义视觉 token、四档响应式、焦点和 reduced motion', () => {
  const files = ['tokens.css', 'base.css', 'layout.css', 'components.css', 'responsive.css'];
  const css = Object.fromEntries(files.map(file => [file, fs.readFileSync(path.join(publicDir, 'styles', file), 'utf8')]));
  assert.match(css['tokens.css'], /--sidebar-width:\s*236px/);
  assert.match(css['tokens.css'], /--accent:\s*#2563eb/);
  assert.match(css['tokens.css'], /--green/);
  assert.match(css['base.css'], /:focus-visible/);
  assert.match(css['layout.css'], /\.app\b/);
  assert.match(css['components.css'], /\.badge/);
  assert.match(css['responsive.css'], /min-width:\s*1200px/);
  assert.match(css['responsive.css'], /min-width:\s*768px.*max-width:\s*1199px/s);
  assert.match(css['responsive.css'], /max-width:\s*767px/);
  assert.match(css['responsive.css'], /max-width:\s*479px/);
  assert.match(css['responsive.css'], /prefers-reduced-motion:\s*reduce/);
});
