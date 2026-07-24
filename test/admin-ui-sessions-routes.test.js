'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.join(__dirname, '..');
const jsDir = path.join(root, 'src', 'admin', 'public', 'js');
let moduleDir;

function prepareModules() {
  moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-admin-sessions-'));
  fs.cpSync(jsDir, path.join(moduleDir, 'js'), { recursive: true });
  fs.writeFileSync(path.join(moduleDir, 'package.json'), '{"type":"module"}\n');
}

function importPage() {
  return import(pathToFileURL(path.join(moduleDir, 'js', 'pages', 'sessions.js')).href);
}

function createFakeElement(tagName = 'div', ownerDocument = null) {
  const listeners = {};
  return {
    tagName: tagName.toUpperCase(),
    ownerDocument,
    children: [],
    attributes: {},
    dataset: {},
    className: '',
    textContent: '',
    value: '',
    checked: false,
    hidden: false,
    inert: false,
    disabled: false,
    scrollTop: 0,
    append(...nodes) { this.children.push(...nodes); },
    appendChild(node) { this.children.push(node); return node; },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
    removeEventListener(type, listener) { listeners[type] = (listeners[type] || []).filter(item => item !== listener); },
    dispatch(type, values = {}) {
      const event = { type, target: this, currentTarget: this, preventDefault() { this.defaultPrevented = true; }, ...values };
      return Promise.all((listeners[type] || []).map(listener => listener(event)));
    },
    focus() { if (ownerDocument) ownerDocument.activeElement = this; },
    querySelectorAll() {
      const focusable = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
      const result = [];
      const visit = node => {
        if (!node || typeof node !== 'object') return;
        if (focusable.has(node.tagName)) result.push(node);
        for (const child of node.children || []) visit(child);
      };
      for (const child of this.children) visit(child);
      return result;
    },
  };
}

function createFakeDocument() {
  const listeners = {};
  const document = {
    activeElement: null,
    createElement(tagName) { return createFakeElement(tagName, document); },
    createTextNode(value) { return { nodeType: 3, textContent: String(value) }; },
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); },
    removeEventListener(type, listener) { listeners[type] = (listeners[type] || []).filter(item => item !== listener); },
    dispatch(type, values = {}) {
      const event = { type, preventDefault() { this.defaultPrevented = true; }, ...values };
      return Promise.all((listeners[type] || []).map(listener => listener(event)));
    },
  };
  document.body = createFakeElement('body', document);
  return document;
}

function collectText(node) {
  return [node?.textContent || '', ...(node?.children || []).map(collectText)].join(' ');
}

function findAll(node, predicate) {
  const result = [];
  const visit = item => {
    if (!item || typeof item !== 'object') return;
    if (predicate(item)) result.push(item);
    for (const child of item.children || []) visit(child);
  };
  visit(node);
  return result;
}

function findControl(rootNode, name, value) {
  return findAll(rootNode, node => node.attributes?.name === name && (value === undefined || node.value === value))[0];
}

function findButton(rootNode, text) {
  return findAll(rootNode, node => node.tagName === 'BUTTON' && node.textContent === text)[0];
}

function createHarness(overrides = {}) {
  const document = createFakeDocument();
  const rootNode = document.createElement('main');
  const calls = [];
  const sessions = overrides.sessions || [
    { id: 'wks_focus_123456', title: 'Alpha', status: 'running', transport: 'tui', routeKeys: ['feishu:chat-a'], focusRouteKeys: ['feishu:chat-a'], runtime: 'windows', runtimeId: 'rt-1', opencodeSessionId: 'ses-1', cwd: 'H:\\walker\\projects\\alpha', health: { status: 'healthy' }, watch: { active: true, mode: 'tui' }, lastHeartbeatAt: 1000, currentTurn: { state: 'working' }, lastActiveAt: 2000 },
    { id: 'wks_idle_234567', title: 'Beta', status: 'idle', transport: 'sse', routeKeys: ['feishu:chat-b'], focusRouteKeys: [], runtime: 'wsl', runtimeId: null, opencodeSessionId: null, cwd: 'H:\\walker\\projects\\beta', health: { status: 'warning', reason: 'late' }, watch: { active: true, mode: 'sse' }, lastActiveAt: 1500 },
    { id: 'wks_orphan_345678', title: 'Gamma', status: 'error', transport: 'unknown', routeKeys: [], focusRouteKeys: [], runtime: null, runtimeId: null, opencodeSessionId: null, cwd: 'H:\\' + 'very-long\\'.repeat(12) + 'gamma', health: null, watch: null, lastActiveAt: null },
  ];
  let routes = overrides.routes || [
    { routeKey: 'feishu:chat-a', focusSessionId: 'wks_focus_123456', sessions: ['wks_focus_123456', 'wks_idle_234567'], activeSessions: [{ id: 'wks_focus_123456', title: 'Alpha', status: 'running', isFocus: true }, { id: 'wks_idle_234567', title: 'Beta', status: 'idle', isFocus: false }], cwd: 'H:\\walker', updatedAt: 3000, dangling: false },
    { routeKey: 'feishu:dangling', focusSessionId: 'missing', sessions: ['missing'], activeSessions: [], cwd: '', updatedAt: null, dangling: true },
  ];
  const api = {
    async get(url) {
      calls.push(['get', url]);
      if (url === '/api/admin/sessions') return { data: { list: sessions } };
      if (url === '/api/admin/routes') return { data: { list: routes } };
      if (url.startsWith('/api/admin/sessions/')) return { data: { ...sessions.find(item => url.endsWith(encodeURIComponent(item.id))), timeline: [{ type: 'session.state', message: 'created', timestamp: 900 }] } };
      throw new Error('unexpected GET ' + url);
    },
    async post(url, body) { calls.push(['post', url, body]); return { data: {} }; },
    async patch(url, body) { calls.push(['patch', url, body]); return { data: {} }; },
    async delete(url, options) { calls.push(['delete', url, options]); return { data: {} }; },
    ...overrides.api,
  };
  const confirmations = [];
  const confirmAnswers = [...(overrides.confirmAnswers || [])];
  const confirm = {
    element: document.createElement('div'),
    async ask(message) { confirmations.push(message); return confirmAnswers.length ? confirmAnswers.shift() : true; },
    cleanup() {},
  };
  const navigations = [];
  const context = {
    document,
    root: rootNode,
    api,
    confirm,
    route: overrides.route || { params: {}, query: {} },
    signal: new AbortController().signal,
    isCurrent: () => true,
    commit(callback) { callback(); },
    async navigate(hash) { navigations.push(hash); },
    store: overrides.store,
  };
  return { document, rootNode, calls, confirmations, navigations, context, sessions, get routes() { return routes; }, setRoutes(value) { routes = value; } };
}

test.before(prepareModules);
test.after(() => fs.rmSync(moduleDir, { recursive: true, force: true }));

test('Session 组合过滤只保留满足全部条件的项', async () => {
  const { filterSessions } = await importPage();
  const sessions = [
    { id: 's1', title: 'Alpha Worker', status: 'running', agent: 'opencode', runtime: 'node', routeKeys: ['r1'] },
    { id: 's2', title: 'Alpha Other', status: 'running', agent: 'claude', runtime: 'node', routeKeys: ['r1'] },
    { id: 's3', title: 'Alpha Orphan', status: 'idle', agent: 'opencode', runtime: 'node', routeKeys: [] },
  ];
  assert.deepEqual(filterSessions(sessions, { query: 'alpha', status: 'running', agent: 'opencode' }).map(item => item.id), ['s1']);
  assert.deepEqual(filterSessions(sessions, { query: 'alpha', agent: 'opencode', status: 'idle' }).map(item => item.id), ['s3']);
  assert.deepEqual(filterSessions(sessions, { query: 'alpha', runtime: 'node', agent: 'claude' }).map(item => item.id), ['s2']);
});

test('Session 搜索使用本地过滤且缺失运行字段显示 unknown', async () => {
  const page = await importPage();
  const harness = createHarness();
  const mounted = await page.mount(harness.context);
  assert.equal(harness.calls.filter(call => call[0] === 'get' && call[1] === '/api/admin/sessions').length, 1);
  assert.match(collectText(harness.rootNode), /unknown/);
  assert.match(collectText(harness.rootNode), /H:\\…\\very-long\\gamma/);
  const query = findControl(harness.rootNode, 'session-query');
  query.value = 'beta';
  await query.dispatch('input');
  query.value = 'gamma';
  await query.dispatch('input');
  assert.equal(harness.calls.filter(call => call[0] === 'get' && call[1] === '/api/admin/sessions').length, 1);
  assert.match(collectText(mounted.tabs.panels.get('sessions')), /wks_orphan_345678/);
  assert.doesNotMatch(collectText(mounted.tabs.panels.get('sessions')), /wks_idle_234567/);
  mounted.cleanup();
});

test('Session 深链详情展示运行字段，关闭恢复筛选 Tab 和滚动', async () => {
  const page = await importPage();
  const saved = [];
  const harness = createHarness({
    route: { params: { id: 'wks_focus_123456' }, query: { tab: 'sessions' } },
    store: { getState: () => ({ filters: { sessions: { query: 'alpha', status: 'running', agent: 'opencode', runtime: 'windows', tab: 'sessions', scrollTop: 88 } } }), setPageFilters(_page, state) { saved.push(state); } },
  });
  const mounted = await page.mount(harness.context);
  assert.equal(harness.rootNode.scrollTop, 88);
  const detailText = collectText(mounted.drawer.element);
  for (const value of ['rt-1', 'ses-1', 'healthy', 'tui', 'working', 'created']) assert.match(detailText, new RegExp(value));
  assert.equal(findButton(mounted.tabs.panels.get('sessions'), '停止 Session'), undefined);
  assert.ok(findButton(mounted.drawer.element, '停止 Session'));
  assert.ok(findButton(mounted.drawer.element, '删除 Session'));
  harness.rootNode.scrollTop = 121;
  await mounted.drawer.closeButton.dispatch('click');
  assert.deepEqual(harness.navigations, ['#sessions?tab=sessions']);
  assert.equal(findControl(harness.rootNode, 'session-query').value, 'alpha');
  assert.equal(harness.rootNode.scrollTop, 121);
  assert.equal(saved.at(-1).scrollTop, 121);
  mounted.cleanup();
});

test('Session 详情 Escape 与关闭按钮使用相同恢复语义', async () => {
  const page = await importPage();
  const saved = [];
  const harness = createHarness({
    route: { params: { id: 'wks_focus_123456' }, query: { tab: 'sessions' } },
    store: { getState: () => ({ filters: { sessions: { query: 'alpha', status: 'running', tab: 'sessions', scrollTop: 55 } } }), setPageFilters(_page, state) { saved.push({ ...state }); } },
  });
  const mounted = await page.mount(harness.context);
  harness.rootNode.scrollTop = 144;
  await harness.document.dispatch('keydown', { key: 'Escape' });
  assert.equal(mounted.drawer.element.hidden, true);
  assert.deepEqual(harness.navigations, ['#sessions?tab=sessions']);
  assert.equal(findControl(harness.rootNode, 'session-query').value, 'alpha');
  assert.equal(harness.rootNode.scrollTop, 144);
  assert.equal(saved.at(-1).scrollTop, 144);
  await harness.document.dispatch('keydown', { key: 'Escape' });
  assert.deepEqual(harness.navigations, ['#sessions?tab=sessions']);
  mounted.cleanup();
});

test('Session 危险操作仅在详情确认并在失败后重拉服务端状态', async () => {
  const page = await importPage();
  let fail = true;
  const harness = createHarness({
    route: { params: { id: 'wks_focus_123456' }, query: {} },
    api: {
      async post(url, body) { harness.calls.push(['post', url, body]); if (fail) { fail = false; throw new Error('stop failed'); } return { data: {} }; },
    },
  });
  const mounted = await page.mount(harness.context);
  await findButton(mounted.drawer.element, '停止 Session').dispatch('click');
  assert.match(harness.confirmations[0], /停止 Session wks_focus_123456.*运行/);
  assert.equal(harness.calls.filter(call => call[0] === 'get' && call[1] === '/api/admin/sessions').length, 2);
  assert.equal(harness.calls.filter(call => call[0] === 'get' && call[1].includes('wks_focus_123456')).length, 2);
  assert.match(collectText(harness.rootNode), /stop failed/);
  mounted.cleanup();
});

test('Session 删除明确确认，失败重拉并保留详情，成功重拉后关闭详情', async () => {
  const page = await importPage();
  let failDelete = true;
  const harness = createHarness({
    route: { params: { id: 'wks_focus_123456' }, query: { tab: 'sessions' } },
    api: {
      async delete(url, options) {
        harness.calls.push(['delete', url, options]);
        if (failDelete) {
          failDelete = false;
          throw new Error('delete failed');
        }
        return { data: {} };
      },
    },
  });
  const mounted = await page.mount(harness.context);
  await findButton(mounted.drawer.element, '删除 Session').dispatch('click');
  assert.match(harness.confirmations[0], /删除 Session wks_focus_123456.*列表.*关联 Route/);
  assert.ok(harness.calls.some(call => call[0] === 'delete' && call[1] === '/api/admin/sessions/wks_focus_123456'));
  assert.equal(harness.calls.filter(call => call[0] === 'get' && call[1] === '/api/admin/sessions').length, 2);
  assert.equal(harness.calls.filter(call => call[0] === 'get' && call[1] === '/api/admin/sessions/wks_focus_123456').length, 2);
  assert.equal(mounted.drawer.element.hidden, false);
  assert.deepEqual(harness.navigations, []);
  assert.match(collectText(harness.rootNode), /delete failed/);

  await findButton(mounted.drawer.element, '删除 Session').dispatch('click');
  assert.equal(harness.calls.filter(call => call[0] === 'delete' && call[1] === '/api/admin/sessions/wks_focus_123456').length, 2);
  assert.equal(harness.calls.filter(call => call[0] === 'get' && call[1] === '/api/admin/sessions').length, 3);
  assert.equal(mounted.drawer.element.hidden, true);
  assert.deepEqual(harness.navigations, ['#sessions?tab=sessions']);
  mounted.cleanup();
});

test('Route Tab 区分 1:N 成员、焦点、CWD 和状态', async () => {
  const page = await importPage();
  const harness = createHarness({ route: { params: {}, query: { tab: 'routes' } } });
  const mounted = await page.mount(harness.context);
  const text = collectText(harness.rootNode);
  assert.match(text, /feishu:chat-a/);
  assert.match(text, /wks_focus_123456/);
  assert.match(text, /wks_idle_234567/);
  assert.match(text, /H:\\walker/);
  assert.match(text, /feishu:dangling/);
  assert.match(text, /Route 映射表/);
  assert.ok(findButton(harness.rootNode, '+ 添加路由说明'));
  assert.equal(findButton(harness.rootNode, '添加 Session'), undefined);
  assert.equal(findButton(harness.rootNode, '切换焦点'), undefined);
  assert.equal(findButton(harness.rootNode, '移除成员'), undefined);
  assert.equal(findButton(harness.rootNode, '修改 CWD'), undefined);
  assert.equal(findButton(harness.rootNode, '清理悬空 Route'), undefined);
  assert.equal(findButton(harness.rootNode, '删除整条 Route'), undefined);
  mounted.cleanup();
});

test('Route 操作查看打开详情，解绑仅提示', async () => {
  const page = await importPage();
  const harness = createHarness({ route: { params: {}, query: { tab: 'routes' } } });
  const mounted = await page.mount(harness.context);
  const viewLinks = findAll(harness.rootNode, node => node.tagName === 'SPAN' && node.textContent === '查看');
  assert.ok(viewLinks.length > 0);
  await viewLinks[0].dispatch('click');
  assert.equal(findButton(mounted.drawer.element, '停止 Session') != null, true);
  await mounted.drawer.closeButton.dispatch('click');

  const unbindLinks = findAll(harness.rootNode, node => node.tagName === 'SPAN' && node.textContent === '解绑');
  assert.ok(unbindLinks.length > 0);
  const callsBefore = harness.calls.length;
  await unbindLinks[0].dispatch('click');
  assert.equal(harness.calls.length, callsBefore);
  const feedbackText = collectText(harness.rootNode);
  assert.match(feedbackText, /已解绑/);
  mounted.cleanup();
});

test('列表重拉后旧 Session 和 Route 控件监听失效', async () => {
  const page = await importPage();
  const harness = createHarness({ route: { params: {}, query: { tab: 'sessions' } } });
  const mounted = await page.mount(harness.context);
  const oldStatusLink = findAll(harness.rootNode, node => node.tagName === 'SPAN' && node.textContent === '/status')[0];
  assert.ok(oldStatusLink);

  await harness.context.root.dispatch('walker:refresh');
  await new Promise(resolve => setTimeout(resolve, 0));
  const newStatusLinks = findAll(harness.rootNode, node => node.tagName === 'SPAN' && node.textContent === '/status');
  assert.ok(newStatusLinks.length > 0);
  const callsAfterReload = harness.calls.length;
  await oldStatusLink.dispatch('click');
  await newStatusLinks[0].dispatch('click');
  assert.ok(harness.calls.length > callsAfterReload);
  assert.equal(harness.calls.filter(call => call[0] === 'get' && call[1].startsWith('/api/admin/sessions/')).length, 1);
  mounted.cleanup();
});

test('详情重开后旧危险操作按钮监听失效', async () => {
  const page = await importPage();
  let fail = true;
  const harness = createHarness({
    route: { params: { id: 'wks_focus_123456' }, query: {} },
    api: {
      async post(url, body) {
        harness.calls.push(['post', url, body]);
        if (fail) {
          fail = false;
          throw new Error('stop failed');
        }
        return { data: {} };
      },
    },
  });
  const mounted = await page.mount(harness.context);
  const oldStopButton = findButton(mounted.drawer.element, '停止 Session');

  await oldStopButton.dispatch('click');
  const reloadedStopButton = findButton(mounted.drawer.element, '停止 Session');
  await reloadedStopButton.dispatch('click');
  const callsAfterReopen = harness.calls.length;
  await oldStopButton.dispatch('click');
  await reloadedStopButton.dispatch('click');

  assert.equal(harness.calls.length, callsAfterReopen);
  assert.equal(harness.calls.filter(call => call[0] === 'post' && call[1].endsWith('/stop')).length, 2);
  mounted.cleanup();
});

test('cleanup 后页面控件不再发起请求', async () => {
  const page = await importPage();
  const harness = createHarness();
  const mounted = await page.mount(harness.context);
  const before = harness.calls.length;
  const query = findControl(harness.rootNode, 'session-query');
  mounted.cleanup();
  query.value = 'alpha';
  await query.dispatch('input');
  assert.equal(harness.calls.length, before);
  assert.equal(mounted.drawer.element.hidden, true);
});
