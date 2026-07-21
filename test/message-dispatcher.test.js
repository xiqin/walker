const { describe, it } = require('node:test');
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
    setFocus: () => {},
    removeSessionFromRoute: () => {},
    listSessionsInRoute: () => [],
    getRouteCwd: () => '',
    getRouteForSession: () => null,
    touchRouteCalls: [],
    touchRoute: (routeKey) => { sessionService.touchRouteCalls.push(routeKey); },
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
    prompt: async (agentRef, text, options) => {
      driver.promptCalls.push({ agentRef, text, model: options && options.model, signal: options && options.signal });
      return [new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'Hello' }), new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' })];
    },
    stop: async () => {},
    delete: async () => {},
    resumeSession: async (ref) => ref,
    listModels: async () => [],
  };
  const driverRegistry = { get: () => driver };
  const feishuApi = {
    replyText: (msgId, text) => { feishuApi.calls.push({ type: 'replyText', msgId, text }); return [{ message_id: 'om_reply1' }]; },
    replyMarkdown: (msgId, text) => { feishuApi.calls.push({ type: 'replyMarkdown', msgId, text }); return [{ message_id: 'om_reply1' }]; },
    sendText: (chatId, text) => { feishuApi.calls.push({ type: 'sendText', chatId, text }); },
    sendMarkdown: (chatId, text) => { feishuApi.calls.push({ type: 'sendMarkdown', chatId, text }); },
    replyCard: (msgId, card) => { feishuApi.calls.push({ type: 'replyCard', msgId, card }); return 'om_card1'; },
    patchCard: (cardId, card) => { feishuApi.calls.push({ type: 'patchCard', cardId, card }); },
    addReaction: (msgId, emoji) => { feishuApi.calls.push({ type: 'addReaction', msgId, emoji }); },
    sendUnboundGuide: (msgId, routeKey) => { feishuApi.calls.push({ type: 'sendUnboundGuide', msgId, routeKey }); },
    sendSessionList: (msgId, sessions, currentId, options) => { feishuApi.calls.push({ type: 'sendSessionList', msgId, sessions, currentId, options }); },
    sendAttachableSessionList: (msgId, sessions, options) => { feishuApi.calls.push({ type: 'sendAttachableSessionList', msgId, sessions, options }); },
    sendErrorCard: (msgId, message) => { feishuApi.calls.push({ type: 'sendErrorCard', msgId, message }); },
    sendProgressCard: (msgId, sessionId, _initialEvent) => { feishuApi.calls.push({ type: 'sendProgressCard', msgId, sessionId }); return 'om_prog1'; },
    updateProgressCard: (cardId, sessionId, agentEvent) => { feishuApi.calls.push({ type: 'updateProgressCard', cardId, sessionId, agentEvent }); return null; },
    sendModelList: (msgId, models, options) => { feishuApi.calls.push({ type: 'sendModelList', msgId, models, options }); return 'om_model_card1'; },
    sendHelpCard: (msgId, commands, options) => { feishuApi.calls.push({ type: 'sendHelpCard', msgId, commands, options }); return 'om_help_card1'; },
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
  it('线程消息未命中时回退到群聊根 route 的焦点 session', async () => {
    const mocks = makeMocks();
    const getCurrentCalls = [];
    mocks.sessionService.getCurrent = (routeKey) => {
      getCurrentCalls.push(routeKey);
      if (routeKey === 'feishu:oc_chat1:root:oc_chat1') {
        return { id: 'wks_bound1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_bound1', serverUrl: 'http://localhost:4096' } };
      }
      return null;
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
      chatId: 'oc_chat1', messageId: 'om_thread_msg1', openId: 'ou_user1', text: '线程里发的消息',
      messageType: 'text', createTime: Date.now(), rootId: 'om_thread_root1',
      routeKey: 'feishu:oc_chat1:root:om_thread_root1',
    });

    assert.equal(result, 'prompted');
    assert.deepEqual(getCurrentCalls, [
      'feishu:oc_chat1:root:om_thread_root1',
      'feishu:oc_chat1:root:oc_chat1',
    ]);
    assert.equal(mocks.driver.promptCalls.length, 1);
    assert.equal(mocks.driver.promptCalls[0].text, '线程里发的消息');
    assert.deepEqual(mocks.sessionService.touchRouteCalls, ['feishu:oc_chat1:root:oc_chat1']);
  });

  it('已绑定线程 route 优先，不回退到群聊根 route', async () => {
    const mocks = makeMocks();
    const getCurrentCalls = [];
    const threadSession = { id: 'wks_thread1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_thread1', serverUrl: 'http://localhost:4096' } };
    const rootSession = { id: 'wks_root1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_root1', serverUrl: 'http://localhost:4096' } };
    mocks.sessionService.getCurrent = (routeKey) => {
      getCurrentCalls.push(routeKey);
      if (routeKey === 'feishu:oc_chat1:root:om_thread_root1') return threadSession;
      if (routeKey === 'feishu:oc_chat1:root:oc_chat1') return rootSession;
      return null;
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
      chatId: 'oc_chat1', messageId: 'om_thread_priority1', openId: 'ou_user1', text: '线程消息',
      messageType: 'text', createTime: Date.now(), rootId: 'om_thread_root1',
      routeKey: 'feishu:oc_chat1:root:om_thread_root1',
    });

    assert.equal(result, 'prompted');
    assert.deepEqual(getCurrentCalls, ['feishu:oc_chat1:root:om_thread_root1']);
    assert.equal(mocks.driver.promptCalls.length, 1);
    assert.equal(mocks.driver.promptCalls[0].agentRef.opencodeSessionId, 'ses_thread1');
    assert.deepEqual(mocks.sessionService.touchRouteCalls, ['feishu:oc_chat1:root:om_thread_root1']);
  });

  it('线程 route 和群聊根 route 都未绑定时发送引导卡片', async () => {
    const mocks = makeMocks();
    const getCurrentCalls = [];
    mocks.sessionService.getCurrent = (routeKey) => {
      getCurrentCalls.push(routeKey);
      return null;
    };
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    const result = await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_double_unbound1', openId: 'ou_user1', text: '无人绑定',
      messageType: 'text', createTime: Date.now(), rootId: 'om_thread_root1',
      routeKey: 'feishu:oc_chat1:root:om_thread_root1',
    });

    assert.equal(result, 'unbound');
    assert.deepEqual(getCurrentCalls, [
      'feishu:oc_chat1:root:om_thread_root1',
      'feishu:oc_chat1:root:oc_chat1',
    ]);
    assert.ok(mocks.feishuApi.calls.some(c => c.type === 'sendUnboundGuide'));
  });

  it('回退后 driver.prompt 使用回退 route 的 session agentRef', async () => {
    const mocks = makeMocks();
    const fallbackSession = { id: 'wks_fallback1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_fallback1', serverUrl: 'http://localhost:4096' } };
    mocks.sessionService.getCurrent = (routeKey) => {
      if (routeKey === 'feishu:oc_chat2:root:oc_chat2') return fallbackSession;
      return null;
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
      chatId: 'oc_chat2', messageId: 'om_fallback_agentref1', openId: 'ou_user1', text: '回退后消息',
      messageType: 'text', createTime: Date.now(), rootId: 'om_thread_root2',
      routeKey: 'feishu:oc_chat2:root:om_thread_root2',
    });

    assert.equal(result, 'prompted');
    assert.equal(mocks.driver.promptCalls.length, 1);
    assert.equal(mocks.driver.promptCalls[0].agentRef.opencodeSessionId, 'ses_fallback1');
  });

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
    const updates = mocks.feishuApi.calls.filter(c => c.type === 'updateProgressCard');
    assert.equal(updates.some(c => c.agentEvent.type === AgentEvent.TYPE_TEXT), false, 'TYPE_TEXT 不应触发 updateProgressCard');
    assert.ok(updates.some(c => c.agentEvent.type === AgentEvent.TYPE_DONE), 'TYPE_DONE 仍应触发一次 updateProgressCard');
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyMarkdown');
    assert.ok(reply, '应通过 replyMarkdown 发送完整文本');
    assert.equal(reply.text, 'Hello\n\n---\n模型：未指定');
    assert.ok(mocks.feishuApi.calls.some(c => c.type === 'addReaction' && c.emoji === 'OnIt'));
    assert.deepEqual(mocks.sessionService.touchRouteCalls, ['feishu:oc_chat1:root:om_root1']);
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
    assert.equal(updates.some(c => c.agentEvent.type === AgentEvent.TYPE_TEXT), false, 'TYPE_TEXT 不应触发 updateProgressCard');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].agentEvent.type, AgentEvent.TYPE_DONE);
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyMarkdown');
    assert.ok(reply, '应通过 replyMarkdown 发送合并后的完整文本');
    assert.equal(reply.text, '你好\n\n---\n模型：未指定');
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
    assert.equal(updates.some(c => c.agentEvent.type === AgentEvent.TYPE_TEXT), false, 'TYPE_TEXT 不应触发 updateProgressCard');
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyMarkdown');
    assert.ok(reply, '应通过 replyMarkdown 发送完整文本');
    assert.equal(reply.text.includes('你是谁'), false, 'replyMarkdown 发送的文本不应包含复述的用户消息');
    assert.equal(reply.text.includes('我是 OpenCode'), true, 'replyMarkdown 应包含实际回答');
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
    assert.equal(textUpdates.length, 0, 'TYPE_TEXT 不应触发 updateProgressCard');
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyMarkdown');
    assert.ok(reply, '应通过 replyMarkdown 发送完整文本');
    assert.equal(reply.text, '你好\n\n---\n模型：未指定');
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
    assert.equal(textUpdates.length, 0, 'TYPE_TEXT 不应触发 updateProgressCard');
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyMarkdown');
    assert.ok(reply, '应通过 replyMarkdown 发送完整文本');
    assert.equal(reply.text, '我是 OpenCode\n\n---\n模型：未指定');
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
    assert.equal(textUpdates.length, 0, 'TYPE_TEXT 不应触发 updateProgressCard');
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyMarkdown');
    assert.ok(reply, '应通过 replyMarkdown 发送折叠后的文本');
    assert.equal(reply.text.includes('m0004'), false, 'replyMarkdown 发送的文本不应包含消息编号');
    assert.equal(reply.text.includes('代码协作助手'), true, 'replyMarkdown 应包含折叠后的回答');
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
    const textUpdates = mocks.feishuApi.calls.filter(c => c.type === 'updateProgressCard' && c.agentEvent.type === AgentEvent.TYPE_TEXT);
    assert.equal(textUpdates.length, 0, 'TYPE_TEXT 不应触发 updateProgressCard');
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyMarkdown');
    assert.ok(reply, '应通过 replyMarkdown 发送最终回答文本');
    assert.equal(reply.text, '完成\n\n---\n模型：未指定');
    assert.equal(reply.text.includes('正在分析调用链'), false, 'replyMarkdown 不应包含思考内容');
    assert.equal(mocks.feishuApi.calls.some(c => c.type === 'sendMarkdown' && c.text.includes('正在分析调用链')), false);
    assert.equal(mocks.feishuApi.calls.some(c => c.type === 'replyMarkdown' && c.text.includes('正在分析调用链')), false);
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

    assert.equal(mocks.feishuApi.calls.some(c => c.type === 'sendMarkdown' && c.text === 'Hello'), false, 'watch 不应重复 sendMarkdown 已由 replyText 发送的文本');
    const textCardUpdates = mocks.feishuApi.calls.filter(c => c.type === 'updateProgressCard' && c.agentEvent.type === AgentEvent.TYPE_TEXT);
    assert.equal(textCardUpdates.length, 0, 'card 模式下 TYPE_TEXT 不应进卡片');
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyMarkdown' && c.text.startsWith('Hello'));
    assert.ok(reply, '应通过 replyMarkdown 发送 Hello');
  });

  it('card 模式通过普通文本发送合并后的完整回答', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_bound1', serverUrl: 'http://localhost:4096' } });
    mocks.driver.prompt = async () => [
      new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'Hello' }),
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
      chatId: 'oc_chat1', messageId: 'om_card_reply1', openId: 'ou_user1', text: 'test',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });

    const replies = mocks.feishuApi.calls.filter(c => c.type === 'replyMarkdown');
    assert.equal(replies.length, 1, 'replyMarkdown 恰好调用一次');
    assert.equal(replies[0].text, 'Hello\n\n---\n模型：未指定');
    const textUpdates = mocks.feishuApi.calls.filter(c => c.type === 'updateProgressCard' && c.agentEvent.type === AgentEvent.TYPE_TEXT);
    assert.equal(textUpdates.length, 0, 'TYPE_TEXT 不触发 updateProgressCard');
    const doneUpdates = mocks.feishuApi.calls.filter(c => c.type === 'updateProgressCard' && c.agentEvent.type === AgentEvent.TYPE_DONE);
    assert.equal(doneUpdates.length, 1, 'TYPE_DONE 触发一次 updateProgressCard');
  });

  it('card 模式空回答不发送文本消息', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_bound1', serverUrl: 'http://localhost:4096' } });
    mocks.driver.prompt = async () => [
      new AgentEvent(AgentEvent.TYPE_REASONING, { text: '正在分析' }),
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
      chatId: 'oc_chat1', messageId: 'om_card_empty1', openId: 'ou_user1', text: 'test',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });

    const replies = mocks.feishuApi.calls.filter(c => c.type === 'replyMarkdown');
    assert.equal(replies.length, 0, '空回答不应调用 replyMarkdown');
    const doneUpdates = mocks.feishuApi.calls.filter(c => c.type === 'updateProgressCard' && c.agentEvent.type === AgentEvent.TYPE_DONE);
    assert.equal(doneUpdates.length, 1, '卡片仍应标记 done');
  });

  it('卡片创建失败不触发 legacy 重复发送', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_bound1', serverUrl: 'http://localhost:4096' } });
    mocks.driver.prompt = async () => [
      new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'Hello' }),
      new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }),
    ];
    mocks.feishuApi.sendProgressCard = () => { mocks.feishuApi.calls.push({ type: 'sendProgressCard' }); return null; };
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      progressStyle: 'card',
    });

    await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_card_fail1', openId: 'ou_user1', text: 'test',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });

    const updates = mocks.feishuApi.calls.filter(c => c.type === 'updateProgressCard');
    assert.equal(updates.length, 0, 'sendProgressCard 返回 null 时不应调用 updateProgressCard');
    const replies = mocks.feishuApi.calls.filter(c => c.type === 'replyMarkdown');
    assert.equal(replies.length, 1, '最终文本仍应由 _renderEvents 通过 replyMarkdown 发送一次');
    assert.equal(replies[0].text, 'Hello\n\n---\n模型：未指定');
  });

  it('replyText undefined 不标记已送达', async () => {
    const mocks = makeMocks();
    let watched;
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_bound1', serverUrl: 'http://localhost:4096' } });
    mocks.driver.watchSession = (_agentRef, handlers) => {
      watched = handlers;
      return () => {};
    };
    mocks.feishuApi.replyMarkdown = (msgId, text) => { mocks.feishuApi.calls.push({ type: 'replyMarkdown', msgId, text }); return undefined; };
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      progressStyle: 'card',
    });

    await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_undelivered1', openId: 'ou_user1', text: '你好',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });

    watched.onEvent(new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'Hello' }));
    watched.onEvent(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(mocks.feishuApi.calls.some(c => c.type === 'sendMarkdown' && c.text === 'Hello'), true, 'replyMarkdown 返回 undefined 时不记录 deliveredText，watch 应可补发');
  });

  it('replyMarkdown 失败后 watch 可补发', async () => {
    const mocks = makeMocks();
    let watched;
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_bound1', serverUrl: 'http://localhost:4096' } });
    mocks.driver.watchSession = (_agentRef, handlers) => {
      watched = handlers;
      return () => {};
    };
    mocks.feishuApi.replyMarkdown = () => { throw new Error('replyMarkdown boom'); };
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      progressStyle: 'card',
    });

    await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_reply_fail1', openId: 'ou_user1', text: '你好',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });

    mocks.feishuApi.replyMarkdown = (msgId, text) => { mocks.feishuApi.calls.push({ type: 'replyMarkdown', msgId, text }); return [{ message_id: 'om_reply1' }]; };
    watched.onEvent(new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'Hello' }));
    watched.onEvent(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }));
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(mocks.feishuApi.calls.some(c => c.type === 'sendMarkdown' && c.text === 'Hello'), true, 'replyText 失败后未记录 deliveredText，watch 应可 sendMarkdown 补发');
  });

  it('card 模式只更新一个 done 事件', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_bound1', serverUrl: 'http://localhost:4096' } });
    mocks.driver.prompt = async () => [
      new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'Hello' }),
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
      chatId: 'oc_chat1', messageId: 'om_card_done1', openId: 'ou_user1', text: 'test',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });

    const doneUpdates = mocks.feishuApi.calls.filter(c => c.type === 'updateProgressCard' && c.agentEvent.type === AgentEvent.TYPE_DONE);
    assert.equal(doneUpdates.length, 1, 'updateProgressCard 中 TYPE_DONE 只应有 1 个调用');
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

    const sendMarkdown = mocks.feishuApi.calls.find(c => c.type === 'sendMarkdown');
    assert.equal(sendMarkdown.chatId, 'oc_chat1');
    assert.equal(sendMarkdown.text, '终端回复');
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

  it('/new 继承当前焦点 session 的模型', async () => {
    const mocks = makeMocks();
    const created = {};
    mocks.sessionService.getCurrent = () => ({
      id: 'wks_cur1', agent: 'opencode', status: 'idle',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
    });
    mocks.sessionService.createSession = (opts) => {
      created.opts = opts;
      return { id: 'wks_new1', agent: opts.agent || 'opencode', status: 'created', route: opts.route, agentRef: opts.agentRef };
    };
    const driverCreateCalls = [];
    mocks.driver.createSession = async (opts) => {
      driverCreateCalls.push(opts);
      return { opencodeSessionId: 'ses_new1', serverUrl: 'http://localhost:4096' };
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
      messageId: 'om_new_inherit1', chatId: 'oc_chat1',
    });

    assert.deepEqual(driverCreateCalls[0].model, { providerID: 'anthropic', modelID: 'claude-sonnet-4' });
    assert.deepEqual(created.opts.model, { providerID: 'anthropic', modelID: 'claude-sonnet-4' });
  });

  it('/new 无当前 session 时继承 defaultModel 对象', async () => {
    const mocks = makeMocks();
    const created = {};
    mocks.sessionService.getCurrent = () => null;
    mocks.sessionService.createSession = (opts) => {
      created.opts = opts;
      return { id: 'wks_new1', agent: opts.agent || 'opencode', status: 'created', route: opts.route, agentRef: opts.agentRef };
    };
    const driverCreateCalls = [];
    mocks.driver.createSession = async (opts) => {
      driverCreateCalls.push(opts);
      return { opencodeSessionId: 'ses_new1', serverUrl: 'http://localhost:4096' };
    };
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      defaultModel: 'anthropic/claude-sonnet-4',
    });

    await dispatcher.handleCommand({
      type: 'command', name: 'new', args: [],
      routeKey: 'feishu:oc_chat1:om_root1',
      messageId: 'om_new_inherit2', chatId: 'oc_chat1',
    });

    assert.deepEqual(driverCreateCalls[0].model, { providerID: 'anthropic', modelID: 'claude-sonnet-4' });
    assert.deepEqual(created.opts.model, { providerID: 'anthropic', modelID: 'claude-sonnet-4' });
  });

  it('/new 无当前 session 且无 defaultModel 时不传 model', async () => {
    const mocks = makeMocks();
    const created = {};
    mocks.sessionService.getCurrent = () => null;
    mocks.sessionService.createSession = (opts) => {
      created.opts = opts;
      return { id: 'wks_new1', agent: opts.agent || 'opencode', status: 'created', route: opts.route, agentRef: opts.agentRef };
    };
    const driverCreateCalls = [];
    mocks.driver.createSession = async (opts) => {
      driverCreateCalls.push(opts);
      return { opencodeSessionId: 'ses_new1', serverUrl: 'http://localhost:4096' };
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
      messageId: 'om_new_inherit3', chatId: 'oc_chat1',
    });

    assert.equal(driverCreateCalls[0].model, null);
    assert.equal(created.opts.model, null);
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
    mocks.sessionService.setFocus = () => { throw new Error('session not found: wks_missing'); };
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

  it('/status 有绑定时返回 route、焦点 session 和其他 session 状态', async () => {
    const mocks = makeMocks();
    const session = {
      id: 'wks_status1', agent: 'opencode', status: 'running', cwd: 'H:\\walker',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      agentRef: { opencodeSessionId: 'ses_status1', cwd: 'H:\\walker' },
    };
    mocks.sessionService.getCurrent = () => session;
    mocks.sessionService.listSessionsInRoute = () => [session];
    mocks.sessionService.getRouteCwd = () => 'H:\\walker';
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
    assert.match(reply.text, /Route: feishu:oc_chat1:om_root1/);
    assert.match(reply.text, /Active sessions: 1/);
    assert.match(reply.text, /Focus: wks_status1/);
    assert.match(reply.text, /opencode/);
    assert.match(reply.text, /ses_status1/);
  });

  it('/ps 复用 status', async () => {
    const mocks = makeMocks();
    const session = { id: 'wks_ps1', agent: 'opencode', status: 'idle', cwd: 'H:\\walker', agentRef: { opencodeSessionId: 'ses_ps1' } };
    mocks.sessionService.getCurrent = () => session;
    mocks.sessionService.listSessionsInRoute = () => [session];
    mocks.sessionService.getRouteCwd = () => 'H:\\walker';
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'thread' });

    const result = await dispatcher.handleCommand({
      type: 'command', name: 'ps', args: [],
      routeKey: 'feishu:oc_chat1:om_root1', messageId: 'om_ps1', chatId: 'oc_chat1',
    });

    assert.equal(result.sessionId, 'wks_ps1');
    assert.ok(mocks.feishuApi.calls.some(c => c.type === 'replyText' && c.text.includes('wks_ps1')));
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

    const sends = mocks.feishuApi.calls.filter(c => c.type === 'sendMarkdown' && c.text === 'watch answer');
    assert.equal(sends.length, 1);
  });

  it('watch 进度事件实时渲染进度卡片并在 done 时完成', async () => {
    const mocks = makeMocks();
    const session = { id: 'wks_watch_prog1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_watch_prog1' } };
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'thread', progressStyle: 'card' });

    dispatcher._handleWatchedSessionEvent(session, 'oc_chat1', new AgentEvent(AgentEvent.TYPE_TODO, { todos: [{ id: 't1', status: 'completed' }] }));
    dispatcher._handleWatchedSessionEvent(session, 'oc_chat1', new AgentEvent(AgentEvent.TYPE_FILE_EDITED, { path: 'src/x.js', action: 'edit', linesAdded: 5, linesRemoved: 1 }));
    dispatcher._handleWatchedSessionEvent(session, 'oc_chat1', new AgentEvent(AgentEvent.TYPE_COMMAND_EXECUTED, { command: 'npm test', exitCode: 0 }));
    dispatcher._handleWatchedSessionEvent(session, 'oc_chat1', new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'done output' }));
    dispatcher._handleWatchedSessionEvent(session, 'oc_chat1', new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const sendCardCalls = mocks.feishuApi.calls.filter(c => c.type === 'sendProgressCard');
    assert.ok(sendCardCalls.length >= 1, '应建进度卡片');
    const updateCalls = mocks.feishuApi.calls.filter(c => c.type === 'updateProgressCard');
    const updatedTypes = updateCalls.map(c => c.agentEvent.type);
    assert.ok(updatedTypes.includes(AgentEvent.TYPE_TODO), 'todo 应更新进度卡片');
    assert.equal(updatedTypes.includes(AgentEvent.TYPE_FILE_EDITED), false, 'file_edited 不应更新进度卡片');
    assert.ok(updatedTypes.includes(AgentEvent.TYPE_COMMAND_EXECUTED), 'command_executed 应更新进度卡片');
    assert.equal(updatedTypes.includes(AgentEvent.TYPE_STEP), false, 'step 不应更新进度卡片');
    assert.equal(updatedTypes.includes(AgentEvent.TYPE_SESSION_DIFF), false, 'session_diff 不应更新进度卡片');
    const sends = mocks.feishuApi.calls.filter(c => c.type === 'sendMarkdown' && c.text === 'done output');
    assert.equal(sends.length, 1, 'done 后仍应发送文本');
    assert.equal(dispatcher.sessionWatchProgressCards.has(session.id), false, 'done 后应清理进度卡片 id');
  });

  it('watch progressStyle 非 card 时不建进度卡片', async () => {
    const mocks = makeMocks();
    const session = { id: 'wks_watch_prog2', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_watch_prog2' } };
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'thread', progressStyle: 'legacy' });

    dispatcher._handleWatchedSessionEvent(session, 'oc_chat1', new AgentEvent(AgentEvent.TYPE_TODO, { todos: [] }));
    dispatcher._handleWatchedSessionEvent(session, 'oc_chat1', new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'legacy output' }));
    dispatcher._handleWatchedSessionEvent(session, 'oc_chat1', new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }));
    await new Promise((resolve) => setImmediate(resolve));

    const sendCardCalls = mocks.feishuApi.calls.filter(c => c.type === 'sendProgressCard');
    assert.equal(sendCardCalls.length, 0, '非 card 模式不应建进度卡片');
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
    assert.ok(mocks.feishuApi.calls.every(c => c.type !== 'sendAttachableSessionList'));
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
    assert.equal(Object.prototype.hasOwnProperty.call(cardCall.options, 'maxDisplay'), false);
  });

  it('/attach <id> 对已管理 OpenCode 会话直接绑定现有 Walker session', async () => {
    const mocks = makeMocks();
    mocks.driver.listSessions = async () => [
      { id: 'ses_managed', title: 'managed', cwd: 'H:\\walker', status: 'idle' },
    ];
    mocks.sessionService.listSessions = () => [
      { id: 'wks_existing1', agent: 'opencode', status: 'idle', cwd: 'H:\\walker', agentRef: { opencodeSessionId: 'ses_managed' } },
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

  it('/attach <id> 可按完整 OpenCode session id 直接纳入指定会话', async () => {
    const mocks = makeMocks();
    let createOpts;
    mocks.driver.listSessions = async () => [
      { id: 'ses_foreign_full_id_12345', title: 'foreign', cwd: 'H:\\rsstest', status: 'idle' },
    ];
    mocks.sessionService.listSessions = () => [];
    mocks.sessionService.createSession = (opts) => {
      createOpts = opts;
      return { id: 'wks_attached_foreign', agent: opts.agent, status: 'created', agentRef: opts.agentRef };
    };
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      defaultCwd: 'H:\\walker',
    });

    const result = await dispatcher.handleCommand({
      type: 'command', name: 'attach', args: ['ses_foreign_full_id_12345'],
      routeKey: 'feishu:oc_chat1:om_root1',
      messageId: 'om_attach_foreign1', chatId: 'oc_chat1',
    });

    assert.equal(result.sessionId, 'wks_attached_foreign');
    assert.equal(createOpts.route, 'feishu:oc_chat1:om_root1');
    assert.equal(createOpts.cwd, 'H:\\rsstest');
    assert.equal(createOpts.agentRef.opencodeSessionId, 'ses_foreign_full_id_12345');
    assert.ok(mocks.feishuApi.calls.some((c) => c.type === 'replyText' && c.text.includes('ses_foreign_full_id_12345')));
  });
});

describe('MessageDispatcher /delete command', () => {
  it('/delete 在卡片回调无 messageId 时使用 chatId 回复', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getSession = () => ({ id: 'wks_delete1', agent: 'opencode', agentRef: { opencodeSessionId: 'ses_delete1' } });
    mocks.sessionService.listSessionsInRoute = () => [{ id: 'wks_delete1' }];
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
    delete mocks.feishuApi.sendModelList;
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle' });
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

  it('/model 无参数使用当前 session agent 的模型目录并优先发送模型卡片', async () => {
    const mocks = makeMocks();
    const currentDriver = {
      ensureReadyCalls: 0,
      listModelsCalls: 0,
      ensureReady: async () => { currentDriver.ensureReadyCalls += 1; },
      listModels: async () => {
        currentDriver.listModelsCalls += 1;
        return [
          { id: 'custom-model', name: 'Custom Model', provider: 'custom', status: 'active', enabled: true },
        ];
      },
    };
    const opencodeDriver = {
      ensureReady: async () => { throw new Error('should not use opencode'); },
      listModels: async () => { throw new Error('should not list opencode'); },
    };
    mocks.sessionService.getCurrent = () => ({ id: 'wks_custom1', agent: 'custom-agent', status: 'idle', model: { providerID: 'custom', modelID: 'custom-model' } });
    mocks.driverRegistry.get = (name) => name === 'custom-agent' ? currentDriver : opencodeDriver;
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'user' });

    const result = await dispatcher.handleCommand({
      name: 'model', args: [], routeKey: 'feishu:oc_chat1:ou_user1',
      messageId: 'om_model_card', chatId: 'oc_chat1',
    });

    assert.equal(currentDriver.ensureReadyCalls, 1);
    assert.equal(currentDriver.listModelsCalls, 1);
    assert.equal(result.models.length, 1);
    const card = mocks.feishuApi.calls.find(c => c.type === 'sendModelList');
    assert.ok(card, '应优先发送模型列表卡片');
    assert.deepEqual(card.models, [{ id: 'custom-model', name: 'Custom Model', provider: 'custom', status: 'active', enabled: true }]);
    assert.equal(card.options.routeKey, 'feishu:oc_chat1:ou_user1');
    assert.deepEqual(card.options.currentModel, { providerID: 'custom', modelID: 'custom-model' });
    assert.equal(Object.hasOwn(card.options, 'updateMessageId'), false, '首次 /model 不应更新触发消息');
    assert.equal(mocks.feishuApi.calls.some(c => c.type === 'replyText'), false);
  });

  it('/model --page 分页请求复用当前 agent 目录并可在同一卡片往返', async () => {
    const mocks = makeMocks();
    const session = {
      id: 'wks_page1', agent: 'custom-agent', status: 'idle',
      model: { providerID: 'custom', modelID: 'model-1' },
    };
    const updatedFields = [];
    const currentDriver = {
      listModelsCalls: 0,
      ensureReady: async () => {},
      listModels: async () => {
        currentDriver.listModelsCalls += 1;
        return [{ id: 'model-1', name: 'Model 1', provider: 'custom', status: 'active', enabled: true }];
      },
    };
    mocks.sessionService.getCurrent = () => session;
    mocks.sessionService.updateSessionField = (sid, field, value) => { updatedFields.push({ sid, field, value }); };
    mocks.driverRegistry.get = (name) => name === 'custom-agent' ? currentDriver : null;
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'user' });
    const baseCmd = {
      name: 'model', routeKey: 'feishu:oc_chat1:ou_user1',
      messageId: 'om_model_pagination', chatId: 'oc_chat1',
    };

    await dispatcher.handleCommand(Object.assign({}, baseCmd, { args: ['--page', '2'] }));
    await dispatcher.handleCommand(Object.assign({}, baseCmd, { args: ['--page', '1'] }));
    await dispatcher.handleCommand(Object.assign({}, baseCmd, { args: ['--page', '2'] }));

    const cards = mocks.feishuApi.calls.filter(c => c.type === 'sendModelList');
    assert.equal(currentDriver.listModelsCalls, 3, '分页动作每次都应刷新当前 agent 模型目录');
    assert.deepEqual(cards.map(c => c.options.page), ['2', '1', '2']);
    assert.deepEqual(cards.map(c => c.options.updateMessageId), [
      'om_model_pagination', 'om_model_pagination', 'om_model_pagination',
    ]);
    assert.ok(cards.every(c => c.options.routeKey === 'feishu:oc_chat1:ou_user1'));
    for (const card of cards) {
      assert.deepEqual(card.options.currentModel, { providerID: 'custom', modelID: 'model-1' });
    }
    assert.equal(updatedFields.length, 0, '分页动作不能更新 session.model');
  });

  it('/model --page 缺失或非法页码仍交给卡片层归一化且不更新模型', async () => {
    const mocks = makeMocks();
    const updatedFields = [];
    mocks.sessionService.getCurrent = () => ({
      id: 'wks_bad_page1', agent: 'opencode', status: 'idle',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
    });
    mocks.sessionService.updateSessionField = (sid, field, value) => { updatedFields.push({ sid, field, value }); };
    mocks.driver.listModels = async () => [
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic', status: 'active', enabled: true },
    ];
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'user' });

    await dispatcher.handleCommand({
      name: 'model', args: ['--page'], routeKey: 'feishu:oc_chat1:ou_user1',
      messageId: 'om_model_bad_page', chatId: 'oc_chat1',
    });
    await dispatcher.handleCommand({
      name: 'model', args: ['--page', 'not-a-number'], routeKey: 'feishu:oc_chat1:ou_user1',
      messageId: 'om_model_bad_page', chatId: 'oc_chat1',
    });

    const cards = mocks.feishuApi.calls.filter(c => c.type === 'sendModelList');
    assert.equal(cards.length, 2);
    assert.equal(cards[0].options.page, undefined);
    assert.equal(cards[1].options.page, 'not-a-number');
    assert.equal(updatedFields.length, 0);
    assert.equal(mocks.feishuApi.calls.some(c => c.type === 'replyText' && c.text.includes('Model not found')), false);
  });

  it('/model --page 卡片 patch 返回空值或抛错时 fallback 到纯文本列表', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_page_fallback1', agent: 'opencode', status: 'idle' });
    mocks.driver.listModels = async () => [
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic', status: 'active', enabled: true },
    ];
    let sendCalls = 0;
    mocks.feishuApi.sendModelList = () => {
      sendCalls += 1;
      if (sendCalls === 1) return null;
      throw new Error('patch failed');
    };
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'user' });

    await dispatcher.handleCommand({
      name: 'model', args: ['--page', '2'], routeKey: 'feishu:oc_chat1:ou_user1',
      messageId: 'om_model_patch_falsy', chatId: 'oc_chat1',
    });
    await dispatcher.handleCommand({
      name: 'model', args: ['--page', '2'], routeKey: 'feishu:oc_chat1:ou_user1',
      messageId: 'om_model_patch_throw', chatId: 'oc_chat1',
    });

    const replies = mocks.feishuApi.calls.filter(c => c.type === 'replyText');
    assert.equal(replies.length, 2);
    assert.ok(replies.every(c => c.text.includes('claude-sonnet-4')));
  });

  it('/model 无参数在当前 driver 不支持模型目录时提示不支持', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_plain1', agent: 'plain-agent', status: 'idle' });
    mocks.driverRegistry.get = () => ({ ensureReady: async () => true });
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'user' });

    const result = await dispatcher.handleCommand({
      name: 'model', args: [], routeKey: 'feishu:oc_chat1:ou_user1',
      messageId: 'om_model_unsupported', chatId: 'oc_chat1',
    });

    assert.equal(result.error, 'list_models_not_supported');
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyText');
    assert.equal(reply.text, '不支持模型列表');
  });

  it('/model 无参数无卡片能力时 fallback 到纯文本列表', async () => {
    const mocks = makeMocks();
    delete mocks.feishuApi.sendModelList;
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle' });
    mocks.driver.listModels = async () => [
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic' },
    ];
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'user' });

    const result = await dispatcher.handleCommand({
      name: 'model', args: [], routeKey: 'feishu:oc_chat1:ou_user1',
      messageId: 'om_model_text_fallback', chatId: 'oc_chat1',
    });

    assert.equal(result.models.length, 1);
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyText');
    assert.ok(reply.text.includes('claude-sonnet-4'));
  });

  it('/model 无参数模型卡片发送失败时 fallback 到纯文本列表', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle' });
    mocks.driver.listModels = async () => [
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic' },
    ];
    mocks.feishuApi.sendModelList = () => { throw new Error('send model card failed'); };
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'user' });

    const result = await dispatcher.handleCommand({
      name: 'model', args: [], routeKey: 'feishu:oc_chat1:ou_user1',
      messageId: 'om_model_card_fail_fallback', chatId: 'oc_chat1',
    });

    assert.equal(result.models.length, 1);
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyText');
    assert.ok(reply.text.includes('claude-sonnet-4'));
  });

  it('/model <model_id> 设置当前会话模型并通过目录补全 providerID', async () => {
    const mocks = makeMocks();
    const updatedFields = [];
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', model: '' });
    mocks.sessionService.updateSessionField = (sid, field, value) => { updatedFields.push({ sid, field, value }); };
    mocks.driver.listModels = async () => [
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic', status: 'active', enabled: true },
      { id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', status: 'active', enabled: true },
    ];
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'user' });

    const result = await dispatcher.handleCommand({
      name: 'model', args: ['claude-sonnet-4'], routeKey: 'feishu:oc_chat1:ou_user1',
      messageId: 'om_model_set', chatId: 'oc_chat1',
    });

    assert.deepEqual(result.model, { modelID: 'claude-sonnet-4', providerID: 'anthropic' });
    assert.equal(result.sessionId, 'wks_bound1');
    assert.deepEqual(updatedFields[0], { sid: 'wks_bound1', field: 'model', value: { modelID: 'claude-sonnet-4', providerID: 'anthropic' } });
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyText');
    assert.ok(reply.text.includes('anthropic/claude-sonnet-4'));
  });

  it('/model provider/model_id 指定 provider', async () => {
    const mocks = makeMocks();
    const updatedFields = [];
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', model: '' });
    mocks.sessionService.updateSessionField = (sid, field, value) => { updatedFields.push({ sid, field, value }); };
    mocks.driver.listModels = async () => [
      { id: 'gpt-5.5', name: 'GPT-5.5', provider: 'cpa', status: 'active', enabled: true },
    ];
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

  it('/model provider/model_id 只使用当前 session agent driver', async () => {
    const mocks = makeMocks();
    const updatedFields = [];
    const customDriver = {
      ensureReadyCalls: 0,
      listModelsCalls: 0,
      ensureReady: async () => { customDriver.ensureReadyCalls += 1; },
      listModels: async () => {
        customDriver.listModelsCalls += 1;
        return [{ id: 'custom-model', name: 'Custom Model', provider: 'custom', status: 'active', enabled: true }];
      },
    };
    const opencodeDriver = {
      ensureReady: async () => { throw new Error('should not touch opencode'); },
      listModels: async () => { throw new Error('should not list opencode'); },
    };
    mocks.sessionService.getCurrent = () => ({ id: 'wks_custom1', agent: 'custom-agent', status: 'idle', model: '' });
    mocks.sessionService.updateSessionField = (sid, field, value) => { updatedFields.push({ sid, field, value }); };
    mocks.driverRegistry.get = (name) => name === 'custom-agent' ? customDriver : opencodeDriver;
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'user' });

    const result = await dispatcher.handleCommand({
      name: 'model', args: ['custom/custom-model'], routeKey: 'feishu:oc_chat1:ou_user1',
      messageId: 'om_model_custom_arg', chatId: 'oc_chat1',
    });

    assert.equal(customDriver.ensureReadyCalls, 1);
    assert.equal(customDriver.listModelsCalls, 1);
    assert.deepEqual(result.model, { modelID: 'custom-model', providerID: 'custom' });
    assert.deepEqual(updatedFields[0], { sid: 'wks_custom1', field: 'model', value: { modelID: 'custom-model', providerID: 'custom' } });
  });

  it('/model provider/model_id 当前 agent 缺失或不支持模型目录时提示不支持且不更新模型', async () => {
    const missingAgentMocks = makeMocks();
    const missingUpdates = [];
    missingAgentMocks.sessionService.getCurrent = () => ({ id: 'wks_missing_agent1', status: 'idle', model: '' });
    missingAgentMocks.sessionService.updateSessionField = (sid, field, value) => { missingUpdates.push({ sid, field, value }); };
    const missingDispatcher = new MessageDispatcher({ ...missingAgentMocks, routeMode: 'user' });

    const missingResult = await missingDispatcher.handleCommand({
      name: 'model', args: ['custom/custom-model'], routeKey: 'feishu:oc_chat1:ou_user1',
      messageId: 'om_model_arg_missing_agent', chatId: 'oc_chat1',
    });

    assert.equal(missingResult.error, 'list_models_not_supported');
    assert.equal(missingUpdates.length, 0);
    assert.equal(missingAgentMocks.feishuApi.calls.find(c => c.type === 'replyText').text, '不支持模型列表');

    const unsupportedMocks = makeMocks();
    const unsupportedUpdates = [];
    unsupportedMocks.sessionService.getCurrent = () => ({ id: 'wks_plain1', agent: 'plain-agent', status: 'idle', model: '' });
    unsupportedMocks.sessionService.updateSessionField = (sid, field, value) => { unsupportedUpdates.push({ sid, field, value }); };
    unsupportedMocks.driverRegistry.get = () => ({ ensureReady: async () => true });
    const unsupportedDispatcher = new MessageDispatcher({ ...unsupportedMocks, routeMode: 'user' });

    const unsupportedResult = await unsupportedDispatcher.handleCommand({
      name: 'model', args: ['custom/custom-model'], routeKey: 'feishu:oc_chat1:ou_user1',
      messageId: 'om_model_arg_unsupported', chatId: 'oc_chat1',
    });

    assert.equal(unsupportedResult.error, 'list_models_not_supported');
    assert.equal(unsupportedUpdates.length, 0);
    assert.equal(unsupportedMocks.feishuApi.calls.find(c => c.type === 'replyText').text, '不支持模型列表');
  });

  it('/model <unknown_id> 模型目录无匹配时拒绝', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', model: '' });
    mocks.driver.listModels = async () => [
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic', status: 'active', enabled: true },
    ];
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'user' });

    const result = await dispatcher.handleCommand({
      name: 'model', args: ['unknown-model'], routeKey: 'feishu:oc_chat1:ou_user1',
      messageId: 'om_model_unknown', chatId: 'oc_chat1',
    });

    assert.equal(result.error, 'Model not found: unknown-model. Use /model to list available models.');
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyText');
    assert.ok(reply.text.includes('not found'));
  });

  it('/model <ambiguous_id> 跨 provider 重名时提示用完整 ID', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', model: '' });
    mocks.driver.listModels = async () => [
      { id: 'shared-model', name: 'Shared A', provider: 'anthropic', status: 'active', enabled: true },
      { id: 'shared-model', name: 'Shared B', provider: 'openai', status: 'active', enabled: true },
    ];
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'user' });

    const result = await dispatcher.handleCommand({
      name: 'model', args: ['shared-model'], routeKey: 'feishu:oc_chat1:ou_user1',
      messageId: 'om_model_ambig', chatId: 'oc_chat1',
    });

    assert.ok(result.error.includes('Multiple models match'));
    assert.ok(result.error.includes('anthropic/shared-model'));
    assert.ok(result.error.includes('openai/shared-model'));
  });

  it('/model <provider/model_id> 目录中无匹配时拒绝', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_bound1', agent: 'opencode', status: 'idle', model: '' });
    mocks.driver.listModels = async () => [
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', provider: 'anthropic', status: 'active', enabled: true },
    ];
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'user' });

    const result = await dispatcher.handleCommand({
      name: 'model', args: ['unknown/gpt-9'], routeKey: 'feishu:oc_chat1:ou_user1',
      messageId: 'om_model_badprov', chatId: 'oc_chat1',
    });

    assert.ok(result.error.includes('not found'));
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

  it('同一卡片不同 /model 参数均会执行，完全相同参数重复点击会去重', async () => {
    const mocks = makeMocks();
    const session = { id: 'wks_bound1', agent: 'opencode', status: 'idle', model: '' };
    const updates = [];
    mocks.sessionService.getCurrent = () => session;
    mocks.sessionService.updateSessionField = (sid, field, value) => {
      updates.push({ sid, field, value });
      session[field] = value;
    };
    mocks.driver.listModels = async () => [
      { id: 'model-a', name: 'Model A', provider: 'p1', status: 'active', enabled: true },
      { id: 'model-b', name: 'Model B', provider: 'p2', status: 'active', enabled: true },
    ];
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'user' });
    const baseCmd = { name: 'model', routeKey: 'feishu:oc_chat1:ou_user1', messageId: 'om_model_button', chatId: 'oc_chat1' };

    const first = await dispatcher.handleCommand(Object.assign({}, baseCmd, { args: ['p1/model-a'] }));
    const second = await dispatcher.handleCommand(Object.assign({}, baseCmd, { args: ['p2/model-b'] }));
    const duplicate = await dispatcher.handleCommand(Object.assign({}, baseCmd, { args: ['p2/model-b'] }));

    assert.deepEqual(first.model, { providerID: 'p1', modelID: 'model-a' });
    assert.deepEqual(second.model, { providerID: 'p2', modelID: 'model-b' });
    assert.deepEqual(duplicate, { duplicate: true });
    assert.equal(updates.length, 2);
    assert.deepEqual(session.model, { providerID: 'p2', modelID: 'model-b' });
  });
});

describe('MessageDispatcher /help command', () => {
  it('/help 优先发送帮助卡片', async () => {
    const mocks = makeMocks();
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'user' });

    const result = await dispatcher.handleCommand({
      name: 'help', args: [], routeKey: 'feishu:oc_chat1:ou_user1',
      messageId: 'om_help_card', chatId: 'oc_chat1',
    });

    assert.deepEqual(result, { help: true });
    const card = mocks.feishuApi.calls.find(c => c.type === 'sendHelpCard');
    assert.ok(card, '应优先发送帮助卡片');
    assert.ok(card.commands.some(c => c.name === 'model'));
    assert.equal(card.options.routeKey, 'feishu:oc_chat1:ou_user1');
    assert.equal(mocks.feishuApi.calls.some(c => c.type === 'replyText'), false);
  });

  it('/help 无卡片能力时 fallback 到纯文本帮助', async () => {
    const mocks = makeMocks();
    delete mocks.feishuApi.sendHelpCard;
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'user' });

    const result = await dispatcher.handleCommand({
      name: 'help', args: [], routeKey: 'feishu:oc_chat1:ou_user1',
      messageId: 'om_help_text', chatId: 'oc_chat1',
    });

    assert.deepEqual(result, { help: true });
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyText');
    assert.ok(reply.text.includes('Walker 命令清单'));
  });

  it('/help 帮助卡片发送失败时 fallback 到纯文本帮助', async () => {
    const mocks = makeMocks();
    mocks.feishuApi.sendHelpCard = () => { throw new Error('send help card failed'); };
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'user' });

    const result = await dispatcher.handleCommand({
      name: 'help', args: [], routeKey: 'feishu:oc_chat1:ou_user1',
      messageId: 'om_help_card_fail_fallback', chatId: 'oc_chat1',
    });

    assert.deepEqual(result, { help: true });
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyText');
    assert.ok(reply.text.includes('Walker 命令清单'));
  });
});

describe('MessageDispatcher model footer', () => {
  it('普通 Agent 最终文本底部追加当前 session 模型 footer', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({
      id: 'wks_footer1', agent: 'opencode', status: 'idle',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      agentRef: { opencodeSessionId: 'ses_footer1' },
    });
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'thread', progressStyle: 'card' });

    await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_footer1', openId: 'ou_user1', text: 'test',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });

    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyMarkdown');
    assert.equal(reply.text, 'Hello\n\n---\n模型：anthropic/claude-sonnet-4');
  });

  it('普通 Agent 最终文本无模型时 footer 显示未指定', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_footer2', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_footer2' } });
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'thread', progressStyle: 'card' });

    await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_footer2', openId: 'ou_user1', text: 'test',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });

    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyMarkdown');
    assert.equal(reply.text, 'Hello\n\n---\n模型：未指定');
  });
});

describe('MessageDispatcher 1:N route commands', () => {
  it('/use 切焦点到指定 session（而非覆盖式绑定）', async () => {
    const mocks = makeMocks();
    const setFocusCalls = [];
    mocks.sessionService.setFocus = (routeKey, sessionId) => { setFocusCalls.push({ routeKey, sessionId }); };
    mocks.sessionService.listSessionsInRoute = () => [
      { id: 'wks_a', agent: 'opencode', status: 'idle' },
      { id: 'wks_b', agent: 'opencode', status: 'idle' },
    ];
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    const result = await dispatcher.handleCommand({
      type: 'command', name: 'use', args: ['wks_b'],
      routeKey: 'feishu:oc_chat1:om_root1',
      messageId: 'om_use_focus1', chatId: 'oc_chat1',
    });

    assert.equal(result.focus, 'wks_b');
    assert.deepEqual(setFocusCalls, [{ routeKey: 'feishu:oc_chat1:om_root1', sessionId: 'wks_b' }]);
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyText');
    assert.ok(reply.text.includes('wks_b'));
  });

  it('/use 不在 route sessions 列表中的 session id 返回错误', async () => {
    const mocks = makeMocks();
    mocks.sessionService.setFocus = () => { throw new Error('session not in route: wks_other'); };
    mocks.sessionService.listSessionsInRoute = () => [
      { id: 'wks_a', agent: 'opencode', status: 'idle' },
    ];
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    const result = await dispatcher.handleCommand({
      type: 'command', name: 'use', args: ['wks_other'],
      routeKey: 'feishu:oc_chat1:om_root1',
      messageId: 'om_use_notinroute1', chatId: 'oc_chat1',
    });

    assert.equal(result.error, 'command_failed');
    assert.ok(mocks.feishuApi.calls.some(c => c.type === 'sendErrorCard' && c.message.includes('wks_other')));
  });

  it('/use off 从 route 移除焦点 session（保留其他 session）', async () => {
    const mocks = makeMocks();
    const removeCalls = [];
    mocks.sessionService.removeSessionFromRoute = (routeKey, sessionId) => { removeCalls.push({ routeKey, sessionId }); };
    mocks.sessionService.getCurrent = () => ({ id: 'wks_focus1', agent: 'opencode', status: 'idle' });
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    const result = await dispatcher.handleCommand({
      type: 'command', name: 'use', args: ['off'],
      routeKey: 'feishu:oc_chat1:om_root1',
      messageId: 'om_use_off1', chatId: 'oc_chat1',
    });

    assert.equal(result.removed, 'wks_focus1');
    assert.deepEqual(removeCalls, [{ routeKey: 'feishu:oc_chat1:om_root1', sessionId: 'wks_focus1' }]);
  });

  it('/use off 无焦点 session 时返回提示', async () => {
    const mocks = makeMocks();
    const removeCalls = [];
    mocks.sessionService.removeSessionFromRoute = (routeKey, sessionId) => { removeCalls.push({ routeKey, sessionId }); };
    mocks.sessionService.getCurrent = () => null;
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    const result = await dispatcher.handleCommand({
      type: 'command', name: 'use', args: ['off'],
      routeKey: 'feishu:oc_chat1:om_root1',
      messageId: 'om_use_off_none1', chatId: 'oc_chat1',
    });

    assert.equal(result.noFocus, true);
    assert.equal(removeCalls.length, 0);
  });

  it('/list 列出 route 下多 session（焦点在前）', async () => {
    const mocks = makeMocks();
    const sessions = [
      { id: 'wks_focus1', agent: 'opencode', status: 'idle' },
      { id: 'wks_other1', agent: 'opencode', status: 'running' },
    ];
    mocks.sessionService.listSessionsInRoute = (_routeKey) => sessions;
    mocks.sessionService.getCurrent = () => sessions[0];
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    const result = await dispatcher.handleCommand({
      type: 'command', name: 'list', args: [],
      routeKey: 'feishu:oc_chat1:om_root1',
      messageId: 'om_list_route1', chatId: 'oc_chat1',
    });

    assert.deepEqual(result.sessions, sessions);
    const cardCall = mocks.feishuApi.calls.find(c => c.type === 'sendSessionList');
    assert.ok(cardCall);
    assert.deepEqual(cardCall.sessions, sessions);
    assert.equal(cardCall.currentId, 'wks_focus1');
    assert.equal(cardCall.options.routeKey, 'feishu:oc_chat1:om_root1');
    assert.deepEqual(mocks.sessionService.touchRouteCalls, ['feishu:oc_chat1:om_root1']);
  });

  it('/status 显示多 session 状态', async () => {
    const mocks = makeMocks();
    const focusSession = {
      id: 'wks_focus1', agent: 'opencode', status: 'running', cwd: 'H:\\walker',
      agentRef: { opencodeSessionId: 'ses_focus1' },
    };
    const otherSession = {
      id: 'wks_other1', agent: 'opencode', status: 'idle', cwd: 'H:\\walker',
      agentRef: { opencodeSessionId: 'ses_other1' },
    };
    mocks.sessionService.getCurrent = () => focusSession;
    mocks.sessionService.listSessionsInRoute = () => [focusSession, otherSession];
    mocks.sessionService.getRouteCwd = () => 'H:\\walker';
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'thread' });
    dispatcher.sessionWatchStops.set(focusSession.id, () => {});
    dispatcher.turnStates.set(focusSession.id, {
      token: 1, startedAt: Date.now() - 1200, lastEventAt: Date.now() - 500, cancelled: false,
    });

    const result = await dispatcher.handleCommand({
      type: 'command', name: 'status', args: [],
      routeKey: 'feishu:oc_chat1:om_root1', messageId: 'om_status_multi1', chatId: 'oc_chat1',
    });

    assert.equal(result.sessionId, 'wks_focus1');
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyText');
    assert.match(reply.text, /Route: feishu:oc_chat1:om_root1/);
    assert.match(reply.text, /Active sessions: 2/);
    assert.match(reply.text, /Focus: wks_focus1/);
    assert.match(reply.text, /Other:.*wks_other1/);
  });

  it('/status 无 session 时显示未绑定提示', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => null;
    mocks.sessionService.listSessionsInRoute = () => [];
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'thread' });

    const result = await dispatcher.handleCommand({
      type: 'command', name: 'status', args: [],
      routeKey: 'feishu:oc_chat1:om_root1', messageId: 'om_status_empty1', chatId: 'oc_chat1',
    });

    assert.equal(result.noSession, true);
  });
});

describe('MessageDispatcher non-focus output', () => {
  it('非焦点 session 输出带 session 标识前缀', async () => {
    const mocks = makeMocks();
    const focusSession = { id: 'wks_focus1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_focus1' } };
    const nonFocusSession = { id: 'wks_nonfocus1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_nonfocus1' } };
    mocks.sessionService.getCurrent = () => focusSession;
    mocks.sessionService.getRouteForSession = (sessionId) => sessionId === 'wks_nonfocus1' || sessionId === 'wks_focus1' ? 'feishu:oc_chat1:om_root1' : null;
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      nonFocusOutput: true,
    });

    dispatcher._handleWatchedSessionEvent(nonFocusSession, 'oc_chat1', new AgentEvent(AgentEvent.TYPE_TEXT, { text: '非焦点回复' }));
    dispatcher._handleWatchedSessionEvent(nonFocusSession, 'oc_chat1', new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }));
    await new Promise((resolve) => setImmediate(resolve));

    const sendMarkdown = mocks.feishuApi.calls.find(c => c.type === 'sendMarkdown' && c.text.includes('非焦点回复'));
    assert.ok(sendMarkdown, '非焦点 session 的输出应发送到群');
    assert.ok(sendMarkdown.text.startsWith('[session: wks_nonf'), '非焦点输出应带 [session: <id前8位>] 前缀');
  });

  it('焦点 session 输出不带 session 标识前缀（保持原有体验）', async () => {
    const mocks = makeMocks();
    const focusSession = { id: 'wks_focus1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_focus1' } };
    mocks.sessionService.getCurrent = () => focusSession;
    mocks.sessionService.getRouteForSession = () => 'feishu:oc_chat1:om_root1';
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      nonFocusOutput: true,
    });

    dispatcher._handleWatchedSessionEvent(focusSession, 'oc_chat1', new AgentEvent(AgentEvent.TYPE_TEXT, { text: '焦点回复' }));
    dispatcher._handleWatchedSessionEvent(focusSession, 'oc_chat1', new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }));
    await new Promise((resolve) => setImmediate(resolve));

    const sendMarkdown = mocks.feishuApi.calls.find(c => c.type === 'sendMarkdown' && c.text.includes('焦点回复'));
    assert.ok(sendMarkdown);
    assert.equal(sendMarkdown.text.startsWith('[session:'), false, '焦点输出不应带 session 标识前缀');
  });

  it('nonFocusOutput=false 时非焦点 session 静默不回群', async () => {
    const mocks = makeMocks();
    const focusSession = { id: 'wks_focus1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_focus1' } };
    const nonFocusSession = { id: 'wks_nonfocus1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_nonfocus1' } };
    mocks.sessionService.getCurrent = () => focusSession;
    mocks.sessionService.getRouteForSession = (sessionId) => sessionId === 'wks_nonfocus1' || sessionId === 'wks_focus1' ? 'feishu:oc_chat1:om_root1' : null;
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      nonFocusOutput: false,
    });

    dispatcher._handleWatchedSessionEvent(nonFocusSession, 'oc_chat1', new AgentEvent(AgentEvent.TYPE_TEXT, { text: '不应发送' }));
    dispatcher._handleWatchedSessionEvent(nonFocusSession, 'oc_chat1', new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }));
    await new Promise((resolve) => setImmediate(resolve));

    const sendMarkdown = mocks.feishuApi.calls.find(c => c.type === 'sendMarkdown' && c.text.includes('不应发送'));
    assert.equal(!!sendMarkdown, false, 'nonFocusOutput=false 时非焦点 session 不应发送到群');
  });
});

describe('MessageDispatcher ensureWatchForSession', () => {
  it('纳入非焦点 session 后启动 watch', () => {
    const mocks = makeMocks();
    const session = { id: 'wks_enroll1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_enroll1', serverUrl: 'http://localhost:4096' } };
    mocks.sessionService.getSession = (id) => id === session.id ? session : null;
    mocks.sessionService.getRouteForSession = () => 'feishu:oc_chat1:om_root1';
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    assert.equal(dispatcher.sessionWatchStops.has(session.id), false, '调用前不应有 watch');
    dispatcher.ensureWatchForSession(session.id);
    assert.equal(dispatcher.sessionWatchStops.has(session.id), true, '调用后应启动 watch');
  });

  it('session 不存在时安全跳过', () => {
    const mocks = makeMocks();
    mocks.sessionService.getSession = () => null;
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    dispatcher.ensureWatchForSession('wks_nope');
    assert.equal(dispatcher.sessionWatchStops.size, 0, 'session 不存在时不应启动 watch');
  });

  it('已有 watch 时幂等不重复启动', () => {
    const mocks = makeMocks();
    const session = { id: 'wks_dup1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_dup1' } };
    mocks.sessionService.getSession = (id) => id === session.id ? session : null;
    mocks.sessionService.getRouteForSession = () => 'feishu:oc_chat1:om_root1';
    let watchCallCount = 0;
    mocks.driver.watchSession = () => { watchCallCount++; return () => {}; };
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    dispatcher.ensureWatchForSession(session.id);
    dispatcher.ensureWatchForSession(session.id);
    assert.equal(watchCallCount, 1, '重复调用 ensureWatchForSession 不应重复 watch');
  });
});

function makeClearMocks(overrides) {
  const mocks = makeMocks();
  const session = Object.assign({
    id: 'wks_clear1',
    agent: 'opencode',
    status: 'idle',
    agentRef: {
      opencodeSessionId: 'ses_clear1',
      transport: 'tui-bridge',
      runtimeId: 'rt_clear1',
    },
  }, overrides && overrides.session);
  mocks.sessionService.getCurrent = () => session;
  mocks.sessionService.getSession = (id) => id === session.id ? session : null;
  mocks.sessionService.getRouteForSession = () => 'feishu:oc_chat1:om_root1';
  mocks.sessionService.listSessionsInRoute = () => [session];
  mocks.driver.createSessionCalls = [];
  mocks.driver.createSession = async () => {
    mocks.driver.createSessionCalls.push(true);
    return { opencodeSessionId: 'ses_should_not', serverUrl: 'http://localhost:4096' };
  };
  mocks.driver.clearSessionCalls = [];
  mocks.driver.clearSession = async (agentRef) => {
    mocks.driver.clearSessionCalls.push(agentRef);
    return {
      runtimeId: 'rt_clear1',
      oldSessionId: 'ses_clear1',
      newSessionId: 'ses_clear2',
      walkerSessionId: 'wks_clear2',
    };
  };
  mocks.driver.openTerminalCalls = [];
  mocks.driver.openTerminal = async () => { mocks.driver.openTerminalCalls.push(true); };
  mocks.driver.updateConfigCalls = [];
  mocks.driver.updateConfig = async () => { mocks.driver.updateConfigCalls.push(true); };
  mocks.driver.stop = async () => {};
  mocks.driver.delete = async () => {};
  mocks.sessionService.stopSessionCalls = [];
  mocks.sessionService.stopSession = () => { mocks.sessionService.stopSessionCalls.push(true); };
  mocks.sessionService.deleteSessionCalls = [];
  mocks.sessionService.deleteSession = () => { mocks.sessionService.deleteSessionCalls.push(true); };
  mocks.sessionService.updateConfigCalls = [];
  mocks.sessionService.updateSessionField = () => {};
  return mocks;
}

function clearCmd(extra) {
  return Object.assign({
    type: 'command', name: 'clear', args: [],
    routeKey: 'feishu:oc_chat1:om_root1',
    messageId: 'om_clear1', chatId: 'oc_chat1',
  }, extra || {});
}

describe('MessageDispatcher /clear command', () => {
  it('/clear 成功时调用 driver.clearSession 并回复旧新 session ID，保持当前 TUI 窗口', async () => {
    const mocks = makeClearMocks();
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    const result = await dispatcher.handleCommand(clearCmd());

    assert.equal(result.cleared, true);
    assert.equal(mocks.driver.clearSessionCalls.length, 1);
    assert.equal(mocks.driver.clearSessionCalls[0].opencodeSessionId, 'ses_clear1');
    assert.equal(mocks.driver.createSessionCalls.length, 0, '不得调用 driver.createSession');
    assert.equal(mocks.driver.openTerminalCalls.length, 0, '不得调用 runtime.openTerminal');
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyText');
    assert.ok(reply, '应回复成功消息');
    assert.match(reply.text, /ses_clear1/);
    assert.match(reply.text, /ses_clear2/);
    assert.match(reply.text, /wks_clear2/);
  });

  it('/clear 不调用 stop/delete 旧 session', async () => {
    const mocks = makeClearMocks();
    mocks.driver.stop = async () => { mocks.driver.stopCalls = (mocks.driver.stopCalls || 0) + 1; };
    mocks.driver.delete = async () => { mocks.driver.deleteCalls = (mocks.driver.deleteCalls || 0) + 1; };
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    await dispatcher.handleCommand(clearCmd());

    assert.equal(mocks.sessionService.stopSessionCalls.length, 0, '不应调用 stopSession');
    assert.equal(mocks.sessionService.deleteSessionCalls.length, 0, '不应调用 deleteSession');
    assert.equal(mocks.driver.stopCalls || 0, 0, '不应调用 driver.stop');
    assert.equal(mocks.driver.deleteCalls || 0, 0, '不应调用 driver.delete');
  });

  it('/clear 不修改旧 session model 或全局配置', async () => {
    const mocks = makeClearMocks();
    const updateFields = [];
    mocks.sessionService.updateSessionField = (sid, field, value) => { updateFields.push({ sid, field, value }); };
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    await dispatcher.handleCommand(clearCmd());

    assert.equal(mocks.driver.updateConfigCalls.length, 0, '不应调用 driver.updateConfig');
    const modelUpdates = updateFields.filter((u) => u.field === 'model');
    assert.equal(modelUpdates.length, 0, '不应修改旧 session model');
  });

  it('/clear 无绑定 session 时锁外立即拒绝，不排队等待 route lock', async () => {
    const mocks = makeClearMocks();
    mocks.sessionService.getCurrent = () => null;
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    const result = await dispatcher.handleCommand(clearCmd());

    assert.equal(result.noSession, true);
    assert.equal(mocks.driver.clearSessionCalls.length, 0);
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyText');
    assert.ok(reply);
    assert.match(reply.text, /\/new|\/attach/);
  });

  it('/clear 非 TUI transport 时锁外立即拒绝', async () => {
    const mocks = makeClearMocks({
      session: { agentRef: { opencodeSessionId: 'ses_clear1', transport: 'http', serverUrl: 'http://localhost:4096' } },
    });
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    const result = await dispatcher.handleCommand(clearCmd());

    assert.equal(result.error || result.rejected, true);
    assert.equal(mocks.driver.clearSessionCalls.length, 0);
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyText' || c.type === 'sendErrorCard');
    assert.ok(reply);
  });

  it('/clear session running 时锁外立即拒绝并提示先 /cancel', async () => {
    const mocks = makeClearMocks({
      session: { status: 'running' },
    });
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    const result = await dispatcher.handleCommand(clearCmd());

    assert.equal(result.busy || result.rejected, true);
    assert.equal(mocks.driver.clearSessionCalls.length, 0);
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyText' || c.type === 'sendErrorCard');
    assert.ok(reply);
    assert.match(reply.text || reply.message, /\/cancel/);
  });

  it('/clear 存在活动 turn state 时锁外立即拒绝', async () => {
    const mocks = makeClearMocks();
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });
    dispatcher.turnStates.set('wks_clear1', { token: 1, startedAt: Date.now(), lastEventAt: Date.now(), cancelled: false });

    const result = await dispatcher.handleCommand(clearCmd());

    assert.equal(result.busy || result.rejected, true);
    assert.equal(mocks.driver.clearSessionCalls.length, 0);
  });

  it('/clear 存在未完成 prompt queue 时锁外立即拒绝', async () => {
    const mocks = makeClearMocks();
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });
    let resolvePrompt;
    mocks.driver.prompt = async () => new Promise((resolve) => { resolvePrompt = resolve; });
    const pending = dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_clear_prompt1', openId: 'ou_user1', text: '慢任务',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
    });
    await new Promise((resolve) => setImmediate(resolve));

    const result = await dispatcher.handleCommand(clearCmd({ messageId: 'om_clear_during_prompt1' }));

    assert.equal(result.busy || result.rejected, true);
    assert.equal(mocks.driver.clearSessionCalls.length, 0);

    resolvePrompt([new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' })]);
    await pending;
    assert.equal(mocks.driver.clearSessionCalls.length, 0, 'prompt 完成后不应自动执行 clear');
  });

  it('/clear 锁内复检焦点变化时拒绝执行', async () => {
    const mocks = makeClearMocks();
    let getCurrentCalls = 0;
    const originalSession = mocks.sessionService.getCurrent();
    mocks.sessionService.getCurrent = () => {
      getCurrentCalls += 1;
      if (getCurrentCalls >= 2) return null;
      return originalSession;
    };
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    const result = await dispatcher.handleCommand(clearCmd());

    assert.equal(result.noSession || result.rejected || result.error, true);
    assert.equal(mocks.driver.clearSessionCalls.length, 0);
  });

  it('/clear 锁内复检状态变为 running 时拒绝执行', async () => {
    const mocks = makeClearMocks();
    const session = mocks.sessionService.getCurrent();
    let getCurrentCalls = 0;
    mocks.sessionService.getCurrent = () => {
      getCurrentCalls += 1;
      if (getCurrentCalls >= 2) session.status = 'running';
      return session;
    };
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    const result = await dispatcher.handleCommand(clearCmd());

    assert.equal(result.busy || result.rejected, true);
    assert.equal(mocks.driver.clearSessionCalls.length, 0);
  });

  it('/clear driver 缺少 clearSession 能力时拒绝执行', async () => {
    const mocks = makeClearMocks();
    delete mocks.driver.clearSession;
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    const result = await dispatcher.handleCommand(clearCmd());

    assert.equal(result.rejected || result.error, true);
    assert.equal(mocks.driver.createSessionCalls.length, 0, '禁止回退到 createSession');
    const reply = mocks.feishuApi.calls.find(c => c.type === 'replyText' || c.type === 'sendErrorCard');
    assert.ok(reply);
  });

  it('/clear bridge 失败时返回错误卡片且不伪报成功', async () => {
    const mocks = makeClearMocks();
    mocks.driver.clearSession = async () => { throw new Error('bridge clear failed'); };
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    const result = await dispatcher.handleCommand(clearCmd());

    assert.equal(result.error, 'command_failed');
    assert.ok(mocks.feishuApi.calls.some(c => c.type === 'sendErrorCard' && (c.message || '').includes('bridge clear failed')));
    const successReply = mocks.feishuApi.calls.find(c => c.type === 'replyText' && /ses_clear2/.test(c.text));
    assert.equal(!!successReply, false, '不应伪报成功');
  });

  it('/clear agent 非 opencode 时拒绝执行', async () => {
    const mocks = makeClearMocks({
      session: { agent: 'claude', agentRef: { opencodeSessionId: 'ses_clear1', transport: 'tui-bridge', runtimeId: 'rt_clear1' } },
    });
    const dispatcher = new MessageDispatcher({
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
    });

    const result = await dispatcher.handleCommand(clearCmd());

    assert.equal(result.rejected || result.error, true);
    assert.equal(mocks.driver.clearSessionCalls.length, 0);
  });
});

describe('MessageDispatcher model resolution on prompt', () => {
  function setupPromptMocks(sessionModel, defaultModel) {
    const mocks = makeMocks();
    const session = {
      id: 'wks_cur1', agent: 'opencode', status: 'idle',
      agentRef: { opencodeSessionId: 'ses_cur1', serverUrl: 'http://localhost:4096' },
    };
    if (sessionModel !== undefined) session.model = sessionModel;
    mocks.sessionService.getCurrent = () => session;
    mocks.sessionService.getSession = () => session;
    const opts = {
      sessionService: mocks.sessionService,
      driverRegistry: mocks.driverRegistry,
      feishuApi: mocks.feishuApi,
      dedup: mocks.dedup,
      routeMode: 'thread',
      progressStyle: 'card',
    };
    if (defaultModel !== undefined) opts.defaultModel = defaultModel;
    const dispatcher = new MessageDispatcher(opts);
    return { mocks, dispatcher, session };
  }

  it('prompt 时使用 session.model 对象', async () => {
    const { mocks, dispatcher } = setupPromptMocks({ providerID: 'anthropic', modelID: 'claude-sonnet-4' });

    await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_prompt_obj1', openId: 'ou_user1', text: 'hello',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
      routeKey: 'feishu:oc_chat1:root:om_root1',
    });

    assert.deepEqual(mocks.driver.promptCalls[0].model, { providerID: 'anthropic', modelID: 'claude-sonnet-4' });
  });

  it('prompt 时 session.model 为 string 时规范化为对象（向后兼容）', async () => {
    const { mocks, dispatcher } = setupPromptMocks('anthropic/claude-sonnet-4');

    await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_prompt_str1', openId: 'ou_user1', text: 'hello',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
      routeKey: 'feishu:oc_chat1:root:om_root1',
    });

    assert.deepEqual(mocks.driver.promptCalls[0].model, { providerID: 'anthropic', modelID: 'claude-sonnet-4' });
  });

  it('prompt 时 session.model 为裸 string 时规范化为无 providerID 对象', async () => {
    const { mocks, dispatcher } = setupPromptMocks('claude-sonnet-4');

    await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_prompt_bare1', openId: 'ou_user1', text: 'hello',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
      routeKey: 'feishu:oc_chat1:root:om_root1',
    });

    assert.deepEqual(mocks.driver.promptCalls[0].model, { providerID: '', modelID: 'claude-sonnet-4' });
  });

  it('prompt 时无 session.model 且有 defaultModel 时规范化为对象', async () => {
    const { mocks, dispatcher } = setupPromptMocks(undefined, 'anthropic/claude-sonnet-4');

    await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_prompt_dm1', openId: 'ou_user1', text: 'hello',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
      routeKey: 'feishu:oc_chat1:root:om_root1',
    });

    assert.deepEqual(mocks.driver.promptCalls[0].model, { providerID: 'anthropic', modelID: 'claude-sonnet-4' });
  });

  it('prompt 时无 session.model 且无 defaultModel 时 model 为 null', async () => {
    const { mocks, dispatcher } = setupPromptMocks(undefined);

    await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_prompt_nomodel1', openId: 'ou_user1', text: 'hello',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
      routeKey: 'feishu:oc_chat1:root:om_root1',
    });

    assert.equal(mocks.driver.promptCalls[0].model, null);
  });
});

describe('MessageDispatcher AbortSignal and transport recovery', () => {
  it('prompt 将 AbortSignal 传给 driver.prompt', async () => {
    const mocks = makeMocks();
    const session = { id: 'wks_signal1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_signal1' } };
    mocks.sessionService.getCurrent = () => session;
    mocks.sessionService.getSession = () => session;
    mocks.sessionService.markRunning = () => { session.status = 'running'; };
    mocks.sessionService.markIdle = () => { session.status = 'idle'; };
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'thread' });

    await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_signal1', openId: 'ou_user1', text: 'hello',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
      routeKey: 'feishu:oc_chat1:root:om_root1',
    });

    assert.ok(mocks.driver.promptCalls.length >= 1);
    assert.ok(mocks.driver.promptCalls[0].signal, 'signal 应透传给 driver.prompt');
    assert.equal(typeof mocks.driver.promptCalls[0].signal.addEventListener, 'function');
    assert.equal(mocks.driver.promptCalls[0].signal.aborted, false, '正常完成时 signal 未 abort');
  });

  it('/cancel 时 abort signal 并标记 cancelled', async () => {
    const mocks = makeMocks();
    const session = { id: 'wks_cancel_sig1', agent: 'opencode', status: 'running', agentRef: { opencodeSessionId: 'ses_cancel_sig1' } };
    let resolvePrompt;
    let capturedSignal = null;
    mocks.sessionService.getCurrent = () => session;
    mocks.sessionService.getSession = () => session;
    mocks.sessionService.markRunning = () => { session.status = 'running'; };
    mocks.sessionService.markIdle = () => { session.status = 'idle'; };
    mocks.driver.prompt = async (_ref, _text, options) => {
      capturedSignal = options && options.signal;
      return new Promise((resolve) => { resolvePrompt = resolve; });
    };
    mocks.driver.stop = async () => {};
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'thread', progressStyle: 'card' });

    const pending = dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_cancel_sig_msg1', openId: 'ou_user1', text: '慢任务',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
      routeKey: 'feishu:oc_chat1:root:om_root1',
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(capturedSignal, 'signal 应已传给 driver');
    assert.equal(capturedSignal.aborted, false, 'cancel 前未 abort');

    await dispatcher.handleCommand({
      type: 'command', name: 'cancel', args: [],
      routeKey: 'feishu:oc_chat1:root:om_root1', messageId: 'om_cancel_sig_cmd1', chatId: 'oc_chat1',
    });

    assert.equal(capturedSignal.aborted, true, 'cancel 后 signal 应已 abort');
    resolvePrompt([new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' })]);
    assert.equal(await pending, 'cancelled');
  });

  it('deadline 超时 abort signal 并使用 deadline reason', async () => {
    const mocks = makeMocks();
    const session = { id: 'wks_deadline1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_deadline1' } };
    let resolvePrompt;
    let capturedSignal = null;
    mocks.sessionService.getCurrent = () => session;
    mocks.sessionService.getSession = () => session;
    mocks.sessionService.markRunning = () => { session.status = 'running'; };
    mocks.sessionService.markIdle = () => { session.status = 'idle'; };
    mocks.driver.prompt = async (_ref, _text, options) => {
      capturedSignal = options && options.signal;
      return new Promise((resolve) => { resolvePrompt = resolve; });
    };
    mocks.driver.stop = async () => {};
    const dispatcher = new MessageDispatcher({
      ...mocks, routeMode: 'thread', progressStyle: 'card',
      promptHeartbeatInitialMs: 10, promptHeartbeatIntervalMs: 10,
      maxTurnTimeMins: 0.00025,
    });

    const pending = dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_deadline1', openId: 'ou_user1', text: '慢任务',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
      routeKey: 'feishu:oc_chat1:root:om_root1',
    });
    await new Promise((resolve) => setTimeout(resolve, 30));

    assert.ok(capturedSignal, 'signal 应已传给 driver');
    assert.equal(capturedSignal.aborted, true, 'deadline 后 signal 应已 abort');
    assert.ok(mocks.feishuApi.calls.some(c => c.type === 'replyText' && c.text === 'Current turn timed out after 0.00025 minutes and was cancelled.'));

    resolvePrompt([new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'late answer' }), new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' })]);
    assert.equal(await pending, 'cancelled');
  });

  it('transport recovering 错误不标记 session error 也不发送错误卡片', async () => {
    const mocks = makeMocks();
    const session = { id: 'wks_recover1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_recover1' } };
    let markedError = false;
    mocks.sessionService.getCurrent = () => session;
    mocks.sessionService.getSession = () => session;
    mocks.sessionService.markRunning = () => { session.status = 'running'; };
    mocks.sessionService.markIdle = () => { session.status = 'idle'; };
    mocks.sessionService.markError = () => { markedError = true; };
    const transportErr = new Error('SSE connection timed out after 300000ms');
    transportErr.code = 'SSE_IDLE_TIMEOUT';
    mocks.driver.prompt = async () => { throw transportErr; };
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'thread' });

    const result = await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_recover1', openId: 'ou_user1', text: 'hello',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
      routeKey: 'feishu:oc_chat1:root:om_root1',
    });

    assert.equal(result, 'recovering', 'transport 可恢复错误应返回 recovering');
    assert.equal(markedError, false, '不应标记 session error');
    assert.equal(mocks.feishuApi.calls.some(c => c.type === 'sendErrorCard'), false, '不应发送错误卡片');
    assert.equal(session.status, 'idle', 'session 应回 idle');
  });

  it('SSE_OPEN_TIMEOUT 也视为 transport recovering', async () => {
    const mocks = makeMocks();
    const session = { id: 'wks_open_timeout1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_open_timeout1' } };
    mocks.sessionService.getCurrent = () => session;
    mocks.sessionService.getSession = () => session;
    mocks.sessionService.markRunning = () => { session.status = 'running'; };
    mocks.sessionService.markIdle = () => { session.status = 'idle'; };
    const transportErr = new Error('SSE connection open timeout after 1000ms');
    transportErr.code = 'SSE_OPEN_TIMEOUT';
    mocks.driver.prompt = async () => { throw transportErr; };
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'thread' });

    const result = await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_open_timeout1', openId: 'ou_user1', text: 'hello',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
      routeKey: 'feishu:oc_chat1:root:om_root1',
    });

    assert.equal(result, 'recovering');
    assert.equal(mocks.feishuApi.calls.some(c => c.type === 'sendErrorCard'), false);
  });

  it('TUI_RUNTIME_DISCONNECTED 视为 transport recovering', async () => {
    const mocks = makeMocks();
    const session = { id: 'wks_tui_disc1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_tui_disc1' } };
    mocks.sessionService.getCurrent = () => session;
    mocks.sessionService.getSession = () => session;
    mocks.sessionService.markRunning = () => { session.status = 'running'; };
    mocks.sessionService.markIdle = () => { session.status = 'idle'; };
    const transportErr = new Error('OpenCode TUI bridge lease lost');
    transportErr.code = 'TUI_RUNTIME_DISCONNECTED';
    mocks.driver.prompt = async () => { throw transportErr; };
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'thread' });

    const result = await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_tui_disc1', openId: 'ou_user1', text: 'hello',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
      routeKey: 'feishu:oc_chat1:root:om_root1',
    });

    assert.equal(result, 'recovering');
    assert.equal(mocks.feishuApi.calls.some(c => c.type === 'sendErrorCard'), false);
  });

  it('真正业务错误仍标记 error 并发送错误卡片', async () => {
    const mocks = makeMocks();
    const session = { id: 'wks_bizerr1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_bizerr1' } };
    let markedError = false;
    let markedErrorMsg = '';
    mocks.sessionService.getCurrent = () => session;
    mocks.sessionService.getSession = () => session;
    mocks.sessionService.markRunning = () => { session.status = 'running'; };
    mocks.sessionService.markIdle = () => { session.status = 'idle'; };
    mocks.sessionService.markError = (id, msg) => { markedError = true; markedErrorMsg = msg; };
    mocks.driver.prompt = async () => { throw new Error('opencode server unreachable'); };
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'thread' });

    const result = await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_bizerr1', openId: 'ou_user1', text: 'hello',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
      routeKey: 'feishu:oc_chat1:root:om_root1',
    });

    assert.equal(result, 'error', '真正业务错误应返回 error');
    assert.equal(markedError, true, '应标记 session error');
    assert.equal(markedErrorMsg, 'opencode server unreachable');
    assert.ok(mocks.feishuApi.calls.some(c => c.type === 'sendErrorCard' && c.message === 'opencode server unreachable'));
  });

  it('maxTurnTimeMins 为零时不创建 deadline timer', async () => {
    const mocks = makeMocks();
    const session = { id: 'wks_no_deadline1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_no_deadline1' } };
    mocks.sessionService.getCurrent = () => session;
    mocks.sessionService.getSession = () => session;
    mocks.sessionService.markRunning = () => { session.status = 'running'; };
    mocks.sessionService.markIdle = () => { session.status = 'idle'; };
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'thread', maxTurnTimeMins: 0 });

    await dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_no_deadline1', openId: 'ou_user1', text: 'hello',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
      routeKey: 'feishu:oc_chat1:root:om_root1',
    });

    const turnState = dispatcher.turnStates.get('wks_no_deadline1');
    assert.equal(turnState, undefined, 'prompt 完成后 turnState 应已清理');
  });

  it('取消后 watcher 迟到 final 不再渲染到飞书', async () => {
    const mocks = makeMocks();
    const session = { id: 'wks_cancel_late1', agent: 'opencode', status: 'running', agentRef: { opencodeSessionId: 'ses_cancel_late1' } };
    let resolvePrompt;
    let watched;
    mocks.sessionService.getCurrent = () => session;
    mocks.sessionService.getSession = () => session;
    mocks.sessionService.markRunning = () => { session.status = 'running'; };
    mocks.sessionService.markIdle = () => { session.status = 'idle'; };
    mocks.driver.prompt = async () => new Promise((resolve) => { resolvePrompt = resolve; });
    mocks.driver.stop = async () => {};
    mocks.driver.watchSession = (_ref, handlers) => { watched = handlers; return () => {}; };
    const dispatcher = new MessageDispatcher({ ...mocks, routeMode: 'thread', progressStyle: 'card' });

    const pending = dispatcher.handleIncomingMessage({
      chatId: 'oc_chat1', messageId: 'om_cancel_late1', openId: 'ou_user1', text: '慢任务',
      messageType: 'text', createTime: Date.now(), rootId: 'om_root1',
      routeKey: 'feishu:oc_chat1:root:om_root1',
    });
    await new Promise((resolve) => setImmediate(resolve));

    await dispatcher.handleCommand({
      type: 'command', name: 'cancel', args: [],
      routeKey: 'feishu:oc_chat1:root:om_root1', messageId: 'om_cancel_late_cmd1', chatId: 'oc_chat1',
    });

    if (watched) {
      watched.onEvent(new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'late watcher text' }));
      watched.onEvent(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }));
    }
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(mocks.feishuApi.calls.some(c => c.type === 'sendMarkdown' && c.text === 'late watcher text'), false, '取消后 watcher 迟到文本不应发送到飞书');

    resolvePrompt([new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'late prompt text' }), new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' })]);
    assert.equal(await pending, 'cancelled');
    assert.equal(mocks.feishuApi.calls.some(c => c.type === 'replyText' && c.text && c.text.includes('late prompt text')), false, '取消后 prompt 迟到结果不应渲染到飞书');
  });
});

describe('MessageDispatcher permission handling', () => {
  it('TYPE_PERMISSION 事件触发权限卡片发送', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_p1', agent: 'opencode', status: 'running', agentRef: { opencodeSessionId: 'ses_p1' } });
    mocks.sessionService.getRouteForSession = () => 'feishu:oc_chat1:root:om_root1';
    mocks.feishuApi.replyCard = (replyCtx, card) => { mocks.feishuApi.calls.push({ type: 'replyCard', replyCtx, card }); return 'om_perm_card1'; };
    const dispatcher = new MessageDispatcher(mocks);
    const session = { id: 'wks_p1', agent: 'opencode', status: 'running', agentRef: { opencodeSessionId: 'ses_p1' } };
    dispatcher._handleWatchedSessionEvent(session, 'oc_chat1', new AgentEvent(AgentEvent.TYPE_PERMISSION, {
      id: 'perm_abc', type: 'bash', title: '执行 rm 命令',
    }));
    await new Promise((resolve) => setImmediate(resolve));
    const cardCall = mocks.feishuApi.calls.find((c) => c.type === 'replyCard');
    assert.ok(cardCall, '应调用 replyCard 发送权限卡片');
    assert.equal(cardCall.card.header.title.content, '权限确认请求');
    assert.equal(cardCall.card.header.template, 'red');
  });

  it('TYPE_PERMISSION_REPLIED 更新原权限卡片', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getRouteForSession = () => 'feishu:oc_chat1:root:om_root1';
    mocks.feishuApi.replyCard = () => 'om_perm_card1';
    const dispatcher = new MessageDispatcher(mocks);
    const session = { id: 'wks_p1', agent: 'opencode', status: 'running', agentRef: { opencodeSessionId: 'ses_p1' } };
    dispatcher._handleWatchedSessionEvent(session, 'oc_chat1', new AgentEvent(AgentEvent.TYPE_PERMISSION, { id: 'perm_abc', title: 'test' }));
    await new Promise((resolve) => setImmediate(resolve));
    dispatcher._handleWatchedSessionEvent(session, 'oc_chat1', new AgentEvent(AgentEvent.TYPE_PERMISSION_REPLIED, { permissionId: 'perm_abc', response: 'allow' }));
    const patchCall = mocks.feishuApi.calls.find((c) => c.type === 'patchCard');
    assert.ok(patchCall, '应调用 patchCard 更新权限卡片');
    assert.equal(patchCall.card.header.title.content, '权限已处理');
  });

  it('/permit allow 正确调用 replyPermission 并 patch 原卡片', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_p1', agent: 'opencode', status: 'running', agentRef: { opencodeSessionId: 'ses_p1' } });
    let replyCalls = [];
    mocks.driver.replyPermission = async (sessionRef, permissionId, response, remember) => {
      replyCalls.push({ sessionRef, permissionId, response, remember });
    };
    const dispatcher = new MessageDispatcher(mocks);
    dispatcher.permissionCardIds = new Map([['perm_abc', 'om_perm_card']]);
    const result = await dispatcher.handleCommand({
      type: 'command', name: 'permit', args: ['perm_abc', 'allow'],
      routeKey: 'feishu:oc_chat1:root:om_root1', messageId: 'om_cmd1', chatId: 'oc_chat1',
    });
    assert.equal(replyCalls.length, 1);
    assert.equal(replyCalls[0].permissionId, 'perm_abc');
    assert.equal(replyCalls[0].response, 'allow');
    assert.equal(result.replied, 'perm_abc');
    assert.ok(mocks.feishuApi.calls.some((c) => c.type === 'patchCard'), '成功后应 patch 原卡片');
    assert.equal(mocks.feishuApi.calls.some((c) => c.type === 'replyText'), false, '成功后不应再发文本回执');
  });

  it('/permit deny 正确调用 replyPermission', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_p1', agent: 'opencode', status: 'running', agentRef: { opencodeSessionId: 'ses_p1' } });
    let replyCalls = [];
    mocks.driver.replyPermission = async (sessionRef, permissionId, response, remember) => {
      replyCalls.push({ sessionRef, permissionId, response, remember });
    };
    const dispatcher = new MessageDispatcher(mocks);
    const result = await dispatcher.handleCommand({
      type: 'command', name: 'permit', args: ['perm_abc', 'deny'],
      routeKey: 'feishu:oc_chat1:root:om_root1', messageId: 'om_cmd1', chatId: 'oc_chat1',
    });
    assert.equal(replyCalls[0].response, 'deny');
    assert.equal(result.replied, 'perm_abc');
  });

  it('/permit always 正确调用 replyPermission 并启用 remember', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_p1', agent: 'opencode', status: 'running', agentRef: { opencodeSessionId: 'ses_p1' } });
    let replyCalls = [];
    mocks.driver.replyPermission = async (sessionRef, permissionId, response, remember) => {
      replyCalls.push({ sessionRef, permissionId, response, remember });
    };
    const dispatcher = new MessageDispatcher(mocks);
    const result = await dispatcher.handleCommand({
      type: 'command', name: 'permit', args: ['perm_abc', 'always'],
      routeKey: 'feishu:oc_chat1:root:om_root1', messageId: 'om_cmd1', chatId: 'oc_chat1',
    });
    assert.equal(replyCalls[0].response, 'always');
    assert.equal(replyCalls[0].remember, true);
    assert.equal(result.replied, 'perm_abc');
  });

  it('/permit 缺少参数返回用法提示', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_p1', agent: 'opencode', status: 'running', agentRef: {} });
    const dispatcher = new MessageDispatcher(mocks);
    const result = await dispatcher.handleCommand({
      type: 'command', name: 'permit', args: ['perm_abc'],
      routeKey: 'feishu:oc_chat1:root:om_root1', messageId: 'om_cmd1', chatId: 'oc_chat1',
    });
    assert.equal(result.error, 'missing_args');
    assert.ok(mocks.feishuApi.calls.some((c) => c.type === 'replyText' && c.text.includes('用法')));
  });

  it('/permit 非法 response 返回错误', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_p1', agent: 'opencode', status: 'running', agentRef: {} });
    const dispatcher = new MessageDispatcher(mocks);
    const result = await dispatcher.handleCommand({
      type: 'command', name: 'permit', args: ['perm_abc', 'maybe'],
      routeKey: 'feishu:oc_chat1:root:om_root1', messageId: 'om_cmd1', chatId: 'oc_chat1',
    });
    assert.equal(result.error, 'invalid_response');
  });

  it('/permit replyPermission 失败提示权限不存在', async () => {
    const mocks = makeMocks();
    mocks.sessionService.getCurrent = () => ({ id: 'wks_p1', agent: 'opencode', status: 'running', agentRef: { opencodeSessionId: 'ses_p1' } });
    mocks.driver.replyPermission = async () => { throw new Error('server 404'); };
    const dispatcher = new MessageDispatcher(mocks);
    const result = await dispatcher.handleCommand({
      type: 'command', name: 'permit', args: ['perm_abc', 'allow'],
      routeKey: 'feishu:oc_chat1:root:om_root1', messageId: 'om_cmd1', chatId: 'oc_chat1',
    });
    assert.equal(result.error, 'reply_failed');
    assert.ok(mocks.feishuApi.calls.some((c) => c.type === 'replyText' && c.text.includes('权限不存在或已过期')));
  });
});

describe('MessageDispatcher 原生 question 路由', () => {
  it('独立路由 question_asked，且 /answer 不经过通用去重', async () => {
    const mocks = makeMocks();
    const session = { id: 'wks_q1', agent: 'opencode', agentRef: { transport: 'tui-bridge', runtimeId: 'rt_1', opencodeSessionId: 'ses_q1' } };
    mocks.sessionService.getRouteForSession = () => 'feishu:oc_chat1:root:om_root1';
    mocks.sessionService.getSession = () => session;
    mocks.driver.replyQuestion = async () => {};
    const dispatcher = new MessageDispatcher(mocks);
    dispatcher._handleWatchedSessionEvent(session, 'oc_chat1', new AgentEvent(AgentEvent.TYPE_QUESTION_ASKED, {
      requestID: 'req_1', sessionID: 'ses_q1', questions: [{ header: '选择', question: '请选择', options: [{ label: 'A', description: '' }] }],
    }));
    await new Promise((resolve) => setImmediate(resolve));
    const cmd = { type: 'command', name: 'answer', args: ['req_1:0', '--form', 'wks_q1'], routeKey: 'feishu:oc_chat1:root:om_root1', messageId: 'om_card1', chatId: 'oc_chat1', formValue: { question_selected: 'option_0' } };
    await dispatcher.handleCommand(cmd);
    await dispatcher.handleCommand(cmd);
    assert.equal(mocks.feishuApi.calls.filter((call) => call.type === 'replyCard').length, 1);
    assert.equal(mocks.dedup.entries['cmd:om_card1:answer:req_1:0 --form wks_q1'], undefined);
  });

  it('独立路由 question_replied 和 question_rejected', () => {
    const mocks = makeMocks();
    const session = { id: 'wks_q2', agent: 'opencode', agentRef: { transport: 'tui-bridge', runtimeId: 'rt_2', opencodeSessionId: 'ses_q2' } };
    mocks.sessionService.getRouteForSession = () => 'feishu:oc_chat1:root:om_root1';
    const dispatcher = new MessageDispatcher(mocks);
    const calls = [];
    dispatcher.questionHandler.handleReplied = (_session, _chatId, event) => { calls.push(event.type); };
    dispatcher.questionHandler.handleRejected = (_session, _chatId, event) => { calls.push(event.type); };
    dispatcher._handleWatchedSessionEvent(session, 'oc_chat1', new AgentEvent(AgentEvent.TYPE_QUESTION_REPLIED, { requestID: 'req_2', sessionID: 'ses_q2', answers: [['A']] }));
    dispatcher._handleWatchedSessionEvent(session, 'oc_chat1', new AgentEvent(AgentEvent.TYPE_QUESTION_REJECTED, { requestID: 'req_2', sessionID: 'ses_q2' }));
    assert.deepEqual(calls, [AgentEvent.TYPE_QUESTION_REPLIED, AgentEvent.TYPE_QUESTION_REJECTED]);
  });
});
