'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('wsl-runtime');

class WslRuntime {
  constructor(options) {
    if (!options.distro) {
      throw new Error('WslRuntime requires distro configuration');
    }
    this.distro = options.distro;
    this._spawn = options.spawn || require('child_process').spawn;
    this.exec = options.exec || function defaultExec(cmd, args) {
      return new Promise((resolve, reject) => {
        const { execFile } = require('child_process');
        execFile(cmd, args || [], (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
        });
      });
    };
  }

  spawn(command, args, options) {
    const wslArgs = ['-d', this.distro, '--', command, ...args];
    const opts = { ...options };
    logger.info('wsl spawn', { distro: this.distro, command, args });
    return this._spawn('wsl.exe', wslArgs, opts);
  }

  async resolveServerUrl({ configuredUrl, port }) {
    if (configuredUrl) {
      logger.info('wsl use configured url', { url: configuredUrl });
      return configuredUrl;
    }

    const actualPort = port || 4096;
    try {
      const output = await this.exec('wsl.exe', ['-d', this.distro, '--', 'hostname', '-I']);
      const ip = output.trim().split(/\s+/)[0];
      if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
        throw new Error('WSL IP not found in hostname output: ' + output);
      }
      const url = 'http://' + ip + ':' + actualPort;
      logger.info('wsl detected server url', { url });
      return url;
    } catch (err) {
      throw new Error('Failed to detect WSL runtime server URL: ' + err.message);
    }
  }
}

module.exports = { WslRuntime };
