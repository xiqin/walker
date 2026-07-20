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

function waitMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

      const promptPromise = h.bridge.prompt(session.agentRef, '来自飞书', { model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' } });
      const delivery = h.bridge.poll({ runtimeId: 'runtime-2', sessionId: 'ses_local' });

      assert.ok(delivery);
      assert.equal(delivery.sessionId, 'ses_local');
      assert.equal(delivery.text, '来自飞书');
      assert.deepEqual(delivery.model, { providerID: 'anthropic', modelID: 'claude-sonnet-4' });

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

  it('permission 事件通过 watchSession 分发到飞书（无 deliveryId 路径）', () => {
    const h = createHarness();
    try {
      h.sessionService.createSession({ route: 'feishu:oc_bridge_perm:om_root', cwd: 'H:\\walker' });
      h.sessionService.setRouteCwd('feishu:oc_bridge_perm:om_root', 'H:\\walker');
      const enrolled = h.bridge.register({ runtimeId: 'runtime-perm', sessionId: 'ses_perm', cwd: 'H:\\walker' });
      const session = h.sessionService.getSession(enrolled.sessionId);
      const received = [];
      const stop = h.bridge.watchSession(session.agentRef, { onEvent: (event) => received.push(event) });

      h.bridge.reportEvents({
        runtimeId: 'runtime-perm',
        sessionId: 'ses_perm',
        events: [
          { type: 'permission', data: { id: 'perm_1', type: 'command', title: '执行命令', metadata: { command: 'rm -rf /' } } },
          { type: 'permission_replied', data: { permissionId: 'perm_1', response: 'allow' } },
        ],
      });

      assert.equal(received.length, 2);
      assert.equal(received[0].type, 'permission');
      assert.equal(received[0].data.id, 'perm_1');
      assert.equal(received[0].data.title, '执行命令');
      assert.equal(received[1].type, 'permission_replied');
      assert.equal(received[1].data.permissionId, 'perm_1');
      assert.equal(received[1].data.response, 'allow');
      stop();
    } finally {
      h.cleanup();
    }
  });

  it('规范化原生 question asked、replied 和 rejected 事件', () => {
    const h = createHarness();
    try {
      h.sessionService.createSession({ route: 'feishu:oc_bridge_question:om_root', cwd: 'H:\\walker' });
      h.sessionService.setRouteCwd('feishu:oc_bridge_question:om_root', 'H:\\walker');
      const enrolled = h.bridge.register({ runtimeId: 'runtime-question', sessionId: 'ses_question', cwd: 'H:\\walker' });
      const session = h.sessionService.getSession(enrolled.sessionId);
      const received = [];
      const stop = h.bridge.watchSession(session.agentRef, { onEvent: (event) => received.push(event) });

      h.bridge.reportEvents({
        runtimeId: 'runtime-question',
        sessionId: 'ses_question',
        events: [
          { type: 'question_asked', data: { requestID: 'req_1', sessionID: 'ses_question', questions: [] } },
          { type: 'question_replied', data: { requestID: 'req_1', sessionID: 'ses_question', answers: [['yes']] } },
          { type: 'question_rejected', data: { requestID: 'req_1', sessionID: 'ses_question' } },
        ],
      });

      assert.deepEqual(received.map((event) => event.type), [
        'question_asked', 'question_replied', 'question_rejected',
      ]);
      assert.deepEqual(received[1].data.answers, [['yes']]);
      stop();
    } finally {
      h.cleanup();
    }
  });

  it('todo/file_edited/compacted/command_executed 事件通过 watchSession 分发（无 deliveryId 路径）', () => {
    const h = createHarness();
    try {
      h.sessionService.createSession({ route: 'feishu:oc_bridge_evt:om_root', cwd: 'H:\\walker' });
      h.sessionService.setRouteCwd('feishu:oc_bridge_evt:om_root', 'H:\\walker');
      const enrolled = h.bridge.register({ runtimeId: 'runtime-evt', sessionId: 'ses_evt', cwd: 'H:\\walker' });
      const session = h.sessionService.getSession(enrolled.sessionId);
      const received = [];
      const stop = h.bridge.watchSession(session.agentRef, { onEvent: (event) => received.push(event) });

      h.bridge.reportEvents({
        runtimeId: 'runtime-evt',
        sessionId: 'ses_evt',
        events: [
          { type: 'todo', data: { todos: [{ id: 't1', status: 'completed' }, { id: 't2', status: 'in_progress' }] } },
          { type: 'file_edited', data: { path: 'src/index.js', action: 'edit', linesAdded: 10, linesRemoved: 2 } },
          { type: 'compacted', data: { sessionID: 'ses_evt' } },
          { type: 'command_executed', data: { command: 'npm test', exitCode: 0 } },
        ],
      });

      assert.equal(received.length, 4);
      assert.equal(received[0].type, 'todo');
      assert.equal(received[0].data.todos.length, 2);
      assert.equal(received[1].type, 'file_edited');
      assert.equal(received[1].data.path, 'src/index.js');
      assert.equal(received[1].data.linesAdded, 10);
      assert.equal(received[2].type, 'compacted');
      assert.equal(received[2].data.sessionID, 'ses_evt');
      assert.equal(received[3].type, 'command_executed');
      assert.equal(received[3].data.command, 'npm test');
      assert.equal(received[3].data.exitCode, 0);
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

describe('OpencodeTuiBridge clearSession', () => {
  function setupClearHarness(opts) {
    opts = opts || {};
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-tui-clear-'));
    const sessionService = new SessionService({
      stateStore: new JsonStore(path.join(tmpDir, 'state.json'), {}),
    });
    const enrolled = [];
    const bridge = new OpencodeTuiBridge({
      sessionService,
      promptTimeoutMs: opts.promptTimeoutMs || 1000,
      runtimeStaleMs: opts.runtimeStaleMs || 10000,
      onSessionEnrolled: (info) => enrolled.push(info),
    });
    const routeKey = opts.routeKey || 'feishu:oc_clear:om_root';
    const cwd = opts.cwd || 'H:\\walker';
    sessionService.setRouteCwd(routeKey, cwd);
    const oldSession = opts.oldSession || sessionService.createSession({
      route: routeKey,
      agent: 'opencode',
      cwd,
      agentRef: { opencodeSessionId: 'ses_old', serverUrl: 'http://localhost:4096' },
    });
    const reg = bridge.register({
      runtimeId: 'runtime-clear',
      sessionId: 'ses_old',
      cwd,
      opencodeVersion: '1.17.20',
      bridgeProtocolVersion: 2,
    });
    if (opts.oldModel) {
      sessionService.updateSessionField(reg.sessionId, 'model', opts.oldModel);
    }
    enrolled.length = 0;
    const runtime = bridge.runtimes.get('runtime-clear');
    runtime.opencodeVersion = runtime.opencodeVersion || '1.17.20';
    const tuiSession = sessionService.getSession(reg.sessionId);
    return {
      tmpDir, sessionService, bridge, enrolled, routeKey, cwd, oldSession, tuiSession, runtime,
      cleanup() {
        bridge.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      },
    };
  }

  it('clearSession 投递 clear 控制并等待新 session 注册', async () => {
    const h = setupClearHarness();
    try {
      const clearPromise = h.bridge.clearSession(h.tuiSession.agentRef);
      const delivery = h.bridge.poll({ runtimeId: 'runtime-clear', sessionId: 'ses_old' });
      assert.ok(delivery, '应投递 clear delivery');
      assert.equal(delivery.type, 'clear');
      assert.equal(delivery.sessionId, 'ses_old');
      assert.ok(delivery.deliveryId, '应携带 deliveryId');

      h.bridge.register({
        runtimeId: 'runtime-clear',
        sessionId: 'ses_new',
        cwd: h.cwd,
        controlDeliveryId: delivery.deliveryId,
      });
      h.bridge.reportEvents({
        runtimeId: 'runtime-clear',
        sessionId: 'ses_old',
        deliveryId: delivery.deliveryId,
        control: { type: 'clear', newSessionId: 'ses_new' },
      });

      const result = await clearPromise;
      assert.equal(result.runtimeId, 'runtime-clear');
      assert.equal(result.oldSessionId, 'ses_old');
      assert.equal(result.newSessionId, 'ses_new');
      assert.ok(result.walkerSessionId, '应返回新 walker session id');

      const current = h.sessionService.getCurrent(h.routeKey);
      assert.equal(current.agentRef.opencodeSessionId, 'ses_new');
      const runtime = h.bridge.runtimes.get('runtime-clear');
      assert.equal(runtime.currentSessionId, 'ses_new');
      assert.equal(h.enrolled.length, 1);
      assert.equal(h.enrolled[0].sessionId, result.walkerSessionId);
      assert.equal(h.enrolled[0].routeKey, h.routeKey);
    } finally {
      h.cleanup();
    }
  });

  it('旧版 TUI plugin 不支持 clear 时立即拒绝且不投递空 prompt', async () => {
    const h = setupClearHarness();
    try {
      delete h.runtime.bridgeProtocolVersion;

      await assert.rejects(
        () => h.bridge.clearSession(h.tuiSession.agentRef),
        { message: /restart.*OpenCode TUI|重启.*TUI|plugin/i },
      );

      assert.equal(h.runtime.queue.length, 0, '不应向旧插件投递 clear delivery');
      assert.equal(h.bridge._clearPending.size, 0, '不应创建 clear pending');
    } finally {
      h.cleanup();
    }
  });

  it('control 先到与 register 先到均只在汇合后更新原 route 焦点', async () => {
    for (const order of ['control-first', 'register-first']) {
      const h = setupClearHarness();
      try {
        const clearPromise = h.bridge.clearSession(h.tuiSession.agentRef);
        const delivery = h.bridge.poll({ runtimeId: 'runtime-clear', sessionId: 'ses_old' });

        const currentBefore = h.sessionService.getCurrent(h.routeKey);
        assert.equal(currentBefore.agentRef.opencodeSessionId, 'ses_old',
          order + ': clear 完成前原 route 焦点应保持旧 session');
        assert.equal(h.bridge.runtimes.get('runtime-clear').currentSessionId, 'ses_old',
          order + ': clear 完成前 runtime 当前 session 应保持旧 session');

        if (order === 'control-first') {
          h.bridge.reportEvents({
            runtimeId: 'runtime-clear',
            sessionId: 'ses_old',
            deliveryId: delivery.deliveryId,
            control: { type: 'clear', newSessionId: 'ses_new' },
          });
          const currentMid = h.sessionService.getCurrent(h.routeKey);
          assert.equal(currentMid.agentRef.opencodeSessionId, 'ses_old',
            'control 先到时 register 未完成，焦点不得提前切换');
          h.bridge.register({
            runtimeId: 'runtime-clear',
            sessionId: 'ses_new',
            cwd: h.cwd,
            controlDeliveryId: delivery.deliveryId,
          });
        } else {
          h.bridge.register({
            runtimeId: 'runtime-clear',
            sessionId: 'ses_new',
            cwd: h.cwd,
            controlDeliveryId: delivery.deliveryId,
          });
          const currentMid = h.sessionService.getCurrent(h.routeKey);
          assert.equal(currentMid.agentRef.opencodeSessionId, 'ses_old',
            'register 先到时 control 未完成，焦点不得提前切换');
          h.bridge.reportEvents({
            runtimeId: 'runtime-clear',
            sessionId: 'ses_old',
            deliveryId: delivery.deliveryId,
            control: { type: 'clear', newSessionId: 'ses_new' },
          });
        }

        const result = await clearPromise;
        assert.equal(result.newSessionId, 'ses_new');
        const current = h.sessionService.getCurrent(h.routeKey);
        assert.equal(current.agentRef.opencodeSessionId, 'ses_new',
          order + ': 汇合后焦点应切换到新 session');
        assert.equal(h.bridge.runtimes.get('runtime-clear').currentSessionId, 'ses_new',
          order + ': 汇合后 runtime 当前 session 应更新');
      } finally {
        h.cleanup();
      }
    }
  });

  it('clear 完成后旧 session 仍可查询和聚焦', async () => {
    const h = setupClearHarness();
    try {
      const clearPromise = h.bridge.clearSession(h.tuiSession.agentRef);
      const delivery = h.bridge.poll({ runtimeId: 'runtime-clear', sessionId: 'ses_old' });
      h.bridge.register({
        runtimeId: 'runtime-clear', sessionId: 'ses_new', cwd: h.cwd, controlDeliveryId: delivery.deliveryId,
      });
      h.bridge.reportEvents({
        runtimeId: 'runtime-clear', sessionId: 'ses_old', deliveryId: delivery.deliveryId,
        control: { type: 'clear', newSessionId: 'ses_new' },
      });
      await clearPromise;

      const routeSessions = h.sessionService.listSessionsInRoute(h.routeKey);
      const oldInRoute = routeSessions.find((s) => s.id === h.oldSession.id);
      assert.ok(oldInRoute, '旧 Walker session 应仍在 route 中');
      const oldStill = h.sessionService.getSession(h.oldSession.id);
      assert.ok(oldStill, '旧 Walker session 不应被删除');
      assert.notEqual(oldStill.status, 'deleted');

      h.sessionService.setFocus(h.routeKey, h.oldSession.id);
      const restored = h.sessionService.getCurrent(h.routeKey);
      assert.equal(restored.id, h.oldSession.id, '旧 session 应可重新聚焦');
    } finally {
      h.cleanup();
    }
  });

  it('新 Walker session 继承旧模型与关联注册 cwd', async () => {
    const h = setupClearHarness({ oldModel: { providerID: 'cpa', modelID: 'gpt-5-custom' }, cwd: 'D:\\projects\\alpha' });
    try {
      const clearPromise = h.bridge.clearSession(h.tuiSession.agentRef);
      const delivery = h.bridge.poll({ runtimeId: 'runtime-clear', sessionId: 'ses_old' });
      const newCwd = 'D:\\projects\\alpha\\sub';
      h.bridge.register({
        runtimeId: 'runtime-clear', sessionId: 'ses_new', cwd: newCwd, controlDeliveryId: delivery.deliveryId,
      });
      h.bridge.reportEvents({
        runtimeId: 'runtime-clear', sessionId: 'ses_old', deliveryId: delivery.deliveryId,
        control: { type: 'clear', newSessionId: 'ses_new' },
      });
      const result = await clearPromise;

      const newWalker = h.sessionService.getSession(result.walkerSessionId);
      assert.deepEqual(newWalker.model, { providerID: 'cpa', modelID: 'gpt-5-custom' }, '应继承旧 session 模型');
      assert.equal(newWalker.cwd, newCwd, '应使用关联 register 上报的 cwd');
      assert.deepEqual(newWalker.agentRef, {
        opencodeSessionId: 'ses_new', transport: 'tui-bridge', runtimeId: 'runtime-clear',
      });
    } finally {
      h.cleanup();
    }
  });

  it('clearSession 拒绝无效 transport、stale runtime、旧 session 和并发 clear', async () => {
    const h = setupClearHarness();
    try {
      await assert.rejects(
        () => h.bridge.clearSession({ opencodeSessionId: 'ses_old', transport: 'http', serverUrl: 'x' }),
        /transport=tui-bridge/i,
      );

      const runtime = h.bridge.runtimes.get('runtime-clear');
      runtime.lastSeenAt = Date.now() - 999999;
      await assert.rejects(
        () => h.bridge.clearSession(h.tuiSession.agentRef),
        /stale|连接失效|connection/i,
      );
      runtime.lastSeenAt = Date.now();

      const staleRef = { ...h.tuiSession.agentRef, opencodeSessionId: 'ses_other' };
      await assert.rejects(
        () => h.bridge.clearSession(staleRef),
        /current session|当前会话|has changed/i,
      );

      const first = h.bridge.clearSession(h.tuiSession.agentRef);
      await assert.rejects(
        () => h.bridge.clearSession(h.tuiSession.agentRef),
        /clear|pending|在途/i,
      );
      const delivery = h.bridge.poll({ runtimeId: 'runtime-clear', sessionId: 'ses_old' });
      h.bridge.register({
        runtimeId: 'runtime-clear', sessionId: 'ses_new', cwd: h.cwd, controlDeliveryId: delivery.deliveryId,
      });
      h.bridge.reportEvents({
        runtimeId: 'runtime-clear', sessionId: 'ses_old', deliveryId: delivery.deliveryId,
        control: { type: 'clear', newSessionId: 'ses_new' },
      });
      await first;
    } finally {
      h.cleanup();
    }
  });

  it('clear 错误和超时不切换焦点并清理 pending', async () => {
    const h = setupClearHarness({ promptTimeoutMs: 50 });
    try {
      const errorPromise = h.bridge.clearSession(h.tuiSession.agentRef);
      const delivery = h.bridge.poll({ runtimeId: 'runtime-clear', sessionId: 'ses_old' });
      h.bridge.reportEvents({
        runtimeId: 'runtime-clear', sessionId: 'ses_old', deliveryId: delivery.deliveryId,
        error: 'SDK create failed',
      });
      await assert.rejects(errorPromise, /SDK create failed|clear/i);

      const current = h.sessionService.getCurrent(h.routeKey);
      assert.equal(current.agentRef.opencodeSessionId, 'ses_old', '错误后焦点不得切换');
      assert.equal(h.bridge._clearPending.size, 0, '错误后 pending 应清理');

      const timeoutPromise = h.bridge.clearSession(h.tuiSession.agentRef);
      h.bridge.poll({ runtimeId: 'runtime-clear', sessionId: 'ses_old' });
      await assert.rejects(timeoutPromise, /timed out|超时/i);
      const currentAfterTimeout = h.sessionService.getCurrent(h.routeKey);
      assert.equal(currentAfterTimeout.agentRef.opencodeSessionId, 'ses_old', '超时后焦点不得切换');
      assert.equal(h.bridge._clearPending.size, 0, '超时后 pending 应清理');
      assert.equal(h.bridge.runtimes.get('runtime-clear').currentSessionId, 'ses_old', '超时后 runtime 当前 session 不变');
    } finally {
      h.cleanup();
    }
  });

  it('普通 register 不完成 clear pending 且不切换焦点', async () => {
    const h = setupClearHarness();
    try {
      const clearPromise = h.bridge.clearSession(h.tuiSession.agentRef);
      const delivery = h.bridge.poll({ runtimeId: 'runtime-clear', sessionId: 'ses_old' });

      h.bridge.register({
        runtimeId: 'runtime-clear', sessionId: 'ses_other', cwd: h.cwd,
      });
      const current = h.sessionService.getCurrent(h.routeKey);
      assert.equal(current.agentRef.opencodeSessionId, 'ses_other',
        '普通 register 应正常创建/聚焦新 session（与 clear 无关）');

      const routeSessions = h.sessionService.listSessionsInRoute(h.routeKey);
      assert.ok(routeSessions.find((s) => s.agentRef && s.agentRef.opencodeSessionId === 'ses_other'),
        '普通 register session 应加入 route');

      h.bridge.reportEvents({
        runtimeId: 'runtime-clear', sessionId: 'ses_old', deliveryId: delivery.deliveryId,
        control: { type: 'clear', newSessionId: 'ses_new' },
      });
      h.bridge.register({
        runtimeId: 'runtime-clear', sessionId: 'ses_new', cwd: h.cwd, controlDeliveryId: delivery.deliveryId,
      });
      const result = await clearPromise;
      assert.equal(result.newSessionId, 'ses_new', 'clear 仍可在普通 register 后完成');
      const finalCurrent = h.sessionService.getCurrent(h.routeKey);
      assert.equal(finalCurrent.agentRef.opencodeSessionId, 'ses_new');
    } finally {
      h.cleanup();
    }
  });

  it('未知 controlDeliveryId 的 register 被拒绝且不回退为普通注册', async () => {
    const h = setupClearHarness();
    try {
      assert.throws(
        () => h.bridge.register({
          runtimeId: 'runtime-clear', sessionId: 'ses_unknown', cwd: h.cwd, controlDeliveryId: 'del_nonexistent',
        }),
        /unknown|controlDeliveryId|关联|过期|expired/i,
      );
      const exists = h.sessionService.listSessions().find((s) => s.agentRef && s.agentRef.opencodeSessionId === 'ses_unknown');
      assert.equal(exists, undefined, '未知关联 ID 的 register 不得创建 Walker session');
      const current = h.sessionService.getCurrent(h.routeKey);
      assert.equal(current.agentRef.opencodeSessionId, 'ses_old', '未知关联 register 不得改变焦点');
    } finally {
      h.cleanup();
    }
  });

  it('迟到 control 在 pending 清理后不提交焦点', async () => {
    const h = setupClearHarness({ promptTimeoutMs: 30 });
    try {
      const clearPromise = h.bridge.clearSession(h.tuiSession.agentRef);
      const delivery = h.bridge.poll({ runtimeId: 'runtime-clear', sessionId: 'ses_old' });
      await assert.rejects(clearPromise, /timed out|超时/i);
      assert.equal(h.bridge._clearPending.size, 0);

      assert.throws(
        () => h.bridge.reportEvents({
          runtimeId: 'runtime-clear', sessionId: 'ses_old', deliveryId: delivery.deliveryId,
          control: { type: 'clear', newSessionId: 'ses_new' },
        }),
        /unknown|过期|expired|delivery/i,
      );
      const current = h.sessionService.getCurrent(h.routeKey);
      assert.equal(current.agentRef.opencodeSessionId, 'ses_old', '迟到 control 不得切换焦点');
    } finally {
      h.cleanup();
    }
  });

  it('迟到关联 register 在 pending 清理后被拒绝且不改变焦点', async () => {
    const h = setupClearHarness({ promptTimeoutMs: 30 });
    try {
      const clearPromise = h.bridge.clearSession(h.tuiSession.agentRef);
      const delivery = h.bridge.poll({ runtimeId: 'runtime-clear', sessionId: 'ses_old' });
      await assert.rejects(clearPromise, /timed out|超时/i);

      assert.throws(
        () => h.bridge.register({
          runtimeId: 'runtime-clear', sessionId: 'ses_new', cwd: h.cwd, controlDeliveryId: delivery.deliveryId,
        }),
        /unknown|过期|expired|controlDeliveryId/i,
      );
      const exists = h.sessionService.listSessions().find((s) => s.agentRef && s.agentRef.opencodeSessionId === 'ses_new');
      assert.equal(exists, undefined, '迟到关联 register 不得创建 Walker session');
      const current = h.sessionService.getCurrent(h.routeKey);
      assert.equal(current.agentRef.opencodeSessionId, 'ses_old', '迟到 register 不得改变焦点');
    } finally {
      h.cleanup();
    }
  });

  it('close 清理所有 clear pending 且不切换焦点', async () => {
    const h = setupClearHarness();
    let clearPromise;
    try {
      clearPromise = h.bridge.clearSession(h.tuiSession.agentRef);
      h.bridge.poll({ runtimeId: 'runtime-clear', sessionId: 'ses_old' });
      assert.equal(h.bridge._clearPending.size, 1, '应有 clear pending');
    } finally {
      h.bridge.close();
      await assert.rejects(clearPromise, /closed|关闭/i);
      fs.rmSync(h.tmpDir, { recursive: true, force: true });
    }
  });

  it('cancel 清理相关 clear pending', async () => {
    const h = setupClearHarness();
    try {
      const clearPromise = h.bridge.clearSession(h.tuiSession.agentRef);
      h.bridge.poll({ runtimeId: 'runtime-clear', sessionId: 'ses_old' });
      assert.equal(h.bridge._clearPending.size, 1);
      h.bridge.cancel(h.tuiSession.agentRef);
      await assert.rejects(clearPromise, /cancel/i);
      assert.equal(h.bridge._clearPending.size, 0);
      const current = h.sessionService.getCurrent(h.routeKey);
      assert.equal(current.agentRef.opencodeSessionId, 'ses_old');
    } finally {
      h.cleanup();
    }
  });

  it('dispose 清理 runtime 的 clear pending', async () => {
    const h = setupClearHarness();
    let clearPromise;
    try {
      clearPromise = h.bridge.clearSession(h.tuiSession.agentRef);
      h.bridge.poll({ runtimeId: 'runtime-clear', sessionId: 'ses_old' });
      assert.equal(h.bridge._clearPending.size, 1);
    } finally {
      h.bridge.dispose({ runtimeId: 'runtime-clear' });
      await assert.rejects(clearPromise, /dispose|closed|cancel/i);
      fs.rmSync(h.tmpDir, { recursive: true, force: true });
    }
  });

  it('prompt delivery 显式携带 type=prompt', async () => {
    const h = setupClearHarness();
    try {
      const promptPromise = h.bridge.prompt(h.tuiSession.agentRef, 'hello');
      const delivery = h.bridge.poll({ runtimeId: 'runtime-clear', sessionId: 'ses_old' });
      assert.equal(delivery.type, 'prompt');
      h.bridge.reportEvents({
        runtimeId: 'runtime-clear', sessionId: 'ses_old', deliveryId: delivery.deliveryId,
        events: [{ type: 'done', data: { reason: 'idle' } }],
      });
      await promptPromise;
    } finally {
      h.cleanup();
    }
  });
});

describe('OpencodeTuiBridge v3 lease and tombstone', () => {
  function setupV3Harness(opts) {
    opts = opts || {};
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-tui-v3-'));
    const sessionService = new SessionService({
      stateStore: new JsonStore(path.join(tmpDir, 'state.json'), {}),
    });
    const bridge = new OpencodeTuiBridge({
      sessionService,
      leaseTimeoutMs: opts.leaseTimeoutMs || 90,
      heartbeatIntervalMs: opts.heartbeatIntervalMs || 30,
      tombstoneCapacity: opts.tombstoneCapacity || 100,
      tombstoneTtlMs: opts.tombstoneTtlMs || 300000,
      promptTimeoutMs: opts.promptTimeoutMs || 1000,
      runtimeStaleMs: opts.runtimeStaleMs || 10000,
    });
    const routeKey = opts.routeKey || 'feishu:oc_v3:om_root';
    const cwd = opts.cwd || 'H:\\walker';
    sessionService.setRouteCwd(routeKey, cwd);
    const reg = bridge.register({
      runtimeId: 'runtime-v3',
      sessionId: 'ses_v3',
      cwd,
      opencodeVersion: '1.17.20',
      bridgeProtocolVersion: 3,
    });
    const tuiSession = sessionService.getSession(reg.sessionId);
    return {
      tmpDir, sessionService, bridge, routeKey, cwd, tuiSession,
      cleanup() {
        bridge.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      },
    };
  }

  it('prompt 创建 queued 状态的 pending，无固定总超时 timer', () => {
    const h = setupV3Harness();
    try {
      const promptPromise = h.bridge.prompt(h.tuiSession.agentRef, 'hello v3');
      const delivery = h.bridge.poll({ runtimeId: 'runtime-v3', sessionId: 'ses_v3' });
      assert.ok(delivery, '应投递 delivery');
      const pending = h.bridge.pending.get(delivery.deliveryId);
      assert.equal(pending.state, 'queued');
      assert.equal(pending.timer, null);
      assert.equal(pending.leaseStartedAt, null);
      h.bridge.reportEvents({
        runtimeId: 'runtime-v3',
        sessionId: 'ses_v3',
        deliveryId: delivery.deliveryId,
        events: [{ type: 'done', data: { reason: 'idle' } }],
      });
      return promptPromise;
    } finally {
      h.cleanup();
    }
  });

  it('accepted 将 queued 转为 leased 并启动租约 timer', async () => {
    const h = setupV3Harness({ leaseTimeoutMs: 200 });
    try {
      const promptPromise = h.bridge.prompt(h.tuiSession.agentRef, 'lease test');
      const delivery = h.bridge.poll({ runtimeId: 'runtime-v3', sessionId: 'ses_v3' });
      const pendingBefore = h.bridge.pending.get(delivery.deliveryId);
      assert.equal(pendingBefore.state, 'queued');
      assert.equal(pendingBefore.timer, null);

      const result = h.bridge.reportEvents({
        runtimeId: 'runtime-v3',
        sessionId: 'ses_v3',
        deliveryId: delivery.deliveryId,
        deliveryState: 'accepted',
      });
      assert.deepEqual(result, { delivered: true });

      const pendingAfter = h.bridge.pending.get(delivery.deliveryId);
      assert.equal(pendingAfter.state, 'leased');
      assert.ok(pendingAfter.leaseStartedAt, '应设置 leaseStartedAt');
      assert.ok(pendingAfter.timer, '应启动租约 timer');

      h.bridge.reportEvents({
        runtimeId: 'runtime-v3',
        sessionId: 'ses_v3',
        deliveryId: delivery.deliveryId,
        events: [{ type: 'done', data: { reason: 'idle' } }],
      });
      await promptPromise;
    } finally {
      h.cleanup();
    }
  });

  it('heartbeat 续租：清除旧 timer 并重启新 lease timer', async () => {
    const h = setupV3Harness({ leaseTimeoutMs: 500 });
    try {
      const promptPromise = h.bridge.prompt(h.tuiSession.agentRef, 'heartbeat test');
      const delivery = h.bridge.poll({ runtimeId: 'runtime-v3', sessionId: 'ses_v3' });

      h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: delivery.deliveryId, deliveryState: 'accepted',
      });

      const pendingAfterAccept = h.bridge.pending.get(delivery.deliveryId);
      const timerAfterAccept = pendingAfterAccept.timer;
      assert.ok(timerAfterAccept);

      const hbResult = h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: delivery.deliveryId, deliveryState: 'heartbeat',
      });
      assert.deepEqual(hbResult, { delivered: true });

      const pendingAfterHb = h.bridge.pending.get(delivery.deliveryId);
      assert.equal(pendingAfterHb.state, 'leased');
      assert.notEqual(pendingAfterHb.timer, timerAfterAccept, 'timer 应被替换');

      h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: delivery.deliveryId,
        events: [{ type: 'done', data: { reason: 'idle' } }],
      });
      await promptPromise;
    } finally {
      h.cleanup();
    }
  });

  it('租约超时触发 _loseLease，reject prompt 并创建 transport_lost tombstone', async () => {
    const h = setupV3Harness({ leaseTimeoutMs: 30 });
    try {
      const promptPromise = h.bridge.prompt(h.tuiSession.agentRef, 'lease expire');
      const delivery = h.bridge.poll({ runtimeId: 'runtime-v3', sessionId: 'ses_v3' });

      h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: delivery.deliveryId, deliveryState: 'accepted',
      });

      await assert.rejects(promptPromise, /TUI_RUNTIME_DISCONNECTED/);

      assert.equal(h.bridge.pending.size, 0, 'pending 应已清理');
      const tombstone = h.bridge._tombstones.get(delivery.deliveryId);
      assert.ok(tombstone, '应有 tombstone');
      assert.equal(tombstone.reason, 'transport_lost');
    } finally {
      h.cleanup();
    }
  });

  it('迟到 final 在 transport_lost tombstone 上转交事件到 watchers（至多一次）', async () => {
    const h = setupV3Harness({ leaseTimeoutMs: 30 });
    try {
      const promptPromise = h.bridge.prompt(h.tuiSession.agentRef, 'late final');
      const delivery = h.bridge.poll({ runtimeId: 'runtime-v3', sessionId: 'ses_v3' });

      h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: delivery.deliveryId, deliveryState: 'accepted',
      });

      await assert.rejects(promptPromise, /TUI_RUNTIME_DISCONNECTED/);

      const received = [];
      const stop = h.bridge.watchSession(h.tuiSession.agentRef, {
        onEvent: (event) => received.push(event),
      });

      const result1 = h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: delivery.deliveryId,
        events: [{ type: 'text', data: { text: '迟到的回复' } }],
      });
      assert.deepEqual(result1, { delivered: true, recovered: true });
      assert.equal(received.length, 1);
      assert.equal(received[0].data.text, '迟到的回复');

      const result2 = h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: delivery.deliveryId,
        events: [{ type: 'text', data: { text: '再次迟到' } }],
      });
      assert.deepEqual(result2, { delivered: true, duplicate: true });
      assert.equal(received.length, 1, '至多恢复一次');

      stop();
    } finally {
      h.cleanup();
    }
  });

  it('completed tombstone 对迟到 final 幂等返回 duplicate', async () => {
    const h = setupV3Harness();
    try {
      const promptPromise = h.bridge.prompt(h.tuiSession.agentRef, 'dup test');
      const delivery = h.bridge.poll({ runtimeId: 'runtime-v3', sessionId: 'ses_v3' });

      h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: delivery.deliveryId,
        events: [{ type: 'done', data: { reason: 'idle' } }],
      });
      await promptPromise;

      const result = h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: delivery.deliveryId,
        events: [{ type: 'done', data: { reason: 'idle' } }],
      });
      assert.deepEqual(result, { delivered: true, duplicate: true });
    } finally {
      h.cleanup();
    }
  });

  it('cancelled tombstone 对迟到 final 返回 suppressed', async () => {
    const h = setupV3Harness();
    try {
      const promptPromise = h.bridge.prompt(h.tuiSession.agentRef, 'cancel test');
      const delivery = h.bridge.poll({ runtimeId: 'runtime-v3', sessionId: 'ses_v3' });

      h.bridge.cancel(h.tuiSession.agentRef);
      await assert.rejects(promptPromise, /cancel/);

      const result = h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: delivery.deliveryId,
        events: [{ type: 'done', data: { reason: 'idle' } }],
      });
      assert.deepEqual(result, { delivered: true, suppressed: true });
    } finally {
      h.cleanup();
    }
  });

  it('AbortSignal 取消 prompt 进入 cancelled tombstone', async () => {
    const h = setupV3Harness();
    try {
      const ac = new AbortController();
      const promptPromise = h.bridge.prompt(h.tuiSession.agentRef, 'abort test', { signal: ac.signal });
      const delivery = h.bridge.poll({ runtimeId: 'runtime-v3', sessionId: 'ses_v3' });
      assert.ok(delivery);

      ac.abort();

      await assert.rejects(promptPromise, /cancel/);
      assert.equal(h.bridge.pending.size, 0);
      const tombstone = h.bridge._tombstones.get(delivery.deliveryId);
      assert.ok(tombstone);
      assert.equal(tombstone.reason, 'cancelled');

      const result = h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: delivery.deliveryId,
        events: [{ type: 'done', data: { reason: 'idle' } }],
      });
      assert.deepEqual(result, { delivered: true, suppressed: true });
    } finally {
      h.cleanup();
    }
  });

  it('已 abort 的 signal 传入 prompt 立即拒绝并创建 cancelled tombstone', async () => {
    const h = setupV3Harness();
    try {
      const ac = new AbortController();
      ac.abort();

      await assert.rejects(
        () => h.bridge.prompt(h.tuiSession.agentRef, 'pre-abort', { signal: ac.signal }),
        /cancel/,
      );
    } finally {
      h.cleanup();
    }
  });

  it('cancel 将 pending 移到 cancelled tombstone 并清理 timer', async () => {
    const h = setupV3Harness({ leaseTimeoutMs: 500 });
    try {
      const promptPromise = h.bridge.prompt(h.tuiSession.agentRef, 'cancel pending');
      const delivery = h.bridge.poll({ runtimeId: 'runtime-v3', sessionId: 'ses_v3' });

      h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: delivery.deliveryId, deliveryState: 'accepted',
      });
      const pending = h.bridge.pending.get(delivery.deliveryId);
      assert.equal(pending.state, 'leased');
      assert.ok(pending.timer);

      h.bridge.cancel(h.tuiSession.agentRef);
      await assert.rejects(promptPromise, /cancel/);
      assert.equal(h.bridge.pending.size, 0);
      const tombstone = h.bridge._tombstones.get(delivery.deliveryId);
      assert.ok(tombstone);
      assert.equal(tombstone.reason, 'cancelled');
    } finally {
      h.cleanup();
    }
  });

  it('dispose 将所有 pending 移到 transport_lost tombstone', async () => {
    const h = setupV3Harness({ leaseTimeoutMs: 500 });
    try {
      const p1 = h.bridge.prompt(h.tuiSession.agentRef, 'dispose test 1');
      const d1 = h.bridge.poll({ runtimeId: 'runtime-v3', sessionId: 'ses_v3' });
      h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: d1.deliveryId, deliveryState: 'accepted',
      });

      const p2 = h.bridge.prompt(h.tuiSession.agentRef, 'dispose test 2');
      const d2 = h.bridge.poll({ runtimeId: 'runtime-v3', sessionId: 'ses_v3' });

      h.bridge.dispose({ runtimeId: 'runtime-v3' });

      await assert.rejects(p1, /dispose/);
      await assert.rejects(p2, /dispose/);

      const ts1 = h.bridge._tombstones.get(d1.deliveryId);
      assert.ok(ts1);
      assert.equal(ts1.reason, 'transport_lost');
      assert.equal(ts1.deliveryId, d1.deliveryId);

      const ts2 = h.bridge._tombstones.get(d2.deliveryId);
      assert.ok(ts2);
      assert.equal(ts2.reason, 'transport_lost');
    } finally {
      h.cleanup();
    }
  });

  it('tombstone 容量超限时淘汰最老的', () => {
    const h = setupV3Harness({ tombstoneCapacity: 3 });
    try {
      const deliveryIds = [];
      for (let i = 0; i < 5; i++) {
        h.bridge.prompt(h.tuiSession.agentRef, 'cap ' + i);
        const d = h.bridge.poll({ runtimeId: 'runtime-v3', sessionId: 'ses_v3' });
        deliveryIds.push(d.deliveryId);
        h.bridge.reportEvents({
          runtimeId: 'runtime-v3', sessionId: 'ses_v3',
          deliveryId: d.deliveryId,
          events: [{ type: 'done', data: { reason: 'idle' } }],
        });
      }

      assert.ok(!h.bridge._tombstones.has(deliveryIds[0]), '最老 tombstone 应被淘汰');
      assert.ok(!h.bridge._tombstones.has(deliveryIds[1]), '第二老 tombstone 应被淘汰');
      assert.ok(h.bridge._tombstones.has(deliveryIds[2]));
      assert.ok(h.bridge._tombstones.has(deliveryIds[3]));
      assert.ok(h.bridge._tombstones.has(deliveryIds[4]));
      assert.equal(h.bridge._tombstones.size, 3);
    } finally {
      h.cleanup();
    }
  });

  it('tombstone 过期后自动清理', async () => {
    const h = setupV3Harness({ tombstoneTtlMs: 30 });
    try {
      const p = h.bridge.prompt(h.tuiSession.agentRef, 'ttl test');
      const d = h.bridge.poll({ runtimeId: 'runtime-v3', sessionId: 'ses_v3' });
      h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: d.deliveryId,
        events: [{ type: 'done', data: { reason: 'idle' } }],
      });
      await p;

      assert.ok(h.bridge._tombstones.has(d.deliveryId), '应存在 tombstone');
      await new Promise((r) => setTimeout(r, 50));
      h.bridge._evictTombstones();
      assert.ok(!h.bridge._tombstones.has(d.deliveryId), '过期 tombstone 应被清理');
    } finally {
      h.cleanup();
    }
  });

  it('accepted 拒绝非 queued 状态的 delivery', async () => {
    const h = setupV3Harness();
    try {
      const p = h.bridge.prompt(h.tuiSession.agentRef, 'double accept');
      const d = h.bridge.poll({ runtimeId: 'runtime-v3', sessionId: 'ses_v3' });

      h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: d.deliveryId, deliveryState: 'accepted',
      });

      assert.throws(
        () => h.bridge.reportEvents({
          runtimeId: 'runtime-v3', sessionId: 'ses_v3',
          deliveryId: d.deliveryId, deliveryState: 'accepted',
        }),
        /cannot accept from state leased/,
      );

      h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: d.deliveryId,
        events: [{ type: 'done', data: { reason: 'idle' } }],
      });
      await p;
    } finally {
      h.cleanup();
    }
  });

  it('heartbeat 拒绝非 leased 状态的 delivery', () => {
    const h = setupV3Harness();
    try {
      const p = h.bridge.prompt(h.tuiSession.agentRef, 'hb queued');
      const d = h.bridge.poll({ runtimeId: 'runtime-v3', sessionId: 'ses_v3' });

      assert.throws(
        () => h.bridge.reportEvents({
          runtimeId: 'runtime-v3', sessionId: 'ses_v3',
          deliveryId: d.deliveryId, deliveryState: 'heartbeat',
        }),
        /cannot heartbeat from state queued/,
      );

      h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: d.deliveryId,
        events: [{ type: 'done', data: { reason: 'idle' } }],
      });
      return p;
    } finally {
      h.cleanup();
    }
  });

  it('v2 兼容：无 deliveryState 时按 final 处理', async () => {
    const h = setupV3Harness();
    try {
      const promptPromise = h.bridge.prompt(h.tuiSession.agentRef, 'v2 compat');
      const delivery = h.bridge.poll({ runtimeId: 'runtime-v3', sessionId: 'ses_v3' });

      const result = h.bridge.reportEvents({
        runtimeId: 'runtime-v3',
        sessionId: 'ses_v3',
        deliveryId: delivery.deliveryId,
        events: [{ type: 'text', data: { text: 'v2 回复' } }, { type: 'done', data: { reason: 'idle' } }],
      });
      assert.deepEqual(result, { delivered: true });

      const events = await promptPromise;
      assert.equal(events.length, 2);
      assert.equal(events[0].data.text, 'v2 回复');
    } finally {
      h.cleanup();
    }
  });

  it('deliveryState=final 显式传值与省略等价', async () => {
    const h = setupV3Harness();
    try {
      const promptPromise = h.bridge.prompt(h.tuiSession.agentRef, 'explicit final');
      const delivery = h.bridge.poll({ runtimeId: 'runtime-v3', sessionId: 'ses_v3' });

      const result = h.bridge.reportEvents({
        runtimeId: 'runtime-v3',
        sessionId: 'ses_v3',
        deliveryId: delivery.deliveryId,
        deliveryState: 'final',
        events: [{ type: 'done', data: { reason: 'idle' } }],
      });
      assert.deepEqual(result, { delivered: true });
      await promptPromise;
    } finally {
      h.cleanup();
    }
  });

  it('close 清理 tombstones 和所有 pending 的 timer/abort listener', async () => {
    const h = setupV3Harness();
    let promptPromise;
    try {
      const ac = new AbortController();
      promptPromise = h.bridge.prompt(h.tuiSession.agentRef, 'close test', { signal: ac.signal });
      const d = h.bridge.poll({ runtimeId: 'runtime-v3', sessionId: 'ses_v3' });
      h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: d.deliveryId, deliveryState: 'accepted',
      });

      assert.equal(h.bridge.pending.size, 1);
    } finally {
      h.bridge.close();
      await assert.rejects(promptPromise, /closed/);
      assert.equal(h.bridge._tombstones.size, 0, 'close 应清理 tombstones');
      fs.rmSync(h.tmpDir, { recursive: true, force: true });
    }
  });

  it('迟到 final 在无 watcher 时 transport_lost tombstone 仍标记 resolved', async () => {
    const h = setupV3Harness({ leaseTimeoutMs: 30 });
    try {
      const p = h.bridge.prompt(h.tuiSession.agentRef, 'no watcher');
      const d = h.bridge.poll({ runtimeId: 'runtime-v3', sessionId: 'ses_v3' });
      h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: d.deliveryId, deliveryState: 'accepted',
      });
      await assert.rejects(p, /TUI_RUNTIME_DISCONNECTED/);

      const result = h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: d.deliveryId,
        events: [{ type: 'done', data: { reason: 'idle' } }],
      });
      assert.deepEqual(result, { delivered: true, recovered: true });

      const ts = h.bridge._tombstones.get(d.deliveryId);
      assert.ok(ts.resolvedAt, 'tombstone 应被标记为已 resolve');
    } finally {
      h.cleanup();
    }
  });

  it('transport_lost tombstone 恢复后再次 report 返回 duplicate', async () => {
    const h = setupV3Harness({ leaseTimeoutMs: 30 });
    try {
      const p = h.bridge.prompt(h.tuiSession.agentRef, 'recovery once');
      const d = h.bridge.poll({ runtimeId: 'runtime-v3', sessionId: 'ses_v3' });
      h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: d.deliveryId, deliveryState: 'accepted',
      });
      await assert.rejects(p, /TUI_RUNTIME_DISCONNECTED/);

      h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: d.deliveryId,
        events: [{ type: 'done', data: { reason: 'idle' } }],
      });

      const result = h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: d.deliveryId,
        events: [{ type: 'done', data: { reason: 'idle' } }],
      });
      assert.deepEqual(result, { delivered: true, duplicate: true });
    } finally {
      h.cleanup();
    }
  });

  it('error final 在 transport_lost tombstone 上不投递到 watcher', async () => {
    const h = setupV3Harness({ leaseTimeoutMs: 30 });
    try {
      const p = h.bridge.prompt(h.tuiSession.agentRef, 'error recovery');
      const d = h.bridge.poll({ runtimeId: 'runtime-v3', sessionId: 'ses_v3' });
      h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: d.deliveryId, deliveryState: 'accepted',
      });
      await assert.rejects(p, /TUI_RUNTIME_DISCONNECTED/);

      const received = [];
      const stop = h.bridge.watchSession(h.tuiSession.agentRef, {
        onEvent: (event) => received.push(event),
        onError: (err) => received.push(err),
      });

      const result = h.bridge.reportEvents({
        runtimeId: 'runtime-v3', sessionId: 'ses_v3',
        deliveryId: d.deliveryId,
        error: 'something failed',
      });
      assert.deepEqual(result, { delivered: true, recovered: true });
      assert.equal(received.length, 0, 'error 应不投递到 watcher');
      stop();
    } finally {
      h.cleanup();
    }
  });
});

describe('OpencodeTuiBridge replyQuestion', () => {
  function setupReplyHarness(opts) {
    opts = opts || {};
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-tui-reply-'));
    const sessionService = new SessionService({
      stateStore: new JsonStore(path.join(tmpDir, 'state.json'), {}),
    });
    const bridge = new OpencodeTuiBridge({
      sessionService,
      leaseTimeoutMs: opts.leaseTimeoutMs || 90,
      heartbeatIntervalMs: opts.heartbeatIntervalMs || 30,
      tombstoneCapacity: opts.tombstoneCapacity || 100,
      tombstoneTtlMs: opts.tombstoneTtlMs || 300000,
      promptTimeoutMs: opts.promptTimeoutMs || 1000,
      runtimeStaleMs: opts.runtimeStaleMs ?? 10000,
    });
    const routeKey = opts.routeKey || 'feishu:oc_reply:om_root';
    const cwd = opts.cwd || 'H:\\walker';
    sessionService.setRouteCwd(routeKey, cwd);
    const reg = bridge.register({
      runtimeId: 'runtime-reply',
      sessionId: 'ses_reply',
      cwd,
      opencodeVersion: '1.17.20',
      bridgeProtocolVersion: opts.bridgeProtocolVersion === undefined ? 4 : opts.bridgeProtocolVersion,
    });
    const tuiSession = sessionService.getSession(reg.sessionId);
    return {
      tmpDir, sessionService, bridge, routeKey, cwd, tuiSession,
      cleanup() {
        bridge.close();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      },
    };
  }

  it('replyQuestion 以完整原生 requestID 和 answers 入队', () => {
    const h = setupReplyHarness();
    try {
      const replyPromise = h.bridge.replyQuestion(h.tuiSession.agentRef, 'req_001', [['yes'], ['custom']]);
      const delivery = h.bridge.poll({ runtimeId: 'runtime-reply', sessionId: 'ses_reply' });

      assert.ok(delivery, '应投递 delivery');
      assert.equal(delivery.type, 'question_reply');
      assert.equal(delivery.sessionId, 'ses_reply');
      assert.equal(delivery.requestID, 'req_001');
      assert.deepEqual(delivery.answers, [['yes'], ['custom']]);
      assert.equal('questionId' in delivery, false);
      assert.equal('answer' in delivery, false);
      assert.ok(delivery.deliveryId, '应携带 deliveryId');

      h.bridge.reportEvents({
        runtimeId: 'runtime-reply', sessionId: 'ses_reply',
        deliveryId: delivery.deliveryId,
        events: [],
      });
      return replyPromise;
    } finally {
      h.cleanup();
    }
  });

  it('replyQuestion runtime 不在线时 reject', async () => {
    const h = setupReplyHarness();
    try {
      h.bridge.dispose({ runtimeId: 'runtime-reply' });
      await assert.rejects(
        () => h.bridge.replyQuestion(h.tuiSession.agentRef, 'req_002', [['no']]),
        /not connected/,
      );
    } finally {
      h.cleanup();
    }
  });

  it('旧版 runtime 在入队前以不可重试的结构化错误拒绝 question reply', async () => {
    const h = setupReplyHarness({ bridgeProtocolVersion: 3 });
    try {
      await assert.rejects(
        () => h.bridge.replyQuestion(h.tuiSession.agentRef, 'req_legacy', [['no']]),
        (err) => err.code === 'QUESTION_REPLY_UNSUPPORTED'
          && err.deliveryPhase === 'preflight'
          && err.sdkInvoked === false
          && err.safeToRetry === false,
      );
      assert.equal(h.bridge.runtimes.get('runtime-reply').queue.length, 0);
    } finally {
      h.cleanup();
    }
  });

  it('acceptedTypes 仅取首条匹配 delivery 并保持未匹配项顺序', async () => {
    const h = setupReplyHarness();
    try {
      const prompt = h.bridge.prompt(h.tuiSession.agentRef, 'parent prompt');
      const reply = h.bridge.replyQuestion(h.tuiSession.agentRef, 'req_select', [['yes']]);
      const control = h.bridge.poll({
        runtimeId: 'runtime-reply', sessionId: 'ses_reply', acceptedTypes: ['question_reply'],
      });
      assert.equal(control.type, 'question_reply');
      assert.equal(h.bridge.runtimes.get('runtime-reply').queue[0].type, 'prompt');

      h.bridge.reportEvents({
        runtimeId: 'runtime-reply', sessionId: 'ses_reply', deliveryId: control.deliveryId, events: [],
      });
      const parent = h.bridge.poll({ runtimeId: 'runtime-reply', sessionId: 'ses_reply' });
      assert.equal(parent.type, 'prompt');
      h.bridge.reportEvents({
        runtimeId: 'runtime-reply', sessionId: 'ses_reply', deliveryId: parent.deliveryId, events: [],
      });
      await Promise.all([prompt, reply]);
    } finally {
      h.cleanup();
    }
  });

  it('question reply 可与已 leased 的父 prompt 并存，且同 session 控制 delivery 串行', async () => {
    const h = setupReplyHarness({ leaseTimeoutMs: 500 });
    try {
      const prompt = h.bridge.prompt(h.tuiSession.agentRef, 'parent prompt');
      const parent = h.bridge.poll({ runtimeId: 'runtime-reply', sessionId: 'ses_reply' });
      h.bridge.reportEvents({
        runtimeId: 'runtime-reply', sessionId: 'ses_reply', deliveryId: parent.deliveryId, deliveryState: 'accepted',
      });

      const first = h.bridge.replyQuestion(h.tuiSession.agentRef, 'req_first', [['one']]);
      const second = h.bridge.replyQuestion(h.tuiSession.agentRef, 'req_second', [['two']]);
      const firstDelivery = h.bridge.poll({
        runtimeId: 'runtime-reply', sessionId: 'ses_reply', acceptedTypes: ['question_reply'],
      });
      assert.equal(firstDelivery.requestID, 'req_first');
      assert.equal(h.bridge.poll({
        runtimeId: 'runtime-reply', sessionId: 'ses_reply', acceptedTypes: ['question_reply'],
      }), null);

      h.bridge.reportEvents({
        runtimeId: 'runtime-reply', sessionId: 'ses_reply', deliveryId: firstDelivery.deliveryId, deliveryState: 'accepted',
      });
      assert.deepEqual(h.bridge.reportEvents({
        runtimeId: 'runtime-reply', sessionId: 'ses_reply', deliveryId: firstDelivery.deliveryId, deliveryState: 'accepted',
      }), { delivered: true, duplicate: true });
      h.bridge.reportEvents({
        runtimeId: 'runtime-reply', sessionId: 'ses_reply', deliveryId: firstDelivery.deliveryId, events: [],
      });
      const secondDelivery = h.bridge.poll({
        runtimeId: 'runtime-reply', sessionId: 'ses_reply', acceptedTypes: ['question_reply'],
      });
      assert.equal(secondDelivery.requestID, 'req_second');
      h.bridge.reportEvents({
        runtimeId: 'runtime-reply', sessionId: 'ses_reply', deliveryId: secondDelivery.deliveryId, events: [],
      });
      h.bridge.reportEvents({
        runtimeId: 'runtime-reply', sessionId: 'ses_reply', deliveryId: parent.deliveryId, events: [],
      });
      await Promise.all([prompt, first, second]);
    } finally {
      h.cleanup();
    }
  });

  it('question reply 被取出后在 accepted 窗口超时，并对迟到 accepted 返回 expired', async () => {
    const h = setupReplyHarness({ runtimeStaleMs: 120 });
    try {
      const reply = h.bridge.replyQuestion(h.tuiSession.agentRef, 'req_expire', [['late']]);
      const delivery = h.bridge.poll({
        runtimeId: 'runtime-reply', sessionId: 'ses_reply', acceptedTypes: ['question_reply'],
      });
      const rejected = assert.rejects(reply, (err) => err.code === 'TUI_ACCEPTED_TIMEOUT'
        && err.deliveryPhase === 'queued'
        && err.sdkInvoked === false
        && err.safeToRetry === true);
      await waitMs(150);
      await rejected;
      assert.equal(h.bridge._tombstones.get(delivery.deliveryId).reason, 'accepted_timeout');
      assert.deepEqual(h.bridge.reportEvents({
        runtimeId: 'runtime-reply', sessionId: 'ses_reply', deliveryId: delivery.deliveryId, deliveryState: 'accepted',
      }), { delivered: false, expired: true });
    } finally {
      h.cleanup();
    }
  });

  it('replyQuestion runtime stale 时 reject', async () => {
    const h = setupReplyHarness();
    try {
      const runtime = h.bridge.runtimes.get('runtime-reply');
      runtime.lastSeenAt = Date.now() - 999999;
      await assert.rejects(
        () => h.bridge.replyQuestion(h.tuiSession.agentRef, 'req_003', [['maybe']]),
        /stale/,
      );
    } finally {
      h.cleanup();
    }
  });

  it('replyQuestion session 变更时 reject', async () => {
    const h = setupReplyHarness();
    try {
      const staleRef = { ...h.tuiSession.agentRef, opencodeSessionId: 'ses_other' };
      await assert.rejects(
        () => h.bridge.replyQuestion(staleRef, 'req_004', [['ok']]),
        /current session|has changed/i,
      );
    } finally {
      h.cleanup();
    }
  });

  it('replyQuestion accepted→heartbeat→final 成功 resolve', async () => {
    const h = setupReplyHarness({ leaseTimeoutMs: 500 });
    try {
      const replyPromise = h.bridge.replyQuestion(h.tuiSession.agentRef, 'req_005', [['confirmed']]);
      const delivery = h.bridge.poll({ runtimeId: 'runtime-reply', sessionId: 'ses_reply' });

      h.bridge.reportEvents({
        runtimeId: 'runtime-reply', sessionId: 'ses_reply',
        deliveryId: delivery.deliveryId, deliveryState: 'accepted',
      });
      const pending = h.bridge.pending.get(delivery.deliveryId);
      assert.equal(pending.state, 'leased');

      h.bridge.reportEvents({
        runtimeId: 'runtime-reply', sessionId: 'ses_reply',
        deliveryId: delivery.deliveryId, deliveryState: 'heartbeat',
      });
      const pendingAfterHb = h.bridge.pending.get(delivery.deliveryId);
      assert.equal(pendingAfterHb.state, 'leased');

      h.bridge.reportEvents({
        runtimeId: 'runtime-reply', sessionId: 'ses_reply',
        deliveryId: delivery.deliveryId,
        events: [],
      });

      const result = await replyPromise;
      assert.equal(result, undefined, 'replyQuestion resolve 值应为 undefined');
    } finally {
      h.cleanup();
    }
  });

  it('replyQuestion final 带 error 时 reject', async () => {
    const h = setupReplyHarness();
    try {
      const replyPromise = h.bridge.replyQuestion(h.tuiSession.agentRef, 'req_006', [['bad']]);
      const delivery = h.bridge.poll({ runtimeId: 'runtime-reply', sessionId: 'ses_reply' });

      h.bridge.reportEvents({
        runtimeId: 'runtime-reply', sessionId: 'ses_reply',
        deliveryId: delivery.deliveryId,
        error: {
          message: 'reply rejected by runtime',
          code: 'QUESTION_NOT_FOUND',
          deliveryPhase: 'leased',
          sdkInvoked: true,
          safeToRetry: false,
        },
      });

      await assert.rejects(replyPromise, (err) => err.message === 'reply rejected by runtime'
        && err.code === 'QUESTION_NOT_FOUND'
        && err.deliveryPhase === 'leased'
        && err.sdkInvoked === true
        && err.safeToRetry === false);
    } finally {
      h.cleanup();
    }
  });

  it('replyQuestion lease 超时时 reject', async () => {
    const h = setupReplyHarness({ leaseTimeoutMs: 30 });
    try {
      const replyPromise = h.bridge.replyQuestion(h.tuiSession.agentRef, 'req_007', [['timeout']]);
      const delivery = h.bridge.poll({ runtimeId: 'runtime-reply', sessionId: 'ses_reply' });

      h.bridge.reportEvents({
        runtimeId: 'runtime-reply', sessionId: 'ses_reply',
        deliveryId: delivery.deliveryId, deliveryState: 'accepted',
      });

      const rejected = assert.rejects(replyPromise, /TUI_RUNTIME_DISCONNECTED/);
      await waitMs(50);
      await rejected;
      assert.equal(h.bridge.pending.size, 0, 'pending 应已清理');
    } finally {
      h.cleanup();
    }
  });

  it('已 accepted 的 question reply 在 runtime dispose 时按不可重试的已调用 SDK 状态拒绝', async () => {
    const h = setupReplyHarness({ leaseTimeoutMs: 500 });
    try {
      const replyPromise = h.bridge.replyQuestion(h.tuiSession.agentRef, 'req_dispose', [['accepted']]);
      const delivery = h.bridge.poll({ runtimeId: 'runtime-reply', sessionId: 'ses_reply' });
      h.bridge.reportEvents({
        runtimeId: 'runtime-reply', sessionId: 'ses_reply',
        deliveryId: delivery.deliveryId, deliveryState: 'accepted',
      });
      h.bridge.dispose({ runtimeId: 'runtime-reply' });
      await assert.rejects(replyPromise, (err) => err.code === 'TUI_RUNTIME_DISCONNECTED'
        && err.deliveryPhase === 'leased'
        && err.sdkInvoked === true
        && err.safeToRetry === false);
    } finally {
      h.cleanup();
    }
  });

  it('cancel 清理 question_reply pending', async () => {
    const h = setupReplyHarness();
    try {
      const replyPromise = h.bridge.replyQuestion(h.tuiSession.agentRef, 'req_008', [['cancel me']]);
      const delivery = h.bridge.poll({ runtimeId: 'runtime-reply', sessionId: 'ses_reply' });

      h.bridge.cancel(h.tuiSession.agentRef);
      await assert.rejects(replyPromise, /cancel/);
      assert.equal(h.bridge.pending.size, 0, 'pending 应已清理');

      const tombstone = h.bridge._tombstones.get(delivery.deliveryId);
      assert.ok(tombstone, '应有 tombstone');
      assert.equal(tombstone.reason, 'cancelled');
    } finally {
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
