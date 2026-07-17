/**
 * 创建带作用域标签的结构化日志器
 * @param {string} scope - 日志作用域标识，如模块名
 * @returns {Object} 包含 info/warn/error/debug 方法的日志器对象
 */

const fs = require('fs');
const path = require('path');

const LEVEL_PRIORITY = { error: 0, warn: 1, info: 2, debug: 3 };
let _currentPriority = null;

let _fileStream = null;
let _fileStreamInitFailed = false;

function getFileStream() {
  if (_fileStreamInitFailed) return null;
  if (_fileStream) return _fileStream;
  if ((process.env.WALKER_LOG_FILE || '').toLowerCase() === 'false') {
    _fileStreamInitFailed = true;
    return null;
  }
  try {
    const logDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    _fileStream = fs.createWriteStream(path.join(logDir, 'walker.log'), { flags: 'a' });
    _fileStream.on('error', () => { _fileStreamInitFailed = true; _fileStream = null; });
    process.on('beforeExit', () => { if (_fileStream) { _fileStream.end(); _fileStream = null; } });
  } catch (_) {
    _fileStreamInitFailed = true;
    return null;
  }
  return _fileStream;
}

function getCurrentPriority() {
  if (_currentPriority === null) {
    const level = (process.env.WALKER_LOG_LEVEL || 'info').toLowerCase();
    _currentPriority = LEVEL_PRIORITY[level] != null ? LEVEL_PRIORITY[level] : 2;
  }
  return _currentPriority;
}

function setLogLevel(level) {
  const lower = (level || 'info').toLowerCase();
  _currentPriority = LEVEL_PRIORITY[lower] != null ? LEVEL_PRIORITY[lower] : 2;
}
const SENSITIVE_KEYS = ['token', 'secret', 'password', 'authorization', 'apikey', 'api_key'];

function maskSensitive(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(maskSensitive);
  const result = {};
  for (const key of Object.keys(obj)) {
    const lower = key.toLowerCase();
    if (SENSITIVE_KEYS.some((s) => lower.includes(s))) {
      result[key] = '***';
    } else {
      result[key] = maskSensitive(obj[key]);
    }
  }
  return result;
}

function createLogger(scope) {
  /**
   * 输出一条结构化日志记录
   * @param {string} level - 日志级别（info/warn/error/debug）
   * @param {string} message - 日志消息
   * @param {Object} [extra] - 额外字段，错误级别时自动提取 err 对象的 message 和 stack
   */
  function log(level, message, extra) {
    const priority = LEVEL_PRIORITY[level] != null ? LEVEL_PRIORITY[level] : 2;
    if (priority > getCurrentPriority()) return;
    const row = {
      ts: new Date().toISOString(),
      level,
      scope,
      message,
      ...maskSensitive(extra || {}),
    };
    if (level === 'error' && extra && extra.err) {
      row.errMessage = extra.err.message || '';
      row.errStack = (extra.err.stack || '').slice(0, 500);
      row.errCode = extra.err.code;
      if (extra.err.cause) {
        row.causeMessage = extra.err.cause.message || '';
      }
    }
    try {
      const line = JSON.stringify(row);
      if (typeof process.stderr.write === 'function') {
        process.stderr.write(line + '\n');
      } else {
        console.log(line);
      }
      const stream = getFileStream();
      if (stream) stream.write(line + '\n');
    } catch (_) {
      console.log(JSON.stringify({ ts: row.ts, level: row.level, scope: row.scope, message: row.message, error: 'log serialization failed' }));
    }
  }

  return {
    info: (msg, extra) => log('info', msg, extra),
    warn: (msg, extra) => log('warn', msg, extra),
    error: (msg, extra) => log('error', msg, extra),
    debug: (msg, extra) => log('debug', msg, extra),
  };
}

module.exports = { createLogger, setLogLevel };
