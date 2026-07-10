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
    config: { appId: 'cli_a', appSecret: 'sec', routeMode: 'thread' },
    sessionService: {},
    onMessage: overrides && overrides.onMessage || (() => Promise.resolve()),
    onCardAction: overrides && overrides.onCardAction || (() => Promise.resolve()),
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

test('FeishuPlatform start 传播 WSClient.start 失败', async () => {
  const fake = { startResult: Promise.reject(new Error('ws failed')) };
  const { FeishuPlatform } = loadPlatformWithFakeLark(fake);
  const platform = createPlatform(FeishuPlatform);

  await assert.rejects(platform.start(), /ws failed/);
});
