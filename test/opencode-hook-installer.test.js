const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { installHookPlugin } = require('../src/opencode-hook/installer');
const { getPluginSource } = require('../src/opencode-hook/plugin-template');

function createTempConfigDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-hook-cfg-'));
  const pluginsDir = path.join(tmpDir, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  return { tmpDir, pluginsDir };
}

test('installHookPlugin 写入新 plugin 文件', () => {
  const { tmpDir, pluginsDir } = createTempConfigDir();
  const targetPath = path.join(pluginsDir, 'walker-hook.js');

  const result = installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });

  assert.equal(result.installed, true);
  assert.equal(result.path, targetPath);
  assert.ok(fs.existsSync(targetPath));

  const content = fs.readFileSync(targetPath, 'utf8');
  assert.ok(content.length > 0);
  assert.ok(content.includes('session.created'));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('已存在 plugin 不覆盖', () => {
  const { tmpDir, pluginsDir } = createTempConfigDir();
  const targetPath = path.join(pluginsDir, 'walker-hook.js');

  fs.writeFileSync(targetPath, '// existing user plugin\n', 'utf8');

  const result = installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: true });

  assert.equal(result.installed, false);
  assert.equal(result.reason, 'already_exists');
  assert.equal(fs.readFileSync(targetPath, 'utf8'), '// existing user plugin\n');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('enabled=false 时不安装', () => {
  const { tmpDir, pluginsDir } = createTempConfigDir();
  const targetPath = path.join(pluginsDir, 'walker-hook.js');

  const result = installHookPlugin({ opencodeConfigDir: tmpDir, walkerPort: 8787, enabled: false });

  assert.equal(result.installed, false);
  assert.equal(result.reason, 'disabled');
  assert.ok(!fs.existsSync(targetPath));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('未传入 opencodeConfigDir 时使用默认 ~/.config/opencode 路径', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-home-'));
  const origHomedir = os.homedir;
  os.homedir = () => tmpHome;

  try {
    const expectedDir = path.join(tmpHome, '.config', 'opencode', 'plugins');
    const expectedPath = path.join(expectedDir, 'walker-hook.js');

    const result = installHookPlugin({ walkerPort: 8787, enabled: true });

    assert.equal(result.installed, true);
    assert.equal(result.path, expectedPath);
    assert.ok(fs.existsSync(expectedPath));

    fs.rmSync(tmpHome, { recursive: true, force: true });
  } finally {
    os.homedir = origHomedir;
  }
});

test('getPluginSource 返回包含 loopback 地址和必要逻辑的 plugin 内容', () => {
  const source = getPluginSource(8787);

  assert.ok(typeof source === 'string');
  assert.ok(source.length > 0);
  assert.ok(source.includes('127.0.0.1'));
  assert.ok(source.includes('8787'));
  assert.ok(source.includes('session.created'));
  assert.ok(source.includes('/opencode/hook/session-created'));
  assert.ok(!source.includes('admin_token'), 'plugin 不得包含 admin token');
  assert.ok(!source.includes('WALKER_ADMIN_TOKEN'), 'plugin 不得包含 token 环境变量名');
});

test('getPluginSource 不同 walkerPort 生成不同内容', () => {
  const s1 = getPluginSource(8787);
  const s2 = getPluginSource(9999);
  assert.ok(s1.includes('8787'));
  assert.ok(s2.includes('9999'));
  assert.notEqual(s1, s2);
});

test('getPluginSource 包含 OPENCODE_BASE_URL 默认值 localhost:4096', () => {
  const source = getPluginSource(8787);
  assert.ok(source.includes('localhost:4096'), 'plugin 应包含默认 opencode base url');
});

test('getPluginSource 使用 ESM 导出和 event hook 模式', () => {
  const source = getPluginSource(8787);
  assert.ok(source.includes('export const'), 'plugin 应使用 ESM 导出');
  assert.ok(source.includes('event:'), 'plugin 应返回 event hook');
  assert.ok(!source.includes('module.exports'), 'plugin 不应使用 CommonJS module.exports');
  assert.ok(!source.includes('api.on'), 'plugin 不应使用 api.on 监听模式');
});
