'use strict';

const { AgentDriver, AgentEvent } = require('./agent-driver');
const { createLogger } = require('../core/logger');

const logger = createLogger('opencode-driver');

class OpencodeDriver extends AgentDriver {
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

  async resumeSession(sessionRef) {
    if (!sessionRef || !sessionRef.opencodeSessionId) {
      throw new Error('resumeSession requires sessionRef with opencodeSessionId');
    }
    logger.info('resuming opencode session', { sessionId: sessionRef.opencodeSessionId });
    return sessionRef;
  }

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

  async _checkHealth() {
    try {
      const resp = await this.httpClient.request('GET', this.serverUrl + '/api/v1/health', null);
      return resp.status === 200;
    } catch (_) {
      return false;
    }
  }

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

  _extractPort() {
    const match = this.serverUrl.match(/:(\d+)/);
    return match ? parseInt(match[1], 10) : 4096;
  }

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

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

class DefaultHttpClient {
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

class DefaultSSEClient {
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
