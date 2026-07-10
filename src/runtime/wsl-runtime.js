'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('wsl-runtime');

function escapeCmdArg(value) {
  return String(value).replace(/([&|<>\^%!(\)" \t])/g, '^$1');
}

/**
 * WSL (Windows Subsystem for Linux) 运行时环境，通过 wsl.exe 在指定发行版中执行命令
 */
class WslRuntime {
  /**
   * 初始化 WSL 运行时
   * @param {Object} options - 配置选项
   * @param {string} options.distro - WSL 发行版名称，如 'Ubuntu-24.04'
   * @param {Function} [options.spawn] - 自定义 spawn 函数
   * @param {Function} [options.exec] - 自定义 exec 函数，用于同步执行命令
   */
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
    this._exec = options._exec || require('child_process').exec;
  }

  /**
   * 通过 WSL 在指定发行版中启动子进程
   * @param {string} command - 要在 WSL 中执行的命令
   * @param {string[]} args - 命令参数列表
   * @param {Object} [options] - spawn 选项
   * @returns {ChildProcess} 子进程对象
   */
  spawn(command, args, options) {
    const wslArgs = ['-d', this.distro, '--', command, ...args];
    const opts = { ...options };
    logger.info('wsl spawn', { distro: this.distro, command, args });
    return this._spawn('wsl.exe', wslArgs, opts);
  }

  /**
   * 在新的 cmd 终端窗口中通过 WSL 启动命令，用户可在终端中接手工作
   * @param {string} command - 要在 WSL 中执行的命令
   * @param {string[]} args - 命令参数列表
   * @param {Object} [options] - 选项
   * @param {string} [options.cwd] - WSL 中的工作目录
   * @param {string} [options.title] - 终端窗口标题
   * @returns {Promise<void>}
   */
  openTerminal(command, args, options) {
    const cwd = (options && options.cwd) || process.cwd();
    const title = (options && options.title) || 'Walker Session';

    const wslCmdParts = [command, ...args];
    const wslCmd = wslCmdParts.map(escapeCmdArg).join(' ');

    const cmdArgs = ['/v:off', '/k', 'wsl.exe -d ' + escapeCmdArg(this.distro) + ' -- ' + wslCmd];

    logger.info('wsl openTerminal', { distro: this.distro, command, args, title });

    try {
      const proc = this._spawn('cmd.exe', cmdArgs, { cwd, detached: true, stdio: 'ignore' });
      if (proc && proc.unref) proc.unref();
      logger.info('wsl openTerminal success');
      return Promise.resolve();
    } catch (err) {
      logger.error('wsl openTerminal failed', { error: err.message });
      return Promise.reject(err);
    }
  }

  /**
   * 解析 WSL 中 OpenCode 服务的访问地址，优先使用配置的 URL，否则自动检测 WSL IP
   * @param {Object} options - 解析选项
   * @param {string} [options.configuredUrl] - 用户配置的服务 URL
   * @param {number} [options.port=4096] - 服务端口
   * @returns {Promise<string>} 服务 URL 地址
   */
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
