const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { AgentEvent } = require('../src/drivers/agent-driver');
const { ClaudeDriver } = require('../src/drivers/claude-driver');
const { ClaudePtyBroker } = require('../src/drivers/claude-pty-broker');
const { OpencodeDriver } = require('../src/drivers/opencode-driver');
const { listProviderCatalog } = require('../src/providers/provider-catalog');

function createFakeBroker() {
  const calls = { createRuntime: [], resumeRuntime: [], writeInput: [], stopRuntime: [], deleteRuntime: [], detachAllRuntimes: [] };
  const runtimes = new Map();
  return {
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
    writeInput(runtimeId, data, options) {
      calls.writeInput.push({ runtimeId, data: Buffer.from(data), options });
      return Promise.resolve();
    },
    stopRuntime(runtimeId, reason) {
      calls.stopRuntime.push({ runtimeId, reason });
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
}

function createFakeBridge() {
  const calls = { getRuntime: [], writeInput: [] };
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
  };
}

function createTranscript(events, sessions) {
  const calls = { cursor: [], read: [], watch: [], listAll: [], listCwd: [] };
  return {
    calls,
    createTranscriptCursor(options) {
      calls.cursor.push(options);
      return { claudeSessionId: options.claudeSessionId, transcriptPath: 'session.jsonl' };
    },
    readAssistantEventsSince(cursor) {
      calls.read.push(cursor);
      return Promise.resolve(events || [{ type: 'assistant', text: 'plain answer' }]);
    },
    watchClaudeTranscript(options) {
      calls.watch.push(options);
      for (const event of events || []) options.onEvent(event);
      return { close() {} };
    },
    listAllClaudeSessions(options) {
      calls.listAll.push(options);
      return sessions || [];
    },
    listClaudeSessionsForCwd(options) {
      calls.listCwd.push(options);
      return sessions || [];
    },
  };
}

function createFakePty(spawns) {
  return {
    spawn(command, args, options) {
      const proc = {
        writes: [],
        onData() { return { dispose() {} }; },
        onExit() { return { dispose() {} }; },
        write(data) { this.writes.push(Buffer.from(data)); },
        kill() {},
      };
      spawns.push({ command, args: args.slice(), options, proc });
      return proc;
    },
  };
}

for (const command of ['claude', 'kscc']) {
  describe('Claude TUI command parity: ' + command, () => {
    it('REQ-007-B01/REQ-007-B03/REQ-007-B04: create/resume/prompt 使用单 PTY TUI 且保留 endpoint 与认证环境', async () => {
      const spawns = [];
      const broker = new ClaudePtyBroker({
        command,
        cwd: 'H:\\walker',
        env: {
          ANTHROPIC_BASE_URL: 'https://custom.example.invalid',
          ANTHROPIC_API_KEY: 'secret-api-key',
          KSCC_TOKEN: 'secret-kscc-token',
        },
        ptyFactory: createFakePty(spawns),
        idFactory: () => 'rt_' + (spawns.length + 1),
      });
      const transcript = createTranscript([{ type: 'assistant', text: 'ok' }]);
      const driver = new ClaudeDriver({
        cwd: 'H:\\walker',
        env: {
          ANTHROPIC_BASE_URL: 'https://custom.example.invalid',
          ANTHROPIC_API_KEY: 'secret-api-key',
          KSCC_TOKEN: 'secret-kscc-token',
        },
        ptyBroker: broker,
        transcript,
        attachServer: false,
        openClaudeAttachTerminal: async () => ({ windowId: 'initial-window' }),
      });

      const ref = await driver.createSession({ sessionId: '11111111-1111-4111-8111-111111111111', cwd: 'H:\\walker' });
      await driver.prompt(ref, 'hello from ' + command);
      const resumed = await driver.resumeSession(ref);
      await driver.prompt(resumed, 'after resume');

      assert.equal(spawns.length, 2);
      assert.deepEqual(spawns.map((spawn) => spawn.command), [command, command]);
      assert.deepEqual(spawns[0].args.slice(0, 2), ['--session-id', ref.claudeSessionId]);
      assert.deepEqual(spawns[1].args.slice(0, 2), ['--resume', ref.claudeSessionId]);
      const allArgs = spawns.flatMap((spawn) => spawn.args);
      assert.equal(allArgs.includes('--print'), false);
      assert.equal(allArgs.includes('--background'), false);
      assert.equal(allArgs.includes('--bg'), false);
      assert.equal(allArgs.includes('--remote-control'), false);
      assert.equal(allArgs.includes('stream-json'), false);
      assert.deepEqual(spawns.flatMap((spawn) => spawn.proc.writes.map((item) => item.toString())), ['hello from ' + command + '\r', 'after resume\r']);
      assert.equal(spawns[0].options.env.ANTHROPIC_BASE_URL, 'https://custom.example.invalid');
      assert.equal(spawns[0].options.env.ANTHROPIC_API_KEY, 'secret-api-key');
      assert.equal(spawns[0].options.env.KSCC_TOKEN, 'secret-kscc-token');
      assert.equal(spawns[1].options.env.ANTHROPIC_BASE_URL, 'https://custom.example.invalid');
      assert.doesNotMatch(JSON.stringify(ref), /secret-api-key|secret-kscc-token|custom\.example/i);
      assert.doesNotMatch(JSON.stringify(resumed), /secret-api-key|secret-kscc-token|custom\.example/i);
    });
  });
}

describe('Claude/OpenCode tool parity integration', () => {
  it('REQ-001-B03/REQ-001-B04/REQ-002-B05/REQ-004-B06/REQ-006-B05/REQ-008-B05/REQ-008-B06: 完整配置、多轮 prompt、resume 和 transcript 边界保持安全兼容', async () => {
    const broker = createFakeBroker();
    const transcript = createTranscript([{ type: 'assistant', text: 'plain answer' }]);
    const driver = new ClaudeDriver({
      cwd: 'H:\\walker',
      model: 'sonnet',
      permissionMode: 'default',
      permissionModeMigrated: true,
      tools: ['Read', 'Grep'],
      allowedTools: ['Read'],
      disallowedTools: ['Write'],
      transcriptConfigDir: 'C:\\claude-transcripts-SECRET_SENTINEL',
      settingsFile: 'C:\\claude-settings.json',
      settingSources: ['user', 'project'],
      mcpConfigs: ['C:\\mcp.json'],
      pluginDirs: ['C:\\plugin'],
      agents: { reviewer: { model: 'opus' } },
      ptyBroker: broker,
      transcript,
      attachServer: false,
      openClaudeAttachTerminal: async () => ({ windowId: 'win_1' }),
    });

    const ref = await driver.createSession({ sessionId: '11111111-1111-4111-8111-111111111111', cwd: 'H:\\walker' });
    const first = await driver.prompt(ref, 'first');
    const second = await driver.prompt(ref, 'second');
    const resumed = await driver.resumeSession(ref);

    assert.deepEqual(first.map((event) => event.type), [AgentEvent.TYPE_TEXT, AgentEvent.TYPE_DONE]);
    assert.equal(first[0].data.text, 'plain answer');
    assert.equal(second[0].data.text, 'plain answer');
    assert.equal(broker.calls.createRuntime.length, 1);
    assert.equal(broker.calls.writeInput.length, 2);
    assert.deepEqual(broker.calls.writeInput.map((call) => call.data.toString()), ['first\r', 'second\r']);
    assert.equal(broker.calls.resumeRuntime.length, 1);
    assert.equal(resumed.runtimeId, 'rt_1');

    const createArgs = broker.calls.createRuntime[0].launchArgs;
    const resumeArgs = broker.calls.resumeRuntime[0].launchArgs;
    assert.deepEqual(createArgs.slice(0, 2), ['--session-id', ref.claudeSessionId]);
    assert.deepEqual(resumeArgs.slice(0, 2), ['--resume', ref.claudeSessionId]);
    assert.deepEqual(createArgs.slice(2), resumeArgs.slice(2));
    assert.equal(createArgs.includes('--print'), false);
    assert.equal(createArgs.includes('stream-json'), false);
    assert.equal(createArgs.includes('--permission-mode'), false);
    assert.equal(createArgs.includes('C:\\claude-transcripts-SECRET_SENTINEL'), false);
    assert.ok(createArgs.includes('--settings'));
    assert.equal(transcript.calls.cursor[0].configDir, 'C:\\claude-transcripts-SECRET_SENTINEL');
    assert.doesNotMatch(JSON.stringify(ref), /SECRET_SENTINEL/);
  });

  it('REQ-003-B05/REQ-003-B06/REQ-005-B04/REQ-005-B05/REQ-005-B06: Claude 能力降级明确且 question reply 受控写入 PTY，OpenCode 保持支持', async () => {
    const broker = createFakeBroker();
    const claudeDriver = new ClaudeDriver({ ptyBroker: broker });
    const providers = new Map(listProviderCatalog().map((provider) => [provider.id, provider]));
    const opencodeHttpCalls = [];
    const opencodeDriver = new OpencodeDriver({
      serverUrl: 'http://localhost:4096',
      autostart: false,
      httpClient: {
        request: async (method, url, body) => {
          opencodeHttpCalls.push({ method, url, body });
          return { status: 200, data: { ok: true } };
        },
      },
    });

    await assert.rejects(() => claudeDriver.replyPermission({ runtimeId: 'rt_1' }, 'perm_1', 'allow'), (err) => {
      assert.equal(err.code, 'CLAUDE_PERMISSION_REPLY_UNSUPPORTED');
      assert.equal(err.phase, 'preflight');
      assert.equal(err.sdkInvoked, false);
      return true;
    });
    await claudeDriver.createSession({ sessionId: '11111111-1111-4111-8111-111111111111', cwd: 'H:\\walker' });
    await claudeDriver.replyQuestion({ runtimeId: 'rt_1', claudeSessionId: '11111111-1111-4111-8111-111111111111', transport: 'pty-attach' }, 'q_1', [['yes']]);
    await opencodeDriver.replyPermission({ opencodeSessionId: 'ses_1' }, 'perm_1', 'allow', false);

    assert.equal(broker.calls.writeInput.length, 1);
    assert.match(broker.calls.writeInput[0].data.toString('utf8'), /AskUserQuestion q_1/);
    assert.equal(providers.get('claude').capabilities.permissions, false);
    assert.equal(providers.get('claude').capabilities.questionReply, true);
    assert.equal(providers.get('claude').capabilityStatus.permissions.status, 'degraded');
    assert.equal(providers.get('claude').capabilityStatus.questionReply.status, 'degraded');
    assert.equal(providers.get('opencode').capabilities.permissions, true);
    assert.equal(providers.get('opencode').capabilities.questionReply, true);
    assert.equal(opencodeHttpCalls.length, 1);
    assert.match(opencodeHttpCalls[0].url, /\/session\/ses_1\/permissions\/perm_1$/);
    assert.deepEqual(opencodeHttpCalls[0].body, { response: 'allow', remember: false });
  });

  it('REQ-007-B01/REQ-007-B02/REQ-007-B03/REQ-007-B04/REQ-007-B05: 历史列表、sidecar reuse、lease 和停止语义不破坏 OpenCode', async () => {
    const broker = createFakeBroker();
    const bridge = createFakeBridge();
    const transcript = createTranscript([], [{ id: 'claude-session', cwd: 'H:\\walker', updatedAt: 10 }]);
    bridge.runtimes.set('rt_bridge', {
      runtimeId: 'rt_bridge',
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      status: 'walker-disconnected',
      reconnectable: true,
      processGeneration: 7,
      cwd: 'H:\\walker',
      connectionState: 'reconnectable',
    });
    const driver = new ClaudeDriver({ cwd: 'H:\\walker', ptyBroker: broker, claudeBridge: bridge, transcript });
    const ref = await driver.resumeSession({
      provider: 'claude',
      transport: 'bridge-sidecar',
      runtimeId: 'rt_bridge',
      claudeSessionId: '11111111-1111-4111-8111-111111111111',
      processGeneration: 7,
      cwd: 'H:\\walker',
    });

    await driver.prompt(ref, 'after reconnect');
    await driver.stopWalkerConnection('walker shutdown');
    const allSessions = await driver.listSessions();
    const cwdSessions = await driver.listSessions({ cwd: 'H:\\walker' });

    assert.equal(ref.transport, 'bridge-sidecar');
    assert.equal(ref.runtimeId, 'rt_bridge');
    assert.equal(ref.connectionState, 'reconnectable');
    assert.equal(broker.calls.resumeRuntime.length, 0);
    assert.equal(broker.calls.createRuntime.length, 0);
    assert.deepEqual(bridge.calls.writeInput.map((call) => call.data.toString()), ['after reconnect\r']);
    assert.deepEqual(broker.calls.stopRuntime, []);
    assert.deepEqual(allSessions, [{ id: 'claude-session', cwd: 'H:\\walker', updatedAt: 10 }]);
    assert.deepEqual(cwdSessions, [{ id: 'claude-session', cwd: 'H:\\walker', updatedAt: 10 }]);
    assert.equal(transcript.calls.listAll.length, 1);
    assert.equal(transcript.calls.listCwd[0].cwd, 'H:\\walker');

    const opencodeDriver = new OpencodeDriver({
      serverUrl: 'http://localhost:4096',
      autostart: false,
      httpClient: { request: async () => ({ status: 200, data: [] }) },
    });
    assert.equal(typeof opencodeDriver.listSessions, 'function');
    assert.equal(typeof opencodeDriver.replyPermission, 'function');
  });
});
