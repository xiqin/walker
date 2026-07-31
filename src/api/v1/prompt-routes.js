'use strict';

const sessionAdmin = require('../../admin/session-admin');
const { route, readObjectBody, sendOk, sendError, isNonEmptyString, recordApiEvent, recordApiMetric } = require('./common');

function createPromptRoutes(ctx) {
  return [
    route('POST', '/api/v1/prompt', async function promptHandler(req, res) {
      const body = await readObjectBody(req, res);
      if (!body) return;
      if (!isNonEmptyString(body.text) || (!isNonEmptyString(body.sessionId) && !isNonEmptyString(body.routeKey))) {
        recordApiMetric(ctx, 'errors');
        recordApiEvent(ctx, {
          type: 'api.v1.error',
          level: 'error',
          routeKey: isNonEmptyString(body.routeKey) ? body.routeKey : '',
          sessionId: isNonEmptyString(body.sessionId) ? body.sessionId : '',
          message: 'invalid prompt request',
          data: { hasText: isNonEmptyString(body.text), hasTarget: isNonEmptyString(body.sessionId) || isNonEmptyString(body.routeKey) },
        });
        sendError(res, 'BAD_REQUEST', '需要非空 text，并且至少提供 routeKey 或 sessionId', 400);
        return;
      }

      const sessionId = isNonEmptyString(body.sessionId) ? body.sessionId : resolveSessionId(ctx, body.routeKey);
      if (!sessionId) {
        recordApiMetric(ctx, 'errors');
        recordApiEvent(ctx, { type: 'api.v1.error', level: 'error', routeKey: body.routeKey, message: 'prompt target route not found' });
        sendError(res, 'NOT_FOUND', 'route not found or has no focused session', 404);
        return;
      }

      recordApiEvent(ctx, {
        type: 'api.v1.prompt',
        sessionId,
        routeKey: body.routeKey || '',
        message: 'api v1 prompt requested',
        data: { textLength: body.text.trim().length },
      });
      const result = await sessionAdmin.sendPrompt(ctx, sessionId, body.text);
      if (!result.ok) {
        const err = result.error || { code: 'INTERNAL_ERROR', message: 'prompt failed' };
        sendError(res, err.code, err.message, err.code === 'NOT_FOUND' ? 404 : err.code === 'BAD_REQUEST' ? 400 : 500);
        return;
      }
      sendOk(res, { sessionId, events: sanitizePromptEvents(result.events || []) });
    }),
  ];
}

function sanitizePromptEvents(value, key) {
  if (value == null) return value;
  if (key && /token|secret|authorization|cookie|password|credential|api[-_]?key|app[-_]?secret/i.test(String(key))) {
    return value ? '[redacted]' : '';
  }
  if (Array.isArray(value)) return value.map((item) => sanitizePromptEvents(item));
  if (typeof value === 'object') {
    const result = {};
    for (const [childKey, child] of Object.entries(value)) {
      result[childKey] = sanitizePromptEvents(child, childKey);
    }
    return result;
  }
  if (typeof value !== 'string') return value;
  return value
    .replace(/(WALKER_ADMIN_TOKEN|FEISHU_APP_SECRET|TOKEN|SECRET|PASSWORD|API_KEY|AUTHORIZATION)=([^\s]+)/gi, '$1=[redacted]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\-/]+=*/gi, '$1[redacted]');
}

function resolveSessionId(ctx, routeKey) {
  if (!isNonEmptyString(routeKey)) return '';
  if (ctx.sessionService && typeof ctx.sessionService.getCurrent === 'function') {
    const session = ctx.sessionService.getCurrent(routeKey);
    return session && session.id || '';
  }
  const state = ctx.sessionService && ctx.sessionService._readNormalized ? ctx.sessionService._readNormalized()
    : ctx.sessionService && ctx.sessionService.stateStore ? ctx.sessionService.stateStore.read() : {};
  const routeInfo = state.routes && state.routes[routeKey];
  return routeInfo && routeInfo.focusSessionId || '';
}

module.exports = { createPromptRoutes, sanitizePromptEvents };
