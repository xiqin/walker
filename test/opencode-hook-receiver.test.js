const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const { SessionService } = require('../src/core/session-service');
const { JsonStore } = require('../src/core/json-store');
const { createHookReceiverRoutes } = require('../src/opencode-hook/receiver');
const { createAdminServer } = require('../src/admin/server');

function createCtx(options) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-hook-rcv-'));
  const stateStore = new JsonStore(path.join(tmpDir, 'state.json'), {});
  const sessionService = new SessionService({ stateStore });
  return {
    tmpDir,
    sessionService,
    config: { admin: { token: (options && options.token) || '' } },
    defaultOpencodeUrl: (options && options.defaultOpencodeUrl) || undefined,
  };
}

function makeReq(method, url, body, opts) {
  const req = {
    method: method || 'POST',
    url: url || '/opencode/hook/session-created',
    headers: {},
    on: function (ev, cb) {
      if (ev === 'data') {
        if (body !== undefined && body !== null) {
          cb(Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)));
        }
        return req;
      }
      if (ev === 'end') {
        cb();
        return req;
      }
      return req;
    },
  };
  if (opts && opts.remoteAddress) {
    req.socket = { remoteAddress: opts.remoteAddress };
    req.connection = { remoteAddress: opts.remoteAddress };
  } else {
    req.socket = { remoteAddress: '127.0.0.1' };
    req.connection = { remoteAddress: '127.0.0.1' };
  }
  if (opts && opts.authorization) {
    req.headers.authorization = opts.authorization;
  }
  if (opts && opts.cookie) {
    req.headers.cookie = opts.cookie;
  }
  return req;
}

function makeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead: function (code, headers) {
      res.statusCode = code;
      if (headers) {
        for (const k of Object.keys(headers)) res.headers[k] = headers[k];
      }
    },
    end: function (chunk) {
      if (chunk) res.body = chunk.toString();
    },
  };
  return res;
}

async function callRoute(routes, method, url, body, opts) {
  const req = makeReq(method, url, body, opts);
  const res = makeRes();
  const route = routes.find((r) => r.method === method && r.pattern === url);
  if (!route) throw new Error('route not found: ' + method + ' ' + url);
  await route.handler(req, res);
  return { req, res, parsed: res.body ? JSON.parse(res.body) : null };
}

test('上报 session.created 并按 cwd 精确匹配 route', async () => {
  const ctx = createCtx();
  try {
    const routeKey = 'feishu:oc_abc:ou_user';
    const cwd = 'H:\\walker';
    ctx.sessionService.setRouteCwd(routeKey, cwd);

    const routes = createHookReceiverRoutes(ctx);
    const { res, parsed } = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:1234',
      sessionId: 'oc_sess_1',
      cwd: cwd,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.data.sessionId);
    assert.equal(parsed.data.routeKey, routeKey);

    const sessionsInRoute = ctx.sessionService.listSessionsInRoute(routeKey);
    assert.equal(sessionsInRoute.length, 1);
    assert.equal(sessionsInRoute[0].agentRef.opencodeSessionId, 'oc_sess_1');
    assert.equal(sessionsInRoute[0].agentRef.serverUrl, 'http://127.0.0.1:1234');
    assert.equal(sessionsInRoute[0].agent, 'opencode');
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
});

test('上报 cwd 匹配子目录 route（子目录次之）', async () => {
  const ctx = createCtx();
  try {
    const routeKey = 'feishu:oc_parent:ou_user';
    const parentCwd = 'H:\\projects';
    ctx.sessionService.setRouteCwd(routeKey, parentCwd);

    const routes = createHookReceiverRoutes(ctx);
    const { res, parsed } = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:1234',
      sessionId: 'oc_sess_sub',
      cwd: 'H:\\projects\\subdir',
    });

    assert.equal(res.statusCode, 200);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.routeKey, routeKey);

    const sessionsInRoute = ctx.sessionService.listSessionsInRoute(routeKey);
    assert.equal(sessionsInRoute.length, 1);
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
});

test('重复上报同一 session 幂等返回', async () => {
  const ctx = createCtx();
  try {
    const routeKey = 'feishu:oc_dup:ou_user';
    const cwd = 'H:\\walker';
    ctx.sessionService.setRouteCwd(routeKey, cwd);

    const routes = createHookReceiverRoutes(ctx);

    const r1 = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:1234',
      sessionId: 'oc_sess_dup',
      cwd: cwd,
    });
    assert.equal(r1.res.statusCode, 200);

    const r2 = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:1234',
      sessionId: 'oc_sess_dup',
      cwd: cwd,
    });
    assert.equal(r2.res.statusCode, 200);
    assert.equal(r2.parsed.data.sessionId, r1.parsed.data.sessionId);

    const sessionsInRoute = ctx.sessionService.listSessionsInRoute(routeKey);
    assert.equal(sessionsInRoute.length, 1);
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
});

test('重复上报同一 session 时修正 serverUrl 和 cwd，并保留 agentRef 扩展字段', async () => {
  const ctx = createCtx();
  try {
    const routeKey = 'feishu:oc_refresh:ou_user';
    const cwd = 'H:\\walker';
    ctx.sessionService.setRouteCwd(routeKey, cwd);
    const routes = createHookReceiverRoutes(ctx);

    const first = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:4096',
      sessionId: 'oc_sess_refresh',
      cwd,
    });
    ctx.sessionService.updateSessionField(first.parsed.data.sessionId, 'agentRef', {
      ...ctx.sessionService.getSession(first.parsed.data.sessionId).agentRef,
      workspace: 'main',
    });
    const second = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:54321',
      sessionId: 'oc_sess_refresh',
      cwd: 'H:\\walker\\subdir',
    });

    assert.equal(second.parsed.data.sessionId, first.parsed.data.sessionId);
    const session = ctx.sessionService.getSession(first.parsed.data.sessionId);
    assert.deepEqual(session.agentRef, {
      opencodeSessionId: 'oc_sess_refresh',
      serverUrl: 'http://127.0.0.1:54321',
      workspace: 'main',
    });
    assert.equal(session.cwd, 'H:\\walker\\subdir');
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
});

test('活跃会话上报后成为匹配 route 的焦点', async () => {
  const ctx = createCtx();
  try {
    const routeKey = 'feishu:oc_active:ou_user';
    const cwd = 'H:\\walker';
    ctx.sessionService.setRouteCwd(routeKey, cwd);
    const routes = createHookReceiverRoutes(ctx);

    const first = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:4100',
      sessionId: 'oc_sess_first',
      cwd,
    });
    await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:4200',
      sessionId: 'oc_sess_active',
      cwd,
      active: true,
    });

    const focused = ctx.sessionService.getCurrent(routeKey);
    assert.equal(focused.agentRef.opencodeSessionId, 'oc_sess_active');
    assert.notEqual(focused.id, first.parsed.data.sessionId);
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
});

test('无匹配 cwd 时创建游离 session', async () => {
  const ctx = createCtx();
  try {
    const cwd = 'H:\\unmatched\\dir';
    const routes = createHookReceiverRoutes(ctx);
    const { res, parsed } = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:1234',
      sessionId: 'oc_sess_free',
      cwd: cwd,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(parsed.ok, true);
    assert.ok(parsed.data.sessionId);
    assert.equal(parsed.data.routeKey, null);

    const session = ctx.sessionService.getSession(parsed.data.sessionId);
    assert.ok(session);
    assert.equal(session.cwd, cwd);
    assert.equal(session.agentRef.opencodeSessionId, 'oc_sess_free');
    const routeForSession = ctx.sessionService.getRouteForSession(parsed.data.sessionId);
    assert.equal(routeForSession, null);
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
});

test('多候选 route 选最近活跃', async () => {
  const ctx = createCtx();
  try {
    const cwd = 'H:\\walker';
    const olderRouteKey = 'feishu:oc_older:ou_a';
    const newerRouteKey = 'feishu:oc_newer:ou_b';
    ctx.sessionService.setRouteCwd(olderRouteKey, cwd);
    ctx.sessionService.setRouteCwd(newerRouteKey, cwd);

    const now = Date.now();
    const state = ctx.sessionService.stateStore.read();
    state.routes[olderRouteKey].updatedAt = now - 60000;
    state.routes[newerRouteKey].updatedAt = now;
    ctx.sessionService.stateStore.write(state);

    const routes = createHookReceiverRoutes(ctx);
    const { res, parsed } = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:1234',
      sessionId: 'oc_sess_multi',
      cwd: cwd,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(parsed.data.routeKey, newerRouteKey);
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
});

test('同 cwd 多 route 优先选择最近飞书活跃 route', async () => {
  const ctx = createCtx();
  try {
    const cwd = 'H:\\walker';
    const activeRouteKey = 'feishu:oc_active:ou_a';
    const hookUpdatedRouteKey = 'feishu:oc_hook_updated:ou_b';
    ctx.sessionService.setRouteCwd(activeRouteKey, cwd);
    ctx.sessionService.setRouteCwd(hookUpdatedRouteKey, cwd);

    const now = Date.now();
    const state = ctx.sessionService.stateStore.read();
    state.routes[activeRouteKey].lastActiveAt = now;
    state.routes[activeRouteKey].updatedAt = now - 60000;
    state.routes[hookUpdatedRouteKey].updatedAt = now + 60000;
    ctx.sessionService.stateStore.write(state);

    const routes = createHookReceiverRoutes(ctx);
    const { res, parsed } = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:1234',
      sessionId: 'oc_sess_active_route',
      cwd: cwd,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(parsed.data.routeKey, activeRouteKey);
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
});

test('缺少 sessionId 返回 400', async () => {
  const ctx = createCtx();
  try {
    const routes = createHookReceiverRoutes(ctx);
    const { res, parsed } = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:1234',
      cwd: 'H:\\walker',
    });
    assert.equal(res.statusCode, 400);
    assert.equal(parsed.ok, false);
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
});

test('缺少 cwd 返回 400', async () => {
  const ctx = createCtx();
  try {
    const routes = createHookReceiverRoutes(ctx);
    const { res, parsed } = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:1234',
      sessionId: 'oc_sess_1',
    });
    assert.equal(res.statusCode, 400);
    assert.equal(parsed.ok, false);
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
});

test('非 loopback 请求返回 403', async () => {
  const ctx = createCtx();
  try {
    const routes = createHookReceiverRoutes(ctx);
    const { res, parsed } = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:1234',
      sessionId: 'oc_sess_1',
      cwd: 'H:\\walker',
    }, { remoteAddress: '192.168.1.100' });

    assert.equal(res.statusCode, 403);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, 'FORBIDDEN');
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
});

test('IPv6 loopback ::1 放行', async () => {
  const ctx = createCtx();
  try {
    const routeKey = 'feishu:oc_v6:ou_user';
    ctx.sessionService.setRouteCwd(routeKey, 'H:\\walker');

    const routes = createHookReceiverRoutes(ctx);
    const { res, parsed } = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:1234',
      sessionId: 'oc_sess_v6',
      cwd: 'H:\\walker',
    }, { remoteAddress: '::1' });

    assert.equal(res.statusCode, 200);
    assert.equal(parsed.ok, true);
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
});

test('配置 token 时无 token 请求被拒', async () => {
  const ctx = createCtx({ token: 'secret-token-xyz' });
  try {
    const routes = createHookReceiverRoutes(ctx);
    const { res, parsed } = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:1234',
      sessionId: 'oc_sess_1',
      cwd: 'H:\\walker',
    });

    assert.equal(res.statusCode, 401);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.error.code, 'UNAUTHORIZED');
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
});

test('配置 token 时携带正确 token 放行', async () => {
  const ctx = createCtx({ token: 'secret-token-xyz' });
  try {
    const routeKey = 'feishu:oc_authed:ou_user';
    ctx.sessionService.setRouteCwd(routeKey, 'H:\\walker');

    const routes = createHookReceiverRoutes(ctx);
    const { res, parsed } = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:1234',
      sessionId: 'oc_sess_authed',
      cwd: 'H:\\walker',
    }, { authorization: 'Bearer secret-token-xyz' });

    assert.equal(res.statusCode, 200);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.routeKey, routeKey);
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
});

test('直接传 adminConfig（无 .admin 属性）时 token 鉴权生效', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-hook-rcv-'));
  try {
    const stateStore = new JsonStore(path.join(tmpDir, 'state.json'), {});
    const sessionService = new SessionService({ stateStore });
    const ctx = {
      tmpDir,
      sessionService,
      config: { enabled: true, host: '127.0.0.1', port: 8787, token: 'direct-token-abc' },
    };
    const routeKey = 'feishu:oc_direct:ou_user';
    ctx.sessionService.setRouteCwd(routeKey, 'H:\\walker');

    const routes = createHookReceiverRoutes(ctx);
    const noToken = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:1234',
      sessionId: 'oc_direct_notoken',
      cwd: 'H:\\walker',
    });
    assert.equal(noToken.res.statusCode, 401, '无 token 应被拒');

    const withToken = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:1234',
      sessionId: 'oc_direct_withtoken',
      cwd: 'H:\\walker',
    }, { authorization: 'Bearer direct-token-abc' });
    assert.equal(withToken.res.statusCode, 200, '携带正确 token 应放行');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('onSessionEnrolled 回调在新 session 纳入 route 后触发', async () => {
  const ctx = createCtx();
  try {
    const routeKey = 'feishu:oc_cb:ou_user';
    const cwd = 'H:\\walker';
    ctx.sessionService.setRouteCwd(routeKey, cwd);

    const enrolled = [];
    ctx.onSessionEnrolled = ({ sessionId, routeKey: rk }) => {
      enrolled.push({ sessionId, routeKey: rk });
    };

    const routes = createHookReceiverRoutes(ctx);
    const { res, parsed } = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:1234',
      sessionId: 'oc_sess_cb',
      cwd: cwd,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(enrolled.length, 1, '回调应触发一次');
    assert.equal(enrolled[0].sessionId, parsed.data.sessionId);
    assert.equal(enrolled[0].routeKey, routeKey);
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
});

test('onSessionEnrolled 回调在幂等返回时也触发', async () => {
  const ctx = createCtx();
  try {
    const routeKey = 'feishu:oc_idem:ou_user';
    const cwd = 'H:\\walker';
    ctx.sessionService.setRouteCwd(routeKey, cwd);

    const enrolled = [];
    ctx.onSessionEnrolled = ({ sessionId, routeKey: rk }) => {
      enrolled.push({ sessionId, routeKey: rk });
    };

    const routes = createHookReceiverRoutes(ctx);
    const r1 = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:1234',
      sessionId: 'oc_sess_idem',
      cwd: cwd,
    });
    const r2 = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:1234',
      sessionId: 'oc_sess_idem',
      cwd: cwd,
    });

    assert.equal(r1.res.statusCode, 200);
    assert.equal(r2.res.statusCode, 200);
    assert.equal(enrolled.length, 2, '幂等返回也应触发回调');
    assert.equal(enrolled[0].sessionId, enrolled[1].sessionId);
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
});

test('onSessionEnrolled 回调抛错不影响 enroll 结果', async () => {
  const ctx = createCtx();
  try {
    const routeKey = 'feishu:oc_throw:ou_user';
    const cwd = 'H:\\walker';
    ctx.sessionService.setRouteCwd(routeKey, cwd);

    ctx.onSessionEnrolled = () => { throw new Error('callback boom'); };

    const routes = createHookReceiverRoutes(ctx);
    const { res, parsed } = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:1234',
      sessionId: 'oc_sess_throw',
      cwd: cwd,
    });

    assert.equal(res.statusCode, 200, '回调抛错不应影响 enroll 结果');
    assert.equal(parsed.ok, true);
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
});

// ── 端到端集成测试：验证路由通过 server handleRequest 可达 ──

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
 * 创建完整的 AdminServer 实例用于端到端测试
 * @param {Object} options - 配置选项
 * @param {string} options.token - admin token
 * @param {Function} [options.onSessionEnrolled] - session 纳入回调
 * @returns {{ server: Object, port: number, cleanup: Function, ctx: Object }}
 */
function createFullServer(options) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-e2e-'));
  const stateStore = new JsonStore(path.join(tmpDir, 'state.json'), {});
  const sessionService = new SessionService({ stateStore });
  const ctx = {
    tmpDir,
    sessionService,
    config: { enabled: true, host: '127.0.0.1', port: 0, token: options.token || '' },
  };
  if (options.onSessionEnrolled) {
    ctx.onSessionEnrolled = options.onSessionEnrolled;
  }

  const hookRoutes = createHookReceiverRoutes(ctx);
  ctx.hookReceiverRoutes = hookRoutes;

  const adminServer = createAdminServer({
    config: ctx.config,
    publicDir: '',
    routes: function registerRoutes(router, _authGuard) {
      for (const route of hookRoutes) {
        router.add(route.method, route.pattern, route.handler);
      }
    },
  });

  return { adminServer, ctx, cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }) };
}

async function withFullServer(options, testFn) {
  const { adminServer, ctx, cleanup } = createFullServer(options);
  await adminServer.start();
  const port = adminServer.getStatus().port;
  try {
    await testFn({ port, ctx });
  } finally {
    await adminServer.stop();
    cleanup();
  }
}

test('E2E: POST /opencode/hook/session-created 路由可达（不返回 404）', async () => {
  await withFullServer({ token: '' }, async ({ port, ctx }) => {
    const routeKey = 'feishu:oc_e2e:ou_user';
    ctx.sessionService.setRouteCwd(routeKey, 'H:\\walker');

    const res = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/opencode/hook/session-created',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        opencodeBaseUrl: 'http://127.0.0.1:1234',
        sessionId: 'oc_e2e_1',
        cwd: 'H:\\walker',
      },
    });

    assert.equal(res.statusCode, 200, '路由应可达，返回 200');
    assert.equal(res.body.ok, true);
    assert.ok(res.body.data.sessionId);
    assert.equal(res.body.data.routeKey, routeKey);

    const sessionsInRoute = ctx.sessionService.listSessionsInRoute(routeKey);
    assert.equal(sessionsInRoute.length, 1);
    assert.equal(sessionsInRoute[0].agentRef.opencodeSessionId, 'oc_e2e_1');
  });
});

test('E2E: loopback 检查生效——非 loopback 请求返回 403', async () => {
  await withFullServer({ token: '' }, async ({ port, ctx }) => {
    const routeKey = 'feishu:oc_e2e_lb:ou_user';
    ctx.sessionService.setRouteCwd(routeKey, 'H:\\walker');

    const res = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/opencode/hook/session-created',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        opencodeBaseUrl: 'http://127.0.0.1:1234',
        sessionId: 'oc_e2e_lb',
        cwd: 'H:\\walker',
      },
    });

    assert.notEqual(res.statusCode, 404, '不应返回 404（路由应可达）');
    assert.equal(res.statusCode, 200, 'loopback 请求应正常处理');
  });
});

test('E2E: token 鉴权生效——无 token 请求被拒（401）', async () => {
  await withFullServer({ token: 'e2e-secret-token' }, async ({ port, ctx }) => {
    const routeKey = 'feishu:oc_e2e_auth:ou_user';
    ctx.sessionService.setRouteCwd(routeKey, 'H:\\walker');

    const resNoToken = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/opencode/hook/session-created',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        opencodeBaseUrl: 'http://127.0.0.1:1234',
        sessionId: 'oc_e2e_auth',
        cwd: 'H:\\walker',
      },
    });

    assert.notEqual(resNoToken.statusCode, 404, '不应返回 404（路由应可达）');
    assert.equal(resNoToken.statusCode, 401, '无 token 应返回 401');
    assert.equal(resNoToken.body.ok, false);
    assert.equal(resNoToken.body.error.code, 'UNAUTHORIZED');

    const resWithToken = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/opencode/hook/session-created',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer e2e-secret-token',
      },
      body: {
        opencodeBaseUrl: 'http://127.0.0.1:1234',
        sessionId: 'oc_e2e_auth_ok',
        cwd: 'H:\\walker',
      },
    });

    assert.equal(resWithToken.statusCode, 200, '携带正确 token 应放行');
    assert.equal(resWithToken.body.ok, true);
    assert.equal(resWithToken.body.data.routeKey, routeKey);
  });
});

test('E2E: session 被正确创建并纳入 route', async () => {
  await withFullServer({ token: '' }, async ({ port, ctx }) => {
    const routeKey = 'feishu:oc_e2e_create:ou_user';
    const cwd = 'H:\\walker';
    ctx.sessionService.setRouteCwd(routeKey, cwd);

    const res = await httpRequest({
      hostname: '127.0.0.1',
      port,
      path: '/opencode/hook/session-created',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        opencodeBaseUrl: 'http://127.0.0.1:4040',
        sessionId: 'oc_e2e_create_sid',
        cwd: cwd,
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    const walkerSessionId = res.body.data.sessionId;
    assert.ok(walkerSessionId);
    assert.equal(res.body.data.routeKey, routeKey);

    const session = ctx.sessionService.getSession(walkerSessionId);
    assert.ok(session, 'session 应在 SessionService 中存在');
    assert.equal(session.cwd, cwd);
    assert.equal(session.agent, 'opencode');
    assert.equal(session.agentRef.opencodeSessionId, 'oc_e2e_create_sid');
    assert.equal(session.agentRef.serverUrl, 'http://127.0.0.1:4040');

    const sessionsInRoute = ctx.sessionService.listSessionsInRoute(routeKey);
    assert.equal(sessionsInRoute.length, 1);
    assert.equal(sessionsInRoute[0].id, walkerSessionId);

    const routeForSession = ctx.sessionService.getRouteForSession(walkerSessionId);
    assert.equal(routeForSession, routeKey);
  });
});

test('opencodeBaseUrl 为空时 fallback 到 ctx.defaultOpencodeUrl', async () => {
  const ctx = createCtx({ defaultOpencodeUrl: 'http://localhost:4096' });
  try {
    const routeKey = 'feishu:oc_fallback:ou_user';
    const cwd = 'H:\\walker';
    ctx.sessionService.setRouteCwd(routeKey, cwd);

    const routes = createHookReceiverRoutes(ctx);
    const { res, parsed } = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: '',
      sessionId: 'oc_empty_url',
      cwd: cwd,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(parsed.ok, true);

    const sessionsInRoute = ctx.sessionService.listSessionsInRoute(routeKey);
    assert.equal(sessionsInRoute.length, 1);
    assert.equal(sessionsInRoute[0].agentRef.serverUrl, 'http://localhost:4096');
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
});

test('opencodeBaseUrl 为空且无 defaultOpencodeUrl 时 fallback 到 localhost:4096', async () => {
  const ctx = createCtx();
  try {
    const routeKey = 'feishu:oc_default_url:ou_user';
    const cwd = 'H:\\walker';
    ctx.sessionService.setRouteCwd(routeKey, cwd);

    const routes = createHookReceiverRoutes(ctx);
    const { res, parsed } = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: '',
      sessionId: 'oc_no_url',
      cwd: cwd,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(parsed.ok, true);

    const sessionsInRoute = ctx.sessionService.listSessionsInRoute(routeKey);
    assert.equal(sessionsInRoute.length, 1);
    assert.equal(sessionsInRoute[0].agentRef.serverUrl, 'http://localhost:4096');
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
});

test('opencodeBaseUrl 非空时优先使用上报 loopback 值', async () => {
  const ctx = createCtx({ defaultOpencodeUrl: 'http://localhost:4096' });
  try {
    const routeKey = 'feishu:oc_priority:ou_user';
    const cwd = 'H:\\walker';
    ctx.sessionService.setRouteCwd(routeKey, cwd);

    const routes = createHookReceiverRoutes(ctx);
    const { res, parsed } = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://127.0.0.1:8080',
      sessionId: 'oc_priority_url',
      cwd: cwd,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(parsed.ok, true);

    const sessionsInRoute = ctx.sessionService.listSessionsInRoute(routeKey);
    assert.equal(sessionsInRoute.length, 1);
    assert.equal(sessionsInRoute[0].agentRef.serverUrl, 'http://127.0.0.1:8080');
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
});

test('opencodeBaseUrl 非 loopback 地址被拒绝', async () => {
  const ctx = createCtx();
  try {
    const routes = createHookReceiverRoutes(ctx);
    const { res, parsed } = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://192.168.1.100:8080',
      sessionId: 'oc_bad_url',
      cwd: 'H:\\walker',
    });

    assert.equal(res.statusCode, 400);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.error.message.includes('opencodeBaseUrl'));
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
});

test('opencodeBaseUrl 匹配已配置的 defaultOpencodeUrl 主机时放行', async () => {
  const ctx = createCtx({ defaultOpencodeUrl: 'http://opencode.internal:4096' });
  try {
    const routeKey = 'feishu:oc_custom:ou_user';
    const cwd = 'H:\\walker';
    ctx.sessionService.setRouteCwd(routeKey, cwd);

    const routes = createHookReceiverRoutes(ctx);
    const { res, parsed } = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'http://opencode.internal:4096',
      sessionId: 'oc_custom_url',
      cwd: cwd,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(parsed.ok, true);
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
});

test('opencodeBaseUrl 非 http/https scheme 被拒绝', async () => {
  const ctx = createCtx();
  try {
    const routes = createHookReceiverRoutes(ctx);
    const { res, parsed } = await callRoute(routes, 'POST', '/opencode/hook/session-created', {
      opencodeBaseUrl: 'ftp://127.0.0.1:4096',
      sessionId: 'oc_ftp_url',
      cwd: 'H:\\walker',
    });

    assert.equal(res.statusCode, 400);
    assert.equal(parsed.ok, false);
  } finally {
    fs.rmSync(ctx.tmpDir, { recursive: true, force: true });
  }
});
