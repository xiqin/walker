'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { runClaudeAttachCommand } = require('../src/cli/claude-attach-command');
const { MessageDispatcher } = require('../src/dispatch/message-dispatcher');
const { MessageDedup } = require('../src/core/message-dedup');
const { ClaudeBridgeSidecar } = require('../src/drivers/claude-bridge-sidecar');
const { ClaudeDriver } = require('../src/drivers/claude-driver');

const CLAUDE_SESSION_ID = '11111111-1111-4111-8111-111111111111';

class RecordingBroker {
  constructor(bridgeSidecar) {
    this.bridgeSidecar = bridgeSidecar;
    this.calls = { resumeRuntime: [], writeInput: [], stopRuntime: [], deleteRuntime: [], detachAllRuntimes: [] };
    this.runtimes = new Map();
  }

  createRuntime(options) {
    return this.resumeRuntime({ ...options, runtimeId: options && options.runtimeId || 'rt_created' });
  }

  resumeRuntime(options) {
    const opts = options || {};
    this.calls.resumeRuntime.push(opts);
    const runtimeId = opts.runtimeId || 'rt_fallback_new';
    const snapshot = {
      provider: 'claude',
      transport: 'pty-attach',
      runtimeId,
      claudeSessionId: opts.claudeSessionId,
      processGeneration: opts.processGeneration ? opts.processGeneration + 1 : 1,
      cwd: opts.cwd,
      status: 'active',
      agentRef: {
        provider: 'claude',
        transport: 'pty-attach',
        runtimeId,
        claudeSessionId: opts.claudeSessionId,
        processGeneration: opts.processGeneration ? opts.processGeneration + 1 : 1,
      },
    };
    this.runtimes.set(runtimeId, snapshot);
    return snapshot;
  }

  getRuntime(runtimeId) {
    if (this.runtimes.has(runtimeId)) return this.runtimes.get(runtimeId);
    if (!this.bridgeSidecar || typeof this.bridgeSidecar.getRuntime !== 'function') return null;
    const runtime = this.bridgeSidecar.getRuntime(runtimeId);
    return runtime ? { ...runtime, transport: 'bridge-sidecar', agentRef: runtime.agentRef } : null;
  }

  writeInput(runtimeId, data, options) {
    this.calls.writeInput.push({ runtimeId, data: Buffer.from(data), options });
    if (this.runtimes.has(runtimeId)) return Promise.resolve();
    if (this.bridgeSidecar && typeof this.bridgeSidecar.writeInput === 'function') {
      return this.bridgeSidecar.writeInput(runtimeId, data, options || {});
    }
    return Promise.reject(new Error('runtime not found: ' + runtimeId));
  }

  stopRuntime(runtimeId, reason) {
    this.calls.stopRuntime.push({ runtimeId, reason });
    this.runtimes.delete(runtimeId);
    return null;
  }

  deleteRuntime(runtimeId, reason) {
    this.calls.deleteRuntime.push({ runtimeId, reason });
    this.runtimes.delete(runtimeId);
    return null;
  }

  detachAllRuntimes(reason) {
    this.calls.detachAllRuntimes.push({ reason });
  }

  resize() {}
  subscribeOutput() { return () => {}; }
}

function createRuntime() {
  const runtime = new EventEmitter();
  runtime.inputs = [];
  runtime.writeInput = (data) => {
    runtime.inputs.push(Buffer.from(data));
    return Promise.resolve();
  };
  runtime.subscribeOutput = (handler) => {
    runtime.on('data', handler);
    return () => runtime.off('data', handler);
  };
  return runtime;
}

function createDispatcher(session, driver, updates, options = {}) {
  const feishuApi = {
    calls: [],
    sendProgressCard: (msgId, sessionId) => { feishuApi.calls.push({ type: 'sendProgressCard', msgId, sessionId }); return 'om_progress'; },
    updateProgressCard: (cardId, sessionId, event) => { feishuApi.calls.push({ type: 'updateProgressCard', cardId, sessionId, event }); },
    sendErrorCard: (msgId, message) => { feishuApi.calls.push({ type: 'sendErrorCard', msgId, message }); },
    replyText: (msgId, text) => { feishuApi.calls.push({ type: 'replyText', msgId, text }); },
    sendUnboundGuide: (msgId, routeKey) => { feishuApi.calls.push({ type: 'sendUnboundGuide', msgId, routeKey }); },
  };
  const sessionService = {
    getCurrent: () => session,
    getSession: () => session,
    getRouteForSession: () => 'feishu:oc_chat1:root:om_root1',
    touchRoute: () => {},
    markRunning: () => { session.status = 'running'; },
    markIdle: () => { session.status = 'idle'; },
    markError: (_id, message) => { session.status = 'error'; session.errorMessage = message; },
    updateSessionField: (sessionId, field, value) => {
      if (options.updateError) throw options.updateError;
      updates.push({ sessionId, field, value });
      session[field] = value;
    },
  };
  return {
    dispatcher: new MessageDispatcher({
      sessionService,
      driverRegistry: { get: () => driver },
      feishuApi,
      dedup: new MessageDedup({ windowMs: 300000 }),
      routeMode: 'thread',
    }),
    feishuApi,
  };
}

async function prompt(dispatcher, messageId, text) {
  return dispatcher.handleIncomingMessage({
    chatId: 'oc_chat1',
    messageId,
    openId: 'ou_user1',
    text,
    messageType: 'text',
    createTime: Date.now(),
    rootId: 'om_root1',
    routeKey: 'feishu:oc_chat1:root:om_root1',
  });
}

test('REQ-001/REQ-003/REQ-005: Walker connection 释放后旧 TUI runtime 存活时飞书 prompt 写入同一 runtime 且不创建第二个 TUI', async () => {
  const logs = [];
  const bridge = new ClaudeBridgeSidecar({
    token: 'bridge-secret-token',
    tokenFactory: () => 'attach-secret-token',
    logger: { info: (message, row) => logs.push({ level: 'info', message, row }), warn: () => {}, error: () => {} },
  });
  const oldRuntime = createRuntime();
  bridge.registerRuntime({
    runtimeId: 'rt_old_tui',
    claudeSessionId: CLAUDE_SESSION_ID,
    processGeneration: 1,
    cwd: 'H:\\walker',
    runtime: oldRuntime,
  });
  bridge.stopWalkerConnection('walker shutdown TOKEN=secret-value');

  const broker = new RecordingBroker(bridge);
  const terminalCalls = [];
  const driver = new ClaudeDriver({
    cwd: 'H:\\walker',
    claudeBridge: bridge,
    ptyBroker: broker,
    attachServer: false,
    transcript: null,
    openClaudeAttachTerminal: async (...args) => { terminalCalls.push(args); return { windowId: 'new-window' }; },
  });
  const oldRef = {
    provider: 'claude',
    transport: 'pty-attach',
    runtimeId: 'rt_old_tui',
    claudeSessionId: CLAUDE_SESSION_ID,
    processGeneration: 1,
    terminal: { status: 'active', windowId: 'old-window' },
    conversationReady: true,
    cwd: 'H:\\walker',
  };
  const session = { id: 'wks_reconnect', agent: 'claude', status: 'idle', agentRef: oldRef };
  const updates = [];
  const { dispatcher } = createDispatcher(session, driver, updates);

  const result = await prompt(dispatcher, 'om_reconnect_1', '继续旧 TUI');

  assert.equal(result, 'prompted');
  assert.deepEqual(oldRuntime.inputs.map((item) => item.toString()), ['继续旧 TUI\r']);
  assert.deepEqual(broker.calls.resumeRuntime, []);
  assert.deepEqual(terminalCalls, []);
  assert.deepEqual(broker.calls.stopRuntime, []);
  assert.deepEqual(broker.calls.deleteRuntime, []);
  assert.deepEqual(broker.calls.detachAllRuntimes, []);
  assert.equal(driver.isSessionRefActive(oldRef), true);
  const snapshot = bridge.getRuntime('rt_old_tui');
  assert.equal(snapshot.runtimeId, 'rt_old_tui');
  assert.equal(snapshot.reconnectable, true);
  assert.match(snapshot.connectionState, /reconnectable|reused|active/);
  const serialized = JSON.stringify({ snapshot, logs });
  assert.doesNotMatch(serialized, /secret-value|bridge-secret-token|attach-secret-token/);
});

test('REQ-002/REQ-005: 新 Walker 进程没有旧 in-memory bridge registry 时 fallback 到新受控 runtime', async () => {
  const bridge = new ClaudeBridgeSidecar({ token: 'bridge-secret-token' });
  const broker = new RecordingBroker(bridge);
  const terminalCalls = [];
  const driver = new ClaudeDriver({
    cwd: 'H:\\walker',
    claudeBridge: bridge,
    ptyBroker: broker,
    attachServer: false,
    transcript: null,
    openClaudeAttachTerminal: async (...args) => { terminalCalls.push(args); return { windowId: 'new-process-window' }; },
  });
  const oldRef = {
    provider: 'claude',
    transport: 'bridge-sidecar',
    runtimeId: 'rt_old_process_only',
    claudeSessionId: CLAUDE_SESSION_ID,
    processGeneration: 1,
    runtimeStatus: 'reconnected',
    terminal: { status: 'active', windowId: 'old-process-window' },
    conversationReady: true,
    cwd: 'H:\\walker',
  };
  const session = { id: 'wks_new_process_fallback', agent: 'claude', status: 'idle', agentRef: oldRef };
  const updates = [];
  const { dispatcher } = createDispatcher(session, driver, updates);

  const result = await prompt(dispatcher, 'om_new_process_fallback', '新进程 fallback');

  assert.equal(result, 'prompted');
  assert.equal(broker.calls.resumeRuntime.length, 1);
  assert.equal(broker.calls.resumeRuntime[0].runtimeId, undefined);
  assert.equal(terminalCalls.length, 0);
  assert.equal(session.agentRef.runtimeId, 'rt_fallback_new');
  assert.equal(session.agentRef.previousRuntimeId, 'rt_old_process_only');
  assert.equal(session.agentRef.runtimeStatus, 'fallback');
  assert.deepEqual(broker.calls.writeInput.map((call) => ({ runtimeId: call.runtimeId, text: call.data.toString() })), [
    { runtimeId: 'rt_fallback_new', text: '新进程 fallback\r' },
  ]);
  assert.deepEqual(updates.find((item) => item.field === 'agentRef').value, session.agentRef);
});

test('REQ-002/REQ-005: sidecar runtime 不可用时 fallback 到新受控 runtime 并在 prompt 前持久化新 agentRef', async () => {
  const bridge = new ClaudeBridgeSidecar({ token: 'bridge-secret-token' });
  const broker = new RecordingBroker(bridge);
  const terminalCalls = [];
  const driver = new ClaudeDriver({
    cwd: 'H:\\walker',
    claudeBridge: bridge,
    ptyBroker: broker,
    attachServer: false,
    transcript: null,
    openClaudeAttachTerminal: async (...args) => { terminalCalls.push(args); return { windowId: 'fallback-window' }; },
  });
  const oldRef = {
    provider: 'claude',
    transport: 'pty-attach',
    runtimeId: 'rt_missing_tui',
    claudeSessionId: CLAUDE_SESSION_ID,
    processGeneration: 1,
    terminal: { status: 'active', windowId: 'stale-window' },
    conversationReady: true,
    cwd: 'H:\\walker',
  };
  const session = { id: 'wks_fallback', agent: 'claude', status: 'idle', agentRef: oldRef };
  const updates = [];
  const callOrder = [];
  const originalUpdatePush = updates.push.bind(updates);
  updates.push = (value) => { callOrder.push('update:' + value.value.runtimeId); return originalUpdatePush(value); };
  const originalPrompt = driver.prompt.bind(driver);
  driver.prompt = async (ref, text, options) => {
    callOrder.push('prompt:' + ref.runtimeId);
    return originalPrompt(ref, text, options);
  };
  const { dispatcher } = createDispatcher(session, driver, updates);

  const result = await prompt(dispatcher, 'om_fallback_1', 'fallback message');

  assert.equal(result, 'prompted');
  assert.equal(broker.calls.resumeRuntime.length, 1);
  assert.equal(broker.calls.resumeRuntime[0].claudeSessionId, CLAUDE_SESSION_ID);
  assert.equal(broker.calls.resumeRuntime[0].runtimeId, undefined);
  assert.equal(terminalCalls.length, 0);
  assert.equal(session.agentRef.runtimeId, 'rt_fallback_new');
  assert.equal(session.agentRef.runtimeStatus, 'fallback');
  assert.equal(session.agentRef.previousRuntimeId, 'rt_missing_tui');
  assert.deepEqual(callOrder.slice(0, 2), ['update:rt_fallback_new', 'prompt:rt_fallback_new']);
  assert.deepEqual(updates.find((item) => item.field === 'agentRef').value, session.agentRef);
  assert.deepEqual(broker.calls.writeInput.map((call) => ({ runtimeId: call.runtimeId, text: call.data.toString() })), [
    { runtimeId: 'rt_fallback_new', text: 'fallback message\r' },
  ]);
  assert.doesNotMatch(JSON.stringify(session.agentRef), /bridge-secret-token|API_KEY|Bearer/i);
});

test('REQ-001-B03/REQ-002-B03: 并发飞书消息恢复同一 Claude UUID 时只创建一个 runtime 且不开窗口', async () => {
  const bridge = new ClaudeBridgeSidecar({ token: 'bridge-secret-token' });
  const broker = new RecordingBroker(bridge);
  const terminalCalls = [];
  const driver = new ClaudeDriver({
    cwd: 'H:\\walker',
    claudeBridge: bridge,
    ptyBroker: broker,
    attachServer: false,
    transcript: null,
    openClaudeAttachTerminal: async (...args) => { terminalCalls.push(args); return { windowId: 'unexpected-window' }; },
  });
  const oldRef = {
    provider: 'claude',
    transport: 'pty-attach',
    runtimeId: 'rt_missing_concurrent',
    claudeSessionId: CLAUDE_SESSION_ID,
    processGeneration: 3,
    terminal: { status: 'detached', windowId: 'old-detached-window' },
    conversationReady: true,
    cwd: 'H:\\walker',
  };
  const session = { id: 'wks_concurrent_fallback', agent: 'claude', status: 'idle', agentRef: oldRef };
  const updates = [];
  const { dispatcher } = createDispatcher(session, driver, updates);

  const [first, second] = await Promise.all([
    prompt(dispatcher, 'om_concurrent_1', 'first concurrent'),
    prompt(dispatcher, 'om_concurrent_2', 'second concurrent'),
  ]);

  assert.deepEqual([first, second], ['prompted', 'prompted']);
  assert.equal(broker.calls.resumeRuntime.length, 1);
  assert.equal(broker.calls.resumeRuntime[0].claudeSessionId, CLAUDE_SESSION_ID);
  assert.equal(terminalCalls.length, 0);
  assert.equal(session.agentRef.runtimeId, 'rt_fallback_new');
  assert.deepEqual(broker.calls.writeInput.map((call) => ({ runtimeId: call.runtimeId, text: call.data.toString() })), [
    { runtimeId: 'rt_fallback_new', text: 'first concurrent\r' },
    { runtimeId: 'rt_fallback_new', text: 'second concurrent\r' },
  ]);
  assert.ok(updates.filter((item) => item.field === 'agentRef').length >= 2);
  assert.ok(updates.every((item) => item.value.runtimeId === 'rt_fallback_new'));
});

test('REQ-006-B03/REQ-006-B04: agentRef 持久化失败时不写 PTY 并返回错误卡片', async () => {
  const bridge = new ClaudeBridgeSidecar({ token: 'bridge-secret-token' });
  const broker = new RecordingBroker(bridge);
  const terminalCalls = [];
  const driver = new ClaudeDriver({
    cwd: 'H:\\walker',
    claudeBridge: bridge,
    ptyBroker: broker,
    attachServer: false,
    transcript: null,
    openClaudeAttachTerminal: async (...args) => { terminalCalls.push(args); return { windowId: 'unexpected-window' }; },
  });
  const oldRef = {
    provider: 'claude',
    transport: 'pty-attach',
    runtimeId: 'rt_missing_persist',
    claudeSessionId: CLAUDE_SESSION_ID,
    processGeneration: 1,
    terminal: { status: 'detached', windowId: 'stale-window' },
    conversationReady: true,
    cwd: 'H:\\walker',
  };
  const session = { id: 'wks_persist_failed', agent: 'claude', status: 'idle', agentRef: oldRef };
  const updates = [];
  const { dispatcher, feishuApi } = createDispatcher(session, driver, updates, { updateError: new Error('disk write failed TOKEN=secret') });
  const stderr = [];
  const originalWrite = process.stderr.write;
  process.stderr.write = function write(chunk, ..._args) {
    stderr.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    return true;
  };

  let result;
  try {
    result = await prompt(dispatcher, 'om_persist_failed', 'must not be written');
  } finally {
    process.stderr.write = originalWrite;
  }

  assert.equal(result, 'error');
  assert.equal(broker.calls.resumeRuntime.length, 1);
  assert.equal(terminalCalls.length, 0);
  assert.deepEqual(broker.calls.writeInput, []);
  assert.equal(session.agentRef, oldRef);
  assert.deepEqual(updates, []);
  const errorCard = feishuApi.calls.find((call) => call.type === 'sendErrorCard');
  assert.ok(errorCard);
  assert.match(errorCard.message, /Failed to persist Claude runtime state before prompting/i);
  assert.doesNotMatch(JSON.stringify(feishuApi.calls), /TOKEN=secret|disk write failed/);
  assert.doesNotMatch(stderr.join(''), /TOKEN=secret|disk write failed TOKEN=secret/);
});

test('REQ-003: Walker stop 只释放 Walker connection，pending 输入被拒绝且 runtime 保持可诊断可续接', async () => {
  let rejectPending;
  const runtime = createRuntime();
  runtime.writeInput = (data) => {
    runtime.inputs.push(Buffer.from(data));
    return new Promise((_resolve, reject) => { rejectPending = reject; });
  };
  const bridge = new ClaudeBridgeSidecar({ token: 'bridge-secret-token' });
  bridge.registerRuntime({ runtimeId: 'rt_pending', claudeSessionId: CLAUDE_SESSION_ID, runtime, cwd: 'H:\\walker' });
  const broker = new RecordingBroker(bridge);
  const driver = new ClaudeDriver({ cwd: 'H:\\walker', claudeBridge: bridge, ptyBroker: broker, attachServer: false, transcript: null });
  const pending = driver.prompt({ provider: 'claude', transport: 'bridge-sidecar', runtimeId: 'rt_pending', claudeSessionId: CLAUDE_SESSION_ID }, 'pending input');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(typeof rejectPending, 'function');

  await driver.stopWalkerConnection('walker shutdown');

  await assert.rejects(pending, /walker connection stopped|walker shutdown/i);
  const snapshot = bridge.getRuntime('rt_pending');
  assert.equal(snapshot.status, 'walker-disconnected');
  assert.equal(snapshot.reconnectable, true);
  assert.equal(snapshot.connectionState, 'reconnectable');
  assert.deepEqual(broker.calls.stopRuntime, []);
  assert.deepEqual(broker.calls.deleteRuntime, []);
  assert.deepEqual(broker.calls.detachAllRuntimes, []);
});

class ManualWebSocket extends EventEmitter {
  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    ManualWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(String(data)));
  }

  close(code = 1000, reason = '') {
    this.emit('close', code, Buffer.from(String(reason)));
  }
}
ManualWebSocket.instances = [];

function stream() {
  const s = new EventEmitter();
  s.writes = [];
  s.isTTY = true;
  s.columns = 80;
  s.rows = 24;
  s.write = (chunk) => s.writes.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk)));
  s.setRawModeCalls = [];
  s.setRawMode = (value) => s.setRawModeCalls.push(value);
  s.resume = () => { s.resumed = true; };
  s.pause = () => { s.paused = true; };
  return s;
}

function text(s) {
  return Buffer.concat(s.writes).toString();
}

test('REQ-004/REQ-006: attach CLI 断线重连、失败退出和 token 错误均保持本地安全边界与脱敏', async () => {
  ManualWebSocket.instances = [];
  const stdout = stream();
  const resolves = [];
  const command = runClaudeAttachCommand(['rt_cli'], {
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
  await new Promise((resolve) => setImmediate(resolve));
  ManualWebSocket.instances[0].emit('open');
  ManualWebSocket.instances[0].close(1006, 'network lost');
  await new Promise((resolve) => setTimeout(resolve, 5));
  ManualWebSocket.instances[1].emit('open');
  ManualWebSocket.instances[1].emit('message', Buffer.from('reconnected output'));
  ManualWebSocket.instances[1].close(1000);
  assert.equal(await command, 0);
  assert.deepEqual(resolves, ['rt_cli', 'rt_cli']);
  assert.match(text(stdout), /reconnected output/);

  ManualWebSocket.instances = [];
  const stdin = stream();
  const stderr = stream();
  let count = 0;
  const failedCommand = runClaudeAttachCommand(['rt_cli'], {
    stdin,
    stdout: stream(),
    stderr,
    WebSocket: ManualWebSocket,
    reconnectWindowMs: 1,
    retryDelayMs: 5,
    resolveAttachment: async () => (++count === 1 ? { url: 'ws://127.0.0.1:1234/attach/rt_cli?token=secret-token' } : null),
  });
  await new Promise((resolve) => setImmediate(resolve));
  ManualWebSocket.instances[0].emit('open');
  ManualWebSocket.instances[0].close(1006, 'server vanished');
  const failed = await failedCommand;
  assert.equal(failed, 1);
  assert.deepEqual(stdin.setRawModeCalls, [true, false]);
  assert.equal(stdin.paused, true);
  assert.match(text(stderr), /reconnect window exceeded/i);
  assert.doesNotMatch(text(stderr), /secret-token/);

  const bridge = new ClaudeBridgeSidecar({ token: 'bridge-secret-token' });
  assert.equal(bridge._isLoopback('127.0.0.1'), true);
  assert.equal(bridge._isLoopback('10.0.0.5'), false);
  const auth = bridge._authorize({ remoteAddress: '127.0.0.1', token: 'wrong' });
  assert.equal(auth.ok, false);
  const error = bridge._unauthorized(auth.reason);
  assert.match(error.message, /unauthorized|invalid token/i);
  assert.doesNotMatch(error.message, /bridge-secret-token/);
});
