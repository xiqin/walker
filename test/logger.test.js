'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULT_MAX_BYTES } = require('../src/core/log-rotation');
const { _resetForTests, createLogger, setLogLevel } = require('../src/core/logger');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'walker-logger-'));
}

function withIsolatedLogger(t, options = {}) {
  const cwd = makeTempDir();
  const originalCwd = process.cwd();
  const originalEnv = {
    WALKER_LOG_FILE: process.env.WALKER_LOG_FILE,
    WALKER_LOG_LEVEL: process.env.WALKER_LOG_LEVEL,
  };
  const originalStderrWrite = process.stderr.write;
  const stderrLines = [];

  process.chdir(cwd);
  if (Object.prototype.hasOwnProperty.call(options, 'logFile')) {
    process.env.WALKER_LOG_FILE = options.logFile;
  } else {
    delete process.env.WALKER_LOG_FILE;
  }
  if (Object.prototype.hasOwnProperty.call(options, 'level')) {
    process.env.WALKER_LOG_LEVEL = options.level;
  } else {
    delete process.env.WALKER_LOG_LEVEL;
  }
  process.stderr.write = (chunk, encoding, callback) => {
    stderrLines.push(String(chunk));
    if (typeof encoding === 'function') encoding();
    if (typeof callback === 'function') callback();
    return true;
  };
  _resetForTests();

  t.after(async () => {
    await _resetForTests();
    process.stderr.write = originalStderrWrite;
    if (originalEnv.WALKER_LOG_FILE === undefined) {
      delete process.env.WALKER_LOG_FILE;
    } else {
      process.env.WALKER_LOG_FILE = originalEnv.WALKER_LOG_FILE;
    }
    if (originalEnv.WALKER_LOG_LEVEL === undefined) {
      delete process.env.WALKER_LOG_LEVEL;
    } else {
      process.env.WALKER_LOG_LEVEL = originalEnv.WALKER_LOG_LEVEL;
    }
    process.chdir(originalCwd);
  });

  return { cwd, stderrLines };
}

async function waitForFileWrite() {
  await new Promise((resolve) => setImmediate(resolve));
}

function readLogLines(cwd) {
  const logPath = path.join(cwd, 'logs', 'walker.log');
  return fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
}

test('默认未设置 WALKER_LOG_FILE 时不创建 walker.log', async (t) => {
  const { cwd } = withIsolatedLogger(t);

  createLogger('default-file').info('stderr only');
  await waitForFileWrite();

  assert.equal(fs.existsSync(path.join(cwd, 'logs', 'walker.log')), false);
});

test('WALKER_LOG_FILE=true 时创建并写入结构化 JSON walker.log', async (t) => {
  const { cwd } = withIsolatedLogger(t, { logFile: 'true' });

  createLogger('file-enabled').info('persist me', { answer: 42 });
  await _resetForTests();

  const rows = readLogLines(cwd);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].level, 'info');
  assert.equal(rows[0].scope, 'file-enabled');
  assert.equal(rows[0].message, 'persist me');
  assert.equal(rows[0].answer, 42);
  assert.match(rows[0].ts, /^\d{4}-\d{2}-\d{2}T/);
});

test('WALKER_LOG_FILE=false 时不创建也不追加 walker.log', async (t) => {
  const { cwd } = withIsolatedLogger(t, { logFile: 'false' });
  const logDir = path.join(cwd, 'logs');
  const logPath = path.join(logDir, 'walker.log');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(logPath, 'existing\n');

  createLogger('file-disabled').warn('do not persist');
  await waitForFileWrite();

  assert.equal(fs.readFileSync(logPath, 'utf8'), 'existing\n');
});

test('stderr 仍输出结构化日志且敏感字段脱敏', (t) => {
  const { stderrLines } = withIsolatedLogger(t);

  createLogger('stderr-mask').error('failed safely', {
    token: 'plain-token',
    nested: { password: 'plain-password' },
    err: Object.assign(new Error('boom'), { code: 'EBOOM' }),
  });

  assert.equal(stderrLines.length, 1);
  const row = JSON.parse(stderrLines[0]);
  assert.equal(row.level, 'error');
  assert.equal(row.scope, 'stderr-mask');
  assert.equal(row.message, 'failed safely');
  assert.equal(row.token, '***');
  assert.equal(row.nested.password, '***');
  assert.equal(row.errMessage, 'boom');
  assert.equal(row.errCode, 'EBOOM');
});

test('WALKER_LOG_LEVEL 过滤行为保持不变', async (t) => {
  const { cwd, stderrLines } = withIsolatedLogger(t, { logFile: 'true', level: 'warn' });

  createLogger('level-filter').info('filtered');
  createLogger('level-filter').warn('visible');
  await _resetForTests();

  assert.equal(stderrLines.length, 1);
  assert.equal(JSON.parse(stderrLines[0]).message, 'visible');
  const rows = readLogLines(cwd);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message, 'visible');
  setLogLevel('info');
});

test('WALKER_LOG_FILE=true 时打开写入流前轮转已有大 walker.log', async (t) => {
  const { cwd } = withIsolatedLogger(t, { logFile: 'true' });
  const logDir = path.join(cwd, 'logs');
  const logPath = path.join(logDir, 'walker.log');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(logPath, Buffer.alloc(DEFAULT_MAX_BYTES));

  createLogger('rotate-before-write').info('after rotation');
  await _resetForTests();

  assert.equal(fs.statSync(`${logPath}.1`).size, DEFAULT_MAX_BYTES);
  const rows = readLogLines(cwd);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].message, 'after rotation');
});

test('walker.log 轮转失败不得导致 logger 调用崩溃', async (t) => {
  const { cwd, stderrLines } = withIsolatedLogger(t, { logFile: 'true' });
  const logDir = path.join(cwd, 'logs');
  const logPath = path.join(logDir, 'walker.log');
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(logPath, Buffer.alloc(DEFAULT_MAX_BYTES));
  fs.writeFileSync(`${logPath}.1`, 'blocking-file');
  fs.mkdirSync(`${logPath}.2`, { recursive: true });

  assert.doesNotThrow(() => {
    createLogger('rotate-failure').info('stderr survives');
  });
  await waitForFileWrite();

  assert.equal(stderrLines.length, 1);
  assert.equal(JSON.parse(stderrLines[0]).message, 'stderr survives');
});
