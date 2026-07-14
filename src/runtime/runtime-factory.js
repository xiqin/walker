'use strict';

const { WindowsRuntime } = require('./windows-runtime');
const { WslRuntime } = require('./wsl-runtime');

/**
 * 根据运行时类型创建对应的运行时实例
 * @param {string} type - 运行时类型（'windows' 或 'wsl'）
 * @param {Object} options - 运行时配置选项
 * @returns {WindowsRuntime|WslRuntime} 运行时实例
 */
function createRuntime(type, options) {
  switch (type) {
    case 'windows':
      return new WindowsRuntime(options);
    case 'wsl':
      if (!options || !options.distro) {
        throw new Error('WslRuntime requires distro configuration');
      }
      return new WslRuntime(options);
    default:
      throw new Error('Unknown runtime type: ' + type);
  }
}

module.exports = { createRuntime };
