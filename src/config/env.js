const fs = require('fs');
const os = require('os');
const path = require('path');

const PACKAGE_ENV_PATH = path.join(__dirname, '..', '..', '.env');

/**
 * 从 .env 文件加载环境变量到 process.env（不覆盖已存在的变量）
 * @param {string} [envPath] - 显式 .env 文件路径
 * @param {Object} [options]
 * @param {Object} [options.env] - 要写入的环境变量对象，默认 process.env
 * @param {string} [options.homeDir] - 用户目录，测试注入用
 * @param {string} [options.packageEnvPath] - 安装包 .env 路径，测试注入用
 */
function loadDotEnv(envPath, options) {
  const opts = options || {};
  const targetEnv = opts.env || process.env;
  const filePaths = getDotEnvPaths(envPath, {
    env: targetEnv,
    homeDir: opts.homeDir,
    packageEnvPath: opts.packageEnvPath,
  });

  for (const filePath of filePaths) {
    loadDotEnvFile(filePath, targetEnv);
  }
}

function loadDotEnvFile(filePath, targetEnv) {
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
    if (!targetEnv[key]) {
      targetEnv[key] = val;
    }
  }
}

function getDotEnvPaths(envPath, options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const paths = [];
  if (envPath) paths.push(envPath);

  const dataDir = resolveWalkerDataDir(env, opts.homeDir);
  if (dataDir) paths.push(path.join(dataDir, '.env'));

  paths.push(opts.packageEnvPath || PACKAGE_ENV_PATH);
  return Array.from(new Set(paths));
}

function resolveWalkerDataDir(env, homeDir) {
  const home = homeDir || os.homedir() || env.USERPROFILE || env.HOME || '.';
  const value = env.WALKER_DATA_DIR || path.join(home, '.walker');
  if (value === '~') return home;
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(home, value.slice(2));
  }
  return value;
}

function createConfigError(key, message) {
  return new Error(`${key} ${message}`);
}

function parseListValue(key, val, defaultVal) {
  if (val === undefined || val === '') return defaultVal.slice();
  const text = String(val).trim();
  if (!text) return defaultVal.slice();
  if (text.startsWith('[')) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (_err) {
      throw createConfigError(key, 'must be valid JSON array');
    }
    if (!Array.isArray(parsed)) throw createConfigError(key, 'must be a list');
    if (!parsed.every((item) => typeof item === 'string')) throw createConfigError(key, 'must contain only strings');
    return parsed.map((item) => item.trim()).filter(Boolean);
  }
  if (text.startsWith('{')) throw createConfigError(key, 'must be a list');
  return text.split(',').map((item) => item.trim()).filter(Boolean);
}

function parseJsonObjectValue(key, val, defaultVal) {
  if (val === undefined || val === '') return { ...defaultVal };
  const text = String(val).trim();
  if (!text) return { ...defaultVal };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_err) {
    throw createConfigError(key, 'must be valid JSON object');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw createConfigError(key, 'must be a JSON object');
  return parsed;
}

/**
 * 加载环境配置，从环境变量 / .env 文件读取飞书凭据
 * @param {Object} options - 配置选项
 * @param {Object} [options.env] - 环境变量对象，默认使用 process.env
 * @returns {Object} 包含所有配置项的对象
 */
function loadEnvConfig(options) {
  const env = (options && options.env) || process.env;
  const shouldLoadDotEnv = !options || !options.env || options.envPath || options.homeDir || options.packageEnvPath;
  if (shouldLoadDotEnv) {
    loadDotEnv(options && options.envPath, {
      env,
      homeDir: options && options.homeDir,
      packageEnvPath: options && options.packageEnvPath,
    });
  }

  const feishuAppId = env.FEISHU_APP_ID || '';
  const feishuAppSecret = env.FEISHU_APP_SECRET || '';
  const feishuConfigSource = (feishuAppId && feishuAppSecret) ? 'env' : 'missing';

  /**
   * 将字符串值解析为布尔值
   * @param {string|undefined} val - 要解析的值
   * @param {boolean} defaultVal - 当值为空时的默认返回值
   * @returns {boolean} 解析后的布尔值
   */
  function parseBool(val, defaultVal, key) {
    if (val === undefined || val === '') return defaultVal;
    const s = String(val).toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no') return false;
    if (key) throw createConfigError(key, 'must be boolean');
    return false;
  }

  function parseClaudePermissionMode(val) {
    const text = val === undefined ? '' : String(val).trim();
    if (!text || text === 'default') return '';
    return text;
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
    claudeCmd: env.CLAUDE_CMD || 'claude',
    claudeModel: env.CLAUDE_MODEL || '',
    claudeFallbackModel: env.CLAUDE_FALLBACK_MODEL || '',
    claudeAgent: env.CLAUDE_AGENT || '',
    claudePermissionMode: parseClaudePermissionMode(env.CLAUDE_PERMISSION_MODE),
    claudePermissionModeMigrated: env.CLAUDE_PERMISSION_MODE === 'default',
    claudeAllowedTools: env.CLAUDE_ALLOWED_TOOLS || '',
    claudeDisallowedTools: env.CLAUDE_DISALLOWED_TOOLS || '',
    claudeConfigDir: env.CLAUDE_CONFIG_DIR || '',
    claudeTools: parseListValue('CLAUDE_TOOLS', env.CLAUDE_TOOLS, []),
    claudeAgents: parseJsonObjectValue('CLAUDE_AGENTS', env.CLAUDE_AGENTS, {}),
    claudeMcpConfigs: parseListValue('CLAUDE_MCP_CONFIGS', env.CLAUDE_MCP_CONFIGS, []),
    claudeStrictMcpConfig: parseBool(env.CLAUDE_STRICT_MCP_CONFIG, false, 'CLAUDE_STRICT_MCP_CONFIG'),
    claudeSettingsFile: env.CLAUDE_SETTINGS_FILE || '',
    claudeSettingSources: parseListValue('CLAUDE_SETTING_SOURCES', env.CLAUDE_SETTING_SOURCES, []),
    claudePluginDirs: parseListValue('CLAUDE_PLUGIN_DIRS', env.CLAUDE_PLUGIN_DIRS, []),
    claudeBare: parseBool(env.CLAUDE_BARE, false, 'CLAUDE_BARE'),
    claudeSafeMode: parseBool(env.CLAUDE_SAFE_MODE, false, 'CLAUDE_SAFE_MODE'),
    claudeDisableSlashCommands: parseBool(env.CLAUDE_DISABLE_SLASH_COMMANDS, false, 'CLAUDE_DISABLE_SLASH_COMMANDS'),
    claudeAllowBypassPermissions: parseBool(env.CLAUDE_ALLOW_BYPASS_PERMISSIONS, false, 'CLAUDE_ALLOW_BYPASS_PERMISSIONS'),
    claudePromptTimeoutMs: parsePositiveInt(env.CLAUDE_PROMPT_TIMEOUT_MS, 120000),
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
