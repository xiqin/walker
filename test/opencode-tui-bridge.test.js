'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { JsonStore } = require('../src/core/json-store');
const { SessionService } = require('../src/core/session-service');
const { AgentEvent } = require('../src/drivers/agent-driver');
const { OpencodeTuiBridge } = require('../src/opencode-tui-bridge/bridge');
const { createTuiBridgeRoutes } = require('../src/opencode-tui-bridge/routes');
const { createAdminServer } = require('../src/admin/server');

function createHarness() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-tui-bridge-'));
  const sessionService = new SessionService({
    stateStore: new JsonStore(path.join(tmpDir, 'state.json'), {}),
  });
  const bridge = new OpencodeTuiBridge({
    sessionService,
    promptTimeoutMs: 1000,
  });
  return {
    tmpDir,
    sessionService,
    bridge,
    cleanup() {
      bridge.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('OpencodeTuiBridge', () => {
  it('普通 TUI runtime 注册当前 session，并成为同 cwd route 的焦点', () => {
    const h = createHarness();
    try {
      const routeKey = 'feishu:oc_bridge:om_root';
      const cwd = 'H:\\walker';
      const oldSession = h.sessionService.createSession({
        route: routeKey,
        agent: 'opencode',
        cwd,
        agentRef: { opencodeSessionId: 'ses_server', serverUrl: 'http://localhost:4096' },
      });
      h.sessionService.setRouteCwd(routeKey, cwd);

      const result = h.bridge.register({
        runtimeId: 'runtime-1',
        sessionId: 'ses_embedded',
        cwd,
        opencodeVersion: '1.17.20',
      });

      assert.equal(result.routeKey, routeKey);
      assert.notEqual(result.sessionId, oldSession.id);
      const current = h.sessionService.getCurrent(routeKey);
      assert.equal(current.id, result.sessionId);
      assert.deepEqual(current.agentRef, {
        opencodeSessionId: 'ses_embedded',
        transport: 'tui-bridge',
        runtimeId: 'runtime-1',
      });
    } finally {
      h.cleanup();
    }
  });

  it('prompt 经 runtime 队列投递，并由 TUI 回传 AgentEvent 完成', async () => {
    const h = createHarness();
    try {
      h.sessionService.createSession({ route: 'feishu:oc_bridge2:om_root', cwd: 'H:\\walker' });
      h.sessionService.setRouteCwd('feishu:oc_bridge2:om_root', 'H:\\walker');
      const enrolled = h.bridge.register({ runtimeId: 'runtime-2', sessionId: 'ses_local', cwd: 'H:\\walker' });
      const session = h.sessionService.getSession(enrolled.sessionId);

      const promptPromise = h.bridge.prompt(session.agentRef, '来自飞书', { model: 'model-a' });
      const delivery = h.bridge.poll({ runtimeId: 'runtime-2', sessionId: 'ses_local' });

      assert.ok(delivery);
      assert.equal(delivery.sessionId, 'ses_local');
      assert.equal(delivery.text, '来自飞书');
      assert.equal(delivery.model, 'model-a');

      h.bridge.reportEvents({
        runtimeId: 'runtime-2',
        sessionId: 'ses_local',
        deliveryId: delivery.deliveryId,
        events: [
          { type: 'text', data: { text: '本地 TUI 回复' } },
          { type: 'done', data: { reason: 'idle' } },
        ],
      });

      const events = await promptPromise;
      assert.equal(events.length, 2);
      assert.ok(events[0] instanceof AgentEvent);
      assert.equal(events[0].type, AgentEvent.TYPE_TEXT);
      assert.equal(events[0].data.text, '本地 TUI 回复');
      assert.equal(events[1].type, AgentEvent.TYPE_DONE);
    } finally {
      h.cleanup();
    }
  });

  it('TUI 手工发起的 turn 通过 watchSession 回传飞书', () => {
    const h = createHarness();
    try {
      h.sessionService.createSession({ route: 'feishu:oc_bridge3:om_root', cwd: 'H:\\walker' });
      h.sessionService.setRouteCwd('feishu:oc_bridge3:om_root', 'H:\\walker');
      const enrolled = h.bridge.register({ runtimeId: 'runtime-3', sessionId: 'ses_manual', cwd: 'H:\\walker' });
      const session = h.sessionService.getSession(enrolled.sessionId);
      const received = [];
      const stop = h.bridge.watchSession(session.agentRef, { onEvent: (event) => received.push(event) });

      h.bridge.reportEvents({
        runtimeId: 'runtime-3',
        sessionId: 'ses_manual',
        events: [
          { type: 'text', data: { text: '终端手工消息的回复' } },
          { type: 'done', data: { reason: 'idle' } },
        ],
      });

      assert.deepEqual(received.map((event) => event.type), ['text', 'done']);
      assert.equal(received[0].data.text, '终端手工消息的回复');
      stop();
    } finally {
      h.cleanup();
    }
  });

  it('runtime 当前 session 已切换时拒绝向旧 session 投递', async () => {
    const h = createHarness();
    try {
      h.sessionService.createSession({ route: 'feishu:oc_bridge4:om_root', cwd: 'H:\\walker' });
      h.sessionService.setRouteCwd('feishu:oc_bridge4:om_root', 'H:\\walker');
      const first = h.bridge.register({ runtimeId: 'runtime-4', sessionId: 'ses_old', cwd: 'H:\\walker' });
      const oldRef = h.sessionService.getSession(first.sessionId).agentRef;
      h.bridge.register({ runtimeId: 'runtime-4', sessionId: 'ses_new', cwd: 'H:\\walker' });

      await assert.rejects(
        () => h.bridge.prompt(oldRef, '不应误投'),
        { message: /current session|当前会话/i },
      );
    } finally {
      h.cleanup();
    }
  });

  it('AdminServer 通过鉴权后的 bridge routes 注册和轮询 runtime', async () => {
    const h = createHarness();
    const config = { enabled: true, host: '127.0.0.1', port: 0, token: 'bridge-token' };
    const routes = createTuiBridgeRoutes({ bridge: h.bridge, config });
    const server = createAdminServer({
      config,
      routes(router, authGuard) {
        for (const route of routes) router.add(route.method, route.pattern, authGuard(route.handler));
      },
    });
    try {
      h.sessionService.createSession({ route: 'feishu:oc_bridge5:om_root', cwd: 'H:\\walker' });
      h.sessionService.setRouteCwd('feishu:oc_bridge5:om_root', 'H:\\walker');
      const started = await server.start();
      const unauthorized = await postJson(started.port, '/opencode/tui-bridge/register', {
        runtimeId: 'runtime-http', sessionId: 'ses_http', cwd: 'H:\\walker',
      });
      assert.equal(unauthorized.statusCode, 401);

      const registered = await postJson(started.port, '/opencode/tui-bridge/register', {
        runtimeId: 'runtime-http', sessionId: 'ses_http', cwd: 'H:\\walker',
      }, 'bridge-token');
      assert.equal(registered.statusCode, 200);
      assert.equal(registered.body.ok, true);

      const polled = await postJson(started.port, '/opencode/tui-bridge/poll', {
        runtimeId: 'runtime-http', sessionId: 'ses_http',
      }, 'bridge-token');
      assert.deepEqual(polled.body.data, { delivery: null });
    } finally {
      await server.stop();
      h.cleanup();
    }
  });
});

function postJson(port, requestPath, body, token) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) };
    if (token) headers.Authorization = 'Bearer ' + token;
    const req = http.request({ hostname: '127.0.0.1', port, path: requestPath, method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}
