const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
});

test('loadEnvConfig 从 cc-connect TOML 读取飞书凭据回退', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-env-'));
  const configPath = path.join(tmpDir, 'config.toml');
  fs.writeFileSync(configPath, [
    'app_id = "cli_from_toml"',
    'app_secret = "secret_from_toml"',
  ].join('\n'), 'utf8');

  const config = loadEnvConfig({ env: {}, ccConnectConfigPath: configPath });
  assert.equal(config.feishuAppId, 'cli_from_toml');
  assert.equal(config.feishuAppSecret, 'secret_from_toml');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('loadEnvConfig 环境变量优先于 cc-connect TOML', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-env-'));
  const configPath = path.join(tmpDir, 'config.toml');
  fs.writeFileSync(configPath, [
    'app_id = "cli_from_toml"',
    'app_secret = "secret_from_toml"',
  ].join('\n'), 'utf8');

  const env = { FEISHU_APP_ID: 'cli_env', FEISHU_APP_SECRET: 'secret_env' };
  const config = loadEnvConfig({ env, ccConnectConfigPath: configPath });
  assert.equal(config.feishuAppId, 'cli_env');
  assert.equal(config.feishuAppSecret, 'secret_env');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('loadEnvConfig 缺少飞书凭据时标记为空', () => {
  const config = loadEnvConfig({ env: {}, ccConnectConfigPath: '/nonexistent/missing-config.toml' });
  assert.equal(config.feishuAppId, '');
  assert.equal(config.feishuAppSecret, '');
  assert.equal(config.feishuConfigSource, 'missing');
});

test('loadEnvConfig cc-connect TOML 不存在时不报错', () => {
  const config = loadEnvConfig({ env: {}, ccConnectConfigPath: '/nonexistent/config.toml' });
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
