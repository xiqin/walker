/**
 * 轻量路由匹配器
 * 支持 method + path 精确匹配和 :id 参数提取
 * API 路径前缀 /api/admin/
 */

/**
 * 将路由模式字符串编译为正则表达式和参数名列表
 * @param {string} pattern - 路由模式，如 /api/admin/sessions/:id
 * @returns {{ re: RegExp, names: string[] }}
 */
function compilePattern(pattern) {
  const names = [];
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reStr = escaped.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, (_match, name) => {
    names.push(name);
    return '([^/]+)';
  });
  return { re: new RegExp(`^${reStr}$`), names };
}

/**
 * 创建路由器实例
 * @returns {{ add: Function, match: Function, routes: Array }}
 */
function createRouter() {
  const routes = [];

  /**
   * 注册一条路由规则
   * @param {string} method - HTTP 方法，如 GET、POST
   * @param {string} pattern - 路由模式，支持 :id 参数
   * @param {Function} handler - 路由处理函数 (req, res, params) => void
   */
  function add(method, pattern, handler) {
    const compiled = compilePattern(pattern);
    routes.push({ method: method.toUpperCase(), pattern, compiled, handler });
  }

  /**
   * 匹配请求到已注册路由，返回匹配结果
   * @param {string} method - HTTP 方法
   * @param {string} pathname - 请求路径
   * @returns {{ handler: Function, params: Object } | null}
   */
  function match(method, pathname) {
    const upper = method.toUpperCase();
    for (const route of routes) {
      if (route.method !== upper) continue;
      const m = pathname.match(route.compiled.re);
      if (m) {
        const params = {};
        for (let i = 0; i < route.compiled.names.length; i += 1) {
          params[route.compiled.names[i]] = decodeURIComponent(m[i + 1]);
        }
        return { handler: route.handler, params };
      }
    }
    return null;
  }

  return { add, match, routes };
}

/**
 * 判断路径是否为管理端 API 路径
 * @param {string} pathname - 请求路径
 * @returns {boolean}
 */
function isAdminApiPath(pathname) {
  return pathname.startsWith('/api/admin/');
}

module.exports = { createRouter, compilePattern, isAdminApiPath };
