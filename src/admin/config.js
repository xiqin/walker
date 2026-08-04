const EDITABLE_ENV_KEYS = Object.freeze([
  'WALKER_ADMIN_ENABLED',
  'WALKER_ADMIN_HOST',
  'WALKER_ADMIN_PORT',
  'WALKER_DEFAULT_AGENT',
  'WALKER_DEFAULT_RUNTIME',
  'WALKER_DEFAULT_CWD',
  'WALKER_DATA_DIR',
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
  'CLAUDE_CMD',
  'CLAUDE_MODEL',
  'CLAUDE_FALLBACK_MODEL',
  'CLAUDE_AGENT',
  'CLAUDE_PERMISSION_MODE',
  'CLAUDE_ALLOWED_TOOLS',
  'CLAUDE_DISALLOWED_TOOLS',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_PROMPT_TIMEOUT_MS',
  'OPENCODE_PROMPT_REQUEST_TIMEOUT_MS',
  'OPENCODE_SSE_IDLE_TIMEOUT_MS',
  'OPENCODE_SSE_OPEN_TIMEOUT_MS',
  'OPENCODE_RECOVERY_WINDOW_MS',
  'WALKER_OPENCODE_HOOK_ENABLED',
  'WALKER_PROMPT_HEARTBEAT_INITIAL_MS',
  'WALKER_PROMPT_HEARTBEAT_INTERVAL_MS',
  'WALKER_PROMPT_HEARTBEAT_STUCK_MS',
  'WALKER_MAX_TURN_TIME_MINS',
  'OPENCODE_TUI_LEASE_TIMEOUT_MS',
  'OPENCODE_TUI_HEARTBEAT_INTERVAL_MS',
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
  { id: 'claude', label: 'Claude' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'timeout-recovery', label: '超时恢复' },
]);

const CONFIG_DEFINITIONS = Object.freeze([
  { env: 'WALKER_ADMIN_ENABLED', label: '启用 Admin', group: 'admin', defaultValue: 'true', type: 'boolean', input: { type: 'boolean', values: ['true', 'false'] } },
  { env: 'WALKER_ADMIN_HOST', label: '监听地址', group: 'admin', defaultValue: '127.0.0.1', type: 'host', input: { type: 'text', required: true, pattern: '^[^\\s/\\\\]+$' } },
  { env: 'WALKER_ADMIN_PORT', label: '监听端口', group: 'admin', defaultValue: '8787', type: 'port', input: { type: 'number', integer: true, min: 1, max: 65535 } },
  { env: 'WALKER_ADMIN_TOKEN', label: 'Admin Token', group: 'admin', defaultValue: '', secret: true },
  { env: 'WALKER_OPENCODE_HOOK_ENABLED', label: '启用 Hook', group: 'admin', defaultValue: 'true', type: 'boolean', input: { type: 'boolean', values: ['true', 'false'] }, display: 'switch', description: '关闭后退回手动 /attach 模式' },
  { env: 'WALKER_DEFAULT_AGENT', label: '默认 Agent', group: 'walker', defaultValue: 'opencode', type: 'non-empty', input: { type: 'text', required: true, trim: true, minLength: 1 } },
  { env: 'WALKER_DATA_DIR', label: '数据存储目录', group: 'walker', defaultValue: '~/.walker', type: 'string', input: { type: 'text' } },
  { env: 'WALKER_DEFAULT_RUNTIME', label: '默认 Runtime', group: 'runtime', defaultValue: 'windows', type: 'runtime', input: { type: 'enum', values: ['windows', 'wsl'] } },
  { env: 'WALKER_DEFAULT_CWD', label: '默认工作目录', group: 'runtime', defaultValue: '', type: 'string', input: { type: 'text' } },
  { env: 'WALKER_WSL_DISTRO', label: 'WSL 发行版', group: 'runtime', defaultValue: 'Ubuntu-24.04', type: 'non-empty', input: { type: 'text', required: true, trim: true, minLength: 1 } },
  { env: 'FEISHU_APP_ID', label: '飞书 App ID', group: 'feishu', defaultValue: '', readOnly: true },
  { env: 'FEISHU_APP_SECRET', label: '飞书 App Secret', group: 'feishu', defaultValue: '', secret: true },
  { env: 'FEISHU_ROUTE_MODE', label: '飞书路由模式', group: 'feishu', defaultValue: 'thread', type: 'route-mode', input: { type: 'enum', values: ['thread', 'user', 'channel'], labels: { thread: 'thread（按消息线程）', user: 'user（按用户）', channel: 'channel（按群）' } } },
  { env: 'FEISHU_PROGRESS_STYLE', label: '进度样式', group: 'feishu', defaultValue: 'card', type: 'progress-style', input: { type: 'enum', values: ['card', 'legacy'], labels: { card: 'card（结构化卡片）', legacy: 'legacy（逐条文本）' } } },
  { env: 'FEISHU_REACTION_EMOJI', label: '收到消息表情', group: 'feishu', defaultValue: 'OnIt', type: 'string', input: { type: 'text' } },
  { env: 'FEISHU_DONE_EMOJI', label: '完成表情', group: 'feishu', defaultValue: 'none', type: 'string', input: { type: 'text' } },
  { env: 'OPENCODE_SERVER_URL', label: 'Server URL', group: 'opencode', defaultValue: '', type: 'url', input: { type: 'url', protocols: ['http:', 'https:'], allowEmpty: true } },
  { env: 'OPENCODE_CMD', label: 'CLI 命令名', group: 'opencode', defaultValue: 'opencode', type: 'non-empty', input: { type: 'text', required: true, trim: true, minLength: 1 } },
  { env: 'OPENCODE_MODEL', label: '指定模型', group: 'opencode', defaultValue: '', type: 'string', input: { type: 'text', placeholder: '留空使用 opencode 默认' } },
  { env: 'OPENCODE_AGENT', label: '指定 Agent', group: 'opencode', defaultValue: '', type: 'string', input: { type: 'text', placeholder: '留空使用 opencode 默认' } },
  { env: 'CLAUDE_CMD', label: 'CLI 命令名', group: 'claude', defaultValue: 'claude', type: 'non-empty', input: { type: 'text', required: true, trim: true, minLength: 1 } },
  { env: 'CLAUDE_MODEL', label: '指定模型', group: 'claude', defaultValue: '', type: 'string', input: { type: 'text', placeholder: '留空使用 Claude 默认' } },
  { env: 'CLAUDE_FALLBACK_MODEL', label: 'Fallback 模型', group: 'claude', defaultValue: '', type: 'string', input: { type: 'text', placeholder: '留空不指定 fallback' } },
  { env: 'CLAUDE_AGENT', label: '指定 Agent', group: 'claude', defaultValue: '', type: 'string', input: { type: 'text', placeholder: '留空使用 Claude 默认' } },
  { env: 'CLAUDE_PERMISSION_MODE', label: '权限模式', group: 'claude', defaultValue: 'default', type: 'claude-permission-mode', input: { type: 'enum', values: ['default', 'acceptEdits', 'auto', 'dontAsk', 'plan'] }, description: '默认不允许 bypassPermissions 或危险跳过权限参数' },
  { env: 'CLAUDE_ALLOWED_TOOLS', label: '允许工具', group: 'claude', defaultValue: '', type: 'string', input: { type: 'text', placeholder: '逗号分隔，如 Read,Grep' } },
  { env: 'CLAUDE_DISALLOWED_TOOLS', label: '禁用工具', group: 'claude', defaultValue: '', type: 'string', input: { type: 'text', placeholder: '逗号分隔，如 Bash' } },
  { env: 'CLAUDE_CONFIG_DIR', label: '配置目录', group: 'claude', defaultValue: '', type: 'string', input: { type: 'text' } },
  { env: 'CLAUDE_PROMPT_TIMEOUT_MS', label: 'Prompt 超时(ms)', group: 'claude', defaultValue: '120000', type: 'positive-int', input: { type: 'number', integer: true, min: 1 } },
  { env: 'OPENCODE_PROMPT_REQUEST_TIMEOUT_MS', label: 'Prompt 提交超时(ms)', group: 'opencode', defaultValue: '30000', type: 'positive-int', input: { type: 'number', integer: true, min: 1 } },
  { env: 'OPENCODE_SSE_IDLE_TIMEOUT_MS', label: 'SSE 空闲超时(ms)', group: 'opencode', defaultValue: '300000', type: 'positive-int', input: { type: 'number', integer: true, min: 1 } },
  { env: 'OPENCODE_SSE_OPEN_TIMEOUT_MS', label: 'SSE 建连超时(ms)', group: 'opencode', defaultValue: '1000', type: 'positive-int', input: { type: 'number', integer: true, min: 1 } },
  { env: 'OPENCODE_RECOVERY_WINDOW_MS', label: 'Polling 恢复窗口(ms)', group: 'opencode', defaultValue: '300000', type: 'positive-int', input: { type: 'number', integer: true, min: 1 } },
  { env: 'OPENCODE_SERVER_AUTOSTART', label: '未启动时自动启动 OpenCode', group: 'opencode', defaultValue: 'true', type: 'boolean', input: { type: 'boolean', values: ['true', 'false'] }, display: 'switch' },
  { env: 'WALKER_PROMPT_HEARTBEAT_INITIAL_MS', label: '心跳首次触发(ms)', group: 'timeout-recovery', defaultValue: '30000', type: 'positive-int', input: { type: 'number', integer: true, min: 1 } },
  { env: 'WALKER_PROMPT_HEARTBEAT_INTERVAL_MS', label: '心跳重复间隔(ms)', group: 'timeout-recovery', defaultValue: '60000', type: 'positive-int', input: { type: 'number', integer: true, min: 1 } },
  { env: 'WALKER_PROMPT_HEARTBEAT_STUCK_MS', label: '卡住提示阈值(ms)', group: 'timeout-recovery', defaultValue: '300000', type: 'positive-int', input: { type: 'number', integer: true, min: 1 } },
  { env: 'WALKER_MAX_TURN_TIME_MINS', label: '单轮硬超时(分钟)', group: 'timeout-recovery', defaultValue: '0', type: 'non-negative-int', input: { type: 'number', integer: true, min: 0 }, hint: '0 关闭；>0 超时自动取消该 turn' },
  { env: 'OPENCODE_TUI_LEASE_TIMEOUT_MS', label: 'TUI 租约超时(ms)', group: 'timeout-recovery', defaultValue: '90000', type: 'positive-int', input: { type: 'number', integer: true, min: 1 } },
  { env: 'OPENCODE_TUI_HEARTBEAT_INTERVAL_MS', label: 'TUI 心跳上报间隔(ms)', group: 'timeout-recovery', defaultValue: '30000', type: 'positive-int', input: { type: 'number', integer: true, min: 1 } },
  { env: 'WALKER_OPENCODE_HEALTH_POLL_INTERVAL_MS', label: '健康轮询间隔(ms)', group: 'timeout-recovery', defaultValue: '5000', type: 'positive-int', input: { type: 'number', integer: true, min: 1 } },
  { env: 'WALKER_OPENCODE_EXIT_ACTION', label: '退出动作', group: 'timeout-recovery', defaultValue: 'cancel', type: 'exit-action', input: { type: 'enum', values: ['cancel', 'stop', 'none'], labels: { cancel: 'cancel（取消 turn 并移出 route）', none: 'none（仅记录 detached）' } } },
  { env: 'WALKER_OPENCODE_NON_FOCUS_OUTPUT', label: '非焦点 session 输出回群', group: 'timeout-recovery', defaultValue: 'true', type: 'boolean', input: { type: 'boolean', values: ['true', 'false'] }, display: 'switch' },
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
    ...(definition.display ? { display: definition.display } : {}),
    ...(definition.description ? { description: definition.description } : {}),
    ...(definition.hint ? { hint: definition.hint } : {}),
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
