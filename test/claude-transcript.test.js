'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createTranscriptCursor,
  decodeClaudeProjectPath,
  defaultConfigDir,
  encodeClaudeProjectPath,
  listAllClaudeSessions,
  listClaudeSessionsForCwd,
  parseClaudeJsonlLine,
  parseClaudeJsonlLineEvents,
  readAssistantTextSince,
  resolveClaudeTranscriptPath,
  watchClaudeTranscript,
} = require('../src/drivers/claude-transcript');
const { AgentEvent } = require('../src/drivers/agent-driver');

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'walker-claude-transcript-'));
  const cwd = path.join(root, 'workspace');
  const configDir = path.join(root, 'claude-config');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  return { root, cwd, configDir };
}

function expectedProjectDirName(cwd) {
  return fs.realpathSync.native(cwd).replace(/[\\/:]/g, '-');
}

function projectDir(configDir, cwd) {
  return path.join(configDir, 'projects', expectedProjectDirName(cwd));
}

function transcriptPath(configDir, cwd, uuid = UUID_A) {
  const dir = projectDir(configDir, cwd);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, uuid + '.jsonl');
}

function appendJsonLine(file, value) {
  fs.appendFileSync(file, JSON.stringify(value) + '\n');
}

async function waitFor(predicate, options = {}) {
  const deadline = Date.now() + (options.timeoutMs || 500);
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, options.intervalMs || 10));
  }
  assert.fail(options.message || 'condition was not met before timeout');
}

test('REQ-004-B04: encodeClaudeProjectPath 保留真实 Claude project 目录前导分隔符', () => {
  assert.equal(encodeClaudeProjectPath('/Users/alice/project'), '-Users-alice-project');
  assert.equal(encodeClaudeProjectPath('C:\\Users\\alice\\project'), 'C--Users-alice-project');
});

test('REQ-004-B01: 飞书 prompt 只返回边界之后的 assistant 文本并过滤旧消息和 echo', async () => {
  const { cwd, configDir } = makeSandbox();
  const file = transcriptPath(configDir, cwd);
  appendJsonLine(file, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'old answer' }] } });

  const cursor = createTranscriptCursor({ cwd, configDir, claudeSessionId: UUID_A });
  appendJsonLine(file, { type: 'user', message: { role: 'user', content: 'new prompt echo' } });
  appendJsonLine(file, { role: 'user', content: 'another echo' });
  appendJsonLine(file, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', text: 'hidden' }, { type: 'text', text: 'new answer' }] } });
  appendJsonLine(file, { role: 'assistant', content: [{ type: 'text', text: 'second chunk' }] });

  const text = await readAssistantTextSince(cursor, { timeoutMs: 30, pollIntervalMs: 5 });

  assert.equal(text, 'new answer\nsecond chunk');
});

test('REQ-004-B02: 本地 TUI 的最终 assistant JSONL 记录形成文本和完成事件', async () => {
  const { cwd, configDir } = makeSandbox();
  const file = transcriptPath(configDir, cwd);
  appendJsonLine(file, { role: 'assistant', content: 'old answer' });
  const events = [];
  const controller = new AbortController();

  const watcher = watchClaudeTranscript({
    cwd,
    configDir,
    claudeSessionId: UUID_A,
    pollIntervalMs: 10,
    signal: controller.signal,
    onEvent: event => events.push(event),
  });
  appendJsonLine(file, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'local prompt' }] } });
  appendJsonLine(file, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'tool preface' }], stop_reason: 'tool_use' } });
  appendJsonLine(file, {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'local answer' }],
      model: 'claude-sonnet-4-20250514',
      usage: {
        input_tokens: 12,
        output_tokens: 8,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 5,
      },
      stop_reason: 'end_turn',
    },
  });

  await waitFor(() => events.length === 4, { message: 'watcher did not emit user, assistant, and done events' });
  controller.abort();
  watcher.close();

  assert.deepEqual(events.map(event => ({ type: event.type, text: event.text })), [
    { type: 'user', text: 'local prompt' },
    { type: 'assistant', text: 'tool preface' },
    { type: 'assistant', text: 'local answer' },
    { type: 'done', text: undefined },
  ]);
  assert.equal(events[0].claudeSessionId, UUID_A);
  assert.equal(events[0].transcriptPath, file);
  assert.equal(events[2].model, 'claude-sonnet-4-20250514');
  assert.equal(events[2].contextSize, 125);
  assert.deepEqual(events[2].tokenUsage, {
    inputTokens: 12,
    outputTokens: 8,
    cacheReadTokens: 100,
    cacheWriteTokens: 5,
    totalTokens: 125,
  });
  assert.equal(events[3].model, 'claude-sonnet-4-20250514');
  assert.equal(events[3].contextSize, 125);
});

test('REQ-004-B01: 单条 assistant 多 content block 按 text/reasoning/tool_use 原顺序输出', () => {
  const events = parseClaudeJsonlLineEvents(JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'text', text: '先说明' },
        { type: 'thinking', thinking: '内部计划' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'src/a.js' } },
        { type: 'text', text: '后说明' },
      ],
      model: 'claude-sonnet-4-20250514',
    },
  }));

  assert.deepEqual(events.map(event => [event.type, event.text, event.name, event.phase, event.callID]), [
    ['assistant', '先说明', undefined, undefined, undefined],
    ['reasoning', '内部计划', undefined, undefined, undefined],
    ['tool_use', undefined, 'Read', 'start', 'toolu_1'],
    ['assistant', '后说明', undefined, undefined, undefined],
  ]);
  assert.deepEqual(events[2].input, { file_path: 'src/a.js' });
  assert.equal(events[0].model, 'claude-sonnet-4-20250514');
  assert.equal(parseClaudeJsonlLine(JSON.stringify({ role: 'assistant', content: '兼容文本' })).text, '兼容文本');
});

test('REQ-004-B02/REQ-004-B03: tool_use result 用 callID 关联，orphan result 保留且不误绑', () => {
  const started = parseClaudeJsonlLineEvents(JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_ok', name: 'Bash', input: { command: 'npm test' } }] },
  }));
  const results = parseClaudeJsonlLineEvents(JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_ok', content: 'passed', is_error: false },
        { type: 'tool_result', tool_use_id: 'toolu_missing', content: [{ type: 'text', text: 'failed secret=abc' }], is_error: true },
      ],
    },
  }), { seenToolUseIds: new Set(started.map(event => event.callID).filter(Boolean)) });

  assert.deepEqual(results.map(event => ({ type: event.type, phase: event.phase, callID: event.callID, result: event.result, isError: event.isError, orphan: event.orphan, status: event.status })), [
    { type: 'tool_use', phase: 'result', callID: 'toolu_ok', result: 'passed', isError: false, orphan: false, status: 'done' },
    { type: 'tool_use', phase: 'result', callID: 'toolu_missing', result: 'failed secret=[redacted]', isError: true, orphan: true, status: 'error' },
  ]);
});

test('REQ-004-B04/REQ-004-B05/REQ-008-B03/REQ-008-B04: watcher 对坏记录和高频未知 block 诊断有界并恢复', async () => {
  const { cwd, configDir } = makeSandbox();
  const file = transcriptPath(configDir, cwd);
  const events = [];
  const watcher = watchClaudeTranscript({ cwd, configDir, claudeSessionId: UUID_A, pollIntervalMs: 10, onEvent: event => events.push(event) });

  fs.appendFileSync(file, '{bad json with SECRET=abc}\n');
  for (let i = 0; i < 20; i += 1) {
    appendJsonLine(file, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'mystery_' + i, prompt: 'full prompt SECRET=abc', input: { token: 'abc' } }] } });
  }
  appendJsonLine(file, { role: 'assistant', content: 'recovered text' });

  await waitFor(() => events.some(event => event.type === 'assistant' && event.text === 'recovered text'), { message: 'watcher did not recover after bad and unknown records' });
  watcher.close();

  const diagnostics = events.filter(event => event.type === 'status' && event.status === 'claude-transcript-diagnostic');
  assert.ok(diagnostics.length > 0);
  assert.ok(diagnostics.length <= 10);
  assert.ok(diagnostics.some(event => event.diagnostic && event.diagnostic.kind === 'bad-json'));
  assert.ok(diagnostics.some(event => event.diagnostic && event.diagnostic.rawType === 'mystery_0'));
  assert.equal(diagnostics.some(event => JSON.stringify(event).includes('SECRET=abc')), false);
  assert.equal(diagnostics.some(event => JSON.stringify(event).includes('full prompt')), false);
});

test('REQ-004-B06: 纯文本 transcript 回复收集和 watch 语义保持不变', async () => {
  const { cwd, configDir } = makeSandbox();
  const file = transcriptPath(configDir, cwd);
  const cursor = createTranscriptCursor({ cwd, configDir, claudeSessionId: UUID_A });
  appendJsonLine(file, { role: 'assistant', content: 'plain one' });
  appendJsonLine(file, { role: 'assistant', content: 'plain two' });

  const text = await readAssistantTextSince(cursor, { timeoutMs: 30, pollIntervalMs: 5 });
  assert.equal(text, 'plain one\nplain two');

  const events = [];
  const watcher = watchClaudeTranscript({ cwd, configDir, claudeSessionId: UUID_A, pollIntervalMs: 10, onEvent: event => events.push(event) });
  appendJsonLine(file, { role: 'assistant', content: 'plain watched' });
  await waitFor(() => events.some(event => event.text === 'plain watched'), { message: 'watcher did not emit plain text' });
  watcher.close();
  assert.ok(events.some(event => event.type === 'assistant' && event.text === 'plain watched'));
});

test('REQ-005-B01/REQ-005-B06: question/hook 只映射稳定脱敏字段且不重复敏感 payload', () => {
  const question = parseClaudeJsonlLineEvents(JSON.stringify({
    type: 'question',
    request_id: 'req-1',
    session_id: 'sess-1',
    question: '允许执行工具？',
    tool_name: 'Bash',
    prompt: '完整 prompt SECRET=abc',
    token: 'abc',
  }));
  const hook = parseClaudeJsonlLineEvents(JSON.stringify({
    type: 'hook',
    hook_event_name: 'PreToolUse',
    tool_name: 'Read',
    tool_input: { file_path: 'secret.txt', token: 'abc' },
    prompt: '完整 prompt SECRET=abc',
  }));

  assert.equal(question.length, 1);
  assert.equal(question[0].type, 'question_asked');
  assert.deepEqual(question[0].questions, [{ question: '允许执行工具？', header: 'Bash', options: [] }]);
  assert.deepEqual(question[0].tool, { name: 'Bash' });
  assert.equal(hook.length, 1);
  assert.equal(hook[0].type, 'status');
  assert.equal(hook[0].diagnostic.hookEventName, 'PreToolUse');
  assert.deepEqual(hook[0].diagnostic.tool, { name: 'Read' });
  assert.equal(JSON.stringify(question.concat(hook)).includes('SECRET=abc'), false);
  assert.equal(JSON.stringify(question.concat(hook)).includes('secret.txt'), false);
});

test('AgentEvent tool_use schema: 新 lifecycle 字段可选且旧字段兼容', () => {
  assert.deepEqual(AgentEvent.DATA_SCHEMAS[AgentEvent.TYPE_TOOL_USE], {
    name: 'string',
    input: 'object?',
    output: 'string?',
    status: 'string?',
    callID: 'string?',
    phase: 'string?',
    result: 'string?',
    isError: 'boolean?',
    orphan: 'boolean?',
  });
  assert.deepEqual(new AgentEvent(AgentEvent.TYPE_TOOL_USE, { name: 'Read', input: {}, status: 'pending' }).data, { name: 'Read', input: {}, status: 'pending' });
});

test('REQ-004-B03: 缺失文件抛 MISSING，部分行抛 PARTIAL_LINE_TIMEOUT，完整文件无 assistant 抛 TIMEOUT', async () => {
  const { cwd, configDir } = makeSandbox();
  const cursor = createTranscriptCursor({ cwd, configDir, claudeSessionId: UUID_A });

  await assert.rejects(
    () => readAssistantTextSince(cursor, { timeoutMs: 20, pollIntervalMs: 5 }),
    err => err.code === 'CLAUDE_TRANSCRIPT_MISSING' && err.transcriptPath === cursor.transcriptPath && err.claudeSessionId === UUID_A && err.offset === 0,
  );

  const file = transcriptPath(configDir, cwd);
  fs.appendFileSync(file, '{"role":"assistant","content":"partial"');
  await assert.rejects(
    () => readAssistantTextSince(cursor, { timeoutMs: 20, pollIntervalMs: 5 }),
    err => err.code === 'CLAUDE_TRANSCRIPT_PARTIAL_LINE_TIMEOUT' && err.offset === 0,
  );

  fs.writeFileSync(file, JSON.stringify({ role: 'user', content: 'no assistant here' }) + '\n');
  cursor.offset = 0;
  await assert.rejects(
    () => readAssistantTextSince(cursor, { timeoutMs: 20, pollIntervalMs: 5 }),
    err => err.code === 'CLAUDE_TRANSCRIPT_TIMEOUT' && err.offset > 0,
  );

  fs.writeFileSync(file, '{"role":"assistant","content":"partial"');

  const events = [];
  const watcher = watchClaudeTranscript({ cwd, configDir, claudeSessionId: UUID_A, pollIntervalMs: 10, onEvent: event => events.push(event) });
  fs.appendFileSync(file, '}\n');
  appendJsonLine(file, { role: 'assistant', content: 'after partial' });

  await waitFor(() => events.some(event => event.text === 'partial'), { timeoutMs: 1500, message: 'watcher did not recover after partial line completed' });
  watcher.close();

  assert.ok(events.some(event => event.type === 'assistant' && event.text === 'after partial'));
});

test('REQ-004-B04: 非法 UUID、cwd 不存在、非目录和 symlink workspace 全部 fail closed', () => {
  const { root, cwd, configDir } = makeSandbox();
  assert.throws(
    () => resolveClaudeTranscriptPath({ cwd, configDir, claudeSessionId: '../evil' }),
    err => err.code === 'CLAUDE_TRANSCRIPT_INVALID_UUID',
  );

  assert.throws(
    () => resolveClaudeTranscriptPath({ cwd: path.join(root, 'missing-workspace'), configDir, claudeSessionId: UUID_A }),
    err => err.code === 'CLAUDE_TRANSCRIPT_INVALID_WORKSPACE',
  );

  const notDirectory = path.join(root, 'not-directory');
  fs.writeFileSync(notDirectory, 'not a directory');
  assert.throws(
    () => resolveClaudeTranscriptPath({ cwd: notDirectory, configDir, claudeSessionId: UUID_A }),
    err => err.code === 'CLAUDE_TRANSCRIPT_INVALID_WORKSPACE',
  );

  const realWorkspace = path.join(root, 'real-workspace');
  const linkedWorkspace = path.join(root, 'linked-workspace');
  fs.mkdirSync(realWorkspace, { recursive: true });
  fs.symlinkSync(realWorkspace, linkedWorkspace, 'junction');
  assert.throws(
    () => resolveClaudeTranscriptPath({ cwd: linkedWorkspace, configDir, claudeSessionId: UUID_A }),
    err => err.code === 'CLAUDE_TRANSCRIPT_PATH_ESCAPE',
  );

  fs.rmSync(linkedWorkspace, { recursive: true, force: true });

  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  const expectedProjectDir = projectDir(configDir, cwd);
  fs.mkdirSync(path.dirname(expectedProjectDir), { recursive: true });
  fs.symlinkSync(outside, expectedProjectDir, 'junction');

  assert.throws(
    () => resolveClaudeTranscriptPath({ cwd, configDir, claudeSessionId: UUID_A }),
    err => err.code === 'CLAUDE_TRANSCRIPT_PATH_ESCAPE',
  );
});

test('REQ-004-B05: 错误 workspace 不扫描其他目录，缺失绑定 UUID 时明确 MISSING', async () => {
  const { root, cwd, configDir } = makeSandbox();
  const otherWorkspace = path.join(root, 'other-workspace');
  fs.mkdirSync(otherWorkspace, { recursive: true });
  const boundFile = transcriptPath(configDir, cwd, UUID_A);
  appendJsonLine(boundFile, { role: 'assistant', content: 'must not be read from another workspace' });

  const cursor = createTranscriptCursor({ cwd: otherWorkspace, configDir, claudeSessionId: UUID_A });

  await assert.rejects(
    () => readAssistantTextSince(cursor, { timeoutMs: 20, pollIntervalMs: 5 }),
    err => err.code === 'CLAUDE_TRANSCRIPT_MISSING' && err.transcriptPath !== boundFile,
  );
});

test('REQ-004-B05: 同 cwd 多个 UUID 时只读取绑定 UUID，禁止 latest-mtime 猜测', async () => {
  const { cwd, configDir } = makeSandbox();
  const bound = transcriptPath(configDir, cwd, UUID_A);
  const other = transcriptPath(configDir, cwd, UUID_B);
  appendJsonLine(bound, { role: 'assistant', content: 'old bound' });
  const cursor = createTranscriptCursor({ cwd, configDir, claudeSessionId: UUID_A });

  appendJsonLine(other, { role: 'assistant', content: 'wrong newest answer' });
  appendJsonLine(bound, { role: 'assistant', content: 'right answer' });

  const text = await readAssistantTextSince(cursor, { timeoutMs: 30, pollIntervalMs: 5 });

  assert.equal(text, 'right answer');
});

test('listClaudeSessionsForCwd: 返回字段完整且 updatedAt 取尾部最新 timestamp(number)', () => {
  const { cwd, configDir } = makeSandbox();
  const file = transcriptPath(configDir, cwd, UUID_A);
  appendJsonLine(file, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }] }, timestamp: '2026-08-06T10:00:00.000Z' });
  appendJsonLine(file, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] }, timestamp: '2026-08-06T10:01:00.000Z' });

  const sessions = listClaudeSessionsForCwd({ cwd, configDir });
  assert.equal(sessions.length, 1);
  const s = sessions[0];
  assert.equal(s.id, UUID_A);
  assert.equal(typeof s.updatedAt, 'number');
  assert.equal(s.updatedAt, Date.parse('2026-08-06T10:01:00.000Z'));
  assert.equal(s.status, 'idle');
  assert.equal(s.cwd, fs.realpathSync.native(cwd));
  assert.equal(s.title, 'first prompt');
});

test('listClaudeSessionsForCwd: title 截断长 user 文本,无 user 时回退默认标题', () => {
  const { cwd, configDir } = makeSandbox();
  const fileA = transcriptPath(configDir, cwd, UUID_A);
  appendJsonLine(fileA, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'a'.repeat(100) }] }, timestamp: '2026-08-06T10:01:00.000Z' });
  const fileB = transcriptPath(configDir, cwd, UUID_B);
  appendJsonLine(fileB, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'only assistant' }] }, timestamp: '2026-08-06T10:00:00.000Z' });

  const sessions = listClaudeSessionsForCwd({ cwd, configDir });
  assert.deepEqual(sessions.map((s) => s.id), [UUID_A, UUID_B]);
  assert.equal(sessions[0].title.length, 60);
  assert.equal(sessions[0].title, 'a'.repeat(60));
  assert.equal(sessions[1].title, 'claude ' + UUID_B.slice(0, 8));
});

test('listClaudeSessionsForCwd: 无 timestamp 时 updatedAt 回退文件 mtimeMs', () => {
  const { cwd, configDir } = makeSandbox();
  const file = transcriptPath(configDir, cwd, UUID_A);
  appendJsonLine(file, { type: 'user', message: { role: 'user', content: 'no timestamp record' } });
  const sessions = listClaudeSessionsForCwd({ cwd, configDir });
  assert.equal(sessions.length, 1);
  assert.equal(typeof sessions[0].updatedAt, 'number');
  assert.ok(sessions[0].updatedAt > 0);
  const mtime = fs.statSync(file).mtimeMs;
  assert.ok(Math.abs(sessions[0].updatedAt - mtime) < 5000);
});

test('listClaudeSessionsForCwd: 过滤非 UUID 文件名与无关文件', () => {
  const { cwd, configDir } = makeSandbox();
  const dir = projectDir(configDir, cwd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'not-a-uuid.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } }) + '\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'ignore me');
  const file = transcriptPath(configDir, cwd, UUID_A);
  appendJsonLine(file, { type: 'user', message: { role: 'user', content: 'valid' }, timestamp: '2026-08-06T10:00:00.000Z' });

  const sessions = listClaudeSessionsForCwd({ cwd, configDir });
  assert.deepEqual(sessions.map((s) => s.id), [UUID_A]);
});

test('listClaudeSessionsForCwd: cwd 不存在或 projectDir 缺失返回 [] 不抛错', () => {
  const { root, cwd, configDir } = makeSandbox();
  assert.deepEqual(listClaudeSessionsForCwd({ cwd: path.join(root, 'no-such-cwd'), configDir }), []);
  assert.deepEqual(listClaudeSessionsForCwd({ cwd, configDir }), []);
  assert.deepEqual(listClaudeSessionsForCwd({ configDir }), []);
});

test('listClaudeSessionsForCwd: 多会话按 updatedAt 倒序', () => {
  const { cwd, configDir } = makeSandbox();
  const fileA = transcriptPath(configDir, cwd, UUID_A);
  appendJsonLine(fileA, { type: 'user', message: { role: 'user', content: 'a' }, timestamp: '2026-08-06T09:00:00.000Z' });
  const fileB = transcriptPath(configDir, cwd, UUID_B);
  appendJsonLine(fileB, { type: 'user', message: { role: 'user', content: 'b' }, timestamp: '2026-08-06T10:00:00.000Z' });

  const sessions = listClaudeSessionsForCwd({ cwd, configDir });
  assert.deepEqual(sessions.map((s) => s.id), [UUID_B, UUID_A]);
});

test('defaultConfigDir: 导出且返回非空字符串', () => {
  assert.equal(typeof defaultConfigDir(), 'string');
  assert.ok(defaultConfigDir().length > 0);
});

test('decodeClaudeProjectPath: Windows 盘符与路径分隔符反推', () => {
  assert.equal(decodeClaudeProjectPath('H--walker'), 'H:\\walker');
  assert.equal(decodeClaudeProjectPath('C--Users-alice'), 'C:\\Users\\alice');
  assert.equal(decodeClaudeProjectPath('-Users-alice'), '/Users/alice');
});

test('listAllClaudeSessions: 扫描全部项目目录并从记录无损还原 cwd', () => {
  const { root, configDir } = makeSandbox();
  const cwdA = path.join(root, 'proj-a');
  const cwdB = path.join(root, 'proj-b');
  fs.mkdirSync(cwdA, { recursive: true });
  fs.mkdirSync(cwdB, { recursive: true });
  const realA = fs.realpathSync.native(cwdA);
  const realB = fs.realpathSync.native(cwdB);
  const dirA = path.join(configDir, 'projects', encodeClaudeProjectPath(realA));
  const dirB = path.join(configDir, 'projects', encodeClaudeProjectPath(realB));
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });
  fs.writeFileSync(path.join(dirA, UUID_A + '.jsonl'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'in proj-a' }, cwd: realA, timestamp: '2026-08-06T09:00:00.000Z' }) + '\n');
  fs.writeFileSync(path.join(dirB, UUID_B + '.jsonl'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'in proj-b' }, cwd: realB, timestamp: '2026-08-06T10:00:00.000Z' }) + '\n');

  const sessions = listAllClaudeSessions({ configDir });
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions.map((s) => s.id), [UUID_B, UUID_A]);
  assert.equal(sessions.find((s) => s.id === UUID_A).cwd, realA, 'cwd 无损还原为真实路径');
  assert.equal(sessions.find((s) => s.id === UUID_B).cwd, realB);
  assert.equal(sessions[0].updatedAt, Date.parse('2026-08-06T10:00:00.000Z'));
});

test('listAllClaudeSessions: 无 cwd 记录时启发式解码目录名兜底', () => {
  const { configDir } = makeSandbox();
  const dir = path.join(configDir, 'projects', 'H--fallback');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, UUID_A + '.jsonl'),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'no cwd here' } }) + '\n');
  const sessions = listAllClaudeSessions({ configDir });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].cwd, 'H:\\fallback');
  assert.equal(sessions[0].title, 'claude ' + UUID_A.slice(0, 8));
});

test('listAllClaudeSessions: projects 目录缺失返回 []', () => {
  const { root } = makeSandbox();
  assert.deepEqual(listAllClaudeSessions({ configDir: path.join(root, 'no-config') }), []);
});

test('listAllClaudeSessions: 子目录 cwd 不冒充项目根（编码不匹配则用真实项目 cwd）', () => {
  const { root, configDir } = makeSandbox();
  const cwd = path.join(root, 'proj-root');
  fs.mkdirSync(cwd, { recursive: true });
  const real = fs.realpathSync.native(cwd);
  const dir = path.join(configDir, 'projects', encodeClaudeProjectPath(real));
  fs.mkdirSync(dir, { recursive: true });
  // 记录 cwd 同时含项目根和子目录，应选编码匹配目录名的项目根
  fs.writeFileSync(path.join(dir, UUID_A + '.jsonl'),
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' }, cwd: path.join(real, 'sub'), timestamp: '2026-08-06T09:00:00.000Z' }) + '\n' +
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'x2' }, cwd: real, timestamp: '2026-08-06T10:00:00.000Z' }) + '\n');
  const sessions = listAllClaudeSessions({ configDir });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].cwd, real, '选编码匹配项目根的真实 cwd 而非子目录');
});
