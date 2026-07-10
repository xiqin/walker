'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('windows-runtime');

function escapeCmdArg(value) {
  return String(value).replace(/([&|<>\^%!(\)" \t])/g, '^$1');
}

/**
 * Windows 本地运行时环境，直接在 Windows 上启动子进程
 */
class WindowsRuntime {
  /**
   * 初始化 Windows 运行时
   * @param {Object} options - 配置选项
   * @param {Function} [options.spawn] - 自定义 spawn 函数，默认使用 child_process.spawn
   * @param {Function} [options.exec] - 自定义 exec 函数，默认使用 child_process.exec
   */
  constructor(options) {
    this._spawn = options.spawn || require('child_process').spawn;
    this._exec = options.exec || require('child_process').exec;
  }

  /**
   * 在 Windows 环境中启动子进程
   * @param {string} command - 要执行的命令
   * @param {string[]} args - 命令参数列表
   * @param {Object} [options] - spawn 选项
   * @returns {ChildProcess} 子进程对象
   */
  spawn(command, args, options) {
    const opts = { ...options };
    logger.info('windows spawn', { command, args });
    return this._spawn(command, args, opts);
  }

  /**
   * 在新的 cmd 终端窗口中启动命令，用户可在终端中接手工作
   * @param {string} command - 要执行的命令
   * @param {string[]} args - 命令参数列表
   * @param {Object} [options] - 选项
   * @param {string} [options.cwd] - 工作目录
   * @param {string} [options.title] - 终端窗口标题
   * @returns {Promise<void>}
   */
  openTerminal(command, args, options) {
    const cwd = (options && options.cwd) || process.cwd();
    const title = (options && options.title) || 'Walker Session';
    const cmdParts = [command, ...args];
    const fullCmd = cmdParts.map(escapeCmdArg).join(' ');
    const cmdArgs = ['/v:off', '/k', fullCmd];

    logger.info('windows openTerminal', { command, args, cwd, title });

    try {
      const proc = this._spawn('cmd.exe', cmdArgs, { cwd, detached: true, stdio: 'ignore' });
      if (proc && proc.unref) proc.unref();
      logger.info('openTerminal success');
      return Promise.resolve();
    } catch (err) {
      logger.error('openTerminal failed', { error: err.message });
      return Promise.reject(err);
    }
  }
};

module.exports = { WindowsRuntime };
