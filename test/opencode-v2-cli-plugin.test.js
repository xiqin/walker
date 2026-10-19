const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { pathToFileURL } = require('url');
const { installHookPlugin } = require('../src/opencode-hook/installer');
const { getPluginSource, getV2PluginEntrySource, getV1PluginEntrySource } = require('../src/opencode-hook/plugin-template');

function createTempConfigDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'walker-hook-v2-'));
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 2000);
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待 TUI plugin 执行超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('无法解析的 cli.json 不会被覆盖', () => {
  const tmpDir = createTempConfigDir();
  const configPath = path.join(tmpDir, 'cli.json');
  fs.writeFileSync(configPath, '{', 'utf8');

  const result = installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });

  assert.equal(result.installed, false);
  assert.equal(result.reason, 'error');
  assert.equal(fs.readFileSync(configPath, 'utf8'), '{');
  assert.equal(fs.existsSync(path.join(tmpDir, 'walker-tui-plugin.js')), false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('安装时从旧 tui.json 移除 Walker 插件并保留其他配置', () => {
  const tmpDir = createTempConfigDir();
  const tuiPath = path.join(tmpDir, 'tui.json');
  const oldPlugin = path.join(tmpDir, 'old-walker-tui-plugin.js');
  fs.writeFileSync(oldPlugin, '// Walker TUI bridge version: 3\n', 'utf8');
  const { pathToFileURL } = require('url');
  fs.writeFileSync(tuiPath, JSON.stringify({
    theme: 'custom',
    plugin: [pathToFileURL(oldPlugin).href, 'file:///old/walker-tui-plugin.js', 'other-plugin'],
  }, null, 2), 'utf8');

  const result = installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });

  assert.equal(result.installed, true);
  const tuiConfig = JSON.parse(fs.readFileSync(tuiPath, 'utf8'));
  assert.equal(tuiConfig.theme, 'custom');
  assert.equal(tuiConfig.plugin.includes('other-plugin'), true);
  assert.equal(tuiConfig.plugin.includes('file:///old/walker-tui-plugin.js'), true);
  assert.equal(tuiConfig.plugin.some((entry) => entry.includes('walker-tui-plugin-v1.js')), true);
  assert.equal(tuiConfig.plugin.includes(pathToFileURL(oldPlugin).href), false);
  const cliConfig = JSON.parse(fs.readFileSync(path.join(tmpDir, 'cli.json'), 'utf8'));
  assert.equal(cliConfig.plugins.filter((entry) => entry === pathToFileURL(path.join(tmpDir, 'walker-tui-plugin')).href).length, 1);
  assert.equal(cliConfig.plugins.some((entry) => entry.includes('walker-tui-plugin-v1.js')), false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('生成的 CLI plugin 用 V2 setup 执行 prompt、权限和表单', async () => {
  const source = getPluginSource(8787, 'token-test');
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  assert.equal(plugin.default.id, 'walker-tui-bridge');
  assert.equal(typeof plugin.default.setup, 'function');

  const requests = [];
  const handlers = new Map();
  const promptCalls = [];
  const switchCalls = [];
  const formCalls = [];
  let dispose;
  let delivery = null;
  const originalFetch = global.fetch;
  const messages = [];

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    if (String(url).endsWith('/poll')) {
      const next = delivery;
      delivery = null;
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { delivery: next } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
  };

  try {
    dispose = await plugin.default.setup({
      app: { version: '2.0.32' },
      location: { directory: 'H:\\walker', workspaceID: 'ws_1' },
      ui: { router: { current: () => ({ type: 'session', sessionID: 'ses_v2' }), navigate() {} } },
      data: {
        on(type, handler) {
          handlers.set(type, handler);
          return () => handlers.delete(type);
        },
        session: {
          status: () => 'idle',
          message: { list: () => messages },
        },
      },
      client: {
        session: {
          async prompt(input) {
            promptCalls.push(input);
            return { id: 'in_1', sessionID: input.sessionID, type: 'user' };
          },
          async switchModel(input) {
            switchCalls.push(input);
          },
          form: {
            reply(input) {
              formCalls.push(input);
              return Promise.resolve();
            },
          },
        },
      },
    });

    await waitFor(() => requests.some((request) => request.url.endsWith('/register') && request.body.sessionId === 'ses_v2'));

    delivery = {
      deliveryId: 'del_v2',
      type: 'prompt',
      sessionId: 'ses_v2',
      text: 'hello v2',
      model: { providerID: 'xai', modelID: 'grok' },
    };
    await waitFor(() => promptCalls.length === 1);
    assert.deepEqual(switchCalls[0], { sessionID: 'ses_v2', model: { id: 'grok', providerID: 'xai' } });
    assert.deepEqual(promptCalls[0], { sessionID: 'ses_v2', text: 'hello v2' });
    messages.push({
      id: 'msg_v2',
      type: 'assistant',
      time: { created: 1, completed: 2 },
      model: { id: 'grok', providerID: 'xai' },
      tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 }, total: 3 },
      content: [
        { type: 'text', text: 'v2-ok' },
        { type: 'tool', name: 'read', state: { status: 'completed', input: { file: 'a.js' }, content: [{ type: 'text', text: 'done' }] } },
      ],
    });

    await handlers.get('session.execution.succeeded')({ type: 'session.execution.succeeded', data: { sessionID: 'ses_v2' } });
    await waitFor(() => requests.some((request) => request.url.endsWith('/events') && request.body.assistantMessageId === 'msg_v2'));
    const finalReport = requests.find((request) => request.body && request.body.assistantMessageId === 'msg_v2');
    assert.equal(finalReport.body.deliveryState, 'final');
    assert.equal(finalReport.body.events.some((event) => event.type === 'text' && event.data.text === 'v2-ok'), true);
    assert.equal(finalReport.body.events.some((event) => event.type === 'tool_use' && event.data.name === 'read' && event.data.output === 'done'), true);
    const done = finalReport.body.events.find((event) => event.type === 'done');
    assert.deepEqual(done.data.usage, {
      inputTokens: 1,
      outputTokens: 2,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 3,
    });

    await handlers.get('permission.asked')({
      type: 'permission.asked',
      data: {
        id: 'perm_v2',
        sessionID: 'ses_v2',
        action: 'edit',
        resources: ['src/a.js'],
        message: 'edit a.js',
        source: { type: 'tool', messageID: 'msg_v2', id: 'call_v2' },
      },
    });
    await waitFor(() => requests.some((request) => (request.body.events || []).some((event) => event.type === 'permission' && event.data.id === 'perm_v2')));
    const permission = requests.flatMap((request) => request.body.events || []).find((event) => event.type === 'permission' && event.data.id === 'perm_v2');
    assert.equal(permission.data.type, 'edit');
    assert.equal(permission.data.messageID, 'msg_v2');
    assert.equal(permission.data.callID, 'call_v2');

    await handlers.get('form.created')({
      type: 'form.created',
      data: {
        form: {
          id: 'form_v2',
          sessionID: 'ses_v2',
          title: '确认',
          fields: [{ key: 'mode', type: 'string', title: '模式', options: [{ value: 'safe', label: '稳妥' }] }],
        },
      },
    });
    await waitFor(() => requests.some((request) => (request.body.events || []).some((event) => event.type === 'question_asked' && event.data.requestID === 'form_v2')));

    delivery = {
      deliveryId: 'del_form',
      type: 'question_reply',
      sessionId: 'ses_v2',
      requestID: 'form_v2',
      answers: [['稳妥']],
    };
    await waitFor(() => formCalls.length === 1);
    assert.deepEqual(formCalls[0], { sessionID: 'ses_v2', formID: 'form_v2', answer: { mode: 'safe' } });
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('完成事件早于新回复进入缓存时不发送旧回复', async () => {
  const source = getPluginSource(8787, 'token-test');
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  const handlers = new Map();
  const promptCalls = [];
  let dispose;
  let delivery = null;
  const originalFetch = global.fetch;
  const messages = [{
    id: 'msg_old',
    type: 'assistant',
    time: { created: 1, completed: 2 },
    model: { id: 'grok', providerID: 'xai' },
    tokens: { input: 9, output: 8, reasoning: 0, cache: { read: 0, write: 0 } },
    content: [{ type: 'text', text: 'OLD_REPLY_SENTINEL' }],
  }];

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    if (String(url).endsWith('/poll')) {
      const next = delivery;
      delivery = null;
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { delivery: next } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
  };

  try {
    dispose = await plugin.default.setup({
      app: { version: '2.0.32' },
      location: { directory: 'H:\\walker' },
      ui: { router: { current: () => ({ type: 'session', sessionID: 'ses_race' }), navigate() {} } },
      data: {
        on(type, handler) {
          handlers.set(type, handler);
          return () => handlers.delete(type);
        },
        session: {
          status: () => 'idle',
          message: { list: () => messages },
        },
      },
      client: {
        session: {
          async prompt(input) {
            promptCalls.push(input);
            return { id: 'in_race', sessionID: input.sessionID, type: 'user' };
          },
        },
      },
    });

    await waitFor(() => requests.some((request) => request.url.endsWith('/register') && request.body.sessionId === 'ses_race'));
    delivery = { deliveryId: 'del_race', type: 'prompt', sessionId: 'ses_race', text: '新问题' };
    await waitFor(() => promptCalls.length === 1);

    await handlers.get('session.execution.succeeded')({ type: 'session.execution.succeeded', data: { sessionID: 'ses_race' } });
    assert.equal(
      requests.some((request) => JSON.stringify(request.body).includes('OLD_REPLY_SENTINEL')),
      false,
      '完成事件早于缓存同步时不得发送旧回复',
    );

    messages.push({
      id: 'msg_new',
      type: 'assistant',
      time: { created: 10, completed: 11 },
      model: { id: 'grok', providerID: 'xai' },
      tokens: { input: 3, output: 4, reasoning: 1, cache: { read: 2, write: 1 }, total: 11 },
      content: [
        { type: 'text', text: 'NEW_REPLY' },
        { type: 'tool', name: 'read', state: { status: 'completed', input: { file: 'a.js' }, content: [{ type: 'text', text: 'tool-out' }] } },
      ],
    });
    await handlers.get('session.execution.succeeded')({ type: 'session.execution.succeeded', data: { sessionID: 'ses_race' } });
    const finalReport = requests.find((request) => request.body && request.body.assistantMessageId === 'msg_new');
    assert.ok(finalReport, '缓存同步后应上报本轮回复');
    assert.equal(finalReport.body.events.some((event) => event.type === 'text' && event.data.text === 'NEW_REPLY'), true);
    assert.equal(requests.some((request) => JSON.stringify(request.body).includes('OLD_REPLY_SENTINEL')), false);
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('隐藏字段位于首中尾时按序号回填会错位', async () => {
  const source = getPluginSource(8787, 'token-test');
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  const handlers = new Map();
  const formCalls = [];
  let dispose;
  let delivery = null;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    if (String(url).endsWith('/poll')) {
      const next = delivery;
      delivery = null;
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { delivery: next } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
  };

  try {
    dispose = await plugin.default.setup({
      app: { version: '2.0.32' },
      location: { directory: 'H:\\walker' },
      ui: { router: { current: () => ({ type: 'session', sessionID: 'ses_form' }), navigate() {} } },
      data: {
        on(type, handler) {
          handlers.set(type, handler);
          return () => handlers.delete(type);
        },
        session: { status: () => 'idle', message: { list: () => [] } },
      },
      client: {
        session: {
          form: {
            reply(input) {
              formCalls.push(input);
              return Promise.resolve();
            },
          },
        },
      },
    });

    await waitFor(() => requests.some((request) => request.url.endsWith('/register')));
    await handlers.get('form.created')({
      type: 'form.created',
      data: {
        form: {
          id: 'form_shift',
          sessionID: 'ses_form',
          title: '确认',
          fields: [
            { key: 'hidden_first', type: 'string', title: '隐藏首', hidden: true },
            { key: 'mode', type: 'string', title: '模式', default: 'safe', options: [{ value: 'safe', label: '稳妥' }, { value: 'fast', label: '快速' }] },
            { key: 'hidden_mid', type: 'string', title: '隐藏中', hidden: true },
            { key: 'count', type: 'integer', title: '数量' },
            { key: 'note', type: 'string', title: '备注', when: [{ key: 'mode', op: 'eq', value: 'safe' }] },
            { key: 'hidden_last', type: 'string', title: '隐藏尾', hidden: true },
            { key: 'secret', type: 'string', title: '机密', when: [{ key: 'mode', op: 'eq', value: 'fast' }] },
          ],
        },
      },
    });
    await waitFor(() => requests.some((request) => (request.body.events || []).some((event) => event.type === 'question_asked' && event.data.requestID === 'form_shift')));
    const asked = requests.flatMap((request) => request.body.events || []).find((event) => event.type === 'question_asked' && event.data.requestID === 'form_shift');
    assert.deepEqual(asked.data.questions.map((question) => question.question), ['模式', '数量', '备注']);

    delivery = {
      deliveryId: 'del_shift',
      type: 'question_reply',
      sessionId: 'ses_form',
      requestID: 'form_shift',
      answers: [['稳妥'], ['4'], ['记下']],
    };
    await waitFor(() => formCalls.length === 1);
    assert.deepEqual(formCalls[0].answer, { mode: 'safe', count: 4, note: '记下' });
    assert.equal(Object.prototype.hasOwnProperty.call(formCalls[0].answer, 'hidden_first'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(formCalls[0].answer, 'hidden_mid'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(formCalls[0].answer, 'hidden_last'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(formCalls[0].answer, 'secret'), false);
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

function pluginDataUrl(token, heartbeatMs) {
  return 'data:text/javascript;base64,' + Buffer.from(getPluginSource(8787, token || 'token-test', heartbeatMs)).toString('base64');
}

function finalReports(requests, deliveryId) {
  return requests.filter((request) => request.url.endsWith('/events')
    && request.body
    && request.body.deliveryState === 'final'
    && (!deliveryId || request.body.deliveryId === deliveryId));
}

function createV2Harness(sessionId, options) {
  const opts = options || {};
  const requests = [];
  const handlers = new Map();
  const promptCalls = [];
  const formCalls = [];
  let delivery = null;
  const state = {
    requests,
    handlers,
    promptCalls,
    formCalls,
    get delivery() { return delivery; },
    set delivery(value) { delivery = value; },
  };
  const api = {
    app: { version: '2.0.32' },
    location: { directory: 'H:\\walker' },
    ui: { router: { current: () => ({ type: 'session', sessionID: sessionId }), navigate() {} } },
    data: {
      on(type, handler) {
        handlers.set(type, handler);
        return () => handlers.delete(type);
      },
      session: {
        status: () => 'idle',
        message: {
          list() {
            if (opts.list) return opts.list();
            return opts.messages || [];
          },
        },
      },
    },
    client: {
      session: {
        async prompt(input) {
          promptCalls.push(input);
          if (opts.onPrompt) return opts.onPrompt(input);
          return { id: 'in_1', sessionID: input.sessionID, type: 'user' };
        },
        form: {
          reply(input) {
            formCalls.push(input);
            return Promise.resolve();
          },
        },
      },
    },
  };
  const fetchImpl = async (url, requestOptions) => {
    const body = JSON.parse(requestOptions.body);
    requests.push({ url: String(url), body });
    if (opts.onRequest) {
      const custom = await opts.onRequest(String(url), body);
      if (custom) return custom;
    }
    if (String(url).endsWith('/poll')) {
      const next = delivery;
      delivery = null;
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { delivery: next } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
  };
  return { state, api, fetchImpl };
}

async function fireIdle(handlers, sessionId) {
  await handlers.get('session.execution.succeeded')({
    type: 'session.execution.succeeded',
    data: { sessionID: sessionId },
  });
}

function completedMessage(id, text, completedAt) {
  return {
    id,
    type: 'assistant',
    time: { created: 10, completed: completedAt == null ? 11 : completedAt },
    model: { id: 'grok', providerID: 'xai' },
    tokens: { input: 3, output: 4, reasoning: 1, cache: { read: 2, write: 1 }, total: 11 },
    content: [
      { type: 'text', text },
      { type: 'tool', name: 'read', state: { status: 'completed', input: { file: 'a.js' }, content: [{ type: 'text', text: 'tool-out' }] } },
    ],
  };
}

test('首次 final 上报失败后可重试，成功后重复完成事件不再上报', async () => {
  const messages = [completedMessage('msg_old', 'OLD_REPLY_SENTINEL')];
  let failFinal = true;
  const harness = createV2Harness('ses_retry', {
    messages,
    onRequest(url, body) {
      if (url.endsWith('/events') && body.deliveryState === 'final' && failFinal) {
        failFinal = false;
        return { ok: false, status: 503, json: async () => ({ ok: false, error: { message: 'upstream down' } }) };
      }
      return null;
    },
  });
  const originalFetch = global.fetch;
  global.fetch = harness.fetchImpl;
  let dispose;
  try {
    const plugin = await import(pluginDataUrl('token-test', 100));
    dispose = await plugin.default.setup(harness.api);
    await waitFor(() => harness.state.requests.some((request) => request.url.endsWith('/register')));
    harness.state.delivery = { deliveryId: 'del_retry', type: 'prompt', sessionId: 'ses_retry', text: '新问题' };
    await waitFor(() => harness.state.promptCalls.length === 1);
    messages.push(completedMessage('msg_new', 'NEW_REPLY_AFTER_RETRY'));

    await fireIdle(harness.state.handlers, 'ses_retry');
    await waitFor(() => finalReports(harness.state.requests, 'del_retry').length === 1);
    const afterFailure = harness.state.requests.length;
    await waitFor(() => harness.state.requests.slice(afterFailure).some((request) => request.body.deliveryState === 'heartbeat' && request.body.deliveryId === 'del_retry'), 2000);
    assert.equal(harness.state.requests.some((request) => JSON.stringify(request.body).includes('OLD_REPLY_SENTINEL')), false);

    await fireIdle(harness.state.handlers, 'ses_retry');
    await waitFor(() => finalReports(harness.state.requests, 'del_retry').length === 2);
    const recovered = finalReports(harness.state.requests, 'del_retry')[1];
    assert.equal(recovered.body.assistantMessageId, 'msg_new');
    assert.equal(recovered.body.events.some((event) => event.type === 'text' && event.data.text === 'NEW_REPLY_AFTER_RETRY'), true);
    assert.equal(recovered.body.events.some((event) => event.type === 'tool_use' && event.data.output === 'tool-out'), true);
    assert.equal(recovered.body.events.some((event) => event.type === 'done' && event.data.usage && event.data.usage.totalTokens === 11), true);
    assert.equal(harness.state.requests.some((request) => JSON.stringify(request.body).includes('OLD_REPLY_SENTINEL')), false);

    const settled = finalReports(harness.state.requests, 'del_retry').length;
    await fireIdle(harness.state.handlers, 'ses_retry');
    assert.equal(finalReports(harness.state.requests, 'del_retry').length, settled);
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('空缓存、无完成标记和缓存读取失败时不报告错误完成，恢复后仍上报本轮回复', async () => {
  const messages = [];
  let phase = 'throw';
  const harness = createV2Harness('ses_recover', {
    list() {
      if (phase === 'throw') throw new Error('cache sync failed');
      return messages.slice();
    },
  });
  const originalFetch = global.fetch;
  global.fetch = harness.fetchImpl;
  let dispose;
  try {
    const plugin = await import(pluginDataUrl());
    dispose = await plugin.default.setup(harness.api);
    await waitFor(() => harness.state.requests.some((request) => request.url.endsWith('/register')));
    harness.state.delivery = { deliveryId: 'del_recover', type: 'prompt', sessionId: 'ses_recover', text: '继续' };
    await waitFor(() => harness.state.promptCalls.length === 1);

    await fireIdle(harness.state.handlers, 'ses_recover');
    assert.equal(finalReports(harness.state.requests).length, 0);
    assert.equal(harness.state.requests.some((request) => request.body && request.body.error), false);

    phase = 'ready';
    await fireIdle(harness.state.handlers, 'ses_recover');
    assert.equal(finalReports(harness.state.requests).length, 0);

    messages.push({
      id: 'msg_partial',
      role: 'assistant',
      time: { created: 1 },
      content: [{ type: 'text', text: 'PARTIAL_SHOULD_NOT_SEND' }],
    });
    await fireIdle(harness.state.handlers, 'ses_recover');
    assert.equal(finalReports(harness.state.requests).length, 0);
    assert.equal(harness.state.requests.some((request) => JSON.stringify(request.body).includes('PARTIAL_SHOULD_NOT_SEND')), false);
    assert.equal(harness.state.requests.some((request) => request.body && request.body.error), false);

    messages.push(completedMessage('msg_recovered', 'RECOVERED_REPLY', Date.now()));
    await fireIdle(harness.state.handlers, 'ses_recover');
    await waitFor(() => finalReports(harness.state.requests, 'del_recover').length === 1);
    const recovered = finalReports(harness.state.requests, 'del_recover')[0];
    assert.equal(recovered.body.error, null);
    assert.equal(recovered.body.assistantMessageId, 'msg_recovered');
    assert.equal(recovered.body.events.some((event) => event.type === 'text' && event.data.text === 'RECOVERED_REPLY'), true);
    assert.equal(recovered.body.events.some((event) => event.type === 'tool_use' && event.data.name === 'read'), true);
    assert.equal(recovered.body.events.some((event) => event.type === 'done' && event.data.usage.outputTokens === 4), true);
    assert.equal(harness.state.requests.some((request) => JSON.stringify(request.body).includes('PARTIAL_SHOULD_NOT_SEND')), false);
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('基线读取失败后第一次成功读取已含本轮完成回复时仍上报且不发送旧回复', async () => {
  const messages = [completedMessage('msg_old', 'OLD_REPLY_SENTINEL')];
  let phase = 'throw';
  const harness = createV2Harness('ses_baseline_late', {
    list() {
      if (phase === 'throw') throw new Error('cache sync failed');
      return messages.slice();
    },
  });
  const originalFetch = global.fetch;
  global.fetch = harness.fetchImpl;
  let dispose;
  try {
    const plugin = await import(pluginDataUrl());
    dispose = await plugin.default.setup(harness.api);
    await waitFor(() => harness.state.requests.some((request) => request.url.endsWith('/register')));
    harness.state.delivery = { deliveryId: 'del_baseline_late', type: 'prompt', sessionId: 'ses_baseline_late', text: '本轮问题' };
    await waitFor(() => harness.state.promptCalls.length === 1);

    messages.push(completedMessage('msg_current', 'CURRENT_REPLY_AFTER_BASELINE_FAIL', Date.now()));
    phase = 'ready';
    await fireIdle(harness.state.handlers, 'ses_baseline_late');
    await waitFor(() => finalReports(harness.state.requests, 'del_baseline_late').length === 1);

    const reports = finalReports(harness.state.requests, 'del_baseline_late');
    assert.equal(reports.length, 1);
    const reported = reports[0];
    assert.equal(reported.body.error, null);
    assert.equal(reported.body.assistantMessageId, 'msg_current');
    assert.equal(reported.body.events.some((event) => event.type === 'text' && event.data.text === 'CURRENT_REPLY_AFTER_BASELINE_FAIL'), true);
    assert.equal(reported.body.events.some((event) => event.type === 'tool_use' && event.data.name === 'read' && event.data.output === 'tool-out'), true);
    assert.equal(reported.body.events.some((event) => event.type === 'done' && event.data.usage && event.data.usage.outputTokens === 4 && event.data.usage.totalTokens === 11), true);
    assert.equal(harness.state.requests.some((request) => request.body && request.body.deliveryId === 'del_baseline_late' && request.body.error), false);
    assert.equal(harness.state.requests.some((request) => JSON.stringify(request.body).includes('OLD_REPLY_SENTINEL')), false);
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('已发送的旧消息不会提前终结仍在等待本轮回复的新 delivery', async () => {
  const messages = [];
  const harness = createV2Harness('ses_sent_old', { messages });
  const originalFetch = global.fetch;
  global.fetch = harness.fetchImpl;
  let dispose;
  try {
    const plugin = await import(pluginDataUrl('token-test', 100));
    dispose = await plugin.default.setup(harness.api);
    await waitFor(() => harness.state.requests.some((request) => request.url.endsWith('/register')));

    harness.state.delivery = { deliveryId: 'del_prev', type: 'prompt', sessionId: 'ses_sent_old', text: '上一轮' };
    await waitFor(() => harness.state.promptCalls.length === 1);
    messages.push(completedMessage('msg_old', 'OLD_REPLY_SENTINEL'));
    await fireIdle(harness.state.handlers, 'ses_sent_old');
    await waitFor(() => finalReports(harness.state.requests, 'del_prev').length === 1);

    messages.length = 0;
    harness.state.delivery = { deliveryId: 'del_next', type: 'prompt', sessionId: 'ses_sent_old', text: '本轮' };
    await waitFor(() => harness.state.promptCalls.length === 2);
    messages.push(completedMessage('msg_old', 'OLD_REPLY_SENTINEL'));
    const afterStaleIdle = harness.state.requests.length;
    await fireIdle(harness.state.handlers, 'ses_sent_old');
    assert.equal(finalReports(harness.state.requests, 'del_next').length, 0);
    assert.equal(harness.state.requests.some((request) => request.body && request.body.deliveryId === 'del_next' && request.body.error), false);
    await waitFor(() => harness.state.requests.slice(afterStaleIdle).some((request) => request.body.deliveryState === 'heartbeat' && request.body.deliveryId === 'del_next'), 2000);

    messages.push(completedMessage('msg_current', 'CURRENT_REPLY_AFTER_OLD'));
    await fireIdle(harness.state.handlers, 'ses_sent_old');
    await waitFor(() => finalReports(harness.state.requests, 'del_next').length === 1);
    await fireIdle(harness.state.handlers, 'ses_sent_old');
    const nextReports = finalReports(harness.state.requests, 'del_next');
    assert.equal(nextReports.length, 1);
    assert.equal(nextReports[0].body.error, null);
    assert.equal(nextReports[0].body.assistantMessageId, 'msg_current');
    assert.equal(nextReports[0].body.events.some((event) => event.type === 'text' && event.data.text === 'CURRENT_REPLY_AFTER_OLD'), true);
    assert.equal(harness.state.requests.some((request) => request.body && request.body.deliveryId === 'del_next' && JSON.stringify(request.body).includes('OLD_REPLY_SENTINEL')), false);
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

function writePluginTree(dir, token) {
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(dir, 'walker-tui-bridge.js'), getPluginSource(8787, token || 'token-test'));
  fs.writeFileSync(path.join(dir, 'walker-tui-plugin.js'), getV2PluginEntrySource());
  fs.writeFileSync(path.join(dir, 'walker-tui-plugin-v1.js'), getV1PluginEntrySource());
}

function writeFakePluginPackage(dir, source) {
  const pkgDir = path.join(dir, 'node_modules', '@opencode', 'plugin');
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({
    name: '@opencode/plugin',
    type: 'module',
    exports: { './tui': './tui.js' },
  }));
  fs.writeFileSync(path.join(pkgDir, 'tui.js'), source);
}

async function expectImportRejected(url, pattern) {
  await assert.rejects(() => import(url), (error) => {
    assert.match(String(error && (error.message || error)), pattern);
    return true;
  });
}

test('V2 入口经 Plugin.define 加载后启动桥接', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-v2-entry-'));
  writePluginTree(dir);
  writeFakePluginPackage(dir, 'export const Plugin = { define(plugin) { return Object.assign({ definedBy: "opencode-plugin-tui" }, plugin); } };\n');
  const entry = fs.readFileSync(path.join(dir, 'walker-tui-plugin.js'), 'utf8');
  assert.equal(entry.includes('try'), false);
  assert.equal(entry.includes('define(plugin)'), false);
  assert.match(entry, /Plugin\.define\(/);
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
  };
  let dispose;
  try {
    const plugin = await import(pathToFileURL(path.join(dir, 'walker-tui-plugin.js')).href);
    assert.equal(plugin.default.definedBy, 'opencode-plugin-tui');
    assert.equal(plugin.default.id, 'walker-tui-bridge');
    dispose = await plugin.default.setup({
      app: { version: '2.0.32' },
      location: { directory: dir },
      ui: { router: { current: () => ({ type: 'session', sessionID: 'ses_v2_entry' }), navigate() {} } },
      data: { on() { return () => {}; }, session: { status: () => 'idle', message: { list: () => [] } } },
    });
    await waitFor(() => requests.some((request) => request.url.endsWith('/register') && request.body.sessionId === 'ses_v2_entry'));
    await waitFor(() => requests.some((request) => request.url.endsWith('/poll')));
    assert.equal(new Set(requests.filter((request) => request.url.endsWith('/register')).map((request) => request.body.runtimeId)).size, 1);
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('V2 缺包或没有 Plugin.define 时导入失败且不轮询', async () => {
  const missingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-v2-missing-'));
  const badDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-v2-bad-define-'));
  writePluginTree(missingDir);
  writePluginTree(badDir);
  writeFakePluginPackage(badDir, 'export const Plugin = { name: "missing-define" };\n');
  let calls = 0;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
  };
  try {
    await expectImportRejected(pathToFileURL(path.join(missingDir, 'walker-tui-plugin.js')).href, /Cannot find package|ERR_MODULE_NOT_FOUND/);
    await expectImportRejected(pathToFileURL(path.join(badDir, 'walker-tui-plugin.js')).href, /define/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls, 0);
  } finally {
    global.fetch = originalFetch;
    fs.rmSync(missingDir, { recursive: true, force: true });
    fs.rmSync(badDir, { recursive: true, force: true });
  }
});

test('V2 缺包失败后补上有效导出再导入只建立一条桥接', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-v2-reload-'));
  writePluginTree(dir);
  const entryUrl = pathToFileURL(path.join(dir, 'walker-tui-plugin.js')).href;
  const requests = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
  };
  let dispose;
  try {
    await expectImportRejected(entryUrl, /Cannot find package|ERR_MODULE_NOT_FOUND/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(requests.length, 0);
    writeFakePluginPackage(dir, 'export const Plugin = { define(plugin) { return plugin; } };\n');
    const plugin = await import(entryUrl + '?reload=1');
    dispose = await plugin.default.setup({
      app: { version: '2.0.32' },
      location: { directory: dir },
      ui: { router: { current: () => ({ type: 'session', sessionID: 'ses_reload' }), navigate() {} } },
      data: { on() { return () => {}; }, session: { status: () => 'idle', message: { list: () => [] } } },
    });
    await waitFor(() => requests.some((request) => request.url.endsWith('/register') && request.body.sessionId === 'ses_reload'));
    await waitFor(() => requests.some((request) => request.url.endsWith('/poll')));
    assert.equal(new Set(requests.filter((request) => request.url.endsWith('/register')).map((request) => request.body.runtimeId)).size, 1);
    assert.equal(requests.filter((request) => request.url.endsWith('/poll')).length >= 1, true);
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('V1 入口完成 register、poll、events 和 dispose', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-v1-entry-'));
  writePluginTree(dir);
  const source = fs.readFileSync(path.join(dir, 'walker-tui-plugin-v1.js'), 'utf8');
  assert.equal(source.includes('@opencode/plugin/tui'), false);
  assert.match(source, /tui\(api\) \{\s*return setup\(api\);/);
  const requests = [];
  const handlers = new Map();
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
  };
  let dispose;
  try {
    const plugin = await import(pathToFileURL(path.join(dir, 'walker-tui-plugin-v1.js')).href);
    dispose = await plugin.default.tui({
      app: { version: '1.18.0' },
      route: { current: { name: 'session', params: { sessionID: 'ses_v1' } }, navigate() {} },
      event: { on(type, handler) { handlers.set(type, handler); return () => handlers.delete(type); } },
      state: { path: { directory: dir }, session: { status: () => ({ type: 'idle' }), messages: {} } },
      client: { session: { async promptAsync() { return {}; } } },
    });
    await waitFor(() => requests.some((request) => request.url.endsWith('/register') && request.body.sessionId === 'ses_v1'));
    await waitFor(() => requests.some((request) => request.url.endsWith('/poll')));
    await handlers.get('permission.asked')({ properties: {
      id: 'perm_v1',
      sessionID: 'ses_v1',
      permission: 'edit',
      patterns: ['a.js'],
    } });
    await waitFor(() => requests.some((request) => request.url.endsWith('/events') && (request.body.events || []).some((event) => event.type === 'permission' && event.data.id === 'perm_v1')));
    const runtimeId = requests.find((request) => request.url.endsWith('/register')).body.runtimeId;
    await dispose();
    dispose = null;
    await waitFor(() => requests.some((request) => request.url.endsWith('/dispose') && request.body.runtimeId === runtimeId));
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function publishForm(handlers, form) {
  await handlers.get('form.created')({ type: 'form.created', data: { form } });
}

test('选项标签、多选和布尔值按可见字段 key 回填', async () => {
  const harness = createV2Harness('ses_mixed');
  const originalFetch = global.fetch;
  global.fetch = harness.fetchImpl;
  let dispose;
  try {
    const plugin = await import(pluginDataUrl());
    dispose = await plugin.default.setup(harness.api);
    await waitFor(() => harness.state.requests.some((request) => request.url.endsWith('/register')));
    await publishForm(harness.state.handlers, {
      id: 'form_mixed',
      sessionID: 'ses_mixed',
      title: '确认',
      fields: [
        { key: 'mode', type: 'string', title: '模式', options: [{ value: 'safe', label: '稳妥' }, { value: 'fast', label: '快速' }] },
        { key: 'tags', type: 'multiselect', title: '标签', options: [{ value: 'a', label: '甲' }, { value: 'b', label: '乙' }] },
        { key: 'confirm', type: 'boolean', title: '确认' },
        { key: 'hidden', type: 'string', title: '隐藏', hidden: true },
      ],
    });
    await waitFor(() => harness.state.requests.some((request) => (request.body.events || []).some((event) => event.type === 'question_asked' && event.data.requestID === 'form_mixed')));
    const asked = harness.state.requests.flatMap((request) => request.body.events || []).find((event) => event.data && event.data.requestID === 'form_mixed');
    assert.equal(asked.data.questions.length, 3);
    assert.equal(asked.data.questions[1].multiple, true);
    harness.state.delivery = {
      deliveryId: 'del_mixed',
      type: 'question_reply',
      sessionId: 'ses_mixed',
      requestID: 'form_mixed',
      answers: [['快速'], ['甲', '乙'], ['是']],
    };
    await waitFor(() => harness.state.formCalls.length === 1);
    assert.deepEqual(harness.state.formCalls[0], {
      sessionID: 'ses_mixed',
      formID: 'form_mixed',
      answer: { mode: 'fast', tags: ['a', 'b'], confirm: true },
    });
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('非法数字和缺失字段不调用 reply，完整有效回复后不再待答', async () => {
  const harness = createV2Harness('ses_invalid');
  const originalFetch = global.fetch;
  global.fetch = harness.fetchImpl;
  let dispose;
  try {
    const plugin = await import(pluginDataUrl());
    dispose = await plugin.default.setup(harness.api);
    await waitFor(() => harness.state.requests.some((request) => request.url.endsWith('/register')));
    await publishForm(harness.state.handlers, {
      id: 'form_invalid',
      sessionID: 'ses_invalid',
      title: '确认',
      fields: [
        { key: 'mode', type: 'string', title: '模式', default: 'safe', options: [{ value: 'safe', label: '稳妥' }] },
        { key: 'count', type: 'integer', title: '数量' },
        { key: 'ratio', type: 'number', title: '比例' },
        { key: 'note', type: 'string', title: '备注', when: [{ key: 'mode', op: 'eq', value: 'safe' }] },
        { key: 'secret', type: 'string', title: '机密', when: [{ key: 'mode', op: 'eq', value: 'fast' }] },
      ],
    });
    await waitFor(() => harness.state.requests.some((request) => (request.body.events || []).some((event) => event.type === 'question_asked' && event.data.requestID === 'form_invalid')));

    async function reply(deliveryId, answers) {
      harness.state.delivery = {
        deliveryId,
        type: 'question_reply',
        sessionId: 'ses_invalid',
        requestID: 'form_invalid',
        answers,
      };
      await waitFor(() => finalReports(harness.state.requests, deliveryId).length === 1, 4000);
      return finalReports(harness.state.requests, deliveryId)[0].body.error;
    }

    const missing = await reply('del_missing', [['稳妥'], ['4'], ['1.5']]);
    assert.equal(missing.code, 'FORM_REPLY_INVALID');
    assert.equal(missing.safeToRetry, true);
    assert.equal(missing.sdkInvoked, false);
    assert.match(missing.message, /visible fields/);
    assert.equal(harness.state.formCalls.length, 0);

    const invalid = await reply('del_bad_number', [['稳妥'], ['1.5'], ['abc'], ['记下']]);
    assert.equal(invalid.code, 'FORM_REPLY_INVALID');
    assert.equal(invalid.safeToRetry, true);
    assert.equal(invalid.sdkInvoked, false);
    assert.match(invalid.message, /count/);
    assert.match(invalid.message, /ratio/);
    assert.equal(harness.state.formCalls.length, 0);

    const accepted = await reply('del_valid', [['稳妥'], ['4'], ['1.5'], ['记下']]);
    assert.equal(accepted, null);
    await waitFor(() => harness.state.formCalls.length === 1);
    assert.deepEqual(harness.state.formCalls[0].answer, { mode: 'safe', count: 4, ratio: 1.5, note: '记下' });
    assert.equal(typeof harness.state.formCalls[0].answer.count, 'number');
    assert.equal(Number.isInteger(harness.state.formCalls[0].answer.count), true);
    assert.equal(typeof harness.state.formCalls[0].answer.ratio, 'number');

    const repeated = await reply('del_repeat', [['稳妥'], ['4'], ['1.5'], ['记下']]);
    assert.equal(repeated.code, 'FORM_ALREADY_REPLIED');
    assert.equal(repeated.safeToRetry, false);
    assert.equal(harness.state.formCalls.length, 1);
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('含哨兵正文的成功和失败日志只保留 delivery 标识、类型和阶段', async () => {
  const bodySentinel = 'FEISHU_BODY_SENTINEL_q8w3';
  const tokenSentinel = 'WALKER_TOKEN_SENTINEL_9f3a';
  const passwordSentinel = 'FEISHU_PASSWORD_SENTINEL_7c2b';
  const messages = [];
  let failFinal = true;
  const harness = createV2Harness('ses_log', {
    messages,
    onPrompt(input) {
      if (String(input.text).includes('THROW_PROMPT')) {
        throw new Error('sdk failed ' + tokenSentinel + ' ' + passwordSentinel);
      }
      return { id: 'in_log', sessionID: input.sessionID, type: 'user' };
    },
    onRequest(url, body) {
      if (url.endsWith('/events') && body.deliveryState === 'final' && body.deliveryId === 'del_log' && failFinal) {
        failFinal = false;
        return { ok: false, status: 503, json: async () => ({ ok: false }) };
      }
      return null;
    },
  });
  const logs = [];
  const originalFetch = global.fetch;
  const originalWarn = console.warn;
  const originalError = console.error;
  const originalLog = console.log;
  function capture(method, args) {
    logs.push(args);
    method(...args);
  }
  console.warn = (...args) => capture(originalWarn, args);
  console.error = (...args) => capture(originalError, args);
  console.log = (...args) => capture(originalLog, args);
  global.fetch = harness.fetchImpl;
  let dispose;
  try {
    const plugin = await import(pluginDataUrl(tokenSentinel));
    dispose = await plugin.default.setup(harness.api);
    await waitFor(() => harness.state.requests.some((request) => request.url.endsWith('/register')));
    harness.state.delivery = { deliveryId: 'del_log', type: 'prompt', sessionId: 'ses_log', text: bodySentinel };
    await waitFor(() => harness.state.promptCalls.length === 1);
    messages.push(completedMessage('msg_log', bodySentinel));
    await fireIdle(harness.state.handlers, 'ses_log');
    await waitFor(() => finalReports(harness.state.requests, 'del_log').length === 1);
    await fireIdle(harness.state.handlers, 'ses_log');
    await waitFor(() => finalReports(harness.state.requests, 'del_log').length === 2);

    harness.state.delivery = {
      deliveryId: 'del_throw',
      type: 'prompt',
      sessionId: 'ses_log',
      text: 'THROW_PROMPT ' + bodySentinel + ' ' + tokenSentinel + ' ' + passwordSentinel,
    };
    await waitFor(() => finalReports(harness.state.requests, 'del_throw').length === 1, 4000);

    const rendered = logs.map((args) => args.map((value) => {
      if (typeof value === 'string') return value;
      try { return JSON.stringify(value); } catch (_) { return String(value); }
    }).join(' ')).join('\n');
    assert.equal(rendered.includes(bodySentinel), false);
    assert.equal(rendered.includes(tokenSentinel), false);
    assert.equal(rendered.includes(passwordSentinel), false);
    const bridgeLogs = logs
      .filter((args) => args[0] === '[walker-bridge]' && args[1] && typeof args[1] === 'object')
      .map((args) => args[1]);
    for (const entry of bridgeLogs) {
      assert.deepEqual(Object.keys(entry).sort(), ['deliveryId', 'stage', 'type']);
    }
    assert.ok(bridgeLogs.some((entry) => entry.deliveryId === 'del_log' && entry.type === 'prompt' && entry.stage === 'received'));
    assert.ok(bridgeLogs.some((entry) => entry.deliveryId === 'del_log' && entry.type === 'prompt' && entry.stage === 'accepted'));
    assert.ok(bridgeLogs.some((entry) => entry.deliveryId === 'del_log' && entry.type === 'prompt' && entry.stage === 'report'));
    assert.ok(bridgeLogs.some((entry) => entry.deliveryId === 'del_log' && entry.type === 'prompt' && entry.stage === 'final'));
    assert.ok(bridgeLogs.some((entry) => entry.deliveryId === 'del_throw' && entry.type === 'prompt' && entry.stage === 'prompt'));
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
    console.warn = originalWarn;
    console.error = originalError;
    console.log = originalLog;
  }
});
