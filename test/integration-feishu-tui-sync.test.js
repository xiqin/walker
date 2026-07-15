'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { SessionService } = require('../src/core/session-service');
const { JsonStore } = require('../src/core/json-store');
const { MessageDispatcher } = require('../src/dispatch/message-dispatcher');
const { MessageDedup } = require('../src/core/message-dedup');
const { AgentEvent } = require('../src/drivers/agent-driver');
const { OpencodeDriver } = require('../src/drivers/opencode-driver');
const { OpencodeTuiBridge } = require('../src/opencode-tui-bridge/bridge');
const { buildRouteKey } = require('../src/core/route-key');

function makeRealCtx() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-feishu-tui-'));
  const stateStore = new JsonStore(path.join(tmpDir, 'state.json'), {});
  const sessionService = new SessionService({ stateStore });
  return {
    tmpDir,
    sessionService,
    config: { admin: { token: '' } },
    cleanup() { fs.rmSync(tmpDir, { recursive: true, force: true }); },
  };
}

function makeFeishuStub() {
  const calls = [];
  return {
    calls,
    replyText: (replyCtx, text) => { calls.push({ type: 'replyText', replyCtx, text }); return [{ message_id: 'om_reply_' + calls.length }]; },
    sendText: (chatId, text) => { calls.push({ type: 'sendText', chatId, text }); },
    replyCard: (replyCtx, card) => { calls.push({ type: 'replyCard', replyCtx, card }); return 'om_card_' + calls.length; },
    patchCard: (cardId, card) => { calls.push({ type: 'patchCard', cardId, card }); },
    addReaction: (msgId, emoji) => { calls.push({ type: 'addReaction', msgId, emoji }); },
    sendUnboundGuide: (replyCtx, routeKey) => { calls.push({ type: 'sendUnboundGuide', replyCtx, routeKey }); },
    sendSessionList: (replyCtx, sessions, currentId, routeKey) => { calls.push({ type: 'sendSessionList', replyCtx, sessions, currentId, routeKey }); },
    sendAttachableSessionList: (replyCtx, sessions, options) => { calls.push({ type: 'sendAttachableSessionList', replyCtx, sessions, options }); },
    sendErrorCard: (replyCtx, message) => { calls.push({ type: 'sendErrorCard', replyCtx, message }); },
    sendProgressCard: (replyCtx, sessionId) => { calls.push({ type: 'sendProgressCard', replyCtx, sessionId }); return 'om_prog_' + calls.length; },
    updateProgressCard: (cardId, sessionId, agentEvent) => { calls.push({ type: 'updateProgressCard', cardId, sessionId, agentEvent }); return null; },
  };
}

function makeStubDriver(options) {
  const opts = options || {};
  const promptCalls = [];
  let watchHandlers = null;

  return {
    promptCalls,
    getWatchHandlers: () => watchHandlers,
    ensureReady: async () => true,
    createSession: async () => ({ opencodeSessionId: 'ses_' + Math.random().toString(36).slice(2, 8), serverUrl: 'http://localhost:4096' }),
    listSessions: async () => [],
    watchSession: (sessionRef, handlers) => {
      watchHandlers = handlers;
      return () => { watchHandlers = null; };
    },
    prompt: async (agentRef, text) => {
      promptCalls.push({ agentRef, text });
      return opts.promptEvents || [new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'echo:' + text }), new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' })];
    },
    stop: async () => {},
    delete: async () => {},
    resumeSession: async (ref) => ref,
    listModels: async () => [],
  };
}

async function pollDelivery(bridge, runtimeId, sessionId, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 1000);
  while (Date.now() < deadline) {
    const delivery = bridge.poll({ runtimeId, sessionId });
    if (delivery) return delivery;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out waiting for TUI bridge delivery');
}

describe('飞书-TUI 双向链路集成测试', () => {
  let ctx;
  let feishuApi;
  let dispatcher;

  beforeEach(() => {
    ctx = makeRealCtx();
    feishuApi = makeFeishuStub();
  });

  afterEach(() => {
    if (dispatcher) {
      dispatcher.destroy();
      dispatcher = null;
    }
    ctx.cleanup();
  });

  describe('已 attach 会话双向消息', () => {
    it('飞书 thread 消息进入已 attach session → prompt 被调用 → TUI assistant 回复通过 watch 出站到飞书', async () => {
      const chatId = 'oc_chat_bidir';
      const rootId = 'om_root_bidir';
      const cwd = process.cwd();
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const agentRef = { opencodeSessionId: 'ses_bidir_1', serverUrl: 'http://localhost:4096', cwd };

      ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd, agentRef });
      ctx.sessionService.setRouteCwd(routeKey, cwd);

      const driver = makeStubDriver();
      const driverRegistry = { get: () => driver };

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry,
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      const result = await dispatcher.handleIncomingMessage({
        messageId: 'om_msg_bidir_1',
        chatId,
        rootId,
        text: 'hello from feishu thread',
      });

      assert.equal(result, 'prompted', 'handleIncomingMessage 应返回 prompted');
      assert.equal(driver.promptCalls.length, 1, 'driver.prompt 应被调用一次');
      assert.equal(driver.promptCalls[0].text, 'hello from feishu thread');
      assert.equal(driver.promptCalls[0].agentRef.opencodeSessionId, 'ses_bidir_1');

      const handlers = driver.getWatchHandlers();
      assert.ok(handlers, 'watchSession 应已注册 handlers');
      assert.ok(typeof handlers.onEvent === 'function', 'handlers 应包含 onEvent');

      const tuiReplyText = 'TUI assistant reply from watched session';
      handlers.onEvent(new AgentEvent(AgentEvent.TYPE_TEXT, { text: tuiReplyText }));
      handlers.onEvent(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'polled' }));
      await new Promise((resolve) => setImmediate(resolve));

      const sendTextCalls = feishuApi.calls.filter((c) => c.type === 'sendText');
      const tuiReply = sendTextCalls.find((c) => c.text && c.text.includes(tuiReplyText));
      assert.ok(tuiReply, '飞书 sendText 应收到 TUI assistant 回复');
      assert.equal(tuiReply.chatId, chatId, '回复应发送到正确的 chatId');
    });

    it('thread route 无绑定 → 回退到同群根 route → prompt 和 watch 均正常', async () => {
      const chatId = 'oc_chat_fallback';
      const rootId = 'om_root_fallback';
      const cwd = process.cwd();
      const fallbackRouteKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const agentRef = { opencodeSessionId: 'ses_fallback_1', serverUrl: 'http://localhost:4096', cwd };

      ctx.sessionService.createSession({ route: fallbackRouteKey, agent: 'opencode', cwd, agentRef });
      ctx.sessionService.setRouteCwd(fallbackRouteKey, cwd);

      const driver = makeStubDriver();
      const driverRegistry = { get: () => driver };

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry,
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      const result = await dispatcher.handleIncomingMessage({
        messageId: 'om_msg_fallback_1',
        chatId,
        rootId,
        text: 'hello from thread without binding',
      });

      assert.equal(result, 'prompted', '回退到群根 route 后应返回 prompted');
      assert.equal(driver.promptCalls.length, 1, 'prompt 应被调用');
      assert.equal(driver.promptCalls[0].agentRef.opencodeSessionId, 'ses_fallback_1', 'prompt 应发往群根 route 的 session');

      const handlers = driver.getWatchHandlers();
      assert.ok(handlers, '回退后也应建立 watch');

      const replyText = 'fallback TUI reply';
      handlers.onEvent(new AgentEvent(AgentEvent.TYPE_TEXT, { text: replyText }));
      handlers.onEvent(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'polled' }));
      await new Promise((resolve) => setImmediate(resolve));

      const sendTextCalls = feishuApi.calls.filter((c) => c.type === 'sendText');
      const reply = sendTextCalls.find((c) => c.text && c.text.includes(replyText));
      assert.ok(reply, '回退场景下飞书也应收到 TUI 回复');
      assert.equal(reply.chatId, chatId, '回复应发送到正确的 chatId');
    });
  });

  describe('普通 embedded TUI bridge', () => {
    it('飞书 prompt 经本地 TUI runtime 执行并回传，且不访问独立 4096 服务', async () => {
      const chatId = 'oc_chat_embedded';
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const cwd = process.cwd();
      const runtimeId = 'runtime-embedded-e2e';
      const opencodeSessionId = 'ses_embedded_e2e';

      ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd });
      ctx.sessionService.setRouteCwd(routeKey, cwd);

      const bridge = new OpencodeTuiBridge({
        sessionService: ctx.sessionService,
        promptTimeoutMs: 1000,
        runtimeStaleMs: 1000,
      });
      bridge.register({ runtimeId, sessionId: opencodeSessionId, cwd, opencodeVersion: '1.17.20' });

      let networkCalls = 0;
      const driver = new OpencodeDriver({
        serverUrl: 'http://localhost:4096',
        tuiBridge: bridge,
        httpClient: {
          request: async () => {
            networkCalls++;
            throw new Error('embedded TUI bridge must not use HTTP');
          },
        },
        sseClient: {
          connect: async () => {
            networkCalls++;
            throw new Error('embedded TUI bridge must not use SSE');
          },
        },
      });

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => driver },
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      const promptResult = dispatcher.handleIncomingMessage({
        messageId: 'om_msg_embedded_e2e',
        chatId,
        text: 'hello embedded TUI',
      });

      const delivery = await pollDelivery(bridge, runtimeId, opencodeSessionId);
      assert.equal(delivery.text, 'hello embedded TUI');
      assert.equal(delivery.sessionId, opencodeSessionId);

      bridge.reportEvents({
        runtimeId,
        sessionId: opencodeSessionId,
        deliveryId: delivery.deliveryId,
        events: [
          { type: AgentEvent.TYPE_TEXT, data: { text: 'embedded assistant reply' } },
          { type: AgentEvent.TYPE_DONE, data: { reason: 'idle' } },
        ],
      });

      assert.equal(await promptResult, 'prompted');
      assert.equal(networkCalls, 0, 'bridge session 不应访问独立 OpenCode HTTP/SSE');

      const renderedReply = feishuApi.calls.find((call) => {
        return call.type === 'replyText'
          && call.text
          && call.text.includes('embedded assistant reply');
      });
      assert.ok(renderedReply, '飞书应通过普通文本消息收到 embedded TUI 的回答');

      bridge.reportEvents({
        runtimeId,
        sessionId: opencodeSessionId,
        events: [
          { type: AgentEvent.TYPE_TEXT, data: { text: 'manual TUI turn reply' } },
          { type: AgentEvent.TYPE_DONE, data: { reason: 'idle' } },
        ],
      });
      await new Promise((resolve) => setImmediate(resolve));

      const manualReply = feishuApi.calls.find((call) => {
        return call.type === 'sendText' && call.chatId === chatId && call.text.includes('manual TUI turn reply');
      });
      assert.ok(manualReply, 'TUI 手工发起的回答应通过 watch 回传飞书');
      bridge.close();
    });
  });

  describe('不会重复或跨 route 推送 TUI 回复', () => {
    it('单次双向流程不会重复发送回复', async () => {
      const chatId = 'oc_chat_dedup';
      const rootId = 'om_root_dedup';
      const cwd = process.cwd();
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const agentRef = { opencodeSessionId: 'ses_dedup_1', serverUrl: 'http://localhost:4096', cwd };

      ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd, agentRef });
      ctx.sessionService.setRouteCwd(routeKey, cwd);

      const driver = makeStubDriver();
      const driverRegistry = { get: () => driver };

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry,
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      await dispatcher.handleIncomingMessage({
        messageId: 'om_msg_dedup_1',
        chatId,
        rootId,
        text: 'test dedup',
      });

      const handlers = driver.getWatchHandlers();
      const uniqueText = 'unique reply from TUI ' + Date.now();
      handlers.onEvent(new AgentEvent(AgentEvent.TYPE_TEXT, { text: uniqueText }));
      handlers.onEvent(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'polled' }));
      await new Promise((resolve) => setImmediate(resolve));

      handlers.onEvent(new AgentEvent(AgentEvent.TYPE_TEXT, { text: uniqueText }));
      handlers.onEvent(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'polled' }));
      await new Promise((resolve) => setImmediate(resolve));

      const sendTextCalls = feishuApi.calls.filter((c) => c.type === 'sendText' && c.text && c.text.includes(uniqueText));
      assert.equal(sendTextCalls.length, 1, '相同回复文本不应被重复发送');
    });

    it('不同 chat 的回复不会误投递到其他 chatId', async () => {
      const chatIdA = 'oc_chat_iso_a';
      const chatIdB = 'oc_chat_iso_b';
      const cwd = process.cwd();

      const routeKeyA = buildRouteKey({ chatId: chatIdA, rootId: '' }, 'thread');
      const agentRefA = { opencodeSessionId: 'ses_iso_a', serverUrl: 'http://localhost:4096', cwd };

      ctx.sessionService.createSession({ route: routeKeyA, agent: 'opencode', cwd, agentRef: agentRefA });
      ctx.sessionService.setRouteCwd(routeKeyA, cwd);

      let watchHandlersA = null;
      const driverA = {
        ensureReady: async () => true,
        prompt: async () => [new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'echo' }), new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' })],
        watchSession: (ref, handlers) => { watchHandlersA = handlers; return () => { watchHandlersA = null; }; },
        resumeSession: async (ref) => ref,
      };

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => driverA },
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      await dispatcher.handleIncomingMessage({
        messageId: 'om_msg_iso_a',
        chatId: chatIdA,
        rootId: 'om_root_a',
        text: 'message to A',
      });

      assert.ok(watchHandlersA, 'chatA 的 watch 应已建立');

      watchHandlersA.onEvent(new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'reply from A session' }));
      watchHandlersA.onEvent(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'polled' }));
      await new Promise((resolve) => setImmediate(resolve));

      const sendToA = feishuApi.calls.filter((c) => c.type === 'sendText' && c.chatId === chatIdA);
      assert.ok(sendToA.length >= 1, 'chatA 应收到回复');

      const sendToB = feishuApi.calls.filter((c) => c.type === 'sendText' && c.chatId === chatIdB);
      assert.equal(sendToB.length, 0, 'chatA 的回复不应误投递到 chatB');
    });

    it('不同 session 的 watch 回复隔离，不会跨 session 投递', async () => {
      const chatId = 'oc_chat_session_iso';
      const cwd = process.cwd();
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');

      const agentRef1 = { opencodeSessionId: 'ses_iso_s1', serverUrl: 'http://localhost:4096', cwd };
      const agentRef2 = { opencodeSessionId: 'ses_iso_s2', serverUrl: 'http://localhost:4096', cwd };

      const session1 = ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd, agentRef: agentRef1 });
      ctx.sessionService.setRouteCwd(routeKey, cwd);
      ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd, agentRef: agentRef2 });

      const feishuLocal = makeFeishuStub();

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => ({ watchSession: () => () => {}, prompt: async () => [] }) },
        feishuApi: feishuLocal,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      dispatcher._handleWatchedSessionEvent(session1, chatId, new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'session1 output' }));
      dispatcher._handleWatchedSessionEvent(session1, chatId, new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }));
      await new Promise((resolve) => setImmediate(resolve));

      const session1Send = feishuLocal.calls.filter((c) => c.type === 'sendText' && c.text && c.text.includes('session1 output'));
      assert.equal(session1Send.length, 1, 'session1 输出应发送一次');

      const session2 = ctx.sessionService.listSessions().find((s) => s.id !== session1.id);
      const session2Text = 'session2 exclusive output ' + Date.now();
      dispatcher._handleWatchedSessionEvent(session2, chatId, new AgentEvent(AgentEvent.TYPE_TEXT, { text: session2Text }));
      dispatcher._handleWatchedSessionEvent(session2, chatId, new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'polled' }));
      await new Promise((resolve) => setImmediate(resolve));

      const allSendText = feishuLocal.calls.filter((c) => c.type === 'sendText');
      const session2Duplicates = allSendText.filter((c) => c.text && c.text.includes(session2Text));
      assert.ok(session2Duplicates.length <= 1, 'session2 输出不应重复发送');
    });
  });
});
