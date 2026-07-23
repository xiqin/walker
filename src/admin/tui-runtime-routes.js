'use strict';

const { success, error, send } = require('./response');

const SENSITIVE_KEY = /token|secret|authorization|cookie|api[-_]?key|password/i;

/**
 * 创建 TUI Runtime 列表和详情路由。
 * @param {Object} ctx - 包含 tuiBridge 的应用上下文。
 * @returns {Array<Object>} 路由定义。
 */
function createTuiRuntimeRoutes(ctx) {
  const context = ctx || {};
  return [
    {
      method: 'GET',
      pattern: '/api/admin/tui-runtimes',
      handler: function tuiRuntimeListHandler(_req, res) {
        const list = context.tuiBridge && typeof context.tuiBridge.getRuntimeSnapshots === 'function'
          ? context.tuiBridge.getRuntimeSnapshots() : [];
        const safeList = sanitize(list);
        send(res, success({ list: safeList, total: safeList.length }));
      },
    },
    {
      method: 'GET',
      pattern: '/api/admin/tui-runtimes/:runtimeId',
      handler: function tuiRuntimeDetailHandler(_req, res, params) {
        const runtime = context.tuiBridge && typeof context.tuiBridge.getRuntimeSnapshot === 'function'
          ? context.tuiBridge.getRuntimeSnapshot(params.runtimeId) : null;
        if (!runtime) {
          send(res, error('NOT_FOUND', 'TUI runtime not found'), 404);
          return;
        }
        send(res, success(sanitize(runtime)));
      },
    },
  ];
}

/**
 * 递归复制响应并删除敏感键。
 * @param {*} value - 原始响应值。
 * @returns {*} 安全副本。
 */
function sanitize(value) {
  if (Array.isArray(value)) return value.map(sanitize);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) continue;
    result[key] = sanitize(child);
  }
  return result;
}

module.exports = { createTuiRuntimeRoutes };
