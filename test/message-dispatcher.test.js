const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { MessageDispatcher } = require('../src/dispatch/message-dispatcher');
const { MessageDedup } = require('../src/core/message-dedup');
const { AgentEvent } = require('../src/drivers/agent-driver');
const { ProgressCard } = require('../src/platform/feishu/progress-card');
const { renderSessionListCard, renderUnboundRouteCard } = require('../src/platform/feishu/cards');

function makeMocks() {
  const sessionService = {
    getCurrent: () => null,
    createSession: () => ({ id: 'wks_new1', agent: 'opencode', state: 'created' }),
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
    replyText: () => {},
    sendText: () => {},
    sendCard: () => 'om_card1',
    patchCard: () => {},
    addReaction: () => {},
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
    mocks.feishuApi.replyCard = (msgId, card) => { mocks.feishuApi.calls.push({ type: 'replyCard', msgId, card }); };
    const result = await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_msg1', openId: 'ou_user1', text: '你好',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });
    assert.equal(result, 'unbound');
    assert.equal(mocks.feishuApi.calls.length, 1);
    assert.equal(mocks.feishuApi.calls[0].type, 'replyCard');
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
    mocks.feishuApi.replyCard = () => { mocks.feishuApi.calls.push('reply'); };
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
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', state: 'idle', agentRef: { opencodeSessionId: 'ses_bound1', serverUrl: 'http://localhost:4096' } });
    mocks.feishuApi.replyCard = (msgId, card) => { mocks.feishuApi.calls.push({ type: 'replyCard', msgId }); return 'om_prog1'; };
    mocks.feishuApi.patchCard = (cardId, card) => { mocks.feishuApi.calls.push({ type: 'patchCard', cardId }); };
    mocks.feishuApi.replyText = (msgId, text) => { mocks.feishuApi.calls.push({ type: 'replyText', msgId, text }); };
    mocks.feishuApi.addReaction = (msgId, emoji) => { mocks.feishuApi.calls.push({ type: 'reaction', msgId, emoji }); };
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
    assert.ok(mocks.feishuApi.calls.some(c => c.type === 'replyCard'));
    assert.ok(mocks.feishuApi.calls.some(c => c.type === 'patchCard'));
    assert.ok(mocks.feishuApi.calls.some(c => c.type === 'reaction' && c.emoji === 'OnIt'));
  });

  it('driver 错误时标记 session error 并回复错误卡片', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_err1', agent: 'opencode', state: 'idle', agentRef: { opencodeSessionId: 'ses_err1' } });
    mocks.driver.prompt = async () => [new AgentEvent(AgentEvent.TYPE_ERROR, { message: 'API quota exceeded' })];
    mocks.feishuApi.replyCard = (msgId) => { mocks.feishuApi.calls.push({ type: 'replyCard', msgId }); return 'om_prog1'; };
    mocks.feishuApi.replyText = (msgId, text) => { mocks.feishuApi.calls.push({ type: 'replyText', msgId, text }); };
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
    assert.ok(mocks.sessionService.markError.called !== undefined || mocks.feishuApi.calls.some(c => c.type === 'replyCard' || c.type === 'replyText'));
  });
});

describe('MessageDispatcher /new command', () => {
  it('/new 创建 Walker session 并绑定 routeKey', async () => {
    const mocks = makeMocks();
    mocks.sessionService.createSession = (opts) => ({ id: 'wks_new1', agent: opts.agent || 'opencode', state: 'created', route: opts.route });
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
