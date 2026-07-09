'use strict';

const { loadEnvConfig } = require('../config/env');
const { JsonStore } = require('../core/json-store');
const { SessionService } = require('../core/session-service');
const { MessageDedup } = require('../core/message-dedup');
const { DriverRegistry } = require('../drivers/driver-registry');
const { OpencodeDriver } = require('../drivers/opencode-driver');
const { stubClaudeDriver, stubCodexDriver } = require('../drivers/stub-drivers');
const { createRuntime } = require('../runtime/runtime-factory');
const { MessageDispatcher } = require('../dispatch/message-dispatcher');
const { AttachmentService } = require('../dispatch/attachment-service');
const { FeishuPlatform } = require('../platform/feishu/platform');
const { renderUnboundRouteCard, renderSessionListCard, renderErrorCard } = require('../platform/feishu/cards');
const { ProgressCard } = require('../platform/feishu/progress-card');
const { createLogger } = require('../core/logger');
const path = require('path');

const logger = createLogger('bootstrap');

/**
 * 创建 Walker 应用实例，组装所有服务组件并返回启动/停止接口
 * @param {Object} config - 环境配置对象
 * @param {Object} deps - 依赖注入映射，允许替换各组件类用于测试
 * @returns {Object} 包含 start、stop、platform、dispatcher、sessionService、registry 的应用对象
 */
function createApp(config, deps) {
  const FeishuPlatformClass = deps.FeishuPlatform || FeishuPlatform;
  const SessionServiceClass = deps.SessionService || SessionService;
  const JsonStoreClass = deps.JsonStore || JsonStore;
  const OpencodeDriverClass = deps.OpencodeDriver || OpencodeDriver;
  const stubClaude = deps.stubClaudeDriver || stubClaudeDriver;
  const stubCodex = deps.stubCodexDriver || stubCodexDriver;
  const DriverRegistryClass = deps.DriverRegistry || DriverRegistry;
  const createRuntimeFn = deps.createRuntime || createRuntime;
  const MessageDedupClass = deps.MessageDedup || MessageDedup;
  const MessageDispatcherClass = deps.MessageDispatcher || MessageDispatcher;
  const AttachmentServiceClass = deps.AttachmentService || AttachmentService;

  const dataDir = config.walkerDataDir || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.walker');

  const sessionsStore = new JsonStoreClass(path.join(dataDir, 'sessions.json'), {});
  const routesStore = new JsonStoreClass(path.join(dataDir, 'routes.json'), {});
  const sessionService = new SessionServiceClass({ sessionsStore, routesStore });

  const runtime = createRuntimeFn(config.walkerDefaultRuntime, {
    distro: config.walkerWslDistro || 'Ubuntu-24.04',
  });

  const opencodeDriver = new OpencodeDriverClass({
    serverUrl: config.opencodeServerUrl || 'http://localhost:4096',
    autostart: config.opencodeServerAutostart,
    runtime,
    opencodeCmd: config.opencodeCmd || 'opencode',
    pollInterval: config.opencodePollInterval || 500,
    maxPolls: config.opencodeMaxPolls || 20,
  });

  const registry = new DriverRegistryClass();
  registry.register('opencode', opencodeDriver);
  registry.register('claude', stubClaude());
  registry.register('codex', stubCodex());

  const dedup = new MessageDedupClass({ windowMs: config.walkerDedupWindowMs || 300000 });
  const attachmentService = new AttachmentServiceClass({ dataDir });

  const feishuApiRef = {};

  const dispatcher = new MessageDispatcherClass({
    sessionService,
    driverRegistry: registry,
    feishuApi: feishuApiRef,
    dedup,
    routeMode: config.feishuRouteMode || 'thread',
    reactionEmoji: config.feishuReactionEmoji || '',
    doneEmoji: config.feishuDoneEmoji || '',
    progressStyle: config.feishuProgressStyle || 'card',
    defaultAgent: config.walkerDefaultAgent || 'opencode',
    defaultCwd: config.walkerDefaultCwd || process.cwd(),
  });

  const platform = new FeishuPlatformClass({
    config: {
      appId: config.feishuAppId,
      appSecret: config.feishuAppSecret,
      routeMode: config.feishuRouteMode || 'thread',
    },
    sessionService,
    onMessage: (event) => dispatcher.handleIncomingMessage(event),
    onCardAction: (action) => dispatcher.handleCommand(action),
  });

  feishuApiRef.replyText = (msgId, text) => platform.api.replyText({ messageId: msgId }, text);
  feishuApiRef.sendText = (chatId, text) => platform.api.sendText(chatId, text);
  feishuApiRef.replyCard = (msgId, card) => platform.api.replyCard({ messageId: msgId }, card);
  feishuApiRef.patchCard = (cardId, card) => platform.api.patchCard(cardId, card);
  feishuApiRef.addReaction = (msgId, emoji) => platform.api.addReaction(msgId, emoji);

  /** 发送未绑定引导卡片到飞书 */
  feishuApiRef.sendUnboundGuide = (msgId, routeKey) => platform.api.replyCard({ messageId: msgId }, renderUnboundRouteCard(routeKey));
  /** 发送会话列表卡片到飞书 */
  feishuApiRef.sendSessionList = (msgId, sessions, currentId) => platform.api.replyCard({ messageId: msgId }, renderSessionListCard(sessions, currentId));
  /** 发送错误提示卡片到飞书 */
  feishuApiRef.sendErrorCard = (msgId, message) => platform.api.replyCard({ messageId: msgId }, renderErrorCard(message));
  /** 发送进度卡片并返回卡片消息 ID */
  feishuApiRef.sendProgressCard = (msgId, sessionId, initialEvent) => {
    const card = new ProgressCard({ sessionId });
    if (initialEvent) card.append(initialEvent);
    return platform.api.replyCard({ messageId: msgId }, card.render());
  };
  /** 更新进度卡片内容，返回 patch 失败时的策略 */
  feishuApiRef.updateProgressCard = (cardId, sessionId, agentEvent) => {
    const card = new ProgressCard({ sessionId, cardMessageId: cardId });
    card.append(agentEvent);
    const rendered = card.render();
    try {
      platform.api.patchCard(cardId, rendered);
      return null;
    } catch (patchErr) {
      const strategy = card.handlePatchFailure(patchErr);
      return strategy;
    }
  };

  /**
   * 启动 Walker 应用，初始化飞书平台连接
   * @returns {Promise<void>}
   */
  async function start() {
    logger.info('walker starting', { agent: config.walkerDefaultAgent, runtime: config.walkerDefaultRuntime });
    await platform.start();
    logger.info('walker started successfully');
  }

  /**
   * 停止 Walker 应用，关闭飞书平台连接
   */
  function stop() {
    logger.info('walker stopping');
    platform.stop();
    logger.info('walker stopped');
  }

  return { start, stop, platform, dispatcher, sessionService, registry };
}

module.exports = { createApp };
