'use strict';

const { createLogger } = require('./logger');

const logger = createLogger('message-dedup');

/**
 * 消息去重器，基于时间窗口检测并过滤重复消息
 */
class MessageDedup {
  /**
   * 初始化去重器
   * @param {Object} options - 配置选项
   * @param {number} [options.windowMs=300000] - 去重时间窗口（毫秒），默认 5 分钟
   */
  constructor(options) {
    this.windowMs = options.windowMs || 300000;
    this.entries = {};
  }

  /**
   * 检测消息是否为重复消息
   * @param {string} messageId - 消息唯一标识符
   * @returns {boolean} 若为重复消息返回 true，否则记录该消息并返回 false
   */
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

  /**
   * 获取当前去重缓存中的消息条数
   * @returns {number} 缓存条目数量
   */
  size() {
    return Object.keys(this.entries).length;
  }

  /**
   * 清理超出时间窗口的过期缓存条目
   * @param {number} now - 当前时间戳（毫秒）
   */
  _cleanup(now) {
    for (const key of Object.keys(this.entries)) {
      if (now - this.entries[key] > this.windowMs) {
        delete this.entries[key];
      }
    }
  }
}

module.exports = { MessageDedup };
