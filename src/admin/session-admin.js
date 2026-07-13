'use strict';

/**
 * Session 管理服务函数
 * 提供会话的列表、详情、创建、停止、删除、prompt 和 timeline 操作
 * 所有状态变更操作会写入 eventStore
 */

const { recordEvent, recordMetric, timelineForSession } = require('./event-store');

/**
 * 列出所有未删除的会话
 * @param {Object} ctx - 上下文对象
 * @param {Object} ctx.sessionService - SessionService 实例
 * @returns {Object[]} 未删除会话列表
 */
function listSessions(ctx) {
  const sessions = ctx.sessionService.listSessions();
  const state = ctx.sessionService._readNormalized ? ctx.sessionService._readNormalized() : ctx.sessionService.stateStore.read();
  const routes = state.routes || {};

  return sessions.map((session) => withRouteDiagnostics(session, routes));
}

/**
 * 获取指定会话详情，附带 routeKeys 和 timeline 摘要
 * @param {Object} ctx - 上下文对象
 * @param {string} sessionId - 会话 ID
 * @returns {Object|null} 会话详情对象，不存在则返回 null
 */
function getSession(ctx, sessionId) {
  const session = ctx.sessionService.getSession(sessionId);
  if (!session) return null;

  const state = ctx.sessionService._readNormalized ? ctx.sessionService._readNormalized() : ctx.sessionService.stateStore.read();
  const routes = state.routes || {};

  const timeline = timelineForSession(ctx.eventStore, sessionId, { limit: 10 });

  return { ...withRouteDiagnostics(session, routes), timeline };
}

function withRouteDiagnostics(session, routes) {
  const routeKeys = [];
  const focusRouteKeys = [];
  for (const routeKey of Object.keys(routes || {})) {
    const route = routes[routeKey];
    if (!route || !Array.isArray(route.sessions) || !route.sessions.includes(session.id)) continue;
    routeKeys.push(routeKey);
    if (route.focusSessionId === session.id) focusRouteKeys.push(routeKey);
  }
  const agentRef = session.agentRef || {};
  return {
    ...session,
    routeKeys,
    focusRouteKeys,
    isUnbound: routeKeys.length === 0,
    opencodeSessionId: agentRef.opencodeSessionId || '',
    serverUrl: agentRef.serverUrl || '',
  };
}

/**
 * 创建 Walker session，可选同时创建底层 opencode session 写入 agentRef
 * @param {Object} ctx - 上下文对象
 * @param {Object} opts - 创建选项
 * @param {string} [opts.agent] - Agent 类型，默认 'opencode'
 * @param {string} [opts.title] - 会话标题
 * @param {string} [opts.runtime] - 运行时类型，默认 'windows'
 * @param {string} [opts.cwd] - 工作目录
 * @param {string} [opts.route] - 要绑定的路由键
 * @param {boolean} [opts.createAgentSession] - 是否创建底层 agent session
 * @returns {Promise<Object>} 创建的会话对象
 */
async function createSession(ctx, opts) {
  const options = opts || {};
  const session = ctx.sessionService.createSession({
    agent: options.agent,
    title: options.title,
    runtime: options.runtime,
    cwd: options.cwd,
    route: options.route,
  });

  recordEvent(ctx.eventStore, {
    type: 'session.state',
    sessionId: session.id,
    message: 'session created',
    data: { agent: session.agent, runtime: session.runtime },
  });

  if (options.createAgentSession && session.agent === 'opencode') {
    const driver = ctx.registry.get('opencode');
    if (driver) {
      try {
        const agentRef = await driver.createSession({
          title: session.title,
          cwd: session.cwd,
        });
        ctx.sessionService.stateStore.update((data) => {
          if (!data.sessions) data.sessions = {};
          if (data.sessions[session.id]) {
            data.sessions[session.id].agentRef = agentRef;
            data.sessions[session.id].status = 'running';
            data.sessions[session.id].updatedAt = Date.now();
          }
        });
        session.agentRef = agentRef;
        session.status = 'running';

        recordEvent(ctx.eventStore, {
          type: 'session.state',
          sessionId: session.id,
          message: 'agent session created',
          data: { agentRef },
        });
      } catch (err) {
        ctx.sessionService.markError(session.id, err.message);
        recordEvent(ctx.eventStore, {
          type: 'error',
          level: 'error',
          sessionId: session.id,
          message: 'agent session creation failed: ' + err.message,
        });
      }
    }
  }

  return ctx.sessionService.getSession(session.id) || session;
}

/**
 * 停止会话，优先调用 driver stop，失败时仍标记 stopped 并返回 warning
 * @param {Object} ctx - 上下文对象
 * @param {string} sessionId - 会话 ID
 * @returns {Promise<Object>} 结果对象，含 session 和可能的 warning
 */
async function stopSession(ctx, sessionId) {
  const session = ctx.sessionService.getSession(sessionId);
  if (!session) {
    return { ok: false, error: { code: 'NOT_FOUND', message: 'session not found' } };
  }

  let warning = null;

  if (session.agentRef) {
    const driver = ctx.registry.get(session.agent);
    if (driver) {
      try {
        await driver.stop(session.agentRef);
      } catch (err) {
        warning = 'driver stop failed: ' + err.message;
      }
    } else {
      warning = 'driver not found for agent: ' + session.agent;
    }
  }

  ctx.sessionService.stopSession(sessionId);

  recordEvent(ctx.eventStore, {
    type: 'session.state',
    sessionId,
    message: 'session stopped' + (warning ? ' (with warning)' : ''),
    data: { warning },
  });

  const updated = ctx.sessionService.getSession(sessionId);
  return { ok: true, session: updated, warning };
}

/**
 * 删除会话，优先调用 driver delete，失败时仍标记删除并返回 warning
 * @param {Object} ctx - 上下文对象
 * @param {string} sessionId - 会话 ID
 * @returns {Promise<Object>} 结果对象，含 ok 和可能的 warning
 */
async function deleteSession(ctx, sessionId) {
  const session = ctx.sessionService.getSession(sessionId);
  if (!session) {
    return { ok: false, error: { code: 'NOT_FOUND', message: 'session not found' } };
  }

  let warning = null;

  if (session.agentRef) {
    const driver = ctx.registry.get(session.agent);
    if (driver) {
      try {
        await driver.delete(session.agentRef);
      } catch (err) {
        warning = 'driver delete failed: ' + err.message;
      }
    } else {
      warning = 'driver not found for agent: ' + session.agent;
    }
  }

  ctx.sessionService.deleteSession(sessionId);

  recordEvent(ctx.eventStore, {
    type: 'session.state',
    sessionId,
    message: 'session deleted' + (warning ? ' (with warning)' : ''),
    data: { warning },
  });

  return { ok: true, warning };
}

/**
 * 向有 agentRef 的会话发送 prompt
 * @param {Object} ctx - 上下文对象
 * @param {string} sessionId - 会话 ID
 * @param {string} text - 提示文本
 * @returns {Promise<Object>} 结果对象，含事件列表或错误信息
 */
async function sendPrompt(ctx, sessionId, text) {
  const session = ctx.sessionService.getSession(sessionId);
  if (!session) {
    return { ok: false, error: { code: 'NOT_FOUND', message: 'session not found' } };
  }

  if (!session.agentRef) {
    return { ok: false, error: { code: 'BAD_REQUEST', message: 'session has no agentRef, cannot send prompt' } };
  }

  const driver = ctx.registry.get(session.agent);
  if (!driver) {
    return { ok: false, error: { code: 'NOT_FOUND', message: 'driver not found for agent: ' + session.agent } };
  }

  const startTime = Date.now();

  recordEvent(ctx.eventStore, {
    type: 'admin.action',
    sessionId,
    message: 'web prompt sent',
    data: { textLength: text.length, source: 'web-admin' },
  });
  recordMetric(ctx.eventStore, 'prompts');

  try {
    const events = await driver.prompt(session.agentRef, text);
    const durationMs = Date.now() - startTime;
    recordMetric(ctx.eventStore, 'promptDurationMs', durationMs);
    recordEvent(ctx.eventStore, {
      type: 'session.state',
      sessionId,
      message: 'prompt completed',
      data: { durationMs, eventCount: events.length },
    });
    return { ok: true, events };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    recordMetric(ctx.eventStore, 'promptDurationMs', durationMs);
    recordMetric(ctx.eventStore, 'errors');
    recordEvent(ctx.eventStore, {
      type: 'error',
      level: 'error',
      sessionId,
      message: 'prompt failed: ' + err.message,
      data: { durationMs },
    });
    return { ok: false, error: { code: 'INTERNAL_ERROR', message: err.message } };
  }
}

/**
 * 获取指定会话的 timeline（合并状态、route、prompt 和错误事件）
 * @param {Object} ctx - 上下文对象
 * @param {string} sessionId - 会话 ID
 * @param {Object} [opts] - 过滤选项
 * @returns {Object[]} 事件时间线列表
 */
function getTimeline(ctx, sessionId, opts) {
  return timelineForSession(ctx.eventStore, sessionId, opts);
}

module.exports = {
  listSessions,
  getSession,
  createSession,
  stopSession,
  deleteSession,
  sendPrompt,
  getTimeline,
};
