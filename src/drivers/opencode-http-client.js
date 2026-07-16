'use strict';

const { httpRequest, sseConnect } = require('../core/http-helper');

const DEFAULT_REQUEST_TIMEOUT_MS = 0;

class DefaultHttpClient {
  async request(method, url, body, options) {
    const requestOptions = Object.assign({}, options || {});
    if (requestOptions.timeoutMs === undefined) {
      requestOptions.timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
    }
    return httpRequest(method, url, body, null, requestOptions);
  }
}

class DefaultSSEClient {
  async connect(url, options) {
    const sseOptions = Object.assign({}, options || {});
    if (sseOptions.idleTimeoutMs === undefined && sseOptions.timeoutMs !== undefined) {
      sseOptions.idleTimeoutMs = sseOptions.timeoutMs;
      delete sseOptions.timeoutMs;
    }
    return sseConnect(url, null, sseOptions);
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
  if (Array.isArray(resp.messages)) return resp.messages;
  return [];
}

function extractProjectList(resp) {
  const data = (resp && resp.data) || resp || [];
  return Array.isArray(data) ? data : [];
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
    cwd: raw.cwd || raw.directory || raw.path || (raw.workspace && raw.workspace.path) || fallbackCwd || '',
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
};
