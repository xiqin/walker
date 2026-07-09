const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('../src/app/bootstrap');

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
        constructor() { this.sessionsStore = { read: () => ({}) }; this.routesStore = { read: () => ({}) }; }
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
    };
    const app = createApp(config, deps);
    assert.ok(app);
    assert.ok(app.start);
  });
});
