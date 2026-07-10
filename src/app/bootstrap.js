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
const { renderUnboundRouteCard, renderSessionListCard, renderAttachableSessionCard, renderErrorCard } = require('../platform/feishu/cards');
const { ProgressCard } = require('../platform/feishu/progress-card');
const { parseCommand } = require('../platform/feishu/commands');
const { buildRouteKey } = require('../core/route-key');
const { createLogger } = require('../core/logger');
const { createEventStore } = require('../admin/event-store');
const { createAdminServerFromContext } = require('../admin/index');
const path = require('path');

const logger = createLogger('bootstrap');

/**
 * 创建 Walker 应用实例，组装所有服务组件并返回启动/停止接口
 * @param {Object} config - 环境配置对象
 * @param {Object} deps - 依赖注入映射，允许替换各组件类用于测试
 * @returns {Object} 包含 start、stop、platform、dispatcher、sessionService、registry 的应用对象
 */
function createApp(config, deps) {
  deps = deps || {};
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
  const createEventStoreFn = deps.createEventStore || createEventStore;
  const createAdminServerFn = deps.createAdminServer || createAdminServerFromContext;

  const dataDir = config.walkerDataDir || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.walker');

  const eventStore = createEventStoreFn();

  const stateStore = new JsonStoreClass(path.join(dataDir, 'state.json'), {});
  const sessionService = new SessionServiceClass({ stateStore });

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
    promptTimeoutMs: config.opencodePromptTimeoutMs || 120000,
    sseOpenTimeoutMs: config.opencodeSseOpenTimeoutMs || 1000,
  });

  const registry = new DriverRegistryClass();
  registry.register('opencode', opencodeDriver);
  registry.register('claude', stubClaude());
  registry.register('codex', stubCodex());

  const dedupStore = new JsonStoreClass(path.join(dataDir, 'dedup.json'), {});
  const dedup = new MessageDedupClass({ windowMs: config.walkerDedupWindowMs || 300000, store: dedupStore });
  const attachmentService = new AttachmentServiceClass({ dataDir });

  const feishuApiRef = {};
  const progressCards = new Map();

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
    runtimeType: config.walkerDefaultRuntime || 'windows',
  });

  const platform = new FeishuPlatformClass({
    config: {
      appId: config.feishuAppId,
      appSecret: config.feishuAppSecret,
      routeMode: config.feishuRouteMode || 'thread',
    },
    sessionService,
    onMessage: (event) => {
      if (event.type === 'command') {
        return dispatcher.handleCommand({
          ...event.command,
          routeKey: event.routeKey,
          chatId: event.chatId,
          messageId: event.messageId,
          openId: event.openId,
          rootId: event.rootId,
          createTime: event.createTime,
        });
      }
      return dispatcher.handleIncomingMessage(event);
    },
    onCardAction: (action) => {
      const rawAction = action.action || '';
      if (rawAction.startsWith('cmd:')) {
        const cmd = parseCommand(rawAction.slice(4));
        if (cmd.type === 'command') {
          const routeKey = action.routeKey || buildRouteKey(action, config.feishuRouteMode || 'thread');
          return dispatcher.handleCommand({
            ...cmd,
            routeKey,
            chatId: action.chatId,
            messageId: action.messageId,
            openId: action.openId,
          });
        }
      }
      return dispatcher.handleCommand(action);
    },
  });

  feishuApiRef.replyText = (replyCtx, text) => platform.api.replyText(normalizeReplyCtx(replyCtx), text);
  feishuApiRef.sendText = (chatId, text) => platform.api.sendText(chatId, text);
  feishuApiRef.replyCard = (replyCtx, card) => platform.api.replyCard(normalizeReplyCtx(replyCtx), card);
  feishuApiRef.patchCard = (cardId, card) => platform.api.patchCard(cardId, card);
  feishuApiRef.addReaction = (msgId, emoji) => platform.api.addReaction(msgId, emoji);

  /** 发送未绑定引导卡片到飞书 */
  feishuApiRef.sendUnboundGuide = (replyCtx, routeKey) => platform.api.replyCard(normalizeReplyCtx(replyCtx), renderUnboundRouteCard(routeKey));
  /** 发送会话列表卡片到飞书 */
  feishuApiRef.sendSessionList = (replyCtx, sessions, currentId, routeKey) => platform.api.replyCard(normalizeReplyCtx(replyCtx), renderSessionListCard(sessions, currentId, routeKey));
  /** 发送可纳入 OpenCode 会话列表卡片到飞书 */
  feishuApiRef.sendAttachableSessionList = (replyCtx, sessions, options) => platform.api.replyCard(normalizeReplyCtx(replyCtx), renderAttachableSessionCard(sessions, options));
  /** 发送错误提示卡片到飞书 */
  feishuApiRef.sendErrorCard = (replyCtx, message) => platform.api.replyCard(normalizeReplyCtx(replyCtx), renderErrorCard(message));
  /** 发送进度卡片并返回卡片消息 ID */
  feishuApiRef.sendProgressCard = async (replyCtx, sessionId, initialEvent) => {
    const card = new ProgressCard({ sessionId });
    if (initialEvent) card.append(initialEvent);
    const cardId = await platform.api.replyCard(normalizeReplyCtx(replyCtx), card.render());
    progressCards.set(cardId, card);
    return cardId;
  };
  /** 更新进度卡片内容，返回 patch 失败时的策略 */
  feishuApiRef.updateProgressCard = async (cardId, sessionId, agentEvent) => {
    const card = progressCards.get(cardId) || new ProgressCard({ sessionId, cardMessageId: cardId });
    if (!progressCards.has(cardId)) progressCards.set(cardId, card);
    card.append(agentEvent);
    const rendered = card.render();
    try {
      await platform.api.patchCard(cardId, rendered);
      if (card.done) progressCards.delete(cardId);
      return null;
    } catch (patchErr) {
      const strategy = card.handlePatchFailure(patchErr);
      return strategy;
    }
  };

  const requiredFeishuMethods = [
    'replyText', 'sendText', 'replyCard', 'patchCard', 'addReaction',
    'sendUnboundGuide', 'sendSessionList', 'sendAttachableSessionList',
    'sendErrorCard', 'sendProgressCard', 'updateProgressCard',
  ];
  for (const method of requiredFeishuMethods) {
    if (typeof feishuApiRef[method] !== 'function') {
      logger.warn('feishu api method not mounted', { method });
    }
  }

  const adminEnabled = config.admin ? config.admin.enabled !== false : true;
  const adminConfig = config.admin || { enabled: true, host: '127.0.0.1', port: 8787, token: '' };
  let platformStarted = false;

  /**
   * 创建管理端 AdminServer（adminEnabled=false 时跳过）
   * @returns {Object|null} AdminServer 实例或 null
   */
  function createAdminIfEnabled() {
    if (!adminEnabled) return null;
    const feishuSummary = {
      connected: false,
      source: config.feishuConfigSource || 'missing',
    };
    return createAdminServerFn({
      sessionService,
      registry,
      eventStore,
      envConfig: config,
      feishuSummary,
      dataDir,
      version: config.walkerVersion || '',
      startTime: Date.now(),
      runtime,
      attachmentService,
      config: adminConfig,
    }, {
      stopApp: async function stopWalkerApp() { stop(); return { ok: true }; },
      exitProcess: function exitWalkerProcess(code) { process.exit(code || 0); },
    });
  }

  let adminServer = createAdminIfEnabled();

  /**
   * 启动 Walker 应用，初始化飞书平台连接和管理端 HTTP 服务
   * @returns {Promise<void>}
   */
  async function start() {
    logger.info('walker starting', { agent: config.walkerDefaultAgent, runtime: config.walkerDefaultRuntime, admin: adminEnabled });
    const recovered = sessionService.recoverOnStartup();
    const cleaned = sessionService.cleanOrphanRoutes();
    if (recovered.length > 0) logger.info('recovered running sessions to idle', { count: recovered.length });
    if (cleaned.length > 0) logger.info('cleaned orphan routes', { count: cleaned.length });
    await platform.start();
    platformStarted = true;
    if (adminServer) {
      const result = await adminServer.start();
      if (result && result.ok && !result.disabled) {
        logger.info('admin console started', { host: result.host, port: result.port });
      }
    }
    logger.info('walker started successfully');
  }

  /**
   * 停止 Walker 应用，关闭管理端 HTTP 服务和飞书平台连接
   * 同步触发 admin server 关闭（不等待 Promise 完成），与原始飞书 stop 行为一致
   */
  async function stop() {
    logger.info('walker stopping');
    if (adminServer) {
      await adminServer.stop();
      logger.info('admin console stopped');
    }
    platform.stop();
    logger.info('walker stopped');
  }

  return { start, stop, platform, dispatcher, sessionService, registry, adminServer, runtime, attachmentService, eventStore };
}

function normalizeReplyCtx(replyCtx) {
  if (replyCtx && typeof replyCtx === 'object') return replyCtx;
  return { messageId: replyCtx };
}

module.exports = { createApp };
