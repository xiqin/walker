const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { pathToFileURL } = require('url');
const { installHookPlugin } = require('../src/opencode-hook/installer');
const { getPluginSource, getV2PluginEntrySource, getV1PluginEntrySource, getV2PackageManifest } = require('../src/opencode-hook/plugin-template');

function createTempConfigDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-hook-cfg-'));
  return { tmpDir };
}

test('installHookPlugin 写入 TUI plugin 并注册到 cli.json', () => {
  const { tmpDir } = createTempConfigDir();
  const targetPath = path.join(tmpDir, 'walker-tui-plugin', 'tui.js');

  const result = installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });

  assert.equal(result.installed, true);
  assert.equal(result.path, targetPath);
  assert.ok(fs.existsSync(targetPath));

  const content = fs.readFileSync(targetPath, 'utf8');
  const bridge = fs.readFileSync(path.join(tmpDir, 'walker-tui-bridge.js'), 'utf8');
  const v1 = fs.readFileSync(path.join(tmpDir, 'walker-tui-plugin-v1.js'), 'utf8');
  assert.ok(content.includes('export default'));
  assert.ok(content.includes('Plugin.define'));
  assert.equal(content.includes('try'), false);
  assert.ok(bridge.includes('api.route.current'));
  assert.ok(bridge.includes('api.client.session.promptAsync'));
  assert.ok(bridge.includes('Walker TUI bridge version: 18'));
  assert.equal(v1.includes('@opencode/plugin/tui'), false);
  assert.ok(v1.includes('return setup(api)'));

  const cliConfig = JSON.parse(fs.readFileSync(path.join(tmpDir, 'cli.json'), 'utf8'));
  assert.equal(cliConfig.$schema, 'https://opencode.ai/v2/cli.json');
  assert.equal(cliConfig.plugins.length, 1);
  assert.ok(cliConfig.plugins[0].startsWith('file:'));
  assert.equal(fs.existsSync(path.join(tmpDir, 'tui.json')), false);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('已存在当前版本 plugin 且内容匹配时不覆盖', () => {
  const { tmpDir } = createTempConfigDir();
  const pluginDir = path.join(tmpDir, 'walker-tui-plugin');
  fs.mkdirSync(pluginDir);
  const targetPath = path.join(pluginDir, 'tui.js');
  const bridgePath = path.join(tmpDir, 'walker-tui-bridge.js');
  const v1Path = path.join(tmpDir, 'walker-tui-plugin-v1.js');
  fs.writeFileSync(bridgePath, getPluginSource(8787), 'utf8');
  fs.writeFileSync(targetPath, getV2PluginEntrySource('../walker-tui-bridge.js'), 'utf8');
  fs.writeFileSync(path.join(pluginDir, 'package.json'), getV2PackageManifest(), 'utf8');
  fs.writeFileSync(v1Path, getV1PluginEntrySource(), 'utf8');
  const configPath = path.join(tmpDir, 'cli.json');
  const configText = JSON.stringify({
    $schema: 'https://opencode.ai/v2/cli.json',
    diffs: { wrap: 'word' },
    plugins: [pathToFileURL(pluginDir).href],
  }, null, 2) + '\n';
  fs.writeFileSync(configPath, configText, 'utf8');

  const result = installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });

  assert.equal(result.installed, false);
  assert.equal(result.reason, 'already_exists');
  assert.equal(fs.readFileSync(targetPath, 'utf8'), getV2PluginEntrySource('../walker-tui-bridge.js'));
  assert.equal(fs.readFileSync(configPath, 'utf8'), configText);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('已存在旧版 TUI plugin 即使端口匹配也会升级', () => {
  const { tmpDir } = createTempConfigDir();
  const targetPath = path.join(tmpDir, 'walker-tui-plugin.js');

  fs.writeFileSync(targetPath, '// Walker TUI bridge version: 3\n// existing plugin with localhost:8787\n', 'utf8');

  const result = installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });

  assert.equal(result.installed, true);
  const content = fs.readFileSync(path.join(tmpDir, 'walker-tui-bridge.js'), 'utf8');
  assert.ok(content.includes('Walker TUI bridge version: 18'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('已存在 plugin 但端口不匹配时重新安装', () => {
  const { tmpDir } = createTempConfigDir();
  const targetPath = path.join(tmpDir, 'walker-tui-plugin.js');

  const originalPlugin = '// existing plugin with localhost:9000\n';
  fs.writeFileSync(targetPath, originalPlugin, 'utf8');

  const result = installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });

  assert.equal(result.installed, true);
  assert.equal(fs.readFileSync(targetPath, 'utf8'), originalPlugin);

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
  const origXdg = process.env.XDG_CONFIG_HOME;
  os.homedir = () => tmpHome;
  delete process.env.XDG_CONFIG_HOME;

  try {
    const expectedDir = path.join(tmpHome, '.config', 'opencode');
    const expectedPath = path.join(expectedDir, 'walker-tui-plugin', 'tui.js');

    const result = installHookPlugin({ walkerPort: 8787, enabled: true });

    assert.equal(result.installed, true);
    assert.equal(result.path, expectedPath);
    assert.ok(fs.existsSync(expectedPath));

    fs.rmSync(tmpHome, { recursive: true, force: true });
  } finally {
    os.homedir = origHomedir;
    if (origXdg == null) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdg;
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
  assert.ok(source.includes('Walker TUI bridge version: 18'));
  assert.ok(source.includes('body.assistantMessageId = assistantMessageId'));
  assert.ok(source.includes('bridgeProtocolVersion: 5'));
  assert.ok(source.includes('api.route.current'));
  assert.ok(source.includes('api.client.session.promptAsync'));
  assert.ok(source.includes("onPluginEvent('permission.asked'"));
  assert.ok(source.includes("onPluginEvent('permission.updated'"));
  assert.ok(source.includes("onPluginEvent('permission.replied'"));
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
  const content = fs.readFileSync(path.join(tmpDir, 'walker-tui-bridge.js'), 'utf8');
  assert.ok(content.includes('45000'));
  assert.equal(fs.readFileSync(result.path, 'utf8').includes('45000'), false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('getPluginSource 不再依赖 embedded TUI 的占位 serverUrl', () => {
  const source = getPluginSource(8787);
  assert.ok(!source.includes('ctx.serverUrl'));
  assert.ok(!source.includes('localhost:4096'));
});

test('getPluginSource 在 session idle 时回传当前 TUI 的最终事件', () => {
  const source = getPluginSource(8787);
  assert.ok(source.includes("onPluginEvent('session.idle'"));
  assert.ok(source.includes('deliveryId'));
});

test('getPluginSource 使用 OpenCode V2 CLI plugin 导出', () => {
  const source = getPluginSource(8787);
  const v2 = getV2PluginEntrySource();
  const v1 = getV1PluginEntrySource();
  assert.ok(source.includes('export default'), '桥接应提供默认可加载对象');
  assert.ok(source.includes('export { setup }'), '桥接应导出可直接加载的 setup');
  assert.equal(source.includes('@opencode/plugin/tui'), false, '共享桥接不得导入 V2 包');
  assert.equal(source.includes('define(plugin)'), false, '共享桥接不得回退伪 Plugin.define');
  assert.ok(v2.startsWith("import { Plugin } from '@opencode/plugin/tui';\n"), 'V2 入口必须以真实导入开头');
  assert.ok(v2.includes("import { setup } from './walker-tui-bridge.js';"));
  assert.ok(v2.includes('Plugin.define'), 'V2 入口应通过 Plugin.define 注册');
  assert.equal(v2.includes('try'), false);
  assert.ok(v1.includes('return setup(api)'), 'V1 入口应调用同一 setup');
  assert.equal(v1.includes('@opencode/plugin/tui'), false);
  assert.ok(source.includes("id: 'walker-tui-bridge'"), 'plugin 应提供稳定 id');
  assert.ok(source.includes('tui: setup'), '桥接应保留 tui 别名');
  assert.ok(!source.includes('module.exports'), 'plugin 不应使用 CommonJS module.exports');
});

test('installHookPlugin 合并 cli.json，不覆盖用户配置或重复插件项', () => {
  const { tmpDir } = createTempConfigDir();
  const configPath = path.join(tmpDir, 'cli.json');
  fs.writeFileSync(configPath, JSON.stringify({ diffs: { wrap: 'word' }, plugins: ['npm:existing-plugin'] }, null, 2), 'utf8');

  installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });
  installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });

  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(config.diffs.wrap, 'word');
  assert.equal(config.$schema, 'https://opencode.ai/v2/cli.json');
  assert.equal(config.plugins.filter((entry) => entry === 'npm:existing-plugin').length, 1);
  assert.equal(config.plugins.filter((entry) => entry === pathToFileURL(path.join(tmpDir, 'walker-tui-plugin')).href).length, 1);

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
  let assistantPartReads = 0;
  let releaseReply = false;
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
          messages: () => (releaseReply ? [{
            id: 'msg_assistant',
            role: 'assistant',
            providerID: 'cpa',
            modelID: 'gpt-5.6-sol',
            time: { completed: 1722086400000 },
          }, {
            id: 'msg_assistant_pending',
            role: 'assistant',
            providerID: 'cpa',
            modelID: 'gpt-5.6-sol',
            tokens: {
              total: 0,
              input: 0,
              output: 0,
              reasoning: 0,
              cache: { read: 0, write: 0 },
            },
          }] : []),
          status: () => ({ type: 'idle' }),
        },
        part: (messageId) => {
          if (messageId !== 'msg_assistant') return [];
          assistantPartReads += 1;
          const parts = [{ type: 'text', text: '本地 TUI 回复' }];
          if (assistantPartReads > 1) {
            parts.push({
              type: 'step-finish',
              tokens: {
                total: 92079,
                input: 349,
                output: 82,
                reasoning: 0,
                cache: { read: 91648, write: 0 },
              },
            });
          }
          return parts;
        },
      },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => promptCalls.length === 1);
    assert.equal(promptCalls[0].sessionID, 'ses_embedded');
    assert.equal(promptCalls[0].parts[0].text, '来自飞书');
    const registration = requests.find((request) => request.url.endsWith('/register'));
    assert.equal(registration.body.sessionId, 'ses_embedded');
    assert.equal(registration.body.bridgeProtocolVersion, 5, '实际 register 请求必须声明 protocol v5');
    assert.equal(requests[0].options.headers.Authorization, 'Bearer token-test');
    releaseReply = true;

    await handlers.get('session.idle')({ properties: { sessionID: 'ses_embedded' } });
    const eventRequest = requests.find((request) => request.url.endsWith('/events') && request.body.events && request.body.events.length > 0);
    assert.equal(eventRequest.body.deliveryId, 'del_test');
    assert.equal(eventRequest.body.events[0].data.text, '本地 TUI 回复');
    assert.equal(eventRequest.body.events.at(-1).type, 'done');
    assert.deepEqual(eventRequest.body.events.at(-1).data.model, { providerID: 'cpa', modelID: 'gpt-5.6-sol' });
    assert.deepEqual(eventRequest.body.events.at(-1).data.usage, {
      inputTokens: 349,
      outputTokens: 82,
      reasoningTokens: 0,
      cacheReadTokens: 91648,
      cacheWriteTokens: 0,
      totalTokens: 92079,
    });
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
    assert.equal(errorRequest, undefined, '没有活跃父 delivery 时 session.error 不得创建无关联 final');
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
  let releaseReply = false;
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
          messages: () => (releaseReply ? [{ id: 'msg_new', role: 'assistant', time: { completed: 1 } }] : []),
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

    releaseReply = true;
    await handlers.get('session.idle')({ properties: { sessionID: 'ses_new' } });
    const eventRequest = requests.find((request) => request.url.endsWith('/events'));
    assert.equal(eventRequest.body.sessionId, 'ses_new');
    assert.equal(eventRequest.body.deliveryId, 'del_new');

    await handlers.get('session.error')({
      properties: { sessionID: 'ses_new', error: { message: '新会话失败' } },
    });
    const errorRequest = requests.find((request) => request.url.endsWith('/events') && request.body.error);
    assert.equal(errorRequest, undefined, '完成父 delivery 后 session.error 不得误完结其他 delivery');

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
          get: async (input) => ({ id: input.path.id, workspaceID: 'wks_main' }),
          create: async (input) => { createCalls.push(input); return { data: { id: 'ses_new1' } }; },
        },
      },
      workspace: { current: () => 'wks_main' },
      event: { on: (type, handler) => handlers.set(type, handler) },
      state: {
        path: { directory: 'H:\\walker' },
        session: { status: () => ({ type: 'idle' }) },
      },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => createCalls.length === 1);
    assert.deepEqual(createCalls[0], {
      body: { workspaceID: 'wks_main' },
      query: { directory: 'H:\\walker', workspace: 'wks_main' },
      headers: { 'x-opencode-workspace': 'wks_main' },
    }, 'create 不传 parent，不执行 fork/summarize/delete，并继承 TUI 当前 workspace');

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

test('clear 在 session.create 返回缺 id 时可从 session.created 事件补齐新 session id', async () => {
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
      data = { delivery: { deliveryId: 'del_clr_event_id', type: 'clear', sessionId: 'ses_event_old' } };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };

  try {
    await plugin.default.tui({
      route: {
        current: { name: 'session', params: { sessionID: 'ses_event_old' } },
        navigate: (name, params) => { navigateCalls.push({ name, params }); },
      },
      client: {
        session: {
          create: async () => {
            if (handlers.get('session.created')) {
              await handlers.get('session.created')({ properties: { sessionID: 'ses_event_new', info: { id: 'ses_event_new' } } });
            }
            return { data: {} };
          },
        },
      },
      event: { on: (type, handler) => handlers.set(type, handler) },
      state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'idle' }) } },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => navigateCalls.some((n) => n.name === 'session' && n.params.sessionID === 'ses_event_new'));
    await waitFor(() => requests.some((r) => r.url.endsWith('/events') && r.body.deliveryId === 'del_clr_event_id' && r.body.control));
    const controlReq = requests.find((r) => r.url.endsWith('/events') && r.body.deliveryId === 'del_clr_event_id' && r.body.control);
    assert.equal(controlReq.body.control.newSessionId, 'ses_event_new');
    assert.equal(requests.some((r) => r.url.endsWith('/events') && r.body.deliveryId === 'del_clr_event_id' && r.body.error), false);
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('clear 在最新 SDK create 返回 error 对象时回退旧参数形态', async () => {
  const source = getPluginSource(8787);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  const handlers = new Map();
  const createCalls = [];
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
      data = { delivery: { deliveryId: 'del_clr_error_retry', type: 'clear', sessionId: 'ses_retry_old', title: 'retry title' } };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };

  try {
    await plugin.default.tui({
      route: {
        current: { name: 'session', params: { sessionID: 'ses_retry_old' } },
        navigate: (name, params) => { navigateCalls.push({ name, params }); },
      },
      client: {
        session: {
          create: async (input) => {
            createCalls.push(input);
            if (createCalls.length === 1) {
              return { error: { message: 'unknown option body' }, request: {}, response: {} };
            }
            return { data: { id: 'ses_retry_new' } };
          },
        },
      },
      event: { on: (type, handler) => handlers.set(type, handler) },
      state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'idle' }) } },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => createCalls.length === 2);
    assert.deepEqual(createCalls[0], { body: { title: 'retry title' }, query: { directory: 'H:\\walker' } });
    assert.deepEqual(createCalls[1], { title: 'retry title' });
    await waitFor(() => navigateCalls.some((n) => n.name === 'session' && n.params.sessionID === 'ses_retry_new'));
    await waitFor(() => requests.some((r) => r.url.endsWith('/events') && r.body.deliveryId === 'del_clr_error_retry' && r.body.control));
    const controlReq = requests.find((r) => r.url.endsWith('/events') && r.body.deliveryId === 'del_clr_error_retry' && r.body.control);
    assert.equal(controlReq.body.control.newSessionId, 'ses_retry_new');
    assert.equal(requests.some((r) => r.url.endsWith('/events') && r.body.deliveryId === 'del_clr_error_retry' && r.body.error), false);
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('clear 在 session.create 返回服务端错误时不回退旧参数重复创建', async () => {
  const source = getPluginSource(8787);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  const handlers = new Map();
  const createCalls = [];
  let dispose;
  let clearReturned = false;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    let data = {};
    if (String(url).endsWith('/poll') && !clearReturned) {
      clearReturned = true;
      data = { delivery: { deliveryId: 'del_clr_server_error', type: 'clear', sessionId: 'ses_server_old', title: 'server error title' } };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };

  try {
    await plugin.default.tui({
      route: {
        current: { name: 'session', params: { sessionID: 'ses_server_old' } },
        navigate: () => { throw new Error('不应导航'); },
      },
      client: {
        session: {
          get: async () => ({ id: 'ses_server_old', workspaceID: 'wks_server' }),
          create: async (input) => {
            createCalls.push(input);
            return { error: { message: 'Unexpected server error. Check server logs for details.', ref: 'err_ff6339d6' }, request: {}, response: {} };
          },
        },
      },
      event: { on: (type, handler) => handlers.set(type, handler) },
      state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'idle' }) } },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => requests.some((r) => r.url.endsWith('/events') && r.body.deliveryId === 'del_clr_server_error' && r.body.error));
    assert.equal(createCalls.length, 1);
    assert.deepEqual(createCalls[0], {
      body: { title: 'server error title', workspaceID: 'wks_server' },
      query: { directory: 'H:\\walker', workspace: 'wks_server' },
      headers: { 'x-opencode-workspace': 'wks_server' },
    });
    const errorReq = requests.find((r) => r.url.endsWith('/events') && r.body.deliveryId === 'del_clr_server_error' && r.body.error);
    assert.match(errorReq.body.error.message, /Unexpected server error/);
    assert.equal(requests.some((r) => r.url.endsWith('/events') && r.body.deliveryId === 'del_clr_server_error' && r.body.control), false);
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('clear 在 session.create 返回业务 Bad Request 时不回退旧参数重复创建', async () => {
  const source = getPluginSource(8787);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  const createCalls = [];
  let dispose;
  let clearReturned = false;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    let data = {};
    if (String(url).endsWith('/poll') && !clearReturned) {
      clearReturned = true;
      data = { delivery: { deliveryId: 'del_clr_bad_request', type: 'clear', sessionId: 'ses_bad_request_old' } };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };

  try {
    await plugin.default.tui({
      route: {
        current: { name: 'session', params: { sessionID: 'ses_bad_request_old' } },
        navigate: () => { throw new Error('不应导航'); },
      },
      client: {
        session: {
          create: async (input) => {
            createCalls.push(input);
            return { error: { message: 'Bad Request: invalid workspace' }, request: {}, response: {} };
          },
        },
      },
      event: { on: () => {} },
      state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'idle' }) } },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => requests.some((r) => r.url.endsWith('/events') && r.body.deliveryId === 'del_clr_bad_request' && r.body.error));
    assert.equal(createCalls.length, 1);
    const errorReq = requests.find((r) => r.url.endsWith('/events') && r.body.deliveryId === 'del_clr_bad_request' && r.body.error);
    assert.match(errorReq.body.error.message, /invalid workspace/);
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

test('生成的 TUI plugin 转发原生 question 事件并保留完整载荷', async () => {
  const source = getPluginSource(8787);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  const handlers = new Map();
  let dispose;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
  };

  try {
    await plugin.default.tui({
      route: { current: { name: 'session', params: { sessionID: 'ses_question_events' } } },
      client: { session: { promptAsync: async () => ({ data: null }) } },
      event: { on: (type, handler) => handlers.set(type, handler) },
      state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'idle' }) } },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    const question = {
      question: '选择部署方式',
      header: '部署',
      options: [{ label: '滚动', description: '不中断服务' }],
      multiple: false,
      custom: true,
    };
    await handlers.get('question.asked')({ properties: {
      id: 'req_native', sessionID: 'ses_question_events', questions: [question], tool: { messageID: 'msg_1', callID: 'call_1' },
    } });
    await handlers.get('question.replied')({ properties: {
      requestID: 'req_native', sessionID: 'ses_question_events', answers: [['滚动']],
    } });
    await handlers.get('question.rejected')({ properties: { requestID: 'req_native', sessionID: 'ses_question_events' } });

    const events = requests.filter((request) => request.url.endsWith('/events')).flatMap((request) => request.body.events);
    assert.deepEqual(events, [
      { type: 'question_asked', data: { requestID: 'req_native', sessionID: 'ses_question_events', questions: [question], tool: { messageID: 'msg_1', callID: 'call_1' } } },
      { type: 'question_replied', data: { requestID: 'req_native', sessionID: 'ses_question_events', answers: [['滚动']] } },
      { type: 'question_rejected', data: { requestID: 'req_native', sessionID: 'ses_question_events' } },
    ]);
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('busy 会话重试 question_reply accepted 后只通过原生 SDK 执行', async () => {
  const source = getPluginSource(8787);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  const questionReplyCalls = [];
  let dispose;
  let pollReturned = false;
  let acceptedAttempts = 0;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    const isPoll = String(url).endsWith('/poll');
    const isAccepted = String(url).endsWith('/events') && body.deliveryState === 'accepted';
    if (isPoll && !pollReturned) {
      pollReturned = true;
      return { ok: true, status: 200, json: async () => ({ ok: true, data: {
        delivery: { deliveryId: 'del_question', type: 'question_reply', sessionId: 'ses_busy', requestID: 'req_busy', answers: [['接受']] },
      } }) };
    }
    if (isAccepted && ++acceptedAttempts === 1) {
      return { ok: false, status: 503, json: async () => ({ ok: false, error: { message: 'temporarily unavailable' } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
  };

  try {
    await plugin.default.tui({
      route: { current: { name: 'session', params: { sessionID: 'ses_busy' } } },
      client: {
        session: { promptAsync: async () => { throw new Error('question_reply 不得调用 promptAsync'); } },
        question: { reply: async (input) => { questionReplyCalls.push(input); return { data: null }; } },
      },
      event: { on: () => {} },
      state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'busy' }) } },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => questionReplyCalls.length === 1, 2000);
    assert.deepEqual(questionReplyCalls, [{ requestID: 'req_busy', answers: [['接受']] }]);
    assert.equal(acceptedAttempts, 2, 'accepted 临时失败后应由后续 tick 重试');
    const polls = requests.filter((request) => request.url.endsWith('/poll'));
    assert.ok(polls.length >= 1);
    assert.deepEqual(polls[0].body.acceptedTypes, ['question_reply', 'permission_reply']);
    assert.equal(polls.filter((request) => request.body.acceptedTypes.includes('question_reply')).length, 1, '等待 accepted 时不得重新 poll 控制队列');
    const final = requests.find((request) => request.url.endsWith('/events') && request.body.deliveryId === 'del_question' && request.body.deliveryState === 'final');
    assert.ok(final, 'SDK 成功后应独立 final 控制 delivery');
    assert.equal(final.body.error, null);
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('idle poll 声明全部 v5 delivery 类型，过期 question_reply 不调用 SDK 或 final', async () => {
  const source = getPluginSource(8787);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  const questionReplyCalls = [];
  let dispose;
  let pollReturned = false;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    if (String(url).endsWith('/poll') && !pollReturned) {
      pollReturned = true;
      return { ok: true, status: 200, json: async () => ({ ok: true, data: {
        delivery: { deliveryId: 'del_expired', type: 'question_reply', sessionId: 'ses_idle', requestID: 'req_expired', answers: [['不应提交']] },
      } }) };
    }
    if (String(url).endsWith('/events') && body.deliveryState === 'accepted') {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { expired: true } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
  };

  try {
    await plugin.default.tui({
      route: { current: { name: 'session', params: { sessionID: 'ses_idle' } } },
      client: {
        session: { promptAsync: async () => ({ data: null }) },
        question: { reply: async (input) => questionReplyCalls.push(input) },
      },
      event: { on: () => {} },
      state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'idle' }) } },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => requests.some((request) => request.url.endsWith('/events') && request.body.deliveryState === 'accepted'));
    const poll = requests.find((request) => request.url.endsWith('/poll'));
    assert.deepEqual(poll.body.acceptedTypes, ['prompt', 'clear', 'question_reply', 'permission_reply']);
    assert.deepEqual(questionReplyCalls, []);
    assert.equal(requests.some((request) => request.url.endsWith('/events') && request.body.deliveryId === 'del_expired' && request.body.deliveryState === 'final'), false);
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('非法 question_reply 在未调用 SDK 时上报稳定错误 final', async () => {
  const source = getPluginSource(8787);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  const questionReplyCalls = [];
  let dispose;
  let pollReturned = false;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    if (String(url).endsWith('/poll') && !pollReturned) {
      pollReturned = true;
      return { ok: true, status: 200, json: async () => ({ ok: true, data: {
        delivery: { deliveryId: 'del_invalid', type: 'question_reply', sessionId: 'ses_invalid', requestID: '', answers: [] },
      } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
  };

  try {
    await plugin.default.tui({
      route: { current: { name: 'session', params: { sessionID: 'ses_invalid' } } },
      client: {
        session: { promptAsync: async () => ({ data: null }) },
        question: { reply: async (input) => questionReplyCalls.push(input) },
      },
      event: { on: () => {} },
      state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'idle' }) } },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => requests.some((request) => request.url.endsWith('/events') && request.body.deliveryState === 'final'));
    const final = requests.find((request) => request.url.endsWith('/events') && request.body.deliveryId === 'del_invalid' && request.body.deliveryState === 'final');
    assert.deepEqual(questionReplyCalls, []);
    assert.deepEqual(final.body.error, {
      message: 'question_reply requires a requestID and non-empty string answers',
      code: 'QUESTION_REPLY_INVALID_PAYLOAD',
      deliveryPhase: 'queued',
      sdkInvoked: false,
      safeToRetry: false,
    });
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('生成的 TUI plugin 优先调用 OpenCode 1.18 TUI permission.reply 并回传状态', async () => {
  const source = getPluginSource(8787, '', 15);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  const permissionCalls = [];
  let dispose;
  let deliveryReturned = false;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    let data = {};
    if (String(url).endsWith('/poll') && !deliveryReturned) {
      deliveryReturned = true;
      data = { delivery: { deliveryId: 'del_permission', type: 'permission_reply', sessionId: 'ses_permission', permissionId: 'perm_external_dir', response: 'allow', remember: false } };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };

  const client = {
    session: {
      promptAsync: async () => { throw new Error('permission_reply 不得调用 promptAsync'); },
    },
    permission: {
      reply(input) {
        assert.equal(this, client.permission);
        permissionCalls.push(input);
        return Promise.resolve({ data: true });
      },
    },
    postSessionIdPermissionsPermissionId: async () => { throw new Error('不得调用旧版 1.17 顶层 postSessionIdPermissionsPermissionId'); },
  };

  try {
    await plugin.default.tui({
      route: { current: { name: 'session', params: { sessionID: 'ses_permission' } } },
      client,
      event: { on: () => {} },
      state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'idle' }) } },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => permissionCalls.length === 1);
    assert.deepEqual(permissionCalls[0], {
      requestID: 'perm_external_dir',
      reply: 'once',
      directory: 'H:\\walker',
    });
    await waitFor(() => requests.some((request) => request.url.endsWith('/events')
      && request.body.deliveryId === 'del_permission' && request.body.deliveryState === 'final'));
    assert.ok(requests.some((request) => request.url.endsWith('/events')
      && request.body.deliveryId === 'del_permission' && request.body.deliveryState === 'accepted'));
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('生成的 TUI plugin 使用 OpenCode 1.18 TUI permission.reply', async () => {
  const source = getPluginSource(8787, '', 15);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const permissionCalls = [];
  let dispose;
  let deliveryReturned = false;
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    let data = {};
    if (String(url).endsWith('/poll') && !deliveryReturned) {
      deliveryReturned = true;
      data = { delivery: { deliveryId: 'del_permission_generated', type: 'permission_reply', sessionId: 'ses_permission', permissionId: 'perm_generated', response: 'allow', remember: false } };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };

  try {
    await plugin.default.tui({
      route: { current: { name: 'session', params: { sessionID: 'ses_permission' } } },
      client: {
        permission: {
          reply: (input) => { permissionCalls.push(input); return Promise.resolve({ data: true }); },
        },
      },
      event: { on: () => {} },
      state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'idle' }) } },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => permissionCalls.length === 1);
    assert.deepEqual(permissionCalls[0], {
      requestID: 'perm_generated',
      reply: 'once',
      directory: 'H:\\walker',
    });
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('生成的 TUI plugin 将 permission_reply always 映射为原生 always', async () => {
  const source = getPluginSource(8787, '', 15);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const permissionCalls = [];
  let dispose;
  let deliveryReturned = false;
  const originalFetch = global.fetch;

  global.fetch = async (url, _options) => {
    let data = {};
    if (String(url).endsWith('/poll') && !deliveryReturned) {
      deliveryReturned = true;
      data = { delivery: { deliveryId: 'del_permission_always', type: 'permission_reply', sessionId: 'ses_permission', permissionId: 'perm_external_dir', response: 'always', remember: true } };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };

  try {
    await plugin.default.tui({
      route: { current: { name: 'session', params: { sessionID: 'ses_permission' } } },
      client: {
        permission: {
          reply: (input) => { permissionCalls.push(input); return Promise.resolve({ data: true }); },
        },
      },
      event: { on: () => {} },
      state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'idle' }) } },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => permissionCalls.length === 1);
    assert.deepEqual(permissionCalls[0], {
      requestID: 'perm_external_dir',
      reply: 'always',
      directory: 'H:\\walker',
    });
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('生成的 TUI plugin 缺少权限 SDK 时 permission_reply final 返回明确错误', async () => {
  const source = getPluginSource(8787, '', 15);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  let dispose;
  let deliveryReturned = false;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    let data = {};
    if (String(url).endsWith('/poll') && !deliveryReturned) {
      deliveryReturned = true;
      data = { delivery: { deliveryId: 'del_permission_missing_sdk', type: 'permission_reply', sessionId: 'ses_permission_missing_sdk', permissionId: 'perm_missing', response: 'allow' } };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
  };

  try {
    await plugin.default.tui({
      route: { current: { name: 'session', params: { sessionID: 'ses_permission_missing_sdk' } } },
      client: { session: {} },
      event: { on: () => {} },
      state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'idle' }) } },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => requests.some((request) => request.url.endsWith('/events')
      && request.body.deliveryId === 'del_permission_missing_sdk' && request.body.deliveryState === 'final'));
    const finalReq = requests.find((request) => request.url.endsWith('/events')
      && request.body.deliveryId === 'del_permission_missing_sdk' && request.body.deliveryState === 'final');
    assert.equal(finalReq.body.error.code, 'PERMISSION_REPLY_UNSUPPORTED');
    assert.equal(finalReq.body.error.sdkInvoked, false);
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('父 prompt leased 且 session busy 时控制 delivery 独立 heartbeat 和 final', async () => {
  const source = getPluginSource(8787, '', 10);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  const handlers = new Map();
  const promptCalls = [];
  const questionReplyCalls = [];
  let dispose;
  let sessionBusy = false;
  let pollCount = 0;
  let resolveQuestionReply;
  let releaseReply = false;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    if (String(url).endsWith('/poll')) {
      pollCount++;
      const delivery = pollCount === 1
        ? { deliveryId: 'del_parent', type: 'prompt', sessionId: 'ses_nested', text: '父 prompt' }
        : pollCount === 2
          ? { deliveryId: 'del_control', type: 'question_reply', sessionId: 'ses_nested', requestID: 'req_nested', answers: [['确认']] }
          : null;
      return { ok: true, status: 200, json: async () => ({ ok: true, data: { delivery } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
  };

  try {
    await plugin.default.tui({
      route: { current: { name: 'session', params: { sessionID: 'ses_nested' } } },
      client: {
        session: { promptAsync: async (input) => { promptCalls.push(input); sessionBusy = true; return { data: null }; } },
        question: { reply: async (input) => {
          questionReplyCalls.push(input);
          return new Promise((resolve) => { resolveQuestionReply = resolve; });
        } },
      },
      event: { on: (type, handler) => handlers.set(type, handler) },
      state: {
        path: { directory: 'H:\\walker' },
        session: {
          status: () => ({ type: sessionBusy ? 'busy' : 'idle' }),
          messages: () => (releaseReply ? [{ id: 'msg_nested', role: 'assistant', time: { completed: 1 } }] : []),
        },
        part: () => [{ type: 'text', text: '父 prompt 完成' }],
      },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => questionReplyCalls.length === 1, 2000);
    assert.deepEqual(promptCalls, [{ sessionID: 'ses_nested', parts: [{ type: 'text', text: '父 prompt' }] }]);
    assert.deepEqual(questionReplyCalls, [{ requestID: 'req_nested', answers: [['确认']] }]);
    const polls = requests.filter((request) => request.url.endsWith('/poll'));
    assert.deepEqual(polls[1].body.acceptedTypes, ['question_reply', 'permission_reply']);
    await waitFor(() => {
      const heartbeatIds = new Set(requests
        .filter((request) => request.url.endsWith('/events') && request.body.deliveryState === 'heartbeat')
        .map((request) => request.body.deliveryId));
      return heartbeatIds.has('del_parent') && heartbeatIds.has('del_control');
    });

    releaseReply = true;
    await handlers.get('session.idle')({ properties: { sessionID: 'ses_nested' } });
    await handlers.get('session.error')({ properties: { sessionID: 'ses_nested', error: { message: '父会话稍后错误' } } });
    const parentFinal = requests.find((request) => request.url.endsWith('/events') && request.body.deliveryId === 'del_parent' && request.body.deliveryState === 'final');
    assert.ok(parentFinal, 'session.idle 只应完结父 delivery');
    assert.equal(requests.some((request) => request.url.endsWith('/events') && request.body.deliveryId === 'del_control' && request.body.deliveryState === 'final'), false, 'session idle/error 不得误终结仍在执行的控制 delivery');

    resolveQuestionReply({ data: null });
    await waitFor(() => requests.some((request) => request.url.endsWith('/events') && request.body.deliveryId === 'del_control' && request.body.deliveryState === 'final'));
    const controlFinal = requests.find((request) => request.url.endsWith('/events') && request.body.deliveryId === 'del_control' && request.body.deliveryState === 'final');
    assert.equal(controlFinal.body.error, null);
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('question reply SDK 失败 final 标注已调用且不可重试', async () => {
  const source = getPluginSource(8787);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  let dispose;
  let pollReturned = false;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    if (String(url).endsWith('/poll') && !pollReturned) {
      pollReturned = true;
      return { ok: true, status: 200, json: async () => ({ ok: true, data: {
        delivery: { deliveryId: 'del_sdk_error', type: 'question_reply', sessionId: 'ses_sdk_error', requestID: 'req_sdk_error', answers: [['提交']] },
      } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
  };

  try {
    const sdkError = new Error('OpenCode request not found');
    sdkError.code = 'QUESTION_NOT_FOUND';
    await plugin.default.tui({
      route: { current: { name: 'session', params: { sessionID: 'ses_sdk_error' } } },
      client: {
        session: { promptAsync: async () => { throw new Error('不得调用 promptAsync'); } },
        question: { reply: async () => { throw sdkError; } },
      },
      event: { on: () => {} },
      state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'busy' }) } },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => requests.some((request) => request.url.endsWith('/events') && request.body.deliveryId === 'del_sdk_error' && request.body.deliveryState === 'final'));
    const final = requests.find((request) => request.url.endsWith('/events') && request.body.deliveryId === 'del_sdk_error' && request.body.deliveryState === 'final');
    assert.deepEqual(final.body.error, {
      message: 'OpenCode request not found',
      code: 'QUESTION_NOT_FOUND',
      deliveryPhase: 'leased',
      sdkInvoked: true,
      safeToRetry: false,
    });
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('question reply SDK 缺少 question.reply 时不可重试降级且不标记已调用', async () => {
  const source = getPluginSource(8787);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  let dispose;
  let pollReturned = false;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    if (String(url).endsWith('/poll') && !pollReturned) {
      pollReturned = true;
      return { ok: true, status: 200, json: async () => ({ ok: true, data: {
        delivery: { deliveryId: 'del_no_question_client', type: 'question_reply', sessionId: 'ses_no_question_client', requestID: 'req_no_question_client', answers: [['提交']] },
      } }) };
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
  };

  try {
    await plugin.default.tui({
      route: { current: { name: 'session', params: { sessionID: 'ses_no_question_client' } } },
      client: {
        session: { promptAsync: async () => { throw new Error('不得调用 promptAsync'); } },
      },
      event: { on: () => {} },
      state: { path: { directory: 'H:\walker' }, session: { status: () => ({ type: 'busy' }) } },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await waitFor(() => requests.some((request) => request.url.endsWith('/events') && request.body.deliveryId === 'del_no_question_client' && request.body.deliveryState === 'final'));
    const final = requests.find((request) => request.url.endsWith('/events') && request.body.deliveryId === 'del_no_question_client' && request.body.deliveryState === 'final');
    assert.deepEqual(final.body.error, {
      message: 'OpenCode SDK question.reply is unavailable',
      code: 'QUESTION_REPLY_UNSUPPORTED',
      deliveryPhase: 'queued',
      sdkInvoked: false,
      safeToRetry: false,
    });
  } finally {
    if (dispose) await dispose();
    global.fetch = originalFetch;
  }
});

test('无效原生 question 事件不 report 且后续有效事件正常转发', async () => {
  const source = getPluginSource(8787);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  const handlers = new Map();
  let dispose;
  const originalFetch = global.fetch;
  const originalConsoleError = console.error;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
  };
  console.error = () => {};

  try {
    await plugin.default.tui({
      route: { current: { name: 'session', params: { sessionID: 'ses_invalid_events' } } },
      client: { session: { promptAsync: async () => ({ data: null }) } },
      event: { on: (type, handler) => handlers.set(type, handler) },
      state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'idle' }) } },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await handlers.get('question.asked')({ properties: { id: 'req_invalid', sessionID: 'ses_invalid_events', questions: [] } });
    await handlers.get('question.replied')({ properties: { requestID: 'req_invalid', sessionID: 'ses_invalid_events' } });
    await handlers.get('question.rejected')({ properties: { sessionID: 'ses_invalid_events' } });
    await handlers.get('question.asked')({ properties: {
      id: 'req_valid', sessionID: 'ses_invalid_events', questions: [{ question: '继续？', header: '确认', options: [] }],
    } });

    const events = requests.filter((request) => request.url.endsWith('/events')).flatMap((request) => request.body.events);
    assert.deepEqual(events, [{
      type: 'question_asked',
      data: { requestID: 'req_valid', sessionID: 'ses_invalid_events', questions: [{ question: '继续？', header: '确认', options: [] }] },
    }]);
  } finally {
    if (dispose) await dispose();
    console.error = originalConsoleError;
    global.fetch = originalFetch;
  }
});

test('生成的 TUI plugin 从原生 permission.asked 扁平载荷转发标题和匹配规则', async () => {
  const source = getPluginSource(8787);
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source).toString('base64');
  const plugin = await import(moduleUrl);
  const requests = [];
  const handlers = new Map();
  let dispose;
  const originalFetch = global.fetch;

  global.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url: String(url), body });
    return { ok: true, status: 200, json: async () => ({ ok: true, data: {} }) };
  };

  try {
    await plugin.default.tui({
      route: { current: { name: 'session', params: { sessionID: 'ses_permission_flat' } } },
      client: { session: { promptAsync: async () => ({ data: null }) } },
      event: { on: (type, handler) => handlers.set(type, handler) },
      state: { path: { directory: 'H:\\walker' }, session: { status: () => ({ type: 'idle' }) } },
      lifecycle: { onDispose: (handler) => { dispose = handler; } },
    });

    await handlers.get('permission.asked')({ properties: {
      id: 'perm_external_dir',
      sessionID: 'ses_permission_flat',
      permission: 'external_directory',
      patterns: ['H:\\sacpServ\\frontend\\*'],
      metadata: {},
      always: [],
    } });

    const events = requests.filter((request) => request.url.endsWith('/events')).flatMap((request) => request.body.events);
    assert.deepEqual(events, [{
      type: 'permission',
      data: {
        id: 'perm_external_dir',
        type: 'external_directory',
        title: '访问外部目录 H:\\sacpServ\\frontend',
        description: '',
        metadata: { patterns: ['H:\\sacpServ\\frontend\\*'] },
        sessionID: 'ses_permission_flat',
        messageID: '',
      },
    }]);
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

function withIsolatedConfigEnv(env, fn) {
  const originalHomedir = os.homedir;
  const originalXdg = process.env.XDG_CONFIG_HOME;
  const originalHome = process.env.HOME;
  const originalUserProfile = process.env.USERPROFILE;
  os.homedir = () => env.home;
  if (env.xdg == null) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = env.xdg;
  process.env.HOME = env.home;
  process.env.USERPROFILE = env.home;
  try {
    return fn();
  } finally {
    os.homedir = originalHomedir;
    if (originalXdg == null) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = originalXdg;
    if (originalHome == null) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalUserProfile == null) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = originalUserProfile;
  }
}

function captureStderr(fn) {
  const chunks = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, encoding, callback) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
    return original.call(process.stderr, chunk, encoding, callback);
  };
  try {
    return { result: fn(), text: chunks.join('') };
  } finally {
    process.stderr.write = original;
  }
}

function listTree(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTree(full));
    else out.push(full);
  }
  return out;
}

test('配置目录按显式目录、XDG、HOME 优先级选择', () => {
  const explicit = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-explicit-'));
  const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-xdg-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-home-priority-'));
  const decoyXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-xdg-decoy-'));
  const decoyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-home-decoy-'));
  try {
    const explicitResult = withIsolatedConfigEnv({ xdg: decoyXdg, home: decoyHome }, () => {
      return installHookPlugin({ opencodeConfigDir: explicit, walkerPort: 8787, enabled: true });
    });
    assert.equal(explicitResult.path, path.join(explicit, 'walker-tui-plugin', 'tui.js'));
    assert.equal(fs.existsSync(path.join(explicit, 'cli.json')), true);
    assert.equal(fs.existsSync(path.join(explicit, 'package.json')), false);
    assert.equal(fs.existsSync(path.join(decoyXdg, 'opencode', 'cli.json')), false);
    assert.equal(fs.existsSync(path.join(decoyHome, '.config', 'opencode', 'cli.json')), false);

    const xdgResult = withIsolatedConfigEnv({ xdg, home: decoyHome }, () => {
      return installHookPlugin({ walkerPort: 8787, enabled: true });
    });
    assert.equal(xdgResult.path, path.join(xdg, 'opencode', 'walker-tui-plugin', 'tui.js'));
    assert.equal(fs.existsSync(path.join(xdg, 'opencode', 'cli.json')), true);
    assert.equal(fs.existsSync(path.join(decoyHome, '.config', 'opencode', 'cli.json')), false);

    const homeResult = withIsolatedConfigEnv({ home }, () => {
      return installHookPlugin({ walkerPort: 8787, enabled: true });
    });
    assert.equal(homeResult.path, path.join(home, '.config', 'opencode', 'walker-tui-plugin', 'tui.js'));
    assert.equal(fs.existsSync(path.join(home, '.config', 'opencode', 'cli.json')), true);
    assert.equal(fs.existsSync(path.join(xdg, 'opencode', 'walker-tui-plugin', 'tui.js')), true);
  } finally {
    fs.rmSync(explicit, { recursive: true, force: true });
    fs.rmSync(xdg, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(decoyXdg, { recursive: true, force: true });
    fs.rmSync(decoyHome, { recursive: true, force: true });
  }
});

test('旧的裸 JS 入口换成包目录，同名非 Walker 文件不删除', () => {
  const { tmpDir } = createTempConfigDir();
  const legacyPath = path.join(tmpDir, 'walker-tui-plugin.js');
  const foreignPath = path.join(tmpDir, 'third-party.js');
  const legacySource = getV2PluginEntrySource();
  fs.writeFileSync(legacyPath, legacySource, 'utf8');
  fs.writeFileSync(foreignPath, '// third-party plugin keep me\n', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'cli.json'), JSON.stringify({
    theme: 'keep',
    plugins: [pathToFileURL(legacyPath).href, pathToFileURL(foreignPath).href],
  }, null, 2) + '\n', 'utf8');

  const result = installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });

  const pluginDir = path.join(tmpDir, 'walker-tui-plugin');
  const cli = JSON.parse(fs.readFileSync(path.join(tmpDir, 'cli.json'), 'utf8'));
  assert.equal(result.path, path.join(pluginDir, 'tui.js'));
  assert.equal(fs.existsSync(legacyPath), false);
  assert.equal(fs.readFileSync(foreignPath, 'utf8'), '// third-party plugin keep me\n');
  assert.equal(fs.existsSync(path.join(tmpDir, 'package.json')), false);
  assert.match(fs.readFileSync(result.path, 'utf8'), /import \{ setup \} from '\.\.\/walker-tui-bridge\.js'/);
  assert.equal(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'), getV2PackageManifest());
  assert.equal(cli.theme, 'keep');
  assert.deepEqual(cli.plugins, [pathToFileURL(foreignPath).href, pathToFileURL(pluginDir).href]);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('plugins 不是数组时拒绝写入并保持原文件', () => {
  for (const plugins of [{ url: 'kept' }, 'walker-tui-plugin.js', null]) {
    const { tmpDir } = createTempConfigDir();
    const configPath = path.join(tmpDir, 'cli.json');
    const pluginPath = path.join(tmpDir, 'walker-tui-plugin.js');
    const originalConfig = JSON.stringify({ plugins, theme: 'keep' }, null, 2) + '\n';
    const originalPlugin = '// third-party same name\n';
    fs.writeFileSync(configPath, originalConfig, 'utf8');
    fs.writeFileSync(pluginPath, originalPlugin, 'utf8');

    const result = installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });

    assert.equal(result.installed, false);
    assert.equal(result.reason, 'error');
    assert.match(result.error, /plugins must be an array/);
    assert.equal(fs.readFileSync(configPath, 'utf8'), originalConfig);
    assert.equal(fs.readFileSync(pluginPath, 'utf8'), originalPlugin);
    assert.equal(fs.existsSync(path.join(tmpDir, 'walker-tui-bridge.js')), false);
    assert.equal(fs.existsSync(path.join(tmpDir, 'walker-tui-plugin-v1.js')), false);
    assert.equal(fs.readdirSync(tmpDir).some((name) => name.includes('.tmp')), false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('改名失败时回滚已写文件并保留原配置', () => {
  const { tmpDir } = createTempConfigDir();
  const configPath = path.join(tmpDir, 'cli.json');
  const v2Path = path.join(tmpDir, 'walker-tui-plugin.js');
  const originalConfig = JSON.stringify({ plugins: ['npm:third-party'], theme: 'keep' }, null, 2) + '\n';
  const originalPlugin = '// Walker TUI bridge version: 3\nold-entry\n';
  fs.writeFileSync(configPath, originalConfig, 'utf8');
  fs.writeFileSync(v2Path, originalPlugin, 'utf8');
  const originalRename = fs.renameSync;
  fs.renameSync = function patchedRename(from, to) {
    if (String(from).endsWith('.tmp') && String(to) === configPath) {
      const error = new Error('rename failed');
      error.code = 'EPERM';
      throw error;
    }
    return originalRename.call(fs, from, to);
  };
  try {
    const result = installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });
    assert.equal(result.installed, false);
    assert.equal(result.reason, 'error');
    assert.match(result.error, /rename failed/);
    assert.equal(fs.readFileSync(configPath, 'utf8'), originalConfig);
    assert.equal(fs.readFileSync(v2Path, 'utf8'), originalPlugin);
    assert.equal(fs.existsSync(path.join(tmpDir, 'walker-tui-bridge.js')), false);
    assert.equal(fs.existsSync(path.join(tmpDir, 'walker-tui-plugin-v1.js')), false);
    assert.equal(fs.readdirSync(tmpDir).some((name) => name.includes('.tmp') || name.endsWith('.bak')), false);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(config.plugins, ['npm:third-party']);
    assert.equal(config.theme, 'keep');
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('连续安装两次不重复注册且不改无关字段', () => {
  const { tmpDir } = createTempConfigDir();
  const configPath = path.join(tmpDir, 'cli.json');
  fs.writeFileSync(configPath, JSON.stringify({
    theme: 'custom',
    diffs: { wrap: 'word' },
    server: { port: 4096 },
    plugins: ['npm:other-plugin'],
  }, null, 2) + '\n', 'utf8');

  const first = installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });
  const afterFirst = fs.readFileSync(configPath, 'utf8');
  const second = installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });
  const parsed = JSON.parse(afterFirst);

  assert.equal(first.installed, true);
  assert.equal(second.installed, false);
  assert.equal(second.reason, 'already_exists');
  assert.equal(fs.readFileSync(configPath, 'utf8'), afterFirst);
  assert.equal(parsed.theme, 'custom');
  assert.equal(parsed.diffs.wrap, 'word');
  assert.equal(parsed.server.port, 4096);
  assert.equal(parsed.plugins.filter((entry) => entry === 'npm:other-plugin').length, 1);
  assert.equal(parsed.plugins.filter((entry) => entry === pathToFileURL(path.join(tmpDir, 'walker-tui-plugin')).href).length, 1);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('同名非 Walker 路径保留，可识别旧入口迁到 V1', () => {
  const { tmpDir } = createTempConfigDir();
  const otherDir = path.join(tmpDir, 'other');
  fs.mkdirSync(otherDir);
  const foreignPath = path.join(otherDir, 'walker-tui-plugin.js');
  const foreignText = '// third-party plugin keep me\n';
  fs.writeFileSync(foreignPath, foreignText, 'utf8');
  const oldWalker = path.join(tmpDir, 'legacy-walker.js');
  fs.writeFileSync(oldWalker, '// Walker TUI bridge version: 3\n', 'utf8');
  const foreignUrl = pathToFileURL(foreignPath).href;
  const oldUrl = pathToFileURL(oldWalker).href;
  fs.writeFileSync(path.join(tmpDir, 'cli.json'), JSON.stringify({
    editor: 'vim',
    plugins: [foreignUrl, 'npm:keep-me'],
  }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'tui.json'), JSON.stringify({
    theme: 'custom',
    plugin: [oldUrl, foreignUrl, 'other-plugin'],
  }, null, 2) + '\n', 'utf8');

  installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });

  assert.equal(fs.readFileSync(foreignPath, 'utf8'), foreignText);
  const cli = JSON.parse(fs.readFileSync(path.join(tmpDir, 'cli.json'), 'utf8'));
  const v2Url = pathToFileURL(path.join(tmpDir, 'walker-tui-plugin')).href;
  const v1Url = pathToFileURL(path.join(tmpDir, 'walker-tui-plugin-v1.js')).href;
  assert.equal(cli.editor, 'vim');
  assert.equal(cli.plugins.includes(foreignUrl), true);
  assert.equal(cli.plugins.includes('npm:keep-me'), true);
  assert.equal(cli.plugins.filter((entry) => entry === v2Url).length, 1);
  assert.equal(cli.plugins.includes(v1Url), false);
  const tui = JSON.parse(fs.readFileSync(path.join(tmpDir, 'tui.json'), 'utf8'));
  assert.equal(tui.theme, 'custom');
  assert.equal(tui.plugin.includes(oldUrl), false);
  assert.equal(tui.plugin.includes(foreignUrl), true);
  assert.equal(tui.plugin.includes('other-plugin'), true);
  assert.equal(tui.plugin.filter((entry) => entry === v1Url).length, 1);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('安装成功和失败都不把令牌或密码写入日志、返回值和可编辑配置', () => {
  const token = 'WALKER_TOKEN_SENTINEL_9f3a';
  const password = 'FEISHU_PASSWORD_SENTINEL_7c2b';
  const { tmpDir } = createTempConfigDir();
  const failDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-hook-secret-'));
  const originalSecret = process.env.FEISHU_APP_SECRET;
  const originalRename = fs.renameSync;
  process.env.FEISHU_APP_SECRET = password;
  try {
    const success = captureStderr(() => installHookPlugin({
      opencodeConfigDir: tmpDir,
      walkerPort: 8787,
      enabled: true,
      walkerToken: token,
      feishuPassword: password,
    }));
    const successText = JSON.stringify(success.result) + success.text;
    assert.equal(successText.includes(token), false);
    assert.equal(successText.includes(password), false);
    const files = listTree(tmpDir);
    const bridge = fs.readFileSync(path.join(tmpDir, 'walker-tui-bridge.js'), 'utf8');
    assert.equal(bridge.includes(token), true);
    assert.equal(bridge.includes(password), false);
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      assert.equal(content.includes(password), false, file);
      if (!file.endsWith('walker-tui-bridge.js')) assert.equal(content.includes(token), false, file);
    }
    assert.equal(fs.existsSync(path.join(tmpDir, 'package.json')), false);

    fs.renameSync = function patchedRename(from, to) {
      if (String(from).includes(failDir) && String(from).includes('.tmp')) {
        throw new Error('rename failed ' + token + ' ' + password);
      }
      return originalRename.call(fs, from, to);
    };
    const failure = captureStderr(() => installHookPlugin({
      opencodeConfigDir: failDir,
      walkerPort: 8787,
      enabled: true,
      walkerToken: token,
      feishuPassword: password,
    }));
    const failureText = JSON.stringify(failure.result) + failure.text;
    assert.equal(failure.result.installed, false);
    assert.equal(failure.result.reason, 'error');
    assert.equal(failureText.includes(token), false);
    assert.equal(failureText.includes(password), false);
    assert.match(failure.result.error, /\[redacted\]/);
    assert.match(failure.text, /\[redacted\]/);
    for (const file of listTree(failDir)) {
      const content = fs.readFileSync(file, 'utf8');
      assert.equal(content.includes(token), false, file);
      assert.equal(content.includes(password), false, file);
    }
  } finally {
    fs.renameSync = originalRename;
    if (originalSecret == null) delete process.env.FEISHU_APP_SECRET;
    else process.env.FEISHU_APP_SECRET = originalSecret;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(failDir, { recursive: true, force: true });
  }
});
