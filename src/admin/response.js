/**
 * 统一 JSON 响应构建工具
 * 提供成功响应和错误响应的标准格式，符合 spec 4 节 API 设计
 */

/**
 * 构建成功响应对象
 * @param {Object} data - 响应数据内容
 * @returns {{ ok: boolean, data: Object }}
 */
function success(data) {
  return { ok: true, data: data || {} };
}

/**
 * 构建错误响应对象
 * @param {string} code - 错误代码，如 BAD_REQUEST、UNAUTHORIZED
 * @param {string} message - 可读错误信息
 * @returns {{ ok: boolean, error: { code: string, message: string } }}
 */
function error(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * 将响应对象写入 HTTP response 流，自动设置 JSON 头和状态码
 * @param {import('http').ServerResponse} res - Node.js HTTP 响应对象
 * @param {{ ok: boolean }} body - 响应体对象
 * @param {number} [statusCode] - HTTP 状态码，成功默认 200，错误默认由 code 决定
 */
function send(res, body, statusCode) {
  const code = statusCode || (body.ok ? 200 : errorCodeToStatus(body.error && body.error.code));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/**
 * 将错误代码映射为 HTTP 状态码
 * @param {string} errorCode - 错误代码
 * @returns {number}
 */
function errorCodeToStatus(errorCode) {
  const map = {
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    BAD_REQUEST: 400,
    METHOD_NOT_ALLOWED: 405,
    INTERNAL_ERROR: 500,
  };
  return map[errorCode] || 400;
}

module.exports = { success, error, send, errorCodeToStatus, parseQueryString };

/**
 * 解析 URL 查询字符串为键值对象
 * @param {string} qs - 查询字符串
 * @returns {Object} 键值对对象
 */
function parseQueryString(qs) {
  const result = {};
  if (!qs) return result;
  for (const pair of qs.split('&')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx < 0) continue;
    const key = pair.slice(0, eqIdx);
    result[key] = decodeURIComponent(pair.slice(eqIdx + 1));
  }
  return result;
}
