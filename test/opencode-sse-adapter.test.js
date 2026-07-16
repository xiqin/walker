const test = require('node:test');
const assert = require('node:assert/strict');
const { AgentEvent } = require('../src/drivers/agent-driver');
const { mapSSEEvent } = require('../src/drivers/opencode-sse-adapter');

function makeEvent(type, properties) {
  return { type, properties };
}

test('AgentEvent 现有 6 种 TYPE 常量值不变', () => {
  assert.equal(AgentEvent.TYPE_TEXT, 'text');
  assert.equal(AgentEvent.TYPE_REASONING, 'reasoning');
  assert.equal(AgentEvent.TYPE_TOOL_USE, 'tool_use');
  assert.equal(AgentEvent.TYPE_ERROR, 'error');
  assert.equal(AgentEvent.TYPE_STATUS, 'status');
  assert.equal(AgentEvent.TYPE_DONE, 'done');
});

test('AgentEvent 新增 11 种 TYPE 常量存在且值正确', () => {
  assert.equal(AgentEvent.TYPE_PERMISSION, 'permission');
  assert.equal(AgentEvent.TYPE_PERMISSION_REPLIED, 'permission_replied');
  assert.equal(AgentEvent.TYPE_TODO, 'todo');
  assert.equal(AgentEvent.TYPE_COMPACTED, 'compacted');
  assert.equal(AgentEvent.TYPE_FILE_EDITED, 'file_edited');
  assert.equal(AgentEvent.TYPE_SESSION_DIFF, 'session_diff');
  assert.equal(AgentEvent.TYPE_STEP, 'step');
  assert.equal(AgentEvent.TYPE_MESSAGE_REMOVED, 'message_removed');
  assert.equal(AgentEvent.TYPE_COMMAND_EXECUTED, 'command_executed');
  assert.equal(AgentEvent.TYPE_SESSION_LIFECYCLE, 'session_lifecycle');
  assert.equal(AgentEvent.TYPE_SERVER_CONNECTED, 'server_connected');
});

test('AgentEvent DATA_SCHEMAS 包含现有 6 种类型', () => {
  assert.ok(AgentEvent.DATA_SCHEMAS.text);
  assert.ok(AgentEvent.DATA_SCHEMAS.reasoning);
  assert.ok(AgentEvent.DATA_SCHEMAS.tool_use);
  assert.ok(AgentEvent.DATA_SCHEMAS.error);
  assert.ok(AgentEvent.DATA_SCHEMAS.status);
  assert.ok(AgentEvent.DATA_SCHEMAS.done);
});

test('AgentEvent DATA_SCHEMAS 包含 11 种新类型', () => {
  assert.ok(AgentEvent.DATA_SCHEMAS.permission);
  assert.ok(AgentEvent.DATA_SCHEMAS.permission_replied);
  assert.ok(AgentEvent.DATA_SCHEMAS.todo);
  assert.ok(AgentEvent.DATA_SCHEMAS.compacted);
  assert.ok(AgentEvent.DATA_SCHEMAS.file_edited);
  assert.ok(AgentEvent.DATA_SCHEMAS.session_diff);
  assert.ok(AgentEvent.DATA_SCHEMAS.step);
  assert.ok(AgentEvent.DATA_SCHEMAS.message_removed);
  assert.ok(AgentEvent.DATA_SCHEMAS.command_executed);
  assert.ok(AgentEvent.DATA_SCHEMAS.session_lifecycle);
  assert.ok(AgentEvent.DATA_SCHEMAS.server_connected);
});

test('AgentEvent DATA_SCHEMAS permission 字段声明正确', () => {
  const schema = AgentEvent.DATA_SCHEMAS.permission;
  assert.equal(schema.id, 'string');
  assert.equal(schema.type, 'string');
  assert.equal(schema.title, 'string');
  assert.equal(schema.metadata, 'object?');
  assert.equal(schema.sessionID, 'string');
  assert.equal(schema.messageID, 'string');
  assert.equal(schema.callID, 'string?');
});

test('AgentEvent DATA_SCHEMAS file_edited 字段声明正确', () => {
  const schema = AgentEvent.DATA_SCHEMAS.file_edited;
  assert.equal(schema.path, 'string');
  assert.equal(schema.action, 'string');
  assert.equal(schema.linesAdded, 'number?');
  assert.equal(schema.linesRemoved, 'number?');
});

test('AgentEvent 构造器存储 type 和 data', () => {
  const ev = new AgentEvent(AgentEvent.TYPE_PERMISSION, { id: 'perm_1', title: 'test' });
  assert.equal(ev.type, 'permission');
  assert.equal(ev.data.id, 'perm_1');
});

test('permission.updated 映射到 TYPE_PERMISSION', () => {
  const ev = mapSSEEvent(makeEvent('permission.updated', {
    id: 'perm_abc', type: 'bash', title: '执行 bash 命令',
    metadata: { command: 'rm -rf /' }, sessionID: 's1', messageID: 'm1', callID: 'c1',
  }));
  assert.equal(ev.type, 'permission');
  assert.equal(ev.data.id, 'perm_abc');
  assert.equal(ev.data.type, 'bash');
  assert.equal(ev.data.title, '执行 bash 命令');
  assert.equal(ev.data.sessionID, 's1');
  assert.equal(ev.data.messageID, 'm1');
  assert.equal(ev.data.callID, 'c1');
});

test('permission.updated 缺少 title 时返回空字符串', () => {
  const ev = mapSSEEvent(makeEvent('permission.updated', { id: 'p1', sessionID: 's1', messageID: 'm1' }));
  assert.equal(ev.type, 'permission');
  assert.equal(ev.data.title, '');
});

test('permission.replied 映射到 TYPE_PERMISSION_REPLIED', () => {
  const ev = mapSSEEvent(makeEvent('permission.replied', { permissionId: 'p1', response: 'allow' }));
  assert.equal(ev.type, 'permission_replied');
  assert.equal(ev.data.permissionId, 'p1');
  assert.equal(ev.data.response, 'allow');
});

test('todo.updated 映射到 TYPE_TODO', () => {
  const todos = [{ id: 't1', content: 'task1', status: 'completed' }];
  const ev = mapSSEEvent(makeEvent('todo.updated', { todos }));
  assert.equal(ev.type, 'todo');
  assert.deepEqual(ev.data.todos, todos);
});

test('session.compacted 映射到 TYPE_COMPACTED', () => {
  const ev = mapSSEEvent(makeEvent('session.compacted', { sessionID: 's1' }));
  assert.equal(ev.type, 'compacted');
  assert.equal(ev.data.sessionID, 's1');
});

test('file.edited 映射到 TYPE_FILE_EDITED', () => {
  const ev = mapSSEEvent(makeEvent('file.edited', { path: '/a.js', action: 'edit', linesAdded: 10, linesRemoved: 3 }));
  assert.equal(ev.type, 'file_edited');
  assert.equal(ev.data.path, '/a.js');
  assert.equal(ev.data.action, 'edit');
  assert.equal(ev.data.linesAdded, 10);
  assert.equal(ev.data.linesRemoved, 3);
});

test('session.diff 映射到 TYPE_SESSION_DIFF', () => {
  const ev = mapSSEEvent(makeEvent('session.diff', { diff: '...', filesCount: 3, linesAdded: 20, linesRemoved: 5 }));
  assert.equal(ev.type, 'session_diff');
  assert.equal(ev.data.filesCount, 3);
  assert.equal(ev.data.linesAdded, 20);
  assert.equal(ev.data.linesRemoved, 5);
});

test('message.part.updated step-start 映射到 TYPE_STEP', () => {
  const ev = mapSSEEvent(makeEvent('message.part.updated', { part: { type: 'step-start', stepId: 'step_1' } }));
  assert.equal(ev.type, 'step');
  assert.equal(ev.data.partType, 'step-start');
  assert.equal(ev.data.stepId, 'step_1');
});

test('message.part.updated step-finish 映射到 TYPE_STEP', () => {
  const ev = mapSSEEvent(makeEvent('message.part.updated', { part: { type: 'step-finish', stepId: 'step_1' } }));
  assert.equal(ev.type, 'step');
  assert.equal(ev.data.partType, 'step-finish');
});

test('message.part.updated file 映射到 TYPE_FILE_EDITED', () => {
  const ev = mapSSEEvent(makeEvent('message.part.updated', { part: { type: 'file', path: '/b.js' } }));
  assert.equal(ev.type, 'file_edited');
  assert.equal(ev.data.path, '/b.js');
});

test('message.part.updated patch 映射到 TYPE_FILE_EDITED', () => {
  const ev = mapSSEEvent(makeEvent('message.part.updated', { part: { type: 'patch', path: '/c.js' } }));
  assert.equal(ev.type, 'file_edited');
  assert.equal(ev.data.path, '/c.js');
  assert.equal(ev.data.action, 'patch');
});

test('message.part.updated snapshot 静默丢弃', () => {
  const ev = mapSSEEvent(makeEvent('message.part.updated', { part: { type: 'snapshot' } }));
  assert.equal(ev, null);
});

test('message.part.updated agent 静默丢弃', () => {
  const ev = mapSSEEvent(makeEvent('message.part.updated', { part: { type: 'agent' } }));
  assert.equal(ev, null);
});

test('message.removed 映射到 TYPE_MESSAGE_REMOVED', () => {
  const ev = mapSSEEvent(makeEvent('message.removed', { messageID: 'm1' }));
  assert.equal(ev.type, 'message_removed');
  assert.equal(ev.data.messageId, 'm1');
});

test('message.part.removed 映射到 TYPE_MESSAGE_REMOVED', () => {
  const ev = mapSSEEvent(makeEvent('message.part.removed', { messageID: 'm1', partID: 'p1' }));
  assert.equal(ev.type, 'message_removed');
  assert.equal(ev.data.messageId, 'm1');
  assert.equal(ev.data.partId, 'p1');
});

test('command.executed 映射到 TYPE_COMMAND_EXECUTED', () => {
  const ev = mapSSEEvent(makeEvent('command.executed', { command: 'npm test', exitCode: 0 }));
  assert.equal(ev.type, 'command_executed');
  assert.equal(ev.data.command, 'npm test');
  assert.equal(ev.data.exitCode, 0);
});

test('session.created 映射到 TYPE_SESSION_LIFECYCLE', () => {
  const ev = mapSSEEvent(makeEvent('session.created', { session: { id: 's1' } }));
  assert.equal(ev.type, 'session_lifecycle');
  assert.equal(ev.data.action, 'created');
  assert.equal(ev.data.session.id, 's1');
});

test('session.updated 映射到 TYPE_SESSION_LIFECYCLE', () => {
  const ev = mapSSEEvent(makeEvent('session.updated', { session: { id: 's1' } }));
  assert.equal(ev.type, 'session_lifecycle');
  assert.equal(ev.data.action, 'updated');
});

test('session.deleted 映射到 TYPE_SESSION_LIFECYCLE', () => {
  const ev = mapSSEEvent(makeEvent('session.deleted', { session: { id: 's1' } }));
  assert.equal(ev.type, 'session_lifecycle');
  assert.equal(ev.data.action, 'deleted');
});

test('server.connected 映射到 TYPE_SERVER_CONNECTED', () => {
  const ev = mapSSEEvent(makeEvent('server.connected', {}));
  assert.equal(ev.type, 'server_connected');
});

test('installation.updated 静默丢弃', () => {
  assert.equal(mapSSEEvent(makeEvent('installation.updated', {})), null);
});

test('lsp.updated 静默丢弃', () => {
  assert.equal(mapSSEEvent(makeEvent('lsp.updated', {})), null);
});

test('vcs.branch.updated 静默丢弃', () => {
  assert.equal(mapSSEEvent(makeEvent('vcs.branch.updated', {})), null);
});

test('pty.created 静默丢弃', () => {
  assert.equal(mapSSEEvent(makeEvent('pty.created', {})), null);
});

test('tui.toast.show 静默丢弃', () => {
  assert.equal(mapSSEEvent(makeEvent('tui.toast.show', {})), null);
});

test('未知事件类型返回 null', () => {
  assert.equal(mapSSEEvent(makeEvent('future.unknown.event', {})), null);
});

test('跨 session 事件被过滤', () => {
  const ev = mapSSEEvent(makeEvent('session.compacted', { sessionID: 'other' }), 'mySession');
  assert.equal(ev, null);
});
