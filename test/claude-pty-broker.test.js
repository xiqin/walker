'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { ClaudePtyBroker } = require('../src/drivers/claude-pty-broker');

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createFakePtyFactory(options = {}) {
  const calls = [];
  const processes = [];
  const factory = {
    calls,
    processes,
    spawn(command, args, spawnOptions) {
      calls.push({ command, args, options: spawnOptions });
      if (options.failSpawn) throw options.failSpawn;
      const proc = new EventEmitter();
      proc.writes = [];
      proc.resizes = [];
      proc.kills = [];
      proc.write = options.write || ((data) => { proc.writes.push(data); });
      proc.resize = options.resize || ((cols, rows) => { proc.resizes.push({ cols, rows }); });
      proc.kill = (signal) => { proc.kills.push(signal); };
      proc.onData = (fn) => { proc.on('data', fn); return { dispose: () => proc.off('data', fn) }; };
      proc.onExit = (fn) => { proc.on('exit', fn); return { dispose: () => proc.off('exit', fn) }; };
      processes.push(proc);
      return proc;
    },
  };
  return factory;
}

function createBroker(options = {}) {
  const logs = [];
  const logger = {
    info: (message, extra) => logs.push({ level: 'info', message, ...extra }),
    warn: (message, extra) => logs.push({ level: 'warn', message, ...extra }),
    error: (message, extra) => logs.push({ level: 'error', message, ...extra }),
    debug: (message, extra) => logs.push({ level: 'debug', message, ...extra }),
  };
  const ptyFactory = options.ptyFactory || createFakePtyFactory(options.ptyOptions);
  const broker = new ClaudePtyBroker({
    command: 'kscc',
    cwd: 'H:\\walker',
    env: { ANTHROPIC_API_KEY: 'secret-token', SAFE: 'ok' },
    ptyFactory,
    idFactory: options.idFactory || (() => 'rt_test_1'),
    logger,
    bridgeSidecar: options.bridgeSidecar,
    replayLimitBytes: options.replayLimitBytes,
    queueLimit: options.queueLimit,
  });
  return { broker, ptyFactory, logs };
}

test('REQ-001-B01/REQ-005-B04: createRuntime 以 --session-id 启动一次并返回脱敏快照', () => {
  const { broker, ptyFactory } = createBroker();
  const snapshot = broker.createRuntime({ claudeSessionId: '11111111-1111-4111-8111-111111111111' });

  assert.equal(ptyFactory.calls.length, 1);
  assert.equal(ptyFactory.calls[0].command, 'kscc');
  assert.deepEqual(ptyFactory.calls[0].args, ['--session-id', '11111111-1111-4111-8111-111111111111']);
  assert.equal(snapshot.runtimeId, 'rt_test_1');
  assert.equal(snapshot.claudeSessionId, '11111111-1111-4111-8111-111111111111');
  assert.equal(snapshot.status, 'active');
  assert.equal(snapshot.processGeneration, 1);
  assert.equal(snapshot.agentRef.provider, 'claude');
  assert.equal(snapshot.agentRef.transport, 'pty-attach');
  assert.notEqual(snapshot.agentRef.transport, 'pty');
  assert.equal(snapshot.env, undefined);
  assert.equal(snapshot.token, undefined);
});

test('REQ-001-B04/REQ-005-B02: resumeRuntime 使用 --resume 且不使用 --continue，generation 递增', () => {
  const { broker, ptyFactory } = createBroker();
  const created = broker.createRuntime({ claudeSessionId: '22222222-2222-4222-8222-222222222222' });
  const resumed = broker.resumeRuntime({ runtimeId: created.runtimeId, claudeSessionId: created.claudeSessionId });

  assert.equal(ptyFactory.calls.length, 2);
  assert.deepEqual(ptyFactory.calls[1].args, ['--resume', '22222222-2222-4222-8222-222222222222']);
  assert.equal(ptyFactory.calls[1].args.includes('--continue'), false);
  assert.equal(resumed.processGeneration, 2);
});

test('REQ-001-B01/REQ-002-B01: createRuntime 和 resumeRuntime 使用调用方提供的完整 launchArgs', () => {
  const { broker, ptyFactory } = createBroker();
  const created = broker.createRuntime({
    claudeSessionId: '22222222-2222-4222-8222-222222222222',
    launchArgs: ['--session-id', '22222222-2222-4222-8222-222222222222', '--model', 'sonnet', '--allowed-tools', 'Read'],
  });
  broker.resumeRuntime({
    runtimeId: created.runtimeId,
    claudeSessionId: created.claudeSessionId,
    launchArgs: ['--resume', created.claudeSessionId, '--model', 'sonnet', '--allowed-tools', 'Read'],
  });

  assert.deepEqual(ptyFactory.calls[0].args, ['--session-id', '22222222-2222-4222-8222-222222222222', '--model', 'sonnet', '--allowed-tools', 'Read']);
  assert.deepEqual(ptyFactory.calls[1].args, ['--resume', '22222222-2222-4222-8222-222222222222', '--model', 'sonnet', '--allowed-tools', 'Read']);
  assert.equal(ptyFactory.calls[0].args.includes('--print'), false);
  assert.equal(ptyFactory.calls[1].args.includes('--continue'), false);
});

test('REQ-001-B03/REQ-001-B04: resume spawn 失败时保留旧 active runtime', () => {
  const failOnSecondSpawn = createFakePtyFactory();
  const originalSpawn = failOnSecondSpawn.spawn.bind(failOnSecondSpawn);
  failOnSecondSpawn.spawn = (command, args, options) => {
    if (failOnSecondSpawn.calls.length === 1) throw new Error('ConPTY unavailable token=bad');
    return originalSpawn(command, args, options);
  };
  const { broker, ptyFactory } = createBroker({ ptyFactory: failOnSecondSpawn });
  const created = broker.createRuntime({ claudeSessionId: '22222222-2222-4222-8222-222222222222' });
  const oldProc = ptyFactory.processes[0];

  assert.throws(() => broker.resumeRuntime({ runtimeId: created.runtimeId, claudeSessionId: created.claudeSessionId }), /ConPTY unavailable/);

  const snapshot = broker.getRuntime(created.runtimeId);
  assert.equal(snapshot.status, 'active');
  assert.equal(snapshot.processGeneration, 1);
  assert.deepEqual(oldProc.kills, []);
});

test('REQ-001-B04/REQ-005-B02: resumeRuntime 将传入 processGeneration 作为基线并保证递增', () => {
  const { broker } = createBroker();
  const created = broker.createRuntime({ claudeSessionId: '22222222-2222-4222-8222-222222222222' });

  const sameBaseline = broker.resumeRuntime({
    runtimeId: created.runtimeId,
    claudeSessionId: created.claudeSessionId,
    processGeneration: created.processGeneration,
  });
  assert.equal(sameBaseline.processGeneration, 2);

  const persistedBaseline = broker.resumeRuntime({
    runtimeId: created.runtimeId,
    claudeSessionId: created.claudeSessionId,
    processGeneration: 10,
  });
  assert.equal(persistedBaseline.processGeneration, 11);
});

test('createRuntime 和 resumeRuntime 将 PTY runtime 注册到 bridge sidecar', () => {
  const registrations = [];
  const bridgeSidecar = {
    registerRuntime(options) {
      registrations.push(options);
      return options;
    },
  };
  const { broker } = createBroker({ bridgeSidecar });
  const created = broker.createRuntime({ claudeSessionId: '22222222-2222-4222-8222-222222222222' });
  const resumed = broker.resumeRuntime({ runtimeId: created.runtimeId, claudeSessionId: created.claudeSessionId });

  assert.equal(registrations.length, 2);
  assert.equal(registrations[0].runtimeId, created.runtimeId);
  assert.equal(registrations[0].claudeSessionId, created.claudeSessionId);
  assert.equal(registrations[0].status, 'active');
  assert.equal(typeof registrations[0].runtime.write, 'function');
  assert.equal(registrations[0].reconnectable, true);
  assert.equal(registrations[1].runtimeId, resumed.runtimeId);
  assert.equal(registrations[1].processGeneration, resumed.processGeneration);
});

test('REQ-001-B04/REQ-005-B03: 旧 generation 迟到 data/exit 不污染新 runtime、replay 或 pending', async () => {
  const blocker = createDeferred();
  const { broker, ptyFactory } = createBroker({ ptyOptions: { write: () => blocker.promise } });
  const created = broker.createRuntime({ claudeSessionId: '22222222-2222-4222-8222-222222222222' });
  const oldProc = ptyFactory.processes[0];

  const resumed = broker.resumeRuntime({ runtimeId: created.runtimeId, claudeSessionId: created.claudeSessionId });
  const liveChunks = [];
  broker.subscribeOutput(resumed.runtimeId, (chunk) => liveChunks.push(Buffer.from(chunk).toString()), { replay: false });
  oldProc.emit('data', Buffer.from('stale-output'));
  const pending = broker.writeInput(resumed.runtimeId, 'after resume', { source: 'test' });
  oldProc.emit('exit', { exitCode: 9, signal: null });

  const snapshot = broker.getRuntime(resumed.runtimeId);
  assert.equal(snapshot.status, 'active');
  assert.equal(snapshot.processGeneration, 2);
  assert.deepEqual(liveChunks, []);

  const replayChunks = [];
  broker.subscribeOutput(resumed.runtimeId, (chunk) => replayChunks.push(Buffer.from(chunk).toString()), { replay: true });
  assert.equal(replayChunks.join(''), '');
  blocker.resolve();
  await pending;
});

test('REQ-001-B03: 启动失败不会留下 active runtime', () => {
  const { broker } = createBroker({ ptyOptions: { failSpawn: Object.assign(new Error('ConPTY unavailable token=bad'), { code: 'ENOENT' }) } });

  assert.throws(() => broker.createRuntime({ claudeSessionId: '33333333-3333-4333-8333-333333333333' }), /pty runtime spawn failed/i);
  assert.equal(broker.getRuntime('rt_test_1'), null);
});

test('REQ-001-B02: 正常 exit 转为 stopped，异常 exit 转为 error', () => {
  const { broker, ptyFactory } = createBroker();
  const first = broker.createRuntime({ claudeSessionId: '44444444-4444-4444-8444-444444444444' });
  ptyFactory.processes[0].emit('exit', { exitCode: 0, signal: null });
  assert.equal(broker.getRuntime(first.runtimeId).status, 'stopped');

  const second = broker.resumeRuntime({ runtimeId: first.runtimeId, claudeSessionId: first.claudeSessionId });
  ptyFactory.processes[1].emit('exit', { exitCode: 2, signal: null });
  assert.equal(broker.getRuntime(second.runtimeId).status, 'error');
  assert.match(broker.getRuntime(second.runtimeId).error.message, /exit code 2/i);
});

test('REQ-005-B03: 异常 exit 会失败 pending write/resize，并使后续 subscribe 可观察失败', async () => {
  const pendingWrite = createDeferred();
  const pendingResize = createDeferred();
  const { broker, ptyFactory } = createBroker({
    ptyOptions: {
      write: () => pendingWrite.promise,
      resize: () => pendingResize.promise,
    },
  });
  const runtime = broker.createRuntime({ claudeSessionId: '55555555-5555-4555-8555-555555555555' });
  const writePromise = broker.writeInput(runtime.runtimeId, 'hello', { source: 'feishu' });
  const resizePromise = broker.resize(runtime.runtimeId, 120, 40);

  ptyFactory.processes[0].emit('exit', { exitCode: 9, signal: null });

  await assert.rejects(writePromise, /exit code 9/i);
  await assert.rejects(resizePromise, /exit code 9/i);
  assert.throws(() => broker.subscribeOutput(runtime.runtimeId, () => {}), /exit code 9/i);
});

test('REQ-005-B01: stopRuntime/deleteRuntime 幂等并调用 kill', () => {
  const { broker, ptyFactory } = createBroker();
  const runtime = broker.createRuntime({ claudeSessionId: '66666666-6666-4666-8666-666666666666' });

  broker.stopRuntime(runtime.runtimeId, 'test-stop');
  broker.stopRuntime(runtime.runtimeId, 'test-stop-again');
  assert.equal(ptyFactory.processes[0].kills.length, 1);
  assert.equal(broker.getRuntime(runtime.runtimeId).status, 'stopped');

  broker.deleteRuntime(runtime.runtimeId, 'test-delete');
  broker.deleteRuntime(runtime.runtimeId, 'test-delete-again');
  assert.equal(ptyFactory.processes[0].kills.length, 1);
  assert.equal(broker.getRuntime(runtime.runtimeId), null);
});

test('walker 退出时 detachAllRuntimes 释放 broker 状态但不关闭 Claude TUI', () => {
  const blocker = createDeferred();
  const { broker, ptyFactory } = createBroker({ ptyOptions: { write: () => blocker.promise } });
  const runtime = broker.createRuntime({ claudeSessionId: '99999999-9999-4999-8999-999999999999' });
  const chunks = [];
  broker.subscribeOutput(runtime.runtimeId, (chunk) => chunks.push(Buffer.from(chunk).toString()), { replay: false });
  const pending = broker.writeInput(runtime.runtimeId, 'queued', { source: 'test' });

  broker.detachAllRuntimes('walker shutdown');

  assert.equal(ptyFactory.processes[0].kills.length, 0);
  assert.equal(broker.getRuntime(runtime.runtimeId), null);
  assert.equal(chunks.length, 0);
  ptyFactory.processes[0].emit('data', Buffer.from('late-output'));
  assert.equal(chunks.length, 0);
  assert.rejects(pending, /walker shutdown/i);
});

test('REQ-006-B03: 输出回放缓冲超过上限后淘汰旧数据且队列有固定上限', async () => {
  const blocker = createDeferred();
  const { broker, ptyFactory } = createBroker({ replayLimitBytes: 10, queueLimit: 1, ptyOptions: { write: () => blocker.promise } });
  const runtime = broker.createRuntime({ claudeSessionId: '77777777-7777-4777-8777-777777777777' });

  ptyFactory.processes[0].emit('data', Buffer.from('12345678'));
  ptyFactory.processes[0].emit('data', Buffer.from('abcdef'));
  const replayed = [];
  broker.subscribeOutput(runtime.runtimeId, (chunk) => replayed.push(Buffer.from(chunk).toString()), { replay: true });
  assert.equal(replayed.join(''), '5678abcdef');

  const first = broker.writeInput(runtime.runtimeId, 'one', { source: 'test' });
  assert.throws(() => broker.writeInput(runtime.runtimeId, 'two', { source: 'test' }), /queue limit exceeded/i);
  blocker.resolve();
  await first;
});

test('REQ-006-B02: 生命周期日志包含结构化字段且不记录输入内容或敏感 token', () => {
  const { broker, ptyFactory, logs } = createBroker();
  const runtime = broker.createRuntime({ claudeSessionId: '88888888-8888-4888-8888-888888888888' });
  broker.writeInput(runtime.runtimeId, 'prompt contains secret-token', { source: 'feishu' });
  ptyFactory.processes[0].emit('exit', { exitCode: 0, signal: 'SIGTERM' });

  assert.ok(logs.some((row) => row.runtimeId === runtime.runtimeId));
  assert.ok(logs.some((row) => row.processGeneration === 1));
  assert.ok(logs.some((row) => row.source === 'feishu'));
  assert.ok(logs.some((row) => row.queueDepth === 0));
  assert.ok(logs.some((row) => row.exitReason === 'signal SIGTERM'));
  assert.equal(JSON.stringify(logs).includes('prompt contains secret-token'), false);
  assert.equal(JSON.stringify(logs).includes('secret-token'), false);
});

test('REQ-001-B06/REQ-002-B02: bridge lookup 可返回可续接 runtime 且不创建第二个 PTY', () => {
  const bridgeCalls = [];
  const bridgeSidecar = {
    getRuntime(runtimeId) {
      bridgeCalls.push(runtimeId);
      return {
        runtimeId,
        claudeSessionId: '11111111-1111-4111-8111-111111111111',
        status: 'walker-disconnected',
        reconnectable: true,
        processGeneration: 8,
        connectionState: 'reconnectable',
      };
    },
  };
  const { broker, ptyFactory } = createBroker({ bridgeSidecar });

  const snapshot = broker.getRuntime('rt_bridge_old');

  assert.equal(snapshot.runtimeId, 'rt_bridge_old');
  assert.equal(snapshot.transport, 'bridge-sidecar');
  assert.equal(snapshot.reconnectable, true);
  assert.equal(snapshot.agentRef.transport, 'bridge-sidecar');
  assert.deepEqual(bridgeCalls, ['rt_bridge_old']);
  assert.equal(ptyFactory.calls.length, 0);
});

test('REQ-001-B01/REQ-002-B02: bridge write 只写可续接 runtime，不可用 runtime 明确拒绝', async () => {
  const writes = [];
  const bridgeSidecar = {
    getRuntime(runtimeId) {
      if (runtimeId === 'rt_bridge_active') return { runtimeId, claudeSessionId: '11111111-1111-4111-8111-111111111111', status: 'active', reconnectable: true, processGeneration: 2 };
      if (runtimeId === 'rt_bridge_stale') return { runtimeId, claudeSessionId: '22222222-2222-4222-8222-222222222222', status: 'stopped', reconnectable: false, processGeneration: 2 };
      return null;
    },
    writeInput(runtimeId, data) {
      writes.push({ runtimeId, data: Buffer.from(data).toString() });
      return Promise.resolve();
    },
  };
  const { broker } = createBroker({ bridgeSidecar });

  await broker.writeInput('rt_bridge_active', Buffer.from('hello'), { source: 'feishu' });

  assert.deepEqual(writes, [{ runtimeId: 'rt_bridge_active', data: 'hello' }]);
  assert.throws(() => broker.writeInput('rt_bridge_stale', 'bad', { source: 'feishu' }), /runtime is not active/i);
});
