const test = require('node:test');
const assert = require('node:assert/strict');
const { MessageDispatcher } = require('../src/dispatch/message-dispatcher');
const { MessageDedup } = require('../src/core/message-dedup');
const { AgentEvent } = require('../src/drivers/agent-driver');
const { createEventStore, listEvents } = require('../src/admin/event-store');

function makeDispatcher() {
  const session = { id: 'wks_1', agent: 'opencode', status: 'idle', agentRef: { opencodeSessionId: 'ses_1' } };
  const sessionService = {
    getCurrent: (routeKey) => routeKey === 'feishu:oc_1:root:oc_1' ? session : null,
    getSession: () => session,
    markRunning: (id) => { session.status = 'running'; session.runningId = id; },
    markIdle: (id) => { session.status = 'idle'; session.idleId = id; },
    markError: () => {},
    touchRouteCalls: [],
    touchRoute: (routeKey) => sessionService.touchRouteCalls.push(routeKey),
    listSessions: () => [session],
    updateSessionField: () => {},
  };
  const driver = {
    promptCalls: [],
    prompt: async (agentRef, text) => {
      driver.promptCalls.push({ agentRef, text });
      return [new AgentEvent(AgentEvent.TYPE_TEXT, { text: 'ok' }), new AgentEvent(AgentEvent.TYPE_DONE, {})];
    },
    watchSession: () => () => {},
  };
  const feishuApi = {
    calls: [],
    sendProgressCard: (ctx, sessionId) => { feishuApi.calls.push({ type: 'sendProgressCard', ctx, sessionId }); return 'om_card'; },
    updateProgressCard: (cardId, sessionId, event) => { feishuApi.calls.push({ type: 'updateProgressCard', cardId, sessionId, event }); },
    sendErrorCard: (ctx, message) => { feishuApi.calls.push({ type: 'sendErrorCard', ctx, message }); },
    addReaction: () => {},
  };
  const eventStore = createEventStore({ maxEvents: 100 });
  const dispatcher = new MessageDispatcher({
    sessionService,
    driverRegistry: { get: () => driver },
    feishuApi,
    dedup: new MessageDedup({ windowMs: 300000 }),
    eventStore,
    progressStyle: 'card',
  });
  return { dispatcher, sessionService, driver, feishuApi, eventStore };
}

function platformEvent(overrides) {
  return Object.assign({
    platform: 'feishu',
    type: 'message',
    messageId: 'om_1',
    routeKey: 'feishu:oc_1:root:oc_1',
    userId: 'ou_1',
    text: 'hello',
    attachments: [],
    raw: { message: { chat_id: 'oc_1' } },
    chatId: 'oc_1',
  }, overrides || {});
}

test('handlePlatformMessage 接受标准事件并复用 prompt 状态机', async () => {
  const mocks = makeDispatcher();
  const result = await mocks.dispatcher.handlePlatformMessage(platformEvent());
  assert.equal(result, 'prompted');
  assert.deepEqual(mocks.driver.promptCalls, [{ agentRef: { opencodeSessionId: 'ses_1' }, text: 'hello' }]);
  assert.deepEqual(mocks.sessionService.touchRouteCalls, ['feishu:oc_1:root:oc_1']);
  assert.equal(mocks.sessionService.getSession().status, 'idle');
  assert.equal(listEvents(mocks.eventStore, { type: 'platform.message_received' }).length, 1);
});

test('handlePlatformMessage 拒绝无效事件且不调用 agent driver', async () => {
  const mocks = makeDispatcher();
  const result = await mocks.dispatcher.handlePlatformMessage({ platform: 'feishu', type: 'message', messageId: 'om_bad' });
  assert.equal(result.error, 'BAD_REQUEST');
  assert.equal(mocks.driver.promptCalls.length, 0);
});

test('handlePlatformMessage 复用 messageId dedup', async () => {
  const mocks = makeDispatcher();
  const first = await mocks.dispatcher.handlePlatformMessage(platformEvent({ messageId: 'om_dup' }));
  const second = await mocks.dispatcher.handlePlatformMessage(platformEvent({ messageId: 'om_dup' }));
  assert.equal(first, 'prompted');
  assert.equal(second, 'duplicate');
  assert.equal(mocks.driver.promptCalls.length, 1);
});

test('handlePlatformMessage 捕获 dispatcher 异常并返回结构化错误', async () => {
  const mocks = makeDispatcher();
  mocks.sessionService.getCurrent = () => { throw new Error('state broken'); };
  const result = await mocks.dispatcher.handlePlatformMessage(platformEvent({ messageId: 'om_error' }));
  assert.equal(result.error, 'adapter_error');
  assert.match(result.message, /state broken/);
  assert.equal(mocks.driver.promptCalls.length, 0);
});
