'use strict';

const { listEvents, getMetrics } = require('../../admin/event-store');
const { sanitizeEventForWebSocket } = require('../../admin/ws-events');
const { route, sendOk, parseQuery, parseLimit } = require('./common');

function createEventsRoutes(ctx) {
  return [
    route('GET', '/api/v1/events', function listEventsHandler(req, res) {
      const query = parseQuery(req);
      const events = listEvents(ctx.eventStore, {
        limit: parseLimit(query.limit, 100, 1000),
        level: query.level,
        type: query.type,
        sessionId: query.sessionId,
        routeKey: query.routeKey,
        after: query.after,
      }).map(sanitizeEventForWebSocket);
      sendOk(res, { events, total: events.length });
    }),
    route('GET', '/api/v1/metrics', function metricsHandler(_req, res) {
      sendOk(res, getMetrics(ctx.eventStore));
    }),
  ];
}

module.exports = { createEventsRoutes };
