'use strict';

/**
 * 核心 API 路由注册
 * 导出 createCoreRoutes(appContext) 返回路由数组供集成组装
 * 覆盖 overview、sessions、routes、agents、runtime、events、metrics 等 API
 */

const { success, error, send, parseQueryString } = require('./response');
const { parseBody } = require('./auth');
const { listEvents, getMetrics } = require('./event-store');
const config = require('./config');

const sessionAdmin = require('./session-admin');
const routeAdmin = require('./route-admin');
const agentRuntimeAdmin = require('./agent-runtime-admin');

/**
 * 创建核心 API 路由列表
 * @param {Object} appContext - 应用上下文
 * @param {Object} appContext.sessionService - SessionService 实例
 * @param {Object} appContext.registry - DriverRegistry 实例
 * @param {Object} appContext.eventStore - 事件存储实例
 * @param {Object} [appContext.envConfig] - 环境配置
 * @param {Object} [appContext.feishuSummary] - 飞书连接摘要
 * @param {string} [appContext.dataDir] - 数据目录路径
 * @param {string} [appContext.version] - Walker 版本
 * @param {number} [appContext.startTime] - 进程启动时间
 * @returns {Array<{ method: string, pattern: string, handler: Function }>} 路由数组
 */
function createCoreRoutes(appContext) {
  const ctx = appContext || {};
  const routes = [];

  /**
   * GET /api/admin/overview
   * 返回进程、数据目录、session/route 统计、driver/runtime/feishu 摘要和最近错误
   */
  routes.push({
    method: 'GET',
    pattern: '/api/admin/overview',
    handler: function overviewHandler(_req, res) {
      const sessions = sessionAdmin.listSessions(ctx);
      const routeList = routeAdmin.listRoutes(ctx);
      const agents = agentRuntimeAdmin.listAgents(ctx);
      const recentErrors = listEvents(ctx.eventStore, { type: 'error', limit: 5 });
      const metrics = getMetrics(ctx.eventStore);

      const data = {
        process: {
          pid: process.pid,
          version: ctx.version || '',
          startTime: ctx.startTime || 0,
          uptime: ctx.startTime ? Date.now() - ctx.startTime : 0,
        },
        dataDir: ctx.dataDir || '',
        sessions: {
          total: sessions.length,
          byStatus: countBy(sessions, 'status'),
        },
        routes: {
          total: routeList.length,
          dangling: routeList.filter((r) => r.dangling).length,
        },
        agents: agents,
        feishu: ctx.feishuSummary || { connected: false, source: 'missing' },
        metrics: {
          messages: metrics.messages,
          commands: metrics.commands,
          prompts: metrics.prompts,
          errors: metrics.errors,
          averagePromptDurationMs: metrics.averagePromptDurationMs,
        },
        recentErrors,
      };

      send(res, success(data));
    },
  });

  /**
   * GET /api/admin/metrics
   * 返回本进程内存指标和最近 60 分钟桶统计
   */
  routes.push({
    method: 'GET',
    pattern: '/api/admin/metrics',
    handler: function metricsHandler(_req, res) {
      send(res, success(getMetrics(ctx.eventStore)));
    },
  });

  /**
   * GET /api/admin/events
   * 返回内存事件，支持 limit 和 type 查询参数
   */
  routes.push({
    method: 'GET',
    pattern: '/api/admin/events',
    handler: function eventsHandler(req, res) {
      const qs = req.queryString || '';
      const params = parseQueryString(qs);
      const opts = {};
      if (params.type) opts.type = params.type;
      if (params.limit) opts.limit = parseInt(params.limit, 10);
      send(res, success(listEvents(ctx.eventStore, opts)));
    },
  });

  /**
   * GET /api/admin/sessions
   * 列出未删除 session
   */
  routes.push({
    method: 'GET',
    pattern: '/api/admin/sessions',
    handler: function sessionsListHandler(_req, res) {
      const sessions = sessionAdmin.listSessions(ctx);
      send(res, success({ list: sessions, total: sessions.length }));
    },
  });

  /**
   * POST /api/admin/sessions
   * 创建 session
   */
  routes.push({
    method: 'POST',
    pattern: '/api/admin/sessions',
    handler: async function sessionsCreateHandler(req, res) {
      const body = await parseBody(req);
      if (!body) {
        send(res, error('BAD_REQUEST', '无效请求体'), 400);
        return;
      }
      try {
        const session = await sessionAdmin.createSession(ctx, {
          agent: body.agent,
          title: body.title,
          runtime: body.runtime,
          cwd: body.cwd,
          route: body.route,
          createAgentSession: body.createAgentSession,
        });
        send(res, success(session));
      } catch (err) {
        send(res, error('INTERNAL_ERROR', err.message), 500);
      }
    },
  });

  /**
   * GET /api/admin/sessions/:id
   * session 详情
   */
  routes.push({
    method: 'GET',
    pattern: '/api/admin/sessions/:id',
    handler: function sessionDetailHandler(_req, res, params) {
      const session = sessionAdmin.getSession(ctx, params.id);
      if (!session) {
        send(res, error('NOT_FOUND', 'session not found'), 404);
        return;
      }
      send(res, success(session));
    },
  });

  /**
   * POST /api/admin/sessions/:id/stop
   * 停止 session
   */
  routes.push({
    method: 'POST',
    pattern: '/api/admin/sessions/:id/stop',
    handler: async function sessionStopHandler(_req, res, params) {
      try {
        const result = await sessionAdmin.stopSession(ctx, params.id);
        if (!result.ok) {
          send(res, error(result.error.code, result.error.message), 404);
          return;
        }
        send(res, success({ session: result.session, warning: result.warning }));
      } catch (err) {
        send(res, error('INTERNAL_ERROR', err.message), 500);
      }
    },
  });

  /**
   * DELETE /api/admin/sessions/:id
   * 删除 session
   */
  routes.push({
    method: 'DELETE',
    pattern: '/api/admin/sessions/:id',
    handler: async function sessionDeleteHandler(_req, res, params) {
      try {
        const result = await sessionAdmin.deleteSession(ctx, params.id);
        if (!result.ok) {
          send(res, error(result.error.code, result.error.message), 404);
          return;
        }
        send(res, success({ warning: result.warning }));
      } catch (err) {
        send(res, error('INTERNAL_ERROR', err.message), 500);
      }
    },
  });

  /**
   * POST /api/admin/sessions/:id/prompt
   * 发送网页 prompt
   */
  routes.push({
    method: 'POST',
    pattern: '/api/admin/sessions/:id/prompt',
    handler: async function sessionPromptHandler(req, res, params) {
      const body = await parseBody(req);
      if (!body || typeof body.text !== 'string') {
        send(res, error('BAD_REQUEST', '请求体需包含 text 字段'), 400);
        return;
      }
      try {
        const result = await sessionAdmin.sendPrompt(ctx, params.id, body.text);
        if (!result.ok) {
          const status = result.error.code === 'NOT_FOUND' ? 404 : 400;
          send(res, error(result.error.code, result.error.message), status);
          return;
        }
        send(res, success({ events: result.events }));
      } catch (err) {
        send(res, error('INTERNAL_ERROR', err.message), 500);
      }
    },
  });

  /**
   * GET /api/admin/sessions/:id/timeline
   * 返回 session 时间线
   */
  routes.push({
    method: 'GET',
    pattern: '/api/admin/sessions/:id/timeline',
    handler: function sessionTimelineHandler(_req, res, params) {
      const timeline = sessionAdmin.getTimeline(ctx, params.id);
      send(res, success({ list: timeline, total: timeline.length }));
    },
  });

  /**
   * GET /api/admin/routes
   * 列出所有 route 绑定和健康状态
   */
  routes.push({
    method: 'GET',
    pattern: '/api/admin/routes',
    handler: function routesListHandler(_req, res) {
      const routeList = routeAdmin.listRoutes(ctx);
      send(res, success({ list: routeList, total: routeList.length }));
    },
  });

  /**
   * POST /api/admin/routes
   * 绑定 route
   */
  routes.push({
    method: 'POST',
    pattern: '/api/admin/routes',
    handler: async function routesBindHandler(req, res) {
      const body = await parseBody(req);
      if (!body || !body.routeKey || !body.sessionId) {
        send(res, error('BAD_REQUEST', '需要 routeKey 和 sessionId'), 400);
        return;
      }
      const result = routeAdmin.bindRoute(ctx, body.routeKey, body.sessionId);
      if (!result.ok) {
        send(res, error(result.error.code, result.error.message), 400);
        return;
      }
      send(res, success(result));
    },
  });

  /**
   * DELETE /api/admin/routes/:encodedRouteKey
   * 解除绑定
   */
  routes.push({
    method: 'DELETE',
    pattern: '/api/admin/routes/:encodedRouteKey',
    handler: function routesUnbindHandler(_req, res, params) {
      const routeKey = decodeURIComponent(params.encodedRouteKey);
      const result = routeAdmin.unbindRoute(ctx, routeKey);
      send(res, success(result));
    },
  });

  /**
   * POST /api/admin/routes/cleanup-dangling
   * 清理悬空 route
   */
  routes.push({
    method: 'POST',
    pattern: '/api/admin/routes/cleanup-dangling',
    handler: async function routesCleanupHandler(req, res) {
      const body = await parseBody(req);
      const result = routeAdmin.cleanupDangling(ctx, body && body.confirm);
      if (!result.ok) {
        send(res, error(result.error.code, result.error.message), 400);
        return;
      }
      send(res, success(result));
    },
  });

  /**
   * GET /api/admin/agents
   * 列出 driver 状态摘要
   */
  routes.push({
    method: 'GET',
    pattern: '/api/admin/agents',
    handler: function agentsListHandler(_req, res) {
      const agents = agentRuntimeAdmin.listAgents(ctx);
      send(res, success({ list: agents, total: agents.length }));
    },
  });

  /**
   * POST /api/admin/agents/:id/check
   * 执行 agent 健康检查
   */
  routes.push({
    method: 'POST',
    pattern: '/api/admin/agents/:id/check',
    handler: async function agentCheckHandler(_req, res, params) {
      try {
        const result = await agentRuntimeAdmin.checkAgent(ctx, params.id);
        if (!result.ok) {
          send(res, error(result.error.code, result.error.message), 404);
          return;
        }
        send(res, success(result));
      } catch (err) {
        send(res, error('INTERNAL_ERROR', err.message), 500);
      }
    },
  });

  /**
   * POST /api/admin/agents/opencode/ensure-ready
   * 确保 OpenCode 服务就绪
   */
  routes.push({
    method: 'POST',
    pattern: '/api/admin/agents/opencode/ensure-ready',
    handler: async function agentEnsureReadyHandler(_req, res) {
      try {
        const result = await agentRuntimeAdmin.ensureReadyAgent(ctx);
        if (!result.ok) {
          send(res, error(result.error.code, result.error.message), 404);
          return;
        }
        send(res, success(result));
      } catch (err) {
        send(res, error('INTERNAL_ERROR', err.message), 500);
      }
    },
  });

  /**
   * GET /api/admin/runtime
   * 返回 runtime 配置和检测摘要
   */
  routes.push({
    method: 'GET',
    pattern: '/api/admin/runtime',
    handler: function runtimeHandler(_req, res) {
      const runtimeInfo = agentRuntimeAdmin.detectRuntime(ctx);
      send(res, success(runtimeInfo));
    },
  });

  /**
   * POST /api/admin/runtime/check
   * 执行 runtime 检测
   */
  routes.push({
    method: 'POST',
    pattern: '/api/admin/runtime/check',
    handler: function runtimeCheckHandler(_req, res) {
      const runtimeInfo = agentRuntimeAdmin.detectRuntime(ctx, {
        checkCwd: checkCwdExists,
        detectWslIp: detectWslIpSync,
      });
      send(res, success(runtimeInfo));
    },
  });

  /**
   * GET /api/admin/config
   * 返回脱敏配置摘要
   */
  routes.push({
    method: 'GET',
    pattern: '/api/admin/config',
    handler: function configHandler(_req, res) {
      const summary = config.buildConfigSummary();
      send(res, success(summary));
    },
  });

  return routes;
}

/**
 * 按指定字段对数组进行分组计数
 * @param {Object[]} items - 待分组数组
 * @param {string} field - 分组字段名
 * @returns {Object} 字段值到计数的映射
 */
function countBy(items, field) {
  const result = {};
  for (const item of items) {
    const key = item[field] || 'unknown';
    result[key] = (result[key] || 0) + 1;
  }
  return result;
}

function checkCwdExists(dirPath) {
  try {
    const fs = require('fs');
    return fs.existsSync(dirPath);
  } catch (_e) {
    return false;
  }
}

/**
 * 同步探测 WSL IP（默认实现，返回空表示未探测）
 * @param {string} _distro - WSL 发行版名称
 * @returns {string} 探测到的 IP 地址
 */
function detectWslIpSync(_distro) {
  return '';
}

module.exports = { createCoreRoutes };
