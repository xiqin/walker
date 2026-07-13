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
    logger.info('hook plugin already exists, skip install', { path: targetPath });
    return { installed: false, reason: 'already_exists', path: targetPath };
  }

  try {
    if (!fs.existsSync(pluginsDir)) {
      fs.mkdirSync(pluginsDir, { recursive: true });
    }
    const walkerPort = opts.walkerPort || 8787;
    const source = getPluginSource(walkerPort);
    fs.writeFileSync(targetPath, source, 'utf8');
    logger.info('hook plugin installed', { path: targetPath, walkerPort });
    return { installed: true, path: targetPath };
  } catch (err) {
    logger.error('hook plugin install failed', { err });
    return { installed: false, reason: 'error', error: err.message, path: targetPath };
  }
}

module.exports = { installHookPlugin, getPluginSource };
