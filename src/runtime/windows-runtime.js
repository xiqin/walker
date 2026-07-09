'use strict';

const { createLogger } = require('../core/logger');

const logger = createLogger('windows-runtime');

class WindowsRuntime {
  constructor(options) {
    this._spawn = options.spawn || require('child_process').spawn;
  }

  spawn(command, args, options) {
    const opts = { ...options };
    logger.info('windows spawn', { command, args });
    return this._spawn(command, args, opts);
  }
}

module.exports = { WindowsRuntime };
