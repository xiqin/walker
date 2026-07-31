'use strict';

const routeAdmin = require('../../admin/route-admin');
const { route, readObjectBody, sendOk, sendError, isNonEmptyString } = require('./common');

function createRoutesRoutes(ctx) {
  return [
    route('GET', '/api/v1/routes', function listRoutesHandler(_req, res) {
      const routes = routeAdmin.listRoutes(ctx).map(toSafeRouteDto);
      sendOk(res, { routes, total: routes.length });
    }),
    route('GET', '/api/v1/routes/:routeKey', function getRouteHandler(_req, res, params) {
      const item = routeAdmin.getRoute(ctx, params.routeKey);
      if (!item) {
        sendError(res, 'NOT_FOUND', 'route not found', 404);
        return;
      }
      sendOk(res, toSafeRouteDto(item));
    }),
    route('POST', '/api/v1/routes/:routeKey/focus', async function focusRouteHandler(req, res, params) {
      const body = await readObjectBody(req, res);
      if (!body) return;
      if (!isNonEmptyString(body.sessionId)) {
        sendError(res, 'BAD_REQUEST', '需要 sessionId', 400);
        return;
      }
      sendRouteResult(res, routeAdmin.setFocus(ctx, params.routeKey, body.sessionId));
    }),
    route('POST', '/api/v1/routes/:routeKey/unfocus', function unfocusRouteHandler(_req, res, params) {
      sendRouteResult(res, routeAdmin.unbindRoute(ctx, params.routeKey));
    }),
  ];
}

function toSafeRouteDto(item) {
  if (!item) return item;
  const activeSessions = Array.isArray(item.activeSessions)
    ? item.activeSessions.map((session) => ({ ...session }))
    : [];
  return {
    routeKey: item.routeKey,
    sessionId: item.sessionId || null,
    focusSessionId: item.focusSessionId || item.sessionId || null,
    sessions: Array.isArray(item.sessions) ? item.sessions.slice() : [],
    sessionIds: Array.isArray(item.sessionIds) ? item.sessionIds.slice() : [],
    sessionCount: item.sessionCount || 0,
    activeSessions,
    missingSessionIds: Array.isArray(item.missingSessionIds) ? item.missingSessionIds.slice() : [],
    deletedSessionIds: Array.isArray(item.deletedSessionIds) ? item.deletedSessionIds.slice() : [],
    cwd: item.cwd || '',
    lastActiveAt: item.lastActiveAt || null,
    updatedAt: item.updatedAt || null,
    health: item.health || 'unknown',
    dangling: !!item.dangling,
  };
}

function sendRouteResult(res, result) {
  if (!result || result.ok === false) {
    const err = result && result.error ? result.error : { code: 'INTERNAL_ERROR', message: 'operation failed' };
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'INTERNAL_ERROR' ? 500 : 400;
    sendError(res, err.code || 'INTERNAL_ERROR', err.message || 'operation failed', status, err.details);
    return;
  }
  sendOk(res, { ...result, route: toSafeRouteDto(result.route) });
}

module.exports = { createRoutesRoutes };
