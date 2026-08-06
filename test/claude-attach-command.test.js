'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { runClaudeAttachCommand } = require('../src/cli/claude-attach-command');

class ManualWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    this.closed = false;
    this.readyState = ManualWebSocket.CONNECTING;
    ManualWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data)));
  }

  close(code = 1000, reason = '') {
    this.closed = true;
    this.readyState = ManualWebSocket.CLOSED;
    this.emit('close', code, Buffer.from(String(reason)));
  }
}
ManualWebSocket.CONNECTING = 0;
ManualWebSocket.OPEN = 1;
ManualWebSocket.CLOSED = 3;
ManualWebSocket.instances = [];

function stream() {
  const s = new EventEmitter();
  s.writes = [];
  s.isTTY = true;
  s.columns = 100;
  s.rows = 30;
  s.write = (chunk) => { s.writes.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk))); };
  s.setRawModeCalls = [];
  s.setRawMode = (value) => s.setRawModeCalls.push(value);
  s.resume = () => { s.resumed = true; };
  s.pause = () => { s.paused = true; };
  return s;
}

function text(s) {
  return Buffer.concat(s.writes).toString();
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('REQ-004-B01/REQ-004-B03: 非正常 close 后重新 resolve/connect，窗口内恢复后继续转发输出', async () => {
  ManualWebSocket.instances = [];
  const stdout = stream();
  const resolves = [];
  const command = runClaudeAttachCommand(['rt_1'], {
    stdin: stream(),
    stdout,
    stderr: stream(),
    WebSocket: ManualWebSocket,
    reconnectWindowMs: 100,
    retryDelayMs: 0,
    resolveAttachment: async (runtimeId) => {
      resolves.push(runtimeId);
      return { url: 'ws://127.0.0.1:1234/attach/' + runtimeId + '?token=secret-' + resolves.length };
    },
  });

  await tick();
  ManualWebSocket.instances[0].emit('open');
  ManualWebSocket.instances[0].close(1006, 'network lost');
  await sleep(5);
  assert.equal(ManualWebSocket.instances.length, 2);
  assert.deepEqual(resolves, ['rt_1', 'rt_1']);

  ManualWebSocket.instances[1].emit('open');
  ManualWebSocket.instances[1].emit('message', Buffer.from('after reconnect'));
  ManualWebSocket.instances[1].close(1000);
  const code = await command;

  assert.equal(code, 0);
  assert.match(Buffer.concat(stdout.writes).toString(), /after reconnect/);
});

test('REQ-004-B01: error 后 close 只调度一次重连', async () => {
  ManualWebSocket.instances = [];
  let timerCount = 0;
  const timers = [];
  const command = runClaudeAttachCommand(['rt_1'], {
    stdin: stream(),
    stdout: stream(),
    stderr: stream(),
    WebSocket: ManualWebSocket,
    reconnectWindowMs: 100,
    retryDelayMs: 10,
    setTimeout: (fn, ms) => {
      timerCount += 1;
      timers.push({ fn, ms });
      return { fn, ms };
    },
    clearTimeout: () => {},
    resolveAttachment: async (runtimeId) => ({ url: 'ws://127.0.0.1:1234/attach/' + runtimeId + '?token=secret-token' }),
  });

  await tick();
  ManualWebSocket.instances[0].emit('open');
  ManualWebSocket.instances[0].emit('error', new Error('socket failed'));
  ManualWebSocket.instances[0].close(1006, 'socket closed');

  assert.equal(timerCount, 1);
  timers[0].fn();
  await tick();
  assert.equal(ManualWebSocket.instances.length, 2);
  ManualWebSocket.instances[1].emit('open');
  ManualWebSocket.instances[1].close(1000);
  assert.equal(await command, 0);
});

test('REQ-004-B01: 重连窗口内 stdin 和 resize 不写入已关闭 WebSocket', async () => {
  ManualWebSocket.instances = [];
  const stdin = stream();
  const stdout = stream();
  const timers = [];
  const command = runClaudeAttachCommand(['rt_1'], {
    stdin,
    stdout,
    stderr: stream(),
    WebSocket: ManualWebSocket,
    reconnectWindowMs: 100,
    retryDelayMs: 10,
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return { fn, ms };
    },
    clearTimeout: () => {},
    resolveAttachment: async (runtimeId) => ({ url: 'ws://127.0.0.1:1234/attach/' + runtimeId + '?token=secret-token' }),
  });

  await tick();
  ManualWebSocket.instances[0].readyState = ManualWebSocket.OPEN;
  ManualWebSocket.instances[0].emit('open');
  ManualWebSocket.instances[0].close(1006, 'network lost');
  stdin.emit('data', Buffer.from('typed while disconnected'));
  stdout.emit('resize');

  assert.equal(ManualWebSocket.instances[0].sent.length, 1);
  timers[0].fn();
  await tick();
  ManualWebSocket.instances[1].readyState = ManualWebSocket.OPEN;
  ManualWebSocket.instances[1].emit('open');
  stdin.emit('data', Buffer.from('typed after reconnect'));
  ManualWebSocket.instances[1].close(1000);

  assert.deepEqual(ManualWebSocket.instances[1].sent.map((item) => item.toString()), [
    JSON.stringify({ type: 'resize', cols: 100, rows: 30 }),
    'typed after reconnect',
  ]);
  assert.equal(await command, 0);
});

test('REQ-004-B02/REQ-004-B04: 持续失败超过恢复窗口后非零退出并恢复 raw mode', async () => {
  ManualWebSocket.instances = [];
  const stdin = stream();
  const stderr = stream();
  let resolveCount = 0;
  const command = runClaudeAttachCommand(['rt_1'], {
    stdin,
    stdout: stream(),
    stderr,
    WebSocket: ManualWebSocket,
    reconnectWindowMs: 1,
    retryDelayMs: 5,
    resolveAttachment: async () => {
      resolveCount += 1;
      return resolveCount === 1 ? { url: 'ws://127.0.0.1:1234/attach/rt_1?token=secret-token' } : null;
    },
  });

  await tick();
  ManualWebSocket.instances[0].emit('open');
  ManualWebSocket.instances[0].close(1006, 'server vanished');
  const code = await command;

  assert.equal(code, 1);
  assert.deepEqual(stdin.setRawModeCalls, [true, false]);
  assert.equal(stdin.paused, true);
  assert.match(text(stderr), /reconnect window exceeded/i);
});

test('REQ-006-B02/REQ-006-B04: unauthorized 或 invalid token 被拒绝且错误输出脱敏', async () => {
  class RejectingWebSocket extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      process.nextTick(() => this.emit('close', 1008, Buffer.from('unauthorized: invalid token secret-token')));
    }
    send() {}
    close() {}
  }
  const stderr = stream();
  const code = await runClaudeAttachCommand(['rt_1'], {
    stdin: stream(),
    stdout: stream(),
    stderr,
    WebSocket: RejectingWebSocket,
    reconnectWindowMs: 0,
    resolveAttachment: async () => ({ url: 'ws://127.0.0.1:1234/attach/rt_1?token=secret-token' }),
  });

  assert.equal(code, 1);
  assert.match(text(stderr), /unauthorized|invalid token/i);
  assert.doesNotMatch(text(stderr), /secret-token/);
  assert.doesNotMatch(text(stderr), /token=secret-token/);
});

test('REQ-006-B02: env attach URL 缺失 token 时拒绝连接', async () => {
  ManualWebSocket.instances = [];
  const stderr = stream();
  const code = await runClaudeAttachCommand(['rt_1'], {
    stdin: stream(),
    stdout: stream(),
    stderr,
    WebSocket: ManualWebSocket,
    env: { WALKER_CLAUDE_ATTACH_URL: 'ws://127.0.0.1:1234/attach/rt_1' },
  });

  assert.equal(code, 1);
  assert.equal(ManualWebSocket.instances.length, 0);
  assert.match(text(stderr), /failed to resolve Claude attach endpoint/i);
});
