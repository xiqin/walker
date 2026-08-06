'use strict';

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { AgentDriver, AgentEvent } = require('./agent-driver');
const { ClaudeAttachServer } = require('./claude-attach-server');
const { ClaudePtyBroker, DEFAULT_QUEUE_LIMIT } = require('./claude-pty-broker');
const defaultTranscript = require('./claude-transcript');

const DEFAULT_MODELS = ['sonnet', 'opus'];
const SAFE_PERMISSION_MODES = new Set(['default', 'acceptEdits', 'auto', 'dontAsk', 'plan']);
const SENSITIVE_KEY_PATTERN = /(token|secret|api[_-]?key|password|credential)/i;
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_PROMPT_LENGTH = 20000;
const DEFAULT_LOCAL_LEASE_TIMEOUT_MS = 30000;

function bindRuntimeMethod(runtime, method) {
  if (typeof method !== 'function') return null;
  return method.bind(runtime);
}

/**
 * 基于 Claude Code CLI 的 AgentDriver 实现。
 */
class ClaudeDriver extends AgentDriver {
  /**
   * 初始化 Claude CLI driver。
   * @param {Object} options - driver 选项与可注入运行时依赖
   */
  constructor(options) {
    super('claude');
    options = options || {};
    this.runtime = options.runtime || childProcess;
    this.execFile = options.execFile || promisify(childProcess.execFile);
    const runtimeSpawn = this.runtime && this.runtime.spawn;
    this.spawn = options.spawn || bindRuntimeMethod(this.runtime, runtimeSpawn) || childProcess.spawn;
    this.env = Object.assign({}, process.env, options.env || {});
    this.cwd = options.cwd || process.cwd();
    this.claudeCmd = options.claudeCmd || this.env.CLAUDE_CMD || 'claude';
    this.model = options.model || this.env.CLAUDE_MODEL || '';
    this.fallbackModel = options.fallbackModel || this.env.CLAUDE_FALLBACK_MODEL || '';
    this.agent = options.agent || this.env.CLAUDE_AGENT || '';
    this.permissionMode = options.permissionMode || this.env.CLAUDE_PERMISSION_MODE || 'default';
    this.allowedTools = normalizeList(options.allowedTools || this.env.CLAUDE_ALLOWED_TOOLS);
    this.disallowedTools = normalizeList(options.disallowedTools || this.env.CLAUDE_DISALLOWED_TOOLS);
    this.addDirs = normalizeList(options.addDirs || options.addDir || this.env.CLAUDE_ADD_DIRS || this.env.CLAUDE_ADD_DIR);
    this.configDir = options.configDir || this.env.CLAUDE_CONFIG_DIR || '';
    this.promptTimeoutMs = positiveInteger(options.promptTimeoutMs || this.env.CLAUDE_PROMPT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    const runtimeOpenTerminal = this.runtime && this.runtime.openTerminal;
    this.openTerminal = options.openTerminal || bindRuntimeMethod(this.runtime, runtimeOpenTerminal);
    const runtimeOpenClaudeAttachTerminal = this.runtime && this.runtime.openClaudeAttachTerminal;
    this.openClaudeAttachTerminal = options.openClaudeAttachTerminal || bindRuntimeMethod(this.runtime, runtimeOpenClaudeAttachTerminal);
    this.claudeBridge = options.claudeBridge || options.bridgeSidecar || null;
    this.ptyBroker = options.ptyBroker || new ClaudePtyBroker({ command: this.claudeCmd, cwd: this.cwd, env: this.env, logger: options.logger, claudeBridge: this.claudeBridge });
    this.transcript = options.transcript === undefined ? (options.ptyBroker ? null : defaultTranscript) : options.transcript;
    this.transcriptTimeoutMs = positiveInteger(options.transcriptTimeoutMs || this.env.CLAUDE_TRANSCRIPT_TIMEOUT_MS, this.promptTimeoutMs);
    this.queueLimit = positiveInteger(options.queueLimit == null ? DEFAULT_QUEUE_LIMIT : options.queueLimit, DEFAULT_QUEUE_LIMIT);
    this.maxPromptLength = positiveInteger(options.maxPromptLength == null ? DEFAULT_MAX_PROMPT_LENGTH : options.maxPromptLength, DEFAULT_MAX_PROMPT_LENGTH);
    this.localLeaseTimeoutMs = positiveInteger(options.localLeaseTimeoutMs == null ? DEFAULT_LOCAL_LEASE_TIMEOUT_MS : options.localLeaseTimeoutMs, DEFAULT_LOCAL_LEASE_TIMEOUT_MS);
    this._setTimeout = options.setTimeout || setTimeout;
    this._clearTimeout = options.clearTimeout || clearTimeout;
    this._pending = new Map();
    this._windows = new Map();
    this._runtimeInputState = new Map();
    this._runtimeTransports = new Map();
    this.attachBroker = this._createAttachBrokerFacade();
    this.attachServer = this._createAttachServer(options);
    this._lastVersion = null;
  }

  /**
   * 探测 Claude CLI 是否可执行。
   * @returns {Promise<boolean>} CLI 可用时返回 true
   */
  async ensureReady() {
    try {
      const result = await this._execFile(this.claudeCmd, ['--version'], { cwd: this.cwd, env: this.env, timeout: 10000 });
      const stdout = typeof result === 'string' ? result : (result && result.stdout) || '';
      const stderr = result && result.stderr ? result.stderr : '';
      this._lastVersion = String(stdout || stderr || '').trim();
      return true;
    } catch (err) {
      const wrapped = new Error('claude cli is not available: ' + sanitizeError(err));
      wrapped.code = err && err.code;
      throw wrapped;
    }
  }

  /**
   * 创建 Walker 可持久化的 Claude 会话引用。
   * @param {Object} options - 会话创建选项
   * @returns {Promise<Object>} Claude 会话引用
   */
  async createSession(options) {
    options = options || {};
    const now = new Date().toISOString();
    const requestedSessionId = options.claudeSessionId || options.sessionId || '';
    const claudeSessionId = isUuid(requestedSessionId) ? requestedSessionId : createClaudeSessionId();
    const cwd = options.cwd || this.cwd;
    const snapshot = this.ptyBroker.createRuntime({
      claudeSessionId,
      cwd,
      env: this.env,
      cols: options.cols,
      rows: options.rows,
    });
    const agentRef = snapshot.agentRef || {};
    const ref = {
      provider: 'claude',
      transport: 'pty-attach',
      runtimeId: snapshot.runtimeId,
      claudeSessionId,
      processGeneration: snapshot.processGeneration,
      cwd,
      title: options.title || 'walker claude session',
      model: normalizeModel(options.model || this.model),
      fallbackModel: options.fallbackModel || this.fallbackModel || undefined,
      agent: options.agent || this.agent || undefined,
      permissionMode: options.permissionMode || this.permissionMode || 'default',
      conversationReady: true,
      createdAt: now,
      updatedAt: now,
    };
    Object.assign(ref, agentRef, { cwd, title: ref.title, model: ref.model, fallbackModel: ref.fallbackModel, agent: ref.agent, permissionMode: ref.permissionMode, createdAt: now, updatedAt: now });
    this._runtimeTransports.set(ref.runtimeId, ref.transport || 'pty-attach');
    this._getRuntimeInputState(ref.runtimeId);
    ref.terminal = await this._ensureTerminal(ref);
    return ref;
  }

  /**
   * 恢复并规范化已有 Claude 会话引用。
   * @param {Object} sessionRef - 已持久化的会话引用
   * @returns {Promise<Object>} 规范化后的会话引用
   */
  async resumeSession(sessionRef) {
    if (!sessionRef || !sessionRef.claudeSessionId) {
      throw new Error('resumeSession requires sessionRef with claudeSessionId');
    }
    if (!isUuid(sessionRef.claudeSessionId)) {
      throw createCodedError('resumeSession requires exact Claude UUID', 'CLAUDE_SESSION_INVALID');
    }
    const cwd = sessionRef.cwd || this.cwd;
    const previousRuntimeId = sessionRef.runtimeId || (sessionRef.agentRef && sessionRef.agentRef.runtimeId);
    const bridgeRuntime = previousRuntimeId ? this._lookupBridgeRuntime(previousRuntimeId) : null;
    if (this._isReconnectableRuntime(bridgeRuntime, sessionRef.claudeSessionId)) {
      const ref = Object.assign({}, sessionRef, bridgeRuntime.agentRef || {}, {
        provider: 'claude',
        transport: 'bridge-sidecar',
        runtimeId: bridgeRuntime.runtimeId,
        claudeSessionId: bridgeRuntime.claudeSessionId || sessionRef.claudeSessionId,
        processGeneration: bridgeRuntime.processGeneration || sessionRef.processGeneration,
        cwd: bridgeRuntime.cwd || cwd,
        conversationReady: true,
        runtimeStatus: 'reconnected',
        connectionState: bridgeRuntime.connectionState || 'reconnectable',
        runtimePath: bridgeRuntime.lastPath || 'reconnected',
        updatedAt: new Date().toISOString(),
      });
      this._runtimeTransports.set(ref.runtimeId, 'bridge-sidecar');
      this._getRuntimeInputState(ref.runtimeId);
      return ref;
    }
    const fallbackReason = bridgeRuntime ? (bridgeRuntime.reason || bridgeRuntime.status || 'unavailable') : 'unavailable';
    const fallbackRuntimeId = this.claudeBridge ? undefined : previousRuntimeId;
    const snapshot = this.ptyBroker.resumeRuntime({
      runtimeId: fallbackRuntimeId,
      claudeSessionId: sessionRef.claudeSessionId,
      cwd,
      env: this.env,
      processGeneration: sessionRef.processGeneration,
    });
    const ref = Object.assign({}, sessionRef, snapshot.agentRef || {}, {
      provider: 'claude',
      transport: 'pty-attach',
      runtimeId: snapshot.runtimeId,
      claudeSessionId: snapshot.claudeSessionId || sessionRef.claudeSessionId,
      processGeneration: snapshot.processGeneration,
      cwd,
      conversationReady: true,
      runtimeStatus: this.claudeBridge ? 'fallback' : undefined,
      connectionState: this.claudeBridge ? 'fallback' : undefined,
      runtimePath: this.claudeBridge ? 'fallback' : undefined,
      runtimeReason: this.claudeBridge ? sanitizeText(fallbackReason) : undefined,
      previousRuntimeId: this.claudeBridge ? previousRuntimeId : undefined,
      updatedAt: new Date().toISOString(),
    });
    this._runtimeTransports.set(ref.runtimeId, 'pty-attach');
    this._getRuntimeInputState(ref.runtimeId);
    ref.terminal = await this._ensureTerminal(ref);
    return ref;
  }

  /**
   * Claude CLI 无公开本地目录 API，这里仅返回空可恢复列表。
   * @returns {Promise<Object[]>} 空会话列表
   */
  async listSessions() {
    return [];
  }

  /**
   * 为 Walker 侧会话建立 Claude 终端状态 watch。Claude CLI 没有 OpenCode TUI bridge，
   * 因此这里维护窗口生命周期诊断，不伪造实时消息流。
   * @param {Object} sessionRef - Claude 会话引用
   * @returns {Function} 停止 watch 的函数
   */
  watchSession(sessionRef, handlers) {
    if (!sessionRef || !sessionRef.claudeSessionId) return () => {};
    if (!this.isSessionRefActive(sessionRef)) {
      sessionRef.terminal = this._ensureTerminalSyncStatus(sessionRef);
    }
    if (!this.transcript || typeof this.transcript.watchClaudeTranscript !== 'function') return () => {};
    try {
      const watcher = this.transcript.watchClaudeTranscript({
        cwd: sessionRef.cwd || this.cwd,
        configDir: this.configDir || undefined,
        claudeSessionId: sessionRef.claudeSessionId,
        onEvent: (event) => this._handleTranscriptEvent(event, handlers),
      });
      return () => watcher.close();
    } catch (err) {
      if (handlers && typeof handlers.onError === 'function') handlers.onError(err);
      return () => {};
    }
  }

  /**
   * 判断 Claude 终端窗口状态是否仍可视为活动。
   * @param {Object} sessionRef - Claude 会话引用
   * @returns {boolean} 活动时返回 true
   */
  isSessionRefActive(sessionRef) {
    if (!sessionRef || !sessionRef.claudeSessionId) return false;
    const runtimeId = sessionRef.runtimeId || (sessionRef.agentRef && sessionRef.agentRef.runtimeId);
    const bridgeRuntime = runtimeId ? this._lookupBridgeRuntime(runtimeId) : null;
    if (this._isReconnectableRuntime(bridgeRuntime, sessionRef.claudeSessionId)) return true;
    if (sessionRef.transport === 'pty-attach' || runtimeId) {
      if (!runtimeId || !this.ptyBroker || typeof this.ptyBroker.getRuntime !== 'function') return false;
      const runtime = this.ptyBroker.getRuntime(runtimeId);
      if (!runtime || runtime.status !== 'active') return false;
    }
    if (bridgeRuntime && !this._isReconnectableRuntime(bridgeRuntime, sessionRef.claudeSessionId)) return false;
    const tracked = this._windows.get(sessionRef.claudeSessionId);
    const terminal = tracked || sessionRef.terminal || {};
    return terminal.status === 'active';
  }

  /**
   * 通过 Walker 持有的长期 Claude PTY 发送提示词。
   * @param {Object} sessionRef - Claude 会话引用
   * @param {string} text - 提示词文本
   * @param {Object} options - prompt 选项
   * @returns {Promise<AgentEvent[]>} 统一 Agent 事件
   */
  async prompt(sessionRef, text, options) {
    if (!sessionRef || !sessionRef.claudeSessionId) {
      throw new Error('prompt requires sessionRef with claudeSessionId');
    }
    options = options || {};
    const promptText = this._validatePromptText(text);
    const runtimeId = sessionRef.runtimeId || (sessionRef.agentRef && sessionRef.agentRef.runtimeId);
    if (!runtimeId) throw createCodedError('prompt requires sessionRef with runtimeId', 'CLAUDE_RUNTIME_REQUIRED');
    if ((sessionRef.transport === 'bridge-sidecar' || this._runtimeTransports.get(runtimeId) === 'bridge-sidecar') && !this.isSessionRefActive(sessionRef)) {
      throw createCodedError('bridge runtime is unavailable', 'CLAUDE_RUNTIME_UNAVAILABLE');
    }
    return this._submitPrompt(runtimeId, promptText, options);
  }

  /**
   * 停止指定 Claude 会话的当前 CLI 子进程。
   * @param {Object} sessionRef - Claude 会话引用
   * @returns {Promise<void>}
   */
  async stop(sessionRef) {
    const key = sessionRef && sessionRef.claudeSessionId;
    const runtimeId = sessionRef && (sessionRef.runtimeId || (sessionRef.agentRef && sessionRef.agentRef.runtimeId));
    if (!key && !runtimeId) return;
    const child = this._pending.get(key);
    if (child) {
      terminateChild(child);
      this._pending.delete(key);
    }
    if (runtimeId && this.ptyBroker && typeof this.ptyBroker.stopRuntime === 'function') {
      this.ptyBroker.stopRuntime(runtimeId, 'session stopped');
      this._rejectQueued(runtimeId, createCodedError('runtime stopped', 'CLAUDE_RUNTIME_STOPPED'));
    }
    this._markTerminalStatus(sessionRef, 'stopped', 'session stopped');
  }

  /**
   * 取消指定 Claude 会话的当前 CLI 子进程。
   * @param {Object} sessionRef - Claude 会话引用
   * @returns {Promise<void>}
   */
  async cancel(sessionRef) {
    await this.stop(sessionRef);
  }

  /**
   * 删除 Walker 侧 pending 状态，不删除 Claude 用户历史。
   * @param {Object} sessionRef - Claude 会话引用
   * @returns {Promise<void>}
   */
  async delete(sessionRef) {
    await this.stop(sessionRef);
    const runtimeId = sessionRef && (sessionRef.runtimeId || (sessionRef.agentRef && sessionRef.agentRef.runtimeId));
    if (runtimeId && this.ptyBroker && typeof this.ptyBroker.deleteRuntime === 'function') {
      this.ptyBroker.deleteRuntime(runtimeId, 'session deleted');
      this._runtimeInputState.delete(runtimeId);
    }
    if (sessionRef && sessionRef.claudeSessionId) this._windows.delete(sessionRef.claudeSessionId);
  }

  async detachAllRuntimes(reason) {
    await this._handoffActiveTerminals();
    for (const [runtimeId, state] of this._runtimeInputState.entries()) {
      if (state.leaseTimer) this._clearTimeout(state.leaseTimer);
      this._rejectQueued(runtimeId, createCodedError(reason || 'runtime detached', 'CLAUDE_RUNTIME_DETACHED'));
    }
    this._runtimeInputState.clear();
    this._windows.clear();
    if (this.ptyBroker && typeof this.ptyBroker.detachAllRuntimes === 'function') {
      this.ptyBroker.detachAllRuntimes(reason || 'walker shutdown');
    }
  }

  async stopWalkerConnection(reason) {
    const err = createCodedError(reason || 'walker connection stopped', 'CLAUDE_WALKER_CONNECTION_STOPPED');
    for (const [runtimeId, state] of this._runtimeInputState.entries()) {
      if (state.leaseTimer) this._clearTimeout(state.leaseTimer);
      this._rejectQueued(runtimeId, err);
    }
    this._runtimeInputState.clear();
    this._windows.clear();
    if (this.claudeBridge && typeof this.claudeBridge.stopWalkerConnection === 'function') {
      await this.claudeBridge.stopWalkerConnection(reason || 'walker shutdown');
    }
  }

  async _handoffActiveTerminals() {
    if (!this.runtime || typeof this.runtime.openTerminal !== 'function') return;
    if (!this.ptyBroker || typeof this.ptyBroker.listRuntimes !== 'function') return;
    const runtimes = this.ptyBroker.listRuntimes();
    await Promise.all(runtimes
      .filter((runtime) => runtime && runtime.status === 'active' && runtime.claudeSessionId)
      .map((runtime) => this.runtime.openTerminal(this.claudeCmd, ['--resume', runtime.claudeSessionId], {
        cwd: runtime.cwd || this.cwd,
        title: 'claude ' + runtime.claudeSessionId.slice(0, 8),
        env: this.env,
      }).catch(() => undefined)));
  }

  async _ensureTerminal(sessionRef) {
    if (!this.openClaudeAttachTerminal || typeof this.openClaudeAttachTerminal !== 'function') {
      return this._markTerminalStatus(sessionRef, 'unavailable', 'runtime does not support openClaudeAttachTerminal');
    }
    const current = this._windows.get(sessionRef.claudeSessionId);
    if (current && current.status === 'active') return current;
    let attachment = null;
    try {
      if (this.attachServer && typeof this.attachServer.createAttachment === 'function') {
        if (typeof this.attachServer.start === 'function') await this.attachServer.start();
        attachment = this.attachServer.createAttachment(sessionRef.runtimeId);
      }
      const result = await this.openClaudeAttachTerminal(sessionRef.runtimeId, {
        cwd: sessionRef.cwd || this.cwd,
        title: 'claude ' + (sessionRef.title || sessionRef.claudeSessionId).slice(0, 40),
        attachUrl: attachment && attachment.url,
        token: attachment && attachment.token,
      });
      return this._markTerminalStatus(sessionRef, 'active', '', {
        runtimeId: sessionRef.runtimeId,
        pid: result && result.pid || null,
        windowId: result && (result.windowId || result.id) || null,
        openedAt: new Date().toISOString(),
      });
    } catch (err) {
      return this._markTerminalStatus(sessionRef, 'failed', sanitizeError(err), { runtimeId: sessionRef.runtimeId });
    }
  }

  _ensureTerminalSyncStatus(sessionRef) {
    const current = this._windows.get(sessionRef.claudeSessionId);
    if (current) return current;
    return this._markTerminalStatus(sessionRef, 'unavailable', 'terminal window is not attached');
  }

  _markTerminalStatus(sessionRef, status, reason, extra) {
    const terminal = Object.assign({
      status,
      reason: reason || '',
      updatedAt: new Date().toISOString(),
    }, extra || {});
    if (sessionRef && sessionRef.claudeSessionId) {
      sessionRef.terminal = terminal;
      this._windows.set(sessionRef.claudeSessionId, terminal);
    }
    return terminal;
  }

  _createAttachServer(options) {
    if (typeof options.attachServerFactory === 'function') return options.attachServerFactory({ broker: this.attachBroker, driver: this });
    if (options.attachServer && typeof options.attachServer === 'object') {
      options.attachServer.broker = this.attachBroker;
      return options.attachServer;
    }
    if (options.attachServer === false) return null;
    if (this.claudeBridge) return this.claudeBridge;
    return new ClaudeAttachServer({ broker: this.attachBroker, logger: options.logger });
  }

  _createAttachBrokerFacade() {
    return {
      createRuntime: (options) => this.ptyBroker.createRuntime(options),
      resumeRuntime: (options) => this.ptyBroker.resumeRuntime(options),
      getRuntime: (runtimeId) => this.ptyBroker.getRuntime(runtimeId),
      stopRuntime: (runtimeId, reason) => this.ptyBroker.stopRuntime(runtimeId, reason),
      deleteRuntime: (runtimeId, reason) => this.ptyBroker.deleteRuntime(runtimeId, reason),
      resize: (runtimeId, cols, rows) => this.ptyBroker.resize(runtimeId, cols, rows),
      subscribeOutput: (runtimeId, fn, options) => this.ptyBroker.subscribeOutput(runtimeId, fn, options),
      writeInput: (runtimeId, data, options) => {
        const opts = options || {};
        if (opts.source === 'attach') return this._handleAttachInput(runtimeId, data);
        return this.ptyBroker.writeInput(runtimeId, data, opts);
      },
      detach: (runtimeId) => this._detachAttachInput(runtimeId),
    };
  }

  _validatePromptText(text) {
    if (typeof text !== 'string') throw createCodedError('prompt text must be a string', 'CLAUDE_PROMPT_INVALID');
    if (!text.trim()) throw createCodedError('prompt text must not be blank', 'CLAUDE_PROMPT_EMPTY');
    if (text.length > this.maxPromptLength) throw createCodedError('prompt text exceeds max length', 'CLAUDE_PROMPT_TOO_LONG');
    return text;
  }

  _submitPrompt(runtimeId, text) {
    const state = this._getRuntimeInputState(runtimeId);
    if (this._isInputBlocked(state)) return this._enqueuePrompt(runtimeId, text);
    return this._writePrompt(runtimeId, text);
  }

  _writePrompt(runtimeId, text) {
    const data = Buffer.from(text + '\r');
    const cursor = this._createPromptCursor(runtimeId);
    const transport = this._runtimeTransports.get(runtimeId);
    const input = transport === 'bridge-sidecar' && this.claudeBridge && typeof this.claudeBridge.writeInput === 'function'
      ? this.claudeBridge.writeInput(runtimeId, data, { source: 'feishu' })
      : this.ptyBroker.writeInput(runtimeId, data, { source: 'feishu' });
    return Promise.resolve(input)
      .then(() => this._collectPromptFromTranscript(cursor));
  }

  _createPromptCursor(runtimeId) {
    if (!this.transcript || typeof this.transcript.createTranscriptCursor !== 'function') return null;
    const runtime = this.ptyBroker.getRuntime(runtimeId) || {};
    if (!runtime.claudeSessionId) return null;
    return this.transcript.createTranscriptCursor({
      cwd: runtime.cwd || this.cwd,
      configDir: this.configDir || undefined,
      claudeSessionId: runtime.claudeSessionId,
    });
  }

  async _collectPromptFromTranscript(cursor) {
    if (!cursor || !this.transcript) {
      return [new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'submitted' })];
    }
    let transcriptEvents;
    if (typeof this.transcript.readAssistantEventsSince === 'function') {
      transcriptEvents = await this.transcript.readAssistantEventsSince(cursor, { timeoutMs: this.transcriptTimeoutMs });
    } else if (typeof this.transcript.readAssistantTextSince === 'function') {
      const text = await this.transcript.readAssistantTextSince(cursor, { timeoutMs: this.transcriptTimeoutMs });
      transcriptEvents = text ? [{ type: 'assistant', text }] : [];
    } else {
      return [new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'submitted' })];
    }
    const events = [];
    let finalRuntime = {};
    for (const event of transcriptEvents || []) {
      const runtime = runtimeFromTranscriptEvent(event);
      if (event.text) events.push(new AgentEvent(AgentEvent.TYPE_TEXT, { text: event.text, ...runtime }));
      finalRuntime = { ...finalRuntime, ...runtime };
    }
    events.push(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'transcript', ...finalRuntime }));
    return events;
  }

  _handleTranscriptEvent(event, handlers) {
    if (!handlers || typeof handlers.onEvent !== 'function') return;
    if (!event || event.type === 'error') {
      if (event && event.error && typeof handlers.onError === 'function') handlers.onError(event.error);
      return;
    }
    const runtime = runtimeFromTranscriptEvent(event);
    if (event.type === 'assistant' && event.text) handlers.onEvent(new AgentEvent(AgentEvent.TYPE_TEXT, { text: event.text, ...runtime }));
    if (event.type === 'user' && event.text) handlers.onEvent(new AgentEvent(AgentEvent.TYPE_STATUS, { status: 'user-message' }));
    if (event.type === 'done') handlers.onEvent(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'transcript-watch', ...runtime }));
  }

  _enqueuePrompt(runtimeId, text) {
    const state = this._getRuntimeInputState(runtimeId);
    if (state.queue.length >= this.queueLimit) throw createCodedError('claude input queue is full', 'CLAUDE_INPUT_QUEUE_FULL');
    return new Promise((resolve, reject) => {
      state.queue.push({ text, resolve, reject });
    });
  }

  _drainQueue(runtimeId) {
    const state = this._getRuntimeInputState(runtimeId);
    if (state.draining || this._isInputBlocked(state)) return;
    const item = state.queue.shift();
    if (!item) return;
    state.draining = true;
    this._writePrompt(runtimeId, item.text)
      .then(item.resolve, item.reject)
      .finally(() => {
        state.draining = false;
        this._drainQueue(runtimeId);
      });
  }

  _getRuntimeInputState(runtimeId) {
    if (!this._runtimeInputState.has(runtimeId)) {
      this._runtimeInputState.set(runtimeId, {
        localLeaseActive: false,
        busy: false,
        permission: false,
        queue: [],
        leaseTimer: null,
        draining: false,
      });
    }
    return this._runtimeInputState.get(runtimeId);
  }

  _isInputBlocked(state) {
    return state.localLeaseActive || state.busy || state.permission || state.draining;
  }

  _acquireLocalLease(runtimeId, reason) {
    const state = this._getRuntimeInputState(runtimeId);
    state.localLeaseActive = true;
    state.leaseReason = reason || 'attach-input';
    this._refreshLocalLeaseTimer(runtimeId, state);
  }

  _releaseLocalLease(runtimeId, reason) {
    const state = this._getRuntimeInputState(runtimeId);
    state.localLeaseActive = false;
    state.leaseReason = reason || '';
    if (state.leaseTimer) this._clearTimeout(state.leaseTimer);
    state.leaseTimer = null;
    this._drainQueue(runtimeId);
  }

  _refreshLocalLeaseTimer(runtimeId, state) {
    if (state.leaseTimer) this._clearTimeout(state.leaseTimer);
    state.leaseTimer = this._setTimeout(() => this._releaseLocalLease(runtimeId, 'timeout'), this.localLeaseTimeoutMs);
    if (state.leaseTimer && typeof state.leaseTimer.unref === 'function') state.leaseTimer.unref();
  }

  _setRuntimeBusy(runtimeId, active) {
    const state = this._getRuntimeInputState(runtimeId);
    state.busy = Boolean(active);
    if (!state.busy) this._drainQueue(runtimeId);
  }

  _setPermissionState(runtimeId, active) {
    const state = this._getRuntimeInputState(runtimeId);
    state.permission = Boolean(active);
    if (!state.permission) this._drainQueue(runtimeId);
  }

  _handleAttachInput(runtimeId, chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    const text = data.toString('utf8');
    const releasesLease = text.includes('\r') || text.includes('\n') || text.includes('\x03');
    if (!releasesLease) this._acquireLocalLease(runtimeId, 'attach-input');
    return Promise.resolve(this.ptyBroker.writeInput(runtimeId, data, { source: 'attach' }))
      .then(() => {
        if (releasesLease) this._releaseLocalLease(runtimeId, text.includes('\x03') ? 'ctrl-c' : 'enter');
      });
  }

  _detachAttachInput(runtimeId) {
    this._releaseLocalLease(runtimeId, 'detach');
  }

  _rejectQueued(runtimeId, err) {
    const state = this._runtimeInputState.get(runtimeId);
    if (!state) return;
    while (state.queue.length > 0) {
      const item = state.queue.shift();
      item.reject(err);
    }
  }

  _lookupBridgeRuntime(runtimeId) {
    if (!runtimeId || !this.claudeBridge || typeof this.claudeBridge.getRuntime !== 'function') return null;
    try {
      return this.claudeBridge.getRuntime(runtimeId);
    } catch (err) {
      return { runtimeId, status: 'unavailable', reconnectable: false, reason: sanitizeError(err) };
    }
  }

  _isReconnectableRuntime(runtime, claudeSessionId) {
    if (!runtime || !runtime.runtimeId) return false;
    if (claudeSessionId && runtime.claudeSessionId && runtime.claudeSessionId !== claudeSessionId) return false;
    if (runtime.reconnectable === false) return false;
    return runtime.status === 'active' || runtime.status === 'walker-disconnected' || runtime.connectionState === 'reconnectable';
  }

  /**
   * 返回 Claude CLI 可用模型别名和本地配置摘要。
   * @returns {Promise<Object[]>} 模型摘要列表
   */
  async listModels() {
    const ids = new Set(DEFAULT_MODELS);
    if (this.model) ids.add(this.model);
    if (this.fallbackModel) ids.add(this.fallbackModel);
    return Array.from(ids).map((id) => ({
      id,
      modelID: id,
      name: id,
      providerID: 'claude',
      source: DEFAULT_MODELS.includes(id) ? 'claude-cli-alias' : 'config',
      configured: id === this.model || id === this.fallbackModel,
    }));
  }

  /**
   * 构造 Claude CLI prompt 参数，避免 shell 拼接。
   * @param {Object} sessionRef - Claude 会话引用
   * @param {Object} options - prompt 选项
   * @returns {string[]} CLI 参数数组
   */
  _buildPromptArgs(sessionRef, options) {
    const args = ['--print', '--verbose', '--output-format', 'stream-json'];
    if (sessionRef.conversationReady === false) appendSessionArg(args, sessionRef.claudeSessionId);
    else appendResumeArg(args, sessionRef.claudeSessionId);
    const model = normalizeModel(options.model || sessionRef.model || this.model);
    const fallbackModel = options.fallbackModel || sessionRef.fallbackModel || this.fallbackModel;
    const agent = options.agent || sessionRef.agent || this.agent;
    const permissionMode = options.permissionMode || sessionRef.permissionMode || this.permissionMode;
    appendOption(args, '--model', model);
    appendOption(args, '--fallback-model', fallbackModel);
    appendOption(args, '--agent', agent);
    if (SAFE_PERMISSION_MODES.has(permissionMode)) appendOption(args, '--permission-mode', permissionMode);
    for (const dir of normalizeList(options.addDirs || options.addDir || this.addDirs)) appendOption(args, '--add-dir', dir);
    appendOption(args, '--settings', options.settings || this.configDir);
    appendCsvOption(args, '--allowed-tools', options.allowedTools || this.allowedTools);
    appendCsvOption(args, '--disallowed-tools', options.disallowedTools || this.disallowedTools);
    return args;
  }

  _buildTerminalArgs(sessionRef) {
    const args = [];
    appendResumeArg(args, sessionRef.claudeSessionId);
    const model = normalizeModel(sessionRef.model || this.model);
    appendOption(args, '--model', model);
    appendOption(args, '--fallback-model', sessionRef.fallbackModel || this.fallbackModel);
    appendOption(args, '--agent', sessionRef.agent || this.agent);
    const permissionMode = sessionRef.permissionMode || this.permissionMode;
    if (SAFE_PERMISSION_MODES.has(permissionMode)) appendOption(args, '--permission-mode', permissionMode);
    for (const dir of normalizeList(this.addDirs)) appendOption(args, '--add-dir', dir);
    appendOption(args, '--settings', this.configDir);
    return args;
  }

  /**
   * 兼容 promise 风格 execFile 注入。
   * @param {string} cmd - 命令
   * @param {string[]} args - 参数
   * @param {Object} options - 执行选项
   * @returns {Promise<Object>} execFile 结果
   */
  _execFile(cmd, args, options) {
    return Promise.resolve(this.execFile(cmd, args, options));
  }

  /**
   * 收集子进程输出并转换为 AgentEvent。
   * @param {Object} child - 子进程对象
   * @param {string} pendingKey - pending map key
   * @param {string} text - stdin 文本
   * @param {AbortSignal} signal - 外部取消信号
   * @returns {Promise<AgentEvent[]>} 事件列表
   */
  _collectPrompt(child, pendingKey, text, signal) {
    return new Promise((resolve, reject) => {
      const events = [];
      const stderr = [];
      let stdoutBuffer = '';
      let completed = false;
      const timer = this.promptTimeoutMs > 0 ? setTimeout(() => {
        terminateChild(child);
        rejectWithCode(new Error('claude prompt timeout after ' + this.promptTimeoutMs + 'ms'), 'CLAUDE_PROMPT_TIMEOUT');
      }, this.promptTimeoutMs) : null;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        this._pending.delete(pendingKey);
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      };
      const rejectWithCode = (err, code) => {
        if (completed) return;
        completed = true;
        cleanup();
        err.code = err.code || code;
        reject(err);
      };
      const onAbort = () => {
        terminateChild(child);
        rejectWithCode(new Error('claude prompt cancelled'), 'ABORT_ERR');
      };

      if (signal) {
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }

      if (child.stdout && child.stdout.on) {
        child.stdout.on('data', (chunk) => {
          stdoutBuffer = consumeLines(stdoutBuffer + String(chunk), events);
        });
      }
      if (child.stderr && child.stderr.on) {
        child.stderr.on('data', (chunk) => stderr.push(String(chunk)));
      }
      if (child.stdin && child.stdin.end) child.stdin.end(String(text || ''));
      if (child.on) {
        child.on('error', (err) => rejectWithCode(new Error('claude prompt failed: ' + sanitizeError(err)), err && err.code));
        child.on('close', (code) => {
          if (completed) return;
          stdoutBuffer = consumeLines(stdoutBuffer + '\n', events);
          if (code && code !== 0) {
            rejectWithCode(new Error('claude prompt exited with code ' + code + ': ' + sanitizeText(stderr.join(''))), 'CLAUDE_EXIT_' + code);
            return;
          }
          completed = true;
          cleanup();
          if (!events.some((event) => event.type === AgentEvent.TYPE_DONE)) {
            events.push(new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'exit' }));
          }
          resolve(events);
        });
      }
    });
  }
}

/**
 * 规范化逗号分隔或数组形式的字符串列表。
 * @param {string|string[]} value - 原始列表
 * @returns {string[]} 清理后的列表
 */
function normalizeList(value) {
  if (!value) return [];
  const items = Array.isArray(value) ? value : String(value).split(',');
  return items.map((item) => String(item).trim()).filter(Boolean);
}

function createClaudeSessionId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return [4, 2, 2, 2, 6].map((bytes) => crypto.randomBytes(bytes).toString('hex')).join('-');
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function appendSessionArg(args, sessionId) {
  if (isUuid(sessionId)) {
    args.push('--session-id', String(sessionId));
  } else {
    args.push('--resume', String(sessionId));
  }
}

function appendResumeArg(args, sessionId) {
  args.push('--resume', String(sessionId));
}

/**
 * 解析正整数配置，非法时回退默认值。
 * @param {string|number} value - 原始值
 * @param {number} fallback - 默认值
 * @returns {number} 正整数
 */
function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function createCodedError(message, code) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function runtimeFromTranscriptEvent(event) {
  return {
    ...(event && typeof event.model === 'string' && event.model ? { model: event.model } : {}),
    ...(event && Number.isFinite(event.contextSize) ? { contextSize: event.contextSize } : {}),
    ...(event && event.tokenUsage && typeof event.tokenUsage === 'object' ? { tokenUsage: event.tokenUsage } : {}),
  };
}

/**
 * 规范化 Walker 模型引用到 Claude CLI 模型名。
 * @param {Object|string} model - 模型引用
 * @returns {string} CLI 模型名
 */
function normalizeModel(model) {
  if (!model) return '';
  if (typeof model === 'string') return model;
  return model.modelID || model.modelId || model.id || model.name || '';
}

/**
 * 追加非空 CLI 参数。
 * @param {string[]} args - 参数数组
 * @param {string} name - 参数名
 * @param {string} value - 参数值
 */
function appendOption(args, name, value) {
  if (value) args.push(name, String(value));
}

/**
 * 追加逗号分隔 CLI 参数。
 * @param {string[]} args - 参数数组
 * @param {string} name - 参数名
 * @param {string|string[]} value - 参数值
 */
function appendCsvOption(args, name, value) {
  const items = normalizeList(value);
  if (items.length > 0) args.push(name, items.join(','));
}

/**
 * 消费 stdout 行并映射为 AgentEvent。
 * @param {string} text - 待解析文本
 * @param {AgentEvent[]} events - 事件数组
 * @returns {string} 未完成行缓存
 */
function consumeLines(text, events) {
  const lines = text.split(/\r?\n/);
  const rest = lines.pop();
  for (const line of lines) {
    for (const event of mapClaudeLineEvents(line)) events.push(event);
  }
  return rest;
}

/**
 * 将 Claude stream-json 单行输出映射为 AgentEvent。
 * @param {string} line - 单行 JSON 或文本
 * @returns {AgentEvent|null} 统一事件
 */
function mapClaudeLine(line) {
  return mapClaudeLineEvents(line)[0] || null;
}

/**
 * 将 Claude stream-json 单行输出映射为零个或多个 AgentEvent。
 * @param {string} line - 单行 JSON 或文本
 * @returns {AgentEvent[]} 统一事件列表
 */
function mapClaudeLineEvents(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return [];
  let raw;
  try {
    raw = JSON.parse(trimmed);
  } catch (_) {
    return [new AgentEvent(AgentEvent.TYPE_TEXT, { text: trimmed })];
  }
  if (raw.type === 'result') return [new AgentEvent(AgentEvent.TYPE_DONE, { reason: raw.subtype || raw.result || 'result' })];
  if (raw.type === 'error') return [new AgentEvent(AgentEvent.TYPE_ERROR, { message: sanitizeText(raw.message || raw.error || 'claude error') })];
  if (raw.type === 'system') return [new AgentEvent(AgentEvent.TYPE_STATUS, { status: raw.subtype || raw.type })];
  if (raw.type === 'assistant' || raw.type === 'message') return mapClaudeMessage(raw);
  if (raw.type === 'user') return [];
  return [new AgentEvent(AgentEvent.TYPE_STATUS, { status: raw.type || 'unknown' })];
}

/**
 * 映射 Claude assistant/message 结构。
 * @param {Object} raw - Claude message JSON
 * @returns {AgentEvent[]} 统一事件列表
 */
function mapClaudeMessage(raw) {
  const message = raw.message || raw;
  const content = message.content || raw.content;
  if (typeof content === 'string') return [new AgentEvent(AgentEvent.TYPE_TEXT, { text: content })];
  if (!Array.isArray(content)) return [];
  const events = [];
  for (const part of content) {
    const event = mapClaudePart(part);
    if (event) events.push(event);
  }
  return events;
}

/**
 * 映射 Claude content part。
 * @param {Object} part - Claude content part
 * @returns {AgentEvent|null} 统一事件
 */
function mapClaudePart(part) {
  if (!part) return null;
  if (part.type === 'text' && part.text) return new AgentEvent(AgentEvent.TYPE_TEXT, { text: part.text });
  if ((part.type === 'thinking' || part.type === 'reasoning') && (part.text || part.thinking)) {
    return new AgentEvent(AgentEvent.TYPE_REASONING, { text: part.text || part.thinking });
  }
  if (part.type === 'tool_use') {
    return new AgentEvent(AgentEvent.TYPE_TOOL_USE, { name: part.name || '', input: part.input || {}, status: 'pending' });
  }
  if (part.type === 'tool_result') {
    return new AgentEvent(AgentEvent.TYPE_TOOL_USE, { name: part.name || part.tool_use_id || '', output: stringifyOutput(part.content), status: part.is_error ? 'error' : 'done' });
  }
  return null;
}

/**
 * 将工具输出转为字符串。
 * @param {unknown} value - 工具输出
 * @returns {string} 字符串输出
 */
function stringifyOutput(value) {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

/**
 * 终止子进程，兼容 fake child。
 * @param {Object} child - 子进程对象
 */
function terminateChild(child) {
  if (child && typeof child.kill === 'function') child.kill('SIGTERM');
}

/**
 * 脱敏 Error 对象。
 * @param {Error} err - 原始错误
 * @returns {string} 脱敏错误摘要
 */
function sanitizeError(err) {
  if (!err) return 'unknown error';
  return sanitizeText(err.message || String(err));
}

/**
 * 脱敏字符串中的常见密钥信息。
 * @param {string} value - 原始文本
 * @returns {string} 脱敏文本
 */
function sanitizeText(value) {
  return String(value || '')
    .replace(/(token|secret|api[_-]?key|password|credential)(\s*[=:]\s*)[^\s,;]+/gi, '$1$2[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+/gi, 'Bearer [redacted]')
    .replace(SENSITIVE_KEY_PATTERN, (match) => match);
}

module.exports = { ClaudeDriver, mapClaudeLine, mapClaudeLineEvents };
