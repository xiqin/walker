'use strict';

const { success, send } = require('./response');

/**
 * 创建实时状态查询路由。
 * @param {Object} ctx - 包含 statusAdmin 的应用上下文。
 * @returns {Array<Object>} 路由定义。
 */
function createStatusRoutes(ctx) {
  const context = ctx || {};
  return [{
    method: 'GET',
    pattern: '/api/admin/status',
    handler: async function statusHandler(_req, res) {
      const data = await context.statusAdmin.getStatus();
      send(res, success(data));
    },
  },
  {
    method: 'POST',
    pattern: '/api/admin/feishu/check',
    handler: async function feishuCheckHandler(_req, res) {
      try {
        const data = await context.statusAdmin.getStatus();
        send(res, success({ feishu: data.feishu || { status: 'unknown', reason: 'feishu status unavailable' } }));
      } catch (err) {
        send(res, success({ feishu: { status: 'failed', reason: err.message || String(err) } }));
      }
    },
  }];
}

module.exports = { createStatusRoutes };
