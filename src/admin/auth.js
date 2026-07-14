/**
 * Admin 鉴权模块
 * 支持 Bearer token 和 cookie walker_admin_token 两种方式验证身份
 * 提供 /api/admin/auth/status 和 /api/admin/auth/login 接口辅助
 */

const crypto = require('crypto');

const SESSION_ID_BYTES = 32;
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const activeSessions = new Map();

function generateSessionId() {
  return crypto.randomBytes(SESSION_ID_BYTES).toString('hex');
}

function pruneExpiredSessions() {
  const now = Date.now();
  for (const [sid, entry] of activeSessions) {
    if (now - entry.createdAt > SESSION_TTL_MS) activeSessions.delete(sid);
  }
}

/** parseBody 最大请求体大小（1MB） */
const MAX_BODY_SIZE = 1024 * 1024;

/**
 * 恒定时间比较两个字符串是否相等，防止时序攻击
 * @param {string} a - 字符串 a
 * @param {string} b - 字符串 b
 * @returns {boolean}
 */
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 从请求中提取 token：优先 Authorization Bearer 头，其次 cookie
 * @param {import('http').IncomingMessage} req - HTTP 请求
 * @returns {string} 提取到的 token 或空串
 */
function extractToken(req) {
  const authHeader = (req.headers && req.headers.authorization) || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }

  const cookieHeader = (req.headers && req.headers.cookie) || '';
  const sidMatch = cookieHeader.match(/walker_admin_sid=([^;]+)/);
  if (sidMatch) return sidMatch[1].trim();
  const legacyMatch = cookieHeader.match(/walker_admin_token=([^;]+)/);
  if (legacyMatch) return legacyMatch[1].trim();

  return '';
}

/**
 * 验证请求携带的 token 是否与管理端配置的 token 匹配
 * 未配置 token 时视为免鉴权（本地绑定场景）
 * @param {import('http').IncomingMessage} req - HTTP 请求
 * @param {{ token: string }} config - 管理端配置中的 admin 部分
 * @returns {boolean}
 */
function isAuthenticated(req, config) {
  if (!config.token) return true;
  const token = extractToken(req);

  pruneExpiredSessions();
  if (activeSessions.has(token)) return true;

  return safeEqual(token, config.token);
}

/**
 * 创建鉴权中间件包装器：检查 token 后决定是否放行到实际 handler
 * 返回的函数可作为路由 handler 直接注册到 router
 * @param {{ token: string }} config - 管理端配置
 * @param {Object} response - response 模块（send、error）
 * @returns {Function} 包装函数 (handler) => wrappedHandler
 */
function createAuthGuard(config, response) {
  /**
   * 包装一个路由 handler，要求请求先通过鉴权
   * @param {Function} handler - 鉴权通过后执行的原始路由处理器 (req, res, params) => void
   * @returns {Function} 包装后的路由处理器，签名与原始 handler 一致
   */
  return function wrap(handler) {
    /**
     * 鉴权包装后的路由处理器
     * @param {import('http').IncomingMessage} req - HTTP 请求
     * @param {import('http').ServerResponse} res - HTTP 响应
     * @param {Object} params - 路由参数
     */
    return function guardedHandler(req, res, params) {
      if (!isAuthenticated(req, config)) {
        response.send(res, response.error('UNAUTHORIZED', '需要有效的管理端 token'), 401);
        return;
      }
      handler(req, res, params);
    };
  };
}

/**
 * 解析请求体 JSON 数据，限制最大 1MB 防止 DoS
 * @param {import('http').IncomingMessage} req - HTTP 请求
 * @param {Function} callback - 回调函数 (body) => void
 */
function parseBody(req, callback) {
  const chunks = [];
  let totalSize = 0;
  let aborted = false;

  req.on('data', (chunk) => {
    if (aborted) return;
    totalSize += chunk.length;
    if (totalSize > MAX_BODY_SIZE) {
      aborted = true;
      callback(null);
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (aborted) return;
    try {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : {};
      callback(body);
    } catch (_e) {
      callback(null);
    }
  });
  req.on('error', () => {
    if (aborted) return;
    aborted = true;
    callback(null);
  });
}

/**
 * 创建鉴权相关路由处理器（status 和 login）
 * @param {{ token: string }} config - 管理端配置
 * @param {Object} response - response 模块
 * @returns {{ statusHandler: Function, loginHandler: Function }}
 */
function createAuthHandlers(config, response) {
  /**
   * 处理 GET /api/admin/auth/status：返回是否已认证和是否需要 token
   * @param {import('http').IncomingMessage} req - HTTP 请求
   * @param {import('http').ServerResponse} res - HTTP 响应
   */
  function statusHandler(req, res) {
    const authenticated = isAuthenticated(req, config);
    response.send(res, response.success({
      authenticated,
      tokenRequired: Boolean(config.token),
    }));
  }

  /**
   * 处理 POST /api/admin/auth/login：校验 token 后设置 cookie
   * @param {import('http').IncomingMessage} req - HTTP 请求
   * @param {import('http').ServerResponse} res - HTTP 响应
   */
  function loginHandler(req, res) {
    if (!config.token) {
      response.send(res, response.error('BAD_REQUEST', '管理端未配置 token，无需登录'));
      return;
    }

    parseBody(req, (body) => {
      if (!body || typeof body.token !== 'string') {
        response.send(res, response.error('BAD_REQUEST', '请求体需包含 token 字段'), 400);
        return;
      }

      if (!safeEqual(body.token, config.token)) {
        response.send(res, response.error('UNAUTHORIZED', 'token 不正确'), 401);
        return;
      }

      pruneExpiredSessions();
      const sessionId = generateSessionId();
      activeSessions.set(sessionId, { createdAt: Date.now() });

      const isHttps = req.connection && req.connection.encrypted;
      const cookieFlags = 'Path=/; HttpOnly; SameSite=Strict' + (isHttps ? '; Secure' : '');
      res.setHeader('Set-Cookie', 'walker_admin_sid=' + sessionId + '; ' + cookieFlags);
      response.send(res, response.success({ authenticated: true }));
    });
  }

  return { statusHandler, loginHandler };
}

module.exports = { extractToken, isAuthenticated, createAuthGuard, parseBody, createAuthHandlers };
