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
  'WALKER_OPENCODE_HOOK_ENABLED',
  'WALKER_OPENCODE_HEALTH_POLL_INTERVAL_MS',
  'WALKER_OPENCODE_EXIT_ACTION',
  'WALKER_OPENCODE_NON_FOCUS_OUTPUT',
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

const CONFIG_GROUPS = Object.freeze([
  { id: 'walker', label: 'Walker' },
  { id: 'admin', label: 'Admin' },
  { id: 'feishu', label: '飞书' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'session-route', label: 'Session Route' },
  { id: 'timeout-recovery', label: '超时恢复' },
  { id: 'ui', label: 'UI' },
]);

const CONFIG_DEFINITIONS = Object.freeze([
  { env: 'WALKER_ADMIN_ENABLED', label: '启用 Admin', group: 'admin', defaultValue: 'true', type: 'boolean', input: { type: 'boolean', values: ['true', 'false'] } },
  { env: 'WALKER_ADMIN_HOST', label: '监听地址', group: 'admin', defaultValue: '127.0.0.1', type: 'host', input: { type: 'text', required: true, pattern: '^[^\\s/\\\\]+$' } },
  { env: 'WALKER_ADMIN_PORT', label: '监听端口', group: 'admin', defaultValue: '8787', type: 'port', input: { type: 'number', integer: true, min: 1, max: 65535 } },
  { env: 'WALKER_ADMIN_TOKEN', label: 'Admin Token', group: 'admin', defaultValue: '', secret: true },
  { env: 'WALKER_DEFAULT_AGENT', label: '默认 Agent', group: 'walker', defaultValue: 'opencode', type: 'non-empty', input: { type: 'text', required: true, trim: true, minLength: 1 } },
  { env: 'WALKER_DEFAULT_RUNTIME', label: '默认 Runtime', group: 'runtime', defaultValue: 'windows', type: 'runtime', input: { type: 'enum', values: ['windows', 'wsl'] } },
  { env: 'WALKER_DEFAULT_CWD', label: '默认工作目录', group: 'runtime', defaultValue: '', type: 'string' },
  { env: 'WALKER_WSL_DISTRO', label: 'WSL 发行版', group: 'runtime', defaultValue: 'Ubuntu-24.04', type: 'non-empty', input: { type: 'text', required: true, trim: true, minLength: 1 } },
  { env: 'FEISHU_APP_ID', label: '飞书 App ID', group: 'feishu', defaultValue: '', readOnly: true },
  { env: 'FEISHU_APP_SECRET', label: '飞书 App Secret', group: 'feishu', defaultValue: '', secret: true },
  { env: 'FEISHU_ROUTE_MODE', label: '飞书路由模式', group: 'session-route', defaultValue: 'thread', type: 'route-mode', input: { type: 'enum', values: ['thread', 'chat'] } },
  { env: 'FEISHU_PROGRESS_STYLE', label: '进度样式', group: 'ui', defaultValue: 'card', type: 'progress-style', input: { type: 'enum', values: ['card', 'reaction', 'none'] } },
  { env: 'FEISHU_REACTION_EMOJI', label: '处理中表情', group: 'ui', defaultValue: 'OnIt', type: 'string' },
  { env: 'FEISHU_DONE_EMOJI', label: '完成表情', group: 'ui', defaultValue: '', type: 'string' },
  { env: 'OPENCODE_SERVER_URL', label: '服务地址', group: 'opencode', defaultValue: '', type: 'url', input: { type: 'url', protocols: ['http:', 'https:'], allowEmpty: true } },
  { env: 'OPENCODE_SERVER_AUTOSTART', label: '自动启动服务', group: 'opencode', defaultValue: 'true', type: 'boolean', input: { type: 'boolean', values: ['true', 'false'] } },
  { env: 'OPENCODE_CMD', label: '启动命令', group: 'opencode', defaultValue: 'opencode', type: 'non-empty', input: { type: 'text', required: true, trim: true, minLength: 1 } },
  { env: 'OPENCODE_MODEL', label: '默认模型', group: 'opencode', defaultValue: '', type: 'string' },
  { env: 'OPENCODE_AGENT', label: 'OpenCode Agent', group: 'opencode', defaultValue: '', type: 'string' },
  { env: 'WALKER_OPENCODE_HOOK_ENABLED', label: '启用 Hook', group: 'opencode', defaultValue: 'true', type: 'boolean', input: { type: 'boolean', values: ['true', 'false'] } },
  { env: 'WALKER_OPENCODE_HEALTH_POLL_INTERVAL_MS', label: '健康轮询间隔', group: 'timeout-recovery', defaultValue: '5000', type: 'positive-int', input: { type: 'number', integer: true, min: 1 } },
  { env: 'WALKER_OPENCODE_EXIT_ACTION', label: '退出恢复动作', group: 'timeout-recovery', defaultValue: 'cancel', type: 'exit-action', input: { type: 'enum', values: ['cancel', 'stop', 'none'] } },
  { env: 'WALKER_OPENCODE_NON_FOCUS_OUTPUT', label: '显示非焦点输出', group: 'session-route', defaultValue: 'true', type: 'boolean', input: { type: 'boolean', values: ['true', 'false'] } },
]);

const CONFIG_DEFINITION_BY_KEY = new Map(CONFIG_DEFINITIONS.map((definition) => [definition.env, definition]));

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
 * 将配置定义和值转换为安全 DTO。
 * @param {Object} definition - 配置定义。
 * @param {Object} source - 环境变量对象。
 * @returns {Object} 配置项 DTO。
 */
function buildConfigItem(definition, source) {
  const configured = source[definition.env] !== undefined && String(source[definition.env]) !== '';
  const common = {
    env: definition.env,
    label: definition.label,
    source: configured ? 'environment' : 'default',
    restartRequired: true,
    editable: !definition.readOnly && !definition.secret,
    secret: Boolean(definition.secret),
  };
  if (definition.secret) return { ...common, configured, masked: configured ? '********' : '' };
  return {
    ...common,
    defaultValue: definition.defaultValue,
    value: configured ? String(source[definition.env]) : definition.defaultValue,
    ...(definition.input ? { input: definition.input } : {}),
  };
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
    groups: CONFIG_GROUPS.map((group) => ({
      ...group,
      items: CONFIG_DEFINITIONS
        .filter((definition) => definition.group === group.id)
        .map((definition) => buildConfigItem(definition, source)),
    })),
  };
}

module.exports = {
  EDITABLE_ENV_KEYS,
  SENSITIVE_ENV_KEYS,
  CONFIG_GROUPS,
  CONFIG_DEFINITIONS,
  CONFIG_DEFINITION_BY_KEY,
  buildConfigSummary,
  isSensitiveEnvKey,
};
