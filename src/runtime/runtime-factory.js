'use strict';

const { WindowsRuntime } = require('./windows-runtime');
const { WslRuntime } = require('./wsl-runtime');

function createRuntime(type, options) {
  switch (type) {
    case 'windows':
      return new WindowsRuntime(options);
    case 'wsl':
      return new WslRuntime(options);
    default:
      throw new Error('Unknown runtime type: ' + type);
  }
}

module.exports = { createRuntime };
