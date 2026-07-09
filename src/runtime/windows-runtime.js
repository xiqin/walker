'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('windows-runtime');

/**
 * Windows 本地运行时环境，直接在 Windows 上启动子进程
 */
class WindowsRuntime {
  /**
   * 初始化 Windows 运行时
   * @param {Object} options - 配置选项
   * @param {Function} [options.spawn] - 自定义 spawn 函数，默认使用 child_process.spawn
   */
  constructor(options) {
    this._spawn = options.spawn || require('child_process').spawn;
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
}

module.exports = { WindowsRuntime };
