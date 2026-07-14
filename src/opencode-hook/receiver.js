'use strict';

/**
 * OpenCode hook receiver：接收 plugin 上报的 session.created 事件，
 * 按 cwd 匹配 routeKey 创建 Walker session 并加入 route 的 1:N sessions 列表。
 * 仅接受本机 loopback 请求，复用 admin token 鉴权。
 */

const { success, error, send } = require('../admin/response');
const { parseBody, isAuthenticated } = require('../admin/auth');
const { createLogger } = require('../core/logger');

const logger = createLogger('hook-receiver');

/**
 * 判断请求来源是否为 loopback 地址
 * @param {import('http').IncomingMessage} req - HTTP 请求
 * @returns {boolean}
 */
function isLoopback(req) {
  const addr = (req.socket && req.socket.remoteAddress)
    || (req.connection && req.connection.remoteAddress)
    || (req.remoteAddress)
    || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * 路径规范化：统一为小写并标准化分隔符，用于跨平台 cwd 匹配
 * Windows 路径大小写不敏感，统一小写比较；统一使用反斜杠
 * @param {string} p - 路径
 * @returns {string}
 */
function normalizePath(p) {
  if (!p) return '';
  const isWindows = process.platform === 'win32';
  const normalized = p.trim().replace(/[\\/]+$/, '');
  if (isWindows) {
    return normalized.replace(/\//g, '\\').toLowerCase();
  }
  return normalized.replace(/\\/g, '/');
}

/**
 * 判断 child 是否等于或位于 parent 目录下
 * @param {string} parent - 父目录规范化路径
 * @param {string} child - 子目录规范化路径
 * @returns {boolean}
 */
function isExactOrSubdir(parent, child) {
  if (!parent || !child) return false;
  if (parent === child) return true;
  const sep = process.platform === 'win32' ? '\\' : '/';
  return child.startsWith(parent + sep);
}

/**
 * 按 cwd 查找匹配的 routeKey
 * 匹配优先级：精确匹配 > 子目录匹配；多候选取 updatedAt 最大
 * @param {Object} ctx - 应用上下文
 * @param {string} cwd - 上报的 cwd
 * @returns {string|null} 匹配到的 routeKey
 */
function findRouteKeyByCwd(ctx, cwd) {
  const state = ctx.sessionService.stateStore.read();
  const routes = state.routes || {};
  const normalizedCwd = normalizePath(cwd);

  const exactMatches = [];
  const subdirMatches = [];

  for (const routeKey of Object.keys(routes)) {
    const route = routes[routeKey];
    if (!route || !route.cwd) continue;
    const routeCwd = normalizePath(route.cwd);
    if (!routeCwd) continue;

    if (routeCwd === normalizedCwd) {
      exactMatches.push({ routeKey, lastActiveAt: route.lastActiveAt || 0, updatedAt: route.updatedAt || 0 });
    } else if (isExactOrSubdir(routeCwd, normalizedCwd)) {
      subdirMatches.push({ routeKey, lastActiveAt: route.lastActiveAt || 0, updatedAt: route.updatedAt || 0 });
    }
  }

  if (exactMatches.length > 0) {
    exactMatches.sort(compareRouteCandidates);
    return exactMatches[0].routeKey;
  }

  if (subdirMatches.length === 0) return null;
  if (subdirMatches.length === 1) return subdirMatches[0].routeKey;

  subdirMatches.sort(compareRouteCandidates);
  return subdirMatches[0].routeKey;
}

function compareRouteCandidates(a, b) {
  return (b.lastActiveAt || 0) - (a.lastActiveAt || 0)
    || (b.updatedAt || 0) - (a.updatedAt || 0);
}

/**
 * 检查是否已有 Walker session 持有相同 opencodeSessionId
 * @param {Object} ctx - 应用上下文
 * @param {string} opencodeSessionId - OpenCode session ID
 * @returns {Object|null} 已存在的 Walker session 或 null
 */
function findExistingSession(ctx, opencodeSessionId) {
  const state = ctx.sessionService.stateStore.read();
  const sessions = state.sessions || {};
  for (const id of Object.keys(sessions)) {
    const s = sessions[id];
    if (!s || s.status === 'deleted') continue;
    if (s.agentRef && s.agentRef.opencodeSessionId === opencodeSessionId) {
      return s;
    }
  }
  return null;
}

/**
 * 自动纳入 session：按 cwd 找 routeKey，创建 Walker session 并加入 route
 * 幂等：同一 opencodeSessionId 不重复纳入
 * @param {Object} ctx - 应用上下文
 * @param {Object} params - 上报参数
 * @param {string} params.opencodeBaseUrl - OpenCode 服务器地址
 * @param {string} params.sessionId - OpenCode session ID
 * @param {string} params.cwd - OpenCode 工作目录
 * @returns {{ sessionId: string, routeKey: string|null }}
 */
function _autoEnrollSession(ctx, params) {
  const opencodeSessionId = params.sessionId;
  const cwd = params.cwd || '';
  const defaultOpencodeUrl = (ctx && ctx.defaultOpencodeUrl) || 'http://localhost:4096';
  const opencodeBaseUrl = params.opencodeBaseUrl || defaultOpencodeUrl;

  const existing = findExistingSession(ctx, opencodeSessionId);
  if (existing) {
    const routeKey = ctx.sessionService.getRouteForSession(existing.id);
    logger.info('session already enrolled, idempotent return', {
      walkerSessionId: existing.id,
      opencodeSessionId,
      routeKey,
    });
    if (typeof ctx.onSessionEnrolled === 'function') {
      try { ctx.onSessionEnrolled({ sessionId: existing.id, routeKey }); } catch (cbErr) {
        logger.warn('onSessionEnrolled callback failed', { err: cbErr, sessionId: existing.id });
      }
    }
    return { sessionId: existing.id, routeKey };
  }

  const routeKey = findRouteKeyByCwd(ctx, cwd);

  const session = ctx.sessionService.createSession({
    agent: 'opencode',
    cwd,
    agentRef: {
      opencodeSessionId,
      serverUrl: opencodeBaseUrl,
    },
  });

  if (routeKey) {
    ctx.sessionService.addSessionToRoute(routeKey, session.id, cwd);
    logger.info('session enrolled to route', {
      walkerSessionId: session.id,
      opencodeSessionId,
      routeKey,
      cwd,
    });
  } else {
    logger.info('session enrolled as free-floating', {
      walkerSessionId: session.id,
      opencodeSessionId,
      cwd,
    });
  }

  if (typeof ctx.onSessionEnrolled === 'function') {
    try { ctx.onSessionEnrolled({ sessionId: session.id, routeKey }); } catch (cbErr) {
      logger.warn('onSessionEnrolled callback failed', { err: cbErr, sessionId: session.id });
    }
  }

  return { sessionId: session.id, routeKey };
}

/**
 * 创建 hook receiver 路由列表
 * @param {Object} ctx - 应用上下文
 * @param {Object} ctx.sessionService - SessionService 实例
 * @param {Object} ctx.config - 配置对象，支持完整 config（ctx.config.admin.token）或直接 adminConfig（ctx.config.token）
 * @param {Function} [ctx.onSessionEnrolled] - session 纳入 route 后的回调，接收 { sessionId, routeKey }
 * @returns {Array<{ method: string, pattern: string, handler: Function }>} 路由数组
 */
function createHookReceiverRoutes(ctx) {
  const adminConfig = (ctx.config && ctx.config.admin) ? ctx.config.admin : (ctx.config || { token: '' });

  const routes = [];

  routes.push({
    method: 'POST',
    pattern: '/opencode/hook/session-created',
    handler: function sessionCreatedHandler(req, res) {
      if (!isLoopback(req)) {
        send(res, error('FORBIDDEN', 'only loopback requests are accepted'), 403);
        return;
      }

      if (!isAuthenticated(req, adminConfig)) {
        send(res, error('UNAUTHORIZED', '需要有效的管理端 token'), 401);
        return;
      }

      parseBody(req, (body) => {
        if (!body) {
          send(res, error('BAD_REQUEST', '无效请求体'), 400);
          return;
        }

        const opencodeBaseUrl = body.opencodeBaseUrl || '';
        const sessionId = body.sessionId;
        const cwd = body.cwd;

        if (!sessionId) {
          send(res, error('BAD_REQUEST', '缺少 sessionId'), 400);
          return;
        }
        if (!cwd) {
          send(res, error('BAD_REQUEST', '缺少 cwd'), 400);
          return;
        }

        try {
          const result = _autoEnrollSession(ctx, { opencodeBaseUrl, sessionId, cwd });
          send(res, success({ ok: true, sessionId: result.sessionId, routeKey: result.routeKey }));
        } catch (err) {
          logger.error('auto enroll session failed', { err, sessionId, cwd });
          send(res, error('INTERNAL_ERROR', err.message), 500);
        }
      });
    },
  });

  return routes;
}

module.exports = {
  createHookReceiverRoutes,
  _autoEnrollSession,
  isLoopback,
  findRouteKeyByCwd,
  findExistingSession,
  normalizePath,
  isExactOrSubdir,
};
