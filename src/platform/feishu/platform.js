const lark = require('@larksuiteoapi/node-sdk');
const { parseMessageEvent, parseCardAction } = require('./events');
const { parseCommand } = require('./commands');
const { buildRouteKey } = require('../../core/route-key');
const { FeishuApi } = require('./api');
const { createLogger } = require('../../core/logger');

const logger = createLogger('feishu-platform');

class FeishuPlatform {
  constructor({ config, sessionService, onMessage, onCardAction }) {
    this.config = config;
    this.sessionService = sessionService;
    this.onMessage = onMessage;
    this.onCardAction = onCardAction;
    this.wsClient = null;
    this.api = new FeishuApi({ appId: config.appId || config.feishuAppId, appSecret: config.appSecret || config.feishuAppSecret });
  }

  start() {
    const appId = this.config.appId || this.config.feishuAppId;
    const appSecret = this.config.appSecret || this.config.feishuAppSecret;
    const routeMode = this.config.routeMode || this.config.feishuRouteMode;

    if (!appId || !appSecret) {
      throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required');
    }

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        try {
          const parsed = parseMessageEvent(data);
          if (parsed.messageType !== 'text') return;

          const routeKey = buildRouteKey(parsed, routeMode);
          const cmd = parseCommand(parsed.text);

          if (cmd.type === 'command') {
            await this.onMessage({
              type: 'command',
              command: cmd,
              routeKey,
              chatId: parsed.chatId,
              messageId: parsed.messageId,
              openId: parsed.openId,
              rootId: parsed.rootId,
            });
          } else {
            await this.onMessage({
              type: 'text',
              text: parsed.text,
              routeKey,
              chatId: parsed.chatId,
              messageId: parsed.messageId,
              openId: parsed.openId,
              rootId: parsed.rootId,
            });
          }
        } catch (err) {
          logger.error('message event error', { err });
        }
      },
      'card.action.trigger': async (data) => {
        try {
          const parsed = parseCardAction(data);
          if (parsed.action) {
            await this.onCardAction({
              action: parsed.action,
              chatId: parsed.chatId,
              messageId: parsed.messageId,
              openId: parsed.openId,
            });
          }
        } catch (err) {
          logger.error('card action error', { err });
        }
      },
    });

    this.wsClient = new lark.WSClient({
      appID: appId,
      appSecret: appSecret,
      eventDispatcher: dispatcher,
    });
    this.wsClient.start();
    logger.info('feishu ws client started', { appId: appId.slice(0, 8) });
  }

  stop() {
    if (this.wsClient) {
      try { this.wsClient.close(); } catch (_) {}
    }
    logger.info('feishu platform stopped');
  }
}

module.exports = { FeishuPlatform };
