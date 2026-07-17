/**
 * Admin HTTP 服务主模块
 * 管理 AdminServer 的生命周期：启动、关闭、请求分发
 * adminEnabled=false 时不监听端口，返回禁用状态
 */

const http = require('http');
const url = require('url');

const { createRouter, isAdminApiPath } = require('./router');
const { success, error, send } = require('./response');
const { createAuthGuard, createAuthHandlers } = require('./auth');
const { handleStatic } = require('./static');
const { createLogger } = require('../core/logger');

const logger = createLogger('admin-server');

/**
 * 创建 AdminServer 实例
 * @param {Object} options - 配置选项
 * @param {{ enabled: boolean, host: string, port: number, token: string }} options.config - 管理端配置
 * @param {Object} [options.routes] - 额外路由注册回调 (router, authGuard) => void
 * @param {string} [options.publicDir] - 静态文件目录路径
 * @param {Object} [options.eventStore] - 事件存储实例（来自 T1）
 * @param {Function} [options.now] - 时间函数，默认 Date.now
 * @param {Function} [options.serverFactory] - 自定义 http.Server 创建工厂，用于测试注入
 * @returns {{ start: Function, stop: Function, server: Object|null, getStatus: Function }}
 */
function createAdminServer(options) {
  const opts = options || {};
  const config = opts.config || {};
  const adminConfig = {
    enabled: config.enabled !== false,
    host: config.host || '127.0.0.1',
    port: config.port != null ? config.port : 8787,
    token: config.token || '',
  };

  const router = createRouter();
  const publicDir = opts.publicDir || '';
  const serverFactory = opts.serverFactory;

  const responseModule = { success, error, send };
  const authHandlers = createAuthHandlers(adminConfig, responseModule);
  const authGuard = createAuthGuard(adminConfig, responseModule);

  router.add('GET', '/api/admin/auth/status', authHandlers.statusHandler);
  router.add('POST', '/api/admin/auth/login', authHandlers.loginHandler);

  if (opts.routes) {
    opts.routes(router, authGuard);
  }

  let server = null;
  let started = false;

  /**
   * 处理 HTTP 请求：解析 URL -> API 路由匹配 -> 鉴权 -> 静态 fallback
   * @param {import('http').IncomingMessage} req - HTTP 请求
   * @param {import('http').ServerResponse} res - HTTP 响应
   */
  function handleRequest(req, res) {
    const parsed = url.parse(req.url, false);
    const pathname = parsed.pathname || '/';
    const method = req.method || 'GET';

    req.urlPath = pathname;
    req.queryString = parsed.query || '';

    if (isAdminApiPath(pathname)) {
      const matched = router.match(method, pathname);
      if (matched) {
        req.params = matched.params;
        matched.handler(req, res, matched.params);
        return;
      }

      send(res, error('NOT_FOUND', 'API 路径未找到'), 404);
      return;
    }

    if (publicDir) {
      handleStatic(req, res, publicDir, responseModule);
      return;
    }

    send(res, error('NOT_FOUND', '未找到'), 404);
  }

  /**
   * 启动 Admin HTTP 服务
   * adminEnabled=false 时跳过监听，返回禁用状态
   * @returns {Promise<{ ok: boolean, disabled?: boolean, host?: string, port?: number }>}
   */
  function start() {
    if (!adminConfig.enabled) {
      started = true;
      return Promise.resolve({ ok: true, disabled: true });
    }

    return new Promise((resolve, reject) => {
      const httpServer = serverFactory ? serverFactory(handleRequest) : http.createServer(handleRequest);

      httpServer.on('error', (err) => {
        if (server) {
          logger.error('admin server runtime error', { err });
          return;
        }
        reject(err);
      });

      httpServer.listen(adminConfig.port, adminConfig.host, () => {
        server = httpServer;
        started = true;
        const addr = httpServer.address();
        resolve({
          ok: true,
          host: addr.address || adminConfig.host,
          port: addr.port || adminConfig.port,
        });
      });
    });
  }

  /**
   * 关闭 Admin HTTP 服务
   * @returns {Promise<{ ok: boolean }>}
  */
  function stop() {
    if (!server) {
      started = false;
      return Promise.resolve({ ok: true });
    }

    return new Promise((resolve) => {
      let settled = false;
      const done = (result) => {
        if (settled) return;
        settled = true;
        server = null;
        started = false;
        resolve(result);
      };
      server.close(() => done({ ok: true }));
      setTimeout(() => {
        if (server) {
          try { server.closeAllConnections && server.closeAllConnections(); } catch (_) {}
        }
        done({ ok: true, forced: true });
      }, 5000);
    });
  }

  /**
   * 获取服务当前状态信息
   * @returns {{ started: boolean, disabled: boolean, host: string, port: number }}
   */
  function getStatus() {
    if (!adminConfig.enabled) {
      return { started: started, disabled: true, host: adminConfig.host, port: adminConfig.port };
    }
    if (server) {
      const addr = server.address();
      return { started: true, disabled: false, host: addr.address, port: addr.port };
    }
    return { started: false, disabled: false, host: adminConfig.host, port: adminConfig.port };
  }

  return { start, stop, server, getStatus, router };
}

module.exports = { createAdminServer };
