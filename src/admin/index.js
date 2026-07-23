'use strict';

/**
 * Admin 模块集成入口
 * 组合所有子模块路由，创建完整的 AdminServer 实例
 * @module admin/index
 */

const path = require('path');
const { createAdminServer } = require('./server');
const { createCoreRoutes } = require('./core-routes');
const { createConfigRoutes } = require('./config-routes');
const { createMaintenanceRoutes } = require('./maintenance-routes');
const { createToolsRoutes } = require('./tools-routes');
const { createStatusAdmin } = require('./status-admin');
const { createStatusRoutes } = require('./status-routes');
const { createRouteRoutes } = require('./route-routes');
const { createTuiRuntimeRoutes } = require('./tui-runtime-routes');
const { createObservabilityRoutes } = require('./observability-routes');

/**
 * 创建完整的 AdminServer，组装所有路由并注入应用上下文
 * @param {Object} appContext - 应用上下文，由 bootstrap.js 提供
 * @param {Object} appContext.sessionService - SessionService 实例
 * @param {Object} appContext.registry - DriverRegistry 实例
 * @param {Object} appContext.eventStore - 事件存储实例
 * @param {Object} [appContext.envConfig] - 环境配置对象（来自 loadEnvConfig）
 * @param {Object} [appContext.feishuSummary] - 飞书连接摘要
 * @param {string} [appContext.dataDir] - 数据目录绝对路径
 * @param {string} [appContext.version] - Walker 版本号
 * @param {number} [appContext.startTime] - 进程启动时间戳
 * @param {Object} [appContext.runtime] - Runtime 实例
 * @param {Object} [appContext.attachmentService] - AttachmentService 实例
 * @param {Object} [appContext.config] - 管理端配置 { enabled, host, port, token }
 * @param {Object} [deps] - 依赖注入（用于测试替换）
 * @param {Function} [deps.stopApp] - 停止 Walker 应用的函数
 * @param {Function} [deps.exitProcess] - 退出进程的函数
 * @param {Function} [deps.createServer] - 替换 createAdminServer 的工厂函数
 * @param {Array} [appContext.hookReceiverRoutes] - 额外的 hook receiver 路由数组
 * @returns {Object} AdminServer 实例 { start, stop, server, getStatus, router }
 */
function createAdminServerFromContext(appContext, deps) {
  const ctx = { ...(appContext || {}) };
  const injected = deps || {};
  const secrets = collectSecrets(ctx);
  ctx.feishu = ctx.feishu || ctx.platform;
  ctx.statusAdmin = ctx.statusAdmin || createStatusAdmin(ctx);

  /** 组装所有子模块路由到路由数组 */
  const allRoutes = [
    ...createCoreRoutes(ctx),
    ...createStatusRoutes(ctx),
    ...createRouteRoutes(ctx),
    ...createTuiRuntimeRoutes(ctx),
    ...createObservabilityRoutes(ctx),
    ...createConfigRoutes(ctx),
    ...createMaintenanceRoutes(ctx),
    ...createToolsRoutes(ctx, {
      stopApp: injected.stopApp,
      exitProcess: injected.exitProcess,
    }),
    ...(Array.isArray(ctx.hookReceiverRoutes) ? ctx.hookReceiverRoutes : []),
  ];

  /** 静态文件目录指向 admin/public */
  const publicDir = path.join(__dirname, 'public');

  const serverFactory = injected.createServer || createAdminServer;

  const adminServer = serverFactory({
    config: ctx.config || { enabled: true, host: '127.0.0.1', port: 8787, token: '' },
    routes: function registerRoutes(router, authGuard) {
      for (const route of allRoutes) {
        const handler = authGuard(redactResponse(route.handler, secrets));
        router.add(route.method, route.pattern, handler);
      }
    },
    publicDir,
    eventStore: ctx.eventStore,
  });
  ctx.adminServer = adminServer;

  return adminServer;
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

function redactResponse(handler, secrets) {
  if (secrets.length === 0) return handler;
  return function redactingHandler(req, res, params) {
    const originalEnd = res.end.bind(res);
    const originalSetHeader = res.setHeader && res.setHeader.bind(res);
    const originalWriteHead = res.writeHead.bind(res);
    let pendingWriteHead = null;
    if (originalSetHeader) {
      res.setHeader = function setRedactedHeader(name, value) {
        return originalSetHeader(name, redactHeader(name, value, secrets));
      };
    }
    res.writeHead = function writeRedactedHead(statusCode, statusMessage, headers) {
      let message = statusMessage;
      let responseHeaders = headers;
      if (statusMessage && typeof statusMessage === 'object') {
        responseHeaders = statusMessage;
        message = undefined;
      }
      pendingWriteHead = {
        statusCode,
        statusMessage: message,
        headers: responseHeaders ? redactHeaders(responseHeaders, secrets) : undefined,
      };
      return res;
    };
    res.end = function endRedactedBody(body, encoding, callback) {
      const contentType = getResponseHeader(res, pendingWriteHead && pendingWriteHead.headers, 'content-type');
      const redacted = redactBody(body, contentType, secrets);
      setFinalContentLength(res, pendingWriteHead, redacted.body, encoding);
      if (pendingWriteHead) flushWriteHead(pendingWriteHead, originalWriteHead);
      else originalWriteHead(res.statusCode);
      return originalEnd(redacted.body, encoding, callback);
    };
    return handler(req, res, params);
  };
}

function flushWriteHead(pending, originalWriteHead) {
  if (!pending) return;
  if (pending.statusMessage === undefined) originalWriteHead(pending.statusCode, pending.headers);
  else originalWriteHead(pending.statusCode, pending.statusMessage, pending.headers);
}

function getResponseHeader(res, headers, targetName) {
  if (headers) {
    const entry = Object.entries(headers).find(([name]) => name.toLowerCase() === targetName);
    if (entry) return entry[1];
  }
  return typeof res.getHeader === 'function' ? res.getHeader(targetName) : undefined;
}

function setFinalContentLength(res, pending, body, encoding) {
  const length = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body || '', encoding);
  if (pending && pending.headers) {
    for (const name of Object.keys(pending.headers)) {
      if (name.toLowerCase() === 'content-length') delete pending.headers[name];
    }
    pending.headers['Content-Length'] = length;
    return;
  }
  res.setHeader('Content-Length', length);
}

function redactHeaders(headers, secrets) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, redactHeader(name, value, secrets)]));
}

function redactHeader(name, value, secrets) {
  const normalized = String(name).toLowerCase();
  if (normalized === 'location' || normalized === 'content-disposition' || normalized.startsWith('x-')) {
    return redactValue(value, secrets);
  }
  return value;
}

function redactBody(body, contentType, secrets) {
  if (!isTextContentType(contentType)) return { body, changed: false };
  const isJson = isJsonContentType(contentType);
  if (Buffer.isBuffer(body)) {
    const text = body.toString('utf8');
    const redacted = isJson ? redactJson(text, secrets) : redactValue(text, secrets);
    return redacted === text
      ? { body, changed: false }
      : { body: Buffer.from(redacted, 'utf8'), changed: true };
  }
  if (typeof body === 'string') {
    const redacted = isJson ? redactJson(body, secrets) : redactValue(body, secrets);
    return { body: redacted, changed: redacted !== body };
  }
  return { body, changed: false };
}

function isJsonContentType(contentType) {
  const mime = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  return mime === 'application/json' || mime.endsWith('+json');
}

function isTextContentType(contentType) {
  const mime = String(contentType || '').split(';', 1)[0].trim().toLowerCase();
  return isJsonContentType(mime) || mime.startsWith('text/');
}

function redactJson(body, secrets) {
  try {
    return JSON.stringify(redactJsonValue(JSON.parse(body), secrets));
  } catch (_) {
    return redactValue(body, secrets);
  }
}

function redactJsonValue(value, secrets) {
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactJsonValue(item, secrets)]));
  }
  if (typeof value === 'string') return redactString(value, secrets);
  return value;
}

function redactValue(value, secrets) {
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
  if (typeof value !== 'string') return value;
  return redactString(value, secrets);
}

function redactString(value, secrets) {
  let result = value;
  for (const secret of secrets) {
    if (result === secret) return '[REDACTED]';
    const escaped = escapeRegExp(secret);
    const pattern = secret.length >= 8
      ? new RegExp(escaped, 'g')
      : new RegExp('(?<![A-Za-z0-9_])' + escaped + '(?![A-Za-z0-9_])', 'g');
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { createAdminServerFromContext };
