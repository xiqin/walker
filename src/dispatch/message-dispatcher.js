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
    this.sessionWatchStops = new Map();
    this.sessionWatchBuffers = new Map();
    this._promptQueues = new Map();
    this._routeLocks = new Map();
  }

  /**
   * 处理飞书平台传入的消息事件，路由到对应会话并调用 Agent 驱动响应
   * @param {Object} event - 消息事件对象，包含 messageId、chatId、text 等字段
   * @returns {Promise<string>} 处理结果标识（duplicate/unbound/error/prompted）
   */
  async handleIncomingMessage(event) {
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

    const routeKey = event.routeKey || buildRouteKey(event, this.routeMode);
    logger.info('message accepted by dedup', { messageId: event.messageId, routeKey });

    const current = this.sessionService.getCurrent(routeKey);

    if (!current) {
      logger.info('route not bound, sending guide card', { routeKey });
      this._sendFeishu('sendUnboundGuide', [this._replyCtx(event), routeKey]);
      return 'unbound';
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
    logger.info('route bound, prompting driver', {
      messageId: event.messageId,
      routeKey,
      sessionId: current.id,
      agent: current.agent,
      opencodeSessionId: agentRef.opencodeSessionId,
    });

    return this._enqueuePrompt(current, event, driver, agentRef);
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
      try {
        const progressCardId = this.progressStyle === 'card'
          ? await this._callFeishu('sendProgressCard', [this._replyCtx(event), sessionId], null)
          : null;
        const model = session.model || (this.defaultModel ? { modelID: this.defaultModel } : null);
        const events = await driver.prompt(agentRef, event.text, { model });
        logger.info('driver prompt completed', {
          messageId: event.messageId,
          sessionId,
          eventCount: events.length,
        });
        await this._renderEvents(session, event, events, progressCardId);
        this._markIdleIfActive(sessionId);
        return 'prompted';
      } catch (err) {
        logger.error('driver prompt failed', {
          messageId: event.messageId,
          sessionId,
          error: err.message,
        });
        this._markErrorIfActive(sessionId, err.message);
        await this._callFeishu('sendErrorCard', [this._replyCtx(event), err.message]);
        return 'error';
      }
    };

    const prev = this._promptQueues.get(sessionId) || Promise.resolve();
    const next = prev.then(task, task);
    this._promptQueues.set(sessionId, next);

    next.then(() => {
      if (this._promptQueues.get(sessionId) === next) {
        this._promptQueues.delete(sessionId);
      }
    });

    return next;
  }

  /**
   * 处理飞书命令（/new、/attach、/list、/use、/current、/stop、/delete、/help、/agents、/runtime）
   * @param {Object} cmd - 命令对象，包含 name、args、routeKey、messageId、chatId 等字段
   * @returns {Promise<Object>} 命令执行结果
   */
  async handleCommand(cmd) {
    const dedupKey = cmd.messageId ? 'cmd:' + cmd.messageId + ':' + cmd.name : null;
    if (dedupKey && this.dedup.isDuplicate(dedupKey)) {
      logger.info('skipping duplicate command', { command: cmd.name, messageId: cmd.messageId });
      return { duplicate: true };
    }

    try {
      const handlers = {
        new: () => this._enqueueRouteLock(cmd.routeKey, () => this._cmdNew(cmd)),
        attach: () => this._enqueueRouteLock(cmd.routeKey, () => this._cmdAttach(cmd)),
        model: () => this._cmdModel(cmd),
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
      if (handler) return await handler();
      return { unknown: cmd.name };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      logger.error('command handler failed', { command: cmd.name, error: message });
      await this._callFeishu('sendErrorCard', [this._replyCtx(cmd), message]);
      return { error: 'command_failed', message };
    }
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
      await this._callFeishu('sendErrorCard', [this._replyCtx(cmd), 'Agent not found: ' + agentName]);
      return { error: 'driver_not_found' };
    }

    await driver.ensureReady();
    const agentRef = await driver.createSession({ title, cwd: this.defaultCwd });

    const session = this.sessionService.createSession({
      route: routeKey,
      agent: agentName,
      title: title || ('session ' + agentRef.opencodeSessionId.slice(0, 12)),
      runtime: this.runtimeType,
      cwd: this.defaultCwd,
      agentRef,
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
    const remoteSessions = await driver.listSessions({ cwd: this.defaultCwd });
    const managedIds = this._managedOpencodeSessionIds();
    const candidates = remoteSessions.filter((session) => session && session.id && !managedIds.has(session.id));

    if (!targetOpencodeSessionId) {
      if (candidates.length === 1) {
        return this._attachOpencodeSession(cmd, driver, candidates[0]);
      }
      if (this.feishuApi.sendAttachableSessionList) {
        await this._callFeishu('sendAttachableSessionList', [this._replyCtx(cmd), remoteSessions, { managedIds: Array.from(managedIds), routeKey: cmd.routeKey }]);
      } else {
        await this._callFeishu('replyText', [this._replyCtx(cmd), this._formatAttachableSessions(candidates)]);
      }
      return { candidates };
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
   * /list 命令：显示所有 Walker session 列表卡片
   */
  async _cmdList(cmd) {
    const sessions = this.sessionService.listSessions();
    const currentSession = this.sessionService.getCurrent(cmd.routeKey);
    await this._callFeishu('sendSessionList', [this._replyCtx(cmd), sessions, currentSession ? currentSession.id : null, cmd.routeKey]);
    return { sessions };
  }

  /**
   * /use 命令：绑定或解绑 routeKey 到指定 session
   */
  async _cmdUse(cmd) {
    const targetId = cmd.args[0];
    if (targetId === 'off') {
      this.sessionService.unbindRoute(cmd.routeKey);
      await this._callFeishu('replyText', [this._replyCtx(cmd), 'Route unbound.']);
      return { unbound: true };
    }
    if (!targetId) {
      await this._callFeishu('sendErrorCard', [this._replyCtx(cmd), 'Usage: /use <session_id|off>']);
      return { error: 'missing_session_id' };
    }
    this.sessionService.bindRoute(cmd.routeKey, targetId);
    await this._callFeishu('replyText', [this._replyCtx(cmd), 'Bound to session: ' + targetId]);
    return { bound: targetId };
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
    const { formatHelp } = require('../platform/feishu/commands');
    await this._callFeishu('replyText', [this._replyCtx(cmd), formatHelp()]);
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
    const modelId = cmd.args[0];

    if (!modelId) {
      const driver = this.driverRegistry.get('opencode');
      if (!driver || typeof driver.listModels !== 'function') {
        await this._callFeishu('replyText', [this._replyCtx(cmd), 'Model listing not available for current agent.']);
        return { error: 'list_models_not_supported' };
      }
      await driver.ensureReady();
      const models = await driver.listModels();
      if (models.length === 0) {
        await this._callFeishu('replyText', [this._replyCtx(cmd), 'No models available.']);
        return { models: [] };
      }
      const active = models.filter((m) => m.status !== 'deprecated');
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
      await this._callFeishu('replyText', [this._replyCtx(cmd), '**可用模型**\n\n' + sections.join('\n\n') + '\n\n用法：/model <model_id> 或 /model <provider>/<model_id>']);
      return { models };
    }

    const current = this.sessionService.getCurrent(cmd.routeKey);
    if (!current) {
      await this._callFeishu('replyText', [this._replyCtx(cmd), 'No session bound. Use /new or /attach first.']);
      return { noSession: true };
    }

    let modelRef;
    if (modelId.includes('/')) {
      const [provider, id] = modelId.split('/');
      modelRef = { modelID: id, providerID: provider };
    } else {
      modelRef = { modelID: modelId };
    }

    this.sessionService.updateSessionField(current.id, 'model', modelRef);
    const display = modelRef.providerID ? modelRef.providerID + '/' + modelRef.modelID : modelRef.modelID;
    await this._callFeishu('replyText', [this._replyCtx(cmd), 'Model set to: ' + display + ' for session ' + current.id]);
    return { model: modelRef, sessionId: current.id };
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
    return sessions.map((session) => session.title + ' ' + session.id).join('\n');
  }

  /**
   * 根据 progressStyle 选择渲染方式并渲染 Agent 事件列表
   * @param {Object} session - 当前会话对象
   * @param {Object} event - 原始消息事件
   * @param {AgentEvent[]} events - Agent 返回的事件列表
   * @returns {Promise<void>}
   */
  async _renderEvents(session, event, events, progressCardId) {
    if (this.progressStyle === 'card') {
      await this._renderCardProgress(session, event, events, progressCardId);
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
  async _renderCardProgress(session, event, events, progressCardId) {
    let cardId = progressCardId || await this._callFeishu('sendProgressCard', [this._replyCtx(event), session.id], null);
    const displayEvents = this._coalesceDisplayEvents(events, event.text);

    if (!cardId) {
      await this._renderLegacyProgress(event, events);
      return;
    }

    for (const agentEvent of displayEvents) {
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
  async _renderLegacyProgress(event, events) {
    let fullText = '';
    for (const agentEvent of this._coalesceDisplayEvents(events, event.text)) {
      if (agentEvent.type === AgentEvent.TYPE_DONE) continue;
      if (agentEvent.type === AgentEvent.TYPE_TEXT) {
        fullText += agentEvent.data.text + '\n';
      }
    }
    await this._callFeishu('replyText', [this._replyCtx(event), fullText.trim()]);
  }

  _watchSessionEvents(session, cmd, driver) {
    if (!cmd.chatId || !driver || typeof driver.watchSession !== 'function') return;
    this._stopSessionWatch(session.id);
    const stop = driver.watchSession(session.agentRef, {
      onEvent: (agentEvent) => this._handleWatchedSessionEvent(session, cmd.chatId, agentEvent),
      onError: (err) => logger.warn('session watch failed', { sessionId: session.id, error: err.message }),
    });
    if (typeof stop === 'function') this.sessionWatchStops.set(session.id, stop);
  }

  _stopSessionWatch(sessionId) {
    const stop = this.sessionWatchStops.get(sessionId);
    if (stop) {
      try { stop(); } catch (_) {}
    }
    this.sessionWatchStops.delete(sessionId);
    this.sessionWatchBuffers.delete(sessionId);
  }

  _handleWatchedSessionEvent(session, chatId, agentEvent) {
    const buffer = this.sessionWatchBuffers.get(session.id) || [];
    if (agentEvent.type === AgentEvent.TYPE_DONE) {
      const displayEvents = this._coalesceDisplayEvents(buffer, '');
      const text = displayEvents
        .filter((event) => event.type === AgentEvent.TYPE_TEXT)
        .map((event) => event.data && event.data.text)
        .filter(Boolean)
        .join('\n')
        .trim();
      this.sessionWatchBuffers.set(session.id, []);
      if (text) {
        this._sendFeishu('sendText', [chatId, text], { sessionId: session.id });
      }
      return;
    }
    buffer.push(agentEvent);
    this.sessionWatchBuffers.set(session.id, buffer);
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
    const retryable = /^(replyText|patchCard|replyCard|sendProgressCard|updateProgressCard)$/.test(methodName);
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
}

module.exports = { MessageDispatcher };
