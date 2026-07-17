const fs = require('fs');
const path = require('path');

/**
 * 从 .env 文件加载环境变量到 process.env（不覆盖已存在的变量）
 * @param {string} [envPath] - .env 文件路径，默认为项目根目录下的 .env
 */
function loadDotEnv(envPath) {
  const filePath = envPath || path.join(__dirname, '..', '..', '.env');
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

/**
 * 加载环境配置，从环境变量 / .env 文件读取飞书凭据
 * @param {Object} options - 配置选项
 * @param {Object} [options.env] - 环境变量对象，默认使用 process.env
 * @returns {Object} 包含所有配置项的对象
 */
function loadEnvConfig(options) {
  loadDotEnv(options && options.envPath);
  const env = (options && options.env) || process.env;

  const feishuAppId = env.FEISHU_APP_ID || '';
  const feishuAppSecret = env.FEISHU_APP_SECRET || '';
  const feishuConfigSource = (feishuAppId && feishuAppSecret) ? 'env' : 'missing';

  /**
   * 将字符串值解析为布尔值
   * @param {string|undefined} val - 要解析的值
   * @param {boolean} defaultVal - 当值为空时的默认返回值
   * @returns {boolean} 解析后的布尔值
   */
  function parseBool(val, defaultVal) {
    if (val === undefined || val === '') return defaultVal;
    const s = String(val).toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }

  /**
   * 解析端口数值，无效值回落默认端口
   * @param {string} val - 端口字符串
   * @param {number} defaultVal - 默认端口
   * @returns {number}
   */
  function parsePort(val, defaultVal) {
    const port = parseInt(val, 10);
    return Number.isFinite(port) && port > 0 ? port : defaultVal;
  }

  function parseNonNegativeInt(val, defaultVal) {
    if (val === undefined || val === '') return defaultVal;
    const num = parseInt(val, 10);
    return Number.isFinite(num) && num >= 0 ? num : defaultVal;
  }

  function parsePositiveInt(val, defaultVal) {
    const num = parseInt(val, 10);
    return Number.isFinite(num) && num > 0 ? num : defaultVal;
  }

  function normalizeEmoji(val, defaultVal) {
    const raw = val != null ? String(val).trim() : '';
    if (!raw) return defaultVal;
    return raw.toLowerCase() === 'none' ? '' : raw;
  }

  const result = {
    feishuAppId,
    feishuAppSecret,
    feishuConfigSource,
    feishuRouteMode: env.FEISHU_ROUTE_MODE || 'thread',
    walkerDataDir: env.WALKER_DATA_DIR || '',
    walkerDefaultAgent: env.WALKER_DEFAULT_AGENT || 'opencode',
    walkerDefaultRuntime: env.WALKER_DEFAULT_RUNTIME || 'windows',
    walkerDefaultCwd: env.WALKER_DEFAULT_CWD || '',
    walkerWslDistro: env.WALKER_WSL_DISTRO || 'Ubuntu-24.04',
    opencodeServerUrl: env.OPENCODE_SERVER_URL || '',
    opencodeServerAutostart: parseBool(env.OPENCODE_SERVER_AUTOSTART, true),
    opencodeCmd: env.OPENCODE_CMD || 'opencode',
    opencodeModel: env.OPENCODE_MODEL || '',
    opencodeAgent: env.OPENCODE_AGENT || '',
    feishuProgressStyle: env.FEISHU_PROGRESS_STYLE || 'card',
    feishuReactionEmoji: normalizeEmoji(env.FEISHU_REACTION_EMOJI, 'OnIt'),
    feishuDoneEmoji: normalizeEmoji(env.FEISHU_DONE_EMOJI, ''),
    walkerPromptHeartbeatInitialMs: parsePositiveInt(env.WALKER_PROMPT_HEARTBEAT_INITIAL_MS, 30000),
    walkerPromptHeartbeatIntervalMs: parsePositiveInt(env.WALKER_PROMPT_HEARTBEAT_INTERVAL_MS, 60000),
    walkerPromptHeartbeatStuckMs: parsePositiveInt(env.WALKER_PROMPT_HEARTBEAT_STUCK_MS, 300000),
    walkerMaxTurnTimeMins: parsePositiveInt(env.WALKER_MAX_TURN_TIME_MINS, 0),
    walkerDedupWindowMs: parsePositiveInt(env.WALKER_DEDUP_WINDOW_MS, 300000),
    opencodePollInterval: parsePositiveInt(env.OPENCODE_POLL_INTERVAL, 500),
    opencodeMaxPolls: parsePositiveInt(env.OPENCODE_MAX_POLLS, 20),
    opencodePromptTimeoutMs: parsePositiveInt(env.OPENCODE_PROMPT_TIMEOUT_MS, 120000),
    opencodeSseOpenTimeoutMs: parseNonNegativeInt(env.OPENCODE_SSE_OPEN_TIMEOUT_MS, 1000),
    opencodePromptRequestTimeoutMs: parseNonNegativeInt(env.OPENCODE_PROMPT_REQUEST_TIMEOUT_MS, 30000),
    opencodeSseIdleTimeoutMs: env.OPENCODE_SSE_IDLE_TIMEOUT_MS !== undefined
      ? parseNonNegativeInt(env.OPENCODE_SSE_IDLE_TIMEOUT_MS, 300000)
      : parseNonNegativeInt(env.OPENCODE_PROMPT_TIMEOUT_MS, 300000),
    opencodeRecoveryWindowMs: parseNonNegativeInt(env.OPENCODE_RECOVERY_WINDOW_MS, 300000),
    opencodeMessagePollIntervalMs: parsePositiveInt(env.OPENCODE_MESSAGE_POLL_INTERVAL_MS, 3000),
    opencodeTuiLeaseTimeoutMs: parseNonNegativeInt(env.OPENCODE_TUI_LEASE_TIMEOUT_MS, 90000),
    opencodeTuiHeartbeatIntervalMs: parsePositiveInt(env.OPENCODE_TUI_HEARTBEAT_INTERVAL_MS, 30000),
    opencodeConfigDir: env.OPENCODE_CONFIG_DIR || '',
    admin: {
      enabled: parseBool(env.WALKER_ADMIN_ENABLED, true),
      host: env.WALKER_ADMIN_HOST || '127.0.0.1',
      port: parsePort(env.WALKER_ADMIN_PORT, 8787),
      token: env.WALKER_ADMIN_TOKEN || '',
    },
    walkerOpencodeHookEnabled: parseBool(env.WALKER_OPENCODE_HOOK_ENABLED, true),
    walkerOpencodeHealthPollIntervalMs: parsePositiveInt(env.WALKER_OPENCODE_HEALTH_POLL_INTERVAL_MS, 5000),
    walkerOpencodeExitAction: env.WALKER_OPENCODE_EXIT_ACTION || 'cancel',
    walkerOpencodeNonFocusOutput: parseBool(env.WALKER_OPENCODE_NON_FOCUS_OUTPUT, true),
  };

  if (result.opencodeTuiLeaseTimeoutMs > 0 && result.opencodeTuiHeartbeatIntervalMs >= result.opencodeTuiLeaseTimeoutMs) {
    throw new Error(
      'OPENCODE_TUI_HEARTBEAT_INTERVAL_MS (' + result.opencodeTuiHeartbeatIntervalMs +
      ') must be less than OPENCODE_TUI_LEASE_TIMEOUT_MS (' + result.opencodeTuiLeaseTimeoutMs +
      ') when lease timeout is enabled',
    );
  }

  return result;
}

module.exports = { loadEnvConfig, loadDotEnv };
