'use strict';

const { parseBody } = require('../../admin/auth');
const { success, error, send } = require('../../admin/response');
const { recordEvent, recordMetric } = require('../../admin/event-store');

function route(method, pattern, handler) {
  return {
    method,
    pattern,
    handler: async function apiV1Handler(req, res, params) {
      try {
        await handler(req, res, params || {});
      } catch (err) {
        recordApiError(req, err);
        sendError(res, 'INTERNAL_ERROR', 'API 请求处理失败', 500);
      }
    },
  };
}

async function readObjectBody(req, res) {
  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    const status = err.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
    sendError(res, err.code || 'BAD_REQUEST', err.message || '无效请求体', status);
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    sendError(res, 'BAD_REQUEST', '请求体需为 JSON 对象', 400);
    return null;
  }
  return body;
}

function sendOk(res, data) {
  send(res, success(data));
}

function sendError(res, code, message, status, details) {
  const body = error(code, message);
  body.error.details = details || {};
  send(res, body, status);
}

function sendResult(res, result, dataKey) {
  if (!result || result.ok === false) {
    const err = result && result.error ? result.error : { code: 'INTERNAL_ERROR', message: 'operation failed' };
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'INTERNAL_ERROR' ? 500 : 400;
    sendError(res, err.code || 'INTERNAL_ERROR', err.message || 'operation failed', status, err.details);
    return;
  }
  if (dataKey && Object.hasOwn(result, dataKey)) sendOk(res, result[dataKey]);
  else sendOk(res, result);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function parseQuery(req) {
  const query = new URLSearchParams(req.queryString || '');
  const result = {};
  for (const [key, value] of query.entries()) result[key] = value;
  return result;
}

function parseLimit(value, defaultValue, maxValue) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.min(Math.max(Math.trunc(parsed), 1), maxValue);
}

function recordApiEvent(ctx, event) {
  if (!ctx || !ctx.eventStore) return;
  recordEvent(ctx.eventStore, event);
}

function recordApiMetric(ctx, name, value) {
  if (!ctx || !ctx.eventStore) return;
  try { recordMetric(ctx.eventStore, name, value); } catch (_) {}
}

function recordApiError(req, err) {
  const ctx = req && req.appContext;
  if (!ctx || !ctx.eventStore) return;
  recordApiMetric(ctx, 'errors');
  recordApiEvent(ctx, {
    type: 'api.v1.error',
    level: 'error',
    message: err && err.message ? err.message : 'api v1 handler failed',
    data: { path: req.urlPath || '', code: err && err.code || 'INTERNAL_ERROR' },
  });
}

function attachContext(routes, ctx) {
  return routes.map((item) => ({
    ...item,
    handler(req, res, params) {
      req.appContext = ctx;
      return item.handler(req, res, params);
    },
  }));
}

module.exports = {
  route,
  readObjectBody,
  sendOk,
  sendError,
  sendResult,
  isNonEmptyString,
  parseQuery,
  parseLimit,
  recordApiEvent,
  recordApiMetric,
  attachContext,
};
