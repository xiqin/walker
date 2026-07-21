'use strict';

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
const { renderUnboundRouteCard, renderSessionListCard, renderAttachableSessionCard, renderModelListCard, renderHelpCard, renderErrorCard, buildPermissionCard, buildPermissionRepliedCard } = require('../platform/feishu/cards');
const { ProgressCard } = require('../platform/feishu/progress-card');
const { parseCommand } = require('../platform/feishu/commands');
const { buildRouteKey } = require('../core/route-key');
const { createLogger } = require('../core/logger');
const { createEventStore } = require('../admin/event-store');
const { createAdminServerFromContext } = require('../admin/index');
const { installHookPlugin } = require('../opencode-hook/installer');
const { createHookReceiverRoutes } = require('../opencode-hook/receiver');
const { createHealthPoller } = require('../opencode-hook/health-poller');
const { OpencodeTuiBridge } = require('../opencode-tui-bridge/bridge');
const { createTuiBridgeRoutes } = require('../opencode-tui-bridge/routes');
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
  const OpencodeTuiBridgeClass = deps.OpencodeTuiBridge || OpencodeTuiBridge;
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

  const tuiBridge = new OpencodeTuiBridgeClass({
    sessionService,
    leaseTimeoutMs: config.opencodeTuiLeaseTimeoutMs ?? 90000,
    heartbeatIntervalMs: config.opencodeTuiHeartbeatIntervalMs ?? 30000,
  });

  const opencodeDriver = new OpencodeDriverClass({
    serverUrl: config.opencodeServerUrl || 'http://localhost:4096',
    autostart: config.opencodeServerAutostart,
    runtime,
    opencodeCmd: config.opencodeCmd || 'opencode',
    pollInterval: config.opencodePollInterval || 500,
    maxPolls: config.opencodeMaxPolls || 20,
    promptTimeoutMs: config.opencodePromptTimeoutMs ?? 120000,
    sseOpenTimeoutMs: config.opencodeSseOpenTimeoutMs ?? 1000,
    promptRequestTimeoutMs: config.opencodePromptRequestTimeoutMs ?? 30000,
    sseIdleTimeoutMs: config.opencodeSseIdleTimeoutMs ?? 300000,
    recoveryWindowMs: config.opencodeRecoveryWindowMs ?? 300000,
    messagePollIntervalMs: config.opencodeMessagePollIntervalMs ?? 3000,
    tuiBridge,
  });

  const registry = new DriverRegistryClass();
  registry.register('opencode', opencodeDriver);
  registry.register('claude', stubClaude());
  registry.register('codex', stubCodex());

  const dedupStore = new JsonStoreClass(path.join(dataDir, 'dedup.json'), {});
  const dedup = new MessageDedupClass({ windowMs: config.walkerDedupWindowMs || 300000, store: dedupStore });
  const attachmentService = new AttachmentServiceClass({ dataDir });

  const feishuApiTarget = {};
  const feishuApiRef = new Proxy(feishuApiTarget, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return undefined;
    },
  });
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
    promptHeartbeatInitialMs: config.walkerPromptHeartbeatInitialMs,
    promptHeartbeatIntervalMs: config.walkerPromptHeartbeatIntervalMs,
    promptHeartbeatStuckMs: config.walkerPromptHeartbeatStuckMs,
    maxTurnTimeMins: config.walkerMaxTurnTimeMins,
    nonFocusOutput: config.walkerOpencodeNonFocusOutput !== false,
  });
  if (tuiBridge && typeof tuiBridge.setOnSessionEnrolled === 'function') {
    tuiBridge.setOnSessionEnrolled(({ sessionId }) => {
      if (dispatcher && typeof dispatcher.ensureWatchForSession === 'function') {
        dispatcher.ensureWatchForSession(sessionId);
      }
    });
  }

  const platform = new FeishuPlatformClass({
    config: {
      feishuAppId: config.feishuAppId,
      feishuAppSecret: config.feishuAppSecret,
      feishuRouteMode: config.feishuRouteMode || 'thread',
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
      const cmd = parseCommand(rawAction.startsWith('cmd:') ? rawAction.slice(4) : rawAction);
      if (cmd.type === 'command') {
        const routeKey = action.routeKey || buildRouteKey(action, config.feishuRouteMode || 'thread');
        return dispatcher.handleCommand({
          ...cmd,
          routeKey,
          chatId: action.chatId,
          messageId: action.messageId,
          openId: action.openId,
          formValue: action.formValue,
        });
      }
      return dispatcher.handleIncomingMessage({
        type: 'text',
        text: rawAction,
        routeKey: action.routeKey || buildRouteKey(action, config.feishuRouteMode || 'thread'),
        chatId: action.chatId,
        messageId: action.messageId,
        openId: action.openId,
      });
    },
  });

  feishuApiTarget.replyText = (replyCtx, text) => platform.api.replyText(normalizeReplyCtx(replyCtx), text);
  feishuApiTarget.replyMarkdown = (replyCtx, text) => platform.api.replyMarkdown(normalizeReplyCtx(replyCtx), text);
  feishuApiTarget.sendText = (chatId, text) => platform.api.sendText(chatId, text);
  feishuApiTarget.sendMarkdown = (chatId, text) => platform.api.sendMarkdown(chatId, text);
  feishuApiTarget.replyCard = (replyCtx, card) => platform.api.replyCard(normalizeReplyCtx(replyCtx), card);
  feishuApiTarget.patchCard = (cardId, card) => platform.api.patchCard(cardId, card);
  feishuApiTarget.addReaction = (msgId, emoji) => platform.api.addReaction(msgId, emoji);

  /** 发送未绑定引导卡片到飞书 */
  feishuApiTarget.sendUnboundGuide = (replyCtx, routeKey) => platform.api.replyCard(normalizeReplyCtx(replyCtx), renderUnboundRouteCard(routeKey));
  /** 发送会话列表卡片到飞书 */
  feishuApiTarget.sendSessionList = (replyCtx, sessions, currentId, routeKeyOrOptions) => {
    const options = typeof routeKeyOrOptions === 'string' ? { routeKey: routeKeyOrOptions } : (routeKeyOrOptions || {});
    const card = renderSessionListCard(sessions, currentId, options);
    if (options.updateMessageId) {
      return platform.api.patchCard(options.updateMessageId, card);
    }
    return platform.api.replyCard(normalizeReplyCtx(replyCtx), card);
  };
  /** 发送可纳入 OpenCode 会话列表卡片到飞书 */
  feishuApiTarget.sendAttachableSessionList = (replyCtx, sessions, options) => {
    const card = renderAttachableSessionCard(sessions, options);
    if (options && options.updateMessageId) {
      return platform.api.patchCard(options.updateMessageId, card);
    }
    return platform.api.replyCard(normalizeReplyCtx(replyCtx), card);
  };
  /** 发送模型列表卡片到飞书 */
  feishuApiTarget.sendModelList = (replyCtx, models, options) => {
    const card = renderModelListCard(models, options);
    if (options && options.updateMessageId) {
      return platform.api.patchCard(options.updateMessageId, card);
    }
    return platform.api.replyCard(normalizeReplyCtx(replyCtx), card);
  };
  /** 发送命令帮助卡片到飞书 */
  feishuApiTarget.sendHelpCard = (replyCtx, commands, options) => platform.api.replyCard(normalizeReplyCtx(replyCtx), renderHelpCard(commands, options));
  /** 发送错误提示卡片到飞书 */
  feishuApiTarget.sendErrorCard = (replyCtx, message) => platform.api.replyCard(normalizeReplyCtx(replyCtx), renderErrorCard(message));
  /** 发送权限确认卡片到飞书 */
  feishuApiTarget.sendPermissionCard = (replyCtx, permissionEvent, sessionId, routeKey) => platform.api.replyCard(normalizeReplyCtx(replyCtx), buildPermissionCard(permissionEvent, sessionId, routeKey));
  /** 更新权限卡片为已处理状态 */
  feishuApiTarget.patchPermissionCard = (cardId, permissionId, response) => platform.api.patchCard(cardId, buildPermissionRepliedCard(permissionId, response));
  /** 发送进度卡片并返回卡片消息 ID */
  feishuApiTarget.sendProgressCard = async (replyCtx, sessionId, initialEvent) => {
    const card = new ProgressCard({ sessionId });
    if (initialEvent) card.append(initialEvent);
    const cardId = await platform.api.replyCard(normalizeReplyCtx(replyCtx), card.render());
    progressCards.set(cardId, card);
    return cardId;
  };
  /** 更新进度卡片内容，返回 patch 失败时的策略 */
  feishuApiTarget.updateProgressCard = async (cardId, sessionId, agentEvent) => {
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
      progressCards.delete(cardId);
      return strategy;
    }
  };

  const requiredFeishuMethods = [
    'replyText', 'sendText', 'replyCard', 'patchCard', 'addReaction',
    'sendUnboundGuide', 'sendSessionList', 'sendAttachableSessionList',
    'sendModelList', 'sendHelpCard', 'sendErrorCard', 'sendProgressCard', 'updateProgressCard',
    'sendPermissionCard', 'patchPermissionCard',
  ];
  for (const method of requiredFeishuMethods) {
    if (typeof feishuApiRef[method] !== 'function') {
      logger.warn('feishu api method not mounted', { method });
    }
  }

  const adminEnabled = config.admin ? config.admin.enabled !== false : true;
  const adminConfig = config.admin || { enabled: true, host: '127.0.0.1', port: 8787, token: '' };

  const healthPoller = createHealthPoller({
    sessionService,
    driverRegistry: registry,
    dispatcher,
    pollIntervalMs: config.walkerOpencodeHealthPollIntervalMs,
    exitAction: config.walkerOpencodeExitAction,
    httpClient: opencodeDriver.httpClient,
  });

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
    const hookReceiverRoutes = createHookReceiverRoutes({
      sessionService,
      config: adminConfig,
      defaultOpencodeUrl: config.opencodeServerUrl || 'http://localhost:4096',
      onSessionEnrolled: ({ sessionId, routeKey: _routeKey }) => {
        dispatcher.ensureWatchForSession(sessionId);
        const session = sessionService.getSession(sessionId);
        if (session && session.agentRef) {
          healthPoller.track(sessionId, session.agentRef);
        }
      },
    }).concat(createTuiBridgeRoutes({ bridge: tuiBridge, config: adminConfig }));
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
      hookReceiverRoutes,
    }, {
      stopApp: async function stopWalkerApp() { stop(); return { ok: true }; },
      exitProcess: function exitWalkerProcess(code) { process.exit(code || 0); },
    });
  }

  let adminServer = createAdminIfEnabled();

  function _restoreHealthPollers() {
    if (!sessionService || typeof sessionService.listSessions !== 'function') return;
    const sessions = sessionService.listSessions();
    let restored = 0;
    for (const session of sessions) {
      if (!session || session.status === 'deleted') continue;
      if (!session.agentRef || !session.agentRef.opencodeSessionId) continue;
      if (session.agentRef.transport === 'tui-bridge') continue;
      if (typeof sessionService.getRouteForSession !== 'function') continue;
      const routeKey = sessionService.getRouteForSession(session.id);
      if (!routeKey) continue;
      healthPoller.track(session.id, session.agentRef);
      restored++;
    }
    if (restored > 0) logger.info('restored health pollers on startup', { count: restored });
  }

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
    const hookResult = installHookPlugin({
      opencodeConfigDir: config.opencodeConfigDir,
      walkerPort: adminConfig.port,
      walkerToken: adminConfig.token || '',
      enabled: config.walkerOpencodeHookEnabled !== false,
      heartbeatIntervalMs: config.opencodeTuiHeartbeatIntervalMs ?? 30000,
    });
    if (hookResult.installed) {
      logger.info('hook plugin installed', { path: hookResult.path });
    } else if (hookResult.reason && hookResult.reason !== 'disabled') {
      logger.info('hook plugin not installed', { reason: hookResult.reason, path: hookResult.path || '' });
    }
    await platform.start();
    if (adminServer) {
      const result = await adminServer.start();
      if (result && result.ok && !result.disabled) {
        logger.info('admin console started', { host: result.host, port: result.port });
      }
    }
    _restoreHealthPollers();
    logger.info('walker started successfully');
  }

  /**
   * 停止 Walker 应用，关闭管理端 HTTP 服务和飞书平台连接
   * 同步触发 admin server 关闭（不等待 Promise 完成），与原始飞书 stop 行为一致
   */
  async function stop() {
    logger.info('walker stopping');
    healthPoller.stop();
    if (dispatcher && typeof dispatcher.destroy === 'function') {
      dispatcher.destroy();
    }
    if (tuiBridge && typeof tuiBridge.close === 'function') tuiBridge.close();
    await platform.stop();
    logger.info('feishu platform stopped');
    if (adminServer) {
      await adminServer.stop();
      logger.info('admin console stopped');
    }
    logger.info('walker stopped');
  }

  return { start, stop, platform, dispatcher, sessionService, registry, adminServer, runtime, attachmentService, eventStore, healthPoller, tuiBridge };
}

function normalizeReplyCtx(replyCtx) {
  if (replyCtx && typeof replyCtx === 'object') return replyCtx;
  if (replyCtx == null) return {};
  return { messageId: replyCtx };
}

module.exports = { createApp };
