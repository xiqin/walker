'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createTranscriptCursor,
  encodeClaudeProjectPath,
  readAssistantTextSince,
  resolveClaudeTranscriptPath,
  watchClaudeTranscript,
} = require('../src/drivers/claude-transcript');

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

  await waitFor(() => events.some(event => event.text === 'partial'), { message: 'watcher did not recover after partial line completed' });
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
