'use strict';

/**
 * 核心 API 路由注册
 * 导出 createCoreRoutes(appContext) 返回路由数组供集成组装
 * 覆盖 overview、sessions、routes、agents、runtime 等兼容 API
 */

const { success, error, send } = require('./response');
const { parseBody } = require('./auth');
const { listEvents, getMetrics } = require('./event-store');

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
  const secrets = collectSecrets(ctx);

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

      send(res, success(redactValue(data, secrets)));
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
      send(res, success(redactValue({ list: sessions, total: sessions.length }, secrets)));
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
        send(res, success(redactValue(session, secrets)));
      } catch (err) {
        send(res, error('INTERNAL_ERROR', err.message), 500);
      }
    },
  });

  /**
   * GET /api/admin/sessions/search
   * 按关键词/agent/状态/标签搜索 session，支持分页
   * 必须在 :id 参数路由之前注册，避免被 /sessions/:id 截获
   */
  routes.push({
    method: 'GET',
    pattern: '/api/admin/sessions/search',
    handler: function sessionSearchHandler(req, res) {
      const parsed = require('url').parse(req.url, true);
      const q = parsed.query || {};
      const result = sessionAdmin.searchSessions(ctx, {
        query: q.query || '',
        agent: q.agent || '',
        status: q.status || '',
        tag: q.tag || '',
        limit: q.limit ? parseInt(q.limit, 10) : undefined,
        offset: q.offset ? parseInt(q.offset, 10) : undefined,
      });
      send(res, success(redactValue(result, secrets)));
    },
  });

  /**
   * PATCH /api/admin/sessions/:id/tags
   * 更新 session 标签
   */
  routes.push({
    method: 'PATCH',
    pattern: '/api/admin/sessions/:id/tags',
    handler: async function sessionTagsHandler(req, res, params) {
      const body = await parseBody(req);
      if (!body || !Array.isArray(body.tags)) {
        send(res, error('BAD_REQUEST', '请求体需包含 tags 数组'), 400);
        return;
      }
      const result = sessionAdmin.updateSessionTags(ctx, params.id, body.tags);
      if (!result.ok) {
        const status = result.error.code === 'NOT_FOUND' ? 404 : 400;
        send(res, error(result.error.code, result.error.message), status);
        return;
      }
      send(res, success(redactValue(result.session, secrets)));
    },
  });

  /**
   * POST /api/admin/sessions/batch-stop
   * 批量停止 session
   */
  routes.push({
    method: 'POST',
    pattern: '/api/admin/sessions/batch-stop',
    handler: async function sessionBatchStopHandler(req, res) {
      const body = await parseBody(req);
      if (!body || !Array.isArray(body.sessionIds) || body.sessionIds.length === 0) {
        send(res, error('BAD_REQUEST', '请求体需包含 sessionIds 数组'), 400);
        return;
      }
      const result = await sessionAdmin.batchStopSessions(ctx, body.sessionIds);
      if (!result.ok) {
        send(res, error(result.error.code, result.error.message), 400);
        return;
      }
      send(res, success(redactValue(result, secrets)));
    },
  });

  /**
   * POST /api/admin/sessions/batch-delete
   * 批量删除 session
   */
  routes.push({
    method: 'POST',
    pattern: '/api/admin/sessions/batch-delete',
    handler: async function sessionBatchDeleteHandler(req, res) {
      const body = await parseBody(req);
      if (!body || !Array.isArray(body.sessionIds) || body.sessionIds.length === 0) {
        send(res, error('BAD_REQUEST', '请求体需包含 sessionIds 数组'), 400);
        return;
      }
      const result = await sessionAdmin.batchDeleteSessions(ctx, body.sessionIds);
      if (!result.ok) {
        send(res, error(result.error.code, result.error.message), 400);
        return;
      }
      send(res, success(redactValue(result, secrets)));
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
      send(res, success(redactValue(session, secrets)));
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
        send(res, success(redactValue({ session: result.session, warning: result.warning }, secrets)));
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
        send(res, success(redactValue({ warning: result.warning }, secrets)));
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
        send(res, success(redactValue({ events: result.events }, secrets)));
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
      send(res, success(redactValue({ list: timeline, total: timeline.length }, secrets)));
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
      send(res, success(redactValue({ list: routeList, total: routeList.length }, secrets)));
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
        checkWslCwd: checkWslCwdExists,
        detectWslIp: detectWslIpSync,
      });
      send(res, success(runtimeInfo));
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

function collectSecrets(ctx) {
  const envConfig = ctx.envConfig || {};
  const env = ctx.env || {};
  return [
    envConfig.feishuAppSecret,
    envConfig.admin && envConfig.admin.token,
    env.FEISHU_APP_SECRET,
    env.WALKER_ADMIN_TOKEN,
    ctx.config && ctx.config.token,
  ].filter((value) => typeof value === 'string' && value);
}

function redactValue(value, secrets) {
  if (typeof value === 'string') {
    let result = value;
    for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)]));
  }
  return value;
}

function checkCwdExists(dirPath) {
  try {
    const fs = require('fs');
    return fs.existsSync(dirPath);
  } catch (_e) {
    return false;
  }
}

function checkWslCwdExists(dirPath, distro) {
  if (process.platform !== 'win32') return false;
  try {
    const { execFileSync } = require('child_process');
    execFileSync('wsl.exe', ['-d', distro || 'Ubuntu-24.04', '--', 'test', '-d', dirPath], { stdio: 'ignore', timeout: 3000 });
    return true;
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
