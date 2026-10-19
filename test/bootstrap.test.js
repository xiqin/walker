const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');
const net = require('net');
const { createApp, resolveDataDir } = require('../src/app/bootstrap');
const { createStatusAdmin } = require('../src/admin/status-admin');
const { MessageDispatcher } = require('../src/dispatch/message-dispatcher');
const { AgentEvent } = require('../src/drivers/agent-driver');

/** 构建标准测试依赖映射，adminEnabled 控制是否注入 admin server */
function makeModelCardApp(apiCalls, apiOverrides) {
  const config = {
    feishuAppId: 'cli_test', feishuAppSecret: 'test_secret', feishuRouteMode: 'thread',
    walkerDefaultAgent: 'opencode', walkerDefaultRuntime: 'windows', walkerDefaultCwd: 'H:\\walker',
    walkerDataDir: '', opencodeServerUrl: '', opencodeServerAutostart: false,
    opencodeCmd: 'opencode', walkerWslDistro: 'Ubuntu-24.04',
    feishuProgressStyle: 'card', feishuReactionEmoji: '', feishuDoneEmoji: '',
    admin: { enabled: false, host: '127.0.0.1', port: 8787, token: '' },
  };
  const api = Object.assign({
    replyCard: async (replyCtx, card) => {
      apiCalls.push({ type: 'replyCard', replyCtx, card });
      return 'om_model_reply';
    },
    patchCard: async (messageId, card) => {
      apiCalls.push({ type: 'patchCard', messageId, card });
      return 'om_model_patch';
    },
  }, apiOverrides || {});
  const deps = {
    FeishuPlatform: class {
      constructor() { this.api = api; }
      start() { return Promise.resolve(); }
      stop() {}
    },
    SessionService: class { recoverOnStartup() { return []; } cleanOrphanRoutes() { return []; } },
    JsonStore: class {},
    OpencodeDriver: class {},
    OpencodeTuiBridge: class { setOnSessionEnrolled() {} close() {} },
    stubClaudeDriver: () => ({}),
    stubCodexDriver: () => ({}),
    DriverRegistry: class { register() {} get() { return null; } },
    createRuntime: () => ({}),
    MessageDedup: class {},
    MessageDispatcher: class { constructor(options) { this.feishuApi = options.feishuApi; } },
    AttachmentService: class {},
    createEventStore: () => ({ events: [], metrics: { messages: 0, commands: 0, prompts: 0, errors: 0, promptDurationsMs: [], entries: [] }, now: Date.now, nextEventId: 1 }),
    createAdminServer: () => null,
  };
  return createApp(config, deps);
}

function makeModelPaginationIntegrationApp(apiCalls) {
  const session = {
    id: 'wks_model_page',
    agent: 'opencode',
    status: 'idle',
    model: { providerID: 'custom', modelID: 'model-1' },
  };
  const models = Array.from({ length: 21 }, (_, index) => ({
    id: 'model-' + (index + 1),
    name: 'Model ' + (index + 1),
    provider: 'custom',
    status: 'active',
    enabled: true,
  }));
  const config = {
    feishuAppId: 'cli_test', feishuAppSecret: 'test_secret', feishuRouteMode: 'thread',
    walkerDefaultAgent: 'opencode', walkerDefaultRuntime: 'windows', walkerDefaultCwd: 'H:\\walker',
    walkerDataDir: '', opencodeServerUrl: '', opencodeServerAutostart: false,
    opencodeCmd: 'opencode', walkerWslDistro: 'Ubuntu-24.04',
    feishuProgressStyle: 'card', feishuReactionEmoji: '', feishuDoneEmoji: '',
    admin: { enabled: false, host: '127.0.0.1', port: 8787, token: '' },
  };
  const deps = {
    FeishuPlatform: class {
      constructor(options) {
        this.options = options;
        this.api = {
          patchCard: async (messageId, card) => {
            apiCalls.push({ type: 'patchCard', messageId, card });
            return 'om_model_patch';
          },
          replyCard: async (replyCtx, card) => {
            apiCalls.push({ type: 'replyCard', replyCtx, card });
            return 'om_model_reply';
          },
          replyText: async (replyCtx, text) => {
            apiCalls.push({ type: 'replyText', replyCtx, text });
            return 'om_text_reply';
          },
          replyMarkdown: async (replyCtx, text) => {
            apiCalls.push({ type: 'replyMarkdown', replyCtx, text });
            return 'om_text_reply';
          },
        };
      }
      start() { return Promise.resolve(); }
      stop() {}
    },
    SessionService: class {
      getCurrent() { return session; }
      touchRoute() {}
      recoverOnStartup() { return []; }
      cleanOrphanRoutes() { return []; }
    },
    JsonStore: class {},
    OpencodeDriver: class {
      async ensureReady() {}
      async listModels() { return models; }
    },
    OpencodeTuiBridge: class { setOnSessionEnrolled() {} close() {} },
    stubClaudeDriver: () => ({}),
    stubCodexDriver: () => ({}),
    DriverRegistry: class {
      constructor() { this.drivers = new Map(); }
      register(name, driver) { this.drivers.set(name, driver); }
      get(name) { return this.drivers.get(name); }
    },
    createRuntime: () => ({}),
    MessageDedup: class { isDuplicate() { return false; } },
    MessageDispatcher,
    AttachmentService: class {},
    createEventStore: () => ({ events: [], metrics: { messages: 0, commands: 0, prompts: 0, errors: 0, promptDurationsMs: [], entries: [] }, now: Date.now, nextEventId: 1 }),
    createAdminServer: () => null,
  };
  return createApp(config, deps);
}

describe('createApp', () => {
  it('启动时把 ~/.walker 数据目录展开到真实用户目录', () => {
    const actual = resolveDataDir('~/.walker', { homeDir: 'C:\\Users\\tester' });

    assert.equal(actual, path.join('C:\\Users\\tester', '.walker'));
  });

  it('未配置数据目录时使用检测到的用户目录', () => {
    const actual = resolveDataDir('', { homeDir: 'C:\\Users\\tester', env: { USERPROFILE: '~', HOME: '~' } });

    assert.equal(actual, path.join('C:\\Users\\tester', '.walker'));
  });

  it('基础飞书 adapter 向文本、Markdown 和卡片 API 转发 runtime metadata', async () => {
    const calls = [];
    const runtime = { model: { providerID: 'cpa', modelID: 'gpt-5.5' }, tokenUsage: { totalTokens: 321 } };
    const app = makeModelCardApp(calls, {
      replyText: async (_ctx, _text, value) => { calls.push({ type: 'replyText', runtime: value }); },
      replyMarkdown: async (_ctx, _text, value) => { calls.push({ type: 'replyMarkdown', runtime: value }); },
      sendText: async (_chatId, _text, value) => { calls.push({ type: 'sendText', runtime: value }); },
      sendMarkdown: async (_chatId, _text, value) => { calls.push({ type: 'sendMarkdown', runtime: value }); },
      replyCard: async (_ctx, _card, value) => { calls.push({ type: 'replyCard', runtime: value }); return 'om_card'; },
      patchCard: async (_cardId, _card, value) => { calls.push({ type: 'patchCard', runtime: value }); },
    });

    await app.dispatcher.feishuApi.replyText({ messageId: 'om_parent' }, 'text', runtime);
    await app.dispatcher.feishuApi.replyMarkdown({ messageId: 'om_parent' }, 'markdown', runtime);
    await app.dispatcher.feishuApi.sendText('oc_chat', 'text', runtime);
    await app.dispatcher.feishuApi.sendMarkdown('oc_chat', 'markdown', runtime);
    await app.dispatcher.feishuApi.replyCard({ messageId: 'om_parent' }, {}, runtime);
    await app.dispatcher.feishuApi.patchCard('om_card', {}, runtime);

    assert.equal(calls.length, 6);
    for (const call of calls) assert.equal(call.runtime, runtime, call.type + ' 应转发 runtime');
  });

  it('卡片分页 action 经 onCardAction 和 dispatcher 原地渲染目标页', async () => {
    const calls = [];
    const app = makeModelPaginationIntegrationApp(calls);

    await app.platform.options.onCardAction({
      action: 'cmd:/model --page 2',
      routeKey: 'feishu:oc_chat1:root:om_root1',
      chatId: 'oc_chat1',
      messageId: 'om_original_model_card',
      openId: 'ou_user1',
    });

    const patches = calls.filter((call) => call.type === 'patchCard');
    assert.equal(patches.length, 1);
    assert.equal(patches[0].messageId, 'om_original_model_card');
    assert.ok(patches[0].card.body.elements.some((el) => el.content === '第 2 / 2 页'));
    assert.ok(patches[0].card.body.elements.some((el) => el.tag === 'button' && el.text && el.text.content === 'Model 21 (custom)'));
    assert.equal(calls.filter((call) => call.type === 'replyText').length, 0);
    assert.equal(calls.filter((call) => call.type === 'replyCard').length, 0);
  });

  it('sendModelList 首次打开使用 replyCard 并保留 routeKey 与页码', async () => {
    const calls = [];
    const app = makeModelCardApp(calls);

    const result = await app.dispatcher.feishuApi.sendModelList(
      { messageId: 'om_trigger', chatId: 'oc_chat1' },
      [{ id: 'model-1', name: 'Model 1', provider: 'custom', status: 'active', enabled: true }],
      { routeKey: 'feishu:oc_chat1:root:om_root1', page: 2 },
    );

    assert.equal(result, 'om_model_reply');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, 'replyCard');
    assert.deepEqual(calls[0].replyCtx, { messageId: 'om_trigger', chatId: 'oc_chat1' });
    assert.ok(calls[0].card.body.elements.some(el => el.content === '第 1 / 1 页'));
    const modelButton = calls[0].card.body.elements.find(el => el.tag === 'button' && el.text && el.text.content === 'Model 1 (custom)');
    assert.equal(modelButton.behaviors[0].value.routeKey, 'feishu:oc_chat1:root:om_root1');
  });

  it('sendModelList 带 updateMessageId 时使用 patchCard 更新原卡片', async () => {
    const calls = [];
    const app = makeModelCardApp(calls);

    const result = await app.dispatcher.feishuApi.sendModelList(
      { messageId: 'om_action', chatId: 'oc_chat1' },
      Array.from({ length: 21 }, (_, index) => ({
        id: 'model-' + (index + 1), name: 'Model ' + (index + 1), provider: 'custom', status: 'active', enabled: true,
      })),
      { routeKey: 'feishu:oc_chat1:root:om_root1', page: 2, updateMessageId: 'om_original_card' },
    );

    assert.equal(result, 'om_model_patch');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, 'patchCard');
    assert.equal(calls[0].messageId, 'om_original_card');
    assert.ok(calls[0].card.body.elements.some(el => el.content === '第 2 / 2 页'));
  });

  it('sendModelList 不吞 patchCard 的空返回值或异常', async () => {
    const falsyCalls = [];
    const falsyApp = makeModelCardApp(falsyCalls, {
      patchCard: async (messageId, card) => {
        falsyCalls.push({ type: 'patchCard', messageId, card });
        return null;
      },
    });
    const options = { page: 1, updateMessageId: 'om_original_card' };

    const falsyResult = await falsyApp.dispatcher.feishuApi.sendModelList({}, [], options);

    assert.equal(falsyResult, null);
    assert.equal(falsyCalls.length, 1);

    const error = new Error('patch failed');
    const throwingApp = makeModelCardApp([], {
      patchCard: async () => { throw error; },
    });
    await assert.rejects(
      throwingApp.dispatcher.feishuApi.sendModelList({}, [], options),
      error,
    );
  });

  it('组装并启动 FeishuPlatform，不连接 opendray', async () => {
    const platformStarted = [];
    const config = {
      feishuAppId: 'cli_test',
      feishuAppSecret: 'test_secret',
      feishuRouteMode: 'thread',
      walkerDefaultAgent: 'opencode',
      walkerDefaultRuntime: 'windows',
      walkerDefaultCwd: 'H:\\walker',
      walkerDataDir: '',
      opencodeServerUrl: 'http://localhost:4096',
      opencodeServerAutostart: false,
      opencodeCmd: 'opencode',
      walkerWslDistro: 'Ubuntu-24.04',
      feishuProgressStyle: 'card',
      feishuReactionEmoji: 'OnIt',
      feishuDoneEmoji: 'none',
    };
    const deps = {
      FeishuPlatform: class {
        start() { platformStarted.push('feishu'); return Promise.resolve(); }
      },
      SessionService: class {
        constructor() { this.stateStore = { read: () => ({ sessions: {}, routes: {} }) }; }
        recoverOnStartup() { return []; }
        cleanOrphanRoutes() { return []; }
      },
      JsonStore: class { constructor() { this.read = () => ({}); this.update = () => {}; } },
      OpencodeDriver: class { constructor() {} },
      ClaudeDriver: class { constructor() { this.name = 'claude'; } },
      stubClaudeDriver: () => ({ name: 'claude-stub' }),
      stubCodexDriver: () => ({ name: 'codex' }),
      DriverRegistry: class {
        register() {}
        get() { return null; }
      },
      createRuntime: () => ({ _spawn: () => {} }),
      MessageDedup: class {},
      MessageDispatcher: class {},
      AttachmentService: class {},
      createEventStore: () => ({ events: [], metrics: { messages: 0, commands: 0, prompts: 0, errors: 0, promptDurationsMs: [], entries: [] }, now: Date.now, nextEventId: 1 }),
      createAdminServer: () => null,
    };
    const app = createApp(config, deps);
    await app.start();
    assert.deepEqual(platformStarted, ['feishu']);
    assert.ok(!platformStarted.includes('opendray'));
  });

  it('REQ-001-B01: 残留 Claude 配置不再注册 claude，opencode 与 codex 仍注册', () => {
    const registered = [];
    let claudeBuilds = 0;
    let bridgeBuilds = 0;
    const config = {
      feishuAppId: 'cli_test', feishuAppSecret: 'test_secret', feishuRouteMode: 'thread',
      walkerDefaultAgent: 'opencode', walkerDefaultRuntime: 'windows', walkerDefaultCwd: 'H:\\walker',
      walkerDataDir: '', opencodeServerUrl: 'http://localhost:4096', opencodeServerAutostart: false,
      opencodeCmd: 'opencode', claudeCmd: 'claude-test', claudeModel: 'sonnet',
      claudeFallbackModel: 'opus', claudeAgent: 'reviewer', claudePermissionMode: 'plan', claudePermissionModeMigrated: true,
      claudeAllowedTools: 'Read,Grep', claudeDisallowedTools: 'Bash', claudeConfigDir: 'C:\\claude',
      claudeTools: ['Read', 'Grep'], claudeAgents: { reviewer: { model: 'opus' } },
      claudeMcpConfigs: ['C:/mcp/a.json'], claudeStrictMcpConfig: true,
      claudeSettingsFile: 'C:/claude/settings.json', claudeSettingSources: ['user', 'project'],
      claudePluginDirs: ['C:/plugins'], claudeBare: true, claudeSafeMode: true,
      claudeDisableSlashCommands: true, claudeAllowBypassPermissions: false,
      claudePromptTimeoutMs: 45000, claudeBridgeToken: 'bridge-token', walkerWslDistro: 'Ubuntu-24.04',
      feishuProgressStyle: 'card', feishuReactionEmoji: '', feishuDoneEmoji: '',
    };
    const deps = {
      FeishuPlatform: class { constructor() { this.api = {}; } start() { return Promise.resolve(); } stop() {} },
      SessionService: class { recoverOnStartup() { return []; } cleanOrphanRoutes() { return []; } },
      JsonStore: class { constructor() { this.read = () => ({}); this.update = () => {}; } },
      OpencodeDriver: class { constructor(options) { this.name = 'opencode'; this.options = options; } },
      ClaudeDriver: class { constructor() { claudeBuilds += 1; } },
      ClaudeBridgeSidecar: class { constructor() { bridgeBuilds += 1; } },
      OpencodeTuiBridge: class { setOnSessionEnrolled() {} close() {} },
      stubCodexDriver: () => ({ name: 'codex-stub', _isStub: true }),
      DriverRegistry: class {
        constructor() { this.drivers = new Map(); }
        register(name, driver) { registered.push({ name, driver }); this.drivers.set(name, driver); }
        get(name) { return this.drivers.get(name) || null; }
        list() { return Array.from(this.drivers.keys()); }
      },
      createRuntime: () => ({ spawn() {} }),
      MessageDedup: class {},
      MessageDispatcher: class {},
      AttachmentService: class {},
      createEventStore: () => ({ events: [], metrics: { messages: 0, commands: 0, prompts: 0, errors: 0, promptDurationsMs: [], entries: [] }, now: Date.now, nextEventId: 1 }),
      createAdminServer: () => null,
    };

    const app = createApp(config, deps);

    assert.deepEqual(registered.map((item) => item.name), ['opencode', 'codex']);
    assert.equal(app.registry.list().includes('claude'), false);
    assert.equal(app.registry.get('claude'), null);
    assert.equal(registered.find((item) => item.name === 'codex').driver.name, 'codex-stub');
    assert.equal(claudeBuilds, 0);
    assert.equal(bridgeBuilds, 0);
  });

  it('stop 关闭 platform', async () => {
    const platformStopped = [];
    const config = {
      feishuAppId: 'cli_test', feishuAppSecret: 'test_secret', feishuRouteMode: 'thread',
      walkerDefaultAgent: 'opencode', walkerDefaultRuntime: 'windows', walkerDefaultCwd: '',
      walkerDataDir: '', opencodeServerUrl: '', opencodeServerAutostart: false,
      opencodeCmd: 'opencode', walkerWslDistro: 'Ubuntu-24.04',
      feishuProgressStyle: 'card', feishuReactionEmoji: '', feishuDoneEmoji: '',
    };
    const deps = {
      FeishuPlatform: class {
        start() { return Promise.resolve(); }
        stop() { platformStopped.push('feishu'); }
      },
      SessionService: class { constructor() {} recoverOnStartup() { return []; } cleanOrphanRoutes() { return []; } },
      JsonStore: class { constructor() {} },
      OpencodeDriver: class { constructor() {} },
      stubClaudeDriver: () => ({}),
      stubCodexDriver: () => ({}),
      DriverRegistry: class { register() {} },
      createRuntime: () => ({}),
      MessageDedup: class {},
      MessageDispatcher: class {},
      AttachmentService: class {},
      createEventStore: () => ({ events: [], metrics: { messages: 0, commands: 0, prompts: 0, errors: 0, promptDurationsMs: [], entries: [] }, now: Date.now, nextEventId: 1 }),
      createAdminServer: () => null,
    };
    const app = createApp(config, deps);
    await app.start();
    await app.stop();
    assert.deepEqual(platformStopped, ['feishu']);
  });

  it('REQ-001-B02: 一次和两次 stop 都不调用 Claude release', async () => {
    const calls = [];
    const config = {
      feishuAppId: 'cli_test', feishuAppSecret: 'test_secret', feishuRouteMode: 'thread',
      walkerDefaultAgent: 'claude', walkerDefaultRuntime: 'windows', walkerDefaultCwd: '',
      walkerDataDir: '', opencodeServerUrl: '', opencodeServerAutostart: false,
      opencodeCmd: 'opencode', walkerWslDistro: 'Ubuntu-24.04',
      feishuProgressStyle: 'card', feishuReactionEmoji: '', feishuDoneEmoji: '',
    };
    const deps = {
      FeishuPlatform: class { start() { return Promise.resolve(); } stop() { calls.push('platform.stop'); } },
      SessionService: class { constructor() {} recoverOnStartup() { return []; } cleanOrphanRoutes() { return []; } },
      JsonStore: class { constructor() {} },
      OpencodeDriver: class { constructor() {} },
      ClaudeDriver: class {
        constructor() { calls.push('claude.construct'); }
        stopWalkerConnection(reason) { calls.push('claude.stopWalkerConnection:' + reason); }
        detachAllRuntimes() { calls.push('claude.detachAllRuntimes'); }
        stopRuntime() { calls.push('claude.stopRuntime'); }
        deleteRuntime() { calls.push('claude.deleteRuntime'); }
      },
      ClaudeBridgeSidecar: class { constructor() { calls.push('bridge.construct'); } stop() { calls.push('bridge.stop'); } },
      claudeBridge: { stop() { calls.push('claudeBridge.stop'); }, stopWalkerConnection() { calls.push('claudeBridge.stopWalkerConnection'); } },
      stubCodexDriver: () => ({}),
      DriverRegistry: class { register() {} },
      createRuntime: () => ({
        openTerminal() { calls.push('runtime.openTerminal'); },
        openClaudeAttachTerminal() { calls.push('runtime.openClaudeAttachTerminal'); },
        spawn() { calls.push('runtime.spawn'); },
      }),
      MessageDedup: class {},
      MessageDispatcher: class {},
      AttachmentService: class {},
      createEventStore: () => ({ events: [], metrics: { messages: 0, commands: 0, prompts: 0, errors: 0, promptDurationsMs: [], entries: [] }, now: Date.now, nextEventId: 1 }),
      createAdminServer: () => null,
    };
    const app = createApp(config, deps);
    await app.start();
    await app.stop();
    await app.stop();
    assert.deepEqual(calls, ['platform.stop', 'platform.stop']);
  });

  it('重复 stop 不 kill runtime 且不打开独立 claude --resume 终端', async () => {
    const calls = [];
    const config = {
      feishuAppId: 'cli_test', feishuAppSecret: 'test_secret', feishuRouteMode: 'thread',
      walkerDefaultAgent: 'claude', walkerDefaultRuntime: 'windows', walkerDefaultCwd: '',
      walkerDataDir: '', opencodeServerUrl: '', opencodeServerAutostart: false,
      opencodeCmd: 'opencode', walkerWslDistro: 'Ubuntu-24.04',
      feishuProgressStyle: 'card', feishuReactionEmoji: '', feishuDoneEmoji: '',
      admin: { enabled: false, host: '127.0.0.1', port: 8787, token: '' },
    };
    const deps = {
      FeishuPlatform: class { start() { return Promise.resolve(); } stop() { calls.push('platform.stop'); } },
      SessionService: class { constructor() {} recoverOnStartup() { return []; } cleanOrphanRoutes() { return []; } },
      JsonStore: class { constructor() {} },
      OpencodeDriver: class { constructor() {} },
      ClaudeDriver: class {
        constructor() { this.name = 'claude'; }
        stopWalkerConnection(reason) { calls.push('claude.stopWalkerConnection:' + reason); }
        detachAllRuntimes() { calls.push('claude.detachAllRuntimes'); }
        stopRuntime() { calls.push('claude.stopRuntime'); }
        deleteRuntime() { calls.push('claude.deleteRuntime'); }
      },
      claudeBridge: { stop: () => calls.push('claudeBridge.stop') },
      stubCodexDriver: () => ({}),
      DriverRegistry: class { register() {} },
      createRuntime: () => ({
        openTerminal: (_cmd, args) => calls.push('runtime.openTerminal:' + args.join(' ')),
        kill: () => calls.push('runtime.kill'),
      }),
      MessageDedup: class {},
      MessageDispatcher: class { destroy() { calls.push('dispatcher.destroy'); } },
      AttachmentService: class {},
      createEventStore: () => ({ events: [], metrics: { messages: 0, commands: 0, prompts: 0, errors: 0, promptDurationsMs: [], entries: [] }, now: Date.now, nextEventId: 1 }),
      createAdminServer: () => null,
    };
    const app = createApp(config, deps);
    await app.start();

    await app.stop();
    await app.stop();

    assert.deepEqual(calls, [
      'dispatcher.destroy',
      'platform.stop',
      'platform.stop',
    ]);
    assert.equal(calls.some((call) => call.includes('detachAllRuntimes')), false);
    assert.equal(calls.some((call) => call.includes('stopRuntime')), false);
    assert.equal(calls.some((call) => call.includes('deleteRuntime')), false);
    assert.equal(calls.some((call) => call.includes('openTerminal:--resume')), false);
    assert.equal(calls.some((call) => call.includes('kill')), false);
  });

  it('配置缺失时启动仍创建 app 但飞书连接失败', () => {
    const config = {
      feishuAppId: '', feishuAppSecret: '', feishuRouteMode: 'thread',
      walkerDefaultAgent: 'opencode', walkerDefaultRuntime: 'windows', walkerDefaultCwd: '',
      walkerDataDir: '', opencodeServerUrl: '', opencodeServerAutostart: false,
      opencodeCmd: 'opencode', walkerWslDistro: 'Ubuntu-24.04',
      feishuProgressStyle: 'card', feishuReactionEmoji: '', feishuDoneEmoji: '',
    };
    const deps = {
      FeishuPlatform: class { start() { throw new Error('missing feishu credentials'); } stop() {} },
      SessionService: class { constructor() {} recoverOnStartup() { return []; } cleanOrphanRoutes() { return []; } },
      JsonStore: class { constructor() {} },
      OpencodeDriver: class { constructor() {} },
      stubClaudeDriver: () => ({}),
      stubCodexDriver: () => ({}),
      DriverRegistry: class { register() {} },
      createRuntime: () => ({}),
      MessageDedup: class {},
      MessageDispatcher: class {},
      AttachmentService: class {},
      createEventStore: () => ({ events: [], metrics: { messages: 0, commands: 0, prompts: 0, errors: 0, promptDurationsMs: [], entries: [] }, now: Date.now, nextEventId: 1 }),
      createAdminServer: () => null,
    };
    const app = createApp(config, deps);
    assert.ok(app);
    assert.ok(app.start);
  });

  it('进度卡片更新保留 opencode 文本并在 done 后显示完成', async () => {
    const calls = [];
    const config = {
      feishuAppId: 'cli_test', feishuAppSecret: 'test_secret', feishuRouteMode: 'thread',
      walkerDefaultAgent: 'opencode', walkerDefaultRuntime: 'windows', walkerDefaultCwd: 'H:\\walker',
      walkerDataDir: '', opencodeServerUrl: 'http://localhost:4096', opencodeServerAutostart: false,
      opencodeCmd: 'opencode', walkerWslDistro: 'Ubuntu-24.04',
      feishuProgressStyle: 'card', feishuReactionEmoji: '', feishuDoneEmoji: '',
    };
    const deps = {
      FeishuPlatform: class {
        constructor(options) {
          this.options = options;
          this.api = {
            replyCard: async (_ctx, card) => { calls.push({ type: 'replyCard', card }); return 'om_card1'; },
            patchCard: async (cardId, card) => { calls.push({ type: 'patchCard', cardId, card }); },
            replyText: async (replyCtx, text) => { calls.push({ type: 'replyText', replyCtx, text }); return [{ message_id: 'om_reply1' }]; },
            replyMarkdown: async (replyCtx, text) => { calls.push({ type: 'replyMarkdown', replyCtx, text }); return [{ message_id: 'om_reply1' }]; },
            addReaction: async () => {},
          };
        }
        start() { return Promise.resolve(); }
        stop() {}
      },
      SessionService: class {
        getCurrent() { return { id: 'wks_bound1', agent: 'opencode', agentRef: { opencodeSessionId: 'ses_bound1', cwd: 'H:\\walker' } }; }
        markRunning() {}
        markIdle() {}
        markError() {}
        recoverOnStartup() { return []; }
        cleanOrphanRoutes() { return []; }
      },
      JsonStore: class { constructor() {} },
      OpencodeDriver: class {
        async prompt() {
          return [
            new AgentEvent(AgentEvent.TYPE_TEXT, { text: '我是 opencode' }),
            new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' }),
          ];
        }
      },
      stubClaudeDriver: () => ({}),
      stubCodexDriver: () => ({}),
      createRuntime: () => ({}),
      MessageDedup: class { isDuplicate() { return false; } },
      AttachmentService: class {},
      createEventStore: () => ({ events: [], metrics: { messages: 0, commands: 0, prompts: 0, errors: 0, promptDurationsMs: [], entries: [] }, now: Date.now, nextEventId: 1 }),
      createAdminServer: () => null,
    };

    const app = createApp(config, deps);
    await app.platform.options.onMessage({
      type: 'text', chatId: 'oc_chat1', messageId: 'om_msg1', openId: 'ou_user1', text: '你是谁', rootId: null,
    });

    const lastPatch = calls.filter((call) => call.type === 'patchCard').at(-1);
    assert.ok(lastPatch.card.header.template === 'green');
    const replyTextCall = calls.find((call) => call.type === 'replyMarkdown' && call.text && call.text.includes('我是 opencode'));
    assert.ok(replyTextCall, '最终回答应通过 markdown 卡片消息发送');
    assert.ok(!lastPatch.card.body.elements.some((el) => el.content.includes('我是 opencode')), '最终回答不应进入卡片');
    assert.equal(lastPatch.card.header.template, 'green');
  });

  it('adminEnabled=false 时不创建 AdminServer', async () => {
    const config = {
      feishuAppId: 'cli_test', feishuAppSecret: 'test_secret', feishuRouteMode: 'thread',
      walkerDefaultAgent: 'opencode', walkerDefaultRuntime: 'windows', walkerDefaultCwd: '',
      walkerDataDir: '', opencodeServerUrl: '', opencodeServerAutostart: false,
      opencodeCmd: 'opencode', walkerWslDistro: 'Ubuntu-24.04',
      feishuProgressStyle: 'card', feishuReactionEmoji: '', feishuDoneEmoji: '',
      admin: { enabled: false, host: '127.0.0.1', port: 8787, token: '' },
    };
    const deps = {
      FeishuPlatform: class { start() { return Promise.resolve(); } stop() {} },
      SessionService: class { constructor() {} recoverOnStartup() { return []; } cleanOrphanRoutes() { return []; } },
      JsonStore: class { constructor() {} },
      OpencodeDriver: class { constructor() {} },
      stubClaudeDriver: () => ({}),
      stubCodexDriver: () => ({}),
      DriverRegistry: class { register() {} },
      createRuntime: () => ({}),
      MessageDedup: class {},
      MessageDispatcher: class {},
      AttachmentService: class {},
      createEventStore: () => ({ events: [], metrics: { messages: 0, commands: 0, prompts: 0, errors: 0, promptDurationsMs: [], entries: [] }, now: Date.now, nextEventId: 1 }),
    };
    const app = createApp(config, deps);
    assert.equal(app.adminServer, null);
    await app.start();
    assert.equal(app.adminServer, null);
  });

  it('adminEnabled=true 时先启动 platform 再启动 admin', async () => {
    const started = [];
    const config = {
      feishuAppId: 'cli_test', feishuAppSecret: 'test_secret', feishuRouteMode: 'thread',
      walkerDefaultAgent: 'opencode', walkerDefaultRuntime: 'windows', walkerDefaultCwd: '',
      walkerDataDir: '', opencodeServerUrl: '', opencodeServerAutostart: false,
      opencodeCmd: 'opencode', walkerWslDistro: 'Ubuntu-24.04',
      feishuProgressStyle: 'card', feishuReactionEmoji: '', feishuDoneEmoji: '',
      admin: { enabled: true, host: '127.0.0.1', port: 8787, token: '' },
    };
    const deps = {
      FeishuPlatform: class { start() { started.push('feishu'); return Promise.resolve(); } stop() {} },
      SessionService: class { constructor() {} recoverOnStartup() { return []; } cleanOrphanRoutes() { return []; } },
      JsonStore: class { constructor() {} },
      OpencodeDriver: class { constructor() {} },
      stubClaudeDriver: () => ({}),
      stubCodexDriver: () => ({}),
      DriverRegistry: class { register() {} },
      createRuntime: () => ({}),
      MessageDedup: class {},
      MessageDispatcher: class {},
      AttachmentService: class {},
      createEventStore: () => ({ events: [], metrics: { messages: 0, commands: 0, prompts: 0, errors: 0, promptDurationsMs: [], entries: [] }, now: Date.now, nextEventId: 1 }),
      createAdminServer: () => ({
        start() { started.push('admin'); return Promise.resolve({ ok: true, host: '127.0.0.1', port: 8787 }); },
        stop() { return Promise.resolve({ ok: true }); },
        getStatus() { return { started: true, disabled: false, host: '127.0.0.1', port: 8787 }; },
      }),
    };
    const app = createApp(config, deps);
    assert.ok(app.adminServer);
    await app.start();
    assert.deepEqual(started, ['feishu', 'admin']);
  });

  it('Admin bootstrap 的八项 statusChecks 使用生产对象形状并实时反映变化', async () => {
    let adminContext;
    let opencodeHealthy = false;
    let runtimeSnapshots = [];
    let healthSnapshots = [];
    let feishuConnection = { state: 'idle', reconnectAttempts: 0 };
    const adminState = { started: false, disabled: false };
    const app = createApp({
      feishuAppId: 'cli_test', feishuAppSecret: 'test_secret', feishuRouteMode: 'thread',
      walkerDefaultAgent: 'opencode', walkerDefaultRuntime: 'windows', walkerDefaultCwd: '', walkerDataDir: '',
      opencodeServerUrl: '', opencodeServerAutostart: false, opencodeCmd: 'opencode', walkerWslDistro: 'Ubuntu-24.04',
      feishuProgressStyle: 'card', feishuReactionEmoji: '', feishuDoneEmoji: '',
      admin: { enabled: true, host: '127.0.0.1', port: 8787, token: '' },
    }, {
      FeishuPlatform: class {
        constructor() { this.api = {}; this.wsClient = { getConnectionStatus: () => ({ ...feishuConnection }) }; }
        start() { feishuConnection = { state: 'connected', reconnectAttempts: 0, lastConnectTime: 100 }; }
        stop() { feishuConnection = { state: 'idle', reconnectAttempts: 0 }; }
      },
      SessionService: class { recoverOnStartup() { return []; } cleanOrphanRoutes() { return []; } listSessions() { return []; } },
      JsonStore: class {},
      OpencodeDriver: class { async _checkHealth() { return opencodeHealthy; } },
      OpencodeTuiBridge: class {
        constructor() { this.runtimes = new Map(); }
        setOnSessionEnrolled() {}
        close() {}
        getRuntimeSnapshots() { return runtimeSnapshots; }
      },
      stubClaudeDriver: () => ({}), stubCodexDriver: () => ({}),
      DriverRegistry: class { constructor() { this.drivers = new Map(); } register(name, driver) { this.drivers.set(name, driver); } get(name) { return this.drivers.get(name); } },
      createRuntime: () => ({}), MessageDedup: class {},
      MessageDispatcher: class { constructor() { this.sessionWatchStops = new Map(); } restoreWatches() {} }, AttachmentService: class {},
      createEventStore: () => ({ events: [], metrics: { messages: 0, commands: 0, prompts: 0, errors: 0, promptDurationsMs: [], entries: [] }, now: Date.now, nextEventId: 1 }),
      createAdminServer: (context) => {
        adminContext = context;
        return {
          start() { adminState.started = true; return { ok: true, host: '127.0.0.1', port: 8787 }; },
          stop() { adminState.started = false; },
          getStatus() { return { ...adminState }; },
        };
      },
    });
    assert.equal(adminContext.platform, app.platform);
    assert.equal(adminContext.feishu, app.platform);
    assert.equal(adminContext.dispatcher, app.dispatcher);
    assert.equal(adminContext.healthPoller, app.healthPoller);
    assert.equal(adminContext.tuiBridge, app.tuiBridge);
    assert.equal(adminContext.adminServer, app.adminServer);
    assert.equal(Object.hasOwn(adminContext, 'feishuSummary'), false);
    assert.deepEqual(Object.keys(adminContext.statusChecks), [
      'walker', 'feishu', 'opencode', 'tuiBridge', 'runtimes', 'watchers', 'health', 'admin',
    ]);
    for (const check of Object.values(adminContext.statusChecks)) assert.equal(typeof check, 'function');
    app.healthPoller.getHealthSnapshots = () => healthSnapshots;

    const initial = Object.fromEntries(await Promise.all(Object.entries(adminContext.statusChecks)
      .map(async ([name, check]) => [name, await check()])));
    assert.deepEqual(Object.fromEntries(Object.entries(initial).map(([name, value]) => [name, value.status])), {
      walker: 'failed', feishu: 'failed', opencode: 'failed', tuiBridge: 'healthy',
      runtimes: 'healthy', watchers: 'healthy', health: 'healthy', admin: 'failed',
    });

    opencodeHealthy = true;
    runtimeSnapshots = [{ health: { status: 'warning', reason: 'lease expiring' } }];
    healthSnapshots = [{ status: 'failed', reason: 'health failed' }];
    app.tuiBridge.runtimes.set('rt_1', {});
    app.dispatcher.sessionWatchStops.set('wks_1', () => {});
    await app.start();

    const changed = Object.fromEntries(await Promise.all(Object.entries(adminContext.statusChecks)
      .map(async ([name, check]) => [name, await check()])));
    assert.equal(changed.walker.status, 'healthy');
    assert.equal(changed.feishu.status, 'healthy');
    assert.equal(changed.feishu.lastConnectTime, 100);
    assert.equal(changed.opencode.status, 'healthy');
    assert.equal(changed.tuiBridge.runtimeCount, 1);
    assert.equal(changed.runtimes.status, 'warning');
    assert.equal(changed.watchers.watcherCount, 1);
    assert.equal(changed.health.status, 'failed');
    assert.equal(changed.admin.status, 'healthy');

    feishuConnection = { state: 'reconnecting', reconnectAttempts: 2, nextConnectTime: 200 };
    const reconnecting = await adminContext.statusChecks.feishu();
    assert.equal(reconnecting.status, 'warning');
    assert.equal(reconnecting.reconnectAttempts, 2);
    assert.equal(reconnecting.nextConnectTime, 200);

    feishuConnection = { state: 'failed', reconnectAttempts: 3 };
    assert.equal((await adminContext.statusChecks.feishu()).status, 'failed');

    const checkedAt = 1721642400000;
    adminContext.statusChecks.opencode = () => new Promise(() => {});
    const aggregated = await createStatusAdmin(adminContext, { timeoutMs: 20, now: () => checkedAt }).getStatus();
    assert.equal(aggregated.opencode.status, 'failed');
    assert.match(aggregated.opencode.reason, /timed out/);
    for (const status of Object.values(aggregated)) assert.equal(status.checkedAt, checkedAt);
    await app.stop();
    const stoppedFeishu = await adminContext.statusChecks.feishu();
    assert.notEqual(stoppedFeishu.status, 'healthy');
    assert.match(stoppedFeishu.reason, /idle/i);
  });

  it('stop 触发 admin 和 platform 的关闭调用', async () => {
    const stopped = [];
    const config = {
      feishuAppId: 'cli_test', feishuAppSecret: 'test_secret', feishuRouteMode: 'thread',
      walkerDefaultAgent: 'opencode', walkerDefaultRuntime: 'windows', walkerDefaultCwd: '',
      walkerDataDir: '', opencodeServerUrl: '', opencodeServerAutostart: false,
      opencodeCmd: 'opencode', walkerWslDistro: 'Ubuntu-24.04',
      feishuProgressStyle: 'card', feishuReactionEmoji: '', feishuDoneEmoji: '',
      admin: { enabled: true, host: '127.0.0.1', port: 8787, token: '' },
    };
    const deps = {
      FeishuPlatform: class { start() { return Promise.resolve(); } stop() { stopped.push('feishu'); } },
      SessionService: class { constructor() {} recoverOnStartup() { return []; } cleanOrphanRoutes() { return []; } },
      JsonStore: class { constructor() {} },
      OpencodeDriver: class { constructor() {} },
      stubClaudeDriver: () => ({}),
      stubCodexDriver: () => ({}),
      DriverRegistry: class { register() {} },
      createRuntime: () => ({}),
      MessageDedup: class {},
      MessageDispatcher: class {},
      AttachmentService: class {},
      createEventStore: () => ({ events: [], metrics: { messages: 0, commands: 0, prompts: 0, errors: 0, promptDurationsMs: [], entries: [] }, now: Date.now, nextEventId: 1 }),
      createAdminServer: () => ({
        start() { return Promise.resolve({ ok: true, host: '127.0.0.1', port: 8787 }); },
        stop() { stopped.push('admin'); return Promise.resolve({ ok: true }); },
        getStatus() { return { started: true, disabled: false, host: '127.0.0.1', port: 8787 }; },
      }),
    };
    const app = createApp(config, deps);
    await app.start();
    await app.stop();
    assert.deepEqual(stopped, ['feishu', 'admin']);
  });

  it('start 调用 dispatcher.restoreWatches 恢复重启后的 session watch', async () => {
    let restoreCalled = 0;
    const config = {
      feishuAppId: 'cli_test', feishuAppSecret: 'test_secret', feishuRouteMode: 'thread',
      walkerDefaultAgent: 'opencode', walkerDefaultRuntime: 'windows', walkerDefaultCwd: '',
      walkerDataDir: '', opencodeServerUrl: '', opencodeServerAutostart: false,
      opencodeCmd: 'opencode', walkerWslDistro: 'Ubuntu-24.04',
      feishuProgressStyle: 'card', feishuReactionEmoji: '', feishuDoneEmoji: '',
      admin: { enabled: false, host: '127.0.0.1', port: 8787, token: '' },
    };
    const deps = {
      FeishuPlatform: class { start() { return Promise.resolve(); } stop() {} },
      SessionService: class { constructor() {} recoverOnStartup() { return []; } cleanOrphanRoutes() { return []; } },
      JsonStore: class { constructor() {} },
      OpencodeDriver: class { constructor() {} },
      stubClaudeDriver: () => ({}),
      stubCodexDriver: () => ({}),
      DriverRegistry: class { register() {} },
      createRuntime: () => ({}),
      MessageDedup: class {},
      MessageDispatcher: class { constructor() {} restoreWatches() { restoreCalled++; } },
      AttachmentService: class {},
      createEventStore: () => ({ events: [], metrics: { messages: 0, commands: 0, prompts: 0, errors: 0, promptDurationsMs: [], entries: [] }, now: Date.now, nextEventId: 1 }),
      createAdminServer: () => ({ start() { return Promise.resolve({ ok: false, disabled: true }); }, stop() {}, getStatus() { return {}; } }),
    };
    const app = createApp(config, deps);
    await app.start();
    assert.equal(restoreCalled, 1, 'restoreWatches 应在 start 末尾被调用一次');
    await app.stop();
  });

  it('start 不因 dispatcher 缺少 restoreWatches 方法而报错', async () => {
    const config = {
      feishuAppId: 'cli_test', feishuAppSecret: 'test_secret', feishuRouteMode: 'thread',
      walkerDefaultAgent: 'opencode', walkerDefaultRuntime: 'windows', walkerDefaultCwd: '',
      walkerDataDir: '', opencodeServerUrl: '', opencodeServerAutostart: false,
      opencodeCmd: 'opencode', walkerWslDistro: 'Ubuntu-24.04',
      feishuProgressStyle: 'card', feishuReactionEmoji: '', feishuDoneEmoji: '',
      admin: { enabled: false, host: '127.0.0.1', port: 8787, token: '' },
    };
    const deps = {
      FeishuPlatform: class { start() { return Promise.resolve(); } stop() {} },
      SessionService: class { constructor() {} recoverOnStartup() { return []; } cleanOrphanRoutes() { return []; } },
      JsonStore: class { constructor() {} },
      OpencodeDriver: class { constructor() {} },
      stubClaudeDriver: () => ({}),
      stubCodexDriver: () => ({}),
      DriverRegistry: class { register() {} },
      createRuntime: () => ({}),
      MessageDedup: class {},
      MessageDispatcher: class {},
      AttachmentService: class {},
      createEventStore: () => ({ events: [], metrics: { messages: 0, commands: 0, prompts: 0, errors: 0, promptDurationsMs: [], entries: [] }, now: Date.now, nextEventId: 1 }),
      createAdminServer: () => ({ start() { return Promise.resolve({ ok: false, disabled: true }); }, stop() {}, getStatus() { return {}; } }),
    };
    const app = createApp(config, deps);
    await app.start();
    assert.ok(app.dispatcher, 'dispatcher 仍应存在');
    await app.stop();
  });

  it('返回值包含 adminServer、runtime、attachmentService、eventStore', () => {
    const config = {
      feishuAppId: 'cli_test', feishuAppSecret: 'test_secret', feishuRouteMode: 'thread',
      walkerDefaultAgent: 'opencode', walkerDefaultRuntime: 'windows', walkerDefaultCwd: '',
      walkerDataDir: '', opencodeServerUrl: '', opencodeServerAutostart: false,
      opencodeCmd: 'opencode', walkerWslDistro: 'Ubuntu-24.04',
      feishuProgressStyle: 'card', feishuReactionEmoji: '', feishuDoneEmoji: '',
      admin: { enabled: true, host: '127.0.0.1', port: 8787, token: '' },
    };
    const deps = {
      FeishuPlatform: class { start() { return Promise.resolve(); } stop() {} },
      SessionService: class { constructor() {} recoverOnStartup() { return []; } cleanOrphanRoutes() { return []; } },
      JsonStore: class { constructor() {} },
      OpencodeDriver: class { constructor() {} },
      stubClaudeDriver: () => ({}),
      stubCodexDriver: () => ({}),
      DriverRegistry: class { register() {} },
      createRuntime: () => ({ type: 'test-runtime' }),
      MessageDedup: class {},
      MessageDispatcher: class {},
      AttachmentService: class { constructor() { this.type = 'test-attachment'; } },
      createEventStore: () => ({ events: [], metrics: { messages: 0, commands: 0, prompts: 0, errors: 0, promptDurationsMs: [], entries: [] }, now: Date.now, nextEventId: 1 }),
      createAdminServer: () => ({ start() { return Promise.resolve({ ok: true }); }, stop() { return Promise.resolve({ ok: true }); }, getStatus() { return {}; } }),
    };
    const app = createApp(config, deps);
    assert.ok(app.adminServer);
    assert.ok(app.runtime);
    assert.ok(app.attachmentService);
    assert.ok(app.eventStore);
  });

  it('向 MessageDispatcher 注入长任务配置', () => {
    let dispatcherOptions;
    const config = {
      feishuAppId: 'cli_test', feishuAppSecret: 'test_secret', feishuRouteMode: 'thread',
      walkerDefaultAgent: 'opencode', walkerDefaultRuntime: 'windows', walkerDefaultCwd: '',
      walkerDataDir: '', opencodeServerUrl: '', opencodeServerAutostart: false,
      opencodeCmd: 'opencode', walkerWslDistro: 'Ubuntu-24.04',
      feishuProgressStyle: 'card', feishuReactionEmoji: '', feishuDoneEmoji: '',
      walkerPromptHeartbeatInitialMs: 10000,
      walkerPromptHeartbeatIntervalMs: 20000,
      walkerPromptHeartbeatStuckMs: 90000,
      walkerMaxTurnTimeMins: 45,
      admin: { enabled: false, host: '127.0.0.1', port: 8787, token: '' },
    };
    const deps = {
      FeishuPlatform: class { start() { return Promise.resolve(); } stop() {} },
      SessionService: class { constructor() {} recoverOnStartup() { return []; } cleanOrphanRoutes() { return []; } },
      JsonStore: class { constructor() {} },
      OpencodeDriver: class { constructor() {} },
      stubClaudeDriver: () => ({}),
      stubCodexDriver: () => ({}),
      DriverRegistry: class { register() {} },
      createRuntime: () => ({}),
      MessageDedup: class {},
      MessageDispatcher: class { constructor(options) { dispatcherOptions = options; } },
      AttachmentService: class {},
      createEventStore: () => ({ events: [], metrics: { messages: 0, commands: 0, prompts: 0, errors: 0, promptDurationsMs: [], entries: [] }, now: Date.now, nextEventId: 1 }),
      createAdminServer: () => null,
    };

    createApp(config, deps);

    assert.equal(dispatcherOptions.promptHeartbeatInitialMs, 10000);
    assert.equal(dispatcherOptions.promptHeartbeatIntervalMs, 20000);
    assert.equal(dispatcherOptions.promptHeartbeatStuckMs, 90000);
    assert.equal(dispatcherOptions.maxTurnTimeMins, 45);
  });

  it('onCardAction 传递 formValue 到 dispatcher.handleCommand', async () => {
    let handleCommandArg = null;
    const config = {
      feishuAppId: 'cli_test', feishuAppSecret: 'test_secret', feishuRouteMode: 'thread',
      walkerDefaultAgent: 'opencode', walkerDefaultRuntime: 'windows', walkerDefaultCwd: 'H:\\walker',
      walkerDataDir: '', opencodeServerUrl: '', opencodeServerAutostart: false,
      opencodeCmd: 'opencode', walkerWslDistro: 'Ubuntu-24.04',
      feishuProgressStyle: 'card', feishuReactionEmoji: '', feishuDoneEmoji: '',
      admin: { enabled: false, host: '127.0.0.1', port: 8787, token: '' },
    };
    const deps = {
      FeishuPlatform: class {
        constructor(options) { this.options = options; this.api = {}; }
        start() { return Promise.resolve(); }
        stop() {}
      },
      SessionService: class { recoverOnStartup() { return []; } cleanOrphanRoutes() { return []; } },
      JsonStore: class {},
      OpencodeDriver: class {},
      OpencodeTuiBridge: class { setOnSessionEnrolled() {} close() {} },
      stubClaudeDriver: () => ({}),
      stubCodexDriver: () => ({}),
      DriverRegistry: class { register() {} get() { return null; } },
      createRuntime: () => ({}),
      MessageDedup: class {},
      MessageDispatcher: class {
        constructor() { this.feishuApi = {}; }
        handleCommand(cmd) { handleCommandArg = cmd; return Promise.resolve(); }
        handleIncomingMessage() { return Promise.resolve(); }
      },
      AttachmentService: class {},
      createEventStore: () => ({ events: [], metrics: { messages: 0, commands: 0, prompts: 0, errors: 0, promptDurationsMs: [], entries: [] }, now: Date.now, nextEventId: 1 }),
      createAdminServer: () => null,
    };
    const app = createApp(config, deps);
    await app.platform.options.onCardAction({
      action: 'cmd:/answer q1 yes',
      routeKey: 'feishu:oc_chat1:root:om_root1',
      chatId: 'oc_chat1',
      messageId: 'om_card1',
      openId: 'ou_user1',
      formValue: { question_answer: 'yes' },
    });

    assert.ok(handleCommandArg, 'handleCommand should have been called');
    assert.deepEqual(handleCommandArg.formValue, { question_answer: 'yes' });
  });

  it('飞书文本消息优先通过标准 platform event 进入 dispatcher', async () => {
    let platformArg = null;
    let incomingCalled = false;
    const config = {
      feishuAppId: 'cli_test', feishuAppSecret: 'test_secret', feishuRouteMode: 'thread',
      walkerDefaultAgent: 'opencode', walkerDefaultRuntime: 'windows', walkerDefaultCwd: 'H:\\walker',
      walkerDataDir: '', opencodeServerUrl: '', opencodeServerAutostart: false,
      opencodeCmd: 'opencode', walkerWslDistro: 'Ubuntu-24.04',
      feishuProgressStyle: 'card', feishuReactionEmoji: '', feishuDoneEmoji: '',
      admin: { enabled: false, host: '127.0.0.1', port: 8787, token: '' },
    };
    const deps = {
      FeishuPlatform: class {
        constructor(options) { this.options = options; this.api = {}; }
        start() { return Promise.resolve(); }
        stop() {}
      },
      SessionService: class { recoverOnStartup() { return []; } cleanOrphanRoutes() { return []; } },
      JsonStore: class {},
      OpencodeDriver: class {},
      OpencodeTuiBridge: class { setOnSessionEnrolled() {} close() {} },
      stubClaudeDriver: () => ({}),
      stubCodexDriver: () => ({}),
      DriverRegistry: class { register() {} get() { return null; } },
      createRuntime: () => ({}),
      MessageDedup: class {},
      MessageDispatcher: class {
        constructor() { this.feishuApi = {}; }
        handleCommand() { return Promise.resolve(); }
        handleIncomingMessage() { incomingCalled = true; return Promise.resolve(); }
        handlePlatformMessage(event) { platformArg = event; return Promise.resolve('prompted'); }
      },
      AttachmentService: class {},
      createEventStore: () => ({ events: [], metrics: { messages: 0, commands: 0, prompts: 0, errors: 0, promptDurationsMs: [], entries: [] }, now: Date.now, nextEventId: 1 }),
      createAdminServer: () => null,
    };
    const app = createApp(config, deps);
    const platformEvent = { platform: 'feishu', type: 'message', messageId: 'om_1', routeKey: 'feishu:oc_1:root:oc_1', userId: 'ou_1', text: 'hello', attachments: [], raw: {} };

    await app.platform.options.onMessage({ type: 'text', text: 'hello', routeKey: platformEvent.routeKey, platformEvent });

    assert.equal(incomingCalled, false);
    assert.equal(platformArg, platformEvent);
  });

  it('飞书命令消息保留标准 platform event 观测上下文', async () => {
    let commandArg = null;
    const config = {
      feishuAppId: 'cli_test', feishuAppSecret: 'test_secret', feishuRouteMode: 'thread',
      walkerDefaultAgent: 'opencode', walkerDefaultRuntime: 'windows', walkerDefaultCwd: 'H:\\walker',
      walkerDataDir: '', opencodeServerUrl: '', opencodeServerAutostart: false,
      opencodeCmd: 'opencode', walkerWslDistro: 'Ubuntu-24.04',
      feishuProgressStyle: 'card', feishuReactionEmoji: '', feishuDoneEmoji: '',
      admin: { enabled: false, host: '127.0.0.1', port: 8787, token: '' },
    };
    const deps = {
      FeishuPlatform: class {
        constructor(options) { this.options = options; this.api = {}; }
        start() { return Promise.resolve(); }
        stop() {}
      },
      SessionService: class { recoverOnStartup() { return []; } cleanOrphanRoutes() { return []; } },
      JsonStore: class {},
      OpencodeDriver: class {},
      OpencodeTuiBridge: class { setOnSessionEnrolled() {} close() {} },
      stubClaudeDriver: () => ({}),
      stubCodexDriver: () => ({}),
      DriverRegistry: class { register() {} get() { return null; } },
      createRuntime: () => ({}),
      MessageDedup: class {},
      MessageDispatcher: class {
        constructor() { this.feishuApi = {}; }
        handleCommand(cmd) { commandArg = cmd; return Promise.resolve(); }
        handleIncomingMessage() { return Promise.resolve(); }
      },
      AttachmentService: class {},
      createEventStore: () => ({ events: [], metrics: { messages: 0, commands: 0, prompts: 0, errors: 0, promptDurationsMs: [], entries: [] }, now: Date.now, nextEventId: 1 }),
      createAdminServer: () => null,
    };
    const app = createApp(config, deps);
    const platformEvent = { platform: 'feishu', type: 'message', messageId: 'om_cmd', routeKey: 'feishu:oc_1:root:oc_1', userId: 'ou_1', text: '/new', attachments: [], raw: {} };

    await app.platform.options.onMessage({
      type: 'command',
      command: { name: 'new', args: [] },
      routeKey: platformEvent.routeKey,
      parentId: 'om_parent_cmd',
      platformEvent,
    });

    assert.equal(commandArg.platformEvent, platformEvent);
    assert.equal(commandArg.parentId, 'om_parent_cmd');
  });

  it('飞书平台 adapter 事件写入 app eventStore', async () => {
    const config = {
      feishuAppId: 'cli_test', feishuAppSecret: 'test_secret', feishuRouteMode: 'thread',
      walkerDefaultAgent: 'opencode', walkerDefaultRuntime: 'windows', walkerDefaultCwd: 'H:\\walker',
      walkerDataDir: '', opencodeServerUrl: '', opencodeServerAutostart: false,
      opencodeCmd: 'opencode', walkerWslDistro: 'Ubuntu-24.04',
      feishuProgressStyle: 'card', feishuReactionEmoji: '', feishuDoneEmoji: '',
      admin: { enabled: false, host: '127.0.0.1', port: 8787, token: '' },
    };
    const deps = {
      FeishuPlatform: class {
        constructor(options) { this.options = options; this.api = {}; }
        start() { return Promise.resolve(); }
        stop() {}
      },
      SessionService: class { recoverOnStartup() { return []; } cleanOrphanRoutes() { return []; } },
      JsonStore: class {},
      OpencodeDriver: class {},
      OpencodeTuiBridge: class { setOnSessionEnrolled() {} close() {} },
      stubClaudeDriver: () => ({}),
      stubCodexDriver: () => ({}),
      DriverRegistry: class { register() {} get() { return null; } },
      createRuntime: () => ({}),
      MessageDedup: class {},
      MessageDispatcher: class {
        constructor() { this.feishuApi = {}; }
        handleCommand() { return Promise.resolve(); }
        handleIncomingMessage() { return Promise.resolve(); }
      },
      AttachmentService: class {},
      createEventStore: () => ({ events: [], metrics: { messages: 0, commands: 0, prompts: 0, errors: 0, promptDurationsMs: [], entries: [] }, now: Date.now, nextEventId: 1 }),
      createAdminServer: () => null,
    };
    const app = createApp(config, deps);

    app.platform.options.onEvent({
      type: 'platform.adapter_error',
      platform: 'feishu',
      data: { routeKey: 'feishu:oc_1:root:oc_1', error: 'invalid platform event' },
    });

    const event = app.eventStore.events.find((item) => item.type === 'platform.adapter_error');
    assert.ok(event);
    assert.equal(event.level, 'error');
    assert.equal(event.routeKey, 'feishu:oc_1:root:oc_1');
    assert.equal(event.data.platform, 'feishu');
    assert.equal(event.data.error, 'invalid platform event');
  });

  it('sendPermissionCard 绑定为函数并调用 replyCard', async () => {
    const calls = [];
    const app = makeModelCardApp(calls, {
      replyCard: async (replyCtx, card) => {
        calls.push({ type: 'replyCard', replyCtx, card });
        return 'om_perm_card1';
      },
    });
    assert.equal(typeof app.dispatcher.feishuApi.sendPermissionCard, 'function');
    const result = await app.dispatcher.feishuApi.sendPermissionCard(
      { messageId: 'om_msg1', chatId: 'oc_chat1' },
      { data: { id: 'perm_1', title: '执行 bash 命令' } },
      'wks_s1',
      'route_key_1',
    );
    assert.equal(result, 'om_perm_card1');
    const replyCall = calls.find((c) => c.type === 'replyCard');
    assert.ok(replyCall);
    assert.equal(replyCall.card.header.title.content, '权限确认请求');
  });

  it('patchPermissionCard 绑定为函数并调用 patchCard', async () => {
    const calls = [];
    const app = makeModelCardApp(calls, {
      patchCard: async (cardId, card) => {
        calls.push({ type: 'patchCard', cardId, card });
        return { ok: true };
      },
    });
    assert.equal(typeof app.dispatcher.feishuApi.patchPermissionCard, 'function');
    await app.dispatcher.feishuApi.patchPermissionCard('om_perm_card1', 'perm_1', 'allow');
    const patchCall = calls.find((c) => c.type === 'patchCard');
    assert.ok(patchCall);
    assert.equal(patchCall.cardId, 'om_perm_card1');
    assert.equal(patchCall.card.header.title.content, '权限已处理');
  });
});

const DELETED_CLAUDE_MODULES = [
  ['claude', 'driver'],
  ['claude', 'pty', 'runtime'],
  ['claude', 'pty', 'broker'],
  ['claude', 'bridge', 'sidecar'],
  ['claude', 'attach', 'server'],
  ['claude', 'transcript'],
  ['claude', 'attach', 'command'],
].map((parts) => parts.join('-'));

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function listJsFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

function findDeletedModuleReferences(roots) {
  const pattern = new RegExp(DELETED_CLAUDE_MODULES.map(escapeRegExp).join('|'));
  const hits = [];
  for (const root of roots) {
    for (const file of listJsFiles(root)) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, index) => {
        if (pattern.test(line)) {
          hits.push(path.relative(process.cwd(), file) + ':' + (index + 1) + ':' + line.trim());
        }
      });
    }
  }
  return hits;
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function removeTempDir(dir) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

function baseRemovedConfig(dir, extra) {
  return Object.assign({
    feishuAppId: 'cli_test',
    feishuAppSecret: 'test_secret',
    feishuRouteMode: 'thread',
    walkerDefaultAgent: 'opencode',
    walkerDefaultRuntime: 'windows',
    walkerDefaultCwd: dir,
    walkerDataDir: dir,
    opencodeServerUrl: '',
    opencodeServerAutostart: false,
    opencodeCmd: 'opencode',
    walkerWslDistro: 'Ubuntu-24.04',
    walkerOpencodeHookEnabled: false,
    feishuProgressStyle: 'card',
    feishuReactionEmoji: '',
    feishuDoneEmoji: '',
    admin: { enabled: false, host: '127.0.0.1', port: 0, token: '' },
    claudeCmd: 'claude',
    claudeModel: 'sonnet',
    claudeBridgeEnabled: true,
    claudeBridgeHost: '127.0.0.1',
    claudeBridgePort: 9,
    claudeBridgeToken: 'bridge-token',
    claudeConfigDir: path.join(dir, 'claude-config'),
  }, extra || {});
}

function quietDeps(extra) {
  return Object.assign({
    FeishuPlatform: class {
      constructor() { this.api = {}; }
      start() { return Promise.resolve(); }
      stop() { return Promise.resolve(); }
    },
    OpencodeDriver: class {
      constructor(options) { this.name = 'opencode'; this.options = options || {}; }
    },
    OpencodeTuiBridge: class {
      setOnSessionEnrolled() {}
      close() {}
    },
    MessageDispatcher: class {
      destroy() {}
    },
    AttachmentService: class {},
    createAdminServer: () => null,
  }, extra || {});
}

function installSideEffectProbes() {
  const calls = { execFile: [], execFileSync: [], spawn: [], spawnSync: [], exec: [], execSync: [], listen: [], timers: [] };
  const originals = {
    execFile: childProcess.execFile,
    execFileSync: childProcess.execFileSync,
    spawn: childProcess.spawn,
    spawnSync: childProcess.spawnSync,
    exec: childProcess.exec,
    execSync: childProcess.execSync,
    listen: net.Server.prototype.listen,
    setTimeout: global.setTimeout,
    setInterval: global.setInterval,
  };
  const timers = [];
  function record(bucket, args) {
    calls[bucket].push(Array.from(args).map((arg) => (typeof arg === 'function' ? '[Function]' : arg)));
  }
  childProcess.execFile = function execFileProbe(...args) {
    record('execFile', args);
    return { unref() {}, on() { return this; }, pid: 0 };
  };
  childProcess.execFileSync = function execFileSyncProbe(...args) {
    record('execFileSync', args);
    return '';
  };
  childProcess.spawn = function spawnProbe(...args) {
    record('spawn', args);
    return { unref() {}, on() { return this; }, pid: 0 };
  };
  childProcess.spawnSync = function spawnSyncProbe(...args) {
    record('spawnSync', args);
    return { status: 0, stdout: '', stderr: '' };
  };
  childProcess.exec = function execProbe(...args) {
    record('exec', args);
    const cb = args.find((arg) => typeof arg === 'function');
    if (cb) process.nextTick(() => cb(null, '', ''));
    return { unref() {}, on() { return this; }, pid: 0 };
  };
  childProcess.execSync = function execSyncProbe(...args) {
    record('execSync', args);
    return '';
  };
  net.Server.prototype.listen = function listenProbe(...args) {
    record('listen', args);
    const cb = args.find((arg) => typeof arg === 'function');
    if (cb) process.nextTick(cb);
    return this;
  };
  global.setTimeout = function setTimeoutProbe(fn, ms, ...args) {
    calls.timers.push({ kind: 'timeout', ms });
    const timer = originals.setTimeout(fn, ms, ...args);
    timers.push(timer);
    return timer;
  };
  global.setInterval = function setIntervalProbe(fn, ms, ...args) {
    calls.timers.push({ kind: 'interval', ms });
    const timer = originals.setInterval(fn, ms, ...args);
    timers.push(timer);
    return timer;
  };
  return {
    calls,
    restore() {
      childProcess.execFile = originals.execFile;
      childProcess.execFileSync = originals.execFileSync;
      childProcess.spawn = originals.spawn;
      childProcess.spawnSync = originals.spawnSync;
      childProcess.exec = originals.exec;
      childProcess.execSync = originals.execSync;
      net.Server.prototype.listen = originals.listen;
      global.setTimeout = originals.setTimeout;
      global.setInterval = originals.setInterval;
      for (const timer of timers) {
        clearTimeout(timer);
        clearInterval(timer);
      }
      delete require.cache[require.resolve('../src/app/bootstrap')];
    },
  };
}

function loadFreshCreateApp() {
  const resolved = require.resolve('../src/app/bootstrap');
  delete require.cache[resolved];
  return require('../src/app/bootstrap').createApp;
}

function captureStderr() {
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = function stderrProbe(chunk, encoding, callback) {
    lines.push(String(chunk));
    return original.call(process.stderr, chunk, encoding, callback);
  };
  return {
    lines,
    restore() { process.stderr.write = original; },
    text() { return lines.join(''); },
  };
}

describe('removed claude runtime wiring', () => {
  it('REQ-001-B03: 启动和关闭不 spawn claude，也不打开 attach 终端', async () => {
    const dir = makeTempDir('walker-t1-b03-');
    const token = 'walker-attach-token-sentinel-b03';
    const attachUrl = 'ws://127.0.0.1:9/attach?token=' + token;
    const previousUrl = process.env.WALKER_CLAUDE_ATTACH_URL;
    const previousToken = process.env.WALKER_CLAUDE_ATTACH_TOKEN;
    process.env.WALKER_CLAUDE_ATTACH_URL = attachUrl;
    process.env.WALKER_CLAUDE_ATTACH_TOKEN = token;
    const probes = installSideEffectProbes();
    try {
      const freshCreateApp = loadFreshCreateApp();
      const app = freshCreateApp(baseRemovedConfig(dir, {
        walkerDefaultAgent: 'claude',
        claudeBridgeToken: token,
        claudeAttachUrl: attachUrl,
      }), quietDeps());
      assert.equal(typeof app.runtime.openClaudeAttachTerminal, 'undefined');
      assert.equal(Object.prototype.hasOwnProperty.call(app.runtime, 'openClaudeAttachTerminal'), false);
      if (typeof app.runtime.openClaudeAttachTerminal === 'function') {
        await app.runtime.openClaudeAttachTerminal('rt_1', {
          cwd: dir,
          walkerCommand: 'walker',
          attachUrl,
          token,
        });
      }
      await app.start();
      await app.stop();
      await app.stop();
      const serialized = JSON.stringify(probes.calls);
      assert.equal(serialized.includes('claude'), false);
      assert.equal(serialized.includes('WALKER_CLAUDE_ATTACH'), false);
      assert.equal(serialized.includes(token), false);
      assert.equal(serialized.includes('walker claude attach'), false);
      assert.equal(probes.calls.spawn.length, 0);
      assert.equal(probes.calls.execFile.length, 0);
      assert.equal(probes.calls.execFileSync.length, 0);
    } finally {
      probes.restore();
      if (previousUrl === undefined) delete process.env.WALKER_CLAUDE_ATTACH_URL;
      else process.env.WALKER_CLAUDE_ATTACH_URL = previousUrl;
      if (previousToken === undefined) delete process.env.WALKER_CLAUDE_ATTACH_TOKEN;
      else process.env.WALKER_CLAUDE_ATTACH_TOKEN = previousToken;
      removeTempDir(dir);
    }
  });

  it('REQ-001-B04: 残留 attach token 不进入启动日志或子进程环境', async () => {
    const dir = makeTempDir('walker-t1-b04-');
    const token = 'walker-attach-token-sentinel-b04-7f3a9c';
    const attachUrl = 'ws://127.0.0.1:9/attach?token=' + token;
    const previousUrl = process.env.WALKER_CLAUDE_ATTACH_URL;
    const previousToken = process.env.WALKER_CLAUDE_ATTACH_TOKEN;
    const previousLogFile = process.env.WALKER_LOG_FILE;
    process.env.WALKER_CLAUDE_ATTACH_URL = attachUrl;
    process.env.WALKER_CLAUDE_ATTACH_TOKEN = token;
    process.env.WALKER_LOG_FILE = 'false';
    const probes = installSideEffectProbes();
    const stderr = captureStderr();
    const driverOptions = [];
    try {
      const freshCreateApp = loadFreshCreateApp();
      const app = freshCreateApp(baseRemovedConfig(dir, {
        walkerDefaultAgent: 'claude',
        claudeBridgeToken: token,
        claudeAttachUrl: attachUrl,
      }), quietDeps({
        OpencodeDriver: class {
          constructor(options) {
            this.name = 'opencode';
            this.options = options || {};
            driverOptions.push(this.options);
          }
        },
      }));
      await app.start();
      await app.stop();
      const logs = stderr.text();
      const serialized = JSON.stringify({ calls: probes.calls, driverOptions });
      assert.equal(logs.includes(token), false);
      assert.equal(logs.includes(attachUrl), false);
      assert.equal(serialized.includes(token), false);
      assert.equal(serialized.includes(attachUrl), false);
      assert.equal(probes.calls.listen.length, 0);
      assert.equal(probes.calls.spawn.length, 0);
    } finally {
      stderr.restore();
      probes.restore();
      if (previousUrl === undefined) delete process.env.WALKER_CLAUDE_ATTACH_URL;
      else process.env.WALKER_CLAUDE_ATTACH_URL = previousUrl;
      if (previousToken === undefined) delete process.env.WALKER_CLAUDE_ATTACH_TOKEN;
      else process.env.WALKER_CLAUDE_ATTACH_TOKEN = previousToken;
      if (previousLogFile === undefined) delete process.env.WALKER_LOG_FILE;
      else process.env.WALKER_LOG_FILE = previousLogFile;
      removeTempDir(dir);
    }
  });

  it('REQ-001-B05: src 不再 require 已删除的 Claude 模块', () => {
    const srcRoot = path.join(__dirname, '../src');
    const hits = findDeletedModuleReferences([srcRoot]).filter((hit) => /require\s*\(|import\s+|from\s+['"]/.test(hit));
    assert.deepEqual(hits, []);
    const bootstrapSource = fs.readFileSync(path.join(srcRoot, 'app', 'bootstrap.js'), 'utf8');
    const runtimeSource = fs.readFileSync(path.join(srcRoot, 'runtime', 'windows-runtime.js'), 'utf8');
    assert.equal(bootstrapSource.includes('ClaudeDriver'), false);
    assert.equal(bootstrapSource.includes('ClaudeBridgeSidecar'), false);
    assert.equal(bootstrapSource.includes('openClaudeAttachTerminal'), false);
    assert.equal(runtimeSource.includes('openClaudeAttachTerminal'), false);
    assert.equal(runtimeSource.includes('WALKER_CLAUDE_ATTACH'), false);
  });

  it('REQ-001-B06: createApp 不探测 claude、不监听 bridge、不建重试 timer', () => {
    const dir = makeTempDir('walker-t1-b06-');
    const probes = installSideEffectProbes();
    try {
      const freshCreateApp = loadFreshCreateApp();
      const app = freshCreateApp(baseRemovedConfig(dir, {
        walkerDefaultAgent: 'claude',
        claudeCmd: 'claude',
        claudeBridgePort: 0,
      }), quietDeps({
        ClaudeDriver: class { constructor() { throw new Error('ClaudeDriver must not be constructed'); } },
        ClaudeBridgeSidecar: class { constructor() { throw new Error('bridge must not be constructed'); } },
        claudeBridge: { listen() { throw new Error('injected bridge must not be used'); } },
      }));
      assert.equal(app.registry.list().includes('claude'), false);
      assert.equal(probes.calls.execFile.length, 0);
      assert.equal(probes.calls.execFileSync.length, 0);
      assert.equal(probes.calls.spawn.length, 0);
      assert.equal(probes.calls.listen.length, 0);
      assert.equal(probes.calls.timers.length, 0);
      const serialized = JSON.stringify(probes.calls);
      assert.equal(serialized.includes('claude'), false);
    } finally {
      probes.restore();
      removeTempDir(dir);
    }
  });

  it('REQ-005-B02: 启动不改写旧 agent=claude 记录', async () => {
    const dir = makeTempDir('walker-t1-store-');
    const claudeSession = {
      id: 'wks_old_claude',
      agent: 'claude',
      title: 'old claude',
      runtime: 'windows',
      cwd: 'H:\\walker',
      status: 'running',
      agentRef: {
        provider: 'claude',
        transport: 'pty-attach',
        claudeSessionId: '11111111-1111-4111-8111-111111111111',
        terminal: { status: 'active', windowId: 'win_1', updatedAt: 1000 },
      },
      errorMessage: 'keep-me',
      model: { providerID: 'anthropic', modelID: 'claude-sonnet-4' },
      createdAt: 1000,
      updatedAt: 1000,
    };
    const upperSession = {
      id: 'wks_upper_claude',
      agent: 'Claude',
      title: 'upper',
      runtime: 'windows',
      cwd: 'H:\\walker',
      status: 'running',
      agentRef: { provider: 'Claude', claudeSessionId: '22222222-2222-4222-8222-222222222222' },
      errorMessage: 'upper-error',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const spacedSession = {
      id: 'wks_spaced_claude',
      agent: 'claude ',
      title: 'spaced',
      runtime: 'windows',
      cwd: 'H:\\walker',
      status: 'error',
      agentRef: { provider: 'claude ' },
      errorMessage: 'spaced-error',
      createdAt: 1000,
      updatedAt: 1000,
    };
    const opencodeSession = {
      id: 'wks_opencode_running',
      agent: 'opencode',
      title: 'opencode',
      runtime: 'windows',
      cwd: 'H:\\walker',
      status: 'running',
      agentRef: { provider: 'opencode', opencodeSessionId: 'ses_keep' },
      errorMessage: null,
      createdAt: 1000,
      updatedAt: 1000,
    };
    const before = JSON.parse(JSON.stringify(claudeSession));
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({
      _schemaVersion: 3,
      sessions: {
        wks_old_claude: claudeSession,
        wks_upper_claude: upperSession,
        wks_spaced_claude: spacedSession,
        wks_opencode_running: opencodeSession,
      },
      routes: {
        'feishu:oc_1:ou_1': {
          focusSessionId: 'wks_old_claude',
          sessions: ['wks_old_claude', 'wks_upper_claude', 'wks_spaced_claude', 'wks_opencode_running'],
          cwd: 'H:\\walker',
          updatedAt: 1000,
        },
      },
      platformMessages: { feishu: {} },
    }, null, 2));
    try {
      const app = createApp(baseRemovedConfig(dir, { walkerDefaultAgent: 'claude' }), quietDeps());
      await app.start();
      const stored = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).sessions.wks_old_claude;
      const loaded = app.sessionService.getSession('wks_old_claude');
      assert.deepEqual(stored, before);
      assert.deepEqual(loaded, before);
      assert.equal(stored.id, 'wks_old_claude');
      assert.equal(stored.agent, 'claude');
      assert.equal(stored.status, 'running');
      assert.equal(stored.errorMessage, 'keep-me');
      assert.equal(stored.updatedAt, 1000);
      assert.equal(stored.agentRef.claudeSessionId, '11111111-1111-4111-8111-111111111111');
      assert.equal(app.sessionService.getSession('wks_opencode_running').status, 'idle');
      assert.equal(app.sessionService.getSession('wks_upper_claude').status, 'idle');
      assert.equal(app.sessionService.getSession('wks_upper_claude').agent, 'Claude');
      assert.equal(app.sessionService.getSession('wks_spaced_claude').status, 'idle');
      assert.equal(app.sessionService.getSession('wks_spaced_claude').agent, 'claude ');
      await app.stop();
    } finally {
      removeTempDir(dir);
    }
  });

  it('REQ-006-B02: 真实 stubCodexDriver 仍注册，claude-sonnet-4 原样保存', async () => {
    const dir = makeTempDir('walker-t1-codex-');
    const stubs = require('../src/drivers/stub-drivers');
    const model = { providerID: 'anthropic', modelID: 'claude-sonnet-4' };
    const before = JSON.parse(JSON.stringify(model));
    try {
      assert.equal(typeof stubs.stubCodexDriver, 'function');
      assert.equal(Object.prototype.hasOwnProperty.call(stubs, 'stubClaudeDriver'), false);
      const app = createApp(baseRemovedConfig(dir), quietDeps());
      assert.deepEqual(app.registry.list(), ['opencode', 'codex']);
      const codex = app.registry.get('codex');
      assert.equal(codex.name, 'codex');
      assert.equal(codex._isStub, true);
      await assert.rejects(() => codex.prompt(), /codex driver is not implemented yet/);
      const session = app.sessionService.createSession({
        agent: 'opencode',
        title: 'keep model',
        runtime: 'windows',
        cwd: dir,
        model,
      });
      assert.deepEqual(model, before);
      assert.deepEqual(session.model, before);
      assert.deepEqual(app.sessionService.getSession(session.id).model, before);
      const raw = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
      assert.deepEqual(raw.sessions[session.id].model, before);
      assert.equal(app.registry.get('claude'), null);
    } finally {
      removeTempDir(dir);
    }
  });

  it('REQ-008-B04: src 与 test 不再引用已删除 Claude 模块', () => {
    const hits = findDeletedModuleReferences([
      path.join(__dirname, '../src'),
      path.join(__dirname, '.'),
    ]);
    assert.deepEqual(hits, []);
  });
});
