const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app/bootstrap');
const { AgentEvent } = require('../src/drivers/agent-driver');

/** 构建标准测试依赖映射，adminEnabled 控制是否注入 admin server */
function makeDeps(adminEnabled) {
  const adminStarted = [];
  const adminStopped = [];
  const platformStarted = [];
  const platformStopped = [];
  const adminServer = adminEnabled ? {
    start() { adminStarted.push('admin'); return Promise.resolve({ ok: true, host: '127.0.0.1', port: 8787 }); },
    stop() { adminStopped.push('admin'); return Promise.resolve({ ok: true }); },
    getStatus() { return { started: true, disabled: false, host: '127.0.0.1', port: 8787 }; },
  } : null;
  return {
    FeishuPlatform: class {
      start() { platformStarted.push('feishu'); return Promise.resolve(); }
      stop() { platformStopped.push('feishu'); }
    },
    SessionService: class { constructor() {} },
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
    createAdminServer: () => adminServer,
    _adminStarted,
    _adminStopped,
    _platformStarted,
    _platformStopped,
  };

  function _adminStarted() { return adminStarted; }
  function _adminStopped() { return adminStopped; }
  function _platformStarted() { return platformStarted; }
  function _platformStopped() { return platformStopped; }
}

describe('createApp', () => {
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
            replyText: async () => {},
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
    assert.ok(lastPatch.card.elements.some((el) => el.text.content.includes('我是 opencode')));
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
    assert.deepEqual(stopped, ['admin', 'feishu']);
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
});
