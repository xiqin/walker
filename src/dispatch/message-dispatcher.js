'use strict';

const { buildRouteKey } = require('../core/route-key');
const { AgentEvent } = require('../drivers/agent-driver');
const { createLogger } = require('../core/logger');

const logger = createLogger('message-dispatcher');

/**
 * 消息调度器，处理飞书平台的消息和命令事件并协调 Agent 驱动与飞书 API 交互
 */
class MessageDispatcher {
  /**
   * 初始化消息调度器
   * @param {Object} options - 配置选项
   * @param {SessionService} options.sessionService - 会话管理服务
   * @param {DriverRegistry} options.driverRegistry - Agent 驱动注册表
   * @param {Object} options.feishuApi - 飞书 API 代理对象（含 replyText/replyCard/patchCard/addReaction/sendUnboundGuide/sendSessionList/sendErrorCard/sendProgressCard/updateProgressCard）
   * @param {MessageDedup} options.dedup - 消息去重器
   * @param {string} [options.routeMode='thread'] - 路由模式
   * @param {string} [options.reactionEmoji] - 处理中表情符号
   * @param {string} [options.doneEmoji] - 完成表情符号
   * @param {string} [options.progressStyle='card'] - 进度展示风格（card 或 text）
   * @param {string} [options.defaultAgent='opencode'] - 默认 Agent 类型
   * @param {string} [options.defaultCwd] - 默认工作目录
   */
  constructor(options) {
    this.sessionService = options.sessionService;
    this.driverRegistry = options.driverRegistry;
    this.feishuApi = options.feishuApi;
    this.dedup = options.dedup;
    this.routeMode = options.routeMode || 'thread';
    this.reactionEmoji = options.reactionEmoji || '';
    this.doneEmoji = options.doneEmoji || '';
    this.progressStyle = options.progressStyle || 'card';
    this.defaultAgent = options.defaultAgent || 'opencode';
    this.defaultCwd = options.defaultCwd || process.cwd();
  }

  /**
   * 处理飞书平台传入的消息事件，路由到对应会话并调用 Agent 驱动响应
   * @param {Object} event - 消息事件对象，包含 messageId、chatId、text 等字段
   * @returns {Promise<string>} 处理结果标识（duplicate/unbound/error/prompted）
   */
  async handleIncomingMessage(event) {
    if (this.dedup.isDuplicate(event.messageId)) {
      logger.info('skipping duplicate message', { messageId: event.messageId });
      return 'duplicate';
    }

    const routeKey = buildRouteKey(event, this.routeMode);
    const current = this.sessionService.getCurrent(routeKey);

    if (!current) {
      logger.info('route not bound, sending guide card', { routeKey });
      this.feishuApi.sendUnboundGuide(event.messageId, routeKey);
      return 'unbound';
    }

    if (this.reactionEmoji) {
      try { this.feishuApi.addReaction(event.messageId, this.reactionEmoji); } catch (_) {}
    }

    const driver = this.driverRegistry.get(current.agent);
    if (!driver) {
      logger.error('driver not found', { agent: current.agent });
      this.feishuApi.sendErrorCard(event.messageId, 'Agent driver not found: ' + current.agent);
      return 'error';
    }

    const agentRef = current.agentRef;
    if (!agentRef || !agentRef.opencodeSessionId) {
      logger.error('session has no agentRef', { sessionId: current.id });
      this.feishuApi.sendErrorCard(event.messageId, 'Session has no active agent reference');
      return 'error';
    }

    this.sessionService.markRunning(current.id);

    try {
      const events = await driver.prompt(agentRef, event.text);
      await this._renderEvents(current, event, events);
      this.sessionService.markIdle(current.id);
      return 'prompted';
    } catch (err) {
      this.sessionService.markError(current.id, err.message);
      this.feishuApi.sendErrorCard(event.messageId, err.message);
      return 'error';
    }
  }

  /**
   * 处理飞书命令（/new、/list、/use、/current、/stop、/delete、/help、/agents、/runtime）
   * @param {Object} cmd - 命令对象，包含 name、args、routeKey、messageId、chatId 等字段
   * @returns {Promise<Object>} 命令执行结果
   */
  async handleCommand(cmd) {
    const handlers = {
      new: () => this._cmdNew(cmd),
      list: () => this._cmdList(cmd),
      use: () => this._cmdUse(cmd),
      current: () => this._cmdCurrent(cmd),
      stop: () => this._cmdStop(cmd),
      delete: () => this._cmdDelete(cmd),
      help: () => this._cmdHelp(cmd),
      agents: () => this._cmdAgents(cmd),
      runtime: () => this._cmdRuntime(cmd),
    };
    const handler = handlers[cmd.name];
    if (handler) return handler();
    return { unknown: cmd.name };
  }

  /**
   * /new 命令：创建新 Walker session 并绑定 routeKey
   */
  async _cmdNew(cmd) {
    const routeKey = cmd.routeKey;
    const messageId = cmd.messageId;
    const agentName = cmd.args[0] || this.defaultAgent;
    const title = cmd.args[1] || '';
    const driver = this.driverRegistry.get(agentName);

    if (!driver) {
      this.feishuApi.sendErrorCard(messageId, 'Agent not found: ' + agentName);
      return { error: 'driver_not_found' };
    }

    await driver.ensureReady();
    const agentRef = await driver.createSession({ title, cwd: this.defaultCwd });

    const session = this.sessionService.createSession({
      route: routeKey,
      agent: agentName,
      title: title || ('session ' + agentRef.opencodeSessionId.slice(0, 12)),
      runtime: 'windows',
      cwd: this.defaultCwd,
      agentRef,
    });

    logger.info('new session created via /new', { sessionId: session.id, agent: agentName, routeKey });
    this.feishuApi.replyText(messageId, 'Session created: ' + session.id + ' (' + agentName + ')');
    return { sessionId: session.id, agentRef };
  }

  /**
   * /list 命令：显示所有 Walker session 列表卡片
   */
  async _cmdList(cmd) {
    const sessions = this.sessionService.listSessions();
    const currentSession = this.sessionService.getCurrent(cmd.routeKey);
    this.feishuApi.sendSessionList(cmd.messageId, sessions, currentSession ? currentSession.id : null);
    return { sessions };
  }

  /**
   * /use 命令：绑定或解绑 routeKey 到指定 session
   */
  async _cmdUse(cmd) {
    const targetId = cmd.args[0];
    if (targetId === 'off') {
      this.sessionService.unbindRoute(cmd.routeKey);
      this.feishuApi.replyText(cmd.messageId, 'Route unbound.');
      return { unbound: true };
    }
    this.sessionService.bindRoute(cmd.routeKey, targetId);
    this.feishuApi.replyText(cmd.messageId, 'Bound to session: ' + targetId);
    return { bound: targetId };
  }

  /**
   * /current 命令：查看当前 routeKey 绑定的 session
   */
  async _cmdCurrent(cmd) {
    const current = this.sessionService.getCurrent(cmd.routeKey);
    if (!current) {
      this.feishuApi.replyText(cmd.messageId, 'No session bound to this conversation.');
    } else {
      this.feishuApi.replyText(cmd.messageId, 'Current session: ' + current.id + ' (' + current.agent + ', ' + current.status + ')');
    }
    return { current };
  }

  /**
   * /stop 命令：停止当前绑定的 session
   */
  async _cmdStop(cmd) {
    const current = this.sessionService.getCurrent(cmd.routeKey);
    if (!current) {
      this.feishuApi.replyText(cmd.messageId, 'No session to stop.');
      return { noSession: true };
    }
    const driver = this.driverRegistry.get(current.agent);
    if (driver && current.agentRef) {
      await driver.stop(current.agentRef);
    }
    this.sessionService.stopSession(current.id);
    this.feishuApi.replyText(cmd.messageId, 'Session stopped: ' + current.id);
    return { stopped: current.id };
  }

  /**
   * /delete 命令：删除指定 session
   */
  async _cmdDelete(cmd) {
    const targetId = cmd.args[0];
    const session = this.sessionService.getSession(targetId);
    if (!session) {
      this.feishuApi.replyText(cmd.messageId, 'Session not found: ' + targetId);
      return { notFound: true };
    }
    const driver = this.driverRegistry.get(session.agent);
    if (driver && session.agentRef) {
      await driver.delete(session.agentRef);
    }
    this.sessionService.deleteSession(targetId);
    this.feishuApi.replyText(cmd.messageId, 'Session deleted: ' + targetId);
    return { deleted: targetId };
  }

  /**
   * /help 命令：显示命令帮助说明
   */
  async _cmdHelp(cmd) {
    const { formatHelp } = require('../platform/feishu/commands');
    this.feishuApi.replyText(cmd.messageId, formatHelp());
    return { help: true };
  }

  /**
   * /agents 命令：列出可用 Agent 驱动
   */
  async _cmdAgents(cmd) {
    const agents = this.driverRegistry.list();
    this.feishuApi.replyText(cmd.messageId, 'Available agents: ' + agents.join(', '));
    return { agents };
  }

  /**
   * /runtime 命令：显示运行时环境信息（尚未完整实现）
   */
  async _cmdRuntime(cmd) {
    this.feishuApi.replyText(cmd.messageId, 'Runtime info not yet implemented');
    return { runtime: true };
  }

  /**
   * 根据 progressStyle 选择渲染方式并渲染 Agent 事件列表
   * @param {Object} session - 当前会话对象
   * @param {Object} event - 原始消息事件
   * @param {AgentEvent[]} events - Agent 返回的事件列表
   * @returns {Promise<void>}
   */
  async _renderEvents(session, event, events) {
    if (this.progressStyle === 'card') {
      await this._renderCardProgress(session, event, events);
    } else {
      await this._renderLegacyProgress(event, events);
    }
  }

  /**
   * 使用飞书卡片消息渲染 Agent 处理进度，实时更新卡片内容
   * @param {Object} session - 当前会话对象
   * @param {Object} event - 原始消息事件
   * @param {AgentEvent[]} events - Agent 返回的事件列表
   * @returns {Promise<void>}
   */
  async _renderCardProgress(session, event, events) {
    const cardId = await this.feishuApi.sendProgressCard(event.messageId, session.id);

    for (const agentEvent of events) {
      const rendered = this.feishuApi.updateProgressCard(cardId, session.id, agentEvent);
      if (rendered && rendered.strategy === 'new_message') {
        const newCardId = await this.feishuApi.sendProgressCard(event.messageId, session.id, agentEvent);
        cardId = newCardId;
      }
    }

    if (this.doneEmoji) {
      try { this.feishuApi.addReaction(event.messageId, this.doneEmoji); } catch (_) {}
    }
  }

  /**
   * 使用纯文本方式渲染 Agent 处理结果（仅输出文本事件内容）
   * @param {Object} event - 原始消息事件
   * @param {AgentEvent[]} events - Agent 返回的事件列表
   * @returns {Promise<void>}
   */
  async _renderLegacyProgress(event, events) {
    let fullText = '';
    for (const agentEvent of events) {
      if (agentEvent.type === AgentEvent.TYPE_DONE) continue;
      if (agentEvent.type === AgentEvent.TYPE_TEXT) {
        fullText += agentEvent.data.text + '\n';
      }
    }
    this.feishuApi.replyText(event.messageId, fullText.trim());
  }
}

module.exports = { MessageDispatcher };
