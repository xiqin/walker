const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DriverRegistry } = require('../src/drivers/driver-registry');
const { OpencodeDriver } = require('../src/drivers/opencode-driver');
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
      runtime: { spawn: (cmd, args, opts) => { spawnCalls.push({ cmd, args }); return { pid: 999, kill: () => {}, unref: () => {} }; } },
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
        id: 'ses_abc123', title: 'walker session', status: 'pending',
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
        id: 'ses_abc123', title: 'walker session', status: 'pending',
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
        id: 'ses_abc123', title: 'walker session', status: 'pending',
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
        id: 'ses_abc123', title: 'walker session', status: 'pending',
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
    assert.equal(sse.calls[0].options.timeoutMs, 120000);
    assert.equal(events.length, 3);
    assert.equal(events[0].type, 'text');
    assert.equal(events[0].data.text, 'Hello world');
    assert.equal(events[1].type, 'tool_use');
    assert.equal(events[1].data.name, 'Bash');
    assert.equal(events[2].type, 'done');
  });

  it('先建立 SSE 订阅再提交 prompt，避免错过短生命周期事件', async () => {
    const order = [];
    const http = new FakeHttpClient({}, () => order.push('post'));
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
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096' });

    const models = await driver.listModels();

    assert.equal(models.length, 2);
    assert.equal(models[0].id, 'claude-sonnet-4-20250514');
    assert.equal(models[0].name, 'Claude Sonnet 4');
    assert.equal(models[0].provider, 'anthropic');
    assert.equal(models[1].provider, 'openai');
  });

  it('支持 data 包装响应', async () => {
    const http = new FakeHttpClient({
      'GET http://localhost:4096/api/model': [
        { modelID: 'gemini-pro', modelName: 'Gemini Pro', provider: 'google' },
      ],
    });
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096' });

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
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096' });

    await assert.rejects(() => driver.listModels(), /Failed to list models/);
  });
});
