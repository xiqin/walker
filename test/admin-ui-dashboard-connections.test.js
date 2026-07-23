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
  moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-admin-t5-'));
  fs.cpSync(jsDir, path.join(moduleDir, 'js'), { recursive: true });
  fs.writeFileSync(path.join(moduleDir, 'package.json'), '{"type":"module"}\n');
}

function importModule(relativePath) {
  return import(pathToFileURL(path.join(moduleDir, 'js', relativePath)).href);
}

function createFakeElement(tagName = 'div', ownerDocument = null) {
  return {
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
    focus() { if (ownerDocument) ownerDocument.activeElement = this; },
  };
}

function createFakeDocument() {
  const document = {
    activeElement: null,
    createElement(tagName) { return createFakeElement(tagName, document); },
    createTextNode(value) { return { nodeType: 3, textContent: String(value) }; },
  };
  document.body = createFakeElement('body', document);
  return document;
}

function collectText(node) {
  return [node?.textContent || '', ...(node?.children || []).map(collectText)].join(' ');
}

function findAll(node, predicate) {
  const matches = [];
  function visit(current) {
    if (!current || typeof current !== 'object') return;
    if (predicate(current)) matches.push(current);
    for (const child of current.children || []) visit(child);
  }
  visit(node);
  return matches;
}

function findButton(rootNode, label) {
  return findAll(rootNode, node => node.tagName === 'BUTTON' && node.textContent === label)[0];
}

function findSection(rootNode, heading) {
  return findAll(rootNode, node => node.tagName === 'SECTION'
    && node.children?.some(child => child.tagName === 'H2' && child.textContent === heading))[0];
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function response(data) {
  return { ok: true, data };
}

function createContext(api, options = {}) {
  const document = createFakeDocument();
  const rootNode = createFakeElement('main', document);
  const navigated = [];
  const timers = [];
  const cleared = [];
  const window = {
    setInterval(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearInterval(id) { cleared.push(id); },
  };
  return {
    document,
    root: rootNode,
    api,
    signal: options.signal || new AbortController().signal,
    navigate: async hash => { navigated.push(hash); },
    isCurrent: () => true,
    commit(callback) { callback(); },
    window,
    navigated,
    timers,
    cleared,
  };
}

const dashboardFixture = {
  status: {
    walker: { status: 'healthy', checkedAt: 1000 },
    feishu: { status: 'failed', checkedAt: 1100, reason: '飞书 WebSocket 断开', action: { type: 'navigate', target: '#connections' } },
    opencode: { status: 'warning', checkedAt: 1200, reason: 'OpenCode 响应缓慢', action: { type: 'navigate', target: '#connections' } },
    tuiBridge: { status: 'unknown', checkedAt: 1300, reason: 'TUI Bridge 探针不可用' },
    runtimes: { status: 'healthy', checkedAt: 1400 },
    watchers: { status: 'healthy', checkedAt: 1500 },
    health: { status: 'healthy', checkedAt: 1600 },
    admin: { status: 'healthy', checkedAt: 1700 },
  },
  sessions: {
    list: [
      { id: 'wks_active_123456', title: '部署助手', status: 'running', transport: 'tui', runtimeId: 'rt_1', routeKeys: ['feishu:chat:1'], lastActiveAt: 5000 },
      { id: 'wks_idle', title: '闲置会话', status: 'idle', transport: 'polling', routeKeys: [], lastActiveAt: 2000 },
    ],
    total: 2,
  },
  routes: { list: [{ routeKey: 'feishu:chat:1', dangling: false }, { routeKey: 'orphan', dangling: true }], total: 2 },
  events: [{ id: 'evt_1', level: 'error', type: 'session.failed', message: '执行失败', sessionId: 'wks_active_123456', createdAt: 4500 }],
  metrics: { messages: 12, commands: 3, prompts: 6, errors: 2, buckets: [{ minute: 1000, messages: 2, prompts: 1, errors: 0 }, { minute: 2000, messages: 4, prompts: 2, errors: 1 }] },
};

function dashboardApi(overrides = {}) {
  const values = { ...dashboardFixture, ...overrides };
  return {
    async get(url) {
      if (url === '/api/admin/status') return response(values.status);
      if (url === '/api/admin/sessions') return response(values.sessions);
      if (url === '/api/admin/routes') return response(values.routes);
      if (url.startsWith('/api/admin/events')) return response(values.events);
      if (url === '/api/admin/metrics') return response(values.metrics);
      throw new Error('unexpected URL ' + url);
    },
  };
}

test.before(prepareModules);
test.after(() => fs.rmSync(moduleDir, { recursive: true, force: true }));

test('Dashboard 渲染异常优先的完整工作台和活跃 Session', async () => {
  const { mount } = await importModule('pages/dashboard.js');
  const context = createContext(dashboardApi());
  await mount(context);
  const text = collectText(context.root);

  assert.match(text, /需处理问题.*服务状态.*会话摘要.*近期活动.*最近 60 分钟趋势.*活跃 Session/s);
  assert.match(text, /Session.*2.*Route.*2.*悬空 Route.*1/s);
  assert.match(text, /执行失败/);
  assert.match(text, /wks_.*部署助手.*running.*tui.*rt_1/s);

  const page = context.root.children[0];
  const issues = findSection(page, '需处理问题');
  const status = findSection(page, '服务状态');
  assert.ok(page.children.indexOf(issues) < page.children.indexOf(status), '需处理问题应位于常规服务状态之前');
  const statusText = collectText(status);
  assert.match(statusText, /飞书.*OpenCode.*TUI Bridge.*Walker/s);
  assert.ok(statusText.indexOf('飞书') < statusText.indexOf('OpenCode'), 'failed 应排在 warning 之前');
  assert.ok(statusText.indexOf('OpenCode') < statusText.indexOf('TUI Bridge'), 'warning 应排在 unknown 之前');
  assert.ok(statusText.indexOf('TUI Bridge') < statusText.indexOf('Walker'), 'unknown 应排在 healthy 之前');
});

test('Dashboard 问题动作导航到目标工作区或 Session 详情', async () => {
  const { mount } = await importModule('pages/dashboard.js');
  const context = createContext(dashboardApi());
  await mount(context);

  const actions = findAll(context.root, node => node.tagName === 'BUTTON' && /处理|查看/.test(node.textContent));
  assert.ok(actions.length >= 2);
  assert.match(actions[0].attributes['aria-label'], /飞书/);
  await actions[0].onclick();
  const sessionAction = findAll(context.root, node => node.tagName === 'BUTTON' && node.textContent === '查看 Session')[0];
  assert.match(sessionAction.attributes['aria-label'], /wks_active_123456/);
  await sessionAction.onclick();
  assert.deepEqual(context.navigated, ['#connections', '#sessions/wks_active_123456']);
});

test('Dashboard 局部数据失败时保留其他区域并显示原始原因', async () => {
  const api = dashboardApi();
  const originalGet = api.get;
  api.get = async url => {
    if (url === '/api/admin/status') throw new Error('status backend offline');
    return originalGet(url);
  };
  const { mount } = await importModule('pages/dashboard.js');
  const context = createContext(api);
  await mount(context);
  const text = collectText(context.root);

  assert.match(text, /服务状态.*status backend offline/s);
  assert.match(text, /会话摘要.*Session.*2/s);
  assert.match(text, /近期活动.*执行失败/s);
  assert.match(text, /最近 60 分钟趋势.*消息.*6/s);
});

test('Dashboard 按最近 60 个分钟桶汇总趋势并说明分钟粒度', async () => {
  const buckets = Array.from({ length: 60 }, (_, index) => ({
    minute: Date.UTC(2026, 6, 10, 9, 31 + index, 0),
    messages: index === 0 ? 1 : 0,
    prompts: index === 58 ? 2 : 0,
    errors: index === 59 ? 3 : 0,
  }));
  const { mount } = await importModule('pages/dashboard.js');
  const context = createContext(dashboardApi({
    metrics: { messages: 999, prompts: 999, errors: 999, buckets },
  }));
  await mount(context);

  const trend = findSection(context.root, '最近 60 分钟趋势');
  const text = collectText(trend);
  assert.match(text, /每分钟一个桶/);
  assert.match(text, /消息.*1.*Prompt.*2.*错误.*3/s);
  assert.doesNotMatch(text, /999/);
});

function connectionsApi(options = {}) {
  const calls = [];
  const ensurePending = options.ensurePending;
  const refreshPending = options.refreshPending;
  const detailPending = options.detailPending || {};
  let statusRead = 0;
  const statusValues = [
    {
      feishu: { status: 'failed', checkedAt: 1000, reason: 'tenant access denied' },
      opencode: { status: 'warning', checkedAt: 1100, reason: 'server warming' },
      tuiBridge: { status: 'healthy', checkedAt: 1200 },
      runtimes: { status: 'warning', checkedAt: 1300, reason: 'runtime lease expiring' },
    },
    {
      feishu: { status: 'failed', checkedAt: 1000, reason: 'tenant access denied' },
      opencode: { status: 'healthy', checkedAt: 9000 },
      tuiBridge: { status: 'healthy', checkedAt: 1200 },
      runtimes: { status: 'healthy', checkedAt: 9000 },
    },
  ];
  const api = {
    calls,
    async get(url, requestOptions) {
      calls.push(['GET', url, requestOptions]);
      if (url === '/api/admin/status') {
        const readIndex = statusRead++;
        if (readIndex === 1 && refreshPending) return refreshPending.promise;
        return response(statusValues[Math.min(readIndex, statusValues.length - 1)]);
      }
      if (url === '/api/admin/agents') return response({ list: [{ name: 'opencode', available: true, config: { serverUrl: 'http://127.0.0.1:4096', autostart: true } }], total: 1 });
      if (url === '/api/admin/runtime') return response({ windows: { type: 'windows', cwd: 'H:\\walker', cwdExists: true }, wsl: { type: 'wsl', distro: 'Ubuntu-24.04', cwd: '/mnt/h/walker', cwdExists: true, ipDetected: false, ipError: 'wsl.exe unavailable' } });
      if (url === '/api/admin/tui-runtimes') return response({ list: [
        { runtimeId: 'rt_active', sessionId: 'ses_active', walkerSessionId: 'wks_active', cwd: 'H:\\walker', opencodeVersion: '1.2.3', bridgeProtocolVersion: 5, lastHeartbeatAt: 8000, lease: { status: 'active', remainingMs: 80000, expiresAt: 88000 }, health: { status: 'healthy', reason: null }, token: 'must-not-render' },
        { runtimeId: 'rt_expiring', sessionId: 'ses_expiring', walkerSessionId: 'wks_expiring', cwd: '/workspace', opencodeVersion: '1.2.3', bridgeProtocolVersion: 4, lastHeartbeatAt: 7000, lease: { status: 'expiring', remainingMs: 5000, expiresAt: 12000 }, health: { status: 'warning', reason: 'runtime lease expiring' }, nested: { authorization: 'must-not-render' } },
        { runtimeId: 'rt_expired', sessionId: 'ses_expired', walkerSessionId: 'wks_expired', cwd: '/old', opencodeVersion: '1.0.0', bridgeProtocolVersion: 3, lastHeartbeatAt: 1000, lease: { status: 'expired', remainingMs: 0, expiresAt: 1000 }, health: { status: 'failed', reason: 'runtime lease expired' }, apiKey: 'must-not-render' },
      ], total: 3 });
      if (url === '/api/admin/tui-runtimes/rt_expiring') return response({ runtimeId: 'rt_expiring', sessionId: 'ses_expiring', walkerSessionId: 'wks_expiring', cwd: '/workspace', opencodeVersion: '1.2.3', bridgeProtocolVersion: 4, lastHeartbeatAt: 7000, lease: { status: 'expiring', remainingMs: 5000, expiresAt: 12000 }, health: { status: 'warning', reason: 'runtime lease expiring' }, password: 'must-not-render' });
      if (url === '/api/admin/tui-runtimes/rt_active' && detailPending.rt_active) return detailPending.rt_active.promise;
      if (url === '/api/admin/tui-runtimes/rt_expired' && detailPending.rt_expired) return detailPending.rt_expired.promise;
      throw new Error('unexpected URL ' + url);
    },
    async post(url, body, requestOptions) {
      calls.push(['POST', url, body, requestOptions]);
      if (url === '/api/admin/agents/opencode/ensure-ready' && ensurePending) return ensurePending.promise;
      if (url === '/api/admin/agents/opencode/ensure-ready') return response({ ready: true, agent: 'opencode' });
      if (url === '/api/admin/agents/opencode/check') return response({ healthy: true, agent: 'opencode' });
      if (url === '/api/admin/runtime/check') return response({ windows: { cwdExists: true }, wsl: { ipDetected: true, ip: '172.20.0.1' } });
      throw new Error('unexpected POST ' + url);
    },
  };
  return api;
}

test('连接页统一展示飞书 OpenCode TUI Bridge Runtime 和 Windows WSL', async () => {
  const { mount } = await importModule('pages/connections.js');
  const context = createContext(connectionsApi());
  await mount(context);
  const text = collectText(context.root);

  assert.match(text, /飞书.*tenant access denied.*OpenCode.*server warming.*TUI Bridge.*Runtime/s);
  assert.match(text, /Windows.*H:\\walker.*WSL/s);
  assert.match(text, /wsl.exe unavailable.*Ubuntu-24.04/s);
  assert.match(text, /TUI Runtime.*rt_active.*rt_expiring.*rt_expired/s);
  assert.match(text, /租约正常.*即将过期.*已过期/s);
  assert.doesNotMatch(text, /must-not-render|token|authorization|apiKey/i);
  const detailButtons = findAll(context.root, node => node.tagName === 'BUTTON' && node.textContent === '查看详情');
  assert.deepEqual(detailButtons.map(button => button.attributes['aria-label']), [
    '查看 Runtime rt_active 详情', '查看 Runtime rt_expiring 详情', '查看 Runtime rt_expired 详情',
  ]);
  assert.match(findButton(context.root, '检测 OpenCode').attributes['aria-label'], /OpenCode/);
  assert.match(findButton(context.root, '恢复 OpenCode').attributes['aria-label'], /OpenCode/);
});

test('连接页 WSL 未检测 IP 或 CWD 时不显示健康假阳性', async () => {
  const api = connectionsApi();
  api.get = async (url, requestOptions) => {
    api.calls.push(['GET', url, requestOptions]);
    if (url === '/api/admin/status') return response({ feishu: { status: 'healthy' }, opencode: { status: 'healthy' }, tuiBridge: { status: 'healthy' }, runtimes: { status: 'healthy' } });
    if (url === '/api/admin/agents') return response({ list: [], total: 0 });
    if (url === '/api/admin/runtime') return response({
      windows: { type: 'windows', cwd: 'H:\\walker', cwdExists: true, cwdChecked: true },
      wsl: { type: 'wsl', distro: 'Ubuntu-24.04', cwd: '/mnt/h/walker', cwdExists: false, cwdChecked: false, ipDetected: true, ip: '', ipError: 'WSL IP not detected' },
    });
    if (url === '/api/admin/tui-runtimes') return response({ list: [], total: 0 });
    throw new Error('unexpected URL ' + url);
  };
  const { mount } = await importModule('pages/connections.js');
  const context = createContext(api);
  await mount(context);
  const wslSection = findAll(context.root, node => node.tagName === 'ARTICLE'
    && collectText(node).includes('WSL'))[0];
  const text = collectText(wslSection);

  assert.match(text, /WSL.*警告/s);
  assert.match(text, /CWD 可用\s*未检测/s);
  assert.match(text, /IP\s*未检测/s);
  assert.match(text, /WSL IP not detected/);
});

test('连接检测刷新 checkedAt 和状态并显示结果反馈', async () => {
  const api = connectionsApi();
  const { mount } = await importModule('pages/connections.js');
  const context = createContext(api);
  await mount(context);
  const check = findButton(context.root, '检测 OpenCode');
  assert.ok(check);

  await check.onclick();
  const text = collectText(context.root);
  assert.match(text, /OpenCode.*正常/s);
  assert.match(text, /1970.*09.*00/s);
  assert.match(text, /OpenCode 检测完成/);
  assert.equal(api.calls.some(call => call[0] === 'POST' && call[1] === '/api/admin/agents/opencode/check'), true);
});

test('连接恢复操作在请求期间 busy，完成后反馈并重新加载', async () => {
  const pending = deferred();
  const api = connectionsApi({ ensurePending: pending });
  const { mount } = await importModule('pages/connections.js');
  const context = createContext(api);
  await mount(context);
  const ensure = findButton(context.root, '恢复 OpenCode');
  const action = ensure.onclick();

  assert.equal(ensure.disabled, true);
  assert.equal(ensure.attributes['aria-busy'], 'true');
  pending.resolve(response({ ready: true, agent: 'opencode' }));
  await action;
  assert.equal(ensure.disabled, false);
  assert.match(collectText(context.root), /OpenCode 已恢复/);
  assert.ok(api.calls.filter(call => call[0] === 'GET' && call[1] === '/api/admin/status').length >= 2);
});

test('悬挂自动刷新期间 ensure-ready 强制刷新排队并在当前请求后执行', async () => {
  const refreshPending = deferred();
  const api = connectionsApi({ refreshPending });
  const { mount } = await importModule('pages/connections.js');
  const context = createContext(api);
  await mount(context);

  const automaticRefresh = context.timers[0].callback();
  const ensure = findButton(context.root, '恢复 OpenCode');
  const action = ensure.onclick();
  await Promise.resolve();
  assert.equal(api.calls.filter(call => call[0] === 'GET' && call[1] === '/api/admin/status').length, 2);

  refreshPending.resolve(response({
    feishu: { status: 'healthy', checkedAt: 8000 }, opencode: { status: 'healthy', checkedAt: 8000 },
    tuiBridge: { status: 'healthy', checkedAt: 8000 }, runtimes: { status: 'healthy', checkedAt: 8000 },
  }));
  await automaticRefresh;
  await action;
  assert.ok(api.calls.filter(call => call[0] === 'GET' && call[1] === '/api/admin/status').length >= 3,
    '操作触发的强制刷新不得因自动刷新 loading 而丢失');
});

test('cleanup 取消悬挂自动刷新后的强制刷新排队', async () => {
  const refreshPending = deferred();
  const api = connectionsApi({ refreshPending });
  const { mount } = await importModule('pages/connections.js');
  const context = createContext(api);
  const cleanup = await mount(context);

  const automaticRefresh = context.timers[0].callback();
  const action = findButton(context.root, '恢复 OpenCode').onclick();
  await Promise.resolve();
  cleanup();
  refreshPending.resolve(response({}));
  await automaticRefresh;
  await action;
  assert.equal(api.calls.filter(call => call[0] === 'GET' && call[1] === '/api/admin/status').length, 2);
});

test('TUI Runtime 详情展示完整安全字段且临期租约可辨识', async () => {
  const api = connectionsApi();
  const { mount } = await importModule('pages/connections.js');
  const context = createContext(api);
  await mount(context);
  const detail = findAll(context.root, node => node.tagName === 'BUTTON' && node.textContent === '查看详情')[1];
  await detail.onclick();
  const text = collectText(context.root);

  assert.match(text, /Runtime 详情.*rt_expiring.*ses_expiring.*wks_expiring.*\/workspace.*1.2.3.*协议 4/s);
  assert.match(text, /即将过期.*5 秒.*runtime lease expiring/s);
  assert.doesNotMatch(text, /must-not-render|password/i);
});

test('TUI Runtime A/B 详情反序完成时只显示 B', async () => {
  const first = deferred();
  const second = deferred();
  const api = connectionsApi({ detailPending: { rt_active: first, rt_expired: second } });
  const { mount } = await importModule('pages/connections.js');
  const context = createContext(api);
  await mount(context);
  const buttons = findAll(context.root, node => node.tagName === 'BUTTON' && node.textContent === '查看详情');

  const firstRequest = buttons[0].onclick();
  const secondRequest = buttons[2].onclick();
  second.resolve(response({ runtimeId: 'rt_expired', sessionId: 'ses_B', lease: { status: 'expired', remainingMs: 0 }, health: { status: 'failed' } }));
  await secondRequest;
  first.resolve(response({ runtimeId: 'rt_active', sessionId: 'ses_A', lease: { status: 'active', remainingMs: 5000 }, health: { status: 'healthy' } }));
  await firstRequest;

  const detailText = collectText(findAll(context.root, node => node.className === 'runtime-detail')[0]);
  assert.match(detailText, /rt_expired.*ses_B/s);
  assert.doesNotMatch(detailText, /rt_active|ses_A/);
});

test('连接页 cleanup 取消正在读取的 Runtime 详情', async () => {
  const pending = deferred();
  let detailSignal;
  const api = connectionsApi({ detailPending: { rt_active: pending } });
  const originalGet = api.get;
  api.get = (url, options) => {
    if (url === '/api/admin/tui-runtimes/rt_active') detailSignal = options.signal;
    return originalGet(url, options);
  };
  const { mount } = await importModule('pages/connections.js');
  const context = createContext(api);
  const cleanup = await mount(context);
  const request = findAll(context.root, node => node.tagName === 'BUTTON' && node.textContent === '查看详情')[0].onclick();

  cleanup();
  assert.equal(detailSignal.aborted, true);
  pending.resolve(response({ runtimeId: 'rt_active', sessionId: 'late' }));
  await request;
  assert.doesNotMatch(collectText(context.root), /Runtime 详情.*late/s);
});

test('连接页快速刷新使用页面 signal，cleanup 后停止定时器且不再刷新', async () => {
  const api = connectionsApi();
  const { mount } = await importModule('pages/connections.js');
  const context = createContext(api);
  const cleanup = await mount(context);
  assert.equal(context.timers.length, 1);
  assert.equal(context.timers[0].delay, 5000);
  assert.equal(api.calls.filter(call => call[0] === 'GET').every(call => call[2]?.signal === context.signal), true);

  cleanup();
  assert.deepEqual(context.cleared, [1]);
  const callsBefore = api.calls.length;
  await context.timers[0].callback();
  assert.equal(api.calls.length, callsBefore);
});
