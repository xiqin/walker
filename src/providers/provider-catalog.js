'use strict';

const PROVIDERS = [
  {
    id: 'opencode',
    label: 'OpenCode',
    driver: 'opencode',
    executableCandidates: ['opencode'],
    versionCommand: { args: ['--version'] },
    healthCheck: { type: 'driver' },
    capabilities: { sessions: true, tui: true, http: true, models: true, permissions: true, questionReply: true },
    capabilityStatus: {
      sessions: { status: 'supported', reason: 'OpenCode driver supports session lifecycle' },
      tui: { status: 'supported', reason: 'OpenCode TUI bridge is available' },
      http: { status: 'supported', reason: 'OpenCode HTTP server integration is available' },
      models: { status: 'supported', reason: 'OpenCode model catalog can be queried' },
      permissions: { status: 'supported', reason: 'OpenCode permission events support allow/ask/deny handling' },
      questionReply: { status: 'supported', reason: 'OpenCode question replies are supported' },
    },
    configKeys: ['OPENCODE_CMD', 'OPENCODE_SERVER_URL', 'OPENCODE_SERVER_AUTOSTART', 'OPENCODE_CONFIG_DIR'],
  },
  {
    id: 'claude',
    label: 'Claude Code',
    driver: 'claude',
    executableCandidates: ['claude'],
    versionCommand: { args: ['--version'] },
    healthCheck: { type: 'command' },
    capabilities: { sessions: true, tui: true, http: false, models: true, permissions: false, window: true, questionReply: true },
    capabilityStatus: {
      sessions: { status: 'supported', reason: 'Claude CLI driver supports session lifecycle through TUI/PTY' },
      tui: { status: 'supported', reason: 'Claude runs through native terminal/TUI integration' },
      http: { status: 'unsupported', reason: 'Claude Code does not expose an OpenCode-compatible HTTP API' },
      models: { status: 'supported', reason: 'Model and fallback model can be configured for Claude CLI' },
      permissions: { status: 'degraded', reason: 'Claude native tools and permission modes are not isomorphic with OpenCode allow/ask/deny rules' },
      window: { status: 'supported', reason: 'Claude TUI window attach is available' },
      questionReply: { status: 'degraded', reason: 'Claude question replies are delivered as controlled TUI input because Claude Code does not expose an OpenCode-compatible reply API' },
    },
    configKeys: [
      'CLAUDE_CMD',
      'CLAUDE_MODEL',
      'CLAUDE_FALLBACK_MODEL',
      'CLAUDE_AGENT',
      'CLAUDE_PERMISSION_MODE',
      'CLAUDE_ALLOWED_TOOLS',
      'CLAUDE_DISALLOWED_TOOLS',
      'CLAUDE_CONFIG_DIR',
      'CLAUDE_TOOLS',
      'CLAUDE_AGENTS',
      'CLAUDE_MCP_CONFIGS',
      'CLAUDE_STRICT_MCP_CONFIG',
      'CLAUDE_SETTINGS_FILE',
      'CLAUDE_SETTING_SOURCES',
      'CLAUDE_PLUGIN_DIRS',
      'CLAUDE_BARE',
      'CLAUDE_SAFE_MODE',
      'CLAUDE_DISABLE_SLASH_COMMANDS',
      'CLAUDE_ALLOW_BYPASS_PERMISSIONS',
      'CLAUDE_PROMPT_TIMEOUT_MS',
    ],
  },
  {
    id: 'codex',
    label: 'Codex CLI',
    driver: 'codex',
    executableCandidates: ['codex'],
    versionCommand: { args: ['--version'] },
    healthCheck: { type: 'command' },
    capabilities: { sessions: true, tui: true, http: false, models: false, permissions: false, questionReply: false },
    capabilityStatus: {
      sessions: { status: 'supported', reason: 'Codex CLI session stub is available' },
      tui: { status: 'supported', reason: 'Codex can be launched as a CLI process' },
      http: { status: 'unsupported', reason: 'Codex HTTP integration is not implemented' },
      models: { status: 'unsupported', reason: 'Codex model catalog is not implemented' },
      permissions: { status: 'unsupported', reason: 'Codex permission handling is not implemented' },
      questionReply: { status: 'unsupported', reason: 'Codex question reply handling is not implemented' },
    },
    configKeys: ['CODEX_HOME'],
  },
  {
    id: 'shell',
    label: 'Shell',
    driver: 'shell',
    executableCandidates: [],
    versionCommand: null,
    healthCheck: { type: 'builtin' },
    capabilities: { sessions: false, tui: true, http: false, models: false, permissions: false, questionReply: false, commands: true },
    capabilityStatus: {
      sessions: { status: 'unsupported', reason: 'Shell provider does not manage agent sessions' },
      tui: { status: 'supported', reason: 'Shell can run in a terminal' },
      http: { status: 'unsupported', reason: 'Shell provider has no HTTP API' },
      models: { status: 'unsupported', reason: 'Shell provider has no model catalog' },
      permissions: { status: 'unsupported', reason: 'Shell provider has no permission protocol' },
      questionReply: { status: 'unsupported', reason: 'Shell provider has no question reply protocol' },
      commands: { status: 'supported', reason: 'Shell command execution is the primary capability' },
    },
    configKeys: ['SHELL', 'COMSPEC'],
  },
];

/**
 * 复制 provider 元信息，避免调用方修改静态 catalog。
 * @param {Object} provider - provider 元信息。
 * @returns {Object} provider 元信息副本。
 */
function cloneProvider(provider) {
  return {
    ...provider,
    executableCandidates: provider.executableCandidates.slice(),
    versionCommand: provider.versionCommand ? { ...provider.versionCommand, args: provider.versionCommand.args.slice() } : null,
    healthCheck: { ...provider.healthCheck },
    capabilities: { ...provider.capabilities },
    capabilityStatus: Object.fromEntries(Object.entries(provider.capabilityStatus || {}).map(([key, value]) => [key, { ...value }])),
    configKeys: provider.configKeys.slice(),
  };
}

/**
 * 列出 Walker 支持的 provider catalog。
 * @returns {Object[]} provider 元信息列表。
 */
function listProviderCatalog() {
  return PROVIDERS.map(cloneProvider);
}

/**
 * 根据 id 查询 provider 元信息。
 * @param {string} id - provider id。
 * @returns {Object|null} provider 元信息，不存在返回 null。
 */
function getProviderCatalog(id) {
  const provider = PROVIDERS.find((item) => item.id === id);
  return provider ? cloneProvider(provider) : null;
}

module.exports = { listProviderCatalog, getProviderCatalog };
