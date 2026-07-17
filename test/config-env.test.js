const test = require('node:test');
const assert = require('node:assert/strict');

const { loadEnvConfig } = require('../src/config/env');
const { EDITABLE_ENV_KEYS } = require('../src/admin/config');

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
    WALKER_DEFAULT_AGENT: 'claude',
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
  assert.equal(config.walkerDefaultAgent, 'claude');
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
