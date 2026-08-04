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
  return { runtimeId, url };
}

function validSize(value) {
  return Number.isInteger(value) && value > 0 && value <= 1000;
}

function sendResize(ws, cols, rows) {
  if (!validSize(cols) || !validSize(rows)) return false;
  ws.send(JSON.stringify({ type: 'resize', cols, rows }));
  return true;
}

async function runClaudeAttachCommand(argv, deps) {
  const args = argv || [];
  const opts = deps || {};
  const stdin = opts.stdin || process.stdin;
  const stdout = opts.stdout || process.stdout;
  const stderr = opts.stderr || process.stderr;
  const WS = opts.WebSocket || WebSocket;
  const env = opts.env || process.env;
  const runtimeId = args[0];

  if (!runtimeId) {
    write(stderr, 'missing runtimeId for walker claude attach <runtime-id>\n');
    return 1;
  }

  let attachment;
  try {
    attachment = opts.resolveAttachment ? await opts.resolveAttachment(runtimeId) : resolveFromEnv(runtimeId, env);
  } catch (err) {
    write(stderr, 'failed to resolve Claude attach endpoint: ' + err.message + '\n');
    return 1;
  }
  if (!attachment || !attachment.url) {
    write(stderr, 'failed to resolve Claude attach endpoint for runtime ' + runtimeId + '\n');
    return 1;
  }

  return new Promise((resolve) => {
    let settled = false;
    let rawMode = false;
    const finish = (code, message) => {
      if (settled) return;
      settled = true;
      if (rawMode && stdin && typeof stdin.setRawMode === 'function') stdin.setRawMode(false);
      if (stdin && typeof stdin.pause === 'function') stdin.pause();
      if (message) write(stderr, message + '\n');
      resolve(code);
    };

    const ws = new WS(attachment.url);
    ws.on('open', () => {
      if (stdin && stdin.isTTY && typeof stdin.setRawMode === 'function') {
        stdin.setRawMode(true);
        rawMode = true;
      }
      if (stdin && typeof stdin.resume === 'function') stdin.resume();
      if (stdout && stdout.columns && stdout.rows) sendResize(ws, stdout.columns, stdout.rows);
      if (stdout && typeof stdout.on === 'function') stdout.on('resize', () => sendResize(ws, stdout.columns, stdout.rows));
    });
    ws.on('message', (data) => write(stdout, Buffer.from(data)));
    ws.on('error', (err) => finish(1, 'Claude attach connection failed: ' + err.message));
    ws.on('close', (code) => finish(code === 1000 ? 0 : 1));
    if (stdin && typeof stdin.on === 'function') {
      stdin.on('data', (chunk) => {
        if (!settled) ws.send(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      });
      stdin.on('end', () => {
        if (!settled && typeof ws.close === 'function') ws.close();
      });
    }
  });
}

module.exports = { runClaudeAttachCommand, sendResize };
