'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
  const originalHomedir = os.homedir;
  const originalKill = process.kill;
  const originalSetTimeout = global.setTimeout;
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const originalWalkerDataDir = process.env.WALKER_DATA_DIR;
  const daemonPath = require.resolve('../src/cli/daemon');
  const envPath = require.resolve('../src/config/env');
  const originalEnvModule = require.cache[envPath];

  delete require.cache[daemonPath];
  require.cache[envPath] = {
    id: envPath,
    filename: envPath,
    loaded: true,
    exports: {
      loadDotEnv: () => {
        events.push({ type: 'loadDotEnv' });
        if (Object.hasOwn(options, 'dotEnvWalkerDataDir') && !process.env.WALKER_DATA_DIR) {
          process.env.WALKER_DATA_DIR = options.dotEnvWalkerDataDir;
        }
      },
    },
  };
  if (Object.hasOwn(options, 'walkerDataDir')) {
    process.env.WALKER_DATA_DIR = options.walkerDataDir;
  } else {
    delete process.env.WALKER_DATA_DIR;
  }
  os.homedir = () => options.homeDir || path.join('C:', 'Users', 'walker-test');

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

  const missingPaths = new Set(options.missingPaths || []);

  fs.existsSync = (filePath) => {
    events.push({ type: 'exists', filePath });
    if (missingPaths.has(filePath)) return false;
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
    os.homedir = originalHomedir;
    process.kill = originalKill;
    global.setTimeout = originalSetTimeout;
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    if (originalWalkerDataDir === undefined) {
      delete process.env.WALKER_DATA_DIR;
    } else {
      process.env.WALKER_DATA_DIR = originalWalkerDataDir;
    }
    delete require.cache[daemonPath];
    if (originalEnvModule) {
      require.cache[envPath] = originalEnvModule;
    } else {
      delete require.cache[envPath];
    }
  });

  return { daemon, events };
}

test('daemon 默认把 pid 和后台日志放到用户 .walker 数据目录', (t) => {
  const homeDir = path.join('D:', 'Users', 'alice');
  const { daemon } = loadDaemonWithMocks(t, { homeDir });
  const expectedDataDir = path.join(homeDir, '.walker');

  assert.equal(daemon.DATA_DIR, expectedDataDir);
  assert.equal(daemon.PID_FILE, path.join(expectedDataDir, 'walker.pid'));
  assert.equal(daemon.OUT_LOG, path.join(expectedDataDir, 'logs', 'walker.out.log'));
  assert.equal(daemon.ERR_LOG, path.join(expectedDataDir, 'logs', 'walker.err.log'));
});

test('daemon 使用 WALKER_DATA_DIR 作为后台运行态根目录并支持 ~ 展开', (t) => {
  const homeDir = path.join('D:', 'Users', 'alice');
  const { daemon } = loadDaemonWithMocks(t, { homeDir, walkerDataDir: '~\\walker-data' });
  const expectedDataDir = path.join(homeDir, 'walker-data');

  assert.equal(daemon.DATA_DIR, expectedDataDir);
  assert.equal(daemon.PID_FILE, path.join(expectedDataDir, 'walker.pid'));
  assert.equal(daemon.OUT_LOG, path.join(expectedDataDir, 'logs', 'walker.out.log'));
  assert.equal(daemon.ERR_LOG, path.join(expectedDataDir, 'logs', 'walker.err.log'));
});

test('daemon 初始化路径前加载 .env 中的 WALKER_DATA_DIR', (t) => {
  const homeDir = path.join('D:', 'Users', 'alice');
  const { daemon, events } = loadDaemonWithMocks(t, { homeDir, dotEnvWalkerDataDir: '~\\walker-data' });
  const expectedDataDir = path.join(homeDir, 'walker-data');

  assert.equal(events[0].type, 'loadDotEnv');
  assert.equal(daemon.DATA_DIR, expectedDataDir);
  assert.equal(daemon.PID_FILE, path.join(expectedDataDir, 'walker.pid'));
});

test('daemon 后台运行态路径不再使用包安装目录', (t) => {
  const { daemon } = loadDaemonWithMocks(t, { homeDir: path.join('D:', 'Users', 'alice') });
  const projectRoot = path.resolve(__dirname, '..');

  assert.equal(daemon.PID_FILE.startsWith(projectRoot), false);
  assert.equal(daemon.OUT_LOG.startsWith(projectRoot), false);
  assert.equal(daemon.ERR_LOG.startsWith(projectRoot), false);
});

test('daemon start 先创建数据目录下 logs 目录再打开后台日志', async (t) => {
  const { daemon, events } = loadDaemonWithMocks(t, {
    homeDir: path.join('D:', 'Users', 'alice'),
    missingPaths: [path.join(path.join('D:', 'Users', 'alice'), '.walker', 'logs')],
  });

  const code = await daemon.start();

  assert.equal(code, 0);
  const mkdirIndex = events.findIndex((event) => event.type === 'mkdir' && event.filePath === path.join(daemon.DATA_DIR, 'logs'));
  const outOpenIndex = events.findIndex((event) => event.type === 'open' && event.filePath === daemon.OUT_LOG);
  const errOpenIndex = events.findIndex((event) => event.type === 'open' && event.filePath === daemon.ERR_LOG);
  assert.notEqual(mkdirIndex, -1);
  assert.notEqual(outOpenIndex, -1);
  assert.notEqual(errOpenIndex, -1);
  assert.ok(mkdirIndex < outOpenIndex);
  assert.ok(mkdirIndex < errOpenIndex);
});

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
