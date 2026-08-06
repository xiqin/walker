'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const WebSocket = require('ws');

const SENSITIVE_KEY_RE = /(token|secret|password|credential|api[_-]?key|app[_-]?secret)/i;

function defaultTokenFactory() {
  return crypto.randomBytes(32).toString('hex');
}

function isLoopback(remoteAddress) {
  if (!remoteAddress) return false;
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1' || remoteAddress === 'localhost';
}

function safeEqual(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

class ClaudeBridgeSidecar {
  constructor(options) {
    const opts = options || {};
    this.host = opts.host || '127.0.0.1';
    this.port = opts.port == null ? 0 : opts.port;
    this.token = opts.token || defaultTokenFactory();
    this.tokenFactory = opts.tokenFactory || defaultTokenFactory;
    this.logger = opts.logger || { info() {}, warn() {}, error() {} };
    this.now = opts.now || Date.now;
    this.runtimes = opts.registry || new Map();
    this.attachments = new Map();
    this.clients = new Set();
    this.server = opts.server || null;
    this.wss = null;
  }

  start() {
    if (this.server) return Promise.resolve(this.address());
    this.server = http.createServer((request, response) => this._handleHttp(request, response));
    this.wss = new WebSocket.Server({ noServer: true });
    this.server.on('upgrade', (request, socket, head) => this._handleUpgrade(request, socket, head));
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server = null;
        this.wss = null;
        reject(err);
      };
      this.server.once('error', onError);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', onError);
        resolve(this.address());
      });
    });
  }

  stop() {
    for (const client of this.clients) {
      try { client.terminate(); } catch (_) {}
    }
    this.clients.clear();
    const closeWs = this.wss ? new Promise((resolve) => this.wss.close(() => resolve())) : Promise.resolve();
    const closeServer = this.server ? new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    }) : Promise.resolve();
    this.server = null;
    this.wss = null;
    return Promise.all([closeWs, closeServer]).then(() => undefined);
  }

  address() {
    return this.server && typeof this.server.address === 'function' ? this.server.address() : null;
  }

  registerRuntime(options) {
    const opts = options || {};
    if (!opts.runtimeId) throw new Error('runtimeId is required');
    if (!opts.claudeSessionId) throw new Error('claudeSessionId is required');
    const existing = this.runtimes.get(opts.runtimeId);
    const record = existing || {
      runtimeId: opts.runtimeId,
      pending: new Set(),
      subscribers: new Set(),
      attachments: new Set(),
    };
    record.claudeSessionId = opts.claudeSessionId;
    record.status = opts.status || 'active';
    record.processGeneration = opts.processGeneration || record.processGeneration || 1;
    record.cwd = opts.cwd || record.cwd || process.cwd();
    record.runtime = opts.runtime || record.runtime || null;
    record.reconnectable = opts.reconnectable == null ? true : Boolean(opts.reconnectable);
    record.lastSeenAt = this.now();
    record.connectionState = existing ? 'reused' : 'active';
    record.lastPath = existing ? 'reused' : 'registered';
    record.error = null;
    this.runtimes.set(record.runtimeId, record);
    this._log('info', 'claude bridge runtime registered', record, { path: record.lastPath, connectionState: record.connectionState });
    return this._snapshot(record);
  }

  getRuntime(runtimeId) {
    const record = this.runtimes.get(runtimeId);
    return record ? this._snapshot(record) : null;
  }

  listRuntimes() {
    return Array.from(this.runtimes.values()).map((record) => this._snapshot(record));
  }

  writeInput(runtimeId, text) {
    const record = this._requireRuntime(runtimeId);
    if (!record.runtime || (typeof record.runtime.writeInput !== 'function' && typeof record.runtime.write !== 'function')) return Promise.reject(new Error('runtime input is unavailable'));
    record.lastSeenAt = this.now();
    this._log('info', 'claude bridge input write', record, { path: record.lastPath || 'active' });
    return this._trackInput(record, () => (typeof record.runtime.writeInput === 'function' ? record.runtime.writeInput(text) : record.runtime.write(text)));
  }

  subscribeOutput(runtimeId, handler, options) {
    if (typeof handler !== 'function') throw new TypeError('subscriber must be a function');
    const record = this._requireRuntime(runtimeId);
    if (record.runtime && typeof record.runtime.subscribeOutput === 'function') return record.runtime.subscribeOutput(handler, options || {});
    if (record.runtime && typeof record.runtime.on === 'function') {
      record.runtime.on('data', handler);
      return () => record.runtime.off('data', handler);
    }
    throw new Error('runtime output is unavailable');
  }

  createAttachment(runtimeId) {
    const record = this._requireRuntime(runtimeId);
    const token = String(this.tokenFactory());
    const attachment = { runtimeId, token };
    this.attachments.set(runtimeId, attachment);
    record.attachments.add(runtimeId);
    this._log('info', 'claude bridge attachment created', record, { path: 'attach-created' });
    return { runtimeId, url: this.urlFor(runtimeId), token };
  }

  getAttachment(runtimeId) {
    if (!this.attachments.has(runtimeId)) return null;
    return { runtimeId, url: this.urlFor(runtimeId) };
  }

  urlFor(runtimeId) {
    const attachment = this.attachments.get(runtimeId);
    if (!attachment) throw new Error('attachment not found: ' + runtimeId);
    const address = this.address();
    const port = address && address.port != null ? address.port : this.port;
    return 'ws://' + this.host + ':' + port + '/attach/' + encodeURIComponent(runtimeId) + '?token=' + encodeURIComponent(attachment.token);
  }

  stopWalkerConnection(reason) {
    const err = new Error('walker connection stopped: ' + this._sanitizeReason(reason || 'shutdown'));
    for (const record of this.runtimes.values()) {
      for (const pending of Array.from(record.pending)) {
        if (!pending.settled) pending.reject(err);
        record.pending.delete(pending);
      }
      record.status = 'walker-disconnected';
      record.reconnectable = true;
      record.connectionState = 'reconnectable';
      record.lastPath = 'reconnected';
      record.lastSeenAt = this.now();
      this._log('info', 'claude bridge runtime reconnectable', record, { path: 'reconnected', reason: this._sanitizeReason(reason || 'shutdown') });
    }
  }

  _handleHttp(request, response) {
    const token = request.headers.authorization && request.headers.authorization.replace(/^Bearer\s+/i, '');
    const auth = this._authorize({ remoteAddress: request.socket.remoteAddress, token });
    if (!auth.ok) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: this._unauthorized(auth.reason).message }));
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true, runtimes: this.listRuntimes() }));
  }

  _handleUpgrade(request, socket, head) {
    let url;
    try {
      url = new URL(request.url, 'ws://' + this.host);
    } catch (_) {
      socket.destroy();
      return;
    }
    const match = /^\/attach\/([^/]+)$/.exec(url.pathname);
    const runtimeId = match ? decodeURIComponent(match[1]) : '';
    const attachment = runtimeId ? this.attachments.get(runtimeId) : null;
    const token = url.searchParams.get('token');
    const auth = this._authorize({ remoteAddress: socket.remoteAddress, token, expectedToken: attachment && attachment.token });
    if (!runtimeId || !attachment || !auth.ok) {
      this._log('warn', 'claude bridge attach rejected', { runtimeId: runtimeId || 'unknown', processGeneration: 0 }, { reason: auth.reason || 'missing attachment', remoteAddress: socket.remoteAddress });
      this.wss.handleUpgrade(request, socket, head, (ws) => ws.close(1008, this._unauthorized(auth.reason || 'missing attachment').message));
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => this._attach(ws, runtimeId));
  }

  _attach(ws, runtimeId) {
    this.clients.add(ws);
    let unsubscribe = null;
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      this.writeInput(runtimeId, Buffer.from(data)).catch((err) => {
        try { ws.close(1011, this._sanitizeReason(err.message)); } catch (_) {}
      });
    });
    ws.on('close', () => {
      this.clients.delete(ws);
      if (unsubscribe) unsubscribe();
    });
    unsubscribe = this.subscribeOutput(runtimeId, (chunk) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }, { replay: true });
  }

  _authorize(options) {
    const opts = options || {};
    if (!this._isLoopback(opts.remoteAddress)) return { ok: false, reason: 'non-loopback client' };
    if (!opts.token) return { ok: false, reason: 'missing token' };
    if (!safeEqual(opts.token, opts.expectedToken || this.token)) return { ok: false, reason: 'invalid token' };
    return { ok: true };
  }

  _isLoopback(remoteAddress) {
    return isLoopback(remoteAddress);
  }

  _unauthorized(reason) {
    const err = new Error('unauthorized: ' + this._sanitizeReason(reason || 'invalid token'));
    err.code = 'CLAUDE_BRIDGE_UNAUTHORIZED';
    err.reason = this._sanitizeReason(reason || 'invalid token');
    return err;
  }

  _requireRuntime(runtimeId) {
    const record = this.runtimes.get(runtimeId);
    if (!record) throw new Error('runtime not found: ' + runtimeId);
    return record;
  }

  _trackInput(record, fn) {
    let result;
    try {
      result = fn();
    } catch (err) {
      return Promise.reject(err);
    }
    const pending = { settled: false, reject: null };
    const tracked = new Promise((resolve, reject) => {
      pending.reject = reject;
      Promise.resolve(result).then(resolve, reject).finally(() => {
        pending.settled = true;
        record.pending.delete(pending);
      });
    });
    record.pending.add(pending);
    return tracked;
  }

  _snapshot(record) {
    return {
      runtimeId: record.runtimeId,
      claudeSessionId: record.claudeSessionId,
      status: record.status,
      processGeneration: record.processGeneration,
      cwd: record.cwd,
      reconnectable: Boolean(record.reconnectable),
      lastSeenAt: record.lastSeenAt,
      connectionState: record.connectionState || 'unknown',
      lastPath: record.lastPath || 'unknown',
      pendingInputs: record.pending.size,
      agentRef: {
        provider: 'claude',
        transport: 'bridge-sidecar',
        runtimeId: record.runtimeId,
        claudeSessionId: record.claudeSessionId,
        processGeneration: record.processGeneration,
      },
    };
  }

  _log(level, message, record, extra) {
    const row = this._sanitize({ runtimeId: record.runtimeId, processGeneration: record.processGeneration, ...extra });
    const fn = this.logger[level] || this.logger.info || function noop() {};
    fn.call(this.logger, this._sanitizeReason(message), row);
  }

  _sanitize(value, key) {
    if (value == null) return value;
    if (key && SENSITIVE_KEY_RE.test(String(key))) return value ? '[redacted]' : '';
    if (Array.isArray(value)) return value.map((item) => this._sanitize(item));
    if (typeof value === 'object') {
      const result = {};
      for (const [childKey, childValue] of Object.entries(value)) result[childKey] = this._sanitize(childValue, childKey);
      return result;
    }
    if (typeof value !== 'string') return value;
    return this._sanitizeReason(value);
  }

  _sanitizeReason(value) {
    return String(value)
      .replace(/(WALKER_ADMIN_TOKEN|FEISHU_APP_SECRET|TOKEN|SECRET|PASSWORD|API_KEY)=([^\s]+)/gi, '$1=[redacted]')
      .replace(/(Bearer\s+)[A-Za-z0-9._~+\-/]+=*/gi, '$1[redacted]');
  }
}

module.exports = { ClaudeBridgeSidecar, isLoopback };
