'use strict';

const fs = require('fs');
const path = require('path');

function fileExists(targetFs, filePath) {
  try {
    targetFs.accessSync(filePath);
    return true;
  } catch (_) {
    return false;
  }
}

function assertExistingJsonReadable(filePath, options) {
  const opts = options || {};
  const targetFs = opts.fs || fs;
  if (!fileExists(targetFs, filePath)) return;
  try {
    JSON.parse(targetFs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    throw new Error('Refusing to overwrite invalid JSON at ' + filePath + ': ' + err.message);
  }
}

function safeWriteJson(filePath, value, options) {
  const opts = options || {};
  const targetFs = opts.fs || fs;
  const targetPath = opts.path || path;
  const overwrite = opts.overwrite === true;
  const dir = targetPath.dirname(filePath);
  const base = targetPath.basename(filePath);
  const tempPath = targetPath.join(dir, '.' + base + '.tmp-' + process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2));

  if (!overwrite && fileExists(targetFs, filePath)) {
    assertExistingJsonReadable(filePath, { fs: targetFs });
    return { written: false, reason: 'exists', path: filePath };
  }

  const json = JSON.stringify(value, null, 2) + '\n';
  try {
    targetFs.mkdirSync(dir, { recursive: true });
    targetFs.writeFileSync(tempPath, json, 'utf8');
    JSON.parse(targetFs.readFileSync(tempPath, 'utf8'));
    if (overwrite) {
      targetFs.renameSync(tempPath, filePath);
    } else {
      try {
        targetFs.linkSync(tempPath, filePath);
      } catch (err) {
        if (err && err.code === 'EEXIST') {
          assertExistingJsonReadable(filePath, { fs: targetFs });
          try { targetFs.unlinkSync(tempPath); } catch (_) {}
          return { written: false, reason: 'exists', path: filePath };
        }
        throw err;
      }
      targetFs.unlinkSync(tempPath);
    }
    return { written: true, path: filePath };
  } catch (err) {
    try {
      if (fileExists(targetFs, tempPath)) targetFs.unlinkSync(tempPath);
    } catch (_) {
      // Best-effort cleanup only; preserve the original write error.
    }
    throw new Error('Failed to safely write JSON at ' + filePath + ': ' + err.message);
  }
}

module.exports = { safeWriteJson, assertExistingJsonReadable };
