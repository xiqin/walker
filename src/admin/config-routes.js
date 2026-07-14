'use strict';

const { success, error, send } = require('./response');
const { parseBody } = require('./auth');
const { buildConfigSummary } = require('./config');
const { updateDotEnv } = require('./config-editor');
const { recordEvent } = require('./event-store');

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
      const summary = buildConfigSummary();
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
      const body = await parseBody(req);
      if (!body || typeof body !== 'object') {
        send(res, error('BAD_REQUEST', '请求体需为 JSON 对象'), 400);
        return;
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
        }));
      } catch (err) {
        send(res, error('BAD_REQUEST', err.message), 400);
      }
    },
  });

  return routes;
}

module.exports = { createConfigRoutes };
