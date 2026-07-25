'use strict';

/**
 * Session 管理服务函数
 * 提供会话的列表、详情、创建、停止、删除、prompt 和 timeline 操作
 * 所有状态变更操作会写入 eventStore
 */

const { recordEvent, recordMetric, listEvents, timelineForSession } = require('./event-store');

const NON_BUSINESS_EVENT_TYPES = new Set([
  'heartbeat',
  'runtime.heartbeat',
  'tui.heartbeat',
  'health.heartbeat',
]);

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

  return sessions
    .map((session) => withRuntimeDiagnostics(ctx, withRouteDiagnostics(session, routes), routes))
    .sort((left, right) => (right.opencodeSessionCreatedAt || right.createdAt || 0) - (left.opencodeSessionCreatedAt || left.createdAt || 0));
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

  return { ...withRuntimeDiagnostics(ctx, withRouteDiagnostics(session, routes), routes), timeline };
}

/**
 * 聚合 Session 的 transport、runtime、watch、health 和活动时间。
 * @param {Object} ctx - 应用上下文。
 * @param {Object} session - 已附加路由信息的 Session。
 * @param {Object} routes - 规范化路由映射。
 * @returns {Object} 运行态诊断 DTO。
 */
function withRuntimeDiagnostics(ctx, session, routes) {
  const agentRef = session.agentRef || {};
  const runtimeId = agentRef.runtimeId || null;
  const runtime = runtimeId && ctx.tuiBridge && typeof ctx.tuiBridge.getRuntimeSnapshot === 'function'
    ? ctx.tuiBridge.getRuntimeSnapshot(runtimeId) : null;
  const health = ctx.healthPoller && typeof ctx.healthPoller.getHealthSnapshot === 'function'
    ? ctx.healthPoller.getHealthSnapshot(session.id) : null;
  const transport = normalizeTransport(agentRef.transport);
  const watchActive = !!(ctx.dispatcher && ctx.dispatcher.sessionWatchStops
    && typeof ctx.dispatcher.sessionWatchStops.has === 'function'
    && ctx.dispatcher.sessionWatchStops.has(session.id));
  const currentTurn = ctx.dispatcher && typeof ctx.dispatcher.getTurnState === 'function'
    ? ctx.dispatcher.getTurnState(session.id) : null;
  const routeActivity = session.routeKeys.reduce((latest, routeKey) => {
    const route = routes[routeKey];
    return Math.max(latest, route && route.lastActiveAt || 0);
  }, 0);
  const lastHeartbeatAt = runtime && runtime.lastHeartbeatAt || null;
  const lastBusinessEventAt = getLastBusinessEventAt(ctx, session.id);
  return {
    ...session,
    transport,
    runtimeId,
    watch: { active: watchActive, mode: watchActive ? transport : 'unknown' },
    health: health ? { status: health.status || 'unknown', reason: health.reason || null }
      : runtime && runtime.health ? { ...runtime.health }
        : { status: 'unknown', reason: null },
    lastHeartbeatAt,
    opencodeSessionCreatedAt: getOpencodeSessionCreatedAt(session),
    lastBusinessEventAt,
    currentTurn: currentTurn ? { ...currentTurn } : null,
    lastActiveAt: Math.max(session.updatedAt || 0, routeActivity, lastHeartbeatAt || 0) || null,
  };
}

function getOpencodeSessionCreatedAt(session) {
  const agentRef = session.agentRef || {};
  return agentRef.opencodeSessionCreatedAt
    || agentRef.sessionCreatedAt
    || agentRef.createdAt
    || session.opencodeSessionCreatedAt
    || session.createdAt
    || null;
}

function getLastBusinessEventAt(ctx, sessionId) {
  const events = listEvents(ctx.eventStore, { sessionId, limit: 100 });
  const event = events.find((item) => isBusinessEvent(item));
  return event ? event.createdAt : null;
}

function isBusinessEvent(event) {
  const type = String(event && event.type || '').toLowerCase();
  if (!type) return false;
  if (NON_BUSINESS_EVENT_TYPES.has(type)) return false;
  return !type.includes('heartbeat');
}

/**
 * 将内部 transport 名称转换为 Admin DTO 枚举。
 * @param {string} transport - 内部 transport 名称。
 * @returns {string} tui、sse、polling 或 unknown。
 */
function normalizeTransport(transport) {
  if (transport === 'tui-bridge' || transport === 'tui') return 'tui';
  if (transport === 'sse') return 'sse';
  if (transport === 'polling' || transport === 'http') return 'polling';
  return 'unknown';
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
    opencodeSessionId: agentRef.opencodeSessionId || null,
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
        ctx.sessionService.updateSessionField(session.id, 'agentRef', agentRef);
        ctx.sessionService.markRunning(session.id);
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

/**
 * 搜索会话，支持按标题、agent、状态、标签过滤
 * @param {Object} ctx - 上下文对象
 * @param {Object} opts - 搜索选项
 * @param {string} [opts.query] - 搜索关键词（匹配标题）
 * @param {string} [opts.agent] - Agent 类型过滤
 * @param {string} [opts.status] - 状态过滤
 * @param {string} [opts.tag] - 标签过滤
 * @param {number} [opts.limit] - 结果数量限制，默认 50
 * @param {number} [opts.offset] - 偏移量，默认 0
 * @returns {{ sessions: Object[], total: number, hasMore: boolean }}
 */
function searchSessions(ctx, opts) {
  const options = opts || {};
  const query = options.query || '';
  const agent = options.agent || '';
  const status = options.status || '';
  const tag = options.tag || '';
  const limit = Math.min(Math.max(options.limit || 50, 1), 200);
  const offset = Math.max(options.offset || 0, 0);

  let sessions = listSessions(ctx);

  if (query) {
    const lowerQuery = query.toLowerCase();
    sessions = sessions.filter((s) => (s.title || '').toLowerCase().includes(lowerQuery));
  }

  if (agent) {
    sessions = sessions.filter((s) => s.agent === agent);
  }

  if (status) {
    sessions = sessions.filter((s) => s.status === status);
  }

  if (tag) {
    sessions = sessions.filter((s) => {
      const tags = s.tags || [];
      return Array.isArray(tags) && tags.includes(tag);
    });
  }

  const total = sessions.length;
  const paginatedSessions = sessions.slice(offset, offset + limit);
  const hasMore = offset + limit < sessions.length;

  return { sessions: paginatedSessions, total, hasMore };
}

/**
 * 更新会话标签
 * @param {Object} ctx - 上下文对象
 * @param {string} sessionId - 会话 ID
 * @param {string[]} tags - 标签数组
 * @returns {Object} 操作结果
 */
function updateSessionTags(ctx, sessionId, tags) {
  const session = ctx.sessionService.getSession(sessionId);
  if (!session) {
    return { ok: false, error: { code: 'NOT_FOUND', message: 'session not found' } };
  }

  try {
    ctx.sessionService.updateSessionField(sessionId, 'tags', tags);
    recordEvent(ctx.eventStore, {
      type: 'session.state',
      sessionId,
      message: 'session tags updated',
      data: { tags },
    });
    return { ok: true, session: ctx.sessionService.getSession(sessionId) };
  } catch (err) {
    return { ok: false, error: { code: 'BAD_REQUEST', message: err.message } };
  }
}

/**
 * 批量停止会话
 * @param {Object} ctx - 上下文对象
 * @param {string[]} sessionIds - 会话 ID 数组
 * @returns {Promise<{ results: Object[] }>} 操作结果
 */
async function batchStopSessions(ctx, sessionIds) {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    return { ok: false, error: { code: 'BAD_REQUEST', message: 'sessionIds 数组不能为空' } };
  }

  const results = [];
  for (const sessionId of sessionIds) {
    const result = await stopSession(ctx, sessionId);
    results.push({ sessionId, ...result });
  }

  return { ok: true, results };
}

/**
 * 批量删除会话
 * @param {Object} ctx - 上下文对象
 * @param {string[]} sessionIds - 会话 ID 数组
 * @returns {Promise<{ results: Object[] }>} 操作结果
 */
async function batchDeleteSessions(ctx, sessionIds) {
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    return { ok: false, error: { code: 'BAD_REQUEST', message: 'sessionIds 数组不能为空' } };
  }

  const results = [];
  for (const sessionId of sessionIds) {
    const result = await deleteSession(ctx, sessionId);
    results.push({ sessionId, ...result });
  }

  return { ok: true, results };
}

module.exports = {
  listSessions,
  getSession,
  createSession,
  stopSession,
  deleteSession,
  sendPrompt,
  getTimeline,
  searchSessions,
  updateSessionTags,
  batchStopSessions,
  batchDeleteSessions,
};
