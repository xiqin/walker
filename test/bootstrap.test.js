const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app/bootstrap');
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
      stubClaudeDriver: () => ({ name: 'claude' }),
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
    app.stop();
    assert.deepEqual(platformStopped, ['feishu']);
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
