const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { DriverRegistry } = require('../src/drivers/driver-registry');
const { OpencodeDriver } = require('../src/drivers/opencode-driver');
const { stubClaudeDriver, stubCodexDriver } = require('../src/drivers/stub-drivers');

class FakeHttpClient {
  constructor(responses) {
    this.responses = responses;
    this.calls = [];
    this.callCount = {};
  }
  async request(method, url, body) {
    this.calls.push({ method, url, body });
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
  async connect(url) {
    this.calls.push({ url });
    return this.events;
  }
}

describe('DriverRegistry', () => {
  it('注册 opencode driver', () => {
    const reg = new DriverRegistry();
    const driver = new OpencodeDriver({});
    reg.register('opencode', driver);
    assert.equal(reg.get('opencode'), driver);
  });

  it('获取未注册 driver 返回 null', () => {
    const reg = new DriverRegistry();
    assert.equal(reg.get('unknown'), null);
  });

  it('列出已注册 driver', () => {
    const reg = new DriverRegistry();
    reg.register('opencode', new OpencodeDriver({}));
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
    const http = new FakeHttpClient({ 'GET http://localhost:4096/api/v1/health': { status: 200, data: { ok: true } } });
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
        if (url === 'http://localhost:4096/api/v1/health') {
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
    const http = new FakeHttpClient({ 'GET http://localhost:4096/api/v1/health': { error: new Error('ECONNREFUSED') } });
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096', autostart: false });
    await assert.rejects(() => driver.ensureReady(), { message: /opencode server|ECONNREFUSED|serverUrl/i });
  });
});

describe('OpencodeDriver createSession', () => {
  it('调用 POST /session 创建 opencode session', async () => {
    const http = new FakeHttpClient({
      'POST http://localhost:4096/api/v1/session': {
        status: 201,
        data: { id: 'ses_abc123', title: 'walker session', state: 'pending' },
      },
    });
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096' });
    const result = await driver.createSession({ title: 'walker session', cwd: '/home/user/project' });
    assert.equal(result.opencodeSessionId, 'ses_abc123');
    assert.equal(result.serverUrl, 'http://localhost:4096');
    assert.equal(http.calls[0].body.cwd, '/home/user/project');
  });

  it('创建失败时抛错含 serverUrl', async () => {
    const http = new FakeHttpClient({
      'POST http://localhost:4096/api/v1/session': { error: new Error('Internal Server Error') },
    });
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096' });
    await assert.rejects(() => driver.createSession({}), { message: /serverUrl|opencode/i });
  });
});

describe('OpencodeDriver prompt with SSE', () => {
  const sessionRef = { opencodeSessionId: 'ses_abc', serverUrl: 'http://localhost:4096' };

  it('prompt 发送消息并通过 SSE 接收事件映射为 AgentEvent', async () => {
    const sseEvents = [
      { type: 'message.part.updated', properties: { part: { type: 'text', text: 'Hello world' } } },
      { type: 'message.part.updated', properties: { part: { type: 'tool-use', name: 'Bash', state: 'completed', input: 'ls -la' } } },
      { type: 'session.status', properties: { status: { type: 'idle' } } },
    ];
    const http = new FakeHttpClient({});
    const sse = new FakeSSEClient(sseEvents);
    const driver = new OpencodeDriver({ httpClient: http, sseClient: sse, serverUrl: 'http://localhost:4096' });

    const events = await driver.prompt(sessionRef, '请帮我分析代码');

    assert.equal(events.length, 3);
    assert.equal(events[0].type, 'text');
    assert.equal(events[0].data.text, 'Hello world');
    assert.equal(events[1].type, 'tool_use');
    assert.equal(events[1].data.name, 'Bash');
    assert.equal(events[2].type, 'done');
  });

  it('SSE 包含 reasoning 事件映射为 reasoning AgentEvent', async () => {
    const sseEvents = [
      { type: 'message.part.updated', properties: { part: { type: 'reasoning', text: 'Let me think...' } } },
      { type: 'session.status', properties: { status: { type: 'idle' } } },
    ];
    const http = new FakeHttpClient({});
    const sse = new FakeSSEClient(sseEvents);
    const driver = new OpencodeDriver({ httpClient: http, sseClient: sse, serverUrl: 'http://localhost:4096' });

    const events = await driver.prompt(sessionRef, '思考一下');

    assert.equal(events[0].type, 'reasoning');
    assert.equal(events[0].data.text, 'Let me think...');
    assert.equal(events[1].type, 'done');
  });

  it('SSE 包含 error 事件映射为 error AgentEvent', async () => {
    const sseEvents = [
      { type: 'session.error', properties: { error: { message: 'API quota exceeded' } } },
    ];
    const http = new FakeHttpClient({});
    const sse = new FakeSSEClient(sseEvents);
    const driver = new OpencodeDriver({ httpClient: http, sseClient: sse, serverUrl: 'http://localhost:4096' });

    const events = await driver.prompt(sessionRef, 'test');

    assert.equal(events[0].type, 'error');
    assert.ok(events[0].data.message.includes('API quota exceeded'));
  });
});

describe('OpencodeDriver stop and delete', () => {
  const sessionRef = { opencodeSessionId: 'ses_abc', serverUrl: 'http://localhost:4096' };

  it('stop 调用 POST /session/:id/stop', async () => {
    const http = new FakeHttpClient({
      'POST http://localhost:4096/api/v1/session/ses_abc/stop': { status: 204, data: null },
    });
    const driver = new OpencodeDriver({ httpClient: http, serverUrl: 'http://localhost:4096' });
    await driver.stop(sessionRef);
    assert.equal(http.calls[0].method, 'POST');
    assert.ok(http.calls[0].url.includes('/session/ses_abc/stop'));
  });

  it('delete 调用 DELETE /session/:id', async () => {
    const http = new FakeHttpClient({
      'DELETE http://localhost:4096/api/v1/session/ses_abc': { status: 204, data: null },
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
