'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const agentRuntimeAdmin = require('../src/admin/agent-runtime-admin');
const { DriverRegistry } = require('../src/drivers/driver-registry');

test('REQ-001-B03: register/unregister/clear 后 registry 与 provider metadata 保持一致', async () => {
  const registry = new DriverRegistry({
    detectorOptions: {
      resolveCommand: async () => '/usr/bin/opencode',
      runCommand: async () => ({ stdout: 'opencode 1.0.0\n' }),
      checkHealth: async () => true,
    },
  });
  const driver = { name: 'opencode' };

  registry.register('opencode', driver);
  assert.deepEqual(registry.list(), ['opencode']);
  assert.equal(registry.getProviderMetadata('opencode').registered, true);

  const registeredStatus = await registry.doctorProvider('opencode');
  assert.equal(registeredStatus.provider.registered, true);
  assert.equal(registeredStatus.provider.driverRegistered, true);

  registry.unregister('opencode');
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.getProviderMetadata('opencode').registered, false);

  registry.register('opencode', driver);
  registry.clear();
  assert.deepEqual(registry.list(), []);
  assert.equal(registry.getProviderMetadata('opencode').registered, false);
});

test('REQ-001-B07: driverRegistry.list() 仍只返回已注册 driver 名称', () => {
  const registry = new DriverRegistry();
  registry.register('opencode', { name: 'opencode' });
  registry.register('codex', { name: 'codex' });

  assert.deepEqual(registry.list(), ['opencode', 'codex']);
  assert.ok(!registry.list().some((item) => typeof item === 'object'));
});

test('REQ-002-B01: registry provider 列表只返回 opencode、codex、shell', () => {
  const registry = new DriverRegistry();

  assert.deepEqual(registry.listProviders().map((item) => item.id), ['opencode', 'codex', 'shell']);
  assert.equal(registry.getProviderMetadata('claude'), null);
  assert.equal(registry.getProviderMetadata('Claude'), null);
});

test('REQ-002-B03: registry doctor claude 与 Claude 返回 NOT_FOUND，空 id 保持原错误', async () => {
  let resolveCalls = 0;
  let runCalls = 0;
  const registry = new DriverRegistry({
    detectorOptions: {
      resolveCommand: async () => {
        resolveCalls += 1;
        return '/tmp/fake-claude';
      },
      runCommand: async () => {
        runCalls += 1;
        return { stdout: '2.1.196 (Claude Code)\n' };
      },
      execFile: () => {
        runCalls += 1;
      },
    },
  });

  const lower = await registry.doctorProvider('claude');
  const upper = await registry.doctorProvider('Claude');
  const empty = await registry.doctorProvider('');

  assert.equal(lower.ok, false);
  assert.equal(lower.error.code, 'NOT_FOUND');
  assert.equal(lower.error.message, 'unknown provider: claude');
  assert.equal(lower.provider, undefined);
  assert.equal(upper.ok, false);
  assert.equal(upper.error.code, 'NOT_FOUND');
  assert.equal(upper.error.message, 'unknown provider: Claude');
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, 'NOT_FOUND');
  assert.equal(empty.error.message, 'unknown provider: ');
  assert.notEqual(empty.error.message, 'unknown provider: claude');
  assert.equal(resolveCalls, 0);
  assert.equal(runCalls, 0);
});

test('REQ-002-B04: registry doctor 在 fake claude 可见时不探测版本', async () => {
  let resolveCalls = 0;
  let spawnCalls = 0;
  const registry = new DriverRegistry({
    detectorOptions: {
      env: { PATH: '/tmp/fake-claude-bin', CLAUDE_CMD: '/tmp/fake-claude-bin/claude' },
      resolveCommand: async (candidate) => {
        resolveCalls += 1;
        return candidate === 'claude' ? '/tmp/fake-claude-bin/claude' : null;
      },
      runCommand: async () => {
        spawnCalls += 1;
        return { stdout: '2.1.196 (Claude Code)\n' };
      },
      execFile: () => {
        spawnCalls += 1;
      },
      detectProvider: async () => {
        resolveCalls += 1;
        return { id: 'claude', version: 'should-not-run', installed: true, healthy: true };
      },
    },
  });

  const status = await registry.doctorProvider('claude');

  assert.equal(status.ok, false);
  assert.equal(status.error.code, 'NOT_FOUND');
  assert.equal(status.error.message, 'unknown provider: claude');
  assert.equal(status.provider, undefined);
  assert.equal(resolveCalls, 0);
  assert.equal(spawnCalls, 0);
});

test('REQ-001-B02: registry 查询未知 provider 返回 NOT_FOUND', async () => {
  const registry = new DriverRegistry();
  const result = await registry.doctorProvider('unknown');

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NOT_FOUND');
});

test('REQ-001-B05: listAgents 复用真实 DriverRegistry provider status 数组', async () => {
  const registry = new DriverRegistry({
    detectorOptions: {
      resolveCommand: async () => '/usr/bin/opencode',
      runCommand: async () => ({ stdout: 'opencode 1.2.3\n' }),
      checkHealth: async () => true,
      providers: [{
        id: 'opencode',
        label: 'OpenCode',
        driver: 'opencode',
        executableCandidates: ['opencode'],
        versionCommand: { args: ['--version'] },
        healthCheck: { type: 'driver' },
        capabilities: { sessions: true, models: true },
        configKeys: ['OPENCODE_SERVER_URL'],
      }],
    },
  });
  registry.register('opencode', { name: 'opencode', serverUrl: 'http://127.0.0.1:4096', autostart: false, opencodeCmd: 'opencode' });

  const providerStatuses = await registry.listProviderStatuses();
  const agents = agentRuntimeAdmin.listAgents({ registry }, { providerStatuses });

  assert.equal(agents[0].name, 'opencode');
  assert.equal(agents[0].provider.id, 'opencode');
  assert.equal(agents[0].provider.driver, 'opencode');
  assert.equal(agents[0].provider.installed, true);
  assert.equal(agents[0].provider.version, 'opencode 1.2.3');
  assert.equal(agents[0].provider.healthy, true);
  assert.deepEqual(agents[0].provider.problems, []);
  assert.deepEqual(agents[0].provider.suggestions, []);
  assert.deepEqual(agents[0].provider.health, { status: 'healthy', summary: 'provider health check passed' });
  assert.equal(agents[0].provider.registered, true);
  assert.equal(agents[0].provider.driverRegistered, true);
});
