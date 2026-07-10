const EDITABLE_ENV_KEYS = Object.freeze([
  'WALKER_ADMIN_ENABLED',
  'WALKER_ADMIN_HOST',
  'WALKER_ADMIN_PORT',
  'WALKER_DEFAULT_AGENT',
  'WALKER_DEFAULT_RUNTIME',
  'WALKER_DEFAULT_CWD',
  'WALKER_WSL_DISTRO',
  'FEISHU_ROUTE_MODE',
  'FEISHU_PROGRESS_STYLE',
  'FEISHU_REACTION_EMOJI',
  'FEISHU_DONE_EMOJI',
  'OPENCODE_SERVER_URL',
  'OPENCODE_SERVER_AUTOSTART',
  'OPENCODE_CMD',
  'OPENCODE_MODEL',
  'OPENCODE_AGENT',
]);

const SENSITIVE_ENV_KEYS = Object.freeze([
  'FEISHU_APP_SECRET',
  'WALKER_ADMIN_TOKEN',
]);

const SUMMARY_ENV_KEYS = Object.freeze([
  'FEISHU_APP_ID',
  ...SENSITIVE_ENV_KEYS,
  ...EDITABLE_ENV_KEYS,
]);

/**
 * 判断环境键是否为敏感字段
 * @param {string} key - 环境变量名
 * @returns {boolean}
 */
function isSensitiveEnvKey(key) {
  return SENSITIVE_ENV_KEYS.includes(key);
}

/**
 * 对非空敏感值脱敏，空值返回空串
 * @param {string} value - 原始值
 * @returns {string}
 */
function maskValue(value) {
  return value ? '********' : '';
}

/**
 * 构建配置摘要：敏感字段脱敏，返回可编辑键列表和敏感键列表
 * @param {Object} [env] - 环境变量对象，默认 process.env
 * @returns {{ values: Object, editableKeys: string[], sensitiveKeys: string[] }}
 */
function buildConfigSummary(env) {
  const source = env || process.env;
  const values = {};

  for (const key of SUMMARY_ENV_KEYS) {
    const value = source[key] === undefined ? '' : String(source[key]);
    values[key] = isSensitiveEnvKey(key) ? maskValue(value) : value;
  }

  return {
    values,
    editableKeys: EDITABLE_ENV_KEYS.slice(),
    sensitiveKeys: SENSITIVE_ENV_KEYS.slice(),
  };
}

module.exports = {
  EDITABLE_ENV_KEYS,
  SENSITIVE_ENV_KEYS,
  buildConfigSummary,
  isSensitiveEnvKey,
};
