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

  fs.writeFileSync(targetPath, '// Walker TUI bridge version: 2\n// existing plugin with localhost:8787\n', 'utf8');

  const result = installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });

  assert.equal(result.installed, true);
  const content = fs.readFileSync(targetPath, 'utf8');
  assert.ok(content.includes('Walker TUI bridge version: 3'));

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
    const eventRequest = requests.find((request) => request.url.endsWith('/events'));
    assert.equal(eventRequest.body.deliveryId, 'del_test');
    assert.equal(eventRequest.body.events[0].data.text, '本地 TUI 回复');
    assert.equal(eventRequest.body.events.at(-1).type, 'done');

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
    const errorRequest = requests.find((request) => request.url.endsWith('/events'));
    assert.equal(errorRequest.body.error.message, 'Model not found: cpa/gpt-5.6-sol');
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

async function waitFor(predicate) {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待 TUI plugin 执行超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
