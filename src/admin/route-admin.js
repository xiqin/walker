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
  const state = ctx.sessionService.stateStore.read();
  const routes = state.routes || {};
  const sessions = state.sessions || {};

  return Object.keys(routes).map((routeKey) => {
    const sessionId = routes[routeKey];
    const session = sessions[sessionId];
    const dangling = !session || session.status === 'deleted';

    return {
      routeKey,
      sessionId,
      health: dangling ? 'dangling' : (session ? session.status : 'unknown'),
      dangling,
      session: dangling ? null : session,
    };
  });
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

  return { ok: true, routeKey, sessionId };
}

/**
 * 解除路由键的会话绑定
 * @param {Object} ctx - 上下文对象
 * @param {string} routeKey - 要解绑的路由键
 * @returns {Object} 解绑结果
 */
function unbindRoute(ctx, routeKey) {
  ctx.sessionService.unbindRoute(routeKey);

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
  const state = ctx.sessionService.stateStore.read();
  const routes = state.routes || {};
  const sessions = state.sessions || {};

  const dangling = [];
  for (const routeKey of Object.keys(routes)) {
    const sessionId = routes[routeKey];
    const session = sessions[sessionId];
    if (!session || session.status === 'deleted') {
      dangling.push({
        routeKey,
        sessionId,
        reason: !session ? 'session not found' : 'session deleted',
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

  const dangling = detectDangling(ctx);
  const cleaned = [];

  for (const item of dangling) {
    ctx.sessionService.unbindRoute(item.routeKey);
    recordEvent(ctx.eventStore, {
      type: 'route.bind',
      routeKey: item.routeKey,
      message: 'dangling route cleaned up',
      data: { reason: item.reason },
    });
    cleaned.push(item.routeKey);
  }

  return { ok: true, cleaned };
}

module.exports = {
  listRoutes,
  bindRoute,
  unbindRoute,
  detectDangling,
  cleanupDangling,
};
