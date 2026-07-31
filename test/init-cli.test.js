'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');

const initCommand = require('../src/cli/init-command');
const { main } = require('../src/index');
const { safeWriteJson } = require('../src/cli/safe-write');

function createOutputCapture() {
  const stdout = [];
  const stderr = [];
  return {
    output: {
      write(line) { stdout.push(line); },
      error(line) { stderr.push(line); },
    },
    text() { return stdout.concat(stderr).join('\n'); },
  };
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'walker-init-'));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('init 首次创建数据目录、JSON 资源、附件目录、日志目录和配置模板', async () => {
  const dataDir = path.join(tempDir(), 'data');
  const capture = createOutputCapture();
  const calls = [];

  const code = await initCommand.run([], {
    env: { WALKER_DATA_DIR: dataDir, WALKER_ADMIN_TOKEN: 'admin-token-from-env', OPENCODE_CONFIG_DIR: path.join(dataDir, 'opencode') },
    output: capture.output,
    installHookPlugin(options) {
      calls.push(options);
      return { installed: true, path: path.join(dataDir, 'opencode', 'walker-tui-plugin.js') };
    },
  });

  assert.equal(code, 0);
  assert.ok(fs.statSync(path.join(dataDir, 'attachments')).isDirectory());
  assert.ok(fs.statSync(path.join(dataDir, 'logs')).isDirectory());
  assert.deepEqual(readJson(path.join(dataDir, 'state.json')), { version: 1, routes: {}, sessions: {} });
  assert.deepEqual(readJson(path.join(dataDir, 'dedup.json')), { version: 1, messages: {} });
  const config = readJson(path.join(dataDir, 'config.json'));
  assert.equal(config.admin.tokenEnv, 'WALKER_ADMIN_TOKEN');
  assert.equal(config.admin.host, '127.0.0.1');
  assert.ok(!JSON.stringify(config).includes('admin-token-from-env'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].walkerToken, 'admin-token-from-env');
  assert.match(capture.text(), /OpenCode TUI plugin\s+installed/);
});

test('init 重复执行不覆盖已有 config 和 state', async () => {
  const dataDir = tempDir();
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({ version: 99, custom: true }) + '\n');
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ version: 2, customConfig: 'keep' }) + '\n');
  fs.writeFileSync(path.join(dataDir, 'dedup.json'), JSON.stringify({ seen: ['m1'] }) + '\n');

  const first = await initCommand.run([], { env: { WALKER_DATA_DIR: dataDir, WALKER_ADMIN_TOKEN: 'token' }, output: createOutputCapture().output, installPlugin: false });
  const second = await initCommand.run([], { env: { WALKER_DATA_DIR: dataDir, WALKER_ADMIN_TOKEN: 'token' }, output: createOutputCapture().output, installPlugin: false });

  assert.equal(first, 0);
  assert.equal(second, 0);
  assert.deepEqual(readJson(path.join(dataDir, 'state.json')), { version: 99, custom: true });
  assert.deepEqual(readJson(path.join(dataDir, 'config.json')), { version: 2, customConfig: 'keep' });
  assert.deepEqual(readJson(path.join(dataDir, 'dedup.json')), { seen: ['m1'] });
});

test('init 输出不泄露完整 token，生成 token 也只显示脱敏值', async () => {
  const dataDir = tempDir();
  const capture = createOutputCapture();
  const secret = 'secret-token-that-must-not-appear';

  const code = await initCommand.run([], {
    env: { WALKER_DATA_DIR: dataDir },
    output: capture.output,
    crypto: { randomBytes() { return Buffer.from(secret); } },
    installPlugin: false,
  });

  assert.equal(code, 0);
  assert.doesNotMatch(capture.text(), new RegExp(secret));
  assert.match(capture.text(), /c2Vj\.\.\.ZWFy/);
});

test('safeWriteJson 写入失败会清理临时文件且不留下损坏 JSON', () => {
  const dataDir = tempDir();
  const target = path.join(dataDir, 'state.json');
  const failingFs = Object.assign({}, fs, {
    linkSync() { throw new Error('link failed'); },
  });

  assert.throws(() => safeWriteJson(target, { ok: true }, { fs: failingFs, path }), /Failed to safely write JSON/);
  assert.equal(fs.existsSync(target), false);
  assert.deepEqual(fs.readdirSync(dataDir), []);
});

test('safeWriteJson overwrite=false 时并发创建目标不会被覆盖', () => {
  const dataDir = tempDir();
  const target = path.join(dataDir, 'state.json');
  const concurrent = { keep: true };
  const raceFs = Object.assign({}, fs, {
    linkSync(tempPath, filePath) {
      fs.writeFileSync(filePath, JSON.stringify(concurrent, null, 2) + '\n');
      const err = new Error('file exists');
      err.code = 'EEXIST';
      throw err;
    },
  });

  const result = safeWriteJson(target, { ok: true }, { fs: raceFs, path });

  assert.deepEqual(result, { written: false, reason: 'exists', path: target });
  assert.deepEqual(readJson(target), concurrent);
  assert.deepEqual(fs.readdirSync(dataDir), ['state.json']);
});

test('init 可重建缺失目录，但损坏 config 不会被静默覆盖', async () => {
  const dataDir = tempDir();
  fs.mkdirSync(path.join(dataDir, 'attachments'));
  fs.writeFileSync(path.join(dataDir, 'config.json'), '{ broken json');
  const capture = createOutputCapture();

  const code = await initCommand.run([], {
    env: { WALKER_DATA_DIR: dataDir, WALKER_ADMIN_TOKEN: 'token' },
    output: capture.output,
    installPlugin: false,
  });

  assert.equal(code, 1);
  assert.ok(fs.statSync(path.join(dataDir, 'logs')).isDirectory());
  assert.equal(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'), '{ broken json');
  assert.match(capture.text(), /Refusing to overwrite invalid JSON/);
});

test('init 不修改 shell profile、系统服务或第三方平台密钥', async () => {
  const dataDir = tempDir();
  const shellProfile = path.join(dataDir, '.bashrc');
  const serviceFile = path.join(dataDir, 'walker.service');
  fs.writeFileSync(shellProfile, 'original profile\n');
  fs.writeFileSync(serviceFile, 'original service\n');

  const code = await initCommand.run([], {
    env: { WALKER_DATA_DIR: dataDir, WALKER_ADMIN_TOKEN: 'token', FEISHU_APP_SECRET: 'platform-secret' },
    output: createOutputCapture().output,
    installPlugin: false,
  });

  assert.equal(code, 0);
  assert.equal(fs.readFileSync(shellProfile, 'utf8'), 'original profile\n');
  assert.equal(fs.readFileSync(serviceFile, 'utf8'), 'original service\n');
  assert.ok(!JSON.stringify(readJson(path.join(dataDir, 'config.json'))).includes('platform-secret'));
});

test('init 文件系统异常被捕获并返回明确错误，兼容入口不删除既有命令', async () => {
  const capture = createOutputCapture();
  const throwingFs = Object.assign({}, fs, {
    mkdirSync() { throw new Error('permission denied'); },
  });

  const code = await initCommand.run([], {
    fs: throwingFs,
    env: { WALKER_DATA_DIR: path.join(tempDir(), 'data') },
    output: capture.output,
    installPlugin: false,
  });

  assert.equal(code, 1);
  assert.match(capture.text(), /walker init failed: permission denied/);
  assert.equal(typeof initCommand.run, 'function');
  assert.equal(typeof initCommand.resolveDataDir, 'function');
});

test('真实 CLI 入口 walker init 调度 init-command 并创建资源且输出脱敏', async () => {
  const dataDir = path.join(tempDir(), 'data');
  const capture = createOutputCapture();
  const exits = [];
  const secret = 'entry-token-that-must-not-leak';

  await main(['init'], {
    env: { WALKER_DATA_DIR: dataDir, WALKER_ADMIN_TOKEN: secret },
    output: capture.output,
    exit(code) { exits.push(code); },
    installPlugin: false,
  });

  assert.deepEqual(exits, [0]);
  assert.ok(fs.statSync(path.join(dataDir, 'attachments')).isDirectory());
  assert.ok(fs.statSync(path.join(dataDir, 'logs')).isDirectory());
  assert.deepEqual(readJson(path.join(dataDir, 'state.json')), { version: 1, routes: {}, sessions: {} });
  assert.deepEqual(readJson(path.join(dataDir, 'dedup.json')), { version: 1, messages: {} });
  const config = readJson(path.join(dataDir, 'config.json'));
  assert.equal(config.admin.tokenEnv, 'WALKER_ADMIN_TOKEN');
  assert.equal(config.admin.host, '127.0.0.1');
  assert.ok(!JSON.stringify(config).includes(secret));
  assert.match(capture.text(), /Walker init complete/);
  assert.match(capture.text(), /entr\.\.\.leak/);
  assert.doesNotMatch(capture.text(), new RegExp(secret));
  assert.doesNotMatch(capture.text(), /planned but not implemented|preview/i);
});
