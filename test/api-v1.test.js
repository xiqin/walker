'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAdminServer } = require('../src/admin/server');
const { createApiV1Routes } = require('../src/api/v1');
const { createEventStore, recordEvent } = require('../src/admin/event-store');

function createFakeSessionService() {
  const sessions = {
    wks_one: {
      id: 'wks_one',
      agent: 'opencode',
      title: 'One',
      runtime: 'windows',
      cwd: 'C:\\work',
      status: 'idle',
      agentRef: { opencodeSessionId: 'oc_one', serverUrl: 'http://127.0.0.1:4096', secretToken: 'must-not-leak' },
      createdAt: 1000,
      updatedAt: 2000,
    },
  };
  const routes = {
    chat_one: { focusSessionId: 'wks_one', sessions: ['wks_one'], cwd: 'C:\\work', updatedAt: 2000, lastActiveAt: 3000 },
  };
  return {
    stateStore: { read: () => ({ sessions, routes }) },
    _readNormalized: () => ({ sessions, routes }),
    listSessions: () => Object.values(sessions).filter((s) => s.status !== 'deleted'),
    getSession: (id) => sessions[id] || null,
    getCurrent: (routeKey) => {
      const route = routes[routeKey];
      return route ? sessions[route.focusSessionId] || null : null;
    },
    createSession(opts) {
      const id = 'wks_two';
      sessions[id] = {
        id,
        agent: opts.agent || 'opencode',
        title: opts.title || 'Two',
        runtime: opts.runtime || 'windows',
        cwd: opts.cwd || '',
        status: 'created',
        agentRef: { opencodeSessionId: 'oc_two', serverUrl: 'http://127.0.0.1:4096' },
        createdAt: 4000,
        updatedAt: 4000,
      };
      if (opts.route) routes[opts.route] = { focusSessionId: id, sessions: [id], cwd: opts.cwd || '' };
      return sessions[id];
    },
    stopSession(id) { if (sessions[id]) sessions[id].status = 'stopped'; },
    deleteSession(id) { if (sessions[id]) sessions[id].status = 'deleted'; },
    setFocus(routeKey, sessionId) {
      if (!sessions[sessionId]) throw new Error('session not found: ' + sessionId);
      if (!routes[routeKey]) routes[routeKey] = { focusSessionId: sessionId, sessions: [sessionId], cwd: '' };
      routes[routeKey].focusSessionId = sessionId;
      if (!routes[routeKey].sessions.includes(sessionId)) routes[routeKey].sessions.push(sessionId);
    },
    unbindRoute(routeKey) { delete routes[routeKey]; },
  };
}

function createContext(overrides) {
  const eventStore = createEventStore({ now: () => 123456 });
  const driver = {
    promptCalls: [],
    prompt: async (agentRef, text) => {
      driver.promptCalls.push({ agentRef, text });
      return [
        {
          type: 'text',
          data: {
            text,
            token: 'prompt-token-secret',
            nested: {
              apiKey: 'prompt-api-key',
              message: 'Bearer prompt-bearer-token',
              env: 'WALKER_ADMIN_TOKEN=prompt-env-token',
            },
          },
        },
        { type: 'done', data: {} },
      ];
    },
    stop: async () => {},
    delete: async () => {},
  };
  const registry = {
    get: (name) => name === 'opencode' ? driver : null,
    listProviderStatuses: async () => [{
      id: 'opencode',
      driver: 'opencode',
      installed: true,
      version: '1.2.3',
      healthy: true,
      registered: true,
      driverRegistered: true,
      configKeys: ['OPENCODE_TOKEN'],
      token: 'secret-token-value',
      nested: { apiSecret: 'hidden' },
    }],
    doctorProvider: async (id) => id === 'boom'
      ? (() => { throw new Error('doctor exploded'); })()
      : { ok: true, provider: { id, driver: id, healthy: true, token: 'doctor-secret' }, problems: [], suggestions: [] },
  };
  return {
    sessionService: createFakeSessionService(),
    registry,
    driver,
    eventStore,
    envConfig: { admin: { token: 'api-token' } },
    config: { token: 'api-token' },
    ...(overrides || {}),
  };
}

async function withServer(ctx, fn) {
  const server = createAdminServer({
    config: { enabled: true, host: '127.0.0.1', port: 0, token: 'api-token' },
    routes(router, authGuard) {
      for (const item of createApiV1Routes(ctx)) router.add(item.method, item.pattern, authGuard(item.handler));
      router.add('GET', '/api/admin/compat', authGuard((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, data: { compat: true } }));
      }));
    },
    eventStore: ctx.eventStore,
  });
  await server.start();
  try {
    const status = server.getStatus();
    await fn('http://' + status.host + ':' + status.port);
  } finally {
    await server.stop();
  }
}

async function request(baseUrl, method, pathname, body) {
  const response = await fetch(baseUrl + pathname, {
    method,
    headers: { Authorization: 'Bearer api-token', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('v1 providers/sessions/routes/events/metrics/prompt 返回稳定响应并脱敏', async () => {
  const ctx = createContext();
  recordEvent(ctx.eventStore, { type: 'seed', sessionId: 'wks_one', message: 'seed event' });
  recordEvent(ctx.eventStore, { type: 'secret.seed', data: { token: 'plain-token', nested: { apiSecret: 'plain-secret' }, text: 'Bearer plain-token' } });
  await withServer(ctx, async (baseUrl) => {
    const providers = await request(baseUrl, 'GET', '/api/v1/providers');
    assert.equal(providers.status, 200);
    assert.equal(providers.body.ok, true);
    assert.equal(providers.body.data.providers[0].token, '[REDACTED]');
    assert.equal(providers.body.data.providers[0].nested.apiSecret, '[REDACTED]');

    const doctor = await request(baseUrl, 'GET', '/api/v1/providers/opencode/doctor');
    assert.equal(doctor.status, 200);
    assert.equal(doctor.body.data.provider.token, '[REDACTED]');

    const list = await request(baseUrl, 'GET', '/api/v1/sessions');
    assert.equal(list.status, 200);
    assert.equal(list.body.data.sessions[0].id, 'wks_one');
    assert.equal(Object.hasOwn(list.body.data.sessions[0], 'agentRef'), false);

    const created = await request(baseUrl, 'POST', '/api/v1/sessions', { title: 'Created', route: 'chat_two' });
    assert.equal(created.status, 200);
    assert.equal(created.body.data.id, 'wks_two');

    const detail = await request(baseUrl, 'GET', '/api/v1/sessions/wks_one');
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.opencodeSessionId, 'oc_one');

    const routes = await request(baseUrl, 'GET', '/api/v1/routes');
    assert.equal(routes.status, 200);
    assert.equal(routes.body.data.routes.some((r) => r.routeKey === 'chat_one'), true);
    assert.equal(Object.hasOwn(routes.body.data.routes[0], 'session'), false);
    assert.equal(JSON.stringify(routes.body).includes('must-not-leak'), false);

    const routeDetail = await request(baseUrl, 'GET', '/api/v1/routes/chat_one');
    assert.equal(routeDetail.status, 200);
    assert.equal(Object.hasOwn(routeDetail.body.data, 'session'), false);
    assert.equal(JSON.stringify(routeDetail.body).includes('must-not-leak'), false);

    const focus = await request(baseUrl, 'POST', '/api/v1/routes/chat_one/focus', { sessionId: 'wks_two' });
    assert.equal(focus.status, 200);
    assert.equal(focus.body.ok, true);
    assert.equal(Object.hasOwn(focus.body.data.route, 'session'), false);

    const prompt = await request(baseUrl, 'POST', '/api/v1/prompt', { routeKey: 'chat_one', text: 'hello' });
    assert.equal(prompt.status, 200);
    assert.equal(prompt.body.data.sessionId, 'wks_two');
    assert.equal(prompt.body.data.events[0].data.text, 'hello');
    assert.equal(prompt.body.data.events[0].data.token, '[redacted]');
    assert.equal(prompt.body.data.events[0].data.nested.apiKey, '[redacted]');
    assert.equal(prompt.body.data.events[0].data.nested.message, 'Bearer [redacted]');
    assert.equal(prompt.body.data.events[0].data.nested.env, 'WALKER_ADMIN_TOKEN=[redacted]');
    assert.equal(JSON.stringify(prompt.body).includes('prompt-token-secret'), false);
    assert.equal(JSON.stringify(prompt.body).includes('prompt-api-key'), false);
    assert.equal(JSON.stringify(prompt.body).includes('prompt-bearer-token'), false);
    assert.equal(JSON.stringify(prompt.body).includes('prompt-env-token'), false);
    assert.equal(ctx.driver.promptCalls.length, 1);

    const events = await request(baseUrl, 'GET', '/api/v1/events?limit=20');
    assert.equal(events.status, 200);
    assert.equal(events.body.data.events.some((item) => item.type === 'api.v1.prompt'), true);
    assert.equal(events.body.data.events.some((item) => item.type === 'api.v1.provider.doctor'), true);
    assert.equal(JSON.stringify(events.body).includes('plain-token'), false);
    assert.equal(JSON.stringify(events.body).includes('plain-secret'), false);
    const secretEvent = events.body.data.events.find((item) => item.type === 'secret.seed');
    assert.equal(secretEvent.data.token, '[redacted]');
    assert.equal(secretEvent.data.nested.apiSecret, '[redacted]');

    const metrics = await request(baseUrl, 'GET', '/api/v1/metrics');
    assert.equal(metrics.status, 200);
    assert.equal(metrics.body.data.prompts, 1);
  });
});

test('v1 prompt 无效输入返回 BAD_REQUEST 且不调用 driver 并记录错误指标', async () => {
  const ctx = createContext();
  await withServer(ctx, async (baseUrl) => {
    const result = await request(baseUrl, 'POST', '/api/v1/prompt', { text: '   ' });
    assert.equal(result.status, 400);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'BAD_REQUEST');
    assert.deepEqual(result.body.error.details, {});
    assert.equal(ctx.driver.promptCalls.length, 0);
    const metrics = await request(baseUrl, 'GET', '/api/v1/metrics');
    assert.equal(metrics.body.data.errors, 1);
  });
});

test('v1 handler 异常返回结构化 INTERNAL_ERROR 且后续请求仍可处理', async () => {
  const ctx = createContext();
  await withServer(ctx, async (baseUrl) => {
    const failed = await request(baseUrl, 'GET', '/api/v1/providers/boom/doctor');
    assert.equal(failed.status, 500);
    assert.equal(failed.body.ok, false);
    assert.equal(failed.body.error.code, 'INTERNAL_ERROR');
    assert.deepEqual(failed.body.error.details, {});
    assert.equal(JSON.stringify(failed.body).includes('doctor exploded'), false);

    const errorEvent = ctx.eventStore.events.find((item) => item.type === 'api.v1.error');
    assert.ok(errorEvent);
    assert.match(errorEvent.message, /doctor exploded/);
    assert.equal(errorEvent.data.path, '/api/v1/providers/boom/doctor');
    assert.equal(errorEvent.data.code, 'INTERNAL_ERROR');

    const healthy = await request(baseUrl, 'GET', '/api/v1/metrics');
    assert.equal(healthy.status, 200);
    assert.equal(healthy.body.ok, true);
    assert.equal(healthy.body.data.errors, 1);
  });
});

test('/api/admin/* 兼容路径仍可认证访问', async () => {
  const ctx = createContext();
  await withServer(ctx, async (baseUrl) => {
    const compat = await request(baseUrl, 'GET', '/api/admin/compat');
    assert.equal(compat.status, 200);
    assert.deepEqual(compat.body, { ok: true, data: { compat: true } });
  });
});
