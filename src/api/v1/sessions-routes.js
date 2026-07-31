'use strict';

const sessionAdmin = require('../../admin/session-admin');
const { route, readObjectBody, sendOk, sendError, sendResult } = require('./common');

function createSessionRoutes(ctx) {
  return [
    route('GET', '/api/v1/sessions', function listSessionsHandler(_req, res) {
      const sessions = sessionAdmin.listSessions(ctx).map(sanitizeSession);
      sendOk(res, { sessions, total: sessions.length });
    }),
    route('POST', '/api/v1/sessions', async function createSessionHandler(req, res) {
      const body = await readObjectBody(req, res);
      if (!body) return;
      const session = await sessionAdmin.createSession(ctx, body);
      sendOk(res, sanitizeSession(session));
    }),
    route('GET', '/api/v1/sessions/:id', function getSessionHandler(_req, res, params) {
      const session = sessionAdmin.getSession(ctx, params.id);
      if (!session) {
        sendError(res, 'NOT_FOUND', 'session not found', 404);
        return;
      }
      sendOk(res, sanitizeSession(session));
    }),
    route('POST', '/api/v1/sessions/:id/stop', async function stopSessionHandler(_req, res, params) {
      sendResult(res, await sessionAdmin.stopSession(ctx, params.id));
    }),
    route('DELETE', '/api/v1/sessions/:id', async function deleteSessionHandler(_req, res, params) {
      sendResult(res, await sessionAdmin.deleteSession(ctx, params.id));
    }),
    route('POST', '/api/v1/sessions/:id/cancel', async function cancelSessionHandler(_req, res, params) {
      sendResult(res, await sessionAdmin.stopSession(ctx, params.id));
    }),
  ];
}

function sanitizeSession(session) {
  if (!session || typeof session !== 'object') return session;
  const agentRef = session.agentRef && typeof session.agentRef === 'object' ? session.agentRef : {};
  return {
    id: session.id,
    agent: session.agent || '',
    title: session.title || '',
    runtime: session.runtime || '',
    cwd: session.cwd || '',
    status: session.status || '',
    errorMessage: session.errorMessage || null,
    routeKeys: Array.isArray(session.routeKeys) ? session.routeKeys.slice() : [],
    focusRouteKeys: Array.isArray(session.focusRouteKeys) ? session.focusRouteKeys.slice() : [],
    isUnbound: !!session.isUnbound,
    opencodeSessionId: agentRef.opencodeSessionId || session.opencodeSessionId || null,
    serverUrl: agentRef.serverUrl || session.serverUrl || '',
    transport: session.transport || null,
    health: session.health || null,
    watch: session.watch || null,
    currentTurn: session.currentTurn || null,
    lastHeartbeatAt: session.lastHeartbeatAt || null,
    lastBusinessEventAt: session.lastBusinessEventAt || null,
    lastActiveAt: session.lastActiveAt || null,
    createdAt: session.createdAt || null,
    updatedAt: session.updatedAt || null,
  };
}

module.exports = { createSessionRoutes, sanitizeSession };
