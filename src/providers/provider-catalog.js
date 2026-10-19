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
