'use strict';

// 隔离默认用户路径，保留全新原始日志；不启动真实服务。
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const [mode, output] = process.argv.slice(2);
assert.ok(['probe', 'focused', 'full'].includes(mode));
assert.ok(output && !fs.existsSync(output), '必须使用全新日志路径');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode', 'walker-v2-title-'));
const env = { ...process.env, HOME: directory, USERPROFILE: directory };
for (const key of ['XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'APPDATA', 'LOCALAPPDATA']) {
  env[key] = path.join(directory, key);
  fs.mkdirSync(env[key]);
}
const check = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], { env, encoding: 'utf8' });
assert.equal(check.status, 0);
assert.equal(path.resolve(check.stdout), path.resolve(directory));
const fd = fs.openSync(output, 'wx');
const focused = ['--test', '--test-concurrency=1', 'test/opencode-v2-cli-plugin.test.js',
  'test/opencode-tui-bridge.test.js', 'test/opencode-driver.test.js',
  'test/message-dispatcher.test.js', 'test/integration-feishu-tui-sync.test.js',
  'test/feishu-v2-session-title.test.js', 'test/opencode-hook-installer.test.js',
  'test/opencode-plugin-template.test.js'];
const command = mode === 'full' ? process.env.ComSpec || 'cmd.exe' : process.execPath;
const args = mode === 'full' ? ['/d', '/s', '/c', 'npm test']
  : mode === 'probe' ? [path.join(__dirname, 'title-source-probe.cjs')] : focused;
fs.writeSync(fd, JSON.stringify({ command, args, isolated_home: directory, home_verified: true }) + '\n');
const child = spawn(command, args, { env, stdio: ['ignore', fd, fd] });
child.on('error', error => { fs.writeSync(fd, String(error) + '\n'); });
child.on('close', code => {
  fs.writeSync(fd, JSON.stringify({ exit_code: code, isolated_home_verified: true }) + '\n');
  fs.closeSync(fd);
  // 仅删除本运行器创建的隔离目录，不触碰用户数据。
  fs.rmSync(directory, { recursive: true, force: true });
  process.exitCode = code === 0 ? 0 : 1;
});
