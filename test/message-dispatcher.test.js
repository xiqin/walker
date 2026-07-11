const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { MessageDispatcher } = require('../src/dispatch/message-dispatcher');
const { MessageDedup } = require('../src/core/message-dedup');
const { AgentEvent } = require('../src/drivers/agent-driver');

function makeMocks() {
  const sessionService = {
    getCurrent: () => null,
    getSession: () => null,
    createSession: () => ({ id: 'wks_new1', agent: 'opencode', status: 'created' }),
    bindRoute: () => {},
    markRunning: () => {},
    markIdle: () => {},
    markError: () => {},
    deleteSession: () => {},
    listSessions: () => [],
    updateSessionField: () => {},
  };
  const driver = {
    promptCalls: [],
    ensureReady: async () => true,
    createSession: async () => ({ opencodeSessionId: 'ses_new1', serverUrl: 'http://localhost:4096' }),
    listSessions: async () => [],
    watchSession: () => () => {},
    prompt: async (agentRef, text) => {
      driver.promptCalls.push({ agentRef, text });
      return [new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'Hello' }), new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' })];
    },
    stop: async () => {},
    delete: async () => {},
    resumeSession: async (ref) => ref,
    listModels: async () => [],
  };
  const driverRegistry = { get: () => driver };
  const feishuApi = {
    replyText: (msgId, text) => { feishuApi.calls.push({ type: 'replyText', msgId, text }); },
    sendText: (chatId, text) => { feishuApi.calls.push({ type: 'sendText', chatId, text }); },
    replyCard: (msgId, card) => { feishuApi.calls.push({ type: 'replyCard', msgId, card }); return 'om_card1'; },
    patchCard: (cardId, card) => { feishuApi.calls.push({ type: 'patchCard', cardId, card }); },
    addReaction: (msgId, emoji) => { feishuApi.calls.push({ type: 'addReaction', msgId, emoji }); },
    sendUnboundGuide: (msgId, routeKey) => { feishuApi.calls.push({ type: 'sendUnboundGuide', msgId, routeKey }); },
    sendSessionList: (msgId, sessions, currentId, routeKey) => { feishuApi.calls.push({ type: 'sendSessionList', msgId, sessions, currentId, routeKey }); },
    sendAttachableSessionList: (msgId, sessions, options) => { feishuApi.calls.push({ type: 'sendAttachableSessionList', msgId, sessions, options }); },
    sendErrorCard: (msgId, message) => { feishuApi.calls.push({ type: 'sendErrorCard', msgId, message }); },
    sendProgressCard: (msgId, sessionId, initialEvent) => { feishuApi.calls.push({ type: 'sendProgressCard', msgId, sessionId }); return 'om_prog1'; },
    updateProgressCard: (cardId, sessionId, agentEvent) => { feishuApi.calls.push({ type: 'updateProgressCard', cardId, sessionId, agentEvent }); return null; },
    calls: [],
  };
  const dedup = new MessageDedup({ windowMs: 300000 });
  return { sessionService, driver, driverRegistry, feishuApi, dedup };
}

async function captureUnhandledRejections(action) {
  const unhandled = [];
  const onUnhandled = (reason) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const result = await action();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    return { result, unhandled };
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
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

  it('未绑定引导卡片发送失败不会产生未捕获 rejection', async () => {
    const mocks = makeMocks();
    mocks.feishuApi.sendUnboundGuide = () => Promise.reject(new Error('feishu guide failed'));
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    const { result, unhandled } = await captureUnhandledRejections(() => dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_unbound_reject1', openId: 'ou_user1', text: '你好',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    }));

    assert.equal(result, 'unbound');
    assert.deepEqual(unhandled.map((err) => err.message), []);
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

  it('处理中表情发送失败不会产生未捕获 rejection', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_bound1', serverUrl: 'http://localhost:4096' } });
    mocks.feishuApi.addReaction = () => Promise.reject(new Error('reaction failed'));
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      reactionEmoji: 'OnIt',
      progressStyle: 'card',
    });

    const { result, unhandled } = await captureUnhandledRejections(() => dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_reaction_reject1', openId: 'ou_user1', text: '请分析代码',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    }));

    assert.equal(result, 'prompted');
    assert.deepEqual(unhandled.map((err) => err.message), []);
  });

  it('同一 messageId 第一次投递给 driver，第二次才跳过去重', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_bound1', serverUrl: 'http://localhost:4096' } });
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      progressStyle: 'card',
    });
    const event = {
      chatId: 'oc_chat1', messageId: 'om_dup_bound1', openId: 'ou_user1', text: '你好',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    };

    const first = await dispatcher.handleIncomingMessage(event);
    const second = await dispatcher.handleIncomingMessage(event);

    assert.equal(first, 'prompted');
    assert.equal(second, 'duplicate');
    assert.equal(mocks.driver.promptCalls.length, 1);
    assert.equal(mocks.driver.promptCalls[0].text, '你好');
  });

  it('飞书消息进入后先发送思考中卡片，再等待 driver prompt', async () => {
    const mocks = makeMocks();
    const order = [];
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_bound1', serverUrl: 'http://localhost:4096' } });
    mocks.driver.prompt = async () => {
      order.push('prompt');
      return [new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'Hello' }), new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' })];
    };
    mocks.feishuApi.sendProgressCard = () => {
      order.push('card');
      return 'om_prog1';
    };
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      progressStyle: 'card',
    });

    await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_progress_first', openId: 'ou_user1', text: '你好',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });

    assert.deepEqual(order.slice(0, 2), ['card', 'prompt']);
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

  it('错误卡片发送失败不会产生未捕获 rejection', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_err1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_err1' } });
    mocks.driver.prompt = async () => { throw new Error('driver failed'); };
    mocks.feishuApi.sendErrorCard = () => Promise.reject(new Error('error card failed'));
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      progressStyle: 'card',
    });

    const { result, unhandled } = await captureUnhandledRejections(() => dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_error_card_reject1', openId: 'ou_user1', text: 'test',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    }));

    assert.equal(result, 'error');
    assert.deepEqual(unhandled.map((err) => err.message), []);
  });

  it('prompt resolve 后若 session 已 stopped 不回写 idle', async () => {
    const mocks = makeMocks();
    const session = { id: 'wks_stopped1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_stopped1' } };
    let markIdleCalls = 0;
    mocks.sessionService.getCurrent = () => session;
    mocks.sessionService.getSession = () => session;
    mocks.sessionService.markIdle = () => { markIdleCalls += 1; session.status = 'idle'; };
    mocks.driver.prompt = async () => {
      session.status = 'stopped';
      return [new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'late answer' }), new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' })];
    };
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      progressStyle: 'card',
    });

    const result = await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_stop_race1', openId: 'ou_user1', text: 'test',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });

    assert.equal(result, 'prompted');
    assert.equal(session.status, 'stopped');
    assert.equal(markIdleCalls, 0);
  });

  it('prompt reject 后若 session 已 deleted 不回写 error', async () => {
    const mocks = makeMocks();
    const session = { id: 'wks_deleted1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_deleted1' } };
    let markErrorCalls = 0;
    mocks.sessionService.getCurrent = () => session;
    mocks.sessionService.getSession = () => session;
    mocks.sessionService.markError = () => { markErrorCalls += 1; session.status = 'error'; };
    mocks.driver.prompt = async () => {
      session.status = 'deleted';
      throw new Error('late failure');
    };
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      progressStyle: 'card',
    });

    const result = await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_delete_race1', openId: 'ou_user1', text: 'test',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });

    assert.equal(result, 'error');
    assert.equal(session.status, 'deleted');
    assert.equal(markErrorCalls, 0);
  });

  it('连续 delta 文本合并后再更新飞书卡片，避免逐字 patch', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_bound1', serverUrl: 'http://localhost:4096' } });
    mocks.driver.prompt = async () => [
      new AgentEvent(AgentEvent.TYPE_TEXT, { text: '你', delta: true }),
      new AgentEvent(AgentEvent.TYPE_TEXT, { text: '好', delta: true }),
      new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }),
    ];
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      progressStyle: 'card',
    });

    await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_delta1', openId: 'ou_user1', text: 'test',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });

    const updates = mocks.feishuApi.calls.filter(c => c.type === 'updateProgressCard');
    assert.equal(updates.length, 2);
    assert.equal(updates[0].agentEvent.type, AgentEvent.TYPE_TEXT);
    assert.equal(updates[0].agentEvent.data.text, '你好');
    assert.equal(updates[1].agentEvent.type, AgentEvent.TYPE_DONE);
  });

  it('展示前移除 opencode 事件里复述的本轮用户消息', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_bound1', serverUrl: 'http://localhost:4096' } });
    mocks.driver.prompt = async () => [
      new AgentEvent(AgentEvent.TYPE_TEXT, { text: '你是谁', delta: true }),
      new AgentEvent(AgentEvent.TYPE_TEXT, { text: '我是 OpenCode', delta: true }),
      new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }),
    ];
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      progressStyle: 'card',
    });

    await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_echo1', openId: 'ou_user1', text: '你是谁',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });

    const updates = mocks.feishuApi.calls.filter(c => c.type === 'updateProgressCard');
    assert.equal(updates[0].agentEvent.type, AgentEvent.TYPE_TEXT);
    assert.equal(updates[0].agentEvent.data.text, '我是 OpenCode');
    assert.equal(updates[0].agentEvent.data.text.includes('你是谁'), false);
  });

  it('delta 合并结果与最终快照重复时只更新一次文本', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_bound1', serverUrl: 'http://localhost:4096' } });
    mocks.driver.prompt = async () => [
      new AgentEvent(AgentEvent.TYPE_TEXT, { text: '你', delta: true }),
      new AgentEvent(AgentEvent.TYPE_TEXT, { text: '好', delta: true }),
      new AgentEvent(AgentEvent.TYPE_TEXT, { text: '你好' }),
      new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }),
    ];
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      progressStyle: 'card',
    });

    await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_snapshot1', openId: 'ou_user1', text: 'test',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });

    const textUpdates = mocks.feishuApi.calls.filter(c => c.type === 'updateProgressCard' && c.agentEvent.type === AgentEvent.TYPE_TEXT);
    assert.equal(textUpdates.length, 1);
    assert.equal(textUpdates[0].agentEvent.data.text, '你好');
  });

  it('带消息编号的重复最终快照不会再次更新飞书', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_bound1', serverUrl: 'http://localhost:4096' } });
    mocks.driver.prompt = async () => [
      new AgentEvent(AgentEvent.TYPE_TEXT, { text: '我是 OpenCode' }),
      new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'm0008\n我是 OpenCode' }),
      new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }),
    ];
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      progressStyle: 'card',
    });

    await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_numbered_snapshot1', openId: 'ou_user1', text: 'test',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });

    const textUpdates = mocks.feishuApi.calls.filter(c => c.type === 'updateProgressCard' && c.agentEvent.type === AgentEvent.TYPE_TEXT);
    assert.equal(textUpdates.length, 1);
    assert.equal(textUpdates[0].agentEvent.data.text, '我是 OpenCode');
  });

  it('单个文本事件中带消息编号的重复快照会折叠为一份回答', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_bound1', serverUrl: 'http://localhost:4096' } });
    mocks.driver.prompt = async () => [
      new AgentEvent(AgentEvent.TYPE_TEXT, { text: '我是你的代码协作助手，可以在这个仓库里帮你查代码、改代码、跑测试、定位问题或做代码审查。\n\nm0004\n我是你的代码协作助手，可以在这个仓库里帮你查代码、改代码、跑测试、定位问题或做代码审查。' }),
      new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }),
    ];
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      progressStyle: 'card',
    });

    await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_inline_numbered_snapshot1', openId: 'ou_user1', text: '你是谁',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });

    const textUpdates = mocks.feishuApi.calls.filter(c => c.type === 'updateProgressCard' && c.agentEvent.type === AgentEvent.TYPE_TEXT);
    assert.equal(textUpdates.length, 1);
    assert.equal(textUpdates[0].agentEvent.data.text, '我是你的代码协作助手，可以在这个仓库里帮你查代码、改代码、跑测试、定位问题或做代码审查。');
    assert.equal(textUpdates[0].agentEvent.data.text.includes('m0004'), false);
  });

  it('思考事件只更新进度卡片，不作为文本消息单独发送', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_bound1', serverUrl: 'http://localhost:4096' } });
    mocks.driver.prompt = async () => [
      new AgentEvent(AgentEvent.TYPE_REASONING, { text: '正在分析调用链' }),
      new AgentEvent(AgentEvent.TYPE_TEXT, { text: '分析完成' }),
      new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }),
    ];
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      progressStyle: 'card',
    });

    await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_reasoning1', openId: 'ou_user1', text: '分析',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });

    const reasoningUpdates = mocks.feishuApi.calls.filter(c => c.type === 'updateProgressCard' && c.agentEvent.type === AgentEvent.TYPE_REASONING);
    assert.equal(reasoningUpdates.length, 1);
    assert.equal(reasoningUpdates[0].agentEvent.data.text, '正在分析调用链');
    assert.equal(mocks.feishuApi.calls.some(c => c.type === 'sendText' && c.text.includes('正在分析调用链')), false);
    assert.equal(mocks.feishuApi.calls.some(c => c.type === 'replyText' && c.text.includes('正在分析调用链')), false);
  });

  it('prompt 已渲染的回答不会在 watch 恢复后再次发送到飞书', async () => {
    const mocks = makeMocks();
    let watched;
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_bound1', serverUrl: 'http://localhost:4096' } });
    mocks.driver.watchSession = (_agentRef, handlers) => {
      watched = handlers;
      return () => {};
    };
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      progressStyle: 'card',
    });

    await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_watch_dup1', openId: 'ou_user1', text: '你好',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });

    watched.onEvent(new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'Hello' }));
    watched.onEvent(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(mocks.feishuApi.calls.some(c => c.type === 'sendText' && c.text === 'Hello'), false);
    assert.ok(mocks.feishuApi.calls.some(c => c.type === 'updateProgressCard' && c.agentEvent.type === AgentEvent.TYPE_TEXT && c.agentEvent.data.text === 'Hello'));
  });

  it('prompt 长时间无事件时更新进度卡片心跳提示', async () => {
    const mocks = makeMocks();
    let resolvePrompt;
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_bound1', serverUrl: 'http://localhost:4096' } });
    mocks.sessionService.getSession = () => ({ id: 'wks_bound1', status: 'running' });
    mocks.driver.prompt = async () => new Promise((resolve) => { resolvePrompt = resolve; });
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      progressStyle: 'card',
      promptHeartbeatInitialMs: 10,
      promptHeartbeatIntervalMs: 10,
      promptHeartbeatStuckMs: 30,
    });

    const pending = dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_heartbeat1', openId: 'ou_user1', text: '慢任务',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    const heartbeat = mocks.feishuApi.calls.find(c => c.type === 'updateProgressCard'
      && c.agentEvent.type === AgentEvent.TYPE_STATUS
      && c.agentEvent.data.message.includes('仍在执行'));
    assert.ok(heartbeat);
    assert.equal(heartbeat.cardId, 'om_prog1');

    resolvePrompt([new AgentEvent(AgentEvent.TYPE_TEXT, { text: '完成' }), new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' })]);
    await pending;
  });

  it('prompt 完成后清理进度心跳，不再继续更新卡片', async () => {
    const mocks = makeMocks();
    let resolvePrompt;
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_bound1', serverUrl: 'http://localhost:4096' } });
    mocks.sessionService.getSession = () => ({ id: 'wks_bound1', status: 'running' });
    mocks.driver.prompt = async () => new Promise((resolve) => { resolvePrompt = resolve; });
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      progressStyle: 'card',
      promptHeartbeatInitialMs: 10,
      promptHeartbeatIntervalMs: 10,
      promptHeartbeatStuckMs: 30,
    });

    const pending = dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_heartbeat_clear1', openId: 'ou_user1', text: '慢任务',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    resolvePrompt([new AgentEvent(AgentEvent.TYPE_TEXT, { text: '完成' }), new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' })]);
    await pending;

    const heartbeatCountAfterDone = mocks.feishuApi.calls.filter(c => c.type === 'updateProgressCard'
      && c.agentEvent.type === AgentEvent.TYPE_STATUS).length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    const heartbeatCountLater = mocks.feishuApi.calls.filter(c => c.type === 'updateProgressCard'
      && c.agentEvent.type === AgentEvent.TYPE_STATUS).length;
    assert.equal(heartbeatCountLater, heartbeatCountAfterDone);
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

  it('/new 后监听终端侧会话回复并发送到飞书', async () => {
    const mocks = makeMocks();
    let watched;
    mocks.sessionService.createSession = (opts) => ({ id: 'wks_new1', agent: opts.agent || 'opencode', status: 'created', route: opts.route, agentRef: opts.agentRef });
    mocks.driver.watchSession = (_agentRef, handlers) => {
      watched = handlers;
      return () => {};
    };
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    await dispatcher.handleCommand({
      type: 'command', name: 'new', args: [],
      routeKey: 'feishu:oc_chat1:om_root1',
      messageId: 'om_cmd_watch1', chatId: 'oc_chat1',
    });

    watched.onEvent(new AgentEvent(AgentEvent.TYPE_TEXT, { text: '终端回复' }));
    watched.onEvent(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }));
    await new Promise((resolve) => setImmediate(resolve));

    const sendText = mocks.feishuApi.calls.find(c => c.type === 'sendText');
    assert.equal(sendText.chatId, 'oc_chat1');
    assert.equal(sendText.text, '终端回复');
  });

  it('/new driver 准备失败时发送错误卡片并返回错误结果', async () => {
    const mocks = makeMocks();
    mocks.driver.ensureReady = async () => { throw new Error('driver boot failed'); };
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
      messageId: 'om_new_error1', chatId: 'oc_chat1',
    });

    assert.equal(result.error, 'command_failed');
    assert.ok(mocks.feishuApi.calls.some(c => c.type === 'sendErrorCard' && c.message.includes('driver boot failed')));
  });
});

describe('MessageDispatcher command error boundary', () => {
  it('/use 缺少 session id 时发送错误卡片', async () => {
    const mocks = makeMocks();
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    const result = await dispatcher.handleCommand({
      type: 'command', name: 'use', args: [],
      routeKey: 'feishu:oc_chat1:om_root1',
      messageId: 'om_use_missing_arg1', chatId: 'oc_chat1',
    });

    assert.equal(result.error, 'missing_session_id');
    assert.ok(mocks.feishuApi.calls.some(c => c.type === 'sendErrorCard' && c.message.includes('Usage: /use')));
  });

  it('/use 不存在 session 时发送错误卡片并返回错误结果', async () => {
    const mocks = makeMocks();
    mocks.sessionService.bindRoute = () => { throw new Error('session not found: wks_missing'); };
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    const result = await dispatcher.handleCommand({
      type: 'command', name: 'use', args: ['wks_missing'],
      routeKey: 'feishu:oc_chat1:om_root1',
      messageId: 'om_use_missing_session1', chatId: 'oc_chat1',
    });

    assert.equal(result.error, 'command_failed');
    assert.ok(mocks.feishuApi.calls.some(c => c.type === 'sendErrorCard' && c.message.includes('wks_missing')));
  });

  it('命令文本回复失败不会产生未捕获 rejection', async () => {
    const mocks = makeMocks();
    mocks.feishuApi.replyText = () => Promise.reject(new Error('reply text failed'));
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    const { result, unhandled } = await captureUnhandledRejections(() => dispatcher.handleCommand({
      type: 'command', name: 'current', args: [],
      routeKey: 'feishu:oc_chat1:om_root1',
      messageId: 'om_reply_reject1', chatId: 'oc_chat1',
    }));

    assert.equal(result.current, null);
    assert.deepEqual(unhandled.map((err) => err.message), []);
  });
});

describe('MessageDispatcher turn lifecycle commands', () => {
  it('/cancel 无绑定 session 时返回可诊断提示', async () => {
    const mocks = makeMocks();
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'thread' });

    const result = await dispatcher.handleCommand({
      type: 'command', name: 'cancel', args: [],
      routeKey: 'feishu:oc_chat1:om_root1', messageId: 'om_cancel_none1', chatId: 'oc_chat1',
    });

    assert.equal(result.noSession, true);
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyText');
    assert.equal(reply.text, 'No running session to cancel.');
  });

  it('/cancel 有 running session 时取消当前 turn 并保留 session 回 idle', async () => {
    const mocks = makeMocks();
    const session = { id: 'wks_cancel1', agent: 'opencode', status: 'running', agentRef: { opencodeSessionId: 'ses_cancel1' } };
    let resolvePrompt;
    let stopCalled = false;
    let markedIdle = '';
    mocks.sessionService.getCurrent = () => session;
    mocks.sessionService.getSession = () => session;
    mocks.sessionService.markRunning = () => { session.status = 'running'; };
    mocks.sessionService.markIdle = (sessionId) => { markedIdle = sessionId; session.status = 'idle'; };
    mocks.driver.prompt = async () => new Promise((resolve) => { resolvePrompt = resolve; });
    mocks.driver.stop = async () => { stopCalled = true; };
    const dispatcher = new MessageDispatcher({
      ...mocks,
      routeMode: 'thread',
      progressStyle: 'card',
      promptHeartbeatInitialMs: 10,
      promptHeartbeatIntervalMs: 10,
    });

    const pending = dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_cancel_running1', openId: 'ou_user1', text: '慢任务',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });
    await new Promise((resolve) => setImmediate(resolve));
    const result = await dispatcher.handleCommand({
      type: 'command', name: 'cancel', args: [],
      routeKey: 'feishu:oc_chat1:om_root1', messageId: 'om_cancel_running_cmd1', chatId: 'oc_chat1',
    });

    assert.equal(result.cancelled, 'wks_cancel1');
    assert.equal(stopCalled, true);
    assert.equal(markedIdle, 'wks_cancel1');
    assert.equal(session.status, 'idle');
    assert.ok(mocks.feishuApi.calls.some(c => c.type === 'replyText' && c.text === 'Current turn cancelled: wks_cancel1'));

    resolvePrompt([new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'late answer' }), new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' })]);
    assert.equal(await pending, 'cancelled');
  });

  it('/cancel 后残留 watch 文本不再发送到飞书', async () => {
    const mocks = makeMocks();
    const session = { id: 'wks_cancel_watch1', agent: 'opencode', status: 'running', agentRef: { opencodeSessionId: 'ses_cancel_watch1' } };
    let watched;
    let resolvePrompt;
    mocks.sessionService.getCurrent = () => session;
    mocks.sessionService.getSession = () => session;
    mocks.sessionService.markRunning = () => { session.status = 'running'; };
    mocks.sessionService.markIdle = () => { session.status = 'idle'; };
    mocks.driver.prompt = async () => new Promise((resolve) => { resolvePrompt = resolve; });
    mocks.driver.watchSession = (_agentRef, handlers) => {
      watched = handlers;
      return () => {};
    };
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'thread', progressStyle: 'card' });

    const pending = dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_cancel_watch1', openId: 'ou_user1', text: '慢任务',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });
    await new Promise((resolve) => setImmediate(resolve));
    await dispatcher.handleCommand({
      type: 'command', name: 'cancel', args: [],
      routeKey: 'feishu:oc_chat1:om_root1', messageId: 'om_cancel_watch_cmd1', chatId: 'oc_chat1',
    });
    watched.onEvent(new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'cancelled residue' }));
    watched.onEvent(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(mocks.feishuApi.calls.some(c => c.type === 'sendText' && c.text === 'cancelled residue'), false);
    resolvePrompt([new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' })]);
    await pending;
  });

  it('/status 无绑定时提示 /new 或 /attach', async () => {
    const mocks = makeMocks();
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'thread' });

    const result = await dispatcher.handleCommand({
      type: 'command', name: 'status', args: [],
      routeKey: 'feishu:oc_chat1:om_root1', messageId: 'om_status_none1', chatId: 'oc_chat1',
    });

    assert.equal(result.noSession, true);
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyText');
    assert.equal(reply.text, 'No session bound to this conversation. Use /new or /attach first.');
  });

  it('/status 有绑定时返回 session、agent、状态、cwd、模型和运行时长', async () => {
    const mocks = makeMocks();
    const session = {
      id: 'wks_status1', agent: 'opencode', status: 'running', cwd: 'H:\\walker',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      agentRef: { opencodeSessionId: 'ses_status1', cwd: 'H:\\walker' },
    };
    mocks.sessionService.getCurrent = () => session;
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'thread' });
    dispatcher.sessionWatchStops.set(session.id, () => {});
    dispatcher.turnStates.set(session.id, {
      token: 1,
      startedAt: Date.now() - 1200,
      lastEventAt: Date.now() - 500,
      cancelled: false,
    });

    const result = await dispatcher.handleCommand({
      type: 'command', name: 'status', args: [],
      routeKey: 'feishu:oc_chat1:om_root1', messageId: 'om_status_bound1', chatId: 'oc_chat1',
    });

    assert.equal(result.sessionId, 'wks_status1');
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyText');
    assert.match(reply.text, /Walker session id: wks_status1/);
    assert.match(reply.text, /Agent: opencode/);
    assert.match(reply.text, /Status: running/);
    assert.match(reply.text, /OpenCode session id: ses_status1/);
    assert.match(reply.text, /Model: anthropic\/claude-sonnet-4/);
    assert.match(reply.text, /CWD: H:\\walker/);
    assert.match(reply.text, /Current turn running: yes/);
    assert.match(reply.text, /Running time:/);
    assert.match(reply.text, /Background watch: yes/);
  });

  it('/ps 复用 status', async () => {
    const mocks = makeMocks();
    const session = { id: 'wks_ps1', agent: 'opencode', status: 'idle', cwd: 'H:\\walker', agentRef: { opencodeSessionId: 'ses_ps1' } };
    mocks.sessionService.getCurrent = () => session;
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'thread' });

    const result = await dispatcher.handleCommand({
      type: 'command', name: 'ps', args: [],
      routeKey: 'feishu:oc_chat1:om_root1', messageId: 'om_ps1', chatId: 'oc_chat1',
    });

    assert.equal(result.sessionId, 'wks_ps1');
    assert.ok(mocks.feishuApi.calls.some(c => c.type === 'replyText' && c.text.includes('Walker session id: wks_ps1')));
  });

  it('max turn time 超时后取消当前 turn，清理心跳，不发送过期最终回答', async () => {
    const mocks = makeMocks();
    const session = { id: 'wks_timeout1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_timeout1' } };
    let resolvePrompt;
    let stopCalled = false;
    mocks.sessionService.getCurrent = () => session;
    mocks.sessionService.getSession = () => session;
    mocks.sessionService.markRunning = () => { session.status = 'running'; };
    mocks.sessionService.markIdle = () => { session.status = 'idle'; };
    mocks.driver.prompt = async () => new Promise((resolve) => { resolvePrompt = resolve; });
    mocks.driver.stop = async () => { stopCalled = true; };
    const dispatcher = new MessageDispatcher({
      ...mocks,
      routeMode: 'thread',
      progressStyle: 'card',
      promptHeartbeatInitialMs: 10,
      promptHeartbeatIntervalMs: 10,
      maxTurnTimeMins: 0.00025,
    });

    const pending = dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_timeout1', openId: 'ou_user1', text: '慢任务',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    const statusCountAfterTimeout = mocks.feishuApi.calls.filter(c => c.type === 'updateProgressCard' && c.agentEvent.type === AgentEvent.TYPE_STATUS).length;

    assert.equal(stopCalled, true);
    assert.equal(session.status, 'idle');
    assert.ok(mocks.feishuApi.calls.some(c => c.type === 'replyText' && c.text === 'Current turn timed out after 0.00025 minutes and was cancelled.'));

    resolvePrompt([new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'late timeout answer' }), new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' })]);
    assert.equal(await pending, 'cancelled');
    await new Promise((resolve) => setTimeout(resolve, 25));

    const statusCountLater = mocks.feishuApi.calls.filter(c => c.type === 'updateProgressCard' && c.agentEvent.type === AgentEvent.TYPE_STATUS).length;
    assert.equal(statusCountLater, statusCountAfterTimeout);
    assert.equal(mocks.feishuApi.calls.some(c => c.type === 'updateProgressCard' && c.agentEvent.data && c.agentEvent.data.text === 'late timeout answer'), false);
  });

  it('watch 重复 done 不重复发送 buffer', async () => {
    const mocks = makeMocks();
    const session = { id: 'wks_watch_done1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_watch_done1' } };
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'thread' });

    dispatcher._handleWatchedSessionEvent(session, 'oc_chat1', new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'watch answer' }));
    dispatcher._handleWatchedSessionEvent(session, 'oc_chat1', new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }));
    dispatcher._handleWatchedSessionEvent(session, 'oc_chat1', new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }));
    await new Promise((resolve) => setImmediate(resolve));

    const sends = mocks.feishuApi.calls.filter(c => c.type === 'sendText' && c.text === 'watch answer');
    assert.equal(sends.length, 1);
  });
});

describe('MessageDispatcher /attach command', () => {
  it('/attach 单个候选时自动纳入 Walker session 并绑定 routeKey', async () => {
    const mocks = makeMocks();
    let createOpts;
    let watched;
    mocks.driver.serverUrl = 'http://localhost:4096';
    mocks.driver.listSessions = async () => [
      { id: 'ses_existing1', title: 'terminal session', cwd: 'H:\\walker', status: 'idle' },
    ];
    mocks.driver.resumeSession = async (ref) => Object.assign({}, ref, { resumed: true });
    mocks.driver.watchSession = (_agentRef, handlers) => {
      watched = handlers;
      return () => {};
    };
    mocks.sessionService.listSessions = () => [];
    mocks.sessionService.createSession = (opts) => {
      createOpts = opts;
      return { id: 'wks_attached1', agent: opts.agent, status: 'created', agentRef: opts.agentRef };
    };
    let markedIdle = '';
    mocks.sessionService.markIdle = (sessionId) => { markedIdle = sessionId; };

    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      defaultCwd: 'H:\\walker',
    });

    const result = await dispatcher.handleCommand({
      type: 'command', name: 'attach', args: [],
      routeKey: 'feishu:oc_chat1:om_root1',
      messageId: 'om_attach1', chatId: 'oc_chat1',
    });

    assert.equal(result.sessionId, 'wks_attached1');
    assert.equal(createOpts.route, 'feishu:oc_chat1:om_root1');
    assert.equal(createOpts.agent, 'opencode');
    assert.equal(createOpts.agentRef.opencodeSessionId, 'ses_existing1');
    assert.equal(createOpts.agentRef.serverUrl, 'http://localhost:4096');
    assert.equal(markedIdle, 'wks_attached1');
    assert.ok(watched);
    assert.ok(mocks.feishuApi.calls.some(c => c.type === 'replyText' && c.text.includes('OpenCode session attached')));
  });

  it('/attach 多个候选时发送可纳入列表卡片', async () => {
    const mocks = makeMocks();
    mocks.driver.listSessions = async () => [
      { id: 'ses_a', title: 'A', cwd: 'H:\\walker', status: 'idle' },
      { id: 'ses_b', title: 'B', cwd: 'H:\\walker', status: 'running' },
    ];
    mocks.sessionService.listSessions = () => [];
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    const result = await dispatcher.handleCommand({
      type: 'command', name: 'attach', args: [],
      routeKey: 'feishu:oc_chat1:om_root1',
      messageId: 'om_attach_list1', chatId: 'oc_chat1',
    });

    const cardCall = mocks.feishuApi.calls.find(c => c.type === 'sendAttachableSessionList');
    assert.equal(result.candidates.length, 2);
    assert.equal(cardCall.sessions.length, 2);
    assert.deepEqual(cardCall.options.managedIds, []);
  });

  it('/attach <id> 对已管理 OpenCode 会话直接绑定现有 Walker session', async () => {
    const mocks = makeMocks();
    mocks.driver.listSessions = async () => [
      { id: 'ses_managed', title: 'managed', cwd: 'H:\\walker', status: 'idle' },
    ];
    mocks.sessionService.listSessions = () => [
      { id: 'wks_existing1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_managed' } },
    ];
    let boundRoute;
    mocks.sessionService.bindRoute = (routeKey, sessionId) => { boundRoute = { routeKey, sessionId }; };
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    const result = await dispatcher.handleCommand({
      type: 'command', name: 'attach', args: ['ses_managed'],
      routeKey: 'feishu:oc_chat1:om_root1',
      messageId: 'om_attach_managed1', chatId: 'oc_chat1',
    });

    assert.equal(result.bound, 'wks_existing1');
    assert.deepEqual(boundRoute, { routeKey: 'feishu:oc_chat1:om_root1', sessionId: 'wks_existing1' });
  });
});

describe('MessageDispatcher /delete command', () => {
  it('/delete 在卡片回调无 messageId 时使用 chatId 回复', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getSession = () => ({ id: 'wks_delete1', agent: 'opencode', agentRef: { opencodeSessionId: 'ses_delete1' } });
    let deletedSessionId = '';
    mocks.sessionService.deleteSession = (sessionId) => { deletedSessionId = sessionId; };
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    const result = await dispatcher.handleCommand({
      type: 'command', name: 'delete', args: ['wks_delete1'],
      routeKey: 'feishu:oc_chat1:om_root1',
      messageId: '', chatId: 'oc_chat1',
    });

    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyText');
    assert.equal(result.deleted, 'wks_delete1');
    assert.equal(deletedSessionId, 'wks_delete1');
    assert.deepEqual(reply.msgId, { messageId: '', chatId: 'oc_chat1' });
    assert.equal(reply.text, 'Session deleted: wks_delete1');
  });
});

describe('MessageDispatcher /model command', () => {
  it('/model 无参数时列出可用模型', async () => {
    const mocks = makeMocks();
    mocks.driver.listModels = async () => [
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic' },
      { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai' },
    ];
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'user' });

    const result = await dispatcher.handleCommand({
      name: 'model', args: [], routeKey: 'feishu:oc_chat1:ou_user1',
      messageId: 'om_model_list', chatId: 'oc_chat1',
    });

    assert.equal(result.models.length, 2);
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyText');
    assert.ok(reply.text.includes('claude-sonnet-4'));
    assert.ok(reply.text.includes('gpt-4o'));
  });

  it('/model <model_id> 设置当前会话模型', async () => {
    const mocks = makeMocks();
    const updatedFields = [];
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', model: '' });
    mocks.sessionService.updateSessionField = (sid, field, value) => { updatedFields.push({ sid, field, value }); };
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'user' });

    const result = await dispatcher.handleCommand({
      name: 'model', args: ['claude-sonnet-4'], routeKey: 'feishu:oc_chat1:ou_user1',
      messageId: 'om_model_set', chatId: 'oc_chat1',
    });

    assert.deepEqual(result.model, { modelID: 'claude-sonnet-4' });
    assert.equal(result.sessionId, 'wks_bound1');
    assert.deepEqual(updatedFields[0], { sid: 'wks_bound1', field: 'model', value: { modelID: 'claude-sonnet-4' } });
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyText');
    assert.ok(reply.text.includes('claude-sonnet-4'));
  });

  it('/model provider/model_id 指定 provider', async () => {
    const mocks = makeMocks();
    const updatedFields = [];
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', model: '' });
    mocks.sessionService.updateSessionField = (sid, field, value) => { updatedFields.push({ sid, field, value }); };
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'user' });

    const result = await dispatcher.handleCommand({
      name: 'model', args: ['cpa/gpt-5.5'], routeKey: 'feishu:oc_chat1:ou_user1',
      messageId: 'om_model_provider', chatId: 'oc_chat1',
    });

    assert.deepEqual(result.model, { modelID: 'gpt-5.5', providerID: 'cpa' });
    assert.deepEqual(updatedFields[0], { sid: 'wks_bound1', field: 'model', value: { modelID: 'gpt-5.5', providerID: 'cpa' } });
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyText');
    assert.ok(reply.text.includes('cpa/gpt-5.5'));
  });

  it('/model <model_id> 无绑定会话时提示先创建', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => null;
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'user' });

    const result = await dispatcher.handleCommand({
      name: 'model', args: ['claude-sonnet-4'], routeKey: 'feishu:oc_chat1:ou_user1',
      messageId: 'om_model_nobind', chatId: 'oc_chat1',
    });

    assert.equal(result.noSession, true);
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyText');
    assert.ok(reply.text.includes('/new'));
  });
});
