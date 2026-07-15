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
      const result = await clearPromise;

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
    const h = setupClearHarness({ oldModel: 'gpt-5-custom', cwd: 'D:\\projects\\alpha' });
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
      assert.equal(newWalker.model, 'gpt-5-custom', '应继承旧 session 模型');
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
