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
  registry.register('claude', { name: 'claude' });

  assert.deepEqual(registry.list(), ['opencode', 'claude']);
  assert.ok(!registry.list().some((item) => typeof item === 'object'));
});

test('REQ-001-B02 和 REQ-008-B04: Claude provider 注册后不再呈现 stub 状态', async () => {
  const registry = new DriverRegistry({
    detectorOptions: {
      resolveCommand: async (candidate) => candidate === 'claude' ? '/usr/bin/claude' : null,
      runCommand: async () => ({ stdout: '2.1.196 (Claude Code)\n' }),
    },
  });

  registry.register('claude', { name: 'claude', _isStub: false, ensureReady() {} });
  const metadata = registry.getProviderMetadata('claude');
  const status = await registry.doctorProvider('claude');

  assert.equal(metadata.registered, true);
  assert.equal(status.provider.registered, true);
  assert.equal(status.provider.driverRegistered, true);
  assert.equal(status.provider.installed, true);
  assert.equal(status.provider.healthy, true);
  assert.equal(status.provider.version, '2.1.196 (Claude Code)');
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
