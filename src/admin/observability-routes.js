'use strict';

const { success, error, send, parseQueryString } = require('./response');
const { listEvents } = require('./event-store');
const diagnostics = require('./diagnostics');

const EVENT_LEVELS = new Set(['debug', 'info', 'warn', 'error']);
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

/**
 * 收集观测响应中必须隐藏的已知 Secret。
 * @param {Object} ctx - Admin 应用上下文。
 * @returns {string[]} 非空 Secret 列表。
 */
function collectSecrets(ctx) {
  const envConfig = ctx.envConfig || {};
  return [
    envConfig.feishuAppSecret,
    envConfig.admin && envConfig.admin.token,
    ctx.config && ctx.config.token,
  ].filter((value) => typeof value === 'string' && value);
}

/**
 * 递归脱敏响应对象中的已知 Secret。
 * @param {*} value - 原始响应值。
 * @param {string[]} secrets - 已知 Secret。
 * @returns {*} 脱敏后的值。
 */
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

/**
 * 解析并校验事件查询参数。
 * @param {string} queryString - 原始查询串。
 * @returns {Object} 规范化过滤参数。
 */
function parseEventQuery(queryString) {
  const params = parseQueryString(queryString || '');
  if (params.level && !EVENT_LEVELS.has(params.level)) {
    throw new Error('level 必须为 debug、info、warn 或 error');
  }

  let after;
  if (params.after !== undefined) {
    after = Number(params.after);
    if (!Number.isInteger(after) || after < 0) throw new Error('after 必须为非负毫秒时间戳');
  }

  let limit = DEFAULT_LIMIT;
  if (params.limit !== undefined) {
    limit = Number(params.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new Error(`limit 必须为 1-${MAX_LIMIT} 的整数`);
    }
  }

  return {
    level: params.level || '',
    sessionId: params.sessionId || '',
    routeKey: params.routeKey || '',
    type: params.type || '',
    after,
    limit,
  };
}

/**
 * 根据检查项计算诊断总体状态。
 * @param {Object[]} checks - 结构化检查项。
 * @returns {string} pass、degraded 或 fail。
 */
function getOverallStatus(checks) {
  if (checks.some((check) => check.status === 'fail')) return 'fail';
  if (checks.some((check) => check.status === 'warn')) return 'degraded';
  return 'pass';
}

/**
 * 创建事件查询和诊断导出路由。
 * @param {Object} appContext - Admin 应用上下文。
 * @returns {Array<{method:string, pattern:string, handler:Function}>} 路由列表。
 */
function createObservabilityRoutes(appContext) {
  const ctx = appContext || {};
  const secrets = collectSecrets(ctx);
  return [
    {
      method: 'GET',
      pattern: '/api/admin/events',
      handler(req, res) {
        try {
          const filters = parseEventQuery(req.queryString || '');
          const events = redactValue(listEvents(ctx.eventStore, filters), secrets);
          send(res, success({ events, limit: filters.limit }));
        } catch (err) {
          send(res, error('BAD_REQUEST', err.message), 400);
        }
      },
    },
    {
      method: 'GET',
      pattern: '/api/admin/diagnostics/export',
      async handler(_req, res) {
        const checks = await diagnostics.runHealthCheck(ctx);
        const report = {
          checkedAt: new Date().toISOString(),
          overall: getOverallStatus(checks),
          checks,
        };
        res.writeHead(200, {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Disposition': 'attachment; filename="walker-diagnostics.json"',
        });
        res.end(JSON.stringify(report, null, 2));
      },
    },
  ];
}

module.exports = { createObservabilityRoutes, parseEventQuery, getOverallStatus };
