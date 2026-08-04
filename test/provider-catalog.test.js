'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { listProviderCatalog } = require('../src/providers/provider-catalog');
const { detectProvider, defaultResolveCommand, runCommand } = require('../src/providers/provider-detectors');
const { doctorProvider, listProviderStatuses } = require('../src/providers/provider-health');
const agentRuntimeAdmin = require('../src/admin/agent-runtime-admin');

/**
 * 创建可控的 provider 检测依赖，避免测试访问真实本机命令。
 * @param {Object} behavior - 每个命令候选的模拟行为。
 * @returns {Object} provider 检测依赖。
 */
function createDetectorOptions(behavior) {
  return {
    resolveCommand: async (candidate) => {
      const item = behavior[candidate];
      if (!item || item.missing) return null;
      if (item.resolveError) throw new Error(item.resolveError);
      return item.path || '/usr/bin/' + candidate;
    },
    runCommand: async (command, args) => {
      const commandName = String(command).split(/[\\/]/).pop();
      const item = behavior[command] || behavior[commandName] || behavior[args && args[0]] || {};
      if (item.runError) throw new Error(item.runError);
      return { stdout: item.stdout || '1.2.3\n', stderr: item.stderr || '' };
    },
    checkHealth: async (provider) => {
      const item = behavior[provider.id] || {};
      if (item.healthError) throw new Error(item.healthError);
      return item.health !== undefined ? item.health : true;
    },
  };
}

test('REQ-001-B01: 已安装 provider 返回安装、版本、capabilities 和健康摘要', async () => {
  const result = await doctorProvider('opencode', createDetectorOptions({
    opencode: { path: '/usr/local/bin/opencode', stdout: 'opencode 0.9.1\n', health: true },
  }));

  assert.equal(result.ok, true);
  assert.equal(result.provider.id, 'opencode');
  assert.equal(result.provider.installed, true);
  assert.equal(result.provider.executablePath, '/usr/local/bin/opencode');
  assert.equal(result.provider.version, 'opencode 0.9.1');
  assert.equal(result.provider.healthy, true);
  assert.ok(result.provider.capabilities.sessions);
  assert.deepEqual(result.provider.problems, []);
});

test('REQ-001-B01 和 REQ-007-B03: Claude catalog 声明真实 CLI driver 能力和配置键', () => {
  const claude = listProviderCatalog().find((item) => item.id === 'claude');

  assert.equal(claude.driver, 'claude');
  assert.deepEqual(claude.executableCandidates, ['claude']);
  assert.deepEqual(claude.versionCommand.args, ['--version']);
  assert.equal(claude.healthCheck.type, 'command');
  assert.deepEqual(claude.capabilities, {
    sessions: true,
    tui: true,
    http: false,
    models: true,
    permissions: true,
    window: true,
  });
  assert.ok(claude.configKeys.includes('CLAUDE_CMD'));
  assert.ok(claude.configKeys.includes('CLAUDE_MODEL'));
  assert.ok(claude.configKeys.includes('CLAUDE_FALLBACK_MODEL'));
  assert.ok(claude.configKeys.includes('CLAUDE_AGENT'));
  assert.ok(claude.configKeys.includes('CLAUDE_PERMISSION_MODE'));
  assert.ok(claude.configKeys.includes('CLAUDE_ALLOWED_TOOLS'));
  assert.ok(claude.configKeys.includes('CLAUDE_DISALLOWED_TOOLS'));
  assert.ok(claude.configKeys.includes('CLAUDE_CONFIG_DIR'));
  assert.ok(claude.configKeys.includes('CLAUDE_PROMPT_TIMEOUT_MS'));
});

test('REQ-001-B02: 未知 provider 返回明确 NOT_FOUND 且不调用检测依赖', async () => {
  let calls = 0;
  const result = await doctorProvider('unknown', {
    resolveCommand: async () => { calls++; return '/bin/unknown'; },
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'NOT_FOUND');
  assert.equal(calls, 0);
});

test('REQ-001-B04: 命令缺失、版本失败和健康失败转换为 problems 与 suggestions', async () => {
  const missing = await doctorProvider('claude', createDetectorOptions({ claude: { missing: true } }));
  assert.equal(missing.provider.installed, false);
  assert.equal(missing.provider.healthy, false);
  assert.ok(missing.provider.problems.some((item) => item.code === 'COMMAND_NOT_FOUND'));
  assert.ok(missing.provider.suggestions.length > 0);

  const versionFailed = await doctorProvider('codex', createDetectorOptions({ codex: { runError: 'version timed out' } }));
  assert.equal(versionFailed.provider.installed, true);
  assert.equal(versionFailed.provider.healthy, false);
  assert.ok(versionFailed.provider.problems.some((item) => item.code === 'VERSION_FAILED'));

  const healthFailed = await doctorProvider('opencode', createDetectorOptions({
    opencode: { path: '/usr/local/bin/opencode', stdout: 'opencode 0.9.1\n', healthError: 'server unavailable' },
  }));
  assert.equal(healthFailed.provider.healthy, false);
  assert.ok(healthFailed.provider.problems.some((item) => item.code === 'HEALTH_CHECK_FAILED'));
});

test('REQ-007-B03: Claude provider 检测优先使用 CLAUDE_CMD 配置命令', async () => {
  const result = await doctorProvider('claude', {
    ...createDetectorOptions({
      claude: { missing: true },
      'claude-beta': { path: '/opt/bin/claude-beta', stdout: '2.1.196 (Claude Code)\n', health: true },
    }),
    env: { CLAUDE_CMD: 'claude-beta' },
  });

  assert.equal(result.ok, true);
  assert.equal(result.provider.installed, true);
  assert.equal(result.provider.executablePath, '/opt/bin/claude-beta');
  assert.equal(result.provider.version, '2.1.196 (Claude Code)');
});

test('REQ-001-B04: 默认命令解析器使用平台可执行查找命令', async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const calls = [];
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const resolved = await defaultResolveCommand('opencode', {
      runCommand: (command, args) => {
        calls.push({ command, args });
        return Promise.resolve({ stdout: '/usr/local/bin/opencode\n', stderr: '' });
      },
    });

    assert.equal(resolved, '/usr/local/bin/opencode');
    assert.deepEqual(calls, [{ command: 'which', args: ['opencode'] }]);
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

test('REQ-003-B01 和 REQ-003-B02: runCommand 仅向子进程传递最小必要环境变量', async () => {
  const calls = [];
  const env = {
    PATH: '/usr/local/bin:/usr/bin',
    Path: 'C:\\Windows\\System32',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    SystemRoot: 'C:\\Windows',
    COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    HOME: '/home/alice',
    USERPROFILE: 'C:\\Users\\alice',
    WALKER_ADMIN_TOKEN: 'admin-token',
    FEISHU_APP_SECRET: 'feishu-secret',
    SERVICE_PASSWORD: 'service-password',
    OPENAI_API_KEY: 'openai-key',
    NORMAL_VALUE: 'not-required',
  };
  const execFile = (command, args, options, callback) => {
    calls.push({ command, args, options });
    callback(null, 'ok\n', '');
    return { stdin: { end() {} } };
  };

  const result = await runCommand('provider', ['--version'], { env, execFile });

  assert.equal(result.stdout, 'ok\n');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.env, {
    PATH: '/usr/local/bin:/usr/bin',
    Path: 'C:\\Windows\\System32',
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    SystemRoot: 'C:\\Windows',
    COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
    HOME: '/home/alice',
    USERPROFILE: 'C:\\Users\\alice',
  });
  assert.equal(calls[0].options.env.WALKER_ADMIN_TOKEN, undefined);
  assert.equal(calls[0].options.env.FEISHU_APP_SECRET, undefined);
  assert.equal(calls[0].options.env.SERVICE_PASSWORD, undefined);
  assert.equal(calls[0].options.env.OPENAI_API_KEY, undefined);
});

test('REQ-003-B01 和 REQ-003-B02: defaultResolveCommand 查找命令也使用受限环境变量', async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const calls = [];
  try {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const resolved = await defaultResolveCommand('opencode', {
      env: {
        PATH: '/bin',
        HOME: '/home/alice',
        WALKER_ADMIN_TOKEN: 'admin-token',
        FEISHU_APP_SECRET: 'feishu-secret',
      },
      runCommand: (command, args, options) => {
        calls.push({ command, args, env: options.env });
        return Promise.resolve({ stdout: '/bin/opencode\n', stderr: '' });
      },
    });

    assert.equal(resolved, '/bin/opencode');
    assert.deepEqual(calls, [{ command: 'which', args: ['opencode'], env: { PATH: '/bin', HOME: '/home/alice' } }]);
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

test('REQ-003-B03: provider version command 失败仍返回结构化 problem 和 suggestion', async () => {
  const result = await doctorProvider('codex', createDetectorOptions({ codex: { runError: 'TOKEN=raw-secret failed' } }));

  assert.equal(result.ok, true);
  assert.equal(result.provider.installed, true);
  assert.equal(result.provider.healthy, false);
  assert.ok(result.provider.problems.some((item) => item.code === 'VERSION_FAILED' && item.message === 'TOKEN=raw-secret failed'));
  assert.ok(result.provider.suggestions.some((item) => /codex --version/.test(item)));
});

test('REQ-001-B04: Windows 默认命令解析器继续使用 where', async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const calls = [];
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const resolved = await defaultResolveCommand('opencode', {
      runCommand: (command, args) => {
        calls.push({ command, args });
        return Promise.resolve({ stdout: 'C:\\tools\\opencode.exe\r\n', stderr: '' });
      },
    });

    assert.equal(resolved, 'C:\\tools\\opencode.exe');
    assert.deepEqual(calls, [{ command: 'where', args: ['opencode'] }]);
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

test('REQ-007-B03: Windows 命令解析器优先使用可直接 spawn 的 exe 路径', async () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const calls = [];
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const resolved = await defaultResolveCommand('kscc', {
      runCommand: (command, args) => {
        calls.push({ command, args });
        return Promise.resolve({
          stdout: 'I:\\nvmNodejs\\nodejs\\kscc\r\nI:\\nvmNodejs\\nodejs\\kscc.cmd\r\nI:\\nvm\\v22.11.0\\node_modules\\@seasun\\kscc\\kscc.exe\r\n',
          stderr: '',
        });
      },
    });

    assert.equal(resolved, 'I:\\nvm\\v22.11.0\\node_modules\\@seasun\\kscc\\kscc.exe');
    assert.deepEqual(calls, [{ command: 'where', args: ['kscc'] }]);
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform);
  }
});

test('REQ-001-B04: shell provider version 使用 Windows COMSPEC 环境变量', async () => {
  const originalComspec = process.env.COMSPEC;
  const originalShell = process.env.SHELL;
  try {
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    delete process.env.SHELL;
    const provider = listProviderCatalog().find((item) => item.id === 'shell');
    const result = await detectProvider(provider, {});

    assert.equal(result.executablePath, 'C:\\Windows\\System32\\cmd.exe');
    assert.equal(result.version, 'C:\\Windows\\System32\\cmd.exe');
  } finally {
    if (originalComspec === undefined) delete process.env.COMSPEC;
    else process.env.COMSPEC = originalComspec;
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
  }
});

test('REQ-001-B05: Admin agent 状态复用 provider 检测结构', async () => {
  const ctx = {
    registry: {
      list: () => ['opencode'],
      get: () => ({ serverUrl: 'http://127.0.0.1:4096', autostart: false, opencodeCmd: 'opencode' }),
      getProviderMetadata: () => ({
        id: 'opencode', installed: true, version: 'opencode 0.9.1', healthy: true,
        problems: [], suggestions: [], capabilities: { sessions: true }, configKeys: ['OPENCODE_SERVER_URL'],
      }),
    },
  };

  const agents = agentRuntimeAdmin.listAgents(ctx, createDetectorOptions({}));
  assert.equal(agents[0].name, 'opencode');
  assert.equal(agents[0].provider.id, 'opencode');
  assert.equal(agents[0].provider.installed, true);
  assert.equal(agents[0].provider.healthy, true);
  assert.ok(agents[0].provider.capabilities.sessions);
});

test('REQ-001-B05: Admin agent 状态兼容 providerStatuses 对象映射', () => {
  const ctx = {
    registry: {
      list: () => ['opencode'],
      get: () => ({ serverUrl: '', autostart: true, opencodeCmd: 'opencode' }),
    },
  };

  const providerStatus = {
    id: 'opencode', driver: 'opencode', installed: true, version: 'opencode 0.9.1', healthy: true,
    problems: [], suggestions: [], health: { status: 'healthy', summary: 'ok' }, capabilities: { sessions: true },
  };
  const agents = agentRuntimeAdmin.listAgents(ctx, { providerStatuses: { opencode: providerStatus } });

  assert.equal(agents[0].provider, providerStatus);
  assert.equal(agents[0].provider.installed, true);
  assert.equal(agents[0].provider.version, 'opencode 0.9.1');
  assert.deepEqual(agents[0].provider.health, { status: 'healthy', summary: 'ok' });
});

test('REQ-001-B06 和 REQ-007-B05: 单 provider 异常被结构化捕获且不影响其他 provider', async () => {
  const statuses = await listProviderStatuses({
    providers: listProviderCatalog(),
    detectProvider: async (provider) => {
      if (provider.id === 'claude') throw new Error('detector exploded');
      return {
        id: provider.id,
        installed: provider.id === 'shell',
        healthy: provider.id === 'shell',
        problems: [],
        suggestions: [],
        capabilities: provider.capabilities,
      };
    },
  });

  const claude = statuses.find((item) => item.id === 'claude');
  const shell = statuses.find((item) => item.id === 'shell');
  assert.equal(claude.healthy, false);
  assert.ok(claude.problems.some((item) => item.code === 'DETECTOR_EXCEPTION'));
  assert.equal(shell.installed, true);
  assert.equal(shell.healthy, true);
});
