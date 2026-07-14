'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createHealthPoller } = require('../src/opencode-hook/health-poller');

function createMockHttpClient(responses) {
  const calls = [];
  const client = {
    async request(method, url, body) {
      calls.push({ method, url, body });
      const next = responses.shift();
      if (next && next.throw) {
        throw new Error(next.throw);
      }
      return next && next.resp !== undefined ? next.resp : { status: 200 };
    },
    getCalls() { return calls; },
  };
  return client;
}

function createMockSessionService(opts) {
  const opts_ = opts || {};
  const routes = opts_.routes || {};
  const sessions = opts_.sessions || {};
  return {
    getSession(id) { return sessions[id] || null; },
    getRouteForSession(id) {
      for (const k of Object.keys(routes)) {
        if (routes[k].sessions && routes[k].sessions.includes(id)) return k;
      }
      return null;
    },
    removeSessionFromRoute(routeKey, sessionId) {
      const route = routes[routeKey];
      if (!route || !route.sessions.includes(sessionId)) return;
      route.sessions = route.sessions.filter((s) => s !== sessionId);
      if (route.sessions.length === 0) {
        delete routes[routeKey];
      } else if (route.focusSessionId === sessionId) {
        route.focusSessionId = route.sessions[0];
      }
    },
    listSessions() { return Object.values(sessions); },
  };
}

function createMockDispatcher() {
  const actions = [];
  const _turnStates = new Map();
  return {
    turnStates: _turnStates,
    cancelledSessions: new Set(),
    stoppedSessions: new Set(),
    actions,
    getTurnState(sessionId) {
      const ts = _turnStates.get(sessionId);
      return ts ? { token: ts.token, cancelled: ts.cancelled } : null;
    },
    async cancelTurnBySessionId(sessionId, reason) {
      actions.push({ type: 'cancelTurn', sessionId, reason });
      this.cancelledSessions.add(sessionId);
      const ts = _turnStates.get(sessionId);
      if (ts) ts.cancelled = true;
    },
    stopSessionWatch(sessionId) {
      actions.push({ type: 'stopWatch', sessionId });
      this.stoppedSessions.add(sessionId);
    },
  };
}

function createMockDriverRegistry() {
  return { get() { return null; } };
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test('track 启动独立轮询', async () => {
  const httpClient = createMockHttpClient([{ resp: { status: 200 } }]);
  const sessionService = createMockSessionService({
    sessions: { s1: { id: 's1', agent: 'opencode', agentRef: { opencodeSessionId: 'op1', serverUrl: 'http://localhost:4096' } } },
    routes: { r1: { focusSessionId: 's1', sessions: ['s1'], cwd: 'C:\\proj' } },
  });
  const dispatcher = createMockDispatcher();
  const poller = createHealthPoller({
    sessionService,
    driverRegistry: createMockDriverRegistry(),
    dispatcher,
    pollIntervalMs: 10,
    exitAction: 'cancel',
    httpClient,
  });
  poller.start();
  poller.track('s1', { opencodeSessionId: 'op1', serverUrl: 'http://localhost:4096' });
  await sleep(35);
  assert.equal(poller.getTrackedSessions().length, 1);
  assert.equal(poller.getTrackedSessions()[0], 's1');
  poller.stop();
  assert.equal(poller.getTrackedSessions().length, 0);
});

test('untrack 停止轮询', async () => {
  const httpClient = createMockHttpClient([{ resp: { status: 200 } }]);
  const sessionService = createMockSessionService({
    sessions: { s2: { id: 's2', agent: 'opencode', agentRef: { opencodeSessionId: 'op2', serverUrl: 'http://localhost:4096' } } },
    routes: { r2: { focusSessionId: 's2', sessions: ['s2'], cwd: 'C:\\proj2' } },
  });
  const dispatcher = createMockDispatcher();
  const poller = createHealthPoller({
    sessionService,
    driverRegistry: createMockDriverRegistry(),
    dispatcher,
    pollIntervalMs: 10,
    exitAction: 'cancel',
    httpClient,
  });
  poller.start();
  poller.track('s2', { opencodeSessionId: 'op2', serverUrl: 'http://localhost:4096' });
  await sleep(15);
  poller.untrack('s2');
  assert.equal(poller.getTrackedSessions().length, 0);
  const calls1 = httpClient.getCalls().length;
  await sleep(30);
  assert.equal(httpClient.getCalls().length, calls1, 'no more calls after untrack');
});

test('单次失败不判定 detached', async () => {
  const httpClient = createMockHttpClient([
    { throw: 'ECONNREFUSED' },
    { resp: { status: 200 } },
    { resp: { status: 200 } },
  ]);
  const sessionService = createMockSessionService({
    sessions: { s3: { id: 's3', agent: 'opencode', agentRef: { opencodeSessionId: 'op3', serverUrl: 'http://localhost:4096' } } },
    routes: { r3: { focusSessionId: 's3', sessions: ['s3'], cwd: 'C:\\p3' } },
  });
  const dispatcher = createMockDispatcher();
  const poller = createHealthPoller({
    sessionService,
    driverRegistry: createMockDriverRegistry(),
    dispatcher,
    pollIntervalMs: 15,
    exitAction: 'cancel',
    httpClient,
  });
  poller.start();
  poller.track('s3', { opencodeSessionId: 'op3', serverUrl: 'http://localhost:4096' });
  await sleep(60);
  assert.equal(dispatcher.actions.filter((a) => a.type === 'cancelTurn').length, 0, 'single failure should not cancel');
  poller.stop();
});

test('detached 取消 turn 并移除 route', async () => {
  const httpClient = createMockHttpClient([
    { throw: 'ECONNREFUSED' },
    { throw: 'ECONNREFUSED' },
    { throw: 'ECONNREFUSED' },
  ]);
  const sessionService = createMockSessionService({
    sessions: { s4: { id: 's4', agent: 'opencode', agentRef: { opencodeSessionId: 'op4', serverUrl: 'http://localhost:4096' } } },
    routes: { r4: { focusSessionId: 's4', sessions: ['s4'], cwd: 'C:\\p4' } },
  });
  const dispatcher = createMockDispatcher();
  dispatcher.turnStates.set('s4', { token: 't1', cancelled: false, driver: null });
  const poller = createHealthPoller({
    sessionService,
    driverRegistry: createMockDriverRegistry(),
    dispatcher,
    pollIntervalMs: 10,
    exitAction: 'cancel',
    httpClient,
  });
  poller.start();
  poller.track('s4', { opencodeSessionId: 'op4', serverUrl: 'http://localhost:4096' });
  await sleep(80);
  const cancels = dispatcher.actions.filter((a) => a.type === 'cancelTurn');
  assert.ok(cancels.length >= 1, 'should cancel turn');
  assert.equal(cancels[0].sessionId, 's4');
  const stops = dispatcher.actions.filter((a) => a.type === 'stopWatch');
  assert.ok(stops.length >= 1, 'should stop watch');
  assert.equal(sessionService.getRouteForSession('s4'), null, 'session removed from route');
  poller.stop();
});

test('焦点 detached 自动切下一个 session', async () => {
  const httpClient = createMockHttpClient([
    { throw: 'ECONNREFUSED' },
    { throw: 'ECONNREFUSED' },
  ]);
  const routes = { r5: { focusSessionId: 's5a', sessions: ['s5a', 's5b'], cwd: 'C:\\p5' } };
  const sessionService = createMockSessionService({
    sessions: {
      s5a: { id: 's5a', agent: 'opencode', agentRef: { opencodeSessionId: 'op5a', serverUrl: 'http://localhost:4096' } },
      s5b: { id: 's5b', agent: 'opencode', agentRef: { opencodeSessionId: 'op5b', serverUrl: 'http://localhost:4096' } },
    },
    routes,
  });
  const dispatcher = createMockDispatcher();
  dispatcher.turnStates.set('s5a', { token: 't1', cancelled: false, driver: null });
  const poller = createHealthPoller({
    sessionService,
    driverRegistry: createMockDriverRegistry(),
    dispatcher,
    pollIntervalMs: 10,
    exitAction: 'cancel',
    httpClient,
  });
  poller.start();
  poller.track('s5a', { opencodeSessionId: 'op5a', serverUrl: 'http://localhost:4096' });
  await sleep(80);
  assert.equal(routes.r5.focusSessionId, 's5b', 'focus switched to next session');
  assert.ok(routes.r5.sessions.includes('s5b'), 's5b still in route');
  assert.ok(!routes.r5.sessions.includes('s5a'), 's5a removed from route');
  poller.stop();
});

test('exitAction=none 不取消 turn', async () => {
  const httpClient = createMockHttpClient([
    { throw: 'ECONNREFUSED' },
    { throw: 'ECONNREFUSED' },
  ]);
  const sessionService = createMockSessionService({
    sessions: { s6: { id: 's6', agent: 'opencode', agentRef: { opencodeSessionId: 'op6', serverUrl: 'http://localhost:4096' } } },
    routes: { r6: { focusSessionId: 's6', sessions: ['s6'], cwd: 'C:\\p6' } },
  });
  const dispatcher = createMockDispatcher();
  dispatcher.turnStates.set('s6', { token: 't1', cancelled: false, driver: null });
  const poller = createHealthPoller({
    sessionService,
    driverRegistry: createMockDriverRegistry(),
    dispatcher,
    pollIntervalMs: 10,
    exitAction: 'none',
    httpClient,
  });
  poller.start();
  poller.track('s6', { opencodeSessionId: 'op6', serverUrl: 'http://localhost:4096' });
  await sleep(80);
  const cancels = dispatcher.actions.filter((a) => a.type === 'cancelTurn');
  assert.equal(cancels.length, 0, 'should not cancel when exitAction=none');
  const stops = dispatcher.actions.filter((a) => a.type === 'stopWatch');
  assert.ok(stops.length >= 1, 'should still stop watch');
  poller.stop();
});

test('无 running turn 时退出不报错', async () => {
  const httpClient = createMockHttpClient([
    { throw: 'ECONNREFUSED' },
    { throw: 'ECONNREFUSED' },
  ]);
  const sessionService = createMockSessionService({
    sessions: { s7: { id: 's7', agent: 'opencode', agentRef: { opencodeSessionId: 'op7', serverUrl: 'http://localhost:4096' } } },
    routes: { r7: { focusSessionId: 's7', sessions: ['s7'], cwd: 'C:\\p7' } },
  });
  const dispatcher = createMockDispatcher();
  const poller = createHealthPoller({
    sessionService,
    driverRegistry: createMockDriverRegistry(),
    dispatcher,
    pollIntervalMs: 10,
    exitAction: 'cancel',
    httpClient,
  });
  poller.start();
  poller.track('s7', { opencodeSessionId: 'op7', serverUrl: 'http://localhost:4096' });
  await sleep(80);
  const cancels = dispatcher.actions.filter((a) => a.type === 'cancelTurn');
  assert.equal(cancels.length, 0, 'no cancel when no running turn');
  const stops = dispatcher.actions.filter((a) => a.type === 'stopWatch');
  assert.ok(stops.length >= 1, 'should still stop watch');
  poller.stop();
});

test('stop 清空所有追踪和定时器', async () => {
  const httpClient = createMockHttpClient([{ resp: { status: 200 } }]);
  const sessionService = createMockSessionService({
    sessions: {
      s8a: { id: 's8a', agent: 'opencode', agentRef: { opencodeSessionId: 'op8a', serverUrl: 'http://localhost:4096' } },
      s8b: { id: 's8b', agent: 'opencode', agentRef: { opencodeSessionId: 'op8b', serverUrl: 'http://localhost:4096' } },
    },
    routes: {
      r8a: { focusSessionId: 's8a', sessions: ['s8a'], cwd: 'C:\\p8a' },
      r8b: { focusSessionId: 's8b', sessions: ['s8b'], cwd: 'C:\\p8b' },
    },
  });
  const dispatcher = createMockDispatcher();
  const poller = createHealthPoller({
    sessionService,
    driverRegistry: createMockDriverRegistry(),
    dispatcher,
    pollIntervalMs: 50,
    exitAction: 'cancel',
    httpClient,
  });
  poller.start();
  poller.track('s8a', { opencodeSessionId: 'op8a', serverUrl: 'http://localhost:4096' });
  poller.track('s8b', { opencodeSessionId: 'op8b', serverUrl: 'http://localhost:4096' });
  assert.equal(poller.getTrackedSessions().length, 2);
  poller.stop();
  assert.equal(poller.getTrackedSessions().length, 0);
});

test('track 幂等：重复 track 同一 session 不创建多个定时器', async () => {
  const httpClient = createMockHttpClient([{ resp: { status: 200 } }]);
  const sessionService = createMockSessionService({
    sessions: { s9: { id: 's9', agent: 'opencode', agentRef: { opencodeSessionId: 'op9', serverUrl: 'http://localhost:4096' } } },
    routes: { r9: { focusSessionId: 's9', sessions: ['s9'], cwd: 'C:\\p9' } },
  });
  const dispatcher = createMockDispatcher();
  const poller = createHealthPoller({
    sessionService,
    driverRegistry: createMockDriverRegistry(),
    dispatcher,
    pollIntervalMs: 20,
    exitAction: 'cancel',
    httpClient,
  });
  poller.start();
  poller.track('s9', { opencodeSessionId: 'op9', serverUrl: 'http://localhost:4096' });
  poller.track('s9', { opencodeSessionId: 'op9', serverUrl: 'http://localhost:4096' });
  assert.equal(poller.getTrackedSessions().length, 1, 'only one tracker per session');
  poller.stop();
});

test('health 端点 URL 正确拼接', async () => {
  const httpClient = createMockHttpClient([{ resp: { status: 200 } }]);
  const sessionService = createMockSessionService({
    sessions: { s10: { id: 's10', agent: 'opencode', agentRef: { opencodeSessionId: 'op10', serverUrl: 'http://localhost:4096' } } },
    routes: { r10: { focusSessionId: 's10', sessions: ['s10'], cwd: 'C:\\p10' } },
  });
  const dispatcher = createMockDispatcher();
  const poller = createHealthPoller({
    sessionService,
    driverRegistry: createMockDriverRegistry(),
    dispatcher,
    pollIntervalMs: 10,
    exitAction: 'cancel',
    httpClient,
  });
  poller.start();
  poller.track('s10', { opencodeSessionId: 'op10', serverUrl: 'http://localhost:4096' });
  await sleep(20);
  const calls = httpClient.getCalls();
  assert.ok(calls.length >= 1);
  assert.equal(calls[0].method, 'GET');
  assert.match(calls[0].url, /\/global\/health/);
  poller.stop();
});
