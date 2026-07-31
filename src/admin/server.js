/**
 * Admin HTTP 服务主模块
 * 管理 AdminServer 的生命周期：启动、关闭、请求分发
 * adminEnabled=false 时不监听端口，返回禁用状态
 */

const http = require('http');
const url = require('url');

const { createRouter, isAdminApiPath } = require('./router');
const { success, error, send } = require('./response');
const { createAuthGuard, createAuthHandlers, getSessionStore } = require('./auth');
const { handleStatic } = require('./static');
const { createLogger } = require('../core/logger');
const { createEventBus } = require('../events/event-bus');
const { createEventsWebSocketHandler } = require('./ws-events');

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
  const eventBus = opts.eventBus || createEventBus({
    onListenerError(entry) {
      logger.error('event bus listener failed', { err: entry.err });
    },
  });
  const responseModule = { success, error, send };
  const sessionStore = getSessionStore(adminConfig);
  const authHandlers = createAuthHandlers(adminConfig, responseModule);
  const authGuard = createAuthGuard(adminConfig, responseModule);
  const detachEventStorePublisher = attachEventStorePublisher(opts.eventStore, eventBus);
  const wsEvents = createEventsWebSocketHandler({
    config: adminConfig,
    sessionStore,
    eventStore: opts.eventStore,
    eventBus,
  });

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
    try {
      const parsed = url.parse(req.url, false);
      const pathname = parsed.pathname || '/';
      const method = req.method || 'GET';

      req.urlPath = pathname;
      req.queryString = parsed.query || '';

      if (isAdminApiPath(pathname)) {
        const matched = router.match(method, pathname);
        if (matched) {
          req.params = matched.params;
          const result = matched.handler(req, res, matched.params);
          if (result && typeof result.then === 'function') {
            result.catch((err) => sendRequestError(res, err));
          }
          return;
        }

        send(res, error('NOT_FOUND', 'API 路径未找到'), 404);
        return;
      }

      if (publicDir) {
        const result = handleStatic(req, res, publicDir, responseModule);
        if (result && typeof result.then === 'function') {
          result.catch((err) => sendRequestError(res, err));
        }
        return;
      }

      send(res, error('NOT_FOUND', '未找到'), 404);
    } catch (err) {
      sendRequestError(res, err);
    }
  }

  function sendRequestError(res, err) {
    if (res.writableEnded || res.headersSent) {
      logger.error('admin request failed after response started', { err });
      return;
    }
    if (err && err.name === 'URIError') {
      send(res, error('BAD_REQUEST', '请求路径编码无效'), 400);
      return;
    }
    logger.error('admin request failed', { err });
    send(res, error('INTERNAL_ERROR', 'Admin 请求处理失败'), 500);
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

      httpServer.on('upgrade', (req, socket, head) => {
        const handled = wsEvents.handleUpgrade(req, socket, head);
        if (!handled) socket.destroy();
      });

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
      detachEventStorePublisher();
      return Promise.resolve({ ok: true });
    }

    return new Promise((resolve) => {
      let settled = false;
      wsEvents.close();
      const done = (result) => {
        if (settled) return;
        settled = true;
        detachEventStorePublisher();
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

  return { start, stop, server, getStatus, router, eventBus, wsEvents };
}

function attachEventStorePublisher(eventStore, eventBus) {
  if (!eventStore || !eventStore.events || !eventBus || typeof eventBus.publish !== 'function') return () => false;
  const events = eventStore.events;
  let publisher = events.__walkerEventBusPublisher;

  if (!publisher) {
    publisher = {
      originalPush: events.push.bind(events),
      buses: new Map(),
    };
    Object.defineProperty(events, '__walkerEventBusPublisher', { value: publisher, enumerable: false });
    events.push = function pushAndPublish(...items) {
      const result = publisher.originalPush(...items);
      const buses = Array.from(publisher.buses.keys());
      for (const item of items) {
        for (const bus of buses) bus.publish(item);
      }
      return result;
    };
  }

  publisher.buses.set(eventBus, (publisher.buses.get(eventBus) || 0) + 1);
  let detached = false;
  return function detachEventStorePublisher() {
    if (detached) return false;
    detached = true;
    const count = publisher.buses.get(eventBus) || 0;
    if (count <= 1) publisher.buses.delete(eventBus);
    else publisher.buses.set(eventBus, count - 1);
    return true;
  };
}

module.exports = { createAdminServer };
