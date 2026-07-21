const lark = require('@larksuiteoapi/node-sdk');
const { parseMessageEvent, parseCardAction } = require('./events');
const { parseCommand } = require('./commands');
const { buildRouteKey } = require('../../core/route-key');
const { FeishuApi } = require('./api');
const { createLogger } = require('../../core/logger');

const logger = createLogger('feishu-platform');

/**
 * 飞书平台适配器，通过 Lark SDK 的 WebSocket 客户端接收飞书事件并分发到处理器
 */
class FeishuPlatform {
  /**
   * 初始化飞书平台适配器
   * @param {Object} options - 配置选项
   * @param {Object} options.config - 平台配置，包含 appId、appSecret、routeMode
   * @param {SessionService} options.sessionService - 会话管理服务
   * @param {Function} options.onMessage - 消息事件回调函数
   * @param {Function} options.onCardAction - 卡片交互回调函数
   */
  constructor({ config, sessionService, onMessage, onCardAction }) {
    this.config = config;
    this.sessionService = sessionService;
    this.onMessage = onMessage;
    this.onCardAction = onCardAction;
    this.wsClient = null;
    const appId = config.feishuAppId || '';
    const appSecret = config.feishuAppSecret || '';
    this.api = new FeishuApi({ appId, appSecret });
  }

  /**
   * 启动飞书 WebSocket 客户端，注册消息接收和卡片交互事件处理器
   */
  async start() {
    const appId = this.config.feishuAppId || '';
    const appSecret = this.config.feishuAppSecret || '';
    const routeMode = this.config.feishuRouteMode || 'thread';

    if (!appId || !appSecret) {
      throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required');
    }

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data) => {
        this._handleMessageEvent(data, routeMode).catch((err) => {
          logger.error('message event error', { err });
        });
      },
      'card.action.trigger': (data) => {
        this._handleCardAction(data).catch((err) => {
          logger.error('card action error', { err });
        });
      },
      'im.message.reaction.created_v1': (data) => {
        this._handleReactionEvent(data);
      },
      'im.message.reaction.deleted_v1': (data) => {
        this._handleReactionEvent(data);
      },
    });

    this.wsClient = new lark.WSClient({
      appId: appId,
      appSecret: appSecret,
    });
    const result = await this.wsClient.start({ eventDispatcher: dispatcher });
    logger.info('feishu ws client started', { appId: appId.slice(0, 8) });
    return result;
  }

  async _handleMessageEvent(data, routeMode) {
    const parsed = parseMessageEvent(data);
    if (parsed.messageType !== 'text') {
      await this.api.replyText({ messageId: parsed.messageId }, '暂时仅支持文本消息，图片和文件支持将在后续版本实现。');
      return;
    }

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
        createTime: parsed.createTime,
      });
      return;
    }

    await this.onMessage({
      type: 'text',
      text: parsed.text,
      routeKey,
      chatId: parsed.chatId,
      messageId: parsed.messageId,
      openId: parsed.openId,
      rootId: parsed.rootId,
      createTime: parsed.createTime,
    });
  }

  async _handleCardAction(data) {
    const parsed = parseCardAction(data);
    if (parsed.action) {
      logger.info('card action received', { action: parsed.action, chatId: parsed.chatId, messageId: parsed.messageId, openId: parsed.openId, routeKey: parsed.routeKey, formKeys: parsed.formValue ? Object.keys(parsed.formValue) : [] });
      await this.onCardAction({
        action: parsed.action,
        chatId: parsed.chatId,
        messageId: parsed.messageId,
        openId: parsed.openId,
        routeKey: parsed.routeKey,
        formValue: parsed.formValue,
      });
    } else {
      logger.warn('card action ignored: missing action value', { chatId: parsed.chatId, messageId: parsed.messageId, openId: parsed.openId });
    }
  }

  /**
   * 处理飞书消息表情反应事件（im.message.reaction.created_v1 / deleted_v1）
   * 当前不基于表情触发业务逻辑，仅记录 debug 日志以消除 Lark SDK 的 `no ${type} handle` 警告。
   * @param {Object} data - 飞书 reaction 事件原始数据
   */
  _handleReactionEvent(data) {
    const reactionType = data && data.reaction && data.reaction.reaction_type && data.reaction.reaction_type.emoji_type;
    const messageId = data && data.reaction && data.reaction.message_id;
    const chatId = data && data.reaction && data.reaction.chat_id || (data && data.operator && data.operator.open_id);
    logger.debug('reaction event ignored', { type: data && data.type, reactionType, messageId, chatId });
  }

  /**
   * 停止飞书 WebSocket 客户端连接
   * @returns {Promise<void>}
   */
  async stop() {
    if (this.wsClient) {
      try {
        const closeResult = this.wsClient.close();
        if (closeResult && typeof closeResult.then === 'function') {
          await closeResult;
        }
      } catch (_) {}
    }
    logger.info('feishu platform stopped');
  }
}

module.exports = { FeishuPlatform };
