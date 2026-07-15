'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { pathToFileURL } = require('url');
const { createLogger } = require('../core/logger');
const { getPluginSource } = require('./plugin-template');

const logger = createLogger('hook-installer');
const PLUGIN_FILENAME = 'walker-tui-plugin.js';
const LEGACY_PLUGIN_FILENAME = 'walker-hook.js';
const LEGACY_MARKER = 'Walker auto-attach hook plugin';

function installHookPlugin(options) {
  const opts = options || {};
  if (opts.enabled === false) {
    logger.info('TUI bridge plugin install skipped: disabled');
    return { installed: false, reason: 'disabled' };
  }

  const configDir = opts.opencodeConfigDir || path.join(os.homedir(), '.config', 'opencode');
  const targetPath = path.join(configDir, PLUGIN_FILENAME);
  const configPath = path.join(configDir, 'tui.json');
  const legacyPath = path.join(configDir, 'plugins', LEGACY_PLUGIN_FILENAME);
  const source = getPluginSource(opts.walkerPort || 8787, opts.walkerToken || '');
  const pluginUrl = pathToFileURL(targetPath).href;

  let tuiConfig = {};
  if (fs.existsSync(configPath)) {
    try {
      tuiConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (err) {
      logger.error('failed to parse existing tui.json; refusing to overwrite it', { path: configPath, error: err.message });
      return { installed: false, reason: 'error', error: err.message, path: targetPath };
    }
  }
  if (!tuiConfig || typeof tuiConfig !== 'object' || Array.isArray(tuiConfig)) tuiConfig = {};
  const plugins = Array.isArray(tuiConfig.plugin) ? tuiConfig.plugin.slice() : [];
  const configChanged = !plugins.includes(pluginUrl);
  if (configChanged) plugins.push(pluginUrl);
  tuiConfig.plugin = plugins;

  let pluginChanged = true;
  if (fs.existsSync(targetPath)) {
    try {
      pluginChanged = fs.readFileSync(targetPath, 'utf8') !== source;
    } catch (_) {
      pluginChanged = true;
    }
  }

  try {
    fs.mkdirSync(configDir, { recursive: true });
    if (pluginChanged) fs.writeFileSync(targetPath, source, 'utf8');
    if (configChanged || !fs.existsSync(configPath)) {
      fs.writeFileSync(configPath, JSON.stringify(tuiConfig, null, 2) + '\n', 'utf8');
    }
    removeLegacyPlugin(legacyPath);
    if (!pluginChanged) {
      logger.info('TUI bridge plugin already current', { path: targetPath });
      return { installed: false, reason: 'already_exists', path: targetPath };
    }
    logger.info('TUI bridge plugin installed', { path: targetPath, port: opts.walkerPort || 8787 });
    return { installed: true, path: targetPath };
  } catch (err) {
    logger.error('TUI bridge plugin install failed', { err });
    return { installed: false, reason: 'error', error: err.message, path: targetPath };
  }
}

function removeLegacyPlugin(legacyPath) {
  if (!fs.existsSync(legacyPath)) return;
  try {
    const existing = fs.readFileSync(legacyPath, 'utf8');
    if (!existing.includes(LEGACY_MARKER)) return;
    fs.unlinkSync(legacyPath);
    logger.info('removed legacy Walker server hook', { path: legacyPath });
  } catch (err) {
    logger.warn('failed to remove legacy Walker server hook', { path: legacyPath, error: err.message });
  }
}

module.exports = { installHookPlugin, getPluginSource };
