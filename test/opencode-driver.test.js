const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { AgentDriver } = require('../src/drivers/agent-driver');
const { DriverRegistry } = require('../src/drivers/driver-registry');
const { OpencodeDriver } = require('../src/drivers/opencode-driver');
const { OpencodeTuiBridge } = require('../src/opencode-tui-bridge/bridge');
const { stubClaudeDriver, stubCodexDriver } = require('../src/drivers/stub-drivers');

class FakeHttpClient {
  constructor(responses, onRequest) {
    this.responses = responses;
    this.onRequest = onRequest;
    this.calls = [];
    this.callCount = {};
  }
  async request(method, url, body) {
    this.calls.push({ method, url, body });
    if (this.onRequest) this.onRequest(method, url, body);
    const key = method + ' ' + url;
    const resp = this.responses[key] || { status: 200, data: {} };
    if (resp.error) throw resp.error;
    return resp;
  }
}

class FakeSSEClient {
  constructor(events) {
    this.events = events;
    this.calls = [];
  }
  async connect(url, options) {
    this.calls.push({ url, options });
    if (options && options.onOpen) options.onOpen({ statusCode: 200 });
    if (options && options.onEvent) {
      for (const event of this.events) options.onEvent(event, this.events);
    }
    return this.events;
  }
}

describe('DriverRegistry', () => {
  it('注册 opencode driver', () => {
    const reg = new DriverRegistry();
    const driver = new OpencodeDriver({ serverUrl: 'http://localhost:4096' });
    reg.register('opencode', driver);
    assert.equal(reg.get('opencode'), driver);
  });

  it('获取未注册 driver 返回 null', () => {
    const reg = new DriverRegistry();
    assert.equal(reg.get('unknown'), null);
  });

  it('列出已注册 driver', () => {
    const reg = new DriverRegistry();
    reg.register('opencode', new OpencodeDriver({ serverUrl: 'http://localhost:4096' }));
    reg.register('claude', stubClaudeDriver());
    const list = reg.list();
    assert.deepEqual(list, ['opencode', 'claude']);
  });
});

describe('Stub drivers', () => {
  it('claude stub 的所有方法抛未实现错误含 agent 名', async () => {
    const d = stubClaudeDriver();
    await assert.rejects(() => d.createSession({}), { message: /claude/i });
    await assert.rejects(() => d.prompt({ opencodeSessionId: 's' }, 'text'), { message: /claude/i });
    await assert.rejects(() => d.stop({ opencodeSessionId: 's' }), { message: /claude/i });
    await assert.rejects(() => d.delete({ opencodeSessionId: 's' }), { message: /claude/i });
  });

  it('codex stub 的所有方法抛未实现错误含 agent 名', async () => {
    const d = stubCodexDriver();
    await assert.rejects(() => d.createSession({}), { message: /codex/i });
    await assert.rejects(() => d.prompt({ opencodeSessionId: 's' }, 'text'), { message: /codex/i });
  });
});

describe('OpencodeDriver ensureReady', () => {
  it('server 已可用时直接返回', async () => {
    const http = new FakeHttpClient({ 'GET http://localhost:4096/health': { status: 200, data: { ok: true } } });
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096', autostart: false });
    const result = await driver.ensureReady();
    assert.equal(result, true);
  });

  it('server 不可用且 autostart=true 时自动启动并在后续健康检查通过', async () => {
    let healthCallIndex = 0;
    const http = {
      calls: [],
      async request(method, url, body) {
        this.calls.push({ method, url, body });
        if (url === 'http://localhost:4096/health') {
          healthCallIndex++;
          if (healthCallIndex > 1) return { status: 200, data: { ok: true } };
          throw new Error('ECONNREFUSED');
        }
        return { status: 200, data: {} };
      },
    };
    const spawnCalls = [];
    const driver = new OpencodeDriver({
      httpClient: http,
      serverUrl: 'http://localhost:4096',
      autostart: true,
      runtime: { spawn: (cmd, args, _opts) => { spawnCalls.push({ cmd, args }); return { pid: 999, kill: () => {}, unref: () => {} }; } },
      pollInterval: 10,
      maxPolls: 5,
    });
    const result = await driver.ensureReady();
    assert.equal(result, true);
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].cmd, 'opencode');
    assert.ok(spawnCalls[0].args.includes('serve'));
  });

  it('server 不可用且 autostart=false 时抛错含诊断信息', async () => {
    const http = new FakeHttpClient({ 'GET http://localhost:4096/health': { error: new Error('ECONNREFUSED') } });
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096', autostart: false });
    await assert.rejects(() => driver.ensureReady(), { message: /opencode server|ECONNREFUSED|serverUrl/i });
  });
});

describe('OpencodeDriver createSession', () => {
  it('调用 POST /session 创建 opencode session 并调用 runtime.openTerminal', async () => {
    const http = new FakeHttpClient({
      'POST http://localhost:4096/session?directory=%2Fhome%2Fuser%2Fproject': {
        status: 201,
        id: 'ses_abc123', title: 'walker session',
        // eslint-disable-next-line no-dupe-keys
        status: 'pending',
      },
    });
    const openTerminalCalls = [];
    const runtime = {
      spawn: () => ({ pid: 999, unref: () => {} }),
      openTerminal: async (cmd, args, opts) => {
        openTerminalCalls.push({ cmd, args, opts });
      },
    };
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096', runtime });
    const result = await driver.createSession({ title: 'walker session', cwd: '/home/user/project' });
    assert.equal(result.opencodeSessionId, 'ses_abc123');
    assert.equal(result.serverUrl, 'http://localhost:4096');
    assert.equal(result.cwd, '/home/user/project');
    assert.equal(http.calls[0].body.cwd, undefined);
    assert.equal(openTerminalCalls.length, 1);
    assert.equal(openTerminalCalls[0].cmd, 'opencode');
    assert.deepEqual(openTerminalCalls[0].args, [
      'attach',
      'http://localhost:4096',
      '-s',
      'ses_abc123',
      '--dir',
      '/home/user/project',
    ]);
    assert.equal(openTerminalCalls[0].opts.cwd, '/home/user/project');
  });

  it('runtime 不支持 openTerminal 时跳过，不报错', async () => {
    const http = new FakeHttpClient({
      'POST http://localhost:4096/session?directory=%2Fhome%2Fuser%2Fproject': {
        status: 201,
        id: 'ses_abc123', title: 'walker session',
        // eslint-disable-next-line no-dupe-keys
        status: 'pending',
      },
    });
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096', runtime: { spawn: () => ({}) } });
    const result = await driver.createSession({ title: 'walker session', cwd: '/home/user/project' });
    assert.equal(result.opencodeSessionId, 'ses_abc123');
  });

  it('没有 runtime 时跳过 openTerminal，不报错', async () => {
    const http = new FakeHttpClient({
      'POST http://localhost:4096/session?directory=%2Fhome%2Fuser%2Fproject': {
        status: 201,
        id: 'ses_abc123', title: 'walker session',
        // eslint-disable-next-line no-dupe-keys
        status: 'pending',
      },
    });
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096' });
    const result = await driver.createSession({ title: 'walker session', cwd: '/home/user/project' });
    assert.equal(result.opencodeSessionId, 'ses_abc123');
  });

  it('openTerminal 失败时不影响 createSession 结果', async () => {
    const http = new FakeHttpClient({
      'POST http://localhost:4096/session?directory=%2Fhome%2Fuser%2Fproject': {
        status: 201,
        id: 'ses_abc123', title: 'walker session',
        // eslint-disable-next-line no-dupe-keys
        status: 'pending',
      },
    });
    const runtime = {
      spawn: () => ({ pid: 999, unref: () => {} }),
      openTerminal: async () => { throw new Error('terminal failed'); },
    };
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096', runtime });
    const result = await driver.createSession({ title: 'walker session', cwd: '/home/user/project' });
    assert.equal(result.opencodeSessionId, 'ses_abc123');
  });

  it('创建失败时抛错含 serverUrl', async () => {
    const http = new FakeHttpClient({
      ['POST http://localhost:4096/session?directory=' + encodeURIComponent(process.cwd())]: { error: new Error('Internal Server Error') },
    });
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096' });
    await assert.rejects(() => driver.createSession({}), { message: /serverUrl|opencode/i });
  });

  it('非 2xx 响应时抛出诊断错误且不打开终端', async () => {
    const http = new FakeHttpClient({
      'POST http://localhost:4096/session?directory=%2Fhome%2Fuser%2Fproject': {
        status: 500,
        data: { error: 'database unavailable' },
      },
    });
    const openTerminalCalls = [];
    const runtime = {
      openTerminal: async (cmd, args, opts) => openTerminalCalls.push({ cmd, args, opts }),
    };
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096', runtime });

    await assert.rejects(
      () => driver.createSession({ title: 'walker session', cwd: '/home/user/project' }),
      { message: /Failed to create opencode session|HTTP 500|http:\/\/localhost:4096|database unavailable/ },
    );
    assert.equal(openTerminalCalls.length, 0);
  });

  it('2xx 响应缺少 session id 时抛出诊断错误且不打开终端', async () => {
    const http = new FakeHttpClient({
      'POST http://localhost:4096/session?directory=%2Fhome%2Fuser%2Fproject': {
        status: 201,
        data: { title: 'walker session' },
      },
    });
    const openTerminalCalls = [];
    const runtime = {
      openTerminal: async (cmd, args, opts) => openTerminalCalls.push({ cmd, args, opts }),
    };
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096', runtime });

    await assert.rejects(
      () => driver.createSession({ title: 'walker session', cwd: '/home/user/project' }),
      { message: /Failed to create opencode session|missing session id|http:\/\/localhost:4096|walker session/ },
    );
    assert.equal(openTerminalCalls.length, 0);
  });
});

describe('OpencodeDriver prompt with SSE', () => {
  const sessionRef = { opencodeSessionId: 'ses_abc', serverUrl: 'http://localhost:4096', cwd: '/home/user/project' };

  it('tui-bridge session 委托本地 TUI bridge，不访问 HTTP 或 SSE', async () => {
    const calls = [];
    const bridge = {
      prompt: async (ref, text, options) => {
        calls.push({ method: 'prompt', ref, text, options });
        return [new (require('../src/drivers/agent-driver').AgentEvent)('done', { reason: 'idle' })];
      },
      watchSession: (ref, handlers) => {
        calls.push({ method: 'watchSession', ref, handlers });
        return () => {};
      },
      stop: async (ref) => { calls.push({ method: 'stop', ref }); },
      cancel: async (ref) => { calls.push({ method: 'cancel', ref }); },
      delete: async (ref) => { calls.push({ method: 'delete', ref }); },
    };
    const http = new FakeHttpClient({});
    const sse = new FakeSSEClient([]);
    const driver = new OpencodeDriver({ httpClient: http, sseClient: sse, serverUrl: 'http://localhost:4096', tuiBridge: bridge });
    const ref = { opencodeSessionId: 'ses_local', transport: 'tui-bridge', runtimeId: 'runtime-1' };

    await driver.prompt(ref, 'hello', { model: 'm1' });
    const stopWatch = driver.watchSession(ref, { onEvent: () => {} });
    await driver.stop(ref);
    await driver.cancel(ref);
    await driver.delete(ref);
    stopWatch();

    assert.deepEqual(calls.map((call) => call.method), ['prompt', 'watchSession', 'stop', 'cancel', 'delete']);
    assert.equal(http.calls.length, 0);
    assert.equal(sse.calls.length, 0);
  });

  it('prompt 发送消息并通过 SSE 接收事件映射为 AgentEvent', async () => {
    const sseEvents = [
      { type: 'message.part.updated', properties: { sessionID: 'ses_abc', part: { type: 'text', text: 'Hello world' } } },
      { type: 'message.part.updated', properties: { sessionID: 'ses_abc', part: { type: 'tool-use', name: 'Bash', state: 'completed', input: 'ls -la' } } },
      { type: 'session.status', properties: { sessionID: 'ses_abc', status: { type: 'idle' } } },
    ];
    const http = new FakeHttpClient({});
    const sse = new FakeSSEClient(sseEvents);
    const driver = new OpencodeDriver({ httpClient: http, sseClient: sse, serverUrl: 'http://localhost:4096' });

    const events = await driver.prompt(sessionRef, '请帮我分析代码');

    assert.equal(http.calls[0].url, 'http://localhost:4096/session/ses_abc/prompt_async?directory=%2Fhome%2Fuser%2Fproject');
    assert.equal(sse.calls.length, 1);
    assert.equal(sse.calls[0].url, 'http://localhost:4096/event?directory=%2Fhome%2Fuser%2Fproject');
    assert.equal(typeof sse.calls[0].options.shouldClose, 'function');
    assert.equal(sse.calls[0].options.idleTimeoutMs, 300000);
    assert.equal(events.length, 3);
    assert.equal(events[0].type, 'text');
    assert.equal(events[0].data.text, 'Hello world');
    assert.equal(events[1].type, 'tool_use');
    assert.equal(events[1].data.name, 'Bash');
    assert.equal(events[2].type, 'done');
  });

  it('prompt 和 SSE 使用 sessionRef 指定的 OpenCode 服务', async () => {
    const remoteRef = { ...sessionRef, serverUrl: 'http://127.0.0.1:54321' };
    const sseEvents = [
      { type: 'session.status', properties: { sessionID: 'ses_abc', status: { type: 'idle' } } },
    ];
    const http = new FakeHttpClient({});
    const sse = new FakeSSEClient(sseEvents);
    const driver = new OpencodeDriver({ httpClient: http, sseClient: sse, serverUrl: 'http://localhost:4096' });

    await driver.prompt(remoteRef, 'hello');

    assert.equal(http.calls[0].url, 'http://127.0.0.1:54321/session/ses_abc/prompt_async?directory=%2Fhome%2Fuser%2Fproject');
    assert.equal(sse.calls[0].url, 'http://127.0.0.1:54321/event?directory=%2Fhome%2Fuser%2Fproject');
  });

  it('先建立 SSE 订阅再提交 prompt，避免错过短生命周期事件', async () => {
    const order = [];
    const http = new FakeHttpClient({}, (method) => { if (method === 'POST') order.push('post'); });
    const sse = {
      calls: [],
      async connect(url, options) {
        this.calls.push({ url, options });
        order.push('sse');
        if (options.onOpen) options.onOpen({ statusCode: 200 });
        return [{ type: 'session.status', properties: { sessionID: 'ses_abc', status: { type: 'idle' } } }];
      },
    };
    const driver = new OpencodeDriver({
      httpClient: http,
      sseClient: sse,
      serverUrl: 'http://localhost:4096',
      sseOpenTimeoutMs: 1,
    });

    await driver.prompt(sessionRef, 'hello');

    assert.deepEqual(order, ['sse', 'post']);
  });

  it('SSE 包含 reasoning 事件映射为 reasoning AgentEvent', async () => {
    const sseEvents = [
      { type: 'message.part.updated', properties: { sessionID: 'ses_abc', part: { type: 'reasoning', text: 'Let me think...' } } },
      { type: 'session.status', properties: { sessionID: 'ses_abc', status: { type: 'idle' } } },
    ];
    const http = new FakeHttpClient({});
    const sse = new FakeSSEClient(sseEvents);
    const driver = new OpencodeDriver({ httpClient: http, sseClient: sse, serverUrl: 'http://localhost:4096' });

    const events = await driver.prompt(sessionRef, '思考一下');

    assert.equal(events[0].type, 'reasoning');
    assert.equal(events[0].data.text, 'Let me think...');
    assert.equal(events[1].type, 'done');
  });

  it('SSE payload 包装事件也能映射文本', async () => {
    const sseEvents = [
      { directory: '/home/user/project', payload: { type: 'message.part.updated', properties: { sessionID: 'ses_abc', part: { type: 'text', text: 'Wrapped text' } } } },
      { directory: '/home/user/project', payload: { type: 'session.status', properties: { sessionID: 'ses_abc', status: { type: 'idle' } } } },
    ];
    const http = new FakeHttpClient({});
    const sse = new FakeSSEClient(sseEvents);
    const driver = new OpencodeDriver({ httpClient: http, sseClient: sse, serverUrl: 'http://localhost:4096' });

    const events = await driver.prompt(sessionRef, 'test');

    assert.equal(events[0].type, 'text');
    assert.equal(events[0].data.text, 'Wrapped text');
    assert.equal(events[1].type, 'done');
  });

  it('SSE 明确标记为 user 的文本不会回写到飞书', async () => {
    const sseEvents = [
      { type: 'message.part.updated', properties: { sessionID: 'ses_abc', message: { role: 'user' }, part: { type: 'text', text: '你是谁' } } },
      { type: 'message.part.updated', properties: { sessionID: 'ses_abc', message: { role: 'assistant' }, part: { type: 'text', text: '我是 OpenCode' } } },
      { type: 'session.status', properties: { sessionID: 'ses_abc', status: { type: 'idle' } } },
    ];
    const http = new FakeHttpClient({});
    const sse = new FakeSSEClient(sseEvents);
    const driver = new OpencodeDriver({ httpClient: http, sseClient: sse, serverUrl: 'http://localhost:4096' });

    const events = await driver.prompt(sessionRef, '你是谁');

    assert.equal(events[0].type, 'text');
    assert.equal(events[0].data.text, '我是 OpenCode');
    assert.equal(events[1].type, 'done');
    assert.equal(events.length, 2);
  });

  it('SSE message.part.delta 事件映射为增量文本', async () => {
    const sseEvents = [
      { type: 'message.part.delta', properties: { sessionID: 'ses_abc', messageID: 'msg1', partID: 'part1', field: 'text', delta: '你' } },
      { type: 'message.part.delta', properties: { sessionID: 'ses_abc', messageID: 'msg1', partID: 'part1', field: 'text', delta: '好' } },
      { type: 'session.status', properties: { sessionID: 'ses_abc', status: { type: 'idle' } } },
    ];
    const http = new FakeHttpClient({});
    const sse = new FakeSSEClient(sseEvents);
    const driver = new OpencodeDriver({ httpClient: http, sseClient: sse, serverUrl: 'http://localhost:4096' });

    const events = await driver.prompt(sessionRef, 'test');

    assert.equal(events[0].type, 'text');
    assert.equal(events[0].data.text, '你');
    assert.equal(events[0].data.delta, true);
    assert.equal(events[1].type, 'text');
    assert.equal(events[1].data.text, '好');
    assert.equal(events[1].data.delta, true);
    assert.equal(events[2].type, 'done');
  });

  it('SSE 包含 error 事件映射为 error AgentEvent', async () => {
    const sseEvents = [
      { type: 'session.error', properties: { sessionID: 'ses_abc', error: { message: 'API quota exceeded' } } },
    ];
    const http = new FakeHttpClient({});
    const sse = new FakeSSEClient(sseEvents);
    const driver = new OpencodeDriver({ httpClient: http, sseClient: sse, serverUrl: 'http://localhost:4096' });

    const events = await driver.prompt(sessionRef, 'test');

    assert.equal(events[0].type, 'error');
    assert.ok(events[0].data.message.includes('API quota exceeded'));
  });

  it('无 session id 的目录级 assistant 文本不会混入目标 session 输出', async () => {
    const sseEvents = [
      { type: 'message.part.updated', properties: { message: { role: 'assistant' }, part: { type: 'text', text: '其它会话无 id 文本' } } },
      { type: 'message.part.updated', properties: { sessionID: 'ses_abc', message: { role: 'assistant' }, part: { type: 'text', text: '目标会话文本' } } },
      { type: 'session.status', properties: { sessionID: 'ses_abc', status: { type: 'idle' } } },
    ];
    const http = new FakeHttpClient({});
    const sse = new FakeSSEClient(sseEvents);
    const driver = new OpencodeDriver({ httpClient: http, sseClient: sse, serverUrl: 'http://localhost:4096' });

    const events = await driver.prompt(sessionRef, 'test');

    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'text');
    assert.equal(events[0].data.text, '目标会话文本');
    assert.equal(events[1].type, 'done');
  });

  it('无 session id 的 idle 不会提前终止目标 prompt', async () => {
    const sseEvents = [
      { type: 'session.status', properties: { status: { type: 'idle' } } },
      { type: 'message.part.updated', properties: { sessionID: 'ses_abc', message: { role: 'assistant' }, part: { type: 'text', text: 'idle 后的目标文本' } } },
      { type: 'session.status', properties: { sessionID: 'ses_abc', status: { type: 'idle' } } },
    ];
    const http = new FakeHttpClient({});
    const sse = {
      calls: [],
      async connect(url, options) {
        this.calls.push({ url, options });
        if (options.onOpen) options.onOpen({ statusCode: 200 });
        const delivered = [];
        for (const event of sseEvents) {
          if (options.onEvent) options.onEvent(event, sseEvents);
          delivered.push(event);
          if (options.shouldClose && options.shouldClose(event)) break;
        }
        return delivered;
      },
    };
    const driver = new OpencodeDriver({ httpClient: http, sseClient: sse, serverUrl: 'http://localhost:4096' });

    const events = await driver.prompt(sessionRef, 'test');

    assert.equal(events.length, 2);
    assert.equal(events[0].type, 'text');
    assert.equal(events[0].data.text, 'idle 后的目标文本');
    assert.equal(events[1].type, 'done');
  });

  it('watchSession 后台监听只转发目标 session 的 assistant 事件并可暂停', async () => {
    const delivered = [];
    const sse = {
      calls: [],
      async connect(url, options) {
        this.calls.push({ url, options });
        options.onEvent({ type: 'message.part.updated', properties: { sessionID: 'other', part: { type: 'text', text: '其它会话' } } });
        options.onEvent({ type: 'message.part.updated', properties: { sessionID: 'ses_abc', message: { role: 'user' }, part: { type: 'text', text: '用户输入' } } });
        options.onEvent({ type: 'message.part.updated', properties: { sessionID: 'ses_abc', message: { role: 'assistant' }, part: { type: 'text', text: '终端回复' } } });
        return [];
      },
    };
    const driver = new OpencodeDriver({ httpClient: new FakeHttpClient({}), sseClient: sse, serverUrl: 'http://localhost:4096' });

    const stopWatch = driver.watchSession(sessionRef, { onEvent: (event) => delivered.push(event) });

    assert.equal(sse.calls[0].url, 'http://localhost:4096/event?directory=%2Fhome%2Fuser%2Fproject');
    assert.equal(sse.calls[0].options.collectEvents, false);
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].data.text, '终端回复');
    if (typeof stopWatch === 'function') stopWatch();
  });

  it('watchSession 使用 sessionRef 指定的 OpenCode 服务', async () => {
    const remoteRef = { ...sessionRef, serverUrl: 'http://127.0.0.1:54321' };
    const sse = {
      calls: [],
      async connect(url, options) {
        this.calls.push({ url, options });
        return [];
      },
    };
    const driver = new OpencodeDriver({ httpClient: new FakeHttpClient({}), sseClient: sse, serverUrl: 'http://localhost:4096' });

    const stopWatch = driver.watchSession(remoteRef, { onEvent: () => {} });

    assert.equal(sse.calls[0].url, 'http://127.0.0.1:54321/event?directory=%2Fhome%2Fuser%2Fproject');
    if (typeof stopWatch === 'function') stopWatch();
  });

  it('watchSession 的 SSE 结束后会清理后台轮询定时器', async () => {
    const sse = {
      calls: [],
      async connect(url, options) {
        this.calls.push({ url, options });
        return [];
      },
    };
    const driver = new OpencodeDriver({ httpClient: new FakeHttpClient({}), sseClient: sse, serverUrl: 'http://localhost:4096' });

    driver.watchSession(sessionRef, { onEvent: () => {} });
    await new Promise((resolve) => setImmediate(resolve));
    const leaked = driver._sessionWatcher._pollTimers && driver._sessionWatcher._pollTimers.has('ses_abc');
    if (leaked) {
      clearInterval(driver._sessionWatcher._pollTimers.get('ses_abc'));
      driver._sessionWatcher._pollTimers.delete('ses_abc');
    }

    assert.equal(leaked, false);
    assert.equal(driver._sessionWatcher.watchers.has('ses_abc'), false);
  });

  it('watchSession 已通过 SSE 投递的 assistant 消息不会被轮询重复投递', async () => {
    const delivered = [];
    const http = new FakeHttpClient({
      'GET http://localhost:4096/session/ses_abc/message': {
        status: 200,
        data: [
          { info: { id: 'msg0', role: 'user', time: { completed: Date.now() } }, parts: [{ type: 'text', text: '用户输入' }] },
          { info: { id: 'msg1', role: 'assistant', time: { completed: Date.now() } }, parts: [{ type: 'text', text: '终端回复' }] },
        ],
      },
    });
    const sse = {
      calls: [],
      async connect(url, options) {
        this.calls.push({ url, options });
        options.onEvent({ type: 'message.part.updated', properties: { sessionID: 'ses_abc', messageID: 'msg1', message: { role: 'assistant' }, part: { type: 'text', text: '终端回复' } } });
        return [];
      },
    };
    const driver = new OpencodeDriver({ httpClient: http, sseClient: sse, serverUrl: 'http://localhost:4096' });
    driver._sessionWatcher._lastPolledMessageId = new Map([['ses_abc', 'msg0']]);

    const stopWatch = driver.watchSession(sessionRef, { onEvent: (event) => delivered.push(event) });
    await new Promise((resolve) => setImmediate(resolve));
    if (typeof stopWatch === 'function') stopWatch();

    const textEvents = delivered.filter((event) => event.type === 'text');
    assert.equal(textEvents.length, 1);
    assert.equal(textEvents[0].data.text, '终端回复');
  });

  it('watchSession resume 后继续用原始回调投递轮询消息', async () => {
    const delivered = [];
    let messages = [
      { info: { id: 'msg0', role: 'user', time: { completed: Date.now() } }, parts: [{ type: 'text', text: '用户输入' }] },
    ];
    const http = {
      calls: [],
      async request(method, url, body) {
        this.calls.push({ method, url, body });
        if (method === 'GET' && url === 'http://localhost:4096/session/ses_abc/message') {
          return { status: 200, data: messages };
        }
        return { status: 200, data: {} };
      },
    };
    const sse = {
      calls: [],
      async connect(url, options) {
        this.calls.push({ url, options });
        return new Promise(() => {});
      },
    };
    const driver = new OpencodeDriver({
      httpClient: http,
      sseClient: sse,
      serverUrl: 'http://localhost:4096',
      messagePollIntervalMs: 1000,
    });

    const stopWatch = driver.watchSession(sessionRef, { onEvent: (event) => delivered.push(event) });
    await new Promise((resolve) => setImmediate(resolve));

    driver._sessionWatcher.suspend(sessionRef);
    messages = messages.concat({
      info: { id: 'msg1', role: 'assistant', time: { completed: Date.now() } },
      parts: [{ type: 'text', text: '恢复后的回复' }],
    });

    driver._sessionWatcher.resume(sessionRef);
    await new Promise((resolve) => setImmediate(resolve));
    if (typeof stopWatch === 'function') stopWatch();

    const textEvents = delivered.filter((event) => event.type === 'text');
    assert.equal(textEvents.length, 1);
    assert.equal(textEvents[0].data.text, '恢复后的回复');
  });

  it('pending assistant 消息完成后可投递，游标不跳过', async () => {
    const delivered = [];
    let messages = [
      { info: { id: 'msg0', role: 'user', time: { completed: Date.now() } }, parts: [{ type: 'text', text: '用户输入' }] },
    ];
    const http = {
      calls: [],
      async request(method, url, body) {
        this.calls.push({ method, url, body });
        if (method === 'GET' && url === 'http://localhost:4096/session/ses_abc/message') {
          return { status: 200, data: messages };
        }
        return { status: 200, data: {} };
      },
    };
    const sse = {
      calls: [],
      async connect(url, options) {
        this.calls.push({ url, options });
        return new Promise(() => {});
      },
    };
    const driver = new OpencodeDriver({
      httpClient: http,
      sseClient: sse,
      serverUrl: 'http://localhost:4096',
      messagePollIntervalMs: 1000,
    });

    const stopWatch = driver.watchSession(sessionRef, { onEvent: (event) => delivered.push(event) });
    await new Promise((resolve) => setImmediate(resolve));

    driver._sessionWatcher.suspend(sessionRef);
    messages = messages.concat({
      info: { id: 'msg1', role: 'assistant', time: {} },
      parts: [{ type: 'text', text: '进行中的回复' }],
    });

    driver._sessionWatcher.resume(sessionRef);
    await new Promise((resolve) => setImmediate(resolve));

    const textBeforeComplete = delivered.filter((e) => e.type === 'text');
    assert.equal(textBeforeComplete.length, 0, 'pending 消息不应投递');

    messages = [
      { info: { id: 'msg0', role: 'user', time: { completed: Date.now() } }, parts: [{ type: 'text', text: '用户输入' }] },
      { info: { id: 'msg1', role: 'assistant', time: { completed: Date.now() } }, parts: [{ type: 'text', text: '已完成的回复' }] },
    ];

    await new Promise((resolve) => setTimeout(resolve, 1100));
    if (typeof stopWatch === 'function') stopWatch();

    const textEvents = delivered.filter((e) => e.type === 'text');
    assert.equal(textEvents.length, 1, 'completed 后应投递');
    assert.equal(textEvents[0].data.text, '已完成的回复');
  });

  it('stopWatch 清理轮询定时器，不再投递消息', async () => {
    const delivered = [];
    let pollCount = 0;
    const messages = [
      { info: { id: 'msg0', role: 'user', time: { completed: Date.now() } }, parts: [{ type: 'text', text: '用户输入' }] },
      { info: { id: 'msg1', role: 'assistant', time: { completed: Date.now() } }, parts: [{ type: 'text', text: '回复1' }] },
    ];
    const http = {
      calls: [],
      async request(method, url, body) {
        this.calls.push({ method, url, body });
        if (method === 'GET' && url === 'http://localhost:4096/session/ses_abc/message') {
          pollCount++;
          return { status: 200, data: messages };
        }
        return { status: 200, data: {} };
      },
    };
    const sse = {
      calls: [],
      async connect(url, options) {
        this.calls.push({ url, options });
        return new Promise(() => {});
      },
    };
    const driver = new OpencodeDriver({
      httpClient: http,
      sseClient: sse,
      serverUrl: 'http://localhost:4096',
      messagePollIntervalMs: 200,
    });
    driver._sessionWatcher._lastPolledMessageId = new Map([['ses_abc', 'msg0']]);

    const stopWatch = driver.watchSession(sessionRef, { onEvent: (event) => delivered.push(event) });
    await new Promise((resolve) => setImmediate(resolve));

    if (typeof stopWatch === 'function') stopWatch();
    assert.ok(!driver._sessionWatcher._pollTimers.has('ses_abc'), '定时器应已清理');
    assert.ok(!driver._sessionWatcher.watchers.has('ses_abc'), 'watcher 应已移除');

    const countAfterStop = pollCount;
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(pollCount, countAfterStop, 'stop 后不应再轮询');
  });

  it('resume 后不重复投递已处理的消息', async () => {
    const delivered = [];
    let messages = [
      { info: { id: 'msg0', role: 'user', time: { completed: Date.now() } }, parts: [{ type: 'text', text: '用户输入' }] },
      { info: { id: 'msg1', role: 'assistant', time: { completed: Date.now() } }, parts: [{ type: 'text', text: '回复1' }] },
    ];
    const http = {
      calls: [],
      async request(method, url, body) {
        this.calls.push({ method, url, body });
        if (method === 'GET' && url === 'http://localhost:4096/session/ses_abc/message') {
          return { status: 200, data: messages };
        }
        return { status: 200, data: {} };
      },
    };
    const sse = {
      calls: [],
      async connect(url, options) {
        this.calls.push({ url, options });
        return new Promise(() => {});
      },
    };
    const driver = new OpencodeDriver({
      httpClient: http,
      sseClient: sse,
      serverUrl: 'http://localhost:4096',
      messagePollIntervalMs: 200,
    });
    driver._sessionWatcher._lastPolledMessageId = new Map([['ses_abc', 'msg0']]);

    const stopWatch = driver.watchSession(sessionRef, { onEvent: (event) => delivered.push(event) });
    await new Promise((resolve) => setImmediate(resolve));

    const firstTextCount = delivered.filter((e) => e.type === 'text').length;
    assert.equal(firstTextCount, 1, '初始应投递一条');

    driver._sessionWatcher.suspend(sessionRef);
    driver._sessionWatcher.resume(sessionRef);
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (typeof stopWatch === 'function') stopWatch();

    const textEvents = delivered.filter((e) => e.type === 'text');
    assert.equal(textEvents.length, 1, 'resume 后不应重复投递');
  });
});

describe('OpencodeDriver stop and delete', () => {
  const sessionRef = { opencodeSessionId: 'ses_abc', serverUrl: 'http://localhost:4096' };

  it('stop 调用 POST /session/:id/stop', async () => {
    const http = new FakeHttpClient({
      'POST http://localhost:4096/session/ses_abc/stop': { status: 204, data: null },
    });
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096' });
    await driver.stop(sessionRef);
    assert.equal(http.calls[0].method, 'POST');
    assert.ok(http.calls[0].url.includes('/session/ses_abc/stop'));
  });

  it('delete 调用 DELETE /session/:id', async () => {
    const http = new FakeHttpClient({
      'DELETE http://localhost:4096/session/ses_abc': { status: 204, data: null },
    });
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096' });
    await driver.delete(sessionRef);
    assert.equal(http.calls[0].method, 'DELETE');
    assert.ok(http.calls[0].url.includes('/session/ses_abc'));
  });

  it('replyPermission 调用 POST /session/:id/permissions/:permissionId', async () => {
    const http = new FakeHttpClient({
      'POST http://localhost:4096/session/ses_abc/permissions/perm_123': { status: 200, data: {} },
    });
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096' });
    await driver.replyPermission(sessionRef, 'perm_123', 'allow');
    assert.equal(http.calls[0].method, 'POST');
    assert.ok(http.calls[0].url.includes('/session/ses_abc/permissions/perm_123'));
    assert.equal(http.calls[0].body.response, 'allow');
    assert.equal(http.calls[0].body.remember, false);
  });

  it('replyPermission remember 参数传递', async () => {
    const http = new FakeHttpClient({
      'POST http://localhost:4096/session/ses_abc/permissions/perm_123': { status: 200, data: {} },
    });
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096' });
    await driver.replyPermission(sessionRef, 'perm_123', 'deny', true);
    assert.equal(http.calls[0].body.response, 'deny');
    assert.equal(http.calls[0].body.remember, true);
  });

  it('replyPermission 缺少 sessionRef 抛错', async () => {
    const driver = new OpencodeDriver({ serverUrl: 'http://localhost:4096' });
    await assert.rejects(() => driver.replyPermission(null, 'perm_123', 'allow'), { message: /sessionRef/ });
  });

  it('replyPermission 缺少 permissionId 抛错', async () => {
    const driver = new OpencodeDriver({ serverUrl: 'http://localhost:4096' });
    await assert.rejects(() => driver.replyPermission(sessionRef, '', 'allow'), { message: /permissionId/ });
  });

  it('replyPermission HTTP 失败时抛错', async () => {
    const http = new FakeHttpClient({
      'POST http://localhost:4096/session/ses_abc/permissions/perm_123': { error: new Error('server error') },
    });
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096' });
    await assert.rejects(() => driver.replyPermission(sessionRef, 'perm_123', 'allow'), { message: /server error/ });
  });

  it('session scoped 请求使用 sessionRef.serverUrl', async () => {
    const remoteRef = { opencodeSessionId: 'ses_abc', serverUrl: 'http://127.0.0.1:54321', cwd: '/tmp/project' };
    const http = new FakeHttpClient({
      'GET http://127.0.0.1:54321/session/ses_abc/message': { status: 200, data: [] },
      'POST http://127.0.0.1:54321/session/ses_abc/stop': { status: 204, data: null },
      'DELETE http://127.0.0.1:54321/session/ses_abc': { status: 204, data: null },
    });
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096' });

    await driver.getSessionMessages(remoteRef);
    await driver.stop(remoteRef);
    await driver.delete(remoteRef);

    assert.ok(http.calls.every((call) => call.url.startsWith('http://127.0.0.1:54321/')));
  });
});

describe('OpencodeDriver resumeSession', () => {
  it('恢复已有 session 返回 sessionRef', async () => {
    const http = new FakeHttpClient({});
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096' });
    const result = await driver.resumeSession({ opencodeSessionId: 'ses_abc', serverUrl: 'http://localhost:4096' });
    assert.equal(result.opencodeSessionId, 'ses_abc');
    assert.equal(result.serverUrl, 'http://localhost:4096');
  });
});

describe('OpencodeDriver listSessions', () => {
  it('调用 GET /session 并规范化会话摘要', async () => {
    const http = new FakeHttpClient({
      'GET http://localhost:4096/session?directory=%2Fhome%2Fuser%2Fproject': {
        status: 200,
        data: [
          { id: 'ses_abc', title: 'terminal session', status: { type: 'idle' }, directory: '/home/user/project' },
        ],
      },
    });
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096' });

    const sessions = await driver.listSessions({ cwd: '/home/user/project' });

    assert.equal(http.calls[0].method, 'GET');
    assert.equal(http.calls[0].url, 'http://localhost:4096/session?directory=%2Fhome%2Fuser%2Fproject');
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0], {
      id: 'ses_abc',
      title: 'terminal session',
      status: 'idle',
      cwd: '/home/user/project',
      updatedAt: null,
    });
  });

  it('支持 sessions 包装响应', async () => {
    const http = new FakeHttpClient({
      'GET http://localhost:4096/session?directory=%2Fhome%2Fuser%2Fproject': {
        status: 200,
        data: { sessions: [{ sessionID: 'ses_wrapped', name: 'wrapped' }] },
      },
    });
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096' });

    const sessions = await driver.listSessions({ cwd: '/home/user/project' });

    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].id, 'ses_wrapped');
    assert.equal(sessions[0].title, 'wrapped');
  });
});

describe('OpencodeDriver listModels', () => {
  it('基类默认声明不支持模型目录', async () => {
    const driver = new AgentDriver('stub');

    await assert.rejects(() => driver.listModels(), { message: /stub.*不支持.*模型目录|stub.*model catalog/i });
  });

  it('调用 GET /api/model 并返回规范化模型列表', async () => {
    const http = new FakeHttpClient({
      'GET http://localhost:4096/api/model': {
        status: 200,
        data: [
          { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', providerID: 'anthropic' },
          { id: 'gpt-4o', name: 'GPT-4o', providerID: 'openai' },
        ],
      },
    });
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096', modelState: null });

    const models = await driver.listModels();

    assert.equal(models.length, 2);
    assert.equal(models[0].id, 'claude-sonnet-4-20250514');
    assert.equal(models[0].name, 'Claude Sonnet 4');
    assert.equal(models[0].provider, 'anthropic');
    assert.equal(models[0].source, 'opencode');
    assert.deepEqual(models[0].groups, []);
    assert.equal(models[0].lastUsedAt, null);
    assert.equal(models[1].provider, 'openai');
  });

  it('映射 OpenCode Recent 元数据到统一模型视图', async () => {
    const http = new FakeHttpClient({
      'GET http://localhost:4096/api/model': {
        status: 200,
        data: [
          {
            modelID: 'claude-recent',
            modelName: 'Claude Recent',
            providerID: 'anthropic',
            groups: ['recent', 'anthropic'],
            lastUsedAt: '2026-07-16T10:00:00.000Z',
          },
          {
            id: 'gpt-recent',
            name: 'GPT Recent',
            provider: 'openai',
            category: 'recent',
          },
          {
            id: 'gemini-recent',
            name: 'Gemini Recent',
            provider: 'google',
            recent: true,
          },
        ],
      },
    });
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096', modelState: null });

    const models = await driver.listModels();

    assert.equal(models.length, 3);
    assert.deepEqual(models[0], {
      id: 'claude-recent',
      name: 'Claude Recent',
      provider: 'anthropic',
      status: '',
      enabled: true,
      source: 'opencode',
      groups: ['recent', 'anthropic'],
      lastUsedAt: '2026-07-16T10:00:00.000Z',
    });
    assert.deepEqual(models[1].groups, ['recent']);
    assert.equal(models[1].lastUsedAt, null);
    assert.deepEqual(models[2].groups, ['recent']);
    assert.equal(models[2].source, 'opencode');
  });

  it('合并本地 Recent 与 /api/model，且不读取其它模型源', async () => {
    const http = new FakeHttpClient({
      'GET http://localhost:4096/api/model': {
        status: 200,
        data: [
          {
            id: 'gpt-5.6-sol',
            name: 'GPT 5.6 Sol',
            providerID: 'cpa',
          },
          { id: 'runtime-only', name: 'Runtime Only', providerID: 'anthropic' },
        ],
      },
    });
    const driver = new OpencodeDriver({
      httpClient: http,
      serverUrl: 'http://localhost:4096',
      modelState: {
        recent: [
          { providerID: 'cpa', modelID: 'gpt-5.6-sol' },
          { providerID: 'kscc', modelID: 'glm-5.2' },
          { providerID: 'cpa', modelID: 'gpt-5.6-sol' },
        ],
      },
    });

    const models = await driver.listModels();

    assert.deepEqual(models.map((model) => model.provider + '/' + model.id), [
      'cpa/gpt-5.6-sol',
      'kscc/glm-5.2',
      'anthropic/runtime-only',
    ]);
    assert.equal(models[0].name, 'GPT 5.6 Sol');
    assert.deepEqual(models[0].groups, ['recent']);
    assert.equal(models[1].name, 'glm-5.2');
    assert.deepEqual(models[1].groups, ['recent']);
    assert.deepEqual(models[2].groups, []);
    assert.deepEqual(http.calls.map((call) => call.method + ' ' + call.url), [
      'GET http://localhost:4096/api/model',
    ]);
  });

  it('本地模型状态不可用时仅返回 /api/model', async () => {
    const http = new FakeHttpClient({
      'GET http://localhost:4096/api/model': {
        status: 200,
        data: [{ id: 'claude-sonnet-5', name: 'Claude Sonnet 5', providerID: 'anthropic' }],
      },
    });
    const driver = new OpencodeDriver({
      httpClient: http,
      serverUrl: 'http://localhost:4096',
      modelStatePath: 'Z:\\missing\\opencode-model.json',
    });

    const models = await driver.listModels();

    assert.equal(models.length, 1);
    assert.equal(models[0].id, 'claude-sonnet-5');
    assert.deepEqual(http.calls.map((call) => call.method + ' ' + call.url), [
      'GET http://localhost:4096/api/model',
    ]);
  });

  it('过滤 disabled 或无 id 模型并保留 deprecated 状态', async () => {
    const http = new FakeHttpClient({
      'GET http://localhost:4096/api/model': {
        status: 200,
        data: [
          { id: 'old-model', name: 'Old Model', providerID: 'anthropic', status: 'deprecated' },
          { id: 'disabled-model', name: 'Disabled Model', providerID: 'openai', enabled: false },
          { name: 'Missing ID', providerID: 'google' },
        ],
      },
    });
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096', modelState: null });

    const models = await driver.listModels();

    assert.equal(models.length, 1);
    assert.equal(models[0].id, 'old-model');
    assert.equal(models[0].status, 'deprecated');
    assert.equal(models[0].enabled, true);
  });

  it('支持 data 包装响应', async () => {
    const http = new FakeHttpClient({
      'GET http://localhost:4096/api/model': [
        { modelID: 'gemini-pro', modelName: 'Gemini Pro', provider: 'google' },
      ],
    });
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096', modelState: null });

    const models = await driver.listModels();

    assert.equal(models.length, 1);
    assert.equal(models[0].id, 'gemini-pro');
    assert.equal(models[0].name, 'Gemini Pro');
    assert.equal(models[0].provider, 'google');
  });

  it('API 失败时抛错含 serverUrl', async () => {
    const http = new FakeHttpClient({
      'GET http://localhost:4096/api/model': { error: new Error('connection refused') },
    });
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096', modelState: null });

    await assert.rejects(() => driver.listModels(), /Failed to list models/);
  });
});

describe('OpencodeDriver clearSession', () => {
  it('TUI clear 只委托 bridge', async () => {
    const calls = [];
    const bridge = {
      clearSession: async (ref) => {
        calls.push({ method: 'clearSession', ref });
        return {
          runtimeId: ref.runtimeId,
          oldSessionId: 'ses_old',
          newSessionId: 'ses_new',
          walkerSessionId: 'wks_new',
        };
      },
    };
    const http = new FakeHttpClient({});
    const sse = new FakeSSEClient([]);
    const driver = new OpencodeDriver({
      httpClient: http, sseClient: sse, serverUrl: 'http://localhost:4096', tuiBridge: bridge,
    });
    const ref = { opencodeSessionId: 'ses_old', transport: 'tui-bridge', runtimeId: 'runtime-1' };

    const result = await driver.clearSession(ref);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'clearSession');
    assert.equal(calls[0].ref, ref);
    assert.equal(result.newSessionId, 'ses_new');
    assert.equal(result.walkerSessionId, 'wks_new');
    assert.equal(http.calls.length, 0, 'clearSession 不得访问 HTTP');
  });

  it('拒绝非 TUI ref 且不调用 HTTP create 或打开终端', async () => {
    const http = new FakeHttpClient({});
    const sse = new FakeSSEClient([]);
    const runtime = {
      spawn: () => ({ pid: 1, unref: () => {} }),
      openTerminal: async () => { throw new Error('不应打开终端'); },
    };
    const driver = new OpencodeDriver({
      httpClient: http, sseClient: sse, serverUrl: 'http://localhost:4096', runtime,
    });
    const ref = { opencodeSessionId: 'ses_old', serverUrl: 'http://localhost:4096' };

    await assert.rejects(
      () => driver.clearSession(ref),
      /tui-bridge|transport/i,
    );
    assert.equal(http.calls.length, 0, '非 TUI ref 不应触发 HTTP 调用');
  });

  it('TUI ref 但未配置 tuiBridge 时抛错', async () => {
    const http = new FakeHttpClient({});
    const sse = new FakeSSEClient([]);
    const driver = new OpencodeDriver({
      httpClient: http, sseClient: sse, serverUrl: 'http://localhost:4096',
    });
    const ref = { opencodeSessionId: 'ses_old', transport: 'tui-bridge', runtimeId: 'runtime-1' };

    await assert.rejects(
      () => driver.clearSession(ref),
      /tuiBridge|tui-bridge|not configured|未配置/i,
    );
    assert.equal(http.calls.length, 0);
  });
});

describe('OpencodeDriver replyPermission tui-bridge', () => {
  const tuiRef = { opencodeSessionId: 'ses_local', transport: 'tui-bridge', runtimeId: 'runtime-1' };

  it('tui-bridge transport 保持不支持且绝不调用 tuiBridge.replyQuestion', async () => {
    let bridgeCalled = false;
    const bridge = {
      replyQuestion: async () => { bridgeCalled = true; },
    };
    const http = new FakeHttpClient({});
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096', tuiBridge: bridge });

    await assert.rejects(
      () => driver.replyPermission(tuiRef, 'perm_1', 'allow'),
      { message: 'replyPermission is not supported for tui-bridge transport' },
    );
    assert.equal(bridgeCalled, false);
    assert.equal(http.calls.length, 0);
  });
});

describe('OpencodeDriver replyQuestion', () => {
  const tuiRef = { opencodeSessionId: 'ses_local', transport: 'tui-bridge', runtimeId: 'runtime-1' };

  it('转发 requestID 和二维 answers 到 TUI bridge', async () => {
    const calls = [];
    const bridge = {
      replyQuestion: async (ref, requestID, answers) => {
        calls.push({ ref, requestID, answers });
      },
    };
    const http = new FakeHttpClient({});
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096', tuiBridge: bridge });
    const answers = [['选项 A'], ['选项 B', '自定义答案']];

    await driver.replyQuestion(tuiRef, 'req_1', answers);

    assert.deepEqual(calls, [{ ref: tuiRef, requestID: 'req_1', answers }]);
    assert.equal(http.calls.length, 0, '原生 question reply 不得降级为 HTTP 或 prompt');
  });

  it('保留 Bridge accepted 超时和结果不确定错误的所有可靠性属性', async () => {
    const bridgeErrors = [
      Object.assign(new Error('accepted 超时'), {
        code: 'QUESTION_REPLY_ACCEPTED_TIMEOUT',
        deliveryPhase: 'queued',
        sdkInvoked: false,
        safeToRetry: true,
      }),
      Object.assign(new Error('结果无法确认'), {
        code: 'QUESTION_REPLY_FINAL_UNCERTAIN',
        deliveryPhase: 'leased',
        sdkInvoked: true,
        safeToRetry: false,
      }),
    ];
    const bridge = {
      replyQuestion: async () => { throw bridgeErrors.shift(); },
    };
    const driver = new OpencodeDriver({ serverUrl: 'http://localhost:4096', tuiBridge: bridge });

    await assert.rejects(
      () => driver.replyQuestion(tuiRef, 'req_2', [['答案']]),
      (err) => err.code === 'QUESTION_REPLY_ACCEPTED_TIMEOUT'
        && err.deliveryPhase === 'queued'
        && err.sdkInvoked === false
        && err.safeToRetry === true,
    );
    await assert.rejects(
      () => driver.replyQuestion(tuiRef, 'req_2', [['答案']]),
      (err) => err.code === 'QUESTION_REPLY_FINAL_UNCERTAIN'
        && err.deliveryPhase === 'leased'
        && err.sdkInvoked === true
        && err.safeToRetry === false,
    );
  });

  it('非 TUI transport 返回不可重试的结构化不支持错误且不回退', async () => {
    const bridge = {
      replyQuestion: async () => { throw new Error('不应调用 bridge'); },
    };
    const http = new FakeHttpClient({});
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096', tuiBridge: bridge });

    await assert.rejects(
      () => driver.replyQuestion({ opencodeSessionId: 'ses_remote', transport: 'sse' }, 'req_3', [['答案']]),
      (err) => err.code === 'QUESTION_REPLY_UNSUPPORTED'
        && err.deliveryPhase === 'preflight'
        && err.sdkInvoked === false
        && err.safeToRetry === false,
    );
    assert.equal(http.calls.length, 0, '不支持的 transport 不得回退为 HTTP');
  });

  it('错误的 TUI agentRef 返回不可重试的结构化错误且不调用 Bridge', async () => {
    let bridgeCalled = false;
    const bridge = {
      replyQuestion: async () => { bridgeCalled = true; },
    };
    const driver = new OpencodeDriver({ serverUrl: 'http://localhost:4096', tuiBridge: bridge });

    await assert.rejects(
      () => driver.replyQuestion({ opencodeSessionId: 'ses_local', transport: 'tui-bridge' }, 'req_4', [['答案']]),
      (err) => err.code === 'TUI_INVALID_SESSION_REF'
        && err.deliveryPhase === 'preflight'
        && err.sdkInvoked === false
        && err.safeToRetry === false,
    );
    assert.equal(bridgeCalled, false);
  });

  it('缺失 Bridge 时返回完整的不可重试 preflight 错误', async () => {
    const driver = new OpencodeDriver({ serverUrl: 'http://localhost:4096' });

    await assert.rejects(
      () => driver.replyQuestion(tuiRef, 'req_5', [['答案']]),
      (err) => err.code === 'QUESTION_REPLY_UNSUPPORTED'
        && err.deliveryPhase === 'preflight'
        && err.sdkInvoked === false
        && err.safeToRetry === false,
    );
  });

  it('protocol 低于 4 时透传门禁错误且不入队', async () => {
    const sessions = [];
    const sessionService = {
      createSession: ({ cwd, agentRef }) => {
        const session = { id: 'walker_1', cwd, agentRef };
        sessions.push(session);
        return session;
      },
      listSessions: () => sessions,
      getRouteForSession: () => null,
      listRoutes: () => [],
    };
    const bridge = new OpencodeTuiBridge({ sessionService });
    bridge.register({
      runtimeId: 'runtime-v3',
      sessionId: 'ses_v3',
      cwd: '/tmp/project',
      bridgeProtocolVersion: 3,
    });
    const driver = new OpencodeDriver({ serverUrl: 'http://localhost:4096', tuiBridge: bridge });
    const v3Ref = { opencodeSessionId: 'ses_v3', transport: 'tui-bridge', runtimeId: 'runtime-v3' };

    await assert.rejects(
      () => driver.replyQuestion(v3Ref, 'req_v3', [['答案']]),
      (err) => err.code === 'QUESTION_REPLY_UNSUPPORTED'
        && err.deliveryPhase === 'preflight'
        && err.sdkInvoked === false
        && err.safeToRetry === false,
    );
    assert.equal(bridge.runtimes.get('runtime-v3').queue.length, 0);
    assert.equal(bridge.pending.size, 0);
  });
});

describe('OpencodeDriver prompt timeout and recovery', () => {
  const sessionRef = { opencodeSessionId: 'ses_abc', serverUrl: 'http://localhost:4096', cwd: '/home/user/project' };

  it('SSE open timeout 抛出 SSE_OPEN_TIMEOUT 错误码', async () => {
    const sse = {
      calls: [],
      async connect(url, options) {
        this.calls.push({ url, options });
        return new Promise(() => {});
      },
    };
    const http = new FakeHttpClient({});
    const driver = new OpencodeDriver({
      httpClient: http, sseClient: sse, serverUrl: 'http://localhost:4096',
      sseOpenTimeoutMs: 10,
    });

    await assert.rejects(
      () => driver.prompt(sessionRef, 'hello'),
      (err) => err.code === 'SSE_OPEN_TIMEOUT',
    );
  });

  it('prompt HTTP 错误在提交前失败不进入恢复', async () => {
    const sse = {
      calls: [],
      async connect(url, options) {
        this.calls.push({ url, options });
        if (options.onOpen) options.onOpen({ statusCode: 200 });
        return new Promise(() => {});
      },
    };
    const http = {
      calls: [],
      async request(method, url, body) {
        this.calls.push({ method, url, body });
        throw new Error('HTTP request timed out');
      },
    };
    const driver = new OpencodeDriver({
      httpClient: http, sseClient: sse, serverUrl: 'http://localhost:4096',
      sseOpenTimeoutMs: 0,
    });

    await assert.rejects(
      () => driver.prompt(sessionRef, 'hello'),
      /timed out|HTTP/i,
    );
    assert.equal(driver._sessionWatcher.getLastPolledMessageId('ses_abc'), undefined, '提交前失败不应推进游标');
  });

  it('SSE 断流后恢复从 messages 获取最终结果', async () => {
    let pollCount = 0;
    let messages = [
      { info: { id: 'msg0', role: 'user', time: { completed: Date.now() } }, parts: [{ type: 'text', text: '用户输入' }] },
    ];
    const sse = {
      calls: [],
      async connect(url, options) {
        this.calls.push({ url, options });
        if (options.onOpen) options.onOpen({ statusCode: 200 });
        throw new Error('SSE idle timeout');
      },
    };
    const http = {
      calls: [],
      async request(method, url, body) {
        this.calls.push({ method, url, body });
        if (method === 'POST') return { status: 200, data: {} };
        if (method === 'GET' && url.includes('/message')) {
          pollCount++;
          if (pollCount >= 2) {
            messages = [
              { info: { id: 'msg0', role: 'user', time: { completed: Date.now() } }, parts: [{ type: 'text', text: '用户输入' }] },
              { info: { id: 'msg1', role: 'assistant', time: { completed: Date.now() } }, parts: [{ type: 'text', text: '恢复后的回复' }] },
            ];
          }
          return { status: 200, data: messages };
        }
        return { status: 200, data: {} };
      },
    };
    const driver = new OpencodeDriver({
      httpClient: http, sseClient: sse, serverUrl: 'http://localhost:4096',
      sseOpenTimeoutMs: 0,
      promptRequestTimeoutMs: 0,
      messagePollIntervalMs: 10,
    });

    const events = await driver.prompt(sessionRef, 'hello');
    const textEvents = events.filter((e) => e.type === 'text');
    assert.equal(textEvents.length, 1);
    assert.equal(textEvents[0].data.text, '恢复后的回复');
    assert.ok(events.some((e) => e.type === 'done'));
  });

  it('prompt 失败不推进 watcher 游标到 pending message', async () => {
    const sse = {
      calls: [],
      async connect(url, options) {
        this.calls.push({ url, options });
        if (options.onOpen) options.onOpen({ statusCode: 200 });
        throw new Error('SSE idle timeout');
      },
    };
    const messages = [
      { info: { id: 'msg0', role: 'user', time: { completed: Date.now() } }, parts: [] },
      { info: { id: 'msg1', role: 'assistant', time: {} }, parts: [{ type: 'text', text: '进行中' }] },
    ];
    const http = {
      calls: [],
      async request(method, url, body) {
        this.calls.push({ method, url, body });
        if (method === 'POST') {
          throw new Error('prompt POST failed');
        }
        if (method === 'GET' && url.includes('/message')) {
          return { status: 200, data: messages };
        }
        return { status: 200, data: {} };
      },
    };
    const driver = new OpencodeDriver({
      httpClient: http, sseClient: sse, serverUrl: 'http://localhost:4096',
      sseOpenTimeoutMs: 0,
      promptRequestTimeoutMs: 0,
      messagePollIntervalMs: 10,
    });

    await assert.rejects(
      () => driver.prompt(sessionRef, 'hello'),
      /prompt POST failed/i,
    );

    const cursor = driver._sessionWatcher.getLastPolledMessageId('ses_abc');
    assert.notEqual(cursor, 'msg1', '失败后游标不应推进到 pending message');
  });

  it('abort signal 取消 prompt 抛出 ABORT_ERR', async () => {
    const controller = new AbortController();
    const sse = {
      calls: [],
      async connect(url, options) {
        this.calls.push({ url, options });
        if (options.onOpen) options.onOpen({ statusCode: 200 });
        setTimeout(() => controller.abort(), 10);
        return new Promise((resolve, reject) => {
          const onAbort = () => {
            reject(new Error('The operation was aborted'));
          };
          if (options.signal) {
            if (options.signal.aborted) { onAbort(); return; }
            options.signal.addEventListener('abort', onAbort, { once: true });
          }
        });
      },
    };
    const http = new FakeHttpClient({});
    const driver = new OpencodeDriver({
      httpClient: http, sseClient: sse, serverUrl: 'http://localhost:4096',
      sseOpenTimeoutMs: 0,
    });

    await assert.rejects(
      () => driver.prompt(sessionRef, 'hello', { signal: controller.signal }),
      (err) => err.code === 'ABORT_ERR',
    );
  });

  it('sseOpenTimeoutMs=0 不触发 open timeout 检查', async () => {
    let sseResolved = false;
    const sse = {
      calls: [],
      async connect(url, options) {
        this.calls.push({ url, options });
        await new Promise((resolve) => setTimeout(resolve, 50));
        sseResolved = true;
        if (options.onOpen) options.onOpen({ statusCode: 200 });
        return [{ type: 'session.status', properties: { sessionID: 'ses_abc', status: { type: 'idle' } } }];
      },
    };
    const http = new FakeHttpClient({});
    const driver = new OpencodeDriver({
      httpClient: http, sseClient: sse, serverUrl: 'http://localhost:4096',
      sseOpenTimeoutMs: 0,
    });

    const events = await driver.prompt(sessionRef, 'hello');
    assert.ok(sseResolved, 'SSE 应正常完成而不被 open timeout 中断');
    assert.ok(events.some((e) => e.type === 'done'));
  });
});
