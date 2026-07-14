'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { createLogger } = require('../core/logger');
const { getPluginSource } = require('./plugin-template');

const logger = createLogger('hook-installer');

const PLUGIN_FILENAME = 'walker-hook.js';

/**
 * 安装 hook plugin 到 opencode 全局 plugins 目录
 * @param {Object} options - 安装选项
 * @param {string} [options.opencodeConfigDir] - opencode 配置目录，默认为 ~/.config/opencode
 * @param {number} [options.walkerPort] - Walker 监听端口，默认 8787
 * @param {boolean} [options.enabled] - 是否启用安装，默认 true
 * @returns {{ installed: boolean, path?: string, reason?: string }}
 */
function installHookPlugin(options) {
  const opts = options || {};
  const enabled = opts.enabled !== false;

  if (enabled === false) {
    logger.info('hook plugin install skipped: disabled');
    return { installed: false, reason: 'disabled' };
  }

  const configDir = opts.opencodeConfigDir || path.join(os.homedir(), '.config', 'opencode');
  const pluginsDir = path.join(configDir, 'plugins');
  const targetPath = path.join(pluginsDir, PLUGIN_FILENAME);

  if (fs.existsSync(targetPath)) {
    const walkerPort = opts.walkerPort || 8787;
    try {
      const existing = fs.readFileSync(targetPath, 'utf8');
      const portMatch = existing.match(/localhost:(\d+)/);
      if (portMatch && parseInt(portMatch[1], 10) === walkerPort) {
        logger.info('hook plugin already exists, port matches, skip install', { path: targetPath, port: walkerPort });
        return { installed: false, reason: 'already_exists', path: targetPath };
      }
      logger.info('hook plugin exists but port mismatch, re-installing', { path: targetPath, oldPort: portMatch ? portMatch[1] : null, newPort: walkerPort });
    } catch (e) {
      logger.warn('hook plugin exists but failed to read, re-installing', { path: targetPath, error: e.message });
    }
  }

  try {
    if (!fs.existsSync(pluginsDir)) {
      fs.mkdirSync(pluginsDir, { recursive: true });
    }
    const walkerPort = opts.walkerPort || 8787;
    const walkerToken = opts.walkerToken || '';
    const source = getPluginSource(walkerPort, walkerToken);
    fs.writeFileSync(targetPath, source, 'utf8');
    logger.info('hook plugin installed', { path: targetPath, walkerPort });
    return { installed: true, path: targetPath };
  } catch (err) {
    logger.error('hook plugin install failed', { err });
    return { installed: false, reason: 'error', error: err.message, path: targetPath };
  }
}

module.exports = { installHookPlugin, getPluginSource };
