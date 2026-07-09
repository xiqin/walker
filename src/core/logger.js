/**
 * 创建带作用域标签的结构化日志器
 * @param {string} scope - 日志作用域标识，如模块名
 * @returns {Object} 包含 info/warn/error/debug 方法的日志器对象
 */
function createLogger(scope) {
  /**
   * 输出一条结构化日志记录
   * @param {string} level - 日志级别（info/warn/error/debug）
   * @param {string} message - 日志消息
   * @param {Object} [extra] - 额外字段，错误级别时自动提取 err 对象的 message 和 stack
   */
  function log(level, message, extra) {
    const row = {
      ts: new Date().toISOString(),
      level,
      scope,
      message,
      ...(extra || {}),
    };
    if (level === 'error' && extra && extra.err) {
      row.errMessage = extra.err.message || '';
      row.errStack = (extra.err.stack || '').slice(0, 500);
      if (extra.err.cause) {
        row.causeMessage = extra.err.cause.message || '';
      }
    }
    console.log(JSON.stringify(row));
  }

  return {
    info: (msg, extra) => log('info', msg, extra),
    warn: (msg, extra) => log('warn', msg, extra),
    error: (msg, extra) => log('error', msg, extra),
    debug: (msg, extra) => log('debug', msg, extra),
  };
}

module.exports = { createLogger };
