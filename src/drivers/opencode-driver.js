'use strict';

const { AgentDriver, AgentEvent } = require('./agent-driver');
const { createLogger } = require('../core/logger');

const logger = createLogger('opencode-driver');

/**
 * OpenCode Agent 驱动，通过 HTTP/SSE 与 OpenCode 服务交互
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
    const url = this.serverUrl + '/api/v1/session';
    const body = {
      title: options.title || 'walker session',
      cwd: options.cwd || process.cwd(),
    };
    if (options.model) body.model = options.model;
    if (options.agent) body.agent = options.agent;

    try {
      const resp = await this.httpClient.request('POST', url, body);
      const sessionId = resp.data.id;
      logger.info('opencode session created', { opencodeSessionId: sessionId });
      return {
        opencodeSessionId: sessionId,
        serverUrl: this.serverUrl,
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
   * 向会话发送提示文本并收集 SSE 事件流响应
   * @param {Object} sessionRef - 包含 opencodeSessionId 的会话引用
   * @param {string} text - 提示文本内容
   * @returns {Promise<AgentEvent[]>} 映射后的 Agent 事件列表
   */
  async prompt(sessionRef, text) {
    if (!sessionRef || !sessionRef.opencodeSessionId) {
      throw new Error('prompt requires sessionRef with opencodeSessionId');
    }

    const sessionId = sessionRef.opencodeSessionId;
    const promptUrl = this.serverUrl + '/api/v1/session/' + sessionId + '/prompt';
    const body = { parts: [{ type: 'text', text }] };

    await this.httpClient.request('POST', promptUrl, body);

    const events = [];
    const sseUrl = this.serverUrl + '/api/v1/event?sessionID=' + sessionId;

    try {
      const rawEvents = await this.sseClient.connect(sseUrl);
      for (const raw of rawEvents) {
        const event = this._mapSSEEvent(raw);
        if (event) events.push(event);
        if (event && event.type === AgentEvent.TYPE_DONE) break;
      }
    } catch (err) {
      events.push(new AgentEvent(AgentEvent.TYPE_ERROR, { message: 'SSE connection error: ' + err.message }));
    }

    return events;
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
    const url = this.serverUrl + '/api/v1/session/' + sessionRef.opencodeSessionId + '/stop';
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
    const url = this.serverUrl + '/api/v1/session/' + sessionRef.opencodeSessionId;
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
      const resp = await this.httpClient.request('GET', this.serverUrl + '/api/v1/health', null);
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

  /**
   * 将原始 SSE 事件映射为 AgentEvent 对象
   * @param {Object} raw - 原始 SSE 事件数据
   * @returns {AgentEvent|null} 映射后的 AgentEvent，无法映射则返回 null
   */
  _mapSSEEvent(raw) {
    if (!raw || !raw.properties) return null;
    const props = raw.properties;
    const type = raw.type;

    if (type === 'session.status') {
      const statusType = props.status && props.status.type;
      if (statusType === 'idle') {
        return new AgentEvent(AgentEvent.TYPE_DONE, { reason: 'idle' });
      }
      return new AgentEvent(AgentEvent.TYPE_STATUS, { status: statusType });
    }

    if (type === 'message.updated' || type === 'message.part.updated') {
      const part = props.part;
      if (!part) return null;

      if (part.type === 'text' && part.text) {
        return new AgentEvent(AgentEvent.TYPE_TEXT, { text: part.text });
      }
      if (part.type === 'reasoning' && part.text) {
        return new AgentEvent(AgentEvent.TYPE_REASONING, { text: part.text });
      }
      if (part.type === 'tool-use') {
        return new AgentEvent(AgentEvent.TYPE_TOOL_USE, {
          name: part.toolName || part.name || '',
          input: part.toolInput || part.input || {},
        });
      }
      if (part.type === 'tool-result') {
        return new AgentEvent(AgentEvent.TYPE_TOOL_RESULT, {
          name: part.toolName || part.name || '',
          output: part.toolOutput || part.output || '',
          error: part.isError || false,
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
 * 默认 HTTP 客户端，使用 Node.js 内置 http/https 模块发送请求
 */
class DefaultHttpClient {
  /**
   * 发送 HTTP 请求
   * @param {string} method - HTTP 方法（GET/POST/PATCH/DELETE 等）
   * @param {string} url - 请求 URL
   * @param {Object|null} body - 请求体，为 null 时不发送
   * @returns {Promise<Object>} 包含 status 和 data 的响应对象
   */
  async request(method, url, body) {
    const http = require('http');
    const https = require('https');
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;
    const isBody = body !== null && body !== undefined;
    const options = {
      method,
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      headers: { 'Content-Type': 'application/json' },
    };

    return new Promise((resolve, reject) => {
      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          let parsedData = {};
          try { parsedData = JSON.parse(data); } catch (_) {}
          resolve({ status: res.statusCode, data: parsedData });
        });
      });
      req.on('error', reject);
      if (isBody) req.write(JSON.stringify(body));
      req.end();
    });
  }
}

/**
 * 默认 SSE 客户端，连接 Server-Sent Events 流并收集事件数据
 */
class DefaultSSEClient {
  /**
   * 连接 SSE 事件流并收集所有事件
   * @param {string} url - SSE 流地址
   * @returns {Promise<Object[]>} 解析后的 JSON 事件数组
   */
  async connect(url) {
    const http = require('http');
    const https = require('https');
    const parsed = new URL(url);
    const client = parsed.protocol === 'https:' ? https : http;

    return new Promise((resolve, reject) => {
      const options = {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        headers: { Accept: 'text/event-stream' },
      };

      const req = client.request(options, (res) => {
        const events = [];
        let buffer = '';

        res.on('data', (chunk) => {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (line.startsWith('data:')) {
              try {
                events.push(JSON.parse(line.slice(5).trim()));
              } catch (_) {}
            }
          }
        });

        res.on('end', () => resolve(events));
      });
      req.on('error', reject);
      req.end();
    });
  }
}

module.exports = { OpencodeDriver, DefaultHttpClient, DefaultSSEClient };
