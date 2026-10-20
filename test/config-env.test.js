const { test, mock } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadEnvConfig } = require('../src/config/env');
const { EDITABLE_ENV_KEYS, CONFIG_GROUPS, buildConfigSummary } = require('../src/admin/config');

function assertNoClaudeConfigFields(value) {
  const keys = [];
  const visit = (current, prefix) => {
    if (!current || typeof current !== 'object') return;
    for (const key of Object.keys(current)) {
      const full = prefix ? `${prefix}.${key}` : key;
      keys.push(full);
      if (current[key] && typeof current[key] === 'object') visit(current[key], full);
    }
  };
  visit(value, '');
  assert.deepEqual(keys.filter((key) => /(^|\.)claude/i.test(key) || key.includes('CLAUDE_')), []);
}

function isolatedEnvOptions(tmpDir, envPath) {
  return {
    envPath,
    homeDir: path.join(tmpDir, 'home'),
    packageEnvPath: path.join(tmpDir, 'missing-package.env'),
  };
}

test('loadEnvConfig 默认值正常', () => {
  const config = loadEnvConfig({ env: {} });
  assert.equal(config.feishuRouteMode, 'thread');
  assert.equal(config.walkerDataDir, '');
  assert.equal(config.walkerDefaultAgent, 'opencode');
  assert.equal(config.walkerDefaultRuntime, 'windows');
  assert.equal(config.walkerDefaultCwd, '');
  assert.equal(config.walkerWslDistro, 'Ubuntu-24.04');
  assert.equal(config.opencodeServerUrl, '');
  assert.equal(config.opencodeServerAutostart, true);
  assert.equal(config.opencodeCmd, 'opencode');
  assert.equal(config.opencodeModel, '');
  assert.equal(config.opencodeAgent, '');
  assert.equal(config.feishuProgressStyle, 'card');
  assert.equal(config.feishuReactionEmoji, 'OnIt');
  assert.equal(config.feishuDoneEmoji, '');
  assert.equal(config.walkerPromptHeartbeatInitialMs, 30000);
  assert.equal(config.walkerPromptHeartbeatIntervalMs, 60000);
  assert.equal(config.walkerPromptHeartbeatStuckMs, 300000);
  assert.equal(config.walkerMaxTurnTimeMins, 0);
});

test('loadEnvConfig 环境变量覆盖默认值', () => {
  const env = {
    FEISHU_APP_ID: 'cli_test123',
    FEISHU_APP_SECRET: 'secret456',
    FEISHU_ROUTE_MODE: 'user',
    WALKER_DATA_DIR: '/tmp/walker-test',
    WALKER_DEFAULT_AGENT: 'codex',
    WALKER_DEFAULT_RUNTIME: 'wsl',
    WALKER_DEFAULT_CWD: '/home/user/project',
    WALKER_WSL_DISTRO: 'Ubuntu-22.04',
    OPENCODE_SERVER_URL: 'http://localhost:4096',
    OPENCODE_SERVER_AUTOSTART: 'false',
    OPENCODE_CMD: 'opencode-custom',
    OPENCODE_MODEL: 'anthropic/claude-sonnet-4',
    OPENCODE_AGENT: 'coder',
    FEISHU_PROGRESS_STYLE: 'compact',
    FEISHU_REACTION_EMOJI: 'ThumbsUp',
    FEISHU_DONE_EMOJI: 'Done',
    WALKER_PROMPT_HEARTBEAT_INITIAL_MS: '10000',
    WALKER_PROMPT_HEARTBEAT_INTERVAL_MS: '20000',
    WALKER_PROMPT_HEARTBEAT_STUCK_MS: '90000',
    WALKER_MAX_TURN_TIME_MINS: '45',
  };
  const config = loadEnvConfig({ env });
  assert.equal(config.feishuAppId, 'cli_test123');
  assert.equal(config.feishuAppSecret, 'secret456');
  assert.equal(config.feishuRouteMode, 'user');
  assert.equal(config.walkerDataDir, '/tmp/walker-test');
  assert.equal(config.walkerDefaultAgent, 'codex');
  assert.equal(config.walkerDefaultRuntime, 'wsl');
  assert.equal(config.walkerDefaultCwd, '/home/user/project');
  assert.equal(config.walkerWslDistro, 'Ubuntu-22.04');
  assert.equal(config.opencodeServerUrl, 'http://localhost:4096');
  assert.equal(config.opencodeServerAutostart, false);
  assert.equal(config.opencodeCmd, 'opencode-custom');
  assert.equal(config.opencodeModel, 'anthropic/claude-sonnet-4');
  assert.equal(config.opencodeAgent, 'coder');
  assert.equal(config.feishuProgressStyle, 'compact');
  assert.equal(config.feishuReactionEmoji, 'ThumbsUp');
  assert.equal(config.feishuDoneEmoji, 'Done');
  assert.equal(config.walkerPromptHeartbeatInitialMs, 10000);
  assert.equal(config.walkerPromptHeartbeatIntervalMs, 20000);
  assert.equal(config.walkerPromptHeartbeatStuckMs, 90000);
  assert.equal(config.walkerMaxTurnTimeMins, 45);
});

test('loadEnvConfig 长任务数值配置无效时回落默认值', () => {
  const config = loadEnvConfig({
    env: {
      WALKER_PROMPT_HEARTBEAT_INITIAL_MS: '0',
      WALKER_PROMPT_HEARTBEAT_INTERVAL_MS: '-1',
      WALKER_PROMPT_HEARTBEAT_STUCK_MS: 'abc',
      WALKER_MAX_TURN_TIME_MINS: 'nope',
    },
  });

  assert.equal(config.walkerPromptHeartbeatInitialMs, 30000);
  assert.equal(config.walkerPromptHeartbeatIntervalMs, 60000);
  assert.equal(config.walkerPromptHeartbeatStuckMs, 300000);
  assert.equal(config.walkerMaxTurnTimeMins, 0);
});

test('loadEnvConfig 缺少飞书凭据时标记为缺失', () => {
  const config = loadEnvConfig({ env: {} });
  assert.equal(config.feishuAppId, '');
  assert.equal(config.feishuAppSecret, '');
  assert.equal(config.feishuConfigSource, 'missing');
});

test('loadEnvConfig 默认读取用户数据目录 .env', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-home-'));
  const dataDir = path.join(homeDir, '.walker');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, '.env'), 'FEISHU_APP_ID=cli_data\nFEISHU_APP_SECRET=secret_data\n', 'utf8');

  const config = loadEnvConfig({ env: {}, homeDir, packageEnvPath: path.join(homeDir, 'missing-package.env') });

  assert.equal(config.feishuAppId, 'cli_data');
  assert.equal(config.feishuAppSecret, 'secret_data');
});

test('loadEnvConfig 读取 WALKER_DATA_DIR 指定目录 .env', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-data-'));
  fs.writeFileSync(path.join(tmpDir, '.env'), 'FEISHU_APP_ID=cli_custom\nFEISHU_APP_SECRET=secret_custom\n', 'utf8');
  const env = { WALKER_DATA_DIR: tmpDir };

  const config = loadEnvConfig({ env, homeDir: path.join(tmpDir, 'home'), packageEnvPath: path.join(tmpDir, 'missing-package.env') });

  assert.equal(config.feishuAppId, 'cli_custom');
  assert.equal(config.feishuAppSecret, 'secret_custom');
  assert.equal(config.walkerDataDir, tmpDir);
});

test('loadEnvConfig 已存在环境变量优先于数据目录 .env', () => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-home-'));
  const dataDir = path.join(homeDir, '.walker');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, '.env'), 'FEISHU_APP_ID=cli_data\nFEISHU_APP_SECRET=secret_data\n', 'utf8');

  const config = loadEnvConfig({
    env: { FEISHU_APP_ID: 'cli_env', FEISHU_APP_SECRET: 'secret_env' },
    homeDir,
    packageEnvPath: path.join(homeDir, 'missing-package.env'),
  });

  assert.equal(config.feishuAppId, 'cli_env');
  assert.equal(config.feishuAppSecret, 'secret_env');
});

test('loadEnvConfig emoji 为 none 时归一化为空字符串', () => {
  const config = loadEnvConfig({ env: { FEISHU_REACTION_EMOJI: 'none', FEISHU_DONE_EMOJI: 'NONE' } });
  assert.equal(config.feishuReactionEmoji, '');
  assert.equal(config.feishuDoneEmoji, '');
});

test('loadEnvConfig emoji 缺省时使用默认值', () => {
  const config = loadEnvConfig({ env: {} });
  assert.equal(config.feishuReactionEmoji, 'OnIt');
  assert.equal(config.feishuDoneEmoji, '');
});

test('loadEnvConfig boolean 解析', () => {
  const env1 = { OPENCODE_SERVER_AUTOSTART: 'true' };
  assert.equal(loadEnvConfig({ env: env1 }).opencodeServerAutostart, true);
  const env2 = { OPENCODE_SERVER_AUTOSTART: '1' };
  assert.equal(loadEnvConfig({ env: env2 }).opencodeServerAutostart, true);
  const env3 = { OPENCODE_SERVER_AUTOSTART: '0' };
  assert.equal(loadEnvConfig({ env: env3 }).opencodeServerAutostart, false);
  const env4 = { OPENCODE_SERVER_AUTOSTART: 'false' };
  assert.equal(loadEnvConfig({ env: env4 }).opencodeServerAutostart, false);
});

test('hook enabled 默认 true', () => {
  const config = loadEnvConfig({ env: {} });
  assert.equal(config.walkerOpencodeHookEnabled, true);
});

test('hook enabled 自定义值解析', () => {
  assert.equal(loadEnvConfig({ env: { WALKER_OPENCODE_HOOK_ENABLED: 'false' } }).walkerOpencodeHookEnabled, false);
  assert.equal(loadEnvConfig({ env: { WALKER_OPENCODE_HOOK_ENABLED: '0' } }).walkerOpencodeHookEnabled, false);
  assert.equal(loadEnvConfig({ env: { WALKER_OPENCODE_HOOK_ENABLED: 'true' } }).walkerOpencodeHookEnabled, true);
  assert.equal(loadEnvConfig({ env: { WALKER_OPENCODE_HOOK_ENABLED: '1' } }).walkerOpencodeHookEnabled, true);
});

test('health poll 默认 5000', () => {
  const config = loadEnvConfig({ env: {} });
  assert.equal(config.walkerOpencodeHealthPollIntervalMs, 5000);
});

test('health poll 自定义值解析', () => {
  assert.equal(loadEnvConfig({ env: { WALKER_OPENCODE_HEALTH_POLL_INTERVAL_MS: '1000' } }).walkerOpencodeHealthPollIntervalMs, 1000);
  assert.equal(loadEnvConfig({ env: { WALKER_OPENCODE_HEALTH_POLL_INTERVAL_MS: '30000' } }).walkerOpencodeHealthPollIntervalMs, 30000);
});

test('health poll 无效值回落默�?5000', () => {
  assert.equal(loadEnvConfig({ env: { WALKER_OPENCODE_HEALTH_POLL_INTERVAL_MS: '0' } }).walkerOpencodeHealthPollIntervalMs, 5000);
  assert.equal(loadEnvConfig({ env: { WALKER_OPENCODE_HEALTH_POLL_INTERVAL_MS: '-1' } }).walkerOpencodeHealthPollIntervalMs, 5000);
  assert.equal(loadEnvConfig({ env: { WALKER_OPENCODE_HEALTH_POLL_INTERVAL_MS: 'abc' } }).walkerOpencodeHealthPollIntervalMs, 5000);
});

test('exit action 默认 cancel', () => {
  const config = loadEnvConfig({ env: {} });
  assert.equal(config.walkerOpencodeExitAction, 'cancel');
});

test('exit action 自定义值解析', () => {
  assert.equal(loadEnvConfig({ env: { WALKER_OPENCODE_EXIT_ACTION: 'keep' } }).walkerOpencodeExitAction, 'keep');
  assert.equal(loadEnvConfig({ env: { WALKER_OPENCODE_EXIT_ACTION: 'restart' } }).walkerOpencodeExitAction, 'restart');
});

test('non focus output 默认 true', () => {
  const config = loadEnvConfig({ env: {} });
  assert.equal(config.walkerOpencodeNonFocusOutput, true);
});

test('non focus output 自定义值解析', () => {
  assert.equal(loadEnvConfig({ env: { WALKER_OPENCODE_NON_FOCUS_OUTPUT: 'false' } }).walkerOpencodeNonFocusOutput, false);
  assert.equal(loadEnvConfig({ env: { WALKER_OPENCODE_NON_FOCUS_OUTPUT: '0' } }).walkerOpencodeNonFocusOutput, false);
  assert.equal(loadEnvConfig({ env: { WALKER_OPENCODE_NON_FOCUS_OUTPUT: 'true' } }).walkerOpencodeNonFocusOutput, true);
  assert.equal(loadEnvConfig({ env: { WALKER_OPENCODE_NON_FOCUS_OUTPUT: 'yes' } }).walkerOpencodeNonFocusOutput, true);
});

test('hook 配置项在可编辑白名单中', () => {
  assert.ok(EDITABLE_ENV_KEYS.includes('WALKER_OPENCODE_HOOK_ENABLED'), 'WALKER_OPENCODE_HOOK_ENABLED 应在白名单中');
  assert.ok(EDITABLE_ENV_KEYS.includes('WALKER_OPENCODE_HEALTH_POLL_INTERVAL_MS'), 'WALKER_OPENCODE_HEALTH_POLL_INTERVAL_MS 应在白名单中');
  assert.ok(EDITABLE_ENV_KEYS.includes('WALKER_OPENCODE_EXIT_ACTION'), 'WALKER_OPENCODE_EXIT_ACTION 应在白名单中');
  assert.ok(EDITABLE_ENV_KEYS.includes('WALKER_OPENCODE_NON_FOCUS_OUTPUT'), 'WALKER_OPENCODE_NON_FOCUS_OUTPUT 应在白名单中');
});

test('loadEnvConfig 分层 transport timeout 默认值', () => {
  const config = loadEnvConfig({ env: {} });
  assert.equal(config.opencodePromptRequestTimeoutMs, 30000);
  assert.equal(config.opencodeSseIdleTimeoutMs, 300000);
  assert.equal(config.opencodeRecoveryWindowMs, 300000);
  assert.equal(config.opencodeTuiLeaseTimeoutMs, 90000);
  assert.equal(config.opencodeTuiHeartbeatIntervalMs, 30000);
});

test('loadEnvConfig 分层 transport timeout 显式零值保留', () => {
  const config = loadEnvConfig({
    env: {
      OPENCODE_SSE_OPEN_TIMEOUT_MS: '0',
      OPENCODE_PROMPT_REQUEST_TIMEOUT_MS: '0',
      OPENCODE_SSE_IDLE_TIMEOUT_MS: '0',
      OPENCODE_RECOVERY_WINDOW_MS: '0',
      OPENCODE_TUI_LEASE_TIMEOUT_MS: '0',
    },
  });
  assert.equal(config.opencodeSseOpenTimeoutMs, 0);
  assert.equal(config.opencodePromptRequestTimeoutMs, 0);
  assert.equal(config.opencodeSseIdleTimeoutMs, 0);
  assert.equal(config.opencodeRecoveryWindowMs, 0);
  assert.equal(config.opencodeTuiLeaseTimeoutMs, 0);
});

test('loadEnvConfig 旧 OPENCODE_PROMPT_TIMEOUT_MS 作为 idle fallback', () => {
  const config = loadEnvConfig({
    env: { OPENCODE_PROMPT_TIMEOUT_MS: '180000' },
  });
  assert.equal(config.opencodeSseIdleTimeoutMs, 180000);
  assert.equal(config.opencodePromptTimeoutMs, 180000);
});

test('loadEnvConfig 新 OPENCODE_SSE_IDLE_TIMEOUT_MS 优先于旧配置', () => {
  const config = loadEnvConfig({
    env: {
      OPENCODE_PROMPT_TIMEOUT_MS: '180000',
      OPENCODE_SSE_IDLE_TIMEOUT_MS: '600000',
    },
  });
  assert.equal(config.opencodeSseIdleTimeoutMs, 600000);
  assert.equal(config.opencodePromptTimeoutMs, 180000);
});

test('loadEnvConfig 无效分层 timeout 回落默认值', () => {
  const config = loadEnvConfig({
    env: {
      OPENCODE_PROMPT_REQUEST_TIMEOUT_MS: '-1',
      OPENCODE_SSE_IDLE_TIMEOUT_MS: 'abc',
      OPENCODE_TUI_LEASE_TIMEOUT_MS: '-5',
      OPENCODE_TUI_HEARTBEAT_INTERVAL_MS: '0',
    },
  });
  assert.equal(config.opencodePromptRequestTimeoutMs, 30000);
  assert.equal(config.opencodeSseIdleTimeoutMs, 300000);
  assert.equal(config.opencodeTuiLeaseTimeoutMs, 90000);
  assert.equal(config.opencodeTuiHeartbeatIntervalMs, 30000);
});

test('loadEnvConfig 拒绝 heartbeat 不小于 lease', () => {
  assert.throws(
    () => loadEnvConfig({ env: { OPENCODE_TUI_HEARTBEAT_INTERVAL_MS: '120000', OPENCODE_TUI_LEASE_TIMEOUT_MS: '90000' } }),
    (err) => err.message.includes('OPENCODE_TUI_HEARTBEAT_INTERVAL_MS') && err.message.includes('OPENCODE_TUI_LEASE_TIMEOUT_MS'),
  );
});

test('loadEnvConfig lease 为 0 时不校验 heartbeat 与 lease 关系', () => {
  const config = loadEnvConfig({
    env: { OPENCODE_TUI_LEASE_TIMEOUT_MS: '0', OPENCODE_TUI_HEARTBEAT_INTERVAL_MS: '30000' },
  });
  assert.equal(config.opencodeTuiLeaseTimeoutMs, 0);
  assert.equal(config.opencodeTuiHeartbeatIntervalMs, 30000);
});

test('REQ-003-B01: 默认配置对象和摘要不含 Claude 字段', () => {
  const config = loadEnvConfig({ env: {} });
  assert.equal(config.walkerDefaultAgent, 'opencode');
  assert.equal(config.opencodeCmd, 'opencode');
  assert.equal(config.feishuRouteMode, 'thread');
  assertNoClaudeConfigFields(config);

  const summary = buildConfigSummary({});
  assert.equal(summary.groups.some((group) => group.id === 'claude' || group.label === 'Claude'), false);
  assert.equal(summary.editableKeys.some((key) => key.startsWith('CLAUDE_')), false);
  assert.equal(Object.keys(summary.values).some((key) => key.startsWith('CLAUDE_')), false);
  assert.equal(summary.groups.flatMap((group) => group.items).some((item) => String(item.env).startsWith('CLAUDE_')), false);
  assert.deepEqual(summary.groups.map((group) => group.id), CONFIG_GROUPS.map((group) => group.id));
  assert.equal(EDITABLE_ENV_KEYS.some((key) => key.startsWith('CLAUDE_')), false);

  const example = fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  assert.equal(example.includes('CLAUDE_'), false);
  assert.equal(example.includes('Claude Code'), false);
  assert.match(example, /^FEISHU_APP_ID=/m);
  assert.match(example, /^FEISHU_APP_SECRET=/m);
  assert.match(example, /^OPENCODE_CMD=/m);
  assert.match(example, /^OPENCODE_SERVER_URL=/m);
});

test('REQ-003-B02: WALKER_DEFAULT_AGENT=claude 抛出 claude_removed 且不调用 createApp', () => {
  const createApp = mock.fn(() => ({ started: true }));
  const credentials = {
    FEISHU_APP_ID: 'cli_valid',
    FEISHU_APP_SECRET: 'secret_valid',
  };

  const ready = loadEnvConfig({ env: { ...credentials, WALKER_DEFAULT_AGENT: 'opencode' } });
  if (ready.feishuAppId && ready.feishuAppSecret) createApp(ready);
  assert.equal(createApp.mock.calls.length, 1);

  const unknownCase = loadEnvConfig({ env: { ...credentials, WALKER_DEFAULT_AGENT: 'Claude' } });
  assert.equal(unknownCase.walkerDefaultAgent, 'Claude');
  assertNoClaudeConfigFields(unknownCase);
  if (unknownCase.feishuAppId && unknownCase.feishuAppSecret) createApp(unknownCase);
  assert.equal(createApp.mock.calls.length, 2);

  assert.throws(
    () => {
      const config = loadEnvConfig({
        env: {
          ...credentials,
          WALKER_DEFAULT_AGENT: 'claude',
          CLAUDE_CMD: 'T3_B02_SHOULD_NOT_ECHO',
        },
      });
      if (config.feishuAppId && config.feishuAppSecret) createApp(config);
    },
    (err) => {
      assert.equal(err instanceof Error, true);
      assert.equal(err.code, 'claude_removed');
      assert.equal(err.message, 'Claude integration has been removed.');
      assert.equal(err.message.includes('T3_B02_SHOULD_NOT_ECHO'), false);
      assert.equal(JSON.stringify({ code: err.code, message: err.message }).includes('T3_B02_SHOULD_NOT_ECHO'), false);
      return true;
    },
  );
  assert.equal(createApp.mock.calls.length, 2);
});

test('REQ-003-B04: 残留 CLAUDE_* 被忽略且合法配置继续生效', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-req003-b04-'));
  const envPath = path.join(tmpDir, '.env');
  const original = [
    'CLAUDE_CMD=claude-beta',
    'CLAUDE_TOOLS=["unterminated',
    'CLAUDE_SAFE_MODE=not-a-bool',
    'CLAUDE_ALLOW_BYPASS_PERMISSIONS=true',
    'OPENCODE_CMD=opencode-custom',
    'OPENCODE_MODEL=anthropic/claude-sonnet-4',
    'FEISHU_APP_ID=cli_keep',
    'FEISHU_APP_SECRET=secret_keep',
    'FEISHU_ROUTE_MODE=user',
    '',
  ].join('\n');
  fs.writeFileSync(envPath, original, 'utf8');
  const before = fs.readFileSync(envPath);
  try {
    const config = loadEnvConfig({ env: {}, ...isolatedEnvOptions(tmpDir, envPath) });
    assert.equal(config.opencodeCmd, 'opencode-custom');
    assert.equal(config.opencodeModel, 'anthropic/claude-sonnet-4');
    assert.equal(config.feishuAppId, 'cli_keep');
    assert.equal(config.feishuAppSecret, 'secret_keep');
    assert.equal(config.feishuRouteMode, 'user');
    assert.equal(config.walkerDefaultAgent, 'opencode');
    assertNoClaudeConfigFields(config);
    assert.deepEqual(fs.readFileSync(envPath), before);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('REQ-003-B06: 不根据 CLAUDE_ALLOW_BYPASS_PERMISSIONS 构造 argv 或子进程', () => {
  const spawn = mock.method(childProcess, 'spawn', () => { throw new Error('spawn must not be called'); });
  const spawnSync = mock.method(childProcess, 'spawnSync', () => { throw new Error('spawnSync must not be called'); });
  const execFile = mock.method(childProcess, 'execFile', () => { throw new Error('execFile must not be called'); });
  const execFileSync = mock.method(childProcess, 'execFileSync', () => { throw new Error('execFileSync must not be called'); });
  try {
    const config = loadEnvConfig({
      env: {
        WALKER_DEFAULT_AGENT: 'opencode',
        CLAUDE_ALLOW_BYPASS_PERMISSIONS: 'true',
        CLAUDE_PERMISSION_MODE: 'bypassPermissions',
        OPENCODE_CMD: 'opencode',
      },
    });
    const serialized = JSON.stringify(config);
    assert.equal(serialized.includes('bypassPermissions'), false);
    assert.equal(serialized.includes('claudeAllowBypassPermissions'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(config, 'claudeAllowBypassPermissions'), false);
    assertNoClaudeConfigFields(config);
    assert.equal(config.opencodeCmd, 'opencode');
    assert.equal(spawn.mock.calls.length, 0);
    assert.equal(spawnSync.mock.calls.length, 0);
    assert.equal(execFile.mock.calls.length, 0);
    assert.equal(execFileSync.mock.calls.length, 0);

    for (const relativePath of ['src/config/env.js', 'src/admin/config.js', 'src/admin/config-editor.js']) {
      const source = fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
      assert.equal(source.includes('CLAUDE_ALLOW_BYPASS_PERMISSIONS'), false, relativePath);
      assert.equal(source.includes('bypassPermissions'), false, relativePath);
      assert.equal(source.includes('child_process'), false, relativePath);
    }
  } finally {
    spawn.mock.restore();
    spawnSync.mock.restore();
    execFile.mock.restore();
    execFileSync.mock.restore();
  }
});

test('REQ-003-B07: 默认 agent 改回 opencode 后即使残留 CLAUDE_* 也能加载', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-req003-b07-'));
  const envPath = path.join(tmpDir, '.env');
  const broken = [
    'WALKER_DEFAULT_AGENT=claude',
    'CLAUDE_CMD=claude-keep-cmd',
    'OPENCODE_CMD=opencode-custom',
    'FEISHU_APP_ID=cli_recover',
    'FEISHU_APP_SECRET=secret_recover',
    '',
  ].join('\n');
  fs.writeFileSync(envPath, broken, 'utf8');
  const before = fs.readFileSync(envPath);
  const options = isolatedEnvOptions(tmpDir, envPath);
  try {
    assert.throws(
      () => loadEnvConfig({ env: {}, ...options }),
      (err) => err.code === 'claude_removed' && err.message === 'Claude integration has been removed.',
    );
    assert.deepEqual(fs.readFileSync(envPath), before);

    const repaired = broken.replace('WALKER_DEFAULT_AGENT=claude', 'WALKER_DEFAULT_AGENT=opencode');
    fs.writeFileSync(envPath, repaired, 'utf8');
    const config = loadEnvConfig({ env: {}, ...options });
    assert.equal(config.walkerDefaultAgent, 'opencode');
    assert.equal(config.opencodeCmd, 'opencode-custom');
    assert.equal(config.feishuAppId, 'cli_recover');
    assert.equal(config.feishuAppSecret, 'secret_recover');
    assertNoClaudeConfigFields(config);
    const after = fs.readFileSync(envPath, 'utf8');
    assert.match(after, /^CLAUDE_CMD=claude-keep-cmd/m);
    assert.match(after, /^WALKER_DEFAULT_AGENT=opencode/m);
    assert.equal(after.includes('WALKER_DEFAULT_AGENT=claude'), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('OPENCODE_SERVER_PASSWORD 可读且不在管理端可编辑白名单', () => {
  assert.equal(loadEnvConfig({ env: {} }).opencodeServerPassword, '');
  assert.equal(loadEnvConfig({ env: { OPENCODE_SERVER_PASSWORD: 'secret-value' } }).opencodeServerPassword, 'secret-value');
  assert.equal(EDITABLE_ENV_KEYS.includes('OPENCODE_SERVER_PASSWORD'), false);
});
