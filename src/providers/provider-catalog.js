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
    configKeys: ['OPENCODE_CMD', 'OPENCODE_SERVER_URL', 'OPENCODE_SERVER_AUTOSTART', 'OPENCODE_CONFIG_DIR'],
  },
  {
    id: 'claude',
    label: 'Claude Code',
    driver: 'claude',
    executableCandidates: ['claude'],
    versionCommand: { args: ['--version'] },
    healthCheck: { type: 'command' },
    capabilities: { sessions: true, tui: true, http: false, models: true, permissions: false, questionReply: false, window: true },
    capabilityStatus: {
      permissions: { status: 'degraded', reason: 'Claude Code PTY attach can surface permission prompts but cannot safely reply through stdin.' },
      questionReply: { status: 'unsupported', reason: 'Claude Code does not expose a stable external question reply API.' },
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
    ...(provider.capabilityStatus ? { capabilityStatus: Object.fromEntries(Object.entries(provider.capabilityStatus).map(([key, value]) => [key, { ...value }])) } : {}),
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
