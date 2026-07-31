'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { isAuthenticated } = require('./auth');
const { recordEvent } = require('./event-store');
const { createLogger } = require('../core/logger');

const STREAM_PATH = '/api/v1/events/stream';
const HEARTBEAT_INTERVAL_MS = 30000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_FILTER_VALUE_LENGTH = 128;
const MAX_BAD_MESSAGES = 3;
const SENSITIVE_KEY = /token|secret|authorization|cookie|api[-_]?key|password|credential/i;

function createEventsWebSocketHandler(options) {
  const opts = options || {};
  const config = opts.config || {};
  const sessionStore = opts.sessionStore || null;
  const eventStore = opts.eventStore;
  const eventBus = opts.eventBus;
  const logger = opts.logger || createLogger('admin-ws-events');
  const heartbeatIntervalMs = opts.heartbeatIntervalMs || HEARTBEAT_INTERVAL_MS;
  const maxPayload = opts.maxPayload || MAX_PAYLOAD_BYTES;
  const wss = new WebSocketServer({ noServer: true, maxPayload });
  const clients = new Map();
  let nextClientId = 1;
  let heartbeatTimer = null;

  function handleUpgrade(req, socket, head) {
    const pathname = getPathname(req.url);
    if (pathname !== STREAM_PATH) return false;
    if (!isAuthenticated(req, config, sessionStore)) {
      recordWsEvent('ws.events.auth_failed', 'warn', 'events websocket authentication failed', { remoteAddress: socket.remoteAddress || '' });
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return true;
    }
    if (!isAllowedOrigin(req)) {
      recordWsEvent('ws.events.origin_rejected', 'warn', 'events websocket origin rejected', {
        origin: safeOrigin(req.headers && req.headers.origin),
        host: req.headers && req.headers.host || '',
        remoteAddress: socket.remoteAddress || '',
      });
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return true;
    }

    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } catch (err) {
      logger.error('events websocket upgrade failed', { err });
      recordWsEvent('ws.events.error', 'error', 'events websocket upgrade failed', { error: errorMessage(err) });
      try { socket.destroy(); } catch (_) {}
    }
    return true;
  }

  wss.on('connection', (ws, req) => {
    const clientId = 'ws_' + nextClientId;
    nextClientId += 1;
    const client = { id: clientId, ws, filter: {}, alive: true, badMessages: 0, unsubscribe: null };
    clients.set(clientId, client);
    client.unsubscribe = eventBus && typeof eventBus.subscribe === 'function'
      ? eventBus.subscribe((event) => sendEvent(client, event)) : null;

    ws.on('pong', () => { client.alive = true; });
    ws.on('message', (data) => handleMessage(client, data));
    ws.on('close', () => cleanupClient(client, 'close'));
    ws.on('error', (err) => {
      recordWsEvent('ws.events.error', 'error', 'events websocket error', { clientId, error: errorMessage(err) });
      cleanupClient(client, 'error');
    });

    recordWsEvent('ws.events.connected', 'info', 'events websocket connected', { clientId, remoteAddress: req.socket && req.socket.remoteAddress || '' });
  });

  function handleMessage(client, data) {
    const payloadSize = Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data), 'utf8');
    if (payloadSize > maxPayload) {
      recordWsEvent('ws.events.invalid_message', 'warn', 'events websocket payload too large', { clientId: client.id, size: payloadSize, limit: maxPayload });
      closeBadClient(client, 'payload_too_large', 'payload too large');
      return;
    }

    let message;
    try {
      message = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data));
    } catch (err) {
      registerBadMessage(client, 'invalid_json', 'message must be JSON', err);
      return;
    }

    if (!message || message.type !== 'subscribe') {
      registerBadMessage(client, 'unsupported_type', 'unsupported message type');
      return;
    }

    let filter;
    try {
      filter = normalizeFilter(message.filter || message);
    } catch (err) {
      registerBadMessage(client, 'invalid_filter', err.message || 'invalid filter', err);
      return;
    }

    client.badMessages = 0;
    client.filter = filter;
    recordWsEvent('ws.events.subscribed', 'info', 'events websocket subscribed', { clientId: client.id, filter: client.filter });
    safeSend(client, { type: 'subscribed', filter: client.filter });
  }

  function registerBadMessage(client, reason, message, err) {
    client.badMessages += 1;
    recordWsEvent('ws.events.invalid_message', 'warn', 'events websocket invalid message', {
      clientId: client.id,
      reason,
      error: err ? errorMessage(err) : '',
      badMessages: client.badMessages,
    });
    safeSend(client, { type: 'error', error: { code: 'BAD_REQUEST', message } });
    if (client.badMessages >= MAX_BAD_MESSAGES) closeBadClient(client, 'too_many_bad_messages', 'too many invalid messages');
  }

  function closeBadClient(client, reason, message) {
    recordWsEvent('ws.events.closed', 'warn', 'events websocket closed', { clientId: client.id, reason });
    safeSend(client, { type: 'error', error: { code: 'BAD_REQUEST', message } });
    try { client.ws.close(1008, reason); } catch (_) { try { client.ws.terminate(); } catch (_err) {} }
    cleanupClient(client, reason);
  }

  function sendEvent(client, event) {
    if (!matchesFilter(event, client.filter)) return;
    safeSend(client, { type: 'event', event: sanitize(event) });
  }

  function safeSend(client, payload) {
    if (!client || !client.ws || client.ws.readyState !== WebSocket.OPEN) return false;
    try {
      client.ws.send(JSON.stringify(payload), (err) => {
        if (!err) return;
        recordWsEvent('ws.events.send_failed', 'error', 'events websocket send failed', { clientId: client.id, error: errorMessage(err) });
        cleanupClient(client, 'send_failed');
      });
      return true;
    } catch (err) {
      recordWsEvent('ws.events.send_failed', 'error', 'events websocket send failed', { clientId: client.id, error: errorMessage(err) });
      cleanupClient(client, 'send_failed');
      return false;
    }
  }

  function cleanupClient(client, reason) {
    if (!clients.has(client.id)) return;
    clients.delete(client.id);
    if (client.unsubscribe) {
      try { client.unsubscribe(); } catch (_) {}
      client.unsubscribe = null;
    }
    recordWsEvent('ws.events.disconnected', 'info', 'events websocket disconnected', { clientId: client.id, reason });
  }

  function startHeartbeat() {
    if (heartbeatTimer || heartbeatIntervalMs <= 0) return;
    heartbeatTimer = setInterval(() => {
      for (const client of clients.values()) {
        if (!client.alive) {
          try { client.ws.terminate(); } catch (_) {}
          cleanupClient(client, 'heartbeat_timeout');
          continue;
        }
        client.alive = false;
        try { client.ws.ping(); } catch (err) {
          recordWsEvent('ws.events.error', 'error', 'events websocket ping failed', { clientId: client.id, error: errorMessage(err) });
          cleanupClient(client, 'ping_failed');
        }
      }
    }, heartbeatIntervalMs);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
  }

  function close() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    for (const client of Array.from(clients.values())) {
      try { client.ws.close(1001, 'server_close'); } catch (_) { try { client.ws.terminate(); } catch (_err) {} }
      cleanupClient(client, 'server_close');
    }
    wss.close();
  }

  function recordWsEvent(type, level, message, data) {
    logger[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'info'](message, data || {});
    if (!eventStore) return;
    try {
      recordEvent(eventStore, { type, level, message, data: data || {} });
    } catch (_) {}
  }

  startHeartbeat();

  return {
    handleUpgrade,
    close,
    getClientCount: () => clients.size,
    getServer: () => wss,
  };
}

function getPathname(rawUrl) {
  try { return new URL(rawUrl || '/', 'http://127.0.0.1').pathname; } catch (_) { return ''; }
}

function normalizeFilter(input) {
  const out = {};
  for (const key of ['sessionId', 'routeKey', 'level', 'type']) {
    if (typeof input[key] === 'string' && input[key]) {
      if (input[key].length > MAX_FILTER_VALUE_LENGTH) throw new Error('filter value too long');
      out[key] = input[key];
    }
  }
  return out;
}

function isAllowedOrigin(req) {
  const headers = req.headers || {};
  const origin = headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.host === headers.host;
  } catch (_) {
    return false;
  }
}

function safeOrigin(origin) {
  if (!origin) return '';
  try {
    const parsed = new URL(origin);
    return parsed.protocol + '//' + parsed.host;
  } catch (_) {
    return '[invalid-origin]';
  }
}

function matchesFilter(event, filter) {
  for (const [key, value] of Object.entries(filter || {})) {
    if (event && event[key] !== value) return false;
  }
  return true;
}

function sanitize(value, key) {
  if (value == null) return value;
  if (key && SENSITIVE_KEY.test(String(key))) return value ? '[redacted]' : '';
  if (Array.isArray(value)) return value.map((item) => sanitize(item));
  if (typeof value === 'object') {
    const result = {};
    for (const [itemKey, item] of Object.entries(value)) result[itemKey] = sanitize(item, itemKey);
    return result;
  }
  if (typeof value !== 'string') return value;
  return value
    .replace(/(WALKER_ADMIN_TOKEN|FEISHU_APP_SECRET|TOKEN|SECRET|PASSWORD|API_KEY)=([^\s]+)/gi, '$1=[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\-/]+=*/gi, '$1[redacted]');
}

function errorMessage(err) {
  return err && err.message ? err.message : String(err);
}

module.exports = { createEventsWebSocketHandler, sanitizeEventForWebSocket: sanitize, matchesFilter, STREAM_PATH };
