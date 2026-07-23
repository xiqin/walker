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
  moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-admin-workspaces-'));
  fs.cpSync(jsDir, path.join(moduleDir, 'js'), { recursive: true });
  fs.writeFileSync(path.join(moduleDir, 'package.json'), '{"type":"module"}\n');
}

function importModule(relativePath) {
  return import(pathToFileURL(path.join(moduleDir, 'js', relativePath)).href);
}

function createFakeElement(tagName = 'div', ownerDocument = null) {
  const listeners = {};
  const node = {
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
    scrollHeight: 0,
    append(...nodes) { this.children.push(...nodes); },
    appendChild(child) { this.children.push(child); return child; },
    replaceChildren(...nodes) { this.children = nodes; },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    removeAttribute(name) { delete this.attributes[name]; },
    addEventListener(type, listener) { (listeners[type] ||= []).push(listener); this['on' + type] = listener; },
    removeEventListener(type, listener) {
      listeners[type] = (listeners[type] || []).filter(item => item !== listener);
      if (this['on' + type] === listener) delete this['on' + type];
    },
    dispatch(type, event = {}) {
      for (const listener of listeners[type] || []) listener({ target: this, currentTarget: this, preventDefault() {}, ...event });
    },
    focus() { if (ownerDocument) ownerDocument.activeElement = this; },
    querySelectorAll() {
      const matches = [];
      const focusable = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA']);
      const visit = child => {
        if (!child || typeof child !== 'object') return;
        if (focusable.has(child.tagName)) matches.push(child);
        for (const nested of child.children || []) visit(nested);
      };
      for (const child of this.children) visit(child);
      return matches;
    },
  };
  return node;
}

function createFakeDocument() {
  const document = {
    activeElement: null,
    body: null,
    createElement(tagName) { return createFakeElement(tagName, document); },
    createTextNode(value) { return { nodeType: 3, textContent: String(value) }; },
    addEventListener() {},
    removeEventListener() {},
  };
  document.body = createFakeElement('body', document);
  return document;
}

function collectText(node) {
  return [node?.textContent || '', ...(node?.children || []).map(collectText)].join(' ');
}

function findElements(node, predicate) {
  const matches = [];
  function visit(current) {
    if (!current || typeof current !== 'object') return;
    if (predicate(current)) matches.push(current);
    for (const child of current.children || []) visit(child);
  }
  visit(node);
  return matches;
}

async function flushPromises() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function assertSelectedPanel(workspace, selected) {
  assert.equal(workspace.tabs.getSelected(), selected);
  for (const [id, panel] of workspace.tabs.panels) assert.equal(panel.hidden, id !== selected);
  for (const [id, button] of workspace.tabs.buttons) assert.equal(button.attributes['aria-selected'], String(id === selected));
  return workspace.tabs.panels.get(selected);
}

function feedbackIn(panel) {
  return findElements(panel, node => node.className === 'feedback')[0];
}

function parseMetricsContent(panel) {
  const output = findElements(panel, node => node.tagName === 'PRE')[0];
  return JSON.parse(output.textContent.slice(output.textContent.indexOf('{')));
}

test.before(prepareModules);
test.after(() => fs.rmSync(moduleDir, { recursive: true, force: true }));

test('活动工作区切换 Tab 会按各数据源能力实际应用共享过滤', async () => {
  const { createActivityWorkspace } = await importModule('pages/activity.js');
  const urls = [];
  const after = new Date('2026-07-22T08:30').getTime();
  const workspace = createActivityWorkspace({
    document: createFakeDocument(),
    api: {
      get: async url => {
        urls.push(url);
        if (url.startsWith('/api/admin/events')) {
          return { data: { events: [
            { createdAt: 2000, level: 'warn', sessionId: 'wks_1', routeKey: 'chat_1', type: 'error', message: 'timeout waiting' },
            { createdAt: 2001, level: 'warn', sessionId: 'wks_1', routeKey: 'chat_1', type: 'error', message: 'other failure' },
          ] } };
        }
        if (url.startsWith('/api/admin/logs')) {
          return { data: { lines: [
            { timestamp: after - 1, level: 'warn', sessionId: 'wks_1', routeKey: 'chat_1', type: 'error', message: 'timeout object before' },
            { timestamp: after, level: 'warn', sessionId: 'wks_1', routeKey: 'chat_1', type: 'error', message: 'timeout object equal' },
            { timestamp: after + 1, level: 'warn', sessionId: 'wks_1', routeKey: 'chat_1', type: 'error', message: 'timeout object after' },
            JSON.stringify({ ts: new Date(after - 1).toISOString(), level: 'warn', sessionID: 'wks_1', routeKey: 'chat_1', type: 'error', message: 'timeout string before' }),
            JSON.stringify({ ts: new Date(after).toISOString(), level: 'warn', sessionID: 'wks_1', routeKey: 'chat_1', type: 'error', message: 'timeout string equal' }),
            JSON.stringify({ ts: new Date(after + 1).toISOString(), level: 'warn', sessionID: 'wks_1', routeKey: 'chat_1', type: 'error', message: 'timeout string after' }),
            JSON.stringify({ ts: new Date(after + 1).toISOString(), level: 'warn', sessionId: 'wks_2', routeKey: 'chat_1', type: 'error', message: 'timeout wrong session' }),
            JSON.stringify({ ts: new Date(after + 1).toISOString(), level: 'warn', message: 'timeout sessionId=wks_1 routeKey=chat_1 type=error only in message' }),
            `not json ${new Date(after + 1).toISOString()} sessionId=wks_1 routeKey=chat_1 type=error timeout raw`,
          ] } };
        }
        return { data: {
          messages: 8,
          commands: 3,
          prompts: 2,
          errors: 4,
          averagePromptDurationMs: 25,
          buckets: [
            { minute: after - 60000, errors: 3 },
            { minute: after + 60000, errors: 1 },
          ],
        } };
      },
    },
    filters: {
      after: '2026-07-22T08:30',
      level: 'warn',
      keyword: 'timeout',
      sessionId: 'wks_1',
      routeKey: 'chat_1',
      type: 'error',
    },
  });

  const eventsPanel = assertSelectedPanel(workspace, 'events');
  await workspace.refreshEvents();
  assert.equal(urls.length, 1);
  const eventUrl = new URL('http://localhost' + urls[0]);
  assert.deepEqual(Object.fromEntries(eventUrl.searchParams), {
    after: String(after),
    level: 'warn',
    sessionId: 'wks_1',
    routeKey: 'chat_1',
    type: 'error',
  });
  assert.match(collectText(eventsPanel), /timeout waiting/);
  assert.doesNotMatch(collectText(eventsPanel), /other failure/);
  assert.match(collectText(eventsPanel), /关键词.*本地/);

  workspace.tabs.select('logs');
  await flushPromises();
  const logsPanel = assertSelectedPanel(workspace, 'logs');
  assert.equal(urls.length, 2);
  const logUrl = new URL('http://localhost' + urls[1]);
  assert.equal(logUrl.pathname, '/api/admin/logs');
  assert.deepEqual(Object.fromEntries(logUrl.searchParams), { level: 'warn', keyword: 'timeout' });
  assert.equal(workspace.logOutput.textContent, ['timeout object after', JSON.stringify({ ts: new Date(after + 1).toISOString(), level: 'warn', sessionID: 'wks_1', routeKey: 'chat_1', type: 'error', message: 'timeout string after' })].join('\n'));
  assert.doesNotMatch(collectText(logsPanel), /before|equal|wrong session|only in message|timeout raw/);
  assert.match(collectText(logsPanel), /起始时间.*Session.*Route.*类型.*本地/);

  workspace.setFilter('type', 'errors');
  workspace.tabs.select('metrics');
  await flushPromises();
  const metricsPanel = assertSelectedPanel(workspace, 'metrics');
  assert.deepEqual(urls.slice(2), ['/api/admin/metrics']);
  const metricsContent = parseMetricsContent(metricsPanel);
  assert.deepEqual(metricsContent.summary, { errors: 1 });
  assert.deepEqual(metricsContent.buckets, [{ minute: after + 60000, errors: 1 }]);
  assert.match(collectText(metricsPanel), /级别.*Session.*Route.*关键词.*不适用/);
});

test('指标总量使用 averagePromptDurationMs，时间窗口平均耗时明确不适用', async () => {
  const { createActivityWorkspace } = await importModule('pages/activity.js');
  const after = new Date('2026-07-22T08:30').getTime();
  const urls = [];
  const workspace = createActivityWorkspace({
    document: createFakeDocument(),
    api: { get: async url => {
      urls.push(url);
      return { data: {
        messages: 8,
        commands: 3,
        prompts: 2,
        errors: 4,
        averagePromptDurationMs: 25,
        promptDurationMs: 999,
        buckets: [{ minute: after + 60000, messages: 2, commands: 1, prompts: 1, errors: 1, promptDurationMs: 900 }],
      } };
    } },
  });

  workspace.tabs.select('metrics');
  await flushPromises();
  let metricsPanel = assertSelectedPanel(workspace, 'metrics');
  assert.deepEqual(parseMetricsContent(metricsPanel).summary, {
    messages: 8,
    commands: 3,
    prompts: 2,
    errors: 4,
    averagePromptDurationMs: 25,
  });

  workspace.setFilter('after', '2026-07-22T08:30');
  workspace.setFilter('type', 'averagePromptDurationMs');
  await workspace.refreshMetrics();
  metricsPanel = assertSelectedPanel(workspace, 'metrics');
  const filtered = parseMetricsContent(metricsPanel);
  assert.deepEqual(filtered.summary, {});
  assert.match(filtered.typeNote, /averagePromptDurationMs.*不适用/);
  assert.deepEqual(urls, ['/api/admin/metrics', '/api/admin/metrics']);
});

test('日志单飞且 cleanup 隔离在途 resolve，定时器仅清一次', async () => {
  const { createActivityWorkspace } = await importModule('pages/activity.js');
  const pending = deferred();
  let calls = 0;
  let timerCallback;
  let cleared = 0;
  const workspace = createActivityWorkspace({
    document: createFakeDocument(),
    api: { get: () => { calls++; return pending.promise; } },
    setInterval: callback => { timerCallback = callback; return 7; },
    clearInterval: id => { if (id === 7) cleared++; },
  });
  workspace.setAutoRefresh(true);
  workspace.logOutput.textContent = 'before cleanup';
  workspace.logOutput.scrollTop = 17;
  const logsPanel = workspace.tabs.panels.get('logs');
  const first = timerCallback();
  const second = timerCallback();
  assert.equal(calls, 1);
  workspace.cleanup();
  workspace.cleanup();
  assert.equal(cleared, 1);
  const feedbackState = feedbackIn(logsPanel).dataset.state;
  pending.resolve({ data: { lines: ['after cleanup'] } });
  await Promise.all([first, second]);
  assert.equal(workspace.logOutput.textContent, 'before cleanup');
  assert.equal(workspace.logOutput.scrollTop, 17);
  assert.equal(feedbackIn(logsPanel).dataset.state, feedbackState);
  await timerCallback();
  assert.equal(calls, 1);
});

test('cleanup 隔离在途日志 reject，不写错误反馈', async () => {
  const { createActivityWorkspace } = await importModule('pages/activity.js');
  const pending = deferred();
  let calls = 0;
  const workspace = createActivityWorkspace({
    document: createFakeDocument(),
    api: { get: () => { calls++; return pending.promise; } },
  });
  const logsPanel = workspace.tabs.panels.get('logs');
  const request = workspace.refreshLogs();
  assert.equal(calls, 1);
  const before = collectText(logsPanel);
  const feedbackState = feedbackIn(logsPanel).dataset.state;
  workspace.cleanup();
  pending.reject(new Error('after cleanup failure'));
  await request;
  assert.equal(collectText(logsPanel), before);
  assert.equal(feedbackIn(logsPanel).dataset.state, feedbackState);
  assert.doesNotMatch(collectText(logsPanel), /after cleanup failure/);
});

test('暂停日志跟随不修改 scrollTop', async () => {
  const { createActivityWorkspace } = await importModule('pages/activity.js');
  const document = createFakeDocument();
  const workspace = createActivityWorkspace({ document, api: { get: async () => ({ data: { lines: ['new'] } }) } });
  workspace.logOutput.scrollTop = 19;
  workspace.logOutput.scrollHeight = 200;
  workspace.setFollowLogs(false);
  await workspace.refreshLogs();
  assert.equal(workspace.logOutput.scrollTop, 19);
  workspace.setFollowLogs(true);
  await workspace.refreshLogs();
  assert.equal(workspace.logOutput.scrollTop, 200);
});

test('活动 datetime-local 过滤转换为非负毫秒时间戳', async () => {
  const { createActivityWorkspace } = await importModule('pages/activity.js');
  const urls = [];
  const workspace = createActivityWorkspace({
    document: createFakeDocument(),
    api: { get: async url => { urls.push(url); return { data: { events: [] } }; } },
  });
  workspace.setFilter('after', '2026-07-22T08:30');
  await workspace.refreshEvents();
  const query = new URL('http://localhost' + urls[0]).searchParams;
  assert.match(query.get('after'), /^\d+$/);
  assert.equal(Number(query.get('after')), new Date('2026-07-22T08:30').getTime());
  assert.ok(Number(query.get('after')) >= 0);
});

test('诊断页渲染结构化检查、action 后复检并导出当前报告', async () => {
  const { createDiagnosticsWorkspace } = await importModule('pages/diagnostics.js');
  const downloads = [];
  let healthCalls = 0;
  const workspace = createDiagnosticsWorkspace({
    document: createFakeDocument(),
    api: {
      get: async url => {
        if (url === '/api/admin/health') {
          healthCalls++;
          return { data: { overall: 'degraded', checks: [{ name: 'opencode', group: 'connections', status: 'fail', checkedAt: '2026-07-22T00:00:00Z', reason: 'offline', suggestion: 'start it', action: { method: 'POST', path: '/api/admin/agents/opencode/ensure-ready', label: '恢复' } }] } };
        }
        throw new Error('unexpected');
      },
      request: async () => ({ data: { ok: true } }),
    },
    download: (name, data) => downloads.push({ name, data }),
  });
  await workspace.refresh();
  assert.match(collectText(workspace.element), /总体.*degraded.*connections.*opencode.*offline.*start it.*恢复/);
  await workspace.runAction(workspace.getReport().checks[0]);
  assert.equal(healthCalls, 2);
  workspace.exportReport();
  assert.equal(downloads[0].name, 'walker-diagnostics.json');
  assert.match(downloads[0].data, /opencode/);
});

test('诊断 action 单飞、busy、失败反馈且 cleanup 后不更新', async () => {
  const { createDiagnosticsWorkspace } = await importModule('pages/diagnostics.js');
  const pending = deferred();
  let actionCalls = 0;
  const workspace = createDiagnosticsWorkspace({
    document: createFakeDocument(),
    api: {
      get: async () => ({ data: { overall: 'fail', checks: [{ name: 'opencode', status: 'fail', action: { method: 'POST', path: '/recover', label: '恢复' } }] } }),
      request: async () => { actionCalls++; return pending.promise; },
    },
  });
  await workspace.refresh();
  const actionButton = findElements(workspace.element, node => node.tagName === 'BUTTON' && node.textContent === '恢复')[0];
  actionButton.onclick();
  actionButton.onclick();
  assert.equal(actionCalls, 1);
  assert.equal(actionButton.disabled, true);
  workspace.cleanup();
  pending.resolve(Promise.reject(new Error('recover failed')));
  await flushPromises();
  assert.equal(actionButton.disabled, true);
  assert.doesNotMatch(collectText(workspace.element), /recover failed/);

  const failed = createDiagnosticsWorkspace({
    document: createFakeDocument(),
    api: {
      get: async () => ({ data: { overall: 'fail', checks: [{ name: 'opencode', status: 'fail', action: { method: 'POST', path: '/recover', label: '恢复' } }] } }),
      request: async () => { throw new Error('recover failed'); },
    },
  });
  await failed.refresh();
  const failedButton = findElements(failed.element, node => node.tagName === 'BUTTON' && node.textContent === '恢复')[0];
  failedButton.onclick();
  await flushPromises();
  assert.equal(failedButton.disabled, false);
  assert.match(collectText(failed.element), /recover failed/);
});

test('配置页按八组渲染且 Secret 永不进入 DOM', async () => {
  const { createConfigWorkspace } = await importModule('pages/config.js');
  const groups = ['walker', 'admin', 'feishu', 'opencode', 'runtime', 'session-route', 'timeout-recovery', 'ui'];
  const workspace = createConfigWorkspace({
    document: createFakeDocument(),
    api: { get: async () => ({ data: { editableKeys: ['WALKER_ADMIN_PORT'], groups: groups.map((id, index) => ({ id, label: id, items: index === 1 ? [{ env: 'WALKER_ADMIN_TOKEN', label: 'Token', secret: true, configured: true, masked: 'SECRET_SENTINEL', editable: false, source: 'environment', restartRequired: true }, { env: 'WALKER_ADMIN_PORT', label: 'Port', value: '8787', defaultValue: '8787', editable: true, source: 'default', restartRequired: true, input: { type: 'number', integer: true, min: 1, max: 65535 } }] : [] })) } }) },
  });
  await workspace.load();
  assert.equal(workspace.getGroups().length, 8);
  assert.doesNotMatch(collectText(workspace.element), /SECRET_SENTINEL/);
  assert.match(collectText(workspace.element), /已配置.*来源.*默认.*重启/);
});

test('配置表单阻止非法提交、过滤未知字段并在保存失败时恢复', async () => {
  const { createConfigWorkspace } = await importModule('pages/config.js');
  const calls = [];
  const workspace = createConfigWorkspace({
    document: createFakeDocument(),
    api: { patch: async (_url, body) => { calls.push(body); throw new Error('write failed'); } },
    summary: { editableKeys: ['WALKER_ADMIN_PORT'], groups: [{ id: 'admin', label: 'Admin', items: [{ env: 'WALKER_ADMIN_PORT', label: 'Port', value: '8787', defaultValue: '8787', editable: true, source: 'environment', restartRequired: true, input: { type: 'number', integer: true, min: 1, max: 65535 } }] }] },
  });
  workspace.setValue('WALKER_ADMIN_PORT', '70000');
  assert.deepEqual(workspace.validate(), { WALKER_ADMIN_PORT: '必须小于等于 65535' });
  await assert.rejects(workspace.save(), /请修正/);
  assert.equal(calls.length, 0);
  workspace.setValue('WALKER_ADMIN_PORT', '9000');
  workspace.setValue('UNKNOWN_SECRET', 'nope');
  await assert.rejects(workspace.save(), /write failed/);
  assert.deepEqual(calls[0], { WALKER_ADMIN_PORT: '9000' });
  assert.equal(workspace.getValue('WALKER_ADMIN_PORT'), '8787');
  assert.match(collectText(workspace.element), /write failed/);
});

test('存储维护页从 DOM 展示附件并执行查看下载和确认删除', async () => {
  const { createStorageWorkspace } = await importModule('pages/storage.js');
  const confirmations = [];
  const requests = [];
  let attachmentLoads = 0;
  const workspace = createStorageWorkspace({
    document: createFakeDocument(),
    api: {
      request: async (method, url, options) => { requests.push({ method, url, options }); return { data: {} }; },
      get: async () => {
        attachmentLoads++;
        return { data: { totalFiles: attachmentLoads === 1 ? 1 : 0, groups: attachmentLoads === 1 ? [{ sessionId: 'wks_1', files: [{ name: 'a file.txt', size: 12, modifiedAt: '2026-07-22T00:00:00Z' }] }] : [] } };
      },
    },
    confirm: async message => { confirmations.push(message); return true; },
  });
  await workspace.loadAttachments();
  assert.match(collectText(workspace.element), /数据文件.*附件.*备份.*导出.*清理.*危险区/);
  assert.match(collectText(workspace.element), /wks_1.*a file\.txt.*12/);
  const download = findElements(workspace.element, node => node.tagName === 'A' && node.textContent === '查看/下载')[0];
  assert.equal(download.attributes.href, '/api/admin/attachments/wks_1/a%20file.txt');
  assert.equal(download.attributes.download, 'a file.txt');
  const deleteButton = findElements(workspace.element, node => node.tagName === 'BUTTON' && node.textContent === '删除附件')[0];
  deleteButton.onclick();
  await flushPromises();
  assert.match(confirmations[0], /删除附件.*wks_1.*a file\.txt.*不可恢复/);
  assert.equal(requests[0].url, '/api/admin/attachments/wks_1/a%20file.txt');
  assert.doesNotMatch(collectText(workspace.element), /a file\.txt/);
  await workspace.cleanupAll();
  await workspace.stopService();
  assert.match(confirmations[1], /批量清理.*悬空 Route.*孤立附件/);
  assert.match(confirmations[2], /停止 Walker 服务.*管理控制台.*连接中断/);
  assert.deepEqual(requests.map(item => item.url), ['/api/admin/attachments/wks_1/a%20file.txt', '/api/admin/cleanup', '/api/admin/service/stop']);
});

test('调试工具生产 mount 默认隐藏服务端字符串并保留结构调试信息', async () => {
  const { mount, PREVIEW_CATEGORIES } = await importModule('pages/tools.js');
  const getRequests = [];
  const postRequests = [];
  const document = createFakeDocument();
  const root = createFakeElement('main', document);
  const cleanup = mount({
    root,
    commit: callback => callback(),
    api: {
      get: async url => {
        getRequests.push(url);
        return { data: { parsed: { type: 'command', text: '<img onerror=alert(1)> SECRET_SENTINEL' }, message: 'SECRET_SENTINEL', details: 'SECRET_SENTINEL', dryRun: true, count: 2 } };
      },
      post: async (url, body, options) => {
        postRequests.push({ url, body, options });
        return { data: { preview: { header: { title: '<script>SECRET_SENTINEL</script>', template: 'red' }, elementCount: 2, elements: [{ type: 'text', content: '<img onerror=alert(1)> SECRET_SENTINEL' }, { type: 'action', actions: [{ type: 'button', label: 'SECRET_SENTINEL' }] }] }, rendered: { message: 'SECRET_SENTINEL', enabled: true } } };
      },
    },
  });
  assert.deepEqual(PREVIEW_CATEGORIES, ['session', 'attachable', 'model', 'progress', 'permission', 'question', 'error', 'help']);
  const previewButtons = findElements(root, node => node.attributes?.['data-preview']);
  assert.equal(previewButtons.length, 8);
  assert.ok(previewButtons.every(button => button.tagName === 'BUTTON' && button.attributes.role === undefined));
  const commandInput = findElements(root, node => node.tagName === 'TEXTAREA')[0];
  const simulateButton = findElements(root, node => node.tagName === 'BUTTON' && node.textContent === '模拟命令')[0];
  const rawJson = findElements(root, node => node.attributes?.['aria-label'] === '原始 JSON')[0];
  commandInput.value = '/new';
  simulateButton.onclick();
  await flushPromises();
  assert.match(getRequests[0], /dryRun=true/);
  assert.doesNotMatch(collectText(root) + rawJson.textContent, /SECRET_SENTINEL|<img|onerror/);
  assert.match(rawJson.textContent, /"parsed".*"type": "command".*"text": "\[REDACTED\]"/s);
  assert.match(rawJson.textContent, /"dryRun": true.*"count": 2/s);

  for (const button of previewButtons) {
    button.onclick();
    await flushPromises();
  }
  assert.deepEqual(postRequests.map(request => request.url), Array(8).fill('/api/admin/tools/cards/preview'));
  assert.deepEqual(postRequests.map(request => request.body), [
    { type: 'session_list' },
    { type: 'attachable_session' },
    { type: 'model' },
    { type: 'progress' },
    { type: 'permission' },
    { type: 'question_confirm' },
    { type: 'error' },
    { type: 'help' },
  ]);
  assert.deepEqual(
    postRequests.filter(request => ['model', 'permission', 'help'].includes(request.body.type)).map(request => request.body.type),
    ['model', 'permission', 'help'],
  );
  assert.ok(postRequests.every(request => request.options && 'signal' in request.options));
  assert.doesNotMatch(collectText(root) + rawJson.textContent, /SECRET_SENTINEL|<script|<img|onerror/);
  assert.match(rawJson.textContent, /"header".*"title": "\[REDACTED\]".*"elementCount": 2/s);
  assert.match(rawJson.textContent, /"enabled": true/);
  const preview = findElements(root, node => node.className === 'card-preview')[0];
  assert.match(collectText(preview), /服务端卡片预览.*元素数量：2.*类型：text.*类型：action.*操作数量：1/);
  assert.doesNotMatch(collectText(preview), /\[REDACTED\]/);
  cleanup();
});
