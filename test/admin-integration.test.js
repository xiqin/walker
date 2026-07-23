'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { createAdminServerFromContext } = require('../src/admin/index');
const { createEventStore } = require('../src/admin/event-store');

const SECRET_SENTINEL = 'T8_SECRET_SENTINEL_7f4d0c';
const AUTH_TOKEN = 'T8_AUTH_TOKEN_d5a26b';

/**
 * 创建 fake 应用上下文，模拟 Walker 核心服务但不依赖真实飞书连接或 opencode server
 * @param {Object} [overrides] - 可覆盖的上下文字段
 * @returns {Object} fake appContext
 */
function makeFakeContext(overrides) {
  const eventStore = createEventStore();
  const ctx = {
    sessionService: {
      listSessions: () => [],
      getSession: () => null,
      createSession: () => {},
      markRunning: () => {},
      markIdle: () => {},
      markError: () => {},
      stateStore: { read: () => ({ sessions: {}, routes: {} }) },
    },
    registry: {
      list: () => [],
      get: () => null,
    },
    eventStore,
    envConfig: {
      feishuAppId: 'cli_test',
      feishuAppSecret: SECRET_SENTINEL,
      admin: { token: SECRET_SENTINEL },
      walkerDefaultRuntime: 'windows',
      walkerDefaultCwd: process.cwd(),
    },
    env: {
      FEISHU_APP_ID: 'cli_test',
      FEISHU_APP_SECRET: SECRET_SENTINEL,
      WALKER_ADMIN_TOKEN: SECRET_SENTINEL,
    },
    dataDir: '',
    version: '0.1.0-test',
    startTime: Date.now(),
    runtime: { type: 'test' },
    platform: { getStatus: () => ({ connected: true }) },
    dispatcher: { getWatchSnapshot: () => ({ status: 'healthy' }) },
    healthPoller: { getHealthSnapshots: () => [{ status: 'healthy' }] },
    tuiBridge: {
      getStatus: () => ({ status: 'healthy' }),
      getRuntimeSnapshots: () => [],
      getRuntimeSnapshot: () => null,
    },
    attachmentService: { listAttachments: () => ({ groups: [], totalFiles: 0 }) },
    config: { enabled: true, host: '127.0.0.1', port: 0, token: '' },
  };
  return Object.assign(ctx, overrides || {});
}

/**
 * 向指定 host:port 发送 HTTP 请求并返回响应体
 * @param {Object} options - http.request 选项
 * @param {string} [body] - 请求体 JSON 字符串
 * @returns {Promise<{statusCode, headers, body}>}
 */
function httpRequest(options, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        resolve({ statusCode: res.statusCode, headers: res.headers, body: raw.toString('utf8'), rawBody: raw });
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('request timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

describe('admin 集成测试', () => {
  it('认证：无 token 配置时 auth/status 返回 authenticated=true', async () => {
    const ctx = makeFakeContext();
    const stopCalled = [];
    const adminServer = createAdminServerFromContext(ctx, {
      stopApp: async () => { stopCalled.push('stop'); return { ok: true }; },
      exitProcess: () => { stopCalled.push('exit'); },
    });
    const startResult = await adminServer.start();
    assert.ok(startResult.ok);

    const res = await httpRequest({
      hostname: startResult.host, port: startResult.port, path: '/api/admin/auth/status', method: 'GET',
      headers: { 'Connection': 'close' },
    });
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.ok);
    assert.equal(data.data.authenticated, true);

    await adminServer.stop();
  });

  it('认证：有 token 时未携带 token 返回 401', async () => {
    const ctx = makeFakeContext({ config: { enabled: true, host: '127.0.0.1', port: 0, token: 'test-token-123' } });
    const adminServer = createAdminServerFromContext(ctx);
    const startResult = await adminServer.start();

    const res = await httpRequest({
      hostname: startResult.host, port: startResult.port, path: '/api/admin/overview', method: 'GET',
      headers: { 'Connection': 'close' },
    });
    assert.equal(res.statusCode, 401);

    await adminServer.stop();
  });

  it('认证：有 token 时 Bearer token 正确可访问 overview', async () => {
    const ctx = makeFakeContext({ config: { enabled: true, host: '127.0.0.1', port: 0, token: 'test-token-123' } });
    const adminServer = createAdminServerFromContext(ctx);
    const startResult = await adminServer.start();

    const res = await httpRequest({
      hostname: startResult.host, port: startResult.port, path: '/api/admin/overview', method: 'GET',
      headers: { 'Connection': 'close', 'Authorization': 'Bearer test-token-123' },
    });
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.ok);
    assert.ok(data.data.process);

    await adminServer.stop();
  });

  it('自动枚举的所有 Admin 写路由匿名访问均返回 401', async () => {
    const ctx = makeFakeContext({ config: { enabled: true, host: '127.0.0.1', port: 0, token: AUTH_TOKEN } });
    const adminServer = createAdminServerFromContext(ctx);
    const startResult = await adminServer.start();
    const writes = adminServer.router.routes.filter((route) => (
      route.pattern.startsWith('/api/admin/')
      && route.method !== 'GET'
      && !(route.method === 'POST' && route.pattern === '/api/admin/auth/login')
    ));
    assert.ok(writes.length > 0);
    for (const route of writes) {
      const requestPath = concretePath(route.pattern);
      const res = await httpRequest({
        hostname: startResult.host, port: startResult.port, path: requestPath, method: route.method,
        headers: { 'Connection': 'close', 'Content-Type': 'application/json' },
      }, '{}');
      assert.equal(res.statusCode, 401, `${route.method} ${route.pattern} -> ${requestPath}`);
    }
    await adminServer.stop();
  });

  it('overview 返回进程信息和指标摘要', async () => {
    const ctx = makeFakeContext();
    const adminServer = createAdminServerFromContext(ctx);
    const startResult = await adminServer.start();

    const res = await httpRequest({
      hostname: startResult.host, port: startResult.port, path: '/api/admin/overview', method: 'GET',
      headers: { 'Connection': 'close' },
    });
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.ok);
    assert.ok(data.data.process.pid);
    assert.equal(data.data.process.version, '0.1.0-test');
    assert.ok(data.data.metrics);

    await adminServer.stop();
  });

  it('静态首页：GET / 返回 HTML 内容', async () => {
    const ctx = makeFakeContext();
    const adminServer = createAdminServerFromContext(ctx);
    const startResult = await adminServer.start();

    const res = await httpRequest({
      hostname: startResult.host, port: startResult.port, path: '/', method: 'GET',
      headers: { 'Connection': 'close' },
    });
    assert.equal(res.statusCode, 200);
    assert.ok(res.body.includes('<html') || res.body.includes('Walker'));

    await adminServer.stop();
  });

  it('session 路由：GET /api/admin/sessions 返回空列表', async () => {
    const ctx = makeFakeContext();
    const adminServer = createAdminServerFromContext(ctx);
    const startResult = await adminServer.start();

    const res = await httpRequest({
      hostname: startResult.host, port: startResult.port, path: '/api/admin/sessions', method: 'GET',
      headers: { 'Connection': 'close' },
    });
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.ok);
    assert.equal(data.data.total, 0);

    await adminServer.stop();
  });

  it('service stop：无 confirm=true 返回 400', async () => {
    const ctx = makeFakeContext();
    const stopCalled = [];
    const adminServer = createAdminServerFromContext(ctx, {
      stopApp: async () => { stopCalled.push('stop'); return { ok: true }; },
      exitProcess: () => { stopCalled.push('exit'); },
    });
    const startResult = await adminServer.start();

    const res = await httpRequest({
      hostname: startResult.host, port: startResult.port, path: '/api/admin/service/stop', method: 'POST',
      headers: { 'Connection': 'close', 'Content-Type': 'application/json' },
    }, JSON.stringify({}));
    assert.equal(res.statusCode, 400);
    assert.equal(stopCalled.length, 0);

    await adminServer.stop();
  });

  it('service stop：confirm=true 调用 stopApp 并返回成功', async () => {
    const ctx = makeFakeContext();
    const stopCalled = [];
    const adminServer = createAdminServerFromContext(ctx, {
      stopApp: async () => { stopCalled.push('stop'); return { ok: true }; },
      exitProcess: () => {},
    });
    const startResult = await adminServer.start();

    const res = await httpRequest({
      hostname: startResult.host, port: startResult.port, path: '/api/admin/service/stop', method: 'POST',
      headers: { 'Connection': 'close', 'Content-Type': 'application/json' },
    }, JSON.stringify({ confirm: true }));
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.ok);
    assert.ok(data.data.stopped);
    assert.deepEqual(stopCalled, ['stop']);

    await adminServer.stop();
  });

  it('adminEnabled=false 时 start 返回 disabled', async () => {
    const ctx = makeFakeContext({ config: { enabled: false, host: '127.0.0.1', port: 8787, token: '' } });
    const adminServer = createAdminServerFromContext(ctx);
    const result = await adminServer.start();
    assert.ok(result.ok);
    assert.ok(result.disabled);
  });

  it('完整 Admin router 的 method + pattern 零重复', () => {
    const ctx = makeFakeContext();
    const adminServer = createAdminServerFromContext(ctx);
    const routes = adminServer.router.routes;
    const patterns = routes.map((r) => r.pattern);
    const keys = routes.map((route) => `${route.method} ${route.pattern}`);

    assert.ok(patterns.includes('/api/admin/overview'));
    assert.ok(patterns.includes('/api/admin/sessions'));
    assert.ok(patterns.includes('/api/admin/config'));
    assert.ok(patterns.includes('/api/admin/logs'));
    assert.ok(patterns.includes('/api/admin/metrics'));
    assert.ok(patterns.includes('/api/admin/service/stop'));
    assert.ok(patterns.includes('/api/admin/status'));
    assert.ok(patterns.includes('/api/admin/routes/:encodedRouteKey/sessions'));
    assert.ok(patterns.includes('/api/admin/tui-runtimes'));
    assert.ok(patterns.includes('/api/admin/diagnostics/export'));
    assert.equal(new Set(keys).size, keys.length, duplicateKeys(keys).join(', '));
    assert.equal(keys.filter((key) => key === 'GET /api/admin/events').length, 1);
    assert.equal(keys.filter((key) => key === 'GET /api/admin/metrics').length, 1);
  });

  it('健康检查路由返回检查结果', async () => {
    const ctx = makeFakeContext();
    const adminServer = createAdminServerFromContext(ctx);
    const startResult = await adminServer.start();

    const res = await httpRequest({
      hostname: startResult.host, port: startResult.port, path: '/api/admin/health', method: 'GET',
      headers: { 'Connection': 'close' },
    });
    assert.equal(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.ok(data.ok);
    assert.ok(data.data.checks);

    await adminServer.stop();
  });

  it('事件和指标路由正常工作', async () => {
    const ctx = makeFakeContext();
    const adminServer = createAdminServerFromContext(ctx);
    const startResult = await adminServer.start();

    const eventsRes = await httpRequest({
      hostname: startResult.host, port: startResult.port, path: '/api/admin/events', method: 'GET',
      headers: { 'Connection': 'close' },
    });
    assert.equal(eventsRes.statusCode, 200);
    const eventsData = JSON.parse(eventsRes.body);
    assert.ok(eventsData.ok);
    assert.deepEqual(eventsData.data.events, []);

    const metricsRes = await httpRequest({
      hostname: startResult.host, port: startResult.port, path: '/api/admin/metrics', method: 'GET',
      headers: { 'Connection': 'close' },
    });
    assert.equal(metricsRes.statusCode, 200);
    const metricsData = JSON.parse(metricsRes.body);
    assert.ok(metricsData.ok);

    await adminServer.stop();
  });

  it('status 每次请求读取实时依赖和 AdminServer 生命周期', async () => {
    let connection = { state: 'idle', reconnectAttempts: 0 };
    const platform = { wsClient: { getConnectionStatus: () => ({ ...connection }) } };
    const ctx = makeFakeContext({ platform, feishu: platform });
    const adminServer = createAdminServerFromContext(ctx);
    const startResult = await adminServer.start();
    connection = { state: 'connected', reconnectAttempts: 0 };
    const res = await httpRequest({ hostname: startResult.host, port: startResult.port, path: '/api/admin/status', method: 'GET' });
    const data = JSON.parse(res.body).data;
    assert.equal(data.feishu.status, 'healthy');
    assert.equal(data.admin.status, 'healthy');
    await adminServer.stop();
  });

  it('events 组合过滤、非法参数和兼容响应使用同一规范实现', async () => {
    const ctx = makeFakeContext();
    ctx.eventStore.events.push(
      { id: 1, timestamp: 100, level: 'info', type: 'session.state', sessionId: 'wks_a', routeKey: 'route-a' },
      { id: 2, timestamp: 200, level: 'error', type: 'error', sessionId: 'wks_b', routeKey: 'route-b' },
    );
    const adminServer = createAdminServerFromContext(ctx);
    const startResult = await adminServer.start();
    const filtered = await httpRequest({ hostname: startResult.host, port: startResult.port, path: '/api/admin/events?level=error&sessionId=wks_b&limit=1', method: 'GET' });
    const payload = JSON.parse(filtered.body);
    assert.equal(payload.data.events.length, 1);
    assert.equal(payload.data.events[0].sessionId, 'wks_b');
    const invalid = await httpRequest({ hostname: startResult.host, port: startResult.port, path: '/api/admin/events?limit=1001', method: 'GET' });
    assert.equal(invalid.statusCode, 400);
    await adminServer.stop();
  });

  it('Route v3 DELETE 不被旧含糊实现抢占且诊断导出可下载', async () => {
    const deleted = [];
    const ctx = makeFakeContext({
      sessionService: {
        listSessions: () => [], getSession: () => null,
        stateStore: { read: () => ({ sessions: {}, routes: { routeA: { sessions: [], focusSessionId: null } } }) },
        deleteRoute: (key) => { deleted.push(key); },
      },
    });
    const adminServer = createAdminServerFromContext(ctx);
    const startResult = await adminServer.start();
    const denied = await httpRequest({ hostname: startResult.host, port: startResult.port, path: '/api/admin/routes/routeA', method: 'DELETE', headers: { 'Content-Type': 'application/json' } }, '{}');
    assert.equal(denied.statusCode, 400);
    assert.deepEqual(deleted, []);
    const exported = await httpRequest({ hostname: startResult.host, port: startResult.port, path: '/api/admin/diagnostics/export', method: 'GET' });
    assert.equal(exported.statusCode, 200);
    assert.match(exported.headers['content-disposition'], /walker-diagnostics\.json/);
    await adminServer.stop();
  });

  it('静态模块 MIME、SPA fallback 和路径穿越边界正确', async () => {
    const adminServer = createAdminServerFromContext(makeFakeContext());
    const startResult = await adminServer.start();
    const module = await httpRequest({ hostname: startResult.host, port: startResult.port, path: '/js/app.js', method: 'GET' });
    assert.equal(module.statusCode, 200);
    assert.match(module.headers['content-type'], /application\/javascript/);
    const fallback = await httpRequest({ hostname: startResult.host, port: startResult.port, path: '/sessions/deep-link', method: 'GET' });
    assert.equal(fallback.statusCode, 200);
    assert.match(fallback.headers['content-type'], /text\/html/);
    const traversal = await httpRequest({ hostname: startResult.host, port: startResult.port, path: '/..%2Fpackage.json', method: 'GET' });
    assert.notEqual(traversal.statusCode, 200);
    await adminServer.stop();
  });

  it('Admin API、导出、工具、错误响应和可控 headers 全链路不泄漏 Secret', async () => {
    const sessionId = 'wks_secret_fixture';
    const routeKey = 'route-secret-fixture';
    const session = {
      id: sessionId,
      title: `title-${SECRET_SENTINEL}`,
      agent: 'opencode',
      runtime: 'windows',
      cwd: `C:\\fixture\\${SECRET_SENTINEL}`,
      status: 'error',
      errorMessage: `session-error-${SECRET_SENTINEL}`,
      agentRef: {
        opencodeSessionId: `ses-${SECRET_SENTINEL}`,
        serverUrl: `http://localhost/${SECRET_SENTINEL}`,
        transport: 'sse',
      },
      createdAt: 1,
      updatedAt: 2,
    };
    const route = {
      focusSessionId: sessionId,
      sessions: [sessionId],
      cwd: `C:\\route\\${SECRET_SENTINEL}`,
      label: `route-${SECRET_SENTINEL}`,
      updatedAt: 3,
    };
    const exportState = { sessions: { [sessionId]: session }, routes: { [routeKey]: route } };
    const timelineEvent = {
      id: 1, timestamp: Date.now(), level: 'error', type: 'error', sessionId,
      routeKey, message: `timeline-${SECRET_SENTINEL}`, data: { detail: SECRET_SENTINEL },
    };
    const commandQuery = new URLSearchParams({ text: `say ${SECRET_SENTINEL}`, routeKey }).toString();
    const previewFixture = { type: 'error', data: { message: `message-${SECRET_SENTINEL}`, content: SECRET_SENTINEL } };
    for (const [name, fixture] of Object.entries({ session, route, exportState, timelineEvent, commandQuery, previewFixture })) {
      assert.match(JSON.stringify(fixture), new RegExp(SECRET_SENTINEL), `${name} 原始 fixture 必须包含哨兵`);
    }

    const ctx = makeFakeContext({
      config: { enabled: true, host: '127.0.0.1', port: 0, token: AUTH_TOKEN },
      sessionService: {
        listSessions: () => [session],
        getSession: (id) => id === sessionId ? session : null,
        stateStore: { read: () => exportState },
      },
    });
    ctx.eventStore.events.push(timelineEvent);
    const adminServer = createAdminServerFromContext(ctx);
    const startResult = await adminServer.start();
    const authHeaders = { Authorization: `Bearer ${AUTH_TOKEN}`, 'Content-Type': 'application/json' };
    const requests = [
      ['GET', '/api/admin/status'],
      ['GET', '/api/admin/overview'],
      ['GET', '/api/admin/sessions'],
      ['GET', `/api/admin/sessions/${sessionId}`],
      ['GET', `/api/admin/sessions/${sessionId}/timeline`],
      ['GET', '/api/admin/routes'],
      ['GET', '/api/admin/events'],
      ['GET', '/api/admin/config'],
      ['GET', '/api/admin/health'],
      ['GET', '/api/admin/diagnostics/export'],
      ['GET', '/api/admin/export'],
      ['GET', `/api/admin/tools/command-simulate?${commandQuery}`],
      ['GET', '/api/admin/tools/cards'],
      ['POST', '/api/admin/tools/cards/preview', JSON.stringify(previewFixture)],
      ['GET', '/api/admin/events?limit=1001'],
      ['GET', '/api/admin/sessions/missing'],
      ['GET', '/api/admin/not-found'],
    ];
    for (const [method, requestPath, body] of requests) {
      const res = await httpRequest({
        hostname: startResult.host, port: startResult.port, path: requestPath, method,
        headers: authHeaders,
      }, body);
      assertNoSecret(res, `${method} ${requestPath}`);
    }
    await adminServer.stop();
  });

  it('二进制附件逐字节透传，文本脱敏后 Content-Length 精确匹配', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-t8-binary-'));
    const sessionId = 'wks_binary_fixture';
    const filename = 'binary-fixture.bin';
    const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x41]);
    const attachmentDir = path.join(dataDir, 'attachments', sessionId);
    fs.mkdirSync(attachmentDir, { recursive: true });
    fs.writeFileSync(path.join(attachmentDir, filename), bytes);

    const session = {
      id: sessionId, title: SECRET_SENTINEL, cwd: `C:\\${SECRET_SENTINEL}`,
      agent: 'opencode', runtime: 'windows', status: 'idle', createdAt: 1, updatedAt: 2,
    };
    const ctx = makeFakeContext({
      dataDir,
      config: { enabled: true, host: '127.0.0.1', port: 0, token: AUTH_TOKEN },
      sessionService: {
        listSessions: () => [session],
        getSession: (id) => id === sessionId ? session : null,
        stateStore: { read: () => ({ sessions: { [sessionId]: session }, routes: {} }) },
      },
    });
    const adminServer = createAdminServerFromContext(ctx);
    const startResult = await adminServer.start();
    try {
      const login = await httpRequest({
        hostname: startResult.host, port: startResult.port, path: '/api/admin/auth/login', method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }, JSON.stringify({ token: AUTH_TOKEN }));
      assert.equal(login.statusCode, 200);
      assert.match(String(login.headers['set-cookie']), /walker_admin_sid=/);

      const authHeaders = { Authorization: `Bearer ${AUTH_TOKEN}` };
      const download = await httpRequest({
        hostname: startResult.host, port: startResult.port,
        path: `/api/admin/attachments/${sessionId}/${filename}`, method: 'GET', headers: authHeaders,
      });
      assert.equal(download.statusCode, 200);
      assert.deepEqual(download.rawBody, bytes);
      assert.equal(download.headers['content-length'], '5');
      assert.equal(download.headers['content-type'], 'application/octet-stream');
      assert.match(download.headers['content-disposition'], /filename="binary-fixture\.bin"/);

      const json = await httpRequest({
        hostname: startResult.host, port: startResult.port, path: '/api/admin/export', method: 'GET', headers: authHeaders,
      });
      assert.equal(json.statusCode, 200);
      assert.doesNotMatch(json.body, new RegExp(SECRET_SENTINEL));
      assert.match(json.body, /\[REDACTED\]/);
      assert.equal(Number(json.headers['content-length']), json.rawBody.length);
    } finally {
      await adminServer.stop();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('JSON 脱敏只处理值且短 Secret 不破坏键名或普通文本', async () => {
    const shortSecret = 'id';
    const quotedSecret = 'a.*"\\';
    const ctx = makeFakeContext({
      envConfig: { feishuAppSecret: shortSecret, admin: { token: quotedSecret } },
      config: { enabled: true, host: '127.0.0.1', port: 0, token: '' },
      hookReceiverRoutes: [
        {
          method: 'GET', pattern: '/api/admin/redaction-json', handler: (_req, res) => {
            const payload = {
              id: 'identifier text remains intact',
              nested: { credential: quotedSecret, shortCredential: shortSecret },
              list: [quotedSecret, 'valid identifier'],
            };
            const body = JSON.stringify(payload);
            res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
            res.end(body);
          },
        },
        {
          method: 'GET', pattern: '/api/admin/redaction-text', handler: (_req, res) => {
            const body = `valid identifier; credential=${shortSecret}; escaped=${quotedSecret}; embedded=xa.*"\\y`;
            res.writeHead(200, {
              'Content-Type': 'text/plain',
              'Content-Length': Buffer.byteLength(body),
              'X-Safe-Text': 'valid identifier',
              'X-Credential': `credential=${shortSecret}`,
              'X-Escaped-Credential': `credential=${quotedSecret}`,
            });
            res.end(body);
          },
        },
        {
          method: 'GET', pattern: '/api/admin/redaction-unchanged', handler: (_req, res) => {
            const body = 'valid identifier';
            res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': Buffer.byteLength(body) });
            res.end(body);
          },
        },
      ],
    });
    const adminServer = createAdminServerFromContext(ctx);
    const startResult = await adminServer.start();
    try {
      const json = await httpRequest({ hostname: startResult.host, port: startResult.port, path: '/api/admin/redaction-json', method: 'GET' });
      assert.equal(json.statusCode, 200);
      assert.deepEqual(JSON.parse(json.body), {
        id: 'identifier text remains intact',
        nested: { credential: '[REDACTED]', shortCredential: '[REDACTED]' },
        list: ['[REDACTED]', 'valid identifier'],
      });
      assert.equal(Number(json.headers['content-length']), json.rawBody.length);

      const text = await httpRequest({ hostname: startResult.host, port: startResult.port, path: '/api/admin/redaction-text', method: 'GET' });
      assert.equal(text.body, 'valid identifier; credential=[REDACTED]; escaped=[REDACTED]; embedded=xa.*"\\y');
      assert.equal(text.headers['x-safe-text'], 'valid identifier');
      assert.equal(text.headers['x-credential'], 'credential=[REDACTED]');
      assert.equal(text.headers['x-escaped-credential'], 'credential=[REDACTED]');
      assert.equal(Number(text.headers['content-length']), text.rawBody.length);

      const unchanged = await httpRequest({ hostname: startResult.host, port: startResult.port, path: '/api/admin/redaction-unchanged', method: 'GET' });
      assert.equal(unchanged.body, 'valid identifier');
      assert.equal(unchanged.headers['content-length'], String(Buffer.byteLength('valid identifier')));
    } finally {
      await adminServer.stop();
    }
  });

  it('短 Secret 不修改协议头且 setHeader/writeHead 的最终长度均按 body 字节确定', async () => {
    const body = Buffer.from('12345');
    const makeRoute = (pattern, useWriteHead) => ({
      method: 'GET', pattern, handler: (_req, res) => {
        const headers = {
          'Content-Type': 'application/octet-stream',
          'Content-Length': '5',
          'Connection': 'close',
          'X-Label': 'valid identifier 5 credential=5',
          'Location': '/items/5',
          'Content-Disposition': 'attachment; filename="5.bin"',
        };
        if (useWriteHead) res.writeHead(200, headers);
        else for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
        res.end(body);
      },
    });
    const ctx = makeFakeContext({
      envConfig: { feishuAppSecret: '5' },
      hookReceiverRoutes: [makeRoute('/api/admin/header-set', false), makeRoute('/api/admin/header-head', true)],
    });
    const adminServer = createAdminServerFromContext(ctx);
    const startResult = await adminServer.start();
    try {
      for (const requestPath of ['/api/admin/header-set', '/api/admin/header-head']) {
        let response;
        try {
          response = await httpRequest({ hostname: startResult.host, port: startResult.port, path: requestPath, method: 'GET' });
        } catch (err) {
          err.message = requestPath + ': ' + err.message;
          throw err;
        }
        assert.equal(response.statusCode, 200);
        assert.deepEqual(response.rawBody, body);
        assert.equal(response.headers['content-length'], '5');
        assert.equal(response.headers['content-type'], 'application/octet-stream');
        assert.equal(response.headers.connection, 'close');
        assert.equal(response.headers['x-label'], 'valid identifier [REDACTED] credential=[REDACTED]');
        assert.equal(response.headers.location, '/items/[REDACTED]');
        assert.equal(response.headers['content-disposition'], 'attachment; filename="[REDACTED].bin"');
      }
    } finally {
      await adminServer.stop();
    }
  });
});

function concretePath(pattern) {
  return pattern.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name) => encodeURIComponent(`t8-${name}`));
}

function duplicateKeys(keys) {
  const seen = new Set();
  const duplicates = new Set();
  for (const key of keys) {
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates];
}

function assertNoSecret(response, label) {
  assert.doesNotMatch(response.body, new RegExp(SECRET_SENTINEL), `${label} body`);
  for (const [name, value] of Object.entries(response.headers)) {
    if (['set-cookie', 'content-type', 'content-disposition', 'location'].includes(name)) {
      assert.doesNotMatch(String(value), new RegExp(SECRET_SENTINEL), `${label} header ${name}`);
    }
  }
}
