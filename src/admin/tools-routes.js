'use strict';

/**
 * 调试工具、卡片预览、指标与服务控制路由
 * 导出 tools/cards/metrics/service routes：
 * - GET /api/admin/tools/command-simulate
 * - GET /api/admin/tools/cards
 * - POST /api/admin/tools/cards/preview
 * - GET /api/admin/metrics（复用 T1 event store）
 * - POST /api/admin/service/stop（注入 stopApp/exitProcess）
 * REQ-020, REQ-021, REQ-023, REQ-024, REQ-026
 */

const { success, error, send, parseQueryString } = require('./response');
const { parseBody } = require('./auth');
const { getMetrics } = require('./event-store');
const { simulateCommand } = require('./command-simulator');
const { listCardTypes, getSampleData, previewCard } = require('./card-preview');
const { handleServiceStop } = require('./service-control');

/**
 * 创建调试工具与指标路由列表
 * @param {Object} appContext - 应用上下文
 * @param {Object} appContext.eventStore - 事件存储实例
 * @param {Object} [deps] - 注入依赖（用于测试）
 * @param {Function} [deps.stopApp] - 停止应用的函数
 * @param {Function} [deps.exitProcess] - 退出进程的函数
 * @returns {Array<{ method: string, pattern: string, handler: Function }>} 路由数组
 */
function createToolsRoutes(appContext, deps) {
  const ctx = appContext || {};
  const injectedDeps = deps || {};
  const routes = [];

  /**
   * GET /api/admin/tools/command-simulate
   * 模拟命令解析：输入文本 → 解析结果 → 动作摘要
   * 查询参数：text（必填）、routeKey（可选）、dryRun（可选，默认 true）
   */
  routes.push({
    method: 'GET',
    pattern: '/api/admin/tools/command-simulate',
    handler: function commandSimulateHandler(req, res) {
      const qs = req.queryString || '';
      const params = parseQueryString(qs);
      const text = params.text;

      if (!text) {
        send(res, error('BAD_REQUEST', '需要 text 查询参数'), 400);
        return;
      }

      const options = {
        routeKey: params.routeKey || '',
        dryRun: params.dryRun === 'false' ? false : true,
      };

      const result = simulateCommand(text, options);
      send(res, success(result));
    },
  });

  /**
   * GET /api/admin/tools/cards
   * 返回支持的卡片类型列表（名称和描述）
   */
  routes.push({
    method: 'GET',
    pattern: '/api/admin/tools/cards',
    handler: function cardsListHandler(_req, res) {
      const types = listCardTypes();
      send(res, success({ types: types, total: types.length }));
    },
  });

  /**
   * POST /api/admin/tools/cards/preview
   * 渲染指定卡片类型的预览
   * 请求体：{ type: string, data?: Object }
   */
  routes.push({
    method: 'POST',
    pattern: '/api/admin/tools/cards/preview',
    handler: async function cardsPreviewHandler(req, res) {
      const body = await parseBody(req);
      if (!body || !body.type) {
        send(res, error('BAD_REQUEST', '请求体需包含 type 字段'), 400);
        return;
      }

      const result = previewCard(body.type, body.data);
      if (!result) {
        send(res, error('NOT_FOUND', '未知的卡片类型：' + body.type), 404);
        return;
      }

      send(res, success(result));
    },
  });

  /**
   * GET /api/admin/metrics
   * 返回事件指标汇总（复用 T1 event store）
   */
  routes.push({
    method: 'GET',
    pattern: '/api/admin/metrics',
    handler: function metricsHandler(_req, res) {
      const metrics = getMetrics(ctx.eventStore);
      send(res, success(metrics));
    },
  });

  /**
   * POST /api/admin/service/stop
   * 服务停止请求，必须 confirm=true
   */
  routes.push({
    method: 'POST',
    pattern: '/api/admin/service/stop',
    handler: function serviceStopHandler(req, res) {
      handleServiceStop(req, res, ctx, {
        stopApp: injectedDeps.stopApp,
        exitProcess: injectedDeps.exitProcess,
        response: { success: success, error: error, send: send },
        recordEventFn: require('./event-store').recordEvent,
        parseBodyFn: parseBody,
      });
    },
  });

  return routes;
}

module.exports = { createToolsRoutes };
