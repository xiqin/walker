'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { SessionService } = require('../src/core/session-service');
const { JsonStore } = require('../src/core/json-store');
const { MessageDispatcher } = require('../src/dispatch/message-dispatcher');
const { MessageDedup } = require('../src/core/message-dedup');
const { AgentEvent } = require('../src/drivers/agent-driver');
const { createHookReceiverRoutes } = require('../src/opencode-hook/receiver');
const { createHealthPoller } = require('../src/opencode-hook/health-poller');

function makeRealCtx() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-integ-'));
  const stateStore = new JsonStore(path.join(tmpDir, 'state.json'), {});
  const sessionService = new SessionService({ stateStore });
  return {
    tmpDir,
    sessionService,
    config: { admin: { token: '' } },
    cleanup() { fs.rmSync(tmpDir, { recursive: true, force: true }); },
  };
}

function makeStubDriver(promptResponses) {
  const calls = [];
  return {
    calls,
    ensureReady: async () => true,
    createSession: async () => ({ opencodeSessionId: 'ses_stub_' + Math.random().toString(36).slice(2, 8), serverUrl: 'http://localhost:4096' }),
    listSessions: async () => [],
    watchSession: () => () => {},
    prompt: async (agentRef, text) => {
      calls.push({ agentRef, text });
      return promptResponses || [new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'echo:' + text }), new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' })];
    },
    stop: async () => {},
    delete: async () => {},
    resumeSession: async (ref) => ref,
    listModels: async () => [],
  };
}

function makeFeishuStub() {
  const calls = [];
  return {
    calls,
    replyText: (msgId, text) => { calls.push({ type: 'replyText', msgId, text }); },
    sendText: (chatId, text) => { calls.push({ type: 'sendText', chatId, text }); },
    replyCard: (msgId, card) => { calls.push({ type: 'replyCard', msgId, card }); return 'om_card_' + (calls.length); },
    patchCard: (cardId, card) => { calls.push({ type: 'patchCard', cardId, card }); },
    addReaction: (msgId, emoji) => { calls.push({ type: 'addReaction', msgId, emoji }); },
    sendUnboundGuide: (msgId, routeKey) => { calls.push({ type: 'sendUnboundGuide', msgId, routeKey }); },
    sendSessionList: (msgId, sessions, currentId, routeKey) => { calls.push({ type: 'sendSessionList', msgId, sessions, currentId, routeKey }); },
    sendAttachableSessionList: (msgId, sessions, options) => { calls.push({ type: 'sendAttachableSessionList', msgId, sessions, options }); },
    sendErrorCard: (msgId, message) => { calls.push({ type: 'sendErrorCard', msgId, message }); },
    sendProgressCard: (msgId, sessionId, initialEvent) => { calls.push({ type: 'sendProgressCard', msgId, sessionId }); return 'om_prog_' + (calls.length); },
    updateProgressCard: (cardId, sessionId, agentEvent) => { calls.push({ type: 'updateProgressCard', cardId, sessionId, agentEvent }); return null; },
  };
}

function enrollViaHook(ctx, opencodeSid, cwd) {
  const routes = createHookReceiverRoutes(ctx);
  const handler = routes.find((r) => r.method === 'POST' && r.pattern === '/opencode/hook/session-created').handler;
  const req = {
    method: 'POST', url: '/opencode/hook/session-created', headers: {},
    socket: { remoteAddress: '127.0.0.1' },
    on: function (ev, cb) {
      if (ev === 'data') { cb(Buffer.from(JSON.stringify({ opencodeBaseUrl: 'http://localhost:4096', sessionId: opencodeSid, cwd }))); return req; }
      if (ev === 'end') { cb(); return req; }
      return req;
    },
  };
  const res = { statusCode: 0, headers: {}, body: '', writeHead(c) { res.statusCode = c; }, end(chunk) { if (chunk) res.body = chunk.toString(); } };
  handler(req, res);
  return JSON.parse(res.body);
}

describe('集成测试 1: Hook 纳入 → 路由绑定 → 消息派发', () => {
  it('plugin 上报 session.created → receiver 按 cwd 匹配 route → 创建 session 加入 route → 消息派发到焦点 session', async () => {
    const ctx = makeRealCtx();
    try {
      const routeKey = 'feishu:oc_integ1:om_root1';
      const cwd = 'H:\\walker';
      const initialSession = ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd, agentRef: { opencodeSessionId: 'oc_initial', serverUrl: 'http://localhost:4096' } });
      ctx.sessionService.setRouteCwd(routeKey, cwd);

      const driver = makeStubDriver();
      const driverRegistry = { get: () => driver };
      const feishuApi = makeFeishuStub();
      const dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry,
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      const result = enrollViaHook(ctx, 'oc_hook_enrolled', cwd);
      assert.equal(result.ok, true);
      assert.equal(result.data.routeKey, routeKey);
      const hookSessionId = result.data.sessionId;

      const sessionsInRoute = ctx.sessionService.listSessionsInRoute(routeKey);
      assert.equal(sessionsInRoute.length, 2, 'route 下应有 2 个 session（初始 + hook 纳入）');

      const current = ctx.sessionService.getCurrent(routeKey);
      assert.ok(current, 'getCurrent 应返回焦点 session');
      assert.equal(current.id, initialSession.id, '焦点应保持初始 session');

      const promptResult = await dispatcher.handleIncomingMessage({
        messageId: 'om_msg_integ1', chatId: 'oc_integ1', rootId: 'om_root1', text: 'hello focus',
        routeKey,
      });
      assert.equal(promptResult, 'prompted');
      assert.equal(driver.calls.length, 1);
      assert.equal(driver.calls[0].agentRef.opencodeSessionId, 'oc_initial', '消息应派发到焦点 session');
    } finally {
      ctx.cleanup();
    }
  });

  it('同 cwd 启动第二个 OpenCode → 加入同一 routeKey → 不动 focusSessionId', async () => {
    const ctx = makeRealCtx();
    try {
      const routeKey = 'feishu:oc_integ2:om_root1';
      const cwd = 'H:\\walker';
      const firstSession = ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd, agentRef: { opencodeSessionId: 'oc_first', serverUrl: 'http://localhost:4096' } });
      ctx.sessionService.setRouteCwd(routeKey, cwd);

      const r2 = enrollViaHook(ctx, 'oc_second', cwd);
      assert.equal(r2.data.routeKey, routeKey);

      const sessions = ctx.sessionService.listSessionsInRoute(routeKey);
      assert.equal(sessions.length, 2);

      const current = ctx.sessionService.getCurrent(routeKey);
      assert.equal(current.id, firstSession.id, '焦点应保持第一个 session 不变');
    } finally {
      ctx.cleanup();
    }
  });
});

describe('集成测试 2: 1:N 路由 → 切焦点 → 消息派发到新焦点', () => {
  it('route 下多 session → /use 切焦点 → 新焦点接收消息', async () => {
    const ctx = makeRealCtx();
    try {
      const routeKey = 'feishu:oc_integ3:om_root1';
      const cwd = 'H:\\walker';
      const s1 = ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd, agentRef: { opencodeSessionId: 'oc_focus_orig', serverUrl: 'http://localhost:4096' } });
      ctx.sessionService.setRouteCwd(routeKey, cwd);
      const r2 = enrollViaHook(ctx, 'oc_focus_new', cwd);
      const newFocusId = r2.data.sessionId;

      const driver = makeStubDriver();
      const driverRegistry = { get: () => driver };
      const feishuApi = makeFeishuStub();
      const dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry,
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      const useResult = await dispatcher.handleCommand({
        type: 'command', name: 'use', args: [newFocusId],
        routeKey, messageId: 'om_use_integ3', chatId: 'oc_integ3',
      });
      assert.equal(useResult.focus, newFocusId);

      const current = ctx.sessionService.getCurrent(routeKey);
      assert.equal(current.id, newFocusId, 'getCurrent 应返回新焦点');

      const promptResult = await dispatcher.handleIncomingMessage({
        messageId: 'om_msg_integ3', chatId: 'oc_integ3', rootId: 'om_root1', text: 'send to new focus',
        routeKey,
      });
      assert.equal(promptResult, 'prompted');
      assert.equal(driver.calls.length, 1);
      assert.equal(driver.calls[0].agentRef.opencodeSessionId, 'oc_focus_new', '消息应派发到新焦点 session');
    } finally {
      ctx.cleanup();
    }
  });
});

describe('集成测试 3: 非焦点 session 输出回群带标识', () => {
  it('非焦点 session watch 事件 → 带标识前缀回群；焦点 session 不带前缀', async () => {
    const ctx = makeRealCtx();
    try {
      const routeKey = 'feishu:oc_integ4:om_root1';
      const cwd = 'H:\\walker';
      const focusSession = ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd, agentRef: { opencodeSessionId: 'oc_integ4_focus', serverUrl: 'http://localhost:4096' } });
      ctx.sessionService.setRouteCwd(routeKey, cwd);
      const r2 = enrollViaHook(ctx, 'oc_integ4_nonfocus', cwd);
      const nonFocusSession = ctx.sessionService.getSession(r2.data.sessionId);

      const feishuApi = makeFeishuStub();
      const dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => makeStubDriver() },
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
        nonFocusOutput: true,
      });

      dispatcher._handleWatchedSessionEvent(nonFocusSession, 'oc_integ4', new AgentEvent(AgentEvent.TYPE_TEXT, { text: '非焦点输出' }));
      dispatcher._handleWatchedSessionEvent(nonFocusSession, 'oc_integ4', new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }));
      await new Promise((resolve) => setImmediate(resolve));

      const sendText = feishuApi.calls.find((c) => c.type === 'sendText' && c.text.includes('非焦点输出'));
      assert.ok(sendText, '非焦点输出应发送到群');
      const expectedPrefix = '[session: ' + r2.data.sessionId.slice(0, 8);
      assert.ok(sendText.text.startsWith(expectedPrefix), '应带 [session: <id前8位>] 前缀, got: ' + sendText.text.slice(0, 30));

      dispatcher._handleWatchedSessionEvent(focusSession, 'oc_integ4', new AgentEvent(AgentEvent.TYPE_TEXT, { text: '焦点专属内容' }));
      dispatcher._handleWatchedSessionEvent(focusSession, 'oc_integ4', new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }));
      await new Promise((resolve) => setImmediate(resolve));

      const focusSend = feishuApi.calls.find((c) => c.type === 'sendText' && c.text.includes('焦点专属内容'));
      assert.ok(focusSend, '焦点输出应发送到群');
      assert.equal(focusSend.text.startsWith('[session:'), false, '焦点输出不应带 session 标识前缀');
    } finally {
      ctx.cleanup();
    }
  });
});

describe('集成测试 4: OpenCode 退出检测 cascade', () => {
  it('心跳连续 2 次失败 → detached → 取消 turn → 移除 route → 自动切焦点', async () => {
    const ctx = makeRealCtx();
    try {
      const routeKey = 'feishu:oc_integ5:om_root1';
      const cwd = 'H:\\walker';
      const focusSession = ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd, agentRef: { opencodeSessionId: 'oc_integ5_focus', serverUrl: 'http://localhost:4096' } });
      ctx.sessionService.setRouteCwd(routeKey, cwd);
      const r2 = enrollViaHook(ctx, 'oc_integ5_other', cwd);
      const otherSessionId = r2.data.sessionId;

      const feishuApi = makeFeishuStub();
      const dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => makeStubDriver() },
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });
      dispatcher.turnStates.set(focusSession.id, { token: 1, startedAt: Date.now(), lastEventAt: Date.now(), cancelled: false, driver: null });

      const httpClient = { request: async () => { throw new Error('ECONNREFUSED'); } };
      const poller = createHealthPoller({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => null },
        dispatcher,
        pollIntervalMs: 10,
        exitAction: 'cancel',
        httpClient,
      });
      poller.start();
      poller.track(focusSession.id, { opencodeSessionId: 'oc_integ5_focus', serverUrl: 'http://localhost:4096' });

      await new Promise((resolve) => setTimeout(resolve, 120));

      assert.equal(ctx.sessionService.getRouteForSession(focusSession.id), null, '退出 session 应从 route 移除');

      const current = ctx.sessionService.getCurrent(routeKey);
      assert.ok(current, 'route 应仍有焦点 session');
      assert.equal(current.id, otherSessionId, '焦点应自动切到另一个 session');

      poller.stop();
    } finally {
      ctx.cleanup();
    }
  });

  it('无 running turn 时退出不报错，仍从 route 移除', async () => {
    const ctx = makeRealCtx();
    try {
      const routeKey = 'feishu:oc_integ6:om_root1';
      const cwd = 'H:\\walker';
      const onlySession = ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd, agentRef: { opencodeSessionId: 'oc_integ6_only', serverUrl: 'http://localhost:4096' } });
      ctx.sessionService.setRouteCwd(routeKey, cwd);

      const feishuApi = makeFeishuStub();
      const dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => makeStubDriver() },
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      const httpClient = { request: async () => { throw new Error('ECONNREFUSED'); } };
      const poller = createHealthPoller({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => null },
        dispatcher,
        pollIntervalMs: 10,
        exitAction: 'cancel',
        httpClient,
      });
      poller.start();
      poller.track(onlySession.id, { opencodeSessionId: 'oc_integ6_only', serverUrl: 'http://localhost:4096' });

      await new Promise((resolve) => setTimeout(resolve, 120));

      assert.equal(ctx.sessionService.getRouteForSession(onlySession.id), null, '退出 session 应从 route 移除');
      const remaining = ctx.sessionService.listSessionsInRoute(routeKey);
      assert.equal(remaining.length, 0, 'route 应为空');

      poller.stop();
    } finally {
      ctx.cleanup();
    }
  });
});
