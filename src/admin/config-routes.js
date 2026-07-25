'use strict';

const { success, error, send } = require('./response');
const { parseBody } = require('./auth');
const { buildConfigSummary } = require('./config');
const { updateDotEnv } = require('./config-editor');
const { recordEvent } = require('./event-store');
const fs = require('fs');
const path = require('path');

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * 创建配置管理路由列表
 * GET /api/admin/config 返回脱敏配置摘要
 * PATCH /api/admin/config 调用 updateDotEnv 写入 allowlist 字段并返回 restartRequired
 * @param {Object} appContext - 应用上下文
 * @param {string} [appContext.envPath] - .env 文件路径
 * @param {Object} [appContext.eventStore] - 事件存储实例
 * @returns {Array<{ method: string, pattern: string, handler: Function }>} 路由数组
 */
function createConfigRoutes(appContext) {
  const ctx = appContext || {};
  const routes = [];

  /**
   * GET /api/admin/config
   * 返回脱敏配置摘要，含当前值、可编辑键和敏感键列表
   */
  routes.push({
    method: 'GET',
    pattern: '/api/admin/config',
    handler: function configGetHandler(_req, res) {
      const summary = buildConfigSummary(ctx.env || process.env);
      send(res, success(summary));
    },
  });

  /**
   * PATCH /api/admin/config
   * 更新 .env 文件中 allowlist 内字段，返回 restartRequired 标记
   */
  routes.push({
    method: 'PATCH',
    pattern: '/api/admin/config',
    handler: async function configPatchHandler(req, res) {
      let body;
      try {
        body = await parseBody(req);
      } catch (err) {
        if (err.code === 'PAYLOAD_TOO_LARGE') {
          send(res, error('PAYLOAD_TOO_LARGE', err.message), 413);
          return;
        }
        send(res, error('BAD_REQUEST', '无效请求体'), 400);
        return;
      }
      if (!body || typeof body !== 'object') {
        send(res, error('BAD_REQUEST', '请求体需为 JSON 对象'), 400);
        return;
      }

      if (body.WALKER_ADMIN_HOST && !isLoopbackHost(body.WALKER_ADMIN_HOST)) {
        const currentToken = (ctx.env || process.env).WALKER_ADMIN_TOKEN || '';
        if (!currentToken) {
          send(res, error('BAD_REQUEST', '将 WALKER_ADMIN_HOST 设为非 loopback 地址时必须先配置 WALKER_ADMIN_TOKEN'), 400);
          return;
        }
      }

      const envPath = ctx.envPath || require('path').join(process.cwd(), '.env');

      try {
        const result = updateDotEnv(envPath, body);

        recordEvent(ctx.eventStore, {
          type: 'config.update',
          message: '配置已更新，需要重启',
          data: { updatedKeys: result.updatedKeys },
        });

        send(res, success({
          restartRequired: result.restartRequired,
          updatedKeys: result.updatedKeys,
          effectiveValues: result.effectiveValues,
          source: 'env-file',
        }));
      } catch (err) {
        send(res, error('BAD_REQUEST', err.message), 400);
      }
    },
  });

  /**
   * POST /api/admin/config/reload
   * 热更新配置：重新加载 .env 文件并更新 process.env
   */
  routes.push({
    method: 'POST',
    pattern: '/api/admin/config/reload',
    handler: async function configReloadHandler(_req, res) {
      const envPath = ctx.envPath || path.join(process.cwd(), '.env');

      try {
        if (!fs.existsSync(envPath)) {
          send(res, error('NOT_FOUND', '.env 文件不存在'), 404);
          return;
        }

        const envContent = fs.readFileSync(envPath, 'utf8');
        const envVars = {};
        const lines = envContent.split('\n');

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;

          const eqIndex = trimmed.indexOf('=');
          if (eqIndex === -1) continue;

          const key = trimmed.slice(0, eqIndex).trim();
          let value = trimmed.slice(eqIndex + 1).trim();

          if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
          }

          envVars[key] = value;
        }

        const updatedKeys = [];
        for (const [key, value] of Object.entries(envVars)) {
          if (process.env[key] !== value) {
            process.env[key] = value;
            updatedKeys.push(key);
          }
        }

        recordEvent(ctx.eventStore, {
          type: 'config.reload',
          message: '配置已热更新',
          data: { updatedKeys, envPath },
        });

        send(res, success({
          reloaded: true,
          updatedKeys,
          envPath,
        }));
      } catch (err) {
        send(res, error('INTERNAL_ERROR', `配置热更新失败：${err.message}`), 500);
      }
    },
  });

  return routes;
}

module.exports = { createConfigRoutes };
