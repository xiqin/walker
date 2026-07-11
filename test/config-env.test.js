const test = require('node:test');
const assert = require('node:assert/strict');

const { loadEnvConfig } = require('../src/config/env');

test('loadEnvConfig 默认值正确', () => {
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
  assert.equal(config.feishuDoneEmoji, 'none');
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

test('loadEnvConfig 缺少飞书凭据时标记为空', () => {
  const config = loadEnvConfig({ env: {} });
  assert.equal(config.feishuAppId, '');
  assert.equal(config.feishuAppSecret, '');
  assert.equal(config.feishuConfigSource, 'missing');
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
