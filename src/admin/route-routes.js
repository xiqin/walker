'use strict';

const { parseBody } = require('./auth');
const { success, error, send } = require('./response');
const routeAdmin = require('./route-admin');

/**
 * 创建 Route v3 明确写 API 和旧 bind 兼容入口。
 * @param {Object} appContext - Admin 应用上下文
 * @returns {Array<{method: string, pattern: string, handler: Function}>} 路由定义
 */
function createRouteRoutes(appContext) {
  const ctx = appContext || {};
  return [
    {
      method: 'POST',
      pattern: '/api/admin/routes',
      handler: async function legacyBindHandler(req, res) {
        const body = await readObjectBody(req, res);
        if (!body) return;
        if (!isNonEmptyString(body.routeKey) || !isNonEmptyString(body.sessionId)) {
          send(res, error('BAD_REQUEST', '需要 routeKey 和 sessionId'), 400);
          return;
        }
        sendResult(res, routeAdmin.bindRoute(ctx, body.routeKey, body.sessionId));
      },
    },
    {
      method: 'POST',
      pattern: '/api/admin/routes/:encodedRouteKey/sessions',
      handler: async function addSessionHandler(req, res, params) {
        const body = await readObjectBody(req, res);
        if (!body) return;
        if (!isNonEmptyString(body.sessionId)) {
          send(res, error('BAD_REQUEST', '需要 sessionId'), 400);
          return;
        }
        sendResult(res, routeAdmin.addSession(ctx, params.encodedRouteKey, body.sessionId));
      },
    },
    {
      method: 'DELETE',
      pattern: '/api/admin/routes/:encodedRouteKey/sessions/:sessionId',
      handler: function removeSessionHandler(_req, res, params) {
        sendResult(res, routeAdmin.removeSession(ctx, params.encodedRouteKey, params.sessionId));
      },
    },
    {
      method: 'PATCH',
      pattern: '/api/admin/routes/:encodedRouteKey/focus',
      handler: async function setFocusHandler(req, res, params) {
        const body = await readObjectBody(req, res);
        if (!body) return;
        if (!isNonEmptyString(body.sessionId)) {
          send(res, error('BAD_REQUEST', '需要 sessionId'), 400);
          return;
        }
        sendResult(res, routeAdmin.setFocus(ctx, params.encodedRouteKey, body.sessionId));
      },
    },
    {
      method: 'PATCH',
      pattern: '/api/admin/routes/:encodedRouteKey',
      handler: async function updateRouteHandler(req, res, params) {
        const body = await readObjectBody(req, res);
        if (!body) return;
        if (Object.keys(body).length !== 1 || !Object.hasOwn(body, 'cwd') || !isNonEmptyString(body.cwd)) {
          send(res, error('BAD_REQUEST', '本接口仅允许更新非空 cwd'), 400);
          return;
        }
        sendResult(res, routeAdmin.updateRoute(ctx, params.encodedRouteKey, body.cwd));
      },
    },
    {
      method: 'DELETE',
      pattern: '/api/admin/routes/:encodedRouteKey',
      handler: async function deleteRouteHandler(req, res, params) {
        const body = await readObjectBody(req, res);
        if (!body) return;
        if (body.confirm !== true) {
          send(res, error('BAD_REQUEST', '删除整条 Route 需要 confirm=true 确认'), 400);
          return;
        }
        sendResult(res, routeAdmin.deleteRoute(ctx, params.encodedRouteKey));
      },
    },
    {
      method: 'GET',
      pattern: '/api/admin/routes/:encodedRouteKey',
      handler: function getRouteHandler(_req, res, params) {
        const route = routeAdmin.getRoute(ctx, params.encodedRouteKey);
        if (!route) {
          send(res, error('NOT_FOUND', 'route not found'), 404);
          return;
        }
        send(res, success(route));
      },
    },
    {
      method: 'POST',
      pattern: '/api/admin/routes/:encodedRouteKey/sessions/batch',
      handler: async function batchAddSessionsHandler(req, res, params) {
        const body = await readObjectBody(req, res);
        if (!body) return;
        if (!Array.isArray(body.sessionIds) || body.sessionIds.length === 0) {
          send(res, error('BAD_REQUEST', '请求体需包含 sessionIds 数组'), 400);
          return;
        }
        sendResult(res, routeAdmin.batchAddSessions(ctx, params.encodedRouteKey, body.sessionIds));
      },
    },
    {
      method: 'DELETE',
      pattern: '/api/admin/routes/:encodedRouteKey/sessions/batch',
      handler: async function batchRemoveSessionsHandler(req, res, params) {
        const body = await readObjectBody(req, res);
        if (!body) return;
        if (!Array.isArray(body.sessionIds) || body.sessionIds.length === 0) {
          send(res, error('BAD_REQUEST', '请求体需包含 sessionIds 数组'), 400);
          return;
        }
        sendResult(res, routeAdmin.batchRemoveSessions(ctx, params.encodedRouteKey, body.sessionIds));
      },
    },
    {
      method: 'POST',
      pattern: '/api/admin/routes/detect-dangling',
      handler: function detectDanglingHandler(_req, res) {
        const dangling = routeAdmin.detectDangling(ctx);
        send(res, success({ list: dangling, total: dangling.length }));
      },
    },
  ];
}

/** 解析 JSON 对象请求体并发送统一错误。 */
async function readObjectBody(req, res) {
  let body;
  try {
    body = await parseBody(req);
  } catch (err) {
    const status = err.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400;
    send(res, error(err.code || 'BAD_REQUEST', err.message || '无效请求体'), status);
    return null;
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    send(res, error('BAD_REQUEST', '请求体需为 JSON 对象'), 400);
    return null;
  }
  return body;
}

/** 发送领域操作结果。 */
function sendResult(res, result) {
  if (!result.ok) {
    const status = result.error.code === 'NOT_FOUND' ? 404 : 400;
    send(res, error(result.error.code, result.error.message), status);
    return;
  }
  send(res, success(result));
}

/** 判断值是否为非空字符串。 */
function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

module.exports = { createRouteRoutes };
