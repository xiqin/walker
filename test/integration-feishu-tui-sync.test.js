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
    replyMarkdown: (replyCtx, text) => { calls.push({ type: 'replyMarkdown', replyCtx, text }); return [{ message_id: 'om_reply_' + calls.length }]; },
    sendText: (chatId, text) => { calls.push({ type: 'sendText', chatId, text }); },
    sendMarkdown: (chatId, text) => { calls.push({ type: 'sendMarkdown', chatId, text }); },
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

      const sendMarkdownCalls = feishuApi.calls.filter((c) => c.type === 'sendMarkdown');
      const tuiReply = sendMarkdownCalls.find((c) => c.text && c.text.includes(tuiReplyText));
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

      const sendMarkdownCalls = feishuApi.calls.filter((c) => c.type === 'sendMarkdown');
      const reply = sendMarkdownCalls.find((c) => c.text && c.text.includes(replyText));
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
        return call.type === 'replyMarkdown'
          && call.text
          && call.text.includes('embedded assistant reply');
      });
      assert.ok(renderedReply, '飞书应通过markdown 卡片收到 embedded TUI 的回答');

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
        return call.type === 'sendMarkdown' && call.chatId === chatId && call.text.includes('manual TUI turn reply');
      });
      assert.ok(manualReply, 'TUI 手工发起的回答应通过 watch 回传飞书');

      bridge.reportEvents({
        runtimeId,
        sessionId: opencodeSessionId,
        events: [
          {
            type: AgentEvent.TYPE_PERMISSION,
            data: {
              id: 'perm_external_dir',
              type: 'tool',
              title: 'Access external directory H:\\sacpserv',
              metadata: { patterns: ['H:\\sacpServ\\*'] },
              sessionID: opencodeSessionId,
              messageID: 'msg_perm_external_dir',
            },
          },
        ],
      });
      await new Promise((resolve) => setImmediate(resolve));

      const permissionCard = feishuApi.calls.find((call) => {
        return call.type === 'replyCard'
          && call.replyCtx
          && call.replyCtx.chatId === chatId
          && call.card
          && call.card.header
          && call.card.header.title
          && call.card.header.title.content === '权限确认请求';
      });
      assert.ok(permissionCard, 'TUI permission 事件应通过 watch 回传飞书权限确认卡片');
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

      const sendMarkdownCalls = feishuApi.calls.filter((c) => c.type === 'sendMarkdown' && c.text && c.text.includes(uniqueText));
      assert.equal(sendMarkdownCalls.length, 1, '相同回复文本不应被重复发送');
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

      const sendToA = feishuApi.calls.filter((c) => c.type === 'sendMarkdown' && c.chatId === chatIdA);
      assert.ok(sendToA.length >= 1, 'chatA 应收到回复');

      const sendToB = feishuApi.calls.filter((c) => c.type === 'sendMarkdown' && c.chatId === chatIdB);
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

      const session1Send = feishuLocal.calls.filter((c) => c.type === 'sendMarkdown' && c.text && c.text.includes('session1 output'));
      assert.equal(session1Send.length, 1, 'session1 输出应发送一次');

      const session2 = ctx.sessionService.listSessions().find((s) => s.id !== session1.id);
      const session2Text = 'session2 exclusive output ' + Date.now();
      dispatcher._handleWatchedSessionEvent(session2, chatId, new AgentEvent(AgentEvent.TYPE_TEXT, { text: session2Text }));
      dispatcher._handleWatchedSessionEvent(session2, chatId, new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'polled' }));
      await new Promise((resolve) => setImmediate(resolve));

      const allSendText = feishuLocal.calls.filter((c) => c.type === 'sendMarkdown');
      const session2Duplicates = allSendText.filter((c) => c.text && c.text.includes(session2Text));
      assert.ok(session2Duplicates.length <= 1, 'session2 输出不应重复发送');
    });
  });

  describe('飞书 /clear 全链路集成', () => {
    function makeClearHarness(opts) {
      opts = opts || {};
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-feishu-clear-'));
      const stateStore = new JsonStore(path.join(tmpDir, 'state.json'), {});
      const sessionService = new SessionService({ stateStore });
      const chatId = opts.chatId || 'oc_chat_clear';
      const routeKey = opts.routeKey || buildRouteKey({ chatId, rootId: '' }, 'thread');
      const cwd = opts.cwd || process.cwd();
      const runtimeId = opts.runtimeId || 'runtime-clear-e2e';
      const opencodeSessionId = opts.opencodeSessionId || 'ses_old_e2e';
      const model = opts.model || { modelID: 'gpt-4o' };

      sessionService.setRouteCwd(routeKey, cwd);

      const bridge = new OpencodeTuiBridge({
        sessionService,
        promptTimeoutMs: opts.promptTimeoutMs || 1500,
        runtimeStaleMs: opts.runtimeStaleMs || 60000,
      });
      bridge.register({
        runtimeId,
        sessionId: opencodeSessionId,
        cwd,
        opencodeVersion: '1.17.20',
        bridgeProtocolVersion: 2,
      });
      const walkerSession = sessionService.getCurrent(routeKey);
      if (model) sessionService.updateSessionField(walkerSession.id, 'model', model);

      let networkCalls = 0;
      let createSessionCalls = 0;
      const driver = new OpencodeDriver({
        serverUrl: 'http://localhost:4096',
        tuiBridge: bridge,
        httpClient: {
          request: async () => {
            networkCalls++;
            throw new Error('clear bridge must not use HTTP');
          },
        },
        sseClient: {
          connect: async () => {
            networkCalls++;
            throw new Error('clear bridge must not use SSE');
          },
        },
      });
      const realCreateSession = driver.createSession.bind(driver);
      driver.createSession = async (...args) => {
        createSessionCalls++;
        return realCreateSession(...args);
      };

      const feishuApi = makeFeishuStub();
      dispatcher = new MessageDispatcher({
        sessionService,
        driverRegistry: { get: () => driver },
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      return {
        tmpDir, sessionService, bridge, driver, feishuApi, dispatcher,
        routeKey, chatId, cwd, runtimeId, opencodeSessionId, walkerSession, model,
        networkCalls, createSessionCalls,
        getNetworkCalls: () => networkCalls,
        getCreateSessionCalls: () => createSessionCalls,
        cleanup() {
          if (dispatcher) { dispatcher.destroy(); dispatcher = null; }
          bridge.close();
          fs.rmSync(tmpDir, { recursive: true, force: true });
        },
        async sendClear(messageId) {
          return dispatcher.handleCommand({
            name: 'clear',
            routeKey,
            chatId,
            messageId: messageId || ('om_clear_' + Math.random().toString(36).slice(2, 8)),
          });
        },
      };
    }

    async function pollClearDelivery(h) {
      return pollDelivery(h.bridge, h.runtimeId, h.opencodeSessionId, 1000);
    }

    function completeClear(h, delivery, newSessionId, order) {
      const newSes = newSessionId || 'ses_new_e2e';
      const registerPayload = {
        runtimeId: h.runtimeId,
        sessionId: newSes,
        cwd: h.cwd,
        controlDeliveryId: delivery.deliveryId,
        opencodeVersion: '1.17.20',
      };
      const controlPayload = {
        runtimeId: h.runtimeId,
        sessionId: h.opencodeSessionId,
        deliveryId: delivery.deliveryId,
        control: { type: 'clear', newSessionId: newSes },
      };
      if (order === 'control-first') {
        h.bridge.reportEvents(controlPayload);
        h.bridge.register(registerPayload);
      } else if (order === 'register-first') {
        h.bridge.register(registerPayload);
        h.bridge.reportEvents(controlPayload);
      } else {
        h.bridge.register(registerPayload);
        h.bridge.reportEvents(controlPayload);
      }
      return newSes;
    }

    it('飞书 /clear 在当前 TUI 创建空上下文（control 携带新 session ID）', async () => {
      const h = makeClearHarness();
      try {
        const clearPromise = h.sendClear();
        const delivery = await pollClearDelivery(h);
        assert.equal(delivery.type, 'clear', 'delivery 类型应为 clear');
        assert.equal(delivery.sessionId, h.opencodeSessionId, 'delivery 指向旧 OpenCode session');

        const newSes = completeClear(h, delivery, 'ses_new_a');

        const result = await clearPromise;
        assert.ok(result.cleared, 'handleCommand 应返回 cleared:true');
        assert.equal(result.oldSessionId, h.opencodeSessionId);
        assert.equal(result.newSessionId, newSes);
        assert.ok(result.walkerSessionId, '应返回新 walker session id');

        const reply = h.feishuApi.calls.find((c) => c.type === 'replyText' && c.text && c.text.includes('Cleared session'));
        assert.ok(reply, '应回复 clear 成功消息');
      } finally {
        h.cleanup();
      }
    });

    it('clear 全链路不访问独立服务或 createSession', async () => {
      const h = makeClearHarness();
      try {
        const clearPromise = h.sendClear();
        const delivery = await pollClearDelivery(h);
        completeClear(h, delivery, 'ses_new_nohost');
        await clearPromise;

        assert.equal(h.getNetworkCalls(), 0, 'clear 不应访问独立 OpenCode HTTP/SSE');
        assert.equal(h.getCreateSessionCalls(), 0, 'clear 不应调用 driver.createSession()');
      } finally {
        h.cleanup();
      }
    });

    for (const order of ['control-first', 'register-first']) {
      it('关联 register 与 control 完成后 route 焦点切换（' + order + '）', async () => {
        const h = makeClearHarness();
        try {
          const clearPromise = h.sendClear();
          const delivery = await pollClearDelivery(h);

          const currentBefore = h.sessionService.getCurrent(h.routeKey);
          assert.equal(currentBefore.agentRef.opencodeSessionId, h.opencodeSessionId,
            order + ': 汇合前 route 焦点应保持旧 session');
          assert.equal(h.bridge.runtimes.get(h.runtimeId).currentSessionId, h.opencodeSessionId,
            order + ': 汇合前 runtime 当前 session 应保持旧 session');

          const newSes = completeClear(h, delivery, 'ses_new_order', order);
          await clearPromise;

          const currentAfter = h.sessionService.getCurrent(h.routeKey);
          assert.equal(currentAfter.agentRef.opencodeSessionId, newSes,
            order + ': 汇合后 route 焦点应切换到新 session');
          assert.equal(h.bridge.runtimes.get(h.runtimeId).currentSessionId, newSes,
            order + ': 汇合后 runtime 当前 session 应为新 session');
        } finally {
          h.cleanup();
        }
      });
    }

    it('clear 后旧 session 仍在 route 且可通过 setFocus 恢复', async () => {
      const h = makeClearHarness();
      try {
        const clearPromise = h.sendClear();
        const delivery = await pollClearDelivery(h);
        completeClear(h, delivery, 'ses_new_keep');
        await clearPromise;

        const sessionsInRoute = h.sessionService.listSessionsInRoute(h.routeKey);
        const oldStillInRoute = sessionsInRoute.find((s) => s.agentRef && s.agentRef.opencodeSessionId === h.opencodeSessionId);
        assert.ok(oldStillInRoute, '旧 session 应保留在 route 中');
        assert.notEqual(oldStillInRoute.status, 'stopped', '旧 session 不应被 stop');
        assert.notEqual(oldStillInRoute.status, 'deleted', '旧 session 不应被 delete');

        h.sessionService.setFocus(h.routeKey, oldStillInRoute.id);
        const restored = h.sessionService.getCurrent(h.routeKey);
        assert.equal(restored.id, oldStillInRoute.id, '旧 session 可通过 setFocus 恢复为焦点');
      } finally {
        h.cleanup();
      }
    });

    it('新 session 继承 model 与 cwd', async () => {
      const h = makeClearHarness({ model: { modelID: 'claude-3.5-sonnet' } });
      try {
        const clearPromise = h.sendClear();
        const delivery = await pollClearDelivery(h);
        const newSes = completeClear(h, delivery, 'ses_new_inherit');
        const result = await clearPromise;

        const newWalker = h.sessionService.getSession(result.walkerSessionId);
        assert.deepEqual(newWalker.model, { modelID: 'claude-3.5-sonnet' }, '新 session 应继承旧 model');
        assert.equal(newWalker.cwd, h.cwd, '新 session cwd 应来自关联 register');
        assert.equal(newWalker.agentRef.opencodeSessionId, newSes, '新 session agentRef 指向新 OpenCode session');
      } finally {
        h.cleanup();
      }
    });

    it('注入无关普通 register 不阻断 clear 且不提前改变原 route 焦点', async () => {
      const h = makeClearHarness();
      try {
        const clearPromise = h.sendClear();
        const delivery = await pollClearDelivery(h);

        h.bridge.register({
          runtimeId: h.runtimeId,
          sessionId: 'ses_unrelated',
          cwd: h.cwd,
          opencodeVersion: '1.17.20',
        });

        const currentAfterUnrelated = h.sessionService.getCurrent(h.routeKey);
        assert.notEqual(currentAfterUnrelated.agentRef.opencodeSessionId, h.opencodeSessionId,
          '普通 register 会聚焦自己的新 session（与 clear 无关）');

        const runtimeCurrent = h.bridge.runtimes.get(h.runtimeId).currentSessionId;
        assert.equal(runtimeCurrent, 'ses_unrelated',
          '普通 register 更新 runtime 当前 session');

        completeClear(h, delivery, 'ses_new_isolated');
        const result = await clearPromise;
        assert.equal(result.newSessionId, 'ses_new_isolated',
          'clear 仍可在普通 register 后完成');
        const finalCurrent = h.sessionService.getCurrent(h.routeKey);
        assert.equal(finalCurrent.agentRef.opencodeSessionId, 'ses_new_isolated',
          'clear 完成后焦点切换到新 session');
      } finally {
        h.cleanup();
      }
    });

    it('错误关联 ID 的 register 被拒绝且不回退为普通注册', async () => {
      const h = makeClearHarness();
      try {
        const clearPromise = h.sendClear();
        const delivery = await pollClearDelivery(h);

        assert.throws(
          () => h.bridge.register({
            runtimeId: h.runtimeId,
            sessionId: 'ses_unknown',
            cwd: h.cwd,
            controlDeliveryId: 'del_nonexistent',
          }),
          /unknown|controlDeliveryId|关联|过期|expired/i,
          '未知 controlDeliveryId 应被拒绝',
        );

        const current = h.sessionService.getCurrent(h.routeKey);
        assert.equal(current.agentRef.opencodeSessionId, h.opencodeSessionId,
          '被拒绝的 register 不应改变 route 焦点');

        completeClear(h, delivery, 'ses_new_reject');
        await clearPromise;
      } finally {
        h.cleanup();
      }
    });

    it('同一 runtime 并发 clear 在投递前失败且只创建一个新 OpenCode session', async () => {
      const h = makeClearHarness();
      try {
        const first = h.sendClear('om_clear_concurrent_1');
        const delivery = await pollClearDelivery(h);
        assert.ok(delivery, '第一个 clear 应投递 delivery');

        const secondResult = await h.sendClear('om_clear_concurrent_2');
        assert.ok(secondResult.busy || secondResult.rejected || secondResult.error,
          '第二个 clear 应在投递前被拒绝');

        const replyCalls = h.feishuApi.calls.filter((c) => c.type === 'replyText');
        const rejectReply = replyCalls.find((c) => c.text && /clear|在途|in progress|in flight/i.test(c.text));
        assert.ok(rejectReply, '应回复并发 clear 拒绝消息');

        completeClear(h, delivery, 'ses_new_concurrent');
        await first;

        const newSessions = h.sessionService.listSessions().filter((s) =>
          s.agentRef && s.agentRef.opencodeSessionId === 'ses_new_concurrent');
        assert.equal(newSessions.length, 1, '只创建一个新 Walker session');
      } finally {
        h.cleanup();
      }
    });

    it('stale runtime 与运行中 clear 保持旧焦点', async () => {
      const h = makeClearHarness({ runtimeStaleMs: 50 });
      try {
        await new Promise((r) => setTimeout(r, 80));
        const result = await h.sendClear();
        assert.ok(result.error, 'stale runtime 时应返回错误');

        const current = h.sessionService.getCurrent(h.routeKey);
        assert.equal(current.agentRef.opencodeSessionId, h.opencodeSessionId,
          'stale runtime 时旧焦点不变');
      } finally {
        h.cleanup();
      }
    });

    it('运行中 /clear 在 route lock 外立即提示先 /cancel', async () => {
      const h = makeClearHarness();
      try {
        const current = h.sessionService.getCurrent(h.routeKey);
        h.sessionService.markRunning(current.id);
        h.dispatcher.turnStates.set(current.id, { token: 1, cancelled: false });

        const result = await h.sendClear();
        assert.ok(result.busy || result.rejected, '运行中应立即拒绝');

        const reply = h.feishuApi.calls.find((c) => c.type === 'replyText' && c.text && /cancel/i.test(c.text));
        assert.ok(reply, '应提示先执行 /cancel');

        h.dispatcher.turnStates.delete(current.id);
        h.sessionService.markIdle(current.id);

        const stillCurrent = h.sessionService.getCurrent(h.routeKey);
        assert.equal(stillCurrent.agentRef.opencodeSessionId, h.opencodeSessionId,
          '运行中拒绝后旧焦点不变，且不会自动执行 clear');
      } finally {
        h.cleanup();
      }
    });

    it('clear error 可恢复（旧焦点不变，pending 清理）', async () => {
      const h = makeClearHarness();
      try {
        const errorPromise = h.sendClear('om_clear_err_1');
        const delivery = await pollClearDelivery(h);
        h.bridge.reportEvents({
          runtimeId: h.runtimeId,
          sessionId: h.opencodeSessionId,
          deliveryId: delivery.deliveryId,
          error: 'SDK create failed',
        });
        const errorResult = await errorPromise;
        assert.ok(errorResult.error, '插件 error 应返回错误');

        const currentAfterError = h.sessionService.getCurrent(h.routeKey);
        assert.equal(currentAfterError.agentRef.opencodeSessionId, h.opencodeSessionId,
          'error 后旧焦点不变');
        assert.equal(h.bridge._clearPending.size, 0, 'error 后 pending 应清理');
      } finally {
        h.cleanup();
      }
    });

    it('clear 超时可恢复（旧焦点不变，pending 清理）', async () => {
      const h = makeClearHarness({ promptTimeoutMs: 50 });
      try {
        const timeoutPromise = h.sendClear('om_clear_timeout_1');
        const keepAlive = setInterval(() => {}, 10);
        const timeoutResult = await timeoutPromise;
        clearInterval(keepAlive);
        assert.ok(timeoutResult.error, '超时应返回错误，实际: ' + JSON.stringify(timeoutResult));

        assert.equal(h.bridge._clearPending.size, 0, '超时后 pending 应清理');
        const currentAfterTimeout = h.sessionService.getCurrent(h.routeKey);
        assert.equal(currentAfterTimeout.agentRef.opencodeSessionId, h.opencodeSessionId,
          '超时后旧焦点不变');
      } finally {
        h.cleanup();
      }
    });

    it('超时后迟到 control 与关联 register 均不切换焦点', async () => {
      const h = makeClearHarness({ promptTimeoutMs: 100 });
      try {
        const timeoutPromise = h.sendClear('om_clear_late_1');
        const delivery = await pollClearDelivery(h);
        const keepAlive = setInterval(() => {}, 10);
        await timeoutPromise;
        clearInterval(keepAlive);

        assert.throws(
          () => h.bridge.reportEvents({
            runtimeId: h.runtimeId,
            sessionId: h.opencodeSessionId,
            deliveryId: delivery.deliveryId,
            control: { type: 'clear', newSessionId: 'ses_late' },
          }),
          /unknown|过期|expired|delivery/i,
          '超时后迟到 control 应被拒绝',
        );
        assert.throws(
          () => h.bridge.register({
            runtimeId: h.runtimeId,
            sessionId: 'ses_late',
            cwd: h.cwd,
            controlDeliveryId: delivery.deliveryId,
          }),
          /unknown|过期|expired|controlDeliveryId/i,
          '超时后迟到 register 应被拒绝',
        );

        const current = h.sessionService.getCurrent(h.routeKey);
        assert.equal(current.agentRef.opencodeSessionId, h.opencodeSessionId,
          '迟到事件不切换焦点');
      } finally {
        h.cleanup();
      }
    });

    it('clear 后现有 prompt 双向链路仍正常工作', async () => {
      const h = makeClearHarness();
      try {
        const clearPromise = h.sendClear('om_clear_then_prompt');
        const delivery = await pollClearDelivery(h);
        const newSes = completeClear(h, delivery, 'ses_new_then_prompt');
        await clearPromise;
        await new Promise((r) => setTimeout(r, 0));

        const promptResult = h.dispatcher.handleIncomingMessage({
          messageId: 'om_msg_after_clear',
          chatId: h.chatId,
          text: 'hello after clear',
        });

        h.bridge.runtimes.get(h.runtimeId);
        const newDelivery = await pollDelivery(h.bridge, h.runtimeId, newSes, 3000);
        h.bridge.runtimes.get(h.runtimeId);
        const pendingEntry = h.bridge.pending.get(newDelivery.deliveryId);
        assert.ok(newDelivery, '应拿到 prompt delivery');
        assert.equal(newDelivery.type, 'prompt', 'clear 后 prompt delivery 类型应为 prompt');
        assert.equal(newDelivery.text, 'hello after clear');
        assert.equal(newDelivery.sessionId, newSes);
        assert.ok(pendingEntry, 'pending 应有该 delivery 条目');

        h.bridge.reportEvents({
          runtimeId: h.runtimeId,
          sessionId: newSes,
          deliveryId: newDelivery.deliveryId,
          events: [
            { type: AgentEvent.TYPE_TEXT, data: { text: 'reply after clear' } },
            { type: AgentEvent.TYPE_DONE, data: { reason: 'idle' } },
          ],
        });

        assert.equal(await promptResult, 'prompted');

        const reply = h.feishuApi.calls.find((c) =>
          c.type === 'replyMarkdown' && c.text && c.text.includes('reply after clear'));
        assert.ok(reply, 'clear 后 prompt 回复应回到飞书');
      } finally {
        h.cleanup();
      }
    });
  });

  describe('v3 租约协议长任务与 v2 兼容', () => {
    it('v3 accepted/heartbeat/final 长任务超过旧固定阈值仍完成', async () => {
      const chatId = 'oc_chat_v3_long';
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const cwd = process.cwd();
      const runtimeId = 'runtime-v3-long';
      const opencodeSessionId = 'ses_v3_long';

      ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd });
      ctx.sessionService.setRouteCwd(routeKey, cwd);

      const bridge = new OpencodeTuiBridge({
        sessionService: ctx.sessionService,
        leaseTimeoutMs: 5000,
        heartbeatIntervalMs: 1000,
        runtimeStaleMs: 60000,
      });
      bridge.register({ runtimeId, sessionId: opencodeSessionId, cwd, opencodeVersion: '1.17.20' });

      const driver = new OpencodeDriver({
        serverUrl: 'http://localhost:4096',
        tuiBridge: bridge,
        httpClient: { request: async () => { throw new Error('no http'); } },
        sseClient: { connect: async () => { throw new Error('no sse'); } },
      });

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => driver },
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      const promptResult = dispatcher.handleIncomingMessage({
        messageId: 'om_msg_v3_long',
        chatId,
        text: 'long running task',
      });

      const delivery = await pollDelivery(bridge, runtimeId, opencodeSessionId);
      assert.equal(delivery.text, 'long running task');

      bridge.reportEvents({
        runtimeId, sessionId: opencodeSessionId, deliveryId: delivery.deliveryId,
        deliveryState: 'accepted',
        events: [],
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      const pendingAfterAccepted = bridge.pending.get(delivery.deliveryId);
      assert.ok(pendingAfterAccepted, 'accepted 后 pending 应存在');
      assert.equal(pendingAfterAccepted.state, 'leased', '状态应为 leased');

      bridge.reportEvents({
        runtimeId, sessionId: opencodeSessionId, deliveryId: delivery.deliveryId,
        deliveryState: 'heartbeat',
        events: [],
      });

      await new Promise((resolve) => setTimeout(resolve, 50));
      const pendingAfterHeartbeat = bridge.pending.get(delivery.deliveryId);
      assert.ok(pendingAfterHeartbeat, 'heartbeat 后 pending 应仍存在');
      assert.equal(pendingAfterHeartbeat.state, 'leased', 'heartbeat 后仍为 leased');

      bridge.reportEvents({
        runtimeId, sessionId: opencodeSessionId, deliveryId: delivery.deliveryId,
        deliveryState: 'final',
        events: [
          { type: AgentEvent.TYPE_TEXT, data: { text: 'v3 long task result' } },
          { type: AgentEvent.TYPE_DONE, data: { reason: 'idle' } },
        ],
      });

      assert.equal(await promptResult, 'prompted');

      const reply = feishuApi.calls.find((c) =>
        c.type === 'replyMarkdown' && c.text && c.text.includes('v3 long task result'));
      assert.ok(reply, 'v3 长任务最终结果应到达飞书');
      bridge.close();
    });

    it('v2 plugin 无 deliveryState 时按 final 兼容完成 prompt', async () => {
      const chatId = 'oc_chat_v2_compat';
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const cwd = process.cwd();
      const runtimeId = 'runtime-v2-compat';
      const opencodeSessionId = 'ses_v2_compat';

      ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd });
      ctx.sessionService.setRouteCwd(routeKey, cwd);

      const bridge = new OpencodeTuiBridge({
        sessionService: ctx.sessionService,
        leaseTimeoutMs: 5000,
        heartbeatIntervalMs: 1000,
        runtimeStaleMs: 60000,
      });
      bridge.register({ runtimeId, sessionId: opencodeSessionId, cwd, opencodeVersion: '1.17.20' });

      const driver = new OpencodeDriver({
        serverUrl: 'http://localhost:4096',
        tuiBridge: bridge,
        httpClient: { request: async () => { throw new Error('no http'); } },
        sseClient: { connect: async () => { throw new Error('no sse'); } },
      });

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => driver },
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      const promptResult = dispatcher.handleIncomingMessage({
        messageId: 'om_msg_v2_compat',
        chatId,
        text: 'v2 compat task',
      });

      const delivery = await pollDelivery(bridge, runtimeId, opencodeSessionId);
      assert.equal(delivery.text, 'v2 compat task');

      bridge.reportEvents({
        runtimeId, sessionId: opencodeSessionId, deliveryId: delivery.deliveryId,
        events: [
          { type: AgentEvent.TYPE_TEXT, data: { text: 'v2 compat reply' } },
          { type: AgentEvent.TYPE_DONE, data: { reason: 'idle' } },
        ],
      });

      assert.equal(await promptResult, 'prompted');

      const reply = feishuApi.calls.find((c) =>
        c.type === 'replyMarkdown' && c.text && c.text.includes('v2 compat reply'));
      assert.ok(reply, 'v2 兼容 final 应到达飞书');
      bridge.close();
    });

    it('transport_lost tombstone 迟到 final 补投至 watcher 且至多一次', async () => {
      const chatId = 'oc_chat_tomb_recover';
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const cwd = process.cwd();
      const runtimeId = 'runtime-tomb-recover';
      const opencodeSessionId = 'ses_tomb_recover';

      ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd });
      ctx.sessionService.setRouteCwd(routeKey, cwd);

      const bridge = new OpencodeTuiBridge({
        sessionService: ctx.sessionService,
        leaseTimeoutMs: 100,
        heartbeatIntervalMs: 30,
        runtimeStaleMs: 60000,
        tombstoneTtlMs: 30000,
      });
      bridge.register({ runtimeId, sessionId: opencodeSessionId, cwd, opencodeVersion: '1.17.20' });

      const driver = new OpencodeDriver({
        serverUrl: 'http://localhost:4096',
        tuiBridge: bridge,
        httpClient: { request: async () => { throw new Error('no http'); } },
        sseClient: { connect: async () => { throw new Error('no sse'); } },
      });

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => driver },
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      const promptResult = dispatcher.handleIncomingMessage({
        messageId: 'om_msg_tomb_recover',
        chatId,
        text: 'tomb recover task',
      });

      const delivery = await pollDelivery(bridge, runtimeId, opencodeSessionId);

      bridge.reportEvents({
        runtimeId, sessionId: opencodeSessionId, deliveryId: delivery.deliveryId,
        deliveryState: 'accepted',
        events: [],
      });

      await new Promise((resolve) => setTimeout(resolve, 200));

      try {
        await Promise.race([
          promptResult,
          new Promise((resolve) => setTimeout(() => { resolve('timeout'); }, 50)),
        ]);
        await Promise.race([promptResult.then(() => 'done'), new Promise((r) => setTimeout(() => r('pending'), 10))]);
      } catch (_) {
        ;
      }

      const tombstone = bridge._tombstones.get(delivery.deliveryId);
      assert.ok(tombstone, '租约超时应创建 transport_lost tombstone');
      assert.equal(tombstone.reason, 'transport_lost');

      bridge.reportEvents({
        runtimeId, sessionId: opencodeSessionId, deliveryId: delivery.deliveryId,
        deliveryState: 'final',
        events: [
          { type: AgentEvent.TYPE_TEXT, data: { text: 'recovered late reply' } },
          { type: AgentEvent.TYPE_DONE, data: { reason: 'idle' } },
        ],
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      bridge.reportEvents({
        runtimeId, sessionId: opencodeSessionId, deliveryId: delivery.deliveryId,
        deliveryState: 'final',
        events: [
          { type: AgentEvent.TYPE_TEXT, data: { text: 'recovered late reply' } },
          { type: AgentEvent.TYPE_DONE, data: { reason: 'idle' } },
        ],
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const recoveredReplies = feishuApi.calls.filter((c) =>
        c.type === 'sendMarkdown' && c.text && c.text.includes('recovered late reply'));
      assert.ok(recoveredReplies.length <= 1, '迟到 final 至多投递一次到飞书');
      bridge.close();
    });

    it('cancelled tombstone 迟到 final 被抑制不投递到飞书', async () => {
      const chatId = 'oc_chat_tomb_cancel';
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const cwd = process.cwd();
      const runtimeId = 'runtime-tomb-cancel';
      const opencodeSessionId = 'ses_tomb_cancel';

      ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd });
      ctx.sessionService.setRouteCwd(routeKey, cwd);

      const bridge = new OpencodeTuiBridge({
        sessionService: ctx.sessionService,
        leaseTimeoutMs: 5000,
        heartbeatIntervalMs: 1000,
        runtimeStaleMs: 60000,
        tombstoneTtlMs: 30000,
      });
      bridge.register({ runtimeId, sessionId: opencodeSessionId, cwd, opencodeVersion: '1.17.20' });

      const driver = new OpencodeDriver({
        serverUrl: 'http://localhost:4096',
        tuiBridge: bridge,
        httpClient: { request: async () => { throw new Error('no http'); } },
        sseClient: { connect: async () => { throw new Error('no sse'); } },
      });

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => driver },
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      const promptResult = dispatcher.handleIncomingMessage({
        messageId: 'om_msg_tomb_cancel',
        chatId,
        text: 'tomb cancel task',
      });

      const delivery = await pollDelivery(bridge, runtimeId, opencodeSessionId);

      bridge.reportEvents({
        runtimeId, sessionId: opencodeSessionId, deliveryId: delivery.deliveryId,
        deliveryState: 'accepted',
        events: [],
      });

      await new Promise((resolve) => setImmediate(resolve));

      await dispatcher.handleCommand({
        type: 'command', name: 'cancel', args: [],
        routeKey, messageId: 'om_cancel_tomb_cmd', chatId,
      });

      const tombstone = bridge._tombstones.get(delivery.deliveryId);
      assert.ok(tombstone, 'cancel 应创建 cancelled tombstone');
      assert.equal(tombstone.reason, 'cancelled');

      bridge.reportEvents({
        runtimeId, sessionId: opencodeSessionId, deliveryId: delivery.deliveryId,
        deliveryState: 'final',
        events: [
          { type: AgentEvent.TYPE_TEXT, data: { text: 'cancelled late reply' } },
          { type: AgentEvent.TYPE_DONE, data: { reason: 'idle' } },
        ],
      });

      await new Promise((resolve) => setTimeout(resolve, 100));

      const cancelledReplies = feishuApi.calls.filter((c) =>
        c.type === 'sendMarkdown' && c.text && c.text.includes('cancelled late reply'));
      assert.equal(cancelledReplies.length, 0, 'cancelled tombstone 迟到 final 不应投递到飞书');

      assert.equal(await promptResult, 'cancelled');
      bridge.close();
    });

    it('相同 completed text 经 prompt 和 watcher 两路径只回复一次', async () => {
      const chatId = 'oc_chat_dedup_pw';
      const routeKey = buildRouteKey({ chatId, rootId: '' }, 'thread');
      const cwd = process.cwd();
      const agentRef = { opencodeSessionId: 'ses_dedup_pw', serverUrl: 'http://localhost:4096', cwd };

      ctx.sessionService.createSession({ route: routeKey, agent: 'opencode', cwd, agentRef });
      ctx.sessionService.setRouteCwd(routeKey, cwd);

      let watchHandlers = null;
      const driver = {
        ensureReady: async () => true,
        prompt: async () => [
          new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'shared answer' }),
          new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }),
        ],
        watchSession: (_ref, handlers) => { watchHandlers = handlers; return () => { watchHandlers = null; }; },
        stop: async () => {},
        delete: async () => {},
        resumeSession: async (ref) => ref,
        listModels: async () => [],
        listSessions: async () => [],
        createSession: async () => ({ opencodeSessionId: 'ses_new' }),
      };

      dispatcher = new MessageDispatcher({
        sessionService: ctx.sessionService,
        driverRegistry: { get: () => driver },
        feishuApi,
        dedup: new MessageDedup({ windowMs: 300000 }),
        routeMode: 'thread',
      });

      await dispatcher.handleIncomingMessage({
        messageId: 'om_msg_dedup_pw',
        chatId,
        text: 'dedup test',
      });

      if (watchHandlers) {
        watchHandlers.onEvent(new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'shared answer' }));
        watchHandlers.onEvent(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'polled' }));
      }
      await new Promise((resolve) => setImmediate(resolve));

      const replies = feishuApi.calls.filter((c) =>
        (c.type === 'replyMarkdown' || c.type === 'sendMarkdown') && c.text && c.text.includes('shared answer'));
      assert.equal(replies.length, 1, '相同文本只投递一次');
    });
  });
});
