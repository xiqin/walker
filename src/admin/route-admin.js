'use strict';

/**
 * Route 管理服务函数
 * 提供路由的列表、绑定、解绑、悬空诊断和清理操作
 */

const { recordEvent } = require('./event-store');

/**
 * 列出所有 route 绑定及其健康状态
 * @param {Object} ctx - 上下文对象
 * @returns {Object[]} route 绑定列表，每条含 routeKey、sessionId、health 和 dangling 标记
 */
function listRoutes(ctx) {
  const state = ctx.sessionService._readNormalized ? ctx.sessionService._readNormalized() : ctx.sessionService.stateStore.read();
  const routes = state.routes || {};
  const sessions = state.sessions || {};

  return Object.keys(routes).map((routeKey) => {
    const route = routes[routeKey];
    const sessionId = route ? route.focusSessionId : null;
    const session = sessionId ? sessions[sessionId] : null;
    const sessionIds = route && Array.isArray(route.sessions) ? route.sessions.slice() : [];
    const activeSessions = [];
    const missingSessionIds = [];
    const deletedSessionIds = [];
    for (const id of sessionIds) {
      const item = sessions[id];
      if (!item) {
        missingSessionIds.push(id);
      } else if (item.status === 'deleted') {
        deletedSessionIds.push(id);
      } else {
        activeSessions.push(summarizeSession(item, id === sessionId));
      }
    }
    const dangling = !sessionId
      || !session
      || session.status === 'deleted'
      || !sessionIds.includes(sessionId)
      || missingSessionIds.length > 0
      || deletedSessionIds.length > 0;
    const cwd = route && route.cwd ? route.cwd : findSessionCwd(session, sessionIds, sessions);

    return {
      routeKey,
      sessionId,
      focusSessionId: sessionId,
      sessions: sessionIds,
      sessionIds,
      sessionCount: sessionIds.length,
      activeSessions,
      missingSessionIds,
      deletedSessionIds,
      cwd,
      lastActiveAt: route && route.lastActiveAt ? route.lastActiveAt : null,
      updatedAt: route && route.updatedAt ? route.updatedAt : null,
      health: dangling ? 'dangling' : (session ? session.status : 'unknown'),
      dangling,
      session: dangling ? null : session,
    };
  });
}

function findSessionCwd(focusSession, sessionIds, sessions) {
  if (focusSession && focusSession.cwd) return focusSession.cwd;
  for (const id of sessionIds) {
    const session = sessions[id];
    if (session && session.status !== 'deleted' && session.cwd) return session.cwd;
  }
  return '';
}

function summarizeSession(session, isFocus) {
  const agentRef = session.agentRef || {};
  return {
    id: session.id,
    title: session.title || '',
    agent: session.agent || '',
    status: session.status || '',
    cwd: session.cwd || '',
    runtime: session.runtime || '',
    isFocus: !!isFocus,
    opencodeSessionId: agentRef.opencodeSessionId || '',
    serverUrl: agentRef.serverUrl || '',
    updatedAt: session.updatedAt || null,
  };
}

/**
 * 获取单条 Route 的稳定 v3 DTO。
 * @param {Object} ctx - 上下文对象
 * @param {string} routeKey - Route 键
 * @returns {Object|null} Route DTO，不存在时返回 null
 */
function getRoute(ctx, routeKey) {
  return listRoutes(ctx).find((route) => route.routeKey === routeKey) || null;
}

/**
 * 将 Session 添加到 Route，但不改变已有 Route 的焦点。
 * @param {Object} ctx - 上下文对象
 * @param {string} routeKey - Route 键
 * @param {string} sessionId - Session ID
 * @returns {Object} 操作结果
 */
function addSession(ctx, routeKey, sessionId) {
  try {
    ctx.sessionService.addSessionToRoute(routeKey, sessionId);
  } catch (err) {
    return operationError(err);
  }
  recordRouteEvent(ctx, 'route.session.add', routeKey, sessionId, 'session added to route');
  return { ok: true, route: getRoute(ctx, routeKey) };
}

/**
 * 从 Route 移除指定 Session。
 * @param {Object} ctx - 上下文对象
 * @param {string} routeKey - Route 键
 * @param {string} sessionId - Session ID
 * @returns {Object} 操作结果，removed 表示本次是否实际移除
 */
function removeSession(ctx, routeKey, sessionId) {
  try {
    const removed = ctx.sessionService.removeSessionFromRoute(routeKey, sessionId);
    if (removed) recordRouteEvent(ctx, 'route.session.remove', routeKey, sessionId, 'session removed from route');
    return { ok: true, removed, route: getRoute(ctx, routeKey) };
  } catch (err) {
    return operationError(err);
  }
}

/**
 * 设置 Route 焦点 Session。
 * @param {Object} ctx - 上下文对象
 * @param {string} routeKey - Route 键
 * @param {string} sessionId - Session ID
 * @returns {Object} 操作结果
 */
function setFocus(ctx, routeKey, sessionId) {
  try {
    ctx.sessionService.setFocus(routeKey, sessionId);
  } catch (err) {
    return operationError(err);
  }
  recordRouteEvent(ctx, 'route.focus', routeKey, sessionId, 'route focus changed');
  return { ok: true, route: getRoute(ctx, routeKey) };
}

/**
 * 更新 Route CWD。
 * @param {Object} ctx - 上下文对象
 * @param {string} routeKey - Route 键
 * @param {string} cwd - 绝对路径
 * @returns {Object} 操作结果
 */
function updateRoute(ctx, routeKey, cwd) {
  if (!getRoute(ctx, routeKey)) {
    return { ok: false, error: { code: 'NOT_FOUND', message: 'route not found: ' + routeKey } };
  }
  try {
    ctx.sessionService.setRouteCwd(routeKey, cwd);
  } catch (err) {
    return operationError(err);
  }
  recordRouteEvent(ctx, 'route.update', routeKey, '', 'route cwd updated');
  return { ok: true, route: getRoute(ctx, routeKey) };
}

/**
 * 删除整条 Route。
 * @param {Object} ctx - 上下文对象
 * @param {string} routeKey - Route 键
 * @returns {Object} 操作结果
 */
function deleteRoute(ctx, routeKey) {
  try {
    const deleted = ctx.sessionService.deleteRoute(routeKey);
    if (deleted) recordRouteEvent(ctx, 'route.delete', routeKey, '', 'route deleted');
    return { ok: true, deleted, routeKey };
  } catch (err) {
    return operationError(err);
  }
}

/** 将领域错误转换为稳定 Admin 错误语义。 */
function operationError(err) {
  const message = err && err.message ? err.message : 'route operation failed';
  const code = /not found/.test(message) ? 'NOT_FOUND' : 'BAD_REQUEST';
  return { ok: false, error: { code, message } };
}

/** 记录 Route 写操作事件。 */
function recordRouteEvent(ctx, type, routeKey, sessionId, message) {
  recordEvent(ctx.eventStore, { type, routeKey, sessionId, message });
}

/**
 * 将路由键绑定到指定会话
 * @param {Object} ctx - 上下文对象
 * @param {string} routeKey - 路由键
 * @param {string} sessionId - 要绑定的会话 ID
 * @returns {Object} 绑定结果
 */
function bindRoute(ctx, routeKey, sessionId) {
  try {
    ctx.sessionService.bindRoute(routeKey, sessionId);
  } catch (err) {
    return { ok: false, error: { code: 'BAD_REQUEST', message: err.message } };
  }

  recordEvent(ctx.eventStore, {
    type: 'route.bind',
    routeKey,
    sessionId,
    message: 'route bound to session',
  });

  return { ok: true, routeKey, sessionId, route: getRoute(ctx, routeKey) };
}

/**
 * 解除路由键的会话绑定
 * @param {Object} ctx - 上下文对象
 * @param {string} routeKey - 要解绑的路由键
 * @returns {Object} 解绑结果
 */
function unbindRoute(ctx, routeKey) {
  try {
    ctx.sessionService.unbindRoute(routeKey);
  } catch (err) {
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: err.message } };
  }

  recordEvent(ctx.eventStore, {
    type: 'route.bind',
    routeKey,
    message: 'route unbound',
  });

  return { ok: true, routeKey };
}

/**
 * 检测所有悬空绑定（指向不存在或已删除 session 的 route）
 * @param {Object} ctx - 上下文对象
 * @returns {Object[]} 悬空 route 列表
 */
function detectDangling(ctx) {
  const state = ctx.sessionService._readNormalized ? ctx.sessionService._readNormalized() : ctx.sessionService.stateStore.read();
  const routes = state.routes || {};
  const sessions = state.sessions || {};

  const dangling = [];
  for (const routeKey of Object.keys(routes)) {
    const route = routes[routeKey];
    if (!route || !Array.isArray(route.sessions) || !route.focusSessionId) {
      dangling.push({
        routeKey,
        sessionId: route ? route.focusSessionId : null,
        reason: !route || !Array.isArray(route.sessions) ? 'route has invalid sessions' : 'route has no focusSessionId',
      });
      continue;
    }
    const sessionId = route.focusSessionId;
    const session = sessions[sessionId];
    if (!session || session.status === 'deleted') {
      dangling.push({
        routeKey,
        sessionId,
        reason: !session ? 'session not found' : 'session deleted',
      });
      continue;
    }
    const invalidMember = route.sessions.find((id) => !sessions[id] || sessions[id].status === 'deleted');
    if (invalidMember || !route.sessions.includes(sessionId)) {
      dangling.push({
        routeKey,
        sessionId: invalidMember || sessionId,
        reason: invalidMember
          ? (!sessions[invalidMember] ? 'session not found' : 'session deleted')
          : 'focus session not in route',
      });
    }
  }
  return dangling;
}

/**
 * 确认后清理所有悬空绑定
 * @param {Object} ctx - 上下文对象
 * @param {boolean} confirm - 是否确认清理，必须为 true 才执行
 * @returns {Object} 清理结果，含已清理的 route 列表
 */
function cleanupDangling(ctx, confirm) {
  if (!confirm) {
    return { ok: false, error: { code: 'BAD_REQUEST', message: 'cleanup requires confirm=true' } };
  }

  const danglingByRoute = new Map(detectDangling(ctx).map((item) => [item.routeKey, item]));
  const cleaned = ctx.sessionService.cleanOrphanRoutes();

  for (const routeKey of cleaned) {
    const item = danglingByRoute.get(routeKey);
    recordEvent(ctx.eventStore, {
      type: 'route.bind',
      routeKey,
      message: 'dangling route cleaned up',
      data: { reason: item ? item.reason : 'dangling route member removed' },
    });
  }

  return { ok: true, cleaned };
}

/**
 * 批量将 Session 添加到 Route
 * @param {Object} ctx - 上下文对象
 * @param {string} routeKey - Route 键
 * @param {string[]} sessionIds - Session ID 数组
 * @returns {Object} 操作结果
 */
function batchAddSessions(ctx, routeKey, sessionIds) {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    return { ok: false, error: { code: 'BAD_REQUEST', message: 'sessionIds 数组不能为空' } };
  }

  const results = [];
  for (const sessionId of sessionIds) {
    const result = addSession(ctx, routeKey, sessionId);
    results.push({ sessionId, ...result });
  }

  return { ok: true, results, route: getRoute(ctx, routeKey) };
}

/**
 * 批量从 Route 移除 Session
 * @param {Object} ctx - 上下文对象
 * @param {string} routeKey - Route 键
 * @param {string[]} sessionIds - Session ID 数组
 * @returns {Object} 操作结果
 */
function batchRemoveSessions(ctx, routeKey, sessionIds) {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    return { ok: false, error: { code: 'BAD_REQUEST', message: 'sessionIds 数组不能为空' } };
  }

  const results = [];
  for (const sessionId of sessionIds) {
    const result = removeSession(ctx, routeKey, sessionId);
    results.push({ sessionId, ...result });
  }

  return { ok: true, results, route: getRoute(ctx, routeKey) };
}

module.exports = {
  listRoutes,
  getRoute,
  bindRoute,
  unbindRoute,
  addSession,
  removeSession,
  setFocus,
  updateRoute,
  deleteRoute,
  detectDangling,
  cleanupDangling,
  batchAddSessions,
  batchRemoveSessions,
};
