'use strict';

const { PlatformDriver, assertPlatformEvent } = require('./platform-driver');
const { parseMessageEvent, toFeishuPlatformEvent } = require('../platform/feishu/events');
const { buildRouteKey } = require('../core/route-key');
const { createLogger } = require('../core/logger');

const logger = createLogger('feishu-platform-driver');

class FeishuPlatformDriver extends PlatformDriver {
  constructor(options) {
    super({ platform: 'feishu' });
    this.api = options && options.api;
    this.routeMode = options && options.routeMode || 'thread';
    this.onEvent = options && options.onEvent || null;
  }

  async start() {
    logger.info('feishu platform driver started');
    return { platform: 'feishu', status: 'started' };
  }

  async stop() {
    logger.info('feishu platform driver stopped');
  }

  toPlatformEvent(data) {
    try {
      const parsed = data && data.messageId ? data : parseMessageEvent(data);
      const routeKey = parsed.routeKey || buildRouteKey(parsed, this.routeMode, 'feishu');
      const event = toFeishuPlatformEvent(parsed, { routeKey, raw: data });
      assertPlatformEvent(event);
      return event;
    } catch (err) {
      this._record('platform.adapter_error', { error: err && err.message ? err.message : String(err) });
      throw err;
    }
  }

  async sendMessage(target, text, runtime) {
    if (!this.api) throw new Error('feishu api is required');
    try {
      if (target && target.messageId) return await this.api.replyText(target, text, runtime);
      return await this.api.sendText(target && target.chatId || target, text, runtime);
    } catch (err) {
      this._record('platform.delivery_failed', { method: 'sendMessage', error: err && err.message ? err.message : String(err) });
      throw err;
    }
  }

  async updateMessage(messageId, card, runtime) {
    return this._callDelivery('updateMessage', () => this.api.patchCard(messageId, card, runtime));
  }

  async sendCard(target, card, runtime) {
    return this._callDelivery('sendCard', () => this.api.replyCard(target, card, runtime));
  }

  async uploadAttachment(file) {
    if (!this.api || typeof this.api.uploadAttachment !== 'function') {
      const error = new Error('feishu uploadAttachment is not available');
      this._record('platform.delivery_failed', { method: 'uploadAttachment', error: error.message });
      throw error;
    }
    return this._callDelivery('uploadAttachment', () => this.api.uploadAttachment(file));
  }

  async _callDelivery(method, fn) {
    if (!this.api) throw new Error('feishu api is required');
    try {
      return await fn();
    } catch (err) {
      this._record('platform.delivery_failed', { method, error: err && err.message ? err.message : String(err) });
      throw err;
    }
  }

  _record(type, data) {
    logger.info(type, data || {});
    if (typeof this.onEvent === 'function') {
      try { this.onEvent({ type, platform: 'feishu', data: data || {} }); } catch (_) {}
    }
  }
}

module.exports = { FeishuPlatformDriver };
