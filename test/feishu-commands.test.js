const test = require('node:test');
const assert = require('node:assert/strict');
const { parseCommand, COMMANDS } = require('../src/platform/feishu/commands');

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

test('COMMANDS 包含所有需要的命令', () => {
  const names = Object.keys(COMMANDS);
  assert.ok(names.includes('new'));
  assert.ok(names.includes('list'));
  assert.ok(names.includes('use'));
  assert.ok(names.includes('current'));
  assert.ok(names.includes('stop'));
  assert.ok(names.includes('delete'));
  assert.ok(names.includes('help'));
  assert.ok(names.includes('agents'));
  assert.ok(names.includes('runtime'));
});
