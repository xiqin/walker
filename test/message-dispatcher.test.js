const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { MessageDispatcher } = require('../src/dispatch/message-dispatcher');
const { MessageDedup } = require('../src/core/message-dedup');
const { AgentEvent } = require('../src/drivers/agent-driver');

function makeMocks() {
  const sessionService = {
    getCurrent: () => null,
    createSession: () => ({ id: 'wks_new1', agent: 'opencode', status: 'created' }),
    bindRoute: () => {},
    markRunning: () => {},
    markIdle: () => {},
    markError: () => {},
    listSessions: () => [],
  };
  const driver = {
    ensureReady: async () => true,
    createSession: async () => ({ opencodeSessionId: 'ses_new1', serverUrl: 'http://localhost:4096' }),
    prompt: async () => [new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'Hello' }), new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' })],
    stop: async () => {},
    resumeSession: async (ref) => ref,
  };
  const driverRegistry = { get: () => driver };
  const feishuApi = {
    replyText: (msgId, text) => { feishuApi.calls.push({ type: 'replyText', msgId, text }); },
    sendText: (chatId, text) => { feishuApi.calls.push({ type: 'sendText', chatId, text }); },
    replyCard: (msgId, card) => { feishuApi.calls.push({ type: 'replyCard', msgId, card }); return 'om_card1'; },
    patchCard: (cardId, card) => { feishuApi.calls.push({ type: 'patchCard', cardId, card }); },
    addReaction: (msgId, emoji) => { feishuApi.calls.push({ type: 'addReaction', msgId, emoji }); },
    sendUnboundGuide: (msgId, routeKey) => { feishuApi.calls.push({ type: 'sendUnboundGuide', msgId, routeKey }); },
    sendSessionList: (msgId, sessions, currentId) => { feishuApi.calls.push({ type: 'sendSessionList', msgId, sessions, currentId }); },
    sendErrorCard: (msgId, message) => { feishuApi.calls.push({ type: 'sendErrorCard', msgId, message }); },
    sendProgressCard: (msgId, sessionId, initialEvent) => { feishuApi.calls.push({ type: 'sendProgressCard', msgId, sessionId }); return 'om_prog1'; },
    updateProgressCard: (cardId, sessionId, agentEvent) => { feishuApi.calls.push({ type: 'updateProgressCard', cardId, sessionId, agentEvent }); return null; },
    calls: [],
  };
  const dedup = new MessageDedup({ windowMs: 300000 });
  return { sessionService, driver, driverRegistry, feishuApi, dedup };
}

describe('MessageDispatcher unbound route', () => {
  it('未绑定的 routeKey 回复引导卡片', async () => {
    const mocks = makeMocks();
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });
    const result = await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_msg1', openId: 'ou_user1', text: '你好',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });
    assert.equal(result, 'unbound');
    assert.equal(mocks.feishuApi.calls.length, 1);
    assert.equal(mocks.feishuApi.calls[0].type, 'sendUnboundGuide');
  });

  it('重复消息不处理', async () => {
    const mocks = makeMocks();
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });
    await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_dup1', openId: 'ou_user1', text: 'test',
      messageType: 'text', createTime: Date.now(),
    });
    const result = await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_dup1', openId: 'ou_user1', text: 'test',
      messageType: 'text', createTime: Date.now(),
    });
    assert.equal(result, 'duplicate');
    assert.equal(mocks.feishuApi.calls.length, 1);
  });
});

describe('MessageDispatcher bound route prompt', () => {
  it('绑定 session 的消息投递给 driver 并更新进度卡片', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_bound1', serverUrl: 'http://localhost:4096' } });
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      reactionEmoji: 'OnIt',
      doneEmoji: 'none',
      progressStyle: 'card',
    });
    const result = await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_msg1', openId: 'ou_user1', text: '请分析代码',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });
    assert.equal(result, 'prompted');
    assert.ok(mocks.feishuApi.calls.some(c => c.type === 'sendProgressCard'));
    assert.ok(mocks.feishuApi.calls.some(c => c.type === 'updateProgressCard'));
    assert.ok(mocks.feishuApi.calls.some(c => c.type === 'addReaction' && c.emoji === 'OnIt'));
  });

  it('driver 错误时标记 session error 并回复错误卡片', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_err1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_err1' } });
    mocks.driver.prompt = async () => { throw new Error('API quota exceeded'); };
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      progressStyle: 'card',
    });
    await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_err1', openId: 'ou_user1', text: 'test',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });
    assert.ok(mocks.feishuApi.calls.some(c => c.type === 'sendErrorCard'));
  });
});

describe('MessageDispatcher /new command', () => {
  it('/new 创建 Walker session 并绑定 routeKey', async () => {
    const mocks = makeMocks();
    mocks.sessionService.createSession = (opts) => ({ id: 'wks_new1', agent: opts.agent || 'opencode', status: 'created', route: opts.route });
    mocks.sessionService.bindRoute = () => {};
    mocks.feishuApi.replyText = (msgId, text) => { mocks.feishuApi.calls.push({ type: 'replyText', msgId, text }); };
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });
    const result = await dispatcher.handleCommand({
      type: 'command', name: 'new', args: [],
      routeKey: 'feishu:oc_chat1:om_root1',
      messageId: 'om_cmd1', chatId: 'oc_chat1',
    });
    assert.ok(result.sessionId);
  });
});
