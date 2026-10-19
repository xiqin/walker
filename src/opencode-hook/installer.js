'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL, fileURLToPath } = require('url');
const { createLogger } = require('../core/logger');
const { getPluginSource, getV2PluginEntrySource, getV1PluginEntrySource, getV2PackageManifest } = require('./plugin-template');

const logger = createLogger('hook-installer');
const PLUGIN_PACKAGE_DIR = 'walker-tui-plugin';
const PLUGIN_ENTRY_FILENAME = 'tui.js';
const LEGACY_V2_FILENAME = 'walker-tui-plugin.js';
const BRIDGE_FILENAME = 'walker-tui-bridge.js';
const V1_PLUGIN_FILENAME = 'walker-tui-plugin-v1.js';
const LEGACY_PLUGIN_FILENAME = 'walker-hook.js';
const LEGACY_MARKER = 'Walker auto-attach hook plugin';
const BRIDGE_MARKER = 'Walker TUI bridge';
const CLI_SCHEMA = 'https://opencode.ai/v2/cli.json';

function installHookPlugin(options) {
  const opts = options || {};
  const secrets = collectSecrets(opts);
  if (opts.enabled === false) {
    logger.info('TUI bridge plugin install skipped: disabled');
    return { installed: false, reason: 'disabled' };
  }

  const configDir = resolveConfigDir(opts);
  const bridgePath = path.join(configDir, BRIDGE_FILENAME);
  const pluginDir = path.join(configDir, PLUGIN_PACKAGE_DIR);
  const v2Path = path.join(pluginDir, PLUGIN_ENTRY_FILENAME);
  const packagePath = path.join(pluginDir, 'package.json');
  const v1Path = path.join(configDir, V1_PLUGIN_FILENAME);
  const legacyV2Path = path.join(configDir, LEGACY_V2_FILENAME);
  const configPath = path.join(configDir, 'cli.json');
  const legacyTuiPath = path.join(configDir, 'tui.json');
  const legacyPath = path.join(configDir, 'plugins', LEGACY_PLUGIN_FILENAME);
  // V2 CLI 把包目录解析为 tui.js；裸 JS 文件 URL 不会执行。
  const v2Url = pathToFileURL(pluginDir).href;
  const v1Url = pathToFileURL(v1Path).href;
  const walkerUrls = [v2Url, v1Url];

  const parsed = readJsonObject(configPath);
  if (parsed.invalid) {
    const message = redact(parsed.error ? parsed.error.message : 'invalid cli.json', secrets);
    logger.error('failed to parse existing cli.json; refusing to overwrite it', { path: configPath, error: message });
    return failure(message, v2Path);
  }
  if (parsed.exists && Object.prototype.hasOwnProperty.call(parsed.value, 'plugins') && !Array.isArray(parsed.value.plugins)) {
    const received = parsed.value.plugins === null ? 'null' : typeof parsed.value.plugins;
    const message = 'cli.json plugins must be an array, received ' + received;
    logger.error('refusing to overwrite non-array cli.json plugins', { path: configPath, error: message });
    return failure(message, v2Path);
  }

  const cliConfig = Object.assign({}, parsed.value);
  if (!cliConfig.$schema) cliConfig.$schema = CLI_SCHEMA;
  const previousPlugins = Array.isArray(parsed.value.plugins) ? parsed.value.plugins.slice() : [];
  const nextPlugins = previousPlugins.filter((entry) => !isWalkerOwned(entry, walkerUrls)).concat([v2Url]);
  cliConfig.plugins = nextPlugins;
  const nextConfigText = JSON.stringify(cliConfig, null, 2) + '\n';
  const configChanged = !parsed.exists || nextConfigText !== parsed.rawText;

  const tuiParsed = readJsonObject(legacyTuiPath);
  let nextTuiText = null;
  let tuiChanged = false;
  if (tuiParsed.exists && !tuiParsed.invalid) {
    const migrated = migrateTuiConfig(tuiParsed.value, v1Url, walkerUrls);
    if (migrated.changed) {
      nextTuiText = JSON.stringify(migrated.value, null, 2) + '\n';
      tuiChanged = nextTuiText !== tuiParsed.rawText;
    }
  }

  const bridgeSource = getPluginSource(opts.walkerPort || 8787, opts.walkerToken || '', opts.heartbeatIntervalMs);
  const v2Source = getV2PluginEntrySource('../walker-tui-bridge.js');
  const v1Source = getV1PluginEntrySource();
  const packageSource = getV2PackageManifest();
  const writes = [];
  if (!fileMatches(bridgePath, bridgeSource)) writes.push({ path: bridgePath, content: bridgeSource });
  if (!fileMatches(v2Path, v2Source)) writes.push({ path: v2Path, content: v2Source });
  if (!fileMatches(packagePath, packageSource)) writes.push({ path: packagePath, content: packageSource });
  if (!fileMatches(v1Path, v1Source)) writes.push({ path: v1Path, content: v1Source });
  if (configChanged) writes.push({ path: configPath, content: nextConfigText });
  if (tuiChanged) writes.push({ path: legacyTuiPath, content: nextTuiText });

  if (!writes.length) {
    removeStaleV2File(legacyV2Path, secrets);
    logger.info('TUI bridge plugin already current', { path: v2Path });
    return { installed: false, reason: 'already_exists', path: v2Path };
  }

  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(pluginDir, { recursive: true });
    commitWrites(writes);
    removeLegacyPlugin(legacyPath, secrets);
    removeStaleV2File(legacyV2Path, secrets);
    logger.info('TUI bridge plugin installed', { path: v2Path, port: opts.walkerPort || 8787 });
    return { installed: true, path: v2Path };
  } catch (err) {
    const message = redact(err && err.message ? err.message : 'install failed', secrets);
    logger.error('TUI bridge plugin install failed', { path: v2Path, stage: 'rename', error: message });
    return failure(message, v2Path);
  }
}

function resolveConfigDir(opts) {
  if (opts.opencodeConfigDir) return opts.opencodeConfigDir;
  if (process.env.XDG_CONFIG_HOME) return path.join(process.env.XDG_CONFIG_HOME, 'opencode');
  return path.join(os.homedir(), '.config', 'opencode');
}

function failure(message, targetPath) {
  return { installed: false, reason: 'error', error: message, path: targetPath };
}

function collectSecrets(opts) {
  const values = [];
  function add(value) {
    if (typeof value === 'string' && value && values.indexOf(value) === -1) values.push(value);
  }
  add(opts.walkerToken);
  add(process.env.FEISHU_APP_SECRET);
  add(process.env.WALKER_ADMIN_TOKEN);
  for (const key of Object.keys(opts)) {
    if (/token|secret|password/i.test(key)) add(opts[key]);
  }
  return values;
}

function redact(text, secrets) {
  let out = String(text == null ? '' : text);
  for (const secret of secrets || []) {
    if (secret) out = out.split(secret).join('[redacted]');
  }
  return out;
}

function readJsonObject(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, value: {}, rawText: null };
  let rawText;
  try {
    rawText = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { exists: true, invalid: true, error: err, value: {}, rawText: null };
  }
  try {
    const value = JSON.parse(rawText);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { exists: true, invalid: true, error: new Error('cli.json must be a JSON object'), value: {}, rawText };
    }
    return { exists: true, value, rawText };
  } catch (err) {
    return { exists: true, invalid: true, error: err, value: {}, rawText };
  }
}

function fileMatches(filePath, content) {
  if (!fs.existsSync(filePath)) return false;
  try {
    return fs.readFileSync(filePath, 'utf8') === content;
  } catch (_) {
    return false;
  }
}

function entryValue(entry) {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object' && typeof entry.package === 'string') return entry.package;
  return '';
}

function isWalkerGenerated(content) {
  if (content.includes(BRIDGE_MARKER) || content.includes(LEGACY_MARKER)) return true;
  return content.includes("from '@opencode/plugin/tui'")
    && content.includes('Plugin.define')
    && content.includes("id: 'walker-tui-bridge'")
    && content.includes('walker-tui-bridge.js');
}

function isWalkerOwned(entry, walkerUrls) {
  const value = entryValue(entry);
  if (!value) return false;
  if (walkerUrls.indexOf(value) !== -1) return true;
  const filePath = entryFilePath(value);
  if (!filePath || !fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  const candidate = stat.isDirectory() ? path.join(filePath, PLUGIN_ENTRY_FILENAME) : filePath;
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return false;
  try {
    return isWalkerGenerated(fs.readFileSync(candidate, 'utf8'));
  } catch (_) {
    return false;
  }
}

function removeStaleV2File(filePath, secrets) {
  if (!fs.existsSync(filePath)) return;
  try {
    if (!fs.statSync(filePath).isFile()) return;
    if (!isWalkerGenerated(fs.readFileSync(filePath, 'utf8'))) return;
    fs.unlinkSync(filePath);
  } catch (err) {
    logger.warn('failed to remove stale V2 plugin file', {
      path: filePath,
      error: redact(err && err.message, secrets),
    });
  }
}

function entryFilePath(value) {
  if (value.startsWith('file:')) {
    try {
      return fileURLToPath(value);
    } catch (_) {
      return '';
    }
  }
  if (path.isAbsolute(value)) return value;
  return '';
}

function migrateTuiConfig(config, v1Url, walkerUrls) {
  const next = Object.assign({}, config);
  let changed = false;
  for (const key of ['plugin', 'plugins']) {
    if (!Array.isArray(config[key])) continue;
    let sawWalker = false;
    const kept = [];
    for (const entry of config[key]) {
      if (isWalkerOwned(entry, walkerUrls)) {
        sawWalker = true;
        changed = true;
        continue;
      }
      kept.push(entry);
    }
    if (!sawWalker) continue;
    if (!kept.some((entry) => entryValue(entry) === v1Url)) kept.push(v1Url);
    next[key] = kept;
  }
  return { changed, value: next };
}

function commitWrites(writes) {
  const done = [];
  try {
    for (const write of writes) {
      const previous = fs.existsSync(write.path) ? fs.readFileSync(write.path) : null;
      writeAtomic(write.path, write.content);
      done.push({ path: write.path, previous });
    }
  } catch (err) {
    for (const item of done.reverse()) {
      try {
        if (item.previous == null) fs.unlinkSync(item.path);
        else fs.writeFileSync(item.path, item.previous);
      } catch (_) {}
    }
    throw err;
  }
}

function writeAtomic(targetPath, content) {
  const tempPath = path.join(
    path.dirname(targetPath),
    '.' + path.basename(targetPath) + '.' + process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2) + '.tmp',
  );
  fs.writeFileSync(tempPath, content, 'utf8');
  const backupPath = tempPath + '.bak';
  let backedUp = false;
  try {
    if (fs.existsSync(targetPath)) {
      fs.renameSync(targetPath, backupPath);
      backedUp = true;
    }
    fs.renameSync(tempPath, targetPath);
    if (backedUp) fs.unlinkSync(backupPath);
  } catch (err) {
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (_) {}
    }
    if (backedUp && !fs.existsSync(targetPath) && fs.existsSync(backupPath)) {
      try { fs.renameSync(backupPath, targetPath); } catch (_) {}
    }
    throw err;
  }
}

function removeLegacyPlugin(legacyPath, secrets) {
  if (!fs.existsSync(legacyPath)) return;
  try {
    const existing = fs.readFileSync(legacyPath, 'utf8');
    if (!existing.includes(LEGACY_MARKER) && !existing.includes(BRIDGE_MARKER)) return;
    fs.unlinkSync(legacyPath);
    logger.info('removed legacy Walker server hook', { path: legacyPath });
  } catch (err) {
    logger.warn('failed to remove legacy Walker server hook', {
      path: legacyPath,
      error: redact(err && err.message, secrets),
    });
  }
}

module.exports = { installHookPlugin, getPluginSource };
