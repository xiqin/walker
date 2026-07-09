function createLogger(scope) {
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
