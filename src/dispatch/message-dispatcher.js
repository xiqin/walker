'use strict';

const { buildRouteKey } = require('../core/route-key');
const { AgentEvent } = require('../drivers/agent-driver');
const { createLogger } = require('../core/logger');

const logger = createLogger('message-dispatcher');
const DEFAULT_HEARTBEAT_INITIAL_MS = 30000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60000;
const DEFAULT_HEARTBEAT_STUCK_MS = 300000;

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
    this.sessionDeliveredTexts = new Map();
    this.promptHeartbeatStops = new Map();
    this.turnStates = new Map();
    this.cancelledTurnSessions = new Set();
    this._turnSeq = 0;
    this._promptQueues = new Map();
    this._routeLocks = new Map();
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

    const agentRef = current.agentRef;
    if (!agentRef || !agentRef.opencodeSessionId) {
      logger.error('session has no agentRef', { sessionId: current.id });
      this._sendFeishu('sendErrorCard', [this._replyCtx(event), 'Session has no active agent reference']);
      return 'error';
    }

    this.sessionService.markRunning(current.id);
    this._ensureWatch(current, event.chatId);
    logger.info('route bound, prompting driver', {
      messageId: event.messageId,
      routeKey,
      sessionId: current.id,
      agent: current.agent,
      opencodeSessionId: agentRef.opencodeSessionId,
    });

    return this._enqueueRouteLock(routeKey, () => this._enqueuePrompt(current, event, driver, agentRef));
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
          ? await this._callFeishu('sendProgressCard', [this._replyCtx(event), sessionId], null)
          : null;
        const stopHeartbeat = this._startPromptHeartbeat(session, progressCardId);
        const turnState = this._startTurnState(session, event, driver, agentRef, token, progressCardId, stopHeartbeat);
        const model = this._resolveSessionModel(session);
        const events = await driver.prompt(agentRef, event.text, { model, signal: turnState.abortController.signal });
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
          this._markErrorIfActive(sessionId, errorEvent.data.message);
          await this._callFeishu('sendErrorCard', [this._replyCtx(event), errorEvent.data.message]);
          return 'error';
        }
        this._touchTurnState(turnState);
        await this._renderEvents(session, event, events, progressCardId);
        this._markIdleIfActive(sessionId);
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
        this._clearTurnState(sessionId, token);
        logger.error('driver prompt failed', {
          messageId: event.messageId,
          sessionId,
          error: err.message,
          code: err.code || 'unknown',
        });
        this._markErrorIfActive(sessionId, err.message);
        await this._callFeishu('sendErrorCard', [this._replyCtx(event), err.message]);
        return 'error';
      }
    };

    const prev = this._promptQueues.get(sessionId) || Promise.resolve();
    const next = prev.then(task, task);
    this._promptQueues.set(sessionId, next);

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
    const dedupArgs = (cmd.args || []).join(' ');
    const dedupKey = cmd.messageId ? 'cmd:' + cmd.messageId + ':' + cmd.name + ':' + dedupArgs : null;
    const isModelPage = cmd.name === 'model' && cmd.args && cmd.args[0] === '--page';
    if (!isModelPage && dedupKey && this.dedup.isDuplicate(dedupKey)) {
      logger.info('skipping duplicate command', { command: cmd.name, messageId: cmd.messageId });
      return { duplicate: true };
    }

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
      };
      const handler = handlers[cmd.name];
      if (handler) return await handler();
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
    const messageId = cmd.messageId;
    const agentName = cmd.args[0] || this.defaultAgent;
    const title = cmd.args[1] || '';
    const driver = this.driverRegistry.get(agentName);

    if (!driver) {
      await this._callFeishu('sendErrorCard', [this._replyCtx(cmd), 'Agent not found: ' + agentName]);
      return { error: 'driver_not_found' };
    }

    await driver.ensureReady();
    const inheritedModel = this._resolveInheritedModel(current);
    const agentRef = await driver.createSession({ title, cwd: this.defaultCwd, model: inheritedModel });

    const session = this.sessionService.createSession({
      route: routeKey,
      agent: agentName,
      title: title || ('session ' + agentRef.opencodeSessionId.slice(0, 12)),
      runtime: this.runtimeType,
      cwd: this.defaultCwd,
      agentRef,
      model: inheritedModel,
    });

    logger.info('new session created via /new', { sessionId: session.id, agent: agentName, routeKey });
    this._watchSessionEvents(session, cmd, driver);
    await this._callFeishu('replyText', [this._replyCtx(cmd), 'Session created: ' + session.id + ' (' + agentName + ')']);
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
    const targetOpencodeSessionId = cmd.args[0] || '';
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
    const remoteSessions = await driver.listSessions({});
    const managedIds = this._managedOpencodeSessionIds();
    const routeCwd = typeof this.sessionService.getRouteCwd === 'function'
      ? this.sessionService.getRouteCwd(routeKey)
      : '';
    const candidates = remoteSessions.filter((session) => session && session.id && !managedIds.has(session.id));

    if (!targetOpencodeSessionId) {
      if (candidates.length === 1) {
        return this._attachOpencodeSession(cmd, driver, candidates[0]);
      }
      if (this.feishuApi.sendAttachableSessionList) {
        await this._callFeishu('sendAttachableSessionList', [this._replyCtx(cmd), candidates, {
          managedIds: Array.from(managedIds),
          routeKey: cmd.routeKey,
          crossProject: new Set(candidates.map((session) => session.cwd || '')).size > 1,
        }]);
      } else {
        await this._callFeishu('replyText', [this._replyCtx(cmd), this._formatAttachableSessions(candidates)]);
      }
      return { candidates, routeCwd: routeCwd || '' };
    }

    const target = remoteSessions.find((session) => session.id === targetOpencodeSessionId);
    if (!target) {
      await this._callFeishu('sendErrorCard', [this._replyCtx(cmd), 'OpenCode session not found: ' + targetOpencodeSessionId]);
      return { notFound: true };
    }
    if (managedIds.has(targetOpencodeSessionId)) {
      const existing = this._findSessionByOpencodeId(targetOpencodeSessionId);
      if (existing) {
        this.sessionService.bindRoute(routeKey, existing.id);
        await this._callFeishu('replyText', [this._replyCtx(cmd), 'Bound to existing Walker session: ' + existing.id]);
        return { bound: existing.id };
      }
    }

    return this._attachOpencodeSession(cmd, driver, target);
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

  /**
   * /list 命令：显示当前 route 下的 session 列表卡片
   */
  async _cmdList(cmd) {
    const sessions = this.sessionService.listSessionsInRoute(cmd.routeKey);
    const currentSession = this.sessionService.getCurrent(cmd.routeKey);
    await this._callFeishu('sendSessionList', [this._replyCtx(cmd), sessions, currentSession ? currentSession.id : null, cmd.routeKey]);
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

  _formatModelListText(models) {
    if (!models || models.length === 0) return 'No models available.';
    const active = models.filter((m) => m.status !== 'deprecated');
    if (active.length === 0) return 'No models available.';
    const grouped = {};
    for (const m of active) {
      const p = m.provider || 'unknown';
      if (!grouped[p]) grouped[p] = [];
      grouped[p].push(m);
    }
    const sections = [];
    for (const [provider, list] of Object.entries(grouped)) {
      sections.push('**' + provider + '**\n' + list.map((m) => '- `' + m.id + '` ' + m.name).join('\n'));
    }
    return '**可用模型**\n\n' + sections.join('\n\n') + '\n\n用法：/model <model_id> 或 /model <provider>/<model_id>';
  }

  /**
   * 根据输入和模型目录解析规范化模型引用
   * @param {string} input - 用户输入（可能是 modelID 或 provider/modelID）
   * @param {Array<Object>} models - driver.listModels() 返回的模型目录
   * @returns {Object} - { model: {providerID, modelID} } 或 { error: string }
   */
  _resolveModelRef(input, models) {
    const activeModels = (models || []).filter((m) => m && m.status !== 'deprecated' && m.enabled !== false);
    if (input.includes('/')) {
      const parts = input.split('/');
      const provider = parts[0];
      const id = parts.slice(1).join('/');
      const hit = activeModels.find((m) => m.provider === provider && m.id === id);
      if (!hit) {
        return { error: 'Model not found: ' + input + '. Use /model to list available models.' };
      }
      return { model: { providerID: provider, modelID: id } };
    }
    const matches = activeModels.filter((m) => m.id === input);
    if (matches.length === 0) {
      return { error: 'Model not found: ' + input + '. Use /model to list available models.' };
    }
    if (matches.length === 1) {
      return { model: { providerID: matches[0].provider || '', modelID: matches[0].id } };
    }
    const providers = Array.from(new Set(matches.map((m) => m.provider).filter(Boolean)));
    return {
      error: 'Multiple models match "' + input + '". Use provider/modelID, e.g. ' +
        providers.map((p) => p + '/' + input).join(' or ') + '.',
    };
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

  _findSessionByOpencodeId(opencodeSessionId) {
    return this.sessionService.listSessions().find((session) => session
      && session.agentRef
      && session.agentRef.opencodeSessionId === opencodeSessionId) || null;
  }

  _formatAttachableSessions(sessions) {
    if (!sessions || sessions.length === 0) return 'No attachable OpenCode sessions found.';
    return sessions.map((session) => session.title + ' ' + session.id + ' [' + (session.cwd || '(未设置)') + ']').join('\n');
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
    if (!model) return '';
    if (typeof model === 'string') return model;
    if (model.providerID && model.modelID) return model.providerID + '/' + model.modelID;
    return model.modelID || '';
  }

  _appendModelFooter(text, session) {
    if (!text) return text;
    const model = this._formatModel(this._resolveSessionModel(session)) || '未指定';
    return text + '\n\n---\n模型：' + model;
  }

  /**
   * 解析 defaultModel（可能是 string 或对象）为规范化对象
   * @returns {Object|null} - { providerID, modelID } 或 null
   */
  _normalizeDefaultModel() {
    const dm = this.defaultModel;
    if (!dm) return null;
    if (typeof dm === 'object') {
      return { providerID: dm.providerID || '', modelID: dm.modelID || '' };
    }
    const str = String(dm);
    if (str.includes('/')) {
      const parts = str.split('/');
      return { providerID: parts[0], modelID: parts.slice(1).join('/') };
    }
    return { providerID: '', modelID: str };
  }

  /**
   * 从 session.model 或 defaultModel 解析用于 prompt 的规范化模型对象
   * 兼容历史 string 类型 session.model，仅在读取边界规范化，不做持久化迁移
   * @param {Object} session - 会话对象
   * @returns {Object|null} - { providerID, modelID } 或 null
   */
  _resolveSessionModel(session) {
    if (session && session.model) {
      const m = session.model;
      if (typeof m === 'string') {
        if (m.includes('/')) {
          const parts = m.split('/');
          return { providerID: parts[0], modelID: parts.slice(1).join('/') };
        }
        return { providerID: '', modelID: m };
      }
      if (m && typeof m === 'object') {
        return { providerID: m.providerID || '', modelID: m.modelID || '' };
      }
    }
    return this._normalizeDefaultModel();
  }

  /**
   * /new 时解析继承模型：优先当前焦点 session.model，否则 defaultModel
   * @param {Object} current - 当前焦点 session
   * @returns {Object|null} - { providerID, modelID } 或 null
   */
  _resolveInheritedModel(current) {
    if (current && current.model) {
      return this._resolveSessionModel(current);
    }
    return this._normalizeDefaultModel();
  }

  /**
   * 根据 progressStyle 选择渲染方式并渲染 Agent 事件列表
   * @param {Object} session - 当前会话对象
   * @param {Object} event - 原始消息事件
   * @param {AgentEvent[]} events - Agent 返回的事件列表
   * @returns {Promise<void>}
   */
  async _renderEvents(session, event, events, progressCardId) {
    if (this._isTurnSuppressed(session.id)) return;
    const displayEvents = this._coalesceDisplayEvents(events, event.text);
    if (this.progressStyle === 'card') {
      await this._renderCardProgress(session, event, displayEvents, progressCardId);
      const fullText = this._textFromDisplayEvents(displayEvents);
      if (fullText) {
        const replyResult = await this._callFeishu('replyMarkdown', [this._replyCtx(event), this._appendModelFooter(fullText, session)], null);
        if (replyResult) {
          this._rememberDeliveredText(session.id, fullText);
        }
      }
    } else {
      await this._renderLegacyProgress(session, event, displayEvents);
      this._rememberDeliveredText(session.id, this._textFromDisplayEvents(displayEvents));
    }
  }

  /**
   * 使用飞书卡片消息渲染 Agent 处理进度，实时更新卡片内容
   * @param {Object} session - 当前会话对象
   * @param {Object} event - 原始消息事件
   * @param {AgentEvent[]} events - Agent 返回的事件列表
   * @returns {Promise<void>}
   */
  async _renderCardProgress(session, event, displayEvents, progressCardId) {
    let cardId = progressCardId || await this._callFeishu('sendProgressCard', [this._replyCtx(event), session.id], null);

    if (!cardId) {
      return;
    }

    for (const agentEvent of displayEvents) {
      if (agentEvent.type === AgentEvent.TYPE_TEXT) continue;
      this._touchTurnState(this.turnStates.get(session.id));
      const rendered = await this._callFeishu('updateProgressCard', [cardId, session.id, agentEvent], null);
      if (rendered && rendered.strategy === 'new_message') {
        const newCardId = await this._callFeishu('sendProgressCard', [this._replyCtx(event), session.id, agentEvent], null);
        if (newCardId) cardId = newCardId;
      }
    }

    if (this.doneEmoji) {
      this._sendFeishu('addReaction', [event.messageId, this.doneEmoji]);
    }
  }

  _coalesceDisplayEvents(events, promptText) {
    const displayEvents = [];
    let textBuffer = '';

    const flushText = () => {
      if (!textBuffer) return;
      const text = this._stripPromptEcho(textBuffer, promptText);
      if (text) this._pushDisplayEvent(displayEvents, new AgentEvent(AgentEvent.TYPE_TEXT, { text }));
      textBuffer = '';
    };

    for (const agentEvent of events) {
      if (agentEvent.type === AgentEvent.TYPE_TEXT && agentEvent.data && agentEvent.data.delta) {
        textBuffer += agentEvent.data.text || '';
        continue;
      }
      flushText();
      if (agentEvent.type === AgentEvent.TYPE_TEXT) {
        const text = this._stripPromptEcho(agentEvent.data && agentEvent.data.text, promptText);
        if (text) this._pushDisplayEvent(displayEvents, new AgentEvent(AgentEvent.TYPE_TEXT, Object.assign({}, agentEvent.data, { text })));
        continue;
      }
      this._pushDisplayEvent(displayEvents, agentEvent);
    }

    flushText();
    return displayEvents;
  }

  _pushDisplayEvent(displayEvents, agentEvent) {
    const previous = displayEvents[displayEvents.length - 1];
    if (previous && previous.type === AgentEvent.TYPE_TEXT && agentEvent.type === AgentEvent.TYPE_TEXT) {
      const previousText = previous.data && previous.data.text;
      const nextText = agentEvent.data && agentEvent.data.text;
      if (previousText === nextText) return;
      if (previousText && nextText && previousText.endsWith(nextText)) return;
      if (previousText && nextText && nextText.startsWith(previousText)) {
        const tail = nextText.slice(previousText.length).trimStart();
        const tailWithoutMessageId = tail.replace(/^m\d+\s*/i, '').trimStart();
        if (!tailWithoutMessageId || tailWithoutMessageId === previousText) return;
        previous.data = Object.assign({}, previous.data, { text: nextText });
        return;
      }
    }
    displayEvents.push(agentEvent);
  }

  _stripPromptEcho(text, promptText) {
    if (!text) return '';
    const prompt = (promptText || '').trim();
    let output = text;
    if (prompt) {
      if (output === prompt) return '';
      if (output.startsWith(prompt)) output = output.slice(prompt.length).trimStart();
    }
    output = output.replace(/^m\d+\s*/i, '').trimStart();
    return this._collapseNumberedSnapshots(output);
  }

  _collapseNumberedSnapshots(text) {
    if (!text) return '';
    const normalized = text.replace(/\r\n/g, '\n');
    const parts = normalized
      .split(/\n+\s*m\d+\s*\n+/i)
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length <= 1) return text;

    const snapshots = [];
    for (const part of parts) {
      this._pushTextSnapshot(snapshots, part);
    }
    return snapshots.join('\n\n');
  }

  _pushTextSnapshot(snapshots, nextText) {
    if (!nextText) return;
    const previous = snapshots[snapshots.length - 1];
    if (previous) {
      if (previous === nextText) return;
      if (previous.endsWith(nextText)) return;
      if (nextText.startsWith(previous)) {
        snapshots[snapshots.length - 1] = nextText;
        return;
      }
    }
    snapshots.push(nextText);
  }

  /**
   * 使用纯文本方式渲染 Agent 处理结果（仅输出文本事件内容）
   * @param {Object} event - 原始消息事件
   * @param {AgentEvent[]} events - Agent 返回的事件列表
   * @returns {Promise<void>}
   */
  async _renderLegacyProgress(session, event, displayEvents) {
    const fullText = this._textFromDisplayEvents(displayEvents);
    await this._callFeishu('replyMarkdown', [this._replyCtx(event), this._appendModelFooter(fullText.trim(), session)]);
  }

  _textFromDisplayEvents(displayEvents) {
    return (displayEvents || [])
      .filter((event) => event.type === AgentEvent.TYPE_TEXT)
      .map((event) => event.data && event.data.text)
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  _watchSessionEvents(session, cmd, driver) {
    const chatId = (cmd && cmd.chatId) || this._chatIdFromRouteKey(session.route);
    logger.info('watchSessionEvents called', { sessionId: session.id, chatId, hasDriver: !!driver, agentRef: session.agentRef });
    if (!chatId || !driver || typeof driver.watchSession !== 'function') {
      logger.warn('watchSessionEvents skipped', { sessionId: session.id, chatId, hasDriver: !!driver, hasWatch: !!(driver && typeof driver.watchSession === 'function') });
      return;
    }
    this._stopSessionWatch(session.id);
    const stop = driver.watchSession(session.agentRef, {
      onEvent: (agentEvent) => this._handleWatchedSessionEvent(session, chatId, agentEvent),
      onError: (err) => logger.warn('session watch failed', { sessionId: session.id, error: err.message }),
    });
    if (typeof stop === 'function') this.sessionWatchStops.set(session.id, stop);
  }

  _chatIdFromRouteKey(routeKey) {
    if (!routeKey || typeof routeKey !== 'string') return '';
    const parts = routeKey.split(':');
    if (parts.length >= 2 && parts[0] === 'feishu') return parts[1];
    return '';
  }

  _ensureWatch(session, chatId) {
    if (!session || !session.agentRef || !session.agentRef.opencodeSessionId) return;
    if (this.sessionWatchStops.has(session.id)) return;
    const driver = this.driverRegistry.get(session.agent || 'opencode');
    if (!driver || typeof driver.watchSession !== 'function') return;
    this._watchSessionEvents(session, { chatId }, driver);
  }

  ensureWatchForSession(sessionId) {
    if (!sessionId) return;
    const session = this.sessionService.getSession(sessionId);
    if (!session) return;
    const routeKey = this.sessionService.getRouteForSession(sessionId);
    const chatId = this._chatIdFromRouteKey(routeKey);
    this._ensureWatch(session, chatId);
  }

  restoreWatches() {
    const driver = this.driverRegistry.get('opencode');
    if (!driver || typeof driver.watchSession !== 'function') return;
    const sessions = this.sessionService.listSessions();
    let restored = 0;
    for (const session of sessions) {
      if (session.status === 'deleted') continue;
      if (!session.agentRef || !session.agentRef.opencodeSessionId) continue;
      const routeKey = this.sessionService.getRouteForSession(session.id);
      if (!routeKey) continue;
      const chatId = this._chatIdFromRouteKey(routeKey);
      if (!chatId) continue;
      this._watchSessionEvents(session, { chatId }, driver);
      restored++;
    }
    if (restored > 0) logger.info('restored session watches on startup', { count: restored });
  }

  _stopSessionWatch(sessionId) {
    const stop = this.sessionWatchStops.get(sessionId);
    if (stop) {
      try { stop(); } catch (_) {}
    }
    this.sessionWatchStops.delete(sessionId);
    this.sessionWatchBuffers.delete(sessionId);
    this.sessionDeliveredTexts.delete(sessionId);
    this._promptQueues.delete(sessionId);
    this._routeLocks.delete(sessionId);
    this.cancelledTurnSessions.delete(sessionId);
    this._stopPromptHeartbeat(sessionId);
    this._clearTurnState(sessionId);
  }

  _startTurnState(session, event, driver, agentRef, token, progressCardId, stopHeartbeat) {
    this.cancelledTurnSessions.delete(session.id);
    const turnState = {
      token,
      startedAt: Date.now(),
      lastEventAt: Date.now(),
      progressCardId,
      cancelled: false,
      abortController: new AbortController(),
      cancelReason: null,
      timeoutTimer: null,
      stopHeartbeat,
      event,
      driver,
      agentRef,
    };
    this.turnStates.set(session.id, turnState);
    this._startTurnTimeout(session, turnState);
    return turnState;
  }

  _startTurnTimeout(session, turnState) {
    if (!this.maxTurnTimeMins || this.maxTurnTimeMins <= 0) return;
    const timeoutMs = Math.max(1, this.maxTurnTimeMins * 60 * 1000);
    turnState.timeoutTimer = setTimeout(() => {
      turnState.cancelReason = 'deadline';
      if (turnState.abortController) turnState.abortController.abort();
      this._cancelTurn(session, turnState.driver, turnState, { reason: 'deadline' })
        .then(() => this._callFeishu('replyText', [this._replyCtx(turnState.event), 'Current turn timed out after ' + this.maxTurnTimeMins + ' minutes and was cancelled.']))
        .catch((err) => logger.warn('turn timeout cancel failed', { sessionId: session.id, error: err && err.message ? err.message : String(err) }));
    }, timeoutMs);
    if (turnState.timeoutTimer && typeof turnState.timeoutTimer.unref === 'function') turnState.timeoutTimer.unref();
  }

  async _cancelTurn(session, driver, turnState, options) {
    if (!session || !turnState || turnState.cancelled) return;
    turnState.cancelled = true;
    if (options && options.reason) turnState.cancelReason = options.reason;
    this.cancelledTurnSessions.add(session.id);
    if (turnState.abortController && !turnState.abortController.signal.aborted) {
      turnState.abortController.abort();
    }
    this._clearTurnState(session.id, turnState.token);
    this.sessionWatchBuffers.set(session.id, []);
    const activeDriver = driver || this.driverRegistry.get(session.agent);
    if (activeDriver && session.agentRef) {
      if (typeof activeDriver.cancel === 'function') {
        await activeDriver.cancel(session.agentRef);
      } else if (typeof activeDriver.stop === 'function') {
        await activeDriver.stop(session.agentRef);
      }
    }
    this._markIdleIfActive(session.id);
    logger.info('turn cancelled', { sessionId: session.id, reason: options && options.reason });
  }

  _clearTurnState(sessionId, token) {
    const turnState = this.turnStates.get(sessionId);
    if (!turnState || (token && turnState.token !== token)) return;
    if (turnState.timeoutTimer) clearTimeout(turnState.timeoutTimer);
    if (turnState.stopHeartbeat) {
      try { turnState.stopHeartbeat(); } catch (_) {}
    }
    this.turnStates.delete(sessionId);
  }

  _isTransportRecoverableError(err) {
    if (!err) return false;
    const code = err.code;
    if (code === 'SSE_IDLE_TIMEOUT' || code === 'SSE_OPEN_TIMEOUT') return true;
    if (code === 'TUI_RUNTIME_DISCONNECTED') return true;
    if (!code && err.message && /idle|timed out|SSE connection/i.test(err.message)) return true;
    return false;
  }

  _isTurnCancelled(sessionId, token) {
    const turnState = this.turnStates.get(sessionId);
    return this.cancelledTurnSessions.has(sessionId) || !!(turnState && turnState.token === token && turnState.cancelled);
  }

  _isTurnSuppressed(sessionId) {
    return this.cancelledTurnSessions.has(sessionId);
  }

  _touchTurnState(turnState) {
    if (turnState) turnState.lastEventAt = Date.now();
  }

  _startPromptHeartbeat(session, progressCardId) {
    if (this.progressStyle !== 'card' || !progressCardId || !session || !session.id) return () => {};
    const sessionId = session.id;
    this._stopPromptHeartbeat(sessionId);

    const startedAt = Date.now();
    const initialMs = Math.max(1, this.promptHeartbeatInitialMs);
    const intervalMs = Math.max(1, this.promptHeartbeatIntervalMs);
    const stuckMs = Math.max(initialMs, this.promptHeartbeatStuckMs);
    let timer = null;
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      if (this._isTerminalSession(sessionId)) {
        this._stopPromptHeartbeat(sessionId);
        return;
      }

      const elapsedMs = Date.now() - startedAt;
      const elapsedText = this._formatDuration(elapsedMs);
      const stuck = elapsedMs >= stuckMs;
      const message = stuck
        ? '任务可能卡住，已 ' + elapsedText + ' 无新事件。可以继续等待，或发送 /stop 停止当前 session。'
        : '仍在执行，已等待 ' + elapsedText + '，最近无新事件。';
      this._sendFeishu('updateProgressCard', [progressCardId, sessionId, new AgentEvent(AgentEvent.TYPE_STATUS, { message })], { sessionId });
      timer = setTimeout(tick, intervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
    };

    timer = setTimeout(tick, initialMs);
    if (timer && typeof timer.unref === 'function') timer.unref();

    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (this.promptHeartbeatStops.get(sessionId) === stop) {
        this.promptHeartbeatStops.delete(sessionId);
      }
    };
    this.promptHeartbeatStops.set(sessionId, stop);
    return stop;
  }

  _stopPromptHeartbeat(sessionId) {
    const stop = this.promptHeartbeatStops.get(sessionId);
    if (stop) {
      try { stop(); } catch (_) {}
    }
    this.promptHeartbeatStops.delete(sessionId);
  }

  _formatDuration(ms) {
    const totalSeconds = Math.max(1, Math.round(ms / 1000));
    if (totalSeconds < 60) return totalSeconds + ' 秒';
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (!seconds) return minutes + ' 分钟';
    return minutes + ' 分钟 ' + seconds + ' 秒';
  }

  _handleWatchedSessionEvent(session, chatId, agentEvent) {
    if (this._isTurnSuppressed(session.id)) {
      this.sessionWatchBuffers.set(session.id, []);
      return;
    }
    const buffer = this.sessionWatchBuffers.get(session.id) || [];
    if (agentEvent.type === AgentEvent.TYPE_DONE) {
      const displayEvents = this._coalesceDisplayEvents(buffer, '');
      const text = this._textFromDisplayEvents(displayEvents);
      this.sessionWatchBuffers.set(session.id, []);
      logger.info('watched session done', { sessionId: session.id, chatId, textLen: text.length, bufferLen: buffer.length });
      if (text) {
        if (this._hasDeliveredText(session.id, text)) {
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
        this._sendFeishu('sendMarkdown', [chatId, outputText], { sessionId: session.id });
      }
      return;
    }
    buffer.push(agentEvent);
    this.sessionWatchBuffers.set(session.id, buffer);
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
    const normalized = (text || '').trim();
    if (!sessionId || !normalized) return;
    const recent = this.sessionDeliveredTexts.get(sessionId) || [];
    const next = recent.filter((item) => item !== normalized);
    next.push(normalized);
    this.sessionDeliveredTexts.set(sessionId, next.slice(-5));
  }

  _hasDeliveredText(sessionId, text) {
    const normalized = (text || '').trim();
    if (!sessionId || !normalized) return false;
    return (this.sessionDeliveredTexts.get(sessionId) || []).includes(normalized);
  }

  _sendFeishu(methodName, args, context) {
    this._callFeishu(methodName, args, undefined, context);
  }

  async _callFeishu(methodName, args, fallback, context) {
    const fn = this.feishuApi && this.feishuApi[methodName];
    if (typeof fn !== 'function') {
      logger.warn('feishu api method missing', Object.assign({ method: methodName }, context || {}));
      return fallback;
    }
    const retryable = /^(replyText|replyMarkdown|sendMarkdown|patchCard|replyCard|sendProgressCard|updateProgressCard)$/.test(methodName);
    const maxAttempts = retryable ? 3 : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn.apply(this.feishuApi, args);
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
    };
  }

  destroy() {
    for (const [sessionId, stopFn] of this.sessionWatchStops) {
      try { if (typeof stopFn === 'function') stopFn(); } catch (_) {}
    }
    this.sessionWatchStops.clear();
    for (const [sessionId, stopFn] of this.promptHeartbeatStops) {
      try { if (typeof stopFn === 'function') stopFn(); } catch (_) {}
    }
    this.promptHeartbeatStops.clear();
    this.sessionWatchBuffers.clear();
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
