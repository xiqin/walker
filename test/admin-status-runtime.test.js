'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { createEventStore, recordEvent } = require('../src/admin/event-store');
const sessionAdmin = require('../src/admin/session-admin');
const { createStatusAdmin } = require('../src/admin/status-admin');
const { createStatusRoutes } = require('../src/admin/status-routes');
const { createTuiRuntimeRoutes } = require('../src/admin/tui-runtime-routes');
const { createRouter } = require('../src/admin/router');

/**
 * 调用单条 Admin 路由并收集 JSON 响应。
 * @param {Array<Object>} routes - 路由定义。
 * @param {string} method - HTTP 方法。
 * @param {string} pathname - 请求路径。
 * @returns {Promise<{statusCode:number, body:Object}>} 响应结果。
 */
async function callRoute(routes, method, pathname) {
  const router = createRouter();
  for (const route of routes) router.add(route.method, route.pattern, route.handler);
  const matched = router.match(method, pathname);
  assert.ok(matched, '路由应存在: ' + method + ' ' + pathname);

  const req = new EventEmitter();
  req.method = method;
  req.urlPath = pathname;
  req.queryString = '';
  let statusCode = 200;
  let body = null;
  let resolveEnd;
  const ended = new Promise((resolve) => { resolveEnd = resolve; });
  const res = {
    writeHead(code) { statusCode = code; },
    setHeader() {},
    end(data) {
      body = JSON.parse(data);
      resolveEnd();
    },
  };

  await matched.handler(req, res, matched.params);
  await ended;
  return { statusCode, body };
}

/**
 * 创建状态测试上下文。
 * @param {Object} [overrides] - 上下文覆盖值。
 * @returns {Object} 状态上下文。
 */
function createStatusContext(overrides) {
  const statusChecks = {};
  for (const name of ['walker', 'feishu', 'opencode', 'tuiBridge', 'runtimes', 'watchers', 'health', 'admin']) {
    statusChecks[name] = () => ({ status: 'healthy' });
  }
  return { statusChecks, ...(overrides || {}) };
}

test('聚合全部实时组件状态', async () => {
  const now = 1721642400000;
  const statusAdmin = createStatusAdmin(createStatusContext(), { now: () => now, timeoutMs: 50 });
  const result = await statusAdmin.getStatus();

  assert.deepEqual(Object.keys(result), [
    'walker', 'feishu', 'opencode', 'tuiBridge', 'runtimes', 'watchers', 'health', 'admin',
  ]);
  for (const item of Object.values(result)) {
    assert.equal(item.status, 'healthy');
    assert.equal(item.checkedAt, now);
  }
});

test('状态聚合隔离单个依赖失败', async () => {
  const ctx = createStatusContext();
  ctx.statusChecks.feishu = () => { throw new Error('Feishu disconnected'); };
  const routes = createStatusRoutes({ statusAdmin: createStatusAdmin(ctx, { timeoutMs: 50 }) });
  const response = await callRoute(routes, 'GET', '/api/admin/status');

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.data.feishu.status, 'failed');
  assert.match(response.body.data.feishu.reason, /Feishu disconnected/);
  assert.equal(response.body.data.walker.status, 'healthy');
});

test('异常状态包含诊断字段', async () => {
  const ctx = createStatusContext();
  ctx.statusChecks.admin = () => ({
    status: 'warning',
    reason: 'Admin 仅监听本机地址',
    action: { type: 'navigate', target: '#config' },
  });
  const result = await createStatusAdmin(ctx).getStatus();

  assert.equal(result.admin.status, 'warning');
  assert.equal(result.admin.reason, 'Admin 仅监听本机地址');
  assert.deepEqual(result.admin.action, { type: 'navigate', target: '#config' });
});

test('状态检测执行有界超时', async () => {
  const ctx = createStatusContext();
  ctx.statusChecks.opencode = () => new Promise(() => {});
  const startedAt = Date.now();
  const result = await createStatusAdmin(ctx, { timeoutMs: 30 }).getStatus();

  assert.ok(Date.now() - startedAt < 500, '悬挂检测应在期限内结束');
  assert.equal(result.opencode.status, 'failed');
  assert.match(result.opencode.reason, /timed out|超时/i);
});

test('默认状态检查适配生产对象形状且二次调用反映变化', async () => {
  let runtimeSnapshots = [];
  let healthSnapshots = [];
  let adminStatus = { started: false, disabled: false };
  let walkerStarted = true;
  let opencodeHealthy = true;
  let feishuConnection = { state: 'idle', reconnectAttempts: 0 };
  const ctx = {
    lifecycle: { get started() { return walkerStarted; } },
    feishu: { wsClient: { getConnectionStatus: () => ({ ...feishuConnection }) } },
    registry: {
      get: () => ({ _checkHealth: async () => opencodeHealthy }),
    },
    tuiBridge: {
      runtimes: new Map(),
      getRuntimeSnapshots: () => runtimeSnapshots.map((item) => ({ ...item, health: { ...item.health } })),
    },
    dispatcher: { sessionWatchStops: new Map([['wks_1', () => {}]]) },
    healthPoller: { getHealthSnapshots: () => healthSnapshots.map((item) => ({ ...item })) },
    adminServer: { getStatus: () => ({ ...adminStatus }) },
  };
  const statusAdmin = createStatusAdmin(ctx, { timeoutMs: 50 });

  const first = await statusAdmin.getStatus();
  assert.equal(first.walker.status, 'healthy');
  assert.equal(first.feishu.status, 'failed');
  assert.match(first.feishu.reason, /idle/i);
  assert.equal(first.opencode.status, 'healthy');
  assert.equal(first.tuiBridge.status, 'healthy');
  assert.equal(first.watchers.status, 'healthy');
  assert.equal(first.runtimes.status, 'healthy');
  assert.equal(first.health.status, 'healthy');
  assert.equal(first.admin.status, 'failed');

  feishuConnection = { state: 'connected', reconnectAttempts: 0, lastConnectTime: 100 };
  const connected = await statusAdmin.getStatus();
  assert.equal(connected.feishu.status, 'healthy');
  assert.equal(connected.feishu.lastConnectTime, 100);

  feishuConnection = { state: 'reconnecting', reconnectAttempts: 3, nextConnectTime: 200 };
  const reconnecting = await statusAdmin.getStatus();
  assert.equal(reconnecting.feishu.status, 'warning');
  assert.equal(reconnecting.feishu.reconnectAttempts, 3);
  assert.equal(reconnecting.feishu.nextConnectTime, 200);

  walkerStarted = false;
  opencodeHealthy = false;
  feishuConnection = { state: 'failed', reconnectAttempts: 5 };
  ctx.dispatcher.sessionWatchStops.clear();
  runtimeSnapshots = [{ runtimeId: 'rt_1', health: { status: 'warning', reason: 'lease expiring' } }];
  healthSnapshots = [{ sessionId: 'wks_1', status: 'failed', reason: 'health check failed' }];
  adminStatus = { started: true, disabled: false };
  const second = await statusAdmin.getStatus();

  assert.equal(second.walker.status, 'failed');
  assert.equal(second.feishu.status, 'failed');
  assert.equal(second.opencode.status, 'failed');
  assert.equal(second.runtimes.status, 'warning');
  assert.match(second.runtimes.reason, /lease expiring/);
  assert.equal(second.health.status, 'failed');
  assert.match(second.health.reason, /health check failed/);
  assert.equal(second.watchers.status, 'healthy');
  assert.equal(second.admin.status, 'healthy');
});

test('默认状态检查在实时探针缺失时返回 unknown 和原因', async () => {
  const result = await createStatusAdmin({
    feishuSummary: { connected: true },
    tuiBridge: {},
    healthPoller: {},
    adminServer: {},
  }, { timeoutMs: 50 }).getStatus();

  for (const name of ['walker', 'feishu', 'opencode', 'tuiBridge', 'runtimes', 'watchers', 'health', 'admin']) {
    assert.equal(result[name].status, 'unknown', name + ' 缺少实时探针时应为 unknown');
    assert.ok(result[name].reason, name + ' 缺少实时探针时应包含原因');
  }
});

test('持久化 Session 无运行实例仍可序列化', () => {
  const session = {
    id: 'wks_persisted', status: 'idle', updatedAt: 100, agentRef: null,
  };
  const ctx = {
    sessionService: {
      listSessions: () => [session],
      stateStore: { read: () => ({ routes: {} }) },
    },
  };
  const result = sessionAdmin.listSessions(ctx);

  assert.equal(result[0].transport, 'unknown');
  assert.equal(result[0].runtimeId, null);
  assert.deepEqual(result[0].watch, { active: false, mode: 'unknown' });
  assert.deepEqual(result[0].health, { status: 'unknown', reason: null });
});

test('Session 详情聚合最新运行字段', () => {
  const session = {
    id: 'wks_live', status: 'running', updatedAt: 100,
    agentRef: { transport: 'tui-bridge', runtimeId: 'rt_live', opencodeSessionId: 'ses_live' },
  };
  const ctx = {
    sessionService: {
      getSession: () => session,
      _readNormalized: () => ({
        routes: { 'feishu:chat:root': { sessions: ['wks_live'], focusSessionId: 'wks_live', lastActiveAt: 120 } },
      }),
    },
    eventStore: createEventStore(),
    tuiBridge: {
      getRuntimeSnapshot: () => ({ runtimeId: 'rt_live', lastHeartbeatAt: 180, health: { status: 'healthy', reason: null } }),
    },
    healthPoller: {
      getHealthSnapshot: () => ({ sessionId: 'wks_live', status: 'warning', reason: 'one failed check', checkedAt: 170 }),
    },
    dispatcher: {
      sessionWatchStops: new Map([['wks_live', () => {}]]),
      getTurnState: () => ({ token: 7, cancelled: false, startedAt: 160 }),
    },
  };
  recordEvent(ctx.eventStore, { type: 'session.state', sessionId: 'wks_live', message: 'running', ts: 150 });

  const detail = sessionAdmin.getSession(ctx, 'wks_live');
  assert.equal(detail.transport, 'tui');
  assert.equal(detail.runtimeId, 'rt_live');
  assert.equal(detail.opencodeSessionId, 'ses_live');
  assert.deepEqual(detail.routeKeys, ['feishu:chat:root']);
  assert.deepEqual(detail.focusRouteKeys, ['feishu:chat:root']);
  assert.deepEqual(detail.watch, { active: true, mode: 'tui' });
  assert.equal(detail.health.status, 'warning');
  assert.equal(detail.lastHeartbeatAt, 180);
  assert.equal(detail.currentTurn.token, 7);
  assert.equal(detail.lastActiveAt, 180);
  assert.equal(detail.timeline.length, 1);
});

test('TUI Runtime API 返回完整 DTO', async () => {
  const runtime = {
    runtimeId: 'rt_1', sessionId: 'ses_1', walkerSessionId: 'wks_1', cwd: 'H:\\walker',
    opencodeVersion: '1.2.3', bridgeProtocolVersion: 5, lastHeartbeatAt: 100,
    lease: { status: 'active', remainingMs: 5000, expiresAt: 6000 },
    health: { status: 'healthy', reason: null },
  };
  const bridge = {
    getRuntimeSnapshots: () => [{ ...runtime }],
    getRuntimeSnapshot: () => ({ ...runtime }),
  };
  const routes = createTuiRuntimeRoutes({ tuiBridge: bridge });
  const list = await callRoute(routes, 'GET', '/api/admin/tui-runtimes');
  const detail = await callRoute(routes, 'GET', '/api/admin/tui-runtimes/rt_1');

  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.body.data.list[0], detail.body.data);
  assert.deepEqual(Object.keys(detail.body.data), Object.keys(runtime));
});

test('TUI Runtime API 边界响应', async () => {
  const routes = createTuiRuntimeRoutes({
    tuiBridge: { getRuntimeSnapshots: () => [], getRuntimeSnapshot: () => null },
  });
  const list = await callRoute(routes, 'GET', '/api/admin/tui-runtimes');
  const missing = await callRoute(routes, 'GET', '/api/admin/tui-runtimes/missing');

  assert.equal(list.statusCode, 200);
  assert.deepEqual(list.body.data, { list: [], total: 0 });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.body.error.code, 'NOT_FOUND');
});

test('TUI Runtime 响应敏感键扫描', async () => {
  const routes = createTuiRuntimeRoutes({
    tuiBridge: {
      getRuntimeSnapshots: () => [{ runtimeId: 'rt_safe', token: 'credential-value', nested: { authorization: 'Bearer credential-value' } }],
      getRuntimeSnapshot: () => ({ runtimeId: 'rt_safe', apiKey: 'credential-value', cwd: 'H:\\walker' }),
    },
  });
  const list = await callRoute(routes, 'GET', '/api/admin/tui-runtimes');
  const detail = await callRoute(routes, 'GET', '/api/admin/tui-runtimes/rt_safe');
  const serialized = JSON.stringify([list.body, detail.body]).toLowerCase();

  assert.doesNotMatch(serialized, /credential-value|authorization|apikey|"token"/);
});
