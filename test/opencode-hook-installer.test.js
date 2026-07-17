const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { installHookPlugin } = require('../src/opencode-hook/installer');
const { getPluginSource } = require('../src/opencode-hook/plugin-template');

function createTempConfigDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-hook-cfg-'));
  return { tmpDir };
}

test('installHookPlugin 写入 TUI plugin 并注册到 tui.json', () => {
  const { tmpDir } = createTempConfigDir();
  const targetPath = path.join(tmpDir, 'walker-tui-plugin.js');

  const result = installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });

  assert.equal(result.installed, true);
  assert.equal(result.path, targetPath);
  assert.ok(fs.existsSync(targetPath));

  const content = fs.readFileSync(targetPath, 'utf8');
  assert.ok(content.length > 0);
  assert.ok(content.includes('export default'));
  assert.ok(content.includes('api.route.current'));
  assert.ok(content.includes('api.client.session.promptAsync'));

  const tuiConfig = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tui.json'), 'utf8'));
  assert.equal(tuiConfig.plugin.length, 1);
  assert.ok(tuiConfig.plugin[0].startsWith('file:'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('已存在当前版本 plugin 且内容匹配时不覆盖', () => {
  const { tmpDir } = createTempConfigDir();
  const targetPath = path.join(tmpDir, 'walker-tui-plugin.js');

  const source = getPluginSource(8787);
  fs.writeFileSync(targetPath, source, 'utf8');

  const result = installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });

  assert.equal(result.installed, false);
  assert.equal(result.reason, 'already_exists');
  assert.equal(fs.readFileSync(targetPath, 'utf8'), source);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('已存在旧版 TUI plugin 即使端口匹配也会升级', () => {
  const { tmpDir } = createTempConfigDir();
  const targetPath = path.join(tmpDir, 'walker-tui-plugin.js');

  fs.writeFileSync(targetPath, '// Walker TUI bridge version: 3\n// existing plugin with localhost:8787\n', 'utf8');

  const result = installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });

  assert.equal(result.installed, true);
  const content = fs.readFileSync(targetPath, 'utf8');
  assert.ok(content.includes('Walker TUI bridge version: 8'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('已存在 plugin 但端口不匹配时重新安装', () => {
  const { tmpDir } = createTempConfigDir();
  const targetPath = path.join(tmpDir, 'walker-tui-plugin.js');

  fs.writeFileSync(targetPath, '// existing plugin with localhost:9000\n', 'utf8');

  const result = installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });

  assert.equal(result.installed, true);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('enabled=false 时不安装', () => {
  const { tmpDir } = createTempConfigDir();
  const targetPath = path.join(tmpDir, 'walker-tui-plugin.js');

  const result = installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: false });

  assert.equal(result.installed, false);
  assert.equal(result.reason, 'disabled');
  assert.ok(!fs.existsSync(targetPath));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('未传入 opencodeConfigDir 时使用默认 ~/.config/opencode 路径', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-home-'));
  const origHomedir = os.homedir;
  os.homedir = () => tmpHome;

  try {
    const expectedDir = path.join(tmpHome, '.config', 'opencode');
    const expectedPath = path.join(expectedDir, 'walker-tui-plugin.js');

    const result = installHookPlugin({ walkerPort: 8787, enabled: true });

    assert.equal(result.installed, true);
    assert.equal(result.path, expectedPath);
    assert.ok(fs.existsSync(expectedPath));

    fs.rmSync(tmpHome, { recursive: true, force: true });
  } finally {
    os.homedir = origHomedir;
  }
});

test('getPluginSource 返回 embedded TUI bridge plugin 内容', () => {
  const source = getPluginSource(8787);

  assert.ok(typeof source === 'string');
  assert.ok(source.length > 0);
  assert.ok(source.includes('127.0.0.1'));
  assert.ok(source.includes('8787'));
  assert.ok(source.includes('/opencode/tui-bridge/register'));
  assert.ok(source.includes('/opencode/tui-bridge/poll'));
  assert.ok(source.includes('/opencode/tui-bridge/events'));
  assert.ok(source.includes('bridgeProtocolVersion: 3'));
  assert.ok(source.includes('api.route.current'));
  assert.ok(source.includes('api.client.session.promptAsync'));
});

test('getPluginSource 不同 walkerPort 生成不同内容', () => {
  const s1 = getPluginSource(8787);
  const s2 = getPluginSource(9999);
  assert.ok(s1.includes('8787'));
  assert.ok(s2.includes('9999'));
  assert.notEqual(s1, s2);
});

test('getPluginSource 传入 heartbeatIntervalMs 时内嵌到生成源码', () => {
  const source = getPluginSource(8787, '', 45000);
  assert.ok(source.includes('45000'));
});

test('installHookPlugin 传入 heartbeatIntervalMs 透传到生成模板', () => {
  const { tmpDir } = createTempConfigDir();
  const result = installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true, heartbeatIntervalMs: 45000 });
  assert.equal(result.installed, true);
  const content = fs.readFileSync(result.path, 'utf8');
  assert.ok(content.includes('45000'));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('getPluginSource 不再依赖 embedded TUI 的占位 serverUrl', () => {
  const source = getPluginSource(8787);
  assert.ok(!source.includes('ctx.serverUrl'));
  assert.ok(!source.includes('localhost:4096'));
});

test('getPluginSource 在 session idle 时回传当前 TUI 的最终事件', () => {
  const source = getPluginSource(8787);
  assert.ok(source.includes("api.event.on('session.idle'"));
  assert.ok(source.includes('deliveryId'));
});

test('getPluginSource 使用 OpenCode 加载器要求的默认 TUI plugin 导出', () => {
  const source = getPluginSource(8787);
  assert.ok(source.includes('export default'), 'plugin 应提供默认导出对象');
  assert.ok(source.includes("id: 'walker-tui-bridge'"), 'plugin 应提供稳定 id');
  assert.ok(source.includes('tui'), 'plugin 应提供 tui entrypoint');
  assert.ok(!source.includes('module.exports'), 'plugin 不应使用 CommonJS module.exports');
});

test('installHookPlugin 合并 tui.json，不覆盖用户配置或重复插件项', () => {
  const { tmpDir } = createTempConfigDir();
  const configPath = path.join(tmpDir, 'tui.json');
  fs.writeFileSync(configPath, JSON.stringify({ theme: 'custom', plugin: ['npm:existing-plugin'] }, null, 2), 'utf8');

  installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });
  installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.theme, 'custom');
  assert.equal(config.plugin.filter((entry) => entry === 'npm:existing-plugin').length, 1);
  assert.equal(config.plugin.filter((entry) => entry.includes('walker-tui-plugin.js')).length, 1);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('installHookPlugin 删除已识别的旧 Walker server hook，避免伪 4096 session 抢焦点', () => {
  const { tmpDir } = createTempConfigDir();
  const pluginsDir = path.join(tmpDir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const legacyPath = path.join(pluginsDir, 'walker-hook.js');
  fs.writeFileSync(legacyPath, '// Walker auto-attach hook plugin\n// Walker hook version: 2\n', 'utf8');

  installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });

  assert.equal(fs.existsSync(legacyPath), false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('生成的 TUI plugin 在当前 embedded session 内执行 prompt 并回传结果', async () => {
  const source = getPluginSource(8787, 'token-test');
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  assert.equal(typeof plugin.default, 'object');
  assert.equal(plugin.default.id, 'walker-tui-bridge');
  assert.equal(typeof plugin.default.tui, 'function');
  const requests = [];
  const handlers = new Map();
  const promptCalls = [];
  let dispose;
  let deliveryReturned = false;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), options, body });
    let data = {};
    if (String(url).endsWith('/poll') && !deliveryReturned) {
      deliveryReturned = true;
      data = { delivery: { deliveryId: 'del_test', sessionId: 'ses_embedded', text: '来自飞书' } };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };

  try {
    await plugin.default.tui({
      app: { version: '1.17.20' },
      route: { current: { name: 'session', params: { sessionID: 'ses_embedded' } } },
      client: {
        session: {
          promptAsync: async (input) => { promptCalls.push(input); return { data: null }; },
        },
      },
      event: { on: (type, handler) => handlers.set(type, handler) },
      state: {
        path: { directory: 'H:\\walker' },
        session: {
          messages: () => [{ id: 'msg_assistant', role: 'assistant' }],
          status: () => ({ type: 'idle' }),
        },
        part: () => [{ type: 'text', text: '本地 TUI 回复' }],
      },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => promptCalls.length === 1);
    assert.equal(promptCalls[0].sessionID, 'ses_embedded');
    assert.equal(promptCalls[0].parts[0].text, '来自飞书');
    assert.equal(requests.find((request) => request.url.endsWith('/register')).body.sessionId, 'ses_embedded');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer token-test');

    await handlers.get('session.idle')({ properties: { sessionID: 'ses_embedded' } });
    const eventRequest = requests.find((request) => request.url.endsWith('/events') && request.body.events && request.body.events.length > 0);
    assert.equal(eventRequest.body.deliveryId, 'del_test');
    assert.equal(eventRequest.body.events[0].data.text, '本地 TUI 回复');
    assert.equal(eventRequest.body.events.at(-1).type, 'done');
    assert.equal(eventRequest.body.deliveryState, 'final');

    requests.length = 0;
    await handlers.get('session.error')({
      properties: {
        sessionID: 'ses_embedded',
        error: {
          name: 'ProviderModelNotFoundError',
          data: { message: 'Model not found: cpa/gpt-5.6-sol' },
        },
      },
    });
    const errorRequest = requests.find((request) => request.url.endsWith('/events') && request.body.error);
    assert.equal(errorRequest.body.error.message, 'Model not found: cpa/gpt-5.6-sol');
    assert.equal(errorRequest.body.deliveryState, 'final');
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('prompt delivery 携带 model 时 promptAsync 收到 model 参数', async () => {
  const source = getPluginSource(8787);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  const handlers = new Map();
  const promptCalls = [];
  let dispose;
  let deliveryReturned = false;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), options, body });
    let data = {};
    if (String(url).endsWith('/poll') && !deliveryReturned) {
      deliveryReturned = true;
      data = {
        delivery: {
          deliveryId: 'del_model',
          sessionId: 'ses_model',
          text: '用指定模型回复',
          model: { providerID: 'kscc', modelID: 'glm-5.1' },
        },
      };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };

  try {
    await plugin.default.tui({
      app: { version: '1.17.20' },
      route: { current: { name: 'session', params: { sessionID: 'ses_model' } } },
      client: {
        session: {
          promptAsync: async (input) => { promptCalls.push(input); return { data: null }; },
        },
      },
      event: { on: (type, handler) => handlers.set(type, handler) },
      state: {
        path: { directory: 'H:\\walker' },
        session: {
          messages: () => [{ id: 'msg_model', role: 'assistant' }],
          status: () => ({ type: 'idle' }),
        },
        part: () => [{ type: 'text', text: '模型回复' }],
      },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => promptCalls.length === 1);
    assert.equal(promptCalls[0].sessionID, 'ses_model');
    assert.equal(promptCalls[0].parts[0].text, '用指定模型回复');
    assert.deepEqual(promptCalls[0].model, { providerID: 'kscc', modelID: 'glm-5.1' });
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('prompt delivery 不带 model 时 promptAsync 不传 model 参数', async () => {
  const source = getPluginSource(8787);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const promptCalls = [];
  let dispose;
  let deliveryReturned = false;
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    let data = {};
    if (String(url).endsWith('/poll') && !deliveryReturned) {
      deliveryReturned = true;
      data = { delivery: { deliveryId: 'del_nomodel', sessionId: 'ses_nomodel', text: '无模型' } };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };

  try {
    await plugin.default.tui({
      app: { version: '1.17.20' },
      route: { current: { name: 'session', params: { sessionID: 'ses_nomodel' } } },
      client: {
        session: {
          promptAsync: async (input) => { promptCalls.push(input); return { data: null }; },
        },
      },
      event: { on: () => {} },
      state: {
        path: { directory: 'H:\\walker' },
        session: {
          messages: () => [{ id: 'msg_nomodel', role: 'assistant' }],
          status: () => ({ type: 'idle' }),
        },
        part: () => [{ type: 'text', text: '回复' }],
      },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => promptCalls.length === 1);
    assert.equal(promptCalls[0].sessionID, 'ses_nomodel');
    assert.ok(!promptCalls[0].hasOwnProperty('model'), '不应携带 model 属性');
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('生成的 TUI plugin 在 route 滞后时跟随根会话创建和 TUI 会话选择', async () => {
  const source = getPluginSource(8787);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  const handlers = new Map();
  const promptCalls = [];
  const navigateCalls = [];
  let dispose;
  let newSessionDeliveryReturned = false;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    let data = {};
    if (String(url).endsWith('/poll') && body.sessionId === 'ses_new' && !newSessionDeliveryReturned) {
      newSessionDeliveryReturned = true;
      data = { delivery: { deliveryId: 'del_new', sessionId: 'ses_new', text: '新会话消息' } };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };

  try {
    await plugin.default.tui({
      route: {
        current: { name: 'session', params: { sessionID: 'ses_old' } },
        navigate: (name, params) => { navigateCalls.push({ name, params }); },
      },
      client: {
        session: {
          promptAsync: async (input) => { promptCalls.push(input); return { data: null }; },
        },
      },
      event: { on: (type, handler) => handlers.set(type, handler) },
      state: {
        path: { directory: 'H:\\walker' },
        session: {
          messages: () => [{ id: 'msg_new', role: 'assistant' }],
          status: () => ({ type: 'idle' }),
        },
        part: () => [{ type: 'text', text: '新会话回复' }],
      },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => requests.some((request) => request.url.endsWith('/register')));
    assert.equal(typeof handlers.get('session.created'), 'function');
    assert.equal(typeof handlers.get('tui.session.select'), 'function');

    await handlers.get('session.created')({
      properties: { sessionID: 'ses_child', info: { id: 'ses_child', parentID: 'ses_old' } },
    });
    assert.equal(requests.some((request) => request.url.endsWith('/register') && request.body.sessionId === 'ses_child'), false);

    await handlers.get('session.created')({
      properties: { sessionID: 'ses_new', info: { id: 'ses_new' } },
    });
    await waitFor(() => promptCalls.length === 1);
    assert.deepEqual(navigateCalls[0], { name: 'session', params: { sessionID: 'ses_new' } });
    assert.equal(promptCalls[0].sessionID, 'ses_new');
    assert.equal(promptCalls[0].parts[0].text, '新会话消息');
    assert.ok(requests.some((request) => request.url.endsWith('/register') && request.body.sessionId === 'ses_new'));
    assert.ok(requests.some((request) => request.url.endsWith('/poll') && request.body.sessionId === 'ses_new'));

    await handlers.get('session.idle')({ properties: { sessionID: 'ses_new' } });
    const eventRequest = requests.find((request) => request.url.endsWith('/events'));
    assert.equal(eventRequest.body.sessionId, 'ses_new');
    assert.equal(eventRequest.body.deliveryId, 'del_new');

    await handlers.get('session.error')({
      properties: { sessionID: 'ses_new', error: { message: '新会话失败' } },
    });
    const errorRequest = requests.filter((request) => request.url.endsWith('/events')).at(-1);
    assert.equal(errorRequest.body.sessionId, 'ses_new');
    assert.equal(errorRequest.body.error.message, '新会话失败');

    await handlers.get('tui.session.select')({ properties: { sessionID: 'ses_existing' } });
    await waitFor(() => requests.some((request) => request.url.endsWith('/register') && request.body.sessionId === 'ses_existing'));
    assert.ok(requests.some((request) => request.url.endsWith('/poll') && request.body.sessionId === 'ses_existing'));
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('getPluginSource 包含 clear delivery 处理与本地 session.create 调用', () => {
  const source = getPluginSource(8787);
  assert.ok(source.includes("type === 'clear'"), '应分派 clear delivery');
  assert.ok(source.includes('api.client.session.create'), '应调用本地 SDK create');
  assert.ok(source.includes('api.route.navigate'), '应调用 route.navigate');
  assert.ok(source.includes('controlDeliveryId'), '应发送关联 register');
  assert.ok(source.includes("control: { type: 'clear'"), '应上报 control result');
});

test('生成的 TUI plugin 处理 clear delivery 并创建顶层 session', async () => {
  const source = getPluginSource(8787, 'token-clear');
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  const handlers = new Map();
  const createCalls = [];
  const navigateCalls = [];
  let dispose;
  let clearDeliveryReturned = false;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    let data = {};
    if (String(url).endsWith('/poll') && body.sessionId === 'ses_old' && !clearDeliveryReturned) {
      clearDeliveryReturned = true;
      data = { delivery: { deliveryId: 'del_clear1', type: 'clear', sessionId: 'ses_old' } };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };

  try {
    await plugin.default.tui({
      app: { version: '1.17.20' },
      route: {
        current: { name: 'session', params: { sessionID: 'ses_old' } },
        navigate: (name, params) => { navigateCalls.push({ name, params }); },
      },
      client: {
        session: {
          create: async (input) => { createCalls.push(input); return { data: { id: 'ses_new1' } }; },
        },
      },
      event: { on: (type, handler) => handlers.set(type, handler) },
      state: {
        path: { directory: 'H:\\walker' },
        session: { status: () => ({ type: 'idle' }) },
      },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => createCalls.length === 1);
    assert.deepEqual(createCalls[0], { title: undefined }, 'create 不传 parent，不执行 fork/summarize/delete');

    await waitFor(() => navigateCalls.some((n) => n.name === 'session' && n.params.sessionID === 'ses_new1'));

    await waitFor(() => requests.some((r) => r.url.endsWith('/events') && r.body.deliveryId === 'del_clear1' && r.body.control));
    const controlReq = requests.find((r) => r.url.endsWith('/events') && r.body.deliveryId === 'del_clear1' && r.body.control);
    assert.equal(controlReq.body.sessionId, 'ses_old', 'reportEvents sessionId 必须是旧 session id');
    assert.equal(controlReq.body.runtimeId, controlReq.body.runtimeId);
    assert.equal(controlReq.body.control.type, 'clear');
    assert.equal(controlReq.body.control.newSessionId, 'ses_new1');

    await waitFor(() => requests.some((r) => r.url.endsWith('/register') && r.body.controlDeliveryId === 'del_clear1'));
    const regReq = requests.find((r) => r.url.endsWith('/register') && r.body.controlDeliveryId === 'del_clear1');
    assert.equal(regReq.body.sessionId, 'ses_new1', '关联 register 上报新 session id');
    assert.equal(regReq.body.runtimeId, controlReq.body.runtimeId, '关联 register 与 control 同一 runtimeId');
    assert.equal(regReq.body.cwd, 'H:\\walker');
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('clear 关联 register 请求保持 runtimeId 和 deliveryId', async () => {
  const source = getPluginSource(8787);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  const handlers = new Map();
  let dispose;
  let clearReturned = false;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    let data = {};
    if (String(url).endsWith('/poll') && !clearReturned) {
      clearReturned = true;
      data = { delivery: { deliveryId: 'del_clr_assoc', type: 'clear', sessionId: 'ses_old' } };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };

  try {
    await plugin.default.tui({
      route: {
        current: { name: 'session', params: { sessionID: 'ses_old' } },
        navigate: () => {},
      },
      client: { session: { create: async () => ({ data: { id: 'ses_new_assoc' } }) } },
      event: { on: (type, handler) => handlers.set(type, handler) },
      state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'idle' }) } },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => requests.some((r) => r.url.endsWith('/register') && r.body.controlDeliveryId === 'del_clr_assoc'));
    const regReq = requests.find((r) => r.url.endsWith('/register') && r.body.controlDeliveryId === 'del_clr_assoc');
    assert.ok(regReq.body.runtimeId, '关联 register 必须携带 runtimeId');
    assert.equal(regReq.body.controlDeliveryId, 'del_clr_assoc');
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('clear 创建后调用 route.navigate 到新 session', async () => {
  const source = getPluginSource(8787);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const handlers = new Map();
  const navigateCalls = [];
  let dispose;
  let clearReturned = false;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    JSON.parse(options.body);
    let data = {};
    if (String(url).endsWith('/poll') && !clearReturned) {
      clearReturned = true;
      data = { delivery: { deliveryId: 'del_clr_nav', type: 'clear', sessionId: 'ses_before' } };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };

  try {
    await plugin.default.tui({
      route: {
        current: { name: 'session', params: { sessionID: 'ses_before' } },
        navigate: (name, params) => { navigateCalls.push({ name, params }); },
      },
      client: { session: { create: async () => ({ data: { id: 'ses_after_nav' } }) } },
      event: { on: (type, handler) => handlers.set(type, handler) },
      state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'idle' }) } },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => navigateCalls.some((n) => n.name === 'session' && n.params.sessionID === 'ses_after_nav'));
    const navCall = navigateCalls.find((n) => n.name === 'session' && n.params.sessionID === 'ses_after_nav');
    assert.deepEqual(navCall, { name: 'session', params: { sessionID: 'ses_after_nav' } });
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('clear 各失败阶段保持 Walker 旧焦点并回滚 TUI', async () => {
  const source = getPluginSource(8787);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);

  async function runClearFailureScenario({ failAt, createReturn, navigateShouldFail, failPostRequests }) {
    const requests = [];
    const handlers = new Map();
    const navigateCalls = [];
    let dispose;
    let clearReturned = false;
    let postCallCount = 0;
    const originalFetch = global.fetch;

    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url: String(url), body });
      let data = {};
      if (String(url).endsWith('/poll') && !clearReturned) {
        clearReturned = true;
        data = { delivery: { deliveryId: 'del_clr_fail', type: 'clear', sessionId: 'ses_fail_old' } };
      }
      if (failPostRequests) {
        postCallCount++;
        if (postCallCount > 1 && (String(url).endsWith('/events') || String(url).endsWith('/register'))) {
          return { ok: false, status: 500, json: async () => ({ ok: false, error: { message: 'post failed' } }) };
        }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
    };

    try {
      let createCalled = false;
      const api = {
        route: {
          current: { name: 'session', params: { sessionID: 'ses_fail_old' } },
          navigate: (name, params) => {
            navigateCalls.push({ name, params });
            if (navigateShouldFail && params.sessionID === 'ses_fail_new') {
              throw new Error('navigate failed');
            }
          },
        },
        client: {
          session: {
            create: async (_input) => {
              createCalled = true;
              if (failAt === 'create') throw new Error('create failed');
              return createReturn;
            },
          },
        },
        event: { on: (type, handler) => handlers.set(type, handler) },
        state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'idle' }) } },
        lifecycle: { onDispose: (handler) => { dispose = handler; } },
      };

      await plugin.default.tui(api);

      await waitFor(() => clearReturned && (failAt === 'create' ? createCalled : true), 2000);

      await new Promise((resolve) => setTimeout(resolve, 300));

      const errorReq = requests.find((r) => r.url.endsWith('/events') && r.body.deliveryId === 'del_clr_fail' && r.body.error);
      assert.ok(errorReq, '失败时应发送 error 上报');
      assert.equal(errorReq.body.sessionId, 'ses_fail_old', 'error 上报 sessionId 必须是旧 session id');

      if (failAt === 'postNavigate') {
        const rollbackNav = navigateCalls.find((n) => n.name === 'session' && n.params.sessionID === 'ses_fail_old');
        assert.ok(rollbackNav, '已导航后失败应回滚到旧 session');
      }
    } finally {
      if (dispose) await dispose();
      global.fetch = originalFetch;
    }
  }

  await runClearFailureScenario({ failAt: 'create', createReturn: null });
  await runClearFailureScenario({ failAt: 'missingId', createReturn: { data: {} }, navigateShouldFail: false });
  await runClearFailureScenario({ failAt: 'navigate', createReturn: { data: { id: 'ses_fail_new' } }, navigateShouldFail: true });
  await runClearFailureScenario({ failAt: 'postNavigate', createReturn: { data: { id: 'ses_fail_new' } }, navigateShouldFail: false, failPostRequests: true });
});

test('clear 处理 session.created 早于 create 返回时不提前改变 activeSessionId', async () => {
  const source = getPluginSource(8787);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  const handlers = new Map();
  const navigateCalls = [];
  let dispose;
  let createResolve;
  let clearReturned = false;
  let earlyEventFired = false;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    let data = {};
    if (String(url).endsWith('/poll') && !clearReturned) {
      clearReturned = true;
      data = { delivery: { deliveryId: 'del_clr_early', type: 'clear', sessionId: 'ses_early_old' } };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };

  try {
    await plugin.default.tui({
      route: {
        current: { name: 'session', params: { sessionID: 'ses_early_old' } },
        navigate: (name, params) => { navigateCalls.push({ name, params }); },
      },
      client: {
        session: {
          create: async () => {
            if (!earlyEventFired) {
              earlyEventFired = true;
              if (handlers.get('session.created')) {
                await handlers.get('session.created')({ properties: { sessionID: 'ses_early_new', info: { id: 'ses_early_new' } } });
              }
            }
            return new Promise((resolve) => { createResolve = resolve; });
          },
        },
      },
      event: { on: (type, handler) => handlers.set(type, handler) },
      state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'idle' }) } },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => earlyEventFired);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const earlyReg = requests.find((r) => r.url.endsWith('/register') && r.body.sessionId === 'ses_early_new' && !r.body.controlDeliveryId);
    assert.equal(earlyReg, undefined, 'session.created 早于 create 返回时不应触发普通自动注册');

    createResolve({ data: { id: 'ses_early_new' } });

    await waitFor(() => navigateCalls.some((n) => n.name === 'session' && n.params.sessionID === 'ses_early_new'));
    await waitFor(() => requests.some((r) => r.url.endsWith('/register') && r.body.controlDeliveryId === 'del_clr_early'));
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('clear 抑制自身触发的普通自动注册', async () => {
  const source = getPluginSource(8787);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  const handlers = new Map();
  let dispose;
  let clearReturned = false;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    let data = {};
    if (String(url).endsWith('/poll') && !clearReturned) {
      clearReturned = true;
      data = { delivery: { deliveryId: 'del_clr_suppress', type: 'clear', sessionId: 'ses_supp_old' } };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };

  try {
    await plugin.default.tui({
      route: {
        current: { name: 'session', params: { sessionID: 'ses_supp_old' } },
        navigate: () => {},
      },
      client: { session: { create: async () => ({ data: { id: 'ses_supp_new' } }) } },
      event: { on: (type, handler) => handlers.set(type, handler) },
      state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'idle' }) } },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => requests.some((r) => r.url.endsWith('/register') && r.body.controlDeliveryId === 'del_clr_suppress'));

    if (handlers.get('session.created')) {
      await handlers.get('session.created')({ properties: { sessionID: 'ses_supp_new', info: { id: 'ses_supp_new' } } });
    }
    if (handlers.get('tui.session.select')) {
      await handlers.get('tui.session.select')({ properties: { sessionID: 'ses_supp_new' } });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    const autoReg = requests.find((r) => r.url.endsWith('/register') && r.body.sessionId === 'ses_supp_new' && !r.body.controlDeliveryId);
    assert.equal(autoReg, undefined, 'clear 自身触发的 session.created/tui.session.select 不应触发普通自动注册');
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('clear 支持两种上报顺序（control 先于 register 或 register 先于 control）', async () => {
  for (const order of ['control-first', 'register-first']) {
    const source = getPluginSource(8787);
    const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
    const plugin = await import(moduleUrl);
    const requests = [];
    const handlers = new Map();
    let dispose;
    let clearReturned = false;
    const originalFetch = global.fetch;

    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url: String(url), body });
      let data = {};
      if (String(url).endsWith('/poll') && !clearReturned) {
        clearReturned = true;
        data = { delivery: { deliveryId: 'del_clr_order', type: 'clear', sessionId: 'ses_order_old' } };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
    };

    try {
      let createCallCount = 0;
      await plugin.default.tui({
        route: {
          current: { name: 'session', params: { sessionID: 'ses_order_old' } },
          navigate: () => {},
        },
        client: {
          session: {
            create: async () => {
              createCallCount++;
              return { data: { id: 'ses_order_new' } };
            },
          },
        },
        event: { on: (type, handler) => handlers.set(type, handler) },
        state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'idle' }) } },
        lifecycle: { onDispose: (handler) => { dispose = handler; } },
      });

      await waitFor(() => createCallCount === 1);

      await waitFor(() => {
        const hasControl = requests.some((r) => r.url.endsWith('/events') && r.body.deliveryId === 'del_clr_order' && r.body.control);
        const hasReg = requests.some((r) => r.url.endsWith('/register') && r.body.controlDeliveryId === 'del_clr_order');
        return hasControl && hasReg;
      });

      const controlReq = requests.find((r) => r.url.endsWith('/events') && r.body.deliveryId === 'del_clr_order' && r.body.control);
      const regReq = requests.find((r) => r.url.endsWith('/register') && r.body.controlDeliveryId === 'del_clr_order');
      assert.ok(controlReq, order + ': 应发送 control result');
      assert.ok(regReq, order + ': 应发送关联 register');
      assert.equal(controlReq.body.control.newSessionId, 'ses_order_new');
      assert.equal(regReq.body.sessionId, 'ses_order_new');
    } finally {
      if (dispose) await dispose();
      global.fetch = originalFetch;
    }
  }
});

test('clear 支持四种 session ID 返回形态', async () => {
  const idForms = [
    { ret: { data: { id: 'ses_formA' } }, expected: 'ses_formA' },
    { ret: { id: 'ses_formB' }, expected: 'ses_formB' },
    { ret: { sessionID: 'ses_formC' }, expected: 'ses_formC' },
    { ret: { sessionId: 'ses_formD' }, expected: 'ses_formD' },
  ];

  for (const { ret, expected } of idForms) {
    const source = getPluginSource(8787);
    const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
    const plugin = await import(moduleUrl);
    const requests = [];
    const handlers = new Map();
    const navigateCalls = [];
    let dispose;
    let clearReturned = false;
    const originalFetch = global.fetch;

    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url: String(url), body });
      let data = {};
      if (String(url).endsWith('/poll') && !clearReturned) {
        clearReturned = true;
        data = { delivery: { deliveryId: 'del_clr_form', type: 'clear', sessionId: 'ses_form_old' } };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
    };

    try {
      await plugin.default.tui({
        route: {
          current: { name: 'session', params: { sessionID: 'ses_form_old' } },
          navigate: (name, params) => { navigateCalls.push({ name, params }); },
        },
        client: { session: { create: async () => ret } },
        event: { on: (type, handler) => handlers.set(type, handler) },
        state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'idle' }) } },
        lifecycle: { onDispose: (handler) => { dispose = handler; } },
      });

      await waitFor(() => navigateCalls.some((n) => n.name === 'session' && n.params.sessionID === expected), 2000);
      await waitFor(() => requests.some((r) => r.url.endsWith('/events') && r.body.control && r.body.control.newSessionId === expected), 2000);
    } finally {
      if (dispose) await dispose();
      global.fetch = originalFetch;
    }
  }
});

test('clear 缺失 session ID 时上报错误', async () => {
  const source = getPluginSource(8787);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  const handlers = new Map();
  let dispose;
  let clearReturned = false;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    let data = {};
    if (String(url).endsWith('/poll') && !clearReturned) {
      clearReturned = true;
      data = { delivery: { deliveryId: 'del_clr_noid', type: 'clear', sessionId: 'ses_noid_old' } };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };

  try {
    await plugin.default.tui({
      route: {
        current: { name: 'session', params: { sessionID: 'ses_noid_old' } },
        navigate: () => {},
      },
      client: { session: { create: async () => ({ data: {} }) } },
      event: { on: (type, handler) => handlers.set(type, handler) },
      state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'idle' }) } },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => requests.some((r) => r.url.endsWith('/events') && r.body.deliveryId === 'del_clr_noid' && r.body.error));
    const errorReq = requests.find((r) => r.url.endsWith('/events') && r.body.deliveryId === 'del_clr_noid' && r.body.error);
    assert.equal(errorReq.body.sessionId, 'ses_noid_old', 'error 上报 sessionId 必须是旧 session id');
    assert.ok(errorReq.body.error.message, '应携带错误消息');
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('clear 回滚成功后恢复旧 activeSessionId', async () => {
  const source = getPluginSource(8787);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  const handlers = new Map();
  const navigateCalls = [];
  let dispose;
  let clearReturned = false;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    let data = {};
    if (String(url).endsWith('/poll') && !clearReturned) {
      clearReturned = true;
      data = { delivery: { deliveryId: 'del_clr_rollback', type: 'clear', sessionId: 'ses_rb_old' } };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };

  try {
    await plugin.default.tui({
      route: {
        current: { name: 'session', params: { sessionID: 'ses_rb_old' } },
        navigate: (name, params) => { navigateCalls.push({ name, params }); },
      },
      client: {
        session: {
          create: async () => ({ data: { id: 'ses_rb_new' } }),
        },
      },
      event: { on: (type, handler) => handlers.set(type, handler) },
      state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'idle' }) } },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => requests.some((r) => r.url.endsWith('/register') && r.body.controlDeliveryId === 'del_clr_rollback'));

    const errorEvent = { properties: { sessionID: 'ses_rb_old', error: { message: 'register rejected by bridge' } } };
    if (handlers.get('session.error')) {
      await handlers.get('session.error')(errorEvent);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));

    const errorReq = requests.find((r) => r.url.endsWith('/events') && r.body.deliveryId === 'del_clr_rollback' && r.body.error);
    if (errorReq) {
      assert.equal(errorReq.body.sessionId, 'ses_rb_old');
    }
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('clear 后旧格式 prompt delivery 继续工作', async () => {
  const source = getPluginSource(8787);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  const handlers = new Map();
  const promptCalls = [];
  let dispose;
  let deliveryReturned = false;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    let data = {};
    if (String(url).endsWith('/poll') && !deliveryReturned) {
      deliveryReturned = true;
      data = { delivery: { deliveryId: 'del_legacy_prompt', sessionId: 'ses_legacy', text: '旧格式无 type' } };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };

  try {
    await plugin.default.tui({
      app: { version: '1.17.20' },
      route: { current: { name: 'session', params: { sessionID: 'ses_legacy' } } },
      client: {
        session: { promptAsync: async (input) => { promptCalls.push(input); return { data: null }; } },
      },
      event: { on: (type, handler) => handlers.set(type, handler) },
      state: {
        path: { directory: 'H:\\walker' },
        session: {
          messages: () => [{ id: 'msg_legacy', role: 'assistant' }],
          status: () => ({ type: 'idle' }),
        },
        part: () => [{ type: 'text', text: '旧格式回复' }],
      },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => promptCalls.length === 1);
    assert.equal(promptCalls[0].sessionID, 'ses_legacy');
    assert.equal(promptCalls[0].parts[0].text, '旧格式无 type');
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('clear 无关手工事件不关联 clear', async () => {
  const source = getPluginSource(8787);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  const handlers = new Map();
  let dispose;
  let clearReturned = false;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    let data = {};
    if (String(url).endsWith('/poll') && !clearReturned) {
      clearReturned = true;
      data = { delivery: { deliveryId: 'del_clr_unrelated', type: 'clear', sessionId: 'ses_unrel_old' } };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };

  try {
    await plugin.default.tui({
      route: {
        current: { name: 'session', params: { sessionID: 'ses_unrel_old' } },
        navigate: () => {},
      },
      client: { session: { create: async () => ({ data: { id: 'ses_unrel_new' } }) } },
      event: { on: (type, handler) => handlers.set(type, handler) },
      state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'idle' }) } },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => requests.some((r) => r.url.endsWith('/register') && r.body.controlDeliveryId === 'del_clr_unrelated'));

    if (handlers.get('tui.session.select')) {
      await handlers.get('tui.session.select')({ properties: { sessionID: 'ses_other_manual' } });
    }
    await new Promise((resolve) => setTimeout(resolve, 100));

    const manualReg = requests.find((r) => r.url.endsWith('/register') && r.body.sessionId === 'ses_other_manual');
    assert.ok(manualReg, '无关手工事件应正常注册');
    assert.equal(manualReg.body.controlDeliveryId, undefined, '手工事件 register 不应携带 controlDeliveryId');
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 1000);
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待 TUI plugin 执行超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
