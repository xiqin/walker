'use strict';

const { createLogger } = require('./logger');

const logger = createLogger('message-dedup');

class MessageDedup {
  constructor(options) {
    this.windowMs = options.windowMs || 300000;
    this.entries = {};
  }

  isDuplicate(messageId) {
    const now = Date.now();
    this._cleanup(now);

    if (this.entries[messageId]) {
      logger.info('duplicate message detected', { messageId });
      return true;
    }

    this.entries[messageId] = now;
    return false;
  }

  size() {
    return Object.keys(this.entries).length;
  }

  _cleanup(now) {
    for (const key of Object.keys(this.entries)) {
      if (now - this.entries[key] > this.windowMs) {
        delete this.entries[key];
      }
    }
  }
}

module.exports = { MessageDedup };
