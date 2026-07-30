'use strict';

const fs = require('node:fs');

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVES = 5;

function toErrorResult(reason, error) {
  return {
    ok: false,
    rotated: false,
    reason,
    error: {
      message: error && error.message ? error.message : String(error),
      code: error && error.code,
    },
  };
}

function rotateLogFile(filePath, options = {}) {
  const fsImpl = options.fs || fs;
  const maxBytes = options.maxBytes || DEFAULT_MAX_BYTES;
  const maxArchives = options.maxArchives || DEFAULT_MAX_ARCHIVES;

  let stat;
  try {
    stat = fsImpl.statSync(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return { ok: true, rotated: false, reason: 'not-found' };
    }
    return toErrorResult('stat-failed', err);
  }

  if (!stat || stat.size < maxBytes) {
    return { ok: true, rotated: false, reason: 'below-threshold' };
  }

  try {
    const oldestArchive = `${filePath}.${maxArchives}`;
    if (fsImpl.existsSync(oldestArchive)) {
      fsImpl.unlinkSync(oldestArchive);
    }
  } catch (err) {
    return toErrorResult('unlink-failed', err);
  }

  for (let index = maxArchives - 1; index >= 1; index -= 1) {
    const from = `${filePath}.${index}`;
    const to = `${filePath}.${index + 1}`;
    try {
      if (fsImpl.existsSync(from)) {
        fsImpl.renameSync(from, to);
      }
    } catch (err) {
      return toErrorResult('rename-failed', err);
    }
  }

  try {
    fsImpl.renameSync(filePath, `${filePath}.1`);
  } catch (err) {
    return toErrorResult('rename-failed', err);
  }

  return { ok: true, rotated: true, reason: 'rotated' };
}

module.exports = {
  DEFAULT_MAX_ARCHIVES,
  DEFAULT_MAX_BYTES,
  rotateLogFile,
};
