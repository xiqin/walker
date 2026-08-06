'use strict';

const WebSocket = require('ws');

function write(stream, chunk) {
  if (stream && typeof stream.write === 'function') stream.write(chunk);
}

function resolveFromEnv(runtimeId, env) {
  if (!env || !env.WALKER_CLAUDE_ATTACH_URL) return null;
  let url = env.WALKER_CLAUDE_ATTACH_URL;
  if (env.WALKER_CLAUDE_ATTACH_TOKEN && !/[?&]token=/.test(url)) {
    url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(env.WALKER_CLAUDE_ATTACH_TOKEN);
  }
  if (!/[?&]token=/.test(url)) return null;
  return { runtimeId, url };
}

function sanitizeMessage(value, secrets) {
  let text = String(value == null ? '' : value);
  for (const secret of secrets || []) {
    if (!secret) continue;
    text = text.split(String(secret)).join('[redacted]');
  }
  return text
    .replace(/([?&]token=)[^&\s)]+/gi, '$1[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\-/]+=*/gi, '$1[redacted]')
    .replace(/(TOKEN|SECRET|PASSWORD|API_KEY)=([^\s]+)/gi, '$1=[redacted]');
}

function rememberSecretsFromUrl(url, secrets) {
  try {
    const parsed = new URL(url);
    const token = parsed.searchParams.get('token');
    if (token) secrets.add(token);
  } catch (_) {}
}

function validSize(value) {
  return Number.isInteger(value) && value > 0 && value <= 1000;
}

function sendResize(ws, cols, rows) {
  if (!validSize(cols) || !validSize(rows)) return false;
  ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  return true;
}

function isSocketOpen(ws, WS) {
  if (!ws) return false;
  const openState = WS && WS.OPEN != null ? WS.OPEN : WebSocket.OPEN;
  return ws.readyState === openState || ws.readyState == null;
}

async function runClaudeAttachCommand(argv, deps) {
  const args = argv || [];
  const opts = deps || {};
  const stdin = opts.stdin || process.stdin;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  const WS = opts.WebSocket || WebSocket;
  const env = opts.env || process.env;
  const setTimer = opts.setTimeout || setTimeout;
  const clearTimer = opts.clearTimeout || clearTimeout;
  const reconnectWindowMs = opts.reconnectWindowMs == null ? 30000 : opts.reconnectWindowMs;
  const retryDelayMs = opts.retryDelayMs == null ? 500 : opts.retryDelayMs;
  const runtimeId = args[0];

  if (!runtimeId) {
    write(stderr, 'missing runtimeId for walker claude attach <runtime-id>\n');
    return 1;
  }

  return new Promise((resolve) => {
    let settled = false;
    let rawMode = false;
    let opened = false;
    let reconnectDeadline = 0;
    let retryTimer = null;
    let ws = null;
    const secrets = new Set();
    const finish = (code, message) => {
      if (settled) return;
      settled = true;
      if (retryTimer) clearTimer(retryTimer);
      if (rawMode && stdin && typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
      if (stdin && typeof stdin.pause === 'function') stdin.pause();
      if (message) write(stderr, sanitizeMessage(message, secrets) + '\n');
      resolve(code);
    };

    const scheduleReconnect = (reason) => {
      if (settled) return;
      if (retryTimer) return;
      const now = Date.now();
      if (!reconnectDeadline) reconnectDeadline = now + Math.max(0, reconnectWindowMs);
      if (now >= reconnectDeadline) {
        finish(1, 'Claude attach reconnect window exceeded' + (reason ? ': ' + reason : ''));
        return;
      }
      const delay = Math.min(Math.max(0, retryDelayMs), reconnectDeadline - now);
      retryTimer = setTimer(() => {
        retryTimer = null;
        connect();
      }, delay);
    };

    const connect = () => {
      Promise.resolve()
        .then(() => (opts.resolveAttachment ? opts.resolveAttachment(runtimeId) : resolveFromEnv(runtimeId, env)))
        .then((attachment) => {
          if (settled) return;
          if (!attachment || !attachment.url) {
            const message = 'failed to resolve Claude attach endpoint for runtime ' + runtimeId;
            if (opened) scheduleReconnect(message);
            else finish(1, message);
            return;
          }
          if (attachment.token) secrets.add(attachment.token);
          rememberSecretsFromUrl(attachment.url, secrets);
          const socket = new WS(attachment.url);
          ws = socket;
          socket.on('open', () => {
            opened = true;
            reconnectDeadline = 0;
            if (stdin && stdin.isTTY && typeof stdin.setRawMode === 'function' && !rawMode) {
              stdin.setRawMode(true);
              rawMode = true;
            }
            if (stdin && typeof stdin.resume === 'function') stdin.resume();
            if (stdout && stdout.columns && stdout.rows && isSocketOpen(socket, WS)) sendResize(socket, stdout.columns, stdout.rows);
          });
          socket.on('message', (data) => write(stdout, Buffer.from(data)));
          socket.on('error', (err) => {
            const message = err && err.message ? err.message : 'connection failed';
            if (opened) scheduleReconnect(message);
            else finish(1, 'Claude attach connection failed: ' + message);
          });
          socket.on('close', (code, reason) => {
            if (ws === socket) ws = null;
            const reasonText = Buffer.isBuffer(reason) ? reason.toString() : String(reason || '');
            if (code === 1000) finish(0);
            else if (code === 1008) finish(1, reasonText || 'unauthorized: invalid token');
            else scheduleReconnect(reasonText || 'connection closed');
          });
        })
        .catch((err) => {
          const message = err && err.message ? err.message : 'failed to resolve Claude attach endpoint';
          if (opened) scheduleReconnect(message);
          else finish(1, 'failed to resolve Claude attach endpoint: ' + message);
        });
    };

    if (stdout && typeof stdout.on === 'function') stdout.on('resize', () => {
      if (!settled && isSocketOpen(ws, WS)) sendResize(ws, stdout.columns, stdout.rows);
    });
    if (stdin && typeof stdin.on === 'function') {
      stdin.on('data', (chunk) => {
        if (!settled && isSocketOpen(ws, WS)) ws.send(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      });
      stdin.on('end', () => {
        if (!settled && ws && typeof ws.close === 'function') ws.close();
      });
    }
    connect();
  });
}

module.exports = { runClaudeAttachCommand, sendResize };
