'use strict';

const { buildPermissionCard, buildPermissionRepliedCard } = require('../platform/feishu/cards');
const { createLogger } = require('../core/logger');

const logger = createLogger('permission-handler');

/**
 * 权限确认处理器，负责接收 Agent 权限事件并渲染飞书权限确认卡片，
 * 在权限被回复后更新原卡片状态。
 *
 * 共享状态（permissionCardIds）仍挂在 dispatcher 实例上，保持 lazy init 行为。
 */
class PermissionHandler {
  /**
   * @param {Object} options
   * @param {Object} options.dispatcher - MessageDispatcher 实例
   * @param {Object} options.feishuApi - 飞书 API 代理
   * @param {Object} options.sessionService - 会话服务
   */
  constructor({ dispatcher, feishuApi, sessionService }) {
    this.dispatcher = dispatcher;
    this.feishuApi = feishuApi;
    this.sessionService = sessionService;
  }

  /**
   * 处理权限请求事件，发送或更新权限确认卡片
   * @param {Object} session - 会话对象
   * @param {string} chatId - 飞书聊天 ID
   * @param {AgentEvent} agentEvent - 权限事件
   */
  handle(session, chatId, agentEvent) {
    if (!this.dispatcher.permissionCardIds) this.dispatcher.permissionCardIds = new Map();
    const permissionId = agentEvent.data && agentEvent.data.id;
    const routeKey = this.sessionService && typeof this.sessionService.getRouteForSession === 'function'
      ? this.sessionService.getRouteForSession(session.id) : '';
    const existingCardId = this.dispatcher.permissionCardIds.get(permissionId);
    if (existingCardId) {
      this.dispatcher._sendFeishu('patchCard', [existingCardId, buildPermissionCard(agentEvent, session.id, routeKey)], { sessionId: session.id, permissionId });
      return;
    }
    const replyCtx = { chatId: chatId };
    this.dispatcher._callFeishu('replyCard', [replyCtx, buildPermissionCard(agentEvent, session.id, routeKey)], null, { sessionId: session.id, permissionId })
      .then((cardId) => {
        if (cardId) this.dispatcher.permissionCardIds.set(permissionId, cardId);
      })
      .catch((err) => {
        logger.warn('permission card send failed', { sessionId: session.id, permissionId, error: err && err.message });
      });
  }

  /**
   * 处理权限已回复事件，更新原权限卡片为已处理状态
   * @param {Object} session - 会话对象
   * @param {string} chatId - 飞书聊天 ID
   * @param {AgentEvent} agentEvent - 权限已回复事件
   */
  handleReplied(session, chatId, agentEvent) {
    const permissionId = agentEvent.data && agentEvent.data.permissionId;
    const response = agentEvent.data && agentEvent.data.response;
    if (!this.dispatcher.permissionCardIds || !permissionId) return;
    const existingCardId = this.dispatcher.permissionCardIds.get(permissionId);
    if (existingCardId) {
      this.dispatcher._sendFeishu('patchCard', [existingCardId, buildPermissionRepliedCard(permissionId, response)], { sessionId: session.id, permissionId });
    }
  }
}

module.exports = { PermissionHandler };
