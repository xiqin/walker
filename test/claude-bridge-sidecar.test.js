'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { ClaudeBridgeSidecar } = require('../src/drivers/claude-bridge-sidecar');

class FakeRuntime extends EventEmitter {
  constructor() {
    super();
    this.inputs = [];
    this.subscribers = new Set();
  }

  writeInput(text) {
    this.inputs.push(text);
    return Promise.resolve({ ok: true });
  }

  subscribeOutput(handler) {
    this.subscribers.add(handler);
    return () => this.subscribers.delete(handler);
  }
}

function createLogger(logs) {
  return {
    info(message, row) { logs.push({ level: 'info', message, row }); },
    warn(message, row) { logs.push({ level: 'warn', message, row }); },
    error(message, row) { logs.push({ level: 'error', message, row }); },
  };
}

test('REQ-001-B01/REQ-003-B04: reused old runtimeId after Walker restart', async () => {
  const runtime = new FakeRuntime();
  const sidecar = new ClaudeBridgeSidecar({ token: 'bridge-token-1234567890' });
  sidecar.registerRuntime({ runtimeId: 'old-runtime', claudeSessionId: 'claude-session-1', cwd: 'H:\\walker', runtime });
  sidecar.stopWalkerConnection('restart');

  const discovered = sidecar.getRuntime('old-runtime');
  assert.equal(discovered.runtimeId, 'old-runtime');
  assert.equal(discovered.reconnectable, true);
  assert.equal(discovered.status, 'walker-disconnected');

  await sidecar.writeInput('old-runtime', 'input from feishu');
  assert.deepEqual(runtime.inputs, ['input from feishu']);
  assert.equal(sidecar.getRuntime('new-runtime'), null);
});

test('REQ-001-B04/REQ-005-B01/REQ-006-B03: state and logs show reconnect path without secrets', () => {
  const logs = [];
  const sidecar = new ClaudeBridgeSidecar({ token: 'super-secret-token-value', logger: createLogger(logs), now: () => 1710000000000 });
  sidecar.registerRuntime({
    runtimeId: 'rt-safe',
    claudeSessionId: 'claude-1',
    processGeneration: 7,
    cwd: 'H:\\walker',
    env: { API_KEY: 'api-key-value', NORMAL: 'visible' },
    runtime: new FakeRuntime(),
  });
  sidecar.stopWalkerConnection('restart with PASSWORD=hidden-value');

  const snapshot = sidecar.getRuntime('rt-safe');
  assert.equal(snapshot.connectionState, 'reconnectable');
  assert.equal(snapshot.lastPath, 'reconnected');
  assert.equal(snapshot.reconnectable, true);
  assert.equal(snapshot.lastSeenAt, 1710000000000);
  assert.equal(Object.prototype.hasOwnProperty.call(snapshot, 'env'), false);
  assert.equal(JSON.stringify(snapshot).includes('super-secret-token-value'), false);
  assert.equal(JSON.stringify(snapshot).includes('api-key-value'), false);

  const logText = JSON.stringify(logs);
  assert.match(logText, /reconnected|reconnectable/);
  assert.equal(logText.includes('super-secret-token-value'), false);
  assert.equal(logText.includes('api-key-value'), false);
  assert.equal(logText.includes('hidden-value'), false);
});

test('REQ-003-B03: Walker disconnect rejects pending input and keeps diagnostic registry', async () => {
  let rejectPending;
  const runtime = new FakeRuntime();
  runtime.writeInput = () => new Promise((resolve, reject) => {
    rejectPending = reject;
  });
  const sidecar = new ClaudeBridgeSidecar({ token: 'bridge-token-1234567890' });
  sidecar.registerRuntime({ runtimeId: 'rt-pending', claudeSessionId: 'claude-pending', runtime });
  const pending = sidecar.writeInput('rt-pending', 'queued');
  await new Promise((resolve) => setImmediate(resolve));

  sidecar.stopWalkerConnection('restart');

  await assert.rejects(pending, /walker connection stopped/);
  assert.equal(typeof rejectPending, 'function');
  const snapshot = sidecar.getRuntime('rt-pending');
  assert.equal(snapshot.runtimeId, 'rt-pending');
  assert.equal(snapshot.reconnectable, true);
  assert.equal(snapshot.pendingInputs, 0);
});

test('REQ-006-B01/REQ-006-B02/REQ-006-B04: loopback and token rejection is diagnostic and redacted', () => {
  const sidecar = new ClaudeBridgeSidecar({ token: 'secret-control-token' });

  assert.equal(sidecar._isLoopback('127.0.0.1'), true);
  assert.equal(sidecar._isLoopback('::1'), true);
  assert.equal(sidecar._isLoopback('::ffff:127.0.0.1'), true);
  assert.equal(sidecar._isLoopback('10.0.0.2'), false);

  assert.deepEqual(sidecar._authorize({ remoteAddress: '10.0.0.2', token: 'secret-control-token' }), { ok: false, reason: 'non-loopback client' });
  assert.deepEqual(sidecar._authorize({ remoteAddress: '127.0.0.1' }), { ok: false, reason: 'missing token' });
  assert.deepEqual(sidecar._authorize({ remoteAddress: '127.0.0.1', token: 'wrong-token' }), { ok: false, reason: 'invalid token' });
  assert.deepEqual(sidecar._authorize({ remoteAddress: '127.0.0.1', token: 'secret-control-token' }), { ok: true });

  const err = sidecar._unauthorized('invalid token', 'secret-control-token');
  assert.equal(err.message.includes('invalid token'), true);
  assert.equal(err.message.includes('secret-control-token'), false);
  assert.equal(JSON.stringify(err).includes('secret-control-token'), false);
});

test('REQ-006-B02/REQ-006-B03: createAttachment returns credential without leaking token in registry', () => {
  const sidecar = new ClaudeBridgeSidecar({ token: 'control-token', tokenFactory: () => 'attach-token-secret-value' });
  sidecar.registerRuntime({ runtimeId: 'rt-attach', claudeSessionId: 'claude-attach', runtime: new FakeRuntime() });
  const attachment = sidecar.createAttachment('rt-attach');

  assert.equal(attachment.runtimeId, 'rt-attach');
  assert.equal(attachment.token, 'attach-token-secret-value');
  assert.match(attachment.url, /token=attach-token-secret-value/);

  const snapshot = sidecar.getRuntime('rt-attach');
  assert.equal(JSON.stringify(snapshot.agentRef).includes('attach-token-secret-value'), false);
  assert.equal(JSON.stringify(sidecar.listRuntimes()).includes('attach-token-secret-value'), false);
});
