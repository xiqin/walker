'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const WebSocket = require('ws');

const { ClaudeAttachServer } = require('../src/drivers/claude-attach-server');

class FakeBroker extends EventEmitter {
  constructor() {
    super();
    this.runtime = { runtimeId: 'rt_1', status: 'active', agentRef: { provider: 'claude', transport: 'pty-attach', runtimeId: 'rt_1' } };
    this.inputs = [];
    this.resizes = [];
    this.stops = [];
    this.deletes = [];
    this.detaches = [];
    this.subscribers = new Set();
    this.replay = [Buffer.from('\u001b[31mred\u0000', 'binary')];
  }

  getRuntime(runtimeId) {
    return runtimeId === this.runtime.runtimeId ? this.runtime : null;
  }

  writeInput(runtimeId, data, options) {
    this.inputs.push({ runtimeId, data: Buffer.from(data), options });
    return Promise.resolve();
  }

  resize(runtimeId, cols, rows) {
    this.resizes.push({ runtimeId, cols, rows });
    return Promise.resolve();
  }

  subscribeOutput(runtimeId, fn, options) {
    assert.equal(runtimeId, 'rt_1');
    assert.deepEqual(options, { replay: true });
    for (const chunk of this.replay) fn(chunk);
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  emitOutput(chunk) {
    for (const fn of this.subscribers) fn(Buffer.from(chunk));
  }

  stopRuntime(runtimeId) { this.stops.push(runtimeId); }
  deleteRuntime(runtimeId) { this.deletes.push(runtimeId); }
  detach(runtimeId) { this.detaches.push(runtimeId); }
}

function waitForOpen(ws) {
  return new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
}

function waitForClose(ws) {
  return new Promise((resolve) => ws.once('close', resolve));
}

function waitForMessage(ws) {
  return new Promise((resolve) => ws.once('message', (data) => resolve(Buffer.from(data))));
}

async function waitForCondition(fn) {
  for (let i = 0; i < 20; i += 1) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(fn());
}

async function withServer(fn) {
  const broker = new FakeBroker();
  const logs = [];
  const server = new ClaudeAttachServer({
    broker,
    tokenFactory: () => '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    logger: {
      info(message, row) { logs.push({ level: 'info', message, row }); },
      warn(message, row) { logs.push({ level: 'warn', message, row }); },
      error(message, row) { logs.push({ level: 'error', message, row }); },
    },
  });
  await server.start();
  try {
    return await fn({ server, broker, logs });
  } finally {
    await server.stop();
  }
}

test('REQ-002-B01: attach 原样转发 ANSI/二进制 PTY 输出和键盘字节', async () => {
  await withServer(async ({ server, broker }) => {
    const attachment = server.createAttachment('rt_1');
    const ws = new WebSocket(attachment.url);
    const replay = waitForMessage(ws);
    await waitForOpen(ws);

    assert.deepEqual(await replay, Buffer.from('\u001b[31mred\u0000', 'binary'));
    const live = waitForMessage(ws);
    broker.emitOutput(Buffer.from([0, 255, 27, 91, 65]));
    assert.deepEqual(await live, Buffer.from([0, 255, 27, 91, 65]));

    ws.send(Buffer.from([3, 13, 0, 255]));
    await waitForCondition(() => broker.inputs.length === 1);
    assert.deepEqual(broker.inputs[0].data, Buffer.from([3, 13, 0, 255]));
    assert.deepEqual(broker.inputs[0].options, { source: 'attach' });
    ws.close();
  });
});

test('REQ-002-B02: resize 边界校验仅允许合法尺寸进入 broker.resize', async () => {
  await withServer(async ({ server, broker }) => {
    const attachment = server.createAttachment('rt_1');
    const ws = new WebSocket(attachment.url);
    const replay = waitForMessage(ws);
    await waitForOpen(ws);
    await replay;

    ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    await waitForCondition(() => broker.resizes.length === 1);
    assert.deepEqual(broker.resizes, [{ runtimeId: 'rt_1', cols: 120, rows: 40 }]);
    ws.send(JSON.stringify({ type: 'resize', cols: 0, rows: 40 }));
    await waitForClose(ws);
    assert.equal(broker.resizes.length, 1);
    assert.equal(broker.runtime.status, 'active');
  });
});

test('REQ-002-B03: detach 不 stop runtime，重连可收到 replay', async () => {
  await withServer(async ({ server, broker }) => {
    const attachment = server.createAttachment('rt_1');
    const ws1 = new WebSocket(attachment.url);
    const replay1 = waitForMessage(ws1);
    await waitForOpen(ws1);
    assert.deepEqual(await replay1, broker.replay[0]);
    ws1.close();
    await waitForClose(ws1);
    await waitForCondition(() => broker.detaches.length === 1);

    assert.deepEqual(broker.stops, []);
    assert.deepEqual(broker.deletes, []);
    assert.deepEqual(broker.detaches, ['rt_1']);
    assert.equal(broker.runtime.status, 'active');

    const ws2 = new WebSocket(attachment.url);
    const replay2 = waitForMessage(ws2);
    await waitForOpen(ws2);
    assert.deepEqual(await replay2, broker.replay[0]);
    ws2.close();
  });
});

test('REQ-002-B04/REQ-006-B01: 仅 loopback 且 token 正确可 attach，token 不进入日志或 agentRef', async () => {
  await withServer(async ({ server, broker, logs }) => {
    const attachment = server.createAttachment('rt_1');
    assert.ok(attachment.token.length >= 64);
    assert.equal(server.getAttachment('rt_1').token, undefined);
    assert.equal(JSON.stringify(broker.runtime.agentRef).includes(attachment.token), false);

    const badTokenUrl = attachment.url.replace(attachment.token, 'bad-token');
    const rejected = new WebSocket(badTokenUrl);
    await waitForOpen(rejected);
    await waitForClose(rejected);

    const ok = new WebSocket(attachment.url);
    const replay = waitForMessage(ok);
    await waitForOpen(ok);
    await replay;
    ok.close();

    const logText = JSON.stringify(logs);
    assert.equal(logText.includes(attachment.token), false);
  });
});

test('REQ-002-B06: 未知或畸形协议消息关闭当前连接且不影响 runtime', async () => {
  await withServer(async ({ server, broker }) => {
    const attachment = server.createAttachment('rt_1');
    const ws = new WebSocket(attachment.url);
    const replay = waitForMessage(ws);
    await waitForOpen(ws);
    await replay;
    ws.send(JSON.stringify({ type: 'unknown' }));
    await waitForClose(ws);

    assert.equal(broker.runtime.status, 'active');
    assert.deepEqual(broker.stops, []);
    assert.deepEqual(broker.deletes, []);
  });
});
