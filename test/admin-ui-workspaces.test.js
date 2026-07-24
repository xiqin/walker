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


test.before(prepareModules);
test.after(() => fs.rmSync(moduleDir, { recursive: true, force: true }));

test('日志工作区渲染结构化 log-line 并按级别/来源/关键词过滤', async () => {
  const { createLogsWorkspace } = await importModule('pages/logs.js');
  const urls = [];
  const lines = [
    { createdAt: 1000, level: 'INFO', source: 'AgentDriver', message: 'turn started' },
    { createdAt: 2000, level: 'WARN', source: '飞书 WSClient', message: 'retry after timeout' },
    { createdAt: 3000, level: 'ERROR', source: 'OpenCode Hook', message: 'connection lost' },
    { createdAt: 4000, level: 'DEBUG', source: 'TUI Bridge', message: 'packet forwarded' },
    JSON.stringify({ createdAt: 5000, level: 'INFO', source: 'ProgressCard', message: 'step completed' }),
  ];
  const workspace = createLogsWorkspace({
    document: createFakeDocument(),
    api: { get: async url => { urls.push(url); return { data: { lines } }; } },
  });
  await workspace.refreshLogs();
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/api\/admin\/logs/);

  const logLines = findElements(workspace.element, node => node.className === 'log-line');
  assert.equal(logLines.length, 5);
  const allText = collectText(workspace.element);
  assert.match(allText, /turn started/);
  assert.match(allText, /retry after timeout/);
  assert.match(allText, /connection lost/);

  const noteBox = findElements(workspace.element, node => node.className === 'note-box')[0];
  assert.match(collectText(noteBox), /walker logs.*walker.log/);

  const levelSelect = findElements(workspace.element, node => node.attributes?.['aria-label'] === '级别筛选')[0];
  levelSelect.value = 'ERROR';
  levelSelect.dispatch('change');
  const afterLevel = findElements(workspace.element, node => node.className === 'log-line');
  assert.equal(afterLevel.length, 1);
  assert.match(collectText(afterLevel[0]), /connection lost/);
  levelSelect.value = '';
  levelSelect.dispatch('change');

  const searchInput = findElements(workspace.element, node => node.attributes?.['aria-label'] === '搜索日志')[0];
  searchInput.value = 'timeout';
  searchInput.dispatch('input');
  const afterSearch = findElements(workspace.element, node => node.className === 'log-line');
  assert.equal(afterSearch.length, 1);
  assert.match(collectText(afterSearch[0]), /retry after timeout/);
  searchInput.value = '';
  searchInput.dispatch('input');

  const sourceSelect = findElements(workspace.element, node => node.attributes?.['aria-label'] === '来源筛选')[0];
  sourceSelect.value = 'OpenCode Hook';
  sourceSelect.dispatch('change');
  const afterSource = findElements(workspace.element, node => node.className === 'log-line');
  assert.equal(afterSource.length, 1);
  assert.match(collectText(afterSource[0]), /connection lost/);
});

test('日志单飞且 cleanup 隔离在途 resolve，定时器仅清一次', async () => {
  const { createLogsWorkspace } = await importModule('pages/logs.js');
  const pending = deferred();
  let calls = 0;
  let timerCallback;
  let cleared = 0;
  const workspace = createLogsWorkspace({
    document: createFakeDocument(),
    api: { get: () => { calls++; return pending.promise; } },
    setInterval: callback => { timerCallback = callback; return 7; },
    clearInterval: id => { if (id === 7) cleared++; },
  });
  workspace.setAutoRefresh(true);
  const first = timerCallback();
  const second = timerCallback();
  assert.equal(calls, 1);
  workspace.cleanup();
  workspace.cleanup();
  assert.equal(cleared, 1);
  pending.resolve({ data: { lines: ['after cleanup'] } });
  await Promise.all([first, second]);
  const logLines = findElements(workspace.element, node => node.className === 'log-line');
  assert.equal(logLines.length, 0);
  await timerCallback();
  assert.equal(calls, 1);
});

test('cleanup 隔离在途日志 reject，不写错误反馈', async () => {
  const { createLogsWorkspace } = await importModule('pages/logs.js');
  const pending = deferred();
  let calls = 0;
  const workspace = createLogsWorkspace({
    document: createFakeDocument(),
    api: { get: () => { calls++; return pending.promise; } },
  });
  const request = workspace.refreshLogs();
  assert.equal(calls, 1);
  workspace.cleanup();
  pending.reject(new Error('after cleanup failure'));
  await request;
  const logLines = findElements(workspace.element, node => node.className === 'log-line');
  assert.equal(logLines.length, 0);
  assert.doesNotMatch(collectText(workspace.element), /after cleanup failure/);
});

test('自动滚动和行数限制', async () => {
  const { createLogsWorkspace } = await importModule('pages/logs.js');
  const lines = [];
  for (let i = 0; i < 100; i++) lines.push({ createdAt: i, level: 'INFO', source: 'AgentDriver', message: `line ${i}` });
  const workspace = createLogsWorkspace({
    document: createFakeDocument(),
    api: { get: async () => ({ data: { lines } }) },
  });
  await workspace.refreshLogs();
  const logLines = findElements(workspace.element, node => node.className === 'log-line');
  assert.equal(logLines.length, 80);

  const rowCountSelect = findElements(workspace.element, node => node.attributes?.['aria-label'] === '行数')[0];
  rowCountSelect.value = '200';
  rowCountSelect.dispatch('change');
  const afterChange = findElements(workspace.element, node => node.className === 'log-line');
  assert.equal(afterChange.length, 100);
});

test('导出按钮触发下载', async () => {
  const { createLogsWorkspace } = await importModule('pages/logs.js');
  const downloads = [];
  const workspace = createLogsWorkspace({
    document: createFakeDocument(),
    api: { get: async () => ({ data: { lines: [{ createdAt: 1000, level: 'INFO', source: 'AgentDriver', message: 'test log' }] } }) },
    download: (name, text) => downloads.push({ name, text }),
  });
  await workspace.refreshLogs();
  const exportButton = findElements(workspace.element, node => node.tagName === 'BUTTON' && node.textContent === '⬇ 导出')[0];
  exportButton.onclick();
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].name, /walker-logs-.*\.log/);
  assert.match(downloads[0].text, /test log/);
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
  assert.match(collectText(workspace.element), /opencode.*offline.*start it.*恢复/);
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

test('配置页按六组渲染且 Secret 永不进入 DOM', async () => {
  const { createConfigWorkspace } = await importModule('pages/config.js');
  const groups = [
    { id: 'walker', items: [{ env: 'WALKER_DEFAULT_AGENT', label: 'Agent', value: 'opencode', editable: true, input: { type: 'text' } }] },
    { id: 'admin', items: [{ env: 'WALKER_ADMIN_TOKEN', label: 'Token', secret: true, configured: true, masked: 'SECRET_SENTINEL', editable: false, source: 'environment', restartRequired: true }] },
    { id: 'feishu', items: [{ env: 'FEISHU_APP_ID', label: 'App ID', value: 'cli_a1', editable: true, input: { type: 'text' } }] },
    { id: 'opencode', items: [{ env: 'OPENCODE_SERVER_URL', label: 'URL', value: '', editable: true, input: { type: 'url', protocols: ['http:', 'https:'], allowEmpty: true } }] },
    { id: 'runtime', items: [{ env: 'WALKER_DEFAULT_RUNTIME', label: 'Runtime', value: 'windows', editable: true, input: { type: 'enum', values: ['windows', 'wsl'] } }] },
    { id: 'timeout-recovery', items: [{ env: 'WALKER_OPENCODE_NON_FOCUS_OUTPUT', label: '输出回群', value: 'true', editable: true, display: 'switch', input: { type: 'boolean', values: ['true', 'false'] } }] },
  ];
  const workspace = createConfigWorkspace({
    document: createFakeDocument(),
    api: { get: async () => ({ data: { editableKeys: ['WALKER_ADMIN_PORT'], groups } }) },
  });
  await workspace.load();
  assert.equal(workspace.getGroups().length, 6);
  assert.doesNotMatch(collectText(workspace.element), /SECRET_SENTINEL/);
  assert.match(collectText(workspace.element), /已配置/);
  assert.match(collectText(workspace.element), /飞书后台需/);
  assert.match(collectText(workspace.element), /Hook 端点/);
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
  assert.match(collectText(workspace.element), /磁盘占用.*维护操作.*附件/);
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
  const { mount, PREVIEW_CATEGORIES } = await importModule('pages/debug.js');
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
