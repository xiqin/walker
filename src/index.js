const fs = require('fs');
const path = require('path');
const process = require('process');
const { execFileSync } = require('child_process');
const WebSocket = require('ws');
const lark = require('@larksuiteoapi/node-sdk');

const DEFAULT_CC_CONNECT_CONFIG = path.join(process.env.USERPROFILE || process.env.HOME || '.', '.cc-connect', 'config.toml');
const DEFAULT_BRIDGE_URL = 'ws://localhost:8770/api/v1/channels/bridge/ws';
const DEFAULT_WSL_DISTRO = 'Ubuntu-24.04';
const WSL_IP_TTL_MS = 300000;

loadDotEnv(path.join(__dirname, '..', '.env'));

const state = {
  bridge: null,
  bridgeReady: false,
  bridgeBackoffMs: 1000,
  stopping: false,
  pending: [],
  routeSessions: new Map(),
  cachedWslIp: '',
  cachedWslIpAt: 0,
};

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }
    const idx = trimmed.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

function log(level, message, extra) {
  const row = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(extra || {}),
  };
  console.log(JSON.stringify(row));
}

function readFeishuConfig() {
  const configPath = process.env.CC_CONNECT_CONFIG || DEFAULT_CC_CONNECT_CONFIG;
  const raw = fs.readFileSync(configPath, 'utf8');
  const appId = matchTomlString(raw, 'app_id');
  const appSecret = matchTomlString(raw, 'app_secret');

  if (!appId || !appSecret) {
    throw new Error(`missing app_id/app_secret in ${configPath}`);
  }

  return { appId, appSecret, configPath };
}

function matchTomlString(raw, key) {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, 'm');
  const m = raw.match(re);
  return m ? m[1] : '';
}

function bridgeUrl() {
  const base = process.env.OPENDRAY_BRIDGE_URL || defaultBridgeUrl();
  const token = process.env.OPENDRAY_BRIDGE_TOKEN;
  if (!token) {
    throw new Error('OPENDRAY_BRIDGE_TOKEN is required');
  }
  const url = new URL(base);
  url.searchParams.set('token', token);
  return { url: url.toString(), token };
}

function defaultBridgeUrl() {
  const distro = process.env.OPENDRAY_WSL_DISTRO || DEFAULT_WSL_DISTRO;
  const now = Date.now();
  if (state.cachedWslIp && now - state.cachedWslIpAt < WSL_IP_TTL_MS) {
    return `ws://${state.cachedWslIp}:8770/api/v1/channels/bridge/ws`;
  }
  try {
    const raw = execFileSync('wsl.exe', ['-d', distro, '-u', 'root', '--', 'hostname', '-I'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
    });
    const ip = raw.trim().split(/\s+/).find(Boolean);
    if (ip) {
      state.cachedWslIp = ip;
      state.cachedWslIpAt = now;
      return `ws://${ip}:8770/api/v1/channels/bridge/ws`;
    }
  } catch (err) {
    log('warn', 'failed resolving WSL IP for opendray; falling back to cached or localhost', {
      distro,
      err: err.message,
    });
  }
  if (state.cachedWslIp) {
    return `ws://${state.cachedWslIp}:8770/api/v1/channels/bridge/ws`;
  }
  return DEFAULT_BRIDGE_URL;
}

function opendrayBaseUrl() {
  if (process.env.OPENDRAY_API_BASE) {
    return process.env.OPENDRAY_API_BASE.replace(/\/$/, '');
  }
  const bridge = new URL(process.env.OPENDRAY_BRIDGE_URL || defaultBridgeUrl());
  const protocol = bridge.protocol === 'wss:' ? 'https:' : 'http:';
  return `${protocol}//${bridge.host}`;
}

function opendrayAdminAuth() {
  const password = process.env.OPENDRAY_ADMIN_PASSWORD;
  if (!password) {
    throw new Error('OPENDRAY_ADMIN_PASSWORD is required for session routing');
  }
  return {
    username: process.env.OPENDRAY_ADMIN_USER || 'admin',
    password,
  };
}

async function opendrayLogin() {
  const { username, password } = opendrayAdminAuth();
  const resp = await fetch(`${opendrayBaseUrl()}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || !body.token) {
    throw new Error(`opendray login failed: HTTP ${resp.status}`);
  }
  return body.token;
}

async function listOpendraySessions() {
  const token = await opendrayLogin();
  const resp = await fetch(`${opendrayBaseUrl()}/api/v1/sessions`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok || !Array.isArray(body.sessions)) {
    throw new Error(`list opendray sessions failed: HTTP ${resp.status}`);
  }
  return body.sessions;
}

async function resolveSessionForRoute(routeKey, chatId) {
  const chatKey = `chat:${chatId}`;
  const exactPinned = state.routeSessions.get(routeKey);
  if (exactPinned) {
    return exactPinned;
  }
  const chatPinned = state.routeSessions.get(chatKey);
  if (chatPinned) {
    return chatPinned;
  }
  const sessions = await listOpendraySessions();
  const active = sessions.filter((s) => !['ended', 'stopped'].includes(String(s.state || '')));
  if (active.length === 1) {
    state.routeSessions.set(chatKey, active[0].id);
    log('info', 'auto-bound chat to sole opendray session', { chat_id: chatId, session_id: active[0].id });
    return active[0].id;
  }
  return '';
}

function connectBridge() {
  const { url, token } = bridgeUrl();
  const ws = new WebSocket(url, {
    headers: {
      'X-Bridge-Token': token,
    },
  });

  state.bridge = ws;
  state.bridgeReady = false;

  ws.on('open', () => {
    log('info', 'opendray bridge websocket connected');
    ws.send(JSON.stringify({
      type: 'register',
      token,
      platform: 'feishu',
      capabilities: ['text', 'reply_to_message'],
      metadata: {
        adapter: 'feishu-opendray-bridge',
        version: '0.1.0',
      },
    }));
  });

  ws.on('message', async (raw) => {
    let frame;
    try {
      frame = JSON.parse(raw.toString('utf8'));
    } catch (err) {
      log('warn', 'invalid frame from opendray bridge', { err: err.message });
      return;
    }

    if (frame.type === 'register_ack') {
      if (!frame.ok) {
        log('error', 'opendray bridge register rejected', { error: frame.error || '' });
        ws.close();
        return;
      }
      state.bridgeReady = true;
      state.bridgeBackoffMs = 1000;
      log('info', 'opendray bridge registered');
      flushPending();
      return;
    }

    try {
      await handleBridgeFrame(frame);
    } catch (err) {
      log('error', 'failed handling opendray frame', { type: frame.type, err: err.message });
    }
  });

  ws.on('close', (code, reason) => {
    state.bridgeReady = false;
    if (state.bridge === ws) {
      state.bridge = null;
    }
    log('warn', 'opendray bridge websocket closed', { code, reason: reason.toString() });
    scheduleBridgeReconnect();
  });

  ws.on('error', (err) => {
    log('warn', 'opendray bridge websocket error', { err: err.message });
  });
}

function scheduleBridgeReconnect() {
  if (state.stopping) {
    return;
  }
  const delay = state.bridgeBackoffMs;
  state.bridgeBackoffMs = Math.min(state.bridgeBackoffMs * 2, 30000);
  setTimeout(() => {
    if (!state.stopping) {
      connectBridge();
    }
  }, delay);
}

function sendToBridge(frame) {
  const raw = JSON.stringify(frame);
  if (!state.bridge || state.bridge.readyState !== WebSocket.OPEN || !state.bridgeReady) {
    state.pending.push(raw);
    if (state.pending.length > 100) {
      state.pending.shift();
    }
    log('warn', 'opendray bridge not ready; queued message', { queued: state.pending.length });
    return;
  }
  state.bridge.send(raw);
}

async function sendBridgeText(route, text) {
  sendToBridge({
    type: 'message',
    session_key: `feishu:${route.routeKey}:${route.routeKey}`,
    conversation_id: route.routeKey,
    user_id: route.routeKey,
    user_name: route.openId,
    text,
    reply_ctx: route.replyCtx,
  });
}

function flushPending() {
  if (!state.bridge || state.bridge.readyState !== WebSocket.OPEN || !state.bridgeReady) {
    return;
  }
  const queued = state.pending.splice(0, state.pending.length);
  for (const raw of queued) {
    state.bridge.send(raw);
  }
  if (queued.length) {
    log('info', 'flushed queued bridge messages', { count: queued.length });
  }
}

let feishuApi;

async function handleBridgeFrame(frame) {
  switch (frame.type) {
    case 'send':
      await sendFeishuText(frame);
      break;
    case 'send_card':
      await sendFeishuText({ ...frame, text: renderCardText(frame.card) });
      break;
    case 'send_buttons':
      await sendFeishuText({ ...frame, text: renderButtonsText(frame.text, frame.buttons) });
      break;
    case 'start_typing':
    case 'stop_typing':
      break;
    case 'pong':
      break;
    default:
      log('debug', 'ignored opendray bridge frame', { type: frame.type });
  }
}

async function sendFeishuText(frame) {
  const replyCtx = normalizeReplyCtx(frame.reply_ctx);
  const text = String(frame.text || '').trimEnd();
  if (!replyCtx.chat_id) {
    log('warn', 'cannot send feishu message without chat_id', { conversation_id: frame.conversation_id || '' });
    return;
  }
  if (!text) {
    return;
  }
  await feishuApi.sendText({ chatId: replyCtx.chat_id, replyToMessageId: replyCtx.message_id, text });
}

function normalizeReplyCtx(replyCtx) {
  if (!replyCtx) {
    return {};
  }
  if (typeof replyCtx === 'object') {
    return replyCtx;
  }
  if (typeof replyCtx === 'string') {
    try {
      const parsed = JSON.parse(replyCtx);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_err) {
      return { chat_id: replyCtx };
    }
  }
  return {};
}

function renderCardText(card) {
  if (!card || typeof card !== 'object') {
    return '';
  }
  const lines = [];
  if (card.header && card.header.title) {
    lines.push(String(card.header.title));
  }
  for (const el of card.elements || []) {
    if (el.content) {
      lines.push(String(el.content));
    } else if (el.text) {
      lines.push(String(el.text));
    }
  }
  return lines.join('\n\n');
}

function renderButtonsText(text, buttons) {
  const lines = [String(text || '')];
  for (const row of buttons || []) {
    const labels = (row || []).map((btn) => btn.text || btn.label || btn.value || btn.data).filter(Boolean);
    if (labels.length) {
      lines.push(labels.map((label) => `[${label}]`).join(' '));
    }
  }
  return lines.filter(Boolean).join('\n');
}

class FeishuApi {
  constructor(appId, appSecret) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.token = '';
    this.tokenExpiresAt = 0;
  }

  async tenantToken() {
    const now = Date.now();
    if (this.token && now < this.tokenExpiresAt - 60000) {
      return this.token;
    }

    const resp = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
    });
    const body = await resp.json();
    if (!resp.ok || body.code !== 0 || !body.tenant_access_token) {
      throw new Error(`tenant token failed: HTTP ${resp.status} code=${body.code} msg=${body.msg || ''}`);
    }
    this.token = body.tenant_access_token;
    this.tokenExpiresAt = now + Number(body.expire || 7200) * 1000;
    return this.token;
  }

  async sendText({ chatId, replyToMessageId, text }) {
    const token = await this.tenantToken();
    const path = replyToMessageId
      ? `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(replyToMessageId)}/reply`
      : 'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id';
    const data = replyToMessageId
      ? { msg_type: 'text', content: JSON.stringify({ text }) }
      : { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) };

    const resp = await fetch(path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });
    const body = await resp.json();
    if (!resp.ok || body.code !== 0) {
      throw new Error(`send feishu text failed: HTTP ${resp.status} code=${body.code} msg=${body.msg || ''}`);
    }
    log('info', 'sent feishu text', { chat_id: chatId, reply: Boolean(replyToMessageId) });
  }
}

function startFeishuLongConnection(appId, appSecret) {
  const eventDispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      try {
        await handleFeishuMessage(data);
      } catch (err) {
        log('error', 'failed handling feishu event', { err: err.message });
      }
    },
  });

  const wsClient = new lark.WSClient({
    appId,
    appSecret,
    loggerLevel: lark.LoggerLevel.info,
  });

  wsClient.start({ eventDispatcher });
  log('info', 'feishu long connection started');
}

async function handleFeishuMessage(data) {
  const sender = data.sender || {};
  const senderId = sender.sender_id || {};
  const message = data.message || {};
  const chatId = message.chat_id || '';
  const messageId = message.message_id || '';
  const openId = senderId.open_id || senderId.user_id || 'unknown';
  const text = extractFeishuText(message.message_type, message.content);
  const routeKey = buildRouteKey(chatId, message, openId);

  if (!chatId || !messageId || !text) {
    log('debug', 'ignored feishu message', {
      has_chat_id: Boolean(chatId),
      has_message_id: Boolean(messageId),
      message_type: message.message_type || '',
    });
    return;
  }

  const route = {
    routeKey,
    openId,
    replyCtx: {
      chat_id: chatId,
      message_id: messageId,
      root_id: message.root_id || message.parent_id || messageId,
      open_id: openId,
    },
  };

  if (await handleLocalCommand(route, text)) {
    return;
  }

  const sessionId = await resolveSessionForRoute(routeKey, chatId);
  if (!sessionId) {
    await feishuApi.sendText({
      chatId,
      replyToMessageId: messageId,
      text: '没有可用的 opendray 会话。请先在 opendray 页面启动一个 session，或发送 /sessions 查看；如果有多个 session，请发送 /use <session_id> 绑定当前飞书线程。',
    });
    log('warn', 'no opendray session bound for feishu route', { route_key: routeKey, message_id: messageId });
    return;
  }

  await sendBridgeText(route, `/select ${sessionId}`);
  await sleep(150);
  await sendBridgeText(route, text);
  log('info', 'forwarded feishu message to opendray session', { route_key: routeKey, session_id: sessionId, message_id: messageId });
}

async function handleLocalCommand(route, text) {
  const trimmed = text.trim();
  if (trimmed === '/sessions') {
    const sessions = await listOpendraySessions();
    const lines = sessions.map((s) => `${s.id}  ${s.state || ''}  ${s.name || ''}  ${s.cwd || ''}`.trim());
    await feishuApi.sendText({
      chatId: route.replyCtx.chat_id,
      replyToMessageId: route.replyCtx.message_id,
      text: lines.length ? lines.join('\n') : '当前没有 opendray session。',
    });
    return true;
  }

  const chatKey = `chat:${route.replyCtx.chat_id}`;

  if (trimmed === '/use off') {
    state.routeSessions.delete(chatKey);
    state.routeSessions.delete(route.routeKey);
    await feishuApi.sendText({
      chatId: route.replyCtx.chat_id,
      replyToMessageId: route.replyCtx.message_id,
      text: '已清除当前聊天的 session 绑定。',
    });
    return true;
  }

  const useMatch = trimmed.match(/^\/use\s+(\S+)$/);
  if (useMatch) {
    const sessionId = useMatch[1];
    const sessions = await listOpendraySessions();
    const found = sessions.find((s) => s.id === sessionId);
    if (!found) {
      await feishuApi.sendText({
        chatId: route.replyCtx.chat_id,
        replyToMessageId: route.replyCtx.message_id,
        text: `没有找到 session：${sessionId}`,
      });
      return true;
    }
    state.routeSessions.set(chatKey, sessionId);
    await sendBridgeText(route, `/select ${sessionId}`);
    await feishuApi.sendText({
      chatId: route.replyCtx.chat_id,
      replyToMessageId: route.replyCtx.message_id,
      text: `已绑定当前飞书聊天到 ${sessionId}（${found.name || found.cwd || 'unnamed'}）。后续普通消息会发到这个 session。`,
    });
    log('info', 'bound feishu chat to opendray session', { chat_id: route.replyCtx.chat_id, session_id: sessionId });
    return true;
  }

  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractFeishuText(messageType, content) {
  if (!content) {
    return '';
  }
  if (messageType !== 'text') {
    return `[${messageType || 'unknown'}] ${content}`;
  }
  try {
    const parsed = JSON.parse(content);
    return String(parsed.text || '').trim();
  } catch (_err) {
    return String(content).trim();
  }
}

function buildRouteKey(chatId, message, openId) {
  const mode = process.env.FEISHU_ROUTE_MODE || 'thread';
  if (mode === 'user') {
    return `${chatId}:${openId}`;
  }
  const threadId = message.root_id || message.parent_id || message.message_id || openId;
  return `${chatId}:${threadId}`;
}

function shutdown() {
  state.stopping = true;
  if (state.bridge) {
    state.bridge.close();
  }
  setTimeout(() => process.exit(0), 300).unref();
}

async function main() {
  const feishu = readFeishuConfig();
  feishuApi = new FeishuApi(feishu.appId, feishu.appSecret);
  bridgeUrl();

  log('info', 'starting adapter', {
    cc_connect_config: feishu.configPath,
    bridge_url: bridgeUrl().url.replace(/([?&]token=)[^&]+/, '$1***'),
    route_mode: process.env.FEISHU_ROUTE_MODE || 'thread',
  });

  connectBridge();
  startFeishuLongConnection(feishu.appId, feishu.appSecret);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main().catch((err) => {
  log('error', 'adapter failed to start', { err: err.message });
  process.exit(1);
});
