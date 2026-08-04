'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { URL } = require('node:url');
const WebSocket = require('ws');

const { createLogger } = require('../core/logger');

const MIN_TOKEN_BYTES = 32;
const MAX_RESIZE_COLS = 1000;
const MAX_RESIZE_ROWS = 1000;

function defaultTokenFactory() {
  return crypto.randomBytes(MIN_TOKEN_BYTES).toString('hex');
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function isValidSize(value, max) {
  return Number.isInteger(value) && value > 0 && value <= max;
}

class ClaudeAttachServer {
  constructor(options) {
    const opts = options || {};
    if (!opts.broker) throw new Error('broker is required');
    this.broker = opts.broker;
    this.host = opts.host || '127.0.0.1';
    this.port = opts.port == null ? 0 : opts.port;
    this.tokenFactory = opts.tokenFactory || defaultTokenFactory;
    this.logger = opts.logger || createLogger('claude-attach-server');
    this.attachments = new Map();
    this.clients = new Set();
    this.server = null;
    this.wss = null;
  }

  start() {
    if (this.server) return Promise.resolve(this.address());
    this.server = http.createServer();
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
    if (!this.server) return null;
    return this.server.address();
  }

  createAttachment(runtimeId) {
    if (!runtimeId) throw new Error('runtimeId is required');
    if (!this.broker.getRuntime(runtimeId)) throw new Error('runtime not found: ' + runtimeId);
    const token = String(this.tokenFactory());
    if (Buffer.byteLength(token) < MIN_TOKEN_BYTES) throw new Error('attach token must be at least 32 bytes');
    const attachment = { runtimeId, token };
    this.attachments.set(runtimeId, attachment);
    this.logger.info('claude attach credential created', { runtimeId });
    return { runtimeId, url: this.urlFor(runtimeId), token };
  }

  getAttachment(runtimeId) {
    const attachment = this.attachments.get(runtimeId);
    if (!attachment) return null;
    return { runtimeId, url: this.urlFor(runtimeId) };
  }

  urlFor(runtimeId) {
    const attachment = this.attachments.get(runtimeId);
    if (!attachment) throw new Error('attachment not found: ' + runtimeId);
    const address = this.address();
    if (!address) throw new Error('attach server is not started');
    return 'ws://' + this.host + ':' + address.port + '/attach/' + encodeURIComponent(runtimeId) + '?token=' + encodeURIComponent(attachment.token);
  }

  _handleUpgrade(request, socket, head) {
    const remoteAddress = socket.remoteAddress;
    const result = this._validateRequest(request, remoteAddress);
    if (!result.ok) {
      this.logger.warn('claude attach rejected', { runtimeId: result.runtimeId, reason: result.reason, remoteAddress });
      this.wss.handleUpgrade(request, socket, head, (ws) => ws.close(1008, 'unauthorized'));
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => this._attach(ws, result.runtimeId));
  }

  _validateRequest(request, remoteAddress) {
    if (!isLoopback(remoteAddress)) return { ok: false, reason: 'non-loopback client' };
    let url;
    try {
      url = new URL(request.url, 'ws://' + this.host);
    } catch (_) {
      return { ok: false, reason: 'invalid url' };
    }
    const match = /^\/attach\/([^/]+)$/.exec(url.pathname);
    const runtimeId = match ? decodeURIComponent(match[1]) : '';
    if (!runtimeId) return { ok: false, reason: 'missing runtimeId' };
    const attachment = this.attachments.get(runtimeId);
    if (!attachment) return { ok: false, reason: 'missing attachment', runtimeId };
    if (!this.broker.getRuntime(runtimeId)) return { ok: false, reason: 'runtime not found', runtimeId };
    if (url.searchParams.get('token') !== attachment.token) return { ok: false, reason: 'invalid token', runtimeId };
    return { ok: true, runtimeId };
  }

  _attach(ws, runtimeId) {
    this.clients.add(ws);
    let unsubscribe = null;
    let closed = false;
    const closeWithError = (message) => {
      if (closed) return;
      closed = true;
      try { ws.send(JSON.stringify({ type: 'error', message })); } catch (_) {}
      ws.close(1008, 'protocol error');
    };

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        Promise.resolve(this.broker.writeInput(runtimeId, Buffer.from(data), { source: 'attach' })).catch((err) => closeWithError(err.message));
        return;
      }
      this._handleTextFrame(runtimeId, data, closeWithError);
    });
    ws.on('close', () => {
      closed = true;
      this.clients.delete(ws);
      if (unsubscribe) unsubscribe();
      if (this.broker && typeof this.broker.detach === 'function') this.broker.detach(runtimeId);
      this.logger.info('claude attach detached', { runtimeId });
    });
    this.logger.info('claude attach connected', { runtimeId });
    setImmediate(() => {
      if (closed) return;
      try {
        unsubscribe = this.broker.subscribeOutput(runtimeId, (chunk) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        }, { replay: true });
      } catch (err) {
        closeWithError(err.message);
      }
    });
  }

  _handleTextFrame(runtimeId, data, closeWithError) {
    let frame;
    try {
      frame = JSON.parse(Buffer.from(data).toString('utf8'));
    } catch (_) {
      closeWithError('invalid json');
      return;
    }
    if (!frame || frame.type !== 'resize') {
      closeWithError('unknown control frame');
      return;
    }
    if (!isValidSize(frame.cols, MAX_RESIZE_COLS) || !isValidSize(frame.rows, MAX_RESIZE_ROWS)) {
      closeWithError('invalid terminal size');
      return;
    }
    Promise.resolve(this.broker.resize(runtimeId, frame.cols, frame.rows)).catch((err) => closeWithError(err.message));
  }
}

module.exports = { ClaudeAttachServer, isLoopback };
