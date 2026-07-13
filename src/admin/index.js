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
  const ctx = appContext || {};
  const injected = deps || {};

  /** 组装所有子模块路由到路由数组 */
  const allRoutes = [
    ...createCoreRoutes(ctx),
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
        const handler = authGuard(route.handler);
        router.add(route.method, route.pattern, handler);
      }
    },
    publicDir,
    eventStore: ctx.eventStore,
  });

  return adminServer;
}

module.exports = { createAdminServerFromContext };
