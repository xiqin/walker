'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const { createEventStore, recordEvent, listEvents } = require('../src/admin/event-store');
const { createObservabilityRoutes } = require('../src/admin/observability-routes');
const {
  EDITABLE_ENV_KEYS,
  CONFIG_GROUPS,
  CONFIG_DEFINITIONS,
  buildConfigSummary,
} = require('../src/admin/config');
const { updateDotEnv } = require('../src/admin/config-editor');
const { createConfigRoutes } = require('../src/admin/config-routes');
const diagnostics = require('../src/admin/diagnostics');
const { createRouter } = require('../src/admin/router');

/**
 * 调用路由处理器并收集标准响应。
 * @param {Array} routes - 路由定义。
 * @param {string} method - HTTP 方法。
 * @param {string} requestPath - 含可选查询串的请求路径。
 * @param {Object} [body] - JSON 请求体。
 * @returns {Promise<Object>} 状态码、响应头和响应体。
 */
async function callRoute(routes, method, requestPath, body) {
  const router = createRouter();
  for (const route of routes) router.add(route.method, route.pattern, route.handler);
  const requestUrl = new URL(requestPath, 'http://localhost');
  const matched = router.match(method, requestUrl.pathname);
  assert.ok(matched, `route not found: ${method} ${requestUrl.pathname}`);

  const req = new EventEmitter();
  req.method = method;
  req.headers = {};
  req.urlPath = requestUrl.pathname;
  req.queryString = requestUrl.search.slice(1);
  let statusCode = 200;
  const headers = {};
  let responseBody;
  const res = {
    writeHead(code, values) {
      statusCode = code;
      Object.assign(headers, values || {});
    },
    end(value) {
      const raw = Buffer.isBuffer(value) ? value.toString('utf8') : value;
      try { responseBody = JSON.parse(raw); } catch (_err) { responseBody = raw; }
    },
  };

  const result = matched.handler(req, res, matched.params);
  if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
  req.emit('end');
  if (result && typeof result.then === 'function') await result;
  return { statusCode, headers, body: responseBody };
}

test('events 支持组合过滤并按时间稳定倒序返回', () => {
  const store = createEventStore();
  recordEvent(store, { id: 'out-of-order-newest', level: 'error', sessionId: 'wks_a', routeKey: 'feishu:a', type: 'prompt.failed', createdAt: 500 });
  recordEvent(store, { id: 'same-first', level: 'error', sessionId: 'wks_a', routeKey: 'feishu:a', type: 'prompt.failed', createdAt: 200 });
  recordEvent(store, { id: 'same-second', level: 'error', sessionId: 'wks_a', routeKey: 'feishu:a', type: 'prompt.failed', createdAt: 200 });
  recordEvent(store, { id: 'other', level: 'info', sessionId: 'wks_a', routeKey: 'feishu:a', type: 'prompt.failed', createdAt: 300 });

  const events = listEvents(store, {
    level: 'error',
    sessionId: 'wks_a',
    routeKey: 'feishu:a',
    type: 'prompt.failed',
    after: 100,
    limit: 10,
  });

  assert.deepEqual(events.map((event) => event.id), ['out-of-order-newest', 'same-second', 'same-first']);
});

test('events 容量查询在 1000 条 store 上保持有界', () => {
  const store = createEventStore();
  for (let index = 0; index < 1000; index += 1) {
    recordEvent(store, { type: 'capacity', createdAt: index + 1 });
  }
  assert.equal(listEvents(store, { type: 'capacity', limit: 200 }).length, 200);
  assert.equal(listEvents(store, { type: 'capacity', limit: 1000 }).length, 1000);
});

test('events API 校验 level、after 和 limit 并执行默认及上限', async () => {
  const store = createEventStore();
  for (let index = 0; index < 1000; index += 1) recordEvent(store, { createdAt: index + 1 });
  const routes = createObservabilityRoutes({ eventStore: store });

  for (const query of ['level=trace', 'after=nope', 'after=-1', 'limit=0', 'limit=1001', 'limit=2.5']) {
    const result = await callRoute(routes, 'GET', `/api/admin/events?${query}`);
    assert.equal(result.statusCode, 400, query);
    assert.equal(result.body.error.code, 'BAD_REQUEST');
  }

  const defaults = await callRoute(routes, 'GET', '/api/admin/events');
  assert.equal(defaults.body.data.events.length, 200);
  assert.equal(defaults.body.data.limit, 200);
  const maximum = await callRoute(routes, 'GET', '/api/admin/events?limit=1000');
  assert.equal(maximum.body.data.events.length, 1000);
});

test('createObservabilityRoutes 单模块固定安全路由并拒绝非法参数', async () => {
  const routes = createObservabilityRoutes({ eventStore: createEventStore() });
  assert.deepEqual(routes.map((route) => `${route.method} ${route.pattern}`), [
    'GET /api/admin/events',
    'GET /api/admin/diagnostics/export',
  ]);

  for (const query of [
    'level=ERROR',
    'level=%3Cscript%3E',
    'after=Infinity',
    'after=1.5',
    'limit=-1',
    'limit=01.5',
  ]) {
    const result = await callRoute(routes, 'GET', `/api/admin/events?${query}`);
    assert.equal(result.statusCode, 400, query);
    assert.equal(result.body.ok, false);
    assert.equal(JSON.stringify(result.body).includes('<script>'), false);
  }
});

test('createObservabilityRoutes 事件和诊断输出不包含已知 Secret', async () => {
  const secret = 'T3_OBSERVABILITY_SENTINEL';
  const store = createEventStore();
  recordEvent(store, {
    type: 'security.scan',
    message: `failure ${secret}`,
    data: { nested: { token: secret } },
  });
  const routes = createObservabilityRoutes({
    eventStore: store,
    config: { token: secret },
    diagnosticChecks: [
      { name: 'secret-check', group: 'security', run: () => ({ status: 'warn', reason: secret }) },
    ],
  });

  const events = await callRoute(routes, 'GET', '/api/admin/events?type=security.scan');
  const report = await callRoute(routes, 'GET', '/api/admin/diagnostics/export');
  assert.equal(JSON.stringify(events.body).includes(secret), false);
  assert.equal(JSON.stringify(report.body).includes(secret), false);
});

test('诊断隔离单项异常并输出结构化字段', async () => {
  const checks = await diagnostics.runHealthCheck({
    diagnosticChecks: [
      { name: 'working', group: 'walker', run: () => ({ status: 'pass', reason: 'ok' }) },
      { name: 'broken', group: 'external', run: () => { throw new Error('sentinel failure'); } },
      { name: 'after', group: 'storage', run: () => ({ status: 'warn', suggestion: 'inspect it' }) },
    ],
  });

  assert.equal(checks.length, 3);
  assert.deepEqual(checks.map((item) => item.name), ['working', 'broken', 'after']);
  assert.equal(checks[1].status, 'fail');
  assert.equal(checks[1].reason, 'sentinel failure');
  assert.equal(checks[2].suggestion, 'inspect it');
  for (const item of checks) {
    assert.equal(typeof item.group, 'string');
    assert.equal(typeof item.checkedAt, 'string');
    assert.ok(Object.hasOwn(item, 'reason'));
    assert.ok(Object.hasOwn(item, 'suggestion'));
    assert.ok(Object.hasOwn(item, 'action'));
  }
});

test('导出结构化诊断报告包含时间、总体状态和全部检查', async () => {
  const secret = 'T3_SENTINEL_SECRET';
  const routes = createObservabilityRoutes({
    envConfig: { feishuAppSecret: secret },
    diagnosticChecks: [
      { name: 'one', group: 'walker', run: () => ({ status: 'pass', reason: 'configured' }) },
      { name: 'two', group: 'storage', run: () => ({ status: 'warn', suggestion: 'repair', data: { diagnostic: secret } }) },
    ],
  });
  const result = await callRoute(routes, 'GET', '/api/admin/diagnostics/export');

  assert.equal(result.statusCode, 200);
  assert.match(result.headers['Content-Disposition'], /walker-diagnostics\.json/);
  assert.equal(result.body.overall, 'degraded');
  assert.equal(result.body.checks.length, 2);
  assert.equal(typeof result.body.checkedAt, 'string');
  assert.equal(JSON.stringify(result.body).includes(secret), false);
});

test('配置元数据完整覆盖分组和全部 allowlist', () => {
  const summary = buildConfigSummary({
    WALKER_ADMIN_HOST: '127.0.0.1',
    FEISHU_APP_SECRET: 'T3_SENTINEL_SECRET',
    WALKER_ADMIN_TOKEN: 'T3_ADMIN_SENTINEL',
  });
  const items = summary.groups.flatMap((group) => group.items);

  assert.deepEqual(summary.groups.map((group) => group.id), CONFIG_GROUPS.map((group) => group.id));
  assert.equal(summary.groups.length, 7);
  assert.deepEqual(new Set(items.map((item) => item.env)), new Set(summary.editableKeys.concat(summary.sensitiveKeys, ['FEISHU_APP_ID'])));
  for (const item of items) {
    assert.equal(typeof item.label, 'string');
    if (!item.secret) assert.ok(Object.hasOwn(item, 'defaultValue'));
    assert.equal(typeof item.source, 'string');
    assert.equal(typeof item.restartRequired, 'boolean');
  }
  const secretItems = items.filter((item) => item.secret);
  assert.equal(secretItems.every((item) => item.configured && item.masked === '********' && !Object.hasOwn(item, 'value')), true);
  assert.equal(JSON.stringify(summary).includes('T3_SENTINEL_SECRET'), false);
  assert.equal(JSON.stringify(summary).includes('T3_ADMIN_SENTINEL'), false);
});

test('REQ-007-B01 和 REQ-007-B03: Claude 配置项可见、可编辑且不含 Secret', () => {
  const summary = buildConfigSummary({
    CLAUDE_CMD: 'claude-beta',
    CLAUDE_MODEL: 'sonnet',
    CLAUDE_FALLBACK_MODEL: 'opus',
    CLAUDE_AGENT: 'reviewer',
    CLAUDE_PERMISSION_MODE: 'plan',
    CLAUDE_ALLOWED_TOOLS: 'Read,Grep',
    CLAUDE_DISALLOWED_TOOLS: 'Bash',
    CLAUDE_CONFIG_DIR: 'C:\\claude',
    CLAUDE_PROMPT_TIMEOUT_MS: '45000',
  });
  const group = summary.groups.find((item) => item.id === 'claude');
  const items = new Map(group.items.map((item) => [item.env, item]));

  assert.ok(group);
  assert.deepEqual([
    'CLAUDE_CMD',
    'CLAUDE_MODEL',
    'CLAUDE_FALLBACK_MODEL',
    'CLAUDE_AGENT',
    'CLAUDE_PERMISSION_MODE',
    'CLAUDE_ALLOWED_TOOLS',
    'CLAUDE_DISALLOWED_TOOLS',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_PROMPT_TIMEOUT_MS',
  ].every((key) => summary.editableKeys.includes(key)), true);
  assert.equal(items.get('CLAUDE_CMD').value, 'claude-beta');
  assert.equal(items.get('CLAUDE_MODEL').value, 'sonnet');
  assert.equal(items.get('CLAUDE_PERMISSION_MODE').value, 'plan');
  assert.equal(items.get('CLAUDE_PROMPT_TIMEOUT_MS').value, '45000');
  assert.equal(summary.sensitiveKeys.some((key) => key.startsWith('CLAUDE_')), false);
  assert.equal(group.items.some((item) => item.secret), false);
});

test('配置 DTO 暴露客户端可复用的类型和约束元数据', () => {
  const summary = buildConfigSummary({});
  const items = new Map(summary.groups.flatMap((group) => group.items).map((item) => [item.env, item]));

  assert.deepEqual(items.get('WALKER_ADMIN_ENABLED').input, {
    type: 'boolean',
    values: ['true', 'false'],
  });
  assert.deepEqual(items.get('WALKER_ADMIN_PORT').input, {
    type: 'number',
    integer: true,
    min: 1,
    max: 65535,
  });
  assert.deepEqual(items.get('WALKER_DEFAULT_RUNTIME').input, {
    type: 'enum',
    values: ['windows', 'wsl'],
  });
  assert.deepEqual(items.get('OPENCODE_SERVER_URL').input, {
    type: 'url',
    protocols: ['http:', 'https:'],
    allowEmpty: true,
  });
  assert.deepEqual(items.get('WALKER_OPENCODE_HEALTH_POLL_INTERVAL_MS').input, {
    type: 'number',
    integer: true,
    min: 1,
  });
  assert.deepEqual(items.get('FEISHU_ROUTE_MODE').input, {
    type: 'enum',
    values: ['thread', 'user', 'channel'],
    labels: { thread: 'thread（按消息线程）', user: 'user（按用户）', channel: 'channel（按群）' },
  });
  assert.deepEqual(items.get('WALKER_ADMIN_HOST').input, {
    type: 'text',
    required: true,
    pattern: '^[^\\s/\\\\]+$',
  });
  assert.deepEqual(items.get('OPENCODE_CMD').input, {
    type: 'text',
    required: true,
    trim: true,
    minLength: 1,
  });

  for (const key of ['FEISHU_APP_SECRET', 'WALKER_ADMIN_TOKEN']) {
    const item = items.get(key);
    assert.equal(Object.hasOwn(item, 'value'), false);
    assert.equal(Object.hasOwn(item, 'defaultValue'), false);
    assert.equal(Object.hasOwn(item, 'input'), false);
  }
});

test('配置客户端约束覆盖全部可编辑项的专用服务端校验类型', () => {
  const expectedByServerType = {
    boolean: { type: 'boolean', values: ['true', 'false'] },
    port: { type: 'number', integer: true, min: 1, max: 65535 },
    'positive-int': { type: 'number', integer: true, min: 1 },
    'non-negative-int': { type: 'number', integer: true, min: 0 },
    host: { type: 'text', required: true, pattern: '^[^\\s/\\\\]+$' },
    runtime: { type: 'enum', values: ['windows', 'wsl'] },
    'route-mode': { type: 'enum', values: ['thread', 'user', 'channel'], labels: { thread: 'thread（按消息线程）', user: 'user（按用户）', channel: 'channel（按群）' } },
    'progress-style': { type: 'enum', values: ['card', 'legacy'], labels: { card: 'card（结构化卡片）', legacy: 'legacy（逐条文本）' } },
    'exit-action': { type: 'enum', values: ['cancel', 'stop', 'none'], labels: { cancel: 'cancel（取消 turn 并移出 route）', none: 'none（仅记录 detached）' } },
    'claude-permission-mode': { type: 'enum', values: ['default', 'acceptEdits', 'auto', 'dontAsk', 'plan'] },
    url: { type: 'url', protocols: ['http:', 'https:'], allowEmpty: true },
    'non-empty': { type: 'text', required: true, trim: true, minLength: 1 },
  };
  const definitions = new Map(CONFIG_DEFINITIONS.map((definition) => [definition.env, definition]));
  const items = new Map(buildConfigSummary({}).groups.flatMap((group) => group.items).map((item) => [item.env, item]));

  for (const key of EDITABLE_ENV_KEYS) {
    const definition = definitions.get(key);
    assert.ok(definition, key);
    if (definition.type === 'string') continue;
    assert.deepEqual(items.get(key).input, expectedByServerType[definition.type], `${key} (${definition.type})`);
  }

  const dedicatedTypes = new Set(CONFIG_DEFINITIONS
    .filter((definition) => EDITABLE_ENV_KEYS.includes(definition.env) && definition.type !== 'string')
    .map((definition) => definition.type));
  assert.deepEqual(dedicatedTypes, new Set(Object.keys(expectedByServerType)));

  for (const key of ['FEISHU_APP_SECRET', 'WALKER_ADMIN_TOKEN']) {
    const item = items.get(key);
    assert.equal(Object.hasOwn(item, 'input'), false);
    assert.equal(Object.hasOwn(item, 'value'), false);
    assert.equal(Object.hasOwn(item, 'defaultValue'), false);
  }
});

test('配置服务端校验非法值且多字段失败不部分写入', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-t3-validation-'));
  const envPath = path.join(tmpDir, '.env');
  const original = '# keep\nWALKER_ADMIN_HOST=127.0.0.1\nWALKER_ADMIN_PORT=8787\nUNKNOWN_KEY=keep\n';
  fs.writeFileSync(envPath, original, 'utf8');

  assert.throws(() => updateDotEnv(envPath, {
    WALKER_ADMIN_HOST: 'localhost',
    WALKER_ADMIN_PORT: '70000',
  }), /WALKER_ADMIN_PORT/);
  assert.equal(fs.readFileSync(envPath, 'utf8'), original);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('REQ-007-B02 和 REQ-007-B04: Claude 配置编辑校验并保持失败原子性', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-claude-config-'));
  const envPath = path.join(tmpDir, '.env');
  fs.writeFileSync(envPath, '# keep\nUNKNOWN_KEY=keep\n', 'utf8');

  const result = updateDotEnv(envPath, {
    CLAUDE_CMD: 'claude-beta',
    CLAUDE_PERMISSION_MODE: 'plan',
    CLAUDE_PROMPT_TIMEOUT_MS: '45000',
  });
  const raw = fs.readFileSync(envPath, 'utf8');

  assert.deepEqual(result.effectiveValues, {
    CLAUDE_CMD: 'claude-beta',
    CLAUDE_PERMISSION_MODE: 'plan',
    CLAUDE_PROMPT_TIMEOUT_MS: '45000',
  });
  assert.match(raw, /^UNKNOWN_KEY=keep/m);
  assert.match(raw, /^CLAUDE_CMD=claude-beta/m);
  assert.match(raw, /^CLAUDE_PERMISSION_MODE=plan/m);
  assert.match(raw, /^CLAUDE_PROMPT_TIMEOUT_MS=45000/m);

  const before = fs.readFileSync(envPath, 'utf8');
  assert.throws(() => updateDotEnv(envPath, {
    CLAUDE_PERMISSION_MODE: 'bypassPermissions',
    CLAUDE_PROMPT_TIMEOUT_MS: '0',
  }), /CLAUDE_PERMISSION_MODE/);
  assert.equal(fs.readFileSync(envPath, 'utf8'), before);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('配置更新使用原子替换并在替换失败时保留原文件', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-t3-atomic-'));
  const envPath = path.join(tmpDir, '.env');
  const original = '# keep\nWALKER_ADMIN_HOST=127.0.0.1\nUNKNOWN_KEY=keep\n';
  fs.writeFileSync(envPath, original, 'utf8');
  const originalRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('rename failed'); };
  try {
    assert.throws(() => updateDotEnv(envPath, { WALKER_ADMIN_HOST: 'localhost' }), /rename failed/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.equal(fs.readFileSync(envPath, 'utf8'), original);
  assert.equal(fs.readdirSync(tmpDir).some((name) => name.includes('.tmp-')), false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('配置路由返回实际生效值来源和重启反馈且无 Secret', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-t3-route-'));
  const envPath = path.join(tmpDir, '.env');
  fs.writeFileSync(envPath, 'WALKER_ADMIN_HOST=127.0.0.1\n', 'utf8');
  const routes = createConfigRoutes({ envPath, env: { FEISHU_APP_SECRET: 'T3_SENTINEL_SECRET' } });

  const saved = await callRoute(routes, 'PATCH', '/api/admin/config', { WALKER_ADMIN_HOST: 'localhost' });
  assert.equal(saved.body.data.restartRequired, true);
  assert.deepEqual(saved.body.data.effectiveValues, { WALKER_ADMIN_HOST: 'localhost' });
  assert.equal(saved.body.data.source, 'env-file');
  assert.equal(JSON.stringify(saved.body).includes('T3_SENTINEL_SECRET'), false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
