'use strict';

const { AgentDriver, AgentEvent } = require('./agent-driver');
const { httpRequest, sseConnect } = require('../core/http-helper');
const { createLogger } = require('../core/logger');

const logger = createLogger('opencode-driver');

/**
 * OpenCode Agent 驆动，通过 HTTP/SSE 与 OpenCode 服务交互
 */
class OpencodeDriver extends AgentDriver {
  /**
   * 初始化 OpenCode 驱动
   * @param {Object} options - 配置选项
   * @param {Object} [options.httpClient] - HTTP 请求客户端，默认使用 DefaultHttpClient
   * @param {Object} [options.sseClient] - SSE 连接客户端，默认使用 DefaultSSEClient
   * @param {string} [options.serverUrl] - OpenCode 服务地址
   * @param {boolean} [options.autostart=true] - 是否在服务不可用时自动启动
   * @param {Object} [options.runtime] - 运行时环境实例，用于自动启动服务进程
   * @param {string} [options.opencodeCmd='opencode'] - OpenCode 命令行工具名
   * @param {number} [options.pollInterval=500] - 健康检查轮询间隔（毫秒）
   * @param {number} [options.maxPolls=20] - 最大轮询次数
   * @param {number} [options.promptTimeoutMs=120000] - prompt SSE 最大等待时间
   * @param {number} [options.sseOpenTimeoutMs=1000] - 发 prompt 前等待 SSE 建连的最长时间
   */
  constructor(options) {
    super('opencode');
    this.httpClient = options.httpClient || new DefaultHttpClient();
    this.sseClient = options.sseClient || new DefaultSSEClient();
    this.serverUrl = options.serverUrl || '';
    this.autostart = options.autostart !== undefined ? options.autostart : true;
    this.runtime = options.runtime || null;
    this.opencodeCmd = options.opencodeCmd || 'opencode';
    this.pollInterval = options.pollInterval || 500;
    this.maxPolls = options.maxPolls || 20;
    this.promptTimeoutMs = options.promptTimeoutMs || 120000;
    this.sseOpenTimeoutMs = options.sseOpenTimeoutMs || 1000;
    this.watchers = new Map();
    this.suspendedWatches = new Set();
  }

  /**
   * 确保 OpenCode 服务就绪，必要时自动启动
   * @returns {Promise<boolean>} 服务就绪返回 true
   */
  async ensureReady() {
    if (await this._checkHealth()) {
      logger.info('opencode server already ready');
      return true;
    }

    if (!this.autostart) {
      throw new Error('opencode server not available at ' + this.serverUrl + '. Set OPENCODE_SERVER_AUTOSTART=true or start manually.');
    }

    logger.info('autostarting opencode server');
    this._startServer();

    for (let i = 0; i < this.maxPolls; i++) {
      await this._sleep(this.pollInterval);
      if (await this._checkHealth()) {
        logger.info('opencode server started successfully');
        return true;
      }
    }

    throw new Error('opencode server failed to start at ' + this.serverUrl + ' after ' + (this.maxPolls * this.pollInterval) + 'ms');
  }

  /**
   * 在 OpenCode 服务上创建新会话
   * @param {Object} options - 会话创建选项
   * @param {string} [options.title] - 会话标题
   * @param {string} [options.cwd] - 工作目录
   * @param {string} [options.model] - 模型名称
   * @param {string} [options.agent] - Agent 名称
   * @returns {Promise<Object>} 包含 opencodeSessionId 和 serverUrl 的会话引用
   */
  async createSession(options) {
    const cwd = options.cwd || process.cwd();
    const url = this._buildUrl('/session', { directory: cwd });
    const body = {
      title: options.title || 'walker session',
    };
    if (options.model) body.model = options.model;
    if (options.agent) body.agent = options.agent;

    try {
      const resp = await this.httpClient.request('POST', url, body);
      const status = resp && resp.status;
      const responseSummary = this._summarizeResponse(resp);
      if (typeof status === 'number' && (status < 200 || status >= 300)) {
        throw new Error('HTTP ' + status + ' from ' + this.serverUrl + ': ' + responseSummary);
      }

      const sessionId = resp && (resp.id || resp.sessionID || resp.sessionId || (resp.data && (resp.data.id || resp.data.sessionID || resp.data.sessionId)));
      if (!sessionId) {
        throw new Error('missing session id from ' + this.serverUrl + ': ' + responseSummary);
      }
      logger.info('opencode session created', { opencodeSessionId: sessionId });

      await this._openTerminalForSession(sessionId, options.cwd);

      return {
        opencodeSessionId: sessionId,
        serverUrl: this.serverUrl,
        cwd,
      };
    } catch (err) {
      throw new Error('Failed to create opencode session at ' + this.serverUrl + ': ' + err.message);
    }
  }

  /**
   * 恢复已有 OpenCode 会话
   * @param {Object} sessionRef - 包含 opencodeSessionId 的会话引用
   * @returns {Promise<Object>} 原会话引用对象
   */
  async resumeSession(sessionRef) {
    if (!sessionRef || !sessionRef.opencodeSessionId) {
      throw new Error('resumeSession requires sessionRef with opencodeSessionId');
    }
    logger.info('resuming opencode session', { sessionId: sessionRef.opencodeSessionId });
    return sessionRef;
  }

  /**
   * 列出 OpenCode 服务中已有的会话，用于纳入 Walker 管理
   * @param {Object} [options] - 查询选项
   * @param {string} [options.cwd] - 工作目录，用于 OpenCode 按目录定位会话数据
   * @returns {Promise<Object[]>} 已规范化的 OpenCode 会话列表
   */
  async listModels() {
    const url = this._buildUrl('/api/model', {});
    try {
      const resp = await this.httpClient.request('GET', url, null);
      const models = this._extractModelList(resp);
      return models.map((m) => ({
        id: m.id || m.modelID || '',
        name: m.name || m.modelName || '',
        provider: m.providerID || m.provider || '',
        status: m.status || '',
        enabled: m.enabled !== undefined ? m.enabled : true,
      })).filter((m) => m.id && m.enabled);
    } catch (err) {
      throw new Error('Failed to list models at ' + this.serverUrl + ': ' + err.message);
    }
  }

  _extractModelList(resp) {
    if (Array.isArray(resp)) return resp;
    if (!resp) return [];
    if (Array.isArray(resp.data)) return resp.data;
    if (resp.data && Array.isArray(resp.data.data)) return resp.data.data;
    if (resp.data && Array.isArray(resp.data.models)) return resp.data.models;
    return [];
  }

  async listSessions(options) {
    const cwd = (options && options.cwd) || process.cwd();
    const url = this._buildUrl('/session', { directory: cwd });
    try {
      const resp = await this.httpClient.request('GET', url, null);
      return this._extractSessionList(resp).map((session) => this._normalizeSessionSummary(session, cwd)).filter((session) => session.id);
    } catch (err) {
      throw new Error('Failed to list opencode sessions at ' + this.serverUrl + ': ' + err.message);
    }
  }

  /**
   * 向会话发送提示文本并收集 SSE 事件流响应
   * @param {Object} sessionRef - 包含 opencodeSessionId 的会话引用
   * @param {string} text - 提示文本内容
   * @returns {Promise<AgentEvent[]>} 映射后的 Agent 事件列表
   */
  async prompt(sessionRef, text, options) {
    if (!sessionRef || !sessionRef.opencodeSessionId) {
      throw new Error('prompt requires sessionRef with opencodeSessionId');
    }

    const sessionId = sessionRef.opencodeSessionId;
    this.suspendWatch(sessionRef);
    const promptUrl = this._buildUrl('/session/' + sessionId + '/prompt_async', { directory: sessionRef.cwd });
    const body = { parts: [{ type: 'text', text }] };
    if (options && options.model) {
      const m = options.model;
      if (typeof m === 'string') {
        body.model = { modelID: m };
      } else {
        body.model = m;
      }
    }

    const events = [];
    const sseUrl = this._buildUrl('/event', { directory: sessionRef.cwd });
    let markSSEOpen;
    const sseOpened = new Promise((resolve) => { markSSEOpen = resolve; });

    try {
      logger.info('opencode sse connecting', { sessionId, sseUrl });
      const ssePromise = this.sseClient.connect(sseUrl, {
        timeoutMs: this.promptTimeoutMs,
        onOpen: () => {
          logger.info('opencode sse opened', { sessionId, sseUrl });
          markSSEOpen();
        },
        onEvent: (raw) => {
          const event = this._normalizeSSEEvent(raw);
          logger.info('opencode sse event received', {
            sessionId,
            type: event && event.type,
            status: event && event.properties && event.properties.status && event.properties.status.type,
            partType: event && event.properties && event.properties.part && event.properties.part.type,
          });
        },
        shouldClose: (raw) => this._isTerminalSSEEvent(raw, sessionId),
      });
      ssePromise.catch(() => {});

      await Promise.race([
        sseOpened,
        this._sleep(this.sseOpenTimeoutMs),
      ]);

      logger.info('opencode prompt start', {
        sessionId,
        promptUrl,
        textLength: text ? text.length : 0,
      });
      const promptResp = await this.httpClient.request('POST', promptUrl, body);
      logger.info('opencode prompt posted', { sessionId, promptUrl, status: promptResp && promptResp.status });
      if (promptResp && promptResp.status && (promptResp.status < 200 || promptResp.status >= 300)) {
        throw new Error('opencode prompt failed with HTTP ' + promptResp.status);
      }

      const rawEvents = await ssePromise;
      for (const raw of rawEvents) {
        const event = this._mapSSEEvent(raw, sessionId);
        if (event) events.push(event);
        if (event && event.type === AgentEvent.TYPE_DONE) break;
      }
      logger.info('opencode sse completed', { sessionId, eventCount: events.length });
    } catch (err) {
      logger.warn('opencode sse failed', { sessionId, error: err.message });
      events.push(new AgentEvent(AgentEvent.TYPE_ERROR, { message: 'SSE connection error: ' + err.message }));
    } finally {
      this.resumeWatch(sessionRef);
    }

    return events;
  }

  watchSession(sessionRef, handlers) {
    if (!sessionRef || !sessionRef.opencodeSessionId) {
      throw new Error('watchSession requires sessionRef with opencodeSessionId');
    }
    const sessionId = sessionRef.opencodeSessionId;
    if (this.watchers.has(sessionId)) return this.watchers.get(sessionId).stop;

    const controller = new AbortController();
    const sseUrl = this._buildUrl('/event', { directory: sessionRef.cwd });
    const watcher = {
      stop: () => {
        controller.abort();
        this.watchers.delete(sessionId);
      },
    };
    this.watchers.set(sessionId, watcher);

    this.sseClient.connect(sseUrl, {
      signal: controller.signal,
      collectEvents: false,
      onOpen: () => logger.info('opencode session watch opened', { sessionId, sseUrl }),
      onEvent: (raw) => {
        if (this.suspendedWatches.has(sessionId)) return;
        const event = this._mapSSEEvent(raw, sessionId);
        if (event && handlers && handlers.onEvent) handlers.onEvent(event, raw);
      },
    }).catch((err) => {
      if (!controller.signal.aborted) {
        logger.warn('opencode session watch failed', { sessionId, error: err.message });
        if (handlers && handlers.onError) handlers.onError(err);
      }
    }).finally(() => {
      if (this.watchers.get(sessionId) === watcher) this.watchers.delete(sessionId);
    });

    return watcher.stop;
  }

  suspendWatch(sessionRef) {
    const sessionId = sessionRef && sessionRef.opencodeSessionId;
    if (sessionId) this.suspendedWatches.add(sessionId);
  }

  resumeWatch(sessionRef) {
    const sessionId = sessionRef && sessionRef.opencodeSessionId;
    if (sessionId) this.suspendedWatches.delete(sessionId);
  }

  /**
   * 停止指定 OpenCode 会话
   * @param {Object} sessionRef - 包含 opencodeSessionId 的会话引用
   * @returns {Promise<void>}
   */
  async stop(sessionRef) {
    if (!sessionRef || !sessionRef.opencodeSessionId) {
      throw new Error('stop requires sessionRef with opencodeSessionId');
    }
    const url = this.serverUrl + '/session/' + sessionRef.opencodeSessionId + '/stop';
    try {
      await this.httpClient.request('POST', url, {});
      logger.info('opencode session stopped', { sessionId: sessionRef.opencodeSessionId });
    } catch (err) {
      logger.warn('opencode session stop failed', { error: err.message });
    }
  }

  /**
   * 删除指定 OpenCode 会话
   * @param {Object} sessionRef - 包含 opencodeSessionId 的会话引用
   * @returns {Promise<void>}
   */
  async delete(sessionRef) {
    if (!sessionRef || !sessionRef.opencodeSessionId) {
      throw new Error('delete requires sessionRef with opencodeSessionId');
    }
    const url = this.serverUrl + '/session/' + sessionRef.opencodeSessionId;
    try {
      await this.httpClient.request('DELETE', url, null);
      logger.info('opencode session deleted', { sessionId: sessionRef.opencodeSessionId });
    } catch (err) {
      logger.warn('opencode session delete failed', { error: err.message });
    }
  }

  /**
   * 检查 OpenCode 服务健康状态
   * @returns {Promise<boolean>} 服务正常返回 true，否则返回 false
   */
  async _checkHealth() {
    try {
      const resp = await this.httpClient.request('GET', this.serverUrl + '/health', null);
      return resp.status === 200;
    } catch (_) {
      return false;
    }
  }

  /**
   * 通过运行时环境启动 OpenCode 服务进程
   */
  _startServer() {
    if (!this.runtime) {
      throw new Error('runtime not configured for autostart');
    }
    const port = this._extractPort();
    const args = ['serve', '--hostname', '127.0.0.1', '--port', String(port)];
    const proc = this.runtime.spawn(this.opencodeCmd, args, { detached: true, stdio: 'ignore' });
    if (proc && proc.unref) proc.unref();
    logger.info('opencode server process spawned', { pid: proc ? proc.pid : null });
  }

  /**
   * 从 serverUrl 中提取端口号
   * @returns {number} 端口号，默认 4096
   */
  _extractPort() {
    const match = this.serverUrl.match(/:(\d+)/);
    return match ? parseInt(match[1], 10) : 4096;
  }

  _buildUrl(pathname, query) {
    const url = new URL(pathname, this.serverUrl);
    for (const [key, value] of Object.entries(query || {})) {
      if (value) url.searchParams.set(key, value);
    }
    return url.toString();
  }

  _extractSessionList(resp) {
    if (Array.isArray(resp)) return resp;
    if (!resp) return [];
    if (Array.isArray(resp.data)) return resp.data;
    if (resp.data && Array.isArray(resp.data.sessions)) return resp.data.sessions;
    if (resp.data && Array.isArray(resp.data.items)) return resp.data.items;
    if (Array.isArray(resp.sessions)) return resp.sessions;
    if (Array.isArray(resp.items)) return resp.items;
    return [];
  }

  _normalizeSessionSummary(raw, fallbackCwd) {
    raw = raw || {};
    const id = raw.id || raw.sessionID || raw.sessionId || '';
    const status = raw.status && typeof raw.status === 'object' ? raw.status.type : raw.status;
    return {
      id,
      title: raw.title || raw.name || (id ? 'opencode ' + id.slice(0, 12) : 'opencode session'),
      status: status || 'unknown',
      cwd: raw.cwd || raw.directory || raw.path || (raw.workspace && raw.workspace.path) || fallbackCwd || '',
      updatedAt: raw.updatedAt || raw.updated || raw.timeUpdated || null,
    };
  }

  /**
   * 在终端窗口中打开 opencode TUI 以恢复指定会话，用户可在终端接手工作
   * @param {string} sessionId - opencode 会话 ID
   * @param {string} [cwd] - 工作目录
   */
  async _openTerminalForSession(sessionId, cwd) {
    if (!this.runtime || typeof this.runtime.openTerminal !== 'function') {
      logger.info('runtime does not support openTerminal, skipping');
      return;
    }

    const args = ['attach', this.serverUrl, '-s', sessionId];
    if (cwd) args.push('--dir', cwd);

    try {
      await this.runtime.openTerminal(this.opencodeCmd, args, {
        cwd: cwd || process.cwd(),
        title: 'opencode ' + sessionId.slice(0, 12),
      });
      logger.info('terminal window opened for session', { sessionId });
    } catch (err) {
      logger.warn('failed to open terminal window', { error: err.message });
    }
  }

  /**
   * 将原始 SSE 事件映射为 AgentEvent 对象
   * @param {Object} raw - 原始 SSE 事件数据
   * @param {string} [sessionId] - 目标 session ID，用于过滤其它会话事件
   * @returns {AgentEvent|null} 映射后的 AgentEvent，无法映射则返回 null
   */
  _mapSSEEvent(raw, sessionId) {
    raw = this._normalizeSSEEvent(raw);
    if (!raw || !raw.properties) return null;
    const props = raw.properties;
    if (!this._eventBelongsToSession(props, sessionId)) return null;
    const type = raw.type;

    if (type === 'session.status') {
      const statusType = props.status && props.status.type;
      if (statusType === 'idle') {
        return new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' });
      }
      return new AgentEvent(AgentEvent.TYPE_STATUS, { status: statusType });
    }

    if (type === 'message.part.delta') {
      if (this._isUserMessageEvent(props)) return null;
      if (props.field === 'text' && props.delta) {
        return new AgentEvent(AgentEvent.TYPE_TEXT, { text: props.delta, delta: true });
      }
      return null;
    }

    if (type === 'message.updated' || type === 'message.part.updated') {
      if (this._isUserMessageEvent(props)) return null;
      const part = props.part;
      if (!part) return null;

      const text = part.text || part.content || part.value || '';
      if (part.type === 'text' && text) {
        return new AgentEvent(AgentEvent.TYPE_TEXT, { text });
      }
      if (part.type === 'reasoning' && text) {
        return new AgentEvent(AgentEvent.TYPE_REASONING, { text });
      }
      if (part.type === 'tool-use') {
        return new AgentEvent(AgentEvent.TYPE_TOOL_USE, {
          name: part.toolName || part.name || '',
          input: part.toolInput || part.input || {},
        });
      }
      if (part.type === 'tool-result') {
        return new AgentEvent(AgentEvent.TYPE_TOOL_USE, {
          name: part.toolName || part.name || '',
          output: part.toolOutput || part.output || '',
          status: part.isError ? 'error' : 'done',
        });
      }
    }

    if (type === 'session.error') {
      const errMsg = typeof props.error === 'string'
        ? props.error
        : (props.error && props.error.message) || 'session error';
      return new AgentEvent(AgentEvent.TYPE_ERROR, { message: errMsg });
    }

    return null;
  }

  _isTerminalSSEEvent(raw, sessionId) {
    raw = this._normalizeSSEEvent(raw);
    if (!raw || !raw.properties) return false;
    const props = raw.properties;
    const eventSessionId = props.sessionID || props.sessionId || (props.session && props.session.id);
    if (sessionId && eventSessionId !== sessionId) return false;
    if (raw.type === 'session.error') return true;
    if (raw.type !== 'session.status') return false;
    return props.status && props.status.type === 'idle';
  }

  _normalizeSSEEvent(raw) {
    if (raw && raw.payload && raw.payload.type) return raw.payload;
    return raw;
  }

  _eventBelongsToSession(props, sessionId) {
    if (!sessionId) return true;
    const eventSessionId = props.sessionID || props.sessionId || (props.session && props.session.id);
    return eventSessionId === sessionId;
  }

  _summarizeResponse(resp) {
    if (resp === undefined) return 'undefined response';
    try {
      const text = JSON.stringify(resp);
      return text && text.length > 500 ? text.slice(0, 500) + '...' : text;
    } catch (_) {
      return String(resp);
    }
  }

  _isUserMessageEvent(props) {
    const role = props.role
      || (props.message && props.message.role)
      || (props.part && props.part.role)
      || (props.author && props.author.role);
    return role === 'user';
  }

  /**
   * 等待指定毫秒数
   * @param {number} ms - 等待时间（毫秒）
   * @returns {Promise<void>}
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * 默认 HTTP 客户端，委托给共享的 httpRequest 工具函数
 */
class DefaultHttpClient {
  /**
   * 发送 HTTP 请求，委托给 http-helper 的 httpRequest
   * @param {string} method - HTTP 方法
   * @param {string} url - 请求 URL
   * @param {Object|null} body - 请求体
   * @returns {Promise<Object>} 包含 status 和 data 的响应对象
   */
  async request(method, url, body) {
    return httpRequest(method, url, body);
  }
}

/**
 * 默认 SSE 客户端，委托给共享的 sseConnect 工具函数
 */
class DefaultSSEClient {
  /**
   * 连接 SSE 事件流，委托给 http-helper 的 sseConnect
   * @param {string} url - SSE 流地址
   * @param {Object} [options] - SSE 连接选项
   * @returns {Promise<Object[]>} 解析后的 JSON 事件数组
   */
  async connect(url, options) {
    return sseConnect(url, null, options);
  }
}

module.exports = { OpencodeDriver, DefaultHttpClient, DefaultSSEClient };
