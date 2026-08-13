const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function loadPlatformWithFakeLark(fake) {
  const platformPath = require.resolve('../src/platform/feishu/platform');
  delete require.cache[platformPath];

  class EventDispatcher {
    register(handlers) {
      this.handlers = handlers;
      fake.handlers = handlers;
      return this;
    }
  }

  class WSClient {
    constructor(options) {
      fake.wsOptions = options;
    }

    start(options) {
      fake.startOptions = options;
      return fake.startResult;
    }

    close() {}
  }

  const originalLoad = Module._load;
  Module._load = function mockedLoad(request, parent, isMain) {
    if (request === '@larksuiteoapi/node-sdk') {
      return { EventDispatcher, WSClient };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    return require('../src/platform/feishu/platform');
  } finally {
    Module._load = originalLoad;
  }
}

function createPlatform(FeishuPlatform, overrides) {
  return new FeishuPlatform({
    config: { feishuAppId: 'cli_a', feishuAppSecret: 'sec', feishuRouteMode: 'thread' },
    sessionService: {},
    onMessage: overrides && overrides.onMessage || (() => Promise.resolve()),
    onCardAction: overrides && overrides.onCardAction || (() => Promise.resolve()),
    onEvent: overrides && overrides.onEvent,
  });
}

test('FeishuPlatform 消息事件快速 ACK，不等待 onMessage 完成', async () => {
  const fake = { startResult: Promise.resolve('started') };
  const { FeishuPlatform } = loadPlatformWithFakeLark(fake);
  const deferred = createDeferred();
  const platform = createPlatform(FeishuPlatform, { onMessage: () => deferred.promise });

  await platform.start();
  const ack = fake.handlers['im.message.receive_v1']({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
    },
  });

  const result = await Promise.race([
    Promise.resolve(ack).then(() => 'ack'),
    delay(20).then(() => 'timeout'),
  ]);
  deferred.resolve();
  assert.equal(result, 'ack');
});

test('FeishuPlatform 后台消息错误被捕获', async () => {
  const fake = { startResult: Promise.resolve('started') };
  const { FeishuPlatform } = loadPlatformWithFakeLark(fake);
  const platform = createPlatform(FeishuPlatform, { onMessage: () => Promise.reject(new Error('agent failed')) });

  let unhandled = null;
  const onUnhandled = (err) => { unhandled = err; };
  process.once('unhandledRejection', onUnhandled);
  await platform.start();
  fake.handlers['im.message.receive_v1']({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
    },
  });
  await delay(20);
  process.removeListener('unhandledRejection', onUnhandled);
  assert.equal(unhandled, null);
});

test('REQ-005-B04: FeishuPlatform adapter 转换失败产生可观测事件', async () => {
  const fake = { startResult: Promise.resolve('started') };
  const { FeishuPlatform } = loadPlatformWithFakeLark(fake);
  const observed = [];
  const messages = [];
  const platform = createPlatform(FeishuPlatform, {
    onEvent: (event) => observed.push(event),
    onMessage: (message) => { messages.push(message); return Promise.resolve(); },
  });

  await platform._handleMessageEvent({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: { message_id: '', chat_id: 'oc_1', message_type: 'text', content: JSON.stringify({ text: 'hello' }) },
  }, 'thread');

  assert.equal(messages.length, 0);
  assert.equal(observed.some((event) => event.type === 'platform.adapter_error'), true);
});

test('REQ-005-B05: FeishuPlatform 空文本和 sender fallback 不静默丢弃', async () => {
  const fake = { startResult: Promise.resolve('started') };
  const { FeishuPlatform } = loadPlatformWithFakeLark(fake);
  const messages = [];
  const platform = createPlatform(FeishuPlatform, {
    onMessage: (message) => { messages.push(message); return Promise.resolve(); },
  });

  await platform._handleMessageEvent({
    sender: { sender_id: { user_id: 'uid_1' } },
    message: { message_id: 'om_1', chat_id: 'oc_1', message_type: 'text', content: JSON.stringify({ text: '' }) },
  }, 'thread');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'text');
  assert.equal(messages[0].platformEvent.userId, 'uid_1');
  assert.equal(messages[0].platformEvent.text, '');
});

test('REQ-004-B01: text message includes top-level parentId', async () => {
  const fake = { startResult: Promise.resolve('started') };
  const { FeishuPlatform } = loadPlatformWithFakeLark(fake);
  const messages = [];
  const platform = createPlatform(FeishuPlatform, {
    onMessage: (message) => { messages.push(message); return Promise.resolve(); },
  });

  await platform._handleMessageEvent({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      root_id: 'om_root',
      parent_id: 'om_parent',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello' }),
    },
  }, 'thread');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'text');
  assert.equal(messages[0].parentId, 'om_parent');
});

test('REQ-004-B01: SDK event 包装结构中的 parentId 会转发到 dispatcher', async () => {
  const fake = { startResult: Promise.resolve('started') };
  const { FeishuPlatform } = loadPlatformWithFakeLark(fake);
  const messages = [];
  const platform = createPlatform(FeishuPlatform, {
    onMessage: (message) => { messages.push(message); return Promise.resolve(); },
  });

  await platform._handleMessageEvent({
    event: {
      sender: { sender_id: { open_id: 'ou_1' } },
      message: {
        message_id: 'om_wrapped',
        chat_id: 'oc_1',
        root_id: 'om_root_wrapped',
        parent_id: 'om_parent_wrapped',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello wrapped' }),
      },
    },
  }, 'thread');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'text');
  assert.equal(messages[0].messageId, 'om_wrapped');
  assert.equal(messages[0].rootId, 'om_root_wrapped');
  assert.equal(messages[0].parentId, 'om_parent_wrapped');
  assert.equal(messages[0].platformEvent.parentId, 'om_parent_wrapped');
});

test('REQ-004-B02: command message includes top-level parentId', async () => {
  const fake = { startResult: Promise.resolve('started') };
  const { FeishuPlatform } = loadPlatformWithFakeLark(fake);
  const messages = [];
  const platform = createPlatform(FeishuPlatform, {
    onMessage: (message) => { messages.push(message); return Promise.resolve(); },
  });

  await platform._handleMessageEvent({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: {
      message_id: 'om_cmd',
      chat_id: 'oc_1',
      parent_id: 'om_parent_cmd',
      message_type: 'text',
      content: JSON.stringify({ text: '/status' }),
    },
  }, 'thread');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'command');
  assert.equal(messages[0].command.name, 'status');
  assert.equal(messages[0].parentId, 'om_parent_cmd');
});

test('REQ-004-B03: message without parent_id still dispatches', async () => {
  const fake = { startResult: Promise.resolve('started') };
  const { FeishuPlatform } = loadPlatformWithFakeLark(fake);
  const messages = [];
  const platform = createPlatform(FeishuPlatform, {
    onMessage: (message) => { messages.push(message); return Promise.resolve(); },
  });

  await platform._handleMessageEvent({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: {
      message_id: 'om_no_parent',
      chat_id: 'oc_1',
      message_type: 'text',
      content: JSON.stringify({ text: 'hello without parent' }),
    },
  }, 'thread');

  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, 'text');
});

test('FeishuPlatform 单条文本消息只产生一次 platform.message_received', async () => {
  const fake = { startResult: Promise.resolve('started') };
  const { FeishuPlatform } = loadPlatformWithFakeLark(fake);
  const observed = [];
  const platform = createPlatform(FeishuPlatform, {
    onEvent: (event) => observed.push(event),
    onMessage: (message) => {
      observed.push({
        type: 'platform.message_received',
        platform: 'feishu',
        data: { messageId: message.platformEvent.messageId, routeKey: message.platformEvent.routeKey },
      });
      return Promise.resolve();
    },
  });

  await platform._handleMessageEvent({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: { message_id: 'om_once', chat_id: 'oc_1', root_id: 'om_root', message_type: 'text', content: JSON.stringify({ text: 'hello' }) },
  }, 'thread');

  const receivedEvents = observed.filter((event) => event.type === 'platform.message_received');
  assert.equal(receivedEvents.length, 1);
  assert.equal(receivedEvents[0].data.messageId, 'om_once');
});

test('FeishuPlatform 卡片事件快速 ACK，不等待 onCardAction 完成', async () => {
  const fake = { startResult: Promise.resolve('started') };
  const { FeishuPlatform } = loadPlatformWithFakeLark(fake);
  const deferred = createDeferred();
  const platform = createPlatform(FeishuPlatform, { onCardAction: () => deferred.promise });

  await platform.start();
  const ack = fake.handlers['card.action.trigger']({
    action: { value: { action: 'cmd:/answer req_1:0 --form wks_1' } },
    context: { open_id: 'ou_1', chat_id: 'oc_1', message_id: 'om_1' },
  });

  const result = await Promise.race([
    Promise.resolve(ack).then(() => 'ack'),
    delay(20).then(() => 'timeout'),
  ]);
  deferred.resolve();
  assert.equal(result, 'ack');
});

test('FeishuPlatform 后台卡片错误被捕获', async () => {
  const fake = { startResult: Promise.resolve('started') };
  const { FeishuPlatform } = loadPlatformWithFakeLark(fake);
  const platform = createPlatform(FeishuPlatform, { onCardAction: () => Promise.reject(new Error('card failed')) });

  let unhandled = null;
  const onUnhandled = (err) => { unhandled = err; };
  process.once('unhandledRejection', onUnhandled);
  await platform.start();
  fake.handlers['card.action.trigger']({
    action: { value: { action: 'cmd:/answer req_1:0 --form wks_1' } },
    context: { open_id: 'ou_1', chat_id: 'oc_1', message_id: 'om_1' },
  });
  await delay(20);
  process.removeListener('unhandledRejection', onUnhandled);
  assert.equal(unhandled, null);
});

test('FeishuPlatform 非文本回复失败被后台捕获', async () => {
  const fake = { startResult: Promise.resolve('started') };
  const { FeishuPlatform } = loadPlatformWithFakeLark(fake);
  const platform = createPlatform(FeishuPlatform);
  platform.api.replyText = () => Promise.reject(new Error('reply failed'));

  let unhandled = null;
  const onUnhandled = (err) => { unhandled = err; };
  process.once('unhandledRejection', onUnhandled);
  await platform.start();
  fake.handlers['im.message.receive_v1']({
    sender: { sender_id: { open_id: 'ou_1' } },
    message: {
      message_id: 'om_1',
      chat_id: 'oc_1',
      message_type: 'image',
      content: '{}',
    },
  });
  await delay(20);
  process.removeListener('unhandledRejection', onUnhandled);
  assert.equal(unhandled, null);
});

test('FeishuPlatform start 等待 WSClient.start 的异步结果', async () => {
  let started = false;
  const fake = {
    startResult: delay(20).then(() => {
      started = true;
      return 'ready';
    }),
  };
  const { FeishuPlatform } = loadPlatformWithFakeLark(fake);
  const platform = createPlatform(FeishuPlatform);

  const startPromise = platform.start();
  const early = await Promise.race([
    Promise.resolve(startPromise).then(() => 'resolved'),
    delay(5).then(() => 'pending'),
  ]);
  assert.equal(early, 'pending');
  assert.equal(await startPromise, 'ready');
  assert.equal(started, true);
});

test('FeishuPlatform _handleCardAction 传递 formValue 到 onCardAction', async () => {
  const fake = { startResult: Promise.resolve('started') };
  const { FeishuPlatform } = loadPlatformWithFakeLark(fake);
  const received = [];
  const platform = createPlatform(FeishuPlatform, {
    onCardAction: (action) => { received.push(action); return Promise.resolve(); },
  });

  await platform.start();
  fake.handlers['card.action.trigger']({
    action: {
      value: { action: 'cmd:/answer', routeKey: 'feishu:oc_1:root:om_1' },
      form_value: { question_answer: '42' },
    },
    context: { open_id: 'ou_1', chat_id: 'oc_1', message_id: 'om_1' },
  });

  assert.equal(received.length, 1);
  assert.deepEqual(received[0].formValue, { question_answer: '42' });
});

test('FeishuPlatform _handleCardAction 支持飞书 v2 open_* 和 operator 字段', async () => {
  const fake = { startResult: Promise.resolve('started') };
  const { FeishuPlatform } = loadPlatformWithFakeLark(fake);
  const received = [];
  const platform = createPlatform(FeishuPlatform, {
    onCardAction: (action) => { received.push(action); return Promise.resolve(); },
  });

  await platform.start();
  fake.handlers['card.action.trigger']({
    action: {
      value: { action: 'cmd:/answer req_1:0 --form wks_1', routeKey: 'feishu:oc_1:root:om_1' },
      form_value: { question_selected: 'option_0' },
    },
    context: { open_chat_id: 'oc_1', open_message_id: 'om_1' },
    operator: { open_id: 'ou_1' },
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].chatId, 'oc_1');
  assert.equal(received[0].messageId, 'om_1');
  assert.equal(received[0].openId, 'ou_1');
  assert.equal(received[0].routeKey, 'feishu:oc_1:root:om_1');
  assert.deepEqual(received[0].formValue, { question_selected: 'option_0' });
});

test('FeishuPlatform start 传播 WSClient.start 失败', async () => {
  const fake = { startResult: Promise.reject(new Error('ws failed')) };
  const { FeishuPlatform } = loadPlatformWithFakeLark(fake);
  const platform = createPlatform(FeishuPlatform);

  await assert.rejects(platform.start(), /ws failed/);
});

test('FeishuPlatform 注册 reaction 事件 handler 避免 SDK no handle 警告', async () => {
  const fake = { startResult: Promise.resolve('started') };
  const { FeishuPlatform } = loadPlatformWithFakeLark(fake);
  const platform = createPlatform(FeishuPlatform);

  await platform.start();

  assert.equal(typeof fake.handlers['im.message.reaction.created_v1'], 'function', '应注册 reaction.created handler');
  assert.equal(typeof fake.handlers['im.message.reaction.deleted_v1'], 'function', '应注册 reaction.deleted handler');

  // handler 应能安全处理空数据，不抛错
  fake.handlers['im.message.reaction.created_v1']({
    type: 'im.message.reaction.created_v1',
    reaction: { reaction_type: { emoji_type: 'OnIt' }, message_id: 'om_1' },
  });
  fake.handlers['im.message.reaction.deleted_v1']({
    type: 'im.message.reaction.deleted_v1',
    reaction: { reaction_type: { emoji_type: 'OnIt' }, message_id: 'om_1' },
  });
});
