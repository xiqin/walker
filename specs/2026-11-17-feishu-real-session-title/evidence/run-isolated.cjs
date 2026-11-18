'use strict';

// 仅供本规格验收：为整条命令及其子进程隔离默认用户配置/数据路径，原始字节日志固定UTF-8。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const [mode, output] = process.argv.slice(2);
assert.ok(['full', 'targeted', 'integration', 'question'].includes(mode), '必须指定验证类型');
assert.ok(output && !fs.existsSync(output), '必须使用新的日志路径，不能覆盖历史证据');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode', 'walker-isolated-'));
const env = { ...process.env, HOME: directory, USERPROFILE: directory,
  XDG_STATE_HOME: path.join(directory, 'state'), XDG_DATA_HOME: path.join(directory, 'data'),
  XDG_CONFIG_HOME: path.join(directory, 'config'), APPDATA: path.join(directory, 'roaming'),
  LOCALAPPDATA: path.join(directory, 'local') };
for (const name of ['XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'APPDATA', 'LOCALAPPDATA']) {
  fs.mkdirSync(env[name], { recursive: true });
}
const fd = fs.openSync(output, 'wx');
try {
  // 启动测试前验证Node实际homedir解析，不依赖对Windows环境变量的猜测。
  const home = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("node:os").homedir())'], { env, encoding: 'utf8' });
  assert.equal(home.status, 0);
  assert.equal(path.resolve(home.stdout), path.resolve(directory), '默认用户路径必须落入新建沙箱');
  const args = ['--test', '--test-concurrency=1'];
  if (mode === 'question') args.push('test/integration-feishu-question.test.js');
  if (mode === 'integration') args.push('test/integration-feishu-tui-sync.test.js', 'test/feishu-api.test.js');
  if (mode === 'targeted') args.push('test/claude-removal-guard.test.js', 'test/http-helper.test.js', 'test/opencode-driver.test.js', 'test/message-dispatcher.test.js');
  const command = mode === 'full' ? (process.env.ComSpec || 'cmd.exe') : process.execPath;
  const commandArgs = mode === 'full' ? ['/d', '/s', '/c', 'npm test'] : args;
  fs.writeSync(fd, JSON.stringify({ isolated_home: directory, command, args: commandArgs }) + '\n');
  const child = spawn(command, commandArgs, { env, stdio: ['ignore', fd, fd] });
  child.on('error', (error) => { fs.writeSync(fd, String(error) + '\n'); });
  child.on('close', (code) => {
    fs.writeSync(fd, JSON.stringify({ exit_code: code, isolated_home_verified: true }) + '\n');
    fs.closeSync(fd);
    fs.rmSync(directory, { recursive: true, force: true });
    process.exitCode = code === 0 ? 0 : 1;
  });
} catch (error) {
  fs.closeSync(fd);
  fs.rmSync(directory, { recursive: true, force: true });
  throw error;
}
