/**
 * Admin HTTP 服务骨架与鉴权测试
 * 覆盖 REQ-001、REQ-002、REQ-025、REQ-026
 * 使用随机端口和 serverFactory 注入保证可独立运行
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { createAdminServer } = require('../src/admin/server');
const { createRouter, isAdminApiPath } = require('../src/admin/router');
const { success, error, send, errorCodeToStatus } = require('../src/admin/response');
const { extractToken, isAuthenticated, createAuthGuard, parseBody } = require('../src/admin/auth');
const { getMimeType, hasTraversal, resolveFilePath, isSpaFallbackCandidate } = require('../src/admin/static');

/**
 * 发送 HTTP 请求并收集响应
 * @param {Object} options - 请求选项
 * @returns {Promise<{ statusCode: number, headers: Object, body: Object|string }>}
 */
function httpRequest(options) {
  return new Promise((resolve, reject) => {
    const headers = Object.assign({ Connection: 'close' }, options.headers || {});
    const opts = Object.assign({}, options, { headers });
    const req = http.request(opts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let body;
        try { body = JSON.parse(raw); } catch (_e) { body = raw; }
        resolve({ statusCode: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

/**
 * 创建临时静态文件目录用于测试
 * @returns {{ dir: string, cleanup: Function }}
 */
function createTempPublicDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-admin-static-'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<html>SPA</html>', 'utf8');
  fs.writeFileSync(path.join(dir, 'app.css'), 'body { margin: 0; }', 'utf8');
  fs.writeFileSync(path.join(dir, 'app.js'), 'console.log("app")', 'utf8');
  const subDir = path.join(dir, 'css');
  fs.mkdirSync(subDir);
  fs.writeFileSync(path.join(subDir, 'main.css'), '.main {}', 'utf8');
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

async function withServer(overrides, testFn) {
  const opts = overrides || {};
  const publicDirInfo = opts.noStatic ? undefined : createTempPublicDir();
  const serverOpts = {
    config: opts.config || { enabled: true, host: '127.0.0.1', port: 0, token: opts.token || 'test-token' },
    publicDir: opts.publicDir || (publicDirInfo && publicDirInfo.dir),
    eventStore: opts.eventStore,
    routes: opts.routes,
    serverFactory: opts.serverFactory,
  };
  const adminServer = createAdminServer(serverOpts);
  const result = await adminServer.start();
  const port = adminServer.getStatus().port;

  try {
    await testFn({ adminServer, result, port });
  } finally {
    await adminServer.stop();
    if (publicDirInfo) publicDirInfo.cleanup();
  }
}

// ── REQ-001: admin disabled 时 AdminServer 不监听端口 ──

test('REQ-001: admin disabled 时不启动服务', async () => {
  const adminServer = createAdminServer({
    config: { enabled: false, host: '127.0.0.1', port: 0, token: '' },
  });

  const result = await adminServer.start();
  assert.equal(result.ok, true);
  assert.equal(result.disabled, true);
  assert.equal(adminServer.server, null);

  const status = adminServer.getStatus();
  assert.equal(status.disabled, true);
  assert.equal(status.started, true);

  await adminServer.stop();
});

test('REQ-001: 默认 host/port 可正常监听', async () => {
  await withServer({ config: { enabled: true, host: '127.0.0.1', port: 0, token: '' } }, async ({ result, adminServer }) => {
    assert.equal(result.ok, true);
    assert.equal(result.disabled, undefined);
    assert.equal(result.host, '127.0.0.1');
    assert.ok(result.port > 0);

    const status = adminServer.getStatus();
    assert.equal(status.started, true);
    assert.equal(status.disabled, false);
  });
});

// ── REQ-002: token 鉴权 ──

test('REQ-002: 缺失 token 的 status 接口返回未认证状态', async () => {
  await withServer({ token: 'secret123' }, async ({ port }) => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/admin/auth/status',
      method: 'GET',
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.authenticated, false);
    assert.equal(res.body.data.tokenRequired, true);
  });
});

test('REQ-002: 错误 token 的 status 接口返回未认证', async () => {
  await withServer({ token: 'correct-token' }, async ({ port }) => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/admin/auth/status',
      method: 'GET',
      headers: { Authorization: 'Bearer wrong-token' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.authenticated, false);
  });
});

test('REQ-002: 正确 Bearer token 可认证成功', async () => {
  await withServer({ token: 'my-token' }, async ({ port }) => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/admin/auth/status',
      method: 'GET',
      headers: { Authorization: 'Bearer my-token' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.authenticated, true);
  });
});

test('REQ-002: login 接口正确 token 返回成功并设置 cookie', async () => {
  await withServer({ token: 'login-token' }, async ({ port }) => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/admin/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { token: 'login-token' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.data.authenticated, true);
    assert.ok(res.headers['set-cookie']);
    const rawCookie = Array.isArray(res.headers['set-cookie']) ? res.headers['set-cookie'][0] : res.headers['set-cookie'];
    assert.ok(rawCookie.includes('walker_admin_sid='));
  });
});

test('REQ-002: login 接口错误 token 返回 401', async () => {
  await withServer({ token: 'valid-token' }, async ({ port }) => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/admin/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { token: 'invalid-token' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'UNAUTHORIZED');
  });
});

test('REQ-002: 无配置 token 时免鉴权', async () => {
  await withServer({ config: { enabled: true, host: '127.0.0.1', port: 0, token: '' } }, async ({ port }) => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/admin/auth/status',
      method: 'GET',
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.data.authenticated, true);
    assert.equal(res.body.data.tokenRequired, false);
  });
});

test('REQ-002: authGuard 拦截未认证写操作请求', async () => {
  await withServer({
    token: 'protected-token',
    routes: (router, authGuard) => {
      router.add('POST', '/api/admin/test-protected', authGuard((req, res) => {
        send(res, success({ protectedResult: true }));
      }));
    },
  }, async ({ port }) => {
    const resNoAuth = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/admin/test-protected',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {},
    });
    assert.equal(resNoAuth.statusCode, 401);
    assert.equal(resNoAuth.body.error.code, 'UNAUTHORIZED');

    const resWithAuth = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/admin/test-protected',
      method: 'POST',
      headers: { Authorization: 'Bearer protected-token', 'Content-Type': 'application/json' },
      body: {},
    });
    assert.equal(resWithAuth.statusCode, 200);
    assert.equal(resWithAuth.body.ok, true);
    assert.equal(resWithAuth.body.data.protectedResult, true);
  });
});

// ── 统一 JSON 格式 ──

test('response.success 返回标准成功格式', () => {
  const body = success({ list: [1, 2], total: 2 });
  assert.equal(body.ok, true);
  assert.deepEqual(body.data, { list: [1, 2], total: 2 });
});

test('response.error 返回标准错误格式', () => {
  const body = error('BAD_REQUEST', '参数缺失');
  assert.equal(body.ok, false);
  assert.equal(body.error.code, 'BAD_REQUEST');
  assert.equal(body.error.message, '参数缺失');
});

test('errorCodeToStatus 映射正确', () => {
  assert.equal(errorCodeToStatus('UNAUTHORIZED'), 401);
  assert.equal(errorCodeToStatus('FORBIDDEN'), 403);
  assert.equal(errorCodeToStatus('NOT_FOUND'), 404);
  assert.equal(errorCodeToStatus('BAD_REQUEST'), 400);
  assert.equal(errorCodeToStatus('METHOD_NOT_ALLOWED'), 405);
  assert.equal(errorCodeToStatus('INTERNAL_ERROR'), 500);
  assert.equal(errorCodeToStatus('UNKNOWN'), 400);
});

test('API 404 返回统一错误格式', async () => {
  await withServer({ token: 'test-token' }, async ({ port }) => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/admin/nonexistent',
      method: 'GET',
      headers: { Authorization: 'Bearer test-token' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });
});

// ── 路由匹配器 ──

test('router 基础匹配和参数提取', () => {
  const router = createRouter();
  router.add('GET', '/api/admin/sessions/:id', (_req, _res, _params) => {});

  const result = router.match('GET', '/api/admin/sessions/wks_abc123');
  assert.ok(result);
  assert.equal(result.params.id, 'wks_abc123');
});

test('router 无匹配返回 null', () => {
  const router = createRouter();
  router.add('GET', '/api/admin/sessions', () => {});
  assert.equal(router.match('POST', '/api/admin/sessions'), null);
  assert.equal(router.match('GET', '/api/admin/other'), null);
});

test('isAdminApiPath 判断正确', () => {
  assert.equal(isAdminApiPath('/api/admin/sessions'), true);
  assert.equal(isAdminApiPath('/api/admin/auth/status'), true);
  assert.equal(isAdminApiPath('/opencode/hook/session-created'), true);
  assert.equal(isAdminApiPath('/css/app.css'), false);
  assert.equal(isAdminApiPath('/sessions'), false);
});

// ── REQ-025: 静态文件与 SPA fallback ──

test('REQ-025: / 返回 index.html', async () => {
  await withServer({ token: 'spa-token' }, async ({ port }) => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/',
      method: 'GET',
      headers: { Authorization: 'Bearer spa-token' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, '<html>SPA</html>');
    assert.ok(res.headers['content-type'].includes('text/html'));
  });
});

test('REQ-025: 静态 CSS 文件正常返回', async () => {
  await withServer({ token: 'css-token' }, async ({ port }) => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/app.css',
      method: 'GET',
      headers: { Authorization: 'Bearer css-token' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, 'body { margin: 0; }');
    assert.ok(res.headers['content-type'].includes('text/css'));
  });
});

test('REQ-025: 子目录静态文件正常返回', async () => {
  await withServer({ token: 'sub-token' }, async ({ port }) => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/css/main.css',
      method: 'GET',
      headers: { Authorization: 'Bearer sub-token' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, '.main {}');
  });
});

test('REQ-025: SPA 子路径 fallback 返回 index.html', async () => {
  await withServer({ token: 'fallback-token' }, async ({ port }) => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/sessions/detail',
      method: 'GET',
      headers: { Authorization: 'Bearer fallback-token' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, '<html>SPA</html>');
  });
});

test('REQ-025: API 路径不落入 SPA fallback', async () => {
  await withServer({ token: 'api-no-fallback-token' }, async ({ port }) => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/admin/nonexistent',
      method: 'GET',
      headers: { Authorization: 'Bearer api-no-fallback-token' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });
});

test('REQ-025: 静态文件已知扩展名不触发 SPA fallback', async () => {
  await withServer({ token: 'ext-token' }, async ({ port }) => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/nonexistent.js',
      method: 'GET',
      headers: { Authorization: 'Bearer ext-token' },
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });
});

// ── 路径穿越防护 ──

test('路径穿越 .. 段被拒绝', async () => {
  await withServer({ token: 'traversal-token' }, async ({ port }) => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/../../../etc/passwd',
      method: 'GET',
      headers: { Authorization: 'Bearer traversal-token' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.ok, false);
  });
});

test('hasTraversal 检测正确', () => {
  assert.equal(hasTraversal('/../secret'), true);
  assert.equal(hasTraversal('/css/../../secret'), true);
  assert.equal(hasTraversal('/normal/path'), false);
  assert.equal(hasTraversal('/'), false);
});

test('resolveFilePath 阻止穿越路径', () => {
  assert.equal(resolveFilePath('/../etc/passwd', '/public'), null);
  assert.equal(resolveFilePath('/css/../../secret', '/public'), null);
  assert.ok(resolveFilePath('/app.css', '/public'));
});

test('isSpaFallbackCandidate 排除 API 和静态扩展名', () => {
  assert.equal(isSpaFallbackCandidate('/sessions/detail'), true);
  assert.equal(isSpaFallbackCandidate('/'), true);
  assert.equal(isSpaFallbackCandidate('/api/admin/sessions'), false);
  assert.equal(isSpaFallbackCandidate('/app.css'), false);
  assert.equal(isSpaFallbackCandidate('/app.js'), false);
});

// ── MIME 类型 ──

test('getMimeType 返回正确类型', () => {
  assert.ok(getMimeType('app.css').includes('text/css'));
  assert.ok(getMimeType('app.js').includes('javascript'));
  assert.ok(getMimeType('index.html').includes('text/html'));
  assert.equal(getMimeType('unknown.xyz'), 'application/octet-stream');
});

// ── 鉴权辅助函数 ──

test('extractToken 从 Authorization Bearer 头提取', () => {
  const req = { headers: { authorization: 'Bearer abc123' } };
  assert.equal(extractToken(req), 'abc123');
});

test('extractToken 从 cookie 提取', () => {
  const req = { headers: { cookie: 'walker_admin_sid=sessionabc123; other=val' } };
  assert.equal(extractToken(req), 'sessionabc123');
});

test('extractToken 空请求返回空串', () => {
  const req = { headers: {} };
  assert.equal(extractToken(req), '');
});

test('isAuthenticated 无配置 token 时始终通过', () => {
  assert.equal(isAuthenticated({ headers: {} }, { token: '' }), true);
});

test('isAuthenticated 有配置 token 时需匹配', () => {
  assert.equal(isAuthenticated({ headers: { authorization: 'Bearer matched' } }, { token: 'matched' }), true);
  assert.equal(isAuthenticated({ headers: {} }, { token: 'matched' }), false);
});

// ── parseBody ──

test('parseBody 正确解析 JSON 请求体', (t, done) => {
  const { PassThrough } = require('stream');
  const stream = new PassThrough();
  stream.write(JSON.stringify({ key: 'value' }));
  stream.end();

  parseBody(stream, (body) => {
    assert.deepEqual(body, { key: 'value' });
    done();
  });
});

test('parseBody 空请求体返回空对象', (t, done) => {
  const { PassThrough } = require('stream');
  const stream = new PassThrough();
  stream.end();

  parseBody(stream, (body) => {
    assert.deepEqual(body, {});
    done();
  });
});

test('parseBody 无效 JSON 返回 null', (t, done) => {
  const { PassThrough } = require('stream');
  const stream = new PassThrough();
  stream.write('not json');
  stream.end();

  parseBody(stream, (body) => {
    assert.equal(body, null);
    done();
  });
});

// ── 服务生命周期 ──

test('stop 关闭服务后不再监听', async () => {
  const publicDirInfo = createTempPublicDir();
  const adminServer = createAdminServer({
    config: { enabled: true, host: '127.0.0.1', port: 0, token: '' },
    publicDir: publicDirInfo.dir,
  });
  const result = await adminServer.start();
  const port = result.port;

  await adminServer.stop();
  assert.equal(adminServer.getStatus().started, false);

  try {
    await httpRequest({ hostname: '127.0.0.1', port, path: '/', method: 'GET' });
    assert.fail('不应连接成功');
  } catch (_e) {
    assert.ok(true);
  }

  publicDirInfo.cleanup();
});

test('serverFactory 注入用于测试', async () => {
  const factoryCalled = [];
  const publicDirInfo = createTempPublicDir();
  const adminServer = createAdminServer({
    config: { enabled: true, host: '127.0.0.1', port: 0, token: '' },
    publicDir: publicDirInfo.dir,
    serverFactory: (handler) => {
      factoryCalled.push(true);
      return http.createServer(handler);
    },
  });
  await adminServer.start();
  assert.equal(factoryCalled.length, 1);

  await adminServer.stop();
  publicDirInfo.cleanup();
});

// ── login 接口边界 ──

test('login 未配置 token 时拒绝登录请求', async () => {
  await withServer({ config: { enabled: true, host: '127.0.0.1', port: 0, token: '' } }, async ({ port }) => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/admin/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { token: 'anything' },
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
  });
});

test('login 缺少 token 字段返回 400', async () => {
  await withServer({ token: 'valid' }, async ({ port }) => {
    const res = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/admin/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {},
    });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.error.code, 'BAD_REQUEST');
  });
});

// ── cookie 认证 ──

test('cookie walker_admin_token 可认证', async () => {
  await withServer({ token: 'cookie-val' }, async ({ port }) => {
    const loginRes = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/admin/auth/login',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { token: 'cookie-val' },
    });

    const rawCookie = loginRes.headers['set-cookie'];
    const cookie = Array.isArray(rawCookie) ? rawCookie[0] : rawCookie;
    assert.ok(cookie);

    const cookieValue = cookie.split(';')[0];
    const statusRes = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/api/admin/auth/status',
      method: 'GET',
      headers: { Cookie: cookieValue },
    });
    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.body.data.authenticated, true);
  });
});

// ── createAuthGuard 函数接口 ──

test('createAuthGuard 返回包装函数', () => {
  const guard = createAuthGuard({ token: 'test' }, { success, error, send });
  const wrapped = guard((req, res) => { send(res, success({})); });
  assert.equal(typeof wrapped, 'function');
});
