'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createRouter } = require('../src/admin/router');
const { createRouteRoutes } = require('../src/admin/route-routes');

/** 创建可观察 Route v3 调用的 fake SessionService。 */
function createSessionService() {
  const sessions = {
    wks_a: { id: 'wks_a', status: 'idle' },
    wks_b: { id: 'wks_b', status: 'idle' },
    wks_deleted: { id: 'wks_deleted', status: 'deleted' },
  };
  const routes = {};
  return {
    stateStore: {
      read() { return { sessions, routes }; },
    },
    getSession(id) { return sessions[id] || null; },
    listRoutes() { return routes; },
    addSessionToRoute(routeKey, sessionId) {
      if (!sessions[sessionId]) throw new Error('session not found: ' + sessionId);
      const route = routes[routeKey] || { focusSessionId: sessionId, sessions: [], cwd: '', updatedAt: 1 };
      if (!route.sessions.includes(sessionId)) route.sessions.push(sessionId);
      routes[routeKey] = route;
    },
    bindRoute(routeKey, sessionId) {
      this.addSessionToRoute(routeKey, sessionId);
      routes[routeKey].focusSessionId = sessionId;
    },
    removeSessionFromRoute(routeKey, sessionId) {
      const route = routes[routeKey];
      if (!route || !route.sessions.includes(sessionId)) return false;
      route.sessions = route.sessions.filter((id) => id !== sessionId);
      if (route.sessions.length === 0) delete routes[routeKey];
      else if (route.focusSessionId === sessionId) route.focusSessionId = route.sessions[0];
      return true;
    },
    setFocus(routeKey, sessionId) {
      const route = routes[routeKey];
      if (!route) throw new Error('route not found: ' + routeKey);
      const session = sessions[sessionId];
      if (!session) throw new Error('session not found: ' + sessionId);
      if (session.status === 'deleted') throw new Error('session deleted: ' + sessionId);
      if (!route.sessions.includes(sessionId)) throw new Error('session not in route: ' + sessionId);
      route.focusSessionId = sessionId;
    },
    setRouteCwd(routeKey, cwd) {
      if (!routes[routeKey]) throw new Error('route not found: ' + routeKey);
      if (typeof cwd !== 'string' || !cwd) throw new Error('cwd must be an absolute path');
      if (cwd.split(/[\\/]+/).includes('..')) throw new Error('cwd cannot be resolved');
      if (process.platform === 'win32' && /^\/(?!\/)/.test(cwd)) {
        if (cwd.includes('\\') || Array.from(cwd).some((char) => char.charCodeAt(0) < 32)) throw new Error('cwd is invalid');
        const normalized = path.posix.normalize(cwd).replace(/\/$/, '') || '/';
        if (normalized !== '/mnt/h/walker/src') throw new Error('cwd does not exist in WSL');
        routes[routeKey].cwd = normalized;
        return;
      }
      const isWindowsDrivePath = process.platform === 'win32' && /^[A-Za-z]:[\\/]/.test(cwd);
      const isWindowsUncPath = process.platform === 'win32' && /^\\\\[^\\/]+\\[^\\/]+(?:\\|$)/.test(cwd);
      if (!(isWindowsDrivePath || isWindowsUncPath || (process.platform !== 'win32' && cwd.startsWith('/')))) {
        throw new Error('cwd must be an absolute path');
      }
      let realCwd;
      try {
        realCwd = fs.realpathSync(cwd);
      } catch (_err) {
        throw new Error('cwd does not exist');
      }
      if (!fs.statSync(realCwd).isDirectory()) throw new Error('cwd is not a directory');
      routes[routeKey].cwd = realCwd;
    },
    deleteRoute(routeKey) {
      if (!routes[routeKey]) return false;
      delete routes[routeKey];
      return true;
    },
    seedRoute(routeKey, value) { routes[routeKey] = value; },
  };
}

/** 调用路由并等待异步 handler 完成。 */
async function callRoute(routes, method, pathname, body) {
  const router = createRouter();
  for (const route of routes) router.add(route.method, route.pattern, route.handler);
  const matched = router.match(method, pathname);
  if (!matched) return { statusCode: 404, body: null };

  const req = new EventEmitter();
  req.method = method;
  req.headers = {};
  let statusCode = 200;
  let responseBody;
  let resolveResponse;
  const completed = new Promise((resolve) => { resolveResponse = resolve; });
  const res = {
    writeHead(code) { statusCode = code; },
    end(data) {
      responseBody = JSON.parse(data);
      resolveResponse();
    },
  };

  const result = matched.handler(req, res, matched.params);
  if (body === undefined) req.emit('end');
  else {
    req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  }
  await Promise.all([Promise.resolve(result), completed]);
  return { statusCode, body: responseBody };
}

test('REQ-008-B01 Route v3 API 完整操作', async () => {
  const sessionService = createSessionService();
  const routes = createRouteRoutes({ sessionService });
  const routeKey = 'feishu:chat/room:ou_user';
  const encoded = encodeURIComponent(routeKey);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-route-api-'));

  let response = await callRoute(routes, 'POST', `/api/admin/routes/${encoded}/sessions`, { sessionId: 'wks_a' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body.data.route.sessions, ['wks_a']);

  response = await callRoute(routes, 'POST', `/api/admin/routes/${encoded}/sessions`, { sessionId: 'wks_b' });
  assert.equal(response.body.data.route.focusSessionId, 'wks_a', '明确添加 API 不隐式切换焦点');
  response = await callRoute(routes, 'PATCH', `/api/admin/routes/${encoded}/focus`, { sessionId: 'wks_b' });
  assert.equal(response.body.data.route.focusSessionId, 'wks_b');

  response = await callRoute(routes, 'PATCH', `/api/admin/routes/${encoded}`, { cwd });
  assert.equal(response.body.data.route.cwd, cwd);

  response = await callRoute(routes, 'DELETE', `/api/admin/routes/${encoded}/sessions/wks_a`);
  assert.deepEqual(response.body.data.route.sessions, ['wks_b']);

  response = await callRoute(routes, 'DELETE', `/api/admin/routes/${encoded}`, { confirm: true });
  assert.equal(response.body.data.deleted, true);
  assert.equal(response.body.data.routeKey, routeKey);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('REQ-008-B02 旧 Route bind API 保持兼容', async () => {
  const sessionService = createSessionService();
  const routes = createRouteRoutes({ sessionService });
  const response = await callRoute(routes, 'POST', '/api/admin/routes', {
    routeKey: 'feishu:legacy:ou_user',
    sessionId: 'wks_a',
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.route.focusSessionId, 'wks_a');
  assert.deepEqual(response.body.data.route.sessions, ['wks_a']);
});

test('REQ-008-B03 DELETE Route 不再移除焦点成员', async () => {
  const sessionService = createSessionService();
  const routes = createRouteRoutes({ sessionService });
  const routeKey = 'feishu:delete:ou_user';
  const encoded = encodeURIComponent(routeKey);
  await callRoute(routes, 'POST', `/api/admin/routes/${encoded}/sessions`, { sessionId: 'wks_a' });
  await callRoute(routes, 'POST', `/api/admin/routes/${encoded}/sessions`, { sessionId: 'wks_b' });

  let response = await callRoute(routes, 'DELETE', `/api/admin/routes/${encoded}`);
  assert.equal(response.statusCode, 400);
  assert.deepEqual(sessionService.listRoutes()[routeKey].sessions, ['wks_a', 'wks_b']);

  response = await callRoute(routes, 'DELETE', `/api/admin/routes/${encoded}`, { confirm: true });
  assert.equal(response.statusCode, 200);
  assert.equal(sessionService.listRoutes()[routeKey], undefined);
});

test('REQ-007-B04 Route API 拒绝非法输入', async () => {
  const sessionService = createSessionService();
  const routes = createRouteRoutes({ sessionService });
  const routeKey = 'feishu:invalid:ou_user';
  const encoded = encodeURIComponent(routeKey);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-route-api-invalid-'));
  const filePath = path.join(cwd, 'file.txt');
  const missingPath = path.join(cwd, 'missing');
  const unresolvedTraversal = cwd + path.sep + 'missing-segment' + path.sep + '..' + path.sep + 'other';
  fs.writeFileSync(filePath, 'not a directory');

  let response = await callRoute(routes, 'POST', `/api/admin/routes/${encoded}/sessions`, { sessionId: 'wks_missing' });
  assert.equal(response.statusCode, 404);

  response = await callRoute(routes, 'PATCH', `/api/admin/routes/${encoded}/focus`, { sessionId: 'wks_a' });
  assert.equal(response.statusCode, 404);

  await callRoute(routes, 'POST', `/api/admin/routes/${encoded}/sessions`, { sessionId: 'wks_a' });
  sessionService.seedRoute(routeKey, {
    focusSessionId: 'wks_a',
    sessions: ['wks_a', 'wks_missing_focus', 'wks_deleted'],
    cwd: '',
    updatedAt: 1,
  });
  const before = structuredClone(sessionService.listRoutes()[routeKey]);
  response = await callRoute(routes, 'PATCH', `/api/admin/routes/${encoded}/focus`, { sessionId: 'wks_missing_focus' });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(sessionService.listRoutes()[routeKey], before);

  response = await callRoute(routes, 'PATCH', `/api/admin/routes/${encoded}/focus`, { sessionId: 'wks_deleted' });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(sessionService.listRoutes()[routeKey], before);

  response = await callRoute(routes, 'PATCH', `/api/admin/routes/${encoded}`, { cwd: 'relative\\path' });
  assert.equal(response.statusCode, 400);
  assert.deepEqual(sessionService.listRoutes()[routeKey], before);

  for (const invalidCwd of [missingPath, filePath, unresolvedTraversal]) {
    response = await callRoute(routes, 'PATCH', `/api/admin/routes/${encoded}`, { cwd: invalidCwd });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(sessionService.listRoutes()[routeKey], before);
  }

  fs.rmSync(cwd, { recursive: true, force: true });
});

test('REQ-008-B04 Route API 重复移除返回稳定结果且保留其他成员', async () => {
  const sessionService = createSessionService();
  const routes = createRouteRoutes({ sessionService });
  const routeKey = 'feishu:idempotent:ou_user';
  const encoded = encodeURIComponent(routeKey);
  await callRoute(routes, 'POST', `/api/admin/routes/${encoded}/sessions`, { sessionId: 'wks_a' });
  await callRoute(routes, 'POST', `/api/admin/routes/${encoded}/sessions`, { sessionId: 'wks_b' });

  let response = await callRoute(routes, 'DELETE', `/api/admin/routes/${encoded}/sessions/wks_a`);
  assert.equal(response.body.data.removed, true);
  response = await callRoute(routes, 'DELETE', `/api/admin/routes/${encoded}/sessions/wks_a`);
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.removed, false);
  assert.deepEqual(response.body.data.route.sessions, ['wks_b']);
});

test('Route v3 API 在 Windows 上接受 WSL cwd 并拒绝非法边界', { skip: process.platform !== 'win32' }, async () => {
  const sessionService = createSessionService();
  const routes = createRouteRoutes({ sessionService });
  const routeKey = 'feishu:wsl:ou_user';
  const encoded = encodeURIComponent(routeKey);
  await callRoute(routes, 'POST', `/api/admin/routes/${encoded}/sessions`, { sessionId: 'wks_a' });

  let response = await callRoute(routes, 'PATCH', `/api/admin/routes/${encoded}`, { cwd: '/mnt/h/walker//src/' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.data.route.cwd, '/mnt/h/walker/src');
  const stable = structuredClone(sessionService.listRoutes()[routeKey]);

  for (const cwd of [
    '',
    'mnt/h/walker',
    '\\root-relative',
    'C:foo',
    '//server/share',
    '/mnt/h/../etc',
    '/mnt/h/walker\0bad',
    '/mnt\\h\\walker',
  ]) {
    response = await callRoute(routes, 'PATCH', `/api/admin/routes/${encoded}`, { cwd });
    assert.equal(response.statusCode, 400);
    assert.deepEqual(sessionService.listRoutes()[routeKey], stable);
  }
});
