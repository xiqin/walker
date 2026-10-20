'use strict';

const { httpRequest, sseConnect } = require('../core/http-helper');

const DEFAULT_REQUEST_TIMEOUT_MS = 0;

class DefaultHttpClient {
  constructor(options) {
    this.headers = Object.assign({}, (options && options.headers) || {});
  }

  setHeader(name, value) {
    if (!value) delete this.headers[name];
    else this.headers[name] = value;
  }

  async request(method, url, body, options) {
    const requestOptions = Object.assign({}, options || {});
    if (requestOptions.timeoutMs === undefined) {
      requestOptions.timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
    }
    const headers = Object.assign({}, this.headers, requestOptions.headers || {});
    delete requestOptions.headers;
    return httpRequest(method, url, body, headers, requestOptions);
  }
}

class DefaultSSEClient {
  constructor(options) {
    this.headers = Object.assign({}, (options && options.headers) || {});
  }

  setHeader(name, value) {
    if (!value) delete this.headers[name];
    else this.headers[name] = value;
  }

  async connect(url, options) {
    const sseOptions = Object.assign({}, options || {});
    if (sseOptions.idleTimeoutMs === undefined && sseOptions.timeoutMs !== undefined) {
      sseOptions.idleTimeoutMs = sseOptions.timeoutMs;
      delete sseOptions.timeoutMs;
    }
    const headers = Object.assign({}, this.headers, sseOptions.headers || {});
    delete sseOptions.headers;
    return sseConnect(url, headers, sseOptions);
  }
}

function buildUrl(serverUrl, pathname, query) {
  const url = new URL(pathname, serverUrl);
  for (const [key, value] of Object.entries(query || {})) {
    if (value) url.searchParams.set(key, value);
  }
  return url.toString();
}

function summarizeResponse(resp) {
  if (resp === undefined) return 'undefined response';
  try {
    const text = JSON.stringify(resp);
    return text && text.length > 500 ? text.slice(0, 500) + '...' : text;
  } catch (_) {
    return String(resp);
  }
}

function extractModelList(resp) {
  if (Array.isArray(resp)) return resp;
  if (!resp) return [];
  if (Array.isArray(resp.data)) return resp.data;
  if (resp.data && Array.isArray(resp.data.data)) return resp.data.data;
  if (resp.data && Array.isArray(resp.data.models)) return resp.data.models;
  return [];
}

function extractSessionList(resp) {
  if (Array.isArray(resp)) return resp;
  if (!resp) return [];
  if (Array.isArray(resp.data)) return resp.data;
  if (resp.data && Array.isArray(resp.data.data)) return resp.data.data;
  if (resp.data && Array.isArray(resp.data.sessions)) return resp.data.sessions;
  if (resp.data && Array.isArray(resp.data.items)) return resp.data.items;
  if (Array.isArray(resp.sessions)) return resp.sessions;
  if (Array.isArray(resp.items)) return resp.items;
  return [];
}

function extractMessageList(resp) {
  if (Array.isArray(resp)) return resp;
  if (!resp) return [];
  if (Array.isArray(resp.data)) return resp.data;
  if (resp.data && Array.isArray(resp.data.data)) return resp.data.data;
  if (resp.data && Array.isArray(resp.data.messages)) return resp.data.messages;
  if (Array.isArray(resp.messages)) return resp.messages;
  return [];
}

function extractProjectList(resp) {
  if (Array.isArray(resp)) return resp;
  const body = resp && resp.data !== undefined ? resp.data : resp;
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body.data)) return body.data;
  if (body && Array.isArray(body.projects)) return body.projects;
  return [];
}

const MESSAGE_ROLES = new Set(['user', 'assistant', 'system']);

function roleFromType(value) {
  return typeof value === 'string' && MESSAGE_ROLES.has(value) ? value : '';
}

function modelFields(message) {
  const source = message || {};
  const model = source.model;
  if (model && typeof model === 'object') {
    return {
      providerID: model.providerID || model.provider || source.providerID || source.provider || '',
      modelID: model.modelID || model.id || '',
    };
  }
  return {
    providerID: source.providerID || source.provider || '',
    modelID: source.modelID || source.modelId || (typeof model === 'string' ? model : ''),
  };
}

function normalizePart(part) {
  if (!part || typeof part !== 'object') return part;
  if (part.type === 'text' && !part.text && typeof part.content === 'string') {
    return Object.assign({}, part, { text: part.content });
  }
  return part;
}

function partsFromMessage(message) {
  if (Array.isArray(message.parts)) return message.parts.map(normalizePart);
  const content = message.content;
  if (Array.isArray(content)) return content.map(normalizePart);
  if (typeof content === 'string' && content) return [{ type: 'text', text: content }];
  if (content && typeof content === 'object' && typeof content.text === 'string') {
    return [{ type: 'text', text: content.text }];
  }
  return [];
}

/**
 * 把 V2 的 type/content/model 收成 watcher 仍读取的 info.role/parts。
 * 已是旧形状的消息原样返回。
 */
function normalizeOpencodeMessage(raw, fallback) {
  const message = raw && typeof raw === 'object' ? raw : {};
  const extra = fallback && typeof fallback === 'object' ? fallback : {};
  if (message.info && Array.isArray(message.parts)) {
    if (!message.id && message.info.id) message.id = message.info.id;
    if (!message.role && message.info.role) message.role = message.info.role;
    if (!message.time && message.info.time) message.time = message.info.time;
    return message;
  }
  const id = message.id || (message.info && message.info.id) || extra.id || '';
  const role = message.role
    || (message.info && message.info.role)
    || roleFromType(message.type)
    || roleFromType(extra.type)
    || '';
  const time = (message.info && message.info.time) || message.time || extra.time || null;
  const models = modelFields(message.info && message.info.model ? message.info : message);
  const tokens = message.tokens || (message.info && message.info.tokens) || null;
  const parts = partsFromMessage(message);
  return {
    id,
    role,
    time,
    tokens,
    providerID: models.providerID,
    modelID: models.modelID,
    model: message.model,
    info: {
      id,
      role,
      time,
      tokens,
      providerID: models.providerID,
      modelID: models.modelID,
      model: models.modelID,
    },
    parts,
  };
}

function normalizeSessionSummary(raw, fallbackCwd) {
  raw = raw || {};
  const id = raw.id || raw.sessionID || raw.sessionId || '';
  const status = raw.status && typeof raw.status === 'object' ? raw.status.type : raw.status;
  const time = raw.time && typeof raw.time === 'object' ? raw.time : {};
  const updatedAt = raw.updatedAt || raw.updated || raw.timeUpdated || time.updated || time.updatedAt || null;
  return {
    id,
    title: raw.title || raw.name || (id ? 'opencode ' + id.slice(0, 12) : 'opencode session'),
    status: status || 'unknown',
    cwd: raw.cwd || raw.directory || raw.canonical
      || (raw.location && (raw.location.directory || raw.location.path))
      || raw.path || (raw.workspace && raw.workspace.path) || fallbackCwd || '',
    updatedAt: updatedAt || null,
  };
}

module.exports = {
  DefaultHttpClient,
  DefaultSSEClient,
  buildUrl,
  summarizeResponse,
  extractModelList,
  extractSessionList,
  extractMessageList,
  extractProjectList,
  normalizeSessionSummary,
  normalizeOpencodeMessage,
};
