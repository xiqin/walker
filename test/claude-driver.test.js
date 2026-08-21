const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ClaudeDriver, mapClaudeLine } = require('../src/drivers/claude-driver');
const { AgentEvent } = require('../src/drivers/agent-driver');
const { encodeClaudeProjectPath } = require('../src/drivers/claude-transcript');

function createFakeBroker() {
  const calls = { createRuntime: [], resumeRuntime: [], writeInput: [], stopRuntime: [], deleteRuntime: [], detachAllRuntimes: [] };
  const runtimes = new Map();
  const broker = {
    calls,
    runtimes,
    createRuntime(options) {
      calls.createRuntime.push(options);
      const snapshot = {
        runtimeId: options.runtimeId || 'rt_1',
        claudeSessionId: options.claudeSessionId,
        processGeneration: 1,
        status: 'active',
        cwd: options.cwd,
        agentRef: {
          provider: 'claude',
          transport: 'pty-attach',
          runtimeId: options.runtimeId || 'rt_1',
          claudeSessionId: options.claudeSessionId,
          processGeneration: 1,
        },
      };
      runtimes.set(snapshot.runtimeId, snapshot);
      return snapshot;
    },
    resumeRuntime(options) {
      calls.resumeRuntime.push(options);
      const snapshot = {
        runtimeId: options.runtimeId || 'rt_resumed',
        claudeSessionId: options.claudeSessionId,
        processGeneration: options.processGeneration ? options.processGeneration + 1 : 1,
        status: 'active',
        cwd: options.cwd,
        agentRef: {
          provider: 'claude',
          transport: 'pty-attach',
          runtimeId: options.runtimeId || 'rt_resumed',
          claudeSessionId: options.claudeSessionId,
          processGeneration: options.processGeneration ? options.processGeneration + 1 : 1,
        },
      };
      runtimes.set(snapshot.runtimeId, snapshot);
      return snapshot;
    },
    getRuntime(runtimeId) {
      return runtimes.get(runtimeId) || null;
    },
    listRuntimes() {
      return Array.from(runtimes.values());
    },
    writeInput(runtimeId, data, options) {
      calls.writeInput.push({ runtimeId, data: Buffer.from(data), options });
      return Promise.resolve();
    },
    stopRuntime(runtimeId, reason) {
      calls.stopRuntime.push({ runtimeId, reason });
      const runtime = runtimes.get(runtimeId);
      if (runtime) runtime.status = 'stopped';
      return { runtimeId, status: 'stopped' };
    },
    deleteRuntime(runtimeId, reason) {
      calls.deleteRuntime.push({ runtimeId, reason });
      runtimes.delete(runtimeId);
      return null;
    },
    detachAllRuntimes(reason) {
      calls.detachAllRuntimes.push({ reason });
      runtimes.clear();
    },
  };
  return broker;
}

function createFakeBridge() {
  const calls = { getRuntime: [], writeInput: [], stopWalkerConnection: [] };
  const runtimes = new Map();
  return {
    calls,
    runtimes,
    getRuntime(runtimeId) {
      calls.getRuntime.push(runtimeId);
      return runtimes.get(runtimeId) || null;
    },
    writeInput(runtimeId, data) {
      calls.writeInput.push({ runtimeId, data: Buffer.isBuffer(data) ? Buffer.from(data) : data });
      return Promise.resolve();
    },
    stopWalkerConnection(reason) {
      calls.stopWalkerConnection.push(reason);
    },
  };
}

describe('ClaudeDriver ensureReady', () => {
  it('使用 claude --version 探测 CLI', async () => {
    const calls = [];
    const driver = new ClaudeDriver({
      claudeCmd: 'claude-test',
      execFile: async (cmd, args, options) => {
        calls.push({ cmd, args, options });
        return { stdout: '2.1.196 (Claude Code)\n', stderr: '' };
      },
    });

    const result = await driver.ensureReady();

    assert.equal(result, true);
    assert.equal(calls[0].cmd, 'claude-test');
    assert.deepEqual(calls[0].args, ['--version']);
  });

  it('CLI 不可用时返回脱敏诊断错误', async () => {
    const driver = new ClaudeDriver({
      execFile: async () => {
        const err = new Error('ENOENT token=abc123');
        err.code = 'ENOENT';
        throw err;
      },
    });

    await assert.rejects(() => driver.ensureReady(), (err) => {
      assert.equal(err.code, 'ENOENT');
      assert.match(err.message, /claude cli is not available/i);
      assert.doesNotMatch(err.message, /abc123/);
      return true;
    });
  });
});

describe('ClaudeDriver session lifecycle', () => {
  it('创建和恢复 Claude sessionRef', async () => {
    const broker = createFakeBroker();
    const driver = new ClaudeDriver({ cwd: 'H:\\walker', model: 'sonnet', ptyBroker: broker });
    const ref = await driver.createSession({ title: 't', sessionId: '11111111-1111-4111-8111-111111111111' });

    assert.equal(ref.provider, 'claude');
    assert.equal(ref.transport, 'pty-attach');
    assert.equal(ref.claudeSessionId, '11111111-1111-4111-8111-111111111111');
    assert.equal(ref.runtimeId, 'rt_1');
    assert.equal(ref.processGeneration, 1);
    assert.equal(ref.model, 'sonnet');

    const resumed = await driver.resumeSession(ref);
    assert.equal(resumed.claudeSessionId, ref.claudeSessionId);
    assert.equal(resumed.runtimeId, 'rt_1');
    assert.equal(resumed.processGeneration, 2);
    assert.deepEqual(broker.calls.resumeRuntime[0], {
      runtimeId: 'rt_1',
      claudeSessionId: ref.claudeSessionId,
      cwd: 'H:\\walker',
      env: driver.env,
      launchArgs: ['--resume', ref.claudeSessionId, '--model', 'sonnet'],
      processGeneration: 1,
    });
    assert.ok(resumed.updatedAt);
  });

  it('REQ-002-B02: resumeSession 从精确 UUID 恢复 PTY runtime 且不打开 attach 窗口', async () => {
    const broker = createFakeBroker();
    const calls = [];
    const driver = new ClaudeDriver({
      cwd: 'H:\\walker',
      ptyBroker: broker,
      attachServer: { createAttachment: (runtimeId) => ({ runtimeId, url: 'ws://127.0.0.1/attach/' + runtimeId + '?token=secret', token: 'secret' }) },
      openClaudeAttachTerminal: async (runtimeId) => { calls.push(runtimeId); return { windowId: 'win_resume' }; },
    });

    const resumed = await driver.resumeSession({
      provider: 'claude',
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      runtimeId: 'rt_old',
      processGeneration: 4,
      cwd: 'H:\\walker',
    });

    assert.equal(resumed.transport, 'pty-attach');
    assert.equal(resumed.runtimeId, 'rt_old');
    assert.equal(resumed.processGeneration, 5);
    assert.equal(resumed.terminal, undefined);
    assert.deepEqual(calls, []);
    assert.equal(driver.isSessionRefActive(resumed), true);
    assert.deepEqual(broker.calls.resumeRuntime[0].claudeSessionId, '11111111-1111-4111-8111-111111111111');
  });

  it('REQ-001-B03: 并发 resumeSession 同一 Claude UUID 只恢复一个 PTY runtime', async () => {
    const broker = createFakeBroker();
    const driver = new ClaudeDriver({ cwd: 'H:\\walker', ptyBroker: broker });
    const sessionRef = {
      provider: 'claude',
      transport: 'pty-attach',
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      runtimeId: 'rt_old',
      processGeneration: 4,
      cwd: 'H:\\walker',
    };

    const [first, second] = await Promise.all([driver.resumeSession(sessionRef), driver.resumeSession(sessionRef)]);

    assert.equal(first.runtimeId, 'rt_old');
    assert.equal(second.runtimeId, 'rt_old');
    assert.equal(first.processGeneration, 5);
    assert.equal(second.processGeneration, 5);
    assert.equal(broker.calls.resumeRuntime.length, 1);
  });

  it('REQ-001-B01/REQ-001-B02/REQ-001-B06/REQ-005-B01: bridge 可续接时复用旧 runtime 且不打开新 PTY/TUI', async () => {
    const broker = createFakeBroker();
    const bridge = createFakeBridge();
    const terminalCalls = [];
    bridge.runtimes.set('rt_old_bridge', {
      runtimeId: 'rt_old_bridge',
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      status: 'walker-disconnected',
      reconnectable: true,
      processGeneration: 7,
      cwd: 'H:\\walker',
      connectionState: 'reconnectable',
      lastPath: 'reconnected',
      agentRef: {
        provider: 'claude',
        transport: 'bridge-sidecar',
        runtimeId: 'rt_old_bridge',
        claudeSessionId: '11111111-1111-4111-8111-111111111111',
        processGeneration: 7,
      },
    });
    const driver = new ClaudeDriver({
      cwd: 'H:\\walker',
      ptyBroker: broker,
      claudeBridge: bridge,
      openClaudeAttachTerminal: async (runtimeId) => { terminalCalls.push(runtimeId); return { windowId: 'win_new' }; },
    });

    const resumed = await driver.resumeSession({
      provider: 'claude',
      transport: 'bridge-sidecar',
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      runtimeId: 'rt_old_bridge',
      processGeneration: 7,
      runtimeStatus: 'stale',
      cwd: 'H:\\walker',
    });
    await driver.prompt(resumed, 'after reconnect');

    assert.equal(resumed.runtimeId, 'rt_old_bridge');
    assert.equal(resumed.transport, 'bridge-sidecar');
    assert.equal(resumed.runtimeStatus, 'reconnected');
    assert.equal(resumed.connectionState, 'reconnectable');
    assert.equal(resumed.runtimePath, 'reconnected');
    assert.equal(resumed.processGeneration, 7);
    assert.equal(driver.isSessionRefActive(resumed), true);
    assert.equal(broker.calls.resumeRuntime.length, 0);
    assert.equal(broker.calls.createRuntime.length, 0);
    assert.deepEqual(terminalCalls, []);
    assert.deepEqual(bridge.calls.writeInput.map((call) => call.runtimeId), ['rt_old_bridge']);
    assert.equal(bridge.calls.writeInput[0].data.toString(), 'after reconnect\r');
  });

  it('REQ-001-B03/REQ-001-B05/REQ-002-B01/REQ-002-B03/REQ-002-B04/REQ-005-B02: bridge 不可用时先 fallback 到新 runtime 再写 prompt', async () => {
    const broker = createFakeBroker();
    const bridge = createFakeBridge();
    const terminalCalls = [];
    bridge.runtimes.set('rt_stale_bridge', {
      runtimeId: 'rt_stale_bridge',
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      status: 'stopped',
      reconnectable: false,
      processGeneration: 3,
      connectionState: 'unavailable',
      lastPath: 'unavailable',
    });
    const driver = new ClaudeDriver({
      cwd: 'H:\\walker',
      ptyBroker: broker,
      claudeBridge: bridge,
      attachServer: { createAttachment: (runtimeId) => ({ runtimeId, url: 'ws://127.0.0.1/attach/' + runtimeId + '?token=secret', token: 'secret' }) },
      openClaudeAttachTerminal: async (runtimeId) => { terminalCalls.push(runtimeId); return { windowId: 'win_fallback' }; },
    });

    assert.equal(driver.isSessionRefActive({ claudeSessionId: '11111111-1111-4111-8111-111111111111', runtimeId: 'rt_stale_bridge', terminal: { status: 'active' } }), false);
    const resumed = await driver.resumeSession({
      provider: 'claude',
      transport: 'bridge-sidecar',
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      runtimeId: 'rt_stale_bridge',
      processGeneration: 3,
      runtimeStatus: 'stale',
      cwd: 'H:\\walker',
    });
    await driver.prompt(resumed, 'after fallback');

    assert.equal(resumed.runtimeId, 'rt_resumed');
    assert.equal(resumed.transport, 'pty-attach');
    assert.equal(resumed.runtimeStatus, 'fallback');
    assert.equal(resumed.connectionState, 'fallback');
    assert.equal(resumed.previousRuntimeId, 'rt_stale_bridge');
    assert.deepEqual(terminalCalls, []);
    assert.equal(broker.calls.resumeRuntime.length, 1);
    assert.equal(broker.calls.resumeRuntime[0].runtimeId, undefined);
    assert.deepEqual(bridge.calls.writeInput, []);
    assert.deepEqual(broker.calls.writeInput.map((call) => call.runtimeId), ['rt_resumed']);
    assert.equal(broker.calls.writeInput[0].data.toString(), 'after fallback\r');
  });

  it('REQ-002-B02/REQ-002-B05/REQ-005-B03: lookup 失败不 active，旧格式 ref fallback 且状态脱敏', async () => {
    const broker = createFakeBroker();
    const bridge = {
      getRuntime() { throw new Error('lookup failed API_KEY=secret-value'); },
      writeInput() { throw new Error('must not write stale runtime'); },
    };
    const driver = new ClaudeDriver({
      cwd: 'H:\\walker',
      ptyBroker: broker,
      claudeBridge: bridge,
      attachServer: false,
      openClaudeAttachTerminal: async () => ({ windowId: 'win_old_format' }),
    });

    assert.equal(driver.isSessionRefActive({ claudeSessionId: '11111111-1111-4111-8111-111111111111', runtimeId: 'rt_lookup_fail', terminal: { status: 'active' } }), false);
    const resumed = await driver.resumeSession({
      provider: 'claude',
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      runtimeId: 'rt_lookup_fail',
      processGeneration: 2,
      cwd: 'H:\\walker',
    });

    assert.equal(resumed.runtimeId, 'rt_resumed');
    assert.equal(resumed.runtimeStatus, 'fallback');
    assert.match(resumed.runtimeReason, /lookup failed/);
    assert.doesNotMatch(JSON.stringify(resumed), /secret-value/);
  });

  it('stopWalkerConnection 释放 Walker 侧状态但不 detach/kill runtime', async () => {
    const broker = createFakeBroker();
    const bridge = createFakeBridge();
    const driver = new ClaudeDriver({ cwd: 'H:\walker', ptyBroker: broker, claudeBridge: bridge });

    await driver.stopWalkerConnection('walker shutdown');

    assert.deepEqual(bridge.calls.stopWalkerConnection, ['walker shutdown']);
    assert.deepEqual(broker.calls.detachAllRuntimes, []);
    assert.deepEqual(broker.calls.stopRuntime, []);
    assert.deepEqual(broker.calls.deleteRuntime, []);
  });

  it('默认生成 Claude CLI 可接受的 UUID session id', async () => {
    const driver = new ClaudeDriver({ cwd: 'H:\\walker', ptyBroker: createFakeBroker() });
    const ref = await driver.createSession({ title: 't' });

    assert.match(ref.claudeSessionId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('创建 session 时立即创建 Claude PTY runtime 并打开 attach 窗口', async () => {
    const broker = createFakeBroker();
    const calls = [];
    const attachServer = {
      createAttachment(runtimeId) {
        calls.push({ type: 'attachment', runtimeId });
        return { runtimeId, url: 'ws://127.0.0.1:1234/attach/' + runtimeId + '?token=secret', token: 'secret' };
      },
    };
    const driver = new ClaudeDriver({
      claudeCmd: 'kscc.exe',
      model: 'glm-5.1',
      permissionMode: 'default',
      ptyBroker: broker,
      attachServer,
      openClaudeAttachTerminal: async (runtimeId, options) => {
        calls.push({ type: 'terminal', runtimeId, options });
        return { pid: 1234, windowId: 'win_1' };
      },
    });

    const ref = await driver.createSession({
      title: 'kscc test & safe',
      cwd: 'H:\\walker folder',
      sessionId: '11111111-1111-4111-8111-111111111111',
    });

    assert.equal(ref.provider, 'claude');
    assert.equal(ref.transport, 'pty-attach');
    assert.equal(ref.conversationReady, true);
    assert.equal(ref.runtimeId, 'rt_1');
    assert.equal(ref.terminal.status, 'active');
    assert.deepEqual(broker.calls.createRuntime[0], {
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      cwd: 'H:\\walker folder',
      env: driver.env,
      launchArgs: ['--session-id', '11111111-1111-4111-8111-111111111111', '--model', 'glm-5.1'],
      cols: undefined,
      rows: undefined,
    });
    assert.equal(calls[0].type, 'attachment');
    assert.equal(calls[1].type, 'terminal');
    assert.equal(calls[1].runtimeId, 'rt_1');
    assert.equal(calls[1].options.attachUrl, 'ws://127.0.0.1:1234/attach/rt_1?token=secret');
    assert.equal(calls[1].options.token, 'secret');
    assert.equal(ref.terminal.attachUrl, undefined);
    assert.doesNotMatch(JSON.stringify(ref), /secret/);
    assert.equal(attachServer.broker, driver.attachBroker);
    assert.equal(driver.isSessionRefActive(ref), true);
  });

  it('默认创建并启动 loopback attach server 后再打开窗口', async () => {
    const broker = createFakeBroker();
    const calls = [];
    const fakeServer = {
      start: async () => { calls.push('start'); },
      createAttachment(runtimeId) {
        calls.push('attachment:' + runtimeId);
        return { runtimeId, url: 'ws://127.0.0.1:5000/attach/' + runtimeId + '?token=secret', token: 'secret' };
      },
    };
    const driver = new ClaudeDriver({
      ptyBroker: broker,
      attachServerFactory: ({ broker: attachBroker }) => {
        assert.equal(typeof attachBroker.writeInput, 'function');
        return fakeServer;
      },
      openClaudeAttachTerminal: async (runtimeId) => { calls.push('terminal:' + runtimeId); return { windowId: 'win_1' }; },
    });

    const ref = await driver.createSession({ sessionId: '11111111-1111-4111-8111-111111111111' });

    assert.equal(ref.terminal.status, 'active');
    assert.deepEqual(calls, ['start', 'attachment:rt_1', 'terminal:rt_1']);
  });

  it('终端启动失败时保留 PTY runtime 并记录降级状态', async () => {
    const driver = new ClaudeDriver({
      ptyBroker: createFakeBroker(),
      attachServer: { createAttachment: () => ({ runtimeId: 'rt_1', url: 'ws://127.0.0.1:1234/attach/rt_1?token=secret', token: 'secret' }) },
      openClaudeAttachTerminal: async () => { throw new Error('spawn failed ANTHROPIC_API_KEY=secret123'); },
    });

    const ref = await driver.createSession({ sessionId: '11111111-1111-4111-8111-111111111111' });

    assert.equal(ref.runtimeId, 'rt_1');
    assert.equal(ref.terminal.status, 'failed');
    assert.match(ref.terminal.reason, /spawn failed/);
    assert.doesNotMatch(ref.terminal.reason, /secret123/);
    assert.equal(driver.isSessionRefActive(ref), true);
  });

  it('watchSession 幂等复用已有窗口状态', async () => {
    const driver = new ClaudeDriver({
      ptyBroker: createFakeBroker(),
      attachServer: false,
      openClaudeAttachTerminal: async () => ({ windowId: 'win_once' }),
    });
    const ref = await driver.createSession({ sessionId: '11111111-1111-4111-8111-111111111111' });

    const stop1 = driver.watchSession(ref);
    const stop2 = driver.watchSession(ref);

    assert.equal(typeof stop1, 'function');
    assert.equal(typeof stop2, 'function');
    assert.equal(ref.terminal.status, 'active');
  });

  it('isSessionRefActive 在 broker runtime 丢失时返回 false', async () => {
    const broker = createFakeBroker();
    const driver = new ClaudeDriver({
      ptyBroker: broker,
      attachServer: false,
      openClaudeAttachTerminal: async () => ({ windowId: 'win_once' }),
    });
    const ref = await driver.createSession({ sessionId: '11111111-1111-4111-8111-111111111111' });

    assert.equal(driver.isSessionRefActive(ref), true);
    broker.runtimes.clear();

    assert.equal(driver.isSessionRefActive(ref), false);
  });

  it('walker 退出 detach 前将活跃 Claude runtime 交接到独立 resume 终端', async () => {
    const broker = createFakeBroker();
    const terminalCalls = [];
    const driver = new ClaudeDriver({
      claudeCmd: 'kscc',
      cwd: 'H:\\walker',
      ptyBroker: broker,
      runtime: {
        openTerminal: async (command, args, options) => {
          terminalCalls.push({ command, args, options });
        },
      },
    });
    await driver.createSession({ sessionId: '11111111-1111-4111-8111-111111111111', cwd: 'H:\\walker' });

    await driver.detachAllRuntimes('walker shutdown');

    assert.deepEqual(terminalCalls.map((call) => ({ command: call.command, args: call.args, cwd: call.options.cwd })), [{
      command: 'kscc',
      args: ['--resume', '11111111-1111-4111-8111-111111111111'],
      cwd: 'H:\\walker',
    }]);
    assert.equal(terminalCalls[0].options.env, driver.env);
    assert.deepEqual(broker.calls.detachAllRuntimes, [{ reason: 'walker shutdown' }]);
    assert.equal(broker.listRuntimes().length, 0);
  });

  it('REQ-001-B01/REQ-002-B01/REQ-002-B04/REQ-003-B02: create/resume 共享长期 TUI 启动参数且不包含 print 或 configDir settings', async () => {
    const broker = createFakeBroker();
    const driver = new ClaudeDriver({
      cwd: 'H:\\walker',
      model: 'sonnet',
      fallbackModel: 'opus',
      agent: 'builder',
      permissionMode: 'manual',
      allowedTools: ['Read', 'Grep'],
      disallowedTools: ['Write'],
      tools: ['Read', 'Grep', 'Bash'],
      addDirs: ['H:\\shared'],
      transcriptConfigDir: 'C:\\claude-transcripts',
      settingsFile: 'C:\\claude-settings.json',
      settingSources: ['user', 'project'],
      pluginDirs: ['C:\\claude-plugin'],
      agents: { reviewer: { model: 'opus' } },
      mcpConfigs: ['C:\\mcp-a.json', 'C:\\mcp-b.json'],
      strictMcpConfig: true,
      bare: true,
      disableSlashCommands: true,
      ptyBroker: broker,
    });

    const ref = await driver.createSession({ sessionId: '11111111-1111-4111-8111-111111111111', cwd: 'H:\\walker' });
    await driver.resumeSession(ref);

    const createArgs = broker.calls.createRuntime[0].launchArgs;
    const resumeArgs = broker.calls.resumeRuntime[0].launchArgs;
    assert.deepEqual(createArgs.slice(0, 2), ['--session-id', ref.claudeSessionId]);
    assert.deepEqual(resumeArgs.slice(0, 2), ['--resume', ref.claudeSessionId]);
    assert.deepEqual(createArgs.slice(2), resumeArgs.slice(2));
    assert.equal(createArgs.includes('--print'), false);
    assert.equal(createArgs.includes('stream-json'), false);
    assert.equal(createArgs.includes('C:\\claude-transcripts'), false);
    assert.deepEqual(createArgs, [
      '--session-id', ref.claudeSessionId,
      '--model', 'sonnet',
      '--fallback-model', 'opus',
      '--agent', 'builder',
      '--permission-mode', 'manual',
      '--add-dir', 'H:\\shared',
      '--tools', 'Read,Grep,Bash',
      '--allowed-tools', 'Read,Grep',
      '--disallowed-tools', 'Write',
      '--mcp-config', 'C:\\mcp-a.json',
      '--mcp-config', 'C:\\mcp-b.json',
      '--strict-mcp-config',
      '--settings', 'C:\\claude-settings.json',
      '--setting-sources', 'user,project',
      '--plugin-dir', 'C:\\claude-plugin',
      '--agents', JSON.stringify({ reviewer: { model: 'opus' } }),
      '--bare',
      '--disable-slash-commands',
    ]);
  });

  it('REQ-003-B02/REQ-003-B03/REQ-003-B04/REQ-008-B06: 权限模式 fail-closed 且旧 default 省略 flag', () => {
    const migrated = new ClaudeDriver({ ptyBroker: createFakeBroker(), permissionMode: 'default', permissionModeMigrated: true });
    const args = migrated._buildTerminalArgs({ claudeSessionId: '11111111-1111-4111-8111-111111111111' });
    assert.equal(args.includes('--permission-mode'), false);
    assert.equal(migrated.permissionModeMigrated, true);

    assert.throws(() => new ClaudeDriver({ ptyBroker: createFakeBroker(), permissionMode: 'invalid' }), { code: 'CLAUDE_PERMISSION_MODE_INVALID' });
    assert.throws(() => new ClaudeDriver({ ptyBroker: createFakeBroker(), env: { CLAUDE_PERMISSION_MODE: 'bypassPermissions', CLAUDE_ALLOW_BYPASS_PERMISSIONS: 'false' } }), { code: 'CLAUDE_BYPASS_PERMISSION_CONFIRMATION_REQUIRED' });
    assert.throws(() => new ClaudeDriver({ ptyBroker: createFakeBroker(), permissionMode: 'bypassPermissions', allowBypassPermissions: true, safeMode: true }), { code: 'CLAUDE_PERMISSION_MODE_CONFLICT' });

    const driver = new ClaudeDriver({ ptyBroker: createFakeBroker() });
    assert.throws(() => driver._buildTuiLaunchArgs({
      mode: 'create',
      sessionId: '11111111-1111-4111-8111-111111111111',
      options: { permissionMode: 'bypassPermissions' },
    }), { code: 'CLAUDE_BYPASS_PERMISSION_CONFIRMATION_REQUIRED' });
    assert.throws(() => driver._buildTuiLaunchArgs({
      mode: 'resume',
      sessionId: '11111111-1111-4111-8111-111111111111',
      options: { permissionMode: 'bypassPermissions', allowBypassPermissions: true, safeMode: true },
    }), { code: 'CLAUDE_PERMISSION_MODE_CONFLICT' });
  });

  it('REQ-005-B02/REQ-005-B03: Claude permission 明确 unsupported，question reply 受控写入 PTY', async () => {
    const broker = createFakeBroker();
    const driver = new ClaudeDriver({ ptyBroker: broker });
    const ref = await driver.createSession({ sessionId: '11111111-1111-4111-8111-111111111111', cwd: 'H:\\walker' });

    await assert.rejects(() => driver.replyPermission({}, 'perm_1', 'allow'), (err) => {
      assert.equal(err.code, 'CLAUDE_PERMISSION_REPLY_UNSUPPORTED');
      assert.equal(err.phase, 'preflight');
      assert.equal(err.sdkInvoked, false);
      return true;
    });
    await driver.replyQuestion(ref, 'q_1', [['yes'], ['custom answer']]);
    assert.equal(broker.calls.writeInput.length, 1);
    assert.equal(broker.calls.writeInput[0].runtimeId, ref.runtimeId);
    assert.equal(broker.calls.writeInput[0].options.source, 'feishu-question-reply');
    const written = broker.calls.writeInput[0].data.toString('utf8');
    assert.match(written, /AskUserQuestion q_1/);
    assert.match(written, /1\. yes/);
    assert.match(written, /2\. custom answer/);
    assert.equal(written.endsWith('\r'), true);
  });

  it('question reply 匹配预设选项时写入 TUI 选择键序列', async () => {
    const broker = createFakeBroker();
    const driver = new ClaudeDriver({ ptyBroker: broker });
    const ref = await driver.createSession({ sessionId: '11111111-1111-4111-8111-111111111111', cwd: 'H:\\walker' });

    await driver.replyQuestion(ref, 'q_1', [['比例项太弱']], {
      questions: [{
        question: 'PID 超调原因？',
        options: [
          { label: '积分项导致超调' },
          { label: '比例项太弱' },
          { label: '微分项放大噪声' },
        ],
      }],
    });

    assert.equal(broker.calls.writeInput.length, 1);
    assert.equal(broker.calls.writeInput[0].options.source, 'feishu-question-reply');
    assert.equal(broker.calls.writeInput[0].data.toString('utf8'), '\x1b[B\r');
  });

  it('question reply 在原 runtime 丢失时拒绝提交且不创建重复 Claude 进程', async () => {
    const broker = createFakeBroker();
    broker.writeInput = function (runtimeId, data, options) {
      if (!broker.runtimes.has(runtimeId)) throw new Error('runtime not found: ' + runtimeId);
      broker.calls.writeInput.push({ runtimeId, data: Buffer.from(data), options });
      return Promise.resolve();
    };
    const driver = new ClaudeDriver({ ptyBroker: broker });
    const staleRef = {
      provider: 'claude',
      transport: 'pty-attach',
      runtimeId: 'rt_missing',
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      cwd: 'H:\\walker',
      processGeneration: 1,
    };

    await assert.rejects(
      () => driver.replyQuestion(staleRef, 'q_restore', [['报错']]),
      { code: 'CLAUDE_QUESTION_RUNTIME_UNAVAILABLE' },
    );

    assert.equal(broker.calls.resumeRuntime.length, 0);
    assert.equal(broker.calls.writeInput.length, 0);
  });

  it('listModels 返回 CLI alias 与配置模型，不伪造远端目录', async () => {
    const driver = new ClaudeDriver({ model: 'haiku', fallbackModel: 'opus' });
    const models = await driver.listModels();

    assert.ok(models.some((m) => m.id === 'sonnet' && m.source === 'claude-cli-alias'));
    assert.ok(models.some((m) => m.id === 'opus'));
    assert.ok(models.some((m) => m.id === 'haiku' && m.source === 'config'));
  });
});

describe('ClaudeDriver prompt', () => {
  it('REQ-001-B05: 连续飞书 prompt 始终写入同一 PTY 且不 spawn kscc --print', async () => {
    const broker = createFakeBroker();
    const spawnCalls = [];
    const driver = new ClaudeDriver({
      claudeCmd: 'claude-test',
      model: 'sonnet',
      ptyBroker: broker,
      spawn: (cmd, args, options) => {
        if (args && args.includes('--print')) assert.fail('prompt must not spawn --print');
        spawnCalls.push({ cmd, args, options });
      },
    });
    const ref = await driver.createSession({ sessionId: '11111111-1111-4111-8111-111111111111', cwd: 'H:\\walker' });

    const first = await driver.prompt(ref, 'first');
    const second = await driver.prompt(ref, 'second');

    assert.equal(spawnCalls.length, 0);
    assert.equal(broker.calls.createRuntime.length, 1);
    assert.deepEqual(broker.calls.writeInput.map((call) => call.runtimeId), ['rt_1', 'rt_1']);
    assert.deepEqual(broker.calls.writeInput.map((call) => call.data.toString()), ['first\r', 'second\r']);
    assert.equal(first[0].type, AgentEvent.TYPE_DONE);
    assert.equal(second[0].type, AgentEvent.TYPE_DONE);
  });

  it('飞书 prompt 写入 PTY 后从精确 transcript 返回 Claude 文本', async () => {
    const broker = createFakeBroker();
    const transcriptCalls = [];
    const transcript = {
      createTranscriptCursor(options) {
        transcriptCalls.push({ type: 'cursor', options });
        return { transcriptPath: 'x.jsonl', claudeSessionId: options.claudeSessionId };
      },
      readAssistantTextSince(cursor, options) {
        transcriptCalls.push({ type: 'read', cursor, options });
        return Promise.resolve('assistant answer');
      },
      readAssistantEventsSince(cursor, options) {
        transcriptCalls.push({ type: 'read-events', cursor, options });
        return Promise.resolve([{ type: 'assistant', text: 'assistant answer', model: 'claude-sonnet-4-20250514', contextSize: 125, tokenUsage: { inputTokens: 12, outputTokens: 8, cacheReadTokens: 100, cacheWriteTokens: 5, totalTokens: 125 } }]);
      },
    };
    const driver = new ClaudeDriver({ cwd: 'H:\\walker', ptyBroker: broker, transcript });
    const ref = await driver.createSession({ sessionId: '11111111-1111-4111-8111-111111111111', cwd: 'H:\\walker' });

    const events = await driver.prompt(ref, 'question');

    assert.deepEqual(events.map((event) => event.type), [AgentEvent.TYPE_TEXT, AgentEvent.TYPE_DONE]);
    assert.equal(events[0].data.text, 'assistant answer');
    assert.equal(events[0].data.model, 'claude-sonnet-4-20250514');
    assert.equal(events[0].data.contextSize, 125);
    assert.equal(events[0].data.tokenUsage.totalTokens, 125);
    assert.equal(events[1].data.reason, 'transcript');
    assert.equal(events[1].data.model, 'claude-sonnet-4-20250514');
    assert.equal(events[1].data.contextSize, 125);
    assert.equal(events[1].data.tokenUsage.totalTokens, 125);
    assert.deepEqual(broker.calls.writeInput.map((call) => call.data.toString()), ['question\r']);
    assert.equal(transcriptCalls[0].options.claudeSessionId, ref.claudeSessionId);
  });

  it('watchSession 将 transcript user/assistant/done 事件转发到 watcher handler', () => {
    const broker = createFakeBroker();
    const seen = [];
    let closed = false;
    const transcript = {
      watchClaudeTranscript(options) {
        options.onEvent({ type: 'user', text: 'local input' });
        options.onEvent({
          type: 'assistant',
          text: 'local answer',
          model: 'claude-sonnet-4-20250514',
          contextSize: 125,
          tokenUsage: { inputTokens: 12, outputTokens: 8, cacheReadTokens: 100, cacheWriteTokens: 5, totalTokens: 125 },
        });
        options.onEvent({
          type: 'done',
          model: 'claude-sonnet-4-20250514',
          contextSize: 125,
          tokenUsage: { inputTokens: 12, outputTokens: 8, cacheReadTokens: 100, cacheWriteTokens: 5, totalTokens: 125 },
        });
        return { close: () => { closed = true; } };
      },
    };
    const driver = new ClaudeDriver({ ptyBroker: broker, transcript });
    const ref = { claudeSessionId: '11111111-1111-4111-8111-111111111111', runtimeId: 'rt_1', cwd: 'H:\\walker', terminal: { status: 'active' } };

    const stop = driver.watchSession(ref, { onEvent: (event) => seen.push(event) });
    stop();

    assert.deepEqual(seen.map((event) => event.type), [AgentEvent.TYPE_STATUS, AgentEvent.TYPE_TEXT, AgentEvent.TYPE_DONE]);
    assert.equal(seen[1].data.text, 'local answer');
    assert.equal(seen[1].data.model, 'claude-sonnet-4-20250514');
    assert.equal(seen[1].data.contextSize, 125);
    assert.equal(seen[2].data.reason, 'transcript-watch');
    assert.equal(seen[2].data.model, 'claude-sonnet-4-20250514');
    assert.equal(seen[2].data.tokenUsage.totalTokens, 125);
    assert.equal(closed, true);
  });

  it('REQ-004-B01/REQ-004-B02/REQ-005-B01/REQ-008-B02: watchSession 转发 reasoning、tool、question 和脱敏诊断事件', () => {
    const broker = createFakeBroker();
    const seen = [];
    const logs = [];
    let transcriptLogger = null;
    const transcript = {
      watchClaudeTranscript(options) {
        transcriptLogger = options.logger;
        options.onEvent({ type: 'reasoning', text: 'plan', model: 'claude-sonnet-4-20250514' });
        options.onEvent({ type: 'tool_use', name: 'Read', input: { file: 'a' }, callID: 'toolu_1', phase: 'start', status: 'pending' });
        options.onEvent({ type: 'tool_use', name: 'Read', result: 'ok', output: 'ok', callID: 'toolu_1', phase: 'result', status: 'done', isError: false, orphan: false });
        options.onEvent({ type: 'question_asked', requestID: 'q_1', sessionID: 's_1', questions: [{ question: 'Approve?', header: 'permission', options: [] }], tool: { name: 'Bash' } });
        options.onEvent({ type: 'status', status: 'claude-transcript-diagnostic', diagnostic: { kind: 'bad-json', rawType: 'unknown' } });
        return { close: () => {} };
      },
    };
    const logger = { info: (message, data) => logs.push({ level: 'info', message, data }), warn: (message, data) => logs.push({ level: 'warn', message, data }) };
    const driver = new ClaudeDriver({ ptyBroker: broker, transcript, logger });
    const ref = { claudeSessionId: '11111111-1111-4111-8111-111111111111', runtimeId: 'rt_1', cwd: 'H:\\walker', terminal: { status: 'active' } };

    driver.watchSession(ref, { onEvent: (event) => seen.push(event) })();

    assert.deepEqual(seen.map((event) => event.type), [
      AgentEvent.TYPE_REASONING,
      AgentEvent.TYPE_TOOL_USE,
      AgentEvent.TYPE_TOOL_USE,
      AgentEvent.TYPE_QUESTION_ASKED,
      AgentEvent.TYPE_STATUS,
    ]);
    assert.equal(seen[0].data.text, 'plan');
    assert.equal(seen[1].data.callID, 'toolu_1');
    assert.equal(seen[1].data.phase, 'start');
    assert.equal(seen[2].data.phase, 'result');
    assert.equal(seen[2].data.result, 'ok');
    assert.equal(seen[3].data.requestID, 'q_1');
    assert.equal(seen[3].data.tool.name, 'Bash');
    assert.equal(seen[4].data.diagnostic.kind, 'bad-json');
    assert.equal(transcriptLogger, logger);
    assert.ok(logs.some(log => log.message === 'claude transcript question event forwarded'
      && log.data.requestID === 'q_1'
      && log.data.questionCount === 1));
  });

  it('REQ-003-B01: 飞书 prompt 作为完整不可交错事务写入并只提交一次 Enter', async () => {
    const broker = createFakeBroker();
    const driver = new ClaudeDriver({ ptyBroker: broker });
    const ref = await driver.createSession({ sessionId: '11111111-1111-4111-8111-111111111111' });

    await driver.prompt(ref, 'line1\nline2');

    assert.equal(broker.calls.writeInput.length, 1);
    assert.equal(broker.calls.writeInput[0].data.toString(), 'line1\nline2\r');
    assert.equal((broker.calls.writeInput[0].data.toString().match(/\r/g) || []).length, 1);
    assert.equal(broker.calls.writeInput[0].options.source, 'feishu');
  });

  it('REQ-003-B02: attach broker 输入半行后飞书 prompt 经真实 attach 路径入队', async () => {
    const broker = createFakeBroker();
    const attachServer = {};
    const driver = new ClaudeDriver({ ptyBroker: broker, attachServer });
    const ref = await driver.createSession({ sessionId: '11111111-1111-4111-8111-111111111111' });

    await attachServer.broker.writeInput(ref.runtimeId, Buffer.from('h'), { source: 'attach' });
    const pending = driver.prompt(ref, 'queued');
    await Promise.resolve();

    assert.deepEqual(broker.calls.writeInput.map((call) => call.data.toString()), ['h']);
    assert.deepEqual(broker.calls.writeInput.map((call) => call.options.source), ['attach']);

    await attachServer.broker.writeInput(ref.runtimeId, Buffer.from('\r'), { source: 'attach' });
    const events = await pending;

    assert.deepEqual(broker.calls.writeInput.map((call) => call.data.toString()), ['h', '\r', 'queued\r']);
    assert.deepEqual(broker.calls.writeInput.map((call) => call.options.source), ['attach', 'attach', 'feishu']);
    assert.equal(events[0].type, AgentEvent.TYPE_DONE);
  });

  it('REQ-003-B03: 默认队列 5 条，第 6 条明确拒绝', async () => {
    const broker = createFakeBroker();
    const driver = new ClaudeDriver({ ptyBroker: broker });
    const ref = await driver.createSession({ sessionId: '11111111-1111-4111-8111-111111111111' });
    driver._acquireLocalLease(ref.runtimeId, 'test');

    const queued = [];
    for (let i = 0; i < 5; i += 1) queued.push(driver.prompt(ref, 'q' + i));

    await assert.rejects(() => driver.prompt(ref, 'q5'), (err) => {
      assert.equal(err.code, 'CLAUDE_INPUT_QUEUE_FULL');
      return true;
    });

    driver._releaseLocalLease(ref.runtimeId, 'test');
    await Promise.all(queued);
  });

  it('REQ-003-B04: attach detach/Enter/Ctrl+C 经真实 attach 路径释放 lease 并继续队列', async () => {
    const broker = createFakeBroker();
    const attachServer = {};
    const timers = [];
    const driver = new ClaudeDriver({
      ptyBroker: broker,
      attachServer,
      localLeaseTimeoutMs: 100,
      setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
      clearTimeout: () => {},
    });
    const ref = await driver.createSession({ sessionId: '11111111-1111-4111-8111-111111111111' });

    await attachServer.broker.writeInput(ref.runtimeId, Buffer.from('a'), { source: 'attach' });
    const ctrlQueued = driver.prompt(ref, 'after-ctrl');
    await attachServer.broker.writeInput(ref.runtimeId, Buffer.from('\x03'), { source: 'attach' });
    await ctrlQueued;

    await attachServer.broker.writeInput(ref.runtimeId, Buffer.from('b'), { source: 'attach' });
    const detachQueued = driver.prompt(ref, 'after-detach');
    attachServer.broker.detach(ref.runtimeId);
    await detachQueued;

    await attachServer.broker.writeInput(ref.runtimeId, Buffer.from('c'), { source: 'attach' });
    const timeoutQueued = driver.prompt(ref, 'after-timeout');
    timers[timers.length - 1].fn();
    await timeoutQueued;

    assert.deepEqual(broker.calls.writeInput.map((call) => call.data.toString()), [
      'a', '\x03', 'after-ctrl\r', 'b', 'after-detach\r', 'c', 'after-timeout\r',
    ]);
  });

  it('REQ-003-B05: busy/permission 状态下飞书普通文本不得直接写 PTY', async () => {
    const broker = createFakeBroker();
    const driver = new ClaudeDriver({ ptyBroker: broker });
    const ref = await driver.createSession({ sessionId: '11111111-1111-4111-8111-111111111111' });

    driver._setRuntimeBusy(ref.runtimeId, true);
    const pending = driver.prompt(ref, 'queued-busy');
    await Promise.resolve();

    assert.equal(broker.calls.writeInput.length, 0);

    driver._setRuntimeBusy(ref.runtimeId, false);
    await pending;

    driver._setPermissionState(ref.runtimeId, true);
    const permissionPending = driver.prompt(ref, 'queued-permission');
    await Promise.resolve();

    assert.equal(broker.calls.writeInput.length, 1);

    driver._setPermissionState(ref.runtimeId, false);
    await permissionPending;
    assert.deepEqual(broker.calls.writeInput.map((call) => call.data.toString()), ['queued-busy\r', 'queued-permission\r']);
  });

  it('REQ-003-B06: 空白、超长、非字符串 prompt 稳定拒绝且不写 PTY', async () => {
    const broker = createFakeBroker();
    const driver = new ClaudeDriver({ ptyBroker: broker, maxPromptLength: 5 });
    const ref = await driver.createSession({ sessionId: '11111111-1111-4111-8111-111111111111' });

    await assert.rejects(() => driver.prompt(ref, 1), { code: 'CLAUDE_PROMPT_INVALID' });
    await assert.rejects(() => driver.prompt(ref, '   '), { code: 'CLAUDE_PROMPT_EMPTY' });
    await assert.rejects(() => driver.prompt(ref, '123456'), { code: 'CLAUDE_PROMPT_TOO_LONG' });

    assert.equal(broker.calls.writeInput.length, 0);
  });

  it('REQ-003-B07: 队列事件驱动 drain，空闲时不使用忙轮询', async () => {
    const broker = createFakeBroker();
    let intervalCount = 0;
    const driver = new ClaudeDriver({
      ptyBroker: broker,
      setInterval: () => { intervalCount += 1; throw new Error('busy polling forbidden'); },
    });
    const ref = await driver.createSession({ sessionId: '11111111-1111-4111-8111-111111111111' });

    driver._setRuntimeBusy(ref.runtimeId, true);
    const pending = driver.prompt(ref, 'queued');
    await Promise.resolve();
    driver._setRuntimeBusy(ref.runtimeId, false);
    await pending;

    assert.equal(intervalCount, 0);
    assert.equal(broker.calls.writeInput[0].data.toString(), 'queued\r');
  });

  it('stop 和 delete 幂等调用 broker stopRuntime/deleteRuntime', async () => {
    const broker = createFakeBroker();
    const driver = new ClaudeDriver({ ptyBroker: broker });
    const ref = await driver.createSession({ sessionId: '11111111-1111-4111-8111-111111111111' });

    await driver.stop(ref);
    await driver.delete(ref);

    assert.deepEqual(broker.calls.stopRuntime.map((call) => call.runtimeId), ['rt_1', 'rt_1']);
    assert.deepEqual(broker.calls.deleteRuntime.map((call) => call.runtimeId), ['rt_1']);
  });

  it('无 pending prompt 时 stop 仍更新终端状态诊断', async () => {
    const driver = new ClaudeDriver({ ptyBroker: createFakeBroker() });
    const ref = await driver.createSession({ sessionId: '11111111-1111-4111-8111-111111111111' });

    await driver.stop(ref);

    assert.equal(ref.terminal.status, 'stopped');
    assert.equal(driver.isSessionRefActive(ref), false);
  });
});

describe('ClaudeDriver listSessions', () => {
  it('无 cwd 时扫描全部项目目录(listAllClaudeSessions)并按 updatedAt 倒序', async () => {
    const broker = createFakeBroker();
    const listCalls = [];
    const transcript = {
      listAllClaudeSessions({ configDir }) { listCalls.push({ configDir }); return [
        { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'b', status: 'idle', cwd: 'H:\\other', updatedAt: 200 },
        { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'a', status: 'idle', cwd: 'H:\\walker', updatedAt: 100 },
      ]; },
    };
    const driver = new ClaudeDriver({ cwd: 'H:\\walker', ptyBroker: broker, transcript, configDir: 'C:\\cfg' });
    const sessions = await driver.listSessions({ extraCwds: ['H:\\other'] });
    assert.deepEqual(listCalls, [{ configDir: 'C:\\cfg' }]);
    assert.deepEqual(sessions.map((s) => s.id), ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']);
  });

  it('传入 cwd 时仅扫描该 cwd 并透传 configDir', async () => {
    const broker = createFakeBroker();
    const listCalls = [];
    const transcript = {
      listClaudeSessionsForCwd({ cwd, configDir }) { listCalls.push({ cwd, configDir }); return []; },
    };
    const driver = new ClaudeDriver({ cwd: 'H:\\walker', ptyBroker: broker, transcript, configDir: 'C:\\cfg' });
    await driver.listSessions({ cwd: 'H:\\only' });
    assert.deepEqual(listCalls, [{ cwd: 'H:\\only', configDir: 'C:\\cfg' }]);
  });

  it('transcript 为 null 时 fallback defaultTranscript 扫描全部项目目录并还原 cwd', async () => {
    const broker = createFakeBroker();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-claude-driver-'));
    const cwd = path.join(root, 'workspace');
    const configDir = path.join(root, 'claude-config');
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    const realCwd = fs.realpathSync.native(cwd);
    const projectDirName = encodeClaudeProjectPath(realCwd);
    const projectDir = path.join(configDir, 'projects', projectDirName);
    fs.mkdirSync(projectDir, { recursive: true });
    const uuid = '11111111-1111-4111-8111-111111111111';
    fs.writeFileSync(path.join(projectDir, uuid + '.jsonl'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, cwd: realCwd, timestamp: '2026-08-06T10:00:00.000Z' }) + '\n');
    const driver = new ClaudeDriver({ cwd, ptyBroker: broker, transcript: null, configDir });
    const sessions = await driver.listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, uuid);
    assert.equal(sessions[0].cwd, realCwd, 'cwd 无损还原');
  });
});

describe('mapClaudeLine', () => {
  it('映射 reasoning、tool_use、tool_result 和未知事件', () => {
    assert.equal(mapClaudeLine('{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"plan"}]}}').type, AgentEvent.TYPE_REASONING);
    assert.equal(mapClaudeLine('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file":"a"}}]}}').type, AgentEvent.TYPE_TOOL_USE);
    assert.equal(mapClaudeLine('{"type":"assistant","message":{"content":[{"type":"tool_result","content":"ok"}]}}').data.status, 'done');
    assert.equal(mapClaudeLine('{"type":"new_event"}').type, AgentEvent.TYPE_STATUS);
  });

  it('stream-json AskUserQuestion tool_use 映射为原生问题事件', () => {
    const line = JSON.stringify({
      type: 'assistant',
      session_id: '11111111-1111-4111-8111-111111111111',
      message: {
        content: [{
          type: 'tool_use',
          id: 'call_stream_question',
          name: 'AskUserQuestion',
          input: {
            prompt: 'SECRET=abc',
            questions: [{
              header: '下一步',
              question: '你要选择什么？',
              multiSelect: true,
              options: [{ label: 'A', description: '说明 SECRET=abc' }],
            }],
          },
        }],
      },
    });
    const event = mapClaudeLine(line);
    assert.equal(event.type, AgentEvent.TYPE_QUESTION_ASKED);
    assert.equal(event.data.requestID, 'call_stream_question');
    assert.equal(event.data.sessionID, '11111111-1111-4111-8111-111111111111');
    assert.equal(event.data.questions[0].question, '你要选择什么？');
    assert.equal(event.data.questions[0].multiple, true);
    assert.equal(event.data.questions[0].options[0].description, '说明 SECRET=[redacted]');
    assert.doesNotMatch(JSON.stringify(event.data), /SECRET=abc/);
  });
});
