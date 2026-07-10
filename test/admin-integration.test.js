'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { createAdminServerFromContext } = require('../src/admin/index');
const { createEventStore } = require('../src/admin/event-store');

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
    envConfig: {},
    feishuSummary: { connected: false, source: 'missing' },
    dataDir: '',
    version: '0.1.0-test',
    startTime: Date.now(),
    runtime: { type: 'test' },
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
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve({ statusCode: res.statusCode, headers: res.headers, body: raw });
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

  it('路由组合：core + config + maintenance + tools 路由均注册到 router', () => {
    const ctx = makeFakeContext();
    const adminServer = createAdminServerFromContext(ctx);
    const routes = adminServer.router.routes;
    const patterns = routes.map((r) => r.pattern);

    assert.ok(patterns.includes('/api/admin/overview'));
    assert.ok(patterns.includes('/api/admin/sessions'));
    assert.ok(patterns.includes('/api/admin/config'));
    assert.ok(patterns.includes('/api/admin/logs'));
    assert.ok(patterns.includes('/api/admin/metrics'));
    assert.ok(patterns.includes('/api/admin/service/stop'));
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

    const metricsRes = await httpRequest({
      hostname: startResult.host, port: startResult.port, path: '/api/admin/metrics', method: 'GET',
      headers: { 'Connection': 'close' },
    });
    assert.equal(metricsRes.statusCode, 200);
    const metricsData = JSON.parse(metricsRes.body);
    assert.ok(metricsData.ok);

    await adminServer.stop();
  });
});
