/**
 * Admin 核心 API 测试
 * 覆盖 REQ-003～REQ-011、REQ-016～REQ-018、REQ-022～REQ-023、REQ-026
 * 使用 fake/stub 依赖，不依赖真实 driver 或飞书连接
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createEventStore, recordEvent } = require('../src/admin/event-store');
const { createRouter } = require('../src/admin/router');
const { createCoreRoutes } = require('../src/admin/core-routes');
const sessionAdmin = require('../src/admin/session-admin');
const routeAdmin = require('../src/admin/route-admin');
const agentRuntimeAdmin = require('../src/admin/agent-runtime-admin');
const { SessionService } = require('../src/core/session-service');
const { JsonStore } = require('../src/core/json-store');

/**
 * 创建 fake SessionService，支持所有方法签名
 * @param {Object[]} [initialSessions] - 初始会话数据
 * @param {Object} [initialRoutes] - 初始路由绑定
 * @returns {Object} fake sessionService 实例
 */
function createFakeSessionService(initialSessions, initialRoutes) {
  const sessionsData = {};
  for (const s of (initialSessions || [])) {
    sessionsData[s.id] = { ...s };
  }
  const routesData = {};
  for (const routeKey of Object.keys(initialRoutes || {})) {
    const sid = initialRoutes[routeKey];
    if (typeof sid === 'string') {
      routesData[routeKey] = { focusSessionId: sid, sessions: [sid], cwd: '' };
    } else {
      routesData[routeKey] = { ...sid };
    }
  }

  return {
    stateStore: {
      read: () => ({ sessions: sessionsData, routes: routesData }),
      update: (fn) => fn({ sessions: sessionsData, routes: routesData }),
    },
    createSession(opts) {
      const id = 'wks_test_' + Math.random().toString(36).slice(2, 8);
      const session = {
        id,
        agent: opts.agent || 'opencode',
        title: opts.title || 'test session',
        runtime: opts.runtime || 'windows',
        cwd: opts.cwd || '',
        status: 'created',
        agentRef: opts.agentRef || null,
        errorMessage: null,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      sessionsData[id] = session;
      if (opts.route) {
        const existing = routesData[opts.route];
        if (existing) {
          if (!existing.sessions.includes(id)) {
            existing.sessions.push(id);
          }
        } else {
          routesData[opts.route] = { focusSessionId: id, sessions: [id], cwd: opts.cwd || '' };
        }
      }
      return session;
    },
    getSession(id) {
      return sessionsData[id] || null;
    },
    listSessions() {
      return Object.values(sessionsData).filter((s) => s.status !== 'deleted');
    },
    getCurrent(routeKey) {
      const route = routesData[routeKey];
      if (!route) return null;
      const sid = route.focusSessionId;
      if (!sid) return null;
      const s = sessionsData[sid];
      if (s && s.status !== 'deleted') return s;
      delete routesData[routeKey];
      return null;
    },
    getRouteForSession(sessionId) {
      const entries = Object.entries(routesData);
      const found = entries.find(([, route]) => route && Array.isArray(route.sessions) && route.sessions.includes(sessionId));
      return found ? found[0] : null;
    },
    bindRoute(routeKey, sessionId) {
      const s = sessionsData[sessionId];
      if (!s) throw new Error('session not found: ' + sessionId);
      if (s.status === 'deleted') throw new Error('session deleted: ' + sessionId);
      const existing = routesData[routeKey];
      if (existing) {
        if (!existing.sessions.includes(sessionId)) {
          existing.sessions.push(sessionId);
        }
        existing.focusSessionId = sessionId;
      } else {
        routesData[routeKey] = { focusSessionId: sessionId, sessions: [sessionId], cwd: '' };
      }
    },
    unbindRoute(routeKey) {
      delete routesData[routeKey];
    },
    cleanOrphanRoutes() {
      const cleaned = [];
      for (const routeKey of Object.keys(routesData)) {
        const route = routesData[routeKey];
        const valid = route.sessions.filter((id) => sessionsData[id] && sessionsData[id].status !== 'deleted');
        const changed = valid.length !== route.sessions.length || !valid.includes(route.focusSessionId);
        if (valid.length === 0) {
          delete routesData[routeKey];
        } else {
          route.sessions = valid;
          if (!valid.includes(route.focusSessionId)) route.focusSessionId = valid[0];
        }
        if (changed || !routesData[routeKey]) cleaned.push(routeKey);
      }
      return cleaned;
    },
    stopSession(id) {
      if (sessionsData[id] && sessionsData[id].status !== 'deleted') {
        sessionsData[id].status = 'stopped';
        sessionsData[id].updatedAt = Date.now();
      }
    },
    deleteSession(id) {
      if (!sessionsData[id]) return;
      sessionsData[id].status = 'deleted';
      sessionsData[id].updatedAt = Date.now();
      for (const key of Object.keys(routesData)) {
        const route = routesData[key];
        if (!route || !Array.isArray(route.sessions)) continue;
        if (!route.sessions.includes(id)) continue;
        route.sessions = route.sessions.filter((sid) => sid !== id);
        if (route.sessions.length === 0) {
          delete routesData[key];
        } else if (route.focusSessionId === id) {
          route.focusSessionId = route.sessions[0];
        }
      }
    },
    markRunning(id) {
      if (sessionsData[id] && sessionsData[id].status !== 'stopped' && sessionsData[id].status !== 'deleted') {
        sessionsData[id].status = 'running';
      }
    },
    markIdle(id) {
      if (sessionsData[id] && sessionsData[id].status !== 'stopped' && sessionsData[id].status !== 'deleted') {
        sessionsData[id].status = 'idle';
      }
    },
    markError(id, msg) {
      if (sessionsData[id]) {
        sessionsData[id].status = 'error';
        sessionsData[id].errorMessage = msg;
      }
    },
    updateSessionField(id, field, value) {
      if (sessionsData[id]) {
        sessionsData[id][field] = value;
        sessionsData[id].updatedAt = Date.now();
      }
    },
  };
}

/**
 * 创建 fake DriverRegistry
 * @param {Object} drivers - driver 名称到实例的映射
 * @returns {Object} fake registry 实例
 */
function createFakeRegistry(drivers) {
  const d = drivers || {};
  return {
    register(name, driver) { d[name] = driver; },
    get(name) { return d[name] || null; },
    list() { return Object.keys(d); },
  };
}

/**
 * 创建 fake opencode driver，所有方法可自定义
 * @param {Object} overrides - 方法覆盖映射
 * @returns {Object} fake driver 实例
 */
function createFakeOpencodeDriver(overrides) {
  const defaults = {
    name: 'opencode',
    serverUrl: 'http://127.0.0.1:4096',
    autostart: true,
    opencodeCmd: 'opencode',
    ensureReady: async () => true,
    createSession: async (opts) => ({
      opencodeSessionId: 'oc_test_' + Math.random().toString(36).slice(2, 8),
      serverUrl: 'http://127.0.0.1:4096',
      cwd: opts.cwd || process.cwd(),
    }),
    resumeSession: async (ref) => ref,
    listSessions: async () => [],
    prompt: async (ref, text) => [{ type: 'text', data: { text } }],
    stop: async () => {},
    delete: async () => {},
  };
  return { ...defaults, ...overrides };
}

/**
 * 创建 fake stub driver，方法抛出未实现错误
 * @param {string} name - driver 名称
 * @returns {Object} fake stub driver 实例
 */
function createFakeStubDriver(name) {
  return {
    name,
    _isStub: true,
    ensureReady: async () => { throw new Error(name + ' driver is not implemented yet. This is a stub for future extension.'); },
    createSession: async () => { throw new Error(name + ' driver is not implemented yet.'); },
    resumeSession: async () => { throw new Error(name + ' driver is not implemented yet.'); },
    listSessions: async () => { throw new Error(name + ' driver is not implemented yet.'); },
    prompt: async () => { throw new Error(name + ' driver is not implemented yet.'); },
    stop: async () => { throw new Error(name + ' driver is not implemented yet.'); },
    delete: async () => { throw new Error(name + ' driver is not implemented yet.'); },
  };
}

/**
 * 构造标准 appContext
 * @param {Object} overrides - 上下文覆盖字段
 * @returns {Object} appContext 实例
 */
function buildAppContext(overrides) {
  const store = createEventStore();
  const ctx = {
    sessionService: createFakeSessionService(),
    registry: createFakeRegistry({ opencode: createFakeOpencodeDriver() }),
    eventStore: store,
    envConfig: {
      walkerDefaultCwd: 'C:\\test',
      walkerWslDistro: 'Ubuntu-24.04',
      walkerDefaultRuntime: 'windows',
      walkerDefaultAgent: 'opencode',
    },
    feishuSummary: { connected: true, source: 'env', appId: 'cli_test' },
    dataDir: 'C:\\test\\.walker',
    version: '0.1.0-test',
    startTime: Date.now() - 60000,
    routeAdmin,
  };
  return { ...ctx, ...overrides };
}

/**
 * 用测试用 fake 请求和响应对象模拟路由调用
 * 支持有请求体（parseBody）和无请求体两种场景
 * @param {Array} routes - 路由数组
 * @param {string} method - HTTP 方法
 * @param {string} pathname - 请求路径
 * @param {Object} [body] - 请求体
 * @param {Object} [headers] - 请求头
 * @returns {Object} 响应对象 { statusCode, body }
 */
function callRoute(routes, method, pathname, body, headers) {
  const router = createRouter();
  for (const r of routes) {
    router.add(r.method, r.pattern, r.handler);
  }

  const matched = router.match(method, pathname);
  if (!matched) return { statusCode: 404, body: null };

  const req = new EventEmitter();
  req.method = method;
  req.url = pathname;
  req.headers = headers || {};
  req.urlPath = pathname;
  req.queryString = '';
  req.params = matched.params;

  let resBody = null;
  let statusCode = 200;
  const res = {
    writeHead(code, _headers) { statusCode = code; },
    end(data) {
      try { resBody = JSON.parse(data); } catch (_e) { resBody = data; }
    },
    setHeader() {},
  };

  matched.handler(req, res, matched.params);

  if (body) {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  } else {
    req.emit('end');
  }

  return { statusCode, body: resBody };
}

// ── REQ-003: overview 返回进程、配置、统计和最近错误 ──

test('REQ-003: overview 返回进程信息和统计摘要', () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService([
      { id: 'wks_a', agent: 'opencode', title: 's1', runtime: 'windows', cwd: '', status: 'running', agentRef: { opencodeSessionId: 'oc1' }, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
      { id: 'wks_b', agent: 'opencode', title: 's2', runtime: 'windows', cwd: '', status: 'idle', agentRef: null, errorMessage: null, createdAt: 2000, updatedAt: 2000 },
    ]),
  });

  const routes = createCoreRoutes(ctx);
  const result = callRoute(routes, 'GET', '/api/admin/overview');
  const data = result.body.data;

  assert.equal(data.process.pid, process.pid);
  assert.equal(data.process.version, '0.1.0-test');
  assert.ok(data.process.uptime > 0);
  assert.equal(data.dataDir, 'C:\\test\\.walker');
  assert.equal(data.sessions.total, 2);
  assert.equal(data.sessions.byStatus.running, 1);
  assert.equal(data.sessions.byStatus.idle, 1);
  assert.equal(data.routes.total, 0);
  assert.equal(data.feishu.connected, true);
});

test('REQ-003: overview 包含最近错误和 agent 摘要', () => {
  const ctx = buildAppContext();
  recordEvent(ctx.eventStore, { type: 'error', level: 'error', message: 'test error' });
  recordEvent(ctx.eventStore, { type: 'error', level: 'error', message: 'another error' });

  const routes = createCoreRoutes(ctx);
  const result = callRoute(routes, 'GET', '/api/admin/overview');
  assert.ok(result.body.data.recentErrors.length >= 2);
  assert.equal(result.body.data.agents.length, 1);
  assert.equal(result.body.data.agents[0].name, 'opencode');
  assert.equal(result.body.data.agents[0].available, true);
});

// ── REQ-004: session 列表和详情字段完整 ──

test('REQ-004: listSessions 返回未删除 session 列表', () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService([
      { id: 'wks_a', agent: 'opencode', title: 's1', runtime: 'windows', cwd: '', status: 'running', agentRef: null, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
      { id: 'wks_b', agent: 'opencode', title: 's2', runtime: 'windows', cwd: '', status: 'deleted', agentRef: null, errorMessage: null, createdAt: 2000, updatedAt: 2000 },
    ]),
  });

  const result = sessionAdmin.listSessions(ctx);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'wks_a');
});

test('REQ-004: listSessions 返回 route 归属和 OpenCode 诊断字段', () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService([
      { id: 'wks_focus', agent: 'opencode', title: 'focus', runtime: 'windows', cwd: 'H:\\walker', status: 'running', agentRef: { opencodeSessionId: 'ses_focus', serverUrl: 'http://localhost:4096' }, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
      { id: 'wks_free', agent: 'opencode', title: 'free', runtime: 'windows', cwd: 'H:\\walker', status: 'idle', agentRef: { opencodeSessionId: 'ses_free', serverUrl: 'http://localhost:4096' }, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
    ], {
      'feishu:abc:chat1': { focusSessionId: 'wks_focus', sessions: ['wks_focus'], cwd: 'H:\\walker' },
    }),
  });

  const result = sessionAdmin.listSessions(ctx);
  const focus = result.find((s) => s.id === 'wks_focus');
  const free = result.find((s) => s.id === 'wks_free');
  assert.deepEqual(focus.routeKeys, ['feishu:abc:chat1']);
  assert.deepEqual(focus.focusRouteKeys, ['feishu:abc:chat1']);
  assert.equal(focus.isUnbound, false);
  assert.equal(focus.opencodeSessionId, 'ses_focus');
  assert.equal(focus.serverUrl, 'http://localhost:4096');
  assert.deepEqual(free.routeKeys, []);
  assert.equal(free.isUnbound, true);
});

test('REQ-004: listSessions 按会话创建时间倒序并分离业务事件和心跳时间', () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService([
      { id: 'wks_older_event', agent: 'opencode', title: 'older', runtime: 'windows', cwd: '', status: 'running', agentRef: { opencodeSessionId: 'ses_old', createdAt: 1100 }, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
      { id: 'wks_newer_event', agent: 'opencode', title: 'newer', runtime: 'windows', cwd: '', status: 'running', agentRef: { opencodeSessionId: 'ses_new', opencodeSessionCreatedAt: 2100 }, errorMessage: null, createdAt: 2000, updatedAt: 2000 },
      { id: 'wks_heartbeat_only', agent: 'opencode', title: 'heartbeat', runtime: 'windows', cwd: '', status: 'running', agentRef: { opencodeSessionId: 'ses_hb' }, errorMessage: null, createdAt: 3000, updatedAt: 3000 },
    ]),
    tuiBridge: {
      getRuntimeSnapshot(runtimeId) {
        if (runtimeId === 'rt_hb') return { lastHeartbeatAt: 9000, health: { status: 'healthy' } };
        return null;
      },
    },
  });
  ctx.sessionService.updateSessionField('wks_heartbeat_only', 'agentRef', { opencodeSessionId: 'ses_hb', runtimeId: 'rt_hb', transport: 'tui-bridge' });
  recordEvent(ctx.eventStore, { type: 'prompt.completed', sessionId: 'wks_older_event', createdAt: 5000 });
  recordEvent(ctx.eventStore, { type: 'runtime.heartbeat', sessionId: 'wks_newer_event', createdAt: 8000 });
  recordEvent(ctx.eventStore, { type: 'message.received', sessionId: 'wks_newer_event', createdAt: 7000 });
  recordEvent(ctx.eventStore, { type: 'tui.heartbeat', sessionId: 'wks_heartbeat_only', createdAt: 9500 });

  const result = sessionAdmin.listSessions(ctx);
  assert.deepEqual(result.map((item) => item.id), ['wks_heartbeat_only', 'wks_newer_event', 'wks_older_event']);
  assert.equal(result[0].lastBusinessEventAt, null);
  assert.equal(result[0].lastHeartbeatAt, 9000);
  assert.equal(result[1].lastBusinessEventAt, 7000);
  assert.equal(result[1].opencodeSessionCreatedAt, 2100);
  assert.equal(result[2].lastBusinessEventAt, 5000);
  assert.equal(result[2].opencodeSessionCreatedAt, 1100);
});

test('REQ-004: getSession 详情包含 routeKeys 和 timeline', () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService(
      [{ id: 'wks_a', agent: 'opencode', title: 's1', runtime: 'windows', cwd: '', status: 'running', agentRef: null, errorMessage: null, createdAt: 1000, updatedAt: 1000 }],
      { 'feishu:abc:chat1': 'wks_a' },
    ),
  });
  recordEvent(ctx.eventStore, { type: 'session.state', sessionId: 'wks_a', message: 'created' });

  const detail = sessionAdmin.getSession(ctx, 'wks_a');
  assert.equal(detail.id, 'wks_a');
  assert.deepEqual(detail.routeKeys, ['feishu:abc:chat1']);
  assert.ok(detail.timeline.length >= 1);
});

test('REQ-004: getSession 不存在的 session 返回 null', () => {
  const ctx = buildAppContext();
  assert.equal(sessionAdmin.getSession(ctx, 'wks_nonexist'), null);
});

// ── REQ-005: 创建 Walker session 并可选创建 opencode 底层 session ──

test('REQ-005: 创建 Walker session 不带底层 agent session', async () => {
  const ctx = buildAppContext();
  const session = await sessionAdmin.createSession(ctx, { agent: 'opencode', title: 'test' });
  assert.equal(session.agent, 'opencode');
  assert.equal(session.status, 'created');
  assert.equal(session.agentRef, null);
});

test('REQ-005: 创建 Walker session 并创建底层 opencode session', async () => {
  const ctx = buildAppContext();
  const session = await sessionAdmin.createSession(ctx, {
    agent: 'opencode',
    title: 'test with agent',
    createAgentSession: true,
  });
  assert.equal(session.agent, 'opencode');
  assert.equal(session.status, 'running');
  assert.ok(session.agentRef);
  assert.ok(session.agentRef.opencodeSessionId);
});

test('REQ-005: 创建底层 session 失败时标记错误', async () => {
  const ctx = buildAppContext({
    registry: createFakeRegistry({
      opencode: createFakeOpencodeDriver({
        createSession: async () => { throw new Error('opencode server not available'); },
      }),
    }),
  });
  const session = await sessionAdmin.createSession(ctx, {
    agent: 'opencode',
    createAgentSession: true,
  });
  assert.equal(session.status, 'error');
  assert.ok(session.errorMessage);
});

// ── REQ-006: 停止和删除优先调用 driver 并更新 Walker 状态 ──

test('REQ-006: stopSession 优先调用 driver stop', async () => {
  let driverStopCalled = false;
  const ctx = buildAppContext({
    sessionService: createFakeSessionService([
      { id: 'wks_stop1', agent: 'opencode', title: 's', runtime: 'windows', cwd: '', status: 'running', agentRef: { opencodeSessionId: 'oc1' }, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
    ]),
    registry: createFakeRegistry({
      opencode: createFakeOpencodeDriver({
        stop: async () => { driverStopCalled = true; },
      }),
    }),
  });

  const result = await sessionAdmin.stopSession(ctx, 'wks_stop1');
  assert.equal(result.ok, true);
  assert.equal(driverStopCalled, true);
  assert.equal(result.session.status, 'stopped');
  assert.equal(result.warning, null);
});

test('REQ-006: stopSession driver 失败时返回 warning', async () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService([
      { id: 'wks_stop2', agent: 'opencode', title: 's', runtime: 'windows', cwd: '', status: 'running', agentRef: { opencodeSessionId: 'oc1' }, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
    ]),
    registry: createFakeRegistry({
      opencode: createFakeOpencodeDriver({
        stop: async () => { throw new Error('opencode server not available'); },
      }),
    }),
  });

  const result = await sessionAdmin.stopSession(ctx, 'wks_stop2');
  assert.equal(result.ok, true);
  assert.ok(result.warning);
  assert.equal(result.session.status, 'stopped');
});

test('REQ-006: deleteSession 优先调用 driver delete', async () => {
  let driverDeleteCalled = false;
  const ctx = buildAppContext({
    sessionService: createFakeSessionService([
      { id: 'wks_del1', agent: 'opencode', title: 's', runtime: 'windows', cwd: '', status: 'running', agentRef: { opencodeSessionId: 'oc1' }, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
    ]),
    registry: createFakeRegistry({
      opencode: createFakeOpencodeDriver({
        delete: async () => { driverDeleteCalled = true; },
      }),
    }),
  });

  const result = await sessionAdmin.deleteSession(ctx, 'wks_del1');
  assert.equal(result.ok, true);
  assert.equal(driverDeleteCalled, true);
  assert.equal(result.warning, null);
});

test('REQ-006: deleteSession driver 失败时返回 warning', async () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService([
      { id: 'wks_del2', agent: 'opencode', title: 's', runtime: 'windows', cwd: '', status: 'running', agentRef: { opencodeSessionId: 'oc1' }, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
    ]),
    registry: createFakeRegistry({
      opencode: createFakeOpencodeDriver({
        delete: async () => { throw new Error('opencode server not available'); },
      }),
    }),
  });

  const result = await sessionAdmin.deleteSession(ctx, 'wks_del2');
  assert.equal(result.ok, true);
  assert.ok(result.warning);
});

test('REQ-006: stopSession 不存在的 session 返回 NOT_FOUND', async () => {
  const ctx = buildAppContext();
  const result = await sessionAdmin.stopSession(ctx, 'wks_nonexist');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NOT_FOUND');
});

test('REQ-006: deleteSession 无 agentRef 时无 warning', async () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService([
      { id: 'wks_del3', agent: 'opencode', title: 's', runtime: 'windows', cwd: '', status: 'idle', agentRef: null, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
    ]),
  });

  const result = await sessionAdmin.deleteSession(ctx, 'wks_del3');
  assert.equal(result.ok, true);
  assert.equal(result.warning, null);
});

// ── REQ-007: route 列表、绑定和解绑可用 ──

test('REQ-007: listRoutes 列出绑定和健康状态', () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService(
      [{ id: 'wks_a', agent: 'opencode', title: 's1', runtime: 'windows', cwd: '', status: 'running', agentRef: null, errorMessage: null, createdAt: 1000, updatedAt: 1000 }],
      { 'feishu:abc:chat1': 'wks_a' },
    ),
  });

  const result = routeAdmin.listRoutes(ctx);
  assert.equal(result.length, 1);
  assert.equal(result[0].routeKey, 'feishu:abc:chat1');
  assert.equal(result[0].sessionId, 'wks_a');
  assert.equal(result[0].health, 'running');
  assert.equal(result[0].dangling, false);
});

test('REQ-007: listRoutes 返回 1:N route 诊断字段', () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService([
      { id: 'wks_focus', agent: 'opencode', title: 'focus', runtime: 'windows', cwd: 'H:\\walker', status: 'running', agentRef: { opencodeSessionId: 'ses_focus', serverUrl: 'http://localhost:4096' }, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
      { id: 'wks_other', agent: 'opencode', title: 'other', runtime: 'windows', cwd: 'H:\\walker', status: 'idle', agentRef: { opencodeSessionId: 'ses_other', serverUrl: 'http://localhost:4096' }, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
      { id: 'wks_deleted', agent: 'opencode', title: 'deleted', runtime: 'windows', cwd: 'H:\\walker', status: 'deleted', agentRef: null, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
    ], {
      'feishu:abc:chat1': { focusSessionId: 'wks_focus', sessions: ['wks_focus', 'wks_other', 'wks_deleted', 'wks_missing'], cwd: 'H:\\walker', lastActiveAt: 1500, updatedAt: 2000 },
    }),
  });

  const result = routeAdmin.listRoutes(ctx);
  assert.equal(result.length, 1);
  assert.equal(result[0].focusSessionId, 'wks_focus');
  assert.deepEqual(result[0].sessionIds, ['wks_focus', 'wks_other', 'wks_deleted', 'wks_missing']);
  assert.equal(result[0].sessionCount, 4);
  assert.equal(result[0].cwd, 'H:\\walker');
  assert.equal(result[0].lastActiveAt, 1500);
  assert.equal(result[0].activeSessions.length, 2);
  assert.equal(result[0].activeSessions[0].isFocus, true);
  assert.equal(result[0].activeSessions[0].opencodeSessionId, 'ses_focus');
  assert.deepEqual(result[0].deletedSessionIds, ['wks_deleted']);
  assert.deepEqual(result[0].missingSessionIds, ['wks_missing']);
});

test('REQ-007: listRoutes 在 route cwd 为空时回退到绑定 session cwd', () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService([
      { id: 'wks_focus', agent: 'opencode', title: 'focus', runtime: 'windows', cwd: 'H:\\walker', status: 'running', agentRef: null, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
      { id: 'wks_other', agent: 'opencode', title: 'other', runtime: 'windows', cwd: 'H:\\fallback', status: 'idle', agentRef: null, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
    ], {
      'feishu:abc:chat1': { focusSessionId: 'wks_focus', sessions: ['wks_focus', 'wks_other'], cwd: '', lastActiveAt: 1500, updatedAt: 2000 },
    }),
  });

  const result = routeAdmin.listRoutes(ctx);
  assert.equal(result.length, 1);
  assert.equal(result[0].cwd, 'H:\\walker');
  assert.equal(result[0].activeSessions[0].cwd, 'H:\\walker');
});

test('REQ-007: bindRoute 绑定路由到 session', () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService([
      { id: 'wks_a', agent: 'opencode', title: 's1', runtime: 'windows', cwd: '', status: 'running', agentRef: null, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
    ]),
  });

  const result = routeAdmin.bindRoute(ctx, 'feishu:abc:chat2', 'wks_a');
  assert.equal(result.ok, true);
  assert.equal(result.routeKey, 'feishu:abc:chat2');
});

test('REQ-007: bindRoute 绑定到不存在 session 返回错误', () => {
  const ctx = buildAppContext();
  const result = routeAdmin.bindRoute(ctx, 'feishu:abc:chat3', 'wks_nonexist');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'BAD_REQUEST');
});

test('REQ-007: unbindRoute 解除绑定', () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService(
      [{ id: 'wks_a', agent: 'opencode', title: 's1', runtime: 'windows', cwd: '', status: 'running', agentRef: null, errorMessage: null, createdAt: 1000, updatedAt: 1000 }],
      { 'feishu:abc:chat1': 'wks_a' },
    ),
  });

  const result = routeAdmin.unbindRoute(ctx, 'feishu:abc:chat1');
  assert.equal(result.ok, true);
});

// ── REQ-008: 悬空 route 标记为 dangling 并可确认清理 ──

test('REQ-008: 悬空 route 标记 dangling', () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService(
      [],
      { 'feishu:dangle1': 'wks_deleted', 'feishu:dangle2': 'wks_nonexist' },
    ),
  });

  const result = routeAdmin.listRoutes(ctx);
  assert.equal(result.length, 2);
  assert.equal(result[0].dangling, true);
  assert.equal(result[1].dangling, true);
  assert.equal(result[0].health, 'dangling');
});

test('REQ-008: detectDangling 返回悬空 route 列表', () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService(
      [{ id: 'wks_del', agent: 'opencode', title: 's1', runtime: 'windows', cwd: '', status: 'deleted', agentRef: null, errorMessage: null, createdAt: 1000, updatedAt: 1000 }],
      { 'feishu:abc:chat1': 'wks_del', 'feishu:abc:chat2': 'wks_nonexist' },
    ),
  });

  const dangling = routeAdmin.detectDangling(ctx);
  assert.equal(dangling.length, 2);
  assert.equal(dangling[0].routeKey, 'feishu:abc:chat1');
  assert.equal(dangling[0].reason, 'session deleted');
  assert.equal(dangling[1].reason, 'session not found');
});

test('REQ-008: cleanupDangling 需要 confirm=true', () => {
  const ctx = buildAppContext();
  const result = routeAdmin.cleanupDangling(ctx, false);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'BAD_REQUEST');
});

test('REQ-008: cleanupDangling 确认后清理悬空绑定', () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService(
      [],
      { 'feishu:abc:dangle1': 'wks_nonexist', 'feishu:abc:dangle2': 'wks_deleted' },
    ),
  });

  const result = routeAdmin.cleanupDangling(ctx, true);
  assert.equal(result.ok, true);
  assert.equal(result.cleaned.length, 2);

  const remainingRoutes = routeAdmin.listRoutes(ctx);
  assert.equal(remainingRoutes.length, 0);
});

test('REQ-008: cleanupDangling 检查所有成员并保留有效 Route 状态', () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService([
      { id: 'wks_focus', status: 'idle' },
      { id: 'wks_first', status: 'idle' },
      { id: 'wks_second', status: 'idle' },
      { id: 'wks_deleted', status: 'deleted' },
    ], {
      'route:valid-focus': { focusSessionId: 'wks_focus', sessions: ['wks_focus', 'wks_missing', 'wks_deleted'], cwd: '/mnt/h/one' },
      'route:bad-focus': { focusSessionId: 'wks_missing', sessions: ['wks_missing', 'wks_first', 'wks_second'], cwd: '/mnt/h/two' },
      'route:no-valid': { focusSessionId: 'wks_deleted', sessions: ['wks_deleted', 'wks_missing'], cwd: '/mnt/h/three' },
      'route:healthy': { focusSessionId: 'wks_second', sessions: ['wks_first', 'wks_second'], cwd: '/mnt/h/four' },
    }),
  });

  const detected = routeAdmin.detectDangling(ctx).map((item) => item.routeKey).sort();
  assert.deepEqual(detected, ['route:bad-focus', 'route:no-valid', 'route:valid-focus']);
  assert.equal(routeAdmin.cleanupDangling(ctx, true).ok, true);
  const routes = ctx.sessionService.stateStore.read().routes;
  assert.deepEqual(routes['route:valid-focus'].sessions, ['wks_focus']);
  assert.equal(routes['route:valid-focus'].focusSessionId, 'wks_focus');
  assert.equal(routes['route:valid-focus'].cwd, '/mnt/h/one');
  assert.deepEqual(routes['route:bad-focus'].sessions, ['wks_first', 'wks_second']);
  assert.equal(routes['route:bad-focus'].focusSessionId, 'wks_first');
  assert.equal(routes['route:bad-focus'].cwd, '/mnt/h/two');
  assert.equal(routes['route:no-valid'], undefined);
  assert.deepEqual(routes['route:healthy'].sessions, ['wks_first', 'wks_second']);

  const stable = structuredClone(routes);
  assert.deepEqual(routeAdmin.cleanupDangling(ctx, true), { ok: true, cleaned: [] });
  assert.deepEqual(ctx.sessionService.stateStore.read().routes, stable);
});

test('REQ-008: cleanupDangling 使用真实 SessionService 修复成员外焦点且重复执行幂等', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-admin-cleanup-'));
  const stateStore = new JsonStore(path.join(tmpDir, 'state.json'), {});
  const sessionService = new SessionService({ stateStore });
  stateStore.update((state) => {
    state.sessions = {
      wks_focus: { id: 'wks_focus', status: 'idle' },
      wks_first: { id: 'wks_first', status: 'idle' },
      wks_second: { id: 'wks_second', status: 'idle' },
    };
    state.routes = {
      'route:focus-outside-members': {
        focusSessionId: 'wks_focus',
        sessions: ['wks_second', 'wks_first'],
        cwd: '/mnt/h/production-boundary',
        updatedAt: 1,
      },
    };
    state._schemaVersion = 3;
  });
  const ctx = buildAppContext({ sessionService });

  const beforeCleanup = routeAdmin.listRoutes(ctx)[0];
  assert.equal(beforeCleanup.dangling, true);
  assert.equal(beforeCleanup.health, 'dangling');
  assert.deepEqual(routeAdmin.detectDangling(ctx).map((item) => item.routeKey), ['route:focus-outside-members']);
  assert.deepEqual(routeAdmin.cleanupDangling(ctx, true), { ok: true, cleaned: ['route:focus-outside-members'] });
  const repaired = stateStore.read().routes['route:focus-outside-members'];
  assert.deepEqual(repaired.sessions, ['wks_second', 'wks_first']);
  assert.equal(repaired.focusSessionId, 'wks_second');
  assert.equal(repaired.cwd, '/mnt/h/production-boundary');
  const afterCleanup = routeAdmin.listRoutes(ctx)[0];
  assert.equal(afterCleanup.dangling, false);
  assert.equal(afterCleanup.health, 'idle');

  const stable = structuredClone(repaired);
  assert.deepEqual(routeAdmin.cleanupDangling(ctx, true), { ok: true, cleaned: [] });
  assert.deepEqual(stateStore.read().routes['route:focus-outside-members'], stable);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── REQ-009: driver 列表展示 opencode 与 stub 状态 ──

test('REQ-009: listAgents 展示 opencode 可用状态', () => {
  const ctx = buildAppContext();
  const agents = agentRuntimeAdmin.listAgents(ctx);
  assert.equal(agents.length, 1);
  assert.equal(agents[0].name, 'opencode');
  assert.equal(agents[0].available, true);
});

test('REQ-009: listAgents 展示 stub driver 不可用状态', () => {
  const ctx = buildAppContext({
    registry: createFakeRegistry({
      opencode: createFakeOpencodeDriver(),
      claude: createFakeStubDriver('claude'),
      codex: createFakeStubDriver('codex'),
    }),
  });

  const agents = agentRuntimeAdmin.listAgents(ctx);
  assert.equal(agents.length, 3);
  const opencode = agents.find((a) => a.name === 'opencode');
  assert.equal(opencode.available, true);

  const claude = agents.find((a) => a.name === 'claude');
  assert.equal(claude.available, false);
  assert.ok(claude.reason.includes('not implemented'));

  const codex = agents.find((a) => a.name === 'codex');
  assert.equal(codex.available, false);
  assert.ok(codex.reason.includes('not implemented'));
});

// ── REQ-010: OpenCode check 和 ensure-ready 返回明确结果 ──

test('REQ-010: checkAgent 对 opencode 返回 healthy', async () => {
  const ctx = buildAppContext();
  const result = await agentRuntimeAdmin.checkAgent(ctx, 'opencode');
  assert.equal(result.ok, true);
  assert.equal(result.healthy, true);
});

test('REQ-010: checkAgent 对 opencode 返回不健康结果', async () => {
  const ctx = buildAppContext({
    registry: createFakeRegistry({
      opencode: createFakeOpencodeDriver({
        ensureReady: async () => { throw new Error('opencode server not available'); },
      }),
    }),
  });

  const result = await agentRuntimeAdmin.checkAgent(ctx, 'opencode');
  assert.equal(result.ok, false);
  assert.equal(result.healthy, false);
  assert.ok(result.error);
});

test('REQ-010: checkAgent 对不存在 driver 返回 NOT_FOUND', async () => {
  const ctx = buildAppContext({ registry: createFakeRegistry() });
  const result = await agentRuntimeAdmin.checkAgent(ctx, 'unknown');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NOT_FOUND');
});

test('REQ-010: ensureReadyAgent 成功就绪', async () => {
  const ctx = buildAppContext();
  const result = await agentRuntimeAdmin.ensureReadyAgent(ctx);
  assert.equal(result.ok, true);
  assert.equal(result.ready, true);
});

test('REQ-010: ensureReadyAgent 失败时返回 ready=false', async () => {
  const ctx = buildAppContext({
    registry: createFakeRegistry({
      opencode: createFakeOpencodeDriver({
        ensureReady: async () => { throw new Error('opencode server failed to start'); },
      }),
    }),
  });

  const result = await agentRuntimeAdmin.ensureReadyAgent(ctx);
  assert.equal(result.ok, true);
  assert.equal(result.ready, false);
  assert.ok(result.error);
});

test('REQ-010: ensureReadyAgent 无 opencode driver 时返回 NOT_FOUND', async () => {
  const ctx = buildAppContext({ registry: createFakeRegistry() });
  const result = await agentRuntimeAdmin.ensureReadyAgent(ctx);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NOT_FOUND');
});

// ── REQ-011: runtime 检测返回 cwd、WSL distro、WSL IP 摘要 ──

test('REQ-011: detectRuntime 返回 Windows 和 WSL 配置', () => {
  const ctx = buildAppContext();
  const result = agentRuntimeAdmin.detectRuntime(ctx);
  assert.equal(result.windows.type, 'windows');
  assert.equal(result.wsl.type, 'wsl');
  assert.equal(result.wsl.distro, 'Ubuntu-24.04');
});

test('REQ-011: detectRuntime 带 cwd 存在性检查', () => {
  const ctx = buildAppContext();
  ctx.envConfig.walkerWslCwd = '/mnt/c/test';
  const result = agentRuntimeAdmin.detectRuntime(ctx, {
    checkCwd: (dirPath) => dirPath === 'C:\\test',
    checkWslCwd: (dirPath, distro) => dirPath === '/mnt/c/test' && distro === 'Ubuntu-24.04',
  });
  assert.equal(result.windows.cwdExists, true);
  assert.equal(result.windows.cwdChecked, true);
  assert.equal(result.wsl.cwdExists, true);
  assert.equal(result.wsl.cwdChecked, true);
  assert.equal(result.wsl.cwd, '/mnt/c/test');
});

test('REQ-011: detectRuntime 不复用 Windows CWD 结果冒充 WSL CWD', () => {
  const ctx = buildAppContext();
  const result = agentRuntimeAdmin.detectRuntime(ctx, {
    checkCwd: () => true,
  });
  assert.equal(result.windows.cwdExists, true);
  assert.equal(result.wsl.cwdExists, false);
  assert.equal(result.wsl.cwdChecked, false);
  assert.ok(result.wsl.cwdError);
});

test('REQ-011: detectRuntime 带 WSL IP 探测', () => {
  const ctx = buildAppContext();
  const result = agentRuntimeAdmin.detectRuntime(ctx, {
    checkCwd: () => true,
    detectWslIp: (_distro) => '172.25.0.1',
  });
  assert.equal(result.wsl.ipDetected, true);
  assert.equal(result.wsl.ip, '172.25.0.1');
});

test('REQ-011: detectRuntime 空 WSL IP 不标记为已检测', () => {
  const ctx = buildAppContext();
  const result = agentRuntimeAdmin.detectRuntime(ctx, {
    detectWslIp: () => '',
  });
  assert.equal(result.wsl.ipDetected, false);
  assert.equal(result.wsl.ip, '');
  assert.match(result.wsl.ipError, /not detected/);
});

test('REQ-011: detectRuntime WSL IP 探测失败', () => {
  const ctx = buildAppContext();
  const result = agentRuntimeAdmin.detectRuntime(ctx, {
    detectWslIp: () => { throw new Error('WSL IP not found'); },
  });
  assert.equal(result.wsl.ipDetected, false);
  assert.ok(result.wsl.ipError);
});

// ── REQ-016: timeline 合合状态、route、prompt 和错误事件 ──

test('REQ-016: getTimeline 按 session 合并事件', () => {
  const ctx = buildAppContext();
  recordEvent(ctx.eventStore, { type: 'session.state', sessionId: 'wks_tl1', message: 'created' });
  recordEvent(ctx.eventStore, { type: 'route.bind', sessionId: 'wks_tl1', routeKey: 'feishu:abc', message: 'bound' });
  recordEvent(ctx.eventStore, { type: 'admin.action', sessionId: 'wks_tl1', message: 'prompt sent' });
  recordEvent(ctx.eventStore, { type: 'error', sessionId: 'wks_tl2', message: 'other session error' });

  const timeline = sessionAdmin.getTimeline(ctx, 'wks_tl1');
  assert.equal(timeline.length, 3);
  assert.equal(timeline.every((e) => e.sessionId === 'wks_tl1'), true);
});

test('REQ-016: timeline 包含状态变更和 route 绑定事件', () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService([
      { id: 'wks_tl2', agent: 'opencode', title: 's', runtime: 'windows', cwd: '', status: 'running', agentRef: null, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
    ],
    { 'feishu:abc': 'wks_tl2' }),
  });
  recordEvent(ctx.eventStore, { type: 'session.state', sessionId: 'wks_tl2', message: 'session stopped', data: { warning: null } });
  recordEvent(ctx.eventStore, { type: 'route.bind', sessionId: 'wks_tl2', routeKey: 'feishu:abc', message: 'route bound' });

  const detail = sessionAdmin.getSession(ctx, 'wks_tl2');
  assert.ok(detail.timeline.length >= 2);
});

// ── REQ-017: 有效 agentRef 的 session 可发送网页 prompt ──

test('REQ-017: sendPrompt 对有 agentRef 的 session 成功', async () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService([
      { id: 'wks_prompt1', agent: 'opencode', title: 's', runtime: 'windows', cwd: '', status: 'running', agentRef: { opencodeSessionId: 'oc1' }, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
    ]),
  });

  const result = await sessionAdmin.sendPrompt(ctx, 'wks_prompt1', 'hello');
  assert.equal(result.ok, true);
  assert.ok(result.events);
});

test('REQ-017: sendPrompt 无 agentRef 返回 BAD_REQUEST', async () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService([
      { id: 'wks_prompt2', agent: 'opencode', title: 's', runtime: 'windows', cwd: '', status: 'idle', agentRef: null, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
    ]),
  });

  const result = await sessionAdmin.sendPrompt(ctx, 'wks_prompt2', 'hello');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'BAD_REQUEST');
});

test('REQ-017: sendPrompt 不存在的 session 返回 NOT_FOUND', async () => {
  const ctx = buildAppContext();
  const result = await sessionAdmin.sendPrompt(ctx, 'wks_nonexist', 'hello');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NOT_FOUND');
});

test('REQ-017: sendPrompt driver 不存在返回 NOT_FOUND', async () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService([
      { id: 'wks_prompt3', agent: 'opencode', title: 's', runtime: 'windows', cwd: '', status: 'running', agentRef: { opencodeSessionId: 'oc1' }, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
    ]),
    registry: createFakeRegistry(),
  });

  const result = await sessionAdmin.sendPrompt(ctx, 'wks_prompt3', 'hello');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NOT_FOUND');
});

// ── REQ-022: stub driver 展示预留状态且不误报可执行 ──

test('REQ-022: stub driver 不误报可执行', () => {
  const ctx = buildAppContext({
    registry: createFakeRegistry({
      opencode: createFakeOpencodeDriver(),
      claude: createFakeStubDriver('claude'),
    }),
  });

  const agents = agentRuntimeAdmin.listAgents(ctx);
  const claude = agents.find((a) => a.name === 'claude');
  assert.equal(claude.available, false);
  assert.ok(claude.reason.includes('not implemented'));
});

test('REQ-022: checkAgent 对 stub driver 返回不健康', async () => {
  const ctx = buildAppContext({
    registry: createFakeRegistry({
      claude: createFakeStubDriver('claude'),
    }),
  });

  const result = await agentRuntimeAdmin.checkAgent(ctx, 'claude');
  assert.equal(result.healthy, false);
  assert.ok(result.error);
});

// ── REQ-023: prompt 和错误会增加指标 ──

test('REQ-023: prompt 增加指标计数', async () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService([
      { id: 'wks_metric1', agent: 'opencode', title: 's', runtime: 'windows', cwd: '', status: 'running', agentRef: { opencodeSessionId: 'oc1' }, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
    ]),
  });

  const metricsBefore = ctx.eventStore.metrics.prompts;
  await sessionAdmin.sendPrompt(ctx, 'wks_metric1', 'test prompt');
  assert.equal(ctx.eventStore.metrics.prompts, metricsBefore + 1);
});

test('REQ-023: prompt 失败增加错误指标', async () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService([
      { id: 'wks_metric2', agent: 'opencode', title: 's', runtime: 'windows', cwd: '', status: 'running', agentRef: { opencodeSessionId: 'oc1' }, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
    ]),
    registry: createFakeRegistry({
      opencode: createFakeOpencodeDriver({
        prompt: async () => { throw new Error('prompt error'); },
      }),
    }),
  });

  const errorsBefore = ctx.eventStore.metrics.errors;
  const result = await sessionAdmin.sendPrompt(ctx, 'wks_metric2', 'test');
  assert.equal(result.ok, false);
  assert.equal(ctx.eventStore.metrics.errors, errorsBefore + 1);
});

// ── REQ-018: 核心健康检查覆盖孤立 route、OpenCode 和 runtime ──

test('REQ-018: detectHealth 返回 dangling route、opencode 和 runtime 检查', async () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService(
      [],
      { 'feishu:dangle': 'wks_nonexist' },
    ),
  });

  const checks = await agentRuntimeAdmin.detectHealth(ctx);
  assert.equal(checks.length, 3);

  const danglingCheck = checks.find((c) => c.name === 'dangling_routes');
  assert.equal(danglingCheck.status, 'warn');
  assert.ok(danglingCheck.items.length > 0);

  const opencodeCheck = checks.find((c) => c.name === 'opencode');
  assert.equal(opencodeCheck.status, 'pass');

  const runtimeCheck = checks.find((c) => c.name === 'runtime');
  assert.equal(runtimeCheck.status, 'pass');
});

test('REQ-018: detectHealth 无悬空 route 时 pass', async () => {
  const ctx = buildAppContext();
  const checks = await agentRuntimeAdmin.detectHealth(ctx);
  const danglingCheck = checks.find((c) => c.name === 'dangling_routes');
  assert.equal(danglingCheck.status, 'pass');
  assert.equal(danglingCheck.items.length, 0);
});

// ── 路由注册集成测试 ──

test('createCoreRoutes 只注册无歧义的兼容核心路由', () => {
  const ctx = buildAppContext();
  const routes = createCoreRoutes(ctx);
  assert.ok(routes.length >= 14);

  const patterns = routes.map((r) => r.method + ' ' + r.pattern);
  assert.ok(patterns.includes('GET /api/admin/overview'));
  assert.ok(patterns.includes('GET /api/admin/sessions'));
  assert.ok(patterns.includes('POST /api/admin/sessions'));
  assert.ok(patterns.includes('GET /api/admin/sessions/:id'));
  assert.ok(patterns.includes('POST /api/admin/sessions/:id/stop'));
  assert.ok(patterns.includes('DELETE /api/admin/sessions/:id'));
  assert.ok(patterns.includes('POST /api/admin/sessions/:id/prompt'));
  assert.ok(patterns.includes('GET /api/admin/sessions/:id/timeline'));
  assert.ok(patterns.includes('GET /api/admin/routes'));
  assert.ok(patterns.includes('POST /api/admin/routes/cleanup-dangling'));
  assert.ok(patterns.includes('GET /api/admin/agents'));
  assert.ok(patterns.includes('POST /api/admin/agents/:id/check'));
  assert.ok(patterns.includes('POST /api/admin/agents/opencode/ensure-ready'));
  assert.ok(patterns.includes('GET /api/admin/runtime'));
  assert.ok(patterns.includes('POST /api/admin/runtime/check'));
  assert.ok(!patterns.includes('GET /api/admin/metrics'));
  assert.ok(!patterns.includes('POST /api/admin/routes'));
  assert.ok(!patterns.includes('DELETE /api/admin/routes/:encodedRouteKey'));
  assert.ok(!patterns.includes('GET /api/admin/events'));
});

test('路由 overview handler 返回 JSON 响应', () => {
  const ctx = buildAppContext();
  const routes = createCoreRoutes(ctx);
  const result = callRoute(routes, 'GET', '/api/admin/overview');
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ok, true);
  assert.ok(result.body.data.process);
  assert.ok(result.body.data.sessions);
  assert.ok(result.body.data.routes);
});

test('路由 GET sessions 列表', () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService([
      { id: 'wks_route1', agent: 'opencode', title: 's1', runtime: 'windows', cwd: '', status: 'running', agentRef: null, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
    ]),
  });
  const routes = createCoreRoutes(ctx);
  const result = callRoute(routes, 'GET', '/api/admin/sessions');
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.data.total, 1);
});

test('路由 GET routes 列表', () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService(
      [{ id: 'wks_a', agent: 'opencode', title: 's', runtime: 'windows', cwd: '', status: 'running', agentRef: null, errorMessage: null, createdAt: 1000, updatedAt: 1000 }],
      { 'feishu:abc': 'wks_a' },
    ),
  });
  const routes = createCoreRoutes(ctx);
  const result = callRoute(routes, 'GET', '/api/admin/routes');
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.data.total, 1);
  assert.equal(result.body.data.list[0].routeKey, 'feishu:abc');
});

// ── REQ-026: 核心测试可独立运行 ──

test('REQ-026: 所有测试使用 fake 依赖无外部连接', () => {
  const ctx = buildAppContext();
  const agents = agentRuntimeAdmin.listAgents(ctx);
  assert.ok(agents);
  assert.equal(agents[0].name, 'opencode');
  assert.equal(agents[0].available, true);
});

test('REQ-026: session 状态变更写入 eventStore', async () => {
  const ctx = buildAppContext();
  const session = await sessionAdmin.createSession(ctx, { agent: 'opencode', title: 'event test' });

  const events = ctx.eventStore.events.filter((e) => e.sessionId === session.id);
  assert.ok(events.length >= 1);
  assert.equal(events[0].type, 'session.state');
  assert.equal(events[0].message, 'session created');
});

test('REQ-026: route 绑定事件写入 eventStore', () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService([
      { id: 'wks_bind', agent: 'opencode', title: 's', runtime: 'windows', cwd: '', status: 'running', agentRef: null, errorMessage: null, createdAt: 1000, updatedAt: 1000 },
    ]),
  });

  routeAdmin.bindRoute(ctx, 'feishu:xyz:chat1', 'wks_bind');
  const events = ctx.eventStore.events.filter((e) => e.type === 'route.bind');
  assert.ok(events.length >= 1);
  assert.equal(events[0].routeKey, 'feishu:xyz:chat1');
});

test('REQ-026: cleanup 事件写入 eventStore', () => {
  const ctx = buildAppContext({
    sessionService: createFakeSessionService(
      [],
      { 'feishu:cleanup:d1': 'wks_nonexist' },
    ),
  });

  routeAdmin.cleanupDangling(ctx, true);
  const events = ctx.eventStore.events.filter((e) => e.message === 'dangling route cleaned up');
  assert.ok(events.length >= 1);
});
