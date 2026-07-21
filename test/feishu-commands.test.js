const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCommand, COMMANDS, formatHelp } = require('../src/platform/feishu/commands');

test('parseCommand /new 无参数', () => {
  const result = parseCommand('/new');
  assert.equal(result.type, 'command');
  assert.equal(result.name, 'new');
  assert.deepEqual(result.args, []);
});

test('parseCommand /new opencode my-session', () => {
  const result = parseCommand('/new opencode my-session');
  assert.equal(result.type, 'command');
  assert.equal(result.name, 'new');
  assert.deepEqual(result.args, ['opencode', 'my-session']);
});

test('parseCommand /list', () => {
  const result = parseCommand('/list');
  assert.equal(result.type, 'command');
  assert.equal(result.name, 'list');
  assert.deepEqual(result.args, []);
});

test('parseCommand /attach', () => {
  const result = parseCommand('/attach');
  assert.equal(result.type, 'command');
  assert.equal(result.name, 'attach');
  assert.deepEqual(result.args, []);
});

test('parseCommand /attach ses_abc', () => {
  const result = parseCommand('/attach ses_abc');
  assert.equal(result.type, 'command');
  assert.equal(result.name, 'attach');
  assert.deepEqual(result.args, ['ses_abc']);
});

test('parseCommand /use wks_abc', () => {
  const result = parseCommand('/use wks_abc');
  assert.equal(result.type, 'command');
  assert.equal(result.name, 'use');
  assert.deepEqual(result.args, ['wks_abc']);
});

test('parseCommand /use off', () => {
  const result = parseCommand('/use off');
  assert.equal(result.type, 'command');
  assert.equal(result.name, 'use');
  assert.deepEqual(result.args, ['off']);
});

test('parseCommand /current', () => {
  const result = parseCommand('/current');
  assert.equal(result.type, 'command');
  assert.equal(result.name, 'current');
});

test('parseCommand /stop', () => {
  const result = parseCommand('/stop');
  assert.equal(result.type, 'command');
  assert.equal(result.name, 'stop');
});

test('parseCommand /delete wks_xyz', () => {
  const result = parseCommand('/delete wks_xyz');
  assert.equal(result.type, 'command');
  assert.equal(result.name, 'delete');
  assert.deepEqual(result.args, ['wks_xyz']);
});

test('parseCommand /help', () => {
  const result = parseCommand('/help');
  assert.equal(result.type, 'command');
  assert.equal(result.name, 'help');
});

test('parseCommand 普通文本返回 text 类型', () => {
  const result = parseCommand('hello world');
  assert.equal(result.type, 'text');
  assert.equal(result.text, 'hello world');
});

test('parseCommand /agents', () => {
  const result = parseCommand('/agents');
  assert.equal(result.type, 'command');
  assert.equal(result.name, 'agents');
});

test('parseCommand /runtime', () => {
  const result = parseCommand('/runtime');
  assert.equal(result.type, 'command');
  assert.equal(result.name, 'runtime');
});

test('parseCommand /cancel', () => {
  const result = parseCommand('/cancel');
  assert.equal(result.type, 'command');
  assert.equal(result.name, 'cancel');
  assert.deepEqual(result.args, []);
});

test('parseCommand /status', () => {
  const result = parseCommand('/status');
  assert.equal(result.type, 'command');
  assert.equal(result.name, 'status');
  assert.deepEqual(result.args, []);
});

test('parseCommand /ps', () => {
  const result = parseCommand('/ps');
  assert.equal(result.type, 'command');
  assert.equal(result.name, 'ps');
  assert.deepEqual(result.args, []);
});

test('parseCommand /clear 无参数', () => {
  const result = parseCommand('/clear');
  assert.equal(result.type, 'command');
  assert.equal(result.name, 'clear');
  assert.deepEqual(result.args, []);
});

test('parseCommand /clear 带参数仍解析为 clear 命令', () => {
  const result = parseCommand('/clear extra');
  assert.equal(result.type, 'command');
  assert.equal(result.name, 'clear');
  assert.deepEqual(result.args, ['extra']);
});

test('COMMANDS 包含所有需要的命令', () => {
  const names = Object.keys(COMMANDS);
  assert.ok(names.includes('new'));
  assert.ok(names.includes('attach'));
  assert.ok(names.includes('list'));
  assert.ok(names.includes('use'));
  assert.ok(names.includes('current'));
  assert.ok(names.includes('stop'));
  assert.ok(names.includes('delete'));
  assert.ok(names.includes('help'));
  assert.ok(names.includes('agents'));
  assert.ok(names.includes('runtime'));
  assert.ok(names.includes('cancel'));
  assert.ok(names.includes('status'));
  assert.ok(names.includes('ps'));
  assert.ok(names.includes('clear'));
});

test('formatHelp 包含新增命令', () => {
  const help = formatHelp();
  assert.match(help, /\/cancel/);
  assert.match(help, /取消当前 turn/);
  assert.match(help, /\/status/);
  assert.match(help, /查看当前会话状态/);
  assert.match(help, /\/ps/);
  assert.match(help, /\/status 的别名/);
});

test('formatHelp 包含 /clear 命令说明', () => {
  const help = formatHelp();
  assert.match(help, /\/clear/);
  assert.match(help, /新建空上下文/);
});

test('parseCommand /permit perm_abc allow', () => {
  const result = parseCommand('/permit perm_abc allow');
  assert.equal(result.type, 'command');
  assert.equal(result.name, 'permit');
  assert.deepEqual(result.args, ['perm_abc', 'allow']);
});

test('parseCommand /permit perm_abc deny', () => {
  const result = parseCommand('/permit perm_abc deny');
  assert.equal(result.type, 'command');
  assert.equal(result.name, 'permit');
  assert.deepEqual(result.args, ['perm_abc', 'deny']);
});

test('parseCommand /permit perm_abc always', () => {
  const result = parseCommand('/permit perm_abc always');
  assert.equal(result.type, 'command');
  assert.equal(result.name, 'permit');
  assert.deepEqual(result.args, ['perm_abc', 'always']);
});

test('COMMANDS 包含 permit 条目', () => {
  assert.ok(COMMANDS.permit);
  assert.ok(COMMANDS.permit.desc);
  assert.ok(COMMANDS.permit.usage);
  assert.match(COMMANDS.permit.usage, /permissionId/);
  assert.match(COMMANDS.permit.usage, /allow/);
  assert.match(COMMANDS.permit.usage, /deny/);
  assert.match(COMMANDS.permit.usage, /always/);
});

test('COMMANDS 包含 answer 条目', () => {
  assert.ok(COMMANDS.answer);
  assert.ok(COMMANDS.answer.desc);
  assert.ok(COMMANDS.answer.usage);
  assert.match(COMMANDS.answer.usage, /questionKey/);
  assert.match(COMMANDS.answer.usage, /--form <walkerSessionId>/);
  assert.match(COMMANDS.answer.usage, /--retry <walkerSessionId>/);
  assert.doesNotMatch(COMMANDS.answer.usage, /<value>/);
});

test('parseCommand /answer <questionKey> --form <walkerSessionId>', () => {
  const result = parseCommand('/answer request_1:0 --form wks_answer');
  assert.equal(result.type, 'command');
  assert.equal(result.name, 'answer');
  assert.deepEqual(result.args, ['request_1:0', '--form', 'wks_answer']);
});

test('parseCommand /answer <questionKey> --retry <walkerSessionId>', () => {
  const result = parseCommand('/answer request_1:0 --retry wks_answer');
  assert.equal(result.type, 'command');
  assert.equal(result.name, 'answer');
  assert.deepEqual(result.args, ['request_1:0', '--retry', 'wks_answer']);
});

test('formatHelp 包含 answer 命令', () => {
  const help = formatHelp();
  assert.match(help, /\/answer/);
  assert.match(help, /questionKey/);
  assert.match(help, /--form <walkerSessionId>/);
  assert.match(help, /--retry <walkerSessionId>/);
  assert.doesNotMatch(help, /<value>/);
});
