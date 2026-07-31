'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createAdminServer } = require('../src/admin/server');
const { createApiV1Routes } = require('../src/api/v1');
const { createEventStore } = require('../src/admin/event-store');

function createContext(token = 'secret-token') {
  return {
    sessionService: { listSessions: () => [], stateStore: { read: () => ({ sessions: {}, routes: {} }) } },
    registry: { listProviderStatuses: async () => [] },
    eventStore: createEventStore(),
    config: { token },
  };
}

async function startServer(token = 'secret-token') {
  const ctx = createContext(token);
  const server = createAdminServer({
    config: { enabled: true, host: '127.0.0.1', port: 0, token },
    routes(router, authGuard) {
      for (const item of createApiV1Routes(ctx)) router.add(item.method, item.pattern, authGuard(item.handler));
    },
    eventStore: ctx.eventStore,
  });
  await server.start();
  const status = server.getStatus();
  return { server, baseUrl: 'http://' + status.host + ':' + status.port };
}

async function withServer(fn) {
  const { server, baseUrl } = await startServer();
  try {
    await fn(baseUrl);
  } finally {
    await server.stop();
  }
}

async function getProviders(baseUrl, token) {
  const headers = token === undefined ? {} : { Authorization: 'Bearer ' + token };
  const response = await fetch(baseUrl + '/api/v1/providers', { headers });
  return { status: response.status, body: await response.json() };
}

async function login(baseUrl, token) {
  const response = await fetch(baseUrl + '/api/admin/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
}

async function getProvidersWithCookie(baseUrl, cookie) {
  const response = await fetch(baseUrl + '/api/v1/providers', { headers: { Cookie: cookie } });
  const body = await response.json();
  return { status: response.status, body };
}

test('v1 无 token 请求被拒绝', async () => {
  await withServer(async (baseUrl) => {
    const result = await getProviders(baseUrl);
    assert.equal(result.status, 401);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'UNAUTHORIZED');
  });
});

test('v1 错误 token 请求被拒绝', async () => {
  await withServer(async (baseUrl) => {
    const result = await getProviders(baseUrl, 'wrong-token');
    assert.equal(result.status, 401);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'UNAUTHORIZED');
  });
});

test('v1 正确 token 请求可通过', async () => {
  await withServer(async (baseUrl) => {
    const result = await getProviders(baseUrl, 'secret-token');
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.deepEqual(result.body.data, { providers: [], total: 0 });
  });
});

test('REQ-001-B01 同一 server 登录 sid 可访问 v1 受保护接口', async () => {
  await withServer(async (baseUrl) => {
    const auth = await login(baseUrl, 'secret-token');
    assert.equal(auth.status, 200);
    assert.match(auth.cookie, /walker_admin_sid=/);

    const result = await getProvidersWithCookie(baseUrl, auth.cookie);
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.deepEqual(result.body.data, { providers: [], total: 0 });
  });
});

test('REQ-001-B02 REQ-001-B04 不同 token server 不能复用 sid 且 401 不泄漏凭据', async () => {
  const serverA = await startServer('token-a-secret');
  const serverB = await startServer('token-b-secret');
  try {
    const auth = await login(serverA.baseUrl, 'token-a-secret');
    assert.equal(auth.status, 200);
    const sid = auth.cookie.match(/walker_admin_sid=([^;]+)/)[1];

    const result = await getProvidersWithCookie(serverB.baseUrl, auth.cookie);
    const responseText = JSON.stringify(result.body);
    assert.equal(result.status, 401);
    assert.equal(result.body.ok, false);
    assert.equal(result.body.error.code, 'UNAUTHORIZED');
    assert.doesNotMatch(responseText, new RegExp(sid));
    assert.doesNotMatch(responseText, /token-a-secret|token-b-secret/);
  } finally {
    await serverA.server.stop();
    await serverB.server.stop();
  }
});
