'use strict';

const { buildRouteKey } = require('../core/route-key');
const { AgentEvent } = require('../drivers/agent-driver');
const { createLogger } = require('../core/logger');
const { TurnStateManager } = require('./turn-state');
const { PromptHeartbeat } = require('./heartbeat');
const { ProgressRenderer } = require('./progress-renderer');
const { PermissionHandler } = require('./permission-handler');
const { QuestionHandler } = require('./question-handler');
const { recordEvent, recordMetric } = require('../admin/event-store');
const { validatePlatformEvent } = require('../platforms/platform-driver');

const logger = createLogger('message-dispatcher');
const DEFAULT_HEARTBEAT_INITIAL_MS = 30000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60000;
const DEFAULT_HEARTBEAT_STUCK_MS = 300000;
const ATTACH_RECENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

function getAgentRefId(agentRef) {
  if (!agentRef || typeof agentRef !== 'object') return '';
  return agentRef.opencodeSessionId || agentRef.claudeSessionId || agentRef.runtimeId || agentRef.sessionId || agentRef.id || '';
}

function hasAgentSessionRef(agentRef) {
  return Boolean(getAgentRefId(agentRef));
}

function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function sanitizeErrorReason(value) {
  return String(value || '')
    .replace(/(token|secret|api[_-]?key|password|credential)(\s*[=:]\s*)[^\s,;]+/gi, '$1$2[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]');
}

function shouldPersistAgentRef(agentRef) {
  if (!agentRef || typeof agentRef !== 'object') return false;
  if (agentRef.conversationReady === true) return true;
  return agentRef.transport === 'pty-attach' && Boolean(agentRef.claudeSessionId);
}

function isRecentAttachSession(session, now) {
  const updatedAt = Number(session && session.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return true;
  return updatedAt >= now - ATTACH_RECENT_WINDOW_MS;
}

function filterRecentAttachSessions(sessions, now) {
  return (sessions || []).filter((session) => isRecentAttachSession(session, now));
}

/**
 * 消息调度器，处理飞书平台的消息和命令事件并协调 Agent 驱动与飞书 API 交互
 */
class MessageDispatcher {
  /**
   * 初始化消息调度器
   * @param {Object} options - 配置选项
   * @param {SessionService} options.sessionService - 会话管理服务
   * @param {DriverRegistry} options.driverRegistry - Agent 驱动注册表
   * @param {Object} options.feishuApi - 飞书 API 代理对象（含 replyText/replyCard/patchCard/addReaction/sendUnboundGuide/sendSessionList/sendAttachableSessionList/sendErrorCard/sendProgressCard/updateProgressCard）
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
    this.eventStore = options.eventStore;
    this.routeMode = options.routeMode || 'thread';
    this.reactionEmoji = options.reactionEmoji || '';
    this.doneEmoji = options.doneEmoji || '';
    this.progressStyle = options.progressStyle || 'card';
    this.defaultAgent = options.defaultAgent || 'opencode';
    this.defaultCwd = options.defaultCwd || process.cwd();
    this.defaultModel = options.defaultModel || '';
    this.runtimeType = options.runtimeType || 'windows';
    this.promptHeartbeatInitialMs = options.promptHeartbeatInitialMs || DEFAULT_HEARTBEAT_INITIAL_MS;
    this.promptHeartbeatIntervalMs = options.promptHeartbeatIntervalMs || DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.promptHeartbeatStuckMs = options.promptHeartbeatStuckMs || DEFAULT_HEARTBEAT_STUCK_MS;
    this.maxTurnTimeMins = options.maxTurnTimeMins || 0;
    this.nonFocusOutput = options.nonFocusOutput !== false;
    this.sessionWatchStops = new Map();
    this.sessionWatchBuffers = new Map();
    this.sessionWatchProgressCards = new Map();
    this.sessionWatchProgressPromises = new Map();
    this.sessionDoneInFlight = new Map();
    this.sessionDeliveredTexts = new Map();
    this.promptHeartbeatStops = new Map();
    this.turnStates = new Map();
    this.cancelledTurnSessions = new Set();
    this._turnSeq = 0;
    this._promptQueues = new Map();
    this._promptQueueTexts = new WeakMap();
    this._routeLocks = new Map();
    this.turnStateManager = new TurnStateManager({
      dispatcher: this,
      sessionService: this.sessionService,
      driverRegistry: this.driverRegistry,
      maxTurnTimeMins: this.maxTurnTimeMins,
    });
    this.promptHeartbeat = new PromptHeartbeat({
      dispatcher: this,
      feishuApi: this.feishuApi,
      initialMs: this.promptHeartbeatInitialMs,
      intervalMs: this.promptHeartbeatIntervalMs,
      stuckMs: this.promptHeartbeatStuckMs,
      progressStyle: this.progressStyle,
    });
    this.progressRenderer = new ProgressRenderer({
      dispatcher: this,
      feishuApi: this.feishuApi,
      progressStyle: this.progressStyle,
      doneEmoji: this.doneEmoji,
      nonFocusOutput: this.nonFocusOutput,
      defaultModel: this.defaultModel,
    });
    this.permissionHandler = new PermissionHandler({
      dispatcher: this,
      feishuApi: this.feishuApi,
      sessionService: this.sessionService,
    });
    this.questionHandler = new QuestionHandler({
      feishuApi: this.feishuApi,
      sessionService: this.sessionService,
      driverRegistry: this.driverRegistry,
    });
  }

  /**
   * 处理飞书平台传入的消息事件，路由到对应会话并调用 Agent 驱动响应
   * @param {Object} event - 消息事件对象，包含 messageId、chatId、text 等字段
   * @returns {Promise<string>} 处理结果标识（duplicate/unbound/error/prompted）
   */
  async handleIncomingMessage(event) {
    if (this._destroyed) {
      logger.warn('dispatcher destroyed, ignoring incoming message');
      return 'destroyed';
    }
    logger.info('incoming text message received', {
      messageId: event.messageId,
      chatId: event.chatId,
      rootId: event.rootId || null,
      textLength: event.text ? event.text.length : 0,
    });

    if (this.dedup.isDuplicate(event.messageId, event.createTime)) {
      logger.info('skipping duplicate message', { messageId: event.messageId });
      return 'duplicate';
    }

    let routeKey = event.routeKey || buildRouteKey(event, this.routeMode);
    logger.info('message accepted by dedup', { messageId: event.messageId, routeKey });
    this._recordAdminMetric('messages');
    this._recordAdminEvent({
      type: 'message.received',
      routeKey,
      message: 'incoming message received',
      data: {
        messageId: event.messageId || '',
        chatId: event.chatId || '',
        rootId: event.rootId || '',
        textLength: event.text ? event.text.length : 0,
      },
    });

    let current = this.sessionService.getCurrent(routeKey);
    if (!current && this.routeMode === 'thread' && event.rootId && event.chatId) {
      const fallbackRouteKey = buildRouteKey({ ...event, rootId: '' }, this.routeMode);
      if (fallbackRouteKey !== routeKey) {
        const fallbackCurrent = this.sessionService.getCurrent(fallbackRouteKey);
        if (fallbackCurrent) {
          logger.info('thread route unbound, falling back to chat root route', {
            messageId: event.messageId,
            routeKey,
            fallbackRouteKey,
          });
          routeKey = fallbackRouteKey;
          current = fallbackCurrent;
        }
      }
    }

    if (!current) {
      logger.info('route not bound, sending guide card', { routeKey });
      this._sendFeishu('sendUnboundGuide', [this._replyCtx(event), routeKey]);
      return 'unbound';
    }

    if (routeKey && typeof this.sessionService.touchRoute === 'function') {
      this.sessionService.touchRoute(routeKey);
    }

    if (this.reactionEmoji) {
      this._sendFeishu('addReaction', [event.messageId, this.reactionEmoji]);
    }

    const driver = this.driverRegistry.get(current.agent);
    if (!driver) {
      logger.error('driver not found', { agent: current.agent });
      this._sendFeishu('sendErrorCard', [this._replyCtx(event), 'Agent driver not found: ' + current.agent]);
      return 'error';
    }

    let agentRef = current.agentRef;
    if (!hasAgentSessionRef(agentRef)) {
      logger.error('session has no agentRef', { sessionId: current.id });
      this._sendFeishu('sendErrorCard', [this._replyCtx(event), 'Session has no active agent reference']);
      return 'error';
    }
    if (current.agent === 'claude') {
      const prepared = await this._prepareClaudeAgentRef(current, driver, event);
      if (prepared.error) return 'error';
      agentRef = prepared.agentRef;
    }

    this.sessionService.markRunning(current.id);
    this._ensureWatch(current, event.chatId);
    logger.info('route bound, prompting driver', {
      messageId: event.messageId,
      routeKey,
      sessionId: current.id,
      agent: current.agent,
      agentRefId: getAgentRefId(agentRef),
      opencodeSessionId: agentRef.opencodeSessionId,
      claudeSessionId: agentRef.claudeSessionId,
    });

    const promptEvent = event.routeKey === routeKey ? event : { ...event, routeKey };
    return this._enqueueRouteLock(routeKey, () => this._enqueuePrompt(current, promptEvent, driver, agentRef));
  }

  async handlePlatformMessage(event) {
    const validation = validatePlatformEvent(event);
    if (!validation.ok) {
      logger.warn('invalid platform event rejected', { errors: validation.errors });
      this._recordAdminEvent({
        type: 'platform.invalid_event',
        level: 'warn',
        routeKey: event && event.routeKey || '',
        message: 'invalid platform event',
        data: { errors: validation.errors },
      });
      return { error: 'BAD_REQUEST', message: 'invalid platform event', details: validation.errors };
    }
    this._recordAdminEvent({
      type: 'platform.message_received',
      routeKey: event.routeKey,
      message: 'platform message received',
      data: { platform: event.platform, messageId: event.messageId, userId: event.userId },
    });
    try {
      return await this.handleIncomingMessage({
        type: 'text',
        text: event.text,
        routeKey: event.routeKey,
        chatId: event.chatId || event.raw && event.raw.message && event.raw.message.chat_id || '',
        messageId: event.messageId,
        openId: event.userId,
        rootId: event.rootId || '',
        parentId: event.parentId || '',
        createTime: event.createTime,
        attachments: event.attachments,
        platformEvent: event,
      });
    } catch (err) {
      logger.error('platform adapter dispatch failed', { platform: event.platform, messageId: event.messageId, error: err && err.message ? err.message : String(err) });
      this._recordAdminEvent({
        type: 'platform.adapter_error',
        level: 'error',
        routeKey: event.routeKey,
        message: err && err.message ? err.message : String(err),
        data: { platform: event.platform, messageId: event.messageId },
      });
      return { error: 'adapter_error', message: err && err.message ? err.message : String(err) };
    }
  }

  /**
   * 将 prompt 请求排入 session 串行队列，同一 session 并发消息排队执行
   * @param {Object} session - 会话对象
   * @param {Object} event - 消息事件
   * @param {Object} driver - Agent 驱动
   * @param {Object} agentRef - Agent 引用
   * @returns {Promise<string>} 处理结果标识
   */
  _enqueuePrompt(session, event, driver, agentRef) {
    const sessionId = session.id;
    const task = async () => {
      const token = ++this._turnSeq;
      try {
        const progressCardId = this.progressStyle === 'card'
          ? await this._callFeishu('sendProgressCard', [this._replyCtx(event), sessionId, undefined], null, { sessionId, session })
          : null;
        const stopHeartbeat = this._startPromptHeartbeat(session, progressCardId);
        const turnState = this._startTurnState(session, event, driver, agentRef, token, progressCardId, stopHeartbeat);
        const model = this._resolveSessionModel(session);
        const promptStartedAt = Date.now();
        this._recordAdminMetric('prompts');
        this._recordAdminMetric('activeTurns');
        if (progressCardId) this._recordAdminMetric('cardDeliveries');
        const events = await driver.prompt(agentRef, event.text, { model, signal: turnState.abortController.signal });
        if (shouldPersistAgentRef(agentRef)) {
          session.agentRef = agentRef;
          this._updateSessionRuntimeField(session.id, 'agentRef', agentRef);
        }
        await this._capturePromptRuntime(session, model, events, driver, agentRef);
        this._recordAdminMetric('promptDurationMs', Date.now() - promptStartedAt);
        if (this._isTurnCancelled(sessionId, token)) {
          this._clearTurnState(sessionId, token);
          return 'cancelled';
        }
        this._clearTurnState(sessionId, token);
        logger.info('driver prompt completed', {
          messageId: event.messageId,
          sessionId,
          eventCount: events.length,
        });
        const errorEvent = events.find((e) => e.type === AgentEvent.TYPE_ERROR);
        if (errorEvent && errorEvent.data && errorEvent.data.message) {
          logger.error('driver prompt returned error event', {
            messageId: event.messageId,
            sessionId,
            error: errorEvent.data.message,
          });
          this._recordAdminMetric('errors');
          this._recordAdminEvent({
            type: 'prompt.error',
            level: 'error',
            sessionId,
            routeKey: event.routeKey || buildRouteKey(event, this.routeMode),
            message: errorEvent.data.message,
            data: { messageId: event.messageId || '' },
          });
          this._markErrorIfActive(sessionId, errorEvent.data.message);
          await this._callFeishu('sendErrorCard', [this._replyCtx(event), errorEvent.data.message], null, { sessionId });
          return 'error';
        }
        this._touchTurnState(turnState);
        await this._renderEvents(session, event, events, progressCardId);
        this._markIdleIfActive(sessionId);
        this._recordAdminEvent({
          type: 'prompt.completed',
          sessionId,
          routeKey: event.routeKey || buildRouteKey(event, this.routeMode),
          message: 'prompt completed',
          data: { messageId: event.messageId || '', eventCount: events.length },
        });
        return 'prompted';
      } catch (err) {
        if (this._isTurnCancelled(sessionId, token)) {
          this._clearTurnState(sessionId, token);
          return 'cancelled';
        }
        const isTransportRecovering = this._isTransportRecoverableError(err);
        if (isTransportRecovering) {
          logger.warn('driver prompt transport interrupted, recovering', {
            messageId: event.messageId,
            sessionId,
            error: err.message,
            code: err.code || 'unknown',
          });
          this._clearTurnState(sessionId, token);
          this._markIdleIfActive(sessionId);
          return 'recovering';
        }
        if (err && (err.code === 'TUI_RUNTIME_UNAVAILABLE' || err.code === 'TUI_RUNTIME_STALE')) {
          logger.warn('tui runtime unavailable, prompting user to reconnect', {
            messageId: event.messageId,
            sessionId,
            error: err.message,
            code: err.code,
          });
          this._clearTurnState(sessionId, token);
          this._markIdleIfActive(sessionId);
          const hint = err.code === 'TUI_RUNTIME_STALE'
            ? 'OpenCode TUI 连接已失活，请重新启动 OpenCode TUI 后再发消息；或使用 /attach 重新绑定已有会话。'
            : 'OpenCode TUI 未连接，请先启动 OpenCode TUI 并确认会话已注册，再发送消息；或使用 /new 创建新会话。';
          await this._callFeishu('replyText', [this._replyCtx(event), hint], null, { sessionId });
          return 'tui_unavailable';
        }
        this._clearTurnState(sessionId, token);
        logger.error('driver prompt failed', {
          messageId: event.messageId,
          sessionId,
          error: err.message,
          code: err.code || 'unknown',
        });
        this._recordAdminMetric('errors');
        this._recordAdminEvent({
          type: 'prompt.failed',
          level: 'error',
          sessionId,
          routeKey: event.routeKey || buildRouteKey(event, this.routeMode),
          message: err.message,
          data: { messageId: event.messageId || '', code: err.code || 'unknown' },
        });
        this._markErrorIfActive(sessionId, err.message);
        await this._callFeishu('sendErrorCard', [this._replyCtx(event), err.message], null, { sessionId });
        return 'error';
      }
    };

    const prev = this._promptQueues.get(sessionId) || Promise.resolve();
    const next = prev.then(task, task);
    this._promptQueues.set(sessionId, next);
    this._promptQueueTexts.set(next, String(event.text || '').trim());

    next.finally(() => {
      if (this._promptQueues.get(sessionId) === next) {
        this._promptQueues.delete(sessionId);
      }
    });

    return next;
  }

  /**
   * 处理飞书命令（/new、/attach、/list、/use、/current、/stop、/cancel、/status、/ps、/delete、/clear、/model、/help、/agents、/runtime）
   * @param {Object} cmd - 命令对象，包含 name、args、routeKey、messageId、chatId 等字段
   * @returns {Promise<Object>} 命令执行结果
   */
  async handleCommand(cmd) {
    if (cmd.platformEvent) {
      const validation = validatePlatformEvent(cmd.platformEvent);
      if (!validation.ok) {
        logger.warn('invalid platform event rejected', { errors: validation.errors });
        this._recordAdminEvent({
          type: 'platform.invalid_event',
          level: 'warn',
          routeKey: cmd.platformEvent && cmd.platformEvent.routeKey || cmd.routeKey || '',
          message: 'invalid platform event',
          data: { errors: validation.errors },
        });
        return { error: 'BAD_REQUEST', message: 'invalid platform event', details: validation.errors };
      }
      this._recordAdminEvent({
        type: 'platform.message_received',
        routeKey: cmd.platformEvent.routeKey,
        message: 'platform message received',
        data: { platform: cmd.platformEvent.platform, messageId: cmd.platformEvent.messageId, userId: cmd.platformEvent.userId },
      });
    }
    const dedupArgs = (cmd.args || []).join(' ');
    const dedupKey = cmd.messageId ? 'cmd:' + cmd.messageId + ':' + cmd.name + ':' + dedupArgs : null;
    const isModelPage = cmd.name === 'model' && cmd.args && cmd.args[0] === '--page';
    const isListPage = cmd.name === 'list' && cmd.args && cmd.args[0] === '--page';
    const isAttachPage = cmd.name === 'attach' && cmd.args && (cmd.args[0] === '--page' || (cmd.args[0] === 'claude' && cmd.args[1] === '--page'));
    const isAttachSearch = cmd.name === 'attach' && cmd.args && (cmd.args[0] === '--search' || (cmd.args[0] === 'claude' && cmd.args[1] === '--search'));
    if (cmd.name !== 'answer' && !isModelPage && !isListPage && !isAttachPage && !isAttachSearch && dedupKey && this.dedup.isDuplicate(dedupKey)) {
      logger.info('skipping duplicate command', { command: cmd.name, messageId: cmd.messageId });
      return { duplicate: true };
    }
    this._recordAdminMetric('commands');
    this._recordAdminEvent({
      type: 'command.received',
      routeKey: cmd.routeKey || '',
      message: '/' + (cmd.name || ''),
      data: {
        command: cmd.name || '',
        messageId: cmd.messageId || '',
        chatId: cmd.chatId || '',
      },
    });

    try {
      const handlers = {
        new: () => this._enqueueRouteLock(cmd.routeKey, () => this._withRouteTouch(cmd.routeKey, () => this._cmdNew(cmd))),
        attach: () => this._enqueueRouteLock(cmd.routeKey, () => this._withRouteTouch(cmd.routeKey, () => this._cmdAttach(cmd))),
        clear: async () => {
          const preflight = await this._preflightClear(cmd);
          if (preflight) return preflight;
          return this._enqueueRouteLock(cmd.routeKey, () => this._withRouteTouch(cmd.routeKey, () => this._cmdClear(cmd)));
        },
        model: () => this._withRouteTouch(cmd.routeKey, () => this._cmdModel(cmd)),
        cancel: () => this._withRouteTouch(cmd.routeKey, () => this._cmdCancel(cmd)),
        status: () => this._withRouteTouch(cmd.routeKey, () => this._cmdStatus(cmd)),
        ps: () => this._withRouteTouch(cmd.routeKey, () => this._cmdStatus(cmd)),
        list: () => this._withRouteTouch(cmd.routeKey, () => this._cmdList(cmd)),
        use: () => this._withRouteTouch(cmd.routeKey, () => this._cmdUse(cmd)),
        current: () => this._withRouteTouch(cmd.routeKey, () => this._cmdCurrent(cmd)),
        stop: () => this._withRouteTouch(cmd.routeKey, () => this._cmdStop(cmd)),
        delete: () => this._withRouteTouch(cmd.routeKey, () => this._cmdDelete(cmd)),
        help: () => this._cmdHelp(cmd),
        agents: () => this._cmdAgents(cmd),
        runtime: () => this._cmdRuntime(cmd),
        permit: () => this._cmdPermit(cmd),
        answer: () => this.questionHandler.handleAnswer(cmd),
      };
      const handler = handlers[cmd.name];
      if (handler) {
        const result = await handler();
        if (cmd.name === 'answer') {
          logger.info('answer command handled', { result, args: cmd.args, messageId: cmd.messageId, routeKey: cmd.routeKey, formKeys: cmd.formValue ? Object.keys(cmd.formValue) : [] });
        }
        return result;
      }
      return { unknown: cmd.name };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      logger.error('command handler failed', { command: cmd.name, error: message });
      await this._callFeishu('sendErrorCard', [this._replyCtx(cmd), message]);
      return { error: 'command_failed', message };
    }
  }

  _withRouteTouch(routeKey, fn) {
    return Promise.resolve(fn()).then((result) => {
      if (routeKey && typeof this.sessionService.touchRoute === 'function') {
        this.sessionService.touchRoute(routeKey);
      }
      return result;
    });
  }

  /**
   * /clear 锁外快速预检：无绑定、session running、活动 turn 或未完成 prompt queue 时立即回复
   * @param {Object} cmd - 命令对象
   * @returns {Promise<Object|null>} 拒绝时返回结果对象，通过时返回 null
   */
  async _preflightClear(cmd) {
    const routeKey = cmd.routeKey;
    const current = this.sessionService.getCurrent(routeKey);
    if (!current) {
      await this._callFeishu('replyText', [this._replyCtx(cmd), 'No session bound to this conversation. Use /new or /attach first.']);
      return { noSession: true };
    }
    if (current.status === 'running') {
      await this._callFeishu('replyText', [this._replyCtx(cmd), 'Session is running. Run /cancel before /clear.']);
      return { busy: true, rejected: true };
    }
    if (this.turnStates.has(current.id)) {
      await this._callFeishu('replyText', [this._replyCtx(cmd), 'An active turn is in progress. Run /cancel before /clear.']);
      return { busy: true, rejected: true };
    }
    if (this._promptQueues.get(current.id)) {
      await this._callFeishu('replyText', [this._replyCtx(cmd), 'A prompt is still pending. Run /cancel before /clear.']);
      return { busy: true, rejected: true };
    }
    const driver = this.driverRegistry.get(current.agent);
    if (driver && typeof driver.hasClearPending === 'function' && current.agentRef && driver.hasClearPending(current.agentRef)) {
      await this._callFeishu('replyText', [this._replyCtx(cmd), 'A clear is already in progress on this TUI runtime.']);
      return { busy: true, rejected: true };
    }
    return null;
  }

  /**
   * /clear 命令：在当前 TUI session 新建空上下文，保留旧会话
   */
  async _cmdClear(cmd) {
    const routeKey = cmd.routeKey;
    const current = this.sessionService.getCurrent(routeKey);
    if (!current) {
      await this._callFeishu('replyText', [this._replyCtx(cmd), 'No session bound to this conversation. Use /new or /attach first.']);
      return { noSession: true };
    }
    if (current.status === 'running') {
      await this._callFeishu('replyText', [this._replyCtx(cmd), 'Session is running. Run /cancel before /clear.']);
      return { busy: true, rejected: true };
    }
    if (this.turnStates.has(current.id)) {
      await this._callFeishu('replyText', [this._replyCtx(cmd), 'An active turn is in progress. Run /cancel before /clear.']);
      return { busy: true, rejected: true };
    }
    if (this._promptQueues.get(current.id)) {
      await this._callFeishu('replyText', [this._replyCtx(cmd), 'A prompt is still pending. Run /cancel before /clear.']);
      return { busy: true, rejected: true };
    }

    if (current.agent !== 'opencode') {
      await this._callFeishu('replyText', [this._replyCtx(cmd), '/clear only supports opencode TUI sessions.']);
      return { rejected: true };
    }
    const agentRef = current.agentRef;
    if (!agentRef || agentRef.transport !== 'tui-bridge' || !agentRef.opencodeSessionId) {
      await this._callFeishu('replyText', [this._replyCtx(cmd), '/clear requires a TUI bridge session. Run /new or /attach first.']);
      return { rejected: true };
    }

    const driver = this.driverRegistry.get(current.agent);
    if (!driver || typeof driver.clearSession !== 'function') {
      await this._callFeishu('replyText', [this._replyCtx(cmd), 'Current agent driver does not support clearSession.']);
      return { rejected: true };
    }

    const result = await driver.clearSession(agentRef);
    const text = 'Cleared session ' + current.id + ' (opencode ' + result.oldSessionId + ') → new session ' + result.walkerSessionId + ' (opencode ' + result.newSessionId + '). TUI window kept.';
    await this._callFeishu('replyText', [this._replyCtx(cmd), text]);
    return { cleared: true, oldSessionId: result.oldSessionId, newSessionId: result.newSessionId, walkerSessionId: result.walkerSessionId };
  }

  /**
   * /new 命令：创建新 Walker session 并绑定 routeKey
   */
  async _cmdNew(cmd) {
    const routeKey = cmd.routeKey;
    const current = this.sessionService.getCurrent(routeKey);
    if (current) {
      const pendingPrompt = this._promptQueues.get(current.id);
      if (pendingPrompt) await pendingPrompt.catch(() => {});
    }
    const args = [];
    let cwd = this.defaultCwd;
    for (let i = 0; i < cmd.args.length; i += 1) {
      if (cmd.args[i] !== '--cwd') {
        args.push(cmd.args[i]);
        continue;
      }
      const value = cmd.args[i + 1];
      if (!value) {
        await this._callFeishu('sendErrorCard', [this._replyCtx(cmd), 'Usage: /new [agent] [title] --cwd <path>']);
        return { error: 'missing_cwd' };
      }
      cwd = value;
      i += 1;
    }
    const agentName = args[0] || this.defaultAgent;
    const title = args[1] || '';
    const driver = this.driverRegistry.get(agentName);

    if (!driver) {
      await this._callFeishu('sendErrorCard', [this._replyCtx(cmd), 'Agent not found: ' + agentName]);
      return { error: 'driver_not_found' };
    }

    await driver.ensureReady();
    const inheritedModel = this._resolveInheritedModel(current);
    const agentRef = await driver.createSession({ title, cwd, model: inheritedModel });

    const sessionTitle = title || ('session ' + this._agentRefLabel(agentRef));
    const session = this.sessionService.createSession({
      route: routeKey,
      agent: agentName,
      title: sessionTitle,
      runtime: this.runtimeType,
      cwd,
      agentRef,
      model: inheritedModel,
    });

    logger.info('new session created via /new', { sessionId: session.id, agent: agentName, routeKey });
    this._watchSessionEvents(session, cmd, driver);
    await this._callFeishu('replyText', [this._replyCtx(cmd), this._formatSessionCreated(session, agentName)]);
    return { sessionId: session.id, agentRef };
  }

  /**
   * /attach 命令：发现并纳入已有 OpenCode 会话
   */
  async _cmdAttach(cmd) {
    const routeKey = cmd.routeKey;
    const current = this.sessionService.getCurrent(routeKey);
    if (current) {
      const pendingPrompt = this._promptQueues.get(current.id);
      if (pendingPrompt) await pendingPrompt.catch(() => {});
    }
    const args = cmd.args || [];
    if (args[0] === 'claude') return this._cmdAttachClaude(cmd);
    let targetOpencodeSessionId = '';
    let page;
    let search = '';
    let updateMessageId;

    if (args[0] === '--page') {
      page = args[1];
      updateMessageId = cmd.messageId;
      if (args[2] === '--search' && typeof args[3] === 'string') {
        search = args[3];
      }
    } else if (args[0] === '--search') {
      updateMessageId = cmd.messageId;
      if (cmd.formValue && typeof cmd.formValue.attach_search === 'string') {
        search = cmd.formValue.attach_search;
      }
    } else {
      targetOpencodeSessionId = args[0] || '';
    }

    const driver = this.driverRegistry.get('opencode');

    if (!driver) {
      await this._callFeishu('sendErrorCard', [this._replyCtx(cmd), 'Agent not found: opencode']);
      return { error: 'driver_not_found' };
    }
    if (typeof driver.listSessions !== 'function') {
      await this._callFeishu('sendErrorCard', [this._replyCtx(cmd), 'OpenCode driver does not support session discovery.']);
      return { error: 'list_sessions_not_supported' };
    }

    await driver.ensureReady();
    const extraCwds = this._collectKnownSessionCwds();
    const now = Date.now();
    const remoteSessions = filterRecentAttachSessions(await driver.listSessions({ extraCwds }), now);
    const managedIds = this._managedOpencodeSessionIds();
    // 主动清理孤儿 session：Walker 管理中但 OpenCode 端已不存在的 session
    const remoteIds = new Set(remoteSessions.map((s) => s.id));
    for (const session of this.sessionService.listSessions()) {
      const ocId = session && session.agentRef && session.agentRef.opencodeSessionId;
      if (ocId && managedIds.has(ocId) && !remoteIds.has(ocId) && !this._isSessionRefActive(session)) {
        logger.info('proactive orphan cleanup in /attach', { sessionId: session.id, opencodeSessionId: ocId });
        this.sessionService.deleteSession(session.id);
        managedIds.delete(ocId);
      }
    }
    const routeCwd = typeof this.sessionService.getRouteCwd === 'function'
      ? this.sessionService.getRouteCwd(routeKey)
      : '';
    const candidates = remoteSessions.filter((session) => session && session.id && !managedIds.has(session.id));

    if (!targetOpencodeSessionId) {
      const claudeDriver = this.driverRegistry.get('claude');
      let claudeSessions = [];
      let managedClaudeIds = new Set();
      if (claudeDriver && claudeDriver !== driver && typeof claudeDriver.listSessions === 'function') {
        if (typeof claudeDriver.ensureReady === 'function') await claudeDriver.ensureReady();
        claudeSessions = filterRecentAttachSessions(await claudeDriver.listSessions({ extraCwds }), now);
        managedClaudeIds = this._managedClaudeSessionIds();
        const claudeRemoteIds = new Set(claudeSessions.map((s) => s.id));
        for (const session of this.sessionService.listSessions()) {
          const csId = session && session.agent === 'claude' && session.agentRef && session.agentRef.claudeSessionId;
          if (csId && managedClaudeIds.has(csId) && !claudeRemoteIds.has(csId) && !this._isSessionRefActive(session)) {
            logger.info('proactive orphan cleanup in /attach mixed', { sessionId: session.id, claudeSessionId: csId });
            this.sessionService.deleteSession(session.id);
            managedClaudeIds.delete(csId);
          }
        }
      }
      const mixedSessions = remoteSessions
        .map((session) => ({ ...session, agent: 'opencode' }))
        .concat(claudeSessions.map((session) => ({ ...session, agent: 'claude' })))
        .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
      if (this.feishuApi.sendAttachableSessionList) {
        await this._callFeishu('sendAttachableSessionList', [this._replyCtx(cmd), mixedSessions, {
          managedIds: Array.from(managedIds),
          managedClaudeIds: Array.from(managedClaudeIds),
          routeKey: cmd.routeKey,
          crossProject: new Set(mixedSessions.map((session) => session.cwd || '')).size > 1,
          page,
          search,
          updateMessageId,
          agent: 'mixed',
        }]);
      } else {
        await this._callFeishu('replyText', [this._replyCtx(cmd), this._formatAttachableSessions(candidates)]);
      }
      return { candidates, routeCwd: routeCwd || '' };
    }

    const target = remoteSessions.find((session) => session.id === targetOpencodeSessionId);
    if (!target) {
      // OpenCode 端找不到此 session，检查是否已在 Walker 管理中（孤儿检测）
      if (managedIds.has(targetOpencodeSessionId)) {
        const existing = this._findSessionByOpencodeId(targetOpencodeSessionId);
        if (existing) {
          if (this._isSessionRefActive(existing)) {
            this.sessionService.bindRoute(routeKey, existing.id);
            await this._callFeishu('replyText', [this._replyCtx(cmd), 'Bound to existing Walker session: ' + existing.id]);
            return { bound: existing.id };
          }
          // OpenCode 端已丢失，清理 Walker 中的孤儿引用
          logger.info('orphaned opencode session detected, cleaning up', {
            sessionId: existing.id,
            opencodeSessionId: targetOpencodeSessionId,
          });
          this.sessionService.deleteSession(existing.id);
          await this._callFeishu('sendErrorCard', [this._replyCtx(cmd),
            'OpenCode session not found (orphan cleaned): ' + targetOpencodeSessionId
            + '\n已自动清理失效引用，请发送 /attach 重新绑定新会话。']);
          return { orphanCleaned: true };
        }
      }
      await this._callFeishu('sendErrorCard', [this._replyCtx(cmd), 'OpenCode session not found: ' + targetOpencodeSessionId]);
      return { notFound: true };
    }
    if (managedIds.has(targetOpencodeSessionId)) {
      const existing = this._findSessionByOpencodeId(targetOpencodeSessionId);
      if (existing) {
        if (this._isSessionRefActive(existing)) {
          this.sessionService.bindRoute(routeKey, existing.id);
          await this._callFeishu('replyText', [this._replyCtx(cmd), 'Bound to existing Walker session: ' + existing.id]);
          return { bound: existing.id };
        }
        logger.info('existing session agentRef inactive, re-attaching', {
          sessionId: existing.id,
          opencodeSessionId: targetOpencodeSessionId,
        });
      }
    }

    return this._attachOpencodeSession(cmd, driver, target);
  }

  /**
   * 检查 Walker session 的 agentRef 是否仍然可用（TUI bridge session 时 runtime 仍在线；HTTP session 总是可用）
   * @param {Object} session - Walker session 对象
   * @returns {boolean}
   */
  _isSessionRefActive(session) {
    if (!session || !session.agentRef) return false;
    const driver = this.driverRegistry.get(session.agent || 'opencode');
    if (!driver || typeof driver.isSessionRefActive !== 'function') return true;
    return driver.isSessionRefActive(session.agentRef);
  }

  async _attachOpencodeSession(cmd, driver, remoteSession) {
    const agentRef = await driver.resumeSession({
      opencodeSessionId: remoteSession.id,
      serverUrl: driver.serverUrl,
      cwd: remoteSession.cwd || this.defaultCwd,
    });
    const session = this.sessionService.createSession({
      route: cmd.routeKey,
      agent: 'opencode',
      title: remoteSession.title || ('opencode ' + remoteSession.id.slice(0, 12)),
      runtime: this.runtimeType,
      cwd: agentRef.cwd || this.defaultCwd,
      agentRef,
    });
    this.sessionService.markIdle(session.id);
    this._watchSessionEvents(session, cmd, driver);
    await this._callFeishu('replyText', [this._replyCtx(cmd), 'OpenCode session attached: ' + session.id + ' (' + remoteSession.id + ')']);
    return { sessionId: session.id, agentRef };
  }

  async _cmdAttachClaude(cmd) {
    const driver = this.driverRegistry.get('claude');
    if (!driver) {
      await this._callFeishu('sendErrorCard', [this._replyCtx(cmd), 'Agent not found: claude']);
      return { error: 'driver_not_found' };
    }
    const args = cmd.args || [];
    const rest = args.slice(1);
    let targetClaudeSessionId = '';
    let page;
    let search = '';
    let updateMessageId;
    if (rest[0] === '--page') {
      page = rest[1];
      updateMessageId = cmd.messageId;
      if (rest[2] === '--search' && typeof rest[3] === 'string') search = rest[3];
    } else if (rest[0] === '--search') {
      updateMessageId = cmd.messageId;
      if (cmd.formValue && typeof cmd.formValue.attach_search === 'string') search = cmd.formValue.attach_search;
    } else {
      targetClaudeSessionId = rest[0] || '';
    }

    if (!targetClaudeSessionId) {
      if (typeof driver.ensureReady === 'function') await driver.ensureReady();
      const extraCwds = this._collectKnownSessionCwds();
      const remoteSessions = filterRecentAttachSessions(await driver.listSessions({ extraCwds }), Date.now());
      const managedIds = this._managedClaudeSessionIds();
      const remoteIds = new Set(remoteSessions.map((s) => s.id));
      // 主动清理孤儿 Claude session：Walker 管理中但本地历史已不存在的 session
      for (const session of this.sessionService.listSessions()) {
        const csId = session && session.agent === 'claude' && session.agentRef && session.agentRef.claudeSessionId;
        if (csId && managedIds.has(csId) && !remoteIds.has(csId) && !this._isSessionRefActive(session)) {
          logger.info('proactive orphan cleanup in /attach claude', { sessionId: session.id, claudeSessionId: csId });
          this.sessionService.deleteSession(session.id);
          managedIds.delete(csId);
        }
      }
      const routeCwd = typeof this.sessionService.getRouteCwd === 'function'
        ? this.sessionService.getRouteCwd(cmd.routeKey)
        : '';
      const candidates = remoteSessions.filter((session) => session && session.id && !managedIds.has(session.id));

      if (candidates.length === 1 && !search && !page) {
        return this._attachClaudeSession(cmd, driver, candidates[0]);
      }
      if (this.feishuApi.sendAttachableSessionList) {
        await this._callFeishu('sendAttachableSessionList', [this._replyCtx(cmd), remoteSessions, {
          managedIds: Array.from(managedIds),
          routeKey: cmd.routeKey,
          crossProject: new Set(remoteSessions.map((session) => session.cwd || '')).size > 1,
          page,
          search,
          updateMessageId,
          agent: 'claude',
        }]);
      } else {
        await this._callFeishu('replyText', [this._replyCtx(cmd), this._formatAttachableSessions(candidates)]);
      }
      return { candidates, routeCwd: routeCwd || '' };
    }

    if (!isUuid(targetClaudeSessionId)) {
      const message = 'Invalid or missing Claude session id: expected exact UUID for resume.';
      await this._callFeishu('sendErrorCard', [this._replyCtx(cmd), message]);
      return { error: 'invalid_claude_session_id', message };
    }
    if (typeof driver.ensureReady === 'function') await driver.ensureReady();
    const managedIds = this._managedClaudeSessionIds();
    if (managedIds.has(targetClaudeSessionId)) {
      const existing = this._findSessionByClaudeId(targetClaudeSessionId);
      if (existing && this._isSessionRefActive(existing)) {
        this.sessionService.bindRoute(cmd.routeKey, existing.id);
        await this._callFeishu('replyText', [this._replyCtx(cmd), 'Bound to existing Walker session: ' + existing.id]);
        return { bound: existing.id };
      }
      logger.info('existing claude session agentRef inactive, re-attaching', {
        sessionId: existing && existing.id, claudeSessionId: targetClaudeSessionId,
      });
    }
    let target = null;
    if (typeof driver.listSessions === 'function') {
      try {
        const remoteSessions = await driver.listSessions({ extraCwds: this._collectKnownSessionCwds() });
        target = remoteSessions.find((s) => s.id === targetClaudeSessionId) || null;
      } catch (_) { target = null; }
    }
    return this._attachClaudeSession(cmd, driver, { id: targetClaudeSessionId, cwd: (target && target.cwd) || this.defaultCwd });
  }

  async _attachClaudeSession(cmd, driver, remoteSession) {
    const agentRef = await driver.resumeSession({
      claudeSessionId: remoteSession.id,
      cwd: remoteSession.cwd || this.defaultCwd,
    });
    const session = this.sessionService.createSession({
      route: cmd.routeKey,
      agent: 'claude',
      title: remoteSession.title || ('claude ' + String(remoteSession.id).slice(0, 12)),
      runtime: this.runtimeType,
      cwd: agentRef.cwd || remoteSession.cwd || this.defaultCwd,
      agentRef,
    });
    this.sessionService.markIdle(session.id);
    this._watchSessionEvents(session, cmd, driver);
    await this._callFeishu('replyText', [this._replyCtx(cmd), 'Claude session attached: ' + session.id + ' (' + remoteSession.id + ')']);
    return { sessionId: session.id, agentRef };
  }

  async _prepareClaudeAgentRef(session, driver, event) {
    const agentRef = session && session.agentRef;
    if (!isUuid(agentRef && agentRef.claudeSessionId)) {
      const message = 'Invalid or missing Claude session id: cannot resume without exact UUID.';
      logger.warn('claude agentRef rejected before prompt', { sessionId: session && session.id, reason: 'invalid_claude_session_id' });
      await this._callFeishu('sendErrorCard', [this._replyCtx(event), message], null, { sessionId: session && session.id });
      return { error: 'invalid_claude_session_id', message };
    }
    if (agentRef.transport === 'pty-attach' && agentRef.runtimeId) {
      if (driver && typeof driver.isSessionRefActive === 'function' && driver.isSessionRefActive(agentRef)) return { agentRef };
    }
    if (!driver || typeof driver.resumeSession !== 'function') return { agentRef };
    const resumed = await driver.resumeSession(agentRef);
    const persisted = await this._updateCriticalSessionRuntimeField(session.id, 'agentRef', resumed);
    if (!persisted.ok) {
      const message = 'Failed to persist Claude runtime state before prompting. Please retry.';
      logger.warn('claude agentRef update failed before prompt', { sessionId: session && session.id, reason: sanitizeErrorReason(persisted.error && persisted.error.message) });
      await this._callFeishu('sendErrorCard', [this._replyCtx(event), message], null, { sessionId: session && session.id });
      return { error: 'claude_agent_ref_update_failed', message };
    }
    session.agentRef = resumed;
    return { agentRef: resumed };
  }

  /**
   * /list 命令：显示当前 route 下的 session 列表卡片（支持分页）
   */
  async _cmdList(cmd) {
    const sessions = this.sessionService.listSessionsInRoute(cmd.routeKey);
    const currentSession = this.sessionService.getCurrent(cmd.routeKey);
    const args = cmd.args || [];
    const isPageRequest = args[0] === '--page';
    const options = { routeKey: cmd.routeKey };
    if (isPageRequest) {
      options.page = args[1];
      options.updateMessageId = cmd.messageId;
    }
    await this._callFeishu('sendSessionList', [this._replyCtx(cmd), sessions, currentSession ? currentSession.id : null, options]);
    return { sessions };
  }

  /**
   * /use 命令：切换 route 的焦点 session 或移除焦点 session（/use off）
   */
  async _cmdUse(cmd) {
    const targetId = cmd.args[0];
    if (targetId === 'off') {
      const current = this.sessionService.getCurrent(cmd.routeKey);
      if (!current) {
        await this._callFeishu('replyText', [this._replyCtx(cmd), 'No focus session to remove.']);
        return { noFocus: true };
      }
      this.sessionService.removeSessionFromRoute(cmd.routeKey, current.id);
      await this._callFeishu('replyText', [this._replyCtx(cmd), 'Removed focus session: ' + current.id]);
      return { removed: current.id };
    }
    if (!targetId) {
      await this._callFeishu('sendErrorCard', [this._replyCtx(cmd), 'Usage: /use <session_id|off>']);
      return { error: 'missing_session_id' };
    }
    this.sessionService.setFocus(cmd.routeKey, targetId);
    await this._callFeishu('replyText', [this._replyCtx(cmd), 'Focus set to session: ' + targetId]);
    return { focus: targetId };
  }

  /**
   * /current 命令：查看当前 routeKey 绑定的 session
   */
  async _cmdCurrent(cmd) {
    const current = this.sessionService.getCurrent(cmd.routeKey);
    if (!current) {
      await this._callFeishu('replyText', [this._replyCtx(cmd), 'No session bound to this conversation.']);
    } else {
      await this._callFeishu('replyText', [this._replyCtx(cmd), 'Current session: ' + current.id + ' (' + current.agent + ', ' + current.status + ')']);
    }
    return { current };
  }

  /**
   * /stop 命令：停止当前绑定的 session
   */
  async _cmdStop(cmd) {
    const current = this.sessionService.getCurrent(cmd.routeKey);
    if (!current) {
      await this._callFeishu('replyText', [this._replyCtx(cmd), 'No session to stop.']);
      return { noSession: true };
    }
    const driver = this.driverRegistry.get(current.agent);
    if (driver && current.agentRef) {
      await driver.stop(current.agentRef);
    }
    this._stopSessionWatch(current.id);
    this.sessionService.stopSession(current.id);
    await this._callFeishu('replyText', [this._replyCtx(cmd), 'Session stopped: ' + current.id]);
    return { stopped: current.id };
  }

  async _cmdCancel(cmd) {
    const current = this.sessionService.getCurrent(cmd.routeKey);
    if (!current) {
      await this._callFeishu('replyText', [this._replyCtx(cmd), 'No running session to cancel.']);
      return { noSession: true };
    }
    const turnState = this.turnStates.get(current.id);
    if (!turnState || current.status !== 'running') {
      await this._callFeishu('replyText', [this._replyCtx(cmd), 'No running turn to cancel.']);
      return { noTurn: true };
    }

    const driver = this.driverRegistry.get(current.agent);
    await this._cancelTurn(current, driver, turnState, { reason: 'cancel' });
    await this._callFeishu('replyText', [this._replyCtx(cmd), 'Current turn cancelled: ' + current.id]);
    return { cancelled: current.id };
  }

  async _cmdStatus(cmd) {
    const current = this.sessionService.getCurrent(cmd.routeKey);
    if (!current) {
      await this._callFeishu('replyText', [this._replyCtx(cmd), 'No session bound to this conversation. Use /new or /attach first.']);
      return { noSession: true };
    }

    const sessions = this.sessionService.listSessionsInRoute(cmd.routeKey);
    const routeCwd = (typeof this.sessionService.getRouteCwd === 'function')
      ? this.sessionService.getRouteCwd(cmd.routeKey)
      : '';
    await this._callFeishu('replyText', [this._replyCtx(cmd), this._formatRouteStatus(cmd.routeKey, routeCwd, current, sessions)]);
    return { sessionId: current.id };
  }

  /**
   * /delete 命令：删除指定 session
   */
  async _cmdDelete(cmd) {
    const targetId = cmd.args[0];
    const session = this.sessionService.getSession(targetId);
    if (!session) {
      await this._callFeishu('replyText', [this._replyCtx(cmd), 'Session not found: ' + targetId]);
      return { notFound: true };
    }
    if (cmd.routeKey) {
      const sessionsInRoute = this.sessionService.listSessionsInRoute(cmd.routeKey);
      const belongs = sessionsInRoute.some((s) => s.id === targetId);
      if (!belongs) {
        await this._callFeishu('replyText', [this._replyCtx(cmd), 'Session ' + targetId + ' does not belong to this route']);
        return { forbidden: true };
      }
    }
    const driver = this.driverRegistry.get(session.agent);
    if (driver && session.agentRef) {
      await driver.delete(session.agentRef);
    }
    this._stopSessionWatch(session.id);
    this.sessionService.deleteSession(targetId);
    await this._callFeishu('replyText', [this._replyCtx(cmd), 'Session deleted: ' + targetId]);
    return { deleted: targetId };
  }

  /**
   * /help 命令：显示命令帮助说明
   */
  async _cmdHelp(cmd) {
    const { COMMAND_LIST, formatHelp } = require('../platform/feishu/commands');
    const helpText = formatHelp();
    if (this.feishuApi && typeof this.feishuApi.sendHelpCard === 'function') {
      const sent = await this._callFeishu('sendHelpCard', [this._replyCtx(cmd), COMMAND_LIST, { routeKey: cmd.routeKey }], null);
      if (sent) return { help: true };
    }
    await this._callFeishu('replyText', [this._replyCtx(cmd), helpText]);
    return { help: true };
  }

  /**
   * /agents 命令：列出可用 Agent 驱动
   */
  async _cmdAgents(cmd) {
    const agents = this.driverRegistry.list();
    await this._callFeishu('replyText', [this._replyCtx(cmd), 'Available agents: ' + agents.join(', ')]);
    return { agents };
  }

  /**
   * /runtime 命令：显示运行时环境信息（尚未完整实现）
   */
  async _cmdModel(cmd) {
    const args = cmd.args || [];
    const modelId = args[0];
    const isPageRequest = modelId === '--page';

    if (!modelId || isPageRequest) {
      const current = this.sessionService.getCurrent(cmd.routeKey);
      if (!current) {
        await this._callFeishu('replyText', [this._replyCtx(cmd), 'No session bound. Use /new or /attach first.']);
        return { noSession: true };
      }
      const driver = current.agent ? this.driverRegistry.get(current.agent) : null;
      if (!driver || typeof driver.listModels !== 'function') {
        await this._callFeishu('replyText', [this._replyCtx(cmd), '不支持模型列表']);
        return { error: 'list_models_not_supported' };
      }
      let models;
      try {
        if (typeof driver.ensureReady === 'function') await driver.ensureReady();
        models = await driver.listModels();
      } catch (_) {
        await this._callFeishu('replyText', [this._replyCtx(cmd), '不支持模型列表']);
        return { error: 'list_models_not_supported' };
      }
      const fallbackText = this._formatModelListText(models);
      if (this.feishuApi && typeof this.feishuApi.sendModelList === 'function') {
        const options = {
          routeKey: cmd.routeKey,
          currentModel: this._resolveSessionModel(current),
        };
        if (isPageRequest) {
          options.page = args[1];
          options.updateMessageId = cmd.messageId;
        }
        const sent = await this._callFeishu('sendModelList', [this._replyCtx(cmd), models, options], null);
        if (sent) return { models };
      }
      await this._callFeishu('replyText', [this._replyCtx(cmd), fallbackText]);
      return { models };
    }

    const current = this.sessionService.getCurrent(cmd.routeKey);
    if (!current) {
      await this._callFeishu('replyText', [this._replyCtx(cmd), 'No session bound. Use /new or /attach first.']);
      return { noSession: true };
    }

    const driver = current.agent ? this.driverRegistry.get(current.agent) : null;
    if (!driver || typeof driver.listModels !== 'function') {
      await this._callFeishu('replyText', [this._replyCtx(cmd), '不支持模型列表']);
      return { error: 'list_models_not_supported' };
    }
    let models;
    try {
      if (typeof driver.ensureReady === 'function') await driver.ensureReady();
      models = await driver.listModels();
    } catch (_) {
      await this._callFeishu('replyText', [this._replyCtx(cmd), '不支持模型列表']);
      return { error: 'list_models_not_supported' };
    }
    const resolved = this._resolveModelRef(modelId, models);
    if (resolved.error) {
      await this._callFeishu('replyText', [this._replyCtx(cmd), resolved.error]);
      return { error: resolved.error };
    }
    const modelRef = resolved.model;
    const display = modelRef.providerID
      ? modelRef.providerID + '/' + modelRef.modelID
      : modelRef.modelID;

    this.sessionService.updateSessionField(current.id, 'model', modelRef);

    await this._callFeishu('replyText', [this._replyCtx(cmd), 'Model set to: ' + display + ' for session ' + current.id]);
    return { model: modelRef, sessionId: current.id };
  }

  async _cmdPermit(cmd) {
    const args = cmd.args || [];
    if (args.length < 2) {
      await this._callFeishu('replyText', [this._replyCtx(cmd), '用法: /permit <permissionId> <allow|deny|always>']);
      return { error: 'missing_args' };
    }
    const permissionId = args[0];
    const response = args[1];
    if (response !== 'allow' && response !== 'deny' && response !== 'always') {
      await this._callFeishu('replyText', [this._replyCtx(cmd), '参数错误: 只接受 allow、deny 或 always。用法: /permit <permissionId> <allow|deny|always>']);
      return { error: 'invalid_response' };
    }
    const remember = response === 'always';
    const targetSessionId = args[2];
    let current = targetSessionId && typeof this.sessionService.getSession === 'function'
      ? this.sessionService.getSession(targetSessionId)
      : this.sessionService.getCurrent(cmd.routeKey);
    if (targetSessionId && current && typeof this.sessionService.getRouteForSession === 'function') {
      const routeKey = this.sessionService.getRouteForSession(targetSessionId);
      if (cmd.routeKey && routeKey && routeKey !== cmd.routeKey) current = null;
    }
    if (!current) {
      await this._callFeishu('replyText', [this._replyCtx(cmd), 'No session bound to this conversation.']);
      return { noSession: true };
    }
    const driver = this.driverRegistry.get(current.agent);
    if (!driver || typeof driver.replyPermission !== 'function') {
      await this._callFeishu('replyText', [this._replyCtx(cmd), '当前 agent 不支持权限回复']);
      return { error: 'driver_not_supported' };
    }
    try {
      await driver.replyPermission(current.agentRef, permissionId, response, remember);
      const patched = await this.permissionHandler.patchReplied(permissionId, response, current);
      if (!patched) {
        await this._callFeishu('replyText', [this._replyCtx(cmd), '已' + (response === 'deny' ? '拒绝' : '允许') + '权限请求 ' + permissionId]);
      }
      return { replied: permissionId, response };
    } catch (err) {
      logger.warn('permit command failed', {
        permissionId,
        error: err && err.message,
        code: err && err.code,
        deliveryPhase: err && err.deliveryPhase,
        sdkInvoked: err && err.sdkInvoked,
        safeToRetry: err && err.safeToRetry,
      });
      await this._callFeishu('replyText', [this._replyCtx(cmd), '权限不存在或已过期: ' + permissionId]);
      return { error: 'reply_failed' };
    }
  }

  _formatModelListText(models) {
    return this.progressRenderer._formatModelListText(models);
  }

  /**
   * 根据输入和模型目录解析规范化模型引用
   * @param {string} input - 用户输入（可能是 modelID 或 provider/modelID）
   * @param {Array<Object>} models - driver.listModels() 返回的模型目录
   * @returns {Object} - { model: {providerID, modelID} } 或 { error: string }
   */
  _resolveModelRef(input, models) {
    return this.progressRenderer._resolveModelRef(input, models);
  }

  async _cmdRuntime(cmd) {
    const runtimeType = this.runtimeType || 'windows';
    const cwd = this.defaultCwd;
    await this._callFeishu('replyText', [this._replyCtx(cmd), 'Runtime: ' + runtimeType + '\nDefault CWD: ' + cwd]);
    return { runtime: runtimeType };
  }

  _managedOpencodeSessionIds() {
    return new Set(this.sessionService.listSessions()
      .map((session) => session && session.agentRef && session.agentRef.opencodeSessionId)
      .filter(Boolean));
  }

  _collectKnownSessionCwds() {
    const cwds = new Set();
    if (this.defaultCwd) cwds.add(this.defaultCwd);
    try {
      for (const session of this.sessionService.listSessions()) {
        if (session && session.cwd) cwds.add(session.cwd);
        const ref = session && session.agentRef;
        if (ref && ref.cwd) cwds.add(ref.cwd);
      }
    } catch (_) {}
    return Array.from(cwds);
  }

  _findSessionByOpencodeId(opencodeSessionId) {
    const sessions = this.sessionService.listSessions().filter((session) => session
      && session.agentRef
      && session.agentRef.opencodeSessionId === opencodeSessionId);
    if (sessions.length === 0) return null;
    // 优先返回 agentRef 仍然可用的 session（TUI bridge runtime 仍在线，或 HTTP transport）
    for (const session of sessions) {
      if (this._isSessionRefActive(session)) return session;
    }
    return sessions[0];
  }

  _formatAttachableSessions(sessions) {
    if (!sessions || sessions.length === 0) return 'No attachable OpenCode sessions found.';
    return sessions.map((session) => session.title + ' ' + session.id + ' [' + (session.cwd || '(未设置)') + ']').join('\n');
  }

  _managedClaudeSessionIds() {
    return new Set(this.sessionService.listSessions()
      .filter((session) => session && session.agent === 'claude')
      .map((session) => session && session.agentRef && session.agentRef.claudeSessionId)
      .filter(Boolean));
  }

  _findSessionByClaudeId(claudeSessionId) {
    const sessions = this.sessionService.listSessions().filter((session) => session
      && session.agent === 'claude'
      && session.agentRef
      && session.agentRef.claudeSessionId === claudeSessionId);
    if (sessions.length === 0) return null;
    for (const session of sessions) {
      if (this._isSessionRefActive(session)) return session;
    }
    return sessions[0];
  }

  _formatRouteStatus(routeKey, routeCwd, focusSession, sessions) {
    const lines = [];
    lines.push('Route: ' + routeKey + (routeCwd ? ' (cwd: ' + routeCwd + ')' : ''));
    lines.push('  Active sessions: ' + sessions.length);
    lines.push('  Focus: ' + this._formatSessionSummary(focusSession));
    const others = sessions.filter((s) => s.id !== focusSession.id);
    if (others.length > 0) {
      const otherSummary = others.map((s) => s.id + ' (' + (s.status || '') + ')').join(', ');
      lines.push('  Other: [' + otherSummary + ']');
    }
    return lines.join('\n');
  }

  _formatSessionSummary(session) {
    const agentRef = (session && session.agentRef) || {};
    return (session.id || '') + ' (' + (session.agent || '') + ', ' + (session.status || '') + ', ' + (agentRef.opencodeSessionId || '') + ')';
  }

  _formatModel(model) {
    return this.progressRenderer._formatModel(model);
  }

  _appendModelFooter(text, session) {
    return this.progressRenderer._appendModelFooter(text, session);
  }

  /**
   * 解析 defaultModel（可能是 string 或对象）为规范化对象
   * @returns {Object|null} - { providerID, modelID } 或 null
   */
  _normalizeDefaultModel() {
    return this.progressRenderer._normalizeDefaultModel();
  }

  /**
   * 从 session.model 或 defaultModel 解析用于 prompt 的规范化模型对象
   * 兼容历史 string 类型 session.model，仅在读取边界规范化，不做持久化迁移
   * @param {Object} session - 会话对象
   * @returns {Object|null} - { providerID, modelID } 或 null
   */
  _resolveSessionModel(session) {
    return this.progressRenderer._resolveSessionModel(session);
  }

  /**
   * /new 时解析继承模型：优先当前焦点 session.model，否则 defaultModel
   * @param {Object} current - 当前焦点 session
   * @returns {Object|null} - { providerID, modelID } 或 null
   */
  _resolveInheritedModel(current) {
    return this.progressRenderer._resolveInheritedModel(current);
  }

  /**
   * 根据 progressStyle 选择渲染方式并渲染 Agent 事件列表
   * @param {Object} session - 当前会话对象
   * @param {Object} event - 原始消息事件
   * @param {AgentEvent[]} events - Agent 返回的事件列表
   * @returns {Promise<void>}
   */
  async _renderEvents(session, event, events, progressCardId) {
    return this.progressRenderer._renderEvents(session, event, events, progressCardId);
  }

  /**
   * 使用飞书卡片消息渲染 Agent 处理进度，实时更新卡片内容
   * @param {Object} session - 当前会话对象
   * @param {Object} event - 原始消息事件
   * @param {AgentEvent[]} events - Agent 返回的事件列表
   * @returns {Promise<void>}
   */
  async _renderCardProgress(session, event, displayEvents, progressCardId) {
    return this.progressRenderer._renderCardProgress(session, event, displayEvents, progressCardId);
  }

  _coalesceDisplayEvents(events, promptText) {
    return this.progressRenderer._coalesceDisplayEvents(events, promptText);
  }

  _pushDisplayEvent(displayEvents, agentEvent) {
    return this.progressRenderer._pushDisplayEvent(displayEvents, agentEvent);
  }

  _stripPromptEcho(text, promptText) {
    return this.progressRenderer._stripPromptEcho(text, promptText);
  }

  _collapseNumberedSnapshots(text) {
    return this.progressRenderer._collapseNumberedSnapshots(text);
  }

  _pushTextSnapshot(snapshots, nextText) {
    return this.progressRenderer._pushTextSnapshot(snapshots, nextText);
  }

  /**
   * 使用纯文本方式渲染 Agent 处理结果（仅输出文本事件内容）
   * @param {Object} event - 原始消息事件
   * @param {AgentEvent[]} events - Agent 返回的事件列表
   * @returns {Promise<void>}
   */
  async _renderLegacyProgress(session, event, displayEvents) {
    return this.progressRenderer._renderLegacyProgress(session, event, displayEvents);
  }

  _textFromDisplayEvents(displayEvents) {
    return this.progressRenderer._textFromDisplayEvents(displayEvents);
  }

  _watchSessionEvents(session, cmd, driver, options) {
    const chatId = (cmd && cmd.chatId) || this._chatIdFromRouteKey(session.route);
    logger.info('watchSessionEvents called', { sessionId: session.id, chatId, hasDriver: !!driver, agentRef: session.agentRef });
    if (!chatId || !driver || typeof driver.watchSession !== 'function') {
      logger.warn('watchSessionEvents skipped', { sessionId: session.id, chatId, hasDriver: !!driver, hasWatch: !!(driver && typeof driver.watchSession === 'function') });
      return;
    }
    this._stopSessionWatch(session.id);
    const stop = driver.watchSession(session.agentRef, {
      onEvent: (agentEvent) => this._handleWatchedSessionEvent(session, chatId, agentEvent, driver),
      onError: (err) => logger.warn('session watch failed', { sessionId: session.id, error: err.message }),
    }, options);
    if (typeof stop === 'function') this.sessionWatchStops.set(session.id, stop);
  }

  _chatIdFromRouteKey(routeKey) {
    if (!routeKey || typeof routeKey !== 'string') return '';
    const parts = routeKey.split(':');
    if (parts.length >= 2 && parts[0] === 'feishu') return parts[1];
    return '';
  }

  _ensureWatch(session, chatId) {
    if (!this._canWatchSession(session)) return;
    if (this.sessionWatchStops.has(session.id)) return;
    const driver = this.driverRegistry.get(session.agent || 'opencode');
    if (!driver || typeof driver.watchSession !== 'function') return;
    this._watchSessionEvents(session, { chatId }, driver);
  }

  _refreshWatch(session, chatId) {
    if (!this._canWatchSession(session)) return;
    const driver = this.driverRegistry.get(session.agent || 'opencode');
    if (!driver || typeof driver.watchSession !== 'function') return;
    this._watchSessionEvents(session, { chatId }, driver);
  }

  ensureWatchForSession(sessionId, options) {
    if (!sessionId) return;
    const session = this.sessionService.getSession(sessionId);
    if (!session) return;
    const routeKey = this.sessionService.getRouteForSession(sessionId);
    const chatId = this._chatIdFromRouteKey(routeKey);
    if (options && options.refresh) this._refreshWatch(session, chatId);
    else this._ensureWatch(session, chatId);
  }

  restoreWatches() {
    const sessions = this.sessionService.listSessions();
    let restored = 0;
    for (const session of sessions) {
      if (session.status === 'deleted') continue;
      if (!this._canWatchSession(session)) continue;
      const driver = this.driverRegistry.get(session.agent || 'opencode');
      if (!driver || typeof driver.watchSession !== 'function') continue;
      const routeKey = this.sessionService.getRouteForSession(session.id);
      if (!routeKey) continue;
      const chatId = this._chatIdFromRouteKey(routeKey);
      if (!chatId) continue;
      this._watchSessionEvents(session, { chatId }, driver, { skipHistoryPolling: true });
      restored++;
    }
    if (restored > 0) logger.info('restored session watches on startup', { count: restored });
  }

  _canWatchSession(session) {
    if (!session || !session.agentRef) return false;
    const driver = this.driverRegistry.get(session.agent || 'opencode');
    return !!(driver && typeof driver.watchSession === 'function' && hasAgentSessionRef(session.agentRef));
  }

  _agentRefLabel(agentRef) {
    const id = getAgentRefId(agentRef);
    return id ? String(id).slice(0, 12) : 'agent';
  }

  _formatSessionCreated(session, agentName) {
    let text = 'Session created: ' + session.id + ' (' + agentName + ')';
    const terminal = session.agentRef && session.agentRef.terminal;
    if (terminal && terminal.status && terminal.status !== 'active') {
      text += ' - terminal ' + terminal.status;
      if (terminal.reason) text += ': ' + terminal.reason;
    } else if (terminal && terminal.status === 'active') {
      text += ' - terminal active';
    }
    return text;
  }

  _stopSessionWatch(sessionId) {
    const stop = this.sessionWatchStops.get(sessionId);
    if (stop) {
      try { stop(); } catch (_) {}
    }
    this.sessionWatchStops.delete(sessionId);
    this.sessionWatchBuffers.delete(sessionId);
    this.sessionWatchProgressCards.delete(sessionId);
    this.sessionWatchProgressPromises.delete(sessionId);
    this.sessionDeliveredTexts.delete(sessionId);
    this._promptQueues.delete(sessionId);
    this._routeLocks.delete(sessionId);
    this.cancelledTurnSessions.delete(sessionId);
    this._stopPromptHeartbeat(sessionId);
    this._clearTurnState(sessionId);
  }

  _startTurnState(session, event, driver, agentRef, token, progressCardId, stopHeartbeat) {
    return this.turnStateManager._startTurnState(session, event, driver, agentRef, token, progressCardId, stopHeartbeat);
  }

  _startTurnTimeout(session, turnState) {
    return this.turnStateManager._startTurnTimeout(session, turnState);
  }

  async _cancelTurn(session, driver, turnState, options) {
    this._recordAdminMetric('timeoutsOrCancels');
    return this.turnStateManager._cancelTurn(session, driver, turnState, options);
  }

  _clearTurnState(sessionId, token) {
    return this.turnStateManager._clearTurnState(sessionId, token);
  }

  _isTransportRecoverableError(err) {
    return this.turnStateManager._isTransportRecoverableError(err);
  }

  _isTurnCancelled(sessionId, token) {
    return this.turnStateManager._isTurnCancelled(sessionId, token);
  }

  _isTurnSuppressed(sessionId) {
    return this.turnStateManager._isTurnSuppressed(sessionId);
  }

  _touchTurnState(turnState) {
    return this.turnStateManager._touchTurnState(turnState);
  }

  _startPromptHeartbeat(session, progressCardId) {
    return this.promptHeartbeat.start(session, progressCardId);
  }

  _stopPromptHeartbeat(sessionId) {
    return this.promptHeartbeat.stop(sessionId);
  }

  _formatDuration(ms) {
    return this.promptHeartbeat._formatDuration(ms);
  }

  async _handleWatchedSessionEvent(session, chatId, agentEvent, driver) {
    if (this._destroyed) return;
    if (this._isTurnSuppressed(session.id)) {
      this.sessionWatchBuffers.set(session.id, []);
      return;
    }
    const buffer = this.sessionWatchBuffers.get(session.id) || [];
    if (agentEvent.type === AgentEvent.TYPE_DONE) {
      const doneBuffer = buffer.slice();
      const promptAtArrival = this._promptQueues.get(session.id) || null;
      const promptTextAtArrival = promptAtArrival ? this._promptQueueTexts.get(promptAtArrival) || '' : '';
      this.sessionWatchBuffers.set(session.id, []);
      const run = async () => {
        if (this._destroyed) return;
        if (promptAtArrival) await promptAtArrival.catch(() => {});
        await this._capturePromptRuntime(session, null, doneBuffer.concat([agentEvent]), driver, session.agentRef, { skipDriverRuntimeLookup: true });
        const pendingProgress = this.sessionWatchProgressPromises.get(session.id);
        const displayEvents = this._coalesceDisplayEvents(doneBuffer, '');
        let text = this._textFromDisplayEvents(displayEvents);
        if (!text && doneBuffer.length === 0 && this._shouldFetchLastCompletedText(session, agentEvent)) {
          const fetched = await this._fetchLastCompletedText(session);
          if (fetched) {
            text = fetched;
            logger.info('watched session done: buffer empty, fetched from history', { sessionId: session.id, chatId, textLen: text.length });
          }
        }
        if (this._destroyed) return;
        logger.info('watched session done', { sessionId: session.id, chatId, textLen: text.length, bufferLen: doneBuffer.length });
        const finishProgress = async () => {
          if (pendingProgress) await pendingProgress.catch(() => {});
          const progressCardId = this.sessionWatchProgressCards.get(session.id);
          if (progressCardId && this.progressStyle === 'card') {
            await this._renderWatchProgressCard(session, chatId, displayEvents, progressCardId);
          }
          this.sessionWatchProgressCards.delete(session.id);
          this.sessionWatchProgressPromises.delete(session.id);
        };
        finishProgress().catch((err) => {
          logger.warn('watch progress card render failed', { sessionId: session.id, error: err && err.message });
          this.sessionWatchProgressCards.delete(session.id);
          this.sessionWatchProgressPromises.delete(session.id);
        });
        if (text) {
          if (this._hasDeliveredText(session.id, text)
            || (promptAtArrival && this._hasDeliveredPromptEcho(session.id, text, promptTextAtArrival))) {
            logger.info('skip duplicate watched session text', { sessionId: session.id, chatId, textLen: text.length });
            return;
          }
          const isFocus = this._isFocusSession(session);
          if (!isFocus && !this.nonFocusOutput) {
            logger.info('non-focus output suppressed', { sessionId: session.id, chatId });
            return;
          }
          this._rememberDeliveredText(session.id, text);
          const outputText = (!isFocus && this.nonFocusOutput)
            ? '[session: ' + session.id.slice(0, 8) + '] ' + text
            : text;
          if (this._destroyed) return;
          this._sendFeishu('sendMarkdown', [chatId, outputText], { sessionId: session.id, session });
        }
      };
      const prev = this.sessionDoneInFlight.get(session.id) || Promise.resolve();
      const rawNext = prev.then(run, run);
      const next = rawNext.catch((err) => {
        logger.warn('watched session done handling failed', { sessionId: session.id, error: err && err.message });
      });
      this.sessionDoneInFlight.set(session.id, next);
      next.finally(() => {
        if (this.sessionDoneInFlight.get(session.id) === next) this.sessionDoneInFlight.delete(session.id);
      }).catch(() => {});
      return next;
    }
    if (agentEvent.type === AgentEvent.TYPE_PERMISSION) {
      this._handlePermissionEvent(session, chatId, agentEvent);
      return;
    }
    if (agentEvent.type === AgentEvent.TYPE_PERMISSION_REPLIED) {
      return this._handlePermissionRepliedEvent(session, chatId, agentEvent);
    }
    if (agentEvent.type === AgentEvent.TYPE_QUESTION_ASKED) {
      this.questionHandler.handleAsked(session, chatId, this.sessionService.getRouteForSession(session.id), agentEvent);
      return;
    }
    if (agentEvent.type === AgentEvent.TYPE_QUESTION_REPLIED) {
      this.questionHandler.handleReplied(session, chatId, agentEvent);
      return;
    }
    if (agentEvent.type === AgentEvent.TYPE_QUESTION_REJECTED) {
      this.questionHandler.handleRejected(session, chatId, agentEvent);
      return;
    }
    if (this._isWatchProgressEvent(agentEvent.type) && this.progressStyle === 'card') {
      const prev = this.sessionWatchProgressPromises.get(session.id) || Promise.resolve();
      const next = prev.then(() => this._updateWatchProgressCard(session, chatId, agentEvent)).catch((err) => {
        logger.warn('watch progress card update failed', { sessionId: session.id, error: err && err.message });
      });
      this.sessionWatchProgressPromises.set(session.id, next);
    }
    buffer.push(agentEvent);
    this.sessionWatchBuffers.set(session.id, buffer);
  }

  _isWatchProgressEvent(eventType) {
    return eventType === AgentEvent.TYPE_TODO
      || eventType === AgentEvent.TYPE_COMPACTED
      || eventType === AgentEvent.TYPE_COMMAND_EXECUTED;
  }

  async _updateWatchProgressCard(session, chatId, agentEvent) {
    let cardId = this.sessionWatchProgressCards.get(session.id);
    if (!cardId) {
      cardId = await this._callFeishu('sendProgressCard', [{ chatId }, session.id], null, { sessionId: session.id });
      if (!cardId) return;
      if (this._isTurnSuppressed(session.id) || !this.sessionWatchBuffers.has(session.id)) return;
      this.sessionWatchProgressCards.set(session.id, cardId);
    }
    await this._callFeishu('updateProgressCard', [cardId, session.id, agentEvent], null, { sessionId: session.id });
  }

  async _renderWatchProgressCard(session, chatId, displayEvents, progressCardId) {
    for (const agentEvent of displayEvents) {
      if (agentEvent.type === AgentEvent.TYPE_TEXT) continue;
      if (agentEvent.type === AgentEvent.TYPE_PERMISSION || agentEvent.type === AgentEvent.TYPE_PERMISSION_REPLIED
        || agentEvent.type === AgentEvent.TYPE_QUESTION_ASKED || agentEvent.type === AgentEvent.TYPE_QUESTION_REPLIED
        || agentEvent.type === AgentEvent.TYPE_QUESTION_REJECTED) continue;
      if (agentEvent.type === AgentEvent.TYPE_MESSAGE_REMOVED || agentEvent.type === AgentEvent.TYPE_SESSION_LIFECYCLE || agentEvent.type === AgentEvent.TYPE_SERVER_CONNECTED) continue;
      if (agentEvent.type === AgentEvent.TYPE_STEP || agentEvent.type === AgentEvent.TYPE_SESSION_DIFF) continue;
      if (agentEvent.type === AgentEvent.TYPE_FILE_EDITED) continue;
      const rendered = await this._callFeishu('updateProgressCard', [progressCardId, session.id, agentEvent], null, { sessionId: session.id });
      if (rendered && rendered.strategy === 'new_message') {
        const newCardId = await this._callFeishu('sendProgressCard', [{ chatId }, session.id, agentEvent], null, { sessionId: session.id });
        if (newCardId) {
          progressCardId = newCardId;
          this.sessionWatchProgressCards.set(session.id, newCardId);
        }
      }
    }
    const doneEvent = new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'watch' });
    const doneRendered = await this._callFeishu('updateProgressCard', [progressCardId, session.id, doneEvent], null, { sessionId: session.id });
    if (doneRendered && doneRendered.strategy === 'new_message') {
      const newCardId = await this._callFeishu('sendProgressCard', [{ chatId }, session.id, doneEvent], null, { sessionId: session.id });
      if (newCardId) {
        progressCardId = newCardId;
        this.sessionWatchProgressCards.set(session.id, newCardId);
      }
    }
  }

  _handlePermissionEvent(session, chatId, agentEvent) {
    return this.permissionHandler.handle(session, chatId, agentEvent);
  }

  _handlePermissionRepliedEvent(session, chatId, agentEvent) {
    return this.permissionHandler.handleReplied(session, chatId, agentEvent);
  }

  _isFocusSession(session) {
    if (!session || !this.sessionService || typeof this.sessionService.getRouteForSession !== 'function') return true;
    try {
      const routeKey = this.sessionService.getRouteForSession(session.id);
      if (!routeKey) return true;
      const current = this.sessionService.getCurrent(routeKey);
      return !current || current.id === session.id;
    } catch (_) {
      return true;
    }
  }

  _rememberDeliveredText(sessionId, text) {
    const normalized = this._normalizeDeliveredText(text);
    if (!sessionId || !normalized) return;
    const recent = this.sessionDeliveredTexts.get(sessionId) || [];
    const next = recent.filter((item) => item !== normalized);
    next.push(normalized);
    this.sessionDeliveredTexts.set(sessionId, next.slice(-5));
  }

  async _fetchLastCompletedText(session) {
    if (!session || !session.agentRef || !session.agentRef.opencodeSessionId) return null;
    const driver = this.driverRegistry.get(session.agent || 'opencode');
    if (!driver || typeof driver.getSessionMessages !== 'function') return null;
    try {
      const messages = await driver.getSessionMessages(session.agentRef);
      if (!Array.isArray(messages)) return null;
      const completedAssistant = messages.filter((m) => {
        const role = m.info ? m.info.role : m.role;
        const comp = m.info && m.info.time && m.info.time.completed;
        return role === 'assistant' && comp;
      });
      if (completedAssistant.length === 0) return null;
      const last = completedAssistant[completedAssistant.length - 1];
      const parts = (last && last.parts) || [];
      const text = parts
        .filter((p) => p && p.type === 'text' && p.text)
        .map((p) => p.text)
        .join('\n')
        .trim();
      return text || null;
    } catch (err) {
      logger.warn('fetch last completed text failed', { sessionId: session.id, error: err && err.message });
      return null;
    }
  }

  _shouldFetchLastCompletedText(session, agentEvent) {
    if (!session || !session.id) return false;
    const reason = agentEvent && agentEvent.data && agentEvent.data.reason;
    const hasActiveTurn = this.turnStates && this.turnStates.has(session.id);
    if (reason === 'idle' && !hasActiveTurn) return false;
    if (hasActiveTurn) return true;
    return reason === 'polled';
  }

  _hasDeliveredText(sessionId, text) {
    const normalized = this._normalizeDeliveredText(text);
    if (!sessionId || !normalized) return false;
    return (this.sessionDeliveredTexts.get(sessionId) || []).includes(normalized);
  }

  _hasDeliveredPromptEcho(sessionId, text, promptText) {
    const normalized = this._normalizeDeliveredText(text);
    const prompt = String(promptText || '').trim();
    if (!sessionId || !normalized || !prompt) return false;
    return (this.sessionDeliveredTexts.get(sessionId) || []).some((delivered) => (
      normalized === prompt + '\n' + delivered
    ));
  }

  _normalizeDeliveredText(text) {
    const normalized = (text || '').trim();
    if (!normalized) return '';
    const lines = normalized.split(/\r?\n/);
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 6); i--) {
      const line = (lines[i] || '').trim();
      const next = (lines[i + 1] || '').trim();
      const afterNext = (lines[i + 2] || '').trim();
      if (line === '---' && /^模型：/.test(next)
        && (i + 2 === lines.length || (i + 3 === lines.length && /^上下文：/.test(afterNext)))) {
        return lines.slice(0, i).join('\n').trim();
      }
    }
    return normalized;
  }

  async _capturePromptRuntime(session, model, events, driver, agentRef, options) {
    if (!session || !session.id) return;
    const opts = options || {};
    const runtime = this._runtimeFromAgentEvents(events);
    if (!opts.skipDriverRuntimeLookup
      && (!this._hasRuntimeTokenValue(runtime.contextSize) || !this._hasRuntimeTokenValue(runtime.tokenUsage))
      && driver && typeof driver.getLatestSessionRuntime === 'function') {
      const runtimeRef = agentRef || session.agentRef;
      logger.info('session runtime token missing, reading latest driver runtime', {
        sessionId: session.id,
        opencodeSessionId: runtimeRef && runtimeRef.opencodeSessionId,
        hasContextSize: this._hasRuntimeTokenValue(runtime.contextSize),
        hasTokenUsage: this._hasRuntimeTokenValue(runtime.tokenUsage),
      });
      for (let attempt = 0; attempt < 5 && (!this._hasRuntimeTokenValue(runtime.contextSize) || !this._hasRuntimeTokenValue(runtime.tokenUsage)); attempt += 1) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 25));
        try {
          const fallback = await driver.getLatestSessionRuntime(runtimeRef);
          if (fallback && typeof fallback === 'object') {
            if (runtime.model === undefined && fallback.model !== undefined) runtime.model = fallback.model;
            if (!this._hasRuntimeTokenValue(runtime.contextSize) && fallback.contextSize !== undefined) runtime.contextSize = fallback.contextSize;
            if (!this._hasRuntimeTokenValue(runtime.tokenUsage) && fallback.tokenUsage !== undefined) runtime.tokenUsage = fallback.tokenUsage;
            if (this._hasRuntimeTokenValue(runtime.contextSize) || this._hasRuntimeTokenValue(runtime.tokenUsage)) {
              logger.info('session runtime token loaded from latest driver runtime', {
                sessionId: session.id,
                opencodeSessionId: runtimeRef && runtimeRef.opencodeSessionId,
                attempt: attempt + 1,
                contextSize: runtime.contextSize,
                totalTokens: runtime.tokenUsage && runtime.tokenUsage.totalTokens,
              });
            }
          }
        } catch (err) {
          logger.debug('failed to read latest session runtime', { sessionId: session.id, error: err && err.message });
          break;
        }
      }
    }
    let runtimeModel = runtime.model || session.model || model;
    if (!runtimeModel && driver && typeof driver.getCurrentModel === 'function') {
      try {
        runtimeModel = await driver.getCurrentModel();
      } catch (err) {
        logger.debug('failed to read current driver model', { sessionId: session.id, error: err && err.message });
      }
    }
    if (runtimeModel && runtimeModel !== session.model) {
      session.model = runtimeModel;
      this._updateSessionRuntimeField(session.id, 'model', runtimeModel);
    }

    if (runtime.contextSize !== undefined) {
      session.contextTokens = runtime.contextSize;
      this._updateSessionRuntimeField(session.id, 'contextTokens', runtime.contextSize);
    }
    if (runtime.tokenUsage !== undefined) {
      session.tokenUsage = runtime.tokenUsage;
      this._updateSessionRuntimeField(session.id, 'tokenUsage', runtime.tokenUsage);
    }
  }

  _hasRuntimeTokenValue(value, seen) {
    if (value == null || value === '') return false;
    if (typeof value === 'number') return Number.isFinite(value) && value > 0;
    if (typeof value === 'string') return value.trim() !== '' && value.trim() !== '0';
    if (typeof value !== 'object') return false;
    if (!seen) seen = new Set();
    if (seen.has(value)) return false;
    seen.add(value);
    const keys = [
      'contextSize', 'contextTokens', 'totalTokens', 'total_tokens', 'tokens',
      'tokenUsage', 'usage', 'inputTokens', 'input_tokens', 'input',
      'outputTokens', 'output_tokens', 'output', 'reasoningTokens', 'reasoning_tokens',
      'reasoning', 'cacheReadTokens', 'cache_read_tokens', 'cacheWriteTokens', 'cache_write_tokens',
    ];
    for (const key of keys) {
      if (this._hasRuntimeTokenValue(value[key], seen)) return true;
    }
    const cache = value.cache;
    if (cache && typeof cache === 'object') {
      if (this._hasRuntimeTokenValue(cache.read, seen) || this._hasRuntimeTokenValue(cache.write, seen)) return true;
    }
    return false;
  }

  async _updateSessionRuntimeField(sessionId, field, value) {
    if (!this.sessionService || typeof this.sessionService.updateSessionField !== 'function') return;
    try {
      await this.sessionService.updateSessionField(sessionId, field, value);
    } catch (err) {
      logger.debug('failed to update session runtime metadata', { sessionId, field, error: err && err.message });
    }
  }

  async _updateCriticalSessionRuntimeField(sessionId, field, value) {
    if (!this.sessionService || typeof this.sessionService.updateSessionField !== 'function') return { ok: true };
    try {
      await this.sessionService.updateSessionField(sessionId, field, value);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err };
    }
  }

  _runtimeFromAgentEvents(events) {
    const runtime = {};
    for (const event of events || []) {
      this._mergeRuntimeCandidate(runtime, event && event.data);
    }
    return runtime;
  }

  _mergeRuntimeCandidate(runtime, value, seen) {
    if (!value || typeof value !== 'object') return;
    if (!seen) seen = new Set();
    if (seen.has(value)) return;
    seen.add(value);

    if (runtime.model === undefined) {
      const model = this._firstOwnValue(value, ['model']);
      if (typeof model === 'string' && model) runtime.model = model;
      else if (model && typeof model === 'object' && (model.modelID || model.providerID)) runtime.model = model;
      if (!runtime.model) {
        const modelID = this._firstOwnValue(value, ['modelID', 'modelId']);
        const providerID = this._firstOwnValue(value, ['providerID', 'providerId']);
        if (modelID || providerID) runtime.model = { providerID: providerID || '', modelID: modelID || '' };
      }
    }
    if (runtime.contextSize === undefined) {
      const contextSize = this._firstOwnValue(value, ['contextSize', 'contextTokens', 'totalTokens', 'total_tokens', 'inputTokens', 'input_tokens', 'tokens']);
      if (contextSize !== undefined) runtime.contextSize = contextSize;
    }
    if (runtime.tokenUsage === undefined) {
      const tokenUsage = this._firstOwnValue(value, ['tokenUsage', 'usage']);
      if (tokenUsage !== undefined) runtime.tokenUsage = tokenUsage;
    }
    if (runtime.model !== undefined && runtime.contextSize !== undefined && runtime.tokenUsage !== undefined) return;

    for (const key of Object.keys(value)) {
      const child = value[key];
      if (child && typeof child === 'object') this._mergeRuntimeCandidate(runtime, child, seen);
      if (runtime.model !== undefined && runtime.contextSize !== undefined && runtime.tokenUsage !== undefined) return;
    }
  }

  _firstOwnValue(source, keys) {
    for (const key of keys) {
      if (!Object.prototype.hasOwnProperty.call(source, key)) continue;
      try {
        const value = source[key];
        if (value !== undefined && value !== null && value !== '') return value;
      } catch (_) {}
    }
    return undefined;
  }

  _sendFeishu(methodName, args, context) {
    this._callFeishu(methodName, args, undefined, context);
  }

  async _withFeishuRuntime(methodName, args, context) {
    if (!/^(replyText|sendText|replyMarkdown|sendMarkdown|patchCard|replyCard|sendProgressCard|updateProgressCard)$/.test(methodName)) {
      return args;
    }
    return (args || []).concat([await this._feishuRuntimeContext(context || this._feishuContextFromArgs(args))]);
  }

  _feishuContextFromArgs(args) {
    const first = args && args[0];
    if (first && typeof first === 'object') {
      return {
        sessionId: first.sessionId,
        routeKey: first.routeKey,
      };
    }
    return undefined;
  }

  async _feishuRuntimeContext(context) {
    const session = this._sessionFromFeishuContext(context);
    const model = (session && session.model) || await this._currentDriverModelFallback(session) || undefined;
    if (model && session && !session.model) {
      session.model = model;
      this._updateSessionRuntimeField(session.id, 'model', model);
    }
    return {
      model,
      defaultModel: this.defaultModel,
      contextSize: this._firstRuntimeValue(context, session, ['contextSize', 'contextTokens', 'tokens']),
      tokenUsage: this._firstRuntimeValue(context, session, ['tokenUsage', 'usage']),
    };
  }

  async _currentDriverModelFallback(session) {
    const agentName = (session && session.agent) || this.defaultAgent;
    const driver = this.driverRegistry && typeof this.driverRegistry.get === 'function'
      ? this.driverRegistry.get(agentName)
      : null;
    if (!driver || typeof driver.getCurrentModel !== 'function') return null;
    try {
      return await driver.getCurrentModel();
    } catch (err) {
      logger.debug('failed to read current driver model for feishu runtime', { agent: agentName, error: err && err.message });
      return null;
    }
  }

  _sessionFromFeishuContext(context) {
    if (context && context.session) return context.session;
    if (context && context.sessionId && this.sessionService && typeof this.sessionService.getSession === 'function') {
      const session = this.sessionService.getSession(context.sessionId);
      if (session) return session;
    }
    if (context && context.routeKey && this.sessionService && typeof this.sessionService.getCurrent === 'function') {
      const session = this.sessionService.getCurrent(context.routeKey);
      if (session) return session;
    }
    return null;
  }

  _firstRuntimeValue(context, session, keys) {
    for (const source of [context, context && context.runtime, session, session && session.runtime]) {
      if (!source) continue;
      for (const key of keys) {
        try {
          const value = source[key];
          if (value !== undefined && value !== null && value !== '') return value;
        } catch (_) {}
      }
    }
    return undefined;
  }

  _recordAdminEvent(event) {
    if (!this.eventStore) return;
    try {
      recordEvent(this.eventStore, event);
    } catch (err) {
      logger.warn('admin event record failed', { error: err && err.message ? err.message : String(err) });
    }
  }

  _recordAdminMetric(name, value) {
    if (!this.eventStore) return;
    try {
      recordMetric(this.eventStore, name, value);
    } catch (err) {
      logger.warn('admin metric record failed', { metric: name, error: err && err.message ? err.message : String(err) });
    }
  }

  async _callFeishu(methodName, args, fallback, context) {
    const fn = this.feishuApi && this.feishuApi[methodName];
    if (typeof fn !== 'function') {
      logger.warn('feishu api method missing', Object.assign({ method: methodName }, context || {}));
      return fallback;
    }
    const retryable = /^(replyText|replyMarkdown|sendMarkdown|patchCard|replyCard|sendProgressCard|updateProgressCard)$/.test(methodName);
    const maxAttempts = retryable ? 3 : 1;
    const callArgs = await this._withFeishuRuntime(methodName, args, context);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn.apply(this.feishuApi, callArgs);
      } catch (err) {
        const isLast = attempt === maxAttempts;
        if (!isLast) {
          const delay = 100 * Math.pow(2, attempt - 1);
          logger.info('feishu api call retry', Object.assign({
            method: methodName,
            attempt,
            nextDelayMs: delay,
            error: err && err.message ? err.message : String(err),
          }, context || {}));
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        logger.warn('feishu api call failed', Object.assign({
          method: methodName,
          attempts: maxAttempts,
          error: err && err.message ? err.message : String(err),
          response: err && err.response,
        }, context || {}));
        return fallback;
      }
    }
  }

  _markIdleIfActive(sessionId) {
    if (this._isTerminalSession(sessionId)) return;
    this.sessionService.markIdle(sessionId);
  }

  _markErrorIfActive(sessionId, message) {
    if (this._isTerminalSession(sessionId)) return;
    this.sessionService.markError(sessionId, message);
  }

  _isTerminalSession(sessionId) {
    if (!this.sessionService || typeof this.sessionService.getSession !== 'function') return false;
    const latest = this.sessionService.getSession(sessionId);
    return latest && (latest.status === 'stopped' || latest.status === 'deleted');
  }

  _enqueueRouteLock(routeKey, task) {
    if (!routeKey) return task();
    const prev = this._routeLocks.get(routeKey) || Promise.resolve();
    const next = prev.then(() => task(), () => task());
    this._routeLocks.set(routeKey, next);
    const cleanup = () => {
      if (this._routeLocks.get(routeKey) === next) {
        this._routeLocks.delete(routeKey);
      }
    };
    next.then(cleanup, cleanup);
    return next;
  }

  _replyCtx(source) {
    return {
      messageId: source && source.messageId,
      chatId: source && source.chatId,
      routeKey: source && source.routeKey,
      sessionId: source && source.sessionId,
    };
  }

  destroy() {
    for (const [_sessionId, stopFn] of this.sessionWatchStops) {
      try { if (typeof stopFn === 'function') stopFn(); } catch (_) {}
    }
    this.sessionWatchStops.clear();
    for (const [_sessionId, stopFn] of this.promptHeartbeatStops) {
      try { if (typeof stopFn === 'function') stopFn(); } catch (_) {}
    }
    this.promptHeartbeatStops.clear();
    this.sessionWatchBuffers.clear();
    this.sessionWatchProgressCards.clear();
    this.sessionWatchProgressPromises.clear();
    this.sessionDoneInFlight.clear();
    this.sessionDeliveredTexts.clear();
    this.turnStates.clear();
    this.cancelledTurnSessions.clear();
    this._promptQueues.clear();
    this._routeLocks.clear();
    this._destroyed = true;
    logger.info('dispatcher destroyed, all resources cleaned');
  }

  getTurnState(sessionId) {
    const turnState = this.turnStates.get(sessionId);
    return turnState ? { token: turnState.token, cancelled: turnState.cancelled } : null;
  }

  async cancelTurnBySessionId(sessionId, reason) {
    const session = this.sessionService.getSession(sessionId);
    if (!session) return;
    const turnState = this.turnStates.get(sessionId);
    if (!turnState || turnState.cancelled) return;
    const driver = this.driverRegistry.get(session.agent);
    await this._cancelTurn(session, driver, turnState, { reason: reason || 'external' });
  }

  stopSessionWatch(sessionId) {
    this._stopSessionWatch(sessionId);
  }
}

module.exports = { MessageDispatcher };
