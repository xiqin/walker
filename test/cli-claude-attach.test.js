'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { runClaudeAttachCommand, sendResize } = require('../src/cli/claude-attach-command');
const indexCli = require('../src/index');

class FakeWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    this.closed = false;
    FakeWebSocket.instances.push(this);
    process.nextTick(() => this.emit('open'));
  }

  send(data) { this.sent.push(Buffer.isBuffer(data) ? Buffer.from(data) : String(data)); }
  close() { this.closed = true; this.emit('close', 1000); }
}
FakeWebSocket.instances = [];

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

test('REQ-006-B04: claude attach 缺 runtimeId 返回非零', async () => {
  const stderr = stream();
  const code = await runClaudeAttachCommand([], { stderr });
  assert.equal(code, 1);
  assert.match(Buffer.concat(stderr.writes).toString(), /runtime/i);
});

test('REQ-006-B04: resolve 失败返回非零且不连接', async () => {
  FakeWebSocket.instances = [];
  const stderr = stream();
  const code = await runClaudeAttachCommand(['rt_missing'], {
    stderr,
    WebSocket: FakeWebSocket,
    resolveAttachment: async () => null,
  });
  assert.equal(code, 1);
  assert.equal(FakeWebSocket.instances.length, 0);
  assert.match(Buffer.concat(stderr.writes).toString(), /attach/i);
});

test('REQ-002-B01/REQ-006-B04: CLI 原样转发 stdin/stdout，关闭时恢复 raw mode', async () => {
  FakeWebSocket.instances = [];
  const stdin = stream();
  const stdout = stream();
  const done = runClaudeAttachCommand(['rt_1'], {
    stdin,
    stdout,
    stderr: stream(),
    WebSocket: FakeWebSocket,
    resolveAttachment: async () => ({ url: 'ws://127.0.0.1:1234/attach/rt_1?token=secret-token' }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  const ws = FakeWebSocket.instances[0];
  stdin.emit('data', Buffer.from([0, 27, 255]));
  ws.emit('message', Buffer.from([1, 2, 3]));
  ws.close();
  const code = await done;

  assert.equal(code, 0);
  assert.ok(ws.sent.some((chunk) => Buffer.isBuffer(chunk) && chunk.equals(Buffer.from([0, 27, 255]))));
  assert.deepEqual(stdout.writes[0], Buffer.from([1, 2, 3]));
  assert.deepEqual(stdin.setRawModeCalls, [true, false]);
});

test('REQ-002-B02: sendResize 发送合法 resize 控制帧并拒绝非法尺寸', () => {
  const sent = [];
  const ws = { send(data) { sent.push(JSON.parse(data)); } };
  assert.equal(sendResize(ws, 80, 24), true);
  assert.equal(sendResize(ws, 0, 24), false);
  assert.deepEqual(sent, [{ type: 'resize', cols: 80, rows: 24 }]);
});

test('REQ-006-B04: 连接错误或协议错误返回非零', async () => {
  class ErrorWebSocket extends EventEmitter {
    constructor() {
      super();
      process.nextTick(() => this.emit('error', new Error('auth failed')));
    }
    send() {}
    close() {}
  }
  const code = await runClaudeAttachCommand(['rt_1'], {
    stdin: stream(),
    stdout: stream(),
    stderr: stream(),
    WebSocket: ErrorWebSocket,
    resolveAttachment: async () => ({ url: 'ws://127.0.0.1:1234/attach/rt_1?token=bad' }),
  });
  assert.equal(code, 1);
});

test('src/index 注册 claude attach 子命令，未知 claude 子命令非零', async () => {
  const exits = [];
  const code = await indexCli.main(['claude', 'nope'], { exit: (value) => exits.push(value), output: { write() {}, error() {} } });
  assert.equal(code, undefined);
  assert.deepEqual(exits, [1]);
});
