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
  }];
}

module.exports = { createStatusRoutes };
