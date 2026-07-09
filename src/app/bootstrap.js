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
const { createLogger } = require('../core/logger');
const path = require('path');

const logger = createLogger('bootstrap');

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
  });

  const registry = new DriverRegistryClass();
  registry.register('opencode', opencodeDriver);
  registry.register('claude', stubClaude());
  registry.register('codex', stubCodex());

  const dedup = new MessageDedupClass({ windowMs: 300000 });
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

  async function start() {
    logger.info('walker starting', { agent: config.walkerDefaultAgent, runtime: config.walkerDefaultRuntime });
    await platform.start();
    logger.info('walker started successfully');
  }

  function stop() {
    logger.info('walker stopping');
    platform.stop();
    logger.info('walker stopped');
  }

  return { start, stop, platform, dispatcher, sessionService, registry };
}

module.exports = { createApp };
