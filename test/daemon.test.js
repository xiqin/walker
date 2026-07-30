'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const childProcess = require('node:child_process');

const { DEFAULT_MAX_BYTES } = require('../src/core/log-rotation');

function loadDaemonWithMocks(t, options = {}) {
  const events = [];
  const originalFs = {
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    openSync: fs.openSync,
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    statSync: fs.statSync,
    unlinkSync: fs.unlinkSync,
    renameSync: fs.renameSync,
  };
  const originalSpawn = childProcess.spawn;
  const originalKill = process.kill;
  const originalSetTimeout = global.setTimeout;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const daemonPath = require.resolve('../src/cli/daemon');

  delete require.cache[daemonPath];

  childProcess.spawn = (command, args, spawnOptions) => {
    events.push({ type: 'spawn', command, args, options: spawnOptions });
    return { pid: 4321, unref: () => events.push({ type: 'unref' }) };
  };
  process.kill = () => true;
  global.setTimeout = (fn) => {
    fn();
    return 1;
  };
  console.log = () => {};
  console.error = () => {};

  const daemon = require('../src/cli/daemon');
  const sizes = {};
  if (options.sizes) {
    if (Object.hasOwn(options.sizes, 'walkerOut')) sizes[daemon.OUT_LOG] = options.sizes.walkerOut;
    if (Object.hasOwn(options.sizes, 'walkerErr')) sizes[daemon.ERR_LOG] = options.sizes.walkerErr;
  }
  const existingArchives = new Set(options.existingArchives || []);
  const renameErrorFrom = options.failRenameFor === 'out'
    ? daemon.OUT_LOG
    : options.failRenameFor === 'err'
      ? daemon.ERR_LOG
      : options.renameErrorFrom;

  fs.existsSync = (filePath) => {
    events.push({ type: 'exists', filePath });
    if (filePath === daemon.PID_FILE) return false;
    if (/\.log\.[1-5]$/.test(filePath)) {
      return existingArchives.has(filePath);
    }
    if (filePath === daemon.OUT_LOG || filePath === daemon.ERR_LOG) return Object.hasOwn(sizes, filePath);
    return true;
  };
  fs.mkdirSync = (filePath, mkdirOptions) => events.push({ type: 'mkdir', filePath, options: mkdirOptions });
  fs.openSync = (filePath, flags) => {
    events.push({ type: 'open', filePath, flags });
    return filePath === daemon.OUT_LOG ? 101 : 102;
  };
  fs.writeFileSync = (filePath, data, encoding) => events.push({ type: 'write', filePath, data: String(data), encoding });
  fs.readFileSync = (filePath, encoding) => {
    events.push({ type: 'read', filePath, encoding });
    return '';
  };
  fs.statSync = (filePath) => {
    events.push({ type: 'stat', filePath });
    if (options.statErrorPath === filePath) {
      const error = new Error('stat failed');
      error.code = 'EACCES';
      throw error;
    }
    if (!Object.hasOwn(sizes, filePath)) {
      const error = new Error('not found');
      error.code = 'ENOENT';
      throw error;
    }
    return { size: sizes[filePath] };
  };
  fs.unlinkSync = (filePath) => events.push({ type: 'unlink', filePath });
  fs.renameSync = (from, to) => {
    events.push({ type: 'rename', from, to });
    if (renameErrorFrom === from) throw new Error('rename failed');
  };

  t.after(() => {
    Object.assign(fs, originalFs);
    childProcess.spawn = originalSpawn;
    process.kill = originalKill;
    global.setTimeout = originalSetTimeout;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    delete require.cache[daemonPath];
  });

  return { daemon, events };
}

test('daemon start 启动前轮转 stdout 日志并以追加模式打开当前文件', async (t) => {
  const { daemon, events } = loadDaemonWithMocks(t, {
    sizes: {
      walkerOut: DEFAULT_MAX_BYTES,
      walkerErr: DEFAULT_MAX_BYTES - 1,
    },
  });

  const code = await daemon.start();

  assert.equal(code, 0);
  const renameIndex = events.findIndex((event) => event.type === 'rename' && event.from === daemon.OUT_LOG && event.to === `${daemon.OUT_LOG}.1`);
  const openIndex = events.findIndex((event) => event.type === 'open' && event.filePath === daemon.OUT_LOG && event.flags === 'a');
  assert.notEqual(renameIndex, -1);
  assert.notEqual(openIndex, -1);
  assert.ok(renameIndex < openIndex);
});

test('daemon start 启动前轮转 stderr 日志并以追加模式打开当前文件', async (t) => {
  const { daemon, events } = loadDaemonWithMocks(t, {
    sizes: {
      walkerOut: DEFAULT_MAX_BYTES - 1,
      walkerErr: DEFAULT_MAX_BYTES,
    },
  });

  const code = await daemon.start();

  assert.equal(code, 0);
  const renameIndex = events.findIndex((event) => event.type === 'rename' && event.from === daemon.ERR_LOG && event.to === `${daemon.ERR_LOG}.1`);
  const openIndex = events.findIndex((event) => event.type === 'open' && event.filePath === daemon.ERR_LOG && event.flags === 'a');
  assert.notEqual(renameIndex, -1);
  assert.notEqual(openIndex, -1);
  assert.ok(renameIndex < openIndex);
});

test('daemon start 低于阈值时不归档 stdout 或 stderr 日志', async (t) => {
  const { daemon, events } = loadDaemonWithMocks(t, {
    sizes: {
      walkerOut: DEFAULT_MAX_BYTES - 1,
      walkerErr: DEFAULT_MAX_BYTES - 1,
    },
  });

  const code = await daemon.start();

  assert.equal(code, 0);
  assert.equal(events.some((event) => event.type === 'rename'), false);
  assert.equal(events.some((event) => event.type === 'open' && event.filePath === daemon.OUT_LOG && event.flags === 'a'), true);
  assert.equal(events.some((event) => event.type === 'open' && event.filePath === daemon.ERR_LOG && event.flags === 'a'), true);
});

test('daemon start 轮转失败时仍继续打开日志并尝试启动进程', async (t) => {
  const { daemon, events } = loadDaemonWithMocks(t, {
    sizes: {
      walkerOut: DEFAULT_MAX_BYTES,
      walkerErr: DEFAULT_MAX_BYTES - 1,
    },
    failRenameFor: 'out',
  });

  const code = await daemon.start();

  assert.equal(code, 0);
  assert.equal(events.some((event) => event.type === 'open' && event.filePath === daemon.OUT_LOG && event.flags === 'a'), true);
  assert.equal(events.some((event) => event.type === 'open' && event.filePath === daemon.ERR_LOG && event.flags === 'a'), true);
  assert.equal(events.some((event) => event.type === 'spawn'), true);
});
